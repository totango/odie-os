// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  codingSessionInputForWorkItem,
  normalizeWorkItemTarget,
  workItemRouteState,
  workItemTargetFromUrl,
} from "./workItemNavigation";

describe("work item chat navigation", () => {
  it("recognizes Jira browse links", () => {
    expect(workItemTargetFromUrl("https://example.atlassian.net/browse/ai-3540"))
      .toEqual({ source: "jira", id: "AI-3540", key: "AI-3540" });
  });

  it("recognizes Zendesk agent ticket links", () => {
    expect(workItemTargetFromUrl("https://example.zendesk.com/agent/tickets/109281"))
      .toEqual({ source: "zendesk", id: "109281" });
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
      "Start working on the Jira work item AI-3540. Use the connected Team PI Work Items tools to read the authoritative issue and related customer context before making changes.",
    );
    expect(normalizeWorkItemTarget("zendesk", "109281", undefined))
      .toEqual({ source: "zendesk", id: "109281" });
    expect(() => normalizeWorkItemTarget("jira", "1001", "bad\nkey")).toThrow("Invalid Jira work item key");
    expect(() => normalizeWorkItemTarget("zendesk", "not-a-ticket", undefined)).toThrow("Invalid Zendesk work item reference");
  });

  it("encodes the existing Work Items selected route state", () => {
    expect(workItemRouteState({ source: "jira", id: "1001", key: "AI-3540" }))
      .toBe("selected=jira%3A1001%3AAI-3540");
    expect(workItemRouteState({ source: "zendesk", id: "109281" }))
      .toBe("selected=zendesk%3A109281");
  });
});
