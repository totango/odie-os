# Story A — refreshed upstream selection gate

## Decision and scope

**Research complete; recommend exactly one first micro-batch, pending owner selection and A2 verification. No patches applied.** Other upstream work is deferred, not declared safe. This is not approval to skip A2 or proceed to feature implementation.

The owner explicitly approved an independent temporary clone during this gate-resolution run. Acquisition used a bare clone of the fork with `--no-hardlinks` and then fetched upstream into that clone only; there is no linked worktree, alternate object store, or fetch into the active checkout.

| Evidence | Pinned value |
|---|---|
| Fork HEAD | `248cc75eda989d5ddc93507518a0bf284065e93f` |
| Upstream tip acquired | `08afe059f1b9ee37129e0327cde43782870fbb76` |
| Prior local upstream tip, unchanged | `45ae8c21b4b6b30ca81f69fc1f65db1f42a89278` |
| Common ancestor | `1a4bb1777cf5e95fb19a5ab011e90ad7f3ca744b` |
| Divergence | 441 fork-only / 82 upstream-only commits |
| Upstream changed paths since common ancestor | 604 |
| Exact overlap with fork-changed paths | 94 |
| Independent clone | `/tmp/odie-hugin-gates.6MfTWT/research.git` |
| Clone upstream ref | `refs/research/upstream-main` |

Temporary clone availability is not a durable requirement. Reacquire these exact SHAs in another independent clone if it is removed; never silently advance the pin. Commit dates/remote publication are not test evidence.

## First selected candidate for owner approval: U1

`00da2d66ff5b28c61f4a6c6dd50c783090838239` — Keep the scheduler hook session alive until its disposers run (#446).

Exact write scope in a future A2 patch:
- `packages/gatekeeper-scheduler/__tests__/schedule-driver.test.ts`
- `packages/gatekeeper-scheduler/__tests__/worker.ts`

**Correction to the older dossier:** despite its title, this is a **test-harness change**, not a production scheduler runtime change. It holds a test hook RPC execution context until callback/approval-queue disposers run, bounds the hold with a timer, adds reset-generation fencing for disposal counters, and moves the disposal wait into the test Worker with exact count assertions and timeline diagnostics.

Evidence: inspected the complete `git show` patch. Each fork file's Git blob equals its blob in U1's parent. The scheduler production source differs from that parent only in `src/types.d.ts` documentation; remaining package differences are fork UI, build/test config and production deployment files, none touched by U1. Local `vitest.config.ts` has real `cloudflareTest`, the same `TestHooks` entrypoint and explicit `scripts/assert-workerd.ts` setup. This supports standalone **candidate** status, not a passing test claim.

Dependency closure: the two test files only; no lockfile, package, production Worker, migration, auth, API, or UI changes required by this diff. Preserve local package scripts, workerd assertion, app tests and Odie Wrangler config verbatim. The existing fork toolchain still needs runtime verification; do not import upstream toolchain updates to paper over a failed test.

A2 acceptance after separate implementation authorization:
1. Run baseline scheduler tests on the fork at the recorded SHA and retain failures separately.
2. Apply only U1's two-file patch in an isolated, reviewable integration branch.
3. Run `pnpm --filter @gadgets/gatekeeper-scheduler test:run` (Worker and app suites), then `pnpm exec vp run -F @gadgets/gatekeeper-scheduler build`; review disposal assertions for genuine missing-disposal detection rather than timeout masking.
4. Run full CI-parity verification before merge; one coherent commit with upstream provenance. No automatic merge/push/deploy.
5. Rollback is reverting that single two-file commit; no data migration. Re-audit downstream anchor references against the eventual integration HEAD.

All commands in this acceptance list are **NOT RUN**.

## Candidate/defer matrix

| Group / SHA | Fresh inspection | Decision and dependency rationale |
|---|---|---|
| U1 `00da2d66ff5b…` | Complete patch; both parent blobs match | Recommend first test-only batch above. |
| OT race `ff3f7f1a8439ed79c4408072bfbede6127d63f23` | Both `otClient.ts` and test absent in fork | Defer. Zero overlap concealed an absent upstream architecture; requires the OT/storage migration, not a standalone fix. |
| Google token refresh `a4e2d64cba289eb43ebeb363995618943792bb4c` | Complete patch; `google-configurators.ts` differs; workerd config absent | Defer direct cherry-pick. Assumes token-provider/auth-retry and upstream workerd harness. A separate minimal-port investigation may be valuable, but no port selected now. |
| Calendar primary `3dad5e489e5cc1249b37e8f62cfb7aa60b84533e` | Patch inspected; configurator implementation/types and test harness diverge | Defer. Depends on Google token/configurator stack including prior refresh test; one matching UI file does not establish compatibility. |
| Calendar batching `9a7da94fc408fed455595c61cb1bb03f0ce20b48` | Changed-path/blob comparison; `resources.ts` and its test absent | Defer; cannot treat upstream resource split as local API. |
| Fresh tip `08afe059f1b9ee37129e0327cde43782870fbb76` | Net `ShareModal.tsx` patch inspected and three changed paths enumerated | Defer with restricted-data sharing stack. Removes restricted-data UI blocks under upstream server semantics; do not relax fork UI without matching observer/sharing authorization. The long commit message describes reverted experiments; only the final diff is authoritative. |
| Sharing/OAuth/restricted data: `44f7950a`, `9c1d9c55`, `d0dfc098`, `45ae8c21`, `168be631` | Prior dossier plus fresh range/path inventory | Separate security migration; high-risk kernel and alias/observer overlap. |
| Storage/OT `1ef6020a`; GitHub editing `59a7428e` | Prior dossier plus fresh range/path inventory | Separate architecture migration; not Code Session Auto-Build prerequisites. |
| Composer `cff8cf5aa9d2`, `c0b6f3e52ff0` | Prior dossier plus fresh inventory | Depends on upstream composer extraction; preserve fork editor/chat customizations. |
| Integration/eval and gatekeeper-kit families | Prior dossier plus fresh inventory | Defer entire dependency families; test-only/new-file labels do not remove their architectural dependencies. |
| Toolchain, CI, release and all remaining upstream commits | Full range metadata/path inventory; not every patch semantically reviewed | Deferred by conservative scope, **not** audited-safe. No new blanket merge recommendation. See original `upstream.md` for representative SHAs and fork invariants. |

## Fork invariants and verification boundary

Preserve Code Session owner/repository/generation checks, Team Pi model policy, Odie KG binding names, JARVIS action policy, Finance entitlement, email aliases, restricted-data/observer checks, private diagnostics, direct Odie deployment and Vite+/pnpm/TS7 conventions. Do not enable application previews or alter production secrets/config.

Executed read-only/acquisition commands: git repository/status/index checks; approved `git clone --quiet --bare --no-hardlinks`; clone-only `git fetch --quiet --no-tags <upstream-url> refs/heads/main:refs/research/upstream-main`; `merge-base`, `rev-list`, `log --reverse --format`, `diff --name-only/--stat`, `diff-tree`, `show`, `ls-tree`, and blob identity checks. No `apply`, cherry-pick, merge, build, or test ran.

Remaining owner action: approve U1 as the A2 batch (or request more candidate audits). Selecting U1 does not assert the other 81 changes are unsafe forever or regressions are impossible. Exact-head tests and independent review remain mandatory.
