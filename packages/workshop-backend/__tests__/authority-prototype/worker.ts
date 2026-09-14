import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";

/** Bindings owned only by the isolated real-workerd fixture. */
export type PrototypeEnv = {
  PROTOTYPE_AUTHORITY: DurableObjectNamespace<PrototypeAuthority>;
  PROTOTYPE_SERVICE: Service<PrototypeService>;
};

export class PrototypeAuthority extends DurableObject {
  set(active: boolean, generation: number, unavailable = false): void {
    this.ctx.storage.kv.put("state", {active, generation, unavailable});
  }

  assertCurrent(generation: number): void {
    const state = this.ctx.storage.kv.get<{active: boolean; generation: number; unavailable: boolean}>("state");
    this.ctx.storage.kv.put("checks", this.checks() + 1);
    if (!state || state.unavailable) throw new Error("PROTOTYPE_AUTHORITY_UNAVAILABLE");
    if (!state.active || state.generation !== generation) throw new Error("PROTOTYPE_ADMIN_REVOKED");
  }

  checks(): number { return this.ctx.storage.kv.get<number>("checks") ?? 0; }
  writes(): number { return this.ctx.storage.kv.get<number>("writes") ?? 0; }
  disposals(): number { return this.ctx.storage.kv.get<number>("disposals") ?? 0; }
  write(): number {
    const value = this.writes() + 1;
    this.ctx.storage.kv.put("writes", value);
    return value;
  }
  disposed(): void { this.ctx.storage.kv.put("disposals", this.disposals() + 1); }

  child(): NativeChild {
    const disposed = Promise.withResolvers<void>();
    // Keep the exporting IoContext alive until its real disposer runs. The deadline only
    // releases the hold; it never increments counters or satisfies cleanup assertions.
    this.ctx.waitUntil((async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([disposed.promise, new Promise<void>(resolve => {
          timer = setTimeout(resolve, 5000);
        })]);
      } finally { clearTimeout(timer); }
    })());
    return new NativeChild(this, () => { this.disposed(); disposed.resolve(); });
  }

  #flood = Promise.withResolvers<void>();
  startFlood(): void { this.#flood.resolve(); }
  flood(): ReadableStream<Uint8Array> {
    const ready = this.#flood.promise;
    return new ReadableStream({ async pull(controller) {
      await ready;
      controller.enqueue(new Uint8Array([1]));
    } });
  }

  #source?: ReadableStreamDefaultController<Uint8Array>;
  stream(): ReadableStream<Uint8Array> {
    return new ReadableStream({ start: controller => { this.#source = controller; } });
  }
  closeStream(): void {
    if (!this.#source) throw new Error("PROTOTYPE_NO_SOURCE");
    this.#source.close();
  }
  pushStream(): void {
    if (!this.#source) throw new Error("PROTOTYPE_NO_SOURCE");
    this.#source.enqueue(new Uint8Array([1]));
  }
}

class NativeChild extends RpcTarget {
  constructor(private counter: PrototypeAuthority, private dispose: () => void) { super(); }
  write(): number { return this.counter.write(); }
  get value(): number { return this.counter.writes(); }
  child(): NativeChild { return this.counter.child(); }
  echo(child: RpcStub<NativeChild>): RpcStub<NativeChild> { return child.dup(); }
  async callback(callback: RpcStub<(child: NativeChild) => void>): Promise<void> {
    await callback(this.child());
  }
  async deferred(callback: RpcStub<() => void>): Promise<NativeChild> {
    await callback();
    return this.child();
  }
  stream(): ReadableStream<Uint8Array> { return this.counter.stream(); }
  flood(): ReadableStream<Uint8Array> { return this.counter.flood(); }
  sink(): WritableStream<Uint8Array> {
    const counter = this.counter;
    return new WritableStream({ async write() { await counter.write(); } });
  }
  [Symbol.dispose](): void { this.dispose(); }
}

export class PrototypeService extends WorkerEntrypoint<PrototypeEnv> {
  child(key: string): Promise<RpcStub<NativeChild>> {
    return this.env.PROTOTYPE_AUTHORITY.getByName(key).child();
  }
  async nested(key: string): Promise<{ items: RpcStub<NativeChild>[] }> {
    return {items: [await this.child(key)]};
  }
  service(): Service<PrototypeService> { return this.env.PROTOTYPE_SERVICE; }
}
