import { describe, expect, it } from "vitest";
import {
  assertCodingSessionMcpResponseSize,
  namespaceCodingSessionResourceUri,
  namespaceCodingSessionToolMetadata,
  parseCodingSessionResourceUri,
  selectCodingSessionResourceBinding,
} from "../src/coding-session-mcp.js";

const GENERATION = "generation-a";

describe("coding-session MCP resource namespaces", () => {
  it("round trips the binding generation and opaque upstream resource identity", () => {
    const namespaced = namespaceCodingSessionResourceUri(
      "mcp-17", GENERATION, "ui://widget/index.html?x=/&y=%25#view");
    expect(parseCodingSessionResourceUri(namespaced)).toEqual({
      bindingId: "mcp-17",
      bindingGeneration: GENERATION,
      upstreamUri: "ui://widget/index.html?x=/&y=%25#view",
    });
  });

  it.each([
    "https://workshop/mcp-1/generation-a/ui%3A%2F%2Fapp",
    "ui://other/mcp-1/generation-a/ui%3A%2F%2Fapp",
    "ui://workshop/mcp-1/generation-a/ui%3A%2F%2Fapp/extra",
    "ui://workshop/mcp-1/generation-a/ui%3A%2F%2Fapp?escape=true",
    "ui://workshop/mcp%252D1/generation-a/ui%253A%252F%252Fapp",
    "ui://workshop/mcp-1/generation-a/ui%3A%2F%2Fapp%00",
    "ui://workshop/mcp%2F1/generation-a/ui%3A%2F%2Fapp",
  ])("rejects non-canonical proxy URI %s", uri => {
    expect(() => parseCodingSessionResourceUri(uri)).toThrow(/invalid Workshop MCP resource URI/i);
  });

  it("blocks A-app calls to its own, cross-binding read, and auto-approved tools", () => {
    expect(namespaceCodingSessionToolMetadata("mcp-1", GENERATION, {
      ui: { resourceUri: "ui://app/main", visibility: ["app"] },
    })).toEqual({
      ui: {
        resourceUri: "ui://workshop/mcp-1/generation-a/ui%3A%2F%2Fapp%2Fmain",
        visibility: ["model"],
      },
    });
    expect(namespaceCodingSessionToolMetadata("mcp-2", GENERATION, undefined))
      .toEqual({ ui: { visibility: ["model"] } });
    expect(namespaceCodingSessionToolMetadata("mcp-3", GENERATION, {
      ui: { visibility: ["model", "app"] },
    })).toEqual({ ui: { visibility: ["model"] } });
  });

  it("accounts for UTF-8 and namespace percent expansion in aggregate resource responses", () => {
    const uri = namespaceCodingSessionResourceUri(
      "mcp-1", GENERATION, `ui://app/${"é".repeat(4000)}`);
    expect(() => assertCodingSessionMcpResponseSize({ resources: [{ uri }] })).not.toThrow();
    expect(() => assertCodingSessionMcpResponseSize({
      resources: Array.from({ length: 100 }, () => ({ uri })),
    })).toThrow(/too large/);
  });

  it("bounds transformed tools across multiple maximum-size catalogs", () => {
    const makeTool = (binding: number) => ({
      name: `mcp-${binding}__app`,
      outputSchema: { description: "é".repeat(20_000) },
      securitySchemes: [{ type: "oauth2", scopes: ["s".repeat(20_000)] }],
      _meta: namespaceCodingSessionToolMetadata(
        `mcp-${binding}`, GENERATION, { ui: { resourceUri: `ui://app/${"é".repeat(4000)}` } }),
    });
    expect(() => assertCodingSessionMcpResponseSize({ tools: [makeTool(1)] })).not.toThrow();
    expect(() => assertCodingSessionMcpResponseSize({
      tools: Array.from({ length: 20 }, (_, index) => makeTool(index + 1)),
    })).toThrow(/too large/);
  });
});

describe("coding-session MCP binding isolation", () => {
  it("rejects an unknown binding and a cached URI from before reconnect", () => {
    const current = [{ id: "mcp-1", generation: "generation-current", owner: "current" }];
    expect(selectCodingSessionResourceBinding(
      "mcp-1", "generation-current", current)).toBe(current[0]);
    expect(() => selectCodingSessionResourceBinding(
      "mcp-2", "generation-current", current)).toThrow(/no longer available/);

    const staleUri = namespaceCodingSessionResourceUri(
      "mcp-1", "generation-before-reconnect", "ui://app/main");
    const stale = parseCodingSessionResourceUri(staleUri);
    expect(() => selectCodingSessionResourceBinding(
      stale.bindingId, stale.bindingGeneration, current)).toThrow(/no longer available/);
  });
});
