# Gate-resolution progress (planning only)

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


**Current correction:** Finance operator separation is implemented; see [current contract and remaining gates](finance-operator-separation.md). Do not treat historical Finance containment/drain tasks below as managed-admin requirements. Remaining concrete legacy drain is Context/JARVIS privileged children and issued public Context tokens. Dependency/image closure has hardened privileged Wrangler workflow use, refreshed the direct Miniflare/Odie KG/Sandbox parents and Hono lock path, and completed actual image/network-none smoke. Exact-tree local CI/artifact parity is complete and the owner explicitly accepted the scoped upstream-only advisory residuals for this release. Repository CI/merge policy, post-main native canaries, and genuine live activation evidence remain open. No activation or deployment occurred.

## Story DAG

`P0 preflight -> A fresh inventory -> A candidate decisions`

`P0 -> C1 authority inventory -> C1 decision -> H0 control-plane decision`

`A + C1 + H0 -> critic/self-repair -> documentation verification -> STOP`

A research and C1 research are independent, but this run executes directly and serially in Pi. No subprocess agents or concurrent writers. All implementation stories remain out of scope.

- [x] P0: Git repository, baseline SHA, tracked/index state confirmed; anchor read.
- [x] Architecture pass: initial decision document written before any implementation (none permitted).
- [x] Owner authorized independent temporary upstream clone; original Git refs must remain unchanged.
- [x] A research: acquired/pinned `08afe059…` in independent clone; recommend U1 scheduler test-only batch. Owner selection/A2 runtime validation remain required.
- [x] C1 design: exact-account identity, bootstrap, live generation checks; added JARVIS and Finance inventory. Live four-versus-one admin discrepancy and legacy capability drain remain release gates.
- [x] H0 design: restricted Code Session mode, private reservation/receipt protocol, trusted publisher and failure matrix. Numeric policy/provider/channel approvals remain release gates.
- [x] Critic: same-session self-review completed; concrete corrections documented in `gate-verification.md`. Not an independent approval.
- [x] Finalizer: document/repository checks completed; only plan documents changed. Runtime tests/builds NOT RUN; no implementation.

## Stop state

See `gate-decisions.md` for authoritative dispositions. No source story is authorized. Next owner action is batch selection and review/acceptance of C1/H0 decisions, followed by explicit implementation authority if desired. No PR, commit, merge or deployment was created.
