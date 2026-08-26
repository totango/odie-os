import { readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROVENANCE_KEYS = [
  "schemaVersion", "repository", "ref", "sourceSha", "workflowRunId",
  "ghcrImage", "cloudflareImage",
];
export const CANARY_TIERS = ["standard-1", "standard-2", "standard-3", "standard-4"];
const CHECKS = ["node", "javascript", "typescript", "terminal", "code-server", "cleanup"];
const VERSIONS = JSON.parse(readFileSync(new URL("./versions.json", import.meta.url), "utf8"));
const MAX_DIGEST_FILE_BYTES = 512;
const MAX_PROVENANCE_FILE_BYTES = 16 * 1024;

/** Reads a digest file and requires one canonical image reference plus one newline. */
export function readExactImage(file, pattern, label) {
  if (statSync(file).size > MAX_DIGEST_FILE_BYTES) throw new Error(`${label} is too large.`);
  const content = readFileSync(file, "utf8");
  if (!pattern.test(content)) throw new Error(`${label} is not an exact immutable image reference.`);
  return content.slice(0, -1);
}

/** Validates the exact candidate source-provenance artifact schema. */
export function validateProvenance(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid provenance object.");
  const keys = Object.keys(value).toSorted();
  if (JSON.stringify(keys) !== JSON.stringify([...PROVENANCE_KEYS].toSorted())) {
    throw new Error("Provenance keys do not match the exact schema.");
  }
  if (value.schemaVersion !== 1 || value.repository !== "totango/odie-os" ||
      value.ref !== "refs/heads/main" || !/^[0-9a-f]{40}$/.test(value.sourceSha) ||
      !/^[1-9][0-9]*$/.test(value.workflowRunId) ||
      !/^ghcr\.io\/totango\/odie-os-coding-session@sha256:[0-9a-f]{64}$/.test(value.ghcrImage) ||
      !/^registry\.cloudflare\.com\/[0-9a-f]{32}\/odie-os-coding-session@sha256:[0-9a-f]{64}$/.test(value.cloudflareImage) ||
      value.sourceSha !== expected.sourceSha || value.workflowRunId !== expected.workflowRunId ||
      value.ghcrImage !== expected.ghcrImage || value.cloudflareImage !== expected.cloudflareImage) {
    throw new Error("Provenance does not describe this current-main candidate.");
  }
  return value;
}

/** Generates one isolated, tier-specific Wrangler config after exact provenance validation. */
export function generateCanaryConfig(input) {
  requireMatch(input.accountId, /^[0-9a-f]{32}$/, "CLOUDFLARE_ACCOUNT_ID");
  requireMatch(input.sourceSha, /^[0-9a-f]{40}$/, "source SHA");
  requireMatch(input.workflowRunId, /^[1-9][0-9]*$/, "workflow run ID");
  requireTier(input.instanceTier);
  const workerName = `odie-coding-canary-${input.workflowRunId}-${input.instanceTier}`;
  const applicationName = `${workerName}-container`;
  for (const [label, name] of [["Worker", workerName], ["container application", applicationName]]) {
    if (name.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
      throw new Error(`${label} name is not DNS-safe.`);
    }
  }
  const cloudflarePattern = new RegExp(
    `^registry\\.cloudflare\\.com\\/${input.accountId}\\/odie-os-coding-session@sha256:[0-9a-f]{64}$`,
  );
  if (!cloudflarePattern.test(input.cloudflareImage)) throw new Error("Cloudflare image is not canonical.");
  if (!/^ghcr\.io\/totango\/odie-os-coding-session@sha256:[0-9a-f]{64}$/.test(input.ghcrImage)) {
    throw new Error("GHCR image is not canonical.");
  }
  const main = resolve(input.workspace, "packages/gatekeeper-sessions/canary/worker.ts");
  if (!isAbsolute(main)) throw new Error("Canary entrypoint must be absolute.");
  return {
    workerName,
    applicationName,
    reportChecks: CHECKS,
    config: {
      name: workerName,
      main,
      compatibility_date: "2026-02-02",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: true,
      preview_urls: false,
      vars: {
        SOURCE_SHA: input.sourceSha,
        CANDIDATE_IMAGE: input.cloudflareImage,
        EXPECTED_NODE_VERSION: VERSIONS.node,
        INSTANCE_TIER: input.instanceTier,
      },
      containers: [{
        name: applicationName,
        class_name: "CodingSessionImageCanarySandbox",
        image: input.cloudflareImage,
        instance_type: input.instanceTier,
        max_instances: 1,
      }],
      durable_objects: { bindings: [{
        name: "CANARY_SANDBOX", class_name: "CodingSessionImageCanarySandbox",
      }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["CodingSessionImageCanarySandbox"] }],
      observability: { enabled: true, head_sampling_rate: 1, logs: { invocation_logs: false } },
    },
  };
}

function provenanceCommand(args, env) {
  const accountId = required(env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");
  requireMatch(accountId, /^[0-9a-f]{32}$/, "CLOUDFLARE_ACCOUNT_ID");
  const ghcrImage = readExactImage(required(args.get("--ghcr-file"), "--ghcr-file"),
    /^ghcr\.io\/totango\/odie-os-coding-session@sha256:[0-9a-f]{64}\n$/, "GHCR digest");
  const cloudflareImage = readExactImage(required(args.get("--cloudflare-file"), "--cloudflare-file"),
    new RegExp(`^registry\\.cloudflare\\.com\\/${accountId}\\/odie-os-coding-session@sha256:[0-9a-f]{64}\\n$`),
    "Cloudflare digest");
  const provenance = {
    schemaVersion: 1,
    repository: required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY"),
    ref: required(env.GITHUB_REF, "GITHUB_REF"),
    sourceSha: required(env.GITHUB_SHA, "GITHUB_SHA"),
    workflowRunId: required(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
    ghcrImage,
    cloudflareImage,
  };
  validateProvenance(provenance, provenance);
  writeFileSync(required(args.get("--out"), "--out"), `${JSON.stringify(provenance, null, 2)}\n`);
}

function generateCommand(args, env) {
  const accountId = required(env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");
  requireMatch(accountId, /^[0-9a-f]{32}$/, "CLOUDFLARE_ACCOUNT_ID");
  const sourceSha = required(env.GITHUB_SHA, "GITHUB_SHA");
  const workflowRunId = required(env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  const workspace = resolve(required(env.GITHUB_WORKSPACE, "GITHUB_WORKSPACE"));
  const runnerTemp = resolve(required(env.RUNNER_TEMP, "RUNNER_TEMP"));
  const out = resolve(required(args.get("--out"), "--out"));
  const relativeOut = relative(runnerTemp, out);
  if (relativeOut.startsWith("..") || isAbsolute(relativeOut)) throw new Error("Canary config must be in RUNNER_TEMP.");
  const ghcrImage = readExactImage(required(args.get("--ghcr-file"), "--ghcr-file"),
    /^ghcr\.io\/totango\/odie-os-coding-session@sha256:[0-9a-f]{64}\n$/, "GHCR digest");
  const cloudflareImage = readExactImage(required(args.get("--cloudflare-file"), "--cloudflare-file"),
    new RegExp(`^registry\\.cloudflare\\.com\\/${accountId}\\/odie-os-coding-session@sha256:[0-9a-f]{64}\\n$`),
    "Cloudflare digest");
  const provenanceFile = required(args.get("--provenance-file"), "--provenance-file");
  if (statSync(provenanceFile).size > MAX_PROVENANCE_FILE_BYTES) throw new Error("Provenance file is too large.");
  const provenance = JSON.parse(readFileSync(provenanceFile, "utf8"));
  validateProvenance(provenance, { sourceSha, workflowRunId, ghcrImage, cloudflareImage });
  const instanceTier = required(args.get("--tier"), "--tier");
  const generated = generateCanaryConfig({
    accountId, sourceSha, workflowRunId, instanceTier, workspace, ghcrImage, cloudflareImage,
  });
  writeFileSync(out, `${JSON.stringify(generated.config, null, 2)}\n`, { mode: 0o600 });
}

export function parseArgs(values, allowed) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!allowed.has(name) || value === undefined) throw new Error("Unknown or malformed argument.");
    if (result.has(name)) throw new Error(`Duplicate argument ${name}.`);
    result.set(name, value);
  }
  if (result.size !== allowed.size) throw new Error("Missing required argument.");
  return result;
}

export function requireTier(value) {
  if (!CANARY_TIERS.includes(value)) throw new Error("instance tier is invalid.");
  return value;
}

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function requireMatch(value, pattern, name) {
  if (!pattern.test(value)) throw new Error(`${name} is invalid.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2];
  if (command === "provenance") provenanceCommand(parseArgs(process.argv.slice(3),
    new Set(["--ghcr-file", "--cloudflare-file", "--out"])), process.env);
  else if (command === "generate") generateCommand(parseArgs(process.argv.slice(3),
    new Set(["--ghcr-file", "--cloudflare-file", "--provenance-file", "--tier", "--out"])), process.env);
  else throw new Error("Expected provenance or generate command.");
}
