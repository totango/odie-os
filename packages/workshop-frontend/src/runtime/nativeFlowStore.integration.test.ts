/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, NativeLoginFlowStatus } from '@gadgets/workshop-shared/api'
import type { PendingNativeLoginFlow, WorkshopRuntime } from './WorkshopRuntime'
import { createWebRuntime } from './webRuntime'
import { consumePendingNativeAccount, installNativeAccountCoordinator } from './nativeLoginCoordinator'
import { nativeFlowStore } from './nativeFlowStore'
import { runAccountBrowserFlow } from '../accountBrowserFlow'

const current = vi.hoisted(() => ({ runtime: undefined as WorkshopRuntime | undefined }))
vi.mock('../runtime', () => ({ getWorkshopRuntime: () => current.runtime }))

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const ticket = 'a'.repeat(64)
const fixture = () => {
  let stored: PendingNativeLoginFlow | null = { purpose: 'account', flowHandle: 'flow-A', verifier: 'verifier-A' }
  const runtime: WorkshopRuntime = {
    ...createWebRuntime(), kind: 'tauri',
    readPendingNativeLoginFlow: async () => stored,
    writePendingNativeLoginFlow: async value => { stored = value },
    clearPendingNativeLoginFlow: async () => { stored = null },
    openOAuthTrampoline: async () => {},
    subscribeDeepLinks: async () => () => {},
  }
  current.runtime = runtime
  return { runtime, read: () => stored }
}

describe('serialized native flow ownership', () => {
  it.each(['pending', 'completed'] as const)('A waits for %s status, B is persisted by the real flow runner, then A cannot overwrite/clear/activate; B can complete', async status => {
    const f = fixture()
    const statusA = deferred<NativeLoginFlowStatus>()
    const readStatus = vi.fn<AuthenticatedApi['getNativeAccountFlowStatus']>(async handle => handle === 'flow-A' ? statusA.promise : { status: 'pending' })
    const activate = vi.fn<AuthenticatedApi['completeNativeAccountFlow']>(async () => {})
    const api = { getNativeAccountFlowStatus: readStatus, completeNativeAccountFlow: activate } as unknown as RpcStub<AuthenticatedApi>
    const a = consumePendingNativeAccount(f.runtime, () => api, 'flow-A', ticket)
    await vi.waitFor(() => expect(readStatus).toHaveBeenCalledWith('flow-A', 'verifier-A'))
    const abort = new AbortController()
    const b = runAccountBrowserFlow(api, async () => ({ url: 'https://example.test/start', flowHandle: 'flow-B' }), { signal: abort.signal })
    const stopped = b.catch((error: unknown) => error)
    await vi.waitFor(() => expect(f.read()?.flowHandle).toBe('flow-B'))
    const bRecord = f.read()
    statusA.resolve({ status })
    expect(await a).toBe(false)
    expect(f.read()).toEqual(bRecord)
    expect(activate).not.toHaveBeenCalled()
    abort.abort()
    expect(await stopped).toMatchObject({ name: 'AbortError', message: 'Account browser flow was cancelled.' })
    await consumePendingNativeAccount(f.runtime, () => api, 'flow-B', 'b'.repeat(64))
    expect(activate).toHaveBeenCalledExactlyOnceWith('flow-B', bRecord!.verifier, 'b'.repeat(64))
    expect(f.read()).toBeNull()
  })

  it('does not relabel the old persisted flow with the new epoch while creation is pending', async () => {
    const f = fixture()
    const store = nativeFlowStore(f.runtime)
    const epoch = store.begin()
    expect(await store.read()).toBeNull()
    const api = { getNativeAccountFlowStatus: vi.fn<AuthenticatedApi['getNativeAccountFlowStatus']>() } as unknown as RpcStub<AuthenticatedApi>
    expect(await consumePendingNativeAccount(f.runtime, () => api, 'flow-A', ticket)).toBe(false)
    expect(api.getNativeAccountFlowStatus).not.toHaveBeenCalled()
    await store.replace(epoch, { purpose: 'account', flowHandle: 'flow-B', verifier: 'verifier-B' })
    expect((await store.read())?.flow.flowHandle).toBe('flow-B')
  })

  it('auth teardown while A awaits status prevents claims and dispatch', async () => {
    const f = fixture()
    const store = nativeFlowStore(f.runtime)
    await store.replace(store.begin(), { ...f.read()!, ticket })
    const status = deferred<NativeLoginFlowStatus>()
    const readStatus = vi.fn<AuthenticatedApi['getNativeAccountFlowStatus']>(() => status.promise)
    const activate = vi.fn<AuthenticatedApi['completeNativeAccountFlow']>(async () => {})
    const api = { getNativeAccountFlowStatus: readStatus, completeNativeAccountFlow: activate } as unknown as RpcStub<AuthenticatedApi>
    const cleanup = await installNativeAccountCoordinator(f.runtime, () => api)
    await vi.waitFor(() => expect(readStatus).toHaveBeenCalledOnce())
    cleanup()
    status.resolve({ status: 'pending' })
    await store.read()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(activate).not.toHaveBeenCalled()
    expect(f.read()).toMatchObject({ flowHandle: 'flow-A', ticket })
    expect(f.read()?.activationAttempted).toBeUndefined()
  })

  it('serializes a claim vault-write and a newer replace; rechecks the epoch before dispatch', async () => {
    const f = fixture()
    const writing = deferred<void>()
    const release = deferred<void>()
    const write = f.runtime.writePendingNativeLoginFlow
    f.runtime.writePendingNativeLoginFlow = async flow => {
      if (flow.activationAttempted) { writing.resolve(); await release.promise }
      await write(flow)
    }
    const activate = vi.fn<AuthenticatedApi['completeNativeAccountFlow']>(async () => {})
    const api = { getNativeAccountFlowStatus: async () => ({ status: 'pending' }), completeNativeAccountFlow: activate } as unknown as RpcStub<AuthenticatedApi>
    const a = consumePendingNativeAccount(f.runtime, () => api, 'flow-A', ticket)
    await writing.promise
    const store = nativeFlowStore(f.runtime)
    const next = { purpose: 'account' as const, flowHandle: 'flow-B', verifier: 'verifier-B' }
    const b = store.replace(store.begin(), next)
    release.resolve()
    expect(await a).toBe(false)
    expect(await b).toBe(true)
    expect(f.read()).toEqual(next)
    expect(activate).not.toHaveBeenCalled()
  })

  it('rolls back a known-undispatched claim after auth teardown during its vault write, then fresh authority activates once', async () => {
    const f = fixture()
    const store = nativeFlowStore(f.runtime)
    await store.replace(store.begin(), { ...f.read()!, ticket })
    const writing = deferred<void>()
    const release = deferred<void>()
    const write = f.runtime.writePendingNativeLoginFlow
    f.runtime.writePendingNativeLoginFlow = async flow => {
      if (flow.activationAttempted) { writing.resolve(); await release.promise }
      await write(flow)
    }
    const activateOld = vi.fn<AuthenticatedApi['completeNativeAccountFlow']>(async () => {})
    const oldApi = { getNativeAccountFlowStatus: async () => ({ status: 'pending' }), completeNativeAccountFlow: activateOld } as unknown as RpcStub<AuthenticatedApi>
    const cleanup = await installNativeAccountCoordinator(f.runtime, () => oldApi)
    await writing.promise
    cleanup()
    release.resolve()
    const retained = await store.read()
    expect(activateOld).not.toHaveBeenCalled()
    expect(retained?.flow).toEqual({ purpose: 'account', flowHandle: 'flow-A', verifier: 'verifier-A', ticket })

    const activateFresh = vi.fn<AuthenticatedApi['completeNativeAccountFlow']>(async () => {})
    const freshApi = { getNativeAccountFlowStatus: async () => ({ status: 'pending' }), completeNativeAccountFlow: activateFresh } as unknown as RpcStub<AuthenticatedApi>
    const stop = await installNativeAccountCoordinator(f.runtime, () => freshApi)
    try {
      await vi.waitFor(() => expect(activateFresh).toHaveBeenCalledExactlyOnceWith('flow-A', 'verifier-A', ticket))
      await vi.waitFor(() => expect(f.read()).toBeNull())
      expect(activateOld).not.toHaveBeenCalled()
    } finally { stop() }
  })

  it('retains the claim when start was invoked even if dispatch throws synchronously', async () => {
    const f = fixture()
    const activate = vi.fn<AuthenticatedApi['completeNativeAccountFlow']>(() => { throw new Error('uncertain dispatch') })
    const api = { getNativeAccountFlowStatus: async () => ({ status: 'pending' }), completeNativeAccountFlow: activate } as unknown as RpcStub<AuthenticatedApi>
    await expect(consumePendingNativeAccount(f.runtime, () => api, 'flow-A', ticket)).rejects.toThrow('uncertain dispatch')
    expect(f.read()).toMatchObject({ ticket, activationAttempted: true })
    expect(await consumePendingNativeAccount(f.runtime, () => api)).toBe(false)
    expect(activate).toHaveBeenCalledOnce()
  })

  it('retains recovery for consumed/unknown outcomes rather than treating consumption as success', async () => {
    const f = fixture()
    const store = nativeFlowStore(f.runtime)
    await store.replace(store.begin(), { ...f.read()!, ticket, activationAttempted: true })
    const api = { getNativeAccountFlowStatus: async () => ({ status: 'consumed' }) } as unknown as RpcStub<AuthenticatedApi>
    expect(await consumePendingNativeAccount(f.runtime, () => api)).toBe(false)
    expect(f.read()).toMatchObject({ ticket, activationAttempted: true })
  })
})
