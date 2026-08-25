import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

const sandboxState = vi.hoisted(() => ({ sandboxes: new Map<string, any>() }));
vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn((_namespace: unknown, id: string) => {
    const sandbox = sandboxState.sandboxes.get(id);
    if (!sandbox) throw new Error(`Unexpected sandbox ${id}`);
    return sandbox;
  }),
}));
import {
  CodingSessionApplicationPreview,
  createApplicationPreviewCapabilityId,
  handleApplicationPreviewIngress,
  hostOnlyCookie,
  proxyRequestFor,
  responseHeaders,
  rewritePreviewLocation,
  verifyApplicationPreviewCapabilityId,
  type ApplicationPreviewRecord,
} from "../src/application-preview.js";

const secret = "preview-capability-test-secret";
const ingressSecret = "cloudfront-ingress-test-secret";
const domain = "preview-isolation.example";

function requestFor(capabilityId: string, options: {
  ingress?: string;
  host?: string;
  path?: string;
} = {}): Request {
  return new Request(
    `https://odie-os-gk-sessions.example/gatekeeper/sessions/application-preview/${capabilityId}${options.path ?? "/asset.js?x=1"}`,
    { headers: {
      "X-Odie-Preview-Ingress": options.ingress ?? ingressSecret,
      "X-Odie-Preview-Host": options.host ?? `${capabilityId}.${domain}`,
    } },
  );
}

function envWith(getByName = vi.fn(() => ({ fetch: vi.fn(async () => new Response("proxied")) }))) {
  return {
    APPLICATION_PREVIEW_ENABLED: "true",
    APPLICATION_PREVIEW_COOKIE_ISOLATION_VERIFIED: "true",
    APPLICATION_PREVIEW_DOMAIN: domain,
    APPLICATION_PREVIEW_CAPABILITY_HMAC_SECRET: secret,
    APPLICATION_PREVIEW_INGRESS_SECRET: ingressSecret,
    SESSION_APPLICATION_PREVIEWS: { getByName },
  } as any;
}

class TestSql {
  readonly database = new DatabaseSync(":memory:");

  exec<T extends Record<string, string | number | null>>(query: string, ...bindings: unknown[]) {
    const normalized = query.trim().toUpperCase();
    if (normalized.startsWith("CREATE ")) {
      this.database.exec(query);
      return { toArray: () => [] as T[] };
    }
    const statement = this.database.prepare(query);
    if (normalized.startsWith("SELECT ")) return { toArray: () => statement.all(...bindings) as T[] };
    statement.run(...bindings);
    return { toArray: () => [] as T[] };
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function previewService(recoveredSockets: WebSocket[] = []) {
  const alarms: number[] = [];
  const sockets: WebSocket[] = [...recoveredSockets];
  const sql = new TestSql();
  const ctx = {
    storage: {
      sql,
      setAlarm: vi.fn(async (time: number) => { alarms.push(time); }),
      deleteAlarm: vi.fn(async () => undefined),
    },
    blockConcurrencyWhile: (callback: () => Promise<void>) => { void callback(); },
    acceptWebSocket: vi.fn((socket: WebSocket) => { sockets.push(socket); }),
    getWebSockets: vi.fn((tag?: string) => tag ? sockets : sockets),
  };
  const env = {
    ...envWith(),
    SESSION_REGISTRIES: { getByName: () => ({ isCurrentSessionGeneration: vi.fn(async () => true) }) },
    SESSION_SANDBOX: {},
    SESSION_SANDBOX_STANDARD_2: {},
    SESSION_SANDBOX_STANDARD_3: {},
    SESSION_SANDBOX_STANDARD_4: {},
  } as any;
  const service = new CodingSessionApplicationPreview(ctx as any, env);
  const capabilityId = await createApplicationPreviewCapabilityId(secret);
  const now = Date.now();
  const record: ApplicationPreviewRecord = {
    capabilityId,
    publicHost: `${capabilityId}.${domain}`,
    userId: "user-1",
    sessionId: "session-1",
    sandboxId: "sandbox-1",
    generation: 7,
    instanceTier: "standard-1",
    componentId: "component-1",
    applicationId: "app-1",
    port: 5001,
    protocols: ["http", "websocket", "sse"],
    createdAt: now,
    expiresAt: now + 60_000,
  };
  await service.configure(record);
  return { service, record, ctx, sql };
}

function identity(record: ApplicationPreviewRecord) {
  const { capabilityId, userId, sessionId, sandboxId, generation, applicationId } = record;
  return { capabilityId, userId, sessionId, sandboxId, generation, applicationId };
}

afterEach(() => {
  sandboxState.sandboxes.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("application preview capability IDs", () => {
  it("creates DNS-safe labels and rejects a forged signature", async () => {
    const capabilityId = await createApplicationPreviewCapabilityId(secret);
    expect(capabilityId).toMatch(/^[a-z2-7]{26}-[a-z2-7]{26}$/);
    await expect(verifyApplicationPreviewCapabilityId(capabilityId, secret)).resolves.toBe(true);
    const forged = `${capabilityId.slice(0, -1)}${capabilityId.endsWith("a") ? "b" : "a"}`;
    await expect(verifyApplicationPreviewCapabilityId(forged, secret)).resolves.toBe(false);
    await expect(verifyApplicationPreviewCapabilityId("not-a-dns-capability", secret)).resolves.toBe(false);
  });
});

describe("application preview CloudFront ingress", () => {
  it("is inert when the flag or any required preview configuration is independently absent", async () => {
    const getByName = vi.fn();
    const capabilityId = await createApplicationPreviewCapabilityId(secret);
    const configured = {
      APPLICATION_PREVIEW_ENABLED: "true",
      APPLICATION_PREVIEW_COOKIE_ISOLATION_VERIFIED: "true",
      APPLICATION_PREVIEW_DOMAIN: domain,
      APPLICATION_PREVIEW_CAPABILITY_HMAC_SECRET: secret,
      APPLICATION_PREVIEW_INGRESS_SECRET: ingressSecret,
    };
    for (const missing of [
      "APPLICATION_PREVIEW_ENABLED",
      "APPLICATION_PREVIEW_COOKIE_ISOLATION_VERIFIED",
      "APPLICATION_PREVIEW_DOMAIN",
      "APPLICATION_PREVIEW_CAPABILITY_HMAC_SECRET",
      "APPLICATION_PREVIEW_INGRESS_SECRET",
    ] as const) {
      const incomplete: Partial<typeof configured> = { ...configured };
      delete incomplete[missing];
      const response = await handleApplicationPreviewIngress(requestFor(capabilityId), {
        ...incomplete,
        SESSION_APPLICATION_PREVIEWS: { getByName },
      } as any);
      expect(response?.status).toBe(404);
    }
    const disabled = await handleApplicationPreviewIngress(requestFor(capabilityId), {
      ...configured,
      APPLICATION_PREVIEW_ENABLED: "false",
      SESSION_APPLICATION_PREVIEWS: { getByName },
    } as any);
    expect(disabled?.status).toBe(404);
    expect(getByName).not.toHaveBeenCalled();
  });

  it("forbids Totango parent domains even when every activation flag is supplied", async () => {
    const getByName = vi.fn();
    const capabilityId = await createApplicationPreviewCapabilityId(secret);
    const totangoDomain = "sessions.dev-unison.totango.com";
    const response = await handleApplicationPreviewIngress(requestFor(capabilityId, {
      host: `${capabilityId}.${totangoDomain}`,
    }), {
      APPLICATION_PREVIEW_ENABLED: "true",
      APPLICATION_PREVIEW_COOKIE_ISOLATION_VERIFIED: "true",
      APPLICATION_PREVIEW_DOMAIN: totangoDomain,
      APPLICATION_PREVIEW_CAPABILITY_HMAC_SECRET: secret,
      APPLICATION_PREVIEW_INGRESS_SECRET: ingressSecret,
      SESSION_APPLICATION_PREVIEWS: { getByName },
    } as any);
    expect(response?.status).toBe(404);
    expect(getByName).not.toHaveBeenCalled();
  });

  it("contains no request logging surface for raw preview authority", () => {
    const source = readFileSync(new URL("../src/application-preview.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\b(?:console|logger)\s*\./);
  });

  it("verifies ingress, host, and HMAC before Durable Object allocation", async () => {
    const getByName = vi.fn();
    const capabilityId = await createApplicationPreviewCapabilityId(secret);
    const forged = `${capabilityId.slice(0, -1)}${capabilityId.endsWith("a") ? "b" : "a"}`;
    for (const request of [
      requestFor(capabilityId, { ingress: "wrong" }),
      requestFor(capabilityId, { host: `other.${domain}` }),
      requestFor(forged),
      new Request(`https://odie-os-gk-sessions.example/gatekeeper/sessions/application-preview/not-valid/`),
    ]) {
      const response = await handleApplicationPreviewIngress(request, envWith(getByName));
      expect(response?.status).toBe(404);
    }
    expect(getByName).not.toHaveBeenCalled();
  });

  it("forwards only the root application path and removes private ingress headers", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe(`https://${capabilityId}.${domain}/nested/app.js?x=1`);
      expect(request.headers.has("X-Odie-Preview-Ingress")).toBe(false);
      expect(request.headers.has("X-Odie-Preview-Host")).toBe(false);
      return new Response("proxied");
    });
    const getByName = vi.fn(() => ({ fetch }));
    const capabilityId = await createApplicationPreviewCapabilityId(secret);
    const response = await handleApplicationPreviewIngress(
      requestFor(capabilityId, { path: "/nested/app.js?x=1" }), envWith(getByName),
    );
    expect(await response?.text()).toBe("proxied");
    expect(getByName).toHaveBeenCalledWith(capabilityId);
  });

  it("does not claim unrelated Sessions routes", async () => {
    const response = await handleApplicationPreviewIngress(
      new Request("https://example.test/gatekeeper/sessions/attach/ticket"), envWith(),
    );
    expect(response).toBeNull();
  });
});

describe("application preview transport admission", () => {
  it("closes recovered relay sockets during construction without waiting for a browser event", async () => {
    const recovered = { close: vi.fn() } as unknown as WebSocket;
    await previewService([recovered]);
    expect(recovered.close).toHaveBeenCalledWith(1012, "Preview relay restarted");
  });

  it("rejects a deferred HTTP response when revoke wins the admission race", async () => {
    const pending = deferred<Response>();
    const cancel = vi.fn();
    const containerFetch = vi.fn((_request: Request) => pending.promise);
    sandboxState.sandboxes.set("sandbox-1", { containerFetch });
    const { service, record } = await previewService();
    const responsePromise = service.fetch(new Request(`https://${record.publicHost}/stream`));
    await vi.waitFor(() => expect(containerFetch).toHaveBeenCalledOnce());
    const proxyRequest = containerFetch.mock.calls[0]![0];

    await service.revoke(identity(record), "test revoke");
    expect(proxyRequest.signal.aborted).toBe(true);
    pending.resolve(new Response(new ReadableStream({ cancel }), { status: 200 }));

    const response = await responsePromise;
    expect(response.status).toBe(410);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  });

  it("closes a deferred upstream WebSocket when revoke wins the admission race", async () => {
    const pending = deferred<Response>();
    const wsConnect = vi.fn((_request: Request) => pending.promise);
    sandboxState.sandboxes.set("sandbox-1", { wsConnect });
    const { service, record, ctx } = await previewService();
    const responsePromise = service.fetch(new Request(`https://${record.publicHost}/socket`, {
      headers: { Connection: "Upgrade", Upgrade: "websocket" },
    }));
    await vi.waitFor(() => expect(wsConnect).toHaveBeenCalledOnce());
    const proxyRequest = wsConnect.mock.calls[0]![0];
    const upstream = { close: vi.fn() } as unknown as WebSocket;

    await service.revoke(identity(record), "test revoke");
    expect(proxyRequest.signal.aborted).toBe(true);
    pending.resolve({ status: 101, webSocket: upstream, headers: new Headers(), body: null } as Response);

    const response = await responsePromise;
    expect(response.status).toBe(410);
    expect(upstream.close).toHaveBeenCalled();
    expect(ctx.acceptWebSocket).not.toHaveBeenCalled();
  });

  it("accepts only the relay hibernatably and closes both sockets after partial setup failure", async () => {
    class FakeSocket {
      readonly accept = vi.fn();
      readonly close = vi.fn();
      readonly send = vi.fn();
      readonly serializeAttachment = vi.fn();
      readonly addEventListener = vi.fn();
    }
    const upstream = new FakeSocket();
    const browser = new FakeSocket();
    const relay = new FakeSocket();
    vi.stubGlobal("WebSocketPair", class {
      0 = browser;
      1 = relay;
    });
    sandboxState.sandboxes.set("sandbox-1", {
      wsConnect: vi.fn(async () => ({
        status: 101,
        webSocket: upstream,
        headers: new Headers(),
        body: null,
      })),
    });
    const { service, record, ctx } = await previewService();
    const response = await service.fetch(new Request(`https://${record.publicHost}/socket`, {
      headers: { Connection: "Upgrade", Upgrade: "websocket" },
    }));

    // Node's Response intentionally rejects status 101, exercising cleanup after relay admission.
    expect(response.status).toBe(502);
    expect(upstream.accept).toHaveBeenCalledOnce();
    expect(ctx.acceptWebSocket).toHaveBeenCalledOnce();
    expect(ctx.acceptWebSocket.mock.calls[0]![0]).toBe(relay);
    expect(ctx.acceptWebSocket.mock.calls[0]![0]).not.toBe(upstream);
    expect(upstream.close).toHaveBeenCalled();
    expect(relay.close).toHaveBeenCalled();
  });

  it("bridges successful outgoing WebSocket listeners in both directions with relay tags", async () => {
    class FakeSocket {
      readonly listeners = new Map<string, Array<(event: any) => void>>();
      attachment: unknown;
      readonly accept = vi.fn();
      readonly close = vi.fn();
      readonly send = vi.fn();
      readonly serializeAttachment = vi.fn((attachment: unknown) => { this.attachment = attachment; });
      readonly deserializeAttachment = vi.fn(() => this.attachment);
      readonly addEventListener = vi.fn((type: string, listener: (event: any) => void) => {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      });
      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    class WorkerUpgradeResponse {
      readonly body: BodyInit | null;
      readonly status: number;
      readonly statusText: string;
      readonly headers: Headers;
      readonly webSocket?: WebSocket;
      constructor(body: BodyInit | null, init: ResponseInit & { webSocket?: WebSocket } = {}) {
        this.body = body;
        this.status = init.status ?? 200;
        this.statusText = init.statusText ?? "";
        this.headers = new Headers(init.headers);
        this.webSocket = init.webSocket;
      }
    }
    const upstream = new FakeSocket();
    const browser = new FakeSocket();
    const relay = new FakeSocket();
    vi.stubGlobal("WebSocketPair", class {
      0 = browser;
      1 = relay;
    });
    vi.stubGlobal("Response", WorkerUpgradeResponse);
    sandboxState.sandboxes.set("sandbox-1", {
      wsConnect: vi.fn(async () => ({
        status: 101,
        webSocket: upstream,
        headers: new Headers({ "Sec-WebSocket-Protocol": "vite-hmr" }),
        body: null,
      })),
    });
    const { service, record, ctx } = await previewService();
    const response = await service.fetch(new Request(`https://${record.publicHost}/socket`, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "vite-hmr",
      },
    }));

    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(browser);
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("vite-hmr");
    expect(upstream.accept).toHaveBeenCalledOnce();
    expect(ctx.acceptWebSocket).toHaveBeenCalledOnce();
    const [accepted, tags] = ctx.acceptWebSocket.mock.calls[0]!;
    expect(accepted).toBe(relay);
    expect(tags[0]).toBe("application-preview");
    expect(tags[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(relay.serializeAttachment).toHaveBeenCalledWith({ transportId: tags[1], side: "browser" });
    expect(ctx.acceptWebSocket.mock.invocationCallOrder[0])
      .toBeLessThan(relay.serializeAttachment.mock.invocationCallOrder[0]!);

    const browserBinary = new Uint8Array([1, 2, 3]).buffer;
    service.webSocketMessage(relay as unknown as WebSocket, "from browser");
    service.webSocketMessage(relay as unknown as WebSocket, browserBinary);
    expect(upstream.send).toHaveBeenNthCalledWith(1, "from browser");
    expect(upstream.send).toHaveBeenNthCalledWith(2, browserBinary);

    const upstreamBinary = new Uint8Array([4, 5, 6]).buffer;
    upstream.emit("message", { data: "from upstream" });
    upstream.emit("message", { data: upstreamBinary });
    expect(relay.send).toHaveBeenNthCalledWith(1, "from upstream");
    expect(relay.send).toHaveBeenNthCalledWith(2, upstreamBinary);

    service.webSocketClose(relay as unknown as WebSocket, 1000, "browser closed");
    expect(upstream.close).toHaveBeenCalledWith(1000, "browser closed");
    upstream.emit("close", { code: 1001, reason: "upstream closed" });
    expect(relay.close).toHaveBeenCalledWith(1001, "upstream closed");
    upstream.emit("error", {});
    expect(relay.close).toHaveBeenCalledWith(1011, "Preview transport failed");
  });

  it("closes a reconstructed relay when its outgoing socket is no longer in memory", async () => {
    const { service } = await previewService();
    const relay = {
      deserializeAttachment: () => ({ transportId: "lost-transport", side: "browser" }),
      close: vi.fn(),
    } as unknown as WebSocket;
    service.webSocketMessage(relay, "message");
    expect(relay.close).toHaveBeenCalledWith(1011, "Preview transport unavailable");
  });

  it("tears down a pending admission even when alarm deletion fails", async () => {
    const pending = deferred<Response>();
    const containerFetch = vi.fn((_request: Request) => pending.promise);
    sandboxState.sandboxes.set("sandbox-1", { containerFetch });
    const { service, record, ctx } = await previewService();
    const responsePromise = service.fetch(new Request(`https://${record.publicHost}/pending`));
    await vi.waitFor(() => expect(containerFetch).toHaveBeenCalledOnce());
    const proxyRequest = containerFetch.mock.calls[0]![0];
    ctx.storage.deleteAlarm.mockRejectedValueOnce(new Error("alarm unavailable"));

    await expect(service.revoke(identity(record), "test revoke")).rejects.toThrow("alarm unavailable");
    expect(proxyRequest.signal.aborted).toBe(true);
    pending.resolve(new Response("late"));
    expect((await responsePromise).status).toBe(410);
  });

  it("re-arms the heartbeat on every identical active configure retry", async () => {
    const { service, record, ctx } = await previewService();
    ctx.storage.setAlarm.mockRejectedValueOnce(new Error("alarm unavailable"));
    await expect(service.configure(record)).rejects.toThrow("alarm unavailable");
    await expect(service.configure(record)).resolves.toBeUndefined();
    expect(ctx.storage.setAlarm).toHaveBeenCalledTimes(3);
  });

  it("returns generic unavailable instead of forwarding an unsafe redirect", async () => {
    sandboxState.sandboxes.set("sandbox-1", {
      containerFetch: vi.fn(async () => new Response(null, {
        status: 302,
        headers: { Location: "http://10.0.0.1/private" },
      })),
    });
    const { service, record } = await previewService();
    const response = await service.fetch(new Request(`https://${record.publicHost}/redirect`));
    expect(response.status).toBe(502);
    expect(response.headers.has("Location")).toBe(false);
    expect(await response.text()).toBe("Preview is unavailable");
  });

  it("retains a permanent revoked identity and never reactivates it", async () => {
    const { service, record, sql, ctx } = await previewService();
    await service.revoke(identity(record), "old revoke");
    vi.setSystemTime(Date.now() + 10 * 365 * 24 * 60 * 60_000);
    await service.alarm();

    await expect(service.configure(record)).rejects.toThrow();
    await expect(service.revoke({
      capabilityId: "unrelated",
      userId: "unrelated",
      sessionId: "unrelated",
      sandboxId: "unrelated",
      generation: 999,
      applicationId: "unrelated",
    }, "private reason")).resolves.toBeUndefined();
    expect(ctx.storage.deleteAlarm).toHaveBeenCalledOnce();
    const rows = sql.exec<{ status: string; record_json: string | null }>(
      "SELECT status, record_json FROM application_preview WHERE singleton = 1",
    ).toArray();
    expect(rows).toEqual([{ status: "revoked", record_json: null }]);
  });

  it("rejects SDK-reserved and non-application ports", async () => {
    for (const port of [80, 1023, 3000, 65_536]) {
      const fresh = await previewService();
      await expect(fresh.service.configure({ ...fresh.record, port })).rejects.toThrow("Invalid");
    }
  });
});

describe("application preview header authority", () => {
  const record = {
    publicHost: `opaque.${domain}`,
    port: 5001,
  } as ApplicationPreviewRecord;

  it("removes spoofed routing families and Connection-named fields while preserving application headers", () => {
    const request = new Request(`https://${record.publicHost}/socket`, { headers: {
      Authorization: "Bearer preserved-unless-dynamic",
      Connection: "Upgrade, X-Dynamic, X-Remove-Authorization",
      Cookie: "sid=one",
      Forwarded: "for=attacker",
      Origin: `https://${record.publicHost}`,
      Upgrade: "not-websocket",
      "CF-Connecting-IP": "127.0.0.1",
      "X-Amz-Cf-Id": "fake",
      "X-Dynamic": "remove me",
      "X-Forwarded-Host": "evil.test",
      "X-Original-URL": "/admin",
      "X-Remove-Authorization": "remove me too",
      "X-Rewrite-URL": "/private",
      "X-Custom-App": "keep me",
    } });
    const proxied = proxyRequestFor(request, record, undefined, true);
    expect(proxied.headers.get("Host")).toBe(record.publicHost);
    expect(proxied.headers.get("X-Forwarded-Host")).toBe(record.publicHost);
    expect(proxied.headers.get("X-Forwarded-Proto")).toBe("https");
    expect(proxied.headers.get("Connection")).toBe("Upgrade");
    expect(proxied.headers.get("Upgrade")).toBe("websocket");
    expect(proxied.headers.get("Authorization")).toBe("Bearer preserved-unless-dynamic");
    expect(proxied.headers.get("Cookie")).toBe("sid=one");
    expect(proxied.headers.get("Origin")).toBe(`https://${record.publicHost}`);
    expect(proxied.headers.get("X-Custom-App")).toBe("keep me");
    for (const removed of ["Forwarded", "CF-Connecting-IP", "X-Amz-Cf-Id", "X-Dynamic",
      "X-Original-URL", "X-Remove-Authorization", "X-Rewrite-URL"]) {
      expect(proxied.headers.has(removed)).toBe(false);
    }
  });

  it("removes response routing families and dynamic Connection tokens", () => {
    const upstream = new Headers({
      Connection: "X-Internal-Hop",
      "X-Internal-Hop": "secret",
      "X-Forwarded-For": "private",
      "CF-Ray": "private",
      "X-Custom-App": "keep me",
    });
    const isolated = responseHeaders(upstream, record);
    expect(isolated.get("X-Custom-App")).toBe("keep me");
    expect(isolated.has("Connection")).toBe(false);
    expect(isolated.has("X-Internal-Hop")).toBe(false);
    expect(isolated.has("X-Forwarded-For")).toBe(false);
    expect(isolated.has("CF-Ray")).toBe(false);
  });
});

describe("application preview response isolation", () => {
  const record = { publicHost: `opaque.${domain}`, port: 5001 };

  it("forces cookies to be host-only without disturbing other attributes", () => {
    expect(hostOnlyCookie("sid=one; Domain=localhost; Path=/; Secure; HttpOnly"))
      .toBe("sid=one; Path=/; Secure; HttpOnly");
    expect(hostOnlyCookie("sid=one; domain=.example.com; SameSite=Lax"))
      .toBe("sid=one; SameSite=Lax");
  });

  it("rewrites every exact mapped listener and preserves only safe external/root redirects", () => {
    for (const host of ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]) {
      expect(rewritePreviewLocation(`http://${host}:5001/login?next=%2F#top`, record))
        .toBe(`https://${record.publicHost}/login?next=%2F#top`);
    }
    expect(rewritePreviewLocation("/root-relative", record)).toBe("/root-relative");
    expect(rewritePreviewLocation("https://auth.example.com/login", record))
      .toBe("https://auth.example.com/login");
    expect(rewritePreviewLocation("http://8.8.8.8/login", record)).toBe("http://8.8.8.8/login");
  });

  it("rejects ambiguous, local, private, credentialed, and non-HTTP redirect targets", () => {
    for (const location of [
      "http://localhost:9000/private",
      "http://localhost./private",
      "http://127.1.2.3/private",
      "http://10.0.0.1/private",
      "http://172.16.0.1/private",
      "http://192.168.1.1/private",
      "http://100.64.0.1/private",
      "http://169.254.1.1/private",
      "http://[fd00::1]/private",
      "http://[fe80::1]/private",
      "http://[fec0::1]/private",
      "http://[100::1]/private",
      "http://[4000::1]/private",
      "http://internal/private",
      "http://service.local/private",
      "https://user:password@example.com/private",
      "ftp://example.com/private",
      "javascript:alert(1)",
    ]) expect(rewritePreviewLocation(location, record)).toBeUndefined();

    const isolated = responseHeaders(new Headers({ Location: "http://10.0.0.1/private" }), record as ApplicationPreviewRecord);
    expect(isolated.has("Location")).toBe(false);
  });
});
