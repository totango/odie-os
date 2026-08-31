import { useEffect, useState } from 'react'
import { ChatCenteredDots } from '@phosphor-icons/react'
import type { ProductFeedbackStatus, SubmitProductFeedbackRequest } from '@gadgets/workshop-shared/product-feedback'
import { productFeedbackDiagnosticsSnapshot } from './productFeedbackDiagnostics'
import { useAuthenticatedApi } from './AuthContext'
import { logRpcFailure } from './rpcErrors'

function contextFromPath(pathname: string): SubmitProductFeedbackRequest['context'] {
  const context: SubmitProductFeedbackRequest['context'] = { pathname }
  const workspace = /^\/workspace\/([^/]+)/.exec(pathname)
  if (workspace) context.workspaceId = workspace[1]
  const session = /^\/sessions(?:\/([^/]+))?/.exec(pathname)
  if (session?.[1]) context.codingSessionId = session[1]
  return context
}

export default function ProductFeedbackButton({
  pathname,
  placement = 'floating',
  collapsed = false,
}: {
  pathname: string
  placement?: 'floating' | 'sidebar'
  collapsed?: boolean
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [open, setOpen] = useState(false)
  const [statuses, setStatuses] = useState<ProductFeedbackStatus[]>([])
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.productFeedbackAvailable().then((value) => {
      if (!cancelled) setAvailable(value)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])

  useEffect(() => {
    if (!available) return
    let cancelled = false
    authenticatedApi.listProductFeedbackStatuses().then((items) => {
      if (!cancelled) setStatuses(items)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi, available, open])

  if (!available) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Share feedback"
        title={collapsed ? 'Share feedback' : undefined}
        className={placement === 'sidebar'
          ? collapsed
            ? 'flex h-9 w-9 items-center justify-center rounded-lg border border-transparent bg-kumo-brand text-kumo-inverse shadow-sm transition-all hover:brightness-95 hover:shadow-md'
            : 'flex w-full items-center gap-2.5 rounded-xl border border-transparent bg-kumo-brand px-3 py-2.5 text-left text-kumo-inverse shadow-sm transition-all hover:brightness-95 hover:shadow-md'
          : 'rounded-md border border-kumo-line px-3 py-2 text-sm text-kumo-default shadow-sm hover:bg-kumo-tint'}
      >
        {placement === 'sidebar' && <ChatCenteredDots size={collapsed ? 17 : 18} weight="fill" className="shrink-0" />}
        {!collapsed && (
          placement === 'sidebar'
            ? <span className="min-w-0"><span className="block text-sm font-semibold leading-4">Share feedback</span><span className="mt-0.5 block text-[11px] leading-4 text-kumo-inverse/75">Help improve Odie</span></span>
            : 'Feedback'
        )}
      </button>
      {open && <ProductFeedbackModal pathname={pathname} statuses={statuses} onClose={() => setOpen(false)} onSubmitted={(status) => setStatuses((prev) => [status, ...prev])} />}
    </>
  )
}

function ProductFeedbackModal({
  pathname,
  statuses,
  onClose,
  onSubmitted,
}: {
  pathname: string
  statuses: ProductFeedbackStatus[]
  onClose: () => void
  onSubmitted: (status: ProductFeedbackStatus) => void
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [liveStatuses, setLiveStatuses] = useState(statuses)
  const [kind, setKind] = useState<'bug' | 'feedback'>('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [workspaceContext, setWorkspaceContext] = useState(true)
  const [frontendDiagnostics, setFrontendDiagnostics] = useState(false)
  const [codingSessionContext, setCodingSessionContext] = useState(true)
  const [preview, setPreview] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const request: SubmitProductFeedbackRequest = {
    kind,
    title,
    description,
    consent: { workspaceContext, frontendDiagnostics, codingSessionContext },
    context: contextFromPath(pathname),
    diagnostics: frontendDiagnostics ? productFeedbackDiagnosticsSnapshot() : [],
  }

  useEffect(() => { setLiveStatuses(statuses) }, [statuses])

  useEffect(() => {
    if (!liveStatuses.some((status) => status.state === 'queued' || status.state === 'running')) return
    const timer = window.setInterval(() => {
      authenticatedApi.listProductFeedbackStatuses().then(setLiveStatuses).catch((err) => {
        logRpcFailure('Failed to poll feedback status:', err)
      })
    }, 5000)
    return () => window.clearInterval(timer)
  }, [authenticatedApi, liveStatuses])

  const previewSummary = {
    kind,
    titleLength: title.length,
    descriptionLength: description.length,
    routePathname: pathname,
    evidenceSections: {
      workspaceContext: workspaceContext ? 'server-collected if current workspace is authorized' : 'omitted',
      codingSessionContext: codingSessionContext ? 'server-collected owner summaries/activity' : 'omitted',
      frontendDiagnostics: frontendDiagnostics ? `${productFeedbackDiagnosticsSnapshot().length} current-tab entries` : 'omitted',
    },
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const result = await authenticatedApi.submitProductFeedback(request)
      onSubmitted(result.status)
      setLiveStatuses((prev) => [result.status, ...prev])
      setPreview(false)
    } catch (err) {
      logRpcFailure('Failed to submit product feedback:', err)
      setError(err instanceof Error ? err.message : 'Feedback submission failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Product feedback">
      <div className="max-h-full w-full max-w-2xl overflow-y-auto rounded-xl border border-kumo-line bg-kumo-base p-5 shadow-xl">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-kumo-default">Send product feedback</h2>
          <button type="button" onClick={onClose} className="text-sm text-kumo-subtle hover:text-kumo-default">Close</button>
        </div>
        <div className="mt-4 space-y-3">
          <select value={kind} onChange={(e) => setKind(e.target.value as 'bug' | 'feedback')} className="w-full rounded-md border border-kumo-line bg-kumo-base p-2">
            <option value="bug">Report a bug</option>
            <option value="feedback">Product feedback</option>
          </select>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short title" className="w-full rounded-md border border-kumo-line bg-kumo-base p-2" />
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What happened? What should change?" className="h-28 w-full rounded-md border border-kumo-line bg-kumo-base p-2" />
          <fieldset className="rounded-md border border-kumo-line p-3 text-sm">
            <legend className="px-1 font-medium">Evidence preview and consent</legend>
            <label className="block"><input type="checkbox" checked={workspaceContext} onChange={(e) => setWorkspaceContext(e.target.checked)} /> Include server-collected workspace/chat context if available</label>
            <label className="block"><input type="checkbox" checked={codingSessionContext} onChange={(e) => setCodingSessionContext(e.target.checked)} /> Include coding-session summaries/activity if available</label>
            <label className="block"><input type="checkbox" checked={frontendDiagnostics} onChange={(e) => setFrontendDiagnostics(e.target.checked)} /> Include current-tab console/errors ({productFeedbackDiagnosticsSnapshot().length})</label>
          </fieldset>
          <button type="button" onClick={() => setPreview((value) => !value)} className="text-sm text-kumo-brand">{preview ? 'Hide' : 'Preview'} submission</button>
          {preview && <pre className="max-h-64 overflow-auto rounded bg-kumo-tint p-3 text-xs">{JSON.stringify(previewSummary, null, 2)}</pre>}
          {error && <p className="text-sm text-kumo-danger">{error}</p>}
          <button type="button" disabled={submitting || !title.trim() || !description.trim() || !preview} onClick={submit} className="rounded-md bg-kumo-brand px-4 py-2 text-sm font-medium text-kumo-inverse disabled:opacity-50">
            {submitting ? 'Submitting…' : 'Submit with consent'}
          </button>
        </div>
        {liveStatuses.length > 0 && (
          <div className="mt-6 border-t border-kumo-line pt-4">
            <h3 className="text-sm font-semibold">Recent feedback status</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {liveStatuses.slice(0, 5).map((status) => (
                <li key={status.id} className="rounded-md border border-kumo-line p-2">
                  <div className="font-medium">{status.title} — {status.state}</div>
                  {status.message && <div className="text-kumo-subtle">{status.message}</div>}
                  {status.prUrl && <a className="text-kumo-brand" href={status.prUrl} target="_blank" rel="noreferrer">Open draft PR</a>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
