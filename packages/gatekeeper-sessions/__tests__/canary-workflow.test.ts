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
