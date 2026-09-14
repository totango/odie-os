import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { newHttpBatchRpcResponse, newHttpBatchRpcSession, type RpcPromise } from "capnweb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";
import { COMMUNITY_REQUEST_LIMITS as LIMITS } from "@gadgets/workshop-shared/community-requests";
import { CommunityRequests } from "../src/community-requests";
import { PublicApiImpl, type UserDurableObject, type AdminSettings, type AdminAuthority } from "../src/server";
import type { OverseerDurableObject } from "../src/overseer";

declare global {
  namespace Cloudflare {
  interface Env {
    TEST_COMMUNITY_REQUESTS: DurableObjectNamespace<CommunityRequests>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_ADMIN: DurableObjectNamespace<AdminSettings>;
    TEST_AUTHORITY: DurableObjectNamespace<AdminAuthority>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
  }
}

const registry = () => env.TEST_COMMUNITY_REQUESTS.getByName("");

async function fixture() {
  await runInDurableObject(env.TEST_AUTHORITY.getByName(""), instance => {
    Reflect.get(instance, "env").ADMINS = ["authority_admin_one", "authority_admin_two", "authority_admin_three", "authority_admin_four"];
  });
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "exports", { value: {
    UserDurableObject: env.TEST_USER, OverseerDurableObject: env.TEST_OVERSEER,
    AdminAuthority: env.TEST_AUTHORITY, AdminSettings: env.TEST_ADMIN, CommunityRequests: env.TEST_COMMUNITY_REQUESTS,
  } });
  const adminName = "authority_admin_one";
  await runInDurableObject(env.TEST_USER.getByName(adminName), (_instance, state) => state.storage.deleteAll());
  const config = { ...env, ADMINS: [adminName] };
  const root = new PublicApiImpl(ctx, config, () => {});
  const names = [adminName, `alice_${crypto.randomUUID().replaceAll("-", "")}`, `bob_${crypto.randomUUID().replaceAll("-", "")}`];
  const tokens = await Promise.all(names.map(name => root.createAccount(name, "Private display name", new Uint8Array([1, 2, 3]))));
  const [admin, alice, bob] = await Promise.all(tokens.map(token => root.authenticate(token!)));
  // These are local targets, not RPC stubs. The HTTP test below disposes its actual client stubs.
  return { root, admin, alice, bob, tokens, names, config };
}

function draft(overrides = {}) {
  return { idempotencyKey: crypto.randomUUID(), kind: "feature" as const, title: "Public calendar", body: "Authored description", ...overrides };
}
const command = (action: "hide" | "restore" | "close" | "reopen" | "duplicate", duplicateOf?: string) => ({
  idempotencyKey: crypto.randomUUID(), action, ...(duplicateOf ? { duplicateOf } : {}),
});

beforeEach(async () => {
  await runInDurableObject(registry(), (_instance, ctx) => {
    for (const table of ["requests", "details", "votes", "receipts", "quotas", "moderation"]) {
      ctx.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
});

describe("CommunityRequests authenticated public board (real workerd)", () => {
  it("allows two non-admin accounts to read, vote and append authored details, without connectors or SSO", async () => {
    const setup = await fixture();
    const { alice, bob } = setup;
    expect(await alice.amIAdmin()).toBe(false);
    const request = await alice.createCommunityRequest(draft());
    expect(request).toMatchObject({ isOwn: true, voteCount: 0, viewerHasVoted: false });
    expect(await bob.getCommunityRequest(request.id)).toMatchObject({ isOwn: false, title: request.title });
    await Promise.all([alice.voteCommunityRequest(request.id), bob.voteCommunityRequest(request.id)]);
    expect(await bob.getCommunityRequest(request.id)).toMatchObject({ voteCount: 2, viewerHasVoted: true });
    const detail = await bob.addCommunityRequestDetail(request.id, { idempotencyKey: "detail", body: "Public detail keyword" });
    expect(detail.isOwn).toBe(true);
    expect((await alice.listCommunityRequestDetails(request.id)).items).toEqual([{ ...detail, isOwn: false }]);
    expect((await alice.searchCommunityRequests({ query: "keyword" })).items.map(r => r.id)).toEqual([request.id]);
    expect((await bob.listCommunityRequests()).items).toHaveLength(1);
    await alice.unvoteCommunityRequest(request.id);
    await alice.unvoteCommunityRequest(request.id);
    expect(await alice.getCommunityRequest(request.id)).toMatchObject({ voteCount: 1, viewerHasVoted: false });
  });

  it("atomically deduplicates concurrent submissions, details and votes per account, rejecting conflicting retries", async () => {
    const setup = await fixture();
    const { alice, bob } = setup;
    const input = draft({ idempotencyKey: "same" });
    const created = await Promise.all(Array.from({ length: 8 }, () => alice.createCommunityRequest(input)));
    expect(new Set(created.map(r => r.id)).size).toBe(1);
    const other = await bob.createCommunityRequest(input);
    expect(other.id).not.toBe(created[0].id);
    const requestId = created[0].id;
    await expect(async () => alice.createCommunityRequest({ ...input, body: "Changed" })).rejects.toThrow("retry key");
    const details = await Promise.all(Array.from({ length: 8 }, () => alice.addCommunityRequestDetail(requestId,
      { idempotencyKey: "same", body: "One detail" })));
    expect(new Set(details.map(d => d.id)).size).toBe(1);
    await expect(async () => alice.addCommunityRequestDetail(other.id, { idempotencyKey: "same", body: "One detail" })).rejects.toThrow("retry key");
    await Promise.all(Array.from({ length: 15 }, () => bob.voteCommunityRequest(requestId)));
    expect(await alice.getCommunityRequest(requestId)).toMatchObject({ voteCount: 1, viewerHasVoted: false });
    expect((await alice.listCommunityRequestDetails(requestId)).items).toHaveLength(1);
    // Confirm the account-unique SQL constraint, not just the response's aggregate.
    await runInDurableObject(registry(), (_instance, ctx) => {
      expect(ctx.storage.sql.exec("SELECT * FROM votes").toArray()).toHaveLength(1);
      expect(ctx.storage.sql.exec("SELECT * FROM receipts WHERE operation = 'detail'").toArray()).toHaveLength(1);
    });
  });

  it("hides list/search/related/details and replay results from ordinary users, while explicit admin access works", async () => {
    const setup = await fixture();
    const { alice, bob, admin } = setup;
    const input = draft();
    const request = await alice.createCommunityRequest(input);
    const detail = { idempotencyKey: "detail", body: "Hidden detail needle" };
    await alice.addCommunityRequestDetail(request.id, detail);
    await admin.moderateCommunityRequest(request.id, command("hide"));
    expect(await alice.getCommunityRequest(request.id)).toBeNull();
    expect(await bob.getCommunityRequest(crypto.randomUUID())).toBeNull();
    expect((await bob.listCommunityRequests()).items).toEqual([]);
    expect((await bob.searchCommunityRequests({ query: "needle" })).items).toEqual([]);
    expect(await bob.suggestRelatedCommunityRequests("needle calendar")).toEqual([]);
    await expect(async () => alice.createCommunityRequest(input)).rejects.toThrow("unavailable");
    await expect(async () => alice.addCommunityRequestDetail(request.id, detail)).rejects.toThrow("unavailable");
    await expect(async () => bob.voteCommunityRequest(request.id)).rejects.toThrow("unavailable");
    await expect(async () => bob.listCommunityRequestDetails(request.id)).rejects.toThrow("unavailable");
    for (const read of [() => bob.getCommunityRequest(request.id, true),
      () => bob.listCommunityRequests({ includeHidden: true }),
      () => bob.searchCommunityRequests({ includeHidden: true, query: "needle" }),
      () => bob.listCommunityRequestDetails(request.id, { includeHidden: true })]) {
      await expect(async () => read()).rejects.toThrow("administrator");
    }
    expect(await admin.getCommunityRequest(request.id)).toBeNull();
    expect(await admin.getCommunityRequest(request.id, true)).toMatchObject({ hidden: true });
    expect((await admin.listCommunityRequests({ includeHidden: true })).items).toHaveLength(1);
    expect((await admin.listCommunityRequestDetails(request.id, { includeHidden: true })).items).toHaveLength(1);
    await admin.moderateCommunityRequest(request.id, command("restore"));
    expect((await bob.suggestRelatedCommunityRequests("needle"))[0].id).toBe(request.id);
  });

  it("enforces current static admin on every moderation and hidden-read call; replays return current state", async () => {
    const setup = await fixture();
    const { alice, admin, config } = setup;
    const request = await alice.createCommunityRequest(draft());
    for (const action of ["hide", "restore", "close", "reopen"] as const) {
      await expect(async () => alice.moderateCommunityRequest(request.id, command(action))).rejects.toThrow("administrator");
    }
    const close = command("close");
    expect(await admin.moderateCommunityRequest(request.id, close)).toMatchObject({ status: "closed" });
    await admin.moderateCommunityRequest(request.id, command("reopen"));
    expect(await admin.moderateCommunityRequest(request.id, close)).toMatchObject({ status: "open" });
    await expect(async () => admin.moderateCommunityRequest(request.id, { ...close, action: "hide" })).rejects.toThrow("retry key");
    await runInDurableObject(env.TEST_AUTHORITY.getByName(""), instance => { Reflect.get(instance, "env").ADMINS = []; });
    config.ADMINS = []; // Test the per-call static check, not a dynamic-admin/revocation implementation.
    await expect(async () => admin.moderateCommunityRequest(request.id, command("hide"))).rejects.toThrow("administrator");
    await expect(async () => admin.getCommunityRequest(request.id, true)).rejects.toThrow("administrator");
    await runInDurableObject(registry(), (_instance, ctx) => {
      expect(ctx.storage.sql.exec("SELECT * FROM moderation").toArray()).toHaveLength(2);
    });
  });

  it("keeps duplicate references public-safe and prevents self-links, cycles and chains", async () => {
    const setup = await fixture();
    const { alice, admin, bob } = setup;
    const canonical = await alice.createCommunityRequest(draft());
    const duplicate = await alice.createCommunityRequest(draft());
    await expect(async () => admin.moderateCommunityRequest(canonical.id, command("duplicate", canonical.id))).rejects.toThrow("canonical");
    expect(await admin.moderateCommunityRequest(duplicate.id, command("duplicate", canonical.id)))
      .toMatchObject({ status: "closed", duplicateOf: canonical.id });
    await expect(async () => admin.moderateCommunityRequest(canonical.id, command("duplicate", duplicate.id))).rejects.toThrow("canonical");
    await admin.moderateCommunityRequest(canonical.id, command("hide"));
    expect(await bob.getCommunityRequest(duplicate.id)).toMatchObject({ duplicateOf: null });
    await admin.moderateCommunityRequest(duplicate.id, command("reopen"));
    expect(await bob.getCommunityRequest(duplicate.id)).toMatchObject({ status: "open", duplicateOf: null });
  });

  it("bounds and scopes pagination, filters hidden records on continuation, and treats search literally", async () => {
    const setup = await fixture();
    const { alice, admin, bob } = setup;
    const feature = await alice.createCommunityRequest(draft({ title: "100% _ feature" }));
    const bug = await alice.createCommunityRequest(draft({ kind: "bug", title: "Unicode café bug" }));
    const third = await alice.createCommunityRequest(draft({ title: "Unicode café third" }));
    const first = await bob.listCommunityRequests({ limit: 1 });
    const next = await bob.listCommunityRequests({ limit: 1, cursor: first.nextCursor! });
    expect(next.items[0].id).not.toBe(first.items[0].id);
    await expect(async () => bob.listCommunityRequests({ query: "changed", cursor: first.nextCursor! })).rejects.toThrow("cursor");
    const unicode = await bob.searchCommunityRequests({ query: "café", limit: 1 });
    expect((await bob.searchCommunityRequests({ query: "café", limit: 1, cursor: unicode.nextCursor! })).items).toHaveLength(1);
    expect((await bob.searchCommunityRequests({ query: "% _" })).items.map(r => r.id)).toEqual([feature.id]);
    expect((await bob.listCommunityRequests({ kind: "bug" })).items.map(r => r.id)).toEqual([bug.id]);
    await admin.moderateCommunityRequest(next.items[0].id, command("hide"));
    expect((await bob.listCommunityRequests({ cursor: first.nextCursor! })).items.map(r => r.id)).not.toContain(next.items[0].id);
    await admin.moderateCommunityRequest(third.id, command("restore"));
    await alice.addCommunityRequestDetail(third.id, { idempotencyKey: "one", body: "First" });
    await alice.addCommunityRequestDetail(third.id, { idempotencyKey: "two", body: "Second" });
    // third may have been hidden above; explicit moderator paging still checks the same scope.
    const details = await admin.listCommunityRequestDetails(third.id, { limit: 1, includeHidden: true });
    expect((await admin.listCommunityRequestDetails(third.id, { cursor: details.nextCursor!, includeHidden: true })).items).toHaveLength(1);
    await expect(async () => bob.listCommunityRequests({ limit: 51 })).rejects.toThrow();
    await expect(async () => bob.listCommunityRequests({ cursor: "garbage" })).rejects.toThrow();
    await expect(async () => bob.suggestRelatedCommunityRequests("a".repeat(161))).rejects.toThrow();
  });

  it("publishes only new authored bugs and allowlisted projections, never private account/evidence data", async () => {
    const setup = await fixture();
    const { alice, bob, names } = setup;
    // Private account/workspace state and historical-feedback-shaped storage exist outside the board.
    await runInDurableObject(env.TEST_USER.getByName(names[1]), async (_instance, ctx) => {
      await ctx.storage.put("private-feedback-fixture", { diagnostics: "secret-needle", transcript: "secret-transcript", sessionToken: "secret-token" });
    });
    const bug = await alice.createCommunityRequest(draft({ kind: "bug", body: "New public bug summary" }));
    const visible = await bob.getCommunityRequest(bug.id);
    expect(Object.keys(visible!).toSorted()).toEqual(["id", "kind", "title", "body", "status", "hidden", "duplicateOf", "createdAt", "updatedAt", "isOwn", "voteCount", "viewerHasVoted"].toSorted());
    const all = JSON.stringify([await bob.listCommunityRequests(), await bob.listCommunityRequestDetails(bug.id)]);
    for (const secret of [...names, "Private display name", "secret-needle", "secret-transcript", "secret-token"]) expect(all).not.toContain(secret);
    expect((await bob.searchCommunityRequests({ query: "secret-needle" })).items).toEqual([]);
    expect(await bob.suggestRelatedCommunityRequests("secret-transcript")).toEqual([]);
    for (const extra of [{ owner: names[2] }, { diagnostics: "private" }, { transcript: "private" }, { workspaceId: "private" }, { sessionId: "private" }]) {
      await expect(async () => alice.createCommunityRequest({ ...draft(), ...extra })).rejects.toThrow();
    }
    const invalidDetail = { idempotencyKey: "extra", body: "public", diagnostics: "private" };
    await expect(async () => alice.addCommunityRequestDetail(bug.id, invalidDetail)).rejects.toThrow();
    expect((await bob.listCommunityRequests()).items).toHaveLength(1);
  });

  it("enforces durable atomic account quotas without charging duplicate mutations", async () => {
    const setup = await fixture();
    const { alice, bob } = setup;
    const input = draft();
    const request = await alice.createCommunityRequest(input);
    for (let n = 1; n < LIMITS.createsPerHour; n++) await alice.createCommunityRequest(draft());
    await expect(async () => alice.createCommunityRequest(draft())).rejects.toThrow("rate limit");
    expect((await alice.createCommunityRequest(input)).id).toBe(request.id);
    await bob.createCommunityRequest(draft());
    // Fixed-window quota clock is stored durably; set the boundary without changing global time.
    await runInDurableObject(registry(), (_instance, ctx) => {
      ctx.storage.sql.exec("UPDATE quotas SET count = ? WHERE bucket = 'write'", LIMITS.writesPerMinute);
    });
    await expect(async () => alice.voteCommunityRequest(request.id)).rejects.toThrow("rate limit");
    expect(await alice.getCommunityRequest(request.id)).toMatchObject({ voteCount: 0 });
    await runInDurableObject(registry(), (_instance, ctx) => {
      ctx.storage.sql.exec("UPDATE quotas SET window = window - 1");
    });
    await alice.voteCommunityRequest(request.id);
    await runInDurableObject(registry(), (_instance, ctx) => {
      ctx.storage.sql.exec("UPDATE quotas SET count = ? WHERE bucket = 'write'", LIMITS.writesPerMinute);
    });
    expect(await alice.voteCommunityRequest(request.id)).toMatchObject({ voteCount: 1 });
    await runInDurableObject(registry(), (_instance, ctx) => {
      ctx.storage.sql.exec("UPDATE quotas SET count = ? WHERE bucket = 'read'", LIMITS.readsPerMinute);
    });
    await expect(async () => alice.listCommunityRequests()).rejects.toThrow("rate limit");
  });

  it("retains receipts across registry reconstruction and enforces the separate hourly detail quota atomically", async () => {
    const { alice, bob, names } = await fixture();
    const input = draft();
    const request = await alice.createCommunityRequest(input);
    const detail = { idempotencyKey: "first", body: "Public detail" };
    const originalDetail = await bob.addCommunityRequestDetail(request.id, detail);
    for (let n = 1; n < LIMITS.detailsPerHour; n++) {
      await bob.addCommunityRequestDetail(request.id, { idempotencyKey: `detail_${n}`, body: "More public detail" });
    }
    const owner = env.TEST_USER.idFromName(names[1]).toString();
    await runInDurableObject(registry(), (_instance, ctx) => {
      // Same persisted SQLite state, a fresh constructor: no in-memory receipt/quota authority.
      const reopened = new CommunityRequests(ctx, env);
      expect(reopened.create(owner, input).id).toBe(request.id);
      ctx.storage.sql.exec("UPDATE quotas SET window = window - 1 WHERE bucket = 'write'");
    });
    await expect(async () => bob.addCommunityRequestDetail(request.id,
      { idempotencyKey: "over_quota", body: "Must not commit" })).rejects.toThrow("rate limit");
    expect(await bob.addCommunityRequestDetail(request.id, detail)).toEqual(originalDetail);
    expect((await alice.listCommunityRequestDetails(request.id, { limit: 50 })).items).toHaveLength(30);
    await runInDurableObject(registry(), (_instance, ctx) => {
      expect(ctx.storage.sql.exec("SELECT * FROM receipts WHERE retryKey = 'over_quota'").toArray()).toEqual([]);
    });
  });

  it("bounds all authored fields and keys and stores plain text without treating HTML as instructions", async () => {
    const setup = await fixture();
    const { alice } = setup;
    for (const input of [draft({ title: "x".repeat(161) }), draft({ body: "x".repeat(8001) }),
      draft({ title: "  " }), draft({ kind: "other" }), draft({ idempotencyKey: "x".repeat(81) }), draft({ idempotencyKey: "bad:key" })]) {
      await expect(async () => alice.createCommunityRequest(input)).rejects.toThrow();
    }
    const html = "<script>alert('authored text')</script>";
    const request = await alice.createCommunityRequest(draft({ title: "x".repeat(160), body: html }));
    expect(request.body).toBe(html); // Frontend must render text; backend never interprets it.
    await expect(async () => alice.addCommunityRequestDetail(request.id, { idempotencyKey: "big", body: "x".repeat(4001) })).rejects.toThrow();
  });

  it("completes the public bug, second-account participation and static-admin moderation journey across HTTP batches", async () => {
    const { root, tokens } = await fixture();
    const localFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== "https://board.test/api") throw new Error("Unexpected test fetch URL.");
      return newHttpBatchRpcResponse(request, root);
    });
    let batches = 0;
    async function asAccount<T>(account: number, call: (api: RpcPromise<AuthenticatedApi>) => PromiseLike<T>): Promise<T> {
      using batch = newHttpBatchRpcSession<PublicApi>("https://board.test/api");
      batches++;
      // Each interaction authenticates and pipelines within one batch; no stub escapes its lifetime.
      return await call(batch.authenticate(tokens[account]!));
    }
    try {
      const input = draft({ kind: "bug", title: "Keyboard focus bug", body: "New authored public reproduction" });
      const bug = await asAccount(1, api => api.createCommunityRequest(input));
      expect(await asAccount(1, api => api.createCommunityRequest(input))).toEqual(bug);
      expect(await asAccount(2, api => api.getCommunityRequest(bug.id))).toMatchObject({ kind: "bug", isOwn: false });
      expect((await asAccount(2, api => api.listCommunityRequests({ kind: "bug" }))).items.map(item => item.id)).toEqual([bug.id]);
      expect(await asAccount(2, api => api.voteCommunityRequest(bug.id))).toMatchObject({ voteCount: 1, viewerHasVoted: true });
      expect(await asAccount(2, api => api.voteCommunityRequest(bug.id))).toMatchObject({ voteCount: 1 });
      expect(await asAccount(1, api => api.getCommunityRequest(bug.id))).toMatchObject({ voteCount: 1, viewerHasVoted: false });
      const detail = await asAccount(2, api => api.addCommunityRequestDetail(bug.id, { idempotencyKey: "wire-detail", body: "Tab order regression" }));
      expect((await asAccount(1, api => api.listCommunityRequestDetails(bug.id))).items).toEqual([{ ...detail, isOwn: false }]);
      expect((await asAccount(1, api => api.searchCommunityRequests({ query: "Tab order" }))).items.map(item => item.id)).toEqual([bug.id]);
      expect((await asAccount(1, api => api.suggestRelatedCommunityRequests("Tab order"))).map(item => item.id)).toEqual([bug.id]);
      await expect(asAccount(2, api => api.moderateCommunityRequest(bug.id, command("hide")))).rejects.toThrow("administrator");
      await asAccount(0, api => api.moderateCommunityRequest(bug.id, command("hide")));
      expect(await asAccount(1, api => api.getCommunityRequest(bug.id))).toBeNull();
      expect((await asAccount(2, api => api.searchCommunityRequests({ query: "Tab order" }))).items).toEqual([]);
      expect(await asAccount(2, api => api.suggestRelatedCommunityRequests("Tab order"))).toEqual([]);
      await expect(asAccount(2, api => api.listCommunityRequestDetails(bug.id))).rejects.toThrow("unavailable");
      await expect(asAccount(2, api => api.getCommunityRequest(bug.id, true))).rejects.toThrow("administrator");
      expect(await asAccount(0, api => api.getCommunityRequest(bug.id, true))).toMatchObject({ hidden: true });
      await asAccount(0, api => api.moderateCommunityRequest(bug.id, command("restore")));
      await asAccount(0, api => api.moderateCommunityRequest(bug.id, command("close")));
      expect((await asAccount(2, api => api.listCommunityRequests({ status: "closed" }))).items.map(item => item.id)).toEqual([bug.id]);
      await asAccount(0, api => api.moderateCommunityRequest(bug.id, command("reopen")));
      expect(await asAccount(2, api => api.unvoteCommunityRequest(bug.id))).toMatchObject({ status: "open", voteCount: 0, viewerHasVoted: false });
      expect(localFetch).toHaveBeenCalledTimes(batches);
    } finally {
      localFetch.mockRestore();
    }
  });

  it("serializes the real authenticated API over HTTP batch and denies signed-out board access", async () => {
    const setup = await fixture();
    const { root, tokens } = setup;
    const localFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== "https://board.test/api") throw new Error("Unexpected test fetch URL.");
      return newHttpBatchRpcResponse(request, root);
    });
    try {
      using batch = newHttpBatchRpcSession<PublicApi>("https://board.test/api");
      const authenticated = batch.authenticate(tokens[1]!);
      const result = await authenticated.createCommunityRequest(draft()); // Promise pipelining.
      // The intermediate capability stays in this batch; disposing batch releases it. Do not
      // await/export it after the HTTP batch has ended.
      expect(result.isOwn).toBe(true);
      using signedOut = newHttpBatchRpcSession<AuthenticatedApi>("https://board.test/api");
      await expect(async () => signedOut.listCommunityRequests()).rejects.toThrow();
      await expect(async () => root.authenticate("invalid")).rejects.toThrow();
      expect(localFetch).toHaveBeenCalledTimes(2);
    } finally {
      localFetch.mockRestore();
    }
  });
});
