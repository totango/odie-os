import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpSessionBase } from "@gadgets/mcp-shared/session";
import {
  connect,
  listConnectedAccounts,
  nextUsernames,
  signUp,
  waitFor,
} from "@gadgets/integration-tests/rpc-client";
import {
  startHarness,
  type Harness,
} from "@gadgets/integration-tests/harness";
import { NetworkInterceptor, type Handler } from "@gadgets/integration-tests/network-interceptor";
import {
  ODIE_KG_ACTION_TOOLS,
  ODIE_KG_ALLOWED_TOOLS,
  ODIE_KG_DISPLAY_NAME,
  ODIE_KG_EU_ENDPOINT,
  ODIE_KG_OAUTH_SCOPE,
  VENDOR_ID,
} from "../src/config.js";

const ODIE_KG_DIR = new URL("..", import.meta.url).pathname;
const ODIE_KG_BINDING = "ODIE_KG";
const MCP_ENDPOINT = ODIE_KG_EU_ENDPOINT;
const AUTH_ISSUER = "https://auth.test";
type JsonRpcRequest = {
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
};

type RemoteScenario = {
  listStatus?: 401 | 403 | 429;
  omitTool?: string;
  toolError?: { name: string; message: string };
};

let remoteScenario: RemoteScenario = {};

type PublicApiStub = ReturnType<typeof connect>;
type AuthenticatedApiStub = Awaited<ReturnType<typeof signUp>>;
type McpSessionStub = McpSessionBase & Disposable;

function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, init);
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown, init: ResponseInit = {}): Response {
  return json({ jsonrpc: "2.0", id, result }, init);
}

function allRemoteTools(scenario: RemoteScenario = {}) {
  return ODIE_KG_ALLOWED_TOOLS.map(name => ({
      name,
      title: name,
      description: `Fixture tool ${name}.`,
      inputSchema: { type: "object", additionalProperties: true },
      annotations: {
        readOnlyHint: !(ODIE_KG_ACTION_TOOLS as readonly string[]).includes(name),
      },
    })).filter(tool => tool.name !== scenario.omitTool);
}

function odieOauthAndMcpHandler(seen: string[]): Handler {
  return async (url, method, headers, request) => {
    seen.push(`${method} ${url.href}`);

    if (url.href === MCP_ENDPOINT && method === "POST") {
      const body = await request.json() as JsonRpcRequest;
      if (!headers.has("authorization")) {
        return new Response("authorization required", {
          status: 401,
          headers: {
            "WWW-Authenticate":
              `Bearer resource_metadata="https://odie.test/.well-known/oauth-protected-resource/api/mcp/odie"`,
          },
        });
      }
      expect(headers.get("authorization")).toBe("Bearer access-token");
      if (body.method === "initialize") {
        return rpcResult(body.id, {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "ODIE MCP fixture", title: "ODIE MCP fixture" },
          capabilities: { tools: {} },
        }, { headers: { "Mcp-Session-Id": "mcp-session-1" } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") {
        if (remoteScenario.listStatus === 401) return new Response("token expired", { status: 401 });
        if (remoteScenario.listStatus === 403) return new Response("forbidden", { status: 403 });
        if (remoteScenario.listStatus === 429) return new Response("rate limited", { status: 429 });
        return rpcResult(body.id, {tools: allRemoteTools(remoteScenario)});
      }
      if (body.method === "tools/call") {
        const toolError = remoteScenario.toolError;
        if (toolError && body.params?.name === toolError.name) {
          return rpcResult(body.id, {
            content: [{type: "text", text: toolError.message}],
            isError: true,
          });
        }
        expect(ODIE_KG_ALLOWED_TOOLS).toContain(body.params?.name);
        return rpcResult(body.id, {
          content: [{type: "text", text: `KG ${body.params?.name} returned data`}],
          isError: false,
        });
      }
      return rpcResult(body.id, null);
    }

    if (url.href === "https://odie.test/.well-known/oauth-protected-resource/api/mcp/odie") {
      return json({
        resource: MCP_ENDPOINT,
        authorization_servers: [AUTH_ISSUER],
        scopes_supported: ODIE_KG_OAUTH_SCOPE.split(" "),
      });
    }
    if (url.href === `${AUTH_ISSUER}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: AUTH_ISSUER,
        authorization_endpoint: `${AUTH_ISSUER}/authorize`,
        token_endpoint: `${AUTH_ISSUER}/token`,
        registration_endpoint: `${AUTH_ISSUER}/register`,
        response_types_supported: ["code"],
      });
    }
    if (url.href === `${AUTH_ISSUER}/register` && method === "POST") {
      expect(await request.json()).toMatchObject({
        client_name: "Odie OS E2E",
        redirect_uris: ["http://localhost:8787/gatekeeper/odie-kg/oauth"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
      return json({
        client_id: "odie-test-client",
        redirect_uris: ["http://localhost:8787/gatekeeper/odie-kg/oauth"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    }
    if (url.href === `${AUTH_ISSUER}/token` && method === "POST") {
      const body = new URLSearchParams(await request.text());
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("authorization-code");
      expect(body.get("redirect_uri")).toBe("http://localhost:8787/gatekeeper/odie-kg/oauth");
      expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
      return json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return null;
  };
}

let harness: Harness;
let interceptor: NetworkInterceptor;
let seenNetwork: string[];

beforeAll(async () => {
  seenNetwork = [];
  interceptor = new NetworkInterceptor([odieOauthAndMcpHandler(seenNetwork)]);
  interceptor.install();
  harness = await startHarness({
    gatekeepers: [{
      binding: ODIE_KG_BINDING,
      dir: ODIE_KG_DIR,
      patch(config) {
        config.vars = {
          ...config.vars,
          ODIE_KG_MCP_URL: MCP_ENDPOINT,
          MCP_CLIENT_NAME: "Odie OS E2E",
        };
      },
    }],
    patchWorkshop(config) {
      config.vars = {
        ...config.vars,
        REQUIRED_HEALTHY_CONNECTIONS: VENDOR_ID,
      };
    },
  });
}, 60_000);

afterAll(async () => {
  const unmocked = interceptor.getUnmockedCalls();
  await harness?.server.close();
  interceptor.uninstall();
  interceptor.reset();
  expect(unmocked).toEqual([]);
}, 30_000);

async function withSession<T>(body: (api: PublicApiStub) => Promise<T>): Promise<T> {
  const publicApi = connect(harness.url);
  try {
    return await body(publicApi);
  } finally {
    publicApi[Symbol.dispose]();
  }
}

async function connectOdieKgAccount(api: AuthenticatedApiStub) {
  const { url: connectUrl } = await api.connectAccount(VENDOR_ID);
  const connectResponse = await harness.fetchWorker(
    "gatekeeper-odie-kg", connectUrl, { redirect: "manual" });
  expect(connectResponse.status).toBe(302);
  const authorizationUrl = new URL(connectResponse.headers.get("location")!);
  const callbackUrl = new URL("http://localhost:8787/gatekeeper/odie-kg/oauth");
  callbackUrl.searchParams.set("code", "authorization-code");
  callbackUrl.searchParams.set("state", authorizationUrl.searchParams.get("state")!);
  const callbackResponse = await harness.fetchWorker("gatekeeper-odie-kg", callbackUrl.toString());
  expect(callbackResponse.status).toBe(200);
  const account = await waitFor("the ODIE MCP account to be connected", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(candidate => candidate.vendorId === VENDOR_ID) ?? null;
  });
  return { account, authorizationUrl };
}

describe("ODIE MCP integration", () => {
  it("connects through OAuth and declares the tenant-bound ambient singleton", async () => {
    remoteScenario = {};
    await withSession(async publicApi => {
      using api = await signUp(publicApi, nextUsernames("odiealice")[0]);

      await expect(api.getRequiredConnectionStatuses()).resolves.toEqual([expect.objectContaining({
        vendorId: VENDOR_ID,
        state: "missing",
      })]);

      const vendors = await api.listGatekeeperVendors();
      expect(vendors).toEqual([expect.objectContaining({
        id: VENDOR_ID,
        description: expect.objectContaining({
          displayName: ODIE_KG_DISPLAY_NAME,
          providesAuth: true,
        }),
        supportedResources: [expect.objectContaining({
          title: ODIE_KG_DISPLAY_NAME,
          urlPattern: MCP_ENDPOINT,
        })],
      })]);

      const { account, authorizationUrl } = await connectOdieKgAccount(api);
      expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${AUTH_ISSUER}/authorize`);
      expect(authorizationUrl.searchParams.get("scope")).toBe(ODIE_KG_OAUTH_SCOPE);
      expect(authorizationUrl.searchParams.get("client_id")).toBe("odie-test-client");
      expect(account.credentialsValid).toBe(true);
      expect(account.description.displayName).toBe(ODIE_KG_DISPLAY_NAME);
      expect(account.description.singleton?.tsType).toMatch(/^McpTotangoKg[0-9a-f]+Session$/);
      await expect(api.getRequiredConnectionStatuses()).resolves.toEqual([expect.objectContaining({
        vendorId: VENDOR_ID,
        accountId: account.id,
        state: "healthy",
      })]);

      using overseer = await api.newGadget();
      using gatekeeper = await overseer.getGatekeeperById(0);
      await expect(gatekeeper.getCreationSpec()).resolves.toMatchObject({
        type: "ambient",
        vendorId: VENDOR_ID,
        accountId: account.id,
      });
      await expect(gatekeeper.describe()).resolves.toMatchObject({
        title: ODIE_KG_DISPLAY_NAME,
        suggestedBindingName: "TOTANGO_KG",
      });

      using session = await gatekeeper.openSession() as unknown as McpSessionStub;
      const tools = await session.listTools();
      expect(tools.map(tool => tool.name)).toEqual([...ODIE_KG_ALLOWED_TOOLS]);
      expect(tools.filter(tool => tool.mode === "action").map(tool => tool.name))
        .toEqual([...ODIE_KG_ACTION_TOOLS]);
      expect(tools.every(tool => tool.classifiedBy === "default")).toBe(true);
      await expect(session.callTool("odie-kg-status", {domain: "acme"})).resolves.toMatchObject({
        status: "ok",
        text: "KG odie-kg-status returned data",
        isError: false,
      });
      expect(seenNetwork).toContain("POST https://auth.test/register");
      expect(seenNetwork).toContain("POST https://auth.test/token");
      expect(seenNetwork).toContain(`POST ${MCP_ENDPOINT}`);
    });
  });

  it("exposes generated odieKgQuery and preserves remote MCP tool-error results", async () => {
    remoteScenario = { toolError: { name: "odie-kg-query", message: "KG query failed: bad domain" } };
    await withSession(async publicApi => {
      using api = await signUp(publicApi, nextUsernames("odiequery")[0]);
      await connectOdieKgAccount(api);
      using overseer = await api.newGadget();
      using gatekeeper = await overseer.getGatekeeperById(0);
      using session = await gatekeeper.openSession() as unknown as McpSessionStub & {
        odieKgQuery(args?: Record<string, unknown>): Promise<unknown>;
      };

      await expect(session.odieKgQuery({ question: "show churn risks" })).resolves.toMatchObject({
        status: "ok",
        text: "KG query failed: bad domain",
        isError: true,
      });
      await expect(session.callTool("odie-kg-query", { question: "show churn risks" }))
        .resolves.toMatchObject({ status: "ok", text: "KG query failed: bad domain", isError: true });
    });
  });

  it("uses the cached catalog during remote access failures without locking the application", async () => {
    remoteScenario = {};
    await withSession(async publicApi => {
      using api = await signUp(publicApi, nextUsernames("odiefail")[0]);
      await connectOdieKgAccount(api);
      using overseer = await api.newGadget();
      using gatekeeper = await overseer.getGatekeeperById(0);
      await expect(gatekeeper.describe()).resolves.toMatchObject({
        snippet: expect.stringMatching(/54 organization-bound/i),
      });

      remoteScenario = { listStatus: 403 };
      await expect(api.getRequiredConnectionStatuses()).resolves.toEqual([expect.objectContaining({
        vendorId: VENDOR_ID,
        state: "healthy",
        accountId: expect.any(Number),
      })]);
      await expect(gatekeeper.describe()).resolves.toMatchObject({
        suggestedBindingName: "TOTANGO_KG",
        snippet: expect.stringMatching(/54 organization-bound/i),
      });
    });
  });

  it("keeps the application available when the remote catalog is incomplete", async () => {
    remoteScenario = { omitTool: "odie-kg-query" };
    await withSession(async publicApi => {
      using api = await signUp(publicApi, nextUsernames("odiemissing")[0]);
      const { account } = await connectOdieKgAccount(api);
      await expect(api.getRequiredConnectionStatuses()).resolves.toEqual([expect.objectContaining({
        vendorId: VENDOR_ID,
        accountId: account.id,
        state: "healthy",
      })]);
      using overseer = await api.newGadget();
      using gatekeeper = await overseer.getGatekeeperById(0);
      await expect(gatekeeper.describe()).resolves.toMatchObject({
        suggestedBindingName: "TOTANGO_KG",
        snippet: expect.stringMatching(/reconnect the account/i),
      });
    });
  });

  it("does not lock the application when ODIE MCP rate-limits catalog discovery", async () => {
    await withSession(async publicApi => {
      using api = await signUp(publicApi, nextUsernames("odieratelimit")[0]);
      const { account } = await connectOdieKgAccount(api);
      remoteScenario = { listStatus: 429 };

      await expect(api.getRequiredConnectionStatuses()).resolves.toEqual([expect.objectContaining({
        vendorId: VENDOR_ID,
        accountId: account.id,
        state: "healthy",
      })]);
      using overseer = await api.newGadget();
      using gatekeeper = await overseer.getGatekeeperById(0);
      await expect(gatekeeper.describe()).resolves.toMatchObject({ suggestedBindingName: "TOTANGO_KG" });
    });
  });
});
