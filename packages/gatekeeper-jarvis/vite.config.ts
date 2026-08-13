import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
function emitAppText(): Plugin {
  return { name: "emit-app-text", closeBundle() {
    const html = readFileSync(resolve(packageDirectory, "dist-app/app/index.html"), "utf8");
    const output = resolve(packageDirectory, "src/generated/app.txt");
    const contents = "<!-- Generated from packages/gatekeeper-jarvis/app. Do not edit. -->\n" + html;
    if (existsSync(output) && readFileSync(output, "utf8") === contents) return;
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, contents);
  }};
}

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), emitAppText()],
  build: { outDir: "dist-app", emptyOutDir: true, cssCodeSplit: false,
    assetsInlineLimit: 100_000_000, rollupOptions: { input: "app/index.html" } },
});
