import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Button } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AdminApi, PublicRequestBuild, StartRequestBuild, CancelRequestBuild } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import { panelClass } from './RequestShared'

type Readiness = Awaited<ReturnType<AdminApi['getRequestBuildReadiness']>>
type Mutation = { kind: 'start'; input: StartRequestBuild } | { kind: 'cancel'; input: CancelRequestBuild }

/** Public reads need no connector. Only this mounted admin panel owns the private admin stub. */
export function RequestBuildPanel({ requestId, runId, moderate = false }: { requestId: string; runId?: string; moderate?: boolean }) {
  const { authenticatedApi, isAdmin } = useAuthenticatedApi()
  const scope = useMemo(() => ({ authenticatedApi, isAdmin, requestId, runId }), [authenticatedApi, isAdmin, requestId, runId])
  const [revision, setRevision] = useState(0)
  const [data, setData] = useState<{ scope: typeof scope; runs: PublicRequestBuild[]; readiness?: Readiness }>()
  const [admin, setAdmin] = useState<{ scope: typeof scope; api: RpcStub<AdminApi> }>()
  const [problem, setProblem] = useState<{ scope: typeof scope; message: string }>()
  const [pending, setPending] = useState<{ scope: typeof scope; mutation: Mutation }>()
  const [busy, setBusy] = useState(false)
  const token = useRef<{ active: boolean; scope: typeof scope } | null>(null)
  const lock = useRef(false)
  const current = data?.scope === scope ? data : undefined
  const capability = admin?.scope === scope ? admin.api : undefined
  const retry = pending?.scope === scope ? pending.mutation : undefined
  useEffect(() => {
    const life = { active: true, scope }
    token.current = life; lock.current = false
    setBusy(false); setData(undefined); setAdmin(undefined); setProblem(undefined)
    let owned: RpcStub<AdminApi> | null = null
    ;(async () => {
      try {
        const runs = runId ? await authenticatedApi.getRequestBuild(requestId, runId).then(value => value ? [value] : []) : await authenticatedApi.listRequestBuilds(requestId)
        if (!life.active) return
        setData({ scope, runs })
        if (isAdmin) {
          const api = await authenticatedApi.getAdminApi()
          if (!life.active) { api?.[Symbol.dispose](); return }
          owned = api
          if (!api) throw new Error('unavailable')
          setAdmin({ scope, api })
          const readiness = await api.getRequestBuildReadiness(requestId)
          if (life.active) setData({ scope, runs, readiness })
        }
      } catch { if (life.active) setProblem({ scope, message: 'Build information unavailable. Refresh to retry; no new build was requested.' }) }
    })()
    return () => { life.active = false; owned?.[Symbol.dispose]() }
  }, [scope, authenticatedApi, isAdmin, requestId, runId, revision])

  async function mutate(mutation: Mutation) {
    const life = token.current
    if (!capability || !life?.active || life.scope !== scope || lock.current) return
    lock.current = true; setBusy(true); setProblem(undefined); setPending({ scope, mutation })
    try {
      const run = mutation.kind === 'start' ? await capability.startRequestBuild(mutation.input) : await capability.cancelRequestBuild(mutation.input)
      if (!life.active) return
      setData(previous => ({ scope, runs: [run, ...(previous?.scope === scope ? previous.runs.filter(r => r.runId !== run.runId) : [])], readiness: previous?.scope === scope ? previous.readiness : undefined }))
      setPending(undefined)
    } catch {
      if (life.active) setProblem({ scope, message: 'Could not confirm the operation. Retry the same operation safely. After leaving or reloading, check run history before starting another build.' })
    } finally { if (life.active) { lock.current = false; setBusy(false) } }
  }
  const readiness = current?.readiness
  return <section className={panelClass} aria-label="Request builds">
    <h2 className="font-semibold">Auto-Build</h2>
    <p className="text-sm text-kumo-subtle">Target: totango/odie-os · main. A build can create a draft PR, never merge or deploy. Delivery status is separate from PR creation.</p>
    {problem?.scope === scope && <p role="alert">{problem.message}</p>}
    {!current && !problem && <p role="status">Loading build information…</p>}
    <Button variant="secondary" disabled={busy} onClick={() => setRevision(n => n + 1)}>Refresh builds</Button>
    {current?.runs.length === 0 && <p>{runId ? 'Run unavailable or hidden' : 'No public builds yet.'}</p>}
    {current?.runs.map(run => <article key={run.runId} className={panelClass}>
      <Link to="/requests/$requestId/runs/$runId" params={{ requestId, runId: run.runId }} search={{ moderate: moderate || undefined }} className="text-kumo-brand underline">Build attempt {run.attempt}</Link>
      <p>Revision {run.requestRevision} · {run.state} · Cleanup: {run.cleanup}</p>
      <p>Updated {new Date(run.updatedAt).toLocaleString()}</p>
      {run.errorCode && <p>{run.errorCode}</p>}
      {run.notification && <p>Notification: {run.notification}{run.notification === 'ambiguous' ? ' — delivery may have occurred; operator reconciliation required, no automatic resend.' : ''}</p>}
      {run.pullRequest && /^https:\/\/github\.com\/totango\/odie-os\/pull\/[1-9][0-9]*$/.test(run.pullRequest.url) && <a href={run.pullRequest.url} target="_blank" rel="noopener noreferrer" className="text-kumo-brand underline">Verified draft PR #{run.pullRequest.number}</a>}
      {run.cancelTooLate && <p>Publication was admitted before cancellation. The PR was not undone.</p>}
      {capability && !['pr_created', 'failed', 'canceled', 'needs_attention'].includes(run.state) && <Button variant="secondary" disabled={busy || !!retry} onClick={() => void mutate({ kind: 'cancel', input: { requestId, runId: run.runId, mutationKey: crypto.randomUUID() } })}>Cancel build attempt {run.attempt}</Button>}
    </article>)}
    {isAdmin && readiness && <div className="space-y-3">
      <h3>{readiness.ready ? 'Ready for explicit approval' : 'Auto-Build is not ready'}</h3>
      <ul>{readiness.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
      {readiness.specification !== undefined && <>
        <p>Frozen public specification · revision {readiness.requestRevision}. This includes the current public description, metadata, appended details, and attachment manifest. Private diagnostics, Context collections, chats, workspaces, and Code Sessions are not included.</p>
        <pre className="whitespace-pre-wrap break-words text-sm">{readiness.specification}</pre>
        <p className="text-sm text-kumo-subtle">Starting confirms approval of this exact public specification and its referenced attachment files for one restricted build.</p>
      </>}
      <Button variant="primary" disabled={busy || !!retry || !capability || !readiness.ready || !readiness.requestRevision || readiness.specification === undefined} onClick={() => {
        if (readiness.requestRevision) void mutate({ kind: 'start', input: { requestId, expectedRequestRevision: readiness.requestRevision, mutationKey: crypto.randomUUID() } })
      }}>Approve exact specification and start build</Button>
    </div>}
    {retry && capability && <Button variant="secondary" disabled={busy} onClick={() => void mutate(retry)}>Retry same {retry.kind} operation</Button>}
  </section>
}
