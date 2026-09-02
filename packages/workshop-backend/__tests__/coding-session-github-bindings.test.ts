import { describe, expect, it } from "vitest";

import { codingSessionBindingId, codingSessionGitHubResourceUrls } from "../src/user.js";

describe("codingSessionGitHubResourceUrls", () => {
  it("scopes native GitHub coding-session bindings to selected Totango repositories", () => {
    expect(codingSessionGitHubResourceUrls(["odie-os", "leviosa-express"])).toEqual([
      "https://github.com/totango/odie-os",
      "https://github.com/totango/leviosa-express",
    ]);
  });

  it("does not nominate repositories without an authorized coding-session selection", () => {
    expect(codingSessionGitHubResourceUrls(undefined)).toEqual([]);
  });

  it("keeps one stable binding id per authorized repository URL", () => {
    const [resourceUrl] = codingSessionGitHubResourceUrls(["odie-os"]);

    expect(codingSessionBindingId("github", 12, resourceUrl)).toMatch(/^github-12-resource-[a-z0-9]+$/);
    expect(codingSessionBindingId("github", 12, resourceUrl))
      .toBe(codingSessionBindingId("github", 12, "https://github.com/totango/odie-os"));
    expect(codingSessionBindingId("github", 12, resourceUrl))
      .not.toBe(codingSessionBindingId("github", 12, "https://github.com/totango/other"));
  });
});
