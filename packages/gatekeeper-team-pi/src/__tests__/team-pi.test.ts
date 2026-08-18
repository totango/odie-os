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
import { TeamPiAccount, TeamPiGatekeeper, TeamPiSessionImpl, TeamPiUser, catalogEntries, claimPendingAction, getStoredActionResult, rejectPendingAction, safeConnectionUrl, sanitizeInstallSkillResult, sanitizeStartConnectionResult } from "../team-pi.js";

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

  it("turns Team PI auth denials into actionable access errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: "missing_id_token" }, 403));
    const api = new TeamPiApi(async () => ({ accessToken: "access" }), config.baseUrl);

    await expect(api.listSkills()).rejects.toThrow(/denied access|Reconnect Team PI|required provider\/skill/);
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
    (account as unknown as { env: Env; ctx: unknown }).ctx = { storage: { kv } };
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
});

function configEnv(): Env {
  return {
    TEAM_PI_AUTH0_DOMAIN: "https://tenant.auth0.com",
    TEAM_PI_AUTH0_CLIENT_ID: "public-client",
    TEAM_PI_AUTH0_AUDIENCE: "https://team-pi.example/api",
    TEAM_PI_BASE_URL: "https://team-pi.example",
  } as unknown as Env;
}

describe("Team PI reads, writes, endpoint allowlist, and catalog", () => {
  it("configures the whole-account resource for an existing authenticated account", async () => {
    const user = new TeamPiUser({} as never, configEnv());
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
    expect(approval.authorizeObservation).toHaveBeenCalledWith(expect.objectContaining({ prohibitAllSharing: true }));
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
    expect(boundAgentCatalog(entries, { limit: 1 })).toEqual({
      entries: [{ id: "skill:s1", title: "Skill", description: "x" }],
      truncated: true,
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

    await expect(gatekeeper.getAgentCatalog(
      { limit: 10 },
      authorizer as never,
    )).resolves.toEqual({
      entries: [
        { id: "skill:s1", title: "Skill", description: "Public manifest" },
        { id: "provider:gmail", title: "Gmail", description: "Search and read Gmail messages available through Team PI." },
        { id: "provider:calendar", title: "Calendar", description: "Read calendar events available through Team PI." },
        { id: "provider:chorus", title: "Chorus", description: "Search calls and read customer account, engagement, and conversation details through Team PI." },
        { id: "provider:zendesk", title: "Zendesk", description: "Search and read support tickets available through Team PI." },
        { id: "provider:salesforce", title: "Salesforce", description: "Read customer account records available through Team PI." },
        { id: "provider:docs", title: "Docs", description: "Discover document-oriented Team PI skills and provider capabilities." },
      ],
      truncated: false,
    });
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe("https://team-pi.example/api/skills?limit=12");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(authorizeObservation).toHaveBeenCalledWith({
      title: "Read Team PI skill and provider catalog",
      description: "Listed bounded Team PI skill manifests and provider capabilities for agent discovery.",
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

    await expect(gatekeeper.getAgentCatalog({ limit: 3 }, authorizer as never)).resolves.toEqual({
      entries: [
        { id: "team-pi:catalog-unavailable", title: "Team PI unavailable", description: "Team PI API failed: " },
      ],
      truncated: false,
    });
    expect(authorizeObservation).toHaveBeenCalledWith({
      title: "Team PI catalog unavailable",
      description: "Team PI API failed: ",
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
