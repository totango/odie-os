import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  FINANCE_OPERATIONS_WORKBENCH_BLUEPRINT_ID,
  isFinanceOperationsWorkbenchBlueprintId,
  type AiChatAuthorInfo,
  type BlueprintUserSummary,
} from "@gadgets/workshop-shared/api";
import type { ObservationDomainSharingPolicy } from "@gadgets/workshop-shared/gatekeeper";
import {
  assertBlueprintOriginAllowed,
  readFinanceHubStatus,
  resolveFinanceHubStatus,
  runBlueprintWorkspaceCreation,
  visibleOwnBlueprint,
  visibleOwnBlueprints,
} from "../src/server.js";
import {
  assertCollaboratorInviteAllowed,
  assertShareLinkAllowedByDomainSharingPolicy,
  assertShareLinksAllowed,
  effectiveCollaboratorRole,
  isProfileAllowedByDomainSharingPolicy,
  type OverseerDurableObject,
} from "../src/overseer.js";
import type { AdminSettings, FinanceWorkspaceClaim } from "../src/admin-settings.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ADMIN: DurableObjectNamespace<AdminSettings>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);
const FINANCE_BLUEPRINT_CODE = (() => {
  let doc = new Y.Doc();
  let text = new Y.Text();
  text.insert(0, "export default {};");
  doc.getMap<Y.Text>().set("server.js", text);
  return Y.encodeStateAsUpdateV2(doc);
})();
const TOTANGO_POLICY: ObservationDomainSharingPolicy = {
  type: "verified-sso-email-domain",
  emailDomain: "totango.com",
};

function username(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}@example.com`;
}

async function createUser(prefix: string) {
  let profileId = username(prefix);
  let id = env.TEST_USER.idFromName(profileId);
  let user = env.TEST_USER.get(id);
  await user.createAccount(profileId, prefix, PASSWORD_HASH);
  return {id, profileId, user};
}

async function createSsoUser(email: string) {
  let id = env.TEST_USER.idFromName(email);
  let user = env.TEST_USER.get(id);
  await user.authenticateFromCfAccess(email, true);
  return {id, profileId: email, user};
}

async function clearFinanceClaim(): Promise<void> {
  let admin = env.TEST_ADMIN.getByName("");
  let existing = await admin.getFinanceWorkspaceClaim();
  if (existing) await admin.releaseFinanceWorkspace(existing);
}

async function expectOpenDenied(open: () => PromiseLike<unknown>): Promise<void> {
  let denied = false;
  try {
    await open();
  } catch {
    denied = true;
  }
  expect(denied).toBe(true);
}

function blueprintSummary(id: string): BlueprintUserSummary {
  return {
    id,
    title: id,
    description: "",
    source: {type: "imported"},
    version: 1,
    lastUpdated: new Date("2026-08-26T00:00:00Z"),
  };
}

describe("Finance hub access policy", () => {
  beforeEach(clearFinanceClaim);

  it("fails closed and grants bootstrap only before an admin claim", () => {
    expect(resolveFinanceHubStatus(null, false, false)).toEqual({
      authorized: false,
      canCreate: false,
    });
    expect(resolveFinanceHubStatus("finance-workspace", true, false)).toEqual({
      authorized: true,
      workspaceId: "finance-workspace",
      canCreate: false,
    });
    expect(resolveFinanceHubStatus("finance-workspace", false, true)).toEqual({
      authorized: false,
      canCreate: false,
    });
    expect(resolveFinanceHubStatus(null, false, true)).toEqual({
      authorized: true,
      canCreate: true,
    });
  });

  it("offers bootstrap through live status only to an admin when no singleton exists", async () => {
    expect(await readFinanceHubStatus(
        env.TEST_ADMIN, env.TEST_OVERSEER, "user-id", "user@example.com", false)).toEqual({
      authorized: false,
      canCreate: false,
    });
    expect(await readFinanceHubStatus(
        env.TEST_ADMIN, env.TEST_OVERSEER, "admin-id", "admin@example.com", true)).toEqual({
      authorized: true,
      canCreate: true,
    });
  });

  it("atomically permits one deployment claim and only idempotent exact retries", async () => {
    let admin = env.TEST_ADMIN.getByName("");
    let first: FinanceWorkspaceClaim = {
      workspaceId: env.TEST_OVERSEER.newUniqueId().toString(),
      ownerUserId: "owner-a",
      ownerProfileId: "owner-a@example.com",
    };
    let second: FinanceWorkspaceClaim = {
      workspaceId: env.TEST_OVERSEER.newUniqueId().toString(),
      ownerUserId: "owner-b",
      ownerProfileId: "owner-b@example.com",
    };

    let results = await Promise.all([
      admin.claimFinanceWorkspace(first),
      admin.claimFinanceWorkspace(second),
    ]);
    expect(results.toSorted()).toEqual(["claimed", "conflict"]);

    let stored = await admin.getFinanceWorkspaceClaim();
    expect(stored === null).toBe(false);
    let winner = stored!.workspaceId === first.workspaceId ? first : second;
    let loser = winner === first ? second : first;
    expect(await admin.claimFinanceWorkspace(winner)).toBe("existing");
    expect(await admin.claimFinanceWorkspace({...winner, ownerProfileId: "different"}))
        .toBe("conflict");
    expect(await admin.claimFinanceWorkspace(loser)).toBe("conflict");
    expect(await admin.releaseFinanceWorkspace(loser)).toBe(false);
    expect(await admin.getFinanceWorkspaceClaim()).toEqual(winner);
    expect(await admin.releaseFinanceWorkspace(winner)).toBe(true);
  });

  it("fails closed without replacing a corrupt singleton claim", async () => {
    let admin = env.TEST_ADMIN.getByName("");
    let claim: FinanceWorkspaceClaim = {
      workspaceId: "not-a-durable-object-id",
      ownerUserId: "missing-owner",
      ownerProfileId: "missing-owner@example.com",
    };
    expect(await admin.claimFinanceWorkspace(claim)).toBe("claimed");
    expect(await readFinanceHubStatus(
        env.TEST_ADMIN, env.TEST_OVERSEER,
        claim.ownerUserId, claim.ownerProfileId, true)).toEqual({
      authorized: false,
      canCreate: false,
    });
    expect(await admin.getFinanceWorkspaceClaim()).toEqual(claim);
    expect(await admin.claimFinanceWorkspace({...claim, workspaceId: "replacement"}))
        .toBe("conflict");
    await admin.releaseFinanceWorkspace(claim);
  });

  it("validates owner and collaborator access live and denies a revoked stale listing", async () => {
    let owner = await createUser("finance-owner");
    let collaborator = await createUser("finance-collaborator");
    let secondAdmin = await createUser("finance-second-admin");
    let workspaceId = env.TEST_OVERSEER.newUniqueId();
    let workspaceIdString = workspaceId.toString();
    let claim: FinanceWorkspaceClaim = {
      workspaceId: workspaceIdString,
      ownerUserId: owner.id.toString(),
      ownerProfileId: owner.profileId,
    };
    let admin = env.TEST_ADMIN.getByName("");
    expect(await admin.claimFinanceWorkspace(claim)).toBe("claimed");
    await owner.user.registerFinanceGadget(workspaceIdString, "Finance Operations Workbench");

    let workspace = env.TEST_OVERSEER.get(workspaceId);
    let session = await workspace.open(
        owner.id.toString(), owner.profileId, () => {});

    try {
      expect(await readFinanceHubStatus(
          env.TEST_ADMIN, env.TEST_OVERSEER,
          owner.id.toString(), owner.profileId, true)).toEqual({
        authorized: true,
        workspaceId: workspaceIdString,
        canCreate: false,
      });

      await session.addCollaborator(collaborator.profileId, "use");
      let collaboratorSession = await workspace.open(
          collaborator.id.toString(), collaborator.profileId, () => {});
      collaboratorSession[Symbol.dispose]();
      expect(await readFinanceHubStatus(
          env.TEST_ADMIN, env.TEST_OVERSEER,
          collaborator.id.toString(), collaborator.profileId, false)).toEqual({
        authorized: true,
        workspaceId: workspaceIdString,
        canCreate: false,
      });

      expect(await readFinanceHubStatus(
          env.TEST_ADMIN, env.TEST_OVERSEER,
          secondAdmin.id.toString(), secondAdmin.profileId, true)).toEqual({
        authorized: true,
        workspaceId: workspaceIdString,
        canCreate: false,
      });
      let secondAdminSession = await workspace.open(
          secondAdmin.id.toString(), secondAdmin.profileId, () => {}, undefined, undefined, true);
      secondAdminSession[Symbol.dispose]();
      expect(await admin.claimFinanceWorkspace({
        workspaceId: env.TEST_OVERSEER.newUniqueId().toString(),
        ownerUserId: secondAdmin.id.toString(),
        ownerProfileId: secondAdmin.profileId,
      })).toBe("conflict");

      await session.removeCollaborator(collaborator.profileId, []);
      await expectOpenDenied(() => workspace.open(
          collaborator.id.toString(), collaborator.profileId, () => {}));
      let ownerProfile: AiChatAuthorInfo = {
        type: "user",
        id: owner.profileId,
        name: "finance-owner",
      };
      await collaborator.user.recordSharedGadgetOpen(
          workspaceIdString, "Finance Operations Workbench", ownerProfile, "use", "finance");
      expect(await collaborator.user.getGadget(workspaceIdString)).not.toBeNull();
      expect(await readFinanceHubStatus(
          env.TEST_ADMIN, env.TEST_OVERSEER,
          collaborator.id.toString(), collaborator.profileId, false)).toEqual({
        authorized: false,
        canCreate: false,
      });
    } finally {
      session[Symbol.dispose]();
      await admin.releaseFinanceWorkspace(claim);
      await owner.user.deleteGadget(workspaceIdString);
    }
  });

  it("rolls back a failed Finance initialization, disposes its stub, and permits retry", async () => {
    let owner = await createUser("finance-failed");
    let workspaceId = env.TEST_OVERSEER.newUniqueId().toString();
    let claim: FinanceWorkspaceClaim = {
      workspaceId,
      ownerUserId: owner.id.toString(),
      ownerProfileId: owner.profileId,
    };
    let admin = env.TEST_ADMIN.getByName("");
    let disposed = false;

    await expect(runBlueprintWorkspaceCreation({
      claim: () => admin.claimFinanceWorkspace(claim),
      register: () => owner.user.registerFinanceGadget(
          workspaceId, "Finance Operations Workbench"),
      open: async () => ({[Symbol.dispose]() { disposed = true; }}),
      finish: async () => { throw new Error("initialization failed"); },
      rollbackRegistration: () => owner.user.deleteGadget(workspaceId),
      releaseClaim: () => admin.releaseFinanceWorkspace(claim),
    })).rejects.toThrow("initialization failed");

    expect(disposed).toBe(true);
    expect(await owner.user.getGadget(workspaceId)).toBeNull();
    expect(await admin.getFinanceWorkspaceClaim()).toBeNull();
    expect(await admin.claimFinanceWorkspace(claim)).toBe("claimed");
    await admin.releaseFinanceWorkspace(claim);
  });

  it("retains the singleton and owner record after successful Finance creation", async () => {
    let owner = await createUser("finance-success");
    let workspaceId = env.TEST_OVERSEER.newUniqueId().toString();
    let claim: FinanceWorkspaceClaim = {
      workspaceId,
      ownerUserId: owner.id.toString(),
      ownerProfileId: owner.profileId,
    };
    let admin = env.TEST_ADMIN.getByName("");
    let disposed = false;

    let opened = await runBlueprintWorkspaceCreation({
      claim: () => admin.claimFinanceWorkspace(claim),
      register: () => owner.user.registerFinanceGadget(
          workspaceId, "Finance Operations Workbench"),
      open: async () => ({[Symbol.dispose]() { disposed = true; }}),
      finish: async () => {},
      rollbackRegistration: () => owner.user.deleteGadget(workspaceId),
      releaseClaim: () => admin.releaseFinanceWorkspace(claim),
    });

    expect(disposed).toBe(false);
    expect(await admin.getFinanceWorkspaceClaim()).toEqual(claim);
    expect(await owner.user.getGadget(workspaceId)).toEqual(
        expect.objectContaining({id: workspaceId, originHubId: "finance"}));
    opened[Symbol.dispose]();
    await owner.user.deleteGadget(workspaceId);
    await admin.releaseFinanceWorkspace(claim);
  });

  it("does not roll back a successful claim or registration during an exact replay failure", async () => {
    let owner = await createUser("finance-replay");
    let workspaceId = env.TEST_OVERSEER.newUniqueId().toString();
    let claim: FinanceWorkspaceClaim = {
      workspaceId,
      ownerUserId: owner.id.toString(),
      ownerProfileId: owner.profileId,
    };
    let admin = env.TEST_ADMIN.getByName("");
    let creationOps = {
      claim: () => admin.claimFinanceWorkspace(claim),
      register: () => owner.user.registerFinanceGadget(
          workspaceId, "Finance Operations Workbench"),
      open: async () => ({[Symbol.dispose]() {}}),
      rollbackRegistration: () => owner.user.deleteGadget(workspaceId),
      releaseClaim: () => admin.releaseFinanceWorkspace(claim),
    };

    let opened = await runBlueprintWorkspaceCreation({...creationOps, finish: async () => {}});
    opened[Symbol.dispose]();
    await expect(runBlueprintWorkspaceCreation({
      ...creationOps,
      finish: async () => { throw new Error("replayed step failed"); },
    })).rejects.toThrow("replayed step failed");

    expect(await admin.getFinanceWorkspaceClaim()).toEqual(claim);
    expect(await owner.user.getGadget(workspaceId)).toEqual(expect.objectContaining({
      id: workspaceId,
      title: "Finance Operations Workbench",
      originHubId: "finance",
    }));
    await owner.user.deleteGadget(workspaceId);
    await admin.releaseFinanceWorkspace(claim);
  });

  it("preserves a registration repaired beneath an existing exact claim", async () => {
    let owner = await createUser("finance-repaired-registration");
    let workspaceId = env.TEST_OVERSEER.newUniqueId().toString();
    let claim: FinanceWorkspaceClaim = {
      workspaceId,
      ownerUserId: owner.id.toString(),
      ownerProfileId: owner.profileId,
    };
    let admin = env.TEST_ADMIN.getByName("");
    expect(await admin.claimFinanceWorkspace(claim)).toBe("claimed");
    expect(await owner.user.getGadget(workspaceId)).toBeNull();
    let creationOps = {
      claim: () => admin.claimFinanceWorkspace(claim),
      register: () => owner.user.registerFinanceGadget(
          workspaceId, "Finance Operations Workbench"),
      open: async () => ({[Symbol.dispose]() {}}),
      rollbackRegistration: () => owner.user.deleteGadget(workspaceId),
      releaseClaim: () => admin.releaseFinanceWorkspace(claim),
    };

    await expect(runBlueprintWorkspaceCreation({
      ...creationOps,
      finish: async () => { throw new Error("repair finish failed"); },
    })).rejects.toThrow("repair finish failed");

    expect(await admin.getFinanceWorkspaceClaim()).toEqual(claim);
    expect(await owner.user.getGadget(workspaceId)).toEqual(expect.objectContaining({
      id: workspaceId,
      title: "Finance Operations Workbench",
      originHubId: "finance",
    }));
    expect(await admin.claimFinanceWorkspace({...claim, workspaceId: "replacement"}))
        .toBe("conflict");

    let opened = await runBlueprintWorkspaceCreation({...creationOps, finish: async () => {}});
    opened[Symbol.dispose]();
    expect(await admin.getFinanceWorkspaceClaim()).toEqual(claim);
    expect(await owner.user.getGadget(workspaceId)).not.toBeNull();
    await owner.user.deleteGadget(workspaceId);
    await admin.releaseFinanceWorkspace(claim);
  });

  it("denies an initialized Finance DO after fresh creation rollback removes its owner record", async () => {
    let owner = await createUser("finance-initialized-rollback");
    let workspaceId = env.TEST_OVERSEER.newUniqueId();
    let workspaceIdString = workspaceId.toString();
    let claim: FinanceWorkspaceClaim = {
      workspaceId: workspaceIdString,
      ownerUserId: owner.id.toString(),
      ownerProfileId: owner.profileId,
    };
    let admin = env.TEST_ADMIN.getByName("");
    let workspace = env.TEST_OVERSEER.get(workspaceId);

    await expect(runBlueprintWorkspaceCreation({
      claim: () => admin.claimFinanceWorkspace(claim),
      register: () => owner.user.registerFinanceGadget(
          workspaceIdString, "Finance Operations Workbench"),
      open: async () => await workspace.open(owner.id.toString(), owner.profileId, () => {}),
      finish: async () => { throw new Error("post-open initialization failed"); },
      rollbackRegistration: () => owner.user.deleteGadget(workspaceIdString),
      releaseClaim: () => admin.releaseFinanceWorkspace(claim),
    })).rejects.toThrow("post-open initialization failed");

    expect(await admin.getFinanceWorkspaceClaim()).toBeNull();
    expect(await owner.user.getGadget(workspaceIdString)).toBeNull();
    await expectOpenDenied(
        () => workspace.open(owner.id.toString(), owner.profileId, () => {}));
  });

  it("denies an initialized ordinary workspace after its owner record is removed", async () => {
    let owner = await createUser("ordinary-orphan");
    let workspaceId = env.TEST_OVERSEER.newUniqueId();
    let workspaceIdString = workspaceId.toString();
    await owner.user.newGadget(workspaceIdString, "Ordinary workspace", "ops");
    let workspace = env.TEST_OVERSEER.get(workspaceId);
    let session = await workspace.open(owner.id.toString(), owner.profileId, () => {});
    session[Symbol.dispose]();
    await owner.user.deleteGadget(workspaceIdString);

    await expectOpenDenied(
        () => workspace.open(owner.id.toString(), owner.profileId, () => {}));
  });

  it("fails direct Finance opens closed for missing or corrupt owner metadata", async () => {
    let owner = await createUser("finance-corrupt-owner");
    let workspaceId = env.TEST_OVERSEER.newUniqueId();
    let workspaceIdString = workspaceId.toString();
    let claim: FinanceWorkspaceClaim = {
      workspaceId: workspaceIdString,
      ownerUserId: owner.id.toString(),
      ownerProfileId: owner.profileId,
    };
    let admin = env.TEST_ADMIN.getByName("");
    await admin.claimFinanceWorkspace(claim);
    await owner.user.registerFinanceGadget(workspaceIdString, "Finance Operations Workbench");
    let workspace = env.TEST_OVERSEER.get(workspaceId);
    let session = await workspace.open(owner.id.toString(), owner.profileId, () => {});
    session[Symbol.dispose]();

    await owner.user.deleteGadget(workspaceIdString);
    await expectOpenDenied(
        () => workspace.open(owner.id.toString(), owner.profileId, () => {}));
    await owner.user.newGadget(workspaceIdString, "Corrupt", "support");
    await expectOpenDenied(
        () => workspace.open(owner.id.toString(), owner.profileId, () => {}));

    await owner.user.deleteGadget(workspaceIdString);
    await admin.releaseFinanceWorkspace(claim);
  });

  it("denies stale share keys after an ordinary workspace becomes the claimed Finance workspace", async () => {
    let owner = await createUser("finance-stale-key-owner");
    let collaborator = await createUser("finance-stale-key-collaborator");
    let workspaceId = env.TEST_OVERSEER.newUniqueId();
    let workspaceIdString = workspaceId.toString();
    await owner.user.newGadget(workspaceIdString, "Finance Operations Workbench");
    let workspace = env.TEST_OVERSEER.get(workspaceId);
    let ordinarySession = await workspace.open(owner.id.toString(), owner.profileId, () => {});
    let {key} = await ordinarySession.createShareLink("use");
    await owner.user.updateProvisionalWorkspaceOrigin(workspaceIdString, "finance");
    let claim: FinanceWorkspaceClaim = {
      workspaceId: workspaceIdString,
      ownerUserId: owner.id.toString(),
      ownerProfileId: owner.profileId,
    };
    let admin = env.TEST_ADMIN.getByName("");
    await admin.claimFinanceWorkspace(claim);

    await expectOpenDenied(() => workspace.open(
        collaborator.id.toString(), collaborator.profileId, () => {}, key));
    await expectOpenDenied(() => workspace.open(
        owner.id.toString(), owner.profileId, () => {}, key));

    ordinarySession[Symbol.dispose]();
    await owner.user.deleteGadget(workspaceIdString);
    await admin.releaseFinanceWorkspace(claim);
  });

  it("denies an orphan Finance-origin workspace with no deployment claim", async () => {
    let owner = await createUser("finance-orphan");
    let workspaceId = env.TEST_OVERSEER.newUniqueId();
    await owner.user.registerFinanceGadget(
        workspaceId.toString(), "Finance Operations Workbench");

    await expectOpenDenied(() => env.TEST_OVERSEER.get(workspaceId).open(
        owner.id.toString(), owner.profileId, () => {}));
    await owner.user.deleteGadget(workspaceId.toString());
  });

  it("repairs a missing Finance origin and is idempotent", async () => {
    let owner = await createUser("finance-repair-origin");
    let workspaceId = env.TEST_OVERSEER.newUniqueId();
    let workspaceIdString = workspaceId.toString();
    await owner.user.newGadget(workspaceIdString, "Existing title");
    let session = await env.TEST_OVERSEER.get(workspaceId).open(
        owner.id.toString(), owner.profileId, () => {});
    session[Symbol.dispose]();
    await env.TEST_OVERSEER.get(workspaceId).initializeFromBlueprint(
        FINANCE_BLUEPRINT_CODE, "Finance Operations Workbench");
    let claim: FinanceWorkspaceClaim = {
      workspaceId: workspaceIdString,
      ownerUserId: owner.id.toString(),
      ownerProfileId: owner.profileId,
    };
    let admin = env.TEST_ADMIN.getByName("");
    await admin.claimFinanceWorkspace(claim);

    expect(await admin.diagnoseFinanceHub()).toEqual({
      status: "repairable", repair: "missing-finance-origin",
    });
    expect(await admin.repairFinanceHub()).toEqual({
      repaired: true, diagnostic: {status: "healthy"},
    });
    expect(await owner.user.getGadget(workspaceIdString)).toEqual(expect.objectContaining({
      title: "Existing title", originHubId: "finance",
    }));
    expect(await admin.repairFinanceHub()).toEqual({
      repaired: false, diagnostic: {status: "healthy"},
    });

    await owner.user.deleteGadget(workspaceIdString);
    await admin.releaseFinanceWorkspace(claim);
  });

  it("repairs only a missing owner registration for a validated initialized workspace", async () => {
    let owner = await createUser("finance-repair-registration");
    let workspaceId = env.TEST_OVERSEER.newUniqueId();
    let workspaceIdString = workspaceId.toString();
    await owner.user.newGadget(workspaceIdString, "Original");
    let session = await env.TEST_OVERSEER.get(workspaceId).open(
        owner.id.toString(), owner.profileId, () => {});
    session[Symbol.dispose]();
    await env.TEST_OVERSEER.get(workspaceId).initializeFromBlueprint(
        FINANCE_BLUEPRINT_CODE, "Finance Operations Workbench");
    await owner.user.deleteGadget(workspaceIdString);
    let claim: FinanceWorkspaceClaim = {
      workspaceId: workspaceIdString,
      ownerUserId: owner.id.toString(),
      ownerProfileId: owner.profileId,
    };
    let admin = env.TEST_ADMIN.getByName("");
    await admin.claimFinanceWorkspace(claim);

    expect(await admin.diagnoseFinanceHub()).toEqual({
      status: "repairable", repair: "missing-owner-registration",
    });
    expect(await admin.repairFinanceHub()).toEqual({
      repaired: true, diagnostic: {status: "healthy"},
    });
    expect(await owner.user.getGadget(workspaceIdString)).toEqual(expect.objectContaining({
      title: "Finance Operations Workbench", originHubId: "finance",
    }));

    await owner.user.deleteGadget(workspaceIdString);
    await admin.releaseFinanceWorkspace(claim);
  });

  it("returns coarse refusals for missing and invalid claim identities", async () => {
    let admin = env.TEST_ADMIN.getByName("");
    expect(await admin.diagnoseFinanceHub()).toEqual({status: "unclaimed"});

    let missingProfileId = username("finance-missing-account");
    let missingClaim: FinanceWorkspaceClaim = {
      workspaceId: env.TEST_OVERSEER.newUniqueId().toString(),
      ownerUserId: env.TEST_USER.idFromName(missingProfileId).toString(),
      ownerProfileId: missingProfileId,
    };
    await admin.claimFinanceWorkspace(missingClaim);
    expect(await admin.repairFinanceHub()).toEqual({
      repaired: false,
      diagnostic: {status: "blocked", reason: "missing-owner-account"},
    });
    expect(JSON.stringify(await admin.diagnoseFinanceHub())).not.toContain(missingClaim.ownerUserId);
    await admin.releaseFinanceWorkspace(missingClaim);

    let invalidClaim = {...missingClaim, ownerUserId: env.TEST_USER.newUniqueId().toString()};
    await admin.claimFinanceWorkspace(invalidClaim);
    expect(await admin.diagnoseFinanceHub()).toEqual({
      status: "blocked", reason: "invalid-claim",
    });
    await admin.releaseFinanceWorkspace(invalidClaim);
  });

  it("does not repair an owner registration when first open left only the empty snapshot", async () => {
    let owner = await createUser("finance-incomplete-workspace");
    let workspaceId = env.TEST_OVERSEER.newUniqueId();
    let workspaceIdString = workspaceId.toString();
    await owner.user.newGadget(workspaceIdString, "Incomplete Finance workspace");
    let workspace = env.TEST_OVERSEER.get(workspaceId);
    let session = await workspace.open(owner.id.toString(), owner.profileId, () => {});
    session[Symbol.dispose]();
    let claim: FinanceWorkspaceClaim = {
      workspaceId: workspaceIdString,
      ownerUserId: owner.id.toString(),
      ownerProfileId: owner.profileId,
    };
    let admin = env.TEST_ADMIN.getByName("");
    await admin.claimFinanceWorkspace(claim);

    expect(await admin.diagnoseFinanceHub()).toEqual({
      status: "blocked", reason: "incomplete-workspace",
    });
    expect(await admin.repairFinanceHub()).toEqual({
      repaired: false,
      diagnostic: {status: "blocked", reason: "incomplete-workspace"},
    });
    expect((await owner.user.getGadget(workspaceIdString))?.originHubId).toBeUndefined();

    await owner.user.deleteGadget(workspaceIdString);
    await admin.releaseFinanceWorkspace(claim);
  });

  it("refuses uninitialized workspaces and initialized owner mismatches", async () => {
    let owner = await createUser("finance-uninitialized");
    let workspaceId = env.TEST_OVERSEER.newUniqueId();
    let claim: FinanceWorkspaceClaim = {
      workspaceId: workspaceId.toString(),
      ownerUserId: owner.id.toString(),
      ownerProfileId: owner.profileId,
    };
    let admin = env.TEST_ADMIN.getByName("");
    await admin.claimFinanceWorkspace(claim);
    expect(await admin.repairFinanceHub()).toEqual({
      repaired: false,
      diagnostic: {status: "blocked", reason: "uninitialized-workspace"},
    });
    await admin.releaseFinanceWorkspace(claim);

    let other = await createUser("finance-other-owner");
    await other.user.newGadget(workspaceId.toString(), "Other workspace");
    let session = await env.TEST_OVERSEER.get(workspaceId).open(
        other.id.toString(), other.profileId, () => {});
    session[Symbol.dispose]();
    await admin.claimFinanceWorkspace(claim);
    expect(await admin.diagnoseFinanceHub()).toEqual({
      status: "blocked", reason: "owner-mismatch",
    });
    await admin.releaseFinanceWorkspace(claim);
    await other.user.deleteGadget(workspaceId.toString());
  });

  it("refuses shared, explicit non-Finance, and duplicate owner registrations", async () => {
    let owner = await createUser("finance-conflicting-registration");
    let workspaceId = env.TEST_OVERSEER.newUniqueId();
    let workspaceIdString = workspaceId.toString();
    await owner.user.newGadget(workspaceIdString, "Target");
    let session = await env.TEST_OVERSEER.get(workspaceId).open(
        owner.id.toString(), owner.profileId, () => {});
    session[Symbol.dispose]();
    await env.TEST_OVERSEER.get(workspaceId).initializeFromBlueprint(
        FINANCE_BLUEPRINT_CODE, "Finance Operations Workbench");
    let claim: FinanceWorkspaceClaim = {
      workspaceId: workspaceIdString,
      ownerUserId: owner.id.toString(),
      ownerProfileId: owner.profileId,
    };
    let admin = env.TEST_ADMIN.getByName("");
    await admin.claimFinanceWorkspace(claim);

    await owner.user.deleteGadget(workspaceIdString);
    await owner.user.recordSharedGadgetOpen(workspaceIdString, "Shared", {
      type: "user", id: "other@example.com", name: "Other",
    });
    expect(await admin.diagnoseFinanceHub()).toEqual({
      status: "blocked", reason: "shared-registration",
    });

    await owner.user.deleteGadget(workspaceIdString);
    await owner.user.newGadget(workspaceIdString, "Support", "support");
    expect(await admin.repairFinanceHub()).toEqual({
      repaired: false,
      diagnostic: {status: "blocked", reason: "non-finance-origin"},
    });

    await owner.user.deleteGadget(workspaceIdString);
    await owner.user.registerFinanceGadget(
        env.TEST_OVERSEER.newUniqueId().toString(), "Finance Operations Workbench");
    expect(await admin.diagnoseFinanceHub()).toEqual({
      status: "blocked", reason: "duplicate-finance-registration",
    });

    await admin.releaseFinanceWorkspace(claim);
  });

  it("filters protected Finance records from owner blueprint reads", () => {
    let finance = blueprintSummary(FINANCE_OPERATIONS_WORKBENCH_BLUEPRINT_ID);
    let ordinary = blueprintSummary("starter.ordinary");

    expect(visibleOwnBlueprints([finance, ordinary])).toEqual([ordinary]);
    expect(visibleOwnBlueprint(finance)).toBeNull();
    expect(visibleOwnBlueprint(ordinary)).toBe(ordinary);
  });

  it("leaves ordinary blueprint creation outside the Finance claim lifecycle", async () => {
    let owner = await createUser("ordinary-blueprint");
    let workspaceId = env.TEST_OVERSEER.newUniqueId().toString();
    let opened = await runBlueprintWorkspaceCreation({
      register: () => owner.user.newGadget(workspaceId, "Support", "support"),
      open: async () => ({[Symbol.dispose]() {}}),
      finish: async () => {},
    });

    expect(await owner.user.getGadget(workspaceId)).toEqual(
        expect.objectContaining({id: workspaceId, originHubId: "support"}));
    expect(await env.TEST_ADMIN.getByName("").getFinanceWorkspaceClaim()).toBeNull();
    opened[Symbol.dispose]();
    await owner.user.deleteGadget(workspaceId);
  });

  it("disposes an opened ordinary blueprint workspace when later initialization fails", async () => {
    let owner = await createUser("ordinary-failed");
    let workspaceId = env.TEST_OVERSEER.newUniqueId().toString();
    let disposed = false;
    await expect(runBlueprintWorkspaceCreation({
      register: () => owner.user.newGadget(workspaceId, "Support", "support"),
      open: async () => ({[Symbol.dispose]() { disposed = true; }}),
      finish: async () => { throw new Error("binding failed"); },
    })).rejects.toThrow("binding failed");

    expect(disposed).toBe(true);
    expect(await owner.user.getGadget(workspaceId)).not.toBeNull();
    expect(await env.TEST_ADMIN.getByName("").getFinanceWorkspaceClaim()).toBeNull();
    await owner.user.deleteGadget(workspaceId);
  });

  it("allows only an admin Finance bootstrap with the protected blueprint-origin pair", () => {
    expect(assertBlueprintOriginAllowed(
      FINANCE_OPERATIONS_WORKBENCH_BLUEPRINT_ID,
      "finance",
      true,
    )).toBe(true);
    expect(() => assertBlueprintOriginAllowed(
      FINANCE_OPERATIONS_WORKBENCH_BLUEPRINT_ID,
      "finance",
      false,
    )).toThrow(/not found/i);
    expect(() => assertBlueprintOriginAllowed(
      FINANCE_OPERATIONS_WORKBENCH_BLUEPRINT_ID,
      "ops",
      true,
    )).toThrow(/not found/i);
    expect(() => assertBlueprintOriginAllowed(
      FINANCE_OPERATIONS_WORKBENCH_BLUEPRINT_ID,
      undefined,
      true,
    )).toThrow(/not found/i);
  });

  it("rejects Finance origins for ordinary blueprints and preserves ordinary creation", () => {
    expect(() => assertBlueprintOriginAllowed("starter.ordinary", "finance", true))
        .toThrow(/only the Finance Operations Workbench/i);
    expect(assertBlueprintOriginAllowed("starter.ordinary", "support", false)).toBe(false);
    expect(assertBlueprintOriginAllowed("starter.ordinary", undefined, false)).toBe(false);
  });

  it("recognizes only the exact protected blueprint id", () => {
    expect(isFinanceOperationsWorkbenchBlueprintId(
      FINANCE_OPERATIONS_WORKBENCH_BLUEPRINT_ID,
    )).toBe(true);
    expect(isFinanceOperationsWorkbenchBlueprintId("starter.finance-copy")).toBe(false);
  });

  it("keeps ordinary sharing unchanged and makes Finance direct-invite, use-only", () => {
    expect(effectiveCollaboratorRole("support", "build")).toBe("build");
    expect(effectiveCollaboratorRole("finance", "build")).toBe("use");
    expect(() => assertCollaboratorInviteAllowed(true, true, "use")).not.toThrow();
    expect(() => assertCollaboratorInviteAllowed(true, true, "build"))
        .toThrow(/Gadget-only/);
    expect(() => assertCollaboratorInviteAllowed(true, false, "use"))
        .toThrow(/owner/);
    expect(() => assertShareLinksAllowed(true)).toThrow(/invite-only/);
    expect(() => assertCollaboratorInviteAllowed(false, false, "build")).not.toThrow();
    expect(() => assertShareLinksAllowed(false)).not.toThrow();
  });
});

describe("organization-scoped observation sharing policy", () => {
  it("admits only verified SSO identities in the configured email domain", async () => {
    let ssoTotango = await createSsoUser(`verified-${crypto.randomUUID()}@totango.com`);
    let ssoExternal = await createSsoUser(`verified-${crypto.randomUUID()}@example.com`);
    let passwordTotango = await createUser("password-totango");
    let passwordProfileId = passwordTotango.profileId.replace("@example.com", "@totango.com");

    expect(await isProfileAllowedByDomainSharingPolicy(
        ssoTotango.profileId, () => ssoTotango.user.hasPasswordLogin(), TOTANGO_POLICY)).toBe(true);
    expect(await isProfileAllowedByDomainSharingPolicy(
        ssoExternal.profileId, () => ssoExternal.user.hasPasswordLogin(), TOTANGO_POLICY)).toBe(false);
    expect(await isProfileAllowedByDomainSharingPolicy(
        passwordProfileId, () => passwordTotango.user.hasPasswordLogin(), TOTANGO_POLICY)).toBe(false);
  });

  it("allows direct Totango SSO invites but denies outsiders, password users, and share links", async () => {
    let ssoTotango = await createSsoUser(`invite-${crypto.randomUUID()}@totango.com`);
    let ssoExternal = await createSsoUser(`invite-${crypto.randomUUID()}@example.com`);
    let passwordTotango = await createUser("invite-password");

    await expect(isProfileAllowedByDomainSharingPolicy(
        ssoTotango.profileId, () => ssoTotango.user.hasPasswordLogin(), TOTANGO_POLICY)).resolves.toBe(true);
    await expect(isProfileAllowedByDomainSharingPolicy(
        ssoExternal.profileId, () => ssoExternal.user.hasPasswordLogin(), TOTANGO_POLICY)).resolves.toBe(false);
    await expect(isProfileAllowedByDomainSharingPolicy(
        passwordTotango.profileId.replace("@example.com", "@totango.com"),
        () => passwordTotango.user.hasPasswordLogin(), TOTANGO_POLICY)).resolves.toBe(false);
    expect(() => assertShareLinkAllowedByDomainSharingPolicy(TOTANGO_POLICY))
        .toThrow(/does not support share links/);
    expect(() => assertShareLinkAllowedByDomainSharingPolicy(undefined)).not.toThrow();
  });
});
