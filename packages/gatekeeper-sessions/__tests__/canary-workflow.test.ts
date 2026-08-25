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
    expect(cleanup).toContain("- name: Delete exact container application and Worker, then prove absence\n        if: ${{ always() }}");
    expect(cleanup).toContain("--request DELETE");
    expect(cleanup).toContain("/containers/applications/$application_id");
    expect(cleanup).toContain("/workers/services/$worker?force=true");
    expect(cleanup).toContain("node scripts/coding-session-canary-applications.mjs");
    expect(cleanup).not.toContain("wrangler containers list");
    expect(cleanup).not.toContain("pnpm exec wrangler delete");
  });

  it("uses stable run-only names and least privilege", () => {
    expect(workflow).not.toContain("GITHUB_RUN_ATTEMPT");
    expect(workflow).toContain('worker="odie-coding-canary-${GITHUB_RUN_ID}"');
    expect(workflow).toContain("  publish:\n    permissions:");
    expect(workflow).toContain("packages: write");
    const cleanup = workflow.slice(workflow.indexOf("  cleanup:"));
    expect(cleanup).toContain("permissions:\n      contents: read");
    expect(cleanup).not.toContain("packages: write");
  });

  it("captures the canary response without printing its body and validates closed schemas", () => {
    const invocation = workflow.slice(
      workflow.indexOf("      - name: Invoke and validate one-shot native canary"),
      workflow.indexOf("  cleanup:"),
    );
    expect(invocation).toContain("for attempt in 1 2 3 4 5 6; do");
    expect(invocation).toContain('if [[ "$http_status" != 401 && "$http_status" != 404 ]] || [ "$attempt" = 6 ]; then break; fi');
    expect(invocation).toContain("sleep 5");
    expect(invocation.match(/curl/g)).toHaveLength(1);
    expect(invocation).toContain("--max-filesize 4096");
    expect(invocation).toContain('--output "$result"');
    expect(invocation).toContain("--write-out '%{http_code}'");
    expect(invocation).not.toContain("--fail-with-body");
    expect(invocation).toContain('keys == ["candidateImage", "checks", "ok", "sourceSha"]');
    expect(invocation).toContain('keys == ["failureStage", "ok"]');
    expect(invocation).toContain('IN("node", "javascript", "typescript", "terminal", "code-server", "cleanup", "lifecycle")');
    expect(invocation).toContain("failed at stage: %s");
    expect(invocation).not.toContain('cat "$result"');
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
