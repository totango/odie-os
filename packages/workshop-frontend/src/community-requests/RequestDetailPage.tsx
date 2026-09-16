import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Button } from '@cloudflare/kumo'
import { COMMUNITY_REQUEST_LIMITS as LIMITS, type CommunityRequest, type CommunityRequestDetailPage, type CommunityRequestPrivateDiagnostics, type ModerateCommunityRequest } from '@gadgets/workshop-shared/community-requests'
import { useAuthenticatedApi } from '../AuthContext'
import { useDocumentTitle } from '../useDocumentTitle'
import { RequestBuildPanel } from './RequestBuildPanel'
import { fieldClass, panelClass, publicNotice, RelatedRequests, RequestVote, useRequestLifetime, useRequestRetryKey } from './RequestShared'
import { CommunityAttachmentList, CommunityAttachmentPicker, uploadCommunityAttachmentDrafts, type CommunityAttachmentDraft } from './CommunityRequestAttachments'

export default function RequestDetailPage({ requestId, moderate = false, onBack }: { requestId: string; moderate?: boolean; onBack?: () => void }) {
  const { authenticatedApi, isAdmin } = useAuthenticatedApi()
  const navigate = useNavigate()
  const includeHidden = isAdmin && moderate
  const scope = useMemo(() => ({ api: authenticatedApi, requestId, includeHidden }), [authenticatedApi, requestId, includeHidden])
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
    authenticatedApi.getCommunityRequest(requestId, includeHidden).then(value => {
      if (!cancelled) setResult({ scope, request: value })
    }).catch(() => { if (!cancelled) { setResult(undefined); setError(true) } }).finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [authenticatedApi, scope, requestId, includeHidden, revision])
  return <div className="w-full space-y-6 p-4 text-kumo-default sm:p-6">
    {onBack
      ? <button type="button" onClick={onBack} className="text-kumo-brand underline">All feature requests</button>
      : <Link to="/requests" search={{ moderate: includeHidden }} className="text-kumo-brand underline">All feature requests</Link>}
    {isAdmin && <p><Link to="/requests/$requestId" params={{ requestId }} search={{ moderate: !includeHidden }} replace className="text-sm text-kumo-brand underline">{includeHidden ? 'Leave moderation view' : 'Open moderation view'}</Link></p>}
    {busy && <p role="status">Loading request…</p>}
    {error && <p role="alert">Could not load this request. Please retry in a moment.</p>}
    {request === null && <h1 className="text-xl font-semibold">Request unavailable or hidden</h1>}
    <Button variant="secondary" disabled={busy} onClick={() => setRevision(n => n + 1)}>Refresh request</Button>
    {request && <>
      <article className={panelClass}>
        <h1 className="break-words text-2xl font-semibold">{request.title}</h1>
        <p className="text-sm text-kumo-subtle">{request.kind === 'bug' ? 'Public bug summary' : 'Feature request'} · {request.status}{request.hidden ? ' · Hidden from the board' : ''}{request.isOwn ? ' · Your request' : ''}</p>
        <p className="whitespace-pre-wrap break-words">{request.body}</p>
        <CommunityAttachmentList requestId={request.id} attachments={request.attachments} includeHidden={includeHidden} />
        {request.duplicateOf && <p>Duplicate of <Link to="/requests/$requestId" params={{ requestId: request.duplicateOf }} search={{ moderate: includeHidden }} replace className="text-kumo-brand underline">canonical request</Link></p>}
        <RequestVote request={request} onChange={value => setResult({ scope, request: value })} />
        {request.isOwn && <DeleteOwnedRequest requestId={request.id} onDeleted={() => { if (onBack) onBack(); else void navigate({ to: '/requests', replace: true }) }} />}
      </article>
      {includeHidden && <PrivateDiagnostics key={`diagnostics:${request.id}`} requestId={request.id} />}
      {includeHidden && <RequestModeration key={request.id} request={request} onChange={value => setResult({ scope, request: value })} />}
      {!request.hidden && <RequestBuildPanel key={`builds:${request.id}`} requestId={request.id} moderate={includeHidden} />}
      <RequestDetails key={`${request.id}:${includeHidden}:${request.hidden}`} requestId={request.id} includeHidden={includeHidden} hidden={request.hidden} />
      {!request.hidden && <RelatedRequests text={`${request.title}\n${request.body}`} excludeId={request.id} />}
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
  return <div className="space-y-3 rounded-xl border border-kumo-danger/30 bg-kumo-danger/10 p-4">
    <p className="text-sm text-kumo-default"><strong>Delete this request?</strong> It will disappear from the public board. Its public text, details, attachments, votes, and private diagnostics will be scrubbed, and it cannot be restored.</p>
    {error && <p role="alert" className="text-sm text-kumo-danger">Could not delete this request. Retry or cancel.</p>}
    <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={busy} onClick={() => { setConfirming(false); setError(false) }}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Confirm deletion'}</Button></div>
  </div>
}

function PrivateDiagnostics({ requestId }: { requestId: string }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [result, setResult] = useState<{ api: typeof authenticatedApi; value: CommunityRequestPrivateDiagnostics | null }>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    authenticatedApi.getCommunityRequestPrivateDiagnostics(requestId).then(value => {
      if (!cancelled) setResult({ api: authenticatedApi, value })
    }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [authenticatedApi, requestId])
  if (failed) return <p role="alert" className="text-sm text-kumo-danger">Private diagnostics could not be loaded.</p>
  const evidence = result?.api === authenticatedApi ? result.value : undefined
  if (evidence === undefined) return <p role="status" className="text-sm text-kumo-subtle">Loading private diagnostics…</p>
  if (evidence === null) return null
  return <details className={panelClass}>
    <summary className="cursor-pointer font-semibold text-kumo-strong">Private bug diagnostics ({evidence.diagnostics.length})</summary>
    <div className="space-y-3 text-sm"><p className="text-kumo-subtle">Captured from <code>{evidence.pathname}</code>. Expires {evidence.expiresAt.toLocaleDateString()}. Visible only to current administrators and excluded from public search and Auto-Build.</p>
      {evidence.diagnostics.length === 0 ? <p>No current-tab entries were available at submission.</p> : <ul className="max-h-80 space-y-2 overflow-auto">{evidence.diagnostics.map((entry, index) => <li key={`${entry.timestamp.valueOf()}:${index}`} className="rounded-lg bg-kumo-elevated p-3"><span className="text-xs font-semibold uppercase text-kumo-subtle">{entry.level} · {entry.timestamp.toLocaleString()}</span><pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-kumo-default">{entry.message}</pre></li>)}</ul>}
    </div>
  </details>
}

function RequestDetails({ requestId, includeHidden, hidden }: { requestId: string; includeHidden: boolean; hidden: boolean }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const lifetime = useRequestLifetime()
  const retryKey = useRequestRetryKey()
  const scope = useMemo(() => ({ api: authenticatedApi, requestId, includeHidden, hidden }), [authenticatedApi, requestId, includeHidden, hidden])
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
    authenticatedApi.listCommunityRequestDetails(requestId, { includeHidden, cursor, limit: 20 }).then(next => {
      if (!cancelled) setResult(previous => ({ scope, page: {
        items: cursor && previous?.scope === scope ? [...previous.page.items, ...next.items.filter(item => !previous.page.items.some(old => old.id === item.id))] : next.items,
        nextCursor: next.nextCursor,
      } }))
    }).catch(() => { if (!cancelled) { setResult(undefined); setError(true) } }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [authenticatedApi, requestId, includeHidden, scope, cursor, revision])
  async function add() {
    if (busy || !body.trim() || hidden) return
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
        setCursor(undefined); setResult(undefined); setRevision(n => n + 1)
      }
    } catch { if (current.active) setWriteError(true) }
    finally { if (current.active) setBusy(false) }
  }
  return <section className="space-y-4" aria-label="Public details">
    <h2 className="text-lg font-semibold">Public details</h2>
    {page?.items.map(item => <article key={item.id} className={panelClass}><p className="whitespace-pre-wrap break-words">{item.body}</p><CommunityAttachmentList requestId={requestId} attachments={item.attachments} includeHidden={includeHidden} /><p className="text-xs text-kumo-subtle">{item.isOwn ? 'Your detail · ' : ''}{new Date(item.createdAt).toLocaleDateString()}</p></article>)}
    {page?.items.length === 0 && <p>No details yet.</p>}
    {loading && <p role="status">Loading details…</p>}
    {error && <p role="alert">Details unavailable. <Button variant="secondary" disabled={loading} onClick={() => setRevision(n => n + 1)}>Retry details</Button></p>}
    {page?.nextCursor && <Button variant="secondary" disabled={loading} onClick={() => setCursor(page.nextCursor!)}>Load more details</Button>}
    {published && <p role="status">Your detail was published.</p>}
    {!hidden && <form className={panelClass} onSubmit={e => { e.preventDefault(); void add() }}>
      <label className="block">Add public details<textarea className={`${fieldClass} min-h-28`} maxLength={LIMITS.detail} required value={body} disabled={busy} onChange={e => setBody(e.target.value)} /></label>
      <CommunityAttachmentPicker drafts={attachments} onChange={setAttachments} disabled={busy} />
      <p className="text-sm text-kumo-subtle">{publicNotice}</p>
      <p className="text-sm text-kumo-subtle">Publishing makes these details and selected attachments visible to signed-in deployment users.</p>
      {writeError && <p role="alert">Could not confirm publication. Retry unchanged details. If you leave or reload, check existing details before submitting again.</p>}
      {attachmentsError && <p role="alert">The public detail was created, but one or more attachments were not confirmed. Retry unchanged to resume confirmed uploads. If the same file is rejected again, remove it before trying a new detail.</p>}
      <Button type="submit" variant="primary" disabled={busy || !body.trim()}>{busy ? 'Publishing…' : 'Publish public details'}</Button>
    </form>}
  </section>
}

function RequestModeration({ request, onChange }: { request: CommunityRequest; onChange: (request: CommunityRequest) => void }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const lifetime = useRequestLifetime()
  const retryKey = useRequestRetryKey()
  const [action, setAction] = useState<ModerateCommunityRequest['action']>('close')
  const [duplicateOf, setDuplicateOf] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => { setBusy(false) }, [authenticatedApi])
  async function moderate() {
    if (busy || !confirmed || (action === 'duplicate' && !duplicateOf.trim())) return
    const current = lifetime()
    const payload = { action, ...(action === 'duplicate' ? { duplicateOf: duplicateOf.trim() } : {}) }
    setBusy(true); setError(false)
    try {
      const updated = await authenticatedApi.moderateCommunityRequest(request.id, { ...payload, idempotencyKey: retryKey.keyFor({ requestId: request.id, ...payload }) })
      if (current.active) { retryKey.confirmed(); onChange(updated); setConfirmed(false) }
    } catch { if (current.active) setError(true) }
    finally { if (current.active) setBusy(false) }
  }
  return <form className={panelClass} aria-label="Moderate request" onSubmit={e => { e.preventDefault(); void moderate() }}>
    <h2 className="font-semibold">Moderate request</h2>
    <p className="text-sm text-kumo-subtle">Your current administrator authority is checked on the server. Hide removes the entire request and its details from ordinary board reads; restore makes moderator-hidden requests visible again. Author-deleted requests cannot be restored. Reopen clears duplicate status.</p>
    <label className="block">Moderation action<select className={fieldClass} value={action} disabled={busy} onChange={e => { setAction(e.target.value as ModerateCommunityRequest['action']); setConfirmed(false) }}>
      <option value="close">Close</option><option value="reopen">Reopen</option><option value="hide">Hide</option><option value="restore">Restore</option><option value="duplicate">Mark as duplicate</option>
    </select></label>
    {action === 'duplicate' && <label className="block">Canonical request ID<input className={fieldClass} maxLength={100} required disabled={busy} value={duplicateOf} onChange={e => { setDuplicateOf(e.target.value); setConfirmed(false) }} /><span className="text-xs text-kumo-subtle">Copy the ID from the canonical request’s board URL. The server rejects hidden targets, self-links and duplicate chains.</span></label>}
    <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} className="mt-1" />Confirm this moderation action</label>
    {error && <p role="alert">Could not confirm moderation. Check your admin access and canonical target, or retry the unchanged action.</p>}
    <Button type="submit" variant="secondary" disabled={busy || !confirmed || (action === 'duplicate' && !duplicateOf.trim())}>Apply moderation</Button>
  </form>
}
