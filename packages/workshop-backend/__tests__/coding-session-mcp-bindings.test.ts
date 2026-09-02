import { describe, expect, it } from "vitest";

import { codingSessionBindingId } from "../src/user.js";

describe("codingSessionBindingId", () => {
  it("keeps the legacy singleton/BYO binding id stable", () => {
    expect(codingSessionBindingId("mcp", 7)).toBe("mcp-7");
    expect(codingSessionBindingId("team_pi", 8)).toBe("team_pi-8");
  });

  it("creates stable valid ids for server-scoped portal resource URLs", () => {
    const github = codingSessionBindingId(
      "mcp_portal",
      42,
      "https://gw.example.com/mcp#server=github",
    );
    const jira = codingSessionBindingId(
      "mcp_portal",
      42,
      "https://gw.example.com/mcp#server=jira",
    );

    expect(github).toMatch(/^mcp_portal-42-github-[a-z0-9]+$/);
    expect(jira).toMatch(/^mcp_portal-42-jira-[a-z0-9]+$/);
    expect(github).not.toBe(jira);
    expect(codingSessionBindingId("mcp_portal", 42, "https://gw.example.com/mcp#server=github"))
      .toBe(github);
  });

  it("does not copy invalid URL text into the facet id", () => {
    expect(codingSessionBindingId("mcp_portal", 1, "not a url / #server=bad/value"))
      .toMatch(/^mcp_portal-1-resource-[a-z0-9]+$/);
  });
});
