import { env } from "cloudflare:workers";
import { RpcPromise } from "capnweb";
import { expect, it } from "vitest";
import { checkedBoundary } from "./transport";

it("native pass-back regression: both string-session directions preserve awaited and pipelined arguments", async () => {
  const key = crypto.randomUUID();
  using boundary = checkedBoundary(env.PROTOTYPE_SERVICE, async () => {}, env.PROTOTYPE_SERVICE);
  let count = 0;
  for (const service of [boundary.stub, boundary.reverseStub]) {
    using parent = await service.child(key);
    using child = await parent.child();
    using echoed = await parent.echo(child);
    expect(await echoed.write()).toBe(++count);
    // A true RpcPromise argument still substitutes its resolution before provider delivery.
    using future = parent.child();
    using pipelined = await parent.echo(future);
    expect(await pipelined.write()).toBe(++count);
  }
});

it("native promise/property wrappers still support promise pipelining", async () => {
  const key = crypto.randomUUID();
  const native = env.PROTOTYPE_SERVICE.child(key);
  using wrapped = new RpcPromise(native);
  expect(await wrapped.child().write()).toBe(1);
  using property = new RpcPromise(native.value);
  expect(await property).toBe(1);
  using duplicate = wrapped.dup();
  expect(await duplicate.write()).toBe(2);
});
