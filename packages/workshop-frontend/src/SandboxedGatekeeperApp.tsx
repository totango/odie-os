import { type CSSProperties, useCallback, useEffect, useInsertionEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { RpcStub, RpcTarget, newMessagePortRpcSession } from 'capnweb'
import { useNavigate } from '@tanstack/react-router'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from '@gadgets/workshop-shared/theme'
import { isHexColor } from '@gadgets/workshop-shared/api'
import { createRateLimitedCapability } from './rateLimitedCapability'
import { useTheme } from './ThemeContext'
import { useServerConfig } from './ServerConfigContext'
import { forwardTrustedFrameError } from './errorReporting'
import { useAuthenticatedApi } from './AuthContext'
import {
  normalizeGatekeeperAppCodingSessionTitle,
  normalizeGatekeeperAppPrompt,
  parseGatekeeperAppWorkspaceTarget,
  type GatekeeperAppWorkspaceTarget,
} from './gatekeeperAppNavigation'
import { normalizeWorkItemTarget, type WorkItemTarget } from './workItemNavigation'

// The content-pane rect, in viewport coordinates, that the app pins its page to while the iframe
// is full-viewport.
type OverlayRect = { left: number; top: number; width: number; height: number }

// The host's reply to a present/dismiss. On open, `rect` is where the app holds its page fixed while
// the iframe expands to full-viewport (null on restore); `willResize` is whether switching the iframe
// to/from full-viewport actually changes its pixel size (it won't if the pane already fills the window).
type PresentAck = { rect: OverlayRect | null; willResize: boolean }

// Grows the app's iframe to a full-viewport overlay for app-level modals (true) or restores it (false).
type PresentController = (active: boolean) => PresentAck
type OpenTarget = (target: GatekeeperAppWorkspaceTarget) => void
// Resolves workspace IDs the app already holds to their live titles; null for a workspace the user
// can no longer see. Deliberately a lookup, not an enumeration: the app learns nothing new.
type ResolveWorkspaceTitles = (ids: string[]) => Promise<(string | null)[]>
type OpenPrompt = (prompt: string) => void
type RequestCodingSession = (target: WorkItemTarget, title: string) => void
type RouteStateSetter = (value: string) => void

// Lifecycle controls are host-local, not string-named methods exposed through Cap'n Web.
const suspendHost = Symbol('suspendHost')
const refreshHost = Symbol('refreshHost')
const disposeHost = Symbol('disposeHost')
const updateHostTheme = Symbol('updateHostTheme')

/** One independently authorized management capability exposed to a composite gatekeeper app. */
export type GatekeeperAppDependency = {
  app: GatekeeperAppInfo
  capability: any
  error?: string
}

const EMPTY_DEPENDENCIES: GatekeeperAppDependency[] = []

type OverlayState = 'full' | null

// Upper bound on one workspace-title lookup, matching the app's page size.
const MAX_RESOLVED_WORKSPACES = 100

// How long one gadget listing is reused across title lookups. The untrusted frame calls this once
// per page of rows (and could call it in a loop), so the listing is shared rather than repeated.
const WORKSPACE_TITLES_TTL_MS = 10_000
export const MAX_GATEKEEPER_APP_ROUTE_STATE_LENGTH = 2048

export function normalizeGatekeeperAppRouteState(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length > MAX_GATEKEEPER_APP_ROUTE_STATE_LENGTH) return undefined
  for (let index = 0; index < value.length; index++) {
    const charCode = value.charCodeAt(index)
    if (charCode <= 0x1F || charCode === 0x7F) return undefined
  }
  return value
}

function requireGatekeeperAppRouteState(value: string): string {
  const normalized = normalizeGatekeeperAppRouteState(value)
  if (normalized === undefined) throw new TypeError('Invalid gatekeeper app route state.')
  return normalized
}

// Near the max int, so the full-viewport iframe sits above all Workshop chrome.
const overlayZIndex = 2147483000

const baseIframeStyle: CSSProperties = {
  border: 0,
  background: 'transparent',
}

function iframeStyleForOverlay(overlay: OverlayState): CSSProperties {
  if (overlay === 'full') {
    return {
      ...baseIframeStyle,
      position: 'fixed',
      top: 'calc(var(--app-top) + env(safe-area-inset-top))',
      right: 'env(safe-area-inset-right)',
      bottom: 'calc(var(--app-bottom) + env(safe-area-inset-bottom))',
      left: 'env(safe-area-inset-left)',
      width: 'auto',
      height: 'auto',
      zIndex: overlayZIndex,
    }
  }
  return {
    ...baseIframeStyle,
    display: 'block',
    width: '100%',
    height: '100%',
  }
}

// The host capability exposed to the sandboxed app (the gatekeeper's iframe UI) over the MessagePort
// RPC session. The app uses `ui` to reach the gatekeeper's own capability, which Workshop relays and
// rate-limits. `setPresenting` stays in Workshop and only grows/restores the iframe's layout.
class GatekeeperAppHostImpl extends RpcTarget {
  #active = true
  #closed = false
  #epoch = 0
  readonly #authorityCurrent: () => boolean
  #rootSlot: ReturnType<typeof createRateLimitedCapability>
  #rootTarget: any
  #dependencyTargets = new Map<string, any>()
  #slots = new Map<string, ReturnType<typeof createRateLimitedCapability>>()
  readonly #ui: RpcStub<RpcTarget>
  readonly #capabilities = new Map<string, {
    app: GatekeeperAppInfo
    capability: any
    error?: string
  }>()
  readonly #present: PresentController
  readonly #openTarget: OpenTarget
  readonly #openPrompt: OpenPrompt
  readonly #codingSessionAvailable: () => boolean
  readonly #codingSessionRequestAllowed: boolean
  readonly #requestCodingSession: RequestCodingSession
  readonly #resolveWorkspaceTitles: ResolveWorkspaceTitles
  readonly #getRouteState: () => string
  readonly #setRouteState: RouteStateSetter
  #presenting = false
  #theme: GatekeeperAppTheme
  #themeReceiver: RpcStub<GatekeeperAppThemeReceiver> | null = null
  // Presentation changes are coalesced to a single apply per animation frame (see #applyPending).
  #pendingActive: boolean | null = null
  #pendingResolvers: ((ack: PresentAck) => void)[] = []
  #frameId: number | null = null
  readonly #retryProviders: () => void
  readonly #openConnectors: () => void

  constructor(
    capability: any,
    present: PresentController,
    theme: GatekeeperAppTheme,
    openTarget: OpenTarget,
    openPrompt: OpenPrompt,
    codingSessionAvailable: () => boolean,
    codingSessionRequestAllowed: boolean,
    requestCodingSession: RequestCodingSession,
    resolveWorkspaceTitles: ResolveWorkspaceTitles,
    getRouteState: () => string,
    setRouteState: RouteStateSetter,
    dependencies: GatekeeperAppDependency[],
    retryProviders: () => void,
    openConnectors: () => void,
    authorityCurrent: () => boolean,
  ) {
    super()
    this.#authorityCurrent = authorityCurrent
    this.#theme = theme
    this.#retryProviders = retryProviders
    this.#openConnectors = openConnectors
    const rootSlot = createRateLimitedCapability(capability, {
      maxConcurrency: 8,
      maxCallsPerMinute: 600,
      maxPendingCalls: 128,
      onRateLimit: 'throttle',
      label: 'Gatekeeper app',
      assertAuthority: () => this.#assertActive(),
    })
    this.#rootSlot = rootSlot
    this.#rootTarget = capability
    this.#ui = rootSlot.capability
    for (const dependency of dependencies) {
      if (dependency.error || !dependency.capability) {
        this.#capabilities.set(dependency.app.id, dependency)
        continue
      }
      const limited = createRateLimitedCapability(dependency.capability, {
        maxConcurrency: 8,
        maxCallsPerMinute: 600,
        maxPendingCalls: 128,
        onRateLimit: 'throttle',
        label: `Gatekeeper app dependency ${dependency.app.id}`,
        assertAuthority: () => this.#assertActive(),
      })
      this.#capabilities.set(dependency.app.id, {
        app: dependency.app,
        capability: limited.capability,
      })
      this.#slots.set(dependency.app.id, limited)
      this.#dependencyTargets.set(dependency.app.id, dependency.capability)
    }
    this.#present = present
    this.#openTarget = openTarget
    this.#openPrompt = openPrompt
    this.#codingSessionAvailable = codingSessionAvailable
    this.#codingSessionRequestAllowed = codingSessionRequestAllowed
    this.#requestCodingSession = requestCodingSession
    this.#resolveWorkspaceTitles = resolveWorkspaceTitles
    this.#getRouteState = getRouteState
    this.#setRouteState = setRouteState
  }

  #assertActive() {
    if (!this.#active || this.#closed || !this.#authorityCurrent()) throw new Error('Gatekeeper app is no longer available.')
  }

  [suspendHost]() {
    this.#active = false
    this.#rootTarget = null
    this.#dependencyTargets.clear()
    this.#epoch++
    this.#rootSlot.suspend()
    for (const slot of this.#slots.values()) slot.suspend()
    if (this.#frameId !== null) cancelAnimationFrame(this.#frameId)
    this.#frameId = null
    for (const resolve of this.#pendingResolvers) resolve({ rect: null, willResize: false })
    this.#pendingResolvers = []
    this.#pendingActive = null
  }

  [refreshHost](capability: any, dependencies: GatekeeperAppDependency[]) {
    if (this.#closed) return
    if (!this.#active || this.#rootTarget !== capability) this.#rootSlot.replace(capability)
    this.#rootTarget = capability
    const available = new Set(dependencies.filter(d => d.capability && !d.error).map(d => d.app.id))
    for (const [id, slot] of this.#slots) {
      if (!available.has(id)) { slot.dispose(); this.#slots.delete(id); this.#dependencyTargets.delete(id) }
    }
    this.#capabilities.clear()
    for (const dependency of dependencies) {
      if (!available.has(dependency.app.id)) {
        this.#capabilities.set(dependency.app.id, { ...dependency, capability: null })
        continue
      }
      let slot = this.#slots.get(dependency.app.id)
      if (slot) {
        if (!this.#active || this.#dependencyTargets.get(dependency.app.id) !== dependency.capability) slot.replace(dependency.capability)
      }
      else {
        slot = createRateLimitedCapability(dependency.capability, {
          maxConcurrency: 8, maxCallsPerMinute: 600, maxPendingCalls: 128,
          onRateLimit: 'throttle', label: `Gatekeeper app dependency ${dependency.app.id}`,
          assertAuthority: () => this.#assertActive(),
        })
        this.#slots.set(dependency.app.id, slot)
      }
      this.#capabilities.set(dependency.app.id, { ...dependency, capability: slot.capability })
      this.#dependencyTargets.set(dependency.app.id, dependency.capability)
    }
    this.#active = true
  }

  get ui(): RpcStub<RpcTarget> {
    this.#assertActive()
    return this.#ui
  }

  // Metadata carries no authority. The app must request one of the listed opaque IDs separately.
  listCapabilities(): GatekeeperAppInfo[] {
    this.#assertActive()
    return [...this.#capabilities.values()].map(({ app }) => app)
  }

  getCapability(id: string): RpcStub<RpcTarget> | null {
    this.#assertActive()
    const dependency = this.#capabilities.get(id)
    if (dependency?.error) throw new Error(dependency.error)
    return this.#capabilities.get(id)?.capability ?? null
  }

  openWorkItemsConnectors(): void {
    this.#assertActive()
    if (!this.#codingSessionRequestAllowed) throw new Error('Not available to this app.')
    this.#openConnectors()
  }

  retryWorkItemsProviders(): void {
    this.#assertActive()
    if (!this.#codingSessionRequestAllowed) throw new Error('Not available to this app.')
    this.#retryProviders()
  }

  // Navigate to a workspace the app knows about. The IDs are validated here because the app is
  // untrusted; navigation stays in-app rather than handing the frame a URL to follow.
  openWorkspace(workspaceId: string, gadgetId?: number): void {
    this.#assertActive()
    this.#openTarget(parseGatekeeperAppWorkspaceTarget(workspaceId, gadgetId))
  }

  // Resolve live titles for workspaces the app already references, so it never renders a stale
  // snapshot. Bounded per call; unknown or no-longer-visible workspaces come back as null.
  async resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]> {
    this.#assertActive()
    const epoch = this.#epoch
    if (!Array.isArray(ids) || ids.length > MAX_RESOLVED_WORKSPACES) {
      throw new TypeError('Invalid workspace title lookup.')
    }
    const result = await this.#resolveWorkspaceTitles(ids)
    this.#assertActive()
    if (epoch !== this.#epoch) throw new Error('Gatekeeper app authority changed.')
    return result
  }

  openPrompt(prompt: string): void {
    this.#assertActive()
    this.#openPrompt(normalizeGatekeeperAppPrompt(prompt))
  }

  codingSessionAvailable(): boolean {
    this.#assertActive()
    return this.#codingSessionRequestAllowed && this.#codingSessionAvailable()
  }

  requestCodingSession(source: unknown, id: unknown, key: unknown, url: unknown, title: string): void {
    this.#assertActive()
    if (!this.#codingSessionRequestAllowed || !this.#codingSessionAvailable()) {
      throw new Error('Coding-session requests are not available to this app.')
    }
    this.#requestCodingSession(
      normalizeWorkItemTarget(source, id, key, url),
      normalizeGatekeeperAppCodingSessionTitle(title),
    )
  }

  getRouteState(): string {
    this.#assertActive()
    return this.#getRouteState()
  }

  setRouteState(value: string): void {
    this.#assertActive()
    this.#setRouteState(requireGatekeeperAppRouteState(value))
  }

  // The app calls this once to learn the current theme and register a receiver for later changes.
  // Apps that don't theme themselves never call it.
  subscribeTheme(receiver: RpcStub<GatekeeperAppThemeReceiver>): GatekeeperAppTheme {
    this.#assertActive()
    this.#themeReceiver?.[Symbol.dispose]?.()
    // The argument stub is disposed when this call returns, so keep our own dup (released in dispose).
    this.#themeReceiver = receiver.dup()
    return this.#theme
  }

  #dropThemeReceiver(receiver: RpcStub<GatekeeperAppThemeReceiver>) {
    if (this.#themeReceiver !== receiver) return
    receiver[Symbol.dispose]?.()
    this.#themeReceiver = null
  }

  // Push a new theme to a subscribed app; a no-op until (and unless) the app subscribes.
  [updateHostTheme](theme: GatekeeperAppTheme) {
    this.#theme = theme
    const receiver = this.#themeReceiver
    if (!receiver || !this.#active || this.#closed || !this.#authorityCurrent()) return

    try {
      Promise.resolve(receiver.setTheme(theme)).catch(() => this.#dropThemeReceiver(receiver))
    } catch {
      this.#dropThemeReceiver(receiver)
    }
  }

  // Queue a presentation change; the latest requested state is applied on the next frame.
  setPresenting(active: boolean): Promise<PresentAck> {
    this.#assertActive()
    return new Promise((resolve) => {
      this.#pendingActive = active
      this.#pendingResolvers.push(resolve)
      this.#frameId ??= requestAnimationFrame(() => this.#applyPending())
    })
  }

  // Apply the last-requested state once, resolving every caller queued this frame with the result.
  #applyPending() {
    if (!this.#active || this.#closed || !this.#authorityCurrent()) return
    this.#frameId = null
    const active = this.#pendingActive!
    const resolvers = this.#pendingResolvers
    this.#pendingActive = null
    this.#pendingResolvers = []
    // No-op toggles skip the layout apply.
    const ack: PresentAck =
      active === this.#presenting ? { rect: null, willResize: false } : this.#present(active)
    this.#presenting = active
    for (const resolve of resolvers) resolve(ack)
  }

  // Cancel the rate limiter's pending resume timer once this host is no longer in use.
  [disposeHost]() {
    this.#closed = true
    this[suspendHost]()
    this.#rootSlot.dispose()
    for (const slot of this.#slots.values()) slot.dispose()
    this.#slots.clear()
    this.#capabilities.clear()
    this.#themeReceiver?.[Symbol.dispose]?.()
    this.#themeReceiver = null
    if (this.#frameId !== null) {
      cancelAnimationFrame(this.#frameId)
      this.#frameId = null
    }
    for (const resolve of this.#pendingResolvers) resolve({ rect: null, willResize: false })
    this.#pendingResolvers = []
    this.#pendingActive = null
    this.#presenting = false
  }
}

/**
 * Hosts a gatekeeper's full-page management SPA in a sandboxed, network-isolated iframe. The app
 * talks to the gatekeeper only through the `ui` capability carried over the MessagePort RPC session.
 * The iframe fills its parent container.
 */
export default function SandboxedGatekeeperApp(props: Parameters<typeof GatekeeperAppDocument>[0]) {
  // Authority incompatibility resets immediately; deployment code updates require explicit consent.
  return <RetainedGatekeeperApp key={JSON.stringify([props.documentIdentity, props.gatekeeperVendorId, props.workItemHandoffs])} {...props} />
}

function RetainedGatekeeperApp(props: Parameters<typeof GatekeeperAppDocument>[0]) {
  const [html, setHtml] = useState(props.frame.iframeHtml)
  const changed = html !== props.frame.iframeHtml
  return <div className="flex h-full flex-col">
    {changed && <div role="status" className="shrink-0 px-4 py-2 text-sm">
      An app update is available. Your current view is preserved.{' '}
      <button type="button" className="underline" disabled={props.authorityAvailable === false}
        onClick={() => setHtml(props.frame.iframeHtml)}>Reload when ready</button>
    </div>}
    <div className="min-h-0 flex-1">
      <GatekeeperAppDocument key={html} {...props} frame={{ ...props.frame, iframeHtml: html }} />
    </div>
  </div>
}

function GatekeeperAppDocument({
  frame,
  gatekeeperVendorId,
  dependencies = EMPTY_DEPENDENCIES,
  routeState,
  setRouteState,
  codingSessionAvailable = false,
  workItemHandoffs = false,
  onRequestCodingSession,
  onRetryProviders,
  authorityAvailable = true,
  isAuthorityCurrent,
}: {
  frame: GatekeeperUiFrame,
  gatekeeperVendorId: string,
  dependencies?: GatekeeperAppDependency[],
  routeState?: string,
  setRouteState?: RouteStateSetter,
  codingSessionAvailable?: boolean,
  workItemHandoffs?: boolean,
  onRequestCodingSession?: RequestCodingSession,
  onRetryProviders?: () => void,
  documentIdentity?: string,
  authorityAvailable?: boolean,
  isAuthorityCurrent?: () => boolean,
}) {
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const sessionRef = useRef<{ [Symbol.dispose]?(): void } | null>(null)
  const hostRef = useRef<GatekeeperAppHostImpl | null>(null)
  const connectedRef = useRef(false)
  const invalidatedRef = useRef(false)
  const routeStateRef = useRef('')
  const setRouteStateRef = useRef<RouteStateSetter>(() => {})
  const codingSessionAvailableRef = useRef(false)
  const requestCodingSessionRef = useRef<RequestCodingSession>(() => {})
  const retryProvidersRef = useRef(onRetryProviders)
  const [overlay, setOverlay] = useState<OverlayState>(null)
  const overlayRef = useRef<OverlayState>(null)
  // Push the Workshop's resolved light/dark mode and deployment accent whenever either changes.
  const { resolvedThemeMode } = useTheme()
  const configuredAccentColor = useServerConfig()?.accentColor
  const accentColor = configuredAccentColor && isHexColor(configuredAccentColor)
    ? configuredAccentColor
    : null
  const themeRef = useRef<GatekeeperAppTheme>({ mode: resolvedThemeMode, accentColor })
  themeRef.current = { mode: resolvedThemeMode, accentColor }
  useEffect(() => {
    hostRef.current?.[updateHostTheme]({ mode: resolvedThemeMode, accentColor })
  }, [resolvedThemeMode, accentColor])

  const setOverlayPhase = useCallback((next: OverlayState) => {
    if (overlayRef.current === next) return
    overlayRef.current = next
    setOverlay(next)
  }, [])

  // Grow the iframe to full-viewport (or restore it), then report back the pane rect and whether the
  // size actually changed.
  const present = useCallback<PresentController>((active) => {
    const el = iframeRef.current
    const before = el?.getBoundingClientRect()
    // Duplicate restores are common during cleanup; avoid forcing layout when already restored.
    if (!active && overlayRef.current === null) return { rect: null, willResize: false }
    flushSync(() => setOverlayPhase(active ? 'full' : null))
    const after = el?.getBoundingClientRect()
    const willResize =
      !!before && !!after && (before.width !== after.width || before.height !== after.height)
    // On open, `before` is the pane rect the app pins to.
    const rect =
      active && before
        ? { left: before.left, top: before.top, width: before.width, height: before.height }
        : null
    return { rect, willResize }
  }, [setOverlayPhase])
  const openTarget = useCallback<OpenTarget>(({ workspaceId, gadgetId }) => {
    navigate({
      to: '/workspace/$id',
      params: { id: workspaceId },
      search: gadgetId === undefined ? {} : { w: gadgetId },
    })
  }, [navigate])
  const titlesRef = useRef<{ at: number, titles: Promise<Map<string, string>> } | null>(null)
  const resolveWorkspaceTitles = useCallback<ResolveWorkspaceTitles>(async (ids) => {
    let entry = titlesRef.current
    if (!entry || Date.now() - entry.at >= WORKSPACE_TITLES_TTL_MS) {
      entry = {
        at: Date.now(),
        titles: authenticatedApi.listGadgets()
          .then((gadgets) => new Map(gadgets.map((gadget) => [gadget.id, gadget.title]))),
      }
      titlesRef.current = entry
      // Don't cache a failure: drop it so the next lookup retries.
      const failed = entry
      entry.titles.catch(() => {
        if (titlesRef.current === failed) titlesRef.current = null
      })
    }
    const titles = await entry.titles
    return ids.map((id) => titles.get(id) ?? null)
  }, [authenticatedApi])
  const openPrompt = useCallback<OpenPrompt>((prompt) => {
    navigate({ to: '/', search: { prompt } })
  }, [navigate])
  // The gatekeeper capability is `any`: its method shape is gatekeeper-defined and opaque to us.
  const capabilityRef = useRef<any>(null)
  const liveRef = useRef({ dependencies, resolveWorkspaceTitles, openTarget, openPrompt, navigate, isAuthorityCurrent })
  const activeRef = useRef(false)
  const cleanupRef = useRef<(() => void) | null>(null)
  const apiRef = useRef(authenticatedApi)
  useInsertionEffect(() => () => {
    cleanupRef.current?.()
    cleanupRef.current = null
  }, [])

  useLayoutEffect(() => {
    capabilityRef.current = frame.ui
    retryProvidersRef.current = onRetryProviders
    routeStateRef.current = normalizeGatekeeperAppRouteState(routeState) ?? ''
    setRouteStateRef.current = setRouteState ?? (() => {})
    codingSessionAvailableRef.current = codingSessionAvailable
    requestCodingSessionRef.current = onRequestCodingSession ?? (() => {})
    liveRef.current = { dependencies, resolveWorkspaceTitles, openTarget, openPrompt, navigate, isAuthorityCurrent }
    if (apiRef.current !== authenticatedApi) {
      apiRef.current = authenticatedApi
      titlesRef.current = null
      hostRef.current?.[suspendHost]()
    }
    activeRef.current = authorityAvailable
    if (authorityAvailable) hostRef.current?.[refreshHost](frame.ui, dependencies)
    else hostRef.current?.[suspendHost]()
  })
  // Cosmetic callback/array churn must not cancel writes. Only hide/final teardown cleans up here;
  // refreshHost compares exact targets by account ID before replacing an individual slot.
  useLayoutEffect(() => () => {
      activeRef.current = false
      titlesRef.current = null
      hostRef.current?.[suspendHost]()
  }, [])

  useLayoutEffect(() => {
    if (cleanupRef.current) return
    connectedRef.current = false
    invalidatedRef.current = false
    const frameWindow = iframeRef.current?.contentWindow ?? null

    const connect = (port: MessagePort) => {
      if (connectedRef.current) {
        // A second handshake (e.g. iframe reloaded) invalidates the session.
        invalidatedRef.current = true
        port.close()
        sessionRef.current?.[Symbol.dispose]?.()
        sessionRef.current = null
        hostRef.current?.[disposeHost]()
        hostRef.current = null
        setOverlayPhase(null)
        return
      }
      if (invalidatedRef.current || !capabilityRef.current) {
        port.close()
        return
      }
      const host = new GatekeeperAppHostImpl(
        capabilityRef.current,
        present,
        themeRef.current,
        (target) => liveRef.current.openTarget(target),
        (prompt) => liveRef.current.openPrompt(prompt),
        () => codingSessionAvailableRef.current,
        workItemHandoffs,
        (target, title) => requestCodingSessionRef.current(target, title),
        (ids) => liveRef.current.resolveWorkspaceTitles(ids),
        () => routeStateRef.current,
        (value) => setRouteStateRef.current(value),
        liveRef.current.dependencies,
        () => retryProvidersRef.current?.(),
        () => { void liveRef.current.navigate({ to: '/gatekeepers' }) },
        () => activeRef.current && (liveRef.current.isAuthorityCurrent?.() ?? true),
      )
      if (!activeRef.current) host[suspendHost]()
      hostRef.current = host
      sessionRef.current = newMessagePortRpcSession(port, host)
      connectedRef.current = true
    }

    const handleMessage = (event: MessageEvent) => {
      // Only accept the handshake from the exact sandboxed iframe that owned this listener (which
      // posts from a null origin). Capturing the window here keeps an old listener from adopting a
      // newly-remounted iframe before its passive cleanup would otherwise run.
      if (!frameWindow || event.source !== frameWindow || event.origin !== 'null') return
      if (invalidatedRef.current) return
      if (forwardTrustedFrameError(
        event, frameWindow, { surface: 'gatekeeper-app', gatekeeperVendorId },
      )) return
      if (event.data?.type === 'handshake' && event.ports?.[0]) {
        connect(event.ports[0])
      }
    }

    window.addEventListener('message', handleMessage)
    cleanupRef.current = () => {
      window.removeEventListener('message', handleMessage)
      sessionRef.current?.[Symbol.dispose]?.()
      sessionRef.current = null
      hostRef.current?.[disposeHost]()
      hostRef.current = null
    }
    // The local session belongs to the document, not the backend transport or Activity visibility.
    // Its final-only cleanup must not call present()/flushSync or any React state setter.
  }, [gatekeeperVendorId, present, setOverlayPhase, workItemHandoffs])

  return (
    <iframe
      ref={iframeRef}
      srcDoc={frame.iframeHtml}
      // allow-scripts: run the app's JS. allow-modals: its beforeunload unsaved-changes guard. Not
      // allow-same-origin (the frame stays an opaque origin), and the app's CSP keeps connect-src 'none'.
      sandbox="allow-scripts allow-modals"
      allow="clipboard-write"
      title="Gatekeeper app"
      style={iframeStyleForOverlay(overlay)}
    />
  )
}
