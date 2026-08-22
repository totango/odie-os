// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodingSessionActivity } from '@gadgets/workshop-shared/coding-sessions'
import type { CodingSessionSummary } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  github: { state: 'connected', accountId: 42, label: 'octo@example.com' } as { state: 'connected'; accountId: number; label: string } | { state: 'missing' },
  authenticatedApi: undefined as unknown,
}))

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

vi.mock('../../hooks/useGitHubConnection', () => ({
  useGitHubConnection: () => testState.github,
}))

import { openGitHubAccountPopup, SessionsProvider, useSessionsContext } from './SessionsContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

function session(overrides: Partial<CodingSessionSummary> = {}): CodingSessionSummary {
  return {
    id: 'session-1',
    title: 'Fix Jarvis',
    repositories: ['jarvis'],
    runtime: 'opencode',
    status: 'running',
    createdAt: new Date('2026-08-18T00:00:00Z'),
    lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  }
}

function activity(overrides: Partial<CodingSessionActivity> = {}): CodingSessionActivity {
  return {
    id: 'activity-1',
    sessionId: 'session-1',
    vendorId: 'github',
    resourceTitle: 'Shell',
    type: 'action',
    description: { title: 'Run command', description: 'Needs approval' },
    state: 'pending',
    createdAt: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  }
}

function createApi() {
  return {
    listCodingSessions: vi.fn<() => Promise<CodingSessionSummary[]>>(async () => []),
    listCodingSessionActivity: vi.fn<() => Promise<CodingSessionActivity[]>>(async () => []),
    listCodingSessionRepositoryOptions: vi.fn<(query?: string) => Promise<[]>>(async () => []),
    createCodingSession: vi.fn<(request: unknown) => Promise<CodingSessionSummary>>(async () => session({ status: 'starting' })),
    stopCodingSession: vi.fn<(id: string) => Promise<void>>(async () => {}),
    restartCodingSession: vi.fn<(id: string) => Promise<CodingSessionSummary>>(async () => session({ status: 'starting' })),
    archiveCodingSession: vi.fn<(id: string) => Promise<void>>(async () => {}),
    approveCodingSessionAction: vi.fn<(id: string) => Promise<void>>(async () => {}),
    rejectCodingSessionAction: vi.fn<(id: string) => Promise<void>>(async () => {}),
    connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/connect' })),
    reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/reconnect' })),
  }
}

type ProviderContext = ReturnType<typeof useSessionsContext>

async function renderProvider({ loadRepositories = false }: { loadRepositories?: boolean } = {}) {
  let latestContext: ProviderContext | undefined
  let root: Root | undefined
  const container = document.createElement('div')
  document.body.append(container)

  function Probe() {
    latestContext = useSessionsContext()
    return null
  }

  root = createRoot(container)
  await act(async () => {
    const props: ComponentProps<typeof SessionsProvider> = { loadRepositories, children: createElement(Probe) }
    root!.render(createElement(SessionsProvider, props))
  })
  return {
    get context() {
      if (!latestContext) throw new Error('context not rendered')
      return latestContext
    },
    async unmount() {
      await act(async () => root?.unmount())
      container.remove()
    },
  }
}

function fakePopup() {
  return {
    opener: {} as unknown,
    close: vi.fn<() => void>(),
    location: { replace: vi.fn<(url: string) => void>() },
  }
}

describe('openGitHubAccountPopup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
    testState.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.authenticatedApi = createApi()
  })

  testState.authenticatedApi = createApi()

  it('opens a popup synchronously and navigates it to the GitHub connect OAuth URL', async () => {
    const popup = fakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const authenticatedApi = {
      connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/connect' })),
      reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/reconnect' })),
    }

    const promise = openGitHubAccountPopup(authenticatedApi, { kind: 'connect' })

    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(authenticatedApi.connectAccount).toHaveBeenCalledWith('github')

    await promise

    expect(popup.opener).toBeNull()
    expect(popup.location.replace).toHaveBeenCalledWith('https://github.example.test/oauth/connect')
    expect(popup.close).not.toHaveBeenCalled()
    expect(authenticatedApi.reconnectAccount).not.toHaveBeenCalled()
  })

  it('opens a popup synchronously and navigates it to the GitHub reconnect OAuth URL', async () => {
    const popup = fakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const authenticatedApi = {
      connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/connect' })),
      reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/reconnect' })),
    }

    const promise = openGitHubAccountPopup(authenticatedApi, { kind: 'reconnect', accountId: 42 })

    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(authenticatedApi.reconnectAccount).toHaveBeenCalledWith(42)

    await promise

    expect(popup.location.replace).toHaveBeenCalledWith('https://github.example.test/oauth/reconnect')
    expect(popup.close).not.toHaveBeenCalled()
    expect(authenticatedApi.connectAccount).not.toHaveBeenCalled()
  })

  it('closes the already-opened popup when the connect RPC fails', async () => {
    const popup = fakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const failure = new Error('GitHub connector is unavailable')
    const authenticatedApi = {
      connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => { throw failure }),
      reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/reconnect' })),
    }

    await expect(openGitHubAccountPopup(authenticatedApi, { kind: 'connect' })).rejects.toThrow(failure)

    expect(popup.close).toHaveBeenCalledOnce()
    expect(popup.location.replace).not.toHaveBeenCalled()
  })

  it('rejects with useful copy when the browser blocks the popup', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const authenticatedApi = {
      connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/connect' })),
      reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/reconnect' })),
    }

    await expect(openGitHubAccountPopup(authenticatedApi, { kind: 'connect' })).rejects.toThrow(
      'Allow pop-ups to connect GitHub, then try again.',
    )
    expect(authenticatedApi.connectAccount).not.toHaveBeenCalled()
    expect(authenticatedApi.reconnectAccount).not.toHaveBeenCalled()
  })
})

describe('SessionsProvider responsiveness', () => {
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    testState.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.authenticatedApi = createApi()
  })

  it('selects a newly created session even while it is starting', async () => {
    const api = createApi()
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => rendered.context.setRepositories(['jarvis']))
    await act(async () => rendered.context.create())

    expect(api.createCodingSession).toHaveBeenCalledWith({ title: 'Coordinated code change', repositories: ['jarvis'], runtime: 'opencode' })
    expect(rendered.context.activeId).toBe('session-1')
    expect(rendered.context.activeSession?.status).toBe('starting')

    await rendered.unmount()
  })

  it('does not let an older session refresh clear a newer starting session', async () => {
    const api = createApi()
    const initialList = deferred<CodingSessionSummary[]>()
    api.listCodingSessions.mockReturnValueOnce(initialList.promise)
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => rendered.context.setRepositories(['jarvis']))
    await act(async () => rendered.context.create())
    await act(async () => initialList.resolve([]))

    expect(rendered.context.activeId).toBe('session-1')
    expect(rendered.context.sessions.map((item) => item.id)).toEqual(['session-1'])

    await rendered.unmount()
  })

  it('polls starting session metadata without overlapping requests', async () => {
    vi.useFakeTimers()
    const api = createApi()
    api.listCodingSessions.mockResolvedValueOnce([])
    const poll = deferred<CodingSessionSummary[]>()
    api.listCodingSessions.mockReturnValueOnce(poll.promise)
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => rendered.context.setRepositories(['jarvis']))
    await act(async () => rendered.context.create())
    await act(async () => vi.advanceTimersByTime(1_000))
    expect(api.listCodingSessions).toHaveBeenCalledTimes(2)

    await act(async () => vi.advanceTimersByTime(6_000))
    expect(api.listCodingSessions).toHaveBeenCalledTimes(2)

    api.listCodingSessions.mockResolvedValueOnce([session({ status: 'running' })])
    await act(async () => poll.resolve([session({ status: 'starting' })]))
    expect(api.listCodingSessions).toHaveBeenCalledTimes(3)
    await act(async () => {})
    expect(rendered.context.activeSession?.status).toBe('running')

    await rendered.unmount()
  })

  it('keeps loaded true during background refreshes', async () => {
    vi.useFakeTimers()
    const api = createApi()
    api.listCodingSessions.mockResolvedValueOnce([])
    const poll = deferred<CodingSessionSummary[]>()
    api.listCodingSessions.mockReturnValueOnce(poll.promise)
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    expect(rendered.context.loaded).toBe(true)
    await act(async () => rendered.context.setRepositories(['jarvis']))
    await act(async () => rendered.context.create())
    await act(async () => vi.advanceTimersByTime(1_000))

    expect(rendered.context.loaded).toBe(true)

    await rendered.unmount()
  })

  it('does not let stale activity overwrite activity after an action decision', async () => {
    const api = createApi()
    const initialActivity = deferred<CodingSessionActivity[]>()
    api.listCodingSessionActivity.mockReturnValueOnce(initialActivity.promise)
    api.listCodingSessionActivity.mockResolvedValueOnce([])
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => rendered.context.resolveActivity('activity-1', 'approve'))
    await act(async () => initialActivity.resolve([activity()]))
    await act(async () => {})

    expect(api.approveCodingSessionAction).toHaveBeenCalledWith('activity-1')
    expect(rendered.context.activity).toEqual([])

    await rendered.unmount()
  })

  it('loads repository options only when enabled by the sessions route', async () => {
    vi.useFakeTimers()
    const api = createApi()
    testState.authenticatedApi = api
    const outsideSessions = await renderProvider({ loadRepositories: false })

    await act(async () => vi.advanceTimersByTime(250))
    expect(api.listCodingSessionRepositoryOptions).not.toHaveBeenCalled()
    await outsideSessions.unmount()

    const insideSessions = await renderProvider({ loadRepositories: true })
    await act(async () => vi.advanceTimersByTime(250))

    expect(api.listCodingSessionRepositoryOptions).toHaveBeenCalledOnce()

    await insideSessions.unmount()
  })
})
