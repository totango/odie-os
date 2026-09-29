// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { Activity, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ActionsSubscriber, Overseer, ActionHistoryPage } from '@gadgets/workshop-shared/api'
import { useActions } from './useActions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('action subscription generations with paged pending state', () => {
  let root: Root
  let container: HTMLDivElement
  afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.restoreAllMocks() })

  async function mount(api: RpcStub<Overseer>) {
    function Probe() {
      const state = useActions(api)
      return <p>{state.status}:{state.pending.length}</p>
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const render = async (mode: 'hidden' | 'visible') => {
      await act(async () => root.render(<Activity mode={mode}><Probe /></Activity>))
    }
    await render('visible')
    return render
  }

  it('reports subscription failure separately from readiness', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const api = { subscribeToActions: async () => { throw new Error('offline') },
      listActions: async () => ({ entries: [] }) } as unknown as RpcStub<Overseer>
    await mount(api)
    expect(container.textContent).toBe('error:0')
  })

  it('revokes late entries after failure and disposes a late subscription result', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let subscriber!: ActionsSubscriber
    let resolve!: (subscription: Disposable) => void
    const disposed = vi.fn<() => void>()
    const api = { subscribeToActions: (next: ActionsSubscriber) => {
      subscriber = next
      return new Promise<Disposable>(done => { resolve = done })
    }, listActions: async () => { throw new Error('page failure') } } as unknown as RpcStub<Overseer>
    await mount(api)
    expect(container.textContent).toBe('error:0')
    await act(async () => {
      subscriber.entry({ id: 1 } as never)
      resolve({ [Symbol.dispose]: disposed })
    })
    expect(container.textContent).toBe('error:0')
    expect(disposed).toHaveBeenCalledOnce()
  })

  it('ignores late callbacks and resubscribes on same-stub Activity reveal', async () => {
    const subscribers: ActionsSubscriber[] = []
    const pages: ((page: ActionHistoryPage) => void)[] = []
    const dispose = vi.fn<() => void>()
    const api = { subscribeToActions: async (subscriber: ActionsSubscriber) => {
      subscribers.push(subscriber)
      return { [Symbol.dispose]: dispose }
    }, listActions: () => new Promise<ActionHistoryPage>(resolve => pages.push(resolve)) } as unknown as RpcStub<Overseer>
    const render = await mount(api)
    await act(async () => pages[0]({ entries: [] }))
    expect(container.textContent).toBe('ready:0')
    await render('hidden')
    expect(dispose).toHaveBeenCalledOnce()
    await render('visible')
    expect(subscribers).toHaveLength(2)
    expect(container.textContent).toBe('checking:0')
    await act(async () => {
      subscribers[0].entry({ id: 1 } as never)
      subscribers[0].ready()
    })
    expect(container.textContent).toBe('checking:0')
    await act(async () => pages[1]({ entries: [] }))
    expect(container.textContent).toBe('ready:0')
  })
})
