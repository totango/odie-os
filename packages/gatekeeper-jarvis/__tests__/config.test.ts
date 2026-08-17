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
    ]);
    expect(isJarvisAllowedTool("create_skill")).toBe(false);
    expect(isJarvisAllowedTool("escalate_to_human")).toBe(false);
  });

  it("hides internal and arbitrary production tools from management settings", () => {
    expect(JARVIS_SETTINGS_TOOLS).not.toContain("repo_knowledge");
    expect(JARVIS_SETTINGS_TOOLS).not.toContain("jarvis_call_prod_tool");
    expect(JARVIS_SETTINGS_TOOLS).toEqual(
      JARVIS_ALLOWED_TOOLS.filter(
        tool => tool !== "repo_knowledge" && tool !== "jarvis_call_prod_tool"
      )
    );
  });
});

describe("JARVIS tool policy", () => {
  it("defaults chat away from repo knowledge and arbitrary production calls", () => {
    const policy = defaultJarvisToolPolicy();
    expect(policy).toEqual({
      revision: 4,
      chat: {
        tools: JARVIS_ALLOWED_TOOLS.filter(
          tool => tool !== "repo_knowledge" && tool !== "jarvis_call_prod_tool"
        ),
      },
      code: { tools: [...JARVIS_ALLOWED_TOOLS] },
      syncCode: false,
    });
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
    expect(upgradeDefaultJarvisToolPolicy(priorDefault).revision).toBe(4);

    const currentDefault = {
      revision: 3,
      chat: { tools: JARVIS_ALLOWED_TOOLS.filter(tool => tool !== "repo_knowledge") },
      code: { tools: [...JARVIS_ALLOWED_TOOLS] },
      syncCode: false,
    };
    const upgraded = upgradeDefaultJarvisToolPolicy(currentDefault);
    expect(upgraded.revision).toBe(4);
    expect(upgraded.chat.tools).not.toContain("jarvis_call_prod_tool");
    expect(upgraded.code.tools).toContain("jarvis_call_prod_tool");

    const customized = { ...historical, revision: 2 };
    expect(upgradeDefaultJarvisToolPolicy(customized)).toBe(customized);
    const customizedV3 = {
      ...currentDefault,
      chat: { tools: currentDefault.chat.tools.filter(tool => tool !== "lookup_incident") },
    };
    expect(upgradeDefaultJarvisToolPolicy(customizedV3)).toBe(customizedV3);
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

  it("queues a production tool call for approval however the far side labels it", () => {
    // The agent chooses the tool name and its arguments, and the reachable surface includes ad-hoc
    // SQL against production databases. A read-only claim from JARVIS must not be able to turn that
    // into an observation that runs with nobody asked.
    for (const annotations of [undefined, { readOnlyHint: true }]) {
      const policy = applyJarvisToolPolicy(entry("jarvis_call_prod_tool", annotations));
      expect(policy?.mode).toBe("action");
      expect(policy?.autoApprovable).toBe(false);
      expect(policy?.classifiedBy).toBe("default");
    }
  });

  it("leaves discovery as reads, since listing and describing disclose no production data", () => {
    for (const name of ["jarvis_list_prod_tools", "jarvis_describe_prod_tool"]) {
      const policy = applyJarvisToolPolicy(entry(name));
      expect(policy?.mode).toBe("read");
      expect(policy?.autoApprovable).toBe(false);
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
