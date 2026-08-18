import type { CodingSessionRuntime } from "@gadgets/workshop-shared/api";
import { WORKSHOP_MCP_HOST } from "./mcp-policy.js";

export const PI_CONFIG_DIR = "/workspace/.odie-pi";
export const PI_EXTENSION_PATH = `${PI_CONFIG_DIR}/odie-runtime.ts`;

export function codingSessionRuntime(runtime: unknown): CodingSessionRuntime {
  if (runtime === undefined || runtime === "opencode") return "opencode";
  if (runtime === "pi") return "pi";
  throw new Error("Invalid coding session runtime.");
}

export function assertRuntimeEnabled(runtime: CodingSessionRuntime, enabled: string | undefined): void {
  if (runtime === "pi" && enabled !== "true") {
    throw new Error("Pi coding sessions are not enabled for this deployment.");
  }
}

export function piCommand(): [string, ...string[]] {
  return [
    "/usr/local/bin/pi",
    "--provider", "odie-team-pi",
    "--model", "gpt-5.6-sol",
    "--models", "odie-team-pi/gpt-5.6-sol",
    "--tui-mode", "fullscreen",
    "--no-extensions",
    "--extension", PI_EXTENSION_PATH,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
  ];
}

export function piEnvironment(): Record<string, string> {
  return {
    PI_CODING_AGENT_DIR: PI_CONFIG_DIR,
    PI_OFFLINE: "1",
  };
}

export function piExtensionSource(teamPiBaseUrl: string): string {
  const providerBaseUrl = new URL("codex", ensureTrailingSlash(teamPiBaseUrl)).toString();
  const workshopMcpUrl = `https://${WORKSHOP_MCP_HOST}/mcp`;
  return `import { createMcpAdapter } from "/opt/odie-pi/node_modules/pi-mcp-adapter/index.ts";

export default function odieRuntime(pi) {
  pi.registerProvider("odie-team-pi", {
    name: "Team PI Codex",
    baseUrl: ${JSON.stringify(providerBaseUrl)},
    apiKey: "synthetic",
    api: "openai-responses",
    models: [{
      id: "gpt-5.6-sol",
      name: "GPT 5.6 Sol",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1050000,
      maxTokens: 128000,
    }],
  });
  createMcpAdapter({
    config: {
      mcpServers: {
        workshop: {
          url: ${JSON.stringify(workshopMcpUrl)},
          auth: false,
          oauth: false,
          lifecycle: "eager",
          requestTimeoutMs: 30000,
        },
      },
      settings: {
        hostConfigDiscovery: "off",
        scriptMode: false,
      },
    },
  })(pi);
}
`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
