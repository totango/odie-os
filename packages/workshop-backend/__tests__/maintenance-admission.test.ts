import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AdminAuthorityState } from "../src/admin-authority";
import { MaintenanceAdmissionState } from "../src/maintenance-admission";
import type { AdminSettings } from "../src/admin-settings";
import type { UserDurableObject } from "../src/user";

declare global { namespace Cloudflare { interface Env {
  TEST_ADMIN: DurableObjectNamespace<AdminSettings>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
} } }

// These are real SQLite/workerd ledger tests, NOT integration proof for Overseer, gadget runtime,
// agent alarms, Cap'n Web sessions or gatekeeper callbacks. No production pause API is exposed.
const owner = "maintenance-owner";
function fixture(storage: DurableObjectStorage) {
  const config = { ADMINS: [owner] };
  const authority = new AdminAuthorityState(storage, env.TEST_USER, config, async () => {
    throw new Error("NO_PRODUCTION_DRAIN_EVIDENCE");
  });
  const claim = authority.issue(env.TEST_USER.idFromName(owner).toString(), owner, "administration")!;
  const ledger = new MaintenanceAdmissionState(storage, authority, env.TEST_USER, config);
  return { ledger, authority, config, claim };
}
const object = () => env.TEST_ADMIN.getByName(`maintenance-test-${crypto.randomUUID()}`);

describe("preparatory maintenance admission ledger (workerd, not runtime integration)", () => {
  it("requires current purpose-bound authority and exact configured operator membership", async () => {
    await runInDurableObject(object(), (_instance, ctx) => {
      const { ledger, authority, config, claim } = fixture(ctx.storage);
      expect(() => ledger.transition({ ...claim, principalId: "forged" }, 0, "draining")).toThrow("ADMIN_REVOKED");
      const otherPurpose = authority.issue(claim.principalId, owner, "board-moderation")!;
      expect(() => ledger.transition(otherPurpose, 0, "draining")).toThrow("ADMIN_REVOKED");
      // Separate operator configuration is still intersected with actual current authority.
      const noOperators = new MaintenanceAdmissionState(ctx.storage, authority, env.TEST_USER, { ADMINS: [] });
      expect(() => noOperators.transition(claim, 0, "draining")).toThrow("MAINTENANCE_OPERATOR_REQUIRED");
      config.ADMINS = [];
      expect(() => ledger.transition(claim, 0, "draining")).toThrow("ADMIN_REVOKED");
      expect(ledger.snapshot()).toMatchObject({ mode: "normal", revision: 0 });
    });
  });

  it("blocks freeze across an admitted await and rejects a retained caller's next operation", async () => {
    await runInDurableObject(object(), async (_instance, ctx) => {
      const { ledger, claim } = fixture(ctx.storage);
      // Models a retained capability: it must admit EVERY invocation, not only its creation.
      const retained = () => ledger.admit("mutation");
      const token = retained();
      const barrier = Promise.withResolvers<void>();
      let completed = false;
      const pending = (async () => {
        await barrier.promise;
        ledger.assertAdmitted(token, "mutation");
        completed = true;
        ledger.acknowledge(token);
      })();
      expect(ledger.transition(claim, 0, "draining").pending.mutation).toBe(1);
      expect(() => retained()).toThrow("MAINTENANCE_PAUSED");
      expect(() => ledger.transition(claim, 1, "frozen")).toThrow("MAINTENANCE_NOT_DRAINED");
      expect(completed).toBe(false);
      barrier.resolve();
      await pending;
      expect(ledger.transition(claim, 1, "frozen").mode).toBe("frozen");
      expect(() => retained()).toThrow("MAINTENANCE_PAUSED");
      expect(() => ledger.assertAdmitted(token, "mutation")).toThrow("MAINTENANCE_PAUSED");
      ledger.transition(claim, 2, "normal");
      expect(() => ledger.assertAdmitted(token, "mutation")).toThrow("MAINTENANCE_ADMISSION_REQUIRED");
    });
  });

  it("rechecks a retained operator claim after an await, without advancing the fence", async () => {
    await runInDurableObject(object(), async (_instance, ctx) => {
      const { ledger, config, claim } = fixture(ctx.storage);
      const barrier = Promise.withResolvers<void>();
      const retainedOperator = (async () => {
        await barrier.promise;
        return ledger.transition(claim, 0, "draining");
      })();
      const rejected = expect(retainedOperator).rejects.toThrow("ADMIN_REVOKED");
      config.ADMINS = [];
      barrier.resolve();
      await rejected;
      expect(ledger.snapshot()).toMatchObject({ mode: "normal", revision: 0 });
    });
  });

  it("does not mistake an uncertain remote failure for acknowledged completion", async () => {
    const stub = object();
    await runInDurableObject(stub, async (_instance, ctx) => {
      const { ledger, claim } = fixture(ctx.storage);
      ledger.admit("external-effect");
      await expect(Promise.reject(new Error("remote outcome unknown"))).rejects.toThrow("remote outcome unknown");
      ledger.transition(claim, 0, "draining");
    });
    await runInDurableObject(stub, (_instance, ctx) => {
      const { ledger, claim } = fixture(ctx.storage);
      expect(ledger.snapshot().pending["external-effect"]).toBe(1);
      expect(() => ledger.transition(claim, 1, "frozen")).toThrow("MAINTENANCE_NOT_DRAINED");
    });
  });

  it("persists pause and unknown work across separate invocations and ledger reconstruction", async () => {
    const stub = object();
    const tokens = await runInDurableObject(stub, (_instance, ctx) => {
      const { ledger, claim } = fixture(ctx.storage);
      const admissions = [ledger.admit("agent"), ledger.admit("gadget"), ledger.admit("external-effect")];
      ledger.transition(claim, 0, "draining");
      return admissions;
    });
    await runInDurableObject(stub, (_instance, ctx) => {
      const { ledger, claim } = fixture(ctx.storage);
      expect(ledger.snapshot()).toMatchObject({ mode: "draining", pending: { agent: 1, gadget: 1, "external-effect": 1 } });
      expect(() => ledger.admit("agent")).toThrow("MAINTENANCE_PAUSED");
      expect(() => ledger.transition(claim, 1, "frozen")).toThrow("MAINTENANCE_NOT_DRAINED");
      for (const token of tokens) { ledger.acknowledge(token); ledger.acknowledge(token); }
      expect(ledger.transition(claim, 1, "frozen").mode).toBe("frozen");
    });
    await runInDurableObject(stub, (_instance, ctx) => {
      const { ledger } = fixture(ctx.storage);
      expect(ledger.snapshot().mode).toBe("frozen");
      expect(() => ledger.admit("gadget")).toThrow("MAINTENANCE_PAUSED");
    });
  });

  it("keeps admitted OAuth pending during drain, blocks new initiation and rejects invented callbacks", async () => {
    await runInDurableObject(object(), (_instance, ctx) => {
      const { ledger, claim } = fixture(ctx.storage);
      const callback = ledger.admit("oauth");
      ledger.transition(claim, 0, "draining");
      expect(() => ledger.admit("oauth")).toThrow("MAINTENANCE_PAUSED");
      expect(() => ledger.assertAdmitted("invented", "oauth")).toThrow("MAINTENANCE_ADMISSION_REQUIRED");
      expect(() => ledger.assertAdmitted(callback, "external-effect")).toThrow("MAINTENANCE_ADMISSION_REQUIRED");
      expect(() => ledger.assertAdmitted(callback, "oauth")).not.toThrow();
      expect(() => ledger.transition(claim, 1, "frozen")).toThrow("MAINTENANCE_NOT_DRAINED");
      ledger.acknowledge(callback);
      expect(() => ledger.assertAdmitted(callback, "oauth")).toThrow("MAINTENANCE_ADMISSION_REQUIRED");
      expect(ledger.transition(claim, 1, "frozen").pending.oauth).toBe(0);
    });
  });

  it("uses revision CAS, requires drain, and never loses admissions when resuming normal", async () => {
    await runInDurableObject(object(), (_instance, ctx) => {
      const { ledger, claim } = fixture(ctx.storage);
      expect(() => ledger.transition(claim, 0, "frozen")).toThrow("MAINTENANCE_DRAIN_REQUIRED");
      const token = ledger.admit("mutation");
      ledger.transition(claim, 0, "draining");
      expect(() => ledger.transition(claim, 0, "normal")).toThrow("MAINTENANCE_REVISION_CONFLICT");
      expect(ledger.transition(claim, 1, "normal").pending.mutation).toBe(1);
      ledger.acknowledge(token);
      ledger.transition(claim, 2, "draining");
      ledger.transition(claim, 3, "frozen");
      expect(() => ledger.transition(claim, 4, "draining")).toThrow("INVALID_MAINTENANCE_TRANSITION");
      expect(ledger.snapshot()).toMatchObject({ mode: "frozen", revision: 4 });
    });
  });

  it("fails closed on a partially initialized schema or missing state", async () => {
    await runInDurableObject(object(), (_instance, ctx) => {
      fixture(ctx.storage);
      ctx.storage.sql.exec("DELETE FROM maintenance_meta");
      expect(() => fixture(ctx.storage)).toThrow("MAINTENANCE_UNAVAILABLE");
    });
    await runInDurableObject(object(), (_instance, ctx) => {
      fixture(ctx.storage);
      ctx.storage.sql.exec("DROP TABLE maintenance_admissions");
      expect(() => fixture(ctx.storage)).toThrow("MAINTENANCE_UNAVAILABLE");
    });
  });
});
