import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Button } from '@cloudflare/kumo'
import { Bug, Lightbulb, ShieldCheck } from '@phosphor-icons/react'
import { COMMUNITY_REQUEST_LIMITS as LIMITS, type CommunityRequestKind } from '@gadgets/workshop-shared/community-requests'
import { useAuthenticatedApi } from '../AuthContext'
import { useDocumentTitle } from '../useDocumentTitle'
import { fieldClass, panelClass, publicNotice, RelatedRequests, useRequestLifetime, useRequestRetryKey } from './RequestShared'
import { productFeedbackDiagnosticsSnapshot } from '../productFeedbackDiagnostics'

export default function NewRequestPage() {
  useDocumentTitle('Submit a feature request')
  const { authenticatedApi } = useAuthenticatedApi()
  const navigate = useNavigate()
  const lifetime = useRequestLifetime()
  const retryKey = useRequestRetryKey()
  const diagnosticsRetryKey = useRequestRetryKey()
  const [kind, setKind] = useState<CommunityRequestKind>('feature')
  const diagnostics = useRef<ReturnType<typeof productFeedbackDiagnosticsSnapshot> | undefined>(undefined)
  const captureDiagnostics = () => diagnostics.current ??= productFeedbackDiagnosticsSnapshot()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [review, setReview] = useState(false)
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [diagnosticsError, setDiagnosticsError] = useState(false)
  useEffect(() => { setBusy(false) }, [authenticatedApi])
  async function publish() {
    if (busy || !review || !title.trim() || !body.trim()) return
    const current = lifetime()
    const payload = { kind, title: title.trim(), body: body.trim() }
    setBusy(true)
    setError(false)
    setDiagnosticsError(false)
    let publicRequestCreated = false
    try {
      const created = await authenticatedApi.createCommunityRequest({ ...payload, idempotencyKey: retryKey.keyFor(payload) })
      publicRequestCreated = true
      if (!current.active) return
      if (kind === 'bug' && includeDiagnostics) {
        const privatePayload = { pathname: window.location.pathname, diagnostics: captureDiagnostics() }
        await authenticatedApi.attachCommunityRequestDiagnostics(created.id, {
          ...privatePayload, idempotencyKey: diagnosticsRetryKey.keyFor(privatePayload),
        })
      }
      if (current.active) await navigate({ to: '/requests/$requestId', params: { requestId: created.id } })
    } catch {
      if (current.active) {
        if (publicRequestCreated) setDiagnosticsError(true)
        else setError(true)
      }
    }
    finally { if (current.active) setBusy(false) }
  }
  const diagnosticCount = diagnostics.current?.length ?? productFeedbackDiagnosticsSnapshot().length
  return <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 text-kumo-default sm:px-8 lg:py-10">
    <Link to="/requests" className="text-sm font-medium text-kumo-brand hover:underline">← All feature requests</Link>
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <section className="space-y-5">
        <div><h1 className="text-3xl font-semibold tracking-[-0.03em] text-kumo-strong">Submit to Feature Requests</h1><p className="mt-2 text-sm leading-6 text-kumo-subtle">Describe one clear idea or problem. You’ll review exactly what becomes public before publishing.</p></div>
        <form className="space-y-5" onSubmit={e => { e.preventDefault(); if (review) void publish(); else setReview(true) }}>
          {review ? <section aria-label="Public submission preview" className={panelClass}>
            <div className="flex items-center gap-2 text-sm font-medium text-kumo-brand">{kind === 'bug' ? <Bug size={17} weight="fill" /> : <Lightbulb size={17} weight="fill" />} Public preview</div>
            <h2 className="break-words text-xl font-semibold text-kumo-strong">{title}</h2>
            <p className="whitespace-pre-wrap break-words text-sm leading-6">{body}</p>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setReview(false)}>Edit draft</Button>
          </section> : <div className={`${panelClass} space-y-5`}>
            <fieldset><legend className="mb-2 text-sm font-medium">Request type</legend><div className="grid grid-cols-2 gap-2 rounded-xl bg-kumo-elevated p-1">
              <button type="button" aria-pressed={kind === 'feature'} onClick={() => setKind('feature')} className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition ${kind === 'feature' ? 'bg-kumo-base text-kumo-strong shadow-sm ring-1 ring-kumo-line' : 'text-kumo-subtle hover:text-kumo-default'}`}><Lightbulb size={16} weight={kind === 'feature' ? 'fill' : 'regular'} /> Feature</button>
              <button type="button" aria-pressed={kind === 'bug'} onClick={() => setKind('bug')} className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition ${kind === 'bug' ? 'bg-kumo-base text-kumo-strong shadow-sm ring-1 ring-kumo-line' : 'text-kumo-subtle hover:text-kumo-default'}`}><Bug size={16} weight={kind === 'bug' ? 'fill' : 'regular'} /> Bug report</button>
            </div></fieldset>
            <label className="block"><span className="mb-1.5 block text-sm font-medium">Public title</span><input className={fieldClass} required maxLength={LIMITS.title} value={title} placeholder="Summarize the request" onChange={e => setTitle(e.target.value)} /></label>
            <label className="block"><span className="mb-1.5 block text-sm font-medium">Public description</span><textarea className={`${fieldClass} min-h-44 resize-y py-3`} required maxLength={LIMITS.body} value={body} placeholder={kind === 'bug' ? 'What happened, what did you expect, and how can we reproduce it?' : 'What should change, and who would it help?'} onChange={e => setBody(e.target.value)} /></label>
          </div>}
          <RelatedRequests text={`${title}\n${body}`.trim()} />
          {review && kind === 'bug' && <section className="flex items-start gap-3 rounded-xl border border-kumo-line bg-kumo-elevated p-4"><ShieldCheck size={19} weight="fill" className="mt-0.5 shrink-0 text-kumo-brand" /><div className="min-w-0 flex-1 text-sm"><strong className="block text-kumo-strong">Private browser diagnostics</strong><p className="text-kumo-subtle">Optionally attach {diagnosticCount} bounded current-tab console/error {diagnosticCount === 1 ? 'entry' : 'entries'} for administrators. They are sanitized, expire after 30 days, and never enter the public board, search, or Auto-Build input.</p><Button type="button" variant="secondary" aria-pressed={includeDiagnostics} disabled={busy} onClick={() => { const next = !includeDiagnostics; setIncludeDiagnostics(next); if (next) captureDiagnostics() }} className="mt-3">{includeDiagnostics ? 'Remove private diagnostics' : 'Include private diagnostics'}</Button></div></section>}
          {review && <p className="text-sm text-kumo-subtle">Publishing makes this title and description visible to all signed-in deployment users.</p>}
          {error && <p role="alert" className="rounded-xl bg-kumo-danger/10 p-3 text-sm text-kumo-danger">Could not confirm publication. Retry this unchanged submission to avoid duplicates. If you reload or leave this draft, check the board before submitting again.</p>}
          {diagnosticsError && <p role="alert" className="rounded-xl bg-kumo-warning/10 p-3 text-sm text-kumo-warning">The public bug was created, but private diagnostics were not confirmed. Retry unchanged to attach them without creating a duplicate.</p>}
          <Button type="submit" variant="primary" disabled={busy || !title.trim() || !body.trim()}>{busy ? 'Publishing…' : review ? 'Publish public request' : 'Review public submission'}</Button>
        </form>
      </section>
      <aside className="space-y-4 lg:pt-16"><div className="rounded-2xl border border-kumo-line bg-kumo-elevated p-5"><h2 className="text-sm font-semibold text-kumo-strong">What stays private</h2><p className="mt-2 text-sm leading-6 text-kumo-subtle">{publicNotice}</p></div><div className="rounded-2xl border border-kumo-line bg-kumo-base p-5 text-sm leading-6 text-kumo-subtle"><strong className="text-kumo-strong">No automatic changes</strong><br />Publishing does not start a build or create a GitHub pull request. Administrators control that separately.</div></aside>
    </div>
  </main>
}
