import { describe, expect, it } from "vitest";
import { gitRepositoryFromUrl, validateRepositories } from "../src/policy.js";

describe("coding session repository policy", () => {
  it("canonically orders a valid multi-repo set", () => {
    expect(validateRepositories(["zords", "agentic"])).toEqual(["agentic", "zords"]);
  });

  it("rejects empty, duplicate, and unknown repository sets", () => {
    expect(() => validateRepositories([])).toThrow("Select at least one")
    expect(() => validateRepositories(["agentic", "agentic"])).toThrow("invalid")
    expect(() => validateRepositories(["unknown" as "agentic"])).toThrow("invalid")
  });

  it.each([
    ["https://github.com/totango/agentic.git", "agentic"],
    ["https://github.com/totango/unison-integrations.git/info/refs?service=git-upload-pack", "unison-integrations"],
    ["https://github.com/totango/jarvis.git/git-receive-pack", "jarvis"],
  ])("accepts canonical Git smart-HTTP URL %s", (value, expected) => {
    expect(gitRepositoryFromUrl(new URL(value))).toBe(expected)
  });

  it.each([
    "http://github.com/totango/agentic.git",
    "https://github.com.evil.test/totango/agentic.git",
    "https://github.com@evil.test/totango/agentic.git",
    "https://github.com/totango/not-allowed.git",
    "https://github.com/totango/agentic",
    "https://github.com/totango/agentic.git/releases",
    "https://github.com:444/totango/agentic.git",
  ])("rejects non-canonical or unallowlisted URL %s", (value) => {
    expect(gitRepositoryFromUrl(new URL(value))).toBeNull()
  });
});
