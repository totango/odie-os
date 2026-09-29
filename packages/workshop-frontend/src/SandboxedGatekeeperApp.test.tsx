// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { Activity, act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { newMessagePortRpcSession, RpcStub, RpcTarget } from "capnweb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatekeeperUiFrame } from "@gadgets/workshop-shared/gatekeeper";
import type { GatekeeperAppInfo } from "@gadgets/workshop-shared/api";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import SandboxedGatekeeperApp, { normalizeGatekeeperAppRouteState } from "./SandboxedGatekeeperApp";

vi.mock("./ThemeContext", () => ({
  useTheme: () => ({ resolvedThemeMode: "light" }),
}));

vi.mock("./ServerConfigContext", () => ({
  useServerConfig: () => ({ accentColor: "#7c3aed" }),
}));

vi.mock("./errorReporting", () => ({
  forwardTrustedFrameError: () => false,
}));

const WORKSPACE_ID = "a".repeat(64);

function capture<T>(target: { current: T | undefined }, value: T) {
  target.current = value;
}

const listGadgets = vi.fn<() => Promise<{ id: string; title: string }[]>>(async () => [
  { id: WORKSPACE_ID, title: "Daily Brief" },
]);
const authenticatedApi = { listGadgets };
const requestCodingSession = vi.fn<(target: { source: "jira" | "zendesk"; id: string; key?: string; url?: string }, title: string) => void>();

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(window, "scrollTo", { value: vi.fn<() => void>(), configurable: true });

interface TestHost extends RpcTarget {
  ui: TestSource;
  setPresenting(active: boolean): Promise<unknown>;
  refresh(): Promise<void>;
  openWorkItemsConnectors(): Promise<void>;
  retryWorkItemsProviders(): Promise<void>;
  listCapabilities(): Promise<GatekeeperAppInfo[]>;
  getCapability(id: string): Promise<RpcStub<RpcTarget> | null>;
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  openWorkspace(workspaceId: string, gadgetId?: number): Promise<void>;
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]>;
  openPrompt(prompt: string): Promise<void>;
  codingSessionAvailable(): Promise<boolean>;
  requestCodingSession(source: "jira" | "zendesk", id: string, key: string | undefined, url: string | undefined, title: string): Promise<void>;
  getRouteState(): Promise<string>;
  setRouteState(value: string): Promise<void>;
}

class EmptyUi extends RpcTarget {}

interface TestSource extends RpcTarget {
  identify(): Promise<string>;
}

class SourceUi extends RpcTarget {
  constructor(private readonly value = "jira") { super(); }
  identify(): string {
    return this.value;
  }
}

class TestThemeReceiver extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(_theme: GatekeeperAppTheme): void {}
}

describe("SandboxedGatekeeperApp navigation", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let host: RpcStub<TestHost> | undefined;
  let dependencyCapability: RpcStub<RpcTarget> | undefined;

  beforeEach(() => {
    listGadgets.mockClear();
    requestCodingSession.mockClear();
  });

  afterEach(async () => {
    host?.[Symbol.dispose]();
    dependencyCapability?.[Symbol.dispose]();
    await act(async () => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
    dependencyCapability = undefined;
  });

  it('keeps the document, cached ui and port across Activity while hidden helpers fail closed', async () => {
    const errors = vi.spyOn(console, 'error');
    const first = new RpcStub(new SourceUi('first'));
    const second = new RpcStub(new SourceUi('second'));
    const update = { current: undefined as ((value: { hidden: boolean; ui: RpcStub<SourceUi> }) => void) | undefined };
    const App = () => {
      const [state, set] = useState({ hidden: false, ui: first });
      capture(update, set);
      return <Activity mode={state.hidden ? 'hidden' : 'visible'}>
        <SandboxedGatekeeperApp frame={{ iframeHtml: '<p>persistent</p>', ui: state.ui }} gatekeeperVendorId="context" />
      </Activity>;
    };
    const route = createRootRoute({ component: App });
    const router = createRouter({ history: createMemoryHistory({ initialEntries: ['/'] }), routeTree: route.addChildren([createRoute({ getParentRoute: () => route, path: '/' })]) });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    const iframe = container.querySelector('iframe')!;
    const channel = new MessageChannel(); host = newMessagePortRpcSession<TestHost>(channel.port1);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [channel.port2] }));
    const cached = host.ui.dup();
    await expect(host.refresh()).rejects.toThrow(/refresh/);
    await expect(cached.identify()).resolves.toBe('first');
    await act(async () => update.current!({ hidden: true, ui: first }));
    await expect(cached.identify()).rejects.toThrow('no longer available');
    await expect(host.resolveWorkspaceTitles([WORKSPACE_ID])).rejects.toThrow('no longer available');
    await expect(host.openPrompt('test')).rejects.toThrow('no longer available');
    await expect(host.setPresenting(true)).rejects.toThrow('no longer available');
    await act(async () => update.current!({ hidden: false, ui: second }));
    expect(container.querySelector('iframe')).toBe(iframe);
    await expect(cached.identify()).resolves.toBe('second');
    await expect(host.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(['Daily Brief']);
    await act(async () => { await host!.setPresenting(true); });
    await act(async () => root!.unmount()); root = undefined;
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/useInsertionEffect must not schedule|flushSync was called/);
    cached[Symbol.dispose](); first[Symbol.dispose](); second[Symbol.dispose]();
  });

  it('lets held writes settle once through route, callback and equivalent dependency-array churn', async () => {
    class Writer extends RpcTarget {
      finish: (() => void) | undefined;
      calls = 0;
      write() { this.calls++; return new Promise<void>(resolve => { this.finish = resolve; }); }
    }
    const backend = new Writer(); const source = new Writer();
    const main = new RpcStub(backend); const dependency = new RpcStub(source);
    const apps: GatekeeperAppInfo[] = [{ id: 'one', vendorId: 'jira', title: 'One' }, { id: 'two', vendorId: 'jira', title: 'Two' }];
    const update = { current: undefined as ((value: number) => void) | undefined };
    const App = () => {
      const [revision, setRevision] = useState(0); capture(update, setRevision);
      const dependencies = apps.map(app => ({ app: { ...app }, capability: dependency }));
      return <SandboxedGatekeeperApp frame={{ iframeHtml: '<p>held</p>', ui: main }} gatekeeperVendorId="context"
        dependencies={revision ? dependencies.toReversed() : dependencies} routeState={String(revision)}
        isAuthorityCurrent={() => true} setRouteState={() => {}} />;
    };
    const route = createRootRoute({ component: App });
    const router = createRouter({ history: createMemoryHistory({ initialEntries: ['/'] }), routeTree: route.addChildren([createRoute({ getParentRoute: () => route, path: '/' })]) });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    const iframe = container.querySelector('iframe')!; const channel = new MessageChannel();
    const remote = newMessagePortRpcSession<{ ui: Writer; getCapability(id: string): Writer }>(channel.port1);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [channel.port2] }));
    const cached = await remote.getCapability('one');
    const mainWrite = Promise.resolve(remote.ui.write()).then(() => 'done', error => String(error));
    const dependencyWrite = Promise.resolve(cached.write()).then(() => 'done', error => String(error));
    await vi.waitFor(() => { expect(backend.calls).toBe(1); expect(source.calls).toBe(1); });
    await act(async () => update.current!(1));
    backend.finish!(); source.finish!();
    expect(await mainWrite).toBe('done'); expect(await dependencyWrite).toBe('done');
    expect(backend.calls).toBe(1); expect(source.calls).toBe(1);
    expect(container.querySelector('iframe')).toBe(iframe);
    cached[Symbol.dispose](); remote[Symbol.dispose](); main[Symbol.dispose](); dependency[Symbol.dispose]();
  });

  it('retains committed HTML until explicit Reload, but resets immediately for incompatible identity', async () => {
    const ui = new RpcStub(new EmptyUi());
    const update = { current: undefined as ((value: { html: string; identity: string }) => void) | undefined };
    const App = () => {
      const [value, set] = useState({ html: '<p>v1</p>', identity: 'owner/account/admin-false' }); capture(update, set);
      return <SandboxedGatekeeperApp frame={{ iframeHtml: value.html, ui }} documentIdentity={value.identity} gatekeeperVendorId="context" />;
    };
    const route = createRootRoute({ component: App });
    const router = createRouter({ history: createMemoryHistory({ initialEntries: ['/'] }), routeTree: route.addChildren([createRoute({ getParentRoute: () => route, path: '/' })]) });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    const iframe = container.querySelector('iframe')!;
    await act(async () => update.current!({ html: '<p>v2</p>', identity: 'owner/account/admin-false' }));
    expect(container.querySelector('iframe')).toBe(iframe); expect(iframe.srcdoc).toBe('<p>v1</p>');
    const reload = container.querySelector('button')!; expect(reload.textContent).toBe('Reload when ready');
    await act(async () => reload.click());
    const replaced = container.querySelector('iframe')!; expect(replaced).not.toBe(iframe); expect(replaced.srcdoc).toBe('<p>v2</p>');
    await act(async () => update.current!({ html: '<p>v2</p>', identity: 'other-owner/account/admin-false' }));
    expect(container.querySelector('iframe')).not.toBe(replaced);
    ui[Symbol.dispose]();
  });

  it("provides the deployment theme and routes bounded iframe requests", async () => {
    const retryProviders = vi.fn<() => void>();
    const frame = {
      iframeHtml: "<!doctype html><title>Scheduler</title>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as GatekeeperUiFrame;
    dependencyCapability = new RpcStub(new SourceUi());
    const dependency: GatekeeperAppInfo = {
      id: "opaque-jira-app-id",
      vendorId: "jira",
      title: "Jira",
      composition: { kind: "work-items", role: "jira", embeddedOnly: true },
    };
    const dependencies = [{ app: dependency, capability: dependencyCapability }];
    const rootRoute = createRootRoute({
      component: () => <SandboxedGatekeeperApp
        frame={frame}
        gatekeeperVendorId="work-items"
        dependencies={dependencies}
        codingSessionAvailable
        workItemHandoffs
        onRequestCodingSession={requestCodingSession}
        onRetryProviders={retryProviders}
      />,
    });
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
    const gadgetRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workspace/$id",
    });
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createRouter({
      history,
      routeTree: rootRoute.addChildren([indexRoute, gadgetRoute, createRoute({ getParentRoute: () => rootRoute, path: "/gatekeepers" })]),
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));

    const iframe = container.querySelector("iframe");
    if (!iframe) throw new Error("Missing gatekeeper iframe");
    const { port1, port2 } = new MessageChannel();
    host = newMessagePortRpcSession<TestHost>(port1);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "handshake" },
        origin: "null",
        source: iframe.contentWindow,
        ports: [port2],
      }),
    );

    const themeReceiver = new TestThemeReceiver();
    await expect(host.subscribeTheme(themeReceiver)).resolves.toEqual({
      mode: "light",
      accentColor: "#7c3aed",
    });
    await expect(host.listCapabilities()).resolves.toEqual([dependency]);
    await expect(host.getCapability("missing")).resolves.toBeNull();
    const source = await host.getCapability(dependency.id) as RpcStub<TestSource>;
    await expect(source.identify()).resolves.toBe("jira");
    source[Symbol.dispose]();

    await act(async () => {
      await host!.openWorkspace(WORKSPACE_ID, 2);
      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe(`/workspace/${WORKSPACE_ID}`),
      );
    });
    expect(router.state.location.search).toEqual({ w: 2 });

    // Live titles come from the user's own gadget list, never from the app's snapshot. Concurrent
    // and repeated frame requests share a bounded-lifetime host-side index.
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    listGadgets
      .mockResolvedValueOnce([{ id: WORKSPACE_ID, title: "Daily Brief" }])
      .mockResolvedValueOnce([{ id: WORKSPACE_ID, title: "Renamed Brief" }]);
    await expect(
      Promise.all([
        host.resolveWorkspaceTitles([WORKSPACE_ID, "b".repeat(64)]),
        host.resolveWorkspaceTitles([WORKSPACE_ID]),
      ]),
    ).resolves.toEqual([["Daily Brief", null], ["Daily Brief"]]);
    await expect(host.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(["Daily Brief"]);
    expect(listGadgets).toHaveBeenCalledTimes(1);

    now.mockReturnValue(30_000);
    await expect(host.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(["Renamed Brief"]);
    expect(listGadgets).toHaveBeenCalledTimes(2);

    await expect(host.openWorkspace("../evil")).rejects.toThrow(
      "Invalid gatekeeper app workspace target",
    );
    expect(router.state.location.pathname).toBe(`/workspace/${WORKSPACE_ID}`);

    await act(async () => {
      await host!.openPrompt("  Create a daily brief.  ");
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    });
    expect(router.state.location.search).toEqual({ prompt: "Create a daily brief." });

    await expect(host.codingSessionAvailable()).resolves.toBe(true);
    await host.requestCodingSession("jira", "1001", "ai-3540", "https://example.atlassian.net/browse/AI-3540", "  Work on AI-3540  ");
    expect(requestCodingSession).toHaveBeenCalledWith(
      { source: "jira", id: "1001", key: "AI-3540", url: "https://example.atlassian.net/browse/AI-3540" },
      "Work on AI-3540",
    );
    await expect(host.requestCodingSession("jira", "1001", "AI-3540", undefined, "bad\ntitle")).rejects.toThrow(
      "Invalid coding session title",
    );
    await host.retryWorkItemsProviders();
    expect(retryProviders).toHaveBeenCalledOnce();
    await act(async () => {
      await host!.openWorkItemsConnectors();
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/gatekeepers"));
    });
  });

  it("does not expose Work Item Code handoffs to other gatekeeper apps", async () => {
    const frame = {
      iframeHtml: "<!doctype html><title>Other app</title>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as GatekeeperUiFrame;
    const rootRoute = createRootRoute({
      component: () => <SandboxedGatekeeperApp
        frame={frame}
        gatekeeperVendorId="scheduler"
        codingSessionAvailable
        onRequestCodingSession={requestCodingSession}
      />,
    });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/" })]),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));

    const iframe = container.querySelector("iframe")!;
    const { port1, port2 } = new MessageChannel();
    host = newMessagePortRpcSession<TestHost>(port1);
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "handshake" }, origin: "null", source: iframe.contentWindow, ports: [port2],
    }));

    await expect(host.codingSessionAvailable()).resolves.toBe(false);
    await expect(host.requestCodingSession("jira", "1001", "AI-3540", undefined, "Work on AI-3540"))
      .rejects.toThrow("not available to this app");
    expect(requestCodingSession).not.toHaveBeenCalled();
    await expect(host.openWorkItemsConnectors()).rejects.toThrow("Not available to this app");
    await expect(host.retryWorkItemsProviders()).rejects.toThrow("Not available to this app");
  });

  it("retains the sandbox and permanently revokes removed dependency slots", async () => {
    const frame = {
      iframeHtml: "<!doctype html><title>Work Items</title>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as GatekeeperUiFrame;
    dependencyCapability = new RpcStub(new SourceUi());
    const dependency: GatekeeperAppInfo = {
      id: "current-user-jira-app",
      vendorId: "jira",
      title: "Jira",
      composition: { kind: "work-items", role: "jira", embeddedOnly: true },
    };
    const setDependencies = { current: undefined as ((dependencies: { app: GatekeeperAppInfo; capability: RpcStub<RpcTarget> }[]) => void) | undefined };
    const App = () => {
      const [dependencies, updateDependencies] = useState<{ app: GatekeeperAppInfo; capability: RpcStub<RpcTarget> }[]>([]);
      capture(setDependencies, updateDependencies);
      return <SandboxedGatekeeperApp
        frame={frame}
        gatekeeperVendorId="work-items"
        dependencies={dependencies}
      />;
    };
    const rootRoute = createRootRoute({ component: App });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/" })]),
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));

    const firstIframe = container.querySelector("iframe");
    if (!firstIframe) throw new Error("Missing first gatekeeper iframe");
    const channel = new MessageChannel();
    host = newMessagePortRpcSession<TestHost>(channel.port1);
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "handshake" }, origin: "null", source: firstIframe.contentWindow, ports: [channel.port2],
    }));
    await expect(host.listCapabilities()).resolves.toEqual([]);

    await act(async () => setDependencies.current!([{ app: dependency, capability: dependencyCapability! }]));
    const secondIframe = container.querySelector("iframe");
    expect(secondIframe).toBe(firstIframe);
    await expect(host.listCapabilities()).resolves.toEqual([dependency]);
    await expect(host.getCapability("other-users-jira-app")).resolves.toBeNull();
    const old = await host.getCapability(dependency.id) as RpcStub<TestSource>;
    await act(async () => setDependencies.current!([]));
    await expect(old.identify()).rejects.toThrow('no longer available');
    await act(async () => setDependencies.current!([{ app: dependency, capability: dependencyCapability! }]));
    await expect(old.identify()).rejects.toThrow('no longer available');
    const fresh = await host.getCapability(dependency.id) as RpcStub<TestSource>;
    await expect(fresh.identify()).resolves.toBe('jira');
    old[Symbol.dispose](); fresh[Symbol.dispose]();
  });

  it("retains a cached dependency slot when its account id receives a fresh capability", async () => {
    const frame = {
      iframeHtml: "<!doctype html><title>Work Items</title>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as GatekeeperUiFrame;
    const firstCapability = new RpcStub(new SourceUi("old-jira"));
    dependencyCapability = new RpcStub(new SourceUi("new-jira"));
    const dependency: GatekeeperAppInfo = {
      id: "current-user-jira-app",
      vendorId: "jira",
      title: "Jira",
      composition: { kind: "work-items", role: "jira", embeddedOnly: true },
    };
    const setCapability = { current: undefined as ((capability: RpcStub<RpcTarget>) => void) | undefined };
    const App = () => {
      const [capability, updateCapability] = useState<{ value: RpcStub<RpcTarget> }>({ value: firstCapability });
      capture(setCapability, (value) => updateCapability({ value }));
      return <SandboxedGatekeeperApp
        frame={frame}
        gatekeeperVendorId="work-items"
        dependencies={[{ app: dependency, capability: capability.value }]}
      />;
    };
    const rootRoute = createRootRoute({ component: App });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/" })]),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));

    const firstIframe = container.querySelector("iframe")!;
    let channel = new MessageChannel();
    host = newMessagePortRpcSession<TestHost>(channel.port1);
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "handshake" }, origin: "null", source: firstIframe.contentWindow, ports: [channel.port2],
    }));
    const source = await host.getCapability(dependency.id) as RpcStub<TestSource>;
    await expect(source.identify()).resolves.toBe("old-jira");

    await act(async () => setCapability.current!(dependencyCapability!));
    const secondIframe = container.querySelector("iframe")!;
    expect(secondIframe).toBe(firstIframe);
    await expect(source.identify()).resolves.toBe("new-jira");
    source[Symbol.dispose]();
    firstCapability[Symbol.dispose]();
  });

  it("does not let a stale listener adopt a remounted iframe during owner replacement", async () => {
    const messageHandlers: EventListener[] = [];
    const addEventListener = window.addEventListener.bind(window);
    const removeEventListener = window.removeEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
      if (type === "message" && typeof listener === "function") messageHandlers.push(listener);
      return addEventListener(type, listener, options);
    });
    vi.spyOn(window, "removeEventListener").mockImplementation((type, listener, options) =>
      removeEventListener(type, listener, options));

    const frame = {
      iframeHtml: "<!doctype html><title>Work Items</title>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as GatekeeperUiFrame;
    const firstCapability = new RpcStub(new SourceUi("old-jira"));
    dependencyCapability = new RpcStub(new SourceUi("new-jira"));
    const dependency: GatekeeperAppInfo = {
      id: "current-user-jira-app",
      vendorId: "jira",
      title: "Jira",
      composition: { kind: "work-items", role: "jira", embeddedOnly: true },
    };
    const setCapability = { current: undefined as ((capability: RpcStub<RpcTarget>) => void) | undefined };
    const App = () => {
      const [capability, updateCapability] = useState<{ value: RpcStub<RpcTarget> }>({ value: firstCapability });
      capture(setCapability, (value) => updateCapability({ value }));
      return <SandboxedGatekeeperApp
        frame={frame}
        documentIdentity={capability.value === firstCapability ? 'owner-one' : 'owner-two'}
        gatekeeperVendorId="work-items"
        dependencies={[{ app: dependency, capability: capability.value }]}
      />;
    };
    const rootRoute = createRootRoute({ component: App });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/" })]),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    expect(messageHandlers).toHaveLength(1);

    const firstIframe = container.querySelector("iframe")!;
    let channel = new MessageChannel();
    host = newMessagePortRpcSession<TestHost>(channel.port1);
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "handshake" }, origin: "null", source: firstIframe.contentWindow, ports: [channel.port2],
    }));
    let source = await host.getCapability(dependency.id) as RpcStub<TestSource>;
    await expect(source.identify()).resolves.toBe("old-jira");
    source[Symbol.dispose]();

    await act(async () => setCapability.current!(dependencyCapability!));
    const secondIframe = container.querySelector("iframe")!;
    expect(secondIframe).not.toBe(firstIframe);
    expect(messageHandlers).toHaveLength(2);

    // Simulate a message arriving in the narrow window that existed with passive effects: a stale
    // handler sees the new iframe's window. It must ignore it, not consume/invalidate the new port.
    let staleChannel = new MessageChannel();
    messageHandlers[0]!(new MessageEvent("message", {
      data: { type: "handshake" }, origin: "null", source: secondIframe.contentWindow, ports: [staleChannel.port2],
    }));

    host[Symbol.dispose]();
    channel = new MessageChannel();
    host = newMessagePortRpcSession<TestHost>(channel.port1);
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "handshake" }, origin: "null", source: secondIframe.contentWindow, ports: [channel.port2],
    }));
    source = await host.getCapability(dependency.id) as RpcStub<TestSource>;
    await expect(source.identify()).resolves.toBe("new-jira");
    source[Symbol.dispose]();
    firstCapability[Symbol.dispose]();
    staleChannel.port1.close();
    staleChannel.port2.close();
  });

  it("keeps the existing sandbox for equivalent dependency array churn and reordering", async () => {
    const frame = {
      iframeHtml: "<!doctype html><title>Work Items</title>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as GatekeeperUiFrame;
    dependencyCapability = new RpcStub(new SourceUi("jira"));
    const zendeskCapability = new RpcStub(new SourceUi("zendesk"));
    const jira: GatekeeperAppInfo = {
      id: "current-user-jira-app",
      vendorId: "jira",
      title: "Jira",
      composition: { kind: "work-items", role: "jira", embeddedOnly: true },
    };
    const zendesk: GatekeeperAppInfo = {
      id: "current-user-zendesk-app",
      vendorId: "zendesk",
      title: "Zendesk",
      composition: { kind: "work-items", role: "zendesk", embeddedOnly: true },
    };
    const setDependencies = { current: undefined as ((dependencies: { app: GatekeeperAppInfo; capability: RpcStub<RpcTarget> }[]) => void) | undefined };
    const App = () => {
      const [dependencies, updateDependencies] = useState([
        { app: jira, capability: dependencyCapability! },
        { app: zendesk, capability: zendeskCapability },
      ]);
      capture(setDependencies, updateDependencies);
      return <SandboxedGatekeeperApp frame={frame} gatekeeperVendorId="work-items" dependencies={dependencies} />;
    };
    const rootRoute = createRootRoute({ component: App });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/" })]),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));

    const firstIframe = container.querySelector("iframe")!;
    const channel = new MessageChannel();
    host = newMessagePortRpcSession<TestHost>(channel.port1);
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "handshake" }, origin: "null", source: firstIframe.contentWindow, ports: [channel.port2],
    }));
    await expect(host.listCapabilities()).resolves.toEqual(expect.arrayContaining([jira, zendesk]));

    await act(async () => setDependencies.current!([
      { app: zendesk, capability: zendeskCapability },
      { app: jira, capability: dependencyCapability! },
    ]));
    expect(container.querySelector("iframe")).toBe(firstIframe);
    await expect(host.listCapabilities()).resolves.toEqual(expect.arrayContaining([jira, zendesk]));
    zendeskCapability[Symbol.dispose]();
  });

  it("bridges bounded route state without allowing iframe-controlled route changes", async () => {
    const frame = {
      iframeHtml: "<!doctype html><title>Work Items</title>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as GatekeeperUiFrame;
    const rootRoute = createRootRoute();
    const route = createRoute({
      getParentRoute: () => rootRoute,
      path: "/gatekeepers/$appId",
      validateSearch: (search: Record<string, unknown>): { state?: string } => {
        const state = normalizeGatekeeperAppRouteState(search.state);
        return state === undefined || state === "" ? {} : { state };
      },
      component: function RouteComponent() {
        const { appId } = route.useParams();
        const { state } = route.useSearch();
        const navigate = route.useNavigate();
        return <SandboxedGatekeeperApp
          frame={frame}
          gatekeeperVendorId={appId}
          routeState={state}
          setRouteState={(value) => {
            void navigate({ search: value ? { state: value } : {}, replace: true });
          }}
        />;
      },
    });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/gatekeepers/work-items?state=source%3Djira%26q%3Dlogin"] }),
      routeTree: rootRoute.addChildren([route]),
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));

    const iframe = container.querySelector("iframe");
    if (!iframe) throw new Error("Missing gatekeeper iframe");
    const { port1, port2 } = new MessageChannel();
    host = newMessagePortRpcSession<TestHost>(port1);
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "handshake" },
      origin: "null",
      source: iframe.contentWindow,
      ports: [port2],
    }));

    await expect(host.getRouteState()).resolves.toBe("source=jira&q=login");
    await expect(host.codingSessionAvailable()).resolves.toBe(false);
    await expect(host.requestCodingSession("jira", "1001", "AI-3540", undefined, "Work on AI-3540"))
      .rejects.toThrow("not available to this app");

    await act(async () => {
      await host!.setRouteState("source=zendesk&q=refund");
      await vi.waitFor(() => expect(router.state.location.search).toEqual({ state: "source=zendesk&q=refund" }));
    });
    expect(router.state.location.pathname).toBe("/gatekeepers/work-items");

    await act(async () => {
      await host!.setRouteState("");
      await vi.waitFor(() => expect(router.state.location.search).toEqual({}));
    });
    expect(router.state.location.pathname).toBe("/gatekeepers/work-items");

    await expect(host.setRouteState("x".repeat(2049))).rejects.toThrow("Invalid gatekeeper app route state");
    await expect(host.setRouteState("q=bad\nvalue")).rejects.toThrow("Invalid gatekeeper app route state");
    expect(router.state.location.pathname).toBe("/gatekeepers/work-items");
    expect(router.state.location.search).toEqual({});

    await act(async () => {
      await host!.setRouteState("appId=evil&path=/admin&selected=jira%3A1001");
      await vi.waitFor(() => expect(router.state.location.search).toEqual({ state: "appId=evil&path=/admin&selected=jira%3A1001" }));
    });
    expect(router.state.location.pathname).toBe("/gatekeepers/work-items");
  });
});
