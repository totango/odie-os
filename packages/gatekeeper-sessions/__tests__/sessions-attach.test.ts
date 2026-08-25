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
    }), env, { exports: { CodingSessionRegistry: {
      idFromName: (id: string) => id,
      get: () => ({ isCurrentSessionGeneration: vi.fn(() => true) }),
    } } } as any);
    const second = await sessions.default.fetch(new Request("https://example.test/gatekeeper/sessions/attach/token", {
      headers: { Upgrade: "websocket", Origin: "https://example.test" },
    }), env, { exports: { CodingSessionRegistry: {
      idFromName: (id: string) => id,
      get: () => ({ isCurrentSessionGeneration: vi.fn(() => true) }),
    } } } as any);

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
      exports: { CodingSessionRegistry: { idFromName: (id: string) => id, get: () => ({ isCurrentSessionGeneration: vi.fn(() => true), markTerminalUnavailable }) } },
    } as any);

    expect(response.status).toBe(410);
    expect(markTerminalUnavailable).toHaveBeenCalledWith(
      "session-1", "sandbox-1", "term-primary", "Coding session environment expired. Restart the session to continue.", 0);
  });
});

const editorSecret = "editor-test-secret";
const editorNonce = "a".repeat(43);
const editorSignatureBytes = new Uint8Array(await crypto.subtle.sign(
  "HMAC",
  await crypto.subtle.importKey("raw", new TextEncoder().encode(editorSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  new TextEncoder().encode(`odie-editor-v1:${editorNonce}`),
));
let editorSignatureBinary = "";
for (const byte of editorSignatureBytes) editorSignatureBinary += String.fromCharCode(byte);
const editorToken = `${editorNonce}.${btoa(editorSignatureBinary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;


describe("coding session browser editor HTTP gateway", () => {
  const secret = editorSecret;
  const token = editorToken;
  const editorOrigin = "https://editor.example.workers.dev";

  beforeEach(() => {
    sandboxState.sandboxes.clear();
    vi.clearAllMocks();
  });

  it("rejects the capability on any origin other than the dedicated editor origin", async () => {
    const getEditorTicket = vi.fn();
    const response = await sessions.default.fetch(new Request(
      `https://workshop.example.test/c/${token}/`,
    ), {
      EDITOR_BASE_URL: editorOrigin,
      EDITOR_CAPABILITY_HMAC_SECRET: secret,
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ getEditorTicket }) },
    } as any, { exports: {} } as any);

    expect(response.status).toBe(403);
    expect(getEditorTicket).not.toHaveBeenCalled();
  });

  it("rejects forged well-formed tokens before allocating ticket storage", async () => {
    const getEditorTicket = vi.fn();
    const forged = `${"b".repeat(43)}.${"c".repeat(43)}`;
    const response = await sessions.default.fetch(new Request(
      `${editorOrigin}/c/${forged}/`,
    ), {
      EDITOR_BASE_URL: editorOrigin,
      EDITOR_CAPABILITY_HMAC_SECRET: secret,
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ getEditorTicket }) },
    } as any, { exports: {} } as any);

    expect(response.status).toBe(403);
    expect(getEditorTicket).not.toHaveBeenCalled();
  });

  it("validates generation and strips only the capability prefix before proxying", async () => {
    const getEditorTicket = vi.fn(() => ({
      sandboxId: "sandbox-1",
      userId: "user-1",
      sessionId: "session-1",
      expiresAt: Date.now() + 60_000,
    }));
    const isCurrentSessionGeneration = vi.fn(() => true);
    const containerFetch = vi.fn(async (request: Request, port: number) => {
      expect(request.url).toBe("http://localhost:13337/stable/app.js?x=1");
      expect(request.headers.get("Host")).toBe("editor.example.workers.dev");
      expect(request.headers.get("X-Forwarded-Prefix")).toBe(`/c/${token}`);
      expect(port).toBe(13_337);
      return new Response("asset", { status: 302, headers: { Location: "http://localhost:13337/next?y=2" } });
    });
    sandboxState.sandboxes.set("sandbox-1", { containerFetch });

    const response = await sessions.default.fetch(new Request(
      `${editorOrigin}/c/${token}/stable/app.js?x=1`,
      { headers: { Origin: editorOrigin } },
    ), {
      EDITOR_BASE_URL: editorOrigin,
      EDITOR_CAPABILITY_HMAC_SECRET: secret,
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ getEditorTicket }) },
      SESSION_SANDBOX: {},
    } as any, {
      exports: {
        CodingSessionRegistry: {
          idFromName: (id: string) => id,
          get: () => ({ isCurrentSessionGeneration }),
        },
      },
    } as any);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`/c/${token}/next?y=2`);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Service-Worker-Allowed")).toBe(`/c/${token}/`);
    expect(isCurrentSessionGeneration).toHaveBeenCalledWith("session-1", "sandbox-1", 0);
  });

  it("keeps every internal redirect behind the editor capability prefix", async () => {
    const getEditorTicket = vi.fn(() => ({
      sandboxId: "sandbox-1", userId: "user-1", sessionId: "session-1", expiresAt: Date.now() + 60_000,
    }));
    const locations = [
      "//editor.example.workers.dev/public",
      "//localhost:13337/internal",
      `http://localhost:13337/c/${token}/already?x=1`,
      "//external.example.test/leave",
    ];
    const containerFetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: locations.shift()! },
    }));
    sandboxState.sandboxes.set("sandbox-1", { containerFetch });
    const env = {
      EDITOR_BASE_URL: editorOrigin,
      EDITOR_CAPABILITY_HMAC_SECRET: secret,
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ getEditorTicket }) },
      SESSION_SANDBOX: {},
    } as any;
    const ctx = { exports: { CodingSessionRegistry: {
      idFromName: (id: string) => id,
      get: () => ({ isCurrentSessionGeneration: vi.fn(() => true) }),
    } } } as any;

    const results = [];
    for (let index = 0; index < 4; index++) {
      const response = await sessions.default.fetch(
        new Request(`${editorOrigin}/c/${token}/redirect-${index}`), env, ctx,
      );
      results.push(response.headers.get("Location"));
    }

    expect(results).toEqual([
      `/c/${token}/public`,
      `/c/${token}/internal`,
      `/c/${token}/already?x=1`,
      "//external.example.test/leave",
    ]);
  });

  it("turns editor WebSocket transport failures into a bounded gateway error", async () => {
    const getEditorTicket = vi.fn(() => ({
      sandboxId: "sandbox-1", userId: "user-1", sessionId: "session-1", expiresAt: Date.now() + 60_000,
    }));
    sandboxState.sandboxes.set("sandbox-1", {
      wsConnect: vi.fn(async () => { throw new Error("connect failed"); }),
    });
    const response = await sessions.default.fetch(new Request(
      `${editorOrigin}/c/${token}/stable/socket`,
      { headers: { Upgrade: "websocket", Origin: editorOrigin } },
    ), {
      EDITOR_BASE_URL: editorOrigin,
      EDITOR_CAPABILITY_HMAC_SECRET: secret,
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ getEditorTicket }) },
      SESSION_SANDBOX: {},
    } as any, {
      exports: { CodingSessionRegistry: {
        idFromName: (id: string) => id,
        get: () => ({ isCurrentSessionGeneration: vi.fn(() => true) }),
      } },
    } as any);

    expect(response.status).toBe(502);
  });

  it("rejects a stopped or replaced sandbox generation before proxying", async () => {
    const getEditorTicket = vi.fn(() => ({
      sandboxId: "sandbox-old",
      userId: "user-1",
      sessionId: "session-1",
      expiresAt: Date.now() + 60_000,
    }));
    const containerFetch = vi.fn();
    sandboxState.sandboxes.set("sandbox-old", { containerFetch });

    const response = await sessions.default.fetch(new Request(
      `${editorOrigin}/c/${token}/`,
    ), {
      EDITOR_BASE_URL: editorOrigin,
      EDITOR_CAPABILITY_HMAC_SECRET: secret,
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ getEditorTicket }) },
      SESSION_SANDBOX: {},
    } as any, {
      exports: {
        CodingSessionRegistry: {
          idFromName: (id: string) => id,
          get: () => ({ isCurrentSessionGeneration: vi.fn(() => false) }),
        },
      },
    } as any);

    expect(response.status).toBe(410);
    expect(containerFetch).not.toHaveBeenCalled();
  });
});
