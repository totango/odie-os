# Gate pass — critic and verification evidence

**Latest gate correction:** [Finance operator separation](finance-operator-separation.md) supersedes Finance guard/descendant-drain requirements below. Finance is not managed authority. Actual Context/JARVIS legacy-child/token drain remains blocked; fresh build/typecheck failures are open. Prior release artifacts are stale after notifier/Finance edits, and no source review or local fixture result authorizes activation/deploy.

## Review method

This was a separate **self-critic pass in the same Pi session**, not an independent subagent approval. No implementation diff exists to review. Reviewed source claims, private/public boundaries, actor/capability lifetime, data/dispatch atomicity, retries, migration/rollback, and story authority. Earlier independent draft review remains in `review.md`; do not mislabel it as review of these newer ADRs.

## Concrete findings repaired

| Finding | Evidence | Repair in planning documents |
|---|---|---|
| Zero path overlap mistaken for portability | Fork has no `otClient.ts`; Google resource/test stack differs/absent | Defer OT/Google direct picks; only recommend scheduler patch after parent-blob comparison. |
| Scheduler title suggested a production fix | Complete U1 diff touches two `__tests__` files only | Corrected scope to test-harness reliability; keep source/config unchanged. |
| Stale upstream matrix | Acquired one newer commit `08afe059…` | Updated 441/82, 604 changed paths, 94 overlaps; inspected final ShareModal diff rather than lengthy reverted commit-message experiments. |
| Admin inventory incomplete | JARVIS `JarvisPolicyApi` captures a boolean; Finance `#financeRole` elevates to `build` | Added both to C1 retained-capability/child-capability tests and rollout blockers. |
| Owner belief differs from repo bootstrap config | Production Wrangler lists four admins | No auto-removal. Require live preview/explicit membership approval; source is not deployment evidence. |
| Env union could regrant revoked admins | Existing static `ADMINS` versus proposed dynamic state | Bootstrap once, retained generation tombstones, no automatic union/fallback, rollback cannot resurrect grants. |
| Regrant could reactivate old capability | Boolean-only permission or current-membership check | Every retained admin capability binds grant generation; regrant increments it. |
| Per-method check overstated immediate revocation | Distributed operation may pass check before revoke | Define post-commit admission guarantee; already-admitted/in-flight effects may complete. Legacy capability drain required for activation. |
| Ordinary Code Session can publish before guard | `CodingSessionSandbox.enableInternet=true`; contents-write GitHub proxy token | Restricted request-build mode with read-only clone credentials; trusted publisher alone has write authority. |
| Retrying random-ID session creation can duplicate builds | `createSession()` generates UUID on each call | Atomic private dispatch-key reservation before normal lifecycle startup. |
| Durable callback assumed without restart-safe authority | Existing API has no build callback | Choose service-binding receipt polling driven by persisted alarm work; browser is display only. |
| Lost exec acknowledgment could duplicate processes | No verified SDK idempotency option | Reconcile exact attempt or stop/destroy ambiguous generation before explicit new attempt. No blind second launch. |
| Run success conflated with Slack delivery/deployment | External MCP dedupe not proven | Separate outbox/ambiguous notification state; `pr_created` means draft PR only. |
| Strict privacy claim could imply perfect secret detection | Public user-authored text itself may contain sensitive content | Explicit public labels/moderation, no raw sidecar ingestion for MVP; scanner is defense in depth, not a proof. |

## Executed verification

- Git repository/root, `HEAD`, branch/status and empty tracked/index diffs checked before document edits.
- Independent clone acquisition explicitly approved, succeeded; `--bare --no-hardlinks`, upstream fetched into `refs/research/upstream-main` only in `/tmp/odie-hugin-gates.6MfTWT/research.git`.
- `merge-base`, `rev-list`, `log`, `diff-tree`, `diff --name-only/--stat`, `show`, `ls-tree`, and `rev-parse` compared exact commit/path/blob evidence; U1 parent blobs equal fork blobs.
- Package JSON scripts read directly; backend/Context/Scheduler real-Workers config and Sessions mocked-Workers config inspected. No test command executed.
- Repo-wide bounded searches for `isAdmin`, `adminOnly`, `ADMINS`, Finance role/revocation and Sessions create/start/policy paths; scoped file reads cited in ADRs.
- Cap'n Web README read in full. Cloudflare DO alarm/storage docs retrieved: [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) are at-least-once with finite automatic retries and a single alarm per DO; [transactionSync](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync) is synchronous and rolls back on throw. ADRs avoid network I/O in transactions and independent alarms that overwrite lifecycle work.
- Final documentation validation: 11 Markdown files checked, 16 relative links resolve, 7 referenced package scripts exist, fences balanced. Initial check found missing final newlines in three inherited reports (`review.md`, `feedback.md`, `automation.md`); repaired by appending a newline, with prose unchanged, then rechecked.
- Final scope checks: HEAD stays `248cc75eda989d5ddc93507518a0bf284065e93f`; original `upstream/main` stays `45ae8c21b4b6b30ca81f69fc1f65db1f42a89278`; tracked and staged diffs empty. Clone has neither an alternate object store nor a linked-worktree `commondir`. `git status --short` shows only `.oculus/`, `.pi/`, `docs/plans/` as untracked.

Exploratory command errors were non-mutating and repaired: one regex lost its escaped parenthesis; one ignored `node_modules` search found no SDK type files until rerun with `--no-ignore -L`; guessed `Dockerfile` path was absent and replaced by discovered `Dockerfile.pi`. These are research errors, not passing tests or infrastructure failures of a delegated lane (none was launched).

## Future runtime verification — all NOT RUN

| Story | Exact command or deliverable | Coverage |
|---|---|---|
| U1 baseline/post-patch | `pnpm --filter @gadgets/gatekeeper-scheduler test:run` | Workerd disposal lifecycle and scheduler app suite |
| U1 type/build | `pnpm exec vp run -F @gadgets/gatekeeper-scheduler build` | Preserve fork build/task behavior |
| C2 backend | `pnpm --filter @gadgets/workshop-backend test:run` | Includes codegen, unit workerd and integration project; add authority/Finance cases |
| C2 Context | `pnpm --filter @gadgets/gatekeeper-context test:run` | Bundled-context generation plus workerd and Node tests; add retained-capability checks |
| C2/H JARVIS | `pnpm --filter @gadgets/gatekeeper-jarvis test` | Retained policy capability and notifier transport policy |
| H Sessions | `pnpm --filter @gadgets/gatekeeper-sessions test` | Existing mocked unit suite plus new pure protocol tests |
| H true runtime | New real-Workers multi-service harness with `remoteBindings: false` and `scripts/assert-workerd.ts` | Lost ack, restart, generation, service-only trust and cleanup/capacity checks; mocked Sessions tests alone insufficient |
| Shared | `pnpm --filter @gadgets/workshop-shared build` | Existing `tsc` script; documented public contracts |
| Frontend | `pnpm --filter @gadgets/workshop-frontend test:run` | Admin UI, second-user request-run projection, no capability leakage |
| Whole repo before merge | `pnpm lint`, `pnpm build`, `pnpm test` | CI parity; do not run against this planning-only scope |

No Wrangler deployment/dry-run, production queries, credential minting or Slack verification performed. Docker digest compatibility must be checked against the pinned runtime before any future Sandbox changes; this pass did not build the image.

## PR/readiness verdict

Planning-documents review only. A's acquisition and C1/H0 technical decisions have concrete artifacts, but candidate selection, bootstrap/cutover, numeric policy, external delivery contract, actual implementation and runtime validation still require their stated authority/gates. Do not claim an implementation PR is ready or any functional tests passed.
