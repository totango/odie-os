import { createFileRoute, Navigate } from '@tanstack/react-router'
import { useState } from 'react'
import {
  Archive,
  ArrowClockwise,
  ArrowLeft,
  Check,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  Stop,
  TerminalWindow,
  X,
} from '@phosphor-icons/react'
import type { CodingSessionRepository } from '@gadgets/workshop-shared/api'
import type { CodingSessionActivity } from '@gadgets/workshop-shared/coding-sessions'
import { useDocumentTitle } from '../useDocumentTitle'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from '../components/WorkshopControls'
import SessionTerminal from '../components/sessions/SessionTerminal'
import { useSessionsContext } from '../components/sessions/SessionsContext'

export const Route = createFileRoute('/sessions')({ component: SessionsPage })

export function SessionsPage() {
  useDocumentTitle('Sessions')
  const sessions = useSessionsContext()
  const { github, activeSession, error, activity, resolveActivity, restartSession, stopSession, archiveSession, setActiveId } = sessions
  const [terminalKind, setTerminalKind] = useState<'opencode' | 'shell'>('opencode')

  if (github.state === 'loading') return <CenteredMessage>Checking GitHub connection…</CenteredMessage>
  if (github.state === 'missing' || github.state === 'expired') return <Navigate to="/" replace />

  if (activeSession) {
    const sessionActivity = activity.filter((entry) => entry.sessionId === activeSession.id)
    return (
      <div className="flex h-full min-h-0 flex-col bg-kumo-base">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-kumo-line px-3 text-kumo-default">
          <WorkshopIconButton aria-label="Back to new session" onClick={() => setActiveId(undefined)}>
            <ArrowLeft size={16} />
          </WorkshopIconButton>
          <TerminalWindow size={16} className="text-kumo-brand" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-kumo-strong">{activeSession.title}</div>
            <div className="truncate text-[11px] text-kumo-subtle">{activeSession.repositories.join(' / ')}</div>
          </div>
          <div className="flex rounded-md border border-kumo-line bg-kumo-tint p-0.5 text-[11px]">
            {(['opencode', 'shell'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setTerminalKind(kind)}
                className={`rounded px-2 py-1 capitalize ${terminalKind === kind ? 'bg-kumo-base text-kumo-strong shadow-sm' : 'text-kumo-subtle hover:text-kumo-default'}`}
              >
                {kind}
              </button>
            ))}
          </div>
          <span className="hidden text-[11px] text-kumo-success sm:inline">running</span>
          <WorkshopButton
            title="Discards uncommitted sandbox changes and reclones repositories"
            onClick={() => {
              if (window.confirm('Restart this environment? Uncommitted sandbox changes will be discarded.')) {
                void restartSession(activeSession.id)
              }
            }}
          >
            <ArrowClockwise size={13} /> Restart environment
          </WorkshopButton>
          <WorkshopButton onClick={() => stopSession(activeSession.id)}>
            <Stop size={13} /> Stop
          </WorkshopButton>
          <WorkshopIconButton aria-label="Archive session" onClick={() => archiveSession(activeSession.id)}>
            <Archive size={15} />
          </WorkshopIconButton>
        </div>
        {error && <div className="border-b border-kumo-danger/20 bg-kumo-danger-tint px-3 py-2 text-xs text-kumo-danger">{error}</div>}
        <div className={`grid min-h-0 flex-1 ${sessionActivity.some((entry) => entry.state === 'pending') ? 'lg:grid-cols-[minmax(0,1fr)_320px]' : ''}`}>
          <div className="min-h-0"><SessionTerminal key={`${terminalKind}:${activeSession.lastActiveAt.valueOf()}`} sessionId={activeSession.id} terminalKind={terminalKind} /></div>
          {sessionActivity.some((entry) => entry.state === 'pending') && (
            <ActivityPanel activity={sessionActivity} onResolve={resolveActivity} />
          )}
        </div>
      </div>
    )
  }

  return <NewSessionPane />
}

function NewSessionPane() {
  const {
    activity,
    resolveActivity,
    availablePresets,
    repositories,
    setRepositories,
    repositoryOptions,
    repositorySearch,
    setRepositorySearch,
    repositoryLoading,
    title,
    setTitle,
    creating,
    create,
    error,
  } = useSessionsContext()

  return (
    <section className="flex h-full min-h-0 flex-col bg-kumo-tint/30">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4 pt-6 sm:px-8 sm:pt-8">
      <div className="mx-auto flex h-full min-h-0 max-w-3xl flex-col">
        {activity.some((entry) => entry.state === 'pending') && (
          <div className="mb-7 overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
            <ActivityPanel activity={activity} onResolve={resolveActivity} compact />
          </div>
        )}

        <div className="flex items-center gap-2 text-sm font-semibold text-kumo-default"><Plus size={15} /> New session</div>
        <p className="mt-1 text-xs text-kumo-subtle">Choose repositories from connected GitHub, then open the coding terminal.</p>
        {error && <div className="mt-5 rounded-lg border border-kumo-danger bg-kumo-danger-tint px-4 py-3 text-sm text-kumo-danger">{error}</div>}

        {availablePresets.length > 0 && (
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {availablePresets.map((preset) => {
              const selected = preset.repositories.length === repositories.length && preset.repositories.every((repository) => repositories.includes(repository))
              return (
                <button key={preset.id} type="button" onClick={() => setRepositories(preset.repositories)}
                  className={`rounded-xl border bg-kumo-base p-4 text-left transition-colors ${selected ? 'border-kumo-brand ring-1 ring-kumo-brand/15' : 'border-kumo-line hover:border-kumo-strong'}`}>
                  <div className="text-[13px] font-medium text-kumo-default">{preset.title}</div>
                  <div className="mt-1 text-xs leading-5 text-kumo-subtle">{preset.description}</div>
                </button>
              )
            })}
          </div>
        )}

        <div className="mt-7 text-[11px] font-medium uppercase tracking-wider text-kumo-subtle">Repositories</div>
        <div className="relative mt-2">
          <MagnifyingGlass size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive" />
          <WorkshopInput value={repositorySearch} onChange={(event) => setRepositorySearch(event.target.value)} placeholder="Search connected GitHub repositories…" aria-label="Search repositories" className="w-full pl-9" />
        </div>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl border border-kumo-line bg-kumo-base p-2">
          <div className="grid gap-2 sm:grid-cols-2">
          {repositoryOptions.map((option) => (
            <RepositoryOptionRow
              key={option.repository}
              name={option.repository}
              label={option.title}
              description={option.description}
              checked={repositories.includes(option.repository)}
              onChange={(checked) => setRepositories(checked ? [...repositories, option.repository] : repositories.filter((item) => item !== option.repository))}
            />
          ))}
          </div>
        </div>
        {repositoryLoading && <p className="mt-2 text-xs text-kumo-subtle">Searching repositories…</p>}
        {!repositoryLoading && repositoryOptions.length === 0 && <p className="mt-3 text-sm text-kumo-subtle">No connected repositories match that search.</p>}

      </div>
      </div>
      <div className="shrink-0 border-t border-kumo-line bg-kumo-base/95 px-6 py-3 shadow-[0_-8px_24px_rgba(0,0,0,0.03)] backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-center">
          <WorkshopInput value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Session title" className="flex-1" />
          <WorkshopButton tone="primary" className="shrink-0 gap-1.5 !rounded-lg !px-3" disabled={creating || !repositories.length || !title.trim()} onClick={create}>
            <TerminalWindow size={14} /> {creating ? 'Starting…' : 'Open session'}
          </WorkshopButton>
        </div>
      </div>
    </section>
  )
}

function RepositoryOptionRow({ name, label, description, checked, onChange }: { name: CodingSessionRepository; label: string; description?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2.5 text-xs text-kumo-default">
      <input className="mt-0.5" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="min-w-0">
        <span className="block truncate font-medium">{label}</span>
        {description && <span className="mt-0.5 block truncate text-[11px] text-kumo-subtle">{description}</span>}
        {label !== name && <span className="mt-0.5 block truncate text-[11px] text-kumo-inactive">{name}</span>}
      </span>
    </label>
  )
}

function ActivityPanel({ activity, onResolve, compact = false }: { activity: CodingSessionActivity[]; onResolve: (id: string, decision: 'approve' | 'reject') => void; compact?: boolean }) {
  const pending = activity.filter((entry) => entry.state === 'pending')
  return (
    <aside className={`${compact ? '' : 'min-h-0 overflow-y-auto border-t border-kumo-line bg-kumo-base lg:border-l lg:border-t-0'}`}>
      <div className="flex h-11 items-center gap-2 border-b border-kumo-line px-3 text-xs font-medium text-kumo-default">
        <ShieldCheck size={14} className="text-kumo-brand" /> Tool approvals
        <span className="ml-auto rounded-full bg-kumo-tint px-1.5 py-0.5 text-[10px] text-kumo-subtle">{pending.length}</span>
      </div>
      <div className="space-y-2 p-3">
        {pending.map((entry) => (
          <div key={entry.id} className="rounded-lg border border-kumo-line bg-kumo-base p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-kumo-subtle">{entry.resourceTitle}</div>
            <div className="mt-1 text-[13px] font-medium text-kumo-default">{entry.description.title}</div>
            <div className="mt-1 line-clamp-4 text-xs leading-5 text-kumo-subtle">{entry.description.description}</div>
            <div className="mt-3 flex gap-2">
              <WorkshopButton tone="primary" onClick={() => onResolve(entry.id, 'approve')}><Check size={13} /> Approve</WorkshopButton>
              <WorkshopButton onClick={() => onResolve(entry.id, 'reject')}><X size={13} /> Reject</WorkshopButton>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-kumo-subtle"><div>{children}</div></div>
}
