# Hugin Anchor Plan: selective upstream integration + authenticated request/bug board + admin Auto-Build

Planning-only anchor for `/Users/jacob_1/odie-os` at `main@248cc75eda989d5ddc93507518a0bf284065e93f`. No implementation, fetch, merge, build, test, dependency install, commit, push, deploy, staging, or external message is authorized by this artifact.

## Anchor status and durable dossier

**Ready for gated planning handoff; not blanket implementation approval.** An independent review requested seven revisions; the revision pass incorporated them, and parent synthesis tightened the DAG below. The revised artifact has not had a second independent review. Downstream work must resolve story-specific gates before implementation.

Durable evidence alongside this anchor: [upstream inventory and candidate/defer matrix](upstream.md), [Code Session/PR/Slack trace](automation.md), [feedback/privacy/UI trace](feedback.md), and [independent draft review](review.md). Historical open questions in those reports are superseded by owner decisions in this anchor. Research reports are evidence, not execution authority.

## Scoped A/C1/H0 follow-up

The subsequent planning-only gate pass is recorded in [gate-decisions.md](gate-decisions.md), with [progress](TODO.md), [fresh upstream matrix](upstream-gate.md), [admin authority ADR](admin-authority-adr.md), [Auto-Build control-plane ADR](autobuild-control-plane-adr.md), and [critic/verification evidence](gate-verification.md). These scoped decisions supersede earlier provisional A/C1/H0 details below; the original dossier is preserved as historical evidence.

Fresh upstream research used an explicitly approved independent clone: divergence is now **441/82**, with **94** overlapping paths. The selected recommendation is a two-file scheduler **test-harness** patch, not a production fix. C1 additionally inventories JARVIS policy and Finance-derived capabilities. H0 chooses private receipt polling and a restricted Code Session mode because an ordinary session already has GitHub write-proxy authority. Runtime, bootstrap, provider and implementation approvals remain gates; see the follow-up for exact dispositions.

## 1. Goal and measurable success

### Goal
Prepare an implementation-ready, dependency-aware plan that first selectively integrates non-conflicting upstream Cloudflare changes without regressing Totango fork customizations; then adds a default-on authenticated Community Requests page for all signed-in deployment users; then deepens bug reporting so new public bug summaries appear in the same list with votes/details; and finally enables admin-only Auto-Build that reuses the Code Session system, links resulting run/PR to the originating request, and posts a completion notification to the approved Slack PR channel.

### Owner decisions already applied
- Public audience means signed-in users of this deployment, not anonymous internet readers.
- Only admins may start Auto-Build.
- Add admin management; supplied Jacob emails are not proof of linked identity or authority.
- Reuse the Code Session system; a dedicated per-build Code Session is acceptable.
- Only new bug submissions become public summaries; historical private reports and raw diagnostics remain private.

### Success criteria for eventual implementation
1. **Upstream:** only audited micro-batches are integrated; no wholesale upstream merge unless separately approved; Totango fork invariants still pass targeted checks and CI.
2. **Board:** authenticated deployment users can list/search public feature requests and new public bug summaries, submit, upvote/unvote idempotently, add public details, and see related/duplicate suggestions.
3. **Privacy:** raw diagnostics, private feedback evidence, workspace/coding-session content, emails, private auth identifiers, transcripts, capability URLs, terminal/editor/OpenCode/Pi tokens, and raw execution errors never appear in public board records, search, PR bodies, Slack messages, logs, or URLs.
4. **Admin:** verified admin management has bootstrap safety, last-admin safeguards, audit trail, and effective revocation across all admin-derived capabilities, not only `AdminApi`.
5. **Auto-Build:** admin start creates an idempotent request-bound automation run with immutable request/session/generation/repository/base binding, durable state transitions, crash/retry recovery, PR/run provenance, cancellation semantics, and no duplicate PRs.
6. **Slack:** approved completion notification links request plus PR/run through validated URLs, has durable retry state, and treats external deduplication semantics as an explicit deployment contract.
7. **Operations:** migrations are additive with rollback plans; moderation/rate limits exist before public launch; tests and CI are run only after implementation authority exists.

## 2. Research dossier, source map, files read, commands, evidence constraints

### Evidence constraints
- Observations are from supplied research/review plus independent read-only source checks during finalization.
- Commands in this finalization were read-only: `git rev-parse HEAD && git status --short --branch && git diff --cached --name-only`.
- Result: HEAD `248cc75eda989d5ddc93507518a0bf284065e93f`; branch status `* main...origin/main`; only untracked `.oculus/` and `.pi/`; no staged files.
- No builds/tests were run. Future verification commands below are **NOT RUN**.
- Local `upstream/main` facts remain from supplied research: local upstream `45ae8c21b4b6b30ca81f69fc1f65db1f42a89278`; remote upstream observed by prior `git ls-remote` as `08afe059f1b9ee37129e0327cde43782870fbb76`; do not infer remote-only commit contents without a future approved independent disposable clone.

### Source map and relevant evidence
| Area | Evidence |
|---|---|
| Skill load | `.agents/skills/write-gatekeeper/SKILL.md:1-30` loaded before final domain consolidation; relevant to capability/security review posture. |
| Hugin convention | Supplied research cites `packages/gatekeeper-sessions/pi-image/node_modules/@howlerops/valhalla/pi/prompts/hugin.md:1-30` and `.../src/hugin.mjs:3-54` as verified dependency-aware planning, no code edits, dossier, DAG, risks, verification, review gates. |
| Checkout state | Final read-only git command returned HEAD `248cc75...`, status `* main...origin/main`, untracked `.oculus/` and `.pi/`, empty staged diff output. |
| Existing feedback model | `packages/workshop-shared/src/product-feedback.ts:12-89` defines private/internal feedback kinds/status; `:109-150` validates/sanitizes input. |
| Existing authenticated API | `packages/workshop-shared/src/api.ts:940-950` has product-feedback availability/submit/list/get only; no community list/vote/comment/search API. |
| Product feedback backend | `packages/workshop-backend/src/user.ts:1919-1951` gates current feedback to verified Totango SSO; `:1953-1999` builds private evidence. |
| Product feedback automation | `packages/gatekeeper-sessions/src/sessions.ts:2636-2829` stores owner-scoped jobs/evidence, clones `totango/odie-os`, runs OpenCode, validates diff, pushes PR, retries Slack. |
| Current UI seam | `packages/workshop-frontend/src/ProductFeedbackButton.tsx:17-70`, `:88-145`, `:205-214` is modal/status UI, not a public route/list. |
| Authenticated route/nav seam | `packages/workshop-frontend/src/routes/__root.tsx:32-39` only signup/blueprint are signed-out public routes; `:196-208` authenticated app shell; `Sidebar.tsx:170-246` primary nav and pinned feedback button. |
| Admin current model | `packages/workshop-backend/src/server.ts:374-390` reads `ADMINS`; `:1138-1169` mints `AdminApi`. `packages/workshop-shared/src/api.ts:1647-1656` documents check-at-mint/no per-method recheck; `:1688-1702` documents soft settings do not revoke existing capabilities. |
| Admin identity aliases | `packages/workshop-backend/src/server.ts:397-410` lists/switches verified account identities; `packages/workshop-backend/src/auth/identity.ts:4-30` resolves and enumerates verified SSO identities. |
| Admin-derived context capability | `packages/workshop-backend/src/server.ts:1146-1154` passes fresh `isAdmin` to gatekeeper app UI; `packages/gatekeeper-context/src/library-gatekeeper.ts:153-160` captures it into `ContextApiImpl`; `packages/gatekeeper-context/src/context-api.ts:58-69`, `:98-108`, `:123-128` uses captured `isAdmin` for public collection writes/admin checks. |
| Storage/migrations | `packages/workshop-backend/wrangler.jsonc:45-68` and `packages/workshop-backend/wrangler.odie-os-production.jsonc:57-63` need additive, history-preserving migration updates. |
| Slack notifier | `packages/gatekeeper-jarvis/src/index.ts:88-134` validates fixed product-feedback PR notification/channel; `:347-384` calls external MCP with idempotency key but does not itself prove receiver dedupe. |
| Test scripts corrected | `packages/gatekeeper-sessions/package.json:6-13` and `packages/gatekeeper-jarvis/package.json:6-15` define `test`, not `test:run`; `packages/gatekeeper-sessions/vitest.config.ts:1-13` aliases `cloudflare:workers` to a test double, not real Workers coverage. |

### Key observations
1. Current product feedback is private/internal and owner-scoped, not a deployment-wide board.
2. Existing private evidence guardrails are valuable but must remain private.
3. Existing product-feedback PR bot is a safety precedent, not the requested Code Session-system Auto-Build substrate.
4. Admin authority currently escapes through more than `AdminApi`; retained gatekeeper UI/context capabilities can capture `isAdmin` and must be included in revocation design.
5. Authenticated UI route/nav seams can support `/requests` without making it anonymous-public.
6. Upstream integration is high-risk if wholesale: supplied research found fork/upstream divergence `441 81`, 93 exact overlapping files, and a stale local upstream ref.

### Inferences
- A new deployment-scoped request/bug registry is required; widening `ProductFeedbackStatus` is not enough.
- Admin authority research and approved ADR must precede freezing admin/build portions of the API contract.
- The public run link must be a non-capability request-run detail projection; raw Code Session workbench/capability URLs are inappropriate.
- Slack exactly-once semantics are unknown until the external receiver schema/dedupe contract is approved.

## 3. Optional memory notes

No persistent memory artifact was available or used. This plan relies on repository inspection plus supplied research/review artifacts only.

## 4. Known / inferred / assumption / question ledger with approval gates

### Known from owner decisions
- Signed-in deployment users are the public audience.
- Auto-Build starts are admin-only.
- Admin management is in scope and must not assume supplied emails prove authority.
- Reuse the Code Session system; dedicated per-build sessions are acceptable.
- New public bug summaries only; no historical backfill or raw diagnostic publication.

### Known from repo evidence
- `ADMINS` is env-driven username-array matching (`server.ts:374-390`).
- `AdminApi` is checked at mint and methods do not re-check (`api.ts:1647-1656`).
- Gatekeeper/context UI capabilities can capture admin state (`server.ts:1146-1154`; `library-gatekeeper.ts:153-160`; `context-api.ts:58-69`, `98-108`, `123-128`).
- Current feedback automation is per-owner/private (`user.ts:1919-1999`; `sessions.ts:2636-2829`).
- Current Slack notifier is fixed-channel/fixed-template product-feedback PR notification (`gatekeeper-jarvis/src/index.ts:88-134`, `347-384`).

### Inferred defaults, subject to approval
- Store board state in a new deployment-scoped backend Durable Object, likely SQLite-backed.
- Store votes keyed by non-public stable user/person identity; expose aggregate count plus current-user vote only.
- Start related suggestions with deterministic lexical matching over public title/summary/details only.
- Store Auto-Build run records with the request registry and allow private service-only execution updates.
- Feature is default-on for authenticated users; individual records can be moderated/hidden rather than gating the whole feature behind an MVP flag.

### Explicit unresolved owner questions / decisions
1. Should public records show submitter display name, anonymous-by-default label, or admin-only submitter identity?
2. Should a bug submission require a distinct “public summary” consent checkbox separate from private diagnostics consent?
3. What retention period is approved for any private bug evidence sidecar after public request creation?
4. Which verified identity dimension controls votes/admin grants: account DO identity, verified person across aliases, or another stable identity record?
5. What is the canonical target repo/base for Auto-Build? Provisional code precedent is `totango/odie-os` / `main`, but this needs approval.
6. Which Slack PR channel is authoritative? Existing code uses `C09EW0T5VB5`; approval is required before any message.
7. What are accepted automation authority/cost limits: bot/service actor, admin-owned session, per-run budget, cancellation rules?
8. What moderation powers are required before launch: hide/delete details, close/reopen, duplicate/merge, spam/rate-limit thresholds, audit visibility?
9. If preview URLs are ever requested, is a separate preview-domain/security approval desired? Default: out of MVP.

### Blocking gates
- Hugin anchor approval before implementation.
- Upstream acquisition gate: any remote acquisition must use an **independent disposable clone**, not this checkout and not a linked worktree. Fetching through this repository or linked worktrees requires an explicit relaxation of the prohibition.
- Admin authority ADR gate before freezing admin/build API surfaces.
- Admin authority implementation/verification gate before Auto-Build.
- Control-plane trust/recovery gate before cross-service Auto-Build implementation.
- Privacy/moderation gate before public launch.
- Slack receiver/dedupe contract gate before claiming exactly-once or sending notifications.
- Migration review gate before Durable Object migration deploy.

## 5. ADR: provisional architecture, alternatives, compatibility, migration

### Status
Proposed. Approval of this anchor would approve a plan only, not implementation or side effects.

### Decision
Create a new authenticated, deployment-scoped **Community Requests** domain in `workshop-backend` as source of truth for signed-in-public feature requests and new public bug summaries. Keep existing product-feedback evidence/private automation as precedent and compatibility surface, not the public board. Add admin authority research and implementation before admin-only Auto-Build. Implement Auto-Build through Code Session-system jobs with private service-only control-plane updates, request-bound public run projections, and Slack notification behind an external receiver contract gate.

### Architecture components
1. **Shared contract:** add `CommunityRequest`, `CommunityRequestDetail`, `CommunityRequestVote`, `CommunityRequestPublicDetail`, `CommunityRequestSuggestion`, `CommunityRequestBuildRunPublic`, moderation/admin types, and authenticated RPCs. Split ordinary board contracts from admin/build contracts until authority ADR is approved.
2. **Backend registry:** new deployment-scoped DO for public requests, details, votes, related/duplicate links, moderation/audit events, build-run records, dispatch intents, acknowledgments, terminal states, and private evidence references.
3. **Private evidence sidecar:** raw diagnostics/workspace/coding-session evidence stays private, TTL-bound, and never indexed; public bug record has explicitly authored public title/summary/details only.
4. **Admin authority:** create a verified identity-aware source of truth outside soft `AdminConfig` unless explicitly justified; include bootstrap from env, last-admin safeguards, per-method or generation-based revalidation, revocation inventory across `AdminApi` and admin-derived gatekeeper/context capabilities, audit, and retained-capability invalidation timing guarantee.
5. **Frontend:** add authenticated `/requests` route under app shell; sidebar item; list/detail/draft form; vote/unvote; public details; related suggestions; admin-only controls surfaced only after revalidated admin status.
6. **Public run projection:** add stable authenticated request-run detail route with allowlisted state/provenance only. Keep Code Session workbench/terminal/editor/OpenCode/Pi links separately authorized and never expose capability URLs publicly.
7. **Auto-Build control plane:** admin start creates immutable request/run/session/generation/repository/base binding and persisted dispatch intent. Sessions execution acknowledges, emits monotonic service-only updates, rejects stale/duplicate caller-authoritative updates, reconciles lost acknowledgments/PR persistence, and supports cancellation/cleanup.
8. **Slack:** extend or add notifier schema only after receiver contract is known. Validate request/run/PR URLs for protocol/host/no credentials/no query or fragment carrying authority; persist notification attempts; do not promise exactly-once unless receiver dedupe scope/retention is documented.
9. **Search/suggestions:** deterministic lexical search over public fields with bounded input/results; no private evidence or model/API calls for MVP.
10. **Moderation/ops:** admin close/reopen, duplicate, hide/restore, audit, rate limits, and recovery runbooks.

### Alternatives considered
| Alternative | Outcome | Rationale |
|---|---|---|
| Extend existing `ProductFeedbackStatus` | Rejected | Owner-scoped, Totango-gated, lacks votes/details/search/build provenance, mixes private evidence concerns. |
| Store board in per-user sessions registry | Rejected | Cannot efficiently provide deployment-wide list/votes and conflates public product state with owner session state. |
| Store board in `AdminSettings` | Rejected | Soft config singleton is not high-churn user content and does not solve capability revocation. |
| Wholesale merge upstream first | Rejected | Heavy divergence/overlap; must integrate audited micro-batches only. |
| Raw Code Session URL as public run link | Rejected | Workbench/capability URLs either deny other users or leak authority. Use non-capability projection. |
| Current PR bot unchanged as Auto-Build | Rejected as substrate | It does not satisfy Code Session-system reuse and has narrow diff limits; reuse guardrail patterns only. |
| Application preview ingress in MVP | Rejected | Separate dark/security-gated infra; not needed to link request/PR/run. |

### Compatibility and migration
- Preserve existing product-feedback APIs/statuses until replacement/bridge is approved.
- No historical private feedback publication or backfill.
- Add new migration tags to both base and Odie production Wrangler configs while preserving each config’s existing history.
- Rollback: hide route/nav or disable starts; retain registry data; stop-new-starts for Auto-Build; let runs finish/fail or mark canceled; Slack pending notifications can retry after config fix or be admin-marked skipped.

## 6. Dependency story DAG with executable story contracts

### Story A — Selective upstream preparation and micro-batch selection
- **Scope:** refresh candidate/dependency matrix against an approved pinned upstream SHA in an independent disposable clone; choose zero or more non-conflicting micro-batches.
- **Must not:** fetch into this checkout or a linked worktree; merge upstream wholesale.
- **Likely files:** only selected upstream batch files; high-risk kernel/auth/session/JARVIS/config files require separate approval.
- **Acceptance:** each selected batch has source SHA, touched files, semantic dependency notes, Totango invariants, targeted tests, and rollback notes. If no safe batch exists, explicitly defer upstream work.
- **Future checks:** targeted package tests per touched files, then full CI. **NOT RUN**.

### Story A2 — Integrate and verify selected upstream batches
- **Inputs/dependencies:** A's refreshed, pinned candidate/dependency matrix and owner-approved batch selection.
- **Outputs:** one separately reviewable integration commit/PR per coherent batch, exact-head verification evidence, preserved fork-invariant matrix, and rollback instructions. No automatic merge or deployment.
- **Likely files:** precisely those selected in A; include dependency/lockfile closure rather than selecting by textual conflict status alone.
- **Verification:** baseline and post-batch targeted tests plus CI; classify pre-existing failures separately. Re-audit all later file references/contracts against the resulting integration head.
- **Parallel safety:** serial integration writer. Independent read-only reviewers may run concurrently; no feature implementation until all approved batches finish. Skipping upstream requires an explicit owner-approved deferral, not an agent's silent decision.

### Story B1 — Ordinary Community Requests contract
- **Scope:** signed-in-public list/detail/search/submit/vote/unvote/add-detail/suggest APIs and types; public/private field boundaries; error codes/JSDoc.
- **Files:** `packages/workshop-shared/src/api.ts`, new shared community module/export if needed, tests.
- **Prereqs:** Story A2 verified, or explicit owner-approved upstream deferral; C1 identity decision before finalizing vote uniqueness.
- **Acceptance:** type-safe contract; no admin/build control-plane authority in this first freeze; every public type excludes private evidence/capability URLs; kernel/API review complete.
- **Future checks:** shared typecheck/unit contract tests. **NOT RUN**.

### Story B2 — Admin/build contract after authority ADR
- **Scope:** admin management APIs, moderation APIs, Auto-Build start/status public projection, private service update interfaces if shared.
- **Files:** shared API/types plus backend-private service types if needed.
- **Prereqs:** Story C1 and H0 approved; A2 verified or owner-approved deferral.
- **Acceptance:** admin/build contract reflects identity/revocation/control-plane design; caller-authoritative “link PR”/“mark completed” mutations are absent from public APIs.
- **Future checks:** typecheck plus authorization contract tests. **NOT RUN**.

### Story C1 — Admin authority research and approved ADR
- **Scope:** inventory all admin-derived capabilities (`AdminApi`, gatekeeper app UIs, context library admin writes, any other captured admin booleans); decide verified identity model, bootstrap, last-admin, audit, stale capability revocation timing.
- **Files read/likely:** `server.ts`, `api.ts`, `auth/identity.ts`, gatekeeper/context UI APIs, admin UI.
- **Acceptance:** ADR states whether votes/grants follow account DO or verified person across aliases; defines enforceable revocation for retained capabilities; serializes shared/backend authority edits.
- **Future checks:** design review only before implementation. **NOT RUN**.

### Story C2 — Admin authority implementation and verification
- **Scope:** implement approved admin source of truth, admin management UI/API, audit, bootstrap fallback, last-admin protection, retained-capability revocation.
- **Files:** `packages/workshop-backend/src/server.ts`, possible admin-authority DO/module, `packages/workshop-shared/src/api.ts`, admin frontend/tests, context/gatekeeper capabilities if ADR requires.
- **Acceptance:** non-admin denial; grant/revoke; alias/verified-email handling; stale `AdminApi` denial; retained `ContextApi` mutation denied after revocation according to timing guarantee; audit entries written.
- **Future checks:** backend/admin/context tests, including retained context capability revocation. **NOT RUN**.

### Story D — Backend public registry and migrations
- **Scope:** DO schema/storage/API implementation for requests, public details, votes, related/duplicate links, moderation fields, public projections, private evidence references, rate limits.
- **Files:** `packages/workshop-backend/src/server.ts`, `user.ts`, new registry module, `wrangler.jsonc`, `wrangler.odie-os-production.jsonc`, tests.
- **Prereqs:** B1; moderation/admin fields that need authority depend on C1/C2.
- **Acceptance:** submit/list/search/detail/vote idempotency/add-detail/redaction/pagination/rate-limit/moderation/migration tests pass; public projections never include private fields.
- **Future checks:** repo-confirmed backend DO/workerd tests. **NOT RUN**.

### Story E — Related/duplicate suggestions
- **Scope:** deterministic public-text-only matching during draft and submit; duplicate linkage support.
- **Files:** backend registry/search module/tests; frontend form integration.
- **Prereqs:** B1, D read model.
- **Acceptance:** bounded ranking over title/summary/details only; abusive/empty input handled; no private evidence indexing; submit returns suggestions without blocking submission.
- **Future checks:** pure ranking tests and integration tests. **NOT RUN**.

### Story F — Frontend board and request/bug UI
- **Scope:** `/requests` authenticated route, sidebar nav item, list/search/filter/sort, detail, submit feature/bug, vote/unvote, add public details, suggestions, public run projection links, admin-only controls when revalidated.
- **Files:** `packages/workshop-frontend/src/routes/*`, generated route tree, `components/AppShell/Sidebar.tsx`, new components/hooks/tests, possible feedback-button transition.
- **Prereqs:** B1; can mock D until backend ready; admin-only UI waits for C/B2.
- **Acceptance:** signed-out users see login, signed-in users see board; vote display idempotent; public bug labels clear; no private evidence rendered; second user without GitHub access can view public run projection but cannot control session.
- **Future checks:** frontend jsdom/UI tests and accessibility basics. **NOT RUN**.

### Story G — Legacy product-feedback bridge and new public bug path
- **Scope:** transition old modal/statuses while routing new bug submissions into public summaries only when explicitly authored for public display; preserve private feedback automation/statuses until deprecation.
- **Files:** `ProductFeedbackButton.tsx`, backend `user.ts`, shared product/community types, tests.
- **Prereqs:** D, F, privacy review.
- **Acceptance:** no historical publication; raw diagnostics private/TTL-bound; UI separates public summary from private evidence consent; existing owner statuses still private or cleanly deprecated.
- **Future checks:** privacy regression tests and old product-feedback tests. **NOT RUN**.

### Story H0 — Approve build control-plane contract
- **Inputs/dependencies:** C1 authority ADR, existing Code Session service/API trace, approved repo/base and actor/budget policy. Read-only design can parallel upstream research.
- **Outputs:** concrete private service protocol, durable state table and recovery ownership, approved-spec revision binding, dispatch deduplication key, execution acknowledgment, reconciliation queries, and cancellation/revocation semantics. Session generation is recorded when acknowledged and immutable for that execution attempt; retries create distinct attempts rather than rewriting provenance.
- **Verification:** table-top failures at intent persistence, session-created/ack-lost, PR-created/state-lost, stale callback, revoked admin, canceled run, and Slack-accepted/response-lost. Browser polling is not the recovery owner. PR status must come from authenticated provider/service evidence, never model text or caller-submitted URLs.
- **Safety:** public request text and comments are untrusted specifications, not authority to change repo targets, credentials, protected paths, budgets, or review policy. Freeze the admin-approved specification revision; later comments do not silently alter a running build. No auto-merge or deployment from Auto-Build.
- **Parallel safety:** design/review only; approve before B2/H implementation.

### Story H — Cross-service Auto-Build control plane on Code Session system
- **Scope:** admin-only start, immutable run binding, dedicated/selected Code Session dispatch, service-only status callbacks/reconciler, PR branch/url capture, failure/cancellation/retry, duplicate prevention.
- **Files:** `workshop-backend/src/user.ts`, registry module, `gatekeeper-sessions/src/sessions.ts`, Code Session runtime modules, safety helper module/tests.
- **Prereqs:** H0, B2, C2, D, canonical repo/base gate, automation authority/cost gate.
- **Acceptance:** revoked admin denied; one active run per request/revision policy; stale session/generation updates rejected; lost ack and PR-before-persist failures reconcile; no duplicate PRs; private evidence not echoed; terminal state durable.
- **Future checks:** backend + sessions tests, plus new real-Workers/cross-service integration harness. **NOT RUN**.

### Story I — Public run projection
- **Scope:** stable authenticated route/data model showing allowlisted run state/provenance only.
- **Files:** shared public run types, backend projection API, frontend route/components/tests.
- **Prereqs:** D/H schema.
- **Acceptance:** second signed-in user without GitHub access can view request/run state; raw workbench URLs, tokens, terminal/editor/OpenCode/Pi capabilities, transcripts, raw execution errors, and credential-bearing URLs are rejected/not rendered.
- **Future checks:** visibility/authorization tests. **NOT RUN**.

### Story J — Slack completion notification
- **Scope:** validated completion notification with request URL + PR/run URL, durable retry, idempotency, external receiver contract.
- **Files:** `packages/gatekeeper-jarvis/src/index.ts`, shared notifier types or new module, sessions/backend update path, tests.
- **Prereqs:** H/I schema, Slack channel gate, receiver schema/dedupe gate.
- **Acceptance:** local validator rejects invalid URL hosts/credentials/query/hash/capability data; mocked “accepted remotely, response lost, retry” behavior handled per documented semantics; no raw evidence; no messages sent before approval.
- **Future checks:** `pnpm --filter @gadgets/gatekeeper-jarvis test`; integration verification only after external-message approval. **NOT RUN**.

### Story K — Operations, moderation, rollout, rollback
- **Scope:** rate limits, spam handling, moderation controls, audit UI/logs, metrics, migration runbook, rollback/cancel/retry runbooks.
- **Files:** backend/admin/frontend/docs/tests.
- **Prereqs:** C/D/H/I/J.
- **Acceptance:** moderation actions audited; rate limits tested; migration/rollback rehearsed in non-production; launch checklist prevents raw private data exposure.
- **Future checks:** abuse/rate-limit/audit tests and deployment dry run after authorization. **NOT RUN**.

### Authoritative DAG and concurrency contract

```text
A -> A2 -> B1 -> D -> E
C1 -> B1 (identity semantics only)
C1 -> H0 -> B2 -> C2
C1 -> C2
A2 -> B2
B1 -> F (mocked backend; D required for integration)
D + F + privacy decision -> G
H0 + B2 + C2 + D -> H -> I -> J
C2 + D + F -> K-core (moderation, rate limits, board rollout)
G + E + K-core -> board launch gate
H + I + J + K-core -> K-automation -> Auto-Build launch gate
```

C1/H0 research may run alongside A; their implementation waits for the upstream gate. C2 and D share backend/API seams and therefore serialize in this checkout; F may run in an isolated frontend lane after B1, with mocked contracts. E backend edits serialize with D. K is split so board moderation does not depend on Slack delivery or force unsafe early launch. Each story's named scope is its output contract; its prerequisite artifacts are its inputs. Acceptance evidence must record exact commit, commands/results, reviewer findings, and remaining risks.

## 7. Execution schedule

1. **Preflight only:** re-run clean-state checks at implementation start: `git rev-parse HEAD && git status --short --branch && git diff --cached --name-only`.
2. **Upstream first, serial:** if approved, use an independent disposable clone to fetch/pin upstream; update candidate matrix; integrate at most one audited micro-batch at a time. Stop on kernel/auth/session/JARVIS/toolchain surprise.
3. **Contract split:** freeze B1 ordinary board contract first. Do not freeze admin/build portions until C1 ADR is approved.
4. **Authority before automation:** complete C1 ADR and C2 implementation/verification before Auto-Build work.
5. **Parallel after B1:** backend registry (D), frontend board (F with mocks), and suggestions (E after D read model) may proceed with one writer per seam.
6. **Legacy bridge:** integrate new-public-bug path only after registry/UI privacy labels exist.
7. **Authority-sensitive serial lane:** H, I, J proceed after C2/B2/D and deployment gates; one owner for cross-service control-plane state.
8. **Rollout:** feature is default-on for authenticated users once ready; moderation controls and rollback runbooks must exist before broad launch; Slack/external messages require explicit approval.

Recommended first downstream invocation (human slash command, planning/preparation scope only):

```text
/tyr Read docs/plans/hugin-community-requests/anchor.md and its dossier. Perform read-only preflight and resolve Story A acquisition/selection gates and C1/H0 decisions only. Do not edit code, fetch into this checkout, merge, push, deploy, or send Slack messages. Stop for explicit implementation authorization.
```

The anchor path and natural-language scope are the handoff; no additional `/tyr` flags or runtime semantics are assumed. `/vidar` may consume the same scoped handoff instead.

First shell check within that handoff (read-only preflight):

```bash
git rev-parse HEAD && git status --short --branch && git diff --cached --name-only
```

## 8. Risk register, verification matrix, review gates, finding dispositions

### Risk register
| Risk | Likelihood | Impact | Mitigation |
|---|---:|---:|---|
| Private diagnostics leak publicly | Medium | Critical | Separate public/private stores; explicit public fields; redaction tests; no private indexing. |
| Admin revocation incomplete | High | High | Inventory all admin-derived capabilities; per-method/generation revalidation; retained-capability tests. |
| Linked worktree used as false fetch isolation | Medium | High | Require independent disposable clone for upstream acquisition. |
| Contract frozen before authority design | Medium | High | Split B1/B2; C1 before B2. |
| Cross-service run state inconsistency | Medium | High | Persisted dispatch intent/ack; monotonic service updates; reconciler; failure-injection tests. |
| Public run link leaks capability | Medium | Critical | Non-capability public projection; strict URL validation; deny raw workbench/token links. |
| Slack duplicate or missed notification | Medium | Medium/High | Receiver contract gate; durable retries; unresolved exactly-once if dedupe unknown. |
| Duplicate PRs/builds | Medium | High | Request/revision/run idempotency; branch/PR reconciliation; stale update rejection. |
| Upstream semantic conflict despite textual non-overlap | Medium | High | Small batches, manual audit, targeted tests, kernel review. |
| Abuse/spam on public board | Medium | Medium | Auth-only MVP, rate limits, moderation/audit. |
| Historical private feedback published | Low/Medium | Critical | No backfill; privacy tests. |

### Future verification matrix — NOT RUN
| Area | Future command/check | Purpose | Status |
|---|---|---|---|
| Frontend UI | `pnpm --filter @gadgets/workshop-frontend test:run` if still valid in package scripts | Board route, submit/vote/details/suggestions, private evidence not rendered | NOT RUN |
| Backend registry | repo-confirmed backend test command, e.g. `vp run -F @gadgets/workshop-backend test` if valid | DO storage, migrations, redaction, votes, rate limits | NOT RUN |
| Sessions | `pnpm --filter @gadgets/gatekeeper-sessions test` | Code Session automation unit coverage; note current Vitest aliases Workers APIs to test double | NOT RUN |
| Real Workers integration | new harness/config deliverable | Cross-service authority/durable-state/failure-injection tests beyond current Sessions Vitest | NOT RUN |
| Slack notifier | `pnpm --filter @gadgets/gatekeeper-jarvis test` | URL/idempotency validation and retry behavior | NOT RUN |
| Shared contract | package typecheck/build command confirmed by implementer | API exports/JSDoc compatibility | NOT RUN |
| Full repo | `pnpm lint`, `pnpm build`, `pnpm test` after authorization | CI parity before merge | NOT RUN |
| Manual/security | auth/privacy/control-plane/Slack/migration reviews | Gates above | NOT RUN |

### Review finding dispositions incorporated
1. **Linked worktree isolation:** accepted. Plan now requires an independent disposable clone for approved upstream acquisition; linked worktree/branch is not considered isolation.
2. **Contract freeze vs authority design:** accepted. Split B1 ordinary board contract from B2 admin/build contract; C1 ADR precedes B2; C2 implementation precedes H.
3. **Admin-derived capabilities:** accepted. Added inventory requirement for gatekeeper/context retained admin capabilities and retained-capability revocation test.
4. **Cross-service control plane:** accepted. Added explicit dispatch intent, ack, monotonic private updates, reconciler, stale update rejection, lost ack/PR persistence recovery, cancellation/cleanup.
5. **Public run links:** accepted. Added non-capability public run projection and strict prohibition on workbench/capability/token/transcript/raw error exposure.
6. **Slack exactly-once:** accepted. External receiver schema/dedupe is a deployment gate; exactly-once remains unresolved until documented.
7. **Verification command corrections:** accepted. Sessions/JARVIS future commands changed to `test`; real Workers integration harness is a deliverable.

### Remaining gates
- User/owner approval of this final anchor before implementation.
- Independent disposable clone approval for upstream acquisition.
- Admin identity/revocation ADR approval.
- Canonical repo/base, Slack channel, automation authority/cost, moderation, evidence retention, and display-name decisions.
- Privacy/security review before public bug launch and Auto-Build enablement.
- Migration review before deploy.
- Pre-merge review verifying actual tests/CI, no staged/untracked surprises beyond expected preserved `.oculus/` and `.pi/`.

## Final anchor statement
Do not treat the existing product-feedback PR bot as the requested public request system. It is useful evidence and contains reusable safety patterns, but the requested feature requires a new authenticated public request/bug domain model, an admin-management authority model, a non-capability request-run projection, and a Code Session-system Auto-Build control plane with durable request/PR/Slack provenance. Upstream integration must happen first in audited micro-batches, never by wholesale merge, and any upstream acquisition must occur only through an approved independent disposable clone under the current no-fetch-in-this-checkout constraint.
