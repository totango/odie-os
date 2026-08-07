import { describe, expect, it } from "vitest";
import { McpSessionBase } from "@gadgets/mcp-shared/session";
import { classifyTool } from "@gadgets/mcp-shared/tools";
import {
  GatekeeperVendor,
  JarvisConnectionAccount,
  JarvisGatekeeper,
  JarvisSession,
  jarvisSingletonResourceUrl,
} from "../src/index.js";
import { applyJarvisToolPolicy } from "../src/config.js";

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

    await account.setMcpSessionId("https://jarvis.example.com/mcp", first.generation, "mcp-session");
    expect(await account.getConnection("https://jarvis.example.com/mcp"))
      .toMatchObject({ sessionId: "mcp-session", generation: 1 });

    await account.setMcpSessionId("https://jarvis.example.com/mcp", first.generation + 1, "stale");
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

describe("JarvisSession", () => {
  it("enforces manual approval for support and investigation despite unsafe annotations", () => {
    for (const name of ["jarvis_answer_support_question", "jarvis_investigate_customer_issue"]) {
      const classified = applyJarvisToolPolicy(classifyTool({
        name,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      }, "vetted"));
      expect(classified).toMatchObject({ mode: "action", autoApprovable: false });
    }
    expect(applyJarvisToolPolicy(classifyTool({
      name: "query_knowledge",
      annotations: { readOnlyHint: false },
    }, "vetted"))).toMatchObject({ mode: "read", autoApprovable: false });
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

  it("stages support and investigation tools for manual approval under trusted JARVIS annotations", async () => {
    const supportTool = classifyTool({
      name: "jarvis_answer_support_question",
      description: "Draft a support answer.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, "vetted");
    const investigationTool = classifyTool({
      name: "jarvis_investigate_customer_issue",
      description: "Start an investigation.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, "vetted");
    expect(supportTool).toMatchObject({ mode: "action", autoApprovable: false });
    expect(investigationTool).toMatchObject({ mode: "action", autoApprovable: false });

    const submitted: Array<{ id: number; autoApprovable?: boolean; awaitDecision?: boolean }> = [];
    const session = new JarvisSession({
      serverName: "JARVIS",
      endpoint: "https://jarvis.example.com/mcp",
      scope: { tools: ["jarvis_answer_support_question", "jarvis_investigate_customer_issue"] },
      tools: async () => [supportTool, investigationTool],
      call: async () => { throw new Error("action tool should not call before approval"); },
      actionKindFor: toolName => ({ tag: `jarvis:${toolName}`, label: toolName }),
      stageAction: (toolName, args) => ({
        id: submitted.length + 1,
        toolName,
        args,
        state: "pending",
        submittedAt: Date.now(),
      }),
      discardStagedAction: () => {},
      lookupAction: () => undefined,
    }, {
      authorizeObservation: async () => {},
      submitAction: async (id: number, description: { autoApprovable?: boolean; awaitDecision?: boolean }) => {
        submitted.push({ id, autoApprovable: description.autoApprovable, awaitDecision: description.awaitDecision });
      },
      dup() { return this; },
      [Symbol.dispose]() {},
    } as never);

    await expect(session.callTool("jarvis_answer_support_question", { question: "help" }))
      .resolves.toMatchObject({ status: "pending", actionId: 1 });
    await expect(session.callTool("jarvis_investigate_customer_issue", { customer: "acme" }))
      .resolves.toMatchObject({ status: "pending", actionId: 2 });
    expect(submitted).toEqual([
      { id: 1, autoApprovable: false, awaitDecision: true },
      { id: 2, autoApprovable: false, awaitDecision: true },
    ]);
  });
});

describe("JarvisGatekeeper catalog", () => {
  it("bounds catalog entries and authorizes the observation before returning", async () => {
    const gatekeeper = Object.create(JarvisGatekeeper.prototype) as JarvisGatekeeper & {
      tools(): Promise<Array<{ tool: { name: string; title?: string; description?: string }; mode: string }>>;
    };
    (gatekeeper as unknown as { tools(): Promise<unknown[]> }).tools = async () => [
      { tool: { name: "query_knowledge", title: "Query", description: "Search knowledge\nmore" }, mode: "read" },
      { tool: { name: "create_skill", title: "Create skill", description: "Forbidden" }, mode: "write" },
    ];
    let authorized = false;
    const authorizer = {
      authorizeObservation: async () => { authorized = true; },
    } as unknown as Parameters<JarvisGatekeeper["getAgentCatalog"]>[1];

    const catalog = await gatekeeper.getAgentCatalog({ limit: 10 }, authorizer);
    expect(authorized).toBe(true);
    expect(catalog.entries).toEqual([{ id: "query_knowledge", title: "Query", description: "Search knowledge" }]);
  });

  it("authorizes even an empty catalog observation", async () => {
    const gatekeeper = Object.create(JarvisGatekeeper.prototype) as JarvisGatekeeper;
    (gatekeeper as unknown as { tools(): Promise<unknown[]> }).tools = async () => [
      { tool: { name: "create_skill", title: "Create skill", description: "Forbidden" }, mode: "action" },
    ];
    let authorized = false;
    const authorizer = {
      authorizeObservation: async () => { authorized = true; },
    } as unknown as Parameters<JarvisGatekeeper["getAgentCatalog"]>[1];

    const catalog = await gatekeeper.getAgentCatalog({ limit: 10 }, authorizer);
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
