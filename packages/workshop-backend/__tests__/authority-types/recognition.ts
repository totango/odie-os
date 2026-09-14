import type { RpcStub as NativeStub, RpcTarget } from "cloudflare:workers";
import type { RpcStub } from "capnweb";
import type { PrototypeAuthority } from "../authority-prototype/worker";

type Child = ReturnType<PrototypeAuthority["child"]>;
type Assert<T extends true> = T;
type OwnershipKeys = "__RPC_STUB_BRAND" | typeof Symbol.dispose;
type ChildOwnership = Pick<RpcStub<Child>, OwnershipKeys>;
type Callable = (value: number) => number;
type CallableOwnership = Pick<RpcStub<Callable>, OwnershipKeys>;
type Payload<T extends Pick<RpcStub<unknown>, OwnershipKeys>> = T["__RPC_STUB_BRAND"];

/** Brand and disposal recognize actual native payloads without projecting polymorphic dup(). */
export type OwnershipRecognitionControls = [
  Assert<NativeStub<Child> extends ChildOwnership ? true : false>,
  Assert<NativeStub<Callable> extends CallableOwnership ? true : false>,
  Assert<Payload<NativeStub<Child>> extends Child ? true : false>,
  Assert<Child extends Payload<NativeStub<Child>> ? true : false>,
  Assert<NativeStub<RpcTarget> extends ChildOwnership ? false : true>,
  Assert<NativeStub<(value: string) => string> extends CallableOwnership ? false : true>,
  Assert<Child extends ChildOwnership ? false : true>,
  Assert<{ write(): Promise<number>; dup(): unknown; [Symbol.dispose](): void } extends ChildOwnership ? false : true>
];
