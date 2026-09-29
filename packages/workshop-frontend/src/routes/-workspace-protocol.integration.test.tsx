// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
/* eslint-disable vitest/no-conditional-expect -- explicit protocol-state matrix has different UI outcomes */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicApi, AiChatSubscriber, WorkpiecesSubscriber } from '@gadgets/workshop-shared/api'
import { Route as RootRoute } from './__root'
import GadgetEditor from '../GadgetEditor'
import { RpcContext } from '../RpcContext'
import { ThemeProvider } from '../ThemeContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Real router, root auth, workspace opener, chat/composer, and RPC dispatch. Only the remote
// service is a deterministic in-process peer; this is not deployed-Worker authorization evidence.
class Workspace extends RpcTarget {
  negotiated = false
  calls: string[] = []
  sent: string[] = []
  readonly metadataSubscribed: Promise<void>
  private resolveMetadata!: () => void
  constructor(readonly state: 'ready' | 'paused' | 'incompatible' | 'read-only') {
    super()
    this.metadataSubscribed = new Promise(resolve => { this.resolveMetadata = resolve })
  }
  negotiateEditingProtocol(protocol: string) {
    this.calls.push(`negotiate:${protocol}`)
    this.negotiated = protocol === 'git-ot-v1'
    return this.getEditingProtocol()
  }
  getEditingProtocol() {
    return { protocol: this.state === 'incompatible' ? 'old-wire' : 'git-ot-v1', state: this.state === 'incompatible' ? 'upgrade-required' : this.state }
  }
  getMetadata() { return { id: 'workspace', title: 'Protocol workspace', role: this.state === 'read-only' ? 'use' : 'build', provisional: false } }
  async subscribeToMetadata(callback: (metadata: ReturnType<Workspace['getMetadata']>) => void) {
    await callback(this.getMetadata())
    this.resolveMetadata()
    return new RpcTarget()
  }
  async subscribeToWorkpieces(subscriber: RpcStub<WorkpiecesSubscriber>) { await subscriber.ready(); return new RpcTarget() }
  subscribeToPresence() { return new RpcTarget() }
  subscribeToActions() { return new RpcTarget() }
  subscribeToConsoleLogs() { return new RpcTarget() }
  listActions() { return { entries: [] } }
  listHooks() { return [] }
  listModels() { return [] }
  listChats() { return [] }
  listBlueprints() { return [] }
  listSlashCommands() { return [] }
  async subscribeToChat(subscriber: RpcStub<AiChatSubscriber>) {
    this.calls.push('chat-stream')
    if (!this.negotiated || this.state === 'incompatible') throw new Error('EDITING_PROTOCOL_UPGRADE_REQUIRED')
    await subscriber.streamGeneration(1)
    return new RpcTarget()
  }
  newChat(text: string) {
    this.calls.push('new-chat')
    if (!this.negotiated || this.state !== 'ready') throw new Error('not writable')
    this.sent.push(text)
    return 7
  }
  getChatHistory() { return { messages: [], hasMore: false } }
}

class Account extends RpcTarget {
  constructor(private workspace: Workspace) { super() }
  whoami() { return { type: 'user', id: 'verified-owner', name: 'Owner' } }
  amIAdmin() { return false }
  isOnboardingCompleted() { return true }
  getFinanceHubStatus() { return { authorized: false, canCreate: false } }
  getUiFeatureFlags() { return {} }
  getRequiredConnectionStatuses() { return [] }
  subscribeConnectedAccounts() { return new RpcTarget() }
  listCodingSessions() { return [] }
  listCodingSessionActivity() { return [] }
  listGatekeeperVendors() { return [] }
  listGatekeeperApps() { return [] }
  listModels() { return [] }
  getProfileImage() { return null }
  openGadget() { return this.workspace }
}
class Public extends RpcTarget {
  constructor(private account: Account) { super() }
  authenticate(token: string) { if (token !== 'fixture-session') throw new Error('Unauthorized'); return this.account }
}

describe('authenticated workspace route editing protocol', () => {
  let root: Root
  let container: HTMLDivElement
  const peers: RpcStub<PublicApi>[] = []
  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    localStorage.setItem('authToken', 'fixture-session')
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }))
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    peers.splice(0).forEach(peer => peer[Symbol.dispose]())
    container.remove(); localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  })

  it.each(['ready', 'paused', 'incompatible', 'read-only'] as const)('runs the %s peer through the authenticated route', async state => {
    const workspace = new Workspace(state)
    const peer = new RpcStub(new Public(new Account(workspace))) as unknown as RpcStub<PublicApi>
    peers.push(peer)
    const route = createRoute({ getParentRoute: () => RootRoute, path: '/workspace/$id', component: GadgetEditor })
    const router = createRouter({ routeTree: RootRoute.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/workspace/workspace'] }) })
    await router.load()
    await act(async () => root.render(<ThemeProvider><RpcContext.Provider value={{ stub: peer, connectionLost: false }}>
      <RouterProvider router={router} />
    </RpcContext.Provider></ThemeProvider>))
    await workspace.metadataSubscribed
    await act(async () => {})
    expect(container.textContent).toContain('Protocol workspace')
    expect(workspace.calls[0]).toBe('negotiate:git-ot-v1')
    if (state === 'ready' || state === 'paused') {
      expect(workspace.calls).toContain('chat-stream')
      const textarea = container.querySelector('textarea')!
      expect(textarea).not.toBeNull()
      const send = container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
      if (state === 'ready') {
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Authenticated draft')
          textarea.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await act(async () => send.click())
        expect(workspace.sent).toEqual(['Authenticated draft'])
      } else {
        expect(send.disabled).toBe(true)
        expect(container.textContent).toContain('Editing is paused')
        expect(workspace.sent).toEqual([])
      }
    } else {
      expect(workspace.calls).not.toContain('chat-stream')
      expect(workspace.sent).toEqual([])
      if (state === 'read-only') expect(container.querySelector('textarea')).toBeNull()
      else expect(container.textContent).toContain('cannot edit together')
    }
  })
})
