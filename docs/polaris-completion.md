# Polaris integration handoff

## Status and provenance

The code integration is complete in `/Users/jacob_1/odie-os-polaris-upstream` on
`integration/polaris-upstream`. The final local merge commit is `96797fd2`. Git
ancestry includes fork `origin/main` at `aa485877` and Cloudflare `upstream/main`
at `ef65348f`. Neither the original main worktree nor production was changed.
The branch was pushed and opened as [PR #188](https://github.com/totango/odie-os/pull/188)
after the original integration handoff. Keep this worktree for review; the PR has not been merged.

The **production transition is not complete**. The checked-in deployment gate keeps
the new backend artifact write-paused until an operator records real cutover evidence.
No independent human attestation is required by this fork; agent fanout and PR checks
review the code. See `polaris-production-cutover.md`; do not infer a release
approval from passing local tests.

## Context, decisions and execution

The Hugin source dossier, assumptions, dependency DAG, lane ownership, risks and
verification matrix live in `polaris-upstream-integration.md`. The fork and upstream
were both refreshed during the task. The initial base was `6a00bd36`, upstream
advanced through `a591fe32`, `687aab04` and `ef65348f`, and fork main advanced
to `aa485877`. The initial merge had dozens of API, backend, frontend, connector,
tooling and blueprint conflicts. A locally authorized checkpoint commit made it
possible to bring in the new fork main without touching concurrent work there.

Eitri required no new always-on agent/command/plugin artifacts: existing scoped
agents and the repo's tests covered the implementation lanes. Munin used explicit
before/after outcome checks rather than an invented performance metric: unsaved
iframe state and RPC after Activity/reconnect, OT acknowledgement recovery,
legacy Yjs-to-Git migration, policy persistence, OAuth mixed-version rejection,
build provenance and test results. Earlier failing regressions were repaired and
rerun. The optional AgentDB memory service was not used and no memory was stored.

The implemented architecture adopts upstream Git-backed gadget code, OT pending
changes, CodeMirror and worktree editing, lazy bounded commit reads, typed bundled
blueprints, shared UI and newer agent/integration tests. The legacy Yjs data
migration and fork's five support formats/five featured starters remain covered.
Code sessions retain sandbox execution, xterm and browser VS Code; their new
CodeMirror Changes surface is bounded and read-only. A writable container Files
editor remains outside this integration because it needs conditional saves and
external-change authority semantics.

The reconnect path now keeps the same gadget document through recoverable
connection/Activity cycles, restores RPC with fresh authority, retains pending OT
and CodeMirror state, and offers explicit recovery rather than replaying uncertain
writes. The newer fork main supplied the single lifetime bridge and real Chromium
coverage. Browser tests exercised a 60-second outage, 100 reconnect cycles and
editor continuity. The latest upstream editor and chat-preview changes were
reconciled with those guarantees.

The fork's persisted private-only, restricted-data and domain-policy keys remain
distinct. Its owner-only private approval, Finance/admin/Context/JARVIS fences,
ODIE binding/allowlist, request-build publisher, native flows and production Worker
migration identities remain protected. New owner-invites-only access narrows the
existing policy; private worktree content is filtered from client chat/tool-call
delivery and non-owner commit reads. Native/browser OAuth uses one-use,
protocol-acknowledged handoffs; old persisted flows are rejected before exchange.

Skuld review found and drove repairs for stale capability writes, expired grant
cleanup, native-flow races, an earlier cutover record-validation bug, late attachment
withdrawal, retained worktree tool-call data and private commit IDs, owner-invite
open races, and preview reset gaps. Independent re-reviews found those scoped
paths clean. The last six upstream public-API test commits also received a clean
scoped review. A PR was subsequently opened; no inline PR comments were posted during
the integration work.

## Exact-tree outcome checks

Run from the integration worktree:

| Check | Final result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `VP_RUN_CONCURRENCY_LIMIT=2 pnpm lint` | Passed |
| `VP_RUN_CONCURRENCY_LIMIT=2 pnpm build` | Passed |
| `VP_RUN_CONCURRENCY_LIMIT=2 pnpm test` | Passed after deterministic frontend test repairs; integration package 129 passed and frontend 1,176 passed |
| `CONTINUITY_BROWSER_CHANNEL=chrome pnpm --filter @gadgets/workshop-frontend exec playwright test --config browser/playwright.config.ts` | 14 passed |
| `git diff --check`, ancestry of both refreshed remotes | Passed; the committed code candidate had a clean tree before these handoff-doc edits |

Detailed command logs are under
`/var/folders/5q/r1rw9tjx4pl2phchr2rhc_lm0000gp/T/opencode/`, notably
`polaris-ef65348f-verify-{install,lint,build,browser}.log` and the **passing**
`polaris-post-f-deterministic-full-test.log`. The earlier
`polaris-ef65348f-verify-test.log` failed with three frontend timing cases. The first broad pass surfaced
three frontend timing failures; their test isolation/synchronization was fixed
without changing reconnect behavior or weakening assertions, and the full test
gate then passed. Four backend integration cases are intentionally skipped.

## Release and cleanup gates

Before deployment, operators must supply actual evidence for old-client draft
recovery (or a compatible preparatory release), current-deployment write and OAuth
admission fencing, draining, backup/restore rehearsal, migrated snapshot checks,
mixed-version browser/native completion and deployment receipts. The cutover
validator checks exact artifact identity and evidence references; it cannot prove
that referenced operations occurred. Missing
evidence blocks the production workflow; it is not replaced by this handoff.

No temporary review clone was created. The integration worktree is intentionally
retained for inspection. The original dirty main checkout and the other agents'
worktrees were not cleaned, reset or overwritten. Production, credentials, and
container images were not mutated.
