// Test-only provider harness. Production exports no fixture mint/evidence/reset endpoints.
export * from "../src/server";
export { AdminAuthorizationEntrypoint } from "../src/admin-authority";
export { default } from "../src/server";
export { ContextCollectionDurableObject } from "../../gatekeeper-context/src/context-collection";
export { UserLibraryDurableObject } from "../../gatekeeper-context/src/user-library";
export { LibraryRegistryDurableObject } from "../../gatekeeper-context/src/registry-do";
export { JarvisPolicy } from "../../gatekeeper-jarvis/src/policy";

import type { AdminClaim } from "../src/admin-authority";
import type { AppUiContext, AuthorizedAppUiContext, GatekeeperUiFrame, GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";
import type { CodingSessionOwner, CodingSessionsService, RequestBuildExecutionReceipt, RequestBuildGitHubRead, RequestBuildGitHubWrite, RequestBuildIntent, RequestBuildNotifier, RequestBuildNotification, RequestBuildNotificationResult, RequestBuildNotifierReadiness, RequestBuildPolicy, RequestBuildReadiness } from "@gadgets/workshop-shared/coding-sessions";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { RpcStub, RpcTarget } from "capnweb";
import { ContextApiImpl } from "../../gatekeeper-context/src/context-api";
import { JarvisPolicyApi } from "../../gatekeeper-jarvis/src/policy";
import type { ContextApi, ContextCollectionMetadata } from "../../gatekeeper-context/src/context-types";
import { domainName } from "../../gatekeeper-context/src/domain";

/** Typed test bridge avoids merging unrelated Worker Env programs; only real owners attest. */
export class ContextFenceVendor extends WorkerEntrypoint<Cloudflare.Env, {sharingDomain: string}> {
  async adminFenceReadiness(challenge: Parameters<NonNullable<GatekeeperVendor["adminFenceReadiness"]>>[0]) {
    const domain = this.ctx.props.sharingDomain;
    return this.ctx.exports.LibraryRegistryDurableObject.getByName(domain).adminFenceReadiness(domain, challenge);
  }
}
/** Native test transport to the actual JARVIS policy owner, without copying enforcement. */
export class JarvisFenceVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async adminFenceReadiness(challenge: Parameters<NonNullable<GatekeeperVendor["adminFenceReadiness"]>>[0]) {
    return this.ctx.exports.JarvisPolicy.getByName("global").adminFenceReadiness(challenge);
  }
}

// Frozen old wire calls deliberately omit authorization; do not use upgraded wrappers here.
class LegacyContextChild extends RpcTarget {
  constructor(private env: Cloudflare.Env) { super(); }
  #collection(id: string) { return this.env.TEST_CONTEXT_COLLECTIONS.getByName(domainName("test-domain", id)); }
  async createContextCollection(title: string): Promise<ContextCollectionMetadata> {
    const metadata: ContextCollectionMetadata = {id: crypto.randomUUID(), title, description: "", visibility: "public",
      created: new Date(), lastUpdated: new Date(), documentCount: 0, content: {source: "web"}};
    return this.#collection(metadata.id).initialize(metadata, "test-domain", "");
  }
  updateContextCollection(id: string) { return this.#collection(id).updateMetadata({title: "Old write"}); }
  deleteContextCollection(id: string) { return this.#collection(id).deleteSelf(); }
  putContextDocument(id: string) { return this.#collection(id).putContextDocument("old.md", {description: "", body: "Old write"}); }
  deleteContextDocument(id: string) { return this.#collection(id).deleteContextDocument("kept.md"); }
  moveContextDocument(id: string) { return this.#collection(id).moveContextDocument("kept.md", "moved.md"); }
  syncContextCollectionArtifactSource(id: string) { return this.#collection(id).syncArtifactSource(); }
  createContextCollectionGitToken(id: string) { return this.#collection(id).createGitToken(); }
  listContextCollectionGitTokens(id: string) { return this.#collection(id).listGitTokens(); }
  revokeContextCollectionGitToken(id: string, token: string) { return this.#collection(id).revokeGitToken(token); }
}

class LegacyJarvisChild extends RpcTarget {
  constructor(private policy: DurableObjectStub<import("../../gatekeeper-jarvis/src/policy").JarvisPolicy>) { super(); }
  get() { return this.policy.get(); }
  update(input: Parameters<JarvisPolicyApi["update"]>[0]) { return this.policy.update(input); }
}

/** Exercises real native issuance and actual provider consumers, without external providers. */
export class AdminProviderTestHooks extends DurableObject<Cloudflare.Env> {
  /** Same native ctx.exports mint path as AuthenticatedApi, with test-owned runtime claims. */
  mint(claim: AdminClaim) { return this.ctx.exports.AdminAuthorizationEntrypoint({props: {claim}}); }
  /** Retain old argument shapes while using the current authoritative collection owner. */
  legacyContext(): Pick<ContextApi, Exclude<keyof LegacyContextChild, keyof RpcTarget>> {
    return new RpcStub(new LegacyContextChild(this.env));
  }
  /** Pre-upgrade policy child with no generation capability, not a harmless account wrapper. */
  legacyJarvis(): Pick<JarvisPolicyApi, "get" | "update"> {
    return new RpcStub(new LegacyJarvisChild(this.env.TEST_JARVIS_POLICY.getByName("")));
  }
  context(authorized = false, wrongPurpose = false): import("../../gatekeeper-context/src/context-types").ContextApi {
    const authorization = authorized ? (wrongPurpose ? this.env.TEST_JARVIS_AUTHORIZATION : this.env.TEST_CONTEXT_AUTHORIZATION) : undefined;
    return new RpcStub(new ContextApiImpl(this.env, "test-domain", "private-owner", false,
      this.env.TEST_CONTEXT_COLLECTIONS, this.env.TEST_USER_LIBRARIES, this.env.TEST_LIBRARY_REGISTRIES, authorization));
  }
  jarvis(regranted = false, wrongPurpose = false): Pick<JarvisPolicyApi, "get" | "update"> {
    return new RpcStub(new JarvisPolicyApi(this.env.TEST_JARVIS_POLICY.getByName(""), false,
      wrongPurpose ? this.env.TEST_CONTEXT_AUTHORIZATION : regranted ? this.env.TEST_JARVIS_REGRANTED : this.env.TEST_JARVIS_AUTHORIZATION));
  }
}

class FixtureAppUi extends RpcTarget { protocol() { return "legacy-unprivileged"; } }
class FixtureGitHubVerifier extends RpcTarget { hasRepoWriteAccess(owner: string, repo: string) { return owner === "totango" && repo === "odie-os"; } }
@validateRpc()
export class FixtureGitHubAccount extends WorkerEntrypoint {
  describe() { return {displayName: "Fixture GitHub", uniqueName: "fixture-github"}; }
  getVerifier() { return new RpcStub(new FixtureGitHubVerifier()); }
  getConnectionStatus() { return { status: "connected" }; }
}
/** Fixture transport records downgrade attempts by a distinct outcome, never fake authorization. */
@validateRpc()
export class FixtureAppAccount extends WorkerEntrypoint {
  async startAppUi(context: AppUiContext) {
    if (context.isAdmin) throw new Error("LEGACY_ADMIN_CALLED");
    return {iframeHtml: "fixture", ui: new RpcStub(new FixtureAppUi())};
  }
  async startAppUiAuthorized(_context: AuthorizedAppUiContext): Promise<GatekeeperUiFrame> {
    throw new Error("PROVIDER_DENIED_OR_UNAVAILABLE");
  }
}


/** Ordinary upgraded provider rejects any accidental elevated capability transfer. */
@validateRpc()
export class FixtureOrdinaryAppAccount extends WorkerEntrypoint {
  async startAppUiAuthorized(context: AuthorizedAppUiContext) {
    if (context.authorization) throw new Error("ORDINARY_PROVIDER_RECEIVED_AUTHORITY");
    return {iframeHtml: "ordinary-authorized", ui: new RpcStub(new FixtureAppUi())};
  }
}

const requestBuildFixturePolicy: RequestBuildPolicy = {
  version: "facade-fixture-1",
  runtimeVersion: "0.85.1",
  model: "gpt-6-astra",
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

/** Success-path facade fixture: enough of Sessions to admit/start/cancel without launching a sandbox. */
function requestBuildFixtureReceipt(dispatchKey: string, intentHash = "fixture-intent", cancelRevision = 0): RequestBuildExecutionReceipt {
  const now = Date.now();
  return { dispatchKey, intentHash, sessionId: crypto.randomUUID(), generation: 1, sequence: 1,
    state: "canceled", stage: "done", cancelRevision, createdAt: now, updatedAt: now, deadline: now + 60_000,
    cleanup: "complete" };
}

export class RequestBuildSessionsFixture extends WorkerEntrypoint implements Pick<CodingSessionsService,
  "requestBuildReadiness" | "readRequestBuildGitHub" | "ensureRequestBuild" | "getRequestBuildReceipt" |
  "cancelRequestBuildExecution" | "getRequestBuildArtifact" | "writeRequestBuildGitHub" | "editorAvailable"> {
  async requestBuildReadiness(): Promise<RequestBuildReadiness> {
    return { ready: true, reasons: [], policy: requestBuildFixturePolicy, protocolVersion: "request-build-git-data-v1" };
  }
  async readRequestBuildGitHub(operation: RequestBuildGitHubRead): Promise<string | null> {
    if (operation.kind === "base") return JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: "a".repeat(40) } });
    if (operation.kind === "commit" && operation.sha === "a".repeat(40)) return JSON.stringify({ sha: "a".repeat(40), tree: { sha: "b".repeat(40) }, parents: [], message: "fixture base" });
    return null;
  }
  async ensureRequestBuild(_owner: CodingSessionOwner, intent: RequestBuildIntent): Promise<RequestBuildExecutionReceipt> {
    return requestBuildFixtureReceipt(intent.dispatchKey, intent.policyHash);
  }
  async getRequestBuildReceipt(): Promise<null> { return null; }
  async cancelRequestBuildExecution(_owner: CodingSessionOwner, dispatchKey: string, cancelRevision: number): Promise<RequestBuildExecutionReceipt> {
    return requestBuildFixtureReceipt(dispatchKey, "fixture-intent", cancelRevision);
  }
  async getRequestBuildArtifact(): Promise<null> { return null; }
  async writeRequestBuildGitHub(_owner: CodingSessionOwner, _authorization: unknown, _operation: RequestBuildGitHubWrite): Promise<string> { throw new Error("FIXTURE_NO_PUBLICATION_WRITE"); }
  async editorAvailable(): Promise<boolean> { return false; }
}

/** Success-path facade fixture for the private JARVIS notifier readiness contract; it never posts. */
export class RequestBuildNotifierFixture extends WorkerEntrypoint implements Pick<RequestBuildNotifier, "requestBuildNotifierReadiness" | "notifyRequestBuild"> {
  async requestBuildNotifierReadiness(): Promise<RequestBuildNotifierReadiness> {
    const checkedAt = Date.now();
    return { protocol: "request-build-slack-v1" as const, configured: true, destinationVerified: true,
      posting: "unproven" as const, origin: "https://workshop.example.invalid", generation: "facade-fixture-1",
      checkedAt, expiresAt: checkedAt + 30_000 };
  }
  async notifyRequestBuild(request: RequestBuildNotification): Promise<RequestBuildNotificationResult> {
    return { status: "blocked", notificationKey: request.notificationKey };
  }
}

/** Opens the actual private Context management API with the forwarded authority, if any. */
@validateRpc()
export class FixtureContextAccount extends WorkerEntrypoint<Cloudflare.Env> {
  async startAppUiAuthorized(context: AuthorizedAppUiContext) {
    return {iframeHtml: "context-authorized", ui: new RpcStub(new ContextApiImpl(this.env,
      "test-domain", "private-owner", false, this.env.TEST_CONTEXT_COLLECTIONS,
      this.env.TEST_USER_LIBRARIES, this.env.TEST_LIBRARY_REGISTRIES, context.authorization))};
  }
}

// Imported backend source refers to these production bindings. This local fixture does not
// provide or exercise them: accidental use must throw, never fabricate provider success.
declare global { namespace Cloudflare { interface Env { LOADER: WorkerLoader; BROWSER: BrowserRun; } } }
// Same missing-runtime-export declaration as scripts/generate-worker-types.ts; no runtime patch.
declare module "cloudflare:workers" { export const restore: symbol; }
