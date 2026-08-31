import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageDirectory, "../..");
const configPath = resolve(packageDirectory, "src-tauri/tauri.conf.json");
const appPaths = [
  "gatekeeper-context/src/generated/app.txt",
  "gatekeeper-jarvis/src/generated/app.txt",
  "gatekeeper-scheduler/src/generated/app.txt",
  "gatekeeper-team-pi/src/generated/app.txt",
].map((path) => resolve(repositoryRoot, "packages", path));

const hashes = [];
for (const appPath of appPaths) {
  const html = await readFile(appPath, "utf8");
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const digest = createHash("sha256").update(match[1]).digest("base64");
    hashes.push(`'sha256-${digest}'`);
  }
}

const original = await readFile(configPath, "utf8");
const replacement = `script-src 'self' ${hashes.join(" ")};`;
const updated = original.replace(/script-src 'self'(?: '[^']+')*;/, replacement);
if (updated === original && !original.includes(replacement)) {
  throw new Error("Could not locate the native script-src directive.");
}
if (updated !== original) await writeFile(configPath, updated);
console.log(`Synced ${hashes.length} gatekeeper app CSP hashes.`);
