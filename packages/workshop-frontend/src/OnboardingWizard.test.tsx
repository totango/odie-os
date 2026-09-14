// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { expect, it, vi } from 'vitest'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'
import OnboardingWizard from './OnboardingWizard'

vi.mock('./AuthContext', () => ({ useAuthenticatedApi: vi.fn<typeof useAuthenticatedApi>() }))
vi.mock('./ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'Test Workshop' }))
vi.mock('./components/SiteLogo', () => ({ default: ({ children }: { children: ReactNode }) => children }))
vi.mock('./AddModelModal', () => ({ default: () => null }))
vi.mock('@cloudflare/kumo', () => ({ Switch: () => null, useKumoToastManager: () => ({ add: vi.fn<() => void>() }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('lets a new account navigate from onboarding to the board without completing setup or connecting services', async () => {
  const dispose = vi.fn<() => void>()
  const subscription = Object.assign(Promise.resolve({ [Symbol.dispose]: dispose }), { [Symbol.dispose]: dispose })
  const api = {
    listModels: vi.fn<AuthenticatedApi['listModels']>(async () => []),
    getAiConfig: vi.fn<AuthenticatedApi['getAiConfig']>(async () => ({ enabled: false })),
    listGatekeeperVendors: vi.fn<AuthenticatedApi['listGatekeeperVendors']>(async () => []),
    subscribeConnectedAccounts: vi.fn<() => typeof subscription>(() => subscription),
    completeOnboarding: vi.fn<AuthenticatedApi['completeOnboarding']>(),
    connectAccount: vi.fn<AuthenticatedApi['connectAccount']>(),
  }
  vi.mocked(useAuthenticatedApi).mockReturnValue({ authenticatedApi: api as never, currentUser: null, isAdmin: false, logout: vi.fn<() => void>() })
  const complete = vi.fn<() => void>()
  const base = createRootRoute()
  const home = createRoute({ getParentRoute: () => base, path: '/', component: () => <OnboardingWizard onComplete={complete} /> })
  const board = createRoute({ getParentRoute: () => base, path: '/requests', component: () => <h1>Feature requests reached</h1> })
  const router = createRouter({ routeTree: base.addChildren([home, board]), history: createMemoryHistory({ initialEntries: ['/'] }) })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  try {
    await act(async () => { await router.load(); root.render(<RouterProvider router={router} />) })
    expect(container.textContent).toContain("Let's set you up")
    const link = container.querySelector<HTMLAnchorElement>('a[href="/requests"]')
    expect(link?.textContent).toContain('without completing setup')
    await act(async () => link!.click())
    expect(container.textContent).toContain('Feature requests reached')
    expect(api.completeOnboarding).not.toHaveBeenCalled()
    expect(api.connectAccount).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  }
})
