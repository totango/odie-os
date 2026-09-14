# Test-only authority boundary — BLOCKED, not production code

This directory is deliberately outside the ordinary backend test glob. It uses public string
`RpcSession`/`RpcTransport` APIs and real native Workers RPC. Do not import it from production.
The board uses existing static-admin checks and does not depend on this prototype.

## Current evidence

- The reviewed same-version `patches/capnweb@0.12.0.patch` remains unchanged. Both native `.dup()`
  pass-back controls pass; awaited and true-promise arguments pass in both session directions.
  Native promise/property wrapping and promise duplication also pass at runtime.
- Native children are now created by the fixture DO. Real disposers synchronously update that
  actor's storage; there is no fire-and-forget remote counter. A bounded `waitUntil` keeps the
  exporting IoContext alive. Its deadline only ends the hold, never increments a count. Tests
  check parent disposal, independently retained/returned duplicates, final release and abort;
  target counts are exactly 1/2/3, not one count per local alias of the same target.
- Ordinary readable streams are explicitly paced by the local fixture driver; a separate flood
  starts only after the caller owns the reader and observes `closed`. The transport retains the
  original 32-message/256 Ki UTF-16 bounds. Reader/writer operation and `closed` promises are
  observed locally, never by a global rejection handler. Denied streams reject; their reader's
  disposal error does not preserve the authority error text. A subsequent ordinary call verifies
  the actual boundary abort reason.
- Existing nested descendants, callbacks, parent disposal, generation/regrant/outage, whole-map
  admission, deferred callback response denial and HTTP batching remain covered. Added accepted
  local WebSocket-pair retained-child coverage and missing-authority denial. None is a deployed
  browser/network or production Finance entitlement test.

**The full runtime suite still fails:** 32 assertions pass (including 13 private-lifetime tests),
but Vitest reports three unhandled
rejections (`PROTOTYPE_ADMIN_REVOKED`, `PROTOTYPE_BACKPRESSURE_LIMIT`,
`PROTOTYPE_NATIVE_PIPE_FAILURE`) and exits 1. This is NOT passing containment evidence.

## Private-lifetime experiment (isolated acceptance only)

`transport.ts` now owns both private main stubs and returns ordinary `dup()` aliases. Disposing
an alias or returned parent does not shut down a session with live descendants. Terminal close
rejects active and queued sends exactly once, wakes idle receives, and races each active check
against owned close and a fixture deadline. A late successful check cannot release its message;
the race immediately observes late rejection of this privately abandoned check, not caller errors.
The original 32-message / 256 Ki UTF-16 bounds and first terminal reason are preserved.

Both sessions must receive their original transport failure before disposing their private mains:
public `onRpcBroken` notifications drive an idempotent `closed` promise, whose continuation calls
both real main disposers. Disposing them synchronously before that would replace the original
reason with Cap'n Web's generic main-shutdown error. `closed` is **not** native drain, downstream
RPC cancellation, or proof that previously admitted operations stopped. The default 5000 ms and
short test overrides are fixture-only deadlines, not an approved production timeout policy.

`lifetime.test.ts` checks permanent stalls, close/deadline settlement, late resolve/reject, both
directions pending, original overflow bounds, repeated disposal, root/parent aliases with live
native children, and no late native writes or callback bytes. Public-method observation proves
both private main disposers run exactly once. Actual actor-local native disposer counts remain
exactly 2 disposed parents / 4 total native targets in the descendant case; duplicate aliases do
not manufacture additional counts. Bridge counters reach zero without waiting for the abandoned
check. This does not release or account for durable capacity held by downstream native work.

Targeted runtime: **13 passed, exit 0, no unhandled errors**. Dedicated lifetime/source typecheck:
**exit 0**, scoped lint **exit 0**. The original full runtime and type gates below still fail.
Final logs and pre/post snapshots: `/tmp/odie-lifetime-evidence/`; see implementation TODO for
exact commands, unsuccessful intermediate type checks, and scope/integrity evidence.
Independent review is required before accepting this isolated repair; no production import exists.

## Native stream rejection ownership blocker

`native-stream.test.ts` imports no Cap'n Web API and creates no checked boundary. It obtains a
native readable stream, attaches an assertion to `source.pipeTo(destination)` immediately, and
paces two chunks. The destination throws on the second chunk. The expected `pipeTo` rejection is
observed, **and an additional unhandled rejection with the same error still occurs**. Direct
native reader cancellation and graceful readable/writable completion pass.

`stream-rejection.test.ts` is the contrasting userspace-source checked-boundary control: after
one consumed chunk it revokes admission and emits another chunk. It rejects/cleans up without an
extra unhandled error. The native boundary cases exhibit the same extra-rejection shape as the
no-Cap'n-Web native control. This isolates a path below the proposed authority boundary; it does
not identify the exact private workerd promise or establish a safe repair.

Installed Cap'n Web stream source (recoverable from its shipped source maps) observes the
`readable.pipeTo(writable)` pump in `src/rpc.ts` (`pipeTo(...).catch(...).finally(...)`), stream
write acknowledgments in `src/streams.ts:createWritableStreamFromHook`, and writer abort errors
in `WritableStreamStubHook.dispose`. No justified third Cap'n Web patch was found. No private
hooks, protocol parsing, runtime upgrade, native provider signature rewrite, or suppression was
used. The valid native `.dup()` provider contract is retained.

## Public type compatibility blocker

The old prototype was not typechecked. The new explicit config includes its actual tests and
fixture Env augmentation (derived from `PrototypeEnv`, not a mirrored provider interface).
The original test-file set still exits 1 with six TS2345 argument incompatibilities and one
TS7006 map-inference error, verified against both pre-lifetime and current transport. Including
the new lifetime test in the full glob changes diagnostics in the old files to seven TS2345 and
two TS2339 (`nested.items` on `never`), with no lifetime source/test diagnostics. This mapped-type
instantiation sensitivity is not a type repair or a full type pass. The dedicated lifetime config
passes separately; the full config is unchanged and includes every test. The direct native
`parent.echo(child)` control fails typing as well as its serialized equivalent.

Relevant installed mappings:
- `worker-configuration.d.ts:12999`: native `Unstubify<T>` maps a stub to its underlying `V`;
  `:13025` uses that transformation in method arguments.
- `capnweb/dist/index-workers.d.ts:65-80`: `UnstubifyInner`/`Unstubify` likewise unwrap input stub
  brands, and `:125` applies them to methods. With these native declarations, a valid async stub
  argument is compared to `NativeChild` (including private fields / synchronous target methods).
- `transport.test.ts:25` is the direct-native TS2345 control, `:34` its boundary counterpart;
  callback/pass-back and `native-compatibility.test.ts:13,17` also fail. `transport.test.ts:97`
  has the unresolved map callback inference diagnostic.

A `Pick` projection experiment did not repair the sync/async mismatch and was removed. There are
no casts, hand-written RPC mirrors, `ts-ignore`/`ts-expect-error`, or weakened declarations to
make this green. Runtime success is not type-safe production compatibility.

## Reproduce (local fixtures only)

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
# PASS: 2 controls, other tests excluded by this filter, not claimed passing.
pnpm --filter @gadgets/workshop-backend exec vitest run --config vitest.authority-prototype.config.ts -t 'native pass-back control'
# PASS: 2 dependency runtime regressions, both directions and native promises/properties.
pnpm --filter @gadgets/workshop-backend exec vitest run --config vitest.authority-prototype.config.ts native-compatibility
# FAIL: 3 assertions pass + 1 unhandled native pipe rejection, exit 1.
pnpm --filter @gadgets/workshop-backend exec vitest run --config vitest.authority-prototype.config.ts native-stream
# PASS: userspace source rejection control.
pnpm --filter @gadgets/workshop-backend exec vitest run --config vitest.authority-prototype.config.ts stream-rejection
# PASS: 13 private-lifetime tests, zero unhandled errors (not full containment).
pnpm --filter @gadgets/workshop-backend exec vitest run --config vitest.authority-prototype.config.ts lifetime
# PASS: new lifetime tests and their real source/native fixture types.
pnpm --filter @gadgets/workshop-backend exec tsc -p tsconfig.authority-lifetime-tests.json --noEmit
# FAIL: 32 assertions pass + 3 unhandled rejections, exit 1.
pnpm --filter @gadgets/workshop-backend exec vitest run --config vitest.authority-prototype.config.ts
# FAIL: public native input mappings/inference; separate from shipped-code build.
pnpm --filter @gadgets/workshop-backend exec tsc -p tsconfig.authority-prototype-tests.json --noEmit
```

Remaining gates include downstream permanently unresolved native authority work/capacity ownership,
DO restart/persistent generation behavior, production Finance owner/direct-share regression through
a proposed guard, capacity/latency measurements, full subscription lifetime accounting and legacy
capability drain. Private bridge-wait interruption does not cancel the underlying authority RPC.
Passing some native disposal assertions does not prove all cleanup paths. C2, dynamic admins and
Auto-Build remain unimplemented; no production authority wiring is authorized by this evidence.
