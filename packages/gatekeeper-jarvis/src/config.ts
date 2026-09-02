import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { ClassifiedTool, ServerTrust } from "@gadgets/mcp-shared/tools";
import { sameEndpoint } from "@gadgets/mcp-shared/scope";
import { JARVIS_ALLOWED_TOOLS, type JarvisAllowedTool } from "./policy-types.js";
export { JARVIS_ALLOWED_TOOLS, type JarvisAllowedTool } from "./policy-types.js";

/** Stable vendor identifier for the deployment-configured JARVIS MCP gatekeeper. */
export const VENDOR_ID = "jarvis";

/** Stable server id used in generated types, binding names, and approval-scope tags. */
export const JARVIS_SERVER_ID = "jarvis";

/** Human-facing display name for the JARVIS singleton account and resource. */
export const JARVIS_DISPLAY_NAME = "JARVIS";

/** Monochrome robot icon for the JARVIS management app sidebar entry. */
export const JARVIS_UI_ICON = {
  url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'%3E%3Cpath fill='currentColor' d='M200 48h-56V32a16 16 0 0 0-32 0v16H56a32 32 0 0 0-32 32v96a32 32 0 0 0 32 32h144a32 32 0 0 0 32-32V80a32 32 0 0 0-32-32ZM88 144a24 24 0 1 1 24-24 24 24 0 0 1-24 24Zm80 0a24 24 0 1 1 24-24 24 24 0 0 1-24 24Zm-72 32h64a8 8 0 0 1 0 16H96a8 8 0 0 1 0-16Z'/%3E%3C/svg%3E",
};

const ALLOWED_TOOL_SET = new Set<string>(JARVIS_ALLOWED_TOOLS);

/** Parsed deployment configuration for the JARVIS MCP endpoint. */
export type JarvisConfig = {
  /** HTTPS Streamable HTTP MCP endpoint configured by the deployment. */
  endpoint: string;
};

/** Returns true when `toolName` is in the fixed production JARVIS MCP allowlist. */
export function isJarvisAllowedTool(toolName: string): toolName is JarvisAllowedTool {
  return ALLOWED_TOOL_SET.has(toolName);
}

/** Applies deployment-owned read/action policy to allowlisted JARVIS tools. */
export function applyJarvisToolPolicy(entry: ClassifiedTool): ClassifiedTool | null {
  if (!isJarvisAllowedTool(entry.tool.name)) return null;
  const manualAction = entry.tool.name === "jarvis_call_prod_tool" ||
    entry.tool.name === "jarvis_call_wren_tool";
  return {
    ...entry,
    mode: manualAction ? "action" : "read",
    autoApprovable: false,
    classifiedBy: "default",
  };
}

/** Reads and validates the deployment-configured JARVIS MCP endpoint. */
export function readJarvisConfig(env: Env): JarvisConfig | null {
  const raw = env.JARVIS_MCP_URL?.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  url.hash = "";
  return { endpoint: url.toString() };
}

/** Returns the current JARVIS annotation trust tier. Defaults to BYO unless explicitly enabled. */
export function jarvisTrust(env: Env): ServerTrust {
  return (env.JARVIS_TRUST_ANNOTATIONS ?? "").toLowerCase() === "true" ? "vetted" : "byo";
}

/** Returns the bearer token only for the deployment's current JARVIS endpoint. */
export function jarvisTokenFor(env: Env, endpoint: string): string | null {
  const config = readJarvisConfig(env);
  if (!config || !sameEndpoint(config.endpoint, endpoint)) return null;
  return env.JARVIS_MCP_TOKEN || null;
}

/** Returns true when both endpoint and bearer token configuration are present and usable. */
export function hasJarvisConfiguration(env: Env): boolean {
  const config = readJarvisConfig(env);
  return config !== null && jarvisTokenFor(env, config.endpoint) !== null;
}

/** Describes the singleton JARVIS MCP resource exposed to the Workshop account surface. */
export function jarvisResource(config: JarvisConfig): SupportedResource {
  return {
    urlPattern: config.endpoint,
    title: JARVIS_DISPLAY_NAME,
    description:
      "Deployment-approved JARVIS knowledge, support, incident, and integration-health tools.",
  };
}
