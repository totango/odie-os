import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, BrowserFlowOptions, BrowserFlowStart, NativeLoginFlowStatus } from '@gadgets/workshop-shared/api'
import { getWorkshopRuntime } from './runtime'

const NATIVE_ACCOUNT_FLOW_POLL_MS = 1_000

type FlowStart = (options?: { flow?: BrowserFlowOptions }) => Promise<Partial<BrowserFlowStart>>

export interface AccountBrowserFlowOptions {
  signal?: AbortSignal
  webPopup?: 'direct' | 'preopen' | 'none'
  webFallback?: 'location' | 'manual'
  webPreopenUrl?: string
  webNavigate?: 'href' | 'replace'
  requireWebPopup?: boolean
}

export interface AccountBrowserFlowResult {
  url?: string
  popupBlocked?: boolean
  nativeStatus?: NativeLoginFlowStatus
}

function base64Url(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function randomVerifier(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

async function sha256Hex(value: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function abortError(): DOMException {
  return new DOMException('Account browser flow was cancelled.', 'AbortError')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(done, ms)
    function done() {
      cleanup()
      resolve()
    }
    function abort() {
      cleanup()
      reject(abortError())
    }
    function cleanup() {
      window.clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function pollNativeAccountFlow(
  authenticatedApi: RpcStub<AuthenticatedApi>,
  flowHandle: string,
  verifier: string,
  signal: AbortSignal | undefined,
): Promise<NativeLoginFlowStatus> {
  for (;;) {
    throwIfAborted(signal)
    const status = await authenticatedApi.getNativeAccountFlowStatus(flowHandle, verifier)
    switch (status.status) {
      case 'completed':
        return status
      case 'failed':
        throw new Error(status.message || 'Account authorization failed.')
      case 'expired':
        throw new Error('Account authorization expired. Please try again.')
      case 'consumed':
        throw new Error('Account authorization was already completed.')
      case 'pending':
        await wait(NATIVE_ACCOUNT_FLOW_POLL_MS, signal)
        break
    }
  }
}

export async function runAccountBrowserFlow(
  authenticatedApi: RpcStub<AuthenticatedApi>,
  start: FlowStart,
  options: AccountBrowserFlowOptions = {},
): Promise<AccountBrowserFlowResult> {
  const runtime = getWorkshopRuntime()
  if (runtime.kind === 'tauri' && typeof runtime.openOAuthTrampoline === 'function') {
    const verifier = randomVerifier()
    const started = await start({
      flow: { returnMode: 'native-verified-link', clientVerifierHash: await sha256Hex(verifier) },
    })
    if (!started.url) return {}
    if (!started.flowHandle) throw new Error('Native account browser flow did not return a handle.')
    throwIfAborted(options.signal)
    await runtime.openOAuthTrampoline(started.url)
    const nativeStatus = await pollNativeAccountFlow(authenticatedApi, started.flowHandle, verifier, options.signal)
    return { url: started.url, nativeStatus }
  }

  let popup: Window | null = null
  if (options.webPopup === 'preopen') {
    popup = window.open(options.webPreopenUrl ?? 'about:blank', '_blank')
    if (popup) popup.opener = null
    else if (options.requireWebPopup) return { popupBlocked: true }
  }
  try {
    const started = await start()
    const url = started.url
    if (!url || options.webPopup === 'none') {
      popup?.close()
      return { url }
    }
    if (options.webPopup === 'preopen') {
      if (popup) {
        if (options.webNavigate === 'replace') popup.location.replace(url)
        else popup.location.href = url
      }
      else if (options.webFallback === 'manual') return { url, popupBlocked: true }
      else window.location.assign(url)
      return { url, popupBlocked: !popup }
    }
    window.open(url, '_blank', 'noopener,noreferrer')
    return { url }
  } catch (error) {
    popup?.close()
    throw error
  }
}

export const accountBrowserFlows = {
  connect(
    authenticatedApi: RpcStub<AuthenticatedApi>,
    vendorId: string,
    resourceUrlPatterns?: string[],
    options?: AccountBrowserFlowOptions,
  ) {
    return runAccountBrowserFlow(authenticatedApi, flow => flow
      ? authenticatedApi.connectAccount(vendorId, resourceUrlPatterns, flow)
      : resourceUrlPatterns === undefined
        ? authenticatedApi.connectAccount(vendorId)
        : authenticatedApi.connectAccount(vendorId, resourceUrlPatterns), options)
  },
  reconnect(authenticatedApi: RpcStub<AuthenticatedApi>, accountId: number, options?: AccountBrowserFlowOptions) {
    return runAccountBrowserFlow(authenticatedApi, flow => flow
      ? authenticatedApi.reconnectAccount(accountId, flow)
      : authenticatedApi.reconnectAccount(accountId), options)
  },
  grant(
    authenticatedApi: RpcStub<AuthenticatedApi>,
    accountId: number,
    resourceUrlPatterns: string[],
    options?: AccountBrowserFlowOptions,
  ) {
    return runAccountBrowserFlow(authenticatedApi, flow => flow
      ? authenticatedApi.ensureAccountResources(accountId, resourceUrlPatterns, flow)
      : authenticatedApi.ensureAccountResources(accountId, resourceUrlPatterns), options)
  },
}
