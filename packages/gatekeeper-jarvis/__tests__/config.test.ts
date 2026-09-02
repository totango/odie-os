import { describe, expect, it } from "vitest";
import type { ClassifiedTool } from "@gadgets/mcp-shared/tools";
import {
  applyJarvisToolPolicy,
  hasJarvisConfiguration,
  isJarvisAllowedTool,
  jarvisResource,
  jarvisTokenFor,
  jarvisTrust,
  readJarvisConfig,
  JARVIS_ALLOWED_TOOLS,
} from "../src/config.js";
import { JARVIS_SETTINGS_TOOLS } from "../src/policy-types.js";
import deployInputs from "../deploy-inputs.json";
import {
  defaultJarvisToolPolicy,
  normalizeJarvisToolPolicy,
  upgradeDefaultJarvisToolPolicy,
} from "../src/policy.js";

function env(overrides: Record<string, string> = {}): Env {
  return overrides as unknown as Env;
}

describe("readJarvisConfig", () => {
  it("returns null when unconfigured or not parseable", () => {
    expect(readJarvisConfig(env())).toBeNull();
    expect(readJarvisConfig(env({ JARVIS_MCP_URL: "   " }))).toBeNull();
    expect(readJarvisConfig(env({ JARVIS_MCP_URL: "not a url" }))).toBeNull();
  });

  it("requires HTTPS and rejects ambient URL credentials", () => {
    expect(readJarvisConfig(env({ JARVIS_MCP_URL: "http://jarvis.example.com/mcp" }))).toBeNull();
    expect(readJarvisConfig(env({
      JARVIS_MCP_URL: "https://admin:secret@jarvis.example.com/mcp",
    }))).toBeNull();
  });

  it("normalizes away fragments while preserving endpoint identity", () => {
    expect(readJarvisConfig(env({
      JARVIS_MCP_URL: "https://jarvis.example.com/mcp#tool=query_knowledge",
    }))?.endpoint).toBe("https://jarvis.example.com/mcp");
  });
});

describe("JARVIS allowlist", () => {
  it("contains only the approved production tools", () => {
    expect(JARVIS_ALLOWED_TOOLS).toEqual([
      "query_knowledge",
      "repo_knowledge",
      "resolve_repo_group",
      "lookup_incident",
      "repo_graph_search",
      "repo_graph_get_node",
      "repo_graph_neighbors",
      "repo_graph_traverse",
      "repo_graph_status",
      "jarvis_answer_support_question",
      "jarvis_investigate_customer_issue",
      "jarvis_check_integration_health",
      "jarvis_get_investigation_status",
      "jarvis_get_support_answer_status",
      "jarvis_list_prod_tools",
      "jarvis_describe_prod_tool",
      "jarvis_call_prod_tool",
      "jarvis_describe_wren_tool",
      "jarvis_call_wren_tool",
    ]);
    expect(isJarvisAllowedTool("create_skill")).toBe(false);
    expect(isJarvisAllowedTool("escalate_to_human")).toBe(false);
  });

  it("hides only the internal repository tool from management settings", () => {
    expect(JARVIS_SETTINGS_TOOLS).not.toContain("repo_knowledge");
    expect(JARVIS_SETTINGS_TOOLS).toContain("jarvis_call_prod_tool");
    expect(JARVIS_SETTINGS_TOOLS).toEqual(
      JARVIS_ALLOWED_TOOLS.filter(tool => tool !== "repo_knowledge")
    );
  });
});

describe("JARVIS tool policy", () => {
  it("defaults chat to all administrator-visible read-only tools", () => {
    const policy = defaultJarvisToolPolicy();
    expect(policy).toEqual({
      revision: 6,
      chat: {
        tools: JARVIS_ALLOWED_TOOLS.filter(tool => tool !== "repo_knowledge"),
      },
      code: { tools: [...JARVIS_ALLOWED_TOOLS] },
      syncCode: false,
    });
    expect(policy.chat.tools).toContain("jarvis_call_prod_tool");
    expect(policy.chat.tools).toContain("jarvis_call_wren_tool");
  });

  it("upgrades only the original untouched default", () => {
    const historicalTools = [
      "query_knowledge", "repo_knowledge", "resolve_repo_group", "lookup_incident",
      "jarvis_answer_support_question", "jarvis_investigate_customer_issue",
      "jarvis_check_integration_health", "jarvis_get_investigation_status",
      "jarvis_get_support_answer_status", "jarvis_list_prod_tools",
      "jarvis_describe_prod_tool", "jarvis_call_prod_tool",
    ];
    const historical = {
      revision: 1,
      chat: { tools: historicalTools },
      code: { tools: [...historicalTools] },
      syncCode: true,
    };
    expect(upgradeDefaultJarvisToolPolicy(historical).chat.tools).not.toContain("repo_knowledge");
    expect(upgradeDefaultJarvisToolPolicy(historical).chat.tools).toContain("repo_graph_search");

    const priorDefault = {
      revision: 2,
      chat: { tools: historicalTools.filter(tool => tool !== "repo_knowledge") },
      code: { tools: [...historicalTools] },
      syncCode: false,
    };
    expect(upgradeDefaultJarvisToolPolicy(priorDefault).revision).toBe(6);

    const currentDefault = {
      revision: 3,
      chat: { tools: JARVIS_ALLOWED_TOOLS.filter(
        tool => tool !== "repo_knowledge" && tool !== "jarvis_describe_wren_tool" &&
          tool !== "jarvis_call_wren_tool") },
      code: { tools: JARVIS_ALLOWED_TOOLS.filter(
        tool => tool !== "jarvis_describe_wren_tool" && tool !== "jarvis_call_wren_tool") },
      syncCode: false,
    };
    const upgraded = upgradeDefaultJarvisToolPolicy(currentDefault);
    expect(upgraded.revision).toBe(6);
    expect(upgraded.chat.tools).toContain("jarvis_call_prod_tool");
    expect(upgraded.chat.tools).toContain("jarvis_call_wren_tool");
    expect(upgraded.code.tools).toContain("jarvis_call_prod_tool");

    const priorV4Default = {
      revision: 4,
      chat: { tools: JARVIS_ALLOWED_TOOLS.filter(
        tool => tool !== "repo_knowledge" && tool !== "jarvis_call_prod_tool" &&
          tool !== "jarvis_describe_wren_tool" && tool !== "jarvis_call_wren_tool") },
      code: { tools: JARVIS_ALLOWED_TOOLS.filter(
        tool => tool !== "jarvis_describe_wren_tool" && tool !== "jarvis_call_wren_tool") },
      syncCode: false,
    };
    expect(upgradeDefaultJarvisToolPolicy(priorV4Default).revision).toBe(6);
    const customizedV4Code = {
      ...priorV4Default,
      code: { tools: ["query_knowledge"] },
    };
    expect(upgradeDefaultJarvisToolPolicy(customizedV4Code).chat.tools)
      .toContain("jarvis_call_prod_tool");
    expect(upgradeDefaultJarvisToolPolicy(customizedV4Code).code.tools)
      .toEqual(["query_knowledge"]);

    const futureCustomizedPolicy = {
      revision: 12,
      chat: { tools: JARVIS_ALLOWED_TOOLS.filter(
        tool => tool !== "repo_knowledge" && tool !== "jarvis_call_prod_tool") },
      code: { tools: [...JARVIS_ALLOWED_TOOLS] },
      syncCode: false,
    };
    expect(upgradeDefaultJarvisToolPolicy(futureCustomizedPolicy))
      .toBe(futureCustomizedPolicy);

    const customized = {
      ...historical,
      revision: 2,
      chat: { tools: historicalTools.filter(tool => tool !== "jarvis_call_prod_tool") },
    };
    expect(upgradeDefaultJarvisToolPolicy(customized)).toBe(customized);
    const unsafeCustomized = { ...historical, revision: 2 };
    expect(upgradeDefaultJarvisToolPolicy(unsafeCustomized)).toBe(unsafeCustomized);
    const customizedV3 = {
      ...currentDefault,
      chat: { tools: currentDefault.chat.tools.filter(tool => tool !== "lookup_incident") },
    };
    const sanitizedV3 = upgradeDefaultJarvisToolPolicy(customizedV3);
    expect(sanitizedV3).toBe(customizedV3);
    expect(sanitizedV3.chat.tools).not.toContain("lookup_incident");
    expect(sanitizedV3.chat.tools).toContain("jarvis_call_prod_tool");
    expect(sanitizedV3.code.tools).toContain("jarvis_call_prod_tool");

    const unrestricted = {
      revision: 9,
      chat: {},
      code: {},
      syncCode: false,
    };
    const bounded = upgradeDefaultJarvisToolPolicy(unrestricted);
    expect(bounded.chat.tools).toEqual(
      JARVIS_ALLOWED_TOOLS.filter(tool => tool !== "repo_knowledge")
    );
    expect(bounded.code.tools).toEqual(JARVIS_ALLOWED_TOOLS);
  });

  it("normalizes order and mirrors chat when synchronized", () => {
    expect(normalizeJarvisToolPolicy({
      chatTools: ["repo_knowledge", "query_knowledge", "repo_knowledge"],
      syncCode: true,
      codeTools: ["lookup_incident"],
    }, 7)).toEqual({
      revision: 7,
      chat: { tools: ["query_knowledge", "repo_knowledge"] },
      code: { tools: ["query_knowledge", "repo_knowledge"] },
      syncCode: true,
    });
  });

  it("retains selected production and Wren callers in chat", () => {
    expect(normalizeJarvisToolPolicy({
      chatTools: ["query_knowledge", "jarvis_call_prod_tool", "jarvis_call_wren_tool"],
      syncCode: false,
      codeTools: ["query_knowledge", "jarvis_call_prod_tool", "jarvis_call_wren_tool"],
    }, 8)).toEqual({
      revision: 8,
      chat: { tools: ["query_knowledge", "jarvis_call_prod_tool", "jarvis_call_wren_tool"] },
      code: { tools: ["query_knowledge", "jarvis_call_prod_tool", "jarvis_call_wren_tool"] },
      syncCode: false,
    });
  });

  it("keeps separate code scope and rejects names outside the fixed allowlist", () => {
    expect(normalizeJarvisToolPolicy({
      chatTools: ["query_knowledge"], syncCode: false, codeTools: ["lookup_incident"],
    }, 2).code.tools).toEqual(["lookup_incident"]);
    expect(() => normalizeJarvisToolPolicy({
      chatTools: ["create_skill"], syncCode: true,
    }, 2)).toThrow(/not allowed/);
  });
});

describe("applyJarvisToolPolicy", () => {
  function entry(name: string, annotations?: { readOnlyHint?: boolean }): ClassifiedTool {
    return {
      tool: { name, inputSchema: { type: "object" as const }, ...(annotations ? { annotations } : {}) },
      mode: "read",
      autoApprovable: true,
      classifiedBy: "server-annotation",
    };
  }

  it("drops anything outside the allowlist", () => {
    expect(applyJarvisToolPolicy(entry("create_skill"))).toBeNull();
  });

  it("keeps list/describe tools read-only and requires approval for dispatcher actions", () => {
    for (const name of JARVIS_ALLOWED_TOOLS) {
      for (const annotations of [undefined, { readOnlyHint: true }, { readOnlyHint: false }]) {
        const policy = applyJarvisToolPolicy(entry(name, annotations));
        expect(policy?.mode).toBe(
          name === "jarvis_call_prod_tool" || name === "jarvis_call_wren_tool" ? "action" : "read");
        expect(policy?.autoApprovable).toBe(false);
        expect(policy?.classifiedBy).toBe("default");
      }
    }
  });
});

describe("jarvisTokenFor", () => {
  it("returns the bearer only for the currently configured endpoint", () => {
    const configured = env({
      JARVIS_MCP_URL: "https://jarvis.example.com/mcp",
      JARVIS_MCP_TOKEN: "secret-token",
    });
    expect(jarvisTokenFor(configured, "https://jarvis.example.com/mcp")).toBe("secret-token");
    expect(jarvisTokenFor(configured, "https://other.example.com/mcp")).toBeNull();
  });

  it("withholds missing or orphaned tokens", () => {
    expect(jarvisTokenFor(env({ JARVIS_MCP_URL: "https://jarvis.example.com/mcp" }),
      "https://jarvis.example.com/mcp")).toBeNull();
    expect(jarvisTokenFor(env({ JARVIS_MCP_TOKEN: "orphan" }),
      "https://jarvis.example.com/mcp")).toBeNull();
  });
});

describe("hasJarvisConfiguration", () => {
  it("requires both a valid endpoint and token", () => {
    expect(hasJarvisConfiguration(env())).toBe(false);
    expect(hasJarvisConfiguration(env({ JARVIS_MCP_URL: "https://jarvis.example.com/mcp" })))
      .toBe(false);
    expect(hasJarvisConfiguration(env({
      JARVIS_MCP_URL: "https://jarvis.example.com/mcp",
      JARVIS_MCP_TOKEN: "secret-token",
    }))).toBe(true);
  });
});

describe("jarvisTrust", () => {
  it("defaults to BYO and requires an explicit true to trust annotations", () => {
    expect(jarvisTrust(env())).toBe("byo");
    expect(jarvisTrust(env({ JARVIS_TRUST_ANNOTATIONS: "TRUE" }))).toBe("vetted");
    for (const value of ["1", "yes", "vetted", ""]) {
      expect(jarvisTrust(env({ JARVIS_TRUST_ANNOTATIONS: value }))).toBe("byo");
    }
  });
});

describe("jarvisResource", () => {
  it("describes only the configured endpoint", () => {
    const config = readJarvisConfig(env({ JARVIS_MCP_URL: "https://jarvis.example.com/mcp" }))!;
    expect(jarvisResource(config).urlPattern).toBe("https://jarvis.example.com/mcp");
    expect(jarvisResource(config).title).toBe("JARVIS");
  });
});

describe("deploy inputs", () => {
  it("overrides default OAuth CLIENT_ID/CLIENT_SECRET inputs with required JARVIS secrets", () => {
    expect(deployInputs.map(input => input.name)).toEqual(["JARVIS_MCP_URL", "JARVIS_MCP_TOKEN"]);
    expect(deployInputs.every(input => input.kind === "secret")).toBe(true);
  });
});
