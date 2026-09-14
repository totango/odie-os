import { useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Button } from '@cloudflare/kumo'
import { COMMUNITY_REQUEST_LIMITS, type CommunityRequestPage, type CommunityRequestQuery } from '@gadgets/workshop-shared/community-requests'
import { useAuthenticatedApi } from '../AuthContext'
import { useDocumentTitle } from '../useDocumentTitle'
import { fieldClass, RequestLinks } from './RequestShared'
import { PrivateFeedbackHistory } from './PrivateFeedbackHistory'

export default function RequestsPage({ moderate = false }: { moderate?: boolean }) {
  useDocumentTitle('Community requests')
  const { isAdmin } = useAuthenticatedApi()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<CommunityRequestQuery['kind']>()
  const [status, setStatus] = useState<CommunityRequestQuery['status']>()
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 400)
    return () => clearTimeout(timer)
  }, [query])
  const filters = useMemo(() => ({ query: search, kind, status, ...(isAdmin && moderate ? { includeHidden: true } : {}) }), [search, kind, status, isAdmin, moderate])
  return <main className="mx-auto w-full max-w-3xl space-y-6 p-4 text-kumo-default sm:p-8">
    <header className="space-y-3">
      <h1 className="text-2xl font-semibold">Community requests</h1>
      <p className="text-sm text-kumo-subtle">Features and public bug summaries for everyone signed in to this deployment. No GitHub connection required.</p>
      <Link to="/requests/new" className="inline-block rounded-lg bg-kumo-brand px-4 py-2 font-medium text-kumo-inverse">Submit a request or bug</Link>
      {isAdmin && <p><Link to="/requests" search={{ moderate: !moderate }} className="text-sm text-kumo-brand underline">{moderate ? 'Leave moderation view' : 'Moderate requests (including hidden)'}</Link></p>}
      {isAdmin && moderate && <p className="text-sm text-kumo-subtle">Moderation uses existing deployment admin checks. Dynamic admin management and revocation are not implemented.</p>}
    </header>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="sm:col-span-2">Search public requests<input type="search" className={fieldClass} maxLength={COMMUNITY_REQUEST_LIMITS.query} value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label>Request type<select className={fieldClass} value={kind ?? ''} onChange={e => setKind(e.target.value === 'bug' ? 'bug' : e.target.value === 'feature' ? 'feature' : undefined)}><option value="">All types</option><option value="feature">Features</option><option value="bug">Bugs</option></select></label>
      <label>Status<select className={fieldClass} value={status ?? ''} onChange={e => setStatus(e.target.value === 'open' ? 'open' : e.target.value === 'closed' ? 'closed' : undefined)}><option value="">All statuses</option><option value="open">Open</option><option value="closed">Closed</option></select></label>
    </div>
    <RequestResults key={JSON.stringify(filters)} filters={filters} />
    <PrivateFeedbackHistory />
  </main>
}

function RequestResults({ filters }: { filters: CommunityRequestQuery }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const scope = useMemo(() => ({ api: authenticatedApi, filters }), [authenticatedApi, filters])
  const [result, setResult] = useState<{ scope: typeof scope; page: CommunityRequestPage }>()
  const [continuation, setContinuation] = useState<{ scope: typeof scope; value: string }>()
  const cursor = continuation?.scope === scope ? continuation.value : undefined
  const setCursor = (value: string | undefined) => setContinuation(value ? { scope, value } : undefined)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState(false)
  const page = result?.scope === scope ? result.page : undefined
  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setError(false)
    const options = { ...filters, cursor, limit: 20 }
    const call = filters.query ? authenticatedApi.searchCommunityRequests(options) : authenticatedApi.listCommunityRequests(options)
    call.then(next => {
      if (!cancelled) setResult(previous => ({ scope, page: {
        items: cursor && previous?.scope === scope ? [...previous.page.items, ...next.items.filter(item => !previous.page.items.some(old => old.id === item.id))] : next.items,
        nextCursor: next.nextCursor,
      } }))
    }).catch(() => { if (!cancelled) setError(true) }).finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [authenticatedApi, filters, scope, cursor, revision])
  return <section aria-label="Requests" className="space-y-4" aria-busy={busy}>
    {page && <RequestLinks items={page.items} moderate={filters.includeHidden} />}
    {page?.items.length === 0 && <p>No matching requests. Try another search or submit a new one.</p>}
    {busy && <p role="status">Loading requests…</p>}
    {error && <p role="alert">Could not load requests. Please retry in a moment.</p>}
    <div className="flex gap-2">
      <Button variant="secondary" disabled={busy} onClick={() => { setCursor(undefined); setResult(undefined); setRevision(n => n + 1) }}>Refresh requests</Button>
      {error && <Button variant="secondary" disabled={busy} onClick={() => setRevision(n => n + 1)}>Retry loading</Button>}
      {page?.nextCursor && !error && <Button variant="secondary" disabled={busy} onClick={() => setCursor(page.nextCursor!)}>Load more requests</Button>}
    </div>
  </section>
}
