/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadRuntime() {
  vi.resetModules()
  return await import('./index')
}

describe('WorkshopRuntime selection', () => {
  beforeEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    localStorage.clear()
    vi.doUnmock('@tauri-apps/plugin-notification')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
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

  it('requests web notification permission only once after denial and sends only while not visible', async () => {
    const notifications: Array<{ title: string; body?: string }> = []
    const requestPermission = vi.fn<() => Promise<NotificationPermission>>(async () => 'denied')
    class FakeNotification {
      static permission: NotificationPermission = 'default'
      static requestPermission = requestPermission
      constructor(title: string, options?: NotificationOptions) {
        notifications.push({ title, body: options?.body })
      }
    }
    vi.stubGlobal('Notification', FakeNotification)
    const { getWorkshopRuntime } = await loadRuntime()
    const runtime = getWorkshopRuntime()

    expect(await runtime.requestNotificationPermission()).toBe(false)
    expect(await runtime.requestNotificationPermission()).toBe(false)
    expect(requestPermission).toHaveBeenCalledOnce()

    FakeNotification.permission = 'granted'
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await runtime.sendNotification({ title: 'Visible', body: 'ignored' })
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    await runtime.sendNotification({ title: 'Hidden', body: 'bounded' })

    expect(notifications).toEqual([{ title: 'Hidden', body: 'bounded' }])
  })

  it('uses the Tauri notification plugin permission and send APIs best-effort', async () => {
    const requestPermission = vi.fn<() => Promise<'granted'>>(async () => 'granted')
    const sendNotification = vi.fn<(options: { title: string; body: string }) => void>()
    vi.doMock('@tauri-apps/plugin-notification', () => ({
      isPermissionGranted: vi.fn<() => Promise<boolean>>(async () => false),
      requestPermission,
      sendNotification,
    }))
    ;(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    const { getWorkshopRuntime } = await loadRuntime()
    const runtime = getWorkshopRuntime()

    expect(await runtime.requestNotificationPermission()).toBe(true)
    await runtime.sendNotification({ title: 'Agent turn complete', body: 'Repair Jarvis' })

    expect(requestPermission).toHaveBeenCalledTimes(2)
    expect(sendNotification).toHaveBeenCalledWith({ title: 'Agent turn complete', body: 'Repair Jarvis' })
  })
})
