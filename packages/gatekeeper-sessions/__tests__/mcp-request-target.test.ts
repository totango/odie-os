import { describe, expect, it } from "vitest";
import { validateWorkshopMcpRequestTarget } from "../src/mcp-policy.js";

describe("Workshop MCP request target validation", () => {
  it("returns 405 for GET negotiation on the internal MCP endpoint", async () => {
    const response = validateWorkshopMcpRequestTarget(new Request("https://workshop-mcp.internal/mcp", {
      method: "GET",
    }));

    expect(response?.status).toBe(405);
    expect(response?.headers.get("Allow")).toBe("POST");
    await expect(response?.text()).resolves.toContain("does not provide an SSE stream");
  });

  it("denies invalid targets before considering the method", () => {
    expect(validateWorkshopMcpRequestTarget(new Request("https://workshop-mcp.internal/other", {
      method: "GET",
    }))?.status).toBe(403);
    expect(validateWorkshopMcpRequestTarget(new Request("https://evil.example/mcp", {
      method: "GET",
    }))?.status).toBe(403);
  });

  it("allows POST to the exact internal MCP endpoint", () => {
    expect(validateWorkshopMcpRequestTarget(new Request("https://workshop-mcp.internal/mcp", {
      method: "POST",
    }))).toBeNull();
  });
});
