import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mintGitHubCodingSessionToken,
  mintGitHubOrganizationToken,
  type GitHubAppEnv,
} from "../src/github-app.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub App token scopes", () => {
  it("separates organization reads from repository-scoped coding writes", async () => {
    const keyPair = await crypto.subtle.generateKey({
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 1_024,
      publicExponent: Uint8Array.of(1, 0, 1),
      hash: "SHA-256",
    }, true, ["sign", "verify"]);
    const key = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey))
      .toString("base64");
    const env: GitHubAppEnv = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_PRIVATE_KEY:
        `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----`,
    };
    const fetchMock = vi.fn(async () => Response.json({
      token: "installation-token",
      expires_at: "2026-08-14T12:00:00Z",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await mintGitHubOrganizationToken(env);
    await mintGitHubCodingSessionToken(env, ["odie-os", "unison"]);

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      permissions: { contents: "read", metadata: "read" },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      repositories: ["odie-os", "unison"],
      permissions: { contents: "write", metadata: "read" },
    });
  });
});
