/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { consumePendingNativeLogin, consumePendingNativeLoginUrl, installNativeLoginCoordinator } from './nativeLoginCoordinator'
import type { WorkshopRuntime } from './WorkshopRuntime'

function mockFn<T extends (...args: any[]) => any>() {
  return vi.fn<T>()
}

const TICKET = 'c'.repeat(64)
const returnUrl = (handle = 'a'.repeat(32)) => `https://odie-os-native-api.odie-os.workers.dev/native/oauth-return/${handle}#${TICKET}`

function runtime(pending: { flowHandle: string; verifier: string; ticket?: string } | null): WorkshopRuntime {
  return {
    kind: 'tauri',
    apiOrigin: new URL('https://odie-os-native-api.odie-os.workers.dev'),
    publicWebOrigin: new URL('https://odie-os.odie-os.workers.dev'),
    appLinkOrigin: new URL('https://odie-os-native-api.odie-os.workers.dev'),
    getNativeAppInfo: vi.fn<WorkshopRuntime['getNativeAppInfo']>(async () => null),
    openExternal: mockFn<(url: string) => Promise<void>>(),
    openOAuthTrampoline: mockFn<(url: string) => Promise<void>>(),
    subscribeDeepLinks: mockFn<WorkshopRuntime['subscribeDeepLinks']>(),
    readSessionSecret: mockFn<() => Promise<string | null>>(),
    writeSessionSecret: mockFn<(token: string) => Promise<void>>(),
    clearSessionSecret: mockFn<() => Promise<void>>(),
    readPendingNativeLoginFlow: vi.fn<() => Promise<{ flowHandle: string; verifier: string } | null>>(async () => pending),
    writePendingNativeLoginFlow: mockFn<WorkshopRuntime['writePendingNativeLoginFlow']>(),
    clearPendingNativeLoginFlow: mockFn<() => Promise<void>>(),
    saveBlob: mockFn<WorkshopRuntime['saveBlob']>(),
    saveText: mockFn<WorkshopRuntime['saveText']>(),
    requestNotificationPermission: vi.fn<() => Promise<boolean>>(async () => true),
    sendNotification: vi.fn<WorkshopRuntime['sendNotification']>(async () => {}),
    lock: vi.fn<() => Promise<void>>(async () => {}),
    unlock: vi.fn<() => Promise<boolean>>(async () => true),
  }
}

describe('native login coordinator', () => {
  it('cold-start consumes matching pending flow using the current stub, writes session, and clears pending state', async () => {
    const rt = runtime({ flowHandle: 'a'.repeat(32), verifier: 'verifier' })
    const firstApi = { consumeNativeLoginFlow: vi.fn<(handle: string, verifier: string) => Promise<string>>() }
    const currentApi = { consumeNativeLoginFlow: vi.fn<(handle: string, verifier: string) => Promise<any>>(async () => ({ status: 'completed', token: 'user:token' })) }
    const getApi = vi.fn<() => any>()
      .mockReturnValueOnce(firstApi)
      .mockReturnValueOnce(currentApi)

    // Proves callers can install with one stub and consume later with the replaced/current stub.
    getApi()
    const consumed = await consumePendingNativeLoginUrl(rt, getApi, returnUrl())
    expect(consumed).toBe(true)
    expect(firstApi.consumeNativeLoginFlow).not.toHaveBeenCalled()
    expect(currentApi.consumeNativeLoginFlow).toHaveBeenCalledWith('a'.repeat(32), 'verifier', TICKET)
    expect(rt.writeSessionSecret).toHaveBeenCalledWith('user:token')
    expect(rt.clearPendingNativeLoginFlow).toHaveBeenCalled()
  })

  it('ignores foreign links and mismatched handles without clearing pending state', async () => {
    const rt = runtime({ flowHandle: 'a'.repeat(32), verifier: 'verifier' })
    const api = { consumeNativeLoginFlow: vi.fn<(handle: string, verifier: string) => Promise<string>>() }
    expect(await consumePendingNativeLoginUrl(rt, () => api as any, 'https://evil.example/native/oauth-return/' + 'a'.repeat(32))).toBe(false)
    expect(await consumePendingNativeLoginUrl(rt, () => api as any, returnUrl('b'.repeat(32)))).toBe(false)
    expect(api.consumeNativeLoginFlow).not.toHaveBeenCalled()
    expect(rt.clearPendingNativeLoginFlow).not.toHaveBeenCalled()
  })

  it('retains pending verifier on transient RPC failures', async () => {
    const rt = runtime({ flowHandle: 'a'.repeat(32), verifier: 'verifier' })
    const api = { consumeNativeLoginFlow: vi.fn<(handle: string, verifier: string) => Promise<any>>(async () => { throw new Error('WebSocket disconnected') }) }
    await expect(consumePendingNativeLoginUrl(rt, () => api as any, returnUrl())).rejects.toThrow('WebSocket disconnected')
    expect(rt.writePendingNativeLoginFlow).toHaveBeenCalledWith({ flowHandle: 'a'.repeat(32), verifier: 'verifier', ticket: TICKET })
    expect(rt.clearPendingNativeLoginFlow).not.toHaveBeenCalled()
  })

  it('waits for a stable foreground before consuming a pending flow', async () => {
    vi.useFakeTimers()
    const rt = runtime(null)
    vi.mocked(rt.subscribeDeepLinks).mockResolvedValue(() => {})
    vi.mocked(rt.readPendingNativeLoginFlow)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ flowHandle: 'a'.repeat(32), verifier: 'verifier', ticket: TICKET })
    const api = {
      consumeNativeLoginFlow: vi.fn<() => Promise<any>>(async () => ({ status: 'completed', token: 'user:token' })),
    }

    const cleanup = await installNativeLoginCoordinator(rt, () => api as any)
    try {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(251)
      expect(api.consumeNativeLoginFlow).not.toHaveBeenCalled()

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(251)
      expect(api.consumeNativeLoginFlow).toHaveBeenCalled()
      expect(rt.writeSessionSecret).toHaveBeenCalledWith('user:token')
      expect(rt.clearPendingNativeLoginFlow).toHaveBeenCalled()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('clears pending verifier on terminal server outcomes', async () => {
    const rt = runtime({ flowHandle: 'a'.repeat(32), verifier: 'verifier' })
    const api = { consumeNativeLoginFlow: vi.fn<(handle: string, verifier: string) => Promise<any>>(async () => ({ status: 'expired' })) }
    await expect(consumePendingNativeLoginUrl(rt, () => api as any, returnUrl())).resolves.toBe(true)
    expect(rt.clearPendingNativeLoginFlow).toHaveBeenCalled()
  })

  it('retries a previously delivered ticket on startup when an app link is unavailable', async () => {
    const rt = runtime({ flowHandle: 'a'.repeat(32), verifier: 'verifier', ticket: TICKET })
    vi.mocked(rt.subscribeDeepLinks).mockResolvedValue(() => {})
    const api = {
      consumeNativeLoginFlow: vi.fn<(handle: string, verifier: string) => Promise<any>>(
        async () => ({ status: 'completed', token: 'user:token' }),
      ),
    }
    const cleanup = await installNativeLoginCoordinator(rt, () => api as any)
    await vi.waitFor(() => expect(rt.writeSessionSecret).toHaveBeenCalledWith('user:token'))
    cleanup()
  })

  it('keeps polling when native deep-link registration fails', async () => {
    const rt = runtime({ flowHandle: 'a'.repeat(32), verifier: 'verifier', ticket: TICKET })
    vi.mocked(rt.subscribeDeepLinks).mockRejectedValue(new Error('plugin unavailable'))
    const api = {
      consumeNativeLoginFlow: vi.fn<(handle: string, verifier: string) => Promise<any>>(
        async () => ({ status: 'completed', token: 'user:token' }),
      ),
    }
    const cleanup = await installNativeLoginCoordinator(rt, () => api as any)
    try {
      await vi.waitFor(() => expect(rt.writeSessionSecret).toHaveBeenCalledWith('user:token'))
    } finally {
      cleanup()
    }
  })

  it('drops the in-memory native unlock lease when the app is backgrounded', async () => {
    const rt = runtime(null)
    vi.mocked(rt.subscribeDeepLinks).mockResolvedValue(() => {})
    const api = { consumeNativeLoginFlow: mockFn<() => Promise<any>>() }
    const originalVisibility = document.visibilityState
    const cleanup = await installNativeLoginCoordinator(rt, () => api as any)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(rt.lock).toHaveBeenCalled())
    Object.defineProperty(document, 'visibilityState', { value: originalVisibility, configurable: true })
    cleanup()
  })

  it('subscribes warm links without capturing a stale RPC stub', async () => {
    const rt = runtime({ flowHandle: 'a'.repeat(32), verifier: 'verifier' })
    let callback!: (event: { url: string }) => void
    vi.mocked(rt.subscribeDeepLinks).mockImplementation(async cb => {
      callback = cb
      return () => {}
    })
    const api = { consumeNativeLoginFlow: vi.fn<(handle: string, verifier: string) => Promise<any>>(async () => ({ status: 'completed', token: 'user:token' })) }
    const cleanup = await installNativeLoginCoordinator(rt, () => api as any)
    try {
      callback({ url: returnUrl() })
      await vi.waitFor(() => expect(api.consumeNativeLoginFlow).toHaveBeenCalled())
    } finally {
      cleanup()
    }
  })

  it('never accepts a legacy backend token from a status-only poll', async () => {
    const rt = runtime({ flowHandle: 'a'.repeat(32), verifier: 'verifier' })
    const api = { consumeNativeLoginFlow: vi.fn<() => Promise<any>>(async () => ({ status: 'completed', token: 'unsafe' })) }
    expect(await consumePendingNativeLogin(rt, () => api as any)).toBe(false)
    expect(rt.writeSessionSecret).not.toHaveBeenCalled()
    expect(rt.clearPendingNativeLoginFlow).not.toHaveBeenCalled()
  })
})
