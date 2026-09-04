import { describe, expect, it, vi } from "vitest";
import type { AppUiContext, Gatekeeper, GatekeeperUiFrame, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";

const retiredVendorId = "team_pi";

function makeRetiredAccount() {
  const account = {
    describe: vi.fn(async () => ({
      displayName: "Team PI",
      uniqueName: "team-pi@example.test",
      avatar: {url: "https://team-pi.example/avatar.png"},
      singleton: {tsType: "TeamPiSession"},
      providesUi: {title: "Team PI"},
    })),
    getSingletonGatekeeperClass: vi.fn(async () =>
      ({} as DurableObjectClass<Gatekeeper<any>>)),
    startAppUi: vi.fn(async () => ({html: ""}) as unknown as GatekeeperUiFrame),
    getGatekeeperClassFor: vi.fn(async () => ({
      class: {} as DurableObjectClass<Gatekeeper<any>>,
      resource: {urlPattern: "https://team-pi.example/*", title: "Team PI"},
    })),
    ensureResources: vi.fn(async () => ({})),
    startResourceConfigurator: vi.fn(async () => ({html: ""}) as unknown as GatekeeperUiFrame),
    reconnect: vi.fn(async () => ({url: "https://team-pi.example/reconnect"})),
    getVerifier: vi.fn(async () => ({})),
    revoke: vi.fn(async () => {}),
  };

  const record = {
    id: 7,
    vendorId: retiredVendorId,
    account: account as unknown as Fetcher<GatekeeperUser>,
    description: {
      displayName: "Team PI",
      uniqueName: "team-pi@example.test",
      avatar: {url: "https://team-pi.example/avatar.png"},
      singleton: {tsType: "TeamPiSession"},
      providesUi: {title: "Team PI"},
    },
    autoProvisioned: true,
  };

  const connectedAccounts = {
    get: vi.fn((accountId: number) => accountId === record.id ? record : undefined),
    put: vi.fn(),
    delete: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };

  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    env: {BLUEPRINTS: {get: vi.fn().mockResolvedValue(null)}},
    vendors: new Map(),
    storage: {
      connectedAccounts,
      nextAccountId: {get: vi.fn(() => 8), put: vi.fn()},
      cloudflareBilling: {put: vi.fn()},
    },
  });

  return {user, account, connectedAccounts};
}

describe("retired gatekeeper accounts", () => {
  it("does not mint old Team PI singleton, UI, or resource capabilities", async () => {
    const {user, account} = makeRetiredAccount();

    await expect(user.getSingletonGatekeeperClass(7)).resolves.toBeNull();
    await expect(user.startAccountAppUi(7, {isAdmin: false} as AppUiContext))
      .rejects.toThrow("No such app");
    await expect(user.getGatekeeperClassFor(7, "https://team-pi.example/resource"))
      .rejects.toThrow(/retired/);
    await expect(user.ensureAccountResources(7, ["https://team-pi.example/*"]))
      .rejects.toThrow(/retired/);
    await expect(user.startResourceConfigurator(7, "https://team-pi.example/*"))
      .rejects.toThrow(/retired/);
    await expect(user.reconnectAccount(7)).rejects.toThrow(/retired/);
    await expect(user.getVerifier(7, retiredVendorId)).resolves.toBeNull();
    await expect(user.describeConnectedAccount(7)).resolves.toBeNull();

    expect(account.getSingletonGatekeeperClass).not.toHaveBeenCalled();
    expect(account.startAppUi).not.toHaveBeenCalled();
    expect(account.getGatekeeperClassFor).not.toHaveBeenCalled();
    expect(account.ensureResources).not.toHaveBeenCalled();
    expect(account.startResourceConfigurator).not.toHaveBeenCalled();
    expect(account.reconnect).not.toHaveBeenCalled();
    expect(account.getVerifier).not.toHaveBeenCalled();
  });
});
