// Relative import deliberately bypasses the browser-only capnweb alias. The
// implementation is unchanged; only actual session creation/termination is observed.
import { newMessagePortRpcSession as realSession, type RpcCompatible } from '../../node_modules/capnweb/dist/index.js'
export * from '../../node_modules/capnweb/dist/index.js'

type Entry = { id: number; owner: 'fixture' | 'component'; ended: 'disposed' | 'broken' | null }
const entries: Entry[] = []
let owner: Entry['owner'] = 'component'

/** Labels only sessions opened synchronously by the synthetic backend transport. */
export function fixtureSessions<T>(create: () => T): T {
  owner = 'fixture'
  try { return create() } finally { owner = 'component' }
}

/** Records real session roots; does not count guessed GC or override RPC behavior. */
export function newMessagePortRpcSession<T extends RpcCompatible<T> = undefined>(...args: Parameters<typeof realSession>) {
  const stub = realSession<T>(...args)
  const entry: Entry = { id: entries.length + 1, owner, ended: null }
  entries.push(entry)
  stub.onRpcBroken(() => { entry.ended ??= 'broken' })
  return new Proxy(stub, {
    get(target, property) {
      if (property === Symbol.dispose) return () => {
        entry.ended ??= 'disposed'
        target[Symbol.dispose]()
      }
      return Reflect.get(target, property, target)
    },
  })
}

// Read-only, value-only test diagnostics in the trusted fixture page, never in
// production or exposed to the sandbox. Sessions inside the iframe aren't counted.
Object.defineProperty(window, '__continuityLedger', {
  value: () => entries.map(entry => ({ ...entry })),
})
