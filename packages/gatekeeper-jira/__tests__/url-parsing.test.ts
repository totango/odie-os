import { describe, expect, it } from "vitest";
import { classifyJiraUrl, parseIssueKeyOrId, parseProjectKeyOrId } from "../src/jira-api";

describe("Jira URL parsing", () => {
  it("classifies Jira issue URLs", () => {
    expect(classifyJiraUrl("https://acme.atlassian.net/browse/ENG-123")).toEqual({ kind: "issue", host: "acme.atlassian.net", issueKey: "ENG-123", projectKey: "ENG" });
  });

  it("classifies project URLs", () => {
    expect(classifyJiraUrl("https://acme.atlassian.net/projects/ENG/summary")).toEqual({ kind: "project", host: "acme.atlassian.net", projectKey: "ENG" });
  });

  it("rejects non-Atlassian hosts", () => {
    expect(() => classifyJiraUrl("https://evil.example/browse/ENG-1")).toThrow(/Unsupported Jira Cloud host/);
  });

  it("parses bare issue and project references", () => {
    expect(parseIssueKeyOrId("eng-123")).toBe("ENG-123");
    expect(parseProjectKeyOrId("eng")).toBe("ENG");
  });
});
