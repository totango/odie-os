/** Maximum terminal write payload size used to avoid long parser tasks during replay. */
export const MAX_TERMINAL_WRITE_CHUNK_BYTES = 64 * 1024

type OrderedTerminalOperation = (done: () => void) => void

/**
 * Serializes callback-completing terminal operations in protocol order.
 *
 * xterm's `write` parses asynchronously and signals completion with a callback, so operations that
 * must occur between writes (such as `clear`) need an explicit FIFO instead of direct invocation.
 */
export class OrderedTerminalOperationQueue {
  private readonly operations: OrderedTerminalOperation[] = []
  private readonly idleWaiters: Array<() => void> = []
  private running = false
  private cancelled = false

  /** Enqueue an operation and start it immediately when the queue is idle. */
  enqueue(operation: OrderedTerminalOperation): void {
    if (this.cancelled) return
    this.operations.push(operation)
    this.runNext()
  }

  /** Prevent queued work from starting and ignore callbacks from already-started operations. */
  cancel(): void {
    this.cancelled = true
    this.operations.length = 0
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  /** Resolves after all operations currently ahead of the waiter have completed. */
  whenIdle(): Promise<void> {
    if (!this.running && this.operations.length === 0) return Promise.resolve()
    return new Promise((resolve) => { this.idleWaiters.push(resolve) })
  }

  private runNext(): void {
    if (this.cancelled) {
      for (const resolve of this.idleWaiters.splice(0)) resolve()
      return
    }
    if (this.running) return
    const operation = this.operations.shift()
    if (!operation) {
      this.resolveIdle()
      return
    }

    this.running = true
    let completed = false
    const done = () => {
      if (completed) return
      completed = true
      this.running = false
      this.runNext()
    }

    try {
      operation(done)
    } catch {
      done()
    }
  }

  private resolveIdle(): void {
    if (this.running || this.operations.length > 0) return
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }
}

/** Enqueue a binary terminal frame, slicing only large frames into bounded subarray views. */
export function enqueueTerminalWriteFrame(
  queue: OrderedTerminalOperationQueue,
  bytes: Uint8Array,
  write: (chunk: Uint8Array, done: () => void) => void,
): void {
  if (bytes.byteLength <= MAX_TERMINAL_WRITE_CHUNK_BYTES) {
    queue.enqueue((done) => { write(bytes, done) })
    return
  }

  for (let offset = 0; offset < bytes.byteLength; offset += MAX_TERMINAL_WRITE_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + MAX_TERMINAL_WRITE_CHUNK_BYTES)
    queue.enqueue((done) => { write(chunk, done) })
  }
}

/** Coalesces adjacent WebSocket frames while preserving ordering around control operations. */
export class TerminalWriteBatcher {
  private readonly chunks: Uint8Array[] = []
  private readonly committed: Array<() => void> = []
  private byteLength = 0
  private scheduled: number | undefined

  constructor(
    private readonly queue: OrderedTerminalOperationQueue,
    private readonly write: (chunk: Uint8Array, done: () => void) => void,
    private readonly schedule: (flush: () => void) => number,
    private readonly cancelScheduled: (handle: number) => void,
  ) {}

  /** Add output to the current browser-frame batch. */
  push(bytes: Uint8Array, committed?: () => void): void {
    this.chunks.push(bytes)
    if (committed) this.committed.push(committed)
    this.byteLength += bytes.byteLength
    if (this.byteLength >= MAX_TERMINAL_WRITE_CHUNK_BYTES) {
      this.flush()
    } else if (this.scheduled === undefined) {
      this.scheduled = this.schedule(() => {
        this.scheduled = undefined
        this.flush()
      })
    }
  }

  /** Enqueue pending output immediately, before a following protocol operation. */
  flush(): void {
    if (this.scheduled !== undefined) {
      this.cancelScheduled(this.scheduled)
      this.scheduled = undefined
    }
    if (this.chunks.length === 0) return

    let bytes = this.chunks[0]
    if (this.chunks.length > 1) {
      bytes = new Uint8Array(this.byteLength)
      let offset = 0
      for (const chunk of this.chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
    }
    this.chunks.length = 0
    this.byteLength = 0
    enqueueTerminalWriteFrame(this.queue, bytes, this.write)
    const committed = this.committed.splice(0)
    if (committed.length > 0) {
      this.queue.enqueue((done) => {
        for (const commit of committed) commit()
        done()
      })
    }
  }

  /** Discard output that has not yet been enqueued. */
  cancel(): void {
    if (this.scheduled !== undefined) this.cancelScheduled(this.scheduled)
    this.scheduled = undefined
    this.chunks.length = 0
    this.committed.length = 0
    this.byteLength = 0
  }
}
