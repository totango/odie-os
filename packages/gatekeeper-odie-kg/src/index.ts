import { RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  boundAgentCatalog,
  stripTrailingSlashes,
  type AccountDescription,
  type ActionDescription,
  type ApprovalQueue,
  type AgentCatalog,
  type AvatarImage,
  type ConnectionHealthStatus,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type HookController,
  type HookDescription,
  type ObservationAuthorizer,
  type ObservationDescription,
  type ObservationDomainSharingPolicy,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { MCP_BASE_TYPES } from "@gadgets/mcp-shared/base-types";
import {
  McpAccountBase,
  type ConnectedServer,
  type ConnectOutcome,
} from "@gadgets/mcp-shared/account";
import { generateNonce } from "@gadgets/mcp-shared/connect-nonce";
import { type ConnectionAccount, type McpConnection } from "@gadgets/mcp-shared/connection";
import { McpFacetBase } from "@gadgets/mcp-shared/facet";
import {
  errorPageHtml,
  htmlResponse,
  INVALID_LINK_HTML,
  SELF_CLOSING_HTML,
} from "@gadgets/mcp-shared/html";
import { handleMcpHttpRequest } from "@gadgets/mcp-shared/http";
import type { McpLog, McpLogFields } from "@gadgets/mcp-shared/log";
import { generateSessionTypes, sessionTypeName } from "@gadgets/mcp-shared/schema-to-ts";
import { McpSessionBase } from "@gadgets/mcp-shared/session";
import { endpointTag, sameEndpoint, type ToolScope } from "@gadgets/mcp-shared/scope";
import { type ClassifiedTool, type ServerTrust } from "@gadgets/mcp-shared/tools";
import {
  McpGatekeeperUserBase,
  mcpGatekeeperUserContext,
  type McpGatekeeperUserProps,
} from "@gadgets/mcp-shared/user";
import { hostOf } from "@gadgets/mcp-shared/util";
import {
  applyOdieKgToolPolicy,
  odieKgResource,
  odieKgResourceUrl,
  odieKgServer,
  odieKgToolScope,
  readOdieKgConfig,
  ODIE_KG_ALLOWED_TOOLS,
  ODIE_KG_DISPLAY_NAME,
  ODIE_KG_OAUTH_SCOPE,
  ODIE_KG_SERVER_ID,
  VENDOR_ID,
} from "./config.js";

const logger = createLogger<McpLogFields>({
  component: "gatekeeper.odie-kg",
  vendorId: VENDOR_ID,
});

const TOTANGO_DOMAIN_SHARING_POLICY = {
  type: "verified-sso-email-domain",
  emailDomain: "totango.com",
} as const satisfies ObservationDomainSharingPolicy;

const ODIE_KG_ICON: AvatarImage = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
    "<path d='M48 32h56v56H48V32Zm104 0h56v56h-56V32ZM48 168h56v56H48v-56Zm104 0h56v56h-56v-56ZM104 56h48v8h-48v-8Zm20 32h8v80h-8V88Zm-20 104h48v8h-48v-8Z'/>" +
    "</svg>"),
};

const ODIE_MCP_SCOPE_VERSION = 2;
const ODIE_MCP_SCOPE_VERSION_KEY = "odieMcpScopeVersion";

type OdieKgGatekeeperProps = McpGatekeeperUserProps & {
  endpoint: string;
  scope: ToolScope;
};

type ExportContext<Props> = ExecutionContext<Props> & {
  exports: {
    OdieKgAccount: DurableObjectNamespace<OdieKgAccount>;
    OdieKgUser: (options: { props: McpGatekeeperUserProps }) => Fetcher<GatekeeperUser>;
    OdieKgGatekeeper: (options: { props: OdieKgGatekeeperProps }) =>
      DurableObjectClass<Gatekeeper<unknown>>;
    OdieKgVerifier: (options: object) => Fetcher<GatekeeperUserVerifier>;
  };
};

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(
    env.BASE_URL ?? "http://localhost:8787/gatekeeper/odie-kg",
  );
}

async function continueConnect(
  account: DurableObjectStub<OdieKgAccount>,
  initiationNonce: string,
  env: Env,
): Promise<Response> {
  const config = readOdieKgConfig(env);
  if (!config) {
    return htmlResponse(errorPageHtml(
      "ODIE MCP is not configured",
      "Ask an administrator to configure the Agentic Odie MCP endpoint.",
    ), 503);
  }
  let outcome: ConnectOutcome;
  try {
    outcome = await account.beginConnect(initiationNonce, odieKgServer(config));
  } catch (error) {
    logger.warn("ODIE MCP connect failed", { event: "connect.failed", error });
    return htmlResponse(errorPageHtml(
      "Could not connect",
      error instanceof Error ? error.message : String(error),
    ), 502);
  }
  if (outcome.kind === "invalid") return htmlResponse(INVALID_LINK_HTML, 400);
  if (outcome.kind === "redirect") return Response.redirect(outcome.url, 302);
  return htmlResponse(SELF_CLOSING_HTML);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const exports = (ctx as ExportContext<unknown>).exports;
    return handleMcpHttpRequest(request, {
      baseUrl: getBaseUrl(env),
      accountForId: id => exports.OdieKgAccount.get(exports.OdieKgAccount.idFromString(id)),
      log: logger,
      connect: async (req, account, nonce) => {
        if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
        return continueConnect(account, nonce, env);
      },
    });
  },
};

/** First-party connector that starts one tenant-bound OAuth account per user. */
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  /** Describes the deployment-configured ODIE MCP connection. */
  async describe(): Promise<VendorDescription> {
    const config = readOdieKgConfig(this.env);
    return {
      displayName: ODIE_KG_DISPLAY_NAME,
      url: "https://www.totango.com/",
      logo: ODIE_KG_ICON,
      color: "#5b4bdb",
      tagline: config ? "Connect your organization's customer context" : "Not configured",
      description:
        "Use organization-bound Knowledge Graph, customer context, interviews, skills, exports, " +
        "briefs, actions, and supported Leviosa public data.",
      providesAuth: config !== null,
    };
  }

  /** Starts the per-user Agentic OAuth flow without accepting a caller-provided endpoint. */
  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    if (!readOdieKgConfig(this.env)) throw new Error("ODIE MCP is not configured.");
    const exports = (this.ctx as ExportContext<unknown>).exports;
    const accountId = exports.OdieKgAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await exports.OdieKgAccount.get(accountId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${accountId.toString()}/${initiationNonce}` };
  }

  /** Returns one non-grantable resource so the connector is visible before account connection. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    const config = readOdieKgConfig(this.env);
    return config ? [odieKgResource(config)] : [];
  }

  /** Returns transport-neutral MCP base types; tool methods are generated on the singleton. */
  async getTypeScriptTypes(): Promise<string> {
    return MCP_BASE_TYPES;
  }
}

function missingOdieMcpTools(tools: ClassifiedTool[]): string[] {
  const available = new Set(tools.map(entry => entry.tool.name));
  return ODIE_KG_ALLOWED_TOOLS.filter(name => !available.has(name));
}

/** Durable per-user owner of Agentic OAuth credentials and MCP transport state. */
export class OdieKgAccount extends McpAccountBase<Env> {
  protected baseUrl(): string {
    return getBaseUrl(this.env);
  }

  protected log(): McpLog {
    return logger;
  }

  /** Invalidates the old scope grant before an endpoint repoint can begin. */
  override async beginConnect(
    initiationNonce: string,
    target: ConnectedServer | null,
  ): Promise<ConnectOutcome> {
    let existing: ConnectedServer | undefined;
    try {
      existing = this.requireServer();
    } catch {
      // A first connection has no prior scope grant to invalidate.
    }
    const repointing = existing !== undefined && target !== null && this.awaitingSelection(initiationNonce)
      && !sameEndpoint(existing.endpoint, target.endpoint);
    const previousScopeVersion = repointing
      ? this.ctx.storage.kv.get<number>(ODIE_MCP_SCOPE_VERSION_KEY)
      : undefined;
    if (repointing) {
      this.ctx.storage.kv.delete(ODIE_MCP_SCOPE_VERSION_KEY);
    }
    try {
      const outcome = await super.beginConnect(initiationNonce, target);
      if (repointing && outcome.kind === "invalid" && previousScopeVersion !== undefined) {
        this.ctx.storage.kv.put(ODIE_MCP_SCOPE_VERSION_KEY, previousScopeVersion);
      }
      return outcome;
    } catch (error) {
      let current: ConnectedServer | undefined;
      try {
        current = this.requireServer();
      } catch {
        // A failed first connection has no previous grant to restore.
      }
      if (repointing && existing && current && sameEndpoint(current.endpoint, existing.endpoint)
          && previousScopeVersion !== undefined) {
        this.ctx.storage.kv.put(ODIE_MCP_SCOPE_VERSION_KEY, previousScopeVersion);
      }
      throw error;
    }
  }

  protected mintAccount(): Fetcher<GatekeeperUser> {
    const props: McpGatekeeperUserProps = { accountObjectId: this.ctx.id.toString() };
    return (this.ctx as unknown as ExportContext<unknown>).exports.OdieKgUser({ props });
  }

  protected override oauthScope(_server: ConnectedServer): string {
    return ODIE_KG_OAUTH_SCOPE;
  }

  protected override connectionCompleted(server: ConnectedServer): void {
    const configured = readOdieKgConfig(this.env)?.endpoint;
    if (configured && sameEndpoint(server.endpoint, configured)) {
      this.ctx.storage.kv.put(ODIE_MCP_SCOPE_VERSION_KEY, ODIE_MCP_SCOPE_VERSION);
    }
  }

  /** Reports whether this account completed OAuth for the current ODIE MCP scope revision. */
  hasCurrentScopeGrant(): boolean {
    return this.ctx.storage.kv.get<number>(ODIE_MCP_SCOPE_VERSION_KEY) === ODIE_MCP_SCOPE_VERSION;
  }

  /** Verifies the durable endpoint and scope state used by required-connection checks. */
  async getConnectionStatus(): Promise<ConnectionHealthStatus> {
    const config = readOdieKgConfig(this.env);
    if (!config) return { state: "unavailable", message: "ODIE MCP is not configured." };
    try {
      const server = await this.getServer();
      if (!sameEndpoint(server.endpoint, config.endpoint)) {
        return {
          state: "unavailable",
          message: "The ODIE MCP endpoint changed. Reconnect this account.",
        };
      }
      if (!this.hasCurrentScopeGrant()) {
        return {
          state: "expired",
          message: "Reconnect ODIE MCP to authorize the expanded scopes.",
        };
      }

      return { state: "healthy", message: "ODIE MCP is connected for the current scopes." };
    } catch (error) {
      return classifyOdieKgStatusError(error);
    }
  }
}

/** Facet-side credential view that fails closed after a deployment endpoint repoint. */
export class OdieKgConnectionAccount implements ConnectionAccount {
  constructor(
    private readonly env: Env,
    private readonly account: DurableObjectStub<OdieKgAccount>,
    private readonly endpoint: string,
  ) {}

  #assertCurrent(endpoint: string): void {
    const configured = readOdieKgConfig(this.env)?.endpoint;
    if (!configured || !sameEndpoint(endpoint, this.endpoint) ||
        !sameEndpoint(configured, this.endpoint)) {
      throw new Error("The ODIE MCP endpoint changed. Reconnect this account.");
    }
  }

  async getConnection(endpoint: string): Promise<McpConnection> {
    this.#assertCurrent(endpoint);
    return this.account.getConnection(endpoint);
  }

  async assertConnectionCurrent(endpoint: string, generation: number): Promise<void> {
    this.#assertCurrent(endpoint);
    await this.account.assertConnectionCurrent(endpoint, generation);
  }

  async setMcpSessionId(
    endpoint: string,
    generation: number,
    previousSessionId: string | null,
    sessionId: string | null,
  ): Promise<boolean> {
    this.#assertCurrent(endpoint);
    return this.account.setMcpSessionId(endpoint, generation, previousSessionId, sessionId);
  }

  async noteCredentialsExpired(endpoint: string, generation: number): Promise<void> {
    this.#assertCurrent(endpoint);
    await this.account.noteCredentialsExpired(endpoint, generation);
  }
}

/** Connected user capability that contributes an ambient KG singleton to every workspace. */
@validateRpc()
export class OdieKgUser extends McpGatekeeperUserBase<Env> implements GatekeeperUser {
  #account(): DurableObjectStub<OdieKgAccount> {
    const exports = (this.ctx as ExportContext<McpGatekeeperUserProps>).exports;
    return exports.OdieKgAccount.get(
      exports.OdieKgAccount.idFromString(this.ctx.props.accountObjectId),
    );
  }

  protected [mcpGatekeeperUserContext]() {
    return { account: this.#account(), avatar: ODIE_KG_ICON, baseUrl: getBaseUrl(this.env) };
  }

  /** Describes the connected tenant identity and its owner-only ambient singleton. */
  override async describe(): Promise<AccountDescription> {
    const base = await super.describe();
    const config = readOdieKgConfig(this.env);
    const account = this.#account();
    const [server, hasCurrentScopeGrant] = await Promise.all([
      account.getServer(),
      account.hasCurrentScopeGrant(),
    ]);
    const configured = config && sameEndpoint(server.endpoint, config.endpoint) && hasCurrentScopeGrant;
    return {
      ...base,
      displayName: ODIE_KG_DISPLAY_NAME,
      avatar: ODIE_KG_ICON,
      singleton: configured ? {
        tsType: sessionTypeName(ODIE_KG_SERVER_ID, odieKgResourceUrl(config.endpoint)),
        revisionedAuthority: true,
      } : undefined,
    };
  }

  /** Returns the owner-scoped fixed-tool ODIE MCP singleton class. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<unknown>>> {
    return (await this.getSingletonGatekeeperAuthority()).class;
  }

  /** Returns the immutable facet revision for the current ODIE MCP scope. */
  async getSingletonGatekeeperAuthority(): Promise<{
    key: string;
    class: DurableObjectClass<Gatekeeper<unknown>>;
  }> {
    const config = readOdieKgConfig(this.env);
    if (!config) throw new Error("ODIE MCP is not configured.");
    const account = this.#account();
    const [server, hasCurrentScopeGrant] = await Promise.all([
      account.getServer(),
      account.hasCurrentScopeGrant(),
    ]);
    if (!sameEndpoint(server.endpoint, config.endpoint) || !hasCurrentScopeGrant) {
      throw new Error("Reconnect ODIE MCP to authorize the current endpoint and scopes.");
    }
    const props: OdieKgGatekeeperProps = {
      accountObjectId: this.ctx.props.accountObjectId,
      endpoint: config.endpoint,
      scope: odieKgToolScope(),
    };
    return {
      key: `odie-mcp-v${ODIE_MCP_SCOPE_VERSION}:${endpointTag(config.endpoint)}`,
      class: (this.ctx as ExportContext<McpGatekeeperUserProps>).exports.OdieKgGatekeeper({ props }),
    };
  }

  /** This account is a singleton and exposes no separately grantable resources. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  /** Returns the singleton class when an agent explicitly attaches the fixed account resource. */
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<unknown>>;
    resource: SupportedResource;
  }> {
    const config = readOdieKgConfig(this.env);
    if (!config || !sameEndpoint(url, config.endpoint)) {
      throw new Error("Unsupported ODIE MCP resource.");
    }
    return {
      class: (await this.getSingletonGatekeeperAuthority()).class,
      resource: odieKgResource(config),
    };
  }

  /** This singleton has no resource configurator. */
  async startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("ODIE MCP has no resource configurator.");
  }

  /** Returns the required verifier token for organization-scoped sharing. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return (this.ctx as ExportContext<McpGatekeeperUserProps>).exports.OdieKgVerifier({});
  }

  /** Delegates the required-connection health check to the account Durable Object. */
  async getConnectionStatus(): Promise<ConnectionHealthStatus> {
    return this.#account().getConnectionStatus();
  }
}

/** Opaque same-vendor verifier; Workshop enforces the Totango SSO domain before observer use. */
@validateRpc()
export class OdieKgVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

class DomainSharingApprovalQueue extends RpcTarget implements ApprovalQueue {
  constructor(private readonly inner: RpcStub<ApprovalQueue>, private readonly ownsInner = false) { super(); }
  dup(): RpcStub<ApprovalQueue> {
    return new DomainSharingApprovalQueue(this.inner.dup(), true) as unknown as RpcStub<ApprovalQueue>;
  }
  [Symbol.dispose](): void { if (this.ownsInner) this.inner[Symbol.dispose](); }
  async authorizeObservation(description: ObservationDescription): Promise<void> {
    await this.inner.authorizeObservation({
      ...description,
      domainSharingPolicy: description.domainSharingPolicy ?? TOTANGO_DOMAIN_SHARING_POLICY,
    });
  }
  getSessionSurface(): Promise<"chat" | "code"> { return this.inner.getSessionSurface(); }
  submitAction(action: number, description: ActionDescription): Promise<void> {
    return this.inner.submitAction(action, description);
  }
  bindHook<Hook extends RpcTarget>(
      _controller: Fetcher<HookController<Hook>>, _callback: RpcStub<Hook>,
      _description: HookDescription): Promise<void> {
    throw new Error("ODIE MCP sessions cannot register persistent hooks.");
  }
}

/** Organization-scoped facet exposing the exact ODIE MCP tool surface. */
export class OdieKgGatekeeper
  extends McpFacetBase<Env, OdieKgGatekeeperProps, OdieKgSession> {
  protected get log() {
    return logger.with({
      serverId: ODIE_KG_SERVER_ID,
      serverHost: hostOf(this.ctx.props.endpoint),
      trust: "vetted",
    });
  }

  protected get trust(): ServerTrust {
    return "vetted";
  }

  protected get sessionClass() {
    return OdieKgSession;
  }

  protected get actionScopeTag(): string {
    return `odie-kg:${endpointTag(this.ctx.props.endpoint)}`;
  }

  protected get observerName(): string {
    return ODIE_KG_DISPLAY_NAME;
  }

  protected account(): ConnectionAccount {
    const exports = (this.ctx as unknown as ExportContext<OdieKgGatekeeperProps>).exports;
    const account = exports.OdieKgAccount.get(
      exports.OdieKgAccount.idFromString(this.ctx.props.accountObjectId),
    );
    return new OdieKgConnectionAccount(this.env, account, this.ctx.props.endpoint);
  }

  /** Admit domain-policy collaborators; Workshop verifies @totango.com SSO before calling this. */
  override async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** Apply the Totango organization sharing policy to every ODIE MCP session observation. */
  override async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<OdieKgSession> {
    return await super.startSession(
        new DomainSharingApprovalQueue(approvalQueue) as unknown as RpcStub<ApprovalQueue>);
  }

  override async removeObserver(_id: string): Promise<void> {}

  /** Filters the cached remote catalog to fixed tools and overrides remote annotations. */
  override async tools() {
    const configured = readOdieKgConfig(this.env)?.endpoint;
    if (!configured || !sameEndpoint(configured, this.ctx.props.endpoint)) {
      throw new Error("The ODIE MCP endpoint changed. Reconnect this account.");
    }
    try {
      const tools = (await super.tools())
        .map(applyOdieKgToolPolicy)
        .filter(entry => entry !== null);
      const missingTools = missingOdieMcpTools(tools);
      if (missingTools.length > 0) {
        throw new Error(
          `ODIE MCP is missing ${missingTools.length} required tool(s). Reconnect the account.`,
        );
      }
      return tools;
    } catch (error) {
      const message = boundedErrorMessage(error);
      if (/reconnect the account|credential|authorization|401/i.test(message)) {
        throw new Error(
          "ODIE MCP credentials are stale or expired. Reconnect the account, " +
          "then try the TOTANGO_KG binding again.",
          { cause: error },
        );
      }
      if (/403|does not have access|refused/i.test(message)) {
        throw new Error(
          "ODIE MCP refused access. Ask an administrator to grant the connected account access " +
          "to the required scopes and tools.",
          { cause: error },
        );
      }
      throw new Error("Could not load the ODIE MCP tool catalog. Try again later.", {
        cause: error,
      });
    }
  }

  get serverName(): string {
    return ODIE_KG_DISPLAY_NAME;
  }

  /** Describes the ambient customer/internal knowledge binding. */
  async describe(): Promise<ResourceDescription> {
    let tools;
    try {
      tools = await this.tools();
    } catch (error) {
      const message = boundedErrorMessage(error);
      return {
        url: this.resourceUrl,
        title: ODIE_KG_DISPLAY_NAME,
        snippet: `Unavailable: ${message}`,
        suggestedBindingName: "TOTANGO_KG",
        tsType: sessionTypeName(ODIE_KG_SERVER_ID, this.resourceUrl),
        domainSharingPolicy: TOTANGO_DOMAIN_SHARING_POLICY,
      };
    }
    return {
      url: this.resourceUrl,
      title: ODIE_KG_DISPLAY_NAME,
      snippet: `${tools.length} organization-bound ODIE MCP tools with first-party actions enabled.`,
      suggestedBindingName: "TOTANGO_KG",
      tsType: sessionTypeName(ODIE_KG_SERVER_ID, this.resourceUrl),
      domainSharingPolicy: TOTANGO_DOMAIN_SHARING_POLICY,
    };
  }

  /** Generates exact typed methods for the allowlisted remote KG tools. */
  async getTypeScriptTypes(): Promise<string> {
    return generateSessionTypes({
      baseTypes: MCP_BASE_TYPES,
      serverId: ODIE_KG_SERVER_ID,
      serverName: ODIE_KG_DISPLAY_NAME,
      endpoint: this.ctx.props.endpoint,
      discriminator: this.resourceUrl,
      trust: "vetted",
      tools: await this.tools(),
    });
  }

  /** Returns a bounded discovery catalog for agent routing. */
  async getAgentCatalog(
    authorizer: RpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog> {
    let entries: AgentCatalog["entries"];
    let unavailable: string | undefined;
    try {
      entries = (await this.tools()).map(entry => ({
        id: entry.tool.name,
        title: entry.tool.title ?? entry.tool.name,
        description: entry.tool.description?.split(/\r?\n/)[0] ?? "ODIE MCP read tool.",
      }));
    } catch (error) {
      unavailable = classifyOdieKgStatusError(error).message
        ?? "ODIE MCP is unavailable. Try again or contact an administrator.";
      entries = [{
        id: "odie-mcp-unavailable",
        title: "ODIE MCP unavailable",
        description: unavailable,
      }];
    }
    const catalog = boundAgentCatalog(entries);
    await authorizer.authorizeObservation({
      title: unavailable ? "ODIE MCP unavailable" : "ODIE MCP catalog",
      description: unavailable ?? `Listed ${catalog.entries.length} organization-bound read tool(s).`,
      domainSharingPolicy: TOTANGO_DOMAIN_SHARING_POLICY,
    });
    return catalog;
  }
}

function boundedErrorMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  return message.length <= 512 ? message : `${message.slice(0, 509)}...`;
}

function classifyOdieKgStatusError(error: unknown): ConnectionHealthStatus {
  const message = boundedErrorMessage(error);
  if (/403|does not have access|tenant|unbound|declined|refused/i.test(message)) {
    return {
      state: "unavailable",
      message: "ODIE MCP is not authorized for this organization. Contact an administrator.",
    };
  }
  if (/401|credential|authorization|required authorization|reconnect the account/i.test(message)) {
    return { state: "expired", message: "Reconnect ODIE MCP to continue." };
  }
  return {
    state: "unavailable",
    message: "ODIE MCP is unavailable. Try again or contact an administrator.",
  };
}

/** Typed MCP session installed with one method per allowlisted KG tool. */
@validateRpc()
export class OdieKgSession extends McpSessionBase {}
