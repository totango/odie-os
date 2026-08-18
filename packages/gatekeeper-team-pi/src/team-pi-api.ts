const MAX_ID_LENGTH = 256;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_RESPONSE_BYTES = 256_000;
const MAX_STRING_LENGTH = 16_000;
const MAX_ARRAY_LENGTH = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 8;

export class TeamPiApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403 || this.code === "invalid_grant";
  }
}

export type TokenGrant = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  idToken?: string;
};

export type TeamPiApiCredentials = {
  accessToken: string;
  idToken?: string;
};

export type TeamPiConfig = {
  auth0Domain: string;
  clientId: string;
  audience: string;
  baseUrl: string;
};

export type DeviceCodeStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
};

export type ListOptions = { query?: string; limit?: number; cursor?: string };
export type CalendarOptions = { startIso: string; endIso: string; limit?: number; calendarId?: string };
export type SearchOptions = { query: string; limit?: number; cursor?: string };
export type TeamPiProvider = "gmail" | "calendar" | "chorus" | "zendesk" | "salesforce" | "docs";

const PROVIDERS = new Set<TeamPiProvider>(["gmail", "calendar", "chorus", "zendesk", "salesforce", "docs"]);

type ReadEndpoint =
  | "listSkills" | "getSkill" | "checkSkill" | "listConnections" | "calendarEvents"
  | "gmailSearch" | "gmailMessage" | "chorusSearch" | "chorusAccount" | "chorusEngagement"
  | "chorusConversation" | "zendeskSearch" | "zendeskTicket" | "salesforceAccount";
type WriteEndpoint = "installSkill" | "startConnection";

const READ_ENDPOINTS = new Set<ReadEndpoint>([
  "listSkills", "getSkill", "checkSkill", "listConnections", "calendarEvents", "gmailSearch",
  "gmailMessage", "chorusSearch", "chorusAccount", "chorusEngagement", "chorusConversation",
  "zendeskSearch", "zendeskTicket", "salesforceAccount",
]);
const WRITE_ENDPOINTS = new Set<WriteEndpoint>(["installSkill", "startConnection"]);

export function resolveConfig(env: Env): TeamPiConfig {
  const auth0Domain = normalizeHttpsBaseUrl(env.TEAM_PI_AUTH0_DOMAIN, "TEAM_PI_AUTH0_DOMAIN");
  const baseUrl = normalizeHttpsBaseUrl(env.TEAM_PI_BASE_URL, "TEAM_PI_BASE_URL");
  return {
    auth0Domain,
    clientId: required(env.TEAM_PI_AUTH0_CLIENT_ID, "TEAM_PI_AUTH0_CLIENT_ID"),
    audience: required(env.TEAM_PI_AUTH0_AUDIENCE, "TEAM_PI_AUTH0_AUDIENCE"),
    baseUrl,
  };
}

export function assertAllowedEndpoint(kind: "read", endpoint: string): asserts endpoint is ReadEndpoint;
export function assertAllowedEndpoint(kind: "write", endpoint: string): asserts endpoint is WriteEndpoint;
export function assertAllowedEndpoint(kind: "read" | "write", endpoint: string): void {
  const allowed = kind === "read" ? READ_ENDPOINTS : WRITE_ENDPOINTS;
  if (!allowed.has(endpoint as never)) throw new Error(`Team PI endpoint not allowed: ${endpoint}`);
}

export async function startDeviceAuthorization(config: TeamPiConfig): Promise<DeviceCodeStart> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    audience: config.audience,
    scope: "openid profile email offline_access",
  });
  const json = await auth0Post(config, "/oauth/device/code", body);
  return {
    deviceCode: boundedString(requiredJsonString(json, "device_code"), MAX_ID_LENGTH),
    userCode: boundedString(requiredJsonString(json, "user_code"), 128),
    verificationUri: trustedAuthUrl(requiredJsonString(json, "verification_uri"), config.auth0Domain),
    verificationUriComplete: trustedOptionalAuthUrl(json, "verification_uri_complete", config.auth0Domain),
    expiresIn: boundedPositiveInt(json.expires_in, 900),
    interval: boundedPositiveInt(json.interval, 5),
  };
}

export async function pollDeviceAuthorization(config: TeamPiConfig, deviceCode: string): Promise<TokenGrant | "pending"> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: config.clientId,
    device_code: safeId(deviceCode, "device code"),
  });
  const response = await fetch(`${config.auth0Domain}/oauth/token`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await boundedJson(response);
  if (!response.ok) {
    const code = typeof json.error === "string" ? json.error : undefined;
    if (code === "authorization_pending" || code === "slow_down") return "pending";
    throw new TeamPiApiError(`Auth0 device authorization failed: ${code ?? response.statusText}`, response.status, code);
  }
  return parseGrant(json);
}

export async function refreshAccessToken(config: TeamPiConfig, refreshToken: string): Promise<TokenGrant> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: refreshToken,
    scope: "openid profile email offline_access",
  });
  return parseGrant(await auth0Post(config, "/oauth/token", body));
}

export async function revokeRefreshToken(config: TeamPiConfig, refreshToken: string): Promise<void> {
  const body = new URLSearchParams({ client_id: config.clientId, token: refreshToken });
  const response = await fetch(`${config.auth0Domain}/oauth/revoke`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new TeamPiApiError("Auth0 token revocation failed", response.status);
}

export class TeamPiApi {
  constructor(
    private readonly getCredentials: () => Promise<TeamPiApiCredentials>,
    private readonly baseUrl: string,
  ) {}

  listSkills(options: ListOptions = {}): Promise<unknown> {
    assertAllowedEndpoint("read", "listSkills");
    return this.request("GET", "/api/skills", listParams(options));
  }

  getSkill(skillId: string): Promise<unknown> {
    assertAllowedEndpoint("read", "getSkill");
    return this.request("GET", `/api/skills/${encodeURIComponent(safeId(skillId, "skillId"))}`);
  }

  checkSkill(skillId: string): Promise<unknown> {
    assertAllowedEndpoint("read", "checkSkill");
    return this.request("GET", `/api/skills/${encodeURIComponent(safeId(skillId, "skillId"))}/check`);
  }

  listConnections(options: ListOptions = {}): Promise<unknown> {
    assertAllowedEndpoint("read", "listConnections");
    return this.request("GET", "/connections", listParams(options));
  }

  calendarEvents(options: CalendarOptions): Promise<unknown> {
    assertAllowedEndpoint("read", "calendarEvents");
    return this.request("GET", "/calendar/events", calendarParams(options));
  }

  gmailSearch(options: SearchOptions): Promise<unknown> {
    assertAllowedEndpoint("read", "gmailSearch");
    return this.request("GET", "/gmail/search", searchParams(options));
  }

  gmailMessage(messageId: string): Promise<unknown> {
    assertAllowedEndpoint("read", "gmailMessage");
    return this.request("GET", `/gmail/message/${encodeURIComponent(safeId(messageId, "messageId"))}`);
  }

  chorusSearch(options: SearchOptions): Promise<unknown> {
    assertAllowedEndpoint("read", "chorusSearch");
    return this.request("GET", "/chorus/search", chorusSearchParams(options));
  }

  chorusAccount(accountId: string): Promise<unknown> {
    assertAllowedEndpoint("read", "chorusAccount");
    const params = new URLSearchParams({ q: safeId(accountId, "accountId") });
    return this.request("GET", "/chorus/account", params);
  }

  chorusEngagement(engagementId: string): Promise<unknown> {
    assertAllowedEndpoint("read", "chorusEngagement");
    return this.request("GET", `/chorus/engagement/${encodeURIComponent(safeId(engagementId, "engagementId"))}`);
  }

  chorusConversation(conversationId: string): Promise<unknown> {
    assertAllowedEndpoint("read", "chorusConversation");
    return this.request("GET", `/chorus/conversation/${encodeURIComponent(safeId(conversationId, "conversationId"))}`);
  }

  zendeskSearch(options: SearchOptions): Promise<unknown> {
    assertAllowedEndpoint("read", "zendeskSearch");
    return this.request("GET", "/zendesk/search", searchParams(options));
  }

  zendeskTicket(ticketId: string): Promise<unknown> {
    assertAllowedEndpoint("read", "zendeskTicket");
    return this.request("GET", `/zendesk/ticket/${encodeURIComponent(safeId(ticketId, "ticketId"))}`);
  }

  salesforceAccount(accountId: string): Promise<unknown> {
    assertAllowedEndpoint("read", "salesforceAccount");
    const params = new URLSearchParams({ q: safeId(accountId, "accountId") });
    return this.request("GET", "/salesforce/account", params);
  }

  installSkill(skillId: string): Promise<unknown> {
    assertAllowedEndpoint("write", "installSkill");
    return this.request("POST", `/api/skills/${encodeURIComponent(safeId(skillId, "skillId"))}/install`);
  }

  startConnection(provider: TeamPiProvider): Promise<unknown> {
    assertAllowedEndpoint("write", "startConnection");
    return this.request("POST", `/connect/${encodeURIComponent(safeProvider(provider))}`);
  }

  private async request(method: "GET" | "POST", path: string, params?: URLSearchParams): Promise<unknown> {
    const credentials = await this.getCredentials();
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) url.search = params.toString();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
    };
    if (credentials.idToken) headers["X-Team-PI-ID-Token"] = credentials.idToken;
    const response = await fetch(url, {
      method,
      redirect: "manual",
      headers,
    });
    const json = await boundedJson(response);
    if (!response.ok) {
      const code = typeof json.error === "string" ? json.error : undefined;
      if (response.status === 401) {
        throw new TeamPiApiError(
          "Team PI rejected the stored credentials. Reconnect Team PI from Connections, then retry.",
          response.status,
          code,
        );
      }
      if (response.status === 403) {
        throw new TeamPiApiError(
          "Team PI denied access. Reconnect Team PI or connect the required provider/skill, then retry.",
          response.status,
          code,
        );
      }
      throw new TeamPiApiError(`Team PI API failed: ${response.statusText}`, response.status, code);
    }
    return boundJsonValue(json);
  }
}

export function safeProvider(value: string): TeamPiProvider {
  if (!PROVIDERS.has(value as TeamPiProvider)) throw new Error(`Invalid Team PI provider: ${value}.`);
  return value as TeamPiProvider;
}

export function safeId(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH || hasControlCharacter(value)) {
    throw new Error(`Invalid Team PI ${name}.`);
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; ++i) {
    if (value.charCodeAt(i) < 32) return true;
  }
  return false;
}

export function boundJsonValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === "string") return boundedString(value, MAX_STRING_LENGTH);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_LENGTH).map(item => boundJsonValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      out[boundedString(key, 256)] = boundJsonValue(child, depth + 1);
    }
    return out;
  }
  return null;
}

async function auth0Post(config: TeamPiConfig, path: string, body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch(`${config.auth0Domain}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await boundedJson(response);
  if (!response.ok) {
    const code = typeof json.error === "string" ? json.error : undefined;
    throw new TeamPiApiError(`Auth0 request failed: ${code ?? response.statusText}`, response.status, code);
  }
  return json;
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const text = await boundedText(response);
  if (text.length === 0) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { value: boundJsonValue(parsed) };
  return boundJsonValue(parsed) as Record<string, unknown>;
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) throw new TeamPiApiError("Team PI response exceeded size limit", response.status);
    chunks.push(value);
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseGrant(json: Record<string, unknown>): TokenGrant {
  return {
    accessToken: requiredJsonString(json, "access_token"),
    refreshToken: optionalJsonString(json, "refresh_token"),
    expiresIn: boundedPositiveInt(json.expires_in, 3600),
    idToken: optionalJsonString(json, "id_token"),
  };
}

function listParams(options: ListOptions): URLSearchParams {
  const params = new URLSearchParams();
  if (options.query) params.set("query", boundedString(options.query, 512));
  params.set("limit", String(limit(options.limit)));
  if (options.cursor) params.set("cursor", safeId(options.cursor, "cursor"));
  return params;
}

function searchParams(options: SearchOptions): URLSearchParams {
  if (!options.query) throw new Error("Team PI search query is required.");
  const params = listParams({ limit: options.limit, cursor: options.cursor });
  params.set("q", boundedString(options.query, 1024));
  return params;
}

function chorusSearchParams(options: SearchOptions): URLSearchParams {
  const params = searchParams(options);
  const cursor = params.get("cursor");
  if (cursor) {
    params.delete("cursor");
    params.set("continuation_key", cursor);
  }
  return params;
}

function calendarParams(options: CalendarOptions): URLSearchParams {
  const params = new URLSearchParams();
  params.set("from", isoDate(options.startIso, "startIso"));
  params.set("to", isoDate(options.endIso, "endIso"));
  params.set("limit", String(limit(options.limit)));
  if (options.calendarId) params.set("calendarId", safeId(options.calendarId, "calendarId"));
  return params;
}

function iso(value: string, name: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`Invalid Team PI ${name}.`);
  return value;
}

function isoDate(value: string, name: string): string {
  const parsed = iso(value, name);
  return parsed.slice(0, 10);
}

function limit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function normalizeHttpsBaseUrl(value: string | undefined, name: string): string {
  const raw = required(value, name);
  let url: URL;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS.`);
  if (url.username || url.password) throw new Error(`${name} must not include credentials.`);
  if (url.search || url.hash) throw new Error(`${name} must not include query parameters or a hash.`);
  return url.href.replace(/\/+$/, "");
}

function requiredJsonString(json: Record<string, unknown>, key: string): string {
  const value = json[key];
  if (typeof value !== "string" || value.length === 0) throw new TeamPiApiError(`Missing ${key} in response.`);
  return value;
}

function optionalJsonString(json: Record<string, unknown>, key: string): string | undefined {
  const value = json[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function trustedOptionalAuthUrl(json: Record<string, unknown>, key: string, auth0Domain: string): string | undefined {
  const value = optionalJsonString(json, key);
  return value ? trustedAuthUrl(value, auth0Domain) : undefined;
}

function trustedAuthUrl(value: string, auth0Domain: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TeamPiApiError("Auth0 returned an invalid verification URL.");
  }
  if (url.protocol !== "https:" || url.origin !== new URL(auth0Domain).origin || url.username || url.password) {
    throw new TeamPiApiError("Auth0 returned an untrusted verification URL.");
  }
  return boundedString(url.toString(), 2048);
}

function boundedPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

function boundedString(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
