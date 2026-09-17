// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { Activity, act } from 'react'
import { createRoot } from 'react-dom/client'
import { RpcStub, RpcTarget, newMessagePortRpcSession } from 'capnweb'
import type { ResourceConfiguratorIframe } from '@gadgets/workshop-shared/gatekeeper'
// Like rpcErrors.test.ts, this runs in Node but src/ deliberately has browser-only types.
// @ts-expect-error node builtin without @types/node
import { createRequire } from 'node:module'
// @ts-expect-error node builtin without @types/node
import { execFile } from 'node:child_process'
// @ts-expect-error node builtin without @types/node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
// @ts-expect-error node builtin without @types/node
import { tmpdir } from 'node:os'
// @ts-expect-error node builtin without @types/node
import { join, resolve as resolvePath } from 'node:path'
// @ts-expect-error node builtin without @types/node
import { promisify } from 'node:util'
// @ts-expect-error node builtin without @types/node
import process from 'node:process'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import SandboxedResourceConfigurator from './SandboxedResourceConfigurator'

// jsdom's runtime is already a frontend test dependency; keep the small harness boundary local
// rather than adding a production dependency on its optional declaration package.
const { JSDOM } = createRequire(resolvePath('package.json'))('jsdom') as {
  JSDOM: new (html: string, options: { runScripts: 'outside-only'; pretendToBeVisual: boolean }) => {
    window: Window & typeof globalThis
  }
}

vi.mock('./ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))
vi.mock('./errorReporting', () => ({ forwardTrustedFrameError: () => false }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let fixture: string
let html: string
let runtime: string
let capnweb: string
beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'configurator-startup-'))
  await mkdir(join(fixture, 'src/configurator'), { recursive: true })
  await mkdir(join(fixture, 'node_modules/capnweb/dist'), { recursive: true })
  capnweb = await readFile(resolvePath('node_modules/capnweb/dist/index.js'), 'utf8')
  await writeFile(join(fixture, 'node_modules/capnweb/dist/index.js'), capnweb)
  await writeFile(join(fixture, 'src/configurator/test.tsx'), `
    import { h, TextInput } from '@gadgets/configurator-ui';
    export default {
      initial: { resource: 'default' },
      async initialValuesFromResourceUrl({ resourceUrl, ui }) {
        globalThis.bootstrapAttempts = (globalThis.bootstrapAttempts || 0) + 1;
        return { resource: await ui.resolveResource(resourceUrl) };
      },
      resourceUrl: ({ values }) => values.resource,
      render({ values, setValues, ui }) {
        return <div><TextInput name="resource" value={values.resource}
          onChange={resource => setValues({ resource })} />
          <button onClick={() => ui.write().catch(() => {})}>Write</button></div>;
      }
    };
  `)
  await promisify(execFile)(process.execPath, [
    resolvePath('../../scripts/build-gatekeeper-configurator.ts'), fixture,
  ], { env: { ...process.env, VITE_FRONTEND_ERROR_REPORTING: 'false' } })
  html = await readFile(join(fixture, 'src/generated/test.txt'), 'utf8')
  const script = html.match(/<script type="module" src="data:text\/javascript;charset=utf-8,([^"]+)"/)
  if (!script) throw new Error('Missing generated runtime')
  runtime = decodeURIComponent(script[1]).replace(/^import .*;$/gm, '')
})
afterAll(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }) })

function startGeneratedRuntime(app: InstanceType<typeof JSDOM>, postMessage: (data: unknown, origin: string, ports: MessagePort[]) => void) {
  // Node MessagePorts deserialize into Node's realm. A browser deserializes into the receiving
  // frame's realm; reconstruct this fixture's JSON-shaped RPC envelopes there for parity.
  class FrameMessageChannel {
    readonly port1
    readonly port2
    constructor() {
      const channel = new MessageChannel()
      this.port2 = channel.port2
      this.port1 = {
        start: () => channel.port1.start(), close: () => channel.port1.close(),
        postMessage: (data: unknown) => channel.port1.postMessage(data),
        addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
          channel.port1.addEventListener(type, event => {
            const data = 'data' in event ? event.data : undefined
            listener({ data: data === undefined ? undefined : app.window.JSON.parse(JSON.stringify(data)) })
          })
        },
      }
    }
  }
  Object.assign(app.window, { MessageChannel: FrameMessageChannel, ReadableStream, WritableStream, TransformStream, TextEncoder, TextDecoder, Request, Response, Headers,
    ResizeObserver: class { observe() {} disconnect() {} } })
  Object.defineProperty(app.window, 'parent', { value: { postMessage } })
  // Execute the ENTIRE generated startup and actual bundled RPC implementation in the frame's
  // realm. JSDOM cannot import data-URL modules, so only the module wrappers are removed.
  const evaluate = new app.window.Function(capnweb.replace(/^export .*;$/gm, '') + '\n' + runtime)
  evaluate()
}

it.each(['hidden handshake', 'interrupted read'] as const)('generated startup preserves the requested seed after %s and never reseeds edits or replays writes', async scenario => {
  const reads = vi.fn<(url: string) => Promise<string>>(async url => url)
  const writes = vi.fn<() => Promise<void>>(() => new Promise(() => {}))
  let finishOld: ((value: string) => void) | undefined
  if (scenario === 'interrupted read') reads.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
  class Backend extends RpcTarget {
    resolveResource(url: string) { return reads(url) }
    write() { return writes() }
  }
  const backend = new RpcStub(new Backend())
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const requested = 'https://example.com/items/42'
  const frame = { iframeHtml: html, ui: backend }
  const render = (hidden: boolean) => <Activity mode={hidden ? 'hidden' : 'visible'}>
    <SandboxedResourceConfigurator frame={frame} resourceIdentity="owner/account/resource"
      initialResourceUrl={requested} resourceUrlPattern="https://example.com/items/:id" />
  </Activity>
  const app = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true })
  try {
    await act(async () => root.render(render(false)))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
    const iframe = document.querySelector('iframe')!
    const source = iframe.contentWindow
    if (scenario === 'hidden handshake') await act(async () => root.render(render(true)))
    startGeneratedRuntime(app, (data, _origin, ports) => {
      window.dispatchEvent(new MessageEvent('message', { data, origin: 'null', source, ports }))
    })
    await vi.waitFor(() => {
      expect(app.window.document.querySelector('.error')?.textContent).toBeUndefined()
      expect(reads).toHaveBeenCalledTimes(scenario === 'hidden handshake' ? 0 : 1)
    })
    if (scenario === 'interrupted read') await act(async () => root.render(render(true)))
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(reads).toHaveBeenCalledTimes(scenario === 'hidden handshake' ? 0 : 1)
    expect(app.window.document.querySelector('input')).toBeNull()
    expect(writes).not.toHaveBeenCalled()
    await act(async () => root.render(render(false)))
    await vi.waitFor(() => {
      expect(app.window.document.querySelector('.error')?.textContent).toBeUndefined()
      expect(app.window.document.querySelector('input')?.value).toBe(requested)
    })
    const expectedReads = scenario === 'hidden handshake' ? 1 : 2
    expect(reads).toHaveBeenCalledTimes(expectedReads)
    const input = app.window.document.querySelector('input')!
    input.value = 'user edit'
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }))
    app.window.document.querySelector('button')!.click()
    await vi.waitFor(() => expect(writes).toHaveBeenCalledOnce())
    await act(async () => root.render(render(true)))
    finishOld?.('late obsolete seed')
    await act(async () => root.render(render(false)))
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(app.window.document.querySelector('input')?.value).toBe('user edit')
    expect(Reflect.get(app.window, 'bootstrapAttempts')).toBe(expectedReads)
    expect(reads).toHaveBeenCalledTimes(expectedReads)
    expect(writes).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    app.window.close(); backend[Symbol.dispose](); container.remove()
  }
})

it('new generated runtime seeds through a real legacy host with no readiness methods', async () => {
  const requested = 'https://example.com/items/legacy'
  const reads = vi.fn<(url: string) => string>(url => url)
  const initial = vi.fn<() => { resourceUrl: string; resourceUrlPattern: string }>(() => ({
    resourceUrl: requested, resourceUrlPattern: 'https://example.com/items/:id',
  }))
  class Backend extends RpcTarget { resolveResource(url: string) { return reads(url) } }
  // The old public host surface, without awaitReady/isReady. Missing-method errors come from
  // Cap'n Web itself, not a mock that manufactures the error the implementation expects.
  class LegacyHost extends RpcTarget {
    get gatekeeper() { return new Backend() }
    getInitialResource() { return initial() }
    resize() {}
    setSelectionReady() {}
    forwardScroll() {}
  }
  const app = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true })
  let session: RpcStub<ResourceConfiguratorIframe> | undefined
  try {
    startGeneratedRuntime(app, (_data, _origin, ports) => {
      session = newMessagePortRpcSession<ResourceConfiguratorIframe>(ports[0], new LegacyHost())
    })
    await vi.waitFor(() => {
      expect(app.window.document.querySelector('.error')?.textContent).toBeUndefined()
      expect(app.window.document.querySelector('input')?.value).toBe(requested)
    })
    expect(initial).toHaveBeenCalledOnce()
    expect(reads).toHaveBeenCalledExactlyOnceWith(requested)
    await expect(session!.collectResourceUrl()).resolves.toBe(requested)
    const input = app.window.document.querySelector('input')!
    input.value = 'edited legacy value'
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }))
    await expect(session!.collectResourceUrl()).resolves.toBe('edited legacy value')
    expect(initial).toHaveBeenCalledOnce()
  } finally {
    app.window.close(); session?.[Symbol.dispose]()
  }
})

it.each(['authority rejection', 'near-miss TypeError', 'wrong error type', 'terminal close', 'established protocol', 'missing isReady'] as const)(
  'new generated runtime never downgrades on %s', async scenario => {
    const initial = vi.fn<() => { resourceUrl: string; resourceUrlPattern: string }>(() => ({
      resourceUrl: 'https://example.com/items/42', resourceUrlPattern: 'https://example.com/items/:id',
    }))
    class Backend extends RpcTarget { resolveResource(url: string) { return url } }
    let probes = 0
    class Host extends RpcTarget {
      get gatekeeper() { return new Backend() }
      getInitialResource() { return initial() }
      awaitReady() {
        probes++
        if ((scenario === 'established protocol' && probes === 1) || scenario === 'missing isReady') return 0
        if (scenario === 'established protocol') throw new TypeError("'awaitReady' is not a function.")
        if (scenario === 'near-miss TypeError') throw new TypeError('awaitReady is not a function')
        if (scenario === 'wrong error type') throw new Error("'awaitReady' is not a function.")
        throw new Error('Configurator is no longer available.')
      }
      isReady() {
        if (scenario === 'missing isReady') throw new TypeError("'isReady' is not a function.")
        return false
      }
      resize() {}
    }
    const app = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true })
    let session: RpcStub<ResourceConfiguratorIframe> | undefined
    try {
      startGeneratedRuntime(app, (_data, _origin, ports) => {
        session = newMessagePortRpcSession<ResourceConfiguratorIframe>(ports[0], new Host())
        if (scenario === 'terminal close') session[Symbol.dispose]()
      })
      await vi.waitFor(() => expect(app.window.document.querySelector('.error')?.textContent).toMatch(/not a function|no longer available|closed|dispos/i))
      expect(app.window.document.querySelector('input')).toBeNull()
      expect(initial).toHaveBeenCalledTimes(scenario === 'established protocol' || scenario === 'missing isReady' ? 1 : 0)
    } finally {
      app.window.close(); session?.[Symbol.dispose]()
    }
  },
)
