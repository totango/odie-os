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
  type CodingSessionTerminalKind,
  type CreateCodingSessionRequest,
  type OpenCodeUserCustomization,
} from "@gadgets/workshop-shared/api";
import {
  type CodingSessionOwner,
  type CodingSessionTool,
  type CodingSessionToolHost,
  type CodingSessionToolResult,
  type CodingSessionsService,
} from "@gadgets/workshop-shared/coding-sessions";
import type { VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  mintGitHubCodingSessionToken,
  type GitHubAppEnv,
  type GitHubInstallationToken,
} from "./github-app.js";
import {
  normalizeMcpToolInputSchema,
  WORKSHOP_MCP_HOST,
  validateWorkshopMcpRequestTarget,
} from "./mcp-policy.js";
import { validateRepositories } from "./policy.js";

export { ContainerProxy };

const ATTACH_TTL_MS = 60_000;
const MAX_SESSIONS_PER_USER = 5;
const MAX_TITLE_LENGTH = 120;
const GITHUB_ORIGIN = "https://github.com";
const OPENCODE_CONFIG_DIR = "/workspace/.odie-opencode";

type SessionsLogFields = {
  sessionId?: string;
  userId?: string;
  repositoryCount?: number;
  mcpMethod?: string;
  status?: number;
};

const logger = createLogger<SessionsLogFields>({ component: "gatekeeper.sessions" });

interface Env extends GitHubAppEnv {
  SESSION_SANDBOX: DurableObjectNamespace<CodingSessionSandbox>;
  SESSION_POLICIES: DurableObjectNamespace<CodingSessionPolicy>;
  WORKSHOP_TOOLS: Service<CodingSessionToolHost>;
  BASE_URL?: string;
  SESSION_ALLOWED_ORIGIN?: string;
  TEAM_PI_CODEX_BASE_URL?: string;
  TEAM_PI_CODEX_HMAC_SECRET?: string;
}

type SessionRecord = CodingSessionSummary & {
  sandboxId: string;
  terminalId?: string;
  shellTerminalId?: string;
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

// Assignment must invoke Container's inherited static setter, which installs these handlers in the
// registry used by ContainerProxy. A static class field would shadow the setter without registering.
CodingSessionSandbox.outboundByHost = {
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
    const response = await fetch(expected, { method: "POST", headers, body, redirect: "manual" });
    if (!response.ok) {
      logger.warn("Team PI Codex request rejected", {
        event: "coding.session.codex.rejected",
        sessionId: policy.sessionId,
        status: response.status,
      });
    }
    return response;
  }

  /** Terminates the session-scoped Workshop MCP protocol without exposing account credentials. */
  async handleWorkshopMcpRequest(request: Request): Promise<Response> {
    const rejectedTarget = validateWorkshopMcpRequestTarget(request);
    if (rejectedTarget) return rejectedTarget;
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
        const tools = await this.env.WORKSHOP_TOOLS.listTools(
          policy.owner, policy.sessionId) as unknown as CodingSessionTool[];
        return mcpResult(message.id, {
          tools: [
            ...tools.map(tool => ({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              inputSchema: normalizeMcpToolInputSchema(tool.inputSchema),
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
          result = await this.env.WORKSHOP_TOOLS.getActionResult(
            policy.owner, policy.sessionId, args.tool,
            args.actionId as number) as unknown as CodingSessionToolResult;
        } else {
          result = await this.env.WORKSHOP_TOOLS.callTool(
            policy.owner, policy.sessionId, params.name,
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
      logger.warn("Workshop MCP request failed", {
        event: "coding.session.mcp.failed",
        sessionId: policy.sessionId,
        mcpMethod: message.method.slice(0, 128),
        error,
      });
      return mcpError(message.id, -32603, boundedError(error));
    }
  }

  #policy(): SessionPolicy {
    const policy = this.ctx.storage.kv.get<SessionPolicy>("policy");
    if (!policy) throw new Error("Coding session policy has not been configured.");
    return policy;
  }

  async #installationToken(repositories: CodingSessionRepository[]): Promise<string> {
    const cached = this.ctx.storage.kv.get<GitHubInstallationToken>("githubToken");
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const result = await mintGitHubCodingSessionToken(this.env, repositories);
    this.ctx.storage.kv.put("githubToken", result);
    return result.token;
  }
}

/** Per-user registry for coding-session lifecycle and terminal metadata. */
export class CodingSessionRegistry extends DurableObject<Env> {
  readonly #shellTerminalCreations = new Map<string, Promise<string>>();

  /** Lists this user's sessions newest first. */
  listSessions(): CodingSessionSummary[] {
    return [...this.#records()].map(({
      sandboxId: _sandboxId,
      terminalId: _terminalId,
      shellTerminalId: _shellTerminalId,
      ...summary
    }) => summary)
      .toSorted((a, b) => b.createdAt.valueOf() - a.createdAt.valueOf());
  }

  /** Creates and initializes one multi-repository coding session. */
  async createSession(
    owner: CodingSessionOwner,
    request: CreateCodingSessionRequest,
    customization: OpenCodeUserCustomization,
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

    try {
      record = await this.#start(record, owner, customization);
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

  /** Destroys and rebuilds one session from its authorized repositories. */
  async restartSession(
    sessionId: string,
    owner: CodingSessionOwner,
    customization: OpenCodeUserCustomization,
  ): Promise<CodingSessionSummary> {
    const record = this.#get(sessionId);
    if (!record || record.archivedAt) throw new Error("Coding session was not found.");
    if (record.status === "starting" || record.status === "stopping") {
      throw new Error("Coding session is already changing state.");
    }
    const stopping: SessionRecord = {
      ...record,
      status: "stopping",
      error: undefined,
      terminalId: undefined,
      shellTerminalId: undefined,
      lastActiveAt: new Date(),
    };
    this.#put(stopping);
    let operation = stopping;
    try {
      await getSandbox(this.env.SESSION_SANDBOX, record.sandboxId).destroy();
      let current = this.#get(sessionId);
      if (current?.sandboxId !== record.sandboxId || current.status !== "stopping") {
        throw new Error("Coding session restart was cancelled.");
      }
      const starting: SessionRecord = {
        ...stopping,
        status: "starting",
        sandboxId: crypto.randomUUID(),
        lastActiveAt: new Date(),
      };
      this.#put(starting);
      operation = starting;
      return publicSummary(await this.#start(starting, owner, customization));
    } catch (error) {
      const current = this.#get(sessionId);
      if (current?.sandboxId !== operation.sandboxId || current.status !== operation.status) {
        return publicSummary(current ?? operation);
      }
      const failed = { ...operation, status: "failed" as const, error: boundedError(error), lastActiveAt: new Date() };
      this.#put(failed);
      logger.error("coding session failed to restart", {
        event: "coding.session.restart.failed", sessionId, userId: owner.userId, error,
      });
      return publicSummary(failed);
    }
  }

  /** Stops and destroys a session owned by this registry. */
  async stopSession(sessionId: string): Promise<void> {
    const record = this.#get(sessionId);
    if (!record || record.status === "stopped") return;
    this.#put({ ...record, status: "stopping", lastActiveAt: new Date() });
    await getSandbox(this.env.SESSION_SANDBOX, record.sandboxId).destroy();
    this.#put({
      ...record,
      status: "stopped",
      terminalId: undefined,
      shellTerminalId: undefined,
      lastActiveAt: new Date(),
    });
  }

  /** Stops and hides a session from the default session list. */
  async archiveSession(sessionId: string): Promise<void> {
    const record = this.#get(sessionId);
    if (!record || record.archivedAt) return;
    if (record.status !== "stopped") await this.stopSession(sessionId);
    const stopped = this.#get(sessionId) ?? record;
    this.#put({
      ...stopped,
      status: "stopped",
      terminalId: undefined,
      shellTerminalId: undefined,
      archivedAt: new Date(),
      lastActiveAt: new Date(),
    });
  }

  /** Mints one single-use terminal attachment URL. */
  async mintAttachCapability(
    owner: CodingSessionOwner,
    sessionId: string,
    terminal: CodingSessionTerminalKind = "opencode",
  ): Promise<CodingSessionAttachCapability> {
    const record = this.#get(sessionId);
    if (!record || record.status !== "running" || !record.terminalId) {
      throw new Error("Coding session is not running.");
    }
    if (terminal !== "opencode" && terminal !== "shell") throw new Error("Invalid terminal type.");
    await policyForSandbox(this.env, record.sandboxId).configure({
      sessionId: record.id,
      owner,
      repositories: record.repositories,
    });
    let terminalId = record.terminalId;
    if (terminal === "shell") {
      const sandbox = getSandbox(this.env.SESSION_SANDBOX, record.sandboxId);
      let shell = record.shellTerminalId ? await sandbox.getTerminal(record.shellTerminalId) : undefined;
      if (!shell) {
        let creation = this.#shellTerminalCreations.get(sessionId);
        if (!creation) {
          creation = sandbox.createTerminal({
            command: ["/bin/bash", "-l"],
            cwd: `/workspace/${record.repositories[0]}`,
            cols: 120,
            rows: 40,
            bufferSize: 1024 * 1024,
          }).then(created => created.id);
          this.#shellTerminalCreations.set(sessionId, creation);
        }
        try {
          terminalId = await creation;
        } finally {
          if (this.#shellTerminalCreations.get(sessionId) === creation) {
            this.#shellTerminalCreations.delete(sessionId);
          }
        }
      } else {
        terminalId = shell.id;
      }
    }
    const current = this.#get(sessionId);
    if (!current || current.status !== "running" || !current.terminalId) {
      throw new Error("Coding session is not running.");
    }
    const updated = terminal === "shell" ? { ...current, shellTerminalId: terminalId } : current;
    const token = randomToken();
    const expiresAt = new Date(Date.now() + ATTACH_TTL_MS);
    await (await ticketFor(this.env, token)).storeTicket({
      sandboxId: record.sandboxId,
      terminalId,
      expiresAt: expiresAt.valueOf(),
    });
    const latest = this.#get(sessionId);
    if (!latest || latest.status !== "running" || !latest.terminalId) {
      throw new Error("Coding session is not running.");
    }
    this.#put({
      ...latest,
      ...(terminal === "shell" ? { shellTerminalId: updated.shellTerminalId } : {}),
      lastActiveAt: new Date(),
    });
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

  async #start(
    record: SessionRecord,
    owner: CodingSessionOwner,
    customization: OpenCodeUserCustomization,
  ): Promise<SessionRecord> {
    const policy = policyForSandbox(this.env, record.sandboxId);
    await policy.configure({ sessionId: record.id, owner, repositories: record.repositories });
    const sandbox = getSandbox(this.env.SESSION_SANDBOX, record.sandboxId);
    await sandbox.destroy();
    const token = await policy.getInstallationToken();
    await sandbox.configureGitHubAuth(token);
    for (const repository of record.repositories) await sandbox.checkoutRepository(repository);
    await materializeOpenCodeCustomization(sandbox, customization);
    const terminal = await sandbox.createTerminal({
      command: ["/bin/bash", "-lc", `cd /workspace/${record.repositories[0]} && exec opencode`],
      cwd: `/workspace/${record.repositories[0]}`,
      env: opencodeEnvironment(this.env, customization),
      cols: 120,
      rows: 40,
      bufferSize: 1024 * 1024,
    });
    const current = this.#get(record.id);
    if (!current || current.sandboxId !== record.sandboxId || current.status !== "starting") {
      await sandbox.destroy();
      throw new Error("Coding session startup was cancelled.");
    }
    const running = { ...record, status: "running" as const, terminalId: terminal.id, lastActiveAt: new Date() };
    this.#put(running);
    return running;
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
    customization: OpenCodeUserCustomization,
  ): Promise<CodingSessionSummary> {
    return registryFor(this.ctx, owner.userId).createSession(owner, request, customization);
  }

  /** Stops a session for the supplied authenticated owner. */
  stopSession(owner: CodingSessionOwner, sessionId: string): Promise<void> {
    return registryFor(this.ctx, owner.userId).stopSession(sessionId);
  }

  /** Rebuilds a session for the supplied authenticated owner. */
  restartSession(
    owner: CodingSessionOwner,
    sessionId: string,
    customization: OpenCodeUserCustomization,
  ): Promise<CodingSessionSummary> {
    return registryFor(this.ctx, owner.userId).restartSession(sessionId, owner, customization);
  }

  /** Stops and archives a session for the supplied authenticated owner. */
  archiveSession(owner: CodingSessionOwner, sessionId: string): Promise<void> {
    return registryFor(this.ctx, owner.userId).archiveSession(sessionId);
  }

  /** Mints a terminal capability for the supplied authenticated owner. */
  mintAttachCapability(
    owner: CodingSessionOwner,
    sessionId: string,
    terminal?: CodingSessionTerminalKind,
  ): Promise<CodingSessionAttachCapability> {
    return registryFor(this.ctx, owner.userId).mintAttachCapability(owner, sessionId, terminal);
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

function policyFor(env: Env, containerId: string): DurableObjectStub<CodingSessionPolicy> {
  return env.SESSION_POLICIES.get(env.SESSION_POLICIES.idFromName(`container:${containerId}`));
}

function policyForSandbox(env: Env, sandboxId: string): DurableObjectStub<CodingSessionPolicy> {
  return policyFor(env, env.SESSION_SANDBOX.idFromName(sandboxId).toString());
}

async function ticketFor(env: Env, token: string): Promise<DurableObjectStub<CodingSessionPolicy>> {
  const digest = await sha256Hex(new TextEncoder().encode(token));
  return env.SESSION_POLICIES.get(env.SESSION_POLICIES.idFromName(`ticket:${digest}`));
}

function publicSummary(record: SessionRecord): CodingSessionSummary {
  const {
    sandboxId: _sandboxId,
    terminalId: _terminalId,
    shellTerminalId: _shellTerminalId,
    ...summary
  } = record;
  return summary;
}

function opencodeEnvironment(env: Env, customization: OpenCodeUserCustomization): Record<string, string> {
  const baseUrl = env.TEAM_PI_CODEX_BASE_URL;
  if (!baseUrl) return {};
  return {
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_CONFIG_DIR,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "openai/gpt-5.6-sol",
      small_model: "openai/gpt-5.6-sol",
      share: "disabled",
      enabled_providers: ["openai"],
      provider: {
        openai: {
          name: "Team PI Codex",
          options: {
            baseURL: new URL("codex", ensureTrailingSlash(baseUrl)).toString(),
            apiKey: "synthetic",
          },
          models: {
            "gpt-5.6-sol": {
              name: "GPT 5.6 Sol",
              reasoning: true,
              temperature: false,
              tool_call: true,
              limit: { context: 1_050_000, output: 128_000 },
            },
          },
        },
      },
      mcp: {
        workshop: {
          type: "remote",
          url: `https://${WORKSHOP_MCP_HOST}/mcp`,
          oauth: false,
          enabled: true,
          timeout: 30_000,
        },
      },
      plugin: customization.plugins,
    }),
  };
}

async function materializeOpenCodeCustomization(
  sandbox: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
    writeFile(path: string, content: string): Promise<unknown>;
  },
  customization: OpenCodeUserCustomization,
): Promise<void> {
  await sandbox.mkdir(`${OPENCODE_CONFIG_DIR}/skills`, { recursive: true });
  for (const skill of customization.skills) {
    const skillDir = `${OPENCODE_CONFIG_DIR}/skills/${skill.name}`;
    await sandbox.mkdir(skillDir, { recursive: true });
    await sandbox.writeFile(`${skillDir}/SKILL.md`, openCodeSkillMarkdown(skill));
  }
}

function openCodeSkillMarkdown(skill: OpenCodeUserCustomization["skills"][number]): string {
  return `---\nname: ${yamlDoubleQuote(skill.name)}\ndescription: ${yamlDoubleQuote(skill.description)}\n---\n\n${skill.instructions}\n`;
}

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value).replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    `\\x${hex.slice(2)}`);
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

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
