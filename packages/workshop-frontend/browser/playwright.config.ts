import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  testDir: '.',
  // Keep outside Vitest's default *.test / *.spec discovery.
  testMatch: '*.pw.ts',
  outputDir: './test-results',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  use: {
    browserName: 'chromium',
    // Optional installed Chrome avoids downloading Chromium on developer machines.
    channel: process.env.CONTINUITY_BROWSER_CHANNEL || undefined,
    baseURL: 'http://127.0.0.1:4179',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite --config browser/vite.config.ts',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
