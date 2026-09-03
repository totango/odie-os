import { describe, expect, it, vi } from "vitest";
import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";

function makeUser(vendorId: string, revoke: () => Promise<void>) {
  const connectedAccounts = {
    get: (accountId: number) => accountId === 7
      ? {
          id: accountId,
          vendorId,
          account: {revoke} as Fetcher<GatekeeperUser>,
        }
      : undefined,
    delete: vi.fn(),
  };
  const cloudflareBilling = {put: vi.fn()};
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {storage: {connectedAccounts, cloudflareBilling}});
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
});
