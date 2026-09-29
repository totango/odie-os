import type { PendingNativeLoginFlow, WorkshopRuntime } from './WorkshopRuntime'

type FlowSnapshot = { epoch: number; flow: PendingNativeLoginFlow }

/** One owner for the app's pending-flow vault slot. Network awaits stay outside its lock;
 * vault reads/writes, claims, clears, and dispatch admission are serialized together. */
class NativeFlowStore {
  private epoch = 0
  private publishedEpoch = 0
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private runtime: WorkshopRuntime) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => {})
    return result
  }

  /** Starting another browser flow immediately revokes older work, even before its RPC returns. */
  begin(): number { return ++this.epoch }

  replace(epoch: number, flow: PendingNativeLoginFlow, assertAuthority: () => void = () => {}): Promise<boolean> {
    return this.serial(async () => {
      if (epoch !== this.epoch) return false
      assertAuthority()
      await this.runtime.writePendingNativeLoginFlow(flow)
      assertAuthority()
      if (epoch !== this.epoch) return false
      this.publishedEpoch = epoch
      return true
    })
  }

  read(): Promise<FlowSnapshot | null> {
    return this.serial(async () => {
      const epoch = this.epoch
      if (epoch !== this.publishedEpoch) return null
      const flow = await this.runtime.readPendingNativeLoginFlow()
      return flow && epoch === this.epoch && epoch === this.publishedEpoch ? { epoch, flow } : null
    })
  }

  private async current(snapshot: FlowSnapshot): Promise<boolean> {
    if (snapshot.epoch !== this.epoch) return false
    const flow = await this.runtime.readPendingNativeLoginFlow()
    return snapshot.epoch === this.epoch && flow?.flowHandle === snapshot.flow.flowHandle &&
      flow.verifier === snapshot.flow.verifier && flow.purpose === snapshot.flow.purpose
  }

  /** Claim the matching flow and start the RPC before releasing the lock. The RPC result is
   * boxed so a slow response cannot block creation of a new flow. Revalidate after vault awaits. */
  dispatch<T>(snapshot: FlowSnapshot, update: PendingNativeLoginFlow | undefined,
    assertAuthority: () => void, start: () => Promise<T>, claimAccount = false,
  ): Promise<{ result: Promise<T> } | null> {
    return this.serial(async () => {
      if (!await this.current(snapshot)) return null
      assertAuthority()
      if (claimAccount) {
        const latest = await this.runtime.readPendingNativeLoginFlow()
        if (snapshot.epoch !== this.epoch || latest?.activationAttempted) return null
        assertAuthority()
      }
      if (update) await this.runtime.writePendingNativeLoginFlow(update)
      if (snapshot.epoch !== this.epoch) return null
      try {
        assertAuthority()
      } catch (error) {
        // No RPC was invoked. Undo only our claim, while holding the slot lock, so fresh
        // authority can finish this flow. Never undo a claim after start() was invoked.
        if (claimAccount && update && await this.current(snapshot)) {
          const recoverable = { ...update }
          delete recoverable.activationAttempted
          await this.runtime.writePendingNativeLoginFlow(recoverable)
        }
        throw error
      }
      const result = start()
      // Attach immediately; the caller awaits it after this queue operation resolves.
      void result.catch(() => {})
      return { result }
    })
  }

  finish(snapshot: FlowSnapshot, assertAuthority: () => void, token?: string): Promise<boolean> {
    return this.serial(async () => {
      if (!await this.current(snapshot)) return false
      assertAuthority()
      if (token !== undefined) {
        await this.runtime.writeSessionSecret(token)
        if (snapshot.epoch !== this.epoch) return false
        assertAuthority()
      }
      await this.runtime.clearPendingNativeLoginFlow()
      return snapshot.epoch === this.epoch
    })
  }
}

const stores = new WeakMap<WorkshopRuntime, NativeFlowStore>()

/** All frontend producers and consumers of the pending native flow share this owner. */
export const nativeFlowStore = (runtime: WorkshopRuntime): NativeFlowStore => {
  let store = stores.get(runtime)
  if (!store) { store = new NativeFlowStore(runtime); stores.set(runtime, store) }
  return store
}
