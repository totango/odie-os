import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(fileURLToPath(import.meta.url), "..");
execFileSync("pnpm", ["exec", "vite", "build", "-c", "vite.config.ts"], {
  cwd: packageDirectory,
  stdio: "inherit",
});
