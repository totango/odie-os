# Install TARS

## iPhone and iPad ad hoc pilot (Firebase App Distribution)

This pilot is for registered iPhones and iPads, without App Store upload or App Review. Open the
Firebase invitation on the device in Safari, sign in with Google, and follow its instructions to
register the device and install TARS. If Firebase says the device is not yet included in the
build, wait for the release operator to add its UDID to the Apple ad hoc profile and redistribute.
Keep the installed app when updating; install the newer build from the Firebase tester page.

The release operator must first:

1. The [TARS Firebase project](https://console.firebase.google.com/project/tars-8d9af/appdistribution)
   has separate iOS and Android app registrations and the `odie-internal` tester group. Add the
   pilot testers to that group. Firebase App Distribution does not require adding a Firebase SDK
   or GoogleService-Info.plist to this app.
2. Register at least one pilot device with Apple. Create an **Ad Hoc** provisioning profile for
   `com.totango.odieos` named exactly **Odie OS Ad Hoc** using the existing Apple Distribution
   certificate. Include the app's Associated Domains entitlement and all currently known devices.
3. Set these in the protected GitHub `native-release` environment:

   | Name | Type | Value |
   | --- | --- | --- |
   | `APPLE_DISTRIBUTION_CERTIFICATE_BASE64` | secret | Base64 `.p12` Apple Distribution certificate (shared with the App Store workflow). |
   | `APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD` | secret | Password for that certificate. |
   | `APPLE_IOS_AD_HOC_PROFILE_BASE64` | secret | Base64 **Ad Hoc** `.mobileprovision`, not the App Store profile. |
   | `NATIVE_RELEASE_KEYCHAIN_PASSWORD` | secret | Temporary CI keychain password. |
   | `FIREBASE_IOS_APP_ID` | variable | Firebase *app ID* for the iOS app, not the bundle ID. |
   | `FIREBASE_TESTER_GROUP` | variable | Alias of the invited internal tester group. |
   | `GOOGLE_WORKLOAD_IDENTITY_PROVIDER` | variable | TARS GitHub OIDC provider resource name. |
   | `GOOGLE_RELEASE_SERVICE_ACCOUNT` | variable | TARS release service account with the Firebase App Distribution Admin role. |

   Google Cloud accepts only GitHub OIDC tokens for `totango/odie-os`, `main`, and the protected
   `native-release` environment. Firebase uploads use short-lived credentials; no Google private
   key is stored in GitHub.

4. Run **Distribute TARS iOS ad hoc pilot** (`.github/workflows/release-ios-ad-hoc.yml`) from `main`
   with a positive `build_number`. The job archives, exports, verifies the embedded Ad Hoc profile,
   and uploads the signed IPA to Firebase; it fails if any step fails. For new code, use a new build
   number. To add devices to an unchanged build, Firebase permits redistributing the same version
   and build number with an updated profile.
5. For additional testers, use Firebase's **Export Apple UDIDs**, register those devices in the
   Apple developer account, regenerate **Odie OS Ad Hoc**, update the profile secret and rerun the
   workflow. Invitation alone cannot install an IPA on a device omitted from its embedded profile.
   [Firebase device-registration guide](https://firebase.google.com/docs/app-distribution/register-additional-devices).

Start with one registered phone, confirm install, sign-in, verified links, and an update over the
existing installation before inviting the remaining devices. Apple's ad hoc limit is 100 registered
devices per product family per membership year. Firebase retains a release for 150 days, so keep
the source and signing assets for rebuilding future releases.

## Android internal build (Firebase App Distribution)

The Android app uses package `com.totango.odieos` and the same Firebase tester group. Run
**Distribute TARS Android internal build** (`.github/workflows/release-android-firebase.yml`) from
`main` with a positive `version_code` higher than the last distributed APK. The job builds an
ARM64 release APK, checks its package/version and pinned signing certificate, and uploads it to
Firebase. Open the Firebase invitation on the Android device to install; Android does not require
Apple device registration. If Android asks, allow installation of apps from the Firebase tester
experience. Keep the existing installation when updating, since it is signed with the same key.

The protected GitHub `native-release` environment holds the Android signing secrets
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, and `ANDROID_KEY_PASSWORD`, plus variables
`ANDROID_KEY_ALIAS`, `FIREBASE_ANDROID_APP_ID`, `FIREBASE_TESTER_GROUP`,
`GOOGLE_WORKLOAD_IDENTITY_PROVIDER`, and `GOOGLE_RELEASE_SERVICE_ACCOUNT`. The release keystore
backup is on the release operator's Mac at `~/.config/odie-os/android-release/odie-os-release.jks`,
with its password in macOS Keychain under `odie-os-android-release-keystore`. Back it up securely:
losing this key prevents updates to existing Android installations. Its public SHA-256 fingerprint
is pinned in the release workflow and the native gateway's Android App Links association document.
After deploying the native gateway, verify
`https://odie-os-native-api.odie-os.workers.dev/.well-known/assetlinks.json` matches the APK's
signing certificate. macOS continues to use the notarized DMG and Cloudflare R2 download below.

## iPhone and iPad with TestFlight

Requirements: iOS or iPadOS 15 or later, the free TestFlight app, and an Apple ID invited to the Odie external testing group.

1. Install [TestFlight](https://apps.apple.com/app/testflight/id899247664) from the App Store.
2. Open the TARS invitation email on the device where TestFlight is installed.
3. Select **View in TestFlight** and sign in with the Apple ID that received the invitation.
4. Select **Accept**, then **Install** next to TARS.
5. Open TARS from TestFlight or the Home Screen and sign in normally.

Existing TestFlight builds may still be listed as Odie OS until a TARS build is uploaded. TestFlight
notifies testers when Apple approves a new external build. Select **Update** in TestFlight, or
enable **Automatic Updates** from the app's TestFlight page.

If the invitation says it was already redeemed, confirm TestFlight is using the invited Apple ID. Ask the Odie administrator for a new invitation if the original invitation was associated with another Apple ID.

## macOS disk image

Requirements: macOS 15 or later.

1. Download [OdieOS-latest.dmg](https://odie-os-native-api.odie-os.workers.dev/downloads/mac/OdieOS-latest.dmg).
2. Open the downloaded disk image.
3. Drag **TARS** into the **Applications** folder shown in the disk image.
4. If you previously installed **Odie OS**, remove its old application after confirming TARS opens
   and signs in; the application name changed, but its bundle identifier and protected data remain.
5. Eject the disk image, then open **TARS** from Applications.

The application is Developer ID signed and notarized. For an optional integrity check, download [the published SHA-256 checksum](https://odie-os-native-api.odie-os.workers.dev/downloads/mac/OdieOS-latest.dmg.sha256) and run:

```sh
shasum -a 256 ~/Downloads/OdieOS-latest.dmg
```

When TARS shows an **Update available** card, select it to download the latest disk image. Quit
TARS before replacing the copy in Applications; account data and sign-in credentials remain in
the system-protected application storage. The installer filename and download URL retain the
`OdieOS` prefix for compatibility with existing update clients.

## Publish native releases

The App Store/macOS path is the manual GitHub Actions workflow **Release native apps**
(`.github/workflows/release-native.yml`). Run it only from `main`; the workflow refuses other refs
and uses the protected `native-release` environment before any signing or publishing step.

Workflow inputs:

- `platform`: `both`, `macos`, or `ios`. `both` starts independent macOS and iOS jobs.
- `build_number`: required for iOS and ignored for macOS. Enter a positive integer greater than the
  latest build already uploaded for the current marketing version; the workflow does not guess from
  its own run counter.

Required GitHub environment secrets and variables:

| Name | Type | Used by | Notes |
| --- | --- | --- | --- |
| `APPLE_DEVELOPER_ID_CERTIFICATE_BASE64` | secret | macOS | Base64 `.p12` Developer ID Application certificate. |
| `APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD` | secret | macOS | Password for the Developer ID `.p12`. |
| `APPLE_DISTRIBUTION_CERTIFICATE_BASE64` | secret | iOS | Base64 `.p12` Apple Distribution certificate. |
| `APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD` | secret | iOS | Password for the distribution `.p12`. |
| `APPLE_IOS_PROVISIONING_PROFILE_BASE64` | secret | iOS | Base64 App Store provisioning profile for `com.totango.odieos`. |
| `NATIVE_RELEASE_KEYCHAIN_PASSWORD` | secret | both | Temporary CI keychain password. |
| `APP_STORE_CONNECT_API_KEY_P8_BASE64` | secret | both | Base64 App Store Connect API private key. |
| `APP_STORE_CONNECT_API_KEY_ID` | secret | both | App Store Connect API key id. |
| `APP_STORE_CONNECT_API_ISSUER_ID` | secret | both | App Store Connect issuer id. |
| `CLOUDFLARE_API_TOKEN` | secret | macOS | Token with R2 object write access. |
| `CLOUDFLARE_ACCOUNT_ID` | variable | macOS | Cloudflare account that owns `odie-os-native-downloads`. |

Version and build-number rules:

- The marketing version comes from `packages/workshop-native/package.json` and must match
  `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`; the macOS preparation script rejects
  mismatches. Do not type a version into the workflow.
- Increment the marketing version before a release that should be visible as a new application
  version.
- Every iOS upload for a given marketing version needs a unique, increasing build number in App
  Store Connect. Look up the latest uploaded build and explicitly supply a larger `build_number` for
  every iOS workflow run.

iOS App Store upload:

- App Store Connect must already contain the app with bundle id `com.totango.odieos`.
- The workflow signs, validates, and uploads the IPA. It deliberately does not select a build,
  submit an App Store version for review, or release it; those are separate production decisions in
  App Store Connect.
- After upload processing completes, select the build on the matching App Store version and complete
  its description, screenshots, support and privacy URLs, age rating, privacy answers, export
  compliance, availability, and review information.

### First unlisted iOS release

Unlisted distribution is the production channel for the internal iOS app. The app is absent from
App Store search and listings, but anyone who obtains its link can download it. Odie authentication
and authorization remain the access boundary; never treat possession of the App Store link as proof
that a user is an employee.

1. Upload the current iOS build with **Release native apps**.
2. Create or select its App Store version in App Store Connect, attach the processed build, choose
   public distribution in **Pricing and Availability**, and use manual release so approval cannot
   make the app searchable before Apple processes the unlisted request.
3. In **App Review Information**, provide Apple a persistent review account that can exercise the
   core app using synthetic data. Store those credentials only in App Store Connect, not this
   repository, GitHub Actions, release notes, or logs.
4. State in **Review Notes** that the app is an internal employee resource intended for unlisted
   distribution, explain the sign-in steps, and submit the version for App Review.
5. Submit Apple's [unlisted app distribution request](https://developer.apple.com/contact/request/unlisted-app/).
   Apple requires the app to be submitted for App Review and declines beta or prerelease builds.
6. After Apple approves the request and app version, add the generated private App Store URL to the
   **Apps** section in `packages/workshop-frontend/src/SettingsPage.tsx`.

Future versions use the same unlisted listing and link: upload a new unique build, attach it to the
new App Store version, update metadata, and submit it for review. Team members install and update
through the ordinary App Store without App Store Connect or TestFlight access.

Rollback semantics:

- macOS metadata is uploaded last. If a macOS release must be rolled back, re-upload the previous
  versioned DMG if necessary and then restore `OdieOS-latest.json` to point clients back at it. The
  router resolves the latest DMG and checksum from this single metadata pointer, so mutable release
  objects cannot diverge.
- App Store releases cannot be replaced in place. If an iOS release is defective, remove it from
  sale if necessary and submit a corrected version with a higher marketing version and build number.

### Break-glass macOS publishing

After signing, notarizing, and stapling the disk image, prepare the public artifacts. The script validates the staple, Developer ID signature, bundle identifier, and embedded version before writing metadata:

```sh
pnpm --filter @gadgets/odie-os-native macos:prepare-release /path/to/OdieOS.dmg /tmp/odie-macos-release
```

Upload the immutable, content-addressed disk image first. Upload the metadata pointer last so clients never see a new version before its installer is available:

```sh
VERSIONED_DMG="$(node -p "require('/tmp/odie-macos-release/OdieOS-latest.json').url.split('/').pop()")"
pnpm exec wrangler r2 object put "odie-os-native-downloads/mac/$VERSIONED_DMG" --remote --file "/tmp/odie-macos-release/$VERSIONED_DMG" --content-type application/x-apple-diskimage
pnpm exec wrangler r2 object put odie-os-native-downloads/mac/OdieOS-latest.json --remote --file /tmp/odie-macos-release/OdieOS-latest.json --content-type application/json
```

The router derives the latest DMG and checksum responses from the validated metadata and immutable
versioned object. Verify all four public URLs after upload: the latest DMG, versioned DMG, checksum,
and metadata. Increment the version in `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json` before every release; the preparation script rejects mismatched versions.
