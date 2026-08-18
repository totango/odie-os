// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodingSessionRepository, CodingSessionRuntime, CodingSessionSummary } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  piEnabled: false,
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
    runtime: 'opencode' as 'opencode' | 'pi',
    setRuntime: vi.fn<(runtime: CodingSessionRuntime) => void>(),
    creating: false,
    create: vi.fn<() => Promise<void>>(async () => {}),
  },
}))

vi.mock('../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('../components/sessions/SessionsContext', () => ({
  useSessionsContext: () => testState.context,
}))
vi.mock('../components/sessions/SessionTerminal', () => ({
  default: (props: unknown) => { testState.terminalProps(props); return null },
}))
vi.mock('../FeatureFlagsContext', () => ({
  useUiFeatureFlag: () => ({ enabled: testState.piEnabled, loading: false }),
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
    testState.piEnabled = false
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

  it('offers Pi only when the rollout flag is enabled', async () => {
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
    expect(piButton).toBeTruthy()

    await act(async () => piButton!.click())
    expect(testState.context.setRuntime).toHaveBeenCalledWith('pi')
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
})
