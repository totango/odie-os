// Test-only native RPC harness. Production imports none of these fixture constructors or controls.
import { DurableObject } from "cloudflare:workers";
import { RequestBuildFixture } from "../../../gatekeeper-sessions/__tests__/request-build-fixture.js";
import { RequestBuilds } from "../../src/request-builds.js";
import { RequestBuildOutbox } from "../../src/request-build-outbox.js";
import { AdminAuthorityState } from "../../src/admin-authority.js";
import { providerFixtureBaseline } from "../admin-authority-fixture.js";

export class ProfileFixture extends DurableObject {
  initialize(profileId) {
    this.ctx.storage.kv.put("profileId", profileId);
  }
  whoamiIfExists() {
    const id = this.ctx.storage.kv.get("profileId");
    return id ? { id, name: "Fixture existing account" } : null;
  }
}
import {
  readRequestBuildGitHub,
  writeRequestBuildGitHub,
} from "../../../gatekeeper-sessions/src/request-build-github.js";
import { parseRequestBuildPolicy } from "../../../gatekeeper-sessions/src/request-build-policy.js";

export class ExecutionFixture extends RequestBuildFixture {
  controller() {
    const controller = super.controller();
    controller.deps.authorize = (owner, request) =>
      this.env.BUILDS.getByName(this.ctx.storage.kv.get("backendName")).authorize(owner, request);
    return controller;
  }
  async ensure(owner, intent) {
    const result = await this.controller().ensure(owner, intent);
    if (this.ctx.storage.kv.get("lost-ensure")) {
      this.ctx.storage.kv.delete("lost-ensure");
      throw new Error("lost ensure response");
    }
    return result;
  }
  receipt(owner, key) {
    const c = this.controller(),
      r = c.get(owner, key);
    if (!r) return null;
    const receipt = c.receipt(r);
    return this.ctx.storage.kv.get("wrong-receipt-generation")
      ? { ...receipt, generation: receipt.generation + 1 }
      : receipt;
  }
  artifact(owner, key) {
    return this.controller().artifact(owner, key);
  }
  cancel(owner, key, revision) {
    return this.controller().cancel(owner, key, revision);
  }
  async tick() {
    await this.ctx.storage.deleteAlarm();
    await this.controller().alarm();
  }
}

export class BuildFixture extends DurableObject {
  authority() {
    return new AdminAuthorityState(
      this.ctx.storage,
      this.env.USERS,
      { ADMINS: this.ctx.storage.kv.get("seeds") ?? [] },
      async (meta) => {
        if (
          !this.ctx.storage.kv.get("fixtureGuard") ||
          this.ctx.storage.kv.get("fixtureLegacyReferences") !== 0
        )
          throw new Error("fixture cutover unavailable");
        return { ...meta, legacyDrained: true, providersCurrent: true, providerBaseline: providerFixtureBaseline };
      },
    );
  }
  async initialize(name) {
    const seeds = [`${name}_admin`, `${name}_other`];
    this.ctx.storage.kv.put("seeds", seeds);
    for (const seed of seeds) await this.env.USERS.getByName(seed).initialize(seed);
    const state = this.authority();
    const principal = (seed) => this.env.USERS.idFromName(seed).toString();
    const legacy = state.issue(principal(seeds[0]), seeds[0], "administration");
    const preview = await state.preview(legacy);
    await state.prepare(legacy, {
      expectedRevision: 0,
      mutationKey: "prepare",
      digest: preview.digest,
    });
    this.ctx.storage.kv.put("fixtureGuard", true);
    this.ctx.storage.kv.put("fixtureLegacyReferences", 0);
    await state.activate(legacy, { expectedRevision: 1, mutationKey: "activate" });
    return seeds.map((seed) => state.issue(principal(seed), seed, "request-build"));
  }
  controller() {
    const kv = this.ctx.storage.kv;
    const execution = (owner) => this.env.EXECUTION.getByName(owner.userId);
    // Fault only alarm I/O; all transactions and rows still use real workerd SQLite.
    const storage = this.ctx.storage;
    const alarmStorage = new Proxy(storage, {
      get(target, property) {
        if (property === "setAlarm") return async (at) => {
          const committed = target.sql.exec("SELECT COUNT(*) AS n FROM build_runs").one().n;
          kv.put("armCommittedRows", [...(kv.get("armCommittedRows") ?? []), committed]);
          if (committed && kv.get("failCommittedAlarm")) {
            kv.delete("failCommittedAlarm");
            throw new Error("fixture committed alarm failure");
          }
          return target.setAlarm(at);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let readinessCalls = 0;
    return new RequestBuilds(alarmStorage, {
      notificationOrigin: "https://workshop.example.invalid",
      notifierGeneration: "fixture-generation-1",
      notifier: {
        requestBuildNotifierReadiness: () => this.env.NOTIFIER.requestBuildNotifierReadiness(),
        notifyRequestBuild: async (request, generation) => {
          try { return await this.env.NOTIFIER.notifyRequestBuild(request, generation); }
          catch (error) { kv.put("notificationError", String(error)); throw error; }
        },
      },
      sessions: {
        requestBuildReadiness: async () => {
          if (++readinessCalls === 2 && kv.get("wakeBeforeCommit")) {
            kv.delete("wakeBeforeCommit");
            // Deterministically consume an existing wake during final admission I/O.
            await storage.setAlarm(Date.now() + 60_000);
            await storage.deleteAlarm();
            await this.controller().alarm();
            kv.put("preCommitWake", {
              rows: storage.sql.exec("SELECT COUNT(*) AS n FROM build_runs").one().n,
              alarm: await storage.getAlarm(),
            });
          }
          return {
            ...parseRequestBuildPolicy(kv.get("policy")),
            ...(kv.get("oldProvider") ? {} : { protocolVersion: "request-build-git-data-v1" }),
          };
        },
        ensureRequestBuild: (owner, intent) => execution(owner).ensure(owner, intent),
        getRequestBuildReceipt: (owner, key) => {
          if (kv.get("receipt-callback-unavailable")) throw new Error("registry callback unavailable");
          return execution(owner).receipt(owner, key);
        },
        cancelRequestBuildExecution: (owner, key, revision) =>
          execution(owner).cancel(owner, key, revision),
        getRequestBuildArtifact: (owner, key) => execution(owner).artifact(owner, key),
        readRequestBuildGitHub: (op) => {
          if (op.kind === "base" && kv.get("spec-drift")) {
            kv.delete("spec-drift");
            kv.put("revision", (kv.get("revision") ?? 1) + 1);
          }
          return readRequestBuildGitHub(this.env, op);
        },
        writeRequestBuildGitHub: (owner, auth, op) =>
          writeRequestBuildGitHub(
            this.env,
            { authorizeRequestBuild: (o, r) => this.authorize(o, r) },
            owner,
            auth,
            op,
          ),
      },
      assertCurrent: async (claim) => {
        if (kv.get("outage")) throw new Error("ADMIN_AUTHORITY_UNAVAILABLE");
        this.authority().assertCurrent(claim, "request-build");
        if (kv.get("benign-version-drift")) {
          kv.delete("benign-version-drift");
          const row = storage.sql.exec("SELECT runId,value FROM build_runs WHERE slot=1").toArray()[0];
          if (row) {
            const value = JSON.parse(row.value);
            value.version++;
            value.updatedAt = Date.now();
            storage.sql.exec("UPDATE build_runs SET value=? WHERE runId=?", JSON.stringify(value), row.runId);
          }
        }
      },
      eligibility: async (claim, model) => {
        if (kv.get("ineligible") || model !== "fixture-model") throw new Error("ineligible");
        return { userId: claim.principalId, email: claim.profileId };
      },
      activationReasons: async () => (kv.get("blocked") ? ["BUILD_IMAGE_UNVERIFIED"] : []),
      publicationPolicy: () => ({
        version: "fixture-1",
        allowedPaths: ["a.ts"],
        changedLines: 4,
        textBytes: 4096,
      }),
      contextFile: async () => null,
      specification: (id) =>
        kv.get("hidden") || id !== kv.get("requestId")
          ? null
          : {
              revision: kv.get("revision") ?? 1,
              specification: "feature: Fixture\n\nChange a to b",
              contextFiles: [],
              open: true,
            },
    });
  }
  authorize(owner, request) {
    return this.controller().authorize(owner, request);
  }
  async alarm() {
    await this.controller().alarm();
  }
  async operation(input) {
    if (navigator.userAgent !== "Cloudflare-Workers") throw new Error("workerd required");
    const kv = this.ctx.storage.kv,
      c = this.controller();
    if (input.op === "initialize") return this.initialize(input.name);
    if (input.op === "revoke") {
      const state = this.authority(),
        actor = state.issue(input.actor.principalId, input.actor.profileId, "administration");
      return state.revoke(actor, {
        expectedRevision: state.list(actor).revision,
        mutationKey: "revoke",
        principalId: input.principalId,
      });
    }
    if (input.op === "configure") {
      for (const [key, value] of Object.entries(input.fields)) kv.put(key, value);
      return true;
    }
    if (input.op === "start") return c.start(input.claim, input.input);
    if (input.op === "cancel") return c.cancel(input.claim, input.input);
    if (input.op === "get") return c.get(input.requestId, input.runId);
    if (input.op === "list") return c.list(input.requestId);
    if (input.op === "readiness") return c.readiness(input.claim, input.requestId);
    if (input.op === "authorize") return c.authorize(input.owner, input.request);
    if (input.op === "tick") {
      // Reconstructing both controllers on every call exercises persisted, not in-memory, progress.
      await this.ctx.storage.deleteAlarm();
      this.ctx.storage.sql.exec("UPDATE build_runs SET value=json_set(value,'$.retryAt',0)");
      await c.alarm();
    }
    if (input.op === "recover") {
      await this.ctx.storage.deleteAlarm();
      await c.recover();
    }
    const rows = this.ctx.storage.sql.exec("SELECT value,slot FROM build_runs").toArray();
    return {
      runtime: navigator.userAgent,
      runs: rows.map((r) => JSON.parse(r.value)),
      notificationError: this.ctx.storage.kv.get("notificationError"),
      armCommittedRows: kv.get("armCommittedRows"),
      preCommitWake: kv.get("preCommitWake"),
      keys: this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM build_keys").one().n,
      slots: rows.filter((r) => r.slot === 1).length,
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
}
export class NotificationFixture extends DurableObject {
  /** Tests explicitly drive due/recover/tick; the production board owns the real alarm handler. */
  async alarm() {}
  async operation(input) {
    const kv = this.ctx.storage.kv;
    const notifier = this.env[`NOTIFIER${kv.get("receiver") ?? ""}`];
    const outbox = new RequestBuildOutbox(this.ctx.storage, {
      requestBuildNotifierReadiness: async () => {
        if (kv.get("missing")) return { protocol: "request-build-slack-v1", configured: false, destinationVerified: false, posting: "unproven" };
        const ready = await notifier.requestBuildNotifierReadiness();
        return { ...ready, ...kv.get("readinessPatch") };
      },
      notifyRequestBuild: async (request, generation) => {
        const result = await notifier.notifyRequestBuild(request, generation);
        if (kv.get("lostAck")) throw new Error("fixture lost acknowledgement");
        return result;
      },
    }, async () => !kv.get("revoked") && !kv.get("hidden"), kv.get("generation") ?? "fixture-generation-1");
    if (input.op === "configure") for (const [key, value] of Object.entries(input.fields)) kv.put(key, value);
    if (input.op === "enqueue") outbox.enqueue(input.notification);
    if (input.op === "notifierReadiness") return notifier.requestBuildNotifierReadiness();
    if (input.op === "direct") return notifier.notifyRequestBuild(input.notification, input.generation ?? "fixture-generation-1");
    if (input.op === "due") this.ctx.storage.sql.exec("UPDATE build_notifications SET retryAt=0");
    if (input.op === "recover") await outbox.recover();
    if (input.op === "crash") this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE build_notifications SET state='sending',attempts=1");
      this.ctx.storage.sql.exec("INSERT INTO build_notification_attempts SELECT key,1,?,NULL,'sending',NULL FROM build_notifications", Date.now());
    });
    if (input.op === "tick") { await this.ctx.storage.deleteAlarm(); await outbox.alarm(); }
    return { runtime: navigator.userAgent,
      notifications: this.ctx.storage.sql.exec("SELECT * FROM build_notifications").toArray(),
      attempts: this.ctx.storage.sql.exec("SELECT * FROM build_notification_attempts").toArray(),
      alarm: await this.ctx.storage.getAlarm() };
  }
}
// Actual production factory, still retaining every unrelated activation blocker.
export { CommunityRequests } from "../../src/community-requests";
export default {
  async fetch(request, env) {
    try {
      const input = await request.json();
      const name = new URL(request.url).pathname.slice(1);
      const result = input.productionBoard
        ? await env.BOARD.getByName(name).requestBuildReadiness(input.claim, input.requestId)
        : input.outbox
        ? await env.NOTIFICATIONS.getByName(name).operation(input)
        : input.execution
        ? await env.EXECUTION.getByName(name).operation(input)
        : await env.BUILDS.getByName(name).operation(input);
      return Response.json(result ?? null);
    } catch (error) {
      return Response.json({ error: error.message }, { status: 409 });
    }
  },
};
