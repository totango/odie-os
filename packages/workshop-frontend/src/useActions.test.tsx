// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { Activity, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ActionsSubscriber, Overseer, ActionLogEntry } from '@gadgets/workshop-shared/api'
import { useActions } from './useActions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('action subscription generations', () => {
  let root: Root
  let container: HTMLDivElement
  afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.restoreAllMocks() })

  async function mount(api: RpcStub<Overseer>) {
    function Probe() {
      const state = useActions(api)
      return <p>{state.error ? 'failed' : state.isReady ? 'ready' : 'waiting'}:{state.actionsById.size}</p>
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
    const api = { subscribeToActions: async () => { throw new Error('offline') } } as unknown as RpcStub<Overseer>
    await mount(api)
    expect(container.textContent).toBe('failed:0')
  })

  it('ignores late callbacks and resubscribes on same-stub Activity reveal', async () => {
    const subscribers: ActionsSubscriber[] = []
    const dispose = vi.fn<() => void>()
    const api = { subscribeToActions: async (subscriber: ActionsSubscriber) => {
      subscribers.push(subscriber)
      return { [Symbol.dispose]: dispose }
    } } as unknown as RpcStub<Overseer>
    const render = await mount(api)
    await act(async () => subscribers[0].ready())
    expect(container.textContent).toBe('ready:0')
    await render('hidden')
    expect(dispose).toHaveBeenCalledOnce()
    await render('visible')
    expect(subscribers).toHaveLength(2)
    expect(container.textContent).toBe('waiting:0')
    await act(async () => {
      subscribers[0].entry({ id: 1 } as ActionLogEntry)
      subscribers[0].ready()
    })
    expect(container.textContent).toBe('waiting:0')
    await act(async () => subscribers[1].ready())
    expect(container.textContent).toBe('ready:0')
  })
})
