// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProductFeedbackButton from './ProductFeedbackButton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ProductFeedbackButton board transition', () => {
  let root: Root
  let container: HTMLDivElement
  afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.restoreAllMocks() })

  it.each([false, true])('always links to the board without an automation or GitHub prerequisite (collapsed=%s)', async collapsed => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    const base = createRootRoute()
    const index = createRoute({ getParentRoute: () => base, path: '/', component: () => <ProductFeedbackButton collapsed={collapsed} /> })
    const requests = createRoute({ getParentRoute: () => base, path: '/requests', component: () => <h1>Board reached</h1> })
    const router = createRouter({ routeTree: base.addChildren([index, requests]), history: createMemoryHistory({ initialEntries: ['/'] }) })
    await act(async () => { await router.load(); root.render(<RouterProvider router={router} />) })
    expect(container.querySelector('a')?.getAttribute('aria-label')).toBe('Community requests')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/requests')
    await act(async () => container.querySelector('a')!.click())
    expect(container.textContent).toContain('Board reached')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})
