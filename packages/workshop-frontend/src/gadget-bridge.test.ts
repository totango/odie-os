import { afterEach, describe, expect, it, vi } from 'vitest'
import { GadgetBridge } from './gadget-bridge'

const sessions = vi.hoisted(() => [] as { target: any; dispose: ReturnType<typeof vi.fn> }[])
vi.mock('capnweb', () => ({
  RpcTarget: class {},
  newMessagePortRpcSession: (port: MessagePort, target?: any) => {
    const dispose = vi.fn<() => void>(() => port.close())
    sessions.push({ target, dispose })
    return { [Symbol.dispose]: dispose }
  },
}))

afterEach(() => {
  sessions.length = 0
  vi.useRealTimers()
})

describe('gadget bridge lifecycle fences', () => {
  it('checks authority at invocation even when a property was looked up while active', async () => {
    const status = vi.fn<(message: string | null) => void>()
    const bridge = new GadgetBridge(status)
    bridge.resume(async () => ({ [Symbol.dispose]: vi.fn<() => void>() }))
    bridge.handshake({ close: vi.fn<() => void>() } as unknown as MessagePort)
    await vi.waitFor(() => expect(sessions).toHaveLength(3))
    const method = sessions[0].target.write
    const statusCalls = status.mock.calls.length
    bridge.suspend()
    expect(() => method('opaque mutation')).toThrow('not dispatched')
    bridge.dispose()
    expect(status).toHaveBeenCalledTimes(statusCalls)
    expect(sessions[0].dispose).toHaveBeenCalledOnce()
  })

  it('does not start a scheduled acquisition after synchronous suspension', async () => {
    const acquire = vi.fn<() => Promise<unknown>>()
    const bridge = new GadgetBridge(vi.fn<(message: string | null) => void>())
    bridge.resume(acquire)
    bridge.handshake({ close: vi.fn<() => void>() } as unknown as MessagePort)
    bridge.suspend()
    bridge.releaseBackend()
    await Promise.resolve()
    expect(acquire).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('bounds automatic retries and never updates React state from final cleanup', async () => {
    vi.useFakeTimers()
    const status = vi.fn<(message: string | null) => void>()
    const acquire = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error('offline'))
    const bridge = new GadgetBridge(status)
    bridge.resume(acquire)
    bridge.handshake({ close: vi.fn<() => void>() } as unknown as MessagePort)
    await vi.runAllTimersAsync()
    expect(acquire).toHaveBeenCalledTimes(6)
    const calls = status.mock.calls.length
    bridge.dispose()
    await vi.runAllTimersAsync()
    expect(status).toHaveBeenCalledTimes(calls)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a hung first acquisition, rejects its waiting call and keeps retries fail-fast', async () => {
    vi.useFakeTimers()
    const acquire = vi.fn<() => Promise<unknown>>(() => new Promise(() => {}))
    const bridge = new GadgetBridge(vi.fn<(message: string | null) => void>())
    bridge.resume(acquire)
    bridge.handshake({ close: vi.fn<() => void>() } as unknown as MessagePort)
    const target = sessions[0].target
    expect(target.then).toBeUndefined()
    const pending = target.write('first attempt') as Promise<unknown>
    void pending.catch(() => {})
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(pending).rejects.toThrow('not dispatched')
    await vi.advanceTimersByTimeAsync(500)
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(() => target.write('retry')).toThrow('not dispatched')
    bridge.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('manual retry rejects the first wait instead of transferring it to another generation', async () => {
    const bridge = new GadgetBridge(vi.fn<(message: string | null) => void>())
    bridge.resume(() => new Promise(() => {}))
    bridge.handshake({ close: vi.fn<() => void>() } as unknown as MessagePort)
    const pending = sessions[0].target.write('first attempt') as Promise<unknown>
    bridge.retry()
    await expect(pending).rejects.toThrow('not dispatched')
    bridge.dispose()
  })
})
