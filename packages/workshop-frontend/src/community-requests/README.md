# Community requests UI

The board is enabled for every authenticated deployment account at `/requests`. `/requests/new`
creates a feature or newly authored public bug; `/requests/$requestId` shows its public description,
account vote, details and related requests. The pinned sidebar entry replaces the old feedback
submission modal, including in Code mode and the collapsed rail. The root still requires login,
but board routes bypass onboarding, required connectors and the mandatory billing-account picker.
Neither GitHub nor an admin/domain-specific account is a board prerequisite. Onboarding and the
required-connector recovery screen also link directly to the board when setup has replaced the sidebar;
following those links does not complete onboarding or connect a service.

## Privacy and behavior

- “Public” means signed-in users of this deployment. The form previews the exact public title/body
  and requires explicit public-summary consent. Details require their own public-text consent.
  Text is rendered as React text, never Markdown/HTML. No diagnostics, workspace/chat context,
  identities, attachments or capability links are read or added to a submission.
- Draft and detail text is not persisted to browser storage or logged. RPC failures use fixed safe
  UI messages, not raw exception messages. Do not promise that user-pasted secrets can be detected.
- Related suggestions debounce for 600 ms and send at most the backend's 160-code-unit query limit.
  They remain visible during preview/submission; failure does not block publishing. List search
  debounces for 400 ms. Pages use the backend cursors, reset for query/API changes, and load only on
  user demand. There is no board polling or external search/model provider.
- Create/detail/moderation writes retain one retry key for an unchanged uncertain payload during the
  mounted form's lifetime, including API reconnect. Confirmed detail/moderation writes reset it.
  Votes explicitly set/remove the account's vote; the UI does not optimistically toggle. Drafts and
  retry keys are **not durable across reload/navigation**: uncertainty copy asks users to check the
  board before resubmitting after leaving. Server-side receipts remain durable. Editing an uncertain
  submission creates a new operation, so retry unchanged to recover the original result.
- The AuthProvider owns the authenticated stub. Board methods return plain value records, not child
  capabilities; no new stub ownership/disposal is introduced. Read effects cancel stale responses,
  API-scoped results/cursors prevent reconnect reuse, and mutation lifetime tokens reject late
  completions after unmount, API replacement or React Activity suspension.

## Moderation and deferred work

The existing Admin page links to `/requests?moderate=true`. Ordinary users never send hidden-inclusive
reads. Static admins explicitly open moderation view to include hidden records and hide/restore,
close/reopen or mark a duplicate (canonical board ID plus confirmation). Server checks remain the
security boundary. Hiding covers the entire request and all details; there is no per-detail moderation
API in this stage. Existing static-admin limitations remain; this is **not** C2 dynamic authority or
revocation, and there is no dynamic-admin management panel.

Auto-Build is a disabled, explanatory not-ready state: request-bound execution, authority, budget,
credentials and notification prerequisites are not implemented/enabled here. The planned target is
`totango/odie-os` / `main`. Publishing never invokes `submitProductFeedback` or another PR/build runner.

“View my legacy private feedback status” is explicit, lazy and read-only. It calls the existing
owner-scoped `listProductFeedbackStatuses` without conditioning the public board on legacy automation
availability. Refresh is manual; older records are not imported/searchable as board requests. Only
strict HTTPS `github.com/totango/odie-os/pull/<number>` legacy links are clickable. The old backend
private feedback APIs remain unchanged for compatibility; this UI is not a legacy-capability cutover.

## Local verification

`CommunityRequests.test.tsx` uses jsdom, real React/Kumo controls and memory-router navigation with
method-typed RPC doubles. It covers public submission/bug privacy and consent, retry keys, bounded
suggestions, list/search/filter/pagination, safe text/errors, stale responses/API replacement,
votes/details, moderation and owner-private status retrieval. Root integration tests verify signed-out
login and board onboarding/billing/connector escape behavior; Sidebar and RequiredConnectionsGate tests
cover availability without GitHub and no required-connector RPC reads. This is frontend interaction
coverage, not a browser-to-live-backend end-to-end test.

The existing Vite TanStack plugin generates `src/routeTree.gen.ts` on test/build; do not hand-edit it.
`OnboardingWizard.test.tsx` additionally navigates from the real onboarding component to a local board
route without completing setup and checks subscription cleanup. Required-connection tests assert the
board recovery link on missing-service and failed-status screens. Backend HTTP-batch coverage exercises
the real authenticated facade/SQLite across new-bug creation, another account's votes/details/search/
suggestions, admin hide/restore/close/reopen, and ordinary-user denials; it uses local interception only.

Run `pnpm --filter @gadgets/workshop-frontend test:run`,
`pnpm exec vp run -F @gadgets/workshop-frontend build`, and a direct
`pnpm --filter @gadgets/workshop-frontend exec tsc --noEmit` to check current test/source types without
relying on cached task output. Backend privacy/wire coverage belongs to the independently reviewed
board backend stage; no backend bridge changed in this frontend stage.
