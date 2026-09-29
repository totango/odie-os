// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { Activity, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { CodeSubscriber } from '@gadgets/workshop-shared/api'
import { RecoveryControls, RecoveryProvider, RecoveryWorkspace, useRecoverySource } from './Recovery'
import GadgetCodeInterface from './GadgetCodeInterface'
import { createRecoveryBundle, recoveryBundleHtml, recoveryComposerText, type ComposerRecovery, type RecoveryBundle } from './recoveryBundle'

const mocks = vi.hoisted(() => ({ text: null as Y.Text | null, saveBlob: vi.fn<() => Promise<void>>() }))
vi.mock('./runtime', () => ({ getWorkshopRuntime: () => ({ saveBlob: mocks.saveBlob }) }))
vi.mock('@cloudflare/kumo', () => ({ useKumoToastManager: () => ({ add: () => {} }) }))
vi.mock('./FileSidebar', () => ({ default: () => null }))
vi.mock('./components/WorkshopControls', () => ({ WorkshopButton: () => null, WorkshopIconButton: () => null }))
vi.mock('./CodeEditor', () => ({ default: ({ ytext }: { ytext: Y.Text }) => { mocks.text = ytext; return null } }))
vi.mock('./CodeDiffEditor', () => ({ default: ({ modifiedYText }: { modifiedYText: Y.Text }) => { mocks.text = modifiedYText; return null } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const container = document.createElement('div')
let root = createRoot(container)
afterEach(async () => {
  await act(async () => root.unmount())
  root = createRoot(container)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  mocks.saveBlob.mockReset()
})
const click = async (label: string) => {
  const button = Array.from(container.querySelectorAll('button')).find(el => el.textContent === label)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
const snapshot = (): RecoveryBundle => JSON.parse(container.querySelector('textarea')!.value)

it('captures materialized branch edits while updateCode is unresolved, including while Files is hidden', async () => {
  const doc = new Y.Doc()
  doc.getMap<Y.Text>('files').set('client.js', new Y.Text('base'))
  doc.getMap<Y.Text>('files').set('untouched.txt', new Y.Text('full text'))
  let resolve!: () => void
  const updateCode = vi.fn<() => Promise<void>>(() => new Promise<void>(r => { resolve = r }))
  const overseer = {
    subscribeToCode: async (subscriber: CodeSubscriber) => {
      subscriber.update({ update: Y.encodeStateAsUpdateV2(doc), version: 7, timestamp: new Date() })
      subscriber.ready()
      return { [Symbol.dispose]() {} }
    }, updateCode,
  }
  const render = async (visible: boolean) => {
    await act(async () => root.render(<RecoveryProvider>
      <RecoveryControls workspaceId="workspace" />
      <GadgetCodeInterface overseer={overseer as never} filesRoot="files" selectedChatId={42} isAgentActive={false} isVisible={visible} />
    </RecoveryProvider>))
  }
  await render(true)
  await act(async () => { mocks.text!.insert(4, ' local unacknowledged') })
  expect(updateCode).toHaveBeenCalledTimes(1)
  await render(false)
  await click('Capture recovery snapshot')
  const source = snapshot().sources[0]
  expect(source.kind).toBe('editor')
  if (source.kind !== 'editor') throw new Error('missing editor')
  expect(source.sending).toBe(true)
  expect(source.unacknowledged).toEqual([{ chatId: 42, bytes: expect.any(Number) }])
  expect(source.lastObservedServerVersion).toBe(7)
  expect(source.branch).toEqual({ kind: 'chat', chatId: 42 })
  const branch = source.layers.find(layer => layer.name === 'editable-branch')!
  expect(branch.files).toEqual([{ name: 'client.js', text: 'base local unacknowledged' }, { name: 'untouched.txt', text: 'full text' }])
  expect(branch.localStateVector.length).toBeGreaterThan(0)
  expect(updateCode).toHaveBeenCalledTimes(1) // capture never replays
  await act(async () => resolve())
  expect(snapshot().sources[0]).toEqual(source) // the captured snapshot cannot silently change
  await click('Capture recovery snapshot')
  expect(snapshot().sources[0]).toMatchObject({ sending: false, unacknowledged: [] })
  doc.destroy()
})

it('works without storage/network and preserves a copyable snapshot after download rejection', async () => {
  vi.stubGlobal('sessionStorage', { getItem() { throw new Error('disabled') }, setItem() { throw new Error('disabled') } })
  vi.stubGlobal('localStorage', { getItem() { throw new Error('disabled') }, setItem() { throw new Error('disabled') } })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('offline') }))
  mocks.saveBlob.mockRejectedValue(new Error('unavailable'))
  await act(async () => root.render(<RecoveryControls capture={() => ({
    kind: 'composer', chatId: 3, text: 'unsent text', sending: true, omittedCapsules: 0,
    attachments: [{ name: 'notes.pdf', mimeType: 'application/pdf', bytes: 42, state: 'uploading', omitted: true }],
  })} />))
  await click('Capture recovery snapshot')
  await click('Download offline recovery bundle')
  expect(container.textContent).toContain('Download failed')
  expect(snapshot().sources[0]).toMatchObject({ text: 'unsent text', sending: true })
  expect(fetch).not.toHaveBeenCalled()
})

it('renders hostile filenames/drafts as inert text in a standalone offline viewer and retains exact JSON', () => {
  const text = '</pre><script>alert(1)</script><img src="https://example.com">\r\n\u0000 & 😀'
  const bundle = createRecoveryBundle('workspace', [
    { kind: 'composer', chatId: null, text, sending: false, attachments: [], omittedCapsules: 0 },
    {
      kind: 'editor', chatId: null, branch: { kind: 'mainline', chatId: null }, filesRoot: 'files',
      initialSyncReached: false, lastObservedServerVersion: 0, sending: false, unacknowledged: [],
      layers: [{ name: 'mainline', files: [{ name: '<img src=x onerror=alert(1)>', text }], localStateVector: [] }],
    },
  ])
  const document = new DOMParser().parseFromString(recoveryBundleHtml(bundle), 'text/html')
  expect(document.querySelector('script,img,iframe,a')).toBeNull()
  expect(document.querySelector('meta[http-equiv]')?.getAttribute('content')).toContain("default-src 'none'")
  const json = Array.from(document.querySelectorAll('pre')).at(-1)!.textContent!
  expect(JSON.parse(json)).toEqual(bundle)
  expect(recoveryComposerText('before SECRET after', [{ start: 7, length: 6 }])).toBe('before [resource omitted; reconnect manually] after')
})

it('keeps a value-only snapshot outside paused Activity, but clears it when route/identity scope changes', async () => {
  const capture = vi.fn<() => ComposerRecovery>(() => ({ kind: 'composer', chatId: 5, text: 'before pause', sending: false, attachments: [], omittedCapsules: 0 }))
  function Source() { useRecoverySource('composer', capture); return null }
  const render = async (mode: 'hidden' | 'visible', scope = 'a') => {
    await act(async () => root.render(<RecoveryProvider scope={scope}>
      <RecoveryControls key={scope} />
      <Activity mode={mode}><RecoveryWorkspace workspaceId="workspace"><Source /></RecoveryWorkspace></Activity>
    </RecoveryProvider>))
  }
  await render('visible')
  await render('hidden')
  const callsAfterPause = capture.mock.calls.length
  await click('Capture recovery snapshot')
  expect(capture).toHaveBeenCalledTimes(callsAfterPause)
  expect(snapshot().sources[0]).toMatchObject({ workspaceId: 'workspace', text: 'before pause', retainedAfterPause: true })
  await render('hidden', 'other-owner-or-route')
  expect(container.querySelector('textarea')).toBeNull()
  await click('Capture recovery snapshot')
  expect(snapshot().sources).toEqual([])
})
