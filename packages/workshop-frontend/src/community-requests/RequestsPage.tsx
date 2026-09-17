import { useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useNavigate } from '@tanstack/react-router'
import { Button, Dialog } from '@cloudflare/kumo'
import { FunnelSimple, MagnifyingGlass, Plus, X } from '@phosphor-icons/react'
import { COMMUNITY_REQUEST_LIMITS, type CommunityRequestPage, type CommunityRequestQuery } from '@gadgets/workshop-shared/community-requests'
import { useAuthenticatedApi } from '../AuthContext'
import { useDocumentTitle } from '../useDocumentTitle'
import { fieldClass, RequestLinks } from './RequestShared'
import RequestDetailPage from './RequestDetailPage'

export default function RequestsPage({ selectedRequestId }: { selectedRequestId?: string }) {
  useDocumentTitle('Feature requests')
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<CommunityRequestQuery['kind']>()
  const [status, setStatus] = useState<CommunityRequestQuery['status']>()
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 400)
    return () => clearTimeout(timer)
  }, [query])
  const filters = useMemo(() => ({ query: search, kind, status }), [search, kind, status])
  const filtered = !!query || !!kind || !!status
  const clearFilters = () => { setQuery(''); setSearch(''); setKind(undefined); setStatus(undefined) }

  return <>
    <main className="w-full space-y-6 px-4 py-6 text-kumo-default sm:px-8 lg:px-10 lg:py-10">
    <header className="flex flex-col gap-4 border-b border-kumo-line pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-[-0.025em] text-kumo-strong">Feature requests</h1>
        <p className="mt-1.5 text-sm leading-6 text-kumo-subtle">Share ideas, report problems, find related requests, and vote on what matters. Visible to everyone signed in to this deployment.</p>
      </div>
      <Button variant="primary" onClick={() => void navigate({ to: '/requests/new' })} className="shrink-0 self-start sm:self-auto">
        <Plus size={16} weight="bold" /> New feature or bug
      </Button>
    </header>

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
    {selectedRequestId && <RequestDetailSheet requestId={selectedRequestId} />}
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
  const busyRef = useRef(true)
  const [error, setError] = useState(false)
  const page = result?.scope === scope ? result.page : undefined
  useEffect(() => { busyRef.current = busy }, [busy])
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible' && !busyRef.current) {
        setContinuation(undefined)
        setRevision(value => value + 1)
      }
    }
    const timer = window.setInterval(refresh, 30_000)
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('focus', refresh)
    }
  }, [])
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
    {page && <RequestLinks items={page.items} />}
    {page?.items.length === 0 && <div className="rounded-2xl border border-dashed border-kumo-line bg-kumo-elevated px-6 py-12 text-center"><p className="font-medium text-kumo-strong">No matching requests</p><p className="mt-1 text-sm text-kumo-subtle">Try a broader search or start a new request.</p>{filtered && <Button variant="secondary" onClick={onClear}>Clear filters</Button>}</div>}
    {busy && !page && <div role="status" className="grid gap-3 md:grid-cols-2">{[0, 1, 2, 3].map(item => <div key={item} className="h-36 animate-pulse rounded-2xl border border-kumo-line bg-kumo-elevated" />)}<span className="sr-only">Loading requests…</span></div>}
    {error && <div role="alert" className="rounded-xl border border-kumo-danger/30 bg-kumo-danger/10 p-4 text-sm text-kumo-danger">Could not load requests. Please retry in a moment.</div>}
    {(error || page?.nextCursor) && <div className="flex flex-wrap gap-2">
      {error && <Button variant="secondary" disabled={busy} onClick={() => setRevision(n => n + 1)}>Retry loading</Button>}
      {page?.nextCursor && !error && <Button variant="secondary" disabled={busy} onClick={() => setCursor(page.nextCursor!)}>Load more requests</Button>}
    </div>}
  </section>
}

export function RequestDetailSheet({ requestId }: { requestId: string }) {
  const navigate = useNavigate()
  const close = () => navigate({ to: '/requests', replace: true })
  return <Dialog.Root open onOpenChange={open => { if (!open) void close() }}>
    <Dialog
      size="lg"
      className="!fixed !inset-y-0 !left-auto !right-0 !top-0 !z-[1000] flex !h-dvh !max-h-dvh !w-full !max-w-none !translate-x-0 !translate-y-0 flex-col overflow-hidden !rounded-none border-l border-kumo-line bg-kumo-base p-0 shadow-2xl md:!inset-y-3 md:!right-3 md:!top-3 md:!h-[calc(100dvh-1.5rem)] md:!max-h-[calc(100dvh-1.5rem)] md:!w-[min(760px,calc(100vw-304px))] md:!rounded-2xl md:border"
    >
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-kumo-line px-4 sm:px-6">
        <div>
          <Dialog.Title className="text-base font-semibold text-kumo-strong">Feature request details</Dialog.Title>
          <Dialog.Description className="text-xs text-kumo-subtle">Review, vote, and manage your own public details without leaving the board.</Dialog.Description>
        </div>
        <Dialog.Close render={props => <button {...props} type="button" aria-label="Close feature request" className="flex h-9 w-9 items-center justify-center rounded-lg text-kumo-subtle transition hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-ring"><X size={18} /></button>} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <RequestDetailPage requestId={requestId} onBack={() => { void close() }} />
      </div>
    </Dialog>
  </Dialog.Root>
}
