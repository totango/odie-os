import { Link } from '@tanstack/react-router'
import { ChatCenteredDots } from '@phosphor-icons/react'

/** The old private-auto-PR entry point now leads to the authenticated public board. */
export default function ProductFeedbackButton({ collapsed = false }: { collapsed?: boolean }) {
  return <Link to="/requests" aria-label="Community requests" title={collapsed ? 'Community requests' : undefined}
    className={collapsed
      ? 'flex h-9 w-9 items-center justify-center rounded-lg bg-kumo-brand text-kumo-inverse focus-visible:outline-2 focus-visible:outline-kumo-ring'
      : 'flex w-full items-center gap-2.5 rounded-xl bg-kumo-brand px-3 py-2.5 text-kumo-inverse focus-visible:outline-2 focus-visible:outline-kumo-ring'}>
    <ChatCenteredDots size={18} weight="fill" className="shrink-0" />
    {!collapsed && <span><span className="block text-sm font-semibold">Community requests</span><span className="block text-xs">Suggest a feature or report a bug</span></span>}
  </Link>
}
