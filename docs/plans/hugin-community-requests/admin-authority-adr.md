# C1 — Admin authority decision

**Latest approved clarification and implementation:** [Legacy owner fencing](legacy-owner-fencing.md) supersedes the historical Context token-retirement and JARVIS read-revocation requirements below. Issued Git tokens are independent write credentials; no automatic retirement occurs. JARVIS ordinary value-only policy reads remain available. Public Context/JARVIS mutations are now fenced at resource owners. Managed activation requires two fresh complete private owner scans and atomically records their domain/version baseline; missing/old/mismatched providers still deny. Finance remains separate. This is source/fixture evidence, not a production activation or generic native-drain claim.

**Approved Finance role correction:** [Finance operator separation](finance-operator-separation.md) supersedes the Finance-coupled parts of the original contract. Finance status/create/open uses exact deployment-configured operators (optional `FINANCE_OPERATORS`, omitted → `ADMINS`), independent of managed grant/revoke. Owner/direct-share access is unchanged. No managed-admin descendant drain or revocation barrier is claimed for Finance. The remaining Context/JARVIS legacy-child/token inventory still blocks managed activation.

**Authority-core source now implemented; no production grant changes or managed activation.** See [implementation evidence and inventory](authority-core-implementation.md); the supplied second component review passed after three repairs and passing combined test-program typing. The [real admin UI](admin-management-ui-implementation.md) is now locally implemented/tested, pending its independent review. Historical design language below is retained as the contract, not a claim that UI/Finance cutover passed. The [implementation-first addendum](implementation-first-addendum.md) supersedes implementation ordering and refines transition/compatibility: implement AdminAuthority, known privileged paths and UI now; Context/JARVIS legacy capability drain remains a mandatory managed-activation gate. Live bootstrap/cutover cannot be inferred from source inspection. Legacy/prepared modes preserve static authority; effective grant/revoke is managed-only.

## 1. Evidence and identity decision

- `workshop-backend/src/server.ts:374-390`: admin means the selected named user DO appears in `ADMINS`, not a browser-reported email.
- `server.ts:397-410`, `src/auth/identity.ts`, `src/auth/config.ts:36-59`, and `docs/email-domain-migration.md`: verified SSO can resolve/switch existing same-local-part accounts under the configured alias policy. Tokens remain bound to the account that issued them; two existing accounts are not merged. Local parts retain case and plus tags.
- `workshop-backend/wrangler.odie-os-production.jsonc:19-26` lists **jacob.beck@totango.com, keith@totango.com, nick.roberts@totango.com, stacy.kennedy@totango.com**. This conflicts with the owner's belief that only Jacob is admin. Checked-in configuration is not live-state proof. Do not silently remove the other entries or grant `jacob.beck@heyodie.ai`.

**Decision:** grants and votes attach to the exact authenticated user DO identity, deployment-scoped. Do not create a person-deduplication or account-merging subsystem. One vote per `(requestId, principalId)` means one account, not one human; aliases that resolve to the same DO share a vote, independently existing accounts do not. Abuse controls address multi-account voting; never claim person-level uniqueness.

A target admin is an **existing account**, resolved by exact profile ID through trusted user-DO lookup. The admin UI shows exact account ID plus display label, requires explicit confirmation, and never uses editable display name, a supplied email, or `hasPasswordLogin=false` as verified-person proof. Preserve existing password-admin compatibility on deployments that permit password auth; alias switching still requires existing verified provenance. No new admin signup/invitation or implicit account creation in MVP.

## 2. Source of truth and proposed private schema

Use a separate SQLite-backed `AdminAuthority` backend DO, one per deployment authorization domain, rather than `AdminConfig`, KV, gatekeeper props alone, or a new external identity service. This small authorization coordination object handles low-volume grants/checks, not board search/content traffic. No positive authority cache in the browser or KV.

Prospective records (not existing types):
- `authority_meta(singleton, schemaVersion, mode, bootstrapDigest, revision, initializedAt)`.
- `admin_grants(principalId PRIMARY KEY, profileId, generation, active, source, grantedBy, changedAt)`; revoked rows retained so regrant never resurrects an old generation.
- `admin_audit(eventId PRIMARY KEY, mutationKey UNIQUE, actorPrincipalId, targetPrincipalId, action, previousGeneration, nextGeneration, revision, timestamp)`; private audit, bounded fields, no secrets/session tokens/diagnostics.
- No Finance revocation queue: Finance operator configuration is independent of managed authority.

Atomicity: each grant/revoke rechecks the **actor inside the authority DO's same synchronous storage transaction**, validates expected authority revision, checks target existence established by trusted lookup, changes target generation/active state, and writes audit/idempotency outcome together. No network await inside that transaction. A concurrent last-admin removal cannot observe stale counts. A repeated mutation key with different payload rejects; retrying the same key returns its stored result. A revoked caller does not gain read authority through an idempotency lookup.

## 3. Bootstrap, recovery, revocation contract

### Bootstrap/cutover
1. Ship the compatibility machinery with legacy authority still effective and no membership changes.
2. An existing authorized deployment operator previews exact current `ADMINS` and the corresponding existing account identities. Resolve the four-versus-one discrepancy using live authenticated evidence and explicit owner approval, not source edits to guessed identities. Unknown accounts require explicit disposition; do not seed future users merely because a name matches.
3. Initialize managed grants **once**, transactionally, from the approved existing-principal list. Record a bootstrap digest and revision; never union env entries into managed grants on every request/restart.
4. Complete the capability cutover below, then explicitly activate managed mode. Preserve `AUTH_GATEKEEPERS`, `DISABLE_PASSWORD_AUTH`, and `AUTH_EMAIL_DOMAIN_ALIASES` as env-only authentication policy. Dynamic membership is separate authorization policy.
5. Retain at least one active existing admin. MVP forbids self-revocation; another admin can revoke the caller after a replacement signs in and is verified usable. Test two concurrent removals, not just sequential last-admin checks.

Recovery is out-of-band deployment-operator work, not a public `resetAdmins()` RPC and not automatic env fallback on DB failure. An approved recovery operation must add a specific existing principal, increment revisions/generations and audit the recovery without deleting grant history. If storage or identity verification is unavailable, fail closed for privileged operations. Ordinary signed-in board access remains available where it does not require admin checks.

### Timing guarantee (precise, not retroactive)

Each managed-administrator RPC admission performs a fresh authoritative check. This guarantee excludes separately configured Finance operator capabilities and owner/direct-share authority. **Checks ordered after a revocation commit reject**, including on retained stubs. Regrant uses a new generation and cannot revive old stubs. Operations whose authorization check completed before the commit may finish; revocation is not a rollback of already-admitted writes or external requests. Document this in the API/UI rather than promise instantaneous cancellation of in-flight distributed work. Recheck immediately before external publication; a publication already sent cannot be unsent. No fresh authority means deny.

## 4. Complete current admin-derived capability inventory

| Surface | Current evidence | Required C2 treatment / regression test |
|---|---|---|
| `AuthenticatedApi.isAdmin/getAdminApi` and all `AdminApiImpl` methods | `server.ts:1158-1169`; `admin-settings.ts:852-981` | Mint a principal+generation-bound capability and check on **every** privileged read/write, including settings, formats, gatekeeper policy, Finance repair and diagnostics. Hold old AdminApi, revoke, then call it; must deny. |
| Gatekeeper app discovery/open and `providesUi.adminOnly` | `server.ts:80-114,1141-1152`; `user.ts:2532`; `workshop-shared/src/gatekeeper.ts:82-88,200-213,840-843` | Fresh checks on listing/open; pass a narrow revocable authority capability, not an authoritative cached boolean. Ordinary non-admin/private UI functions remain usable. |
| Context public collections and Git-backed operations | `gatekeeper-context/src/library-gatekeeper.ts:153-160`; `context-api.ts:58-128,287` | Replace all admin branches in `#assertAdmin`, `#assertCanWrite`, and editability projection. Retain Context RPC, revoke, attempt public create/edit/delete/Git-backed change; deny. Own private collection authority must remain intact. |
| JARVIS policy read/update | `gatekeeper-jarvis/src/index.ts:294-296`; `policy.ts:143-165` | `JarvisPolicyApi` currently captures `isAdmin`; replace with live generation-bound checks for both read and update. Retained policy UI must lose permission after revocation; do not accidentally broaden tool/action permissions. |
| Finance hub status/create/open and derived workspace role | `server.ts`, `finance-operators.ts`, `overseer.ts:#financeRole` | Independent configured operator admission; managed grant/revoke has no effect. Test exact operators/nonoperators, managed grant/revoke, fresh opens after config change, outage, owners/direct shares. Already-escaped capabilities are not promised revoked by operator config changes. |
| Finance sharing revocation mechanism | `overseer.ts:3743-3766` | Existing `scheduleRevocationRestart()` flushes then aborts the DO to close clients. Reuse for invalidation when applicable, but avoid relying solely on best-effort abort fanout for authorization correctness. |
| Future Auto-Build start/control/publication | H0 ADR | Principal+generation check at start, dispatch and publish. Cancellation/status reconciliation remains available to the trusted service after trigger user loses membership. |

Do not wrap Finance in a speculative authority membrane. Finance operators are not managed administrators. Managed activation remains blocked by concrete pre-upgrade Context/JARVIS privileged children and issued-token inventory; new-path protocol support is not proof of drain.

### Cross-Worker admin capability

Proposed `AdminAuthorization` is a narrow backend-owned native WorkerEntrypoint capability, constructed with immutable private principal/purpose/deployment and mode/epoch provenance, plus grant generation in managed mode. Its only authority method is `assertCurrent(): Promise<void>`; it cannot grant rights or target arbitrary users. Legacy capabilities freshly check exact static identity per operation and are invalid in managed mode. Add an explicitly advertised capability-aware app UI path; `isAdmin` is **never sufficient for a privileged write on that new path**. New consumers fail closed on missing capability/protocol and never downgrade after denial/outage. As approved in the addendum, the old provider boolean path remains solely for old-backend legacy compatibility; it is unfenced drain inventory, not upgraded enforcement, and must be fenced/retired and drained before activation. The issuer must be a trusted Workshop binding, never a stub accepted from a browser/gadget. Use native persistent service references where needed; ephemeral Cap'n Web callbacks are not durable grants. Preserve disposal/dup semantics, document every public API member.

**Cutover hazard:** existing Context/JARVIS account capabilities can pin older Worker versions, and already-open privileged provider UIs cannot be retroactively patched by changing an interface. Before managed mode is enabled, verify updated providers are in use, rebind/reconnect affected stored accounts through supported mechanisms, and drain/invalidate pre-cutover admin sessions. Merely deploying the new backend or asking users to refresh is not proof. If a complete legacy-capability drain cannot be demonstrated, leave managed mode inactive and report this as a C2 release blocker. No production reconnect/drain is executed in this planning run.

## 5. Proposed APIs, exact seams and migrations

Public `AdminApi` additions in `workshop-shared/src/api.ts` (all documented, bounded inputs):
- `listAdministrators(cursor?) -> {items, nextCursor, revision}`.
- `resolveAdministratorCandidate(exactProfileId) -> existing-account summary | null`, admin-only, no unbounded directory scan.
- `grantAdministrator({profileId, expectedRevision, mutationKey}) -> grant result`.
- `revokeAdministrator({principalId, expectedRevision, mutationKey}) -> revocation result`.
- `listAdministratorAudit(cursor?) -> private paged events`.

Actor identity comes only from the minted capability; none of these methods accepts `isAdmin` or caller identity as authority. Error vocabulary: `ADMIN_REQUIRED`, `ADMIN_REVOKED`, `REVISION_CONFLICT`, `ACCOUNT_NOT_FOUND`, `LAST_ADMIN`, `SELF_REVOKE_FORBIDDEN`, `AUTHORITY_UNAVAILABLE`; do not leak target existence to non-admins.

Likely implementation seams: new `workshop-backend/src/admin-authority.ts`, `env.d.ts`, `server.ts`, `admin-settings.ts`, `overseer.ts`; shared `api.ts`/`gatekeeper.ts`; Context `library-gatekeeper.ts`/`context-api.ts`; JARVIS `index.ts`/`policy.ts`; existing frontend admin route/panel and tests. Authoritative existing RPC types are reused rather than mirrored.

Migrations: board `v4-community-requests` now exists. Append `v5-admin-authority` introducing `AdminAuthority` after it in both configs; **preserve** dev v3's `NativeBrowserFlow` and production v3's empty historical tag. Do not renumber or fold existing board history into auth. Update affected generated env types through existing generator only during authorized implementation. Review generic release manifest/golden and Odie direct deployment wiring; adding a WorkerEntrypoint alone does not require a DO migration.

Rollback: before activation, leave legacy mode as-is; after managed membership changes, do not roll back to old static code that can resurrect revoked admins. Keep enforcement/schema and disable management mutations or roll forward. No DO deletion, history rewrite, or fallback to stale KV authority.

## 6. Design verification, release gates

Source inspection and the table-top scenarios above are completed design work, not passing runtime tests. Future C2 verification must cover exact-account/alias collision, fabricated emails/unknown users, password compatibility, bootstrap repeat/concurrency, storage outage, stale revision/regrant, self/last-admin protection, cross-Worker Context/JARVIS retained stubs, Finance operator independence, restart persistence, and legacy-provider cutover.

Use backend `__tests__/finance-access.test.ts` and `__integration__` real-RPC fixtures as patterns; add focused `admin-authority` tests and Context/JARVIS tests. Exact commands are in `gate-verification.md`. Original design tests below were not runtime evidence; current focused results and unresolved typecheck failures are recorded in [Finance operator separation](finance-operator-separation.md).

Open release gates: operator-confirmed live bootstrap list (including four-versus-one discrepancy); accepted account-scoped voting and revocation timing; proven legacy capability cutover; C2 implementation plus independent security review. No supplied email is treated as proof of deployed access.
