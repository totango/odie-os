// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { Activity, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeChangeSubmission, Overseer } from '@gadgets/workshop-shared/api'
import type { ChatChangeRow } from './features/code/otClient'
import type { ChatCodeChanges, ChatLiveChangeRows, ChatLiveEditPreviews, EditPreviewEvent } from './ChatInterface'
import { negotiateEditing } from './features/workspace/editingProtocol'
import WorkpieceCodeInterface from './features/code/WorkpieceCodeInterface'

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
  listTree() { return [{ name: 'notes.txt', kind: 'file', size: baseText.length }] }
  readFilesAtCommit(_commit: string, paths: string[]) { return paths.map(path => [path, { kind: 'text', text: baseText }]) }
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
  const previewStream = () => {
    const listeners = new Set<(event: EditPreviewEvent) => void>()
    let current: { start: Extract<EditPreviewEvent, { kind: 'start' }>; text: string } | null = null
    let sequence = 0
    const terminals: { sequence: number; event: Extract<EditPreviewEvent, { kind: 'reset' | 'clear' }> }[] = []
    const source: ChatLiveEditPreviews = { chatId: 7, terminalSequence: () => sequence, subscribe(listener, afterTerminalSequence) {
      listeners.add(listener)
      if (afterTerminalSequence !== undefined) {
        for (const terminal of terminals) if (terminal.sequence > afterTerminalSequence) listener(terminal.event)
      }
      if (current) {
        listener(current.start)
        if (current.text) listener({ kind: 'delta', toolCallId: current.start.toolCallId, delta: current.text })
      }
      return () => { listeners.delete(listener) }
    } }
    return { source, emit(event: EditPreviewEvent) {
      if (event.kind === 'start') current = { start: event, text: '' }
      if (event.kind === 'delta' && current?.start.toolCallId === event.toolCallId) current.text += event.delta
      if (event.kind === 'clear' && current?.start.toolCallId === event.toolCallId) current = null
      if (event.kind === 'reset') current = null
      if (event.kind === 'clear' || event.kind === 'reset') terminals.push({ sequence: ++sequence, event })
      for (const listener of listeners) listener(event)
    } }
  }
  const setup = async (previews?: ChatLiveEditPreviews) => {
    const server = new Workspace()
    const stub = new RpcStub(server) as unknown as RpcStub<Overseer>
    stubs.push(stub)
    await negotiateEditing(stub)
    const head = crypto.randomUUID()
    const changes: ChatCodeChanges = { chatId: 7, rowsThrough: 0, codeBase: { generation: 0, revision: 0,
      pins: [{ gadgetId: 1, baseCommit: head, mergedCommit: head }] } }
    const liveRows: ChatLiveChangeRows = { chatId: 7, subscribe: listener => {
      server.listeners.add(listener)
      for (const row of server.rows) listener(row)
      return () => { server.listeners.delete(listener) }
    } }
    const show = (visible: boolean, mode: 'visible' | 'hidden' = 'visible', owner = stub) => act(async () => root.render(
      <Activity mode={mode}><WorkpieceCodeInterface overseer={owner} workspaceId="workspace" summary={{ id: 1, type: 'gadget', title: 'App', commitId: head }}
        selectedChatId={7} chatChanges={changes} liveRows={liveRows} liveEditPreviews={previews}
        isAgentActive={false} isVisible={visible} height="200px" /></Activity>,
    ))
    await show(false)
    await frames()
    expect(container.querySelector('.cm-editor')).toBeNull()
    await show(true)
    for (let attempt = 0; attempt < 20 && !container.querySelector('.cm-editor'); attempt++) await frames()
    expect(container.querySelector('.cm-editor')).not.toBeNull()
    return { server, show, stub, changes, liveRows, head }
  }

  it('retains finished A under streaming B over real Activity teardown; resolves A row once and retires B on clear', async () => {
    const stream = previewStream()
    const { server, show, stub, changes, head } = await setup(stream.source)
    const view = editor()
    const start = (toolCallId: string): EditPreviewEvent => ({ kind: 'start', toolCallId, workpieceId: 1, filename: 'notes.txt' })
    await act(async () => {
      stream.emit(start('A'))
      stream.emit({ kind: 'delta', toolCallId: 'A', delta: 'A preview' })
      stream.emit(start('B'))
      stream.emit({ kind: 'delta', toolCallId: 'B', delta: 'B preview' })
    })
    expect(view.state.doc.toString()).toBe('B preview')
    await show(true, 'hidden')
    await show(true)
    await frames()
    expect(editor().state.doc.toString()).toBe('B preview')
    // A finished before hide; only B is replayed. Its row must resolve exactly once
    // beneath B without briefly removing B's still-streaming document.
    const row: ChatChangeRow = { generation: 0, revision: 1,
      author: { type: 'agent', id: 'agent', name: 'Agent' }, change: { 1: [['notes.txt', { set: 'A preview' }]] } }
    server.rows.push(row)
    await act(async () => server.emit(row))
    await frames()
    expect(editor().state.doc.toString()).toBe('B preview')
    expect(server.submissions).toHaveLength(0)
    await act(async () => stream.emit({ kind: 'clear', toolCallId: 'B' }))
    expect(editor().state.doc.toString()).toBe('A preview')

    // An owner change remounts the principal-keyed route. No finished preview or escaped
    // subscription may cross into that owner's fresh component even with the same workpiece id.
    const freshServer = new Workspace()
    const fresh = new RpcStub(freshServer) as unknown as RpcStub<Overseer>
    stubs.push(fresh)
    await negotiateEditing(fresh)
    const noReplay = previewStream()
    const freshRows: ChatLiveChangeRows = { chatId: 7, subscribe(listener) {
      freshServer.listeners.add(listener)
      return () => { freshServer.listeners.delete(listener) }
    } }
    await act(async () => root.render(<Activity key="different-owner" mode="visible">
      <WorkpieceCodeInterface overseer={fresh} workspaceId="workspace" summary={{ id: 1, type: 'gadget', title: 'App', commitId: head }}
        selectedChatId={7} chatChanges={changes} liveRows={freshRows} liveEditPreviews={noReplay.source}
        isAgentActive={false} isVisible height="200px" />
    </Activity>))
    for (let attempt = 0; attempt < 20 && !container.querySelector('.cm-editor'); attempt++) await frames()
    await frames()
    expect(editor().state.doc.toString()).toBe(baseText)
    expect(stub).not.toBe(fresh)
  })

  it.each([false, true])('reconciles B terminal reset hidden with A durable row %s; no phantom B or finished no-row preview', async rowWhileHidden => {
    const stream = previewStream()
    const { server, show } = await setup(stream.source)
    const start = (toolCallId: string): EditPreviewEvent => ({ kind: 'start', toolCallId, workpieceId: 1, filename: 'notes.txt' })
    await act(async () => {
      stream.emit(start('A'))
      stream.emit({ kind: 'delta', toolCallId: 'A', delta: 'A preview' })
      stream.emit(start('B'))
      stream.emit({ kind: 'delta', toolCallId: 'B', delta: 'B has no row' })
    })
    expect(editor().state.doc.toString()).toBe('B has no row')
    await show(true, 'hidden')
    const row: ChatChangeRow = { generation: 0, revision: 1,
      author: { type: 'agent', id: 'agent', name: 'Agent' }, change: { 1: [['notes.txt', { set: 'A preview' }]] } }
    if (rowWhileHidden) server.rows.push(row) // chat's row buffer replays it on subscribe
    stream.emit({ kind: 'reset' }) // turn ended while the editor's effects were disconnected
    await show(true)
    await frames()
    expect(editor().state.doc.toString()).toBe(rowWhileHidden ? 'A preview' : baseText)
    if (!rowWhileHidden) {
      server.rows.push(row)
      await act(async () => server.emit(row))
      await frames()
    }
    expect(editor().state.doc.toString()).toBe('A preview')
    expect(server.submissions).toHaveLength(0)
    // A later Activity cycle cannot reintroduce a finished preview from before the reset.
    await show(true, 'hidden')
    await show(true)
    await frames()
    expect(editor().state.doc.toString()).toBe('A preview')
  })

  it('replays B clear while hidden but retains successful finished A until its row', async () => {
    const stream = previewStream()
    const { server, show } = await setup(stream.source)
    await act(async () => {
      stream.emit({ kind: 'start', toolCallId: 'A', workpieceId: 1, filename: 'notes.txt' })
      stream.emit({ kind: 'delta', toolCallId: 'A', delta: 'A pending' })
      stream.emit({ kind: 'start', toolCallId: 'B', workpieceId: 1, filename: 'notes.txt' })
      stream.emit({ kind: 'delta', toolCallId: 'B', delta: 'B failed' })
    })
    await show(true, 'hidden')
    stream.emit({ kind: 'clear', toolCallId: 'B' })
    await show(true)
    await frames()
    expect(editor().state.doc.toString()).toBe('A pending')
    const row: ChatChangeRow = { generation: 0, revision: 1,
      author: { type: 'agent', id: 'agent', name: 'Agent' }, change: { 1: [['notes.txt', { set: 'A pending' }]] } }
    server.rows.push(row)
    await act(async () => server.emit(row))
    await frames()
    expect(editor().state.doc.toString()).toBe('A pending')
    expect(server.submissions).toHaveLength(0)
  })

  it('does not lend a finished preview to a replacement chat stream with no replay evidence', async () => {
    const old = previewStream()
    const { stub, changes, liveRows, head } = await setup(old.source)
    await act(async () => {
      old.emit({ kind: 'start', toolCallId: 'A', workpieceId: 1, filename: 'notes.txt' })
      old.emit({ kind: 'delta', toolCallId: 'A', delta: 'old private text' })
      old.emit({ kind: 'start', toolCallId: 'B', workpieceId: 1, filename: 'notes.txt' })
    })
    expect(editor().state.doc.toString()).toBe('')
    const replacement = previewStream()
    await act(async () => root.render(<Activity mode="visible">
      <WorkpieceCodeInterface overseer={stub} workspaceId="workspace" summary={{ id: 1, type: 'gadget', title: 'App', commitId: head }}
        selectedChatId={7} chatChanges={changes} liveRows={liveRows} liveEditPreviews={replacement.source}
        isAgentActive={false} isVisible height="200px" />
    </Activity>))
    await frames()
    expect(editor().state.doc.toString()).toBe(baseText)
  })

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
