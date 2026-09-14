import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Button } from '@cloudflare/kumo'
import { ArrowUp, Bug, Lightbulb } from '@phosphor-icons/react'
import { COMMUNITY_REQUEST_LIMITS, type CommunityRequest } from '@gadgets/workshop-shared/community-requests'
import { useAuthenticatedApi } from '../AuthContext'

export const fieldClass = 'block h-11 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-sm text-kumo-default shadow-sm transition focus:border-kumo-brand focus-visible:outline-2 focus-visible:outline-kumo-ring'
export const panelClass = 'rounded-2xl border border-kumo-line bg-kumo-base p-5 shadow-sm space-y-4'
export const publicNotice = 'Public here means all signed-in users of this deployment. Only the text you write is published; no private diagnostics, chats, workspace or Code Session context is attached. Do not paste secrets or personal information.'

/** The AuthProvider owns the API stub; board calls return values, not child capabilities.
 * Cleanup also runs when React Activity hides the authenticated tree on reconnect. */
export function useRequestLifetime() {
  const { authenticatedApi } = useAuthenticatedApi()
  const lifetime = useRef({ active: false })
  useEffect(() => {
    const current = { active: true }
    lifetime.current = current
    return () => { current.active = false }
  }, [authenticatedApi])
  return () => lifetime.current
}

/** Keep the exact key for an uncertain write's unchanged payload, until confirmed.
 * No authored text is persisted in browser storage or logged from RPC exceptions. */
export function useRequestRetryKey() {
  const pending = useRef<{ payload: string; key: string } | null>(null)
  return {
    keyFor(payload: unknown) {
      const canonical = JSON.stringify(payload)
      if (pending.current?.payload !== canonical) pending.current = { payload: canonical, key: crypto.randomUUID() }
      return pending.current.key
    },
    confirmed() { pending.current = null },
  }
}

export function RequestLinks({ items, moderate = false }: { items: CommunityRequest[]; moderate?: boolean }) {
  return <ul className="grid gap-3 md:grid-cols-2">
    {items.map(item => <li key={item.id}>
      <Link to="/requests/$requestId" params={{ requestId: item.id }} search={{ moderate }} className="group flex h-full min-h-40 flex-col rounded-2xl border border-kumo-line bg-kumo-base p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-kumo-brand/40 hover:shadow-md focus-visible:outline-2 focus-visible:outline-kumo-ring">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-kumo-fill px-2 py-1 text-[11px] font-medium text-kumo-strong">{item.kind === 'bug' ? <Bug size={12} weight="fill" /> : <Lightbulb size={12} weight="fill" />}{item.kind === 'bug' ? 'Bug' : 'Feature'}</span>
            <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${item.status === 'open' ? 'bg-kumo-success/10 text-kumo-success' : 'bg-kumo-tint text-kumo-subtle'}`}>{item.status === 'open' ? 'Open' : 'Closed'}</span>
            {item.hidden && <span className="rounded-full bg-kumo-warning/10 px-2 py-1 text-[11px] font-medium text-kumo-warning">Hidden</span>}
            {item.duplicateOf && <span className="rounded-full bg-kumo-tint px-2 py-1 text-[11px] font-medium text-kumo-subtle">Duplicate</span>}
          </div>
          <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${item.viewerHasVoted ? 'border-kumo-brand/30 bg-kumo-brand/10 text-kumo-brand' : 'border-kumo-line text-kumo-subtle'}`}><ArrowUp size={12} weight="bold" /> {item.voteCount}</span>
        </div>
        <h3 className="mt-4 break-words text-base font-semibold leading-6 text-kumo-strong transition-colors group-hover:text-kumo-brand">{item.title}</h3>
        {item.body && <p className="mt-2 line-clamp-2 break-words text-sm leading-5 text-kumo-subtle">{item.body}</p>}
        <div className="mt-auto flex flex-wrap gap-2 pt-4 text-[11px] text-kumo-inactive">
          {item.isOwn && <span>Your request</span>}
          {item.viewerHasVoted && <span>You voted</span>}
        </div>
      </Link>
    </li>)}
  </ul>
}

export function RelatedRequests({ text: authoredText, excludeId }: { text: string; excludeId?: string }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const text = authoredText.trim().slice(0, COMMUNITY_REQUEST_LIMITS.query)
  const [result, setResult] = useState<{ api: typeof authenticatedApi; excludeId?: string; text: string; items?: CommunityRequest[]; failed?: boolean }>()
  useEffect(() => {
    if (!text.trim()) return
    let cancelled = false
    const timer = setTimeout(() => {
      authenticatedApi.suggestRelatedCommunityRequests(text, excludeId).then(items => {
        if (!cancelled) setResult({ api: authenticatedApi, excludeId, text, items })
      }).catch(() => { if (!cancelled) setResult({ api: authenticatedApi, excludeId, text, failed: true }) })
    }, 600)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [authenticatedApi, text, excludeId])
  if (!text.trim()) return null
  return <section aria-label="Related requests" className="space-y-3">
    <h2 className="font-semibold">Possible duplicates and related requests</h2>
    <p className="text-sm text-kumo-subtle">Consider voting or adding details to an existing request instead.</p>
    {result?.api !== authenticatedApi || result?.excludeId !== excludeId || result?.text !== text ? <p role="status">Looking for related requests…</p>
      : result.failed ? <p role="status">Suggestions unavailable. You can still review and publish your request.</p>
      : result.items?.length ? <RequestLinks items={result.items} /> : <p className="text-sm">No related requests found.</p>}
  </section>
}

export function RequestVote({ request, onChange }: { request: CommunityRequest; onChange: (request: CommunityRequest) => void }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const lifetime = useRequestLifetime()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  async function vote() {
    if (busy) return
    const current = lifetime()
    setBusy(true)
    setError(false)
    try {
      const updated = await (request.viewerHasVoted ? authenticatedApi.unvoteCommunityRequest(request.id) : authenticatedApi.voteCommunityRequest(request.id))
      if (current.active) onChange(updated)
    } catch { if (current.active) setError(true) }
    finally { if (current.active) setBusy(false) }
  }
  useEffect(() => { setBusy(false) }, [authenticatedApi])
  return <div className="space-y-2">
    <Button variant="secondary" aria-pressed={request.viewerHasVoted} disabled={busy || request.hidden} onClick={vote}>
      {request.viewerHasVoted ? 'Remove upvote' : 'Upvote'} ({request.voteCount})
    </Button>
    {error && <p role="alert">Could not confirm your vote. Retry to apply the same choice.</p>}
  </div>
}
