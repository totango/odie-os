import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AdminFenceChallenge, AdminFenceEvidence, GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";
import { readAdminProviderEvidence } from "../src/admin-provider-evidence";
import { AdminAuthorityState } from "../src/admin-authority";
import type { AdminAuthority } from "../src/admin-authority";
import type { UserDurableObject } from "../src/user";
import type { LibraryRegistryDurableObject } from "../../gatekeeper-context/src/registry-do";

declare global { namespace Cloudflare { interface Env {
  TEST_CONTEXT_FENCE_VENDOR: Service<GatekeeperVendor>;
  TEST_JARVIS_FENCE_VENDOR: Service<GatekeeperVendor>;
  TEST_AUTHORITY: DurableObjectNamespace<AdminAuthority>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
  TEST_LIBRARY_REGISTRIES: DurableObjectNamespace<LibraryRegistryDurableObject>;
} } }
const scope = {epoch: "fixture-deployment-epoch", revision: 7};
const config = () => Object.assign({}, env, {
  GATEKEEPER_CONTEXT: env.TEST_CONTEXT_FENCE_VENDOR,
  GATEKEEPER_JARVIS: env.TEST_JARVIS_FENCE_VENDOR,
});

// Values are changed only after the real provider/owner answered; these are protocol-negative fixtures.
function changedContext(change: (value: AdminFenceEvidence, call: number) => unknown) {
  let calls = 0;
  return Object.assign(config(), {GATEKEEPER_CONTEXT: {
    async adminFenceReadiness(challenge: AdminFenceChallenge) {
      if (typeof env.TEST_CONTEXT_FENCE_VENDOR.adminFenceReadiness !== "function") throw new Error("Missing fixture method");
      return change(await env.TEST_CONTEXT_FENCE_VENDOR.adminFenceReadiness(challenge), ++calls);
    },
  }});
}

describe("private resource-owner activation evidence (real workerd)", () => {
  it("gets binding-owned domains and stable inventory through typed native bridges to actual Context/JARVIS owners", async () => {
    const evidence = await readAdminProviderEvidence(config(), scope);
    expect(evidence).toEqual([
      {provider: "context", domain: "evidence-domain", fenceVersion: 1, registryRevision: 0, ownerCount: 0,
        inventory: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},
      {provider: "jarvis", domain: "global", fenceVersion: 1, registryRevision: 0, ownerCount: 1, inventory: "global-policy"},
    ]);
  });

  it("denies absent/old providers and mismatched purpose, version, nonce, epoch or revision", async () => {
    for (const overrides of [{GATEKEEPER_CONTEXT: undefined}, {GATEKEEPER_JARVIS: undefined}, {GATEKEEPER_CONTEXT: {}}]) {
      await expect(readAdminProviderEvidence(Object.assign(config(), overrides), scope)).rejects.toThrow("LEGACY_CAPABILITIES_UNDRAINED");
    }
    for (const patch of [{provider: "jarvis"}, {fenceVersion: 2}, {nonce: crypto.randomUUID()}, {epoch: "other"}, {revision: 8}, {ownerCount: 1001}]) {
      await expect(readAdminProviderEvidence(changedContext(value => ({...value, ...patch})), scope)).rejects.toThrow("LEGACY_CAPABILITIES_UNDRAINED");
    }
  });

  it("uses distinct challenges and denies replay, second-scan outage, domain and inventory drift", async () => {
    let previous: AdminFenceEvidence | undefined;
    await expect(readAdminProviderEvidence(changedContext(value => {
      if (!previous) { previous = value; return value; }
      expect(value.nonce).not.toBe(previous.nonce);
      return previous;
    }), scope)).rejects.toThrow("LEGACY_CAPABILITIES_UNDRAINED");
    for (const patch of [{domain: "other-domain"}, {registryRevision: 1}, {inventory: "1".repeat(64)}, {ownerCount: 1}]) {
      await expect(readAdminProviderEvidence(changedContext((value, call) => call === 2 ? {...value, ...patch} : value), scope)).rejects.toThrow("LEGACY_CAPABILITIES_UNDRAINED");
    }
    await expect(readAdminProviderEvidence(changedContext((value, call) => {
      if (call === 2) throw new Error("Provider unavailable");
      return value;
    }), scope)).rejects.toThrow("LEGACY_CAPABILITIES_UNDRAINED");
  });

  it("attests each indexed public owner without enumerating private collections or Git credentials", async () => {
    const domain = `indexed-${crypto.randomUUID()}`;
    const id = crypto.randomUUID();
    const principalId = env.TEST_USER.idFromName("authority_admin_one").toString();
    const claim = await env.TEST_AUTHORITY.getByName("").issue(principalId, "authority_admin_one", "context-public");
    expect(claim).not.toBeNull();
    const authorization = await env.TEST_ADMIN_PROVIDERS.getByName("").mint(claim!);
    const owner = env.TEST_CONTEXT_COLLECTIONS.getByName(`${domain}\u0000${id}`);
    const metadata = await owner.initialize({id, title: "Public", description: "", visibility: "public", created: new Date(),
      lastUpdated: new Date(), documentCount: 0, content: {source: "web"}}, domain, "", authorization);
    const registry = env.TEST_LIBRARY_REGISTRIES.getByName(domain);
    await registry.addPublic(domain, metadata, authorization);
    const privateId = crypto.randomUUID();
    const privateOwner = env.TEST_CONTEXT_COLLECTIONS.getByName(`${domain}\u0000${privateId}`);
    await privateOwner.initialize({...metadata, id: privateId, visibility: "private"}, domain, "private-owner");
    const result = await registry.adminFenceReadiness(domain, {...scope, nonce: crypto.randomUUID()});
    expect(result).toMatchObject({domain, ownerCount: 1, registryRevision: 1, fenceVersion: 1});
    expect(await owner.adminFenceReadiness(domain, id)).toEqual({domain, collectionId: id, fenceVersion: 1});
    expect((await privateOwner.getMetadata()).visibility).toBe("private");
  });

  it("rejects missing public owners, oversized inventory and a registry mutation during a scan", async () => {
    for (const scenario of ["missing", "oversize", "race"] as const) {
      const domain = `evidence-${scenario}-${crypto.randomUUID()}`;
      const registry = env.TEST_LIBRARY_REGISTRIES.getByName(domain);
      // Immediate expected DO rejections are caught at the actual owner boundary; no runtime filters.
      const failure = await runInDurableObject(registry, async instance => {
        const storage = Reflect.get(instance, "storage");
        for (let i = 0; i < (scenario === "oversize" ? 1001 : scenario === "missing" ? 1 : 0); i++) {
          storage.publicCollections.put({id: `missing-${i}`, title: "Fixture", description: "", visibility: "public", documentCount: 0, lastUpdated: new Date()});
        }
        const pending = instance.adminFenceReadiness(domain, {...scope, nonce: crypto.randomUUID()});
        if (scenario === "race") storage.registryRevision.put(storage.registryRevision.get() + 1);
        try { await pending; return "UNEXPECTED_SUCCESS"; }
        catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("ADMIN_FENCE_")) throw error;
          return error.message;
        }
      });
      expect(failure).toContain(scenario === "missing" ? "OWNER_MISMATCH" : scenario === "oversize" ? "INVENTORY_INCOMPLETE" : "INVENTORY_CHANGED");
    }
  });

  it("wires production activation to private native bridges and actual owner evidence, not caller flags", async () => {
    const names = ["authority_admin_one", "authority_admin_two", "authority_admin_three", "authority_admin_four"];
    for (const name of names) await env.TEST_USER.getByName(name).authenticateFromCfAccess(name, true);
    const authority = env.TEST_AUTHORITY.getByName(crypto.randomUUID());
    await runInDurableObject(authority, async instance => {
      const ownerEnv = Reflect.get(instance, "env");
      const previous = [ownerEnv.GATEKEEPER_CONTEXT, ownerEnv.GATEKEEPER_JARVIS];
      ownerEnv.GATEKEEPER_CONTEXT = env.TEST_CONTEXT_FENCE_VENDOR;
      ownerEnv.GATEKEEPER_JARVIS = env.TEST_JARVIS_FENCE_VENDOR;
      try {
        const claim = instance.issue(env.TEST_USER.idFromName(names[0]).toString(), names[0], "administration")!;
        const preview = await instance.preview(claim);
        await instance.prepare(claim, {expectedRevision: 0, mutationKey: "prepare", digest: preview.digest});
        expect(await instance.activate(claim, {expectedRevision: 1, mutationKey: "activate"})).toBe(2);
        await instance.assertProvidersCurrent();
        const current = instance.issue(claim.principalId, names[0], "administration")!;
        expect(instance.list(current)).toMatchObject({mode: "managed", blockers: []});
      } finally {
        if (previous[0] === undefined) delete ownerEnv.GATEKEEPER_CONTEXT; else ownerEnv.GATEKEEPER_CONTEXT = previous[0];
        if (previous[1] === undefined) delete ownerEnv.GATEKEEPER_JARVIS; else ownerEnv.GATEKEEPER_JARVIS = previous[1];
      }
    });
  });

  it("activates old prepared state only with fresh owner evidence, atomically records baseline, and rechecks readiness", async () => {
    const name = `evidence-admin-${crypto.randomUUID()}`;
    await env.TEST_USER.getByName(name).authenticateFromCfAccess(name, true);
    const authority = env.TEST_AUTHORITY.getByName(crypto.randomUUID());
    await runInDurableObject(authority, async (_instance, ctx) => {
      let providerEnv = config();
      const state = new AdminAuthorityState(ctx.storage, env.TEST_USER, {ADMINS: [name]}, async meta => ({
        ...meta, legacyDrained: true, providersCurrent: true, providerBaseline: await readAdminProviderEvidence(providerEnv, meta),
      }));
      const claim = state.issue(env.TEST_USER.idFromName(name).toString(), name, "administration")!;
      const preview = await state.preview(claim);
      await state.prepare(claim, {expectedRevision: 0, mutationKey: "prepare", digest: preview.digest});
      const before = ctx.storage.sql.exec<{value: string}>("SELECT value FROM authority_meta").one().value;
      expect(JSON.parse(before).providerBaseline).toBeUndefined();
      providerEnv = changedContext((value, call) => { if (call === 2) throw new Error("Outage"); return value; });
      await expect(state.activate(claim, {expectedRevision: 1, mutationKey: "activate"})).rejects.toThrow("LEGACY_CAPABILITIES_UNDRAINED");
      expect(ctx.storage.sql.exec<{value: string}>("SELECT value FROM authority_meta").one().value).toBe(before);
      expect(state.audit(claim).items.map(item => item.action)).toEqual(["prepare"]);
      providerEnv = config();
      const attempts = await Promise.allSettled([
        state.activate(claim, {expectedRevision: 1, mutationKey: "activate"}),
        state.activate(claim, {expectedRevision: 1, mutationKey: "competing-activate"}),
      ]);
      expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
      const currentClaim = state.issue(claim.principalId, name, "administration")!;
      expect(state.audit(currentClaim).items.map(item => item.action)).toEqual(["prepare", "activate"]);
      const recorded = JSON.parse(ctx.storage.sql.exec<{value: string}>("SELECT value FROM authority_meta").one().value);
      expect(recorded.mode).toBe("managed");
      expect(recorded.providerBaseline.map((item: {domain: string}) => item.domain)).toEqual(["evidence-domain", "global"]);
      await state.assertProvidersCurrent();
      providerEnv = changedContext(value => ({...value, domain: "changed-domain"}));
      await expect(state.assertProvidersCurrent()).rejects.toThrow("LEGACY_CAPABILITIES_UNDRAINED");
      expect(JSON.parse(ctx.storage.sql.exec<{value: string}>("SELECT value FROM authority_meta").one().value).providerBaseline).toEqual(recorded.providerBaseline);
    });
  });
});
