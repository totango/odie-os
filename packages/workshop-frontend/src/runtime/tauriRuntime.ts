import { envUrl, ODIE_NATIVE_API_ORIGIN, ODIE_PRODUCTION_ORIGIN, originUrl, shouldSendSystemNotification, type DeepLinkEvent, type NativeAppInfo, type PendingNativeLoginFlow, type SaveFileOptions, type SystemNotificationOptions, type Unsubscribe, type WorkshopRuntime } from './WorkshopRuntime'

const SESSION_SECRET_KEY = 'workshop.sessionToken'
const PENDING_NATIVE_LOGIN_FLOW_KEY = 'workshop.pendingNativeLoginFlow'

type TauriCore = { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> }
type TauriDeepLink = { getCurrent(): Promise<string[] | null>; onOpenUrl(callback: (urls: string[]) => void): Promise<Unsubscribe> }
type TauriNotification = {
  isPermissionGranted(): Promise<boolean>
  requestPermission(): Promise<'granted' | 'denied' | 'default'>
  sendNotification(options: SystemNotificationOptions): void
}

declare global {
  interface Window { __TAURI_INTERNALS__?: unknown }
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined
}

async function importTauriCore(): Promise<TauriCore> {
  return await import(/* @vite-ignore */ '@tauri-apps/api/core') as TauriCore
}

async function importTauriDeepLink(): Promise<TauriDeepLink> {
  return await import(/* @vite-ignore */ '@tauri-apps/plugin-deep-link') as TauriDeepLink
}

async function importTauriNotification(): Promise<TauriNotification> {
  return await import(/* @vite-ignore */ '@tauri-apps/plugin-notification') as TauriNotification
}

function productionOrigin(): URL {
  return envUrl('VITE_ODIE_API_ORIGIN') ?? new URL(ODIE_NATIVE_API_ORIGIN)
}

async function readNativeSecret(key: string): Promise<string | null> {
  const core = await importTauriCore()
  return await core.invoke<string | null>('read_session_secret', { key })
}

async function writeNativeSecret(key: string, token: string): Promise<void> {
  const core = await importTauriCore()
  await core.invoke('write_session_secret', { key, token })
}

async function clearNativeSecret(key: string): Promise<void> {
  const core = await importTauriCore()
  await core.invoke('clear_session_secret', { key })
}

export function createTauriRuntime(): WorkshopRuntime {
  const apiOrigin = productionOrigin()
  const publicWebOrigin = envUrl('VITE_ODIE_PUBLIC_WEB_ORIGIN') ?? new URL(ODIE_PRODUCTION_ORIGIN)
  const appLinkOrigin = envUrl('VITE_ODIE_APP_LINK_ORIGIN') ?? new URL(ODIE_NATIVE_API_ORIGIN)
  let deniedThisRuntime = false
  async function ensureNotificationPermission() {
    try {
      const notification = await importTauriNotification()
      if (await notification.isPermissionGranted()) return true
      if (deniedThisRuntime) return false
      const permission = await notification.requestPermission()
      if (permission === 'denied') deniedThisRuntime = true
      return permission === 'granted'
    } catch {
      return false
    }
  }
  return {
    kind: 'tauri',
    apiOrigin: originUrl(apiOrigin),
    publicWebOrigin: originUrl(publicWebOrigin),
    appLinkOrigin: originUrl(appLinkOrigin),
    async getNativeAppInfo() {
      const core = await importTauriCore()
      return await core.invoke<NativeAppInfo>('native_app_info')
    },
    async openExternal(url: string) {
      const parsed = new URL(url, apiOrigin)
      const core = await importTauriCore()
      await core.invoke('open_external_link', { url: parsed.toString() })
    },
    async openOAuthTrampoline(url: string) {
      const parsed = new URL(url, apiOrigin)
      const core = await importTauriCore()
      await core.invoke('open_oauth_trampoline', { url: parsed.toString() })
    },
    async subscribeDeepLinks(callback: (event: DeepLinkEvent) => void): Promise<Unsubscribe> {
      const deepLink = await importTauriDeepLink()
      const current = await deepLink.getCurrent().catch(() => null)
      for (const url of current ?? []) callback({ url })
      return await deepLink.onOpenUrl((urls) => {
        for (const url of urls) callback({ url })
      })
    },
    async readSessionSecret() {
      return await readNativeSecret(SESSION_SECRET_KEY)
    },
    async writeSessionSecret(token: string) {
      await writeNativeSecret(SESSION_SECRET_KEY, token)
    },
    async clearSessionSecret() {
      await clearNativeSecret(SESSION_SECRET_KEY)
    },
    async readPendingNativeLoginFlow() {
      const raw = await readNativeSecret(PENDING_NATIVE_LOGIN_FLOW_KEY)
      return raw ? JSON.parse(raw) as PendingNativeLoginFlow : null
    },
    async writePendingNativeLoginFlow(flow: PendingNativeLoginFlow) {
      await writeNativeSecret(PENDING_NATIVE_LOGIN_FLOW_KEY, JSON.stringify(flow))
    },
    async clearPendingNativeLoginFlow() {
      await clearNativeSecret(PENDING_NATIVE_LOGIN_FLOW_KEY)
    },
    async saveBlob(blob: Blob, options: SaveFileOptions) {
      const core = await importTauriCore()
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
      await core.invoke('save_file', { filename: options.filename, contentType: options.contentType, bytes })
    },
    async saveText(filename: string, content: string) {
      const core = await importTauriCore()
      await core.invoke('save_text_file', { filename, content })
    },
    async requestNotificationPermission() {
      return await ensureNotificationPermission()
    },
    async sendNotification(options: SystemNotificationOptions) {
      try {
        if (!shouldSendSystemNotification()) return
        const notification = await importTauriNotification()
        if (!(await ensureNotificationPermission())) return
        notification.sendNotification(options)
      } catch {}
    },
    async lock() {
      const core = await importTauriCore()
      await core.invoke('lock_session')
    },
    async unlock() {
      const core = await importTauriCore()
      return await core.invoke<boolean>('unlock_session')
    },
  }
}
