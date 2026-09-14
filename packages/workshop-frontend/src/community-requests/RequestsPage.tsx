import { useEffect, useMemo, useState } from 'react'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { Button, Dialog } from '@cloudflare/kumo'
import { FunnelSimple, MagnifyingGlass, Plus, ShieldCheck, X } from '@phosphor-icons/react'
import { COMMUNITY_REQUEST_LIMITS, type CommunityRequestPage, type CommunityRequestQuery } from '@gadgets/workshop-shared/community-requests'
import { useAuthenticatedApi } from '../AuthContext'
import { useDocumentTitle } from '../useDocumentTitle'
import { fieldClass, RequestLinks } from './RequestShared'
import RequestDetailPage from './RequestDetailPage'

export default function RequestsPage({ moderate = false, selectedRequestId }: { moderate?: boolean; selectedRequestId?: string }) {
  useDocumentTitle('Feature requests')
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
  const filtered = !!query || !!kind || !!status
  const clearFilters = () => { setQuery(''); setSearch(''); setKind(undefined); setStatus(undefined) }

  return <>
    <main className="w-full space-y-6 px-4 py-6 text-kumo-default sm:px-8 lg:px-10 lg:py-10">
    <header className="flex flex-col gap-4 border-b border-kumo-line pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-[-0.025em] text-kumo-strong">Feature requests</h1>
        <p className="mt-1.5 text-sm leading-6 text-kumo-subtle">Share ideas, report problems, find related requests, and vote on what matters. Visible to everyone signed in to this deployment.</p>
        {isAdmin && <Link to="/requests" search={{ moderate: !moderate }} className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-kumo-brand hover:underline"><ShieldCheck size={14} />{moderate ? 'Leave moderation view' : 'Review hidden requests'}</Link>}
      </div>
      <Link to="/requests/new" className="inline-flex h-10 shrink-0 items-center justify-center gap-2 self-start rounded-lg bg-kumo-brand px-4 text-sm font-semibold text-kumo-inverse shadow-sm transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-kumo-ring sm:self-auto">
        <Plus size={16} weight="bold" /> New feature or bug
      </Link>
    </header>

    {isAdmin && moderate && <div className="flex items-start gap-3 rounded-xl border border-kumo-warning/30 bg-kumo-warning/10 px-4 py-3 text-sm">
      <ShieldCheck size={18} weight="fill" className="mt-0.5 shrink-0 text-kumo-warning" />
      <div><p className="font-medium text-kumo-strong">Moderation view is active</p><p className="text-kumo-subtle">Hidden requests are included and clearly marked. Your current administrator authority is checked again for every moderation action.</p></div>
    </div>}

    <section aria-label="Search and filter requests" className="rounded-2xl border border-kumo-line bg-kumo-base p-4 shadow-sm sm:p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-kumo-strong"><FunnelSimple size={17} /> Find requests</div>
      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_180px_auto] lg:items-end">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-kumo-subtle">Search titles, descriptions, and details</span>
          <span className="relative block">
            <MagnifyingGlass size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive" />
            <input type="search" className={`${fieldClass} pl-10 pr-10`} maxLength={COMMUNITY_REQUEST_LIMITS.query} value={query} placeholder="Search requests…" onChange={e => setQuery(e.target.value)} />
            {query && <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); setSearch('') }} className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-kumo-inactive hover:bg-kumo-tint hover:text-kumo-default"><X size={14} /></button>}
          </span>
        </label>
        <label className="block"><span className="mb-1.5 block text-xs font-medium text-kumo-subtle">Type</span><select aria-label="Request type" className={fieldClass} value={kind ?? ''} onChange={e => setKind(e.target.value === 'bug' ? 'bug' : e.target.value === 'feature' ? 'feature' : undefined)}><option value="">All types</option><option value="feature">Feature requests</option><option value="bug">Bug reports</option></select></label>
        <label className="block"><span className="mb-1.5 block text-xs font-medium text-kumo-subtle">Status</span><select aria-label="Request status" className={fieldClass} value={status ?? ''} onChange={e => setStatus(e.target.value === 'open' ? 'open' : e.target.value === 'closed' ? 'closed' : undefined)}><option value="">Any status</option><option value="open">Open</option><option value="closed">Closed</option></select></label>
        <Button variant="secondary" disabled={!filtered} onClick={clearFilters}>Clear filters</Button>
      </div>
      {query.trim() !== search && <p role="status" className="mt-2 text-xs text-kumo-subtle">Updating search…</p>}
    </section>

    <RequestResults key={JSON.stringify(filters)} filters={filters} filtered={filtered} onClear={clearFilters} />
    </main>
    {selectedRequestId && <RequestDetailSheet requestId={selectedRequestId} moderate={moderate} />}
    <Outlet />
  </>
}

function RequestResults({ filters, filtered, onClear }: { filters: CommunityRequestQuery; filtered: boolean; onClear: () => void }) {
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
  return <section aria-label="Feature requests" className="space-y-4" aria-busy={busy}>
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold text-kumo-strong">Feature requests</h2>{page && <span className="text-xs text-kumo-subtle">{page.items.length}{page.nextCursor ? '+' : ''} shown</span>}</div>
    {page && <RequestLinks items={page.items} moderate={filters.includeHidden} />}
    {page?.items.length === 0 && <div className="rounded-2xl border border-dashed border-kumo-line bg-kumo-elevated px-6 py-12 text-center"><p className="font-medium text-kumo-strong">No matching requests</p><p className="mt-1 text-sm text-kumo-subtle">Try a broader search or start a new request.</p>{filtered && <Button variant="secondary" onClick={onClear}>Clear filters</Button>}</div>}
    {busy && !page && <div role="status" className="grid gap-3 md:grid-cols-2">{[0, 1, 2, 3].map(item => <div key={item} className="h-36 animate-pulse rounded-2xl border border-kumo-line bg-kumo-elevated" />)}<span className="sr-only">Loading requests…</span></div>}
    {busy && page && <p role="status" className="text-sm text-kumo-subtle">Refreshing requests…</p>}
    {error && <div role="alert" className="rounded-xl border border-kumo-danger/30 bg-kumo-danger/10 p-4 text-sm text-kumo-danger">Could not load requests. Please retry in a moment.</div>}
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" disabled={busy} onClick={() => { setCursor(undefined); setResult(undefined); setRevision(n => n + 1) }}>Refresh requests</Button>
      {error && <Button variant="secondary" disabled={busy} onClick={() => setRevision(n => n + 1)}>Retry loading</Button>}
      {page?.nextCursor && !error && <Button variant="secondary" disabled={busy} onClick={() => setCursor(page.nextCursor!)}>Load more requests</Button>}
    </div>
  </section>
}

export function RequestDetailSheet({ requestId, moderate }: { requestId: string; moderate: boolean }) {
  const navigate = useNavigate()
  const close = () => navigate({ to: '/requests', search: { moderate: moderate || undefined }, replace: true })
  return <Dialog.Root open onOpenChange={open => { if (!open) void close() }}>
    <Dialog
      size="lg"
      className="!fixed !inset-y-0 !left-auto !right-0 !top-0 !z-[1000] !h-dvh !max-h-dvh !w-full !max-w-none !translate-x-0 !translate-y-0 overflow-hidden !rounded-none border-l border-kumo-line bg-kumo-base p-0 shadow-2xl md:!w-[min(760px,calc(100vw-280px))]"
    >
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-kumo-line px-4 sm:px-6">
        <div>
          <Dialog.Title className="text-base font-semibold text-kumo-strong">Feature request details</Dialog.Title>
          <Dialog.Description className="text-xs text-kumo-subtle">Review, vote, add details, or moderate without leaving the board.</Dialog.Description>
        </div>
        <Dialog.Close render={props => <button {...props} type="button" aria-label="Close feature request" className="flex h-9 w-9 items-center justify-center rounded-lg text-kumo-subtle transition hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-ring"><X size={18} /></button>} />
      </header>
      <div className="h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain">
        <RequestDetailPage requestId={requestId} moderate={moderate} onBack={() => { void close() }} />
      </div>
    </Dialog>
  </Dialog.Root>
}
