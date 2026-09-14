import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
it("direct native stream control: paced read and caller cancellation", async () => {
  const key = crypto.randomUUID();
  const authority = env.PROTOTYPE_AUTHORITY.getByName(key);
  using child = await env.PROTOTYPE_SERVICE.child(key);
  const reader = (await child.stream()).getReader();
  const closed = reader.closed.then(() => undefined, error => error);
  await authority.pushStream();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel(new Error("PROTOTYPE_NATIVE_CANCEL"));
  expect(await closed).toBeUndefined();
  reader.releaseLock();
});

it("direct native stream control: observed pipeTo destination failure", async () => {
  const key = crypto.randomUUID();
  const authority = env.PROTOTYPE_AUTHORITY.getByName(key);
  using child = await env.PROTOTYPE_SERVICE.child(key);
  const source = await child.stream();
  const consumed = Promise.withResolvers<void>();
  let chunks = 0;
  const sink = new WritableStream<Uint8Array>({ write() {
    if (++chunks === 2) throw new Error("PROTOTYPE_NATIVE_PIPE_FAILURE");
    consumed.resolve();
  } });
  const pumping = expect(source.pipeTo(sink)).rejects.toThrow("PROTOTYPE_NATIVE_PIPE_FAILURE");
  await authority.pushStream();
  await consumed.promise;
  await authority.pushStream();
  await pumping;
  expect(chunks).toBe(2);
});

it("direct native stream control: graceful readable and writable completion", async () => {
  const key = crypto.randomUUID();
  const authority = env.PROTOTYPE_AUTHORITY.getByName(key);
  using child = await env.PROTOTYPE_SERVICE.child(key);
  const reader = (await child.stream()).getReader();
  const closed = reader.closed.then(() => undefined, error => error);
  await authority.pushStream();
  expect((await reader.read()).done).toBe(false);
  await authority.closeStream();
  expect((await reader.read()).done).toBe(true);
  expect(await closed).toBeUndefined();
  reader.releaseLock();
  const writer = (await child.sink()).getWriter();
  const sinkClosed = writer.closed.then(() => undefined, error => error);
  await writer.write(new Uint8Array([1]));
  await writer.close();
  expect(await sinkClosed).toBeUndefined();
  writer.releaseLock();
  expect(await authority.writes()).toBe(1);
});
