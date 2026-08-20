import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinEntry } from "../../scripts/bin-entry.ts";
import { pnpmCommand } from "../../scripts/pnpm-command.ts";

const packageDirectory = resolve(fileURLToPath(import.meta.url), "..");
const watch = process.argv.includes("--watch");
const dev = process.argv.includes("--dev");

const viteArgs = ["build", "-c", "vite.app.config.ts", ...(watch ? ["--watch"] : [])];
const viteEntry = resolveBinEntry(packageDirectory, "vite");
const [command, argv] = viteEntry
  ? [process.execPath, [viteEntry, ...viteArgs]]
  : pnpmCommand(["exec", "vite", ...viteArgs]);

execFileSync(command, argv, {
  cwd: packageDirectory,
  stdio: "inherit",
  env: { ...process.env, GATEKEEPER_APP_UNMINIFIED: dev ? "true" : "false" },
});
