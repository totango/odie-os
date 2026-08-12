import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  Archive,
  ArrowClockwise,
  ArrowLeft,
  Check,
  CaretRight,
  GithubLogo,
  Plus,
  ShieldCheck,
  Stop,
  TerminalWindow,
  X,
} from '@phosphor-icons/react'
import type { CodingSessionRepository, CodingSessionSummary } from '@gadgets/workshop-shared/api'
import type { CodingSessionActivity } from '@gadgets/workshop-shared/coding-sessions'
import { useAuthenticatedApi } from '../AuthContext'
import { useGitHubConnection } from '../hooks/useGitHubConnection'
import { useDocumentTitle } from '../useDocumentTitle'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from '../components/WorkshopControls'
import SessionTerminal from '../components/sessions/SessionTerminal'

export const Route = createFileRoute('/sessions')({ component: SessionsPage })

const PRESETS: Array<{ id: string; title: string; description: string; repositories: CodingSessionRepository[] }> = [
  {
    id: 'core',
    title: 'Core',
    description: 'Agentic, integrations, backend, and Zords.',
    repositories: ['agentic', 'unison-integrations', 'leviosa-backend', 'zords'],
  },
  {
    id: 'core-ml',
    title: 'Core + ML Ops',
    description: 'The core stack plus leviosa-ml-ops.',
    repositories: ['agentic', 'unison-integrations', 'leviosa-backend', 'zords', 'leviosa-ml-ops'],
  },
  { id: 'jarvis', title: 'JARVIS', description: 'A focused JARVIS repair session.', repositories: ['jarvis'] },
]

const ALL_REPOSITORIES: CodingSessionRepository[] = [
  'agentic', 'unison-integrations', 'leviosa-backend', 'zords', 'leviosa-ml-ops', 'jarvis',
]

export function SessionsPage() {
  useDocumentTitle('Sessions')
  const { authenticatedApi } = useAuthenticatedApi()
  const github = useGitHubConnection()
  const [sessions, setSessions] = useState<CodingSessionSummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('Coordinated code change')
  const [repositories, setRepositories] = useState<CodingSessionRepository[]>(PRESETS[0].repositories)
  const [activeId, setActiveId] = useState<string>()
  const [showArchived, setShowArchived] = useState(false)
  const [activity, setActivity] = useState<CodingSessionActivity[]>([])

  const activeSession = sessions.find((session) => session.id === activeId && session.status === 'running')

  const refresh = () => {
    setError(undefined)
    setLoaded(false)
    authenticatedApi.listCodingSessions().then((items) => {
      setSessions(items)
      setLoaded(true)
      setActiveId((current) => items.some((session) => session.id === current && session.status === 'running') ? current : undefined)
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : 'Could not load coding sessions.')
      setLoaded(true)
    })
  }

  const refreshActivity = () => {
    authenticatedApi.listCodingSessionActivity().then(setActivity).catch(() => {})
  }

  useEffect(() => {
    if (github.state === 'connected') {
      refresh()
      refreshActivity()
    }
  // Refresh when a newly-connected account arrives; authenticatedApi is stable for one RPC session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticatedApi, github.state])

  useEffect(() => {
    if (github.state !== 'connected') return
    const timer = window.setInterval(refreshActivity, 3_000)
    return () => window.clearInterval(timer)
  // authenticatedApi is stable for one RPC session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticatedApi, github.state])

  const connect = async () => {
    const { url } = await authenticatedApi.connectAccount('github')
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const reconnect = async (accountId: number) => {
    const { url } = await authenticatedApi.reconnectAccount(accountId)
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const create = async () => {
    if (!repositories.length) return
    setCreating(true)
    setError(undefined)
    try {
      const session = await authenticatedApi.createCodingSession({ title, repositories })
      setSessions((current) => [session, ...current])
      if (session.status === 'running') setActiveId(session.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create coding session.')
    } finally {
      setCreating(false)
    }
  }

  const stopSession = async (id: string) => {
    await authenticatedApi.stopCodingSession(id)
    if (activeId === id) setActiveId(undefined)
    refresh()
  }

  const archiveSession = async (id: string) => {
    await authenticatedApi.archiveCodingSession(id)
    if (activeId === id) setActiveId(undefined)
    refresh()
  }

  const resolveActivity = async (id: string, decision: 'approve' | 'reject') => {
    setError(undefined)
    try {
      if (decision === 'approve') await authenticatedApi.approveCodingSessionAction(id)
      else await authenticatedApi.rejectCodingSessionAction(id)
      refreshActivity()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not resolve tool action.')
    }
  }

  if (github.state === 'loading') return <CenteredMessage>Checking GitHub connection…</CenteredMessage>
  if (github.state === 'missing') {
    return (
      <CenteredMessage>
        <GithubLogo size={32} className="mx-auto mb-3" />
        <p>Connect GitHub to open coding sessions across Totango repositories.</p>
        <WorkshopButton tone="primary" className="mt-4" onClick={connect}>Connect GitHub</WorkshopButton>
      </CenteredMessage>
    )
  }
  if (github.state === 'expired') {
    return (
      <CenteredMessage>
        <GithubLogo size={32} className="mx-auto mb-3" />
        <p>Your GitHub connection needs attention before you can use coding sessions.</p>
        <WorkshopButton tone="primary" className="mt-4" onClick={() => reconnect(github.accountId)}>
          Reconnect GitHub
        </WorkshopButton>
      </CenteredMessage>
    )
  }

  if (activeSession) {
    const sessionActivity = activity.filter((entry) => entry.sessionId === activeSession.id)
    return (
      <div className="flex h-full min-h-0 flex-col bg-kumo-base">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-kumo-line px-3 text-kumo-default">
          <WorkshopIconButton aria-label="Back to sessions" onClick={() => setActiveId(undefined)}>
            <ArrowLeft size={16} />
          </WorkshopIconButton>
          <TerminalWindow size={16} className="text-kumo-brand" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-kumo-strong">{activeSession.title}</div>
            <div className="truncate text-[11px] text-kumo-subtle">{activeSession.repositories.join(' / ')}</div>
          </div>
          <span className="hidden text-[11px] text-kumo-success sm:inline">running</span>
          <WorkshopButton onClick={() => stopSession(activeSession.id)}>
            <Stop size={13} /> Stop
          </WorkshopButton>
          <WorkshopIconButton aria-label="Archive session" onClick={() => archiveSession(activeSession.id)}>
            <Archive size={15} />
          </WorkshopIconButton>
        </div>
        {error && <div className="border-b border-kumo-danger/20 bg-kumo-danger-tint px-3 py-2 text-xs text-kumo-danger">{error}</div>}
        <div className={`grid min-h-0 flex-1 ${sessionActivity.some((entry) => entry.state === 'pending') ? 'lg:grid-cols-[minmax(0,1fr)_320px]' : ''}`}>
          <div className="min-h-0"><SessionTerminal sessionId={activeSession.id} /></div>
          {sessionActivity.some((entry) => entry.state === 'pending') && (
            <ActivityPanel activity={sessionActivity} onResolve={resolveActivity} />
          )}
        </div>
      </div>
    )
  }

  const visibleSessions = sessions.filter((session) => showArchived ? !!session.archivedAt : !session.archivedAt)

  return (
    <div className="grid h-full min-h-0 bg-kumo-base lg:grid-cols-[minmax(300px,0.78fr)_minmax(430px,1.22fr)]">
      <section className="flex min-h-0 flex-col border-b border-kumo-line lg:border-b-0 lg:border-r">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-kumo-line px-5">
          <div>
            <h1 className="text-[15px] font-semibold text-kumo-default">Sessions</h1>
            <p className="text-[11px] text-kumo-subtle">Persistent coding environments</p>
          </div>
          <WorkshopIconButton aria-label="Refresh sessions" onClick={refresh}><ArrowClockwise size={15} /></WorkshopIconButton>
        </header>

        <div className="flex shrink-0 gap-1 border-b border-kumo-line px-4 py-2">
          <button type="button" onClick={() => setShowArchived(false)} className={`rounded-md px-2.5 py-1 text-xs ${!showArchived ? 'bg-kumo-tint font-medium text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'}`}>Open</button>
          <button type="button" onClick={() => setShowArchived(true)} className={`rounded-md px-2.5 py-1 text-xs ${showArchived ? 'bg-kumo-tint font-medium text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'}`}>Archived</button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {!loaded ? <p className="px-2 py-4 text-sm text-kumo-subtle">Loading…</p> : visibleSessions.length === 0 ? (
            <div className="px-3 py-12 text-center">
              <TerminalWindow size={24} className="mx-auto text-kumo-inactive" />
              <p className="mt-3 text-sm text-kumo-subtle">{showArchived ? 'No archived sessions.' : 'No sessions yet.'}</p>
            </div>
          ) : visibleSessions.map((session) => (
            <div key={session.id} className="group mb-1 flex items-start gap-2 rounded-lg px-2 py-2.5 hover:bg-kumo-tint">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => session.status === 'running' && setActiveId(session.id)}>
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${session.status === 'running' ? 'bg-emerald-500' : session.status === 'failed' ? 'bg-kumo-danger' : 'bg-kumo-inactive'}`} />
                  <span className="truncate text-[13px] font-medium text-kumo-default">{session.title}</span>
                </div>
                <div className="ml-3.5 mt-1 truncate text-[11px] text-kumo-subtle">{session.repositories.join(' · ')}</div>
                {session.error && <div className="ml-3.5 mt-1 line-clamp-2 text-[11px] text-kumo-danger">{session.error}</div>}
              </button>
              {!session.archivedAt && (
                <WorkshopIconButton aria-label={`Archive ${session.title}`} onClick={() => archiveSession(session.id)} className="opacity-0 group-hover:opacity-100 focus:opacity-100">
                  <Archive size={14} />
                </WorkshopIconButton>
              )}
              {session.status === 'running' && <CaretRight size={14} className="mt-1 text-kumo-inactive" />}
            </div>
          ))}
        </div>
      </section>

      <section className="min-h-0 overflow-y-auto bg-kumo-tint/30 p-6 sm:p-8">
        <div className="mx-auto max-w-2xl">
          {activity.some((entry) => entry.state === 'pending') && (
            <div className="mb-7 overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
              <ActivityPanel activity={activity} onResolve={resolveActivity} compact />
            </div>
          )}
          <div className="flex items-center gap-2 text-sm font-semibold text-kumo-default"><Plus size={15} /> New session</div>
          <p className="mt-1 text-xs text-kumo-subtle">Choose a workspace, then open its OpenCode TUI.</p>
          {error && <div className="mt-5 rounded-lg border border-kumo-danger bg-kumo-danger-tint px-4 py-3 text-sm text-kumo-danger">{error}</div>}

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {PRESETS.map((preset) => {
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

          <div className="mt-7 text-[11px] font-medium uppercase tracking-wider text-kumo-subtle">Repositories</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {ALL_REPOSITORIES.map((repository) => (
              <label key={repository} className="flex cursor-pointer items-center gap-2 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2.5 text-xs text-kumo-default">
                <input type="checkbox" checked={repositories.includes(repository)} onChange={(event) => {
                  setRepositories((current) => event.target.checked ? [...current, repository] : current.filter((item) => item !== repository))
                }} />
                {repository}
              </label>
            ))}
          </div>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <WorkshopInput value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Session title" className="flex-1" />
            <WorkshopButton tone="primary" disabled={creating || !repositories.length || !title.trim()} onClick={create}>
              <TerminalWindow size={14} /> {creating ? 'Starting…' : 'Open session'}
            </WorkshopButton>
          </div>
        </div>
      </section>
    </div>
  )
}

function ActivityPanel({
  activity,
  onResolve,
  compact = false,
}: {
  activity: CodingSessionActivity[]
  onResolve: (id: string, decision: 'approve' | 'reject') => void
  compact?: boolean
}) {
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
