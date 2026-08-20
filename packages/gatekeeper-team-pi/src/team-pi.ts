import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  boundAgentCatalog,
  type AccountDescription,
  type ActionKind,
  type AgentCatalog,
  type AgentCatalogEntry,
  type ApprovalQueue,
  type ConnectionHealthStatus,
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
import type { TeamPiActionResult, TeamPiConnection, TeamPiQueuedAction, TeamPiSession, TeamPiSkill, TeamPiSkillCheck } from "./types.js";

type TeamPiLogFields = { event?: string; vendorId?: string; accountId?: string; status?: number; error?: unknown };

const logger = createLogger<TeamPiLogFields>({ component: "gatekeeper.team-pi", vendorId: "team-pi" });
const ICON = { url: "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'><rect width='256' height='256' rx='56' fill='#111827'/><text x='50%' y='54%' dominant-baseline='middle' text-anchor='middle' font-family='Arial' font-size='82' fill='white'>PI</text></svg>") };
const CONNECT_TIMEOUT_MS = 15 * 60 * 1000;
const ACCESS_TOKEN_SAFETY_MS = 60_000;
const ID_TOKEN_REFRESH_RETRY_MS = 5 * 60 * 1000;
const APPLYING_TIMEOUT_MS = 5 * 60 * 1000;
const SKILL_INSTRUCTIONS_MAX_LENGTH = 12_000;
const ACCOUNT_URL = "team-pi://account";
const ACCOUNT_RESOURCE: SupportedResource = {
  urlPattern: ACCOUNT_URL,
  title: "Team PI Account",
  description: "Per-user Team PI skills, connections, calendar, Gmail, Chorus, Zendesk, and Salesforce APIs.",
  providedBySingleton: true,
};

type StoredDevice = { nonce: string; deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete?: string; expiresAt: number; intervalMs: number };
type StoredIdentity = { displayName?: string; uniqueName?: string };
type Props = { accountId: string };
type PendingAction = { kind: "installSkill"; skillId: string } | { kind: "startConnection"; provider: TeamPiProvider };
type ApplyingAction = PendingAction & { claimedAt: number };

const PROVIDER_CATALOG_ENTRIES: AgentCatalogEntry[] = [
  { id: "provider:gmail", title: "Gmail", description: "Search and read Gmail messages available through Team PI." },
  { id: "provider:calendar", title: "Calendar", description: "Read calendar events available through Team PI." },
  { id: "provider:chorus", title: "Chorus", description: "Search calls and read customer account, engagement, and conversation details through Team PI." },
  { id: "provider:zendesk", title: "Zendesk", description: "Search and read support tickets available through Team PI." },
  { id: "provider:salesforce", title: "Salesforce", description: "Read customer account records available through Team PI." },
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
      description: "Connect Team PI with Auth0 device authorization to expose approved per-user skills, connections, calendar, Gmail, Chorus, Zendesk, and Salesforce APIs to agents.",
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

  async getApiCredentials(): Promise<{ accessToken: string; idToken?: string }> {
    let accessToken = await this.getAccessToken();
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
      this.ctx.storage.kv.delete("idToken");
      this.ctx.storage.kv.delete("idTokenExpiresAt");
      this.ctx.storage.kv.delete("identity");
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
  async describe(): Promise<AccountDescription> {
    const identity = await this.#account().describeIdentity();
    return { displayName: identity.displayName ?? identity.uniqueName ?? "Team PI", uniqueName: identity.uniqueName, avatar: ICON, singleton: { tsType: "TeamPiSession" } };
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
export class TeamPiVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier { verify(): void {} }

@validateRpc()
export class TeamPiGatekeeper extends DurableObject<Env, Props> implements Gatekeeper<TeamPiSession> {
  #account(): DurableObjectStub<TeamPiAccount> { return this.ctx.exports.TeamPiAccount.get(this.ctx.exports.TeamPiAccount.idFromString(this.ctx.props.accountId)); }
  #api(): TeamPiApi { return new TeamPiApi(() => this.#account().getApiCredentials(), resolveConfig(this.env).baseUrl); }
  async describe(): Promise<ResourceDescription> { return { url: ACCOUNT_URL, title: "Team PI", snippet: "Broad per-user Team PI singleton with approved reads and staged writes.", suggestedBindingName: "TEAM_PI", tsType: "TeamPiSession" }; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }
  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<TeamPiSession> { return new TeamPiSessionImpl(this.#api(), approvalQueue.dup(), this.ctx.storage.kv); }
  async getAgentCatalog(authorizer: RpcStub<ObservationAuthorizer>): Promise<AgentCatalog> {
    try {
      const skills = await this.#api().listSkills({ limit: 12 });
      const entries = [...catalogEntries("skill", skillsFromEnvelope(skills)), ...PROVIDER_CATALOG_ENTRIES];
      await authorizer.authorizeObservation({
        title: "Read Team PI skill and provider catalog",
        description: "Listed bounded Team PI skill manifests and provider capabilities for agent discovery.",
      });
      return boundAgentCatalog(entries);
    } catch (error) {
      logger.warn("team pi catalog fallback used", {
        event: "team_pi.catalog.fallback.used", accountId: this.ctx.props.accountId, error,
      });
      const message = boundString(error instanceof Error ? error.message : String(error), 512);
      await authorizer.authorizeObservation({
        title: "Team PI catalog unavailable",
        description: message,
      });
      return boundAgentCatalog([{
        id: "team-pi:catalog-unavailable",
        title: "Team PI unavailable",
        description: message,
      }]);
    }
  }
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> { throw new Error("Team PI observations are private to the connected user and cannot be observed by collaborators."); }
  async removeObserver(_id: string): Promise<void> {}
  async applyAction(action: number): Promise<void> {
    const pending = claimPendingAction(this.ctx.storage.kv, action);
    if (!pending) return;
    try {
      const raw = pending.kind === "installSkill" ? await this.#api().installSkill(pending.skillId) : await this.#api().startConnection(pending.provider);
      const result = pending.kind === "installSkill"
        ? sanitizeInstallSkillResult(raw)
        : sanitizeStartConnectionResult(pending.provider, raw, resolveConfig(this.env).baseUrl);
      this.ctx.storage.kv.put(resultKey(action), { status: "ready", result });
    } catch (error) {
      this.ctx.storage.kv.put(resultKey(action), {
        status: "unknown",
        message: boundString(error instanceof Error ? error.message : String(error), 512),
        canRetry: false,
      });
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
  async getActionResult(actionId: number): Promise<TeamPiActionResult> { return getStoredActionResult(this.kv, actionId); }
  private async read<T>(title: string, description: string, fn: () => Promise<T>): Promise<T> { const result = await fn(); await this.approvalQueue.authorizeObservation({ title, description, prohibitAllSharing: true }); return result; }
  private async queue(action: PendingAction, title: string, description: string): Promise<TeamPiQueuedAction> {
    const actionId = (this.kv.get<number>("nextActionId") ?? 1);
    this.kv.put("nextActionId", actionId + 1);
    this.kv.put(pendingKey(actionId), action);
    this.kv.put(resultKey(actionId), { status: "pending" });
    try {
      await this.approvalQueue.submitAction(actionId, { title, description, implementsRevert: false, awaitDecision: true, actionKind: { tag: `team-pi.${action.kind}`, label: action.kind === "installSkill" ? "Install Team PI skill" : "Start Team PI connection" } });
    } catch (error) {
      this.kv.delete(pendingKey(actionId));
      this.kv.delete(resultKey(actionId));
      throw error;
    }
    return { actionId, status: "pending", pollAfterMs: 1000 };
  }
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
function escapeMd(value: string): string { return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&"); }

function connectPage(accountId: string, nonce: string): { body: string; csp: string } {
  void accountId;
  void nonce;
  const scriptNonce = crypto.randomUUID().replace(/-/g, "");
  return {
    csp: `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
    body: `<!doctype html><meta charset="utf-8"><title>Connect Team PI</title><main style="font-family:system-ui;max-width:720px;margin:4rem auto"><h1>Connect Team PI</h1><button id="start" type="button">Start device authorization</button><div id="out" style="white-space:pre-wrap;background:#f3f4f6;padding:1rem;margin-top:1rem"></div><button id="poll" type="button" hidden>I've authorized Team PI</button><script nonce="${scriptNonce}">const out=document.getElementById('out'),poll=document.getElementById('poll'),base=location.pathname;function text(v){out.textContent=v}function showDevice(j){out.textContent='Open: ';const a=document.createElement('a');a.href=j.verificationUriComplete||j.verificationUri;a.target='_blank';a.rel='noopener';a.textContent=j.verificationUri;out.append(a,document.createTextNode('\\nCode: '+j.userCode+'\\nExpires: '+new Date(j.expiresAt).toLocaleString()));poll.hidden=false}document.getElementById('start').onclick=async()=>{const r=await fetch(base+'?op=start',{method:'POST'});const j=await r.json();if(j.error){text(j.error);return}showDevice(j)};poll.onclick=async()=>{const r=await fetch(base+'?op=poll',{method:'POST'});const j=await r.json();text(j.status==='complete'?'Connected. You may close this tab.':(j.error||'Still waiting for authorization.'))};</script></main>`,
  };
}
