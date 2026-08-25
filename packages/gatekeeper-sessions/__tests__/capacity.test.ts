import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPACITY_LIMITS,
  CAPACITY_RESERVATION_TTL_MS,
  CodingSessionCapacity,
  HEAVY_SESSION_TIERS,
  type CapacityReservationKey,
  type HeavySessionTier,
} from "../src/capacity.js";

class SqlCursor<T extends Record<string, string | number | null>> {
  constructor(private readonly rows: T[], readonly rowsWritten: number) {}
  toArray(): T[] { return this.rows; }
  one(): T {
    const row = this.rows[0];
    if (!row) throw new Error("expected one row");
    return row;
  }
}

class TestSql {
  readonly database = new DatabaseSync(":memory:");

  exec<T extends Record<string, string | number | null>>(query: string, ...bindings: unknown[]): SqlCursor<T> {
    const normalized = query.trim().toUpperCase();
    if (normalized.startsWith("CREATE ")) {
      this.database.exec(query);
      return new SqlCursor<T>([], 0);
    }
    const statement = this.database.prepare(query);
    if (normalized.startsWith("SELECT ") || normalized.includes(" RETURNING ")) {
      return new SqlCursor(statement.all(...bindings) as T[], 0);
    }
    const result = statement.run(...bindings);
    return new SqlCursor<T>([], Number(result.changes));
  }
}

type TestContext = {
  storage: {
    sql: TestSql;
    transactionSync<T>(closure: () => T): T;
    setAlarm(time: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  alarm: number | null;
};

function capacity(): { service: CodingSessionCapacity; ctx: TestContext } {
  const ctx: TestContext = {
    alarm: null,
    storage: {
      sql: new TestSql(),
      transactionSync: closure => {
        ctx.storage.sql.database.exec("BEGIN");
        try {
          const result = closure();
          ctx.storage.sql.database.exec("COMMIT");
          return result;
        } catch (error) {
          ctx.storage.sql.database.exec("ROLLBACK");
          throw error;
        }
      },
      setAlarm: async time => { ctx.alarm = time; },
      deleteAlarm: async () => { ctx.alarm = null; },
    },
  };
  const service = new CodingSessionCapacity(
    ctx as unknown as DurableObjectState<{}>,
    {},
  );
  return { service, ctx };
}

function key(
  reservationId: string,
  userId = "user-1",
  generation = 1,
  tier: HeavySessionTier = "standard-2",
): CapacityReservationKey {
  return {
    tier,
    reservationId,
    sessionId: `session-${reservationId}`,
    generation,
    sandboxId: `sandbox-${reservationId}-${generation}`,
    userId,
  };
}

afterEach(() => vi.useRealTimers());

describe("CodingSessionCapacity", () => {
  it("exports the server-owned pools and limits", () => {
    expect(HEAVY_SESSION_TIERS).toEqual(["standard-2", "standard-3", "standard-4"]);
    expect(CAPACITY_LIMITS).toEqual({
      "standard-2": { global: 8, perUser: 2 },
      "standard-3": { global: 4, perUser: 1 },
      "standard-4": { global: 2, perUser: 1 },
    });
  });

  it("reserves idempotently, activates idempotently, and releases idempotently", async () => {
    vi.useFakeTimers().setSystemTime(1_000_000);
    const { service, ctx } = capacity();
    const lease = key("r1");
    const reserved = await service.reserve(lease);
    expect(reserved).toEqual({
      ...lease,
      state: "reserved",
      createdAt: 1_000_000,
      updatedAt: 1_000_000,
      expiresAt: 1_000_000 + CAPACITY_RESERVATION_TTL_MS,
    });
    expect(await service.reserve(lease)).toEqual(reserved);
    expect(ctx.alarm).toBe(reserved.expiresAt);

    vi.setSystemTime(1_000_100);
    const active = await service.activate(lease);
    expect(active).toEqual({ ...lease, state: "active", createdAt: 1_000_000, updatedAt: 1_000_100 });
    expect(ctx.storage.sql.exec<{ state: string; updated_at: number; expires_at: number | null }>(
      "SELECT state, updated_at, expires_at FROM capacity_generations WHERE session_id = ?", lease.sessionId,
    ).one()).toEqual({ state: "active", updated_at: 1_000_100, expires_at: null });
    expect(await service.activate(lease)).toEqual(active);
    expect(ctx.alarm).toBeNull();
    await service.release(lease);
    await service.release(lease);
    expect(await service.snapshot("standard-2", "user-1")).toEqual({ available: true, active: 0, limit: 2 });
  });

  it("enforces both global and per-user limits while counting reserved and active", async () => {
    const { service } = capacity();
    await service.reserve(key("mine-1"));
    await service.activate(key("mine-1"));
    await service.reserve(key("mine-2"));
    expect(await service.snapshot("standard-2", "user-1")).toEqual({ available: false, active: 2, limit: 2 });
    await expect(service.reserve(key("mine-3"))).rejects.toThrow("unavailable");

    for (let index = 3; index <= 8; index++) await service.reserve(key(`r${index}`, `user-${index}`));
    expect(await service.snapshot("standard-2", "new-user")).toEqual({ available: false, active: 8, limit: 8 });
    await expect(service.reserve(key("overflow", "new-user"))).rejects.toThrow("unavailable");
  });

  it("fences reservation identity, session generation, activation, and release mismatches", async () => {
    const { service } = capacity();
    const lease = key("r1");
    await service.reserve(lease);
    await expect(service.reserve({ ...lease, sandboxId: "other" })).rejects.toThrow("already in use");
    await expect(service.reserve({ ...lease, reservationId: "r2" })).rejects.toThrow("already in use");
    await expect(service.activate({ ...lease, generation: 2 })).rejects.toThrow("stale or mismatched");
    await expect(service.release({ ...lease, sandboxId: "other" })).rejects.toThrow("stale or mismatched");
    expect((await service.snapshot("standard-2", "user-1")).active).toBe(1);
  });

  it("transfers only an exact active lease to a newer reserved generation", async () => {
    vi.useFakeTimers().setSystemTime(5_000);
    const { service } = capacity();
    const old = key("old");
    await service.reserve(old);
    await expect(service.transfer(old, { reservationId: "next", generation: 3, sandboxId: "sandbox-next" }))
      .rejects.toThrow("exact active");
    await service.activate(old);

    vi.setSystemTime(6_000);
    const replacement = await service.transfer(old, {
      reservationId: "next", generation: 3, sandboxId: "sandbox-next",
    });
    expect(replacement).toEqual({
      ...old,
      reservationId: "next",
      generation: 3,
      sandboxId: "sandbox-next",
      state: "reserved",
      createdAt: 6_000,
      updatedAt: 6_000,
      expiresAt: 6_000 + CAPACITY_RESERVATION_TTL_MS,
    });
    expect(await service.transfer(old, {
      reservationId: "next", generation: 3, sandboxId: "sandbox-next",
    })).toEqual(replacement);
    for (const mismatchedOld of [
      { ...old, reservationId: "altered-old" },
      { ...old, generation: 2 },
      { ...old, sandboxId: "altered-sandbox" },
    ]) {
      await expect(service.transfer(mismatchedOld, {
        reservationId: "next", generation: 3, sandboxId: "sandbox-next",
      })).rejects.toThrow();
    }
    const activatedReplacement = await service.activate({
      ...old, reservationId: "next", generation: 3, sandboxId: "sandbox-next",
    });
    expect(await service.transfer(old, {
      reservationId: "next", generation: 3, sandboxId: "sandbox-next",
    })).toEqual(activatedReplacement);
    await service.release(old); // stale release must not delete the replacement
    expect((await service.snapshot("standard-2", old.userId)).active).toBe(1);
    await expect(service.transfer(old, {
      reservationId: "different", generation: 4, sandboxId: "sandbox-4",
    })).rejects.toThrow("stale or mismatched");
  });

  it("expires only reserved leases and alarm schedules the next reservation", async () => {
    vi.useFakeTimers().setSystemTime(10_000);
    const { service, ctx } = capacity();
    const active = key("active");
    await service.reserve(active);
    await service.activate(active);
    const expiring = key("expiring", "user-2");
    await service.reserve(expiring);
    expect(ctx.alarm).toBe(10_000 + CAPACITY_RESERVATION_TTL_MS);

    vi.setSystemTime(10_000 + CAPACITY_RESERVATION_TTL_MS);
    await service.alarm();
    expect(ctx.alarm).toBeNull();
    expect(await service.snapshot("standard-2", "user-2")).toEqual({ available: true, active: 0, limit: 2 });
    await expect(service.activate(expiring)).rejects.toThrow("stale or mismatched");
    expect((await service.activate(active)).state).toBe("active");
  });

  it("does not resurrect a reservation after TTL expiry", async () => {
    vi.useFakeTimers().setSystemTime(20_000);
    const { service } = capacity();
    const expired = key("expired");
    await service.reserve(expired);
    vi.setSystemTime(20_000 + CAPACITY_RESERVATION_TTL_MS);
    await service.alarm();
    await expect(service.reserve(expired)).rejects.toThrow("cannot be reopened");
    expect((await service.snapshot("standard-2", expired.userId)).active).toBe(0);
  });

  it("does not resurrect a reservation after release", async () => {
    const { service } = capacity();
    const released = key("released");
    await service.reserve(released);
    await service.release(released);
    await expect(service.reserve(released)).rejects.toThrow("cannot be reopened");
  });

  it("keeps a session generation high-water mark and permits only one live generation", async () => {
    const { service } = capacity();
    const first = key("first");
    await service.reserve(first);
    const concurrent = {
      ...first, reservationId: "second", generation: 2, sandboxId: "sandbox-second",
    };
    await expect(service.reserve(concurrent)).rejects.toThrow("already has a live");
    await service.activate(first);
    const replacement = {
      ...first, reservationId: "replacement", generation: 3, sandboxId: "sandbox-replacement",
    };
    await service.transfer(first, {
      reservationId: replacement.reservationId,
      generation: replacement.generation,
      sandboxId: replacement.sandboxId,
    });
    await service.release(replacement);
    await expect(service.reserve(first)).rejects.toThrow("stale");
    await expect(service.reserve({
      ...first, reservationId: "old-two", generation: 2, sandboxId: "sandbox-old-two",
    })).rejects.toThrow("stale");
    const newer = {
      ...first, reservationId: "newer", generation: 4, sandboxId: "sandbox-newer",
    };
    expect((await service.reserve(newer)).generation).toBe(4);
  });

  it("never reuses a reservation ID from an older historical generation", async () => {
    const { service } = capacity();
    const first = key("historical-r1");
    await service.reserve(first);
    await service.activate(first);
    const second = {
      ...first, reservationId: "historical-r2", generation: 2, sandboxId: "sandbox-historical-r2",
    };
    await service.transfer(first, {
      reservationId: second.reservationId, generation: second.generation, sandboxId: second.sandboxId,
    });
    await service.release(second);
    await expect(service.reserve({
      ...first, generation: 3, sandboxId: "sandbox-historical-r1-again",
    })).rejects.toThrow("cannot be reused");
  });

  it("rejects release for an unknown session with no generation ledger", async () => {
    const { service } = capacity();
    await expect(service.release(key("unknown-release"))).rejects.toThrow("no reservation generation ledger");
    expect(await service.snapshot("standard-2", "user-1")).toEqual({ available: true, active: 0, limit: 2 });
  });

  it("rejects release requests newer than the session high-water mark", async () => {
    const { service } = capacity();
    const current = key("release-high-water");
    await service.reserve(current);
    await expect(service.release({
      ...current, reservationId: "future-release", generation: 2, sandboxId: "sandbox-future-release",
    })).rejects.toThrow("newer than");
    expect((await service.activate(current)).state).toBe("active");
  });

  it("rolls back lease replacement when the generation ledger update fails", async () => {
    const { service, ctx } = capacity();
    const old = key("rollback-old");
    await service.reserve(old);
    const active = await service.activate(old);
    ctx.storage.sql.database.exec(`CREATE TRIGGER reject_generation_update
      BEFORE UPDATE ON capacity_generations
      WHEN NEW.generation = 2
      BEGIN SELECT RAISE(ABORT, 'forced ledger failure'); END`);
    await expect(service.transfer(old, {
      reservationId: "rollback-next", generation: 2, sandboxId: "sandbox-rollback-next",
    })).rejects.toThrow("forced ledger failure");
    expect(await service.activate(old)).toEqual(active);
    expect((await service.snapshot("standard-2", old.userId)).active).toBe(1);
    await expect(service.activate({
      ...old, reservationId: "rollback-next", generation: 2, sandboxId: "sandbox-rollback-next",
    })).rejects.toThrow("stale or mismatched");
  });

  it("pins a shard to its first tier", async () => {
    const { service } = capacity();
    await service.snapshot("standard-2", "user-1");
    await expect(service.snapshot("standard-3", "user-1")).rejects.toThrow("different tier");
  });

  it.each([
    ["unsupported tier", () => capacity().service.snapshot("standard-1" as HeavySessionTier, "user")],
    ["empty user", () => capacity().service.snapshot("standard-2", "")],
    ["unsafe id", () => capacity().service.reserve({ ...key("valid"), reservationId: "bad id" })],
    ["long id", () => capacity().service.reserve({ ...key("valid"), sandboxId: "x".repeat(129) })],
    ["zero generation", () => capacity().service.reserve({ ...key("valid"), generation: 0 })],
    ["fractional generation", () => capacity().service.reserve({ ...key("valid"), generation: 1.5 })],
  ])("validates %s before persistence", async (_name, operation) => {
    await expect(operation()).rejects.toThrow(TypeError);
  });
});
