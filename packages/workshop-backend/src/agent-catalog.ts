import {
  AGENT_CATALOG_MAX_DESCRIPTION_LENGTH, AGENT_CATALOG_MAX_ENTRIES,
  AGENT_CATALOG_MAX_ID_LENGTH, AGENT_CATALOG_MAX_TITLE_LENGTH,
} from "@gadgets/workshop-shared/gatekeeper";
import type { AgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.agent.catalog");

export type AgentCatalogSnapshot = {
  gatekeeperId: number;
  catalog: AgentCatalog | null;
};

function normalizeText(value: string, maxLength: number): string {
  return value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/**
 * Workshop-side re-validation of a gatekeeper's catalog (the gatekeeper output is untrusted): strip
 * control chars / collapse whitespace, drop unusable entries, and re-clamp to the global
 * AGENT_CATALOG_MAX_* bounds. Gatekeepers should apply the same caps before RPC, but the Workshop
 * does not trust them to do so. `id` keeps the full bound since it is the opaque key the agent passes
 * back; only the title/description need shortening. The count clamp drops from the tail so the
 * gatekeeper's priority order decides what survives; the survivors are then sorted for display.
 */
export function normalizeAgentCatalog(catalog: AgentCatalog): AgentCatalog {
  let entries = catalog.entries
      .map(entry => ({
        id: normalizeText(entry.id, AGENT_CATALOG_MAX_ID_LENGTH),
        title: normalizeText(entry.title, AGENT_CATALOG_MAX_TITLE_LENGTH),
        description: normalizeText(entry.description, AGENT_CATALOG_MAX_DESCRIPTION_LENGTH),
      }))
      .filter(entry => entry.id.length > 0 && entry.title.length > 0);
  let dropped = entries.length > AGENT_CATALOG_MAX_ENTRIES;
  if (dropped) {
    logger.warn("agent catalog exceeded the entry cap", {
      event: "agent.catalog.truncated", size: entries.length,
    });
  }
  return {
    entries: entries
        .slice(0, AGENT_CATALOG_MAX_ENTRIES)
        .toSorted((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)),
    ...(catalog.truncated === true || dropped ? {truncated: true} : {}),
  };
}

export async function completeAgentCatalogSnapshot(
    existing: AgentCatalogSnapshot[] | undefined,
    gatekeeperIds: number[],
    loadCatalog: (gatekeeperId: number) => Promise<AgentCatalog | null>):
    Promise<{snapshots: AgentCatalogSnapshot[], changed: boolean}> {
  let activeIds = new Set(gatekeeperIds);
  let existingCount = existing?.length ?? 0;
  let catalogs = new Map(
      existing
          ?.filter(entry => activeIds.has(entry.gatekeeperId))
          .map(entry => [entry.gatekeeperId, entry.catalog]));
  let removedStaleEntries = catalogs.size !== existingCount;
  let missing = gatekeeperIds.filter(gatekeeperId => !catalogs.has(gatekeeperId));
  await Promise.all(missing.map(async gatekeeperId => {
    // Isolate per entry: one failing loader must not reject the whole snapshot (it would lose every
    // other catalog and abort the turn). A failed/empty load is recorded as null, like any other.
    try {
      catalogs.set(gatekeeperId, await loadCatalog(gatekeeperId));
    } catch (error) {
      logger.warn("failed to load agent catalog", {
        event: "agent.catalog.load.failed", gatekeeperId, error,
      });
      catalogs.set(gatekeeperId, null);
    }
  }));
  return {
    snapshots: [...catalogs]
        .toSorted(([left], [right]) => left - right)
        .map(([gatekeeperId, catalog]) => ({gatekeeperId, catalog})),
    changed: missing.length > 0 || removedStaleEntries,
  };
}

/** The catalog as a JSON blob for inclusion in a prompt, on its own line, or "" if empty. */
export function formatAgentCatalogPrompt(catalog: AgentCatalog | null): string {
  if (!catalog?.entries.length) return "";
  return `\n${JSON.stringify(catalog)}`;
}

/**
 * Build the system-prompt section that tells the agent which always-available resource bindings it
 * has (their `env.NAME` entries) plus each one's discovery catalog, and how to use them. This
 * describes the agent's environment rather than anything the user said, so it lives in the system
 * prompt alongside the bindings list rather than as a synthetic user turn.
 */
export function formatAlwaysAvailableResourcesPrompt(resources: Array<{
  title: string;
  name: string;
  catalog: AgentCatalog | null;
}>): string {
  let lines = resources.map(resource =>
    `- ${resource.title}: \`env.${resource.name}\`${formatAgentCatalogPrompt(resource.catalog)}`);
  let jarvisTools = new Set(resources
    .filter(resource => resource.name === "JARVIS")
    .flatMap(resource => resource.catalog?.entries.map(entry => entry.id) ?? []));
  let hasWrenWorkflow = [
    "jarvis_list_prod_tools",
    "jarvis_describe_wren_tool",
    "jarvis_call_wren_tool",
  ].every(tool => jarvisTools.has(tool));
  let wrenGuidance = hasWrenWorkflow
    ? `For structured production-data questions, prefer the Wren semantic query tools behind ` +
      `JARVIS: list production tools restricted to \`prod-wren\`, describe the relevant Wren tool, ` +
      `validate SQL before execution, and call it through the Wren-specific JARVIS action. Use raw ` +
      `Postgres or ClickHouse production tools only when Wren lacks the required model or capability, ` +
      `and say why that fallback was necessary. `
    : "";
  return `The following resources are always available as bindings in your env for use with the ` +
    `executeCode tool (you don't need to request them):\n${lines.join("\n")}\n` +
    `When one is relevant, use describeBinding with the binding's name to learn its API before ` +
    `using it. If its API lacks an operation you expected, do not request another connection to ` +
    `the same vendor; a duplicate binding does not add methods. Explain the missing capability or ` +
    `use another relevant resource instead. For product feedback, bug reports, or Jira/work-item ` +
    `creation, never create a Gadget, document, or other local artifact as a substitute for an ` +
    `unavailable external write. Use an explicit feedback or work-item action when one exists; ` +
    `otherwise explain that the write is unavailable, ask where the user wants it sent, and provide ` +
    `a concise draft directly in chat. For customer, account, CSM, product-usage, or internal ` +
    `business questions, prefer ` +
    `the ODIE MCP resource when available, then other relevant internal resources, ` +
    `before using public web sources; say when an answer had to fall back to the public web. ` +
    `Within ODIE MCP, structured ODIE account facts from account, property, dashboard, ` +
    `prediction, or public account tools outrank interactions, notes, documents, and meeting ` +
    `titles. Report ambiguity, missing facts, or conflicts; never infer account role, name, ` +
    `identity, or gender from weak evidence. ` +
    wrenGuidance + `For ` +
    `engineering questions about the configured ODI repositories, prefer JARVIS repo_graph tools ` +
    `for indexed topology and relationships, then use the Totango GitHub source resource to verify ` +
    `current implementation details or when the graph is missing or stale. When ` +
    `\`env.GITHUB_ORG\` is available, use it for read-only Totango source access instead of requesting ` +
    `a per-repository GitHub connection; request one only when the task needs capabilities the ` +
    `organization source does not provide. If a Gadget's persistent code needs one, wire it into ` +
    `that gadget with ` +
    `setGadgetBinding.`;
}
