// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodingSessionRepository, CodingSessionRuntime, CodingSessionSummary } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  piEnabled: false,
  piLoading: false,
  terminalMounts: 0,
  terminalProps: vi.fn<(props: unknown) => void>(),
  context: {
    github: { state: 'missing' } as
      | { state: 'missing' }
      | { state: 'expired'; accountId: number; label: string }
      | { state: 'connected'; accountId: number; label: string },
    activeSession: undefined as CodingSessionSummary | undefined,
    error: undefined as string | undefined,
    activity: [],
    resolveActivity: vi.fn<(id: string, decision: 'approve' | 'reject') => Promise<void>>(),
    restartSession: vi.fn<(id: string) => Promise<void>>(),
    stopSession: vi.fn<(id: string) => Promise<void>>(),
    archiveSession: vi.fn<(id: string) => Promise<void>>(),
    setActiveId: vi.fn<(id: string | undefined) => void>(),
    refresh: vi.fn<() => void>(),
    connect: vi.fn<() => Promise<void>>(async () => {}),
    reconnect: vi.fn<(accountId: number) => Promise<void>>(async () => {}),
    availablePresets: [],
    repositories: ['jarvis'],
    setRepositories: vi.fn<(repositories: CodingSessionRepository[]) => void>(),
    repositoryOptions: [{ repository: 'jarvis', title: 'totango/jarvis', private: true }],
    repositorySearch: '',
    setRepositorySearch: vi.fn<(query: string) => void>(),
    repositoryLoading: false,
    title: 'Fix Jarvis',
    setTitle: vi.fn<(title: string) => void>(),
    runtime: 'opencode' as CodingSessionRuntime,
    setRuntime: vi.fn<(runtime: CodingSessionRuntime) => void>(),
    creating: false,
    create: vi.fn<() => Promise<void>>(async () => {}),
  },
}))

vi.mock('../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('../components/sessions/SessionsContext', () => ({
  useSessionsContext: () => testState.context,
}))
vi.mock('../components/sessions/SessionTerminal', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    default: (props: unknown) => {
      const [mountId] = React.useState(() => ++testState.terminalMounts)
      testState.terminalProps({ ...(props as object), mountId })
      return null
    },
  }
})
vi.mock('../FeatureFlagsContext', () => ({
  useUiFeatureFlag: () => ({ enabled: testState.piEnabled, loading: testState.piLoading }),
}))

import { SessionsPage } from './sessions'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('SessionsPage locked Code setup', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
    testState.context.github = { state: 'missing' }
    testState.context.error = undefined
    testState.context.activeSession = undefined
    testState.context.runtime = 'opencode'
    testState.context.refresh.mockClear()
    testState.terminalMounts = 0
    testState.piEnabled = false
    testState.piLoading = false
  })

  async function render() {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<SessionsPage />))
    return container
  }

  it('shows setup and connects when GitHub is missing', async () => {
    const rendered = await render()

    expect(rendered.textContent).toContain('Set up Code')
    expect(rendered.textContent).toContain('Chat remains usable')
    const button = Array.from(rendered.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Connect GitHub'))
    expect(button).toBeTruthy()

    await act(async () => button!.click())

    expect(testState.context.connect).toHaveBeenCalledOnce()
    expect(testState.context.reconnect).not.toHaveBeenCalled()
  })

  it('reconnects the expired GitHub account and preserves provider error copy', async () => {
    testState.context.github = { state: 'expired', accountId: 42, label: 'octo@example.com' }
    testState.context.error = 'Provider reported expired credentials.'
    const rendered = await render()

    expect(rendered.textContent).toContain('Reconnect octo@example.com')
    expect(rendered.textContent).toContain('Provider reported expired credentials.')
    const button = Array.from(rendered.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Reconnect GitHub'))
    expect(button).toBeTruthy()

    await act(async () => button!.click())

    expect(testState.context.reconnect).toHaveBeenCalledWith(42)
    expect(testState.context.connect).not.toHaveBeenCalled()
  })

  it('offers Pi but keeps Prime Agent hidden until its image is pinned', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    let rendered = await render()

    expect(rendered.textContent).not.toContain('Coding agent')

    await act(async () => root?.unmount())
    root = undefined
    container?.remove()
    container = undefined
    testState.piEnabled = true
    rendered = await render()

    expect(rendered.textContent).toContain('Coding agent')
    const piButton = Array.from(rendered.querySelectorAll('button')).find((candidate) => candidate.textContent?.startsWith('Pi'))
    const primeButton = Array.from(rendered.querySelectorAll('button')).find((candidate) => candidate.textContent?.startsWith('Prime Agent'))
    expect(piButton).toBeTruthy()
    expect(primeButton).toBeUndefined()

    await act(async () => piButton!.click())
    expect(testState.context.setRuntime).toHaveBeenCalledWith('pi')
    expect(testState.context.setRuntime).not.toHaveBeenCalledWith('prime-agent')
  })

  it('resets an alternate runtime when the coding-runtime flag is disabled', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.runtime = 'prime-agent'

    await render()

    expect(testState.context.setRuntime).toHaveBeenCalledWith('opencode')
  })

  it('preserves an alternate runtime while the rollout flag is loading', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.runtime = 'prime-agent'
    testState.piLoading = true

    await render()

    expect(testState.context.setRuntime).not.toHaveBeenCalled()
  })

  it('labels the primary terminal with the persisted runtime', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1',
      title: 'Pi repair',
      repositories: ['jarvis'],
      runtime: 'pi',
      status: 'running',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }

    const rendered = await render()
    const terminalMode = rendered.querySelector('[aria-label="Terminal mode"]')

    expect(terminalMode?.textContent).toContain('Pi')
    expect(terminalMode?.textContent).toContain('Shell')
    expect(terminalMode?.textContent).not.toContain('OpenCode')
    expect(testState.terminalProps).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'pi' }))
  })

  it('labels the primary terminal for a persisted Prime Agent session', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-prime',
      title: 'Prime repair',
      repositories: ['jarvis'],
      runtime: 'prime-agent',
      status: 'running',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }

    const rendered = await render()
    expect(rendered.querySelector('[aria-label="Terminal mode"]')?.textContent).toContain('Prime Agent')
    expect(testState.terminalProps).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'prime-agent' }))
  })

  it('refreshes sessions when the terminal reports the environment is unavailable', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1',
      title: 'Pi repair',
      repositories: ['jarvis'],
      runtime: 'pi',
      status: 'running',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }

    await render()
    const props = testState.terminalProps.mock.calls.at(-1)?.[0] as { onSessionUnavailable?: () => void }
    props.onSessionUnavailable?.()

    expect(testState.context.refresh).toHaveBeenCalledOnce()
  })

  it('presents restart instead of terminal reconnect for expired environments', async () => {
    window.confirm = vi.fn<() => boolean>(() => true)
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1',
      title: 'Expired repair',
      repositories: ['jarvis'],
      runtime: 'opencode',
      status: 'failed',
      error: 'Coding session environment expired. Restart the session to continue.',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }

    const rendered = await render()

    expect(rendered.textContent).toContain('Environment needs restart')
    expect(rendered.textContent).not.toContain('Reconnect')
    const button = Array.from(rendered.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Restart environment'))
    expect(button).toBeTruthy()

    await act(async () => button!.click())
    expect(testState.context.restartSession).toHaveBeenCalledWith('session-1')
  })

  it('shows a neutral progress panel while an active session is starting', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1',
      title: 'Starting repair',
      repositories: ['jarvis'],
      runtime: 'opencode',
      status: 'starting',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }

    const rendered = await render()

    expect(rendered.textContent).toContain('Starting environment')
    expect(rendered.textContent).not.toContain('Environment needs restart')
    expect(testState.terminalProps).not.toHaveBeenCalled()
  })

  it('shows a neutral progress panel while an active session is stopping', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1',
      title: 'Stopping repair',
      repositories: ['jarvis'],
      runtime: 'opencode',
      status: 'stopping',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }

    const rendered = await render()

    expect(rendered.textContent).toContain('Stopping environment')
    expect(rendered.textContent).not.toContain('Environment needs restart')
    expect(testState.terminalProps).not.toHaveBeenCalled()
  })

  it('transitions from starting progress to the terminal when refreshed state becomes running', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1',
      title: 'Starting repair',
      repositories: ['jarvis'],
      runtime: 'opencode',
      status: 'starting',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }
    const rendered = await render()
    expect(rendered.textContent).toContain('Starting environment')

    testState.context.activeSession = { ...testState.context.activeSession, status: 'running' } as CodingSessionSummary
    await act(async () => root!.render(<SessionsPage />))

    expect(rendered.textContent).not.toContain('Starting environment')
    expect(testState.terminalProps).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }))
  })

  it('does not remount a running terminal when only lastActiveAt changes', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1',
      title: 'Pi repair',
      repositories: ['jarvis'],
      runtime: 'pi',
      status: 'running',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }
    await render()
    const firstProps = testState.terminalProps.mock.calls.at(-1)?.[0]
    expect(firstProps).toBeDefined()
    const firstMountId = (firstProps as { mountId: number }).mountId

    testState.context.activeSession = {
      ...testState.context.activeSession,
      lastActiveAt: new Date('2026-08-18T00:05:00Z'),
    } as CodingSessionSummary
    await act(async () => root!.render(<SessionsPage />))

    const latestProps = testState.terminalProps.mock.calls.at(-1)?.[0]
    expect(latestProps).toBeDefined()
    expect((latestProps as { mountId: number }).mountId).toBe(firstMountId)
  })
})
