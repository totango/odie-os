# Work Items Gatekeeper Shell

Provider-neutral, auto-provisioned Work Items management shell. The package owns only shell-local UI state: saved views and optional operational imports of saved views. It does not store Jira or Zendesk credentials, call provider HTTP APIs, or mint cross-gatekeeper server authority.

## Composition contract

The Workshop hosts this app as the visible shell with `composition: { kind: "work-items" }`. The iframe asks the Workshop host for `listCapabilities()` and `getCapability(id)`, then composes embedded-only source apps whose metadata is exactly:

- Jira: `{ kind: "work-items", role: "jira", embeddedOnly: true }`
- Zendesk: `{ kind: "work-items", role: "zendesk", embeddedOnly: true }`

Each source capability must implement `WorkItemsSourceManagementApi` from `src/types.d.ts`: `getCurrentUser`, `getSourceStatuses`, `search`, and `item`. Each per-item capability returned by `item()` must implement the full direct `WorkItemManagementApi` contract: `read`, `addComment`, `updateFields`, `transition`, `readAttachment`, `mediaCapabilities`, `createAttachment`, and `linkTo`. Missing source methods are isolated as disconnected contract errors so one healthy provider can continue. Missing per-item methods fail that item selection. Unavailable sources are tolerated only when the Workshop lists a source but `getCapability(id)` returns `null`, or when a method throws during a provider operation; those become source health or partial-search failures.

Source adapters must advertise provider options accurately. For example, a Zendesk adapter should return no transitions when transitions are unsupported, and unsupported operations must reject rather than returning placeholder success. The shell forwards direct management API results and does not unwrap queued action envelopes.

The shell derives the My Work identity from source `getCurrentUser()` results in the iframe composition layer. The server intentionally exposes no `setCurrentUser` UI method, because the iframe is not an identity authority.

## Agent and coding-session authority

This shell is UI-only. Provider gatekeepers own their own agent-facing sessions, approval queues, coding-session tool catalogs, and provider-specific credentials. The shell's singleton `WorkItemsSession` is only a lightweight readiness marker for discovery; it does not proxy provider operations server-side.

## Saved-view migration

Saved views are bounded to 80 normalized entries. For operational migrations from another shell, the UI metadata capability exposes `importSavedViews(views)`, which replaces the shell's saved views after applying the same normalization, de-duplication by id, and bounds as ordinary saves. The operation is idempotent for already-normalized input. Orchestrators should call it once with user-approved exported view JSON; the shell does not read legacy provider storage by itself and does not infer saved views from provider accounts.

## Build notes

`src/types.txt` must remain a symlink to `types.d.ts`. `src/generated/app.txt` is generated from `app/` by `node build-app.mjs` and committed as package-local data for the Worker text module rule.
