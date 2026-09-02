# Install Odie OS

## iPhone and iPad with TestFlight

Requirements: iOS or iPadOS 15 or later, the free TestFlight app, and an Apple ID invited to the Odie external testing group.

1. Install [TestFlight](https://apps.apple.com/app/testflight/id899247664) from the App Store.
2. Open the Odie OS invitation email on the device where TestFlight is installed.
3. Select **View in TestFlight** and sign in with the Apple ID that received the invitation.
4. Select **Accept**, then **Install** next to Odie OS.
5. Open Odie OS from TestFlight or the Home Screen and sign in normally.

TestFlight notifies testers when Apple approves a new external build. Select **Update** in TestFlight, or enable **Automatic Updates** from the Odie OS TestFlight page.

If the invitation says it was already redeemed, confirm TestFlight is using the invited Apple ID. Ask the Odie administrator for a new invitation if the original invitation was associated with another Apple ID.

## macOS disk image

Requirements: macOS 15 or later.

1. Download [OdieOS-latest.dmg](https://odie-os-native-api.odie-os.workers.dev/downloads/mac/OdieOS-latest.dmg).
2. Open the downloaded disk image.
3. Drag **Odie OS** into the **Applications** folder shown in the disk image.
4. If Finder asks, select **Replace** to update an existing installation.
5. Eject the Odie OS disk image, then open **Odie OS** from Applications.

The application is Developer ID signed and notarized. For an optional integrity check, download [the published SHA-256 checksum](https://odie-os-native-api.odie-os.workers.dev/downloads/mac/OdieOS-latest.dmg.sha256) and run:

```sh
shasum -a 256 ~/Downloads/OdieOS-latest.dmg
```

When Odie OS shows an **Update available** card, select it to download the latest disk image. Quit Odie OS before replacing the copy in Applications; account data and sign-in credentials remain in the system-protected application storage.

## Publish a macOS release

After signing, notarizing, and stapling the disk image, validate it and prepare the public artifacts:

```sh
xcrun stapler validate /path/to/OdieOS.dmg
spctl --assess --type open --context context:primary-signature --verbose /path/to/OdieOS.dmg
pnpm --filter @gadgets/odie-os-native macos:prepare-release /path/to/OdieOS.dmg /tmp/odie-macos-release
```

Upload the disk image and checksum first. Upload the metadata last so clients never see a new version before its installer is available:

```sh
pnpm exec wrangler r2 object put odie-os-native-downloads/mac/OdieOS-latest.dmg --file /tmp/odie-macos-release/OdieOS-latest.dmg --content-type application/x-apple-diskimage
pnpm exec wrangler r2 object put odie-os-native-downloads/mac/OdieOS-latest.dmg.sha256 --file /tmp/odie-macos-release/OdieOS-latest.dmg.sha256 --content-type text/plain
pnpm exec wrangler r2 object put odie-os-native-downloads/mac/OdieOS-latest.json --file /tmp/odie-macos-release/OdieOS-latest.json --content-type application/json
```

Verify all three public URLs after upload. Increment the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` before every release; the preparation script rejects mismatched versions.
