import { describe, expect, it, vi } from "vitest";
import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";

function makeUser(
    vendorId: string,
    revoke: () => Promise<void>,
    options: {autoProvisioned?: boolean; mode?: "disabled" | "enabled" | "optional"} = {}) {
  const connectedAccounts = {
    get: (accountId: number) => accountId === 7
      ? {
          id: accountId,
          vendorId,
          account: {revoke} as Fetcher<GatekeeperUser>,
          autoProvisioned: options.autoProvisioned,
        }
      : undefined,
    delete: vi.fn(),
  };
  const cloudflareBilling = {put: vi.fn()};
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  const storedConfig = options.mode
    ? JSON.stringify({ambientGatekeeperModes: {[vendorId]: options.mode}})
    : null;
  Object.assign(user, {
    env: {BLUEPRINTS: {get: vi.fn().mockResolvedValue(storedConfig)}},
    storage: {connectedAccounts, cloudflareBilling},
  });
  return {user, connectedAccounts, cloudflareBilling};
}

describe("UserDurableObject.disconnectAccount", () => {
  it("removes the local account when provider revocation fails", async () => {
    const {user, connectedAccounts} = makeUser(
        "notion", async () => { throw new Error("provider unavailable"); });

    await expect(user.disconnectAccount(7)).resolves.toBeUndefined();

    expect(connectedAccounts.delete).toHaveBeenCalledWith(7);
  });

  it("clears Cloudflare billing state when provider revocation fails", async () => {
    const {user, connectedAccounts, cloudflareBilling} = makeUser(
        "cloudflare", async () => { throw new Error("provider unavailable"); });

    await expect(user.disconnectAccount(7)).resolves.toBeUndefined();

    expect(connectedAccounts.delete).toHaveBeenCalledWith(7);
    expect(cloudflareBilling.put).toHaveBeenCalledWith(null);
  });

  it("preserves a disabled auto-provisioned account as dormant", async () => {
    const revoke = vi.fn(async () => {});
    const {user, connectedAccounts} = makeUser(
        "context", revoke, {autoProvisioned: true, mode: "disabled"});

    await expect(user.disconnectAccount(7)).rejects.toThrow(/managed automatically/);

    expect(revoke).not.toHaveBeenCalled();
    expect(connectedAccounts.delete).not.toHaveBeenCalled();
  });

  it("preserves an enabled auto-provisioned account", async () => {
    const revoke = vi.fn(async () => {});
    const {user, connectedAccounts} = makeUser(
        "context", revoke, {autoProvisioned: true, mode: "enabled"});

    await expect(user.disconnectAccount(7)).rejects.toThrow(/managed automatically/);

    expect(revoke).not.toHaveBeenCalled();
    expect(connectedAccounts.delete).not.toHaveBeenCalled();
  });

  it("allows removal of an optional auto-provisioned account", async () => {
    const revoke = vi.fn(async () => {});
    const {user, connectedAccounts} = makeUser(
        "context", revoke, {autoProvisioned: true, mode: "optional"});

    await expect(user.disconnectAccount(7)).resolves.toBeUndefined();

    expect(revoke).toHaveBeenCalledOnce();
    expect(connectedAccounts.delete).toHaveBeenCalledWith(7);
  });

  it("removes an optional auto-provisioned account when provider cleanup fails", async () => {
    const revoke = vi.fn(async () => { throw new Error("provider unavailable"); });
    const {user, connectedAccounts} = makeUser(
        "context", revoke, {autoProvisioned: true, mode: "optional"});

    await expect(user.disconnectAccount(7)).resolves.toBeUndefined();

    expect(connectedAccounts.delete).toHaveBeenCalledWith(7);
  });
});
