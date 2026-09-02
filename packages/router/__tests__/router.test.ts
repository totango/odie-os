import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import router, { type Env } from '../src/index';
// Imported as text so the config-integrity tests run inside workerd without filesystem access.
import wranglerConfigText from '../wrangler.jsonc?raw';
import productionWranglerConfigText from '../wrangler.odie-os-production.jsonc?raw';
import nativeProductionWranglerConfigText from '../wrangler.odie-os-native-production.jsonc?raw';

function stubFetcher(label: string): Fetcher {
  return {
    fetch: async () => new Response(label),
  } as unknown as Fetcher;
}

function makeEnv(extra: Record<string, unknown> = {}): Env {
  return {
    WORKSHOP_BACKEND: stubFetcher('backend'),
    ...extra,
  } as Env;
}

async function route(env: Env, path: string, host = 'example.com'): Promise<string> {
  const req = new Request(`https://${host}${path}`);
  const res = await router.fetch!(req, env, {} as ExecutionContext);
  return res.text();
}

function stubBucket(objects: Record<string, { body: string; contentType: string }>): R2Bucket {
  const objectFor = (key: string) => {
    const object = objects[key];
    if (!object) return null;
    return {
      body: new Response(object.body).body,
      httpEtag: '"test-etag"',
      writeHttpMetadata(headers: Headers) {
        headers.set('content-type', object.contentType);
      },
    };
  };
  return {
    get: async (key: string) => objectFor(key),
    head: async (key: string) => objectFor(key),
  } as unknown as R2Bucket;
}

describe('router fetch', () => {
  it('routes /api, native OAuth launch, and /blueprint-screenshot prefixes to the backend', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/api')).toBe('backend');
    expect(await route(env, '/api/workshop')).toBe('backend');
    expect(await route(env, '/native/oauth-start/ticket')).toBe('backend');
    expect(await route(env, '/native/oauth-return/flow')).toBe('backend');
    expect(await route(env, '/blueprint-screenshot')).toBe('backend');
    expect(await route(env, '/blueprint-screenshot/abc')).toBe('backend');
  });

  it('does not treat /api-lookalike paths as backend routes', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/apiary')).toBe('assets');
    expect(await route(env, '/blueprint-screenshots')).toBe('assets');
  });

  it('routes /gatekeeper/<short> by scanning GATEKEEPER_* bindings', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_GOOGLE: stubFetcher('google'),
      GATEKEEPER_HOMEASSISTANT: stubFetcher('homeassistant'),
    });
    expect(await route(env, '/gatekeeper/google')).toBe('google');
    expect(await route(env, '/gatekeeper/google/oauth')).toBe('google');
    expect(await route(env, '/gatekeeper/homeassistant/foo')).toBe('homeassistant');
  });

  it('maps underscores in binding names to dashes in the path', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_MY_SERVICE: stubFetcher('my-service'),
    });
    expect(await route(env, '/gatekeeper/my-service')).toBe('my-service');
    expect(await route(env, '/gatekeeper/my-service/oauth')).toBe('my-service');
  });

  it('does not match gatekeeper prefixes on longer path segments', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_GOOGLE: stubFetcher('google'),
    });
    expect(await route(env, '/gatekeeper/googles')).toBe('assets');
  });

  it('serves verified-link association documents on the configured host', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(JSON.parse(await route(env, '/.well-known/apple-app-site-association', 'odie-os.odie-os.workers.dev'))).toEqual({ applinks: { apps: [], details: [] } });
    expect(JSON.parse(await route(env, '/.well-known/assetlinks.json', 'odie-os.odie-os.workers.dev'))).toEqual([]);

    const nativeEnv = makeEnv({
      NATIVE_API_ONLY: 'true',
      APP_LINK_HOST: 'odie-os-native-api.odie-os.workers.dev',
      APPLE_APP_ID: '66J7DJB93K.com.totango.odieos',
    });
    expect(JSON.parse(await route(nativeEnv, '/.well-known/apple-app-site-association', 'odie-os-native-api.odie-os.workers.dev'))).toEqual({
      applinks: {
        apps: [],
        details: [{
          appID: '66J7DJB93K.com.totango.odieos',
          paths: [
            '/admin', '/blueprints', '/context', '/explore', '/gatekeepers',
            '/getting-started', '/outputs', '/profile', '/providers', '/sessions',
            '/signup', '/workspaces', '/blueprint/*', '/gadget/*', '/gatekeepers/*',
            '/workspace/*', '/native/oauth-return/*',
          ],
        }],
      },
    });
    expect(await route(nativeEnv, '/.well-known/apple-app-site-association', 'odie-os.odie-os.workers.dev')).toBe('Not Found');
  });

  it('keeps a native gateway restricted to API, OAuth, installed gatekeepers, and association routes', async () => {
    const env = makeEnv({
      NATIVE_API_ONLY: 'true',
      APP_LINK_HOST: 'odie-os-native-api.odie-os.workers.dev',
      GATEKEEPER_GOOGLE: stubFetcher('google'),
    });
    expect(await route(env, '/api')).toBe('backend');
    expect(await route(env, '/native/oauth-start/ticket')).toBe('backend');
    expect(await route(env, '/native/oauth-return/flow')).toBe('backend');
    expect(await route(env, '/gatekeeper/google/oauth')).toBe('google');
    expect(await route(env, '/')).toBe('Not Found');
    expect(await route(env, '/admin')).toBe('Not Found');
    expect(await route(env, '/assets/main.js')).toBe('Not Found');
    expect(await route(env, '/blueprint-screenshot/abc')).toBe('Not Found');
  });

  it('serves only explicit native download objects from R2', async () => {
    const env = makeEnv({
      NATIVE_API_ONLY: 'true',
      NATIVE_DOWNLOADS: stubBucket({
        'mac/OdieOS-latest.dmg': { body: 'notarized-dmg', contentType: 'application/x-apple-diskimage' },
        'mac/OdieOS-latest.dmg.sha256': { body: 'checksum', contentType: 'text/plain' },
        'mac/OdieOS-latest.json': { body: '{"version":"1.0.0"}', contentType: 'application/json' },
        'mac/OdieOS-1.0.0.dmg': { body: 'versioned-dmg', contentType: 'application/x-apple-diskimage' },
      }),
    });
    expect(await route(env, '/downloads/mac/OdieOS-latest.dmg')).toBe('notarized-dmg');
    expect(await route(env, '/downloads/mac/OdieOS-latest.dmg.sha256')).toBe('checksum');
    expect(await route(env, '/downloads/mac/OdieOS-latest.json')).toBe('{"version":"1.0.0"}');
    const versioned = await router.fetch!(new Request('https://example.com/downloads/mac/OdieOS-1.0.0.dmg'), env, {} as ExecutionContext);
    expect(await versioned.text()).toBe('versioned-dmg');
    expect(versioned.headers.get('access-control-allow-origin')).toBe('*');
    const head = await router.fetch!(new Request('https://example.com/downloads/mac/OdieOS-1.0.0.dmg', { method: 'HEAD' }), env, {} as ExecutionContext);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(await route(env, '/downloads/mac/private.dmg')).toBe('Not Found');
    expect(await route(env, '/downloads/mac/OdieOS-1.0.0-beta.dmg')).toBe('Not Found');
  });

  it('serves everything else from ASSETS when the binding is present', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/')).toBe('assets');
    expect(await route(env, '/blueprints/123')).toBe('assets');
    expect(await route(env, '/gatekeeper/not-installed')).toBe('assets');
  });

  // Dev has no ASSETS binding: the backend serves the frontend from its own assets binding in
  // `run-local` mode, and in normal dev mode you open the Vite server on :3000 directly.
  it('falls through to the backend when ASSETS is absent', async () => {
    const env = makeEnv();
    expect(await route(env, '/')).toBe('backend');
    expect(await route(env, '/blueprints/123')).toBe('backend');
  });
});

describe('router email', () => {
  it('forwards to GATEKEEPER_EMAIL when bound', async () => {
    const received: unknown[] = [];
    const env = makeEnv({
      GATEKEEPER_EMAIL: { email: async (m: unknown) => { received.push(m); } },
    });
    const message = {} as ForwardableEmailMessage;
    await router.email!(message, env, {} as ExecutionContext);
    expect(received).toEqual([message]);
  });

  it('rejects mail when no email gatekeeper is installed', async () => {
    const rejections: string[] = [];
    const env = makeEnv();
    const message = {
      setReject: (reason: string) => { rejections.push(reason); },
    } as unknown as ForwardableEmailMessage;
    await router.email!(message, env, {} as ExecutionContext);
    expect(rejections).toHaveLength(1);
  });
});

// The deploy service renders customer instances from this config (via the release manifest), so
// the asset-routing contract must hold: worker-first prefixes cover every dynamic route, or asset
// 404 handling would swallow API and gatekeeper traffic.
describe('wrangler.jsonc contract', () => {
  const config = parse(wranglerConfigText);

  it('runs the worker first for API, screenshot, and gatekeeper prefixes', () => {
    const first: string[] = config.assets.run_worker_first;
    expect(first).toContain('/api');
    expect(first).toContain('/api/*');
    expect(first).toContain('/native/oauth-start/*');
    expect(first).toContain('/native/oauth-return/*');
    expect(first).toContain('/blueprint-screenshot');
    expect(first).toContain('/blueprint-screenshot/*');
    expect(first).toContain('/gatekeeper/*');
  });

  it('keeps native OAuth callbacks on the worker in production', () => {
    const production = parse(productionWranglerConfigText);
    expect(production.assets.run_worker_first).toContain('/native/oauth-return/*');
  });

  it('configures the production native gateway for the signed iOS app', () => {
    const nativeProduction = parse(nativeProductionWranglerConfigText);
    expect(nativeProduction.assets).toBeUndefined();
    expect(nativeProduction.vars).toMatchObject({
      NATIVE_API_ONLY: 'true',
      APP_LINK_HOST: 'odie-os-native-api.odie-os.workers.dev',
      APPLE_APP_ID: '66J7DJB93K.com.totango.odieos',
    });
  });

  it('serves the frontend as a single-page application', () => {
    expect(config.assets.not_found_handling).toBe('single-page-application');
    expect(config.assets.directory).toBe('../workshop-frontend/dist');
    expect(config.assets.binding).toBe('ASSETS');
  });

  it('binds the workshop backend', () => {
    expect(config.services).toContainEqual({
      binding: 'WORKSHOP_BACKEND',
      service: 'workshop-backend',
    });
  });
});
