# Featured starter blueprints

This directory is the source of truth for deployment-provided starter applications. Each child
directory is built into an ownerless ordinary blueprint and added to the deployment-wide featured
collection. These starters are examples users can instantiate, inspect, and modify; they are not
special runtime application types.

For the general blueprint architecture, storage format, and user-published blueprint lifecycle, see
[`docs/blueprints.md`](../../../docs/blueprints.md).

## Product behavior

- Starters appear on **Explore** (`/explore`). The **Blueprints** page (`/blueprints`) intentionally
  lists only blueprints the current user published, uploaded, or saved. A featured starter appears
  there only after the user adds it to their library.
- Opening a starter shows the ordinary blueprint landing page and creates an independent workspace
  through `AuthenticatedApi.newGadgetFromBlueprint()`.
- A starter has no owner User Durable Object. Its stable `starter.*` ID, public KV record, R2 code
  snapshot, and featured entry are installed directly by `AdminSettings`.
- Starters are not output formats. They must never be added to `AdminConfig.formats`,
  `promotedFormatBlueprints`, or the New-output menu.
- Every starter must work without external connections. The landing page therefore has no required
  blueprint bindings and lets the user create immediately. Optional connection discovery and skip
  controls live inside the created starter.

The currently shipped starters are:

| Blueprint ID | Source directory | Purpose |
| --- | --- | --- |
| `starter.developer-delivery-kit` | `developer-delivery-kit/` | Repository health, review queues, releases, and delivery risks |
| `starter.incident-investigation-board` | `incident-investigation-board/` | Incident timeline, evidence, ownership, and decisions |
| `starter.jira-delivery-risk` | `jira-delivery-risk/` | Release risks, blockers, mitigations, and executive summaries |
| `starter.support-escalation-cockpit` | `support-escalation-cockpit/` | Support escalation triage, customer impact, and cross-functional ownership |

## Source contract

Every starter directory must contain exactly these four files. Unexpected files and nested
directories fail the build so nothing appears to be shipped while being silently omitted from the
archive.

```text
<slug>/
  blueprint.json
  client.js
  server.js
  README.md
```

`blueprint.json` fields:

| Field | Contract |
| --- | --- |
| `blueprintId` | Stable `[a-zA-Z0-9._-]+` ID. Never rename after deployment; a rename creates a new blueprint and orphans the old entry. |
| `title` | Explore and landing-page title. |
| `description` | User-facing purpose, offline behavior, and optional-connection expectations. |
| `author` | Ordinary blueprint author object. The current starters use the deployment author identity. |
| `revision` | Positive integer and archive metadata version. Increment whenever archived source or metadata changes. |
| `updatedAt` | Canonical ISO 8601 UTC timestamp, used for both archive `created` and `lastUpdated`. Update it with each revision; do not derive dates from the revision number. |
| `bindings` | Omit or use an empty array/object. Non-empty values are rejected because current starter connections are optional, while blueprint binding metadata means required pre-creation setup. |

`README.md`, `client.js`, and `server.js` are the three files copied into the Yjs code snapshot. The
sidecar is packaging metadata and is not copied into the instantiated Gadget.

## Build and archive determinism

`scripts/build-format-blueprints.mjs` packages formats and featured starters into the gitignored
`src/generated/format-blueprints.ts`. Package `build`, `types:check`, and `test` run the generator
first.

Featured archive bytes are deterministic for identical inputs:

- starter directories and archived filenames are sorted;
- the Yjs document client ID is a stable nonzero hash of the directory slug;
- gzip `mtime` is fixed to zero;
- archive dates come from explicit `updatedAt` metadata;
- the archive version comes from `revision`.

`FEATURED_BLUEPRINTS_DIR` may replace this directory at build time. It replaces the generated input
set rather than overlaying it. A missing override directory generates no featured starters; a
malformed existing directory fails the build. This does not make deployment installation
subtractive: starters installed by an older release are not automatically removed from Explore when
the next generated set omits them.

## Installation lifecycle

1. The generator emits `FEATURED_BLUEPRINTS` alongside `FORMAT_BLUEPRINTS`.
2. The first request reaching backend `/api` calls
   `AdminSettings.ensureFormatBlueprintsInstalled()` via `ctx.waitUntil()`. This method owns both
   bundled sets despite its historical name.
3. `featuredBlueprintsManifestVersion()` fingerprints each starter's ID, revision, title,
   description, and author. The featured stamp is separate from the format stamp so starter updates
   cannot trigger format promotion.
4. `installFeaturedBlueprints()` validates each ordinary archive, writes code to R2 at
   `<blueprintId>/<revision>`, and writes its ownerless public record to the `BLUEPRINTS` KV namespace.
5. `AdminSettings` merges installed entries into its typed `featuredBlueprints` collection, writes
   the reserved `.featured` KV snapshot, and preserves unrelated user-featured blueprints.
6. `AuthenticatedApi.listFeaturedBlueprints()` reads the cheap `.featured` KV snapshot used by
   Explore and by the agent blueprint catalog.

Installation is idempotent. A complete matching fingerprint costs only a string comparison. A
partial installation does not advance the stamp, allowing a later `/api` request to retry. The
module-level trigger resets after partial or thrown failures so a failed isolate is not permanently
stuck.

Installation is additive/update-only. It does not track which existing featured entries came from a
previous bundle and therefore cannot safely infer which entries to delete. To retire a starter,
remove it from the generated set and add a deliberate `AdminSettings` maintenance/migration path
that removes that exact ID from the authoritative `featuredBlueprints` collection before rewriting
the `.featured` snapshot. The ordinary admin feature toggle does not support ownerless bundled
blueprints. The old public KV/R2 snapshot may remain addressable by stable ID; retirement removes it
from discovery rather than rewriting history. Never edit or bulk-replace `.featured` directly: the
Durable Object can restore its authoritative state, and a replacement would remove user-featured
entries owned outside the bundle.

## Optional connection model

Current blueprint bindings are required setup: declaring one blocks **Create Gadget** until the user
assigns it. That is intentionally not used for these starters. Their persistent code detects only
resources the user or agent wires after creation, while manual entry, import, and demo data remain
fully functional.

Common optional binding names are:

- GitHub: `GITHUB_REPO`, `GITHUB_ISSUE`, `GITHUB_PULL_REQUEST`
- Gmail: `GMAIL_INBOX`, `GMAIL_SEARCH`, `GMAIL_LABEL`
- Linear: `LINEAR_WORKSPACE`, `LINEAR_TEAM`, `LINEAR_ISSUE`
- deployment services: `TEAM_PI`, `JARVIS`

Jira and Zendesk do not imply native gatekeepers. Route them through Team PI or a vetted MCP
connection, then store bounded normalized findings in the starter. Never fabricate live data when a
source is missing or fails.

Skip is a capability/privacy decision, not just presentation state. Once a connector is skipped:

- connection status must report `Skipped`;
- page-load snapshots and explicit sync operations must not invoke its RPC capability;
- connected-source notes must not imply the skipped source was read;
- re-enabling it is the only action that permits reads again.

## Runtime and security rules

- Keep imports and persistent collections bounded. Normalize and truncate untrusted strings, lists,
  percentages, and record counts before storage.
- Escape every untrusted value before inserting it into HTML, attributes, or inline styles. Clamp
  numeric style values independently of storage normalization.
- Consume RPC cursors through `next()` and dispose them in `finally` with
  `cursor[Symbol.dispose]()`. Dispose any nested RPC stubs returned in cursor records.
- Do not put RPC stubs in `useState()` directly. These starters currently keep their stubs outside
  React state, but any React rewrite must wrap callable stubs in a non-callable object.
- Sync must deduplicate source records and preserve manual/demo records. Missing connectors remain
  missing; errors may produce bounded status notes but never substitute invented records.
- Reset actions may be destructive only when clearly labelled. Ordinary demo refresh must not erase
  user-created records.
- Persistent code may use only explicitly bound capabilities. A starter or gatekeeper must never
  assert that a resource is ambient.

## Editing checklist

1. Make the smallest source change in the relevant starter directory.
2. Increment `revision` and set `updatedAt` to the release timestamp whenever archive bytes or
   user-visible sidecar metadata changes.
3. Keep `blueprintId` unchanged.
4. Run the generator and inspect its summary:

   ```sh
   pnpm --filter @gadgets/workshop-backend build:format-blueprints
   ```

5. Run focused and package verification:

   ```sh
   pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/format-blueprints.test.ts
   pnpm --filter @gadgets/workshop-backend test
   pnpm --filter @gadgets/workshop-backend types:check
   pnpm --filter @gadgets/workshop-frontend types:check
   pnpm lint:check
   ```

6. For UI changes, instantiate every affected starter and verify desktop/mobile rendering, create,
   edit, delete, import, demo lifecycle, skip/re-enable, sync, and malicious-string escaping.
7. Review the generated output twice or compare hashes when determinism changes. Identical inputs
   must produce identical `src/generated/format-blueprints.ts` bytes.

## Deployment and production verification

Deploy the backend Worker containing the generated module. A router/frontend deployment is needed
only when those packages changed. After deployment:

1. Confirm the intended backend version is active.
2. Send an authenticated request to `/api` to wake `AdminSettings`. The install trigger runs before
   backend authentication checks, but an edge-level access policy may prevent unauthenticated
   traffic from reaching the Worker.
3. Read only the reserved `.featured` key from the production `BLUEPRINTS` KV namespace and verify
   all expected `starter.*` IDs. Do not print unrelated metadata or secrets into logs.
4. Open `/explore`, verify all cards, open each detail page, and confirm the displayed version/date.
5. Create a Gadget without configuring connections, then verify its optional onboarding and demo
   path. Connectors should enrich only after being wired and must stop reading after Skip.

## Troubleshooting

- **Explore has no starters, but deployment succeeded:** confirm an authenticated `/api` request
  reached the backend, inspect the featured install event logs, and read `.featured` from production
  KV. Uploading a Worker version alone does not wake the singleton Durable Object.
- **A removed starter still appears in Explore:** expected until an admin explicitly unfeatures the
  previously installed ownerless blueprint through a code-backed `AdminSettings` maintenance path.
  The normal admin UI cannot do this, and omitting it from a later bundle is not a deletion signal.
- **Blueprints page is empty while Explore has starters:** expected. `/blueprints` is the current
  user's library; save a starter from Explore to add it there.
- **Landing page says no connections are required:** expected for these offline-first starters.
  Optional connections are added after creation. The copy should say “No connections required to
  start,” not imply that the Gadget cannot use connections.
- **Landing page shows 1969/1970:** the sidecar is missing or not using a valid `updatedAt`, or an old
  revision is still installed. Never synthesize dates from small revision integers.
- **A source is read after Skip:** treat as a blocking privacy bug. Check both automatic page-load
  snapshot methods and explicit sync methods, then add an RPC-call-count regression.
- **Generated output changes on a no-op rebuild:** check Yjs client IDs, ordering, gzip timestamps,
  and metadata dates before accepting the diff.
