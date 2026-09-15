// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import type { AdminApi, AuthenticatedApi, PublicRequestBuild } from '@gadgets/workshop-shared/api'
import { act, type ReactNode, type ButtonHTMLAttributes } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestBuildPanel } from './RequestBuildPanel'

const context = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('../AuthContext', () => ({ useAuthenticatedApi: () => context.current }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to, params, search }: { children: ReactNode; to: string; params: Record<string, string>; search?: { moderate?: boolean } }) => <a href={`${to.replace('$requestId', params.requestId).replace('$runId', params.runId ?? '')}${search?.moderate ? '?moderate=true' : ''}`}>{children}</a> }))
vi.mock('@cloudflare/kumo', () => ({ Button: ({ children, variant: _variant, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {variant?: string}) => <button {...props}>{children}</button> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const requestId = '11111111-1111-4111-8111-111111111111', runId = '22222222-2222-4222-8222-222222222222'
const run: PublicRequestBuild = { requestId, runId, requestRevision: 3, attempt: 1, state: 'queued', cleanup: 'pending', createdAt: 1, updatedAt: 2, cancelTooLate: false }
const readiness = { ready: true, reasons: [], requestRevision: 3, specification: 'feature: Frozen\n\nPublic specification only' }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function setup(admin = true) {
  const dispose = vi.fn<() => void>()
  const capability = { [Symbol.dispose]: dispose, getRequestBuildReadiness: vi.fn<AdminApi['getRequestBuildReadiness']>().mockResolvedValue(readiness), startRequestBuild: vi.fn<AdminApi['startRequestBuild']>().mockResolvedValue(run), cancelRequestBuild: vi.fn<AdminApi['cancelRequestBuild']>().mockResolvedValue({ ...run, state: 'cancel_requested' }) }
  const api = { listRequestBuilds: vi.fn<AuthenticatedApi['listRequestBuilds']>().mockResolvedValue([]), getRequestBuild: vi.fn<AuthenticatedApi['getRequestBuild']>().mockResolvedValue(run), getAdminApi: vi.fn<() => Promise<typeof capability | null>>().mockResolvedValue(capability) }
  context.current = { authenticatedApi: api, isAdmin: admin }
  return { api, capability, dispose }
}
let root: Root, container: HTMLDivElement
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks() })
async function render(runRoute = false, moderate = false) { await act(async () => root.render(<RequestBuildPanel requestId={requestId} runId={runRoute ? runId : undefined} moderate={moderate} />)) }
function button(text: string) { const b = [...container.querySelectorAll('button')].find(b => b.textContent === text); if (!b) throw new Error(`Missing button ${text}`); return b }
async function click(text: string) { await act(async () => button(text).click()) }
describe('RequestBuildPanel real API control path and private lifetime boundary', () => {
  it('approves the exact server snapshot revision then displays the canonical mutation receipt', async () => {
    const { capability } = setup(); await render(false, true)
    expect(container.textContent).toContain(readiness.specification)
    expect(button('Approve exact specification and start build').disabled).toBe(false)
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
    await click('Approve exact specification and start build')
    expect(capability.startRequestBuild).toHaveBeenCalledWith({ requestId, expectedRequestRevision: 3, mutationKey: expect.any(String) })
    expect(container.querySelector('a')?.getAttribute('href')).toBe(`/requests/${requestId}/runs/${runId}?moderate=true`)
  })
  it('locks double clicks and retains the identical start retry key after lost acknowledgement and refresh', async () => {
    const { capability } = setup(); const response = deferred<typeof run>()
    capability.startRequestBuild.mockReturnValueOnce(response.promise).mockRejectedValueOnce(new Error('lost'))
    await render()
    await act(async () => { button('Approve exact specification and start build').click(); button('Approve exact specification and start build').click() })
    expect(capability.startRequestBuild).toHaveBeenCalledTimes(1)
    await act(async () => response.resolve(run))
    await click('Approve exact specification and start build')
    const input = capability.startRequestBuild.mock.calls[1][0]
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not confirm')
    expect(button('Retry same start operation').disabled).toBe(false)
    capability.getRequestBuildReadiness.mockResolvedValue({ ...readiness, ready: false, reasons: ['BUILD_CAPACITY_UNAVAILABLE'] })
    await click('Refresh builds')
    expect(container.textContent).toContain('BUILD_CAPACITY_UNAVAILABLE')
    expect(button('Approve exact specification and start build').disabled).toBe(true)
    await click('Retry same start operation')
    expect(capability.startRequestBuild.mock.calls[2][0]).toEqual(input)
  })
  it('retains a settled ambiguous cancel across refresh and retries only the same receipt', async () => {
    const { api, capability, dispose } = setup(); api.listRequestBuilds.mockResolvedValue([run]); capability.cancelRequestBuild.mockRejectedValueOnce(new Error('lost'))
    await render(); await click('Cancel build attempt 1')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not confirm')
    expect(button('Retry same cancel operation').disabled).toBe(false)
    await click('Refresh builds')
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(api.getAdminApi).toHaveBeenCalledTimes(2)
    expect(button('Cancel build attempt 1').disabled).toBe(true)
    await click('Retry same cancel operation')
    expect(container.textContent).toContain('cancel_requested')
    expect(capability.cancelRequestBuild.mock.calls[1][0]).toEqual(capability.cancelRequestBuild.mock.calls[0][0])
  })
  it.each(['account', 'request'] as const)('does not retain pending mutation authority across %s replacement or return', async replacement => {
    const { capability } = setup(); const original = context.current
    capability.startRequestBuild.mockRejectedValueOnce(new Error('lost'))
    await render(); await click('Approve exact specification and start build')
    expect(button('Retry same start operation').disabled).toBe(false)
    if (replacement === 'account') setup()
    await act(async () => root.render(<RequestBuildPanel requestId={replacement === 'request' ? '33333333-3333-4333-8333-333333333333' : requestId} />))
    expect(container.textContent).not.toContain('Retry same')
    context.current = original
    await render()
    expect(container.textContent).not.toContain('Retry same')
    expect(capability.startRequestBuild).toHaveBeenCalledTimes(1)
    expect(button('Approve exact specification and start build').disabled).toBe(false)
  })
  it('renders signed-in run route status and PR without requesting admin or GitHub capabilities', async () => {
    const { api } = setup(false)
    api.getRequestBuild.mockResolvedValue(Object.assign({ ...run, state: 'pr_created' as const, notification: 'ambiguous' as const, pullRequest: { number: 12, url: 'https://github.com/totango/odie-os/pull/12' } }, { sessionId: 'SECRET_SESSION', owner: 'SECRET_OWNER' }))
    await render(true)
    expect(container.textContent).toContain('Verified draft PR #12')
    expect(container.textContent).toContain('operator reconciliation required')
    expect(api.getRequestBuild).toHaveBeenCalledWith(requestId, runId)
    expect(api.getAdminApi).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('SECRET_')
    expect(container.querySelector('input')).toBeNull()
  })
  it('shows hidden/unavailable runs without private controls or old PRs', async () => {
    const { api } = setup(false); api.getRequestBuild.mockResolvedValue(null); await render(true)
    expect(container.textContent).toContain('Run unavailable or hidden')
    expect(container.textContent).not.toContain('Verified draft PR')
  })
  it('fails closed on missing readiness, even with retained admin membership', async () => {
    const { capability } = setup(); capability.getRequestBuildReadiness.mockRejectedValue(new Error('revoked private details')); await render()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.textContent).not.toContain('revoked private details')
    expect(container.textContent).not.toContain('Approve exact specification and start build')
    expect(capability.startRequestBuild).not.toHaveBeenCalled()
  })
  it('wraps callable stubs rather than executing them and disposes on unmount', async () => {
    const { api, capability, dispose } = setup(); const callable = Object.assign(vi.fn<() => void>(), capability); api.getAdminApi.mockResolvedValue(callable)
    await render(); expect(callable).not.toHaveBeenCalled()
    await act(async () => root.render(null)); expect(dispose).toHaveBeenCalledTimes(1)
  })
  it('disposes late-acquired capabilities and suppresses old account reads', async () => {
    const { api, capability, dispose } = setup(); const late = deferred<typeof capability>(); api.getAdminApi.mockReturnValue(late.promise)
    await render(); expect(api.getAdminApi).toHaveBeenCalledTimes(1)
    setup(false); await render(); await act(async () => late.resolve(capability))
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(capability.getRequestBuildReadiness).not.toHaveBeenCalled()
    expect(container.querySelector('input')).toBeNull()
  })
  it('suppresses mutation results after account replacement', async () => {
    const { capability, dispose } = setup(); const late = deferred<typeof run>(); capability.startRequestBuild.mockReturnValue(late.promise)
    await render(); await click('Approve exact specification and start build')
    setup(false); await render(); await act(async () => late.resolve(run))
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('Build attempt 1')
  })
})
