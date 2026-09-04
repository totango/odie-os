import { describe, expect, it } from "vitest";
import { adfToMarkdown, markdownToAdf } from "../src/jira-api";

describe("ADF conversion", () => {
  it("wraps markdown paragraphs in an ADF doc", () => {
    expect(markdownToAdf("one\n\ntwo")).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "one" }] },
        { type: "paragraph", content: [{ type: "text", text: "two" }] },
      ],
    });
  });

  it("extracts text from nested ADF content", () => {
    expect(adfToMarkdown({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] })).toBe("hello");
  });
});
