use serde_json::Value;
use std::{fs, path::Path};

fn read(path: &str) -> String {
    fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap()
}

#[test]
fn capabilities_are_default_deny_for_main_window_only() {
    let capabilities = read("capabilities/default.json");
    assert!(capabilities.contains("\"windows\": [\"main\"]"));
    assert!(capabilities.contains("\"local\": true"));
    assert!(!capabilities.contains("\"remote\""));
    assert!(!capabilities.contains("opener:allow-open-url"));
    assert!(!capabilities.to_ascii_lowercase().contains("stronghold"));
    assert!(!capabilities.to_ascii_lowercase().contains("keyring"));
    assert!(!capabilities.contains("camera"));
    assert!(!capabilities.contains("notification"));
}

#[test]
fn platform_manifests_do_not_request_camera_or_notifications() {
    let android = read("gen/android/app/src/main/AndroidManifest.xml");
    let entitlements = read("Entitlements.plist");
    for manifest in [android, entitlements] {
        let lower = manifest.to_ascii_lowercase();
        assert!(!lower.contains("camera"));
        assert!(!lower.contains("notification"));
    }
}

#[test]
fn verified_link_domain_is_declared() {
    assert!(read("Entitlements.plist").contains("applinks:odie-os.odie-os.workers.dev"));
    let android = read("gen/android/app/src/main/AndroidManifest.xml");
    assert!(android.contains("android:scheme=\"https\""));
    assert!(android.contains("android:host=\"odie-os.odie-os.workers.dev\""));
}

#[test]
fn native_identifier_is_mobile_safe() {
    let config: Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
    let identifier = config["identifier"].as_str().unwrap();
    assert_eq!(identifier, "com.totango.odieos");
    assert!(identifier.split('.').all(|segment| !segment.is_empty()
        && segment
            .chars()
            .all(|ch| ch == '_' || ch.is_ascii_alphanumeric())));
}

#[test]
fn csp_is_restrictive_and_disallows_remote_scripts() {
    let config: Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
    let csp = config["app"]["security"]["csp"].as_str().unwrap();
    assert!(csp.contains("default-src 'self'"));
    assert!(csp.contains("script-src 'self'"));
    assert!(csp.contains(
        "connect-src 'self' https://odie-os.odie-os.workers.dev wss://odie-os.odie-os.workers.dev"
    ));
    assert!(csp.contains("object-src 'none'"));
    assert!(!csp.contains("script-src 'self' https://"));
}

#[test]
fn verified_links_do_not_claim_excluded_prefixes() {
    let config: Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
    let mobile = &config["plugins"]["deep-link"]["mobile"][0];
    let paths = mobile["path"].as_array().unwrap();
    let prefixes = mobile["pathPrefix"].as_array().unwrap();
    let claimed = paths
        .iter()
        .chain(prefixes.iter())
        .map(|value| value.as_str().unwrap())
        .collect::<Vec<_>>();
    for excluded in [
        "/",
        "/api",
        "/api/",
        "/gatekeeper/",
        "/.well-known/",
        "/assets/",
        "/native/oauth-start/",
    ] {
        assert!(
            !claimed.contains(&excluded),
            "claimed excluded path {excluded}"
        );
        assert!(
            !claimed
                .iter()
                .any(|path| excluded.starts_with(path) && *path == "/"),
            "root claim would include {excluded}"
        );
    }

    let android = read("gen/android/app/src/main/AndroidManifest.xml");
    assert!(!android.contains("android:pathPrefix=\"/\""));
    assert!(!android.contains("android:path=\"/\""));
    for excluded in [
        "/api",
        "/gatekeeper/",
        "/.well-known/",
        "/assets/",
        "/native/oauth-start/",
    ] {
        assert!(!android.contains(&format!("android:path=\"{excluded}\"")));
        assert!(!android.contains(&format!("android:pathPrefix=\"{excluded}\"")));
    }
}
