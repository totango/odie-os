import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

/** Native-only diagnostic bindings, never production authority. */
export type MatrixEnv = {
  MATRIX_AUTHORITY: DurableObjectNamespace<MatrixAuthority>;
  MATRIX_SERVICE: Service<MatrixService>;
};

/** Matches the original native stream producer and exporting-context hold. */
export class MatrixAuthority extends DurableObject {
  #source?: ReadableStreamDefaultController<Uint8Array>;

  child(): MatrixChild {
    const disposed = Promise.withResolvers<void>();
    this.ctx.waitUntil((async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([disposed.promise, new Promise<void>(resolve => {
          timer = setTimeout(resolve, 5000);
        })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    })());
    return new MatrixChild(this, () => {
      this.ctx.storage.kv.put("disposals", this.stats().disposals + 1);
      disposed.resolve();
    });
  }

  stream(): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start: controller => { this.#source = controller; },
      // Observation only: cancellation has no rejected side effect or extra promise.
      cancel: reason => {
        this.ctx.storage.kv.put("cancellations", this.stats().cancellations + 1);
        this.ctx.storage.kv.put("cancelReason", reason instanceof Error ? reason.message : String(reason));
      },
    });
  }
  pushStream(): void {
    if (!this.#source) throw new Error("PROTOTYPE_NO_SOURCE");
    this.#source.enqueue(new Uint8Array([1]));
  }
  closeStream(): void {
    if (!this.#source) throw new Error("PROTOTYPE_NO_SOURCE");
    this.#source.close();
  }
  write(): number {
    const writes = this.stats().writes + 1;
    this.ctx.storage.kv.put("writes", writes);
    return writes;
  }
  stats() {
    return {
      cancellations: this.ctx.storage.kv.get<number>("cancellations") ?? 0,
      cancelReason: this.ctx.storage.kv.get<string>("cancelReason") ?? null,
      writes: this.ctx.storage.kv.get<number>("writes") ?? 0,
      disposals: this.ctx.storage.kv.get<number>("disposals") ?? 0,
    };
  }
}

class MatrixChild extends RpcTarget {
  constructor(private counter: MatrixAuthority, private dispose: () => void) { super(); }
  stream(): ReadableStream<Uint8Array> { return this.counter.stream(); }
  sink(): WritableStream<Uint8Array> {
    const counter = this.counter;
    return new WritableStream({ async write() { await counter.write(); } });
  }
  [Symbol.dispose](): void { this.dispose(); }
}

/** Retains Service -> DO -> native child -> native stream crossings. */
export class MatrixService extends WorkerEntrypoint<MatrixEnv> {
  child(key: string) { return this.env.MATRIX_AUTHORITY.getByName(key).child(); }
}
