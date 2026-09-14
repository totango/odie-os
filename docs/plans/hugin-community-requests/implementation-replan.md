# Implementation replan: implementation first, activation gated

## Current owner direction (supersedes historical ordering below)

Finish the missing implementation before further native/type investigation. The [implementation-first addendum](implementation-first-addendum.md) records the supervisor-approved legacy/prepared/managed transition, private server-owned readiness contract, compatibility behavior, exact stage scopes and tests.

```text
retained reviewed board + U1 + runtime patch
  -> AdminAuthority + known privileged paths + admin UI
  -> restricted Sessions protocol/runner
  -> durable backend builds + trusted PR
  -> Slack outbox/notifier + run UI
  -> fresh review/repair + protected verification

unproven Finance guard + legacy drain -> separate managed activation gate
```

Implement and wire production entrypoints now, without speculative Finance transport wiring, mock production providers or an admin-controlled cutover boolean. Missing real Finance/drain evidence keeps transition and Auto-Build admission closed. Effective grant/revoke is managed-only; legacy/prepared modes preserve the four static admins and do not claim revocation. Provider-first compatibility retains the old boolean path only as explicitly unfenced legacy authority; new backend must use the capability-aware protocol and never downgrade on failure. Native research is paused. The documentation checkpoint passed review. The subsequent [authority-core source slice](authority-core-implementation.md) passed the supplied second independent review. The [administrator UI](admin-management-ui-implementation.md) is implemented and locally tested, pending its independent review; downstream Sessions/Auto-Build/PR/Slack source remains pending.

The following sections are chronological history, not the current implementation dependency DAG. Their test failures and safety evidence remain valid; statements requiring more native research before *any* implementation are superseded, not resolved.

## Historical explicit owner decision

After the C2 prototype blocked, the owner requested **both** (1) a narrowly scoped, tested RPC compatibility fix/alternative-boundary investigation and (2) delivering the board first using existing admin checks while dynamic admins/Auto-Build remain deferred. This reorders the original DAG; it does not authorize a partial revocation guard, real external actions, or silently abandoning the remaining features.

## Current state

Branch `feat/community-requests`, baseline HEAD `248cc75eda989d5ddc93507518a0bf284065e93f`. U1 exact two-file scheduler test patch is implemented, tested and independently approved. C2 production changes are absent. Five isolated prototype files reproduce a native pass-back failure and incomplete stream/disposal evidence; preserve them as reproducible evidence, not a shipping authority implementation.

## Revised DAG

```text
U1 -> board backend/types/privacy/tests -> board frontend/new bugs/tests -> board review/fixes
  \-> RPC compatibility source investigation (read-only, independent)
board complete + compatibility diagnosis -> narrow compatibility repair/prototype tests -> review
passing full boundary evidence -> resume C2 -> admin UI -> Auto-Build/Slack -> final e2e review
```

This wave delivers and verifies the board, and separately investigates/repairs compatibility where evidence supports it. It does not automatically restart production C2 after a partial prototype pass; that remains a parent review gate. If compatibility still blocks, retain the independently usable board rather than discard or falsely report the whole goal complete.

## Architecture for board-first

Use existing authenticated account identity and static admin capability checks for moderation, without adding dynamic grants or claiming immediate static-admin revocation. The board is enabled by default for signed-in deployment users, independent of Code Sessions/GitHub/SSO domain/admin status. Features and **new** authored public bug summaries share list/detail/votes/comments/search/related suggestions. No import of historical private reports, operational Reporter events, raw diagnostics or personal session content. Additive registry DO and documented RPC types, idempotent writes, bounded input/pagination/rate limits, admin moderation, safe rendering and privacy tests.

Do not automatically enqueue the legacy PR bot when creating a public board request. Auto-Build may appear only as a truthful unavailable control explaining pending setup/authority work, never a fake successful call or placeholder production runner. Preserve old owner-only feedback status retrieval. If adding a new public bug entry point, do not leave a confusing parallel modal which secretly auto-builds a user-authored public report.

## Compatibility scope

Initial investigation is read-only and may run concurrently with the sole board writer; no package installs, tests, dependency edits or writing shared files while that writer runs. After board work, one writer may repair a demonstrated dependency interop defect using a minimal reproducible, reviewable pnpm patch (or a supported local alternative), without an unrelated version upgrade. Do not hand-edit ignored node_modules as the only durable fix; preserve pinned dependency identity and pnpm reproducibility. No private protocol-hook workaround, casts, removal of legitimate pass-back coverage, global unhandled-error suppression, or unbounded queue expansion. Full real-Workers prototype evidence (nested native refs, callbacks, parent disposal, map, streams, HTTP/WS, generation, outage and cleanup) remains required before authority wiring.

## Verification and authority

Run narrow real-workerd backend tests and frontend jsdom/build checks for board, then independent security/correctness review and fixes. Broad build/lint/test as feasible after both writer stages, report prototype-specific failures separately. Preserve U1, existing .oculus/.pi files and all unrelated source. No commits/push/merge/deploy/provider writes. Update IMPLEMENTATION-TODO with actual milestones/evidence. Follow all repo skills and RPC/logging/security constraints.

## Verification-driven sequencing refinement

During D/E, the board's real HTTP-batch signed-out denial asserted correctly but produced a separate unhandled server future in Cap'n Web 0.12.0. Supervisor explicitly authorized moving the diagnosed minimal same-version pnpm compatibility repair into the sole board writer stage, before frontend. This is not C2 authority wiring: preserve the denied-wire test and native pass-back controls, patch no protocols or versions, and leave full authority containment/stream/disposal verification to the later RPC stage. Later work must reuse—not overwrite—the reviewed patch. Board delivery remains independent of dynamic-admin completion.

Conservative board UI contract approved at this boundary: plain authored public title/body/details, no names/emails/account IDs (only `isOwn` and viewer vote/count), no evidence sidecar, durable bounded-key retries, fixed account quotas, explicit static-admin hidden reads/moderation. See shared `community-requests.ts` for limits; debounce suggestions and do not poll aggressively.

The advanced compatibility work is now locally implemented as two narrow runtime hunks in the
same-version pnpm patch (native import RpcStub semantics; observation of a private synthetic
rejected promise while returning the same rejection). Board + compatibility + existing auth/Finance
regressions pass in real workerd, and the isolated deliberately unobserved OUTER caller diagnostic
still exits 1. See `patches/README.md` and writer-exit TODO evidence. This is pending independent
review, not proof of C2 containment or a replacement for later full RPC/stream/disposal validation.

## Board frontend delivery boundary

The supplied independent backend/dependency review passed the board gate. F/G board frontend is now
locally implemented and verified, pending its independent review: default-visible authenticated
routes/sidebar, public feature/new-bug preview and consent, votes/details/search/related suggestions,
static-admin moderation, and owner-private legacy status retrieval. Board participation bypasses
onboarding/connector/billing setup without making the route anonymous-public. The old feedback modal
no longer submits to the legacy PR bot. Auto-Build is explicitly unavailable; no dynamic admin panel,
C2 guard, runner, Slack action or live change is claimed. See `IMPLEMENTATION-TODO.md` for actual
commands/results and the frontend community-requests README for retry/lifecycle/privacy limits.

## Board integration verification boundary

Supplied independent backend and frontend reviews both passed. Follow-up local journey verification
repaired board discoverability when onboarding or required-connector setup replaces the sidebar:
both now offer board links without changing setup completion or connector policy. Real-workerd HTTP
batch coverage now spans new public bugs, another account's participation, and static-admin moderation.
The board milestone is independently usable in source/local fixtures, without C2/dynamic admins or
Auto-Build; this is not live rollout or full-goal completion. Final frontend suite: 80 files/661 passed;
backend board + compatibility: 2 files/13 passed; relevant builds/shared and test-source typechecks pass.
Root `pnpm lint:check` is **not green**: eight unused `lifetime` bindings in the preserved, isolated C2
prototype fail lint. Board-scoped lint passes. The prototype and dependencies remain unchanged, and
its supplied runtime failures remain unresolved. See TODO for exact evidence and residual gates;
independent review of these final navigation/test edits remains required.

## RPC repair verification boundary — containment remains blocked

The supplied board-verify-review PASS is retained. The sole RPC writer reused the reviewed pnpm
patch unchanged, repaired test-only native disposal accounting and paced/flood stream fixtures,
and expanded bidirectional/native-promise/WebSocket/missing-authority controls. Full prototype:
19 assertions pass but **exit 1, three unhandled native stream errors**; direct-native observed
`pipeTo` destination failure reproduces without Cap'n Web. Explicit prototype tsc also fails
public native argument mappings/inference (six TS2345 plus one TS7006), not shipped-code tsc.
No third speculative dependency fix or production authority was added. C2 stays blocked.

Root `pnpm build` and full `pnpm lint` now pass (existing warnings retained). Root test script
half passes 189 tests; the first attempt to pass a concurrency flag through `pnpm test` failed
Vitest option routing before package tests. Supervisor-approved corrected equivalent package
half (`vp run --concurrency-limit 2 --filter '!cloudflare-os' --cache test`) passes all 31 tasks:
264 files / 3180 passed / 7 existing skipped. The original failed invocation is not relabeled
passed. Default suites still exclude the explicitly failing authority/outer-caller diagnostics.
See TODO and the authority-prototype README for exact logs/gaps. Independent review of these
isolated fixture/docs changes remains required; no live rollout, dynamic-admin or full-goal pass.
