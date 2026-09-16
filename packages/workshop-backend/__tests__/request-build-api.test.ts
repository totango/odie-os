import { env } from "cloudflare:workers";
import type { JWTPayload } from "jose";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { newHttpBatchRpcResponse, newHttpBatchRpcSession } from "capnweb";
import { expect, it, vi } from "vitest";
import type { AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";
import type { GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";
import {
  PublicApiImpl,
  type AdminAuthority,
  type AdminSettings,
  type CommunityRequests,
  type UserDurableObject,
} from "../src/server";
import { AdminApiImpl } from "../src/admin-settings";
import { requestBuildDeploymentEvidenceReasons } from "../src/community-requests";
import { buildHash, canonicalBuildJson, type CodingSessionsService, type RequestBuildNotifier, type RequestBuildPolicy } from "@gadgets/workshop-shared/coding-sessions";
import { AdminAuthorityState } from "../src/admin-authority";
import { readAdminProviderEvidence } from "../src/admin-provider-evidence";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_USER: DurableObjectNamespace<UserDurableObject>;
      TEST_ADMIN: DurableObjectNamespace<AdminSettings>;
      TEST_AUTHORITY: DurableObjectNamespace<AdminAuthority>;
      TEST_COMMUNITY_REQUESTS: DurableObjectNamespace<CommunityRequests>;
      TEST_REQUEST_BUILD_SESSIONS: Service<CodingSessionsService>;
      TEST_REQUEST_BUILD_NOTIFIER: Service<RequestBuildNotifier>;
      TEST_CONTEXT_FENCE_VENDOR: Service<GatekeeperVendor>;
      TEST_JARVIS_FENCE_VENDOR: Service<GatekeeperVendor>;
    }
  }
}

const adminPrincipal = (name: string) => env.TEST_USER.idFromName(name).toString();
async function resetManagedAuthority(name: string): Promise<void> {
  await env.TEST_USER.get(env.TEST_USER.idFromName(name)).authenticateFromCfAccess(name, true);
  await runInDurableObject(env.TEST_AUTHORITY.getByName(""), async (_instance, ctx) => {
    const authorityEnv = Reflect.get(_instance, "env");
    authorityEnv.ADMINS = [name];
    authorityEnv.GATEKEEPER_CONTEXT = env.TEST_CONTEXT_FENCE_VENDOR;
    authorityEnv.GATEKEEPER_JARVIS = env.TEST_JARVIS_FENCE_VENDOR;
    for (const table of ["admin_audit", "admin_receipts", "admin_grants", "authority_meta"]) ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
    const state = new AdminAuthorityState(ctx.storage, env.TEST_USER, authorityEnv,
      async meta => ({ ...meta, legacyDrained: true, providersCurrent: true, providerBaseline: await readAdminProviderEvidence(authorityEnv, meta) }));
    const claim = state.issue(adminPrincipal(name), name, "administration")!;
    const preview = await state.preview(claim);
    await state.prepare(claim, { expectedRevision: 0, mutationKey: "prepare", digest: preview.digest });
    await state.activate(claim, { expectedRevision: 1, mutationKey: "activate" });
  });
}
async function wireRequestBuildUser(name: string): Promise<void> {
  await runInDurableObject(env.TEST_USER.get(env.TEST_USER.idFromName(name)), instance => {
    Reflect.set(instance, "sessionsService", env.TEST_REQUEST_BUILD_SESSIONS);
    const account = Reflect.get(instance, "ctx").exports.FixtureGitHubAccount({ props: {} });
    const storage = Reflect.get(instance, "storage");
    storage.connectedAccounts.put({ id: 0, account, vendorId: "github",
      description: { displayName: "Fixture GitHub", uniqueName: "fixture-github" } });
    storage.nextAccountId.put(1);
  });
}
function wireRequestBuildFixture(board: DurableObjectStub<CommunityRequests>, deploymentEvidence: string): Promise<void> {
  return runInDurableObject(board, instance => {
    const fixtureEnv = Reflect.get(instance, "env");
    fixtureEnv.GATEKEEPER_SESSIONS = env.TEST_REQUEST_BUILD_SESSIONS;
    fixtureEnv.REQUEST_BUILD_NOTIFIER = env.TEST_REQUEST_BUILD_NOTIFIER;
    fixtureEnv.REQUEST_BUILD_DEPLOYMENT_EVIDENCE = deploymentEvidence;
    fixtureEnv.REQUEST_BUILD_PUBLICATION_POLICY = JSON.stringify({ version: "facade-fixture-1", allowedPaths: ["a.ts"], changedLines: 4, textBytes: 4096 });
    fixtureEnv.REQUEST_BUILD_WORKSHOP_ORIGIN = "https://workshop.example.invalid";
    fixtureEnv.REQUEST_BUILD_NOTIFIER_GENERATION = "facade-fixture-1";
  });
}
function publicApiRoot(accessPayload?: JWTPayload) {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "exports", {
    value: {
      UserDurableObject: env.TEST_USER,
      AdminAuthority: env.TEST_AUTHORITY,
      AdminSettings: env.TEST_ADMIN,
      CommunityRequests: env.TEST_COMMUNITY_REQUESTS,
    },
  });
  return new PublicApiImpl(ctx, env, () => {}, accessPayload);
}

it("real authenticated/admin facades expose safe read and fail-closed static readiness, never client completion", async () => {
  const name = "authority_admin_one",
    users = env.TEST_USER,
    authority = env.TEST_AUTHORITY.getByName("");
  await users.getByName(name).authenticateFromCfAccess(name, true);
  const claim = await authority.issue(users.idFromName(name).toString(), name, "administration");
  expect(claim).not.toBeNull();
  const board = env.TEST_COMMUNITY_REQUESTS.getByName("api-build-test");
  const request = await board.create(users.idFromName(name).toString(), {
    idempotencyKey: crypto.randomUUID(),
    kind: "feature",
    title: "Public",
    body: "Only authored body",
  });
  const admin = new AdminApiImpl(env.TEST_ADMIN.getByName(""), name, authority, claim!, board);
  const readiness = await admin.getRequestBuildReadiness(request.id);
  expect(readiness).toMatchObject({ ready: false, requestRevision: 1 });
  expect(readiness.reasons).toContain("ADMIN_MANAGED_NOT_ACTIVE");
  expect(readiness.reasons).not.toContain("FINANCE_GUARD_UNAVAILABLE");
  expect(readiness.reasons).toContain("LEGACY_CAPABILITIES_UNDRAINED");
  expect(readiness.reasons).toContain("BUILD_PRICING_UNVERIFIED");
  expect(readiness.reasons).toContain("BUILD_REPOSITORY_UNVERIFIED");
  expect(readiness.reasons).toContain("BUILD_MODEL_UNVERIFIED");
  await expect(
    admin.startRequestBuild({
      requestId: request.id,
      expectedRequestRevision: 1,
      mutationKey: "start",
    }),
  ).rejects.toThrow("ADMIN_MANAGED_NOT_ACTIVE");
  await runInDurableObject(board, (_instance, state) => {
    expect(
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM build_runs").one().n,
    ).toBe(0);
  });
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "exports", {
    value: {
      UserDurableObject: users,
      AdminAuthority: env.TEST_AUTHORITY,
      AdminSettings: env.TEST_ADMIN,
      CommunityRequests: env.TEST_COMMUNITY_REQUESTS,
    },
  });
  const root = new PublicApiImpl(ctx, env, () => {});
  const username = `reader_${crypto.randomUUID().replaceAll("-", "")}`;
  const token = await root.createAccount(username, "Reader", new Uint8Array([1]));
  const localFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url !== "https://build-api.test/api") throw new Error("Unexpected fetch");
    return newHttpBatchRpcResponse(req, root);
  });
  try {
    using batch = newHttpBatchRpcSession<PublicApi>("https://build-api.test/api");
    expect(
      await batch.authenticate(token!).getRequestBuild(request.id, crypto.randomUUID()),
    ).toBeNull();
    using nonAdmin = newHttpBatchRpcSession<PublicApi>("https://build-api.test/api");
    expect(await nonAdmin.authenticate(token!).getAdminApi()).toBeNull();
    using signedOut = newHttpBatchRpcSession<AuthenticatedApi>("https://build-api.test/api");
    await expect(signedOut.getRequestBuild(request.id, crypto.randomUUID())).rejects.toThrow();
    expect(localFetch).toHaveBeenCalledTimes(3);
  } finally {
    localFetch.mockRestore();
  }
});

it("authenticated PublicApi admin facade reaches managed board start/cancel with fixture-owned provider evidence", async () => {
  const adminName = `facadeadmin${crypto.randomUUID().replaceAll("-", "")}@totango.com`;
  await resetManagedAuthority(adminName);
  const policy: RequestBuildPolicy = {
    version: "facade-fixture-1",
    runtimeVersion: "0.85.1",
    model: "gpt-6-astra",
    wallTimeMs: 120000,
    modelCalls: 2,
    spendMicros: 2000,
    callChargeMicros: 1000,
    modelInputBytes: 8192,
    contextFiles: 10,
    contextBytes: 100 * 1024 * 1024,
    modelOutputTokens: 200,
    outputBytes: 8192,
    diffBytes: 4096,
    diffFiles: 2,
    concurrency: 1,
    dependencyHosts: [],
  };
  const policyHash = await buildHash(canonicalBuildJson(policy));
  const evidence = JSON.stringify({
    image: `registry.cloudflare.com/${"1".repeat(32)}/odie-os-coding-session@sha256:${"2".repeat(64)}`,
    runtimeVersion: policy.runtimeVersion,
    policyHash,
    pricing: { model: policy.model, callChargeMicros: policy.callChargeMicros, spendMicros: policy.spendMicros, source: "https://billing.example.invalid/request-build-fixture" },
    repository: "totango/odie-os",
    baseBranch: "main",
  });
  const board = env.TEST_COMMUNITY_REQUESTS.getByName("");
  await wireRequestBuildFixture(board, evidence);
  const root = publicApiRoot({ email: adminName });
  await root.authenticateFromCfAccess();
  await wireRequestBuildUser(adminName);
  await resetManagedAuthority(adminName);
  const authed = await root.authenticateFromCfAccess();
  const request = await authed.createCommunityRequest({
    idempotencyKey: crypto.randomUUID().replaceAll("-", ""),
    kind: "feature",
    title: "Facade success",
    body: "Exercise the authenticated facade path only.",
  });
  const rootText = new TextEncoder().encode("public request attachment\n");
  await authed.addCommunityRequestAttachment(request.id, {
    idempotencyKey: "root-attachment", name: "request.txt", mimeType: "text/plain", content: rootText,
  });
  const viewer = `facadeviewer${crypto.randomUUID().replaceAll("-", "")}@totango.com`;
  const viewerRoot = publicApiRoot({ email: viewer });
  const viewerApi = await viewerRoot.authenticateFromCfAccess();
  const detail = await viewerApi.addCommunityRequestDetail(request.id, {
    idempotencyKey: "public-detail", body: "Complete public conversation detail.",
  });
  const detailText = new TextEncoder().encode("public detail attachment\n");
  await viewerApi.addCommunityRequestAttachment(request.id, {
    idempotencyKey: "detail-attachment", detailId: detail.id,
    name: "detail.md", mimeType: "text/markdown", content: detailText,
  });
  const admin = await authed.getAdminApi();
  expect(admin).not.toBeNull();
  const readiness = await admin!.getRequestBuildReadiness(request.id);
  expect(readiness).toMatchObject({ ready: true, requestRevision: 4 });
  const started = await admin!.startRequestBuild({ requestId: request.id, expectedRequestRevision: readiness.requestRevision!, mutationKey: "start" });
  expect(started).toMatchObject({ requestId: request.id, requestRevision: 4, state: "queued", cleanup: "pending" });
  expect(await admin!.startRequestBuild({ requestId: request.id, expectedRequestRevision: 4, mutationKey: "start" })).toMatchObject({ runId: started.runId });
  const frozen = await runInDurableObject(board, (_instance, ctx) => {
    const value = ctx.storage.sql.exec<{value: string}>("SELECT value FROM build_runs WHERE runId=?", started.runId).one().value;
    return JSON.parse(value) as {intent: {specification: string; contextFiles: Array<{id: string; path: string; byteLength: number; sha256: string}>}};
  });
  expect(frozen.intent.specification).toContain("Exercise the authenticated facade path only.");
  expect(frozen.intent.specification).toContain("Complete public conversation detail.");
  expect(frozen.intent.specification).toContain("/workspace/.request-build/context/01-");
  expect(frozen.intent.contextFiles).toHaveLength(2);
  expect(frozen.intent.contextFiles.map(file => file.byteLength)).toEqual([rootText.length, detailText.length]);
  expect(frozen.intent.specification).not.toContain(adminName);
  expect(frozen.intent.specification).not.toContain(viewer);
  const viewerRun = await viewerApi.getRequestBuild(request.id, started.runId);
  expect(viewerRun).toMatchObject({ runId: started.runId, requestId: request.id, state: "queued" });
  expect(Object.keys(viewerRun ?? {}).toSorted()).toEqual([
    "attempt", "cancelTooLate", "cleanup", "createdAt", "requestId", "requestRevision", "runId", "state", "updatedAt",
  ].toSorted());
  const canceled = await admin!.cancelRequestBuild({ requestId: request.id, runId: started.runId, mutationKey: "cancel" });
  expect(canceled).toMatchObject({ runId: started.runId, state: "cancel_requested" });
  expect(await viewerApi.getRequestBuild(request.id, started.runId)).toMatchObject({ state: "cancel_requested" });
});

it("requires exact deployment evidence for request-build image, pricing, repository, and model readiness", async () => {
  const policy: RequestBuildPolicy = {
    version: "release-candidate",
    runtimeVersion: "0.85.1",
    model: "gpt-6-astra",
    wallTimeMs: 120000,
    modelCalls: 2,
    spendMicros: 2000,
    callChargeMicros: 1000,
    modelInputBytes: 8192,
    contextFiles: 10,
    contextBytes: 100 * 1024 * 1024,
    modelOutputTokens: 200,
    outputBytes: 8192,
    diffBytes: 4096,
    diffFiles: 2,
    concurrency: 1,
    dependencyHosts: [],
  };
  const component = { ready: true, reasons: [], policy, protocolVersion: "request-build-git-data-v1" as const };
  const policyHash = await buildHash(canonicalBuildJson(policy));
  const exactEvidence = JSON.stringify({
    image: `registry.cloudflare.com/${"1".repeat(32)}/odie-os-coding-session@sha256:${"2".repeat(64)}`,
    runtimeVersion: policy.runtimeVersion,
    policyHash,
    pricing: { model: policy.model, callChargeMicros: policy.callChargeMicros, spendMicros: policy.spendMicros, source: "https://billing.example.invalid/request-build" },
    repository: "totango/odie-os",
    baseBranch: "main",
  });
  await expect(requestBuildDeploymentEvidenceReasons(undefined, component)).resolves.toEqual([
    "BUILD_IMAGE_UNVERIFIED", "BUILD_PRICING_UNVERIFIED", "BUILD_REPOSITORY_UNVERIFIED", "BUILD_MODEL_UNVERIFIED",
  ]);
  await expect(requestBuildDeploymentEvidenceReasons(exactEvidence, component)).resolves.toEqual([]);
  await expect(requestBuildDeploymentEvidenceReasons(exactEvidence.replace(policyHash, `${"0".repeat(64)}`), component))
    .resolves.toEqual(["BUILD_POLICY_EVIDENCE_STALE", "BUILD_MODEL_UNVERIFIED"]);
  await expect(requestBuildDeploymentEvidenceReasons(exactEvidence.replace("gpt-6-astra", "other-model"), component))
    .resolves.toEqual(["BUILD_PRICING_UNVERIFIED", "BUILD_MODEL_UNVERIFIED"]);
  await expect(requestBuildDeploymentEvidenceReasons(exactEvidence.replace("totango/odie-os", "totango/other"), component))
    .resolves.toEqual(["BUILD_REPOSITORY_UNVERIFIED"]);
});
