# C2 authority — historical native stream/type investigation

**Scope correction:** [Finance operator separation](finance-operator-separation.md) is the current contract. The owner approved independent deployment-configured Finance operators, so the arbitrary Finance descendant/native-membrane investigation below is no longer a managed-admin release requirement. It remains historical evidence, not a revocation guarantee. Actual pre-upgrade Context/JARVIS privileged children and issued-token inventory still block managed activation; fresh source/typecheck failures are reported separately.

## Current RPC repair boundary (supersedes the historical failure classification below)

The reviewed two-hunk, exact-version pnpm patch already repairs native `.dup()` pass-back and
synthetic rejection ownership; this later writer reused it unchanged. The repaired isolated
prototype now has 19 runtime assertions passing, but its full command **exits 1 with three
unhandled native stream rejections**. A direct-native paced `ReadableStream.pipeTo` destination
failure, with the returned promise observed and no Cap'n Web import/boundary, reproduces one
extra rejection. Its direct cancel/graceful-completion controls pass. No narrowly proven private
promise owner or supported runtime repair was identified; no speculative third patch was made.

Native target disposal is now actor-owned and lifetime-backed with exact 1/2/3 target counts;
ordinary paced streams and separately bounded flood controls replace the conflated unpaced case.
No bounds were increased and no runtime assertions/rejections were suppressed. The new explicit
prototype typecheck exposes six TS2345 native/boundary argument-mapping failures plus one TS7006
map inference error. A failed public-Pick experiment was removed, not replaced by casts or a
mirrored interface. Successful runtime controls do not establish type-safe production compatibility.

Current reproducible source, commands, type-mapping locations and uncovered gates:
`packages/workshop-backend/__tests__/authority-prototype/README.md`. Actual writer milestones,
root build/lint/test results and logs: `IMPLEMENTATION-TODO.md`, RPC repair writer-exit boundary.
**C2 remains unimplemented.** Board-first source/local verification is independent and retained;
static moderation is not dynamic revocation. The remainder of this document preserves the original
investigation evidence and historical results, not the current checkout inventory/test counts.

## Investigation scope and state

Read implementation-decisions.md and IMPLEMENTATION-TODO.md first, then the full admin-authority ADR, anchor, verification dossier, AGENTS.md, gatekeeper skill, and Cap'n Web documentation/installed public types and implementation. HEAD remains 248cc75eda989d5ddc93507518a0bf284065e93f on feat/community-requests. Only U1's two scheduler files are tracked changes; index empty. At investigation entry there were no C2 production/test source changes or test runs. Final state below includes an authorized isolated, failing test-only prototype; no production changes, provider operations, dependencies or runtime upgrades. An attempted read of a guessed backend `__tests__/worker.ts` returned ENOENT; actual integration fixtures were located with file discovery. This is an inspection-path error, not a runtime infrastructure failure.

Supervisor initially authorized design investigation after escalation of Finance's arbitrary descendant capabilities, then test-only prototyping and a bounded diagnosis cycle. No production implementation was authorized after the blocker arose. C2 remains blocked; no implementation/activation claim.

## Exact existing boundary evidence

- `workshop-backend/src/overseer.ts:7382-7401,7445-7657`: Finance boolean bypass selects build role and returns ordinary `OverseerClientInterface`.
- `overseer.ts:8382-8400,8652-8659,8758`: session binds profile/user/owner, not admin provenance; returns GadgetClient and GatekeeperClient children.
- `overseer.ts:10506-10514,10546-10552,10849-10855`: GadgetClient returns arbitrary gadget RPC and binding children; GatekeeperClient returns arbitrary provider sessions. Their return graphs are not closed by the known Workshop interfaces.
- `overseer.ts:2754-2811`: existing Proxy handles only top-level gadget calls/error reporting. It is not a recursive authority membrane; copying it would let returned children escape.
- `overseer.ts:3743-3767`: sharing revocation flushes state, waits 100 ms, then aborts the entire DO. It intentionally relies on disconnect/reopen, not per-call checks.
- `server.ts:669-706`: notifyClosed callback disposal aborts the browser RPC session only when started and not normally closed. It is not an acknowledged revocation barrier and can be bypassed as a notification mechanism by disposing the top-level workspace while retaining a child (normal disposal marks closed).
- `server.ts:1495-1506,1513-1563`: abort signal disposes the Cap'n Web root, but explicitly has no effect on HTTP batches. No durable acknowledgement that all browser sessions were closed exists.
- `__integration__/open-gadget-rpc.test.ts:162-210`: existing workerd tests distinguish poisoned incarnation-bound native stubs from fresh namespace stubs. This does NOT prove transitive revocation of arbitrary returned cross-Worker capabilities. The error-mapping group at line 76 is pre-existing skipped; no skips changed.
- Installed `capnweb/dist/index-workers.d.ts:193-264,383-402`: public custom RpcTransport/RpcSession seam exists, with no public method-invocation admission hook. RpcSessionOptions supports error rewriting/resource limits only (`:266-291`). Native generated types `worker-configuration.d.ts:13080-13111` similarly expose no revocation membrane constructor.
- Installed `capnweb/dist/index-workers.js:67-78,1331-1378`: native RpcStub and ServiceStub are encoded as RPC targets; references nested in payloads become session exports. No raw native capability crosses a string transport.
- Installed Cap'n Web `:2212-2241`: session abort rejects imports and disposes exports. `:2243-2329` evaluates push/stream/map payloads after transport.receive; `:1990-2009` unwraps internal hooks before encoding a resolution, not as raw transport capabilities.

## Candidate 1 — acknowledged durable restart barrier

Not sufficient for the selected contract on current evidence. A revoke could durably mark a generation denied, mark Finance invalidation pending, prevent opens, abort the old Finance incarnation, and only report cleanup done when a fresh incarnation observes the durable fence. But that establishes a new-generation startup barrier, not that every native capability exported to another Worker is irreversibly fenced. Existing source/types do not establish containment for ServiceStub/provider descendants, forwarded callbacks or capabilities stored elsewhere. Delayed abort also leaves an interval after revocation commit in which an old local child admits a call. Moving the public success point to cleanup acknowledgement changes the ADR's post-commit admission guarantee and still needs transitive proof. The restart remains useful cleanup, not sole correctness.

## Candidate 2 — scoped serialized Cap'n Web session boundary

Smallest promising seam: when Finance access derives ONLY from admin bypass (not ordinary owner entitlement), return the real Overseer capability through a private in-memory pair of **public RpcSession/RpcTransport** instances, with string transport and authority checked before each message is released for evaluation. Derive generics from real `Overseer`/`RpcCompatible` types; no handwritten RPC mirror, unknown-cast or ad-hoc Proxy recursion. Because all exported references are serialized into this private session's table, arbitrary children/native ServiceStubs/callback arguments/streams are mediated by the same boundary. Reject and abort the entire private session on missing/stale generation; a later regrant cannot repair it. Ordinary owners/direct-share users reopen through ordinary role evaluation. Existing DO restart can clear stale work/subscriptions but remains best effort.

This is a hypothesis grounded in installed library implementation, NOT a proven guard. It adds a serialization hop per Finance-only admin session, not a new RPC protocol. Keep public browser/native pipelining and derive return types, but extra authority reads and memory/stream overhead need measurement.

### Contract implications requiring approval

Transport admission is per received protocol message, not per every subcall. A Cap'n Web `.map()` payload can contain several instructions (including calls on locally obtained descendants); all are admitted together at the message check. A pipelined message accepted before revocation can resolve and execute after revocation, like other admitted operations in the ADR. If the ADR requires each map instruction to recheck separately, the installed library exposes no public supported hook to implement that; this candidate must be rejected or the admission definition explicitly refined. Do not parse/modify protocol instructions or import private hooks to pretend equivalence.

Reverse-direction callback delivery and stream messages should also check authority, to stop fresh subscription pushes after revocation; already-delivered bytes cannot be erased. Transport cancellation must drain/dispose references even when normal top-level stubs have been disposed. All queues must be bounded using backpressure rather than adding unbounded message buffers.

## Required prototype tests before production approval

A focused real-workerd test fixture, no external providers, no existing tests weakened:
1. Retain workspace/editor/chat/GadgetClient/GatekeeperClient and grandchildren after disposing parent; revoke then every attempted call rejects with no fixture write counter change.
2. Return a separate native Worker service reference and its grandchild from a fixture provider; retain directly, nested in object/array, from callback, and from a promise pipeline. Verify revocation defeats all paths, including round-trip/pass-back of same-session references.
3. `.map()` capture/instructions, lazy promise properties and pre-revocation admission ordering, with a deferred result resolving after revoke. Pin exact guarantee and fresh post-commit message denial.
4. Independent sessions/generations, regrant, authority outage, session close, DO abort/restart, retained descendants after parent disposal, negative storage lookups and no positive cache.
5. Subscription pushes/readable/writable streams, disposal propagation and counts, bounded pending data and unresolved checks; do not manufacture disposer counts/timeouts to pass.
6. Browser WebSocket and HTTP batch bridges; forged input cannot create or swap the backend-owned authority capability.
7. Finance owner remains build and direct-share remains use after admin revoke/reopen; admin-only nonowner denied or downgraded only via fresh open.

Only after this prototype passes and receives review should C2 source work proceed: helper module + Finance open seam, separate AdminAuthority DO/entrypoint/shared types, per-method AdminApi checks, Context/JARVIS consumers, additive v4 and generated env/manifest evidence. Legacy provider drain/live bootstrap stay independently blocked. No production cutover inferred from static vars.

## Final prototype results and recommendation

The supervisor approved the test-only prototype and explicitly accepted per-protocol-message admission, including a whole map payload. No private hooks, protocol parsing, dependency changes, mirrored interfaces or casts were introduced.

### Changed files (C2 only)

- `packages/workshop-backend/__tests__/authority-prototype/transport.ts` — 108 lines; private paired string transports using supported RpcSession APIs, authority before message delivery in both directions, 32-message / 256 Ki UTF-16 code-unit outstanding bounds per direction, whole-session abort cleanup.
- `packages/workshop-backend/__tests__/authority-prototype/worker.ts` — 59 lines; real SQLite DO authority/counters and native service/child/grandchild fixtures, argument duplication, callbacks and streams.
- `packages/workshop-backend/__tests__/authority-prototype/transport.test.ts` — 188 lines; eight initial scenarios plus two matched pass-back controls. Isolated from the default backend `__tests__/*.test.ts` glob.
- `packages/workshop-backend/__tests__/authority-prototype/wrangler.jsonc` — 13 lines; local-only native service/DO fixture wiring. Not a deployed package config.
- `packages/workshop-backend/vitest.authority-prototype.config.ts` — 17 lines; real workerd, remoteBindings false, original assert-workerd setup, no global rejection-ignore handler.
- `docs/plans/hugin-community-requests/IMPLEMENTATION-TODO.md` — records U1 review evidence and C2 blocked stage boundary.
- This configured artifact. No existing .oculus/.pi files altered.

Five prototype files total **385 lines**, all untracked, none staged. Existing U1 tracked diff remains exactly two files / 106 insertions / 15 deletions and matching upstream hashes.

### Exact verification

1. `pnpm --filter @gadgets/workshop-backend exec vitest run --config vitest.authority-prototype.config.ts` — **exit 1**, config startup ERR_MODULE_NOT_FOUND for direct miniflare import copied from scheduler fixture. No tests ran. `/tmp/odie-c2-authority-prototype.log`.
2. Stopped and escalated. Supervisor authorized a narrow config repair and one retry. Used supported Wrangler named self-service binding: installed pool `buildProjectWorkerOptions` rewrites matching configured Wrangler Worker name to current runner. Removed undeclared transitive import; no install/upgrade.
3. Same command — **exit 1**, real workerd 8 tests: **5 passed, 3 failed, 3 unhandled errors**; total 3.03 s, test execution 1.55 s. `/tmp/odie-c2-authority-prototype-retry.log`. Runtime assertion was not weakened.
4. Supervisor authorized one bounded diagnosis cycle. `pnpm --filter @gadgets/workshop-backend exec vitest run --config vitest.authority-prototype.config.ts -t 'native pass-back control'` — **exit 1**, **direct native control PASSED; serialized boundary control FAILED**, one unhandled error, eight other tests excluded by `-t` (not new skip directives). Total 1.73 s / tests 145 ms. `/tmp/odie-c2-authority-pass-back.log`.
5. `/usr/bin/git diff --check` — **exit 0** (tracked files only; new files are untracked). `/usr/bin/git diff --cached --name-only` — empty. HEAD unchanged at initial SHA. Prototype line count from `wc -l` = 385. U1 hashes remain `73c397108e929a228bb92e308aa1379d89d08a9a` and `32b5c317d48da531bbb0313014f82c8e1410d22a`. Final tracked patch `/tmp/odie-c2-final-tracked.diff`.

### Failure classification

**Decisive valid-API incompatibility:** `NativeChild.echo(child) { return child.dup(); }` succeeds in a direct native call with an already-awaited child argument. The otherwise identical call through the serialized boundary fails with `Can't dup an RpcTarget stub as a promise`. Neither test uses a lazy incoming argument or changed provider ownership semantics. Stack points to installed Cap'n Web `TargetStubHook.get` through `Proxy.dup` and native `RpcProperty`. Every explicit application promise in the matched control is awaited; the runtime additionally reports an unhandled capability rejection. This is not made green by removing pass-back, changing arbitrary provider methods to await their declared stub arguments, unsafe casts, or ignoring runtime errors. No supported public admission/argument-normalization hook is present to repair arbitrary native providers at this boundary. This disproves the prototype's transparent compatibility, not evidence that it leaked a write after revoke.

**Stream failure:** infinite 1-byte producer exhausts the fixed 32-message outstanding cap and fails closed with PROTOTYPE_BACKPRESSURE_LIMIT before the revoke assertion. This is bounded adversarial resource exhaustion, not proof ordinary consumer-paced streams cannot work. A paced controlled-source case and separate flood assertion were planned but not added after decisive native incompatibility. Bounds were not increased; the test still fails as evidence.

**Cleanup evidence gap:** disposer fire-and-forgets another DO RPC; observed counter remained zero during its poll. This does not prove the local disposer never ran: its creator context may end before remote completion. Actor-owned local accounting or bounded valid waitUntil lifetime would be needed. No synthetic counter increment/timeout success was added. Cleanup therefore remains unproven.

**Unhandled errors:** the initial pass-back error, stream limit, and HTTP-batch revoked future were visible. No onUnhandledError ignore list was added. Intermediate HTTP-batch future promises require further lifetime observation; not repaired once the valid native pass-back control disproved the candidate.

### Coverage not claimed

No complete WebSocket/native grandchild pass-back success, full stream revocation/cleanup, restart persistence, owner/direct-share Finance integration, capacity measurement, typecheck/build, Context/JARVIS/admin authority suite or production end-to-end coverage. Five passing initial assertions do not establish an acceptable boundary, particularly with unhandled errors. Duration is the test-run cost, not a production latency benchmark; no per-message-cost claim.

### Disposition

Per supervisor instruction, stopped when a genuinely unsupported valid native API remained. **C2 is not implemented.** Keep the failing prototype isolated for review/reproduction; it must not ship as an authority boundary. No AdminAuthority grant/list/revoke/audit/bootstrap data APIs, generation-bound AdminApi/Context/JARVIS/Finance wiring or additive production migrations exist from this stage. All four static admins/auth aliases preserved; existing production static-authority limitations remain. Managed activation and Auto-Build must remain blocked. A separately approved dependency interoperability repair or another proven boundary design is required before resuming C2; no upgrade is recommended as automatic permission.
