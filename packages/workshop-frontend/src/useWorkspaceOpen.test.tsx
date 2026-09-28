// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { Activity, act, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcStub, RpcTarget } from 'capnweb'
import {
  createOpenGadgetError,
  OPEN_GADGET_ERROR_CODES,
  type AuthenticatedApi,
  type GadgetMetadata,
  type Overseer,
} from '@gadgets/workshop-shared/api'
import WorkspaceOpenErrorPage from './components/WorkspaceOpenErrorPage'
import { useWorkspaceOpen } from './useWorkspaceOpen'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function disposableStub<T extends object>(value: T, dispose = vi.fn<() => void>()) {
  return Object.assign(value, { [Symbol.dispose]: dispose }) as T & Disposable
}

function api(overseer: RpcStub<Overseer>): RpcStub<AuthenticatedApi> {
  return { openGadget: () => overseer } as unknown as RpcStub<AuthenticatedApi>
}

const METADATA = {
  id: 'workspace-1',
  title: 'Quarterly planning',
  provisional: false,
} as GadgetMetadata

function WorkspaceProbe({ authenticatedApi }: { authenticatedApi: RpcStub<AuthenticatedApi> }) {
  const state = useWorkspaceOpen({
    id: 'workspace-1',
    authenticatedApi,
    onInvalidShareKey: () => {},
    onMetadata: () => {},
    onShareKeyConsumed: () => {},
  })
  if (state.error?.kind === 'open') {
    return (
      <WorkspaceOpenErrorPage
        kind={state.error.failure}
        onGoToWorkspaces={() => {}}
        onRetry={state.retry}
      />
    )
  }
  return <p>{state.metadata?.title}</p>
}

describe('useWorkspaceOpen', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    document.title = ''
    vi.restoreAllMocks()
  })

  it('never republishes a disposed real stub when Activity reveals with the same API', async () => {
    const ready = deferred<void>()
    const disposed = vi.fn<(epoch: number) => void>()
    const reads = vi.fn<(epoch: number) => void>()
    const received: string[] = []
    let attempt = 0
    class Target extends RpcTarget {
      constructor(private epoch: number) { super() }
      async subscribeToMetadata(callback: (metadata: GadgetMetadata) => void) {
        callback(METADATA)
        if (this.epoch === 2) await ready.promise
        return new RpcTarget()
      }
      getMetadata() { reads(this.epoch); return METADATA }
      [Symbol.dispose]() { disposed(this.epoch) }
    }
    const authenticatedApi = {
      openGadget: () => new RpcStub(new Target(++attempt)),
    } as unknown as RpcStub<AuthenticatedApi>
    function Probe() {
      const state = useWorkspaceOpen({ id: 'workspace-1', authenticatedApi,
        onMetadata: () => {}, onInvalidShareKey: () => {}, onShareKeyConsumed: () => {} })
      useEffect(() => {
        if (state.overseer) void state.overseer.stub.getMetadata().then(
          () => received.push('live'), () => received.push('disposed'))
      }, [state.overseer])
      return <p>{state.overseer ? 'published' : 'pending'}</p>
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Activity mode="visible"><Probe /></Activity>))
    expect(container.textContent).toBe('published')
    await act(async () => root!.render(<Activity mode="hidden"><Probe /></Activity>))
    expect(disposed).toHaveBeenCalledWith(1)
    await act(async () => root!.render(<Activity mode="visible"><Probe /></Activity>))
    expect(container.textContent).toBe('pending')
    expect(received).toEqual(['live'])
    await act(async () => ready.resolve())
    expect(container.textContent).toBe('published')
    expect(received).toEqual(['live', 'live'])
    expect(reads.mock.calls).toEqual([[1], [2]])
  })

  it('ignores old metadata callbacks after replacement', async () => {
    let oldCallback!: (metadata: GadgetMetadata) => void
    const make = (title: string, capture = false) => api(disposableStub({
      subscribeToMetadata: async (callback: (metadata: GadgetMetadata) => void) => {
        if (capture) oldCallback = callback
        callback({ ...METADATA, title })
        return disposableStub({})
      },
    }) as unknown as RpcStub<Overseer>)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={make('old', true)} />))
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={make('new')} />))
    await act(async () => oldCallback({ ...METADATA, title: 'stale' }))
    expect(container.textContent).toBe('new')
  })

  it('disposes a metadata subscription that resolves after its load attempt is cleaned up', async () => {
    const pendingSubscription = deferred<RpcStub<{}>>()
    const overseerDispose = vi.fn<() => void>()
    const overseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(() => pendingSubscription.promise),
    }, overseerDispose) as unknown as RpcStub<Overseer>
    const subscriptionDispose = vi.fn<() => void>()
    const subscription = disposableStub({}, subscriptionDispose) as RpcStub<{}>
    const authenticatedApi = api(overseer)

    function Probe() {
      useWorkspaceOpen({
        id: 'workspace-1',
        authenticatedApi,
        onInvalidShareKey: () => {},
        onMetadata: () => {},
        onShareKeyConsumed: () => {},
      })
      return null
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))

    act(() => root!.unmount())
    root = undefined
    await act(async () => { pendingSubscription.resolve(subscription); await Promise.resolve() })

    expect(overseerDispose).toHaveBeenCalledOnce()
    expect(subscriptionDispose).toHaveBeenCalledOnce()
  })

  it('does not publish the overseer stub while the metadata subscription is pending', async () => {
    const pendingSubscription = deferred<RpcStub<{}>>()
    const overseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(() => pendingSubscription.promise),
    }) as unknown as RpcStub<Overseer>
    const authenticatedApi = api(overseer)

    function Probe() {
      const state = useWorkspaceOpen({
        id: 'workspace-1',
        authenticatedApi,
        onInvalidShareKey: () => {},
        onMetadata: () => {},
        onShareKeyConsumed: () => {},
      })
      return <p>{state.overseer ? 'published' : 'pending'}</p>
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))
    await act(async () => { await Promise.resolve() })

    expect(container.textContent).toBe('pending')
  })

  it('publishes the overseer stub after the metadata subscription succeeds', async () => {
    const pendingSubscription = deferred<RpcStub<{}>>()
    const overseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(() => pendingSubscription.promise),
    }) as unknown as RpcStub<Overseer>
    const subscription = disposableStub({}) as RpcStub<{}>
    const authenticatedApi = api(overseer)

    function Probe() {
      const state = useWorkspaceOpen({
        id: 'workspace-1',
        authenticatedApi,
        onInvalidShareKey: () => {},
        onMetadata: () => {},
        onShareKeyConsumed: () => {},
      })
      return <p>{state.overseer ? 'published' : 'pending'}</p>
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))
    expect(container.textContent).toBe('pending')

    await act(async () => {
      pendingSubscription.resolve(subscription)
      await Promise.resolve()
    })

    expect(container.textContent).toBe('published')
  })

  it('does not publish the failed overseer stub after access is denied', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const pendingSubscription = deferred<RpcStub<{}>>()
    const deniedOverseerDispose = vi.fn<() => void>()
    const deniedOverseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(() => pendingSubscription.promise),
    }, deniedOverseerDispose) as unknown as RpcStub<Overseer>
    const authenticatedApi = api(deniedOverseer)

    function Probe() {
      const state = useWorkspaceOpen({
        id: 'workspace-1',
        authenticatedApi,
        onInvalidShareKey: () => {},
        onMetadata: () => {},
        onShareKeyConsumed: () => {},
      })
      if (state.error?.kind === 'open') return <p>{state.error.failure}</p>
      return <p>{state.overseer ? 'published' : 'pending'}</p>
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))
    expect(container.textContent).toBe('pending')

    await act(async () => {
      pendingSubscription.reject(createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied))
      await Promise.resolve()
    })

    expect(container.textContent).toBe('access-denied')
    expect(deniedOverseerDispose).toHaveBeenCalledOnce()
  })

  it('clears loaded metadata and title and disposes the failed stub after access is denied', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    document.title = 'outside'
    const firstSubscriptionDispose = vi.fn<() => void>()
    const firstOverseer = disposableStub({
      subscribeToMetadata: vi.fn<
        (callback: (metadata: GadgetMetadata) => void) => Promise<RpcStub<{}>>
      >(async callback => {
          callback(METADATA)
          return disposableStub({}, firstSubscriptionDispose) as RpcStub<{}>
        }),
    }) as unknown as RpcStub<Overseer>
    const deniedOverseerDispose = vi.fn<() => void>()
    const deniedOverseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(async () => {
        throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied)
      }),
    }, deniedOverseerDispose) as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(firstOverseer)} />))
    expect(container.textContent).toContain('Quarterly planning')
    expect(document.title).toBe('Quarterly planning - Odie OS')

    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(deniedOverseer)} />))
    expect(container.textContent).toContain("You don't have access to this workspace")
    expect(container.textContent).not.toContain('Quarterly planning')
    expect(document.title).toBe('Odie OS')
    expect(firstSubscriptionDispose).toHaveBeenCalledOnce()
    expect(deniedOverseerDispose).toHaveBeenCalledOnce()
  })
})
