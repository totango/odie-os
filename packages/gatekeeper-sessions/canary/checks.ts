import type { SandboxProcess, Terminal } from "@cloudflare/sandbox";
import { ContainerUnavailableError } from "@cloudflare/sandbox/errors";
import type { CodeContext, ExecutionResult, Interpreter } from "@cloudflare/sandbox/interpreter";
import versions from "./versions.json";

const EDITOR_PORT = 13_337;
const PROCESS_TIMEOUT_MS = 30_000;
const NODE_EXEC_MAX_ATTEMPTS = 6;
const NODE_EXEC_DEFAULT_RETRY_DELAY_MS = 1_000;
const NODE_EXEC_MAX_RETRY_DELAY_MS = 10_000;
const MAX_INTERPRETER_STDOUT_BYTES = 4_096;
const MAX_TERMINAL_BYTES = 16 * 1024;
const MAX_TERMINAL_EVENTS = 128;
export const EXPECTED_NODE_VERSION = versions.node;

/** Named stages accepted by test-only fault injection. */
export type CanaryStage = "node" | "javascript" | "typescript" | "terminal" | "code-server" | "cleanup";

/** Closed, non-sensitive failure stages returned by the native canary endpoint. */
export type CanaryFailureStage = CanaryStage | "lifecycle";

/** Associates an internal canary error with its safe public stage without discarding its cause. */
export class CanaryStageError extends Error {
  constructor(readonly failureStage: CanaryFailureStage, cause: unknown) {
    super(`Canary ${failureStage} stage failed.`, { cause });
    this.name = "CanaryStageError";
  }
}

/** Minimal public Sandbox client surface used by the canary. */
export interface CanarySandboxClient {
  exec(command: readonly [string, ...string[]], options?: {
    timeout?: number;
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<SandboxProcess>;
  createTerminal(options: {
    command: readonly [string, ...string[]];
    cwd?: string;
    cols?: number;
    rows?: number;
    bufferSize?: number;
  }): Promise<Terminal>;
  listProcesses(): Promise<Array<{ id: string; state: string }>>;
  listTerminals(): Promise<Terminal[]>;
  getProcess(id: string): Promise<SandboxProcess | null>;
  getTerminal(id: string): Promise<Terminal | null>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, content: string): Promise<unknown>;
  containerFetch(request: Request, port: number): Promise<Response>;
  interpreter: Pick<Interpreter, "createCodeContext" | "runCode" | "deleteCodeContext">;
}

/** Optional deterministic fault hook used only by unit tests. */
export interface CanaryCheckOptions {
  beforeStage?: (stage: CanaryStage) => void;
}

/** Successful, bounded native canary report. */
export interface CanaryChecksReport {
  checks: readonly ["node", "javascript", "typescript", "terminal", "code-server", "cleanup"];
  resourceIds: { process: string[]; terminal: string[] };
}

/** Exercises the candidate and cleans every resource even when a check fails. */
export async function runCanary(
  sandbox: CanarySandboxClient,
  options: CanaryCheckOptions = {},
): Promise<CanaryChecksReport> {
  let terminal: Terminal | undefined;
  const terminalIds: string[] = [];
  const processes: SandboxProcess[] = [];
  const contexts: CodeContext[] = [];
  let operationError: unknown;
  let operationStage: Exclude<CanaryStage, "cleanup"> = "node";
  const cleanupErrors: unknown[] = [];

  try {
    options.beforeStage?.("node");
    const node = await startNodeCanaryProcess(sandbox);
    processes.push(node);
    const nodeOutput = await node.output({ encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, maxBytes: 4096 });
    assert(nodeOutput.stdout === `odie-node-version:${EXPECTED_NODE_VERSION}\nodie-node-stdout:42\n`,
      "Node version/stdout did not match.");
    assert(nodeOutput.stderr === "odie-node-stderr:ok\n", "Node stderr did not match.");
    assert(nodeOutput.exitCode === 0 && !nodeOutput.timedOut && !nodeOutput.truncated,
      "Node process did not exit cleanly.");

    operationStage = "javascript";
    options.beforeStage?.("javascript");
    const javascriptContext = await sandbox.interpreter.createCodeContext({
      language: "javascript", cwd: "/workspace",
    });
    contexts.push(javascriptContext);
    assertInterpreterOutput(await sandbox.interpreter.runCode(
      "const answer = 6 * 7; console.log(`odie-js:${answer}`);",
      { context: javascriptContext },
    ), "odie-js:42");

    operationStage = "typescript";
    options.beforeStage?.("typescript");
    const typescriptContext = await sandbox.interpreter.createCodeContext({
      language: "typescript", cwd: "/workspace",
    });
    contexts.push(typescriptContext);
    assertInterpreterOutput(await sandbox.interpreter.runCode(
      "const answer: number = 6 * 7; console.log(`odie-ts:${answer}`);",
      { context: typescriptContext },
    ), "odie-ts:42");

    operationStage = "terminal";
    options.beforeStage?.("terminal");
    terminal = await sandbox.createTerminal({
      command: [
        "/bin/sh", "-lc",
        "IFS= read -r line; printf 'odie-terminal:<%s>\\n' \"$line\"; exec sleep 600",
      ],
      cwd: "/workspace", cols: 80, rows: 24, bufferSize: 16 * 1024,
    });
    terminalIds.push(terminal.id);
    await terminal.resize(100, 30);
    const terminalOutput = terminal.output({ replay: true, follow: true, signal: AbortSignal.timeout(PROCESS_TIMEOUT_MS) });
    await terminal.write(new TextEncoder().encode("forty-two\n"));
    const observed = await readUntil(terminalOutput, "odie-terminal:<forty-two>");
    assert(observed.includes("odie-terminal:<forty-two>"), "Terminal output did not match.");
    await terminal.terminate();
    const terminalExit = await terminal.waitForExit({ timeout: PROCESS_TIMEOUT_MS });
    assert(!terminalExit.timedOut, "Terminal termination timed out.");
    terminal = undefined;

    operationStage = "code-server";
    options.beforeStage?.("code-server");
    const userDataDir = "/workspace/.odie-code-server/user-data";
    await sandbox.mkdir(`${userDataDir}/User`, { recursive: true });
    await sandbox.writeFile(`${userDataDir}/User/settings.json`, JSON.stringify({
      "extensions.autoCheckUpdates": false,
      "extensions.autoUpdate": false,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
    }));
    const editor = await sandbox.exec([
      "code-server",
      "--bind-addr", `0.0.0.0:${EDITOR_PORT}`,
      "--auth", "none",
      "--disable-telemetry",
      "--disable-update-check",
      "--disable-workspace-trust",
      "--extensions-dir", "/opt/odie-code-server/extensions",
      "--user-data-dir", userDataDir,
      "/workspace",
    ], {
      cwd: "/workspace",
      env: {
        CS_DISABLE_GETTING_STARTED_OVERRIDE: "1",
        EXTENSIONS_GALLERY: "{}",
        VSCODE_PROXY_URI: "./proxy/{{port}}",
      },
    });
    processes.push(editor);
    await editor.waitForPort(EDITOR_PORT, {
      mode: "http", path: "/", status: { min: 200, max: 399 }, timeout: PROCESS_TIMEOUT_MS,
    });
    const editorResponse = await sandbox.containerFetch(new Request("http://localhost/"), EDITOR_PORT);
    assert(editorResponse.status >= 200 && editorResponse.status <= 399, "code-server was not ready.");
    await editorResponse.body?.cancel();
    await stopProcess(editor);
  } catch (error) {
    operationError = new CanaryStageError(classifyCanaryOperationFailure(operationStage, error), error);
  } finally {
    for (const context of contexts.toReversed()) {
      try {
        await sandbox.interpreter.deleteCodeContext(context.id);
      } catch (error) {
        cleanupErrors.push(new CanaryStageError("cleanup", error));
      }
    }
    if (terminal) {
      try {
        await terminal.terminate();
        const exit = await terminal.waitForExit({ timeout: 5_000 });
        assert(!exit.timedOut, "Terminal cleanup timed out.");
      } catch (error) {
        cleanupErrors.push(new CanaryStageError("cleanup", error));
      }
    }
    for (const process of processes.toReversed()) {
      try {
        await stopProcess(process);
      } catch (error) {
        cleanupErrors.push(new CanaryStageError("cleanup", error));
      }
    }
  }

  if (operationError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([operationError, ...cleanupErrors], "Canary operation and resource cleanup failed.");
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Canary resource cleanup failed.");

  try {
    options.beforeStage?.("cleanup");
    const [activeProcesses, terminals] = await Promise.all([sandbox.listProcesses(), sandbox.listTerminals()]);
    assert(!activeProcesses.some(process => process.state === "running"), "A canary process is still running.");
    const snapshots = await Promise.all(terminals.map(terminalHandle => terminalHandle.getSnapshot()));
    assert(!snapshots.some(snapshot => snapshot.status === "running"), "A canary terminal is still running.");
    return {
      checks: ["node", "javascript", "typescript", "terminal", "code-server", "cleanup"],
      resourceIds: { process: processes.map(process => process.id), terminal: terminalIds },
    };
  } catch (error) {
    throw new CanaryStageError("cleanup", error);
  }
}

/** Classifies exhausted container startup separately from an admitted Node runtime check. */
export function classifyCanaryOperationFailure(
  stage: Exclude<CanaryStage, "cleanup">,
  error: unknown,
): CanaryFailureStage {
  return stage === "node" && error instanceof ContainerUnavailableError ? "lifecycle" : stage;
}

/** Starts the initial Node check, retrying only pre-admission container unavailability. */
export async function startNodeCanaryProcess(
  sandbox: Pick<CanarySandboxClient, "exec">,
  sleep: (delayMs: number) => Promise<void> = delay,
): Promise<SandboxProcess> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sandbox.exec([
        "node", "--eval",
        "process.stdout.write(`odie-node-version:${process.version}\\nodie-node-stdout:42\\n`); process.stderr.write('odie-node-stderr:ok\\n')",
      ], { timeout: PROCESS_TIMEOUT_MS });
    } catch (error) {
      if (!(error instanceof ContainerUnavailableError) || attempt >= NODE_EXEC_MAX_ATTEMPTS) throw error;
      await sleep(nodeExecRetryDelay(error.context.retryAfterMs, attempt));
    }
  }
}

function nodeExecRetryDelay(retryAfterMs: number | undefined, attempt: number): number {
  if (Number.isSafeInteger(retryAfterMs) && retryAfterMs !== undefined && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, NODE_EXEC_MAX_RETRY_DELAY_MS);
  }
  return Math.min(NODE_EXEC_DEFAULT_RETRY_DELAY_MS * 2 ** (attempt - 1), NODE_EXEC_MAX_RETRY_DELAY_MS);
}

function delay(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

/** Claims one run, applies a real Worker-side deadline, and destroys only after a successful claim. */
export async function runClaimedCanaryLifecycle(
  sandbox: CanarySandboxClient & {
    claimOneShot(): void | Promise<void>;
    destroy(): Promise<void>;
  },
  operation: () => Promise<CanaryChecksReport>,
  options: { runTimeoutMs: number; settleTimeoutMs: number; destroyTimeoutMs: number },
): Promise<CanaryChecksReport> {
  validateTimeout(options.runTimeoutMs, "runTimeoutMs", 15 * 60_000);
  validateTimeout(options.settleTimeoutMs, "settleTimeoutMs", 120_000);
  validateTimeout(options.destroyTimeoutMs, "destroyTimeoutMs", 120_000);
  let claimed = false;
  let work: Promise<CanaryChecksReport> | undefined;
  let report: CanaryChecksReport | undefined;
  let workSettled = false;
  const failures: unknown[] = [];
  try {
    await sandbox.claimOneShot();
    claimed = true;
    work = Promise.resolve().then(operation);
    void work.then(() => { workSettled = true; }, () => { workSettled = true; });
    void work.catch(() => undefined);
    report = await withDeadline(work, options.runTimeoutMs, "Canary run deadline exceeded.");
  } catch (error) {
    failures.push(error);
  } finally {
    if (claimed) {
      let firstDestroyFailed = false;
      try {
        await destroyAndVerifySandbox(sandbox, options.destroyTimeoutMs, report?.resourceIds);
      } catch (error) {
        firstDestroyFailed = true;
        failures.push(error);
      }
      const workWasPendingAtDestroy = work !== undefined && !workSettled;
      if (work) {
        try {
          await settleAfterDestroy(work, options.settleTimeoutMs);
        } catch (error) {
          failures.push(error);
        }
      }
      // A pending operation can resume after the first destroy and attempt another waking call.
      // Destroy and verify once more after the bounded settlement window; control-plane deletion is
      // the final backstop if the operation still cannot settle.
      if (workWasPendingAtDestroy || firstDestroyFailed) {
        try {
          await destroyAndVerifySandbox(sandbox, options.destroyTimeoutMs, report?.resourceIds);
        } catch (error) {
          failures.push(error);
        }
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Canary run and lifecycle cleanup failed.");
  if (!report) throw new Error("Canary did not produce a report.");
  return report;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleAfterDestroy(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timed-out");
  const timeout = new Promise<typeof timedOut>(resolve => {
    timer = setTimeout(() => resolve(timedOut), timeoutMs);
  });
  try {
    const result = await Promise.race([
      promise.then(() => undefined, () => undefined),
      timeout,
    ]);
    if (result === timedOut) throw new Error("Canary work did not settle after sandbox destroy.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Destroys the sandbox and proves the non-waking runtime lookups are empty. */
export async function destroyAndVerifySandbox(
  sandbox: Pick<CanarySandboxClient,
    "listProcesses" | "listTerminals" | "getProcess" | "getTerminal"> & { destroy(): Promise<void> },
  timeoutMs: number,
  resourceIds: CanaryChecksReport["resourceIds"] = { process: [], terminal: [] },
): Promise<void> {
  validateTimeout(timeoutMs, "destroyTimeoutMs", 120_000);
  await boundedOperation(() => sandbox.destroy(), timeoutMs, "Sandbox destroy timed out.");
  const verification = await boundedOperation(() => Promise.all([
    sandbox.listProcesses(),
    sandbox.listTerminals(),
    Promise.all(resourceIds.process.map(id => sandbox.getProcess(id))),
    Promise.all(resourceIds.terminal.map(id => sandbox.getTerminal(id))),
  ]), timeoutMs, "Post-destroy verification timed out.");
  const [processes, terminals, knownProcesses, knownTerminals] = verification;
  if (processes.length !== 0 || terminals.length !== 0 ||
      knownProcesses.some(process => process !== null) || knownTerminals.some(terminal => terminal !== null)) {
    throw new Error("Destroyed sandbox still has runtime resources.");
  }
}

async function boundedOperation<T>(operation: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const promise = Promise.resolve().then(operation);
  // The deadline only stops the local wait. Observe a late rejection from the underlying RPC.
  void promise.catch(() => undefined);
  return withDeadline(promise, timeoutMs, message);
}

function validateTimeout(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} is invalid.`);
  }
}

async function stopProcess(process: SandboxProcess): Promise<void> {
  const status = await process.status();
  if (status.state !== "running") return;
  await process.kill(15);
  try {
    const exit = await process.waitForExit({ timeout: 5_000 });
    if (!exit.timedOut) return;
  } catch {
    // A local wait timeout does not kill the process; SIGKILL is the bounded fallback.
  }
  await process.kill(9);
  const killed = await process.waitForExit({ timeout: 5_000 });
  assert(!killed.timedOut, "Process SIGKILL timed out.");
}

function assertInterpreterOutput(result: ExecutionResult, expected: string): void {
  assert(result.error === undefined, "Interpreter execution failed.");
  if (result.logs.stdout.length > 64 ||
      result.logs.stdout.reduce((bytes, value) => bytes + new TextEncoder().encode(value).byteLength, 0) >
        MAX_INTERPRETER_STDOUT_BYTES) {
    throw new Error("Interpreter stdout exceeded its bound.");
  }
  const output = result.logs.stdout.join("").replaceAll("\r\n", "\n").trimEnd();
  assert(output === expected, "Interpreter stdout did not match.");
}

async function readUntil(streamPromise: Promise<ReadableStream<import("@cloudflare/sandbox").TerminalOutputEvent>>, marker: string): Promise<string> {
  const stream = await streamPromise;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;
  let events = 0;
  try {
    while (!output.includes(marker)) {
      const { done, value } = await reader.read();
      if (done) break;
      events++;
      if (events > MAX_TERMINAL_EVENTS) throw new Error("Terminal event count exceeded its bound.");
      if (value.type === "data") {
        bytes += value.data.byteLength;
        if (bytes > MAX_TERMINAL_BYTES) throw new Error("Terminal output exceeded its bound.");
        output += decoder.decode(value.data, { stream: true });
      }
      if (value.type === "terminal" && value.state === "error") throw new Error("Terminal failed.");
    }
    return output.replaceAll("\r\n", "\n");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
