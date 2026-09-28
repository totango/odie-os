# Feature Requests UI

The board is enabled for every authenticated deployment account at `/requests`. `/requests/new`
creates a feature or newly authored public bug; `/requests/$requestId` opens a URL-backed desktop
side sheet (mobile full-screen) over the board with its public description, account vote, details and
related requests. `/requests/$requestId/runs/$runId` uses the same URL-backed sheet pattern for an
individual Auto-Build run. Browser Back closes the sheet and direct links remain shareable. A quiet primary-style sidebar row replaces the old oversized
feedback callout, including in Code mode and the collapsed rail. Current administrators also receive a
persistent Admin row. The root still requires login,
but board routes bypass onboarding, required connectors and the mandatory billing-account picker.
Neither GitHub nor an admin/domain-specific account is a board prerequisite. Board cards and in-panel
navigation use app-style buttons while URL state remains shareable. The request list refreshes every
thirty seconds while visible and immediately on window focus; no manual Refresh Requests control is
shown. Onboarding and the required-connector recovery screen also link directly to the board when setup
has replaced the sidebar; following those links does not complete onboarding or connect a service.

## Privacy and behavior

- “Public” means signed-in users of this deployment. The form previews the exact public title/body
  and selected attachment names; its final publish action explicitly confirms that public payload,
  and the details form labels its publish action the same way without an extra checkbox. Text is
  rendered as React text, never Markdown/HTML. Request authors and detail authors may upload up to
  ten immutable attachments per request, 25 MiB each and 100 MiB combined. The server allowlists and
  checks expected signatures for binary files and valid UTF-8 for text/Markdown/JSON,
  MP4, WebM, and QuickTime content;
  SVG, HTML, archives, Office files, executables, and MIME/extension mismatches are rejected. Bytes
  load only after an authenticated user explicitly requests a preview or download. A bug author may
  separately opt in to attach the bounded current-tab console/error
  snapshot with an explicit, default-off diagnostics button. That evidence is sanitized, stored separately for
  thirty days, readable only with current board-moderation authority, and never enters public list,
  detail, search, related-request or Auto-Build projections.
- Draft and detail text is not persisted to browser storage or logged. RPC failures use fixed safe
  UI messages, not raw exception messages. Do not promise that user-pasted secrets can be detected.
- Related suggestions debounce for 600 ms and send at most the backend's 160-code-unit query limit.
  They remain visible during preview/submission; failure does not block publishing. List search
  debounces for 400 ms. Pages use the backend cursors, reset for query/API changes, and load only on
  user demand. Visibility-aware polling refreshes the newest page every thirty seconds and when the
  window regains focus; after pagination it deliberately returns to the first page so new requests and
  vote/status changes cannot remain stale. There is no external search/model provider.
- Create/detail/attachment/diagnostic writes retain one retry key for an unchanged uncertain payload during the
  mounted form's lifetime, including API reconnect. Confirmed detail writes reset it.
  Votes explicitly set/remove the account's vote; the UI does not optimistically toggle. Drafts and
  retry keys are **not durable across reload/navigation**: uncertainty copy asks users to check the
  board before resubmitting after leaving. Server-side receipts remain durable. Editing an uncertain
  submission creates a new operation, so retry unchanged to recover the original result.
- The AuthProvider owns the authenticated stub. Board methods return plain value records, not child
  capabilities; no new stub ownership/disposal is introduced. Read effects cancel stale responses,
  API-scoped results/cursors prevent reconnect reuse, and mutation lifetime tokens reject late
  completions after unmount, API replacement or React Activity suspension.

## Ownership and deferred administration

The board has no separate moderation view. It performs only ordinary visible request reads, and stale
`moderate` query parameters grant no hidden access. On an ordinary visible bug request, current
administrators receive an inline Private diagnostics section through the separately authority-checked
private-diagnostics API. The purpose-bound backend moderation capability remains available for
operational compatibility but has no Feature Requests navigation or hidden-request UI.

Authors can delete their own requests, individual public details, and individual attachments. Detail
deletion removes only that author's text and attachments; attachment deletion leaves its parent text
intact. Both advance the request revision, invalidate stale and future Auto-Build approval, and schedule attachment
objects through the durable retry queue. An already approved run retains its disclosed immutable frozen copy. Another account cannot delete the content. Request deletion immediately hides the request and transactionally scrubs its authored
title/body, all public details, attachments, votes and private diagnostics. A minimal moderator-only
request tombstone remains for durable build/audit integrity and cannot be restored. An approved build
record may retain its frozen copy for restricted audit integrity, but owner deletion immediately revokes
continued execution and public access to the request and its run history.

Auto-Build is request-bound and administrator-controlled, with authority, image, budget, repository,
model and notification readiness checked independently. Approval freezes the complete public request
text, public metadata, all public details, and an immutable attachment manifest. Attachment bytes are
privately transferred into the restricted sandbox, rechecked by length and SHA-256, and materialized
outside the repository before Pi starts; the sandbox receives no object-storage or publication
credentials. Later comments or attachments affect later approvals only. Publishing never invokes the
legacy `submitProductFeedback` runner; private diagnostics remain excluded from build specifications.

The legacy private-feedback status button is no longer rendered on the Feature Requests board. Older
records are not imported or searchable as Feature Requests. The backend private-feedback APIs remain
unchanged for compatibility; removing the button is not a legacy-capability cutover.

## Local verification

`CommunityRequests.test.tsx` uses jsdom, real React/Kumo controls and memory-router navigation with
method-typed RPC doubles. It covers public submission/bug privacy and separate diagnostic consent,
retry keys, bounded suggestions, list/search/filter/pagination, URL-backed detail-sheet navigation,
safe text/errors, stale responses/API replacement, votes/details/attachments, request/detail owner deletion,
button-based navigation, and visibility-aware background board refresh. Root integration tests verify signed-out
login and board onboarding/billing/connector escape behavior; Sidebar and RequiredConnectionsGate tests
cover availability without GitHub and no required-connector RPC reads. This is frontend interaction
coverage, not a browser-to-live-backend end-to-end test.

The existing Vite TanStack plugin generates `src/routeTree.gen.ts` on test/build; do not hand-edit it.
`OnboardingWizard.test.tsx` additionally navigates from the real onboarding component to a local board
route without completing setup and checks subscription cleanup. Required-connection tests assert the
board recovery link on missing-service and failed-status screens. Backend HTTP-batch coverage exercises
the real authenticated facade/SQLite across new-bug creation, another account's votes/details/search/
suggestions, public attachment validation/authorization/storage, private diagnostic sanitization/isolation, request/detail author
deletion, retained backend admin authority checks, and ordinary-user denials; it uses local interception only.

Run `pnpm --filter @gadgets/workshop-frontend test:run`,
`pnpm exec vp run -F @gadgets/workshop-frontend build`, and a direct
`pnpm --filter @gadgets/workshop-frontend exec tsc --noEmit` to check current test/source types without
relying on cached task output. Backend privacy/wire coverage belongs to the independently reviewed
board backend stage; no backend bridge changed in this frontend stage.
