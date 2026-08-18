import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { CodingSessionRepository, CodingSessionRepositoryOption, CodingSessionRuntime, CodingSessionSummary } from '@gadgets/workshop-shared/api'
import type { CodingSessionActivity } from '@gadgets/workshop-shared/coding-sessions'
import { useAuthenticatedApi } from '../../AuthContext'
import { useGitHubConnection } from '../../hooks/useGitHubConnection'

export const CODING_SESSION_PRESETS: Array<{
  id: string
  title: string
  description: string
  repositories: CodingSessionRepository[]
}> = [
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

type SessionsContextValue = {
  github: ReturnType<typeof useGitHubConnection>
  sessions: CodingSessionSummary[]
  openSessions: CodingSessionSummary[]
  archivedSessions: CodingSessionSummary[]
  loaded: boolean
  error?: string
  creating: boolean
  title: string
  setTitle: (title: string) => void
  runtime: CodingSessionRuntime
  setRuntime: (runtime: CodingSessionRuntime) => void
  repositories: CodingSessionRepository[]
  setRepositories: (repositories: CodingSessionRepository[]) => void
  repositoryOptions: CodingSessionRepositoryOption[]
  repositorySearch: string
  setRepositorySearch: (query: string) => void
  repositoryLoading: boolean
  availablePresets: typeof CODING_SESSION_PRESETS
  activeId?: string
  setActiveId: (id: string | undefined) => void
  activeSession?: CodingSessionSummary
  activity: CodingSessionActivity[]
  refresh: () => void
  refreshActivity: () => void
  create: () => Promise<void>
  stopSession: (id: string) => Promise<void>
  restartSession: (id: string) => Promise<void>
  archiveSession: (id: string) => Promise<void>
  resolveActivity: (id: string, decision: 'approve' | 'reject') => Promise<void>
  connect: () => Promise<void>
  reconnect: (accountId: number) => Promise<void>
}

type GitHubAccountConnector = {
  connectAccount: (vendorId: 'github') => Promise<{ url: string }>
  reconnectAccount: (accountId: number) => Promise<{ url: string }>
}

export async function openGitHubAccountPopup(
  authenticatedApi: GitHubAccountConnector,
  request: { kind: 'connect' } | { kind: 'reconnect'; accountId: number },
): Promise<void> {
  const popup = window.open('', '_blank')
  if (!popup) {
    throw new Error(`Allow pop-ups to ${request.kind === 'connect' ? 'connect' : 'reconnect'} GitHub, then try again.`)
  }
  popup.opener = null
  try {
    const { url } = request.kind === 'connect'
      ? await authenticatedApi.connectAccount('github')
      : await authenticatedApi.reconnectAccount(request.accountId)
    popup.location.replace(url)
  } catch (caught) {
    popup.close()
    throw caught
  }
}

const SessionsContext = createContext<SessionsContextValue | null>(null)

export function SessionsProvider({ children }: { children: ReactNode }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const github = useGitHubConnection()
  const [sessions, setSessions] = useState<CodingSessionSummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('Coordinated code change')
  const [runtime, setRuntime] = useState<CodingSessionRuntime>('opencode')
  const [repositories, setRepositories] = useState<CodingSessionRepository[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [activity, setActivity] = useState<CodingSessionActivity[]>([])
  const [repositorySearch, setRepositorySearch] = useState('')
  const [repositoryOptions, setRepositoryOptions] = useState<CodingSessionRepositoryOption[]>([])
  const [repositoryLoading, setRepositoryLoading] = useState(false)

  const refresh = useCallback(() => {
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
  }, [authenticatedApi])

  const refreshActivity = useCallback(() => {
    authenticatedApi.listCodingSessionActivity().then(setActivity).catch(() => {})
  }, [authenticatedApi])

  useEffect(() => {
    if (github.state !== 'connected') return
    refresh()
    refreshActivity()
  }, [github.state, refresh, refreshActivity])

  useEffect(() => {
    if (github.state !== 'connected') return
    const timer = window.setInterval(refreshActivity, 3_000)
    return () => window.clearInterval(timer)
  }, [github.state, refreshActivity])

  useEffect(() => {
    if (github.state !== 'connected') return
    let cancelled = false
    const timer = window.setTimeout(() => {
      setRepositoryLoading(true)
      authenticatedApi.listCodingSessionRepositoryOptions(repositorySearch).then((options) => {
        if (!cancelled) setRepositoryOptions(options)
      }).catch((caught: unknown) => {
        if (!cancelled) {
          setRepositoryOptions([])
          setError(caught instanceof Error ? caught.message : 'Could not load GitHub repositories.')
        }
      }).finally(() => {
        if (!cancelled) setRepositoryLoading(false)
      })
    }, 180)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [authenticatedApi, github.state, repositorySearch])

  const connect = useCallback(async () => {
    await openGitHubAccountPopup(authenticatedApi, { kind: 'connect' })
  }, [authenticatedApi])

  const reconnect = useCallback(async (accountId: number) => {
    await openGitHubAccountPopup(authenticatedApi, { kind: 'reconnect', accountId })
  }, [authenticatedApi])

  const create = useCallback(async () => {
    if (!repositories.length) return
    setCreating(true)
    setError(undefined)
    try {
      const session = await authenticatedApi.createCodingSession({ title, repositories, runtime })
      setSessions((current) => [session, ...current])
      if (session.status === 'running') setActiveId(session.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create coding session.')
    } finally {
      setCreating(false)
    }
  }, [authenticatedApi, repositories, runtime, title])

  const stopSession = useCallback(async (id: string) => {
    await authenticatedApi.stopCodingSession(id)
    if (activeId === id) setActiveId(undefined)
    refresh()
  }, [activeId, authenticatedApi, refresh])

  const restartSession = useCallback(async (id: string) => {
    setError(undefined)
    try {
      const session = await authenticatedApi.restartCodingSession(id)
      setSessions((current) => current.map((item) => item.id === id ? session : item))
      if (session.status !== 'running') setActiveId(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not restart coding session.')
    }
  }, [authenticatedApi])

  const archiveSession = useCallback(async (id: string) => {
    await authenticatedApi.archiveCodingSession(id)
    if (activeId === id) setActiveId(undefined)
    refresh()
  }, [activeId, authenticatedApi, refresh])

  const resolveActivity = useCallback(async (id: string, decision: 'approve' | 'reject') => {
    setError(undefined)
    try {
      if (decision === 'approve') await authenticatedApi.approveCodingSessionAction(id)
      else await authenticatedApi.rejectCodingSessionAction(id)
      refreshActivity()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not resolve tool action.')
    }
  }, [authenticatedApi, refreshActivity])

  const activeSession = sessions.find((session) => session.id === activeId && session.status === 'running')
  const availableRepositoryNames = new Set(repositoryOptions.map((option) => option.repository))
  const availablePresets = CODING_SESSION_PRESETS.filter((preset) => preset.repositories.every((repo) => availableRepositoryNames.has(repo)))

  const value = useMemo<SessionsContextValue>(() => ({
    github,
    sessions,
    openSessions: sessions.filter((session) => !session.archivedAt),
    archivedSessions: sessions.filter((session) => !!session.archivedAt),
    loaded,
    error,
    creating,
    title,
    setTitle,
    runtime,
    setRuntime,
    repositories,
    setRepositories,
    repositoryOptions,
    repositorySearch,
    setRepositorySearch,
    repositoryLoading,
    availablePresets,
    activeId,
    setActiveId,
    activeSession,
    activity,
    refresh,
    refreshActivity,
    create,
    stopSession,
    restartSession,
    archiveSession,
    resolveActivity,
    connect,
    reconnect,
  }), [
    activeId, activeSession, activity, archiveSession, availablePresets, connect, create, creating, error,
    github, loaded, reconnect, refresh, refreshActivity, repositories, repositoryLoading, repositoryOptions,
    repositorySearch, resolveActivity, restartSession, runtime, sessions, stopSession, title,
  ])

  return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>
}

export function useSessionsContext(): SessionsContextValue {
  const context = useContext(SessionsContext)
  if (!context) throw new Error('useSessionsContext must be used inside SessionsProvider')
  return context
}
