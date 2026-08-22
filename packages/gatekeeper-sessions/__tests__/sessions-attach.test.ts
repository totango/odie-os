import { beforeEach, describe, expect, it, vi } from "vitest";

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

const sessions = await import("../src/sessions.js");

describe("coding session terminal attach HTTP handler", () => {
  beforeEach(() => {
    sandboxState.sandboxes.clear();
    vi.clearAllMocks();
  });

  it("rejects a bad origin before consuming a ticket", async () => {
    const consumeTicket = vi.fn();
    const response = await sessions.default.fetch(new Request("https://example.test/gatekeeper/sessions/attach/token", {
      headers: { Upgrade: "websocket", Origin: "https://evil.test" },
    }), {
      BASE_URL: "https://example.test",
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ consumeTicket }) },
      SESSION_SANDBOX: {},
    } as any, { exports: {} } as any);

    expect(response.status).toBe(403);
    expect(consumeTicket).not.toHaveBeenCalled();
  });

  it("rejects an oversized terminal cursor before consuming a ticket", async () => {
    const consumeTicket = vi.fn();
    const response = await sessions.default.fetch(new Request(`https://example.test/gatekeeper/sessions/attach/token?cursor=${"x".repeat(1025)}`, {
      headers: { Upgrade: "websocket", Origin: "https://example.test" },
    }), {
      BASE_URL: "https://example.test",
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ consumeTicket }) },
      SESSION_SANDBOX: {},
    } as any, { exports: {} } as any);

    expect(response.status).toBe(400);
    expect(consumeTicket).not.toHaveBeenCalled();
  });

  it("forwards a bounded terminal cursor and consumes the ticket once", async () => {
    let ticket: any = {
      sandboxId: "sandbox-1",
      terminalId: "term-primary",
      userId: "user-1",
      sessionId: "session-1",
      terminalKind: "opencode",
      expiresAt: Date.now() + 60_000,
    };
    const consumeTicket = vi.fn(() => {
      const current = ticket;
      ticket = null;
      return current;
    });
    const connect = vi.fn(async (_request: Request, options: unknown) => Response.json(options));
    sandboxState.sandboxes.set("sandbox-1", {
      getTerminal: vi.fn(async () => ({ getSnapshot: vi.fn(async () => ({ status: "running" })), connect })),
    });
    const env = {
      BASE_URL: "https://example.test",
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ consumeTicket }) },
      SESSION_SANDBOX: {},
    } as any;

    const first = await sessions.default.fetch(new Request("https://example.test/gatekeeper/sessions/attach/token?cursor=abc", {
      headers: { Upgrade: "websocket", Origin: "https://example.test" },
    }), env, { exports: {} } as any);
    const second = await sessions.default.fetch(new Request("https://example.test/gatekeeper/sessions/attach/token", {
      headers: { Upgrade: "websocket", Origin: "https://example.test" },
    }), env, { exports: {} } as any);

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ cursor: "abc", cols: 120, rows: 40 });
    expect(second.status).toBe(403);
  });

  it("marks a missing primary terminal as a failed session during attach", async () => {
    const consumeTicket = vi.fn(() => ({
      sandboxId: "sandbox-1",
      terminalId: "term-primary",
      userId: "user-1",
      sessionId: "session-1",
      terminalKind: "opencode",
      expiresAt: Date.now() + 60_000,
    }));
    const markTerminalUnavailable = vi.fn();
    sandboxState.sandboxes.set("sandbox-1", { getTerminal: vi.fn(async () => null) });

    const response = await sessions.default.fetch(new Request("https://example.test/gatekeeper/sessions/attach/token", {
      headers: { Upgrade: "websocket", Origin: "https://example.test" },
    }), {
      BASE_URL: "https://example.test",
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ consumeTicket }) },
      SESSION_SANDBOX: {},
    } as any, {
      exports: { CodingSessionRegistry: { idFromName: (id: string) => id, get: () => ({ markTerminalUnavailable }) } },
    } as any);

    expect(response.status).toBe(410);
    expect(markTerminalUnavailable).toHaveBeenCalledWith(
      "session-1", "sandbox-1", "term-primary", "Coding session environment expired. Restart the session to continue.");
  });
});
