import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingSessionSummary } from "@gadgets/workshop-shared/api";

const sandboxState = vi.hoisted(() => ({
  sandboxes: new Map<string, {
    getTerminal: ReturnType<typeof vi.fn>;
    createTerminal: ReturnType<typeof vi.fn>;
  }>(),
}));

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class ContainerProxy {},
  Sandbox: class Sandbox {},
  getSandbox: vi.fn((_namespace: unknown, id: string) => {
    const sandbox = sandboxState.sandboxes.get(id);
    if (!sandbox) throw new Error(`Unexpected sandbox ${id}`);
    return sandbox;
  }),
}));

const { CodingSessionRegistry, GatekeeperVendor } = await import("../src/sessions.js");
const { getSandbox } = await import("@cloudflare/sandbox");

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
    list: vi.fn(<T,>({ prefix }: { prefix: string }): Map<string, T> => new Map([...values].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>)),
    values,
  };
}

function createRegistry(record: StoredRecord) {
  const kv = createKv();
  kv.put(`session:${record.id}`, record);
  const policies = {
    configure: vi.fn(),
    storeTicket: vi.fn(),
  };
  const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
    env: Record<string, unknown>;
    ctx: { storage: { kv: typeof kv; getAlarm: ReturnType<typeof vi.fn>; setAlarm: ReturnType<typeof vi.fn>; deleteAlarm: ReturnType<typeof vi.fn> } };
  };
  registry.env = {
    SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
    SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policies },
  };
  registry.ctx = { storage: { kv, getAlarm: vi.fn(async () => null), setAlarm: vi.fn(), deleteAlarm: vi.fn() } };
  return { registry, kv, policies };
}

function runningRecord(overrides: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id: "session-1",
    title: "Repair",
    repositories: ["jarvis"],
    runtime: "opencode",
    status: "running",
    createdAt: new Date("2026-08-18T00:00:00Z"),
    lastActiveAt: new Date("2026-08-18T00:00:00Z"),
    sandboxId: "sandbox-1",
    terminalId: "term-primary",
    ...overrides,
  };
}

function runningTerminal(id: string) {
  return { id, getSnapshot: vi.fn(async () => ({ id, command: ["bash"], status: "running" })) };
}

describe("coding session terminal expiry", () => {
  beforeEach(() => {
    sandboxState.sandboxes.clear();
    vi.clearAllMocks();
  });

  it("persists a failed actionable state when the primary terminal is missing before attach", async () => {
    const sandbox = { getTerminal: vi.fn(async () => null), createTerminal: vi.fn() };
    sandboxState.sandboxes.set("sandbox-1", sandbox);
    const { registry, kv, policies } = createRegistry(runningRecord());

    await expect(registry.mintAttachCapability({ userId: "user-1", email: "user@example.com" }, "session-1", "opencode"))
      .rejects.toThrow("environment expired");

    const stored = kv.get<StoredRecord>("session:session-1");
    expect(stored?.status).toBe("failed");
    expect(stored?.terminalId).toBeUndefined();
    expect(stored?.shellTerminalId).toBeUndefined();
    expect(stored?.error).toContain("Restart the session");
    expect(policies.configure).not.toHaveBeenCalled();
  });

  it("deletes expired private feedback evidence, logs, patches, and status", async () => {
    const { registry, kv } = createRegistry(runningRecord());
    kv.put("feedback:feedback-1", {
      id: "feedback-1", kind: "bug", title: "Private title", state: "failed", stage: "done",
      attempts: 3, createdAt: new Date(0), updatedAt: new Date(0),
    });
    kv.put("feedback-evidence:feedback-1", {
      id: "feedback-1", kind: "bug", title: "Private title", description: "Private evidence",
      submitterEmail: "user@totango.com", owner: { userId: "user-1", email: "user@totango.com" },
      pathname: "/", expiresAt: new Date(0),
    });
    kv.put("feedback-diff:feedback-1", "private patch");
    kv.put("feedback-log:feedback-1", "private log");
    kv.put("feedback-evidence:orphan", {
      id: "orphan", kind: "feedback", title: "Orphan", description: "Orphan evidence",
      submitterEmail: "user@totango.com", owner: { userId: "user-1", email: "user@totango.com" },
      pathname: "/", expiresAt: new Date(0),
    });

    await registry.alarm();

    expect(kv.get("feedback:feedback-1")).toBeUndefined();
    expect(kv.get("feedback-evidence:feedback-1")).toBeUndefined();
    expect(kv.get("feedback-diff:feedback-1")).toBeUndefined();
    expect(kv.get("feedback-log:feedback-1")).toBeUndefined();
    expect(kv.get("feedback-evidence:orphan")).toBeUndefined();
  });

  it("does not create an empty shell replacement container when the primary terminal is gone", async () => {
    const sandbox = { getTerminal: vi.fn(async () => null), createTerminal: vi.fn() };
    sandboxState.sandboxes.set("sandbox-1", sandbox);
    const { registry } = createRegistry(runningRecord());

    await expect(registry.mintAttachCapability({ userId: "user-1", email: "user@example.com" }, "session-1", "shell"))
      .rejects.toThrow("environment expired");

    expect(sandbox.createTerminal).not.toHaveBeenCalled();
  });

  it("persists failure when the primary terminal has exited", async () => {
    const primary = { id: "term-primary", getSnapshot: vi.fn(async () => ({ id: "term-primary", command: ["bash"], status: "exited" })) };
    sandboxState.sandboxes.set("sandbox-1", { getTerminal: vi.fn(async () => primary), createTerminal: vi.fn() });
    const { registry, kv } = createRegistry(runningRecord());

    await expect(registry.mintAttachCapability({ userId: "user-1", email: "user@example.com" }, "session-1", "opencode"))
      .rejects.toThrow("environment expired");

    expect(kv.get<StoredRecord>("session:session-1")?.status).toBe("failed");
  });

  it("lists sessions without probing sandboxes or terminals", async () => {
    sandboxState.sandboxes.set("sandbox-1", {
      getTerminal: vi.fn(async () => null),
      createTerminal: vi.fn(),
    });
    const { registry, kv } = createRegistry(runningRecord());

    const sessions = await registry.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe("running");
    expect(getSandbox).not.toHaveBeenCalled();
    expect(sandboxState.sandboxes.get("sandbox-1")?.getTerminal).not.toHaveBeenCalled();
    expect(kv.get<StoredRecord>("session:session-1")?.terminalId).toBe("term-primary");
  });

  it("reconciles an expired running session during targeted lookup", async () => {
    sandboxState.sandboxes.set("sandbox-1", {
      getTerminal: vi.fn(async () => null),
      createTerminal: vi.fn(),
    });
    const { registry, kv } = createRegistry(runningRecord());

    const session = await registry.getSession("session-1");

    expect(session?.status).toBe("failed");
    expect(session?.error).toContain("Restart the session");
    expect(getSandbox).toHaveBeenCalledOnce();
    expect(kv.get<StoredRecord>("session:session-1")?.terminalId).toBeUndefined();
  });

  it("reconciles an exited running session during targeted lookup", async () => {
    const primary = {
      id: "term-primary",
      getSnapshot: vi.fn(async () => ({ id: "term-primary", command: ["bash"], status: "exited" })),
    };
    sandboxState.sandboxes.set("sandbox-1", {
      getTerminal: vi.fn(async () => primary),
      createTerminal: vi.fn(),
    });
    const { registry, kv } = createRegistry(runningRecord());

    const session = await registry.getSession("session-1");

    expect(session?.status).toBe("failed");
    expect(session?.error).toContain("terminal exited");
    expect(kv.get<StoredRecord>("session:session-1")?.terminalId).toBeUndefined();
  });

  it("treats missing and archived sessions as absent during targeted lookup", async () => {
    const { registry } = createRegistry(runningRecord({ archivedAt: new Date("2026-08-19T00:00:00Z") }));

    await expect(registry.getSession("session-1")).resolves.toBeUndefined();
    await expect(registry.getSession("missing")).resolves.toBeUndefined();
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("normalizes legacy session runtime during targeted lookup", async () => {
    const { registry } = createRegistry(runningRecord({ runtime: undefined, status: "stopped", terminalId: undefined }));

    await expect(registry.getSession("session-1")).resolves.toMatchObject({ runtime: "opencode" });
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("reads targeted session metadata without probing the sandbox", async () => {
    const { registry } = createRegistry(runningRecord());

    expect(registry.getSessionMetadata("session-1")).toMatchObject({
      id: "session-1",
      status: "running",
    });
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("does not mint a stale attach ticket across a concurrent restart", async () => {
    const primary = {
      id: "term-primary",
      getSnapshot: vi.fn(async () => ({ id: "term-primary", command: ["bash"], status: "running" })),
    };
    sandboxState.sandboxes.set("sandbox-1", {
      getTerminal: vi.fn(async () => primary),
      createTerminal: vi.fn(),
    });
    const { registry, kv, policies } = createRegistry(runningRecord());
    policies.configure.mockImplementationOnce(async () => {
      kv.put("session:session-1", runningRecord({
        sandboxId: "sandbox-2",
        terminalId: "term-restarted",
      }));
    });

    await expect(registry.mintAttachCapability(
      { userId: "user-1", email: "user@example.com" },
      "session-1",
      "opencode",
    )).rejects.toThrow("not running");

    expect(policies.configure).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: "sandbox-1" }));
    expect(policies.storeTicket).not.toHaveBeenCalled();
  });

  it("routes targeted service lookup solely through the authenticated owner id", async () => {
    const stub = { getSession: vi.fn(async () => undefined) };
    const namespace = {
      idFromName: vi.fn((name: string) => `id:${name}`),
      get: vi.fn(() => stub),
    };
    const service = new GatekeeperVendor() as InstanceType<typeof GatekeeperVendor> & {
      ctx: { exports: { CodingSessionRegistry: typeof namespace } };
    };
    service.ctx = { exports: { CodingSessionRegistry: namespace } };

    await service.getSession({ userId: "user-1", email: "wrong@example.com", githubLogin: "other" }, "session-1");

    expect(namespace.idFromName).toHaveBeenCalledWith("user-1");
    expect(namespace.idFromName).toHaveBeenCalledOnce();
    expect(namespace.get).toHaveBeenCalledWith("id:user-1");
    expect(stub.getSession).toHaveBeenCalledWith("session-1");
  });

  it("retries a session-list read with a fresh registry stub after a reset", async () => {
    const reset = Object.assign(new Error("registry reset"), {
      durableObjectReset: true,
      overloaded: true,
    });
    const first = { listSessions: vi.fn(async () => { throw reset; }) };
    const second = { listSessions: vi.fn(async () => [runningRecord()]) };
    const namespace = {
      idFromName: vi.fn((name: string) => `id:${name}`),
      get: vi.fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second),
    };
    const service = new GatekeeperVendor() as InstanceType<typeof GatekeeperVendor> & {
      ctx: { exports: { CodingSessionRegistry: typeof namespace } };
    };
    service.ctx = { exports: { CodingSessionRegistry: namespace } };
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("scheduler", { wait: vi.fn(async () => {}) });

    try {
      await expect(service.listSessions({ userId: "user-1", email: "user@example.com" }))
        .resolves.toHaveLength(1);
    } finally {
      random.mockRestore();
      vi.unstubAllGlobals();
    }

    expect(namespace.get).toHaveBeenCalledTimes(2);
    expect(first.listSessions).toHaveBeenCalledOnce();
    expect(second.listSessions).toHaveBeenCalledOnce();
  });

  it("does not reuse an old-generation shell creation promise for a replacement sandbox", async () => {
    let finishOldShell!: (value: { id: string }) => void;
    const oldCreate = vi.fn(() => new Promise<{ id: string }>(resolve => { finishOldShell = resolve; }));
    const newCreate = vi.fn(async () => ({ id: "shell-new" }));
    sandboxState.sandboxes.set("sandbox-1", {
      getTerminal: vi.fn(async () => runningTerminal("term-old")),
      createTerminal: oldCreate,
    });
    sandboxState.sandboxes.set("sandbox-2", {
      getTerminal: vi.fn(async () => runningTerminal("term-new")),
      createTerminal: newCreate,
    });
    const oldRecord = runningRecord({
      terminalId: "term-old", sandboxId: "sandbox-1",
      generation: 1,
      development: { catalogRevision: 1, componentIds: [], instanceTier: "standard-1" },
    } as any);
    const { registry, kv, policies } = createRegistry(oldRecord);
    const owner = { userId: "user-1", email: "user@example.com" };

    const oldMint = registry.mintAttachCapability(owner, "session-1", "shell");
    while (!oldCreate.mock.calls.length) await Promise.resolve();
    kv.put("session:session-1", runningRecord({
      terminalId: "term-new", sandboxId: "sandbox-2",
      generation: 2,
      development: { catalogRevision: 1, componentIds: [], instanceTier: "standard-1" },
    } as any));

    await expect(registry.mintAttachCapability(owner, "session-1", "shell")).resolves.toHaveProperty("url");
    expect(newCreate).toHaveBeenCalledOnce();
    expect(policies.storeTicket).toHaveBeenCalledWith(expect.objectContaining({
      sandboxId: "sandbox-2", generation: 2, terminalId: "shell-new",
    }));
    finishOldShell({ id: "shell-old" });
    await expect(oldMint).rejects.toThrow("not running");
  });

});
