import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildHash,
  canonicalBuildJson,
  type CodingSessionToolHost,
  type RequestBuildGitHubAuthorization,
  type RequestBuildGitHubWrite,
} from "@gadgets/workshop-shared/coding-sessions";
import { readRequestBuildGitHub, writeRequestBuildGitHub } from "../src/request-build-github.js";
import type { GitHubAppEnv } from "../src/github-app.js";
let env: GitHubAppEnv;
const owner = { userId: "fixture-account", email: "fixture@example.invalid" };
const operation: RequestBuildGitHubWrite = {
  kind: "ref",
  branch: `request-build/${crypto.randomUUID()}/1`,
  sha: "a".repeat(40),
};
const host: Pick<CodingSessionToolHost, "authorizeRequestBuild"> = {
  authorizeRequestBuild: async (_owner, request) => ({
    allowed: true,
    intentHash: request.intentHash,
    sessionId: request.sessionId,
    generation: request.generation,
  }),
};
async function authorization(): Promise<RequestBuildGitHubAuthorization> {
  return {
    dispatchKey: crypto.randomUUID(),
    intentHash: "b".repeat(64),
    sessionId: crypto.randomUUID(),
    generation: 1,
    phase: "publish",
    publicationHash: await buildHash(canonicalBuildJson(operation)),
  };
}
beforeAll(async () => {
  const key = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 1024,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pem = Buffer.from(await crypto.subtle.exportKey("pkcs8", key.privateKey)).toString(
    "base64",
  );
  env = {
    GITHUB_APP_ID: "fixture",
    GITHUB_APP_INSTALLATION_ID: "fixture",
    GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`,
  };
});
afterEach(() => vi.unstubAllGlobals());
function mock(
  scope: Record<string, string> = { contents: "write", metadata: "read", pull_requests: "write" },
  repo = "totango/odie-os",
) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).origin).toBe("https://api.github.com");
    expect(init.redirect).toBe("manual");
    return url.includes("/access_tokens")
      ? Response.json({
          token: "fixture-token",
          expires_at: "2099-01-01T00:00:00Z",
          permissions: scope,
          repositories: [{ full_name: repo }],
        })
      : Response.json({ result: "fixture" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
describe("Worker-owned restricted GitHub transport", () => {
  it("uses exact repo-scoped write grant and reauthorizes after minting before fixed POST", async () => {
    const fetchMock = mock(),
      auth = await authorization();
    const authorize = vi.fn(host.authorizeRequestBuild);
    await writeRequestBuildGitHub(
      env,
      { authorizeRequestBuild: authorize },
      owner,
      auth,
      operation,
    );
    expect(authorize).toHaveBeenCalledExactlyOnceWith(owner, auth);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      repositories: ["odie-os"],
      permissions: { contents: "write", metadata: "read", pull_requests: "write" },
    });
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.github.com/repos/totango/odie-os/git/refs",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({
      ref: `refs/heads/${operation.kind === "ref" ? operation.branch : ""}`,
      sha: "a".repeat(40),
    });
  });
  it("denies digest forgery, extra URL fields, non-build branch and authority outage before publication", async () => {
    const fetchMock = mock(),
      auth = await authorization();
    await expect(
      writeRequestBuildGitHub(env, host, owner, { ...auth, publicationHash: "forged" }, operation),
    ).rejects.toThrow("BUILD_PUBLICATION_DENIED");
    await expect(
      writeRequestBuildGitHub(env, host, owner, auth, {
        ...operation,
        url: "https://evil.invalid",
      }),
    ).rejects.toThrow("BUILD_GITHUB_INPUT_INVALID");
    await expect(
      writeRequestBuildGitHub(env, host, owner, auth, {
        kind: "ref",
        branch: "main",
        sha: "a".repeat(40),
      }),
    ).rejects.toThrow("BUILD_GITHUB_INPUT_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      writeRequestBuildGitHub(
        env,
        { authorizeRequestBuild: async () => ({ allowed: false, reasons: ["ADMIN_REVOKED"] }) },
        owner,
        auth,
        operation,
      ),
    ).rejects.toThrow("BUILD_PUBLICATION_DENIED");
    expect(fetchMock).toHaveBeenCalledTimes(1); // Token response cannot authorize the following publication.
  });
  it("rejects expanded installation scopes or another repository", async () => {
    const auth = await authorization();
    for (const [scope, repo] of [
      [
        { contents: "write", metadata: "read", pull_requests: "write", issues: "write" },
        "totango/odie-os",
      ],
      [{ contents: "write", metadata: "read", pull_requests: "write" }, "other/repo"],
    ] as const) {
      const fetchMock = mock(scope, repo);
      await expect(writeRequestBuildGitHub(env, host, owner, auth, operation)).rejects.toThrow(
        "BUILD_GITHUB_TOKEN_SCOPE_INVALID",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
  it("reconciliation uses a separate read token with no actor or write permission", async () => {
    const fetchMock = mock({ contents: "read", metadata: "read", pull_requests: "read" });
    await readRequestBuildGitHub(env, { kind: "base" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      repositories: ["odie-os"],
      permissions: { contents: "read", metadata: "read", pull_requests: "read" },
    });
    expect(fetchMock.mock.calls[1][1].method).toBe("GET");
  });
});
