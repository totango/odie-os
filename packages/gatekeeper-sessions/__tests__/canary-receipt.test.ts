import { describe, expect, it } from "vitest";
import { aggregateCanaryReceipts, createCanaryReceipt, validateCanaryReceipt } from "../canary/receipt.mjs";

const CHECKS = ["node", "javascript", "typescript", "terminal", "code-server", "cleanup"];
const provenance = {
  schemaVersion: 1,
  repository: "totango/odie-os",
  ref: "refs/heads/main",
  sourceSha: "a".repeat(40),
  workflowRunId: "123",
  ghcrImage: `ghcr.io/totango/odie-os-coding-session@sha256:${"b".repeat(64)}`,
  cloudflareImage: `registry.cloudflare.com/${"c".repeat(32)}/odie-os-coding-session@sha256:${"d".repeat(64)}`,
};

function receipt(instanceTier: string, workflowRunAttempt = "1") {
  return createCanaryReceipt(provenance, {
    ok: true, sourceSha: provenance.sourceSha, candidateImage: provenance.cloudflareImage,
    instanceTier, checks: CHECKS,
  }, { sourceSha: provenance.sourceSha, workflowRunId: provenance.workflowRunId,
    workflowRunAttempt, instanceTier });
}

describe("native canary receipts", () => {
  it("derives the exact per-tier schema from provenance and a strict response", () => {
    const value = receipt("standard-2", "3");
    expect(Object.keys(value)).toEqual([
      "schemaVersion", "repository", "ref", "sourceSha", "workflowRunId", "workflowRunAttempt",
      "instanceTier", "ghcrImage", "cloudflareImage", "checks",
    ]);
    expect(validateCanaryReceipt(value, provenance)).toBe(value);
    expect(value.workflowRunAttempt).toBe("3");
  });

  it("rejects response extras, noncanonical attempts and tier mismatch", () => {
    const response = { ok: true, sourceSha: provenance.sourceSha, candidateImage: provenance.cloudflareImage,
      instanceTier: "standard-1", checks: CHECKS };
    expect(() => createCanaryReceipt(provenance, { ...response, extra: true }, {
      sourceSha: provenance.sourceSha, workflowRunId: "123", workflowRunAttempt: "1", instanceTier: "standard-1",
    })).toThrow("exact schema");
    expect(() => createCanaryReceipt(provenance, response, {
      sourceSha: provenance.sourceSha, workflowRunId: "123", workflowRunAttempt: "01", instanceTier: "standard-1",
    })).toThrow("attempt");
    expect(() => createCanaryReceipt(provenance, response, {
      sourceSha: provenance.sourceSha, workflowRunId: "123", workflowRunAttempt: "1", instanceTier: "standard-2",
    })).toThrow("does not match");
  });

  it("selects the highest agreeing attempt for every exact tier", () => {
    const values = [receipt("standard-1"), receipt("standard-2", "2"), receipt("standard-3"),
      receipt("standard-4"), receipt("standard-2", "10")];
    const aggregate = aggregateCanaryReceipts(provenance, values);
    expect(aggregate.tiers).toEqual([
      { instanceTier: "standard-1", workflowRunAttempt: "1" },
      { instanceTier: "standard-2", workflowRunAttempt: "10" },
      { instanceTier: "standard-3", workflowRunAttempt: "1" },
      { instanceTier: "standard-4", workflowRunAttempt: "1" },
    ]);
    expect(Object.keys(aggregate)).toEqual([
      "schemaVersion", "repository", "ref", "sourceSha", "workflowRunId", "ghcrImage",
      "cloudflareImage", "checks", "tiers",
    ]);
  });

  it("rejects duplicate tier-attempt receipts even when their bytes agree", () => {
    expect(() => aggregateCanaryReceipts(provenance, [
      receipt("standard-1"), receipt("standard-1"), receipt("standard-2"),
      receipt("standard-3"), receipt("standard-4"),
    ])).toThrow("Duplicate standard-1 attempt receipt");
  });

  it("rejects missing, unknown and conflicting tier receipts", () => {
    expect(() => aggregateCanaryReceipts(provenance, [receipt("standard-1"), receipt("standard-2"),
      receipt("standard-3")])).toThrow("Missing");
    expect(() => validateCanaryReceipt({ ...receipt("standard-1"), instanceTier: "standard-5" }, provenance))
      .toThrow("tier");
    expect(() => validateCanaryReceipt({ ...receipt("standard-1"), unexpected: true }, provenance))
      .toThrow("exact schema");
    expect(() => aggregateCanaryReceipts(provenance, [receipt("standard-1"), receipt("standard-2"),
      receipt("standard-3"), receipt("standard-4"), { ...receipt("standard-4", "2"), checks: [] }]))
      .toThrow("does not agree");
  });
});
