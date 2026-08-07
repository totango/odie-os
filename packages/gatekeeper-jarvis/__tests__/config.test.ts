import { describe, expect, it } from "vitest";
import {
  hasJarvisConfiguration,
  isJarvisAllowedTool,
  jarvisResource,
  jarvisTokenFor,
  jarvisTrust,
  readJarvisConfig,
  JARVIS_ALLOWED_TOOLS,
} from "../src/config.js";
import deployInputs from "../deploy-inputs.json";

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
      "jarvis_answer_support_question",
      "jarvis_investigate_customer_issue",
      "jarvis_check_integration_health",
      "jarvis_get_investigation_status",
      "jarvis_get_support_answer_status",
    ]);
    expect(isJarvisAllowedTool("create_skill")).toBe(false);
    expect(isJarvisAllowedTool("escalate_to_human")).toBe(false);
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
