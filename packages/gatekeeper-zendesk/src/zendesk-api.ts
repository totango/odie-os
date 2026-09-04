const REQUEST_TIMEOUT_MS = 25_000;
const MAX_JSON_BYTES = 1_000_000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export { MAX_ATTACHMENT_BYTES, REQUEST_TIMEOUT_MS, SUBDOMAIN_RE };

export class ZendeskApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
    this.name = "ZendeskApiError";
  }
  get isAuthError(): boolean { return this.status === 401 || this.status === 403; }
  get isNotFound(): boolean { return this.status === 404; }
}

export type ZendeskOAuthGrant = { accessToken: string; refreshToken?: string; expiresAt: number; scope?: string };
export type ZendeskIdentity = { id: number; name?: string | null; email?: string | null; photo?: { content_url?: string | null } | null };
export type ZendeskTicket = {
  id: number; url?: string; external_id?: string | null; type?: string | null; subject?: string | null; raw_subject?: string | null;
  description?: string | null; priority?: string | null; status?: string | null; requester_id?: number | null; assignee_id?: number | null;
  submitter_id?: number | null; organization_id?: number | null; group_id?: number | null; brand_id?: number | null; tags?: string[];
  custom_fields?: Array<{ id: number; value: string | number | boolean | null | string[] }>; fields?: Array<{ id: number; value: string | number | boolean | null | string[] }>;
  created_at?: string | null; updated_at?: string | null; generated_timestamp?: number | null;
};
export type ZendeskUser = { id: number; name?: string | null; email?: string | null; photo?: { content_url?: string | null } | null };
export type ZendeskComment = { id: number; type?: string; author_id?: number | null; body?: string | null; html_body?: string | null; plain_body?: string | null; public?: boolean; created_at?: string | null; attachments?: ZendeskAttachment[] };
export type ZendeskAttachment = { id: number; file_name?: string | null; content_type?: string | null; size?: number | null; content_url?: string | null; mapped_content_url?: string | null; created_at?: string | null };
export type ZendeskAudit = { id: number; created_at?: string | null; author_id?: number | null; events?: Array<{ type?: string; field_name?: string; value?: unknown; body?: string }> };
export type ZendeskUpload = { token: string; expires_at?: string; attachment: ZendeskAttachment };

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };

function baseUrl(subdomain: string): string {
  if (!SUBDOMAIN_RE.test(subdomain)) throw new Error("Zendesk subdomain must be a DNS label under zendesk.com.");
  return `https://${subdomain}.zendesk.com`;
}

export function normalizeSubdomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const host = trimmed.includes("//") ? new URL(trimmed).hostname : trimmed.replace(/\/+$/g, "");
  const subdomain = host.endsWith(".zendesk.com") ? host.slice(0, -".zendesk.com".length) : host;
  if (!SUBDOMAIN_RE.test(subdomain) || subdomain === "www" || subdomain === "api") {
    throw new Error("Enter a valid Zendesk subdomain, for example `acme` or `acme.zendesk.com`.");
  }
  return subdomain;
}

export function ticketUrl(subdomain: string, id: string | number): string { return `${baseUrl(subdomain)}/agent/tickets/${id}`; }

export function buildAuthorizeUrl(options: { subdomain: string; clientId: string; redirectUri: string; state: string; scope: string }): string {
  const url = new URL(`${baseUrl(options.subdomain)}/oauth/authorizations/new`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", options.scope);
  url.searchParams.set("state", options.state);
  return url.toString();
}

function grantFromTokenResponse(json: TokenResponse): ZendeskOAuthGrant {
  if (json.error || !json.access_token) throw new ZendeskApiError(400, [json.error, json.error_description].filter(Boolean).join(": ") || "Zendesk OAuth failed", json);
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000, scope: json.scope };
}

async function tokenRequest(subdomain: string, body: unknown): Promise<ZendeskOAuthGrant> {
  const res = await fetch(`${baseUrl(subdomain)}/oauth/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await boundedJson<TokenResponse>(res);
  if (!res.ok) throw new ZendeskApiError(res.status, json?.error_description ?? json?.error ?? res.statusText, json);
  return grantFromTokenResponse(json ?? {});
}

export function exchangeAuthCode(input: { subdomain: string; code: string; clientId: string; clientSecret: string; redirectUri: string; scope: string }): Promise<ZendeskOAuthGrant> {
  return tokenRequest(input.subdomain, { grant_type: "authorization_code", code: input.code, client_id: input.clientId, client_secret: input.clientSecret, redirect_uri: input.redirectUri, scope: input.scope });
}

export function refreshAccessToken(input: { subdomain: string; refreshToken: string; clientId: string; clientSecret: string; scope: string }): Promise<ZendeskOAuthGrant> {
  return tokenRequest(input.subdomain, { grant_type: "refresh_token", refresh_token: input.refreshToken, client_id: input.clientId, client_secret: input.clientSecret, scope: input.scope });
}

async function boundedJson<T>(res: Response): Promise<T | undefined> {
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_JSON_BYTES) throw new ZendeskApiError(res.status, "Zendesk response exceeded the configured size limit.");
  const bytes = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new ZendeskApiError(res.status, "Zendesk response exceeded the configured size limit.");
  }
  if (bytes.byteLength === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    throw new ZendeskApiError(res.status, "Zendesk returned malformed JSON.", error);
  }
}

export class ZendeskApi {
  constructor(private readonly subdomain: string, private readonly getToken: () => Promise<string>) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!path.startsWith("/api/v2/") && path !== "/api/v2/users/me.json") throw new Error("Unsupported Zendesk API path.");
    const token = await this.getToken();
    const res = await fetch(`${baseUrl(this.subdomain)}${path}`, {
      ...init,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...init.headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 204) return undefined as T;
    const json = await boundedJson<T & { error?: string; description?: string; details?: unknown }>(res);
    if (!res.ok) throw new ZendeskApiError(res.status, json?.description ?? json?.error ?? res.statusText, json);
    if (json === undefined) throw new ZendeskApiError(res.status, "Zendesk returned an unparseable response.");
    return json;
  }

  me(): Promise<{ user: ZendeskIdentity }> { return this.request("/api/v2/users/me.json"); }
  async showTicket(id: string): Promise<ZendeskTicket | null> { try { return (await this.request<{ ticket: ZendeskTicket }>(`/api/v2/tickets/${encodeURIComponent(id)}.json`)).ticket; } catch (e) { if (e instanceof ZendeskApiError && e.isNotFound) return null; throw e; } }
  searchTickets(query: string, page: number, perPage: number): Promise<{ results: ZendeskTicket[]; next_page?: string | null }> { return this.request(`/api/v2/search.json?query=${encodeURIComponent(`type:ticket ${query}`.trim())}&page=${page}&per_page=${perPage}`); }
  comments(id: string): Promise<{ comments: ZendeskComment[]; users?: ZendeskUser[] }> { return this.request(`/api/v2/tickets/${encodeURIComponent(id)}/comments.json?include=users`); }
  audits(id: string): Promise<{ audits: ZendeskAudit[]; users?: ZendeskUser[] }> { return this.request(`/api/v2/tickets/${encodeURIComponent(id)}/audits.json`); }
  async upload(input: { name: string; contentType: string; data: Uint8Array }): Promise<ZendeskUpload> {
    if (input.data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Zendesk attachments are limited to 5 MiB through this gatekeeper.");
    const res = await fetch(`${baseUrl(this.subdomain)}/api/v2/uploads.json?filename=${encodeURIComponent(input.name)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.getToken()}`, "Content-Type": input.contentType, Accept: "application/json" },
      body: input.data as BodyInit,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await boundedJson<{ upload: ZendeskUpload }>(res);
    if (!res.ok || !json) throw new ZendeskApiError(res.status, "Zendesk upload failed.", json);
    return json.upload;
  }
  updateTicket(id: string, ticket: Record<string, unknown>, safeUpdate?: { updateStamp?: string }): Promise<{ ticket: ZendeskTicket }> {
    const guarded = safeUpdate?.updateStamp
      ? { ...ticket, safe_update: true, updated_stamp: safeUpdate.updateStamp }
      : { ...ticket, safe_update: true };
    return this.request(`/api/v2/tickets/${encodeURIComponent(id)}.json`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket: guarded }) });
  }
  async downloadAttachment(url: string, maxBytes = MAX_ATTACHMENT_BYTES): Promise<{ data: Uint8Array; contentType?: string }> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== `${this.subdomain}.zendesk.com`) throw new Error("Attachment URL is outside the connected Zendesk subdomain.");
    const res = await fetch(parsed.toString(), { headers: { Authorization: `Bearer ${await this.getToken()}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new ZendeskApiError(res.status, `Zendesk attachment download failed: ${res.statusText}`);
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > maxBytes) throw new Error("Zendesk attachment exceeded the configured size limit.");
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > maxBytes) throw new Error("Zendesk attachment exceeded the configured size limit.");
    return { data, contentType: res.headers.get("content-type") ?? undefined };
  }
}
