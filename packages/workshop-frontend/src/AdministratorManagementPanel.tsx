import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdministratorList, AdministratorCandidate, AdministratorAuditPage } from '@gadgets/workshop-shared/api'

type ManagementApi = Pick<RpcStub<AdminApi>, 'listAdministrators' | 'resolveAdministratorCandidate' | 'grantAdministrator' | 'revokeAdministrator' | 'listAdministratorAudit'>
type Confirmation = { action: 'grant' | 'revoke'; account: AdministratorCandidate; revision: number; mutationKey: string }
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
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // Borrow the page-owned stub; only its owner disposes it. Tokens suppress late UI updates.
  const lifetime = useRef(0)
  const inFlight = useRef(false)

  const clearConfirmation = () => { setConfirmation(null); setConfirmed(false); setUncertain(false) }
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
    setList(null); setAudit(null); clearConfirmation()
    const [members, events] = await Promise.all([admin.listAdministrators(), admin.listAdministratorAudit()])
    if (current()) { setList(members); setAudit(events) }
  })
  useEffect(() => {
    lifetime.current++
    inFlight.current = false
    setProfileId(''); setNotice('')
    void refresh()
    return () => { lifetime.current++ }
  }, [admin])

  const select = (action: Confirmation['action'], account: AdministratorCandidate) => {
    if (!list) return
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
  const managed = list?.mode === 'managed'
  const locked = busy || confirmation !== null

  return <section aria-label="Administrator membership" className="bg-kumo-elevated border border-kumo-line rounded-xl p-6 space-y-4">
    <div className="flex items-center justify-between gap-4">
      <h2 className="text-lg font-semibold">Administrators</h2>
      <Button variant="secondary" disabled={locked} onClick={refresh}>Refresh membership</Button>
    </div>
    <p className="text-sm text-kumo-subtle">Membership belongs to an exact existing account, not a person or email alias. Display names are not identity proof. Accounts are never automatically merged or created here.</p>
    <p className="text-sm text-kumo-subtle">Finance operator access is separately deployment-configured. Granting or revoking Workshop administrator membership does not change it. Finance owners and direct shares keep their existing access.</p>
    {busy && <p role="status">Loading administrator operation…</p>}
    {error && <p role="alert" className="text-kumo-danger">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {list && <>
      <p>Authority mode: <strong>{list.mode}</strong> · Revision {list.revision}</p>
      {!managed && <div className="space-y-2">
        <h3 className="font-semibold">Pending managed cutover — static membership remains effective</h3>
        <p>No grant or revocation is effective before the backend verifies managed readiness. Preparation alone does not change access. Operator-confirmed bootstrap and cutover are separate deployment operations.</p>
        <ul className="list-disc pl-5">{list.blockers.map(reason => <li key={reason}>{blockerLabels[reason] ?? 'An additional backend readiness requirement is unresolved.'} <code>{reason}</code></li>)}</ul>
        <h3 className="font-semibold">Current configured administrators</h3>
        <ul>{list.staticProfileIds.map(id => <li key={id} className="break-all"><code>{id}</code></li>)}</ul>
        <p>These exact configured profile IDs remain effective; this list is not proof that every configured account already exists. No seeds are silently removed.</p>
      </div>}
      {managed && <p>Managed membership is active. Each managed-administrator operation rechecks authority. Revocation rejects later admissions; it does not undo already-admitted work. Regrant does not revive old capabilities. Issued Context Git write tokens are independent credentials; administrator removal does not revoke them. Revoke tokens explicitly in Context management.</p>}
      <h3 className="font-semibold">{managed ? 'Managed grant history' : 'Stored grants (not effective membership)'}</h3>
      {!list.items.length && <p>No stored grants on this page.</p>}
      <ul className="space-y-3">{list.items.map(account => <li key={account.principalId} className="rounded border border-kumo-line p-3 space-y-1 break-all">
        <p>{account.displayName || '(No display name)'} — {account.active ? 'Active stored grant' : 'Revoked'} · Generation {account.generation}</p>
        <p>Exact profile ID: <code>{account.profileId}</code></p>
        <p>Account ID: <code>{account.principalId}</code></p>
        {managed && (account.active ? <>
          <Button variant="secondary" disabled={locked || !currentProfileId || account.profileId === currentProfileId} onClick={() => select('revoke', account)}>Revoke {account.profileId}</Button>
          {account.profileId === currentProfileId && <p>You cannot revoke yourself. Another verified administrator must do that.</p>}
        </> : <Button variant="secondary" disabled={locked} onClick={() => { setProfileId(account.profileId); void resolve(account.profileId) }}>Regrant {account.profileId}</Button>)}
      </li>)}</ul>
      {list.nextCursor && <Button disabled={locked} onClick={moreMembers}>Load more administrators</Button>}
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (!locked && profileId.length) void resolve() }}>
        <label htmlFor="administrator-profile">Exact existing profile ID</label>
        <Input id="administrator-profile" aria-label="Exact existing profile ID" value={profileId} maxLength={256} disabled={locked} onChange={event => setProfileId(event.target.value)} />
        <Button type="submit" disabled={locked || !profileId.length}>Find exact account</Button>
      </form>
      {confirmation && <div role="group" aria-label="Confirm exact account" className="border border-kumo-line rounded p-4 space-y-2 break-all">
        <h3 className="font-semibold">Confirm {confirmation.action} target</h3>
        <p>Display label (not identity proof): {confirmation.account.displayName || '(No display name)'}</p>
        <p>Exact profile ID: <code>{confirmation.account.profileId}</code></p>
        <p>Account ID: <code>{confirmation.account.principalId}</code></p>
        <p>Expected authority revision: {confirmation.revision}</p>
        <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={busy || uncertain} onChange={event => setConfirmed(event.target.checked)} />I verified this exact account, not an email alias, and intend to {confirmation.action} its administrator access.</label>
        <div className="flex gap-2">
          <Button variant="primary" disabled={busy || !confirmed || !managed} onClick={mutate}>{uncertain ? 'Retry same operation' : `Confirm ${confirmation.action}`}</Button>
          <Button disabled={busy} onClick={() => { clearConfirmation(); void refresh() }}>Close and refresh</Button>
        </div>
        {!managed && <p>Pending cutover: account lookup is available, but membership mutations are blocked.</p>}
      </div>}
    </>}
    {audit && <div className="space-y-2">
      <h3 className="font-semibold">Private administrator audit</h3>
      <p>Oldest first. This audit contains account identifiers and is visible only to administrators.</p>
      {!audit.items.length && <p>No audit events on this page.</p>}
      <ol className="space-y-2">{audit.items.map(event => <li key={event.revision} className="break-all">
        Revision {event.revision} · {event.action} · {new Date(event.timestamp).toLocaleString()}<br />
        Actor: <code>{event.actorPrincipalId}</code> · Target: <code>{event.targetPrincipalId || '(authority mode)'}</code> · Generation {event.previousGeneration} → {event.nextGeneration}
      </li>)}</ol>
      {audit.nextCursor !== undefined && <Button disabled={locked} onClick={moreAudit}>Load more audit events</Button>}
    </div>}
  </section>
}
