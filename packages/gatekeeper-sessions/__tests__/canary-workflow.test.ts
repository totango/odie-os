import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(import.meta.dirname, "../../../.github/workflows/publish-coding-session-image.yml"),
  "utf8",
);

describe("native canary workflow cleanup", () => {
  it("always runs its destructive exact-resource step with dependency-independent deletes", () => {
    const cleanup = workflow.slice(workflow.indexOf("  cleanup:"));
    expect(cleanup).toContain("- name: Delete exact tier container application and Worker, then prove absence\n        if: ${{ always() }}");
    expect(cleanup).toContain("--request DELETE");
    expect(cleanup).toContain("/containers/applications/$application_id");
    expect(cleanup).toContain("/workers/services/$worker?force=true");
    expect(cleanup).toContain("node scripts/coding-session-canary-applications.mjs");
    expect(cleanup).not.toContain("wrangler containers list");
    expect(cleanup).not.toContain("pnpm exec wrangler delete");
  });

  it("uses stable run-and-tier names and least privilege", () => {
    expect(workflow).toContain("attempt-${{ github.run_attempt }}");
    expect(workflow).toContain('worker="odie-coding-canary-${GITHUB_RUN_ID}-${INSTANCE_TIER}"');
    expect(workflow).toContain("instanceTier: [standard-1, standard-2, standard-3, standard-4]");
    expect(workflow.match(/max-parallel: 1/g)).toHaveLength(2);
    expect(workflow.match(/fail-fast: false/g)).toHaveLength(2);
    expect(workflow).toContain("  publish:\n    permissions:");
    expect(workflow).toContain("packages: write");
    const cleanup = workflow.slice(workflow.indexOf("  cleanup:"));
    expect(cleanup).toContain("permissions:\n      contents: read");
    expect(cleanup).not.toContain("packages: write");
  });

  it("preflights the runtime idempotently before the one-shot invocation", () => {
    const preflight = workflow.slice(
      workflow.indexOf("      - name: Preflight isolated tier runtime before one-shot claim"),
      workflow.indexOf("      - name: Invoke, validate and record tier canary"),
    );
    expect(preflight).toContain("for attempt in 1 2 3; do");
    expect(preflight).toContain("--max-time 120 --max-filesize 4096");
    expect(preflight).toContain('"https://${worker}.odie-os.workers.dev/ready"');
    expect(preflight).toContain('keys == ["candidateImage", "instanceTier", "ok", "ready", "sourceSha"]');
    expect(preflight).toContain(".ok == true and .ready == true");
    expect(preflight).toContain('if [ "$attempt" != 3 ]; then sleep 5; fi');
    expect(preflight.match(/curl/g)).toHaveLength(1);
    expect(preflight).not.toContain('cat "$result"');
  });

  it("captures the canary response without printing its body and validates closed schemas", () => {
    const invocation = workflow.slice(
      workflow.indexOf("      - name: Invoke, validate and record tier canary"),
      workflow.indexOf("  cleanup:"),
    );
    expect(invocation).toContain("for attempt in 1 2 3 4 5 6; do");
    expect(invocation).toContain('if [[ "$http_status" != 401 && "$http_status" != 404 ]] || [ "$attempt" = 6 ]; then break; fi');
    expect(invocation).toContain("sleep 5");
    expect(invocation.match(/curl/g)).toHaveLength(1);
    expect(invocation).toContain("--max-time 600 --max-filesize 4096");
    expect(invocation).toContain('--output "$result"');
    expect(invocation).toContain("--write-out '%{http_code}'");
    expect(invocation).not.toContain("--fail-with-body");
    expect(invocation).toContain('keys == ["candidateImage", "checks", "instanceTier", "ok", "sourceSha"]');
    expect(invocation).toContain('keys == ["failureStage", "ok"]');
    expect(invocation).toContain('IN("node", "javascript", "typescript", "terminal", "code-server", "cleanup", "lifecycle")');
    expect(invocation).toContain("failed at stage: %s");
    expect(invocation).not.toContain('cat "$result"');
  });

  it("gates the exact all-tier receipt on both matrix aggregates", () => {
    const receipt = workflow.slice(workflow.indexOf("  receipt:"));
    expect(receipt).toContain("needs: [publish, canary, cleanup]");
    expect(receipt).toContain("needs.canary.result == 'success'");
    expect(receipt).toContain("needs.cleanup.result == 'success'");
    expect(receipt).toContain("receipt.mjs aggregate");
    expect(receipt).toContain("coding-session-all-tier-canary-receipt-${{ github.sha }}-attempt-${{ github.run_attempt }}");
  });

  it("requires the current BuildKit SLSA v1 provenance contract", () => {
    expect(workflow).toContain("https://slsa.dev/provenance/v1");
    expect(workflow).toContain(".SLSA).buildDefinition.buildType");
    expect(workflow).toContain(
      "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
    );
    expect(workflow).not.toContain("https://slsa.dev/provenance/v0.2");
    expect(workflow).not.toContain("https://mobyproject.org/buildkit@v1");
  });
});
