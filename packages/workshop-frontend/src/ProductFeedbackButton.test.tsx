// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import ProductFeedbackButton from './ProductFeedbackButton'
import { AuthProvider } from './AuthContext'

describe('ProductFeedbackButton', () => {
  let root: Root | undefined
  afterEach(() => { act(() => root?.unmount()); vi.restoreAllMocks() })

  it('launches the feedback form and renders status with a PR link', async () => {
    const api = {
      whoami: async () => ({ type: 'user', id: 'dev@totango.com', name: 'Dev' }),
      amIAdmin: async () => false,
      productFeedbackAvailable: async () => true,
      listProductFeedbackStatuses: async () => [{
        id: 'fb1', kind: 'bug', title: 'Broken flow', state: 'pr-created',
        prUrl: 'https://github.com/totango/odie-os/pull/1', createdAt: new Date(), updatedAt: new Date(),
      }],
    } as unknown as AuthenticatedApi
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <AuthProvider authenticatedApi={api as never} onLogout={() => {}}>
        <ProductFeedbackButton pathname="/workspace/abc" />
      </AuthProvider>,
    ))
    await act(async () => container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('Tell us what happened or what would make Odie better.')
    expect(container.textContent).toContain('Report a bug')
    expect(container.textContent).toContain('Suggest an idea')
    expect(container.textContent).toContain('Broken flow pr-created')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://github.com/totango/odie-os/pull/1')
    container.remove()
  })

  it('stays hidden when the server says feedback automation is unavailable', async () => {
    const api = {
      whoami: async () => ({ type: 'user', id: 'external@example.com', name: 'External' }),
      amIAdmin: async () => false,
      productFeedbackAvailable: async () => false,
    } as unknown as AuthenticatedApi
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <AuthProvider authenticatedApi={api as never} onLogout={() => {}}>
        <ProductFeedbackButton pathname="/" />
      </AuthProvider>,
    ))
    expect(container.textContent).toBe('')
    container.remove()
  })

  it('keeps feedback actions outside the scrollable content after preview is shown', async () => {
    const api = {
      whoami: async () => ({ type: 'user', id: 'dev@totango.com', name: 'Dev' }),
      amIAdmin: async () => false,
      productFeedbackAvailable: async () => true,
      listProductFeedbackStatuses: async () => [],
      submitProductFeedback: async () => ({
        status: { id: 'fb1', kind: 'bug', title: 'Broken flow', state: 'queued', createdAt: new Date(), updatedAt: new Date() },
      }),
    } as unknown as AuthenticatedApi
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <AuthProvider authenticatedApi={api as never} onLogout={() => {}}>
        <ProductFeedbackButton pathname="/workspace/abc" />
      </AuthProvider>,
    ))
    await act(async () => container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    await act(async () => {
      const title = container.querySelector<HTMLInputElement>('#feedback-title')!
      const description = container.querySelector<HTMLTextAreaElement>('#feedback-description')!
      title.value = 'Broken flow'
      description.value = 'The submission controls must stay reachable on a short viewport.'.repeat(8)
      title.dispatchEvent(new Event('input', { bubbles: true }))
      description.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Preview')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const dialog = container.querySelector('[role="dialog"]')!
    const modal = dialog.firstElementChild!
    const content = Array.from(modal.children).find((child) => child.textContent?.includes('Submission preview'))!
    const preview = content.querySelector('pre')!
    const footer = modal.querySelector('footer')!
    expect(modal.className).toContain('flex-col')
    expect(modal.className).toContain('max-h-[calc(100dvh-1rem)]')
    expect(content.className).toContain('min-h-0')
    expect(content.className).toContain('flex-1')
    expect(content.className).toContain('overflow-y-auto')
    expect(preview.className).toContain('max-h-52')
    expect(preview.className).toContain('overflow-auto')
    expect(footer.className).toContain('shrink-0')
    expect(footer.textContent).toContain('Cancel')
    expect(footer.textContent).toContain('Hide preview')
    expect(footer.textContent).toContain('Send feedback')
    container.remove()
  })
})
