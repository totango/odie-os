import { Component, type ErrorInfo, type ReactNode } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { reportIssue } from "./error-reporting";

type State = { error: Error | null };

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportIssue("work-items.react-boundary", error, {
      handled: true,
      severity: "error",
      captureMechanism: "react",
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="grid min-h-dvh place-items-center bg-kumo-base px-6 text-kumo-default">
        <div className="max-w-sm rounded-xl border border-kumo-line bg-kumo-control p-5 shadow-sm">
          <WarningCircle className="text-kumo-danger" size={22} />
          <h1 className="mt-3 text-base font-semibold">Work Items could not start</h1>
          <p className="mt-2 text-sm leading-6 text-kumo-subtle">
            Reload this Work Items workspace. If it keeps happening, check the deployment’s frontend error reports.
          </p>
        </div>
      </main>
    );
  }
}
