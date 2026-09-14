# Prime/package modernization evidence — local writer slice

## Final dependency/image closure — 2026-09-14

Scope: exact proper-parent only. No overrides, resolutions, new patches, staging, commit, push, provider action, deploy, login, or image push was performed. The existing reviewed `capnweb@0.12.0` patch remains preserved.

### Direct-parent updates applied

| File | Direct parent | Before | After | Lock evidence |
|---|---|---:|---:|---|
| `packages/gatekeeper-cloudflare/package.json` | `miniflare` | `5.20260801.0-alpha` | `5.20260911.0-alpha` | `pnpm-lock.yaml` importer resolves `5.20260911.0-alpha(@types/node@26.1.0)` |
| `packages/gatekeeper-scheduler/package.json` | `miniflare` | `5.20260801.0-alpha` | `5.20260911.0-alpha` | `pnpm-lock.yaml` importer resolves `5.20260911.0-alpha(@types/node@26.1.0)` |
| `packages/gatekeeper-zendesk/package.json` | `miniflare` | `5.20260801.0-alpha` | `5.20260911.0-alpha` | `pnpm-lock.yaml` importer resolves `5.20260911.0-alpha(@types/node@26.1.0)` |
| `packages/gatekeeper-odie-kg/package.json` | `vitest` | `^4.1.10` | `^4.1.11` | no `4.1.10` remains in workspace package manifests or lock |

`grep` confirmation: no `5.20260801.0-alpha` remains in workspace package manifests or `pnpm-lock.yaml`; no `4.1.10` remains in workspace package manifests or `pnpm-lock.yaml`.

### Lock/install commands

- Strict runner SHA confirmed before protected tests: `56d83de010ec5fb47e4d1f9c6da002a9a56804f7607d7de21ad8326da551f551  /tmp/odie-restricted-sessions-evidence/run-builds-pr-candidate.py`.
- Normal public-registry lock regeneration:

```sh
NPM_CONFIG_USERCONFIG="$tmp/user-npmrc" NPM_CONFIG_GLOBALCONFIG="$tmp/global-npmrc" \
  npm_config_userconfig="$tmp/user-npmrc" npm_config_globalconfig="$tmp/global-npmrc" \
  COREPACK_ENABLE_NETWORK=1 pnpm install --lockfile-only --ignore-scripts --registry=https://registry.npmjs.org/
```

Result: passed; lockfile supply-chain policies passed; 992 packages resolved; no lifecycle scripts.

- Frozen install check:

```sh
NPM_CONFIG_USERCONFIG="$tmp/user-npmrc" NPM_CONFIG_GLOBALCONFIG="$tmp/global-npmrc" \
  npm_config_userconfig="$tmp/user-npmrc" npm_config_globalconfig="$tmp/global-npmrc" \
  COREPACK_ENABLE_NETWORK=1 pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org/
```

Result: passed; lockfile up to date.

### Strict-runner validation

All commands below ran through `/usr/bin/python3 /tmp/odie-restricted-sessions-evidence/run-builds-pr-candidate.py` after SHA verification.

| Area | Command label | Result |
|---|---|---|
| Root workflow tests | `final-dep-root-workflow-tests` | passed: 16/16 node tests |
| Cloudflare gatekeeper tests | `final-dep-cloudflare-tests` | passed: 6 node files / 89 tests, then 2 worker files / 22 tests; expected negative-path stderr only |
| Scheduler tests | `final-dep-scheduler-tests` | passed: worker 102 passed / 3 existing skipped, app 19 passed |
| Zendesk tests | `final-dep-zendesk-tests` | passed: 107 node tests + 8 worker tests; expected negative-path stderr only |
| Odie KG tests | `final-dep-odie-kg-tests` | passed: 3 files / 17 tests |
| Scheduler build | `final-dep-scheduler-build` | passed: 4 tasks, 0/4 cache hits |
| Odie KG build | `final-dep-odie-kg-build` | passed: capnweb-validate + `tsc` |
| Odie KG types | `final-dep-odie-kg-types` | passed: `tsc --noEmit` and test tsconfig |

### Audits and residuals

Strict-runner root audit remains network-denied by the runner profile, same as prior attempts: `final-dep-root-pnpm-audit-prod` ran `pnpm audit --prod --json` and failed with `fetch failed` under sandbox-exec. Strict-runner pi-image audit was also attempted both with `npm --prefix packages/gatekeeper-sessions/pi-image audit --omit=dev --json` and with an explicit `cd`; both returned exit 0/no vulnerabilities under the protected npm environment, which disagrees with the same lock audited normally against the public registry. The public-registry audit results below are therefore retained as the precise residual inventory rather than treating the protected npm mismatch as advisory clearance:

| Graph | Audit command/result | Residuals |
|---|---|---|
| Root production | `pnpm audit --prod --json --registry=https://registry.npmjs.org/` exit 1; metadata: 2 low, 5 moderate, 3 high across 647 total deps | DOMPurify 3.4.8 via Monaco (`1124022` low, `1124233` moderate, `1124234` low, `1138538` moderate); `extract-zip 2.0.1` via `@cloudflare/puppeteer>@puppeteer/browsers` (`1139346`, `1193685` high); `nanoid 3.3.16` via Vite/PostCSS (`1139427` high); `hono 4.13.1` via `@cloudflare/sandbox` (`1193729`, `1193730`, `1193731` moderate). |
| Root all deps | `pnpm audit --json --registry=https://registry.npmjs.org/` exit 1; metadata: 2 low, 5 moderate, 4 high across 992 deps | Same as root production plus dev/test `sharp 0.35.2` (`1193725` high) via current `@cloudflare/vitest-pool-workers 0.22.0`/Wrangler Miniflare paths and other Wrangler dev paths. Stale direct Miniflare `5.20260801.0-alpha` is gone. |
| Pi image production | `(cd packages/gatekeeper-sessions/pi-image && npm audit --omit=dev --json --registry=https://registry.npmjs.org/)` exit 1; metadata: 2 high across 562 total deps | `extract-zip 2.0.1` (`1139346`, `1193685` high) via official `prime-agent 0.9.4`. |

Latest-parent checks: npm reports `extract-zip` latest `2.0.1`; `@cloudflare/puppeteer` latest `1.4.0` still depends on `@puppeteer/browsers 2.2.4`; `monaco-editor` latest `0.56.0` still depends on `dompurify 3.4.8`; `@cloudflare/vitest-pool-workers` latest `0.22.0` still depends on `miniflare 5.20260815.0-alpha` and `wrangler 4.124.0`; exact direct Miniflare target `5.20260911.0-alpha` depends on `undici 7.29.0` and `sharp 0.35.4`.

### Local linux/amd64 coding-session image build and network-none smoke

Preflight/free-space: started with 22GiB free on `/System/Volumes/Data`; build monitored disk and stopped only if free space dropped below an 8GiB threshold. Build completed with 17GiB free; smoke completed with 14GiB free.

Build command used `packages/gatekeeper-sessions/Dockerfile.pi`, `--platform linux/amd64`, tag `odie-os-coding-session:local-release-candidate`, and the current exact build args: `NODE_VERSION=24.14.0`, `PNPM_PACKAGE_MANAGER=pnpm@10.22.0+sha512.bf049efe995b28f527fd2b41ae0474ce29186f7edcb3bf545087bd61fbbebb2bf75362d1307fda09c2d288e1e499787ac12d4fcb617a974718a6051f2eee741c`, `REPOSITORY_PNPM_PACKAGE_MANAGER=pnpm@11.17.0+sha512.cca3cea332ad254bb84145f966d19f4879615210346fc92c79a047f23a0d7b3cca3c3792f0076ba1f1831d277efbcf0a9119b31a9a60eca7fb3d6231f331ef72`, `OPENCODE_VERSION=1.18.30`, `PI_VERSION=0.85.1`, `PI_MCP_ADAPTER_VERSION=2.33.0`, `PRIME_AGENT_VERSION=0.9.4`, `VALHALLA_VERSION=0.3.0`, `CODE_SERVER_VERSION=4.133.0`.

Image evidence before cleanup:

- Tag: `odie-os-coding-session:local-release-candidate`
- Image ID: `sha256:7236dbe6c7bef7b6bc5edd814f0c40acef0933e0163aa9f167b0666c6987230c`
- RepoDigest as locally reported by Docker: `odie-os-coding-session@sha256:7236dbe6c7bef7b6bc5edd814f0c40acef0933e0163aa9f167b0666c6987230c`
- OS/architecture: `linux/amd64`
- Size: `1698299843` bytes
- Build log: `/tmp/odie-final-dep-image-build.log`; tail includes `#33 naming to docker.io/library/odie-os-coding-session:local-release-candidate done` and `#33 DONE 54.1s`.

Smoke command used `packages/gatekeeper-sessions/pi-image/test-image-network-none.sh odie-os-coding-session:local-release-candidate` with all expected environment values listed above. The script hard-bounds both runs and uses `--network none`, `--read-only`, tmpfs, `--cap-drop ALL`, `no-new-privileges`, pids/memory/cpu limits, and cleanup traps. Smoke log `/tmp/odie-final-dep-image-smoke.log` ends:

```text
0.9.4
real-binary local smoke matrix passed
coding-session image smoke passed
```

Cleanup/egress evidence: after smoke, `docker ps -a --filter name=coding-session` returned no matching containers; process scan found no `test-image-network-none`, `smoke-image`, `docker buildx build`, or `docker run` helper. The smoke's only Docker runtime paths were `--network none`; no push/login/deploy occurred. Parent steering noted a possible wrapper/helper wait after success; local follow-up found no matching helper process, preserved logs and image evidence, and did not rerun build or smoke.

The local test image was removed after evidence capture with `docker rmi odie-os-coding-session:local-release-candidate`; no unrelated Docker assets were removed.

### Remaining gates

Release is still not publishable from local evidence alone. Remaining gates: independent review of this final closure diff/evidence, CI/clean-install parity, disposition/acceptance or upstream fixes for the residual advisories above, existing native Sandbox canary tiers, genuine live provider/Slack/model/repository gates already documented elsewhere, and normal owner release approval. No stale direct Miniflare/Vitest parents remain from this closure task.


## Implemented within the active write contract

- Upgraded the coding-session image Prime source from the official PrimeIntellect R2 `prime-agent` 0.8.0 tarball to the official 0.9.4 tarball:
  - URL: `https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.9.4/prime-agent-0.9.4.tgz`
  - SHA-256 verified against upstream `SHA256SUMS`: `b8d752a53d11a8c9a7580e1fb5fc24f7ce74ccad979c7e6e6aa8880fc3ad90b0`
  - npm lock integrity: `sha512-6FWCvTiS3+o2yX3NWTVQSlPNP0RHhatuoKsl3ZesCn8SvagSuDQ1aCiP7omzKh15AXXPa03BFkrAL+Oo5UuPEw==`
- Refreshed the image direct parent `pi-mcp-adapter` from 2.26.0 to 2.33.0 with normal npm peer resolution. The selected package declares accepted non-registry MCP 2.0 preview artifacts:
  - `@modelcontextprotocol/client`: `https://pkg.pr.new/@modelcontextprotocol/client@3b205e7dd2f997b6a87e479e36421f7eaa2058e0`
  - `@modelcontextprotocol/core`: `https://pkg.pr.new/@modelcontextprotocol/core@3b205e7dd2f997b6a87e479e36421f7eaa2058e0`
- Preserved Pi 0.85.1, OpenCode 1.18.30, Cloudflare Sandbox SDK package pin, and the Cloudflare Sandbox base image digest.
- Kept package lifecycle quarantine: image install still uses `npm ci --prefix /opt/odie-pi --ignore-scripts`.
- Removed the unconditional legacy ZeroMQ installer path; Prime 0.9.4 no longer declares `zeromq` and the Dockerfile now asserts the installer path is absent.
- Added an offline Prime runtime smoke (`prime-runtime-smoke.py`) that starts `python -m rlm.repl`, requires ready protocol 3, executes imports for `rlm`, `rlm.mcp`, `rlm.bash`, and `McpIntegration`, and verifies MCP2 `input_schema` normalizes to non-empty `inputSchema`.
- Extended Dockerfile and network-none smoke to run the Prime runtime smoke in addition to the existing IPython compatibility import.
- Updated owner bridge/RPC tests and harness labels to Prime 0.9.4 while preserving ordinary Pi 0.84.2/0.85.1 compatibility and restricted request-build Pi 0.85.1.
- Updated authorized workspace direct parents: catalog `vite-plus` `^0.3.1`, `vitest` `^4.1.11`, `wrangler` `^4.131.1`; JARVIS now consumes catalog `vite`, `vitest`, and `wrangler` instead of local stale pins.
- Dependency/release repair follow-up: catalog `@cloudflare/vitest-pool-workers` now resolves to the current compatible `0.22.0`; Vitest is retained at `4.1.11` for the catalog and gatekeeper-sessions package because pool `0.22.0` peers require `^4.1.0` and no Vitest major bump is part of this gate.
- Dependency/release repair follow-up: `packages/workshop-backend` now declares the current direct `@cloudflare/puppeteer` parent `^1.4.0` and the lock resolves it to `1.4.0` normally.
- Release workflow repair follow-up: `publish-coding-session-image` and `deploy-production` no longer install global npm Wrangler. Privileged Wrangler actions now run through `pnpm exec wrangler` from the frozen workspace after exact-source checkout, Corepack enablement and `voidzero-dev/setup-vp` dependency setup; Cloudflare credentials are not present during dependency installation.

No new package-manager overrides, resolutions, `patchedDependencies`, local tarball edits, `file:`, `link:`, vendored source patches, registry push/login, deployment, staging, or live provider action was performed. The existing reviewed root `patchedDependencies` entry for `capnweb@0.12.0` is unrelated accumulated work and was retained exactly; no new pi-image or dependency patches were added.

## Lock/acquisition commands run

Public acquisition/provenance:

```sh
tmp=$(mktemp -d)
curl -fsSL --retry 3 --connect-timeout 10 --max-time 120 https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.9.4/SHA256SUMS -o "$tmp/SHA256SUMS"
curl -fsSL --retry 3 --connect-timeout 10 --max-time 300 https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.9.4/prime-agent-0.9.4.tgz -o "$tmp/prime-agent-0.9.4.tgz"
awk '$2 == "prime-agent-0.9.4.tgz" { print; found=1 } END { exit found ? 0 : 1 }' "$tmp/SHA256SUMS" > "$tmp/SHA256SUMS.selected"
grep -Fx 'b8d752a53d11a8c9a7580e1fb5fc24f7ce74ccad979c7e6e6aa8880fc3ad90b0  prime-agent-0.9.4.tgz' "$tmp/SHA256SUMS.selected"
(cd "$tmp" && shasum -a 256 -c SHA256SUMS.selected)
```

Lock mutations, rerun with empty user/global npm configs for npm operations:

```sh
cd packages/gatekeeper-sessions/pi-image
npm_config_userconfig="$tmp/user-npmrc" npm_config_globalconfig="$tmp/global-npmrc" npm install --package-lock-only --ignore-scripts --audit=false
# Final lock was regenerated from a clean temporary directory containing only package.json, then copied back.
```

```sh
NPM_CONFIG_USERCONFIG="$tmp/user-npmrc" NPM_CONFIG_GLOBALCONFIG="$tmp/global-npmrc" \
  npm_config_userconfig="$tmp/user-npmrc" npm_config_globalconfig="$tmp/global-npmrc" \
  COREPACK_ENABLE_NETWORK=1 pnpm install --lockfile-only --ignore-scripts
```

Dependency/release repair lock/install refresh, again with separate empty user/global npm configs and no lifecycle scripts:

```sh
NPM_CONFIG_USERCONFIG="$tmp/user-npmrc" NPM_CONFIG_GLOBALCONFIG="$tmp/global-npmrc" \
  npm_config_userconfig="$tmp/user-npmrc" npm_config_globalconfig="$tmp/global-npmrc" \
  COREPACK_ENABLE_NETWORK=1 pnpm install --lockfile-only --ignore-scripts
NPM_CONFIG_USERCONFIG="$tmp/user-npmrc" NPM_CONFIG_GLOBALCONFIG="$tmp/global-npmrc" \
  npm_config_userconfig="$tmp/user-npmrc" npm_config_globalconfig="$tmp/global-npmrc" \
  COREPACK_ENABLE_NETWORK=1 pnpm install --frozen-lockfile --ignore-scripts
```

A first defensive npm rerun used the same empty file for user and global config and failed before config resolution with npm's `double-loading config` guard; the subsequent two-file empty-config rerun passed.

## Focused validation

- Prime R2 tarball checksum: passed, `prime-agent-0.9.4.tgz: OK`.
- Focused Sessions harness tests, strict runner SHA-256 `56d83de010ec5fb47e4d1f9c6da002a9a56804f7607d7de21ad8326da551f551`:
  - Command: `/usr/bin/python3 /tmp/odie-restricted-sessions-evidence/run-builds-pr-candidate.py prime-modernization-vitest-node-3 ./node_modules/.bin/vitest run packages/gatekeeper-sessions/__tests__/harness-image-pins.test.ts packages/gatekeeper-sessions/__tests__/pi-adapter-canary.test.ts packages/gatekeeper-sessions/__tests__/harness-rpc.test.ts packages/gatekeeper-sessions/__tests__/harness-command.test.ts packages/gatekeeper-sessions/__tests__/pi-backbone.test.ts`
  - Result: 5 files passed, 119 tests passed.
- Sessions TypeScript check, strict runner:
  - Command: `/usr/bin/python3 /tmp/odie-restricted-sessions-evidence/run-builds-pr-candidate.py prime-modernization-sessions-local-tsc-2 packages/gatekeeper-sessions/node_modules/.bin/tsc -p packages/gatekeeper-sessions/tsconfig.json --noEmit`
  - Result: passed.
- A root `./node_modules/.bin/tsc -p packages/gatekeeper-sessions/tsconfig.json --noEmit` attempt under the strict runner failed because the root TS7 binary rejects the package's existing `baseUrl`; the package-local TypeScript binary matching the package script passed.
- Root pnpm audit was attempted only through the required strict runner:
  - Command: `/usr/bin/python3 /tmp/odie-restricted-sessions-evidence/run-builds-pr-candidate.py prime-modernization-pnpm-audit pnpm audit --prod --json`
  - Result: failed with `fetch failed` under the runner's network-denied profile. A raw pnpm audit was not run because non-install pnpm validation commands must use the strict runner.
- Image npm production audit with empty npm configs:
  - Command: `npm audit --omit=dev --json`
  - Result: failed with 2 remaining high findings (`extract-zip`, `prime-agent`). `fast-uri`, `hono`, and `qs` advisories were cleared by clean package-lock regeneration selecting current versions within official parent ranges.
- Dependency/release repair strict-runner validation (runner SHA-256 `56d83de010ec5fb47e4d1f9c6da002a9a56804f7607d7de21ad8326da551f551`):
  - Script/workflow tests: `pnpm --config.verify-deps-before-run=error exec node --test scripts/production-work-items-wiring.test.ts scripts/team-pi-model-sync.test.ts scripts/admin-authority-rollout.test.ts scripts/request-build-notifier-binding.test.ts` → 16 passed.
  - Sessions workflow/image-pin tests: `pnpm --config.verify-deps-before-run=error --filter @gadgets/gatekeeper-sessions exec vitest run __tests__/canary-workflow.test.ts __tests__/harness-image-pins.test.ts` → Vitest 4.1.11, 2 files / 11 tests passed.
  - Cloudflare gatekeeper tests: `pnpm --config.verify-deps-before-run=error --filter @gadgets/cloudflare-gatekeeper test:run` → Vitest 4.1.11, 8 files / 111 tests passed, with expected existing negative-path diagnostics.
  - Scheduler tests: `pnpm --config.verify-deps-before-run=error --filter @gadgets/gatekeeper-scheduler test:run` → Vitest 4.1.11, Worker 102 passed / 3 existing skipped and app 19 passed.
  - Zendesk tests: `pnpm --config.verify-deps-before-run=error --filter @gadgets/gatekeeper-zendesk test:run` → Vitest 4.1.11, 115 tests passed, with expected existing negative-path diagnostics.
  - Backend build: `pnpm --config.verify-deps-before-run=error exec vp run -F @gadgets/workshop-backend build` → 4 tasks passed, 0/4 cache hits.
  - Backend focused tests: `pnpm --config.verify-deps-before-run=error --filter @gadgets/workshop-backend exec vitest run __tests__/finance-access.test.ts __tests__/email-migration.test.ts __tests__/request-build-api.test.ts` → 3 files / 66 tests passed, with expected existing negative-path diagnostics.
  - Scheduler build: `pnpm --config.verify-deps-before-run=error exec vp run -F @gadgets/gatekeeper-scheduler build` → 4 tasks passed, 0/4 cache hits.

## Historical audit inventory before final closure (superseded)

> This section records the pre-closure scan and is not the current release state. The final closure subsequently updated the three direct Miniflare parents and Odie KG Vitest parent, moved the Sandbox preview to `0.13.0-next.751.1` and refreshed its compatible Hono selection to `4.13.7`. A filtered root update could clear the PostCSS/Nanoid advisory only by also changing the lint toolchain graph and producing new exact-tree lint failures, so that attempted lock change was reverted rather than weakening lint or accepting unrelated churn. Current audit results and remaining gates are recorded in [final release evidence](final-release-evidence.md).

No override/patch was added for any advisory. Latest registry checks show `extract-zip` still publishes only `2.0.1` (no `2.0.2`), `monaco-editor` latest is `0.56.0` and depends on `dompurify 3.4.8`, `@cloudflare/vitest-pool-workers` latest is `0.22.0` with peers `vitest/@vitest/* ^4.1.0` and dependencies `wrangler 4.124.0` / `miniflare 5.20260815.0-alpha`, and `@cloudflare/puppeteer` latest is `1.4.0` with `@puppeteer/browsers 2.2.4`.

| Graph | Package/advisory | Severity | Locked version | Direct parent / reason | Reachability and compensating controls | Disposition |
|---|---|---:|---:|---|---|---|
| pi-image npm production audit | `extract-zip` / `prime-agent` | high | `extract-zip 2.0.1`, `prime-agent 0.9.4` | Official Prime 0.9.4 still pulls `extract-zip 2.0.1`; npm publishes no `extract-zip 2.0.2`. | Image install remains `npm ci --ignore-scripts`; release still requires actual built-image smoke/egress/cleanup evidence. | Not fixed; promotion remains blocked until upstream fix or explicit scoped acceptance by the appropriate owners. |
| root pnpm production audit | `extract-zip` via `@cloudflare/puppeteer` | high | `extract-zip 2.0.1` | Current `@cloudflare/puppeteer 1.4.0` still depends on `@puppeteer/browsers 2.2.4`, which pulls `extract-zip`. | Used by backend Browser Rendering integration path, not by the coding-session image. | Not fixed by current direct parent; no override added. |
| root pnpm production audit | `dompurify` via Monaco | low/moderate | `dompurify 3.4.8` | Current `monaco-editor 0.56.0` pins `dompurify 3.4.8`; frontend also reaches it through direct Monaco and `@monaco-editor/react` / `y-monaco`. | Monaco is client/editor surface; no server secret exposure. Sanitization-sensitive behavior still needs upstream Monaco fix or a separately approved change. | Not fixed; no override added. |
| root pnpm development audit | `sharp` via pool Miniflare | high | `sharp 0.35.2` | Current `@cloudflare/vitest-pool-workers 0.22.0` still pulls dev-only `miniflare 5.20260815.0-alpha` and Wrangler's Miniflare with older `sharp`. | Test/dev graph only; not deployed runtime. | Not fixed; no override added. |
| root pnpm development audit | `undici` via direct Miniflare | moderate/high | `undici 7.28.0` | The three out-of-contract direct Miniflare packages still declare `miniflare 5.20260801.0-alpha`; current target `5.20260911.0-alpha` would pull `undici 7.29.0` and `sharp 0.35.4`. | Test/dev graph only. | Not changed in this run due active write contract; parent follow-up must edit the three package files and regenerate/revalidate the lock. |
| root pnpm production audit | `nanoid` via Vite/PostCSS | high | `nanoid 3.3.16` | Current direct Vite catalog remains `7.3.6`; advisory is through Vite/PostCSS transitive paths. | Build/tooling-heavy reachability; still appears in production audit because package manifests list Vite in several dependency sections. | Not fixed; no override added. |
| root pnpm production audit | `hono` via `@cloudflare/sandbox` | moderate | `hono 4.13.1` | Current Sandbox SDK package still pulls vulnerable Hono. | Sessions/Sandbox package graph; actual image/candidate proof remains a release gate. | Not fixed; no override added. |
| root pnpm development audit | `vitest`/`@vitest/mocker` in `gatekeeper-odie-kg` | moderate | `4.1.10` | `packages/gatekeeper-odie-kg` is outside this run's allowed write paths and still declares `vitest ^4.1.10`. | Dev/test graph only. | Not changed in this run; parent follow-up required if this package remains in scope. |

Advisories fixed by proper parent/lock refresh in the earlier image slice: `fast-uri` moved to 3.1.7, image `hono` moved to 4.13.7, and image `qs` moved to 6.16.0 through clean npm lock regeneration from the image manifest.

Out-of-contract direct-parent residuals intentionally skipped by supervisor decision: `packages/gatekeeper-cloudflare/package.json`, `packages/gatekeeper-scheduler/package.json`, and `packages/gatekeeper-zendesk/package.json` still declare `miniflare 5.20260801.0-alpha`; exact required edit in each file is `"miniflare": "5.20260911.0-alpha"`, followed by normal `pnpm install --lockfile-only` and strict revalidation.

## Historical image build/smoke status (superseded)

> This section records the earlier disk-constrained slice. A later final-closure run successfully built the actual linux/amd64 image and passed the network-none real-binary smoke matrix; see [final release evidence](final-release-evidence.md).

A local linux/amd64 image build was not attempted. The earlier Prime slice stopped at `9.0Gi` available on `/System/Volumes/Data`; the dependency/release repair preflight was lower: `6.5Gi` available on `/System/Volumes/Data` (99% capacity), Docker images `17.45GB`, containers `140.1MB`, local volumes `2.578GB`, build cache `3.532GB` with `0B` reclaimable image/cache according to `docker system df`. Per instruction, the run stopped before unsafe disk exhaustion and did not delete unrelated images/evidence. Consequently `test-image-network-none.sh` was not run against a newly built image in this slice, and no new test image ID/digest exists to clean up.

## Release status after final dependency/image closure

The local image build and network-none smoke, direct Miniflare/Odie KG parent repairs, and Sandbox/Hono refresh are complete. No override, resolution, or new patch was added. Release still requires exact-tree CI/artifact parity, explicit owner disposition of the upstream-only residual advisories, post-main native Sandbox canaries, genuine live provider/Slack/model/repository gates, and normal release approval.
