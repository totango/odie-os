## Summary

Planning-only research completed at initial `HEAD 248cc75eda989d5ddc93507518a0bf284065e93f`; no source/config files were edited, no dependencies installed, and no build/test commands were run. Existing Code Sessions are an authenticated, owner-bound GitHub-repository sandbox mechanism, while the existing product-feedback automation is a separate internal, per-user, `odie-os`-only PR bot path—not a public feature-request/bug ledger with votes, duplicate suggestions, originating-request provenance, or “use an existing Code Session” semantics.

## Hugin Anchor

Before implementation, anchor on this constraint: **do not treat the existing product-feedback PR bot as the requested public request system.** It is useful evidence and can provide seams, but the requested feature needs a public, multi-user request/bug record model plus an automation-run model that can reference a Code Session/run/PR/Slack notification idempotently.

## Analysis

### Observations

- **Current checkout / upstream state**
  - `git rev-parse HEAD` returned `248cc75eda989d5ddc93507518a0bf284065e93f`.
  - `git status --porcelain=v1` shows only existing untracked `.oculus/` and `.pi/`.
  - `git rev-list --left-right --count HEAD...upstream/main` returned `441 81`; relevant upstream drift touches `workshop-backend`, `workshop-frontend`, `workshop-shared`, `gatekeeper-slack`, and many generated/config files. This supports a selective upstream-integration phase before feature work.

- **Code Sessions public API exists, but it is repo/session oriented**
  - `AuthenticatedApi` exposes Code Session lifecycle and capability APIs: list, preflight, create, restart/stop/archive, terminal/editor/OpenCode/Pi/application capabilities, upload, and coding-session activity approval APIs (`packages/workshop-shared/src/api.ts:869-938`).
  - Creation takes selected GitHub repositories, runtime, optional Pi workbench, and optional development stack (`packages/workshop-shared/src/api.ts:627-639`).
  - The private Sessions service mirrors those methods for an authenticated `CodingSessionOwner` (`packages/workshop-shared/src/coding-sessions.ts:277-338`).

- **Code Sessions build/check out GitHub repositories, not Gadgets**
  - Session startup clones `https://github.com/totango/<repository>.git` into `/workspace/<repository>` and later runs the selected runtime in that repository (`packages/gatekeeper-sessions/src/sessions.ts:1045-1058`, `packages/gatekeeper-sessions/src/sessions.ts:1085-1118`).
  - `openCodeCommand(repository)` runs `opencode` in `/workspace/<repository>` (`packages/gatekeeper-sessions/src/runtime.ts:137-143`).
  - Separately, the in-workspace agent prompt describes Gadgets as sandboxed `client.js` / `server.js` workpieces, with `executeCode` as a one-off sandbox over chat bindings, not the Code Session repo sandbox (`packages/workshop-backend/src/agent.ts:494-538`, `packages/workshop-backend/src/agent.ts:810-824`).
  - **Inference:** Code Sessions are the right substrate for platform-repo changes/PRs, but not for directly “building Gadgets” unless a future integration explicitly bridges a public request record to a repo session.

- **Existing product-feedback automation is internal and private**
  - Product feedback is only available to verified internal Totango SSO users, because `productFeedbackAvailable()` delegates to `isTeamPiCodexEligibleUser(...)`, which requires no password login and a `totango.com` identity (`packages/workshop-backend/src/user.ts:1941-1950`, `packages/workshop-backend/src/team-pi-codex-models.ts:47-53`).
  - UI hides the feedback button when `productFeedbackAvailable()` is false (`packages/workshop-frontend/src/ProductFeedbackButton.tsx:31-48`).
  - Submitted feedback/bugs produce per-user statuses only through `listProductFeedbackStatuses()` / `getProductFeedbackStatus()` (`packages/workshop-shared/src/api.ts:940-950`, `packages/gatekeeper-sessions/src/sessions.ts:2660-2671`).
  - The current `ProductFeedbackStatus` has only `id`, `kind`, `title`, `state`, optional `prUrl`, optional `message`, and timestamps—no public vote count, details thread, duplicate links, related IDs, Slack permalink, Code Session ID, or automation run URL (`packages/workshop-shared/src/product-feedback.ts:63-80`).

- **Existing product-feedback automation does not use an existing user Code Session**
  - It creates/uses a dedicated `ProductFeedbackSandbox` with internet disabled and only `github.com` / `team-pi-proxy.unison.totango.com` allowed (`packages/gatekeeper-sessions/src/sessions.ts:373-377`).
  - It hard-codes the target repository to `odie-os` and branch prefix `feedback/` (`packages/gatekeeper-sessions/src/product-feedback.ts:5-8`).
  - It clones `totango/odie-os`, writes sanitized evidence/prompt files, runs `opencode run --pure --auto --model openai/gpt-6-astra`, validates the diff, publishes a branch, and creates a draft PR (`packages/gatekeeper-sessions/src/sessions.ts:2690-2801`).
  - **Inference:** This path is a safe PR-bot precedent, but it does not satisfy “Auto-Build uses existing Code Session” without a new integration seam.

- **GitHub PR provenance exists only for the PR bot path**
  - PR creation searches for an existing PR by branch, otherwise creates a draft PR against `main`, with a private-evidence-safe title/body, then assigns a fixed owner (`packages/gatekeeper-sessions/src/product-feedback.ts:157-192`).
  - Diff guardrails reject protected paths, binaries/mode changes, secret-looking additions, too many files/lines, and echoes of private evidence (`packages/gatekeeper-sessions/src/product-feedback.ts:92-125`).
  - Public status strips internal branch, PR number, sandbox IDs, stage, Slack attempts, and change summary (`packages/gatekeeper-sessions/src/sessions.ts:3413-3426`).
  - **Unknown:** Whether a future user-owned Code Session should reuse GitHub App installation tokens, user GitHub credentials, or a new server-owned automation actor for branch/PR provenance.

- **Slack delivery exists through JARVIS, not the Slack gatekeeper**
  - The Slack gatekeeper’s agent-facing API is read-only: workspace/conversation/thread methods list/read/search Slack data (`packages/gatekeeper-slack/src/types.d.ts:119-184`), and its OAuth scopes are read/search oriented (`packages/gatekeeper-slack/src/slack.ts:100-149`).
  - Product feedback PR notifications use a private JARVIS notifier, validating a fixed GitHub PR URL, fixed channel, fixed message template, and matching idempotency key (`packages/gatekeeper-jarvis/src/index.ts:88-132`, `packages/gatekeeper-jarvis/src/index.ts:347-384`).
  - Current Slack text is only `Draft product-feedback PR created: <prUrl>`; it does not link an originating public request (`packages/gatekeeper-jarvis/src/index.ts:129-132`).

- **Retries, polling, logging, and lifecycle already have usable patterns**
  - Product-feedback jobs are durable `feedback:<id>` plus private `feedback-evidence:<id>` records, with a 30-day TTL (`packages/workshop-backend/src/user.ts:1953-1999`, `packages/gatekeeper-sessions/src/sessions.ts:2636-2657`).
  - Registry alarms retry durable lifecycle work and feedback jobs; feedback exhausts after attempts, while Slack notification separately retries up to 3 attempts (`packages/gatekeeper-sessions/src/sessions.ts:1192-1261`, `packages/gatekeeper-sessions/src/sessions.ts:2802-2821`).
  - The frontend polls queued/running product-feedback status every 5 seconds; no server push/callback exists for feedback status (`packages/workshop-frontend/src/ProductFeedbackButton.tsx:109-116`).
  - Logging uses structured event names for session startup, retries, cleanup, feedback Slack failures, and sandbox cleanup (`packages/gatekeeper-sessions/src/sessions.ts:1237-1259`, `packages/gatekeeper-sessions/src/sessions.ts:2815-2817`, `packages/gatekeeper-sessions/src/sessions.ts:3434-3449`).

### Inferences

- The minimal safe implementation seam is **not** “extend the modal”; it is a new public request/bug ledger with:
  - public list/read/search APIs;
  - private/sanitized evidence sidecar;
  - vote/details mutations with idempotency;
  - duplicate/related suggestion endpoint;
  - automation-run records that can reference Code Session ID, branch, PR, Slack notification, and final state.
- Existing product-feedback PR-bot guardrails can be reused as validation patterns, but the requested “feature generation” needs larger diffs than current PR-bot limits of 12 files / 30 changed lines (`packages/gatekeeper-sessions/src/product-feedback.ts:11-13`, `packages/gatekeeper-sessions/src/product-feedback.ts:116-118`), so it should not be silently forced through that lane.
- A “public to other users” feature cannot live in the per-user `CodingSessionRegistry` alone, because `registryFor(ctx, owner.userId)` scopes records by user (`packages/gatekeeper-sessions/src/sessions.ts:3311-3316`).

### Unknowns / Permission Questions

1. Should all authenticated users see/submit/upvote requests, or should public visibility include signed-out users?
2. Who can trigger Auto-Build: submitter, any voter, admins, or automation policy?
3. Should the automation use the submitter’s existing Code Session, create a new server-owned Code Session, or create a Code Session-like run using server credentials?
4. Which Slack “PR channel” is authoritative, and should the existing JARVIS notifier be extended or replaced with a first-class Slack write gatekeeper?
5. What public data is allowed for bugs: title/details only, sanitized diagnostics summary, workspace link, reporter identity, or none?
6. How should duplicate suggestions be powered: simple lexical search over public records, embeddings/model calls, or external issue tracker search?

## Root Cause

The fundamental gap is a **model mismatch**: current code has (a) owner-bound Code Sessions for Totango GitHub repositories and (b) an internal, per-user product-feedback PR bot. The requested feature is a public product request/bug system with collaborative voting/details plus automation-run provenance; no current API, storage model, or UI route represents that public shared object.

## Recommendations

1. **Add a public request/bug domain model before automation** — medium effort, high impact.  
   Define public `RequestSummary`, `RequestDetail`, `Vote`, `Detail/comment`, `RelatedRequest`, and private `EvidenceBundle` types in `workshop-shared`, with exact JSDoc. Store public records in a deployment/global DO, not per-user registries.

2. **Introduce an automation-run record linked to requests** — medium effort, high impact.  
   Track `requestId`, `runId`, trigger user/admin, Code Session/session generation, branch, PR URL/number, Slack delivery state/idempotency key, retries, terminal failure, and timestamps. Keep raw evidence private and TTL-bound.

3. **Keep Auto-Build behind an explicit permission gate** — low/medium effort, high impact.  
   Require an admin/policy decision on whether runs use submitter authority, server GitHub App authority, or a dedicated bot. Do not reuse the current hidden `ProductFeedbackSandbox` as if it were an “existing Code Session.”

4. **Reuse product-feedback guardrail patterns, not its narrow limits** — medium effort, medium impact.  
   Preserve protected-path, secret-echo, idempotent PR, and Slack idempotency checks, but define new limits appropriate to feature work and require Hugin/planning review before writes.

5. **Add duplicate/related suggestions as a read-only seam first** — low effort, medium impact.  
   Start with title/details lexical matching over public records at draft/submit time; later upgrade to embeddings/model ranking only after privacy and cost decisions.

6. **Delay large upstream integration until selective conflict triage** — high effort, high impact.  
   Upstream has large overlapping changes in `workshop-backend`, `workshop-frontend`, `workshop-shared`, and gatekeepers. Selectively integrate mechanical/tooling and non-conflicting fixes first; isolate Totango-specific sessions/product-feedback/JARVIS changes from upstream replacements.

## Trade-offs

| Option | Pros | Cons |
|---|---|---|
| Extend current product-feedback modal/status | Fastest UI path; reuses existing PR bot | Still private/per-user/internal; no public votes/details; wrong automation semantics |
| New global request/bug registry + automation runs | Matches requested feature; clean provenance/idempotency | More API/storage/UI work; needs permission decisions |
| Use existing user Code Session for Auto-Build | Aligns with user request wording; visible run context | Harder authority model; user sessions are ephemeral and owner-bound |
| Use server-owned PR bot sandbox | Existing precedent and guardrails | Does not satisfy “existing Code Session”; risks hidden automation surprise |

## References

- `packages/workshop-shared/src/api.ts:869-950` — authenticated Code Session and product-feedback API surface.
- `packages/workshop-shared/src/coding-sessions.ts:277-338` — private Sessions service lifecycle and feedback methods.
- `packages/workshop-shared/src/product-feedback.ts:63-80` — current status shape lacks public votes/details/run/Slack provenance.
- `packages/gatekeeper-sessions/src/sessions.ts:373-377` — product-feedback sandbox is separate and deny-by-default.
- `packages/gatekeeper-sessions/src/sessions.ts:2690-2801` — current product-feedback automation clones `odie-os`, runs OpenCode, validates, pushes, and creates PR.
- `packages/gatekeeper-jarvis/src/index.ts:347-384` — private JARVIS Slack notifier.
- `packages/gatekeeper-slack/src/types.d.ts:119-184` — Slack gatekeeper is read-only.
- `docs/coding-session-development-stacks.md:32-45` — sandbox tier/lifecycle constraints.
- `docs/coding-session-development-stacks.md:226-232` — recommended development-stack delivery sequence.
- `docs/owner-pi-backbone.md:17-23` — Pi connection handles are short-lived owner/generation capabilities.
- Commands: `git rev-parse HEAD`, `git status --porcelain=v1`, `git rev-list --left-right --count HEAD...upstream/main`, `git diff --name-status HEAD...upstream/main -- ...`.
