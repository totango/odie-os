import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@cloudflare/kumo'
import { Trash } from '@phosphor-icons/react'
import { COMMUNITY_REQUEST_LIMITS as LIMITS, type CommunityRequest, type CommunityRequestDetailPage, type CommunityRequestPrivateDiagnostics } from '@gadgets/workshop-shared/community-requests'
import { useAuthenticatedApi } from '../AuthContext'
import { useDocumentTitle } from '../useDocumentTitle'
import { RequestBuildPanel } from './RequestBuildPanel'
import { fieldClass, panelClass, publicNotice, RelatedRequests, RequestVote, useRequestLifetime, useRequestRetryKey } from './RequestShared'
import { CommunityAttachmentList, CommunityAttachmentPicker, uploadCommunityAttachmentDrafts, type CommunityAttachmentDraft } from './CommunityRequestAttachments'

export default function RequestDetailPage({ requestId, onBack }: { requestId: string; onBack?: () => void }) {
  const { authenticatedApi, isAdmin } = useAuthenticatedApi()
  const navigate = useNavigate()
  const scope = useMemo(() => ({ api: authenticatedApi, requestId }), [authenticatedApi, requestId])
  const [result, setResult] = useState<{ scope: typeof scope; request: CommunityRequest | null }>()
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(true)
  const request = result?.scope === scope ? result.request : undefined
  useDocumentTitle(request?.title ?? 'Feature request')
  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setError(false)
    authenticatedApi.getCommunityRequest(requestId).then(value => {
      if (!cancelled) setResult({ scope, request: value })
    }).catch(() => { if (!cancelled) { setResult(undefined); setError(true) } }).finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [authenticatedApi, scope, requestId, revision])
  return <div className="w-full space-y-6 p-4 text-kumo-default sm:p-6">
    {busy && <p role="status">Loading request…</p>}
    {error && <p role="alert">Could not load this request. Please retry in a moment.</p>}
    {request === null && <h1 className="text-xl font-semibold">Request unavailable</h1>}
    <Button variant="secondary" disabled={busy} onClick={() => setRevision(n => n + 1)}>Refresh request</Button>
    {request && <>
      <article className={panelClass}>
        <h1 className="break-words text-2xl font-semibold">{request.title}</h1>
        <p className="text-sm text-kumo-subtle">{request.kind === 'bug' ? 'Public bug summary' : 'Feature request'} · {request.status}{request.isOwn ? ' · Your request' : ''}</p>
        <p className="whitespace-pre-wrap break-words">{request.body}</p>
        <CommunityAttachmentList requestId={request.id} attachments={request.attachments} onDeleted={() => setRevision(value => value + 1)} />
        {request.duplicateOf && <div className="flex items-center gap-2"><span className="text-sm text-kumo-subtle">This request was marked as a duplicate.</span><Button variant="secondary" onClick={() => void navigate({ to: '/requests/$requestId', params: { requestId: request.duplicateOf! }, replace: true })}>View canonical request</Button></div>}
        <RequestVote request={request} onChange={value => setResult({ scope, request: value })} />
        {request.isOwn && <DeleteOwnedRequest requestId={request.id} onDeleted={() => { if (onBack) onBack(); else void navigate({ to: '/requests', replace: true }) }} />}
      </article>
      <RequestBuildPanel key={`builds:${request.id}:${revision}`} requestId={request.id} />
      {isAdmin && <PrivateDiagnostics requestId={request.id} />}
      <RequestDetails key={request.id} requestId={request.id} onChanged={() => setRevision(value => value + 1)} />
      <RelatedRequests text={`${request.title}\n${request.body}`} excludeId={request.id} />
    </>}
  </div>
}

function DeleteOwnedRequest({ requestId, onDeleted }: { requestId: string; onDeleted: () => void }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const lifetime = useRequestLifetime()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  async function remove() {
    if (busy) return
    const current = lifetime()
    setBusy(true); setError(false)
    try {
      await authenticatedApi.deleteCommunityRequest(requestId)
      if (current.active) onDeleted()
    } catch { if (current.active) setError(true) }
    finally { if (current.active) setBusy(false) }
  }
  if (!confirming) return <div className="border-t border-kumo-line pt-4"><Button variant="secondary" onClick={() => setConfirming(true)}>Delete your request</Button></div>
  return <div role="group" aria-live="polite" aria-label="Confirm request deletion" className="space-y-3 rounded-xl border border-kumo-danger/30 bg-kumo-danger/10 p-4">
    <p className="text-sm text-kumo-default"><strong>Delete this request?</strong> It will disappear from the public board. Its public text, details, attachments, votes, and private diagnostics will be scrubbed, and it cannot be restored. Approved build records may retain their frozen copy for restricted audit integrity, but deletion revokes continued execution and public access.</p>
    {error && <p role="alert" className="text-sm text-kumo-danger">Could not delete this request. Retry or cancel.</p>}
    <div className="flex flex-wrap gap-2"><Button autoFocus variant="secondary" disabled={busy} onClick={() => { setConfirming(false); setError(false) }}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Confirm deletion'}</Button></div>
  </div>
}

function DeleteOwnedDetail({ requestId, detailId, onDeleted }: { requestId: string; detailId: string; onDeleted: () => void }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const lifetime = useRequestLifetime()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  async function remove() {
    if (busy) return
    const current = lifetime()
    setBusy(true); setError(false)
    try {
      await authenticatedApi.deleteCommunityRequestDetail(requestId, detailId)
      if (current.active) onDeleted()
    } catch { if (current.active) setError(true) }
    finally { if (current.active) setBusy(false) }
  }
  if (!confirming) return <Button variant="secondary" onClick={() => setConfirming(true)}><Trash size={15} /> Delete your detail</Button>
  return <div role="group" aria-live="polite" aria-label="Confirm detail deletion" className="space-y-3 rounded-xl border border-kumo-danger/30 bg-kumo-danger/10 p-3">
    <p className="text-sm"><strong>Delete this detail?</strong> Its text and attachments will be removed from the board and future Auto-Build approvals. A build already approved keeps its frozen copy.</p>
    {error && <p role="alert" className="text-sm text-kumo-danger">Could not delete this detail. Retry or cancel.</p>}
    <div className="flex flex-wrap gap-2"><Button autoFocus variant="secondary" disabled={busy} onClick={() => { setConfirming(false); setError(false) }}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Confirm deletion'}</Button></div>
  </div>
}

function PrivateDiagnostics({ requestId }: { requestId: string }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const scope = useMemo(() => ({ api: authenticatedApi, requestId }), [authenticatedApi, requestId])
  const [result, setResult] = useState<{ scope: typeof scope; value: CommunityRequestPrivateDiagnostics | null }>()
  const [error, setError] = useState(false)
  const value = result?.scope === scope ? result.value : undefined
  useEffect(() => {
    let cancelled = false
    setError(false)
    authenticatedApi.getCommunityRequestPrivateDiagnostics(requestId)
      .then(next => { if (!cancelled) setResult({ scope, value: next }) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [authenticatedApi, requestId, scope])
  if (error) return <section className={panelClass} aria-label="Private diagnostics"><h2 className="text-lg font-semibold">Private diagnostics</h2><p role="alert" className="text-sm text-kumo-danger">Private diagnostics are unavailable.</p></section>
  if (value === undefined) return <p role="status">Loading private diagnostics…</p>
  if (value === null) return null
  return <section className={panelClass} aria-label="Private diagnostics">
    <div><h2 className="text-lg font-semibold">Private diagnostics</h2><p className="text-sm text-kumo-subtle">Visible only to current administrators until {new Date(value.expiresAt).toLocaleString()}.</p></div>
    <p className="break-all text-sm"><strong>Page:</strong> {value.pathname}</p>
    <ol className="space-y-2">
      {value.diagnostics.map((entry, index) => <li key={`${new Date(entry.timestamp).getTime()}:${index}`} className="rounded-lg bg-kumo-elevated p-3 text-sm"><span className="font-medium uppercase">{entry.level}</span> · {new Date(entry.timestamp).toLocaleString()}<pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs">{entry.message}</pre></li>)}
    </ol>
  </section>
}

function RequestDetails({ requestId, onChanged }: { requestId: string; onChanged: () => void }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const lifetime = useRequestLifetime()
  const retryKey = useRequestRetryKey()
  const scope = useMemo(() => ({ api: authenticatedApi, requestId }), [authenticatedApi, requestId])
  const [result, setResult] = useState<{ scope: typeof scope; page: CommunityRequestDetailPage }>()
  const [continuation, setContinuation] = useState<{ scope: typeof scope; value: string }>()
  const cursor = continuation?.scope === scope ? continuation.value : undefined
  const setCursor = (value: string | undefined) => setContinuation(value ? { scope, value } : undefined)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<CommunityAttachmentDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [writeError, setWriteError] = useState(false)
  const [attachmentsError, setAttachmentsError] = useState(false)
  const [published, setPublished] = useState(false)
  const page = result?.scope === scope ? result.page : undefined
  useEffect(() => { setBusy(false) }, [authenticatedApi])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    authenticatedApi.listCommunityRequestDetails(requestId, { cursor, limit: 20 }).then(next => {
      if (!cancelled) setResult(previous => ({ scope, page: {
        items: cursor && previous?.scope === scope ? [...previous.page.items, ...next.items.filter(item => !previous.page.items.some(old => old.id === item.id))] : next.items,
        nextCursor: next.nextCursor,
      } }))
    }).catch(() => { if (!cancelled) { setResult(undefined); setError(true) } }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [authenticatedApi, requestId, scope, cursor, revision])
  async function add() {
    if (busy || !body.trim()) return
    const current = lifetime()
    const payload = { requestId, body: body.trim() }
    setBusy(true)
    setWriteError(false)
    setAttachmentsError(false)
    setPublished(false)
    try {
      const detail = await authenticatedApi.addCommunityRequestDetail(requestId, { body: payload.body, idempotencyKey: retryKey.keyFor(payload) })
      try {
        if (!await uploadCommunityAttachmentDrafts(
          authenticatedApi, requestId, attachments, detail.id, () => current.active,
        )) return
      } catch { if (current.active) setAttachmentsError(true); return }
      if (current.active) {
        retryKey.confirmed()
        setBody(''); setAttachments([]); setPublished(true)
        setCursor(undefined); setResult(undefined); setRevision(value => value + 1); onChanged()
      }
    } catch { if (current.active) setWriteError(true) }
    finally { if (current.active) setBusy(false) }
  }
  return <section className="space-y-4" aria-label="Public details">
    <h2 className="text-lg font-semibold">Public details</h2>
    {page?.items.map(item => <article key={item.id} className={panelClass}>
      <p className="whitespace-pre-wrap break-words">{item.body}</p>
      <CommunityAttachmentList requestId={requestId} attachments={item.attachments} onDeleted={() => { setCursor(undefined); setResult(undefined); setRevision(value => value + 1); onChanged() }} />
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
        <p className="text-xs text-kumo-subtle">{item.isOwn ? 'Your detail · ' : ''}{new Date(item.createdAt).toLocaleDateString()}</p>
        {item.isOwn && <DeleteOwnedDetail requestId={requestId} detailId={item.id} onDeleted={() => { setCursor(undefined); setResult(undefined); setRevision(value => value + 1); onChanged() }} />}
      </div>
    </article>)}
    {page?.items.length === 0 && <p>No details yet.</p>}
    {loading && <p role="status">Loading details…</p>}
    {error && <p role="alert">Details unavailable. <Button variant="secondary" disabled={loading} onClick={() => setRevision(n => n + 1)}>Retry details</Button></p>}
    {page?.nextCursor && <Button variant="secondary" disabled={loading} onClick={() => setCursor(page.nextCursor!)}>Load more details</Button>}
    {published && <p role="status">Your detail was published.</p>}
    <form className={panelClass} onSubmit={e => { e.preventDefault(); void add() }}>
      <label className="block">Add public details<textarea className={`${fieldClass} min-h-28`} maxLength={LIMITS.detail} required value={body} disabled={busy} onChange={e => setBody(e.target.value)} /></label>
      <CommunityAttachmentPicker drafts={attachments} onChange={setAttachments} disabled={busy} />
      <p className="text-sm text-kumo-subtle">{publicNotice}</p>
      <p className="text-sm text-kumo-subtle">Publishing makes these details and selected attachments visible to signed-in deployment users.</p>
      {writeError && <p role="alert">Could not confirm publication. Retry unchanged details. If you leave or reload, check existing details before submitting again.</p>}
      {attachmentsError && <p role="alert">The public detail was created, but one or more attachments were not confirmed. Retry unchanged to resume confirmed uploads. If the same file is rejected again, remove it before trying a new detail.</p>}
      <Button type="submit" variant="primary" disabled={busy || !body.trim()}>{busy ? 'Publishing…' : 'Publish public details'}</Button>
    </form>
  </section>
}
