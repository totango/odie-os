import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { RpcStub } from "cloudflare:workers";
import { boundAgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import {
  TeamPiApi,
  assertAllowedEndpoint,
  pollDeviceAuthorization,
  refreshAccessToken,
  resolveConfig,
  startDeviceAuthorization,
  type TeamPiConfig,
} from "../team-pi-api.js";
import { TeamPiAccount, TeamPiGatekeeper, TeamPiSessionImpl, TeamPiUser, TeamPiWorkItemManagementApi, TeamPiWorkItemsManagementApi, catalogEntries, claimPendingAction, detailFromEnvelope, getStoredActionResult, rejectPendingAction, safeConnectionUrl, sanitizeInstallSkillResult, sanitizeStartConnectionResult } from "../team-pi.js";

const config: TeamPiConfig = {
  auth0Domain: "https://tenant.auth0.com",
  clientId: "public-client",
  audience: "https://team-pi.example/api",
  baseUrl: "https://team-pi.example",
};

class Kv {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  put<T>(key: string, value: T): void { this.values.set(key, value); }
  delete(key: string): void { this.values.delete(key); }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Team PI Auth0 device flow", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("starts device authorization with a public client and no client secret", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({
      device_code: "device-1", user_code: "ABCD-EFGH", verification_uri: "https://tenant.auth0.com/activate",
      verification_uri_complete: "https://tenant.auth0.com/activate?user_code=ABCD-EFGH", expires_in: 600, interval: 7,
    }));
    const started = await startDeviceAuthorization(config);
    expect(started.userCode).toBe("ABCD-EFGH");
    const requestBody = String(vi.mocked(fetch).mock.calls[0]?.[1]?.body);
    expect(requestBody).toContain("client_id=public-client");
    expect(requestBody).not.toContain("client_secret");
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("rejects verification links outside the configured Auth0 origin", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({
      device_code: "device-1", user_code: "ABCD-EFGH", verification_uri: "https://evil.example/activate",
      expires_in: 600, interval: 7,
    }));
    await expect(startDeviceAuthorization(config)).rejects.toThrow(/untrusted verification URL/);
  });

  it("treats authorization_pending as pollable and parses completed grants", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ error: "authorization_pending" }, 400))
      .mockResolvedValueOnce(response({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }));
    await expect(pollDeviceAuthorization(config, "device-1")).resolves.toBe("pending");
    await expect(pollDeviceAuthorization(config, "device-1")).resolves.toMatchObject({ accessToken: "access", refreshToken: "refresh" });
  });
});

describe("Team PI token refresh and API isolation", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("refreshes access tokens using refresh_token without a client secret", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1200 }));
    await expect(refreshAccessToken(config, "old-refresh")).resolves.toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
    const requestBody = String(vi.mocked(fetch).mock.calls[0]?.[1]?.body);
    expect(requestBody).not.toContain("client_secret");
    expect(requestBody).toContain("scope=openid+profile+email+offline_access");
  });

  it("requires hardened HTTPS Auth0 and Team PI base URLs", () => {
    expect(() => resolveConfig({
      TEAM_PI_AUTH0_DOMAIN: "http://tenant.auth0.com",
      TEAM_PI_AUTH0_CLIENT_ID: "public-client",
      TEAM_PI_AUTH0_AUDIENCE: "https://team-pi.example/api",
      TEAM_PI_BASE_URL: "https://team-pi.example",
    } as unknown as Env)).toThrow(/HTTPS/);
    expect(() => resolveConfig({
      TEAM_PI_AUTH0_DOMAIN: "https://user:pass@tenant.auth0.com",
      TEAM_PI_AUTH0_CLIENT_ID: "public-client",
      TEAM_PI_AUTH0_AUDIENCE: "https://team-pi.example/api",
      TEAM_PI_BASE_URL: "https://team-pi.example?x=1",
    } as unknown as Env)).toThrow(/credentials|query/);
  });

  it("keeps per-user requests isolated by token provider", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ items: [] }))
      .mockResolvedValueOnce(response({ items: [] }));
    await new TeamPiApi(async () => ({ accessToken: "user-a", idToken: "identity-a" }), config.baseUrl).listSkills();
    await new TeamPiApi(async () => ({ accessToken: "user-b", idToken: "identity-b" }), config.baseUrl).listSkills();
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer user-a" });
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer user-b" });
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Team-PI-ID-Token": "identity-a" });
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.headers).toMatchObject({ "X-Team-PI-ID-Token": "identity-b" });
  });

  it("bounds Team PI API requests with a total timeout", async () => {
    const signal = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);

    await expect(new TeamPiApi(
      async () => ({ accessToken: "user-a", idToken: "identity-a" }),
      config.baseUrl,
    ).listSkills()).rejects.toThrow("Team PI request timed out");
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetch).not.toHaveBeenCalled();
    timeout.mockRestore();
  });

  it("turns Team PI auth denials into actionable access errors", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ error: "missing_id_token" }, 403));
    const api = new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl);

    await expect(api.listSkills()).rejects.toThrow(/denied access|Reconnect Team PI|required provider\/skill/);
  });

  it("refreshes credentials once and retries when Team PI rejects an access token", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ error: "expired_token" }, 401))
      .mockResolvedValueOnce(response({ items: [] }));
    const credentials = vi.fn(async (forceRefresh?: boolean) => ({
      accessToken: forceRefresh ? "fresh-access" : "stale-access",
      idToken: forceRefresh ? "fresh-identity" : "stale-identity",
    }));

    await expect(new TeamPiApi(credentials, config.baseUrl).listSkills()).resolves.toEqual({ items: [] });
    expect(credentials).toHaveBeenNthCalledWith(1, false);
    expect(credentials).toHaveBeenNthCalledWith(2, true);
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer fresh-access",
      "X-Team-PI-ID-Token": "fresh-identity",
    });
  });

  it("retries only once when refreshed credentials are also rejected", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ error: "expired_token" }, 401));
    const credentials = vi.fn(async () => ({ accessToken: "access", idToken: "identity" }));

    await expect(new TeamPiApi(credentials, config.baseUrl).listSkills()).rejects.toThrow(/rejected the stored credentials/);
    expect(credentials).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refreshes but does not replay a write rejected for stale credentials", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: "expired_token" }, 401));
    const credentials = vi.fn(async () => ({ accessToken: "access", idToken: "identity" }));

    await expect(new TeamPiApi(credentials, config.baseUrl).installSkill("skill-1"))
      .rejects.toThrow(/refreshed the stored credentials|Retry the operation/);
    expect(credentials).toHaveBeenNthCalledWith(1, false);
    expect(credentials).toHaveBeenNthCalledWith(2, true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes credentials and retries attachment reads rejected with 401", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "Content-Disposition": "attachment; filename=report.pdf",
          "Content-Type": "application/pdf",
        },
      }));
    const credentials = vi.fn(async (forceRefresh?: boolean) => ({
      accessToken: forceRefresh ? "fresh-access" : "stale-access",
      idToken: "identity",
    }));

    await expect(new TeamPiApi(credentials, config.baseUrl).workItemsAttachmentContent("jira", "J-1", "attachment-1"))
      .resolves.toEqual({ data: new Uint8Array([1, 2, 3]), name: "report.pdf", contentType: "application/pdf" });
    expect(credentials).toHaveBeenNthCalledWith(1, false);
    expect(credentials).toHaveBeenNthCalledWith(2, true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("coalesces in-instance refreshes to avoid rotating refresh-token races", async () => {
    let resolveRefresh!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(resolve => { resolveRefresh = resolve; }));
    const kv = new Kv();
    kv.put("refreshToken", "rotating-refresh");
    kv.put("accessTokenExpiresAt", 0);
    kv.put("idToken", "stale-id-token");
    kv.put("idTokenExpiresAt", Date.now() + 60_000);
    kv.put("identity", { uniqueName: "stale@totango.com" });
    const account = new TeamPiAccount({} as never, configEnv());
    (account as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (account as unknown as { env: Env; ctx: unknown }).ctx = {
      storage: { kv, transactionSync: <T>(callback: () => T) => callback() },
    };
    const first = account.getAccessToken();
    const second = account.getAccessToken();
    await Promise.resolve();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    resolveRefresh(response({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 }));
    await expect(Promise.all([first, second])).resolves.toEqual(["fresh", "fresh"]);
    expect(kv.get("refreshToken")).toBe("rotated");
    expect(kv.get("idToken")).toBeUndefined();
    expect(kv.get("idTokenExpiresAt")).toBeUndefined();
    expect(kv.get("identity")).toBeUndefined();
  });

  it("replaces the stored refresh token during a forced API refresh", async () => {
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const renewedIdToken = `e30.${btoa(JSON.stringify({ email: "renewed@totango.com", exp: Math.floor(expiresAt / 1000) }))}.sig`;
    vi.mocked(fetch).mockResolvedValueOnce(response({
      access_token: "renewed-access",
      refresh_token: "rotated-refresh",
      id_token: renewedIdToken,
      expires_in: 3600,
    }));
    const kv = new Kv();
    kv.put("refreshToken", "old-refresh");
    kv.put("accessToken", "rejected-access");
    kv.put("accessTokenExpiresAt", expiresAt);
    kv.put("idToken", renewedIdToken);
    kv.put("idTokenExpiresAt", expiresAt);
    const account = new TeamPiAccount({} as never, configEnv());
    (account as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (account as unknown as { env: Env; ctx: unknown }).ctx = { storage: { kv } };

    await expect(account.getApiCredentials(true)).resolves.toEqual({
      accessToken: "renewed-access",
      idToken: renewedIdToken,
    });
    expect(kv.get("refreshToken")).toBe("rotated-refresh");
  });

  it("preserves a still-valid ID token when access-token refresh omits one", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 3600,
    }));
    const kv = new Kv();
    kv.put("refreshToken", "old-refresh");
    kv.put("accessTokenExpiresAt", 0);
    kv.put("idToken", "valid-id");
    kv.put("idTokenExpiresAt", Date.now() + 60 * 60 * 1000);
    kv.put("identity", { uniqueName: "user@totango.com" });
    const account = new TeamPiAccount({} as never, configEnv());
    (account as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (account as unknown as { env: Env; ctx: unknown }).ctx = { storage: { kv } };

    await expect(account.getApiCredentials()).resolves.toEqual({
      accessToken: "fresh-access",
      idToken: "valid-id",
    });
    expect(kv.get("identity")).toEqual({ uniqueName: "user@totango.com" });
  });

  it("requires a fresh ID token instead of forwarding an expired identity", async () => {
    const kv = new Kv();
    kv.put("accessToken", "valid-access");
    kv.put("accessTokenExpiresAt", Date.now() + 60 * 60 * 1000);
    kv.put("idToken", "expired-id");
    kv.put("idTokenExpiresAt", Date.now() - 1);
    const account = new TeamPiAccount({} as never, configEnv());
    (account as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (account as unknown as { env: Env; ctx: unknown }).ctx = { storage: { kv } };

    await expect(account.getApiCredentials()).rejects.toThrow(/fresh identity token|Reconnect Team PI/);
  });

  it("returns the renewed ID token on the first API request after refresh", async () => {
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const renewedIdToken = `e30.${btoa(JSON.stringify({ email: "renewed@totango.com", exp: Math.floor(expiresAt / 1000) }))}.sig`;
    vi.mocked(fetch).mockResolvedValueOnce(response({
      access_token: "renewed-access",
      refresh_token: "renewed-refresh",
      id_token: renewedIdToken,
      expires_in: 3600,
    }));
    const kv = new Kv();
    kv.put("refreshToken", "old-refresh");
    kv.put("accessToken", "still-valid-access");
    kv.put("accessTokenExpiresAt", Date.now() + 60 * 60 * 1000);
    const account = new TeamPiAccount({} as never, configEnv());
    (account as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (account as unknown as { env: Env; ctx: unknown }).ctx = { storage: { kv } };

    await expect(account.getApiCredentials()).resolves.toEqual({
      accessToken: "renewed-access",
      idToken: renewedIdToken,
    });
  });

  it("reports connection status from the live credential probe", async () => {
    const kv = new Kv();
    kv.put("accessToken", "valid-access");
    kv.put("accessTokenExpiresAt", Date.now() + 60 * 60 * 1000);
    kv.put("idToken", "valid-id");
    kv.put("idTokenExpiresAt", Date.now() + 60 * 60 * 1000);
    const account = new TeamPiAccount({} as never, configEnv());
    (account as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (account as unknown as { env: Env; ctx: unknown }).ctx = { storage: { kv } };
    const user = new TeamPiUser({} as never, configEnv());
    (user as unknown as { ctx: unknown }).ctx = {
      props: { accountId: "account-1" },
      exports: { TeamPiAccount: { idFromString: () => "account-1", get: () => account } },
    };

    await expect(user.getConnectionStatus()).resolves.toMatchObject({ state: "healthy" });

    kv.put("idTokenExpiresAt", Date.now() - 1);
    await expect(user.getConnectionStatus()).resolves.toMatchObject({ state: "expired" });
  });

  it("preserves a valid access token when the legacy ID-token refresh fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: "temporarily_unavailable" }, 503));
    const kv = new Kv();
    const originalExpiry = Date.now() + 60 * 60 * 1000;
    kv.put("refreshToken", "old-refresh");
    kv.put("accessToken", "still-valid-access");
    kv.put("accessTokenExpiresAt", originalExpiry);
    const account = new TeamPiAccount({} as never, configEnv());
    (account as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (account as unknown as { env: Env; ctx: unknown }).ctx = { storage: { kv } };

    await expect(account.getApiCredentials()).rejects.toThrow(/Auth0 request failed/);
    expect(kv.get("accessToken")).toBe("still-valid-access");
    expect(kv.get("accessTokenExpiresAt")).toBe(originalExpiry);
  });

  it("surfaces legacy refreshes with no usable ID token as reconnect errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({
      access_token: "renewed-access",
      refresh_token: "renewed-refresh",
      expires_in: 3600,
    }));
    const kv = new Kv();
    kv.put("refreshToken", "old-refresh");
    kv.put("accessToken", "still-valid-access");
    kv.put("accessTokenExpiresAt", Date.now() + 60 * 60 * 1000);
    const account = new TeamPiAccount({} as never, configEnv());
    (account as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (account as unknown as { env: Env; ctx: unknown }).ctx = { storage: { kv } };

    await expect(account.getApiCredentials()).rejects.toThrow(/fresh identity token|Reconnect Team PI/);
    await expect(account.getApiCredentials()).rejects.toThrow(/fresh identity token|Reconnect Team PI/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("marks expired refresh-token grants and throws an actionable reconnect error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: "invalid_grant" }, 400));
    const kv = new Kv();
    const callback = { credentialsExpired: vi.fn() };
    kv.put("refreshToken", "revoked-refresh");
    kv.put("callback", callback);
    const account = new TeamPiAccount({} as never, configEnv());
    (account as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (account as unknown as { env: Env; ctx: unknown }).ctx = { storage: { kv } };

    await expect(account.getAccessToken()).rejects.toThrow(/expired or been revoked|Reconnect Team PI/);
    expect(callback.credentialsExpired).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent device polls so the Workshop callback completes once", async () => {
    let resolvePoll!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(resolve => { resolvePoll = resolve; }));
    const kv = new Kv();
    const callback = { complete: vi.fn() };
    kv.put("nonce", "nonce-1");
    kv.put("callback", callback);
    kv.put("device", {
      nonce: "nonce-1",
      deviceCode: "device-1",
      userCode: "ABCD-EFGH",
      verificationUri: "https://tenant.auth0.com/activate",
      expiresAt: Date.now() + 60_000,
      intervalMs: 5_000,
    });
    const account = new TeamPiAccount({} as never, configEnv());
    (account as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (account as unknown as { env: Env; ctx: unknown }).ctx = {
      id: { toString: () => "account-1" },
      storage: { kv, deleteAlarm: vi.fn() },
      exports: { TeamPiUser: vi.fn(() => ({ account: "account-1" })) },
    };
    const first = account.pollDeviceFlow("nonce-1");
    const second = account.pollDeviceFlow("nonce-1");
    await Promise.resolve();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const idToken = `e30.${btoa(JSON.stringify({ email: "user@totango.com", name: "User", exp: Math.floor(expiresAt / 1000) }))}.sig`;
    resolvePoll(response({ access_token: "access", refresh_token: "refresh", expires_in: 3600, id_token: idToken }));
    await expect(Promise.all([first, second])).resolves.toEqual([{ status: "complete" }, { status: "complete" }]);
    expect(callback.complete).toHaveBeenCalledTimes(1);
    expect(kv.get("idToken")).toBe(idToken);
    expect(kv.get<number>("idTokenExpiresAt")).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
    expect(kv.get("identity")).toEqual({ displayName: "User", uniqueName: "user@totango.com" });
    await expect(account.getApiCredentials()).resolves.toEqual({ accessToken: "access", idToken });
  });

  it("uses the actual Team PI server paths and query names", async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(response({ items: [] })));
    const api = new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl);
    await api.listConnections({ limit: 3 });
    await api.calendarEvents({ startIso: "2026-08-01T00:00:00Z", endIso: "2026-08-02T00:00:00Z", limit: 2 });
    await api.gmailSearch({ query: "from:a", limit: 4 });
    await api.gmailMessage("msg-1");
    await api.chorusSearch({ query: "acme", cursor: "next" });
    await api.chorusAccount("Acme");
    await api.chorusEngagement("eng-1");
    await api.chorusConversation("conv-1");
    await api.zendeskSearch({ query: "type:ticket", limit: 5 });
    await api.zendeskTicket("123");
    await api.salesforceAccount("Acme");
    await api.startConnection("gmail");
    const urls = vi.mocked(fetch).mock.calls.map(call => String(call[0]));
    expect(urls).toContain("https://team-pi.example/connections?limit=3");
    expect(urls).toContain("https://team-pi.example/calendar/events?from=2026-08-01&to=2026-08-02&limit=2");
    expect(urls).toContain("https://team-pi.example/gmail/search?limit=4&q=from%3Aa");
    expect(urls).toContain("https://team-pi.example/gmail/message/msg-1");
    expect(urls).toContain("https://team-pi.example/chorus/search?limit=10&q=acme&continuation_key=next");
    expect(urls).toContain("https://team-pi.example/chorus/account?q=Acme");
    expect(urls).toContain("https://team-pi.example/chorus/engagement/eng-1");
    expect(urls).toContain("https://team-pi.example/chorus/conversation/conv-1");
    expect(urls).toContain("https://team-pi.example/zendesk/search?limit=5&q=type%3Aticket");
    expect(urls).toContain("https://team-pi.example/zendesk/ticket/123");
    expect(urls).toContain("https://team-pi.example/salesforce/account?q=Acme");
    expect(urls).toContain("https://team-pi.example/connect/gmail");
  });

  it("uses exact allowlisted Work Items v1 endpoints with auth headers and bounded JSON bodies", async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(response({ item: { source: "jira", id: "J-1", title: "Issue", fields: {} } })));
    const api = new TeamPiApi(async () => ({ accessToken: "access", idToken: "identity" }), config.baseUrl);

    await api.workItemsSourceStatus();
    await api.workItemsSearch("jira", { query: "login", limit: 2, cursor: "5" });
    await api.workItemsDetail("jira", "J-1");
    await api.workItemsComments("jira", "J-1");
    await api.workItemsActivity("jira", "J-1");
    await api.workItemsUpdateOptions("jira", "J-1");
    await api.workItemsAddComment("zendesk", "12", { body: "x".repeat(20_000) });
    await api.workItemsUpdateFields("jira", "J-1", { summary: "New" });
    await api.workItemsTransitions("J-1");
    await api.workItemsApplyTransition("J-1", "31");
    await api.workItemsLink("J-1", "12");
    await api.workItemsCreateJiraIssue({ summary: "New issue", description: "Details", priority: "High", projectKey: "ENG", issueType: "Bug", ignored: "no" } as never);
    await api.workItemsAttachments("jira", "J-1");

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.map(call => String(call[0]))).toEqual([
      "https://team-pi.example/api/work-items/v1/sources/status",
      "https://team-pi.example/api/work-items/v1/search?source=jira&limit=2&q=login&cursor=5",
      "https://team-pi.example/api/work-items/v1/items/jira/J-1",
      "https://team-pi.example/api/work-items/v1/items/jira/J-1/comments",
      "https://team-pi.example/api/work-items/v1/items/jira/J-1/activity",
      "https://team-pi.example/api/work-items/v1/items/jira/J-1/update-options",
      "https://team-pi.example/api/work-items/v1/items/zendesk/12/comments",
      "https://team-pi.example/api/work-items/v1/items/jira/J-1/fields",
      "https://team-pi.example/api/work-items/v1/items/jira/J-1/transitions",
      "https://team-pi.example/api/work-items/v1/items/jira/J-1/transitions",
      "https://team-pi.example/api/work-items/v1/links",
      "https://team-pi.example/api/work-items/v1/items/jira",
      "https://team-pi.example/api/work-items/v1/items/jira/J-1/attachments",
    ]);
    expect(calls[6]?.[1]).toMatchObject({ method: "POST", redirect: "manual" });
    expect(calls[7]?.[1]).toMatchObject({ method: "PATCH" });
    expect(calls[10]?.[1]).toMatchObject({ method: "POST" });
    expect(calls[11]?.[1]).toMatchObject({ method: "POST" });
    expect(calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer access", "X-Team-PI-ID-Token": "identity" });
    expect(JSON.parse(String(calls[6]?.[1]?.body))).toEqual({ body: "x".repeat(12_000) });
    expect(JSON.parse(String(calls[10]?.[1]?.body))).toEqual({ jiraId: "J-1", zendeskTicketId: "12" });
    expect(JSON.parse(String(calls[11]?.[1]?.body))).toEqual({ projectKey: "ENG", issueType: "Bug", summary: "New issue", description: "Details", priority: "High" });
    expect(() => assertAllowedEndpoint("workItems", "rawProxy")).toThrow(/not allowed/);
  });

  it("posts Jira create requests to the exact Work Items path with defaults", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ item: { source: "jira", id: "AI-1", title: "Issue", fields: {} } }));
    const api = new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl);

    await api.workItemsCreateJiraIssue({ summary: " Defaulted ", description: " Details\nSecond line " });

    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe("https://team-pi.example/api/work-items/v1/items/jira");
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({
      projectKey: "AI",
      issueType: "Story",
      summary: "Defaulted",
      description: "Details\nSecond line",
    });
  });

  it("normalizes Jira project casing and rejects descriptions that cannot be previewed exactly", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ item: { source: "jira", id: "ABC-1", title: "Issue", fields: {} } }));
    const api = new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl);

    await api.workItemsCreateJiraIssue({ projectKey: "aBc", summary: "Issue", description: "Details" });
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)).projectKey).toBe("ABC");
    expect(() => api.workItemsCreateJiraIssue({ summary: "Issue", description: Array(81).fill("line").join("\n") }))
      .toThrow(/at most 80 lines/);
    expect(() => api.workItemsCreateJiraIssue({ summary: "Issue", description: Array(81).fill("line").join("\r") }))
      .toThrow(/at most 80 lines/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fetches Work Items attachment bytes through the bounded binary allowlist", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "image/png", "Content-Disposition": "attachment; filename=screen.png" },
    }));
    const api = new TeamPiApi(async () => ({ accessToken: "access", idToken: "identity" }), config.baseUrl);
    await expect(api.workItemsAttachmentContent("jira", "J-1", "a1")).resolves.toEqual({ data: new Uint8Array([1, 2, 3]), name: "screen.png", contentType: "image/png" });
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe("https://team-pi.example/api/work-items/v1/items/jira/J-1/attachments/a1/content");
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "manual", headers: expect.objectContaining({ Authorization: "Bearer access", "X-Team-PI-ID-Token": "identity" }) });
  });

  it("preserves Work Item descriptions above the generic JSON string limit", async () => {
    const description = "x".repeat(50_000);
    vi.mocked(fetch).mockResolvedValueOnce(response({ item: { source: "jira", id: "J-1", title: "Issue", description: { body: description, format: "adf-text", truncated: false }, fields: {} } }));
    const api = new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl);

    await expect(api.workItemsDetail("jira", "J-1")).resolves.toMatchObject({ item: { description: { body: description, truncated: false } } });
  });

  it("blocks Team PI attachment redirects", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://evil.example/file" } }));
    const api = new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl);
    await expect(api.workItemsAttachmentContent("jira", "J-1", "a1")).rejects.toThrow(/redirect was blocked/);
  });
});

function configEnv(): Env {
  return {
    TEAM_PI_AUTH0_DOMAIN: "https://tenant.auth0.com",
    TEAM_PI_AUTH0_CLIENT_ID: "public-client",
    TEAM_PI_AUTH0_AUDIENCE: "https://team-pi.example/api",
    TEAM_PI_BASE_URL: "https://team-pi.example",
  } as unknown as Env;
}

async function testSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function fakeAccount(overrides: Partial<TeamPiAccount> = {}): DurableObjectStub<TeamPiAccount> {
  return {
    describeIdentity: async () => ({}),
    listSavedWorkItemViews: async () => [],
    saveWorkItemView: async (view: never) => view,
    deleteWorkItemView: async () => {},
    ...overrides,
  } as unknown as DurableObjectStub<TeamPiAccount>;
}

describe("Team PI reads, writes, endpoint allowlist, and catalog", () => {
  it("configures the whole-account resource for an existing authenticated account", async () => {
    const user = new TeamPiUser({} as never, configEnv());
    (user as unknown as { env: Env }).env = configEnv();
    (user as unknown as { ctx: unknown }).ctx = {
      props: { accountId: "account-1" },
      exports: {
        TeamPiAccount: { idFromString: (id: string) => id, get: () => ({ getApiCredentials: async () => ({ accessToken: "access", idToken: "identity" }), describeIdentity: async () => ({ displayName: "Dana", uniqueName: "dana@example.com" }) }) },
        TeamPiGatekeeper: vi.fn(() => ({ class: "team-pi" })),
      },
    };

    await expect(user.describe()).resolves.toMatchObject({
      avatar: expect.objectContaining({ url: expect.stringContaining("PI") }),
      providesUi: { title: "Work Items", adminOnly: true, icon: expect.objectContaining({ url: expect.not.stringContaining("PI") }) },
    });

    const app = await user.startAppUi({ isAdmin: true });
    expect(app.iframeHtml).toContain("app.txt");
    expect(app.ui).toBeInstanceOf(RpcStub);
    app.ui[Symbol.dispose]();
    await expect(user.startAppUi({ isAdmin: false })).rejects.toThrow(/admins only/);

    (user as unknown as { ctx: unknown }).ctx = {
      props: { accountId: "account-1" },
      exports: { TeamPiGatekeeper: vi.fn(() => ({ class: "team-pi" })) },
    };

    const frame = await user.startResourceConfigurator("team-pi://account");
    expect(frame.iframeHtml).toBeTruthy();
    expect(frame.ui).toBeInstanceOf(RpcStub);
    frame.ui[Symbol.dispose]();
    await expect(user.getSupportedResources()).resolves.toEqual([
      expect.objectContaining({urlPattern: "team-pi://account", providedBySingleton: true}),
    ]);
    await expect(user.getGatekeeperClassFor("team-pi://account")).resolves.toMatchObject({
      resource: { title: "Team PI Account" },
    });
    await expect(user.startResourceConfigurator("team-pi://other"))
      .rejects.toThrow(/Unsupported Team PI resource configurator/);
    await expect(user.getGatekeeperClassFor("team-pi://other"))
      .rejects.toThrow(/Unsupported Team PI resource/);
  });

  it("only returns provider connection pages on the configured Team PI origin", () => {
    const baseUrl = "https://team-pi.example";
    expect(safeConnectionUrl("/connect/gmail/page?user=u", baseUrl, "gmail"))
      .toBe("https://team-pi.example/connect/gmail/page?user=u");
    expect(safeConnectionUrl("/connect/gmail/page?user=u&sessionToken=secret&shared=1", baseUrl, "gmail"))
      .toBe("https://team-pi.example/connect/gmail/page?user=u&shared=1");
    expect(safeConnectionUrl("https://evil.example/connect/gmail/page?user=u", baseUrl, "gmail")).toBeUndefined();
    expect(safeConnectionUrl("http://team-pi.example/connect/gmail/page?user=u", baseUrl, "gmail")).toBeUndefined();
    expect(safeConnectionUrl("/connect/calendar/page?user=u", baseUrl, "gmail")).toBeUndefined();
  });

  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("rejects endpoints outside the explicit allowlist", () => {
    expect(() => assertAllowedEndpoint("read", "rawRequest")).toThrow(/not allowed/);
    expect(() => assertAllowedEndpoint("write", "deleteSkill")).toThrow(/not allowed/);
  });

  it("authorizes reads before returning and stages writes through the approval queue", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ skills: [{ id: "skill-1", name: "Coach" }], bundleVersion: "abc123" }));
    const kv = new Kv();
    const approval = { authorizeObservation: vi.fn(), submitAction: vi.fn(), dup() { return this; }, [Symbol.dispose]() {} };
    const session = new TeamPiSessionImpl(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), approval as never, kv as never);
    await expect(session.listSkills()).resolves.toMatchObject({ items: [{ id: "skill-1" }] });
    expect(approval.authorizeObservation).toHaveBeenCalledWith(expect.objectContaining({
      domainSharingPolicy: { type: "verified-sso-email-domain", emailDomain: "totango.com" },
    }));
    await expect(session.installSkill("skill-1")).resolves.toMatchObject({ actionId: 1, status: "pending" });
    expect(approval.submitAction).toHaveBeenCalledWith(1, expect.objectContaining({ actionKind: { tag: "team-pi.installSkill", label: "Install Team PI skill" } }));
    expect(kv.get("pending:1")).toMatchObject({ kind: "installSkill", skillId: "skill-1" });
  });

  it("cleans staged action state when submitAction fails", async () => {
    const kv = new Kv();
    const approval = { authorizeObservation: vi.fn(), submitAction: vi.fn().mockRejectedValue(new Error("queue down")), dup() { return this; }, [Symbol.dispose]() {} };
    const session = new TeamPiSessionImpl(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), approval as never, kv as never);
    await expect(session.startConnection("gmail")).rejects.toThrow("queue down");
    expect(kv.get("pending:1")).toBeUndefined();
    expect(kv.get("result:1")).toBeUndefined();
  });

  it("stages Jira creation with default payload and Markdown-escaped approval details", async () => {
    const kv = new Kv();
    const approval = { authorizeObservation: vi.fn(), submitAction: vi.fn(), dup() { return this; }, [Symbol.dispose]() {} };
    const session = new TeamPiSessionImpl(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), approval as never, kv as never);

    await expect(session.createJiraIssue({
      summary: "Fix *login* [now] <hidden>",
      description: "Line > one\nBacktick ` code & <details>",
      priority: "High",
    })).resolves.toMatchObject({ actionId: 1, status: "pending" });

    expect(kv.get("pending:1")).toEqual({
      kind: "createJiraIssue",
      request: { projectKey: "AI", issueType: "Story", summary: "Fix *login* [now] <hidden>", description: "Line > one\nBacktick ` code & <details>", priority: "High" },
    });
    expect(approval.submitAction).toHaveBeenCalledWith(1, expect.objectContaining({
      actionKind: { tag: "team-pi.createJiraIssue", label: "Create Jira issue" },
      title: "Create Jira issue AI Story",
      description: expect.stringContaining("Project key: AI"),
    }));
    const description = approval.submitAction.mock.calls[0]?.[1]?.description;
    expect(description).toContain("Summary: Fix \\*login\\* \\[now\\] &lt;hidden\\>");
    expect(description).toContain("Line \\> one");
    expect(description).toContain("Backtick \\` code");
    expect(description).toContain("&amp; &lt;details\\>");
  });

  it("claims pending actions synchronously and blocks reject/apply races", () => {
    const kv = new Kv();
    kv.put("pending:1", { kind: "startConnection", provider: "gmail" });
    const action = claimPendingAction(kv as never, 1);
    expect(action).toMatchObject({ kind: "startConnection", provider: "gmail" });
    expect(kv.get("pending:1")).toBeUndefined();
    expect(kv.get("applying:1")).toMatchObject({ kind: "startConnection" });
    expect(() => rejectPendingAction(kv as never, 1)).toThrow(/already applying/);
    expect(() => claimPendingAction(kv as never, 1)).toThrow(/already applying/);
  });

  it("transforms real Team PI proxy envelopes into safe agent types", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ skill: { id: "s1", name: "Coach", version: "1.0.0", status: "approved", requiredConnections: { user: ["gmail"], sessionToken: "secret" } }, files: { "SKILL.md": "Use this skill\n" + "x".repeat(20_000), "secret.txt": "no" } }))
      .mockResolvedValueOnce(response({ user: "u@example.com", skillId: "s1", requiredConnections: { user: ["gmail"], connectLink: "secret" }, status: { user: { gmail: true, sessionToken: "secret" } } }))
      .mockResolvedValueOnce(response({ connections: { gmail: "u-gmail" }, shared: { zendesk: "shared-zd" }, tokenConnections: { chorus: { configured: true, baseUrl: "https://chorus" } } }));
    const approval = { authorizeObservation: vi.fn(), submitAction: vi.fn(), dup() { return this; }, [Symbol.dispose]() {} };
    const session = new TeamPiSessionImpl(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), approval as never, new Kv() as never);
    await expect(session.getSkill("s1")).resolves.toMatchObject({ id: "s1", name: "Coach", instructions: expect.stringMatching(/^Use this skill/), requiredConnections: { user: ["gmail"], shared: [], token: [] } });
    await expect(session.checkSkill("s1")).resolves.toEqual({ skillId: "s1", requiredConnections: { user: ["gmail"], shared: [], token: [] }, status: { user: { gmail: true }, shared: {}, token: {} } });
    await expect(session.listConnections()).resolves.toEqual({ items: [
      { id: "u-gmail", name: "gmail", provider: "gmail", scope: "user", status: "connected" },
      { id: "shared-zd", name: "zendesk", provider: "zendesk", scope: "shared", status: "connected" },
      { id: undefined, name: "chorus", provider: "chorus", scope: "token", status: "configured" },
    ] });
  });

  it("normalizes and bounds Work Items responses before returning over RPC", () => {
    expect(detailFromEnvelope({ item: {
      source: "jira",
      id: "J-1",
      key: "J-1",
      url: "https://jira.example/browse/J-1",
      title: "x".repeat(400),
      description: { body: "Full description", format: "markdown", truncated: true },
      fields: { summary: "y".repeat(3_000), labels: ["secret"], customfield_12345: "raw custom", providerOptions: "raw options" },
      token: "do-not-copy",
    } })).toEqual({ item: expect.objectContaining({
      source: "jira",
      id: "J-1",
      title: "x".repeat(300),
      description: { body: "Full description", format: "markdown", truncated: true },
      fields: { summary: "y".repeat(2_000), labels: "secret" },
    }) });
  });

  it("preserves bounded rich descriptions and marks only local overflow as truncated", () => {
    const complete = "x".repeat(50_000);
    expect(detailFromEnvelope({ item: { source: "jira", id: "J-1", title: "Issue", description: { body: complete, format: "adf-text", truncated: false }, fields: {} } }))
      .toMatchObject({ item: { description: { body: complete, format: "text" } } });

    const oversized = "y".repeat(60_001);
    expect(detailFromEnvelope({ item: { source: "jira", id: "J-1", title: "Issue", description: { body: oversized, format: "text", truncated: false }, fields: {} } }))
      .toMatchObject({ item: { description: { body: "y".repeat(60_000), format: "text", truncated: true } } });
  });

  it("authorizes exactly one private observation for agent Work Items search", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ items: [{ source: "jira", id: "J-1", title: "Issue", fields: {} }], hasMore: false }));
    const approval = { authorizeObservation: vi.fn(), submitAction: vi.fn(), dup() { return this; }, [Symbol.dispose]() {} };
    const session = new TeamPiSessionImpl(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), approval as never, new Kv() as never);

    await expect(session.workItemsSearch({ source: "jira", query: "login" })).resolves.toMatchObject({ items: [{ source: "jira", id: "J-1" }] });
    expect(approval.authorizeObservation).toHaveBeenCalledTimes(1);
    expect(approval.authorizeObservation).toHaveBeenCalledWith({
      title: "Search Team PI Work Items",
      description: "Searched Jira and Zendesk Work Items through Team PI.",
      domainSharingPolicy: { type: "verified-sso-email-domain", emailDomain: "totango.com" },
    });
  });

  it("isolates provider partial failures when searching both Work Items sources", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ source: "jira", items: [{ source: "jira", id: "J-1", title: "Issue", fields: {} }], cursor: "1", hasMore: true }))
      .mockResolvedValueOnce(response({ error: "zendesk_down" }, 503));
    const api = new TeamPiWorkItemsManagementApi(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), fakeAccount());

    await expect(api.search({ source: "both", query: "acme" })).resolves.toEqual({
      items: [{ source: "jira", id: "J-1", title: "Issue", fields: {}, key: undefined, url: undefined, status: undefined, type: undefined, priority: undefined, assignee: undefined, requester: undefined, updatedAt: undefined, projectKey: undefined }],
      cursors: { jira: "1" },
      hasMore: { jira: true },
      errors: [{ source: "zendesk", message: "Team PI API failed: ", status: 503 }],
    });
  });

  it("normalizes Work Items source statuses through the management API", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({
      sources: {
        jira: { configured: true, connected: false, reason: "missing shared connection" },
        zendesk: { configured: true, connected: true, secret: "ignored" },
      },
    }));
    const api = new TeamPiWorkItemsManagementApi(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), fakeAccount());

    await expect(api.getSourceStatuses()).resolves.toEqual({
      jira: { configured: true, connected: false, reason: "missing shared connection" },
      zendesk: { configured: true, connected: true, reason: undefined },
    });
  });

  it("reads the Work Items current user from the stored Team PI OAuth identity", async () => {
    const api = new TeamPiWorkItemsManagementApi(
      new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl),
      fakeAccount({ describeIdentity: async () => ({ displayName: "Dana CSM", uniqueName: "dana@example.com" }) }),
    );

    await expect(api.getCurrentUser()).resolves.toEqual({ displayName: "Dana CSM", uniqueName: "dana@example.com" });
  });

  it("normalizes, replaces, bounds, and deletes stored Work Items saved views", async () => {
    const kv = new Kv();
    const account = new TeamPiAccount({} as never, configEnv());
    (account as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (account as unknown as { env: Env; ctx: unknown }).ctx = {
      storage: { kv, transactionSync: <T>(callback: () => T) => callback() },
    };
    const oversized = {
      id: " mine ",
      name: " My triage ",
      query: "q".repeat(400),
      source: "jira",
      filters: { status: " Open ", priority: "P".repeat(200), type: "Bug", person: "Dana" },
      view: "kanban",
      hiddenStatuses: Array.from({ length: 30 }, (_, i) => `Hidden ${i}`),
    };

    await expect(account.saveWorkItemView(oversized as never)).resolves.toEqual({
      id: "mine",
      name: "My triage",
      query: "q".repeat(300),
      source: "jira",
      filters: { status: "Open", priority: "P".repeat(120), type: "Bug", person: "Dana" },
      view: "kanban",
      hiddenStatuses: Array.from({ length: 25 }, (_, i) => `Hidden ${i}`),
    });
    await expect(account.saveWorkItemView({ ...oversized, id: "builtin:all" } as never))
      .rejects.toThrow("reserved");
    await account.saveWorkItemView({ ...oversized, name: "Replacement", source: "nonsense", view: "grid" } as never);
    await expect(account.listSavedWorkItemViews()).resolves.toMatchObject([{ id: "mine", name: "Replacement", source: "both", view: "list" }]);

    for (let i = 0; i < 25; i++) {
      await account.saveWorkItemView({ id: `v-${i}`, name: `View ${i}`, query: "", source: "both", filters: { status: "", priority: "", type: "", person: "" }, view: "list", hiddenStatuses: [] });
    }
    await expect(account.listSavedWorkItemViews()).resolves.toHaveLength(20);
    await expect(account.listSavedWorkItemViews()).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "mine" })]));
    await account.deleteWorkItemView("v-24");
    await expect(account.listSavedWorkItemViews()).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "v-24" })]));
  });

  it("uses Zendesk internal comments by default and public only when explicit", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ item: { source: "zendesk", id: "12", title: "Ticket", fields: {} } }))
      .mockResolvedValueOnce(response({ item: { source: "zendesk", id: "12", title: "Ticket", fields: {} } }))
      .mockResolvedValueOnce(response({ item: { source: "zendesk", id: "12", title: "Ticket", fields: {} } }))
      .mockResolvedValueOnce(response({ item: { source: "zendesk", id: "12", title: "Ticket", fields: {} } }));
    const item = new TeamPiWorkItemManagementApi(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), { source: "zendesk", id: "12" });

    await expect(item.addComment({ body: "internal note" })).resolves.toMatchObject({ item: { id: "12" } });
    await expect(item.addComment({ body: "customer reply", visibility: "public" })).resolves.toMatchObject({ item: { id: "12" } });

    const bodies = vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith("/comments")).map(call => JSON.parse(String(call[1]?.body)));
    expect(bodies).toEqual([{ body: "internal note" }, { body: "customer reply", visibility: "public" }]);
  });

  it("calls Work Items transition, field update, link, and refreshes detail after mutations", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ item: { source: "jira", id: "J-1", title: "Before", fields: {} } }))
      .mockResolvedValueOnce(response({ item: { source: "jira", id: "J-1", title: "After fields", fields: { summary: "After fields" } } }))
      .mockResolvedValueOnce(response({ item: { source: "jira", id: "J-1", title: "Transitioned", fields: {} } }))
      .mockResolvedValueOnce(response({ item: { source: "jira", id: "J-1", title: "Done", fields: {} } }))
      .mockResolvedValueOnce(response({ link: { globalId: "gid", jiraId: "J-1", zendeskTicketId: "12" } }));
    const item = new TeamPiWorkItemManagementApi(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), { source: "jira", id: "J-1" });

    await expect(item.updateFields({ fields: { summary: "After fields" } })).resolves.toMatchObject({ item: { title: "After fields" } });
    await expect(item.transition("31")).resolves.toMatchObject({ item: { title: "Done" } });
    await expect(item.linkTo({ source: "zendesk", id: "12" })).resolves.toEqual({ globalId: "gid", jiraId: "J-1", zendeskTicketId: "12" });

    expect(vi.mocked(fetch).mock.calls.map(call => [String(call[0]), call[1]?.method ?? "GET"])).toEqual([
      ["https://team-pi.example/api/work-items/v1/items/jira/J-1/fields", "PATCH"],
      ["https://team-pi.example/api/work-items/v1/items/jira/J-1", "GET"],
      ["https://team-pi.example/api/work-items/v1/items/jira/J-1/transitions", "POST"],
      ["https://team-pi.example/api/work-items/v1/items/jira/J-1", "GET"],
      ["https://team-pi.example/api/work-items/v1/links", "POST"],
    ]);
  });

  it("preserves complete bounded descriptions when updating fields", async () => {
    const description = "Detailed context.\n".repeat(2_000);
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({ item: { source: "jira", id: "J-1", title: "Issue", fields: {} } }));
    const item = new TeamPiWorkItemManagementApi(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), { source: "jira", id: "J-1" });

    await item.updateFields({ fields: { description } });

    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({ fields: { description } });
  });

  it("composes selected Work Item reads from detail, comments, activity, options, and Jira transitions", async () => {
    const attachments = Array.from({ length: 100 }, (_, index) => ({ id: `att-${index}`, name: `file-${index}.png`, contentType: "image/png", size: index, commentId: "c1", createdAt: undefined }));
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ item: { source: "jira", id: "J-1", title: "Issue", fields: {} } }))
      .mockResolvedValueOnce(response({ comments: [{ id: "c1", body: "hello" }] }))
      .mockResolvedValueOnce(response({ activity: [{ id: "a1", type: "changelog", summary: "changed" }] }))
      .mockResolvedValueOnce(response({ source: "jira", id: "J-1", allowedFields: ["summary"], providerOptions: ["summary", "secret".repeat(100)] }))
      .mockResolvedValueOnce(response({ transitions: [{ id: "31", name: "Done", toStatus: "Done" }] }))
      .mockResolvedValueOnce(response({ attachments }));
    const item = new TeamPiWorkItemManagementApi(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), { source: "jira", id: "J-1" });

    await expect(item.read()).resolves.toMatchObject({
      detail: { item: { id: "J-1", title: "Issue" } },
      comments: [{ id: "c1", body: "hello", public: true }],
      activity: [{ id: "a1", type: "changelog", summary: "changed" }],
      updateOptions: { source: "jira", id: "J-1", allowedFields: ["summary"], providerOptions: ["summary", expect.stringMatching(/^secret/) ] },
      transitions: [{ id: "31", name: "Done", toStatus: "Done" }],
      attachments,
    });
  });

  it("reads authoritative Zendesk tickets through Work Items and then stores only minimized memory", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ item: { source: "zendesk", id: "12", title: "Login failing", url: "https://acme.zendesk.com/agent/tickets/12", status: "open", type: "incident", priority: "high", requester: "Customer", assignee: "Agent", description: { body: "secret description" }, fields: { brandId: "brand-1", account_id: "acct-1", raw: "ignored" } } }))
      .mockResolvedValueOnce(response({ comments: [{ id: "c1", author: "Customer", body: "private comment" }] }))
      .mockResolvedValueOnce(response({ activity: [{ id: "a1", type: "audit", author: "Agent", summary: "updated" }] }))
      .mockResolvedValueOnce(response({ allowedFields: ["status"] }))
      .mockResolvedValueOnce(response({ attachments: [{ id: "att-1", name: "screen.png", contentType: "image/png" }] }));
    const kv = new Kv();
    const approval = { authorizeObservation: vi.fn(), submitAction: vi.fn(), dup() { return this; }, [Symbol.dispose]() {} };
    const session = new TeamPiSessionImpl(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), approval as never, kv as never);

    await expect(session.readZendeskTicket({ id: "12" })).resolves.toMatchObject({
      detail: { item: { source: "zendesk", id: "12", description: { body: "secret description" } } },
      comments: [{ body: "private comment", public: true }],
      activity: [{ summary: "updated" }],
      updateOptions: { source: "zendesk", id: "12", allowedFields: ["status"] },
      transitions: [],
      attachments: [{ id: "att-1", name: "screen.png" }],
    });
    expect(approval.authorizeObservation).toHaveBeenCalledWith(expect.objectContaining({
      domainSharingPolicy: { type: "verified-sso-email-domain", emailDomain: "totango.com" },
    }));
    expect(vi.mocked(fetch).mock.calls.map(call => String(call[0]))).toEqual([
      "https://team-pi.example/api/work-items/v1/items/zendesk/12",
      "https://team-pi.example/api/work-items/v1/items/zendesk/12/comments",
      "https://team-pi.example/api/work-items/v1/items/zendesk/12/activity",
      "https://team-pi.example/api/work-items/v1/items/zendesk/12/update-options",
      "https://team-pi.example/api/work-items/v1/items/zendesk/12/attachments",
    ]);
    const meta = kv.get<{ partitions: { keyHash: string; lastUsedAt: number }[] }>("zendeskTicketMemory:v2:meta");
    expect(meta?.partitions).toHaveLength(1);
    const entries = kv.get<unknown[]>(`zendeskTicketMemory:v2:partition:${meta?.partitions[0]?.keyHash}`);
    expect(entries?.[0]).toEqual({
      id: "12",
      url: "https://acme.zendesk.com/agent/tickets/12",
      title: "Login failing",
      status: "open",
      type: "incident",
      priority: "high",
      rememberedAt: expect.any(Number),
    });
    expect(JSON.stringify([meta, entries])).not.toMatch(/brand-1|acct-1|secret description|private comment|Customer|Agent|screen\.png|raw/);
  });

  it("skips memory when authoritative partition dimensions are incomplete", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ item: { source: "zendesk", id: "13", title: "No account fields", url: "https://acme.zendesk.com/agent/tickets/13", fields: {} } }))
      .mockResolvedValueOnce(response({ comments: [] }))
      .mockResolvedValueOnce(response({ activity: [] }))
      .mockResolvedValueOnce(response({ allowedFields: [] }))
      .mockResolvedValueOnce(response({ attachments: [] }))
      .mockResolvedValueOnce(response({ item: { source: "zendesk", id: "14", title: "Incomplete", url: "https://acme.zendesk.com/agent/tickets/14", fields: { brandId: "brand-1" } } }))
      .mockResolvedValueOnce(response({ comments: [] }))
      .mockResolvedValueOnce(response({ activity: [] }))
      .mockResolvedValueOnce(response({ allowedFields: [] }))
      .mockResolvedValueOnce(response({ attachments: [] }));
    const kv = new Kv();
    const approval = { authorizeObservation: vi.fn(), submitAction: vi.fn(), dup() { return this; }, [Symbol.dispose]() {} };
    const session = new TeamPiSessionImpl(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), approval as never, kv as never);

    await session.readZendeskTicket({ id: "13" });
    await session.readZendeskTicket({ id: "14" });

    expect(kv.get("zendeskTicketMemory:v2:meta")).toBeUndefined();
  });

  it("canonicalizes remembered Zendesk URLs and requires a recognized ticket path for the ticket id", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ item: { source: "zendesk", id: "17", title: "Canonical", url: "https://acme.zendesk.com/agent/tickets/17?token=secret#fragment", fields: { brandId: "brand-1", account_id: "acct-1" } } }))
      .mockResolvedValueOnce(response({ comments: [] })).mockResolvedValueOnce(response({ activity: [] })).mockResolvedValueOnce(response({ allowedFields: [] })).mockResolvedValueOnce(response({ attachments: [] }))
      .mockResolvedValueOnce(response({ item: { source: "zendesk", id: "18", title: "Wrong path", url: "https://acme.zendesk.com/users/18?token=secret", fields: { brandId: "brand-1", account_id: "acct-1" } } }))
      .mockResolvedValueOnce(response({ comments: [] })).mockResolvedValueOnce(response({ activity: [] })).mockResolvedValueOnce(response({ allowedFields: [] })).mockResolvedValueOnce(response({ attachments: [] }));
    const kv = new Kv();
    const approval = { authorizeObservation: vi.fn(), submitAction: vi.fn(), dup() { return this; }, [Symbol.dispose]() {} };
    const session = new TeamPiSessionImpl(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), approval as never, kv as never);

    await session.readZendeskTicket({ id: "17" });
    await session.readZendeskTicket({ id: "18" });

    const meta = kv.get<{ partitions: { keyHash: string }[] }>("zendeskTicketMemory:v2:meta");
    const entries = kv.get<{ id: string; url?: string }[]>(`zendeskTicketMemory:v2:partition:${meta?.partitions[0]?.keyHash}`);
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: "17", url: "https://acme.zendesk.com/agent/tickets/17" })]));
    const wrongPath = entries?.find(entry => entry.id === "18");
    expect(wrongPath).toBeUndefined();
    expect(JSON.stringify(entries)).not.toMatch(/token=secret|fragment/);
  });

  it("searches Zendesk ticket memory by exact partition with lexical query and limits", async () => {
    const kv = new Kv();
    const approval = { authorizeObservation: vi.fn(), submitAction: vi.fn(), dup() { return this; }, [Symbol.dispose]() {} };
    const session = new TeamPiSessionImpl(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), approval as never, kv as never);
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ item: { source: "zendesk", id: "1", title: "Login broken", url: "https://acme.zendesk.com/agent/tickets/1", fields: { brand: "b1", organization_id: "a1" } } }))
      .mockResolvedValueOnce(response({ comments: [] })).mockResolvedValueOnce(response({ activity: [] })).mockResolvedValueOnce(response({ allowedFields: [] })).mockResolvedValueOnce(response({ attachments: [] }))
      .mockResolvedValueOnce(response({ item: { source: "zendesk", id: "2", title: "Billing question", url: "https://acme.zendesk.com/agent/tickets/2", fields: { brand: "b1", organization_id: "a1" } } }))
      .mockResolvedValueOnce(response({ comments: [] })).mockResolvedValueOnce(response({ activity: [] })).mockResolvedValueOnce(response({ allowedFields: [] })).mockResolvedValueOnce(response({ attachments: [] }))
      .mockResolvedValueOnce(response({ item: { source: "zendesk", id: "3", title: "Login other account", url: "https://acme.zendesk.com/agent/tickets/3", fields: { brand: "b1", organization_id: "a2" } } }))
      .mockResolvedValueOnce(response({ comments: [] })).mockResolvedValueOnce(response({ activity: [] })).mockResolvedValueOnce(response({ allowedFields: [] })).mockResolvedValueOnce(response({ attachments: [] }));
    await session.readZendeskTicket({ id: "1" });
    await session.readZendeskTicket({ id: "2" });
    await session.readZendeskTicket({ id: "3" });
    vi.mocked(fetch).mockClear();

    await expect(session.searchZendeskTicketMemory({ partition: { brandId: "b1", accountId: "a1", subdomain: "acme" }, query: "login", limit: 1 })).resolves.toEqual({
      items: [expect.objectContaining({ id: "1", title: "Login broken", partition: { brandId: "b1", accountId: "a1", subdomain: "acme" } })],
    });
    await expect(session.searchZendeskTicketMemory({ partition: { brandId: "b1", accountId: "a2", subdomain: "acme" }, query: "login" })).resolves.toEqual({
      items: [expect.objectContaining({ id: "3", title: "Login other account" })],
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(approval.authorizeObservation).toHaveBeenCalledTimes(5);
  });

  it("enforces Zendesk ticket memory TTL, per-partition entry cap, and LRU partition cap", async () => {
    const kv = new Kv();
    const now = Date.now();
    const searchedHash = await testSha256(JSON.stringify({ brandId: "missing", accountId: "a", subdomain: "acme" }));
    const partitions = Array.from({ length: 27 }, (_, partitionIndex) => ({
      keyHash: partitionIndex === 0 ? searchedHash : partitionIndex.toString(16).padStart(2, "0").repeat(32),
      lastUsedAt: now - partitionIndex,
    }));
    for (const [partitionIndex, partition] of partitions.entries()) {
      kv.put(`zendeskTicketMemory:v2:partition:${partition.keyHash}`, Array.from({ length: partitionIndex === 0 ? 105 : 1 }, (_, entryIndex) => ({
        id: `${partitionIndex}-${entryIndex}`,
        title: `Ticket ${entryIndex}`,
        rememberedAt: entryIndex === 104 ? now - 31 * 24 * 60 * 60 * 1000 : now - entryIndex,
      })));
    }
    kv.put("zendeskTicketMemory:v2:meta", { partitions });
    const approval = { authorizeObservation: vi.fn(), submitAction: vi.fn(), dup() { return this; }, [Symbol.dispose]() {} };
    const session = new TeamPiSessionImpl(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), approval as never, kv as never);

    await session.searchZendeskTicketMemory({ partition: { brandId: "missing", accountId: "a", subdomain: "acme" } });

    const meta = kv.get<{ partitions: { keyHash: string }[] }>("zendeskTicketMemory:v2:meta");
    expect(meta?.partitions.length).toBeLessThanOrEqual(25);
    const entries = kv.get<unknown[]>(`zendeskTicketMemory:v2:partition:${partitions[0]?.keyHash}`);
    expect(entries?.length).toBe(50);
    expect(JSON.stringify(entries)).not.toContain("0-104");
    expect(kv.get(`zendeskTicketMemory:v2:partition:${partitions[26]?.keyHash}`)).toBeUndefined();
  });

  it("does not mutate Zendesk ticket memory search state before observation authorization", async () => {
    const kv = new Kv();
    const seededHash = await testSha256(JSON.stringify({ brandId: "b", accountId: "a", subdomain: "acme" }));
    kv.put("zendeskTicketMemory:v2:meta", { partitions: [{ keyHash: seededHash, lastUsedAt: 1 }] });
    kv.put(`zendeskTicketMemory:v2:partition:${seededHash}`, [{ id: "1", title: "Ticket", rememberedAt: Date.now() }]);
    const before = JSON.stringify([...kv.values.entries()]);
    const approval = { authorizeObservation: vi.fn().mockRejectedValue(new Error("denied")), submitAction: vi.fn(), dup() { return this; }, [Symbol.dispose]() {} };
    const session = new TeamPiSessionImpl(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), approval as never, kv as never);

    await expect(session.searchZendeskTicketMemory({ partition: { brandId: "b", accountId: "a", subdomain: "acme" } })).rejects.toThrow("denied");

    expect(JSON.stringify([...kv.values.entries()])).toBe(before);
  });

  it("covers a customer/product issue query flow across discovery and provider reads", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ skills: [{ id: "customer-health", name: "Customer Health", description: "Investigate customer product issues" }] }))
      .mockResolvedValueOnce(response({ connections: { chorus: "chorus-user" }, shared: { zendesk: "zendesk-shared", salesforce: "sf-shared" } }))
      .mockResolvedValueOnce(response({ account: { id: "acme", name: "Acme", health: "red", productArea: "Onboarding" } }))
      .mockResolvedValueOnce(response({ tickets: [{ id: "ZD-7", subject: "Onboarding import failing", status: "open" }] }))
      .mockResolvedValueOnce(response({ account: { id: "001", name: "Acme", csm: "Dana" } }));
    const approval = { authorizeObservation: vi.fn(), submitAction: vi.fn(), dup() { return this; }, [Symbol.dispose]() {} };
    const session = new TeamPiSessionImpl(new TeamPiApi(async () => ({ accessToken: "access", idToken: "identity" }), config.baseUrl), approval as never, new Kv() as never);

    await expect(session.listSkills({ query: "customer product issue", limit: 5 })).resolves.toMatchObject({
      items: [{ id: "customer-health", name: "Customer Health" }],
    });
    await expect(session.listConnections()).resolves.toMatchObject({
      items: expect.arrayContaining([
        { id: "chorus-user", name: "chorus", provider: "chorus", scope: "user", status: "connected" },
        { id: "zendesk-shared", name: "zendesk", provider: "zendesk", scope: "shared", status: "connected" },
        { id: "sf-shared", name: "salesforce", provider: "salesforce", scope: "shared", status: "connected" },
      ]),
    });
    await expect(session.chorusAccount("acme")).resolves.toMatchObject({ account: { name: "Acme", productArea: "Onboarding" } });
    await expect(session.zendeskSearch({ query: "Acme Onboarding import failing", limit: 5 })).resolves.toMatchObject({ tickets: [{ id: "ZD-7" }] });
    await expect(session.salesforceAccount("Acme")).resolves.toMatchObject({ account: { csm: "Dana" } });
    expect(approval.authorizeObservation).toHaveBeenCalledTimes(5);
    expect(vi.mocked(fetch).mock.calls.map(call => String(call[0]))).toEqual([
      "https://team-pi.example/api/skills?query=customer+product+issue&limit=5",
      "https://team-pi.example/connections?limit=10",
      "https://team-pi.example/chorus/account?q=acme",
      "https://team-pi.example/zendesk/search?limit=5&q=Acme+Onboarding+import+failing",
      "https://team-pi.example/salesforce/account?q=Acme",
    ]);
  });

  it("sanitizes write results and refuses unknown action IDs", async () => {
    const kv = new Kv();
    const approval = { authorizeObservation: vi.fn(), submitAction: vi.fn(), dup() { return this; }, [Symbol.dispose]() {} };
    const session = new TeamPiSessionImpl(new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl), approval as never, kv as never);
    expect(() => getStoredActionResult(kv as never, 99)).toThrow(/Unknown/);
    kv.put("result:1", { status: "ready", result: { provider: "gmail", connectionId: "c1", localConnectUrl: "https://team-pi.example/connect/gmail/page?user=u" } });
    await expect(session.getActionResult(1)).resolves.toMatchObject({ status: "ready", result: { provider: "gmail", connectionId: "c1" } });
  });

  it("applies approved Jira creation and stores a sanitized ready result", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ item: {
      source: "jira",
      id: "10001",
      key: "AI-17",
      url: "https://jira.example/browse/AI-17",
      title: "Created",
      projectKey: "AI",
      description: { body: "Safe", format: "markdown" },
      fields: { summary: "Created", customfield_10000: "secret", providerOptions: "secret" },
      token: "secret",
    } }));
    const kv = new Kv();
    kv.put("pending:3", { kind: "createJiraIssue", request: { projectKey: "AI", issueType: "Story", summary: "Created", description: "Safe" } });
    const gatekeeper = new TeamPiGatekeeper({} as never, configEnv());
    (gatekeeper as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (gatekeeper as unknown as { ctx: unknown }).ctx = {
      storage: { kv },
      props: { accountId: "account-1" },
      exports: { TeamPiAccount: { idFromString: (id: string) => id, get: () => ({ getApiCredentials: async () => ({ accessToken: "access" }) }) } },
    };

    await gatekeeper.applyAction(3);

    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({ projectKey: "AI", issueType: "Story", summary: "Created", description: "Safe" });
    expect(kv.get("result:3")).toEqual({ status: "ready", result: { item: expect.objectContaining({ source: "jira", id: "10001", key: "AI-17", title: "Created", fields: { summary: "Created" } }) } });
    expect(JSON.stringify(kv.get("result:3"))).not.toMatch(/customfield|providerOptions|token|secret/);
  });

  it("marks failed Jira creation apply attempts as unknown and non-retryable", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: "upstream_write_status_unknown" }, 502));
    const kv = new Kv();
    kv.put("pending:4", { kind: "createJiraIssue", request: { projectKey: "AI", issueType: "Story", summary: "Created", description: "Safe" } });
    const gatekeeper = new TeamPiGatekeeper({} as never, configEnv());
    (gatekeeper as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (gatekeeper as unknown as { ctx: unknown }).ctx = {
      storage: { kv },
      props: { accountId: "account-1" },
      exports: { TeamPiAccount: { idFromString: (id: string) => id, get: () => ({ getApiCredentials: async () => ({ accessToken: "access" }) }) } },
    };

    await gatekeeper.applyAction(4);

    expect(kv.get("result:4")).toEqual({ status: "unknown", message: "Team PI API failed: ", canRetry: false });
    expect(kv.get("applying:4")).toBeUndefined();
  });

  it("marks definite Jira creation denials as failed", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: "project_not_allowed" }, 403));
    const kv = new Kv();
    kv.put("pending:5", { kind: "createJiraIssue", request: { projectKey: "NOPE", issueType: "Story", summary: "Created", description: "Safe" } });
    const gatekeeper = new TeamPiGatekeeper({} as never, configEnv());
    (gatekeeper as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (gatekeeper as unknown as { ctx: unknown }).ctx = {
      storage: { kv },
      props: { accountId: "account-1" },
      exports: { TeamPiAccount: { idFromString: (id: string) => id, get: () => ({ getApiCredentials: async () => ({ accessToken: "access" }) }) } },
    };

    await gatekeeper.applyAction(5);

    expect(kv.get("result:5")).toEqual({ status: "failed", message: expect.stringMatching(/denied access/i) });
  });

  it("fails closed for unknown persisted action kinds", async () => {
    const kv = new Kv();
    kv.put("pending:6", { kind: "futureAction", request: { projectKey: "AI", issueType: "Story", summary: "Must not create", description: "Safe" } });
    const gatekeeper = new TeamPiGatekeeper({} as never, configEnv());
    (gatekeeper as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (gatekeeper as unknown as { ctx: unknown }).ctx = {
      storage: { kv },
      props: { accountId: "account-1" },
      exports: { TeamPiAccount: { idFromString: (id: string) => id, get: () => ({ getApiCredentials: async () => ({ accessToken: "access" }) }) } },
    };

    await gatekeeper.applyAction(6);

    expect(fetch).not.toHaveBeenCalled();
    expect(kv.get("result:6")).toEqual({ status: "unknown", message: "Unknown Team PI action kind.", canRetry: false });
  });

  it("allowlists write-result fields and strips connection bootstrap secrets", () => {
    expect(sanitizeStartConnectionResult("gmail", {
      connectionId: "c1",
      localConnectUrl: "https://team-pi.example/connect/gmail/page?user=u&sessionToken=secret",
      sessionToken: "secret",
      connectLink: "https://nango.example/secret",
    }, config.baseUrl)).toEqual({
      provider: "gmail",
      alreadyConnected: undefined,
      connectionId: "c1",
      browserUrl: "https://team-pi.example/connect/gmail/page?user=u",
    });
    expect(sanitizeInstallSkillResult({
      ok: true,
      connectionStatus: {
        user: { gmail: true, sessionToken: "secret" },
        shared: { zendesk: false },
        connectLink: "https://nango.example/secret",
      },
    })).toEqual({
      ok: true,
      skill: undefined,
      connectionStatus: { user: { gmail: true }, shared: { zendesk: false }, token: {} },
    });
  });

  it("marks stale applying actions unknown without redispatching", () => {
    const kv = new Kv();
    kv.put("applying:2", { kind: "startConnection", provider: "gmail", claimedAt: Date.now() - 10 * 60 * 1000 });
    expect(getStoredActionResult(kv as never, 2)).toEqual({ status: "unknown", message: "Team PI action application timed out; outcome is unknown and will not be retried.", canRetry: false });
    expect(kv.get("applying:2")).toBeUndefined();
  });

  it("bounds catalog entries built from skills and connections", () => {
    const entries = [
      ...catalogEntries("skill", { items: [{ id: "s1", name: "Skill", description: "x" }] }),
      ...catalogEntries("connection", { items: [{ id: "c1", name: "Connection" }] }),
    ];
    expect(boundAgentCatalog(entries)).toEqual({
      entries: [
        { id: "skill:s1", title: "Skill", description: "x" },
        { id: "connection:c1", title: "Connection", description: "connection available in Team PI" },
      ],
      truncated: false,
    });
  });

  it("builds ambient discovery from public skills without reading private connections", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({
      skills: [{ id: "s1", name: "Skill", description: "Public manifest" }],
    }));
    const authorizeObservation = vi.fn();
    const authorizer = Object.assign(new RpcStub({} as never), { authorizeObservation });
    const gatekeeper = new TeamPiGatekeeper({} as never, configEnv());
    (gatekeeper as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (gatekeeper as unknown as { env: Env; ctx: unknown }).ctx = {
      props: { accountId: "account-1" },
      exports: {
        TeamPiAccount: {
          idFromString: (id: string) => id,
          get: () => ({
            getApiCredentials: async () => ({ accessToken: "access", idToken: "identity" }),
          }),
        },
      },
    };

    await expect(gatekeeper.getAgentCatalog(authorizer as never)).resolves.toEqual({
      entries: [
        { id: "skill:s1", title: "Skill", description: "Public manifest" },
        { id: "provider:gmail", title: "Gmail", description: "Search and read Gmail messages available through Team PI." },
        { id: "provider:calendar", title: "Calendar", description: "Read calendar events available through Team PI." },
        { id: "provider:chorus", title: "Chorus", description: "Search calls and read customer account, engagement, and conversation details through Team PI." },
        { id: "provider:zendesk", title: "Zendesk", description: "Search and read support tickets available through Team PI." },
        { id: "provider:salesforce", title: "Salesforce", description: "Read customer account records available through Team PI." },
        { id: "provider:work-items", title: "Work Items / Jira", description: "Search Jira issues and Zendesk tickets through Team PI Work Items, and request approved Jira issue creation with createJiraIssue(request)." },
        { id: "provider:docs", title: "Docs", description: "Discover document-oriented Team PI skills and provider capabilities." },
      ],
      truncated: false,
    });
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe("https://team-pi.example/api/skills?limit=12");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(authorizeObservation).toHaveBeenCalledWith({
      title: "Read Team PI skill, provider, and Work Items catalog",
      description: "Listed bounded Team PI skill manifests, provider capabilities, Work Items/Jira search, and approval-backed Jira issue creation capability for agent discovery.",
      domainSharingPolicy: { type: "verified-sso-email-domain", emailDomain: "totango.com" },
    });
  });

  it("declares the Totango SSO sharing policy in its resource description", async () => {
    const gatekeeper = new TeamPiGatekeeper({} as never, configEnv());
    await expect(gatekeeper.describe()).resolves.toMatchObject({
      domainSharingPolicy: { type: "verified-sso-email-domain", emailDomain: "totango.com" },
    });
  });

  it("returns fallback capabilities when the live catalog cannot load", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: "upstream_down" }, 503));
    const authorizeObservation = vi.fn();
    const authorizer = Object.assign(new RpcStub({} as never), { authorizeObservation });
    const gatekeeper = new TeamPiGatekeeper({} as never, configEnv());
    (gatekeeper as unknown as { env: Env; ctx: unknown }).env = configEnv();
    (gatekeeper as unknown as { env: Env; ctx: unknown }).ctx = {
      props: { accountId: "account-1" },
      exports: {
        TeamPiAccount: {
          idFromString: (id: string) => id,
          get: () => ({
            getApiCredentials: async () => ({ accessToken: "access", idToken: "identity" }),
          }),
        },
      },
    };

    await expect(gatekeeper.getAgentCatalog(authorizer as never)).resolves.toEqual({
      entries: [
        { id: "team-pi:catalog-unavailable", title: "Team PI unavailable", description: "Team PI API failed: " },
      ],
      truncated: false,
    });
    expect(authorizeObservation).toHaveBeenCalledWith({
      title: "Team PI catalog unavailable",
      description: "Team PI API failed: ",
      domainSharingPolicy: { type: "verified-sso-email-domain", emailDomain: "totango.com" },
    });
  });
});

describe("Team PI rejection is always possible", () => {
  it("records a rejection for an action this binding never knew about", () => {
    // The Workshop asks the gatekeeper to reject before it records the rejection, so throwing here
    // would leave an approval the user can never dismiss. One cannot fail to *not* do something.
    const kv = new Kv();
    expect(() => rejectPendingAction(kv as never, 7)).not.toThrow();
    expect(kv.get("result:7")).toEqual({ status: "rejected" });
  });

  it("still refuses to reject an action that is already being applied", () => {
    // This one must keep throwing: the write may already have reached Team PI.
    const kv = new Kv();
    kv.put("applying:1", { kind: "startConnection", provider: "gmail", claimedAt: Date.now() });
    expect(() => rejectPendingAction(kv as never, 1)).toThrow(/already applying/);
  });
});
