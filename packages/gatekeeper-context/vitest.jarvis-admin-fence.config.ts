// Run JARVIS's provider-only native fixture with the already-installed Context workerd toolchain.
// JARVIS's ordinary unit suite uses Vitest 3/Node; no dependency/runtime version is changed here.
import { createRequire } from "node:module";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
const { kCurrentWorker } = createRequire(import.meta.resolve("@cloudflare/vitest-pool-workers"))("miniflare");

export default defineConfig({
  root: new URL("./", import.meta.url).pathname,
  resolve: {alias: [{find: /^vitest$/, replacement: new URL("./node_modules/vitest/dist/index.js", import.meta.url).pathname}]},
  plugins: [
    capnwebValidate({cwd: new URL("../gatekeeper-jarvis/", import.meta.url).pathname, tsconfig: "tsconfig.json", include: ["src/**/*.ts"]}),
    cloudflareTest({
      main: new URL("../gatekeeper-jarvis/src/index.ts", import.meta.url).pathname,
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["nodejs_compat", "allow_irrevocable_stub_storage"],
        serviceBindings: {TEST_JARVIS_FENCE_VENDOR: {name: kCurrentWorker, entrypoint: "GatekeeperVendor"}},
        durableObjects: {TEST_JARVIS_FENCE_POLICY: {className: "JarvisPolicy", useSQLite: true}},
      },
    }),
  ],
  test: {include: ["../gatekeeper-jarvis/__tests__/admin-fence.worker.test.ts"], setupFiles: ["../../scripts/assert-workerd.ts"]},
});
