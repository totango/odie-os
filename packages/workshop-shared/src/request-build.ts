/** Immutable deployment-selected limits; omission never means unlimited. Amounts are USD microdollars. */
export interface RequestBuildPolicy {
  /** Operator-reviewed policy revision. */
  version: string;
  /** Exact installed Pi SDK version, checked again inside the runner. */
  runtimeVersion: string;
  /** Exact approved Responses model identifier. */
  model: string;
  /** Absolute execution duration, including startup. */
  wallTimeMs: number;
  /** Maximum billable requests, charged before forwarding (including unsuccessful requests). */
  modelCalls: number;
  /** Maximum cumulative conservatively reserved model spend. */
  spendMicros: number;
  /** Reviewed worst-case charge for a request at the input/output limits, never refunded. */
  callChargeMicros: number;
  /** Maximum serialized model input bytes. */
  modelInputBytes: number;
  /** Enforced Responses output-token limit. */
  modelOutputTokens: number;
  /** Maximum retained process output and model response bytes. */
  outputBytes: number;
  /** Maximum frozen UTF-8 patch bytes. */
  diffBytes: number;
  /** Maximum changed files. */
  diffFiles: number;
  /** Deployment-wide simultaneous attempts; this implementation supports exactly one. */
  concurrency: number;
  /** Approved read-only dependency hosts; empty explicitly denies all dependency downloads. */
  dependencyHosts: string[];
}

/** Private, backend-authored immutable attempt; never accepted from a browser or sandbox. */
export interface RequestBuildIntent {
  /** Opaque idempotency key shared by backend persistence and Sessions reservation. */
  dispatchKey: string;
  /** Opaque logical run identifier. */
  runId: string;
  /** Positive attempt ordinal. */
  attempt: number;
  /** Approved public specification only, without private account/session context. */
  specification: string;
  /** SHA-256 of the exact UTF-8 specification. */
  specificationHash: string;
  /** Fixed canonical repository, not chosen by model output. */
  repository: "totango/odie-os";
  /** Fixed publication base branch. */
  baseBranch: "main";
  /** Full immutable approved base commit. */
  baseSha: string;
  /** Frozen policy, compared with current private deployment policy before reservation. */
  policy: RequestBuildPolicy;
  /** SHA-256 of canonical policy JSON. */
  policyHash: string;
}

/** Reauthorization phase; every decision is reconstructed from backend persistence. */
export type RequestBuildPhase = "reserve" | "start" | "model" | "collect" | "publish";

/** Exact receipt identity sent to the private Workshop host, not the sandbox catalog. */
export interface RequestBuildAuthorizationRequest {
  /** Idempotency key to look up in the backend attempt table. */
  dispatchKey: string;
  /** Current operation to authorize. */
  phase: RequestBuildPhase;
  /** Preallocated session, retained across lost acknowledgements. */
  sessionId: string;
  /** Immutable container generation, never silently replaced. */
  generation: number;
  /** Canonical immutable intent hash. */
  intentHash: string;
  /** Exact persisted GitHub operation digest; mandatory only for publication admission. */
  publicationHash?: string;
}

/** Frozen private decision. A grant requires current admin, owner GitHub/model eligibility and readiness. */
export type RequestBuildAuthorization =
  | { allowed: false; reasons: string[] }
  | { allowed: true; intentHash: string; sessionId: string; generation: number };

/** Durable execution state; publication and notifications belong to the Workshop, not Sessions. */
export type RequestBuildExecutionState = "reserved" | "starting" | "running" | "collecting" |
  "artifact_ready" | "cancel_requested" | "canceled" | "failed" | "needs_attention";

/** Private persisted execution snapshot; contains no transcript, credential, raw provider error or patch. */
export interface RequestBuildExecutionReceipt {
  /** Attempt idempotency key. */
  dispatchKey: string;
  /** Immutable input identity. */
  intentHash: string;
  /** Reserved existing-Code-Session registry identity. */
  sessionId: string;
  /** Exact sandbox generation for this attempt. */
  generation: number;
  /** Strictly increasing snapshot sequence. */
  sequence: number;
  /** Current durable execution outcome. */
  state: RequestBuildExecutionState;
  /** Persisted side-effect stage; launch without a handle is ambiguous, not retryable. */
  stage: "authorize" | "setup" | "clone_launch" | "clone_wait" | "runner_launch" | "runner_wait" | "collect_launch" | "collect_wait" | "done";
  /** Latest accepted cancellation revision. */
  cancelRevision: number;
  /** Reservation time in Unix milliseconds. */
  createdAt: number;
  /** Latest state transition time in Unix milliseconds. */
  updatedAt: number;
  /** Absolute execution deadline. */
  deadline: number;
  /** Closed error code, never a provider message. */
  errorCode?: string;
  /** SHA-256 of the frozen patch, if available. */
  artifactHash?: string;
  /** Cleanup is independently retryable and retains capacity until confirmed. */
  cleanup: "pending" | "complete";
}

/** Untrusted frozen patch for independent trusted-publisher validation; private binding only. */
export interface RequestBuildArtifact {
  /** Base commit required by the approved intent. */
  baseSha: string;
  /** Exact UTF-8 git patch, including new files. */
  patch: string;
  /** SHA-256 of patch bytes. */
  hash: string;
}

/** Private setup diagnostic; readiness does not prove live image/egress validation. */
export interface RequestBuildReadiness {
  /** Private provider-first protocol, including permanent cancellation fences and digest-bound Git Data transport. */
  protocolVersion?: "request-build-git-data-v1";
  /** True only when all component prerequisites are configured. Backend activation adds authority gates. */
  ready: boolean;
  /** Bounded closed missing/invalid prerequisite codes. */
  reasons: string[];
  /** Validated policy if fully specified. */
  policy?: RequestBuildPolicy;
}
