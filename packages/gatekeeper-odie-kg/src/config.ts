import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { ConnectedServer } from "@gadgets/mcp-shared/account";
import type { ClassifiedTool } from "@gadgets/mcp-shared/tools";
import { formatToolScope, type ToolScope } from "@gadgets/mcp-shared/scope";

/** Stable vendor identifier for the first-party ODIE MCP connector. */
export const VENDOR_ID = "odie_kg";

/** Stable server identifier used in generated session types. */
export const ODIE_KG_SERVER_ID = "totango_kg";

/** Human-facing connector and binding name. */
export const ODIE_KG_DISPLAY_NAME = "ODIE MCP";

/** The only ODIE MCP endpoint enabled for the hosted Odie deployment. */
export const ODIE_KG_EU_ENDPOINT = "https://api-agents.unison.totango.com/api/mcp/odie";

/** Least-privilege OAuth scopes requested from Agentic's Odie MCP resource. */
export const ODIE_KG_OAUTH_SCOPE = [
  "openid",
  "profile",
  "email",
  "mcp:odie:kg:read",
  "mcp:odie:exports:read",
  "mcp:odie:skills:read",
  "mcp:odie:customers:read",
  "mcp:odie:public-api:read",
].join(" ");

/** Exact read-only ODIE MCP tools exposed by this connector. */
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
  "get_customer_overview",
  "get_customer_property",
  "search_customer",
  "get_customer_interaction",
  "get_customer_prediction",
  "get_segment",
  "odie-skills-list",
  "odie-export-status",
  "odie-export-download",
  "leviosa_public_list_property_definitions",
  "leviosa_public_list_accounts",
  "leviosa_public_get_account",
  "leviosa_public_list_workflow_emails",
  "leviosa_public_get_workflow_email",
  "leviosa_public_list_account_health_snapshots",
  "leviosa_public_list_notes",
  "leviosa_public_get_note",
  "leviosa_public_list_workflows",
  "leviosa_public_get_workflow",
  "leviosa_public_list_workflow_email_templates",
  "leviosa_public_list_workflow_runs",
  "leviosa_public_list_work_items",
  "leviosa_public_get_work_item",
  "leviosa_public_list_email_suppressions",
] as const;

/** One validated deployment-owned ODIE MCP endpoint. */
export type OdieKgConfig = { endpoint: string };

/** Reads the configured Agentic ODIE MCP endpoint, failing closed unless it is the EU endpoint. */
export function readOdieKgConfig(env: Env): OdieKgConfig | null {
  const raw = env.ODIE_KG_MCP_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.toString() !== ODIE_KG_EU_ENDPOINT) {
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
