import { applyPatch, parsePatch } from "diff";
import { z } from "zod";
import {
  buildHash,
  canonicalBuildJson,
  type RequestBuildArtifact,
  type RequestBuildIntent,
  type RequestBuildGitHubRead,
  type RequestBuildGitHubWrite,
  type RequestBuildTreeEntry,
} from "@gadgets/workshop-shared/coding-sessions";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const commitSchema = z.object({
  sha,
  tree: z.object({ sha }),
  parents: z.array(z.object({ sha })),
  message: z.string(),
});
const treeEntry = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.enum(["blob", "tree", "commit"]),
  sha,
});
const treeSchema = z.object({
  sha,
  truncated: z.literal(false),
  tree: z.array(treeEntry).max(100_000),
});
const refSchema = z.object({
  ref: z.string(),
  object: z.object({ type: z.literal("commit"), sha }),
});
const pullSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string(),
  draft: z.literal(true),
  body: z.string(),
  head: z.object({
    ref: z.string(),
    sha,
    repo: z.object({ full_name: z.literal("totango/odie-os") }),
  }),
  base: z.object({
    ref: z.literal("main"),
    sha,
    repo: z.object({ full_name: z.literal("totango/odie-os") }),
  }),
});
const publicationPolicySchema = z
  .object({
    version: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    allowedPaths: z.array(z.string().min(1).max(240)).min(1).max(100),
    changedLines: z.number().int().positive().max(100_000),
    textBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
  })
  .strict();
/** Explicit deployment-reviewed publication allowlist/bounds, with no numeric or path defaults. */
export type RequestBuildPublicationPolicy = z.infer<typeof publicationPolicySchema>;
/** Completed immutable validation evidence retained privately for Git Data publication and reconciliation. */
export type ValidatedBuildArtifact = {
  artifactHash: string;
  baseTree: string;
  baseEntries: z.infer<typeof treeEntry>[];
  entries: RequestBuildTreeEntry[];
  contentHashes: Record<string, string | null>;
};
/** Persisted publication progress; sent means the operation may already have succeeded remotely. */
export type BuildPublication = {
  artifact: ValidatedBuildArtifact;
  tree?: string;
  head?: string;
  refVerified?: boolean;
  pending?: { operation: RequestBuildGitHubWrite; hash: string; sent: boolean };
  pullRequest?: { number: number; url: string };
};
/** Actual binding read shape, narrowed from the private shared service contract. */
export type BuildRepositoryRead = (operation: RequestBuildGitHubRead) => Promise<string | null>;

/** Missing or malformed deployment policy denies publication; no request can select paths or budgets. */
export function parseBuildPublicationPolicy(raw?: string): RequestBuildPublicationPolicy | null {
  if (!raw) return null;
  try {
    const policy = publicationPolicySchema.parse(JSON.parse(raw));
    if (policy.allowedPaths.some((path) => !safePath(path.endsWith("/") ? `${path}file` : path)))
      return null;
    return policy;
  } catch {
    return null;
  }
}
function json(text: string | null): unknown {
  if (text === null) throw new Error("BUILD_REPOSITORY_EVIDENCE_MISSING");
  return JSON.parse(text);
}
function safePath(path: string): boolean {
  return (
    /^[A-Za-z0-9_./-]{1,240}$/.test(path) &&
    !path.startsWith("/") &&
    !path
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.startsWith(".")) &&
    !/(^|\/)(?:auth[^/]*|admin[^/]*|security|secrets?|credentials?|migrations?|deploy[^/]*|request-build[^/]*|provisioning-policy[^/]*|server\.ts|user\.ts|overseer\.ts|node_modules|vendor|AGENTS\.md|CLAUDE\.md|Dockerfile[^/]*|wrangler[^/]*|package(?:-lock)?\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*)(\/|$)/i.test(
      path,
    )
  );
}
function safeText(text: string, limit: number): void {
  const bytes = new TextEncoder().encode(text);
  if (
    bytes.length > limit ||
    bytes.some(
      (byte) => (byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 0x7f,
    ) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})|(?:authorization\s*:\s*bearer\s+\S+)|(?:password|secret|token|api[_-]?key)\s*[:=]\s*["'][^"'\s]{12,}/i.test(
      text,
    )
  )
    throw new Error("BUILD_ARTIFACT_CONTENT_REJECTED");
}
async function blobHash(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content),
    header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const input = new Uint8Array(header.length + bytes.length);
  input.set(header);
  input.set(bytes, header.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", input))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Resolve only canonical main, then verify that its full commit exists via the same repository transport. */
export async function resolveRequestBuildBase(read: BuildRepositoryRead): Promise<string> {
  const ref = refSchema.parse(json(await read({ kind: "base" })));
  if (ref.ref !== "refs/heads/main") throw new Error("BUILD_BASE_INVALID");
  const commit = commitSchema.parse(json(await read({ kind: "commit", sha: ref.object.sha })));
  if (commit.sha !== ref.object.sha) throw new Error("BUILD_BASE_INVALID");
  return commit.sha;
}

/** Strict patch parsing is independent of the runner. Apply at the exact frozen base with zero fuzz. */
export async function validateBuildArtifact(
  intent: RequestBuildIntent,
  artifact: RequestBuildArtifact,
  policy: RequestBuildPublicationPolicy,
  read: BuildRepositoryRead,
): Promise<ValidatedBuildArtifact> {
  if (
    artifact.baseSha !== intent.baseSha ||
    artifact.hash !== (await buildHash(artifact.patch)) ||
    new TextEncoder().encode(artifact.patch).length > intent.policy.diffBytes
  )
    throw new Error("BUILD_ARTIFACT_INVALID");
  safeText(artifact.patch, intent.policy.diffBytes);
  const sections = artifact.patch.split(/(?=^diff --git )/m).filter(Boolean);
  if (
    !sections.length ||
    sections.length > intent.policy.diffFiles ||
    sections.some((s) => !s.startsWith("diff --git "))
  )
    throw new Error("BUILD_ARTIFACT_INVALID");
  const commit = commitSchema.parse(json(await read({ kind: "commit", sha: intent.baseSha })));
  if (commit.sha !== intent.baseSha) throw new Error("BUILD_BASE_INVALID");
  const tree = treeSchema.parse(json(await read({ kind: "tree", sha: commit.tree.sha })));
  if (
    tree.sha !== commit.tree.sha ||
    new Set(tree.tree.map((e) => e.path)).size !== tree.tree.length
  )
    throw new Error("BUILD_TREE_INVALID");
  const entries: RequestBuildTreeEntry[] = [],
    contentHashes: Record<string, string | null> = {};
  let changedLines = 0,
    totalBytes = 0;
  for (const section of sections) {
    const first = /^diff --git a\/([A-Za-z0-9_./-]+) b\/([A-Za-z0-9_./-]+)\n/.exec(section);
    if (!first || first[1] !== first[2]) throw new Error("BUILD_ARTIFACT_PATH_REJECTED");
    const path = first[1];
    if (
      !safePath(path) ||
      !policy.allowedPaths.some((allowed) =>
        allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed,
      ) ||
      Object.hasOwn(contentHashes, path)
    )
      throw new Error("BUILD_ARTIFACT_PATH_REJECTED");
    const headerEnd = section.indexOf("\n@@ ");
    if (headerEnd < 0) throw new Error("BUILD_ARTIFACT_INVALID");
    const headers = section.slice(first[0].length, headerEnd).split("\n");
    if (
      headers.some(
        (line) =>
          !/^(?:index [a-f0-9]+\.\.[a-f0-9]+(?: 100644)?|(?:new file|deleted file) mode 100644|--- (?:a\/[A-Za-z0-9_./-]+|\/dev\/null)|\+\+\+ (?:b\/[A-Za-z0-9_./-]+|\/dev\/null))$/.test(
            line,
          ),
      )
    )
      throw new Error("BUILD_ARTIFACT_MODE_REJECTED");
    const patches = parsePatch(section);
    if (patches.length !== 1) throw new Error("BUILD_ARTIFACT_INVALID");
    const patch = patches[0],
      creating = patch.oldFileName === "/dev/null",
      deleting = patch.newFileName === "/dev/null";
    if (
      (creating && deleting) ||
      patch.oldFileName !== (creating ? "/dev/null" : `a/${path}`) ||
      patch.newFileName !== (deleting ? "/dev/null" : `b/${path}`)
    )
      throw new Error("BUILD_ARTIFACT_INVALID");
    const previous = tree.tree.find((e) => e.path === path);
    if (creating ? !!previous : !previous || previous.mode !== "100644" || previous.type !== "blob")
      throw new Error("BUILD_ARTIFACT_MODE_REJECTED");
    // No symlink/submodule ancestors, even for a new file.
    if (tree.tree.some((e) => path.startsWith(`${e.path}/`) && e.type !== "tree"))
      throw new Error("BUILD_ARTIFACT_MODE_REJECTED");
    let original = "";
    if (previous) {
      const blob = z
        .object({
          sha,
          encoding: z.literal("base64"),
          content: z.string(),
          size: z.number().int().nonnegative(),
        })
        .parse(json(await read({ kind: "blob", sha: previous.sha })));
      if (blob.sha !== previous.sha || blob.size > policy.textBytes)
        throw new Error("BUILD_ARTIFACT_INVALID");
      const bytes = Uint8Array.from(atob(blob.content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
      original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      if (bytes.length !== blob.size || (await blobHash(original)) !== previous.sha)
        throw new Error("BUILD_ARTIFACT_INVALID");
    }
    safeText(original, policy.textBytes);
    changedLines += patch.hunks
      .flatMap((h) => h.lines)
      .filter((line) => line.startsWith("+") || line.startsWith("-")).length;
    if (changedLines > policy.changedLines) throw new Error("BUILD_ARTIFACT_LIMIT");
    // Enforce exact hunk positions/context ourselves: jsdiff otherwise searches nearby matching lines.
    const lines = original === "" ? [] : original.split("\n");
    if (original.endsWith("\n")) lines.pop();
    let consumed = 0;
    for (const hunk of patch.hunks) {
      // parsePatch normalizes even empty old ranges to a one-based insertion point.
      const start = hunk.oldStart - 1;
      if (start < consumed || start + hunk.oldLines > lines.length)
        throw new Error("BUILD_ARTIFACT_INVALID");
      let index = start;
      for (const line of hunk.lines)
        if (line.startsWith(" ") || line.startsWith("-")) {
          if (lines[index++] !== line.slice(1)) throw new Error("BUILD_ARTIFACT_BASE_MISMATCH");
        }
      consumed = index;
    }
    const content = applyPatch(original, patch, { fuzzFactor: 0, autoConvertLineEndings: false });
    if (content === false || (deleting && content !== ""))
      throw new Error("BUILD_ARTIFACT_BASE_MISMATCH");
    safeText(content, policy.textBytes);
    totalBytes += new TextEncoder().encode(content).length;
    if (totalBytes > policy.textBytes) throw new Error("BUILD_ARTIFACT_LIMIT");
    entries.push(
      deleting
        ? { path, mode: "100644", type: "blob", sha: null }
        : { path, mode: "100644", type: "blob", content },
    );
    contentHashes[path] = deleting ? null : await blobHash(content);
  }
  return {
    artifactHash: artifact.hash,
    baseTree: tree.sha,
    baseEntries: tree.tree,
    entries,
    contentHashes,
  };
}

/** Deterministic branch/provenance never incorporates request or model text. */
export function buildPublicationBranch(intent: RequestBuildIntent): string {
  return `request-build/${intent.runId}/${intent.attempt}`;
}
/** Fixed PR body records actual runner completion, not a model's claim that tests passed. */
export function buildPublicationBody(
  intent: RequestBuildIntent,
  requestId: string,
  revision: number,
  artifactHash: string,
): string {
  return `Request: ${requestId}\nRun: ${intent.runId}\nAttempt: ${intent.attempt}\nApproved revision: ${revision}\nBase: ${intent.baseSha}\nSpecification SHA-256: ${intent.specificationHash}\nArtifact SHA-256: ${artifactHash}\n\nRestricted runner and collector: exit 0. Project verification tests: not run by the trusted control plane.\nNo merge or deployment performed.`;
}

/** Verify the entire resulting file tree: only exact approved regular-file changes may differ. */
export async function verifyBuildTree(
  read: BuildRepositoryRead,
  publication: BuildPublication,
  treeSha: string,
): Promise<void> {
  const tree = treeSchema.parse(json(await read({ kind: "tree", sha: treeSha })));
  if (tree.sha !== treeSha) throw new Error("BUILD_PUBLICATION_CONFLICT");
  const expected = new Map(
    publication.artifact.baseEntries
      .filter((e) => e.type !== "tree")
      .map((e) => [e.path, { mode: e.mode, type: e.type, sha: e.sha }]),
  );
  for (const [path, hash] of Object.entries(publication.artifact.contentHashes)) {
    if (hash === null) expected.delete(path);
    else expected.set(path, { mode: "100644", type: "blob", sha: hash });
  }
  const actual = tree.tree.filter((e) => e.type !== "tree");
  if (
    actual.length !== expected.size ||
    new Set(actual.map((e) => e.path)).size !== actual.length ||
    actual.some(
      (e) =>
        canonicalBuildJson(expected.get(e.path) ?? null) !==
        canonicalBuildJson({ mode: e.mode, type: e.type, sha: e.sha }),
    )
  )
    throw new Error("BUILD_PUBLICATION_CONFLICT");
}

/** Independent response/reconciliation verification; never trusts a supplied URL or model event. */
export async function verifyBuildPublicationResult(
  read: BuildRepositoryRead,
  intent: RequestBuildIntent,
  publication: BuildPublication,
  operation: RequestBuildGitHubWrite,
  response: string,
): Promise<BuildPublication> {
  const next = { ...publication, pending: undefined };
  if (operation.kind === "tree") {
    const result = z.object({ sha }).parse(json(response));
    await verifyBuildTree(read, publication, result.sha);
    next.tree = result.sha;
  } else if (operation.kind === "commit") {
    const result = commitSchema.parse(json(response));
    const verified = commitSchema.parse(json(await read({ kind: "commit", sha: result.sha })));
    if (
      verified.sha !== result.sha ||
      verified.tree.sha !== operation.tree ||
      verified.parents.length !== 1 ||
      verified.parents[0].sha !== intent.baseSha ||
      verified.message !== operation.message
    )
      throw new Error("BUILD_PUBLICATION_CONFLICT");
    await verifyBuildTree(read, publication, verified.tree.sha);
    next.head = verified.sha;
  } else if (operation.kind === "ref") {
    const ref = refSchema.parse(json(await read({ kind: "ref", branch: operation.branch })));
    if (
      ref.ref !== `refs/heads/${buildPublicationBranch(intent)}` ||
      ref.object.sha !== publication.head
    )
      throw new Error("BUILD_PUBLICATION_CONFLICT");
    next.refVerified = true;
  } else {
    const result = pullSchema.parse(json(response));
    const verified = pullSchema.parse(json(await read({ kind: "pull", number: result.number })));
    const ref = refSchema.parse(json(await read({ kind: "ref", branch: operation.branch })));
    if (
      verified.number !== result.number ||
      verified.head.ref !== operation.branch ||
      verified.head.sha !== publication.head ||
      verified.base.sha !== intent.baseSha ||
      verified.body !== operation.body ||
      verified.html_url !== `https://github.com/totango/odie-os/pull/${verified.number}` ||
      ref.object.sha !== publication.head
    )
      throw new Error("BUILD_PUBLICATION_CONFLICT");
    next.pullRequest = { number: verified.number, url: verified.html_url };
  }
  return next;
}

/** Lost acknowledgements reconcile by exact branch/PR reads; absent evidence NEVER triggers a blind retry. */
export async function reconcileBuildPublication(
  read: BuildRepositoryRead,
  intent: RequestBuildIntent,
  publication: BuildPublication,
): Promise<BuildPublication> {
  const operation = publication.pending?.operation;
  if (!operation) return publication;
  if (operation.kind === "ref")
    return verifyBuildPublicationResult(read, intent, publication, operation, "{}");
  if (operation.kind === "pull") {
    const results = z
      .array(pullSchema)
      .max(99)
      .parse(json(await read({ kind: "pulls", branch: operation.branch })));
    if (results.length !== 1) throw new Error("BUILD_PUBLICATION_AMBIGUOUS");
    return verifyBuildPublicationResult(
      read,
      intent,
      publication,
      operation,
      JSON.stringify(results[0]),
    );
  }
  // Content-addressed objects may exist, but no acknowledged hash means no trusted evidence to adopt.
  throw new Error("BUILD_PUBLICATION_AMBIGUOUS");
}
