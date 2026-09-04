import { describe, expect, it, vi } from "vitest";
import { composeWorkItemsApi, type HostCompositionApi, type WorkItemsShellRuntimeApi } from "./composition";
import type { WorkItemManagementApi, WorkItemsManagementApi } from "../src/types";

function itemApi(source: "jira" | "zendesk", overrides: Partial<WorkItemManagementApi> = {}): WorkItemManagementApi & { dispose: ReturnType<typeof vi.fn>; [Symbol.dispose]: () => void } {
  const detail = { item: { source, id: `${source}-1`, key: source === "jira" ? "ODIE-1" : undefined, url: source === "jira" ? "https://jira-a.example.atlassian.net/browse/ODIE-1" : "https://support.example.zendesk.com/agent/tickets/222", title: source, fields: {} } };
  const dispose = vi.fn();
  return {
    read: vi.fn(async () => ({ detail, comments: [], activity: [], updateOptions: { source, id: `${source}-1`, allowedFields: ["assignee"] }, transitions: source === "jira" ? [{ id: "31", name: "Done" }] : [], attachments: [] })),
    addComment: vi.fn(async () => detail),
    updateFields: vi.fn(async () => detail),
    transition: vi.fn(async () => detail),
    linkTo: vi.fn(async (other) => ({ globalId: "work-items:link", jiraId: source === "jira" ? `${source}-1` : other.id, zendeskTicketId: source === "zendesk" ? `${source}-1` : other.id })),
    readAttachment: vi.fn(async (id) => ({ data: new Uint8Array([1, 2, 3]), name: `${id}.bin`, contentType: "application/octet-stream" })),
    mediaCapabilities: vi.fn(async () => ({ uploads: true, uploadMode: source === "jira" ? "immediate-issue" as const : "staged-comment" as const, targets: ["comment" as const], inlineImages: false, inlineVideos: false, maxBytes: 1024, acceptedContentTypes: ["image/png"] })),
    createAttachment: vi.fn(async (input) => ({ attachment: { id: "a1", name: input.name, contentType: input.contentType, size: input.data.byteLength }, uploadMode: source === "jira" ? "immediate-issue" as const : "staged-comment" as const, target: input.target, supportsInline: false })),
    dispose,
    [Symbol.dispose]() { dispose(); },
    ...overrides,
  };
}

function sourceApi(source: "jira" | "zendesk", overrides: Partial<WorkItemsManagementApi> = {}): WorkItemsManagementApi {
  return {
    getCurrentUser: vi.fn(async () => ({ displayName: source === "jira" ? "Jira User" : "Zendesk User", uniqueName: `${source}@example.test` })),
    listSavedViews: vi.fn(),
    saveSavedView: vi.fn(),
    deleteSavedView: vi.fn(),
    getSourceStatuses: vi.fn(async () => ({ jira: { configured: source === "jira", connected: source === "jira" }, zendesk: { configured: source === "zendesk", connected: source === "zendesk" } })),
    search: vi.fn(async (_request) => ({ items: [{ source, id: `${source}-1`, key: source === "jira" ? "ODIE-1" : undefined, url: source === "jira" ? "https://jira-a.example.atlassian.net/browse/ODIE-1" : "https://support.example.zendesk.com/agent/tickets/222", title: source, fields: {} }], cursors: {}, hasMore: { [source]: false } })),
    item: vi.fn(async () => itemApi(source)),
    ...overrides,
  };
}

describe("Work Items source composition", () => {
  it("selects role-tagged embedded Jira and Zendesk capabilities through the Workshop host", async () => {
    const jira = sourceApi("jira");
    const zendesk = sourceApi("zendesk");
    const shell = { listSavedViews: vi.fn(async () => []), saveSavedView: vi.fn(), deleteSavedView: vi.fn() } as WorkItemsShellRuntimeApi;
    const host = {
      ui: shell,
      listCapabilities: vi.fn(async () => [
        { id: "jira-app", vendorId: "jira", title: "Jira", composition: { kind: "work-items", role: "jira", embeddedOnly: true } },
        { id: "zendesk-app", vendorId: "zendesk", title: "Zendesk", composition: { kind: "work-items", role: "zendesk", embeddedOnly: true } },
        { id: "other", vendorId: "other", title: "Other", composition: { kind: "work-items", role: "jira" } },
      ]),
      getCapability: vi.fn(async (id: string) => id === "jira-app" ? jira : id === "zendesk-app" ? zendesk : null),
    } as HostCompositionApi;

    const api = await composeWorkItemsApi(host);
    await expect(api.getCurrentUser()).resolves.toEqual({ displayName: "Jira User", uniqueName: "jira@example.test" });
    await expect(api.search({ source: "both", limit: 10 })).resolves.toMatchObject({ items: [{ source: "jira" }, { source: "zendesk" }] });
    expect(host.getCapability).toHaveBeenCalledWith("jira-app");
    expect(host.getCapability).toHaveBeenCalledWith("zendesk-app");
  });

  it("rejects self-labeled Work Items source providers before requesting their capabilities", async () => {
    const jira = sourceApi("jira");
    const host = {
      ui: { listSavedViews: vi.fn(), saveSavedView: vi.fn(), deleteSavedView: vi.fn() },
      listCapabilities: vi.fn(async () => [
        { id: "spoofed-jira", vendorId: "zendesk", title: "Bad Jira", composition: { kind: "work-items", role: "jira", embeddedOnly: true } },
        { id: "spoofed-zendesk", vendorId: "jira", title: "Bad Zendesk", composition: { kind: "work-items", role: "zendesk", embeddedOnly: true } },
        { id: "wrong-kind", vendorId: "jira", title: "Wrong Kind", composition: { kind: "other", role: "jira", embeddedOnly: true } },
        { id: "visible-jira", vendorId: "jira", title: "Visible Jira", composition: { kind: "work-items", role: "jira" } },
        { id: "jira-app", vendorId: "jira", title: "Jira", composition: { kind: "work-items", role: "jira", embeddedOnly: true } },
      ]),
      getCapability: vi.fn(async (id: string) => id === "jira-app" ? jira : null),
    } as HostCompositionApi;

    const api = await composeWorkItemsApi(host);
    await expect(api.search({ source: "jira" })).resolves.toMatchObject({ items: [{ source: "jira" }] });
    expect(host.getCapability).toHaveBeenCalledTimes(1);
    expect(host.getCapability).toHaveBeenCalledWith("jira-app");
  });

  it("isolates missing or failed sources as partial failures", async () => {
    const jira = sourceApi("jira", { search: vi.fn(async () => { throw new Error("Jira down"); }) });
    const host = {
      ui: { listSavedViews: vi.fn(), saveSavedView: vi.fn(), deleteSavedView: vi.fn() },
      listCapabilities: vi.fn(async () => [{ id: "jira-app", vendorId: "jira", title: "Jira", composition: { kind: "work-items", role: "jira", embeddedOnly: true } }]),
      getCapability: vi.fn(async () => jira),
    } as HostCompositionApi;
    const api = await composeWorkItemsApi(host);
    await expect(api.search({ source: "both" })).resolves.toMatchObject({
      items: [],
      errors: [{ source: "jira", message: "Jira down" }, { source: "zendesk", message: "No zendesk Work Items source is connected." }],
    });
  });

  it("forwards statuses, search, item reads, direct mutations, attachments, and links to exact source contracts", async () => {
    const jiraItem = itemApi("jira");
    const zendeskItem = itemApi("zendesk");
    const jira = sourceApi("jira", { item: vi.fn(async () => jiraItem) });
    const zendesk = sourceApi("zendesk", { item: vi.fn(async () => zendeskItem) });
    const host = hostWithSources({ jira, zendesk });
    const api = await composeWorkItemsApi(host);

    await expect(api.getSourceStatuses()).resolves.toEqual({
      jira: { configured: true, connected: true },
      zendesk: { configured: true, connected: true },
    });
    await api.search({ source: "jira", query: "ODIE", limit: 5, cursors: { jira: "c1" } });
    expect(jira.search).toHaveBeenCalledWith({ source: "jira", query: "ODIE", limit: 5, cursors: { jira: "c1" } });

    const item = await api.item({ source: "jira", id: "ODIE-1", key: "ODIE-1" });
    expect(jira.item).toHaveBeenCalledWith({ source: "jira", id: "ODIE-1", key: "ODIE-1" });
    await item.read();
    await item.addComment({ body: "done", visibility: "public" });
    await item.updateFields({ fields: { assignee: "123" } });
    await item.transition("31");
    await item.readAttachment("a1");
    await item.mediaCapabilities();
    await item.createAttachment({ name: "a.png", contentType: "image/png", data: new Uint8Array([1]), target: "comment" });
    await item.linkTo({ source: "jira", id: "ODIE-2", key: "ODIE-2" });
    (item as WorkItemManagementApi & { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();

    expect(jiraItem.read).toHaveBeenCalledTimes(1);
    expect(jiraItem.addComment).toHaveBeenCalledWith({ body: "done", visibility: "public" });
    expect(jiraItem.updateFields).toHaveBeenCalledWith({ fields: { assignee: "123" } });
    expect(jiraItem.transition).toHaveBeenCalledWith("31");
    expect(jiraItem.readAttachment).toHaveBeenCalledWith("a1");
    expect(jiraItem.createAttachment).toHaveBeenCalledWith({ name: "a.png", contentType: "image/png", data: new Uint8Array([1]), target: "comment" });
    expect(jiraItem.linkTo).toHaveBeenCalledWith({ source: "jira", id: "ODIE-2", key: "ODIE-2" });
    expect(jiraItem.dispose).toHaveBeenCalledTimes(1);
    expect(zendeskItem.read).not.toHaveBeenCalled();
  });

  it("disables cross-provider linking locally instead of falling back to an unsupported provider", async () => {
    const jiraItem = itemApi("jira", { linkTo: vi.fn(async () => { throw new Error("Jira cannot link"); }) });
    const zendeskItem = itemApi("zendesk");
    const api = await composeWorkItemsApi(hostWithSources({ jira: sourceApi("jira", { item: vi.fn(async () => jiraItem) }), zendesk: sourceApi("zendesk", { item: vi.fn(async () => zendeskItem) }) }));
    const item = await api.item({ source: "jira", id: "ODIE-1" });
    await expect(item.linkTo({ source: "zendesk", id: "222", url: "https://support.example.zendesk.com/agent/tickets/222" })).rejects.toThrow(/Cross-provider Work Items linking is disabled/);
    expect(jiraItem.linkTo).not.toHaveBeenCalled();
    expect(zendeskItem.linkTo).not.toHaveBeenCalled();
    expect(zendeskItem.dispose).not.toHaveBeenCalled();
  });

  it("isolates unavailable and malformed listed sources without blanking healthy providers", async () => {
    const unavailable = hostWithSources({ jira: null });
    const api = await composeWorkItemsApi(unavailable);
    await expect(api.getSourceStatuses()).resolves.toMatchObject({ jira: { connected: false } });

    const malformed = await composeWorkItemsApi(hostWithSources({ jira: { getCurrentUser: vi.fn() }, zendesk: sourceApi("zendesk") }));
    await expect(malformed.getSourceStatuses()).resolves.toEqual({
      jira: { configured: false, connected: false, reason: "jira Work Items source does not implement required Work Items composition method getSourceStatuses." },
      zendesk: { configured: true, connected: true },
    });
    await expect(malformed.search({ source: "both" })).resolves.toMatchObject({
      items: [{ source: "zendesk" }],
      errors: [{ source: "jira", message: "jira Work Items source does not implement required Work Items composition method getSourceStatuses." }],
    });
  });

  it("merges current user from the first complete healthy source identity", async () => {
    const jira = sourceApi("jira", { getCurrentUser: vi.fn(async () => ({ uniqueName: "jira@example.test" })) });
    const zendesk = sourceApi("zendesk", { getCurrentUser: vi.fn(async () => ({ displayName: "Zendesk User", uniqueName: "zendesk@example.test" })) });
    const api = await composeWorkItemsApi(hostWithSources({ jira, zendesk }));
    await expect(api.getCurrentUser()).resolves.toEqual({ displayName: "Zendesk User", uniqueName: "zendesk@example.test" });
  });

  it("surfaces unsupported provider operations as failures rather than false successes", async () => {
    const zendeskItem = itemApi("zendesk", {
      transition: vi.fn(async () => { throw new Error("Zendesk transitions are unsupported."); }),
      linkTo: vi.fn(async () => { throw new Error("Zendesk linking is unsupported."); }),
    });
    const api = await composeWorkItemsApi(hostWithSources({ zendesk: sourceApi("zendesk", { item: vi.fn(async () => zendeskItem) }) }));
    const item = await api.item({ source: "zendesk", id: "222" });
    await expect(item.transition("31")).rejects.toThrow("Zendesk transitions are unsupported.");
    await expect(item.linkTo({ source: "jira", id: "ODIE-1" })).rejects.toThrow(/Cross-provider Work Items linking is disabled/);
    expect(zendeskItem.transition).toHaveBeenCalledWith("31");
    expect(zendeskItem.linkTo).not.toHaveBeenCalled();
  });

  it("retains trusted provider URLs through search, selection, detail, update, attachment, and link handoffs", async () => {
    const jiraItem = itemApi("jira");
    const jira = sourceApi("jira", { item: vi.fn(async () => jiraItem) });
    const api = await composeWorkItemsApi(hostWithSources({ jira }));
    const page = await api.search({ source: "jira", query: "ODIE" });
    const ref = page.items[0]!;

    expect(ref).toMatchObject({ source: "jira", id: "jira-1", key: "ODIE-1", url: "https://jira-a.example.atlassian.net/browse/ODIE-1" });
    const item = await api.item(ref);
    expect(jira.item).toHaveBeenCalledWith({ source: "jira", id: "https://jira-a.example.atlassian.net/browse/ODIE-1", key: "ODIE-1", url: "https://jira-a.example.atlassian.net/browse/ODIE-1" });
    await item.read();
    await item.updateFields({ fields: { priority: "High" } });
    await item.readAttachment("a1");
    await item.linkTo({ source: "jira", id: "jira-2", key: "ODIE-2", url: "https://jira-b.example.atlassian.net/browse/ODIE-2" });
    expect(jiraItem.linkTo).toHaveBeenCalledWith({ source: "jira", id: "https://jira-b.example.atlassian.net/browse/ODIE-2", key: "ODIE-2", url: "https://jira-b.example.atlassian.net/browse/ODIE-2" });
  });

  it("drops malformed source results without leaking them into healthy provider results", async () => {
    const jira = sourceApi("jira", { search: vi.fn(async () => ({ items: [{ source: "zendesk" as const, id: "foreign", title: "wrong provider", fields: {} }], cursors: {}, hasMore: { jira: false } })) });
    const zendesk = sourceApi("zendesk");
    const api = await composeWorkItemsApi(hostWithSources({ jira, zendesk }));
    await expect(api.search({ source: "both" })).resolves.toMatchObject({
      items: [{ source: "zendesk", id: "zendesk-1" }],
      errors: [{ source: "jira", message: expect.stringContaining("Dropped malformed jira search result") }],
    });
  });

  it("rejects malformed item capabilities at selection time", async () => {
    const jira = {
      getCurrentUser: vi.fn(async () => ({ displayName: "Jira User" })),
      getSourceStatuses: vi.fn(async () => ({ jira: { configured: true, connected: true } })),
      search: vi.fn(async () => ({ items: [], cursors: {}, hasMore: { jira: false } })),
      item: vi.fn(async () => ({ read: vi.fn() })),
    };
    const api = await composeWorkItemsApi(hostWithSources({ jira }));
    await expect(api.item({ source: "jira", id: "ODIE-1" })).rejects.toThrow(/required Work Items composition method readAttachment/);
  });
});

function hostWithSources(sources: { jira?: WorkItemsManagementApi | null | object; zendesk?: WorkItemsManagementApi | null | object }): HostCompositionApi {
  return {
    ui: { listSavedViews: vi.fn(), saveSavedView: vi.fn(), deleteSavedView: vi.fn() } as WorkItemsShellRuntimeApi,
    listCapabilities: vi.fn(async () => Object.keys(sources).map((role) => ({ id: `${role}-app`, vendorId: role, title: role, composition: { kind: "work-items", role, embeddedOnly: true } }))),
    getCapability: vi.fn(async (id: string) => sources[id.replace(/-app$/, "") as "jira" | "zendesk"] ?? null),
  } as HostCompositionApi;
}
