# Same-runtime native stream matrix — diagnostic, NOT accepted containment

This isolated fixture imports no Cap'n Web. It preserves Service → SQLite DO →
native RpcTarget → native readable/writable RPC crossings. `provider.ts` copies the
original prototype's paced one-byte source, native sink and bounded five-second
export-context hold, adding only actual producer cancellation/disposal counters.
`scenarios.ts` is the same source in the existing Workers pool and standalone
request handler (TypeScript 6's existing transform removes types for standalone).
The original `authority-prototype/native-stream.test.ts` is unchanged.

## Checked results

Actual evidence: `/tmp/odie-native-matrix-evidence/`. Final standalone fixture:
`/tmp/odie-native-matrix-NBz5yd/`. This is **not** the incomplete CI artifact snapshot.

| Context | Case | Caller/bytes | Extra rejection events | Producer cancel callback | Actual child disposer | Result |
|---|---|---|---:|---:|---:|---|
| pool | pipeTo | original error identity / 2 | 1, unknown promise | 0 | 1 | FAIL |
| standalone | pipeTo | original error identity / 2 | 1, unknown promise | 0 | 1 | FAIL |
| pool | explicit pump | original error identity / 2 | 0 | 0 | 1 | cancellation discrepancy |
| standalone | explicit pump | original error identity / 2 | 0 | 0 | 1 | cancellation discrepancy |
| pool | cancel | successful cancel / 1 | 0 | 0 | 1 | cancellation discrepancy |
| standalone | cancel | successful cancel / 1 | 0 | 0 | 1 | cancellation discrepancy |
| pool | graceful | EOF + native sink write / 1 | 0 | 0 | 1 | PASS |
| standalone | graceful | EOF + native sink write / 1 | 0 | 0 | 1 | PASS |

All final caller assertions and disposal checks pass. Cancellation reasons remain
**null**, not the requested errors. Counts are sampled before disposal and after
actual disposal plus a 50 ms reporting turn, not over an asserted complete native
drain. Final scenarios take 52–71 ms. The five-second hold never increments counts.
Exactly-one producer cancellation with the original reason remains an explicit,
**unproved diagnostic propagation expectation**, not a demonstrated hosted-runtime
guarantee. It is retained as a failed expectation, not changed to zero to pass.
Disposal or successful `reader.cancel()` is not proof that producer cancellation
completed. Native C++ ownership/transfer source is not present in the npm payload;
there is no source-backed rationale here for relaxing the requirement.

The explicit pump observes every public read/write and both closed promises,
cancels/aborts counterparts, records cleanup outcomes, releases locks, and rethrows
the identical destination error. Its `reader.cancel`, `writer.abort` and
`reader.closed` fulfill; `writer.closed` rejects with the destination error. This
is a diagnostic control only, **not** a provider rewrite or transparent bridge fix.

The public rejection listener only records event reason, promise identity and
matches against already-known operation/closed promises. It never calls
`preventDefault` or attaches a handler from an event. Both `pipeTo` events have
identity 1 and match no tracked public promise; this does not identify their
private owner. The pool still reports its unhandled error independently. Standalone
returns HTTP 500 on any extra event or failed expectation (its stderr was empty;
that is not a green result). Metadata is captured before soft assertions.

No context discriminator emerged, so **zero production-flag controls** were run.
The same operation-dependent result outside the pool rules out a necessary role
for Vitest or Cap'n Web in this reproducer. It narrows investigation toward native
pipe shutdown/transfer ownership, but does not identify an exact repair line,
prove a security escape, establish full cancellation/drain, or justify suppression.
No declaration, dependency, native binary or production patch was made.

## Reproduction (requires approved local execution setup)

These are intentionally failing diagnostics, outside the default test glob. Use
the existing versions only. `run-local.py` invokes the existing Vitest JS entry
with its existing real-Workers pool; it is not a different test runner. It also
supports the separately authorized public `workerd serve` request driver.

```sh
E=$(mktemp -d /tmp/odie-native-review.XXXXXX)
D=packages/workshop-backend/__tests__/authority-native-matrix
python3 "$D/run-local.py" "$E" pool baseline vitest.authority-prototype.config.ts native-stream
python3 "$D/run-local.py" "$E" pool matrix vitest.authority-native-matrix.config.ts
TMPDIR=/tmp node "$D/prepare-standalone.mjs" > "$E/standalone-path.txt"
python3 "$D/run-local.py" "$E" standalone
pnpm --filter @gadgets/workshop-backend exec tsc -p tsconfig.authority-native-matrix-tests.json --noEmit
```

Commands intentionally exit nonzero; do not blindly chain with `&&` or retry an
infrastructure failure. The durable driver refuses log overwrites and stops on a
failed preflight or scenario setup/cleanup assertion. Its final refusal/preflight
hardening was syntax-reviewed, **not another matrix rerun**. Executed driver with
exact argv/exits is saved as `run.py` and `commands.jsonl` in the evidence directory.

`prepare-standalone.mjs` requires the pinned Darwin arm64 binary SHA-256
`3da61644318c8fab32e68a504513865aef12329b1356d75d7e6f83a713ea9f7b`.
It copies only that binary and three fixture modules to a fresh narrow temp root.
Date remains `2026-02-02`, flags only `nodejs_compat`. No install, env/config/token
copy, production binding, provider call or external network access is involved.
The SQLite disk service is accessible only as the DO storage backend and points
to a freshly created directory. `/ready` verifies the same DO's actual KV write,
readback and real child disposer before any stream scenario is requested.

The public config explicitly defines `internet` as a terminal deny Worker with
zero imports or bindings. Both Workers explicitly select it as `globalOutbound`.
Its self designation is **not execution recursion**: handlers only throw, never
forward or call outbound APIs. There is no native network service/implicit internet.
The process additionally runs under macOS sandbox-exec external-egress denial;
only a pre-bound loopback descriptor carries local driver HTTP. Standalone denies
original-home reads/writes. The pool needs existing repository/dependency reads,
but denies env/npmrc/config reads and external egress, and has a public outbound
handler that throws. HOME/config/cache are fresh and the environment is explicit.
Startup is bounded to 60 s, each case to 15 s, post-second-chunk cleanup to 5 s and
process shutdown to 5 s. These are fixture bounds, not production policy.

## Failed setup and limited retries — all retained

1. Exact original baseline: 3 passing assertions + one unhandled error, exit 1.
2. First pool matrix: producer cancellation expectations fired before metadata;
   3 failed/1 passed + one extra error. `first-run-source/`, `pool-matrix.*` retain it.
   Supervisor approved one instrumentation correction/rerun: record full outcomes
   first, preserve all expectations. Corrected `pool-corrected.*`: 3 failed/1 passed
   + one extra error, with all four full records in JSON `meta.nativeMatrix`.
3. First standalone launch failed before cases: KJ rejects network deny `public`.
   Stopped/escalated; `startup-failed.log`, `rejected-config.capnp` retain it. One
   approved correction installed the explicit terminal deny Worker described above.
4. Next standalone started, but `inMemory` storage did not provide `storage.kv`
   even with `enableSql=true`. All four invalid-lifetime requests were already sent
   before the harness result was inspected. Their counters/disposal are **unproved**;
   those are not matrix acceptance. Stopped/escalated; `invalid-inmemory/` retains
   config/logs/JSON. One approved storage correction used public `localDisk`, matching
   installed Miniflare's normal SQLite configuration, with same-class readiness and
   immediate result inspection. Final four standalone results are the table above.
5. Initial dedicated tsc used module-scoped Env augmentation and failed. Corrected
   to the original fixture's global `Cloudflare.Env` pattern; final dedicated tsc
   and scoped lint exit 0. No declarations or native provider signatures changed.

Full original prototype rerun: **5 files / 32 assertions pass + 3 unexpected
unhandled errors, exit 1** (`full-prototype.log/json`). Exact original prototype
`tsc`: **7 TS2345 + 2 TS2339**, exit 1 (`full-types.log`). No clean full C2 gate.
C2, dynamic admins/admin UI, restricted Auto-Build/Slack, literal `pnpm test`,
isolated artifact build and remote CI/CD remain incomplete. Board/U1, reviewed
runtime hunks, accepted private-lifetime work, rejected type evidence and the
not-build-ready `/private/tmp/odie-ci-recovery-46npkv13` snapshot remain preserved.
