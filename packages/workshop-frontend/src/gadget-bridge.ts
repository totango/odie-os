import { RpcTarget, newMessagePortRpcSession } from 'capnweb'

// Gadget APIs are user-defined; their method vocabulary is intentionally dynamic.
type Capability = any

/** Owns one document's local bridge independently of its replaceable backend connection. */
export class GadgetBridge {
  source: Window | null = null
  documentId = ''
  active = false
  private generation = 0
  private target: Capability = null
  private backend: Capability = null
  private backendSession: Capability = null
  private session: Capability = null
  private acquire: (() => Promise<Capability>) | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private timeout: ReturnType<typeof setTimeout> | undefined
  private attempts = 0
  private bootstrap: {
    promise: Promise<void>
    resolve: () => void
    reject: (error: Error) => void
    generation: number | null
  } | null = null

  constructor(private status: (message: string | null) => void) {}

  private rejectBootstrap() {
    this.bootstrap?.reject(new Error('Gadget server unavailable; call was not dispatched.'))
    this.bootstrap = null
  }

  private release() {
    const target = this.target
    this.target = null
    target?.[Symbol.dispose]()
    this.backendSession?.[Symbol.dispose]()
    this.backendSession = null
  }

  private releaseCapability() {
    const backend = this.backend
    this.backend = null
    backend?.[Symbol.dispose]()
  }

  /** Synchronous security fence; no React updates and no deferred calls to replay. */
  suspend() {
    this.active = false
    ++this.generation
    this.rejectBootstrap()
    clearTimeout(this.timer)
    clearTimeout(this.timeout)
    this.release()
  }

  releaseBackend() {
    this.acquire = null
    this.release()
    this.releaseCapability()
  }

  resume(acquire: () => Promise<Capability>) {
    this.active = true
    this.acquire = acquire
    this.attempts = 0
    if (this.session) this.retry()
  }

  retry = () => {
    if (!this.active || !this.acquire || !this.session) return
    clearTimeout(this.timer)
    clearTimeout(this.timeout)
    const generation = ++this.generation
    // Only the first acquisition may hold bootstrap calls. A manual retry also cancels them.
    if (this.bootstrap?.generation !== null) this.rejectBootstrap()
    if (this.bootstrap) this.bootstrap.generation = generation
    this.release()
    this.releaseCapability()
    const current = () => this.active && generation === this.generation
    this.status('Connecting to gadget server…')
    const failed = () => {
      if (!current()) return
      ++this.generation
      this.rejectBootstrap()
      clearTimeout(this.timeout)
      this.release()
      this.releaseCapability()
      this.status('Gadget server unavailable. Your view is preserved.')
      // Bounded automatic retries, independent of the parent stub's identity.
      if (this.attempts < 5) {
        this.timer = setTimeout(this.retry, Math.min(500 * 2 ** this.attempts++, 8_000))
      }
    }
    this.timeout = setTimeout(failed, 20_000)
    const acquire = this.acquire
    Promise.resolve().then(() => current() ? acquire() : null).then(target => {
      if (!target) return
      if (!current()) {
        target[Symbol.dispose]()
        return
      }
      clearTimeout(this.timeout)
      this.backend = target
      // A generation-scoped RPC membrane revokes *all* derived capabilities and callbacks,
      // not just the top-level gadget stub. Closing it also disposes late RPC results using
      // Cap'n Web's ownership rules, without inventing a parallel recursive serializer.
      const { port1, port2 } = new MessageChannel()
      this.backendSession = newMessagePortRpcSession(port1, target)
      this.target = newMessagePortRpcSession(port2)
      target.onRpcBroken?.(failed)
      if (current()) {
        this.bootstrap?.resolve()
        this.bootstrap = null
        this.status(null)
      }
    }).catch(failed)
  }

  handshake(port: MessagePort) {
    // One bootstrap per document. A duplicate must not replace a working session.
    if (this.session) {
      port.close()
      return
    }
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    void promise.catch(() => {})
    this.bootstrap = { promise, resolve, reject, generation: null }
    const forwardingTarget = new Proxy(new RpcTarget(), {
      get: (target, property, receiver) => {
        // The exported target is not a thenable (including during Cap'n Web resolution).
        if (property === 'then') return undefined
        if (typeof property === 'symbol' || property in target) {
          return Reflect.get(target, property, receiver)
        }
        // Lookup is not authority: check again when the method is actually invoked.
        return (...args: Capability[]) => {
          const generation = this.generation
          const dispatch = () => {
            if (!this.active || generation !== this.generation || !this.target) {
              throw new Error('Gadget server unavailable; call was not dispatched.')
            }
            return this.target[property](...args)
          }
          // Normal boot code immediately calls gadget.read(). Hold only this first authorized
          // acquisition, bounded by its timeout. Returning the promise keeps incoming callback
          // args owned by Cap'n Web until dispatch or rejection; never duplicate them into a queue.
          // Suspension/failure cancels the wait permanently. Reconnect calls always fail fast.
          if (this.active && !this.target && this.bootstrap) {
            return this.bootstrap.promise.then(dispatch)
          }
          return dispatch()
        }
      },
    })
    this.session = newMessagePortRpcSession(port, forwardingTarget)
    if (this.active) this.retry()
  }

  /** Final/document teardown only. Safe inside insertion cleanup: never sets state. */
  dispose() {
    this.suspend()
    this.releaseBackend()
    this.session?.[Symbol.dispose]()
    this.session = null
    this.source = null
    this.documentId = ''
  }
}
