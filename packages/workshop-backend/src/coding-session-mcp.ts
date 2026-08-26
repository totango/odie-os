import type { CodingSessionTool } from "@gadgets/workshop-shared/coding-sessions";

const CODING_SESSION_RESOURCE_HOST = "workshop";
const MAX_CODING_SESSION_RESOURCE_RESPONSE_BYTES = 900 * 1024;
const CODING_SESSION_BINDING_ID = /^[a-z][a-z0-9_-]*-[0-9]+(?:-[A-Za-z0-9-]{0,64}-[a-z0-9]+)?$/;

function hasControlCharacters(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/** Wraps an upstream MCP Apps resource URI in one Workshop-owned binding namespace. */
export function namespaceCodingSessionResourceUri(
  bindingId: string,
  bindingGeneration: string,
  upstreamUri: string,
): string {
  if (!CODING_SESSION_BINDING_ID.test(bindingId) || !isBindingGeneration(bindingGeneration) ||
      !isUpstreamUiUri(upstreamUri)) {
    throw new Error("Invalid Workshop MCP resource identity.");
  }
  return `ui://${CODING_SESSION_RESOURCE_HOST}/${encodeURIComponent(bindingId)}/` +
    `${encodeURIComponent(bindingGeneration)}/${encodeURIComponent(upstreamUri)}`;
}

function isBindingGeneration(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !hasControlCharacters(value);
}

function isUpstreamUiUri(uri: string): boolean {
  if (uri.length === 0 || uri.length > 4096 || hasControlCharacters(uri)) return false;
  try {
    return new URL(uri).protocol === "ui:";
  } catch {
    return false;
  }
}

/** Selects a resource binding only from the current user's live binding set. */
export function selectCodingSessionResourceBinding<T extends { id: string; generation: string }>(
  bindingId: string,
  bindingGeneration: string,
  bindings: readonly T[],
): T {
  const binding = bindings.find(candidate =>
    candidate.id === bindingId && candidate.generation === bindingGeneration);
  if (!binding) throw new Error("This connected resource is no longer available.");
  return binding;
}

/** Rejects a post-namespace resource response that exceeds the Workshop MCP byte budget. */
export function assertCodingSessionMcpResponseSize(value: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_CODING_SESSION_RESOURCE_RESPONSE_BYTES) {
    throw new Error("Workshop MCP response is too large.");
  }
}

/**
 * Rewrites app metadata for Workshop and fails closed against iframe tool calls.
 *
 * pi-mcp-adapter 2.26 does not carry a trusted iframe origin through MCP `tools/call`, so Workshop
 * must not expose any tool as app-callable until that adapter supplies an unforgeable origin.
 */
export function namespaceCodingSessionToolMetadata(
  bindingId: string,
  bindingGeneration: string,
  metadata: CodingSessionTool["_meta"],
): CodingSessionTool["_meta"] {
  const resourceUri = metadata?.ui?.resourceUri;
  return {
    ui: {
      ...(resourceUri === undefined
        ? {} : { resourceUri: namespaceCodingSessionResourceUri(bindingId, bindingGeneration, resourceUri) }),
      visibility: ["model"],
    },
  };
}

/** Validates and unwraps one Workshop-owned MCP Apps resource URI. */
export function parseCodingSessionResourceUri(
  uri: string,
): { bindingId: string; bindingGeneration: string; upstreamUri: string } {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("Invalid Workshop MCP resource URI.");
  }
  const segments = parsed.pathname.slice(1).split("/");
  if (parsed.protocol !== "ui:" || parsed.hostname !== CODING_SESSION_RESOURCE_HOST ||
      parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash ||
      segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) {
    throw new Error("Invalid Workshop MCP resource URI.");
  }
  try {
    const bindingId = decodeURIComponent(segments[0]);
    const bindingGeneration = decodeURIComponent(segments[1]);
    const upstreamUri = decodeURIComponent(segments[2]);
    if (!CODING_SESSION_BINDING_ID.test(bindingId) || !isBindingGeneration(bindingGeneration) ||
        !isUpstreamUiUri(upstreamUri) ||
        namespaceCodingSessionResourceUri(bindingId, bindingGeneration, upstreamUri) !== uri) {
      throw new Error("Invalid Workshop MCP resource URI.");
    }
    return { bindingId, bindingGeneration, upstreamUri };
  } catch {
    throw new Error("Invalid Workshop MCP resource URI.");
  }
}
