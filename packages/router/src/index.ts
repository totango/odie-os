// The public origin of a gadgets instance. Routes by path prefix to the workshop backend and
// whichever gatekeepers are bound, and serves the workshop frontend for everything else.
//
// Routing config IS the binding set: gatekeepers are discovered by scanning `GATEKEEPER_*` env
// keys, so installing a gatekeeper only requires re-deploying this worker with one more service
// binding — no code or config changes here.
//
// The same worker doubles as the dev router (`pnpm dev-server` at the repo root): dev has no
// `ASSETS` binding, so frontend requests fall through to the backend instead.

// gatekeeper-email's entrypoint: a WorkerEntrypoint whose optional email() handler is present.
type EmailEntrypoint = CloudflareWorkersModule.WorkerEntrypoint &
    Required<Pick<CloudflareWorkersModule.WorkerEntrypoint, "email">>;

export interface Env {
  WORKSHOP_BACKEND: Fetcher;
  /** Present in production (wrangler.jsonc assets stanza); absent in dev and the native gateway. */
  ASSETS?: Fetcher;
  /** Restricts this deployment to native API, OAuth, and association-document routes. */
  NATIVE_API_ONLY?: string;
  /** Host allowed to serve this deployment's verified-link association documents. */
  APP_LINK_HOST?: string;
  /** Signed Apple application identifier allowed to open links on APP_LINK_HOST. */
  APPLE_APP_ID?: string;
  /** Publicly downloadable, signed native application artifacts. */
  NATIVE_DOWNLOADS?: R2Bucket;
  /** Dormant until custom domains + Email Routing exist; the handler ships anyway. */
  GATEKEEPER_EMAIL?: Service<EmailEntrypoint>;
  [key: string]: unknown;
}

const ODIE_APP_LINK_HOST = "odie-os.odie-os.workers.dev";
const NATIVE_DOWNLOADS = new Map([
  ["/downloads/mac/OdieOS-latest.dmg", {
    key: "mac/OdieOS-latest.dmg",
    contentType: "application/x-apple-diskimage",
  }],
  ["/downloads/mac/OdieOS-latest.dmg.sha256", {
    key: "mac/OdieOS-latest.dmg.sha256",
    contentType: "text/plain; charset=utf-8",
  }],
  ["/downloads/mac/OdieOS-latest.json", {
    key: "mac/OdieOS-latest.json",
    contentType: "application/json; charset=utf-8",
  }],
]);

function nativeDownload(pathname: string): { key: string; contentType: string } | undefined {
  const fixed = NATIVE_DOWNLOADS.get(pathname);
  if (fixed) return fixed;
  const versionedDmg = /^\/downloads\/mac\/OdieOS-(\d+\.\d+\.\d+)\.dmg$/.exec(pathname);
  if (!versionedDmg) return undefined;
  return {
    key: `mac/OdieOS-${versionedDmg[1]}.dmg`,
    contentType: "application/x-apple-diskimage",
  };
}

function nativeDownloadResponse(object: R2Object, body: ReadableStream | null, contentType: string): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", contentType);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=300");
  headers.set("access-control-allow-origin", "*");
  return new Response(body, { headers });
}

function associationResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function appleAppSiteAssociation(appId?: string): Response {
  const details = appId ? [{
    appID: appId,
    paths: [
      "/admin", "/blueprints", "/context", "/explore", "/gatekeepers",
      "/getting-started", "/outputs", "/profile", "/providers", "/sessions",
      "/signup", "/workspaces", "/blueprint/*", "/gadget/*", "/gatekeepers/*",
      "/workspace/*", "/native/oauth-return/*",
    ],
  }] : [];
  return associationResponse({ applinks: { apps: [], details } });
}

function androidAssetLinks(): Response {
  // Production SHA-256 fingerprints depend on the Play/App signing key and remain an external gate.
  return associationResponse([]);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    const nativeApiOnly = env.NATIVE_API_ONLY === "true";
    const appLinkHost = env.APP_LINK_HOST || ODIE_APP_LINK_HOST;
    if (url.hostname === appLinkHost && url.pathname === "/.well-known/apple-app-site-association") {
      return appleAppSiteAssociation(env.APPLE_APP_ID);
    }
    if (url.hostname === appLinkHost && url.pathname === "/.well-known/assetlinks.json") {
      return androidAssetLinks();
    }

    const download = nativeDownload(url.pathname);
    if (download && env.NATIVE_DOWNLOADS) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      if (req.method === "HEAD") {
        const object = await env.NATIVE_DOWNLOADS.head(download.key);
        return object
          ? nativeDownloadResponse(object, null, download.contentType)
          : new Response("Not Found", { status: 404 });
      }
      const object = await env.NATIVE_DOWNLOADS.get(download.key);
      return object
        ? nativeDownloadResponse(object, object.body, download.contentType)
        : new Response("Not Found", { status: 404 });
    }

    for (const key of Object.keys(env)) {
      if (!key.startsWith("GATEKEEPER_")) continue;
      const suffix = key.slice("GATEKEEPER_".length).toLowerCase().replaceAll("_", "-");
      const prefix = `/gatekeeper/${suffix}`;
      if (url.pathname === prefix || url.pathname.startsWith(prefix + "/")) {
        return (env[key] as Fetcher).fetch(req);
      }
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/") ||
        (url.pathname.startsWith("/native/oauth-start/") ||
          url.pathname.startsWith("/native/oauth-return/")) ||
        (!nativeApiOnly && (url.pathname === "/blueprint-screenshot" ||
          url.pathname.startsWith("/blueprint-screenshot/")))) {
      return env.WORKSHOP_BACKEND.fetch(req);
    }

    // The native gateway deliberately has no SPA/admin/static fallback. Its public origin exposes
    // only in-band-authorized RPC, one-time OAuth plumbing, installed gatekeepers, and association
    // documents; the Access-protected browser origin remains a separate defense-in-depth boundary.
    if (nativeApiOnly) return new Response("Not Found", { status: 404 });

    // Note: gatekeeper OAuth redirects land on the gatekeeper Workers themselves, at
    // `/gatekeeper/<name>/oauth` (handled by the loop above) — there are no backend /auth
    // callbacks.

    if (env.ASSETS) {
      return env.ASSETS.fetch(req);
    }

    // Dev only: with no assets binding here, everything else goes to the backend.
    //
    // In `run-local` mode the backend has a static `assets` binding configured (with
    // `run_worker_first` for the API routes), so it serves the pre-built single-page app for these
    // frontend requests. In normal dev mode the backend has no assets and frontend requests aren't
    // expected here -- run the Vite dev server with `pnpm dev-client` and open localhost:3000
    // directly instead. (We don't try to forward to localhost:3000 becaues it doesn't work well:
    // Vite's HMR socket gets disconnected every time wrangler restarts workerd.)
    return env.WORKSHOP_BACKEND.fetch(req);
  },

  async email(message, env) {
    if (!env.GATEKEEPER_EMAIL) {
      message.setReject("No email gatekeeper is installed on this instance.");
      return;
    }
    await env.GATEKEEPER_EMAIL.email(message);
  },
} satisfies ExportedHandler<Env>;
