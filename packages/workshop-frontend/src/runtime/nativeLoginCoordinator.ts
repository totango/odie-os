import { type RpcStub } from 'capnweb'
import type { PublicApi, AuthenticatedApi, NativeLoginConsumeResult } from '@gadgets/workshop-shared/api'
import { parseNativeDeepLink } from './deepLinks'
import type { WorkshopRuntime } from './WorkshopRuntime'
import { nativeFlowStore } from './nativeFlowStore'

export const NATIVE_LOGIN_TOKEN_EVENT = 'workshop:native-login-token'
const NATIVE_LOGIN_FOREGROUND_DELAY_MS = 250

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
  ticket?: string,
  assertActive: () => void = () => {},
): Promise<boolean> {
  if (runtime.kind !== 'tauri') return false
  const store = nativeFlowStore(runtime)
  const snapshot = await store.read()
  const pending = snapshot?.flow
  if (!pending || pending.purpose === 'account' || (expectedHandle !== undefined && pending.flowHandle !== expectedHandle)) return false
  if (ticket !== undefined && !/^[0-9a-f]{64}$/.test(ticket)) return false
  const api = getPublicApi()
  const assertAuthority = () => {
    assertActive()
    if (getPublicApi() !== api) throw new Error('Sign-in authority changed')
  }
  const completionTicket = ticket ?? pending.ticket
  const dispatched = await store.dispatch<NativeLoginConsumeResult>(snapshot, ticket ? { ...pending, ticket } : undefined,
    assertAuthority, () => api.consumeNativeLoginFlow(pending.flowHandle, pending.verifier, completionTicket))
  if (!dispatched) return false
  const result = await dispatched.result
  switch (result.status) {
    case 'completed':
      // A legacy server must not turn a status-only poll into authentication.
      if (!completionTicket) return false
      if (!await store.finish(snapshot, assertAuthority, result.token)) return false
      dispatchNativeLoginToken(result.token)
      return true
    case 'expired':
    case 'consumed':
    case 'verifier-mismatch':
    case 'failed':
      return store.finish(snapshot, assertAuthority)
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
  return await consumePendingNativeLogin(runtime, getPublicApi, parsed.handle, parsed.ticket)
}

/** Redeem authenticated native grants with both independently held verifier and return ticket. */
export async function consumePendingNativeAccount(
  runtime: WorkshopRuntime,
  getApi: () => RpcStub<AuthenticatedApi>,
  expectedHandle?: string,
  ticket?: string,
  assertActive: () => void = () => {},
): Promise<boolean> {
  if (runtime.kind !== 'tauri') return false
  const store = nativeFlowStore(runtime)
  const snapshot = await store.read()
  const pending = snapshot?.flow
  if (!pending || pending.purpose !== 'account' || (expectedHandle !== undefined && expectedHandle !== pending.flowHandle)) return false
  if (ticket !== undefined && !/^[0-9a-f]{64}$/.test(ticket)) return false
  const api = getApi()
  const assertAuthority = () => {
    assertActive()
    if (getApi() !== api) throw new Error('Account authority changed')
  }
  assertAuthority()
  const status = await api.getNativeAccountFlowStatus(pending.flowHandle, pending.verifier)
  // A legacy `consumed` or any unknown state does not prove that activation completed.
  // Keep recovery material until K's confirmed terminal result is available.
  if (status.status === 'completed' || status.status === 'expired' || status.status === 'failed') return store.finish(snapshot, assertAuthority)
  if (status.status !== 'pending') return false
  const completionTicket = ticket ?? pending.ticket
  if (!completionTicket || pending.activationAttempted) return false
  const dispatched = await store.dispatch(snapshot, { ...pending, ticket: completionTicket, activationAttempted: true },
    assertAuthority, () => api.completeNativeAccountFlow(pending.flowHandle, pending.verifier, completionTicket), true)
  if (!dispatched) return false
  await dispatched.result
  return store.finish(snapshot, assertAuthority)
}

export function installNativeLoginCoordinator(
  runtime: WorkshopRuntime,
  getPublicApi: () => RpcStub<PublicApi>,
): Promise<() => void> {
  return installNativeFlowCoordinator(runtime, (handle, ticket, assertActive) => consumePendingNativeLogin(runtime, getPublicApi, handle, ticket, assertActive))
}

/** Runs only inside the current authenticated epoch; account grants never use the public login API. */
export function installNativeAccountCoordinator(runtime: WorkshopRuntime, getApi: () => RpcStub<AuthenticatedApi>): Promise<() => void> {
  return installNativeFlowCoordinator(runtime, (handle, ticket, assertActive) => consumePendingNativeAccount(runtime, getApi, handle, ticket, assertActive))
}

async function installNativeFlowCoordinator(runtime: WorkshopRuntime,
  consumePending: (handle: string | undefined, ticket: string | undefined, assertActive: () => void) => Promise<boolean>,
): Promise<() => void> {
  if (runtime.kind !== 'tauri') return () => {}
  let consuming = false
  let queuedLink: { handle: string; ticket: string } | undefined
  let closed = false
  let foregroundTimer: number | null = null
  const consume = async (link?: { handle: string; ticket: string }) => {
    if (closed) return
    if (link) queuedLink = link
    if (consuming) return
    consuming = true
    try {
      const next = queuedLink
      queuedLink = undefined
      await consumePending(next?.handle, next?.ticket, () => { if (closed) throw new Error('Native flow coordinator closed') })
    } catch {
      // Network/RPC failures are transient. Keep the verifier so focus, polling, or a later verified
      // link can retry after the app reconnects.
    } finally {
      consuming = false
      if (queuedLink && !closed) void consume()
    }
  }
  let unsubscribe = () => {}
  try {
    unsubscribe = await runtime.subscribeDeepLinks(({ url }) => {
      const parsed = parseNativeDeepLink(url, runtime.appLinkOrigin.origin)
      if (parsed?.kind === 'oauth-return') void consume(parsed)
    })
  } catch {
    // Polling can retry a previously received ticket, but cannot replace ticket delivery.
  }
  const onForeground = () => {
    if (document.visibilityState !== 'visible' || foregroundTimer !== null) return
    foregroundTimer = window.setTimeout(() => {
      foregroundTimer = null
      if (document.visibilityState === 'visible') void consume()
    }, NATIVE_LOGIN_FOREGROUND_DELAY_MS)
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      if (foregroundTimer !== null) {
        window.clearTimeout(foregroundTimer)
        foregroundTimer = null
      }
      void runtime.lock().catch(() => {})
    } else {
      onForeground()
    }
  }
  window.addEventListener('focus', onForeground)
  document.addEventListener('visibilitychange', onVisibilityChange)
  const poll = window.setInterval(onForeground, 2_000)
  void consume()
  return () => {
    closed = true
    window.clearInterval(poll)
    if (foregroundTimer !== null) window.clearTimeout(foregroundTimer)
    window.removeEventListener('focus', onForeground)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    unsubscribe()
  }
}
