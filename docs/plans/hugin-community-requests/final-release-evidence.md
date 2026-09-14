# Final release evidence

## Final dependency/image closure — 2026-09-14

Scope: exact proper-parent only. No overrides, resolutions, new patches, staging, commit, push, provider action, deploy, login, or image push was performed. The existing reviewed `capnweb@0.12.0` patch remains preserved.

### Direct-parent updates applied

| File | Direct parent | Before | After | Lock evidence |
|---|---|---:|---:|---|
| `packages/gatekeeper-cloudflare/package.json` | `miniflare` | `5.20260801.0-alpha` | `5.20260911.0-alpha` | `pnpm-lock.yaml` importer resolves `5.20260911.0-alpha(@types/node@26.1.0)` |
| `packages/gatekeeper-scheduler/package.json` | `miniflare` | `5.20260801.0-alpha` | `5.20260911.0-alpha` | `pnpm-lock.yaml` importer resolves `5.20260911.0-alpha(@types/node@26.1.0)` |
| `packages/gatekeeper-zendesk/package.json` | `miniflare` | `5.20260801.0-alpha` | `5.20260911.0-alpha` | `pnpm-lock.yaml` importer resolves `5.20260911.0-alpha(@types/node@26.1.0)` |
| `packages/gatekeeper-odie-kg/package.json` | `vitest` | `^4.1.10` | `^4.1.11` | no `4.1.10` remains in workspace package manifests or lock |
| `packages/gatekeeper-sessions/package.json` | `@cloudflare/sandbox` | `0.13.0-next.724.1` | `0.13.0-next.751.1` | importer resolves `0.13.0-next.751.1`; compatible Hono resolves `4.13.7` |

`grep` confirmation: no `5.20260801.0-alpha`, `4.1.10`, Sandbox `0.13.0-next.724.1`, or Hono `4.13.1` remains in workspace manifests/lock.

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
| Root production | `pnpm audit --prod --json --registry=https://registry.npmjs.org/` exit 1; metadata: 2 low, 2 moderate, 3 high | DOMPurify 3.4.8 via Monaco (`1124022` low, `1124233` moderate, `1124234` low, `1138538` moderate); `extract-zip 2.0.1` via `@cloudflare/puppeteer>@puppeteer/browsers` (`1139346`, `1193685` high); Nanoid `3.3.16` via Vite/PostCSS (`1139427` high). The Sandbox/Hono findings are cleared. |
| Root all deps | `pnpm audit --json --registry=https://registry.npmjs.org/` exit 1; metadata: 2 low, 2 moderate, 4 high | Same as root production plus dev/test `sharp 0.35.2` (`1193725` high) via current `@cloudflare/vitest-pool-workers 0.22.0`/Wrangler Miniflare paths and other Wrangler dev paths. Stale direct Miniflare and Sandbox/Hono findings are gone. |
| Pi image production | `(cd packages/gatekeeper-sessions/pi-image && npm audit --omit=dev --json --registry=https://registry.npmjs.org/)` exit 1; metadata: 2 high across 562 total deps | `extract-zip 2.0.1` (`1139346`, `1193685` high) via official `prime-agent 0.9.4`. |

Latest-parent checks: npm reports `extract-zip` latest `2.0.1`; `@cloudflare/puppeteer` latest `1.4.0` still depends on `@puppeteer/browsers 2.2.4`; `monaco-editor` latest `0.56.0` still depends on `dompurify 3.4.8`; `@cloudflare/vitest-pool-workers` latest `0.22.0` still depends on an older Miniflare/Wrangler path carrying `sharp 0.35.2`. Sandbox `0.13.0-next.751.1` now resolves Hono `4.13.7`. Vite's graph still resolves PostCSS `8.5.25` / Nanoid `3.3.16`; a normal filtered root update cleared that advisory only by also changing the lint toolchain graph and introducing new exact-tree lint errors, so the attempted lock change was reverted rather than weakening lint or accepting unrelated churn.

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

### Subsequent Sandbox/PostCSS closure validation

After the initial final-closure review, Sandbox was updated to `0.13.0-next.751.1` and the lock was refreshed through a normal filtered pnpm update. This selected Hono `4.13.7`. The Miniflare alpha's new constructor options are bridged in the three direct Miniflare fixtures using its exported `convertV4MiniflareOptions` compatibility converter. Strict-runner Sessions validation then passed all 41 files / 671 tests.

### Final exact-tree validation and owner disposition

Strict-runner SHA `56d83de010ec5fb47e4d1f9c6da002a9a56804f7607d7de21ad8326da551f551` was reconfirmed. Exact-tree `pnpm lint` passed, including all 87 build tasks. Exact-tree `pnpm test` passed after isolating and confirming one load-only Context timeout: 196 root tests passed and the Vite+ aggregate completed with 28/32 cache hits; fresh affected suites included Sessions 680, frontend 695, Context 49+1, request-build controller 48, and the remaining package tasks. `scripts/build-production-deploy.mjs` completed 16/16 production dry-run artifacts with Wrangler `4.131.1`; the temporary artifact directory was removed after verification. Fresh independent code and security reviews both returned PASS with no source/security blocker.

The owner explicitly accepted, for this release, the scoped residual risk from DOMPurify 3.4.8 via current Monaco, extract-zip 2.0.1 via current Puppeteer and official Prime 0.9.4, Nanoid 3.3.16 via Vite/PostCSS, and dev/test-only Sharp 0.35.2, with the documented sandboxing, no-lifecycle image installation, and post-main canary controls. This acceptance does not suppress the advisories or claim they are fixed; compatible upstream updates remain follow-up work.

### Remaining gates

Local release closure is complete. Remaining gates are repository CI/merge policy, post-main image publication and native Sandbox canary tiers, genuine live provider/Slack/model/repository checks, migration-aware deployment ordering, and post-deploy smoke/rollback verification. No stale direct Miniflare/Vitest/Sandbox or Hono residual remains from this closure task.

