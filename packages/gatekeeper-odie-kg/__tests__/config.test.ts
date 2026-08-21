import { describe, expect, it } from "vitest";
import type { ClassifiedTool } from "@gadgets/mcp-shared/tools";
import {
  applyOdieKgToolPolicy,
  odieKgResourceUrl,
  readOdieKgConfig,
  ODIE_KG_ALLOWED_TOOLS,
  ODIE_KG_EU_ENDPOINT,
  ODIE_KG_OAUTH_SCOPE,
} from "../src/config.js";

function env(values: Record<string, string> = {}): Env {
  return values as unknown as Env;
}

describe("ODIE MCP configuration", () => {
  it("accepts only the exact EU ODIE MCP endpoint", () => {
    expect(readOdieKgConfig(env({
      ODIE_KG_MCP_URL: ODIE_KG_EU_ENDPOINT,
    })))?.toEqual({ endpoint: ODIE_KG_EU_ENDPOINT });
    for (const endpoint of [
      "http://api.example.com/api/mcp/odie",
      "https://user:secret@api.example.com/api/mcp/odie",
      "https://api.example.com/api/mcp/unison",
      "https://api.example.com/api/mcp/odie?tenant=other",
      "https://api.example.com/api/mcp/odie#tool=export",
      "https://api-agents.us.unison.totango.com/api/mcp/odie",
    ]) {
      expect(readOdieKgConfig(env({ ODIE_KG_MCP_URL: endpoint }))).toBeNull();
    }
  });

  it("requests only identity and ODIE MCP read scopes", () => {
    expect(ODIE_KG_OAUTH_SCOPE.split(" ")).toEqual([
      "openid",
      "profile",
      "email",
      "mcp:odie:kg:read",
      "mcp:odie:exports:read",
      "mcp:odie:skills:read",
      "mcp:odie:customers:read",
      "mcp:odie:public-api:read",
    ]);
    expect(ODIE_KG_OAUTH_SCOPE).not.toMatch(/:write|:run|:generate/);
  });

  it("uses the exact 36 read-tool names in the singleton discriminator", () => {
    expect(ODIE_KG_ALLOWED_TOOLS).toHaveLength(36);
    const url = odieKgResourceUrl("https://api.example.com/api/mcp/odie");
    for (const tool of ODIE_KG_ALLOWED_TOOLS) {
      expect(url).toContain(`tool=${encodeURIComponent(tool)}`);
    }
  });

  it("drops side effects and forces every allowlisted tool to a connector-owned read", () => {
    const tool = (name: string): ClassifiedTool => ({
      tool: { name, inputSchema: { type: "object" } },
      mode: "action",
      autoApprovable: true,
      classifiedBy: "server-annotation",
    });
    for (const name of [
      "odie-skill-run",
      "odie-skill-create-draft",
      "odie-skill-publish",
      "odie-export-request",
      "run_odie_skill",
      "generate_brief",
    ]) {
      expect(applyOdieKgToolPolicy(tool(name))).toBeNull();
    }
    for (const name of ODIE_KG_ALLOWED_TOOLS) {
      expect(applyOdieKgToolPolicy(tool(name))).toMatchObject({
        mode: "read",
        autoApprovable: false,
        classifiedBy: "default",
      });
    }
  });
});
