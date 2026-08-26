import { describe, expect, it } from "vitest";
import {
  isValidWorkshopMcpRequestId,
  negotiateWorkshopMcpProtocolVersion,
  normalizeMcpToolInputSchema,
  validateWorkshopMcpRequestTarget,
  workshopMcpToolDefinition,
} from "../src/mcp-policy.js";

describe("Workshop MCP tool schema normalization", () => {
  it("omits null required fields published by connected tools", () => {
    expect(normalizeMcpToolInputSchema({
      type: "object",
      properties: { tool: { type: "string" } },
      required: null,
      additionalProperties: false,
    })).toEqual({
      type: "object",
      properties: { tool: { type: "string" } },
      additionalProperties: false,
    });
  });

  it("preserves valid required fields and supplies an object fallback", () => {
    expect(normalizeMcpToolInputSchema({ type: "object", required: ["tool"] }))
      .toEqual({ type: "object", required: ["tool"] });
    expect(normalizeMcpToolInputSchema(null))
      .toEqual({ type: "object", additionalProperties: true });
  });
});

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


describe("Workshop MCP Apps tool pass-through", () => {
  it("preserves standard output, security, and UI metadata fields", () => {
    expect(workshopMcpToolDefinition({
      name: "mcp-1__weather",
      inputSchema: { type: "object" },
      outputSchema: { type: "object", required: ["temperature"] },
      securitySchemes: [{ type: "oauth2", scopes: ["weather.read"] }],
      _meta: { ui: { resourceUri: "ui://workshop/mcp-1/generation-a/ui%3A%2F%2Fweather%2Fdashboard" } },
    })).toMatchObject({
      outputSchema: { type: "object", required: ["temperature"] },
      securitySchemes: [{ type: "oauth2", scopes: ["weather.read"] }],
      _meta: { ui: { resourceUri: "ui://workshop/mcp-1/generation-a/ui%3A%2F%2Fweather%2Fdashboard" } },
    });
  });
});


describe("Workshop MCP protocol negotiation", () => {
  it("echoes compatible versions and selects the current version for unknown revisions", () => {
    expect(negotiateWorkshopMcpProtocolVersion("2025-03-26")).toBe("2025-03-26");
    expect(negotiateWorkshopMcpProtocolVersion("2099-01-01")).toBe("2025-06-18");
  });

  it("rejects missing, non-string, and oversized protocol versions", () => {
    expect(negotiateWorkshopMcpProtocolVersion(undefined)).toBeNull();
    expect(negotiateWorkshopMcpProtocolVersion(20250618)).toBeNull();
    expect(negotiateWorkshopMcpProtocolVersion("x".repeat(33))).toBeNull();
  });
});


describe("Workshop MCP request ids", () => {
  it("accepts only non-null JSON-RPC string and finite-number ids", () => {
    expect(isValidWorkshopMcpRequestId("request-1")).toBe(true);
    expect(isValidWorkshopMcpRequestId(0)).toBe(true);
    expect(isValidWorkshopMcpRequestId(null)).toBe(false);
    expect(isValidWorkshopMcpRequestId(undefined)).toBe(false);
    expect(isValidWorkshopMcpRequestId(false)).toBe(false);
  });
});
