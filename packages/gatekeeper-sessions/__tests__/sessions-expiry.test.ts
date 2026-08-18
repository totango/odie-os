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

const { CodingSessionRegistry } = await import("../src/sessions.js");

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
    ctx: { storage: { kv: typeof kv } };
  };
  registry.env = {
    SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
    SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policies },
  };
  registry.ctx = { storage: { kv } };
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

  it("reconciles an expired running session while listing sessions", async () => {
    sandboxState.sandboxes.set("sandbox-1", {
      getTerminal: vi.fn(async () => null),
      createTerminal: vi.fn(),
    });
    const { registry, kv } = createRegistry(runningRecord());

    const sessions = await registry.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe("failed");
    expect(sessions[0]?.error).toContain("Restart the session");
    expect(kv.get<StoredRecord>("session:session-1")?.terminalId).toBeUndefined();
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

    expect(policies.storeTicket).not.toHaveBeenCalled();
  });
});
