# Implementation decision record

## Authority and baseline

User explicitly requested end-to-end implementation after the gate-only pass, and confirmed these safeguards:
- U1 is the only upstream batch selected.
- Preserve all four configured admins; no guessed live membership changes.
- Account-scoped votes and grants.
- Auto-Build targets `totango/odie-os` / `main`.
- Auto-Build remains disabled with clear setup reasons until budget, credentials, legacy-capability cutover and Slack prerequisites pass.

Baseline is `248cc75eda989d5ddc93507518a0bf284065e93f`. Pre-existing `.oculus/`, `.pi/`, and planning documents are preserved. Code/tests/docs and local verification are authorized; push, merge, live migrations, deployments, real GitHub PR creation, credential minting and Slack messages are not. Earlier planning-only prohibitions are superseded only for this implementation scope. No persistent goal/token budget created.

## Latest implementation-first direction

The owner now prioritizes missing AdminAuthority/admin UI and restricted Auto-Build/PR/Slack implementation over further native/type research. [Implementation-first addendum](implementation-first-addendum.md) is the current ordering/transition contract, approved by the supervisor before this documentation checkpoint. Implement real integrated components with server-side fail-closed readiness; unresolved Finance guard/drain blocks **managed activation**, not all component implementation. Preserve static deployment behavior until legitimate transition; no effective grant/revoke or Auto-Build admission while managed readiness is absent. The architecture checkpoint was documentation-only. The subsequent [authority-core source slice](authority-core-implementation.md) passed the supplied second independent review. The [administrator UI](admin-management-ui-implementation.md) is implemented and locally tested, pending its independent review; downstream Sessions/Auto-Build/PR/Slack implementation remains open.

## Architecture decisions before source edits

Follow `anchor.md`, `admin-authority-adr.md`, `autobuild-control-plane-adr.md`, `upstream-gate.md` and `gate-decisions.md`; these are the evidence/contract baseline. Use the smallest implementation that satisfies those invariants. Prefer existing capability/lifecycle mechanisms to a second automation framework.

1. Apply U1's exact two scheduler test files only, after baseline verification; preserve local build/config/production sources.
2. Add account-scoped administrative authority separate from soft AdminConfig, preserve configured seed principals, prevent last-admin lockout and stale-generation authority. Cover AdminApi, Context, JARVIS and Finance-derived paths. Leave managed-mode activation safely gated if old capabilities cannot be proven drained; document actionable cutover rather than claim it occurred.
3. Add authenticated deployment-scoped request/bug storage and documented APIs, idempotent votes/comments/submissions, public-only duplicate matching, moderation and private-data separation. New bug submissions only; never backfill diagnostics or operational Reporter events.
4. Add default-visible request list/detail/submit UI and admin management UI. No GitHub or admin prerequisite for reading/submitting/voting. Raw Code Session control links are not public run links.
5. Implement restricted dedicated Code Session Auto-Build, durable dispatch reservation/receipts/recovery and trusted PR publication. All prerequisites enforced server-side. Incomplete prerequisites yield display-safe setup status; a disabled button alone is not authorization enforcement. No fake success, mock backend shipped as production, or placeholder that claims an unimplemented runner exists.
6. Implement durable Slack outbox through private JARVIS notifier with strict URL/payload validation. Receiver idempotency unknown => explicit blocked/ambiguous state, never false exactly-once claim.

## Pinned surfaces and migration/test strategy

- Kernel: `workshop-shared/src/api.ts`, `coding-sessions.ts`, `gatekeeper.ts`, new documented domain types; `workshop-backend/src/server.ts`, `user.ts`, `admin-settings.ts`, `overseer.ts`, new authority/requests/run modules.
- Gatekeepers: Context management capability, JARVIS policy/notifier, Sessions existing registry/policy/Sandbox/GitHub publication helpers. Respect project skills and pinned next Sandbox SDK; no dependency/runtime upgrades unless proven necessary and explicitly raised.
- Frontend: existing admin surfaces, authenticated TanStack routes/sidebar, feedback modal transition, new request/run pages with Kumo and existing UI conventions. Regenerate route tree using existing tooling.
- Additive DO migrations only; preserve differing historical tags in base vs Odie production config, update private bindings/types/release wiring where required. No deployed state mutated. Auth provider/alias/password configuration remains env-only.
- Verify narrowly per story, then shared type checks and package builds/tests. Add true workerd integration evidence for retained capabilities/durable records; Sessions' default Node doubles do not establish it.
- Broad final gates: `pnpm lint`, `pnpm build`, `pnpm test` when feasible; capture exit codes and baseline/environment failures, never mark unrun tests passed. No weakening tests or disabling runtime assertions to obtain green.

## Execution/review structure

One feature branch and one serial source writer at a time. Pi extension-backed children get distinct scoped tasks and durable outputs; no tmux or raw CLI-agent fallback. Fresh read-only reviewer after each stage; repair concrete issues before continuing. Final security and cross-layer reviews may run concurrently (read-only), then a single repair/finalizer writer. On infrastructure failure capture exact state and stop, not silently switch execution modes.

Current dependency DAG: `retained reviewed board/U1/patch -> AdminAuthority + known privileged paths/admin UI -> restricted Sessions -> durable builds/trusted PR -> Slack/run UI -> review/repair/protected verification`. Finance containment and legacy drain are separate managed-activation gates; further native research is paused. See the addendum for private evidence contracts and provider-first compatibility. A newly discovered safety/API ambiguity still requires escalation; missing Finance evidence must deny activation, never silently narrow revocation scope.
