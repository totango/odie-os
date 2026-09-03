import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

describe("workspace deletion recovery", () => {
  it("blocks blueprint publication and resumes a persisted deletion after eviction", async () => {
    let profileId = `deleting-${crypto.randomUUID()}@example.com`;
    let ownerId = env.TEST_USER.idFromName(profileId);
    let owner = env.TEST_USER.get(ownerId);
    await owner.createAccount(profileId, "Owner", new Uint8Array([1, 2, 3]));

    let workspaceId = env.TEST_OVERSEER.newUniqueId();
    let workspaceIdString = workspaceId.toString();
    await owner.newGadget(workspaceIdString, "Deleting workspace", "ops");
    let workspace = env.TEST_OVERSEER.get(workspaceId);
    let session = await workspace.open(ownerId.toString(), profileId, () => {});
    session[Symbol.dispose]();

    let mutationBlocked = await runInDurableObject(workspace, async (instance, state) => {
      state.storage.kv.put("workspaceDeletion", {
        ownerId: ownerId.toString(),
        reason: "user",
        startedAt: new Date(),
      });
      await state.storage.setAlarm(Date.now() + 60_000);
      let internal = instance as unknown as {
        impl: {withWorkspaceMutation<T>(operation: () => Promise<T>): Promise<T>};
      };
      try {
        await internal.impl.withWorkspaceMutation(async () => undefined);
        return false;
      } catch {
        return true;
      }
    });
    expect(mutationBlocked).toBe(true);
    expect(await owner.listBlueprints()).toEqual([]);

    await evictDurableObject(workspace);
    expect(await runDurableObjectAlarm(workspace)).toBe(true);
    expect(await owner.getGadget(workspaceIdString)).toBeNull();
    await runInDurableObject(workspace, async (_instance, state) => {
      expect(Array.from(await state.storage.kv.list())).toEqual([]);
    });
  }, 30_000);
});
