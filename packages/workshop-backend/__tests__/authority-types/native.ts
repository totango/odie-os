import { RpcTarget, type RpcStub } from "cloudflare:workers";

/** Minimal private native target; keep the provider's legitimate stub-input API. */
export class NativeTypeChild extends RpcTarget {
  #count = 0;
  write(): number { return ++this.#count; }
  child(): NativeTypeChild { return new NativeTypeChild(); }
  echo(child: RpcStub<NativeTypeChild>): RpcStub<NativeTypeChild> { return child.dup(); }
}

/** A nominally different target with the same public methods. */
export class UnrelatedNativeTypeChild extends RpcTarget {
  #count = 0;
  write(): number { return ++this.#count; }
  child(): UnrelatedNativeTypeChild { return new UnrelatedNativeTypeChild(); }
  echo(child: RpcStub<UnrelatedNativeTypeChild>): RpcStub<UnrelatedNativeTypeChild> { return child.dup(); }
}

/** Compile-only direct-native controls; never invoked by the runtime suite. */
export async function nativeControls(parent: RpcStub<NativeTypeChild>, target: NativeTypeChild) {
  using child = await parent.child();
  using echoed = await parent.echo(child);
  using echoedTarget = await parent.echo(target);
  const exact: RpcStub<NativeTypeChild> = echoed;
  const count: number = await exact.write();
  return count + await echoedTarget.write();
}

type Assert<T extends true> = T;
type Rejects<Input, Candidate> = Candidate extends Input ? false : true;
type EchoInput = Parameters<RpcStub<NativeTypeChild>["echo"]>[0];
/** Negative assertions must compile without error directives or erased argument types. */
export type NativeNegativeControls = [
  Assert<Rejects<EchoInput, RpcStub<UnrelatedNativeTypeChild>>>,
  Assert<Rejects<EchoInput, UnrelatedNativeTypeChild>>,
  Assert<Rejects<EchoInput, { write(): Promise<number> }>>,
  Assert<Rejects<EchoInput, Promise<RpcStub<NativeTypeChild>>>>,
  Assert<Rejects<EchoInput, () => number>>,
  Assert<"#count" extends keyof RpcStub<NativeTypeChild> ? false : true>
];
