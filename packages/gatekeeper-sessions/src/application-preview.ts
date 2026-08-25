import { DurableObject } from "cloudflare:workers";
import type {
  CodingSessionInstanceTier,
} from "@gadgets/workshop-shared/api";
import type { CodingSessionRegistry } from "./sessions.js";
import { sandboxFor, type CodingSessionSandboxEnv } from "./sandbox-routing.js";

const CAPABILITY_PATTERN = /^[a-z2-7]{26}-[a-z2-7]{26}$/;
const INGRESS_PREFIX = "/gatekeeper/sessions/application-preview/";
const HEARTBEAT_MS = 30_000;
const MAX_CAPABILITY_TTL_MS = 30 * 60_000;
const PREVIEW_SOCKET_TAG = "application-preview";
const TEXT_ENCODER = new TextEncoder();

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade",
]);
const ROUTING_HEADERS = new Set([
  "cdn-loop", "forwarded", "host", "true-client-ip", "via", "x-real-ip",
  "x-odie-preview-host", "x-odie-preview-ingress",
]);

/** Environment bindings and configuration used only by the dark application-preview relay. */
export interface ApplicationPreviewEnv extends CodingSessionSandboxEnv {
  SESSION_APPLICATION_PREVIEWS: DurableObjectNamespace<CodingSessionApplicationPreview>;
  SESSION_REGISTRIES: DurableObjectNamespace<CodingSessionRegistry>;
  APPLICATION_PREVIEW_ENABLED?: string;
  APPLICATION_PREVIEW_COOKIE_ISOLATION_VERIFIED?: string;
  APPLICATION_PREVIEW_DOMAIN?: string;
  APPLICATION_PREVIEW_CAPABILITY_HMAC_SECRET?: string;
  APPLICATION_PREVIEW_INGRESS_SECRET?: string;
}

/** Immutable authority installed in one opaque application-preview relay. */
export interface ApplicationPreviewRecord {
  capabilityId: string;
  publicHost: string;
  userId: string;
  sessionId: string;
  sandboxId: string;
  generation: number;
  instanceTier: CodingSessionInstanceTier;
  componentId: string;
  applicationId: string;
  port: number;
  protocols: Array<"http" | "websocket" | "sse">;
  createdAt: number;
  expiresAt: number;
}

/** Identity required by control-plane renew and revoke calls. */
export type ApplicationPreviewIdentity = Pick<
  ApplicationPreviewRecord,
  "capabilityId" | "userId" | "sessionId" | "sandboxId" | "generation" | "applicationId"
>;

type StoredPreview = {
  record: ApplicationPreviewRecord;
  status: "active";
} | {
  status: "revoked";
};

type ActiveStoredPreview = Extract<StoredPreview, { status: "active" }>;

type PreviewConfiguration = {
  domain: string;
  capabilitySecret: string;
  ingressSecret: string;
};

type SocketAttachment = {
  transportId: string;
  side: "browser" | "sandbox";
};

type ActiveHttpTransport = {
  abort: AbortController;
  terminate?: () => void;
};

type PendingAdmission = {
  abort: AbortController;
  epoch: number;
};

/** Creates a DNS-label-safe, signed opaque preview capability ID. */
export async function createApplicationPreviewCapabilityId(secret: string): Promise<string> {
  const nonce = base32(crypto.getRandomValues(new Uint8Array(16)));
  const signature = base32((await hmac(secret, `odie-application-preview-v1:${nonce}`)).slice(0, 16));
  return `${nonce}-${signature}`;
}

/** Verifies a signed preview ID before a caller allocates or addresses its Durable Object. */
export async function verifyApplicationPreviewCapabilityId(
  capabilityId: string,
  secret: string,
): Promise<boolean> {
  if (!CAPABILITY_PATTERN.test(capabilityId)) return false;
  const nonce = capabilityId.slice(0, 26);
  const supplied = capabilityId.slice(27);
  const expected = base32((await hmac(secret, `odie-application-preview-v1:${nonce}`)).slice(0, 16));
  return constantTimeEqual(supplied, expected);
}

/**
 * Handles only the CloudFront-rewritten application-preview prefix.
 *
 * A disabled or incompletely configured deployment returns a closed 404 without verifying a token
 * or allocating a Durable Object. Other Sessions HTTP paths return `null` to the existing handler.
 */
export async function handleApplicationPreviewIngress(
  request: Request,
  env: ApplicationPreviewEnv,
): Promise<Response | null> {
  // Preview URLs, paths, hosts, and ingress headers are capabilities or private routing data.
  // Keep rejection generic and do not add request-derived logging in this relay.
  const url = new URL(request.url);
  if (!url.pathname.startsWith(INGRESS_PREFIX)) return null;
  const configuration = previewConfiguration(env);
  if (!configuration) return closedResponse(404, "Not found");

  const suffix = url.pathname.slice(INGRESS_PREFIX.length);
  const slash = suffix.indexOf("/");
  const capabilityId = slash === -1 ? suffix : suffix.slice(0, slash);
  const applicationPath = slash === -1 ? "/" : suffix.slice(slash);
  if (!CAPABILITY_PATTERN.test(capabilityId) ||
      !constantTimeEqual(request.headers.get("X-Odie-Preview-Ingress") ?? "", configuration.ingressSecret)) {
    return closedResponse(404, "Not found");
  }
  const publicHost = request.headers.get("X-Odie-Preview-Host")?.toLowerCase();
  const expectedHost = `${capabilityId}.${configuration.domain}`;
  if (publicHost !== expectedHost ||
      !(await verifyApplicationPreviewCapabilityId(capabilityId, configuration.capabilitySecret))) {
    return closedResponse(404, "Not found");
  }

  const headers = new Headers(request.headers);
  headers.delete("X-Odie-Preview-Ingress");
  headers.delete("X-Odie-Preview-Host");
  const publicUrl = new URL(`https://${publicHost}${applicationPath}`);
  publicUrl.search = url.search;
  const relayRequest = new Request(publicUrl, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
  return env.SESSION_APPLICATION_PREVIEWS.getByName(capabilityId).fetch(relayRequest);
}

/** Stateful, generation-bound HTTP/WebSocket/SSE relay for one opaque preview hostname. */
export class CodingSessionApplicationPreview extends DurableObject<ApplicationPreviewEnv> {
  readonly #activeRequests = new Set<ActiveHttpTransport>();
  readonly #pendingAdmissions = new Set<PendingAdmission>();
  readonly #upstreamSockets = new Map<string, WebSocket>();
  #admissionEpoch = 0;

  constructor(ctx: DurableObjectState<{}>, env: ApplicationPreviewEnv) {
    super(ctx, env);
    // Keep explicit assignments compatible with the package's lightweight Worker unit shim.
    this.ctx = ctx;
    this.env = env;
    for (const socket of ctx.getWebSockets(PREVIEW_SOCKET_TAG)) {
      safeClose(socket, 1012, "Preview relay restarted");
    }
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS application_preview (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          record_json TEXT,
          status TEXT NOT NULL CHECK (status IN ('active', 'revoked'))
        )
      `);
    });
  }

  /** Installs the relay's immutable target. Repeated identical configuration is idempotent. */
  async configure(record: ApplicationPreviewRecord): Promise<void> {
    const configuration = previewConfiguration(this.env);
    if (!configuration) throw new Error("Application previews are disabled.");
    await validateRecord(record, configuration);
    const existing = this.#stored();
    if (existing) {
      if (existing.status === "active" && recordsEqual(existing.record, record)) {
        await this.#scheduleHeartbeat(record.expiresAt);
        return;
      }
      throw new Error("Application preview authority is immutable.");
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO application_preview (singleton, record_json, status) VALUES (1, ?, 'active')",
      JSON.stringify(record),
    );
    await this.#scheduleHeartbeat(record.expiresAt);
  }

  /** Extends an active capability without changing any target authority. */
  async renew(identity: ApplicationPreviewIdentity, expiresAt: number): Promise<void> {
    const stored = this.#requireActive(identity);
    const now = Date.now();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + MAX_CAPABILITY_TTL_MS) {
      throw new Error("Invalid application preview expiry.");
    }
    const record = { ...stored.record, expiresAt };
    this.ctx.storage.sql.exec(
      "UPDATE application_preview SET record_json = ? WHERE singleton = 1 AND status = 'active'",
      JSON.stringify(record),
    );
    this.#invalidatePendingAdmissions("Preview authority changed");
    await this.#scheduleHeartbeat(expiresAt);
  }

  /** Persists revocation before closing every established HTTP, SSE, and WebSocket transport. */
  async revoke(identity: ApplicationPreviewIdentity, _reason = "Preview revoked"): Promise<void> {
    const stored = this.#stored();
    if (!stored) throw new Error("Application preview identity does not match.");
    if (stored.status === "active" && !sameIdentity(stored.record, identity)) {
      throw new Error("Application preview identity does not match.");
    }
    await this.#revoke(stored);
  }

  /** Returns whether this exact capability remains active. */
  isActive(identity: ApplicationPreviewIdentity): boolean {
    const stored = this.#stored();
    return !!stored && stored.status === "active" && sameIdentity(stored.record, identity) &&
      stored.record.expiresAt > Date.now();
  }

  /** Proxies one request only after current-generation admission. */
  async fetch(request: Request): Promise<Response> {
    const stored = this.#stored();
    if (!stored) return closedResponse(404, "Not found");
    if (stored.status !== "active") return closedResponse(410, "Preview is no longer available");
    if (!(await this.#stillAdmitted(stored.record))) {
      await this.#revoke(stored);
      return closedResponse(410, "Preview is no longer available");
    }
    const requestUrl = new URL(request.url);
    if (requestUrl.protocol !== "https:" || requestUrl.host !== stored.record.publicHost) {
      return closedResponse(403, "Preview origin is not allowed");
    }
    const origin = request.headers.get("Origin");
    if (origin && origin !== requestUrl.origin) return closedResponse(403, "Preview origin is not allowed");

    const isWebSocket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (isWebSocket && !stored.record.protocols.includes("websocket")) {
      return closedResponse(426, "WebSocket preview is not enabled");
    }
    if (!isWebSocket && !stored.record.protocols.includes("http")) {
      return closedResponse(405, "HTTP preview is not enabled");
    }
    return isWebSocket ? this.#proxyWebSocket(request, stored.record) : this.#proxyHttp(request, stored.record);
  }

  /** Revalidates active transports at least every thirty seconds; tombstones are permanent. */
  async alarm(): Promise<void> {
    const stored = this.#stored();
    if (!stored || stored.status === "revoked") return;

    if (!(await this.#stillAdmitted(stored.record))) {
      await this.#revoke(stored);
      return;
    }
    await this.#scheduleHeartbeat(stored.record.expiresAt);
  }

  webSocketMessage(webSocket: WebSocket, message: ArrayBuffer | string): void {
    const transportId = this.#socketTransportId(webSocket);
    const peer = transportId ? this.#upstreamSockets.get(transportId) : undefined;
    if (!transportId || !peer) {
      safeClose(webSocket, 1011, "Preview transport unavailable");
      return;
    }
    try {
      peer.send(message);
    } catch {
      this.#upstreamSockets.delete(transportId);
      safeClose(webSocket, 1011, "Preview transport unavailable");
      safeClose(peer, 1011, "Preview transport unavailable");
    }
  }

  webSocketClose(webSocket: WebSocket, code: number, reason: string): void {
    const transportId = this.#socketTransportId(webSocket);
    const peer = transportId ? this.#upstreamSockets.get(transportId) : undefined;
    if (transportId) this.#upstreamSockets.delete(transportId);
    if (peer) safeClose(peer, code, reason);
  }

  webSocketError(webSocket: WebSocket): void {
    const transportId = this.#socketTransportId(webSocket);
    const peer = transportId ? this.#upstreamSockets.get(transportId) : undefined;
    if (transportId) this.#upstreamSockets.delete(transportId);
    safeClose(webSocket, 1011, "Preview transport failed");
    if (peer) safeClose(peer, 1011, "Preview transport failed");
  }

  async #proxyHttp(request: Request, record: ApplicationPreviewRecord): Promise<Response> {
    const admission = this.#beginAdmission(record);
    if (!admission) return closedResponse(410, "Preview is no longer available");
    const transport: ActiveHttpTransport = { abort: admission.abort };
    const abortFromClient = () => admission.abort.abort(request.signal.reason);
    request.signal.addEventListener("abort", abortFromClient, { once: true });
    let upstream: Response | undefined;
    try {
      const proxyRequest = proxyRequestFor(request, record, admission.abort.signal, false);
      upstream = await sandboxFor(this.env, record.instanceTier, record.sandboxId)
        .containerFetch(proxyRequest, record.port);
      if (!this.#promoteAdmission(admission, record, transport)) {
        await upstream.body?.cancel().catch(() => undefined);
        return closedResponse(410, "Preview is no longer available");
      }
      const isEventStream = upstream.headers.get("Content-Type")?.toLowerCase()
        .startsWith("text/event-stream") ?? false;
      if (isEventStream && !record.protocols.includes("sse")) {
        await upstream.body?.cancel().catch(() => undefined);
        this.#activeRequests.delete(transport);
        return closedResponse(502, "Preview is unavailable");
      }
      const location = upstream.headers.get("Location");
      if (location && rewritePreviewLocation(location, record) === undefined) {
        await upstream.body?.cancel().catch(() => undefined);
        this.#activeRequests.delete(transport);
        return closedResponse(502, "Preview is unavailable");
      }
      const headers = responseHeaders(upstream.headers, record);
      if (!upstream.body) {
        this.#activeRequests.delete(transport);
        return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers });
      }
      const body = trackedBody(upstream.body, transport, () => {
        this.#activeRequests.delete(transport);
        request.signal.removeEventListener("abort", abortFromClient);
      });
      return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
    } catch {
      this.#pendingAdmissions.delete(admission);
      transport.abort.abort(new Error("Preview transport failed"));
      transport.terminate?.();
      await upstream?.body?.cancel().catch(() => undefined);
      this.#activeRequests.delete(transport);
      return closedResponse(502, "Preview is unavailable");
    } finally {
      if (!this.#activeRequests.has(transport)) {
        request.signal.removeEventListener("abort", abortFromClient);
      }
    }
  }

  async #proxyWebSocket(request: Request, record: ApplicationPreviewRecord): Promise<Response> {
    const admission = this.#beginAdmission(record);
    if (!admission) return closedResponse(410, "Preview is no longer available");
    let upstream: WebSocket | undefined;
    let relay: WebSocket | undefined;
    let transportId: string | undefined;
    try {
      const upstreamResponse = await sandboxFor(this.env, record.instanceTier, record.sandboxId)
        .wsConnect(proxyRequestFor(request, record, admission.abort.signal, true), record.port);
      upstream = upstreamResponse.webSocket ?? undefined;
      if (!upstream || upstreamResponse.status !== 101) {
        await upstreamResponse.body?.cancel().catch(() => undefined);
        this.#pendingAdmissions.delete(admission);
        if (upstream) safeClose(upstream, 1011, "Preview transport unavailable");
        return closedResponse(502, "Preview is unavailable");
      }
      if (!this.#promoteAdmission(admission, record)) {
        safeClose(upstream, 4001, "Preview revoked");
        return closedResponse(410, "Preview is no longer available");
      }

      upstream.accept();
      const pair = new WebSocketPair();
      const [browser, serverRelay] = Object.values(pair);
      relay = serverRelay;
      transportId = crypto.randomUUID();
      this.ctx.acceptWebSocket(relay, [PREVIEW_SOCKET_TAG, transportId]);
      relay.serializeAttachment({ transportId, side: "browser" } satisfies SocketAttachment);
      this.#upstreamSockets.set(transportId, upstream);
      this.#listenToUpstream(transportId, upstream);

      const headers = new Headers();
      const protocol = upstreamResponse.headers.get("Sec-WebSocket-Protocol");
      if (protocol) headers.set("Sec-WebSocket-Protocol", protocol);
      headers.set("Cache-Control", "private, no-store");
      headers.set("Referrer-Policy", "no-referrer");
      return new Response(null, { status: 101, headers, webSocket: browser });
    } catch {
      this.#pendingAdmissions.delete(admission);
      if (transportId) this.#upstreamSockets.delete(transportId);
      if (relay) safeClose(relay, 1011, "Preview transport unavailable");
      if (upstream) safeClose(upstream, 1011, "Preview transport unavailable");
      return closedResponse(502, "Preview is unavailable");
    }
  }

  #listenToUpstream(transportId: string, upstream: WebSocket): void {
    const relay = () => this.ctx.getWebSockets(transportId)[0];
    upstream.addEventListener("message", event => {
      const downstream = relay();
      if (!downstream) {
        this.#upstreamSockets.delete(transportId);
        safeClose(upstream, 1011, "Preview transport unavailable");
        return;
      }
      try {
        downstream.send(event.data);
      } catch {
        this.#upstreamSockets.delete(transportId);
        safeClose(downstream, 1011, "Preview transport unavailable");
        safeClose(upstream, 1011, "Preview transport unavailable");
      }
    });
    upstream.addEventListener("close", event => {
      this.#upstreamSockets.delete(transportId);
      const downstream = relay();
      if (downstream) safeClose(downstream, event.code, event.reason);
    });
    upstream.addEventListener("error", () => {
      this.#upstreamSockets.delete(transportId);
      const downstream = relay();
      if (downstream) safeClose(downstream, 1011, "Preview transport failed");
      safeClose(upstream, 1011, "Preview transport failed");
    });
  }

  #socketTransportId(webSocket: WebSocket): string | undefined {
    const attachment = webSocket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || attachment.side !== "browser" || typeof attachment.transportId !== "string") {
      return undefined;
    }
    return attachment.transportId;
  }

  #beginAdmission(record: ApplicationPreviewRecord): PendingAdmission | undefined {
    const stored = this.#stored();
    if (stored?.status !== "active" || !recordsEqual(stored.record, record) ||
        stored.record.expiresAt <= Date.now()) return undefined;
    const admission = { abort: new AbortController(), epoch: this.#admissionEpoch };
    this.#pendingAdmissions.add(admission);
    return admission;
  }

  #promoteAdmission(
    admission: PendingAdmission,
    record: ApplicationPreviewRecord,
    transport?: ActiveHttpTransport,
  ): boolean {
    const stored = this.#stored();
    const admitted = this.#pendingAdmissions.has(admission) && !admission.abort.signal.aborted &&
      admission.epoch === this.#admissionEpoch && stored?.status === "active" &&
      recordsEqual(stored.record, record) && stored.record.expiresAt > Date.now();
    this.#pendingAdmissions.delete(admission);
    if (admitted && transport) this.#activeRequests.add(transport);
    return admitted;
  }

  #stored(): StoredPreview | undefined {
    const row = this.ctx.storage.sql.exec<{
      record_json: string | null;
      status: "active" | "revoked";
    }>("SELECT record_json, status FROM application_preview WHERE singleton = 1").toArray()[0];
    if (!row) return undefined;
    if (row.status === "active" && row.record_json !== null) {
      return { record: JSON.parse(row.record_json) as ApplicationPreviewRecord, status: "active" };
    }
    return { status: "revoked" };
  }

  #requireActive(identity: ApplicationPreviewIdentity): ActiveStoredPreview {
    const stored = this.#stored();
    if (!stored || stored.status !== "active" || !sameIdentity(stored.record, identity)) {
      throw new Error("Application preview is not active.");
    }
    return stored;
  }

  async #stillAdmitted(record: ApplicationPreviewRecord): Promise<boolean> {
    const configuration = previewConfiguration(this.env);
    if (!configuration || record.expiresAt <= Date.now() ||
        record.publicHost !== `${record.capabilityId}.${configuration.domain}` ||
        !(await verifyApplicationPreviewCapabilityId(record.capabilityId, configuration.capabilitySecret))) {
      return false;
    }
    try {
      return await this.env.SESSION_REGISTRIES.getByName(record.userId)
        .isCurrentSessionGeneration(record.sessionId, record.sandboxId, record.generation);
    } catch {
      // The registry is the generation authority. A relay that cannot prove the exact live
      // generation must revoke rather than preserve availability with stale authority.
      return false;
    }
  }

  async #revoke(stored: StoredPreview): Promise<void> {
    const newlyRevoked = stored.status === "active";
    if (newlyRevoked) {
      this.ctx.storage.sql.exec(
        "UPDATE application_preview SET record_json = NULL, status = 'revoked' WHERE singleton = 1",
      );
    }
    this.#invalidatePendingAdmissions("Preview revoked");
    for (const transport of this.#activeRequests) {
      transport.abort.abort(new Error("Preview revoked"));
      transport.terminate?.();
    }
    for (const socket of this.ctx.getWebSockets(PREVIEW_SOCKET_TAG)) {
      safeClose(socket, 4001, "Preview revoked");
    }
    for (const socket of this.#upstreamSockets.values()) {
      safeClose(socket, 4001, "Preview revoked");
    }
    this.#upstreamSockets.clear();
    if (newlyRevoked) await this.ctx.storage.deleteAlarm();
  }

  #invalidatePendingAdmissions(reason: string): void {
    this.#admissionEpoch++;
    for (const admission of this.#pendingAdmissions) {
      admission.abort.abort(new Error(reason));
    }
    this.#pendingAdmissions.clear();
  }

  #scheduleHeartbeat(expiresAt: number): Promise<void> {
    return this.ctx.storage.setAlarm(Math.min(expiresAt, Date.now() + HEARTBEAT_MS));
  }
}

function previewConfiguration(env: ApplicationPreviewEnv): PreviewConfiguration | undefined {
  if (env.APPLICATION_PREVIEW_ENABLED !== "true" ||
      env.APPLICATION_PREVIEW_COOKIE_ISOLATION_VERIFIED !== "true") return undefined;
  const domain = env.APPLICATION_PREVIEW_DOMAIN?.trim().toLowerCase();
  const capabilitySecret = env.APPLICATION_PREVIEW_CAPABILITY_HMAC_SECRET;
  const ingressSecret = env.APPLICATION_PREVIEW_INGRESS_SECRET;
  if (!domain || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ||
      domain === "totango.com" || domain.endsWith(".totango.com") ||
      !capabilitySecret || !ingressSecret) return undefined;
  return { domain, capabilitySecret, ingressSecret };
}

async function validateRecord(record: ApplicationPreviewRecord, configuration: PreviewConfiguration): Promise<void> {
  const now = Date.now();
  if (!(await verifyApplicationPreviewCapabilityId(record.capabilityId, configuration.capabilitySecret)) ||
      record.publicHost !== `${record.capabilityId}.${configuration.domain}` ||
      !record.userId || !record.sessionId || !record.sandboxId || !record.componentId || !record.applicationId ||
      [record.userId, record.sessionId, record.sandboxId, record.componentId, record.applicationId]
        .some(value => value.length > 256) ||
      !Number.isSafeInteger(record.generation) || record.generation < 0 ||
      !["standard-1", "standard-2", "standard-3", "standard-4"].includes(record.instanceTier) ||
      !Number.isInteger(record.port) || record.port < 1024 || record.port > 65_535 || record.port === 3000 ||
      !Array.isArray(record.protocols) || !record.protocols.includes("http") ||
      new Set(record.protocols).size !== record.protocols.length ||
      record.protocols.some(protocol => !["http", "websocket", "sse"].includes(protocol)) ||
      !Number.isSafeInteger(record.createdAt) || record.createdAt > now ||
      !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= now ||
      record.expiresAt > now + MAX_CAPABILITY_TTL_MS) {
    throw new Error("Invalid application preview authority.");
  }
}

/** Builds a Sandbox request after removing viewer-controlled routing and hop-by-hop authority. */
export function proxyRequestFor(
  request: Request,
  record: ApplicationPreviewRecord,
  signal: AbortSignal | undefined,
  webSocket: boolean,
): Request {
  const source = new URL(request.url);
  const target = new URL(`http://localhost:${record.port}${source.pathname}`);
  target.search = source.search;
  const headers = sanitizedHeaders(request.headers);
  headers.set("Host", record.publicHost);
  headers.set("X-Forwarded-Host", record.publicHost);
  headers.set("X-Forwarded-Proto", "https");
  if (webSocket) {
    headers.set("Connection", "Upgrade");
    headers.set("Upgrade", "websocket");
  }
  return new Request(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    signal,
  });
}

/** Applies preview response isolation and removes upstream routing and hop-by-hop authority. */
export function responseHeaders(upstream: Headers, record: ApplicationPreviewRecord): Headers {
  const headers = sanitizedHeaders(upstream, true);
  headers.delete("Server");
  for (const cookie of setCookieValues(upstream)) headers.append("Set-Cookie", hostOnlyCookie(cookie));
  const location = headers.get("Location");
  if (location) {
    const safeLocation = rewritePreviewLocation(location, record);
    if (safeLocation === undefined) headers.delete("Location");
    else headers.set("Location", safeLocation);
  }
  headers.set("Cache-Control", "private, no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Service-Worker-Allowed", "/");
  return headers;
}

function setCookieValues(headers: Headers): string[] {
  const extended = headers as Headers & {
    getAll?: (name: "Set-Cookie") => string[];
    getSetCookie?: () => string[];
  };
  if (extended.getAll) return extended.getAll("Set-Cookie");
  if (extended.getSetCookie) return extended.getSetCookie();
  const single = headers.get("Set-Cookie");
  return single ? [single] : [];
}

function sanitizedHeaders(source: Headers, response = false): Headers {
  const dynamic = connectionTokens(source);
  const result = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (lower === "set-cookie" || dynamic.has(lower) || HOP_BY_HOP_HEADERS.has(lower) ||
        isRoutingHeader(lower)) continue;
    result.append(name, value);
  }
  if (response) result.delete("Set-Cookie");
  return result;
}

function connectionTokens(headers: Headers): Set<string> {
  return new Set((headers.get("Connection") ?? "").split(",")
    .map(token => token.trim().toLowerCase())
    .filter(token => /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(token)));
}

function isRoutingHeader(name: string): boolean {
  return ROUTING_HEADERS.has(name) || name.startsWith("x-forwarded-") ||
    name.startsWith("x-original-") || name.startsWith("x-rewrite-") ||
    name.startsWith("cf-") || name.startsWith("x-amz-") || name.startsWith("x-edge-") ||
    name.startsWith("x-odie-preview-");
}

/** Removes cookie Domain authority so one preview can never write into a sibling preview host. */
export function hostOnlyCookie(cookie: string): string {
  return cookie.split(";").filter((part, index) =>
    index === 0 || !/^\s*domain\s*=/i.test(part)).join(";");
}

/** Rewrites the exact private listener, preserves safe external HTTP(S), and rejects other targets. */
export function rewritePreviewLocation(
  location: string,
  record: Pick<ApplicationPreviewRecord, "publicHost" | "port">,
): string | undefined {
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(location) || location.startsWith("//");
  if (!absolute) return location;
  let parsed: URL;
  try {
    parsed = new URL(location, `https://${record.publicHost}/`);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(hostname)) {
    if (parsed.port !== String(record.port)) return undefined;
    return `https://${record.publicHost}${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  return clearlyExternalHost(hostname) ? location : undefined;
}

function clearlyExternalHost(hostname: string): boolean {
  if (!hostname || hostname.includes(":") || hostname.endsWith(".") || hostname.endsWith(".local") ||
      hostname === "local" || !hostname.includes(".")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return publicIpv4(hostname);
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/i
    .test(hostname);
}

function publicIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b, c] = octets as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113));
}

function trackedBody(
  body: ReadableStream<Uint8Array>,
  transport: ActiveHttpTransport,
  done: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    transport.terminate = undefined;
    done();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      downstream = controller;
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch {
        if (!finished) controller.error(new Error("Preview stream ended"));
        finish();
      }
    },
    async cancel(reason) {
      transport.abort.abort(reason);
      finish();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  transport.terminate = () => {
    if (finished) return;
    downstream?.error(new Error("Preview revoked"));
    void reader.cancel("Preview revoked").catch(() => undefined);
    finish();
  };
  return stream;
}

function sameIdentity(record: ApplicationPreviewIdentity, identity: ApplicationPreviewIdentity): boolean {
  return record.capabilityId === identity.capabilityId && record.userId === identity.userId &&
    record.sessionId === identity.sessionId && record.sandboxId === identity.sandboxId &&
    record.generation === identity.generation && record.applicationId === identity.applicationId;
}

function recordsEqual(left: ApplicationPreviewRecord, right: ApplicationPreviewRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeClose(socket: WebSocket, code: number, reason: string): void {
  const validCode = (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
    (code >= 3000 && code <= 4999) ? code : 1011;
  try {
    socket.close(validCode, boundedCloseReason(reason));
  } catch {
    // The peer may already be closed. Revocation and paired close remain idempotent.
  }
}

function boundedCloseReason(reason: string): string {
  let result = sanitizedReason(reason);
  while (TEXT_ENCODER.encode(result).byteLength > 120) result = result.slice(0, -1);
  return result;
}

function sanitizedReason(reason: string): string {
  return reason.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\u0000", " ");
}

function closedResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", TEXT_ENCODER.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(message)));
}

function base32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
