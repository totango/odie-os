import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [capnwebValidate(), cloudflareTest({
    main: "./src/index.ts",
    miniflare: {
      compatibilityDate: "2026-02-02",
      compatibilityFlags: ["nodejs_compat", "allow_irrevocable_stub_storage"],
      durableObjects: {
        TEST_CONTEXT_COLLECTIONS: { className: "ContextCollectionDurableObject", useSQLite: true },
        TEST_LIBRARY_REGISTRIES: { className: "LibraryRegistryDurableObject", useSQLite: true },
      },
      kvNamespaces: ["CONTEXT_COLLECTIONS"],
    },
  })],
  test: {
    fileParallelism: false,
    exclude: ["__tests__/vite-config.test.ts"],
    include: ["__tests__/*.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
