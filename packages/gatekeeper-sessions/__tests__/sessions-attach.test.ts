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
    const getSnapshot = vi.fn(async () => ({ status: "running" }));
    sandboxState.sandboxes.set("sandbox-1", {
      getTerminal: vi.fn(async () => ({ getSnapshot, connect })),
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
    expect(getSnapshot).not.toHaveBeenCalled();
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

async function openCodeToken(secret: string, overrides: Record<string, unknown> = {}) {
  const payloadObject = {
    userId: "user-1",
    sessionId: "session-1",
    sandboxId: "sandbox-1",
    generation: 7,
    instanceTier: "standard-1",
    expiresAt: Date.now() + 60_000,
    nonce: "nonce-1",
    ...overrides,
  };
  const payload = btoa(JSON.stringify(payloadObject)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const signatureBytes = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    new TextEncoder().encode(`odie-opencode-server-v1:${payload}`),
  ));
  let binary = "";
  for (const byte of signatureBytes) binary += String.fromCharCode(byte);
  return `${payload}.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

describe("disabled application preview routing", () => {
  it("does not claim existing editor or terminal attachment routes", async () => {
    const getByName = vi.fn();
    const env = {
      APPLICATION_PREVIEW_ENABLED: "false",
      APPLICATION_PREVIEW_DOMAIN: "sessions.example.test",
      APPLICATION_PREVIEW_CAPABILITY_HMAC_SECRET: "capability-secret",
      APPLICATION_PREVIEW_INGRESS_SECRET: "ingress-secret",
      SESSION_APPLICATION_PREVIEWS: { getByName },
    } as any;
    const ctx = { exports: {} } as any;

    const editorResponse = await sessions.default.fetch(
      new Request(`https://example.test/c/${editorToken}/`), env, ctx,
    );
    const attachResponse = await sessions.default.fetch(
      new Request("https://example.test/gatekeeper/sessions/attach/token"), env, ctx,
    );

    expect(editorResponse.status).toBe(404);
    expect(await editorResponse.text()).toBe("Browser editor is not configured");
    expect(attachResponse.status).toBe(426);
    expect(await attachResponse.text()).toBe("WebSocket upgrade required");
    expect(getByName).not.toHaveBeenCalled();
  });
});

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

describe("coding session same-origin OpenCode HTTP gateway", () => {
  const secret = editorSecret;
  const origin = "https://workshop.example.test";

  beforeEach(() => {
    sandboxState.sandboxes.clear();
    vi.clearAllMocks();
  });

  function envWithTicket(tokenTicket: Record<string, unknown> = {}) {
    const ticket = {
      sandboxId: "sandbox-1",
      userId: "user-1",
      sessionId: "session-1",
      generation: 7,
      instanceTier: "standard-1",
      expiresAt: Date.now() + 60_000,
      ...tokenTicket,
    };
    return {
      BASE_URL: origin,
      EDITOR_CAPABILITY_HMAC_SECRET: secret,
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ getOpenCodeTicket: vi.fn(() => ticket) }) },
      SESSION_SANDBOX: {},
    } as any;
  }

  const currentCtx = (isCurrentSessionGeneration = vi.fn(() => true)) => ({
    exports: { CodingSessionRegistry: { idFromName: (id: string) => id, get: () => ({ isCurrentSessionGeneration }) } },
  } as any);

  it("rejects forged OpenCode tokens before allocating ticket storage", async () => {
    const get = vi.fn();
    const response = await sessions.default.fetch(new Request(
      `${origin}/gatekeeper/sessions/opencode/${"a".repeat(20)}.${"b".repeat(43)}/global/health`,
    ), {
      BASE_URL: origin,
      EDITOR_CAPABILITY_HMAC_SECRET: secret,
      SESSION_POLICIES: { idFromName: (id: string) => id, get },
    } as any, currentCtx());

    expect(response.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  it("enforces same-origin request URLs and optional Origin before proxying", async () => {
    const token = await openCodeToken(secret);
    const response = await sessions.default.fetch(new Request(
      `${origin}/gatekeeper/sessions/opencode/${token}/global/health`,
      { headers: { Origin: "https://evil.example.test" } },
    ), envWithTicket(), currentCtx());

    expect(response.status).toBe(403);
  });

  it("validates generation and allowlists routes before forwarding", async () => {
    const token = await openCodeToken(secret);
    const containerFetch = vi.fn();
    sandboxState.sandboxes.set("sandbox-1", { containerFetch });
    const isCurrentSessionGeneration = vi.fn(() => false);

    const stale = await sessions.default.fetch(new Request(
      `${origin}/gatekeeper/sessions/opencode/${token}/session`,
    ), envWithTicket(), currentCtx(isCurrentSessionGeneration));
    const blocked = await sessions.default.fetch(new Request(
      `${origin}/gatekeeper/sessions/opencode/${token}/config`,
    ), envWithTicket(), currentCtx());
    const traversal = await sessions.default.fetch(new Request(
      `${origin}/gatekeeper/sessions/opencode/${token}/session/../auth`,
    ), envWithTicket(), currentCtx());

    expect(stale.status).toBe(410);
    expect(blocked.status).toBe(404);
    expect(traversal.status).toBe(404);
    expect(containerFetch).not.toHaveBeenCalled();
    expect(isCurrentSessionGeneration).toHaveBeenCalledWith("session-1", "sandbox-1", 7);
  });

  it("strips authority-bearing headers and stream-forwards allowed responses", async () => {
    const token = await openCodeToken(secret);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("ok"));
        controller.close();
      },
    });
    const containerFetch = vi.fn(async (request: Request, port: number) => {
      expect(request.url).toBe("http://127.0.0.1:40913/session/abc/message");
      expect(port).toBe(40_913);
      expect(request.headers.get("Cookie")).toBeNull();
      expect(request.headers.get("Authorization")).toBeNull();
      expect(request.headers.get("Referer")).toBeNull();
      expect(request.headers.get("X-Forwarded-For")).toBeNull();
      expect(request.headers.get("CF-Connecting-IP")).toBeNull();
      expect(request.headers.get("Host")).toBe("127.0.0.1:40913");
      return new Response(body, { headers: {
        "Content-Type": "text/html",
        "Set-Cookie": "session=poisoned",
        "Service-Worker-Allowed": "/",
      } });
    });
    sandboxState.sandboxes.set("sandbox-1", { containerFetch });

    const response = await sessions.default.fetch(new Request(
      `${origin}/gatekeeper/sessions/opencode/${token}/session/abc/message`,
      { headers: { Cookie: "a=b", Authorization: "Bearer secret", Referer: `${origin}/gatekeeper/sessions/opencode/${token}/`, "X-Forwarded-For": "1.2.3.4", "CF-Connecting-IP": "1.2.3.4" } },
    ), envWithTicket(), currentCtx());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Service-Worker-Allowed")).toBeNull();
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("forwards the bounded slash-command route", async () => {
    const token = await openCodeToken(secret);
    const containerFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("http://127.0.0.1:40913/session/abc/command");
      expect(await request.json()).toEqual({ command: "test", arguments: "unit" });
      return new Response(null, { status: 204 });
    });
    sandboxState.sandboxes.set("sandbox-1", { containerFetch });

    const response = await sessions.default.fetch(new Request(
      `${origin}/gatekeeper/sessions/opencode/${token}/session/abc/command`,
      { method: "POST", body: JSON.stringify({ command: "test", arguments: "unit" }), headers: { "Content-Type": "application/json" } },
    ), envWithTicket(), currentCtx());

    expect(response.status).toBe(204);
    expect(containerFetch).toHaveBeenCalledOnce();
  });

  it("bounds POST bodies and rejects redirects", async () => {
    const token = await openCodeToken(secret);
    const oversizedLength = 12 * 1024 * 1024 + 1;
    const large = await sessions.default.fetch(new Request(
      `${origin}/gatekeeper/sessions/opencode/${token}/session/abc/prompt_async`,
      { method: "POST", body: "x".repeat(oversizedLength), headers: { "Content-Length": String(oversizedLength) } },
    ), envWithTicket(), currentCtx());
    expect(large.status).toBe(413);

    const understated = await sessions.default.fetch(new Request(
      `${origin}/gatekeeper/sessions/opencode/${token}/session/abc/prompt_async`,
      { method: "POST", body: "x".repeat(oversizedLength), headers: { "Content-Length": "2" } },
    ), envWithTicket(), currentCtx());
    expect(understated.status).toBe(413);

    sandboxState.sandboxes.set("sandbox-1", {
      containerFetch: vi.fn(async () => new Response(null, { status: 302, headers: { Location: "http://evil.test/" } })),
    });
    const redirect = await sessions.default.fetch(new Request(
      `${origin}/gatekeeper/sessions/opencode/${token}/session/abc/abort`,
      { method: "POST", body: "{}", headers: { "Content-Type": "application/json", "Content-Length": "2" } },
    ), envWithTicket(), currentCtx());

    expect(redirect.status).toBe(502);
    expect(await redirect.text()).toBe("OpenCode redirect rejected");
  });
});
