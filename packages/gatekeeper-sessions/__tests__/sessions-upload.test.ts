import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingSessionSummary } from "@gadgets/workshop-shared/api";
import { MAX_CODING_SESSION_UPLOAD_BYTES } from "@gadgets/workshop-shared/coding-sessions";

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

const { CodingSessionRegistry } = await import("../src/sessions.js");

type StoredRecord = Omit<CodingSessionSummary, "runtime"> & {
  runtime?: CodingSessionSummary["runtime"];
  sandboxId: string;
  terminalId?: string;
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

function record(overrides: Partial<StoredRecord> = {}): StoredRecord {
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

function registryWith(stored: StoredRecord) {
  const kv = createKv();
  kv.put(`session:${stored.id}`, stored);
  const policy = { configure: vi.fn() };
  const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
    env: Record<string, unknown>;
    ctx: { storage: { kv: typeof kv } };
  };
  registry.env = {
    SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
    SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
  };
  registry.ctx = { storage: { kv } };
  return { registry, kv, policy };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

describe("coding session file uploads", () => {
  beforeEach(() => {
    sandboxState.sandboxes.clear();
    vi.clearAllMocks();
  });

  it("sanitizes traversal filenames and preserves binary bytes", async () => {
    const { registry, policy } = registryWith(record());
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    sandboxState.sandboxes.set("sandbox-1", {
      getTerminal: vi.fn(async () => ({ getSnapshot: vi.fn(async () => ({ status: "running" })) })),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (path: string, content: ReadableStream<Uint8Array>) => {
        writes.push({ path, bytes: await collect(content) });
      }),
    });
    const content = new Uint8Array([0, 255, 1, 128, 42]);

    const result = await registry.uploadFile(
      { userId: "user-1", email: "user@example.com" },
      { sessionId: "session-1", filename: "../secret/../résumé.bin", content },
    );

    expect(result.filename).toBe("r_sum_.bin");
    expect(result.bytesWritten).toBe(content.byteLength);
    expect(result.path).toMatch(/^\/workspace\/\.odie-uploads\/[0-9a-f-]{36}-r_sum_\.bin$/);
    expect(writes).toEqual([{ path: result.path, bytes: content }]);
    expect(policy.configure).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      owner: { userId: "user-1", email: "user@example.com" },
      repositories: ["jarvis"],
    }));
  });

  it("rejects empty and oversized content before writing", async () => {
    const { registry } = registryWith(record());
    const sandbox = {
      getTerminal: vi.fn(async () => ({ getSnapshot: vi.fn(async () => ({ status: "running" })) })),
      mkdir: vi.fn(),
      writeFile: vi.fn(),
    };
    sandboxState.sandboxes.set("sandbox-1", sandbox);

    await expect(registry.uploadFile(
      { userId: "user-1", email: "user@example.com" },
      { sessionId: "session-1", filename: "empty.txt", content: new Uint8Array() },
    )).rejects.toThrow("must not be empty");
    await expect(registry.uploadFile(
      { userId: "user-1", email: "user@example.com" },
      { sessionId: "session-1", filename: "large.bin", content: new Uint8Array(MAX_CODING_SESSION_UPLOAD_BYTES + 1) },
    )).rejects.toThrow("at most");
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("rejects stopped sessions", async () => {
    const { registry } = registryWith(record({ status: "stopped", terminalId: undefined }));
    sandboxState.sandboxes.set("sandbox-1", { writeFile: vi.fn() });

    await expect(registry.uploadFile(
      { userId: "user-1", email: "user@example.com" },
      { sessionId: "session-1", filename: "file.txt", content: new Uint8Array([1]) },
    )).rejects.toThrow("Coding session is not running.");
  });
});
