// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { Activity, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { CodeChangeSubmission } from '@gadgets/workshop-shared/api'
import { ChatOtClient, type ChatOtClientDelegate } from './features/code/otClient'
import { RecoveryControls, RecoveryProvider, RecoveryWorkspace, useRecoverySource } from './Recovery'
import {
  createRecoveryBundle, recoveryBundleHtml, recoveryComposerText,
  type ComposerRecovery, type EditorRecovery, type RecoveryBundle,
} from './recoveryBundle'

const mocks = vi.hoisted(() => ({ saveBlob: vi.fn<() => Promise<void>>() }))
vi.mock('./runtime', () => ({ getWorkshopRuntime: () => ({ saveBlob: mocks.saveBlob }) }))

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
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 5))

// A real OT client whose submission never settles: the state the export exists for.
function unacknowledgedClient(): { client: ChatOtClient; submissions: CodeChangeSubmission[] } {
  const submissions: CodeChangeSubmission[] = []
  const delegate: ChatOtClientDelegate = {
    fetchFilesAtCommit: async () => new Map(),
    submitCodeChange: submission => {
      submissions.push(submission)
      return new Promise(() => {})
    },
    isTransientError: () => false,
    onRemoteChange: () => {},
    onLocalEditsDiscarded: () => {},
    onDirtyState: () => {},
    onFatalError: () => {},
  }
  return { client: new ChatOtClient(delegate), submissions }
}

it("exports the OT client's own unacknowledged text, including while the editor is hidden", async () => {
  const { client, submissions } = unacknowledgedClient()
  client.setDurableState({ rowsThrough: 0 })
  client.setPendingCreations(new Set([1]))
  await flush()
  client.applyLocalChange({ 1: [['client.js', { set: 'local unacknowledged' }]] })
  await flush()
  expect(submissions).toHaveLength(1)

  // The real interface registers this source below its own visibility gate, so a hidden Files
  // pane must still capture. Activity hiding is covered separately, below.
  function Editor() {
    useRecoverySource('editor', (): EditorRecovery => ({
      kind: 'editor', chatId: 42, branch: { kind: 'chat', chatId: 42 },
      sending: client.hasLocalEdits(), code: client.captureRecovery(),
    }))
    return null
  }
  await act(async () => root.render(<RecoveryProvider>
    <RecoveryControls workspaceId="workspace" />
    <Editor />
  </RecoveryProvider>))
  await click('Capture recovery snapshot')

  const source = snapshot().sources[0]
  if (source.kind !== 'editor') throw new Error('missing editor source')
  expect(source.sending).toBe(true)
  expect(source.branch).toEqual({ kind: 'chat', chatId: 42 })
  expect(source.code?.acknowledgement).toBe('unconfirmed')
  expect(source.code?.files).toEqual([{ gadgetId: 1, path: 'client.js', text: 'local unacknowledged' }])
  expect(submissions).toHaveLength(1) // capture never resubmits
  client.dispose()
})

it('reports a clean editor as nothing to recover rather than inventing a copy', async () => {
  const { client } = unacknowledgedClient()
  client.setDurableState({ rowsThrough: 0 })
  await flush()
  expect(client.hasLocalEdits()).toBe(false)
  expect(client.captureRecovery()).toBeNull()
  client.dispose()
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

it('renders hostile paths/drafts as inert text in a standalone offline viewer and retains exact JSON', () => {
  const text = '</pre><script>alert(1)</script><img src="https://example.com">\r\n\u0000 & 😀'
  const bundle = createRecoveryBundle('workspace', [
    { kind: 'composer', chatId: null, text, sending: false, attachments: [], omittedCapsules: 0 },
    {
      kind: 'editor', chatId: null, branch: { kind: 'mainline', chatId: null }, sending: false,
      code: {
        version: 1, generation: 0, revision: 0, clientId: 'client', seq: 0,
        acknowledgement: 'unconfirmed', bases: [], omittedBases: 0,
        files: [{ gadgetId: 1, path: '<img src=x onerror=alert(1)>', text }], omitted: 0,
      },
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
