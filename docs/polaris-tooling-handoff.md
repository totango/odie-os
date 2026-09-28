# Polaris tooling lane handoff — 2026-09-15

Worktree: `/Users/jacob_1/odie-os-polaris-upstream`.

## Skuld T P1 — production first-cutover gate

Implemented paused-by-default production artifacts and a fail-closed deployment approval gate
before provider/secret mutations. Manual prepare remains paused; resume requires fresh exact-target
completion evidence; automatic routine releases require a successful resume receipt, ancestry,
and identical compatibility/gate-source fingerprint. The schema requires real K/F/C/T review IDs,
old-client and recovery-client pins, hashed evidence references, and the actual coordinator loop
ordinal within 1–20. No success record or readiness evidence is committed.

Files: `.github/workflows/deploy-production.yml`, `scripts/build-production-deploy.mjs`, new
`scripts/production-cutover.mjs`, its root tests, env-policy expectation, and the new operator runbook
`docs/polaris-production-cutover.md`. The source backend config remains normally unset, while the
artifact builder forces pause. Only successful evidence validation can remove it from an artifact.

Checks: 17 cutover/artifact/schema/workflow tests pass; complete direct root scripts tests pass;
scripts types and scoped lint pass. Tests cover missing evidence, first-cutover expiry, target/hash
mismatch, artifact tampering, absent independent review/client pins, phase separation, and routine
ancestry/resume-receipt requirements. These tests are synthetic fixtures, not operational evidence.

External blockers remain: actual old-backend/socket/agent and OAuth admission fence, completed drain,
restorable snapshot and restore rehearsal, pinned old-client export or deployed preparatory recovery
release, mixed browser/native/provider OAuth matrix, migration/catalog/deployed-version verification,
protected GitHub environment review policy, and real prepare/completion/resume records. Gate prevents
the first deployment without those attestations; it cannot independently prove linked evidence true.
Coordinator must reconcile its existing global loop count (not supplied to T); this remediation does
not reset or invent it. Independent Skuld approval remains pending. No deploy, secret/resource mutation,
commit, or new full runtime test run was performed. K owns the integration-protocol test repairs.

## Root-test repair and full test attempt — current result

Resolved the two root-tooling failures reported by the coordinator:

- Removed obsolete `CONTINUITY_URL` and `PLAYWRIGHT_MODULE` entries from the env-policy expectation
  after F removed the duplicate standalone Chromium fixture. `CONTINUITY_BROWSER_CHANNEL` remains.
- Reproduced the trusted-launcher failure: a Vite+ automatically tracked task reinserts
  `DYLD_INSERT_LIBRARIES` into a child even when invoked through `/usr/bin/env -i` with an explicit
  clean environment. The diagnostic printed only environment key names, not values. The probe's
  `PROXY_ENV_UNSAFE` rejection is therefore correct; the same test passes directly outside tracking.
- Removed the temporary diagnostic task. Added a mandatory, watchdogged, `cache: false`
  `test:trusted-launcher` prerequisite to the scripts test task. The prerequisite runs the existing
  launcher test unchanged; the cached task runs the other tests. Both selectors share the exact
  test name. Production launcher/proxy/security code and its assertions were not modified or relaxed.

Verification:

- `pnpm exec vp run --cache -F @gadgets/scripts test`: **354 passed** (one uncached launcher test
  plus 353 in the cached task), zero failures. Both task paths executed rather than replaying cache.
- `pnpm types:scripts`, scoped lint, and diff checks: passed.
- `VP_RUN_CONCURRENCY_LIMIT=2 pnpm test`: **exit 1**, completed rather than timing out.
  Root tooling passed again (353 replayed, launcher rerun). Error-reporting 23, bundled-blueprints
  285, typed-storage 56, and router 19 tests passed; configurator-ui declares no tests.
- Integration-tests: **33 failed, 40 passed, 8 failed files / 5 passed files**. All 33 failures
  report `EDITING_PROTOCOL_UPGRADE_REQUIRED`. The task runner then terminated the concurrent
  frontend test task (exit 137), so that is not evidence of a frontend assertion failure or a
  completed frontend suite. Later packages were not reached. `vp run --last-details` reports
  17 tasks, four cache hits, two failed tasks (integration exit 1, frontend exit 137).

Exact integration failures to coordinator/K (all under `packages/integration-tests/__tests__/`):

| Suite | Failing tests |
| --- | ---: |
| `external-message-verification.test.ts` | 2 |
| `observer-reverification.test.ts` | 7 |
| `observer-role-scope.test.ts` | 4 |
| `sensitive-observations.test.ts` | 12 |
| `workshop-blueprints.test.ts` | 2 |
| `workshop-lifecycle.test.ts` | 3 |
| `workshop-presence.test.ts` | 1 |
| `workshop-sharing.test.ts` | 2 |

The two agent suites pass and their shared `src/agent-session.ts:361` explicitly negotiates
`WORKSHOP_EDITING_PROTOCOL`. The failing suites open workspaces directly (examples:
`workshop-presence.test.ts:50`, `workshop-lifecycle.test.ts:39,74,97`,
`observer-reverification.test.ts:143`, `observer-role-scope.test.ts:82`,
`sensitive-observations.test.ts:101`) and need contract-aware fixture review. No protocol guard
was bypassed and no integration/runtime implementation was edited in this tooling-only pass.

Process check after completion (`pgrep -fl 'vitest|scripts/vp/run.ts|with-timeout'`) found no matching
active test/task/watchdog processes. No duplicate full run was started. Changes in this pass are
the two root tooling files and this handoff only; no commit or deployment.

## Latest-main merge T pass — current status

Inputs verified: HEAD `6e77d8ef553da4c996d8d5b080f01dcfadcb2cf1`, MERGE_HEAD
`aa485877389515479426b6e346582244da536d5a`, merge base
`6a00bd36a3f15cf57810d107f45312ed28fde372`. These supersede the previous exact-tree green status
below; the active latest-main merge is not committed. The anchor document now records this refresh.

### Resolutions and inspection

- Frontend manifest keeps `@gadgets/scripts`, router-plugin `^1.168.35`, and newly added
  `@playwright/test` pinned at `1.58.2`; `test:browser:continuity` is retained alongside Vitest.
- Lockfile combines both importer entries and retains the existing dependency graph plus all new
  Playwright package/snapshot references (`playwright`, `playwright-core`, Darwin `fsevents@2.3.2`).
  No unrelated version refresh was needed.
- Backend Vitest combines `workerLoaders.LOADER` and new `r2Buckets: ['BLUEPRINT_CONTENT']`, keeping
  both the upstream gadget-execution suites and latest-main attachment storage fixtures. Existing
  NativeBrowserFlow/UserDirectory namespace and text-module configuration remain intact.
- Preserved the separate Chromium continuity CI job, pinned dependency install, failure artifacts,
  and all three browser suites. The `*.pw.ts` naming keeps them outside Vitest discovery.
- Inspected auto-merged configurator readiness: initialization waits on readiness, discards old
  generation results, reacquires/disposes bootstrap capabilities, and rejects collection before
  initialization. Only initial read-only bootstrap retries; normal UI actions do not. Precise
  missing-method fallback is allowed only on the first readiness probe.
- Updated the root configurator test host to implement the readiness contract. Added execution
  tests against the generated bootstrap for stale-generation discard/reacquisition, initial legacy
  fallback, authority rejection, and refusal to downgrade an established protocol.
- Env policy retains external `CONTINUITY_BROWSER_CHANNEL` and also classifies `CONTINUITY_URL` /
  `PLAYWRIGHT_MODULE` from the existing standalone `src/features/workspace/continuity.chromium.mjs`
  browser harness as external. None is a production build input.

### Verification and remaining dependency

- `pnpm install --frozen-lockfile`: passed; 38 projects, four packages reused/added, no downloads;
  supply-chain checks passed.
- `node --test --test-reporter=dot 'scripts/**/*.test.ts'`: passed after readiness/env fixes.
- `pnpm types:scripts`: passed.
- Scoped lint of changed root tooling, backend Vitest, and browser configs: passed.
- `pnpm --filter @gadgets/workshop-frontend exec playwright test --config browser/playwright.config.ts --list`:
  passed, **12 tests in three files**. Discovery is not browser execution.
- Scoped whitespace check: passed.

Broad build is deferred until F finishes runtime conflict resolution, as requested. Last marker
scan still found F-owned `GadgetEditor.tsx` (first marker 541), `GatekeeperModal.tsx` (2),
`GadgetUI.integration.test.tsx` (611), `useActions.test.tsx` (2), and
`useWorkspaceOpen.test.tsx` (4). K's shared `api.ts` marker scan was already clear. Run
`VP_RUN_CONCURRENCY_LIMIT=2 pnpm build` once runtime owners release the tree; do not inherit the
previous pass's green build as evidence for this merge.

Only verified T-owned resolutions/tooling/doc updates are staged by this pass. No new broad
generated-output rewrite, commit, push, or deployment was performed.

## Third T pass — current status: requested checks green

This section supersedes the outstanding diagnostics in the earlier passes below.

- Added `TEST_NATIVE_BROWSER_FLOW` / `NativeBrowserFlow` to the authority declaration fixture's
  namespace and test-only migration, and to the actual workerd fixture in `vitest.config.ts`.
- Regenerated `__tests__/admin-authority-configuration.d.ts` with Wrangler 4.131.2. The authority
  program now recognizes the namespace at the reported `server.ts:80` / `user.ts:3347` sites.
- Confirmed `WORKSHOP_EDITING_PAUSED?: string` already exists in K-owned `src/env.d.ts` and the
  implementation pauses only for the exact string `"true"`. Added comments in both generic and
  Odie production Wrangler configs documenting the deployment-owned cutover gate. The variable
  remains **unset** in checked-in deployment configuration for normal operation; no runtime or
  administrator-policy changes were made.

Final commands and results for this pass:

| Command | Result |
| --- | --- |
| `pnpm exec wrangler types --config=__tests__/wrangler.admin-authority.jsonc __tests__/admin-authority-configuration.d.ts` (backend directory) | Exit 0; generated namespace includes NativeBrowserFlow. |
| `pnpm exec tsc --noEmit -p tsconfig.admin-authority-tests.json` (backend directory) | Exit 0; no remaining authority-type diagnostics. |
| `pnpm lint:check` | Exit 0; warnings only, no lint errors. |
| `pnpm types:scripts` | Exit 0. |
| `VP_RUN_CONCURRENCY_LIMIT=2 pnpm build` | Exit 0; 96 tasks completed, 53 cache hits (55%), no failures. Backend/browser, Sessions/canary, Google test types, frontend assets and the remaining package build tasks completed. |

The root lint script's three underlying gates (lint check, scripts types, and the build aliased by
`types:check`) all passed. Nonfatal output remains: configured lint warnings, frontend mixed
static/dynamic-import and large-chunk warnings, and capnweb-validate's package-boundary skip notices
(15 external files for Sessions, 32 for ODIE KG). No remaining compiler/lint errors need assignment
to K/F/C from this pass. This is build/type/lint evidence, not a new full unit/integration-test run.

No dependency installation or lockfile edit was needed in this pass. No staging, merge, commit,
push, or deployment was performed; latest-main integration remains a later coordinator operation.

## Second T pass — default generation authorized

This section supersedes the first pass's generator/format blockers below. K has supplied the
default-input merger; its tests now prove all five local support IDs/bytes are retained.

### Repairs

- Added `@gadgets/gatekeeper-kit: workspace:*` to Jira and Zendesk. Updated the lockfile offline;
  its only new changes are those two workspace links. `pnpm install --frozen-lockfile --offline`
  then passed. No registry download was needed.
- Set `rootDir: "../.."` in JARVIS and ODIE KG to cover their imported workspace source; removed
  obsolete emit-only `outDir`, `declaration`, and `sourceMap` options from these no-emit programs.
  Both pass direct `tsc` without command-line root overrides, and their package builds passed.
- Added `TEST_USER_DIRECTORY` / `UserDirectoryDurableObject` to the authority fixture Wrangler
  config and regenerated `__tests__/admin-authority-configuration.d.ts` with installed Wrangler
  4.131.2. The fixture date now matches `vitest.config.ts` (2026-09-04). The requested namespace
  TS2339 errors in `server.ts` / `user.ts` are gone. The generated runtime declaration refresh is
  sizeable; it was produced by Wrangler rather than hand-edited.
- Wired `node --test 'scripts/*.test.ts'` into the backend Vite+ `test` task and direct `test:run`.
  `bundled-blueprint-inputs.test.ts` passes both tests (eight default formats and empty-override
  replacement semantics).
- Removed DOM from Zendesk's Worker/test type program. Its collision with Workers' `SubtleCrypto`
  caused `gatekeeper-kit/src/connect-nonce.ts:46` to report missing `timingSafeEqual`; Zendesk's
  subsequent package type check passed.

### Generated and verified

- Default bundled module: **8 formats**, including all five local support formats.
- Retained format/featured module: **5 legacy formats + 5 featured starters**.
- Configurator prerequisites completed for all 16 configurator gatekeepers.
- Browser-runtime generation and its browser TypeScript program passed.
- Root tooling tests (`node --test --test-reporter=dot 'scripts/**/*.test.ts'`) and
  `pnpm types:scripts` passed after these changes.
- Frontend TypeScript and production asset build passed. Vite reported nonfatal mixed
  static/dynamic imports for `passwordHash.ts` and `CodeEditor.tsx`, plus the existing large-chunk
  warning.
- Targeted JARVIS, ODIE KG, Jira, GitHub, and Work Items package builds passed. Other package checks
  ran during the workspace attempts below; no whole-workspace success is claimed.
- Targeted lint and diff whitespace checks passed.

### Build attempts and exact outstanding owner diagnostics

`pnpm build` initially failed in Zendesk's types, fixed above. Vite+ also terminated in-flight
tasks with exit 137 after the failure; those terminations are not independent compiler diagnostics.
`VP_RUN_CONCURRENCY_LIMIT=2 pnpm build` then failed on Sessions. An additional build excluding
Sessions/backend reached Google's test-type failures. Direct checks reconfirmed the following:

| Owner | File and location | Current diagnostic |
| --- | --- | --- |
| C | `packages/gatekeeper-sessions/src/github-org.ts:326:14` | TS2420: `GitHubOrganizationAccount` lacks required `GatekeeperUser.commitReconnect`. |
| C | `packages/gatekeeper-google/__tests__/worker.ts:21:7`, `:76:54` | TS2420 / TS2741: `TestApprovalQueue` lacks `ApprovalQueue.getSessionSurface`. |
| C | `packages/gatekeeper-google/__tests__/workerd/native-sessions.test.ts:25:7`, `:135:9` | TS2420 / TS2322: the other `TestApprovalQueue` lacks `getSessionSurface`. |
| C | `packages/gatekeeper-google/__tests__/workerd/native-sessions.test.ts:187:29`, `:187:46` | TS2352 / TS2344: read-only sheet stub cast to `RpcStub<GoogleSpreadsheetSession>` lacks write methods, and that interface does not satisfy `Stubable`. |
| K | `packages/workshop-backend/__tests__/test-worker.ts:27:10` | TS2722 under `tsconfig.admin-authority-tests.json`: invocation of possibly undefined `[restore]` method. |
| K | `packages/workshop-backend/__tests__/test-worker.ts:73:5` | TS2741 under the same config: `FakeGatekeeperAccount.describe()` lacks required `AccountDescription.avatar`. |

The ordinary backend `tsc --noEmit` passed. An earlier authority-type attempt additionally saw
native-flow API mismatches in `server.ts`; the final recheck no longer reports those, so they are
not current blockers. No runtime/test implementation files were edited for the diagnostics above.

Commands for owners to reproduce the remaining diagnostics from their package directories:

```sh
# gatekeeper-sessions
pnpm exec tsc --noEmit
# gatekeeper-google
pnpm exec tsc --noEmit -p tsconfig.test.json
# workshop-backend
pnpm exec tsc --noEmit -p tsconfig.admin-authority-tests.json
```

No files were staged by this pass; existing staged work was preserved. No commit, push, deployment,
or unrelated runtime edits were made. Full build is still blocked on the owner fixes above.

## First T pass (historical)

This pass continued the existing partial tooling integration. It did not commit, push, deploy,
resolve another lane's index entries, or regenerate coordinator-owned Worker/route/blueprint outputs.
Root tooling tests generate their fixtures in temporary directories as designed.

## Changes in this pass

- `packages/workshop-backend/vite.config.ts`: restored an uncached
  `build:featured-blueprints` prerequisite for `build`, `test`, and `build:integration-worker`.
  The retained `scripts/build-format-blueprints.mjs` produces the
  `generated/format-blueprints.ts` module still imported for `FEATURED_BLUEPRINTS`.
- `packages/workshop-backend/package.json`: restored the same prerequisite on the direct
  `test:integration`, `test:run`, and `test:watch` routes.
- `packages/integration-tests/src/worker-inputs.ts`: included external
  `FEATURED_BLUEPRINTS_DIR` inputs in watch roots, rerun globs, and deletion detection.
- Updated its existing unit tests and `scripts/env-passthrough.test.ts`; added
  `scripts/integration-worker-inputs.test.ts` to exercise both external blueprint overrides in
  isolated processes, including neighboring-directory rejection.

The existing reconciled manifests, configuration, Wrangler migration histories, release golden,
integration harness, and bundled-blueprint sources were retained. No remaining conflict markers
were found in manifests/JSONC, YAML/workflows, configuration files, root scripts, integration-tests,
or bundled-blueprints. Other lanes still have unmerged Git index entries; that is distinct from
literal markers remaining in a working file.

## Verification

| Command | Result |
| --- | --- |
| `pnpm install --no-frozen-lockfile` | Exit 0; 38 workspace projects, already up to date, pnpm 11.17.0. No lockfile change from this pass. |
| `node --test 'scripts/**/*.test.ts'` | 351 passed, zero failed/skipped after watcher changes. |
| `pnpm exec vp run -F @gadgets/scripts --no-cache test` | Final root-tooling run after prerequisite wiring: 351 passed, zero failed/skipped; watchdog and workspace task route exercised. |
| `pnpm types:scripts` | Exit 0. |
| `pnpm exec tsc --noEmit -p packages/integration-tests/tsconfig.json` | Exit 0. |
| `pnpm --filter @gadgets/bundled-blueprints test:run` | 19 files, 285 tests passed. |
| `pnpm exec vp run -F @gadgets/bundled-blueprints build` | Exit 0; all five type-check programs replayed cache hits, not fresh compiler runs. |
| `pnpm exec vitest run --config vite.config.ts __tests__/worker-inputs.test.ts __tests__/network-interceptor.test.ts __tests__/mock-model.test.ts` from `packages/integration-tests` | Three pure Node suites, 33 tests passed. This uses the task-only config to omit Worker global setup; it is not an end-to-end Worker result. |
| `pnpm exec vp lint scripts packages/integration-tests packages/bundled-blueprints` | Exit 0; four existing warnings (one shadowed name, three function-scoping warnings). |
| Targeted lint of changed TypeScript and backend task config | Exit 0, no diagnostics. |
| Scoped `git diff --check` | Exit 0. |

The install encountered no network blocker. Its up-to-date result is not proof of a fresh registry
download. Installation ownership is released after this pass.

## Exact remaining handoffs

### K: legacy local formats and generator resolution

`packages/workshop-backend/scripts/build-format-blueprints.mjs` remains a modify/delete conflict
in the index. Its current working copy is needed by the featured-starter wiring above. If K extracts
or renames it, update the task command and direct test routes together with its output imports.

The new `scripts/build-bundled-blueprints.ts` defaults to the three upstream formats in
`@gadgets/bundled-blueprints`. The current `src/bundled-blueprints.ts` installer iterates
`BUNDLED_BLUEPRINTS`, while these five local archive/sidecar pairs remain only under backend-owned
`format-blueprints/`:

- `format.support.customer-impact-brief`
- `format.support.engineering-escalation`
- `format.support.handoff`
- `format.support.incident-rca-summary`
- `format.support.weekly-digest`

Running the retained generator also emits them as legacy `FORMAT_BLUEPRINTS`, but the current new
installer does not consume that list. K must integrate these inputs into the authoritative bundled
set with stable IDs (and preserve explicit override semantics). Merely restoring featured generation
does not resolve this format-preservation blocker. The archives and backend generator/installer
source were outside this pass's ownership.

### Coordinator: integrated verification and code generation

Run serialized output generation after the runtime lanes hand off, then full workerd/integration
tests and repository lint/build/test. This pass did not run the integration prebuild because it
regenerates coordinator-owned default artifacts; the pure harness results above do not replace it.
Regeneration includes `pnpm types:generate` and backend blueprint/browser-runtime/validated-worker
prerequisites, with package UI and frontend route generation as required by the final tree.

The existing migration-history/golden tests passed, including the distinct backend histories with
appended `v6-user-directory` and retained Sessions `v6-request-build`. This is source verification,
not evidence of deployed history or mixed-version cutover safety.

No independent reviewer tool was available in this session. A separate manual diff inspection was
performed after authoring, with the checks above; independent lane approval remains outstanding.
