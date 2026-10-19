import { newMessagePortRpcSession, RpcTarget } from 'capnweb'
import { validateGadgetAiRequest, type GadgetAiRequest } from '@gadgets/workshop-shared/api'

/** A confirmation shown by the trusted host, never by Gadget-authored code. */
export type GadgetAiConfirmation = { request: GadgetAiRequest; running: boolean }

/** Keeps interactive AI authority outside the Gadget's persistent server and bindings. */
export class GadgetAiBridge {
  private session: ReturnType<typeof newMessagePortRpcSession> | null = null
  private execute: ((request: GadgetAiRequest) => Promise<string>) | null = null
  private pending: {
    request: GadgetAiRequest
    running: boolean
    resolve: (value: string) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  } | null = null

  constructor(private notify: (confirmation: GadgetAiConfirmation | null) => void) {}

  resume(execute: (request: GadgetAiRequest) => Promise<string>) {
    this.execute = execute
    this.notify(null)
  }

  /** Revoke immediately without React updates, including during document teardown. */
  suspend() {
    this.execute = null
    this.cancel(false)
  }

  handshake(port: MessagePort) {
    if (this.session) return port.close()
    const request = (input: unknown) => this.request(input)
    this.session = newMessagePortRpcSession(port, new class extends RpcTarget {
      run(input: unknown): Promise<string> { return request(input) }
    }())
  }

  private request(input: unknown): Promise<string> {
    if (!this.execute) throw new Error('Gadget AI is only available in an active view.')
    if (this.pending) throw new Error('An AI request is already pending.')
    const request = Object.freeze(validateGadgetAiRequest(input))
    return new Promise((resolve, reject) => {
      this.pending = { request, running: false, resolve, reject,
        timeout: setTimeout(() => this.cancel(), 60_000) }
      this.notify({ request, running: false })
    })
  }

  /** Called only by the host's confirmation button; an iframe RPC cannot approve itself. */
  approve() {
    const pending = this.pending
    const execute = this.execute
    if (!pending || pending.running || !execute) return
    pending.running = true
    clearTimeout(pending.timeout)
    this.notify({ request: pending.request, running: true })
    void Promise.resolve().then(() => {
      if (this.pending !== pending || this.execute !== execute) throw new Error('AI request cancelled.')
      return execute(pending.request)
    }).then(pending.resolve, pending.reject).finally(() => {
      if (this.pending === pending) {
        this.pending = null
        this.notify(null)
      }
    })
  }

  cancel(notify = true) {
    if (this.pending) {
      clearTimeout(this.pending.timeout)
      this.pending.reject(new Error('AI request cancelled.'))
      this.pending = null
    }
    if (notify) this.notify(null)
  }

  dispose() {
    this.suspend()
    this.session?.[Symbol.dispose]()
    this.session = null
  }
}
