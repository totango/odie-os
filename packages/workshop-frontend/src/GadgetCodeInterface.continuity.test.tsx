// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { Activity, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeChangeSubmission, Overseer } from '@gadgets/workshop-shared/api'
import type { ChatChangeRow } from './otClient'
import type { ChatCodeChanges, ChatLiveChangeRows } from './ChatInterface'
import { negotiateEditing } from './features/workspace/editingProtocol'
import GadgetCodeInterface from './GadgetCodeInterface'

vi.mock('./ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }));
vi.mock('@cloudflare/kumo', async original => ({ ...await original<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: () => {} }) }));
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const baseText = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
class Workspace extends RpcTarget {
  submissions: CodeChangeSubmission[] = []
  listeners = new Set<(row: ChatChangeRow) => void>()
  rows: ChatChangeRow[] = []
  lostAck = false
  commits = 0
  negotiateEditingProtocol() { return { protocol: 'git-ot-v1', state: 'ready' } }
  getEditingProtocol() { return this.negotiateEditingProtocol() }
  getCodeAtCommit() { return { files: [['notes.txt', baseText]] } }
  submitCodeChange(_chatId: number, submission: CodeChangeSubmission) {
    this.submissions.push(submission)
    const existing = this.rows.find(row => row.submission?.clientId === submission.clientId && row.submission.seq === submission.seq)
    if (existing) { this.emit(existing); return Promise.resolve({ generation: 0, revision: existing.revision }) }
    const row: ChatChangeRow = { generation: 0, revision: this.rows.length + 1, change: submission.change,
      author: { type: 'user', id: 'owner', name: 'Owner' }, submission: { clientId: submission.clientId, seq: submission.seq } }
    this.rows.push(row)
    this.commits++
    if (this.lostAck) return new Promise<{ generation: number; revision: number }>(() => {})
    this.emit(row)
    return Promise.resolve({ generation: 0, revision: row.revision })
  }
  emit(row: ChatChangeRow) { this.listeners.forEach(listener => listener(row)) }
}

describe('real Git/OT CodeMirror interface lifetime', () => {
  let root: Root
  let container: HTMLDivElement
  const stubs: RpcStub<Overseer>[] = []
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.spyOn(document, 'createRange').mockImplementation(() => ({ setStart() {}, setEnd() {},
      getBoundingClientRect: () => new DOMRect(), getClientRects: () => [] }) as unknown as Range)
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    stubs.splice(0).forEach(stub => stub[Symbol.dispose]())
    container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  })
  const frames = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
  const editor = () => EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
  const setup = async () => {
    const server = new Workspace()
    const stub = new RpcStub(server) as unknown as RpcStub<Overseer>
    stubs.push(stub)
    await negotiateEditing(stub)
    const head = crypto.randomUUID()
    const changes: ChatCodeChanges = { chatId: 7, rowsThrough: 0, codeBase: { generation: 0, revision: 0,
      pins: [{ gadgetId: 1, baseCommit: head, mergedCommit: head }] } }
    const liveRows: ChatLiveChangeRows = { chatId: 7, subscribe: listener => {
      server.listeners.add(listener)
      return () => { server.listeners.delete(listener) }
    } }
    const show = (visible: boolean, mode: 'visible' | 'hidden' = 'visible', owner = stub) => act(async () => root.render(
      <Activity mode={mode}><GadgetCodeInterface overseer={owner} workspaceId="workspace" workpieceId={1}
        headCommitId={head} selectedChatId={7} chatChanges={changes} liveRows={liveRows}
        isAgentActive={false} isVisible={visible} height="200px" /></Activity>,
    ))
    await show(false)
    await frames()
    expect(container.querySelector('.cm-editor')).toBeNull()
    await show(true)
    for (let attempt = 0; attempt < 20 && !container.querySelector('.cm-editor'); attempt++) await frames()
    expect(container.querySelector('.cm-editor')).not.toBeNull()
    return { server, show, stub }
  }

  it('lazily mounts once, retains actual editor/selection/scroll while hidden, applies remote edits and keeps undo', async () => {
    const { server, show } = await setup()
    const view = editor()
    expect(view).not.toBeNull()
    await act(async () => view.dispatch({ changes: { from: 0, insert: 'local ' }, selection: { anchor: 9, head: 12 } }))
    await frames()
    expect(server.submissions).toHaveLength(1)
    view.scrollDOM.scrollTop = 320
    view.scrollDOM.scrollLeft = 15
    await show(false)
    expect(editor()).toBe(view)
    expect(view.state.selection.main.anchor).toBe(9)
    const length = view.state.doc.length
    const remote: ChatChangeRow = { generation: 0, revision: 2, author: { type: 'agent', id: 'agent', name: 'Agent' },
      change: { 1: [['notes.txt', { edit: [length, [0, '\nremote']] }]] } }
    server.rows.push(remote)
    await act(async () => server.emit(remote))
    await frames()
    expect(view.state.doc.toString()).toContain('\nremote')
    expect(server.submissions).toHaveLength(1)
    await show(true)
    expect(editor()).toBe(view)
    expect(view.scrollDOM.scrollTop).toBe(320)
    expect(view.scrollDOM.scrollLeft).toBe(15)
    expect(view.state.selection.main.anchor).toBe(9)
    expect(view.state.selection.main.head).toBe(12)
    await act(async () => { expect(undo(view)).toBe(true) })
    expect(view.state.doc.toString()).toBe(`${baseText}\nremote`)
  })

  it('retains lost-ack local edits across real Activity and fresh negotiated capability; commits once', async () => {
    const { server, show } = await setup()
    server.lostAck = true
    const view = editor()
    await act(async () => view.dispatch({ changes: { from: 0, insert: 'unacknowledged ' }, selection: { anchor: 5 } }))
    await frames()
    expect(server.commits).toBe(1)
    const originalWire = server.submissions[0]
    await show(true, 'hidden')
    const fresh = new RpcStub(server) as unknown as RpcStub<Overseer>
    stubs.push(fresh)
    await negotiateEditing(fresh)
    await show(true, 'visible', fresh)
    await frames()
    expect(server.submissions).toHaveLength(2)
    expect(server.submissions[1]).toEqual(originalWire)
    expect(server.commits).toBe(1)
    expect(editor().state.doc.toString()).toBe(`unacknowledged ${baseText}`)
    expect(editor().state.selection.main.anchor).toBe(5)
    await act(async () => { expect(undo(editor())).toBe(true) })
    expect(editor().state.doc.toString()).toBe(baseText)
  })
})
