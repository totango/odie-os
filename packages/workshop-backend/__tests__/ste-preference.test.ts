import { describe, expect, it } from "vitest";

import { formatSimplifiedTechnicalEnglishDirective } from "../src/agent.js";

describe("Simplified Technical English response preference", () => {
  it("is omitted from the dynamic prompt when disabled", () => {
    expect(formatSimplifiedTechnicalEnglishDirective(false)).toBe("");
  });

  it("directs prose only and allows an explicit per-turn style override", () => {
    let directive = formatSimplifiedTechnicalEnglishDirective(true);

    expect(directive).toContain("Simplified Technical English");
    expect(directive).toContain("active voice");
    expect(directive).toContain("one idea per sentence");
    expect(directive).toContain("one consistent term");
    expect(directive).toContain("user-facing prose");
    expect(directive).toContain(
        "Do not simplify code, quotations, identifiers, domain terms, or tool payloads");
    expect(directive).toContain("current message explicitly asks for a different style");
  });
});
