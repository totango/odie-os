import { describe, expect, it } from "vitest";
import {
  MAX_GATEKEEPER_APP_CODING_SESSION_TITLE_LENGTH,
  MAX_GATEKEEPER_APP_PROMPT_LENGTH,
  normalizeGatekeeperAppCodingSessionTitle,
  normalizeGatekeeperAppPrompt,
  parseGatekeeperAppWorkspaceTarget,
} from "./gatekeeperAppNavigation";

const WORKSPACE_ID = "a".repeat(64);

describe("parseGatekeeperAppWorkspaceTarget", () => {
  it("accepts a workspace ID with an optional gadget", () => {
    expect(parseGatekeeperAppWorkspaceTarget(WORKSPACE_ID, undefined)).toEqual({
      workspaceId: WORKSPACE_ID,
    });
    expect(parseGatekeeperAppWorkspaceTarget(WORKSPACE_ID, 0)).toEqual({
      workspaceId: WORKSPACE_ID,
      gadgetId: 0,
    });
  });

  it.each([
    ["", undefined],
    ["../admin", undefined],
    [WORKSPACE_ID.toUpperCase(), undefined],
    [`${WORKSPACE_ID}a`, undefined],
    [WORKSPACE_ID, -1],
    [WORKSPACE_ID, 1.5],
    [WORKSPACE_ID, 9_007_199_254_740_992],
    [WORKSPACE_ID, "1"],
  ])("rejects (%s, %s)", (workspaceId, gadgetId) => {
    expect(() => parseGatekeeperAppWorkspaceTarget(workspaceId, gadgetId)).toThrow(
      "Invalid gatekeeper app workspace target",
    );
  });
});

describe("normalizeGatekeeperAppPrompt", () => {
  it("trims a bounded visible prompt", () => {
    expect(normalizeGatekeeperAppPrompt("  Set up a daily brief.  ")).toBe("Set up a daily brief.");
  });

  it("rejects empty and oversized prompts", () => {
    expect(() => normalizeGatekeeperAppPrompt("   ")).toThrow("cannot be empty");
    expect(() =>
      normalizeGatekeeperAppPrompt("x".repeat(MAX_GATEKEEPER_APP_PROMPT_LENGTH + 1)),
    ).toThrow("too long");
  });
});


describe("normalizeGatekeeperAppCodingSessionTitle", () => {
  it("trims bounded titles and rejects unsafe values", () => {
    expect(normalizeGatekeeperAppCodingSessionTitle("  Work on AI-3540  ")).toBe("Work on AI-3540");
    expect(() => normalizeGatekeeperAppCodingSessionTitle("bad\ntitle")).toThrow("Invalid coding session title");
    expect(() => normalizeGatekeeperAppCodingSessionTitle("x".repeat(MAX_GATEKEEPER_APP_CODING_SESSION_TITLE_LENGTH + 1)))
      .toThrow("Invalid coding session title");
  });
});
