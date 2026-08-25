# Coding session development stacks

Status: design investigation, 2026-08-24

This document defines how an Odie coding session can run a useful subset of the Totango Agentic product, from one hot-reload frontend through a complete local development graph. It records current repository evidence and the platform boundaries that an implementation must enforce. It is not an assertion that every profile already runs in production.

Repository revisions inspected for this design:

- `totango/agentic@04afee2b1e21233f155841f553946204847c3fda`
- `totango/leviosa-backend@0cb1665973efd61ad400971e8aa2ca310f85c029`
- `totango/unison-integrations@7b7caeaa05ea9a3b77a23fe0a5b6cfa52531d1c4`
- `totango/unison-frontend@48028b0109b9c12ba1a4b94c43423c013f9f875d`

## Goals

- Let a user choose a known development profile or individual components before starting a session.
- Resolve dependencies, capacity, ports, initialization, and readiness before launching work.
- Support HTTP, WebSocket, SSE, and hot-reload previews without exposing Workshop or editor authority.
- Keep databases and native service ports private.
- Use synthetic local data or explicitly selected shared-development services.
- Stop, revoke, and clean up every resource with the sandbox generation.

## Non-goals

- A repository file does not authorize secrets, new egress, arbitrary images, or a public port.
- "Complete" does not mean every Leviosa Temporal worker. Workers are selected by the product scenario.
- Shared development Auth0 users are not created from a coding sandbox.
- A process that starts is not considered healthy until its declared readiness check passes.

## Current platform boundaries

Production coding sessions currently use one `standard-1` Cloudflare Container per sandbox generation: 0.5 vCPU, 4 GiB RAM, and 8 GB ephemeral disk. The public instance tiers are:

| Tier | vCPU | Memory | Disk |
| --- | ---: | ---: | ---: |
| `standard-1` | 0.5 | 4 GiB | 8 GB |
| `standard-2` | 1 | 6 GiB | 12 GB |
| `standard-3` | 2 | 8 GiB | 16 GB |
| `standard-4` | 4 | 12 GiB | 20 GB |

The instance type is fixed by its container binding. A running sandbox cannot be resized. Odie therefore needs separate container pools and must choose a tier before creating a session generation.

A background process does not keep the current sandbox alive. After ten minutes without platform activity the container can stop, and its process IDs and writable disk disappear. A development-stack implementation must either accept that disposable lifecycle, deliberately extend/keep alive a bounded heavy session, or checkpoint cleanly stopped data. Checkpointing is not currently provisioned: the Worker and Wrangler configs have no R2 backup binding. Even after one is added, failure or rollout cannot guarantee a clean database checkpoint. FUSE/object storage is not suitable for live Postgres or ClickHouse files.

The coding-session package uses the Sandbox 1.0 preview line (`@cloudflare/sandbox` `0.13.0-next.724.1`). New work must use its argv/process-handle API and the matching digest-pinned image. Stable Sandbox examples are not compatible.

## Trusted stack catalog

Odie should own a versioned catalog of reviewed components and profiles. A repository may contain a suggested manifest, but it is untrusted input until the user or deployment policy selects a reviewed catalog entry.

Each component declares:

- stable component ID and revision;
- required repositories;
- exact command and working directory;
- dependency component IDs;
- required capacity and disk headroom;
- private and preview port allocations;
- non-secret environment names and capability-backed integrations;
- migration, seed, and initialization jobs;
- readiness and liveness checks;
- bounded logs, restart policy, and stop order;
- whether data is disposable or checkpointable.

The planner resolves the dependency DAG and rejects port collisions, missing repositories, missing configuration, or capacity beyond the selected pool before starting anything. Mutable `latest` images found in current compose files must be digest-pinned before a profile is approved.

## Composable profiles

| Profile | Components | Hard dependencies | Suggested capacity | Main use |
| --- | --- | --- | --- | --- |
| `frontend-shared` | Unison Vite on 5001 | Shared dev GraphQL, Agentic API, Auth0 | `standard-3` candidate; native benchmark required | Fast UI work with shared dev data |
| `agentic-core` | Agentic Postgres/Timescale, Redis Stack, MCP, API, gateway | DB health and migrations; catalog policy starts healthy MCP before API/gateway | `standard-2/3` candidate; benchmark required | Odie chat, tools, approvals, realtime, reports |
| `leviosa-graphql` | Leviosa Postgres, Redis, GraphQL process | DB health and migrations | `standard-2/3` candidate; benchmark required | Core Unison data plane |
| `temporal-workflows` | Temporal Postgres, Temporal, optional UI, selected workers | Namespace/search initialization and scenario-specific DBs | `standard-2/3` candidate; benchmark required | Async workflows and schedules |
| `data-odi-clickhouse` | Shared ClickHouse plus selected migrations/projection workers | ClickHouse readiness; workers add Temporal and source DBs | `standard-2/3` candidate; benchmark required | ODI, semantic and product-usage analytics |
| `integrations` | Integrations Postgres, Timescale, Redis, LocalStack, API, one worker | Migrations, Timescale views, S3 bucket, Temporal; ClickHouse when selected | `standard-3/4` candidate; benchmark required | Connector provisioning and ingestion |
| `complete-local` | Union of the above plus frontend | Ordered init jobs and selected workers | External environment by default | Full product scenarios |

The only measured idle infrastructure floor was about 1.8 GiB in an existing shared stack, before Node APIs, workers, frontend processes, builds, or fresh data. ClickHouse alone used about 1.3 GiB there. This was not a clean full-graph benchmark. Eight GiB is an optimistic minimum operating estimate; 12–16 GiB is recommended during builds/work. Current image caches indicate a 20–30 GB disk budget once repositories, dependencies, images, and fresh volumes are included. That exceeds safe headroom on the public `standard-4` limit. Odie must not advertise a reliable full-local profile in one Cloudflare sandbox until a clean benchmark fits with margin.

Recommended execution policy:

- begin the shared-dev frontend profile on `standard-3`; its observed peak already exceeds `standard-1`, and `standard-2` lacks safe memory/disk headroom;
- use benchmark-selected `standard-2/3` pools for curated local subsets;
- reserve `standard-4` for measured, opt-in combinations with a lower concurrency quota;
- provision external ephemeral infrastructure, or obtain a larger approved instance class, for the full graph.

Rootless Docker-in-Docker is supported by Cloudflare only with iptables disabled and host networking. Existing compose service DNS and isolated networks therefore do not work unchanged. Host networking also disables ordinary `ports:`/`-p` NAT mappings: each daemon must bind its allocated canonical host port itself, or a supervised user-space proxy must do so. The current image has no dockerd, and the published stable DinD recipe cannot be copied into this Sandbox-next package line. Before DinD is listed as available, a digest-pinned image using the exact matching next runtime must prove rootless daemon startup, host networking, cgroup limits, supervision, and shutdown in deployment.

Runtime image pulls are blocked by the current outbound allowlist. A DinD profile must pre-bake reviewed digest-pinned images or introduce narrowly reviewed registry egress; repository-selected arbitrary pulls are not allowed. DinD duplicates image/storage overhead and remains a compatibility pool, not the default architecture. Curated native processes or an external ephemeral namespace are preferred.

External ephemeral infrastructure also needs an explicit connector. The current sandbox disables general internet access and permits only reviewed HTTP(S) hosts, so normal PostgreSQL, Redis, ClickHouse native, and Temporal endpoints are not directly reachable. A production design needs a local connector that carries those protocols through a reviewed HTTPS/WSS broker on port 443 with short-lived session capabilities, or a separately approved egress-policy change. Do not place long-lived external database credentials in untrusted session code.

The outer Sandbox VM isolates sessions, not sibling components. Native processes and mandatory DinD host networking let any repository process connect to every localhost service and scan or bind other ports. A local profile therefore combines mutually trusted components only and cannot claim per-component network capability isolation. Do not place a stronger secret beside code that is not trusted to use it.

## Service graph and canonical ports

A combined profile can use one Temporal server, one LocalStack S3 deployment, and one ClickHouse deployment, but only after reconciling each repository's contract. Temporal needs distinct `default`, `integrations`, and `odi-agents` namespaces where applicable, all required search attributes, and checks for task-queue, schedule, and workflow-ID collisions. A shared ClickHouse needs one pinned image, a reconciled user/password contract, and both repositories' init/migration sets in a deterministic and idempotent order. LocalStack likewise runs every required bucket initializer idempotently. Keep the Agentic, Leviosa, integrations, Timescale, and Temporal Postgres databases logically separate.

The following values are actual localhost listener allocations, not Docker NAT mappings. A native process or host-network DinD service must be configured to listen on that port; otherwise the catalog must start a supervised user-space proxy.

| Service | Canonical host port | Browser forwarding | Readiness |
| --- | ---: | --- | --- |
| Unison Vite | 5001 | HTTP + WebSocket (HMR) | HTTP root |
| Agentic API | 3001 | HTTP + SSE/streaming | `GET /health` |
| Agentic MCP | 3003 | HTTP when debugging | `GET /health` |
| Agentic gateway | 4400 | HTTP + WebSocket + Socket.IO + SSE | `GET /health` |
| Leviosa GraphQL/REST | 3100 | HTTP + SSE | `GET /health/ready` |
| Leviosa health/metrics | 9091 | No by default | `GET /health/live` |
| Integrations API | 3109 | HTTP when debugging | `GET /health/ready` |
| Integrations health/metrics | 9092 | No by default | `GET /health/live` |
| Integrations worker health | 9093 | No by default | declared worker check |
| Integrations debug UI | 3005 | Optional HTTP preview | HTTP root |
| Agentic Postgres | 55431 | Never | `pg_isready` |
| Leviosa Postgres | 55432 | Never | `pg_isready` |
| Integrations Timescale | 55433 | Never | `pg_isready` |
| Integrations Postgres | 55434 | Never | `pg_isready` |
| Temporal Postgres | 55435 | Never | `pg_isready` |
| Optional Catalyst Postgres | 55436 | Never | `pg_isready` |
| Agentic Redis Stack | 6381 | Never | `redis-cli ping` |
| Leviosa Redis | 6382 | Never | `redis-cli ping` |
| Integrations Redis | 6383 | Never | `redis-cli ping` |
| RedisInsight | 8002 | Optional owner-only DB management | HTTP root |
| Temporal gRPC | 7233 | Never | gRPC health/Temporal CLI |
| Temporal UI | 8085 | Optional HTTP preview | HTTP root |
| LocalStack S3 | 4566 | No by default | `GET /_localstack/health` |
| ClickHouse HTTP/play | 8123 | Optional owner-only full HTTP/SQL authority | `GET /ping` |
| ClickHouse native | 9000 | Never | native client check |

This map resolves collisions in the checked-in repositories, including 5433, 5432, 6379, 7233, 8123/9000, LocalStack's broad port range, and repeated 9091 health ports. The current Agentic gateway configuration also disagrees between 3002 and 4400; the catalog must set one value explicitly rather than inherit that drift.

A listener or HTTP root is only component readiness. Each profile also needs an end-to-end smoke check. For `frontend-shared`, that check must cover the remote preview origin, Auth0 callback/logout, API CORS, authenticated GraphQL, and Agentic API access.

## Profile details

### Frontend against shared development

No local database or backend is required. The profile clones `totango/agentic`, installs its pinned dependencies, writes only the reviewed public `dev` frontend variables to an ignored local environment file, and starts:

```sh
pnpm --filter @totango/agentic-unison dev -- --host 0.0.0.0
```

The authoritative Vite port is 5001. A disposable amd64-emulated benchmark of the current immutable session image found:

- a 1.34 GiB unpacked base image;
- a 7.4 GiB checkout after the 3,195-package install and Vite optimizer activity;
- a Vite-ready response in about 2.9 seconds after installation;
- a cgroup peak above 5.2 GiB that was still rising during dependency optimization.

These measurements make `standard-3` the initial candidate, subject to a native Cloudflare/Node 24 benchmark. The image needs pinned Node 24.14.x and pnpm 10.22.0; its current base provides Node 22 and no pnpm. Installation also reads a private `@totango` GitHub Package. Odie must authorize that through a method- and path-restricted Worker-side package credential proxy, using a synthetic sandbox credential. It must not place a reusable `GIT_NPM_TOKEN` in sandbox files or environment variables.

Unison uses `redirect_uri: window.location.origin`. Its remote preview origin must therefore be registered as an allowed callback, logout, and web origin in the development Auth0 SPA. The Agentic dev API must allow the same origin. Odie injects public endpoints and the public Auth0 client configuration, never tenant-management credentials or backend secrets.

`demo.user@totango.com` is treated by the frontend as an expected seeded identity, but repository evidence does not prove its current Auth0 state or authorize distribution of a shared password. Use an account approved by the development tenant owner. Do not run Leviosa's demo workflow merely to enable frontend development because that workflow mutates the real Auth0 tenant.

### Agentic core

Agentic's committed infra starts Timescale/Postgres and Redis Stack. The core watch command starts MCP on 3003, API on 3001, and the realtime gateway. Run DB migration and optional synthetic seed before app readiness. The current app and infra compose files do not reliably share one network when launched separately; an approved catalog must use one network or host-run processes with explicit localhost ports.

### Leviosa GraphQL

Core Unison CRUD needs Leviosa Postgres, Redis, migrations, and the GraphQL process on 3100. Temporal, LocalStack, ClickHouse, and their workers are scenario components, not unconditional GraphQL dependencies. GraphQL WebSockets are disabled, but Leviosa agent routes use SSE and require unbuffered streaming.

### Temporal and data projections

Start only the workers required by a selected scenario. "All workers" forks dozens of processes and is not a useful default. ClickHouse-backed ODI and projection features require the ClickHouse component plus their exact migration/init jobs. ClickHouse and Temporal image versions currently include mutable tags and need review and digest pinning.

### Integrations

The minimal connector/landing profile needs integrations Postgres, Timescale, Redis, shared LocalStack, shared Temporal, the integrations API, and one selected worker. It deliberately skips ClickHouse-dependent migrations and features. A scenario that runs the repository's full `start:db` initialization must also depend on `data-odi-clickhouse`. Catalyst Postgres, debug UI, OAuth helpers, real Nango, and additional workers remain opt-in components.

## Preview and port-forwarding boundary

Do not reuse a browser VS Code token as a general preview token. A preview receives a narrower record containing owner, session, sandbox generation, component, port, expiry, and revocation state. Authenticate every ordinary HTTP request and every WebSocket or SSE handshake. Handshake validation cannot revoke an established long-lived stream. Unlike the current pass-through editor proxy, the preview ingress therefore needs a Durable Object or equivalent stateful relay that terminates WebSockets, owns cancellable SSE streams, and forcibly closes them on expiry, revocation, generation change, and shutdown.

Use a unique hostname per preview, such as:

```text
https://<opaque-preview-id>.preview.example.com/
```

A hostname proxy preserves root-relative assets, cookies, redirects, service workers, Vite/Next HMR, Socket.IO, and SSE without rewriting application content. It also isolates browser storage between applications and generations. The gateway must set no-store and no-referrer, reject unregistered ports, preserve streaming, revoke before process shutdown, and terminate its tracked long-lived transports.

Cloudflare's built-in exposed-port URLs are public bearer URLs unless wrapped by this authorization boundary. Quick tunnels are also public bearer endpoints and are not the production solution. The current Odie Cloudflare account has no DNS zone, so a wildcard preview hostname requires a delegated/custom preview domain or an equivalent approved ingress service before this design can ship. A fixed origin reused across untrusted sessions is not equivalent because service workers and browser storage survive generation changes.

Dynamic Unison origins add a separate authentication gate. The development Auth0 tenant must approve a wildcard callback/logout/web-origin rule that exactly covers the delegated preview domain, or Odie must provide a stable callback broker. Agentic and GraphQL CORS must accept the same authenticated origin pattern. The sandbox never receives Auth0 management authority, so this cannot be performed ad hoc for each generated preview.

Internal Postgres, Redis, Temporal gRPC, and ClickHouse native ports are never browser previews. The planner exposes only catalog-declared HTTP applications, and the user can see and revoke every active preview in a Running apps panel. Port 8123 grants ClickHouse HTTP SQL authority, and RedisInsight grants database-management authority; neither is a harmless static UI. If offered, each is owner-only and explicitly labeled with that authority rather than treated as an ordinary shareable preview.

## Lifecycle and control plane

The session registry should persist desired component specs and generation identity, not only process IDs. The supervisor then reconciles current Sandbox process handles and readiness:

1. validate repositories, profile, capacity, egress, and non-secret configuration;
2. allocate collision-free private and preview ports;
3. start dependencies and wait for real readiness;
4. run one-shot migrations/init/seed jobs idempotently;
5. start selected APIs/workers/apps with bounded logs and restart budgets;
6. register narrow preview capabilities only after readiness;
7. show pending, ready, degraded, failed, and stopped states in the UI;
8. on stop/restart/archive, revoke previews and close tracked WS/SSE transports first, stop dependents before dependencies, checkpoint only after clean DB shutdown when enabled, and destroy the generation;
9. sweep leaked external namespaces, preview records, and stuck operations.

The dark supervisor foundation implements this lifecycle without enabling a component. Each selected development generation stores a detached, recursively frozen copy of its validated server catalog authority in `CodingSessionPolicy`; public session records keep only display selection. The policy verifies the persisted primary terminal with non-waking Sandbox discovery before component filesystem or process calls. It checkpoints a deterministic reserved `ODIE_SUPERVISION_MARKER` wrapper before each launch, adopts only one exact command/cwd match after a lost response, and fails the generation rather than risk a duplicate when provenance is ambiguous. One-shot jobs must declare `idempotent: true`, have a remote timeout, and persist both a container marker and durable completion state.

Readiness and liveness consume bounded restart budgets. Private component log tails share a per-component maximum of 64 KiB and 2,000 lines and are never included in public status. Public errors are fixed server-authored messages. The reader-first foundation understands durable configure/schedule work before its first policy RPC, and an exact generation cancellation tombstone prevents a delayed startup RPC from recreating work after stop. `CODING_SESSION_DURABLE_LIFECYCLE_ENABLED` gates every new start/stop writer and remains unset in this foundation deployment, so rollback cannot strand a record that the previous Worker does not understand. A later Odie-only activation sets it only after this reader is the verified rollback target. Once enabled, stop and restart serialize against startup and reconciliation, clean services in reverse topology with confirmed TERM/KILL exits, then cross separate cancel, cleanup, destroy, capacity release/transfer, and scheduling checkpoints. Component failure never destroys the primary terminal. All catalog components, profiles, heavy tiers, images, configuration sources, and previews remain unavailable until their later activation gates are satisfied.

Heavy profiles should have a lower per-user and deployment concurrency limit, wall-clock TTL, disk watermark, log limit, and cost telemetry. A session that disconnects must not silently claim its ephemeral databases will survive a container stop or rollout.

## Recommended delivery sequence

1. **Catalog and planner:** checked, display-only plans for reviewed profiles, dependency/capacity resolution, and canonical port allocation.
2. **Isolated preview gateway:** delegated wildcard domain, tenant-approved Auth0/CORS strategy, Durable Object transport relay, HTTP/WS/SSE and HMR tests, generation revocation, and a Running apps panel.
3. **Frontend-shared profile:** pinned Node 24/pnpm image tools, Worker-side GitHub Packages credential proxy, `standard-3` native benchmark, public dev configuration, Unison Vite, dev Auth0/CORS registration, and production-like browser verification.
4. **Curated local subsets:** Agentic core, Leviosa GraphQL, Temporal, and ClickHouse as independently selectable components on measured larger pools.
5. **Full-stack execution:** only after a clean benchmark proves headroom; otherwise provision an external ephemeral namespace plus the reviewed 443 connector needed for narrow, short-lived protocol capabilities.

## Known repository drift to fix or override

- Agentic gateway defaults conflict between 3002 and 4400.
- Agentic app and infra compose network declarations are not a reliable combined graph.
- Leviosa docs mention Ollama, but current compose has no Ollama service.
- Leviosa and integrations compose files have few meaningful healthchecks.
- Integrations Redis documentation and compose disagree between 6380 and 6379.
- Multiple compose files use mutable `latest` images.
- Setup scripts use fixed sleeps where readiness checks are required.
- The full set of Leviosa workers is not a bounded "complete product" profile and must be scenario-selected.
