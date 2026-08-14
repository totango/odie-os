import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./__tests__/cloudflare-workers.ts", import.meta.url)),
      "capnweb-validate": fileURLToPath(
        new URL("./__tests__/capnweb-validate.ts", import.meta.url)),
    },
  },
});
