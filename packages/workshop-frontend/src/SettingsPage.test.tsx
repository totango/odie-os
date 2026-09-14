// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatAuthorInfo, OpenCodeUserCustomization } from '@gadgets/workshop-shared/api'

const state = vi.hoisted(() => {
  const toast = vi.fn<(toast: unknown) => void>()
  const getOpenCodeCustomization = vi.fn<() => Promise<OpenCodeUserCustomization>>()
  return {
    getOpenCodeCustomization,
    toast,
    authenticatedApi: {
      hasPasswordLogin: vi.fn<() => Promise<boolean>>(async () => false),
      getSimplifiedTechnicalEnglishEnabled: vi.fn<() => Promise<boolean>>(async () => false),
      getOpenCodeCustomization,
      whoami: vi.fn<() => Promise<AiChatAuthorInfo>>(async () => ({ type: 'user', id: 'person@example.com', name: 'Person' })),
    },
  }
})

vi.mock('@cloudflare/kumo', () => ({
  Switch: (props: { checked: boolean; disabled?: boolean; 'aria-labelledby'?: string }) =>
    <input type="checkbox" role="switch" checked={props.checked} aria-checked={props.checked} disabled={props.disabled} readOnly aria-labelledby={props['aria-labelledby']} />,
  // Kumo returns a new wrapper on each render; effects must not restart because of it.
  useKumoToastManager: () => ({ add: state.toast }),
}))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: state.authenticatedApi }) }))
vi.mock('./useAvatar', () => ({ useAvatar: () => undefined, invalidateAvatarCache: vi.fn<() => void>() }))
vi.mock('./components/billing/UsageSettings', () => ({ default: () => null }))
vi.mock('./useDocumentTitle', () => ({ useDocumentTitle: vi.fn<(title: string) => void>() }))

import SettingsPage from './SettingsPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('SettingsPage OpenCode loading recovery', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('ends a hung load, prevents an empty overwrite, and succeeds on retry', async () => {
    vi.useFakeTimers()
    state.getOpenCodeCustomization
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ plugins: ['opencode-plugin-example@1.0.0'], skills: [] })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<SettingsPage />))
    expect(container.textContent).toContain('Loading OpenCode settings…')

    await act(async () => vi.advanceTimersByTimeAsync(12_000))
    expect(state.getOpenCodeCustomization).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Failed to load OpenCode settings')
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-describedby="opencode-plugin-help"]')?.disabled).toBe(true)
    expect(Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Save OpenCode settings')?.hasAttribute('disabled')).toBe(true)

    const retry = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Retry')!
    await act(async () => retry.click())
    expect(state.getOpenCodeCustomization).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('Loading OpenCode settings…')
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-describedby="opencode-plugin-help"]')?.value).toBe('opencode-plugin-example@1.0.0')
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-describedby="opencode-plugin-help"]')?.disabled).toBe(false)
  })
})
