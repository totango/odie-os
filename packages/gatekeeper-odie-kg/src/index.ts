import { RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  boundAgentCatalog,
  stripTrailingSlashes,
  type AccountDescription,
  type AgentCatalog,
  type AgentCatalogRequest,
  type AvatarImage,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ObservationAuthorizer,
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
import type { ConnectionAccount, McpConnection } from "@gadgets/mcp-shared/connection";
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
import type { ServerTrust } from "@gadgets/mcp-shared/tools";
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
  ODIE_KG_DISPLAY_NAME,
  ODIE_KG_OAUTH_SCOPE,
  ODIE_KG_SERVER_ID,
  VENDOR_ID,
} from "./config.js";

const logger = createLogger<McpLogFields>({
  component: "gatekeeper.odie-kg",
  vendorId: VENDOR_ID,
});

const ODIE_KG_ICON: AvatarImage = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
    "<path d='M48 32h56v56H48V32Zm104 0h56v56h-56V32ZM48 168h56v56H48v-56Zm104 0h56v56h-56v-56ZM104 56h48v8h-48v-8Zm20 32h8v80h-8V88Zm-20 104h48v8h-48v-8Z'/>" +
    "</svg>"),
};

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
      "Totango Knowledge Graph is not configured",
      "Ask an administrator to configure the Agentic Odie MCP endpoint.",
    ), 503);
  }
  let outcome: ConnectOutcome;
  try {
    outcome = await account.beginConnect(initiationNonce, odieKgServer(config));
  } catch (error) {
    logger.warn("Totango KG connect failed", { event: "connect.failed", error });
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
  /** Describes the deployment-configured Totango KG connection. */
  async describe(): Promise<VendorDescription> {
    const config = readOdieKgConfig(this.env);
    return {
      displayName: ODIE_KG_DISPLAY_NAME,
      url: "https://www.totango.com/",
      logo: ODIE_KG_ICON,
      color: "#5b4bdb",
      tagline: config ? "Connect your tenant's customer knowledge" : "Not configured",
      description:
        "Use tenant-scoped customer, account, CSM, product-usage, and internal Totango knowledge " +
        "as an always-available agent source after connecting once.",
      providesAuth: config !== null,
    };
  }

  /** Starts the per-user Agentic OAuth flow without accepting a caller-provided endpoint. */
  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    if (!readOdieKgConfig(this.env)) throw new Error("Totango Knowledge Graph is not configured.");
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

/** Durable per-user owner of Agentic OAuth credentials and MCP transport state. */
export class OdieKgAccount extends McpAccountBase<Env> {
  protected baseUrl(): string {
    return getBaseUrl(this.env);
  }

  protected log(): McpLog {
    return logger;
  }

  protected mintAccount(): Fetcher<GatekeeperUser> {
    const props: McpGatekeeperUserProps = { accountObjectId: this.ctx.id.toString() };
    return (this.ctx as unknown as ExportContext<unknown>).exports.OdieKgUser({ props });
  }

  protected override oauthScope(_server: ConnectedServer): string {
    return ODIE_KG_OAUTH_SCOPE;
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
      throw new Error("The Totango Knowledge Graph endpoint changed. Reconnect this account.");
    }
  }

  async getConnection(endpoint: string): Promise<McpConnection> {
    this.#assertCurrent(endpoint);
    return this.account.getConnection(endpoint);
  }

  async setMcpSessionId(
    endpoint: string,
    generation: number,
    sessionId: string | null,
  ): Promise<void> {
    this.#assertCurrent(endpoint);
    await this.account.setMcpSessionId(endpoint, generation, sessionId);
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
    const server = await this.#account().getServer();
    const configured = config && sameEndpoint(server.endpoint, config.endpoint);
    return {
      ...base,
      displayName: ODIE_KG_DISPLAY_NAME,
      avatar: ODIE_KG_ICON,
      singleton: configured ? {
        tsType: sessionTypeName(ODIE_KG_SERVER_ID, odieKgResourceUrl(config.endpoint)),
      } : undefined,
    };
  }

  /** Returns the owner-scoped fixed-read KG singleton class. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<unknown>>> {
    const config = readOdieKgConfig(this.env);
    if (!config) throw new Error("Totango Knowledge Graph is not configured.");
    const server = await this.#account().getServer();
    if (!sameEndpoint(server.endpoint, config.endpoint)) {
      throw new Error("The Totango Knowledge Graph endpoint changed. Reconnect this account.");
    }
    const props: OdieKgGatekeeperProps = {
      accountObjectId: this.ctx.props.accountObjectId,
      endpoint: config.endpoint,
      scope: odieKgToolScope(),
    };
    return (this.ctx as ExportContext<McpGatekeeperUserProps>).exports.OdieKgGatekeeper({ props });
  }

  /** This account is a singleton and exposes no separately grantable resources. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  /** Refuses attempts to mint URL-addressed facets from the singleton account. */
  getGatekeeperClassFor(_url: string): never {
    throw new Error("Totango Knowledge Graph is an ambient singleton, not a URL resource.");
  }

  /** This singleton has no resource configurator. */
  async startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Totango Knowledge Graph has no resource configurator.");
  }

  /** Returns the required verifier token; the singleton itself refuses every observer. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return (this.ctx as ExportContext<McpGatekeeperUserProps>).exports.OdieKgVerifier({});
  }
}

/** Opaque same-vendor verifier; owner-only facets never interrogate it. */
@validateRpc()
export class OdieKgVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

/** Owner-only facet exposing the exact customer/internal KG read surface. */
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

  /** Filters the remote catalog to the fixed KG reads and overrides remote annotations. */
  override async tools() {
    const configured = readOdieKgConfig(this.env)?.endpoint;
    if (!configured || !sameEndpoint(configured, this.ctx.props.endpoint)) {
      throw new Error("The Totango Knowledge Graph endpoint changed. Reconnect this account.");
    }
    return (await super.tools())
      .map(applyOdieKgToolPolicy)
      .filter(entry => entry !== null);
  }

  get serverName(): string {
    return ODIE_KG_DISPLAY_NAME;
  }

  /** Describes the ambient customer/internal knowledge binding. */
  async describe(): Promise<ResourceDescription> {
    const tools = await this.tools();
    return {
      url: this.resourceUrl,
      title: ODIE_KG_DISPLAY_NAME,
      snippet: `${tools.length} tenant-scoped customer and internal knowledge tools, all read-only.`,
      suggestedBindingName: "TOTANGO_KG",
      tsType: sessionTypeName(ODIE_KG_SERVER_ID, this.resourceUrl),
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
    request: AgentCatalogRequest,
    authorizer: RpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog> {
    const entries = (await this.tools()).map(entry => ({
      id: entry.tool.name,
      title: entry.tool.title ?? entry.tool.name,
      description: entry.tool.description?.split(/\r?\n/)[0] ?? "Totango KG read tool.",
    }));
    const catalog = boundAgentCatalog(entries, request);
    await authorizer.authorizeObservation({
      title: "Totango Knowledge Graph catalog",
      description: `Listed ${catalog.entries.length} tenant-scoped KG tool(s).`,
    });
    return catalog;
  }
}

/** Typed MCP session installed with one method per allowlisted KG tool. */
@validateRpc()
export class OdieKgSession extends McpSessionBase {}
