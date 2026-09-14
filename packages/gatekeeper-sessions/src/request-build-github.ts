import {
  buildHash,
  canonicalBuildJson,
  type CodingSessionOwner,
  type CodingSessionToolHost,
  type RequestBuildGitHubAuthorization,
  type RequestBuildGitHubRead,
  type RequestBuildGitHubWrite,
} from "@gadgets/workshop-shared/coding-sessions";
import {
  githubHeaders,
  mintGitHubInstallationToken,
  readGitHubResponseText,
  type GitHubAppEnv,
} from "./github-app.js";

const origin = "https://api.github.com/repos/totango/odie-os";
const maximum = 8 * 1024 * 1024;
function sha(value: string): string {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("BUILD_GITHUB_INPUT_INVALID");
  return value;
}
function branch(value: string): string {
  if (!/^request-build\/[a-f0-9-]{36}\/[1-9][0-9]?$/.test(value))
    throw new Error("BUILD_GITHUB_INPUT_INVALID");
  return value;
}
function fields(value: object, names: string[]): void {
  if (Object.keys(value).some((name) => !names.includes(name)))
    throw new Error("BUILD_GITHUB_INPUT_INVALID");
}
function bounded(value: string, limit: number): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > limit)
    throw new Error("BUILD_GITHUB_INPUT_INVALID");
  return value;
}

/** Private transport reads stay available for service reconciliation; no caller supplies a URL or headers. */
export async function readRequestBuildGitHub(
  env: GitHubAppEnv,
  operation: RequestBuildGitHubRead,
): Promise<string | null> {
  let path: string;
  switch (operation.kind) {
    case "base":
      fields(operation, ["kind"]);
      path = "/git/ref/heads/main";
      break;
    case "commit":
    case "tree":
    case "blob":
      fields(operation, ["kind", "sha"]);
      path = `/git/${operation.kind === "commit" ? "commits" : operation.kind === "tree" ? "trees" : "blobs"}/${sha(operation.sha)}${operation.kind === "tree" ? "?recursive=1" : ""}`;
      break;
    case "ref":
      fields(operation, ["kind", "branch"]);
      path = `/git/ref/heads/${branch(operation.branch)}`;
      break;
    case "pulls":
      fields(operation, ["kind", "branch"]);
      path = `/pulls?state=all&head=${encodeURIComponent(`totango:${branch(operation.branch)}`)}&base=main&per_page=100`;
      break;
    case "pull":
      fields(operation, ["kind", "number"]);
      if (!Number.isSafeInteger(operation.number) || operation.number < 1)
        throw new Error("BUILD_GITHUB_INPUT_INVALID");
      path = `/pulls/${operation.number}`;
      break;
    default:
      throw new Error("BUILD_GITHUB_INPUT_INVALID");
  }
  const token = await mintGitHubInstallationToken(env, {
    repositories: ["odie-os"],
    permissions: { contents: "read", metadata: "read", pull_requests: "read" },
    verifyRepositoryScope: true,
  });
  return request(token.token, path);
}

/** Write credentials never enter a sandbox: each exact operation digest is admitted by the persisted backend run. */
export async function writeRequestBuildGitHub(
  env: GitHubAppEnv,
  host: Pick<CodingSessionToolHost, "authorizeRequestBuild">,
  owner: CodingSessionOwner,
  authorization: RequestBuildGitHubAuthorization,
  operation: RequestBuildGitHubWrite,
): Promise<string> {
  let path: string, body: object;
  if (new TextEncoder().encode(canonicalBuildJson(operation)).length > maximum)
    throw new Error("BUILD_GITHUB_INPUT_INVALID");
  switch (operation.kind) {
    case "tree":
      fields(operation, ["kind", "baseTree", "entries"]);
      if (
        !Array.isArray(operation.entries) ||
        !operation.entries.length ||
        operation.entries.length > 100
      )
        throw new Error("BUILD_GITHUB_INPUT_INVALID");
      for (const entry of operation.entries) {
        fields(
          entry,
          "content" in entry
            ? ["path", "mode", "type", "content"]
            : ["path", "mode", "type", "sha"],
        );
        if (
          entry.mode !== "100644" ||
          entry.type !== "blob" ||
          !/^[A-Za-z0-9_./-]{1,240}$/.test(entry.path) ||
          entry.path.split("/").some((p) => !p || p === "." || p === "..") ||
          ("content" in entry ? typeof entry.content !== "string" : entry.sha !== null)
        )
          throw new Error("BUILD_GITHUB_INPUT_INVALID");
      }
      path = "/git/trees";
      body = { base_tree: sha(operation.baseTree), tree: operation.entries };
      break;
    case "commit":
      fields(operation, ["kind", "tree", "parent", "message", "date"]);
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(operation.date))
        throw new Error("BUILD_GITHUB_INPUT_INVALID");
      path = "/git/commits";
      body = {
        tree: sha(operation.tree),
        parents: [sha(operation.parent)],
        message: bounded(operation.message, 1000),
        author: {
          name: "Odie Request Builds",
          email: "request-builds@users.noreply.github.com",
          date: operation.date,
        },
        committer: {
          name: "Odie Request Builds",
          email: "request-builds@users.noreply.github.com",
          date: operation.date,
        },
      };
      break;
    case "ref":
      fields(operation, ["kind", "branch", "sha"]);
      path = "/git/refs";
      body = { ref: `refs/heads/${branch(operation.branch)}`, sha: sha(operation.sha) };
      break;
    case "pull":
      fields(operation, ["kind", "branch", "title", "body"]);
      path = "/pulls";
      body = {
        head: branch(operation.branch),
        base: "main",
        draft: true,
        title: bounded(operation.title, 160),
        body: bounded(operation.body, 4000),
      };
      break;
    default:
      throw new Error("BUILD_GITHUB_INPUT_INVALID");
  }
  if (
    authorization.phase !== "publish" ||
    (await buildHash(canonicalBuildJson(operation))) !== authorization.publicationHash
  )
    throw new Error("BUILD_PUBLICATION_DENIED");
  // Minting is not publication admission; recheck AFTER credential I/O, immediately before the write.
  const token = await mintGitHubInstallationToken(env, {
    repositories: ["odie-os"],
    permissions: { contents: "write", metadata: "read", pull_requests: "write" },
    verifyRepositoryScope: true,
  });
  if (JSON.stringify(body).includes(token.token))
    throw new Error("BUILD_ARTIFACT_CONTENT_REJECTED");
  const decision = await host.authorizeRequestBuild(owner, authorization);
  if (
    !decision.allowed ||
    decision.intentHash !== authorization.intentHash ||
    decision.sessionId !== authorization.sessionId ||
    decision.generation !== authorization.generation
  )
    throw new Error("BUILD_PUBLICATION_DENIED");
  const result = await request(token.token, path, body);
  if (result === null) throw new Error("BUILD_GITHUB_UNAVAILABLE");
  return result;
}

async function request(token: string, path: string, body?: object): Promise<string | null> {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: githubHeaders(`Bearer ${token}`, "odie-request-builds"),
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (!body && response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("BUILD_GITHUB_UNAVAILABLE");
  }
  const text = await readGitHubResponseText(response, maximum);
  JSON.parse(text); // Preserve bounded JSON only; backend validates each operation's response schema.
  return text;
}
