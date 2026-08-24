import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingSessionSummary } from "@gadgets/workshop-shared/api";

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

const { CodingSessionRegistry, GatekeeperVendor } = await import("../src/sessions.js");

type StoredRecord = Omit<CodingSessionSummary, "runtime"> & {
  runtime?: CodingSessionSummary["runtime"];
  sandboxId: string;
  terminalId?: string;
  editorProcessId?: string;
};

function createRegistry(record: StoredRecord) {
  const values = new Map<string, unknown>([[`session:${record.id}`, record]]);
  const kv = {
    get: vi.fn(<T>(key: string): T | undefined => values.get(key) as T | undefined),
    put: vi.fn((key: string, value: unknown) => { values.set(key, value); }),
    list: vi.fn(<T,>({ prefix }: { prefix: string }): Map<string, T> =>
      new Map([...values].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>)),
  };
  const policies = { configure: vi.fn(), storeEditorTicket: vi.fn() };
  const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
    env: Record<string, unknown>;
    ctx: { storage: { kv: typeof kv } };
  };
  registry.env = {
    EDITOR_BASE_URL: "https://editor.example.workers.dev",
    EDITOR_CAPABILITY_HMAC_SECRET: "editor-test-secret",
    SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
    SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policies },
  };
  registry.ctx = { storage: { kv } };
  return { registry, kv, policies };
}

function runningRecord(): StoredRecord {
  return {
    id: "session-1",
    title: "Repair",
    repositories: ["jarvis"],
    runtime: "prime-agent",
    status: "running",
    createdAt: new Date("2026-08-18T00:00:00Z"),
    lastActiveAt: new Date("2026-08-18T00:00:00Z"),
    sandboxId: "sandbox-1",
    terminalId: "term-primary",
  };
}

describe("coding session browser editor capability", () => {
  beforeEach(() => {
    sandboxState.sandboxes.clear();
    vi.clearAllMocks();
  });

  it("advertises the editor only with a separate HTTPS origin and signing key", async () => {
    const vendor = new GatekeeperVendor() as InstanceType<typeof GatekeeperVendor> & { env: Record<string, unknown> };
    vendor.env = {};
    await expect(vendor.editorAvailable()).resolves.toBe(false);
    vendor.env = {
      EDITOR_BASE_URL: "https://editor.example.workers.dev",
      EDITOR_CAPABILITY_HMAC_SECRET: "editor-test-secret",
    };
    await expect(vendor.editorAvailable()).resolves.toBe(true);
  });

  it("starts code-server once with offline extensions and stores a generation-bound ticket", async () => {
    const process = { id: "editor-1", waitForPort: vi.fn() };
    const sandbox = {
      getTerminal: vi.fn(async () => ({ getSnapshot: vi.fn(async () => ({ status: "running" })) })),
      getProcess: vi.fn(async () => null),
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      exec: vi.fn(async () => process),
    };
    sandboxState.sandboxes.set("sandbox-1", sandbox);
    const { registry, kv, policies } = createRegistry(runningRecord());
    const owner = { userId: "user-1", email: "user@example.com" };

    const capability = await registry.mintEditorCapability(owner, "session-1");

    expect(capability.url).toMatch(/^https:\/\/editor\.example\.workers\.dev\/c\/[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\/$/);
    expect(sandbox.exec).toHaveBeenCalledWith(expect.arrayContaining([
      "code-server", "--auth", "none", "--disable-update-check",
      "--extensions-dir", "/opt/odie-code-server/extensions", "/workspace",
    ]), expect.objectContaining({
      cwd: "/workspace",
      env: expect.objectContaining({ EXTENSIONS_GALLERY: "{}" }),
    }));
    expect(process.waitForPort).toHaveBeenCalledWith(13_337, expect.objectContaining({ mode: "http" }));
    expect(policies.storeEditorTicket).toHaveBeenCalledWith(expect.objectContaining({
      sandboxId: "sandbox-1", userId: "user-1", sessionId: "session-1",
    }));
    expect(kv.get<StoredRecord>("session:session-1")?.editorProcessId).toBe("editor-1");
  });

  it("deduplicates concurrent editor startup for one session generation", async () => {
    const process = { id: "editor-1", waitForPort: vi.fn(), kill: vi.fn() };
    const sandbox = {
      getTerminal: vi.fn(async () => ({ getSnapshot: vi.fn(async () => ({ status: "running" })) })),
      getProcess: vi.fn(async () => null),
      mkdir: vi.fn(), writeFile: vi.fn(), exec: vi.fn(async () => process),
    };
    sandboxState.sandboxes.set("sandbox-1", sandbox);
    const { registry } = createRegistry(runningRecord());
    const owner = { userId: "user-1", email: "user@example.com" };

    await Promise.all([
      registry.mintEditorCapability(owner, "session-1"),
      registry.mintEditorCapability(owner, "session-1"),
    ]);

    expect(sandbox.exec).toHaveBeenCalledOnce();
  });

  it("kills a failed code-server process before allowing a retry", async () => {
    const failed = {
      id: "editor-failed",
      waitForPort: vi.fn(async () => { throw new Error("not ready"); }),
      kill: vi.fn(async () => {}),
      waitForExit: vi.fn()
        .mockResolvedValueOnce({ code: 143, timedOut: true })
        .mockResolvedValueOnce({ code: 137, timedOut: false }),
    };
    const healthy = { id: "editor-healthy", waitForPort: vi.fn(), kill: vi.fn() };
    const sandbox = {
      getTerminal: vi.fn(async () => ({ getSnapshot: vi.fn(async () => ({ status: "running" })) })),
      getProcess: vi.fn(async () => null),
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      exec: vi.fn()
        .mockResolvedValueOnce(failed)
        .mockResolvedValueOnce(healthy),
    };
    sandboxState.sandboxes.set("sandbox-1", sandbox);
    const { registry } = createRegistry(runningRecord());
    const owner = { userId: "user-1", email: "user@example.com" };

    await expect(registry.mintEditorCapability(owner, "session-1")).rejects.toThrow("not ready");
    expect(failed.kill.mock.calls).toEqual([[15], [9]]);
    expect(failed.waitForExit).toHaveBeenCalledTimes(2);
    await expect(registry.mintEditorCapability(owner, "session-1")).resolves.toBeDefined();
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
  });

  it("fails closed when no separate HTTPS editor origin is configured", async () => {
    const process = { id: "editor-1", waitForPort: vi.fn() };
    sandboxState.sandboxes.set("sandbox-1", {
      getTerminal: vi.fn(async () => ({ getSnapshot: vi.fn(async () => ({ status: "running" })) })),
      getProcess: vi.fn(async () => null),
      mkdir: vi.fn(), writeFile: vi.fn(), exec: vi.fn(async () => process),
    });
    const { registry } = createRegistry(runningRecord());
    delete registry.env.EDITOR_BASE_URL;

    await expect(registry.mintEditorCapability(
      { userId: "user-1", email: "user@example.com" }, "session-1",
    )).rejects.toThrow("EDITOR_BASE_URL");
  });
});
