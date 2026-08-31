# Capacitor mobile application plan

*Status: superseded by `plans/tauri-native.md`. Retained as historical prior art; do not execute this
Capacitor plan.*

## 1. Goal

Ship the existing Workshop as an iOS and Android application using Capacitor while retaining the
React/Vite frontend and Cloudflare-hosted backend. The mobile application is initially an agent
control surface, not a complete phone-based IDE.

Primary mobile workflows:

- Chat with agents and use gadgets.
- Review and approve connected-service actions.
- Create, monitor, stop, and archive coding sessions.
- Read terminal output and perform limited terminal interaction.
- Manage connectors and developer setup.
- Open shared workspaces and blueprints from links.
- Receive notifications in a later phase.

Full Monaco-based editing and intensive terminal use are tablet-oriented follow-ups, not launch
requirements.

## 2. Fixed decisions

1. Use Capacitor 8 for iOS and Android. Do not add Tauri or a desktop application.
2. Keep `packages/workshop-frontend` as the single UI implementation.
3. Bundle the compiled frontend into each native application. Do not load the live Workshop site
   as remote executable UI.
4. Keep all authoritative data, authentication, agents, gadgets, coding sessions, credentials, and
   approval state in the existing Cloudflare services.
5. Do not add a native backend or move gatekeeper credentials into the application.
6. Use the system browser for OAuth and verified Universal Links/App Links for callbacks when
   possible. A custom URI scheme is acceptable only for early internal prototypes.
7. Deep links carry opaque flow identifiers only. They must never contain tokens, RPC stubs,
   connected-account capabilities, prompts, or other sensitive state.
8. Continue supporting the web application from the same frontend codebase.
9. Treat mobile suspension as a normal WebSocket disconnect and restore state through existing RPC
   APIs after resume.
10. Use native secure storage for production authentication tokens. `localStorage` is acceptable
    only for a time-boxed feasibility prototype.

## 3. Proposed structure

Create a separate package for native release concerns:

```text
packages/workshop-frontend/       # Existing shared React/Vite application
packages/workshop-mobile/
  package.json
  capacitor.config.ts
  ios/
  android/
```

`workshop-mobile` builds `workshop-frontend`, points Capacitor's `webDir` at its `dist`, and runs
`cap sync`. Keep generated native projects committed so signing settings, entitlements, manifests,
privacy declarations, and native fixes are reviewable.

Initial dependencies:

- `@capacitor/core`
- `@capacitor/cli`
- `@capacitor/ios`
- `@capacitor/android`
- `@capacitor/app`
- `@capacitor/browser`
- `@capacitor/network`

Add plugins such as secure storage, Share, Clipboard, Filesystem, Keyboard, Splash Screen, and Push
Notifications only when a concrete workflow needs them.

## 4. Shared runtime abstraction

The packaged application does not share an origin with the backend. Replace direct assumptions
about `window.location` with one web-compatible runtime adapter:

```ts
interface WorkshopRuntime {
  apiOrigin: string;
  publicWebOrigin: string;
  isNative: boolean;
  openExternal(url: string): Promise<void>;
  onDeepLink(handler: (url: URL) => void): Promise<() => void>;
}
```

Responsibilities:

- `apiOrigin`: canonical HTTPS origin used for Cap'n Web RPC, terminal attachments, site assets,
  screenshots, and client error reporting.
- `publicWebOrigin`: canonical origin used when generating share, workspace, and blueprint links.
- `openExternal`: `window.open` on web and Capacitor Browser on native.
- `onDeepLink`: no-op/browser routing on web and `@capacitor/app` URL events on native.

Update at least these areas:

- `packages/workshop-frontend/src/main.tsx`: build the `/api` WebSocket from `apiOrigin`, not the
  WebView origin.
- OAuth/connect/reconnect call sites currently using `window.open()`.
- Share and blueprint links currently using `window.location.origin`.
- Client error reporting, site logo, screenshots, downloads, and other relative backend requests.
- `SessionTerminal`: resolve attachment URLs against `apiOrigin` and reacquire expired tickets.

Expose the deployment's canonical public origin through `ServerConfig`; do not hard-code one
customer deployment into the mobile binary. Define how the app chooses a deployment before
production work starts: fixed branded deployment, managed environment selection, or an approved
user-entered URL.

## 5. Authentication and deep links

Native connector flow:

1. The authenticated RPC API returns an OAuth initiation URL and opaque flow identifier.
2. Open the URL in the system browser through Capacitor Browser.
3. The existing gatekeeper completes OAuth on its HTTPS callback.
4. The callback redirects to a verified mobile link such as
   `https://<deployment>/open/oauth/<opaque-id>`.
5. iOS/Android opens the application and `@capacitor/app` emits `appUrlOpen`.
6. The application validates the origin/path, closes the browser if appropriate, and asks the
   backend for flow status over authenticated RPC.
7. Existing connected-account subscriptions and a fresh account query reconcile the UI.

Backend changes may be required so pending OAuth/login flows survive application suspension and do
not depend on one continuously open RPC/WebSocket execution context.

Host these association documents from the public router:

- `/.well-known/apple-app-site-association`
- `/.well-known/assetlinks.json`

Restrict them to the production bundle/application IDs and signing identities. Test cold-start and
already-running deep links on physical iOS and Android devices.

## 6. Networking and lifecycle

Use the browser WebSocket implementation first; add a native WebSocket plugin only if device tests
show a concrete incompatibility.

On pause/background:

- Expect Cap'n Web and terminal sockets to close.
- Do not keep authority alive through background hacks.
- Persist only ordinary navigation/UI state needed to restore the screen.

On resume/foreground or network change:

- Reconnect Cap'n Web using the existing backoff/recovery path.
- Reauthenticate from secure storage.
- Refresh connected accounts, coding-session activity, and current route data.
- Mint a fresh single-use terminal attachment capability rather than reusing an expired one.

Add explicit tests for Wi-Fi/cellular changes, airplane mode, long suspension, process termination,
and returning from OAuth after the OS killed the application.

## 7. Security requirements

- Keep all service credentials and connected-account capabilities outside the native application.
- Store production session credentials in iOS Keychain and Android Keystore through a maintained
  secure-storage plugin. Clear native and web storage on logout.
- Never place authentication tokens in query strings, custom schemes, logs, analytics, crash
  reports, or notification payloads.
- Validate every deep-link scheme, host, path, and opaque identifier before navigation.
- Add the exact Capacitor WebView origin to the terminal attachment origin allowlist; do not disable
  origin validation. Confirm actual origins on both platforms before configuration is finalized.
- Retain short-lived, single-use terminal capabilities and all existing owner/repository checks.
- Apply a restrictive WebView navigation policy: the app may load bundled assets and connect only
  to the selected Workshop deployment; external pages open in the system browser.
- Do not expose gadget/user-authored content to native plugin bridges. Gadget iframes retain their
  existing sandbox boundary.
- Keep frontend error reports free of tokens, prompts, headers, request bodies, and deep-link data.
- Review every native plugin and permission individually; no broad filesystem, camera, location,
  contacts, or background permissions without a shipped feature requiring it.

## 8. Mobile UX scope

Required launch work:

- Respect iOS and Android safe-area insets.
- Handle virtual keyboard resize and focus without hiding chat input or approval controls.
- Implement Android back-button behavior through TanStack Router history.
- Replace hover-only affordances with touch-accessible controls.
- Ensure dialogs, sheets, configurator frames, and connector flows fit phone viewports.
- Provide explicit terminal keys for Control, Escape, Tab, arrows, and paste when terminal input is
  enabled.
- Define graceful mobile behavior for Monaco: read-only/diff-first on phones is acceptable.
- Use native Share for external workspace/blueprint links where available.
- Test gadget frames and file upload/download behavior inside both WebViews.

Prefer a tablet-enhanced layout for editing and terminal work. Do not block the initial release on
full phone IDE parity.

## 9. Delivery phases

### Phase 0: product and deployment decisions

- Choose initial iOS bundle ID, Android application ID, display name, and supported deployment(s).
- Decide whether launch supports one fixed deployment or deployment selection.
- Decide launch feature scope for phone versus tablet.
- Enroll/confirm Apple Developer and Google Play accounts and ownership of signing credentials.

Exit criterion: identifiers, deployment selection, and launch workflows are approved.

### Phase 1: feasibility shell (3-5 engineering days)

- Add `workshop-mobile` and initialize Capacitor iOS/Android projects.
- Bundle the existing Vite assets.
- Add the runtime adapter and connect Cap'n Web to a development deployment.
- Verify password login, navigation, chat read/write, session listing, and gadget rendering.
- Test one physical iPhone and one physical Android device.

Exit criterion: both platforms reliably launch, authenticate, reconnect, and use one end-to-end
agent workflow.

### Phase 2: production authentication and lifecycle (1-2 weeks)

- Implement system-browser OAuth and resumable backend flow status.
- Add Universal Links/App Links and association endpoints.
- Add secure token storage and migration/logout behavior.
- Add pause/resume/network recovery.
- Add trusted native origins for terminal attachments and verify one real session terminal.

Exit criterion: login/connect/reconnect and terminal attachment work after cold start, suspension,
and process termination without leaking credentials.

### Phase 3: mobile UX (2-4 weeks)

- Adapt navigation, dialogs, approvals, configurators, chat, and coding sessions for touch.
- Implement keyboard, safe-area, back-button, share, clipboard, and file behavior.
- Define and implement phone/tablet Monaco and terminal behavior.
- Add accessibility and device-matrix testing.

Exit criterion: all launch workflows pass on representative small phone, large phone, and tablet
viewports on both platforms.

### Phase 4: distribution (2-3 weeks)

- Configure iOS signing, entitlements, privacy manifest, TestFlight, and App Store metadata.
- Configure Android keystore, target SDK, Play App Signing, internal testing, and store metadata.
- Add CI jobs for reproducible signed builds without exposing signing secrets.
- Add native crash/error reporting integration consistent with the existing bounded frontend path.
- Define release versioning, rollback, backend compatibility, and mandatory-update policy.

Exit criterion: signed builds are distributed through TestFlight and Play internal testing, with a
documented repeatable release process.

## 10. Testing and acceptance

Keep existing web tests and builds mandatory. Add:

- Unit tests for runtime URL construction and platform adapter behavior.
- Tests proving generated share links use `publicWebOrigin`, never the WebView origin.
- Tests for deep-link allowlisting and opaque flow parsing.
- Tests for secure-storage migration and logout clearing.
- Native smoke tests for cold launch, login, reconnect, OAuth, chat, approvals, session listing,
  terminal attachment, and gadget use.
- Physical-device tests for background/resume and network transitions.
- iOS and Android accessibility checks and phone/tablet screenshot regression coverage.

Release acceptance requires:

- No credentials in native logs, deep links, analytics, or crash reports.
- No unrestricted native bridge exposed to gadget or gatekeeper UI frames.
- Web behavior remains unchanged.
- Existing repository lint, type checks, builds, and tests pass.
- Signed native artifacts can be reproduced by CI from a tagged commit.

## 11. Deferred follow-ups

- Push notifications and notification-driven deep links.
- Background task execution; agents and coding sessions remain server-side meanwhile.
- Biometric unlock for locally stored sessions.
- Offline read caches or draft queues.
- Full phone Monaco editing.
- Advanced terminal keyboard/accessory bar.
- Multiple simultaneous Workshop deployments/accounts.
- Managed live web-asset updates. Native releases initially ship immutable bundled frontend assets.

## 12. Estimate

Expected production effort is approximately five to eight engineering weeks for one experienced
engineer, dominated by OAuth/deep-link lifecycle behavior, mobile UI adaptation, physical-device
testing, signing, and store release work. The feasibility phase should be completed before making a
store-launch commitment.
