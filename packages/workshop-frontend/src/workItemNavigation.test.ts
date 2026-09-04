// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  codingSessionInputForWorkItem,
  normalizeWorkItemTarget,
  workItemRouteState,
  workItemTargetFromUrl,
} from "./workItemNavigation";

describe("work item chat navigation", () => {
  it("recognizes Jira browse links on Atlassian tenant origins", () => {
    expect(workItemTargetFromUrl("https://example.atlassian.net/browse/ai-3540"))
      .toEqual({ source: "jira", id: "AI-3540", key: "AI-3540", url: "https://example.atlassian.net/browse/ai-3540" });
  });

  it("recognizes Zendesk agent ticket links", () => {
    expect(workItemTargetFromUrl("https://example.zendesk.com/agent/tickets/109281"))
      .toEqual({ source: "zendesk", id: "109281", url: "https://example.zendesk.com/agent/tickets/109281" });
  });

  it("preserves multi-site provider URLs through route state and coding prompts", () => {
    const first = workItemTargetFromUrl("https://first.atlassian.net/browse/ODIE-1")!;
    const second = workItemTargetFromUrl("https://second.atlassian.net/browse/ODIE-1")!;

    expect(first).not.toEqual(second);
    expect(workItemRouteState(first)).toBe("selected=jira%3AODIE-1%3AODIE-1&selectedUrl=https%3A%2F%2Ffirst.atlassian.net%2Fbrowse%2FODIE-1");
    expect(codingSessionInputForWorkItem(second)).toContain("The original provider URL is https://second.atlassian.net/browse/ODIE-1; use that URL to select the exact Jira site");
  });

  it("does not reinterpret unrelated or malformed links", () => {
    expect(workItemTargetFromUrl("https://example.com/reports/AI-3540")).toBeNull();
    expect(workItemTargetFromUrl("https://example.com/browse/AI-3540")).toBeNull();
    expect(workItemTargetFromUrl("https://example.com/agent/tickets/109281")).toBeNull();
    expect(workItemTargetFromUrl("javascript:alert(1)")).toBeNull();
    expect(workItemTargetFromUrl("https://example.com/agent/tickets/not-a-number")).toBeNull();
  });

  it("validates structured handoffs and builds a fixed Workshop-owned prompt", () => {
    const target = normalizeWorkItemTarget("jira", "1001", "ai-3540");
    expect(target).toEqual({ source: "jira", id: "1001", key: "AI-3540" });
    expect(codingSessionInputForWorkItem(target)).toBe(
      "Start working on the Jira work item AI-3540. Use the connected native JIRA_SITE, JIRA_PROJECT, or JIRA_ISSUE binding and its Jira coding tools to read the authoritative work item before making changes.",
    );
    expect(normalizeWorkItemTarget("zendesk", "109281", undefined))
      .toEqual({ source: "zendesk", id: "109281" });
    expect(() => normalizeWorkItemTarget("jira", "1001", "bad\nkey")).toThrow("Invalid Jira work item key");
    expect(() => normalizeWorkItemTarget("zendesk", "not-a-ticket", undefined)).toThrow("Invalid Zendesk work item reference");
    expect(() => normalizeWorkItemTarget("jira", "1001", "AI-3540", "https://other.atlassian.net/browse/AI-9999")).toThrow("Jira provider URL does not match work item key");
    expect(() => normalizeWorkItemTarget("zendesk", "109281", undefined, "https://example.atlassian.net/browse/AI-3540")).toThrow("Invalid work item provider URL");
  });

  it("encodes the existing Work Items selected route state", () => {
    expect(workItemRouteState({ source: "jira", id: "1001", key: "AI-3540" }))
      .toBe("selected=jira%3A1001%3AAI-3540");
    expect(workItemRouteState({ source: "zendesk", id: "109281" }))
      .toBe("selected=zendesk%3A109281");
  });
});
