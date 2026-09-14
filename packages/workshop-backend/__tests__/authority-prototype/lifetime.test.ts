import { env } from "cloudflare:workers";
import { RpcSession, RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import { checkedBoundary, CheckedTransport } from "./transport";

const EMPTY = {messages: 0, codeUnits: 0, queued: 0, active: false};

function pair(check: () => Promise<void>, timeout = 5000) {
  const incoming = new CheckedTransport(check, timeout);
  const outgoing = new CheckedTransport(check, timeout);
  incoming.peer = outgoing;
  outgoing.peer = incoming;
  return {incoming, outgoing};
}

// Observe each caller immediately; a successful result remains a distinct test failure.
function outcome<T>(promise: PromiseLike<T>) {
  return Promise.resolve(promise).then(
    value => ({ok: true, value}),
    (error: unknown) => ({ok: false, error}),
  );
}

async function turn() { await new Promise<void>(resolve => setTimeout(resolve, 0)); }

function expectEmpty(boundary: ReturnType<typeof pair>) {
  expect(boundary.incoming.bookkeeping()).toEqual(EMPTY);
  expect(boundary.outgoing.bookkeeping()).toEqual(EMPTY);
}

describe("TEST ONLY: private authority lifetime", () => {
  it.each(["pending", "resolve", "reject"])("settles active/queued sends once on close, including late %s", async late => {
    const check = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const boundary = pair(() => { entered.resolve(); return check.promise; });
    const sends = [outcome(boundary.outgoing.send("active")), outcome(boundary.outgoing.send("queued"))];
    const received = outcome(boundary.incoming.receive());
    await entered.promise;
    expect(boundary.incoming.bookkeeping()).toEqual({messages: 2, codeUnits: 12, queued: 1, active: true});
    const reason = new Error("OWNED_CLOSE");
    boundary.incoming.abort(reason);
    boundary.outgoing.abort(new Error("MUST_NOT_REPLACE_REASON"));
    expect(await received).toEqual({ok: false, error: reason});
    expect(await Promise.all(sends)).toEqual([{ok: false, error: reason}, {ok: false, error: reason}]);
    expectEmpty(boundary);
    if (late === "resolve") check.resolve();
    if (late === "reject") check.reject(new Error("PRIVATELY_ABANDONED_CHECK"));
    await turn();
    expect(boundary.incoming.admitted).toBe(0);
    expect(await outcome(boundary.incoming.receive())).toEqual({ok: false, error: reason});
    expect(await outcome(boundary.outgoing.send("late"))).toEqual({ok: false, error: reason});
    expectEmpty(boundary);
  });

  it("expires a permanently pending check without explicit close and preserves the deadline reason", async () => {
    const boundary = pair(() => new Promise<void>(() => {}), 25);
    const sent = outcome(boundary.outgoing.send("never"));
    const queued = outcome(boundary.outgoing.send("queued"));
    const received = await outcome(boundary.incoming.receive());
    expect(received).toMatchObject({ok: false, error: {message: "PROTOTYPE_AUTHORITY_DEADLINE"}});
    expect(await sent).toEqual(received);
    expect(await queued).toEqual(received);
    expectEmpty(boundary);
    expect(boundary.incoming.admitted).toBe(0);
  });

  it("interrupts both directions simultaneously, including queued sends and idle receives", async () => {
    const entered = Promise.withResolvers<void>();
    let checks = 0;
    const boundary = pair(() => {
      if (++checks === 2) entered.resolve();
      return new Promise<void>(() => {});
    });
    const sends = [boundary.incoming, boundary.outgoing].flatMap(transport =>
      [outcome(transport.send("active")), outcome(transport.send("queued"))]);
    const receives = [outcome(boundary.incoming.receive()), outcome(boundary.outgoing.receive())];
    await entered.promise;
    const reason = new Error("BIDIRECTIONAL_CLOSE");
    boundary.outgoing.abort(reason);
    for (const result of await Promise.all([...sends, ...receives])) expect(result).toEqual({ok: false, error: reason});
    expectEmpty(boundary);
    expect(checks).toBe(2);
    const idle = pair(async () => {});
    const waiting = outcome(idle.incoming.receive());
    idle.outgoing.abort(reason);
    expect(await waiting).toEqual({ok: false, error: reason});
    expectEmpty(idle);
  });

  it.each(["messages", "codeUnits"])("retains the original %s limit with an active stalled check", async limit => {
    const entered = Promise.withResolvers<void>();
    const boundary = pair(() => { entered.resolve(); return new Promise<void>(() => {}); });
    const sends = [outcome(boundary.outgoing.send(limit === "messages" ? "x" : "x".repeat(256 * 1024)))];
    const received = outcome(boundary.incoming.receive());
    await entered.promise;
    if (limit === "messages") for (let i = 1; i < 32; ++i) sends.push(outcome(boundary.outgoing.send("x")));
    sends.push(outcome(boundary.outgoing.send("overflow")));
    for (const result of await Promise.all([...sends, received])) {
      expect(result).toMatchObject({ok: false, error: {message: "PROTOTYPE_BACKPRESSURE_LIMIT"}});
    }
    expect(boundary.incoming.peakMessages).toBeLessThanOrEqual(32);
    expect(boundary.incoming.peakCodeUnits).toBeLessThanOrEqual(256 * 1024);
    expectEmpty(boundary);
  });

  it("owns both private mains while ordinary main/parent aliases leave live native descendants usable", async () => {
    // Observe only public main acquisition/disposal, never a protocol or private session hook.
    const original = RpcSession.prototype.getRemoteMain;
    const mainDisposals: number[] = [];
    const spy = vi.spyOn(RpcSession.prototype, "getRemoteMain").mockImplementation(function (this: RpcSession) {
      const main = original.call(this);
      const index = mainDisposals.push(0) - 1;
      return new Proxy(main, {get(target, property, receiver) {
        if (property === Symbol.dispose) return () => { ++mainDisposals[index]; target[Symbol.dispose](); };
        return Reflect.get(target, property, receiver);
      }});
    });
    try {
      const key = crypto.randomUUID();
      const authority = env.PROTOTYPE_AUTHORITY.getByName(key);
      using boundary = checkedBoundary(env.PROTOTYPE_SERVICE, async () => {}, env.PROTOTYPE_SERVICE);
      const parent = await boundary.stub.child(key);
      using child = await parent.child();
      const reverseParent = await boundary.reverseStub.child(key);
      using reverseChild = await reverseParent.child();
      boundary.stub[Symbol.dispose]();
      boundary.reverseStub[Symbol.dispose]();
      parent[Symbol.dispose]();
      reverseParent[Symbol.dispose]();
      await expect.poll(() => authority.disposals()).toBe(2);
      expect(mainDisposals).toEqual([0, 0]);
      expect(await child.write()).toBe(1);
      expect(await reverseChild.write()).toBe(2);
      const duplicate = child.dup();
      boundary[Symbol.dispose]();
      boundary[Symbol.dispose]();
      boundary.outgoing.abort(new Error("MUST_NOT_REPLACE_REASON"));
      await boundary.closed;
      expect(mainDisposals).toEqual([1, 1]);
      await expect.poll(() => authority.disposals()).toBe(4);
      expect(await outcome(child.write())).toMatchObject({ok: false, error: {message: "PROTOTYPE_SESSION_CLOSED"}});
      expect(await outcome(reverseChild.write())).toMatchObject({ok: false, error: {message: "PROTOTYPE_SESSION_CLOSED"}});
      duplicate[Symbol.dispose]();
      duplicate[Symbol.dispose]();
      child[Symbol.dispose]();
      reverseChild[Symbol.dispose]();
      await turn();
      expect(await authority.disposals()).toBe(4);
      expect(await authority.writes()).toBe(2);
      expect(mainDisposals).toEqual([1, 1]);
      expectEmpty(boundary);
    } finally { spy.mockRestore(); }
  });

  it.each(["close-resolve", "close-reject", "deadline"])("settles native writes in both directions with no late dispatch: %s", async mode => {
    const key = crypto.randomUUID();
    const authority = env.PROTOTYPE_AUTHORITY.getByName(key);
    const check = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let stall = false;
    let stalled = 0;
    using boundary = checkedBoundary(env.PROTOTYPE_SERVICE, () => {
      if (!stall) return Promise.resolve();
      if (++stalled === 2) entered.resolve();
      return check.promise;
    }, env.PROTOTYPE_SERVICE, mode === "deadline" ? 100 : 5000);
    using child = await boundary.stub.child(key);
    using reverseChild = await boundary.reverseStub.child(key);
    stall = true;
    const results = [outcome(child.write()), outcome(reverseChild.write())];
    await entered.promise;
    if (mode !== "deadline") boundary[Symbol.dispose]();
    const message = mode === "deadline" ? "PROTOTYPE_AUTHORITY_DEADLINE" : "PROTOTYPE_SESSION_CLOSED";
    for (const result of await Promise.all(results)) expect(result).toMatchObject({ok: false, error: {message}});
    await boundary.closed;
    await expect.poll(() => authority.disposals()).toBe(2);
    expectEmpty(boundary);
    const admitted = [boundary.incoming.admitted, boundary.outgoing.admitted];
    if (mode === "close-resolve") check.resolve();
    if (mode === "close-reject") check.reject(new Error("LATE_NATIVE_AUTHORITY_REJECTION"));
    await turn();
    expect(await authority.writes()).toBe(0);
    expect(await authority.disposals()).toBe(2);
    expect([boundary.incoming.admitted, boundary.outgoing.admitted]).toEqual(admitted);
    expect(await outcome(child.write())).toMatchObject({ok: false, error: {message}});
    expectEmpty(boundary);
  });

  it.each(["resolve", "reject"])("never delivers callback bytes after closing its pending reverse check: late %s", async late => {
    const check = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let stall = false;
    let blockCallback = false;
    let delivered = 0;
    class CallbackProvider extends RpcTarget {
      invoke(callback: RpcStub<(bytes: Uint8Array) => void>) {
        if (blockCallback) stall = true;
        return callback(new Uint8Array([7, 8]));
      }
    }
    using boundary = checkedBoundary(new CallbackProvider(), () => {
      if (!stall) return Promise.resolve();
      entered.resolve();
      return check.promise;
    });
    using callback = new RpcStub((bytes: Uint8Array) => { delivered += bytes.byteLength; });
    expect(await boundary.stub.invoke(callback)).toBeUndefined();
    expect(delivered).toBe(2);
    const admitted = boundary.incoming.admitted;
    // The provider switches to a pending check only after its invocation was admitted.
    blockCallback = true;
    const result = outcome(boundary.stub.invoke(callback));
    await entered.promise;
    await expect.poll(() => boundary.outgoing.bookkeeping().active).toBe(true);
    boundary[Symbol.dispose]();
    expect(await result).toMatchObject({ok: false, error: {message: "PROTOTYPE_SESSION_CLOSED"}});
    await boundary.closed;
    if (late === "resolve") check.resolve();
    else check.reject(new Error("LATE_CALLBACK_AUTHORITY_REJECTION"));
    await turn();
    expect(delivered).toBe(2);
    expect(boundary.incoming.admitted).toBeGreaterThan(admitted);
    expectEmpty(boundary);
  });
});
