// Intentionally failing diagnostic, excluded from the normal backend and authority suites.
import { defineConfig } from "vitest/config";
import config from "./vitest.config";

export default defineConfig({
  ...config,
  test: { ...config.test, include: ["__tests__/compatibility-diagnostics/outer-unhandled.test.ts"] },
});
