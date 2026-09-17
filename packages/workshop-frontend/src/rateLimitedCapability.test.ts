import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcStub, RpcTarget } from 'capnweb'
import { createRateLimitedCapability } from './rateLimitedCapability'

const options = { maxConcurrency: 1, maxCallsPerMinute: 2, maxPendingCalls: 8, onRateLimit: 'throttle' as const, label: 'Test' }
afterEach(() => vi.useRealTimers())

describe('rate limited authority slots', () => {
  it('terminal close rejects queued calls and completion never restarts dispatch', async () => {
    let finish!: (value: string) => void
    const method = vi.fn<() => Promise<string>>(() => new Promise<string>(resolve => { finish = resolve }))
    const slot = createRateLimitedCapability({ method }, options)
    const first = slot.capability.method().catch((error: Error) => error.message)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const queued = slot.capability.method().catch((error: Error) => error.message)
    slot.dispose()
    expect(await queued).toContain('no longer available')
    finish('old')
    expect(await first).toContain('no longer available')
    await expect(slot.capability.method()).rejects.toThrow('no longer available')
    expect(() => slot.replace({ method })).toThrow('no longer available')
    expect(method).toHaveBeenCalledOnce()
  })

  it('rejects old queued work on refresh without resetting the document rate budget', async () => {
    vi.useFakeTimers()
    const old = vi.fn<() => string>(() => 'old')
    const fresh = vi.fn<() => string>(() => 'new')
    const slot = createRateLimitedCapability({ method: old }, { ...options, maxCallsPerMinute: 1 })
    expect(await slot.capability.method()).toBe('old')
    const queued = slot.capability.method().catch((error: Error) => error.message)
    slot.suspend()
    slot.replace({ method: fresh })
    expect(await queued).toContain('no longer available')
    const next = slot.capability.method()
    await Promise.resolve()
    expect(fresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(await next).toBe('new')
    slot.dispose()
  })

  it('checks authority at invocation, not just when the cached reference was obtained', async () => {
    let authorized = true
    const method = vi.fn<() => string>(() => 'allowed')
    const slot = createRateLimitedCapability({ method }, { ...options, assertAuthority: () => {
      if (!authorized) throw new Error('revoked')
    } })
    const pending = slot.capability.method()
    authorized = false
    await expect(pending).rejects.toThrow('revoked')
    expect(method).not.toHaveBeenCalled()
    slot.dispose()
  })

  it('releases a real Capnweb callback argument when its queued call is closed', async () => {
    let finish!: () => void
    class Callback extends RpcTarget {
      disposed = vi.fn<() => void>();
      [Symbol.dispose]() { this.disposed() }
      call() { return 'callback' }
    }
    const callback = new Callback()
    const slot = createRateLimitedCapability({ hold: () => new Promise<void>(resolve => { finish = resolve }), call: () => 'unexpected' }, options)
    const client = new RpcStub<{ hold(): Promise<void>; call(callback: Callback): string }>(slot.capability)
    const first = Promise.resolve(client.hold()).catch(() => {})
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const queued = Promise.resolve(client.call(callback)).catch((error: Error) => error.message)
    await new Promise(resolve => setTimeout(resolve, 0))
    slot.dispose()
    expect(await queued).toContain('no longer available')
    await vi.waitFor(() => expect(callback.disposed).toHaveBeenCalledOnce())
    finish(); await first
    client[Symbol.dispose]()
  })

  it('revokes escaped children and backend-held callbacks in both directions across suspension and regrant', async () => {
    const invoked = vi.fn<() => string>(() => 'callback')
    class Callback extends RpcTarget { invoke() { return invoked() } }
    class Child extends RpcTarget { read() { return 'child' } }
    class Backend extends RpcTarget {
      callback: RpcStub<Callback> | null = null
      child() { return new Child() }
      subscribe(callback: RpcStub<Callback>) {
        this.callback?.[Symbol.dispose]()
        this.callback = callback.dup()
      }
    }
    const backend = new Backend()
    const backendStub = new RpcStub(backend)
    const slot = createRateLimitedCapability(backendStub, { ...options, maxCallsPerMinute: 100 })
    const client = new RpcStub<Backend>(slot.capability)
    const callback = new Callback()
    const child = await client.child()
    await client.subscribe(callback)
    await expect(backend.callback!.invoke()).resolves.toBe('callback')
    const oldCallback = backend.callback!
    slot.suspend()
    await expect(child.read()).rejects.toThrow(/closed|disconnected|dispos/i)
    await expect(oldCallback.invoke()).rejects.toThrow(/closed|disconnected|dispos/i)
    slot.replace(backendStub)
    await expect(child.read()).rejects.toThrow(/closed|disconnected|dispos/i)
    const freshChild = await client.child()
    await expect(freshChild.read()).resolves.toBe('child')
    slot.dispose()
    const regrant = createRateLimitedCapability(backendStub, options)
    const newClient = new RpcStub<Backend>(regrant.capability)
    await expect(freshChild.read()).rejects.toThrow(/closed|disconnected|dispos/i)
    await expect(client.child()).rejects.toThrow('no longer available')
    await expect(oldCallback.invoke()).rejects.toThrow(/closed|disconnected|dispos/i)
    const granted = await newClient.child()
    await expect(granted.read()).resolves.toBe('child')
    expect(invoked).toHaveBeenCalledOnce()
    granted[Symbol.dispose](); child[Symbol.dispose](); freshChild[Symbol.dispose]()
    oldCallback[Symbol.dispose](); client[Symbol.dispose](); newClient[Symbol.dispose]()
    regrant.dispose(); backendStub[Symbol.dispose]()
  })

  it('recovers concurrency from never-settled old work and ignores its late completion', async () => {
    let finishOld!: () => void
    const slot = createRateLimitedCapability({ write: () => new Promise<void>(resolve => { finishOld = resolve }) }, { ...options, maxCallsPerMinute: 100 })
    const old = slot.capability.write().catch((error: Error) => error.message)
    await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'))
    slot.suspend()
    expect(await old).toContain('no longer available')
    let finishNew!: () => void
    const write = vi.fn<() => Promise<void>>(() => new Promise(resolve => { finishNew = resolve }))
    slot.replace({ write })
    const fresh = slot.capability.write()
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    const queued = slot.capability.write().catch((error: Error) => error.message)
    finishOld()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(write).toHaveBeenCalledOnce()
    finishNew(); await fresh
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    slot.dispose()
    expect(await queued).toContain('no longer available')
  })
})
