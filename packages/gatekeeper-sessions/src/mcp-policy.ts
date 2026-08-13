/** Hostname used only inside the coding-session sandbox for Workshop MCP traffic. */
export const WORKSHOP_MCP_HOST = "workshop-mcp.internal";

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
