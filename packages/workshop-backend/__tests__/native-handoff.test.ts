import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { createNativeBrowserFlowRecord } from "../src/auth/native-browser-flow";
import { newSecretToken, requireProviderHandoff } from "../src/connect-handoff";

// The provider harness loads the validated backend and actual Context/JARVIS Workers lazily.
beforeAll(async () => { await env.TEST_PENDING_LOGIN.getByName("native-handoff-warmup").begin(); }, 30000);

async function rejection(call: () => PromiseLike<unknown>): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([call(), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("RPC rejection timed out")), 2000);
    })]);
    return "unexpected success";
  }
  catch (error) { return String(error); }
  finally { clearTimeout(timeout); }
}

async function fixture(native = true, vendorId = "test", failDescribe = false) {
  const name = crypto.randomUUID();
  const hooks = env.TEST_ADMIN_PROVIDERS.getByName(name);
  const pending = env.TEST_PENDING_LOGIN.getByName(name);
  await pending.begin();
  const verifier = await newSecretToken();
  const flow = hooks;
  await flow.initialize(createNativeBrowserFlowRecord({
    kind: "login", flowHandle: name, launchTicket: name, clientVerifierHash: verifier.hash,
    providerInitiationUrl: "https://provider.example/authorize", pendingLoginId: pending.id.toString(),
  }));
  const callback = await hooks.loginCallback(pending.id.toString(), native ? name : undefined, vendorId);
  const account = await hooks.handoffAccount(name, false, failDescribe);
  return {name, flow, pending, callback, account, verifier};
}

async function accountFixture(legacyHandoff = false) {
  const name = crypto.randomUUID();
  const flow = env.TEST_ADMIN_PROVIDERS.getByName(name);
  const user = env.TEST_USER.getByName(name);
  await runInDurableObject(user, async instance => { Reflect.get(instance, "storage").nextAccountId.put(1); });
  const verifier = await newSecretToken();
  const nonce = await user.openConnectFlow(0, name);
  await flow.initialize(createNativeBrowserFlowRecord({kind: "connect", flowHandle: name,
    launchTicket: name, clientVerifierHash: verifier.hash, providerInitiationUrl: "https://provider.example/authorize",
    userId: user.id.toString(), accountNonce: nonce}));
  const callback = await flow.accountCallback(user.id.toString(), 0, name);
  const account = await flow.handoffAccount(name, legacyHandoff);
  const connected = () => runInDurableObject(user, async instance =>
    Boolean(Reflect.get(instance, "storage").connectedAccounts.get(0)));
  return {name, flow, user, verifier, nonce, callback, account, connected};
}

describe("provider → backend → native redemption", () => {
  it("cleans a conclusively uninstalled grant when provider describe rejects before effects", async () => {
    const f = await fixture(true, "cloudflare", true);
    const handoff = await f.callback.complete(f.account as never);
    expect(await rejection(() => f.pending.confirm(handoff.ticket))).toContain("describe failed");
    expect(await f.account.calls()).toContain("revoke");
    expect(await f.pending.getLink()).toBeNull();
    await runInDurableObject(f.pending, async instance => {
      await instance.alarm();
      expect(instance.ctx.storage.kv.get("result")).toBeUndefined();
      expect(await instance.ctx.storage.getAlarm()).toBeNull();
    });
    const user = env.TEST_USER.getByName(`${f.name}@example.com`);
    await runInDurableObject(user, instance => {
      expect([...Reflect.get(instance, "storage").connectedAccounts.list()]).toEqual([]);
    });
  });

  it.each(["not-started", "preparing", "installed"])("reconciles a persisted %s grant after DO interruption and stops its expiry alarm", async checkpoint => {
    const f = await fixture(true, "cloudflare");
    const handoff = await f.callback.complete(f.account as never);
    const {hashPresentedSecret} = await import("../src/connect-handoff");
    const grantId = (await hashPresentedSecret(handoff.ticket))!;
    let user = env.TEST_USER.getByName(`${f.name}@example.com`);
    if (checkpoint === "preparing") await runInDurableObject(user, instance => {
      Reflect.get(instance, "storage").loginGrantOutcomes.put({id: grantId, state: "preparing"});
    });
    if (checkpoint === "installed") await user.installLoginGrant(grantId, f.account as never, "cloudflare");
    // Persist exactly the checkpoint preceding the user-DO call, with no live confirmation task.
    await runInDurableObject(f.pending, instance => {
      const result = instance.ctx.storage.kv.get<Record<string, unknown>>("result")!;
      instance.ctx.storage.kv.put("result", {...result, confirming: true});
    });
    await abortAllDurableObjects();
    f.pending = env.TEST_PENDING_LOGIN.getByName(f.name);
    f.flow = env.TEST_ADMIN_PROVIDERS.getByName(f.name);
    f.account = await f.flow.handoffAccount(f.name);
    user = env.TEST_USER.getByName(`${f.name}@example.com`);
    await (f.pending as DurableObjectStub<import("./admin-authority-worker").PendingLogin>).expireDuringConfirmation();
    if (checkpoint === "installed") {
      expect(await f.account.calls()).not.toContain("revoke");
      expect(await f.pending.getLink()).not.toBeNull();
    } else {
      expect(await f.account.calls()).toContain("revoke");
      expect(await f.pending.getLink()).toBeNull();
      expect(await rejection(() => user.installLoginGrant(grantId, f.account as never, "cloudflare")))
        .toContain("LOGIN_GRANT_INSTALL_UNAVAILABLE");
    }
    expect(await rejection(() => f.pending.receive())).toContain("expired");
    await runInDurableObject(f.pending, async instance => {
      expect(instance.ctx.storage.kv.get("result")).toBeUndefined();
      expect(await instance.ctx.storage.getAlarm()).toBeNull();
    });
  });

  it("reconciles an installed grant after its acknowledgement is lost without revocation or replay", async () => {
    const f = await fixture(true, "cloudflare");
    const handoff = await f.callback.complete(f.account as never);
    const user = env.TEST_USER.getByName(`${f.name}@example.com`);
    let installs = 0;
    await runInDurableObject(user, instance => {
      const original = instance.installLoginGrant.bind(instance);
      Object.setPrototypeOf(instance, {__proto__: Object.getPrototypeOf(instance),
        async installLoginGrant(...args: Parameters<typeof original>) {
          installs++;
          await original(...args);
          throw new Error("installed acknowledgement lost");
        },
      });
    });
    await f.pending.confirm(handoff.ticket);
    expect(installs).toBe(1);
    expect(await f.pending.getLink()).not.toBeNull();
    expect(await f.account.calls()).not.toContain("revoke");
    await (f.pending as DurableObjectStub<import("./admin-authority-worker").PendingLogin>).expireDuringConfirmation();
    expect(await rejection(() => f.pending.receive())).toContain("expired");
    expect(await f.account.calls()).not.toContain("revoke");
    await runInDurableObject(f.pending, async instance => {
      expect(instance.ctx.storage.kv.get("result")).toBeUndefined();
      expect(await instance.ctx.storage.getAlarm()).toBeNull();
    });
  });
  it.each(["before", "after"])("reconciles a %s-activation RPC fault without losing proof or replaying activation", async fault => {
    const f = await accountFixture();
    const handoff = await f.callback.complete(f.account as never);
    let calls = 0;
    await runInDurableObject(f.user, instance => {
      const original = instance.completeConnectHandoff.bind(instance);
      Object.setPrototypeOf(instance, {__proto__: Object.getPrototypeOf(instance),
        async completeConnectHandoff(ticket: string, nonce: string) {
        calls++;
        if (calls === 1 && fault === "before") throw new Error("delivery failed before activation");
        await original(ticket, nonce);
        if (calls === 1 && fault === "after") throw new Error("activation acknowledgement lost");
      }});
    });
    if (fault === "before") {
      expect(await rejection(() => f.flow.completeAccountHandoff(f.verifier.hash, handoff.ticket, f.user.id.toString())))
        .toContain("before activation");
      expect(await f.flow.getAccountStatus(f.verifier.hash, f.user.id.toString())).toEqual({status: "pending"});
      expect(await f.connected()).toBe(false);
      await f.flow.completeAccountHandoff(f.verifier.hash, handoff.ticket, f.user.id.toString());
    } else {
      await f.flow.completeAccountHandoff(f.verifier.hash, handoff.ticket, f.user.id.toString());
    }
    expect(await f.connected()).toBe(true);
    expect(await f.flow.getAccountStatus(f.verifier.hash, f.user.id.toString())).toEqual({status: "completed"});
    expect(calls).toBe(fault === "before" ? 2 : 1);
  });

  it("expiry fences a delayed install before revoking its grant, with no stale resurrection", async () => {
    const f = await fixture(true, "cloudflare");
    const handoff = await f.callback.complete(f.account as never);
    const barrier = {reached: false, released: false};
    const user = env.TEST_USER.getByName(`${f.name}@example.com`);
    await runInDurableObject(user, instance => {
      const original = instance.installLoginGrant.bind(instance);
      Object.setPrototypeOf(instance, {__proto__: Object.getPrototypeOf(instance),
        async installLoginGrant(...args: Parameters<typeof original>) {
        barrier.reached = true;
        while (!barrier.released) await new Promise(resolve => setTimeout(resolve, 5));
        return original(...args);
      }});
    });
    const confirm = rejection(() => f.pending.confirm(handoff.ticket));
    try {
      while (!barrier.reached) await new Promise(resolve => setTimeout(resolve, 5));
      await (f.pending as DurableObjectStub<import("./admin-authority-worker").PendingLogin>).expireDuringConfirmation();
      expect(await f.account.calls()).toContain("revoke");
    } finally { barrier.released = true; }
    expect(await confirm).toContain("LOGIN_GRANT_INSTALL_UNAVAILABLE");
    expect(await f.pending.getLink()).toBeNull();
    await runInDurableObject(f.pending, async instance => {
      expect(instance.ctx.storage.kv.get("result")).toBeUndefined();
      expect(await instance.ctx.storage.getAlarm()).toBeNull();
    });
    expect(await rejection(() => f.pending.receive())).toContain("expired");
  });
  it("rejects old or mismatched provider launch acknowledgements for browser and native flows", () => {
    for (const protocol of ["browser-bound-v1", "native-verifier-v1"] as const) {
      expect(() => requireProviderHandoff({url: "https://provider.example/authorize"}, protocol))
          .toThrow("PROVIDER_HANDOFF_UPGRADE_REQUIRED");
      expect(() => requireProviderHandoff({url: "https://provider.example/authorize", handoffProtocol: protocol}, protocol))
          .not.toThrow();
      expect(() => requireProviderHandoff({}, protocol)).not.toThrow();
    }
    expect(() => requireProviderHandoff({url: "https://provider.example", handoffProtocol: "browser-bound-v1"}, "native-verifier-v1"))
        .toThrow("PROVIDER_HANDOFF_UPGRADE_REQUIRED");
  });

  it("withholds old-provider reconnect/grant URLs before browsers can overwrite a live grant", async () => {
    const f = await accountFixture(true);
    const handoff = await f.callback.complete(f.account as never);
    await f.flow.completeAccountHandoff(f.verifier.hash, handoff.ticket, f.user.id.toString());
    expect(await rejection(() => f.user.reconnectAccount(0))).toMatch(/PROVIDER_HANDOFF_UPGRADE_REQUIRED/);
    expect(await rejection(() => f.user.reconnectAccount(0, {flowHandle: "another-native-flow", returnUrl: "https://workshop.example/native/oauth-return/another-native-flow"})))
        .toMatch(/PROVIDER_HANDOFF_UPGRADE_REQUIRED/);
    expect(await rejection(() => f.user.ensureAccountResources(0, ["https://resource.example/*"])))
        .toMatch(/PROVIDER_HANDOFF_UPGRADE_REQUIRED/);
    expect(await f.connected()).toBe(true);
    expect((await f.account.calls()).some(call => call.startsWith("commitReconnect"))).toBe(false);
  });
  it("defers a sign-in billing grant until ticket proof, and revokes an abandoned grant", async () => {
    const f = await fixture(true, "cloudflare");
    const handoff = await f.callback.complete(f.account as never);
    expect(await f.pending.getLink()).toBeNull();
    await f.flow.consumeLoginResult(f.verifier.hash, handoff.ticket);
    expect(await f.pending.getLink()).not.toBeNull();
    expect(await f.callback.getHandoffProtocol()).toBe("browser-bound-v1");

    const abandoned = await fixture(false, "cloudflare");
    await abandoned.callback.complete(abandoned.account as never);
    expect(await abandoned.pending.getLink()).toBeNull();
    await runInDurableObject(abandoned.pending, instance => instance.alarm());
    expect(await abandoned.account.calls()).toContain("revoke");
    expect(await abandoned.pending.getLink()).toBeNull();
  });
  it("activates a native account only with its owner, verifier, ticket, and exact flow", async () => {
    const f = await accountFixture();
    expect(await f.callback.getHandoffProtocol()).toBe("native-verifier-v1");
    const handoff = await f.callback.complete(f.account as never);
    expect(handoff.nativeFlowHandle).toBe(f.name);
    expect(await f.connected()).toBe(false);
    expect(await f.flow.getAccountStatus(f.verifier.hash, f.user.id.toString())).toEqual({status: "pending"});
    expect(await rejection(() => f.flow.completeAccountHandoff("wrong", handoff.ticket, f.user.id.toString()))).toMatch(/verifier/);
    expect(await rejection(() => f.flow.completeAccountHandoff(f.verifier.hash, handoff.ticket, "another-owner"))).toMatch(/not redeemable/);
    expect(await f.connected()).toBe(false);
    await f.flow.completeAccountHandoff(f.verifier.hash, handoff.ticket, f.user.id.toString());
    expect(await f.connected()).toBe(true);
    expect(await rejection(() => f.flow.completeAccountHandoff(f.verifier.hash, handoff.ticket, f.user.id.toString()))).toMatch(/not redeemable/);
  });

  it("rejects cross-flow browser/native redemption even for the same connected-account slot", async () => {
    const f = await accountFixture();
    const browserNonce = await f.user.openConnectFlow(0);
    const handoff = await f.callback.complete(f.account as never);
    expect(await rejection(() => f.user.completeConnectHandoff(handoff.ticket, browserNonce))).toMatch(/expired/);
    expect(await f.connected()).toBe(false);
  });

  it("commits only the ticket's reconnect stage and refuses legacy credential-restored completion", async () => {
    const f = await accountFixture();
    const initial = await f.callback.complete(f.account as never);
    await f.flow.completeAccountHandoff(f.verifier.hash, initial.ticket, f.user.id.toString());
    const name = crypto.randomUUID();
    const next = env.TEST_ADMIN_PROVIDERS.getByName(name);
    const started = await f.user.reconnectAccount(0, {flowHandle: name,
      returnUrl: `https://workshop.example/native/oauth-return/${name}`});
    await next.initialize(createNativeBrowserFlowRecord({kind: "reconnect", flowHandle: name,
      launchTicket: name, clientVerifierHash: f.verifier.hash, providerInitiationUrl: started.url,
      userId: f.user.id.toString(), accountNonce: started.nonce}));
    expect(await f.callback.getHandoffProtocol()).toBe("native-verifier-v1");
    const handoff = await f.callback.reconnectComplete("exact-stage");
    expect(handoff.nativeFlowHandle).toBe(name);
    expect(await rejection(() => f.user.markCredentialsRestored(0))).toMatch(/requires its completion ticket/);
    expect((await f.account.calls()).some(call => call.startsWith("commitReconnect"))).toBe(false);
    await next.completeAccountHandoff(f.verifier.hash, handoff.ticket, f.user.id.toString());
    expect((await f.account.calls()).filter(call => call.startsWith("commitReconnect")))
        .toEqual(["commitReconnect(exact-stage)"]);
    expect(await f.callback.getHandoffProtocol()).toBe("browser-bound-v1");
    expect(await next.getAccountStatus(f.verifier.hash, f.user.id.toString())).toEqual({status: "completed"});
  });

  it("old account providers discarding native tickets leave grants staged and inaccessible", async () => {
    const f = await accountFixture();
    await f.callback.complete(f.account as never);
    expect(await f.connected()).toBe(false);
    expect(await f.flow.getAccountStatus(f.verifier.hash, f.user.id.toString())).toEqual({status: "pending"});
  });

  it("requires both the completing browser's ticket and the app verifier; consumes once", async () => {
    const f = await fixture();
    expect(await f.callback.getHandoffProtocol()).toBe("native-verifier-v1");
    expect(await f.flow.launch(f.name)).toBe("https://provider.example/authorize");
    const handoff = await f.callback.complete(f.account as never);
    expect(handoff.nativeFlowHandle).toBe(f.name);
    expect(handoff.targetOrigin).toBe("https://workshop.example");
    expect(await f.pending.receive()).toBeNull();
    expect(await f.flow.consumeLoginResult(f.verifier.hash)).toEqual({status: "pending"});
    expect(await f.flow.consumeLoginResult("wrong", handoff.ticket)).toEqual({status: "verifier-mismatch"});
    expect(await rejection(() => f.flow.consumeLoginResult(f.verifier.hash, "0".repeat(64)))).toMatch(/expired/);
    const result = await f.flow.consumeLoginResult(f.verifier.hash, handoff.ticket);
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.token).toContain(`${f.name}@example.com:`);
    expect(await f.flow.consumeLoginResult(f.verifier.hash, handoff.ticket)).toEqual({status: "consumed"});
    expect(await rejection(() => f.callback.complete(f.account as never))).toMatch(/expired/);
    expect(await rejection(() => f.flow.launch(f.name))).toMatch(/already used/);
  });

  it("old providers ignoring the returned native ticket cannot activate verifier-only polling", async () => {
    const f = await fixture();
    // Frozen legacy provider behavior: no negotiation and discard complete()'s result.
    await f.callback.complete(f.account as never);
    expect(await f.flow.consumeLoginResult(f.verifier.hash)).toEqual({status: "pending"});
    await f.flow.expire();
    expect(await f.flow.consumeLoginResult(f.verifier.hash)).toEqual({status: "expired"});
  });

  it("old providers ignoring a browser ticket cannot release the browser login attempt", async () => {
    const f = await fixture(false);
    expect(await f.callback.getHandoffProtocol()).toBe("browser-bound-v1");
    await f.callback.complete(f.account as never);
    expect(await f.pending.receive()).toBeNull();
    expect(await rejection(() => f.pending.confirm("0".repeat(64)))).toMatch(/expired/);
    expect(await f.pending.receive()).toBeNull();
  });

  it("keeps browser redemption ticket-gated and disjoint from another native flow", async () => {
    const browser = await fixture(false);
    const native = await fixture();
    const handoff = await browser.callback.complete(browser.account as never);
    expect(handoff.nativeFlowHandle).toBeUndefined();
    expect(await rejection(() => native.flow.consumeLoginResult(native.verifier.hash, handoff.ticket))).toMatch(/expired/);
    expect(await browser.pending.receive()).toBeNull();
    await browser.pending.confirm(handoff.ticket);
    expect(await browser.pending.receive()).toContain(`${browser.name}@example.com:`);
    expect(await rejection(() => browser.pending.receive())).toMatch(/expired/);
  });
});
