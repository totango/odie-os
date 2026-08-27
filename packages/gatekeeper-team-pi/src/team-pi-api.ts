const MAX_ID_LENGTH = 256;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_RESPONSE_BYTES = 256_000;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64_000;
const MAX_STRING_LENGTH = 16_000;
const MAX_WORK_ITEM_DESCRIPTION_LENGTH = 60_000;
const MAX_JIRA_CREATE_DESCRIPTION_LENGTH = 12_000;
const MAX_ARRAY_LENGTH = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 8;
const REQUEST_TIMEOUT_MS = 30_000;

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
type CreateJiraIssueInput = { projectKey?: string; issueType?: string; summary: string; description: string; priority?: string };

const PROVIDERS = new Set<TeamPiProvider>(["gmail", "calendar", "chorus", "zendesk", "salesforce", "docs"]);

type ReadEndpoint =
  | "listSkills" | "getSkill" | "checkSkill" | "listConnections" | "calendarEvents"
  | "gmailSearch" | "gmailMessage" | "chorusSearch" | "chorusAccount" | "chorusEngagement"
  | "chorusConversation" | "zendeskSearch" | "zendeskTicket" | "salesforceAccount";
type WriteEndpoint = "installSkill" | "startConnection";
type WorkItemsEndpoint =
  | "workItemsSourceStatus" | "workItemsSearch" | "workItemsDetail" | "workItemsComments"
  | "workItemsActivity" | "workItemsUpdateOptions" | "workItemsAddComment" | "workItemsUpdateFields"
  | "workItemsTransitions" | "workItemsApplyTransition" | "workItemsLink" | "workItemsAttachments"
  | "workItemsAttachmentContent" | "workItemsCreateJiraIssue";

const READ_ENDPOINTS = new Set<ReadEndpoint>([
  "listSkills", "getSkill", "checkSkill", "listConnections", "calendarEvents", "gmailSearch",
  "gmailMessage", "chorusSearch", "chorusAccount", "chorusEngagement", "chorusConversation",
  "zendeskSearch", "zendeskTicket", "salesforceAccount",
]);
const WRITE_ENDPOINTS = new Set<WriteEndpoint>(["installSkill", "startConnection"]);
const WORK_ITEMS_ENDPOINTS = new Set<WorkItemsEndpoint>([
  "workItemsSourceStatus", "workItemsSearch", "workItemsDetail", "workItemsComments",
  "workItemsActivity", "workItemsUpdateOptions", "workItemsAddComment", "workItemsUpdateFields",
  "workItemsTransitions", "workItemsApplyTransition", "workItemsLink", "workItemsAttachments",
  "workItemsAttachmentContent", "workItemsCreateJiraIssue",
]);

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
export function assertAllowedEndpoint(kind: "workItems", endpoint: string): asserts endpoint is WorkItemsEndpoint;
export function assertAllowedEndpoint(kind: "read" | "write" | "workItems", endpoint: string): void {
  const allowed = kind === "read" ? READ_ENDPOINTS : kind === "write" ? WRITE_ENDPOINTS : WORK_ITEMS_ENDPOINTS;
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
  const response = await fetchWithTimeout(`${config.auth0Domain}/oauth/token`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }, "Auth0 device authorization timed out");
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
  const response = await fetchWithTimeout(`${config.auth0Domain}/oauth/revoke`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }, "Auth0 token revocation timed out");
  if (!response.ok) throw new TeamPiApiError("Auth0 token revocation failed", response.status);
}

export class TeamPiApi {
  constructor(
    private readonly getCredentials: (forceRefresh?: boolean) => Promise<TeamPiApiCredentials>,
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

  workItemsSourceStatus(): Promise<unknown> {
    assertAllowedEndpoint("workItems", "workItemsSourceStatus");
    return this.request("GET", "/api/work-items/v1/sources/status");
  }

  workItemsSearch(source: "jira" | "zendesk", options: { query?: string; limit?: number; cursor?: string } = {}): Promise<unknown> {
    assertAllowedEndpoint("workItems", "workItemsSearch");
    const params = new URLSearchParams({ source: safeWorkItemSource(source), limit: String(limit(options.limit)) });
    if (options.query) params.set("q", boundedString(options.query, 300));
    if (options.cursor) params.set("cursor", safeId(options.cursor, "cursor"));
    return this.request("GET", "/api/work-items/v1/search", params);
  }

  workItemsDetail(source: "jira" | "zendesk", id: string): Promise<unknown> {
    assertAllowedEndpoint("workItems", "workItemsDetail");
    return this.request("GET", workItemsItemPath(source, id), undefined, undefined, MAX_WORK_ITEM_DESCRIPTION_LENGTH);
  }

  workItemsComments(source: "jira" | "zendesk", id: string): Promise<unknown> {
    assertAllowedEndpoint("workItems", "workItemsComments");
    return this.request("GET", `${workItemsItemPath(source, id)}/comments`);
  }

  workItemsActivity(source: "jira" | "zendesk", id: string): Promise<unknown> {
    assertAllowedEndpoint("workItems", "workItemsActivity");
    return this.request("GET", `${workItemsItemPath(source, id)}/activity`);
  }

  workItemsUpdateOptions(source: "jira" | "zendesk", id: string): Promise<unknown> {
    assertAllowedEndpoint("workItems", "workItemsUpdateOptions");
    return this.request("GET", `${workItemsItemPath(source, id)}/update-options`);
  }

  workItemsAddComment(source: "jira" | "zendesk", id: string, input: { body: string; visibility?: "internal" | "public" }): Promise<unknown> {
    assertAllowedEndpoint("workItems", "workItemsAddComment");
    const visibility = input.visibility === "public" ? "public" : input.visibility === "internal" ? "internal" : undefined;
    return this.request("POST", `${workItemsItemPath(source, id)}/comments`, undefined, {
      body: boundedString(input.body, 12_000),
      ...(visibility ? { visibility } : {}),
    });
  }

  workItemsUpdateFields(source: "jira" | "zendesk", id: string, fields: Record<string, unknown>): Promise<unknown> {
    assertAllowedEndpoint("workItems", "workItemsUpdateFields");
    return this.request("PATCH", `${workItemsItemPath(source, id)}/fields`, undefined, { fields }, MAX_WORK_ITEM_DESCRIPTION_LENGTH);
  }

  workItemsTransitions(id: string): Promise<unknown> {
    assertAllowedEndpoint("workItems", "workItemsTransitions");
    return this.request("GET", `/api/work-items/v1/items/jira/${encodeURIComponent(safeId(id, "item id"))}/transitions`);
  }

  workItemsApplyTransition(id: string, transitionId: string): Promise<unknown> {
    assertAllowedEndpoint("workItems", "workItemsApplyTransition");
    return this.request("POST", `/api/work-items/v1/items/jira/${encodeURIComponent(safeId(id, "item id"))}/transitions`, undefined, {
      transitionId: safeId(transitionId, "transitionId"),
    });
  }

  workItemsLink(jiraId: string, zendeskTicketId: string): Promise<unknown> {
    assertAllowedEndpoint("workItems", "workItemsLink");
    return this.request("POST", "/api/work-items/v1/links", undefined, {
      jiraId: safeId(jiraId, "jiraId"),
      zendeskTicketId: safeId(zendeskTicketId, "zendeskTicketId"),
    });
  }

  workItemsCreateJiraIssue(input: CreateJiraIssueInput): Promise<unknown> {
    assertAllowedEndpoint("workItems", "workItemsCreateJiraIssue");
    const body = normalizeCreateJiraIssueInput(input);
    return this.request("POST", "/api/work-items/v1/items/jira", undefined, body, MAX_JIRA_CREATE_DESCRIPTION_LENGTH);
  }

  workItemsAttachments(source: "jira" | "zendesk", id: string): Promise<unknown> {
    assertAllowedEndpoint("workItems", "workItemsAttachments");
    return this.request("GET", `${workItemsItemPath(source, id)}/attachments`);
  }

  workItemsAttachmentContent(source: "jira" | "zendesk", id: string, attachmentId: string): Promise<{ data: Uint8Array; name: string; contentType?: string }> {
    assertAllowedEndpoint("workItems", "workItemsAttachmentContent");
    return this.binaryRequest(`${workItemsItemPath(source, id)}/attachments/${encodeURIComponent(safeId(attachmentId, "attachment id"))}/content`);
  }

  private async request(method: "GET" | "POST" | "PUT" | "PATCH", path: string, params?: URLSearchParams, body?: unknown, maxStringLength = MAX_STRING_LENGTH): Promise<unknown> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) url.search = params.toString();
    let requestBody: string | undefined;
    if (body !== undefined) {
      requestBody = JSON.stringify(boundJsonValueWithLimit(body, 0, maxStringLength));
      if (new TextEncoder().encode(requestBody).byteLength > MAX_REQUEST_BYTES) {
        throw new TeamPiApiError("Team PI request body exceeded size limit");
      }
    }
    for (let attempt = 0; attempt < 2; ++attempt) {
      const credentials = await abortable(this.getCredentials(attempt > 0), signal, "Team PI request timed out");
      const headers: Record<string, string> = {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
      };
      if (credentials.idToken) headers["X-Team-PI-ID-Token"] = credentials.idToken;
      if (requestBody !== undefined) headers["Content-Type"] = "application/json";
      let response: Response;
      try {
        const requestInit: RequestInit = { method, redirect: "manual", headers, signal };
        if (method !== "GET") requestInit.body = requestBody;
        response = await fetch(url, requestInit);
      } catch (error) {
        if (signal.aborted) throw new TeamPiApiError("Team PI request timed out");
        throw error;
      }
      let json: Record<string, unknown>;
      try {
        json = await boundedJson(response, maxStringLength);
      } catch (error) {
        if (signal.aborted) throw new TeamPiApiError("Team PI request timed out", response.status);
        throw error;
      }
      if (response.status === 401 && attempt === 0) {
        if (method === "GET") continue;
        await abortable(this.getCredentials(true), signal, "Team PI request timed out");
        throw new TeamPiApiError(
          "Team PI refreshed the stored credentials. Retry the operation.",
          response.status,
          typeof json.error === "string" ? json.error : undefined,
        );
      }
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
      return boundJsonValueWithLimit(json, 0, maxStringLength);
    }
    throw new TeamPiApiError("Team PI request failed after refreshing credentials.");
  }

  private async binaryRequest(path: string): Promise<{ data: Uint8Array; name: string; contentType?: string }> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const url = new URL(`${this.baseUrl}${path}`);
    for (let attempt = 0; attempt < 2; ++attempt) {
      const credentials = await abortable(this.getCredentials(attempt > 0), signal, "Team PI attachment request timed out");
      const headers: Record<string, string> = {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/octet-stream, application/pdf, image/*, */*;q=0.8",
      };
      if (credentials.idToken) headers["X-Team-PI-ID-Token"] = credentials.idToken;
      let response: Response;
      try {
        response = await fetch(url, { method: "GET", redirect: "manual", headers, signal });
      } catch (error) {
        if (signal.aborted) throw new TeamPiApiError("Team PI attachment request timed out");
        throw error;
      }
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        continue;
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new TeamPiApiError("Team PI attachment redirect was blocked", response.status);
      }
      if (!response.ok) {
        const code = response.headers.get("x-team-pi-error") ?? undefined;
        await response.body?.cancel();
        throw new TeamPiApiError(`Team PI attachment fetch failed: ${response.statusText}`, response.status, code);
      }
      const data = await boundedBytes(response, MAX_ATTACHMENT_BYTES, "Team PI attachment exceeded size limit");
      return {
        data,
        name: contentDispositionName(response.headers.get("content-disposition")) ?? "attachment",
        contentType: optionalHeader(response.headers.get("content-type")),
      };
    }
    throw new TeamPiApiError("Team PI attachment request failed after refreshing credentials.");
  }
}

function safeWorkItemSource(value: string): "jira" | "zendesk" {
  if (value !== "jira" && value !== "zendesk") throw new Error("Invalid Team PI Work Items source.");
  return value;
}

function workItemsItemPath(source: "jira" | "zendesk", id: string): string {
  return `/api/work-items/v1/items/${safeWorkItemSource(source)}/${encodeURIComponent(safeId(id, "item id"))}`;
}

function normalizeCreateJiraIssueInput(input: CreateJiraIssueInput): Required<Pick<CreateJiraIssueInput, "projectKey" | "issueType" | "summary" | "description">> & Pick<CreateJiraIssueInput, "priority"> {
  const projectKey = (optionalCleanInputString(input?.projectKey, 40) ?? "AI").toUpperCase();
  const issueType = optionalCleanInputString(input?.issueType, 80) ?? "Story";
  const summary = requiredCleanInputString(input?.summary, "summary", 300);
  const description = requiredCleanInputString(input?.description, "description", MAX_JIRA_CREATE_DESCRIPTION_LENGTH, true).replace(/\r\n?/g, "\n");
  if (description.split("\n").length > 80) {
    throw new Error("Team PI Jira description must contain at most 80 lines.");
  }
  const priority = optionalCleanInputString(input?.priority, 80);
  return priority ? { projectKey, issueType, summary, description, priority } : { projectKey, issueType, summary, description };
}

function requiredCleanInputString(value: unknown, name: string, max: number, allowMultiline = false): string {
  if (typeof value !== "string") throw new Error(`Team PI Jira ${name} is required.`);
  const out = boundedString(value.trim(), max);
  if (!out) throw new Error(`Team PI Jira ${name} is required.`);
  if (hasDisallowedControlCharacter(out, allowMultiline)) throw new Error(`Invalid Team PI Jira ${name}.`);
  return out;
}

function optionalCleanInputString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const out = boundedString(value.trim(), max);
  if (!out) return undefined;
  if (hasDisallowedControlCharacter(out, false)) throw new Error("Invalid Team PI Jira field.");
  return out;
}

function hasDisallowedControlCharacter(value: string, allowMultiline: boolean): boolean {
  for (let i = 0; i < value.length; ++i) {
    const code = value.charCodeAt(i);
    if (code < 32 && !(allowMultiline && (code === 9 || code === 10 || code === 13))) return true;
  }
  return false;
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
  return boundJsonValueWithLimit(value, depth, MAX_STRING_LENGTH);
}

function boundJsonValueWithLimit(value: unknown, depth: number, maxStringLength: number): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === "string") return boundedString(value, maxStringLength);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_LENGTH).map(item => boundJsonValueWithLimit(item, depth + 1, maxStringLength));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      out[boundedString(key, 256)] = boundJsonValueWithLimit(child, depth + 1, maxStringLength);
    }
    return out;
  }
  return null;
}

async function auth0Post(config: TeamPiConfig, path: string, body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(`${config.auth0Domain}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }, "Auth0 request timed out");
  const json = await boundedJson(response);
  if (!response.ok) {
    const code = typeof json.error === "string" ? json.error : undefined;
    throw new TeamPiApiError(`Auth0 request failed: ${code ?? response.statusText}`, response.status, code);
  }
  return json;
}

async function fetchWithTimeout(input: string | URL, init: RequestInit, message: string): Promise<Response> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal });
  } catch (error) {
    if (signal.aborted) throw new TeamPiApiError(message);
    throw error;
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  if (signal.aborted) throw new TeamPiApiError(message);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new TeamPiApiError(message));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function boundedJson(response: Response, maxStringLength = MAX_STRING_LENGTH): Promise<Record<string, unknown>> {
  const text = await boundedText(response);
  if (text.length === 0) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { value: boundJsonValueWithLimit(parsed, 0, maxStringLength) };
  return boundJsonValueWithLimit(parsed, 0, maxStringLength) as Record<string, unknown>;
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new TeamPiApiError("Team PI response exceeded size limit", response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
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

async function boundedBytes(response: Response, maxBytes: number, message: string): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TeamPiApiError(message, response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concat(chunks, total);
}

function optionalHeader(value: string | null): string | undefined {
  return value && value.length <= 160 && !/[\r\n]/.test(value) ? value : undefined;
}

function contentDispositionName(value: string | null): string | undefined {
  if (!value) return undefined;
  const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(value);
  let raw = match?.[2];
  if (match?.[1]) {
    try {
      raw = decodeURIComponent(match[1]);
    } catch {
      raw = match[1];
    }
  }
  return raw ? boundedString(raw.replace(/[\\/\r\n]/g, "_"), 240) : undefined;
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
