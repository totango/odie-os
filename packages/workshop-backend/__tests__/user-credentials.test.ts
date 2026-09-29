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

    await expect(user.ensureAccountResources(7, [])).resolves.toEqual({});
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
    const connectAccount = vi.fn(async () => ({ url: "https://provider.example/oauth" }));
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
    });

    await expect(user.connectAccount("google", ["resource"], nativeFlow))
      .resolves.toEqual({ url: "https://provider.example/oauth" });

    expect(connectAccount).toHaveBeenCalledWith(callbacks[0], {
      resourceUrlPatterns: ["resource"],
      returnUrl: nativeFlow.returnUrl,
    });
    expect(callbacks[0]).toEqual({
      props: { userId: "user-1", accountId: 7, vendorId: "google", flowHandle: nativeFlow.flowHandle },
    });
  });

  it("records pending native reconnect and grant flows only when a provider URL is returned", async () => {
    const account = {
      reconnect: vi.fn(async () => ({ url: "https://provider.example/reconnect" })),
      ensureResources: vi.fn(async (patterns: string[]) => patterns.length ? { url: "https://provider.example/grant" } : {}),
    } as unknown as Fetcher<GatekeeperUser>;
    const record = { id: 7, account, description: { avatar: { url: "" } }, vendorId: "google", credentialsExpired: false };
    const storage = makeStorage(record);
    const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
    Object.assign(user, {
      env: { BLUEPRINTS: { get: async () => null } },
      storage,
    });

    await expect(user.reconnectAccount(7, nativeFlow)).resolves.toEqual({ url: "https://provider.example/reconnect" });
    expect(account.reconnect).toHaveBeenCalledWith({ returnUrl: nativeFlow.returnUrl });
    expect(storage.saved).toMatchObject({ pendingNativeFlow: { flowHandle: nativeFlow.flowHandle, kind: "reconnect" } });

    await expect(user.ensureAccountResources(7, ["resource"], nativeFlow)).resolves.toEqual({ url: "https://provider.example/grant" });
    expect(account.ensureResources).toHaveBeenCalledWith(["resource"], { returnUrl: nativeFlow.returnUrl });
    expect(storage.saved).toMatchObject({ pendingNativeFlow: { flowHandle: nativeFlow.flowHandle, kind: "grant" } });

    await expect(user.ensureAccountResources(7, [], nativeFlow)).resolves.toEqual({});
    expect(storage.connectedAccounts.put).toHaveBeenCalledTimes(2);
  });

  it("completes native connect callbacks only after the connected account is persisted", async () => {
    const calls: string[] = [];
    const completeAccount = vi.fn(async () => {});
    completeAccount.mockImplementation(async () => { calls.push("completeAccount"); });
    const putConnectedAccount = vi.fn(async () => { calls.push("putConnectedAccount"); });
    const account = { describe: vi.fn(async () => ({ avatar: { url: "" } })) } as unknown as Fetcher<GatekeeperUser>;
    const callback = Object.create(GatekeeperConnectCallbackImpl.prototype) as GatekeeperConnectCallbackImpl;
    Object.assign(callback, {
      ctx: {
        props: { userId: "user-1", accountId: 7, vendorId: "google", flowHandle: nativeFlow.flowHandle },
        exports: {
          UserDurableObject: { idFromString: (id: string) => id, get: () => ({ putConnectedAccount }) },
          NativeBrowserFlow: { idFromName: (id: string) => id, get: () => ({ completeAccount, fail: vi.fn() }) },
        },
      },
    });

    await expect(callback.complete(account)).resolves.toBeUndefined();
    expect(calls).toEqual(["putConnectedAccount", "completeAccount"]);
  });

  it("fails native callback flows when persistence cannot complete", async () => {
    const fail = vi.fn(async () => {});
    const callback = Object.create(GatekeeperConnectCallbackImpl.prototype) as GatekeeperConnectCallbackImpl;
    Object.assign(callback, {
      ctx: {
        props: { userId: "user-1", accountId: 7, vendorId: "google", flowHandle: nativeFlow.flowHandle },
        exports: {
          UserDurableObject: { idFromString: (id: string) => id, get: () => ({ putConnectedAccount: vi.fn(async () => { throw new Error("storage unavailable"); }) }) },
          NativeBrowserFlow: { idFromName: (id: string) => id, get: () => ({ completeAccount: vi.fn(), fail }) },
        },
      },
    });
    const account = { describe: vi.fn(async () => ({ avatar: { url: "" } })) } as unknown as Fetcher<GatekeeperUser>;

    await expect(callback.complete(account)).rejects.toThrow("storage unavailable");
    expect(fail).toHaveBeenCalledWith("Account connection failed. Please try again.");
  });

  it("completes and fails pending reconnect/grant native flows from credential callbacks", async () => {
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

    await expect(user.markCredentialsRestored(7)).resolves.toBeUndefined();
    expect(completeAccount).toHaveBeenCalledOnce();
    expect(storage.saved).not.toHaveProperty("pendingNativeFlow");

    record.pendingNativeFlow = { flowHandle: nativeFlow.flowHandle, kind: "grant" };
    account.describe = vi.fn(async () => { throw new Error("describe failed"); }) as typeof account.describe;
    await expect(user.markCredentialsRestored(7)).rejects.toThrow("describe failed");
    expect(fail).toHaveBeenCalledWith("Account reconnection failed. Please try again.");
  });
});
