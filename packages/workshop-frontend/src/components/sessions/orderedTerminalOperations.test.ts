import { describe, expect, it, vi } from 'vitest'
import {
  enqueueTerminalWriteFrame,
  MAX_TERMINAL_WRITE_CHUNK_BYTES,
  OrderedTerminalOperationQueue,
} from './orderedTerminalOperations'

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
