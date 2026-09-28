# Polaris: full upstream alignment and state-preserving reconnects

## Status and mandate

### Upstream refresh to 687aab04 (active integration)

The original authoring status and pins below are historical. After the prior upstream/main
integration, the coordinator started another authorized upstream merge (42 new commits). Verified:

| Input | Revision |
| --- | --- |
| Current integration HEAD | `41a54d0b469802b215d9642105481bd3d1f540c6` |
| Active upstream MERGE_HEAD | `687aab049cf084030a42093c10c4dde3d9c33fb4` |
| Merge base of those inputs | `a591fe32783a09a0d9ac34abe203a30e778345b7` |
| Original upstream target (unchanged) | `a591fe32783a09a0d9ac34abe203a30e778345b7` |

T owns tooling/configuration and the explicitly delegated E evals source/tasks/tests; K retains
integration-tests source and F/C retain their runtime ownership. Preserve both the
latest-main Playwright browser-continuity workflow and the integrated upstream/local test suites,
dependency versions, and generated-config contracts. The merge remains uncommitted; resolving or
staging conflicts does not establish completed merge ancestry. See `polaris-tooling-handoff.md`
for current verification rather than the historical authoring-pass statements below.

#### Current loop ledger

| Working loop | Provenance / confidence | Work and outcome |
| --- | --- | --- |
| Approximately 8 prior substantial loops | Coordinator estimate supplied with this merge; not independently reconstructed by T | Prior integration/review history remains in the coordinator ledger; no reset. |
| **Provisional next loop 9** | One new integration pass after the supplied estimate; exact global ordinal requires coordinator reconciliation | Integrate 42 upstream commits; T/E resolve tooling and evals, preserve cutover/Bonk/container contracts, run frozen install, root/evals tests and build. See current handoff for actual results and remaining owner diagnostics. |

The global cap remains **20 total loops**, including repair cycles. This provisional label is not
an exact-count claim or an approval record. Before another loop or production confirmation, the
coordinator must reconcile the approximately-eight estimate with its actual ledger and account for
this pass once. Independent approval and external cutover evidence are not supplied by T's checks.

Hugin anchor plan, authored for independent review. **Implementation has not started; independent approval is pending.** This authoring task changes only this document. No merge, commit, dependency installation, build, test, or deployment is part of this pass.

Execute the eventual implementation in `/Users/jacob_1/odie-os-polaris-upstream`. Other worktrees, including the dirty main checkout and other agents' work, are outside its write boundary.

Pinned inputs, verified through Git:

| Input | Revision |
| --- | --- |
| Local HEAD and observed `origin/main` | `6a00bd36a3f15cf57810d107f45312ed28fde372` |
| Upstream target | `a591fe32783a09a0d9ac34abe203a30e778345b7` |
| Verified merge base | `1a4bb1777cf5e95fb19a5ab011e90ad7f3ca744b` |

The upstream base-to-target diff covers 674 files. Full alignment means every upstream change receives a recorded disposition: adopt, adapt to preserve local behavior, already equivalent, or explicitly justified exclusion. It does not mean selecting only Git/CodeMirror changes, nor accepting upstream files wholesale over local capabilities. Remaining required alignment cannot be relabeled follow-up to declare completion.

Fresh-main provenance: the user verified fresh main at `6a00bd36`; this revision pass re-resolved local HEAD and `origin/main` to the full SHA above, upstream to its full SHA, and the merge base to the recorded value. No network freshness check is claimed for this revision pass. Immediately before authorized integration, the coordinator must refresh `origin/main`, resolve all full SHAs again, and compare them with these pins. If main moved, stop integration and update the dossier/contracts against the new base rather than silently substituting revisions.

After S0 inventory/contract approval and S1 baseline capture, the coordinator alone begins the integration with `git merge --no-commit --no-ff a591fe32783a09a0d9ac34abe203a30e778345b7` in this worktree. First inventory and protect existing changes, including this untracked plan; never clean, reset or overwrite them to make the merge proceed. Conflict resolution follows the ownership table below, with no simultaneous coordinator/lane writes. This command is a future execution step, not performed by plan authoring. Never commit without an explicit user request. The eventual authorized merge commit must retain both parents and establish ancestry from the pinned upstream; until then, report an uncommitted integration, not completed merge ancestry.

### Success criteria

1. Integrate the complete pinned upstream feature and infrastructure delta, retaining the local capability/security/product contracts below.
2. Adopt upstream Git-backed committed code, revisioned OT pending changes, worktree capabilities, and CodeMirror Workshop editing with tested legacy migration.
3. Same-workspace transport reconnect and React Activity hide/reveal preserve user input, selection, editor state, and the running gadget iframe where its document remains valid. Terminal/session reconnect must not restart a sandbox or silently resubmit an action.
4. Improve ordinary Code Sessions with a bounded **read-only structured Changes/diff surface**, using CodeMirror where appropriate. Browser VS Code and xterm remain supported. General writable Files is explicitly outside the initial integration: it needs a separately designed authorized filesystem API.
5. Run pre/post Munin outcome checks, complete `pnpm lint`, `pnpm build`, and `pnpm test`, and close actionable Skuld findings. Report actual evidence, never inherited test counts or invented performance gains.

## 1. Research dossier

### Method and provenance

Read `/Users/jacob_1/opencode-agentic-commands/src/hugin.mjs` and the sibling `polaris.mjs`, `eitri.mjs`, `munin.mjs`, and `skuld.mjs`. Hugin requires a source dossier, ADR, story DAG, verification matrix, and independent feasibility review. Polaris supplies the full plan → profiles → research → implementation → review loop, capped at 20 orchestration loops. This document instantiates those semantics; it does not claim plugin execution or implementation completion.

Commands run from the target worktree included:

```sh
git status --short
git rev-parse HEAD origin/main
git merge-base 6a00bd36 a591fe32
git diff --stat 1a4bb177 a591fe32
git show a591fe32:packages/workshop-backend/src/git-migration.ts
git show a591fe32:packages/workshop-backend/src/worktree-binding.d.ts
git show a591fe32:packages/workshop-frontend/src/CodeEditor.tsx
git show a591fe32:packages/workshop-frontend/src/otClient.ts
git show a591fe32:packages/bundled-blueprints/README.md
git diff 1a4bb177 a591fe32 -- packages/workshop-backend/wrangler.jsonc
```

Targeted `git grep` at the pinned revisions and local file reads supplied the anchors below. Initial status was clean. No fetch changed the observed pins. This is targeted architectural discovery, not a line-by-line audit of all 674 files; S0 closes the inventory before integration. References prefixed **U** mean `a591fe32`; **L** mean `6a00bd36`. Local line numbers are discovery anchors, not post-integration promises.

### Observed source facts

| Surface | Evidence | Consequence |
| --- | --- | --- |
| Committed and pending storage | **U** `packages/workshop-backend/src/git-migration.ts`, `migrateCodeLogToGit`, `convertLegacyChat` | Git synthesis handles committed history and each live chat's non-reverted Yjs changes plus `chatDraftUpdates`. A committed-only migration loses proposals. |
| Migration order | **U** `overseer.ts`, `#migrateToGitStorage`, `#migrateToActionIndexes`, `#migrateToWorkpieceTypes` | Internal workspace schema progresses 1→2→3→4, with asynchronous Git migration protected by `blockConcurrencyWhile`, version written last. These are distinct from Wrangler DO class tags. |
| OT transport | **U** `workshop-frontend/src/otClient.ts`, `ChatOtClient` | One immutable in-flight wire submission plus composed pending changes; `(clientId, seq)` idempotency; `(generation, revision)` replay dedupe; content-preserving and destructive generation changes differ. Stall/hard-rejection paths can discard local edits. |
| Editor | **U** `CodeEditor.tsx`, `EditSession`, `connectSessionRemote` | CodeMirror 6; absent session is read-only; remote transactions skip local submission and undo history; exact LF splitting preserves CR/CRLF offsets; theme/read-only reconfiguration is in place. Document/session identity changes rebuild the view. |
| Worktrees | **U** `worktree-binding.d.ts` | Agent file-tree capability based on a Git commit, file operations, commit-all without staging, textual diff; symlinks/submodules unsupported for editing. It is not an OS process or terminal session. |
| Root lifecycle | **L** `workshop-frontend/src/routes/__root.tsx:98–109` | React `Activity` hides the application while loading. Its effect lifecycle must be exercised, not equated to ordinary CSS hiding. |
| Readiness reset | **L** `GadgetEditor.tsx:1012–1032` | `[id]` effect clears proposals, chat/code readiness, workpieces, and view state. Effect setup can run again on Activity reveal despite unchanged logical identity. |
| Open capability lifecycle | **L** `useWorkspaceOpen.ts:58–178` | Cleanup disposes attempt stubs; published `overseer` state is cleared on terminal errors, but not normal cleanup. Retained state can therefore contain a disposed capability before replacement. |
| Frame bridge | **L** `GadgetUI.tsx:191–245,332–403` | A forwarding target can replace the server stub without replacing the iframe. Handshake effect cleanup resets the MessagePort session; reinstallation only listens for a handshake, and the iframe's bootstrap initially sends one. |
| Session runtime | **L** `workshop-shared/src/coding-sessions.ts:242–348` | Owner-checked lifecycle, generation-bound terminal/editor/OpenCode capabilities, Pi connection, private request-build protocol, and bounded private upload exist. Upload is not a general workspace editor API. |
| Session Changes | **L** `components/sessions/OpenCodeWorkbench.tsx:367,741,875–881` and its tests | `/session/{id}/diff` feeds a text card; the surface points users to browser VS Code for full editing. Tests presently include simple fixture shapes, not proof of a production structured diff schema. |
| Session resume precedent | **L** `OpenCodeWorkbench.tsx:200` | Existing code explicitly distinguishes Activity resume from a different session when retaining local input. Extend that pattern rather than blanket-resetting session state. |
| Local authority | **L** `workshop-backend/src/admin-authority.ts`, `assertCurrent` | Fresh purpose-bound checks are present, including mutation checks. Source comments distinguish independent Context Git credentials, JARVIS reads, and Finance operators. |
| Starter packaging | **L** `workshop-backend/featured-blueprints/README.md` | Exact four-file starters, stable IDs, revision/UTC metadata, deterministic Yjs archive packaging, additive installation, protected Finance exclusion, and Skip suppressing every RPC read. |
| New bundled packaging | **U** `bundled-blueprints/README.md` | Extracted format sources, TS bundling and shared libraries, stable historical `format.*` IDs, `BUNDLED_BLUEPRINTS_DIR` replacing the old env name, and legacy archive-pair input support. External override trees are bundled but not automatically typechecked. |
| DO tag collision | **U** backend Wrangler diff; **L** both backend Wrangler files | Upstream adds `UserDirectoryDurableObject` at `v3`. Local default `v3` already exists; production has an empty `v3`, followed by `v4-community-requests` and `v5-admin-authority`. Existing tags cannot be repurposed. |
| Sessions tags and binding | **L** both Sessions Wrangler files; `gatekeeper-odie-kg/src/index.ts:573,582` | Sessions already has `v6-request-build`; `TOTANGO_KG` is a persisted suggested binding name. Preserve both histories/contracts. |

### Full alignment source map to finish in S0

The observed upstream diff also includes `gatekeeper-kit`, GitHub Git transport/actions, Google Drive/Gmail/native sessions, other gatekeeper conversions, MCP handoff/trust changes, observer authorization and replay, action history pagination, user directory/sharing, OAuth connect handoff, composer decomposition, bundled Docs/Sheets/Slides, typed-storage, integration tests/evals, and toolchain/release/CI changes. Each belongs in the inventory, even when unrelated to editor UX.

Local conflict-sensitive sources to inspect end-to-end before changing them:

- `workshop-shared/src/{api,gatekeeper,admin-authority,coding-sessions,request-build,request-build-publication,pi-backbone}.ts` and Cap'n Web's installed README.
- Backend `overseer.ts`, `agent.ts`, `user.ts`, `server.ts`, `admin-settings.ts`, `admin-authority.ts`, Finance entrypoints/access, native auth, `request-build-publisher.ts` and controller/outbox modules.
- `gatekeeper-context`, `gatekeeper-jarvis`, `gatekeeper-odie-kg`, `gatekeeper-sessions`, `mcp-shared/src/tools.ts`, and native provider gatekeepers.
- Frontend `RpcContext.tsx`, `AuthContext.tsx`, `GadgetEditor.tsx`, `GadgetUI.tsx`, `GadgetCodeInterface.tsx`, `ChatInterface.tsx`, session workbenches/terminal, and their lifecycle tests.
- Both generic and Odie Wrangler configs, `.github/workflows/deploy-production.yml`, Sessions image/publisher workflows, `scripts/release/`, package task configs, root catalog/lockfile, and featured generator/install tests.

Optional AgentDB/Agent Wisdom memory: not available in this pass; skipped. Prior local implementation documents are navigation aids, not evidence that this integration passes their historical checks.

## 2. Assumptions and question ledger

| Item | Classification | Resolution / gate |
| --- | --- | --- |
| Activity reveal causes the reported refresh | Probable mechanism, not runtime-confirmed | S1 records an actual hidden→visible reproduction and separates readiness reset, stale stub, and lost bridge failures. |
| Upstream automatically fixes reconnect loss | Unsupported | Its OT retry semantics are useful, but view disposal and stall rebuild can still lose pending state. S4 must prove ownership across reconnect. |
| Existing runtime diff responses provide before/after text | Unverified | S5 inspects pinned OpenCode SDK/runtime responses and Pi events. No invented schema, cast, or shell-based filesystem workaround. |
| A general writable Files API already exists | Rejected by inspected public service surface | Explicitly deferred. A future API needs owner/generation authorization, path/symlink bounds, byte limits, revision/CAS writes, audit and conflict semantics. |
| Legacy archive inputs remain readable after alignment | Upstream documents pair compatibility; local archive/import path still needs proof | S2/S6 test old exports and starter archives against the integrated reader. |
| Production state matches checked configs | Unknown | S8 requires deployment-history evidence before rollout; never infer installed tags or data volume from source alone. |
| Full upstream alignment requires dropping local features | Rejected | Adapt conflicting changes and document parity; retain current security invariants. |
| New agent configuration is required | No | Existing tools suffice. Eitri profiles below are task assignments, not `.opencode` artifacts. |

No user clarification blocks writing or reviewing this plan. Runtime diff support and production migration evidence are explicit implementation/release gates rather than permission to fabricate facts.

## 3. Architecture decisions

### ADR A — Git for committed content, OT for pending collaboration, CodeMirror for presentation

Adopt the upstream model as one coordinated contract across shared types, storage, agent replay, preview, accept/revert, worktrees, and frontend. Git object/commit identity owns committed content; chat pins plus revisioned `CodeChange` streams own proposals. CodeMirror is an editor/view, not an additional source of truth. Keep Yjs only where the integrated code still needs legacy migration/archive compatibility; do not mechanically remove the dependency.

Reject a partial Git port that retains Yjs as a second live writable authority, a new bespoke CRDT, and an editor-only swap over old storage. They increase divergence and obscure which state wins after reconnect. Preserve promise pipelining and dispose real RPC capabilities; shared API additions require documentation on every export and must derive from real interfaces rather than casted mirrors.

### ADR B — Two complementary meanings of work

Workshop Git worktrees are authorized repository/file-tree capabilities participating in agent observations and reviewed actions. Code Sessions are owner-bound sandbox generations with processes, terminal, browser VS Code, OpenCode/Pi/Prime and development applications. Keep both. Creating or restoring a Workshop worktree does not create a container, give unrestricted shell access, attach another owner's session, or acquire publication credentials.

CodeMirror serves Workshop code/diffs and the ordinary Code Session read-only Changes surface. Keep VS Code for full IDE editing and xterm for terminal interaction. Do not attach the Workshop chat OT client to arbitrary container files.

### ADR C — Reconnect is a transport transition, not document replacement

Own retained presentation state by authenticated principal + workspace/chat/workpiece/file identity (or Code Session ID), separate from replaceable connection epochs. An epoch owns subscriptions and stubs; it never determines whether the user's document is new.

- Guard identity resets with the last logical identity, not effect execution alone. Preserve readiness snapshots for same-identity resume while marking transport unavailable; replace initial subscription snapshots atomically at `ready()`.
- Expose current transport readiness separately from retained metadata. A disposed stub must never remain callable through a consumer just because old UI remains visible. Reject obsolete async callbacks and dispose late resolutions.
- Preserve the OT in-flight immutable payload, client sequence and pending composition through a same-document reconnect. Rebind its delegate to the fresh capability without silently minting a new edit session. Preserve selection, scroll, folds and undo when compatible; never apply remote deltas as local edits.
- Do not solve frame cleanup by leaking stubs or disabling disposal. Prefer keeping the live iframe/MessagePort owner outside transient Activity teardown, with explicit authenticated epoch replacement and cleanup on true identity departure. If that boundary cannot be retained, design a versioned re-handshake that reuses the existing iframe document; prove old-frame compatibility and source-window/opaque-origin checks. Merely adding another listener does not make an old frame resend a port.
- Top-level forwarding cannot revive nested RPC capabilities already held by gadget code. Define and test their failure semantics; do not claim transparent recovery for arbitrary escaped stubs.
- A code invalidation keeps the existing explicit stale/reload affordance. A transient network error must not automatically reload a valid frame and erase form input. Terminal access revocation fails closed and clears privileged live state rather than treating it as retryable transport loss.
- Preserve session composer text, selection and terminal view through transport recovery; reattach only to the authorized current generation. Never replay a terminal command, agent turn, merge, push, or publication simply to recover the UI.

Hard rejection/destructive OT generation changes remain authoritative. Before a rebuild discards unsynchronized edits, retain a bounded recoverable local copy and show an explicit recovery/conflict outcome; never replay erased history automatically. Ordinary reconnect must not enter this path solely because effects restarted. This in-memory preservation contract is distinct from full browser-process crash recovery: unacknowledged data in a closed browser is not claimed durable, and no new persistent draft store is implied.

### ADR D — Session Changes scope

Normalize supported runtime diff responses into a bounded presentation model (path, status, before/after or supported hunks, omission/error reason). Keep runtime schema adapters outside the renderer. Render read-only CodeMirror views with file selection, syntax highlighting, search and accessible diff navigation. Unsupported, binary, oversized and malformed entries receive honest summaries; do not fabricate empty text or treat fetch errors as “no changes.”

Validate actual pinned OpenCode response schemas before implementing its adapter. Reuse Pi/Prime's available structured evidence only where verified; label unavailable evidence explicitly. If existing response data is insufficient, the scoped fallback is a clear read-only unsupported/raw view, with the missing structured feature recorded as unresolved until a reviewed bounded read seam is supplied. General browse/write/rename/delete Files operations and autosave remain outside this initial scope. A private upload endpoint is not that seam.

### ADR E — Coordinated protocol and OAuth cutover

**Enforcement update:** `scripts/build-production-deploy.mjs` emits write-paused production
artifacts, and `.github/workflows/deploy-production.yml` validates a protected operator record
before any provider deployment or secret mutation. Prepare/resume require fresh exact-target
artifact approval; routine releases require a verified resume receipt, ancestry and matching
compatibility fingerprint. See [the cutover runbook](polaris-production-cutover.md) for record schema,
real operator steps, and outstanding external evidence. No production confirmation is supplied;
passing local tests is not readiness. The original normal-unset source config is not authorization
to enable artifact writes.

Current review-ledger entry: **Skuld T P1 — first-cutover deployment bypass**; owner T; repair is the
paused-artifact/approval gate and runbook; local root tests, 17 gate tests, scripts types and scoped
lint pass. Independent reviewer verdict remains pending. This is a repair within the coordinator's
existing Polaris loop, not a new/reset loop sequence. The coordinator's current global ordinal was
not supplied to T: it must be reconciled in the authoritative ledger before release. Confirmation
records require that actual ordinal in **1–20**, and reject >20; no fabricated count or claim of
independent approval is recorded here.

**K/F/C/T must jointly approve a compatibility contract before any dependent lane integrates or any release proceeds.** K owns backend protocol acceptance and migration fences; F owns client mismatch/recovery behavior; C owns provider callbacks and catalog provenance; T owns deployment ordering, supported-version inventory and operator instructions. Freeze the accepted protocol/version combinations, rejection behavior, recovery-export format, callback lifetime rules and mixed-version fixtures as part of S0/S2. Do not assume upstream and fork clients or providers can interoperate.

1. Prepare an explicit coordinated cutover pause: stop admission of new editing/agent work and incompatible OAuth flows, drain or account for in-flight writes and callbacks, retain recovery access, and take the migration snapshot before enabling Git/OT writes. The pause must fence backend writes from existing sockets and agents as well as new requests; hiding controls is insufficient. K/C specify which ongoing operations can finish and which must be safely canceled or expire.
2. Detect old/new protocol mismatch before interpreting or accepting incompatible edit submissions, snapshots or subscriptions. Unknown/unversioned peers must be classified deliberately. A mismatch enters an upgrade-required, write-paused state; **never automatically reload or destroy the document to upgrade**, because unacknowledged edits may exist only in memory.
3. Supply an explicit user-controlled recovery export before a reload or destructive migration boundary. Export unacknowledged editor input, composer input and available pending changes with their source identity/base/revision and acknowledgement status; include a readable text fallback when transformation is unsafe. Exclude credentials and RPC capabilities. Verify that the export can be read and manually recovered without treating uncertain writes as safe to replay. Preserve the page until the user has exported or explicitly discarded input and chosen to reload.
4. Already-deployed old clients may have neither version negotiation nor recovery export. No transparent compatibility or lossless-upgrade guarantee is made for them. Require real pinned old-client recovery/export fixtures, or a proven preparatory compatible release and drain procedure that supplies the recovery path before cutover. **Missing export fixtures or an unproven old-client recovery path blocks release.** Server rejection alone does not rescue browser-only drafts; a timed forced refresh is not an acceptable substitute.
5. Freeze OAuth handoff compatibility across old/new provider Workers, backend, and frontend/native clients. Preserve state/nonce, redirect origin, one-use consumption, expiry and account binding. During the pause, retain the compatible callback consumer until admitted flows complete or expire under their original bounded lifetime; do not extend expiry or reinterpret old state as a new flow. Incompatible or expired flows fail explicitly with a safe fresh-start path after resume, not silent success, duplicate account creation or automatic retry of a consumed code.
6. Catalog observation is part of this contract, not just a type rename. Trace fork-private catalog reads through their existing observation/authorization path and preserve that provenance wherever catalog contents are private. Upstream catalog discovery must not make private catalog content ambient, unobserved or transferable across owners. Preserve the ODIE allowlist and restricted request-build exclusions.
7. Rehearse old client→new backend and new client→old backend, plus old provider→new backend callback and new provider→old backend callback, with both old/new browser/native handoff consumers where supported. For each combination record supported completion or explicit safe rejection, draft export/recovery, expiry/replay behavior, and absence of unauthorized side effects. Only resume admissions after the approved combination is live and migration/recovery checks pass. A provider→backend→frontend order alone is not compatibility evidence.

## 4. Migration and preservation contract

### Yjs → Git/OT data migration

1. Inventory legacy versions, gadget roots, chats, compaction anchors, accepted/reverted messages, outstanding drafts and blueprint pins. Use isolated representative fixtures/copies, never destructive production experimentation.
2. Preserve upstream commit selection: historical merge points, time-gap batches, final state and pinned versions; per-gadget unchanged trees need no duplicate commit. Root permanent gadgets at the empty-tree commit when required.
3. Convert live pending state from anchor Yjs + non-reverted change updates + ordered drafts. Create a conversion boundary even for an empty change. Pin touched permanent gadgets; carry pending creations and their files together, skip other chats' pending gadgets, and recover legacy orphan-root proposals when applicable.
4. Rewrite heads, historical merge commit references, and valid blueprint pins only after referenced Git objects exist. Preserve explicit errors for unresolvable legacy blueprints. Preserve retired update bytes needed by upstream compatibility, while stripping them from normal delivery/replay. Do not delete legacy logs as cleanup in this integration.
5. Test interruption before object completion, between object writes and record rewrite, and before version stamp. Rerun must converge without duplicate boundaries, lost drafts, new orphan gadgets, or changed trees. Verify compaction, accept/revert, export/import, preview and restore after migration.
6. Record semantic inventories before/after: exact file bytes, pending-vs-accepted status, pins and reachable commits, bindings, access roles and blueprint identities. Counts alone do not establish equivalence.
7. Before rollout, secure a restorable snapshot/export and rehearse recovery. Retained Yjs bytes alone are **not** a downgrade strategy after new Git/OT writes. Prefer forward repair; restoring a coordinated pre-migration snapshot requires an explicit write-free window and accounting for all subsequent writes.

### Non-negotiable local preservation gates

| Contract | Required outcome |
| --- | --- |
| Managed administration | Every privileged operation retains fresh purpose-bound current-authority checks, including retained capabilities after revocation. Legacy/prepared static membership remains compatible. |
| Finance | `FINANCE_OPERATORS` with omitted-only exact-`ADMINS` fallback stays independent of managed grant/revoke; owners/direct shares remain valid. Do not claim operator config revokes already-escaped capabilities. Protected Finance starter stays absent from public discovery/download/screenshot/catalog paths. |
| Context/JARVIS | Managed activation still requires two complete matching fresh domain/version/inventory owner-fence scans, recorded atomically. Private resource ownership remains fenced. Context Git credentials retain their separate explicit revocation semantics; public visibility confers reads only. JARVIS value-only reads and current-authority policy writes remain distinct. |
| ODIE KG | Keep owner-only `TOTANGO_KG`, all 15 supported scopes, exact 54-tool catalog (42 observations, 12 connector-owned actions), and deny unknown tools regardless of annotations. |
| Generic MCP | Keep annotation handling at the trust boundary; writes require approval, auto-apply additionally requires vetted endpoints. Keep SDK fetch/redirect SSRF enforcement and tenant separation. |
| Request builds | Trusted publisher independently validates bounded artifacts and freshly authorizes exact persisted publication operations. Restricted runner cannot gain ordinary terminal/editor/catalog access or write credentials. Preserve idempotent attempts, ambiguous-ack reconciliation, budget/cancel/generation fences and cleanup-owned capacity release. Upstream GitHub push actions are not a bypass. |
| Native auth | Preserve native browser flow, router endpoint distinctions, cookies/origins and one-use/expiry behavior while adapting upstream OAuth connect handoff. Do not replace deployment-controlled authentication with admin UI policy. |
| Starters | Stable `starter.*` IDs, revision/UTC updates for archive changes, optional connectors and zero RPC after Skip; additive installer preserves user-featured entries. Formats retain stable `format.*` IDs and remain distinct from starters. |
| Deployment | Preserve all deployed class names, bindings, tag order, image/runtime pins unless an explicit reviewed change requires them. Backend default `v3` (`NativeBrowserFlow`) and production empty `v3` remain historical; append a fresh unique user-directory tag after existing `v5-admin-authority`, rather than copying upstream `v3`. Sessions `v6-request-build` remains after v1–v5. |
| Release safety | Preserve Odie direct deploy and generic release differences, credential-isolated publisher/image workflows, manifest-last promotion and optional private bindings. Generated declarations follow the reconciled config; they cannot define deployment history. |

## 5. Story DAG and Eitri lane profiles

Use existing tools and available agents. No new command, skill, plugin, model service or `.opencode` configuration artifact is needed. Maximum four author lanes; reviewer work is independent and read-only. Each lane reports inputs, file ownership, assumptions, diff and verification evidence, then stops at its boundary. When an interface is missing, request the owning lane's change rather than editing its files.

**Exclusive ownership, applied in this precedence order:**

1. **Generated outputs: coordinator only, after lane handoffs.** This includes generated route trees, bundled modules, worker declarations and other codegen output regardless of package. Lanes author generator inputs and report regeneration commands; coordinator serializes generation on the integrated tree. No lane concurrently regenerates shared outputs.
2. **T owns all package manifests and configuration**, including package-local build/test/compiler/Vite/Wrangler configs, root catalog/lockfiles, root scripts, workflows and all documentation. This rule overrides package source ownership. Explicit exception: backend-owned blueprint generator/import scripts are K-owned, including `packages/workshop-backend/scripts/`; T still owns their package/task wiring. Docs embedded as runtime blueprint/archive inputs follow the runtime owner below rather than the general documentation rule.
3. **K owns backend source/tests and shared source/tests**, `typed-storage` runtime/tests, backend blueprint generator/import scripts and backend blueprint installers/readers. K also owns backend featured/format archive inputs and integration-tests/evals runtime source/tests. Their manifests/configs remain T-owned. Backend generator scripts are not T root tooling merely because they are scripts.
4. **F owns all frontend source/tests**, including session workbenches, adapters, CodeMirror views, terminal and lifecycle tests; package/config/docs/generated exceptions above apply.
5. **C owns gatekeeper source/tests and `mcp-shared` source/tests**, including existing gatekeeper runtime assets/build helpers outside the configuration exception; package manifests/configs/docs/generated outputs are excluded. C does not own frontend session components.
6. **T explicitly owns the entire new bundled-blueprints runtime, libraries, blueprint sources/archive inputs and tests**, as well as its packaging/tooling. Review its executable behavior, persistence, synchronization, security and import/export correctness as runtime code, not only deterministic build output. Backend installers and generators remain K-owned; their contract is a serialized T→K handoff.
7. **Coordinator assigns every remaining path in S0 before edits**, including router/backend-utils/error-reporting/configurator helpers and any new/unclassified runtime path; there is no implicit catch-all permission. Record the exact owner and review domain in the exhaustive path ledger. Unassigned paths block work on those paths. Package-local instructions must be read before ownership begins.

These rules also govern merge-conflict resolution. The coordinator reserves root/integration operations; lanes may resolve only assigned paths after the coordinator releases them. No API, catalog observation, OAuth handoff or packaging seam crosses lanes without the K/F/C/T compatibility gate in ADR E.

| Story / lane | Inputs and dependencies | Output and likely files | Verification / parallel safety |
| --- | --- | --- | --- |
| **S0 — inventory and contract freeze / coordinator** | Pinned revisions, this plan, independent plan review | Refresh main and verify full SHAs; complete base→upstream and base→local path/feature disposition ledger; API/storage/config conflicts; test-task inventory; exhaustive precedence-based ownership; K/F/C/T protocol, private catalog observation and OAuth cutover contract. | Every upstream path assigned, local-only paths protected; stop on pin drift. S1 baseline precedes the coordinator's no-commit/no-ff pinned merge. Serialized before contract-dependent edits. |
| **S1 — pre-Munin / F + read-only reviewer** | S0; unchanged local runtime or isolated baseline | Reproduce Activity/transport/frame/session behavior; capture expected preservation assertions, fixtures and command/environment ledger. F lifecycle tests and later browser fixture. | Actual baseline outcomes; no speculative “fixed” claim. Parallel with K/T discovery, not concurrent F implementation. |
| **S2 — Git/OT contract and migration / K** | S0, upstream API/storage sources | Shared `api.ts`, `gatekeeper.ts`, `code-change.ts`; Git codec/store/cache/migration, overseer/agent/preview/worktree session and tests. Adapt local authority seams in the same owned files. | Upstream algebra/migration/DO/worktree suites plus local pending-data fixtures and security regressions. Split internal substeps: contract → storage/migration → agent/preview/actions; serialize shared schemas. |
| **S3 — provider alignment / C** | S0; S2 interface freeze (not unfinished casts) | `gatekeeper-kit`, GitHub transport/actions, Google native APIs, remaining gatekeeper deltas and MCP changes; preserve local Context/JARVIS/ODIE/Sessions behavior. | Provider parser/credential/observer/action tests and workerd boundaries; deny unknown tools/egress. C can run beside F/T after contract handoff, with one writer per package. |
| **S4 — Workshop frontend and reconnect / F** | S1 baseline, S2 interface freeze | CodeMirror, OT client, code/diff/ChatInterface, composer, Activity/history/sharing/connect handoff; `GadgetEditor`, `useWorkspaceOpen`, `GadgetUI`, root/auth/RPC lifecycle. | Outcome matrix below, OT lost-ack/generation tests and real Activity/iframe browser journey. Single F owner prevents reset fixes being overwritten by upstream UI adoption. |
| **S5 — Code Session read-only Changes / F, C handoff if needed** | S4 ownership release; S3 for any provider seam | Verified runtime schema adapter and reusable read-only diff view in session workbenches; existing VS Code/terminal entrypoints retained. Any necessary bounded read protocol goes through K then C before F. | Realistic schema fixtures, malformed/binary/oversize behavior, same-session input retention, owner/generation checks. Serial with S4; writable Files excluded. |
| **S6 — tooling and blueprint packaging / T → K handoff** | S0; frozen K packaging/API contract | Full upstream tooling/CI/release/test infrastructure, bundled TS formats/libraries. K adapts featured generator/install/export readers; T migrates override docs/env tests and manifests. | Deterministic archives, stable IDs, old archive import, external override mutation invalidates output; Skip call-count and Finance exclusion tests. No concurrent K backend edits; schedule the integration handoff after S2. |
| **S7 — semantic integration / coordinator + owners** | S2–S6 completed, full disposition ledger and K/F/C/T cutover approval | Resolve cross-lane behavior and remaining upstream/local deltas; user directory/sharing/observed catalogs, OAuth/native auth, deployment tags and release wiring. Coordinator alone regenerates outputs after lane handoffs. Preserve the pending merge without committing. | Full path coverage; authenticated RPC and bidirectional mixed-version journeys, export/recovery fixtures, local security matrix, all new suites selected. Shared/root integration and codegen serialized. |
| **S8 — post-Munin, broad checks, Skuld / independent reviewers** | S7 exact candidate | Before/after ledger, lint/build/test evidence, migration rehearsal and deploy-order/rollback review, repaired findings. | Required outcomes all pass; review every kernel/shared line. Repairs return to the owner and trigger affected checks plus final exact-tree broad gates. No approval from author lane. |

Dependency summary:

```text
independent plan review → S0 → S1 ──────────→ S4 → S5 ─┐
                           └→ S2 contract → S3 ──────┤
                              S2 implementation ────┤→ S7 → S8
                         S0 → S6 T work → K handoff ─┘
```

S6 can prepare T-owned infrastructure while K implements S2; it cannot simultaneously edit backend generators/installers. S3 and S4 may proceed against a frozen reviewed contract while K finishes implementation, but cannot be integrated before its tests pass. All lanes use exact candidate refs/patch provenance and never operate in the main worktree. Commits/PRs, when subsequently authorized, should isolate kernel/shared concerns from frontend, connectors and tooling; this plan does not create them.

## 6. Verification and Munin protocol

Run Munin semantics **before and after** changes using repository outcome tests, not its unrelated default `train.py`/`val_bpb` workflow. Freeze fixture inputs, runtime/browser versions, command and observation method before comparing. Maintain: hypothesis, permitted files, baseline command/result, candidate command/result, logs, keep/revise/discard decision. Baselines are not measured in this authoring pass.

| Area | Required observable outcome |
| --- | --- |
| Activity hide/reveal | Same identity keeps chat/workpiece/file, composer text, editor selection/scroll/undo, readiness snapshot and iframe document identity; subscription set becomes live once. New workspace clears prior state and ignores late callbacks. |
| Transport loss | Break socket before submit, after server acceptance/before ack, and during resubscription. Pending content converges exactly once without duplicate actions; stale stubs never dispatch; reconnect affordance clears only after current readiness. |
| Protocol cutover | Old client→new backend and new client→old backend detect mismatches before incompatible writes. No automatic reload or input loss; real old/new export fixtures recover unacknowledged editor/composer input. Paused admission also fences old sockets/agents. Missing old-client export evidence blocks release. |
| OAuth/catalog compatibility | Old provider→new backend and new provider→old backend callbacks, with supported old/new browser/native consumers, either complete under the frozen contract or fail safely. Test in-flight cutover, expiry, replay, lost callback acknowledgement and one-use state without duplicate account creation. Fork-private catalogs retain authorized observation provenance and owner isolation. |
| Frame bridge | Form input and frame boot identity survive recoverable disconnect; top-level RPC works after recovery; wrong-window/null-origin spoof rejected; pending handshake and late stub disposal tested. Nested-stub limitation is visible rather than hidden by a reload. |
| OT/CodeMirror | Concurrent edits, replay order/duplicates, missing row/ack, merge epoch bridge, destructive revert, agent-running rejection, CRLF/Unicode and file removal preserve correct bytes and undo semantics. Recovery copy appears before unavoidable local discard. |
| Migration | Accepted code and outstanding drafts/proposals survive; multiple chats/compaction/pending creations/orphans/empty roots/deleted gadget blueprint pins tested; interrupted reruns converge; restore/export/import works. |
| Authorization | Retained admin stub after revoke denied; Finance/operator rules unchanged; Context/JARVIS owner fences enforced; other-owner sessions/current-generation spoof denied; ODIE unknown tool rejected; MCP unvetted write cannot auto-apply. |
| Request-build separation | Interactive attach cannot access restricted run; runner cannot publish; fresh publisher authority, cancellation races, ambiguous write ack and cleanup capacity retain their contracts after Git integration. |
| Session UX | OpenCode/Pi/Prime supported diffs render honestly; unsupported shapes and empty/error states differ; read-only view cannot mutate files; VS Code and xterm remain reachable and composer/terminal recovery does not replay input. |
| Packaging/deploy | Identical inputs yield identical bytes; old and extracted archives instantiate; external input edits are seen; stable format/starter IDs and Finance exclusion survive; Skip causes zero connector RPC calls; config tags append safely. |
| Full alignment | Every upstream disposition backed by source and a check; observer scope/restart, OAuth handoff, provider migration, action history, sharing, integration harness/evals and CI changes are covered beyond editor-specific tests. |

Prefer deterministic assertions (file equality, duplicate submission count, iframe boot count, denied operations, resource disposal) over arbitrary performance targets. For perceived refresh/performance claims, record measured traces or timings on the same scenario and environment; no made-up reduction percentages or borrowed historical suite counts. A browser mock alone does not prove a real MessagePort, workerd migration, or authenticated facade boundary.

Implementation checks, after task wiring is reconciled:

```sh
# Focused package checks use the actual package's declared test:run/config.
pnpm --filter @gadgets/workshop-frontend test:run
pnpm --filter @gadgets/workshop-backend test:run
# Final required repository gates, each with its own recorded exit/result:
pnpm lint
pnpm build
pnpm test
```

Inspect package task configs first: local specialized authority/request-build tests may not be included by a direct `test:run`. Include them explicitly and prove root `pnpm test` selects new suites. Run real workerd projects with their environment guard, preserve bounded concurrency, and investigate hangs/exit 137 instead of treating silence as success. CI test/eval tasks that require credentials have an explicit unmet gate until executed in their proper environment. Do not weaken assertions, remove required suites, or alter the baseline workload to obtain green results.

## 7. Risks, review and rollout gates

| Risk | Mitigation and owner |
| --- | --- |
| Upstream overwrites current local authorization | K/C trace each privileged entrypoint to current check; independent security reviewer tests retained capabilities, not only UI visibility. |
| Migration silently loses unaccepted work | K runs semantic pending-state fixtures and interruption rehearsal before candidate rollout. |
| Activity cleanup destroys frame/editor transport | F isolates logical identity from transport/effect lifetime; S1/S4 browser assertions prove preservation. |
| Blind OT retry or discard duplicates/losses | K/F preserve exact wire idempotency; distinguish destructive generations and retain explicit recoverable draft evidence. |
| Broad dependency changes hide missing tests | T inventories all tasks, compiler/runtime pins and compatibility flags; S8 records exact-tree checks and cache provenance. |
| Blueprint rename/environment switch drops local starters | T/K adapt both format and starter pipelines, document override mapping and archive compatibility; assert stable IDs and additive discovery. |
| Historical migration tag collision | T/K append a new unique user-directory tag only after checking both deployment histories; never rewrite `v3`. |
| Workspace scope creep into container Files | F/K enforce read-only session diff boundary; future writes require a separate API/security ADR. |
| Unsafe downgrade after Git writes | K/operator rehearse snapshot restoration or forward repair; do not assert old binaries can consume new state. |

Review gates:

1. **Anchor:** independent reviewer checks facts versus inferences, complete upstream coverage, migration strategy, bounded session scope and lane disjointness. This file is ready for that review, not self-approved.
2. **Contract/migration:** K/F/C/T jointly approve protocol mismatch behavior, recovery/export fixtures, coordinated pause and mixed OAuth callback expiry compatibility, private catalog observations, shared APIs, commit/OT invariants and pending Yjs conversion before dependent integration. Review every kernel/shared changed line and T-owned bundled runtime behavior.
3. **Lane review:** narrow outcome tests and preserved local contracts accompany each handoff. Reviewers do not author their own fixes; findings return to lane owners.
4. **Final Skuld:** inspect exact final diff and broad evidence, repair confirmed findings, rerun affected checks, and re-review. Use at most 10 review iterations per Skuld invocation and **at most 20 total Polaris orchestration loops**, including repair cycles; never reset the global counter to evade the limit. At the cap, report remaining findings and evidence as blocked, not complete.
5. **Release readiness:** full candidate verification and ADR E's coordinated pause/drain/recovery rehearsal precede rollout. Provider→backend→frontend sequencing is allowed only where the mixed-version contract proves compatibility; retain old callback consumers through admitted-flow completion/expiry. Inspect actual generic/Odie bindings, native auth origins, DO history, archive generation and source/image correspondence. Missing old-client recovery/export fixtures block release. Resume live writes only after migration, compatibility and recovery gates pass. Deployment itself requires its own authorized execution; this document performs none. Merge ancestry is established only by a later explicitly authorized commit, never by claiming an uncommitted merge is finished.

Record each loop's target, finding, owner, repair, commands/results and reviewer verdict. If a reviewer agent is unavailable, use an available reviewer or explicitly record the manual fallback; never invent independent approval. Finish only when inventory, implementation, outcome tests and final review agree there is no remaining required work, or report a concrete blocker.

## Recommended handoff

Independent review target: `docs/polaris-upstream-integration.md`, pinned against local `6a00bd36` and upstream `a591fe32`. After approval and implementation authorization, start:

```text
/tyr Execute S0 and S1 of docs/polaris-upstream-integration.md in /Users/jacob_1/odie-os-polaris-upstream; preserve pinned sources and exclusive lane ownership, inventory the full upstream delta, and capture pre-Munin outcomes before implementation. Continue through the dependency DAG under Polaris semantics, with a global limit of 20 loops.
```
