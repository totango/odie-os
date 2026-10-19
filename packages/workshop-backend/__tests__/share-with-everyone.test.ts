import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { AdminSettings } from "../src/admin-settings.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ADMIN: DurableObjectNamespace<AdminSettings>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

beforeAll(async () => {
  await env.TEST_USER.getByName(`sharing-warmup-${crypto.randomUUID()}`).whoamiIfExists();
}, 300_000);

describe("Share with everyone", () => {
  it("grants future signed-in accounts build access and revokes it on disable", async () => {
    const ownerName = `owner-${crypto.randomUUID()}@example.com`;
    const memberName = `member-${crypto.randomUUID()}@example.com`;
    const ownerId = env.TEST_USER.idFromName(ownerName);
    const memberId = env.TEST_USER.idFromName(memberName);
    const owner = env.TEST_USER.get(ownerId);
    const member = env.TEST_USER.get(memberId);
    await owner.createAccount(ownerName, "Owner", new Uint8Array([1, 2, 3]));
    await member.createAccount(memberName, "Member", new Uint8Array([1, 2, 3]));
    const workspaceId = env.TEST_OVERSEER.newUniqueId();
    const id = workspaceId.toString();
    await owner.newGadget(id, "Everyone workspace");
    const workspace = env.TEST_OVERSEER.get(workspaceId);
    using ownerSession = await workspace.open(ownerId.toString(), ownerName, () => {});

    await ownerSession.setSharedWithEveryone(true);
    expect((await ownerSession.getMetadata()).sharedWithEveryone).toBe(true);
    expect((await env.TEST_ADMIN.getByName("").listSharedWorkspaces())
      .some(entry => entry.id === id && entry.role === "build")).toBe(true);
    using memberSession = await workspace.open(memberId.toString(), memberName, () => {});
    expect((await memberSession.getMetadata()).role).toBe("build");
    await expect(memberSession.setSharedWithEveryone(false)).rejects.toThrow("Only the workspace owner");
    await ownerSession.setTitle("Renamed public workspace");
    expect((await env.TEST_ADMIN.getByName("").listSharedWorkspaces())
      .find(entry => entry.id === id)?.title).toBe("Renamed public workspace");

    await ownerSession.setSharedWithEveryone(false);
    expect((await ownerSession.getMetadata()).sharedWithEveryone).toBe(false);
    expect((await env.TEST_ADMIN.getByName("").listSharedWorkspaces())
      .some(entry => entry.id === id)).toBe(false);
    // Revocation deliberately aborts this object, invalidating already-issued capabilities.
    // Reacquire a fresh stub after that restart before checking the persisted authorization.
    await expect.poll(async () => {
      try {
        using session = await env.TEST_OVERSEER.get(workspaceId)
          .open(memberId.toString(), memberName, () => {});
        return "still authorized";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }).toBe("You don't have access to this workspace.");
  }, 45_000);
});
