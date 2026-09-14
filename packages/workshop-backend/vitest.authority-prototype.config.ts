import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    main: "./__tests__/authority-prototype/worker.ts",
    remoteBindings: false,
    // The pool rewrites Wrangler's named self-service binding to its runner Worker.
    // Avoid importing the backend's undeclared transitive miniflare dependency.
    wrangler: {configPath: "./__tests__/authority-prototype/wrangler.jsonc"},
  })],
  test: {
    include: ["__tests__/authority-prototype/*.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
    testTimeout: 15_000,
  },
});
