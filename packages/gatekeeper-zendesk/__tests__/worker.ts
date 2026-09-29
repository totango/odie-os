// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind the
// Durable Objects, and adds a hook Durable Object for the one thing a test cannot reach directly.
//
// `TestHooks` has to be a Durable Object rather than a WorkerEntrypoint: `ctx.facets` -- the only
// way to turn a props-carrying `DurableObjectClass` into a running object -- exists on Durable
// Objects alone. That asymmetry is the whole reason `ZendeskAccount` owns the management facet.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ZendeskGatekeeper } from "../src/zendesk.js";
import type { ApprovalQueue, ConnectHandoff, Gatekeeper, GatekeeperConnectCallback, GatekeeperUser, GitCache } from "@gadgets/workshop-shared/gatekeeper";
import type { ZendeskAccountSession } from "../src/types.js";

// Named rather than `export *`: the loopback bindings on `ctx.exports` are built from the module's
// declared exports, and the vendor's OAuth completion reaches for `ctx.exports.ZendeskUserImpl`.
export { default } from "../src/zendesk.js";
export {
  GatekeeperVendor,
  ZendeskAccount,
  ZendeskGatekeeper,
  ZendeskUserImpl,
  ZendeskVerifier,
} from "../src/zendesk.js";

type GatekeeperProps = { accountId: string; subdomain: string; ticketId?: string };

/**
 * The Workshop capability the vendor calls back on once OAuth completes.
 *
 * It is a `WorkerEntrypoint` rather than a local `RpcTarget`: `setCallback` persists the callback in
 * Durable Object storage, and only a stub that can outlive the request survives that write.
 */
export class TestConnectCallback extends WorkerEntrypoint implements GatekeeperConnectCallback {
  async getHandoffProtocol(): Promise<"browser-bound-v1"> { return "browser-bound-v1"; }
  async complete(_account: Fetcher<GatekeeperUser>, _expiresAt?: Date): Promise<ConnectHandoff> {
    return { targetOrigin: "https://workshop.example", ticket: "1".repeat(64) };
  }
  async reconnectComplete(stageId: string, _expiresAt?: Date): Promise<ConnectHandoff> {
    // The fixture echoes the stage so tests can emulate the Workshop's exact-stage redemption.
    return { targetOrigin: "https://workshop.example", ticket: stageId };
  }
  async credentialsExpired(): Promise<void> {}
  async credentialsRestored(): Promise<void> {}
}

/** Zendesk actions must never read or write Git objects. */
class UnusedGitCache extends RpcTarget implements GitCache {
  get(): never { throw new Error("Unexpected Git cache use"); }
  has(): never { throw new Error("Unexpected Git cache use"); }
  stat(): never { throw new Error("Unexpected Git cache use"); }
  put(): never { throw new Error("Unexpected Git cache use"); }
  advertiseCommit(): never { throw new Error("Unexpected Git cache use"); }
  buildPack(): never { throw new Error("Unexpected Git cache use"); }
  consumePack(): never { throw new Error("Unexpected Git cache use"); }
  isAncestor(): never { throw new Error("Unexpected Git cache use"); }
}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  /** Opens a props-scoped facet so session tests exercise real RPC and durable action storage. */
  #gatekeeper(props: GatekeeperProps): Fetcher<ZendeskGatekeeper> {
    const exports = (this.ctx as unknown as { exports: Cloudflare.Exports }).exports;
    return this.ctx.facets.get<ZendeskGatekeeper>(`session:${props.accountId}:${props.ticketId ?? "account"}`, () => ({
      class: exports.ZendeskGatekeeper({ props }),
    }));
  }
  /** Returns the account session, never the non-serializable facet stub itself. */
  async startAccountSession(props: Omit<GatekeeperProps, "ticketId">, queue: RpcStub<ApprovalQueue>): Promise<ZendeskAccountSession> {
    const gatekeeper = this.#gatekeeper(props);
    // Fetcher's mapped generic bindHook type differs from the local RpcStub type; runtime RPC is identical.
    return await gatekeeper.startSession(queue as unknown as Parameters<typeof gatekeeper.startSession>[0]) as unknown as ZendeskAccountSession;
  }
  /** Delivers an approval to the same test facet. */
  async applyAction(props: GatekeeperProps, id: number): Promise<void> {
    using cache = new RpcStub(new UnusedGitCache());
    const gatekeeper: Pick<Gatekeeper<ZendeskAccountSession>, "applyAction"> = this.#gatekeeper(props);
    await gatekeeper.applyAction(id, cache);
  }
  /**
   * Calls a gatekeeper method on the `DurableObjectClass` itself -- exactly what
   * `startAppUi` used to hand the Work Items adapter -- and reports what came back.
   *
   * The cast is deliberate and is the point of the hook: with `exportsOf` returning the generated
   * `Cloudflare.Exports`, this line does not typecheck without it, so the test has to opt in to the
   * mistake in order to demonstrate the runtime consequence.
   */
  async callSourceStatusesOnClass(props: GatekeeperProps): Promise<string> {
    const exports = (this.ctx as unknown as { exports: Cloudflare.Exports }).exports;
    const durableClass = exports.ZendeskGatekeeper({ props });
    try {
      await (durableClass as unknown as { sourceStatuses(): Promise<unknown> }).sourceStatuses();
      return "did not throw";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
