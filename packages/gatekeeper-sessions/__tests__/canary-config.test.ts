import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateCanaryConfig, parseArgs, readExactImage, validateProvenance } from "../canary/config.mjs";

const ACCOUNT = "a".repeat(32);
const DIGEST = "b".repeat(64);
const SHA = "c".repeat(40);
const GHCR = `ghcr.io/totango/odie-os-coding-session@sha256:${DIGEST}`;
const CLOUDFLARE = `registry.cloudflare.com/${ACCOUNT}/odie-os-coding-session@sha256:${DIGEST}`;
const expected = {
  sourceSha: SHA, workflowRunId: "12345",
  ghcrImage: GHCR, cloudflareImage: CLOUDFLARE,
};
const provenance = {
  schemaVersion: 1, repository: "totango/odie-os", ref: "refs/heads/main", ...expected,
};

describe("native canary config", () => {
  it("generates one isolated tier-specific application", () => {
    const generated = generateCanaryConfig({
      accountId: ACCOUNT, sourceSha: SHA, workflowRunId: "12345", instanceTier: "standard-2",
      workspace: "/repo", ghcrImage: GHCR, cloudflareImage: CLOUDFLARE,
    });
    expect(generated.workerName).toBe("odie-coding-canary-12345-standard-2");
    expect(generated.applicationName).toBe("odie-coding-canary-12345-standard-2-container");
    expect(generated.config.containers).toEqual([expect.objectContaining({
      name: generated.applicationName, image: CLOUDFLARE, instance_type: "standard-2", max_instances: 1,
    })]);
    expect(generated.config.vars.INSTANCE_TIER).toBe("standard-2");
    expect(generated.config.vars.EXPECTED_NODE_VERSION).toBe("v24.14.0");
    expect(generated.config.durable_objects.bindings).toEqual([
      { name: "CANARY_SANDBOX", class_name: "CodingSessionImageCanarySandbox" },
    ]);
    expect(generated.config).not.toHaveProperty("services");
    expect(JSON.stringify(generated.config)).not.toContain("SESSION_SANDBOX");
    expect(JSON.stringify(generated.config)).not.toContain("WORKSHOP_TOOLS");
  });

  it("requires the exact provenance schema and current-main identity", () => {
    expect(validateProvenance(provenance, expected)).toEqual(provenance);
    for (const changed of [
      { ...provenance, ref: "refs/tags/v1" },
      { ...provenance, repository: "fork/odie-os" },
      { ...provenance, sourceSha: "d".repeat(40) },
      { ...provenance, sourceSha: SHA.toUpperCase() },
      { ...provenance, workflowRunId: "01" },
      { ...provenance, extra: true },
    ]) expect(() => validateProvenance(changed, expected)).toThrow();
  });

  it("rejects non-canonical digest files", () => {
    const directory = mkdtempSync(join(tmpdir(), "canary-config-"));
    const file = join(directory, "digest.txt");
    const pattern = /^ghcr\.io\/totango\/odie-os-coding-session@sha256:[0-9a-f]{64}\n$/;
    writeFileSync(file, `${GHCR}
`);
    expect(readExactImage(file, pattern, "digest")).toBe(GHCR);
    for (const content of [GHCR, `${GHCR}

`, `${GHCR.toUpperCase()}
`, `${GHCR.slice(0, -1)}
`, `${GHCR}0
`]) {
      writeFileSync(file, content);
      expect(() => readExactImage(file, pattern, "digest")).toThrow();
    }
    writeFileSync(file, "x".repeat(513));
    expect(() => readExactImage(file, pattern, "digest")).toThrow("too large");
  });

  it("rejects unknown CLI flags", () => {
    expect(() => parseArgs(["--unknown", "x"], new Set(["--out"]))).toThrow("Unknown");
    expect(() => parseArgs(["--out", "a", "--out", "b"], new Set(["--out"]))).toThrow("Duplicate");
  });

  it("rejects malformed inputs and overlong derived names", () => {
    const base = { accountId: ACCOUNT, sourceSha: SHA, workflowRunId: "1", instanceTier: "standard-1", workspace: "/repo", ghcrImage: GHCR, cloudflareImage: CLOUDFLARE };
    expect(() => generateCanaryConfig({ ...base, accountId: ACCOUNT.toUpperCase() })).toThrow();
    expect(() => generateCanaryConfig({ ...base, sourceSha: `${SHA}0` })).toThrow();
    expect(() => generateCanaryConfig({ ...base, workflowRunId: "9".repeat(60) })).toThrow();
    expect(() => generateCanaryConfig({ ...base, instanceTier: "standard-5" })).toThrow();
    expect(() => generateCanaryConfig({ ...base, cloudflareImage: `${CLOUDFLARE}:tag` })).toThrow();
  });
});
