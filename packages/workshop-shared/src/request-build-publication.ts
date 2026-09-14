import type {
  RequestBuildAuthorizationRequest,
  RequestBuildExecutionReceipt,
} from "./request-build.js";

/** Value-only public lifecycle, never a Code Session control capability. */
export type PublicRequestBuildState =
  | "queued"
  | "dispatching"
  | "starting"
  | "running"
  | "validating"
  | "publishing"
  | "pr_created"
  | "cancel_requested"
  | "canceled"
  | "failed"
  | "needs_attention";

/** Explicit approval of the current authored specification; all execution authority is server-derived. */
export interface StartRequestBuild {
  /** Visible request identifier. */
  requestId: string;
  /** Exact monotonically increasing authored/moderation revision being approved. */
  expectedRequestRevision: number;
  /** Account-scoped durable retry key; changed payloads conflict. */
  mutationKey: string;
}

/** Current administrators may cancel another administrator's run; cleanup is service-owned. */
export interface CancelRequestBuild {
  /** Request containing the run. */
  requestId: string;
  /** Opaque logical run identifier, not a bearer token. */
  runId: string;
  /** Account-scoped durable retry key. */
  mutationKey: string;
}

/** Authenticated, visibility-checked allowlist; excludes actors, raw errors and execution identities. */
export interface PublicRequestBuild {
  /** Logical run identifier. */
  runId: string;
  /** Authored request identifier. */
  requestId: string;
  /** Immutable approved revision. */
  requestRevision: number;
  /** Server-owned lifecycle. */
  state: PublicRequestBuildState;
  /** Explicit approval attempt ordinal. */
  attempt: number;
  /** Creation timestamp in Unix milliseconds. */
  createdAt: number;
  /** Last transition timestamp in Unix milliseconds. */
  updatedAt: number;
  /** Closed diagnostic code, never a provider error message. */
  errorCode?: string;
  /** Cleanup can remain pending independently of the public outcome. */
  cleanup: RequestBuildExecutionReceipt["cleanup"];
  /** Independent delivery state; never implies exactly-once delivery or exposes the private destination. */
  notification?: import("./request-build-notification.js").RequestBuildNotificationState;
  /** Only provider-verified canonical draft PR evidence is projected. */
  pullRequest?: { number: number; url: string };
  /** True when publication was admitted before cancellation could take effect. */
  cancelTooLate: boolean;
}

/** Safe readiness projection; neither a credential nor proof supplied by a caller. */
export interface PublicRequestBuildReadiness {
  /** All actual admission prerequisites currently hold. */
  ready: boolean;
  /** Stable missing prerequisite codes, with no private evidence. */
  reasons: string[];
}

/** Git Data tree entries produced by the trusted publisher, never accepted from generated code. */
export type RequestBuildTreeEntry =
  | { path: string; mode: "100644"; type: "blob"; content: string }
  | { path: string; mode: "100644"; type: "blob"; sha: null };

/** Discriminated private repository reads. Transport derives every path at the fixed canonical origin. */
export type RequestBuildGitHubRead =
  | { kind: "base" }
  | { kind: "commit" | "tree" | "blob"; sha: string }
  | { kind: "ref" | "pulls"; branch: string }
  | { kind: "pull"; number: number };

/** Immutable, digest-authorized publication step. No arbitrary URL/method/header or merge operation. */
export type RequestBuildGitHubWrite =
  | { kind: "tree"; baseTree: string; entries: RequestBuildTreeEntry[] }
  | { kind: "commit"; tree: string; parent: string; message: string; date: string }
  | { kind: "ref"; branch: string; sha: string }
  | { kind: "pull"; branch: string; title: string; body: string };

/** Private write authorization binds one exact persisted operation as well as the execution generation. */
export type RequestBuildGitHubAuthorization = RequestBuildAuthorizationRequest & {
  phase: "publish";
  publicationHash: string;
};

/** Stable JSON hashing for immutable protocol values; rejects undefined and non-JSON values. */
export function canonicalBuildJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalBuildJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      // ES2022 shared consumers: only the newly allocated entries array is mutated.
      // oxlint-disable-next-line unicorn/no-array-sort
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalBuildJson(v)}`)
      .join(",")}}`;
  }
  throw new Error("INVALID_BUILD_JSON");
}

/** SHA-256 of exact UTF-8 protocol data. */
export async function buildHash(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
