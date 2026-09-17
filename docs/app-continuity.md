# App continuity

Workshop preserves a running app's document through compatible connection replacement and React Activity hide/show, while independently revoking and reacquiring its backend authority. This preserves iframe-local drafts and scroll without treating retained UI as permission to keep using an old account or capability. It is not durable draft storage: page reload, browser/process crash, document replacement, and final unmount can still lose local state.

## Two lifetimes

| Lifetime | Retained through a compatible reconnect | Ended by |
| --- | --- | --- |
| Document | iframe DOM/JavaScript, local draft, scroll, document-to-host MessagePort | Final unmount, incompatible identity, explicit app/preview/update replacement |
| Authority generation | Nothing that grants access to the old backend | Suspension, replacement, revocation, or teardown; fresh authority must be acquired |

The root **Activity remains in place**. During authentication recovery it hides the existing tree; the Suspense seam avoids replacing that tree with `null`. `useAuth` verifies `whoami()` on the selected capability before publishing it. Same-owner recovery can resume the retained tree; an owner change increments its identity key, and logout or terminal authentication error destroys it. Identity preference is in-memory and scoped to the login, not shared across logins. See [root boundary](../packages/workshop-frontend/src/routes/__root.tsx:94) and [identity verification](../packages/workshop-frontend/src/useAuth.ts:130).

Workspace opening likewise publishes its owner capability only after the metadata subscription resolves. Cleanup marks the published record inactive **before** disposing it; consumers require an active record matching both workspace ID and authenticated API. This fixes the stale-owner case where Activity retained React state containing an already-disposed `Overseer`. Unexpected reopen failure preserves the existing view for retry; terminal access/open failures clear it. See [useWorkspaceOpen](../packages/workshop-frontend/src/useWorkspaceOpen.ts:62) and its [real-stub regression](../packages/workshop-frontend/src/useWorkspaceOpen.test.tsx:81).

### Why insertion effects are used

The document listener/session needs final-unmount cleanup, not the layout/passive cleanup that Activity performs on hide. GadgetUI uses an empty-dependency insertion effect for that lifetime; layout cleanup synchronously suspends authority, and passive cleanup releases the backend. Management frames use insertion cleanup for their document-owned listener/session too. Cleanup must not set React state or call presentation helpers that use `flushSync`; iframe window capture happens separately because insertion effects precede ref attachment. See [GadgetUI](../packages/workshop-frontend/src/GadgetUI.tsx:164), [document cleanup](../packages/workshop-frontend/src/GadgetUI.tsx:261), and [management cleanup](../packages/workshop-frontend/src/SandboxedGatekeeperApp.tsx:559).

This relies on **React 19.2 implementation behavior**, not a general public API guarantee that insertion effects are a document-lifetime hook. In the installed React DOM source, `disappearLayoutEffects` disconnects layout effects, `disconnectPassiveEffect` disconnects passive effects, and `commitDeletionEffectsOnFiber` performs insertion cleanup on deletion. Source locations: `packages/workshop-frontend/node_modules/react-dom/cjs/react-dom-client.development.js:15162`, `:16207`, and `:14368`. React upgrades must rerun the [lifetime probe](../packages/workshop-frontend/src/GadgetUseView.continuity.test.tsx:24) and real-browser hide/show and hidden-unmount regressions; do not infer compatibility from type checking alone.

## Bridge and revocation rules

- **One-shot bootstrap:** GadgetUI accepts the expected iframe window, opaque `null` origin, and document ID. A duplicate handshake cannot replace its working port. Only the first authorized backend acquisition may hold immediate module-level calls, bounded by the 20-second acquisition timeout. Failure, suspension, or a manual retry permanently cancels that wait. Later reconnect-gap calls fail fast rather than accumulating for replay. Acquisition has up to five automatic retries, with capped backoff; the UI also offers **Retry connection**. [Handshake and dispatch](../packages/workshop-frontend/src/gadget-bridge.ts:121), [acquisition](../packages/workshop-frontend/src/gadget-bridge.ts:71).
- **Descendants are revoked too:** A generation-scoped local RPC session pair sits between the document bridge and backend. Closing it revokes escaped child capabilities and callbacks, not merely the root reference. Late acquisitions are disposed. A surviving document must reacquire child stubs and subscriptions from the fresh root and dispose obsolete stubs; old descendants do not become valid again after recovery. [Gadget membrane](../packages/workshop-frontend/src/gadget-bridge.ts:98), [management membrane](../packages/workshop-frontend/src/rateLimitedCapability.ts:64).
- **No dispatched-write replay:** Reconnecting restores authority, not arbitrary operations. A dispatched write may already have taken effect even if its reply was lost; local rejection or disposal is not server-side rollback. Do not automatically retry such writes without an application-specific idempotency/reconciliation contract.
- **Management limits survive replacement:** Stable root/dependency slots retain the document's rate window. Each management slot allows 8 concurrent calls, 600 starts/minute, and 128 pending calls. Suspension rejects queued and outstanding work, clears its timer, and closes the generation membrane; late completion cannot consume or release another generation's concurrency. Authority is checked at invocation and dispatch. Cosmetic prop churn does not replace unchanged slots. [Host slots](../packages/workshop-frontend/src/SandboxedGatekeeperApp.tsx:174), [limiter](../packages/workshop-frontend/src/rateLimitedCapability.ts:40), [regressions](../packages/workshop-frontend/src/rateLimitedCapability.test.ts:9).

Resource/configurator selection can survive a compatible recovery, but not as live authority. The modal regressions require owner verification and completed account replay before fresh acquisition, retain non-default selection during the gap, reset on owner/admin-context change, and dispose late results from superseded selections. See [modal tests](../packages/workshop-frontend/src/GatekeeperModal.test.tsx:231).

## Explicit app changes

The displayed gadget and RPC conversation branch are pinned. Automatic candidate/proposal changes do not silently swap the running app; **Update preview** explicitly accepts a different preview. An unavailable old branch is suspended rather than rebound to a new conversation. See [selection implementation](../packages/workshop-frontend/src/GadgetEditor.tsx:68) and [branch regressions](../packages/workshop-frontend/src/GadgetEditor.continuity.test.tsx:40).

Gadget code updates mark the current document stale and offer **Reload when ready**. Management HTML changes use the same explicit acceptance model; identical HTML with fresh compatible authority does not imply a reload. Accepting an update intentionally replaces the document and can discard unsaved local state. See [GadgetUI update flow](../packages/workshop-frontend/src/GadgetUI.tsx:173) and [management update flow](../packages/workshop-frontend/src/SandboxedGatekeeperApp.tsx:428).

## Diagnostics and verification

Keep three different symptoms separate:

1. An extension-style asynchronous-message/channel-closed console message is **unattributed** without a source URL/stack or isolated reproduction. It is not evidence of a Workshop bridge failure by itself.
2. A disposed-stub error after reveal can be the stale owner-capability bug described above. Inspect owner publication/invalidation and current generation, not just iframe reload behavior.
3. A fresh UI boot means document replacement. The browser harness records a boot beacon, unique document token, draft, scroll, and successful RPC read: unchanged DOM alone does not prove the bridge works. Its session ledger counts explicit sessions/disposals, not heap retention or production telemetry.

The [browser README](../packages/workshop-frontend/browser/README.md:60) records the original five-case before/after baseline at revision `52577672252eab20208b3e0d57b97c4cf1efaeba`: **1 passed, 4 failed**. Slow gadget replacement and management capability replacement rebooted documents; both Activity cases retained documents but lost working RPC.

The completed local browser verification passed **12 cases**, including gated initial bootstrap, hidden-first cancellation, a 60-second wall-clock outage, 100 reconnect/hide/show cycles, hidden final unmount on both surfaces, and explicit management HTML-update acceptance. Live sessions remained **5 → 5** across the cycle test and reached zero after teardown. These are regression tests, not verified production reliability metrics. The harness uses real components and Cap'n Web but synthetic authority, not a complete deployed WebSocket/auth/backend end-to-end test. CI must verify the final PR revision independently. See [extended evidence and limits](../packages/workshop-frontend/browser/README.md:90).

Run from the repository root:

```sh
# Named frontend unit/component suite
pnpm --filter @gadgets/workshop-frontend test:run

# Real-browser Playwright suite (install the browser once)
pnpm --filter @gadgets/workshop-frontend exec playwright install chromium
pnpm --filter @gadgets/workshop-frontend test:browser:continuity

# Repository validation
pnpm lint
pnpm test
```

The separate [Browser continuity (Chromium) CI job](../.github/workflows/ci.yml:16) installs Chromium with system dependencies, runs on PRs and main pushes, and retains failure artifacts for seven days. Branch protection must require the job for it to block merging. See the browser README for an installed-Chrome alternative and preserving before/after artifacts. Commands and test coverage here are not a claim that this documentation pass ran them.

## Rollout and rollback

Ship through the existing PR review, CI, and deployment workflow only. Require frontend, browser, lint/type-check, and repository-test evidence for the final feature revision before release; this documentation task performs **no production deployment**. Use the existing [deployment guide](github-actions-deployment.md), not an ad hoc production operation.

Rollback by reverting the continuity feature commits through the same reviewed CI/deploy path. This frontend lifecycle change requires **no data migration**. A rollback can restore the earlier reload/disconnected-bridge behavior and cannot recover drafts already lost to document destruction.
