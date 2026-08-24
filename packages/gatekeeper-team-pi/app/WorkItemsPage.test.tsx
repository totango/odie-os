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
  WorkItemSourceStatuses,
  WorkItemSummary,
  WorkItemsManagementApi,
} from "../src/types";

type SavedView = { id: string; name: string; query: string; source: "both" | "jira" | "zendesk"; filters: { status: string; priority: string; type: string; person: string }; view: "list" | "kanban"; hiddenStatuses: string[] };

const statuses = {
  jira: { configured: true, connected: true },
  zendesk: { configured: true, connected: true },
} as const;
const EMPTY_TEST_FILTERS = { status: "", priority: "", type: "", person: "" };

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

const jacobItem: WorkItemSummary = {
  ...jiraItem,
  id: "1003",
  key: "ODIE-3",
  title: "Jacob owned issue",
  assignee: "Jacob Beck",
  status: "In Progress",
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

  it("opens an initial selected item and offers Code when GitHub access is available", async () => {
    const requestCodingSession = vi.fn<(target: { source: "jira" | "zendesk"; id: string; key?: string }, title: string) => void>();
    const api = createApi({ items: [jiraItem], itemApis: [createItemApi(readFor(jiraItem))] });
    await render(api, {
      initialRouteState: "selected=jira%3A1001%3AODIE-1",
      codingSessionAvailable: true,
      requestCodingSession,
    });

    expect(api.item).toHaveBeenCalledWith({ source: "jira", id: "1001", key: "ODIE-1" });
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    await clickText("Start coding session");
    expect(requestCodingSession).toHaveBeenCalledWith(
      { source: "jira", id: "1001", key: "ODIE-1" },
      "Work on ODIE-1: Jira login is slow",
    );
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
    expect(host.textContent).toContain("Assignee");
    await clickText("Customer cannot export");
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Requester");
  });

  it("opens details in an overlay sheet with no empty detail rail and keyboard resizing", async () => {
    const innerWidth = vi.spyOn(window, "innerWidth", "get").mockReturnValue(900);
    const api = createApi({ items: [jiraItem], itemApis: [createItemApi(readFor(jiraItem))] });
    await render(api);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toContain("Select a Jira issue or Zendesk ticket");
    await clickText("Jira login is slow");
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    expect(host.querySelector(".detail-backdrop")).toBeTruthy();
    const handle = host.querySelector<HTMLElement>('[aria-label="Resize detail panel"]')!;
    expect(handle.getAttribute("aria-valuenow")).toBe("520");
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(host.querySelector<HTMLElement>('[aria-label="Resize detail panel"]')?.getAttribute("aria-valuenow")).toBe("544");
    await act(async () => {
      innerWidth.mockReturnValue(380);
      window.dispatchEvent(new Event("resize"));
    });
    expect(host.querySelector<HTMLElement>('[aria-label="Resize detail panel"]')?.getAttribute("aria-valuenow")).toBe("360");
    await clickText("Close detail");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector("[data-row-key='jira:1001']"));
  });

  it("moves focus into the desktop detail sheet and traps tab navigation", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
    const api = createApi({ items: [jiraItem], itemApis: [createItemApi(readFor(jiraItem))] });
    await render(api);
    await clickText("Jira login is slow");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.activeElement).toBe(host.querySelector("[data-detail-back]"));
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const first = host.querySelector<HTMLElement>('[aria-label="Resize detail panel"]')!;
    first.focus();
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(first);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(host.querySelector('input[type="search"]'));
  });

  it("renders provider rich text and entities without unsafe HTML", async () => {
    const read = readFor(jiraItem);
    read.comments = [{
      id: "rich",
      author: "Ada",
      body: "**Bold**&nbsp;&nbsp;<em>safe</em><script>alert('x')</script><a href=\"javascript:alert(1)\">bad</a> ![beacon](https://tracker.example/pixel.gif) [ok](https://example.com)",
      public: true,
      createdAt: "2026-08-20T12:00:00Z",
    }];
    const api = createApi({ items: [jiraItem], itemApis: [createItemApi(read)] });
    await render(api);
    await clickText("Jira login is slow");
    const richText = host.querySelector(".rich-text")!;
    expect(richText.querySelector("strong")?.textContent).toBe("Bold");
    expect(richText.querySelector("em")?.textContent).toBe("safe");
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.innerHTML).not.toContain("alert('x')");
    expect(host.innerHTML).not.toContain("tracker.example");
    expect([...host.querySelectorAll("a")].some((a) => a.getAttribute("href")?.startsWith("javascript:"))).toBe(false);
    const safeLink = [...host.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent?.includes("ok"))!;
    expect(safeLink.href).toBe("https://example.com/");
    expect(safeLink.rel).toContain("noopener");
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
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector("[data-row-key='jira:1001']"));
  });

  it("searches only configured and connected sources and avoids setup conflicts", async () => {
    const api = createApi({
      items: [zendeskItem],
      statuses: { jira: { configured: true, connected: false, reason: "Conflict" }, zendesk: { configured: true, connected: true } },
    });
    await render(api);
    expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ source: "zendesk" }));
    expect(host.textContent).toContain("Customer cannot export");
    expect(host.textContent).not.toContain("Conflict");

    const unavailableApi = createApi({
      items: [jiraItem],
      statuses: { jira: { configured: true, connected: false, reason: "Conflict" }, zendesk: { configured: false, connected: false, reason: "Missing" } },
    });
    act(() => root?.unmount());
    root = undefined;
    host.textContent = "";
    await render(unavailableApi);
    expect(unavailableApi.search).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Provider setup");
    expect(host.textContent).not.toContain("Couldn’t load work items");
  });

  it("refreshes source status and searches newly available providers", async () => {
    let nextStatuses: WorkItemSourceStatuses = { jira: { configured: true, connected: false, reason: "Conflict" }, zendesk: { configured: false, connected: false, reason: "Missing" } };
    const api = createApi({ items: [jiraItem], statuses: () => nextStatuses });
    await render(api);
    expect(api.search).not.toHaveBeenCalled();
    nextStatuses = { jira: { configured: true, connected: true }, zendesk: { configured: false, connected: false, reason: "Missing" } };
    await clickText("Refresh work items");
    expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ source: "jira" }));
    expect(host.textContent).toContain("Jira login is slow");
  });

  it("does not search with stale statuses when status refresh fails", async () => {
    const api = createApi({ items: [jiraItem] });
    await render(api);
    api.search.mockClear();
    api.getSourceStatuses.mockRejectedValueOnce(new Error("status failed"));
    await clickText("Refresh work items");
    expect(api.search).not.toHaveBeenCalled();
    expect(host.textContent).toContain("status failed");
  });

  it("loads more from only providers that still have more results", async () => {
    const search = vi.fn<WorkItemsManagementApi["search"]>(async (request) => request.cursors?.jira ? {
      items: [{ ...jiraItem, id: "1002", key: "ODIE-2", title: "Second Jira item" }],
      cursors: {},
      hasMore: { jira: false },
    } : {
      items: [jiraItem, zendeskItem],
      cursors: { jira: "jira-next" },
      hasMore: { jira: true, zendesk: false },
    });
    const api = createApi({ search });
    await render(api);
    await clickText("Load more");
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ source: "jira", cursors: { jira: "jira-next" } }));
    expect(host.textContent).toContain("Jira login is slow");
    expect(host.textContent).toContain("Customer cannot export");
    expect(host.textContent).toContain("Second Jira item");
    expect([...host.querySelectorAll("[data-row-key='zendesk:222']")]).toHaveLength(1);
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

  it("defaults My work to the current user and tolerates email local-part vs display name", async () => {
    const api = createApi({ items: [jiraItem, jacobItem], currentUser: { displayName: "Jacob Beck", uniqueName: "jacob.beck@example.com" } });
    await render(api);
    await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 240)); });
    expect(host.textContent).toContain("Jacob owned issue");
    expect(host.textContent).not.toContain("Jira login is slow");
    expect([...host.querySelectorAll<HTMLSelectElement>(".filter-select select")].at(3)?.value).toBe("jacob.beck@example.com");
  });

  it("applies, saves, and deletes durable custom views without prompts", async () => {
    const saved: SavedView = { id: "custom:bugs", name: "Bugs", query: "login", source: "jira", filters: { ...EMPTY_TEST_FILTERS, type: "Bug" }, view: "kanban", hiddenStatuses: ["Done"] };
    const api = createApi({ items: [jiraItem], savedViews: [saved] });
    await render(api);
    await clickText("Bugs");
    expect(host.querySelector("[aria-label='Kanban column visibility']")).toBeTruthy();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 240)); });
    expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ source: "jira", query: "login" }));
    await changeText(host.querySelector<HTMLInputElement>(".save-view-name input")!, "Urgent");
    await clickText("Save view");
    expect(api.saveSavedView).toHaveBeenCalledWith(expect.objectContaining({ name: "Urgent", view: "kanban" }));
    await clickText("Delete");
    expect(api.deleteSavedView).toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("");
    expect(host.querySelector("[aria-label='Kanban column visibility']")).toBeNull();
  });

  it("renders searchable kanban columns with accessible hide and show controls", async () => {
    const api = createApi({ items: [jiraItem, jacobItem] });
    await render(api, { initialRouteState: "view=kanban&q=issue" });
    expect(host.textContent).toContain("To Do");
    expect(host.textContent).toContain("In Progress");
    const todoToggle = [...host.querySelectorAll<HTMLInputElement>(".kanban-controls input")].find((input) => input.parentElement?.textContent?.includes("To Do"))!;
    await act(async () => { todoToggle.click(); });
    expect(host.textContent).toContain("1 hidden");
    expect(host.querySelector("input[type='search']")).toBeTruthy();
  });

  it("can restore a saved hidden kanban status absent from current results", async () => {
    const api = createApi({ items: [jiraItem] });
    await render(api, { initialRouteState: "view=kanban&hiddenStatuses=Done" });
    const doneToggle = [...host.querySelectorAll<HTMLInputElement>(".kanban-controls input")]
      .find((input) => input.parentElement?.textContent?.includes("Done"));
    expect(doneToggle?.checked).toBe(false);
    await act(async () => { doneToggle?.click(); });
    expect(host.textContent).toContain("0 hidden");
  });

  it("preserves string identifiers during inline metadata editing", async () => {
    const read = readFor(jiraItem);
    read.updateOptions.allowedFields = ["assignee"];
    const itemApi = createItemApi(read);
    const api = createApi({ items: [jiraItem], itemApis: [itemApi] });
    await render(api);
    await clickText("Jira login is slow");
    await clickText("Edit Assignee");
    await changeText(host.querySelector<HTMLInputElement>('[aria-label="Assignee value"]')!, "12345");
    const save = [...host.querySelectorAll<HTMLButtonElement>(".meta-chip.editable button")]
      .find((button) => button.textContent === "Save")!;
    await act(async () => { save.click(); await Promise.resolve(); });
    expect(itemApi.updateFields).toHaveBeenCalledWith({ fields: { assignee: "12345" } });
  });

  it("edits description separately and omits unsafe description HTML", async () => {
    const read = readFor({ ...jiraItem, fields: { description: "Hello <script>bad()</script> **world**" } });
    read.updateOptions.allowedFields = ["description"];
    const itemApi = createItemApi(read);
    const api = createApi({ items: [jiraItem], itemApis: [itemApi] });
    await render(api);
    await clickText("Jira login is slow");
    expect(host.querySelector(".description-section strong")?.textContent).toBe("world");
    expect(host.querySelector("script")).toBeNull();
    await clickText("Edit");
    await changeText(host.querySelector<HTMLTextAreaElement>(".description-section textarea")!, "Updated description");
    await clickText("Save description");
    expect(itemApi.updateFields).toHaveBeenCalledWith({ fields: { description: "Updated description" } });
  });

  it("renders the complete returned description and blocks truncated edits", async () => {
    const longBody = `Intro\n\n${"Long description line.\n".repeat(80)}`;
    const read = readFor({ ...jiraItem, description: { body: longBody, format: "markdown" }, fields: {} });
    read.updateOptions.allowedFields = ["description"];
    const api = createApi({ items: [jiraItem], itemApis: [createItemApi(read)] });
    await render(api);
    await clickText("Jira login is slow");
    expect(host.textContent).toContain("Long description line.");
    expect(host.querySelector(".description-section")?.textContent).toContain("Intro");

    const truncated = readFor({ ...jiraItem, description: { body: "Partial only", format: "text", truncated: true }, fields: {} });
    truncated.updateOptions.allowedFields = ["description"];
    act(() => root?.unmount()); root = undefined; host.textContent = ""; sessionStorage.clear(); history.replaceState(null, "", "/");
    await render(createApi({ items: [jiraItem], itemApis: [createItemApi(truncated)] }));
    await clickText("Jira login is slow");
    expect(host.textContent).toContain("editing is disabled");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Edit"))).toBe(false);
  });

  it("renders attachment previews from blob URLs and revokes them on cleanup", async () => {
    if (!URL.createObjectURL) Object.assign(URL, { createObjectURL: () => "blob:stub", revokeObjectURL: () => {} });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:team-pi-attachment");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const read = readFor({ ...jiraItem, fields: {} });
    read.attachments = [
      { id: "a1", name: "screenshot.png", contentType: "image/png", size: 2048 },
      { id: "a2", name: "runbook.html", contentType: "text/html" },
    ];
    const itemApi = createItemApi(read);
    itemApi.readAttachment.mockImplementation(async (id) => ({ data: new Uint8Array([1, 2, 3]), name: id === "a1" ? "screenshot.png" : "runbook.html", contentType: id === "a1" ? "image/png" : "text/html" }));
    const api = createApi({ items: [jiraItem], itemApis: [itemApi] });
    await render(api);
    await clickText("Jira login is slow");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain("Attachments");
    expect(itemApi.readAttachment).not.toHaveBeenCalled();
    await clickText("Load preview for screenshot.png");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(itemApi.readAttachment).toHaveBeenCalledWith("a1");
    expect(itemApi.readAttachment).not.toHaveBeenCalledWith("a2");
    expect(host.querySelector<HTMLImageElement>(".attachment-card img")?.src).toBe("blob:team-pi-attachment");
    await clickText("Prepare download for runbook.html");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(itemApi.readAttachment).toHaveBeenCalledWith("a2");
    expect(host.querySelector(".attachment-card iframe")).toBeNull();
    expect(host.querySelector(".attachment-download")?.getAttribute("href")).toBe("blob:team-pi-attachment");
    await clickText("Close detail");
    await act(async () => { await Promise.resolve(); });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:team-pi-attachment");
    createObjectURL.mockRestore();
  });

  it("hides raw provider option and customfield text from visible detail UI", async () => {
    const read = readFor({ ...jiraItem, fields: { customfield_12345: "secret field", description: "Visible description" } });
    read.updateOptions.providerOptions = ["customfield_12345", "secret option"];
    const api = createApi({ items: [jiraItem], itemApis: [createItemApi(read)] });
    await render(api);
    await clickText("Jira login is slow");
    expect(host.textContent).toContain("Visible description");
    expect(host.textContent).not.toContain("customfield_12345");
    expect(host.textContent).not.toContain("secret option");
  });

  it("uses provider-specific safe new-tab links for item and markdown URLs", async () => {
    const read = readFor({ ...jiraItem, url: "https://jira.example/browse/ODIE-1", fields: { description: "[docs](/docs) [bad](javascript:alert(1))" } });
    const api = createApi({ items: [jiraItem], itemApis: [createItemApi(read)] });
    await render(api);
    await clickText("Jira login is slow");
    const providerLink = [...host.querySelectorAll<HTMLAnchorElement>("a")].find((link) => link.textContent?.includes("Open in Jira"))!;
    expect(providerLink.target).toBe("_blank");
    expect(providerLink.rel).toContain("noopener");
    expect(providerLink.getAttribute("aria-label")).toContain("opens in a new tab");
    const markdownLink = [...host.querySelectorAll<HTMLAnchorElement>("a")].find((link) => link.textContent?.includes("docs"))!;
    expect(markdownLink.href).toBe(`${location.origin}/docs`);
    expect(markdownLink.rel).toContain("noreferrer");
    expect(markdownLink.getAttribute("aria-label")).toContain("opens in a new tab");
    expect([...host.querySelectorAll<HTMLAnchorElement>("a")].some((link) => link.href.startsWith("javascript:"))).toBe(false);
  });

  it("keeps overflow-sensitive detail structure bounded while allowing code block scrolling", async () => {
    const read = readFor({ ...jiraItem, title: "x".repeat(500), description: { body: "```\n" + "long-code-line".repeat(80) + "\n```", format: "markdown" }, fields: {} });
    const api = createApi({ items: [jiraItem], itemApis: [createItemApi(read)] });
    await render(api);
    await clickText("Jira login is slow");
    expect(host.querySelector(".detail-pane")).toBeTruthy();
    expect(host.querySelector(".rich-text pre")).toBeTruthy();
  });

  it("debounces opposite-source link search and selects suggestions before linking", async () => {
    const itemApi = createItemApi(readFor(jiraItem));
    const api = createApi({ items: [jiraItem], itemApis: [itemApi], search: async (request) => request.query ? { items: [zendeskItem, jiraItem], cursors: {}, hasMore: {} } : { items: [jiraItem], cursors: {}, hasMore: {} } });
    await render(api);
    await clickText("Jira login is slow");
    await changeText(host.querySelector<HTMLInputElement>('[aria-label="Search or enter item ID/key to link"]')!, "export");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 280)); });
    expect(host.textContent).toContain("Customer cannot export");
    expect(host.querySelectorAll(".link-suggestions button")).toHaveLength(1);
    await clickText("Customer cannot export");
    await clickText("Create link");
    expect(itemApi.linkTo).toHaveBeenCalledWith({ source: "zendesk", id: "222", key: undefined });
  });
});

async function render(api: WorkItemsManagementApi, routeStateHost?: WorkItemsRouteStateHost) {
  await act(async () => {
    root = createRoot(host);
    root.render(<WorkItemsPage api={api} routeStateHost={routeStateHost} />);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
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

function createApi(options: { items?: WorkItemSummary[]; page?: WorkItemSearchPage; itemApis?: ReturnType<typeof createItemApi>[]; statuses?: WorkItemSourceStatuses | (() => WorkItemSourceStatuses | Promise<WorkItemSourceStatuses>); search?: WorkItemsManagementApi["search"]; currentUser?: { displayName?: string; uniqueName?: string }; savedViews?: SavedView[] }): WorkItemsManagementApi & {
  getSourceStatuses: ReturnType<typeof vi.fn<WorkItemsManagementApi["getSourceStatuses"]>>;
  search: ReturnType<typeof vi.fn<WorkItemsManagementApi["search"]>>;
  item: ReturnType<typeof vi.fn<WorkItemsManagementApi["item"]>>;
  getCurrentUser: ReturnType<typeof vi.fn<WorkItemsManagementApi["getCurrentUser"]>>;
  listSavedViews: ReturnType<typeof vi.fn<WorkItemsManagementApi["listSavedViews"]>>;
  saveSavedView: ReturnType<typeof vi.fn<WorkItemsManagementApi["saveSavedView"]>>;
  deleteSavedView: ReturnType<typeof vi.fn<WorkItemsManagementApi["deleteSavedView"]>>;
} {
  const queue = [...(options.itemApis ?? [])];
  const views = [...(options.savedViews ?? [])];
  return {
    getSourceStatuses: vi.fn<WorkItemsManagementApi["getSourceStatuses"]>(async () => typeof options.statuses === "function" ? options.statuses() : options.statuses ?? statuses),
    search: vi.fn<WorkItemsManagementApi["search"]>(options.search ?? (async () => options.page ?? { items: options.items ?? [], cursors: {}, hasMore: {} })),
    item: vi.fn<WorkItemsManagementApi["item"]>(async () => queue.shift() ?? createItemApi(readFor(options.items?.[0] ?? jiraItem))),
    getCurrentUser: vi.fn<WorkItemsManagementApi["getCurrentUser"]>(async () => options.currentUser ?? {}),
    listSavedViews: vi.fn<WorkItemsManagementApi["listSavedViews"]>(async () => views),
    saveSavedView: vi.fn<WorkItemsManagementApi["saveSavedView"]>(async (view) => { views.push(view); return view; }),
    deleteSavedView: vi.fn<WorkItemsManagementApi["deleteSavedView"]>(async (id) => { const index = views.findIndex((view) => view.id === id); if (index >= 0) views.splice(index, 1); }),
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
    readAttachment: vi.fn<WorkItemManagementApi["readAttachment"]>(async () => ({ data: new Uint8Array([1]), name: "attachment.bin", contentType: "application/octet-stream" })),
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
    attachments: [],
  };
}
