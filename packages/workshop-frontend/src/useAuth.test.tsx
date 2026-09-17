// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { PublicApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { setReportedUserId } from './errorReporting'
import { useAuth } from './useAuth'

const runtime = vi.hoisted(() => ({
  readSessionSecret: vi.fn<() => Promise<string | null>>(),
  writeSessionSecret: vi.fn<(token: string) => Promise<void>>(async () => {}),
  clearSessionSecret: vi.fn<() => Promise<void>>(async () => {}),
}))
vi.mock('./runtime', () => ({
  getWorkshopRuntime: () => ({ ...runtime, readSessionSecret: () =>
    runtime.readSessionSecret.getMockImplementation()
      ? runtime.readSessionSecret() : Promise.resolve(localStorage.getItem('authToken')) }),
  addNativeLoginTokenListener: () => () => {},
}))

vi.mock('./errorReporting', () => ({
  setReportedUserId: vi.fn<(reportedUserId: string | undefined) => void>(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const person: AiChatAuthorInfo = { type: 'user', id: 'person@example.com', name: 'Person' }

/** A public API whose authenticated stub resolves `whoami` to `author`, or rejects without one. */
function stubPublicApi(author?: AiChatAuthorInfo): RpcStub<PublicApi> {
  const authenticated = {
    whoami: async () => {
      if (!author) throw new Error('session gone')
      return author
    },
    amIAdmin: async () => false,
    [Symbol.dispose]: () => {},
  }
  return {
    authenticate: () => authenticated,
    authenticateFromCfAccess: () => authenticated,
  } as unknown as RpcStub<PublicApi>
}

/**
 * A public API whose `whoami` stays pending until released, for the window in which an answer can
 * arrive after a logout or a newer authentication has superseded it.
 *
 * Each authentication gets its own deferred, so `release(nth, ...)` can answer an earlier lookup
 * after a later one — the ordering a shared promise could not express.
 */
function deferredPublicApi(): {
  api: RpcStub<PublicApi>
  release: (nth: number, author: AiChatAuthorInfo) => void
} {
  const releases: ((author: AiChatAuthorInfo) => void)[] = []
  const authenticate = () => {
    let release: (author: AiChatAuthorInfo) => void = () => {}
    const pending = new Promise<AiChatAuthorInfo>((resolve) => { release = resolve })
    releases.push(release)
    return { whoami: () => pending, [Symbol.dispose]: () => {} }
  }
  return {
    api: { authenticate, authenticateFromCfAccess: authenticate } as unknown as RpcStub<PublicApi>,
    release: (nth, author) => releases[nth](author),
  }
}

type Controls = { login: (token: string) => void; logout: () => void }

describe('useAuth error reporting identity', () => {
  const roots: Root[] = []
  const containers: HTMLDivElement[] = []

  afterEach(() => {
    act(() => roots.forEach(root => root.unmount()))
    roots.length = 0
    containers.forEach(container => container.remove())
    containers.length = 0
    localStorage.clear()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    runtime.readSessionSecret.mockReset()
    vi.unstubAllGlobals()
  })

  /** Mounts an independent `useAuth` instance, returning its login/logout handles. */
  async function mount(
    publicApi: RpcStub<PublicApi>,
    hook: typeof useAuth = useAuth,
  ): Promise<{ controls: Controls; root: Root }> {
    const captured: { controls?: Controls } = {}
    function Consumer() {
      const { login, logout } = hook(publicApi)
      captured.controls = { login, logout }
      return null
    }

    const container = document.createElement('div')
    document.body.append(container)
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(<Consumer />))
    return { controls: captured.controls!, root }
  }

  it('names the user when a stored token authenticates on mount', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi(person))

    expect(setReportedUserId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('names the user after an inline login with no provider mounted', async () => {
    // The public blueprint page renders outside AuthProvider and logs in through its own useAuth
    // instance. Attaching identity in the provider left that whole session reporting anonymously.
    const { controls } = await mount(stubPublicApi(person))
    expect(setReportedUserId).not.toHaveBeenCalled()

    await act(async () => controls.login('fresh-token'))

    expect(setReportedUserId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('names the user when CF Access authenticates without a token', async () => {
    vi.stubEnv('VITE_CF_ACCESS_MODE', 'true')
    vi.resetModules()
    // Both imports must come from the reset registry, or the assertion would watch a mock instance
    // that the freshly imported hook never calls.
    const { setReportedUserId: setId } = await import('./errorReporting')
    const { useAuth: cfAccessUseAuth } = await import('./useAuth')

    await mount(stubPublicApi(person), cfAccessUseAuth)

    expect(setId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('keeps the identity when one instance unmounts while another stays mounted', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const api = stubPublicApi(person)
    await mount(api)
    const { root: inner } = await mount(api)

    // The blueprint page nests its own instance inside the root's. Clearing on unmount would let
    // navigating away from that page blank an identity the root still holds.
    act(() => inner.unmount())
    roots.splice(roots.indexOf(inner), 1)

    expect(setReportedUserId).not.toHaveBeenCalledWith(undefined)
  })

  it('clears the identity on logout', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { controls } = await mount(stubPublicApi(person))

    act(() => controls.logout())

    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)
  })

  it('ignores a stored-secret read rejection after a newer login succeeds', async () => {
    let rejectRead!: (error: Error) => void
    runtime.readSessionSecret.mockImplementation(() => new Promise((_, reject) => { rejectRead = reject }))
    let current!: ReturnType<typeof useAuth>
    const api = stubPublicApi(person)
    function Consumer() {
      const value = useAuth(api)
      useEffect(() => { current = value })
      return null
    }
    const container = document.createElement('div')
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(<Consumer />))
    await act(async () => current.login('new-login'))
    expect(current.isAuthenticated).toBe(true)
    await act(async () => rejectRead(new Error('old keychain failure')))
    expect(current.isAuthenticated).toBe(true)
    expect(current.error).toBeNull()
  })

  it('revokes CF Access locally before blocked navigation and ignores late authentication', async () => {
    vi.stubEnv('VITE_CF_ACCESS_MODE', 'true')
    vi.resetModules()
    const { useAuth: accessAuth } = await import('./useAuth')
    const navigation = vi.fn<(url: string) => void>(() => { throw new Error('navigation blocked') })
    const browserWindow = window
    vi.stubGlobal('window', new Proxy(browserWindow, {
      get(target, key) { return key === 'location' ? { assign: navigation } : Reflect.get(target, key, target) },
    }))
    let current!: ReturnType<typeof useAuth>
    const dispose = vi.fn<() => void>()
    let resolveLate!: (value: AiChatAuthorInfo) => void
    const pending = new Promise<AiChatAuthorInfo>(resolve => { resolveLate = resolve })
    const source = { whoami: async () => person, [Symbol.dispose]: dispose }
    const late = { whoami: () => pending, [Symbol.dispose]: vi.fn<() => void>() }
    const api = { authenticateFromCfAccess: () => source, authenticate: () => late } as unknown as RpcStub<PublicApi>
    function Consumer() {
      const value = accessAuth(api)
      useEffect(() => { current = value })
      return null
    }
    const container = document.createElement('div')
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(<Consumer />))
    expect(current.isAuthenticated).toBe(true)
    act(() => { expect(() => current.logout()).toThrow('navigation blocked') })
    expect(dispose).toHaveBeenCalled()
    expect(current.authenticatedApi).toBeNull()
    expect(current.isAuthenticated).toBe(false)
    await act(async () => current.login('late-token'))
    act(() => { expect(() => current.logout()).toThrow('navigation blocked') })
    await act(async () => resolveLate(person))
    expect(current.authenticatedApi).toBeNull()
    expect(current.isAuthenticated).toBe(false)
    expect(late[Symbol.dispose]).toHaveBeenCalled()
    expect(navigation).toHaveBeenCalledWith('/cdn-cgi/access/logout')
  })

  it('ignores a lookup that resolves after logout', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api, release } = deferredPublicApi()
    const { controls } = await mount(api)

    act(() => controls.logout())
    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)

    // Disposing the stub is not a defence: capnweb does not guarantee that disposal rejects a call
    // already in flight, so a slow lookup could otherwise name a user who has just signed out.
    await act(async () => release(0, person))

    expect(setReportedUserId).not.toHaveBeenCalledWith('person@example.com')
    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)
  })

  it('ignores a lookup superseded by a newer authentication', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api, release } = deferredPublicApi()
    const { controls } = await mount(api)
    await act(async () => controls.login('fresh-token'))

    // The newer authentication supersedes the first lookup, so answering that one last must not let
    // it win. Only the generation distinguishes them; arrival order alone would pick the stale id.
    await act(async () => release(0, { ...person, id: 'stale@example.com' }))
    expect(setReportedUserId).not.toHaveBeenCalledWith('stale@example.com')

    await act(async () => release(1, person))
    expect(setReportedUserId).toHaveBeenLastCalledWith('person@example.com')
  })

  it('does not name a person for an author that is not a user account', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi({ type: 'agent', id: 'gpt-5.1-pro', name: 'GPT' }))

    expect(setReportedUserId).not.toHaveBeenCalled()
  })

  it('names nobody when the identity lookup fails', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi())

    expect(setReportedUserId).not.toHaveBeenCalled()
  })
})
