/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { WorkshopRuntime } from './runtime'
import { accountBrowserFlows } from './accountBrowserFlow'

const runtime = {
  kind: 'web',
  openOAuthTrampoline: vi.fn<WorkshopRuntime['openOAuthTrampoline']>(async () => {}),
} as unknown as WorkshopRuntime

vi.mock('./runtime', () => ({ getWorkshopRuntime: () => runtime }))

function api(overrides: Partial<AuthenticatedApi> = {}) {
  return {
    connectAccount: vi.fn<AuthenticatedApi['connectAccount']>(async () => ({ url: 'https://oauth.example/connect' })),
    reconnectAccount: vi.fn<AuthenticatedApi['reconnectAccount']>(async () => ({ url: 'https://oauth.example/reconnect' })),
    ensureAccountResources: vi.fn<AuthenticatedApi['ensureAccountResources']>(async () => ({ url: 'https://oauth.example/grant' })),
    getNativeAccountFlowStatus: vi.fn<AuthenticatedApi['getNativeAccountFlowStatus']>(async () => ({ status: 'completed' as const })),
    ...overrides,
  } as unknown as AuthenticatedApi
}

describe('accountBrowserFlows', () => {
  beforeEach(() => {
    vi.spyOn(window, 'open').mockReturnValue({
      location: { href: '', replace: vi.fn<(url?: string) => void>() },
      close: vi.fn<() => void>(),
      opener: null,
    } as unknown as Window)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    ;(runtime as { kind: 'web' | 'tauri' }).kind = 'web'
    vi.mocked(runtime.openOAuthTrampoline).mockClear()
  })

  it('preserves direct web popup behavior', async () => {
    const authenticatedApi = api()
    await accountBrowserFlows.connect(authenticatedApi as any, 'github')

    expect(authenticatedApi.connectAccount).toHaveBeenCalledWith('github')
    expect(window.open).toHaveBeenCalledWith('https://oauth.example/connect', '_blank', 'noopener,noreferrer')
    expect(runtime.openOAuthTrampoline).not.toHaveBeenCalled()
  })

  it('starts native connect with verifier hash, opens trampoline, and polls to completion', async () => {
    vi.useFakeTimers()
    ;(runtime as { kind: 'web' | 'tauri' }).kind = 'tauri'
    const authenticatedApi = api({
      connectAccount: vi.fn<AuthenticatedApi['connectAccount']>(async () => ({ url: 'https://native.example/start', flowHandle: 'flow-1' })),
      getNativeAccountFlowStatus: vi.fn<AuthenticatedApi['getNativeAccountFlowStatus']>()
        .mockResolvedValueOnce({ status: 'pending' })
        .mockResolvedValueOnce({ status: 'completed' }),
    })

    const done = accountBrowserFlows.connect(authenticatedApi as any, 'github')
    await vi.waitFor(() => expect(runtime.openOAuthTrampoline).toHaveBeenCalledWith('https://native.example/start'))
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(done).resolves.toMatchObject({ nativeStatus: { status: 'completed' } })

    const options = vi.mocked(authenticatedApi.connectAccount).mock.calls[0][2]
    expect(options?.flow?.returnMode).toBe('native-verified-link')
    expect(options?.flow?.clientVerifierHash).toMatch(/^[a-f0-9]{64}$/)
    expect(authenticatedApi.getNativeAccountFlowStatus).toHaveBeenCalledTimes(2)
    expect(vi.mocked(authenticatedApi.getNativeAccountFlowStatus).mock.calls[0][0]).toBe('flow-1')
  })

  it('starts native reconnect through the same flow runner', async () => {
    ;(runtime as { kind: 'web' | 'tauri' }).kind = 'tauri'
    const authenticatedApi = api({ reconnectAccount: vi.fn<AuthenticatedApi['reconnectAccount']>(async () => ({ url: 'https://native.example/reconnect', flowHandle: 'flow-2' })) })

    await accountBrowserFlows.reconnect(authenticatedApi as any, 12)

    expect(authenticatedApi.reconnectAccount).toHaveBeenCalledWith(12, expect.objectContaining({ flow: expect.objectContaining({ returnMode: 'native-verified-link' }) }))
    expect(authenticatedApi.getNativeAccountFlowStatus).toHaveBeenCalledWith('flow-2', expect.any(String))
  })

  it('starts native grant through the same flow runner', async () => {
    ;(runtime as { kind: 'web' | 'tauri' }).kind = 'tauri'
    const authenticatedApi = api({ ensureAccountResources: vi.fn<AuthenticatedApi['ensureAccountResources']>(async () => ({ url: 'https://native.example/grant', flowHandle: 'flow-3' })) })

    await accountBrowserFlows.grant(authenticatedApi as any, 12, ['repo:*'])

    expect(authenticatedApi.ensureAccountResources).toHaveBeenCalledWith(12, ['repo:*'], expect.objectContaining({ flow: expect.objectContaining({ returnMode: 'native-verified-link' }) }))
    expect(authenticatedApi.getNativeAccountFlowStatus).toHaveBeenCalledWith('flow-3', expect.any(String))
  })

  it('surfaces native status failures', async () => {
    ;(runtime as { kind: 'web' | 'tauri' }).kind = 'tauri'
    const authenticatedApi = api({
      connectAccount: vi.fn<AuthenticatedApi['connectAccount']>(async () => ({ url: 'https://native.example/start', flowHandle: 'flow-4' })),
      getNativeAccountFlowStatus: vi.fn<AuthenticatedApi['getNativeAccountFlowStatus']>(async () => ({ status: 'failed', message: 'denied' })),
    })

    await expect(accountBrowserFlows.connect(authenticatedApi as any, 'github')).rejects.toThrow('denied')
  })

  it('stops native status polling when cancelled', async () => {
    ;(runtime as { kind: 'web' | 'tauri' }).kind = 'tauri'
    const controller = new AbortController()
    const authenticatedApi = api({
      connectAccount: vi.fn<AuthenticatedApi['connectAccount']>(async () => ({ url: 'https://native.example/start', flowHandle: 'flow-5' })),
      getNativeAccountFlowStatus: vi.fn<AuthenticatedApi['getNativeAccountFlowStatus']>(async () => ({ status: 'pending' })),
    })

    const pending = accountBrowserFlows.connect(authenticatedApi as any, 'github', undefined, { signal: controller.signal })
    await vi.waitFor(() => expect(authenticatedApi.getNativeAccountFlowStatus).toHaveBeenCalledOnce())
    controller.abort()

    await expect(pending).rejects.toThrow('Account browser flow was cancelled.')
    expect(authenticatedApi.getNativeAccountFlowStatus).toHaveBeenCalledOnce()
  })
})
