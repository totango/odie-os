/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, PublicApi } from '@gadgets/workshop-shared/api'
import { createWebRuntime } from './webRuntime'
import type { PendingNativeLoginFlow, WorkshopRuntime } from './WorkshopRuntime'
import { consumePendingNativeAccount, consumePendingNativeLoginUrl, installNativeAccountCoordinator, installNativeLoginCoordinator } from './nativeLoginCoordinator'

const origin = 'https://odie-os-native-api.odie-os.workers.dev'
const handle = 'a'.repeat(32)
const ticket = 'b'.repeat(64)
const link = `${origin}/native/oauth-return/${encodeURIComponent(handle)}#${ticket}`

const fixture = (purpose: 'account' | 'login', coldUrl?: string) => {
  let pending: PendingNativeLoginFlow | null = { purpose, flowHandle: handle, verifier: 'independent-app-verifier' }
  let deliver: ((event: { url: string }) => void) | undefined
  const unsubscribe = vi.fn<() => void>()
  const runtime: WorkshopRuntime = {
    ...createWebRuntime(), kind: 'tauri', appLinkOrigin: new URL(origin),
    readPendingNativeLoginFlow: async () => pending,
    writePendingNativeLoginFlow: async value => { pending = value },
    clearPendingNativeLoginFlow: async () => { pending = null },
    writeSessionSecret: vi.fn<WorkshopRuntime['writeSessionSecret']>(async () => {}),
    subscribeDeepLinks: async callback => { deliver = callback; if (coldUrl) callback({ url: coldUrl }); return unsubscribe },
    lock: async () => {},
  }
  return { runtime, read: () => pending, deliver: (url: string) => deliver?.({ url }), unsubscribe }
}

describe('ticket-bound native handoffs', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks() })

  it.each(['cold', 'warm'])('activates an authenticated account on a %s link only with verifier and ticket', async mode => {
    const f = fixture('account', mode === 'cold' ? link : undefined)
    let activated = false
    const complete = vi.fn<AuthenticatedApi['completeNativeAccountFlow']>(async (receivedHandle, verifier, receivedTicket) => {
      expect([receivedHandle, verifier, receivedTicket]).toEqual([handle, 'independent-app-verifier', ticket])
      activated = true
    })
    const api = { getNativeAccountFlowStatus: async () => ({ status: activated ? 'completed' : 'pending' }), completeNativeAccountFlow: complete } as unknown as RpcStub<AuthenticatedApi>
    cleanups.push(await installNativeAccountCoordinator(f.runtime, () => api))
    if (mode === 'warm') {
      await Promise.resolve()
      // eslint-disable-next-line vitest/no-conditional-expect -- only the warm fixture has a pre-delivery phase
      expect(complete).not.toHaveBeenCalled()
      f.deliver(link)
    }
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(f.read()).toBeNull())
    f.deliver(link)
    await Promise.resolve()
    expect(complete).toHaveBeenCalledOnce()
    expect(f.runtime.writeSessionSecret).not.toHaveBeenCalled()
  })

  it.each(['cold', 'warm'])('redeems a %s sign-in return with the public API and both factors', async mode => {
    const f = fixture('login', mode === 'cold' ? link : undefined)
    const consume = vi.fn<PublicApi['consumeNativeLoginFlow']>(async (receivedHandle, verifier, receivedTicket) => {
      if (!receivedTicket) return { status: 'pending' }
      expect([receivedHandle, verifier, receivedTicket]).toEqual([handle, 'independent-app-verifier', ticket])
      return { status: 'completed', token: 'session-secret' }
    })
    const api = { consumeNativeLoginFlow: consume } as unknown as RpcStub<PublicApi>
    cleanups.push(await installNativeLoginCoordinator(f.runtime, () => api))
    if (mode === 'warm') f.deliver(link)
    await vi.waitFor(() => expect(f.runtime.writeSessionSecret).toHaveBeenCalledExactlyOnceWith('session-secret'))
    expect(f.read()).toBeNull()
  })

  it('rejects wrong origin/handle, missing ticket, query ticket and malformed fragments before any redemption', async () => {
    const f = fixture('login')
    const consume = vi.fn<PublicApi['consumeNativeLoginFlow']>()
    const api = { consumeNativeLoginFlow: consume } as unknown as RpcStub<PublicApi>
    for (const url of [link.replace(origin, 'https://evil.test'), link.replace(handle, 'c'.repeat(32)),
      link.split('#')[0], link.replace('#', '?ticket='), link.replace(ticket, 'invalid')]) {
      expect(await consumePendingNativeLoginUrl(f.runtime, () => api, url)).toBe(false)
    }
    expect(consume).not.toHaveBeenCalled()
    expect(f.read()?.verifier).toBe('independent-app-verifier')
  })

  it('reconciles a lost account acknowledgement by status without repeating activation', async () => {
    const f = fixture('account')
    let activated = false
    const complete = vi.fn<AuthenticatedApi['completeNativeAccountFlow']>(async () => { activated = true; throw new Error('connection lost') })
    const api = { getNativeAccountFlowStatus: async () => ({ status: activated ? 'completed' : 'pending' }), completeNativeAccountFlow: complete } as unknown as RpcStub<AuthenticatedApi>
    await expect(consumePendingNativeAccount(f.runtime, () => api, handle, ticket)).rejects.toThrow('connection lost')
    expect(f.read()).toMatchObject({ ticket, activationAttempted: true })
    await consumePendingNativeAccount(f.runtime, () => api)
    expect(complete).toHaveBeenCalledOnce()
    expect(f.read()).toBeNull()
  })

  it('preserves an uncertain account activation across restart without replaying it', async () => {
    const f = fixture('account')
    const complete = vi.fn<AuthenticatedApi['completeNativeAccountFlow']>(async () => { throw new Error('unknown outcome') })
    const api = { getNativeAccountFlowStatus: async () => ({ status: 'pending' }), completeNativeAccountFlow: complete } as unknown as RpcStub<AuthenticatedApi>
    await expect(consumePendingNativeAccount(f.runtime, () => api, handle, ticket)).rejects.toThrow('unknown outcome')
    await consumePendingNativeAccount(f.runtime, () => api)
    expect(complete).toHaveBeenCalledOnce()
    expect(f.read()?.verifier).toBe('independent-app-verifier')
  })

  it('disposes deep-link ownership and ignores later callbacks after auth teardown', async () => {
    const f = fixture('account')
    const complete = vi.fn<AuthenticatedApi['completeNativeAccountFlow']>()
    const api = { getNativeAccountFlowStatus: async () => ({ status: 'pending' }), completeNativeAccountFlow: complete } as unknown as RpcStub<AuthenticatedApi>
    const cleanup = await installNativeAccountCoordinator(f.runtime, () => api)
    cleanup()
    f.deliver(link)
    await Promise.resolve()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(complete).not.toHaveBeenCalled()
  })
})
