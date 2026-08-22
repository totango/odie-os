import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { zstdDecompressSync } from "node:zlib";
import { ContainerProxy, Sandbox, getSandbox, type Terminal } from "@cloudflare/sandbox";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import { validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  type CodingSessionAttachCapability,
  type CodingSessionRepository,
  type CodingSessionRuntime,
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
import {
  assertRuntimeEnabled,
  codingSessionRuntime,
  openCodeCommand,
  PI_CONFIG_DIR,
  PI_EXTENSION_PATH,
  piCommand,
  piEnvironment,
  piExtensionSource,
} from "./runtime.js";

export { ContainerProxy };

const ATTACH_TTL_MS = 60_000;
const MAX_SESSIONS_PER_USER = 5;
const MAX_TITLE_LENGTH = 120;
const GITHUB_ORIGIN = "https://github.com";
const OPENCODE_CONFIG_DIR = "/workspace/.odie-opencode";
const STARTUP_ALARM_DELAY_MS = 1_000;
const STARTUP_MAX_ATTEMPTS = 3;
const STARTUP_CLONE_CONCURRENCY = 2;

type SessionsLogFields = {
  sessionId?: string;
  userId?: string;
  repositoryCount?: number;
  startupDurationMs?: number;
  mcpMethod?: string;
  status?: number;
  phase?: string;
  terminalKind?: CodingSessionTerminalKind;
  reason?: string;
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
  CODING_SESSION_PI_RUNTIME_ENABLED?: string;
}

type SessionRecord = Omit<CodingSessionSummary, "runtime"> & {
  runtime?: CodingSessionRuntime;
  sandboxId: string;
  terminalId?: string;
  shellTerminalId?: string;
};

type AttachTicket = {
  sandboxId: string;
  terminalId: string;
  userId: string;
  sessionId: string;
  terminalKind: CodingSessionTerminalKind;
  expiresAt: number;
};

type SessionPolicy = {
  sessionId: string;
  sandboxId?: string;
  runtime?: CodingSessionRuntime;
  owner: CodingSessionOwner;
  repositories: CodingSessionRepository[];
};

type StartupPhase = "authorize" | "clone" | "materialize" | "terminal";

type StartupRecord = {
  phase: StartupPhase;
  nextRepositoryIndex: number;
  completedRepositoryIndexes?: number[];
  cloneProcesses?: Array<{ repositoryIndex: number; processId: string }>;
  failureError?: string;
  attempt: number;
  createdAt: number;
  updatedAt: number;
};

type StartupProcess = {
  id: string;
  kill(signal?: number): Promise<void>;
  waitForExit(options?: { timeout?: number }): Promise<{ code: number; timedOut?: boolean }>;
  status(): Promise<
    | { state: "running" }
    | { state: "exited"; exit: { code: number; timedOut?: boolean } }
    | { state: "error" }
  >;
};

type StartupTerminalOptions = Parameters<InstanceType<typeof CodingSessionSandbox>["createTerminal"]>[0];

type StartupSandbox = {
  configureGitHubAuth(token: string): Promise<void>;
  destroy(): Promise<void>;
  exec(command: string[], options?: { timeout?: number; cwd?: string; env?: Record<string, string> }): Promise<StartupProcess>;
  getProcess(id: string): Promise<StartupProcess | null>;
  createTerminal(options: StartupTerminalOptions): Promise<Terminal>;
  listTerminals(): Promise<Terminal[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, content: string): Promise<unknown>;
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
      // Policy DOs are keyed by container ID, so another sandbox generation must use another DO.
      if (existing.sandboxId && policy.sandboxId && existing.sandboxId !== policy.sandboxId) {
        throw new Error("Coding session policy is immutable.");
      }
      if (!existing.sandboxId && policy.sandboxId) {
        this.ctx.storage.kv.put("policy", { ...existing, sandboxId: policy.sandboxId });
      }
      return;
    }
    this.ctx.storage.kv.put("policy", policy);
  }

  /** Persists bounded startup progress and schedules the first asynchronous startup alarm. */
  async startSessionStartup(record: StartupRecord): Promise<void> {
    this.ctx.storage.kv.put("startup", record);
    try {
      await this.ctx.storage.setAlarm(Date.now() + 1);
    } catch (error) {
      this.ctx.storage.kv.delete("startup");
      throw error;
    }
  }

  /** Cancels asynchronous startup for the configured session generation. */
  async cancelSessionStartup(sessionId: string, sandboxId: string): Promise<void> {
    const policy = this.#policy();
    if (policy.sessionId !== sessionId || policy.sandboxId !== sandboxId) return;
    this.ctx.storage.kv.delete("startup");
    await this.ctx.storage.deleteAlarm();
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

  /** Dispatches isolated ticket expiry or bounded asynchronous session startup work. */
  async alarm(): Promise<void> {
    const startup = this.ctx.storage.kv.get<StartupRecord>("startup");
    if (startup) {
      await this.#advanceStartup(startup);
      return;
    }
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
      const sandboxId = required(policy.sandboxId, "Workshop MCP sandboxId");
      if (message.method === "initialize") {
        return mcpResult(message.id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "Workshop connections", version: "1.0.0" },
        });
      }
      if (message.method === "tools/list") {
        const tools = await this.env.WORKSHOP_TOOLS.listTools(
          policy.owner, policy.sessionId, sandboxId) as unknown as CodingSessionTool[];
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
            args.actionId as number, sandboxId) as unknown as CodingSessionToolResult;
        } else {
          result = await this.env.WORKSHOP_TOOLS.callTool(
            policy.owner, policy.sessionId, params.name,
            params.arguments as Record<string, unknown> | undefined, sandboxId) as unknown as CodingSessionToolResult;
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

  async #advanceStartup(startup: StartupRecord): Promise<void> {
    if (startup.failureError !== undefined) {
      await this.#finalizeStartupFailure(startup, startup.failureError);
      return;
    }
    try {
      await this.#advanceStartupOnce(startup);
    } catch (error) {
      const current = this.ctx.storage.kv.get<StartupRecord>("startup");
      const policy = this.#policy();
      if (!current) return;
      if (current.failureError !== undefined) {
        await this.#finalizeStartupFailure(current, current.failureError);
        return;
      }
      if (current.attempt + 1 < STARTUP_MAX_ATTEMPTS) {
        if (current.phase === "clone") await this.#stopCloneProcesses(current);
        this.#putStartup({
          ...current,
          attempt: current.attempt + 1,
          ...(current.phase === "clone" ? { nextRepositoryIndex: 0, cloneProcesses: undefined } : {}),
        });
        await this.#scheduleStartup();
        logger.warn("coding session startup phase will retry", {
          event: "coding.session.startup.retry",
          sessionId: policy.sessionId,
          phase: startup.phase,
          error,
        });
        return;
      }
      const failed = { ...current, failureError: boundedError(error), updatedAt: Date.now() };
      this.#putStartup(failed);
      await this.#finalizeStartupFailure(failed, failed.failureError);
      logger.error("coding session startup failed", {
        event: "coding.session.startup.failed",
        sessionId: policy.sessionId,
        phase: startup.phase,
        error,
      });
    }
  }

  async #finalizeStartupFailure(startup: StartupRecord, error: string): Promise<void> {
    const policy = this.#policy();
    const sandboxId = required(policy.sandboxId, "startup sandboxId");
    if (startup.phase === "clone") {
      try {
        await this.#stopCloneProcesses(startup);
      } catch (stopError) {
        logger.warn("coding session startup clone cleanup failed", {
          event: "coding.session.startup.clone.cleanup.failed",
          sessionId: policy.sessionId,
          phase: startup.phase,
          error: stopError,
        });
      }
    }
    await this.#registry().startupFailed(policy.sessionId, sandboxId, error);
    await getSandbox(this.env.SESSION_SANDBOX, sandboxId).destroy();
    this.ctx.storage.kv.delete("startup");
  }

  async #advanceStartupOnce(startup: StartupRecord): Promise<void> {
    const policy = this.#policy();
    const sandboxId = required(policy.sandboxId, "startup sandboxId");
    const runtime = codingSessionRuntime(policy.runtime);
    const sandbox = getSandbox(this.env.SESSION_SANDBOX, sandboxId) as unknown as StartupSandbox;
    if (startup.phase === "authorize") {
      await this.env.WORKSHOP_TOOLS.prepareSessionStartup(policy.owner, policy.sessionId, policy.repositories);
      await sandbox.configureGitHubAuth(await this.#installationToken(policy.repositories));
      this.#putStartup({
        ...startup,
        phase: "clone",
        nextRepositoryIndex: 0,
        completedRepositoryIndexes: [],
        cloneProcesses: [],
        attempt: 0,
        updatedAt: Date.now(),
      });
      await this.#scheduleStartup(1);
      return;
    }

    if (startup.phase === "clone") {
      await this.#advanceClone(startup, policy.repositories);
      return;
    }

    if (startup.phase === "materialize") {
      const customization = await this.env.WORKSHOP_TOOLS.prepareSessionStartup(
        policy.owner, policy.sessionId, policy.repositories);
      if (runtime === "opencode") await materializeOpenCodeCustomization(sandbox, customization);
      else await materializePiRuntime(sandbox, this.env);
      this.#putStartup({ ...startup, phase: "terminal", attempt: 0, updatedAt: Date.now() });
      await this.#scheduleStartup(1);
      return;
    }

    const customization = await this.env.WORKSHOP_TOOLS.prepareSessionStartup(
      policy.owner, policy.sessionId, policy.repositories);
    const terminal = await this.#runningOrCreatedPrimaryTerminal(sandboxId, runtime, policy.repositories, customization);
    const applied = await this.#registry().startupSucceeded(policy.sessionId, sandboxId, terminal.id);
    if (!applied) await sandbox.destroy();
    this.ctx.storage.kv.delete("startup");
  }

  async #advanceClone(startup: StartupRecord, repositories: CodingSessionRepository[]): Promise<void> {
    const sandbox = getSandbox(this.env.SESSION_SANDBOX, required(this.#policy().sandboxId, "startup sandboxId")) as unknown as StartupSandbox;
    const completed = new Set(startup.completedRepositoryIndexes ?? []);
    const active: NonNullable<StartupRecord["cloneProcesses"]> = [];
    let nextRepositoryIndex = startup.nextRepositoryIndex;

    for (const clone of startup.cloneProcesses ?? []) {
      if (completed.has(clone.repositoryIndex)) continue;
      const repository = repositories[clone.repositoryIndex];
      if (!repository) throw new Error("Invalid repository clone checkpoint.");
      const process = await sandbox.getProcess(clone.processId);
      if (!process) {
        if (await repositoryReady(sandbox, repository)) {
          completed.add(clone.repositoryIndex);
          continue;
        }
        nextRepositoryIndex = Math.min(nextRepositoryIndex, clone.repositoryIndex);
        continue;
      }
      const status = await process.status();
      if (status.state === "running") {
        active.push(clone);
        continue;
      }
      if (status.state === "error" || status.exit.code !== 0 || !(await repositoryReady(sandbox, repository))) {
        throw new Error(`Failed to clone ${repository}.`);
      }
      completed.add(clone.repositoryIndex);
    }

    while (active.length < STARTUP_CLONE_CONCURRENCY && nextRepositoryIndex < repositories.length) {
      const repositoryIndex = nextRepositoryIndex++;
      if (completed.has(repositoryIndex) || active.some(clone => clone.repositoryIndex === repositoryIndex)) continue;
      const repository = repositories[repositoryIndex]!;
      if (await repositoryReady(sandbox, repository)) {
        completed.add(repositoryIndex);
        continue;
      }
      await waitForOk(await sandbox.exec(["rm", "-rf", `/workspace/${repository}`], { timeout: 30_000 }), 35_000);
      const process = await sandbox.exec([
        "git", "clone", "--depth=1", "--filter=blob:none",
        `${GITHUB_ORIGIN}/totango/${repository}.git`, `/workspace/${repository}`,
      ], { timeout: 120_000 });
      active.push({ repositoryIndex, processId: process.id });
    }

    if (completed.size >= repositories.length) {
      this.#putStartup({
        ...startup,
        phase: "materialize",
        nextRepositoryIndex: repositories.length,
        completedRepositoryIndexes: [...completed].toSorted((a, b) => a - b),
        cloneProcesses: undefined,
        attempt: 0,
        updatedAt: Date.now(),
      });
      await this.#scheduleStartup(1);
      return;
    }

    this.#putStartup({
      ...startup,
      nextRepositoryIndex,
      completedRepositoryIndexes: [...completed].toSorted((a, b) => a - b),
      cloneProcesses: active,
      updatedAt: Date.now(),
    });
    await this.#scheduleStartup();
  }

  async #runningOrCreatedPrimaryTerminal(
    sandboxId: string,
    runtime: CodingSessionRuntime,
    repositories: CodingSessionRepository[],
    customization: OpenCodeUserCustomization,
  ): Promise<Terminal> {
    const sandbox = getSandbox(this.env.SESSION_SANDBOX, sandboxId) as unknown as StartupSandbox;
    const options = primaryTerminalOptions(runtime, repositories[0]!, this.env, customization);
    const existing = await matchingRunningTerminals(sandbox, options.command, options.cwd);
    if (existing.length > 0) {
      for (const duplicate of existing.slice(1)) await duplicate.terminate();
      return existing[0]!;
    }
    return sandbox.createTerminal(options);
  }

  async #stopCloneProcesses(startup: StartupRecord): Promise<void> {
    const sandboxId = required(this.#policy().sandboxId, "startup sandboxId");
    const sandbox = getSandbox(this.env.SESSION_SANDBOX, sandboxId) as unknown as StartupSandbox;
    await Promise.allSettled((startup.cloneProcesses ?? []).map(async ({ processId }) => {
      const process = await sandbox.getProcess(processId);
      if (process) await process.kill(15);
    }));
  }

  #putStartup(startup: StartupRecord): void {
    this.ctx.storage.kv.put("startup", startup);
  }

  #scheduleStartup(delayMs = STARTUP_ALARM_DELAY_MS): Promise<void> {
    return this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  #registry(): DurableObjectStub<CodingSessionRegistry> {
    return registryFor(this.ctx as unknown as ExecutionContext, this.#policy().owner.userId);
  }
}

/** Per-user registry for coding-session lifecycle and terminal metadata. */
export class CodingSessionRegistry extends DurableObject<Env> {
  readonly #shellTerminalCreations = new Map<string, Promise<string>>();

  /** Lists this user's sessions newest first. */
  async listSessions(): Promise<CodingSessionSummary[]> {
    return [...this.#records()].map(publicSummary)
      .toSorted((a, b) => b.createdAt.valueOf() - a.createdAt.valueOf());
  }

  /** Retrieves and reconciles one non-archived session without exposing internal runtime handles. */
  async getSession(sessionId: string): Promise<CodingSessionSummary | undefined> {
    const record = this.#get(sessionId);
    if (!record || record.archivedAt) return undefined;
    if (record.status === "running") await this.#runningPrimaryTerminal(record);
    return publicSummary(this.#get(sessionId) ?? record);
  }

  /** Retrieves one non-archived session from persisted metadata without contacting its sandbox. */
  getSessionMetadata(sessionId: string): CodingSessionSummary | undefined {
    const record = this.#get(sessionId);
    return record && !record.archivedAt ? publicSummary(record) : undefined;
  }

  /** Returns whether persisted metadata still points at the supplied running sandbox generation. */
  isCurrentSessionGeneration(sessionId: string, sandboxId: string): boolean {
    const record = this.#get(sessionId);
    return !!record && !record.archivedAt && record.status === "running" && record.sandboxId === sandboxId;
  }

  /** Creates and initializes one multi-repository coding session. */
  async createSession(
    owner: CodingSessionOwner,
    request: CreateCodingSessionRequest,
    _customization?: OpenCodeUserCustomization,
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
    const runtime = codingSessionRuntime(request.runtime);
    assertRuntimeConfigured(this.env, runtime);

    const id = crypto.randomUUID();
    const now = new Date();
    let record: SessionRecord = {
      id,
      title,
      repositories,
      runtime,
      status: "starting",
      createdAt: now,
      lastActiveAt: now,
      sandboxId: id,
    };
    this.#put(record);

    try {
      await this.#scheduleStart(record, owner);
      logger.info("coding session startup scheduled", {
        event: "coding.session.start.scheduled",
        sessionId: id,
        userId: owner.userId,
        repositoryCount: repositories.length,
      });
    } catch (error) {
      record = { ...record, status: "failed", error: boundedError(error), lastActiveAt: new Date() };
      this.#put(record);
      logger.error("coding session startup could not be scheduled", {
        event: "coding.session.start.schedule.failed",
        sessionId: id,
        userId: owner.userId,
        error,
      });
    }
    return publicSummary(record);
  }

  /** Destroys and rebuilds one session from its authorized repositories. */
  async restartSession(
    sessionId: string,
    owner: CodingSessionOwner,
    _customization?: OpenCodeUserCustomization,
  ): Promise<CodingSessionSummary> {
    const record = this.#get(sessionId);
    if (!record || record.archivedAt) throw new Error("Coding session was not found.");
    if (record.status === "starting" || record.status === "stopping") {
      throw new Error("Coding session is already changing state.");
    }
    assertRuntimeConfigured(this.env, codingSessionRuntime(record.runtime));
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
      await this.#scheduleStart(starting, owner);
      return publicSummary(starting);
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
    const stopping: SessionRecord = { ...record, status: "stopping", lastActiveAt: new Date() };
    this.#put(stopping);
    if (record.status === "starting") {
      try {
        await policyForSandbox(this.env, record.sandboxId).cancelSessionStartup(record.id, record.sandboxId);
      } catch (error) {
        logger.warn("coding session startup cancellation failed", {
          event: "coding.session.startup.cancel.failed",
          sessionId,
          error,
        });
      }
    }
    try {
      await getSandbox(this.env.SESSION_SANDBOX, record.sandboxId).destroy();
    } catch (error) {
      const current = this.#get(sessionId);
      if (current?.sandboxId === record.sandboxId && current.status === "stopping") {
        this.#put({ ...stopping, status: "failed", error: boundedError(error), lastActiveAt: new Date() });
      }
      logger.error("coding session failed to stop", {
        event: "coding.session.stop.failed", sessionId, error,
      });
      throw error;
    }
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
    const sandbox = getSandbox(this.env.SESSION_SANDBOX, record.sandboxId);
    const primary = await this.#runningPrimaryTerminal(record);
    if (!primary) throw new Error("Coding session environment expired. Restart the session to continue.");
    await policyForSandbox(this.env, record.sandboxId).configure({
      sessionId: record.id,
      sandboxId: record.sandboxId,
      owner,
      repositories: record.repositories,
    });
    let terminalId = record.terminalId;
    if (terminal === "shell") {
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
    if (!current || current.status !== "running" ||
        current.sandboxId !== record.sandboxId || current.terminalId !== record.terminalId) {
      throw new Error("Coding session is not running.");
    }
    const updated = terminal === "shell" ? { ...current, shellTerminalId: terminalId } : current;
    const token = randomToken();
    const expiresAt = new Date(Date.now() + ATTACH_TTL_MS);
    await (await ticketFor(this.env, token)).storeTicket({
      sandboxId: record.sandboxId,
      terminalId,
      userId: owner.userId,
      sessionId: record.id,
      terminalKind: terminal,
      expiresAt: expiresAt.valueOf(),
    });
    const latest = this.#get(sessionId);
    if (!latest || latest.status !== "running" ||
        latest.sandboxId !== record.sandboxId || latest.terminalId !== record.terminalId) {
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

  /** Records that the persisted primary terminal can no longer serve this session. */
  markTerminalUnavailable(sessionId: string, sandboxId: string, terminalId: string | undefined, reason: string): void {
    const record = this.#get(sessionId);
    if (!record || record.sandboxId !== sandboxId ||
        terminalId !== undefined && record.terminalId !== terminalId || record.status !== "running") return;
    this.#put({
      ...record,
      status: "failed",
      terminalId: undefined,
      shellTerminalId: undefined,
      error: reason,
      lastActiveAt: new Date(),
    });
  }

  async #runningPrimaryTerminal(record: SessionRecord): Promise<Terminal | undefined> {
    const terminalId = record.terminalId;
    if (!terminalId) {
      this.markTerminalUnavailable(record.id, record.sandboxId, undefined, "Coding session environment expired. Restart the session to continue.");
      return undefined;
    }
    const terminal = await getSandbox(this.env.SESSION_SANDBOX, record.sandboxId).getTerminal(terminalId);
    if (!terminal) {
      this.markTerminalUnavailable(record.id, record.sandboxId, terminalId, "Coding session environment expired. Restart the session to continue.");
      return undefined;
    }
    const snapshot = await terminal.getSnapshot();
    if (snapshot.status !== "running") {
      this.markTerminalUnavailable(record.id, record.sandboxId, terminalId, "Coding session terminal exited. Restart the session to continue.");
      return undefined;
    }
    return terminal;
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

  async #scheduleStart(record: SessionRecord, owner: CodingSessionOwner): Promise<void> {
    const runtime = codingSessionRuntime(record.runtime);
    assertRuntimeConfigured(this.env, runtime);
    const policy = policyForSandbox(this.env, record.sandboxId);
    await policy.configure({
      sessionId: record.id,
      sandboxId: record.sandboxId,
      runtime,
      owner,
      repositories: record.repositories,
    });
    const now = Date.now();
    await policy.startSessionStartup({
      phase: "authorize",
      nextRepositoryIndex: 0,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Applies successful asynchronous startup only to the current starting generation. */
  async startupSucceeded(sessionId: string, sandboxId: string, terminalId: string): Promise<boolean> {
    const current = this.#get(sessionId);
    if (!current || current.archivedAt || current.sandboxId !== sandboxId || current.status !== "starting") return false;
    const running = { ...current, status: "running" as const, terminalId, lastActiveAt: new Date() };
    this.#put(running);
    logger.info("coding session environment ready", {
      event: "coding.session.environment.ready",
      sessionId,
      repositoryCount: current.repositories.length,
    });
    return true;
  }

  /** Applies asynchronous startup failure only to the current starting generation. */
  startupFailed(sessionId: string, sandboxId: string, error: string): boolean {
    const current = this.#get(sessionId);
    if (!current || current.archivedAt || current.sandboxId !== sandboxId || current.status !== "starting") return false;
    this.#put({
      ...current,
      status: "failed",
      terminalId: undefined,
      shellTerminalId: undefined,
      error,
      lastActiveAt: new Date(),
    });
    return true;
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

  /** Retrieves one session for the supplied authenticated owner. */
  getSession(owner: CodingSessionOwner, sessionId: string): Promise<CodingSessionSummary | undefined> {
    return registryFor(this.ctx, owner.userId).getSession(sessionId);
  }

  /** Retrieves one owned session from persisted metadata without contacting its sandbox. */
  getSessionMetadata(owner: CodingSessionOwner, sessionId: string): Promise<CodingSessionSummary | undefined> {
    return registryFor(this.ctx, owner.userId).getSessionMetadata(sessionId);
  }

  /** Checks persisted running session generation without contacting its sandbox. */
  isCurrentSessionGeneration(owner: CodingSessionOwner, sessionId: string, sandboxId: string): Promise<boolean> {
    return registryFor(this.ctx, owner.userId).isCurrentSessionGeneration(sessionId, sandboxId);
  }

  /** Creates a session for the supplied authenticated owner. */
  createSession(
    owner: CodingSessionOwner,
    request: CreateCodingSessionRequest,
    customization?: OpenCodeUserCustomization,
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
    customization?: OpenCodeUserCustomization,
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

async function handleHttp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor && cursor.length > 1024) return new Response("Invalid terminal cursor", { status: 400 });

  const ticket = await (await ticketFor(env, match[1])).consumeTicket(Date.now());
  if (!ticket) {
    logger.warn("coding session terminal attach rejected", {
      event: "coding.session.terminal.attach.rejected",
      status: 403,
      reason: "invalid_ticket",
    });
    return new Response("Attachment capability is invalid or expired", { status: 403 });
  }
  try {
    const terminal = await getSandbox(env.SESSION_SANDBOX, ticket.sandboxId).getTerminal(ticket.terminalId);
    if (!terminal) {
      if (ticket.terminalKind === "opencode") {
        await registryFor(ctx, ticket.userId).markTerminalUnavailable(ticket.sessionId, ticket.sandboxId, ticket.terminalId, "Coding session environment expired. Restart the session to continue.");
      }
      logger.warn("coding session terminal attach failed", {
        event: "coding.session.terminal.attach.failed",
        sessionId: ticket.sessionId,
        terminalKind: ticket.terminalKind,
        status: 410,
        reason: "terminal_missing",
      });
      return new Response("Terminal is no longer available", { status: 410 });
    }
    const snapshot = await terminal.getSnapshot();
    if (snapshot.status !== "running") {
      if (ticket.terminalKind === "opencode") {
        await registryFor(ctx, ticket.userId).markTerminalUnavailable(ticket.sessionId, ticket.sandboxId, ticket.terminalId, "Coding session terminal exited. Restart the session to continue.");
      }
      logger.warn("coding session terminal attach failed", {
        event: "coding.session.terminal.attach.failed",
        sessionId: ticket.sessionId,
        terminalKind: ticket.terminalKind,
        status: 410,
        reason: `terminal_${snapshot.status}`,
      });
      return new Response("Terminal is no longer available", { status: 410 });
    }
    logger.debug("coding session terminal attaching", {
      event: "coding.session.terminal.attach",
      sessionId: ticket.sessionId,
      terminalKind: ticket.terminalKind,
    });
    return terminal.connect(request, { cursor, cols: 120, rows: 40 });
  } catch (error) {
    logger.error("coding session terminal attach failed", {
      event: "coding.session.terminal.attach.failed",
      sessionId: ticket.sessionId,
      terminalKind: ticket.terminalKind,
      error,
    });
    return new Response("Terminal connection failed", { status: 502 });
  }
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
  return { ...summary, runtime: codingSessionRuntime(record.runtime) };
}

function primaryTerminalOptions(
  runtime: CodingSessionRuntime,
  repository: CodingSessionRepository,
  env: Env,
  customization: OpenCodeUserCustomization,
): StartupTerminalOptions {
  return {
    command: runtime === "opencode" ? openCodeCommand(repository) : piCommand(),
    cwd: `/workspace/${repository}`,
    env: runtime === "opencode" ? opencodeEnvironment(env, customization) : piEnvironment(),
    cols: 120,
    rows: 40,
    bufferSize: 1024 * 1024,
  };
}

async function repositoryReady(
  sandbox: Pick<StartupSandbox, "exec">,
  repository: CodingSessionRepository,
): Promise<boolean> {
  try {
    const check = await sandbox.exec([
      "git", "-C", `/workspace/${repository}`, "rev-parse", "--verify", "HEAD",
    ], { timeout: 10_000 });
    const exit = await check.waitForExit({ timeout: 15_000 });
    return exit.code === 0 && !exit.timedOut;
  } catch {
    return false;
  }
}

async function waitForOk(process: StartupProcess, timeout: number): Promise<void> {
  const exit = await process.waitForExit({ timeout });
  if (exit.code !== 0 || exit.timedOut) throw new Error("Startup command failed.");
}

async function matchingRunningTerminals(
  sandbox: Pick<StartupSandbox, "listTerminals">,
  command: readonly string[],
  cwd: string | undefined,
): Promise<Terminal[]> {
  const terminals = await sandbox.listTerminals();
  const result: Terminal[] = [];
  for (const terminal of terminals) {
    const snapshot = await terminal.getSnapshot();
    if (snapshot.status === "running" && snapshot.cwd === cwd && arraysEqual(snapshot.command, command)) {
      result.push(terminal);
    }
  }
  return result;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertRuntimeConfigured(env: Env, runtime: CodingSessionRuntime): void {
  assertRuntimeEnabled(runtime, env.CODING_SESSION_PI_RUNTIME_ENABLED);
  if (runtime !== "pi") return;
  required(env.TEAM_PI_CODEX_BASE_URL, "TEAM_PI_CODEX_BASE_URL");
  required(env.TEAM_PI_CODEX_HMAC_SECRET, "TEAM_PI_CODEX_HMAC_SECRET");
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

async function materializePiRuntime(
  sandbox: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
    writeFile(path: string, content: string): Promise<unknown>;
  },
  env: Env,
): Promise<void> {
  const baseUrl = required(env.TEAM_PI_CODEX_BASE_URL, "TEAM_PI_CODEX_BASE_URL");
  await sandbox.mkdir(PI_CONFIG_DIR, { recursive: true });
  await sandbox.writeFile(PI_EXTENSION_PATH, piExtensionSource(baseUrl));
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
