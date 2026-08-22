import { describe, expect, it, vi } from 'vitest'
import {
  enqueueTerminalWriteFrame,
  MAX_TERMINAL_WRITE_CHUNK_BYTES,
  OrderedTerminalOperationQueue,
  TerminalWriteBatcher,
} from './orderedTerminalOperations'

function setupBatcher() {
  const queue = new OrderedTerminalOperationQueue()
  const writes: Uint8Array[] = []
  let scheduled: (() => void) | undefined
  const batcher = new TerminalWriteBatcher(
    queue,
    (chunk, done) => { writes.push(chunk); done() },
    (flush) => { scheduled = flush; return 1 },
    () => { scheduled = undefined },
  )
  return { batcher, writes, runScheduled: () => scheduled?.() }
}

describe('OrderedTerminalOperationQueue', () => {
  it('waits for a deferred write callback before running the next operation', () => {
    const queue = new OrderedTerminalOperationQueue()
    const events: string[] = []
    let finishWrite: (() => void) | undefined

    queue.enqueue((done) => {
      events.push('write:start')
      finishWrite = done
    })
    queue.enqueue((done) => {
      events.push('clear')
      done()
    })

    expect(events).toEqual(['write:start'])
    finishWrite?.()
    expect(events).toEqual(['write:start', 'clear'])
  })

  it('runs truncated clear after old writes and before later writes', () => {
    const queue = new OrderedTerminalOperationQueue()
    const events: string[] = []
    let finishOldWrite: (() => void) | undefined
    let finishLaterWrite: (() => void) | undefined

    queue.enqueue((done) => {
      events.push('old-write:start')
      finishOldWrite = done
    })
    queue.enqueue((done) => {
      events.push('clear')
      done()
    })
    queue.enqueue((done) => {
      events.push('later-write:start')
      finishLaterWrite = done
    })

    expect(events).toEqual(['old-write:start'])
    finishOldWrite?.()
    expect(events).toEqual(['old-write:start', 'clear', 'later-write:start'])
    finishLaterWrite?.()
  })

  it('cancels pending operations and ignores stale callbacks', () => {
    const queue = new OrderedTerminalOperationQueue()
    const events: string[] = []
    let finishWrite: (() => void) | undefined

    queue.enqueue((done) => {
      events.push('write:start')
      finishWrite = done
    })
    queue.enqueue((done) => {
      events.push('stale-side-effect')
      done()
    })

    queue.cancel()
    finishWrite?.()

    expect(events).toEqual(['write:start'])
  })

  it('waits for queued terminal parsing before reporting idle', async () => {
    const queue = new OrderedTerminalOperationQueue()
    let finishWrite: (() => void) | undefined
    let idle = false
    queue.enqueue((done) => { finishWrite = done })

    const waiting = queue.whenIdle().then(() => { idle = true })
    await Promise.resolve()
    expect(idle).toBe(false)

    finishWrite?.()
    await waiting
    expect(idle).toBe(true)
  })
})

describe('TerminalWriteBatcher', () => {
  it('coalesces adjacent small frames into one write', () => {
    const { batcher, writes, runScheduled } = setupBatcher()

    batcher.push(new Uint8Array([1, 2]))
    batcher.push(new Uint8Array([3, 4]))
    expect(writes).toEqual([])

    runScheduled()
    expect(writes.map((chunk) => [...chunk])).toEqual([[1, 2, 3, 4]])
  })

  it('flushes output before a following control operation', () => {
    const queue = new OrderedTerminalOperationQueue()
    const events: string[] = []
    const batcher = new TerminalWriteBatcher(
      queue,
      (_chunk, done) => { events.push('write'); done() },
      () => 1,
      () => {},
    )

    batcher.push(new Uint8Array([1]))
    batcher.flush()
    queue.enqueue((done) => { events.push('clear'); done() })

    expect(events).toEqual(['write', 'clear'])
  })

  it('discards an unflushed batch when cancelled', () => {
    const { batcher, writes, runScheduled } = setupBatcher()
    batcher.push(new Uint8Array([1]))

    batcher.cancel()
    runScheduled()

    expect(writes).toEqual([])
  })

  it('commits a replay cursor only after its terminal write completes', () => {
    const queue = new OrderedTerminalOperationQueue()
    const events: string[] = []
    let finishWrite: (() => void) | undefined
    const batcher = new TerminalWriteBatcher(
      queue,
      (_chunk, done) => { events.push('write'); finishWrite = done },
      () => 1,
      () => {},
    )

    batcher.push(new Uint8Array([1]), () => { events.push('cursor') })
    batcher.flush()

    expect(events).toEqual(['write'])
    finishWrite?.()
    expect(events).toEqual(['write', 'cursor'])
  })
})

describe('enqueueTerminalWriteFrame', () => {
  it('enqueues small frames as one immediate write when idle', () => {
    const queue = new OrderedTerminalOperationQueue()
    const bytes = new Uint8Array([1, 2, 3])
    const write = vi.fn<(chunk: Uint8Array, done: () => void) => void>((_chunk, done) => { done() })

    enqueueTerminalWriteFrame(queue, bytes, write)

    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0]?.[0]).toBe(bytes)
  })

  it('slices only large frames into bounded subarray writes', () => {
    const queue = new OrderedTerminalOperationQueue()
    const bytes = new Uint8Array(MAX_TERMINAL_WRITE_CHUNK_BYTES * 2 + 17)
    const write = vi.fn<(chunk: Uint8Array, done: () => void) => void>((_chunk, done) => { done() })

    enqueueTerminalWriteFrame(queue, bytes, write)

    expect(write).toHaveBeenCalledTimes(3)
    expect(write.mock.calls.map(([chunk]) => chunk.byteLength)).toEqual([
      MAX_TERMINAL_WRITE_CHUNK_BYTES,
      MAX_TERMINAL_WRITE_CHUNK_BYTES,
      17,
    ])
    for (const [chunk] of write.mock.calls) {
      expect(chunk.buffer).toBe(bytes.buffer)
    }
  })
})
