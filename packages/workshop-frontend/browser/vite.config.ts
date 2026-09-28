import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/**
 * A separate, loopback-only entry point. Never imported by the production app/config;
 * deliberately no router plugin, backend proxy, public assets, or build support.
 */
export default defineConfig(({ command }) => {
  if (command !== 'serve') throw new Error('Continuity fixtures are development-only')
  return {
    root: fileURLToPath(new URL('./fixture', import.meta.url)),
    publicDir: false,
    plugins: [react()],
    resolve: {
      alias: [{ find: /^capnweb$/, replacement: fileURLToPath(new URL('./fixture/session-ledger.ts', import.meta.url)) }],
    },
    server: { host: '127.0.0.1', port: 4179, strictPort: true },
  }
})
