import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { ConnectedServer } from "@gadgets/mcp-shared/account";
import type { ClassifiedTool } from "@gadgets/mcp-shared/tools";
import { formatToolScope, type ToolScope } from "@gadgets/mcp-shared/scope";

/** Stable vendor identifier for the first-party Totango Knowledge Graph connector. */
export const VENDOR_ID = "odie_kg";

/** Stable server identifier used in generated session types. */
export const ODIE_KG_SERVER_ID = "totango_kg";

/** Human-facing connector and binding name. */
export const ODIE_KG_DISPLAY_NAME = "Totango Knowledge Graph";

/** Least-privilege OAuth scopes requested from Agentic's Odie MCP resource. */
export const ODIE_KG_OAUTH_SCOPE = "openid profile email mcp:odie:kg:read";

/** Exact customer/internal knowledge tools exposed by this connector. */
export const ODIE_KG_ALLOWED_TOOLS = [
  "odie-kg-status",
  "odie-kg-domains",
  "odie-kg-accounts",
  "odie-kg-account-root",
  "odie-kg-node",
  "odie-kg-children",
  "odie-kg-expand",
  "odie-kg-search",
  "odie-kg-query",
  "odie-kg-paths",
  "odie-kg-communities",
  "odie-kg-document",
] as const;

/** One validated deployment-owned Odie KG endpoint. */
export type OdieKgConfig = { endpoint: string };

/** Reads the configured Agentic Odie MCP endpoint, failing closed on an unexpected URL shape. */
export function readOdieKgConfig(env: Env): OdieKgConfig | null {
  const raw = env.ODIE_KG_MCP_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/api/mcp/odie") {
    return null;
  }
  return { endpoint: url.toString() };
}

/** Deployment-owned server record used for first connect and reconnect. */
export function odieKgServer(config: OdieKgConfig): ConnectedServer {
  return {
    endpoint: config.endpoint,
    serverId: ODIE_KG_SERVER_ID,
    serverName: ODIE_KG_DISPLAY_NAME,
    provenance: "deployment",
    auth: "oauth",
  };
}

/** Immutable tool scope for the owner-specific ambient singleton. */
export function odieKgToolScope(): ToolScope {
  return { tools: [...ODIE_KG_ALLOWED_TOOLS] };
}

/** Stable resource discriminator used by generated types and the singleton facet. */
export function odieKgResourceUrl(endpoint: string): string {
  return formatToolScope(endpoint, odieKgToolScope());
}

/** Non-grantable resource metadata used to surface the connector before OAuth. */
export function odieKgResource(config: OdieKgConfig): SupportedResource {
  return {
    urlPattern: config.endpoint,
    title: ODIE_KG_DISPLAY_NAME,
    description: "Tenant-scoped customer, account, CSM, product-usage, and internal knowledge.",
  };
}

/** Applies the connector-owned read-only contract instead of trusting remote annotations. */
export function applyOdieKgToolPolicy(entry: ClassifiedTool): ClassifiedTool | null {
  if (!(ODIE_KG_ALLOWED_TOOLS as readonly string[]).includes(entry.tool.name)) return null;
  return { ...entry, mode: "read", autoApprovable: false, classifiedBy: "default" };
}
