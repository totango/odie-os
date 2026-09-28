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

const request: CommunityRequest = { id: 'request-1', kind: 'feature', title: '<img src=x onerror=alert(1)>', body: 'Public authored description', status: 'open', hidden: false, duplicateOf: null, createdAt: 1000, updatedAt: 1000, isOwn: false, voteCount: 2, viewerHasVoted: false, attachments: [] }
function makeApi() {
  return {
    listRequestBuilds: vi.fn<AuthenticatedApi['listRequestBuilds']>(async () => []),
    getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(async () => null),
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
    addCommunityRequestDetail: vi.fn<AuthenticatedApi['addCommunityRequestDetail']>(async (_id, data) => ({ id: 'detail-1', body: data.body, createdAt: 2000, isOwn: true, attachments: [] })),
    deleteCommunityRequestDetail: vi.fn<AuthenticatedApi['deleteCommunityRequestDetail']>(async () => {}),
    addCommunityRequestAttachment: vi.fn<AuthenticatedApi['addCommunityRequestAttachment']>(async (_id, data) => ({
      id: 'attachment-1', name: data.name, mimeType: data.mimeType, byteLength: data.content.byteLength,
      sha256: 'a'.repeat(64), createdAt: 3000, isOwn: true,
    })),
    deleteCommunityRequestAttachment: vi.fn<AuthenticatedApi['deleteCommunityRequestAttachment']>(async () => {}),
    getCommunityRequestAttachment: vi.fn<AuthenticatedApi['getCommunityRequestAttachment']>(),
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
      return <RequestDetailSheet requestId={requestId} />
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
  it('lists, searches and filters for an ordinary account, paginates and renders authored text safely', async () => {
    api.listCommunityRequests.mockResolvedValueOnce({ items: [request], nextCursor: 'page-two' }).mockResolvedValueOnce({ items: [{ ...request, id: 'second', title: 'Second request' }], nextCursor: null })
    await render(<RequestsPage />)
    expect(api.listCommunityRequests).toHaveBeenCalledWith({ query: '', kind: undefined, status: undefined, cursor: undefined, limit: 20 })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain(request.title)
    expect(container.textContent).toContain('Feature requests')
    expect(container.textContent).not.toContain('View my legacy private feedback status')
    expect(container.textContent).not.toContain('Moderate requests')
    expect(container.textContent).not.toContain('Review hidden requests')
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
    function DetailSheet() { return <RequestDetailSheet requestId={detail.useParams().requestId} /> }
    const router = createRouter({routeTree: base.addChildren([board.addChildren([detail])]), history: createMemoryHistory({initialEntries: ['/requests']})})
    await act(async () => { await router.load(); root.render(<RouterProvider router={router} />) })
    const typeFilter = container.querySelector<HTMLSelectElement>('select[aria-label="Request type"]')!
    await act(async () => { typeFilter.value = 'feature'; typeFilter.dispatchEvent(new Event('change', {bubbles: true})) })
    await click('View request')
    expect(router.state.location.pathname).toBe(`/requests/${request.id}`)
    expect(document.body.textContent).toContain('Feature requests')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Feature request details')
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('All feature requests')
    await act(async () => router.history.back())
    expect(router.state.location.pathname).toBe('/requests')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Request type"]')?.value).toBe('feature')

    await click('View request')
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

  it('refreshes the first board page on focus without rendering a manual refresh control', async () => {
    api.listCommunityRequests
      .mockResolvedValueOnce({ items: [request], nextCursor: 'page-two' })
      .mockResolvedValueOnce({ items: [{ ...request, id: 'second', title: 'Second request' }], nextCursor: null })
      .mockResolvedValueOnce({ items: [{ ...request, voteCount: 7 }], nextCursor: 'page-two' })
    await render(<RequestsPage />)
    expect(container.textContent).not.toContain('Refresh requests')
    await click('Load more requests')
    expect(container.textContent).toContain('Second request')
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(api.listCommunityRequests).toHaveBeenCalledTimes(3)
    expect(api.listCommunityRequests.mock.lastCall?.[0]?.cursor).toBeUndefined()
    expect(container.textContent).not.toContain('Second request')
    expect(container.textContent).toContain('7')
  })

  it('suppresses board refresh while hidden and refreshes when visibility returns', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await render(<RequestsPage />)
    expect(api.listCommunityRequests).toHaveBeenCalledTimes(1)
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(api.listCommunityRequests).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(api.listCommunityRequests).toHaveBeenCalledTimes(2)
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

  it('previews and uploads selected public attachments only after request creation', async () => {
    await render(<NewRequestPage />)
    await input('input:not([type="file"]):not([type="checkbox"])', 'Request with evidence')
    await input('textarea', 'Public context with an attached screenshot.')
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const file = new File([bytes], 'screen.png', {type: 'image/png'})
    Object.defineProperty(file, 'arrayBuffer', {value: async () => bytes.buffer})
    const picker = container.querySelector<HTMLInputElement>('input[aria-label="Choose public attachments"]')!
    Object.defineProperty(picker, 'files', {configurable: true, value: [file]})
    await act(async () => picker.dispatchEvent(new Event('change', {bubbles: true})))
    expect(container.textContent).toContain('screen.png')
    expect(container.textContent).toContain('Files are public to signed-in users')
    await click('Review public submission')
    expect(container.textContent).toContain('Attachment: screen.png')
    await click('Publish public request')
    expect(api.createCommunityRequest).toHaveBeenCalledTimes(1)
    expect(api.addCommunityRequestAttachment).toHaveBeenCalledWith('created', expect.objectContaining({
      name: 'screen.png', mimeType: 'image/png', content: bytes,
    }))
  })

  it('does not upload local attachment bytes after the request view becomes inactive', async () => {
    const bytes = new ArrayBuffer(8)
    const pendingRead = deferred<ArrayBuffer>()
    const file = new File([bytes], 'screen.png', {type: 'image/png'})
    const arrayBuffer = vi.fn<() => Promise<ArrayBuffer>>(() => pendingRead.promise)
    Object.defineProperty(file, 'arrayBuffer', {value: arrayBuffer})
    const router = await render(<NewRequestPage />)
    await input('input:not([type="file"]):not([type="checkbox"])', 'Stale attachment')
    await input('textarea', 'Do not upload after leaving this request view.')
    const picker = container.querySelector<HTMLInputElement>('input[aria-label="Choose public attachments"]')!
    Object.defineProperty(picker, 'files', {configurable: true, value: [file]})
    await act(async () => picker.dispatchEvent(new Event('change', {bubbles: true})))
    await click('Review public submission')
    await click('Publish public request')
    expect(arrayBuffer).toHaveBeenCalledTimes(1)
    await act(async () => { await router.navigate({to: '/requests'}) })
    await act(async () => { pendingRead.resolve(bytes); await pendingRead.promise })
    expect(api.addCommunityRequestAttachment).not.toHaveBeenCalled()
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
    expect(container.textContent).toContain('deletion revokes continued execution and public access')
    await click('Confirm deletion')
    expect(api.deleteCommunityRequest).toHaveBeenCalledWith(request.id)
    expect(container.textContent).toContain('Board reached')
  })

  it('lets an attachment author delete their file without removing the detail', async () => {
    const ownDetail = { id: 'own-detail', body: 'Keep this authored comment', createdAt: 2000, isOwn: true,
      attachments: [{ id: 'own-attachment', name: 'evidence.txt', mimeType: 'text/plain', byteLength: 8,
        sha256: 'a'.repeat(64), createdAt: 2001, isOwn: true }] }
    api.listCommunityRequestDetails
      .mockResolvedValueOnce({ items: [ownDetail], nextCursor: null })
      .mockResolvedValueOnce({ items: [{ ...ownDetail, attachments: [] }], nextCursor: null })
    await render(<RequestDetailPage requestId={request.id} />)
    await click('Delete attachment')
    expect(container.textContent).toContain('A build already approved keeps its frozen copy')
    await click('Confirm attachment deletion')
    expect(api.deleteCommunityRequestAttachment).toHaveBeenCalledWith(request.id, 'own-attachment')
    expect(container.textContent).toContain('Keep this authored comment')
    expect(container.textContent).not.toContain('evidence.txt')
  })

  it('lets an author confirm deletion of their own public detail', async () => {
    api.listCommunityRequestDetails
      .mockResolvedValueOnce({ items: [{ id: 'own-detail', body: 'Authored comment', createdAt: 2000, isOwn: true, attachments: [] }], nextCursor: null })
      .mockResolvedValueOnce({ items: [], nextCursor: null })
    await render(<RequestDetailPage requestId={request.id} />)
    await click('Delete your detail')
    expect(container.textContent).toContain('future Auto-Build approvals')
    await click('Confirm deletion')
    expect(api.deleteCommunityRequestDetail).toHaveBeenCalledWith(request.id, 'own-detail')
    expect(container.textContent).not.toContain('Authored comment')
  })

  it('shows private diagnostics inline only to current administrators', async () => {
    auth(true)
    api.getCommunityRequestPrivateDiagnostics.mockResolvedValueOnce({
      pathname: '/requests/request-1', capturedAt: new Date(1000), expiresAt: new Date(2000),
      diagnostics: [{ timestamp: new Date(1500), level: 'error', message: 'Sanitized failure' }],
    })
    await render(<RequestDetailPage requestId={request.id} />)
    expect(api.getCommunityRequestPrivateDiagnostics).toHaveBeenCalledWith(request.id)
    expect(container.textContent).toContain('Private diagnostics')
    expect(container.textContent).toContain('Visible only to current administrators')
    expect(container.textContent).toContain('Sanitized failure')
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
    api.listCommunityRequestDetails.mockResolvedValueOnce({ items: [{ id: 'first', body: 'First detail', createdAt: 1000, isOwn: false, attachments: [] }], nextCursor: 'next-details' }).mockResolvedValueOnce({ items: [{ id: 'second', body: 'Second detail', createdAt: 2000, isOwn: true, attachments: [] }], nextCursor: null })
    await render(<RequestDetailPage requestId={request.id} />)
    await click('Load more details')
    expect(api.listCommunityRequestDetails.mock.lastCall?.[1]?.cursor).toBe('next-details')
    expect(container.textContent).toContain('First detail'); expect(container.textContent).toContain('Second detail')
    api.getCommunityRequest.mockResolvedValueOnce(null)
    await click('Refresh request')
    expect(container.textContent).toContain('Request unavailable')
    expect(container.textContent).not.toContain(request.body)
    expect(container.querySelector('textarea')).toBeNull()
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
