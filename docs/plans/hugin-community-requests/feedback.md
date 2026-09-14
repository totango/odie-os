## Summary

Hugin anchor established at `HEAD 248cc75eda989d5ddc93507518a0bf284065e93f`; no implementation was performed. The current code has Totango-only private product-feedback automation, but no public community request/bug list, votes, comments/details, duplicate suggestions, or request-linked Auto-Build run model.

## Hugin Anchor

- **Anchor:** `main` at `248cc75eda989d5ddc93507518a0bf284065e93f`.
- **Scope:** planning/research only; no source/config edits, dependency installs, builds, tests, fetch, merge, commit, push, deploy, or external messages.
- **Workspace state:** `git status --short --branch` showed `* main...origin/main` plus existing untracked `.oculus/` and `.pi/`; `git diff --cached --name-only` returned empty.

## Observations

### 1. Existing feedback is not a public request system

- UI is a modal behind `productFeedbackAvailable()`, not a route/page. It calls `authenticatedApi.productFeedbackAvailable()` and hides entirely when unavailable (`ProductFeedbackButton.tsx:31-49`).
- The modal supports only `kind: 'bug' | 'feedback'`, title, description, and consent flags (`ProductFeedbackButton.tsx:88-105`, `product-feedback.ts:12-60`).
- Recent feedback statuses are only the submitting user’s automation statuses and show PR link/state, not public votes/comments/details (`ProductFeedbackButton.tsx:205-214`).
- Backend explicitly gates submission/status APIs to verified Totango SSO users (`user.ts:1919-1950`), so this cannot satisfy “default-on for all users.”
- Shared API exposes only feedback automation methods, not public list/vote/comment/search RPCs (`api.ts:940-950`).

### 2. Private bug diagnostics already have useful guardrails; keep them private

- Product feedback evidence contains private submitter/email/owner, workspace transcript/activity, diagnostics, coding-session summaries, and a 30-day expiry (`coding-sessions.ts:190-232`).
- Workspace evidence is owner-only and omits transcript/activity when sharing policy blocks it (`overseer.ts:7358-7379`).
- Diagnostics are captured only in a bounded current-tab ring buffer and only included when the user opts in (`productFeedbackDiagnostics.ts:7-12`, `productFeedbackDiagnostics.ts:40-57`, `ProductFeedbackButton.tsx:189-199`).
- Generated PR bodies intentionally omit raw evidence/diagnostics and say they are retained privately for at most 30 days (`product-feedback.ts:41-64`).
- Diff safety rejects protected paths, binaries, secret-looking additions, large diffs, and evidence echoes (`product-feedback.ts:92-125`, tests at `product-feedback.test.ts:11-73`).

### 3. Reporter is separate from user-submitted bug reports

- `ErrorReporter` is a private Worker RPC capability for operational exceptions (`backend-utils/src/error-reporting.ts:27-30`, `backend-utils/src/error-reporting.ts:69-87`).
- Frontend Reporter events are explicitly untrusted diagnostics; `reportedUserId` is not authoritative (`error-reporting/src/index.ts:75-96`).
- `/api/client-errors` accepts same-origin JSON, rate-limits, normalizes, and forwards to Reporter if configured; it is not a public issue/request API (`client-errors.ts:91-153`).

### 4. Frontend nav/routes have clear insertion points

- Authenticated app chrome wraps all normal routes in `AppShell` and `SessionsProvider` (`routes/__root.tsx:196-208`).
- Current public unauthenticated routes are only `/signup` and `/blueprint/*` (`routes/__root.tsx:32-39`, `routes/__root.tsx:72-91`).
- Sidebar primary nav currently has Ask, History, Library, and dynamic gatekeeper apps; feedback is a pinned button at bottom, not a nav destination (`Sidebar.tsx:170-246`).
- TanStack route tree is generated and must be regenerated when adding a file route (`routeTree.gen.ts:7-9`, `routeTree.gen.ts:11-28`).

### 5. Existing Work Items UI provides reusable patterns, but not storage for this feature

- Work Items has search/list/detail/comments/activity abstractions for Jira/Zendesk (`types.d.ts:45-68`, `types.d.ts:165-183`, `types.d.ts:247-301`).
- It has public/internal comment visibility semantics that are useful precedent (`types.d.ts:344-351`).
- Its storage is per auto-provisioned account and only stores saved views (`work-items.ts:48-78`); it is not a deployment-wide public request store.
- Work Items shell exposes only a readiness singleton to agents; search/mutation goes through provider-specific capabilities, not a community API (`work-items.ts:90-115`).

### 6. Existing Auto-Build/product-feedback automation does not match the requested Auto-Build shape

- Product feedback currently uses a dedicated `ProductFeedbackSandbox`, not an existing user Code Session (`sessions.ts:373-399`, `sessions.ts:2690-2714`).
- It clones `totango/odie-os`, runs `opencode run --pure --auto`, validates a tiny diff, pushes a branch, opens a draft PR, then notifies Slack (`sessions.ts:2701-2729`, `sessions.ts:2731-2788`, `sessions.ts:2792-2829`).
- Code Sessions already have display-safe development application lifecycle snapshots (`api.ts:571-598`, `development-supervisor.ts:160-188`) and application listener specs (`development-catalog.ts:49-55`), but no request-linked Auto-Build run entity.
- Gatekeeper apps can request a coding session handoff for Work Items today (`GatekeeperAppPage.tsx:106-109`, `SandboxedGatekeeperApp.tsx:261-272`), useful as a pattern for a request page’s “Build this” entry point.

## Source Map

| Area | Files / symbols |
|---|---|
| Existing feedback UI | `ProductFeedbackButton`, `ProductFeedbackModal` in `packages/workshop-frontend/src/ProductFeedbackButton.tsx:17-234` |
| Existing feedback RPC | `AuthenticatedApi.productFeedbackAvailable/submit/list/get` in `packages/workshop-shared/src/api.ts:940-950`; implementation in `packages/workshop-backend/src/user.ts:1919-1999` |
| Private evidence model | `ProductFeedbackEvidenceBundle` in `packages/workshop-shared/src/coding-sessions.ts:190-232` |
| Automation worker | `ProductFeedbackSandbox`, `submitProductFeedback`, `#resumeFeedbackJob`, `notifyFeedbackSlack` in `packages/gatekeeper-sessions/src/sessions.ts:373-399`, `2636-2829`, `3452-3459` |
| PR/slack safety | `packages/gatekeeper-sessions/src/product-feedback.ts:41-204`; JARVIS notifier validation in `packages/gatekeeper-jarvis/src/index.ts:83-134`, `349-382` |
| Nav/routes | `packages/workshop-frontend/src/routes/__root.tsx:32-39`, `196-208`; `Sidebar.tsx:170-246`; `routeTree.gen.ts:7-28` |
| Existing search/comments patterns | `packages/gatekeeper-work-items/src/types.d.ts:45-68`, `165-183`, `247-301`, `344-351`; UI search state in `WorkItemsPage.tsx:115-260` |
| Storage/migrations | `makeUserStorage` in `user.ts:336-414`; `AdminSettings` storage in `admin-settings.ts:33-74`; backend DO migrations in `wrangler.jsonc:45-68` and production override `wrangler.odie-os-production.jsonc:57-63` |

## Safe Candidate Data Model

**Inference / recommendation:** implement a new deployment-scoped community request store in `workshop-backend`, not in `gatekeeper-sessions`, because the list/vote/comment UX is core Workshop product state and should be available even when product-feedback automation or coding sessions are unavailable.

Public projection:

```ts
type CommunityRequestKind = "feature" | "bug";

type CommunityRequestPublic = {
  id: string;
  kind: CommunityRequestKind;
  title: string;
  summary: string;
  state: "open" | "planned" | "building" | "shipped" | "closed" | "duplicate";
  voteCount: number;
  commentCount: number;
  submitterDisplayName?: string; // product decision: anonymous vs display
  createdAt: Date;
  updatedAt: Date;
  relatedIds: string[];
  duplicateOfId?: string;
  build?: {
    state: "not-started" | "queued" | "running" | "pr-created" | "failed" | "shipped";
    codingSessionId?: string;
    runUrl?: string;
    prUrl?: string;
    completedAt?: Date;
  };
};
```

Private/semi-private records:

```ts
type CommunityRequestPrivateEvidence = {
  requestId: string;
  submitterUserId: string;
  submitterEmail: string;
  diagnostics?: ProductFeedbackEvidenceBundle; // never public
  expiresAt: Date;
};

type CommunityRequestVote = {
  requestId: string;
  voterUserIdHash: string; // one vote per deployment user without exposing email
  createdAt: Date;
};

type CommunityRequestCommentPublic = {
  id: string;
  requestId: string;
  body: string;
  authorDisplayName?: string;
  createdAt: Date;
  updatedAt?: Date;
};
```

RPC candidates:

- `listCommunityRequests({ query?, kind?, state?, sort?, cursor?, limit? }): Promise<CommunityRequestPage>`
- `getCommunityRequest(id): Promise<CommunityRequestDetail | undefined>`
- `submitCommunityRequest({ kind, title, description, publicDetails, privateBugEvidenceConsent? })`
- `voteCommunityRequest(id, vote: boolean)`
- `addCommunityRequestDetails(id, body)`
- `suggestRelatedCommunityRequests({ title, description, kind }): Promise<CommunityRequestPublic[]>`
- Admin/build:
  - `startCommunityRequestBuild(id, codingSessionId?)`
  - `recordCommunityRequestBuildUpdate(id, update)`
  - `linkCommunityRequestPullRequest(id, prUrl, runUrl?)`
  - `markCommunityRequestDuplicate(id, duplicateOfId)`

## Migration and Privacy Constraints

1. **Do not publish raw bug diagnostics.** Public request rows should contain only user-authored title/summary/details that the UI labels as public. Existing diagnostics/evidence should remain private TTL-bound data (`coding-sessions.ts:190-232`, `product-feedback.ts:57`).
2. **New DO class likely needs migrations.** If using a new `CommunityRequestsDurableObject`, add it to backend exports and add migration tags in base and Odie production Wrangler configs (`server.ts:269-273`, `wrangler.jsonc:45-68`, `wrangler.odie-os-production.jsonc:57-63`).
3. **Avoid `AdminSettings` as the hot public list store.** `AdminSettings` is deployment-wide admin/configuration coordination (`admin-settings.ts:33-74`), not a high-churn community comment/vote store.
4. **Default-on means not a UI feature flag.** Existing feature flags default only Pi runtime to false (`feature-flags.ts:7-28`); this feature should be generally visible by default, with only optional admin disable/moderation controls.
5. **One-vote-per-user needs non-public identity.** Use authenticated user DO identity for enforcement, but public projections should not expose raw email unless explicitly decided.
6. **Search/related suggestions must use public text only.** Existing product-feedback evidence includes private diagnostics and workspace/coding-session details; related/duplicate matching must not index those fields.

## Upstream Integration Planning

- `git rev-list --left-right --count HEAD...upstream/main` reported `441 81`: Totango fork and upstream have substantially diverged.
- `git diff` from merge-base `1a4bb1777cf5e95fb19a5ab011e90ad7f3ca744b` showed 718 Totango-changed files, 603 upstream-changed files, 93 overlapping files, and 510 upstream-only files.
- Overlaps include high-risk core files: `packages/workshop-backend/src/user.ts`, `overseer.ts`, `server.ts`, `packages/workshop-shared/src/api.ts`, and frontend route/chat files.
- Non-overlapping upstream-only candidates include `packages/gatekeeper-kit/`, backend `connect-handoff.ts`, backend git/worktree helpers, and frontend composer refactor files; still verify package/config/lock interactions before selecting.
- **Recommendation:** integrate upstream in reviewable slices:
  1. Docs/tooling-only and no-overlap additions.
  2. Gatekeeper-kit / test infrastructure if package graph impact is acceptable.
  3. Connect handoff changes only after checking Totango OAuth/native flow customizations.
  4. Restricted-data/observer changes only with explicit review of Totango sharing/Jira/Zendesk customizations.
  5. Defer large composer/chat refactor until after community request feature, because it overlaps current nav/chat files.

## Remaining Product Decisions

1. Are public request list reads available to signed-out users, or only authenticated users?
2. Should submitter identity be public, anonymous, or “internal display name only”?
3. Can all users trigger Auto-Build, or only admins/maintainers?
4. Does Auto-Build create/use a server-owned Code Session, or require the submitter/admin to choose an existing owned Code Session?
5. Should bug submissions automatically create public request rows, or require a “make public” consent checkbox?
6. What moderation model is required: hide/delete comments, close requests, merge duplicates, spam/rate limits?
7. What Slack channel is the “PR channel” for community request completions, and should it remain the fixed JARVIS path or a new notifier?
8. How long should private bug diagnostics be retained after public request creation?

## Root Cause

The fork currently conflates “feedback” with a private Totango-only automation pipeline. There is no deployment-scoped public community request domain model or API; therefore votes, public bug list rows, duplicate suggestions, public comments/details, and request-linked Auto-Build state cannot be added safely by only widening the existing product-feedback status objects.

## Recommendations

1. **Create a new public community request capability in `workshop-backend`** — medium effort, high impact. Keep `ProductFeedbackEvidenceBundle` private and link it by `requestId` only when a bug submitter explicitly consents.
2. **Add `/requests` or `/feedback` as a first-class authenticated route and sidebar nav item** — low/medium effort, high UX impact. Keep the existing modal as either a shortcut into the page or replace it after migration.
3. **Reuse existing safety primitives, not raw evidence, for Auto-Build** — medium/high effort. Reuse coding-session lifecycle/public PR-link patterns, but store build run state on the originating community request.
4. **Integrate upstream before implementation only in small non-overlapping slices** — medium effort, risk reduction. Avoid wholesale merge into overlapped kernel/frontend route files.

## Trade-offs

| Option | Pros | Cons |
|---|---|---|
| Extend existing `ProductFeedbackStatus` | Fastest path; reuses automation | Breaks privacy model; still Totango-gated; awkward for votes/comments/search |
| New backend `CommunityRequestsDurableObject` | Clean public/private split; default-on for all users; scalable API | Requires new DO migration/export and new UI |
| Store in `AdminSettings` | Fewer new classes | Misuses admin config singleton for high-churn user data |
| Public bug rows by default | More transparent, unified list | Risk of exposing sensitive bug details unless UI forces explicit public/private separation |
| Bug rows require public consent | Safer privacy posture | Slightly more friction and fewer public duplicates to dedupe |

## Commands Run

- `git status --short --branch`
- `git rev-parse HEAD`
- `git rev-parse --abbrev-ref HEAD`
- `git remote -v`
- `git branch -avv --no-abbrev`
- `git log --oneline --decorate --graph --max-count=30 --all`
- `git rev-list --left-right --count HEAD...upstream/main`
- `git diff --name-only/name-status <merge-base>..HEAD`
- `git diff --name-only/name-status <merge-base>..upstream/main`
- `git merge-tree <merge-base> HEAD upstream/main` filtered for conflict indicators
- `grep`, `find`, `ls`, `read`, and `nl -ba ... | sed ...` for source inspection

No builds/tests were run.

## Tooling Note

One exploratory `git merge-tree ... | awk ...` command failed with `awk: towc: multibyte conversion failure` on binary merge-tree output and exit code `2`. This was not a project/source failure and did not modify the checkout; subsequent state remained unchanged with no staged files.
