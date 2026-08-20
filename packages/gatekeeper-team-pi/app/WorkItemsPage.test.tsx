import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkItemsPage from "./WorkItemsPage";
import type { WorkItemsRouteStateHost } from "./bridge";
import type {
  WorkItemDetail,
  WorkItemManagementApi,
  WorkItemRead,
  WorkItemSearchPage,
  WorkItemSummary,
  WorkItemsManagementApi,
} from "../src/types";

const statuses = {
  jira: { configured: true, connected: true },
  zendesk: { configured: true, connected: true },
} as const;

const jiraItem: WorkItemSummary = {
  source: "jira",
  id: "1001",
  key: "ODIE-1",
  title: "Jira login is slow",
  status: "To Do",
  priority: "High",
  type: "Bug",
  assignee: "Ada",
  updatedAt: "2026-08-20T10:00:00Z",
  fields: { severity: "high" },
};

const zendeskItem: WorkItemSummary = {
  source: "zendesk",
  id: "222",
  title: "Customer cannot export",
  status: "open",
  priority: "normal",
  type: "question",
  requester: "Grace",
  updatedAt: "2026-08-20T11:00:00Z",
  fields: { tags: "export" },
};

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.restoreAllMocks();
});

describe("WorkItemsPage", () => {
  it("uses persisted hash source and query for the initial search", async () => {
    history.replaceState(null, "", "/#source=jira&q=login");
    const api = createApi({ items: [jiraItem] });
    await render(api);
    expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ source: "jira", query: "login" }));
    expect(host.textContent).toContain("Jira login is slow");
  });

  it("prefers initial host route state over hash and storage", async () => {
    sessionStorage.setItem("team-pi-work-items:v1", JSON.stringify({ query: "stored", source: "zendesk", filters: {}, selected: null }));
    history.replaceState(null, "", "/#source=zendesk&q=hash");
    const api = createApi({ items: [jiraItem] });
    await render(api, { initialRouteState: "source=jira&q=host" });
    expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ source: "jira", query: "host" }));
  });

  it("sends query state changes to the host route state bridge", async () => {
    const setRouteState = vi.fn<(value: string) => void>();
    const api = createApi({ items: [jiraItem] });
    await render(api, { initialRouteState: "", setRouteState });
    await changeText(host.querySelector<HTMLInputElement>('input[type="search"]')!, "refund");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
    expect(setRouteState).toHaveBeenLastCalledWith("q=refund");
    expect(location.hash).toBe("");
  });

  it("does not crash when opaque-origin storage and history access fail", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    vi.spyOn(history, "replaceState").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    const api = createApi({ items: [jiraItem] });
    await render(api);
    expect(host.textContent).toContain("Jira login is slow");
  });

  it("renders successful provider results when a both-provider search partially fails", async () => {
    const api = createApi({
      page: {
        items: [zendeskItem],
        cursors: {},
        hasMore: {},
        errors: [{ source: "jira", message: "Jira is temporarily unavailable" }],
      },
    });
    await render(api);
    expect(host.textContent).toContain("Customer cannot export");
    expect(host.textContent).toContain("Jira search failed");
  });

  it("selects items and disposes the prior per-item stub", async () => {
    const first = createItemApi(readFor(jiraItem));
    const second = createItemApi(readFor(zendeskItem));
    const api = createApi({ items: [jiraItem, zendeskItem], itemApis: [first, second] });
    await render(api);
    await clickText("Jira login is slow");
    expect(host.textContent).toContain("severity");
    await clickText("Customer cannot export");
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Requester");
  });

  it("defaults Zendesk comments to internal and requires an explicit public choice", async () => {
    const itemApi = createItemApi(readFor(zendeskItem));
    const api = createApi({ items: [zendeskItem], itemApis: [itemApi] });
    await render(api);
    await clickText("Customer cannot export");
    const textarea = host.querySelector("textarea")!;
    await changeText(textarea, "Internal investigation note");
    await clickText("Post comment");
    expect(itemApi.addComment).toHaveBeenCalledWith({ body: "Internal investigation note", visibility: "internal" });

    const publicRadio = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((input) => input.parentElement?.textContent?.includes("Public"))!;
    await act(async () => {
      publicRadio.click();
    });
    await changeText(textarea, "Public response");
    expect(host.textContent).toContain("visible to the requester");
    await clickText("Post comment");
    expect(itemApi.addComment).toHaveBeenLastCalledWith({ body: "Public response", visibility: "public" });
  });

  it("refreshes the selected read and full search after a mutation", async () => {
    const itemApi = createItemApi(readFor(jiraItem));
    const api = createApi({ items: [jiraItem], itemApis: [itemApi] });
    await render(api);
    await clickText("Jira login is slow");
    const textarea = host.querySelector("textarea")!;
    await changeText(textarea, "Public Jira comment");
    await clickText("Post comment");
    expect(itemApi.read).toHaveBeenCalledTimes(2);
    expect(api.search).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale mutation that resolves after switching selection", async () => {
    const deferred = createDeferred<WorkItemDetail>();
    const first = createItemApi(readFor(jiraItem));
    first.addComment.mockImplementation(async () => deferred.promise);
    const second = createItemApi(readFor(zendeskItem));
    const api = createApi({ items: [jiraItem, zendeskItem], itemApis: [first, second] });
    await render(api);
    await clickText("Jira login is slow");
    await changeText(host.querySelector("textarea")!, "slow mutation");
    await clickText("Post comment");
    await clickText("Customer cannot export");
    await act(async () => {
      deferred.resolve({ item: { ...jiraItem, title: "Stale Jira title" } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("Stale Jira title");
    expect(first.read).toHaveBeenCalledTimes(1);
    expect(second.read).toHaveBeenCalledTimes(1);
  });

  it("supports keyboard row navigation and Enter selection", async () => {
    const api = createApi({ items: [jiraItem, zendeskItem], itemApis: [createItemApi(readFor(zendeskItem))] });
    await render(api);
    const listbox = host.querySelector<HTMLElement>('[role="list"]')!;
    await act(async () => {
      listbox.focus();
      listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(async () => {
      listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(api.item).toHaveBeenCalledWith(expect.objectContaining({ source: "zendesk", id: "222" }));
  });

  it("offers an explicit mobile-friendly Back control that closes detail", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width: 900px"), media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
    const api = createApi({ items: [jiraItem], itemApis: [createItemApi(readFor(jiraItem))] });
    await render(api);
    await clickText("Jira login is slow");
    expect(host.textContent).toContain("Back");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.activeElement).toBe(host.querySelector("[data-detail-back]"));
    await clickText("Back");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain("Select a Jira issue or Zendesk ticket");
    expect(document.activeElement).toBe(host.querySelector("[data-row-key='jira:1001']"));
  });

  it("does not close detail on global Escape while editing text", async () => {
    const api = createApi({ items: [jiraItem], itemApis: [createItemApi(readFor(jiraItem))] });
    await render(api);
    await clickText("Jira login is slow");
    const textarea = host.querySelector("textarea")!;
    textarea.focus();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host.textContent).toContain("Jira login is slow");
  });
});

async function render(api: WorkItemsManagementApi, routeStateHost?: WorkItemsRouteStateHost) {
  await act(async () => {
    root = createRoot(host);
    root.render(<WorkItemsPage api={api} routeStateHost={routeStateHost} />);
  });
  await act(async () => { await Promise.resolve(); });
}

async function clickText(text: string) {
  const element = [...host.querySelectorAll<HTMLElement>("button, input, a")].find((node) => node.textContent?.includes(text) || node.getAttribute("aria-label")?.includes(text));
  if (!element) throw new Error(`Missing clickable text: ${text}`);
  await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); });
}

async function changeText(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    await Promise.resolve();
  });
}

function createApi(options: { items?: WorkItemSummary[]; page?: WorkItemSearchPage; itemApis?: ReturnType<typeof createItemApi>[] }): WorkItemsManagementApi & {
  search: ReturnType<typeof vi.fn<WorkItemsManagementApi["search"]>>;
  item: ReturnType<typeof vi.fn<WorkItemsManagementApi["item"]>>;
} {
  const queue = [...(options.itemApis ?? [])];
  return {
    getSourceStatuses: vi.fn<WorkItemsManagementApi["getSourceStatuses"]>(async () => statuses),
    search: vi.fn<WorkItemsManagementApi["search"]>(async () => options.page ?? { items: options.items ?? [], cursors: {}, hasMore: {} }),
    item: vi.fn<WorkItemsManagementApi["item"]>(async () => queue.shift() ?? createItemApi(readFor(options.items?.[0] ?? jiraItem))),
  };
}

function createItemApi(read: WorkItemRead) {
  const detail: WorkItemDetail = read.detail;
  const dispose = vi.fn<() => void>();
  const api = {
    read: vi.fn<WorkItemManagementApi["read"]>(async () => read),
    addComment: vi.fn<WorkItemManagementApi["addComment"]>(async () => detail),
    updateFields: vi.fn<WorkItemManagementApi["updateFields"]>(async () => detail),
    transition: vi.fn<WorkItemManagementApi["transition"]>(async () => detail),
    linkTo: vi.fn<WorkItemManagementApi["linkTo"]>(async () => ({ globalId: "team-pi:link", jiraId: "ODIE-1", zendeskTicketId: "222" })),
    dispose,
    [Symbol.dispose]() { dispose(); },
  } satisfies WorkItemManagementApi & { dispose: typeof dispose; [Symbol.dispose]: () => void };
  return api;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function readFor(item: WorkItemSummary): WorkItemRead {
  return {
    detail: { item },
    comments: [{ id: "c1", author: "Ada", body: "Existing comment", public: item.source === "jira", createdAt: "2026-08-20T12:00:00Z" }],
    activity: [{ id: "a1", type: "audit", author: "System", summary: "Status changed", createdAt: "2026-08-20T12:30:00Z" }],
    updateOptions: { source: item.source, id: item.id, key: item.key, allowedFields: ["priority", "tags"], providerOptions: ["high", "normal"] },
    transitions: item.source === "jira" ? [{ id: "31", name: "Start progress", toStatus: "In Progress" }] : [],
  };
}
