import { DurableObject } from "cloudflare:workers";
import { RequestBuilds } from "./request-builds";
import { parseBuildPublicationPolicy } from "./request-build-publisher";
import type { AdminClaim } from "./admin-authority";
import { buildHash, canonicalBuildJson, requestBuildNotifierDestinationReady } from "@gadgets/workshop-shared/coding-sessions";
import type { CodingSessionsService, CodingSessionOwner, RequestBuildAuthorizationRequest, RequestBuildReadiness, StartRequestBuild, CancelRequestBuild } from "@gadgets/workshop-shared/coding-sessions";
import {
  COMMUNITY_REQUEST_LIMITS as LIMITS,
  type AddCommunityRequestDetail, type AttachCommunityRequestDiagnostics,
  type CommunityRequest, type CommunityRequestDetail, type CommunityRequestDetailPage,
  type CommunityRequestPage, type CommunityRequestPageOptions, type CommunityRequestPrivateDiagnostics,
  type CommunityRequestQuery, type CreateCommunityRequest, type ModerateCommunityRequest,
} from "@gadgets/workshop-shared/community-requests";
import { sanitizeProductFeedbackText } from "@gadgets/workshop-shared/product-feedback";

/** One registry per deployment; only the authenticated server facade holds this namespace. */
export const COMMUNITY_REQUESTS_SINGLETON_NAME = "";

type RequestRow = {
  id: string; owner: string; kind: "feature" | "bug"; title: string; body: string;
  status: "open" | "closed"; hidden: number; duplicateOf: string | null;
  createdAt: number; updatedAt: number;
};
type DetailRow = { id: string; requestId: string; owner: string; body: string; createdAt: number };
type PrivateDiagnosticsRow = {
  requestId: string; owner: string; retryKey: string; payload: string;
  pathname: string; diagnostics: string; capturedAt: number; expiresAt: number;
};
type Receipt = { payload: string; resultId: string };
const PRIVATE_DIAGNOSTICS_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

// Explicit allowlists apply even to in-process/native RPC calls, independently of validateRpc.
function fields(value: object, allowed: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(field => !allowed.includes(field))) throw new Error("Invalid board input.");
}
function text(value: string, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || [...value].some(char => {
        const code = char.charCodeAt(0);
        return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
      })) {
    throw new Error("Invalid board text.");
  }
  const result = value.trim();
  if (!empty && !result) throw new Error("Board text is required.");
  return result;
}
function id(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("Invalid board identifier.");
  }
  return value;
}
function key(value: string): string {
  if (typeof value !== "string" || value.length > LIMITS.idempotencyKey || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid board retry key.");
  }
  return value;
}
function page(options: CommunityRequestPageOptions, scope: string): { limit: number; time: number; id: string } {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.page ||
      (options.includeHidden !== undefined && typeof options.includeHidden !== "boolean")) {
    throw new Error("Invalid board page.");
  }
  if (options.cursor === undefined) return { limit, time: 0, id: "" };
  try {
    if (typeof options.cursor !== "string" || options.cursor.length > 2000) throw new Error();
    const decoded: unknown = JSON.parse(atob(options.cursor));
    if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== scope ||
        !Number.isSafeInteger(decoded[1]) || decoded[1] < 1 || typeof decoded[2] !== "string") throw new Error();
    return { limit, time: decoded[1], id: id(decoded[2]) };
  } catch { throw new Error("Invalid board cursor."); }
}
function cursor(scope: string, row: { createdAt: number; id: string }): string {
  // Scope can contain Unicode user text; encode it without relying on btoa accepting Unicode.
  return btoa(JSON.stringify([scope, row.createdAt, row.id]).replace(/[\u007f-\uffff]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
}

type RequestBuildDeploymentEvidence = {
  image: string;
  runtimeVersion: string;
  policyHash: string;
  pricing: { model: string; callChargeMicros: number; spendMicros: number; source: string };
  repository: "totango/odie-os";
  baseBranch: "main";
};

function safeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

export async function requestBuildDeploymentEvidenceReasons(
    raw: string | undefined, component: RequestBuildReadiness | undefined): Promise<string[]> {
  const policy = component?.policy;
  const missing = ["BUILD_IMAGE_UNVERIFIED", "BUILD_PRICING_UNVERIFIED", "BUILD_REPOSITORY_UNVERIFIED", "BUILD_MODEL_UNVERIFIED"];
  if (!policy || !raw) return missing;
  let evidence: RequestBuildDeploymentEvidence;
  try { evidence = JSON.parse(raw); }
  catch { return missing; }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
      Object.keys(evidence).toSorted().join(",") !== "baseBranch,image,policyHash,pricing,repository,runtimeVersion") return missing;
  const reasons: string[] = [];
  if (!/^registry\.cloudflare\.com\/[a-f0-9]{32}\/odie-os-coding-session@sha256:[a-f0-9]{64}$/.test(evidence.image) ||
      evidence.runtimeVersion !== policy.runtimeVersion) reasons.push("BUILD_IMAGE_UNVERIFIED");
  if (evidence.policyHash !== await buildHash(canonicalBuildJson(policy))) reasons.push("BUILD_POLICY_EVIDENCE_STALE");
  if (!evidence.pricing || typeof evidence.pricing !== "object" || Array.isArray(evidence.pricing) ||
      Object.keys(evidence.pricing).toSorted().join(",") !== "callChargeMicros,model,source,spendMicros" ||
      evidence.pricing.model !== policy.model || evidence.pricing.callChargeMicros !== policy.callChargeMicros ||
      evidence.pricing.spendMicros !== policy.spendMicros || !safeHttpsUrl(evidence.pricing.source)) reasons.push("BUILD_PRICING_UNVERIFIED");
  if (evidence.repository !== "totango/odie-os" || evidence.baseBranch !== "main") reasons.push("BUILD_REPOSITORY_UNVERIFIED");
  if (evidence.pricing?.model !== policy.model || evidence.policyHash !== await buildHash(canonicalBuildJson(policy))) reasons.push("BUILD_MODEL_UNVERIFIED");
  return reasons;
}

/**
 * Authored-public-only SQLite registry. No private feedback, Reporter, workspace, session or
 * data is imported here. Private build control consumes only an immutable authored-public snapshot.
 * Account IDs/receipts/quotas/audit and execution capabilities stay internal.
 * All read-modify-write work is synchronous and transactional, including quotas and retry receipts.
 */
export class CommunityRequests extends DurableObject<Cloudflare.Env> {
  #builds: RequestBuilds;
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
        body TEXT NOT NULL, searchText TEXT NOT NULL, status TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0,
        duplicateOf TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requests_listing ON requests(hidden, createdAt DESC, id DESC);
      CREATE INDEX IF NOT EXISTS requests_duplicates ON requests(duplicateOf);
      CREATE TABLE IF NOT EXISTS details (
        id TEXT PRIMARY KEY, requestId TEXT NOT NULL, owner TEXT NOT NULL, body TEXT NOT NULL, searchText TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS details_listing ON details(requestId, createdAt, id);
      CREATE TABLE IF NOT EXISTS votes (
        requestId TEXT NOT NULL, owner TEXT NOT NULL, PRIMARY KEY(requestId, owner)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        owner TEXT NOT NULL, operation TEXT NOT NULL, retryKey TEXT NOT NULL,
        payload TEXT NOT NULL, resultId TEXT NOT NULL, PRIMARY KEY(owner, operation, retryKey)
      );
      CREATE TABLE IF NOT EXISTS quotas (
        owner TEXT NOT NULL, bucket TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY(owner, bucket)
      );
      CREATE TABLE IF NOT EXISTS request_revisions (requestId TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS moderation (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, requestId TEXT NOT NULL, action TEXT NOT NULL,
        duplicateOf TEXT, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS privateDiagnostics (
        requestId TEXT PRIMARY KEY, owner TEXT NOT NULL, retryKey TEXT NOT NULL, payload TEXT NOT NULL,
        pathname TEXT NOT NULL, diagnostics TEXT NOT NULL, capturedAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS privateDiagnostics_expiry ON privateDiagnostics(expiresAt);
      CREATE TABLE IF NOT EXISTS ownerDeletions (
        requestId TEXT PRIMARY KEY, owner TEXT NOT NULL, deletedAt INTEGER NOT NULL
      );
    `);
    const sessions = (): Service<CodingSessionsService> => {
      if (!this.env.GATEKEEPER_SESSIONS) throw new Error("PROVIDER_PROTOCOL_UNAVAILABLE");
      return this.env.GATEKEEPER_SESSIONS;
    };
    this.#builds = new RequestBuilds(ctx.storage, {
      sessions: {
        requestBuildReadiness: () => sessions().requestBuildReadiness(),
        ensureRequestBuild: (owner, intent) => sessions().ensureRequestBuild(owner, intent),
        getRequestBuildReceipt: (owner, key) => sessions().getRequestBuildReceipt(owner, key),
        cancelRequestBuildExecution: (owner, key, revision) => sessions().cancelRequestBuildExecution(owner, key, revision),
        getRequestBuildArtifact: (owner, key) => sessions().getRequestBuildArtifact(owner, key),
        readRequestBuildGitHub: operation => sessions().readRequestBuildGitHub(operation),
        writeRequestBuildGitHub: (owner, authorization, operation) => sessions().writeRequestBuildGitHub(owner, authorization, operation),
      },
      assertCurrent: claim => this.ctx.exports.AdminAuthority.getByName("").assertCurrent(claim, "request-build"),
      eligibility: (claim, model) => this.ctx.exports.UserDurableObject.get(this.ctx.exports.UserDurableObject.idFromString(claim.principalId)).requestBuildEligibility(model),
      // No binding/env/browser override can manufacture these missing live proofs. Internal fixtures
      // exercise the SAME controller with actual fixture-owned readiness, not this production factory.
      activationReasons: async component => {
        const reasons = await requestBuildDeploymentEvidenceReasons(this.env.REQUEST_BUILD_DEPLOYMENT_EVIDENCE, component);
        try { await this.ctx.exports.AdminAuthority.getByName("").assertProvidersCurrent(); }
        catch { reasons.push("LEGACY_CAPABILITIES_UNDRAINED"); }
        let destinationVerified = false;
        try {
          const notifier = await this.env.REQUEST_BUILD_NOTIFIER?.requestBuildNotifierReadiness();
          if (notifier?.protocol !== "request-build-slack-v1" || !notifier.configured) reasons.push("NOTIFIER_CONFIGURATION_UNAVAILABLE");
          destinationVerified = requestBuildNotifierDestinationReady(notifier, this.env.REQUEST_BUILD_WORKSHOP_ORIGIN, this.env.REQUEST_BUILD_NOTIFIER_GENERATION);
          const origin = new URL(this.env.REQUEST_BUILD_WORKSHOP_ORIGIN ?? "");
          if (origin.protocol !== "https:" || origin.origin !== this.env.REQUEST_BUILD_WORKSHOP_ORIGIN || origin.username || origin.password) reasons.push("NOTIFIER_ORIGIN_INVALID");
        } catch { reasons.push("NOTIFIER_CONFIGURATION_UNAVAILABLE"); }
        if (!destinationVerified) reasons.push("NOTIFIER_DESTINATION_UNVERIFIED");
        return reasons;
      },
      notifierGeneration: this.env.REQUEST_BUILD_NOTIFIER_GENERATION,
      notifier: this.env.REQUEST_BUILD_NOTIFIER,
      notificationOrigin: this.env.REQUEST_BUILD_WORKSHOP_ORIGIN,
      publicationPolicy: () => parseBuildPublicationPolicy(this.env.REQUEST_BUILD_PUBLICATION_POLICY),
      specification: requestId => {
        const row = this.#get(requestId);
        if (!row) return null;
        const revision = this.ctx.storage.sql.exec<{revision: number}>("SELECT revision FROM request_revisions WHERE requestId=?", requestId).toArray()[0]?.revision ?? 1;
        return {revision, specification: `${row.kind}: ${row.title}\n\n${row.body}`, open: row.status === "open" && !row.duplicateOf};
      },
    });
    ctx.blockConcurrencyWhile(() => this.#builds.recover());
  }

  /** Private purpose-bound build admission; only the authenticated AdminApi facade supplies claims. */
  startRequestBuild(claim: AdminClaim, input: StartRequestBuild) { return this.#builds.start(claim, input); }
  /** Current admin cancellation does not transfer the initiator's execution authority. */
  cancelRequestBuild(claim: AdminClaim, input: CancelRequestBuild) { return this.#builds.cancel(claim, input); }
  /** Closed readiness/revision projection, never accepts caller evidence. */
  requestBuildReadiness(claim: AdminClaim, requestId: string) { return this.#builds.readiness(claim, requestId); }
  /** Private Sessions callback performs real persisted/current admission, not an UNKNOWN_RUN placeholder. */
  authorizeRequestBuild(owner: CodingSessionOwner, request: RequestBuildAuthorizationRequest) { return this.#builds.authorize(owner, request); }
  /** Authenticated ordinary users need no GitHub account to read a visible public run. */
  getRequestBuild(owner: string, requestId: string, runId: string) { return this.#read(owner, () => this.#builds.get(requestId, runId)); }
  /** Authenticated newest-first history, always filtered by public request visibility. */
  listRequestBuilds(owner: string, requestId: string) { return this.#read(owner, () => this.#builds.list(requestId)); }
  /** Durable receipts, private-evidence expiry and exact-generation cleanup progress independently of browsers. */
  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM privateDiagnostics WHERE expiresAt <= ?", Date.now());
    try { await this.#builds.alarm(); }
    finally { await this.#armPrivateDiagnostics(); }
  }

  async #armPrivateDiagnostics(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{expiresAt: number}>(
      "SELECT MIN(expiresAt) AS expiresAt FROM privateDiagnostics").toArray()[0]?.expiresAt;
    if (!Number.isSafeInteger(next)) return;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > next) await this.ctx.storage.setAlarm(next);
  }

  #charge(owner: string, bucket: string, maximum: number, milliseconds: number): void {
    const window = Math.floor(Date.now() / milliseconds);
    const current = this.ctx.storage.sql.exec<{ window: number; count: number }>(
      "SELECT window, count FROM quotas WHERE owner = ? AND bucket = ?", owner, bucket).toArray()[0];
    const count = current?.window === window ? current.count + 1 : 1;
    if (count > maximum) throw new Error("Board rate limit reached. Please try again later.");
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO quotas VALUES (?, ?, ?, ?)", owner, bucket, window, count);
  }
  #read<T>(owner: string, fn: () => T): T {
    return this.ctx.storage.transactionSync(() => {
      this.#charge(owner, "read", LIMITS.readsPerMinute, 60_000);
      return fn();
    });
  }
  #mutation(owner: string, special?: "create" | "detail"): void {
    this.#charge(owner, "write", LIMITS.writesPerMinute, 60_000);
    if (special) this.#charge(owner, special,
      special === "create" ? LIMITS.createsPerHour : LIMITS.detailsPerHour, 3_600_000);
  }
  #receipt(owner: string, operation: string, retryKey: string, payload: string): string | undefined {
    const receipt = this.ctx.storage.sql.exec<Receipt>(
      "SELECT payload, resultId FROM receipts WHERE owner = ? AND operation = ? AND retryKey = ?",
      owner, operation, key(retryKey)).toArray()[0];
    if (receipt && receipt.payload !== payload) throw new Error("Board retry key already used for different input.");
    return receipt?.resultId;
  }
  #remember(owner: string, operation: string, retryKey: string, payload: string, resultId: string): void {
    this.ctx.storage.sql.exec("INSERT INTO receipts VALUES (?, ?, ?, ?, ?)", owner, operation, retryKey, payload, resultId);
  }
  #get(requestId: string, includeHidden = false): RequestRow | undefined {
    return this.ctx.storage.sql.exec<RequestRow>(
      "SELECT * FROM requests WHERE id = ? AND (hidden = 0 OR ?)", id(requestId), includeHidden ? 1 : 0).toArray()[0];
  }
  #require(requestId: string, includeHidden = false): RequestRow {
    const row = this.#get(requestId, includeHidden);
    if (!row) throw new Error("Board request unavailable.");
    return row;
  }
  #project(row: RequestRow, owner: string): CommunityRequest {
    const vote = this.ctx.storage.sql.exec<{ count: number; own: number }>(
      "SELECT COUNT(*) AS count, COALESCE(MAX(owner = ?), 0) AS own FROM votes WHERE requestId = ?",
      owner, row.id).one();
    return {
      id: row.id, kind: row.kind, title: row.title, body: row.body, status: row.status,
      hidden: !!row.hidden, duplicateOf: row.duplicateOf && this.#get(row.duplicateOf) ? row.duplicateOf : null,
      createdAt: row.createdAt, updatedAt: row.updatedAt, isOwn: row.owner === owner,
      voteCount: vote.count, viewerHasVoted: !!vote.own,
    };
  }
  #detail(row: DetailRow, owner: string): CommunityRequestDetail {
    return { id: row.id, body: row.body, createdAt: row.createdAt, isOwn: row.owner === owner };
  }

  /** Internal authenticated facade supplies the immutable account DO ID; no client-supplied owner. */
  create(owner: string, input: CreateCommunityRequest): CommunityRequest {
    fields(input, ["idempotencyKey", "kind", "title", "body"]);
    if (input.kind !== "feature" && input.kind !== "bug") throw new Error("Invalid board kind.");
    const title = text(input.title, LIMITS.title), body = text(input.body, LIMITS.body);
    const payload = JSON.stringify([input.kind, title, body]);
    return this.#read(owner, () => {
      const prior = this.#receipt(owner, "create", input.idempotencyKey, payload);
      if (prior) return this.#project(this.#require(prior), owner);
      this.#mutation(owner, "create");
      const requestId = crypto.randomUUID(), now = Date.now();
      this.ctx.storage.sql.exec("INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, 'open', 0, NULL, ?, ?)",
        requestId, owner, input.kind, title, body, `${title}\n${body}`.toLowerCase(), now, now);
      this.#remember(owner, "create", input.idempotencyKey, payload, requestId);
      return this.#project(this.#require(requestId), owner);
    });
  }

  /** Attach one explicit-consent private diagnostic bundle to an owned bug. */
  attachDiagnostics(owner: string, requestId: string, input: AttachCommunityRequestDiagnostics): void {
    fields(input, ["idempotencyKey", "pathname", "diagnostics"]);
    id(requestId);
    key(input.idempotencyKey);
    if (typeof input.pathname !== "string" || !input.pathname.startsWith("/") ||
        input.pathname.includes("?") || input.pathname.includes("#") ||
        input.pathname.length > LIMITS.diagnosticPathname) throw new Error("Invalid diagnostic pathname.");
    if (!Array.isArray(input.diagnostics) || input.diagnostics.length > LIMITS.diagnosticEntries) {
      throw new Error("Invalid diagnostic entries.");
    }
    const diagnostics = input.diagnostics.map(entry => {
      fields(entry, ["timestamp", "level", "message"]);
      if (!entry || !["log", "info", "warn", "error"].includes(entry.level) ||
          typeof entry.message !== "string" || entry.message.length > LIMITS.diagnosticMessage) {
        throw new Error("Invalid diagnostic entry.");
      }
      const timestamp = entry.timestamp instanceof Date ? entry.timestamp : new Date(`${entry.timestamp}`);
      if (Number.isNaN(timestamp.valueOf())) throw new Error("Invalid diagnostic timestamp.");
      return {timestamp: timestamp.valueOf(), level: entry.level,
        message: text(sanitizeProductFeedbackText(entry.message), LIMITS.diagnosticMessage, true)};
    }).filter(entry => entry.message);
    const payload = JSON.stringify([input.pathname, diagnostics]);
    this.#read(owner, () => {
      const request = this.#require(requestId, true);
      if (request.owner !== owner || request.kind !== "bug") throw new Error("Private diagnostics require an owned bug report.");
      if (this.ctx.storage.sql.exec(
          "SELECT 1 FROM ownerDeletions WHERE requestId = ?", requestId).toArray().length) {
        throw new Error("Private diagnostics cannot be attached to a deleted request.");
      }
      const existing = this.ctx.storage.sql.exec<PrivateDiagnosticsRow>(
        "SELECT * FROM privateDiagnostics WHERE requestId = ?", requestId).toArray()[0];
      if (existing) {
        if (existing.retryKey === input.idempotencyKey && existing.payload === payload) return;
        if (existing.retryKey === input.idempotencyKey) throw new Error("Diagnostic retry key already used for different input.");
        throw new Error("Private diagnostics are already attached.");
      }
      this.#mutation(owner);
      const capturedAt = Date.now(), expiresAt = capturedAt + PRIVATE_DIAGNOSTICS_TTL_MS;
      this.ctx.storage.sql.exec("INSERT INTO privateDiagnostics VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        requestId, owner, input.idempotencyKey, payload, input.pathname, JSON.stringify(diagnostics), capturedAt, expiresAt);
    });
    this.ctx.waitUntil(this.#armPrivateDiagnostics());
  }

  /** Remove an owned request from public view and scrub authored text, details, votes and diagnostics. */
  deleteOwned(owner: string, requestId: string): void {
    id(requestId);
    this.#read(owner, () => {
      const request = this.#require(requestId, true);
      if (request.owner !== owner) throw new Error("Only the request owner can delete it.");
      if (this.ctx.storage.sql.exec("SELECT 1 FROM ownerDeletions WHERE requestId = ?", requestId).toArray().length) return;
      this.#mutation(owner);
      const now = Date.now();
      this.ctx.storage.sql.exec("INSERT INTO ownerDeletions VALUES (?, ?, ?)", requestId, owner, now);
      this.ctx.storage.sql.exec("UPDATE requests SET title = '[Deleted by author]', body = '', searchText = '', status = 'closed', hidden = 1, duplicateOf = NULL, updatedAt = ? WHERE id = ?", now, requestId);
      this.ctx.storage.sql.exec("DELETE FROM details WHERE requestId = ?", requestId);
      this.ctx.storage.sql.exec("DELETE FROM votes WHERE requestId = ?", requestId);
      this.ctx.storage.sql.exec("DELETE FROM privateDiagnostics WHERE requestId = ?", requestId);
      this.ctx.storage.sql.exec("INSERT INTO request_revisions VALUES (?,2) ON CONFLICT(requestId) DO UPDATE SET revision=revision+1", requestId);
    });
  }

  /** Read unexpired private diagnostics only after a fresh purpose-bound authority check. */
  async privateDiagnostics(claim: AdminClaim, requestId: string): Promise<CommunityRequestPrivateDiagnostics | null> {
    await this.ctx.exports.AdminAuthority.getByName("").assertCurrent(claim, "board-moderation");
    id(requestId);
    return this.#read(claim.principalId, () => {
      this.ctx.storage.sql.exec("DELETE FROM privateDiagnostics WHERE expiresAt <= ?", Date.now());
      const row = this.ctx.storage.sql.exec<PrivateDiagnosticsRow>(
        "SELECT * FROM privateDiagnostics WHERE requestId = ?", requestId).toArray()[0];
      if (!row) return null;
      const diagnostics = JSON.parse(row.diagnostics) as Array<{timestamp: number; level: "log" | "info" | "warn" | "error"; message: string}>;
      return {pathname: row.pathname,
        diagnostics: diagnostics.map(entry => ({...entry, timestamp: new Date(entry.timestamp)})),
        capturedAt: new Date(row.capturedAt), expiresAt: new Date(row.expiresAt)};
    });
  }

  /** Internal read; includeHidden is supplied only after the facade's current admin check. */
  get(owner: string, requestId: string, includeHidden = false): CommunityRequest | null {
    return this.#read(owner, () => {
      const row = this.#get(requestId, includeHidden);
      return row ? this.#project(row, owner) : null;
    });
  }

  /** Bounded literal public-text search; SQL parameters never include private evidence. */
  list(owner: string, options: CommunityRequestQuery = {}): CommunityRequestPage {
    fields(options, ["query", "kind", "status", "limit", "cursor", "includeHidden"]);
    if (options.kind !== undefined && options.kind !== "feature" && options.kind !== "bug" ||
        options.status !== undefined && options.status !== "open" && options.status !== "closed") {
      throw new Error("Invalid board filter.");
    }
    const query = text(options.query ?? "", LIMITS.query, true).toLowerCase();
    const scope = JSON.stringify([query, options.kind ?? null, options.status ?? null, !!options.includeHidden]);
    const paging = page(options, scope);
    return this.#read(owner, () => {
      const rows = this.ctx.storage.sql.exec<RequestRow>(`SELECT r.* FROM requests r
        WHERE (r.hidden = 0 OR ?) AND (? IS NULL OR r.kind = ?) AND (? IS NULL OR r.status = ?)
        AND (? = '' OR instr(r.searchText, ?) > 0 OR EXISTS
          (SELECT 1 FROM details d WHERE d.requestId = r.id AND instr(d.searchText, ?) > 0))
        AND (? = 0 OR r.createdAt < ? OR (r.createdAt = ? AND r.id < ?))
        ORDER BY r.createdAt DESC, r.id DESC LIMIT ?`, options.includeHidden ? 1 : 0,
        options.kind ?? null, options.kind ?? null, options.status ?? null, options.status ?? null,
        query, query, query, paging.time, paging.time, paging.time, paging.id, paging.limit + 1).toArray();
      const more = rows.length > paging.limit;
      const items = rows.slice(0, paging.limit);
      return { items: items.map(row => this.#project(row, owner)),
        nextCursor: more ? cursor(scope, items[items.length - 1]) : null };
    });
  }

  /** At most eight lexical terms and ten visible matches, with no external model or data source. */
  related(owner: string, input: string, excludeId?: string): CommunityRequest[] {
    const terms = [...new Set(text(input, LIMITS.query, true).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 8);
    if (excludeId !== undefined) id(excludeId);
    return this.#read(owner, () => {
      if (!terms.length) return [];
      const score = terms.map(() => `(instr(r.searchText, ?) > 0 OR EXISTS
        (SELECT 1 FROM details d WHERE d.requestId = r.id AND instr(d.searchText, ?) > 0))`).join(" + ");
      const rows = this.ctx.storage.sql.exec<RequestRow & { score: number }>(
        `SELECT r.*, (${score}) AS score FROM requests r WHERE hidden = 0 AND id != ?
          AND score > 0 ORDER BY score DESC, createdAt DESC, id DESC LIMIT ?`,
        ...terms.flatMap(term => [term, term]), excludeId ?? "", LIMITS.related).toArray();
      return rows.map(row => this.#project(row, owner));
    });
  }

  /** Explicit account-unique vote state; no-op retries don't consume mutation quota. */
  vote(owner: string, requestId: string, voted: boolean): CommunityRequest {
    if (typeof voted !== "boolean") throw new Error("Invalid board vote.");
    return this.#read(owner, () => {
      const row = this.#require(requestId);
      const current = this.ctx.storage.sql.exec("SELECT 1 FROM votes WHERE requestId = ? AND owner = ?", requestId, owner).toArray().length > 0;
      if (current !== voted) {
        this.#mutation(owner);
        if (voted) this.ctx.storage.sql.exec("INSERT INTO votes VALUES (?, ?)", requestId, owner);
        else this.ctx.storage.sql.exec("DELETE FROM votes WHERE requestId = ? AND owner = ?", requestId, owner);
      }
      return this.#project(row, owner);
    });
  }

  /** Append an immutable public detail, atomically with its account-scoped retry receipt. */
  addDetail(owner: string, requestId: string, input: AddCommunityRequestDetail): CommunityRequestDetail {
    fields(input, ["idempotencyKey", "body"]);
    id(requestId);
    const body = text(input.body, LIMITS.detail), payload = JSON.stringify([requestId, body]);
    return this.#read(owner, () => {
      this.#require(requestId);
      const prior = this.#receipt(owner, "detail", input.idempotencyKey, payload);
      if (prior) return this.#detail(this.ctx.storage.sql.exec<DetailRow>("SELECT * FROM details WHERE id = ?", prior).one(), owner);
      this.#mutation(owner, "detail");
      const detailId = crypto.randomUUID(), now = Date.now();
      this.ctx.storage.sql.exec("INSERT INTO details VALUES (?, ?, ?, ?, ?, ?)", detailId, requestId, owner, body, body.toLowerCase(), now);
      this.ctx.storage.sql.exec("UPDATE requests SET updatedAt = ? WHERE id = ?", now, requestId);
      this.#remember(owner, "detail", input.idempotencyKey, payload, detailId);
      return { id: detailId, body, createdAt: now, isOwn: true };
    });
  }

  /** Page details only after checking request visibility, including on cursor continuation. */
  details(owner: string, requestId: string, options: CommunityRequestPageOptions = {}): CommunityRequestDetailPage {
    fields(options, ["limit", "cursor", "includeHidden"]);
    const scope = JSON.stringify([id(requestId), !!options.includeHidden]);
    const paging = page(options, scope);
    return this.#read(owner, () => {
      this.#require(requestId, options.includeHidden);
      const rows = this.ctx.storage.sql.exec<DetailRow>(`SELECT * FROM details WHERE requestId = ?
        AND (? = 0 OR createdAt > ? OR (createdAt = ? AND id > ?))
        ORDER BY createdAt, id LIMIT ?`, requestId, paging.time, paging.time, paging.time, paging.id, paging.limit + 1).toArray();
      const items = rows.slice(0, paging.limit);
      return { items: items.map(row => this.#detail(row, owner)),
        nextCursor: rows.length > paging.limit ? cursor(scope, items[items.length - 1]) : null };
    });
  }

  /** Internal admin-only mutation; current authority is rechecked at the durable mutation owner. */
  async moderate(claim: AdminClaim, requestId: string, input: ModerateCommunityRequest): Promise<CommunityRequest> {
    await this.ctx.exports.AdminAuthority.getByName("").assertCurrent(claim, "board-moderation");
    const owner = claim.principalId;
    fields(input, ["idempotencyKey", "action", "duplicateOf"]);
    id(requestId);
    if (!["hide", "restore", "close", "reopen", "duplicate"].includes(input.action) ||
        (input.action !== "duplicate" && input.duplicateOf !== undefined)) throw new Error("Invalid board moderation.");
    const target = input.action === "duplicate" ? id(input.duplicateOf!) : null;
    const payload = JSON.stringify([requestId, input.action, target]);
    return this.#read(owner, () => {
      const row = this.#require(requestId, true);
      if (this.#receipt(owner, "moderate", input.idempotencyKey, payload)) return this.#project(row, owner);
      if (target) {
        const canonical = this.#require(target);
        if (target === requestId || canonical.duplicateOf || this.ctx.storage.sql.exec(
            "SELECT 1 FROM requests WHERE duplicateOf = ? LIMIT 1", requestId).toArray().length) {
          throw new Error("Duplicate links must point to a distinct canonical request without chains.");
        }
      }
      if (input.action === "restore" && this.ctx.storage.sql.exec(
          "SELECT 1 FROM ownerDeletions WHERE requestId = ?", requestId).toArray().length) {
        throw new Error("An author-deleted request cannot be restored.");
      }
      this.#mutation(owner);
      if (input.action === "hide") row.hidden = 1;
      if (input.action === "restore") row.hidden = 0;
      if (input.action === "close" || input.action === "duplicate") row.status = "closed";
      if (input.action === "reopen") { row.status = "open"; row.duplicateOf = null; }
      if (target) row.duplicateOf = target;
      row.updatedAt = Date.now();
      this.ctx.storage.sql.exec("INSERT INTO request_revisions VALUES (?,2) ON CONFLICT(requestId) DO UPDATE SET revision=revision+1", requestId);
      this.ctx.storage.sql.exec("UPDATE requests SET status = ?, hidden = ?, duplicateOf = ?, updatedAt = ? WHERE id = ?",
        row.status, row.hidden, row.duplicateOf, row.updatedAt, requestId);
      this.ctx.storage.sql.exec("INSERT INTO moderation VALUES (?, ?, ?, ?, ?, ?)",
        crypto.randomUUID(), owner, requestId, input.action, target, row.updatedAt);
      this.#remember(owner, "moderate", input.idempotencyKey, payload, requestId);
      return this.#project(row, owner);
    });
  }
}
