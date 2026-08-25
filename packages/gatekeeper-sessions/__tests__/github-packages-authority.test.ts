import { describe, expect, it } from "vitest";
import {
  githubPackagesAuthorityManifest,
  validateGitHubPackagesAuthorityManifest,
} from "../src/github-packages-authority.js";

describe("inert GitHub Packages authority evidence", () => {
  it("records only the two exact artifacts audited from the pinned Agentic lockfile", () => {
    const authority = githubPackagesAuthorityManifest();

    expect(authority).toEqual({
      complete: false,
      available: false,
      unavailableReason:
        "GitHub Packages transport limits, redirects, response behavior, and credential support have not been verified.",
      source: {
        repository: "totango/agentic",
        revision: "04afee2b1e21233f155841f553946204847c3fda",
        lockfilePath: "pnpm-lock.yaml",
        lockfileGitBlob: "5b81e0ef0f033bbfe78c66326b37377483f0a1c6",
      },
      artifacts: [
        {
          name: "@totango/posthog-unified-tracking",
          version: "0.1.0-alpha.3",
          integrity:
            "sha512-wLLYP+plaVkVdcmvcOVir+8cyjKoghENubEgPaqtvUCq5kCcK6U8wly11O+QrNfJBWF+L66Hd6/0CG6JJqftvg==",
          sha512Hex:
            "c0b2d83fea6569591575c9af70e562afef1cca32a882110db9b1203daaadbd40aae6409c2ba53cc25cb5d4ef90acd7c905617e2fae8777aff4086e8926a7edbe",
          tarballPath:
            "/download/@totango/posthog-unified-tracking/0.1.0-alpha.3/bfa5d74bd835880f55e287dd7127dc74dc1e36c3",
          opaqueTarballId: "bfa5d74bd835880f55e287dd7127dc74dc1e36c3",
          importers: [{
            path: "backend/api",
            dependencyType: "dependencies",
            specifier: "0.1.0-alpha.3",
          }],
          engines: { node: "^24.14.0", pnpm: ">=10.22.0" },
        },
        {
          name: "@totango/unison-core",
          version: "0.1.6",
          integrity:
            "sha512-dc6bLCa19UBtWrBLwVZVVkFZ4rb5WMZDhCtTi7Mhm0aZRGJJWcdsrhzCYltbz5gUcWUdfIhAxkhtUaWxsAErEw==",
          sha512Hex:
            "75ce9b2c26b5f5406d5ab04bc15655564159e2b6f958c643842b538bb3219b469944624959c76cae1cc2625b5bcf981471651d7c8840c6486d51a5b1b0012b13",
          tarballPath:
            "/download/@totango/unison-core/0.1.6/1f2ca9df79a350ec556a4d84c52aa7a5947b2c15",
          opaqueTarballId: "1f2ca9df79a350ec556a4d84c52aa7a5947b2c15",
          importers: [{
            path: "backend/langgraph",
            dependencyType: "dependencies",
            specifier: "0.1.6",
          }],
          engines: null,
        },
      ],
      transport: {
        maxTarballBytes: null,
        redirectHosts: null,
        redirectStatuses: null,
        contentTypes: null,
        rangeBehavior: null,
        credentialContract: null,
      },
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.artifacts)).toBe(true);
    expect(authority.artifacts.every(artifact =>
      Object.isFrozen(artifact) && Object.isFrozen(artifact.importers))).toBe(true);
    const detached = githubPackagesAuthorityManifest();
    expect(detached).not.toBe(authority);
    expect(detached.artifacts[0]).not.toBe(authority.artifacts[0]);
  });

  it("proves each canonical base64 SHA-512 integrity decodes to the audited hex", () => {
    const authority = githubPackagesAuthorityManifest();

    for (const artifact of authority.artifacts) {
      const decoded = Buffer.from(artifact.integrity.slice("sha512-".length), "base64");
      expect(decoded).toHaveLength(64);
      expect(decoded.toString("hex")).toBe(artifact.sha512Hex);
    }
  });

  it("rejects canonical alternatives and extra keys outside the exact audited allowlist", () => {
    const cases: Array<(value: ReturnType<typeof githubPackagesAuthorityManifest>) => void> = [
      value => { value.source.revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; },
      value => { value.source.lockfileGitBlob = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; },
      value => {
        Object.assign(value.artifacts[0]!, {
          name: "@totango/other-package",
          tarballPath:
            "/download/@totango/other-package/0.1.0-alpha.3/bfa5d74bd835880f55e287dd7127dc74dc1e36c3",
        });
      },
      value => {
        Object.assign(value.artifacts[0]!, {
          version: "0.1.1",
          tarballPath:
            "/download/@totango/posthog-unified-tracking/0.1.1/bfa5d74bd835880f55e287dd7127dc74dc1e36c3",
        });
        value.artifacts[0]!.importers[0]!.specifier = "0.1.1";
      },
      value => {
        Object.assign(value.artifacts[0]!, {
          opaqueTarballId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          tarballPath:
            "/download/@totango/posthog-unified-tracking/0.1.0-alpha.3/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        });
      },
      value => {
        value.artifacts[0]!.integrity = value.artifacts[1]!.integrity;
        value.artifacts[0]!.sha512Hex = value.artifacts[1]!.sha512Hex;
      },
      value => { value.artifacts[0]!.importers[0]!.path = "backend/other"; },
      value => { value.artifacts[0]!.engines!.node = "^24.15.0"; },
      value => { Object.assign(value, { unavailableReason: "Still unavailable for another reason." }); },
      value => { Object.assign(value.source, { extra: null }); },
      value => { Object.assign(value.artifacts[0]!, { extra: null }); },
      value => { Object.assign(value.artifacts[0]!.importers[0]!, { extra: null }); },
      value => { Object.assign(value.artifacts[0]!.engines!, { extra: null }); },
      value => { Object.assign(value.transport, { extra: null }); },
    ];

    for (const corrupt of cases) {
      const value = structuredClone(githubPackagesAuthorityManifest());
      corrupt(value);
      expect(() => validateGitHubPackagesAuthorityManifest(value)).toThrow();
    }
  });
});
