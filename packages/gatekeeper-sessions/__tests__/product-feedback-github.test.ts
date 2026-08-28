import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductFeedbackEvidenceBundle } from "@gadgets/workshop-shared/coding-sessions";

vi.mock("../src/github-app.js", () => ({
  githubHeaders: () => new Headers({ authorization: "Bearer token" }),
  mintGitHubProductFeedbackToken: vi.fn(async () => ({ token: "token", expiresAt: Date.now() + 60_000 })),
}));

const { createDraftPullRequest } = await import("../src/product-feedback.js");

const evidence: ProductFeedbackEvidenceBundle = {
  id: "feedback-12345678",
  kind: "bug",
  title: "Private title",
  description: "Private description",
  submitterEmail: "user@totango.com",
  owner: { userId: "user-1", email: "user@totango.com" },
  pathname: "/workspace/private",
  expiresAt: new Date("2026-09-01T00:00:00Z"),
};

afterEach(() => vi.unstubAllGlobals());

describe("product feedback GitHub publishing", () => {
  it("reconciles an existing draft PR and still assigns the fixed owner", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([{ html_url: "https://github.com/totango/odie-os/pull/42", number: 42 }]))
      .mockResolvedValueOnce(Response.json({ assignees: [{ login: "jacobbeck-totango" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createDraftPullRequest({}, evidence, "feedback/feedback-12345678")).resolves.toEqual({
      url: "https://github.com/totango/odie-os/pull/42",
      number: 42,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("/issues/42/assignees");
  });

  it("creates a generic private-evidence-safe draft and assigns it", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ html_url: "https://github.com/totango/odie-os/pull/43", number: 43 }))
      .mockResolvedValueOnce(Response.json({ assignees: [{ login: "jacobbeck-totango" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await createDraftPullRequest({}, evidence, "feedback/feedback-12345678");

    const createBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(createBody).toMatchObject({ draft: true, head: "feedback/feedback-12345678", base: "main" });
    expect(createBody.title).not.toContain(evidence.title);
    expect(createBody.body).not.toContain(evidence.description);
    expect(createBody.body).not.toContain(evidence.submitterEmail);
    expect(fetchMock.mock.calls[2][0]).toContain("/issues/43/assignees");
  });
});
