import type { CodingSessionTool } from "@gadgets/workshop-shared/coding-sessions";

const WORKSHOP_MCP_PROTOCOL_VERSION = "2025-06-18";
const WORKSHOP_MCP_COMPATIBLE_PROTOCOL_VERSIONS = new Set([
  WORKSHOP_MCP_PROTOCOL_VERSION,
  "2025-03-26",
]);

/** Selects a supported MCP version from one validated initialize request. */
export function negotiateWorkshopMcpProtocolVersion(requested: unknown): string | null {
  if (typeof requested !== "string" || requested.length === 0 || requested.length > 32) return null;
  return WORKSHOP_MCP_COMPATIBLE_PROTOCOL_VERSIONS.has(requested)
    ? requested : WORKSHOP_MCP_PROTOCOL_VERSION;
}

/** Returns whether a post-initialize request names a protocol version supported by Workshop. */
export function isSupportedWorkshopMcpProtocolVersion(value: string): boolean {
  return WORKSHOP_MCP_COMPATIBLE_PROTOCOL_VERSIONS.has(value);
}

/** Hostname used only inside the coding-session sandbox for Workshop MCP traffic. */
export const WORKSHOP_MCP_HOST = "workshop-mcp.internal";

/** Normalizes connected tool schemas to the root object shape required by MCP clients. */
export function normalizeMcpToolInputSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { type: "object", additionalProperties: true };
  }
  const schema: Record<string, unknown> = { ...input as Record<string, unknown>, type: "object" };
  if (!Array.isArray(schema.required) || schema.required.some((name: unknown) => typeof name !== "string")) {
    delete schema.required;
  }
  if (schema.properties !== undefined &&
      (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties))) {
    delete schema.properties;
  }
  return schema;
}

/** Returns whether a JSON-RPC request id is a non-null string or finite number. */
export function isValidWorkshopMcpRequestId(value: unknown): value is string | number {
  return (typeof value === "string") || (typeof value === "number" && Number.isFinite(value));
}

/** Converts a Workshop tool contract into the standard MCP wire definition. */
export function workshopMcpToolDefinition(tool: CodingSessionTool): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: normalizeMcpToolInputSchema(tool.inputSchema),
    outputSchema: tool.outputSchema,
    securitySchemes: tool.securitySchemes,
    _meta: tool._meta,
  };
}

/**
 * Validates that an intercepted Workshop MCP request targets the internal endpoint with the supported HTTP method.
 */
export function validateWorkshopMcpRequestTarget(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.hostname !== WORKSHOP_MCP_HOST || url.pathname !== "/mcp") {
    return new Response("Workshop MCP request is not allowed.", { status: 403 });
  }
  if (request.method === "GET") {
    return new Response("Workshop MCP does not provide an SSE stream; use POST for JSON-RPC messages.", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
  if (request.method !== "POST") {
    return new Response("Workshop MCP request is not allowed.", { status: 403 });
  }
  return null;
}
