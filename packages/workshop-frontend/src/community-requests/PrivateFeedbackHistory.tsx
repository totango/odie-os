import { useEffect, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import type { ProductFeedbackStatus } from '@gadgets/workshop-shared/product-feedback'
import { useAuthenticatedApi } from '../AuthContext'

/** Read-only owner-private compatibility surface, never a second submission path. */
export function PrivateFeedbackHistory() {
  const { authenticatedApi } = useAuthenticatedApi()
  const [open, setOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{ api: typeof authenticatedApi; items: ProductFeedbackStatus[] }>()
  const statuses = result?.api === authenticatedApi ? result.items : undefined
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setResult(undefined); setError(false)
    authenticatedApi.listProductFeedbackStatuses().then(items => { if (!cancelled) setResult({ api: authenticatedApi, items }) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [authenticatedApi, open, revision])
  return <section className="space-y-3 border-t border-kumo-line pt-5" aria-label="Private feedback history">
    <Button variant="secondary" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide private feedback history' : 'View my legacy private feedback status'}</Button>
    {open && <>
      <h2 className="font-semibold">Your legacy private feedback</h2>
      <p className="text-sm text-kumo-subtle">Owner-only status for earlier private reports. These reports are not imported into the board. New requests use the public form above and never start the legacy PR bot.</p>
      {!statuses && !error && <p role="status">Loading private status…</p>}
      {error && <p role="alert">Private feedback history is unavailable for this account or connection.</p>}
      {statuses?.length === 0 && <p>No legacy private feedback.</p>}
      <ul className="space-y-3">{statuses?.map(status => <li key={status.id} className="rounded-lg border border-kumo-line p-3">
        <p className="break-words font-medium">{status.title} · {status.state}</p>
        {status.message && <p className="whitespace-pre-wrap break-words text-sm">{status.message}</p>}
        {safeLegacyPrUrl(status.prUrl) && <a href={status.prUrl} target="_blank" rel="noreferrer" className="text-kumo-brand underline">Open legacy draft PR</a>}
      </li>)}</ul>
      <Button variant="secondary" onClick={() => setRevision(n => n + 1)}>Refresh private status</Button>
    </>}
  </section>
}

function safeLegacyPrUrl(value: string | undefined): boolean {
  return typeof value === 'string' && /^https:\/\/github\.com\/totango\/odie-os\/pull\/[1-9]\d*$/.test(value)
}
