import type { WorkerEntrypoint } from "cloudflare:workers";

/** Private value-only notification intent. Backend constructs it only from independently verified PR evidence. */
export interface RequestBuildNotification {
  /** Canonical trusted deployment HTTPS origin, not a caller-selected destination. */
  origin: string;
  /** Public board UUID. */
  requestId: string;
  /** Public run UUID, never an execution identity. */
  runId: string;
  /** Frozen build attempt ordinal. */
  attempt: number;
  /** Independently verified canonical repository PR number. */
  prNumber: number;
  /** Stable deployment/run/attempt/PR binding; does not imply Slack deduplication. */
  notificationKey: string;
}

/** Safe notification lifecycle; acknowledgement is distinct from enqueue or an uncertain send. */
export type RequestBuildNotificationState = "queued" | "sending" | "retry_wait" | "acknowledged" | "ambiguous" | "blocked" | "suppressed";

/** Private provider result. Only documented definitive non-delivery allows automatic retry. */
export type RequestBuildNotificationResult =
  | { status: "acknowledged"; notificationKey: string; receipt: string }
  | { status: "retry"; notificationKey: string; retryAfterSeconds: number }
  | { status: "blocked" | "ambiguous"; notificationKey: string };

/** Private fresh destination evidence, not proof of posting permission or delivery. No Slack identities leave JARVIS. */
export type RequestBuildNotifierReadiness =
  | { protocol: "request-build-slack-v1"; configured: boolean; destinationVerified: false; posting: "unproven" }
  | { protocol: "request-build-slack-v1"; configured: true; destinationVerified: true; posting: "unproven";
      origin: string; generation: string; checkedAt: number; expiresAt: number };

/** Checks private receiver evidence against current deployment configuration at consumption; old protocols fail closed. */
export function requestBuildNotifierDestinationReady(evidence: RequestBuildNotifierReadiness | undefined, origin: string | undefined,
  generation: string | undefined, now = Date.now()): boolean {
  try {
    const url = new URL(origin ?? "");
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) return false;
  } catch { return false; }
  return !!evidence && evidence.protocol === "request-build-slack-v1" && evidence.configured === true &&
    evidence.destinationVerified === true && evidence.posting === "unproven" &&
    typeof origin === "string" && evidence.origin === origin &&
    typeof generation === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(generation) && evidence.generation === generation &&
    Number.isSafeInteger(now) && Number.isSafeInteger(evidence.checkedAt) && Number.isSafeInteger(evidence.expiresAt) &&
    evidence.checkedAt > 0 && evidence.checkedAt <= now && evidence.expiresAt > now &&
    evidence.expiresAt > evidence.checkedAt && evidence.expiresAt - evidence.checkedAt <= 30_000;
}

/** Binding-only JARVIS receiver. Never exposed through user, gadget, MCP or HTTP routes. */
export interface RequestBuildNotifier extends WorkerEntrypoint<unknown> {
  /** Fresh Slack-owned identity/access checks; never posts a canary or attests actual posting permission. */
  requestBuildNotifierReadiness(): Promise<RequestBuildNotifierReadiness>;
  /** Rechecks the expected configuration generation and destination before sending fixed safe links. */
  notifyRequestBuild(request: RequestBuildNotification, generation: string): Promise<RequestBuildNotificationResult>;
}

/** Canonical private key, containing no user prose or account/session identity. */
export function requestBuildNotificationKey(request: Omit<RequestBuildNotification, "notificationKey">): string {
  return `request-build:${request.origin}:${request.runId}:${request.attempt}:pr:${request.prNumber}`;
}

/** Strict value validation shared by the backend enqueue and the private receiver. */
export function validateRequestBuildNotification(request: RequestBuildNotification, origin: string): void {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password ||
      !request || typeof request !== "object" || Array.isArray(request) ||
      // ES2022 shared consumers: only the newly allocated keys array is mutated.
      // oxlint-disable-next-line unicorn/no-array-sort
      Object.keys(request).sort().join(",") !== "attempt,notificationKey,origin,prNumber,requestId,runId" ||
      request.origin !== origin || typeof request.requestId !== "string" || typeof request.runId !== "string" ||
      !uuid.test(request.requestId) || !uuid.test(request.runId) ||
      !Number.isSafeInteger(request.attempt) || request.attempt < 1 ||
      !Number.isSafeInteger(request.prNumber) || request.prNumber < 1 ||
      request.notificationKey !== requestBuildNotificationKey(request)) throw new Error("BUILD_NOTIFICATION_INVALID");
}
