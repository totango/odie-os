import { useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdministratorList, AdministratorCandidate, AdministratorAuditPage, AdministratorBootstrapPreview } from '@gadgets/workshop-shared/api'

type ManagementApi = Pick<RpcStub<AdminApi>, 'listAdministrators' | 'resolveAdministratorCandidate' | 'searchAdministratorCandidates' | 'previewAdministratorBootstrap' | 'prepareAdministratorBootstrap' | 'activateManagedAdministrators' | 'grantAdministrator' | 'revokeAdministrator' | 'listAdministratorAudit'>
type Confirmation = { action: 'grant' | 'revoke'; account: AdministratorCandidate; revision: number; mutationKey: string }
type Cutover = { action: 'prepare' | 'activate'; revision: number; mutationKey: string; digest?: string }
const errors: Record<string, string> = {
  ADMIN_REQUIRED: 'Administrator access is required. Sign in again to refresh your access.',
  ADMIN_REVOKED: 'Your administrator access has changed. Sign in again to refresh your access.',
  REVISION_CONFLICT: 'Membership changed in another session. Refresh and confirm the exact account again.',
  LAST_ADMIN: 'The last administrator cannot be revoked. Verify another administrator can sign in first.',
  SELF_REVOKE_FORBIDDEN: 'You cannot revoke yourself. Ask another administrator after verifying a replacement can sign in.',
  ADMIN_MANAGED_NOT_ACTIVE: 'Managed membership is not active. No effective membership change was made.',
  ACCOUNT_NOT_FOUND: 'No existing account has that exact profile ID. No account was created.',
  ADMIN_ALREADY_GRANTED: 'This account is already an administrator. Refresh the list.',
  ADMIN_NOT_GRANTED: 'This account is not an active administrator. Refresh the list.',
  MUTATION_KEY_CONFLICT: 'This operation conflicts with an earlier receipt. Refresh and review membership.',
  INVALID_ADMIN_INPUT: 'Enter an exact existing profile ID (1–256 characters, no control characters).',
  AUTHORITY_UNAVAILABLE: 'Administrator authority is unavailable. Privileged changes are blocked.',
  ADMIN_BOOTSTRAP_UNCONFIRMED: 'The configured administrator snapshot changed or contains an unresolved account. Review it again.',
  ADMIN_BOOTSTRAP_ALREADY_PREPARED: 'Managed membership preparation already completed. Refresh membership.',
  ADMIN_TRANSITION_BLOCKED: 'Managed activation is still blocked by provider or legacy-capability evidence. Refresh readiness before retrying.',
  ADMIN_ALREADY_MANAGED: 'Managed administrator membership is already active. Refresh membership.',
}
const blockerLabels: Record<string, string> = {
  LEGACY_CAPABILITIES_UNDRAINED: 'Fresh Context collection-owner and JARVIS policy-owner enforcement evidence is pending. Activation requires two complete matching provider scans.',
}
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && Object.hasOwn(errors, error.message) ? error.message : undefined
}

export default function AdministratorManagementPanel({ admin, currentProfileId }: { admin: ManagementApi; currentProfileId?: string }) {
  const [list, setList] = useState<AdministratorList | null>(null)
  const [audit, setAudit] = useState<AdministratorAuditPage | null>(null)
  const [profileId, setProfileId] = useState('')
  const [suggestions, setSuggestions] = useState<AdministratorCandidate[]>([])
  const [activeSuggestion, setActiveSuggestion] = useState(-1)
  const [searching, setSearching] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const confirmationRef = useRef<HTMLElement>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [bootstrap, setBootstrap] = useState<AdministratorBootstrapPreview | null>(null)
  const [cutover, setCutover] = useState<Cutover | null>(null)
  const [cutoverConfirmed, setCutoverConfirmed] = useState(false)
  const [cutoverUncertain, setCutoverUncertain] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // Borrow the page-owned stub; only its owner disposes it. Tokens suppress late UI updates.
  const lifetime = useRef(0)
  const inFlight = useRef(false)

  const clearConfirmation = () => { setConfirmation(null); setConfirmed(false); setUncertain(false) }
  const clearCutover = () => { setBootstrap(null); setCutover(null); setCutoverConfirmed(false); setCutoverUncertain(false) }
  const fail = (caught: unknown) => {
    const code = errorCode(caught)
    setError(code ? errors[code] : 'Could not read administrator state. Refresh to try again.')
    if (code === 'ADMIN_REQUIRED' || code === 'ADMIN_REVOKED' || code === 'AUTHORITY_UNAVAILABLE') {
      setList(null); setAudit(null); clearConfirmation()
    }
  }
  const perform = async (operation: (current: () => boolean) => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    const token = lifetime.current
    const current = () => lifetime.current === token
    setBusy(true); setError('')
    try { await operation(current) } catch (caught) { if (current()) fail(caught) }
    finally { if (current()) { inFlight.current = false; setBusy(false) } }
  }
  const refresh = () => perform(async current => {
    // Clear the stale revision before reading. Never silently retry a conflicting mutation.
    setList(null); setAudit(null); clearConfirmation(); clearCutover()
    const [members, events] = await Promise.all([admin.listAdministrators(), admin.listAdministratorAudit()])
    if (current()) { setList(members); setAudit(events) }
  })
  useEffect(() => {
    lifetime.current++
    inFlight.current = false
    setProfileId(''); setNotice(''); clearCutover()
    void refresh()
    return () => { lifetime.current++ }
  }, [admin])

  const select = (action: Confirmation['action'], account: AdministratorCandidate) => {
    if (!list) return
    setSuggestions([]); setActiveSuggestion(-1)
    setProfileId(account.profileId)
    setConfirmation({ action, account, revision: list.revision, mutationKey: crypto.randomUUID() })
    setConfirmed(false); setUncertain(false); setNotice(''); setError('')
  }
  const resolve = (exactProfileId = profileId) => perform(async current => {
    clearConfirmation(); setNotice('')
    // No trim, lowercase, email rewrite or alias lookup: use the exact supplied identifier.
    const account = await admin.resolveAdministratorCandidate(exactProfileId)
    if (!current()) return
    if (!account) { setError(errors.ACCOUNT_NOT_FOUND); return }
    select('grant', account)
  })
  const mutate = () => perform(async current => {
    if (!confirmation || !confirmed || list?.mode !== 'managed') return
    const { action, account, revision: expectedRevision, mutationKey } = confirmation
    let committedRevision: number
    try {
      committedRevision = action === 'grant'
        ? await admin.grantAdministrator({ profileId: account.profileId, expectedRevision, mutationKey })
        : await admin.revokeAdministrator({ principalId: account.principalId, expectedRevision, mutationKey })
    } catch (caught) {
      if (!current()) return
      const code = errorCode(caught)
      if (!code) {
        // Lost response may have committed. Retry the same envelope, never a fresh mutation key.
        setUncertain(true)
        setError('Outcome unknown. Retry the same operation to reconcile its receipt, or close and refresh before deciding what to do next.')
      } else { clearConfirmation(); fail(caught); setList(null); setAudit(null) }
      return
    }
    if (!current()) return
    clearConfirmation(); setList(null); setAudit(null)
    setNotice(`${action === 'grant' ? 'Grant' : 'Revocation'} committed at revision ${committedRevision}. Refreshing current membership.`)
    const [members, events] = await Promise.all([admin.listAdministrators(), admin.listAdministratorAudit()])
    if (current()) { setList(members); setAudit(events) }
  })
  const reviewBootstrap = () => perform(async current => {
    setBootstrap(null); setCutover(null); setCutoverConfirmed(false); setCutoverUncertain(false); setNotice('')
    const preview = await admin.previewAdministratorBootstrap()
    if (current()) setBootstrap(preview)
  })
  const stageCutover = (action: Cutover['action']) => {
    if (!list || (action === 'prepare' && !bootstrap)) return
    setCutover({ action, revision: list.revision, mutationKey: crypto.randomUUID(), ...(bootstrap ? { digest: bootstrap.digest } : {}) })
    setCutoverConfirmed(false); setCutoverUncertain(false); setError(''); setNotice('')
  }
  const mutateCutover = () => perform(async current => {
    if (!cutover || !cutoverConfirmed) return
    const input = { expectedRevision: cutover.revision, mutationKey: cutover.mutationKey }
    try {
      const committedRevision = cutover.action === 'prepare'
        ? await admin.prepareAdministratorBootstrap({ ...input, digest: cutover.digest! })
        : await admin.activateManagedAdministrators(input)
      if (!current()) return
      clearCutover(); clearConfirmation(); setList(null); setAudit(null)
      setNotice(`${cutover.action === 'prepare' ? 'Preparation' : 'Managed activation'} committed at revision ${committedRevision}. Refreshing current membership.`)
      const [members, events] = await Promise.all([admin.listAdministrators(), admin.listAdministratorAudit()])
      if (current()) { setList(members); setAudit(events) }
    } catch (caught) {
      if (!current()) return
      const code = errorCode(caught)
      if (!code) {
        setCutoverUncertain(true)
        setError('Outcome unknown. Retry the same transition to reconcile its receipt, or refresh before taking another action.')
      } else { clearCutover(); fail(caught); setList(null); setAudit(null) }
    }
  })
  const moreMembers = () => perform(async current => {
    if (!list?.nextCursor) return
    const page = await admin.listAdministrators(list.nextCursor)
    if (!current()) return
    if (page.revision !== list.revision || page.mode !== list.mode) {
      setList(null); setAudit(null); clearConfirmation(); setError(errors.REVISION_CONFLICT); return
    }
    setList({ ...page, items: [...list.items, ...page.items] })
  })
  const moreAudit = () => perform(async current => {
    if (audit?.nextCursor === undefined) return
    const page = await admin.listAdministratorAudit(audit.nextCursor)
    if (current()) setAudit({ ...page, items: [...audit.items, ...page.items] })
  })
  useEffect(() => {
    if (confirmation) confirmationRef.current?.focus()
  }, [confirmation])
  useEffect(() => {
    setActiveSuggestion(-1)
    if (confirmation || profileId.trim().length < 2) { setSuggestions([]); setSearching(false); return }
    let cancelled = false
    const timer = window.setTimeout(() => {
      setSearching(true)
      admin.searchAdministratorCandidates(profileId).then(page => {
        if (!cancelled) setSuggestions(page.items)
      }).catch(() => {
        if (!cancelled) setSuggestions([])
      }).finally(() => {
        if (!cancelled) setSearching(false)
      })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [admin, confirmation, profileId])
  const managed = list?.mode === 'managed'
  const locked = busy || confirmation !== null || cutover !== null

  return <section aria-label="Administrator membership" className="space-y-6">
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div><h2 className="text-xl font-semibold text-kumo-strong">Administrators</h2><p className="mt-1 text-sm text-kumo-subtle">Manage exact existing Workshop accounts. Finance operator access is separately deployment-configured; changing Workshop administration does not change it.</p></div>
      <Button variant="secondary" disabled={locked} onClick={refresh}>Refresh membership</Button>
    </header>
    {busy && <p role="status" className="text-sm text-kumo-subtle">Loading administrator operation…</p>}
    {error && <p role="alert" className="rounded-xl border border-kumo-danger/30 bg-kumo-danger/10 p-3 text-sm text-kumo-danger">{error}</p>}
    {notice && <p role="status" className="rounded-xl border border-kumo-success/30 bg-kumo-success/10 p-3 text-sm text-kumo-success">{notice}</p>}

    {list && <>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-kumo-line bg-kumo-base p-4"><p className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">Authority mode</p><p className="mt-2 text-lg font-semibold capitalize text-kumo-strong">{list.mode}</p></div>
        <div className="rounded-xl border border-kumo-line bg-kumo-base p-4"><p className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">Revision</p><p className="mt-2 text-lg font-semibold text-kumo-strong">{list.revision}</p></div>
        <div className="rounded-xl border border-kumo-line bg-kumo-base p-4"><p className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">Active grants</p><p className="mt-2 text-lg font-semibold text-kumo-strong">{managed ? list.items.filter(item => item.active).length : list.staticProfileIds.length}</p></div>
      </div>

      {!managed && <section className="space-y-4 rounded-xl border border-kumo-warning/30 bg-kumo-warning/10 p-5">
        <div><h3 className="font-semibold text-kumo-strong">Pending managed cutover</h3><p className="mt-1 text-sm text-kumo-subtle">Configured static membership remains effective until the exact configured accounts are prepared and provider-owned legacy capabilities pass the activation gate.</p></div>
        {list.blockers.length > 0 && <ul className="space-y-2 text-sm">{list.blockers.map(reason => <li key={reason} className="rounded-lg bg-kumo-base/70 p-3"><span>{blockerLabels[reason] ?? 'An additional backend readiness requirement is unresolved.'}</span> <code className="block pt-1 text-xs">{reason}</code></li>)}</ul>}
        <div className="overflow-x-auto rounded-lg border border-kumo-line bg-kumo-base"><table className="w-full min-w-[560px] text-left text-sm"><caption className="sr-only">Deployment-configured static administrators</caption><thead className="bg-kumo-elevated text-xs uppercase tracking-wide text-kumo-subtle"><tr><th scope="col" className="px-4 py-3">Configured account</th><th scope="col" className="px-4 py-3">Current authority</th></tr></thead><tbody className="divide-y divide-kumo-line">{list.staticProfileIds.map(id => <tr key={id}><td className="px-4 py-3 font-mono text-xs">{id}</td><td className="px-4 py-3"><span className="rounded-full bg-kumo-success/10 px-2 py-1 text-xs font-medium text-kumo-success">Effective static admin</span></td></tr>)}</tbody></table></div>
        {list.mode === 'legacy' && <Button variant="secondary" disabled={locked} onClick={reviewBootstrap}>Review exact cutover accounts</Button>}
        {bootstrap && <div className="space-y-3 rounded-lg border border-kumo-line bg-kumo-base p-4"><p className="font-medium">Verified snapshot: {bootstrap.accounts.length} account{bootstrap.accounts.length === 1 ? '' : 's'}</p>{bootstrap.accounts.length > 0 && <div className="overflow-x-auto rounded-lg border border-kumo-line"><table className="w-full min-w-[680px] text-left text-sm"><caption className="sr-only">Exact accounts prepared for managed administrator membership</caption><thead className="bg-kumo-elevated text-xs uppercase tracking-wide text-kumo-subtle"><tr><th scope="col" className="px-3 py-2">Display name</th><th scope="col" className="px-3 py-2">Exact profile ID</th><th scope="col" className="px-3 py-2">Account ID</th></tr></thead><tbody className="divide-y divide-kumo-line">{bootstrap.accounts.map(account => <tr key={account.principalId}><td className="px-3 py-2">{account.displayName || '(No display name)'}</td><td className="px-3 py-2 font-mono text-xs">{account.profileId}</td><td className="px-3 py-2 font-mono text-xs">{account.principalId}</td></tr>)}</tbody></table></div>}{bootstrap.unresolvedProfileIds.length > 0 && <p role="alert" className="text-sm text-kumo-danger">Unresolved: {bootstrap.unresolvedProfileIds.join(', ')}</p>}<Button variant="primary" disabled={locked || bootstrap.unresolvedProfileIds.length > 0 || bootstrap.revision !== list.revision} onClick={() => stageCutover('prepare')}>Prepare managed membership</Button></div>}
        {list.mode === 'prepared' && <Button variant="primary" disabled={locked} onClick={() => stageCutover('activate')}>Verify readiness and activate</Button>}
        {cutover && <div role="group" aria-label="Confirm managed membership transition" className="space-y-3 rounded-lg border border-kumo-line bg-kumo-base p-4"><p className="font-semibold">Confirm {cutover.action === 'prepare' ? 'preparation' : 'managed activation'}</p><p className="text-sm text-kumo-subtle">This exact revision is protected by a replay-safe receipt. Preparation does not change effective access; activation does.</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={cutoverConfirmed} disabled={busy || cutoverUncertain} onChange={event => setCutoverConfirmed(event.target.checked)} />I reviewed the exact accounts and understand this deployment-wide authority transition.</label><div className="flex flex-wrap gap-2"><Button variant="primary" disabled={busy || !cutoverConfirmed} onClick={mutateCutover}>{cutoverUncertain ? 'Retry same transition' : `Confirm ${cutover.action}`}</Button><Button variant="secondary" disabled={busy} onClick={() => { clearCutover(); void refresh() }}>Cancel and refresh</Button></div></div>}
      </section>}

      <section className="space-y-4 rounded-xl border border-kumo-line bg-kumo-base p-5">
        <div><h3 className="font-semibold text-kumo-strong">Add an administrator</h3><p className="mt-1 text-sm text-kumo-subtle">Look up an exact existing account by its sign-in email or profile ID. This never creates, merges, lowercases, or aliases an account.</p></div>
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={event => { event.preventDefault(); if (!locked && profileId.length) void resolve() }}>
          <label className="min-w-0 flex-1" htmlFor="administrator-profile"><span className="mb-1.5 block text-sm font-medium">Account email or exact profile ID</span><input id="administrator-profile" role="combobox" aria-label="Account email or exact profile ID" aria-autocomplete="list" aria-controls="administrator-suggestions" aria-expanded={suggestions.length > 0} aria-activedescendant={activeSuggestion >= 0 ? `administrator-suggestion-${activeSuggestion}` : undefined} autoComplete="off" placeholder="name@company.com" value={profileId} maxLength={256} disabled={locked} onChange={event => setProfileId(event.target.value)} onKeyDown={event => { if (!suggestions.length) return; if (event.key === 'ArrowDown') { event.preventDefault(); setActiveSuggestion(index => (index + 1) % suggestions.length) } else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveSuggestion(index => index <= 0 ? suggestions.length - 1 : index - 1) } else if (event.key === 'Enter' && activeSuggestion >= 0) { event.preventDefault(); select('grant', suggestions[activeSuggestion]) } else if (event.key === 'Escape') { event.preventDefault(); setSuggestions([]); setActiveSuggestion(-1) } }} className="h-10 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-sm text-kumo-default outline-none placeholder:text-kumo-inactive focus:border-kumo-brand focus:ring-2 focus:ring-kumo-brand/20 disabled:cursor-not-allowed disabled:opacity-50" /></label>
          <Button type="submit" variant="secondary" disabled={locked || !profileId.length}>Look up account</Button>
        </form>
        {searching && <p role="status" className="text-sm text-kumo-subtle">Searching existing accounts…</p>}
        {!searching && profileId.trim().length >= 2 && suggestions.length === 0 && <p className="text-sm text-kumo-subtle">No indexed matches yet. Exact lookup still checks the authoritative account directly and never creates one.</p>}
        {suggestions.length > 0 && <div id="administrator-suggestions" role="listbox" aria-label="Existing account suggestions" className="overflow-hidden rounded-lg border border-kumo-line">{suggestions.map((account, index) => <button id={`administrator-suggestion-${index}`} key={account.principalId} type="button" role="option" aria-selected={activeSuggestion === index} disabled={locked} onMouseEnter={() => setActiveSuggestion(index)} onClick={() => select('grant', account)} className={`flex w-full flex-col gap-1 border-b border-kumo-line px-4 py-3 text-left last:border-b-0 hover:bg-kumo-tint disabled:opacity-50 ${activeSuggestion === index ? 'bg-kumo-tint' : ''}`}><span className="font-medium text-kumo-strong">{account.displayName || '(No display name)'}</span><span className="font-mono text-xs text-kumo-subtle">{account.profileId}</span></button>)}</div>}
      </section>

      {confirmation && <section ref={confirmationRef} tabIndex={-1} role="group" aria-label="Confirm exact account" className="space-y-3 rounded-xl border border-kumo-brand/30 bg-kumo-brand/5 p-5 break-all">
        <div><h3 className="font-semibold text-kumo-strong">Confirm {confirmation.action} target</h3><p className="text-sm text-kumo-subtle">Display names help recognition but are not identity proof.</p></div>
        <dl className="grid gap-2 text-sm sm:grid-cols-[160px_1fr]"><dt className="text-kumo-subtle">Display name</dt><dd>{confirmation.account.displayName || '(No display name)'}</dd><dt className="text-kumo-subtle">Exact profile ID</dt><dd><code>{confirmation.account.profileId}</code></dd><dt className="text-kumo-subtle">Account ID</dt><dd><code>{confirmation.account.principalId}</code></dd><dt className="text-kumo-subtle">Expected revision</dt><dd>{confirmation.revision}</dd></dl>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={busy || uncertain} onChange={event => setConfirmed(event.target.checked)} />I verified this exact account and intend to {confirmation.action} its administrator access.</label>
        <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={busy || !confirmed || !managed} onClick={mutate}>{uncertain ? 'Retry same operation' : `Confirm ${confirmation.action}`}</Button><Button variant="secondary" disabled={busy} onClick={() => { clearConfirmation(); void refresh() }}>Close and refresh</Button></div>
        {!managed && <p className="text-sm text-kumo-warning">Account lookup is available, but membership changes remain blocked until managed cutover.</p>}
      </section>}

      <section className="space-y-4 rounded-xl border border-kumo-line bg-kumo-base p-5">
        <div><h3 className="font-semibold text-kumo-strong">Administrator membership</h3><p className="mt-1 text-sm text-kumo-subtle">Exact account identifiers remain visible for verification. Revoking Workshop administration does not alter Finance access or independently issued Context Git tokens.</p></div>
        <div className="overflow-x-auto rounded-lg border border-kumo-line"><table className="w-full min-w-[860px] text-left text-sm"><caption className="sr-only">Stored administrator membership grants</caption><thead className="bg-kumo-elevated text-xs uppercase tracking-wide text-kumo-subtle"><tr><th scope="col" className="px-4 py-3">Account</th><th scope="col" className="px-4 py-3">Exact profile ID</th><th scope="col" className="px-4 py-3">Account ID</th><th scope="col" className="px-4 py-3">Generation</th><th scope="col" className="px-4 py-3 text-right">Action</th></tr></thead><tbody className="divide-y divide-kumo-line">{list.items.map(account => <tr key={account.principalId}><td className="px-4 py-3"><p className="font-medium text-kumo-strong">{account.displayName || '(No display name)'}</p><span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${account.active ? 'bg-kumo-success/10 text-kumo-success' : 'bg-kumo-tint text-kumo-subtle'}`}>{account.active ? 'Active' : 'Revoked'}</span></td><td className="px-4 py-3 font-mono text-xs">{account.profileId}</td><td className="px-4 py-3 font-mono text-xs">{account.principalId}</td><td className="px-4 py-3">{account.generation}</td><td className="px-4 py-3 text-right">{managed && (account.active ? <Button variant="secondary" disabled={locked || !currentProfileId || account.profileId === currentProfileId} onClick={() => select('revoke', account)}>{`Revoke ${account.profileId}`}</Button> : <Button variant="secondary" disabled={locked} onClick={() => { setProfileId(account.profileId); void resolve(account.profileId) }}>{`Regrant ${account.profileId}`}</Button>)}</td></tr>)}</tbody></table></div>
        {!list.items.length && <p className="rounded-lg border border-dashed border-kumo-line p-6 text-center text-sm text-kumo-subtle">No stored grants yet.</p>}
        {managed && list.items.some(account => account.profileId === currentProfileId) && <p className="text-sm text-kumo-subtle">You cannot revoke yourself. Another verified administrator must do that.</p>}
        {list.nextCursor && <Button variant="secondary" disabled={locked} onClick={moreMembers}>Load more administrators</Button>}
      </section>
    </>}

    {audit && <details className="rounded-xl border border-kumo-line bg-kumo-base p-5"><summary className="cursor-pointer font-semibold text-kumo-strong">Private administrator audit ({audit.items.length}{audit.nextCursor !== undefined ? '+' : ''})</summary><p className="mt-2 text-sm text-kumo-subtle">Oldest first. Visible only to administrators.</p>{audit.items.length > 0 && <div className="mt-4 overflow-x-auto rounded-lg border border-kumo-line"><table className="w-full min-w-[760px] text-left text-sm"><caption className="sr-only">Private administrator authority audit events</caption><thead className="bg-kumo-elevated text-xs uppercase tracking-wide text-kumo-subtle"><tr><th scope="col" className="px-4 py-3">Revision</th><th scope="col" className="px-4 py-3">Action</th><th scope="col" className="px-4 py-3">Actor</th><th scope="col" className="px-4 py-3">Target</th><th scope="col" className="px-4 py-3">Generation</th><th scope="col" className="px-4 py-3">Time</th></tr></thead><tbody className="divide-y divide-kumo-line">{audit.items.map(event => <tr key={event.revision}><td className="px-4 py-3">{event.revision}</td><td className="px-4 py-3 capitalize">{event.action}</td><td className="px-4 py-3 font-mono text-xs"><span className="sr-only">Actor: </span>{event.actorPrincipalId}</td><td className="px-4 py-3 font-mono text-xs"><span className="sr-only">Target: </span>{event.targetPrincipalId || '(authority mode)'}</td><td className="px-4 py-3"><span className="sr-only">Generation </span>{event.previousGeneration} → {event.nextGeneration}</td><td className="px-4 py-3 whitespace-nowrap">{new Date(event.timestamp).toLocaleString()}</td></tr>)}</tbody></table></div>}{!audit.items.length && <p className="mt-4 text-sm text-kumo-subtle">No audit events yet.</p>}{audit.nextCursor !== undefined && <Button variant="secondary" disabled={locked} onClick={moreAudit}>Load more audit events</Button>}</details>}
  </section>
}
