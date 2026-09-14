# Isolated native / Cap'n Web declaration experiment — blocked

These are compile-only public-type regression fixtures, **not production authority code** and not default runtime tests. No dependency declaration change is retained. The reviewed board, U1, private-lifetime transport and both Cap'n Web runtime patch hunks remain unchanged.

## Reproduce the restored baseline

From the repository root:

```sh
pnpm --filter @gadgets/workshop-backend exec tsc -p tsconfig.authority-types-native.json --noEmit
pnpm --filter @gadgets/workshop-backend exec tsc -p tsconfig.authority-types-boundary.json --noEmit
pnpm --filter @gadgets/workshop-backend exec tsc -p tsconfig.authority-prototype-tests.json --noEmit
```

These commands currently **fail**, intentionally preserved as unsolved compiler evidence, not skipped assertions. Native-only reports two errors: legitimate stub input rejected and a declared stub return double-wrapped. The unchanged full prototype reports nine errors (7 TS2345, 2 TS2339). Source builds exclude these explicit test configs; a source build pass is not their acceptance.

- `native.ts`: real private targets, unchanged `echo(child: RpcStub<NativeTypeChild>) { return child.dup(); }`, target/stub inputs, exact awaited result, and negative unrelated-private-target, lookalike, callable and arbitrary-native-promise controls.
- `boundary.ts`: actual `PrototypeService` and checked boundary, both directions, awaited/true-promise pass-back, property/promise wrappers, duplicate, inferred map and **unannotated callback**. Explicit `IsAny` assignments reject silently erased callback/map inference. Original provider/test signatures are not rewritten.
- `owned-projection.ts`: diagnoses why the first candidate never recognized natives. `Omit<RpcStub<unknown>, "onRpcBroken">` retains a `dup()` whose return still includes `onRpcBroken`.
- `recognition.ts`: the separately authorized correction projects only the actual public brand and disposal keys. Eight positive/negative type assertions prove native target/callable recognition, payload identity, and rejection of unrelated target/callable shapes, raw targets and lookalikes **before** normalization is applied.

## Bounded results

| Stage | Compiler result |
| --- | --- |
| Native baseline, runtime-only fresh generated types | exit 1; 2 diagnostics |
| One workerd native algebra candidate | exit 0; native positive/negative controls pass |
| First boundary candidate (incorrect Omit discriminator) | exit 1; full prototype still has 8 diagnostics |
| Corrected discriminator recognition gate, restored dependencies | exit 0; all 8 assertions |
| Same native algebra + one explicitly authorized corrected boundary candidate | native controls exit 0; **exact original prototype tsc exits 0** |
| Additional unannotated callback acceptance under that corrected candidate | **exit 1; TS7006 plus TS2322 from the explicit IsAny assertion** |

The final residual is **callback contextual typing**, not failure to recognize the common native brand. Native `Unstubify` now retains the valid callable stub alternative, while the native provider's callback input also retains the original local function signature. Their boundary union does not contextually type the callback parameter. The earlier Omit failure is not evidence normalization is impossible; the corrected experiment actually removes all original prototype diagnostics. Annotating the callback would hide the new failure and is not accepted. No further mapping redesign was attempted.

Full runtime with the corrected declaration candidate: **5 files / 32 assertions pass, exit 1 with 3 unexpected native-stream rejections** (`PROTOTYPE_NATIVE_PIPE_FAILURE`, `PROTOTYPE_ADMIN_REVOKED`, `PROTOTYPE_BACKPRESSURE_LIMIT`). A restored-dependency filter covering native pass-back, promise/property, callback and recorded map controls passes **6 tests**, exit 0 (26 excluded only by command filter). No runtime error was suppressed.

## Rejected candidates and ownership

`rejected-candidates/` is inert review evidence, **not pnpm patch configuration**. It contains the native worker.mjs candidate and the selected public `index.d.ts` diffs for both boundary candidates. The full six-variant declaration diffs are in the external evidence directory. Do not apply or ship them as an accepted repair.

- Workerd remains **1.20260801.1**; only the embedded public Rpc declarations in its `worker.mjs` were experimentally changed. Native binary SHA-256 remains `3da61644318c8fab32e68a504513865aef12329b1356d75d7e6f83a713ea9f7b`.
- Cap'n Web remains **0.12.0**; candidate edits covered all six `.d.ts` / `.d.cts` variants, including the selected public entry. No runtime bundle or source map changed.
- Wrangler generated fresh scratch outputs to avoid the version/date/flags cache. Sanitized temporary configurations retained the existing dates/flags and used a clean HOME with telemetry/env-file loading disabled. The corrected exact check used a fresh sibling declaration generated by Wrangler and the repository's existing `ensureRestoreExport` postprocessor, temporarily replacing the complete generated file; it was not hand-edited.
- Both candidate cycles restored the original type worker/declarations. Final generated backend types, patch/lock/workspace metadata, native binary and exact U1 hashes are unchanged. No candidate was patch-committed or installed durably. Only this stage's pnpm patch-session metadata was removed; the earlier board patch session was preserved.

Actual logs, scratch generators/configs, full candidate diffs, exits and pre/post hashes: **`/tmp/odie-types-evidence/`**. `exits.log` records unsuccessful setup controls too: the first minimal config accidentally loaded the project header without source ambient declarations; another scratch config guessed the pool type-file path incorrectly. Both were corrected without changing a compiler/candidate. The first recognition negative used a DurableObject where native `RpcStub` requires a stubable target; corrected to the actual native RpcTarget base. These are failed fixture setup checks, not passing compatibility evidence.

Remaining acceptance includes inferred callback argument/result correctness and the broader positive/negative collection/function matrix, root build/test regressions **if a declaration repair is retained**, zero-unhandled full runtime, and independent review. No root build/test rerun was needed for a retained declaration repair here because **none is retained**. Production C2, dynamic admins/admin UI, restricted Auto-Build/Slack, literal root `pnpm test`, isolated deployment artifacts and CI/CD remain incomplete.
