/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadRuntime() {
  vi.resetModules()
  return await import('./index')
}

describe('WorkshopRuntime selection', () => {
  beforeEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    localStorage.clear()
  })

  it('uses browser storage only for the web runtime', async () => {
    const { getWorkshopRuntime } = await loadRuntime()
    const runtime = getWorkshopRuntime()
    expect(runtime.kind).toBe('web')
    await runtime.writeSessionSecret('token-1')
    expect(localStorage.getItem('authToken')).toBe('token-1')
    expect(await runtime.readSessionSecret()).toBe('token-1')
    await runtime.clearSessionSecret()
    expect(await runtime.readSessionSecret()).toBeNull()
  })

  it('defaults native origins to Odie production', async () => {
    ;(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    const { getWorkshopRuntime } = await loadRuntime()
    const runtime = getWorkshopRuntime()
    expect(runtime.kind).toBe('tauri')
    expect(runtime.apiOrigin.origin).toBe('https://odie-os-native-api.odie-os.workers.dev')
    expect(runtime.publicWebOrigin.origin).toBe('https://odie-os.odie-os.workers.dev')
    expect(runtime.appLinkOrigin.origin).toBe('https://odie-os-native-api.odie-os.workers.dev')
  })
})
