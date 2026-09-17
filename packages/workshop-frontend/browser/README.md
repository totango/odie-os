# Real-browser app continuity regression harness

This is a standalone development-only Vite entry point mounting **the real
`GadgetUI`**. It is not a production route, is not under `src` or `public`, and is
not imported by the production entry point or Vite config. Its own Vite config
refuses builds and binds only to `127.0.0.1`. It has no backend proxy and uses no
credentials, production access, or arbitrary host capability.

The fixture uses actual Cap'n Web `RpcTarget`/`RpcStub` objects and MessagePort
sessions. Replacing the endpoint disposes the old transport; the delayed case
holds the replacement behind a manually released promise. GadgetUI's generated
sandboxed `srcDoc`, injected client code, CSP, handshake and bridge are unchanged.
The iframe sends a source/origin-checked boot beacon, has a unique per-document
token, an unsaved input, a tall scrollable document and a server-read button.
No storage rehydration can disguise a reload. React `Activity` really hides and
shows the component; this is not a mocked effect cleanup.

## Run from the repository root

The coordinator owns dependency installation/lockfile generation. The package
manifest adds the dev dependency `@playwright/test@1.58.2`. Once it is installed:

```sh
pnpm --config.verify-deps-before-run=false --filter @gadgets/workshop-frontend exec playwright install chromium
pnpm --config.verify-deps-before-run=false --filter @gadgets/workshop-frontend test:browser:continuity
```

To reuse an installed Chrome instead of downloading Chromium:

```sh
CONTINUITY_BROWSER_CHANNEL=chrome pnpm --config.verify-deps-before-run=false --filter @gadgets/workshop-frontend test:browser:continuity
```

`verify-deps-before-run=false` prevents pnpm 11 from unexpectedly starting an
installation while the coordinator is installing dependencies. It does **not**
make missing dependencies available. Tests start and stop their own isolated
server on port 4179; an occupied port fails rather than attaching to another app.

## Assertions and baseline status

All assertions target the fixed behavior, with no expected-failure annotations.
GadgetUI coverage (`continuity.pw.ts`):

1. Fast replacement: one document boot; unchanged token/draft/scroll; reads
   return `epoch-2`. This is the positive control.
2. Replacement held for 6.2 real seconds: same preservation assertions and
   successful read from `epoch-2`. No fake timers.
3. Activity hide/show: same document/draft/scroll **and a working RPC read**.

Every test reaching the continuity assertions logs before/after JSON and attaches
`continuity-evidence`; failures retain a Playwright trace and screenshot under
the ignored `browser/test-results/` directory.

Management coverage (`management.pw.ts`) mounts the real `SandboxedGatekeeperApp`
inside the real AuthProvider, ThemeProvider and an isolated memory router. Its
synthetic auth target exposes no real identity or backend; its iframe has an
opaque origin and restrictive CSP. It covers identical-HTML capability replacement
and Activity hide/show, checking both document state and `host.ui.read()`.

### Captured baseline

Real Chrome, revision `52577672252eab20208b3e0d57b97c4cf1efaeba`, with **no runtime
diff** in GadgetUI or SandboxedGatekeeperApp at capture:

| Case | Result | Observed evidence |
| --- | --- | --- |
| Gadget fast replacement | PASS | One boot, same document/draft/scroll, RPC returns epoch-2 |
| Gadget 6.2-second replacement | FAIL | Two boots, changed document token, empty draft, scroll 640→0; RPC returns epoch-2 |
| Gadget Activity | FAIL | One boot, document/draft/scroll retained; RPC errors `Peer closed MessagePort connection.` |
| Management capability replacement | FAIL | Two boots, changed token, empty draft, scroll 640→0; RPC returns epoch-2 |
| Management Activity | FAIL | One boot, document/draft/scroll retained; RPC errors `Peer closed MessagePort connection.` |

The gadget baseline was run with the command above (3 tests, 1 passed / 2 failed).
The management baseline was run separately to preserve those original traces:

```sh
CONTINUITY_BROWSER_CHANNEL=chrome pnpm --filter @gadgets/workshop-frontend test:browser:continuity management.pw.ts --output=browser/artifacts/management-baseline
```

Ignored local baseline evidence:
- `artifacts/gadget-baseline.json`: narrow before/after summary, retained across reruns.
- `test-results/`: original gadget failure traces, screenshots and error contexts.
- `artifacts/management-baseline/`: management failure traces/screenshots/contexts.
- `artifacts/management-baseline.json`: narrow before/after summary.

A default rerun replaces `test-results/`; use a fresh `--output=browser/artifacts/<name>`
to preserve the original traces. Assertions remain red intentionally until the
runtime fix lands; do not invert them or mark expected failures.

This is a focused component/browser regression, not an end-to-end WebSocket/auth/
backend reconnection test. It does not yet cover child capability reacquisition,
subscriptions, management dependency replacement, or the app-open route lifecycle.

## Extended lifecycle coverage and CI

`lifecycle.pw.ts` additionally checks an immediate module-level read behind gated
initial acquisition, hidden-first Activity with bootstrap cancellation, a **60s
wall-clock outage**, 100 reconnect/hide/show cycles, final unmount while hidden
for both surfaces, and explicit acceptance of changed management HTML. Outage
and suspension must not replay arbitrary gadget writes: only initial authorized
bootstrap can wait; later reads are explicitly retried after recovery.

The Vite-only `session-ledger.ts` alias delegates to the real Cap'n Web library
and records session creation, explicit root disposal and broken notifications.
Fixture transport sessions are labeled separately from component sessions,
including actual generation membranes. It neither forces nor guesses GC, counts
iframe-side sessions, nor claims to measure heap/object retention. Its snapshot
function returns copied scalar records, not capabilities. Tests compare live
session counts to the measured initial baseline, not a hard-coded membrane design.

Initial extended full Chrome run: **11 passed, 1 failed, reported duration 2.0m**.
The failure was the absent management HTML-update acceptance button, not a harness
startup failure. The 100-cycle run observed 5→605 total session creations while
live counts stayed at 5 (3 component, 2 fixture); document token, draft and scroll
were unchanged. Both hidden-unmount cases reached zero live sessions. Evidence is
under ignored `artifacts/extended-full/` and `artifacts/extended-full-summary.json`.

Final verification after the management acceptance repair: **12 passed, 0 failed,
reported duration 2.0m**, including the 60-second outage and 100 cycles (36.4s).
Live session counts again remained 5→5 after 605 cumulative creations. The env
passthrough policy passed 4/4 and the complete root scripts suite passed 201/201.
`CONTINUITY_BROWSER_CHANNEL` is intentionally classified as `external`: only the
directly invoked Node-side Playwright runner reads it, not a production build.
The ignored `artifacts/final-verification-summary.json` records the commands and
observed results; the complete workspace package test suite was not rerun here.

The separate `Browser continuity (Chromium)` CI job installs pinned Playwright's
Chromium with `--with-deps`, explicitly runs this suite on pull requests and main
pushes, and uploads failure artifacts for seven days. It needs no deployed app or
secrets. The local suite takes approximately two minutes; installation is separate.
Repository branch protection must require that job if it is to block merges.
