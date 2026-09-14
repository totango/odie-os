import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  plugins: [cloudflareTest({
    main: "./__tests__/authority-native-matrix/worker.ts",
    remoteBindings: false,
    wrangler: {configPath: "./__tests__/authority-native-matrix/wrangler.jsonc"},
    miniflare: {
      outboundService() { throw new Error("MATRIX_EXTERNAL_EGRESS_DENIED"); },
    },
  })],
  test: {
    include: ["__tests__/authority-native-matrix/matrix.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
    testTimeout: 15_000,
  },
});
