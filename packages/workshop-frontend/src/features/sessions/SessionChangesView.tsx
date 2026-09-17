import { useState } from 'react'
import CodeEditor from '../../CodeEditor'
import { WorkshopButton } from '../../components/WorkshopControls'
import type { SessionChanges } from './openCodeChanges'

export const SessionChangesView = ({ changes, loading, error }: {
  changes?: SessionChanges; loading: boolean; error?: string
}) => {
  const [selected, setSelected] = useState(0)
  const [hunk, setHunk] = useState(0)
  const files = changes?.files ?? []
  const index = Math.min(selected, Math.max(0, files.length - 1))
  const file = files[index]
  const hunks = file?.patch?.split('\n').flatMap((line, i) => line.startsWith('@@ ') ? [i + 1] : []) ?? []
  const hunkIndex = Math.min(hunk, Math.max(0, hunks.length - 1))
  return <section aria-label="Session changes" className="min-w-0 space-y-3">
    <p className="text-xs text-kumo-subtle">Read-only runtime patches. Use browser VS Code for full editing; the terminal remains available.</p>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">Loading changes…</p>}
    {changes?.notice && <p role="status">{changes.notice}</p>}
    {!loading && !error && changes && !changes.notice && files.length === 0 && <p>No changes.</p>}
    {file && <>
      <div className="flex flex-wrap items-center gap-2">
        <label>Changed file <select aria-label="Changed file" value={index} onChange={event => { setSelected(Number(event.target.value)); setHunk(0) }}>
          {files.map((entry, i) => <option key={i} value={i}>{entry.path}</option>)}
        </select></label>
        <WorkshopButton disabled={index === 0} onClick={() => setSelected(index - 1)}>Previous file</WorkshopButton>
        <WorkshopButton disabled={index + 1 === files.length} onClick={() => setSelected(index + 1)}>Next file</WorkshopButton>
        <span>{file.status ?? 'Changed'} {file.additions !== undefined && `+${file.additions} −${file.deletions}`}</span>
      </div>
      {file.omission ? <p role="status">{file.omission}</p> : <>
        <p className="text-xs text-kumo-subtle">Unified patch; Ctrl/Cmd-F to search.</p>
        <div className="flex items-center gap-2">
          <WorkshopButton disabled={hunkIndex === 0} onClick={() => setHunk(hunkIndex - 1)}>Previous change</WorkshopButton>
          <span aria-live="polite">Change {hunkIndex + 1} of {hunks.length}</span>
          <WorkshopButton disabled={hunkIndex + 1 >= hunks.length} onClick={() => setHunk(hunkIndex + 1)}>Next change</WorkshopButton>
        </div>
        <CodeEditor key={`${index}:${file.path}`} filename={`${file.path}.diff`} text={file.patch} readOnly height="420px" revealLine={hunks[hunkIndex]} />
      </>}
    </>}
  </section>
}
