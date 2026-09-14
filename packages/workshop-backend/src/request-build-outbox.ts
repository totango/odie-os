import { requestBuildNotifierDestinationReady, requestBuildNotificationKey, validateRequestBuildNotification, type RequestBuildNotification, type RequestBuildNotificationState, type RequestBuildNotifier } from "@gadgets/workshop-shared/coding-sessions";

type Row = { key: string; runId: string; payload: string; state: RequestBuildNotificationState; attempts: number; retryAt: number };
/** Separate durable delivery ledger. No delivery failure changes PR success or occupies execution capacity. */
export class RequestBuildOutbox {
  constructor(private storage: DurableObjectStorage, private notifier: Pick<RequestBuildNotifier, "requestBuildNotifierReadiness" | "notifyRequestBuild"> | undefined,
    private permitted: (runId: string) => Promise<boolean>, private generation: string | undefined) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS build_notifications (key TEXT PRIMARY KEY, runId TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, retryAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS build_notification_due ON build_notifications(state,retryAt,key);
      CREATE TABLE IF NOT EXISTS build_notification_attempts (key TEXT NOT NULL, attempt INTEGER NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, outcome TEXT NOT NULL, receipt TEXT, PRIMARY KEY(key,attempt));
    `);
  }
  /** Called in the same transaction as independently verified PR persistence. Never accepts user/model prose. */
  enqueue(input: Omit<RequestBuildNotification, "notificationKey">): void {
    const notification = { ...input, notificationKey: requestBuildNotificationKey(input) };
    validateRequestBuildNotification(notification, input.origin);
    const payload = JSON.stringify(notification);
    const prior = this.storage.sql.exec<Row>("SELECT * FROM build_notifications WHERE runId=?", input.runId).toArray()[0];
    if (prior) {
      if (prior.key !== notification.notificationKey || prior.payload !== payload) throw new Error("BUILD_NOTIFICATION_CONFLICT");
      return;
    }
    this.storage.sql.exec("INSERT INTO build_notifications VALUES (?,?,?,'queued',0,0)", notification.notificationKey, input.runId, payload);
  }
  /** Safe status only: no token, destination, remote receipt or notification key crosses the board boundary. */
  status(runId: string): RequestBuildNotificationState | undefined {
    return this.storage.sql.exec<Row>("SELECT state FROM build_notifications WHERE runId=?", runId).toArray()[0]?.state;
  }
  async #arm(at: number): Promise<void> {
    const alarm = await this.storage.getAlarm();
    if (alarm === null || alarm > at) await this.storage.setAlarm(at);
  }
  /** A durable sending intent after restart means possible delivery, never permission to blindly resend. */
  async recover(): Promise<void> {
    this.storage.transactionSync(() => {
      this.storage.sql.exec("UPDATE build_notification_attempts SET outcome='ambiguous',finishedAt=? WHERE outcome='sending'", Date.now());
      this.storage.sql.exec("UPDATE build_notifications SET state='ambiguous' WHERE state='sending'");
    });
    await this.#schedule();
  }
  async #schedule(): Promise<void> {
    const next = this.storage.sql.exec<{ at: number | null }>("SELECT MIN(retryAt) AS at FROM build_notifications WHERE state IN ('queued','retry_wait')").one().at;
    if (next !== null) await this.#arm(Math.max(Date.now() + 1000, next));
  }
  /** One bounded send per alarm; persisted attempt precedes the private cross-service call. */
  async alarm(): Promise<void> {
    try {
      const row = this.storage.sql.exec<Row>("SELECT * FROM build_notifications WHERE state IN ('queued','retry_wait') AND retryAt<=? ORDER BY retryAt,key LIMIT 1", Date.now()).toArray()[0];
      if (!row) return;
      // Recheck visibility and current initiator authority after asynchronous readiness checks.
      const notification: RequestBuildNotification = JSON.parse(row.payload);
      let ready;
      try {
        ready = await this.notifier?.requestBuildNotifierReadiness();
      } catch { /* No send occurred; blocked, not ambiguous. */ }
      let permitted = false;
      try { permitted = await this.permitted(row.runId); } catch { /* Fail closed on authority outage. */ }
      const verified = requestBuildNotifierDestinationReady(ready, notification.origin, this.generation);
      const state = !permitted ? "suppressed" : !verified ? "blocked" : "sending";
      const attempt = row.attempts + 1;
      const claimed = this.storage.transactionSync(() => {
        const current = this.storage.sql.exec<Row>("SELECT * FROM build_notifications WHERE key=?", row.key).one();
        if (current.state !== row.state || current.attempts !== row.attempts) return false;
        this.storage.sql.exec("UPDATE build_notifications SET state=?,attempts=? WHERE key=?", state, state === "sending" ? attempt : row.attempts, row.key);
        if (state === "sending") this.storage.sql.exec("INSERT INTO build_notification_attempts VALUES (?,?,?,NULL,'sending',NULL)", row.key, attempt, Date.now());
        return true;
      });
      if (!claimed || state !== "sending") return;
      // A watchdog permits alarm-based crash reconciliation even if the binding acknowledgement is lost.
      await this.#arm(Date.now() + 30_000);
      let outcome: RequestBuildNotificationState = "ambiguous", receipt: string | null = null, retryAt = 0;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // The receiver has its own HTTP deadline. Losing the private RPC response cannot stall this
        // ledger forever; timeout means possible delivery, never permission to issue another send.
        const result = await Promise.race([
          this.notifier!.notifyRequestBuild(notification, this.generation!),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("BUILD_NOTIFICATION_ACK_TIMEOUT")), 15_000);
          }),
        ]);
        if (result.notificationKey === row.key) {
          if (result.status === "acknowledged" && /^[0-9]{10,16}\.[0-9]{6}$/.test(result.receipt)) {
            outcome = "acknowledged"; receipt = result.receipt;
          } else if (result.status === "retry" && Number.isSafeInteger(result.retryAfterSeconds) && result.retryAfterSeconds >= 1 && result.retryAfterSeconds <= 3600) {
            outcome = attempt >= 6 ? "blocked" : "retry_wait";
            retryAt = Date.now() + Math.max(result.retryAfterSeconds * 1000, 1000 * 2 ** attempt);
          } else if (result.status === "blocked") outcome = "blocked";
        }
      } catch { /* Lost acknowledgement: preserve ambiguity, with no automatic retry. */ }
      finally { if (timeout !== undefined) clearTimeout(timeout); }
      this.storage.transactionSync(() => {
        this.storage.sql.exec("UPDATE build_notification_attempts SET outcome=?,finishedAt=?,receipt=? WHERE key=? AND attempt=?", outcome, Date.now(), receipt, row.key, attempt);
        this.storage.sql.exec("UPDATE build_notifications SET state=?,retryAt=? WHERE key=?", outcome, retryAt, row.key);
      });
    } finally { await this.#schedule(); }
  }
}
