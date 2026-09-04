// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorkItemDrawer from "./WorkItemDrawer";

const gatekeeperAppPage = vi.hoisted(() => vi.fn<(props: { appId: string; routeState?: string }) => React.ReactNode>(() => <div data-testid="work-items-app" />));
vi.mock("./GatekeeperAppPage", () => ({ default: gatekeeperAppPage }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("WorkItemDrawer", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    gatekeeperAppPage.mockClear();
  });

  it("hosts the selected Work Item beside chat and closes without navigation", async () => {
    const onClose = vi.fn<() => void>();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(
      <WorkItemDrawer
        appId="work-items"
        target={{ source: "jira", id: "AI-3540", key: "AI-3540" }}
        onClose={onClose}
      />,
    ));

    const pane = container.querySelector("aside")!;
    expect(pane.textContent).toContain("Work Item · AI-3540");
    expect(pane.classList).not.toContain("absolute");
    expect(gatekeeperAppPage).toHaveBeenCalledWith(expect.objectContaining({
      appId: "work-items",
      routeState: "selected=jira%3AAI-3540%3AAI-3540",
    }), undefined);

    const close = container.querySelector('button[aria-label="Close Work Item"]')!;
    expect(document.activeElement).toBe(close);
    await act(async () => close.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape and restores focus to the chat trigger when removed", async () => {
    const onClose = vi.fn<() => void>();
    const trigger = document.createElement("a");
    trigger.href = "#issue";
    document.body.append(trigger);
    trigger.focus();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(
      <WorkItemDrawer
        appId="work-items"
        target={{ source: "zendesk", id: "1234" }}
        onClose={onClose}
      />,
    ));

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
