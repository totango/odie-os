import type { RpcStub as NativeStub, RpcTarget } from "cloudflare:workers";
import type { RpcStub } from "capnweb";

type Assert<T extends true> = T;
type OwnedProjection = Omit<RpcStub<unknown>, "onRpcBroken">;

/**
 * The rejected candidate's Omit projection is not a common native ownership shape:
 * its inherited polymorphic dup() still returns a Cap'n Web stub with onRpcBroken.
 * These non-assignability assertions diagnose that candidate, not a runtime limitation.
 */
export type OwnedProjectionCounterexample = [
  Assert<NativeStub<RpcTarget> extends OwnedProjection ? false : true>,
  Assert<"onRpcBroken" extends keyof ReturnType<OwnedProjection["dup"]> ? true : false>
];
