import { type RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'
import { parseNativeDeepLink } from './deepLinks'
import type { WorkshopRuntime } from './WorkshopRuntime'

export const NATIVE_LOGIN_TOKEN_EVENT = 'workshop:native-login-token'

type NativeLoginTokenEvent = CustomEvent<{ token: string }>

export function dispatchNativeLoginToken(token: string): void {
  window.dispatchEvent(new CustomEvent(NATIVE_LOGIN_TOKEN_EVENT, { detail: { token } }))
}

export function addNativeLoginTokenListener(callback: (token: string) => void): () => void {
  const listener = (event: Event) => callback((event as NativeLoginTokenEvent).detail.token)
  window.addEventListener(NATIVE_LOGIN_TOKEN_EVENT, listener)
  return () => window.removeEventListener(NATIVE_LOGIN_TOKEN_EVENT, listener)
}

export async function consumePendingNativeLogin(
  runtime: WorkshopRuntime,
  getPublicApi: () => RpcStub<PublicApi>,
  expectedHandle?: string,
): Promise<boolean> {
  if (runtime.kind !== 'tauri') return false
  const pending = await runtime.readPendingNativeLoginFlow()
  if (!pending || (expectedHandle !== undefined && pending.flowHandle !== expectedHandle)) return false

  const result = await getPublicApi().consumeNativeLoginFlow(pending.flowHandle, pending.verifier)
  switch (result.status) {
    case 'completed':
      await runtime.writeSessionSecret(result.token)
      await runtime.clearPendingNativeLoginFlow()
      dispatchNativeLoginToken(result.token)
      return true
    case 'expired':
    case 'consumed':
    case 'verifier-mismatch':
    case 'failed':
      await runtime.clearPendingNativeLoginFlow()
      return true
    case 'pending':
      return false
  }
}

export async function consumePendingNativeLoginUrl(
  runtime: WorkshopRuntime,
  getPublicApi: () => RpcStub<PublicApi>,
  rawUrl: string,
): Promise<boolean> {
  if (runtime.kind !== 'tauri') return false
  const parsed = parseNativeDeepLink(rawUrl, runtime.appLinkOrigin.origin)
  if (parsed?.kind !== 'oauth-return') return false
  return await consumePendingNativeLogin(runtime, getPublicApi, parsed.handle)
}

export async function installNativeLoginCoordinator(
  runtime: WorkshopRuntime,
  getPublicApi: () => RpcStub<PublicApi>,
): Promise<() => void> {
  if (runtime.kind !== 'tauri') return () => {}
  let consuming = false
  const consume = async (expectedHandle?: string) => {
    if (consuming) return
    consuming = true
    try {
      await consumePendingNativeLogin(runtime, getPublicApi, expectedHandle)
    } catch {
      // Network/RPC failures are transient. Keep the verifier so focus, polling, or a later verified
      // link can retry after the app reconnects.
    } finally {
      consuming = false
    }
  }
  const unsubscribe = await runtime.subscribeDeepLinks(({ url }) => {
    const parsed = parseNativeDeepLink(url, runtime.appLinkOrigin.origin)
    if (parsed?.kind === 'oauth-return') void consume(parsed.handle)
  })
  const onForeground = () => { if (document.visibilityState === 'visible') void consume() }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') void runtime.lock().catch(() => {})
    else void consume()
  }
  window.addEventListener('focus', onForeground)
  document.addEventListener('visibilitychange', onVisibilityChange)
  const poll = window.setInterval(onForeground, 2_000)
  void consume()
  return () => {
    window.clearInterval(poll)
    window.removeEventListener('focus', onForeground)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    unsubscribe()
  }
}
