import { describe, expect, it } from "vitest";
import { validateOpenCodeCustomization } from "@gadgets/workshop-shared/coding-sessions";

describe("OpenCode customization validation", () => {
  it("accepts npm plugin names with optional versions and valid skills", () => {
    expect(validateOpenCodeCustomization({
      plugins: ["opencode-plugin", "@scope/plugin@1.2.3", "pkg@^2.0.0"],
      skills: [{ name: "review-code", description: "Review code", instructions: "Check the diff." }],
    })).toEqual({
      plugins: ["opencode-plugin", "@scope/plugin@1.2.3", "pkg@^2.0.0"],
      skills: [{ name: "review-code", description: "Review code", instructions: "Check the diff." }],
    });
  });

  it.each(["https://example.com/plugin", "git+ssh://example/repo", "file:../plugin", "bad plugin"])(
    "rejects non-package plugin references: %s",
    plugin => {
      expect(() => validateOpenCodeCustomization({ plugins: [plugin], skills: [] }))
        .toThrow("npm package names");
    },
  );

  it("rejects duplicates, invalid skill names, empty text, and oversize collections", () => {
    expect(() => validateOpenCodeCustomization({ plugins: ["pkg", "pkg"], skills: [] })).toThrow("Duplicate");
    expect(() => validateOpenCodeCustomization({
      plugins: [],
      skills: [{ name: "BadName", description: "ok", instructions: "ok" }],
    })).toThrow("kebab-case");
    expect(() => validateOpenCodeCustomization({
      plugins: [],
      skills: [{ name: "ok", description: "", instructions: "ok" }],
    })).toThrow("descriptions");
    expect(() => validateOpenCodeCustomization({
      plugins: Array.from({ length: 21 }, (_, index) => `pkg-${index}`),
      skills: [],
    })).toThrow("20 plugins");
  });
});
