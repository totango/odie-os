import { RpcTarget } from "capnweb";
import { expect, it } from "vitest";
import { checkedBoundary } from "./transport";

it("observes an aborted userspace stream without a native provider", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  class Root extends RpcTarget {
    source() { return new ReadableStream<Uint8Array>({ start(value) { controller = value; } }); }
  }
  let revoked = false;
  using boundary = checkedBoundary(new Root(), async () => {
    if (revoked) throw new Error("PROTOTYPE_STREAM_ABORT");
  });
  const reader = (await boundary.stub.source()).getReader();
  const closed = reader.closed.then(() => undefined, error => error);
  controller.enqueue(new Uint8Array([1]));
  expect((await reader.read()).done).toBe(false);
  revoked = true;
  controller.enqueue(new Uint8Array([2]));
  await expect(reader.read()).rejects.toThrow("disposed without calling close()");
  expect(await closed).toBeInstanceOf(Error);
  reader.releaseLock();
});
