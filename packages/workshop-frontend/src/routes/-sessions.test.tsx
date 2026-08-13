// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  context: {
    github: { state: 'missing' } as
      | { state: 'missing' }
      | { state: 'expired'; accountId: number; label: string },
    activeSession: undefined,
    error: undefined as string | undefined,
    activity: [],
    resolveActivity: vi.fn<(id: string, decision: 'approve' | 'reject') => Promise<void>>(),
    restartSession: vi.fn<(id: string) => Promise<void>>(),
    stopSession: vi.fn<(id: string) => Promise<void>>(),
    archiveSession: vi.fn<(id: string) => Promise<void>>(),
    setActiveId: vi.fn<(id: string | undefined) => void>(),
    connect: vi.fn<() => Promise<void>>(async () => {}),
    reconnect: vi.fn<(accountId: number) => Promise<void>>(async () => {}),
  },
}))

vi.mock('../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('../components/sessions/SessionsContext', () => ({
  useSessionsContext: () => testState.context,
}))
vi.mock('../components/sessions/SessionTerminal', () => ({ default: () => null }))

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
})
