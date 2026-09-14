// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminApi, AdministratorList, AdministratorAuditPage, AdministratorCandidate } from '@gadgets/workshop-shared/api'
import AdministratorManagementPanel from './AdministratorManagementPanel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const seeds = ['jacob.beck@totango.com', 'keith@totango.com', 'nick.roberts@totango.com', 'stacy.kennedy@totango.com']
const candidate: AdministratorCandidate = { profileId: 'Exact+Case@heyodie.ai', principalId: 'exact-account-2', displayName: 'Same display label' }
// Local RPC fixture only. The authority-core workerd suite proves actual SQLite transactions.
class ManagementFixture extends RpcTarget implements Pick<AdminApi, 'listAdministrators' | 'listAdministratorAudit' | 'resolveAdministratorCandidate' | 'searchAdministratorCandidates' | 'previewAdministratorBootstrap' | 'prepareAdministratorBootstrap' | 'activateManagedAdministrators' | 'grantAdministrator' | 'revokeAdministrator'> {
  view: AdministratorList = { mode: 'managed', revision: 3, staticProfileIds: [], blockers: [], items: [
    { profileId: seeds[0], principalId: 'actor-account', displayName: 'Jacob', generation: 1, active: true },
    { ...candidate, generation: 1, active: true },
  ] }
  events: AdministratorAuditPage = { items: [] }
  calls = {
    listAdministrators: vi.fn<AdminApi['listAdministrators']>(async () => structuredClone(this.view)),
    listAdministratorAudit: vi.fn<AdminApi['listAdministratorAudit']>(async () => structuredClone(this.events)),
    resolveAdministratorCandidate: vi.fn<AdminApi['resolveAdministratorCandidate']>(async id => id === candidate.profileId ? candidate : null),
    searchAdministratorCandidates: vi.fn<AdminApi['searchAdministratorCandidates']>(async query => ({items: candidate.profileId.toLowerCase().startsWith(query.trim().toLowerCase()) ? [candidate] : []})),
    previewAdministratorBootstrap: vi.fn<AdminApi['previewAdministratorBootstrap']>(async () => ({ revision: this.view.revision, digest: 'a'.repeat(64), accounts: seeds.map((profileId, index) => ({ profileId, principalId: `seed-${index}`, displayName: profileId })), unresolvedProfileIds: [] })),
    prepareAdministratorBootstrap: vi.fn<AdminApi['prepareAdministratorBootstrap']>(async input => { if (input.expectedRevision !== this.view.revision) throw new Error('REVISION_CONFLICT'); this.view.mode = 'prepared'; return ++this.view.revision }),
    activateManagedAdministrators: vi.fn<AdminApi['activateManagedAdministrators']>(async input => { if (input.expectedRevision !== this.view.revision) throw new Error('REVISION_CONFLICT'); this.view.mode = 'managed'; this.view.blockers = []; this.view.staticProfileIds = []; return ++this.view.revision }),
    grantAdministrator: vi.fn<AdminApi['grantAdministrator']>(async input => this.change('grant', candidate.principalId, input.expectedRevision)),
    revokeAdministrator: vi.fn<AdminApi['revokeAdministrator']>(async input => this.change('revoke', input.principalId, input.expectedRevision)),
  };
  listAdministrators(...args: Parameters<AdminApi['listAdministrators']>) { return this.calls.listAdministrators(...args) }
  listAdministratorAudit(...args: Parameters<AdminApi['listAdministratorAudit']>) { return this.calls.listAdministratorAudit(...args) }
  resolveAdministratorCandidate(...args: Parameters<AdminApi['resolveAdministratorCandidate']>) { return this.calls.resolveAdministratorCandidate(...args) }
  searchAdministratorCandidates(...args: Parameters<AdminApi['searchAdministratorCandidates']>) { return this.calls.searchAdministratorCandidates(...args) }
  previewAdministratorBootstrap(...args: Parameters<AdminApi['previewAdministratorBootstrap']>) { return this.calls.previewAdministratorBootstrap(...args) }
  prepareAdministratorBootstrap(...args: Parameters<AdminApi['prepareAdministratorBootstrap']>) { return this.calls.prepareAdministratorBootstrap(...args) }
  activateManagedAdministrators(...args: Parameters<AdminApi['activateManagedAdministrators']>) { return this.calls.activateManagedAdministrators(...args) }
  grantAdministrator(...args: Parameters<AdminApi['grantAdministrator']>) { return this.calls.grantAdministrator(...args) }
  revokeAdministrator(...args: Parameters<AdminApi['revokeAdministrator']>) { return this.calls.revokeAdministrator(...args) }
  disposed = vi.fn<() => void>();
  [Symbol.dispose]() { this.disposed() }
  change(action: 'grant' | 'revoke', principalId: string, expectedRevision: number) {
    if (this.view.mode !== 'managed') throw new Error('ADMIN_MANAGED_NOT_ACTIVE')
    if (expectedRevision !== this.view.revision) throw new Error('REVISION_CONFLICT')
    const row = this.view.items.find(item => item.principalId === principalId)!
    const previousGeneration = row.generation
    row.active = action === 'grant'; row.generation++
    this.view.revision++
    this.events.items.push({ revision: this.view.revision, action, targetPrincipalId: principalId, actorPrincipalId: 'actor-account', previousGeneration, nextGeneration: row.generation, timestamp: 1700000000000 })
    return this.view.revision
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('AdministratorManagementPanel', () => {
  let container: HTMLDivElement
  let root: Root
  let stub: RpcStub<ManagementFixture>
  afterEach(async () => {
    await act(async () => root?.unmount())
    stub?.[Symbol.dispose]()
    container?.remove()
  })
  async function render(fixture = new ManagementFixture()) {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    stub = new RpcStub(fixture)
    await act(async () => root.render(<AdministratorManagementPanel admin={stub} currentProfileId={seeds[0]} />))
    return fixture
  }
  function button(text: string) {
    const found = [...container.querySelectorAll('button')].find(item => item.textContent === text)
    expect(found, `button: ${text}`).toBeDefined()
    return found!
  }
  async function click(text: string) { await act(async () => button(text).click()) }
  async function input(value: string) {
    await act(async () => {
      const element = container.querySelector<HTMLInputElement>('#administrator-profile')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  async function confirm() { await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()) }

  it.each(['legacy', 'prepared'] as const)('shows all four static seeds and genuine pending reasons in %s, without mutation success', async mode => {
    const fixture = new ManagementFixture()
    fixture.view = { ...fixture.view, mode, staticProfileIds: seeds, blockers: ['LEGACY_CAPABILITIES_UNDRAINED'] }
    await render(fixture)
    for (const seed of seeds) expect(container.textContent).toContain(seed)
    expect(container.textContent).toContain('static membership remains effective')
    expect(container.textContent).not.toContain('FINANCE_GUARD_UNAVAILABLE')
    expect(container.textContent).toContain('Finance operator access is separately deployment-configured')
    expect(container.textContent).toContain('does not change it')
    expect(container.textContent).toContain('Fresh Context collection-owner and JARVIS policy-owner enforcement evidence is pending')
    expect(container.textContent).toContain('LEGACY_CAPABILITIES_UNDRAINED')
    expect(container.textContent).not.toContain(`Revoke ${candidate.profileId}`)
    await input(candidate.profileId); await click('Look up account'); await confirm()
    expect(button('Confirm grant').disabled).toBe(true)
    await click('Confirm grant')
    expect(fixture.calls.grantAdministrator).not.toHaveBeenCalled()
    expect(fixture.calls.revokeAdministrator).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('committed at revision')
  })
  it('requires explicit review and replay-safe confirmations for prepare and managed activation', async () => {
    const fixture = new ManagementFixture()
    fixture.view = {...fixture.view, mode: 'legacy', staticProfileIds: seeds, blockers: ['LEGACY_CAPABILITIES_UNDRAINED']}
    await render(fixture)
    await click('Review exact cutover accounts')
    expect(fixture.calls.previewAdministratorBootstrap).toHaveBeenCalledOnce()
    await click('Prepare managed membership'); await confirm(); await click('Confirm prepare')
    expect(fixture.calls.prepareAdministratorBootstrap).toHaveBeenCalledWith({expectedRevision: 3, mutationKey: expect.any(String), digest: 'a'.repeat(64)})
    expect(container.textContent).toContain('Authority modeprepared')
    await click('Verify readiness and activate'); await confirm(); await click('Confirm activate')
    expect(fixture.calls.activateManagedAdministrators).toHaveBeenCalledWith({expectedRevision: 4, mutationKey: expect.any(String)})
    expect(container.textContent).toContain('Authority modemanaged')
  })

  it('resolves exact case/plus spelling without alias merging; requires explicit identity confirmation and refreshes audit after grant', async () => {
    const fixture = new ManagementFixture(); fixture.view.items[1].active = false
    await render(fixture)
    await input(candidate.profileId); await click('Look up account')
    expect(fixture.calls.resolveAdministratorCandidate).toHaveBeenCalledWith(candidate.profileId)
    expect(container.querySelector('[aria-label="Confirm exact account"]')?.textContent).toContain(candidate.principalId)
    expect(button('Confirm grant').disabled).toBe(true)
    await confirm(); await click('Confirm grant')
    expect(fixture.calls.grantAdministrator).toHaveBeenCalledWith({ profileId: candidate.profileId, expectedRevision: 3, mutationKey: expect.any(String) })
    expect(container.textContent).toContain('Grant committed at revision 4')
    expect(container.textContent).toContain('Generation 1 → 2')
    expect(container.textContent).toContain('Actor: actor-account')
    expect(fixture.calls.listAdministratorAudit).toHaveBeenCalledTimes(2)
  })
  it('offers bounded indexed suggestions but confirms and grants only the exact revalidated account', async () => {
    const fixture = new ManagementFixture(); fixture.view.items[1].active = false
    await render(fixture)
    await input('Exact+')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(fixture.calls.searchAdministratorCandidates).toHaveBeenCalledWith('Exact+')
    const combobox = container.querySelector<HTMLInputElement>('[role="combobox"]')!
    const option = container.querySelector<HTMLButtonElement>('[role="option"]')!
    expect(combobox.getAttribute('aria-expanded')).toBe('true')
    expect(option.textContent).toContain(candidate.profileId)
    await act(async () => combobox.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true})))
    await act(async () => combobox.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})))
    const confirmation = container.querySelector<HTMLElement>('[aria-label="Confirm exact account"]')!
    expect(confirmation.textContent).toContain(candidate.principalId)
    expect(document.activeElement).toBe(confirmation)
    await confirm(); await click('Confirm grant')
    expect(fixture.calls.grantAdministrator).toHaveBeenCalledWith({profileId: candidate.profileId, expectedRevision: 3, mutationKey: expect.any(String)})
  })

  it('does not create unknown accounts or normalize alias identifiers', async () => {
    const fixture = await render()
    await input(` ${candidate.profileId.toLowerCase()} `); await click('Look up account')
    expect(fixture.calls.resolveAdministratorCandidate).toHaveBeenCalledWith(` ${candidate.profileId.toLowerCase()} `)
    expect(container.textContent).toContain('No existing account')
    expect(fixture.calls.grantAdministrator).not.toHaveBeenCalled()
  })
  it('revokes only after confirmation and fresh backend receipt, then re-resolves and regrants with a new generation/key', async () => {
    const fixture = await render()
    await click(`Revoke ${candidate.profileId}`); await confirm(); await click('Confirm revoke')
    expect(fixture.calls.revokeAdministrator).toHaveBeenCalledWith({ principalId: candidate.principalId, expectedRevision: 3, mutationKey: expect.any(String) })
    expect(container.textContent).toContain('Revocation committed at revision 4')
    await click(`Regrant ${candidate.profileId}`)
    expect(fixture.calls.resolveAdministratorCandidate).toHaveBeenCalledWith(candidate.profileId)
    await confirm(); await click('Confirm grant')
    expect(fixture.calls.grantAdministrator.mock.calls[0][0].expectedRevision).toBe(4)
    expect(fixture.calls.grantAdministrator.mock.calls[0][0].mutationKey).not.toBe(fixture.calls.revokeAdministrator.mock.calls[0][0].mutationKey)
    expect(container.textContent).toContain('Generation 2 → 3')
  })
  it('prevents self revoke and explains the replacement requirement', async () => {
    const fixture = await render()
    expect(button(`Revoke ${seeds[0]}`).disabled).toBe(true)
    expect(container.textContent).toContain('You cannot revoke yourself')
    await click(`Revoke ${seeds[0]}`)
    expect(fixture.calls.revokeAdministrator).not.toHaveBeenCalled()
  })
  it.each([
    ['LAST_ADMIN', 'The last administrator cannot be revoked'],
    ['SELF_REVOKE_FORBIDDEN', 'You cannot revoke yourself'],
    ['ADMIN_REVOKED', 'Your administrator access has changed'],
    ['ADMIN_MANAGED_NOT_ACTIVE', 'No effective membership change was made'],
    ['AUTHORITY_UNAVAILABLE', 'Privileged changes are blocked'],
  ])('shows %s rejection without reporting successful revoke', async (code, message) => {
    const fixture = await render(); fixture.calls.revokeAdministrator.mockRejectedValueOnce(new Error(code))
    await click(`Revoke ${candidate.profileId}`); await confirm(); await click('Confirm revoke')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message)
    expect(container.textContent).not.toContain('Revocation committed')
    expect(container.querySelector('[aria-label="Confirm exact account"]')).toBeNull()
  })
  it('rejects a concurrent stale confirmation and requires a new revision and explicit confirmation', async () => {
    const fixture = await render()
    await click(`Revoke ${candidate.profileId}`); await confirm()
    fixture.view.revision = 4 // Another admin committed while this confirmation was open.
    await click('Confirm revoke')
    expect(container.textContent).toContain('Membership changed in another session')
    expect(fixture.calls.revokeAdministrator).toHaveBeenCalledTimes(1)
    await click('Refresh membership'); await click(`Revoke ${candidate.profileId}`)
    expect(button('Confirm revoke').disabled).toBe(true)
    await confirm(); await click('Confirm revoke')
    expect(fixture.calls.revokeAdministrator.mock.calls[1][0].expectedRevision).toBe(4)
    expect(container.textContent).toContain('Revocation committed at revision 5')
  })
  it('retries an uncertain receipt with identical key/revision/payload and never shows raw errors or premature success', async () => {
    const fixture = await render()
    fixture.calls.revokeAdministrator.mockRejectedValueOnce(new Error('private diagnostic must not display'))
    await click(`Revoke ${candidate.profileId}`); await confirm(); await click('Confirm revoke')
    expect(container.textContent).toContain('Outcome unknown')
    expect(container.textContent).not.toContain('private diagnostic')
    expect(container.textContent).not.toContain('Revocation committed')
    await click('Retry same operation')
    expect(fixture.calls.revokeAdministrator.mock.calls[1]).toEqual(fixture.calls.revokeAdministrator.mock.calls[0])
    expect(container.textContent).toContain('Revocation committed at revision 4')
  })
  it('blocks double submit while awaiting mutation and does not mistake a refresh failure for mutation failure', async () => {
    const fixture = await render(); const receipt = deferred<number>()
    fixture.calls.revokeAdministrator.mockImplementationOnce(() => receipt.promise)
    await click(`Revoke ${candidate.profileId}`); await confirm()
    await click('Confirm revoke'); await click('Confirm revoke')
    expect(fixture.calls.revokeAdministrator).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('Revocation committed')
    fixture.calls.listAdministrators.mockRejectedValueOnce(new Error('AUTHORITY_UNAVAILABLE'))
    await act(async () => receipt.resolve(4))
    expect(container.textContent).toContain('Revocation committed at revision 4')
    expect(container.textContent).toContain('authority is unavailable')
  })
  it('fails closed on denied initial reads without displaying private rows or controls', async () => {
    const fixture = new ManagementFixture(); fixture.calls.listAdministrators.mockRejectedValueOnce(new Error('ADMIN_REQUIRED'))
    await render(fixture)
    expect(container.textContent).toContain('Administrator access is required')
    expect(container.textContent).not.toContain(candidate.profileId)
    expect(container.querySelector('form')).toBeNull()
  })
  it('paginates membership and private audit using server cursors', async () => {
    const fixture = new ManagementFixture(); fixture.view.nextCursor = 'member-cursor'; fixture.events.nextCursor = 3
    await render(fixture)
    fixture.calls.listAdministrators.mockResolvedValueOnce({ ...fixture.view, nextCursor: undefined, items: [{ ...candidate, principalId: 'third-account', generation: 7, active: false }] })
    await click('Load more administrators')
    expect(fixture.calls.listAdministrators).toHaveBeenLastCalledWith('member-cursor')
    expect(container.textContent).toContain('third-account')
    fixture.calls.listAdministratorAudit.mockResolvedValueOnce({ items: [{ revision: 4, action: 'grant', actorPrincipalId: 'actor-account', targetPrincipalId: 'third-account', previousGeneration: 6, nextGeneration: 7, timestamp: 1700000000000 }] })
    await click('Load more audit events')
    expect(fixture.calls.listAdministratorAudit).toHaveBeenLastCalledWith(3)
    expect(container.textContent).toContain('Generation 6 → 7')
  })
  it('discards mixed-revision membership pages instead of using a stale list', async () => {
    const fixture = new ManagementFixture(); fixture.view.nextCursor = 'member-cursor'
    await render(fixture); fixture.view.revision++
    await click('Load more administrators')
    expect(container.textContent).toContain('Membership changed in another session')
    expect(container.querySelector('form')).toBeNull()
  })
  it('ignores late responses after unmount and leaves disposal to the page owner', async () => {
    const fixture = new ManagementFixture(); const pending = deferred<AdministratorList>()
    fixture.calls.listAdministrators.mockImplementationOnce(() => pending.promise)
    await render(fixture)
    await act(async () => root.unmount())
    expect(fixture.disposed).not.toHaveBeenCalled()
    await act(async () => pending.resolve(fixture.view))
    expect(container.textContent).toBe('')
    stub[Symbol.dispose]()
    expect(fixture.disposed).toHaveBeenCalledOnce()
  })
})
