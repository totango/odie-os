import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { zstdDecompressSync } from "node:zlib";
import { ContainerProxy, Sandbox, getSandbox } from "@cloudflare/sandbox";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import { validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  type CodingSessionAttachCapability,
  type CodingSessionRepository,
  type CodingSessionSummary,
  type CreateCodingSessionRequest,
} from "@gadgets/workshop-shared/api";
import {
  type CodingSessionOwner,
  type CodingSessionTool,
  type CodingSessionToolHost,
  type CodingSessionToolResult,
  type CodingSessionsService,
} from "@gadgets/workshop-shared/coding-sessions";
import type { VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { validateRepositories } from "./policy.js";

export { ContainerProxy };

const ATTACH_TTL_MS = 60_000;
const MAX_SESSIONS_PER_USER = 5;
const MAX_TITLE_LENGTH = 120;
const GITHUB_ORIGIN = "https://github.com";
const GITHUB_API_ORIGIN = "https://api.github.com";
const WORKSHOP_MCP_HOST = "workshop-mcp.internal";

type SessionsLogFields = {
  sessionId?: string;
  userId?: string;
  repositoryCount?: number;
};

const logger = createLogger<SessionsLogFields>({ component: "gatekeeper.sessions" });

interface Env {
  SESSION_SANDBOX: DurableObjectNamespace<CodingSessionSandbox>;
  SESSION_POLICIES: DurableObjectNamespace<CodingSessionPolicy>;
  BASE_URL?: string;
  SESSION_ALLOWED_ORIGIN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  TEAM_PI_CODEX_BASE_URL?: string;
  TEAM_PI_CODEX_HMAC_SECRET?: string;
}

type SessionRecord = CodingSessionSummary & {
  sandboxId: string;
  terminalId?: string;
};

type AttachTicket = {
  sandboxId: string;
  terminalId: string;
  expiresAt: number;
};

type SessionPolicy = {
  sessionId: string;
  owner: CodingSessionOwner;
  repositories: CodingSessionRepository[];
  toolHost: Fetcher<CodingSessionToolHost>;
};

/** Isolated Linux environment used by one coding session. */
export class CodingSessionSandbox extends Sandbox<Env> {
  sleepAfter = "10m";
  enableInternet = false;
  interceptHttps = true;
  entrypoint = [
    "sh", "-lc",
    "cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && update-ca-certificates && exec /usr/bin/tini -- /container-server/sandbox",
  ];
  allowedHosts = [
    "github.com",
    "registry.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
    "proxy.golang.org",
    "sum.golang.org",
    "team-pi-proxy.unison.totango.com",
    WORKSHOP_MCP_HOST,
  ];

  static outboundByHost = {
    "team-pi-proxy.unison.totango.com":
      (request: Request, env: Env, ctx: OutboundHandlerContext) =>
        policyFor(env, ctx.containerId).forwardTeamPiCodexRequest(request),
    [WORKSHOP_MCP_HOST]:
      (request: Request, env: Env, ctx: OutboundHandlerContext) =>
        policyFor(env, ctx.containerId).handleWorkshopMcpRequest(request),
    "registry.npmjs.org": publicReadOnlyRequest,
    "pypi.org": publicReadOnlyRequest,
    "files.pythonhosted.org": publicReadOnlyRequest,
    "proxy.golang.org": publicReadOnlyRequest,
    "sum.golang.org": publicReadOnlyRequest,
  };

  /** Installs GitHub authentication in the Worker-side credential proxy. */
  async configureGitHubAuth(token: string): Promise<void> {
    await this.registerGitAuthInterceptor({
      hosts: { "github.com": { token, username: "x-access-token", type: "basic" } },
    });
  }

  /** Clones one selected repository through the configured credential proxy. */
  async checkoutRepository(repository: CodingSessionRepository): Promise<void> {
    await this.exec([
      "git", "clone", "--depth=1", "--filter=blob:none",
      `${GITHUB_ORIGIN}/totango/${repository}.git`, `/workspace/${repository}`,
    ], { timeout: 120_000 });
    const headPath = `/workspace/${repository}/.git/HEAD`;
    for (let attempt = 0; attempt < 120; attempt++) {
      if ((await this.exists(headPath)).exists) return;
      await delay(1_000);
    }
    throw new Error(`Timed out cloning ${repository}.`);
  }
}

/** Durable repository and model egress policy for one sandbox instance. */
export class CodingSessionPolicy extends DurableObject<Env> {
  /** Installs the immutable owner and repository set before the sandbox starts. */
  configure(policy: SessionPolicy): void {
    const existing = this.ctx.storage.kv.get<SessionPolicy>("policy");
    if (existing) {
      if (JSON.stringify({ sessionId: existing.sessionId, owner: existing.owner, repositories: existing.repositories }) !==
          JSON.stringify({ sessionId: policy.sessionId, owner: policy.owner, repositories: policy.repositories })) {
        throw new Error("Coding session policy is immutable.");
      }
      return;
    }
    this.ctx.storage.kv.put("policy", policy);
  }

  /** Stores a short-lived terminal ticket in a token-addressed policy object. */
  async storeTicket(ticket: AttachTicket): Promise<void> {
    this.ctx.storage.kv.put("ticket", ticket);
    await this.ctx.storage.setAlarm(ticket.expiresAt);
  }

  /** Atomically consumes a terminal ticket. */
  consumeTicket(now: number): AttachTicket | null {
    const ticket = this.ctx.storage.kv.get<AttachTicket>("ticket");
    this.ctx.storage.kv.delete("ticket");
    if (!ticket || ticket.expiresAt < now) return null;
    return ticket;
  }

  /** Deletes expired one-time ticket state. */
  alarm(): void {
    this.ctx.storage.kv.delete("ticket");
  }

  /** Mints or reuses a GitHub token scoped to this session's repositories. */
  async getInstallationToken(): Promise<string> {
    const policy = this.#policy();
    return this.#installationToken(policy.repositories);
  }

  /** Signs and proxies one Team PI Codex Responses request for the authenticated owner. */
  async forwardTeamPiCodexRequest(request: Request): Promise<Response> {
    const policy = this.#policy();
    const baseUrl = required(this.env.TEAM_PI_CODEX_BASE_URL, "TEAM_PI_CODEX_BASE_URL");
    const secret = required(this.env.TEAM_PI_CODEX_HMAC_SECRET, "TEAM_PI_CODEX_HMAC_SECRET");
    const expected = new URL("codex/responses", ensureTrailingSlash(baseUrl));
    const url = new URL(request.url);
    if (request.method !== "POST" || url.origin !== expected.origin || url.pathname !== expected.pathname) {
      return new Response("Codex request is not allowed.", { status: 403 });
    }

    let body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > 4 * 1024 * 1024) {
      return new Response("Codex request is too large.", { status: 413 });
    }
    const encoding = request.headers.get("Content-Encoding")?.trim().toLowerCase();
    if (encoding === "zstd") {
      body = Uint8Array.from(zstdDecompressSync(body, { maxOutputLength: 8 * 1024 * 1024 }));
    } else if (encoding && encoding !== "identity") {
      return new Response("Codex request encoding is not supported.", { status: 415 });
    }
    const timestamp = Date.now().toString();
    const clientRequestId = crypto.randomUUID();
    const sessionId = this.ctx.id.toString();
    const user = policy.owner.email.toLowerCase();
    const canonical = [
      "odie-v1",
      "team-pi-codex",
      "POST",
      "/api/odie/codex/responses",
      timestamp,
      user,
      sessionId,
      clientRequestId,
      await sha256Hex(body),
    ].join("\n");
    const headers = new Headers();
    for (const name of ["Content-Type", "Accept", "OpenAI-Beta", "Originator"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("Content-Encoding", "identity");
    headers.set("session-id", sessionId);
    headers.set("x-client-request-id", clientRequestId);
    headers.set("x-team-pi-odie-key-id", "odie-v1");
    headers.set("x-team-pi-odie-audience", "team-pi-codex");
    headers.set("x-team-pi-odie-timestamp", timestamp);
    headers.set("x-team-pi-odie-user", user);
    headers.set("x-team-pi-odie-signature", `v1=${await hmacBase64Url(secret, canonical)}`);
    return fetch(expected, { method: "POST", headers, body, redirect: "manual" });
  }

  /** Terminates the session-scoped Workshop MCP protocol without exposing account credentials. */
  async handleWorkshopMcpRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.hostname !== WORKSHOP_MCP_HOST || url.pathname !== "/mcp") {
      return new Response("Workshop MCP request is not allowed.", { status: 403 });
    }
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return new Response("Workshop MCP requires JSON.", { status: 415 });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > 1024 * 1024) return new Response("Workshop MCP request is too large.", { status: 413 });
    let message: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
    try {
      message = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return mcpError(null, -32700, "Parse error");
    }
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return mcpError(message.id ?? null, -32600, "Invalid Request");
    }
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    const policy = this.#policy();
    try {
      if (message.method === "initialize") {
        return mcpResult(message.id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "Workshop connections", version: "1.0.0" },
        });
      }
      if (message.method === "tools/list") {
        const tools = await policy.toolHost.listTools(
          policy.sessionId) as unknown as CodingSessionTool[];
        return mcpResult(message.id, {
          tools: [
            ...tools.map(tool => ({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
            })),
            {
              name: "workshop_action_result",
              title: "Collect an approved Workshop action",
              description: "Collect the result of a connected-service action after Workshop approval.",
              inputSchema: {
                type: "object",
                properties: {
                  tool: { type: "string" },
                  actionId: { type: "integer" },
                },
                required: ["tool", "actionId"],
                additionalProperties: false,
              },
            },
          ],
        });
      }
      if (message.method === "tools/call") {
        const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
        if (!params || typeof params.name !== "string" ||
            (params.arguments !== undefined &&
             (typeof params.arguments !== "object" || params.arguments === null || Array.isArray(params.arguments)))) {
          return mcpError(message.id, -32602, "Invalid tool arguments");
        }
        let result: CodingSessionToolResult;
        if (params.name === "workshop_action_result") {
          const args = params.arguments as { tool?: unknown; actionId?: unknown } | undefined;
          if (typeof args?.tool !== "string" || !Number.isInteger(args.actionId)) {
            return mcpError(message.id, -32602, "tool and actionId are required");
          }
          result = await policy.toolHost.getActionResult(
            policy.sessionId, args.tool, args.actionId as number) as unknown as CodingSessionToolResult;
        } else {
          result = await policy.toolHost.callTool(
            policy.sessionId, params.name,
            params.arguments as Record<string, unknown> | undefined) as unknown as CodingSessionToolResult;
        }
        if (result.pendingActionId !== undefined) {
          result.content = [{
            type: "text",
            text: `This action is awaiting Workshop approval. After it is resolved, call ` +
              `workshop_action_result with tool=${JSON.stringify(params.name)} and ` +
              `actionId=${result.pendingActionId}. Do not repeat the original action.`,
          }];
        }
        return mcpResult(message.id, result);
      }
      return mcpError(message.id, -32601, "Method not found");
    } catch (error) {
      return mcpError(message.id, -32603, boundedError(error));
    }
  }

  #policy(): SessionPolicy {
    const policy = this.ctx.storage.kv.get<SessionPolicy>("policy");
    if (!policy) throw new Error("Coding session policy has not been configured.");
    return policy;
  }

  async #installationToken(repositories: CodingSessionRepository[]): Promise<string> {
    const cached = this.ctx.storage.kv.get<{ token: string; expiresAt: number }>("githubToken");
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const appId = required(this.env.GITHUB_APP_ID, "GITHUB_APP_ID");
    const installationId = required(this.env.GITHUB_APP_INSTALLATION_ID, "GITHUB_APP_INSTALLATION_ID");
    const jwt = await githubAppJwt(appId, required(this.env.GITHUB_APP_PRIVATE_KEY,
      "GITHUB_APP_PRIVATE_KEY"));
    const response = await fetch(`${GITHUB_API_ORIGIN}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "user-agent": "odie-os-coding-sessions",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        repositories,
        permissions: { contents: "write", metadata: "read" },
      }),
    });
    if (!response.ok) throw new Error(`GitHub installation token failed (${response.status}).`);
    const result = await response.json() as { token?: string; expires_at?: string };
    if (!result.token || !result.expires_at) throw new Error("GitHub returned an invalid installation token.");
    this.ctx.storage.kv.put("githubToken", {
      token: result.token,
      expiresAt: new Date(result.expires_at).valueOf(),
    });
    return result.token;
  }
}

/** Per-user registry for coding-session lifecycle and terminal metadata. */
export class CodingSessionRegistry extends DurableObject<Env> {
  /** Lists this user's sessions newest first. */
  listSessions(): CodingSessionSummary[] {
    return [...this.#records()].map(({ sandboxId: _sandboxId, terminalId: _terminalId, ...summary }) => summary)
      .toSorted((a, b) => b.createdAt.valueOf() - a.createdAt.valueOf());
  }

  /** Creates and initializes one multi-repository coding session. */
  async createSession(
    owner: CodingSessionOwner,
    request: CreateCodingSessionRequest,
    toolHost: Fetcher<CodingSessionToolHost>,
  ): Promise<CodingSessionSummary> {
    const repositories = validateRepositories(request.repositories);
    if ([...this.#records()].filter(record =>
      !record.archivedAt && ["starting", "running", "stopping"].includes(record.status)).length >= MAX_SESSIONS_PER_USER) {
      throw new Error(`A user may have at most ${MAX_SESSIONS_PER_USER} active coding sessions.`);
    }
    const title = request.title.trim();
    if (!title || title.length > MAX_TITLE_LENGTH) {
      throw new Error(`Session title must be between 1 and ${MAX_TITLE_LENGTH} characters.`);
    }

    const id = crypto.randomUUID();
    const now = new Date();
    let record: SessionRecord = {
      id,
      title,
      repositories,
      status: "starting",
      createdAt: now,
      lastActiveAt: now,
      sandboxId: id,
    };
    this.#put(record);
    const policy = policyFor(this.env, id);
    await policy.configure({ sessionId: id, owner, repositories, toolHost });

    try {
      const sandbox = getSandbox(this.env.SESSION_SANDBOX, id);
      const token = await policy.getInstallationToken();
      await sandbox.configureGitHubAuth(token);
      await sandbox.destroy();
      for (const repository of repositories) {
        await sandbox.checkoutRepository(repository);
      }
      const terminal = await sandbox.createTerminal({
        command: ["/bin/bash", "-lc", `cd /workspace/${repositories[0]} && exec opencode`],
        cwd: `/workspace/${repositories[0]}`,
        env: opencodeEnvironment(this.env),
        cols: 120,
        rows: 40,
        bufferSize: 1024 * 1024,
      });
      record = { ...record, status: "running", terminalId: terminal.id, lastActiveAt: new Date() };
      this.#put(record);
      logger.info("coding session started", {
        event: "coding.session.started",
        sessionId: id,
        userId: owner.userId,
        repositoryCount: repositories.length,
      });
    } catch (error) {
      record = { ...record, status: "failed", error: boundedError(error), lastActiveAt: new Date() };
      this.#put(record);
      logger.error("coding session failed to start", {
        event: "coding.session.start.failed", sessionId: id, userId: owner.userId, error,
      });
    }
    return publicSummary(record);
  }

  /** Stops and destroys a session owned by this registry. */
  async stopSession(sessionId: string): Promise<void> {
    const record = this.#get(sessionId);
    if (!record || record.status === "stopped") return;
    this.#put({ ...record, status: "stopping", lastActiveAt: new Date() });
    await getSandbox(this.env.SESSION_SANDBOX, record.sandboxId).destroy();
    this.#put({ ...record, status: "stopped", terminalId: undefined, lastActiveAt: new Date() });
  }

  /** Stops and hides a session from the default session list. */
  async archiveSession(sessionId: string): Promise<void> {
    const record = this.#get(sessionId);
    if (!record || record.archivedAt) return;
    if (record.status !== "stopped") await this.stopSession(sessionId);
    const stopped = this.#get(sessionId) ?? record;
    this.#put({ ...stopped, status: "stopped", terminalId: undefined, archivedAt: new Date(), lastActiveAt: new Date() });
  }

  /** Mints one single-use terminal attachment URL. */
  async mintAttachCapability(sessionId: string): Promise<CodingSessionAttachCapability> {
    const record = this.#get(sessionId);
    if (!record || record.status !== "running" || !record.terminalId) {
      throw new Error("Coding session is not running.");
    }
    const token = randomToken();
    const expiresAt = new Date(Date.now() + ATTACH_TTL_MS);
    await (await ticketFor(this.env, token)).storeTicket({
      sandboxId: record.sandboxId,
      terminalId: record.terminalId,
      expiresAt: expiresAt.valueOf(),
    });
    this.#put({ ...record, lastActiveAt: new Date() });
    const baseUrl = this.env.BASE_URL?.replace(/\/$/, "") ?? "/gatekeeper/sessions";
    return { url: `${baseUrl}/attach/${token}`, expiresAt };
  }

  *#records(): Generator<SessionRecord> {
    for (const [, record] of this.ctx.storage.kv.list<SessionRecord>({ prefix: "session:" })) yield record;
  }

  #get(id: string): SessionRecord | undefined {
    return this.ctx.storage.kv.get<SessionRecord>(`session:${id}`);
  }

  #put(record: SessionRecord): void {
    this.ctx.storage.kv.put(`session:${record.id}`, record);
  }
}

/** Private control-plane entrypoint called by the authenticated Workshop backend. */
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements CodingSessionsService {
  /** Deliberately fails connector discovery because Sessions is a Workshop feature, not a connector. */
  async describe(): Promise<VendorDescription> {
    throw new Error("Coding Sessions is an internal Workshop service, not a connector.");
  }

  /** Lists sessions for the supplied authenticated owner. */
  listSessions(owner: CodingSessionOwner): Promise<CodingSessionSummary[]> {
    return registryFor(this.ctx, owner.userId).listSessions();
  }

  /** Creates a session for the supplied authenticated owner. */
  createSession(
    owner: CodingSessionOwner,
    request: CreateCodingSessionRequest,
    toolHost: Fetcher<CodingSessionToolHost>,
  ): Promise<CodingSessionSummary> {
    return registryFor(this.ctx, owner.userId).createSession(owner, request, toolHost);
  }

  /** Stops a session for the supplied authenticated owner. */
  stopSession(owner: CodingSessionOwner, sessionId: string): Promise<void> {
    return registryFor(this.ctx, owner.userId).stopSession(sessionId);
  }

  /** Stops and archives a session for the supplied authenticated owner. */
  archiveSession(owner: CodingSessionOwner, sessionId: string): Promise<void> {
    return registryFor(this.ctx, owner.userId).archiveSession(sessionId);
  }

  /** Mints a terminal capability for the supplied authenticated owner. */
  mintAttachCapability(owner: CodingSessionOwner, sessionId: string): Promise<CodingSessionAttachCapability> {
    return registryFor(this.ctx, owner.userId).mintAttachCapability(sessionId);
  }
}

async function handleHttp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/gatekeeper\/sessions\/attach\/([^/]+)$/.exec(url.pathname);
  if (!match) return new Response("Not found", { status: 404 });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", { status: 426 });
  }
  const expectedOrigin = env.SESSION_ALLOWED_ORIGIN ?? (env.BASE_URL ? new URL(env.BASE_URL).origin : url.origin);
  if (request.headers.get("Origin") !== expectedOrigin) {
    return new Response("Origin is not allowed", { status: 403 });
  }

  const ticket = await (await ticketFor(env, match[1])).consumeTicket(Date.now());
  if (!ticket) return new Response("Attachment capability is invalid or expired", { status: 403 });
  const terminal = await getSandbox(env.SESSION_SANDBOX, ticket.sandboxId).getTerminal(ticket.terminalId);
  if (!terminal) return new Response("Terminal is no longer available", { status: 410 });
  return terminal.connect(request, { cols: 120, rows: 40 });
}

export default { fetch: handleHttp };

function registryFor(ctx: ExecutionContext, userId: string): DurableObjectStub<CodingSessionRegistry> {
  const namespace = (ctx as ExecutionContext & {
    exports: { CodingSessionRegistry: DurableObjectNamespace<CodingSessionRegistry> };
  }).exports.CodingSessionRegistry;
  return namespace.get(namespace.idFromName(userId));
}

function policyFor(env: Env, sandboxId: string): DurableObjectStub<CodingSessionPolicy> {
  return env.SESSION_POLICIES.get(env.SESSION_POLICIES.idFromName(`session:${sandboxId}`));
}

async function ticketFor(env: Env, token: string): Promise<DurableObjectStub<CodingSessionPolicy>> {
  const digest = await sha256Hex(new TextEncoder().encode(token));
  return env.SESSION_POLICIES.get(env.SESSION_POLICIES.idFromName(`ticket:${digest}`));
}

function publicSummary(record: SessionRecord): CodingSessionSummary {
  const { sandboxId: _sandboxId, terminalId: _terminalId, ...summary } = record;
  return summary;
}

function opencodeEnvironment(env: Env): Record<string, string> {
  const baseUrl = env.TEAM_PI_CODEX_BASE_URL;
  if (!baseUrl) return {};
  return {
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "openai/gpt-5.6-sol",
      small_model: "openai/gpt-5.6-sol",
      share: "disabled",
      provider: {
        openai: {
          options: { baseURL: new URL("codex", ensureTrailingSlash(baseUrl)).toString(), apiKey: "synthetic" },
          whitelist: ["gpt-5.6-sol"],
        },
      },
      mcp: {
        workshop: {
          type: "remote",
          url: `https://${WORKSHOP_MCP_HOST}/mcp`,
          oauth: false,
          enabled: true,
          timeout: 15_000,
        },
      },
    }),
  };
}

function mcpResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result }, {
    headers: { "MCP-Protocol-Version": "2025-03-26" },
  });
}

function mcpError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, {
    headers: { "MCP-Protocol-Version": "2025-03-26" },
  });
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64Url(bytes);
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

function publicReadOnlyRequest(request: Request): Promise<Response> | Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Package registry request method is not allowed.", { status: 405 });
  }
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  return fetch(new Request(request, { headers, redirect: "manual" }));
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function githubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({ iat: now - 60, exp: now + 9 * 60, iss: appId });
  const input = `${header}.${payload}`;
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function base64UrlJson(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function pemBytes(value: string): ArrayBuffer {
  const base64 = value.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  return base64ToBytes(base64).buffer;
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
