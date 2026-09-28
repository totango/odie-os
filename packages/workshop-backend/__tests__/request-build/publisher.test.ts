import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildHash,
  canonicalBuildJson,
  requestBuildNotificationKey,
  validateRequestBuildNotification,
  type RequestBuildIntent,
  type RequestBuildArtifact,
} from "@gadgets/workshop-shared/coding-sessions";
import {
  parseBuildPublicationPolicy,
  validateBuildArtifact,
  type BuildRepositoryRead,
} from "../../src/request-build-publisher";
const blobSha = createHash("sha1").update("blob 2\0a\n").digest("hex");
const base = "a".repeat(40),
  tree = "b".repeat(40);
const patch =
  "diff --git a/a.ts b/a.ts\nindex 7898192..6178079 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
const policy = {
  version: "fixture-1",
  allowedPaths: ["a.ts", "src/"],
  changedLines: 4,
  textBytes: 4096,
};
async function intent(): Promise<RequestBuildIntent> {
  const execution = {
    version: "fixture-1",
    runtimeVersion: "0.85.1",
    model: "fixture-model",
    wallTimeMs: 120000,
    modelCalls: 2,
    spendMicros: 2000,
    callChargeMicros: 1000,
    modelInputBytes: 8192,
contextFiles: 10,
contextBytes: 100 * 1024 * 1024,
    modelOutputTokens: 200,
    outputBytes: 8192,
    diffBytes: 4096,
    diffFiles: 2,
    concurrency: 1,
    dependencyHosts: [],
  };
  return {
    dispatchKey: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    attempt: 1,
    specification: "public specification",
    specificationHash: await buildHash("public specification"),
contextFiles: [],
    repository: "totango/odie-os",
    baseBranch: "main",
    baseSha: base,
    policy: execution,
    policyHash: await buildHash(canonicalBuildJson(execution)),
  };
}
async function artifact(text = patch): Promise<RequestBuildArtifact> {
  return { baseSha: base, patch: text, hash: await buildHash(text) };
}
const read: BuildRepositoryRead = async (operation) => {
  if (operation.kind === "commit")
    return JSON.stringify({ sha: base, tree: { sha: tree }, parents: [], message: "base" });
  if (operation.kind === "tree")
    return JSON.stringify({
      sha: tree,
      truncated: false,
      tree: [{ path: "a.ts", mode: "100644", type: "blob", sha: blobSha }],
    });
  if (operation.kind === "blob")
    return JSON.stringify({ sha: blobSha, encoding: "base64", content: btoa("a\n"), size: 2 });
  throw new Error("unexpected read");
};
describe("trusted request-build artifact validation", () => {
  it("canonicalBuildJson sorts fresh entries without mutating frozen protocol values", () => {
    const value = Object.freeze({ z: Object.freeze({ b: 2, a: 1 }), a: Object.freeze([3, 1]) });
    expect(canonicalBuildJson(value)).toBe('{"a":[3,1],"z":{"a":1,"b":2}}');
    expect(Object.keys(value)).toEqual(["z", "a"]);
    expect(Object.keys(value.z)).toEqual(["b", "a"]);
    expect(value.a).toEqual([3, 1]);
  });
  it("validateRequestBuildNotification accepts reordered frozen keys but rejects extras", () => {
    const fields = { prNumber: 42, runId: crypto.randomUUID(), requestId: crypto.randomUUID(), attempt: 1, origin: "https://workshop.example.invalid" };
    const request = Object.freeze({ ...fields, notificationKey: requestBuildNotificationKey(fields) });
    const keys = Object.keys(request);
    expect(() => validateRequestBuildNotification(request, fields.origin)).not.toThrow();
    expect(Object.keys(request)).toEqual(keys);
    const invalid = { ...request, privateIdentity: "not public" };
    expect(() => validateRequestBuildNotification(invalid, fields.origin)).toThrow("BUILD_NOTIFICATION_INVALID");
  });
  it("requires explicit bounded policy without protected-path permissions", () => {
    expect(parseBuildPublicationPolicy()).toBeNull();
    expect(parseBuildPublicationPolicy(JSON.stringify(policy))).toEqual(policy);
    for (const overrides of [
      { changedLines: 0 },
      { textBytes: Infinity },
      { allowedPaths: [".github/"] },
      { allowedPaths: ["src/auth/"] },
      { allowEverything: true },
    ])
      expect(parseBuildPublicationPolicy(JSON.stringify({ ...policy, ...overrides }))).toBeNull();
  });
  it("applies a regular text patch only to provider-verified exact base contents", async () => {
    const approved = await validateBuildArtifact(await intent(), await artifact(), policy, read);
    expect(approved.entries).toEqual([
      { path: "a.ts", mode: "100644", type: "blob", content: "b\n" },
    ]);
    expect(approved.contentHashes["a.ts"]).toBe(
      createHash("sha1").update("blob 2\0b\n").digest("hex"),
    );
  });
  it("accepts bounded regular-file creation/deletion and rejects out-of-range insertion", async () => {
    const addition =
      "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+new\n";
    expect(
      (await validateBuildArtifact(await intent(), await artifact(addition), policy, read)).entries,
    ).toEqual([{ path: "src/new.ts", mode: "100644", type: "blob", content: "new\n" }]);
    const deletion =
      "diff --git a/a.ts b/a.ts\ndeleted file mode 100644\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n";
    expect(
      (await validateBuildArtifact(await intent(), await artifact(deletion), policy, read)).entries,
    ).toEqual([{ path: "a.ts", mode: "100644", type: "blob", sha: null }]);
    await expect(
      validateBuildArtifact(
        await intent(),
        await artifact(addition.replace("-0,0", "-100,0")),
        policy,
        read,
      ),
    ).rejects.toThrow("BUILD_ARTIFACT_INVALID");
  });
  it("rejects protected/traversal/duplicate paths, binary, symlink and mode changes, and secret echoes", async () => {
    const cases = [
      patch.replaceAll("a.ts", "../a.ts"),
      patch.replaceAll("a.ts", ".github/workflows/a.ts"),
      patch.replaceAll("a.ts", "src/auth/a.ts"),
      patch.replace("100644", "100755"),
      patch.replace("index 7898192..6178079 100644", "new mode 120000"),
      patch.replace("+b\n", "+sk-abcdefghijklmnopqrstuvwxyz0123456789\n"),
      patch.replace("+b\n", "+b\u0000\n"),
      patch + patch,
      patch.replace("-a\n", "-not-the-base\n"),
      patch.replace("@@ -1 +1 @@", "@@ -2 +2 @@"),
    ];
    for (const text of cases)
      await expect(
        validateBuildArtifact(await intent(), await artifact(text), policy, read),
      ).rejects.toThrow();
  });
  it("rejects artifact hash/base mismatch, output bounds and truncated or symlink base trees", async () => {
    const approved = await intent(),
      frozen = await artifact();
    await expect(
      validateBuildArtifact(approved, { ...frozen, hash: "0".repeat(64) }, policy, read),
    ).rejects.toThrow();
    await expect(
      validateBuildArtifact(approved, { ...frozen, baseSha: tree }, policy, read),
    ).rejects.toThrow();
    await expect(
      validateBuildArtifact(approved, frozen, { ...policy, changedLines: 1 }, read),
    ).rejects.toThrow();
    for (const alteration of [
      { truncated: true },
      { tree: [{ path: "a.ts", mode: "120000", type: "blob", sha: blobSha }] },
    ]) {
      const badRead: BuildRepositoryRead = async (operation) =>
        operation.kind === "tree"
          ? JSON.stringify({ ...JSON.parse((await read(operation))!), ...alteration })
          : read(operation);
      await expect(validateBuildArtifact(approved, frozen, policy, badRead)).rejects.toThrow();
    }
  });
});
