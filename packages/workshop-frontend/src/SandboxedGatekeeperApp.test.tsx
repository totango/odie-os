// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
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
  identify(): string {
    return "jira";
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

  it("provides the deployment theme and routes bounded iframe requests", async () => {
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
      routeTree: rootRoute.addChildren([indexRoute, gadgetRoute]),
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
