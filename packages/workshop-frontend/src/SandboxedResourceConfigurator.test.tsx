// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { Activity, act } from 'react'
import { createRoot } from 'react-dom/client'
import { newMessagePortRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { expect, it, vi } from 'vitest'
import SandboxedResourceConfigurator from './SandboxedResourceConfigurator'
import ResourceConfiguratorHost from './ResourceConfiguratorHost'

vi.mock('./ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))
vi.mock('./errorReporting', () => ({ forwardTrustedFrameError: () => false }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class Backend extends RpcTarget {
  constructor(private readonly label = 'account-resource') { super() }
  identify() { return this.label }
}
class Frame extends RpcTarget {
  updateViewport() {}
  windowResized() {}
  collectResourceUrl() { return 'resource:test' }
}
interface Host extends RpcTarget {
  gatekeeper: Backend
  setSelectionReady(ready: boolean): void
  getInitialResource(): Promise<unknown>
  onSelectionReady(ready: boolean): void
  awaitReady(): Promise<number>
  isReady(generation: number): boolean
}

it.each([false, true])('retains the configurator port and accepts a delayed first handshake while hidden (%s)', async (hiddenHandshake) => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const backend = new RpcStub(new Backend())
  const frame = { iframeHtml: '<p>configurator</p>', ui: backend }
  const ready = vi.fn<(ready: boolean | null) => void>()
  let collect: (() => Promise<string>) | null = null
  const onCollect = (value: (() => Promise<string>) | null) => { collect = value }
  const render = (hidden: boolean) => <Activity mode={hidden ? 'hidden' : 'visible'}>
    <SandboxedResourceConfigurator frame={frame} onSelectionReadyChange={ready} onCollectResourceUrlChange={onCollect} />
  </Activity>
  let host: RpcStub<Host> | undefined
  let cached: RpcStub<Backend> | undefined
  try {
    await act(async () => { root.render(render(false)); await new Promise(resolve => setTimeout(resolve, 40)) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
    const iframe = document.querySelector('iframe')!
    expect(iframe).not.toBeNull()
    const source = iframe.contentWindow
    if (hiddenHandshake) await act(async () => root.render(render(true)))
    const channel = new MessageChannel()
    host = newMessagePortRpcSession<Host>(channel.port1, new Frame())
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source, ports: [channel.port2] }))
    const initial = await host.getInitialResource().catch((error: Error) => error.message)
    expect(initial).toBe(hiddenHandshake ? 'Configurator is no longer available.' : null)
    if (hiddenHandshake) await act(async () => root.render(render(false)))
    cached = host.gatekeeper.dup()
    const generation = await host.awaitReady()
    await expect(cached.identify()).resolves.toBe('account-resource')
    await expect(host.onSelectionReady(true)).rejects.toThrow(/onSelectionReady/)
    const oldCollect = collect!
    await expect(oldCollect()).resolves.toBe('resource:test')
    await act(async () => root.render(render(true)))
    await expect(host.isReady(generation)).resolves.toBe(false)
    await expect(cached.identify()).rejects.toThrow('no longer available')
    await expect(host.setSelectionReady(true)).rejects.toThrow('no longer available')
    await expect(oldCollect()).rejects.toThrow('no longer available')
    await act(async () => root.render(render(false)))
    expect(document.querySelector('iframe')).toBe(iframe)
    await expect(cached.identify()).resolves.toBe('account-resource')
    await expect(oldCollect()).resolves.toBe('resource:test')
    await act(async () => root.render(render(true)))
    const waiters = Array.from({ length: 16 }, () => Promise.resolve(host!.awaitReady()).catch((error: Error) => error.message))
    await expect(host.awaitReady()).rejects.toThrow('Too many configurator readiness requests')
    await act(async () => root.unmount())
    const closed = await Promise.all(waiters)
    expect(closed).toHaveLength(16)
    for (const result of closed) expect(result).toMatch(/closed|dispos|no longer available/i)
    await expect(oldCollect()).rejects.toThrow('no longer available')
  } finally {
    await act(async () => root.unmount())
    cached?.[Symbol.dispose](); host?.[Symbol.dispose](); backend[Symbol.dispose]()
    container.remove()
  }
})

it('retains the caller slot through loading with a verified resource identity, but resets on account switch', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const first = new RpcStub(new Backend('first')); const second = new RpcStub(new Backend('second'))
  const original = { iframeHtml: '<p>configurator</p>', ui: first }
  const replacement = { iframeHtml: '<p>configurator v2</p>', ui: second }
  const render = (frame: typeof original | null, identity = 'owner/account-one/resource', loading = false, frameIdentity = identity) => <ResourceConfiguratorHost
    frame={frame} frameKey={frame === original ? 1 : 2} loading={loading} disabled={false} error={null} resourceIdentity={identity} frameIdentity={frameIdentity} />
  let host: RpcStub<Host> | undefined
  let cached: RpcStub<Backend> | undefined
  try {
    await act(async () => root.render(render(original)))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    const iframe = document.querySelector('iframe')!
    const channel = new MessageChannel(); host = newMessagePortRpcSession<Host>(channel.port1, new Frame())
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [channel.port2] }))
    cached = host.gatekeeper.dup()
    await expect(cached.identify()).resolves.toBe('first')
    await act(async () => root.render(render(null, 'owner/account-one/resource', true)))
    expect(document.querySelector('iframe')).toBe(iframe)
    await expect(cached.identify()).rejects.toThrow('no longer available')
    await act(async () => root.render(render(replacement)))
    expect(document.querySelector('iframe')).toBe(iframe)
    expect(iframe.srcdoc).toBe('<p>configurator</p>')
    expect(container.textContent).toContain('Reload when ready')
    await expect(cached.identify()).resolves.toBe('second')
    await act(async () => root.render(render(replacement, 'owner/account-two/resource', false, 'owner/account-one/resource')))
    expect(document.querySelector('iframe')).toBeNull()
    await act(async () => root.render(render(replacement, 'owner/account-two/resource')))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(document.querySelector('iframe')).not.toBe(iframe)
    await expect(cached.identify()).rejects.toThrow(/closed|disconnected|disposed/i)
  } finally {
    await act(async () => root.unmount())
    cached?.[Symbol.dispose](); host?.[Symbol.dispose](); first[Symbol.dispose](); second[Symbol.dispose](); container.remove()
  }
})
