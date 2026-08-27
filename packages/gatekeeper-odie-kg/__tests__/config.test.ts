import { describe, expect, it } from "vitest";
import type { ClassifiedTool } from "@gadgets/mcp-shared/tools";
import {
  applyOdieKgToolPolicy,
  odieKgResourceUrl,
  readOdieKgConfig,
  ODIE_KG_ACTION_TOOLS,
  ODIE_KG_ALLOWED_TOOLS,
  ODIE_KG_EU_ENDPOINT,
  ODIE_KG_OAUTH_SCOPE,
  ODIE_KG_READ_TOOLS,
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

  it("requests the complete explicit ODIE MCP scope set", () => {
    expect(ODIE_KG_OAUTH_SCOPE.split(" ")).toEqual([
      "mcp:odie:kg:read",
      "mcp:odie:exports:read",
      "mcp:odie:exports:write",
      "mcp:odie:skills:read",
      "mcp:odie:skills:run",
      "mcp:odie:skills:write",
      "mcp:odie:customers:read",
      "mcp:odie:lenses:read",
      "mcp:accounts:read",
      "mcp:odie:actions:run",
      "mcp:odie:briefs:generate",
      "mcp:odie:public-api:read",
      "mcp:odie:interviews:read",
      "mcp:odie:interviews:write",
      "mcp:odie:interviews:publish",
    ]);
  });

  it("uses the exact 54-tool catalog in the singleton discriminator", () => {
    expect(ODIE_KG_READ_TOOLS).toHaveLength(42);
    expect(ODIE_KG_ACTION_TOOLS).toHaveLength(12);
    expect(ODIE_KG_ALLOWED_TOOLS).toHaveLength(54);
    const url = odieKgResourceUrl("https://api.example.com/api/mcp/odie");
    for (const tool of ODIE_KG_ALLOWED_TOOLS) {
      expect(url).toContain(`tool=${encodeURIComponent(tool)}`);
    }
  });

  it("classifies the fixed first-party catalog and auto-approves every action", () => {
    const tool = (name: string): ClassifiedTool => ({
      tool: { name, inputSchema: { type: "object" } },
      mode: "action",
      autoApprovable: true,
      classifiedBy: "server-annotation",
    });
    expect(applyOdieKgToolPolicy(tool("unknown-future-tool"))).toBeNull();
    for (const name of ODIE_KG_READ_TOOLS) {
      expect(applyOdieKgToolPolicy(tool(name))).toMatchObject({
        mode: "read",
        autoApprovable: false,
        classifiedBy: "default",
      });
    }
    for (const name of ODIE_KG_ACTION_TOOLS) {
      expect(applyOdieKgToolPolicy(tool(name))).toMatchObject({
        mode: "action",
        autoApprovable: true,
        classifiedBy: "default",
      });
    }
  });
});
