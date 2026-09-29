import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { newHttpBatchRpcResponse, newHttpBatchRpcSession, type RpcPromise } from "capnweb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";
import { COMMUNITY_REQUEST_LIMITS as LIMITS } from "@gadgets/workshop-shared/community-requests";
import { CommunityRequests } from "../src/community-requests";
import { COMMUNITY_ATTACHMENT_R2_PREFIX } from "../src/community-request-attachments";
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
    for (const table of ["requests", "details", "detailDeletions", "attachments", "attachmentAuthorDeletions", "attachmentDeletions", "votes", "receipts", "quotas", "moderation", "privateDiagnostics", "ownerDeletions"]) {
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

  it("stores immutable public attachments on requests and authored details", async () => {
    const { alice, bob } = await fixture();
    const request = await alice.createCommunityRequest(draft());
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const root = await alice.addCommunityRequestAttachment(request.id, {
      idempotencyKey: "root-image", name: "screen.png", mimeType: "image/png", content: image,
    });
    expect(root).toMatchObject({name: "screen.png", mimeType: "image/png", byteLength: image.length, isOwn: true});
    expect((await bob.getCommunityRequest(request.id))?.attachments).toEqual([{...root, isOwn: false}]);
    const loaded = await bob.getCommunityRequestAttachment(request.id, root.id);
    expect(loaded.attachment).toEqual({...root, isOwn: false});
    expect(loaded.content).toEqual(image);

    const detail = await bob.addCommunityRequestDetail(request.id, {
      idempotencyKey: "detail-with-file", body: "The same issue appears in this trace.",
    });
    const text = new TextEncoder().encode("bounded public evidence\n");
    const detailAttachment = await bob.addCommunityRequestAttachment(request.id, {
      idempotencyKey: "detail-file", detailId: detail.id, name: "trace.txt",
      mimeType: "text/plain", content: text,
    });
    expect((await alice.listCommunityRequestDetails(request.id)).items[0].attachments)
      .toEqual([{...detailAttachment, isOwn: false}]);
    await expect(bob.addCommunityRequestAttachment(request.id, {
      idempotencyKey: "wrong-root", name: "trace.txt", mimeType: "text/plain", content: text,
    })).rejects.toThrow("Only the request owner");
    await expect(alice.addCommunityRequestAttachment(request.id, {
      idempotencyKey: "wrong-detail", detailId: detail.id, name: "trace.txt",
      mimeType: "text/plain", content: text,
    })).rejects.toThrow("authored public detail");
  });

  it("lets only attachment authors delete their files without removing parent text", async () => {
    const { alice, bob } = await fixture();
    const request = await alice.createCommunityRequest(draft({title: "Delete authored attachments"}));
    const root = await alice.addCommunityRequestAttachment(request.id, {
      idempotencyKey: "delete-own-root", name: "root.txt", mimeType: "text/plain",
      content: new TextEncoder().encode("root evidence"),
    });
    const detail = await bob.addCommunityRequestDetail(request.id, {
      idempotencyKey: "delete-own-detail", body: "Keep this comment",
    });
    const child = await bob.addCommunityRequestAttachment(request.id, {
      idempotencyKey: "delete-own-child", detailId: detail.id, name: "child.txt", mimeType: "text/plain",
      content: new TextEncoder().encode("detail evidence"),
    });

    await expect(async () => bob.deleteCommunityRequestAttachment(request.id, root.id)).rejects.toThrow("attachment author");
    await expect(async () => alice.deleteCommunityRequestAttachment(request.id, child.id)).rejects.toThrow("attachment author");
    await alice.deleteCommunityRequestAttachment(request.id, root.id);
    await alice.deleteCommunityRequestAttachment(request.id, root.id);
    await bob.deleteCommunityRequestAttachment(request.id, child.id);
    await bob.deleteCommunityRequestAttachment(request.id, child.id);

    expect((await alice.getCommunityRequest(request.id))?.attachments).toEqual([]);
    expect((await alice.listCommunityRequestDetails(request.id)).items).toEqual([
      expect.objectContaining({id: detail.id, body: "Keep this comment", attachments: []}),
    ]);
    await runInDurableObject(registry(), async (instance, ctx) => {
      expect(ctx.storage.sql.exec("SELECT attachmentId FROM attachmentAuthorDeletions ORDER BY attachmentId").toArray())
        .toEqual([{attachmentId: root.id}, {attachmentId: child.id}].toSorted((a, b) => a.attachmentId.localeCompare(b.attachmentId)));
      ctx.storage.sql.exec("UPDATE attachmentDeletions SET notBefore=0");
      await instance.alarm();
    });
    expect(await env.BLUEPRINT_CONTENT.get(`${COMMUNITY_ATTACHMENT_R2_PREFIX}${root.id}`)).toBeNull();
    expect(await env.BLUEPRINT_CONTENT.get(`${COMMUNITY_ATTACHMENT_R2_PREFIX}${child.id}`)).toBeNull();
    await alice.deleteCommunityRequest(request.id);
    await runInDurableObject(registry(), (_instance, ctx) => {
      expect(ctx.storage.sql.exec("SELECT * FROM attachmentAuthorDeletions WHERE requestId=?", request.id).toArray()).toEqual([]);
    });
  });

  it("lets only a detail author delete their detail and durably removes its attachment", async () => {
    const { alice, bob } = await fixture();
    const request = await alice.createCommunityRequest(draft({title: "Delete authored detail"}));
    const detail = await bob.addCommunityRequestDetail(request.id, {
      idempotencyKey: "detail-delete", body: "Remove my public comment keyword",
    });
    const attachment = await bob.addCommunityRequestAttachment(request.id, {
      idempotencyKey: "detail-delete-file", detailId: detail.id,
      name: "comment.txt", mimeType: "text/plain", content: new TextEncoder().encode("remove me"),
    });

    await expect(alice.deleteCommunityRequestDetail(request.id, detail.id)).rejects.toThrow("detail author");
    await bob.deleteCommunityRequestDetail(request.id, detail.id);
    await bob.deleteCommunityRequestDetail(request.id, detail.id);

    expect((await alice.listCommunityRequestDetails(request.id)).items).toEqual([]);
    expect((await alice.searchCommunityRequests({query: "keyword"})).items).toEqual([]);
    await runInDurableObject(registry(), async (instance, ctx) => {
      expect(ctx.storage.sql.exec("SELECT * FROM details WHERE id=?", detail.id).toArray()).toEqual([]);
      expect(ctx.storage.sql.exec("SELECT * FROM attachments WHERE id=?", attachment.id).toArray()).toEqual([]);
      expect(ctx.storage.sql.exec("SELECT owner FROM detailDeletions WHERE detailId=?", detail.id).toArray())
        .toEqual([{owner: expect.any(String)}]);
      expect(ctx.storage.sql.exec("SELECT id FROM attachmentDeletions").toArray()).toEqual([{id: attachment.id}]);
      ctx.storage.sql.exec("UPDATE attachmentDeletions SET notBefore=0");
      await instance.alarm();
    });
    expect(await env.BLUEPRINT_CONTENT.get(`${COMMUNITY_ATTACHMENT_R2_PREFIX}${attachment.id}`)).toBeNull();
    await alice.deleteCommunityRequest(request.id);
    await runInDurableObject(registry(), (_instance, ctx) => {
      expect(ctx.storage.sql.exec("SELECT * FROM detailDeletions WHERE requestId=?", request.id).toArray()).toEqual([]);
    });
  });

  it("rejects unsupported, mismatched, and empty public attachments", async () => {
    const { alice } = await fixture();
    const request = await alice.createCommunityRequest(draft());
    await expect(alice.addCommunityRequestAttachment(request.id, {
      idempotencyKey: "svg", name: "active.svg", mimeType: "image/svg+xml",
      content: new TextEncoder().encode("<svg/>"),
    })).rejects.toThrow("Unsupported attachment type");
    await expect(alice.addCommunityRequestAttachment(request.id, {
      idempotencyKey: "fake-png", name: "fake.png", mimeType: "image/png",
      content: new TextEncoder().encode("not a png"),
    })).rejects.toThrow("does not match");
    await expect(alice.addCommunityRequestAttachment(request.id, {
      idempotencyKey: "empty", name: "empty.txt", mimeType: "text/plain",
      content: new Uint8Array(),
    })).rejects.toThrow("must not be empty");
  });

  it("enforces the request-wide attachment count across request and detail uploads", async () => {
    const { alice } = await fixture();
    const request = await alice.createCommunityRequest(draft());
    const detail = await alice.addCommunityRequestDetail(request.id, {
      idempotencyKey: "limit-detail", body: "Public detail with bounded files.",
    });
    for (let index = 0; index < LIMITS.attachmentsPerRequest; index++) {
      await alice.addCommunityRequestAttachment(request.id, {
        idempotencyKey: `limit-${index}`, ...(index % 2 ? {detailId: detail.id} : {}),
        name: `file-${index}.txt`, mimeType: "text/plain", content: new Uint8Array([0x61]),
      });
    }
    await expect(alice.addCommunityRequestAttachment(request.id, {
      idempotencyKey: "limit-over", name: "over.txt", mimeType: "text/plain",
      content: new Uint8Array([0x61]),
    })).rejects.toThrow("attachment limit");
    expect((await alice.getCommunityRequest(request.id))?.attachments).toHaveLength(5);
    expect((await alice.listCommunityRequestDetails(request.id)).items[0].attachments).toHaveLength(5);
  });

  it("keeps consented bug diagnostics private, sanitized, owner-bound and moderator-only", async () => {
    const { alice, bob, admin } = await fixture();
    const bug = await alice.createCommunityRequest(draft({ kind: "bug", title: "Broken export" }));
    const attachment = { idempotencyKey: "diagnostics-one", pathname: "/requests/new", diagnostics: [
      { timestamp: new Date(1000), level: "error" as const, message: "Failed at https://private.example/path token=secret-value" },
    ] };
    await alice.attachCommunityRequestDiagnostics(bug.id, attachment);
    await alice.attachCommunityRequestDiagnostics(bug.id, attachment);
    const diagnosticAlarm = await runInDurableObject(registry(), (_instance, ctx) => ctx.storage.getAlarm());
    expect(diagnosticAlarm).toBeGreaterThan(Date.now());
    await expect(bob.attachCommunityRequestDiagnostics(bug.id, attachment)).rejects.toThrow("owned bug");
    await expect(async () => alice.getCommunityRequestPrivateDiagnostics(bug.id)).rejects.toThrow("administrator");
    const evidence = await admin.getCommunityRequestPrivateDiagnostics(bug.id);
    expect(evidence).toMatchObject({ pathname: "/requests/new", diagnostics: [
      { level: "error", message: "Failed at [redacted-url] token=[redacted]" },
    ] });
    expect(evidence?.capturedAt).toBeInstanceOf(Date);
    expect(evidence?.expiresAt).toBeInstanceOf(Date);
    const publicReads = JSON.stringify([
      await bob.getCommunityRequest(bug.id), await bob.listCommunityRequests(),
      await bob.searchCommunityRequests({ query: "private.example" }),
      await bob.suggestRelatedCommunityRequests("secret-value"),
    ]);
    expect(publicReads).not.toContain("private.example");
    expect(publicReads).not.toContain("secret-value");
    await runInDurableObject(registry(), (_instance, ctx) => {
      ctx.storage.sql.exec("UPDATE privateDiagnostics SET expiresAt = 0 WHERE requestId = ?", bug.id);
    });
    expect(await admin.getCommunityRequestPrivateDiagnostics(bug.id)).toBeNull();
  });

  it("lets an author delete a request while preserving an unrestorable scrubbed moderator tombstone", async () => {
    const { alice, bob, admin } = await fixture();
    const bug = await alice.createCommunityRequest(draft({ kind: "bug", title: "Delete me", body: "private-ish authored text" }));
    await bob.voteCommunityRequest(bug.id);
    await alice.addCommunityRequestDetail(bug.id, { idempotencyKey: "delete-detail", body: "Delete this detail" });
    const publicAttachment = await alice.addCommunityRequestAttachment(bug.id, {
      idempotencyKey: "delete-attachment", name: "delete.txt", mimeType: "text/plain",
      content: new TextEncoder().encode("Delete these public bytes"),
    });
    await alice.attachCommunityRequestDiagnostics(bug.id, { idempotencyKey: "delete-diagnostics", pathname: "/requests/new", diagnostics: [] });
    await expect(async () => bob.deleteCommunityRequest(bug.id)).rejects.toThrow("request owner");
    await alice.deleteCommunityRequest(bug.id);
    await alice.deleteCommunityRequest(bug.id);
    expect(await alice.getCommunityRequest(bug.id)).toBeNull();
    expect((await bob.listCommunityRequests()).items).toEqual([]);
    const tombstone = await admin.getCommunityRequest(bug.id, true);
    expect(tombstone).toMatchObject({
      title: "[Deleted by author]", body: "", hidden: true, status: "closed", attachments: [],
    });
    await runInDurableObject(registry(), async (instance, ctx) => {
      expect(ctx.storage.sql.exec("SELECT * FROM attachments WHERE requestId=?", bug.id).toArray()).toEqual([]);
      expect(ctx.storage.sql.exec("SELECT * FROM detailDeletions WHERE requestId=?", bug.id).toArray()).toEqual([]);
      expect(ctx.storage.sql.exec("SELECT * FROM attachmentAuthorDeletions WHERE requestId=?", bug.id).toArray()).toEqual([]);
      expect(ctx.storage.sql.exec("SELECT * FROM receipts").toArray()).toEqual([]);
      expect(ctx.storage.sql.exec("SELECT id FROM attachmentDeletions").toArray())
        .toEqual([{id: publicAttachment.id}]);
      ctx.storage.sql.exec("UPDATE attachmentDeletions SET notBefore=0");
      await instance.alarm();
      expect(ctx.storage.sql.exec("SELECT id FROM attachmentDeletions").toArray()).toEqual([]);
    });
    expect(await env.BLUEPRINT_CONTENT.get(`${COMMUNITY_ATTACHMENT_R2_PREFIX}${publicAttachment.id}`)).toBeNull();
    await expect(alice.attachCommunityRequestDiagnostics(bug.id, {
      idempotencyKey: "delete-diagnostics", pathname: "/requests/new", diagnostics: [],
    })).rejects.toThrow("deleted request");
    expect(await admin.getCommunityRequestPrivateDiagnostics(bug.id)).toBeNull();
    await expect(async () => admin.moderateCommunityRequest(bug.id, command("restore"))).rejects.toThrow("cannot be restored");
  });

  it("durably retries transient object-storage failures while scrubbing deleted attachments", async () => {
    const { alice } = await fixture();
    const request = await alice.createCommunityRequest(draft({title: "Delete with retry"}));
    const attachment = await alice.addCommunityRequestAttachment(request.id, {
      idempotencyKey: "delete-retry-file", name: "retry.txt", mimeType: "text/plain",
      content: new TextEncoder().encode("public bytes awaiting durable cleanup"),
    });
    let original!: R2Bucket;
    let attempts = 0;
    await runInDurableObject(registry(), instance => {
      const fixtureEnv = Reflect.get(instance, "env") as Cloudflare.Env;
      original = fixtureEnv.BLUEPRINT_CONTENT;
      fixtureEnv.BLUEPRINT_CONTENT = new Proxy(original, {
        get(target, property) {
          if (property === "delete") return async (key: string) => {
            attempts++;
            if (attempts === 1) throw new Error("fixture transient R2 failure");
            return target.delete(key);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    await alice.deleteCommunityRequest(request.id);
    await runInDurableObject(registry(), async (instance, ctx) => {
      ctx.storage.sql.exec("UPDATE attachmentDeletions SET notBefore=0");
      await instance.alarm();
      expect(ctx.storage.sql.exec("SELECT id FROM attachmentDeletions").toArray())
        .toEqual([{id: attachment.id}]);
      ctx.storage.sql.exec("UPDATE attachmentDeletions SET notBefore=0");
      await instance.alarm();
      expect(ctx.storage.sql.exec("SELECT id FROM attachmentDeletions").toArray()).toEqual([]);
      (Reflect.get(instance, "env") as Cloudflare.Env).BLUEPRINT_CONTENT = original;
    });
    expect(attempts).toBe(2);
    expect(await original.get(`${COMMUNITY_ATTACHMENT_R2_PREFIX}${attachment.id}`)).toBeNull();
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
    expect(Object.keys(visible!).toSorted()).toEqual(["id", "kind", "title", "body", "status", "hidden", "duplicateOf", "createdAt", "updatedAt", "isOwn", "voteCount", "viewerHasVoted", "attachments"].toSorted());
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
      expect(await asAccount(1, api => api.getOpenCodeCustomization())).toEqual({ plugins: [], skills: [] });
      const customization = { plugins: ["opencode-plugin-example@1.0.0"], skills: [
        { name: "review-code", description: "Review code", instructions: "Review carefully." },
      ] };
      await asAccount(1, api => api.setOpenCodeCustomization(customization));
      expect(await asAccount(1, api => api.getOpenCodeCustomization())).toEqual(customization);
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
