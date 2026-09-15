// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { CommunityRequest } from '@gadgets/workshop-shared/community-requests'
import { useAuthenticatedApi } from '../AuthContext'
import RequestsPage, { RequestDetailSheet } from './RequestsPage'
import NewRequestPage from './NewRequestPage'
import RequestDetailPage from './RequestDetailPage'
import { RelatedRequests, RequestVote } from './RequestShared'

vi.mock('../AuthContext', () => ({ useAuthenticatedApi: vi.fn<typeof useAuthenticatedApi>() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const request: CommunityRequest = { id: 'request-1', kind: 'feature', title: '<img src=x onerror=alert(1)>', body: 'Public authored description', status: 'open', hidden: false, duplicateOf: null, createdAt: 1000, updatedAt: 1000, isOwn: false, voteCount: 2, viewerHasVoted: false }
function makeApi() {
  return {
    listRequestBuilds: vi.fn<AuthenticatedApi['listRequestBuilds']>(async () => []),
    listCommunityRequests: vi.fn<AuthenticatedApi['listCommunityRequests']>(async () => ({ items: [request], nextCursor: null })),
    searchCommunityRequests: vi.fn<AuthenticatedApi['searchCommunityRequests']>(async () => ({ items: [], nextCursor: null })),
    getCommunityRequest: vi.fn<AuthenticatedApi['getCommunityRequest']>(async () => request),
    suggestRelatedCommunityRequests: vi.fn<AuthenticatedApi['suggestRelatedCommunityRequests']>(async () => [request]),
    createCommunityRequest: vi.fn<AuthenticatedApi['createCommunityRequest']>(async () => ({ ...request, id: 'created' })),
    attachCommunityRequestDiagnostics: vi.fn<AuthenticatedApi['attachCommunityRequestDiagnostics']>(async () => {}),
    deleteCommunityRequest: vi.fn<AuthenticatedApi['deleteCommunityRequest']>(async () => {}),
    getCommunityRequestPrivateDiagnostics: vi.fn<AuthenticatedApi['getCommunityRequestPrivateDiagnostics']>(async () => null),
    voteCommunityRequest: vi.fn<AuthenticatedApi['voteCommunityRequest']>(async () => ({ ...request, viewerHasVoted: true, voteCount: 3 })),
    unvoteCommunityRequest: vi.fn<AuthenticatedApi['unvoteCommunityRequest']>(async () => request),
    listCommunityRequestDetails: vi.fn<AuthenticatedApi['listCommunityRequestDetails']>(async () => ({ items: [], nextCursor: null })),
    addCommunityRequestDetail: vi.fn<AuthenticatedApi['addCommunityRequestDetail']>(async (_id, data) => ({ id: 'detail-1', body: data.body, createdAt: 2000, isOwn: true })),
    moderateCommunityRequest: vi.fn<AuthenticatedApi['moderateCommunityRequest']>(async (_id, data) => ({ ...request, hidden: data.action === 'hide', status: data.action === 'reopen' ? 'open' : 'closed', duplicateOf: data.duplicateOf ?? null })),
    listProductFeedbackStatuses: vi.fn<AuthenticatedApi['listProductFeedbackStatuses']>(async () => []),
    submitProductFeedback: vi.fn<AuthenticatedApi['submitProductFeedback']>(),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

async function debounce() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)) }) }

describe('Feature requests interactions', () => {
  let root: Root
  let container: HTMLDivElement
  let api: ReturnType<typeof makeApi>
  function auth(admin = false) {
    vi.mocked(useAuthenticatedApi).mockReturnValue({ authenticatedApi: api as never, isAdmin: admin, currentUser: null, logout: vi.fn<() => void>() })
  }
  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    api = makeApi(); auth()
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
  async function render(component: ReactNode) {
    const base = createRootRoute()
    const index = createRoute({ getParentRoute: () => base, path: '/', component: () => component })
    const detail = createRoute({ getParentRoute: () => base, path: '/requests/$requestId', component: DetailRoute })
    function DetailRoute() {
      const { requestId } = detail.useParams()
      return <RequestDetailSheet requestId={requestId} moderate={false} />
    }
    const list = createRoute({ getParentRoute: () => base, path: '/requests', component: () => <p>Board reached</p> })
    const newRoute = createRoute({ getParentRoute: () => base, path: '/requests/new', component: NewRequestPage })
    const router = createRouter({ routeTree: base.addChildren([index, detail, list, newRoute]), history: createMemoryHistory({ initialEntries: ['/'] }) })
    await act(async () => { await router.load(); root.render(<RouterProvider router={router} />) })
    return router
  }
  function button(text: string) {
    const found = [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text))
    if (!found) throw new Error(`Missing button: ${text}`)
    return found
  }
  async function click(text: string) { await act(async () => button(text).click()) }
  async function input(selector: string, value: string) {
    const node = container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)!
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value); node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) })
  }
  async function confirmCheckbox() {
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => checkbox.click())
  }

  it('lists, searches and filters for an ordinary account, paginates and renders authored text safely', async () => {
    api.listCommunityRequests.mockResolvedValueOnce({ items: [request], nextCursor: 'page-two' }).mockResolvedValueOnce({ items: [{ ...request, id: 'second', title: 'Second request' }], nextCursor: null })
    await render(<RequestsPage />)
    expect(api.listCommunityRequests).toHaveBeenCalledWith({ query: '', kind: undefined, status: undefined, cursor: undefined, limit: 20 })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain(request.title)
    expect(container.textContent).toContain('Feature requests')
    expect(container.textContent).not.toContain('View my legacy private feedback status')
    expect(container.textContent).not.toContain('Moderate requests')
    await click('Load more requests')
    expect(api.listCommunityRequests.mock.lastCall?.[0]?.cursor).toBe('page-two')
    expect(container.textContent).toContain('Second request')
    expect(container.textContent).toContain(request.title)
    await input('input[type="search"]', 'export')
    await debounce()
    expect(api.searchCommunityRequests.mock.lastCall?.[0]).toMatchObject({ query: 'export', cursor: undefined })
    expect(container.textContent).toContain('No matching requests')
    await input('select', 'bug')
    expect(api.searchCommunityRequests.mock.lastCall?.[0]).toMatchObject({ kind: 'bug' })
    const selects = container.querySelectorAll('select')
    await act(async () => { selects[1].value = 'closed'; selects[1].dispatchEvent(new Event('change', { bubbles: true })) })
    expect(api.searchCommunityRequests.mock.lastCall?.[0]).toMatchObject({ status: 'closed', cursor: undefined })
    expect(api.submitProductFeedback).not.toHaveBeenCalled()
  })

  it('keeps the mounted board behind a URL-backed detail sheet and browser Back closes it', async () => {
    const base = createRootRoute({component: () => <Outlet />})
    const board = createRoute({getParentRoute: () => base, path: '/requests', component: RequestsPage})
    const detail = createRoute({getParentRoute: () => board, path: '$requestId', component: DetailSheet})
    function DetailSheet() { return <RequestDetailSheet requestId={detail.useParams().requestId} moderate={false} /> }
    const router = createRouter({routeTree: base.addChildren([board.addChildren([detail])]), history: createMemoryHistory({initialEntries: ['/requests']})})
    await act(async () => { await router.load(); root.render(<RouterProvider router={router} />) })
    const typeFilter = container.querySelector<HTMLSelectElement>('select[aria-label="Request type"]')!
    await act(async () => { typeFilter.value = 'feature'; typeFilter.dispatchEvent(new Event('change', {bubbles: true})) })
    const requestLink = [...container.querySelectorAll<HTMLAnchorElement>('a')].find(link => link.textContent?.includes(request.title))!
    await act(async () => requestLink.click())
    expect(router.state.location.pathname).toBe(`/requests/${request.id}`)
    expect(document.body.textContent).toContain('Feature requests')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Feature request details')
    await act(async () => router.history.back())
    expect(router.state.location.pathname).toBe('/requests')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Request type"]')?.value).toBe('feature')

    const reopenedLink = [...container.querySelectorAll<HTMLAnchorElement>('a')].find(link => link.textContent?.includes(request.title))!
    await act(async () => reopenedLink.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close feature request"]')!.click())
    expect(router.state.location.pathname).toBe('/requests')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => router.history.back())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('discards a late list response after changing the search', async () => {
    const old = deferred<{ items: CommunityRequest[]; nextCursor: null }>()
    api.listCommunityRequests.mockReturnValueOnce(old.promise)
    await render(<RequestsPage />)
    await input('input[type="search"]', 'new query'); await debounce()
    expect(container.textContent).toContain('No matching requests')
    await act(async () => old.resolve({ items: [{ ...request, title: 'Stale old list' }], nextCursor: null }))
    expect(container.textContent).not.toContain('Stale old list')
  })

  it('does not apply a late vote from a replaced authenticated API', async () => {
    const old = deferred<CommunityRequest>()
    api.voteCommunityRequest.mockReturnValueOnce(old.promise)
    const onChange = vi.fn<(value: CommunityRequest) => void>()
    await act(async () => root.render(<RequestVote request={request} onChange={onChange} />))
    await click('Upvote')
    api = makeApi(); auth()
    await act(async () => root.render(<RequestVote request={request} onChange={onChange} />))
    await act(async () => old.resolve({ ...request, viewerHasVoted: true, voteCount: 99 }))
    expect(onChange).not.toHaveBeenCalled()
    expect(button('Upvote').disabled).toBe(false)
    await click('Upvote')
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ voteCount: 3 }))
  })

  it('does not request hidden data from a non-admin even with a moderation URL', async () => {
    await render(<RequestsPage moderate />)
    expect(api.listCommunityRequests.mock.lastCall?.[0]?.includeHidden).toBeUndefined()
  })

  it('bounds and debounces draft suggestions, reviews the public payload and retries the identical feature submission', async () => {
    api.createCommunityRequest.mockRejectedValueOnce(new Error('PRIVATE_BACKEND_EXCEPTION'))
    await render(<NewRequestPage />)
    await input('input:not([type="checkbox"])', 'Better exports')
    await input('textarea', 'An authored public summary. '.repeat(30))
    expect(api.suggestRelatedCommunityRequests).not.toHaveBeenCalled()
    await debounce()
    expect(api.suggestRelatedCommunityRequests).toHaveBeenCalledTimes(1)
    expect(api.suggestRelatedCommunityRequests.mock.lastCall?.[0].length).toBe(160)
    expect(container.textContent).toContain('Possible duplicates')
    await click('Review public submission')
    expect(button('Publish public request').disabled).toBe(false)
    expect(container.textContent).toContain('visible to all signed-in deployment users')
    expect(container.textContent).not.toContain('Private browser diagnostics')
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
    await click('Publish public request')
    expect(container.textContent).toContain('Could not confirm publication')
    expect(container.textContent).not.toContain('PRIVATE_BACKEND_EXCEPTION')
    await click('Publish public request')
    expect(api.createCommunityRequest).toHaveBeenCalledTimes(2)
    expect(api.createCommunityRequest.mock.calls[0]).toEqual(api.createCommunityRequest.mock.calls[1])
    expect(Object.keys(api.createCommunityRequest.mock.calls[0][0]).toSorted()).toEqual(['body', 'idempotencyKey', 'kind', 'title'])
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Feature request details')
    expect(api.submitProductFeedback).not.toHaveBeenCalled()
  })

  it('publishes a new public bug with no private context or legacy automation', async () => {
    await render(<NewRequestPage />)
    await click('Bug report'); await input('input:not([type="checkbox"])', 'New public bug'); await input('textarea', 'Safe reproduction instructions')
    await click('Review public submission')
    await click('Include private diagnostics')
    expect(button('Remove private diagnostics').getAttribute('aria-pressed')).toBe('true')
    await click('Publish public request')
    expect(api.createCommunityRequest.mock.lastCall?.[0]).toMatchObject({ kind: 'bug', title: 'New public bug', body: 'Safe reproduction instructions' })
    expect(api.attachCommunityRequestDiagnostics).toHaveBeenCalledWith('created', expect.objectContaining({ pathname: '/', diagnostics: expect.any(Array), idempotencyKey: expect.any(String) }))
    expect(api.submitProductFeedback).not.toHaveBeenCalled()
  })

  it('does not attach private diagnostics after the new-request view is inactive', async () => {
    const pending = deferred<CommunityRequest>()
    api.createCommunityRequest.mockReturnValueOnce(pending.promise)
    const router = await render(<NewRequestPage />)
    await click('Bug report'); await input('input:not([type="checkbox"])', 'Late public bug'); await input('textarea', 'Safe reproduction instructions')
    await click('Review public submission')
    await click('Include private diagnostics')
    await click('Publish public request')
    await act(async () => { await router.navigate({ to: '/requests' }) })
    await act(async () => pending.resolve({ ...request, id: 'created' }))
    expect(api.attachCommunityRequestDiagnostics).not.toHaveBeenCalled()
  })

  it('lets an author confirm deletion and returns to the board', async () => {
    api.getCommunityRequest.mockResolvedValueOnce({ ...request, isOwn: true })
    await render(<RequestDetailPage requestId={request.id} />)
    await click('Delete your request')
    expect(container.textContent).toContain('cannot be restored')
    await click('Confirm deletion')
    expect(api.deleteCommunityRequest).toHaveBeenCalledWith(request.id)
    expect(container.textContent).toContain('Board reached')
  })

  it('shows private diagnostics only to an administrator in the explicit moderation view', async () => {
    auth(true)
    api.getCommunityRequestPrivateDiagnostics.mockResolvedValueOnce({
      pathname: '/workspace/private', capturedAt: new Date(1000), expiresAt: new Date(2000),
      diagnostics: [{ timestamp: new Date(1500), level: 'error', message: 'sanitized private diagnostic' }],
    })
    await render(<RequestDetailPage requestId={request.id} />)
    expect(api.getCommunityRequestPrivateDiagnostics).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Private bug diagnostics')
    await render(<RequestDetailPage requestId={request.id} moderate />)
    expect(api.getCommunityRequestPrivateDiagnostics).toHaveBeenCalledWith(request.id)
    expect(container.textContent).toContain('Private bug diagnostics (1)')
    expect(container.textContent).toContain('excluded from public search and Auto-Build')
    auth(false)
    await render(<RequestDetailPage requestId={request.id} moderate />)
    expect(api.getCommunityRequestPrivateDiagnostics).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('Private bug diagnostics')
  })

  it('allows voting/unvoting and confirmed public details with idempotent retries', async () => {
    api.addCommunityRequestDetail.mockRejectedValueOnce(new Error('PRIVATE_DIAGNOSTICS'))
    await render(<RequestDetailPage requestId={request.id} />)
    await click('Upvote')
    expect(button('Remove upvote').getAttribute('aria-pressed')).toBe('true')
    expect(button('Remove upvote').textContent).toContain('3')
    await click('Remove upvote')
    expect(api.unvoteCommunityRequest).toHaveBeenCalledWith(request.id)
    await input('textarea', 'Also affects keyboard navigation')
    expect(button('Publish public details').disabled).toBe(false)
    expect(container.textContent).toContain('visible to signed-in deployment users')
    await click('Publish public details')
    expect(container.textContent).not.toContain('PRIVATE_DIAGNOSTICS')
    await click('Publish public details')
    expect(api.addCommunityRequestDetail.mock.calls[0]).toEqual(api.addCommunityRequestDetail.mock.calls[1])
    expect(container.textContent).toContain('Your detail was published')
    // An explicitly new, identical detail is a new operation after a confirmed success.
    await input('textarea', 'Also affects keyboard navigation'); await click('Publish public details')
    expect(api.addCommunityRequestDetail.mock.calls[2][1].idempotencyKey).not.toBe(api.addCommunityRequestDetail.mock.calls[1][1].idempotencyKey)
    expect(container.textContent).toContain('No public builds yet.')
    expect(container.textContent).not.toContain('Approve exact specification and start build')
    expect(container.querySelector('[aria-label="Moderate request"]')).toBeNull()
  })

  it('loads additional details and handles hidden/missing requests without rendering old content', async () => {
    api.listCommunityRequestDetails.mockResolvedValueOnce({ items: [{ id: 'first', body: 'First detail', createdAt: 1000, isOwn: false }], nextCursor: 'next-details' }).mockResolvedValueOnce({ items: [{ id: 'second', body: 'Second detail', createdAt: 2000, isOwn: true }], nextCursor: null })
    await render(<RequestDetailPage requestId={request.id} />)
    await click('Load more details')
    expect(api.listCommunityRequestDetails.mock.lastCall?.[1]?.cursor).toBe('next-details')
    expect(container.textContent).toContain('First detail'); expect(container.textContent).toContain('Second detail')
    api.getCommunityRequest.mockResolvedValueOnce(null)
    await click('Refresh request')
    expect(container.textContent).toContain('Request unavailable or hidden')
    expect(container.textContent).not.toContain(request.body)
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('integrates static-admin hidden reads and hide/restore/duplicate/close/reopen moderation', async () => {
    auth(true)
    await render(<RequestDetailPage requestId={request.id} moderate />)
    expect(api.getCommunityRequest).toHaveBeenCalledWith(request.id, true)
    for (const action of ['hide', 'restore', 'duplicate', 'close', 'reopen']) {
      await input('select', action)
      if (action === 'duplicate') await input('input:not([type="checkbox"])', 'canonical-id')
      await confirmCheckbox(); await click('Apply moderation')
      expect(api.moderateCommunityRequest.mock.lastCall?.[1]).toMatchObject({ action, ...(action === 'duplicate' ? { duplicateOf: 'canonical-id' } : {}) })
      expect(container.textContent?.includes('Hidden from the board')).toBe(action === 'hide')
      expect(container.querySelector('textarea') === null).toBe(action === 'hide')
      expect(container.querySelector('a[href="/requests/canonical-id?moderate=true"]') !== null).toBe(action === 'duplicate')
    }
    expect(container.textContent).toContain('current administrator authority')
  })

  it('handles moderation denial with safe errors and the same retry key', async () => {
    auth(true); api.moderateCommunityRequest.mockRejectedValue(new Error('private admin detail'))
    await render(<RequestDetailPage requestId={request.id} moderate />)
    await confirmCheckbox(); await click('Apply moderation'); await click('Apply moderation')
    expect(api.moderateCommunityRequest.mock.calls[0]).toEqual(api.moderateCommunityRequest.mock.calls[1])
    expect(container.textContent).toContain('Could not confirm moderation')
    expect(container.textContent).not.toContain('private admin detail')
  })

  it('ignores stale suggestions after a draft changes and after unmount', async () => {
    const old = deferred<CommunityRequest[]>()
    api.suggestRelatedCommunityRequests.mockReturnValueOnce(old.promise)
    const base = createRootRoute({ component: () => <RelatedRequests text="First draft" /> })
    const router = createRouter({ routeTree: base, history: createMemoryHistory() })
    await act(async () => { await router.load(); root.render(<RouterProvider router={router} />) }); await debounce()
    await act(async () => root.render(<RelatedRequests text="Second draft" />))
    await act(async () => old.resolve([{ ...request, title: 'Stale suggestion' }]))
    expect(container.textContent).not.toContain('Stale suggestion')
    await act(async () => root.render(<div>Gone</div>)); await debounce()
    expect(api.suggestRelatedCommunityRequests).toHaveBeenCalledTimes(1)
  })

  it('handles list and detail failures without exposing raw RPC errors', async () => {
    api.listCommunityRequests.mockRejectedValueOnce(new Error('SENSITIVE_REASON'))
    await render(<RequestsPage />)
    expect(container.textContent).toContain('Could not load requests'); expect(container.textContent).not.toContain('SENSITIVE_REASON')
    await click('Retry loading')
    expect(container.textContent).toContain(request.title)
  })
})
