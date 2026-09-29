// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminApi, AdminSettingsView } from '@gadgets/workshop-shared/api'
import AdminPage from './AdminPage'

const hooks = vi.hoisted(() => ({
  auth: vi.fn<() => ReturnType<typeof authState>>(),
  updateConfig: vi.fn<ReturnType<typeof import('./ServerConfigContext').useServerConfigUpdater>>(),
  addToast: vi.fn<ReturnType<typeof import('@cloudflare/kumo').useKumoToastManager>['add']>(),
}))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: hooks.auth }))
vi.mock('./ServerConfigContext', async importOriginal => ({
  ...await importOriginal<typeof import('./ServerConfigContext')>(),
  useServerConfigUpdater: () => hooks.updateConfig,
}))
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: hooks.addToast }),
}))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const settings: AdminSettingsView = { signupsEnabled: true, siteName: '', instanceInstructions: '', announcement: '', banner: { text: '', color: 'neutral' }, accentColor: '', enabledHubs: [], resourceVendors: [], formats: [] }
class PageFixture extends RpcTarget implements Pick<AdminApi, 'getSettings' | 'listAdministrators' | 'listAdministratorAudit'> {
  settingsCall = vi.fn<AdminApi['getSettings']>(async () => settings)
  membersCall = vi.fn<AdminApi['listAdministrators']>(async () => ({ mode: 'legacy', revision: 0, staticProfileIds: ['jacob.beck@totango.com', 'keith@totango.com', 'nick.roberts@totango.com', 'stacy.kennedy@totango.com'], items: [], blockers: ['LEGACY_CAPABILITIES_UNDRAINED'] }))
  auditCall = vi.fn<AdminApi['listAdministratorAudit']>(async () => ({ items: [] }))
  disposed = vi.fn<() => void>();
  getSettings() { return this.settingsCall() }
  listAdministrators() { return this.membersCall() }
  listAdministratorAudit() { return this.auditCall() }
  [Symbol.dispose]() { this.disposed() }
}
function authState(getAdminApi: () => Promise<RpcStub<PageFixture> | null>, isAdmin: boolean) {
  return {
    authenticatedApi: { getAdminApi: vi.fn<typeof getAdminApi>(getAdminApi) },
    isAdmin, currentUser: { id: 'jacob.beck@totango.com', name: 'Jacob', type: 'user' as const },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('AdminPage administrator integration and capability lifecycle', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    // jsdom has no layout observer; keep the real Kumo tab interaction, only stub layout.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove(); vi.clearAllMocks(); vi.unstubAllGlobals()
  })
  async function render() {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root.render(<AdminPage />))
  }
  function auth(getAdminApi: () => Promise<RpcStub<PageFixture> | null>, isAdmin = true) {
    const state = authState(getAdminApi, isAdmin)
    hooks.auth.mockReturnValue(state)
    return state.authenticatedApi
  }
  async function openPanel() {
    const tab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(item => item.textContent === 'Administrators')!
    expect(tab).toBeDefined()
    tab.scrollIntoView = vi.fn<HTMLElement['scrollIntoView']>() // jsdom has no scrolling/layout implementation.
    await act(async () => tab.click())
  }
  it('opens the real membership panel from existing AdminPage and disposes the capability once on leaving', async () => {
    const fixture = new PageFixture(); auth(async () => new RpcStub(fixture))
    await render()
    expect(fixture.membersCall).not.toHaveBeenCalled()
    await openPanel()
    expect(fixture.membersCall).toHaveBeenCalledOnce()
    expect(fixture.auditCall).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('stacy.kennedy@totango.com')
    expect(container.textContent).toContain('Pending managed cutover')
    await act(async () => root.unmount())
    expect(fixture.disposed).toHaveBeenCalledOnce()
  })
  it('does not request an admin capability or render private membership for a denied viewer', async () => {
    const api = auth(async () => null, false)
    await render()
    expect(api.getAdminApi).not.toHaveBeenCalled()
    expect(container.textContent).toContain("You don't have access")
    expect(container.textContent).not.toContain('Administrators')
  })
  it('handles a cached admin flag whose backend capability request is denied', async () => {
    auth(async () => null)
    await render()
    expect(container.textContent).toContain('Something went wrong loading admin settings')
    expect(container.querySelector('[aria-label="Administrator membership"]')).toBeNull()
  })
  it('disposes a capability that arrives after unmount without reading settings', async () => {
    const fixture = new PageFixture(); const pending = deferred<RpcStub<PageFixture> | null>()
    auth(() => pending.promise)
    await render(); await act(async () => root.unmount())
    await act(async () => pending.resolve(new RpcStub(fixture)))
    expect(fixture.disposed).toHaveBeenCalledOnce()
    expect(fixture.settingsCall).not.toHaveBeenCalled()
  })
  it('does not apply stale settings when account changes while a read is in flight', async () => {
    const fixture = new PageFixture(); const pending = deferred<AdminSettingsView>()
    fixture.settingsCall.mockImplementationOnce(() => pending.promise)
    auth(async () => new RpcStub(fixture)); await render()
    auth(async () => null, false)
    await act(async () => root.render(<AdminPage />))
    await act(async () => pending.resolve({ ...settings, siteName: 'Previous account settings' }))
    expect(hooks.updateConfig).not.toHaveBeenCalled()
    expect(fixture.disposed).toHaveBeenCalledOnce()
    expect(container.textContent).toContain("You don't have access")
  })
})
