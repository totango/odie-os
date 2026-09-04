/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const records = new Map<string, string>()
const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(async (cmd, args) => {
  if (cmd === 'read_session_secret') return records.get(args?.key as string) ?? null
  if (cmd === 'write_session_secret') {
    records.set(args?.key as string, args?.token as string)
    return undefined
  }
  if (cmd === 'clear_session_secret') {
    records.delete(args?.key as string)
    return undefined
  }
  if (cmd === 'unlock_session') return true
  return undefined
})

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('Tauri Rust-owned Stronghold runtime storage', () => {
  beforeEach(() => {
    records.clear()
    invoke.mockClear()
    ;(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    vi.resetModules()
  })

  it('resolves relative connector authorization URLs against the native gateway', async () => {
    const { createTauriRuntime } = await import('./tauriRuntime')
    const runtime = createTauriRuntime()

    await runtime.openExternal('/gatekeeper/jira/connect?state=opaque')

    expect(invoke).toHaveBeenCalledWith('open_external_link', {
      url: 'https://odie-os-native-api.odie-os.workers.dev/gatekeeper/jira/connect?state=opaque',
    })
  })

  it('stores pending flow and session token through narrow Rust commands only', async () => {
    const { createTauriRuntime } = await import('./tauriRuntime')
    const runtime = createTauriRuntime()

    await runtime.writePendingNativeLoginFlow({ flowHandle: 'handle', verifier: 'verifier', expiresAt: 'later' })
    await runtime.writeSessionSecret('user:session')
    await runtime.clearPendingNativeLoginFlow()
    await runtime.lock()

    expect(await runtime.readSessionSecret()).toBe('user:session')
    expect(await runtime.readPendingNativeLoginFlow()).toBeNull()
    expect(records.has('workshop.sessionToken')).toBe(true)
    expect(records.has('workshop.pendingNativeLoginFlow')).toBe(false)
    expect(invoke.mock.calls.map(([cmd]) => cmd).toSorted()).toEqual([
      'clear_session_secret',
      'lock_session',
      'read_session_secret',
      'read_session_secret',
      'write_session_secret',
      'write_session_secret',
    ])
    expect(invoke).toHaveBeenCalledWith('write_session_secret', { key: 'workshop.sessionToken', token: 'user:session' })
  })
})
