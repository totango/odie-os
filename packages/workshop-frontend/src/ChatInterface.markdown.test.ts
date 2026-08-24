// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItemTarget } from "./workItemNavigation";
import { chatInterfaceLayoutDirection, MarkdownMessage } from "./ChatInterface";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ChatInterface layout", () => {
  it("reflows an open Work Item beside chat outside sidebar mode", () => {
    expect(chatInterfaceLayoutDirection(false, false)).toBe("flex-col");
    expect(chatInterfaceLayoutDirection(false, true)).toBe("flex-row");
    expect(chatInterfaceLayoutDirection(true, false)).toBe("flex-row");
  });
});

describe("MarkdownMessage line breaks", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
  });

  async function render(message: string, onOpenWorkItem?: (target: WorkItemTarget) => void) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(MarkdownMessage, { message, onOpenWorkItem })));
  }

  // The user-message fix relies on Markdown preserving a single newline as a literal "\n"
  // in the DOM, so the `whitespace-pre-wrap` wrapper renders it as a hard line break. If a
  // dependency upgrade (react-markdown / remark-gfm) ever collapsed it to a space, the
  // visual fix would silently break; this test guards that invariant.
  it("preserves a single newline within a paragraph as a literal newline", async () => {
    await render("line one\nline two");

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs.length).toBe(1);
    expect(paragraphs[0].textContent).toBe("line one\nline two");
  });

  it("still renders a blank line as a paragraph break (two <p>)", async () => {
    await render("para one\n\npara two");

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs.length).toBe(2);
    expect(paragraphs[0].textContent).toBe("para one");
    expect(paragraphs[1].textContent).toBe("para two");
  });

  it("opens Jira links in Work Items on an ordinary click", async () => {
    const onOpenWorkItem = vi.fn<(target: WorkItemTarget) => void>();
    await render("[AI-3540](https://example.atlassian.net/browse/AI-3540)", onOpenWorkItem);

    const link = container.querySelector("a")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => link.dispatchEvent(click));

    expect(click.defaultPrevented).toBe(true);
    expect(onOpenWorkItem).toHaveBeenCalledWith({ source: "jira", id: "AI-3540", key: "AI-3540" });
    expect(link.getAttribute("aria-label")).toBe("Open AI-3540 in Work Items");
  });

  it("keeps modified clicks and unrelated links external", async () => {
    const onOpenWorkItem = vi.fn<(target: WorkItemTarget) => void>();
    await render("[AI-3540](https://example.atlassian.net/browse/AI-3540) [Report](https://example.com/report)", onOpenWorkItem);

    const [jira, report] = [...container.querySelectorAll("a")];
    expect(jira.target).toBe("");
    expect(jira.rel).toBe("");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const modifiedClick = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    await act(async () => jira.dispatchEvent(modifiedClick));
    expect(modifiedClick.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith(
      "https://example.atlassian.net/browse/AI-3540",
      "_blank",
      "noopener,noreferrer",
    );
    expect(onOpenWorkItem).not.toHaveBeenCalled();
    expect(report.target).toBe("_blank");
    expect(report.rel).toBe("noopener noreferrer");
  });
});
