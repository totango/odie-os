import { createRequire } from 'node:module';
import { providerFixtureClaim } from './__tests__/admin-authority-fixture';
// Resolve the installed pool's own public Miniflare API, without adding/upgrading a dependency.
const require = createRequire(import.meta.resolve('@cloudflare/vitest-pool-workers'));
const { kCurrentWorker } = require('miniflare');
import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import capnwebValidate from 'capnweb-validate/vite'

const EXPECTED_RPC_REJECTIONS = new Set([
  'Collaborators requires an explicitly invited, verified @totango.com SSO collaborator.',
  'Finance workspaces are invite-only and do not support share links.',
  'Internal share links only support Gadget-only access.',
  // Losing concurrent decision in suspended-agent-resume.test.ts (also asserted by the caller).
  'Action is not pending: 99',
])

/**
 * Tests run inside workerd (via vitest-pool-workers) so they exercise the same runtime APIs as
 * production -- e.g. Uint8Array.toHex/fromHex and crypto.subtle used by the sharing module. Most
 * tests import modules directly; the main Worker and a test-only SQLite DO binding support the
 * Overseer cost-persistence integration test without loading the full deployment configuration.
 */
export default defineConfig({
  plugins: [
    capnwebValidate({ tsconfig: 'tsconfig.admin-authority-tests.json',
      include: ['src/**/*.ts', '__tests__/admin-authority-worker.ts'] }),
    // Actual provider consumers participate in the native-authority harness. Each transformer
    // owns only its package's source, using that provider's real TypeScript program.
    capnwebValidate({ cwd: new URL('../gatekeeper-context/', import.meta.url).pathname,
      tsconfig: 'tsconfig.json', include: ['src/**/*.ts'] }),
    capnwebValidate({ cwd: new URL('../gatekeeper-jarvis/', import.meta.url).pathname,
      tsconfig: 'tsconfig.json', include: ['src/**/*.ts'] }),
    cloudflareTest({
      main: './__tests__/admin-authority-worker.ts',
      miniflare: {
        compatibilityDate: '2026-02-02',
        // Production already permits storing native account references. The authority tests
        // persist actual accounts; revocation is enforced by current checks, not serialization.
        compatibilityFlags: ['experimental', 'nodejs_compat', 'allow_irrevocable_stub_storage'],
        bindings: {
          ADMINS: ['authority_admin_one', 'authority_admin_two', 'authority_admin_three', 'authority_admin_four'],
          TEAM_PI_CODEX_BASE_URL: 'https://team-pi.example/proxy',
          TEAM_PI_CODEX_HMAC_SECRET: 'team-pi-secret',
          TEAM_PI_CODEX_MODELS:
            'gpt-6-astra,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4,gpt-5.4-mini',
          TEAM_PI_CODEX_ONLY: 'true',
        },
        serviceBindings: {
          TEST_CONTEXT_FENCE_VENDOR: {name: kCurrentWorker, entrypoint: 'ContextFenceVendor', props: {sharingDomain: 'evidence-domain'}},
          TEST_JARVIS_FENCE_VENDOR: {name: kCurrentWorker, entrypoint: 'JarvisFenceVendor'},
          TEST_CONTEXT_AUTHORIZATION: {name: kCurrentWorker, entrypoint: 'AdminAuthorizationEntrypoint', props: {claim: providerFixtureClaim}},
          TEST_JARVIS_AUTHORIZATION: {name: kCurrentWorker, entrypoint: 'AdminAuthorizationEntrypoint', props: {claim: {...providerFixtureClaim, purpose: 'jarvis-policy'}}},
          TEST_JARVIS_REGRANTED: {name: kCurrentWorker, entrypoint: 'AdminAuthorizationEntrypoint', props: {claim: {...providerFixtureClaim, purpose: 'jarvis-policy', generation: 3}}},
          TEST_WRONG_EPOCH: {name: kCurrentWorker, entrypoint: 'AdminAuthorizationEntrypoint', props: {claim: {...providerFixtureClaim, epoch: 'wrong-epoch'}}},
          TEST_REQUEST_BUILD_SESSIONS: {name: kCurrentWorker, entrypoint: 'RequestBuildSessionsFixture'},
          TEST_REQUEST_BUILD_NOTIFIER: {name: kCurrentWorker, entrypoint: 'RequestBuildNotifierFixture'},
        },
        kvNamespaces: ['BLUEPRINTS', 'CONTEXT_COLLECTIONS'],
        durableObjects: {
          TEST_PENDING_LOGIN: { className: 'PendingLogin', useSQLite: true },
          TEST_OVERSEER: { className: 'OverseerDurableObject', useSQLite: true },
          TEST_USER: { className: 'UserDurableObject', useSQLite: true },
          TEST_ADMIN: { className: 'AdminSettings', useSQLite: true },
          TEST_AUTHORITY: { className: 'AdminAuthority', useSQLite: true },
          TEST_ADMIN_PROVIDERS: { className: 'AdminProviderTestHooks', useSQLite: true },
          TEST_CONTEXT_COLLECTIONS: { className: 'ContextCollectionDurableObject', useSQLite: true },
          TEST_USER_LIBRARIES: { className: 'UserLibraryDurableObject', useSQLite: true },
          TEST_LIBRARY_REGISTRIES: { className: 'LibraryRegistryDurableObject', useSQLite: true },
          TEST_JARVIS_POLICY: { className: 'JarvisPolicy', useSQLite: true },
          TEST_COMMUNITY_REQUESTS: { className: 'CommunityRequests', useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ['__tests__/*.test.ts'],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ['../../scripts/assert-workerd.ts'],
    // Cap'n Web reports a rejected future capability independently from the awaited RPC promise.
    // The policy tests assert these exact denials; unrelated unhandled errors remain fatal.
    onUnhandledError(error) {
      if (EXPECTED_RPC_REJECTIONS.has(error.message)) return false
    },
  },
})
