import { X } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import GatekeeperAppPage from "./GatekeeperAppPage";
import { workItemRouteState, type WorkItemTarget } from "./workItemNavigation";

/** Hosts Work Items beside the current chat without navigating away from the conversation. */
export default function WorkItemDrawer({
  appId,
  target,
  onClose,
}: {
  appId: string;
  target: WorkItemTarget;
  onClose: () => void;
}) {
  const routeState = workItemRouteState(target);
  const label = target.key ?? target.id;
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <aside
      className="relative z-50 flex h-full w-[min(760px,55vw)] min-w-[min(320px,80vw)] flex-shrink-0 flex-col border-l border-kumo-line bg-kumo-base shadow-2xl"
      aria-labelledby="chat-work-item-title"
    >
      <header className="flex h-12 flex-shrink-0 items-center gap-3 border-b border-kumo-line px-4">
        <div className="min-w-0 flex-1">
          <h2 id="chat-work-item-title" className="truncate text-sm font-semibold text-kumo-default">
            Work Item · {label}
          </h2>
        </div>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md text-kumo-subtle hover:bg-kumo-elevated hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
          ref={closeButtonRef}
          aria-label="Close Work Item"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="min-h-0 flex-1">
        <GatekeeperAppPage
          key={`${appId}:${routeState}`}
          appId={appId}
          routeState={routeState}
        />
      </div>
    </aside>
  );
}
