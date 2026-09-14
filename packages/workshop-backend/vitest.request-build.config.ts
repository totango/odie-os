import { defineConfig } from "vitest/config";

/** Node hosts Miniflare/mock GitHub; actual backend/Sessions run over native workerd bindings. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/request-build/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
