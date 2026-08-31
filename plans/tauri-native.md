# Tauri native applications plan

*Status: locally test-ready implementation. Tauri shell, runtime adaptation, durable native Google login, verified-link plumbing, and OS-vault/biometric-gated Stronghold storage are implemented. Connector OAuth generalization, production association identities, signing/store credentials, and physical-device validation remain release gates. Section 21 supersedes earlier progress snapshots where they conflict.*

This plan supersedes `plans/capacitor-mobile.md`. It was prepared on branch
`plan/tauri-mobile-desktop` from local `main` at `8e3cc05`.

## 1. Goal and success criteria

Ship the existing Workshop as store-ready native applications built with Tauri v2 for:

- macOS, distributed directly as a signed and notarized application;
- iOS, distributed through TestFlight and the App Store; and
- Android, distributed through an internal Play track and the Play Store.

The applications must bundle the React/Vite frontend, connect to one branded Cloudflare-hosted
Workshop origin, and preserve the existing web deployment. The first release requires web-product
feature parity plus native platform essentials and a biometric lock. It must support the current and
previous major OS generations, subject to an explicit compatibility check against the selected Tauri
and plugin versions.

Success means:

1. One frontend codebase serves web, macOS, iOS, and Android without loading remote executable UI.
2. Every existing Workshop route and workflow works, including gadgets, gatekeeper management UIs,
   connector management, coding sessions, terminal, uploads/downloads, sharing, and admin surfaces.
3. Google gatekeeper sign-in and every connector OAuth connect/reconnect/grant flow use the system
   browser and return automatically through verified HTTPS Universal Links/App Links. No provider
   login page is embedded in the app WebView.
4. Cold-start, warm-start, suspension, process death, cancellation, duplicate callback, expired flow,
   wrong-account, offline, and network-transition cases recover deterministically.
5. Ordinary Workshop links (workspace, blueprint, share, gatekeeper, `/admin`, and every other SPA
   route) open in the installed app. Only non-SPA surfaces are excluded: APIs, OAuth-provider
   callbacks, screenshots, association files, and static assets. Existing authentication and
   authorization still protect `/admin`; claiming its URL grants no access. Web fallback remains
   functional.
6. Session credentials are never stored in `localStorage` in production native builds. Secret storage
   and biometric release behavior are proven on all three platforms or a platform-specific exception
   is explicitly approved.
7. Native commands are default-deny and unavailable to gadget and opaque-origin gatekeeper iframes.
8. CI can reproduce signed artifacts from a tagged commit without exposing signing secrets.
9. Existing web behavior, tests, deployment, and security boundaries remain unchanged.

Not included unless separately approved: push notifications, background agent execution, offline data
caches/action queues, camera capture, or server-driven live replacement of bundled frontend assets.
Launch manifests and entitlements must prove that camera and notification permissions are absent.

## 2. Confirmed product decisions

| Decision | Choice |
|---|---|
| Native framework | Tauri v2; supersede the deferred Capacitor direction |
| UI delivery | Immutable bundled Vite assets |
| Backend | Existing Cloudflare Workers, Durable Objects, KV/R2, gatekeepers, and WebSocket RPC |
| Deployment selection | One branded production origin; separate controlled dev/staging build flavors |
| Scope | Full web feature parity |
| OAuth UX | System browser for all login/connect/reconnect/grant flows; automatic verified-link return |
| Required login | Google gatekeeper sign-in; password and Cloudflare Access are not launch acceptance requirements |
| Deep links | OAuth return plus every SPA route, including workspace/share, gatekeeper, and `/admin`; non-SPA paths are excluded |
| Native launch features | Secure secret storage, biometric lock, external browser, verified links, native file open/save/share, clipboard, safe areas, keyboard/back behavior, and lifecycle/network recovery |
| macOS distribution | Direct signed/notarized application, not Mac App Store |
| iOS/Android distribution | App Store and Play Store |
| Support policy | Current and previous major OS generations, finalized against pinned dependencies |

## 3. Context research dossier

### 3.1 Source map and evidence

- `AGENTS.md`: the frontend is a client-only SPA; the backend is a Cloudflare Worker kernel; Cap'n Web
  runs over one persistent WebSocket; RPC stubs and capability boundaries must be preserved.
- `pnpm-workspace.yaml`: every `packages/*` directory is a workspace package; shared dependency
  versions and supply-chain release-age rules apply.
- `package.json`: root build/test/lint use pnpm and Vite+ task orchestration. A native package must
  integrate without causing recursive duplicate builds or bypassing task environment declarations.
- `packages/workshop-frontend/vite.config.ts:14-54`: frontend build is a cached Vite+ task, declares
  `VITE_*`, emits `dist/**`, and excludes generated output. Native configuration inputs must be
  fingerprinted; do not hide build-flavor variables in package scripts.
- `packages/workshop-frontend/src/main.tsx:88-101`: production RPC currently derives `/api` WSS from
  `window.location`. A packaged `tauri://localhost`/platform WebView origin would target itself, not
  the Cloudflare backend.
- `packages/workshop-frontend/src/components/auth/OAuthButtons.tsx:47-91`: gatekeeper login depends on
  `window.open`, popup-close polling, an in-flight RPC capability, and `localStorage` token storage.
- `packages/workshop-backend/src/auth/login-flow.ts:25-73`: `PendingLogin` has no durable storage and
  relies on an in-flight waiter. Mobile suspension or process termination can lose the rendezvous.
- `packages/workshop-backend/src/server.ts:1037-1072`: `startGatekeeperLogin()` returns a provider URL
  plus an unguessable RPC attempt capability; the client intentionally never receives a login ID.
- `packages/workshop-frontend/src/ConnectAccountModal.tsx:62-76` and
  `ResourcePicker.tsx:397-455`: connect, reconnect, and incremental grant flows also rely on popup or
  full-page browser behavior.
- `packages/router/src/index.ts:26-52`: `/api`, screenshots, and `/gatekeeper/<vendor>` share the public
  origin. Provider OAuth callbacks terminate inside individual gatekeeper workers, whose success
  pages currently self-close in several packages.
Current connector inventory from `packages/gatekeeper-*` (S5 must verify and keep this table current):

| Package(s) | Current initiation class | Native return requirement |
|---|---|---|
| Google | Fixed-provider OAuth; advertises auth login | Required for login, connect, reconnect, and incremental grant |
| GitHub, Cloudflare | Fixed-provider OAuth; advertise auth login | Required for connect/reconnect/grant; login remains web-compatible but is not native launch acceptance |
| Confluence, Linear, Notion, Slack, Spotify, Supabase, ZoomInfo | Fixed-provider OAuth with self-closing browser completion | Required for every applicable connect/reconnect/grant flow |
| Email, Home Assistant, Team PI | Browser-interactive custom/nonstandard flow with self-closing completion | Required; test each actual flow rather than treating it as OAuth |
| ODIE KG | First-party external OAuth; may advertise auth when configured | Required for connect/reconnect and configured behavior; native login is not launch acceptance |
| MCP, MCP Portal | Dynamic OAuth discovery from user/admin endpoint | Required; must retain SDK endpoint, redirect, and SSRF validation through branded launch trampoline |
| Context, Jarvis, Scheduler, Sessions | Auto-provisioned, no browser initiation | No deep-link return; prove native behavior stays browser-free |

A conformance test must fail when a new `packages/gatekeeper-*` package has no classification. S5 must
also record which packages actually implement incremental grants rather than inferring that every row
does.
- `packages/workshop-backend/src/server.ts:1247-1263`: Cloudflare Access rejects a native cross-origin
  `/api` connection. Access is therefore excluded from launch until it gets a separate design.
- `packages/workshop-backend/src/server.ts:1299-1315`: non-Access RPC uses in-band authority and already
  allows cross-origin batch/WebSocket use.
- `packages/workshop-frontend/src/useAuth.ts:62-68,104-137`, `LoginPage.tsx:41`, and
  `ProtectedRoute.tsx:19`: authentication reads/writes browser `localStorage` and logout has a
  browser-relative Access path.
- `packages/workshop-backend/src/client-errors.ts:88-101`: frontend error reporting enforces same
  origin, so the native origin needs an explicit, non-authoritative transport contract.
- `packages/workshop-frontend/src/errorReporting.ts:187-196`: reporting posts to relative
  `/api/client-errors`; page-location normalization must never include share fragments or deep-link
  secrets.
- `packages/workshop-frontend/src/BlueprintModal.tsx:530` and `ShareModal.tsx:540-624`: generated public
  links use `window.location.origin`, which is wrong in a bundled app. Share URLs can contain a bearer
  capability in `#share=` and must never be logged or moved into a query string.
- `packages/workshop-frontend/src/fileTransfers.ts:25-97`: file export uses browser save picker/blob
  download fallbacks; native file destinations and share sheets need an adapter.
- `packages/workshop-frontend/src/SandboxedGatekeeperApp.tsx:273-456`: management UIs run as
  `srcDoc`, opaque-origin, sandboxed iframes and communicate over a MessagePort capability. Tauri APIs
  must remain inaccessible to these frames.
- `packages/workshop-frontend/src/GadgetUI.integration.test.tsx`: gadget iframe identity and reload
  behavior already have integration tests that must remain mandatory.
- `packages/workshop-frontend/src/routes`, `router.tsx`, and generated route tree: TanStack Router uses
  browser history. Cold/warm native links and Android back behavior require a native-aware route
  ingress without forking route definitions.
- `plans/capacitor-mobile.md`: contains useful prior requirements for origin abstraction, durable OAuth,
  secure storage, lifecycle, mobile UX, and test matrices, but its framework/desktop decision is now
  superseded.

### 3.2 External Tauri and platform evidence

Implementation must re-check these official references at dependency-pin time:

- Existing Vite frontend configuration: <https://v2.tauri.app/start/frontend/vite/>
- Platform prerequisites: <https://v2.tauri.app/start/prerequisites/>
- Tauri capabilities/default-deny permissions: <https://v2.tauri.app/security/capabilities/>
- Content Security Policy: <https://v2.tauri.app/security/csp/>
- Deep-link plugin, Universal Links, and Android App Links:
  <https://v2.tauri.app/plugin/deep-linking/>
- External opener permissions: <https://v2.tauri.app/plugin/opener/>
- Stronghold secret vault: <https://v2.tauri.app/plugin/stronghold/>
- Biometric plugin: <https://v2.tauri.app/plugin/biometric/>
- macOS signing/notarization: <https://v2.tauri.app/distribute/sign/macos/>
- iOS signing: <https://v2.tauri.app/distribute/sign/ios/>
- Android signing and Play distribution: <https://v2.tauri.app/distribute/sign/android/> and
  <https://v2.tauri.app/distribute/google-play/>
- Google OAuth native-app policy (external user-agent; no embedded WebView):
  <https://developers.google.com/identity/protocols/oauth2/native-app>
- OAuth for native apps threat model: <https://datatracker.ietf.org/doc/rfc8252/>

Observed Tauri constraints:

- `build.devUrl`, `build.frontendDist`, `beforeDevCommand`, and `beforeBuildCommand` integrate an
  existing Vite app. Physical mobile development also needs `TAURI_DEV_HOST` and a strict matching
  Vite port.
- Deep-link schemes/domains are statically registered. iOS Universal Links require an
  `apple-app-site-association` file and associated-domain entitlement; Android verified App Links
  require `assetlinks.json` tied to the signing certificate.
- Cold-start links (`getCurrent`) and links received while running (`onOpenUrl`) are separate paths.
- External URL opening and every JS-to-Rust command require explicit capabilities. Remote content has
  no Tauri API permission by default; retain that default.
- Stronghold is a Tauri-supported encrypted vault but is not automatically the Apple Keychain or
  Android Keystore. The implementation spike must compare it with a maintained native keychain/
  keystore plugin or a small package-owned mobile plugin before selecting secret storage.
- The official biometric plugin covers iOS/Android; macOS Touch ID support must be validated or
  supplied by a narrowly scoped custom command. Do not silently downgrade the user-selected biometric
  lock on macOS.
- Tauri desktop updater does not replace App Store/Play Store update mechanisms. Direct macOS may use
  signed Tauri updates; iOS/Android must use store releases.

### 3.3 Commands run

Research used repository file reads, `find`, targeted `rg`, `git log`, package manifest inspection,
and official Tauri/Google documentation searches.

Implementation readiness commands run on 2026-08-27:

- `pnpm install --frozen-lockfile --ignore-scripts --reporter append-only` — passed after adding the native/frontend Tauri packages to the lockfile.
- `pnpm --filter @gadgets/workshop-frontend test:run` — passed (48 files, 288 tests).
- `pnpm --filter @gadgets/router test:run` — passed (1 file, 13 tests).
- `pnpm --filter @gadgets/typed-storage build && pnpm --filter @gadgets/workshop-backend test:run` — passed (typed-storage build; backend unit + integration suites passed). A direct backend test run before building typed-storage failed because the pre-existing workspace package exposes `dist/index.js`.
- `cargo fmt --check --manifest-path packages/workshop-native/src-tauri/Cargo.toml` — passed.
- `cargo clippy --manifest-path packages/workshop-native/src-tauri/Cargo.toml -- -D warnings` — passed.
- `cargo test --manifest-path packages/workshop-native/src-tauri/Cargo.toml` — passed (5 tests).
- `pnpm --filter @gadgets/odie-os-native tauri build --debug` — passed, producing `packages/workshop-native/src-tauri/target/debug/bundle/macos/Odie OS.app`. An earlier `targets: all` attempt built the binary but failed at unsigned DMG bundling; local readiness now targets the app bundle while signing/notarization remains gated.

Review repair validation on 2026-08-28:

- `pnpm --filter @gadgets/workshop-frontend test:run src/runtime/deepLinks.test.ts src/runtime/runtime.test.ts` — passed (2 files, 6 tests).
- `pnpm --filter @gadgets/workshop-backend test:run` — passed (backend unit and integration suites). A targeted script invocation with `native-browser-flow.test.ts` still forwards the file filter to the integration config and fails there; direct unit invocation below proves the moved test is runnable.
- `pnpm --dir packages/workshop-backend exec vitest run __tests__/native-browser-flow.test.ts` — passed (1 file, 2 tests).
- `cargo fmt --check --manifest-path packages/workshop-native/src-tauri/Cargo.toml`, `cargo clippy --manifest-path packages/workshop-native/src-tauri/Cargo.toml -- -D warnings`, and `cargo test --manifest-path packages/workshop-native/src-tauri/Cargo.toml` — passed.
- `pnpm exec vp run -F @gadgets/workshop-frontend build && pnpm exec vp run -F @gadgets/workshop-shared build && pnpm exec vp run -F @gadgets/workshop-backend build` — passed.
- `pnpm --filter @gadgets/odie-os-native tauri build --debug` — passed, producing the debug macOS app bundle with the narrowed app-link config and CSP.
- `git diff --check` — passed.

### 3.4 Patterns to preserve

- Keep kernel/shared API diffs small, documented, and capability-derived.
- Keep the web app operational and default behavior browser-native.
- Continue Cap'n Web promise pipelining and dispose every stub.
- Keep credentials and gatekeeper capabilities server-side.
- Keep gadget/gatekeeper frames opaque and network/native-bridge isolated.
- Keep share fragments out of logs, reports, analytics, referrers, and server requests.
- Use package-owned structured logging on Workers; never log prompts, headers, tokens, bodies, or
  raw deep links.
- Use pnpm and Vite+ tasks; account for every output-affecting environment variable.

## 4. Memory and prior art

No AgentDB/Agent Wisdom result was required. Repository prior art is the superseded Capacitor plan,
whose framework choice is rejected but whose security and lifecycle lessons are retained. The Tauri
plan must not copy Capacitor APIs or plugin assumptions.

## 5. Assumption and question ledger

### Known

- Tauri v2, bundled UI, one branded origin, full parity, store readiness, all OAuth deep-link returns,
  notarized direct macOS, and biometric lock are approved.
- Google gatekeeper sign-in is the required launch login flow.
- Password and Cloudflare Access login are not launch acceptance requirements. Existing web password
  behavior must not regress.
- Push, offline data queues, and background execution are not launch features.

### Safe implementation defaults

- Use verified HTTPS links as primary callbacks; reserve a custom scheme only as an explicit recovery
  fallback and never put authority in it.
- A deep link carries an opaque, short-lived, single-use flow handle or an ordinary route. It never
  carries a session token, provider code, RPC stub, prompt, connected-account capability, or headers.
- OAuth provider redirect URIs remain the existing HTTPS gatekeeper callbacks. The gatekeeper/backend
  completes provider exchange server-side, then returns the browser to the app through a Workshop
  link. This avoids registering native Google OAuth clients and preserves server-held secrets.
- Native runtime logic lives behind a narrow frontend adapter; platform checks are not scattered
  through components.
- Browser WebSocket remains first choice; use a native WebSocket plugin only after a failing physical-
  device proof with a documented reason.

### Blocking values required before implementation Story S1

1. Product display name.
2. macOS and iOS bundle identifier(s), Android application ID, and whether macOS shares the iOS bundle
   namespace.
3. Apple Team ID and accounts/roles for Developer ID, App Store Connect, and associated domains.
4. Android signing identity, Play Console application ownership, and SHA-256 certificate fingerprints
   for development/internal/production App Links.
5. Canonical production HTTPS origin and controlled dev/staging origins.
6. Exact minimum OS versions after checking the pinned Tauri core/plugins; “latest two majors” alone
   is not a reproducible build setting.
7. Privacy/support URLs, store ownership, and legal entity.
8. Biometric policy: lock on every cold launch, every foreground after timeout, or only after an
   explicit user toggle; fallback behavior when biometrics are unavailable/changed/locked out.
9. Whether direct macOS updates use Tauri updater, manual download, or mandatory web prompt; signing
   keys and rollback policy follow from this.

### Decisions that can wait until the feasibility evidence exists

- Browser vs Tauri WebSocket implementation.
- Stronghold vs native Keychain/Keystore package-owned abstraction.
- Exact mobile automation framework and screenshot service.
- Whether Monaco needs platform-specific performance tuning; feature parity means it cannot simply be
  removed.

## 6. Architecture decision record

### ADR-1: Bundled frontend with explicit remote service origins

Create `packages/workshop-native/` as the Tauri release shell. It owns `src-tauri`, icons, platform
configuration, capabilities, entitlements, generated Xcode/Gradle projects, signing templates, and
native CI commands. It consumes `packages/workshop-frontend/dist` rather than creating a second UI.

Add a frontend `WorkshopRuntime` abstraction with at least:

```ts
interface WorkshopRuntime {
  kind: 'web' | 'tauri'
  apiOrigin: URL
  publicWebOrigin: URL
  openExternal(url: URL): Promise<void>
  subscribeDeepLinks(handler: (url: URL) => void): Promise<() => void>
  readSessionSecret(): Promise<string | null>
  writeSessionSecret(value: string): Promise<void>
  clearSessionSecret(): Promise<void>
  saveFile(input: NativeSaveRequest): Promise<'saved' | 'cancelled'>
  share(input: NativeShareRequest): Promise<void>
  lockSession(): Promise<void>
  unlockSession(reason: UnlockReason): Promise<UnlockResult>
}
```

The concrete interface may be smaller after inventory, but URLs, secret storage, external navigation,
deep-link ingress, files/share, and lock state must each have one owner. `publicWebOrigin` creates
shareable links; `apiOrigin` creates HTTPS/WSS service URLs; neither comes from the native WebView.

Reject remote-web-wrapper and hybrid delivery because they weaken release immutability, store review,
CSP/navigation control, offline startup, and reproducibility.

### ADR-2: Server-completed OAuth with durable opaque flow handles

Do not send Google/provider authorization codes to Tauri. Preserve the existing gatekeeper HTTPS
callback and server-side token exchange. Introduce one generic native-capable flow contract shared by
login, connect, reconnect, and resource-grant initiation:

1. Client asks RPC to begin a flow and declares a validated return mode, not an arbitrary URL.
2. Backend creates a random opaque flow handle, stores bounded state/result durably with expiry and
   single-consumption semantics, and associates authenticated connector flows with the initiating user.
3. Web keeps its existing direct provider URL behavior. Native receives a one-time launch URL on the
   branded Workshop origin, not an arbitrary provider URL. The Workshop consumes that launch ticket
   and redirects in the system browser to the server-validated provider destination. This trampoline
   preserves MCP's existing endpoint/redirect/SSRF checks while allowing dynamically discovered OAuth
   authorization servers; the native opener never needs a wildcard provider-host permission.
4. Provider redirects to the existing public HTTPS gatekeeper callback.
5. Gatekeeper completes server-side and emits a common success/failure page that attempts a verified
   Workshop return URL and always offers an accessible “Return to app” button plus web fallback.
6. Tauri receives the HTTPS link on cold or warm start, validates exact scheme/host/path, strips and
   avoids logging fragments, then asks the backend for status. Login status returns a session exactly
   once; authenticated flows verify the initiating user before disclosing status.
7. The app reconciles subscriptions and fresh account state. Duplicate/expired/wrong-user callbacks
   are harmless.

The generic return-page/flow mechanism must be reused by gatekeepers rather than introducing a second
bespoke callback protocol in every connector. Provider-specific code should only complete OAuth and
report success/failure through the existing callback capability.

This deliberately changes the current “client never receives an ID” shape. The replacement handle is
random, short-lived, narrowly scoped, durable, rate-limited, and conveys no authority without the
flow-specific consume rules. A security review must approve its exact API before shared/kernel edits.

### ADR-3: Verified-link router with route allowlist

Serve association documents at:

- `/.well-known/apple-app-site-association`
- `/.well-known/assetlinks.json`

The router owns immutable generated data derived from approved identifiers/signing fingerprints. Do
not use a broad wildcard until tested exclusions are encoded. Native route parsing must implement this concrete top-level matrix:

- **Claim and route:** OAuth return paths (opaque handle only); `/workspace/*`; `/blueprint/*`; share
  URLs/fragments; `/gatekeepers/*`; `/admin`; `/sessions/*`; and every other path represented in the
  generated SPA route tree, including `/`.
- **Never claim as app navigation:** `/api` and `/api/*`; `/blueprint-screenshot/*`;
  `/gatekeeper/*/oauth` and every provider callback/initiation path; `/.well-known/*`; static build
  assets; and the native OAuth launch trampoline.
- **Reject before routing:** malformed encodings, credentials in URL authority, non-HTTPS production
  links, foreign hosts, unknown paths, and oversize inputs.

Share bearer fragments are retained only in memory/session restoration as existing code requires and
are never persisted to logs or native analytics. `/admin` is app-linkable to satisfy full route parity,
but existing server authorization remains the only authority.

Cold and warm links go through the same pure parser and route dispatcher. Web fallback remains the
existing SPA. Custom schemes may only invoke the same parser and must not broaden accepted content.

### ADR-4: Default-deny native capability boundary

Use Tauri v2 capabilities per window/platform. The top-level trusted Workshop window gets only the
minimum commands needed. OAuth initiation may open only the branded one-time launch trampoline from
ADR-2; dynamic MCP authorization hosts are followed only after the server applies its existing
endpoint, redirect, and SSRF checks. Ordinary user-selected external links use a separate narrowly
validated `http(s)` opener path and can never masquerade as an OAuth launch. File permissions use
user-selected paths/tokens, never broad filesystem roots.

No gadget or gatekeeper `srcDoc` frame receives Tauri globals, command permissions, opener access,
filesystem access, secret access, or biometric access. Add an executable security test proving this
on each WebView engine.

### ADR-5: Secure secret release and biometric lock

Build a `SessionSecretStore` owned by the native shell. A feasibility/security story must choose:

- an encrypted Tauri Stronghold vault whose wrapping key is protected by platform facilities; or
- a maintained, audited native Keychain/Keystore plugin; or
- a minimal package-owned Swift/Kotlin/macOS implementation if neither meets lifecycle and biometric
  requirements.

Never use Tauri Store or browser storage for session secrets. Non-secret UI state may use Store or web
storage. Biometric success releases the session to the trusted frontend process; background timeout,
logout, biometric enrollment changes, and OS lock clear in-memory access. Recovery must not strand a
valid account without an approved fallback/re-login path. Before backgrounding or locking, replace
sensitive UI with an opaque privacy cover so iOS snapshots, Android recents, and the macOS app switcher
cannot capture workspace, chat, terminal, share, or connector content. Decide and test the policy for
OS screenshots and screen recording; do not request broad screen-capture detection privileges without
an approved requirement.

### Compatibility and migration

- “Keep the web deployment unchanged” means preserve web-visible behavior, URLs, authentication,
  popup UX, and compatibility; it does not prohibit additive router association files, a native-only
  launch trampoline, or additive RPC methods needed by installed clients.
- Web builds keep current browser runtime semantics.
- Existing web `localStorage` sessions are not imported into native apps.
- Native upgrades migrate only versioned native-secret records, transactionally; failure logs out
  safely.
- API changes are additive until all shipped clients age out. Durable flow records have explicit
  schema/version/TTL and cleanup.
- App/backend compatibility is negotiated through `ServerConfig` or a dedicated public compatibility
  result so old binaries receive an actionable upgrade screen rather than undefined RPC failures.

## 7. Story DAG

### S0 — Approve identifiers, threat model, and release policy

- **Inputs:** blocking values in section 5, selected product decisions.
- **Outputs:** signed ADR addendum containing IDs/origins/OS floors, biometric policy, link path matrix,
  privacy owner, update policy, and test device matrix.
- **Dependencies:** none.
- **Likely files:** this plan or follow-up ADR; no runtime code.
- **Verification:** product, security, and release-owner sign-off.
- **Parallel:** no; it gates association files, native projects, signing, and storage design.

### S1 — Tauri feasibility and plugin spike

- **Inputs:** S0 identifiers; pinned Tauri v2/core CLI/plugin candidates.
- **Outputs:** `packages/workshop-native` shell that bundles the existing Vite output and launches on
  macOS, one physical iPhone, and one physical Android device; evidence for `srcDoc`, WebSocket, Monaco,
  terminal, file picker, opener, deep link, Stronghold/keychain, and biometric support.
- **Dependencies:** S0.
- **Likely files:** new native package, `pnpm-lock.yaml`, root/Vite+ configuration, frontend Vite dev-host
  configuration.
- **Verification:** build and run three platforms; record exact WebView origins/user agents and plugin
  versions; prove trusted top window has minimal command access and child frames have none.
- **Parallel:** platform probes can run in parallel after one owner lands the scaffold; one writer owns
  shared package/config files.

### S2 — Runtime/origin adapter and URL inventory

- **Inputs:** S1 origin evidence and branded origins.
- **Outputs:** web-compatible runtime abstraction; all service/public-link/external-navigation call
  sites migrated; no production native URL derives from WebView origin.
- **Dependencies:** S1.
- **Likely files:** `workshop-frontend/src/main.tsx`, auth/connect components, sharing/blueprint routes,
  error reporting, logo/screenshot fetches, terminal/session code, file transfers, tests.
- **Verification:** repository check for unreviewed relative backend fetches and `window.location.origin`
  link construction; unit tests for web/native URL resolution; existing frontend suite.
- **Parallel:** inventory/tests can run beside S3 design, but one frontend writer owns adapter migration.

### S3 — Durable resumable flow API and common return page

- **Inputs:** S0 threat model and ADR-2.
- **Outputs:** reviewed shared RPC types; durable login/connector flow state machine with TTL,
  user-binding, single consume, cancellation, duplicate safety, and bounded cleanup; generic browser
  return page/redirect contract reusable by all gatekeepers.
- **Dependencies:** S0; may design during S1/S2 but lands after security review.
- **Likely files:** `workshop-shared/src/api.ts` and gatekeeper types, backend auth/login flow/server/user,
  router, a minimal shared gatekeeper helper or existing common mechanism, focused tests.
- **Verification:** state-machine tests for every terminal/expiry/race case; no token/code in URL or
  logs; capability and user-binding review; kernel diff kept minimal and separately reviewable.
- **Parallel:** not safe to split shared API/backend state ownership; gatekeeper conformance follows.

### S3a — Verified OAuth-link ingress foundation

- **Inputs:** S0 identifiers/path matrix, S1 native shell evidence, S2 runtime adapter, and S3 OAuth
  return path contract.
- **Outputs:** production-shaped `apple-app-site-association` and `assetlinks.json`; iOS associated-domain
  entitlement; Android intent filters/signing fingerprints; narrowly scoped OAuth-return parser; cold
  (`getCurrent`) and warm (`onOpenUrl`) dispatch into a test status screen; installed/not-installed web
  fallback. This story claims only the OAuth-return path so authentication can be proven before broad
  route association.
- **Dependencies:** S0, S1, S2, S3.
- **Likely files:** router association assets/config, Tauri platform configs/capabilities, frontend
  runtime/deep-link parser and tests.
- **Verification:** hosted association-file validators; signed physical-device links from Mail/Messages/
  browser; exact host/path rejection; cold/warm/duplicate/expired inputs; provider callback, API, static,
  trampoline, and foreign paths never open the app.
- **Parallel:** hosted-file generation and pure parser tests can run in parallel; signing/platform
  integration is serialized under one owner.

### S4 — Native auth coordinator and secret storage

- **Inputs:** S1 plugin verdict, S2 runtime adapter, S3 flow API, and S3a verified-link ingress.
- **Outputs:** system-browser launch, cold/warm callback handling, Google login consume, native secret
  storage, biometric lock/unlock, logout, relaunch/resume reconciliation, and non-secret UI state.
- **Dependencies:** S1, S2, S3, S3a.
- **Likely files:** native Rust/plugins/capabilities and frontend auth/runtime modules.
- **Verification:** physical-device matrix for success, cancel, process kill, duplicate link, expired
  link, offline callback, changed biometrics, lockout, logout, wrong account, and reinstall. Inspect
  storage/logs/backups for leaked secrets; verify privacy cover before every OS background/app-switcher
  snapshot and on biometric relock.
- **Parallel:** platform storage implementations can be parallel after a single interface/test contract;
  auth coordinator integration is serialized.

### S5 — Connector OAuth conformance

- **Inputs:** S3 common flow/return mechanism and S4 coordinator.
- **Outputs:** a checked-in connector conformance table covering every current package named in section
  3.1 and classifying login/connect/reconnect/incremental-grant/native-return behavior; every applicable
  interactive flow returns to app and reconciles; auto-provisioned flows remain browser-free; provider
  callback URI registrations remain valid.
- **Dependencies:** S3, S4.
- **Likely files:** common gatekeeper flow helper plus only connector-specific changes that cannot be
  centralized; frontend connector call sites; connector tests/docs.
- **Verification:** catalog-based conformance suite plus real staging flows for Google and each enabled
  OAuth provider. Include fixed-provider OAuth, Email/Home Assistant/Team PI custom flows, ODIE KG,
  dynamic MCP/MCP Portal discovery, auto-provisioned no-browser behavior, deny/cancel/partial grant/
  expired credential, and a test that fails when a new gatekeeper package lacks a table row.
- **Parallel:** provider validation can fan out by non-overlapping gatekeeper package after common
  contract lands; shared helper has one owner.

### S6 — Expand verified links to the full SPA route matrix

- **Inputs:** S0 approved route matrix, S2 adapter, S3a verified OAuth ingress, and S4 coordinator.
- **Outputs:** association documents/entitlements/manifest filters expanded from the narrow OAuth path
  to every SPA route in ADR-3 (including `/admin`), pure route dispatch, web fallback, and Android
  back/history integration while every non-SPA exclusion remains unclaimed.
- **Dependencies:** S0, S2, S3a, S4.
- **Likely files:** router assets/config, Tauri platform configs, frontend router/runtime tests.
- **Verification:** hosted-file validators; physical devices; installed/not-installed fallback; links
  from Messages/Mail/browser; malformed/foreign/admin/API paths; share fragment secrecy; multiple app
  windows/instances on macOS.
- **Parallel:** hosted files and pure parser tests can proceed in parallel from the approved matrix;
  final platform integration is serialized.

### S7 — Native platform essentials and parity closure

- **Inputs:** S1 compatibility evidence and S2 adapters.
- **Outputs:** native file open/save/share and clipboard, safe-area/keyboard behavior, touch/hover
  parity, dialogs, Monaco, terminal keys and reconnect, gadget/gatekeeper iframe parity, lifecycle and
  network recovery, accessible offline/reconnect shell, and store manifests with no camera or
  notification permission/entitlement.
- **Dependencies:** S1, S2; terminal auth may depend on S4.
- **Likely files:** frontend UI/runtime modules, scoped native plugins/capabilities, platform config,
  tests.
- **Verification:** feature inventory mapping every web route/workflow to macOS/iPhone/iPad/Android
  phone/tablet evidence; uploads/downloads at supported limits; gadget and gatekeeper sandbox tests;
  accessibility and orientation tests; automated manifest/entitlement assertions prove camera and
  notification access are absent.
- **Parallel:** non-overlapping files/platform tests may fan out; shared adapters and global layouts have
  one writer.

### S8 — Native error reporting and observability

- **Inputs:** S2 explicit API origin and S4 identity lifecycle.
- **Outputs:** bounded native-aware report transport, platform/build metadata, same no-secrets policy,
  explicit origin/rate-limit behavior, symbol/source-map handling, and operational dashboards.
- **Dependencies:** S2, S4.
- **Likely files:** frontend reporting, backend client-errors, native crash bridge/config, tests.
- **Verification:** accepted/rejected origin tests, opt-out/no-binding behavior, redaction tests, symbol
  upload rehearsal, and proof that raw URLs/fragments/tokens never enter reports.
- **Parallel:** can proceed beside S7 after transport contract review.

### S9 — Signing, CI, stores, and updates

- **Inputs:** S0 identities/accounts/policies; stable S1 package.
- **Outputs:** Developer ID signing/notarization and direct macOS artifact/update path; iOS certificates,
  profiles, privacy manifest, TestFlight/App Store pipeline; Android keystore/Play App Signing/AAB,
  privacy/data-safety declarations, and internal track; version mapping and backend compatibility gate.
- **Dependencies:** S0, S1; final release waits for S3-S8.
- **Likely files:** GitHub workflows, native configs/entitlements/manifests, release scripts/docs; secrets
  remain outside git.
- **Verification:** clean-runner signed artifacts, notarization verification, TestFlight install, Play
  internal install, upgrade/downgrade/rollback drill, SBOM/license review, reproducible checksums where
  platform signing permits.
- **Parallel:** three platform release lanes can run in parallel with separate secret ownership; shared
  versioning/release manifest is serialized.

### S10 — Release candidate and parity gate

- **Inputs:** S3-S9 complete.
- **Outputs:** release candidate, support/runbooks, store submissions, approved residual-risk list.
- **Dependencies:** all prior stories.
- **Likely files:** tests, docs, release metadata; only release-blocking fixes.
- **Verification:** full matrix below, independent security review, product acceptance, and rollback
  rehearsal.
- **Parallel:** test lanes parallelize by platform; release decision is serialized.

## 8. Execution schedule

1. **Gate:** S0.
2. **Feasibility:** S1; do not commit to store dates until it passes on physical iOS/Android and macOS.
3. **Foundation parallel lanes:** S2 runtime inventory, S3 state-machine/API design, and early S9 account/
   signing setup. Shared contracts each retain one owner.
4. **Serialized integration:** land reviewed S3, then S3a narrow verified-link ingress, then S4 auth/
   storage. Authentication cannot claim completion against a custom scheme or simulated callback.
5. **Parallel hardening:** S5 provider conformance, S6 broad SPA route ingress, S7 parity, S8
   observability, and the three S9 release lanes.
6. **Convergence:** S10 only after all narrow gates pass.

Recommended commit/PR boundaries:

- PR 1: Tauri scaffold and feasibility evidence only.
- PR 2: frontend runtime/origin abstraction, web-compatible.
- PR 3: shared API + backend durable flow kernel change.
- PR 4: common gatekeeper return mechanism and connector conformance.
- PR 5: native auth/secret/biometric integration.
- PR 6+: links, platform UX, observability, and per-platform release infrastructure by concern.

## 9. Risk register

| Risk | Severity | Mitigation / gate |
|---|---:|---|
| Tauri mobile/plugin behavior cannot support full iframe/Monaco/terminal parity | Critical | S1 physical-device spike; stop and revisit framework decision if hard blocker is proven |
| OAuth succeeds while app process and RPC waiter are gone | Critical | Durable, expiring, single-consume S3 state machine; cold-start tests |
| Deep link leaks token/share capability or links wrong user | Critical | Opaque handles, authenticated consume, exact parser, no logging, duplicate/wrong-user tests |
| Native bridge reaches gadget or gatekeeper iframe | Critical | Default-deny capabilities, no remote permissions, executable child-frame denial tests |
| Session secret exposed in localStorage/backups/logs | Critical | Native vault/keychain gate, biometric release, storage inspection, redaction tests |
| Google rejects embedded login | Critical | System browser only; provider callback remains HTTPS/server-side |
| Broad Universal Links hijack API/provider-callback/static paths | High | Concrete ADR-3 matrix; S3a starts narrow and S6 expands only to generated SPA routes |
| `tauri://` origin breaks RPC, reporting, files, previews, or assets | High | S2 exhaustive runtime URL inventory and physical-origin evidence |
| Biometric plugin lacks macOS support | High | S1 macOS proof; narrowly scoped custom implementation or explicit product decision, never silent omission |
| Cloudflare Access deployment fails cross-origin | High | Explicitly excluded from launch; detect and show unsupported deployment error |
| Store policy rejects remote-code/native capability combination | High | Bundled immutable UI, child-frame isolation, privacy/plugin review, reviewer notes |
| Provider-specific callback pages require large gatekeeper churn | High | One shared return-page/state contract; provider conformance after central mechanism |
| Web regression from runtime abstraction | High | Browser adapter is default; existing suite plus web E2E required on every native PR |
| Mobile background disconnect loses capability state | High | Treat suspension as disconnect; restore by IDs and fresh RPC capabilities, never serialize stubs |
| Direct macOS updater and mobile stores drift versions | Medium | One version manifest/compatibility policy; channel-specific delivery only |
| “Latest two majors” changes under the project | Medium | Freeze exact deployment floors per release and revisit intentionally |
| Signing secrets leak or builds are irreproducible | High | CI secret stores, least privilege, no committed keystores/profiles, clean-runner rehearsal |

## 10. Verification matrix

| Area | Narrow verification | Final gate |
|---|---|---|
| Build | pnpm/Vite+ task tests; Rust format/clippy/test; platform config validation | Clean macOS/iOS/Android builds from tagged commit |
| Web compatibility | runtime adapter unit tests; existing frontend/backend/gatekeeper tests | `pnpm lint`, `pnpm test`, `pnpm build`; web E2E Google login and connector connect/reconnect/grant, popup cancel, self-close, and fallback behavior |
| RPC/network | URL construction; WebSocket reconnect; lifecycle tests | Wi-Fi/cellular/airplane, long background, process kill on physical devices |
| Google login | state-machine and parser tests | Real Google staging login: warm/cold/cancel/deny/duplicate/expired/offline |
| Connectors | generic conformance harness | Real enabled-provider connect/reconnect/grant matrix |
| Secrets/biometric | vault migration, logout, timeout, fallback tests | Device inspection; enrollment change/lockout/reinstall/backup tests |
| Deep links | pure parser allow/deny corpus | Verified HTTPS links installed/not installed, all route classes, three platforms |
| Shares | fragment retention and no-log tests | Open real bearer share from external app without server/referrer/report leakage |
| Frames | capability policy tests | Gadget and gatekeeper frame cannot invoke any Tauri command on every WebView engine |
| Files/clipboard/share | adapter unit tests and cancellation/error cases | Real upload/export/open/share at limits on phones/tablet/macOS |
| UX/parity | route/workflow checklist, keyboard/back/safe-area tests | Small/large phone, tablet, desktop; portrait/landscape; accessibility pass |
| Reporting | origin, bounds, redaction, opt-in tests | Staging event symbolication with no token/prompt/header/body/raw-link data |
| Distribution | signing config lint and dry runs | notarized macOS install/update; TestFlight; Play internal; rollback drill |

## 11. Review gates

1. **Framework feasibility gate (after S1):** architecture, frontend, security, and mobile owners approve
   physical-device evidence. Failure reopens Tauri vs Capacitor/native alternatives.
2. **Kernel/API gate (before S3 lands):** independent backend and security reviewers approve durable
   flow authority, TTL, consume semantics, logging, and minimal shared API diff.
3. **Native boundary gate (before S4/S7):** security reviewer approves capabilities, opener scopes,
   navigation policy, iframe denial evidence, storage, and biometric fallback.
4. **Deep-link gates:** before S3a, security/product reviewers approve the narrow OAuth return and
   association/signing identity; before S6, they approve every claimed SPA route, every non-SPA
   exclusion, `/admin` behavior, and share-fragment handling.
5. **Provider gate (before release):** enabled connector inventory has evidence; no “works like Google”
   assumption substitutes for a tested provider flow.
6. **Store/release gate (S10):** release engineering, privacy/legal, accessibility, security, and product
   approve artifacts, disclosures, support/runbooks, compatibility, and rollback.

## 12. Recommended first execution command

After supplying and approving the S0 blocking values, begin with:

`/tyr Execute Story S1 from plans/tauri-native.md only: create the bounded Tauri v2 feasibility shell and produce physical-device evidence; do not begin production auth, shared API, or gatekeeper changes.`

## 14. Implementation progress (2026-08-27)

Review repair update: local readiness now also fixes the production Google OAuth base URL, uses the mobile-safe native identifier `com.totango.odieos`, restores a restrictive Tauri CSP, narrows platform app-link declarations away from root/API/provider/static/trampoline paths, rejects native OAuth/connect/reconnect/grant flows until the durable verified-link return path is implemented, permits only validated in-memory workspace share fragments in the deep-link parser, moves the native browser-flow unit test under the backend Vitest include, and routes native saves through a user-selected save dialog instead of ambient Downloads/Documents writes.

Completed local code/config/test stories that do not require private credentials, signing identities, store accounts, or devices:

- Added `packages/workshop-native` as the Tauri v2 owner with `productName: "Odie OS"`, package name `@gadgets/odie-os-native`, mobile-safe identifier `com.totango.odieos`, bundled frontend dist wiring, default-deny top-level-window capabilities, associated-domain entitlement placeholder, narrowed Android App Link manifest proof, Rust command surface, and native config tests.
- Added a frontend `WorkshopRuntime` owner with web and Tauri implementations for `apiOrigin`, `publicWebOrigin`, external opening, deep-link subscription, session-secret read/write/clear, file save, and lock/unlock commands. Tauri production defaults use `https://odie-os.odie-os.workers.dev`; web behavior still derives from the existing browser/dev origin unless `VITE_ODIE_*` overrides are set.
- Moved frontend backend URL construction, error-report transport, generated public blueprint/workspace/share URLs, file export paths, OAuth connect/reconnect opener call sites, dev auto-login, login, and logout through the runtime adapter where locally safe.
- Added pure verified-link parsing tests for the approved claim/exclude matrix, rejecting `/api`, `/gatekeeper/*`, `/.well-known/*`, `/native/oauth-start/*`, credentials-in-authority, fragments on native OAuth returns, malformed encoded handles, non-HTTPS links, foreign origins, and non-share fragments while retaining validated `/workspace/:id#share=...` fragments in memory.
- Added router support and tests for Odie association-document endpoints. The documents intentionally do not claim an app until Apple Team ID and Android signing fingerprints are supplied.
- Added additive shared browser-flow API types and explicit backend guard methods for native flow consumption/status. The fully durable `NativeOAuthFlow` Durable Object is not wired yet; `native-browser-flow.ts` currently contains a tested record/TTL state helper only.
- Added Odie production config for Google gatekeeper binding, Google-only auth vars, and removal of Cloudflare Access vars from Odie backend production config. Added `packages/gatekeeper-google/wrangler.odie-os-production.jsonc`.
- Updated the default deployment display name fallback from `Cloudflare OS` to `Odie OS` and adjusted affected frontend tests.

Known deliberate deviations / remaining gates:

- No Apple Team ID, Developer ID certificate, provisioning profile, notarization key, Android keystore/upload key, Play/App Store account value, OAuth client secret, or signing fingerprint was invented.
- Native session storage is represented by a package-owned `SessionSecretStore` command abstraction and in-memory local shell implementation. Production Keychain/Keystore/Stronghold selection, biometric release, enrollment-change behavior, background privacy cover, and physical-device proof remain required before release.
- Durable native OAuth is only shaped at the API/type/helper level. Native login/connect/reconnect/grant entry points are intentionally disabled/rejected until the migration, Durable Object binding/export, one-time launch trampoline, gatekeeper return helper migration, and user-bound single-consume flow status are implemented.
- Association documents are valid JSON but intentionally empty until Apple Team ID and Android signing SHA-256 fingerprints are available; app-link verification must be completed on physical iOS/Android devices.
- The local Tauri build now bundles a macOS `.app` only. DMG/notarized artifacts require signing/notarization credentials and CI secret setup.

## 15. Follow-up progress after verifier REVISE

Additional local software completed after verifier feedback:

- Removed accidental generated build outputs from the shared worktree (`packages/gatekeeper-*/dist-app` and `packages/workshop-native/src-tauri/target`) and kept native `target/` ignored.
- Fixed the native browser-flow lint/type issue by replacing the narrow helper with a versioned `NativeBrowserFlow` Durable Object state machine: durable initialization, TTL alarm expiry, one-time launch consumption, verifier-bound login consumption, user-bound authenticated-flow status, constant-time verifier comparison, and token clearing after consume/expiry.
- Added the `NativeBrowserFlow` migration to backend wrangler configs and exported the DO from the backend worker.
- Implemented additive native login RPC behavior while preserving web popup behavior: `startGatekeeperLogin(vendor)` still returns `{ url, attempt }` for web; `startGatekeeperLogin(vendor, { flow: { returnMode: "native-verified-link", clientVerifierHash } })` creates a durable native flow and returns a branded `/native/oauth-start/<handle>` launch URL plus opaque handle/expiry. `consumeNativeLoginFlow(handle, verifier)` single-consumes the completed login token.
- Added backend `/native/oauth-start/<ticket>` as a branded one-time launch trampoline routed through the backend by the router. The native app link parser continues to exclude this path.
- Added `AuthenticatedApi.getNativeAccountFlowStatus(flowHandle, clientVerifier)` plumbing to the durable flow for user-bound status checks. Native connect/reconnect/grant initiation still needs ticket creation/wiring; MCP OAuth discovery/SSRF code was not changed.
- Extended gatekeeper connect options with an optional `returnUrl` and added `renderBrowserFlowCompletionHtml()` in shared gatekeeper code. Google now stores the optional native return URL and renders an Odie OS completion page that attempts verified-link return while preserving web self-close behavior when no return URL is supplied.
- Updated router worker-first config/tests so `/native/oauth-start/*` reaches the backend and is not swallowed by assets.

Verification notes:

- `pnpm --filter @gadgets/workshop-frontend test:run` passed (48 files, 289 tests).
- `pnpm --filter @gadgets/router test:run` passed (1 file, 13 tests).
- `pnpm --filter @gadgets/typed-storage build && pnpm --filter @gadgets/workshop-backend test:run` passed (37 backend unit files with 448 tests; integration 1 file with 5 passed / 4 skipped). The backend tests log expected access-denied uncaught exceptions from existing tests.
- `pnpm lint:check` passed with pre-existing warnings only.
- `pnpm build` passed.
- `cargo test --manifest-path packages/workshop-native/src-tauri/Cargo.toml` passed (8 tests). `cargo fmt --check` and `cargo clippy -- -D warnings` emitted success/no-issue output before a combined command timed out; rerunning the test-only command completed successfully.
- A full `pnpm --filter @gadgets/odie-os-native tauri build --debug` was intentionally not retried after parent steering: previous attempt showed frontend build and Rust compilation progress but exceeded the bounded tool timeout while compiling/bundling. Earlier local readiness had produced an unsigned `.app`; signing/DMG/notarization remain credential-gated.

Exact remaining software/technical blockers:

- Native connector `connectAccount` / `ensureAccountResources` / `reconnectAccount` still need durable flow creation, branded launch URLs, callback bridging, and status completion for all connector flows. The status method and DO state machine are present, but initiation is still web-URL based for these flows.
- Google native login is implemented at the backend/RPC/return-page level, but full browser round-trip cannot be proven without deployed Google OAuth credentials and verified app links.
- The official Tauri biometric plugin supports iOS/Android only; it does not provide macOS Touch ID. Production-suitable cross-platform biometric lock therefore requires either a custom macOS native command or an approved macOS exception. Current local native storage is an in-memory command abstraction and is not production-suitable for session secrets.
- Association documents remain valid placeholders until Apple Team ID and Android signing SHA-256 fingerprints are supplied.

## 16. Security review repair pass

Final-review findings repaired locally:

1. Native Google login no longer relies on a reload/localStorage handoff. The frontend stores the verifier/flow handle in the runtime secret store, a global native-login coordinator consumes cold/warm verified links, writes the session token through the runtime, dispatches an in-process token event, and `useAuth` authenticates root state immediately from that event.
2. `NativeBrowserFlow` now treats both pending and completed flows as TTL-bound. Alarm/status/consume paths mark expired records and clear `loginToken`, so an unconsumed completed native login token does not live indefinitely.
3. Pending native login state is represented as `workshop.pendingNativeLoginFlow` in the runtime secret store. Native OAuth startup writes it before opening the system browser; cold/warm deep-link consumption validates the exact handle, consumes with the verifier, writes the session token, and clears pending flow state.
4. Tauri no longer grants `opener:allow-open-url`. The frontend calls package-owned commands: `open_oauth_trampoline` accepts only `https://odie-os.odie-os.workers.dev/native/oauth-start/*`; `open_external_link` rejects trampoline paths, credentials, non-HTTPS/non-mailto URLs, and file URLs. The opener plugin's automatic JS link opening is disabled.
5. Google OAuth completion/error responses now include `Referrer-Policy: no-referrer`; the Google provider redirect and backend branded trampoline redirect also set `Referrer-Policy: no-referrer`.
6. New exported shared browser-flow API members and updated auth token docs now have doc comments describing web-popup vs native verified-link behavior, opaque handles, expiry, and runtime-specific token storage.

Regression coverage added/updated:

- Frontend `nativeLoginCoordinator.test.ts` covers cold-start matching-link consumption, session write, pending-flow clear, and rejection of foreign/mismatched links.
- Backend `native-browser-flow.test.ts` covers completed-flow TTL expiry so completed login tokens are bounded.
- Native Rust tests cover narrow OAuth trampoline validation, ordinary external-link rejection of trampoline/file URLs, and removal of unscoped opener capability.
- Existing frontend deep-link tests continue to reject foreign hosts, credentials, excluded prefixes, and fragments.

Remaining technical blockers after this repair:

- Native connector connect/reconnect/grant flow initiation remains incomplete; login is wired, and the durable DO/status primitives exist, but connector creation/callback bridging has not yet been generalized without broadening this repair pass.
- Production-suitable biometric release remains blocked by current supported Tauri APIs: `tauri-plugin-biometric` supports iOS/Android but not macOS Touch ID. A macOS-specific native command or an approved macOS exception is still required. The checked-in local secret store is still an abstraction/in-memory development backend and must be replaced by a selected Keychain/Keystore/Stronghold-backed implementation before release.
- End-to-end Google native login requires deployed Google OAuth secrets and verified iOS/Android app-link association values; those remain external credential/device gates.

## 17. Final high-finding repair pass

Additional repairs completed:

- Replaced the native one-slot in-memory command store with a keyed persistent command store. The session token key (`workshop.sessionToken`) and pending native-login key (`workshop.pendingNativeLoginFlow`) are independent; clearing pending flow state no longer clears the signed-in session. Host tests reopen the store file to prove process-death-style persistence for the session key after pending-flow clear.
- Added `tauri-plugin-stronghold` to the native shell as the current supported Tauri encrypted-vault solution for production hardening. The checked command facade is keyed and durable in host tests; final production migration still needs the Stronghold password policy / biometric release decision below.
- Updated native-login coordinator to accept a current RPC stub getter instead of capturing the startup stub, so warm/cold deep-link consumption uses the replacement RPC connection after reconnects.
- Updated native-login coordinator failure handling: pending verifier/handle is retained on transient RPC/network failures and cleared only after successful consume or errors classified as terminal server outcomes (expired, already consumed, verifier mismatch, failed, different user).
- Added frontend regression tests for current-stub consumption after reconnect, warm-link subscription, transient RPC failure retention, terminal-outcome clearing, and foreign/mismatched deep-link rejection.
- Added native command-layer regression coverage for keyed persistence: pending write -> session write -> pending clear preserves session, including after reopening the durable store.

Verification notes:

- `pnpm --filter @gadgets/workshop-frontend test:run` passed (49 files, 294 tests).
- `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/native-browser-flow.test.ts` passed (3 tests).
- `pnpm lint:check` passed with pre-existing warnings only.
- `pnpm build` passed.
- `cargo fmt --check --manifest-path packages/workshop-native/src-tauri/Cargo.toml` and `cargo clippy --manifest-path packages/workshop-native/src-tauri/Cargo.toml -- -D warnings` passed.
- `cargo test --manifest-path packages/workshop-native/src-tauri/Cargo.toml --lib -- --nocapture` passed (4 tests) and `cargo test --manifest-path packages/workshop-native/src-tauri/Cargo.toml --test native_config -- --nocapture` passed (6 tests). A broad all-target cargo test command exceeded the bounded timeout after clippy; split focused test commands completed successfully.

Remaining technical/security gate:

- Production secret hardening must finish the Stronghold password/unlock policy. Current supported Tauri Stronghold requires a password/key to load the snapshot; deriving or storing that key without user/biometric/platform-keychain input would weaken the design. The local command store is durable and keyed for process-death recovery tests, but a release build must bind it to Stronghold with a user/biometric-backed unlock policy (or a separately approved platform keychain/keystore implementation) before shipping.

## 18. Native Stronghold storage repair pass

Additional local repairs completed for this pass:

- Moved the Tauri frontend runtime off plaintext native secret commands. `packages/workshop-frontend/src/runtime/tauriRuntime.ts` now opens a Stronghold snapshot under `appDataDir()/odie-os.stronghold`, uses the `odie-os` Stronghold client, stores only the session token (`workshop.sessionToken`) and pending native login flow (`workshop.pendingNativeLoginFlow`) records, and obtains the Stronghold unlock password through the package-owned native command `release_stronghold_unlock_key`.
- Disabled the previous plaintext production command path in `packages/workshop-native/src-tauri/src/lib.rs`: `read_session_secret`, `write_session_secret`, and `clear_session_secret` now validate the two allowlisted keys and fail closed instead of reading or writing a JSON command store.
- Added a fail-closed native unlock-key facade. Production builds have no plaintext fallback. Debug builds only allow a random persistent development key when `ODIE_DEV_NATIVE_SECRET_FALLBACK=true` is explicitly set; otherwise the unlock command returns an error.
- Replaced frontend terminal-error regex classification for native login consumption with typed `NativeLoginConsumeResult` statuses. The backend durable object now returns exact consume statuses (`completed`, `pending`, `expired`, `consumed`, `verifier-mismatch`, `failed`) so transient fetch/WebSocket exceptions continue to preserve pending state while terminal server outcomes clear it.
- Added focused coverage: frontend Stronghold storage test proves session token and pending verifier are independent Stronghold records; native-login coordinator tests exercise typed terminal outcomes; Rust tests cover fail-closed storage, key allowlisting, and opener/file validation.

Verification notes for this pass:

- `pnpm --filter @gadgets/workshop-frontend exec tsc --noEmit` passed.
- `pnpm --filter @gadgets/workshop-frontend test:run` passed (50 files, 295 tests).
- `pnpm --filter @gadgets/workshop-backend exec tsc --noEmit` passed.
- `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/native-browser-flow.test.ts` passed (1 file, 3 tests).
- `pnpm --filter @gadgets/router test:run` passed (1 file, 13 tests).
- `cargo fmt --check --manifest-path packages/workshop-native/src-tauri/Cargo.toml`, `cargo clippy --manifest-path packages/workshop-native/src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path packages/workshop-native/src-tauri/Cargo.toml --lib -- --nocapture` (4 tests), and `cargo test --manifest-path packages/workshop-native/src-tauri/Cargo.toml --test native_config -- --nocapture` (6 tests) passed.
- `pnpm lint:check` passed with pre-existing warnings only.
- `pnpm build` passed; generated build outputs were removed again afterward.

Remaining blocker / release gate:

- The checked-in native unlock command intentionally fails closed on production platform builds until the Apple Keychain/LocalAuthentication and Android Keystore/BiometricPrompt release implementations are added and validated on physical devices. This is safer than a plaintext or hardcoded fallback, but it means production native sign-in storage is not fully usable yet.

## 19. Keyring-backed Stronghold unlock repair pass

Additional repairs completed:

- Added maintained `tauri-plugin-keyring-store` `0.2.x` as the Rust-side OS vault owner for the random Stronghold unlock key, registered with service `com.totango.odieos.stronghold-unlock`. No keyring-store JS permission is granted in `capabilities/default.json`; JS can only request `release_stronghold_unlock_key`, and Rust owns vault access.
- Kept session token and pending native-login verifier storage inside the Tauri Stronghold snapshot. The OS keyring stores only the random Stronghold unlock key account (`workshop.strongholdUnlockKey`) on supported mobile production builds after successful authentication.
- Added official `tauri-plugin-biometric` for iOS/Android builds only. Mobile unlock now requires successful biometric/device-credential authentication before reading or creating the keyring unlock key. If authentication/status fails, the Stronghold unlock command fails closed.
- Kept macOS production fail-closed pending a narrowly scoped LocalAuthentication-gated Login Keychain release implementation and physical signed validation. No plaintext production macOS fallback was added.
- Removed the obsolete plaintext JSON/session command store path. Legacy secret commands now validate the two allowed record names and return errors; the explicit debug-only `ODIE_DEV_NATIVE_SECRET_FALLBACK=true` path remains the only non-keyring fallback for local development.
- Structured native login consume statuses continue to control pending cleanup; message-regex terminal detection is not used.

Verification notes:

- `cargo fmt --manifest-path packages/workshop-native/src-tauri/Cargo.toml` passed.
- `cargo clippy --manifest-path packages/workshop-native/src-tauri/Cargo.toml -- -D warnings` passed.
- `cargo test --manifest-path packages/workshop-native/src-tauri/Cargo.toml --lib -- --nocapture` passed (5 tests).
- `cargo test --manifest-path packages/workshop-native/src-tauri/Cargo.toml --test native_config -- --nocapture` passed (6 tests).
- `pnpm --filter @gadgets/workshop-frontend test:run` passed (50 files, 295 tests).
- `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/native-browser-flow.test.ts` passed (1 file, 3 tests).
- `pnpm --filter @gadgets/router test:run` passed (1 file, 13 tests).
- `pnpm lint:check` passed with pre-existing warnings only.
- `pnpm build` passed with existing large-chunk/deprecation warnings.

Remaining release gate:

- macOS Stronghold unlock remains intentionally unavailable until a LocalAuthentication implementation can gate Login Keychain release and be validated with signing/entitlements on physical macOS hardware. iOS/Android keyring+biometric code compiles by target configuration but still needs physical-device validation with generated projects and signing assets.

## 20. High-finding repair pass: Rust-owned Stronghold, global coordinator, macOS unlock

Additional repairs completed:

- Moved native session-token and pending-login-verifier Stronghold access behind package-owned Rust commands (`read_session_secret`, `write_session_secret`, `clear_session_secret`). The frontend no longer imports `@tauri-apps/plugin-stronghold`, the dependency was removed from `packages/workshop-frontend/package.json`/lockfile, the Tauri Stronghold plugin is no longer registered as a JS-accessible plugin, and no Stronghold/keyring JS capability is granted.
- Kept the OS keyring scoped to Rust only. `tauri-plugin-keyring-store` remains registered with service `com.totango.odieos.stronghold-unlock`; the keyring stores only the random Stronghold unlock key, while session token and pending verifier records stay in Stronghold.
- Removed button-local deep-link consumption from `OAuthButtons`. Native login startup now writes the pending verifier/handle and opens the branded trampoline; warm/cold callback consumption is handled only by the global native-login coordinator using the current RPC stub and token event. The button path no longer clears pending state on thrown transient errors.
- Implemented macOS production unlock gating with Login Keychain + LocalAuthentication. macOS now uses `apple-localauthentication` 0.3.5 to evaluate `LAPolicy::DeviceOwnerAuthentication` before reading/creating the Stronghold unlock key in the Login Keychain through `tauri-plugin-keyring-store`. Debug fallback remains explicit via `ODIE_DEV_NATIVE_SECRET_FALLBACK=true`.
- Kept iOS/Android device authentication with the official biometric plugin and keyring-store OS vault. All OS-vault release paths fail closed if authentication is unavailable or denied.

Verification notes:

- `cargo fmt --manifest-path packages/workshop-native/src-tauri/Cargo.toml` passed.
- `cargo clippy --manifest-path packages/workshop-native/src-tauri/Cargo.toml -- -D warnings` passed.
- `cargo test --manifest-path packages/workshop-native/src-tauri/Cargo.toml --lib -- --nocapture` passed (4 tests).
- `cargo test --manifest-path packages/workshop-native/src-tauri/Cargo.toml --test native_config -- --nocapture` passed (6 tests).
- `pnpm --filter @gadgets/odie-os-native tauri build --debug` passed and produced a local unsigned macOS debug `.app` before cleanup.
- `pnpm --filter @gadgets/workshop-frontend test:run` passed (50 files, 295 tests).
- `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/native-browser-flow.test.ts` passed (1 file, 3 tests).
- `pnpm --filter @gadgets/router test:run` passed (1 file, 13 tests).
- `pnpm lint:check` passed with pre-existing warnings only.
- `pnpm build` passed with existing large-chunk/deprecation warnings.

Remaining release gates:

- The macOS LocalAuthentication/Login Keychain path is compile-checked by the macOS debug Tauri build, but still requires signed/notarized physical-hardware validation for final release behavior and enrollment/lockout cases.
- iOS/Android biometric/keyring paths remain target-configured and require physical device validation with signing assets.

## 21. High-finding repair pass: no unlock-key IPC and ObjC LocalAuthentication

Additional repairs completed:

- Moved `random_key_hex()` out of debug-only cfg so production iOS/Android/macOS OS-vault key creation compiles without relying on a debug symbol.
- Removed `release_stronghold_unlock_key` from the Tauri invoke handler and renderer IPC surface entirely. Renderer code now calls only the narrow Rust-owned `read_session_secret`, `write_session_secret`, `clear_session_secret`, `unlock_session`, opener, and file commands; Stronghold opening and OS-vault unlock-key release remain in Rust.
- Replaced `apple-localauthentication` with `objc2-local-authentication` plus `block2`/`objc2-foundation` bindings for macOS LocalAuthentication. The macOS unlock path creates and retains an `LAContext`, preflights `LAPolicy::DeviceOwnerAuthentication`, invokes `evaluatePolicy:localizedReason:reply:`, bridges the callback through a bounded channel timeout, and only then reads/creates the random Stronghold unlock key in Login Keychain through keyring-store.
- Kept the button-local deep-link consume subscription removed; global current-stub coordinator and structured native-flow result statuses remain the only pending cleanup path.
- Extended native config tests to assert no Stronghold/keyring JS permissions are granted.

Verification notes:

- `cargo fmt --check --manifest-path packages/workshop-native/src-tauri/Cargo.toml` passed.
- `cargo clippy --manifest-path packages/workshop-native/src-tauri/Cargo.toml -- -D warnings` passed.
- `cargo test --manifest-path packages/workshop-native/src-tauri/Cargo.toml --lib -- --nocapture` passed (4 tests).
- `cargo test --manifest-path packages/workshop-native/src-tauri/Cargo.toml --test native_config -- --nocapture` passed (6 tests).
- `cargo check --release --manifest-path packages/workshop-native/src-tauri/Cargo.toml` passed.
- `pnpm --filter @gadgets/odie-os-native tauri build --debug` passed and produced a local unsigned macOS debug `.app` before cleanup.
- `pnpm --filter @gadgets/workshop-frontend test:run` passed (50 files, 295 tests).
- `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/native-browser-flow.test.ts` passed (1 file, 3 tests).
- `pnpm --filter @gadgets/router test:run` passed (1 file, 13 tests).
- `pnpm lint:check` passed with pre-existing warnings only.
- `pnpm build` passed with existing large-chunk/deprecation warnings.

Remaining release gates:

- macOS LocalAuthentication/Login Keychain is compile-checked and debug-build checked, but still needs signed physical-hardware validation for prompt UX, timeout/cancel behavior, lockout, and biometric enrollment changes.
- iOS/Android biometric/keyring paths remain target-configured and require physical-device validation with signing assets.
