import { DurableObject } from "cloudflare:workers";
import { createLogger } from "@gadgets/backend-utils/logger";
import type { CodingSessionDevelopmentCapacity } from "@gadgets/workshop-shared/api";

/** Instance tiers coordinated by the coding-session capacity service. */
export const HEAVY_SESSION_TIERS = ["standard-2", "standard-3", "standard-4"] as const;

/** A coding-session tier which needs an explicit capacity lease. */
export type HeavySessionTier = typeof HEAVY_SESSION_TIERS[number];

/** Server-owned global and per-user limits for each heavy session tier. */
export const CAPACITY_LIMITS: Readonly<Record<HeavySessionTier, Readonly<{ global: number; perUser: number }>>> = Object.freeze({
  "standard-2": Object.freeze({ global: 8, perUser: 2 }),
  "standard-3": Object.freeze({ global: 4, perUser: 1 }),
  "standard-4": Object.freeze({ global: 2, perUser: 1 }),
});

/** Time allowed for a reserved lease to become active. */
export const CAPACITY_RESERVATION_TTL_MS = 10 * 60_000;

/** Stable identity and generation fence for a capacity lease. */
export interface CapacityReservationKey {
  tier: HeavySessionTier;
  reservationId: string;
  sessionId: string;
  generation: number;
  sandboxId: string;
  userId: string;
}

/** Persisted capacity lease. Active leases do not expire. */
export interface CapacityReservationRecord extends CapacityReservationKey {
  state: "reserved" | "active";
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

/** Generation-specific fields for replacing an active lease without releasing its slot. */
export interface CapacityReservationReplacement {
  reservationId: string;
  generation: number;
  sandboxId: string;
}

/** Backwards-compatible short name used by the session registry integration. */
export type CapacityReplacement = CapacityReservationReplacement;

type CapacityLogFields = {
  tier?: HeavySessionTier;
  state?: CapacityReservationRecord["state"];
  reason?: string;
  expiredCount?: number;
};

const logger = createLogger<CapacityLogFields>({ component: "gatekeeper.sessions.capacity" });
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/|+-]{0,127}$/;

type LeaseRow = {
  tier: string;
  reservation_id: string;
  session_id: string;
  generation: number;
  sandbox_id: string;
  user_id: string;
  state: string;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
};

type GenerationRow = LeaseRow & {
  closed: number;
  predecessor_reservation_id: string | null;
  predecessor_generation: number | null;
  predecessor_sandbox_id: string | null;
};
type ReservationHistoryRow = { reservation_id: string };
type CountRow = { count: number };
type TierRow = { tier: string };
type ExpiryRow = { expires_at: number | null };

/** SQLite coordinator for one tier-sharded coding-session capacity pool. */
export class CodingSessionCapacity extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState<{}>, env: unknown) {
    super(ctx, env);
    // Keep the explicit assignments compatible with the package's lightweight Worker unit shim.
    this.ctx = ctx;
    this.env = env;
    this.#ensureSchema();
  }

  /** Returns capacity visible to one user after reclaiming expired reservations. */
  async snapshot(tier: HeavySessionTier, userId: string): Promise<CodingSessionDevelopmentCapacity> {
    validateTier(tier);
    validateIdentifier(userId, "userId");
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      this.#ensureSchema();
      this.#assertScope(tier);
      this.#deleteExpired(now);
      const active = this.#count();
      const userActive = this.#count(userId);
      const limits = CAPACITY_LIMITS[tier];
      const available = active < limits.global && userActive < limits.perUser;
      const globalRemaining = limits.global - active;
      const userRemaining = limits.perUser - userActive;
      return userRemaining <= globalRemaining
        ? { available, active: userActive, limit: limits.perUser }
        : { available, active, limit: limits.global };
    });
    await this.#scheduleAlarm();
    return result;
  }

  /** Reserves one slot. Repeating the exact request is idempotent. */
  async reserve(key: CapacityReservationKey): Promise<CapacityReservationRecord> {
    const valid = validateKey(key);
    const now = Date.now();
    const record = this.ctx.storage.transactionSync(() => {
      this.#ensureSchema();
      this.#assertScope(valid.tier);
      this.#deleteExpired(now);
      const conflict = this.#findEither(valid.reservationId, valid.sessionId, valid.generation);
      if (conflict) {
        if (sameKey(conflict, valid)) return fromRow(conflict);
        throw conflictError("Capacity reservation identity is already in use.");
      }
      const generation = this.#findGeneration(valid.sessionId);
      if (generation) {
        if (valid.generation < generation.generation) {
          throw conflictError("Capacity reservation generation is stale.");
        }
        if (valid.generation === generation.generation) {
          if (!sameKey(generation, valid)) throw conflictError("Capacity reservation generation is mismatched.");
          throw conflictError(generation.closed
            ? "Closed capacity reservation generations cannot be reopened."
            : "Capacity reservation generation has no live lease.");
        }
        if (valid.reservationId === generation.reservation_id) {
          throw conflictError("Capacity reservation IDs cannot be reused for a newer generation.");
        }
      }
      if (this.#findBySession(valid.sessionId)) {
        throw conflictError("A coding session already has a live capacity lease.");
      }
      if (this.#findReservationHistory(valid.reservationId)) {
        throw conflictError("Capacity reservation IDs cannot be reused.");
      }
      const limits = CAPACITY_LIMITS[valid.tier];
      if (this.#count() >= limits.global || this.#count(valid.userId) >= limits.perUser) {
        logger.info("capacity reservation rejected", { event: "capacity.reserve.limit", tier: valid.tier, reason: "limit" });
        throw new Error("Coding session capacity is unavailable.");
      }
      const expiresAt = now + CAPACITY_RESERVATION_TTL_MS;
      const reserved = { ...valid, state: "reserved" as const, createdAt: now, updatedAt: now, expiresAt };
      this.#insert(reserved);
      this.#insertReservationHistory(reserved);
      this.#writeGeneration(reserved, false);
      return reserved;
    });
    await this.#scheduleAlarm();
    return record;
  }

  /** Marks an exact reserved generation active. Active leases never expire. */
  async activate(key: CapacityReservationKey): Promise<CapacityReservationRecord> {
    const valid = validateKey(key);
    const now = Date.now();
    const record = this.ctx.storage.transactionSync(() => {
      this.#ensureSchema();
      this.#assertScope(valid.tier);
      this.#deleteExpired(now);
      const row = this.#findEither(valid.reservationId, valid.sessionId, valid.generation);
      if (!row || !sameKey(row, valid)) throw conflictError("Capacity reservation is stale or mismatched.");
      const generation = this.#findGeneration(valid.sessionId);
      if (!generation || !sameKey(generation, valid) || generation.closed || generation.state !== row.state) {
        throw new Error("Capacity reservation generation ledger is inconsistent.");
      }
      if (row.state === "active") return fromRow(row);
      if (row.state !== "reserved") throw new Error("Capacity reservation has an invalid state.");
      this.ctx.storage.sql.exec(
        "UPDATE capacity_leases SET state = 'active', updated_at = ?, expires_at = NULL WHERE reservation_id = ?",
        now, valid.reservationId,
      );
      const ledgerUpdate = this.ctx.storage.sql.exec(`UPDATE capacity_generations
        SET state = 'active', updated_at = ?, expires_at = NULL
        WHERE session_id = ? AND tier = ? AND reservation_id = ? AND generation = ?
          AND sandbox_id = ? AND user_id = ? AND state = 'reserved' AND closed = 0`,
      now, valid.sessionId, valid.tier, valid.reservationId, valid.generation,
      valid.sandboxId, valid.userId);
      if (ledgerUpdate.rowsWritten !== 1) {
        throw new Error("Capacity reservation generation ledger activation failed.");
      }
      return { ...valid, state: "active" as const, createdAt: row.created_at, updatedAt: now };
    });
    await this.#scheduleAlarm();
    return record;
  }

  /** Replaces an active generation with a fresh reservation while retaining the same slot. */
  async transfer(
    oldKey: CapacityReservationKey,
    replacement: CapacityReservationReplacement,
  ): Promise<CapacityReservationRecord> {
    const old = validateKey(oldKey);
    const next = validateReplacement(replacement);
    if (next.generation <= old.generation) throw new TypeError("replacement.generation must increase.");
    const replacementKey: CapacityReservationKey = {
      tier: old.tier, reservationId: next.reservationId, sessionId: old.sessionId,
      generation: next.generation, sandboxId: next.sandboxId, userId: old.userId,
    };
    const now = Date.now();
    const record = this.ctx.storage.transactionSync(() => {
      this.#ensureSchema();
      this.#assertScope(old.tier);
      this.#deleteExpired(now);
      const oldById = this.#findByReservationId(old.reservationId);
      if (!oldById) {
        const existing = this.#findEither(next.reservationId, old.sessionId, next.generation);
        const generation = this.#findGeneration(old.sessionId);
        if (existing && sameKey(existing, replacementKey) && generation &&
            sameKey(generation, replacementKey) && predecessorMatches(generation, old)) {
          return fromRow(existing);
        }
        throw conflictError("Capacity transfer is stale or mismatched.");
      }
      if (!sameKey(oldById, old) || oldById.state !== "active") {
        throw conflictError("Capacity transfer requires the exact active generation.");
      }
      const collision = this.#findEither(next.reservationId, old.sessionId, next.generation);
      if (collision) throw conflictError("Replacement capacity reservation identity is already in use.");
      if (this.#findReservationHistory(next.reservationId)) {
        throw conflictError("Replacement capacity reservation ID was already used.");
      }
      const expiresAt = now + CAPACITY_RESERVATION_TTL_MS;
      const reserved = { ...replacementKey, state: "reserved" as const, createdAt: now, updatedAt: now, expiresAt };
      this.ctx.storage.sql.exec("DELETE FROM capacity_leases WHERE reservation_id = ?", old.reservationId);
      this.#insert(reserved);
      this.#insertReservationHistory(reserved);
      this.#writeGeneration(reserved, false, old);
      return reserved;
    });
    await this.#scheduleAlarm();
    return record;
  }

  /** Releases an exact generation without allowing stale cleanup to delete its replacement. */
  async release(key: CapacityReservationKey): Promise<void> {
    const valid = validateKey(key);
    this.ctx.storage.transactionSync(() => {
      this.#ensureSchema();
      this.#assertScope(valid.tier);
      const byId = this.#findByReservationId(valid.reservationId);
      if (byId) {
        if (!sameKey(byId, valid)) throw conflictError("Capacity release is stale or mismatched.");
        this.#closeGeneration(byId);
        this.ctx.storage.sql.exec("DELETE FROM capacity_leases WHERE reservation_id = ?", valid.reservationId);
        return;
      }
      const generation = this.#findGeneration(valid.sessionId);
      if (!generation) throw conflictError("Capacity release has no reservation generation ledger.");
      if (valid.generation < generation.generation) return;
      if (valid.generation === generation.generation) {
        if (!sameKey(generation, valid)) throw conflictError("Capacity release identity does not match the stored generation.");
        if (generation.closed) return;
        throw conflictError("Capacity release generation has no matching live lease.");
      }
      throw conflictError("Capacity release generation is newer than the stored high-water mark.");
    });
    await this.#scheduleAlarm();
  }

  /** Reclaims expired reservations and arms the next cleanup alarm. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const expiredCount = this.ctx.storage.transactionSync(() => {
      this.#ensureSchema();
      return this.#deleteExpired(now);
    });
    if (expiredCount > 0) logger.info("expired capacity reservations reclaimed", { event: "capacity.reservations.expired", expiredCount });
    await this.#scheduleAlarm();
  }

  #ensureSchema(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS capacity_scope (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), tier TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS capacity_leases (
      reservation_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      sandbox_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'active')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      UNIQUE(session_id)
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS capacity_generations (
      session_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      reservation_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      sandbox_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'active')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      closed INTEGER NOT NULL CHECK (closed IN (0, 1)),
      predecessor_reservation_id TEXT,
      predecessor_generation INTEGER,
      predecessor_sandbox_id TEXT
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS capacity_reservation_history (
      reservation_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      generation INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS capacity_live_session ON capacity_leases(session_id)",
    );
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS capacity_expiry ON capacity_leases(state, expires_at)",
    );
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS capacity_user ON capacity_leases(user_id)");
  }

  #assertScope(tier: HeavySessionTier): void {
    const row = this.ctx.storage.sql.exec<TierRow>("SELECT tier FROM capacity_scope WHERE singleton = 1").toArray()[0];
    if (!row) {
      this.ctx.storage.sql.exec("INSERT INTO capacity_scope(singleton, tier) VALUES (1, ?)", tier);
    } else if (row.tier !== tier) {
      logger.error("capacity shard tier mismatch", { event: "capacity.scope.mismatch", tier, reason: "scope-mismatch" });
      throw new Error("Capacity shard is assigned to a different tier.");
    }
  }

  #deleteExpired(now: number): number {
    const expired = this.ctx.storage.sql.exec<LeaseRow>(
      "SELECT * FROM capacity_leases WHERE state = 'reserved' AND expires_at <= ?", now,
    ).toArray();
    for (const row of expired) this.#closeGeneration(row);
    this.ctx.storage.sql.exec(
      "DELETE FROM capacity_leases WHERE state = 'reserved' AND expires_at <= ?", now,
    );
    return expired.length;
  }

  #count(userId?: string): number {
    const cursor = userId === undefined
      ? this.ctx.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM capacity_leases")
      : this.ctx.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM capacity_leases WHERE user_id = ?", userId);
    return cursor.one().count;
  }

  #findByReservationId(reservationId: string): LeaseRow | undefined {
    return this.ctx.storage.sql.exec<LeaseRow>(
      "SELECT * FROM capacity_leases WHERE reservation_id = ?", reservationId,
    ).toArray()[0];
  }

  #findBySession(sessionId: string): LeaseRow | undefined {
    return this.ctx.storage.sql.exec<LeaseRow>(
      "SELECT * FROM capacity_leases WHERE session_id = ?", sessionId,
    ).toArray()[0];
  }

  #findReservationHistory(reservationId: string): ReservationHistoryRow | undefined {
    return this.ctx.storage.sql.exec<ReservationHistoryRow>(
      "SELECT reservation_id FROM capacity_reservation_history WHERE reservation_id = ?", reservationId,
    ).toArray()[0];
  }

  #insertReservationHistory(record: CapacityReservationKey): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO capacity_reservation_history(reservation_id, session_id, generation) VALUES (?, ?, ?)",
      record.reservationId, record.sessionId, record.generation,
    );
  }

  #findGeneration(sessionId: string): GenerationRow | undefined {
    return this.ctx.storage.sql.exec<GenerationRow>(
      "SELECT * FROM capacity_generations WHERE session_id = ?", sessionId,
    ).toArray()[0];
  }

  #writeGeneration(
    record: CapacityReservationRecord,
    closed: boolean,
    predecessor?: CapacityReservationKey,
  ): void {
    this.ctx.storage.sql.exec(`INSERT INTO capacity_generations (
      session_id, tier, reservation_id, generation, sandbox_id, user_id,
      state, created_at, updated_at, expires_at, closed,
      predecessor_reservation_id, predecessor_generation, predecessor_sandbox_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      tier = excluded.tier, reservation_id = excluded.reservation_id,
      generation = excluded.generation, sandbox_id = excluded.sandbox_id,
      user_id = excluded.user_id, state = excluded.state, created_at = excluded.created_at,
      updated_at = excluded.updated_at, expires_at = excluded.expires_at, closed = excluded.closed,
      predecessor_reservation_id = excluded.predecessor_reservation_id,
      predecessor_generation = excluded.predecessor_generation,
      predecessor_sandbox_id = excluded.predecessor_sandbox_id`,
    record.sessionId, record.tier, record.reservationId, record.generation, record.sandboxId,
    record.userId, record.state, record.createdAt, record.updatedAt, record.expiresAt ?? null,
    closed ? 1 : 0, predecessor?.reservationId ?? null, predecessor?.generation ?? null,
    predecessor?.sandboxId ?? null);
  }

  #closeGeneration(row: LeaseRow): void {
    this.ctx.storage.sql.exec(`UPDATE capacity_generations SET closed = 1
      WHERE session_id = ? AND tier = ? AND reservation_id = ? AND generation = ?
        AND sandbox_id = ? AND user_id = ?`,
    row.session_id, row.tier, row.reservation_id, row.generation, row.sandbox_id, row.user_id);
  }

  #findEither(reservationId: string, sessionId: string, generation: number): LeaseRow | undefined {
    return this.ctx.storage.sql.exec<LeaseRow>(
      "SELECT * FROM capacity_leases WHERE reservation_id = ? OR (session_id = ? AND generation = ?)",
      reservationId, sessionId, generation,
    ).toArray()[0];
  }

  #insert(record: CapacityReservationRecord): void {
    this.ctx.storage.sql.exec(`INSERT INTO capacity_leases (
      reservation_id, tier, session_id, generation, sandbox_id, user_id,
      state, created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    record.reservationId, record.tier, record.sessionId, record.generation, record.sandboxId,
    record.userId, record.state, record.createdAt, record.updatedAt, record.expiresAt ?? null);
  }

  async #scheduleAlarm(): Promise<void> {
    const next = this.ctx.storage.sql.exec<ExpiryRow>(
      "SELECT MIN(expires_at) AS expires_at FROM capacity_leases WHERE state = 'reserved'",
    ).toArray()[0];
    if (next && next.expires_at !== null) await this.ctx.storage.setAlarm(next.expires_at);
    else await this.ctx.storage.deleteAlarm();
  }
}

function validateTier(value: unknown): asserts value is HeavySessionTier {
  if (typeof value !== "string" || !(HEAVY_SESSION_TIERS as readonly string[]).includes(value)) {
    throw new TypeError("tier must be a supported heavy session tier.");
  }
}

function validateIdentifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`${name} must be a canonical identifier of at most 128 characters.`);
  }
}

function validateGeneration(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function validateKey(value: unknown): CapacityReservationKey {
  if (!value || typeof value !== "object") throw new TypeError("capacity reservation key must be an object.");
  const key = value as Partial<CapacityReservationKey>;
  validateTier(key.tier);
  validateIdentifier(key.reservationId, "reservationId");
  validateIdentifier(key.sessionId, "sessionId");
  validateGeneration(key.generation, "generation");
  validateIdentifier(key.sandboxId, "sandboxId");
  validateIdentifier(key.userId, "userId");
  return key as CapacityReservationKey;
}

function validateReplacement(value: unknown): CapacityReservationReplacement {
  if (!value || typeof value !== "object") throw new TypeError("replacement must be an object.");
  const replacement = value as Partial<CapacityReservationReplacement>;
  validateIdentifier(replacement.reservationId, "replacement.reservationId");
  validateGeneration(replacement.generation, "replacement.generation");
  validateIdentifier(replacement.sandboxId, "replacement.sandboxId");
  return replacement as CapacityReservationReplacement;
}

function sameKey(row: LeaseRow, key: CapacityReservationKey): boolean {
  return row.tier === key.tier && row.reservation_id === key.reservationId &&
    row.session_id === key.sessionId && row.generation === key.generation &&
    row.sandbox_id === key.sandboxId && row.user_id === key.userId;
}

function predecessorMatches(row: GenerationRow, key: CapacityReservationKey): boolean {
  return row.predecessor_reservation_id === key.reservationId &&
    row.predecessor_generation === key.generation && row.predecessor_sandbox_id === key.sandboxId;
}

function fromRow(row: LeaseRow): CapacityReservationRecord {
  if (row.state !== "reserved" && row.state !== "active") throw new Error("Stored capacity lease has an invalid state.");
  return {
    tier: row.tier as HeavySessionTier,
    reservationId: row.reservation_id,
    sessionId: row.session_id,
    generation: row.generation,
    sandboxId: row.sandbox_id,
    userId: row.user_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  };
}

function conflictError(message: string): Error {
  logger.warn("capacity generation fence rejected an operation", { event: "capacity.generation-fence.rejected", reason: "generation-fence" });
  return new Error(message);
}
