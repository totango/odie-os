import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestBuildPolicy } from "@gadgets/workshop-shared/coding-sessions";
const require = createRequire(import.meta.url);
const tooling = createRequire(require.resolve("wrangler/package.json"));
const sessionsRequire = createRequire(
  new URL("../../../gatekeeper-sessions/package.json", import.meta.url).href,
);
const { Miniflare, convertV4MiniflareOptions } = tooling("miniflare");
const { build } = tooling("esbuild");
const policy: RequestBuildPolicy = {
  version: "fixture-1",
  runtimeVersion: "0.85.1",
  model: "fixture-model",
  wallTimeMs: 120000,
  modelCalls: 2,
  spendMicros: 2000,
  callChargeMicros: 1000,
  modelInputBytes: 8192,
  modelOutputTokens: 200,
  outputBytes: 8192,
  diffBytes: 4096,
  diffFiles: 2,
  concurrency: 1,
  dependencyHosts: [],
};
let claim = {
  principalId: "fixture-admin",
  profileId: "admin@example.invalid",
  epoch: "fixture-epoch",
  mode: "managed",
  generation: 1,
  purpose: "request-build",
};
let other = { ...claim, principalId: "fixture-other-admin", profileId: "other@example.invalid" };
const baseSha = "a".repeat(40),
  baseTree = "b".repeat(40);
const hash = (content: string) => createHash("sha1").update(content).digest("hex");
const aBlob = hash("blob 2\0a\n"),
  bBlob = hash("blob 2\0b\n");
const entry = (sha: string) => ({ path: "a.ts", mode: "100644", type: "blob", sha });

describe("request-build actual backend/Sessions workerd lifecycle with mocked GitHub HTTP", () => {
  let mf: InstanceType<typeof Miniflare>;
  const owners = new Map<string, string>();
  const trees = new Map<string, object>([
    [baseTree, { sha: baseTree, truncated: false, tree: [entry(aBlob)] }],
  ]);
  const commits = new Map<string, object>([
    [baseSha, { sha: baseSha, tree: { sha: baseTree }, parents: [], message: "base" }],
  ]);
  const refs = new Map<string, string>();
  const pulls: Record<string, unknown>[] = [];
  const writes: string[] = [];
  let lose: string | null = null;
  let onWrite: ((path: string) => Promise<void>) | null = null;
  const notifications: unknown[] = [];
  let slackMode = "ack";
  let slackReadMode = "ok", slackReadCount = 0;
  const slackReadTokens: string[] = [];
  let slackChannelPatch: Record<string, unknown> = {}, slackIdentityPatch: Record<string, unknown> = {};
  let slackScopes = "chat:write,channels:read,groups:read";
  let afterSlackRead: (() => void) | undefined;
  async function github(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin === "https://slack.com" && ["/api/auth.test", "/api/conversations.info"].includes(url.pathname)) {
      expect(request.method).toBe("GET");
      const authorization = request.headers.get("Authorization")!;
      expect(["Bearer fixture-not-a-credential", "Bearer rotated-fixture-not-a-credential"]).toContain(authorization);
      slackReadTokens.push(authorization);
      slackReadCount++;
      if (slackReadMode === "redirect") return new Response(null, { status: 302, headers: { location: "https://forbidden.example.invalid" } });
      if (slackReadMode === "timeout") {
        await new Promise(resolve => setTimeout(resolve, 5000));
        return new Response(null, { status: 503 });
      }
      if (slackReadMode === "server") return new Response(null, { status: 503 });
      if (slackReadMode === "large") return new Response("x".repeat(32769));
      if (slackReadMode === "malformed") return new Response("not JSON");
      if (slackReadMode === "revoked") return Response.json({ ok: false, error: "token_revoked" });
      const headers = { "x-oauth-scopes": slackScopes };
      if (url.pathname === "/api/auth.test") return Response.json({ ok: true,
        team_id: "T1234567890", user_id: "U1234567890", bot_id: "B1234567890", ...slackIdentityPatch }, { headers });
      expect(url.searchParams.get("channel")).toBe("C1234567890");
      const response = Response.json({ ok: true, channel: { id: "C1234567890", context_team_id: "T1234567890",
        is_channel: true, is_group: false, is_private: false, is_im: false, is_mpim: false,
        is_archived: false, is_member: true, is_shared: false, is_ext_shared: false, is_org_shared: false,
        ...slackChannelPatch } }, { headers });
      afterSlackRead?.();
      return response;
    }
    if (url.href === "https://slack.com/api/chat.postMessage") {
      expect(request.method).toBe("POST");
      const payload = await request.json();
      notifications.push(payload);
      if (slackMode === "no-permission") return Response.json({ ok: false, error: "restricted_action" });
      if (slackMode === "rate") return Response.json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "Retry-After": "7" } });
      if (slackMode === "bad-rate") return Response.json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "Retry-After": "999999" } });
      if (slackMode === "conflict-rate") return Response.json({ ok: true, ts: "1789000000.000001" }, { status: 429, headers: { "Retry-After": "1" } });
      if (slackMode === "redirect") return new Response(null, { status: 302, headers: { location: "https://forbidden.example.invalid" } });
      if (slackMode === "large") return new Response("x".repeat(32_769));
      if (slackMode === "malformed") return new Response("not JSON");
      if (slackMode === "server") return new Response(null, { status: 503 });
      return Response.json({ ok: true, channel: slackMode === "wrong-channel" ? "C9999999999" : "C1234567890", ts: "1789000000.000001" });
    }
    if (url.origin !== "https://api.github.com") throw new Error("unexpected external origin");
    if (url.pathname === "/app/installations/fixture/access_tokens") {
      const body = (await request.json()) as {
        repositories: string[];
        permissions: Record<string, string>;
      };
      expect(body.repositories).toEqual(["odie-os"]);
      expect(body.permissions).not.toHaveProperty("issues");
      return Response.json({
        token: "fixture-token-not-a-real-credential",
        expires_at: "2099-01-01T00:00:00Z",
        permissions: body.permissions,
        repositories: [{ full_name: "totango/odie-os" }],
      });
    }
    expect(url.pathname.startsWith("/repos/totango/odie-os/")).toBe(true);
    const path = url.pathname.slice("/repos/totango/odie-os".length);
    if (request.method === "GET") {
      if (path === "/git/ref/heads/main")
        return Response.json({ ref: "refs/heads/main", object: { type: "commit", sha: baseSha } });
      if (path.startsWith("/git/commits/"))
        return Response.json(commits.get(path.split("/").at(-1)!) ?? null);
      if (path.startsWith("/git/trees/"))
        return Response.json(trees.get(path.split("/").at(-1)!) ?? null);
      if (path === `/git/blobs/${aBlob}`)
        return Response.json({ sha: aBlob, encoding: "base64", content: btoa("a\n"), size: 2 });
      if (path.startsWith("/git/ref/heads/request-build/")) {
        const branch = path.slice("/git/ref/heads/".length),
          sha = refs.get(branch);
        return sha
          ? Response.json({ ref: `refs/heads/${branch}`, object: { type: "commit", sha } })
          : new Response(null, { status: 404 });
      }
      if (path === "/pulls")
        return Response.json(
          pulls.filter(
            (p) =>
              (p.head as { ref: string }).ref ===
              url.searchParams.get("head")?.slice("totango:".length),
          ),
        );
      if (path.startsWith("/pulls/"))
        return Response.json(
          pulls.find((p) => p.number === Number(path.split("/").at(-1))) ?? null,
        );
      throw new Error(`unexpected read ${path}`);
    }
    expect(request.method).toBe("POST");
    const body = (await request.json()) as Record<string, unknown>;
    writes.push(path);
    let response: Record<string, unknown>;
    if (path === "/git/trees") {
      expect(body.base_tree).toBe(baseTree);
      expect(body.tree).toEqual([{ path: "a.ts", mode: "100644", type: "blob", content: "b\n" }]);
      const sha = hash(JSON.stringify(body));
      response = { sha };
      trees.set(sha, { sha, truncated: false, tree: [entry(bBlob)] });
    } else if (path === "/git/commits") {
      const sha = hash(JSON.stringify(body));
      response = {
        sha,
        tree: { sha: body.tree },
        parents: (body.parents as string[]).map((parentSha) => ({ sha: parentSha })),
        message: body.message,
      };
      commits.set(sha, response);
    } else if (path === "/git/refs") {
      const branch = String(body.ref).slice("refs/heads/".length);
      expect(branch).toMatch(/^request-build\/[a-f0-9-]{36}\/\d+$/);
      expect(refs.has(branch)).toBe(false);
      refs.set(branch, String(body.sha));
      response = { ref: body.ref, object: { type: "commit", sha: body.sha } };
    } else if (path === "/pulls") {
      expect(body.base).toBe("main");
      expect(body.draft).toBe(true);
      const number = pulls.length + 1;
      response = {
        number,
        html_url: `https://github.com/totango/odie-os/pull/${number}`,
        draft: true,
        body: body.body,
        head: {
          ref: body.head,
          sha: refs.get(String(body.head)),
          repo: { full_name: "totango/odie-os" },
        },
        base: { ref: "main", sha: baseSha, repo: { full_name: "totango/odie-os" } },
      };
      pulls.push(response);
    } else throw new Error(`unexpected write ${path}`);
    await onWrite?.(path);
    if (lose === path) {
      lose = null;
      return new Response(null, { status: 503 });
    }
    return Response.json(response);
  }
  beforeAll(async () => {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("./fixture.js", import.meta.url).href)],
      bundle: true,
      write: false,
      format: "esm",
      target: "es2022",
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      mainFields: ["module", "main"],
      external: ["cloudflare:*", "node:*"],
      plugins: [
        require("capnweb-validate/esbuild")({ include: ["src/**/*.ts"] }),
        sessionsRequire("capnweb-validate/esbuild")({
          cwd: fileURLToPath(new URL("../../../gatekeeper-sessions/", import.meta.url).href),
          tsconfig: "tsconfig.json",
          include: ["src/**/*.ts"],
        }),
      ],
    });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const notifierBundle = await build({
      entryPoints: [fileURLToPath(new URL("../../../gatekeeper-jarvis/src/request-build-notifier.ts", import.meta.url).href)],
      bundle: true, write: false, format: "esm", target: "es2022", platform: "neutral",
      conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], external: ["cloudflare:*", "node:*"],
    });
    mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
      outboundService: github,
      name: "request-build-control-fixture",
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-02-02",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        REQUEST_BUILD_WORKSHOP_ORIGIN: "https://workshop.example.invalid",
        REQUEST_BUILD_NOTIFIER_GENERATION: "fixture-generation-1",
        GITHUB_APP_ID: "fixture",
        GITHUB_APP_INSTALLATION_ID: "fixture",
        GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
      },
      serviceBindings: {
        REQUEST_BUILD_NOTIFIER: { name: "request-build-notifier-fixture", entrypoint: "RequestBuildNotifierEntrypoint" },
        ...Object.fromEntries(["", "_PRIVATE", "_ROTATED", "_MISSING"].map(suffix => [
          `NOTIFIER${suffix}`, { name: `request-build-notifier-fixture${suffix}`, entrypoint: "RequestBuildNotifierEntrypoint" },
        ])),
      },
      durableObjects: {
        BOARD: { className: "CommunityRequests", useSQLite: true },
        NOTIFICATIONS: { className: "NotificationFixture", useSQLite: true },
        BUILDS: { className: "BuildFixture", useSQLite: true },
        EXECUTION: { className: "ExecutionFixture", useSQLite: true },
        USERS: { className: "ProfileFixture", useSQLite: true },
      },
    }, ...["", "_PRIVATE", "_ROTATED", "_MISSING"].map(suffix => ({
      name: `request-build-notifier-fixture${suffix}`, outboundService: github,
      modules: true, script: notifierBundle.outputFiles[0].text,
      compatibilityDate: "2026-02-02",
      bindings: {
        REQUEST_BUILD_SLACK_TOKEN: suffix === "_ROTATED" ? "rotated-fixture-not-a-credential" : "fixture-not-a-credential",
        REQUEST_BUILD_SLACK_CHANNEL: "C1234567890",
        REQUEST_BUILD_SLACK_TEAM_ID: suffix === "_MISSING" ? "" : "T1234567890",
        REQUEST_BUILD_SLACK_BOT_USER_ID: "U1234567890",
        REQUEST_BUILD_SLACK_BOT_ID: "B1234567890",
        REQUEST_BUILD_SLACK_CHANNEL_TYPE: suffix === "_PRIVATE" ? "private" : "public",
        REQUEST_BUILD_NOTIFIER_GENERATION: suffix === "_ROTATED" ? "fixture-generation-2" : "fixture-generation-1",
        REQUEST_BUILD_WORKSHOP_ORIGIN: "https://workshop.example.invalid",
      },
    }))] }));
    await mf.ready;
  });
  afterAll(async () => {
    await mf?.dispose();
  });
  async function call(name: string, op: string, extra: Record<string, unknown> = {}) {
    const target = extra.execution ? (owners.get(name) ?? name) : name;
    return (
      await mf.dispatchFetch(`http://fixture.invalid/${target}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, ...extra }),
      })
    ).json();
  }
  async function setup(name: string) {
    const requestId = crypto.randomUUID();
    [claim, other] = await call(name, "initialize", { name });
    owners.set(name, claim.principalId);
    await call(name, "configure", { fields: { policy: JSON.stringify(policy), requestId } });
    await call(name, "configure", {
      execution: true,
      fields: { policy: JSON.stringify(policy), backendName: name },
    });
    return {
      requestId,
      input: { requestId, expectedRequestRevision: 1, mutationKey: crypto.randomUUID() },
    };
  }
  async function tick(name: string, count = 1) {
    for (let n = 0; n < count; n++) {
      await call(name, "tick");
      await call(name, "tick", { execution: true });
    }
    return call(name, "inspect");
  }
  it("reaches real typed transport draft PR creation, no browser completion and no public private fields", async () => {
    const name = "positive",
      { requestId, input } = await setup(name);
    expect(await call(name, "readiness", { claim, requestId })).toMatchObject({
      ready: true,
      requestRevision: 1,
    });
    const run = await call(name, "start", { claim, input });
    expect(run).toMatchObject({ state: "queued", requestRevision: 1 });
    expect(await call(name, "start", { claim, input })).toMatchObject({ runId: run.runId });
    expect(await call(name, "recover")).toMatchObject({
      runtime: "Cloudflare-Workers",
      slots: 1,
      alarm: expect.any(Number),
    });
    const done = await tick(name, 22);
    expect(done.runs[0]).toMatchObject({ state: "pr_created", cleanup: "complete" });
    expect(done.slots).toBe(0);
    const publicRun = await call(name, "get", { requestId, runId: run.runId });
    expect(publicRun.pullRequest.url).toMatch(
      /^https:\/\/github.com\/totango\/odie-os\/pull\/\d+$/,
    );
    expect(Object.keys(publicRun).toSorted()).toEqual(
      [
        "runId",
        "requestId",
        "requestRevision",
        "state",
        "attempt",
        "createdAt",
        "updatedAt",
        "cleanup",
        "pullRequest",
        "cancelTooLate",
        "notification",
      ].toSorted(),
    );
    expect(writes).toEqual(["/git/trees", "/git/commits", "/git/refs", "/pulls"]);
    expect(done.notificationError).toBeUndefined();
    expect(notifications).toHaveLength(1);
    expect(publicRun.notification).toBe("acknowledged");
    expect(notifications).toEqual([{ channel: "C1234567890", unfurl_links: false, unfurl_media: false,
      text: `Draft community-request PR created. Request: https://workshop.example.invalid/requests/${requestId}\nRun: https://workshop.example.invalid/requests/${requestId}/runs/${run.runId}\nPR: ${publicRun.pullRequest.url}` }]);
    await tick(name, 3);
    expect(notifications).toHaveLength(1);
    expect(await call(name, "list", { requestId })).toEqual([await call(name, "get", { requestId, runId: run.runId })]);
    await call(name, "configure", { fields: { hidden: true } });
    expect(await call(name, "get", { requestId, runId: run.runId })).toBeNull();
    expect(await call(name, "list", { requestId })).toEqual([]);
  });
  it("arms committed work after a pre-commit wake consumes the alarm during admission", async () => {
    const name = "start-precommit-wake", { input } = await setup(name);
    await call(name, "configure", { fields: { wakeBeforeCommit: true } });
    const run = await call(name, "start", { claim, input });
    expect(run.state).toBe("queued");
    const persisted = await call(name, "inspect");
    expect(persisted.preCommitWake).toEqual({ rows: 0, alarm: null });
    expect(persisted.armCommittedRows).toEqual([1]);
    expect(persisted).toMatchObject({ slots: 1, keys: 1, alarm: expect.any(Number) });
    expect(persisted.runs).toHaveLength(1);
    expect(persisted.runs[0].runId).toBe(run.runId);
  });
  it("retains committed start on alarm failure and actually re-arms on the same-key retry", async () => {
    const name = "start-postcommit-alarm-failure", { input } = await setup(name);
    await call(name, "configure", { fields: { failCommittedAlarm: true } });
    expect(await call(name, "start", { claim, input })).toEqual({ error: "fixture committed alarm failure" });
    const failed = await call(name, "inspect");
    expect(failed).toMatchObject({ slots: 1, keys: 1, alarm: null, armCommittedRows: [1] });
    expect(failed.runs).toHaveLength(1);
    // Each operation reconstructs the controller; retry must use its persisted receipt.
    const retried = await call(name, "start", { claim, input });
    expect(retried.runId).toBe(failed.runs[0].runId);
    const recovered = await call(name, "inspect");
    expect(recovered).toMatchObject({ slots: 1, keys: 1, alarm: expect.any(Number), armCommittedRows: [1, 1] });
    expect(recovered.runs).toHaveLength(1);
    await call(name, "start", { claim, input });
    const repeated = await call(name, "inspect");
    expect(repeated.alarm).toBe(recovered.alarm);
    expect(repeated.armCommittedRows).toEqual([1, 1]);
  });
  const notification = () => ({ origin: "https://workshop.example.invalid", requestId: crypto.randomUUID(), runId: crypto.randomUUID(), attempt: 1, prNumber: 42 });
  const box = (name: string, op: string, extra: Record<string, unknown> = {}) => call(name, op, { ...extra, outbox: true });
  it("production CommunityRequests clears only the computed notifier blocker, never legacy-provider/image/pricing", async () => {
    const args = { productionBoard: true, claim, requestId: crypto.randomUUID() };
    const before = notifications.length;
    const positive = await call("production-notifier-readiness", "readiness", args);
    expect(positive.ready).toBe(false);
    expect(positive.reasons).not.toContain("NOTIFIER_DESTINATION_UNVERIFIED");
    expect(positive.reasons).not.toContain("NOTIFIER_CONFIGURATION_UNAVAILABLE");
    expect(positive.reasons).not.toContain("FINANCE_GUARD_UNAVAILABLE");
    for (const reason of ["LEGACY_CAPABILITIES_UNDRAINED", "BUILD_IMAGE_UNVERIFIED", "BUILD_PRICING_UNVERIFIED", "BUILD_REPOSITORY_UNVERIFIED", "BUILD_MODEL_UNVERIFIED"]) {
      expect(positive.reasons).toContain(reason);
    }
    expect(Object.keys(positive).toSorted()).toEqual(["ready", "reasons"]);
    slackReadMode = "revoked";
    try {
      const denied = await call("production-notifier-readiness", "readiness", args);
      expect(denied.reasons).toContain("NOTIFIER_DESTINATION_UNVERIFIED");
      expect(denied.ready).toBe(false);
    } finally { slackReadMode = "ok"; }
    expect(notifications.length).toBe(before);
  });
  it("computes fresh private evidence without posting or exposing Slack identity; each delivery rechecks", async () => {
    const before = notifications.length, reads = slackReadCount;
    const evidence = await box("readiness-positive", "notifierReadiness");
    expect(evidence).toEqual({ protocol: "request-build-slack-v1", configured: true, destinationVerified: true,
      posting: "unproven", origin: "https://workshop.example.invalid", generation: "fixture-generation-1",
      checkedAt: expect.any(Number), expiresAt: evidence.checkedAt + 30_000 });
    expect(slackReadCount - reads).toBe(2);
    expect(notifications.length).toBe(before);
    await box("readiness-positive", "enqueue", { notification: notification() });
    expect((await box("readiness-positive", "tick")).notifications[0].state).toBe("acknowledged");
    expect(slackReadCount - reads).toBe(6); // Fresh outbox checks, then fresh receiver checks.
  });
  it.each(["redirect", "server", "large", "malformed", "revoked", "timeout"])("fails closed on Slack check %s without attempting a post", async mode => {
    const name = `read-${mode}`, before = notifications.length;
    slackReadMode = mode;
    try {
      expect(await box(name, "notifierReadiness")).toMatchObject({ configured: true, destinationVerified: false });
      await box(name, "enqueue", { notification: notification() });
      expect((await box(name, "tick")).notifications[0]).toMatchObject({ state: "blocked", attempts: 0 });
      expect(notifications.length).toBe(before);
    } finally { slackReadMode = "ok"; }
  });
  it("rejects wrong token workspace/user/bot and enterprise-wide identity", async () => {
    for (const patch of [{ team_id: "T9999999999" }, { user_id: "U9999999999" }, { bot_id: "B9999999999" }, { bot_id: null }, { is_enterprise_install: true }]) {
      slackIdentityPatch = patch;
      try { expect(await box("identity-mismatch", "notifierReadiness")).toMatchObject({ destinationVerified: false }); }
      finally { slackIdentityPatch = {}; }
    }
  });
  it("rejects wrong/missing channel identity and unsafe type/access/sharing flags", async () => {
    const patches = [
      { id: "C9999999999" }, { context_team_id: "T9999999999" }, { context_team_id: null },
      ...["is_archived", "is_im", "is_mpim", "is_shared", "is_ext_shared", "is_org_shared", "is_pending_ext_shared", "is_frozen", "is_read_only", "is_thread_only", "is_private"].map(field => ({ [field]: true })),
      { is_channel: false }, { is_group: true }, { is_member: false }, { is_member: null },
      { pending_shared: ["T9999999999"] }, { pending_connected_team_ids: ["T9999999999"] },
      { shared_team_ids: ["T1234567890", "T9999999999"] }, { is_frozen: "false" }, { pending_shared: null },
    ];
    for (const [i, patch] of patches.entries()) {
      slackChannelPatch = patch;
      try {
        const name = `unsafe-channel-${i}`, before = notifications.length;
        await box(name, "enqueue", { notification: notification() });
        expect((await box(name, "tick")).notifications[0].state).toBe("blocked");
        expect(notifications.length).toBe(before);
      } finally { slackChannelPatch = {}; }
    }
  });
  it("requires provider-owned type-specific read and write scopes, and accepts ordinary private groups", async () => {
    await box("private-channel", "configure", { fields: { receiver: "_PRIVATE" } });
    for (const scopes of ["", "channels:read", "chat:write", "chat:write,groups:read"]) {
      slackScopes = scopes;
      try { expect(await box("public-scopes", "notifierReadiness")).toMatchObject({ destinationVerified: false }); }
      finally { slackScopes = "chat:write,channels:read,groups:read"; }
    }
    slackChannelPatch = { is_private: true, is_channel: false, is_group: true, shared_team_ids: ["T1234567890"],
      pending_shared: [], pending_connected_team_ids: [], is_frozen: false };
    try {
      slackScopes = "chat:write,channels:read";
      expect(await box("private-channel", "notifierReadiness")).toMatchObject({ destinationVerified: false });
      slackScopes = "chat:write,groups:read";
      expect(await box("private-channel", "notifierReadiness")).toMatchObject({ destinationVerified: true, posting: "unproven" });
      await box("private-channel", "enqueue", { notification: notification() });
      expect((await box("private-channel", "tick")).notifications[0].state).toBe("acknowledged");
    } finally { slackChannelPatch = {}; slackScopes = "chat:write,channels:read,groups:read"; }
  });
  it("blocks missing configuration and stale/future/old/mismatched private evidence", async () => {
    const now = Date.now();
    const patches = [
      { checkedAt: now - 60000, expiresAt: now - 30000 }, { checkedAt: now + 60000, expiresAt: now + 90000 },
      { checkedAt: now, expiresAt: now + 60000 }, { checkedAt: null }, { origin: "https://other.example.invalid" },
      { generation: "fixture-generation-2" }, { destinationVerified: null }, { protocol: "old" }, { configured: false },
    ];
    for (const [i, readinessPatch] of patches.entries()) {
      const name = `stale-evidence-${i}`, before = notifications.length;
      await box(name, "configure", { fields: { readinessPatch } });
      await box(name, "enqueue", { notification: notification() });
      expect((await box(name, "tick")).notifications[0]).toMatchObject({ state: "blocked", attempts: 0 });
      expect(notifications.length).toBe(before);
    }
    await box("missing-identity", "configure", { fields: { receiver: "_MISSING" } });
    const before = slackReadCount;
    expect(await box("missing-identity", "notifierReadiness")).toMatchObject({ configured: false, destinationVerified: false });
    expect(slackReadCount).toBe(before);
  });
  it("requires matching current generation and rereads with rotated token, never reusing an old success", async () => {
    const name = "rotated-receiver", before = notifications.length;
    expect(await box(name, "notifierReadiness")).toMatchObject({ generation: "fixture-generation-1", destinationVerified: true });
    await box(name, "configure", { fields: { receiver: "_ROTATED" } });
    await box(name, "enqueue", { notification: notification() });
    expect((await box(name, "tick")).notifications[0]).toMatchObject({ state: "blocked", attempts: 0 });
    const input = notification(), notificationKey = `request-build:${input.origin}:${input.runId}:1:pr:42`;
    expect(await box(name, "direct", { notification: { ...input, notificationKey } })).toMatchObject({ status: "blocked" });
    expect(notifications.length).toBe(before);
    expect(await box(name, "direct", { notification: { ...input, notificationKey }, generation: "fixture-generation-2" })).toMatchObject({ status: "acknowledged" });
    expect(slackReadTokens.slice(-2)).toEqual(Array(2).fill("Bearer rotated-fixture-not-a-credential"));
  });
  it("rechecks revoked permissions between readiness and send, with no stale success fallback", async () => {
    const name = "read-send-revoked", before = notifications.length;
    afterSlackRead = () => { slackReadMode = "revoked"; };
    try {
      await box(name, "enqueue", { notification: notification() });
      expect((await box(name, "tick")).notifications[0]).toMatchObject({ state: "blocked", attempts: 1 });
      expect(notifications.length).toBe(before);
    } finally { afterSlackRead = undefined; slackReadMode = "ok"; }
  });
  it("does not interpret metadata success as posting permission", async () => {
    const name = "posting-unproven", before = notifications.length;
    slackMode = "no-permission";
    try {
      await box(name, "enqueue", { notification: notification() });
      expect((await box(name, "tick")).notifications[0].state).toBe("ambiguous");
      expect(notifications.length).toBe(before + 1);
      await box(name, "tick");
      expect(notifications.length).toBe(before + 1);
    } finally { slackMode = "ack"; }
  });
  it("persists independent attempts, honors documented rate delay/backoff and suppresses duplicate enqueue", async () => {
    const name = "outbox-rate", input = notification(), before = notifications.length;
    await box(name, "enqueue", { notification: input });
    slackMode = "rate";
    const waiting = await box(name, "tick");
    expect(waiting.runtime).toBe("Cloudflare-Workers");
    expect(waiting.notifications[0]).toMatchObject({ state: "retry_wait", attempts: 1 });
    expect(waiting.notifications[0].retryAt).toBeGreaterThanOrEqual(waiting.attempts[0].startedAt + 7000);
    await box(name, "tick");
    expect(notifications.length - before).toBe(1);
    slackMode = "ack";
    await box(name, "due");
    const sent = await box(name, "tick");
    expect(sent.notifications[0]).toMatchObject({ state: "acknowledged", attempts: 2 });
    expect(sent.attempts.map((a: {outcome: string}) => a.outcome)).toEqual(["retry_wait", "acknowledged"]);
    await box(name, "enqueue", { notification: input });
    await box(name, "recover"); await box(name, "tick");
    expect(notifications.length - before).toBe(2);
    expect(await box(name, "enqueue", { notification: { ...input, prNumber: 43 } })).toEqual({ error: "BUILD_NOTIFICATION_CONFLICT" });
  });
  it("bounds proven non-delivery retries and retains the stable key across all attempts", async () => {
    const name = "outbox-exhausted", input = notification(), before = notifications.length;
    await box(name, "enqueue", { notification: input });
    slackMode = "rate";
    for (let attempt = 1; attempt <= 6; attempt++) {
      await box(name, "due");
      const result = await box(name, "tick");
      expect(result.notifications[0].attempts).toBe(attempt);
      expect(result.notifications[0].retryAt).toBeGreaterThanOrEqual(result.attempts[attempt - 1].startedAt + Math.max(7000, 1000 * 2 ** attempt));
    }
    slackMode = "ack";
    const stopped = await box(name, "tick");
    expect(stopped.notifications[0].state).toBe("blocked");
    expect(new Set(stopped.attempts.map((a: {key: string}) => a.key)).size).toBe(1);
    expect(notifications.length - before).toBe(6);
  });
  it("does not resend lost cross-service acknowledgements or crash-persisted sending intents", async () => {
    const name = "outbox-lost", input = notification(), before = notifications.length;
    await box(name, "configure", { fields: { lostAck: true } });
    await box(name, "enqueue", { notification: input });
    const lost = await box(name, "tick");
    expect(lost.notifications[0].state).toBe("ambiguous");
    await box(name, "recover"); await box(name, "tick");
    expect(notifications.length - before).toBe(1);
    await box("outbox-crash", "enqueue", { notification: notification() });
    await box("outbox-crash", "crash");
    const recovered = await box("outbox-crash", "recover");
    expect(recovered.attempts[0].outcome).toBe("ambiguous");
    await box("outbox-crash", "tick");
    expect(notifications.length - before).toBe(1);
  });
  it.each(["bad-rate", "conflict-rate", "redirect", "large", "malformed", "server", "wrong-channel"])("treats %s as ambiguous without blind retries", async mode => {
    const name = `outbox-${mode}`, before = notifications.length;
    await box(name, "enqueue", { notification: notification() });
    slackMode = mode;
    const result = await box(name, "tick");
    slackMode = "ack";
    expect(result.notifications[0].state).toBe("ambiguous");
    await box(name, "tick");
    expect(notifications.length - before).toBe(1);
  });
  it.each(["revoked", "hidden", "missing"])("does not send when %s before delivery admission", async reason => {
    const name = `outbox-deny-${reason}`, before = notifications.length;
    await box(name, "enqueue", { notification: notification() });
    await box(name, "configure", { fields: { [reason]: true } });
    const denied = await box(name, "tick");
    expect(denied.notifications[0].state).toBe(reason === "missing" ? "blocked" : "suppressed");
    expect(denied.attempts).toHaveLength(0);
    expect(notifications.length).toBe(before);
  });
  it("rejects noncanonical origins, prose, forged keys and private identities before HTTP", async () => {
    const input = notification(), before = notifications.length;
    const key = `request-build:${input.origin}:${input.runId}:1:pr:42`;
    for (const patch of [{ origin: "https://evil.example.invalid" }, { origin: `${input.origin}/?token=x` }, { requestId: "private-session" }, { channel: "C9999999999" }, { text: "user prose" }, { notificationKey: "forged" }, { prNumber: 1.5 }]) {
      const result = await box("outbox-invalid", "direct", { notification: { ...input, notificationKey: key, ...patch } });
      expect(result).toEqual({ error: "BUILD_NOTIFICATION_INVALID" });
    }
    expect(notifications.length).toBe(before);
  });
  it("serializes duplicate admins, conflicts changed retry payloads, freezes exact revision", async () => {
    const name = "duplicates",
      { input } = await setup(name);
    const starts = await Promise.all([
      call(name, "start", { claim, input }),
      call(name, "start", { claim: other, input: { ...input, mutationKey: "other" } }),
    ]);
    expect(starts.filter((s) => s.runId)).toHaveLength(1);
    expect(starts.filter((s) => s.error)).toHaveLength(1);
    const winner = starts.find((s) => s.runId),
      actor = starts[0].runId ? claim : other;
    expect(
      await call(name, "start", {
        claim: actor,
        input: {
          ...input,
          mutationKey: actor === claim ? input.mutationKey : "other",
          expectedRequestRevision: 2,
        },
      }),
    ).toEqual({ error: "BUILD_MUTATION_KEY_CONFLICT" });
    expect((await call(name, "inspect")).runs[0].intent.specification).toBe(
      "feature: Fixture\n\nChange a to b",
    );
    await call(name, "cancel", {
      claim: other,
      input: { requestId: input.requestId, runId: winner.runId, mutationKey: "cancel" },
    });
    expect((await tick(name, 3)).slots).toBe(0);
  });
  it("recovers lost reservation ack without duplicate session or process", async () => {
    const name = "lost-session",
      { input } = await setup(name);
    await call(name, "configure", { execution: true, fields: { "lost-ensure": true } });
    await call(name, "start", { claim, input });
    expect((await tick(name, 22)).runs[0].state).toBe("pr_created");
    expect(await call(name, "inspect", { execution: true })).toMatchObject({
      sessions: 1,
      execs: 3,
    });
  });
  it("ambiguous process start stops exact generation and releases only confirmed cleanup", async () => {
    const name = "lost-process",
      { input } = await setup(name);
    await call(name, "configure", {
      execution: true,
      fields: { "lose-start": 2, "destroy-failed": true },
    });
    await call(name, "start", { claim, input });
    const held = await tick(name, 12);
    expect(held.runs[0].state).toBe("needs_attention");
    expect(held.slots).toBe(1);
    await call(name, "configure", { execution: true, fields: { "destroy-failed": false } });
    expect((await tick(name, 4)).slots).toBe(0);
    expect(await call(name, "inspect", { execution: true })).toMatchObject({ execs: 2 });
  });
  it("revocation/outage and hidden requests deny new work while service cleanup survives", async () => {
    for (const field of ["hidden", "outage", "ineligible", "revoked"]) {
      const name = `deny-${field}`,
        { input } = await setup(name);
      const run = await call(name, "start", { claim, input });
      await tick(name, 4);
      if (field === "revoked")
        await call(name, "revoke", { actor: other, principalId: claim.principalId });
      else await call(name, "configure", { fields: { [field]: true } });
      expect((await tick(name, 10)).slots).toBe(0);
      if (field === "hidden")
        expect(
          await call(name, "get", { requestId: input.requestId, runId: run.runId }),
        ).toBeNull();
      const state = await call(name, "inspect"),
        persisted = state.runs[0];
      expect(
        await call(name, "authorize", {
          owner: persisted.owner,
          request: {
            dispatchKey: persisted.intent.dispatchKey,
            intentHash: persisted.intentHash,
            sessionId: persisted.receipt?.sessionId ?? crypto.randomUUID(),
            generation: 1,
            phase: "model",
          },
        }),
      ).toMatchObject({ allowed: false });
    }
  });
  it("PR acknowledgement loss adopts exact verified evidence without a second write", async () => {
    const name = "lost-pr",
      { input } = await setup(name),
      before = pulls.length;
    lose = "/pulls";
    await call(name, "start", { claim, input });
    expect((await tick(name, 25)).runs[0].state).toBe("pr_created");
    expect(pulls.length).toBe(before + 1);
  });
  it("admitted PR wins cancellation/revocation race, but never grants another write", async () => {
    const name = "publish-cancel",
      { input } = await setup(name);
    const run = await call(name, "start", { claim, input }),
      before = pulls.length;
    onWrite = async (path) => {
      if (path !== "/pulls") return;
      onWrite = null;
      await call(name, "cancel", {
        claim: other,
        input: { requestId: input.requestId, runId: run.runId, mutationKey: "race-cancel" },
      });
      await call(name, "revoke", { actor: other, principalId: claim.principalId });
    };
    const done = await tick(name, 25);
    expect(done.runs[0].state).toBe("pr_created");
    expect(done.slots).toBe(0);
    expect(await call(name, "get", { requestId: input.requestId, runId: run.runId })).toMatchObject(
      { state: "pr_created", cancelTooLate: true, notification: "suppressed" },
    );
    expect(pulls.length).toBe(before + 1);
    expect(await call(name, "start", { claim, input })).toEqual({ error: "ADMIN_REVOKED" });
  });
  it("wrong receipt generation never advances state or frees a cleanup lease", async () => {
    const name = "wrong-receipt",
      { input } = await setup(name);
    await call(name, "start", { claim, input });
    await tick(name, 3);
    await call(name, "configure", {
      execution: true,
      fields: { "wrong-receipt-generation": true },
    });
    const denied = await tick(name, 3);
    expect(denied.runs[0].state).toBe("cancel_requested");
    expect(denied.slots).toBe(1);
    await call(name, "configure", {
      execution: true,
      fields: { "wrong-receipt-generation": false },
    });
    expect((await tick(name, 8)).slots).toBe(0);
  });
  it("unknown/forged identity and publication digests cannot authorize provider writes", async () => {
    const name = "forged",
      { input } = await setup(name);
    await call(name, "start", { claim, input });
    await tick(name, 3);
    const r = (await call(name, "inspect")).runs[0];
    const auth = {
      dispatchKey: r.intent.dispatchKey,
      intentHash: r.intentHash,
      sessionId: r.receipt?.sessionId ?? crypto.randomUUID(),
      generation: 1,
      phase: "start",
    };
    expect(
      await call(name, "authorize", {
        owner: r.owner,
        request: { ...auth, dispatchKey: "unknown" },
      }),
    ).toEqual({ allowed: false, reasons: ["UNKNOWN_RUN"] });
    for (const patch of [
      { generation: 2 },
      { intentHash: "forged" },
      { sessionId: crypto.randomUUID() },
      { phase: "publish", publicationHash: "forged" },
    ]) {
      expect(
        await call(name, "authorize", { owner: r.owner, request: { ...auth, ...patch } }),
      ).toMatchObject({ allowed: false });
    }
    await call(name, "cancel", {
      claim: other,
      input: { requestId: input.requestId, runId: r.runId, mutationKey: "cancel" },
    });
    expect((await tick(name, 8)).slots).toBe(0);
  });
  it("missing live readiness creates no run, reservation or provider write", async () => {
    const name = "blocked",
      { input } = await setup(name),
      before = writes.length;
    await call(name, "configure", { fields: { blocked: true } });
    expect(await call(name, "start", { claim, input })).toEqual({
      error: "BUILD_IMAGE_UNVERIFIED",
    });
    expect((await call(name, "inspect")).runs).toEqual([]);
    expect(await call(name, "inspect", { execution: true })).toMatchObject({
      execs: 0,
      sessions: 0,
    });
    expect(writes.length).toBe(before);
  });
});
