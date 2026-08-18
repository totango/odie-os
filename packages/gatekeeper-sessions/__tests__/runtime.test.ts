import { describe, expect, it } from "vitest";
import {
  assertRuntimeEnabled,
  codingSessionRuntime,
  piCommand,
  piEnvironment,
  piExtensionSource,
} from "../src/runtime.js";

describe("coding session runtimes", () => {
  it("defaults legacy sessions to OpenCode and validates explicit runtimes", () => {
    expect(codingSessionRuntime(undefined)).toBe("opencode");
    expect(codingSessionRuntime("opencode")).toBe("opencode");
    expect(codingSessionRuntime("pi")).toBe("pi");
    expect(() => codingSessionRuntime("other")).toThrow("Invalid coding session runtime");
  });

  it("fails closed unless Pi is explicitly enabled", () => {
    expect(() => assertRuntimeEnabled("pi", undefined)).toThrow("not enabled");
    expect(() => assertRuntimeEnabled("pi", "false")).toThrow("not enabled");
    expect(() => assertRuntimeEnabled("pi", "true")).not.toThrow();
    expect(() => assertRuntimeEnabled("opencode", undefined)).not.toThrow();
  });

  it("starts Pi with only the trusted extension and no ambient resources", () => {
    expect(piCommand()).toEqual([
      "/usr/local/bin/pi",
      "--provider", "odie-team-pi",
      "--model", "gpt-5.6-sol",
      "--models", "odie-team-pi/gpt-5.6-sol",
      "--no-extensions",
      "--extension", "/workspace/.odie-pi/odie-runtime.ts",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
    ]);
    expect(piEnvironment()).toEqual({
      PI_CODING_AGENT_DIR: "/workspace/.odie-pi",
      PI_OFFLINE: "1",
    });
  });

  it("provides only Team PI and the isolated Workshop MCP server", () => {
    const source = piExtensionSource("https://team-pi-proxy.example.com/api/odie");

    expect(source).toContain('baseUrl: "https://team-pi-proxy.example.com/api/odie/codex"');
    expect(source).toContain('url: "https://workshop-mcp.internal/mcp"');
    expect(source).toContain('hostConfigDiscovery: "off"');
    expect(source).toContain("scriptMode: false");
    expect(source).not.toContain("TEAM_PI_CODEX_HMAC_SECRET");
  });
});
