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
    expect(container.textContent).toContain('Send product feedback')
    expect(container.textContent).toContain('Broken flow — pr-created')
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
})
