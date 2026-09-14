import { useEffect, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Button } from '@cloudflare/kumo'
import { COMMUNITY_REQUEST_LIMITS as LIMITS, type CommunityRequestKind } from '@gadgets/workshop-shared/community-requests'
import { useAuthenticatedApi } from '../AuthContext'
import { useDocumentTitle } from '../useDocumentTitle'
import { fieldClass, panelClass, publicNotice, RelatedRequests, useRequestLifetime, useRequestRetryKey } from './RequestShared'

export default function NewRequestPage() {
  useDocumentTitle('Submit a community request')
  const { authenticatedApi } = useAuthenticatedApi()
  const navigate = useNavigate()
  const lifetime = useRequestLifetime()
  const retryKey = useRequestRetryKey()
  const [kind, setKind] = useState<CommunityRequestKind>('feature')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [consent, setConsent] = useState(false)
  const [review, setReview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => { setBusy(false) }, [authenticatedApi])
  async function publish() {
    if (busy || !review || !consent || !title.trim() || !body.trim()) return
    const current = lifetime()
    const payload = { kind, title: title.trim(), body: body.trim() }
    setBusy(true)
    setError(false)
    try {
      const created = await authenticatedApi.createCommunityRequest({ ...payload, idempotencyKey: retryKey.keyFor(payload) })
      if (current.active) await navigate({ to: '/requests/$requestId', params: { requestId: created.id } })
    } catch { if (current.active) setError(true) }
    finally { if (current.active) setBusy(false) }
  }
  return <main className="mx-auto w-full max-w-3xl space-y-6 p-4 text-kumo-default sm:p-8">
    <Link to="/requests" className="text-kumo-brand underline">All requests</Link>
    <h1 className="text-2xl font-semibold">Submit a request or bug</h1>
    <p className="text-sm text-kumo-subtle">{publicNotice}</p>
    <p className="text-sm">Publishing does not start an automated build or create a GitHub PR.</p>
    <form className="space-y-5" onSubmit={e => { e.preventDefault(); if (review) void publish(); else setReview(true) }}>
      {review ? <section aria-label="Public submission preview" className={panelClass}>
        <h2 className="font-semibold">Review your public {kind === 'bug' ? 'bug summary' : 'feature request'}</h2>
        <h3 className="break-words font-semibold">{title}</h3>
        <p className="whitespace-pre-wrap break-words">{body}</p>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => { setReview(false); setConsent(false) }}>Edit draft</Button>
      </section> : <div className="space-y-4">
        <label className="block">Request type<select className={fieldClass} value={kind} onChange={e => setKind(e.target.value === 'bug' ? 'bug' : 'feature')}><option value="feature">Feature request</option><option value="bug">Public bug summary</option></select></label>
        <label className="block">Public title<input className={fieldClass} required maxLength={LIMITS.title} value={title} onChange={e => setTitle(e.target.value)} /></label>
        <label className="block">Public description<textarea className={`${fieldClass} min-h-40`} required maxLength={LIMITS.body} value={body} onChange={e => setBody(e.target.value)} /></label>
      </div>}
      <RelatedRequests text={`${title}\n${body}`.trim()} />
      {review && <label className="flex items-start gap-2"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={busy} className="mt-1" />I consent to publishing this title and description to all signed-in deployment users. This is not private diagnostic consent.</label>}
      {error && <p role="alert">Could not confirm publication. Retry this unchanged submission to avoid duplicates. If you reload or leave this draft, check the board before submitting again.</p>}
      <Button type="submit" variant="primary" disabled={busy || !title.trim() || !body.trim() || (review && !consent)}>{busy ? 'Publishing…' : review ? 'Publish public request' : 'Review public submission'}</Button>
    </form>
  </main>
}
