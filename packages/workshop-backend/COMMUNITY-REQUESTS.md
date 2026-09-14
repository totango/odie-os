# Signed-in community requests

The board is default-on through `AuthenticatedApi`, with no admin, GitHub, SSO-domain or connector
prerequisite. `PublicApi` has no board methods. The server supplies the authenticated account DO
ID to one `CommunityRequests` deployment singleton; it never accepts an author/voter identity
from the client. Exact account aliases are separate accounts, not deduplicated people.

## UI contract

See `workshop-shared/src/community-requests.ts` and `AuthenticatedApi` in `api.ts`.

- Create feature requests or **new** authored public bugs. Public means signed-in deployment
  users, not anonymous internet readers. This path never calls the legacy PR bot.
- Title/body/details are intentionally authored plain text. Render as text, not HTML. Tell users
  this text is shared; do not automatically attach diagnostics, email, transcripts, workspace
  context, session URLs or tokens. The API rejects extra fields and has no evidence sidecar.
  Arbitrary user-authored text is not magically secret-redacted: users must avoid pasting secrets.
- Public projection has no author/account IDs, names or emails: only `isOwn`, aggregate votes,
  viewer vote state and authored text/lifecycle/timestamps. This is privacy minimization, not
  anonymity from the server. Old owner-only feedback retrieval remains unchanged; there is no
  backfill or connection to operational Reporter data.
- List/search share literal, Unicode-lowercased substring matching over public title/body/details.
  Related suggestions use at most eight lexical terms, returning at most ten visible requests.
  Hidden records/details never participate for ordinary users, including continuations/retries.
  Hidden duplicate targets are redacted, and no hidden-inclusive totals are exposed.
- Creation order drives stable keyset pagination, with opaque query-bound cursors; `limit` may
  change between pages. Detail pages are oldest first. Concurrent moderation can remove records
  between pages; this is not a snapshot. Closed requests still accept votes/details.
- Use stable retry keys for create, detail and moderation; keys are account + operation scoped,
  immutable canonical payload mismatches reject. Receipts persist indefinitely (no expiry that
  silently turns a retry into a duplicate). Replays check current visibility and return current
  state, not stale moderation responses. Vote/unvote set explicit state, never toggle.
- Limits: title 160/body 8000/detail 4000/query 160/key 80 UTF-16 code units; page max 50.
  Every board operation consumes the account's 120/min read budget. Mutations additionally
  consume 30/min; creates 5/hour and details 30/hour. Exact/no-op retries do not consume mutation
  quota, but still consume read quota. Quotas use fixed windows, allowing boundary bursts.
  Debounce search/related suggestions and avoid aggressive polling.

## Moderation and storage

`moderateCommunityRequest` checks existing static `#isAdmin()` on every call. Explicit hidden
list/get/details reads do the same. This is **not** dynamic-admin grant management or immediate
revocation of previously issued unrelated capabilities. All four production admin seeds and auth
configuration are unchanged. Admins may hide/restore a whole record (including all its details),
close/reopen it, or mark it duplicate without chains/cycles. Reopen clears the duplicate link.
There is no individual detail edit/delete, public admin audit, run/Auto-Build API or fake runner.

SQLite mutations, uniqueness constraints, receipts, quota charges and internal moderation audit
are committed synchronously in one transaction. Public responses explicitly project fields;
private account IDs, receipts, quota counters and audit actors never leave the registry. It has
no reference to User feedback, Reporter, workspace/session or external-service capabilities.
Search uses bounded SQL parameters/results but scans public text; growth may require a dedicated
index later. Indefinite receipt/audit retention is a storage cost, not a TTL guarantee.

## Migration and verification

Append-only `v4-community-requests` introduces the SQLite DO through loopback `ctx.exports`.
Base config retains v3 NativeBrowserFlow; production retains its pre-existing empty v3. No new
external service binding is required. Generated types include the new namespace; the existing
generator's mainModule normalization keeps it pointing at source, not `.wrangler/validate`.
Release manifest/golden tests include the new migration and assert both full histories.
No live migration/deployment occurred. Rollback must preserve the class/migration/storage rather
than deleting deployed data or rewriting historical tags; disable board entry points if needed.

```sh
pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend exec tsc -p tsconfig.community-requests-tests.json --noEmit
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/community-requests.test.ts __tests__/capnweb-compatibility.test.ts
pnpm exec node --test scripts/release/manifest-lib.test.ts
```

Tests use real workerd/SQLite and real User authentication, with explicit local HTTP interception
(no network fallback). The scoped test typecheck is intentional: the ordinary backend tsconfig
excludes test sources. The HTTP denial uncovered a Cap'n Web compatibility issue repaired in a
separately reviewable same-version pnpm patch; see `patches/README.md`. Independent security and
correctness review is still required before acceptance; no UI or production C2 authority ships here.
