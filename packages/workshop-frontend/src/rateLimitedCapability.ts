import { RpcTarget, newMessagePortRpcSession } from 'capnweb'

// Shared, rate-limited proxy around an arbitrary gatekeeper-defined capability exposed to a
// sandboxed iframe (the resource configurator and full-page gatekeeper apps both use it). The
// iframe is untrusted (gatekeeper-authored HTML running in a sandbox), so we cap concurrency, rate,
// and backlog to keep a misbehaving app from hammering the backend. The capability's method shape is
// gatekeeper-defined and opaque to Workshop, so we treat it as `any` and let Cap'n Web carry calls.

export type RateLimitOptions = {
  maxConcurrency: number
  maxCallsPerMinute: number
  maxPendingCalls: number
  /**
   * What to do when the per-minute window is full. `throttle` pauses and resumes once the window has
   * room (used by long-lived apps); `reject` fails the call immediately (used by the short-lived
   * configurator form, where a flood is always a bug).
   */
  onRateLimit: 'throttle' | 'reject'
  /** Human-readable noun for error messages, e.g. "Gatekeeper app" or "Resource configurator". */
  label: string
  /** Checked on entry and immediately before dispatch, never just when the slot is obtained. */
  assertAuthority?: () => void
}

/**
 * A stable slot with a terminal close and an epoch fence. Suspension rejects pending work, while
 * replacement preserves the rate window and concurrency budget of the document.
 */
export function createRateLimitedCapability(
  capability: any,
  options: RateLimitOptions,
): { capability: any; dispose: () => void; suspend: () => void; replace: (target: any) => void } {
  type QueuedCall = {
    method: string
    args: unknown[]
    resolve: (value: unknown) => void
    reject: (reason?: unknown) => void
  }

  const startedCalls: number[] = []
  const queue: QueuedCall[] = []
  // Only the current generation consumes concurrency. Closing a generation rejects its calls
  // even if the remote work never settles; late completions cannot decrement a new generation.
  const outstanding = new Set<QueuedCall>()
  let resumeTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let suspended = false
  let epoch = 0
  let membrane: { target: any; dispose(): void } | null = null
  const unavailable = () => new Error(`${options.label} is no longer available.`)
  const suspend = () => {
    suspended = true
    epoch++
    capability = null
    membrane?.dispose()
    membrane = null
    if (resumeTimer !== null) clearTimeout(resumeTimer)
    resumeTimer = null
    for (const call of queue.splice(0)) call.reject(unavailable())
    for (const call of outstanding) call.reject(unavailable())
    outstanding.clear()
  }

  const connect = (backend: any) => {
    const generation = epoch
    // Both directions cross this per-slot, per-generation local RPC session. Closing it revokes
    // escaped child stubs AND callbacks using Cap'n Web's own recursive ownership semantics.
    const forwarding = new Proxy(new RpcTarget(), {
      get(target, property, receiver) {
        if (typeof property !== 'string' || property in target) return Reflect.get(target, property, receiver)
        if (property === 'then') return undefined
        return (...args: unknown[]) => {
          if (closed || suspended || epoch !== generation) throw unavailable()
          options.assertAuthority?.()
          if (typeof backend?.[property] !== 'function') throw new Error(`${options.label} method is not available: ${property}`)
          return backend[property](...args)
        }
      },
    })
    const { port1, port2 } = new MessageChannel()
    const server = newMessagePortRpcSession(port1, forwarding)
    const client = newMessagePortRpcSession(port2)
    membrane = { target: client, dispose() { client[Symbol.dispose](); server[Symbol.dispose](); backend = null } }
  }

  const pruneCallWindow = () => {
    const cutoff = Date.now() - 60_000
    while (startedCalls.length > 0 && startedCalls[0] < cutoff) startedCalls.shift()
  }

  const drain = () => {
    if (closed || suspended) return
    pruneCallWindow()
    while (outstanding.size < options.maxConcurrency && queue.length > 0) {
      if (startedCalls.length >= options.maxCallsPerMinute) {
        if (options.onRateLimit === 'reject') {
          queue.shift()?.reject(new Error(`${options.label} made too many requests.`))
          continue
        }
        // Throttle: pause and resume once the oldest call ages out of the window (a completion may
        // resume sooner). The backlog stays bounded by maxPendingCalls below.
        if (resumeTimer === null) {
          const waitMs = startedCalls[0] + 60_000 - Date.now()
          resumeTimer = setTimeout(() => { resumeTimer = null; drain() }, Math.max(waitMs, 0) + 1)
        }
        break
      }
      const call = queue.shift()!
      if (typeof capability?.[call.method] !== 'function') {
        call.reject(new Error(`${options.label} method is not available: ${call.method}`))
        continue
      }
      startedCalls.push(Date.now())
      outstanding.add(call)
      const callEpoch = epoch
      if (!membrane) connect(capability)
      const target = membrane!.target
      Promise.resolve()
        .then(() => {
          if (closed || suspended || epoch !== callEpoch) throw unavailable()
          options.assertAuthority?.()
          return target[call.method](...call.args)
        })
        .then((result) => {
          if (closed || suspended || epoch !== callEpoch) {
            try { result?.[Symbol.dispose]?.() } finally { call.reject(unavailable()) }
          } else call.resolve(result)
        }, call.reject)
        .finally(() => {
          if (outstanding.delete(call) && !closed && !suspended && epoch === callEpoch) drain()
        })
        .catch(call.reject)
    }
  }

  const proxy = new Proxy(new (class extends RpcTarget {})(), {
    get(_target, property) {
      if (property === 'then') return undefined
      if (property === Symbol.dispose) return undefined
      if (typeof property !== 'string') return undefined
      return (...args: unknown[]) => new Promise((resolve, reject) => {
        options.assertAuthority?.()
        if (closed || suspended) { reject(unavailable()); return }
        if (queue.length + outstanding.size >= options.maxPendingCalls) {
          reject(new Error(`${options.label} has too many pending requests.`))
          return
        }
        queue.push({ method: property, args, resolve, reject })
        drain()
      })
    },
  })

  return {
    capability: proxy,
    suspend,
    replace: (target) => {
      if (closed) throw unavailable()
      suspend()
      capability = target
      suspended = false
    },
    dispose: () => {
      closed = true
      suspend()
    },
  }
}
