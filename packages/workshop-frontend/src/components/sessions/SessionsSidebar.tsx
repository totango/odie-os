import { Archive, ArrowClockwise, CaretRight, Plus, TerminalWindow } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { CodingSessionSummary } from '@gadgets/workshop-shared/api'
import { WorkshopIconButton } from '../WorkshopControls'
import { useSessionsContext } from './SessionsContext'

export default function SessionsSidebar({ collapsed = false }: { collapsed?: boolean }) {
  const { openSessions, archivedSessions, loaded, refresh, activeId, setActiveId, archiveSession } = useSessionsContext()
  const [showArchived, setShowArchived] = useState(false)
  const visibleSessions = showArchived ? archivedSessions : openSessions

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1.5 px-2 py-3">
        <Link to="/sessions" aria-label="New session" title="New session" className="flex h-9 w-9 items-center justify-center rounded-lg text-kumo-brand hover:bg-kumo-tint">
          <Plus size={16} />
        </Link>
        {openSessions.slice(0, 8).map((session) => (
          <button key={session.id} type="button" aria-label={session.title} title={session.title} onClick={() => setActiveId(session.id)} className={`flex h-9 w-9 items-center justify-center rounded-lg ${activeId === session.id ? 'bg-kumo-fill text-kumo-brand' : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'}`}>
            <TerminalWindow size={15} />
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-kumo-line px-3 py-3">
        <Link to="/sessions" onClick={() => setActiveId(undefined)} className="flex h-9 items-center justify-center gap-2 rounded-lg bg-kumo-contrast px-3 text-[13px] font-medium text-kumo-inverse hover:bg-kumo-strong">
          <Plus size={14} /> New session
        </Link>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-b border-kumo-line px-3 py-2">
        <button type="button" onClick={() => setShowArchived(false)} className={`rounded-md px-2.5 py-1 text-xs ${!showArchived ? 'bg-kumo-tint font-medium text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'}`}>Open sessions</button>
        <button type="button" onClick={() => setShowArchived(true)} className={`rounded-md px-2.5 py-1 text-xs ${showArchived ? 'bg-kumo-tint font-medium text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'}`}>Archived</button>
        <WorkshopIconButton aria-label="Refresh sessions" onClick={refresh} className="ml-auto !h-7 !w-7"><ArrowClockwise size={14} /></WorkshopIconButton>
      </div>
      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-2">
        {!loaded ? <p className="px-2 py-4 text-sm text-kumo-subtle">Loading…</p> : visibleSessions.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-kumo-subtle">{showArchived ? 'No archived sessions.' : 'No open sessions.'}</p>
        ) : visibleSessions.map((session) => (
          <SessionRow key={session.id} session={session} active={activeId === session.id} onOpen={() => session.status === 'running' && setActiveId(session.id)} onArchive={() => archiveSession(session.id)} />
        ))}
      </div>
    </div>
  )
}

function SessionRow({ session, active, onOpen, onArchive }: { session: CodingSessionSummary; active: boolean; onOpen: () => void; onArchive: () => void }) {
  return (
    <div className={`group mb-1 flex items-start gap-1 rounded-lg px-2 py-2.5 ${active ? 'bg-kumo-fill' : 'hover:bg-kumo-tint'}`}>
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${session.status === 'running' ? 'bg-emerald-500' : session.status === 'failed' ? 'bg-kumo-danger' : 'bg-kumo-inactive'}`} />
          <span className="truncate text-[13px] font-medium text-kumo-default">{session.title}</span>
        </div>
        <div className="ml-3.5 mt-1 truncate text-[11px] text-kumo-subtle">{session.repositories.join(' · ')}</div>
        {session.error && <div className="ml-3.5 mt-1 line-clamp-2 text-[11px] text-kumo-danger">{session.error}</div>}
      </button>
      {!session.archivedAt && (
        <WorkshopIconButton aria-label={`Archive ${session.title}`} onClick={onArchive} className="opacity-0 group-hover:opacity-100 focus:opacity-100"><Archive size={14} /></WorkshopIconButton>
      )}
      {session.status === 'running' && <CaretRight size={14} className="mt-1 text-kumo-inactive" />}
    </div>
  )
}
