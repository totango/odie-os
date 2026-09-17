// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { Activity, act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { newMessagePortRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GadgetClient, UiBundle } from '@gadgets/workshop-shared/api'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  } else {
    testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

vi.mock('@cloudflare/kumo', () => ({
  Banner: () => null,
  Loader: () => null,
  Text: ({ children }: { children: ReactNode }) => children,
}))

import GadgetUI from './GadgetUI'

interface TestGadget {
  read(): string
  child(): TestChild
  subscribe(callback: RpcStub<TestSubscriber>): TestSubscription
}

interface TestChild {
  read(): string
}

interface TestSubscriber {
  update(value: string): void
}

interface TestSubscription {}

class TestChildTarget extends RpcTarget implements TestChild {
  constructor(private value: string) {
    super()
  }

  read() {
    return this.value
  }
}

class TestSubscriptionTarget extends RpcTarget implements TestSubscription {
  constructor(private unsubscribe: () => void) {
    super()
  }

  [Symbol.dispose]() {
    this.unsubscribe()
  }
}

class TestGadgetTarget extends RpcTarget implements TestGadget {
  private subscribers = new Set<RpcStub<TestSubscriber>>()

  constructor(private value: string, private onDispose?: () => void) {
    super()
  }

  read() {
    return this.value
  }

  child() {
    return new TestChildTarget(this.value)
  }

  async subscribe(callback: RpcStub<TestSubscriber>) {
    const subscriber = callback.dup()
    this.subscribers.add(subscriber)
    const unsubscribe = () => {
      if (this.subscribers.delete(subscriber)) subscriber[Symbol.dispose]()
    }
    subscriber.onRpcBroken(unsubscribe)
    try {
      await subscriber.update(this.value)
      return new TestSubscriptionTarget(unsubscribe)
    } catch (error) {
      unsubscribe()
      throw error
    }
  }

  [Symbol.dispose]() {
    for (const subscriber of this.subscribers) subscriber[Symbol.dispose]()
    this.subscribers.clear()
    this.onDispose?.()
  }
}

class TestCallbacks extends RpcTarget implements TestSubscriber {
  closed = false

  constructor(private values: string[], private reconnect: () => void) {
    super()
  }

  update(value: string) {
    this.values.push(value)
  }

  [Symbol.dispose]() {
    if (!this.closed) this.reconnect()
  }
}

function fakeGadget(
  value: string,
  bundleCode: string,
  connectToGadget = vi.fn<() => Promise<RpcStub<TestGadget>>>(
    async () => new RpcStub(new TestGadgetTarget(value)) as unknown as RpcStub<TestGadget>,
  ),
) {
  const getUiBundle = vi.fn<() => Promise<UiBundle | null>>(async () => ({ jsCode: bundleCode }))
  return {
    connectToGadget,
    getUiBundle,
    stub: { connectToGadget, getUiBundle } as unknown as RpcStub<GadgetClient>,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function dispatchIframeHandshake(iframe: HTMLIFrameElement, port: MessagePort) {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'handshake', documentId: iframe.srcdoc.match(/data-bridge-id="([^"]+)"/)?.[1] },
    origin: 'null',
    source: iframe.contentWindow,
    ports: [port],
  }))
}

describe('GadgetUI RPC recovery', () => {
  let container: HTMLDivElement
  let root: Root
  const childSessions: RpcStub<TestGadget>[] = []

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    vi.useRealTimers()
    for (const session of childSessions.splice(0)) session[Symbol.dispose]()
    await act(async () => root.unmount())
    container.remove()
  })

  function connectIframe(iframe: HTMLIFrameElement) {
    const { port1, port2 } = new MessageChannel()
    const child = newMessagePortRpcSession<TestGadget>(port1)
    childSessions.push(child)
    dispatchIframeHandshake(iframe, port2)
    return child
  }

  it('waits for delayed first acquisition and dispatches immediate bootstrap read exactly once', async () => {
    const acquisition = deferred<RpcStub<TestGadget>>()
    const read = vi.fn<() => string>(() => 'booted')
    class BootTarget extends TestGadgetTarget {
      read() { return read() }
    }
    const gadget = fakeGadget('first', 'first', vi.fn(() => acquisition.promise))
    await act(async () => root.render(<GadgetUI gadget={gadget.stub} height="100px" />))
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    const boot = Promise.resolve(child.read())
    let settled = false
    void boot.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    expect(read).not.toHaveBeenCalled()
    await act(async () => {
      acquisition.resolve(new RpcStub(new BootTarget('booted')) as unknown as RpcStub<TestGadget>)
      await acquisition.promise
    })
    await expect(boot).resolves.toBe('booted')
    expect(read).toHaveBeenCalledOnce()
    expect(container.querySelector('iframe')).toBe(iframe)
  })

  it.each(['failure', 'suspension'] as const)('rejects bootstrap on %s, releases callback args and never replays it', async reason => {
    const acquisition = deferred<RpcStub<TestGadget>>()
    const connect = vi.fn<() => Promise<RpcStub<TestGadget>>>()
      .mockReturnValueOnce(acquisition.promise)
      .mockImplementation(async () => new RpcStub(new TestGadgetTarget('recovered')) as unknown as RpcStub<TestGadget>)
    const gadget = fakeGadget('first', 'first', connect)
    const render = (hidden: boolean) => root.render(
      <Activity mode={hidden ? 'hidden' : 'visible'}><GadgetUI gadget={gadget.stub} height="100px" /></Activity>,
    )
    await act(async () => render(false))
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    const values: string[] = []
    const disposed = vi.fn<() => void>()
    const callback = new RpcStub(new TestCallbacks(values, disposed))
    const pending = Promise.resolve(child.subscribe(callback))
    void pending.catch(() => {})
    callback[Symbol.dispose]()
    await new Promise(resolve => setTimeout(resolve, 30))
    await act(async () => {
      if (reason === 'failure') acquisition.reject(new Error('offline'))
      else render(true)
    })
    await expect(pending).rejects.toThrow('not dispatched')
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce())
    const lateDisposed = vi.fn<() => void>()
    if (reason === 'failure') {
      await act(async () => container.querySelector('button')!.click())
    } else {
      await act(async () => {
        acquisition.resolve(new RpcStub(new TestGadgetTarget('late', lateDisposed)) as unknown as RpcStub<TestGadget>)
        await acquisition.promise
      })
      await act(async () => render(false))
    }
    expect(lateDisposed).toHaveBeenCalledTimes(reason === 'suspension' ? 1 : 0)
    await expect(child.read()).resolves.toBe('recovered')
    expect(values).toEqual([])
    expect(disposed).toHaveBeenCalledOnce()
    expect(container.querySelector('iframe')).toBe(iframe)
  })

  it.each([false, true])('loads newly available UI after a null bundle (hidden update: %s)', async hidden => {
    const gadget = fakeGadget('first', 'new-ui')
    gadget.getUiBundle.mockResolvedValueOnce(null)
    await act(async () => root.render(<GadgetUI gadget={gadget.stub} height="100px" reloadTrigger={0} />))
    expect(container.textContent).toContain('No gadget UI yet')
    await act(async () => root.render(<GadgetUI gadget={gadget.stub} height="100px" reloadTrigger={1} isVisible={!hidden} />))
    expect(gadget.getUiBundle).toHaveBeenCalledTimes(hidden ? 1 : 2)
    if (hidden) {
      await act(async () => root.render(<GadgetUI gadget={gadget.stub} height="100px" reloadTrigger={1} />))
    }
    expect(container.querySelector('iframe')?.srcdoc).toContain('new-ui')
    expect(gadget.getUiBundle).toHaveBeenCalledTimes(2)
  })

  it('preserves the document and local bridge across Activity while revoking derived capabilities', async () => {
    const first = fakeGadget('first', 'first')
    const render = (hidden: boolean, gadget = first) => root.render(
      <Activity mode={hidden ? 'hidden' : 'visible'}>
        <GadgetUI gadget={gadget.stub} height="100px" />
      </Activity>,
    )
    await act(async () => render(false))
    const iframe = container.querySelector('iframe')!
    const srcdoc = iframe.srcdoc
    const child = connectIframe(iframe)
    const derived = await child.child()
    await expect(derived.read()).resolves.toBe('first')
    await act(async () => render(true))
    await expect(child.read()).rejects.toThrow('not dispatched')
    await expect(derived.read()).rejects.toBeDefined()
    expect(container.querySelector('iframe')).toBe(iframe)
    const replacement = fakeGadget('replacement', 'unused')
    await act(async () => render(false, replacement))
    expect(iframe.srcdoc).toBe(srcdoc)
    expect(container.querySelector('iframe')).toBe(iframe)
    await expect(child.read()).resolves.toBe('replacement')
    await expect(derived.read()).rejects.toBeDefined()
    derived[Symbol.dispose]()
  })

  it('accepts a first handshake while Activity is hidden without acquiring backend authority', async () => {
    const gadget = fakeGadget('first', 'first')
    const render = (hidden: boolean) => root.render(
      <Activity mode={hidden ? 'hidden' : 'visible'}>
        <GadgetUI gadget={gadget.stub} height="100px" />
      </Activity>,
    )
    await act(async () => render(false))
    const iframe = container.querySelector('iframe')!
    await act(async () => render(true))
    const child = connectIframe(iframe)
    await expect(child.read()).rejects.toThrow('not dispatched')
    expect(gadget.connectToGadget).not.toHaveBeenCalled()
    await act(async () => render(false))
    await expect(child.read()).resolves.toBe('first')
    expect(container.querySelector('iframe')).toBe(iframe)
    await act(async () => root.unmount())
    await expect(child.read()).rejects.toBeDefined()
    root = createRoot(container)
  })

  it('retains the initial bridge on acquisition failure and retries without reloading', async () => {
    const connect = vi.fn<() => Promise<RpcStub<TestGadget>>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new RpcStub(new TestGadgetTarget('recovered')) as unknown as RpcStub<TestGadget>)
    const gadget = fakeGadget('first', 'first', connect)
    await act(async () => root.render(<GadgetUI gadget={gadget.stub} height="100px" />))
    const iframe = container.querySelector('iframe')!
    let child!: RpcStub<TestGadget>
    await act(async () => { child = connectIframe(iframe) })
    await expect(child.read()).rejects.toThrow('not dispatched')
    expect(container.textContent).toContain('unavailable')
    expect(container.querySelector('iframe')).toBe(iframe)
    await act(async () => container.querySelector('button')!.click())
    await expect(child.read()).resolves.toBe('recovered')
    expect(gadget.getUiBundle).toHaveBeenCalledOnce()
  })

  it('rejects stale document and duplicate handshakes without replacing the bridge', async () => {
    const gadget = fakeGadget('first', 'first')
    await act(async () => root.render(<GadgetUI gadget={gadget.stub} height="100px" />))
    const iframe = container.querySelector('iframe')!
    const stalePort = { close: vi.fn<() => void>() } as unknown as MessagePort
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'handshake', documentId: 'stale' }, origin: 'null',
      source: iframe.contentWindow, ports: [stalePort],
    }))
    expect(stalePort.close).toHaveBeenCalledOnce()
    expect(gadget.connectToGadget).not.toHaveBeenCalled()
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')
    const duplicate = { close: vi.fn<() => void>() } as unknown as MessagePort
    dispatchIframeHandshake(iframe, duplicate)
    expect(duplicate.close).toHaveBeenCalledOnce()
    await expect(child.read()).resolves.toBe('first')
    expect(gadget.connectToGadget).toHaveBeenCalledOnce()
  })

  it('retries a broken backend with unchanged props', async () => {
    let broken!: () => void
    const backend = new RpcStub(new TestGadgetTarget('first')) as unknown as RpcStub<TestGadget>
    const connect = vi.fn<() => Promise<RpcStub<TestGadget>>>()
      .mockResolvedValueOnce(new Proxy(backend, {
        get(target, property) {
          if (property === 'onRpcBroken') return (callback: () => void) => { broken = callback }
          return Reflect.get(target, property)
        },
      }))
      .mockResolvedValueOnce(new RpcStub(new TestGadgetTarget('recovered')) as unknown as RpcStub<TestGadget>)
    const gadget = fakeGadget('first', 'first', connect)
    await act(async () => root.render(<GadgetUI gadget={gadget.stub} height="100px" />))
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')
    vi.useFakeTimers()
    await act(async () => broken())
    await act(async () => vi.advanceTimersByTimeAsync(500))
    vi.useRealTimers()
    await expect(child.read()).resolves.toBe('recovered')
    expect(connect).toHaveBeenCalledTimes(2)
    expect(container.querySelector('iframe')).toBe(iframe)
  })

  it('rejects wrong source/origin handshakes before acquiring any backend', async () => {
    const gadget = fakeGadget('first', 'first')
    await act(async () => root.render(<GadgetUI gadget={gadget.stub} height="100px" />))
    const iframe = container.querySelector('iframe')!
    const port = { close: vi.fn<() => void>() } as unknown as MessagePort
    const data = { type: 'handshake', documentId: iframe.srcdoc.match(/data-bridge-id="([^"]+)"/)?.[1] }
    window.dispatchEvent(new MessageEvent('message', {
      data, origin: 'https://example.com', source: iframe.contentWindow, ports: [port],
    }))
    window.dispatchEvent(new MessageEvent('message', {
      data, origin: 'null', source: window, ports: [port],
    }))
    expect(gadget.connectToGadget).not.toHaveBeenCalled()
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')
  })

  it('disposes an acquisition that times out without replacing the document or bridge', async () => {
    const connection = deferred<RpcStub<TestGadget>>()
    const gadget = fakeGadget('first', 'first', vi.fn(() => connection.promise))
    await act(async () => root.render(<GadgetUI gadget={gadget.stub} height="100px" />))
    const iframe = container.querySelector('iframe')!
    const srcdoc = iframe.srcdoc
    vi.useFakeTimers()
    let child!: RpcStub<TestGadget>
    await act(async () => { child = connectIframe(iframe) })
    await act(async () => vi.advanceTimersByTimeAsync(20_000))
    const disposed = vi.fn<() => void>()
    await act(async () => {
      connection.resolve(new RpcStub(new TestGadgetTarget('late', disposed)) as unknown as RpcStub<TestGadget>)
      await connection.promise
    })
    expect(disposed).toHaveBeenCalledOnce()
    expect(container.querySelector('iframe')).toBe(iframe)
    expect(iframe.srcdoc).toBe(srcdoc)
    vi.useRealTimers()
    await expect(child.read()).rejects.toThrow('not dispatched')
  })

  it('does not replay a dispatched mutation and disposes its late capability after suspension', async () => {
    const result = deferred<TestChildTarget>()
    const write = vi.fn<() => Promise<TestChildTarget>>(() => result.promise)
    class MutationTarget extends RpcTarget {
      child() { return write() }
    }
    const gadget = fakeGadget('first', 'first', vi.fn(async () =>
      new RpcStub(new MutationTarget()) as unknown as RpcStub<TestGadget>,
    ))
    const render = (hidden: boolean) => root.render(
      <Activity mode={hidden ? 'hidden' : 'visible'}>
        <GadgetUI gadget={gadget.stub} height="100px" />
      </Activity>,
    )
    await act(async () => render(false))
    let child!: RpcStub<TestGadget>
    await act(async () => { child = connectIframe(container.querySelector('iframe')!) })
    const pending = Promise.resolve(child.child())
    void pending.catch(() => {})
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    await act(async () => render(true))
    await expect(pending).rejects.toBeDefined()
    const disposed = vi.fn<() => void>()
    class LateChild extends TestChildTarget {
      [Symbol.dispose]() { disposed() }
    }
    result.resolve(new LateChild('late'))
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce())
    await act(async () => render(false))
    expect(write).toHaveBeenCalledOnce()
  })

  it('lays out gadget UI against the device-width viewport', async () => {
    const gadget = fakeGadget('responsive', 'document.body.textContent = "responsive"')
    await act(async () => {
      root.render(<GadgetUI gadget={gadget.stub} height="100px" />)
    })

    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    expect(container.querySelector('iframe')!.srcdoc).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    )
  })

  it('keeps the iframe while redirecting calls to the replacement gadget client', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const firstIframe = container.querySelector('iframe')!
    const firstChild = connectIframe(firstIframe)
    await expect(firstChild.read()).resolves.toBe('first')
    await expect((firstChild as any).child().read()).resolves.toBe('first')

    const replacement = fakeGadget(
      'replacement',
      'document.body.textContent = "replacement"',
    )
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })

    await vi.waitFor(() => expect(replacement.connectToGadget).toHaveBeenCalledOnce())
    expect(container.querySelector('iframe')).toBe(firstIframe)
    await expect(firstChild.read()).resolves.toBe('replacement')
    await expect((firstChild as any).child().read()).resolves.toBe('replacement')
  })

  it('fails calls fast while replacement is pending and never replays them', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')

    const connection = deferred<RpcStub<TestGadget>>()
    const replacement = fakeGadget(
      'replacement',
      'document.body.textContent = "replacement"',
      vi.fn(() => connection.promise),
    )
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(replacement.connectToGadget).toHaveBeenCalledOnce())

    const read = child.read()
    await expect(read).rejects.toThrow('not dispatched')
    const replacementStub = new RpcStub(
      new TestGadgetTarget('replacement'),
    ) as unknown as RpcStub<TestGadget>
    connection.resolve(replacementStub)

    await expect(child.read()).resolves.toBe('replacement')
    expect(container.querySelector('iframe')).toBe(iframe)
  })

  it('keeps visible gadget edits until a pending code reload is accepted', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" reloadTrigger={0} />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')

    const connection = deferred<RpcStub<TestGadget>>()
    const connectToGadget = vi.fn<() => Promise<RpcStub<TestGadget>>>()
      .mockReturnValueOnce(connection.promise)
      .mockResolvedValueOnce(
        new RpcStub(new TestGadgetTarget('reloaded')) as unknown as RpcStub<TestGadget>,
      )
    const replacement = fakeGadget('replacement', 'unused', connectToGadget)
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" reloadTrigger={0} />)
    })
    const read = child.read()
    await expect(read).rejects.toThrow('not dispatched')

    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" reloadTrigger={1} />)
    })
    expect(container.querySelector('iframe')).toBe(iframe)
    expect(container.textContent).toContain('Reload when ready')

    await act(async () => {
      Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Reload when ready')!.click()
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBe(iframe))
    const reloadedChild = connectIframe(container.querySelector('iframe')!)
    await expect(read).rejects.toBeDefined()
    await expect(reloadedChild.read()).resolves.toBe('reloaded')
  })

  it('keeps a hidden loaded iframe until a pending code reload is accepted', async () => {
    const gadget = fakeGadget('first', 'document.body.textContent = "first"')
    gadget.getUiBundle
      .mockResolvedValueOnce({ jsCode: 'document.body.textContent = "first"' })
      .mockResolvedValueOnce({ jsCode: 'document.body.textContent = "updated"' })
    await act(async () => {
      root.render(<GadgetUI gadget={gadget.stub} height="100px" reloadTrigger={0} />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    expect(iframe.srcdoc).toContain('first')

    await act(async () => {
      root.render(<GadgetUI gadget={gadget.stub} height="100px" reloadTrigger={1} isVisible={false} />)
    })
    expect(container.querySelector('iframe')).toBe(iframe)
    expect(gadget.getUiBundle).toHaveBeenCalledOnce()

    await act(async () => {
      root.render(<GadgetUI gadget={gadget.stub} height="100px" reloadTrigger={1} isVisible />)
    })
    expect(container.querySelector('iframe')).toBe(iframe)
    expect(container.textContent).toContain('Reload when ready')

    await act(async () => {
      container.querySelector('button')!.click()
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBe(iframe))
    expect(container.querySelector('iframe')?.srcdoc).toContain('updated')
  })

  it('re-subscribes disposed callbacks without restoring an intentional unsubscribe', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    const values: string[] = []
    let callbacks: TestCallbacks | undefined
    let subscription: RpcStub<TestSubscription> | undefined
    let subscribeCount = 0
    const subscribe = async () => {
      callbacks = new TestCallbacks(values, () => void subscribe())
      subscription = await child.subscribe(callbacks) as unknown as RpcStub<TestSubscription>
      subscribeCount++
    }
    await subscribe()
    expect(values).toEqual(['first'])

    const replacement = fakeGadget('replacement', 'unused')
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(values).toEqual(['first', 'replacement']))
    expect(container.querySelector('iframe')).toBe(iframe)

    callbacks!.closed = true
    subscription![Symbol.dispose]()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(subscribeCount).toBe(2)
  })

  it('preserves the document beyond five seconds and accepts a slow replacement', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')

    const connection = deferred<RpcStub<TestGadget>>()
    const replacement = fakeGadget('replacement', 'unused', vi.fn(() => connection.promise))
    vi.useFakeTimers()
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    expect(replacement.connectToGadget).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(6_200))
    vi.useRealTimers()
    await expect(child.read()).rejects.toThrow('not dispatched')
    expect(container.querySelector('iframe')).toBe(iframe)

    const disposed = vi.fn<() => void>()
    connection.resolve(
      new RpcStub(new TestGadgetTarget('late', disposed)) as unknown as RpcStub<TestGadget>,
    )
    await connection.promise
    await expect(child.read()).resolves.toBe('late')
    expect(disposed).not.toHaveBeenCalled()
  })

  it('ignores a superseded replacement connection', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')

    const staleConnection = deferred<RpcStub<TestGadget>>()
    const stale = fakeGadget('stale', 'unused', vi.fn(() => staleConnection.promise))
    await act(async () => root.render(<GadgetUI gadget={stale.stub} height="100px" />))
    await vi.waitFor(() => expect(stale.connectToGadget).toHaveBeenCalledOnce())

    const current = fakeGadget('current', 'unused')
    await act(async () => root.render(<GadgetUI gadget={current.stub} height="100px" />))
    await vi.waitFor(() => expect(current.connectToGadget).toHaveBeenCalledOnce())
    await expect(child.read()).resolves.toBe('current')

    const disposed = vi.fn<() => void>()
    staleConnection.resolve(
      new RpcStub(new TestGadgetTarget('stale', disposed)) as unknown as RpcStub<TestGadget>,
    )
    await staleConnection.promise
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce())
    expect(container.querySelector('iframe')).toBe(iframe)
    await expect(child.read()).resolves.toBe('current')
  })

  it('ignores an old bundle that resolves after the gadget client is replaced', async () => {
    const oldBundle = deferred<UiBundle>()
    const first = fakeGadget('first', 'unused')
    first.getUiBundle.mockReturnValue(oldBundle.promise)
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })

    const replacement = fakeGadget(
      'replacement',
      'document.body.textContent = "replacement"',
    )
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    await vi.waitFor(() => {
      expect(container.querySelector('iframe')?.srcdoc).toContain('replacement')
    })

    await act(async () => {
      oldBundle.resolve({ jsCode: 'document.body.textContent = "stale"' })
      await oldBundle.promise
    })

    expect(container.querySelector('iframe')?.srcdoc).toContain('replacement')
    expect(container.querySelector('iframe')?.srcdoc).not.toContain('stale')
  })

  it('ignores an old bundle while its replacement is hidden', async () => {
    const oldBundle = deferred<UiBundle>()
    const first = fakeGadget('first', 'unused')
    first.getUiBundle.mockReturnValue(oldBundle.promise)
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })

    const replacement = fakeGadget(
      'replacement',
      'document.body.textContent = "replacement"',
    )
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" isVisible={false} />)
    })
    expect(replacement.getUiBundle).not.toHaveBeenCalled()

    await act(async () => {
      oldBundle.resolve({ jsCode: 'document.body.textContent = "stale"' })
      await oldBundle.promise
    })

    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" isVisible />)
    })
    await vi.waitFor(() => {
      expect(replacement.getUiBundle).toHaveBeenCalledOnce()
      expect(container.querySelector('iframe')?.srcdoc).toContain('replacement')
    })
    expect(container.querySelector('iframe')?.srcdoc).not.toContain('stale')
  })

  it('disposes a connection that resolves after the gadget client is replaced', async () => {
    const oldConnection = deferred<RpcStub<TestGadget>>()
    const first = fakeGadget(
      'first',
      'document.body.textContent = "first"',
      vi.fn(() => oldConnection.promise),
    )
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const firstIframe = container.querySelector('iframe')!
    const child = connectIframe(firstIframe)

    const replacement = fakeGadget(
      'replacement',
      'document.body.textContent = "replacement"',
    )
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    expect(container.querySelector('iframe')).toBe(firstIframe)

    const disposed = vi.fn<() => void>()
    await act(async () => {
      oldConnection.resolve(
        new RpcStub(new TestGadgetTarget('stale', disposed)) as unknown as RpcStub<TestGadget>,
      )
      await oldConnection.promise
    })
    expect(disposed).toHaveBeenCalledOnce()

    await expect(child.read()).resolves.toBe('replacement')
  })

  it('ignores a handshake rejection from an iframe that was reloaded', async () => {
    const oldConnection = deferred<RpcStub<TestGadget>>()
    const connectToGadget = vi.fn<() => Promise<RpcStub<TestGadget>>>()
      .mockReturnValueOnce(oldConnection.promise)
      .mockResolvedValueOnce(
        new RpcStub(new TestGadgetTarget('reloaded')) as unknown as RpcStub<TestGadget>,
      )
    const gadget = fakeGadget(
      'initial',
      'document.body.textContent = "bundle"',
      connectToGadget,
    )
    await act(async () => {
      root.render(<GadgetUI gadget={gadget.stub} height="100px" reloadTrigger={0} />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const oldIframe = container.querySelector('iframe')!
    dispatchIframeHandshake(oldIframe, new MessageChannel().port2)

    await act(async () => {
      root.render(<GadgetUI gadget={gadget.stub} height="100px" reloadTrigger={1} />)
    })
    expect(container.querySelector('iframe')).toBe(oldIframe)

    await act(async () => {
      Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Reload when ready')!.click()
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBe(oldIframe))

    await act(async () => {
      oldConnection.reject(new Error('old connection lost'))
      await oldConnection.promise.catch(() => {})
    })
    expect(container.querySelector('iframe')).not.toBeNull()

    const reloadedChild = connectIframe(container.querySelector('iframe')!)
    await expect(reloadedChild.read()).resolves.toBe('reloaded')
  })
})
