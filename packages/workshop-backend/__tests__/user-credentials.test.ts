import { describe, expect, it, vi } from "vitest";
import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";

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
