import { describe, expect, it } from "vitest";
import type { CodingSessionDevelopmentPlan } from "@gadgets/workshop-shared/api";
import type { ProcessLogEvent, ProcessStatus, SandboxCommand, SandboxProcess } from "@cloudflare/sandbox";
import {
  DEVELOPMENT_CATALOG,
  type DevelopmentCatalogDefinition,
  type DevelopmentExecutionSpec,
} from "../src/development-catalog.js";
import { createDevelopmentGenerationIntent } from "../src/development-intent.js";
import {
  cleanupDevelopmentGeneration,
  createDevelopmentSupervisorState,
  publicDevelopmentSupervisorUpdate,
  reconcileDevelopmentGeneration,
  type DevelopmentSupervisorSandbox,
} from "../src/development-supervisor.js";

function spec(argv = ["bin/service"], port = 3000): DevelopmentExecutionSpec {
  return {
    processes: [{ id: "service", phase: "service", argv, cwd: "/workspace", environment: [
      { name: "MODE", source: { kind: "literal", value: "test" } },
    ] }],
    images: [{ id: "runtime", reference: `example/runtime@sha256:${"a".repeat(64)}` }],
    minimumDiskBytes: 1,
    requirements: { configuration: [], capabilities: [] },
    readiness: [{ processId: "service", kind: "tcp", port, timeoutMs: 10 }],
    liveness: [{ processId: "service", kind: "tcp", port, timeoutMs: 10 }],
    applications: [], logs: { maxBytes: 100, maxLines: 10 },
    restart: { maxAttempts: 1, backoffMs: 0 },
    stop: { processOrder: ["service"], graceMs: 10 },
    dataDisposition: "disposable", egress: [],
  };
}

function catalog(): DevelopmentCatalogDefinition {
  return {
    revision: 7,
    enabledTiers: ["standard-1"],
    profiles: [],
    components: [{
      id: "database", revision: 2, title: "Database", description: "Database", available: true,
      execution: "sandbox", requiredRepositories: [], dependencyIds: [], minimumTier: "standard-1",
      applications: [], ports: [3000], executionSpec: spec(["db", "serve"]),
    }, {
      id: "api", revision: 4, title: "API", description: "API", available: true,
      execution: "sandbox", requiredRepositories: [], dependencyIds: ["database"], minimumTier: "standard-1",
      applications: [], ports: [3001], executionSpec: spec(["api", "serve"], 3001),
    }],
  };
}

function plan(): CodingSessionDevelopmentPlan {
  return {
    catalogRevision: 7, selection: { componentIds: ["api"] }, resolvedComponentIds: ["database", "api"],
    requiredRepositories: [], minimumTier: "standard-1", selectedTier: "standard-1",
    capacity: { available: true, active: 0, limit: 5 }, issues: [], canCreate: true,
  };
}

class FakeProcess implements SandboxProcess {
  readonly pid = 1;
  readonly exitCode = Promise.resolve(0);
  state: ProcessStatus["state"] = "running";
  portFailures = 0;
  killSignals: number[] = [];
  waitFails = false;
  waitRejectsOnce = false;
  waitTimesOut = false;
  logEvents: ProcessLogEvent[] = [];
  logCalls: Array<{ since?: string }> = [];
  constructor(
    readonly id: string,
    readonly command: SandboxCommand,
    readonly cwd: string,
    readonly onKill: (id: string) => void = () => undefined,
  ) {}
  status(): Promise<ProcessStatus> {
    const base = { id: this.id, pid: this.pid, command: this.command, cwd: this.cwd, startedAt: new Date(0).toISOString() };
    if (this.state === "running") return Promise.resolve({ ...base, state: "running" });
    if (this.state === "exited") return Promise.resolve({ ...base, state: "exited", exit: { code: 0 }, endedAt: new Date(1).toISOString() });
    return Promise.resolve({ ...base, state: "error", error: { message: "failed" }, endedAt: new Date(1).toISOString() });
  }
  logs(options: { since?: string } = {}): ReturnType<SandboxProcess["logs"]> {
    this.logCalls.push(options);
    const start = options.since ? this.logEvents.findIndex(event => event.cursor === options.since) + 1 : 0;
    return Promise.resolve(new ReadableStream<ProcessLogEvent>({
      start: controller => {
        for (const event of this.logEvents.slice(start)) controller.enqueue(event);
        controller.close();
      },
    }));
  }
  waitForLog(): ReturnType<SandboxProcess["waitForLog"]> { throw new Error("not used"); }
  async waitForExit(): Promise<{ code: number }> {
    if (this.waitFails) throw new Error("timeout");
    if (this.waitRejectsOnce) { this.waitRejectsOnce = false; throw new Error("timeout"); }
    if (this.waitTimesOut) { this.waitTimesOut = false; return { code: 0, timedOut: true }; }
    this.state = "exited";
    return { code: 0 };
  }
  output(): ReturnType<SandboxProcess["output"]> { throw new Error("not used"); }
  async waitForPort(): Promise<void> {
    if (this.portFailures-- > 0) throw new Error("not ready");
  }
  async kill(signal = 15): Promise<void> { this.killSignals.push(signal); this.onKill(this.id); }
}

class FakeSandbox implements DevelopmentSupervisorSandbox {
  readonly processes = new Map<string, FakeProcess>();
  readonly launches: Array<{ argv: SandboxCommand; cwd: string; env: Record<string, string> }> = [];
  readonly killOrder: string[] = [];
  nextPortFailures = 0;
  next = 0;
  readonly files = new Set<string>();
  exec(argv: SandboxCommand, options: { cwd: string; env: Record<string, string> }): Promise<SandboxProcess> {
    this.launches.push({ argv, ...options });
    const process = new FakeProcess(`p${++this.next}`, argv, options.cwd, id => this.killOrder.push(id));
    process.portFailures = this.nextPortFailures;
    this.nextPortFailures = 0;
    this.processes.set(process.id, process);
    return Promise.resolve(process);
  }
  getProcess(id: string): Promise<SandboxProcess | null> { return Promise.resolve(this.processes.get(id) ?? null); }
  async listProcesses(): Promise<ProcessStatus[]> { return Promise.all([...this.processes.values()].map(process => process.status())); }
  exists(path: string): Promise<{ exists: boolean }> { return Promise.resolve({ exists: this.files.has(path) }); }
  mkdir(): Promise<unknown> { return Promise.resolve({ success: true }); }
  writeFile(path: string): Promise<unknown> { this.files.add(path); return Promise.resolve({ success: true }); }
}

function intent() {
  return createDevelopmentGenerationIntent(catalog(), plan(), { sessionId: "session", sandboxId: "sandbox", generation: 3 });
}

describe("development generation intent", () => {
  it("deep-copies the full private execution contract and does not recursively leak it publicly", () => {
    const source = catalog();
    const value = createDevelopmentGenerationIntent(source, plan(), { sessionId: "session", sandboxId: "sandbox", generation: 3 });
    source.components[0]!.executionSpec!.processes[0]!.argv[0] = "attacker";
    expect(value.components[0]!.revision).toBe(2);
    expect(value.components[0]!.executionSpec.processes[0]!.argv).toEqual(["db", "serve"]);
    expect(Object.isFrozen(value.components[0]!.executionSpec.processes[0]!.argv)).toBe(true);
    const publicValue = publicDevelopmentSupervisorUpdate(value, createDevelopmentSupervisorState(value));
    const json = JSON.stringify(publicValue);
    for (const secret of ["argv", "environment", "images", "ports", "processId", "db serve", "MODE"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("rejects an ineligible or stale plan", () => {
    expect(() => createDevelopmentGenerationIntent(catalog(), { ...plan(), canCreate: false },
      { sessionId: "s", sandboxId: "b", generation: 1 })).toThrow(/eligible/);
  });

  it("rejects noncanonical closure, stale tier, extraneous issues, and external execution", () => {
    const fence = { sessionId: "s", sandboxId: "b", generation: 1 };
    expect(() => createDevelopmentGenerationIntent(catalog(), {
      ...plan(), resolvedComponentIds: ["api", "database"],
    }, fence)).toThrow(/canonical dependency closure/);
    const tierCatalog = catalog();
    tierCatalog.enabledTiers.push("standard-2");
    expect(() => createDevelopmentGenerationIntent(tierCatalog, {
      ...plan(), selectedTier: "standard-2", selection: { componentIds: ["api"], requestedTier: "standard-1" },
    }, fence)).toThrow(/tier/);
    expect(() => createDevelopmentGenerationIntent(tierCatalog, {
      ...plan(), selectedTier: "standard-2",
    }, fence)).toThrow(/tier/);
    expect(() => createDevelopmentGenerationIntent(catalog(), {
      ...plan(), catalogRevision: 6,
    }, fence)).toThrow(/eligible/);
    expect(Object.isFrozen(DEVELOPMENT_CATALOG)).toBe(true);
    expect(Object.isFrozen(DEVELOPMENT_CATALOG.components[0]!.dependencyIds)).toBe(true);
    expect(() => createDevelopmentGenerationIntent(catalog(), {
      ...plan(), issues: [{ code: "configuration-unavailable", message: "no" }],
    }, fence)).toThrow(/eligible/);
    const external = catalog();
    external.components[0]!.execution = "external";
    expect(() => createDevelopmentGenerationIntent(external, plan(), fence)).toThrow(/no executable/);
  });
});

describe("development reconciler", () => {
  it("starts dependencies topologically with exact argv, cwd, and non-secret env", async () => {
    const value = intent();
    const state = createDevelopmentSupervisorState(value);
    const sandbox = new FakeSandbox();
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(sandbox.launches.map(entry => entry.argv[2])).toEqual(["db", "api"]);
    expect(sandbox.launches[0]).toEqual({ argv: ["/usr/bin/env", expect.stringContaining("ODIE_SUPERVISION_MARKER="), "db", "serve"], cwd: "/workspace", env: { MODE: "test" } });
    expect(Object.values(state.components).map(component => component.status)).toEqual(["ready", "ready"]);
  });

  it("launches reviewed init, migration, seed, then service order", async () => {
    const source = catalog();
    source.components[0]!.executionSpec!.processes.unshift(
      { id: "init", phase: "init", argv: ["db", "init"], cwd: "/workspace", environment: [], idempotent: true, timeoutMs: 100 },
      { id: "migrate", phase: "migration", argv: ["db", "migrate"], cwd: "/workspace", environment: [], idempotent: true, timeoutMs: 100 },
      { id: "seed", phase: "seed", argv: ["db", "seed"], cwd: "/workspace", environment: [], idempotent: true, timeoutMs: 100 },
    );
    const value = createDevelopmentGenerationIntent(source, plan(), {
      sessionId: "session", sandboxId: "sandbox", generation: 3,
    });
    const state = createDevelopmentSupervisorState(value);
    const sandbox = new FakeSandbox();
    for (let id = 1; id <= 3; id++) {
      await reconcileDevelopmentGeneration(value, state, sandbox);
      sandbox.processes.get(`p${id}`)!.state = "exited";
      await reconcileDevelopmentGeneration(value, state, sandbox);
    }
    expect(sandbox.launches.slice(0, 4).map(entry => entry.argv[3] ?? entry.argv[2]))
      .toEqual(["init", "migrate", "seed", "serve"]);
  });

  it("adopts exact stored process IDs after a crash and launches no duplicates", async () => {
    const value = intent();
    const state = createDevelopmentSupervisorState(value);
    const sandbox = new FakeSandbox();
    await reconcileDevelopmentGeneration(value, state, sandbox);
    await reconcileDevelopmentGeneration(value, structuredClone(state), sandbox);
    expect(sandbox.launches).toHaveLength(2);
  });

  it("checkpoints successful one-shots and does not rerun them", async () => {
    const source = catalog();
    source.components[0]!.executionSpec!.processes.unshift({
      id: "migrate", phase: "migration", argv: ["db", "migrate"], cwd: "/workspace", environment: [], idempotent: true, timeoutMs: 1_000,
    });
    const value = createDevelopmentGenerationIntent(source, plan(), {
      sessionId: "session", sandboxId: "sandbox", generation: 3,
    });
    const state = createDevelopmentSupervisorState(value);
    const sandbox = new FakeSandbox();
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(sandbox.launches).toHaveLength(1);
    sandbox.processes.get("p1")!.state = "exited";
    await reconcileDevelopmentGeneration(value, state, sandbox);
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(sandbox.launches.filter(entry => entry.argv[3] === "migrate")).toHaveLength(1);
    expect(state.components.database!.completedJobs).toEqual(["migrate"]);
  });

  it("reruns a catalog-idempotent one-shot when its container marker is absent", async () => {
    const source = catalog();
    source.components[0]!.executionSpec!.processes.unshift({
      id: "seed", phase: "seed", argv: ["db", "seed"], cwd: "/workspace", environment: [], idempotent: true, timeoutMs: 1_000,
    });
    const value = createDevelopmentGenerationIntent(source, plan(), {
      sessionId: "session", sandboxId: "sandbox", generation: 3,
    });
    const state = createDevelopmentSupervisorState(value);
    const sandbox = new FakeSandbox();
    await reconcileDevelopmentGeneration(value, state, sandbox);
    sandbox.processes.get("p1")!.state = "exited";
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(state.components.database!.completedJobs).toEqual(["seed"]);
    sandbox.files.clear();
    sandbox.processes.clear();
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(sandbox.launches.filter(entry => entry.argv[3] === "seed")).toHaveLength(2);
  });

  it("checkpoints launching before exec and adopts one uniquely marked lost response", async () => {
    const value = intent();
    const state = createDevelopmentSupervisorState(value);
    const sandbox = new FakeSandbox();
    const checkpoints: any[] = [];
    await reconcileDevelopmentGeneration(value, state, sandbox, {}, Date.now(), async checkpoint => {
      checkpoints.push(structuredClone(checkpoint));
    });
    expect(checkpoints.some(checkpoint => checkpoint.components.database.processes.service?.phase === "launching")).toBe(true);

    const crashed = createDevelopmentSupervisorState(value);
    const marker = "g3:database:service:a0";
    crashed.components.database!.processes.service = { phase: "launching", attempts: 0, marker };
    const adopted = new FakeProcess("adopted", ["/usr/bin/env", `ODIE_SUPERVISION_MARKER=${marker}`, "db", "serve"], "/workspace");
    sandbox.processes.clear();
    sandbox.launches.length = 0;
    sandbox.processes.set(adopted.id, adopted);
    await reconcileDevelopmentGeneration(value, crashed, sandbox);
    expect(crashed.components.database!.processes.service).toMatchObject({ phase: "launched", processId: "adopted" });
    expect(sandbox.launches.filter(entry => entry.argv[2] === "db")).toHaveLength(0);
  });

  it("fails closed when a launching checkpoint has no exact adoption candidate", async () => {
    const value = intent();
    const state = createDevelopmentSupervisorState(value);
    state.components.database!.processes.service = {
      phase: "launching", attempts: 0, marker: "g3:database:service:a0",
    };
    const sandbox = new FakeSandbox();

    await reconcileDevelopmentGeneration(value, state, sandbox);

    expect(state.components.database!.status).toBe("failed");
    expect(state.components.database!.message).toContain("provenance");
    expect(sandbox.launches).toHaveLength(0);
  });

  it("recovers a marker-only completed job checkpoint without rerunning it", async () => {
    const source = catalog();
    source.components[0]!.executionSpec!.processes.unshift({
      id: "seed", phase: "seed", argv: ["db", "seed"], cwd: "/workspace", environment: [],
      idempotent: true, timeoutMs: 1_000,
    });
    const value = createDevelopmentGenerationIntent(source, plan(), {
      sessionId: "session", sandboxId: "sandbox", generation: 3,
    });
    const state = createDevelopmentSupervisorState(value);
    const sandbox = new FakeSandbox();
    sandbox.files.add("/tmp/odie-supervision/database/seed.complete");
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(state.components.database!.completedJobs).toEqual(["seed"]);
    expect(sandbox.launches.some(entry => entry.argv[3] === "seed")).toBe(false);
  });

  it("never exposes caught private execution values in public status", async () => {
    const source = catalog();
    source.components[0]!.executionSpec!.processes[0]!.environment = [{
      name: "PRIVATE_VALUE", source: { kind: "configuration", requirement: "secret-requirement-id" },
    }];
    source.components[0]!.executionSpec!.requirements.configuration = ["secret-requirement-id"];
    const value = createDevelopmentGenerationIntent(source, plan(), {
      sessionId: "session", sandboxId: "sandbox", generation: 3,
    });
    const state = createDevelopmentSupervisorState(value);
    const sandbox = new FakeSandbox();
    await reconcileDevelopmentGeneration(value, state, sandbox);
    const json = JSON.stringify(publicDevelopmentSupervisorUpdate(value, state));
    for (const secret of ["secret-requirement-id", "PRIVATE_VALUE", "/workspace", "db serve", "sha256", "3000", "processId"]) {
      expect(json).not.toContain(secret);
    }
    expect(state.components.database!.status).toBe("failed");
    const launches = sandbox.launches.length;
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(state.components.database!.status).toBe("failed");
    expect(sandbox.launches).toHaveLength(launches);
  });

  it("degrades on liveness failure, restarts once, then recovers", async () => {
    const value = intent();
    const state = createDevelopmentSupervisorState(value);
    const sandbox = new FakeSandbox();
    await reconcileDevelopmentGeneration(value, state, sandbox);
    state.components.database!.logs.cursors.service = "stale-cursor";
    state.components.database!.logs.terminals.service = true;
    sandbox.processes.get("p1")!.portFailures = 1;
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(state.components.database!.status).toBe("degraded");
    expect(sandbox.launches.filter(entry => entry.argv[2] === "db")).toHaveLength(2);
    expect(state.components.database!.logs.cursors.service).toBeUndefined();
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(sandbox.processes.get("p3")!.logCalls[0]).not.toHaveProperty("since");
    expect(state.components.database!.status).toBe("ready");
    sandbox.processes.get("p3")!.portFailures = 1;
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(state.components.database!.status).toBe("failed");
    expect(state.components.database!.message).toContain("exhausted");
  });

  it("degrades and recovers readiness without treating exec start as command completion", async () => {
    const value = intent();
    const state = createDevelopmentSupervisorState(value);
    const sandbox = new FakeSandbox();
    sandbox.nextPortFailures = 1;
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(state.components.database!.status).toBe("degraded");
    expect(state.components.api!.status).toBe("degraded");
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(state.components.database!.status).toBe("ready");
  });

  it("terminates and exhausts bounded readiness without resurrection", async () => {
    const source = catalog();
    source.components[0]!.executionSpec!.restart.maxAttempts = 0;
    const value = createDevelopmentGenerationIntent(source, plan(), {
      sessionId: "session", sandboxId: "sandbox", generation: 3,
    });
    const state = createDevelopmentSupervisorState(value);
    const sandbox = new FakeSandbox();
    sandbox.nextPortFailures = 1;
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(state.components.database!.status).toBe("failed");
    expect(sandbox.processes.get("p1")!.killSignals).toContain(15);
    const launches = sandbox.launches.length;
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(state.components.database!.status).toBe("failed");
    expect(sandbox.launches).toHaveLength(launches);
  });

  it("honors durable restart backoff before launching a replacement", async () => {
    const source = catalog();
    source.components[0]!.executionSpec!.restart.backoffMs = 100;
    const value = createDevelopmentGenerationIntent(source, plan(), {
      sessionId: "session", sandboxId: "sandbox", generation: 3,
    });
    const base = Date.now();
    const state = createDevelopmentSupervisorState(value, base);
    const sandbox = new FakeSandbox();
    await reconcileDevelopmentGeneration(value, state, sandbox, {}, base);
    sandbox.processes.get("p1")!.portFailures = 1;
    await reconcileDevelopmentGeneration(value, state, sandbox, {}, base + 1);
    expect(sandbox.launches.filter(entry => entry.argv[2] === "db")).toHaveLength(1);
    await reconcileDevelopmentGeneration(value, state, sandbox, {}, base + 50);
    expect(sandbox.launches.filter(entry => entry.argv[2] === "db")).toHaveLength(1);
    await reconcileDevelopmentGeneration(value, state, sandbox, {}, base + 202);
    expect(sandbox.launches.filter(entry => entry.argv[2] === "db")).toHaveLength(2);
  });

  it("retains private logs by byte and line caps with cursor continuation and truncation", async () => {
    const source = catalog();
    source.components[0]!.executionSpec!.logs = { maxBytes: 12, maxLines: 2 };
    const value = createDevelopmentGenerationIntent(source, plan(), {
      sessionId: "session", sandboxId: "sandbox", generation: 3,
    });
    const state = createDevelopmentSupervisorState(value);
    const sandbox = new FakeSandbox();
    await reconcileDevelopmentGeneration(value, state, sandbox);
    const process = sandbox.processes.get("p1")!;
    process.logEvents.push(
      { type: "stdout", cursor: "c1", timestamp: "0", data: new TextEncoder().encode("secret-one\n") },
      { type: "stderr", cursor: "c2", timestamp: "1", data: new TextEncoder().encode("secret-two\nsecret-three") },
      { type: "truncated", cursor: "c3", timestamp: "2" },
    );
    await reconcileDevelopmentGeneration(value, state, sandbox);
    const first = state.components.database!.logs;
    expect(first.cursors.service).toBe("c3");
    expect(first.bytes).toBeLessThanOrEqual(12);
    expect(first.lines).toBeLessThanOrEqual(2);
    expect(first.truncated).toBe(true);
    process.logEvents.push({
      type: "stdout", cursor: "c4", timestamp: "3", data: new TextEncoder().encode("\nprivate-four"),
    });
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(process.logCalls.at(-1)).toMatchObject({ since: "c3" });
    expect(state.components.database!.logs.text).toContain("private-four");
    const publicJson = JSON.stringify(publicDevelopmentSupervisorUpdate(value, state));
    for (const secret of ["secret-one", "secret-two", "secret-three", "private-four", "c3", "c4"]) {
      expect(publicJson).not.toContain(secret);
    }
  });

  it("continues private log replay after the per-reconcile event budget", async () => {
    const value = intent();
    const state = createDevelopmentSupervisorState(value);
    const sandbox = new FakeSandbox();
    await reconcileDevelopmentGeneration(value, state, sandbox);
    const process = sandbox.processes.get("p1")!;
    for (let index = 1; index <= 513; index++) {
      process.logEvents.push({
        type: "stdout", cursor: `cursor-${index}`, timestamp: `${index}`,
        data: new TextEncoder().encode("x"),
      });
    }
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(state.components.database!.logs.cursors.service).toBe("cursor-400");
    expect(state.components.database!.logs.truncated).toBe(true);
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(process.logCalls.at(-1)).toMatchObject({ since: "cursor-400" });
    expect(state.components.database!.logs.cursors.service).toBe("cursor-513");
  });

  it("fails closed on foreign provenance and stale generation state", async () => {
    const value = intent();
    const state = createDevelopmentSupervisorState(value);
    const sandbox = new FakeSandbox();
    const foreign = new FakeProcess("foreign", ["attacker"], "/workspace");
    sandbox.processes.set(foreign.id, foreign);
    state.components.database!.processes.service = { phase: "launched", processId: foreign.id, attempts: 0, marker: "g3:database:service:a0" };
    await reconcileDevelopmentGeneration(value, state, sandbox);
    expect(state.components.database!.status).toBe("failed");
    await expect(reconcileDevelopmentGeneration(value, { ...state, generation: 2 }, sandbox)).rejects.toThrow(/fence/);
  });

  it("cleans up in reverse topology with TERM then KILL and tolerates absent processes", async () => {
    const value = intent();
    const state = createDevelopmentSupervisorState(value);
    const sandbox = new FakeSandbox();
    await reconcileDevelopmentGeneration(value, state, sandbox);
    const database = sandbox.processes.get("p1")!;
    const api = sandbox.processes.get("p2")!;
    api.waitRejectsOnce = true;
    await cleanupDevelopmentGeneration(value, state, sandbox);
    expect(api.killSignals).toEqual([15, 9]);
    expect(sandbox.killOrder[0]).toBe(api.id);
    expect(sandbox.killOrder).toContain(database.id);
    expect(Object.values(state.components).map(component => component.status)).toEqual(["stopped", "stopped"]);

    const absentState = createDevelopmentSupervisorState(value);
    absentState.components.database!.processes.service = { phase: "launched", processId: "absent", attempts: 0, marker: "g3:database:service:a0" };
    await expect(cleanupDevelopmentGeneration(value, absentState, new FakeSandbox())).resolves.toBe(absentState);
  });
});
