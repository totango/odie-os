import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { AdminAuthorization, AdministratorAuditEvent, AdministratorAuditPage, AdministratorBootstrapPreview, AdministratorCandidate, AdministratorGrant, AdministratorList, AdministratorMutation, AdminAuthorityMode } from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "./user";
import { readAdminProviderEvidence, type AdminProviderBaseline } from "./admin-provider-evidence";

/** Backend-owned purpose domains; providers cannot select or widen them. */
export type AdminPurpose = import("@gadgets/workshop-shared/admin-authority").AdminAuthorizationPurpose;
/** Private issuance provenance, never accepted from a public API. */
export type AdminClaim = { principalId: string; profileId: string; epoch: string; mode: "legacy" | "managed"; generation: number; purpose: AdminPurpose };
type Meta = { schemaVersion: 1; initializedAt: number; mode: AdminAuthorityMode; revision: number; epoch: string; bootstrapDigest: string; providerBaseline?: AdminProviderBaseline };
type GrantRow = { principalId: string; profileId: string; displayName: string; generation: number; active: number };
/** Internal evidence contract. Only backend-owned controls may establish these facts. */
export type AdminTransitionEvidence = { epoch: string; revision: number; bootstrapDigest: string; legacyDrained: true; providersCurrent: true; providerBaseline: AdminProviderBaseline };

/** Preserve the exact existing ADMINS spelling and JSON-string binding semantics. */
export function configuredAdministratorProfiles(env: Pick<Cloudflare.Env, "ADMINS">): string[] {
  let value = env.ADMINS;
  if (typeof value === "string") value = JSON.parse(value);
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw new Error("AUTHORITY_UNAVAILABLE");
  return [...new Set(value)].toSorted();
}
// Pending until fresh private scans attest the indexed Context owners and JARVIS policy owner.
// Issued Git credentials, ordinary JARVIS reads and Finance operators are independent authority;
// administrator revocation does not retire those credentials or ordinary read capabilities.
const activationBlockers = ["LEGACY_CAPABILITIES_UNDRAINED"];
function providerScopes(baseline: AdminProviderBaseline): string {
  return JSON.stringify(baseline.map(({provider, domain, fenceVersion}) => ({provider, domain, fenceVersion})));
}
function bounded(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || [...value].some(character => character.charCodeAt(0) < 32)) throw new Error("INVALID_ADMIN_INPUT");
}
function cursorRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("INVALID_ADMIN_INPUT");
}

/** SQLite authority engine. Constructor injection is internal, never a binding/env/RPC override. */
export class AdminAuthorityState {
  constructor(private storage: DurableObjectStorage, private users: DurableObjectNamespace<UserDurableObject>,
      private env: Pick<Cloudflare.Env, "ADMINS">,
      private evidence: (meta: Readonly<Meta>) => Promise<AdminTransitionEvidence>) {
    const existing = storage.sql.exec<{n: number}>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('authority_meta','admin_grants','admin_audit','admin_receipts')").one().n;
    if (existing !== 0 && existing !== 4) throw new Error("AUTHORITY_UNAVAILABLE");
    storage.transactionSync(() => {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS authority_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_grants (principalId TEXT PRIMARY KEY, profileId TEXT NOT NULL, displayName TEXT NOT NULL, generation INTEGER NOT NULL, active INTEGER NOT NULL, source TEXT NOT NULL, grantedBy TEXT NOT NULL, changedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_audit (revision INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_receipts (mutationKey TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL);`);
    if (existing === 0) storage.sql.exec("INSERT INTO authority_meta VALUES (1, ?)", JSON.stringify({ schemaVersion: 1, initializedAt: Date.now(), mode: "legacy", revision: 0, epoch: crypto.randomUUID(), bootstrapDigest: "" } satisfies Meta));
    this.#meta(); // Existing but corrupt/missing metadata must never reset into static authority.
    });
  }
  #meta(): Meta {
    const row = this.storage.sql.exec<{value: string}>("SELECT value FROM authority_meta WHERE singleton=1").toArray()[0];
    if (!row) throw new Error("AUTHORITY_UNAVAILABLE");
    const meta: Meta = JSON.parse(row.value);
    if (meta.schemaVersion !== 1 || !Number.isSafeInteger(meta.initializedAt) || !["legacy", "prepared", "managed"].includes(meta.mode) || !Number.isSafeInteger(meta.revision) || meta.revision < 0 || typeof meta.epoch !== "string" || !meta.epoch || typeof meta.bootstrapDigest !== "string") throw new Error("AUTHORITY_UNAVAILABLE");
    return meta;
  }
  #grant(principalId: string): GrantRow | undefined { return this.storage.sql.exec<GrantRow>("SELECT * FROM admin_grants WHERE principalId=?", principalId).toArray()[0]; }
  #static(principalId: string, profileId: string): boolean {
    return configuredAdministratorProfiles(this.env).includes(profileId) && this.users.idFromName(profileId).toString() === principalId;
  }
  /** Mint only for an exact current account resolved by the authenticated backend. */
  issue(principalId: string, profileId: string, purpose: AdminPurpose): AdminClaim | null {
    const meta = this.#meta();
    if (!["administration", "board-moderation", "context-public", "jarvis-policy", "request-build"].includes(purpose)) throw new Error("ADMIN_REQUIRED");
    const grant = this.#grant(principalId);
    if (meta.mode === "managed" ? !grant?.active || grant.profileId !== profileId : !this.#static(principalId, profileId)) return null;
    return {principalId, profileId, purpose, epoch: meta.epoch, mode: meta.mode === "managed" ? "managed" : "legacy", generation: meta.mode === "managed" ? grant!.generation : 0};
  }
  /** Fresh local authority check, reused inside each mutation transaction. */
  assertCurrent(claim: AdminClaim, purpose?: AdminPurpose): void {
    const meta = this.#meta();
    if (!["administration", "board-moderation", "context-public", "jarvis-policy", "request-build"].includes(claim.purpose) || claim.epoch !== meta.epoch || purpose && purpose !== claim.purpose) throw new Error("ADMIN_REVOKED");
    if (meta.mode === "managed") {
      const grant = this.#grant(claim.principalId);
      if (claim.mode !== "managed" || !grant?.active || grant.profileId !== claim.profileId || grant.generation !== claim.generation) throw new Error("ADMIN_REVOKED");
    } else if (claim.mode !== "legacy" || !this.#static(claim.principalId, claim.profileId)) throw new Error("ADMIN_REVOKED");
  }
  /** Exact existing-account lookup; never creates or aliases an account. */
  async resolve(claim: AdminClaim, profileId: string): Promise<AdministratorCandidate | null> {
    this.assertCurrent(claim, "administration"); bounded(profileId);
    const id = this.users.idFromName(profileId);
    const profile = await this.users.get(id).whoamiIfExists();
    this.assertCurrent(claim, "administration");
    return profile?.id === profileId ? {principalId: id.toString(), profileId, displayName: profile.name} : null;
  }
  /** Bounded private grants projection, distinguishing effective static membership. */
  list(claim: AdminClaim, cursor = ""): AdministratorList {
    this.assertCurrent(claim, "administration");
    if (cursor) bounded(cursor);
    const meta = this.#meta();
    const rows = this.storage.sql.exec<GrantRow>("SELECT * FROM admin_grants WHERE principalId>? ORDER BY principalId LIMIT 51", cursor).toArray();
    const items: AdministratorGrant[] = rows.slice(0, 50).map(({principalId, profileId, displayName, generation, active}) => ({principalId, profileId, displayName, generation, active: !!active}));
    return {mode: meta.mode, revision: meta.revision, staticProfileIds: meta.mode === "managed" ? [] : configuredAdministratorProfiles(this.env), items,
      ...(rows.length > 50 ? {nextCursor: items.at(-1)!.principalId} : {}), blockers: meta.mode === "managed" ? [] : [...activationBlockers]};
  }
  /** Resolve every configured seed; an unknown account blocks preparation. */
  async preview(claim: AdminClaim): Promise<AdministratorBootstrapPreview> {
    this.assertCurrent(claim, "administration");
    const meta = this.#meta();
    const profiles = configuredAdministratorProfiles(this.env);
    const accounts: AdministratorCandidate[] = [], unresolvedProfileIds: string[] = [];
    for (const profileId of profiles) {
      const account = await this.resolve(claim, profileId);
      if (account) accounts.push(account); else unresolvedProfileIds.push(profileId);
    }
    const digest = (await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(accounts.map(({principalId, profileId}) => [principalId, profileId])))));
    if (this.#meta().revision !== meta.revision || JSON.stringify(profiles) !== JSON.stringify(configuredAdministratorProfiles(this.env))) throw new Error("REVISION_CONFLICT");
    return {revision: meta.revision, digest: new Uint8Array(digest).toHex(), accounts, unresolvedProfileIds};
  }
  #mutate(claim: AdminClaim, input: AdministratorMutation, action: AdministratorAuditEvent["action"], target: string, data: string, change: (meta: Meta) => [number, number]): number {
    bounded(input.mutationKey); cursorRevision(input.expectedRevision);
    return this.storage.transactionSync(() => {
      this.assertCurrent(claim, "administration");
      const payload = JSON.stringify([claim.principalId, action, target, input.expectedRevision, data]);
      const receipt = this.storage.sql.exec<{payload: string; revision: number}>("SELECT payload,revision FROM admin_receipts WHERE mutationKey=?", input.mutationKey).toArray()[0];
      if (receipt) { if (receipt.payload !== payload) throw new Error("MUTATION_KEY_CONFLICT"); return receipt.revision; }
      const meta = this.#meta();
      if (meta.revision !== input.expectedRevision) throw new Error("REVISION_CONFLICT");
      const [previousGeneration, nextGeneration] = change(meta);
      meta.revision++;
      const event: AdministratorAuditEvent = {revision: meta.revision, actorPrincipalId: claim.principalId, targetPrincipalId: target, action, previousGeneration, nextGeneration, timestamp: Date.now()};
      this.storage.sql.exec("UPDATE authority_meta SET value=? WHERE singleton=1", JSON.stringify(meta));
      this.storage.sql.exec("INSERT INTO admin_audit VALUES (?,?)", meta.revision, JSON.stringify(event));
      this.storage.sql.exec("INSERT INTO admin_receipts VALUES (?,?,?)", input.mutationKey, payload, meta.revision);
      return meta.revision;
    });
  }
  /** One-time idempotent preparation, never a recurring union with deployment config. */
  async prepare(claim: AdminClaim, input: AdministratorMutation & {digest: string}): Promise<number> {
    if (typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest)) throw new Error("ADMIN_BOOTSTRAP_UNCONFIRMED");
    if (this.#meta().mode !== "legacy") {
      // A confirmed snapshot is immutable. Retrying it must not re-resolve or union later config.
      return this.#mutate(claim, input, "prepare", "", input.digest, () => { throw new Error("ADMIN_BOOTSTRAP_ALREADY_PREPARED"); });
    }
    const preview = await this.preview(claim);
    if (!preview.accounts.length || preview.unresolvedProfileIds.length || preview.digest !== input.digest) throw new Error("ADMIN_BOOTSTRAP_UNCONFIRMED");
    return this.#mutate(claim, input, "prepare", "", input.digest, meta => {
      if (meta.mode !== "legacy") throw new Error("ADMIN_BOOTSTRAP_ALREADY_PREPARED");
      for (const account of preview.accounts) this.storage.sql.exec("INSERT INTO admin_grants VALUES (?,?,?,?,?,?,?,?)", account.principalId, account.profileId, account.displayName, 1, 1, "bootstrap", claim.principalId, Date.now());
      meta.mode = "prepared"; meta.bootstrapDigest = input.digest;
      return [0, 0];
    });
  }
  /** Transition evidence is obtained privately, then the exact revision is revalidated at commit. */
  async activate(claim: AdminClaim, input: AdministratorMutation): Promise<number> {
    this.assertCurrent(claim, "administration");
    const snapshot = this.#meta();
    if (snapshot.mode === "managed") return this.#mutate(claim, input, "activate", "", "", () => { throw new Error("ADMIN_ALREADY_MANAGED"); });
    if (snapshot.mode !== "prepared") throw new Error("ADMIN_BOOTSTRAP_UNCONFIRMED");
    const evidence = await this.evidence({...snapshot});
    return this.#mutate(claim, input, "activate", "", "", meta => {
      if (meta.mode !== "prepared" || evidence.epoch !== meta.epoch || evidence.revision !== meta.revision || evidence.bootstrapDigest !== meta.bootstrapDigest || evidence.legacyDrained !== true || evidence.providersCurrent !== true) throw new Error("ADMIN_TRANSITION_BLOCKED");
      if (evidence.providerBaseline.length !== 2) throw new Error("ADMIN_TRANSITION_BLOCKED");
      meta.providerBaseline = evidence.providerBaseline;
      meta.mode = "managed";
      return [0, 0];
    });
  }
  /** Fresh readiness after activation; domain/version baseline is immutable, inventory may grow. */
  async assertProvidersCurrent(): Promise<void> {
    const snapshot = this.#meta();
    if (snapshot.mode !== "managed" || !snapshot.providerBaseline) throw new Error("LEGACY_CAPABILITIES_UNDRAINED");
    const current = await this.evidence(snapshot);
    if (this.#meta().revision !== snapshot.revision || providerScopes(current.providerBaseline) !== providerScopes(snapshot.providerBaseline)) {
      throw new Error("LEGACY_CAPABILITIES_UNDRAINED");
    }
  }
  /** Real generation-advancing grant transaction; never effective before managed cutover. */
  async grant(claim: AdminClaim, input: AdministratorMutation & {profileId: string}): Promise<number> {
    this.assertCurrent(claim, "administration");
    if (this.#meta().mode !== "managed") throw new Error("ADMIN_MANAGED_NOT_ACTIVE");
    const target = await this.resolve(claim, input.profileId);
    if (!target) throw new Error("ACCOUNT_NOT_FOUND");
    return this.#mutate(claim, input, "grant", target.principalId, target.profileId, meta => {
      if (meta.mode !== "managed") throw new Error("ADMIN_MANAGED_NOT_ACTIVE");
      const previous = this.#grant(target.principalId);
      if (previous?.active) throw new Error("ADMIN_ALREADY_GRANTED");
      const generation = (previous?.generation ?? 0) + 1;
      this.storage.sql.exec("INSERT INTO admin_grants VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(principalId) DO UPDATE SET profileId=excluded.profileId,displayName=excluded.displayName,generation=excluded.generation,active=1,source=excluded.source,grantedBy=excluded.grantedBy,changedAt=excluded.changedAt", target.principalId, target.profileId, target.displayName, generation, 1, "grant", claim.principalId, Date.now());
      return [previous?.generation ?? 0, generation];
    });
  }
  /** Revoke and retain history. Actor check, last-admin protection and receipt share one transaction. */
  revoke(claim: AdminClaim, input: AdministratorMutation & {principalId: string}): number {
    bounded(input.principalId);
    return this.#mutate(claim, input, "revoke", input.principalId, "", meta => {
      if (meta.mode !== "managed") throw new Error("ADMIN_MANAGED_NOT_ACTIVE");
      if (input.principalId === claim.principalId) throw new Error("SELF_REVOKE_FORBIDDEN");
      const previous = this.#grant(input.principalId);
      if (!previous?.active) throw new Error("ADMIN_NOT_GRANTED");
      if (this.storage.sql.exec<{n: number}>("SELECT COUNT(*) AS n FROM admin_grants WHERE active=1").one().n <= 1) throw new Error("LAST_ADMIN");
      this.storage.sql.exec("UPDATE admin_grants SET active=0,generation=generation+1,changedAt=? WHERE principalId=?", Date.now(), input.principalId);
      return [previous.generation, previous.generation + 1];
    });
  }
  /** Private forward-only bounded audit projection. */
  audit(claim: AdminClaim, cursor = 0): AdministratorAuditPage {
    this.assertCurrent(claim, "administration"); cursorRevision(cursor);
    const rows = this.storage.sql.exec<{value: string}>("SELECT value FROM admin_audit WHERE revision>? ORDER BY revision LIMIT 51", cursor).toArray();
    const items: AdministratorAuditEvent[] = rows.slice(0, 50).map(row => JSON.parse(row.value));
    return {items, ...(rows.length > 50 ? {nextCursor: items.at(-1)!.revision} : {})};
  }
}

/** Deployment singleton; no test evidence injection is exposed by its constructor or RPC surface. */
export class AdminAuthority extends DurableObject<Cloudflare.Env> {
  #state = new AdminAuthorityState(this.ctx.storage, this.ctx.exports.UserDurableObject, this.env,
    async meta => ({...meta, legacyDrained: true, providersCurrent: true,
      providerBaseline: await readAdminProviderEvidence(this.env, meta)}));
  /** Binding-only live provider readiness, compared with the atomically recorded activation baseline. */
  async assertProvidersCurrent() { await this.#state.assertProvidersCurrent(); }
  issue(...args: Parameters<AdminAuthorityState["issue"]>) { return this.#state.issue(...args); }
  assertCurrent(...args: Parameters<AdminAuthorityState["assertCurrent"]>) { return this.#state.assertCurrent(...args); }
  list(...args: Parameters<AdminAuthorityState["list"]>) { return this.#state.list(...args); }
  async resolve(...args: Parameters<AdminAuthorityState["resolve"]>) { return await this.#state.resolve(...args); }
  async preview(...args: Parameters<AdminAuthorityState["preview"]>) { return await this.#state.preview(...args); }
  async prepare(...args: Parameters<AdminAuthorityState["prepare"]>) { return await this.#state.prepare(...args); }
  async activate(...args: Parameters<AdminAuthorityState["activate"]>) { return await this.#state.activate(...args); }
  async grant(...args: Parameters<AdminAuthorityState["grant"]>) { return await this.#state.grant(...args); }
  revoke(...args: Parameters<AdminAuthorityState["revoke"]>) { return this.#state.revoke(...args); }
  audit(...args: Parameters<AdminAuthorityState["audit"]>) { return this.#state.audit(...args); }
}

/** Persistent native reference, minted only through trusted backend ctx.exports with fixed props. */
export class AdminAuthorizationEntrypoint extends WorkerEntrypoint<Cloudflare.Env, {claim: AdminClaim}> implements AdminAuthorization {
  /** Checks the issuer's current deployment state on every provider admission. */
  async assertCurrent(expectedPurpose: AdminPurpose): Promise<void> {
    if (!expectedPurpose) throw new Error("ADMIN_REQUIRED");
    await this.ctx.exports.AdminAuthority.getByName("").assertCurrent(this.ctx.props.claim, expectedPurpose);
  }
}
