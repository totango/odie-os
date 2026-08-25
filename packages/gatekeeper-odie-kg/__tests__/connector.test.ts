import { describe, expect, it, vi } from "vitest";
import { McpAccountBase } from "@gadgets/mcp-shared/account";
import { McpSessionBase } from "@gadgets/mcp-shared/session";
import {
  GatekeeperVendor,
  OdieKgAccount,
  OdieKgConnectionAccount,
  OdieKgGatekeeper,
  OdieKgSession,
  OdieKgUser,
} from "../src/index.js";
import { ODIE_KG_DISPLAY_NAME } from "../src/config.js";

const ENDPOINT = "https://api-agents.unison.totango.com/api/mcp/odie";

function env(values: Record<string, string> = {}): Env {
  return values as unknown as Env;
}

describe("ODIE MCP connector", () => {
  it("advertises a visible auth connector only when the endpoint is configured", async () => {
    const vendor = Object.create(GatekeeperVendor.prototype) as GatekeeperVendor;
    Object.defineProperty(vendor, "env", { value: env({ ODIE_KG_MCP_URL: ENDPOINT }) });
    expect(await vendor.describe()).toMatchObject({
      displayName: "ODIE MCP",
      providesAuth: true,
    });
    expect(await vendor.getSupportedResources()).toHaveLength(1);
  });

  it("turns a connected user account into an ambient singleton", async () => {
    const account = {
      getServer: vi.fn(async () => ({ endpoint: ENDPOINT, serverName: ODIE_KG_DISPLAY_NAME })),
      hasCurrentScopeGrant: vi.fn(async () => true),
    };
    const user = new (OdieKgUser as unknown as { new(): OdieKgUser })();
    Object.defineProperty(user, "env", { value: env({ ODIE_KG_MCP_URL: ENDPOINT }) });
    Object.defineProperty(user, "ctx", {
      value: {
        props: { accountObjectId: "account-id" },
        exports: {
          OdieKgAccount: { idFromString: () => "id", get: () => account },
          OdieKgGatekeeper: ({ props }: { props: unknown }) => ({ props }),
        },
      },
    });
    const description = await user.describe();
    expect(description.singleton?.tsType).toContain("TotangoKg");
    expect(description.singleton?.revisionedAuthority).toBe(true);
    const authority = await user.getSingletonGatekeeperAuthority();
    expect(authority.key).toMatch(/^odie-mcp-read-v1:/);
    const singleton = await user.getSingletonGatekeeperClass() as unknown as { props: unknown };
    expect(singleton.props).toMatchObject({ endpoint: ENDPOINT, accountObjectId: "account-id" });
  });

  it("requires legacy-branded accounts to reconnect for the expanded read scopes", async () => {
    const account = {
      getServer: vi.fn(async () => ({ endpoint: ENDPOINT, serverName: "Totango Knowledge Graph" })),
      hasCurrentScopeGrant: vi.fn(async () => false),
    };
    const user = new (OdieKgUser as unknown as { new(): OdieKgUser })();
    Object.defineProperty(user, "env", { value: env({ ODIE_KG_MCP_URL: ENDPOINT }) });
    Object.defineProperty(user, "ctx", {
      value: {
        props: { accountObjectId: "legacy-account-id" },
        exports: {
          OdieKgAccount: { idFromString: () => "id", get: () => account },
        },
      },
    });

    await expect(user.describe()).resolves.toMatchObject({
      displayName: ODIE_KG_DISPLAY_NAME,
      singleton: undefined,
    });
    await expect(user.getSingletonGatekeeperClass()).rejects.toThrow(/reconnect ODIE MCP/i);
  });

  it("refuses observers and uses the validated MCP session subclass", async () => {
    const facet = Object.create(OdieKgGatekeeper.prototype) as OdieKgGatekeeper;
    await expect(facet.addObserver("observer", {} as never))
      .rejects.toThrow(/only be opened by its owner/i);
    expect(OdieKgSession.prototype).toBeInstanceOf(McpSessionBase);
  });

  it("refuses credentials after the configured endpoint changes", async () => {
    const underlying = {
      getConnection: vi.fn(),
      setMcpSessionId: vi.fn(),
      noteCredentialsExpired: vi.fn(),
    };
    const account = new OdieKgConnectionAccount(
      env({ ODIE_KG_MCP_URL: "https://new.example.com/api/mcp/odie" }),
      underlying as never,
      ENDPOINT,
    );
    await expect(account.getConnection(ENDPOINT)).rejects.toThrow(/endpoint changed/i);
    expect(underlying.getConnection).not.toHaveBeenCalled();
  });

  it("refuses cached tool metadata after the configured endpoint changes", async () => {
    const facet = Object.create(OdieKgGatekeeper.prototype) as OdieKgGatekeeper;
    Object.defineProperty(facet, "env", {
      value: env({ ODIE_KG_MCP_URL: "https://new.example.com/api/mcp/odie" }),
    });
    Object.defineProperty(facet, "ctx", { value: { props: { endpoint: ENDPOINT } } });
    await expect(facet.tools()).rejects.toThrow(/endpoint changed/i);
  });

  it("invalidates the scope grant only while an endpoint repoint is accepted", async () => {
    const values = new Map<string, unknown>([
      ["server", { endpoint: ENDPOINT, serverName: ODIE_KG_DISPLAY_NAME }],
      ["odieMcpScopeVersion", 1],
      ["nonce", { value: "nonce", expiresAt: Date.now() + 60_000, stage: "initiation" }],
    ]);
    const account = Object.create(OdieKgAccount.prototype) as OdieKgAccount;
    Object.defineProperty(account, "ctx", {
      value: {
        storage: {
          kv: {
            get: (key: string) => values.get(key),
            put: (key: string, value: unknown) => values.set(key, value),
            delete: (key: string) => values.delete(key),
          },
        },
      },
    });
    const base = vi.spyOn(McpAccountBase.prototype, "beginConnect")
      .mockResolvedValueOnce({ kind: "invalid" })
      .mockResolvedValueOnce({ kind: "redirect", url: "https://auth.example.com" })
      .mockResolvedValueOnce({ kind: "invalid" });

    await account.beginConnect("stale-nonce", {
      endpoint: "https://new.example.com/api/mcp/odie",
      serverName: ODIE_KG_DISPLAY_NAME,
    } as never);
    expect(values.has("odieMcpScopeVersion")).toBe(true);

    await account.beginConnect("nonce", {
      endpoint: "https://new.example.com/api/mcp/odie",
      serverName: ODIE_KG_DISPLAY_NAME,
    } as never);

    expect(values.has("odieMcpScopeVersion")).toBe(false);
    values.set("odieMcpScopeVersion", 1);
    await account.beginConnect("nonce", {
      endpoint: "https://new.example.com/api/mcp/odie",
      serverName: ODIE_KG_DISPLAY_NAME,
    } as never);
    expect(values.has("odieMcpScopeVersion")).toBe(true);
    expect(base).toHaveBeenCalledTimes(3);
    base.mockRestore();
  });
});
