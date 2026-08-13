// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { openGitHubAccountPopup } from './SessionsContext'

function fakePopup() {
  return {
    opener: {} as unknown,
    close: vi.fn<() => void>(),
    location: { replace: vi.fn<(url: string) => void>() },
  }
}

describe('openGitHubAccountPopup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens a popup synchronously and navigates it to the GitHub connect OAuth URL', async () => {
    const popup = fakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const authenticatedApi = {
      connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/connect' })),
      reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/reconnect' })),
    }

    const promise = openGitHubAccountPopup(authenticatedApi, { kind: 'connect' })

    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(authenticatedApi.connectAccount).toHaveBeenCalledWith('github')

    await promise

    expect(popup.opener).toBeNull()
    expect(popup.location.replace).toHaveBeenCalledWith('https://github.example.test/oauth/connect')
    expect(popup.close).not.toHaveBeenCalled()
    expect(authenticatedApi.reconnectAccount).not.toHaveBeenCalled()
  })

  it('opens a popup synchronously and navigates it to the GitHub reconnect OAuth URL', async () => {
    const popup = fakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const authenticatedApi = {
      connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/connect' })),
      reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/reconnect' })),
    }

    const promise = openGitHubAccountPopup(authenticatedApi, { kind: 'reconnect', accountId: 42 })

    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(authenticatedApi.reconnectAccount).toHaveBeenCalledWith(42)

    await promise

    expect(popup.location.replace).toHaveBeenCalledWith('https://github.example.test/oauth/reconnect')
    expect(popup.close).not.toHaveBeenCalled()
    expect(authenticatedApi.connectAccount).not.toHaveBeenCalled()
  })

  it('closes the already-opened popup when the connect RPC fails', async () => {
    const popup = fakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const failure = new Error('GitHub connector is unavailable')
    const authenticatedApi = {
      connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => { throw failure }),
      reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/reconnect' })),
    }

    await expect(openGitHubAccountPopup(authenticatedApi, { kind: 'connect' })).rejects.toThrow(failure)

    expect(popup.close).toHaveBeenCalledOnce()
    expect(popup.location.replace).not.toHaveBeenCalled()
  })

  it('rejects with useful copy when the browser blocks the popup', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const authenticatedApi = {
      connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/connect' })),
      reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/reconnect' })),
    }

    await expect(openGitHubAccountPopup(authenticatedApi, { kind: 'connect' })).rejects.toThrow(
      'Allow pop-ups to connect GitHub, then try again.',
    )
    expect(authenticatedApi.connectAccount).not.toHaveBeenCalled()
    expect(authenticatedApi.reconnectAccount).not.toHaveBeenCalled()
  })
})
