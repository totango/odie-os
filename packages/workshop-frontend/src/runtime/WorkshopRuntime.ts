export const ODIE_PRODUCTION_ORIGIN = 'https://odie-os.odie-os.workers.dev'
export const ODIE_NATIVE_API_ORIGIN = 'https://odie-os-native-api.odie-os.workers.dev'

export type DeepLinkEvent = {
  url: string
}

export type Unsubscribe = () => void

export interface SaveFileOptions {
  filename: string
  contentType: string
  extension?: string
  description?: string
}

export interface PendingNativeLoginFlow {
  flowHandle: string
  verifier: string
  expiresAt?: string
}

export interface WorkshopRuntime {
  readonly kind: 'web' | 'tauri'
  readonly apiOrigin: URL
  readonly publicWebOrigin: URL
  readonly appLinkOrigin: URL
  openExternal(url: string): Promise<void>
  openOAuthTrampoline(url: string): Promise<void>
  subscribeDeepLinks(callback: (event: DeepLinkEvent) => void): Promise<Unsubscribe>
  readSessionSecret(): Promise<string | null>
  writeSessionSecret(token: string): Promise<void>
  clearSessionSecret(): Promise<void>
  readPendingNativeLoginFlow(): Promise<PendingNativeLoginFlow | null>
  writePendingNativeLoginFlow(flow: PendingNativeLoginFlow): Promise<void>
  clearPendingNativeLoginFlow(): Promise<void>
  saveBlob(blob: Blob, options: SaveFileOptions): Promise<void>
  saveText(filename: string, content: string): Promise<void>
  lock(): Promise<void>
  unlock(): Promise<boolean>
}

export function envUrl(name: 'VITE_ODIE_API_ORIGIN' | 'VITE_ODIE_PUBLIC_WEB_ORIGIN' | 'VITE_ODIE_APP_LINK_ORIGIN'): URL | null {
  const raw = import.meta.env[name]?.trim()
  if (!raw) return null
  return new URL(raw)
}

export function originUrl(url: URL): URL {
  return new URL(url.origin)
}
