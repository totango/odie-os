import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingSessionSummary, OpenCodeUserCustomization } from "@gadgets/workshop-shared/api";

const sandboxState = vi.hoisted(() => ({ sandboxes: new Map<string, any>() }));

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class ContainerProxy {},
  Sandbox: class Sandbox {},
  getSandbox: vi.fn((_namespace: unknown, id: string) => {
    const sandbox = sandboxState.sandboxes.get(id);
    if (!sandbox) throw new Error(`Unexpected sandbox ${id}`);
    return sandbox;
  }),
}));

vi.mock("../src/github-app.js", () => ({
  mintGitHubCodingSessionToken: vi.fn(async () => ({ token: "github-token", expiresAt: Date.now() + 60_000 })),
}));

const { CodingSessionPolicy, CodingSessionRegistry } = await import("../src/sessions.js");

const OPENCODE_COMMAND = [
  "/bin/bash",
  "-lc",
  "if [ -d /opt/odie-valhalla/opencode ]; then mkdir -p /workspace/.odie-opencode/command /workspace/.odie-opencode/skills && cp -R /opt/odie-valhalla/opencode/command/. /workspace/.odie-opencode/command/ && cp -R /opt/odie-valhalla/opencode/skills/. /workspace/.odie-opencode/skills/; fi && cd /workspace/jarvis && exec opencode",
];

type StoredRecord = Omit<CodingSessionSummary, "runtime"> & {
  runtime?: CodingSessionSummary["runtime"];
  sandboxId: string;
  terminalId?: string;
  shellTerminalId?: string;
};

function createKv() {
  const values = new Map<string, unknown>();
  return {
    get: vi.fn(<T>(key: string): T | undefined => values.get(key) as T | undefined),
    put: vi.fn((key: string, value: unknown) => { values.set(key, value); }),
    delete: vi.fn((key: string) => values.delete(key)),
    list: vi.fn(<T,>({ prefix }: { prefix: string }): Map<string, T> =>
      new Map([...values].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>)),
    values,
  };
}

function startupRecord(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    sandboxId: "sandbox-1",
    runtime: "opencode",
    phase: "authorize",
    nextRepositoryIndex: 0,
    attempt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createPolicy() {
  const kv = createKv();
  const setAlarm = vi.fn(async () => undefined);
  const deleteAlarm = vi.fn(async () => undefined);
  const registry = { startupSucceeded: vi.fn(async () => true), startupFailed: vi.fn(() => true) };
  const namespace = { idFromName: vi.fn((name: string) => name), get: vi.fn(() => registry) };
  const tools = {
    prepareSessionStartup: vi.fn(async (): Promise<OpenCodeUserCustomization> => ({ plugins: [], skills: [] })),
  };
  const policy = new CodingSessionPolicy() as InstanceType<typeof CodingSessionPolicy> & {
    env: Record<string, unknown>;
    ctx: { storage: { kv: typeof kv; setAlarm: typeof setAlarm; deleteAlarm: typeof deleteAlarm }; id: { toString(): string }; exports: { CodingSessionRegistry: typeof namespace } };
  };
  policy.env = {
    SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
    WORKSHOP_TOOLS: tools,
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "key",
    GITHUB_APP_INSTALLATION_ID: "2",
  };
  policy.ctx = { storage: { kv, setAlarm, deleteAlarm }, id: { toString: () => "policy-1" }, exports: { CodingSessionRegistry: namespace } };
  kv.put("policy", {
    sessionId: "session-1",
    sandboxId: "sandbox-1",
    runtime: "opencode",
    owner: { userId: "user-1", email: "user@example.com" },
    repositories: ["jarvis"],
  });
  return { policy, kv, setAlarm, deleteAlarm, registry, tools };
}

function createRegistryWith(record: StoredRecord) {
  const kv = createKv();
  kv.put(`session:${record.id}`, record);
  const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
    ctx: { storage: { kv: typeof kv } };
  };
  registry.ctx = { storage: { kv } };
  return { registry, kv };
}

function startingRecord(overrides: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id: "session-1",
    title: "Repair",
    repositories: ["jarvis"],
    runtime: "opencode",
    status: "starting",
    createdAt: new Date("2026-08-18T00:00:00Z"),
    lastActiveAt: new Date("2026-08-18T00:00:00Z"),
    sandboxId: "sandbox-1",
    ...overrides,
  };
}

function processHandle(id: string, state: "running" | "exited" = "exited", code = 0) {
  return {
    id,
    kill: vi.fn(async () => undefined),
    status: vi.fn(async () => state === "running" ? { state } : { state, exit: { code, timedOut: false } }),
    waitForExit: vi.fn(async () => ({ code, timedOut: false })),
  };
}

function createStartupSandbox() {
  const processes = new Map<string, ReturnType<typeof processHandle>>();
  let ready = false;
  const terminal = {
    id: "term-primary",
    getSnapshot: vi.fn(async () => ({ id: "term-primary", command: OPENCODE_COMMAND, cwd: "/workspace/jarvis", status: "running" })),
    terminate: vi.fn(),
  };
  const sandbox = {
    configureGitHubAuth: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    getProcess: vi.fn(async (id: string) => processes.get(id) ?? null),
    listTerminals: vi.fn(async () => []),
    createTerminal: vi.fn(async () => terminal),
    exec: vi.fn(async (command: string[]) => {
      if (command[0] === "git" && command[1] === "-C") return processHandle("check", "exited", ready ? 0 : 1);
      if (command[0] === "rm") return processHandle("rm");
      const clone = processHandle("clone-1", "running");
      processes.set("clone-1", clone);
      ready = true;
      return clone;
    }),
    processes,
  };
  sandboxState.sandboxes.set("sandbox-1", sandbox);
  return sandbox;
}

describe("coding session asynchronous startup", () => {
  beforeEach(() => {
    sandboxState.sandboxes.clear();
    vi.clearAllMocks();
  });

  it("create returns a persisted starting session before deferred startup work runs", async () => {
    const kv = createKv();
    const scheduled = vi.fn(async () => undefined);
    const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
      env: Record<string, unknown>;
      ctx: { storage: { kv: typeof kv } };
    };
    const policy = { configure: vi.fn(), startSessionStartup: scheduled };
    const tools = { prepareSessionStartup: vi.fn() };
    registry.env = {
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
      WORKSHOP_TOOLS: tools,
    };
    registry.ctx = { storage: { kv } };

    const summary = await registry.createSession(
      { userId: "user-1", email: "user@example.com" },
      { title: "Repair", repositories: ["jarvis"] },
    );

    expect(summary.status).toBe("starting");
    expect(kv.get<StoredRecord>(`session:${summary.id}`)?.status).toBe("starting");
    expect(scheduled).toHaveBeenCalledOnce();
    expect(tools.prepareSessionStartup).not.toHaveBeenCalled();
  });

  it("rolls back startup state when its alarm cannot be scheduled", async () => {
    const { policy, kv, setAlarm } = createPolicy();
    setAlarm.mockRejectedValueOnce(new Error("alarm unavailable"));

    await expect(policy.startSessionStartup(startupRecord())).rejects.toThrow("alarm unavailable");

    expect(kv.get("startup")).toBeUndefined();
  });

  it("persists a failed session when durable startup cannot be scheduled", async () => {
    const kv = createKv();
    const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
      env: Record<string, unknown>;
      ctx: { storage: { kv: typeof kv } };
    };
    registry.env = {
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: {
        idFromName: (id: string) => id,
        get: () => ({ configure: vi.fn(), startSessionStartup: vi.fn(async () => { throw new Error("alarm unavailable"); }) }),
      },
    };
    registry.ctx = { storage: { kv } };

    const summary = await registry.createSession(
      { userId: "user-1", email: "user@example.com" },
      { title: "Repair", repositories: ["jarvis"] },
    );

    expect(summary).toMatchObject({ status: "failed", error: "alarm unavailable" });
    expect(kv.get<StoredRecord>(`session:${summary.id}`)?.status).toBe("failed");
  });

  it("alarm progresses through clone, materialization, and running terminal storage", async () => {
    const { policy, kv, registry, tools } = createPolicy();
    const sandbox = createStartupSandbox();
    kv.put("startup", startupRecord());

    await policy.alarm();
    expect(tools.prepareSessionStartup).toHaveBeenCalledOnce();
    expect(sandbox.configureGitHubAuth).toHaveBeenCalledOnce();
    expect(kv.get<any>("startup")?.phase).toBe("clone");

    await policy.alarm();
    expect(kv.get<any>("startup")?.cloneProcesses).toEqual([{ repositoryIndex: 0, processId: "clone-1" }]);
    sandbox.processes.set("clone-1", processHandle("clone-1", "exited", 0));
    await policy.alarm();
    expect(kv.get<any>("startup")?.phase).toBe("materialize");

    await policy.alarm();
    expect(sandbox.mkdir).toHaveBeenCalled();
    expect(kv.get<any>("startup")?.phase).toBe("terminal");

    await policy.alarm();
    expect(registry.startupSucceeded).toHaveBeenCalledWith("session-1", "sandbox-1", "term-primary");
    expect(kv.get("startup")).toBeUndefined();
  });

  it("records bounded startup failure after repeated alarm failures", async () => {
    const { policy, kv, registry, tools } = createPolicy();
    const sandbox = createStartupSandbox();
    tools.prepareSessionStartup.mockRejectedValue(new Error("x".repeat(800)));
    kv.put("startup", startupRecord({ attempt: 2 }));

    await policy.alarm();

    expect(registry.startupFailed).toHaveBeenCalledWith("session-1", "sandbox-1", "x".repeat(500));
    expect(sandbox.destroy).toHaveBeenCalledOnce();
    expect(kv.get("startup")).toBeUndefined();
  });

  it("retains startup state when final sandbox destroy is unavailable", async () => {
    const { policy, kv, tools } = createPolicy();
    const sandbox = createStartupSandbox();
    sandbox.destroy.mockRejectedValue(new Error("destroy unavailable"));
    tools.prepareSessionStartup.mockRejectedValue(new Error("authorization failed"));
    kv.put("startup", startupRecord({ attempt: 2 }));

    await expect(policy.alarm()).rejects.toThrow("destroy unavailable");

    expect(kv.get<any>("startup")).toMatchObject({ failureError: "authorization failed" });
  });

  it("continues retained failure cleanup without resuming startup phases", async () => {
    const { policy, kv, registry, tools } = createPolicy();
    const sandbox = createStartupSandbox();
    sandbox.destroy.mockRejectedValueOnce(new Error("destroy unavailable"));
    tools.prepareSessionStartup.mockRejectedValue(new Error("authorization failed"));
    kv.put("startup", startupRecord({ attempt: 2 }));
    await expect(policy.alarm()).rejects.toThrow("destroy unavailable");
    tools.prepareSessionStartup.mockClear();
    registry.startupFailed.mockClear();

    await policy.alarm();

    expect(tools.prepareSessionStartup).not.toHaveBeenCalled();
    expect(registry.startupFailed).toHaveBeenCalledWith("session-1", "sandbox-1", "authorization failed");
    expect(kv.get("startup")).toBeUndefined();
  });

  it("retains startup state when registry failure finalization is unavailable", async () => {
    const { policy, kv, registry, tools } = createPolicy();
    createStartupSandbox();
    tools.prepareSessionStartup.mockRejectedValue(new Error("authorization failed"));
    registry.startupFailed.mockRejectedValue(new Error("registry unavailable"));
    kv.put("startup", startupRecord({ attempt: 2 }));

    await expect(policy.alarm()).rejects.toThrow("registry unavailable");

    expect(kv.get("startup")).toBeDefined();
  });

  it("duplicate terminal alarm adopts one matching primary and cleans duplicates", async () => {
    const { policy, kv, registry } = createPolicy();
    const sandbox = createStartupSandbox();
    const duplicate = {
      id: "term-duplicate",
      getSnapshot: vi.fn(async () => ({ id: "term-duplicate", command: OPENCODE_COMMAND, cwd: "/workspace/jarvis", status: "running" })),
      terminate: vi.fn(),
    };
    sandbox.listTerminals.mockResolvedValue([await sandbox.createTerminal(), duplicate]);
    sandbox.createTerminal.mockClear();
    kv.put("startup", startupRecord({ phase: "terminal" }));

    await policy.alarm();

    expect(sandbox.createTerminal).not.toHaveBeenCalled();
    expect(duplicate.terminate).toHaveBeenCalledOnce();
    expect(registry.startupSucceeded).toHaveBeenCalledWith("session-1", "sandbox-1", "term-primary");
  });

  it("stale successful completion is ignored and destroys the old sandbox", async () => {
    const { policy, kv, registry } = createPolicy();
    const sandbox = createStartupSandbox();
    registry.startupSucceeded.mockResolvedValue(false);
    kv.put("startup", startupRecord({ phase: "terminal" }));

    await policy.alarm();

    expect(sandbox.destroy).toHaveBeenCalledOnce();
    expect(kv.get("startup")).toBeUndefined();
  });

  it("retains stale-success startup state when old sandbox destroy fails", async () => {
    const { policy, kv, registry } = createPolicy();
    const sandbox = createStartupSandbox();
    sandbox.destroy.mockRejectedValue(new Error("destroy unavailable"));
    registry.startupSucceeded.mockResolvedValue(false);
    kv.put("startup", startupRecord({ phase: "terminal" }));

    await policy.alarm();

    expect(kv.get<any>("startup")).toMatchObject({ phase: "terminal", attempt: 1 });
  });

  it("passes the sandbox generation fence to Workshop MCP tool methods", async () => {
    const { policy, kv } = createPolicy();
    const tools = policy.env.WORKSHOP_TOOLS as {
      listTools: ReturnType<typeof vi.fn>;
      callTool: ReturnType<typeof vi.fn>;
      getActionResult: ReturnType<typeof vi.fn>;
    };
    tools.listTools = vi.fn(async () => []);
    tools.callTool = vi.fn(async () => ({ content: [] }));
    tools.getActionResult = vi.fn(async () => ({ content: [] }));

    await policy.handleWorkshopMcpRequest(new Request("https://workshop-mcp.internal/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    await policy.handleWorkshopMcpRequest(new Request("https://workshop-mcp.internal/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "vendor__read", arguments: { a: 1 } } }),
    }));
    await policy.handleWorkshopMcpRequest(new Request("https://workshop-mcp.internal/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workshop_action_result", arguments: { tool: "vendor__write", actionId: 7 } } }),
    }));

    const owner = kv.get<any>("policy").owner;
    expect(tools.listTools).toHaveBeenCalledWith(owner, "session-1", "sandbox-1");
    expect(tools.callTool).toHaveBeenCalledWith(owner, "session-1", "vendor__read", { a: 1 }, "sandbox-1");
    expect(tools.getActionResult).toHaveBeenCalledWith(owner, "session-1", "vendor__write", 7, "sandbox-1");
  });

  it("rejects Workshop MCP requests without a sandbox generation", async () => {
    const { policy, kv } = createPolicy();
    const tools = policy.env.WORKSHOP_TOOLS as { listTools: ReturnType<typeof vi.fn> };
    tools.listTools = vi.fn(async () => []);
    kv.put("policy", {
      sessionId: "session-1",
      runtime: "opencode",
      owner: { userId: "user-1", email: "user@example.com" },
      repositories: ["jarvis"],
    });

    const response = await policy.handleWorkshopMcpRequest(new Request("https://workshop-mcp.internal/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));

    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "Workshop MCP sandboxId is not configured." },
    });
    expect(tools.listTools).not.toHaveBeenCalled();
  });

  it("retains terminal startup state when success finalization is unavailable", async () => {
    const { policy, kv, registry } = createPolicy();
    createStartupSandbox();
    registry.startupSucceeded.mockRejectedValue(new Error("registry unavailable"));
    kv.put("startup", startupRecord({ phase: "terminal" }));

    await policy.alarm();

    expect(kv.get<any>("startup")).toMatchObject({ phase: "terminal", attempt: 1 });
  });

  it("registry ignores old generation completion after restart, stop, or archive invalidates it", async () => {
    for (const record of [
      startingRecord({ sandboxId: "sandbox-2" }),
      startingRecord({ status: "stopped" }),
      startingRecord({ status: "stopped", archivedAt: new Date("2026-08-19T00:00:00Z") }),
    ]) {
      const { registry, kv } = createRegistryWith(record);
      await expect(registry.startupSucceeded("session-1", "sandbox-1", "term-old")).resolves.toBe(false);
      expect(kv.get<StoredRecord>("session:session-1")?.terminalId).toBeUndefined();
    }
  });

  it("registry reports only the current running sandbox generation", () => {
    const { registry } = createRegistryWith(startingRecord({ status: "running", terminalId: "term-1" }));

    expect(registry.isCurrentSessionGeneration("session-1", "sandbox-1")).toBe(true);
    expect(registry.isCurrentSessionGeneration("session-1", "sandbox-old")).toBe(false);
  });

  it("ticket alarm behavior remains isolated from startup state", async () => {
    const { policy, kv } = createPolicy();
    kv.put("ticket", { expiresAt: Date.now() - 1 });
    await policy.alarm();
    expect(kv.get("ticket")).toBeUndefined();

    createStartupSandbox();
    kv.put("ticket", { expiresAt: Date.now() - 1 });
    kv.put("startup", startupRecord({ phase: "clone" }));
    await policy.alarm();
    expect(kv.get("ticket")).toBeDefined();
  });

  it("recovers from a missing clone process by cleaning the partial path and restarting clone", async () => {
    const { policy, kv } = createPolicy();
    const sandbox = createStartupSandbox();
    kv.put("startup", startupRecord({
      phase: "clone",
      nextRepositoryIndex: 1,
      cloneProcesses: [{ repositoryIndex: 0, processId: "missing" }],
      attempt: 0,
    }));

    await policy.alarm();

    expect(sandbox.getProcess).toHaveBeenCalledWith("missing");
    expect(sandbox.exec.mock.calls.some(([command]) => command[0] === "rm")).toBe(true);
    expect(kv.get<any>("startup")?.cloneProcesses).toEqual([{ repositoryIndex: 0, processId: "clone-1" }]);
  });

  it("cancels startup only for the configured session generation", async () => {
    const { policy, kv, deleteAlarm } = createPolicy();
    kv.put("startup", startupRecord());

    await policy.cancelSessionStartup("session-1", "sandbox-old");
    expect(kv.get("startup")).toBeDefined();
    expect(deleteAlarm).not.toHaveBeenCalled();

    await policy.cancelSessionStartup("session-1", "sandbox-1");
    expect(kv.get("startup")).toBeUndefined();
    expect(deleteAlarm).toHaveBeenCalledOnce();
  });

  it("backfills a missing sandbox generation on a matching legacy policy", () => {
    const { policy, kv } = createPolicy();
    kv.put("policy", {
      sessionId: "session-1",
      owner: { userId: "user-1", email: "user@example.com" },
      repositories: ["jarvis"],
    });

    policy.configure({
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      owner: { userId: "user-1", email: "user@example.com" },
      repositories: ["jarvis"],
    });

    expect(kv.get<any>("policy")?.sandboxId).toBe("sandbox-1");
  });

  it("cancels durable startup before destroying a starting sandbox", async () => {
    const { registry } = createRegistryWith(startingRecord());
    const cancelSessionStartup = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    sandboxState.sandboxes.set("sandbox-1", { destroy });
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: {
        idFromName: (id: string) => id,
        get: () => ({ cancelSessionStartup }),
      },
    };

    await registry.stopSession("session-1");

    expect(cancelSessionStartup).toHaveBeenCalledWith("session-1", "sandbox-1");
    expect(cancelSessionStartup.mock.invocationCallOrder[0]).toBeLessThan(destroy.mock.invocationCallOrder[0]!);
  });

  it("logs startup cancellation failure but still destroys and stops the session", async () => {
    const { registry, kv } = createRegistryWith(startingRecord());
    const destroy = vi.fn(async () => undefined);
    sandboxState.sandboxes.set("sandbox-1", { destroy });
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: {
        idFromName: (id: string) => id,
        get: () => ({ cancelSessionStartup: vi.fn(async () => { throw new Error("cancel failed"); }) }),
      },
    };

    await registry.stopSession("session-1");

    expect(destroy).toHaveBeenCalledOnce();
    expect(kv.get<StoredRecord>("session:session-1")).toMatchObject({ status: "stopped", terminalId: undefined });
  });

  it("marks a session failed when sandbox destruction prevents stopping", async () => {
    const { registry, kv } = createRegistryWith(startingRecord({ status: "running", terminalId: "terminal-1" }));
    sandboxState.sandboxes.set("sandbox-1", {
      destroy: vi.fn(async () => { throw new Error("destroy failed"); }),
    });
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
    };

    await expect(registry.stopSession("session-1")).rejects.toThrow("destroy failed");

    expect(kv.get<StoredRecord>("session:session-1")).toMatchObject({
      status: "failed",
      error: "destroy failed",
      terminalId: "terminal-1",
    });
  });

  it("resets retry accounting when startup advances to another phase", async () => {
    const { policy, kv } = createPolicy();
    const sandbox = createStartupSandbox();
    kv.put("startup", startupRecord({ attempt: 2 }));

    await policy.alarm();
    expect(kv.get<any>("startup")).toMatchObject({ phase: "clone", attempt: 0 });

    kv.put("startup", startupRecord({
      phase: "clone",
      nextRepositoryIndex: 1,
      completedRepositoryIndexes: [0],
      attempt: 2,
    }));
    await policy.alarm();
    expect(kv.get<any>("startup")).toMatchObject({ phase: "materialize", attempt: 0 });

    kv.put("startup", startupRecord({ phase: "materialize", attempt: 2 }));
    await policy.alarm();
    expect(sandbox.mkdir).toHaveBeenCalled();
    expect(kv.get<any>("startup")).toMatchObject({ phase: "terminal", attempt: 0 });
  });

  it("starts at most two repository clones concurrently and checkpoints their handles", async () => {
    const { policy, kv } = createPolicy();
    kv.put("policy", {
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      runtime: "opencode",
      owner: { userId: "user-1", email: "user@example.com" },
      repositories: ["alpha", "beta", "gamma"],
    });
    const processes = new Map<string, ReturnType<typeof processHandle>>();
    const sandbox = {
      getProcess: vi.fn(async (id: string) => processes.get(id) ?? null),
      exec: vi.fn(async (command: string[]) => {
        if (command[0] === "git" && command[1] === "-C") return processHandle("check", "exited", 1);
        if (command[0] === "rm") return processHandle("rm");
        const repository = command.at(-1)!.split("/").at(-1)!;
        const process = processHandle(`clone-${repository}`, "running");
        processes.set(process.id, process);
        return process;
      }),
    };
    sandboxState.sandboxes.set("sandbox-1", sandbox);
    kv.put("startup", startupRecord({ phase: "clone" }));

    await policy.alarm();

    expect(kv.get<any>("startup")).toMatchObject({
      nextRepositoryIndex: 2,
      cloneProcesses: [
        { repositoryIndex: 0, processId: "clone-alpha" },
        { repositoryIndex: 1, processId: "clone-beta" },
      ],
    });
    expect(sandbox.exec.mock.calls.filter(([command]) => command[0] === "git" && command[1] === "clone")).toHaveLength(2);
  });

  it("stops a running sibling clone before retrying a failed clone phase", async () => {
    const { policy, kv } = createPolicy();
    kv.put("policy", {
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      runtime: "opencode",
      owner: { userId: "user-1", email: "user@example.com" },
      repositories: ["alpha", "beta"],
    });
    const failed = processHandle("clone-alpha", "exited", 1);
    const running = processHandle("clone-beta", "running");
    const processes = new Map([[failed.id, failed], [running.id, running]]);
    sandboxState.sandboxes.set("sandbox-1", {
      getProcess: vi.fn(async (id: string) => processes.get(id) ?? null),
    });
    kv.put("startup", startupRecord({
      phase: "clone",
      nextRepositoryIndex: 2,
      cloneProcesses: [
        { repositoryIndex: 0, processId: failed.id },
        { repositoryIndex: 1, processId: running.id },
      ],
    }));

    await policy.alarm();

    expect(running.kill).toHaveBeenCalledWith(15);
    expect(kv.get<any>("startup")).toMatchObject({ phase: "clone", nextRepositoryIndex: 0, attempt: 1 });
    expect(kv.get<any>("startup")?.cloneProcesses).toBeUndefined();
  });
});
