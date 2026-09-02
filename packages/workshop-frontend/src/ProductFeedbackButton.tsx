import { useEffect, useState } from 'react'
import { Bug, ChatCenteredDots, Lightbulb, ShieldCheck, X } from '@phosphor-icons/react'
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
            ? 'flex h-9 w-9 items-center justify-center rounded-lg border border-transparent bg-kumo-brand text-kumo-inverse shadow-sm transition-all hover:brightness-95 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-elevated'
            : 'flex w-full items-center gap-2.5 rounded-xl border border-transparent bg-kumo-brand px-3 py-2.5 text-left text-kumo-inverse shadow-sm transition-all hover:brightness-95 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-elevated'
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

  const inputClass = 'w-full rounded-xl border border-kumo-line bg-kumo-base px-3.5 py-3 text-sm text-kumo-default shadow-sm outline-none transition placeholder:text-kumo-inactive focus:border-kumo-brand focus:ring-2 focus:ring-kumo-brand/20'

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-2 backdrop-blur-[2px] sm:p-4" role="dialog" aria-modal="true" aria-labelledby="product-feedback-title">
      <div className="flex max-h-[calc(100vh-1rem)] max-h-[calc(100dvh-1rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-kumo-line bg-kumo-base shadow-2xl sm:max-h-[min(760px,calc(100vh-2rem))] sm:max-h-[min(760px,calc(100dvh-2rem))]">
        <header className="shrink-0 flex items-start gap-3 border-b border-kumo-line px-5 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kumo-fill text-kumo-brand">
            <ChatCenteredDots size={20} weight="fill" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="product-feedback-title" className="text-base font-semibold tracking-[-0.15px] text-kumo-default">Share feedback</h2>
            <p className="mt-0.5 text-xs leading-5 text-kumo-subtle">Tell us what happened or what would make Odie better.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close feedback" className="flex h-8 w-8 items-center justify-center rounded-lg text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default">
            <X size={17} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <fieldset>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-kumo-subtle">Feedback type</legend>
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-kumo-elevated p-1" role="group">
              <button type="button" onClick={() => setKind('bug')} aria-pressed={kind === 'bug'} className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${kind === 'bug' ? 'bg-kumo-base text-kumo-default shadow-sm ring-1 ring-kumo-line' : 'text-kumo-subtle hover:text-kumo-default'}`}>
                <Bug size={16} weight={kind === 'bug' ? 'fill' : 'regular'} className={kind === 'bug' ? 'text-kumo-brand' : ''} /> Report a bug
              </button>
              <button type="button" onClick={() => setKind('feedback')} aria-pressed={kind === 'feedback'} className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${kind === 'feedback' ? 'bg-kumo-base text-kumo-default shadow-sm ring-1 ring-kumo-line' : 'text-kumo-subtle hover:text-kumo-default'}`}>
                <Lightbulb size={16} weight={kind === 'feedback' ? 'fill' : 'regular'} className={kind === 'feedback' ? 'text-kumo-brand' : ''} /> Suggest an idea
              </button>
            </div>
          </fieldset>

          <div className="space-y-4">
            <label htmlFor="feedback-title" className="block">
              <span className="mb-1.5 block text-sm font-medium text-kumo-default">Title</span>
              <input id="feedback-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Summarize the issue or idea" className={inputClass} />
            </label>
            <label htmlFor="feedback-description" className="block">
              <span className="mb-1.5 block text-sm font-medium text-kumo-default">Details</span>
              <textarea id="feedback-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What happened? What did you expect, or what should change?" className={`${inputClass} min-h-32 resize-y`} />
            </label>
          </div>

          <fieldset className="rounded-xl border border-kumo-line bg-kumo-elevated/60 p-4">
            <legend className="sr-only">Evidence and consent</legend>
            <div className="mb-3 flex items-start gap-2.5">
              <ShieldCheck size={18} weight="fill" className="mt-0.5 shrink-0 text-kumo-brand" />
              <div><h3 className="text-sm font-semibold text-kumo-default">Include helpful context</h3><p className="mt-0.5 text-xs leading-4 text-kumo-subtle">Choose exactly what Odie may attach to this report.</p></div>
            </div>
            <div className="space-y-2.5 text-sm text-kumo-default">
              <label className="flex cursor-pointer items-start gap-2.5"><input className="mt-0.5 h-4 w-4 accent-kumo-brand" type="checkbox" checked={workspaceContext} onChange={(e) => setWorkspaceContext(e.target.checked)} /><span>Workspace and chat context <small className="block text-xs text-kumo-subtle">Only when the current workspace is authorized.</small></span></label>
              <label className="flex cursor-pointer items-start gap-2.5"><input className="mt-0.5 h-4 w-4 accent-kumo-brand" type="checkbox" checked={codingSessionContext} onChange={(e) => setCodingSessionContext(e.target.checked)} /><span>Coding-session summaries and activity</span></label>
              <label className="flex cursor-pointer items-start gap-2.5"><input className="mt-0.5 h-4 w-4 accent-kumo-brand" type="checkbox" checked={frontendDiagnostics} onChange={(e) => setFrontendDiagnostics(e.target.checked)} /><span>Current-tab console and errors <small className="text-xs text-kumo-subtle">({productFeedbackDiagnosticsSnapshot().length} entries)</small></span></label>
            </div>
          </fieldset>

          {preview && <div><div className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-kumo-subtle">Submission preview</div><pre className="max-h-52 overflow-auto rounded-xl border border-kumo-line bg-kumo-elevated p-3 text-xs leading-5 text-kumo-subtle">{JSON.stringify(previewSummary, null, 2)}</pre></div>}
          {error && <p role="alert" className="rounded-lg bg-kumo-danger/10 px-3 py-2 text-sm text-kumo-danger">{error}</p>}

          {liveStatuses.length > 0 && (
            <section className="border-t border-kumo-line pt-4">
              <h3 className="text-sm font-semibold text-kumo-default">Recent feedback</h3>
              <ul className="mt-2 space-y-2 text-sm">
                {liveStatuses.slice(0, 5).map((status) => (
                  <li key={status.id} className="rounded-xl border border-kumo-line bg-kumo-elevated p-3">
                    <div className="font-medium text-kumo-default">{status.title} <span className="ml-1 text-xs font-normal text-kumo-subtle">{status.state}</span></div>
                    {status.message && <div className="mt-1 text-xs text-kumo-subtle">{status.message}</div>}
                    {status.prUrl && <a className="mt-1 inline-block text-xs font-medium text-kumo-brand hover:underline" href={status.prUrl} target="_blank" rel="noreferrer">Open draft PR</a>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <footer className="shrink-0 flex flex-col gap-3 border-t border-kumo-line bg-kumo-elevated px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="hidden text-xs text-kumo-subtle sm:block">Preview is required before sending.</p>
          <div className="flex w-full items-center justify-end gap-2 sm:ml-auto sm:w-auto">
            <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-kumo-line bg-kumo-base px-3.5 py-2 text-sm font-medium text-kumo-default shadow-sm transition hover:bg-kumo-tint sm:flex-none">Cancel</button>
            <button type="button" onClick={() => setPreview((value) => !value)} className="flex-1 rounded-lg border border-kumo-line bg-kumo-base px-3.5 py-2 text-sm font-medium text-kumo-default shadow-sm transition hover:bg-kumo-tint sm:flex-none">{preview ? 'Hide preview' : 'Preview'}</button>
            <button type="button" disabled={submitting || !title.trim() || !description.trim() || !preview} onClick={submit} className="flex-1 rounded-lg bg-kumo-brand px-4 py-2 text-sm font-semibold text-kumo-inverse shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none">
              {submitting ? 'Sending…' : 'Send feedback'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
