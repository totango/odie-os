import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node" },
  resolve: {
    alias: {
      "cloudflare:workers": new URL("./__tests__/cloudflare-workers-shim.ts", import.meta.url).pathname,
      "capnweb-validate": new URL("./__tests__/capnweb-validate-shim.ts", import.meta.url).pathname,
    },
  },
});
