const TOKEN_HEX_LENGTH = 64;

/** Returns whether a request carries the exact fixed-length canary bearer token. */
export async function hasValidCanaryAuthorization(
  authorization: string | null,
  expectedToken: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(expectedToken)) return false;
  if (!authorization?.startsWith("Bearer ")) return false;
  const provided = authorization.slice("Bearer ".length);
  if (provided.length !== TOKEN_HEX_LENGTH || !/^[0-9a-f]{64}$/.test(provided)) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expectedToken)),
  ]);
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

/** Atomically claims through the synchronous `DurableObjectStorage.kv` API. */
export function claimCanaryRun(
  storage: Pick<DurableObjectStorage["kv"], "get" | "put">,
): void {
  if (storage.get<boolean>("claimed")) throw new Error("Canary invocation was already claimed.");
  storage.put("claimed", true);
}

/** Returns a bounded rejection response, or null for an authenticated canary endpoint request. */
export async function rejectCanaryRequest(request: Request, expectedToken: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/ready" && url.pathname !== "/run") return boundedResponse("Not found.", 404);
  if (request.method !== "POST") return boundedResponse("Method not allowed.", 405);
  if (!(await hasValidCanaryAuthorization(request.headers.get("Authorization"), expectedToken))) {
    return boundedResponse("Unauthorized.", 401);
  }
  return null;
}

function boundedResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
