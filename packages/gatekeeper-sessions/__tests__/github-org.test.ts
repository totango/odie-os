import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import {
  GitHubOrganizationGatekeeper,
  GitHubOrganizationSessionImpl,
  GitHubSourceRepositoryImpl,
} from "../src/github-org.js";

function approvalQueue() {
  const authorizeObservation = vi.fn(async () => {});
  const queue = {
    authorizeObservation,
    dup() { return queue; },
    [Symbol.dispose]() {},
  } as unknown as RpcStub<ApprovalQueue>;
  return { queue, authorizeObservation };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub organization source", () => {
  it("searches only installed repositories and records the observation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ repositories: [
      {
        name: "odie-os",
        full_name: "totango/odie-os",
        description: "Personal applications",
        html_url: "https://github.com/totango/odie-os",
        default_branch: "main",
        archived: false,
        updated_at: "2026-08-14T00:00:00Z",
      },
      {
        name: "other",
        full_name: "another-org/other",
        description: "Unrelated",
        html_url: "https://github.com/another-org/other",
        default_branch: "main",
        archived: false,
        updated_at: "2026-08-14T00:00:00Z",
      },
    ] })));
    const approval = approvalQueue();
    const session = new GitHubOrganizationSessionImpl(async () => "token", approval.queue);

    await expect(session.searchRepositories("odie", 1)).resolves.toEqual([
      expect.objectContaining({ name: "odie-os", fullName: "totango/odie-os" }),
    ]);
    expect(approval.authorizeObservation).toHaveBeenCalledOnce();
    expect(approval.authorizeObservation).toHaveBeenCalledWith(expect.objectContaining({
      domainSharingPolicy: { type: "verified-sso-email-domain", emailDomain: "totango.com" },
    }));
  });

  it("reads bounded UTF-8 source and records the exact path", async () => {
    const content = btoa("export const answer = 42;\n");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      type: "file",
      name: "answer.ts",
      path: "src/answer.ts",
      sha: "abc123",
      size: 26,
      html_url: "https://github.com/totango/odie-os/blob/main/src/answer.ts",
      encoding: "base64",
      content,
    })));
    const approval = approvalQueue();
    const repository = new GitHubSourceRepositoryImpl(
      "odie-os", async () => "token", approval.queue);

    const result = await repository.readFile("src/answer.ts", "main");
    expect(result).toMatchObject({
      repository: "totango/odie-os",
      path: "src/answer.ts",
      ref: "main",
      content: "export const answer = 42;\n",
    });
    expect(approval.authorizeObservation).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining("src/answer.ts"),
      domainSharingPolicy: { type: "verified-sso-email-domain", emailDomain: "totango.com" },
    }));
  });

  it("declares Totango SSO sharing and admits observers", async () => {
    const gatekeeper = Object.create(GitHubOrganizationGatekeeper.prototype) as GitHubOrganizationGatekeeper;
    await expect(gatekeeper.describe()).resolves.toMatchObject({
      domainSharingPolicy: { type: "verified-sso-email-domain", emailDomain: "totango.com" },
    });
    await expect(gatekeeper.addObserver("observer", {} as never)).resolves.toBeUndefined();
  });

  it("rejects traversal, oversized files, and excessive limits", async () => {
    const approval = approvalQueue();
    const repository = new GitHubSourceRepositoryImpl(
      "odie-os", async () => "token", approval.queue);
    await expect(repository.readFile("../secret")).rejects.toThrow(/Invalid file path/);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      type: "file", name: "large", path: "large", sha: "abc", size: 256 * 1024 + 1,
      html_url: null, encoding: "base64", content: "",
    })));
    await expect(repository.readFile("large")).rejects.toThrow(/larger than 256 KiB/);

    const session = new GitHubOrganizationSessionImpl(async () => "token", approval.queue);
    await expect(session.searchRepositories("odie", 51)).rejects.toThrow(/between 1 and 50/);
    expect(approval.authorizeObservation).not.toHaveBeenCalled();
  });
});
