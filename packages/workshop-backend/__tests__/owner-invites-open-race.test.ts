import { expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES } from "@gadgets/workshop-shared/api";

it.each([false, true])("rechecks ownerInvitesOnly while observer verification awaits (direct=%s)",
    async direct => {
  await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    const impl = Reflect.get(instance, "impl");
    const ownerId = "owner-user-id", profileId = "indirect-user";
    impl.ownerId = ownerId;
    impl.storage.ownerId.put(ownerId);
    impl.ownerProfileId = "owner-profile";
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    impl.scheduleAccessRestart = async () => {};
    impl.tearDownLostObservers = async () => {};
    impl.users = {idFromString: (id: string) => id,
      get: (id: string) => id === ownerId
        ? {getGadget: async () => ({id: impl.ctx.id.toString(), title: "Workspace"}),
          whoami: async () => ({type: "user", id: "owner-profile", name: "Owner"})}
        : {whoami: async () => ({type: "user", id: profileId, name: "Collaborator"}),
          hasPasswordLogin: async () => false, recordSharedGadgetOpen: async () => {}},
    };
    impl.storage.collaborators.put({profile: {type: "user", id: profileId, name: "Collaborator"},
      addedBy: [{type: "user", sharer: direct ? "owner-profile" : "intermediate",
        role: "build", created: new Date()}]});
    if (!direct) impl.storage.collaborators.put({
      profile: {type: "user", id: "intermediate", name: "Intermediate"},
      addedBy: [{type: "user", sharer: "owner-profile", role: "build", created: new Date()}],
    });
    const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    impl.ensureObserver = async () => {
      reached.resolve();
      await release.promise;
      // Reproduce a verification that completes after the policy latch's cleanup.
      impl.storage.observers.put({profileId, observerId: "late", accountChoices: {}});
    };
    const pending = instance.open(profileId, profileId, new NativeRpcStub<() => void>(() => {}));
    await reached.promise;
    await impl.authorizeObservation(1, {title: "Private", description: "Private",
      ownerInvitesOnly: true}, {from: "user"});
    release.resolve();
    if (direct) {
      const opened = await pending;
      expect((await opened.getMetadata()).role).toBe("build");
      opened[Symbol.dispose]();
    } else {
      let error: unknown;
      try { await pending; } catch (caught) { error = caught; }
      expect(getOpenGadgetErrorCode(error)).toBe(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
      expect(impl.storage.observers.get(profileId)).toBeUndefined();
    }
  });
});
