import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { Toasty } from '@cloudflare/kumo'
import { EditorView } from '@codemirror/view'
import type { CodeChangeSubmission, Overseer } from '@gadgets/workshop-shared/api'
import type { ChatChangeRow } from '../../src/otClient'
import GadgetCodeInterface from '../../src/GadgetCodeInterface'
import { ThemeProvider } from '../../src/ThemeContext'
import { negotiateEditing } from '../../src/features/workspace/editingProtocol'

const base = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
const listeners = new Set<(row: ChatChangeRow) => void>()
let revision = 0
const author = { type: 'user', id: 'fixture-owner', name: 'Fixture owner' } as const
class Workspace extends RpcTarget {
  negotiateEditingProtocol() { return { protocol: 'git-ot-v1', state: 'ready' } }
  getEditingProtocol() { return this.negotiateEditingProtocol() }
  getCodeAtCommit() { return { files: [['notes.txt', base]] } }
  submitCodeChange(_chatId: number, submission: CodeChangeSubmission) {
    const row: ChatChangeRow = { generation: 0, revision: ++revision, author, change: submission.change,
      submission: { clientId: submission.clientId, seq: submission.seq } }
    listeners.forEach(listener => listener(row))
    return { generation: 0, revision }
  }
}
const owner = new RpcStub(new Workspace()) as unknown as RpcStub<Overseer>
await negotiateEditing(owner)
const changes = { chatId: 7, rowsThrough: 0, codeBase: { generation: 0, revision: 0,
  pins: [{ gadgetId: 1, baseCommit: 'head', mergedCommit: 'head' }] } }
const liveRows = { chatId: 7, subscribe: (listener: (row: ChatChangeRow) => void) => {
  listeners.add(listener); return () => { listeners.delete(listener) }
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
  return <>
    <button onClick={() => setVisible(true)}>Open code</button>
    <button onClick={() => setVisible(false)}>Hide code</button>
    <button onClick={() => {
      const row: ChatChangeRow = { generation: 0, revision: ++revision, author,
        change: { 1: [['notes.txt', { edit: [view().state.doc.length, [0, '', 'remote']] }]] } }
      listeners.forEach(listener => listener(row))
    }}>Remote append</button>
    <div style={{ height: 420 }}><GadgetCodeInterface overseer={owner} workspaceId="fixture" workpieceId={1}
      headCommitId="head" selectedChatId={7} chatChanges={changes} liveRows={liveRows}
      isAgentActive={false} isVisible={visible} /></div>
  </>
}
createRoot(document.getElementById('root')!).render(<ThemeProvider><Toasty><Fixture /></Toasty></ThemeProvider>)
