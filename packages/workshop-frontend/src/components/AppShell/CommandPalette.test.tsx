// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CommandPalette from './CommandPalette'
import { CREATE_JIRA_ISSUE_PROMPT } from '../../createJiraIssuePrompt'

const authenticatedApi = {
  listGadgets: vi.fn<() => Promise<never[]>>(async () => []),
  listOwnBlueprints: vi.fn<() => Promise<never[]>>(async () => []),
  listLibraryBlueprints: vi.fn<() => Promise<never[]>>(async () => []),
  listOutputFormats: vi.fn<() => Promise<never[]>>(async () => []),
}

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi }),
}));

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}));

vi.mock('../../useGatekeeperApps', () => ({
  useGatekeeperApps: () => [{ id: 'work-items', title: 'Work Items', vendorId: 'work-items' }],
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(window, 'scrollTo', { value: vi.fn<() => void>(), configurable: true })
Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn<() => void>(), configurable: true })

describe('CommandPalette', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
  })

  it('adds visible gatekeeper management apps as navigation commands', async () => {
    const rootRoute = createRootRoute({ component: () => <CommandPalette open onClose={() => {}} /> })
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ['/'] }),
      routeTree: rootRoute,
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(<RouterProvider router={router} />))
    expect(container.textContent).toContain('Work Items')
    expect(container.textContent).toContain('Library')
    expect(container.textContent).not.toContain('Blueprints')

    const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent?.includes('Work Items'))
    if (!button) throw new Error('Missing Work Items command')
    await act(async () => { button.click(); await Promise.resolve() })

    expect(router.state.location.pathname).toBe('/gatekeepers/work-items')
  })

  it('seeds the Home composer for first-class Jira creation', async () => {
    const rootRoute = createRootRoute({ component: () => <CommandPalette open onClose={() => {}} /> })
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ['/workspaces'] }),
      routeTree: rootRoute,
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(<RouterProvider router={router} />))
    expect(container.textContent).toContain('Create Jira issue')

    const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent?.includes('Create Jira issue'))
    if (!button) throw new Error('Missing Create Jira issue command')
    await act(async () => { button.click(); await Promise.resolve() })

    expect(router.state.location.pathname).toBe('/')
    expect(router.state.location.search).toEqual({ prompt: CREATE_JIRA_ISSUE_PROMPT })
  })
})
