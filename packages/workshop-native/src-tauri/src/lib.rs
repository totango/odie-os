use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
use tauri_plugin_keyring_store::KeyringExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_stronghold::stronghold::Stronghold;
use url::Url;

const ALLOWED_SESSION_KEY: &str = "workshop.sessionToken";
const ALLOWED_PENDING_FLOW_KEY: &str = "workshop.pendingNativeLoginFlow";
#[cfg(not(target_os = "macos"))]
const STRONGHOLD_CLIENT: &[u8] = b"odie-os";
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
const STRONGHOLD_UNLOCK_ACCOUNT: &str = "workshop.strongholdUnlockKey";
const ODIE_PRODUCTION_ORIGIN: &str = "https://odie-os-native-api.odie-os.workers.dev";

#[derive(serde::Serialize)]
struct NativeAppInfo {
    platform: &'static str,
    version: String,
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
#[derive(Clone)]
struct StrongholdUnlockKeyStore {
    app_data_dir: PathBuf,
    // The OS-authenticated vault key and decrypted Stronghold stay only in this process. Reopening
    // the snapshot performs an intentionally expensive key derivation, so every command must reuse
    // this lease rather than decrypting the same file again.
    unlocked_key: Arc<Mutex<Option<String>>>,
    stronghold: Arc<Mutex<Option<Stronghold>>>,
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
impl StrongholdUnlockKeyStore {
    fn new(app_data_dir: PathBuf) -> Self {
        Self {
            app_data_dir,
            unlocked_key: Arc::new(Mutex::new(None)),
            stronghold: Arc::new(Mutex::new(None)),
        }
    }

    fn release_key<R: Runtime>(&self, app: &AppHandle<R>) -> Result<String, String> {
        let mut unlocked_key = self
            .unlocked_key
            .lock()
            .map_err(|_| "native vault key lock is poisoned".to_string())?;
        if let Some(key) = unlocked_key.as_ref() {
            return Ok(key.clone());
        }
        let key = release_os_protected_stronghold_key(app, &self.app_data_dir)?;
        *unlocked_key = Some(key.clone());
        Ok(key)
    }

    fn with_stronghold<R: Runtime, T>(
        &self,
        app: &AppHandle<R>,
        operation: impl FnOnce(&Stronghold) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut cached = self
            .stronghold
            .lock()
            .map_err(|_| "native Stronghold lock is poisoned".to_string())?;
        if cached.is_none() {
            fs::create_dir_all(&self.app_data_dir)
                .map_err(|error| format!("could not create native data directory: {error}"))?;
            let unlock_key = decode_key_hex(&self.release_key(app)?)?;
            *cached = Some(
                Stronghold::new(self.snapshot_path(), unlock_key)
                    .map_err(|error| format!("could not open Stronghold snapshot: {error}"))?,
            );
        }
        operation(cached.as_ref().expect("Stronghold initialized above"))
    }

    #[cfg(any(test, target_os = "ios", target_os = "android"))]
    fn lock(&self) -> Result<(), String> {
        *self
            .stronghold
            .lock()
            .map_err(|_| "native Stronghold lock is poisoned".to_string())? = None;
        *self
            .unlocked_key
            .lock()
            .map_err(|_| "native vault key lock is poisoned".to_string())? = None;
        Ok(())
    }

    fn snapshot_path(&self) -> PathBuf {
        self.app_data_dir.join("odie-os.stronghold")
    }

    fn has_snapshot(&self) -> bool {
        self.snapshot_path().exists()
    }
}

fn release_os_protected_stronghold_key<R: Runtime>(
    app: &AppHandle<R>,
    app_data_dir: &std::path::Path,
) -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        if std::env::var("ODIE_DEV_NATIVE_SECRET_FALLBACK").as_deref() == Ok("true") {
            return release_development_stronghold_key(app_data_dir);
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = app_data_dir;

    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        authenticate_mobile_unlock(app)?;
        return read_or_create_keyring_unlock_key(app);
    }

    #[cfg(target_os = "macos")]
    {
        // The login Keychain is already encrypted at rest and unlocked by the macOS user session.
        // Requiring a second device-owner prompt on every app launch made a persisted native login
        // behave like a password manager rather than a normal signed-in desktop app.
        read_or_create_keyring_unlock_key(app)
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    {
        let _ = app;
        Err("No approved OS vault is available for this platform.".to_string())
    }
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn authenticate_mobile_unlock<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tauri_plugin_biometric::{AuthOptions, BiometricExt};

    let status = app
        .biometric()
        .status()
        .map_err(|error| format!("could not query device authentication status: {error}"))?;
    if !status.is_available {
        return Err(status.error.unwrap_or_else(|| {
            "biometric/device-credential authentication is unavailable".to_string()
        }));
    }
    app.biometric()
        .authenticate(
            "Unlock Odie OS session storage".to_string(),
            AuthOptions {
                allow_device_credential: true,
                cancel_title: Some("Cancel".to_string()),
                fallback_title: Some("Use device credential".to_string()),
                title: Some("Unlock Odie OS".to_string()),
                subtitle: Some(
                    "Authenticate to release the encrypted session vault key.".to_string(),
                ),
                confirmation_required: Some(true),
            },
        )
        .map_err(|error| format!("device authentication failed: {error}"))
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
fn read_or_create_keyring_unlock_key<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    if let Some(existing) = app
        .keyring()
        .store
        .get_password(STRONGHOLD_UNLOCK_ACCOUNT)
        .map_err(|error| format!("could not read Stronghold key from OS vault: {error}"))?
    {
        return Ok(existing);
    }
    let key = random_key_hex()?;
    app.keyring()
        .store
        .set_password(STRONGHOLD_UNLOCK_ACCOUNT, &key)
        .map_err(|error| format!("could not store Stronghold key in OS vault: {error}"))?;
    Ok(key)
}

#[cfg(debug_assertions)]
fn release_development_stronghold_key(app_data_dir: &std::path::Path) -> Result<String, String> {
    let path = app_data_dir.join("dev-stronghold-unlock-key");
    if path.exists() {
        return fs::read_to_string(&path)
            .map_err(|error| format!("could not read development Stronghold key: {error}"));
    }
    fs::create_dir_all(app_data_dir)
        .map_err(|error| format!("could not create development key directory: {error}"))?;
    let key = random_key_hex()?;
    fs::write(&path, &key)
        .map_err(|error| format!("could not persist development Stronghold key: {error}"))?;
    Ok(key)
}

fn random_key_hex() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("could not generate Stronghold key: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn decode_key_hex(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.len() != 64 {
        return Err("OS vault contains an invalid Stronghold key".to_string());
    }
    (0..encoded.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&encoded[index..index + 2], 16)
                .map_err(|_| "OS vault contains an invalid Stronghold key".to_string())
        })
        .collect()
}

fn validate_session_key(key: &str) -> Result<(), String> {
    if matches!(key, ALLOWED_SESSION_KEY | ALLOWED_PENDING_FLOW_KEY) {
        Ok(())
    } else {
        Err("unsupported secret key".to_string())
    }
}

fn validate_oauth_trampoline(url: &str) -> Result<String, String> {
    let parsed = Url::parse(url).map_err(|_| "invalid URL".to_string())?;
    if parsed.origin().ascii_serialization() != ODIE_PRODUCTION_ORIGIN
        || parsed.username() != ""
        || parsed.password().is_some()
        || !parsed.path().starts_with("/native/oauth-start/")
        || parsed.fragment().is_some()
    {
        return Err("OAuth trampoline URL is not allowed".to_string());
    }
    Ok(parsed.to_string())
}

fn validate_external_link(url: &str) -> Result<String, String> {
    let parsed = Url::parse(url).map_err(|_| "invalid URL".to_string())?;
    if !matches!(parsed.scheme(), "https" | "mailto")
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.path().starts_with("/native/oauth-start/")
    {
        return Err("external URL is not allowed".to_string());
    }
    Ok(parsed.to_string())
}

fn safe_filename(filename: &str) -> Result<String, String> {
    let trimmed = filename.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed == "."
        || trimmed == ".."
    {
        return Err("invalid filename".to_string());
    }
    Ok(trimmed.to_string())
}

fn selected_save_path(app: &AppHandle, filename: &str) -> Result<PathBuf, String> {
    let filename = safe_filename(filename)?;
    app.dialog()
        .file()
        .set_file_name(filename)
        .blocking_save_file()
        .ok_or_else(|| "save cancelled".to_string())?
        .into_path()
        .map_err(|error| format!("could not use selected file destination: {error}"))
}

#[cfg(not(target_os = "macos"))]
fn stronghold_client(stronghold: &Stronghold) -> Result<iota_stronghold::Client, String> {
    let inner = stronghold.inner();
    inner
        .load_client(STRONGHOLD_CLIENT)
        .or_else(|_| inner.create_client(STRONGHOLD_CLIENT))
        .map_err(|error| format!("could not open Stronghold client: {error}"))
}

#[tauri::command]
async fn read_session_secret<R: Runtime>(
    app: AppHandle<R>,
    store: tauri::State<'_, StrongholdUnlockKeyStore>,
    key: String,
) -> Result<Option<String>, String> {
    validate_session_key(&key)?;
    #[cfg(target_os = "macos")]
    {
        let _ = store;
        app.keyring()
            .store
            .get_password(&key)
            .map_err(|error| format!("could not read native secret from macOS Keychain: {error}"))
    }
    #[cfg(not(target_os = "macos"))]
    let store = store.inner().clone();
    #[cfg(not(target_os = "macos"))]
    tauri::async_runtime::spawn_blocking(move || {
        if !store.has_snapshot() {
            return Ok(None);
        }
        store.with_stronghold(&app, |stronghold| {
            let client = stronghold_client(stronghold)?;
            let Some(bytes) = client
                .store()
                .get(key.as_bytes())
                .map_err(|error| format!("could not read Stronghold record: {error}"))?
            else {
                return Ok(None);
            };
            String::from_utf8(bytes)
                .map(Some)
                .map_err(|error| format!("Stronghold record is not valid UTF-8: {error}"))
        })
    })
    .await
    .map_err(|error| format!("native vault task failed: {error}"))?
}

#[tauri::command]
async fn write_session_secret<R: Runtime>(
    app: AppHandle<R>,
    store: tauri::State<'_, StrongholdUnlockKeyStore>,
    key: String,
    token: String,
) -> Result<(), String> {
    validate_session_key(&key)?;
    #[cfg(target_os = "macos")]
    {
        let _ = store;
        app.keyring()
            .store
            .set_password(&key, &token)
            .map_err(|error| format!("could not write native secret to macOS Keychain: {error}"))
    }
    #[cfg(not(target_os = "macos"))]
    let store = store.inner().clone();
    #[cfg(not(target_os = "macos"))]
    tauri::async_runtime::spawn_blocking(move || {
        store.with_stronghold(&app, |stronghold| {
            let client = stronghold_client(stronghold)?;
            client
                .store()
                .insert(
                    key.into_bytes(),
                    token.into_bytes(),
                    None::<std::time::Duration>,
                )
                .map_err(|error| format!("could not write Stronghold record: {error}"))?;
            stronghold
                .save()
                .map_err(|error| format!("could not save Stronghold snapshot: {error}"))
        })
    })
    .await
    .map_err(|error| format!("native vault task failed: {error}"))?
}

#[tauri::command]
async fn clear_session_secret<R: Runtime>(
    app: AppHandle<R>,
    store: tauri::State<'_, StrongholdUnlockKeyStore>,
    key: String,
) -> Result<(), String> {
    validate_session_key(&key)?;
    #[cfg(target_os = "macos")]
    {
        let _ = store;
        app.keyring()
            .store
            .delete(&key)
            .map_err(|error| format!("could not clear native secret from macOS Keychain: {error}"))
    }
    #[cfg(not(target_os = "macos"))]
    let store = store.inner().clone();
    #[cfg(not(target_os = "macos"))]
    tauri::async_runtime::spawn_blocking(move || {
        store.with_stronghold(&app, |stronghold| {
            let client = stronghold_client(stronghold)?;
            client
                .store()
                .delete(key.as_bytes())
                .map_err(|error| format!("could not clear Stronghold record: {error}"))?;
            stronghold
                .save()
                .map_err(|error| format!("could not save Stronghold snapshot: {error}"))
        })
    })
    .await
    .map_err(|error| format!("native vault task failed: {error}"))?
}

#[tauri::command]
fn save_file(
    app: AppHandle,
    filename: String,
    content_type: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let _ = content_type;
    let path = selected_save_path(&app, &filename)?;
    fs::write(&path, bytes).map_err(|error| format!("could not write selected file: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn save_text_file(app: AppHandle, filename: String, content: String) -> Result<String, String> {
    let path = selected_save_path(&app, &filename)?;
    fs::write(&path, content).map_err(|error| format!("could not write selected file: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_oauth_trampoline(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(validate_oauth_trampoline(&url)?, None::<&str>)
        .map_err(|error| format!("could not open OAuth trampoline: {error}"))
}

#[tauri::command]
fn open_external_link(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(validate_external_link(&url)?, None::<&str>)
        .map_err(|error| format!("could not open external link: {error}"))
}

#[tauri::command]
fn native_app_info<R: Runtime>(app: AppHandle<R>) -> NativeAppInfo {
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "android") {
        "android"
    } else {
        "other"
    };
    NativeAppInfo {
        platform,
        version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
fn lock_session(store: tauri::State<'_, StrongholdUnlockKeyStore>) -> Result<(), String> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    return store.lock();
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = store;
        Ok(())
    }
}

#[tauri::command]
async fn unlock_session<R: Runtime>(
    app: AppHandle<R>,
    store: tauri::State<'_, StrongholdUnlockKeyStore>,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let _ = (app, store);
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    let store = store.inner().clone();
    #[cfg(not(target_os = "macos"))]
    tauri::async_runtime::spawn_blocking(move || Ok(store.release_key(&app).is_ok()))
        .await
        .map_err(|error| format!("native vault task failed: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .setup(|app| {
            app.manage(StrongholdUnlockKeyStore::new(app.path().app_data_dir()?));
            Ok(())
        })
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_keyring_store::Builder::new()
                .service("com.totango.odieos.stronghold-unlock")
                .build(),
        )
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            read_session_secret,
            write_session_secret,
            clear_session_secret,
            save_file,
            save_text_file,
            open_oauth_trampoline,
            open_external_link,
            native_app_info,
            lock_session,
            unlock_session,
        ]);

    #[cfg(any(target_os = "ios", target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_biometric::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running Odie OS native shell");
}

#[cfg(test)]
mod tests {
    use super::{
        decode_key_hex, safe_filename, validate_external_link, validate_oauth_trampoline,
        validate_session_key, Stronghold, StrongholdUnlockKeyStore, ALLOWED_PENDING_FLOW_KEY,
        ALLOWED_SESSION_KEY,
    };

    #[test]
    fn session_key_is_allowlisted() {
        assert!(validate_session_key(ALLOWED_SESSION_KEY).is_ok());
        assert!(validate_session_key(ALLOWED_PENDING_FLOW_KEY).is_ok());
        assert!(validate_session_key("other").is_err());
    }

    #[test]
    fn opener_commands_are_narrowly_validated() {
        assert!(validate_oauth_trampoline(
            "https://odie-os-native-api.odie-os.workers.dev/native/oauth-start/abc"
        )
        .is_ok());
        assert!(validate_oauth_trampoline("https://evil.example/native/oauth-start/abc").is_err());
        assert!(validate_oauth_trampoline(
            "https://odie-os-native-api.odie-os.workers.dev/workspaces"
        )
        .is_err());
        assert!(validate_external_link("https://example.com/docs").is_ok());
        assert!(validate_external_link(
            "https://odie-os-native-api.odie-os.workers.dev/native/oauth-start/abc"
        )
        .is_err());
        assert!(validate_external_link("file:///tmp/x").is_err());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn development_fallback_key_is_random_and_persistent() {
        let dir = tempfile::tempdir().unwrap();
        let first = super::release_development_stronghold_key(dir.path()).unwrap();
        let second = super::release_development_stronghold_key(dir.path()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert_ne!(first, "0".repeat(64));
    }

    #[test]
    fn stronghold_key_is_decoded_to_the_required_32_bytes() {
        let decoded = decode_key_hex(&"ab".repeat(32)).unwrap();
        assert_eq!(decoded, vec![0xab; 32]);
        assert!(decode_key_hex("too-short").is_err());
        assert!(decode_key_hex(&"zz".repeat(32)).is_err());
    }

    #[test]
    fn lifecycle_lock_clears_the_in_memory_unlock_lease() {
        let store =
            StrongholdUnlockKeyStore::new(tempfile::tempdir().unwrap().path().to_path_buf());
        *store.unlocked_key.lock().unwrap() = Some("key".to_string());
        *store.stronghold.lock().unwrap() =
            Some(Stronghold::new(store.snapshot_path(), vec![0; 32]).unwrap());
        store.lock().unwrap();
        assert!(store.unlocked_key.lock().unwrap().is_none());
        assert!(store.stronghold.lock().unwrap().is_none());
    }

    #[test]
    fn new_store_has_no_snapshot_to_unlock() {
        let store =
            StrongholdUnlockKeyStore::new(tempfile::tempdir().unwrap().path().to_path_buf());
        assert!(!store.has_snapshot());
    }

    #[test]
    fn filenames_cannot_escape_destination() {
        assert_eq!(safe_filename("export.gadget").unwrap(), "export.gadget");
        assert!(safe_filename("../secret").is_err());
        assert!(safe_filename("nested/file").is_err());
        assert!(safe_filename("").is_err());
    }
}
