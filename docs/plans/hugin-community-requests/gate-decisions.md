# A / C1 / H0 — decision record and handoff

**Latest owner-approved semantic decision:** [Finance operator separation](finance-operator-separation.md) supersedes historical Finance guard/drain gates. Exact deployment-configured operators are separate from managed administrators; grant/revoke does not change Finance. Context/JARVIS pre-upgrade privileged children/tokens remain concrete activation inventory. No new role UI, authentication semantics or release authorization is implied.

## Scope and status

Planning-only pass at `main@248cc75eda989d5ddc93507518a0bf284065e93f`. Git repository confirmed before edits; tracked working tree/index unchanged. Pre-existing `.oculus/`, `.pi/`, and `docs/plans/` preserved. Only documentation under this plan directory was created/updated. No implementation, tests/builds, installs, source/config edits, merges, commits, pushes, PRs, deployments or Slack messages.

The owner explicitly authorized **independent temporary clone acquisition** in answer to the single clarification question. That permission does not allow fetching into this checkout or merging selected patches.

## Short architecture decision

| Gate | Selected decision | Evidence / remaining authority |
|---|---|---|
| A | Pin upstream `08afe059f1b9ee37129e0327cde43782870fbb76`; recommend scheduler **test-only** `00da2d66ff5b28c61f4a6c6dd50c783090838239` as first A2 batch; defer remaining families | Fresh clone acquired, 441/82 divergence, 604 upstream changed paths, 94 overlaps. Candidate patch/parent blobs inspected. Owner batch selection and exact-head A2 tests still required. |
| C1 | Account-DO-scoped grants/votes; separate AdminAuthority DO; bootstrap once from approved existing accounts; live generation-bound checks across AdminApi, Context, JARVIS and Finance | Exact aliases remain separate accounts. Source lists four production admins, not one; live membership cannot be asserted. Managed-mode rollout requires verified bootstrap list and legacy-capability drain. |
| H0 | Dedicated restricted Code Session mode, admin+GitHub entitlement; durable idempotent reservation and receipt polling; trusted publisher after frozen-spec/patch validation | Ordinary sessions have write-capable GitHub proxy auth and internet access, so unchanged reuse is unsafe. Budget/runtime/egress configuration and external receiver contract are enablement gates, not assumed defaults. |

**Design work is complete; owner/operational gates are not falsely marked approved.** These artifacts guide implementation after explicit authorization; they do not discharge unperformed production checks or runtime tests.

## Authoritative companion documents

- [A refreshed inventory, selected candidate, defer matrix and rollback](upstream-gate.md)
- [C1 admin identity, APIs, schema, revocation and cutover ADR](admin-authority-adr.md)
- [H0 private protocol, schemas, state machine and failure matrix](autobuild-control-plane-adr.md)
- [Progress and dependent stories](TODO.md)
- [Critic findings, self-repair and verification](gate-verification.md)
- [Original anchor](anchor.md) and its older dossier remain available; the scoped decisions here supersede earlier provisional A/C1/H0 statements. No unrelated feature scope is replaced.

## Gate-only story DAG and execution

`P0 -> A-acquire -> A-audit -> A-selection recommendation`

`P0 -> C1-inventory -> C1-ADR -> H0-protocol`

`A + C1 + H0 -> critic/self-repair -> documentation verification -> STOP`

A and C1 are independent read-only research, but executed serially in this Pi session: no parallel writers/subprocess agents were necessary. C1 feeds H0 authority. The runtime implementation path remains `A2 -> contracts -> C2/board -> H`, as refined in the anchor; **no implementation story ran**.

## Downstream constraints pinned

Exact prospective file/API/schema details and additive migration strategy are in the two ADRs. Existing `AdminConfig` stays soft config; auth provider/domain settings stay env-driven. Reuse Cap'n Web types, pipelining and disposal semantics, with private JavaScript `#` methods for RPC-inaccessible helpers. Every shared export gets documentation. Small kernel/auth/service changes ship in separately reviewable increments; no broad rewrite or automatic upstream merge.

No historical bug publication or operational Reporter-to-board feed; no internet-public board, personal session takeover, public workbench token, anonymous voting, agent-selected repository, automatic deployment, or exactly-once Slack claim. The board remains default-on for authenticated users even when Auto-Build prerequisites are missing.

## Remaining owner/operational decisions before execution or enablement

1. Select U1 for A2 or request more upstream audits; no silent upstream deferral.
2. Confirm live bootstrap membership: checked-in config lists Jacob, Keith, Nick and Stacy. Do not remove or grant anyone based on the current assumption that Jacob is alone.
3. Accept account-level (not person-level) votes/grants and post-commit-check revocation timing; prove old capability cutover before managed-mode activation.
4. Confirm deployment runtime/budgets/egress and repo App permissions; no synthetic model/credential authority.
5. Confirm Slack channel and receiver schema/deduplication contract before notification activation. These checks send nothing now.

Recommended next human request: “Approve U1 as the first A2 batch and review the C1/H0 ADR decisions.” That still must explicitly authorize implementation before any code changes. This run stops here with documentation ready for review, not an implementation PR or deployment claim.
