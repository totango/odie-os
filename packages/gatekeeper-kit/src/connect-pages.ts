/** Hardened HTML and browser request guards for gatekeeper connect flows. */

import type { ConnectHandoff, ConnectHandoffProtocol, GatekeeperConnectCallback, GatekeeperReconnectOptions } from "@gadgets/workshop-shared/gatekeeper";
import type { KvMutable } from "./kv";

/**
 * Checks the browser or native callback protocol before a provider exchanges or installs credentials. An older
 * callback's complete() may commit immediately and return void, so checking its result is too late.
 * Keep the method invocation on the callback: RPC method presence cannot be inspected locally.
 * Missing methods, void replies, unknown versions and disagreement with the recorded launch protocol
 * all require a fresh flow after upgrading. The historical name also covers native browser flows.
 */
export async function requireBrowserHandoff(
  callback: Pick<GatekeeperConnectCallback, "getHandoffProtocol">,
  kv?: KvMutable,
): Promise<ConnectHandoffProtocol> {
  try {
    const protocol = await callback.getHandoffProtocol();
    const expected = kv?.get<ConnectHandoffProtocol>("connectHandoffProtocol");
    if ((protocol === "browser-bound-v1" || protocol === "native-verifier-v1") &&
        (expected === undefined || protocol === expected)) return protocol;
  } catch {
    // Includes old RPC implementations with no protocol method. Never fall back to complete().
  }
  throw new Error("This Workshop does not support browser-bound connection handoffs. Upgrade it and start a new connection.");
}

/** Acknowledges provider support and records the requested protocol before exposing a launch URL. */
export async function acknowledgeHandoff(
  kv: KvMutable, options?: GatekeeperReconnectOptions,
): Promise<ConnectHandoffProtocol> {
  const requested = options?.handoffProtocol ?? "browser-bound-v1";
  if (requested !== "browser-bound-v1" && requested !== "native-verifier-v1") {
    throw new Error("PROVIDER_HANDOFF_UPGRADE_REQUIRED");
  }
  const callback = kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
  if (!callback) throw new Error("PROVIDER_HANDOFF_UPGRADE_REQUIRED");
  // Workshop records pendingNativeFlow only after this launch returns. Its retained callback still
  // describes the preceding flow here; agreement is checked before exchange, not at launch.
  kv.put("connectHandoffProtocol", requested);
  return requested;
}

/** Rejects a legacy void completion or malformed handoff without inventing a redirect or ticket. */
export function requireConnectHandoff(handoff: ConnectHandoff | void, protocol?: ConnectHandoffProtocol): ConnectHandoff {
  if (!handoff || typeof handoff.targetOrigin !== "string" ||
      typeof handoff.ticket !== "string" || handoff.ticket.length === 0) {
    throw new Error("This Workshop returned no browser-bound connection handoff. Upgrade it and start a new connection.");
  }
  let origin: string;
  try {
    const url = new URL(handoff.targetOrigin);
    origin = url.protocol === "https:" || url.protocol === "http:" ? url.origin : "";
  } catch {
    origin = "";
  }
  if (origin === "" || origin === "null" || origin !== handoff.targetOrigin) {
    throw new Error("The connect handoff's targetOrigin is not an origin.");
  }
  if (handoff.nativeFlowHandle !== undefined &&
      (typeof handoff.nativeFlowHandle !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(handoff.nativeFlowHandle))) {
    throw new Error("The connect handoff has an invalid native flow handle.");
  }
  if (handoff.nativeFlowHandle !== undefined && !/^[0-9a-f]{64}$/.test(handoff.ticket)) {
    throw new Error("The native handoff has an invalid ticket.");
  }
  if ((protocol === "native-verifier-v1" && handoff.nativeFlowHandle === undefined) ||
      (protocol === "browser-bound-v1" && handoff.nativeFlowHandle !== undefined)) {
    throw new Error("The connect handoff does not match the negotiated protocol.");
  }
  return handoff;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes a value for HTML text or a quoted attribute.
 * @param value Untrusted text.
 * @returns Escaped HTML text.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => HTML_ESCAPES[char]!);
}

/**
 * Builds an uncacheable, unframeable HTML response. Connect URLs carry bearer nonces, so responses
 * never cache or send referrers.
 * @param body HTML response body.
 * @param status HTTP status.
 * @returns A hardened HTML response.
 */
export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Normalizes a media type for exact comparison; substring checks would accept values such as
 * `application/jsonp`.
 * @param value Raw `Content-Type` header.
 * @returns Lowercase media type without parameters.
 */
function mediaType(value: string | null): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

/**
 * Classifies a browser mutation request. The expected origin is explicit rather than derived from
 * `req.url`, which a fronting proxy may rewrite; the browser's `Origin` names the configured base
 * URL the form was served under.
 * @param req Mutation request.
 * @param options Expected origin (a base URL is accepted) and media type.
 * @returns An error code, or `undefined` when accepted.
 *
 * @example
 * ```ts
 * const error = connectMutationError(req, { origin: baseUrl, contentType: "application/json" });
 * if (error) {
 *   const status = error === "cross-origin" ? 403 : 415;
 *   return htmlResponse(errorPageHtml("Connection failed", "Start again."), status);
 * }
 * ```
 */
export function connectMutationError(
  req: Request,
  options: { origin: string; contentType: string },
): "cross-origin" | "unsupported-content-type" | undefined {
  if (req.headers.get("origin") !== new URL(options.origin).origin) return "cross-origin";
  if (mediaType(req.headers.get("content-type")) !== mediaType(options.contentType)) {
    return "unsupported-content-type";
  }
  return undefined;
}

/**
 * Shared connect-page layout. Connect pages cannot load Workshop CSS, so this mirrors its palette.
 */
export const PAGE_STYLE = `
  :root {
    color-scheme: light dark;
    --font: "FT Kunst Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
            "Helvetica Neue", sans-serif;
    --base: #fcfcfb;
    --control: #ffffff;
    --line: #e8e7e4;
    --text: #1c1a18;
    --strong: #100f0d;
    --subtle: oklch(52% 0.006 60);
    --brand: #ff4801;
    --danger: oklch(63.7% 0.237 25.331);
    /* Kumo's primary button is "contrast": near-black in light mode, the accent in dark. */
    --contrast: #14110f;
    --on-contrast: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --base: oklch(0.115 0.012 285);
      --control: oklch(0.155 0.011 285);
      --line: oklch(0.34 0.022 285);
      --text: oklch(0.92 0.01 285);
      --strong: oklch(0.92 0.01 285);
      --subtle: oklch(0.66 0.02 285);
      --brand: #b84e00;
      --danger: oklch(70.4% 0.191 22.216);
      --contrast: #b84e00;
    }
  }

  body { font: 15px/1.5 var(--font); margin: 0; padding: 48px 20px; display: flex;
         justify-content: center; background: var(--base); color: var(--text);
         -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 420px; }
  h1 { font-size: 17px; font-weight: 600; color: var(--strong); margin: 0 0 6px;
       letter-spacing: -0.01em; }
  p.sub { margin: 0 0 24px; color: var(--subtle); font-size: 14px; }
  p.err { color: var(--danger); font-size: 13px; margin: 0 0 16px; }
`;

/**
 * Serializes a value for a `<script>` body. `<`, `>` and `&` become `\uXXXX` escapes so no value —
 * not even one containing `</script>` — can end the script early; the two line terminators JSON
 * allows but JavaScript did not are escaped for older parsers.
 * @param value JSON-serializable value.
 * @returns A JavaScript expression evaluating to the value.
 */
function scriptLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * The page a finished connect, reconnect or sign-in flow lands on. It navigates the popup to the
 * Workshop's own handoff page, `<targetOrigin>/connect/handoff#<ticket>`, which redeems the ticket
 * over the popup's own session; this page holds no session and needs no RPC client.
 *
 * The ticket travels in the URL fragment, which a browser never sends to a server nor in a
 * `Referer` header, and `location.replace()` leaves no history entry to revisit; the ticket is
 * single-use and expires two minutes after the flow finishes. The destination is the
 * backend-supplied `targetOrigin`, validated to be exactly an origin, so the ticket reaches no
 * other document. A flow finished by anyone but its starter ends with a ticket that person's
 * session cannot redeem and no popup of the starter's carries. The connection itself is inert until
 * the Workshop redeems the ticket on the initiating user's session (see
 * `GatekeeperVendor.connectAccount`).
 *
 * The Workshop must serve `/connect/handoff` directly: a fragment survives an HTTP redirect, but the
 * page it lands on has to be the SPA. The path literal is duplicated here on purpose — the kit is
 * published to gatekeepers and must not depend on `workshop-frontend` — and each package pins it
 * with a test.
 * @param handoff The handoff returned by `GatekeeperConnectCallback.complete()` /
 *   `reconnectComplete()`. Its `targetOrigin` must be exactly an origin.
 * @returns Escaped HTML; serve it with `htmlResponse()`.
 *
 * @example
 * ```ts
 * const handoff = await callback.complete(account);
 * return htmlResponse(connectHandoffPageHtml(handoff));
 * ```
 */
export function connectHandoffPageHtml(handoff: ConnectHandoff): string {
  const { targetOrigin: origin } = requireConnectHandoff(handoff);
  const path = handoff.nativeFlowHandle === undefined ? "/connect/handoff" :
    `/native/oauth-return/${encodeURIComponent(handoff.nativeFlowHandle)}`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>Connected</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>Connected</h1>
<p class="sub">Returning to the Workshop…</p></main>
<script>
(function () {
  var ticket = ${scriptLiteral(handoff.ticket)};
  var target = ${scriptLiteral(origin)};
  window.location.replace(target + ${scriptLiteral(path + "#")} + encodeURIComponent(ticket));
})();
</script></body></html>`;
}

/** The page a connect link that has expired or been used already lands on. */
export const INVALID_LINK_HTML =
  errorPageHtml("This link has expired", "Start the connection again.");

/**
 * Renders a connect-flow error page.
 * @param title Error heading.
 * @param detail Error detail.
 * @returns Escaped HTML.
 */
export function errorPageHtml(title: string, detail: string): string {
  const escapedTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapedTitle}</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>${escapedTitle}</h1>
<p class="sub">${escapeHtml(detail)}</p></main></body></html>`;
}
