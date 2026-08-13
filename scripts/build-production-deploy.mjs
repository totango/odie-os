#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { collectModules } from "./release/hash-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND_DIST = join(ROOT, "packages", "workshop-frontend", "dist");
const WORKERS = [
  "gatekeeper-context",
  "gatekeeper-github",
  "gatekeeper-jarvis",
  "gatekeeper-scheduler",
  "gatekeeper-team-pi",
  "gatekeeper-sessions",
  "workshop-backend",
  "router",
];
const ALLOWED_CONFIG_KEYS = new Set([
  "$schema", "ai", "assets", "browser", "build", "compatibility_date",
  "compatibility_flags", "containers", "durable_objects", "kv_namespaces", "main",
  "migrations", "name", "observability", "preview_urls", "r2_buckets", "rules", "services",
  "vars", "worker_loaders", "workers_dev",
]);

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--out") {
    throw new Error("usage: build-production-deploy.mjs --out <directory>");
  }
  return resolve(argv[1]);
}

function runWrangler(packageDir, configPath, outDir) {
  execFileSync("pnpm", [
    "exec", "wrangler", "deploy", "--dry-run", "--outdir", outDir,
    "--config", configPath,
  ], { cwd: packageDir, stdio: "inherit" });
}

function validateOutputDir(outputDir) {
  const allowedRoots = [ROOT, resolve(tmpdir())];
  if (outputDir === ROOT || outputDir === resolve(homedir()) || outputDir === resolve("/")) {
    throw new Error(`refusing unsafe output directory: ${outputDir}`);
  }
  if (!allowedRoots.some(root => outputDir.startsWith(root + "/"))) {
    throw new Error(`output directory must be under the repository or system temp directory`);
  }
}

function validateConfig(config, configPath) {
  const unsupported = Object.keys(config).filter(key => !ALLOWED_CONFIG_KEYS.has(key));
  if (unsupported.length) {
    throw new Error(`${configPath} has unsupported keys: ${unsupported.join(", ")}`);
  }
  if (config.preview_urls !== false) {
    throw new Error(`${configPath} must disable preview_urls`);
  }
}

function main() {
  const outputDir = parseArgs(process.argv.slice(2));
  validateOutputDir(outputDir);
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  for (const packageName of WORKERS) {
    const packageDir = join(ROOT, "packages", packageName);
    const configPath = join(packageDir, "wrangler.odie-os-production.jsonc");
    const workerDir = join(outputDir, packageName);
    mkdirSync(workerDir, { recursive: true });
    runWrangler(packageDir, configPath, workerDir);

    const config = parse(readFileSync(configPath, "utf8"));
    validateConfig(config, configPath);
    const { mainModule } = collectModules(workerDir);
    delete config.$schema;
    delete config.build;
    config.main = `./${mainModule}`;

    if (packageName === "router") {
      cpSync(FRONTEND_DIST, join(workerDir, "assets"), { recursive: true });
      config.assets.directory = "./assets";
    }

    writeFileSync(join(workerDir, "wrangler.json"), JSON.stringify(config, null, 2) + "\n");
    console.log(`prepared ${relative(ROOT, workerDir)}`);
  }
}

main();
