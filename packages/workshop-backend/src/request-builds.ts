import {
  buildHash,
  canonicalBuildJson,
  type CodingSessionOwner,
  type CodingSessionsService,
  type RequestBuildAuthorization,
  type RequestBuildAuthorizationRequest,
  type RequestBuildExecutionReceipt,
  type RequestBuildIntent,
  type RequestBuildReadiness,
  type StartRequestBuild,
  type CancelRequestBuild,
  type PublicRequestBuild,
  type PublicRequestBuildReadiness,
  type RequestBuildGitHubWrite,
} from "@gadgets/workshop-shared/coding-sessions";
import type { AdminClaim } from "./admin-authority";
import type { RequestBuildNotifier } from "@gadgets/workshop-shared/coding-sessions";
import { RequestBuildOutbox } from "./request-build-outbox";
import { createWorkshopLogger } from "./observability";
const logger = createWorkshopLogger("workshop.request-builds");
import {
  buildPublicationBody,
  buildPublicationBranch,
  reconcileBuildPublication,
  resolveRequestBuildBase,
  validateBuildArtifact,
  verifyBuildPublicationResult,
  type BuildPublication,
  type RequestBuildPublicationPolicy,
} from "./request-build-publisher";

/** Only authored visible board content is available to this controller. */
export type RequestBuildSpecification = { revision: number; specification: string; open: boolean };
/** Private adapters use actual Sessions methods, not mirrored native/Cap'n Web interfaces. */
export interface RequestBuildDependencies {
  sessions: Pick<
    CodingSessionsService,
    | "requestBuildReadiness"
    | "ensureRequestBuild"
    | "getRequestBuildReceipt"
    | "cancelRequestBuildExecution"
    | "getRequestBuildArtifact"
    | "readRequestBuildGitHub"
    | "writeRequestBuildGitHub"
  >;
  assertCurrent(claim: AdminClaim): Promise<void>;
  eligibility(claim: AdminClaim, model: string): Promise<CodingSessionOwner>;
  activationReasons(component?: RequestBuildReadiness): Promise<string[]>;
  publicationPolicy(): RequestBuildPublicationPolicy | null;
  specification(requestId: string): RequestBuildSpecification | null;
  /** Trusted deployment origin; missing configuration gates production admission. */
  notificationOrigin?: string;
  /** Current receiver configuration generation; no evidence survives a mismatched deployment. */
  notifierGeneration?: string;
  /** Private service binding, never a gadget or user-provided capability. */
  notifier?: Pick<RequestBuildNotifier, "requestBuildNotifierReadiness" | "notifyRequestBuild">;
}
/** Private persisted approval and attempt. No public API accepts this record. */
export type RequestBuildRun = {
  runId: string;
  requestId: string;
  requestRevision: number;
  claim: AdminClaim;
  owner: CodingSessionOwner;
  intent: RequestBuildIntent;
  intentHash: string;
  publicationPolicy: RequestBuildPublicationPolicy;
  /** Trusted origin frozen at approval; deployment changes cannot rewrite an existing notification key. */
  notificationOrigin?: string;
  state: PublicRequestBuild["state"];
  version: number;
  createdAt: number;
  updatedAt: number;
  receipt?: RequestBuildExecutionReceipt;
  receiptHash?: string;
  cancelRevision: number;
  errorCode?: string;
  publication?: BuildPublication;
  retryAt: number;
  failures: number;
  cleanup: "pending" | "complete";
};
const terminal = new Set<PublicRequestBuild["state"]>([
  "pr_created",
  "canceled",
  "failed",
  "needs_attention",
]);
const executionTerminal = new Set<RequestBuildExecutionReceipt["state"]>([
  "artifact_ready",
  "canceled",
  "failed",
  "needs_attention",
]);
function identifier(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  )
    throw new Error("BUILD_INPUT_INVALID");
}
function key(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value))
    throw new Error("BUILD_INPUT_INVALID");
}
function fields(value: object, allowed: string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw new Error("BUILD_INPUT_INVALID");
}

/** Durable control plane embedded in the existing board SQLite DO; alarms, not browsers, own progress. */
export class RequestBuilds {
  #busy = false;
  #authorizationDiagnostics = new Map<string, Set<string>>();
  #outbox: RequestBuildOutbox;
  constructor(
    private storage: DurableObjectStorage,
    private deps: RequestBuildDependencies,
  ) {
    storage.transactionSync(() =>
      storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS build_runs (runId TEXT PRIMARY KEY, requestId TEXT NOT NULL, slot INTEGER UNIQUE CHECK(slot=1 OR slot IS NULL), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS build_keys (actor TEXT NOT NULL, operation TEXT NOT NULL, mutationKey TEXT NOT NULL, payload TEXT NOT NULL, runId TEXT NOT NULL, PRIMARY KEY(actor,operation,mutationKey));
      CREATE INDEX IF NOT EXISTS build_request_history ON build_runs(requestId,runId);
    `),
    );
    this.#outbox = new RequestBuildOutbox(storage, deps.notifier, async runId => {
      const run = this.#get(runId);
      if (!run || !run.publication?.pullRequest || run.cancelRevision || !deps.specification(run.requestId)) return false;
      await deps.assertCurrent(run.claim);
      const current = this.#get(runId);
      return !!current && !current.cancelRevision && !!deps.specification(current.requestId);
    }, deps.notifierGeneration);
  }
  #get(runId: string): RequestBuildRun | null {
    const row = this.storage.sql
      .exec<{ value: string }>("SELECT value FROM build_runs WHERE runId=?", runId)
      .toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  #dispatch(key: string): RequestBuildRun | null {
    // Bounded by one deployment-active slot; historical callbacks still receive explicit terminal denial.
    const rows = this.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM build_runs WHERE json_extract(value,'$.intent.dispatchKey')=?",
        key,
      )
      .toArray();
    return rows.length === 1 ? JSON.parse(rows[0].value) : null;
  }
  #save(run: RequestBuildRun): void {
    this.storage.transactionSync(() => {
      const current = this.#get(run.runId);
      if (current && current.version !== run.version) throw new Error("BUILD_STATE_CONFLICT");
      run.version++;
      run.updatedAt = Date.now();
      const release =
        terminal.has(run.state) && run.cleanup === "complete" && !run.publication?.pending;
      this.storage.sql.exec(
        "INSERT INTO build_runs VALUES (?,?,?,?) ON CONFLICT(runId) DO UPDATE SET slot=excluded.slot,value=excluded.value",
        run.runId,
        run.requestId,
        release ? null : 1,
        JSON.stringify(run),
      );
      if (run.state === "pr_created" && run.publication?.pullRequest && run.notificationOrigin) {
        this.#outbox.enqueue({
          origin: run.notificationOrigin, requestId: run.requestId,
          runId: run.runId, attempt: run.intent.attempt, prNumber: run.publication.pullRequest.number,
        });
      }
    });
  }
  async #arm(at = Date.now() + 1000): Promise<void> {
    const alarm = await this.storage.getAlarm();
    if (alarm === null || alarm > at) await this.storage.setAlarm(at);
  }
  /** Constructor recovery never postpones an existing due alarm. */
  async recover(): Promise<void> {
    await this.#outbox.recover();
    if (this.storage.sql.exec("SELECT 1 FROM build_runs WHERE slot=1").toArray().length)
      await this.#arm();
  }
  #spec(run: RequestBuildRun): RequestBuildSpecification {
    const spec = this.deps.specification(run.requestId);
    // Later details cannot rewrite approval. Hiding/closing/revision drift blocks new work.
    if (
      !spec ||
      !spec.open ||
      spec.revision !== run.requestRevision ||
      spec.specification !== run.intent.specification
    )
      throw new Error("BUILD_APPROVAL_UNAVAILABLE");
    return spec;
  }
  async #setup(
    claim: AdminClaim,
  ): Promise<{
    readiness: PublicRequestBuildReadiness;
    component?: RequestBuildReadiness;
    publicationPolicy: RequestBuildPublicationPolicy | null;
    owner?: CodingSessionOwner;
  }> {
    const reasons: string[] = [];
    try {
      await this.deps.assertCurrent(claim);
    } catch {
      reasons.push("ADMIN_AUTHORITY_UNAVAILABLE");
    }
    if (claim.mode !== "managed" || claim.purpose !== "request-build")
      reasons.push("ADMIN_MANAGED_NOT_ACTIVE");
    let component: RequestBuildReadiness | undefined, owner: CodingSessionOwner | undefined;
    const publicationPolicy = this.deps.publicationPolicy();
    if (!publicationPolicy) reasons.push("BUILD_PUBLICATION_POLICY_INVALID");
    try {
      component = await this.deps.sessions.requestBuildReadiness();
      reasons.push(...component.reasons);
      if (component.protocolVersion !== "request-build-git-data-v1")
        reasons.push("PROVIDER_PROTOCOL_UNAVAILABLE");
      if (!component.ready || !component.policy) reasons.push("BUILD_POLICY_UNAVAILABLE");
    } catch {
      reasons.push("PROVIDER_PROTOCOL_UNAVAILABLE");
    }
    try {
      reasons.push(...(await this.deps.activationReasons(component)));
    } catch {
      reasons.push("BUILD_READINESS_UNAVAILABLE");
    }
    if (component?.policy) {
      try {
        owner = await this.deps.eligibility(claim, component.policy.model);
        if (owner.userId !== claim.principalId || owner.email !== claim.profileId)
          throw new Error("BUILD_ACTOR_MISMATCH");
      } catch {
        reasons.push("REPOSITORY_OR_MODEL_AUTHORIZATION_UNAVAILABLE");
      }
    }
    return {
      readiness: { ready: reasons.length === 0, reasons: [...new Set(reasons)] },
      component,
      publicationPolicy,
      owner,
    };
  }
  /** Safe diagnostics do not create execution intents or mint publication credentials. */
  async readiness(
    claim: AdminClaim,
    requestId: string,
  ): Promise<PublicRequestBuildReadiness & { requestRevision?: number; specification?: string }> {
    identifier(requestId);
    const setup = await this.#setup(claim),
      spec = this.deps.specification(requestId);
    if (!spec || !spec.open) setup.readiness.reasons.push("BUILD_APPROVAL_UNAVAILABLE");
    if (this.storage.sql.exec("SELECT 1 FROM build_runs WHERE slot=1").toArray().length)
      setup.readiness.reasons.push("BUILD_CAPACITY_UNAVAILABLE");
    return {
      ...setup.readiness,
      ready: setup.readiness.reasons.length === 0,
      ...(spec ? { requestRevision: spec.revision, specification: spec.specification } : {}),
    };
  }
  #prior(
    claim: AdminClaim,
    operation: string,
    mutationKey: string,
    payload: string,
  ): RequestBuildRun | null {
    const receipt = this.storage.sql
      .exec<{ payload: string; runId: string }>(
        "SELECT payload,runId FROM build_keys WHERE actor=? AND operation=? AND mutationKey=?",
        claim.principalId,
        operation,
        mutationKey,
      )
      .toArray()[0];
    if (receipt && receipt.payload !== payload) throw new Error("BUILD_MUTATION_KEY_CONFLICT");
    return receipt ? this.#get(receipt.runId) : null;
  }
  #remember(
    claim: AdminClaim,
    operation: string,
    mutationKey: string,
    payload: string,
    runId: string,
  ): void {
    this.storage.sql.exec(
      "INSERT INTO build_keys VALUES (?,?,?,?,?)",
      claim.principalId,
      operation,
      mutationKey,
      payload,
      runId,
    );
  }
  /** Approval, capacity and retry receipt commit atomically; alarm is durable before acknowledgement. */
  async start(claim: AdminClaim, input: StartRequestBuild): Promise<PublicRequestBuild> {
    fields(input, ["requestId", "expectedRequestRevision", "mutationKey"]);
    identifier(input.requestId);
    key(input.mutationKey);
    if (!Number.isSafeInteger(input.expectedRequestRevision) || input.expectedRequestRevision < 1)
      throw new Error("BUILD_INPUT_INVALID");
    await this.deps.assertCurrent(claim);
    if (claim.purpose !== "request-build" || claim.mode !== "managed")
      throw new Error("ADMIN_MANAGED_NOT_ACTIVE");
    const payload = canonicalBuildJson(input),
      prior = this.#prior(claim, "start", input.mutationKey, payload);
    if (prior) {
      if (!this.deps.specification(prior.requestId)) throw new Error("BUILD_UNAVAILABLE");
      await this.recover();
      return this.#project(prior);
    }
    if (this.storage.sql.exec("SELECT 1 FROM build_runs WHERE slot=1").toArray().length)
      throw new Error("BUILD_CAPACITY_UNAVAILABLE");
    const setup = await this.#setup(claim);
    if (
      !setup.readiness.ready ||
      !setup.component?.policy ||
      !setup.publicationPolicy ||
      !setup.owner
    )
      throw new Error(setup.readiness.reasons[0] ?? "BUILD_NOT_READY");
    const spec = this.deps.specification(input.requestId);
    if (
      !spec?.open ||
      spec.revision !== input.expectedRequestRevision ||
      new TextEncoder().encode(spec.specification).length > 32768
    )
      throw new Error("BUILD_APPROVAL_UNAVAILABLE");
    const baseSha = await resolveRequestBuildBase((operation) =>
      this.deps.sessions.readRequestBuildGitHub(operation),
    );
    const attempt = this.storage.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*)+1 AS n FROM build_runs WHERE requestId=?",
        input.requestId,
      )
      .one().n;
    if (attempt > 99) throw new Error("BUILD_ATTEMPT_LIMIT");
    const intent: RequestBuildIntent = {
      dispatchKey: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      attempt,
      specification: spec.specification,
      specificationHash: await buildHash(spec.specification),
      repository: "totango/odie-os",
      baseBranch: "main",
      baseSha,
      policy: setup.component.policy,
      policyHash: await buildHash(canonicalBuildJson(setup.component.policy)),
    };
    const now = Date.now();
    const run: RequestBuildRun = {
      runId: intent.runId,
      requestId: input.requestId,
      requestRevision: spec.revision,
      claim,
      owner: setup.owner,
      intent,
      intentHash: await buildHash(canonicalBuildJson(intent)),
      publicationPolicy: setup.publicationPolicy,
      ...(this.deps.notificationOrigin ? { notificationOrigin: this.deps.notificationOrigin } : {}),
      state: "queued",
      version: 0,
      createdAt: now,
      updatedAt: now,
      cancelRevision: 0,
      retryAt: now,
      failures: 0,
      cleanup: "pending",
    };
    const admission = await this.#setup(claim);
    if (
      !admission.readiness.ready ||
      canonicalBuildJson(admission.component?.policy) !== canonicalBuildJson(run.intent.policy) ||
      canonicalBuildJson(admission.publicationPolicy) !==
        canonicalBuildJson(run.publicationPolicy) ||
      admission.owner?.userId !== run.owner.userId
    )
      throw new Error("BUILD_ADMISSION_CHANGED");
    await this.deps.assertCurrent(claim);
    const result = this.storage.transactionSync(() => {
      const concurrent = this.#prior(claim, "start", input.mutationKey, payload);
      if (concurrent) return this.#project(concurrent);
      this.#spec(run);
      if (
        this.storage.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*)+1 AS n FROM build_runs WHERE requestId=?",
            input.requestId,
          )
          .one().n !== run.intent.attempt
      )
        throw new Error("BUILD_STATE_CONFLICT");
      if (this.storage.sql.exec("SELECT 1 FROM build_runs WHERE slot=1").toArray().length)
        throw new Error("BUILD_CAPACITY_UNAVAILABLE");
      this.#save(run);
      this.#remember(claim, "start", input.mutationKey, payload, run.runId);
      return this.#project(run);
    });
    // A pre-commit wake can observe no work. Arm after commit, before acknowledging;
    // if scheduling fails, the durable same-key receipt retries through recover().
    await this.#arm();
    return result;
  }
  /** Any current admin may cancel; receipt reads and exact-generation cleanup do not use the initiator. */
  async cancel(claim: AdminClaim, input: CancelRequestBuild): Promise<PublicRequestBuild> {
    fields(input, ["requestId", "runId", "mutationKey"]);
    identifier(input.requestId);
    identifier(input.runId);
    key(input.mutationKey);
    await this.deps.assertCurrent(claim);
    if (claim.purpose !== "request-build") throw new Error("ADMIN_REQUIRED");
    await this.#arm();
    await this.deps.assertCurrent(claim);
    const payload = canonicalBuildJson(input);
    return this.storage.transactionSync(() => {
      const run = this.#get(input.runId);
      if (!run || run.requestId !== input.requestId) throw new Error("BUILD_UNAVAILABLE");
      const prior = this.#prior(claim, "cancel", input.mutationKey, payload);
      if (prior) return this.#project(run);
      run.cancelRevision++;
      if (!terminal.has(run.state)) run.state = "cancel_requested";
      this.#save(run);
      this.#remember(claim, "cancel", input.mutationKey, payload, run.runId);
      return this.#project(run);
    });
  }
  #project(run: RequestBuildRun): PublicRequestBuild {
    return {
      runId: run.runId,
      requestId: run.requestId,
      requestRevision: run.requestRevision,
      state: run.state,
      attempt: run.intent.attempt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.errorCode ? { errorCode: run.errorCode } : {}),
      cleanup: run.cleanup,
      ...(this.#outbox.status(run.runId) ? { notification: this.#outbox.status(run.runId) } : {}),
      ...(run.publication?.pullRequest ? { pullRequest: run.publication.pullRequest } : {}),
      cancelTooLate: run.cancelRevision > 0 && !!run.publication?.pullRequest,
    };
  }
  /** Authenticated public read: even a known run ID conveys no hidden-request access. */
  get(requestId: string, runId: string): PublicRequestBuild | null {
    identifier(requestId);
    identifier(runId);
    const run = this.#get(runId);
    return this.deps.specification(requestId) && run?.requestId === requestId
      ? this.#project(run)
      : null;
  }
  /** Bounded newest-first history; hidden requests disclose no runs even to retained admin capabilities. */
  list(requestId: string): PublicRequestBuild[] {
    identifier(requestId);
    if (!this.deps.specification(requestId)) return [];
    return this.storage.sql.exec<{ value: string }>(
      "SELECT value FROM build_runs WHERE requestId=? ORDER BY json_extract(value,'$.createdAt') DESC,runId DESC LIMIT 20", requestId,
    ).toArray().map(row => this.#project(JSON.parse(row.value)));
  }
  /** Private host admission is derived from persisted approval AND the real Sessions reservation. */
  async authorize(
    owner: CodingSessionOwner,
    request: RequestBuildAuthorizationRequest,
  ): Promise<RequestBuildAuthorization> {
    let executionId: string | undefined;
    let checkpoint = "lookup";
    const phase = ["reserve", "start", "model", "collect", "publish"].includes(request.phase)
      ? request.phase
      : "invalid";
    try {
      const run = this.#dispatch(request.dispatchKey);
      if (!run) return { allowed: false, reasons: ["UNKNOWN_RUN"] };
      executionId = run.runId;
      checkpoint = "run";
      if (
        owner.userId !== run.owner.userId ||
        owner.email !== run.owner.email ||
        request.intentHash !== run.intentHash ||
        run.cancelRevision ||
        terminal.has(run.state) ||
        run.state === "queued" ||
        run.state === "cancel_requested"
      )
        throw new Error();
      checkpoint = "specification";
      this.#spec(run);
      checkpoint = "setup";
      const setup = await this.#setup(run.claim);
      if (!setup.readiness.ready) {
        const reason = setup.readiness.reasons.find(value => /^[A-Z0-9_]{1,80}$/.test(value));
        checkpoint = `setup.${reason ?? "unavailable"}`;
        throw new Error();
      }
      if (!setup.owner) {
        checkpoint = "setup.owner_missing";
        throw new Error();
      }
      if (setup.owner.userId !== run.owner.userId || setup.owner.email !== run.owner.email) {
        checkpoint = "setup.owner_changed";
        throw new Error();
      }
      if (canonicalBuildJson(setup.component?.policy) !== canonicalBuildJson(run.intent.policy)) {
        checkpoint = "setup.policy_changed";
        throw new Error();
      }
      if (canonicalBuildJson(setup.publicationPolicy) !== canonicalBuildJson(run.publicationPolicy)) {
        checkpoint = "setup.publication_changed";
        throw new Error();
      }
      // Registry alarms call this host while that same registry is occupied. Reuse the receipt
      // already bound by the controller instead of making a circular RPC back into the caller.
      // Its state can lag the registry, so it proves immutable identity but not current lifecycle
      // phase. The trusted registry enforces stage ordering before and after this callback.
      // Model and publication calls originate outside the registry and still read live state.
      checkpoint = "receipt";
      const registryCallback = request.phase === "start" || request.phase === "collect";
      const boundRegistryReceipt = registryCallback ? run.receipt : undefined;
      const receipt =
        boundRegistryReceipt ??
        (await this.deps.sessions.getRequestBuildReceipt(run.owner, request.dispatchKey));
      if (
        !receipt ||
        receipt.dispatchKey !== request.dispatchKey ||
        receipt.intentHash !== run.intentHash ||
        receipt.sessionId !== request.sessionId ||
        receipt.generation !== request.generation ||
        request.generation !== 1 ||
        receipt.cancelRevision ||
        (run.receipt &&
          (run.receipt.sessionId !== receipt.sessionId ||
            run.receipt.generation !== receipt.generation))
      )
        throw new Error();
      identifier(receipt.sessionId);
      const phaseAllowed =
        request.phase === "publish"
          ? receipt.state === "artifact_ready" &&
            run.state === "publishing" &&
            run.publication?.pending?.sent &&
            request.publicationHash === run.publication.pending.hash
          : request.publicationHash === undefined &&
            (request.phase === "reserve"
              ? !executionTerminal.has(receipt.state)
              : request.phase === "start"
                ? !!boundRegistryReceipt || ["reserved", "starting"].includes(receipt.state)
                : request.phase === "model"
                  ? receipt.state === "running"
                  : request.phase === "collect"
                    ? !!boundRegistryReceipt || ["running", "collecting"].includes(receipt.state)
                    : false);
      checkpoint = "phase";
      if (!phaseAllowed) throw new Error();
      checkpoint = "authority";
      await this.deps.assertCurrent(run.claim);
      checkpoint = "current";
      const current = this.#get(run.runId)!;
      this.#spec(current);
      if (current.version !== run.version || current.cancelRevision) throw new Error();
      if (!current.receipt) {
        checkpoint = "binding";
        if (request.phase !== "reserve") throw new Error();
        this.#receipt(current, receipt);
        this.#save(current); // Bind once to the actual durable reservation.
      }
      return {
        allowed: true,
        intentHash: run.intentHash,
        sessionId: receipt.sessionId,
        generation: receipt.generation,
      };
    } catch {
      const operation = `${phase}.${checkpoint}`;
      if (executionId) {
        let operations = this.#authorizationDiagnostics.get(executionId);
        if (!operations) {
          // One slot is active at a time. Retain only recent runs so later failures stay visible.
          if (this.#authorizationDiagnostics.size >= 4) {
            const oldest = this.#authorizationDiagnostics.keys().next().value;
            if (oldest) this.#authorizationDiagnostics.delete(oldest);
          }
          operations = new Set();
          this.#authorizationDiagnostics.set(executionId, operations);
        }
        // Bound repeated private-provider callbacks without mutating durable run/version state.
        if (operations.size < 10 && !operations.has(operation)) {
          operations.add(operation);
          logger.warn("request build authorization denied", {
            event: "request.build.authorization.denied",
            executionId,
            operation,
          });
        }
      }
      return { allowed: false, reasons: ["BUILD_AUTHORIZATION_DENIED"] };
    }
  }
  async #current(run: RequestBuildRun): Promise<void> {
    this.#spec(run);
    const setup = await this.#setup(run.claim);
    if (
      !setup.readiness.ready ||
      !setup.owner ||
      setup.owner.userId !== run.owner.userId ||
      canonicalBuildJson(setup.component?.policy) !== canonicalBuildJson(run.intent.policy) ||
      canonicalBuildJson(setup.publicationPolicy) !== canonicalBuildJson(run.publicationPolicy)
    )
      throw new Error("BUILD_AUTHORIZATION_DENIED");
    await this.deps.assertCurrent(run.claim);
    const current = this.#get(run.runId)!;
    this.#spec(current);
    if (current.version !== run.version || current.cancelRevision)
      throw new Error("BUILD_AUTHORIZATION_DENIED");
  }
  #receipt(run: RequestBuildRun, receipt: RequestBuildExecutionReceipt): void {
    if (
      receipt.dispatchKey !== run.intent.dispatchKey ||
      receipt.intentHash !== run.intentHash ||
      receipt.generation !== 1 ||
      (run.receipt &&
        (receipt.sessionId !== run.receipt.sessionId ||
          receipt.generation !== run.receipt.generation)) ||
      !Number.isSafeInteger(receipt.sequence) ||
      receipt.sequence < 1
    )
      throw new Error("BUILD_RECEIPT_INVALID");
    identifier(receipt.sessionId);
    if (
      ![
        "reserved",
        "starting",
        "running",
        "collecting",
        "artifact_ready",
        "cancel_requested",
        "canceled",
        "failed",
        "needs_attention",
      ].includes(receipt.state) ||
      !["pending", "complete"].includes(receipt.cleanup) ||
      !Number.isSafeInteger(receipt.cancelRevision) ||
      receipt.cancelRevision < 0 ||
      !Number.isSafeInteger(receipt.createdAt) ||
      !Number.isSafeInteger(receipt.updatedAt) ||
      !Number.isSafeInteger(receipt.deadline) ||
      receipt.updatedAt < receipt.createdAt ||
      receipt.deadline <= receipt.createdAt ||
      (receipt.state === "artifact_ready" && !/^[a-f0-9]{64}$/.test(receipt.artifactHash ?? "")) ||
      (run.receipt &&
        (receipt.createdAt !== run.receipt.createdAt ||
          receipt.deadline !== run.receipt.deadline ||
          receipt.updatedAt < run.receipt.updatedAt ||
          receipt.cancelRevision < run.receipt.cancelRevision ||
          (run.receipt.artifactHash && receipt.artifactHash !== run.receipt.artifactHash)))
    )
      throw new Error("BUILD_RECEIPT_INVALID");
    const hash = canonicalBuildJson(receipt);
    if (
      run.receipt &&
      (receipt.sequence < run.receipt.sequence ||
        (receipt.sequence === run.receipt.sequence && hash !== run.receiptHash) ||
        (executionTerminal.has(run.receipt.state) && receipt.state !== run.receipt.state) ||
        (run.receipt.cleanup === "complete" && receipt.cleanup !== "complete"))
    )
      throw new Error("BUILD_RECEIPT_INVALID");
    run.receipt = receipt;
    run.receiptHash = hash;
    run.cleanup = receipt.cleanup;
  }
  /** One bounded reconciliation step per alarm; every external side-effect intent is already durable. */
  async alarm(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const row = this.storage.sql
        .exec<{ value: string }>("SELECT value FROM build_runs WHERE slot=1")
        .toArray()[0];
      if (!row) return;
      let run: RequestBuildRun = JSON.parse(row.value);
      await this.#arm(Math.max(Date.now() + 1000, run.retryAt));
      if (run.retryAt > Date.now()) return;
      try {
        await this.#advance(run);
      } catch (error) {
        run = this.#get(run.runId)!;
        run.failures++;
        const safeCodes = [
          "BUILD_BASE_MOVED",
          "BUILD_APPROVAL_UNAVAILABLE",
          "BUILD_AUTHORIZATION_DENIED",
          "BUILD_RECEIPT_INVALID",
          "BUILD_ARTIFACT_INVALID",
          "BUILD_ARTIFACT_PATH_REJECTED",
          "BUILD_ARTIFACT_CONTENT_REJECTED",
          "BUILD_ARTIFACT_MODE_REJECTED",
          "BUILD_ARTIFACT_BASE_MISMATCH",
          "BUILD_ARTIFACT_LIMIT",
          "BUILD_PUBLICATION_CONFLICT",
          "BUILD_PUBLICATION_AMBIGUOUS",
        ];
        const code =
          error instanceof Error && safeCodes.includes(error.message)
            ? error.message
            : "BUILD_RECONCILIATION_REQUIRED";
        logger.warn("request build requires reconciliation", {
          event: "request.build.reconcile",
          executionId: run.runId,
          failureCount: run.failures,
          operation: code,
        });
        if (!terminal.has(run.state) && (run.state !== "cancel_requested" || run.failures >= 6)) {
          run.state =
            run.publication?.pending?.sent || run.failures >= 6
              ? "needs_attention"
              : "cancel_requested";
          run.cancelRevision++;
          run.errorCode = code;
        }
        run.retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(run.failures, 6));
        this.#save(run);
      }
    } finally {
      try { await this.#outbox.alarm(); } finally { this.#busy = false; }
    }
  }
  async #advance(run: RequestBuildRun): Promise<void> {
    const sessions = this.deps.sessions,
      read = (op: Parameters<CodingSessionsService["readRequestBuildGitHub"]>[0]) =>
        sessions.readRequestBuildGitHub(op);
    // Reconcile admitted writes first, even after cancellation/revocation; never infer they were undone.
    if (run.publication?.pending?.sent) {
      const publication = await reconcileBuildPublication(read, run.intent, run.publication);
      const current = this.#get(run.runId)!;
      current.publication = publication;
      if (publication.pullRequest) current.state = "pr_created";
      else if (terminal.has(current.state)) {
        current.state = "cancel_requested";
        current.cancelRevision++;
      }
      this.#save(current);
      return;
    }
    const receipt = await sessions.getRequestBuildReceipt(run.owner, run.intent.dispatchKey);
    if (this.#get(run.runId)!.version !== run.version) return;
    if (receipt) this.#receipt(run, receipt);
    if (run.cancelRevision || terminal.has(run.state)) {
      if (!receipt) {
        const canceled = await sessions.cancelRequestBuildExecution(
          run.owner,
          run.intent.dispatchKey,
          Math.max(1, run.cancelRevision),
        );
        if (this.#get(run.runId)!.version !== run.version) return;
        if (canceled) this.#receipt(run, canceled);
        else run.cleanup = "complete";
        if (run.state === "cancel_requested" && run.cleanup === "complete") run.state = "canceled";
      } else if (!executionTerminal.has(receipt.state)) {
        run.cancelRevision = Math.max(1, run.cancelRevision);
        this.#save(run);
        await sessions.cancelRequestBuildExecution(
          run.owner,
          run.intent.dispatchKey,
          run.cancelRevision,
        );
        return;
      } else if (run.state === "cancel_requested") run.state = "canceled";
      this.#save(run);
      return;
    }
    await this.#current(run);
    if (run.state === "queued") {
      run.state = "dispatching";
      this.#save(run);
      return;
    }
    if (!receipt) {
      // ensure is itself durably idempotent. A lost reservation ack is recovered by the same dispatch key.
      try {
        await sessions.ensureRequestBuild(run.owner, run.intent);
      } catch {
        // Lost response is not a new attempt. Probe the durable reservation before choosing cleanup.
        const reserved = await sessions.getRequestBuildReceipt(run.owner, run.intent.dispatchKey);
        if (!reserved) throw new Error("BUILD_DISPATCH_UNCERTAIN");
        if (this.#get(run.runId)!.version !== run.version) return;
        this.#receipt(run, reserved);
        this.#save(run);
      }
      return;
    }
    if (receipt.state === "artifact_ready") {
      if (!run.publication) {
        const artifact = await sessions.getRequestBuildArtifact(run.owner, run.intent.dispatchKey);
        if (!artifact || artifact.hash !== receipt.artifactHash)
          throw new Error("BUILD_ARTIFACT_INVALID");
        run.state = "validating";
        const validated = await validateBuildArtifact(
          run.intent,
          artifact,
          run.publicationPolicy,
          read,
        );
        await this.#current(run);
        run.publication = { artifact: validated };
        run.state = "publishing";
        this.#save(run);
        return;
      }
      await this.#publish(run);
      return;
    }
    if (
      receipt.state === "failed" ||
      receipt.state === "canceled" ||
      receipt.state === "needs_attention"
    ) {
      run.state = receipt.state;
      run.errorCode = "BUILD_EXECUTION_ENDED";
    } else
      run.state =
        receipt.state === "running"
          ? "running"
          : receipt.state === "collecting"
            ? "validating"
            : "starting";
    this.#save(run);
  }
  async #publish(run: RequestBuildRun): Promise<void> {
    const publication = run.publication!,
      sessions = this.deps.sessions;
    const read = (op: Parameters<CodingSessionsService["readRequestBuildGitHub"]>[0]) =>
      sessions.readRequestBuildGitHub(op);
    const branch = buildPublicationBranch(run.intent);
    // Explicit approved-base policy: main movement blocks NEW writes, never silently rebases approval.
    if ((await resolveRequestBuildBase(read)) !== run.intent.baseSha)
      throw new Error("BUILD_BASE_MOVED");
    await this.#current(run);
    let operation: RequestBuildGitHubWrite;
    if (!publication.tree)
      operation = {
        kind: "tree",
        baseTree: publication.artifact.baseTree,
        entries: publication.artifact.entries,
      };
    else if (!publication.head)
      operation = {
        kind: "commit",
        tree: publication.tree,
        parent: run.intent.baseSha,
        message: `Request build ${run.runId}/${run.intent.attempt}\nArtifact ${publication.artifact.artifactHash}`,
        date: new Date(run.createdAt).toISOString(),
      };
    else if (!publication.refVerified) {
      if ((await read({ kind: "ref", branch })) !== null)
        throw new Error("BUILD_PUBLICATION_CONFLICT");
      operation = { kind: "ref", branch, sha: publication.head };
    } else {
      const existing = await read({ kind: "pulls", branch });
      if (
        existing === null ||
        !Array.isArray(JSON.parse(existing)) ||
        JSON.parse(existing).length !== 0
      )
        throw new Error("BUILD_PUBLICATION_CONFLICT");
      operation = {
        kind: "pull",
        branch,
        title: `Request build ${run.runId}`,
        body: buildPublicationBody(
          run.intent,
          run.requestId,
          run.requestRevision,
          publication.artifact.artifactHash,
        ),
      };
    }
    const hash = await buildHash(canonicalBuildJson(operation));
    await this.#current(run);
    publication.pending = { operation, hash, sent: true };
    run.state = "publishing";
    this.#save(run); // Irreversible intent BEFORE the RPC/HTTP call; no caller completion dependency.
    const response = await sessions.writeRequestBuildGitHub(
      run.owner,
      {
        dispatchKey: run.intent.dispatchKey,
        intentHash: run.intentHash,
        sessionId: run.receipt!.sessionId,
        generation: run.receipt!.generation,
        phase: "publish",
        publicationHash: hash,
      },
      operation,
    );
    const verified = await verifyBuildPublicationResult(
      read,
      run.intent,
      publication,
      operation,
      response,
    );
    const current = this.#get(run.runId)!;
    if (current.publication?.pending?.hash !== hash) throw new Error("BUILD_PUBLICATION_CONFLICT");
    current.publication = verified;
    if (verified.pullRequest) current.state = "pr_created";
    this.#save(current);
  }
}
