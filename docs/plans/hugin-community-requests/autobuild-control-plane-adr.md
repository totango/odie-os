# H0 — Code Session Auto-Build control plane

**Technical design selected; stage-B restricted Sessions component implemented and locally tested, not activated. No live sessions, branches, PRs, messages or deployments created.** The [implementation-first addendum](implementation-first-addendum.md) supersedes the old prerequisite ordering: implement restricted Sessions, durable builds/trusted PR and Slack/run UI before more native research. Complete managed authority/Finance cutover and all actual prerequisites still gate enablement server-side, not component implementation. Preserve U1 only; this work does not select additional upstream batches. Proposed names below do not describe existing APIs.

## 1. Evidence that determines the design

- `workshop-backend/src/user.ts:1679-1715,1786-1802`: Code Sessions require a connected GitHub account with repository write access and a private startup reauthorization callback.
- `workshop-shared/src/coding-sessions.ts:235-338`: Sessions service has owner lifecycle/get metadata/current-generation APIs, but no request-build idempotency or durable build receipt protocol.
- `gatekeeper-sessions/src/sessions.ts:1356-1493`: createSession generates a new UUID each call; blindly retrying it after a lost response can create duplicates.
- `sessions.ts:953-992,1045-1058`: durable startup reauthorizes and clones repositories; default clone is current default branch, not an immutable approved revision.
- `sessions.ts:344-360` and `github-app.ts:22-29`: ordinary sessions have internet access and GitHub contents-write auth in the Worker credential proxy. **Reusing an ordinary session unchanged would let untrusted request-driven code push before a publication guard.** Keeping a token out of environment variables alone does not remove its proxy authority.
- `sessions.ts:373-399,2690-2829` and `product-feedback.ts`: private feedback bot demonstrates deny-by-default execution and separate publication/validation, but is not the requested Code Session-system job. Reuse safety patterns, not its hidden parallel job store.
- Installed Sandbox SDK is pinned `0.13.0-next.724.1`; `Dockerfile.pi` pins a sandbox image digest. Do not upgrade either in H. Exec starts a process; process IDs are generation/container-local, not durable task identities.
- `gatekeeper-jarvis/src/index.ts:88-134,347-384`: notifier forwards a key to external MCP; receiver schema and deduplication guarantees are not established by local code.

## 2. Selected authority and scope

- Platform target is fixed by trusted deployment policy to **`totango/odie-os`**, base branch **`main`**, consistent with origin and current feedback code. Resolve and store a full base commit SHA at approval/start; never accept repository/base from public request text, comments, browser run updates or model output. Operator verifies the GitHub App installation can access that target before enablement.
- A currently authorized **admin with existing Code Session GitHub eligibility** triggers the run. Membership alone does not bypass repository access or model entitlement; Jacob's aliases do not impersonate another account. No new shared robot user for MVP. Durable cleanup/reconciliation is service-owned, so it does not stop working when the triggering admin loses access.
- Create a dedicated request-build **mode of the existing Code Session lifecycle**. Do not borrow a live personal session or load its user plugins, skills, private connector catalog, transcripts or arbitrary customization. Ordinary interactive sessions retain their existing behavior.
- Use a policy-specific deny-by-default Sandbox class/config routed through the existing registry/policy machinery (prospective `RequestBuildSandbox` extending the existing class), not `ProductFeedbackSandbox` jobs. Clone credentials are read-only for the one repository. Vetted model/dependency egress only; no ambient personal MCP, production bindings, deploy secrets, or agent-side contents-write/PR credentials.
- Pin a reviewed runtime/model and immutable build policy version per attempt. No hardcoded new model chosen from memory. Deployment policy must specify wall-time, model-call/spend enforcement, output/diff bounds and approved egress. Safe starting concurrency proposal: **one active Auto-Build per deployment**, one active logical run per request. Missing budget enforcement/config means Auto-Build is unavailable with a reason, not unbounded. The board itself remains default-on.
- Only a trusted publisher may create a request-owned branch/draft PR after validating a frozen patch from an immutable base. Prefer Worker-side GitHub Git Data API publication of an allowlisted file tree using repo-scoped contents/pull-request permissions; generated code never executes with publication credentials. Do not reuse the old helper's `issues:write`/assignment scope without need. No force pushes, base-branch writes, automatic merge, or deploy.

These are selected implementation constraints, not owner approval of live cost/credentials/channel settings. Operator accepts numeric budgets/runtime/egress policy before activation; do not silently supply permissive defaults.

## 3. Public contract vs private protocol

### Public, authenticated Workshop API
- Admin capability: `startRequestBuild({requestId, expectedRequestRevision, mutationKey}) -> {runId, requestRevision, state}`; actor, repo, policy and session identity are server-derived.
- Admin capability: `cancelRequestBuild({requestId, runId, mutationKey}) -> public run state`; any current admin may cancel, including after the initiator is revoked.
- Board API: `getRequestBuild(requestId, runId) -> PublicBuildRun`, signed-in users only, respecting hidden/deleted request access.
- No public methods to attach an arbitrary PR, submit run events, mark success, select a sandbox, or override cost policy. Build control stays outside ambient gadget/agent bindings.

`PublicBuildRun` explicitly allowlists IDs, public request revision, state, timestamps, bounded error **code**, verified PR number/URL and validated request-run path. It excludes owner email, private user ID, session/sandbox IDs, connection IDs, bearer links, transcripts and raw errors. The detail route is `/requests/<requestId>/runs/<runId>`; it is not a Code Session control capability. Any owner/admin workbench action is separately reauthorized and unavailable to an ordinary second user without GitHub access.

### Private binding-only service contract

Extend the real `CodingSessionsService` type in `workshop-shared/src/coding-sessions.ts`; keep internal DTOs in a documented dedicated module if needed. Use existing `WORKSHOP_TOOLS`/`CodingSessionToolHostImpl` private service boundary for reauthorization, not a new unauthenticated HTTP webhook.

- `ensureRequestBuild(owner, intent) -> ExecutionReceipt`: idempotently reserve/find an attempt; matching key with different immutable inputs rejects.
- `getRequestBuildReceipt(owner, dispatchKey) -> ExecutionReceipt | null`: persisted lookup without sandbox reentry.
- `cancelRequestBuildExecution(owner, dispatchKey, cancelRevision) -> ExecutionReceipt`: service-authorized cancellation, retry-safe, no GitHub eligibility requirement for cleanup.
- Workshop-private `authorizeRequestBuild(dispatchKey, phase, generation) -> frozen authorization decision`: rederive actor, grant generation, request approval and policy from backend persistence. Request-supplied booleans are never authority.

**Choose durable polling/reconciliation**, not completion callbacks, for the first version. Backend registry alarm pulls private Sessions receipts; Sessions is the sole writer of execution receipts. Browser polling only renders. Existing service bindings let backend reconstruct the call after restart; no stored ephemeral RPC callback. Service-only naming is not protection by itself: binding targets/private entrypoints must never be reachable through public fetch or the sandbox's MCP tool catalog.

## 4. Persistence and invariants

Backend community registry (one deployment board is the bounded coordination domain; do not put model execution inside its request handler):
- `build_runs(runId PRIMARY KEY, requestId, approvedRequestRevision, specificationHash, actorPrincipalId, actorGrantGeneration, repository, baseBranch, baseSha, policyVersion, state, stateVersion, activeAttempt, createdAt, updatedAt)`.
- `build_start_keys(actorPrincipalId, mutationKey, payloadHash, runId)` unique composite; reject same key/different payload. Partial unique constraint on active run per request and deployment capacity enforced atomically.
- `build_attempts(runId, attemptNo, dispatchKey UNIQUE, sessionId?, sessionGeneration?, sandboxId?, lastReceiptSequence, state, cancelRevision, retryAt)` private; generation binds once on ack, never rewritten for a replacement container.
- `build_notification_outbox(notificationKey PRIMARY KEY, runId, verifiedPrNumber, state, attempts, nextAttemptAt, receiverReceipt?)` separate from run success.

Sessions registry (reuse existing per-owner DO):
- `request-build:<dispatchKey>` receipt with intent hash, preallocated session ID, generation, state sequence, durable stage intent, process handle hint, artifact hash, base/head/branch/PR evidence, retry/cancel/cleanup state.
- Reserve `dispatchKey -> session ID + initial session record` atomically **before external startup**. Reuse the normal lifecycle via a private reserved-session path; do not call public random-ID createSession twice. Public callers cannot choose IDs. Concurrent retries find the same reservation.

Trusted publication evidence is scoped to `(repository, deterministic branch, baseSha, artifactHash, runId, attemptNo)`. Store provider-verified head SHA and PR number; wrong-base/wrong-head/wrong-repo results are conflicts, not success. Branch format uses opaque validated IDs, e.g. `request-build/<runId>/<attemptNo>`; never interpolate untrusted title text into shell/branch names.

Transactions contain only synchronous local SQL/KV operations. Cross-service I/O happens after persisted intent, never inside a storage transaction or a long `blockConcurrencyWhile`. One alarm per DO: integrate new due-work into existing Sessions alarm arbitration, do not overwrite lifecycle/start/stop/ticket alarms with an independent timer.

## 5. State machine and recovery owner

Logical flow:

`queued -> dispatching -> starting -> running -> validating -> publishing -> pr_created`

Other states: `cancel_requested -> canceled`, `failed`, `needs_attention`. Notification and cleanup have separate state machines; `pr_created` is not “feature deployed”. Attempts may advance by a trusted newer snapshot; never use lexical enum ordering. Terminal transitions cannot be overwritten by late running callbacks/receipts. Receipt sequence is monotonically increasing per attempt; duplicate sequence+same hash is a no-op, inconsistent duplicate is an error.

| Boundary/failure | Required recovery and verification scenario |
|---|---|
| Start RPC response lost | Backend transaction already stores mutation key/run; retry returns same logical run after current authority check. Test duplicate clicks/concurrent admins. |
| Alarm scheduling lost after intent | Arm/retain an alarm before acknowledging accepted work; persist intent before external calls. A harmless early wake may find no work. Constructor must not push out an already-due alarm. Test crash after persistence at each ordering boundary. |
| Session reserved/created but ack lost | Retry `ensureRequestBuild` by dispatch key returns the reserved session; never allocate a second UUID. Backend records first receipt then polls. |
| Process launched but handle not persisted | Do not assume `exec()` exactly-once or invent an SDK idempotency option. Reconcile only when trusted evidence identifies the exact attempt process. Otherwise mark needs_attention and stop/destroy the generation before an explicit new attempt; no blind second execution. No write credential was available to ambiguous analysis. |
| Sandbox replaced or generation changed | Reject old receipt for active attempt; retain it in history. New generation requires new attempt and reauthorization, not mutation of existing provenance. |
| Code/tests generated but process fails | Store sanitized error code; private bounded diagnostic sidecar only. Do not label “tests passed” from model text. Record actual runner exit/evidence or “not run/environment blocked”. |
| Branch/ref mutation response lost | Publisher probes exact deterministic ref/head/artifact before retry. Expected ref already present = reconcile; divergent ref = needs_attention, never force update. |
| PR created before receipt persistence | Search GitHub by exact owner/head/base, verify head SHA and request provenance, adopt existing PR; only create if verified absent. No duplicate run on transient GitHub error. |
| Publishing races cancellation/revocation | Fresh authority check before send; no future publication admitted after revoke/cancel. A request already sent may succeed: reconcile PR and show `pr_created` with cancel-too-late, not falsely canceled. Never close/delete a PR automatically. |
| Trigger user loses GitHub/admin access | Deny future model/publish authorization and schedule cancellation. Service receipt reads/destroy/capacity release remain possible. No transferred authority to a random admin. |
| Backend/Sessions restarts | Durable intent/receipt/outbox drives alarms; reconstruct service references from bindings, not browser connection or in-memory promise chains. |
| Long downstream outage | Explicit retry schedule with bounded backoff and needs_attention after policy exhaustion. Platform alarm retries are finite; do not rely on automatic retry forever. |
| Cleanup fails | Persist cleanup intent and exact generation/capacity lease, retry; do not release capacity until destruction confirmed. Terminal public status can coexist with cleanup pending. |
| Slack accepted remotely, response lost | Separate notification `ambiguous` state if receiver dedupe unverified; no blind resend claim. If documented dedupe exists, resend same immutable key within its retention contract. Build/PR success remains true. |

Cancellation before publication stops the process and tears down only the bound build generation. A retry after failed/canceled requires explicit current-admin approval and a new attempt/dispatch key. New comments do not alter the approved specification. Request edits mark revision drift; an admin must explicitly approve a later revision. Hiding/removing a request prevents new publication and public projection; existing PR/message cleanup is an explicit external moderation operation, not silently promised erasure.

## 6. Publication and private evidence boundary

Request text/comments are untrusted input. The admin approves a frozen public specification; it cannot override system policy, change repo targets, authorize personal connector reads, or instruct credential exfiltration. MVP Auto-Build consumes **public specification only**, not raw diagnostic sidecars; a future private-evidence build path needs separate consent/authorization and review.

Validate the frozen artifact before any write-capable publisher sees it: allowed repo/base, bounded text diff, no protected auth/secrets/deploy/workflow paths absent an explicit separate reviewed policy, no symlinks/submodules/binaries/mode changes, no detected secret/evidence echoes. Scan plus sandbox containment is defense in depth, not proof an arbitrary user's text contains no private information. Users see clear public-submission labels and moderation remains necessary.

The existing small feedback limit (12 files/30 changed lines) is not silently inherited or removed. A reviewed feature-build policy must set explicit bounds. Legitimate features requiring protected-path changes go to manual review rather than bypassing guards. Execute verification with no production authority; PR includes actual passed/failed/not-run status, run link and specification revision only. PR author/branch/head are confirmed through GitHub, not a claimed URL from the agent.

## 7. Slack contract and rollout

Use the existing private JARVIS notifier seam, not the read-only Slack gatekeeper. Candidate channel from source is `C09EW0T5VB5`; operator confirms live destination before enablement. Fixed message after **verified draft PR creation**: request link + PR link (+ safe run route), no user-authored freeform body or private evidence. Build failure stays visible on the board; failure notifications can be a separate explicitly approved policy.

Only same-origin, credential-free request/run URLs without bearer query/fragment data and exact canonical GitHub PR URLs are accepted. Notification key binds deployment/run/attempt/PR, not user title. Receiver schema, dedupe scope, retention and message receipt lookup must be documented and integration-tested before claiming exactly-once. If unavailable, expose ambiguous delivery for manual reconciliation; do not silently drop notification or treat “queued” as sent. No messages are sent in planning.

## 8. Files, migration, test strategy

Prospective files: backend `community-requests.ts` (board/run projection), `request-builds.ts` (bounded protocol helpers), `server.ts`/`user.ts` private binding routing; shared `api.ts`, `coding-sessions.ts`, documented request-build DTO module; Sessions `sessions.ts`, `github-app.ts`, new narrowly scoped runner/publication helpers; JARVIS `index.ts`/notifier tests; frontend request/run route. Reuse actual existing types, never parallel mirrored RPC interfaces with casts. No broad kernel rewrite.

No runtime upgrade. Preserve `Dockerfile.pi`, lockfile, Team Pi model policy and preview-disabled config. Existing Sessions DOs get versioned additive record fields. If policy-specific `RequestBuildSandbox` requires a new class/container binding, append the next unused migration in **both** Sessions configs and keep existing tags; validate class/binding choice against installed pinned SDK before implementation. Backend board storage migration belongs to D; AdminAuthority migration belongs to C2. Service entrypoint/protocol additions require compatible provider-first deploy, not DO history rewrites.

Expand unit tests for state reducer, idempotency, branch/URL/patch policy. Add a **real Workers** cross-service integration harness; current Sessions Vitest replaces Workers classes with doubles. Reuse backend/Context workerd patterns, assert runtime, disable remote bindings and mock GitHub/model/Slack at the transport boundary. Inject every table failure, especially lost ack, stale generation, retained revoked admin, ambiguous publication and cleanup/capacity leaks. Package scripts/future commands are pinned in `gate-verification.md`; none ran here.

## Gate disposition

H0 architecture is specified: actor boundary, restricted session mode, immutable approval, binding-only durable polling, idempotent reservation, trusted publication and recovery semantics. Enablement remains blocked on numeric budget/runtime/egress enforcement, provider/GitHub App configuration, admin cutover, implementation tests, migration review, receiver contract and operator channel confirmation. This design intentionally does not claim impossible exactly-once execution of a remote process or retroactive cancellation of an already-sent request.

## Stage-B implementation checkpoint

See [restricted Sessions implementation](restricted-sessions-implementation.md) for actual protocol/registry/runner/egress paths,12 real-workerd cases and activation obligations. The approved stage-C backend host seam currently denies UNKNOWN_RUN; durable run lookup, admin/current-generation/readiness authorization and publisher remain next work. Component setup does not attest actual image/egress or pricing/Finance/drain readiness.

Mid-stage owner authorization supersedes only the harness-pin freeze: image sources now target Pi0.85.1/OpenCode1.18.30; Prime0.8.0 remains due the0.9.4 kernel/MCP2 incompatibility. Sandbox SDK/base and checked production image digest remain unchanged. Restricted SDK runtime requires0.85.1; ordinary bridge accepts the exact0.84.2/0.85.1 provider-first window. No deployed harness upgrade or live canary is claimed.
