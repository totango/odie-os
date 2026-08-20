import { TooltipProvider, Toasty } from "@cloudflare/kumo";
import { createRoot } from "react-dom/client";
import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import type { GatekeeperAppTheme, GatekeeperAppThemeReceiver } from "@gadgets/workshop-shared/theme";
import type { WorkItemsManagementApi } from "../src/types";
import ErrorBoundary from "./ErrorBoundary";
import WorkItemsPage from "./WorkItemsPage";
import { WorkItemsApiProvider, WorkItemsRouteStateProvider } from "./bridge";
import { installErrorReporting, reportIssue } from "./error-reporting";
import { applyAppTheme } from "./theme";
import "./styles.css";

installErrorReporting();

class AppIframe extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(theme: GatekeeperAppTheme): void {
    applyAppTheme(theme);
  }
}

interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<WorkItemsManagementApi>;
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  getRouteState(): Promise<string>;
  setRouteState(value: string): Promise<void>;
}

async function main() {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing Team PI Work Items app root.");

  const { port1, port2 } = new MessageChannel();
  window.parent.postMessage({ type: "handshake" }, "*", [port2]);
  const iframe = new AppIframe();
  const host = newMessagePortRpcSession<HostCapability>(port1, iframe);
  host.subscribeTheme(iframe).then(applyAppTheme).catch(() => {});
  const initialRouteState = await host.getRouteState().catch(() => "");

  createRoot(root, {
    onUncaughtError: (error) => reportIssue("team-pi-work-items.react-root", error, {
      handled: false,
      severity: "fatal",
      captureMechanism: "react",
    }),
  }).render(
    <ErrorBoundary>
      <TooltipProvider>
        <Toasty>
          <WorkItemsApiProvider value={host.ui}>
            <WorkItemsRouteStateProvider value={{
              initialRouteState,
              setRouteState: (value) => { void host.setRouteState(value).catch(() => {}); },
            }}>
              <WorkItemsPage />
            </WorkItemsRouteStateProvider>
          </WorkItemsApiProvider>
        </Toasty>
      </TooltipProvider>
    </ErrorBoundary>,
  );
}

void main();
