import { createLogger } from "@gadgets/backend-utils/logger";
import type { getSandbox, SandboxProcess } from "@cloudflare/sandbox";
import type { CodingSessionOwner, CodingSessionToolHost, RequestBuildArtifact, RequestBuildExecutionReceipt, RequestBuildIntent, RequestBuildReadiness } from "@gadgets/workshop-shared/coding-sessions";
import { assertRequestBuildKey, buildHash, validateRequestBuildIntent } from "./request-build-policy.js";
import { requestBuildRunnerSource, requestBuildCloneCommand, requestBuildCollectCommand } from "./request-build-runner.js";

/** Actual Sandbox SDK surface used by the restricted lifecycle, narrowed without a mirrored RPC interface. */
export type RequestBuildSandboxClient = Pick<ReturnType<typeof getSandbox>, "mkdir" | "writeFile" | "exec" | "getProcess" | "destroy">;
/** Private record stored inside the existing per-owner Code Session registry. */
export type RequestBuildRecord = RequestBuildExecutionReceipt & {
  owner: CodingSessionOwner;
  intent: RequestBuildIntent;
  sandboxId: string;
  processId?: string;
};
/** Registry-owned adapters; production supplies real binding/SDK operations, tests substitute only providers. */
export interface RequestBuildExecutionDependencies {
  readiness(): RequestBuildReadiness;
  authorize: CodingSessionToolHost["authorizeRequestBuild"];
  sandbox(record: RequestBuildRecord): RequestBuildSandboxClient;
  configure(record: RequestBuildRecord): Promise<void>;
  disable(record: RequestBuildRecord): Promise<void>;
  acquire(record: RequestBuildRecord): Promise<boolean>;
  release(record: RequestBuildRecord): Promise<void>;
  reserveSession(record: RequestBuildRecord): void;
  updateSession(record: RequestBuildRecord): void;
  current(record: RequestBuildRecord): boolean;
  arm(): Promise<void>;
}

type RequestBuildLogFields = {
  vendorId: string;
  dispatchKey?: string;
  stage?: RequestBuildRecord["stage"];
  error?: unknown;
};

const logger = createLogger<RequestBuildLogFields>({ component: "gatekeeper.sessions.request-build", vendorId: "sessions" });

const terminal = new Set(["artifact_ready", "canceled", "failed", "needs_attention"]);
const processFailureMarkers = [
  "BUILD_RUNTIME_MISMATCH",
  "BUILD_MODEL_UNAVAILABLE",
  "BUILD_RESOURCES_FORBIDDEN",
  "BUILD_MODEL_REQUEST_DENIED",
  "BUILD_MODEL_RESPONSE_REJECTED",
  "ERR_MODULE_NOT_FOUND",
  "EEXIST",
] as const;

/** Maps untrusted process stderr to a closed diagnostic code without retaining its contents. */
export function classifyProcessFailure(stderr: string, truncated: boolean): string {
  for (const marker of processFailureMarkers) if (stderr.includes(marker)) return marker;
  if (/\b(?:401|403)\b/.test(stderr)) return "BUILD_MODEL_HTTP_AUTHORIZATION";
  if (/\b429\b/.test(stderr)) return "BUILD_MODEL_HTTP_RATE_LIMIT";
  if (/\b5[0-9]{2}\b/.test(stderr)) return "BUILD_MODEL_HTTP_UPSTREAM";
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT/i.test(stderr)) return "BUILD_MODEL_NETWORK_FAILED";
  if (/Executable not found|ENOENT/i.test(stderr)) return "BUILD_PROCESS_EXECUTABLE_MISSING";
  if (/SyntaxError/.test(stderr)) return "BUILD_PROCESS_SYNTAX_ERROR";
  return truncated ? "BUILD_PROCESS_DIAGNOSTIC_TRUNCATED" : "BUILD_PROCESS_FAILED_UNKNOWN";
}

type FailedProcessStatus =
  | { state: "error"; error: { code: string; message: string } }
  | { state: "exited"; exit: { code: number; timedOut: boolean } };

/** Classifies SDK failures or bounded terminal stderr while never returning untrusted text. */
export async function diagnoseProcessFailure(
  status: FailedProcessStatus,
  readOutput: () => Promise<{ stderr: string; truncated: boolean }>,
): Promise<string> {
  if (status.state === "error")
    return classifyProcessFailure(`${status.error.code}\n${status.error.message}`, false);
  if (status.exit.timedOut) return "BUILD_PROCESS_TIMED_OUT";
  try {
    const output = await readOutput();
    return classifyProcessFailure(output.stderr, output.truncated);
  } catch {
    return "BUILD_PROCESS_DIAGNOSTIC_UNAVAILABLE";
  }
}

/** Restricted mode lifecycle embedded in CodingSessionRegistry, not a separate feedback job store. */
export class RequestBuildExecution {
  readonly #busy = new Set<string>();
  constructor(readonly storage: DurableObjectStorage, readonly deps: RequestBuildExecutionDependencies) {}

  /** Persisted private lookup never enters a sandbox or checks revoked-owner eligibility. */
  get(owner: CodingSessionOwner, key: string): RequestBuildRecord | null {
    assertRequestBuildKey(key);
    const record = this.storage.kv.get<RequestBuildRecord>(`request-build:${key}`);
    if (record && record.owner.userId !== owner.userId) throw new Error("BUILD_OWNER_MISMATCH");
    return record ?? null;
  }

  /** Public-to-the-private-binding DTO excludes owner, sandbox ID, specification and process handle. */
  receipt(record: RequestBuildRecord): RequestBuildExecutionReceipt {
    const { owner: _owner, intent: _intent, sandboxId: _sandboxId, processId: _processId, ...receipt } = record;
    return receipt;
  }

  /** Compare-and-reserve, with alarm-before-ack and no external calls in the local transaction. */
  async ensure(owner: CodingSessionOwner, intent: RequestBuildIntent): Promise<RequestBuildExecutionReceipt> {
    assertRequestBuildKey(intent.dispatchKey);
    const cancellationFence = this.storage.kv.get<{ownerId: string}>(`request-build-canceled:${intent.dispatchKey}`);
    if (cancellationFence) throw new Error(cancellationFence.ownerId === owner.userId ? "BUILD_CANCELED_BEFORE_RESERVATION" : "BUILD_OWNER_MISMATCH");
    const readiness = this.deps.readiness();
    if (!readiness.ready || !readiness.policy) throw new Error(readiness.reasons[0] ?? "BUILD_NOT_READY");
    const intentHash = await validateRequestBuildIntent(intent, readiness.policy);
    let record = this.get(owner, intent.dispatchKey);
    if (record && record.intentHash !== intentHash) throw new Error("BUILD_KEY_CONFLICT");
    const now = Date.now();
    record ??= {
      owner, intent, intentHash, dispatchKey: intent.dispatchKey, sessionId: crypto.randomUUID(),
      sandboxId: `request-build-${crypto.randomUUID()}`, generation: 1, sequence: 1,
      state: "reserved", stage: "authorize", cancelRevision: 0, createdAt: now, updatedAt: now,
      deadline: now + intent.policy.wallTimeMs, cleanup: "pending",
    };
    // Reserve precedes remote authorization: concurrent ensure calls must name the same identity.
    await this.deps.arm();
    record = this.storage.transactionSync(() => {
      const canceled = this.storage.kv.get<{ownerId: string}>(`request-build-canceled:${intent.dispatchKey}`);
      if (canceled) throw new Error(canceled.ownerId === owner.userId ? "BUILD_CANCELED_BEFORE_RESERVATION" : "BUILD_OWNER_MISMATCH");
      const existing = this.get(owner, intent.dispatchKey);
      if (existing) {
        if (existing.intentHash !== intentHash) throw new Error("BUILD_KEY_CONFLICT");
        return existing;
      }
      this.deps.reserveSession(record!);
      this.storage.kv.put(`request-build:${intent.dispatchKey}`, record!);
      return record!;
    });
    await this.#authorize(record, "reserve");
    return this.receipt(this.get(owner, intent.dispatchKey)!);
  }

  /** Cancellation is durable, monotonic and service-owned, even when the triggering admin is revoked. */
  async cancel(owner: CodingSessionOwner, key: string, revision: number): Promise<RequestBuildExecutionReceipt | null> {
    assertRequestBuildKey(key);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("INVALID_CANCEL_REVISION");
    await this.deps.arm();
    return this.storage.transactionSync(() => {
      const record = this.get(owner, key);
      const previous = this.storage.kv.get<{ownerId: string; revision: number}>(`request-build-canceled:${key}`);
      if (previous && previous.ownerId !== owner.userId) throw new Error("BUILD_OWNER_MISMATCH");
      this.storage.kv.put(`request-build-canceled:${key}`, {ownerId: owner.userId, revision: Math.max(revision, previous?.revision ?? 0)});
      if (!record) return null; // Strong acknowledgement: delayed ensure is fenced permanently.
      if (revision > record.cancelRevision && !terminal.has(record.state)) {
        this.#save(record, { cancelRevision: revision, state: "cancel_requested" });
      }
      return this.receipt(this.get(owner, key)!);
    });
  }

  /** Returns immutable untrusted patch only after collection completed and exact current identity matches. */
  artifact(owner: CodingSessionOwner, key: string): RequestBuildArtifact | null {
    const record = this.get(owner, key);
    return record?.state === "artifact_ready" && this.deps.current(record)
      ? this.storage.kv.get<RequestBuildArtifact>(`request-build-artifact:${key}`) ?? null : null;
  }

  /** Participates in the existing registry's single alarm arbitration. */
  hasWork(): boolean {
    return [...this.storage.kv.list<RequestBuildRecord>({ prefix: "request-build:" })].map(([, record]) => record)
      .some(r => !terminal.has(r.state) || r.cleanup !== "complete");
  }

  /** One persisted stage per attempt per wake; uncertain process launch never executes a second time. */
  async alarm(): Promise<void> {
    // KV iterators are live in workerd: checkpoint writes can revisit the same key indefinitely.
    const records = Array.from(this.storage.kv.list<RequestBuildRecord>({ prefix: "request-build:" }));
    for (const [, record] of records) {
      if (this.#busy.has(record.dispatchKey) || terminal.has(record.state) && record.cleanup === "complete") continue;
      this.#busy.add(record.dispatchKey);
      try {
        await this.deps.arm();
        await this.#advance(record);
      } catch (error) {
        logger.warn("request build operation requires reconciliation", {
          event: "request.build.execution.reconcile",
          dispatchKey: record.dispatchKey,
          stage: this.get(record.owner, record.dispatchKey)?.stage ?? record.stage,
          error,
        });
        const current = this.get(record.owner, record.dispatchKey)!;
        // Keep ambiguous launches for attention; no remote error text persists or enters public receipts.
        if (!terminal.has(current.state) && current.state !== "cancel_requested") {
          this.#save(current, { state: "needs_attention", errorCode: "BUILD_OPERATION_UNCERTAIN" });
        }
      } finally {
        this.#busy.delete(record.dispatchKey);
      }
    }
  }

  async #authorize(record: RequestBuildRecord, phase: "reserve" | "start" | "collect"): Promise<void> {
    const decision = await this.deps.authorize(record.owner, {
      dispatchKey: record.dispatchKey, sessionId: record.sessionId, generation: record.generation,
      intentHash: record.intentHash, phase,
    });
    if (!decision.allowed || decision.intentHash !== record.intentHash || decision.sessionId !== record.sessionId || decision.generation !== record.generation) throw new Error("BUILD_AUTHORIZATION_DENIED");
    if (!this.deps.current(record)) throw new Error("BUILD_GENERATION_STALE");
    const current = this.get(record.owner, record.dispatchKey)!;
    if (phase !== "reserve" && (current.cancelRevision !== record.cancelRevision || terminal.has(current.state))) throw new Error("BUILD_NO_LONGER_ACTIVE");
  }

  #save(record: RequestBuildRecord, patch: Partial<RequestBuildRecord>): RequestBuildRecord {
    const current = this.get(record.owner, record.dispatchKey)!;
    // A cancellation that interleaved with provider I/O cannot be overwritten by a stale completion.
    if (current.sequence !== record.sequence) return current;
    const next = { ...current, ...patch, sequence: current.sequence + 1, updatedAt: Date.now() };
    this.storage.transactionSync(() => {
      this.storage.kv.put(`request-build:${record.dispatchKey}`, next);
      this.deps.updateSession(next);
    });
    return next;
  }

  async #advance(record: RequestBuildRecord): Promise<void> {
    if (record.state === "cancel_requested") record = this.#save(record, { state: "canceled", stage: "done" });
    if (!terminal.has(record.state) && Date.now() >= record.deadline) record = this.#save(record, { state: "failed", errorCode: "BUILD_WALLTIME_LIMIT" });
    if (!terminal.has(record.state) && !this.deps.current(record)) record = this.#save(record, { state: "needs_attention", errorCode: "BUILD_GENERATION_STALE" });
    if (terminal.has(record.state)) {
      if (record.cleanup === "complete") return;
      // Disable egress first; destruction is required before releasing capacity. Failure remains retryable.
      await this.deps.disable(record);
      await this.deps.sandbox(record).destroy();
      await this.deps.release(record);
      this.#save(record, { cleanup: "complete", stage: "done" });
      return;
    }
    if (record.stage === "authorize") {
      await this.#authorize(record, "start");
      if (!await this.deps.acquire(record)) {
        this.#save(record, { state: "failed", errorCode: "BUILD_CAPACITY_UNAVAILABLE" }); return;
      }
      this.#save(record, { state: "starting", stage: "setup" }); return;
    }
    if (record.stage === "setup") {
      await this.#authorize(record, "start");
      await this.deps.configure(record);
      const sandbox = this.deps.sandbox(record);
      await sandbox.mkdir("/workspace/.request-build", { recursive: true });
      await sandbox.writeFile("/workspace/.request-build/runner.mjs", requestBuildRunnerSource(record.intent));
      await this.#launch(record, "clone_launch", "clone_wait", requestBuildCloneCommand(record.intent)); return;
    }
    if (record.stage.endsWith("_launch")) {
      this.#save(record, { state: "needs_attention", errorCode: "BUILD_PROCESS_START_AMBIGUOUS" }); return;
    }
    const sandbox = this.deps.sandbox(record);
    const process = record.processId ? await sandbox.getProcess(record.processId) : null;
    if (!process) { this.#save(record, { state: "needs_attention", errorCode: "BUILD_PROCESS_LOST" }); return; }
    const status = await process.status();
    if (status.state === "running") return;
    if (status.state !== "exited" || status.exit.code !== 0 || status.exit.timedOut) {
      const reason = await diagnoseProcessFailure(status, async () =>
        process.output({ encoding: "utf8", maxBytes: 16_384, timeout: 1000 }));
      logger.warn("request build process failed", {
        event: "request.build.process.failed",
        dispatchKey: record.dispatchKey,
        stage: record.stage,
        error: new Error(reason),
      });
      this.#save(record, { state: "failed", errorCode: "BUILD_PROCESS_FAILED" }); return;
    }
    if (record.stage === "clone_wait") {
      await this.#authorize(record, "start");
      await this.#launch(record, "runner_launch", "runner_wait", ["node", "/workspace/.request-build/runner.mjs"]); return;
    }
    if (record.stage === "runner_wait") {
      const output = await process.output({ encoding: "utf8", maxBytes: record.intent.policy.outputBytes, timeout: 1000 });
      if (output.truncated) { this.#save(record, { state: "failed", errorCode: "BUILD_OUTPUT_LIMIT" }); return; }
      await this.#authorize(record, "collect");
      await this.#launch(record, "collect_launch", "collect_wait", requestBuildCollectCommand(record.intent)); return;
    }
    if (record.stage === "collect_wait") await this.#collect(record, process);
  }

  async #launch(record: RequestBuildRecord, launch: RequestBuildRecord["stage"], wait: RequestBuildRecord["stage"], argv: [string, ...string[]]): Promise<void> {
    const current = this.get(record.owner, record.dispatchKey)!;
    if (current.sequence !== record.sequence) return;
    const intent = this.#save(record, { stage: launch, processId: undefined });
    if (intent.stage !== launch) return;
    const process = await this.deps.sandbox(intent).exec(argv, {
      cwd: "/workspace", timeout: Math.max(1, intent.deadline - Date.now()),
      env: { HOME: "/workspace/.request-build/home", PI_CODING_AGENT_DIR: "/workspace/.request-build/agent", PI_OFFLINE: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    this.#save(intent, { stage: wait, processId: process.id, state: wait === "runner_wait" ? "running" : wait === "collect_wait" ? "collecting" : "starting" });
  }

  async #collect(record: RequestBuildRecord, process: SandboxProcess): Promise<void> {
    await this.#authorize(record, "collect");
    const output = await process.output({ encoding: "utf8", maxBytes: record.intent.policy.diffBytes, timeout: 1000 });
    if (output.truncated || output.exitCode !== 0 || output.timedOut || !output.stdout.startsWith("diff --git ")) {
      this.#save(record, { state: "failed", errorCode: "BUILD_ARTIFACT_INVALID" }); return;
    }
    const hash = await buildHash(output.stdout);
    const current = this.get(record.owner, record.dispatchKey)!;
    if (current.sequence !== record.sequence) return;
    const artifact: RequestBuildArtifact = { patch: output.stdout, hash, baseSha: record.intent.baseSha };
    this.storage.transactionSync(() => {
      this.storage.kv.put(`request-build-artifact:${record.dispatchKey}`, artifact);
      this.#save(record, { state: "artifact_ready", artifactHash: hash, stage: "done" });
    });
  }
}
