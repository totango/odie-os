import { describe, expect, it } from "vitest";
import { McpSessionBase } from "@gadgets/mcp-shared/session";
import { classifyTool } from "@gadgets/mcp-shared/tools";
import {
  GatekeeperVendor,
  JarvisAccount,
  JarvisConnectionAccount,
  JarvisGatekeeper,
  JarvisSession,
  jarvisSingletonResourceUrl,
} from "../src/index.js";
import { applyJarvisToolPolicy, JARVIS_ALLOWED_TOOLS } from "../src/config.js";
import { JarvisPolicyApi } from "../src/policy.js";

class FakeKv {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  put<T>(key: string, value: T): void { this.values.set(key, value); }
  delete(key: string): boolean { return this.values.delete(key); }
}

function fakeStorage(): DurableObjectStorage {
  return { kv: new FakeKv() } as unknown as DurableObjectStorage;
}

function env(overrides: Record<string, string> = {}): Env {
  return overrides as unknown as Env;
}

describe("JarvisConnectionAccount", () => {
  it("returns a bearer token and safely persists session ids by generation", async () => {
    const storage = fakeStorage();
    const account = new JarvisConnectionAccount(env({
      JARVIS_MCP_URL: "https://jarvis.example.com/mcp",
      JARVIS_MCP_TOKEN: "secret-token",
    }), storage, "https://jarvis.example.com/mcp");

    const first = await account.getConnection("https://jarvis.example.com/mcp");
    expect(first).toMatchObject({ authorization: "secret-token", sessionId: null, generation: 1 });

    await account.setMcpSessionId("https://jarvis.example.com/mcp", first.generation, null, "mcp-session");
    expect(await account.getConnection("https://jarvis.example.com/mcp"))
      .toMatchObject({ sessionId: "mcp-session", generation: 1 });

    await account.setMcpSessionId("https://jarvis.example.com/mcp", first.generation + 1, "mcp-session", "stale");
    expect(await account.getConnection("https://jarvis.example.com/mcp"))
      .toMatchObject({ sessionId: "mcp-session" });
  });

  it("does not send a token to an endpoint after configuration is repointed", async () => {
    const account = new JarvisConnectionAccount(env({
      JARVIS_MCP_URL: "https://new.example.com/mcp",
      JARVIS_MCP_TOKEN: "new-token",
    }), fakeStorage(), "https://old.example.com/mcp");
    await expect(account.getConnection("https://old.example.com/mcp"))
      .rejects.toThrow(/bearer token/);
  });
});

describe("JarvisAccount", () => {
  it("describes the management UI with the dotted title and monochrome robot icon", async () => {
    const account = Object.create(JarvisAccount.prototype) as JarvisAccount;
    Object.defineProperty(account, "env", {
      value: env({
        JARVIS_MCP_URL: "https://jarvis.example.com/mcp",
        JARVIS_MCP_TOKEN: "secret-token",
      }),
    });
    Object.defineProperty(account, "ctx", {
      value: { exports: { JarvisPolicy: { getByName: () => ({ get: async () => ({
        revision: 1,
        chat: { tools: ["query_knowledge"] },
        code: { tools: [] },
        syncCode: true,
      }) }) } } },
    });

    const description = await account.describe();
    expect(description.providesUi?.title).toBe("J.A.R.V.I.S");
    expect(description.providesUi?.icon?.url).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(description.providesUi?.icon?.url.split(",")[1] ?? ""))
      .toContain("<svg");
  });
});

describe("JarvisSession", () => {
  it("enforces the deployment-owned read-only policy despite unsafe annotations", () => {
    for (const name of JARVIS_ALLOWED_TOOLS) {
      const classified = applyJarvisToolPolicy(classifyTool({
        name,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      }, "vetted"));
      expect(classified).toMatchObject({ mode: "read", autoApprovable: false });
    }
  });

  it("is the validated MCP session subclass used for generated tool methods", () => {
    expect(JarvisSession.prototype).toBeInstanceOf(McpSessionBase);
    expect(typeof JarvisSession.prototype.callTool).toBe("function");
  });

  it("runs read-only knowledge tools as observations under trusted JARVIS annotations", async () => {
    const queryTool = classifyTool({
      name: "query_knowledge",
      description: "Search JARVIS knowledge.",
      annotations: { readOnlyHint: true },
    }, "vetted");
    expect(queryTool.mode).toBe("read");

    let authorized = false;
    let called = false;
    let submitted = false;
    const session = new JarvisSession({
      serverName: "JARVIS",
      endpoint: "https://jarvis.example.com/mcp",
      scope: { tools: ["query_knowledge"] },
      tools: async () => [queryTool],
      call: async fn => {
        called = true;
        return fn({
          callTool: async (name: string) => ({
            content: [{ type: "text", text: `called ${name}` }],
          }),
        } as never);
      },
      actionKindFor: toolName => ({ tag: `jarvis:${toolName}`, label: toolName }),
      stageAction: () => { throw new Error("read tool should not stage an action"); },
      discardStagedAction: () => {},
      lookupAction: () => undefined,
    }, {
      authorizeObservation: async () => { authorized = true; },
      submitAction: async () => { submitted = true; },
      dup() { return this; },
      [Symbol.dispose]() {},
    } as never);

    await expect(session.callTool("query_knowledge", { query: "billing" }))
      .resolves.toMatchObject({ status: "ok", text: "called query_knowledge" });
    expect(called).toBe(true);
    expect(authorized).toBe(true);
    expect(submitted).toBe(false);
  });

  it("runs allowlisted support and investigation tools as observations", async () => {
    const supportTool = applyJarvisToolPolicy(classifyTool({
      name: "jarvis_answer_support_question",
      description: "Draft a support answer.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, "vetted"))!;
    const investigationTool = applyJarvisToolPolicy(classifyTool({
      name: "jarvis_investigate_customer_issue",
      description: "Start an investigation.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, "vetted"))!;

    const called: string[] = [];
    let authorized = 0;
    const session = new JarvisSession({
      serverName: "JARVIS",
      endpoint: "https://jarvis.example.com/mcp",
      scope: { tools: ["jarvis_answer_support_question", "jarvis_investigate_customer_issue"] },
      tools: async () => [supportTool, investigationTool],
      call: async fn => fn({
        callTool: async (name: string) => {
          called.push(name);
          return { content: [{ type: "text", text: `called ${name}` }] };
        },
      } as never),
      actionKindFor: toolName => ({ tag: `jarvis:${toolName}`, label: toolName }),
      stageAction: () => { throw new Error("read tool should not stage an action"); },
      discardStagedAction: () => {},
      lookupAction: () => undefined,
    }, {
      authorizeObservation: async () => { authorized++; },
      submitAction: async () => { throw new Error("read tool should not submit an action"); },
      dup() { return this; },
      [Symbol.dispose]() {},
    } as never);

    await expect(session.callTool("jarvis_answer_support_question", { question: "help" }))
      .resolves.toMatchObject({ status: "ok" });
    await expect(session.callTool("jarvis_investigate_customer_issue", { customer: "acme" }))
      .resolves.toMatchObject({ status: "ok" });
    expect(called).toEqual(["jarvis_answer_support_question", "jarvis_investigate_customer_issue"]);
    expect(authorized).toBe(2);
  });
});

describe("Jarvis policy administration", () => {
  const input = { chatTools: ["query_knowledge"], syncCode: true };

  it("rejects non-admin reads and updates", async () => {
    let updated = false;
    const policy = {
      get: () => ({ revision: 1, chat: { tools: [] }, code: { tools: [] }, syncCode: true }),
      update: () => { updated = true; return policy.get(); },
    };
    const api = new JarvisPolicyApi(policy, false);
    await expect(api.get()).rejects.toThrow(/administrator/);
    await expect(api.update(input)).rejects.toThrow(/administrator/);
    expect(updated).toBe(false);
  });

  it("allows admin updates", async () => {
    const api = new JarvisPolicyApi({
      get: () => ({ revision: 1, chat: { tools: [] }, code: { tools: [] }, syncCode: true }),
      update: () => ({ revision: 2, chat: { tools: ["query_knowledge"] },
        code: { tools: ["query_knowledge"] }, syncCode: true }),
    }, true);
    await expect(api.update(input)).resolves.toMatchObject({ revision: 2 });
  });
});

describe("JarvisGatekeeper runtime scope", () => {
  it("selects chat vs code scope and refuses tools outside the selected frozen scope", async () => {
    const queryTool = applyJarvisToolPolicy(classifyTool({ name: "query_knowledge" }, "vetted"))!;
    const repoTool = applyJarvisToolPolicy(classifyTool({ name: "repo_knowledge" }, "vetted"))!;
    const gatekeeper = Object.create(JarvisGatekeeper.prototype) as JarvisGatekeeper;
    Object.defineProperty(gatekeeper, "ctx", { value: { props: {
      endpoint: "https://jarvis.example.com/mcp",
      scope: { tools: ["query_knowledge", "repo_knowledge"] },
      chatScope: { tools: ["query_knowledge"] },
      codeScope: { tools: ["repo_knowledge"] },
    } } });
    (gatekeeper as unknown as { tools(): Promise<unknown[]> }).tools = async () => [queryTool, repoTool];
    (gatekeeper as unknown as { call(): never }).call = () => { throw new Error("not reached"); };
    const queue = {
      getSessionSurface: async () => "code" as const,
      authorizeObservation: async () => {}, submitAction: async () => {},
      dup() { return this; }, [Symbol.dispose]() {},
    } as never;
    const session = await gatekeeper.startSession(queue);
    await expect(session.callTool("query_knowledge")).rejects.toThrow(/does not grant|grants only/);
    expect((await session.listTools()).map(tool => tool.name)).toEqual(["repo_knowledge"]);
  });
});

describe("JarvisGatekeeper catalog", () => {
  it("bounds catalog entries and authorizes the observation before returning", async () => {
    const gatekeeper = Object.create(JarvisGatekeeper.prototype) as JarvisGatekeeper & {
      tools(): Promise<Array<{ tool: { name: string; title?: string; description?: string }; mode: string }>>;
    };
    Object.defineProperty(gatekeeper, "ctx", { value: { props: {
      chatScope: { tools: ["query_knowledge"] },
    } } });
    (gatekeeper as unknown as { tools(): Promise<unknown[]> }).tools = async () => [
      { tool: { name: "query_knowledge", title: "Query", description: "Search knowledge\nmore" }, mode: "read" },
      { tool: { name: "create_skill", title: "Create skill", description: "Forbidden" }, mode: "write" },
    ];
    let authorized = false;
    const authorizer = {
      authorizeObservation: async () => { authorized = true; },
    } as unknown as Parameters<JarvisGatekeeper["getAgentCatalog"]>[0];

    const catalog = await gatekeeper.getAgentCatalog(authorizer);
    expect(authorized).toBe(true);
    expect(catalog.entries).toEqual([{ id: "query_knowledge", title: "Query", description: "Search knowledge" }]);
  });

  it("authorizes even an empty catalog observation", async () => {
    const gatekeeper = Object.create(JarvisGatekeeper.prototype) as JarvisGatekeeper;
    Object.defineProperty(gatekeeper, "ctx", { value: { props: {
      chatScope: { tools: [...JARVIS_ALLOWED_TOOLS] },
    } } });
    (gatekeeper as unknown as { tools(): Promise<unknown[]> }).tools = async () => [
      { tool: { name: "create_skill", title: "Create skill", description: "Forbidden" }, mode: "action" },
    ];
    let authorized = false;
    const authorizer = {
      authorizeObservation: async () => { authorized = true; },
    } as unknown as Parameters<JarvisGatekeeper["getAgentCatalog"]>[0];

    const catalog = await gatekeeper.getAgentCatalog(authorizer);
    expect(catalog.entries).toEqual([]);
    expect(authorized).toBe(true);
  });
});

describe("GatekeeperVendor", () => {
  it("suppresses auto-provisioning product behavior until endpoint and token are configured", async () => {
    const vendor = Object.create(GatekeeperVendor.prototype) as GatekeeperVendor;
    Object.defineProperty(vendor, "env", {
      value: env({ JARVIS_MCP_URL: "https://jarvis.example.com/mcp" }),
    });
    expect(() => vendor.connectAccount({} as never)).toThrow(/auto-provisioned/);
    await expect(vendor.createAccount()).rejects.toThrow(/JARVIS is not configured/);
    expect(await vendor.describe()).toMatchObject({
      displayName: "JARVIS",
      autoProvisionsAccount: false,
      providesAuth: false,
    });
  });

  it("declares auto-provisioning only when fully configured", async () => {
    const vendor = Object.create(GatekeeperVendor.prototype) as GatekeeperVendor;
    Object.defineProperty(vendor, "env", {
      value: env({
        JARVIS_MCP_URL: "https://jarvis.example.com/mcp",
        JARVIS_MCP_TOKEN: "secret-token",
      }),
    });
    expect(await vendor.describe()).toMatchObject({
      displayName: "JARVIS",
      autoProvisionsAccount: true,
      providesAuth: false,
    });
  });
});

describe("jarvisSingletonResourceUrl", () => {
  it("pins the generated type discriminator to the fixed allowlist", () => {
    const url = jarvisSingletonResourceUrl("https://jarvis.example.com/mcp");
    expect(url).toContain("#tool=query_knowledge");
    expect(url).toContain("tool=jarvis_check_integration_health");
    expect(url).not.toContain("escalate");
  });
});
