// JARVIS gatekeeper: an auto-provisioned ambient singleton backed by one deployment-configured MCP
// endpoint. It deliberately exposes only a fixed read/support allowlist and relies on
// @gadgets/mcp-shared for MCP cataloging, tool classification, sessions, and action handling.

import { RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import { boundAgentCatalog, type AccountDescription, type AgentCatalog, type AgentCatalogRequest, type AppUiContext, type AvatarImage, type Gatekeeper, type GatekeeperConnectCallback, type GatekeeperConnectOptions, type GatekeeperUiFrame, type GatekeeperUser, type GatekeeperUserVerifier, type GatekeeperVendor as GatekeeperVendorIface, type ObservationAuthorizer, type ResourceDescription, type SupportedResource, type VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { MCP_BASE_TYPES } from "@gadgets/mcp-shared/base-types";
import { McpFacetBase } from "@gadgets/mcp-shared/facet";
import type { McpLogFields } from "@gadgets/mcp-shared/log";
import { generateSessionTypes, sessionTypeName } from "@gadgets/mcp-shared/schema-to-ts";
import { McpSessionBase } from "@gadgets/mcp-shared/session";
import { endpointTag, formatToolScope, type ToolScope } from "@gadgets/mcp-shared/scope";
import type { ConnectionAccount, McpConnection } from "@gadgets/mcp-shared/connection";
import type { ServerTrust } from "@gadgets/mcp-shared/tools";
import { hostOf } from "@gadgets/mcp-shared/util";
import APP_HTML from "./generated/app.txt";
import {
  JarvisPolicy,
  JarvisPolicyApi,
  type JarvisToolPolicy,
} from "./policy.js";
import {
  applyJarvisToolPolicy,
  isJarvisAllowedTool,
  hasJarvisConfiguration,
  jarvisTokenFor,
  jarvisTrust,
  readJarvisConfig,
  JARVIS_ALLOWED_TOOLS,
  JARVIS_DISPLAY_NAME,
  JARVIS_SERVER_ID,
  VENDOR_ID,
} from "./config.js";

/** Logger fields emitted by the JARVIS gatekeeper. */
type JarvisLogFields = McpLogFields & {
  /** Redacted JARVIS endpoint host. */
  serverHost?: string;
};

const logger = createLogger<JarvisLogFields>({
  component: "gatekeeper.jarvis", vendorId: VENDOR_ID,
});

const JARVIS_ICON: AvatarImage = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
    "<path d='M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24Zm0 16a88 88 0 1 1-88 88 88.1 88.1 0 0 1 88-88Zm-40 72a16 16 0 1 1 16-16 16 16 0 0 1-16 16Zm80 0a16 16 0 1 1 16-16 16 16 0 0 1-16 16Zm-40 88c-25.9 0-47.7-15.5-56.8-40h17.4c7.8 14.8 22.5 24 39.4 24s31.6-9.2 39.4-24h17.4c-9.1 24.5-30.9 40-56.8 40Z'/>" +
    "</svg>"),
};

/** Props stored on an auto-provisioned JARVIS account capability. */
export type JarvisAccountProps = {
  /** Random per-account id used to give the singleton Durable Object stable owner-specific props. */
  accountId: string;
};

type JarvisGatekeeperProps = JarvisAccountProps & {
  endpoint: string;
  scope: ToolScope;
  // Optional only for facets minted before deployment-admin policy existed.
  chatScope?: ToolScope;
  codeScope?: ToolScope;
  policyRevision?: number;
  policyKey?: string;
};

type StoredConnectionState = {
  endpoint: string;
  generation: number;
  sessionId?: string;
};

type ExportContext<Props> = ExecutionContext<Props> & {
  exports: {
    JarvisAccount: (options: { props: JarvisAccountProps }) => Fetcher<GatekeeperUser>;
    JarvisGatekeeper: (options: { props: JarvisGatekeeperProps }) =>
      DurableObjectClass<Gatekeeper<unknown>>;
    JarvisVerifier: (options: object) => Fetcher<GatekeeperUserVerifier>;
    JarvisPolicy: DurableObjectNamespace<JarvisPolicy>;
  };
};

function policyObject(context: ExportContext<unknown>): DurableObjectStub<JarvisPolicy> {
  return context.exports.JarvisPolicy.getByName("global");
}

function policyKey(endpoint: string, policy: JarvisToolPolicy): string {
  return [
    "v2",
    endpointTag(endpoint),
    policy.revision,
    policy.chat.tools?.join(",") ?? "*",
    policy.code.tools?.join(",") ?? "*",
  ].join(":");
}

/** Connection account stored inside a JARVIS facet Durable Object. */
export class JarvisConnectionAccount implements ConnectionAccount {
  constructor(
    private readonly env: Env,
    private readonly storage: DurableObjectStorage,
    private readonly endpoint: string,
  ) {}

  #state(): StoredConnectionState {
    const stored = this.storage.kv.get<StoredConnectionState>("connection");
    if (stored?.endpoint === this.endpoint) return stored;
    const next: StoredConnectionState = {
      endpoint: this.endpoint,
      generation: (stored?.generation ?? 0) + 1,
    };
    this.storage.kv.put("connection", next);
    return next;
  }

  /** Returns the configured bearer and cached MCP transport session for `endpoint`. */
  async getConnection(endpoint: string): Promise<McpConnection> {
    if (endpoint !== this.endpoint) {
      throw new Error("This JARVIS binding was asked to contact the wrong endpoint.");
    }
    const token = jarvisTokenFor(this.env, endpoint);
    if (!token) {
      throw new Error("JARVIS is not configured with a bearer token for this MCP endpoint.");
    }
    const state = this.#state();
    return { authorization: token, sessionId: state.sessionId ?? null, generation: state.generation };
  }

  /** Persists a refreshed MCP transport session id if the connection generation is still current. */
  async setMcpSessionId(
    endpoint: string, generation: number, sessionId: string | null,
  ): Promise<void> {
    const state = this.storage.kv.get<StoredConnectionState>("connection");
    if (!state || state.endpoint !== endpoint || endpoint !== this.endpoint ||
        state.generation !== generation) {
      return;
    }
    if (sessionId) this.storage.kv.put("connection", { ...state, sessionId });
    else this.storage.kv.put("connection", { endpoint, generation });
  }

  /** Clears stale session state after an auth failure; the deployment must fix the secret. */
  async noteCredentialsExpired(endpoint: string, generation: number): Promise<void> {
    await this.setMcpSessionId(endpoint, generation, null);
    logger.warn("JARVIS MCP token was rejected", {
      event: "credentials.expiry.detected",
      serverHost: hostOf(endpoint),
    });
  }
}

/** Auto-provisioned JARVIS account that exposes one ambient singleton and no URL grants. */
@validateRpc()
export class JarvisAccount
  extends WorkerEntrypoint<Env, JarvisAccountProps>
  implements GatekeeperUser {
  /** Describes the JARVIS singleton account. */
  async describe(): Promise<AccountDescription> {
    const config = readJarvisConfig(this.env);
    const description: AccountDescription = {
      displayName: JARVIS_DISPLAY_NAME,
      avatar: JARVIS_ICON,
    };
    if (config && jarvisTokenFor(this.env, config.endpoint)) {
      const policy = await policyObject(this.ctx as ExportContext<unknown>).get();
      const union = JARVIS_ALLOWED_TOOLS.filter(name =>
        policy.chat.tools?.includes(name) || policy.code.tools?.includes(name));
      description.singleton = {
        tsType: sessionTypeName(
          JARVIS_SERVER_ID,
          jarvisSingletonResourceUrl(config.endpoint, { tools: union }),
        ),
        revisionedAuthority: true,
      };
      description.providesUi = { title: "JARVIS", icon: JARVIS_ICON };
    }
    return description;
  }

  /** Returns the owner-scoped JARVIS singleton gatekeeper class. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<unknown>>> {
    return (await this.getSingletonGatekeeperAuthority()).class;
  }

  /** Returns the facet class minted from the current deployment-global immutable policy snapshot. */
  async getSingletonGatekeeperAuthority(): Promise<{
    key: string;
    class: DurableObjectClass<Gatekeeper<unknown>>;
  }> {
    const config = readJarvisConfig(this.env);
    if (!config) throw new Error("This deployment has no valid HTTPS JARVIS_MCP_URL configured.");
    if (!jarvisTokenFor(this.env, config.endpoint)) {
      throw new Error("This deployment has no JARVIS_MCP_TOKEN configured for JARVIS.");
    }
    const policy = await policyObject(this.ctx as ExportContext<unknown>).get();
    const union = JARVIS_ALLOWED_TOOLS.filter(name =>
      policy.chat.tools?.includes(name) || policy.code.tools?.includes(name));
    const props: JarvisGatekeeperProps = {
      accountId: this.ctx.props.accountId,
      endpoint: config.endpoint,
      // One facet generates a union interface for both callers. startSession selects a surface-local
      // host and strictly filters runtime list/call access to the corresponding frozen scope.
      scope: { tools: union },
      chatScope: policy.chat,
      codeScope: policy.code,
      policyRevision: policy.revision,
      policyKey: policyKey(config.endpoint, policy),
    };
    return {
      key: props.policyKey!,
      class: (this.ctx as ExportContext<JarvisAccountProps>).exports.JarvisGatekeeper({ props }),
    };
  }

  /** Opens the deployment policy UI with update authority only for current administrators. */
  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    const api = new JarvisPolicyApi(
      policyObject(this.ctx as ExportContext<unknown>), context.isAdmin);
    return { iframeHtml: APP_HTML, ui: new RpcStub(api) };
  }

  /** JARVIS exposes no user-grantable URL resources. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  /** JARVIS has no URL-addressed resource grants. */
  getGatekeeperClassFor(_url: string): never {
    throw new Error("JARVIS is an ambient singleton and has no URL-addressed resources.");
  }

  /** JARVIS has no resource configurator UI. */
  startResourceConfigurator(_resourceUrlPattern: string): never {
    throw new Error("JARVIS is an ambient singleton and has no URL-addressed resources.");
  }

  /** JARVIS has no resource grant flow. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Revocation has no remote side effect because credentials are deployment-owned. */
  async revoke(): Promise<void> {}

  /** JARVIS is auto-provisioned and cannot reconnect through a user flow. */
  reconnect(): never {
    throw new Error("JARVIS is deployment-configured; ask an administrator to rotate its token.");
  }

  /** JARVIS does not authenticate end users. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Returns a verifier object; observers are refused by the facet before it is consulted. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return (this.ctx as ExportContext<JarvisAccountProps>).exports.JarvisVerifier({});
  }
}

/** Verifier required by the GatekeeperUser contract; JARVIS facets refuse observers. */
@validateRpc()
export class JarvisVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  /** No-op verifier because observers are never admitted. */
  verify(): void {}
}

/** Durable Object facet implementing the JARVIS MCP singleton. */
export class JarvisGatekeeper
  extends McpFacetBase<Env, JarvisGatekeeperProps, JarvisSession> {
  #account: JarvisConnectionAccount | undefined;

  protected get log() {
    return logger.with({
      serverId: JARVIS_SERVER_ID,
      serverHost: hostOf(this.ctx.props.endpoint),
      trust: jarvisTrust(this.env),
    });
  }

  protected get trust(): ServerTrust {
    return jarvisTrust(this.env);
  }

  protected get sessionClass() {
    return JarvisSession;
  }

  protected get actionScopeTag(): string {
    return `jarvis:${endpointTag(this.ctx.props.endpoint)}`;
  }

  protected get observerName(): string {
    return JARVIS_DISPLAY_NAME;
  }

  protected sessionScope(surface: "chat" | "code"): ToolScope {
    const { chatScope, codeScope, scope } = this.ctx.props;
    if ((chatScope === undefined) !== (codeScope === undefined)) {
      throw new Error("This JARVIS facet has an invalid partial surface policy.");
    }
    return (surface === "code" ? codeScope : chatScope) ?? scope;
  }

  protected account(): ConnectionAccount {
    return this.#account ??= new JarvisConnectionAccount(
      this.env, this.ctx.storage, this.ctx.props.endpoint);
  }

  /** Returns only fixed-policy JARVIS tools; upstream annotations cannot weaken approval rules. */
  async tools() {
    return (await super.tools())
      .map(applyJarvisToolPolicy)
      .filter(entry => entry !== null);
  }

  /** Human-readable server name used in observations and approval prompts. */
  get serverName(): string {
    return JARVIS_DISPLAY_NAME;
  }

  /** Describes the JARVIS singleton binding. */
  async describe(): Promise<ResourceDescription> {
    const allTools = await this.tools();
    const chatAllowed = new Set((this.ctx.props.chatScope ?? this.ctx.props.scope).tools ?? []);
    const codeAllowed = new Set((this.ctx.props.codeScope ?? this.ctx.props.scope).tools ?? []);
    const chatTools = allTools.filter(entry => chatAllowed.has(entry.tool.name));
    const codeTools = allTools.filter(entry => codeAllowed.has(entry.tool.name));
    const chatReads = chatTools.filter(entry => entry.mode === "read").length;
    const codeReads = codeTools.filter(entry => entry.mode === "read").length;
    const scopeSummary = chatAllowed.size === codeAllowed.size &&
        [...chatAllowed].every(name => codeAllowed.has(name))
      ? `${chatTools.length} approved JARVIS MCP tools (${chatReads} read-only, ` +
        `${chatTools.length - chatReads} requiring approval)`
      : `Chat: ${chatTools.length} tools (${chatReads} read-only); code: ${codeTools.length} tools ` +
        `(${codeReads} read-only)`;
    return {
      url: this.resourceUrl,
      title: JARVIS_DISPLAY_NAME,
      snippet:
        `${scopeSummary}. Escalation and skill-creation tools are not exposed.`,
      suggestedBindingName: JARVIS_DISPLAY_NAME,
      tsType: sessionTypeName(JARVIS_SERVER_ID, this.resourceUrl),
    };
  }

  /**
   * Generates the union TypeScript interface needed by chat and code surfaces.
   * Runtime sessions still enforce their frozen surface-specific scope before every list/call.
   */
  async getTypeScriptTypes(): Promise<string> {
    return generateSessionTypes({
      baseTypes: MCP_BASE_TYPES,
      serverId: JARVIS_SERVER_ID,
      serverName: JARVIS_DISPLAY_NAME,
      endpoint: this.ctx.props.endpoint,
      discriminator: this.resourceUrl,
      trust: jarvisTrust(this.env),
      tools: await this.tools(),
    });
  }

  /** Returns bounded allowlisted tool discovery after recording observation authorization. */
  async getAgentCatalog(
    request: AgentCatalogRequest,
    authorizer: RpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog> {
    const allowed = new Set((this.ctx.props.chatScope ?? this.ctx.props.scope).tools ?? []);
    const entries = (await this.tools())
      .filter(entry => allowed.has(entry.tool.name))
      .filter(entry => isJarvisAllowedTool(entry.tool.name))
      .map(entry => ({
        id: entry.tool.name,
        title: entry.tool.title ?? entry.tool.name,
        description: entry.tool.description?.split(/\r?\n/)[0] ?? "JARVIS MCP tool.",
      }))
      .toSorted((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
    const catalog = boundAgentCatalog(entries, request);
    await authorizer.authorizeObservation({
      title: "JARVIS catalog",
      description: `Listed ${catalog.entries.length} available JARVIS tool(s).`,
    });
    return catalog;
  }
}

/** Gadget-facing JARVIS MCP session with generated per-tool helpers installed at startup. */
@validateRpc()
export class JarvisSession extends McpSessionBase {}

/** Vendor entrypoint for the auto-provisioned JARVIS connector. */
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  /** Describes the JARVIS connector. */
  async describe(): Promise<VendorDescription> {
    const config = readJarvisConfig(this.env);
    const configured = config !== null && jarvisTokenFor(this.env, config.endpoint) !== null;
    return {
      displayName: JARVIS_DISPLAY_NAME,
      url: "https://workers.cloudflare.com/",
      logo: JARVIS_ICON,
      color: "#4f46e5",
      tagline: config ? `Ask JARVIS through ${hostOf(config.endpoint)}` : "No JARVIS MCP endpoint configured",
      description:
        "JARVIS gives agents deployment-approved access to knowledge, support, incident, and " +
        "integration-health MCP tools. The connector is ambient and exposes only a fixed allowlist.",
      autoProvisionsAccount: configured,
      providesAuth: false,
    };
  }

  /** Mints a JARVIS account without a user OAuth flow. */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    if (!hasJarvisConfiguration(this.env)) {
      throw new Error(
        "JARVIS is not configured. Set HTTPS JARVIS_MCP_URL and JARVIS_MCP_TOKEN before " +
        "auto-provisioning accounts.");
    }
    return (this.ctx as ExportContext<{}>).exports.JarvisAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  /** JARVIS is auto-provisioned and has no connect flow. */
  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("JARVIS is auto-provisioned; it has no connect flow.");
  }

  /** Returns the configured JARVIS resource metadata, or none when unconfigured. */
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  /** Returns transport-neutral base types; singleton-specific tool types come from the facet. */
  async getTypeScriptTypes(): Promise<string> {
    return MCP_BASE_TYPES;
  }
}

/** Builds the singleton JARVIS resource URL discriminator used for generated session types. */
export function jarvisSingletonResourceUrl(
  endpoint = "https://jarvis.invalid/mcp",
  scope: ToolScope = { tools: [...JARVIS_ALLOWED_TOOLS] },
): string {
  return formatToolScope(endpoint, scope);
}

export { JarvisPolicy, JarvisPolicyApi } from "./policy.js";

export default {
  /** Health-check endpoint for direct HTTP requests to the worker. */
  async fetch(): Promise<Response> {
    return new Response("JARVIS gatekeeper worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
