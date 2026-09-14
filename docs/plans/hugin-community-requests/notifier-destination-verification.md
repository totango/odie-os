# Private notifier destination verification — local implementation, not live acceptance

## Approved scope

The supervisor approved fresh Slack-owned identity/destination/access evidence to clear **only** `NOTIFIER_DESTINATION_UNVERIFIED`. Metadata never proves permission to post: readiness explicitly says `posting: "unproven"`; only an acknowledged `chat.postMessage` proves delivery of that particular attempt. No automatic canary is sent. Finance containment, legacy drain, image and pricing blockers remain unconditional production gates. All changes must release together only after all tasks/gates; no partial board rollout.

No live API call, credential read/provisioning, Slack message, grant change, paid model call, image change, dependency change, staging, commit or deployment occurred. The new source has not received independent acceptance review. Earlier16 dryrun artifacts and full-root test totals describe the **pre-notifier-verification source**, not current runtime artifacts.

## Private evidence contract

`RequestBuildNotifierEntrypoint` remains service-binding-only, absent from default HTTP, MCP, gadget, account/session and discovery APIs. Existing ProductFeedback/personal JARVIS paths are unchanged. It reads fixed `https://slack.com/api/auth.test` and `https://slack.com/api/conversations.info` endpoints with the dedicated credential; no caller chooses token, destination, identity or endpoint.

Each readiness call snapshots current configuration/token and performs both reads, with manual redirects, a shared four-second read deadline, and32KiB streamed response limits. Slack must affirm the expected token `team_id`, `user_id` and `bot_id`; enterprise-wide installation responses deny. The exact returned conversation ID/workspace must match. Type is checked using `is_private`, not C/G prefix, including Slack's old private `is_group` representation. Required membership, ordinary-channel type, nonarchive and nonshared flags must be explicit. IM/MPIM, foreign workspace, missing/wrong identity, nonmember, shared/ext/org-shared channels deny. Optional pending/frozen/read-only/thread-only flags must be false when present, pending arrays empty, shared-team arrays limited to the expected workspace. Missing optional fields are permitted as documented ordinary responses omit them; malformed/present contradictory fields deny. Provider scope headers on **both** reads must include `chat:write` and the type-specific read scope.

Success contains only protocol, configured/verified status, `posting: "unproven"`, trusted origin, configuration generation, `checkedAt` and `expiresAt`. `checkedAt` is the start of the bounded checks, so the earliest identity observation cannot outlive30seconds; evidence is returned only after both complete. Failure contains only protocol, locally-complete `configured`, `destinationVerified:false` and unproven posting. No Slack identity/channel/token/hash/scopes/headers/raw provider errors are returned, logged or persisted as evidence. The board projects only closed readiness reasons/delivery states.

The shared consumer verifies exact origin/current generation, safe finite timestamps, no future start, positive ordered lifetime at most30seconds and nonexpired evidence **after** asynchronous current-authority checks. Missing old-protocol fields fail closed. There is no positive cache or durable attestation. Every actual send independently repeats Slack checks with one token/config snapshot; it also requires the backend's expected generation argument to match before doing any I/O. Token/config rotation therefore never reuses an earlier success, even if an operator neglects to bump the label. The generation is a consistency label, **not** a token revocation or security attestation. Checks and already-admitted sends cannot retroactively undo in-flight remote effects; configuration races after admission are not claimed atomic with Slack.

The separate existing SQLite outbox/attempt ledger is reused without migration. A failed pre-send check is blocked with no post. After an attempted post, existing strict acknowledgement, documented429 non-delivery retry and ambiguity/no-blind-resend rules remain. Revoked post permission can still be discovered only by posting; metadata success does not turn such a response into acknowledgement.

## Operator configuration and minimal scopes (no provisioning authorized here)

JARVIS requires these expected constraints, supplied separately through trusted deployment administration:

- `REQUEST_BUILD_SLACK_TOKEN`: dedicated bot credential, unrelated to personal Slack or JARVIS MCP grants.
- `REQUEST_BUILD_SLACK_TEAM_ID`, `REQUEST_BUILD_SLACK_BOT_USER_ID`, `REQUEST_BUILD_SLACK_BOT_ID`: expected workspace, bot-user and bot identities.
- `REQUEST_BUILD_SLACK_CHANNEL`: exact explicitly intended channel ID.
- `REQUEST_BUILD_SLACK_CHANNEL_TYPE`: exactly `public` or `private` (ordinary channels only).
- `REQUEST_BUILD_WORKSHOP_ORIGIN`: canonical HTTPS Workshop SPA origin, with no credentials/path/query/fragment.
- `REQUEST_BUILD_NOTIFIER_GENERATION`:1–128 ASCII letters/digits/underscore/hyphen, matching the backend's value. Coordinate a changed generation when rotating credentials/configuration or release identity. No sample/default production identity or generation was inserted into checked configuration.

Backend requires the existing private `REQUEST_BUILD_NOTIFIER` binding, the same explicit Workshop origin, and matching `REQUEST_BUILD_NOTIFIER_GENERATION`. An absent or malformed value stays blocked. Presence is only an expected constraint, never evidence of an actual Slack identity, scope, membership or posting permission.

Minimum dedicated bot scopes: `chat:write` plus **`channels:read` for a public channel OR `groups:read` for a private channel**. `auth.test` requires no additional scope. Membership comes from Slack's `is_member`; no `users:read`, member-list pagination, history, IM/MPIM scopes, admin scopes or `chat:write.public` are needed. The bot must already be a member; this mechanism never joins/invites it. Reinstall/regrant changes require separate operator authorization. The actual OAuth scope header, not configured scope text, is checked. Do not add private channel names, identities, tokens or provider response bodies to board output/logs.

Official public references fetched by supervisor (metadata research only; refs `mu0eoaa4s2mco9`, `mu0eookix5eid0`, `mu0ep17lajsbmi`):
- https://docs.slack.dev/reference/methods/auth.test/
- https://docs.slack.dev/reference/methods/conversations.info.md
- https://docs.slack.dev/reference/objects/conversation-object/
- https://docs.slack.dev/authentication/installing-with-oauth/#appending_scopes
- https://docs.slack.dev/reference/scopes/channels.read.md
- https://docs.slack.dev/reference/scopes/groups.read.md
- https://docs.slack.dev/reference/scopes/chat.write.md
- Existing send/429 references: https://docs.slack.dev/reference/methods/chat.postMessage/ and https://docs.slack.dev/apis/web-api/rate-limits/

## Local evidence and remaining gates

Protected commands use only the unchanged runner `/tmp/odie-restricted-sessions-evidence/run-builds-pr-candidate.py` (SHA256 `56d83de010ec5fb47e4d1f9c6da002a9a56804f7607d7de21ad8326da551f551`) with unique `notifier-activation-*` labels and `pnpm --config.verify-deps-before-run=error`. Full argv, sandbox canaries, clean-HOME/noCI/original-store/install monitor outcomes and logs are in `commands.jsonl` and those per-label artifacts. No environment/protection exception was introduced.

- `control-2`:48 passing controller/publisher tests, including15 added cases. Actual workerd backend→JARVIS→fake Slack HTTP checks/read/send, the real production CommunityRequests factory clears only the notifier reason, ordinary public/private destinations, identity/access/sharing/scope denial, outage/redirect/size/malformed/4s timeout, stale/future/old/generation evidence, token rotation, pre-send permission revocation and posting-unproven ambiguity. Existing safe projection/authority/cancellation/retry/crash/lost-ack tests retained. Test-only fixtures supply fake provider responses and configuration; production imports none of their controls.
- `backend-facade-1`:23 passing real-workerd authenticated board/authority/facade/compatibility tests, preserving configured accounts, private Context, hidden JARVIS and fail-closed privileged paths.
- `jarvis-compat-1`:39 existing JARVIS tests pass.
- Source/test-program typing and scoped lint pass; scoped lint reports5 warnings/0 errors. Final command details are in the writer artifact.
- `integrity-1`:71337 unchanged installed payload/shim records plus the one previously approved metadata-only timestamp; state SHA256 remains `66fff93882427af045cc728c481778fe08f1ffd37b4764c5df8ec67784a8293e`. Exact patched24 + unchanged older2 entrypoints, root manifests/lock/U1 and HEAD are preserved. Index empty; tracked and named untracked whitespace checks pass (the first no-index shell loop stopped on the normal additions exit1; corrected status handling checked all files).

The full controller suites emit one unsuppressed Cap'n Web `RPC result was not disposed properly` warning, attributed by Vitest to `admitted PR wins cancellation/revocation race` in `control-1` and `wrong receipt generation never advances state or frees a cleanup lease` in `control-2`. Both test cases existed before this change, but no matching pre-change **result** warning was established, so causation is **unresolved**, not asserted preexisting. Bounded fixture inspection found native DO/service calls and value DTOs, no newly owned Cap'n Web stub/result; no runtime patch, ignored error or native experiment was introduced. Earlier root logs contain a differently worded stub warning, which is not proof of the same cause.

Outstanding: independent source/security acceptance; genuine operator-authorized destination/credential check and a separately authorized operational send smoke; supported optional generic-release notifier binding contract in the external deploy service; all existing Finance/drain/image/pricing/browser/CI/advisory and final all-change release gates. No nonexistent manifest/deploy-service schema was invented. Local fake Slack success is **not** evidence about the real destination or permission to send there.
