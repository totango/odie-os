import { RpcPromise, type RpcStub } from "capnweb";
import { checkedBoundary } from "../authority-prototype/transport";
import type { PrototypeAuthority, PrototypeService } from "../authority-prototype/worker";

type Child = ReturnType<PrototypeAuthority["child"]>;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Assert<T extends true> = T;

/** Compile-only controls over the unchanged actual native provider and public boundary. */
export async function boundaryControls(service: Service<PrototypeService>, key: string) {
  using boundary = checkedBoundary(service, async () => {}, service);
  for (const remote of [boundary.stub, boundary.reverseStub]) {
    using parent = await remote.child(key);
    using child = await parent.child();
    using echoed = await parent.echo(child);
    using future = parent.child();
    using pipelined = await parent.echo(future);
    const exact: RpcStub<Child> = echoed;
    const count: number = await pipelined.write();
    void exact;
    void count;
    await parent.callback(value => {
      const notAny: IsAny<typeof value> = false;
      const callbackChild: RpcStub<Child> = value;
      void notAny;
      void callbackChild;
    });
    using nested = remote.nested(key);
    const mapped: number[] = await nested.items.map(item => {
      const notAny: IsAny<typeof item> = false;
      void notAny;
      return item.write();
    });
    void mapped;
  }
  const native = service.child(key);
  using wrapped = new RpcPromise(native);
  using property = new RpcPromise(native.value);
  using duplicate = wrapped.dup();
  const count: number = await duplicate.write();
  const value: number = await property;
  return count + value;
}

/** Plain-interface stubs must retain ownership and may not become plain values. */
export type BoundaryNegativeControls = [
  Assert<RpcStub<{ value: number }> extends { value: number } ? false : true>,
  Assert<"counter" extends keyof RpcStub<Child> ? false : true>,
  Assert<"dispose" extends keyof RpcStub<Child> ? false : true>
];
