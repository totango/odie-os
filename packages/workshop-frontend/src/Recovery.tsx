import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getWorkshopRuntime } from './runtime'
import { createRecoveryBundle, recoveryBundleHtml, RECOVERY_NOTICE, type RecoveryBundle, type RecoverySource } from './recoveryBundle'

type Capture = () => RecoverySource
const RecoveryContext = createContext<Map<RecoverySource['kind'], Capture> | null>(null)
const WorkspaceContext = createContext<string | null>(null)

/** Registers only a mounted, first-party source. Snapshot reads are synchronous and local. */
export function useRecoverySource(kind: RecoverySource['kind'], capture: Capture): boolean {
  const sources = useContext(RecoveryContext)
  const workspaceId = useContext(WorkspaceContext)
  const currentCapture = useRef(capture)
  useLayoutEffect(() => { currentCapture.current = capture })
  useLayoutEffect(() => {
    if (!sources) return
    const read = (): RecoverySource => ({ ...currentCapture.current(), workspaceId, sourceCapturedAt: new Date().toISOString(), retainedAfterPause: false })
    sources.set(kind, read)
    return () => {
      if (sources.get(kind) !== read) return
      // Activity disconnects effects while hidden. Freeze values only: never retain the closure,
      // Y.Doc, Blob, or RPC stubs in the recovery store after suspension/unmount.
      try {
        const frozen = { ...read(), retainedAfterPause: true }
        sources.set(kind, () => frozen)
      } catch {
        sources.delete(kind)
      }
    }
  }, [sources, workspaceId, kind])
  return sources !== null
}

export function RecoveryProvider({ children, scope = '' }: { children: ReactNode; scope?: string }) {
  const sources = useMemo(() => new Map<RecoverySource['kind'], Capture>(), [scope])
  return <RecoveryContext.Provider value={sources}>{children}</RecoveryContext.Provider>
}

export function RecoveryWorkspace({ workspaceId, children }: { workspaceId: string | null; children: ReactNode }) {
  return <WorkspaceContext.Provider value={workspaceId}>{children}</WorkspaceContext.Provider>
}

export function RecoveryControls({ workspaceId = null, capture }: { workspaceId?: string | null; capture?: Capture }) {
  const sources = useContext(RecoveryContext)
  const [bundle, setBundle] = useState<RecoveryBundle | null>(null)
  const [status, setStatus] = useState('')
  return <details className="shrink-0 border-b border-kumo-line bg-kumo-base px-3 py-2 text-sm">
    <summary className="cursor-pointer">Recovery export (local/offline)</summary>
    <p>{RECOVERY_NOTICE}</p>
    <p>No automatic disk backup. Paused sources use a last local, in-memory snapshot; inspect sourceCapturedAt and retainedAfterPause. Keep this tab open until you have opened and checked your saved bundle. Raw file/draft text can contain secrets you typed; no credentials or capabilities are collected from the app.</p>
    <button type="button" className="underline" onClick={() => {
      try {
        const snapshots = capture ? [capture()] : Array.from(sources?.values() ?? [], read => read())
        setBundle(createRecoveryBundle(workspaceId, snapshots))
        setStatus('Snapshot captured in memory. Review it, then download; it does not include later edits.')
      } catch {
        setBundle(null)
        setStatus('Snapshot failed. Keep this tab open and copy/export your work manually.')
      }
    }}>Capture recovery snapshot</button>
    {bundle && <>
      <label className="block">Review recovery JSON (select and copy if download fails)
        <textarea readOnly className="block max-h-48 w-full font-mono" rows={6} value={JSON.stringify(bundle, null, 2)} />
      </label>
      <button type="button" className="underline" onClick={async () => {
        setStatus('Download requested. Open and verify the saved file before leaving this tab.')
        try {
          await getWorkshopRuntime().saveBlob(new Blob([recoveryBundleHtml(bundle)], { type: 'text/html;charset=utf-8' }), {
            filename: 'workshop-recovery-v1.html', contentType: 'text/html', extension: '.html', description: 'Offline Workshop recovery viewer',
          })
        } catch {
          setStatus('Download failed. Select and copy the recovery JSON above to a local text file. Keep this tab open.')
        }
      }}>Download offline recovery bundle</button>
      {' · '}<button type="button" className="underline" onClick={() => { setBundle(null); setStatus('Snapshot discarded from this panel.') }}>Discard snapshot</button>
    </>}
    <p role="status">{status}</p>
  </details>
}
