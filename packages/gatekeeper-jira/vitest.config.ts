import { fileURLToPath } from "node:url";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [capnwebValidate()],
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./__tests__/workers-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
  },
});
