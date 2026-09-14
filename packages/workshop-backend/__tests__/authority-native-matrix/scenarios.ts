import type { MatrixEnv } from "./provider";

/** The fixed four scenarios, shared byte-for-byte between pool and standalone. */
export const scenarios = ["pipeTo", "explicit-pump", "cancel", "graceful"] as const;
type Scenario = typeof scenarios[number];
const failureMessage = "PROTOTYPE_NATIVE_PIPE_FAILURE";
const cancelMessage = "PROTOTYPE_NATIVE_CANCEL";
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function check(value: boolean, description: string): asserts value {
  if (!value) throw new Error(`MATRIX_ASSERTION: ${description}`);
}

/** Public observation only. Never suppresses events or attaches handlers from an event. */
function rejectionObserver() {
  const known = new WeakMap<Promise<unknown>, string>();
  const identities = new WeakMap<Promise<unknown>, number>();
  const unhandled: { reason: string; knownPromise: string | null; identity: number }[] = [];
  let nextId = 1;
  const listener = (event: PromiseRejectionEvent) => {
    let identity = identities.get(event.promise);
    if (identity === undefined) { identity = nextId++; identities.set(event.promise, identity); }
    unhandled.push({ reason: message(event.reason), knownPromise: known.get(event.promise) ?? null, identity });
  };
  addEventListener("unhandledrejection", listener);
  return {
    unhandled,
    track<T>(promise: Promise<T>, name: string) { known.set(promise, name); return promise; },
    dispose() { removeEventListener("unhandledrejection", listener); },
  };
}

/** Holds the caller context through assertions, real producer disposal and bounded cleanup. */
export async function runScenario(env: MatrixEnv, scenario: Scenario) {
  const observer = rejectionObserver();
  const key = crypto.randomUUID();
  const authority = env.MATRIX_AUTHORITY.getByName(key);
  const child = await env.MATRIX_SERVICE.child(key);
  const primary = new Error(failureMessage);
  const cleanup: { operation: string; status: string; reason?: string }[] = [];
  let chunks = 0;
  let callerError: string | null = null;
  let callerErrorIsOriginal = false;
  const started = Date.now();
  let assertionFailure: string | null = null;
  let cleanupFailure: string | null = null;
  let producerBeforeDisposal: Awaited<ReturnType<typeof authority.stats>> | null = null;
  let producer: Awaited<ReturnType<typeof authority.stats>> | null = null;
  let cleanupDeadline = Infinity;
  const boundedCleanup = async <T>(promise: Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("MATRIX_CLEANUP_DEADLINE")), Math.max(0, cleanupDeadline - Date.now()));
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const observe = <T>(promise: Promise<T>, name: string) => observer.track(promise, name).then(
    value => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  try {
    const source = await child.stream();
    if (scenario === "pipeTo" || scenario === "explicit-pump") {
      const consumed = Promise.withResolvers<void>();
      const sink = new WritableStream<Uint8Array>({ write() {
        if (++chunks === 2) throw primary;
        consumed.resolve();
      } });
      const explicitPump = async () => {
        const reader = source.getReader();
        const writer = sink.getWriter();
        const readerClosed = observe(reader.closed, "reader.closed");
        const writerClosed = observe(writer.closed, "writer.closed");
        try {
          while (true) {
            const next = await observer.track(reader.read(), "reader.read");
            if (next.done) { await observer.track(writer.close(), "writer.close"); break; }
            await observer.track(writer.write(next.value), "writer.write");
          }
        } catch (error) {
          const outcomes = await Promise.all([
            observe(reader.cancel(error), "reader.cancel"),
            observe(writer.abort(error), "writer.abort"),
          ]);
          for (const [index, outcome] of outcomes.entries()) {
            cleanup.push({ operation: index === 0 ? "reader.cancel" : "writer.abort", status: outcome.status,
              ...(outcome.status === "rejected" ? { reason: message(outcome.error) } : {}) });
          }
          throw error;
        } finally {
          for (const [index, outcome] of (await Promise.all([readerClosed, writerClosed])).entries()) {
            cleanup.push({ operation: index === 0 ? "reader.closed" : "writer.closed", status: outcome.status,
              ...(outcome.status === "rejected" ? { reason: message(outcome.error) } : {}) });
          }
          reader.releaseLock();
          writer.releaseLock();
        }
      };
      // Observe the actual public caller promise immediately, without replacing its rejection.
      const pumping = observe(scenario === "pipeTo" ? source.pipeTo(sink) : explicitPump(), "caller.pump");
      await authority.pushStream();
      await consumed.promise;
      cleanupDeadline = Date.now() + 5000;
      await authority.pushStream();
      const outcome = await boundedCleanup(pumping);
      check(outcome.status === "rejected", "destination failure must reject caller");
      callerError = message(outcome.error);
      callerErrorIsOriginal = outcome.error === primary;
      check(callerError === failureMessage && callerErrorIsOriginal, "original caller error identity");
      check(chunks === 2, "exactly two paced chunks");
    } else {
      const reader = source.getReader();
      const closed = observe(reader.closed, "reader.closed");
      await authority.pushStream();
      check(!(await observer.track(reader.read(), "reader.read")).done, "first native chunk");
      chunks++;
      cleanupDeadline = Date.now() + 5000;
      if (scenario === "cancel") {
        await observer.track(reader.cancel(new Error(cancelMessage)), "reader.cancel");
      } else {
        await authority.closeStream();
        check((await observer.track(reader.read(), "reader.read.end")).done === true, "native EOF");
      }
      check((await closed).status === "fulfilled", "reader.closed resolves");
      reader.releaseLock();
      if (scenario === "graceful") {
        const writer = (await child.sink()).getWriter();
        const sinkClosed = observe(writer.closed, "writer.closed");
        await observer.track(writer.write(new Uint8Array([1])), "writer.write");
        await observer.track(writer.close(), "writer.close");
        check((await sinkClosed).status === "fulfilled", "writer.closed resolves");
        writer.releaseLock();
        check((await authority.stats()).writes === 1, "native sink write");
      }
    }
  } catch (error) {
    // Preserve failed assertions in the report; both drivers fail explicitly on this field.
    assertionFailure = message(error);
  } finally {
    if (!Number.isFinite(cleanupDeadline)) cleanupDeadline = Date.now() + 5000;
    try {
      producerBeforeDisposal = await boundedCleanup(authority.stats());
    } catch (error) { cleanupFailure = message(error); }
    child[Symbol.dispose]();
    try {
      producer = await boundedCleanup(authority.stats());
      while (producer.disposals !== 1 && Date.now() < cleanupDeadline) {
        await delay(5);
        producer = await boundedCleanup(authority.stats());
      }
      check(producer.disposals === 1, "actual native child disposal, not timer");
      // Let runtime rejection reporting run with the caller context still alive.
      await boundedCleanup(delay(50));
      producer = await boundedCleanup(authority.stats());
    } catch (error) { cleanupFailure = message(error); }
    observer.dispose();
  }
  return { scenario, chunks, callerError, callerErrorIsOriginal, assertionFailure, cleanupFailure,
    cleanup, producerBeforeDisposal, producer, elapsedMs: Date.now() - started,
    cleanupRemainingMs: cleanupDeadline - Date.now(), unhandled: observer.unhandled };
}

/** Unmet cancellation propagation expectations remain visible, not silently changed to zero. */
export function cancellationMatches(result: Awaited<ReturnType<typeof runScenario>>): boolean {
  return result.producer?.cancellations === (result.scenario === "graceful" ? 0 : 1)
    && result.producer.cancelReason === (result.scenario === "graceful" ? null
      : result.scenario === "cancel" ? cancelMessage : failureMessage);
}
