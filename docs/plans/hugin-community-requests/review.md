## Review

**Verdict: REVISE before gated handoff.** The architecture direction is sound, but several authority and execution dependencies need explicit treatment. Approval of the revised anchor would approve a plan—not fetching, implementation, testing, deployment, or external side effects.

### Correct
- **Separate public requests from private feedback.** Existing submission/status methods are owner-scoped and Totango-SSO gated; evidence includes email, diagnostics, workspace content, and session metadata (`packages/workshop-backend/src/user.ts:1919-1999`). The proposed separate registry, authenticated audience, and no historical backfill preserve the owner decisions.
- **Target platform-repository changes, not Gadget generation.** Existing PR automation targets `totango/odie-os`, base `main` (`packages/gatekeeper-sessions/src/product-feedback.ts:5-6,157-183`). The draft correctly treats that as the provisional target and rejects the private PR bot as the Code Session implementation substrate.
- **Preserve Code Session authority.** Repository access is checked through connected GitHub credentials and repository write access (`packages/workshop-backend/src/user.ts:1679-1715`). Startup reauthorizes through a private Workshop service callback (`packages/gatekeeper-sessions/src/sessions.ts:953-992`; `packages/workshop-backend/src/server.ts:275-291`).
- **Keep previews out of scope.** Session attachment/editor/OpenCode URLs are capabilities, not ordinary public run links (`packages/workshop-shared/src/api.ts:686-720`).
- **Keep migrations additive.** The cited base and production configurations have materially different v3 contents; preserving both histories while adding a new tag is appropriate (`packages/workshop-backend/wrangler.jsonc:45-68`; `packages/workshop-backend/wrangler.odie-os-production.jsonc:57-63`).

### Fixed
None. Review-only; no files edited.

### Findings

#### 1. P1 — A linked worktree or integration branch does not isolate upstream acquisition

**Location:** Draft §2 evidence constraints, §4 acquisition gate, §7 Phase 1.

The plan offers a “disposable clone/worktree or explicit integration branch” while preserving the prohibition against fetching into this checkout. These are not interchangeable isolation boundaries: linked worktrees share the repository’s object store and ordinary refs; changing branches does not isolate a fetch.

**Smallest fix:** Specify an **independent disposable clone, not a linked worktree**, for any subsequently approved remote acquisition. Fetching through this repository or its linked worktrees must require an explicit change to the current prohibition. Preserve the local-versus-remote inventory distinction and refresh the candidate/dependency matrix against an explicitly pinned upstream SHA before selecting patches.

**Evidence limit:** The SHA, divergence counts, and candidate matrix are supplied research evidence; this reviewer did not rerun Git or inspect remote-only commits.

#### 2. P1 — Contract freeze precedes the authority design that determines the contract

**Location:** Draft §6 Stories B/C/H and §7 Phases 2–4.

Story B freezes admin/build contracts before Story C resolves identity, bootstrap, and revocation. Story C formally outputs a research/design ADR, while H depends on C without a separately completed admin-management implementation milestone. The schedule nevertheless introduces a parallel admin implementation lane.

This matters beyond naming: current authorization uses the named user DO (`server.ts:374-390`), whereas verified SSO can enumerate and switch between existing account identities (`server.ts:397-410`; `auth/identity.ts:4-30`). Identity selection affects both grants and vote uniqueness.

**Smallest fix:**
- Split C into **authority research/approved ADR** and **authority implementation/verification**.
- Complete the ADR before freezing admin/build portions of B; ordinary board contracts can proceed separately.
- Make H depend explicitly on implemented, tested authority management.
- State whether votes/grants follow an account DO or a verified person across aliases; do not silently equate these.
- Serialize edits to shared/backend authority seams rather than describing overlapping kernel writers as independently safe.

#### 3. P1 — Revocation inventory omits admin authority already delegated to gatekeeper UIs

**Location:** Draft §1 admin success, §5 architecture item 4, §6 Story C.

The draft focuses on minted `AdminApi`, but existing admin authority also escapes through other capabilities:

- Workshop opens gatekeeper UIs with an `isAdmin` boolean (`packages/workshop-backend/src/server.ts:1146-1154`).
- Context captures that boolean in a returned RPC capability (`packages/gatekeeper-context/src/library-gatekeeper.ts:153-160`).
- That capability subsequently authorizes public collection writes using the captured value (`packages/gatekeeper-context/src/context-api.ts:58-69,98-108,123-128`).

Updating `#isAdmin()` and `AdminApiImpl` alone therefore cannot satisfy the draft’s promise of effective revocation of already-minted admin authority.

**Smallest fix:** Add a bounded inventory of admin-derived capabilities to C’s ADR and define enforceable revocation for each. Include a test that retains a Context management capability, revokes the admin, then attempts a public-collection mutation. Define the revocation timing guarantee explicitly; short TTLs or login invalidation are not automatically equivalent to immediate invalidation of retained capabilities.

This is a missing requirement in the proposed dynamic-admin change, not a claim that existing static-admin behavior was newly broken.

#### 4. P1 — Durable cross-service build orchestration lacks its trust and recovery contract

**Location:** Draft §5 architecture items 2/6, §6 Stories B/D/H/I.

The plan puts authoritative runs in a backend registry but execution in Sessions, without identifying the private completion/status seam, its authority, or the recovery owner. Existing `CodingSessionsService` provides owner-scoped lifecycle and private-feedback operations, not request-build completion callbacks (`packages/workshop-shared/src/coding-sessions.ts:277-338`). Existing feedback writes PR/Slack progress within its own registry (`packages/gatekeeper-sessions/src/sessions.ts:2790-2829`); that is not a cross-service consistency solution.

**Smallest fix:** Add a control-plane design gate before B/H implementation covering:
- Private service-only updates, never caller-authoritative “link PR” or “mark completed” mutations.
- Immutable request/run/session/generation/repository/base binding and an approved request revision.
- Persisted dispatch intent, execution acknowledgment, monotonic transitions, and stale/duplicate update rejection.
- A restart-safe callback receiver or reconciler—not only an in-memory RPC stub or browser polling.
- Recovery when session creation succeeds but acknowledgment is lost, and when PR creation succeeds before registry persistence.
- Cancellation/revocation behavior and cleanup ownership.

Add failure-injection tests at these boundaries. Generic “crash recovery” acceptance text does not yet specify what must recover.

#### 5. P1 — Public run links need an explicit non-capability projection

**Location:** Draft §1 success items 3/5/6, §5 architecture items 6/7, §6 Stories F/H/I.

The plan promises public run/session links without defining their reader surface. Current session workbenches are owner/repository-authorized (`packages/workshop-backend/src/user.ts:1837-1879`), and their attachment URLs carry authority (`packages/workshop-shared/src/api.ts:686-720`). The existing `/sessions` page also requires a connected GitHub account (`packages/workshop-frontend/src/routes/sessions.tsx:29-50`).

A raw workbench URL would either be inaccessible to other board users or distribute a capability.

**Smallest fix:** Define a stable authenticated request-run detail route containing only allowlisted public status/provenance. Keep the owner/admin Code Session workbench as a separately authorized action. Explicitly prohibit terminal/editor/OpenCode/Pi connection tokens, capability URLs, transcripts, and raw execution errors in board records, Slack, and PR bodies. Validate run URLs as strictly as request URLs, including rejection of credentials and capability-bearing query/fragment data.

Test visibility as a second user without GitHub access and test denial of session control access.

#### 6. P1 — Slack exactly-once behavior depends on an unverified external contract

**Location:** Draft §1 success items 5/6, §5 architecture item 7, §6 Story I.

The existing notifier forwards a fixed tool invocation and `idempotencyKey` to external MCP; it does not implement receiver-side deduplication locally (`packages/gatekeeper-jarvis/src/index.ts:347-384`). Its current validator accepts a narrowly defined legacy key and PR-only template (`index.ts:88-134`).

Therefore, extending the local validator and persisting retries does not establish that the external tool accepts request/run metadata or suppresses duplicate messages after an ambiguous timeout.

**Smallest fix:** Extend the Slack deployment gate to require documented receiver schema, deduplication scope/retention, and accepted delivery semantics. If that contract is unavailable, explicitly mark exactly-once delivery as unresolved rather than promising it. Plan a mocked “accepted remotely, response lost, retry” test and a separate approved integration verification; send no messages during planning.

#### 7. P2 — Two verification commands do not exist; Sessions workerd coverage is unspecified

**Location:** Draft §8 verification matrix.

- `packages/gatekeeper-sessions/package.json:6-13` defines `test`, not `test:run`.
- `packages/gatekeeper-jarvis/package.json:6-15` likewise defines `test`, not `test:run`.
- Sessions’ current Vitest configuration aliases `cloudflare:workers` to a test double (`packages/gatekeeper-sessions/vitest.config.ts:1-13`); it does not establish the advertised workerd coverage.

**Smallest fix:** Replace those future commands with:
- `pnpm --filter @gadgets/gatekeeper-sessions test`
- `pnpm --filter @gadgets/gatekeeper-jarvis test`

Name the additional real-Workers integration harness/configuration as a deliverable for cross-service authority and durable-state tests. Keep every command marked **NOT RUN** until execution is authorized.

### Evidence and limitations

- Loaded `.agents/skills/write-gatekeeper/SKILL.md` before domain inspection.
- Used only `read`, scoped `grep`, and `find`; all review tool operations completed without infrastructure failure.
- No shell/Git commands, tests, builds, installs, network acquisition, edits, staging, or external messages were performed.
- Initial HEAD, upstream inventory, and empty index are attributed to supplied research, not independently refreshed.
- Supplied research records exploratory command errors. Those are not passing checks and should remain in the final evidence ledger.

### Merge verdict

**BLOCK — revise the planning artifact.** Resolve the planning omissions above, retain unresolved deployment decisions as explicit gates, then seek gated handoff approval. No implementation permission is conveyed by this review.
