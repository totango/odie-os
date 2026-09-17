import { describe, expect, it, vi } from "vitest";
import type { GatekeeperUser, GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";
import { GatekeeperConnectCallbackImpl, UserDurableObject } from "../src/user.js";

function makeUser(vendorId: string, credentialsExpired = false) {
  const ensureResources = vi.fn(async () => ({}));
  const account = { ensureResources } as Fetcher<GatekeeperUser>;
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    env: { BLUEPRINTS: { get: async () => null } },
    storage: {
      connectedAccounts: {
        get: () => ({
          id: 7,
          account,
          description: { avatar: { url: "" } },
          vendorId,
          credentialExpiresAt: new Date(0),
          credentialsExpired,
        }),
      },
    },
  });
  return { user, ensureResources };
}

describe("connected account credential expiry", () => {
  it("ignores legacy Slack access-token expiry", async () => {
    const { user, ensureResources } = makeUser("slack");

    await expect(user.ensureAccountResources(7, [])).resolves.toBeNull();
    expect(ensureResources).toHaveBeenCalledOnce();
  });

  it("still rejects Slack credentials reported as expired", async () => {
    const { user, ensureResources } = makeUser("slack", true);

    await expect(user.ensureAccountResources(7, [])).rejects.toThrow("needs to be reconnected");
    expect(ensureResources).not.toHaveBeenCalled();
  });

  it("still rejects another provider's expired credentials", async () => {
    const { user, ensureResources } = makeUser("confluence");

    await expect(user.ensureAccountResources(7, [])).rejects.toThrow("needs to be reconnected");
    expect(ensureResources).not.toHaveBeenCalled();
  });
});

describe("native account browser flows", () => {
  const nativeFlow = {
    flowHandle: "native-flow-1",
    returnUrl: "https://workshop.example/native/oauth-return/native-flow-1",
  };

  function makeStorage(record?: unknown) {
    let saved: unknown;
    return {
      get saved() { return saved; },
      nextAccountId: { get: vi.fn(() => 7), put: vi.fn() },
      connectedAccounts: {
        get: vi.fn(() => record),
        put: vi.fn((value: unknown) => { saved = value; }),
      },
    };
  }

  it("passes the native return URL and verifier-bound callback through connectAccount", async () => {
    const connectAccount = vi.fn(async () => ({ url: "https://provider.example/oauth", handoffProtocol: "native-verifier-v1" }));
    const callbacks: unknown[] = [];
    const storage = makeStorage();
    const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
    Object.assign(user, {
      env: { BLUEPRINTS: { get: async () => null } },
      ctx: {
        id: { toString: () => "user-1" },
        exports: { GatekeeperConnectCallbackImpl: (value: unknown) => { callbacks.push(value); return value; } },
      },
      storage,
      vendors: new Map([["google", { connectAccount } as unknown as GatekeeperVendor]]),
      openConnectFlow: vi.fn(async () => "private-nonce"),
    });

    await expect(user.connectAccount("google", ["resource"], nativeFlow))
      .resolves.toEqual({ url: "https://provider.example/oauth", nonce: "private-nonce" });

    expect(connectAccount).toHaveBeenCalledWith(callbacks[0], {
      resourceUrlPatterns: ["resource"],
      returnUrl: nativeFlow.returnUrl,
      handoffProtocol: "native-verifier-v1",
    });
    expect(callbacks[0]).toEqual({
      props: { userId: "user-1", accountId: 7, vendorId: "google", flowHandle: nativeFlow.flowHandle },
    });
  });

  it("records pending native reconnect and grant flows only when a provider URL is returned", async () => {
    const account = {
      reconnect: vi.fn(async () => ({ url: "https://provider.example/reconnect", handoffProtocol: "native-verifier-v1" })),
      ensureResources: vi.fn(async (patterns: string[]) => patterns.length ? { url: "https://provider.example/grant", handoffProtocol: "native-verifier-v1" } : {}),
    } as unknown as Fetcher<GatekeeperUser>;
    const record = { id: 7, account, description: { avatar: { url: "" } }, vendorId: "google", credentialsExpired: false };
    const storage = makeStorage(record);
    const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
    Object.assign(user, {
      env: { BLUEPRINTS: { get: async () => null } },
      storage,
      openConnectFlow: vi.fn(async () => "private-nonce"),
    });

    await expect(user.reconnectAccount(7, nativeFlow)).resolves.toEqual({ url: "https://provider.example/reconnect", nonce: "private-nonce" });
    expect(account.reconnect).toHaveBeenCalledWith({ returnUrl: nativeFlow.returnUrl, handoffProtocol: "native-verifier-v1" });
    expect(storage.saved).toMatchObject({ pendingNativeFlow: { flowHandle: nativeFlow.flowHandle, kind: "reconnect" } });

    await expect(user.ensureAccountResources(7, ["resource"], nativeFlow)).resolves.toEqual({ url: "https://provider.example/grant", nonce: "private-nonce" });
    expect(account.ensureResources).toHaveBeenCalledWith(["resource"], { returnUrl: nativeFlow.returnUrl, handoffProtocol: "native-verifier-v1" });
    expect(storage.saved).toMatchObject({ pendingNativeFlow: { flowHandle: nativeFlow.flowHandle, kind: "grant" } });

    await expect(user.ensureAccountResources(7, [], nativeFlow)).resolves.toBeNull();
    expect(storage.connectedAccounts.put).toHaveBeenCalledTimes(2);
  });

  it("stages native connect callbacks without persisting or completing the account", async () => {
    const calls: string[] = [];
    const completeAccount = vi.fn(async () => {});
    completeAccount.mockImplementation(async () => { calls.push("completeAccount"); });
    const putConnectedAccount = vi.fn(async () => { calls.push("putConnectedAccount"); });
    const handoff = {targetOrigin: "https://workshop.example", ticket: "ticket", nativeFlowHandle: nativeFlow.flowHandle};
    const stagePendingConnect = vi.fn(async () => { calls.push("stagePendingConnect"); return handoff; });
    const account = { describe: vi.fn(async () => ({ avatar: { url: "" } })) } as unknown as Fetcher<GatekeeperUser>;
    const callback = Object.create(GatekeeperConnectCallbackImpl.prototype) as GatekeeperConnectCallbackImpl;
    Object.assign(callback, {
      ctx: {
        props: { userId: "user-1", accountId: 7, vendorId: "google", flowHandle: nativeFlow.flowHandle },
        exports: {
          UserDurableObject: { idFromString: (id: string) => id, get: () => ({ putConnectedAccount, stagePendingConnect }) },
          NativeBrowserFlow: { idFromName: (id: string) => id, get: () => ({ completeAccount, fail: vi.fn() }) },
        },
      },
    });

    await expect(callback.complete(account)).resolves.toEqual(handoff);
    expect(calls).toEqual(["stagePendingConnect"]);
    expect(stagePendingConnect).toHaveBeenCalledWith(7, account, "google", undefined, nativeFlow.flowHandle);
  });

  it("fails native callback flows when persistence cannot complete", async () => {
    const fail = vi.fn(async () => {});
    const callback = Object.create(GatekeeperConnectCallbackImpl.prototype) as GatekeeperConnectCallbackImpl;
    Object.assign(callback, {
      ctx: {
        props: { userId: "user-1", accountId: 7, vendorId: "google", flowHandle: nativeFlow.flowHandle },
        exports: {
          UserDurableObject: { idFromString: (id: string) => id, get: () => ({ stagePendingConnect: vi.fn(async () => { throw new Error("storage unavailable"); }) }) },
          NativeBrowserFlow: { idFromName: (id: string) => id, get: () => ({ completeAccount: vi.fn(), fail }) },
        },
      },
    });
    const account = { describe: vi.fn(async () => ({ avatar: { url: "" } })) } as unknown as Fetcher<GatekeeperUser>;

    await expect(callback.complete(account)).rejects.toThrow("storage unavailable");
    expect(fail).not.toHaveBeenCalled();
  });

  it("refuses legacy credential callbacks as proof of native reconnect/grant completion", async () => {
    const completeAccount = vi.fn(async () => {});
    const fail = vi.fn(async () => {});
    const account = { describe: vi.fn(async () => ({ avatar: { url: "updated" } })) } as unknown as Fetcher<GatekeeperUser>;
    const record = {
      id: 7,
      account,
      description: { avatar: { url: "" } },
      vendorId: "google",
      pendingNativeFlow: { flowHandle: nativeFlow.flowHandle, kind: "reconnect" },
    };
    const storage = makeStorage(record);
    const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
    Object.assign(user, {
      ctx: { exports: { NativeBrowserFlow: { idFromName: (id: string) => id, get: () => ({ completeAccount, fail }) } } },
      storage,
    });

    await expect(user.markCredentialsRestored(7)).rejects.toThrow("requires its completion ticket");
    expect(completeAccount).not.toHaveBeenCalled();
    expect(storage.connectedAccounts.put).not.toHaveBeenCalled();

    record.pendingNativeFlow = { flowHandle: nativeFlow.flowHandle, kind: "grant" };
    account.describe = vi.fn(async () => { throw new Error("describe failed"); }) as typeof account.describe;
    await expect(user.markCredentialsRestored(7)).rejects.toThrow("requires its completion ticket");
    expect(fail).not.toHaveBeenCalled();
    expect(account.describe).not.toHaveBeenCalled();
  });
});
