import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Button } from '@cloudflare/kumo'
import { COMMUNITY_REQUEST_LIMITS, type CommunityRequest } from '@gadgets/workshop-shared/community-requests'
import { useAuthenticatedApi } from '../AuthContext'

export const fieldClass = 'block w-full rounded-lg border border-kumo-line bg-kumo-base p-3 text-sm text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-ring'
export const panelClass = 'rounded-xl border border-kumo-line bg-kumo-base p-4 space-y-4'
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
  return <ul className="space-y-3">
    {items.map(item => <li key={item.id} className={panelClass}>
      <Link to="/requests/$requestId" params={{ requestId: item.id }} search={{ moderate }} className="break-words font-semibold text-kumo-brand underline decoration-transparent hover:decoration-current focus-visible:outline-2">
        {item.title}
      </Link>
      <p className="text-xs text-kumo-subtle">{item.kind === 'bug' ? 'Bug' : 'Feature'} · {item.status} · {item.voteCount} votes{item.viewerHasVoted ? ' · You voted' : ''}{item.isOwn ? ' · Your request' : ''}{item.hidden ? ' · Hidden' : ''}{item.duplicateOf ? ' · Duplicate' : ''}</p>
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
