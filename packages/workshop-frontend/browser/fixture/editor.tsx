import { Activity, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { Toasty } from '@cloudflare/kumo'
import { EditorView } from '@codemirror/view'
import type { CodeChangeSubmission, Overseer } from '@gadgets/workshop-shared/api'
import type { ChatChangeRow } from '../../src/features/code/otClient'
import type { ChatLiveEditPreviews, EditPreviewEvent } from '../../src/ChatInterface'
import WorkpieceCodeInterface from '../../src/features/code/WorkpieceCodeInterface'
import { ThemeProvider } from '../../src/ThemeContext'
import { negotiateEditing } from '../../src/features/workspace/editingProtocol'

const base = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
const listeners = new Set<(row: ChatChangeRow) => void>()
const acceptedRows: ChatChangeRow[] = []
const previewListeners = new Set<(event: EditPreviewEvent) => void>()
const terminalEvents: { sequence: number; event: Extract<EditPreviewEvent, { kind: 'reset' | 'clear' }> }[] = []
let terminalSequence = 0
let streaming: { start: Extract<EditPreviewEvent, { kind: 'start' }>; text: string } | undefined
const previews: ChatLiveEditPreviews = { chatId: 7, terminalSequence: () => terminalSequence,
  subscribe(listener, afterTerminalSequence) {
    previewListeners.add(listener)
    if (afterTerminalSequence !== undefined) {
      for (const { sequence, event } of terminalEvents) if (sequence > afterTerminalSequence) listener(event)
    }
    if (streaming) {
      listener(streaming.start)
      if (streaming.text) listener({ kind: 'delta', toolCallId: streaming.start.toolCallId, delta: streaming.text })
    }
    return () => { previewListeners.delete(listener) }
  },
}
const emitPreview = (event: EditPreviewEvent) => {
  if (event.kind === 'start') streaming = { start: event, text: '' }
  if (event.kind === 'delta' && streaming?.start.toolCallId === event.toolCallId) streaming.text += event.delta
  if (event.kind === 'clear' || event.kind === 'reset') {
    terminalEvents.push({ sequence: ++terminalSequence, event })
    if (event.kind === 'reset' || streaming?.start.toolCallId === event.toolCallId) streaming = undefined
  }
  for (const listener of previewListeners) listener(event)
}
let revision = 0
const author = { type: 'user', id: 'fixture-owner', name: 'Fixture owner' } as const
class Workspace extends RpcTarget {
  negotiateEditingProtocol() { return { protocol: 'git-ot-v1', state: 'ready' } }
  getEditingProtocol() { return this.negotiateEditingProtocol() }
  listTree() { return [{ name: 'notes.txt', kind: 'file', size: base.length }] }
  readFilesAtCommit(_commit: string, paths: string[]) { return paths.map(path => [path, { kind: 'text', text: base }]) }
  submitCodeChange(_chatId: number, submission: CodeChangeSubmission) {
    const row: ChatChangeRow = { generation: 0, revision: ++revision, author, change: submission.change,
      submission: { clientId: submission.clientId, seq: submission.seq } }
    acceptedRows.push(row)
    listeners.forEach(listener => listener(row))
    return { generation: 0, revision }
  }
}
const owner = new RpcStub(new Workspace()) as unknown as RpcStub<Overseer>
await negotiateEditing(owner)
const changes = { chatId: 7, rowsThrough: 0, codeBase: { generation: 0, revision: 0,
  pins: [{ gadgetId: 1, baseCommit: 'head', mergedCommit: 'head' }] } }
const liveRows = { chatId: 7, subscribe: (listener: (row: ChatChangeRow) => void) => {
  listeners.add(listener)
  for (const row of acceptedRows) listener(row)
  return () => { listeners.delete(listener) }
} }
const view = () => EditorView.findFromDOM(document.querySelector('.cm-content[contenteditable="true"]')!.closest('.cm-editor') as HTMLElement)!
declare global {
  interface Window { editorFixture: { snapshot(): { text: string; anchor: number; head: number; scroll: number }; select(): Promise<void> } }
}
window.editorFixture = {
  snapshot: () => ({ text: view().state.doc.toString(), anchor: view().state.selection.main.anchor,
    head: view().state.selection.main.head, scroll: view().scrollDOM.scrollTop }),
  async select() {
    view().dispatch({ selection: { anchor: 20, head: 25 } })
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    view().scrollDOM.scrollTop = 500
  },
}
const Fixture = () => {
  const [visible, setVisible] = useState(false)
  const [activityHidden, setActivityHidden] = useState(false)
  return <>
    <button onClick={() => setVisible(true)}>Open code</button>
    <button onClick={() => setVisible(false)}>Hide code</button>
    <button onClick={() => setActivityHidden(true)}>Hide Activity</button>
    <button onClick={() => setActivityHidden(false)}>Show Activity</button>
    <button onClick={() => { emitPreview({ kind: 'start', toolCallId: 'A', workpieceId: 1, filename: 'notes.txt' });
      emitPreview({ kind: 'delta', toolCallId: 'A', delta: 'A preview' }) }}>Preview A</button>
    <button onClick={() => { emitPreview({ kind: 'start', toolCallId: 'B', workpieceId: 1, filename: 'notes.txt' });
      emitPreview({ kind: 'delta', toolCallId: 'B', delta: 'B has no row' }) }}>Preview B</button>
    <button onClick={() => emitPreview({ kind: 'reset' })}>Reset previews</button>
    <button onClick={() => {
      const row: ChatChangeRow = { generation: 0, revision: ++revision, author,
        change: { 1: [['notes.txt', { set: 'A preview' }]] } }
      acceptedRows.push(row)
      for (const listener of listeners) listener(row)
    }}>Commit A</button>
    <button onClick={() => {
      const row: ChatChangeRow = { generation: 0, revision: ++revision, author,
        change: { 1: [['notes.txt', { edit: [view().state.doc.length, [0, '', 'remote']] }]] } }
      acceptedRows.push(row)
      listeners.forEach(listener => listener(row))
    }}>Remote append</button>
    <div style={{ height: 420 }}><Activity mode={activityHidden ? 'hidden' : 'visible'}>
      <WorkpieceCodeInterface overseer={owner} workspaceId="fixture" summary={{ id: 1, type: 'gadget', title: 'App', commitId: 'head' }}
        selectedChatId={7} chatChanges={changes} liveRows={liveRows} liveEditPreviews={previews}
        isAgentActive={false} isVisible={visible} />
    </Activity></div>
  </>
}
createRoot(document.getElementById('root')!).render(<ThemeProvider><Toasty><Fixture /></Toasty></ThemeProvider>)
