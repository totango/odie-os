import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CANARY_TIERS, validateProvenance } from "./config.mjs";

const CHECKS = ["node", "javascript", "typescript", "terminal", "code-server", "cleanup"];
const RECEIPT_KEYS = [
  "schemaVersion", "repository", "ref", "sourceSha", "workflowRunId", "workflowRunAttempt",
  "instanceTier", "ghcrImage", "cloudflareImage", "checks",
];
const AGGREGATE_KEYS = [
  "schemaVersion", "repository", "ref", "sourceSha", "workflowRunId", "ghcrImage",
  "cloudflareImage", "checks", "tiers",
];
const MAX_JSON_BYTES = 16 * 1024;

/** Creates a canonical per-tier receipt from validated provenance and Worker response data. */
export function createCanaryReceipt(provenance, response, expected) {
  validateProvenance(provenance, {
    sourceSha: expected.sourceSha,
    workflowRunId: expected.workflowRunId,
    ghcrImage: provenance.ghcrImage,
    cloudflareImage: provenance.cloudflareImage,
  });
  requireAttempt(expected.workflowRunAttempt);
  requireTier(expected.instanceTier);
  validateWorkerResponse(response, {
    sourceSha: provenance.sourceSha,
    cloudflareImage: provenance.cloudflareImage,
    instanceTier: expected.instanceTier,
  });
  return {
    schemaVersion: 1,
    repository: provenance.repository,
    ref: provenance.ref,
    sourceSha: provenance.sourceSha,
    workflowRunId: provenance.workflowRunId,
    workflowRunAttempt: expected.workflowRunAttempt,
    instanceTier: response.instanceTier,
    ghcrImage: provenance.ghcrImage,
    cloudflareImage: provenance.cloudflareImage,
    checks: [...response.checks],
  };
}

/** Validates one exact per-tier receipt schema and candidate identity. */
export function validateCanaryReceipt(value, provenance) {
  exactKeys(value, RECEIPT_KEYS, "Canary receipt");
  if (value.schemaVersion !== 1 || value.repository !== provenance.repository || value.ref !== provenance.ref ||
      value.sourceSha !== provenance.sourceSha || value.workflowRunId !== provenance.workflowRunId ||
      value.ghcrImage !== provenance.ghcrImage || value.cloudflareImage !== provenance.cloudflareImage ||
      !sameChecks(value.checks)) throw new Error("Canary receipt does not agree with candidate provenance.");
  requireAttempt(value.workflowRunAttempt);
  requireTier(value.instanceTier);
  return value;
}

/** Aggregates recursive receipt artifacts, selecting the highest agreeing attempt for each tier. */
export function aggregateCanaryReceipts(provenance, receipts) {
  if (!Array.isArray(receipts) || receipts.length < CANARY_TIERS.length) throw new Error("Missing per-tier canary receipts.");
  const selected = [];
  for (const instanceTier of CANARY_TIERS) {
    const tierReceipts = receipts.map(value => validateCanaryReceipt(value, provenance))
      .filter(value => value.instanceTier === instanceTier);
    if (tierReceipts.length === 0) throw new Error(`Missing ${instanceTier} canary receipt.`);
    const attempts = new Set();
    for (const value of tierReceipts) {
      if (attempts.has(value.workflowRunAttempt)) {
        throw new Error(`Duplicate ${instanceTier} attempt receipt.`);
      }
      attempts.add(value.workflowRunAttempt);
    }
    const stable = JSON.stringify({ ...tierReceipts[0], workflowRunAttempt: undefined });
    if (tierReceipts.some(value => JSON.stringify({ ...value, workflowRunAttempt: undefined }) !== stable)) {
      throw new Error(`Conflicting ${instanceTier} canary receipts.`);
    }
    const highest = tierReceipts.reduce((left, right) =>
      BigInt(right.workflowRunAttempt) > BigInt(left.workflowRunAttempt) ? right : left);
    selected.push({ instanceTier, workflowRunAttempt: highest.workflowRunAttempt });
  }
  return {
    schemaVersion: 1,
    repository: provenance.repository,
    ref: provenance.ref,
    sourceSha: provenance.sourceSha,
    workflowRunId: provenance.workflowRunId,
    ghcrImage: provenance.ghcrImage,
    cloudflareImage: provenance.cloudflareImage,
    checks: [...CHECKS],
    tiers: selected,
  };
}

/** Validates the exact all-tier aggregate schema. */
export function validateAggregateReceipt(value, provenance) {
  exactKeys(value, AGGREGATE_KEYS, "Aggregate receipt");
  const expected = aggregateCanaryReceipts(provenance, value.tiers.map(entry => ({
    schemaVersion: 1, repository: value.repository, ref: value.ref, sourceSha: value.sourceSha,
    workflowRunId: value.workflowRunId, workflowRunAttempt: entry.workflowRunAttempt,
    instanceTier: entry.instanceTier, ghcrImage: value.ghcrImage, cloudflareImage: value.cloudflareImage,
    checks: value.checks,
  })));
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error("Aggregate receipt is not canonical.");
  return value;
}

function validateWorkerResponse(value, expected) {
  exactKeys(value, ["candidateImage", "checks", "instanceTier", "ok", "sourceSha"], "Worker response");
  if (value.ok !== true || value.sourceSha !== expected.sourceSha ||
      value.candidateImage !== expected.cloudflareImage || value.instanceTier !== expected.instanceTier ||
      !sameChecks(value.checks)) throw new Error("Worker response does not match the tier candidate.");
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify([...keys].toSorted())) {
    throw new Error(`${label} keys do not match the exact schema.`);
  }
}
function sameChecks(value) { return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(CHECKS); }
function requireTier(value) { if (!CANARY_TIERS.includes(value)) throw new Error("Invalid receipt instance tier."); }
function requireAttempt(value) { if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new Error("Invalid workflow run attempt."); }
function readJson(file) {
  if (statSync(file).size > MAX_JSON_BYTES) throw new Error("Receipt input is too large.");
  return JSON.parse(readFileSync(file, "utf8"));
}
function receiptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...receiptFiles(path));
    else if (entry.isFile() && entry.name === "canary-receipt.json") files.push(path);
    else throw new Error("Unexpected file in canary receipt artifacts.");
  }
  return files;
}
function args(values, names) {
  const allowed = new Set(names); const parsed = new Map();
  for (let i = 0; i < values.length; i += 2) {
    if (!allowed.has(values[i]) || values[i + 1] === undefined || parsed.has(values[i])) throw new Error("Invalid receipt arguments.");
    parsed.set(values[i], values[i + 1]);
  }
  if (parsed.size !== allowed.size) throw new Error("Missing receipt argument.");
  return parsed;
}
function env(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required.`); return value; }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2];
  if (command === "create") {
    const input = args(process.argv.slice(3), ["--provenance-file", "--response-file", "--tier", "--out"]);
    const receipt = createCanaryReceipt(readJson(input.get("--provenance-file")), readJson(input.get("--response-file")), {
      sourceSha: env("GITHUB_SHA"), workflowRunId: env("GITHUB_RUN_ID"),
      workflowRunAttempt: env("GITHUB_RUN_ATTEMPT"), instanceTier: input.get("--tier"),
    });
    writeFileSync(input.get("--out"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  } else if (command === "aggregate") {
    const input = args(process.argv.slice(3), ["--provenance-file", "--receipts-dir", "--out"]);
    const provenance = readJson(input.get("--provenance-file"));
    validateProvenance(provenance, {
      sourceSha: env("GITHUB_SHA"), workflowRunId: env("GITHUB_RUN_ID"),
      ghcrImage: provenance.ghcrImage, cloudflareImage: provenance.cloudflareImage,
    });
    const files = receiptFiles(input.get("--receipts-dir"));
    const receipt = aggregateCanaryReceipts(provenance, files.map(readJson));
    writeFileSync(input.get("--out"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  } else throw new Error("Expected create or aggregate command.");
}
