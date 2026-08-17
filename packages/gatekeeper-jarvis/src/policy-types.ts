import type { ToolScope } from "@gadgets/mcp-shared/scope";

/** Fixed MCP tool allowlist exposed by the JARVIS ambient singleton. */
export const JARVIS_ALLOWED_TOOLS = [
  "query_knowledge",
  "repo_knowledge",
  "resolve_repo_group",
  "lookup_incident",
  "repo_graph_search",
  "repo_graph_get_node",
  "repo_graph_neighbors",
  "repo_graph_traverse",
  "repo_graph_status",
  "jarvis_answer_support_question",
  "jarvis_investigate_customer_issue",
  "jarvis_check_integration_health",
  "jarvis_get_investigation_status",
  "jarvis_get_support_answer_status",
  "jarvis_list_prod_tools",
  "jarvis_describe_prod_tool",
  "jarvis_call_prod_tool",
] as const;

/** A JARVIS MCP tool that this gatekeeper may expose. */
export type JarvisAllowedTool = typeof JARVIS_ALLOWED_TOOLS[number];

/** JARVIS tools administrators may configure through the management application. */
export const JARVIS_SETTINGS_TOOLS: readonly JarvisAllowedTool[] = JARVIS_ALLOWED_TOOLS.filter(
  name => name !== "repo_knowledge" && name !== "jarvis_call_prod_tool"
);

/** Deployment-global immutable-snapshot policy for JARVIS chat and code tool access. */
export type JarvisToolPolicy = {
  /** Monotonic policy revision used as the singleton authority key. */
  revision: number;
  /** Tool scope presented to agent/chat sessions. */
  chat: ToolScope;
  /** Tool scope presented to persistent gadget-code sessions. */
  code: ToolScope;
  /** Whether code mirrors chat rather than being configured independently. */
  syncCode: boolean;
};

/** Input accepted by the JARVIS policy management API. */
export type JarvisToolPolicyInput = {
  /** Allowed tool names for agent/chat sessions. */
  chatTools: string[];
  /** When true, code receives the normalized chat scope. */
  syncCode: boolean;
  /** Allowed tool names for code when `syncCode` is false. */
  codeTools?: string[];
};
