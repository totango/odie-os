import { providerFixtureClaim, providerFixtureBaseline } from "./admin-authority-fixture";
import type { AdminAuthorization } from "@gadgets/workshop-shared/api";
import type { AdminProviderTestHooks, ContextCollectionDurableObject, UserLibraryDurableObject, LibraryRegistryDurableObject } from "./admin-authority-worker";
import { JarvisPolicy } from "../../gatekeeper-jarvis/src/policy";
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AdminAuthority, AdminAuthorityState, type AdminClaim } from "../src/admin-authority";
import { AdminApiImpl } from "../src/admin-settings";
import { PublicApiImpl, type AdminSettings, type OverseerDurableObject, type CommunityRequests } from "../src/server";
import type { UserDurableObject } from "../src/user";

declare global { namespace Cloudflare {
interface Env {
  CONTEXT_COLLECTIONS: KVNamespace;
  ARTIFACTS?: Artifacts;
  TEST_ADMIN: DurableObjectNamespace<AdminSettings>;
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  TEST_COMMUNITY_REQUESTS: DurableObjectNamespace<CommunityRequests>;
  TEST_CONTEXT_AUTHORIZATION: Service<AdminAuthorization>;
  TEST_JARVIS_AUTHORIZATION: Service<AdminAuthorization>;
  TEST_JARVIS_REGRANTED: Service<AdminAuthorization>;
  TEST_WRONG_EPOCH: Service<AdminAuthorization>;
  TEST_ADMIN_PROVIDERS: DurableObjectNamespace<AdminProviderTestHooks>;
  TEST_CONTEXT_COLLECTIONS: DurableObjectNamespace<ContextCollectionDurableObject>;
  TEST_USER_LIBRARIES: DurableObjectNamespace<UserLibraryDurableObject>;
  TEST_LIBRARY_REGISTRIES: DurableObjectNamespace<LibraryRegistryDurableObject>;
  TEST_JARVIS_POLICY: DurableObjectNamespace<JarvisPolicy>;
  TEST_AUTHORITY: DurableObjectNamespace<AdminAuthority>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
} } }
const seeds = ["authority_admin_one", "authority_admin_two", "authority_admin_three", "authority_admin_four"];
const authority = () => env.TEST_AUTHORITY.getByName("");
const principal = (name: string) => env.TEST_USER.idFromName(name).toString();
const mutation = (expectedRevision: number, mutationKey = crypto.randomUUID()) => ({expectedRevision, mutationKey});

// Only local fixture controls may establish eligible mode. This is not production legacy-drain evidence.
async function managedFixture() {
  return runInDurableObject(authority(), async (_instance, ctx) => {
    const controls = {oldReferences: 1, providersCurrent: false};
    const state = new AdminAuthorityState(ctx.storage, env.TEST_USER, {ADMINS: seeds}, async meta => {
      if (controls.oldReferences || !controls.providersCurrent) throw new Error("FIXTURE_NOT_READY");
      return {...meta, legacyDrained: true, providersCurrent: true, providerBaseline: providerFixtureBaseline};
    });
    const legacy = state.issue(principal(seeds[0]), seeds[0], "administration")!;
    const preview = await state.preview(legacy);
    await state.prepare(legacy, {...mutation(0), digest: preview.digest});
    await expect(state.activate(legacy, mutation(1))).rejects.toThrow("FIXTURE_NOT_READY");
    controls.oldReferences = 0; controls.providersCurrent = true;
    await state.activate(legacy, mutation(1));
    expect(() => state.assertCurrent(legacy)).toThrow("ADMIN_REVOKED");
    return seeds.map(name => state.issue(principal(name), name, "administration")!);
  });
}

beforeEach(async () => {
  await runInDurableObject(authority(), (_instance, ctx) => {
    Reflect.get(_instance, "env").ADMINS = [...seeds];
    for (const table of ["admin_audit", "admin_receipts", "admin_grants", "authority_meta"]) ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
    // Reconstruction exercises the real additive schema and durable metadata, not a fake store.
    expect(new AdminAuthorityState(ctx.storage, env.TEST_USER, {ADMINS: seeds}, async () => { throw new Error("TEST_NOT_READY"); })).toBeInstanceOf(AdminAuthorityState);
  });
  await Promise.all(seeds.map(name => env.TEST_USER.getByName(name).authenticateFromCfAccess(name, true)));
});

describe("AdminAuthority SQLite and live admission (real workerd)", () => {
  it("preserves all four exact configured principals, rejects fabricated/alias identity and scopes purpose", async () => {
    for (const name of seeds) expect(await authority().issue(principal(name), name, "administration")).not.toBeNull();
    expect(await authority().issue(principal(seeds[0]), seeds[1], "administration")).toBeNull();
    expect(await authority().issue(principal("alias@heyodie.ai"), "alias@heyodie.ai", "administration")).toBeNull();
    const retained = (await authority().issue(principal(seeds[0]), seeds[0], "administration"))!;
    await runInDurableObject(authority(), instance => { Reflect.get(instance, "env").ADMINS = seeds.slice(1); });
    await expect(async () => authority().assertCurrent(retained)).rejects.toThrow("ADMIN_REVOKED");
    await runInDurableObject(authority(), instance => { Reflect.get(instance, "env").ADMINS = [...seeds]; });
    const claim = (await authority().issue(principal(seeds[0]), seeds[0], "board-moderation"))!;
    await expect(async () => authority().list(claim)).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => authority().issue(principal(seeds[0]), seeds[0], "forged" as AdminClaim["purpose"])).rejects.toThrow("ADMIN_REQUIRED");
  });

  it("prepares once, preserves static effectiveness, audits retries and denies production activation and writes", async () => {
    const claim = (await authority().issue(principal(seeds[0]), seeds[0], "administration"))!;
    expect((await authority().list(claim)).items).toEqual([]);
    expect((await authority().list(claim)).blockers).toEqual(["LEGACY_CAPABILITIES_UNDRAINED"]);
    expect(await authority().resolve(claim, "not-an-existing-account")).toBeNull();
    const preview = await authority().preview(claim);
    expect(preview.accounts.map(a => a.profileId)).toEqual(seeds.toSorted());
    expect(preview.unresolvedProfileIds).toEqual([]);
    const input = {...mutation(0, "bootstrap"), digest: preview.digest};
    expect(await authority().prepare(claim, input)).toBe(1);
    await runInDurableObject(authority(), instance => { Reflect.get(instance, "env").ADMINS = [seeds[0]]; });
    expect(await authority().prepare(claim, input)).toBe(1);
    expect((await authority().list(claim)).items).toHaveLength(4);
    await runInDurableObject(authority(), instance => { Reflect.get(instance, "env").ADMINS = [...seeds]; });
    await expect(async () => authority().prepare(claim, {...mutation(1), digest: preview.digest})).rejects.toThrow("ADMIN_BOOTSTRAP_ALREADY_PREPARED");
    expect(await authority().list(claim)).toMatchObject({mode: "prepared", revision: 1, staticProfileIds: seeds.toSorted()});
    expect((await authority().audit(claim)).items).toHaveLength(1);
    expect((await authority().audit(claim, 1)).items).toEqual([]);
    const admin = new AdminApiImpl(env.TEST_ADMIN.getByName(""), seeds[0], authority(), claim);
    const forgedReadiness = Object.assign(mutation(1), {financeGuard: true, legacyDrained: true, providersCurrent: true});
    await expect(admin.activateManagedAdministrators(forgedReadiness)).rejects.toThrow("LEGACY_CAPABILITIES_UNDRAINED");
    await expect(async () => authority().grant(claim, {...mutation(1), profileId: seeds[1]})).rejects.toThrow("ADMIN_MANAGED_NOT_ACTIVE");
    await expect(async () => authority().revoke(claim, {...mutation(1), principalId: principal(seeds[1])})).rejects.toThrow("ADMIN_MANAGED_NOT_ACTIVE");
    expect((await authority().list(claim)).mode).toBe("prepared");
  });

  it("fails preparation on any unresolved seed, forged digest or stale revision, without partial rows", async () => {
    const claim = (await authority().issue(principal(seeds[0]), seeds[0], "administration"))!;
    await runInDurableObject(authority(), instance => { Reflect.get(instance, "env").ADMINS = [...seeds, "unresolved-seed"]; });
    const preview = await authority().preview(claim);
    expect(preview.unresolvedProfileIds).toEqual(["unresolved-seed"]);
    await expect(async () => authority().prepare(claim, {...mutation(0), digest: preview.digest})).rejects.toThrow("ADMIN_BOOTSTRAP_UNCONFIRMED");
    await runInDurableObject(authority(), instance => { Reflect.get(instance, "env").ADMINS = [...seeds]; });
    const resolved = await authority().preview(claim);
    await expect(async () => authority().prepare(claim, {...mutation(0), digest: "forged"})).rejects.toThrow("ADMIN_BOOTSTRAP_UNCONFIRMED");
    await expect(async () => authority().prepare(claim, {...mutation(99), digest: resolved.digest})).rejects.toThrow("REVISION_CONFLICT");
    expect((await authority().list(claim)).items).toEqual([]);
    expect((await authority().audit(claim)).items).toEqual([]);
  });

  it("executes managed grant/revoke, survives reconstruction, and never revives retained generations", async () => {
    const [actor, target] = await managedFixture();
    const admin = new AdminApiImpl(env.TEST_ADMIN.getByName(""), seeds[1], authority(), target);
    expect((await admin.listAdministrators()).mode).toBe("managed");
    const revoke = {...mutation(2, "revoke"), principalId: target.principalId};
    expect(await authority().revoke(actor, revoke)).toBe(3);
    expect(await authority().revoke(actor, revoke)).toBe(3);
    await expect(async () => authority().revoke(actor, {...revoke, principalId: principal(seeds[2])})).rejects.toThrow("MUTATION_KEY_CONFLICT");
    for (const call of [() => admin.getSettings(), () => admin.setSignupsEnabled(false), () => admin.diagnoseFinanceHub(), () => admin.listAdministratorAudit()]) await expect(call()).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => authority().revoke(target, revoke)).rejects.toThrow("ADMIN_REVOKED");
    expect(await authority().grant(actor, {...mutation(3), profileId: seeds[1]})).toBe(4);
    await expect(async () => authority().assertCurrent(target)).rejects.toThrow("ADMIN_REVOKED");
    const next = (await authority().issue(principal(seeds[1]), seeds[1], "administration"))!;
    expect(next.generation).toBe(3);
    await runInDurableObject(authority(), (_instance, ctx) => {
      const reopened = new AdminAuthorityState(ctx.storage, env.TEST_USER, {ADMINS: []}, async () => { throw new Error("NO_EVIDENCE"); });
      reopened.assertCurrent(next);
      expect(reopened.list(actor).revision).toBe(4);
      expect(reopened.audit(actor).items.map(item => item.action)).toEqual(["prepare", "activate", "revoke", "grant"]);
    });
  });

  it("serializes competing removals and prevents self-revoke/last-admin lockout", async () => {
    const [a, b, c, d] = await managedFixture();
    await authority().revoke(a, {...mutation(2), principalId: c.principalId});
    await authority().revoke(a, {...mutation(3), principalId: d.principalId});
    const outcomes = await Promise.allSettled([
      authority().revoke(a, {...mutation(4), principalId: b.principalId}),
      authority().revoke(b, {...mutation(4), principalId: a.principalId}),
    ]);
    expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const survivor = await authority().issue(a.principalId, a.profileId, "administration") ?? await authority().issue(b.principalId, b.profileId, "administration");
    expect(survivor).not.toBeNull();
    await expect(async () => authority().revoke(survivor!, {...mutation(5), principalId: survivor!.principalId})).rejects.toThrow("SELF_REVOKE_FORBIDDEN");
    expect((await authority().list(survivor!)).items.filter(item => item.active)).toHaveLength(1);
  });

  it("enforces provider-first negotiation and never retries a new-path denial on the boolean path", async () => {
    const user = env.TEST_USER.getByName(seeds[0]);
    async function account(vendorId: string, upgraded: boolean, adminOnly: boolean) {
      await runInDurableObject(user, instance => {
        const nativeAccount = Reflect.get(instance, "ctx").exports.FixtureAppAccount({props: {}});
        Reflect.get(instance, "storage").connectedAccounts.put({id: 991, account: nativeAccount,
          vendorId, description: {displayName: "Fixture", providesUi: {title: "Fixture", adminOnly},
            ...(upgraded ? {adminAuthorizationProtocol: "admin-authorization-v1"} : {})}});
      });
    }
    await account("context", false, false);
    await expect(async () => user.startAccountAppUiAuthorized(991, {protocol: "admin-authorization-v1"})).rejects.toThrow("PROVIDER_PROTOCOL_UNAVAILABLE");
    await account("jarvis", false, true);
    await expect(async () => user.startAccountAppUiAuthorized(991, {protocol: "admin-authorization-v1"})).rejects.toThrow("PROVIDER_PROTOCOL_UNAVAILABLE");
    await account("context", true, false);
    await expect(async () => user.startAccountAppUiAuthorized(991, {protocol: "admin-authorization-v1"})).rejects.toThrow("PROVIDER_DENIED_OR_UNAVAILABLE");
    await account("ordinary", false, false);
    using frame = await user.startAccountAppUiAuthorized(991, {protocol: "admin-authorization-v1"});
    expect(frame.iframeHtml).toBe("fixture");
    frame.ui[Symbol.dispose]();
    await runInDurableObject(user, instance => {
      const ordinary = Reflect.get(instance, "ctx").exports.FixtureOrdinaryAppAccount({props: {}});
      Reflect.get(instance, "storage").connectedAccounts.put({id: 992, account: ordinary,
        vendorId: "ordinary-upgraded", description: {displayName: "Ordinary", providesUi: {title: "Ordinary"},
          adminAuthorizationProtocol: "admin-authorization-v1"}});
    });
    using upgraded = await user.startAccountAppUiAuthorized(992, {protocol: "admin-authorization-v1", authorization: env.TEST_CONTEXT_AUTHORIZATION});
    expect(upgraded.iframeHtml).toBe("ordinary-authorized");
    upgraded.ui[Symbol.dispose]();
    await account("jarvis", true, true);
    await expect(async () => user.startAccountAppUiAuthorized(991, {protocol: "admin-authorization-v1"})).rejects.toThrow("ADMIN_REQUIRED");
  });

  it("denies retained old-wire privileged children at upgraded resource owners; ordinary policy reads remain values", async () => {
    const [actor, target] = await managedFixture();
    const hooks = env.TEST_ADMIN_PROVIDERS.getByName("");
    using context = await hooks.legacyContext();
    using jarvis = await hooks.legacyJarvis();
    const authorization = await hooks.mint({...target, purpose: "context-public"});
    const collectionId = crypto.randomUUID();
    const collection = env.TEST_CONTEXT_COLLECTIONS.getByName(`test-domain\u0000${collectionId}`);
    await collection.initialize({id: collectionId, title: "Preserved", description: "", visibility: "public",
      created: new Date(), lastUpdated: new Date(), documentCount: 0, content: {source: "web"}}, "test-domain", "", authorization);
    await collection.putContextDocument("kept.md", {description: "", body: "Preserved"}, authorization);
    const policy = await jarvis.get();
    const input = {chatTools: policy.chat.tools ?? [], codeTools: policy.code.tools ?? [], syncCode: !policy.syncCode};
    const denied = [
      () => context.updateContextCollection(collectionId, {title: "Denied"}),
      () => context.deleteContextCollection(collectionId),
      () => context.putContextDocument(collectionId, "old.md", {description: "", body: "Denied"}),
      () => context.deleteContextDocument(collectionId, "kept.md"),
      () => context.moveContextDocument(collectionId, "kept.md", "moved.md"),
      () => context.syncContextCollectionArtifactSource(collectionId),
      () => context.createContextCollectionGitToken(collectionId),
      () => context.listContextCollectionGitTokens(collectionId),
      () => context.revokeContextCollectionGitToken(collectionId, "fixture-token"),
    ];
    // pool-workers' dynamic DO callable-thenable adapter releases its queue before assimilating
    // immediate rejected async methods (test-internal.mjs:getRPCPropertyCallableThenable).
    // Catch those expected denials inside the owner boundary, not with a global rejection filter.
    // Other retained child calls below still cross the actual native RPC boundary.
    const immediateDenials = async () => {
      const initialize = await runInDurableObject(collection, async instance => {
        try {
          await instance.initialize({id: crypto.randomUUID(), title: "Denied", description: "", visibility: "public",
            created: new Date(), lastUpdated: new Date(), documentCount: 0, content: {source: "web"}}, "test-domain", "");
          return "UNEXPECTED_SUCCESS";
        } catch (error) { if (!(error instanceof Error) || error.message !== "Admin access required.") throw error; return error.message; }
      });
      expect(initialize).toBe("Admin access required.");
      const index = await runInDurableObject(env.TEST_LIBRARY_REGISTRIES.getByName("test-domain"), async instance => {
        const results: string[] = [];
        for (const call of [
          () => instance.addPublic("test-domain", {id: collectionId, title: "Denied", description: "", visibility: "public", lastUpdated: new Date(), documentCount: 1}),
          () => instance.removePublic("test-domain", collectionId),
        ]) {
          try { await call(); results.push("UNEXPECTED_SUCCESS"); }
          catch (error) { if (!(error instanceof Error) || error.message !== "Admin access required.") throw error; results.push(error.message); }
        }
        return results;
      });
      expect(index).toEqual(["Admin access required.", "Admin access required."]);
      const update = await runInDurableObject(env.TEST_JARVIS_POLICY.getByName(""), async instance => {
        if (!(instance instanceof JarvisPolicy)) throw new Error("Wrong fixture owner");
        try { await instance.update(input); return "UNEXPECTED_SUCCESS"; }
        catch (error) { if (!(error instanceof Error) || error.message !== "Admin access required.") throw error; return error.message; }
      });
      expect(update).toBe("Admin access required.");
    };
    // First provider upgrade, then revoke, then regrant: no old no-argument call gains authority.
    await immediateDenials();
    for (const call of denied) await expect(async () => await call()).rejects.toThrow("Admin access required");
    await authority().revoke(actor, {...mutation(2), principalId: target.principalId});
    await immediateDenials();
    for (const call of denied) await expect(async () => await call()).rejects.toThrow("Admin access required");
    await authority().grant(actor, {...mutation(3), profileId: target.profileId});
    await immediateDenials();
    for (const call of denied) await expect(async () => await call()).rejects.toThrow("Admin access required");
    await expect(async () => collection.updateMetadata({title: "Stale"}, authorization)).rejects.toThrow("ADMIN_REVOKED");
    expect((await collection.getContextDocument("kept.md"))?.body).toBe("Preserved");
    expect(await runInDurableObject(collection, async instance => {
      try { await instance.deleteForRevokedOwner(); return "UNEXPECTED_SUCCESS"; }
      catch (error) { if (!(error instanceof Error) || error.message !== "Private collection required.") throw error; return error.message; }
    })).toBe("Private collection required.");
    // get also serves ordinary old account wrappers. syncCode is nonsensitive, value-only metadata.
    policy.syncCode = !policy.syncCode;
    expect(await jarvis.get()).toMatchObject({syncCode: !policy.syncCode});
    expect(await env.TEST_JARVIS_POLICY.getByName("").get()).toEqual(await jarvis.get());
  });

  it("separates Finance operator opens from managed grants, revokes and authority availability", async () => {
    const [actor, operator] = await managedFixture();
    const ctx = createExecutionContext();
    Object.defineProperty(ctx, "exports", {value: {UserDurableObject: env.TEST_USER, OverseerDurableObject: env.TEST_OVERSEER, AdminSettings: env.TEST_ADMIN, AdminAuthority: env.TEST_AUTHORITY, CommunityRequests: env.TEST_COMMUNITY_REQUESTS}});
    const config: Cloudflare.Env = {...env, ADMINS: seeds};
    const authenticate = (email: string) => new PublicApiImpl(ctx, config, () => {}, {email}).authenticateFromCfAccess();
    const ownerName = "finance_owner";
    const otherName = "finance_nonoperator";
    const sharedName = "finance_direct_share";
    const owner = await authenticate(ownerName);
    const other = await authenticate(otherName);
    const shared = await authenticate(sharedName);
    const finance = await authenticate(operator.profileId);
    for (const name of seeds) expect(await (await authenticate(name)).getFinanceHubStatus()).toEqual({authorized: true, canCreate: true});
    expect(await other.getFinanceHubStatus()).toEqual({authorized: false, canCreate: false});
    await authority().grant(actor, {...mutation(2), profileId: otherName});
    expect(await other.amIAdmin()).toBe(true);
    expect(await other.getFinanceHubStatus()).toEqual({authorized: false, canCreate: false});

    const workspaceId = env.TEST_OVERSEER.newUniqueId().toString();
    const claim = {workspaceId, ownerUserId: principal(ownerName), ownerProfileId: ownerName};
    const adminSettings = env.TEST_ADMIN.getByName("");
    await adminSettings.claimFinanceWorkspace(claim);
    await env.TEST_USER.getByName(ownerName).registerFinanceGadget(workspaceId, "Finance");
    using ownerSession = await owner.openGadget(workspaceId);
    await ownerSession.addCollaborator(sharedName, "use");
    using _operatorSession = await finance.openGadget(workspaceId);
    await expect(async () => other.openGadget(workspaceId)).rejects.toThrow();
    await authority().revoke(actor, {...mutation(3), principalId: operator.principalId});
    expect(await finance.amIAdmin()).toBe(false);
    using _afterRevoke = await finance.openGadget(workspaceId);
    using _sharedSession = await shared.openGadget(workspaceId);
    expect(await finance.getFinanceHubStatus()).toMatchObject({authorized: true, workspaceId});

    // An explicit empty deployment list denies fresh operator opens, but not owners/direct shares.
    config.FINANCE_OPERATORS = [];
    expect(await finance.getFinanceHubStatus()).toEqual({authorized: false, canCreate: false});
    await expect(async () => finance.openGadget(workspaceId)).rejects.toThrow();
    using _ownerStill = await owner.openGadget(workspaceId);
    using _sharedStill = await shared.openGadget(workspaceId);
    config.FINANCE_OPERATORS = [operator.profileId.toUpperCase()];
    await expect(async () => finance.openGadget(workspaceId)).rejects.toThrow();
    config.FINANCE_OPERATORS = JSON.stringify([operator.profileId]);
    using _reconfigured = await finance.openGadget(workspaceId);
    await runInDurableObject(authority(), (_instance, state) => state.storage.sql.exec("UPDATE authority_meta SET value='{}'"));
    await expect(async () => other.amIAdmin()).rejects.toThrow();
    using _duringOutage = await finance.openGadget(workspaceId);
    using _ownerDuringOutage = await owner.openGadget(workspaceId);
    using _sharedDuringOutage = await shared.openGadget(workspaceId);
    await expect(async () => other.openGadget(workspaceId)).rejects.toThrow();
    await adminSettings.releaseFinanceWorkspace(claim);
    await env.TEST_USER.getByName(ownerName).deleteGadget(workspaceId);
  });

  it("mints a runtime-provenance native capability using the production ctx.exports path", async () => {
    const [actor, target] = await managedFixture();
    const hooks = env.TEST_ADMIN_PROVIDERS.getByName("");
    const capability = await hooks.mint(target);
    await capability.assertCurrent("administration");
    await expect(async () => capability.assertCurrent("context-public")).rejects.toThrow("ADMIN_REVOKED");
    await authority().revoke(actor, {...mutation(2), principalId: target.principalId});
    await expect(async () => capability.assertCurrent("administration")).rejects.toThrow("ADMIN_REVOKED");
  });

  it("rechecks retained Context/JARVIS through real native issuer; private ownership survives revocation", async () => {
    // Config-time native props require fixed provenance. Seed only this fixture record,
    // not an injectable production issuer or a claim of real bootstrap/drain completion.
    await runInDurableObject(authority(), (_instance, ctx) => {
      ctx.storage.sql.exec("UPDATE authority_meta SET value=? WHERE singleton=1", JSON.stringify({schemaVersion: 1, initializedAt: 0, mode: "managed", epoch: providerFixtureClaim.epoch, revision: 0, bootstrapDigest: "fixture"}));
      ctx.storage.sql.exec("INSERT INTO admin_grants VALUES (?,?,?,?,?,?,?,?)", providerFixtureClaim.principalId, providerFixtureClaim.profileId, "Fixture", 1, 1, "fixture", "fixture", 0);
    });
    const hooks = env.TEST_ADMIN_PROVIDERS.getByName("");
    await expect(async () => env.TEST_CONTEXT_AUTHORIZATION.assertCurrent("jarvis-policy")).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => env.TEST_JARVIS_AUTHORIZATION.assertCurrent("context-public")).rejects.toThrow("ADMIN_REVOKED");
    using wrongContext = await hooks.context(true, true);
    using wrongJarvis = await hooks.jarvis(false, true);
    await expect(async () => wrongContext.createContextCollection("Denied purpose", "", "public")).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => wrongJarvis.get()).rejects.toThrow("ADMIN_REVOKED");
    using context = await hooks.context(true);
    using jarvis = await hooks.jarvis();
    using ordinaryContext = await hooks.context();
    await expect(async () => env.TEST_WRONG_EPOCH.assertCurrent("context-public")).rejects.toThrow("ADMIN_REVOKED");
    const collection = await context.createContextCollection("Public", "", "public");
    const privateCollection = await context.createContextCollection("Private", "", "private");
    const owner = env.TEST_CONTEXT_COLLECTIONS.getByName(`test-domain\u0000${collection.id}`);
    const registry = env.TEST_LIBRARY_REGISTRIES.getByName("test-domain");
    const policyOwner = env.TEST_JARVIS_POLICY.getByName("");
    const ownerWrites = (authorization: Service<AdminAuthorization>) => [
      () => owner.updateMetadata({title: "Denied"}, authorization),
      () => owner.putContextDocument("denied.md", {description: "", body: "Denied"}, authorization),
      () => owner.deleteContextDocument("denied.md", authorization),
      () => owner.moveContextDocument("denied.md", "other.md", authorization),
      () => owner.syncArtifactSource(authorization),
      () => owner.createGitToken(authorization),
      () => owner.listGitTokens(authorization),
      () => owner.revokeGitToken("fixture-token", authorization),
      () => owner.deleteSelf(authorization),
      () => registry.removePublic("test-domain", collection.id, authorization),
    ];
    for (const call of ownerWrites(env.TEST_JARVIS_AUTHORIZATION)) await expect(async () => await call()).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => policyOwner.update({chatTools: [], syncCode: false}, env.TEST_CONTEXT_AUTHORIZATION)).rejects.toThrow("ADMIN_REVOKED");
    expect(await context.canWriteContextCollection(collection.id)).toBe(true);
    const policy = await jarvis.get();
    expect(policy.revision).toBeGreaterThan(0);
    await jarvis.update({chatTools: policy.chat.tools ?? [], codeTools: policy.code.tools ?? [], syncCode: false});
    await expect(async () => ordinaryContext.createContextCollection("Denied", "", "public")).rejects.toThrow("Admin access required");
    await runInDurableObject(authority(), (_instance, ctx) => { ctx.storage.sql.exec("UPDATE admin_grants SET active=0,generation=2"); });
    for (const call of ownerWrites(env.TEST_CONTEXT_AUTHORIZATION)) await expect(async () => await call()).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => policyOwner.update({chatTools: [], syncCode: false}, env.TEST_JARVIS_AUTHORIZATION)).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => context.createContextCollection("Denied", "", "public")).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => context.canWriteContextCollection(collection.id)).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => context.deleteContextCollection(collection.id)).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => context.putContextDocument(collection.id, "public.md", {description: "", body: "denied"})).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => context.syncContextCollectionArtifactSource(collection.id)).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => context.listContextCollectionGitTokens(collection.id)).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => jarvis.update({chatTools: policy.chat.tools ?? [], codeTools: policy.code.tools ?? [], syncCode: false})).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => jarvis.get()).rejects.toThrow("ADMIN_REVOKED");
    expect(await context.canWriteContextCollection(privateCollection.id)).toBe(true);
    await context.putContextDocument(privateCollection.id, "private.md", {description: "", body: "Private ownership"});
    await context.moveContextDocument(privateCollection.id, "private.md", "moved.md");
    expect((await context.getContextDocument(privateCollection.id, "moved.md"))?.body).toBe("Private ownership");
    await context.deleteContextDocument(privateCollection.id, "moved.md");
    await context.deleteContextCollection(privateCollection.id);
    await runInDurableObject(authority(), (_instance, ctx) => { ctx.storage.sql.exec("UPDATE admin_grants SET active=1,generation=3"); });
    for (const call of ownerWrites(env.TEST_CONTEXT_AUTHORIZATION)) await expect(async () => await call()).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => jarvis.get()).rejects.toThrow("ADMIN_REVOKED");
    await expect(async () => context.getViewerInfo()).rejects.toThrow("ADMIN_REVOKED");
    using fresh = await hooks.jarvis(true);
    expect((await fresh.get()).revision).toBeGreaterThan(0);
    await fresh.update({chatTools: policy.chat.tools ?? [], codeTools: policy.code.tools ?? [], syncCode: false});
    await runInDurableObject(authority(), (_instance, state) => state.storage.sql.exec("DROP TABLE authority_meta"));
    for (const call of ownerWrites(env.TEST_CONTEXT_AUTHORIZATION)) await expect(async () => await call()).rejects.toThrow();
    await expect(async () => policyOwner.update({chatTools: [], syncCode: false}, env.TEST_JARVIS_REGRANTED)).rejects.toThrow();
    expect((await policyOwner.get()).revision).toBeGreaterThan(0);
    await expect(async () => fresh.get()).rejects.toThrow();
    await runInDurableObject(authority(), (_instance, state) => { for (const table of ["admin_audit", "admin_receipts", "admin_grants", "authority_meta"]) state.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`); expect(new AdminAuthorityState(state.storage, env.TEST_USER, {ADMINS: seeds}, async () => { throw new Error("NO_EVIDENCE"); })).toBeInstanceOf(AdminAuthorityState); });
  });

  it("keeps issued public Git write credentials independent until explicit Context revocation", async () => {
    const [actor, issuer] = await managedFixture();
    const stub = env.TEST_CONTEXT_COLLECTIONS.getByName(`token-fixture\u0000${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance, ctx) => {
      // Native handles belong to this owner's I/O context; only immutable claims cross the closure.
      const authorization = ctx.exports.AdminAuthorizationEntrypoint({props: {claim: {...issuer, purpose: "context-public"}}});
      const currentAdmin = ctx.exports.AdminAuthorizationEntrypoint({props: {claim: {...actor, purpose: "context-public"}}});
      Reflect.get(instance, "storage").metadata.put({id: "fixture-public-git", title: "Public", description: "", visibility: "public",
        created: new Date(), lastUpdated: new Date(), documentCount: 0,
        content: {source: "git", remote: "https://fixture.invalid/public.git", branch: "main", lastRefreshedAt: new Date()}});
      let active = false;
      const repo: Pick<ArtifactsRepo, "createToken" | "listTokens" | "revokeToken"> = {
        async createToken() { active = true; return {id: "public-credential", plaintext: "fixture-only", scope: "write", expiresAt: "2099-01-01"}; },
        async listTokens() { return {total: 1, tokens: [{id: "public-credential", scope: "write", state: active ? "active" : "revoked", createdAt: "2020-01-01", expiresAt: "2099-01-01"}]}; },
        async revokeToken(id) { expect(id).toBe("public-credential"); active = false; return true; },
      };
      const ownerEnv = Reflect.get(instance, "env");
      const previous = ownerEnv.ARTIFACTS;
      ownerEnv.ARTIFACTS = {async get() { return repo; }};
      try {
        expect((await instance.createGitToken(authorization)).id).toBe("public-credential");
        await authority().revoke(actor, {...mutation(2), principalId: issuer.principalId});
        for (const operation of [() => instance.createGitToken(authorization), () => instance.listGitTokens(authorization),
          () => instance.revokeGitToken("public-credential", authorization)]) await expect(operation()).rejects.toThrow("ADMIN_REVOKED");
        expect(active).toBe(true);
        expect((await instance.listGitTokens(currentAdmin)).tokens).toHaveLength(1);
        expect(await instance.revokeGitToken("public-credential", currentAdmin)).toBe(true);
        expect(active).toBe(false);
      } finally { ownerEnv.ARTIFACTS = previous; }
    });
  });

  it("preserves historical private Git token owner operations without any admin authority", async () => {
    const stub = env.TEST_CONTEXT_COLLECTIONS.getByName(`test-domain\u0000${crypto.randomUUID()}`);
    const result = await runInDurableObject(stub, async instance => {
      const metadata = {id: "fixture-private-git", title: "Private", description: "", visibility: "private",
        created: new Date(), lastUpdated: new Date(), documentCount: 0,
        content: {source: "git", remote: "https://fixture.invalid/private.git", branch: "main", lastRefreshedAt: new Date()}};
      // Historical private metadata and an in-memory token owner; no real Artifacts binding exists.
      Reflect.get(instance, "storage").metadata.put(metadata);
      let active = true;
      let created = false;
      const repo: Pick<ArtifactsRepo, "createToken" | "listTokens" | "revokeToken"> = {
        async createToken(scope, ttl) {
          expect(scope).toBe("write"); expect(ttl).toBe(31_536_000); created = true;
          return {id: "new-private", plaintext: "fixture-only", scope: "write", expiresAt: "2099-01-01"};
        },
        async listTokens() { return {total: 1, tokens: [{id: "old-private", scope: "write", state: active ? "active" : "revoked", createdAt: "2020-01-01", expiresAt: "2099-01-01"}]}; },
        async revokeToken(id) { expect(id).toBe("old-private"); active = false; return true; },
      };
      // Derive just the methods exercised by this owner, without fabricating provider-wide proof.
      const fixture = {async get(name: Parameters<Artifacts["get"]>[0]) { expect(name).toBe(metadata.id); return repo; }};
      const ownerEnv = Reflect.get(instance, "env");
      const previous = ownerEnv.ARTIFACTS;
      ownerEnv.ARTIFACTS = fixture;
      try {
        expect((await instance.listGitTokens()).tokens.map(token => token.id)).toEqual(["old-private"]);
        expect((await instance.createGitToken()).id).toBe("new-private");
        expect(active).toBe(true); // Issuance never retires an existing private token.
        expect(await instance.revokeGitToken("old-private")).toBe(true);
        return {created, active};
      } finally { ownerEnv.ARTIFACTS = previous; }
    });
    expect(result).toEqual({created: true, active: false});
  });

  it("denies authority outage with no static fallback, while ordinary board reads stay independent", async () => {
    const claim = (await authority().issue(principal(seeds[0]), seeds[0], "administration"))!;
    const retained = new AdminApiImpl(env.TEST_ADMIN.getByName(""), seeds[0], authority(), claim);
    const ctx = createExecutionContext();
    Object.defineProperty(ctx, "exports", {value: {UserDurableObject: env.TEST_USER, OverseerDurableObject: env.TEST_OVERSEER, AdminSettings: env.TEST_ADMIN, AdminAuthority: env.TEST_AUTHORITY, CommunityRequests: env.TEST_COMMUNITY_REQUESTS}});
    const root = new PublicApiImpl(ctx, {...env, ADMINS: seeds}, () => {});
    const ordinaryName = `ordinary_${crypto.randomUUID().replaceAll("-", "")}`;
    const token = await root.createAccount(ordinaryName, "Ordinary", new Uint8Array([3, 7]));
    const authenticated = await root.authenticate(token!);
    await runInDurableObject(env.TEST_USER.getByName(ordinaryName), instance => {
      const exports = Reflect.get(instance, "ctx").exports;
      const accounts = Reflect.get(instance, "storage").connectedAccounts;
      Reflect.get(instance, "storage").nextAccountId.put(3);
      for (const [id, vendorId, account, adminOnly] of [
        [0, "ordinary-upgraded", exports.FixtureOrdinaryAppAccount({props: {}}), false],
        [1, "context", exports.FixtureContextAccount({props: {}}), false],
        [2, "jarvis", exports.FixtureAppAccount({props: {}}), true],
      ]) accounts.put({id, vendorId, account, description: {displayName: vendorId,
        providesUi: {title: vendorId, adminOnly}, adminAuthorizationProtocol: "admin-authorization-v1"}});
    });
    const appsBeforeOutage = await authenticated.listGatekeeperApps();
    expect(appsBeforeOutage.map(app => app.vendorId).toSorted()).toEqual(["context", "ordinary-upgraded"]);
    await runInDurableObject(authority(), (_instance, state) => state.storage.sql.exec("DROP TABLE authority_meta"));
    await expect(retained.getSettings()).rejects.toThrow();
    await expect(authenticated.getAdminApi()).rejects.toThrow();
    await expect(authenticated.listCommunityRequests({includeHidden: true})).rejects.toThrow();
    expect((await authenticated.listCommunityRequests()).items).toEqual([]);
    expect(await authenticated.listGatekeeperApps()).toEqual(appsBeforeOutage);
    for (const app of appsBeforeOutage) {
      const frame = await authenticated.getGatekeeperApp(app.id);
      expect(frame?.iframeHtml).toBe(app.vendorId === "context" ? "context-authorized" : "ordinary-authorized");
      frame?.ui[Symbol.dispose]();
    }
    expect(await authenticated.getGatekeeperApp("jarvis")).toBeNull();
    using privateContext = await env.TEST_ADMIN_PROVIDERS.getByName("").context();
    const privateCollection = await privateContext.createContextCollection("Private during outage", "", "private");
    await privateContext.deleteContextCollection(privateCollection.id);
    await expect(async () => privateContext.createContextCollection("Denied during outage", "", "public")).rejects.toThrow("Admin access required");
    await runInDurableObject(authority(), (_instance, state) => {
      expect(() => new AdminAuthorityState(state.storage, env.TEST_USER, {ADMINS: seeds}, async () => { throw new Error("NO_EVIDENCE"); })).toThrow("AUTHORITY_UNAVAILABLE");
    });
    // Restore only the fixture schema so later test cleanup can run; no production recovery RPC.
    await runInDurableObject(authority(), (_instance, state) => { for (const table of ["admin_audit", "admin_receipts", "admin_grants", "authority_meta"]) state.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`); expect(new AdminAuthorityState(state.storage, env.TEST_USER, {ADMINS: seeds}, async () => { throw new Error("NO_EVIDENCE"); })).toBeInstanceOf(AdminAuthorityState); });
  });
});
