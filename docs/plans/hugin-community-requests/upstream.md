# Hugin anchor: upstream integration + public requests/bugs

## OWNER DECISIONS — supersede open questions

Source: `/Users/jacob_1/.pi/agent/sessions/--Users-jacob_1-odie-os--/subagent-artifacts/outputs/81fdc8b5-9bb7-46f0-ae8d-e29e6d4d6f07/owner-decisions.md`. Verbatim contents:

```markdown
# Owner decisions for Hugin anchor

These explicit user answers supersede the original research questions. Planning only; no implementation authorized.

- Public means **signed-in users of this deployment**, not anonymous internet readers.
- **Only admins may start Auto-Build.** User adds requirement: **a way to manage admins**, since currently Jacob is the only admin (jacob.beck@heyodie.ai / jacob.beck@totango.com). Research existing ADMINS/auth architecture before designing. These supplied emails are not proof of account linkage or authority. Plan stable verified identity handling, bootstrap safety, last-admin safeguards, audit, and effective revocation of already-minted admin capabilities. Keep authorization separate from soft AdminConfig unless justified explicitly.
- “Existing Code Session” means **reuse the Code Session system**; a dedicated per-build session is acceptable. No requirement to reuse a caller's currently open session.
- **Only new bug submissions become public summaries.** All historical private reports remain private; no backfill or automatic publication. Raw diagnostics remain private.

Add admin-management research, story dependencies and tests to the anchor before considering it handoff-ready. Slack destination/repo configuration can be evidenced from existing code and treated as deployment approval gates if not confirmed.
```

Planning impact:
- Audience is authenticated deployment users only; do not plan anonymous/public-internet access for MVP.
- Auto-Build is admin-only; plan an admin-management research/design story before implementation, including auth/bootstrap/revocation and tests.
- “Existing Code Session” means reuse the Code Session system; dedicated per-build sessions are acceptable.
- Only new bug submissions get public summaries; historical private reports remain private.


## Scope and state

Observation:
- Initial HEAD verified as `248cc75eda989d5ddc93507518a0bf284065e93f` on `main`; `origin/main` is the same SHA.
- `git status --short --branch` showed `* main...origin/main` and only untracked `.oculus/` and `.pi/`; I did not edit project/source/config files and did not fetch, merge, commit, push, install, build, or test.
- Remotes: `origin git@github.com:totango/odie-os.git`; `upstream https://github.com/cloudflare/cloudflare-os.git`.
- Local upstream tracking is stale relative to network: local `upstream/main=45ae8c21b4b6b30ca81f69fc1f65db1f42a89278`; `git ls-remote upstream HEAD refs/heads/main` returned `08afe059f1b9ee37129e0327cde43782870fbb76`; `git cat-file -e 08afe059...^{commit}` reported absent. Findings below cover only local upstream objects through `45ae8c21` unless explicitly marked `ls-remote`.
- Merge base: `git merge-base HEAD upstream/main` = `1a4bb1777cf5e95fb19a5ab011e90ad7f3ca744b`; `git rev-list --left-right --count HEAD...upstream/main` = `441 81`.

Tooling notes:
- Project skill load before domain research: read `.agents/skills/write-gatekeeper/SKILL.md`; it is gatekeeper-specific prior art, not directly a request-board implementation skill.
- Hugin convention found in `packages/gatekeeper-sessions/pi-image/node_modules/@howlerops/valhalla/pi/prompts/hugin.md:1-30` and `packages/gatekeeper-sessions/pi-image/node_modules/@howlerops/valhalla/src/hugin.mjs:3-54`: Hugin is a verified dependency-aware plan, no code edits, source dossier, observation/inference/question split, DAG, risks, verification, review gates. No `.omx/plans/*.md` existed (`find .omx -maxdepth 4 -type f` only found `.omx/tmux-hook.json`).
- Non-blocking command errors: one ad-hoc summary command timed out before output and was rerun successfully with a longer timeout; one malformed `git log --all-match=false` was replaced by simpler grep loops. No repo state changed.

Commands run (read-only unless writing this artifact): `git rev-parse`, `git status`, `git remote -v`, `git log`, `git show-ref`, `git branch -r -v`, `git merge-base`, `git rev-list`, `git diff --stat/name-only`, `git diff-tree`, `git ls-remote`, `git cat-file -e`, `grep`, `find`, `nl -ba`, file reads.

## Commit/message style detected

Observation from `git log -30 --pretty=format:'%h %s'`:
- Language: English.
- Format: mixed GitHub merge commits plus semantic lowercase prefixes for direct commits (`fix:`, `feat:`, `test:`, `chore:`, `perf:`). Future commits should use semantic lowercase direct commit subjects unless creating a merge commit.

## Current architecture dossier

### Product feedback / bug automation exists, but is private and owner-scoped

Observation:
- Shared public API types currently model product feedback as `ProductFeedbackKind = "bug" | "feedback"`; submissions include title/description, explicit evidence consent, untrusted context hints, optional current-tab diagnostics, and a per-user automation status with states `queued|running|no-safe-fix|pr-created|failed` (`packages/workshop-shared/src/product-feedback.ts:12-89`). Validation sanitizes credentials/URLs and bounds fields (`packages/workshop-shared/src/product-feedback.ts:109-140`).
- Authenticated API has only owner-scoped product feedback methods: `productFeedbackAvailable`, `submitProductFeedback`, `listProductFeedbackStatuses`, `getProductFeedbackStatus` (`packages/workshop-shared/src/api.ts:940-950`; backend forwards at `packages/workshop-backend/src/server.ts:638-652`).
- Backend currently gates product feedback to eligible Totango SSO accounts/password-disabled policy (`packages/workshop-backend/src/user.ts:1919-1951`). Evidence is private and server re-authorizes workspace/coding-session context (`packages/workshop-backend/src/user.ts:1953-1999`).
- Sessions worker enqueues private evidence and per-owner jobs under `feedback-evidence:*` and `feedback:*`, lists only that owner's registry, and polls/retries from the same registry (`packages/gatekeeper-sessions/src/sessions.ts:2602-2671`).
- Existing automation uses a separate `ProductFeedbackSandbox`, clones `totango/odie-os`, writes private evidence to `/tmp`, runs `opencode`, validates a small diff, pushes `feedback/<id>`, opens a draft PR, then notifies Slack (`packages/gatekeeper-sessions/src/sessions.ts:2690-2829`). This does **not** use an existing user Code Session.
- Safety guardrails reject protected paths, binaries/mode changes, too many files/lines, secret-looking additions, and echoing private evidence (`packages/gatekeeper-sessions/src/product-feedback.ts:10-16`, `92-125`, `128-154`), and PR bodies deliberately omit raw evidence (`packages/gatekeeper-sessions/src/product-feedback.ts:41-64`). Tests cover these guardrails (`packages/gatekeeper-sessions/src/product-feedback.test.ts:11-61`).
- Frontend has a sidebar/floating modal hidden when unavailable; it supports bug vs idea, title/details, consent checkboxes, a required preview, submission, polling, and recent owner statuses with PR links (`packages/workshop-frontend/src/ProductFeedbackButton.tsx:17-70`, `88-145`, `165-218`, `221-234`). Tests cover visibility, rendering, and modal layout (`packages/workshop-frontend/src/ProductFeedbackButton.test.tsx:15-110`).

Inference:
- The requested public request/bug list cannot be implemented by only extending `listProductFeedbackStatuses`; the current storage and API are owner-scoped by construction (`registryFor(... owner.userId)` at `packages/gatekeeper-sessions/src/sessions.ts:3074-3092`).
- Existing private evidence/safe-diff code is reusable for Auto-Build, but the data model needs a separate public record layer so votes/details/related suggestions do not expose private evidence.

### Code Session application previews are scaffolded but dark

Observation:
- `CodingSessionApplicationCapability` is already in the API (`packages/workshop-shared/src/api.ts:716-720`) and can be minted through `AuthenticatedApi.mintCodingSessionApplicationCapability(sessionId, applicationId)` (`packages/workshop-shared/src/api.ts:922-926`; backend delegates at `packages/workshop-backend/src/user.ts:1881-1890`).
- Sessions registry currently rejects application capability minting: `throw new Error("Coding session application previews are not available yet.")` (`packages/gatekeeper-sessions/src/sessions.ts:1328-1333`, delegated at `3057-3064`).
- A disabled/dark relay exists with `APPLICATION_PREVIEW_ENABLED`, cookie-isolation/domain/secret gates, signed capability IDs, ingress header checks, host validation, generation-bound records, and 30-minute max TTL (`packages/gatekeeper-sessions/src/application-preview.ts:8-33`, `112-139`, `532-561`). Wrangler binds `SESSION_APPLICATION_PREVIEWS` and migration `v4` (`packages/gatekeeper-sessions/wrangler.jsonc:44-55`, `82-89`).
- Ingress infra is explicitly undeployed and requires a dedicated non-`*.totango.com` preview domain, no request logging, dark Worker evidence, and external security approval before enabling (`infra/README.md:1-37`, `50-71`, `100-164`, `166-180`).

Inference:
- “Auto-Build uses existing Code Session to build this application feature” should not depend on application-preview URLs unless the separate preview-domain/security gate is satisfied. Existing Code Session execution/PR production can proceed without publicly exposing the app preview.


### Admin auth/management current state (added from owner decisions)

Observation:
- Admin authority is currently env-driven: `AuthenticatedApiImpl.#isAdmin()` reads `env.ADMINS`, accepts either a JSON-array binding or a string that parses to an array, and checks `admins.includes(this.#userId.name)` (`packages/workshop-backend/src/server.ts:374-390`).
- `getAdminApi()` returns `null` unless `#isAdmin()` is true; when true, it mints `AdminApiImpl` with the current `adminUserId` (`packages/workshop-backend/src/server.ts:1138-1169`). The `AdminApi` doc states access is checked when the capability is minted and methods do not re-check (`packages/workshop-shared/src/api.ts:1649-1656`).
- Existing `AdminSettings` is a singleton for deployment settings, mirrors soft config to KV, and explicitly covers branding/agent instructions/gatekeeper/resource settings rather than authentication config (`packages/workshop-backend/src/admin-settings.ts:20-87`; `packages/workshop-shared/src/api.ts:1581-1610`, `1649-1656`).
- Existing admin config is “soft” and does not revoke already-held capabilities; gatekeeper/resource mode docs explicitly say disabling does not revoke existing gadget capabilities (`packages/workshop-shared/src/api.ts:1688-1702`).

Inference:
- Admin management must not be added casually to soft `AdminConfig`: owner decisions require stable verified identity handling, bootstrap safety, last-admin safeguards, audit, and effective revocation of already-minted admin capabilities. Current minted `AdminApi` capabilities do not re-check per method, so effective revocation likely needs either short-lived admin capabilities, per-method revalidation, an admin-generation token checked by `AdminApiImpl`, or forced session invalidation.
- Supplied emails (`jacob.beck@heyodie.ai` / `jacob.beck@totango.com`) are user input and not proof of linked identity. Design must resolve admin records to verified account identities through existing auth identity mechanisms before granting authority.

### Totango fork invariants/customizations to preserve

Observation:
- `AGENTS.md` defines `workshop-backend` and `workshop-shared` as high-review “kernel” surfaces; public API exports need doc comments and small elegant diffs (`AGENTS.md:14-21`).
- Gatekeeper ambience is admin/user configured; a gatekeeper must not assert its own ambience (`AGENTS.md:24-32`).
- Totango-specific gatekeepers and behaviors include Odie KG owner-only ambient singleton (`AGENTS.md:33-34`), Cloudflare Observability safeguards (`AGENTS.md:35-41`), and production JARVIS/Team PI constraints (`docs/team-pi-codex-production-handoff.md:14-24`, `46-56`, `99-124`, `150-185`).
- JARVIS stored gatekeeper capabilities can pin old Worker versions; altering catalog/observation behavior may require reconnecting accounts and has transcript costs (`docs/team-pi-codex-production-handoff.md:187-219`).
- Direct production workflow is Totango-specific, deploying `odie-os-*` workers and checking required secrets; it is not upstream generic release flow (`.github/workflows/deploy-production.yml:1-120`, `121-305`).
- Toolchain: root uses `pnpm@11.17.0`, `vp`, TypeScript 7.0.2 (tsgo), Vite 7.3.6, Wrangler `^4.119.0`; CI runs Node `24.19.0`, setup-vp `v1.17.0`, `pnpm build`, `pnpm test` (`package.json:1-36`; `pnpm-workspace.yaml:1-43`; `.github/workflows/ci.yml:1-82`).

Regression invariants:
1. Do not expose raw feedback/diagnostics/private workspace/coding-session evidence in public list, GitHub PR, Slack, logs, or URLs.
2. Do not make public request create/vote/detail APIs unauthenticated unless the product explicitly accepts spam/PII moderation risk.
3. Do not bypass existing Code Session owner/repository/current-generation authority checks.
4. Do not enable application preview ingress or `APPLICATION_PREVIEW_ENABLED` without the dedicated-domain/security runbook.
5. Preserve Team PI Codex model policy, JARVIS manual-action policy, Odie KG bindings, Jira/Zendesk/Work Items, production secret gates, and direct deploy workflow.
6. Treat upstream textual non-conflict as insufficient; semantic safety requires targeted tests and review.

## Upstream research

Observation:
- Local upstream since merge base is a linear 81-commit range (`git log --reverse --parents --oneline 1a4bb177..upstream/main`).
- Path overlap between fork changes since base and upstream changes since base: 93 exact files (`comm -12 <fork paths> <upstream paths>`). High-overlap areas include `.github` workflows, `AGENTS.md`, docs, `packages/workshop-backend`, `packages/workshop-frontend`, `packages/workshop-shared`, `packages/gatekeeper-github`, `packages/gatekeeper-google`, `packages/gatekeeper-context`, `packages/mcp-shared`, scripts/release, and `pnpm-lock.yaml`.
- Local upstream commits with zero exact path overlap against fork changes were:
  - `be370e13776c` Test the Workshop lifecycle over public RPC (#349)
  - `05d0c82acd5b` Test Workshop sharing and presence (#351)
  - `14117144b740` Test Workshop blueprints and outputs (#352)
  - `ff3f7f1a8439` Fix stale chat metadata rebuild race (#377)
  - `a4e2d64cba28` Fix Google configurator token refresh (#425)
  - `6f43feeb6647` chore: clarify around connect account security (#429)
  - `df04e239ed85` feat: address gatekeeper-kit usability flags (#430)
  - `3dad5e489e5c` Resolve Google Calendar primary alias (#426)
  - `9a7da94fc408` Guide agents to batch Calendar availability (#435)
  - `85facf205b2f` Add a reusable Workshop agent session (#360)
  - `d9741d67571d` Add functional eval scenarios and CI reporting (#362)
  - `00da2d66ff5b` Keep the scheduler hook session alive until its disposers run (#446)
  - `21d3480363ef` Fix eval config startup (#447)
  - `cff8cf5aa9d2` Render selected skills as composer pills (#422)
  - `c0b6f3e52ff0` Add composer skill picker (#423)
  - `54d5d8b0beae` feat(gatekeeper-kit): replayable runs, declared action fences, and a conformance consumer (#460)
  - `94459f2d63c0` integration-tests: check a deleted workspace's listing over a fresh session (#478)

Unknown:
- Remote upstream commits from `45ae8c21` to `08afe059` are not locally inspectable without fetching. Safe acquisition gate: only after approval, fetch into a disposable clone or an explicit integration branch/worktree with clean status; do not fetch into this checkout while the current planning-only constraint remains.

## Candidate / defer / conflict matrix for upstream integration

Textual status is exact path overlap only, not semantic safety.

| Bucket | Commits | Evidence | Dependency closure | Recommendation |
|---|---|---|---|---|
| Candidate after audit: small unrelated frontend/runtime fixes | `ff3f7f1a8439` | touches `packages/workshop-frontend/src/otClient.ts` and its test; zero exact overlap | Appears standalone after upstream `#275` introduced git/OT storage; must verify fork already has compatible `otClient` shape | Manually inspect/apply only if current `otClient` API matches; run targeted frontend tests. |
| Candidate after audit: Google configurator/calendar fixes | `a4e2d64cba28`, `3dad5e489e5c`, `9a7da94fc408` | zero exact overlap for these commits; touches Google configurator/resources | Upstream Google stack had earlier large commits `16f77fd4`, `42269e8e`, `354a0308`, `81f3c573`; fork also changed Google README/source/wrangler | Defer direct cherry-picks; extract minimal hunks only if Odie uses affected Google flows, preserving production wrangler files. |
| Candidate after audit: scheduler hook session retention | `00da2d66ff5b` | zero exact overlap; touches scheduler tests/worker | Depends on current scheduler hook implementation shape | Low priority, but likely separable. Verify with scheduler workerd tests. |
| Candidate test-only/eval infrastructure | `be370e13776c`, `05d0c82acd5b`, `14117144b740`, `85facf205b2f`, `d9741d67571d`, `21d3480363ef`, `94459f2d63c0` | mostly new integration/eval paths; zero exact overlap except internal dependencies | Several depend on upstream-created `packages/workshop-evals`, `agent-session`, and test harness state not present in fork | Defer as a batch; useful after feature request/bug surface exists, but may drag toolchain changes. |
| Defer: composer skill picker/pills | `cff8cf5aa9d2`, `c0b6f3e52ff0` | zero exact overlap because local fork lacks upstream `features/chat/composer/*` structure | Requires prior `ec37b560` and `5491fab4`, which overlap current `ChatInterface`/home composer areas and Totango draft/refresh fixes | Do not cherry-pick now. Reconcile only if adopting upstream composer architecture. |
| Defer: gatekeeper-kit | `0e6aa033`, `df04e239`, `1ec9378f`, `3fbdd862`, `54d5d8b0` | package absent locally; huge new helper package and docs/plans | Interacts with toolchain/package workspace; later gatekeeper commits may assume it | Not relevant to request-board MVP. Defer to a separate gatekeeper modernization plan. |
| Conflict/high-risk: storage/OT/editor migration | `1ef6020a` | 47 paths, 15 exact overlaps, includes `.gitignore`, `AGENTS.md`, backend, frontend, shared, lockfile | Foundational; many later upstream frontend/test commits assume it | Do not integrate wholesale without a dedicated migration branch and semantic regression suite. |
| Conflict/high-risk: shared scripts/toolchain/workspace | `edfe520c`, `87273523`, `115fede1`, `a0fc0966`, dependency bumps `6a6e3c0f`, `d4cc7950`, `0e80e07e`, `cf246711` | exact overlaps in `package.json`, `pnpm-workspace.yaml`, CI/workflows/scripts/lockfile; upstream raises wrangler to `^4.128.0` and setup-vp v1.18.0 | Touches local Vite+/vp conventions and production deploy assumptions | Defer until after product feature; any adoption must include lockfile/toolchain review and CI parity. |
| Conflict/high-risk: connect handoff/OAuth/restricted data | `44f7950a`, `9c1d9c55`, `d0dfc098`, `45ae8c21`, `168be631` | high overlap in docs, shared API/gatekeeper, backend, frontend, mcp-shared | Semantically intersects Totango domain sharing, JARVIS/Odie KG, OAuth email migration, observer/restricted-data model | Security valuable but cannot be “non-conflicting.” Needs a separate security ADR and compatibility tests. |
| Conflict/high-risk but potentially relevant to future Auto-Build | `59a7428e` Ability to pull files from GitHub, edit, and push back (#384) | 61 paths, 16 exact overlaps, gatekeeper-github/backend/frontend/shared/lockfile | Could overlap PR production ideas but uses GitHub gatekeeper authority, not existing Code Session | Do not adopt for this goal unless Auto-Build explicitly changes from Code Session to GitHub-gatekeeper editing. |

## Hugin plan: public feature requests + public bugs + Auto-Build

### Goal restatement
Default-on authenticated request board for all users: public feature requests and bug reports in one list; submit, upvote, add details; suggest duplicates/related items while drafting/submitting; Auto-Build uses an existing Code Session to build the application feature, records run/PR back on the originating request, and posts Slack completion linking the request.

### Architecture decision record

Chosen direction:
1. Add a **public request registry** in `workshop-backend` (new Durable Object is likely appropriate) as the source of truth for public request/bug records, votes, public detail additions, duplicate/related links, admin-management links, and automation links.
2. Keep **private evidence** separate. Reuse current product-feedback sanitization/evidence bundle concepts for optional private bug evidence, but public list records must contain only bounded public title/details/details comments and display-safe automation state.
3. Extend shared API (`workshop-shared/src/api.ts` and product/request shared types) with documented methods roughly: list/search requests, submit request/bug, vote/unvote, add public details, suggest related, start Auto-Build, read request detail.
4. Frontend gets a route such as `/requests` behind the authenticated shell; add sidebar entry and a request detail/draft flow. Owner decision resolves “public” as signed-in users of this deployment, not anonymous internet readers; existing standalone public routes are only `/signup` and `/blueprint/*` (`packages/workshop-frontend/src/routes/__root.tsx:32-39`, `77-91`).
5. Auto-Build is **admin-only** by owner decision. “Existing Code Session” means reuse the Code Session system; a dedicated per-build session is acceptable. Implement as a server-side job constrained to current Code Session authority and request/admin policy, not as the current separate `ProductFeedbackSandbox` path unless deliberately retained as an internal helper.
6. Slack notifier should be extended from fixed PR-only text to include a validated same-origin request URL and run/PR metadata; current text is only `Draft product-feedback PR created: <pr>` (`packages/gatekeeper-jarvis/src/index.ts:108-133`, notifier call path `packages/gatekeeper-sessions/src/sessions.ts:3452-3459`). Slack destination/repo configuration should be treated as deployment approval gates if not confirmed.

Rejected alternatives:
- Store public requests in each user’s `gatekeeper-sessions` registry: cannot list across users without fanout and conflicts with owner-scoped API/storage.
- Use existing product-feedback statuses as the public board: statuses omit votes/details/related links and are intentionally private/owner-scoped.
- Enable application preview ingress as part of MVP: blocked by security/domain gates and unnecessary for linking PR/run.
- Wholesale merge upstream before product work: 93 exact-path overlaps and stale local upstream tip make this unsafe.

### Story DAG

1. **Shared contract/story schema**
   - Inputs: current `ProductFeedback*` types, `AuthenticatedApi` conventions, API doc-comment rules.
   - Outputs: request/bug public types, status enums, related suggestion types, API methods.
   - Likely files: `packages/workshop-shared/src/api.ts`, a new or evolved shared request module.
   - Dependencies: none.
   - Verification: type-check plus API-focused unit tests.
   - Parallel safe: no; contract gates all downstream work.

2. **Admin management research and authority design**
   - Inputs: owner decisions, current `ADMINS` env model, `getAdminApi()` minting, `AdminSettings`/AdminConfig split, auth identity and account-linking mechanisms.
   - Outputs: ADR for admin identity records, bootstrap source of truth, last-admin safeguards, audit trail, revocation semantics for already-minted admin capabilities, and whether managed admins live outside soft AdminConfig.
   - Likely files for eventual implementation: `packages/workshop-shared/src/api.ts`, `packages/workshop-backend/src/server.ts`, `admin-settings.ts` or a new admin-authority module/DO, admin UI routes/components/tests.
   - Dependencies: Story 1. Must complete before Auto-Build authorization or admin UI implementation.
   - Verification: tests for non-admin denial, admin grant/revoke, last-admin refusal, alias/verified-email handling, stale minted `AdminApi` revocation, audit entries, bootstrap from env.
   - Parallel safe: research can run after Story 1; implementation is not parallel-safe with backend registry auth wiring.

3. **Backend public registry**
   - Inputs: shared contract, `AdminSettings`/DO migration patterns, sanitization helpers.
   - Outputs: new registry DO with SQL tables for requests, details, votes, automation links; authenticated methods in `server.ts`/`user.ts`.
   - Likely files: `packages/workshop-backend/src/server.ts`, `user.ts`, new registry module, `wrangler.jsonc` migration, tests.
   - Dependencies: Story 1; admin fields wait on Story 2 if backend registry stores admin-only automation state.
   - Verification: workerd tests for submit/list/vote/detail/idempotency/authorization/redaction.
   - Parallel safe: no with shared contract; yes in parallel with frontend only after mock contract freezes.

4. **Related/duplicate suggestions**
   - Inputs: public registry records.
   - Outputs: deterministic local matching (title/details tokens, kind filters, recent/popular weighting); suggestions during draft and in submit result.
   - Likely files: backend registry module/tests, frontend draft component.
   - Dependencies: Stories 1 and 3.
   - Verification: pure unit tests for ranking; integration test for submit returning suggestions.
   - Parallel safe: yes after registry read API exists.

5. **Frontend request board and detail/draft UI**
   - Inputs: shared API, authenticated shell, existing ProductFeedback modal UI patterns.
   - Outputs: `/requests` route, sidebar nav, list filters, submit form, upvote, add details, related suggestions, bug/feature unified display.
   - Likely files: `packages/workshop-frontend/src/routes/*`, `AppShell`, new components/tests; possibly refactor `ProductFeedbackButton` or replace it.
   - Dependencies: Story 1; can mock backend while Story 2 proceeds.
   - Verification: jsdom tests for list/draft/vote/detail and hidden private evidence.
   - Parallel safe: yes after contract freeze.

6. **Auto-Build job on Code Session system (admin-only)**
   - Inputs: selected request id, admin authority, Code Session system session/dedicated-session policy, current coding session APIs, product feedback PR guardrails.
   - Outputs: admin-only start run, capture run id/activity id, update public request with running/completed/failed state; PR URL from generated change.
   - Likely files: `packages/workshop-backend/src/user.ts`, `packages/gatekeeper-sessions/src/sessions.ts`, `product-feedback.ts` helpers or new automation module, tests.
   - Dependencies: Stories 1-3, especially admin-management revocation semantics; needs explicit design/security review because it changes side-effect authority.
   - Verification: sessions/backend tests for admin-only enforcement, current-generation/session authority, safe diff validation, no private-evidence echo, failure/retry, revoked-admin denial.
   - Parallel safe: no; authority-sensitive.

7. **Slack completion notification**
   - Inputs: request URL, PR URL, run id, current JARVIS notifier.
   - Outputs: validated fixed-template Slack message linking request and PR/run, idempotency key includes request+PR.
   - Likely files: `packages/workshop-shared/src/product-feedback.ts` or new notifier type, `packages/gatekeeper-jarvis/src/index.ts`, `packages/gatekeeper-sessions/src/sessions.ts`, tests.
   - Dependencies: Stories 2, 3, and 6.
   - Verification: pure validation tests for URL/idempotency and notifier test with fixed channel/tool.
   - Parallel safe: after automation link schema freezes.

8. **Migration/compatibility and old product feedback bridge**
   - Inputs: existing owner-scoped product feedback jobs/statuses.
   - Outputs: backward-compatible list for old jobs or one-way display migration policy; UI transition from “Share feedback” to request board.
   - Dependencies: Stories 3-5 and owner decision that only new bugs become public.
   - Verification: existing product-feedback tests updated, no loss of private evidence TTL semantics and no historical publication.
   - Parallel safe: yes after registry and frontend design.

### Execution schedule

1. Do upstream integration only as explicitly selected micro-batches from the matrix above; do not merge upstream/main. First candidate, if any, should be a low-risk standalone fix (`00da2d66` or `ff3f7f1a`) after manual semantic inspection.
2. Freeze shared request-board API (Story 1) and get kernel review before implementation.
3. Research/design admin management auth/bootstrap/revocation (Story 2) before any Auto-Build or admin-management implementation.
4. Implement backend registry and frontend UI in parallel after contract freeze and after admin boundary decisions are known.
5. Serialize admin-only Auto-Build and Slack notifier behind a separate authority/security review.
6. Run full verification only after implementation authority exists. Checks were **not** run in this planning task.

### Verification matrix (future, unrun)

- `pnpm --filter @gadgets/workshop-frontend test:run` for request UI, suggestions, vote/detail behavior.
- `vp run -F @gadgets/workshop-backend test` or direct package test command for registry DO/workerd tests, including admin-management auth/bootstrap/revocation/last-admin/audit cases.
- `pnpm --filter @gadgets/gatekeeper-sessions test:run` plus workerd tests for Auto-Build job and PR guardrails.
- `pnpm --filter @gadgets/gatekeeper-jarvis test:run` for Slack notifier validation.
- `pnpm lint`, `pnpm build`, `pnpm test` before merge; CI uses Node 24.19.0 and setup-vp per `.github/workflows/ci.yml:1-82`.

### Decisions resolved by owner + remaining gates

Resolved by owner decisions (verbatim section at top):
1. Public audience is signed-in users of this deployment, not anonymous internet readers.
2. Only admins may start Auto-Build.
3. Auto-Build may use a dedicated per-build session as long as it reuses the Code Session system.
4. Only new bug submissions become public summaries; historical private reports remain private and raw diagnostics remain private.
5. Add admin management requirement and research existing ADMINS/auth architecture before design.

Remaining approval/research gates:
- Admin management design must settle stable verified identity handling, bootstrap, last-admin safeguards, audit, and effective revocation of minted admin capabilities.
- Slack destination/repo configuration can be evidenced from current code but should be treated as deployment approval gates if not confirmed.
- Application preview ingress remains separately gated by the dedicated-domain/security evidence in `infra/README.md`; it is not part of request-board MVP unless explicitly approved.
