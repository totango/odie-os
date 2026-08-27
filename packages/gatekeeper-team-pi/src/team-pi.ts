import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  boundAgentCatalog,
  type AccountDescription,
  type ActionKind,
  type AgentCatalog,
  type AgentCatalogEntry,
  type AppUiContext,
  type ApprovalQueue,
  type ConnectionHealthStatus,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUiFrame,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ObservationAuthorizer,
  type ObservationDescription,
  type ObservationDomainSharingPolicy,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import TYPES_CODE from "./types.txt";
import {
  TeamPiApi,
  TeamPiApiError,
  pollDeviceAuthorization,
  refreshAccessToken,
  resolveConfig,
  revokeRefreshToken,
  safeProvider,
  startDeviceAuthorization,
  type CalendarOptions,
  type ListOptions,
  type SearchOptions,
  type TeamPiProvider,
  type TokenGrant,
} from "./team-pi-api.js";
import type { TeamPiAccountConfiguratorRpc } from "./configurator/account-configurator-types.js";
import ACCOUNT_CONFIGURATOR_HTML from "./generated/account-configurator-ui.txt";
import APP_HTML from "./generated/app.txt";
import type {
  TeamPiActionResult,
  TeamPiConnection,
  TeamPiCreateJiraIssueRequest,
  TeamPiCreateJiraIssueResult,
  TeamPiQueuedAction,
  TeamPiSession,
  TeamPiSkill,
  TeamPiSkillCheck,
  WorkItemActivity,
  WorkItemAttachment,
  WorkItemAttachmentContent,
  WorkItemComment,
  WorkItemCommentInput,
  WorkItemDetail,
  WorkItemFieldPatch,
  WorkItemLinkResult,
  WorkItemManagementApi,
  WorkItemProviderError,
  WorkItemProviderKind,
  WorkItemProviderRef,
  WorkItemRead,
  WorkItemsCurrentUser,
  WorkItemsManagementApi,
  WorkItemSavedView,
  WorkItemSavedViewFilters,
  WorkItemSearchPage,
  WorkItemSearchRequest,
  WorkItemSourceStatus,
  WorkItemSourceStatuses,
  WorkItemSummary,
  WorkItemTransition,
  WorkItemUpdateOptions,
  ZendeskTicketMemoryEntry,
  ZendeskTicketMemoryPartition,
  ZendeskTicketMemorySearchRequest,
  ZendeskTicketMemorySearchResult,
  ZendeskTicketReadRequest,
} from "./types.js";

type TeamPiLogFields = { event?: string; vendorId?: string; accountId?: string; status?: number; error?: unknown };

const logger = createLogger<TeamPiLogFields>({ component: "gatekeeper.team-pi", vendorId: "team-pi" });
const TOTANGO_DOMAIN_SHARING_POLICY = {
  type: "verified-sso-email-domain",
  emailDomain: "totango.com",
} as const satisfies ObservationDomainSharingPolicy;

function teamPiObservation(title: string, description: string): ObservationDescription {
  return { title, description, domainSharingPolicy: TOTANGO_DOMAIN_SHARING_POLICY };
}
const ICON = { url: "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'><rect width='256' height='256' rx='56' fill='#111827'/><text x='50%' y='54%' dominant-baseline='middle' text-anchor='middle' font-family='Arial' font-size='82' fill='white'>PI</text></svg>") };
const WORK_ITEMS_ICON = { url: "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'><rect width='256' height='256' rx='56' fill='#0f172a'/><rect x='58' y='46' width='140' height='164' rx='18' fill='#f8fafc'/><path d='M90 42h76a18 18 0 0 1 18 18v10H72V60a18 18 0 0 1 18-18Z' fill='#38bdf8'/><path d='m82 110 14 14 28-32' fill='none' stroke='#10b981' stroke-width='13' stroke-linecap='round' stroke-linejoin='round'/><path d='M138 108h36M138 150h36M82 154l13 13 27-31' fill='none' stroke='#334155' stroke-width='12' stroke-linecap='round' stroke-linejoin='round'/></svg>") };
const CONNECT_TIMEOUT_MS = 15 * 60 * 1000;
const ACCESS_TOKEN_SAFETY_MS = 60_000;
const ID_TOKEN_REFRESH_RETRY_MS = 5 * 60 * 1000;
const APPLYING_TIMEOUT_MS = 5 * 60 * 1000;
const SKILL_INSTRUCTIONS_MAX_LENGTH = 12_000;
const WORK_ITEM_FIELD_MAX = 2_000;
const WORK_ITEM_BODY_MAX = 12_000;
const WORK_ITEM_DESCRIPTION_MAX = 60_000;
const WORK_ITEM_SAVED_VIEWS_MAX = 20;
const ZENDESK_MEMORY_META_KEY = "zendeskTicketMemory:v2:meta";
const ZENDESK_MEMORY_PARTITION_KEY_PREFIX = "zendeskTicketMemory:v2:partition:";
const ZENDESK_MEMORY_MAX_PARTITIONS = 25;
const ZENDESK_MEMORY_MAX_ENTRIES = 50;
const ZENDESK_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ZENDESK_MEMORY_MAX_RESULTS = 25;
const ACCOUNT_URL = "team-pi://account";
const ACCOUNT_RESOURCE: SupportedResource = {
  urlPattern: ACCOUNT_URL,
  title: "Team PI Account",
  description: "Per-user Team PI skills, Work Items (Jira/Zendesk), calendar, Gmail, Chorus, Zendesk, and Salesforce reads for agents.",
  providedBySingleton: true,
};

type StoredDevice = { nonce: string; deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete?: string; expiresAt: number; intervalMs: number };
type StoredIdentity = { displayName?: string; uniqueName?: string };
type Props = { accountId: string };
type PendingAction = { kind: "installSkill"; skillId: string } | { kind: "startConnection"; provider: TeamPiProvider } | { kind: "createJiraIssue"; request: NormalizedCreateJiraIssueRequest };
type ApplyingAction = PendingAction & { claimedAt: number };
type NormalizedCreateJiraIssueRequest = Required<Pick<TeamPiCreateJiraIssueRequest, "projectKey" | "issueType" | "summary" | "description">> & Pick<TeamPiCreateJiraIssueRequest, "priority">;
type WorkItemProviderSearchResult =
  | { source: WorkItemProviderKind; page: WorkItemSearchPage }
  | { source: WorkItemProviderKind; error: WorkItemProviderError };
type StoredZendeskTicketMemoryMeta = { partitions: { keyHash: string; lastUsedAt: number }[] };
type StoredZendeskTicketMemoryEntry = Omit<ZendeskTicketMemoryEntry, "partition">;

const PROVIDER_CATALOG_ENTRIES: AgentCatalogEntry[] = [
  { id: "provider:gmail", title: "Gmail", description: "Search and read Gmail messages available through Team PI." },
  { id: "provider:calendar", title: "Calendar", description: "Read calendar events available through Team PI." },
  { id: "provider:chorus", title: "Chorus", description: "Search calls and read customer account, engagement, and conversation details through Team PI." },
  { id: "provider:zendesk", title: "Zendesk", description: "Search and read support tickets available through Team PI." },
  { id: "provider:salesforce", title: "Salesforce", description: "Read customer account records available through Team PI." },
  { id: "provider:work-items", title: "Work Items / Jira", description: "Search Jira issues and Zendesk tickets through Team PI Work Items, and request approved Jira issue creation with createJiraIssue(request)." },
  { id: "provider:docs", title: "Docs", description: "Discover document-oriented Team PI skills and provider capabilities." },
];

const html = (body: string, init?: ResponseInit) => new Response(body, {
  ...init,
  headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    ...init?.headers,
  },
});
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), {
  ...init,
  headers: { "Content-Type": "application/json; charset=utf-8", ...init?.headers },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const connectIndex = parts.lastIndexOf("connect");
    if (connectIndex < 0 || parts.length !== connectIndex + 3) return new Response("Not Found", { status: 404 });
    const accountId = parts[connectIndex + 1] ?? "";
    const nonce = parts[connectIndex + 2] ?? "";
    const stub = ctx.exports.TeamPiAccount.get(ctx.exports.TeamPiAccount.idFromString(accountId));
    try {
    if (request.method === "GET") {
      const page = connectPage(accountId, nonce);
      return html(page.body, { headers: { "Content-Security-Policy": page.csp } });
    }
      if (request.method === "POST" && url.searchParams.get("op") === "start") return json(await stub.startDeviceFlow(nonce));
      if (request.method === "POST" && url.searchParams.get("op") === "poll") return json(await stub.pollDeviceFlow(nonce));
    } catch (error) {
      logger.warn("team pi connect flow failed", { event: "team_pi.connect.failed", accountId, error });
      return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    return new Response("Method Not Allowed", { status: 405 });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Team PI",
      url: "https://team-pi.com/",
      logo: ICON,
      color: "#111827",
      tagline: "Use your per-user Team PI skills and connected work apps",
      description: "Connect Team PI with Auth0 device authorization to expose approved per-user skills, Work Items/Jira search, approval-backed Jira issue creation, calendar, Gmail, Chorus, Zendesk, and Salesforce reads to agents. Management UI writes stay admin-only.",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    const accountId = this.ctx.exports.TeamPiAccount.newUniqueId();
    const nonce = crypto.randomUUID();
    await this.ctx.exports.TeamPiAccount.get(accountId).setCallback(callback, nonce);
    return { url: `/gatekeeper/team-pi/connect/${accountId.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> { return [ACCOUNT_RESOURCE]; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}

export class TeamPiAccount extends DurableObject<Env> {
  #refreshPromise: Promise<void> | undefined;
  #pollInFlight: { nonce: string; promise: Promise<{ status: "pending" | "complete"; pollAfterMs?: number }> } | undefined;

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put("nonce", nonce);
    if (!this.ctx.storage.kv.get<string>("refreshToken")) await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
  }

  async prepareReconnect(nonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback")) {
      throw new Error("Team PI account cannot reconnect because its callback is missing.");
    }
    this.ctx.storage.kv.put("nonce", nonce);
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.delete("device");
    await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
  }

  async startDeviceFlow(nonce: string): Promise<Omit<StoredDevice, "nonce" | "deviceCode">> {
    this.#checkNonce(nonce);
    const started = await startDeviceAuthorization(resolveConfig(this.env));
    const stored: StoredDevice = {
      nonce,
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      verificationUriComplete: started.verificationUriComplete,
      expiresAt: Date.now() + started.expiresIn * 1000,
      intervalMs: started.interval * 1000,
    };
    this.ctx.storage.kv.put("device", stored);
    await this.ctx.storage.setAlarm(stored.expiresAt + 60_000);
    return publicDevice(stored);
  }

  async pollDeviceFlow(nonce: string): Promise<{ status: "pending" | "complete"; pollAfterMs?: number }> {
    if (this.#pollInFlight) {
      if (this.#pollInFlight.nonce !== nonce) throw new Error("Another Team PI connection attempt is being polled.");
      return this.#pollInFlight.promise;
    }
    const promise = this.#pollDeviceFlow(nonce);
    this.#pollInFlight = { nonce, promise };
    try {
      return await promise;
    } finally {
      this.#pollInFlight = undefined;
    }
  }

  async #pollDeviceFlow(nonce: string): Promise<{ status: "pending" | "complete"; pollAfterMs?: number }> {
    this.#checkNonce(nonce);
    const device = this.ctx.storage.kv.get<StoredDevice>("device");
    if (!device || device.nonce !== nonce || Date.now() >= device.expiresAt) throw new Error("This Team PI connection attempt has expired.");
    const grant = await pollDeviceAuthorization(resolveConfig(this.env), device.deviceCode);
    if (grant === "pending") return { status: "pending", pollAfterMs: device.intervalMs };
    await this.#storeGrant(grant);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("This Team PI connection attempt was abandoned.");
    const reconnecting = Boolean(this.ctx.storage.kv.get<boolean>("reconnecting"));
    if (reconnecting) {
      this.ctx.storage.kv.delete("reconnecting");
      await callback.credentialsRestored();
    } else {
      await callback.complete(this.ctx.exports.TeamPiUser({ props: { accountId: this.ctx.id.toString() } }));
    }
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.kv.delete("device");
    this.ctx.storage.kv.delete("nonce");
    return { status: "complete" };
  }

  async getAccessToken(): Promise<string> {
    const token = this.ctx.storage.kv.get<string>("accessToken");
    const expiresAt = this.ctx.storage.kv.get<number>("accessTokenExpiresAt") ?? 0;
    if (token && Date.now() < expiresAt - ACCESS_TOKEN_SAFETY_MS) return token;
    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) throw new Error("Team PI credentials have not been configured.");
    await this.#refreshCredentials(refreshToken, false);
    return this.ctx.storage.kv.get<string>("accessToken") ?? "";
  }

  async #refreshCredentials(refreshToken: string, force: boolean): Promise<void> {
    if (this.#refreshPromise) {
      await this.#refreshPromise;
      return;
    }
    try {
      this.#refreshPromise = (async () => {
        const current = this.ctx.storage.kv.get<string>("accessToken");
        const currentExpiresAt = this.ctx.storage.kv.get<number>("accessTokenExpiresAt") ?? 0;
        if (!force && current && Date.now() < currentExpiresAt - ACCESS_TOKEN_SAFETY_MS) return;
        await this.#storeGrant(await refreshAccessToken(resolveConfig(this.env), refreshToken));
      })();
      await this.#refreshPromise;
    } catch (error) {
      if (error instanceof TeamPiApiError && error.isAuthError) {
        await this.#notifyExpired();
        throw new Error(
          "Team PI credentials have expired or been revoked. Reconnect Team PI from Connections, then retry.",
          { cause: error },
        );
      }
      throw error;
    } finally {
      this.#refreshPromise = undefined;
    }
  }

  async getApiCredentials(forceRefresh = false): Promise<{ accessToken: string; idToken?: string }> {
    let accessToken: string;
    if (forceRefresh) {
      const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
      if (!refreshToken) throw new Error("Team PI credentials have not been configured.");
      await this.#refreshCredentials(refreshToken, true);
      accessToken = this.ctx.storage.kv.get<string>("accessToken") ?? "";
    } else {
      accessToken = await this.getAccessToken();
    }
    let idToken = this.ctx.storage.kv.get<string>("idToken");
    let idTokenExpiresAt = this.ctx.storage.kv.get<number>("idTokenExpiresAt") ?? 0;
    const lastIdTokenRefresh = this.ctx.storage.kv.get<number>("idTokenRefreshAttemptedAt") ?? 0;
    if ((!idToken || Date.now() >= idTokenExpiresAt - ACCESS_TOKEN_SAFETY_MS) &&
        Date.now() - lastIdTokenRefresh >= ID_TOKEN_REFRESH_RETRY_MS) {
      const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
      if (refreshToken) {
        await this.#refreshCredentials(refreshToken, true);
        this.ctx.storage.kv.put("idTokenRefreshAttemptedAt", Date.now());
      }
      accessToken = this.ctx.storage.kv.get<string>("accessToken") ?? accessToken;
      idToken = this.ctx.storage.kv.get<string>("idToken");
      idTokenExpiresAt = this.ctx.storage.kv.get<number>("idTokenExpiresAt") ?? 0;
    }
    if (!idToken || Date.now() >= idTokenExpiresAt - ACCESS_TOKEN_SAFETY_MS) {
      await this.#notifyExpired();
      throw new Error(
        "Team PI requires a fresh identity token for agent reads, but this connection cannot provide one. Reconnect Team PI from Connections, then retry.",
      );
    }
    return {
      accessToken,
      idToken,
    };
  }

  async describeIdentity(): Promise<StoredIdentity> { return this.ctx.storage.kv.get<StoredIdentity>("identity") ?? {}; }

  async listSavedWorkItemViews(): Promise<WorkItemSavedView[]> {
    return savedViewsFromStorage(this.ctx.storage.kv.get<unknown>("workItemSavedViews"));
  }

  async saveWorkItemView(view: WorkItemSavedView): Promise<WorkItemSavedView> {
    const normalized = normalizeSavedView(view);
    this.ctx.storage.transactionSync(() => {
      const views = savedViewsFromStorage(this.ctx.storage.kv.get<unknown>("workItemSavedViews"))
        .filter(existing => existing.id !== normalized.id);
      views.push(normalized);
      this.ctx.storage.kv.put("workItemSavedViews", views.slice(-WORK_ITEM_SAVED_VIEWS_MAX));
    });
    return normalized;
  }

  async deleteWorkItemView(id: string): Promise<void> {
    const normalizedId = normalizeSavedViewId(id);
    this.ctx.storage.transactionSync(() => {
      const views = savedViewsFromStorage(this.ctx.storage.kv.get<unknown>("workItemSavedViews"));
      this.ctx.storage.kv.put("workItemSavedViews", views.filter(view => view.id !== normalizedId));
    });
  }

  async revoke(): Promise<void> {
    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (refreshToken) {
      try { await revokeRefreshToken(resolveConfig(this.env), refreshToken); }
      catch (error) { logger.warn("team pi token revoke failed", { event: "team_pi.token.revoke.failed", accountId: this.ctx.id.toString(), error }); }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) await this.ctx.storage.deleteAll();
  }

  async #storeGrant(grant: TokenGrant): Promise<void> {
    this.ctx.storage.kv.put("accessToken", grant.accessToken);
    this.ctx.storage.kv.put("accessTokenExpiresAt", Date.now() + grant.expiresIn * 1000);
    if (grant.refreshToken) this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
    if (grant.idToken) {
      const claims = parseIdTokenClaims(grant.idToken);
      this.ctx.storage.kv.put("idToken", grant.idToken);
      this.ctx.storage.kv.delete("idTokenRefreshAttemptedAt");
      if (claims.expiresAt) this.ctx.storage.kv.put("idTokenExpiresAt", claims.expiresAt);
      else this.ctx.storage.kv.delete("idTokenExpiresAt");
      this.ctx.storage.kv.put("identity", claims.identity);
    } else {
      const existingIdToken = this.ctx.storage.kv.get<string>("idToken");
      const existingIdTokenExpiresAt = this.ctx.storage.kv.get<number>("idTokenExpiresAt") ?? 0;
      // Auth0 may omit id_token from an otherwise successful access-token refresh. Keep a
      // still-valid identity token rather than turning that success into an early reconnect.
      if (!existingIdToken || Date.now() >= existingIdTokenExpiresAt - ACCESS_TOKEN_SAFETY_MS) {
        this.ctx.storage.kv.delete("idToken");
        this.ctx.storage.kv.delete("idTokenExpiresAt");
        this.ctx.storage.kv.delete("identity");
      }
    }
  }

  #checkNonce(nonce: string): void {
    const stored = this.ctx.storage.kv.get<string>("nonce");
    if (!stored || stored !== nonce) throw new Error("Invalid Team PI connection link.");
  }

  async #notifyExpired(): Promise<void> {
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) await callback.credentialsExpired();
  }
}

@validateRpc()
export class TeamPiUser extends WorkerEntrypoint<Env, Props> implements GatekeeperUser {
  #account(): DurableObjectStub<TeamPiAccount> { return this.ctx.exports.TeamPiAccount.get(this.ctx.exports.TeamPiAccount.idFromString(this.ctx.props.accountId)); }
  #api(): TeamPiApi { return new TeamPiApi(forceRefresh => this.#account().getApiCredentials(forceRefresh), resolveConfig(this.env).baseUrl); }
  async describe(): Promise<AccountDescription> {
    const identity = await this.#account().describeIdentity();
    return {
      displayName: identity.displayName ?? identity.uniqueName ?? "Team PI",
      uniqueName: identity.uniqueName,
      avatar: ICON,
      singleton: { tsType: "TeamPiSession" },
      providesUi: { title: "Work Items", icon: WORK_ITEMS_ICON, adminOnly: true },
    };
  }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }
  async getSupportedResources(): Promise<SupportedResource[]> { return [ACCOUNT_RESOURCE]; }
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> { return {}; }
  async getConnectionStatus(): Promise<ConnectionHealthStatus> {
    try {
      await this.#account().getApiCredentials();
      return { state: "healthy", message: "Team PI credentials are usable." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/expired|revoked|credentials have not been configured|fresh identity token|reconnect team pi/i.test(message)) {
        return { state: "expired", message };
      }
      return { state: "unavailable", message };
    }
  }
  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<TeamPiSession>>; resource: SupportedResource }> {
    if (url !== ACCOUNT_URL) throw new Error(`Unsupported Team PI resource: ${url}`);
    return { class: this.ctx.exports.TeamPiGatekeeper({ props: this.ctx.props }), resource: ACCOUNT_RESOURCE };
  }
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<TeamPiSession>>> { return this.ctx.exports.TeamPiGatekeeper({ props: this.ctx.props }); }
  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== ACCOUNT_URL) {
      throw new Error(`Unsupported Team PI resource configurator: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: ACCOUNT_CONFIGURATOR_HTML,
      ui: new RpcStub(new TeamPiAccountConfiguratorUI()),
    };
  }
  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    if (!context.isAdmin) throw new Error("Team PI Work Items management is available to admins only.");
    return {
      iframeHtml: APP_HTML,
      ui: new RpcStub(new TeamPiWorkItemsManagementApi(this.#api(), this.#account())),
    };
  }
  async revoke(): Promise<void> { await this.#account().revoke(); }
  async reconnect(): Promise<{ url: string }> {
    const nonce = crypto.randomUUID();
    await this.#account().prepareReconnect(nonce);
    return { url: `/gatekeeper/team-pi/connect/${this.ctx.props.accountId}/${nonce}` };
  }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.TeamPiVerifier({}); }
}

@validateRpc()
class TeamPiAccountConfiguratorUI extends RpcTarget implements TeamPiAccountConfiguratorRpc {
  async resourceUrl(): Promise<string> { return ACCOUNT_URL; }
}

@validateRpc()
export class TeamPiWorkItemsManagementApi extends RpcTarget implements WorkItemsManagementApi {
  constructor(private readonly api: TeamPiApi, private readonly account: DurableObjectStub<TeamPiAccount>) { super(); }

  async getCurrentUser(): Promise<WorkItemsCurrentUser> {
    const identity = await this.account.describeIdentity();
    return {
      displayName: optionalBoundString(identity.displayName, 200),
      uniqueName: optionalBoundString(identity.uniqueName, 320),
    };
  }

  async listSavedViews(): Promise<WorkItemSavedView[]> {
    return this.account.listSavedWorkItemViews();
  }

  async saveSavedView(view: WorkItemSavedView): Promise<WorkItemSavedView> {
    return this.account.saveWorkItemView(view);
  }

  async deleteSavedView(id: string): Promise<void> {
    await this.account.deleteWorkItemView(id);
  }

  async getSourceStatuses(): Promise<WorkItemSourceStatuses> {
    return sourceStatusesFromEnvelope(await this.api.workItemsSourceStatus());
  }

  async search(request: WorkItemSearchRequest): Promise<WorkItemSearchPage> {
    return searchWorkItems(this.api, request);
  }

  async item(ref: WorkItemProviderRef): Promise<WorkItemManagementApi> {
    return new RpcStub(new TeamPiWorkItemManagementApi(this.api, normalizeWorkItemRef(ref)));
  }
}

@validateRpc()
export class TeamPiWorkItemManagementApi extends RpcTarget implements WorkItemManagementApi {
  constructor(private readonly api: TeamPiApi, private readonly ref: WorkItemProviderRef) { super(); }

  async read(): Promise<WorkItemRead> {
    return readWorkItem(this.api, this.ref);
  }

  async readAttachment(id: string): Promise<WorkItemAttachmentContent> {
    const content = await this.api.workItemsAttachmentContent(this.ref.source, this.ref.id, boundString(id, 180));
    return { data: content.data, name: boundString(content.name, 240), contentType: optionalBoundString(content.contentType, 160) };
  }

  async addComment(input: WorkItemCommentInput): Promise<WorkItemDetail> {
    const body = typeof input?.body === "string" ? boundString(input.body, WORK_ITEM_BODY_MAX).trim() : "";
    if (!body) throw new Error("Comment body is required.");
    const visibility = input.visibility === "public" ? "public" : input.visibility === "internal" ? "internal" : undefined;
    if (this.ref.source === "jira" && visibility === "internal") throw new Error("Jira comments are public only.");
    await this.api.workItemsAddComment(this.ref.source, this.ref.id, { body, ...(visibility ? { visibility } : {}) });
    return this.#detail();
  }

  async updateFields(patch: WorkItemFieldPatch): Promise<WorkItemDetail> {
    await this.api.workItemsUpdateFields(this.ref.source, this.ref.id, normalizeFieldPatch(patch));
    return this.#detail();
  }

  async transition(transitionId: string): Promise<WorkItemDetail> {
    if (this.ref.source !== "jira") throw new Error("Only Jira work items support transitions.");
    await this.api.workItemsApplyTransition(this.ref.id, boundString(transitionId, 80));
    return this.#detail();
  }

  async linkTo(other: WorkItemProviderRef): Promise<WorkItemLinkResult> {
    const normalizedOther = normalizeWorkItemRef(other);
    const pair = jiraZendeskPair(this.ref, normalizedOther);
    const raw = await this.api.workItemsLink(pair.jiraId, pair.zendeskTicketId);
    return linkResultFromEnvelope(raw, pair);
  }

  #detail(): Promise<WorkItemDetail> {
    return this.api.workItemsDetail(this.ref.source, this.ref.id).then(detailFromEnvelope);
  }
}

@validateRpc()
export class TeamPiVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier { verify(): void {} }

@validateRpc()
export class TeamPiGatekeeper extends DurableObject<Env, Props> implements Gatekeeper<TeamPiSession> {
  #account(): DurableObjectStub<TeamPiAccount> { return this.ctx.exports.TeamPiAccount.get(this.ctx.exports.TeamPiAccount.idFromString(this.ctx.props.accountId)); }
  #api(): TeamPiApi { return new TeamPiApi(forceRefresh => this.#account().getApiCredentials(forceRefresh), resolveConfig(this.env).baseUrl); }
  async describe(): Promise<ResourceDescription> { return { url: ACCOUNT_URL, title: "Team PI", snippet: "Totango SSO-shareable Team PI singleton with approved reads, Work Items search, approval-backed Jira issue creation, and staged non-agent writes.", suggestedBindingName: "TEAM_PI", tsType: "TeamPiSession", domainSharingPolicy: TOTANGO_DOMAIN_SHARING_POLICY }; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }
  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<TeamPiSession> { return new TeamPiSessionImpl(this.#api(), approvalQueue.dup(), this.ctx.storage.kv); }
  async getAgentCatalog(authorizer: RpcStub<ObservationAuthorizer>): Promise<AgentCatalog> {
    try {
      const skills = await this.#api().listSkills({ limit: 12 });
      const entries = [...catalogEntries("skill", skillsFromEnvelope(skills)), ...PROVIDER_CATALOG_ENTRIES];
      await authorizer.authorizeObservation(teamPiObservation(
        "Read Team PI skill, provider, and Work Items catalog",
        "Listed bounded Team PI skill manifests, provider capabilities, Work Items/Jira search, and approval-backed Jira issue creation capability for agent discovery.",
      ));
      return boundAgentCatalog(entries);
    } catch (error) {
      logger.warn("team pi catalog fallback used", {
        event: "team_pi.catalog.fallback.used", accountId: this.ctx.props.accountId, error,
      });
      const message = boundString(error instanceof Error ? error.message : String(error), 512);
      await authorizer.authorizeObservation(teamPiObservation("Team PI catalog unavailable", message));
      return boundAgentCatalog([{
        id: "team-pi:catalog-unavailable",
        title: "Team PI unavailable",
        description: message,
      }]);
    }
  }
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
  async applyAction(action: number): Promise<void> {
    const pending = claimPendingAction(this.ctx.storage.kv, action);
    if (!pending) return;
    try {
      const raw = await applyPendingAction(this.#api(), pending);
      const result = sanitizePendingActionResult(pending, raw, resolveConfig(this.env).baseUrl);
      this.ctx.storage.kv.put(resultKey(action), { status: "ready", result });
    } catch (error) {
      const message = boundString(error instanceof Error ? error.message : String(error), 512);
      this.ctx.storage.kv.put(resultKey(action), pending.kind === "createJiraIssue" && isDefiniteCreateRejection(error)
        ? { status: "failed", message }
        : { status: "unknown", message, canRetry: false });
    }
    this.ctx.storage.kv.delete(applyingKey(action));
  }
  async rejectAction(action: number): Promise<void> {
    rejectPendingAction(this.ctx.storage.kv, action);
  }
  revertAction(_action: number): Promise<void> { throw new Error("Team PI actions are not revertable by this gatekeeper."); }
}

export class TeamPiSessionImpl extends RpcTarget implements TeamPiSession {
  constructor(private readonly api: TeamPiApi, private readonly approvalQueue: RpcStub<ApprovalQueue>, private readonly kv: DurableObjectStorage["kv"]) { super(); }
  [Symbol.dispose](): void { this.approvalQueue[Symbol.dispose](); }
  async listSkills(options?: ListOptions): Promise<{ items: TeamPiSkill[]; nextCursor?: string }> { const out = await this.read("List Team PI skills", "Listed Team PI skills.", () => this.api.listSkills(options)); return { items: skillsFromEnvelope(out), nextCursor: normalizePage(out).nextCursor }; }
  async getSkill(skillId: string): Promise<TeamPiSkill> { return this.read("Read Team PI skill", `Read Team PI skill ${skillId}.`, async () => skillFromEnvelope(await this.api.getSkill(skillId))); }
  async checkSkill(skillId: string): Promise<TeamPiSkillCheck> { return this.read("Check Team PI skill", `Checked Team PI skill ${skillId}.`, async () => skillCheckFromEnvelope(await this.api.checkSkill(skillId))); }
  async listConnections(options?: ListOptions): Promise<{ items: TeamPiConnection[]; nextCursor?: string }> { const out = await this.read("List Team PI connections", "Listed Team PI connections.", () => this.api.listConnections(options)); return { items: connectionsFromEnvelope(out), nextCursor: normalizePage(out).nextCursor }; }
  async calendarEvents(options: CalendarOptions): Promise<unknown[]> { const out = await this.read("Read Team PI calendar events", "Read Team PI calendar events.", () => this.api.calendarEvents(options)); return Array.isArray(out) ? out : normalizePage(out).items; }
  async gmailSearch(options: SearchOptions): Promise<unknown> { return this.read("Search Team PI Gmail", "Searched Gmail through Team PI.", () => this.api.gmailSearch(options)); }
  async gmailMessage(messageId: string): Promise<unknown> { return this.read("Read Team PI Gmail message", `Read Gmail message ${messageId} through Team PI.`, () => this.api.gmailMessage(messageId)); }
  async chorusSearch(options: SearchOptions): Promise<unknown> { return this.read("Search Team PI Chorus", "Searched Chorus through Team PI.", () => this.api.chorusSearch(options)); }
  async chorusAccount(accountId: string): Promise<unknown> { return this.read("Read Team PI Chorus account", `Read Chorus account ${accountId}.`, () => this.api.chorusAccount(accountId)); }
  async chorusEngagement(engagementId: string): Promise<unknown> { return this.read("Read Team PI Chorus engagement", `Read Chorus engagement ${engagementId}.`, () => this.api.chorusEngagement(engagementId)); }
  async chorusConversation(conversationId: string): Promise<unknown> { return this.read("Read Team PI Chorus conversation", `Read Chorus conversation ${conversationId}.`, () => this.api.chorusConversation(conversationId)); }
  async zendeskSearch(options: SearchOptions): Promise<unknown> { return this.read("Search Team PI Zendesk", "Searched Zendesk through Team PI.", () => this.api.zendeskSearch(options)); }
  async zendeskTicket(ticketId: string): Promise<unknown> { return this.read("Read Team PI Zendesk ticket", `Read Zendesk ticket ${ticketId}.`, () => this.api.zendeskTicket(ticketId)); }
  async salesforceAccount(accountId: string): Promise<unknown> { return this.read("Read Team PI Salesforce account", `Read Salesforce account ${accountId}.`, () => this.api.salesforceAccount(accountId)); }
  async installSkill(skillId: string): Promise<TeamPiQueuedAction> { return this.queue({ kind: "installSkill", skillId }, `Install Team PI skill ${skillId}`, `Install Team PI skill \`${escapeMd(skillId)}\`.`); }
  async startConnection(provider: TeamPiProvider): Promise<TeamPiQueuedAction> { const safe = safeProvider(provider); return this.queue({ kind: "startConnection", provider: safe }, `Start Team PI connection ${safe}`, `Start Team PI connection \`${escapeMd(safe)}\`.`); }
  async createJiraIssue(request: TeamPiCreateJiraIssueRequest): Promise<TeamPiQueuedAction<TeamPiCreateJiraIssueResult>> {
    const normalized = normalizeCreateJiraIssueRequest(request);
    return this.queue(
      { kind: "createJiraIssue", request: normalized },
      `Create Jira issue ${normalized.projectKey} ${normalized.issueType}`,
      createJiraIssueApprovalDescription(normalized),
    );
  }
  async getActionResult(actionId: number): Promise<TeamPiActionResult> { return getStoredActionResult(this.kv, actionId); }
  async workItemsSearch(request: WorkItemSearchRequest): Promise<WorkItemSearchPage> { return this.read("Search Team PI Work Items", "Searched Jira and Zendesk Work Items through Team PI.", () => searchWorkItems(this.api, request)); }
  async readZendeskTicket(request: ZendeskTicketReadRequest): Promise<WorkItemRead> {
    const id = normalizeZendeskTicketId(request?.id);
    const result = await this.read(
      "Read Team PI Zendesk ticket Work Item",
      `Read authoritative Zendesk ticket ${id} through Team PI Work Items.`,
      () => readWorkItem(this.api, { source: "zendesk", id }),
    );
    try {
      await rememberZendeskTicket(this.kv, result.detail.item);
    } catch (error) {
      logger.warn("team pi zendesk ticket memory update failed", {
        event: "team_pi.zendesk_ticket_memory.update.failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return result;
  }
  async searchZendeskTicketMemory(request: ZendeskTicketMemorySearchRequest): Promise<ZendeskTicketMemorySearchResult> {
    const search = await readZendeskTicketMemory(this.kv, request);
    await this.approvalQueue.authorizeObservation({
      ...teamPiObservation(
        "Search Team PI Zendesk ticket memory",
        "Searched minimized local Zendesk ticket memory for one exact strict partition. Results are non-authoritative and require live read before use.",
      ),
    });
    try {
      touchZendeskTicketMemoryPartition(this.kv, search.keyHash, Date.now());
    } catch (error) {
      logger.warn("team pi zendesk ticket memory touch failed", {
        event: "team_pi.zendesk_ticket_memory.touch.failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { items: search.items };
  }
  private async read<T>(title: string, description: string, fn: () => Promise<T>): Promise<T> { const result = await fn(); await this.approvalQueue.authorizeObservation(teamPiObservation(title, description)); return result; }
  private async queue(action: PendingAction, title: string, description: string): Promise<TeamPiQueuedAction> {
    const actionId = (this.kv.get<number>("nextActionId") ?? 1);
    this.kv.put("nextActionId", actionId + 1);
    this.kv.put(pendingKey(actionId), action);
    this.kv.put(resultKey(actionId), { status: "pending" });
    try {
      await this.approvalQueue.submitAction(actionId, { title, description, implementsRevert: false, awaitDecision: true, actionKind: actionKindFor(action) });
    } catch (error) {
      this.kv.delete(pendingKey(actionId));
      this.kv.delete(resultKey(actionId));
      throw error;
    }
    return { actionId, status: "pending", pollAfterMs: 1000 };
  }
}

async function applyPendingAction(api: TeamPiApi, pending: PendingAction): Promise<unknown> {
  if (pending.kind === "installSkill") return api.installSkill(pending.skillId);
  if (pending.kind === "startConnection") return api.startConnection(pending.provider);
  if (pending.kind === "createJiraIssue") return api.workItemsCreateJiraIssue(pending.request);
  throw new Error("Unknown Team PI action kind.");
}

function sanitizePendingActionResult(pending: PendingAction, raw: unknown, baseUrl: string): unknown {
  if (pending.kind === "installSkill") return sanitizeInstallSkillResult(raw);
  if (pending.kind === "startConnection") return sanitizeStartConnectionResult(pending.provider, raw, baseUrl);
  if (pending.kind === "createJiraIssue") return createJiraIssueResultFromEnvelope(raw);
  throw new Error("Unknown Team PI action kind.");
}

function actionKindFor(action: PendingAction): ActionKind {
  if (action.kind === "installSkill") return { tag: "team-pi.installSkill", label: "Install Team PI skill" };
  if (action.kind === "startConnection") return { tag: "team-pi.startConnection", label: "Start Team PI connection" };
  if (action.kind === "createJiraIssue") return { tag: "team-pi.createJiraIssue", label: "Create Jira issue" };
  throw new Error("Unknown Team PI action kind.");
}

function isDefiniteCreateRejection(error: unknown): boolean {
  return error instanceof TeamPiApiError && [400, 401, 403, 404, 422].includes(error.status ?? 0);
}

function normalizeCreateJiraIssueRequest(request: TeamPiCreateJiraIssueRequest): NormalizedCreateJiraIssueRequest {
  const projectKey = normalizeRequiredJiraString(request?.projectKey ?? "AI", "projectKey", 40, false).toUpperCase();
  const issueType = normalizeRequiredJiraString(request?.issueType ?? "Story", "issueType", 80, false);
  const summary = normalizeRequiredJiraString(request?.summary, "summary", 300, false);
  const description = normalizeRequiredJiraString(request?.description, "description", WORK_ITEM_BODY_MAX, true).replace(/\r\n?/g, "\n");
  if (description.split("\n").length > 80) {
    throw new Error("Team PI Jira description must contain at most 80 lines.");
  }
  const priority = typeof request?.priority === "string" ? normalizeOptionalJiraString(request.priority, 80) : undefined;
  return priority ? { projectKey, issueType, summary, description, priority } : { projectKey, issueType, summary, description };
}

function normalizeRequiredJiraString(value: unknown, name: string, max: number, allowMultiline: boolean): string {
  if (typeof value !== "string") throw new Error(`Team PI Jira ${name} is required.`);
  const out = boundString(value.trim(), max);
  if (!out) throw new Error(`Team PI Jira ${name} is required.`);
  if (hasJiraControlCharacter(out, allowMultiline)) throw new Error(`Invalid Team PI Jira ${name}.`);
  return out;
}

function normalizeOptionalJiraString(value: string, max: number): string | undefined {
  const out = boundString(value.trim(), max);
  if (!out) return undefined;
  if (hasJiraControlCharacter(out, false)) throw new Error("Invalid Team PI Jira field.");
  return out;
}

function hasJiraControlCharacter(value: string, allowMultiline: boolean): boolean {
  for (let i = 0; i < value.length; ++i) {
    const code = value.charCodeAt(i);
    if (code < 32 && !(allowMultiline && (code === 9 || code === 10 || code === 13))) return true;
  }
  return false;
}

function createJiraIssueApprovalDescription(request: NormalizedCreateJiraIssueRequest): string {
  const lines = [
    "Create a Jira issue through Team PI Work Items with these exact submitted details:",
    `- Project key: ${escapeMd(request.projectKey)}`,
    `- Issue type: ${escapeMd(request.issueType)}`,
    `- Summary: ${escapeMd(request.summary)}`,
  ];
  if (request.priority) lines.push(`- Priority: ${escapeMd(request.priority)}`);
  lines.push("- Description:", escapeMd(request.description));
  return lines.join("\n");
}

function createJiraIssueResultFromEnvelope(value: unknown): TeamPiCreateJiraIssueResult {
  return detailFromEnvelope(value);
}

function publicDevice(device: StoredDevice): Omit<StoredDevice, "nonce" | "deviceCode"> {
  return { userCode: device.userCode, verificationUri: device.verificationUri, verificationUriComplete: device.verificationUriComplete, expiresAt: device.expiresAt, intervalMs: device.intervalMs };
}

function parseIdTokenClaims(idToken: string): { identity: StoredIdentity; expiresAt?: number } {
  try {
    const payload = JSON.parse(atob(idToken.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? "")) as Record<string, unknown>;
    return {
      identity: {
        displayName: typeof payload.name === "string" ? payload.name : undefined,
        uniqueName: typeof payload.email === "string" ? payload.email : undefined,
      },
      expiresAt: typeof payload.exp === "number" ? payload.exp * 1000 : undefined,
    };
  } catch { return { identity: {} }; }
}

function normalizePage(value: unknown): { items: any[]; nextCursor?: string } {
  if (Array.isArray(value)) return { items: value };
  if (value && typeof value === "object") {
    const obj = value as { items?: unknown; results?: unknown; skills?: unknown; connections?: unknown; nextCursor?: unknown };
    let items = Array.isArray(obj.items) ? obj.items : Array.isArray(obj.results) ? obj.results : Array.isArray(obj.skills) ? obj.skills : [];
    if (items.length === 0 && obj.connections && typeof obj.connections === "object") {
      items = Object.entries(obj.connections).map(([provider, id]) => ({ id: String(id), name: provider, provider, status: "connected" }));
    }
    return { items, nextCursor: typeof obj.nextCursor === "string" ? obj.nextCursor : undefined };
  }
  return { items: [] };
}

function skillsFromEnvelope(value: unknown): TeamPiSkill[] {
  const obj = asRecord(value);
  const skills = Array.isArray(obj.skills) ? obj.skills : normalizePage(value).items;
  return skills.map(skillFromValue).filter((skill): skill is TeamPiSkill => Boolean(skill));
}

function skillFromEnvelope(value: unknown): TeamPiSkill {
  const obj = asRecord(value);
  const skill = skillFromValue(obj.skill) ?? skillFromValue(value);
  if (!skill) throw new Error("Team PI skill response did not include a skill.");
  const files = asRecord(obj.files);
  const instructions = typeof files["SKILL.md"] === "string" ? boundString(files["SKILL.md"], SKILL_INSTRUCTIONS_MAX_LENGTH) : undefined;
  return instructions ? { ...skill, instructions } : skill;
}

function skillCheckFromEnvelope(value: unknown): TeamPiSkillCheck {
  const obj = asRecord(value);
  return {
    skillId: stringField(obj.skillId, ""),
    requiredConnections: safeRequiredConnections(obj.requiredConnections) ?? {},
    status: safeConnectionStatus(obj.status) ?? {},
  };
}

function skillFromValue(value: unknown): TeamPiSkill | null {
  const obj = asRecord(value);
  const id = stringField(obj.id, "");
  const name = stringField(obj.name, id);
  if (!id || !name) return null;
  return {
    id: boundString(id, 256),
    name: boundString(name, 200),
    description: optionalBoundString(obj.description, 1000),
    version: optionalBoundString(obj.version, 80),
    status: optionalBoundString(obj.status, 80),
    owner: optionalBoundString(obj.owner, 200),
    tags: Array.isArray(obj.tags) ? obj.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 25).map(tag => boundString(tag, 80)) : undefined,
    requiredConnections: safeRequiredConnections(obj.requiredConnections),
  };
}

function connectionsFromEnvelope(value: unknown): TeamPiConnection[] {
  const obj = asRecord(value);
  return [
    ...connectionMapEntries(asRecord(obj.connections), "user"),
    ...connectionMapEntries(asRecord(obj.shared), "shared"),
    ...connectionMapEntries(asRecord(obj.tokenConnections), "token"),
  ].slice(0, 100);
}

function connectionMapEntries(map: Record<string, unknown>, scope: TeamPiConnection["scope"]): TeamPiConnection[] {
  return Object.entries(map).map(([rawProvider, value]) => {
    const provider = providerOrUnknown(rawProvider);
    const record = asRecord(value);
    const configured = record.configured === true;
    const id = typeof value === "string" ? value : stringField(record.connectionId ?? record.id, "");
    const status = scope === "token" ? (configured ? "configured" : "missing") : (id ? "connected" : "missing");
    return { id: id ? boundString(id, 256) : undefined, name: provider === "unknown" ? boundString(rawProvider, 80) : provider, provider, scope, status };
  });
}

export function sanitizeInstallSkillResult(value: unknown): { ok: boolean; skill?: TeamPiSkill; connectionStatus?: Record<string, Record<string, boolean>> } {
  const obj = asRecord(value);
  return { ok: obj.ok === true, skill: skillFromValue(obj.skill) ?? undefined, connectionStatus: safeConnectionStatus(obj.connectionStatus) };
}

export function sanitizeStartConnectionResult(provider: TeamPiProvider, value: unknown, baseUrl: string): { provider: TeamPiProvider; alreadyConnected?: boolean; connectionId?: string; browserUrl?: string } {
  const obj = asRecord(value);
  const browserUrl = safeConnectionUrl(obj.localConnectUrl, baseUrl, provider);
  return {
    provider,
    alreadyConnected: obj.alreadyConnected === true ? true : undefined,
    connectionId: optionalBoundString(obj.connectionId, 256),
    browserUrl,
  };
}

export function getStoredActionResult(kv: DurableObjectStorage["kv"], action: number): TeamPiActionResult {
  const result = kv.get<TeamPiActionResult>(resultKey(action));
  if (result && result.status !== "pending") return result;
  if (kv.get<PendingAction>(pendingKey(action))) return { status: "pending" };
  const applying = kv.get<ApplyingAction>(applyingKey(action));
  if (applying) {
    if (Date.now() - applying.claimedAt > APPLYING_TIMEOUT_MS) {
      const unknown = { status: "unknown" as const, message: "Team PI action application timed out; outcome is unknown and will not be retried.", canRetry: false as const };
      kv.put(resultKey(action), unknown);
      kv.delete(applyingKey(action));
      return unknown;
    }
    return { status: "pending" };
  }
  throw new Error(`Unknown Team PI action: ${action}`);
}

export function sourceStatusesFromEnvelope(value: unknown): WorkItemSourceStatuses {
  const sources = asRecord(asRecord(value).sources);
  return {
    jira: sourceStatusFromValue(sources.jira),
    zendesk: sourceStatusFromValue(sources.zendesk),
  };
}

function sourceStatusFromValue(value: unknown): WorkItemSourceStatus {
  const obj = asRecord(value);
  return {
    configured: obj.configured === true,
    connected: obj.connected === true,
    reason: optionalBoundString(obj.reason, 240),
  };
}

export function detailFromEnvelope(value: unknown): WorkItemDetail {
  const item = workItemSummaryFromValue(asRecord(value).item);
  if (!item) throw new Error("Team PI Work Items detail did not include an item.");
  return { item };
}

function searchPageFromEnvelope(source: WorkItemProviderKind, value: unknown): WorkItemSearchPage {
  const obj = asRecord(value);
  const items = (Array.isArray(obj.items) ? obj.items : []).map(workItemSummaryFromValue).filter((item): item is WorkItemSummary => Boolean(item));
  const cursor = optionalBoundString(obj.cursor, 500);
  return {
    items: items.slice(0, 50),
    cursors: cursor ? { [source]: cursor } : {},
    hasMore: { [source]: obj.hasMore === true },
  };
}

async function searchWorkItems(api: TeamPiApi, request: WorkItemSearchRequest): Promise<WorkItemSearchPage> {
  const normalized = normalizeWorkItemSearchRequest(request);
  const sources: WorkItemProviderKind[] = normalized.source === "both" ? ["jira", "zendesk"] : [normalized.source];
  const pages = await Promise.all(sources.map(async (source): Promise<WorkItemProviderSearchResult> => {
    try {
      return { source, page: searchPageFromEnvelope(source, await api.workItemsSearch(source, {
        query: normalized.query,
        limit: normalized.limit,
        cursor: normalized.cursors[source],
      })) };
    } catch (error) {
      if (normalized.source !== "both") throw error;
      return { source, error: providerError(source, error) };
    }
  }));
  const out: WorkItemSearchPage = { items: [], cursors: {}, hasMore: {} };
  const errors: WorkItemProviderError[] = [];
  for (const result of pages) {
    if ("page" in result) {
      out.items.push(...result.page.items);
      if (result.page.cursors[result.source]) out.cursors[result.source] = result.page.cursors[result.source];
      out.hasMore[result.source] = result.page.hasMore[result.source] === true;
    } else {
      errors.push(result.error);
    }
  }
  if (errors.length > 0) out.errors = errors;
  return { ...out, items: out.items.slice(0, 100) };
}

async function readWorkItem(api: TeamPiApi, ref: WorkItemProviderRef): Promise<WorkItemRead> {
  const [detail, comments, activity, updateOptions, transitions, attachments] = await Promise.all([
    api.workItemsDetail(ref.source, ref.id).then(detailFromEnvelope),
    api.workItemsComments(ref.source, ref.id).then(value => commentsFromEnvelope(ref.source, value)),
    api.workItemsActivity(ref.source, ref.id).then(activityFromEnvelope),
    api.workItemsUpdateOptions(ref.source, ref.id).then(value => updateOptionsFromEnvelope(ref, value)),
    ref.source === "jira" ? api.workItemsTransitions(ref.id).then(transitionsFromEnvelope) : Promise.resolve([]),
    api.workItemsAttachments(ref.source, ref.id).then(attachmentsFromEnvelope),
  ]);
  return { detail, comments, activity, updateOptions, transitions, attachments };
}

async function rememberZendeskTicket(kv: DurableObjectStorage["kv"], item: WorkItemSummary): Promise<void> {
  if (item.source !== "zendesk") return;
  const url = canonicalZendeskTicketUrl(item.url, item.id);
  const partition = deriveZendeskPartition(item, url);
  if (!partition) return;
  const entry: StoredZendeskTicketMemoryEntry = {
    id: normalizeZendeskTicketId(item.id),
    ...(url ? { url } : {}),
    title: boundCleanString(item.title, 300),
    status: optionalCleanString(item.status, 80),
    type: optionalCleanString(item.type, 80),
    priority: optionalCleanString(item.priority, 80),
    rememberedAt: Date.now(),
  };
  const keyHash = await zendeskPartitionHash(partition);
  const partitionKey = zendeskPartitionStorageKey(keyHash);
  const entries = zendeskMemoryEntriesFromStorage(kv.get<unknown>(partitionKey), entry.rememberedAt);
  const nextEntries = [entry, ...entries.filter(existing => existing.id !== entry.id)]
    .toSorted((a, b) => b.rememberedAt - a.rememberedAt)
    .slice(0, ZENDESK_MEMORY_MAX_ENTRIES);
  kv.put(partitionKey, nextEntries);
  upsertZendeskMemoryMeta(kv, keyHash, entry.rememberedAt);
}

async function readZendeskTicketMemory(kv: DurableObjectStorage["kv"], request: ZendeskTicketMemorySearchRequest): Promise<ZendeskTicketMemorySearchResult & { keyHash: string }> {
  const partition = normalizeZendeskPartition(request?.partition);
  const keyHash = await zendeskPartitionHash(partition);
  const entries = zendeskMemoryEntriesFromStorage(kv.get<unknown>(zendeskPartitionStorageKey(keyHash)), Date.now());
  const query = optionalCleanString(request?.query, 200)?.toLowerCase();
  const limit = typeof request?.limit === "number" && Number.isFinite(request.limit)
    ? Math.max(1, Math.min(ZENDESK_MEMORY_MAX_RESULTS, Math.floor(request.limit)))
    : ZENDESK_MEMORY_MAX_RESULTS;
  return {
    items: entries
      .map(entry => ({ ...entry, partition }))
      .filter(entry => !query || zendeskMemoryText(entry).includes(query))
      .toSorted((a, b) => b.rememberedAt - a.rememberedAt)
      .slice(0, limit),
    keyHash,
  };
}

function zendeskMemoryMetaFromStorage(value: unknown): StoredZendeskTicketMemoryMeta {
  const rawPartitions = asRecord(value).partitions;
  const partitions = Array.isArray(rawPartitions) ? rawPartitions : [];
  return { partitions: partitions.map((part): { keyHash: string; lastUsedAt: number } | null => {
    const obj = asRecord(part);
    const keyHash = typeof obj.keyHash === "string" && /^[a-f0-9]{64}$/.test(obj.keyHash) ? obj.keyHash : "";
    if (!keyHash) return null;
    return { keyHash, lastUsedAt: numberOr(obj.lastUsedAt, 0) };
  }).filter((part): part is { keyHash: string; lastUsedAt: number } => Boolean(part)) };
}

function zendeskMemoryEntriesFromStorage(value: unknown, now: number): StoredZendeskTicketMemoryEntry[] {
  const minRememberedAt = now - ZENDESK_MEMORY_TTL_MS;
  return (Array.isArray(value) ? value : [])
    .map(zendeskMemoryEntryFromStorage)
    .filter((entry): entry is StoredZendeskTicketMemoryEntry =>
      entry !== null && entry.rememberedAt >= minRememberedAt)
    .toSorted((a, b) => b.rememberedAt - a.rememberedAt)
    .slice(0, ZENDESK_MEMORY_MAX_ENTRIES);
}

function zendeskMemoryEntryFromStorage(value: unknown): StoredZendeskTicketMemoryEntry | null {
  try {
    const obj = asRecord(value);
    const url = canonicalZendeskTicketUrl(obj.url, obj.id);
    return {
      id: normalizeZendeskTicketId(obj.id),
      ...(url ? { url } : {}),
      title: requiredCleanString(obj.title, "Zendesk memory title", 300),
      status: optionalCleanString(obj.status, 80),
      type: optionalCleanString(obj.type, 80),
      priority: optionalCleanString(obj.priority, 80),
      rememberedAt: numberOr(obj.rememberedAt, 0),
    };
  } catch { return null; }
}

function upsertZendeskMemoryMeta(kv: DurableObjectStorage["kv"], keyHash: string, lastUsedAt: number): void {
  const meta = zendeskMemoryMetaFromStorage(kv.get<unknown>(ZENDESK_MEMORY_META_KEY));
  const checkedPartitions: { keyHash: string; lastUsedAt: number }[] = [];
  for (const part of [{ keyHash, lastUsedAt }, ...meta.partitions.filter(existing => existing.keyHash !== keyHash)]) {
    const partitionKey = zendeskPartitionStorageKey(part.keyHash);
    const entries = zendeskMemoryEntriesFromStorage(kv.get<unknown>(partitionKey), lastUsedAt);
    if (entries.length === 0) {
      kv.delete(partitionKey);
      continue;
    }
    kv.put(partitionKey, entries);
    checkedPartitions.push(part);
  }
  const partitions = checkedPartitions
    .toSorted((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, ZENDESK_MEMORY_MAX_PARTITIONS);
  const keep = new Set(partitions.map(part => part.keyHash));
  for (const evicted of meta.partitions) {
    if (!keep.has(evicted.keyHash)) kv.delete(zendeskPartitionStorageKey(evicted.keyHash));
  }
  kv.put(ZENDESK_MEMORY_META_KEY, { partitions });
}

function touchZendeskTicketMemoryPartition(kv: DurableObjectStorage["kv"], keyHash: string, now: number): void {
  const entries = zendeskMemoryEntriesFromStorage(kv.get<unknown>(zendeskPartitionStorageKey(keyHash)), now);
  if (entries.length === 0) {
    kv.delete(zendeskPartitionStorageKey(keyHash));
    const meta = zendeskMemoryMetaFromStorage(kv.get<unknown>(ZENDESK_MEMORY_META_KEY));
    kv.put(ZENDESK_MEMORY_META_KEY, { partitions: meta.partitions.filter(part => part.keyHash !== keyHash).slice(0, ZENDESK_MEMORY_MAX_PARTITIONS) });
    return;
  }
  kv.put(zendeskPartitionStorageKey(keyHash), entries);
  upsertZendeskMemoryMeta(kv, keyHash, now);
}

function zendeskPartitionStorageKey(keyHash: string): string {
  return `${ZENDESK_MEMORY_PARTITION_KEY_PREFIX}${keyHash}`;
}

function deriveZendeskPartition(item: WorkItemSummary, canonicalUrl: string | undefined): ZendeskTicketMemoryPartition | null {
  const fields = item.fields ?? {};
  const authoritativeBrandId = optionalPartitionDimension(firstScalarField(fields, ["brandId", "brand_id", "brand"]));
  const authoritativeAccountId = optionalPartitionDimension(firstScalarField(fields, ["accountId", "account_id", "organizationId", "organization_id", "account_ref"]));
  const subdomain = subdomainFromCanonicalZendeskUrl(canonicalUrl);
  if (!authoritativeBrandId || !authoritativeAccountId || !subdomain) return null;
  return { brandId: authoritativeBrandId, accountId: authoritativeAccountId, subdomain };
}

function firstScalarField(fields: Record<string, string | number | boolean | null>, names: string[]): string | undefined {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function normalizeZendeskPartition(value: unknown): ZendeskTicketMemoryPartition {
  const obj = asRecord(value);
  return {
    brandId: requiredCleanString(obj.brandId, "Zendesk memory brandId", 120),
    accountId: requiredCleanString(obj.accountId, "Zendesk memory accountId", 120),
    subdomain: normalizeZendeskSubdomain(obj.subdomain),
  };
}

function normalizeZendeskTicketId(value: unknown): string {
  return requiredCleanString(value, "Zendesk ticket id", 180);
}

function normalizeZendeskSubdomain(value: unknown): string {
  const subdomain = requiredCleanString(value, "Zendesk subdomain", 120).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/.test(subdomain)) throw new Error("Invalid Zendesk subdomain.");
  return subdomain;
}

function optionalPartitionDimension(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredCleanString(value, "Zendesk memory partition dimension", 120);
}

function subdomainFromCanonicalZendeskUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !host.endsWith(".zendesk.com") || host === "zendesk.com") return undefined;
  return normalizeZendeskSubdomain(host.slice(0, -".zendesk.com".length));
}

function canonicalZendeskTicketUrl(value: unknown, ticketIdValue: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || !host.endsWith(".zendesk.com") || host === "zendesk.com") return undefined;
    const ticketId = normalizeZendeskTicketId(ticketIdValue);
    if (!isRecognizedZendeskTicketPath(url.pathname, ticketId)) return undefined;
    return boundString(`${url.protocol}//${url.host}${url.pathname}`, 500);
  } catch { return undefined; }
}

function isRecognizedZendeskTicketPath(pathname: string, ticketId: string): boolean {
  const parts = pathname.split("/").filter(Boolean).map(part => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  for (let i = 0; i < parts.length - 1; i++) {
    if ((parts[i] === "tickets" || parts[i] === "requests") && parts[i + 1] === ticketId) return true;
  }
  return false;
}

function requiredCleanString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error(`${name} is required.`);
  const out = boundCleanString(String(value), max);
  if (!out) throw new Error(`${name} is required.`);
  return out;
}

function optionalCleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
  const out = boundCleanString(String(value), max);
  return out || undefined;
}

function boundCleanString(value: string, max: number): string {
  const out = boundString(value.trim(), max);
  if (/\p{C}/u.test(out)) throw new Error("Control characters are not allowed in Zendesk ticket memory fields.");
  return out;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function zendeskMemoryText(entry: ZendeskTicketMemoryEntry): string {
  return [entry.id, entry.url, entry.title, entry.status, entry.type, entry.priority].filter(Boolean).join("\n").toLowerCase();
}

async function zendeskPartitionHash(partition: ZendeskTicketMemoryPartition): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(partition));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function commentsFromEnvelope(source: WorkItemProviderKind, value: unknown): WorkItemComment[] {
  const comments = asRecord(value).comments;
  return (Array.isArray(comments) ? comments : []).slice(0, 50).map((comment) => commentFromValue(source, comment));
}

function activityFromEnvelope(value: unknown): WorkItemActivity[] {
  const activity = asRecord(value).activity;
  return (Array.isArray(activity) ? activity : []).slice(0, 50).map(activityFromValue);
}

function attachmentsFromEnvelope(value: unknown): WorkItemAttachment[] {
  const attachments = asRecord(value).attachments;
  return (Array.isArray(attachments) ? attachments : []).slice(0, 100).map(attachmentFromValue).filter((attachment): attachment is WorkItemAttachment => Boolean(attachment));
}

function attachmentFromValue(value: unknown): WorkItemAttachment | null {
  const obj = asRecord(value);
  const id = boundString(stringField(obj.id, ""), 180);
  const name = safeFileName(stringField(obj.name, id || "attachment"));
  if (!id || !name) return null;
  const size = typeof obj.size === "number" && Number.isFinite(obj.size) && obj.size >= 0 ? Math.min(Math.floor(obj.size), 10_000_000_000) : undefined;
  return {
    id,
    name,
    contentType: optionalContentType(obj.contentType),
    size,
    createdAt: optionalBoundString(obj.createdAt, 80),
    commentId: optionalBoundString(obj.commentId, 180),
  };
}

function updateOptionsFromEnvelope(ref: WorkItemProviderRef, value: unknown): WorkItemUpdateOptions {
  const obj = asRecord(value);
  return {
    ...ref,
    allowedFields: stringArray(obj.allowedFields, 40, 120),
    providerOptions: stringArray(obj.providerOptions, 100, 120),
  };
}

function transitionsFromEnvelope(value: unknown): WorkItemTransition[] {
  const transitions = asRecord(value).transitions;
  return (Array.isArray(transitions) ? transitions : []).slice(0, 50).map((transition) => {
    const obj = asRecord(transition);
    return {
      id: boundString(stringField(obj.id, ""), 80),
      name: boundString(stringField(obj.name, ""), 120),
      toStatus: optionalBoundString(obj.toStatus, 120),
    };
  }).filter(transition => transition.id && transition.name);
}

function workItemSummaryFromValue(value: unknown): WorkItemSummary | null {
  const obj = asRecord(value);
  const source = workItemSourceOrNull(obj.source);
  const id = boundString(stringField(obj.id, ""), 180);
  const title = boundString(stringField(obj.title, id), 300);
  if (!source || !id || !title) return null;
  return {
    source,
    id,
    key: optionalBoundString(obj.key, 80),
    url: safeWorkItemUrl(obj.url),
    title,
    status: optionalBoundString(obj.status, 80),
    type: optionalBoundString(obj.type, 80),
    priority: optionalBoundString(obj.priority, 80),
    assignee: optionalBoundString(obj.assignee, 120),
    requester: optionalBoundString(obj.requester, 120),
    updatedAt: optionalBoundString(obj.updatedAt, 80),
    projectKey: optionalBoundString(obj.projectKey, 40),
    description: descriptionFromValue(obj.description ?? asRecord(obj.fields).description),
    fields: normalizedScalarFields(obj.fields),
  };
}

function descriptionFromValue(value: unknown): { body: string; format: "text" | "markdown"; truncated?: boolean } | undefined {
  const obj = asRecord(value);
  const body = typeof value === "string" ? value : stringField(obj.body, "");
  if (!body) return undefined;
  return {
    body: boundString(body, WORK_ITEM_DESCRIPTION_MAX),
    format: obj.format === "markdown" ? "markdown" : "text",
    truncated: obj.truncated === true || body.length > WORK_ITEM_DESCRIPTION_MAX ? true : undefined,
  };
}

function commentFromValue(source: WorkItemProviderKind, value: unknown): WorkItemComment {
  const obj = asRecord(value);
  return {
    id: boundString(stringField(obj.id, ""), 80),
    author: optionalBoundString(obj.author, 120),
    body: boundString(stringField(obj.body, ""), WORK_ITEM_FIELD_MAX),
    public: source === "zendesk" ? obj.public !== false : true,
    createdAt: optionalBoundString(obj.createdAt, 80),
  };
}

function activityFromValue(value: unknown): WorkItemActivity {
  const obj = asRecord(value);
  return {
    id: boundString(stringField(obj.id, ""), 80),
    type: boundString(stringField(obj.type, ""), 80),
    author: optionalBoundString(obj.author, 120),
    createdAt: optionalBoundString(obj.createdAt, 80),
    summary: boundString(stringField(obj.summary, ""), 500),
  };
}

function normalizeWorkItemSearchRequest(request: WorkItemSearchRequest): Required<Pick<WorkItemSearchRequest, "source" | "cursors">> & Pick<WorkItemSearchRequest, "query" | "limit"> {
  const source = request?.source === "jira" || request?.source === "zendesk" || request?.source === "both" ? request.source : "both";
  const cursors = asRecord(request?.cursors) as Partial<Record<WorkItemProviderKind, string>>;
  return {
    source,
    query: typeof request?.query === "string" ? boundString(request.query, 300) : undefined,
    limit: typeof request?.limit === "number" ? Math.max(1, Math.min(50, Math.floor(request.limit))) : undefined,
    cursors: {
      jira: typeof cursors.jira === "string" ? boundString(cursors.jira, 500) : undefined,
      zendesk: typeof cursors.zendesk === "string" ? boundString(cursors.zendesk, 500) : undefined,
    },
  };
}

function normalizeWorkItemRef(ref: WorkItemProviderRef): WorkItemProviderRef {
  const source = workItemSourceOrNull(ref?.source);
  const id = typeof ref?.id === "string" ? boundString(ref.id.trim(), 180) : "";
  if (!source || !id || /[\r\n]/.test(id)) throw new Error("Invalid Team PI Work Items item reference.");
  return { source, id, key: optionalBoundString(ref.key, 80) };
}

function normalizeFieldPatch(patch: WorkItemFieldPatch): Record<string, string | number | boolean | null | string[]> {
  const fields = asRecord(patch?.fields);
  const out: Record<string, string | number | boolean | null | string[]> = {};
  for (const [rawKey, value] of Object.entries(fields).slice(0, 10)) {
    const key = boundString(rawKey, 120);
    if (!key || /[\r\n]/.test(key)) continue;
    if (value === null || typeof value === "boolean" || typeof value === "number") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.filter((item): item is string => typeof item === "string").slice(0, 50).map(item => boundString(item, 200));
    else out[key] = boundString(String(value ?? ""), key.toLowerCase() === "description" ? WORK_ITEM_DESCRIPTION_MAX : WORK_ITEM_FIELD_MAX);
  }
  return out;
}

function jiraZendeskPair(a: WorkItemProviderRef, b: WorkItemProviderRef): { jiraId: string; zendeskTicketId: string } {
  if (a.source === "jira" && b.source === "zendesk") return { jiraId: a.id, zendeskTicketId: b.id };
  if (a.source === "zendesk" && b.source === "jira") return { jiraId: b.id, zendeskTicketId: a.id };
  throw new Error("Team PI Work Items can only link a Jira item to a Zendesk item.");
}

function linkResultFromEnvelope(value: unknown, fallback: { jiraId: string; zendeskTicketId: string }): WorkItemLinkResult {
  const link = asRecord(asRecord(value).link);
  return {
    globalId: boundString(stringField(link.globalId, ""), 160),
    jiraId: boundString(stringField(link.jiraId, fallback.jiraId), 180),
    zendeskTicketId: boundString(stringField(link.zendeskTicketId, fallback.zendeskTicketId), 180),
  };
}

function providerError(source: WorkItemProviderKind, error: unknown): WorkItemProviderError {
  return {
    source,
    message: boundString(error instanceof Error ? error.message : String(error), 240),
    status: error instanceof TeamPiApiError ? error.status : undefined,
  };
}

function savedViewsFromStorage(value: unknown): WorkItemSavedView[] {
  return (Array.isArray(value) ? value : [])
    .map((view) => {
      try { return normalizeSavedView(view); }
      catch { return null; }
    })
    .filter((view): view is WorkItemSavedView => Boolean(view))
    .slice(-WORK_ITEM_SAVED_VIEWS_MAX);
}

function normalizeSavedView(value: unknown): WorkItemSavedView {
  const obj = asRecord(value);
  const id = normalizeSavedViewId(obj.id);
  const name = boundString(stringField(obj.name, "").trim(), 120);
  if (!name) throw new Error("Saved Work Items view name is required.");
  return {
    id,
    name,
    query: boundString(stringField(obj.query, "").trim(), 300),
    source: obj.source === "jira" || obj.source === "zendesk" || obj.source === "both" ? obj.source : "both",
    filters: normalizeSavedViewFilters(obj.filters),
    view: obj.view === "kanban" ? "kanban" : "list",
    hiddenStatuses: normalizeSavedViewStringArray(obj.hiddenStatuses),
  };
}

function normalizeSavedViewId(value: unknown): string {
  const id = typeof value === "string" ? boundString(value.trim(), 120) : "";
  if (!id || /[\r\n]/.test(id)) throw new Error("Saved Work Items view id is required.");
  if (id.startsWith("builtin:")) throw new Error("Saved Work Items view id is reserved.");
  return id;
}

function normalizeSavedViewFilters(value: unknown): WorkItemSavedViewFilters {
  const obj = asRecord(value);
  return {
    status: normalizeSavedViewString(obj.status),
    priority: normalizeSavedViewString(obj.priority),
    type: normalizeSavedViewString(obj.type),
    person: normalizeSavedViewString(obj.person),
  };
}

function normalizeSavedViewString(value: unknown): string {
  return typeof value === "string" ? boundString(value.trim(), 120) : "";
}

function normalizeSavedViewStringArray(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .filter((item): item is string => typeof item === "string")
    .map(item => boundString(item.trim(), 120))
    .filter(Boolean)
    .slice(0, 25);
}

function workItemSourceOrNull(value: unknown): WorkItemProviderKind | null {
  return value === "jira" || value === "zendesk" ? value : null;
}

function normalizedScalarFields(value: unknown): Record<string, string | number | boolean | null> {
  const fields = asRecord(value);
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, child] of Object.entries(fields).slice(0, 40)) {
    const safeKey = boundString(key, 120);
    if (!safeKey || /^customfield_\d+$/i.test(safeKey) || safeKey === "providerOptions") continue;
    if (child === null || typeof child === "number" || typeof child === "boolean") out[safeKey] = child;
    else if (Array.isArray(child)) out[safeKey] = boundString(child.map(item => String(item ?? "")).join(", "), WORK_ITEM_FIELD_MAX);
    else if (typeof child === "object" && child !== null) continue;
    else out[safeKey] = boundString(String(child ?? ""), WORK_ITEM_FIELD_MAX);
  }
  return out;
}

function safeFileName(value: string): string {
  return boundString(value.replace(/[\\/\r\n]/g, "_").trim(), 240);
}

function optionalContentType(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 160 || /[\r\n]/.test(value)) return undefined;
  return value.toLowerCase();
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  return (Array.isArray(value) ? value : [])
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .slice(0, maxItems)
    .map(item => boundString(item, maxLength));
}

function safeWorkItemUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? boundString(url.toString(), 500) : undefined;
  } catch { return undefined; }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function optionalBoundString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? boundString(value, max) : undefined;
}

function boundString(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function providerOrUnknown(value: string): TeamPiProvider | "unknown" {
  try { return safeProvider(value); } catch { return "unknown"; }
}

export function safeConnectionUrl(value: unknown, baseUrl: string, provider: TeamPiProvider): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const base = new URL(baseUrl);
    const url = new URL(value, base);
    if (url.protocol !== "https:" || url.origin !== base.origin) return undefined;
    if (url.pathname !== `/connect/${provider}/page`) return undefined;
    const user = url.searchParams.get("user");
    const shared = url.searchParams.get("shared");
    url.search = "";
    if (user) url.searchParams.set("user", boundString(user, 320));
    if (shared === "1") url.searchParams.set("shared", "1");
    return url.toString();
  } catch { return undefined; }
}

function safeConnectionStatus(value: unknown): Record<string, Record<string, boolean>> | undefined {
  const source = asRecord(value);
  const result: Record<string, Record<string, boolean>> = {};
  for (const scope of ["user", "shared", "token"] as const) {
    const providers: Record<string, boolean> = {};
    for (const [provider, connected] of Object.entries(asRecord(source[scope]))) {
      if (providerOrUnknown(provider) !== "unknown" && typeof connected === "boolean") {
        providers[provider] = connected;
      }
    }
    result[scope] = providers;
  }
  return Object.keys(source).length > 0 ? result : undefined;
}

function safeRequiredConnections(value: unknown): Record<string, TeamPiProvider[]> | undefined {
  const source = asRecord(value);
  const result: Record<string, TeamPiProvider[]> = {};
  for (const scope of ["user", "shared", "token"] as const) {
    const providers = Array.isArray(source[scope]) ? source[scope] : [];
    result[scope] = providers
      .filter((provider): provider is string => typeof provider === "string")
      .map(providerOrUnknown)
      .filter((provider): provider is TeamPiProvider => provider !== "unknown")
      .slice(0, 25);
  }
  return Object.keys(source).length > 0 ? result : undefined;
}

export function catalogEntries(kind: "skill" | "connection", value: unknown): AgentCatalogEntry[] {
  return normalizePage(value).items.map((item, index) => {
    const obj = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const id = typeof obj.id === "string" ? obj.id : `${kind}:${index}`;
    const title = typeof obj.name === "string" ? obj.name : typeof obj.title === "string" ? obj.title : id;
    const description = typeof obj.description === "string" ? obj.description : `${kind} available in Team PI`;
    return { id: `${kind}:${id}`, title, description };
  });
}

function pendingKey(action: number): string { return `pending:${action}`; }
function applyingKey(action: number): string { return `applying:${action}`; }
function resultKey(action: number): string { return `result:${action}`; }

export function claimPendingAction(kv: DurableObjectStorage["kv"], action: number): PendingAction | null {
  const pending = kv.get<PendingAction>(pendingKey(action));
  if (!pending) {
    if (kv.get<ApplyingAction>(applyingKey(action))) throw new Error(`Team PI action is already applying: ${action}`);
    const result = kv.get<TeamPiActionResult>(resultKey(action));
    if (result && result.status !== "pending") return null;
    throw new Error(`Unknown Team PI action: ${action}`);
  }
  kv.put<ApplyingAction>(applyingKey(action), { ...pending, claimedAt: Date.now() });
  kv.delete(pendingKey(action));
  return pending;
}

export function rejectPendingAction(kv: DurableObjectStorage["kv"], action: number): void {
  if (kv.get<ApplyingAction>(applyingKey(action))) throw new Error(`Team PI action is already applying: ${action}`);
  if (!kv.get<PendingAction>(pendingKey(action))) {
    const result = kv.get<TeamPiActionResult>(resultKey(action));
    if (result && result.status !== "pending") return;
    // An action this binding has no record of. Refusing here would leave the Workshop holding an
    // approval the user cannot dismiss, so record the rejection instead: one cannot fail to *not*
    // do something, and a spurious rejected result is harmless where a wedged approval is not.
    kv.put(resultKey(action), { status: "rejected" });
    return;
  }
  kv.delete(pendingKey(action));
  kv.put(resultKey(action), { status: "rejected" });
}
function escapeMd(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

function connectPage(accountId: string, nonce: string): { body: string; csp: string } {
  void accountId;
  void nonce;
  const scriptNonce = crypto.randomUUID().replace(/-/g, "");
  return {
    csp: `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
    body: `<!doctype html><meta charset="utf-8"><title>Connect Team PI</title><main style="font-family:system-ui;max-width:720px;margin:4rem auto"><h1>Connect Team PI</h1><button id="start" type="button">Start device authorization</button><div id="out" style="white-space:pre-wrap;background:#f3f4f6;padding:1rem;margin-top:1rem"></div><button id="poll" type="button" hidden>I've authorized Team PI</button><script nonce="${scriptNonce}">const out=document.getElementById('out'),poll=document.getElementById('poll'),base=location.pathname;function text(v){out.textContent=v}function showDevice(j){out.textContent='Open: ';const a=document.createElement('a');a.href=j.verificationUriComplete||j.verificationUri;a.target='_blank';a.rel='noopener';a.textContent=j.verificationUri;out.append(a,document.createTextNode('\\nCode: '+j.userCode+'\\nExpires: '+new Date(j.expiresAt).toLocaleString()));poll.hidden=false}document.getElementById('start').onclick=async()=>{const r=await fetch(base+'?op=start',{method:'POST'});const j=await r.json();if(j.error){text(j.error);return}showDevice(j)};poll.onclick=async()=>{const r=await fetch(base+'?op=poll',{method:'POST'});const j=await r.json();if(j.status==='complete'){text('Connected. Returning to Odie…');setTimeout(()=>window.close(),500)}else text(j.error||'Still waiting for authorization.')};</script></main>`,
  };
}
