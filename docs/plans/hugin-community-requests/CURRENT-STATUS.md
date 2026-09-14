# Current implementation and acceptance checkpoint

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

Local exact-tree release closure is complete: strict lint/build/test and 16 production artifacts passed, fresh independent code/security reviews passed, and the owner explicitly accepted the documented upstream-only dependency residuals for this release. Remaining gates are repository CI/merge policy, post-main image/native Sandbox canaries, genuine live provider/Slack/model/repository checks, migration-safe deployment, and post-deploy smoke/rollback verification.


## Latest frozen slice — Context/JARVIS resource-owner fencing

[Legacy owner fencing](legacy-owner-fencing.md) is the latest accepted source slice and supersedes the older Finance/legacy statements below. Finance remains a separate deployment-configured operator role. Context public-management and JARVIS policy mutations now require current purpose-bound authority at their durable resource owners; two fresh matching provider scans gate managed activation and establish an immutable provider/domain/fence-version baseline. Independently revocable Context Git credentials are intentionally not tied to issuer-admin lifetime. The three native-result inference diagnostics were fixed with source-derived types. Independent security review passed this frozen mechanism at LOW risk; it did not approve deployment.

Current local release evidence is complete after notifier, Finance, owner-fence, authenticated request-build, dependency, and image changes. Production managed activation and Auto-Build remain fail-closed until post-main image/candidate canaries, authoritative pricing/model/repository evidence, Slack destination/send evidence, and migration-aware live checks pass.

## Latest dependency/Prime modernization slice — source and locks only

[Dependency modernization](dependency-modernization.md) upgrades the coding-session Prime source to the official PrimeIntellect R2 `prime-agent` 0.9.4 tarball, verifies its SHA-256 against upstream `SHA256SUMS`, refreshes `pi-mcp-adapter` to 2.33.0 with normal npm peer resolution, removes the stale ZeroMQ installer path, and adds `python -m rlm.repl` protocol-3 plus MCP2 `input_schema` smoke coverage. Pi 0.85.1, OpenCode 1.18.30, the Sandbox SDK pin, the Sandbox base digest, restricted request-build behavior, and publish-workflow protections remain unchanged except for the permitted Prime/adapter version pins. Authorized root/JARVIS catalog pins moved to `vite-plus` 0.3.1, `vitest` 4.1.11, and `wrangler` 4.131.1.

This is not image promotion. The dependency/release repair also updates the pool catalog to `@cloudflare/vitest-pool-workers` `^0.22.0`, keeps Vitest at `4.1.11` where in scope, updates `@cloudflare/puppeteer` to `^1.4.0`, regenerates the pnpm lock normally and hardens privileged publish/deploy Wrangler use to exact-source checkout plus an isolated exact Wrangler `4.131.1` install under `$RUNNER_TEMP` with lifecycle scripts disabled and absolute-path invocation. Candidate workspace dependencies are not installed in credentialed jobs, and no global npm Wrangler install remains. The reviewed root `capnweb@0.12.0` patch remains unrelated accumulated work; no new patch/override was added.

Focused harness tests (119) and package-local Sessions tsc passed in the Prime slice. Final dependency/image closure updated all three direct Miniflare parents to `5.20260911.0-alpha`, Odie KG Vitest to `4.1.11`, Sandbox to `0.13.0-next.751.1`, and its Hono selection to `4.13.7`. The actual linux/amd64 image built and passed the network-none real-binary smoke matrix, then was removed. Sessions' 671-test suite passes against the new Miniflare API through its exported `convertV4MiniflareOptions` compatibility converter. Remaining honest audit findings are upstream-only: official Prime0.9.4 and `@cloudflare/puppeteer`1.4.0 still reach `extract-zip`2.0.1, Monaco0.56.0 pins vulnerable DOMPurify, Vite/PostCSS retains Nanoid3.3.16, and pool0.22.0 retains dev-only sharp0.35.2.

## Current release direction — finish all work, then release together

Owner direction supersedes the reviews' conditional board-only rollout option: **no partial board rollout; commit/merge/deploy all changes together**. The owner has now authorized commit, push, merge, canary, and deployment after local release closure. Live managed activation still remains fail-closed on its provider-owned evidence.

Final independent source/evidence review is **PASS**, including the Stage E ES2022 repair, alarm/browser-origin repairs and artifact correspondence. Final security review inspected board/authority/controller/restricted Sessions/publisher/notifier/UI and is **BLOCKED for managed activation/full acceptance**, not a new source defect. The named final-gates markdown files are empty; supervisor supplied the actual nonempty structured review JSONs, which were read. Exact paths and the ordered remaining source/tests/operator work are in [full-release readiness](full-release-readiness.md).

A–D source and Stage E local verification are implemented. The subsequent [private notifier destination mechanism](notifier-destination-verification.md) now performs fresh Slack-owned identity/channel/access checks and computed narrow readiness, with local real-workerd/fake-Slack coverage; independent review and genuine operator-authorized destination/send evidence remain outstanding. Supported optional generic notifier wiring (external deploy-service contract), image/pricing readiness integration, and an authenticated browser-to-real-facade managed-success harness remain implementation gaps. Finance is an **unresolved architecture/source gate**, not merely missing credentials: supervisor confirms no approved complete containment/drain design exists. Reuse the existing inventory for one finite security design decision; no more native/type investigation or speculative guard wiring. Image execution/egress/cleanup, conservative numeric/provider proof, clean CI/advisories and migration-aware final release acceptance remain required. Independent reviews do not authorize activation.

## Latest notifier source checkpoint — not live verification

Fresh fixed-endpoint Slack `auth.test`/`conversations.info` verification binds expected bot/workspace/channel/type, actual provider scopes and membership to current origin/configuration generation and at most30seconds of freshness. No success cache, env confirmation boolean or durable attestation exists. Every send independently rechecks. Metadata readiness explicitly leaves posting unproven; only a real send acknowledgement proves that attempt. The production factory computes only the notifier destination reason; Finance/drain/image/pricing remain blocked.

Protected local controller/publisher48 tests (15 added), authenticated board/authority/facade23 and JARVIS39 pass; affected types/scoped lint pass. Full-root tests/build and16 dryrun artifacts below are now **pre-change evidence**, not current runtime artifacts. New source has not received independent review or any real destination check. An unsuppressed RPC-result disposal warning in the full controller suite has unresolved attribution; exact test names/logs and operator scopes are in [notifier evidence](notifier-destination-verification.md). No staging/live actions occurred. Optional generic deploy-service wiring and all other full-release gates remain open.

## Latest Stage E local verification — reviewed source/evidence PASS for that checkpoint, full acceptance incomplete

The supplied Stage D second-repair review is **PASS**, limited to source/evidence, not activation. Fresh uncached verification then exposed two shared protocol `toSorted()` calls unavailable in ES2022 consumer type programs. They now sort only newly allocated `Object.entries`/`Object.keys` arrays, with exactly two supervisor-approved, explained `unicorn/no-array-sort` line exceptions. No consumer lib widening, dependency/polyfill or type suppression. Two new frozen-input/order/extra-key regressions pass. AGENTS now correctly describes per-method AdminAuthority checks.

On repaired source, protected exact `pnpm lint`, `pnpm build`, and `pnpm test` pass: **142 warnings/0 lint errors; 194 root +3349 package tests, seven existing skips**. Root task actually selects the new controller/publisher **33** cases. Additional uncached direct checks pass: authenticated board/authority/facade/compatibility **23**, restricted Sessions/GitHub **23**, board/run UI **24**, controller/publisher **33**, and request-build test-program types. Root `--no-cache` build passed87 tasks with one nested cache hit; the fresh isolated build passed **87 tasks/zero cache hits**.

Current runtime source has **16 verified production dry-run outputs**,131 files/57,257,669 bytes. Root: `/private/tmp/odie-restricted-sessions-evidence/tmp/literal-test-2y0lntow/odie-final-artifact-o4nmvksx/source/production-deploy/`. Its sibling `artifact-verification.json` records every file digest; SHA256 `d58e54563e6eac2c299f75813578e3c64480348ede9be7eabaf60319c545e0fd`. This supersedes stale pre-A–D artifacts below. An acquisition-free installed-graph copy audited1541 source files,73772 copied files and2863 confined links; no install, hardlink-back, stale source replay or new validation timestamp. Original integrity remains **71337 exact records +1 prior approved metadata delta**, patched24+2/U1/HEAD/index preserved. Final documentation-only deltas are recorded separately from the built snapshot.

Exact logs/argv/failures are under `/tmp/odie-restricted-sessions-evidence/final-verification-*` and `commands.jsonl`; detailed handoff: `057346eb-e1d7-4c30-baeb-07c7cb253db3/closeout/final-verification.md` in the evidence output root below. The first snapshot attempt was protection-blocked on copied `.npmrc` and stopped/escalated; supervisor-approved owned-TMPDIR provisioning and artifact-only immutable-graph runner derivatives preserve this failure and the failed pre-repair compile. No broad cache/private-read/network allowance was added.

**Not complete acceptance:** successful managed controller→restricted execution state→trusted PR→Slack uses real workerd storage/generations with test-owned external dependencies. Authenticated production facades are separately tested for safe reads/denied admission; UI is separately tested in jsdom. These are **not one authenticated browser-to-success E2E**, and fake container execution is not actual restricted-image execution. The final independent repair/source-evidence review has now passed; the final security review retains managed-activation blockers. That integrated proof, Finance/drain, image/egress/process cleanup, conservative pricing/model/repository readiness, genuine Slack destination verification, generic-release optional notifier wiring, vulnerability advice and remote CI/clean-install parity remain open. No container build/image promotion/deployment/live provider/model/GitHub/Slack action occurred. Pi0.85.1/OpenCode1.18.30 remain source targets only; Prime0.8.0 and deployed images remain unchanged; the prior38 host/image transitive differences remain relevant.

## Historical checkpoints (retained evidence; current disposition above)

All subsequent checkpoint/review-pending statements retain their historical scope. The current review disposition and remaining task list above supersede them; historical tests, failures and artifact hashes have not been rewritten.

### Accepted local milestone

- Exact U1 scheduler test-harness patch retained and independently reviewed.
- Authenticated requests/new-public-bugs board implemented and independently reviewed: submission, voting, details, search/related suggestions, static-admin moderation, navigation independent of connector onboarding, private historical reports kept separate.
- Same-version Cap'n Web 0.12.0 two-hunk runtime patch independently reviewed; installed six bundles verified against exact patched content after dependency recovery. Two legitimate 0.8 consumers remain unchanged.
- Exact local `pnpm test`: exit 0, 189 root tests plus 3,180 package tests, seven existing skips.
- `pnpm lint` and `pnpm build`: exit 0.
- Isolated workspace build and `node scripts/build-production-deploy.mjs --out production-deploy`: exit 0, all 16 dry-run artifacts verified. Output: `/private/tmp/odie-ci-artifact-ad5o0svu/source/production-deploy/`.
- Independent CI closeout review PASS, limited to those local checks.

This is NOT remote CI/CD, clean-install/Ubuntu/CI-mode parity, production deployment or full-goal completion. No commit, push, deployment, live membership change, PR/provider write or Slack message occurred.

## Current implementation-first checkpoint

The [implementation-first addendum](implementation-first-addendum.md) established A authority/admin UI → B restricted Sessions → C durable builds/trusted PR → D Slack/run UI → E review/verification. All those source slices and E local gates now exist; A/UI, C and repaired D have supplied source reviews, E final source/evidence review is PASS, and final security inspected B–D while retaining activation blockers. See [authority-core implementation](authority-core-implementation.md), [admin management UI implementation](admin-management-ui-implementation.md), [restricted Sessions implementation](restricted-sessions-implementation.md), [durable builds implementation](durable-builds-implementation.md) and [Slack/run UI implementation](slack-run-ui-implementation.md) for chronological tests/failures, not current missing-stage claims. Remaining work is the explicit [full-release readiness](full-release-readiness.md) sequence, not another unimplemented Slack UI slice.

Legacy/prepared modes preserve current static membership/Finance behavior; effective grant/revoke requires managed mode. Implemented transition code requires backend-owned evidence, not an AdminConfig/browser boolean or invented attestation. Production missing Finance guard/drain evidence must deny activation and Auto-Build admission. New backend uses the capability-aware provider path without fallback-on-error; old boolean provider paths remain compatible solely as unfenced legacy surfaces that must be retired/fenced and drained before activation.

## Remaining full-goal blockers

AdminAuthority SQLite state, real managed transactions, known AdminApi/board/Context/JARVIS guards and admin management UI are implemented and source-reviewed. Restricted Sessions, durable builds/private authorization/trusted publisher and Slack/notifier/run UI are implemented; final security inspected these source paths, but actual image/egress/cleanup and managed activation remain unproved. Slack-owned destination evidence and generic optional wiring are missing mechanisms, not missing UI. Finance/drain needs a defensible approved implementation design, not more exhausted native experiments. The final review does not independently attest every image-lock dependency or vulnerability; image/advisory acceptance remains open. The new nine-test real-workerd authority suite passes; shipped-source lint/build passes. The combined authority **test-program** tsc now passes with generated test-only namespaces and return types derived from the real provider APIs. Review repairs preserve ordinary app opening/private Context access on authority outage while privileged access denies, restrict capability forwarding to Context/JARVIS, and require each consumer to assert its expected purpose. This does not clear the separately preserved Finance/native prototype failures. Existing Finance and legacy-provider limitations remain. Default-suite green does not include isolated failing native/type diagnostics.

Private transport lifetime repair passed 13 new real-workerd tests and independent review. Full prototype remains blocked by native stream rejection/lifetime evidence and public callback typing. Experimental declaration repairs were rejected and restored; no declaration patch is installed.

Latest source research identified workerd tag `v1.20260801.1` -> `d82c2a45a8695aac30d4d24828ce1ee7fb11909b` (unsigned public tag commit; not reproducible binary attestation). Native stream export waits for producer read before observing destination disconnection. A single reviewed scratch experiment confirmed that after local cancel, ONE diagnostic producer byte caused actual producer cancellation with `Network connection lost.`, without delivering bytes to canceled reader. This is mechanism evidence, NOT a cleanup strategy: a producer that never writes again can remain pending. The exact owner of the additional native pipeTo rejection remains unidentified. Runtime teardown required SIGKILL after its five-second shutdown bound and is not proof of graceful drain.

Latest callback overload experiment improves one callback but fails mixed callback inference and retains a preexisting invalid private-target callback acceptance. It is rejected, scratch-only, and has not altered the verified checkout.

The prior independent review approved only diagnostic evidence and did NOT authorize native/library repair or Finance guard wiring. The latest owner direction now authorizes implementation of the missing non-Finance components under the addendum, not speculative Finance containment. Further native research is paused; any future wake/cancel integration requires separate scope and error-ownership proof, and a local native patch would not repair Cloudflare's hosted runtime. No Sandbox SDK/native upgrade or native binary replacement is authorized. A later owner-approved harness-only update targets Pi0.85.1 and OpenCode1.18.30 in the image sources; Prime0.8.0 is retained because0.9.4 requires a separate kernel/MCP2 migration. Checked production images are unchanged; ordinary Pi bridge explicitly supports0.84.2/0.85.1 during provider-first rollout. This does not upgrade host tooling or establish image activation.

## Latest restricted Sessions verification / activation

Stage B adds private immutable reservation/receipt/authorize protocols, real restricted SDK startup/clone/collection, exact-generation/cancel checks, durable process-start ambiguity, cleanup/capacity retention, model budget reservations and bounded artifacts in the existing Code Session registry. Public sessions/catalog/fetch cannot acquire restricted controls. Both configurations append v6-request-build without changing historical migrations or Sandbox/image pins. Numeric production policy remains absent.

At the stage-B checkpoint, the explicitly approved `CodingSessionToolHostImpl.authorizeRequestBuild` seam returned `UNKNOWN_RUN`. Stage C now replaces it with persisted/current run authorization and real publication reconciliation; that historical Stage-B stub is no longer the source state. Production must additionally verify Finance/drain, actual restricted image/egress, eligibility and conservative per-call pricing. Component setup readiness is not those attestations.

Protected local evidence: Sessions **661 passed**, including12 new workerd +4 pure restricted cases; actual generated Pi0.85.1 SDK bootstrap passed with a loopback fake model and owned empty resource loader, but38 host/image transitive differences prevent an image-smoke claim. Fresh `pnpm build` passed; exact `pnpm test` passed **191 root +3296 package tests /7 existing skips**. Final `pnpm lint` passed (136 warnings/0 errors); integrity chronology is in the component output. No new production artifact/container build, image promotion, live model/PR/Slack/provider write or managed activation. See [component evidence](restricted-sessions-implementation.md).

## Latest durable builds / draft-PR verification

Stage C embeds durable approval/capacity/mutation receipts, alarm-driven execution/recovery, current actor/authority/readiness and exact receipt checks in the existing board DO. Worker-owned publication independently validates bounded text diffs and Git Data/PR evidence; only typed private Sessions transport owns installation credentials. The approved cancellation-fence repair closes delayed reservation versus cleanup release. Public run reads remain authenticated, connector-independent, projected and hidden-request safe. Production factory still unconditionally denies missing Finance/drain/image/pricing/notifier proofs; no fake override or live activation.

Protected backend task passed **624 ordinary +6 existing integration +15 new controller/publisher tests /4 pre-existing integration skips**; Sessions script passed **668** (includes existing generated test copies). Affected shipped-source/test-program tsc and root lint passed. No new full-root tests/build/artifacts are claimed. A protected pnpm validation-cache recovery is documented in [component evidence](durable-builds-implementation.md): failed probes retained, actual pnpm refreshed only its validation timestamp under a separately approved one-use allowance, then strict no-write-exception validation passed. Final dependency accounting is **71337 exact payload/shim records +1 approved timestamp-only metadata record**, with original baseline/patch/U1/manifest/HEAD/index preserved. Independent review and Stage D remain outstanding.

## Latest Stage D source checkpoint

Private repository-owned JARVIS Slack Web API receiver, separate backend notification/attempt outbox, authenticated safe run history/details and real admin frozen-spec/start/cancel/readiness UI are now implemented, pending independent Stage D acceptance review. This supersedes earlier statements that Slack/run UI is the next unimplemented source slice. See [Slack/run UI implementation and operator setup](slack-run-ui-implementation.md). The prior Stage C independent component review supplied with this task was PASS, not activation.

Production remains denied: notifier protocol/config presence is not destination verification. `NOTIFIER_DESTINATION_UNVERIFIED` is an explicit open activation implementation gap requiring genuine Slack-owned destination/credential evidence, not an env assertion; generic release optional private binding support also remains missing. Finance/drain/image/pricing proofs are independent. No live Slack/GitHub/model/provider calls, credentials reads/provisioning, deployment, image changes, staging or commits occurred. Protected source tests include actual cross-worker backend→JARVIS→local fake Slack HTTP, durable delivery/retry/ambiguity/privacy, nine UI control/lifetime tests, full frontend693 and existing JARVIS39 tests; exact final gates/failures/integrity are retained in the Stage D closeout artifact.

### Stage D review repair — Slack browser links

The supplied Stage D review requested REVISE because Slack request/run links targeted the native API-only origin. The source repair now uses an explicit backend/receiver `REQUEST_BUILD_WORKSHOP_ORIGIN` set to the Odie browser SPA origin; native/API `PUBLIC_BASE_URL` and router security remain unchanged, with no fallback. Protected checks passed:3 wiring tests,19 real-workerd router tests (including request/run SPA routing and native404),29 controller/publisher/outbox tests, backend/script typechecks and scoped lint (3 existing warnings/0 errors). Full dependency verifier again passed71337 exact records plus the unchanged previously approved metadata delta; index empty. See `slack-run-ui-implementation.md`. Fresh independent repair review remains required; no activation or live-route proof is claimed.

### Stage D second review — bounded durability repair

The supplied second review requested post-commit start scheduling and refresh-safe mutation retry. `RequestBuilds.start` now commits the run/canonical receipt before arming the existing alarm, before acknowledgement. A scheduling failure leaves the committed receipt available to same-key retry/recovery. Two added real-workerd regressions consume a wake during final pre-commit admission and inject post-commit alarm failure; same-key retry actually re-arms without another run/key, and repeated retry preserves the earlier wake.

The UI finding does not match this writer's entry source: the refresh effect already preserved pending mutations. `RequestBuildPanel.tsx` is unchanged (SHA256 `3bcdc96cd3b06e59bb47792050d8a9c67c276356ab639a052727a37ae9d1dd33`). Strengthened start/cancel settled-failure→refresh→same-key retry assertions and added account/request replacement-and-return denial tests instead of a redundant source change. Protected controller/publisher31 and UI11 tests, backend/frontend typechecks and scoped lint pass (3 existing warnings/0 errors). Fresh independent review remains required; no new architecture, activation work or live proof is claimed. Exact logs and final integrity are in `closeout/slack-ui-fix-1.md` and `slack-run-ui-implementation.md`.

## Evidence references

Under `/Users/jacob_1/.pi/agent/sessions/--Users-jacob_1-odie-os--/subagent-artifacts/outputs/`:

- `ccf82d1e-0808-4ddc-9089-5ac640b29224/repair-cycle/ci-closeout.md` and `ci-closeout-review.md`: actual passing commands/artifacts, recovery incident, protected graph verification and limitations.
- `4f5b048d-5274-4360-b976-addf85c34acc/completion-research/native-ownership.md`, `callback-types.md`, `review.md`: pinned source, rejected callback candidate and required next proofs.
- `82f579dd-5f77-4fdf-9801-68718f027555/wakeup/result.md`, `review.md`: reviewed single-cell wakeup experiment and preserved scratch bundle.

`IMPLEMENTATION-TODO.md` retains detailed staged history. Do not erase failed experiments or the dependency recovery incident when preparing eventual reviewable changes. Current dependency graph is verified restored; future commands must avoid the documented pnpm auto-install/settings mismatch and unpatched-base audit mistake.
