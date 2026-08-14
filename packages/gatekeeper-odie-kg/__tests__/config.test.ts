import { describe, expect, it } from "vitest";
import type { ClassifiedTool } from "@gadgets/mcp-shared/tools";
import {
  applyOdieKgToolPolicy,
  odieKgResourceUrl,
  readOdieKgConfig,
  ODIE_KG_ALLOWED_TOOLS,
  ODIE_KG_OAUTH_SCOPE,
} from "../src/config.js";

function env(values: Record<string, string> = {}): Env {
  return values as unknown as Env;
}

describe("Totango KG configuration", () => {
  it("accepts only an HTTPS Odie MCP endpoint without URL credentials or decoration", () => {
    expect(readOdieKgConfig(env({
      ODIE_KG_MCP_URL: "https://api-agents.unison.totango.com/api/mcp/odie",
    })))?.toEqual({ endpoint: "https://api-agents.unison.totango.com/api/mcp/odie" });
    for (const endpoint of [
      "http://api.example.com/api/mcp/odie",
      "https://user:secret@api.example.com/api/mcp/odie",
      "https://api.example.com/api/mcp/unison",
      "https://api.example.com/api/mcp/odie?tenant=other",
      "https://api.example.com/api/mcp/odie#tool=export",
    ]) {
      expect(readOdieKgConfig(env({ ODIE_KG_MCP_URL: endpoint }))).toBeNull();
    }
  });

  it("requests only identity and KG read scopes", () => {
    expect(ODIE_KG_OAUTH_SCOPE).toBe("openid profile email mcp:odie:kg:read");
    expect(ODIE_KG_OAUTH_SCOPE).not.toContain("exports");
    expect(ODIE_KG_OAUTH_SCOPE).not.toContain("skills");
  });

  it("uses the exact twelve read-tool names in the singleton discriminator", () => {
    expect(ODIE_KG_ALLOWED_TOOLS).toHaveLength(12);
    const url = odieKgResourceUrl("https://api.example.com/api/mcp/odie");
    for (const tool of ODIE_KG_ALLOWED_TOOLS) {
      expect(url).toContain(`tool=${encodeURIComponent(tool)}`);
    }
  });

  it("drops non-KG tools and forces allowlisted tools to connector-owned reads", () => {
    const tool = (name: string): ClassifiedTool => ({
      tool: { name, inputSchema: { type: "object" } },
      mode: "action",
      autoApprovable: true,
      classifiedBy: "server-annotation",
    });
    expect(applyOdieKgToolPolicy(tool("odie-export-request"))).toBeNull();
    expect(applyOdieKgToolPolicy(tool("odie-skill-run"))).toBeNull();
    expect(applyOdieKgToolPolicy(tool("odie-kg-search"))).toMatchObject({
      mode: "read",
      autoApprovable: false,
      classifiedBy: "default",
    });
  });
});
