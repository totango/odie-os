// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { Activity, act, useEffect, useInsertionEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import type { GadgetClient } from '@gadgets/workshop-shared/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RetainedGadgetUI } from './GadgetUseView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { calls, failures } = vi.hoisted(() => ({ calls: vi.fn<(value: unknown) => void>(), failures: vi.fn<(error: unknown) => void>() }))
vi.mock('./GadgetUI', () => ({ default: ({ gadget }: { gadget: RpcStub<GadgetClient> }) => {
  useEffect(() => {
    void gadget.getUiBundle().then(calls, failures)
  }, [gadget])
  return <iframe title="retained document" sandbox="" />
} }))

describe('retained gadget capability seam', () => {
  let root: Root
  let container: HTMLDivElement
  afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.clearAllMocks() })

  it('keeps insertion lifetime across Activity suspension while disconnecting passive authority', async () => {
    const finalCleanup = vi.fn<() => void>()
    const suspend = vi.fn<() => void>()
    const resume = vi.fn<() => void>()
    function LifetimeProbe() {
      useInsertionEffect(() => finalCleanup, [])
      useEffect(() => { resume(); return suspend }, [])
      return <iframe title="lifetime probe" sandbox="" />
    }
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => root.render(<Activity mode="visible"><LifetimeProbe /></Activity>))
    const frame = container.querySelector('iframe')
    await act(async () => root.render(<Activity mode="hidden"><LifetimeProbe /></Activity>))
    expect(suspend).toHaveBeenCalledOnce()
    expect(finalCleanup).not.toHaveBeenCalled()
    await act(async () => root.render(<Activity mode="visible"><LifetimeProbe /></Activity>))
    expect(container.querySelector('iframe')).toBe(frame)
    expect(resume).toHaveBeenCalledTimes(2)
    expect(finalCleanup).not.toHaveBeenCalled()
    await act(async () => root.render(null))
    expect(finalCleanup).toHaveBeenCalledOnce()
  })

  it('retains the exact frame through a capability gap, but not an explicit gadget switch', async () => {
    class Gadget extends RpcTarget {
      getUiBundle() { return null }
    }
    const first = new RpcStub(new Gadget()) as unknown as RpcStub<GadgetClient>
    const second = new RpcStub(new Gadget()) as unknown as RpcStub<GadgetClient>
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<RetainedGadgetUI key="1" gadget={first} height="100%" />))
    const frame = container.querySelector('iframe')
    expect(frame).not.toBeNull()
    await act(async () => root.render(<RetainedGadgetUI key="1" gadget={null} height="100%" />))
    first[Symbol.dispose]()
    expect(container.querySelector('iframe')).toBe(frame)
    expect(frame!.closest('[style*="display: none"]')).not.toBeNull()
    await act(async () => root.render(<RetainedGadgetUI key="1" gadget={second} height="100%" />))
    expect(container.querySelector('iframe')).toBe(frame)
    expect(frame!.closest('[style*="display: none"]')).toBeNull()
    expect(calls).toHaveBeenCalledTimes(2)
    expect(failures).not.toHaveBeenCalled()
    await act(async () => root.render(<RetainedGadgetUI key="2" gadget={second} height="100%" />))
    expect(container.querySelector('iframe')).not.toBe(frame)
    second[Symbol.dispose]()
  })
})
