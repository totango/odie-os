import { configuredAdministratorProfiles, type AdminAuthorityState, type AdminClaim } from "./admin-authority";
import type { UserDurableObject } from "./user";

/** Internal preparatory state, NOT a deployed maintenance API. */
export type MaintenanceMode = "normal" | "draining" | "frozen";
/** Work whose lifetime must be acknowledged before a freeze can complete. */
export type MaintenanceWork = "mutation" | "agent" | "gadget" | "external-effect" | "oauth";
/** Authoritative ledger snapshot; zero counts alone do not prove deployment-wide coverage. */
export type MaintenanceSnapshot = {
  mode: MaintenanceMode;
  revision: number;
  pending: Record<MaintenanceWork, number>;
};

const kinds: readonly MaintenanceWork[] = ["mutation", "agent", "gadget", "external-effect", "oauth"];
const modes: readonly MaintenanceMode[] = ["normal", "draining", "frozen"];
type Meta = { mode: MaintenanceMode; revision: number };

/**
 * SQLite admission ledger for eventual co-location with AdminAuthority. Not wired into production:
 * do NOT expose a pause API until every execution owner participates, including already-issued
 * derived gadget stubs, constructor/alarm restoration, hook effects and legacy OAuth callbacks.
 *
 * Each *operation*, not each WebSocket/capability, acquires a durable admission before doing work.
 * Keep that admission until all asynchronous descendants and remote effects have acknowledged
 * completion. An unknown outcome remains pending, including across object reconstruction. There
 * is deliberately no expiry, force-clear, disposal cleanup, or blanket finally-release helper:
 * losing a caller or timing out an RPC does not establish that its remote effect stopped.
 *
 * Draining rejects new admissions and lets already-admitted work finish. Frozen requires zero
 * admissions in the same transaction as the transition. Thus a check/use await cannot race a
 * successful freeze while its admission is outstanding. Runtime owners must additionally stop
 * background gadget execution before releasing gadget admissions. Reads/raw archive export need
 * no admission; code-executing export does. Tokens are backend-private, never frontend authority.
 */
export class MaintenanceAdmissionState {
  constructor(
    private storage: DurableObjectStorage,
    private authority: Pick<AdminAuthorityState, "assertCurrent">,
    private users: DurableObjectNamespace<UserDurableObject>,
    private env: Pick<Cloudflare.Env, "ADMINS">,
  ) {
    storage.transactionSync(() => {
      const existing = storage.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('maintenance_meta', 'maintenance_admissions')",
      ).one().n;
      if (existing !== 0 && existing !== 2) throw new Error("MAINTENANCE_UNAVAILABLE");
      storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS maintenance_meta (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          mode TEXT NOT NULL CHECK(mode IN ('normal','draining','frozen')),
          revision INTEGER NOT NULL CHECK(revision>=0)
        );
        CREATE TABLE IF NOT EXISTS maintenance_admissions (
          token TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('mutation','agent','gadget','external-effect','oauth'))
        );
      `);
      if (existing === 0) storage.sql.exec("INSERT INTO maintenance_meta VALUES (1, 'normal', 0)");
      this.#meta(); // Never silently reset missing/corrupt metadata to normal.
    });
  }

  #meta(): Meta {
    const row = this.storage.sql.exec<Meta>("SELECT mode,revision FROM maintenance_meta WHERE singleton=1").toArray()[0];
    if (!row || !modes.includes(row.mode) || !Number.isSafeInteger(row.revision) || row.revision < 0) {
      throw new Error("MAINTENANCE_UNAVAILABLE");
    }
    return row;
  }

  /** Read the durable state directly; this state must never be mirrored to KV for enforcement. */
  snapshot(): MaintenanceSnapshot {
    const meta = this.#meta();
    const pending: MaintenanceSnapshot["pending"] = { mutation: 0, agent: 0, gadget: 0, "external-effect": 0, oauth: 0 };
    for (const row of this.storage.sql.exec<{ kind: MaintenanceWork; n: number }>(
      "SELECT kind,COUNT(*) AS n FROM maintenance_admissions GROUP BY kind",
    )) {
      if (!kinds.includes(row.kind) || !Number.isSafeInteger(row.n) || row.n < 0) throw new Error("MAINTENANCE_UNAVAILABLE");
      pending[row.kind] = row.n;
    }
    if (meta.mode === "frozen" && Object.values(pending).some(n => n !== 0)) throw new Error("MAINTENANCE_UNAVAILABLE");
    return { ...meta, pending };
  }

  /**
   * Operator-only CAS transition. Current administration authority AND exact deployment-configured
   * membership are required: granting a managed administrator alone cannot mint an operator.
   * The authority engine must share this storage owner, so revocation cannot interleave at await.
   * This only freezes registered work, not an uninstrumented deployment.
   */
  transition(claim: AdminClaim, expectedRevision: number, mode: MaintenanceMode): MaintenanceSnapshot {
    return this.storage.transactionSync(() => {
      this.authority.assertCurrent(claim, "administration");
      if (!configuredAdministratorProfiles(this.env).includes(claim.profileId) ||
          this.users.idFromName(claim.profileId).toString() !== claim.principalId) {
        throw new Error("MAINTENANCE_OPERATOR_REQUIRED");
      }
      if (!modes.includes(mode) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error("INVALID_MAINTENANCE_INPUT");
      }
      const current = this.snapshot();
      if (current.revision !== expectedRevision) throw new Error("MAINTENANCE_REVISION_CONFLICT");
      if (current.mode === mode) return current;
      if (mode === "frozen") {
        if (current.mode !== "draining") throw new Error("MAINTENANCE_DRAIN_REQUIRED");
        if (Object.values(current.pending).some(n => n !== 0)) throw new Error("MAINTENANCE_NOT_DRAINED");
      }
      if (current.mode === "frozen" && mode !== "normal") throw new Error("INVALID_MAINTENANCE_TRANSITION");
      if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error("MAINTENANCE_UNAVAILABLE");
      this.storage.sql.exec("UPDATE maintenance_meta SET mode=?,revision=? WHERE singleton=1", mode, current.revision + 1);
      return this.snapshot();
    });
  }

  /** Backend-only admission for one bounded operation; never accept a caller-selected token. */
  admit(kind: MaintenanceWork): string {
    return this.storage.transactionSync(() => {
      if (!kinds.includes(kind)) throw new Error("INVALID_MAINTENANCE_INPUT");
      if (this.#meta().mode !== "normal") throw new Error("MAINTENANCE_PAUSED");
      const token = crypto.randomUUID();
      this.storage.sql.exec("INSERT INTO maintenance_admissions VALUES (?,?)", token, kind);
      return token;
    });
  }

  /** Validate a backend-retained continuation, including a previously admitted OAuth callback. */
  assertAdmitted(token: string, kind: MaintenanceWork): void {
    if (this.#meta().mode === "frozen") throw new Error("MAINTENANCE_PAUSED");
    const row = this.storage.sql.exec<{ kind: MaintenanceWork }>(
      "SELECT kind FROM maintenance_admissions WHERE token=?", token,
    ).toArray()[0];
    if (!row || row.kind !== kind) throw new Error("MAINTENANCE_ADMISSION_REQUIRED");
  }

  /**
   * Backend owner acknowledgement after work is conclusively finished; retries are idempotent.
   * A network error or dropped stub is NOT sufficient evidence to call this method.
   */
  acknowledge(token: string): void {
    this.#meta();
    this.storage.sql.exec("DELETE FROM maintenance_admissions WHERE token=?", token);
  }
}
