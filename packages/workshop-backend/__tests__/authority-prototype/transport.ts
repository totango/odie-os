import { RpcSession, type RpcCompatible, type RpcStub, type RpcTransport } from "capnweb";

// TEST ONLY. A protocol message (including a whole map) is one admission unit.
// Limits include messages awaiting an authority response, not just queued messages.
const MAX_MESSAGES = 32;
const MAX_CODE_UNITS = 256 * 1024;
// Fixture deadline only; this does not select a production authority timeout policy.
const CHECK_TIMEOUT_MS = 5000;

type Pending = {
  message: string;
  resolve: () => void;
  reject: (error: Error) => void;
  settled: boolean;
};

/** Test-only transport, exported for direct send/receive lifetime accounting tests. */
export class CheckedTransport implements RpcTransport {
  peer!: CheckedTransport;
  #pending: Pending[] = [];
  #active?: Pending;
  #interrupt?: (error: Error) => void;
  #wake?: () => void;
  #error?: Error;
  #messages = 0;
  #codeUnits = 0;
  admitted = 0;
  peakMessages = 0;
  peakCodeUnits = 0;

  constructor(private assertCurrent: () => Promise<void>, private checkTimeoutMs = CHECK_TIMEOUT_MS) {}

  bookkeeping() {
    return {messages: this.#messages, codeUnits: this.#codeUnits,
      queued: this.#pending.length, active: this.#active !== undefined};
  }

  send(message: string): Promise<void> {
    return this.peer.#accept(message);
  }

  #accept(message: string): Promise<void> {
    if (this.#error) return Promise.reject(this.#error);
    if (this.#messages >= MAX_MESSAGES || this.#codeUnits + message.length > MAX_CODE_UNITS) {
      const error = new Error("PROTOTYPE_BACKPRESSURE_LIMIT");
      this.abort(error);
      return Promise.reject(error);
    }
    ++this.#messages;
    this.#codeUnits += message.length;
    this.peakMessages = Math.max(this.peakMessages, this.#messages);
    this.peakCodeUnits = Math.max(this.peakCodeUnits, this.#codeUnits);
    return new Promise<void>((resolve, reject) => {
      this.#pending.push({ message, resolve, reject, settled: false });
      this.#wake?.();
      this.#wake = undefined;
    });
  }

  #settle(pending: Pending, error?: Error): void {
    if (pending.settled) return;
    pending.settled = true;
    --this.#messages;
    this.#codeUnits -= pending.message.length;
    if (error) pending.reject(error);
    else pending.resolve();
  }

  async receive(): Promise<string> {
    while (!this.#pending.length) {
      if (this.#error) throw this.#error;
      await new Promise<void>(resolve => { this.#wake = resolve; });
    }
    const pending = this.#pending.shift()!;
    this.#active = pending;
    const interrupted = Promise.withResolvers<Error>();
    this.#interrupt = interrupted.resolve;
    const timer = setTimeout(() => this.abort(new Error("PROTOTYPE_AUTHORITY_DEADLINE")), this.checkTimeoutMs);
    try {
      // The race observes only this privately owned check, including late rejection after
      // abandonment. It cannot cancel native authority work or an already-admitted operation.
      const closed = await Promise.race([this.assertCurrent(), interrupted.promise]);
      if (this.#error) throw this.#error;
      if (closed) throw closed;
      ++this.admitted;
      this.#settle(pending);
      return pending.message;
    } catch (error) {
      const failure = this.#error ?? (error instanceof Error ? error : new Error("PROTOTYPE_AUTHORITY_UNAVAILABLE"));
      this.abort(failure);
      throw failure;
    } finally {
      clearTimeout(timer);
      this.#active = undefined;
      this.#interrupt = undefined;
    }
  }

  #close(error: Error): void {
    if (this.#error) return;
    this.#error = error;
    if (this.#active) this.#settle(this.#active, error);
    this.#active = undefined;
    for (const pending of this.#pending.splice(0)) this.#settle(pending, error);
    this.#interrupt?.(error);
    this.#interrupt = undefined;
    this.#wake?.();
    this.#wake = undefined;
  }

  abort(reason: unknown): void {
    const error = reason instanceof Error ? reason : new Error("PROTOTYPE_SESSION_CLOSED");
    this.#close(error);
    this.peer.#close(error);
  }
}

// Resolve polymorphic `this` on the concrete stub, rather than an unresolved conditional RpcStub<T>.
function duplicate<S extends RpcStub<unknown>>(stub: S): S { return stub.dup(); }

/** Test-only private string boundary; callers cannot replace the admission callback over RPC. */
export function checkedBoundary<T extends RpcCompatible<T>, U extends RpcCompatible<U> = undefined>(
    target: T, assertCurrent: () => Promise<void>, reverseTarget?: U, checkTimeoutMs = CHECK_TIMEOUT_MS) {
  const incoming = new CheckedTransport(assertCurrent, checkTimeoutMs);
  const outgoing = new CheckedTransport(assertCurrent, checkTimeoutMs);
  incoming.peer = outgoing;
  outgoing.peer = incoming;
  const server = new RpcSession<U>(incoming, target);
  const client = new RpcSession<T>(outgoing, reverseTarget);
  const serverMain = server.getRemoteMain();
  const clientMain = client.getRemoteMain();
  const serverBroken = Promise.withResolvers<void>();
  const clientBroken = Promise.withResolvers<void>();
  serverMain.onRpcBroken(() => serverBroken.resolve());
  clientMain.onRpcBroken(() => clientBroken.resolve());
  // Let both sessions ingest the transport's original reason before main disposal invokes
  // shutdown with its generic reason. Public broken notifications do not mean native drain.
  const closed = Promise.all([serverBroken.promise, clientBroken.promise]).then(() => {
    try { serverMain[Symbol.dispose](); }
    finally { clientMain[Symbol.dispose](); }
  });
  const stub: RpcStub<T> = duplicate(clientMain);
  const reverseStub: RpcStub<U> = duplicate(serverMain);
  return {
    // Ordinary aliases must not own session shutdown: descendants outlive parent disposal.
    stub,
    reverseStub,
    closed,
    incoming,
    outgoing,
    stats: () => ({server: server.getStats(), client: client.getStats()}),
    [Symbol.dispose]() { incoming.abort(new Error("PROTOTYPE_SESSION_CLOSED")); },
  };
}
