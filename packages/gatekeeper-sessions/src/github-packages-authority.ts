/**
 * Server-private, inert evidence for the exact GitHub Packages artifacts locked by the audited
 * Agentic revision. This module grants no egress or credential authority.
 */

interface AuditedPackageImporter {
  path: string;
  dependencyType: "dependencies";
  specifier: string;
}

interface AuditedPackageEngines {
  node: string;
  pnpm: string;
}

interface AuditedGitHubPackage {
  name: `@${string}/${string}`;
  version: string;
  integrity: `sha512-${string}`;
  sha512Hex: string;
  tarballPath: string;
  opaqueTarballId: string;
  importers: AuditedPackageImporter[];
  engines: AuditedPackageEngines | null;
}

interface UnverifiedGitHubPackagesTransport {
  maxTarballBytes: null;
  redirectHosts: null;
  redirectStatuses: null;
  contentTypes: null;
  rangeBehavior: null;
  credentialContract: null;
}

interface GitHubPackagesAuthorityManifest {
  complete: false;
  available: false;
  unavailableReason: string;
  source: {
    repository: "totango/agentic";
    revision: string;
    lockfilePath: "pnpm-lock.yaml";
    lockfileGitBlob: string;
  };
  artifacts: AuditedGitHubPackage[];
  transport: UnverifiedGitHubPackagesTransport;
}

const PACKAGE_NAME_PATTERN = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const PRERELEASE_IDENTIFIER = String.raw`(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const VERSION_PATTERN = new RegExp(
  String.raw`^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-${PRERELEASE_IDENTIFIER}(?:\.${PRERELEASE_IDENTIFIER})*)?$`,
);
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA512_HEX_PATTERN = /^[0-9a-f]{128}$/;
const SHA512_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const IMPORTER_PATH_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;

const EXPECTED_MANIFEST: GitHubPackagesAuthorityManifest = deepFreeze({
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

/** Validates and returns detached inert, incomplete server-private authority evidence. */
export function githubPackagesAuthorityManifest(): Readonly<GitHubPackagesAuthorityManifest> {
  const value = structuredClone(EXPECTED_MANIFEST);
  validateGitHubPackagesAuthorityManifest(value);
  return deepFreeze(value);
}

/** Validates server-private authority evidence without granting access to any artifact. */
export function validateGitHubPackagesAuthorityManifest(
  value: GitHubPackagesAuthorityManifest,
): void {
  if (value.complete !== false || value.available !== false || !value.unavailableReason.trim()) {
    throw new Error("GitHub Packages authority must remain explicitly incomplete and unavailable.");
  }
  if (value.source.repository !== "totango/agentic" || value.source.lockfilePath !== "pnpm-lock.yaml" ||
      !GIT_SHA_PATTERN.test(value.source.revision) || !GIT_SHA_PATTERN.test(value.source.lockfileGitBlob)) {
    throw new Error("GitHub Packages audit source is not canonical.");
  }
  if (value.artifacts.length !== 2) {
    throw new Error("GitHub Packages authority must contain exactly two audited artifacts.");
  }
  const names = new Set<string>();
  let previousName = "";
  for (const artifact of value.artifacts) {
    validateArtifact(artifact);
    if (names.has(artifact.name) || artifact.name <= previousName) {
      throw new Error("GitHub Packages artifacts must have unique, canonical ordering.");
    }
    names.add(artifact.name);
    previousName = artifact.name;
  }
  if (Object.values(value.transport).some(fact => fact !== null)) {
    throw new Error("GitHub Packages transport facts must remain explicitly unverified.");
  }
  if (!exactlyMatches(value, EXPECTED_MANIFEST)) {
    throw new Error("GitHub Packages authority does not match the exact audited allowlist.");
  }
}

function validateArtifact(artifact: AuditedGitHubPackage): void {
  if (!PACKAGE_NAME_PATTERN.test(artifact.name) || artifact.name !== artifact.name.toLowerCase()) {
    throw new Error(`GitHub package name is not canonical: ${artifact.name}`);
  }
  if (!VERSION_PATTERN.test(artifact.version)) {
    throw new Error(`GitHub package version is not canonical: ${artifact.version}`);
  }
  if (!GIT_SHA_PATTERN.test(artifact.opaqueTarballId)) {
    throw new Error(`GitHub package tarball ID is not canonical: ${artifact.name}`);
  }
  const expectedPath = `/download/${artifact.name}/${artifact.version}/${artifact.opaqueTarballId}`;
  if (artifact.tarballPath !== expectedPath || artifact.tarballPath.includes("?") || artifact.tarballPath.includes("#")) {
    throw new Error(`GitHub package tarball path is not canonical: ${artifact.name}`);
  }
  const encoded = artifact.integrity.slice("sha512-".length);
  if (!artifact.integrity.startsWith("sha512-") || !SHA512_BASE64_PATTERN.test(encoded)) {
    throw new Error(`GitHub package integrity is not canonical SHA-512: ${artifact.name}`);
  }
  const bytes = decodeBase64(encoded);
  if (bytes.length !== 64 || bytesToHex(bytes) !== artifact.sha512Hex ||
      !SHA512_HEX_PATTERN.test(artifact.sha512Hex)) {
    throw new Error(`GitHub package integrity does not match its audited SHA-512: ${artifact.name}`);
  }
  if (artifact.importers.length === 0) {
    throw new Error(`GitHub package has no audited importer: ${artifact.name}`);
  }
  let previousImporter = "";
  for (const importer of artifact.importers) {
    if (!IMPORTER_PATH_PATTERN.test(importer.path) || importer.path <= previousImporter ||
        importer.dependencyType !== "dependencies" || importer.specifier !== artifact.version) {
      throw new Error(`GitHub package importer is not canonical: ${artifact.name}`);
    }
    previousImporter = importer.path;
  }
  if (artifact.engines && (!artifact.engines.node.trim() || !artifact.engines.pnpm.trim())) {
    throw new Error(`GitHub package engine facts are incomplete: ${artifact.name}`);
  }
}

function exactlyMatches(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== "object" || actual === null ||
      typeof expected !== "object" || expected === null) return false;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual) && Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((entry, index) => exactlyMatches(entry, expected[index]));
  }
  const actualRecord = actual as Record<PropertyKey, unknown>;
  const expectedRecord = expected as Record<PropertyKey, unknown>;
  const actualKeys = Reflect.ownKeys(actualRecord);
  const expectedKeys = Reflect.ownKeys(expectedRecord);
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every(key => expectedKeys.includes(key)) &&
    expectedKeys.every(key => exactlyMatches(actualRecord[key], expectedRecord[key]));
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
