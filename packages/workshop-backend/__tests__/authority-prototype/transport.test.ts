import { env } from "cloudflare:workers";
import {
  newHttpBatchRpcResponse, newHttpBatchRpcSession, newWebSocketRpcSession, RpcStub, RpcTarget,
} from "capnweb";
import { describe, expect, it, vi } from "vitest";
import { checkedBoundary } from "./transport";

async function setup() {
  const key = crypto.randomUUID();
  const authority = env.PROTOTYPE_AUTHORITY.getByName(key);
  await authority.set(true, 1);
  const boundary = checkedBoundary(env.PROTOTYPE_SERVICE, () => authority.assertCurrent(1));
  return {key, authority, boundary};
}

async function denied(value: PromiseLike<unknown>) {
  await expect(Promise.resolve(value)).rejects.toThrow("PROTOTYPE_ADMIN_REVOKED");
}

describe("TEST ONLY: checked serialized authority boundary", () => {
  it("native pass-back control: direct native dup retains a valid argument", async () => {
    const key = crypto.randomUUID();
    using parent = await env.PROTOTYPE_SERVICE.child(key);
    using child = await parent.child();
    using echoed = await parent.echo(child);
    expect(await echoed.write()).toBe(1);
  });

  it("native pass-back control: serialized boundary preserves the same dup API", async () => {
    const {key, boundary: connection} = await setup();
    using boundary = connection;
    using parent = await boundary.stub.child(key);
    using child = await parent.child();
    using echoed = await parent.echo(child);
    expect(await echoed.write()).toBe(1);
  });

  it("contains retained native/service grandchildren, nested payloads, pass-back and parent disposal", async () => {
    const {key, authority, boundary: connection} = await setup();
    using boundary = connection;
    using service = await boundary.stub.service();
    const parent = await service.child(key);
    using child = await parent.child();
    using roundTrip = await parent.echo(child);
    using nested = await service.nested(key);
    parent[Symbol.dispose]();
    expect(await child.write()).toBe(1);
    expect(await roundTrip.write()).toBe(2);
    expect(await nested.items[0].write()).toBe(3);
    await authority.set(false, 2);
    await denied(child.write());
    await denied(roundTrip.write());
    await denied(nested.items[0].write());
    await denied(service.child(key).write());
    expect(await authority.writes()).toBe(3);
  });

  it("fences generations and outages without affecting independently entitled sessions", async () => {
    const a = await setup();
    const b = await setup();
    using first = a.boundary;
    using second = b.boundary;
    using child = await first.stub.child(a.key);
    await a.authority.set(false, 2);
    await a.authority.set(true, 3);
    await denied(child.write());
    using fresh = checkedBoundary(env.PROTOTYPE_SERVICE, () => a.authority.assertCurrent(3));
    expect(await fresh.stub.child(a.key).write()).toBe(1);
    expect(await second.stub.child(b.key).write()).toBe(1);
    await a.authority.set(true, 3, true);
    await expect(Promise.resolve(fresh.stub.child(a.key).write()))
      .rejects.toThrow("PROTOTYPE_AUTHORITY_UNAVAILABLE");
    expect(await a.authority.writes()).toBe(1);
  });

  it("contains callback-exported children and rejects newly delivered callback messages", async () => {
    const {key, authority, boundary: connection} = await setup();
    using boundary = connection;
    using child = await boundary.stub.child(key);
    type Child = Awaited<ReturnType<typeof child.child>>;
    let retained: Child | undefined;
    using callback = new RpcStub((value: Child) => { retained = value.dup(); });
    await child.callback(callback);
    if (!retained) throw new Error("callback did not deliver child");
    using callbackChild = retained;
    expect(await callbackChild.write()).toBe(1);
    await authority.set(false, 2);
    await denied(callbackChild.write());
    expect(await authority.writes()).toBe(1);
  });

  it("admits an entire map message and denies a subsequent message", async () => {
    const {key, authority, boundary: connection} = await setup();
    using boundary = connection;
    const start = performance.now();
    using nested = boundary.stub.nested(key);
    expect(await nested.items.map(item => item.write())).toEqual([1]);
    expect(await authority.checks()).toBeGreaterThan(0);
    expect(boundary.incoming.peakMessages).toBeLessThanOrEqual(32);
    expect(boundary.outgoing.peakCodeUnits).toBeLessThanOrEqual(256 * 1024);
    expect(performance.now() - start).toBeLessThan(15_000);
    await authority.set(false, 2);
    await denied(boundary.stub.child(key).child().write());
  });

  it("rejects delivery of a pre-admitted deferred response after revocation", async () => {
    const {key, authority, boundary: connection} = await setup();
    using boundary = connection;
    using child = await boundary.stub.child(key);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using callback = new RpcStub(async () => {
      entered.resolve();
      await release.promise;
    });
    const result = Promise.resolve(child.deferred(callback));
    // Attach rejection handling before revoking, including lazy response races.
    const assertion = expect(result).rejects.toThrow("PROTOTYPE_ADMIN_REVOKED");
    await entered.promise;
    await authority.set(false, 2);
    release.resolve();
    await assertion;
    expect(await authority.writes()).toBe(0);
  });

  it("checks both directions for readable and writable streams", async () => {
    const {key, authority, boundary: connection} = await setup();
    using boundary = connection;
    using child = await boundary.stub.child(key);
    const source = await child.stream();
    const reader = source.getReader();
    const sourceClosed = reader.closed.then(() => undefined, (error: unknown) => error);
    const sink = await child.sink();
    const writer = sink.getWriter();
    const sinkClosed = writer.closed.then(() => undefined, (error: unknown) => error);
    await writer.write(new Uint8Array([1]));
    await authority.pushStream();
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    expect(Array.from(chunk.value ?? [])).toEqual([1]);
    await authority.set(false, 2);
    // This direct test-driver push is outside the boundary: delivery must be checked
    // in the reverse direction, not merely blocked by a forward method call.
    await authority.pushStream();
    await expect(reader.read()).rejects.toThrow("disposed without calling close()");
    await expect(writer.write(new Uint8Array([2]))).rejects.toThrow("PROTOTYPE_ADMIN_REVOKED");
    expect(await sourceClosed).toMatchObject({message: "WritableStream RPC stub was disposed without calling close()"});
    expect(await sinkClosed).toMatchObject({message: "PROTOTYPE_ADMIN_REVOKED"});
    reader.releaseLock();
    writer.releaseLock();
    expect(await authority.writes()).toBe(1);
  });

  it("fails closed on an adversarial unpaced stream within the original bounds", async () => {
    const {key, authority, boundary: connection} = await setup();
    using boundary = connection;
    using child = await boundary.stub.child(key);
    const reader = (await child.flood()).getReader();
    const closed = reader.closed.then(() => undefined, (error: unknown) => error);
    await authority.startFlood();
    let failure: unknown;
    for (let i = 0; i < 64; ++i) {
      try { await reader.read(); } catch (error) { failure = error; break; }
    }
    expect(failure).toMatchObject({message: "WritableStream RPC stub was disposed without calling close()"});
    expect(await closed).toBe(failure);
    await expect(Promise.resolve(child.write())).rejects.toThrow("PROTOTYPE_BACKPRESSURE_LIMIT");
    expect(boundary.outgoing.peakMessages).toBeLessThanOrEqual(32);
    expect(boundary.outgoing.peakCodeUnits).toBeLessThanOrEqual(256 * 1024);
    reader.releaseLock();
  });

  it("accounts for actual native target disposal after independent duplicates and session abort", async () => {
    const {key, authority, boundary: connection} = await setup();
    using boundary = connection;
    const parent = await boundary.stub.child(key);
    const child = await parent.child();
    const originalDuplicate = child.dup();
    const echoed = await parent.echo(child);
    const echoedDuplicate = echoed.dup();
    parent[Symbol.dispose]();
    await expect.poll(() => authority.disposals()).toBe(1);
    child[Symbol.dispose]();
    echoed[Symbol.dispose]();
    expect(await originalDuplicate.write()).toBe(1);
    originalDuplicate[Symbol.dispose]();
    expect(await echoedDuplicate.write()).toBe(2);
    expect(await authority.disposals()).toBe(1);
    echoedDuplicate[Symbol.dispose]();
    await expect.poll(() => authority.disposals()).toBe(2);
    using retained = await boundary.stub.child(key);
    const retainedDuplicate = retained.dup();
    boundary.incoming.abort(new Error("PROTOTYPE_SESSION_CLOSED"));
    await expect(Promise.resolve(retained.write())).rejects.toThrow("PROTOTYPE_SESSION_CLOSED");
    await expect.poll(() => authority.disposals()).toBe(3);
    retainedDuplicate[Symbol.dispose]();
    expect(await authority.disposals()).toBe(3);
    expect(await authority.writes()).toBe(2);
  });

  it("preserves containment when bridged through a public HTTP batch", async () => {
    const {key, authority, boundary: connection} = await setup();
    using boundary = connection;
    class BatchRoot extends RpcTarget {
      open() { return boundary.stub.dup(); }
    }
    const root = new BatchRoot();
    // Local transport only: no fetch leaves workerd and no provider writes occur.
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== "https://prototype.invalid/") throw new Error("Unexpected test fetch URL");
      return newHttpBatchRpcResponse(request, root);
    });
    try {
      using batch = newHttpBatchRpcSession<BatchRoot>("https://prototype.invalid/");
      expect(await batch.open().child(key).write()).toBe(1);
      await authority.set(false, 2);
      using revoked = newHttpBatchRpcSession<BatchRoot>("https://prototype.invalid/");
      await denied(revoked.open().child(key).write());
      expect(await authority.writes()).toBe(1);
      expect(mock).toHaveBeenCalledTimes(2);
    } finally { mock.mockRestore(); }
  });

  it("contains retained grandchildren across an accepted local WebSocket pair", async () => {
    const {key, authority, boundary: connection} = await setup();
    using boundary = connection;
    class SocketRoot extends RpcTarget {
      open() { return boundary.stub.dup(); }
    }
    const pair = new WebSocketPair();
    pair[0].accept();
    pair[1].accept();
    const server = newWebSocketRpcSession(pair[0], new SocketRoot());
    try {
      using client = newWebSocketRpcSession<SocketRoot>(pair[1]);
      const parent = await client.open().child(key);
      using child = await parent.child();
      parent[Symbol.dispose]();
      expect(await child.write()).toBe(1);
      await authority.set(false, 2);
      await denied(child.write());
      expect(await authority.writes()).toBe(1);
    } finally { server[Symbol.dispose](); }
  });

  it("denies missing authority without evaluating the provider", async () => {
    const key = crypto.randomUUID();
    const authority = env.PROTOTYPE_AUTHORITY.getByName(key);
    using boundary = checkedBoundary(env.PROTOTYPE_SERVICE, () => authority.assertCurrent(1));
    await expect(Promise.resolve(boundary.stub.child(key).write()))
      .rejects.toThrow("PROTOTYPE_AUTHORITY_UNAVAILABLE");
    expect(await authority.writes()).toBe(0);
    expect(boundary.incoming.admitted).toBe(0);
  });
});
