import type { CodingSessionDevelopmentComponentStatus } from "@gadgets/workshop-shared/api";
import type { ProcessLogEvent, ProcessStatus, SandboxCommand, SandboxProcess } from "@cloudflare/sandbox";
import type { DevelopmentHealthSpec, DevelopmentProcessSpec } from "./development-catalog.js";
import type { DevelopmentGenerationComponentIntent, DevelopmentGenerationIntent } from "./development-intent.js";

/** Minimum Sandbox-next process surface used by component supervision. */
export interface DevelopmentSupervisorSandbox {
  exec(argv: SandboxCommand, options: { cwd: string; env: Record<string, string>; timeout?: number }): Promise<SandboxProcess>;
  getProcess(id: string): Promise<SandboxProcess | null>;
  listProcesses(): Promise<ProcessStatus[]>;
  exists(path: string): Promise<{ exists: boolean }>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, content: string): Promise<unknown>;
}

/** Durable private runtime checkpoint for one generation. */
export interface DevelopmentSupervisorState {
  generation: number;
  sandboxId: string;
  components: Record<string, DevelopmentComponentRuntime>;
  updatedAt: number;
}

/** Durable private runtime checkpoint for one component. */
export interface DevelopmentComponentRuntime {
  status: CodingSessionDevelopmentComponentStatus;
  processes: Record<string, {
    phase: "launching" | "launched";
    processId?: string;
    attempts: number;
    marker: string;
  }>;
  completedJobs: string[];
  logs: DevelopmentComponentLogSnapshot;
  diagnostics?: { code: string; observedAt: number; maxBytes: number; maxLines: number };
  message?: string;
  restartAfter?: number;
  updatedAt: number;
}

/** Bounded private log tail and continuation metadata for one supervised process. */
export interface DevelopmentComponentLogSnapshot {
  cursors: Record<string, string>;
  text: string;
  bytes: number;
  lines: number;
  truncated: boolean;
  terminals: Record<string, "exited" | "error">;
}

/** Display-safe component lifecycle update emitted behind an exact generation fence. */
export interface DevelopmentSupervisorUpdate {
  sessionId: string;
  sandboxId: string;
  generation: number;
  components: Array<{ id: string; title: string; status: CodingSessionDevelopmentComponentStatus; message?: string; updatedAt: Date }>;
  applications: Array<{ id: string; componentId: string; title: string; status: CodingSessionDevelopmentComponentStatus; message?: string; previewAvailable: false }>;
}

/** Creates an empty durable checkpoint for a server-authored generation intent. */
export function createDevelopmentSupervisorState(intent: DevelopmentGenerationIntent, now = Date.now()): DevelopmentSupervisorState {
  return {
    generation: intent.generation,
    sandboxId: intent.sandboxId,
    components: Object.fromEntries(intent.components.map(component => [component.id, {
      status: "pending" as const, processes: {}, completedJobs: [],
      logs: { cursors: {}, text: "", bytes: 0, lines: 0, truncated: false, terminals: {} }, updatedAt: now,
    }])),
    updatedAt: now,
  };
}

/** Advances one crash-resumable component reconcile pass without minting any preview authority. */
export async function reconcileDevelopmentGeneration(
  intent: DevelopmentGenerationIntent,
  state: DevelopmentSupervisorState,
  sandbox: DevelopmentSupervisorSandbox,
  configuration: Readonly<Record<string, string>> = {},
  now = Date.now(),
  checkpoint: (state: DevelopmentSupervisorState) => Promise<void> = () => Promise.resolve(),
): Promise<DevelopmentSupervisorState> {
  assertFence(intent, state);
  for (const component of intent.components) {
    const runtime = requiredRuntime(state, component.id);
    if (runtime.status === "failed" || runtime.status === "stopped" || runtime.status === "stopping") continue;
    const dependencyStatuses = component.dependencyIds.map(id => requiredRuntime(state, id).status);
    if (dependencyStatuses.some(status => status !== "ready")) {
      if (dependencyStatuses.some(status => ["degraded", "failed", "stopping", "stopped"].includes(status)) &&
          runtime.status !== "degraded") {
        runtime.status = "degraded";
        runtime.message = "A required component is unavailable.";
        runtime.updatedAt = now;
        await checkpoint(state);
      }
      continue;
    }
    try {
      await reconcileComponent(component, state, runtime, sandbox, configuration, now, checkpoint);
    } catch {
      runtime.status = "failed";
      runtime.message = "Component supervision lost process provenance. Restart the session.";
      runtime.diagnostics = {
        code: "process-provenance-lost", observedAt: now,
        maxBytes: component.executionSpec.logs.maxBytes, maxLines: component.executionSpec.logs.maxLines,
      };
      runtime.updatedAt = now;
      await checkpoint(state);
    }
  }
  state.updatedAt = now;
  await checkpoint(state);
  return state;
}

/** Stops services in reverse topological order and the catalog-validated per-component order. */
export async function cleanupDevelopmentGeneration(
  intent: DevelopmentGenerationIntent,
  state: DevelopmentSupervisorState,
  sandbox: DevelopmentSupervisorSandbox,
  now = Date.now(),
  checkpoint: (state: DevelopmentSupervisorState) => Promise<void> = () => Promise.resolve(),
): Promise<DevelopmentSupervisorState> {
  assertFence(intent, state);
  for (const component of intent.components.toReversed()) {
    const runtime = requiredRuntime(state, component.id);
    runtime.status = "stopping";
    runtime.updatedAt = now;
    await checkpoint(state);
    for (const processId of component.executionSpec.stop.processOrder) {
      const launched = runtime.processes[processId];
      if (!launched) continue;
      let process: SandboxProcess | null = null;
      try {
        process = await adoptedProcess(processSpec(component, processId), launched, sandbox);
      } catch {
        runtime.diagnostics = {
          code: "cleanup-provenance-mismatch", observedAt: now,
          maxBytes: component.executionSpec.logs.maxBytes, maxLines: component.executionSpec.logs.maxLines,
        };
        await checkpoint(state);
        continue;
      }
      if (!process) continue;
      await captureProcessLogs(component, runtime, processId, process);
      await checkpoint(state);
      const status = await process.status();
      if (status.state === "running") await terminateProcess(process, component.executionSpec.stop.graceMs);
    }
    runtime.status = "stopped";
    runtime.updatedAt = now;
    await checkpoint(state);
  }
  state.updatedAt = now;
  await checkpoint(state);
  return state;
}

/** Projects a bounded display-safe update. Commands, environment, images, ports, and process IDs are omitted. */
export function publicDevelopmentSupervisorUpdate(
  intent: DevelopmentGenerationIntent,
  state: DevelopmentSupervisorState,
): DevelopmentSupervisorUpdate {
  assertFence(intent, state);
  return {
    sessionId: intent.sessionId,
    sandboxId: intent.sandboxId,
    generation: intent.generation,
    components: intent.components.map(component => {
      const runtime = requiredRuntime(state, component.id);
      return {
        id: component.id,
        title: component.title,
        status: runtime.status,
        ...(runtime.message ? { message: runtime.message } : {}),
        updatedAt: new Date(runtime.updatedAt),
      };
    }),
    applications: intent.components.flatMap(component => {
      const runtime = requiredRuntime(state, component.id);
      return component.applications.map(application => ({
        id: application.id,
        componentId: component.id,
        title: application.title,
        status: runtime.status,
        previewAvailable: false as const,
        ...(runtime.message ? { message: runtime.message } : {}),
      }));
    }),
  };
}

async function reconcileComponent(
  component: DevelopmentGenerationComponentIntent,
  state: DevelopmentSupervisorState,
  runtime: DevelopmentComponentRuntime,
  sandbox: DevelopmentSupervisorSandbox,
  configuration: Readonly<Record<string, string>>,
  now: number,
  checkpoint: (state: DevelopmentSupervisorState) => Promise<void>,
): Promise<void> {
  const previouslyReady = runtime.status === "ready";
  if (runtime.restartAfter !== undefined && runtime.restartAfter > now) return;
  runtime.restartAfter = undefined;
  runtime.status = "starting";
  runtime.message = undefined;
  runtime.updatedAt = now;
  await checkpoint(state);

  if (previouslyReady) {
    let allHealthy = true;
    for (const processSpec of component.executionSpec.processes.filter(process => process.phase === "service")) {
      const launched = runtime.processes[processSpec.id];
      const process = launched ? await adoptedProcess(processSpec, launched, sandbox) : null;
      if (!process) { allHealthy = false; break; }
      await captureProcessLogs(component, runtime, processSpec.id, process);
      await checkpoint(state);
      const status = await process.status();
      if (status.state !== "running") { allHealthy = false; break; }
      const probe = component.executionSpec.liveness.find(entry => entry.processId === processSpec.id)!;
      try {
        await runProbe(probe, process, sandbox);
      } catch {
        runtime.status = "degraded";
        runtime.message = "A component health check failed.";
        runtime.diagnostics = {
          code: "liveness-failed", observedAt: now,
          maxBytes: component.executionSpec.logs.maxBytes, maxLines: component.executionSpec.logs.maxLines,
        };
        runtime.updatedAt = now;
        await checkpoint(state);
        await terminateProcess(process, component.executionSpec.stop.graceMs);
        if (launched.attempts >= component.executionSpec.restart.maxAttempts) {
          runtime.status = "failed";
          runtime.message = "A component exhausted its restart policy.";
          await checkpoint(state);
          return;
        }
        if (component.executionSpec.restart.backoffMs > 0) {
          runtime.restartAfter = now + component.executionSpec.restart.backoffMs;
          await checkpoint(state);
        } else {
          await restartService(component, state, processSpec, runtime, sandbox, configuration, checkpoint);
        }
        return;
      }
    }
    if (allHealthy) {
      runtime.status = "ready";
      runtime.updatedAt = now;
      await checkpoint(state);
      return;
    }
  }

  for (const processSpec of component.executionSpec.processes.filter(process => process.phase !== "service")) {
    const markerPath = jobMarker(component.id, processSpec.id);
    if ((await sandbox.exists(markerPath)).exists) {
      if (!runtime.completedJobs.includes(processSpec.id)) {
        runtime.completedJobs.push(processSpec.id);
        delete runtime.processes[processSpec.id];
        await checkpoint(state);
      }
      continue;
    }
    if (runtime.completedJobs.includes(processSpec.id)) {
      if (component.executionSpec.dataDisposition === "checkpointable") {
        throw new Error("checkpoint-authority-lost");
      }
      runtime.completedJobs = runtime.completedJobs.filter(id => id !== processSpec.id);
      delete runtime.processes[processSpec.id];
      await checkpoint(state);
    }
    const process = await runningOrLaunch(
      state.generation, component.id, processSpec, runtime, state, sandbox, configuration, checkpoint,
    );
    await captureProcessLogs(component, runtime, processSpec.id, process);
    await checkpoint(state);
    const status = await process.status();
    if (status.state === "running") return;
    if (status.state !== "exited" || status.exit.code !== 0 || status.exit.timedOut) {
      throw new Error("one-shot-failed");
    }
    await sandbox.mkdir(markerPath.slice(0, markerPath.lastIndexOf("/")), { recursive: true });
    await sandbox.writeFile(markerPath, "complete\n");
    runtime.completedJobs.push(processSpec.id);
    delete runtime.processes[processSpec.id];
    await checkpoint(state);
  }

  for (const processSpec of component.executionSpec.processes.filter(process => process.phase === "service")) {
    let process = await runningOrLaunch(
      state.generation, component.id, processSpec, runtime, state, sandbox, configuration, checkpoint,
    );
    await captureProcessLogs(component, runtime, processSpec.id, process);
    await checkpoint(state);
    let status = await process.status();
    if (status.state !== "running") {
      process = await restartService(component, state, processSpec, runtime, sandbox, configuration, checkpoint);
      status = await process.status();
      if (status.state !== "running") throw new Error("service-exited");
    }
    const readiness = component.executionSpec.readiness.find(probe => probe.processId === processSpec.id)!;
    try {
      await runProbe(readiness, process, sandbox);
    } catch {
      runtime.status = "degraded";
      runtime.message = "A component readiness check failed.";
      runtime.diagnostics = {
        code: "readiness-failed", observedAt: now,
        maxBytes: component.executionSpec.logs.maxBytes, maxLines: component.executionSpec.logs.maxLines,
      };
      runtime.updatedAt = now;
      await checkpoint(state);
      const launched = runtime.processes[processSpec.id]!;
      await terminateProcess(process, component.executionSpec.stop.graceMs);
      if (launched.attempts >= component.executionSpec.restart.maxAttempts) {
        runtime.status = "failed";
        runtime.message = "A component exhausted its restart policy.";
        await checkpoint(state);
        return;
      }
      if (component.executionSpec.restart.backoffMs > 0) {
        runtime.restartAfter = now + component.executionSpec.restart.backoffMs;
        await checkpoint(state);
      } else {
        await restartService(component, state, processSpec, runtime, sandbox, configuration, checkpoint);
      }
      return;
    }
  }
  runtime.status = "ready";
  runtime.message = undefined;
  runtime.updatedAt = now;
  await checkpoint(state);
}

async function runningOrLaunch(
  generation: number,
  componentId: string,
  spec: DevelopmentProcessSpec,
  runtime: DevelopmentComponentRuntime,
  state: DevelopmentSupervisorState,
  sandbox: DevelopmentSupervisorSandbox,
  configuration: Readonly<Record<string, string>>,
  checkpoint: (state: DevelopmentSupervisorState) => Promise<void>,
): Promise<SandboxProcess> {
  if (spec.imageId) throw new Error("reviewed-image-execution-unavailable");
  const existing = runtime.processes[spec.id];
  if (existing) {
    const adopted = await adoptedProcess(spec, existing, sandbox);
    if (!adopted) throw new Error("process-provenance-lost");
    if (existing.phase !== "launched" || existing.processId !== adopted.id) {
      runtime.processes[spec.id] = { ...existing, phase: "launched", processId: adopted.id };
      await checkpoint(state);
    }
    return adopted;
  }
  return launchProcess(generation, componentId, spec, 0, runtime, state, sandbox, configuration, checkpoint);
}

async function restartService(
  component: DevelopmentGenerationComponentIntent,
  state: DevelopmentSupervisorState,
  spec: DevelopmentProcessSpec,
  runtime: DevelopmentComponentRuntime,
  sandbox: DevelopmentSupervisorSandbox,
  configuration: Readonly<Record<string, string>>,
  checkpoint: (state: DevelopmentSupervisorState) => Promise<void>,
): Promise<SandboxProcess> {
  const attempts = runtime.processes[spec.id]?.attempts ?? 0;
  if (attempts >= component.executionSpec.restart.maxAttempts) throw new Error("restart-exhausted");
  return launchProcess(state.generation, component.id, spec, attempts + 1, runtime, state, sandbox, configuration, checkpoint);
}

async function launchProcess(
  generation: number,
  componentId: string,
  spec: DevelopmentProcessSpec,
  attempts: number,
  runtime: DevelopmentComponentRuntime,
  state: DevelopmentSupervisorState,
  sandbox: DevelopmentSupervisorSandbox,
  configuration: Readonly<Record<string, string>>,
  checkpoint: (state: DevelopmentSupervisorState) => Promise<void>,
): Promise<SandboxProcess> {
  const marker = `g${generation}:${componentId}:${spec.id}:a${attempts}`;
  delete runtime.logs.cursors[spec.id];
  delete runtime.logs.terminals[spec.id];
  runtime.processes[spec.id] = { phase: "launching", attempts, marker };
  await checkpoint(state);
  const process = await sandbox.exec(markedCommand(spec.argv, marker), {
    cwd: spec.cwd,
    env: environmentFor(spec, configuration),
    ...(spec.phase === "service" ? {} : { timeout: spec.timeoutMs }),
  });
  runtime.processes[spec.id] = { phase: "launched", processId: process.id, attempts, marker };
  await checkpoint(state);
  return process;
}

async function adoptedProcess(
  spec: DevelopmentProcessSpec,
  record: DevelopmentComponentRuntime["processes"][string],
  sandbox: DevelopmentSupervisorSandbox,
): Promise<SandboxProcess | null> {
  if (record.processId) {
    const direct = await sandbox.getProcess(record.processId);
    if (direct) {
      await assertProcessProvenance(direct, spec, record.marker);
      return direct;
    }
  }
  const expected = markedCommand(spec.argv, record.marker);
  const candidates = (await sandbox.listProcesses()).filter(status =>
    JSON.stringify(status.command) === JSON.stringify(expected) && status.cwd === spec.cwd);
  // Zero could mean a crash before exec or an unresolved remote launch; multiple is also ambiguous.
  // Fail the generation rather than trade availability for a possible duplicate process.
  if (candidates.length !== 1) return null;
  const adopted = await sandbox.getProcess(candidates[0]!.id);
  if (!adopted) return null;
  await assertProcessProvenance(adopted, spec, record.marker);
  return adopted;
}

async function captureProcessLogs(
  component: DevelopmentGenerationComponentIntent,
  runtime: DevelopmentComponentRuntime,
  processId: string,
  process: SandboxProcess,
): Promise<void> {
  try {
    const previousCursor = runtime.logs.cursors[processId];
    const stream = await process.logs({
      ...(previousCursor ? { since: previousCursor } : {}),
      replay: true,
      follow: false,
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let eventCount = 0;
    let observedBytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const event: ProcessLogEvent = result.value;
        eventCount++;
        if (event.type === "stdout" || event.type === "stderr") observedBytes += event.data.byteLength;
        if (event.cursor) runtime.logs.cursors[processId] = event.cursor;
        if (event.type === "stdout" || event.type === "stderr") {
          const bounded = boundedLogTail(
            runtime.logs.text + decoder.decode(event.data),
            component.executionSpec.logs.maxBytes,
            component.executionSpec.logs.maxLines,
          );
          runtime.logs.text = bounded.text;
          runtime.logs.bytes = bounded.bytes;
          runtime.logs.lines = bounded.lines;
          runtime.logs.truncated ||= bounded.truncated;
        } else if (event.type === "truncated") {
          runtime.logs.truncated = true;
        } else if (event.type === "terminal") {
          runtime.logs.terminals[processId] = event.state;
        }
        if (eventCount >= 512 || observedBytes >= component.executionSpec.logs.maxBytes * 4) {
          runtime.logs.truncated = true;
          await reader.cancel();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch {
    // Log collection is diagnostic only and must never change component health.
  }
}

function boundedLogTail(
  value: string,
  maxBytes: number,
  maxLines: number,
): { text: string; bytes: number; lines: number; truncated: boolean } {
  const encoder = new TextEncoder();
  let encoded = encoder.encode(value);
  let text = value;
  let truncated = false;
  if (encoded.byteLength > maxBytes) {
    let start = encoded.byteLength - maxBytes;
    while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start++;
    text = new TextDecoder().decode(encoded.subarray(start));
    truncated = true;
  }
  let lines = text ? 1 : 0;
  for (let index = text.length - 1; index >= 0; index--) {
    if (text[index] !== "\n") continue;
    if (lines >= maxLines) {
      text = text.slice(index + 1);
      truncated = true;
      break;
    }
    lines++;
  }
  encoded = encoder.encode(text);
  lines = text ? text.split("\n").length : 0;
  return { text, bytes: encoded.byteLength, lines, truncated };
}

async function runProbe(
  probe: DevelopmentHealthSpec,
  service: SandboxProcess,
  sandbox: DevelopmentSupervisorSandbox,
): Promise<void> {
  if (probe.kind === "tcp") return service.waitForPort(probe.port, { mode: "tcp", timeout: probe.timeoutMs });
  if (probe.kind === "http") {
    const statuses = [...probe.statuses].toSorted((a, b) => a - b);
    const status = statuses.length === 1 ? statuses[0] : { min: statuses[0]!, max: statuses.at(-1)! };
    return service.waitForPort(probe.port, { mode: "http", path: probe.path, status, timeout: probe.timeoutMs });
  }
  const process = await sandbox.exec(sandboxCommand(probe.argv), { cwd: probe.cwd, env: {}, timeout: probe.timeoutMs });
  let result;
  try {
    result = await process.waitForExit({ timeout: probe.timeoutMs });
  } catch {
    await terminateProcess(process, probe.timeoutMs);
    throw new Error("health-timeout");
  }
  if (result.code !== 0 || result.timedOut) throw new Error("health-failed");
}

async function terminateProcess(process: SandboxProcess, graceMs: number): Promise<void> {
  await process.kill(15).catch(() => undefined);
  try {
    await process.waitForExit({ timeout: graceMs });
    return;
  } catch {
    // A rejected local wait does not stop the remote process; escalate below.
  }
  await process.kill(9);
  await process.waitForExit({ timeout: graceMs });
}

async function assertProcessProvenance(
  process: SandboxProcess,
  spec: DevelopmentProcessSpec,
  marker: string,
): Promise<void> {
  const status = await process.status();
  if (JSON.stringify(status.command) !== JSON.stringify(markedCommand(spec.argv, marker)) || status.cwd !== spec.cwd) {
    throw new Error("process-provenance-mismatch");
  }
}

function markedCommand(argv: string[], marker: string): SandboxCommand {
  return ["/usr/bin/env", `ODIE_SUPERVISION_MARKER=${marker}`, ...sandboxCommand(argv)];
}

function environmentFor(spec: DevelopmentProcessSpec, configuration: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(spec.environment.map(entry => {
    if (entry.source.kind === "literal") return [entry.name, entry.source.value];
    const value = configuration[entry.source.requirement];
    if (value === undefined) throw new Error(`Required configuration ${entry.source.requirement} is unavailable.`);
    return [entry.name, value];
  }));
}

function jobMarker(componentId: string, processId: string): string {
  return `/tmp/odie-supervision/${componentId}/${processId}.complete`;
}

function sandboxCommand(argv: string[]): SandboxCommand {
  const [command, ...args] = argv;
  if (!command) throw new Error("Development process command is empty.");
  return [command, ...args];
}

function processSpec(component: DevelopmentGenerationComponentIntent, id: string): DevelopmentProcessSpec {
  const spec = component.executionSpec.processes.find(process => process.id === id);
  if (!spec) throw new Error(`Unknown process ${id}.`);
  return spec;
}

function requiredRuntime(state: DevelopmentSupervisorState, id: string): DevelopmentComponentRuntime {
  const runtime = state.components[id];
  if (!runtime) throw new Error(`Development runtime is missing ${id}.`);
  return runtime;
}

function assertFence(intent: DevelopmentGenerationIntent, state: DevelopmentSupervisorState): void {
  if (intent.generation !== state.generation || intent.sandboxId !== state.sandboxId) {
    throw new Error("Development supervisor generation fence does not match.");
  }
}
