# Cap'n Web 0.12.0 compatibility repair

`capnweb@0.12.0.patch` has two independent runtime fixes, applied consistently to the six
ESM/CJS browser/default, Workers and Bun bundles. No version, protocol, public declaration or
authority mechanism changed. The package ships bundles rather than TypeScript source; source
locations below are recoverable from the shipped source maps. Maps retain upstream source.

1. **Native reference pass-back:** `Evaluator`'s `import/pipeline` `addStub` nonpromise branch
   must construct `RpcStub`, not `RpcPromise`. Upstream `src/serialize.ts` explicitly documents
   this distinction. Otherwise a returned native stub passed back into a valid native
   `echo(child) { return child.dup(); }` API fails with `Can't dup an RpcTarget stub as a promise`.
   The true `pipeline` branch is unchanged. The preserved real-native prototype controls now
   both pass; this does not establish revocation, stream or disposal containment.
2. **Synthetic rejection ownership:** `ErrorStubHook.pull()` owns the synthetic rejected
   promise it creates. `RpcImportHook.pull()` / `ImportTableEntry.awaitResolution()` and
   `pullPromise()` forward that failure through async boundaries to the application. Workerd
   reported the intermediate rejection independently even with manual caller try/await/catch;
   the matching Node control did not. Observe this one privately created promise immediately,
   and return **the identical rejected promise**, not the observer's fulfilled result. No error
   identity replacement, catch-and-resolve, global rejection listener, session error hook,
   caller-promise handler or prototype suppression is added.

The normal real-workerd `__tests__/capnweb-compatibility.test.ts` checks missing-method denial,
deliberate programmer failure, repeated observation/error identity, application forwarding and
rethrow, and true-promise substitution/pipelining. The board test retains real serialized
signed-out denial. Before hunk 2, those assertions passed but the suite failed for duplicate
unhandled rejections; after it, both caller rejections still occur and the suite passes.

## Reproduction (local only)

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/capnweb-compatibility.test.ts __tests__/community-requests.test.ts
pnpm --filter @gadgets/workshop-backend exec vitest run --config vitest.authority-prototype.config.ts -t 'native pass-back control'
```

The two native controls are intentionally part of the isolated prototype; tests excluded by
`-t` are **not** passing authority evidence. No production C2 guard ships.

### Caller-owned unhandled rejection diagnostic — expected exit 1

```sh
pnpm --filter @gadgets/workshop-backend exec vitest run --config vitest.outer-unhandled.config.ts
```

`__tests__/compatibility-diagnostics/outer-unhandled.test.ts` deliberately leaves an outer
`Promise.resolve(batch.fail())` unobserved. It must report one unhandled
`UNOBSERVED_OUTER_CALLER_FAILURE` and exit **1**, demonstrating that the patch did not silence
caller-owned failures. It has no rejection handler. This nested fixture and its explicit config
are excluded from normal/backend and authority test globs; do not add it to ordinary test runs,
mark its expected nonzero exit as a passing suite, or suppress its error.

Independent review must inspect the synthetic promise ownership, not just green test totals.
Full authority containment remains a separate, incomplete gate. The later RPC repair stage reused
this patch unchanged and verified native pass-back in both directions, native promise/property
wrapping, and actor-owned native target disposal. Its full runtime prototype still exits 1 for
three unhandled native stream rejections; a direct-native `pipeTo` failure reproduces without
Cap'n Web. Its explicit test-source typecheck also fails native input mappings/inference. See
`packages/workshop-backend/__tests__/authority-prototype/README.md` for exact controls, commands,
and remaining gates. These failures do not authorize another speculative dependency patch.
