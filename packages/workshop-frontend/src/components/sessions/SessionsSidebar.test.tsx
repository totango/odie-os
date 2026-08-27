// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import type React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodingSessionSummary } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  context: {
    openSessions: [] as CodingSessionSummary[],
    archivedSessions: [] as CodingSessionSummary[],
    loaded: true,
    refresh: vi.fn<() => void>(),
    activeId: undefined as string | undefined,
    setActiveId: vi.fn<(id: string | undefined) => void>(),
    archiveSession: vi.fn<(id: string) => void>(),
  },
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}))

vi.mock('./SessionsContext', () => ({
  useSessionsContext: () => testState.context,
}))

import SessionsSidebar from './SessionsSidebar'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function session(status: CodingSessionSummary['status'], id = status): CodingSessionSummary {
  return {
    id,
    title: `${status} session`,
    repositories: ['jarvis'],
    runtime: 'opencode',
    status,
    createdAt: new Date('2026-08-18T00:00:00Z'),
    lastActiveAt: new Date('2026-08-18T00:00:00Z'),
  }
}

describe('SessionsSidebar', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    testState.context.openSessions = []
    testState.context.archivedSessions = []
    testState.context.activeId = undefined
    vi.clearAllMocks()
  })

  async function render() {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<SessionsSidebar />))
    return container
  }

  it('opens non-running session rows so their progress or recovery pane can render', async () => {
    testState.context.openSessions = [session('starting'), session('stopping'), session('failed')]
    const rendered = await render()

    for (const status of ['starting', 'stopping', 'failed']) {
      const button = Array.from(rendered.querySelectorAll('button'))
        .find((candidate) => candidate.textContent?.includes(`${status} session`))
      expect(button).toBeTruthy()
      await act(async () => button!.click())
      expect(testState.context.setActiveId).toHaveBeenLastCalledWith(status)
    }
  })
})
