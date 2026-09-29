// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, useEffect, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi, GadgetClient, GadgetMetadata, WorkpieceSummary, WorkpiecesSubscriber, ActionsSubscriber } from '@gadgets/workshop-shared/api'
import GadgetEditor, { useDisplayedGadget } from './GadgetEditor'
import { RetainedGadgetUI } from './GadgetUseView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let authenticatedApi: RpcStub<AuthenticatedApi>
const frameReads = vi.fn<() => void>()
const frameMounts = vi.fn<() => void>()
let search: Record<string, unknown> = {}
const searchListeners = new Set<() => void>()
const subscribeSearch = (listener: () => void) => { searchListeners.add(listener); return () => { searchListeners.delete(listener) } }
const getSearch = () => search
const navigate = ({ search: update }: { search?: Record<string, unknown> | ((previous: Record<string, unknown>) => Record<string, unknown>) }) => {
  if (!update) return
  search = typeof update === 'function' ? update(search) : update
  searchListeners.forEach(listener => listener())
}
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi }) }))
vi.mock('./RpcContext', () => ({ useConnectionLost: () => false }))
vi.mock('@tanstack/react-router', async original => ({
  ...await original<typeof import('@tanstack/react-router')>(),
  useParams: () => ({ id: 'workspace' }), useSearch: () => useSyncExternalStore(subscribeSearch, getSearch), useNavigate: () => navigate,
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}))
vi.mock('@cloudflare/kumo', async original => ({
  ...await original<typeof import('@cloudflare/kumo')>(), useKumoToastManager: () => ({ add: () => {} }),
}))
vi.mock('./components/UserMenu', () => ({ default: () => null }))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))
vi.mock('./components/GadgetPresence', () => ({ GadgetPresence: () => null }))
vi.mock('./GadgetExportMenu', () => ({ default: () => null }))
vi.mock('./TopBarNotice', () => ({ default: () => null }))
vi.mock('./Connections', () => ({ default: () => null }))
vi.mock('./ActivityNotifications', () => ({ default: () => null }))
vi.mock('./WorkpiecePicker', async original => ({
  ...await original<typeof import('./WorkpiecePicker')>(), default: () => null,
}))
vi.mock('./ShareModal', () => ({ default: () => null }))
vi.mock('./BlueprintModal', () => ({ default: () => null }))
vi.mock('./GadgetCodeInterface', () => ({ default: ({ onHasCodeChange }: ComponentProps<typeof import('./GadgetCodeInterface').default>) => {
  useEffect(() => { onHasCodeChange?.(true) }, [onHasCodeChange])
  return null
} }))
vi.mock('./ChatInterface', () => ({ default: ({ onNavigateToChat, onOpenGadget, onChatCountChange }: ComponentProps<typeof import('./ChatInterface').default>) => {
  useEffect(() => { onChatCountChange?.(2, false) }, [onChatCountChange])
  return <>
    <button data-chat-eight onClick={() => onNavigateToChat?.(8)}>Conversation eight</button>
    <button data-chat-list onClick={() => onNavigateToChat?.(null)}>Conversation list</button>
    <button data-select-fallback onClick={() => onOpenGadget?.(1)}>Select accepted app</button>
  </>
} }))
vi.mock('./GadgetUI', () => ({ default: ({ gadget, chatId }: { gadget: RpcStub<GadgetClient>; chatId?: number }) => {
  useEffect(() => { frameMounts() }, [])
  useEffect(() => { void gadget.getUiBundle(chatId).then(frameReads) }, [gadget, chatId])
  return <iframe title="running app" data-chat={chatId ?? 'main'} sandbox="" />
} }))

const gadget = (id: number, chatId?: number) => ({ id, type: 'gadget', title: `App ${id}`, chatId }) as WorkpieceSummary
let root: Root
let container: HTMLDivElement
afterEach(() => {
  act(() => root?.unmount()); container?.remove(); vi.restoreAllMocks(); localStorage.clear()
  search = {}; searchListeners.clear(); frameMounts.mockClear(); vi.unstubAllGlobals()
})
function setup() { container = document.createElement('div'); document.body.append(container); root = createRoot(container) }

describe('displayed gadget pin', () => {
  it('ignores automatic candidate and proposal changes, suspends disappearance, and accepts explicit choices', async () => {
    let selection!: ReturnType<typeof useDisplayedGadget>
    function Probe(props: Parameters<typeof useDisplayedGadget>[0]) {
      const value = useDisplayedGadget(props)
      useEffect(() => { selection = value })
      return <p>{value.id}:{value.chatId ?? 'main'}:{String(value.available)}</p>
    }
    setup()
    const initial = { candidateId: 1, requestedId: null, gadgets: [gadget(1)], selectedChatId: 7, hasProposedChanges: false }
    await act(async () => root.render(<Probe {...initial} />))
    expect(container.textContent).toBe('1:main:true')
    const proposed = { ...initial, candidateId: 2, gadgets: [gadget(1), gadget(2, 7)], hasProposedChanges: true }
    await act(async () => root.render(<Probe {...proposed} />))
    expect(container.textContent).toBe('1:main:true')
    expect(selection.previewChanged).toBe(true)
    await act(async () => selection.acceptPreview())
    expect(container.textContent).toBe('1:7:true')
    const revision = selection.revision
    await act(async () => root.render(<Probe {...proposed} hasProposedChanges={false} />))
    expect(container.textContent).toBe('1:7:false')
    expect(selection.revision).toBe(revision)
    await act(async () => root.render(<Probe {...proposed} gadgets={[gadget(2, 7)]} />))
    expect(container.textContent).toBe('1:7:false')
    await act(async () => root.render(<Probe {...proposed} requestedId={2} />))
    expect(container.textContent).toBe('2:7:true')
    expect(selection.revision).toBeGreaterThan(revision)
  })

  it('does not give an old branch document the new conversation context', async () => {
    let selection!: ReturnType<typeof useDisplayedGadget>
    function Probe(props: Parameters<typeof useDisplayedGadget>[0]) {
      const value = useDisplayedGadget(props)
      useEffect(() => { selection = value })
      return null
    }
    setup()
    const props = { candidateId: 1, requestedId: 1, gadgets: [gadget(1)], selectedChatId: 7, hasProposedChanges: true }
    await act(async () => root.render(<Probe {...props} />))
    expect(selection.chatId).toBe(7)
    await act(async () => root.render(<Probe {...props} selectedChatId={8} />))
    expect(selection.chatId).toBe(7)
    expect(selection.available).toBe(false)
    await act(async () => selection.acceptPreview())
    expect(selection.chatId).toBe(8)
    expect(selection.available).toBe(true)
  })

  it('keeps the document and RPC branch pinned until explicit acceptance or workpiece selection', async () => {
    const calls = vi.fn<(id: number, chatId: number | undefined) => void>()
    class App extends RpcTarget {
      constructor(private id: number) { super() }
      getUiBundle(chatId?: number) { calls(this.id, chatId); return null }
    }
    const clients = [new RpcStub(new App(1)), new RpcStub(new App(2))]
    let selection!: ReturnType<typeof useDisplayedGadget>
    function Probe(props: Parameters<typeof useDisplayedGadget>[0]) {
      const value = useDisplayedGadget(props)
      useEffect(() => { selection = value })
      return <RetainedGadgetUI key={`${value.id}:${value.revision}`} height="100%" chatId={value.chatId}
        gadget={value.available ? clients[value.id! - 1] as unknown as RpcStub<GadgetClient> : null} />
    }
    setup()
    const props = { candidateId: 1, requestedId: null, gadgets: [gadget(1), gadget(2)], selectedChatId: 7, hasProposedChanges: false }
    await act(async () => root.render(<Probe {...props} />))
    const mainFrame = container.querySelector('iframe')
    await act(async () => root.render(<Probe {...props} candidateId={2} hasProposedChanges />))
    expect(container.querySelector('iframe')).toBe(mainFrame)
    expect(calls.mock.calls).toEqual([[1, undefined]])
    await act(async () => selection.acceptPreview())
    const branchFrame = container.querySelector('iframe')
    expect(branchFrame).not.toBe(mainFrame)
    expect(calls.mock.calls).toEqual([[1, undefined], [1, 7]])
    await act(async () => root.render(<Probe {...props} selectedChatId={8} hasProposedChanges />))
    expect(container.querySelector('iframe')).toBe(branchFrame)
    expect(branchFrame!.closest('[style*="display: none"]')).not.toBeNull()
    expect(calls).toHaveBeenCalledTimes(2)
    await act(async () => selection.acceptPreview())
    expect(container.querySelector('iframe')).not.toBe(branchFrame)
    expect(calls).toHaveBeenLastCalledWith(1, 8)
    await act(async () => root.render(<Probe {...props} candidateId={2} requestedId={2} selectedChatId={8} hasProposedChanges />))
    expect(calls).toHaveBeenLastCalledWith(2, 8)
    clients.forEach(client => client[Symbol.dispose]())
  })
})

it('offers retry after failed reopen and retains the actual editor frame through recovery', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  class App extends RpcTarget { getUiBundle() { return null } }
  class Workspace extends RpcTarget {
    async subscribeToMetadata(callback: (metadata: GadgetMetadata) => Promise<void>) {
      await callback({ id: 'workspace', title: 'Workspace', role: 'use', provisional: false } as GadgetMetadata)
      return new RpcTarget()
    }
    async subscribeToWorkpieces(subscriber: RpcStub<WorkpiecesSubscriber>) {
      await subscriber.entry(gadget(1))
      await subscriber.ready()
      return new RpcTarget()
    }
    async subscribeToActions(subscriber: RpcStub<ActionsSubscriber>) { await subscriber.ready(); return new RpcTarget() }
    subscribeToConsoleLogs() { return new RpcTarget() }
    getGadget() { return new App() }
  }
  let fail = false
  class Api extends RpcTarget {
    openGadget() { if (fail) throw new Error('Temporary outage'); return new Workspace() }
    whoami() { return { type: 'user', id: 'owner', name: 'Owner' } }
  }
  const first = new RpcStub(new Api()) as unknown as RpcStub<AuthenticatedApi>
  const next = new RpcStub(new Api()) as unknown as RpcStub<AuthenticatedApi>
  setup()
  authenticatedApi = first
  await act(async () => root.render(<GadgetEditor />))
  const frame = container.querySelector('iframe')
  expect(frame).not.toBeNull()
  fail = true
  authenticatedApi = next
  await act(async () => root.render(<GadgetEditor />))
  expect(container.querySelector('iframe')).toBe(frame)
  expect(frame!.closest('[style*="display: none"]')).not.toBeNull()
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry connection')!
  expect(retry).toBeDefined()
  fail = false
  await act(async () => retry.click())
  expect(container.querySelector('iframe')).toBe(frame)
  expect(frame!.closest('[style*="display: none"]')).toBeNull()
  expect(container.textContent).not.toContain('Retry connection')
  first[Symbol.dispose]()
  next[Symbol.dispose]()
})

it.each(['eight', 'list'] as const)('retains draft D when navigating to conversation %s, until explicit fallback selection', async destination => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const acquired = vi.fn<(id: number) => void>()
  const bundles = vi.fn<(id: number, chatId: number | undefined) => void>()
  class App extends RpcTarget {
    constructor(private id: number) { super() }
    getUiBundle(chatId?: number) { bundles(this.id, chatId); return null }
  }
  class Workspace extends RpcTarget {
    async subscribeToMetadata(callback: (metadata: GadgetMetadata) => Promise<void>) {
      await callback({ id: 'workspace', title: 'Workspace', role: 'build', provisional: false, defaultGadgetId: 1 } as GadgetMetadata)
      return new RpcTarget()
    }
    async subscribeToWorkpieces(subscriber: RpcStub<WorkpiecesSubscriber>) {
      await subscriber.entry({ ...gadget(1), filesRoot: 'accepted' })
      await subscriber.entry({ ...gadget(2, 7), filesRoot: 'draft' })
      await subscriber.ready()
      return new RpcTarget()
    }
    async subscribeToActions(subscriber: RpcStub<ActionsSubscriber>) { await subscriber.ready(); return new RpcTarget() }
    subscribeToConsoleLogs() { return new RpcTarget() }
    listHooks() { return [] }
    getGadget(id: number) { acquired(id); return new App(id) }
  }
  class Api extends RpcTarget {
    openGadget() { return new Workspace() }
    whoami() { return { type: 'user', id: 'owner', name: 'Owner' } }
  }
  const api = new RpcStub(new Api()) as unknown as RpcStub<AuthenticatedApi>
  authenticatedApi = api
  search = { chat: 7, w: 2 }
  setup()
  await act(async () => root.render(<GadgetEditor />))
  const draftFrame = container.querySelector('iframe')!
  expect(draftFrame).not.toBeNull()
  expect(draftFrame.dataset.chat).toBe('7')
  expect(acquired.mock.calls).toEqual([[2]])
  const mountCount = frameMounts.mock.calls.length

  await act(async () => container.querySelector<HTMLButtonElement>(`[data-chat-${destination}]`)!.click())
  expect(search.chat).toBe(destination === 'eight' ? 8 : undefined)
  expect(search.w).toBe(2)
  expect(container.querySelector('iframe')).toBe(draftFrame)
  expect(draftFrame.closest('[style*="display: none"]')).not.toBeNull()
  // The frame is keyed by displayed id/revision. Same node + no mount proves that
  // conversation cleanup did not advance that revision or acquire the accepted fallback.
  expect(frameMounts).toHaveBeenCalledTimes(mountCount)
  expect(acquired.mock.calls).toEqual([[2]])
  expect(bundles.mock.calls).toEqual([[2, 7]])

  await act(async () => container.querySelector<HTMLButtonElement>('[data-select-fallback]')!.click())
  expect(search.w).toBe(1)
  expect(container.querySelector('iframe')).not.toBe(draftFrame)
  expect(container.querySelector('iframe')?.dataset.chat).toBe('main')
  expect(acquired.mock.calls).toEqual([[2], [1]])
  expect(bundles.mock.calls).toEqual([[2, 7], [1, undefined]])
  api[Symbol.dispose]()
})
