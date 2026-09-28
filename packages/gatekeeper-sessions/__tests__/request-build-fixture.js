import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { RequestBuildExecution } from "../src/request-build-execution.js";
import sessionsWorker, { requestBuildReadiness } from "../src/sessions.js";
export { CodingSessionRegistry, CodingSessionPolicy } from "../src/sessions.js";
import { parseRequestBuildPolicy } from "../src/request-build-policy.js";

/** Test-only provider boundary: no SDK/container, credentials, model/network or publication operation. */
export class RequestBuildFixture extends DurableObject {
  async alarm() { await this.controller().alarm(); }
  controller() {
    return new RequestBuildExecution(this.ctx.storage, {
      readiness: () => parseRequestBuildPolicy(this.ctx.storage.kv.get("policy")),
      authorize: async (_owner, request) => {
        this.ctx.storage.kv.put("last-authorization", request);
        return this.ctx.storage.kv.get("denied") ? { allowed: false, reasons: ["FIXTURE_REVOKED"] } : { allowed: true, ...request };
      },
      contextFile: async (_owner, _request, fileId) =>
        new Uint8Array(this.ctx.storage.kv.get(`context:${fileId}`) ?? []),
      sandbox: () => ({
        mkdir: async () => ({}),
        writeFile: async (path, stream) => {
          const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
          this.ctx.storage.kv.put("writes", [...(this.ctx.storage.kv.get("writes") ?? []), {path, bytes: [...bytes]}]);
          return {};
        },
        exec: async argv => {
          const n = (this.ctx.storage.kv.get("execs") ?? 0) + 1;
          this.ctx.storage.kv.put("execs", n);
          this.ctx.storage.kv.put(`argv:${n}`, argv);
          if (this.ctx.storage.kv.get("lose-start") === n) throw new Error("provider response lost");
          return this.process(String(n));
        },
        getProcess: async id => this.ctx.storage.kv.get("process-lost") ? null : this.process(id),
        destroy: async () => {
          this.ctx.storage.kv.put("destroys", (this.ctx.storage.kv.get("destroys") ?? 0) + 1);
          if (this.ctx.storage.kv.get("destroy-failed")) throw new Error("cleanup unavailable");
        },
      }),
      configure: async () => { this.ctx.storage.kv.put("configured", true); },
      disable: async () => { this.ctx.storage.kv.put("disabled", true); },
      acquire: async r => {
        if (this.ctx.storage.kv.get("capacity-denied")) return false;
        this.ctx.storage.kv.put("slot", r.dispatchKey); return true;
      },
      release: async r => {
        if (this.ctx.storage.kv.get("slot") === r.dispatchKey) this.ctx.storage.kv.delete("slot");
      },
      reserveSession: r => { this.ctx.storage.kv.put(`session:${r.sessionId}`, { generation: r.generation, sandboxId: r.sandboxId }); },
      updateSession: () => {},
      current: r => !this.ctx.storage.kv.get("stale") && this.ctx.storage.kv.get(`session:${r.sessionId}`)?.generation === r.generation,
      arm: async () => {
        if (this.ctx.storage.kv.get("alarm-failed")) throw new Error("alarm unavailable");
        const alarm = await this.ctx.storage.getAlarm();
        if (alarm === null || alarm > Date.now() + 60000) await this.ctx.storage.setAlarm(Date.now() + 60000);
      },
    });
  }
  process(id) {
    return {
      id,
      status: async () => {
        if (this.ctx.storage.kv.get("process-running")) return { state: "running" };
        if (this.ctx.storage.kv.get("process-error-id") === id)
          return { state: "error", error: { code: "SPAWN", message: "Executable not found: fixture" } };
        return { state: "exited", exit: { code: this.ctx.storage.kv.get("failed-process-id") === id ? 1 : 0 } };
      },
      output: async () => {
        this.ctx.storage.kv.put("output-reads", (this.ctx.storage.kv.get("output-reads") ?? 0) + 1);
        if (this.ctx.storage.kv.get("output-throws-id") === id) throw new Error("fixture output unavailable");
        return { stdout: id === "3" ? "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n" : "", stderr: this.ctx.storage.kv.get("process-stderr") ?? "", exitCode: 0, timedOut: false, truncated: !!this.ctx.storage.kv.get("truncated") };
      },
    };
  }
  async operation({ op, owner, intent, key, revision, fields }) {
    if (navigator.userAgent !== "Cloudflare-Workers") throw new Error("real workerd required");
    const c = this.controller();
    if (op === "configure") { for (const [k, v] of Object.entries(fields)) this.ctx.storage.kv.put(k, v); return true; }
    if (op === "ensure") return c.ensure(owner, intent);
    if (op === "legacy-context") {
      const record = c.get(owner, key);
      if (!record) throw new Error("fixture record missing");
      delete record.intent.contextFiles;
      this.ctx.storage.kv.put(`request-build:${key}`, record);
      return true;
    }
    if (op === "cancel") return c.cancel(owner, key, revision);
    if (op === "artifact") return c.artifact(owner, key);
    if (op === "tick") { await this.ctx.storage.deleteAlarm(); await c.alarm(); }
    if (op === "expire") {
      const r = c.get(owner, key); this.ctx.storage.kv.put(`request-build:${key}`, { ...r, deadline: Date.now() - 1 });
    }
    const record = key ? c.get(owner, key) : null;
    return { runtime: navigator.userAgent, receipt: record ? c.receipt(record) : null,
      sessions: [...this.ctx.storage.kv.list({prefix:"session:"})].length,
      execs: this.ctx.storage.kv.get("execs") ?? 0, destroys: this.ctx.storage.kv.get("destroys") ?? 0,
      outputReads: this.ctx.storage.kv.get("output-reads") ?? 0,
      writes: this.ctx.storage.kv.get("writes") ?? [],
      slot: this.ctx.storage.kv.get("slot") ?? null, disabled: this.ctx.storage.kv.get("disabled") ?? false,
      alarm: await this.ctx.storage.getAlarm(), work: c.hasWork(), authorization: this.ctx.storage.kv.get("last-authorization") };
  }
}

/** Private, local verified authority fixture; no production entrypoint imports this file. */
export class BuildAuthorityFixture extends WorkerEntrypoint {
  async authorizeRequestBuild(_owner, request) { return {allowed:true,...request}; }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const data = await request.json();
      if (data.op === "readiness") return Response.json(requestBuildReadiness({...env, ...data.fields}));
      const registry = env.SESSION_REGISTRIES.getByName(data.owner.userId);
      if (data.op === "registry-ensure") return Response.json(await registry.ensureRequestBuild(data.owner,data.intent));
      if (data.op === "registry-inspect") return Response.json({receipt:await registry.getRequestBuildReceipt(data.owner,data.key),sessions:await registry.listSessions(),metadata:await registry.getSessionMetadata(data.sessionId) ?? null,current:await registry.isCurrentSessionGeneration(data.sessionId,"not-authorized")});
      if (data.op === "public-denial") return Response.json({status:(await sessionsWorker.fetch(new Request("https://sessions.invalid/request-build/ensure",{method:"POST"}),env,ctx)).status});
      return Response.json(await env.FIXTURE.getByName(new URL(request.url).pathname).operation(data));
    }
    catch (error) { return Response.json({error:error.message}, {status:409}); }
  },
};
