// Data left under the names this app had before (BananaXterm, then
// BananaTerm), moved over to the current names once:
//
// - %APPDATA% and %LOCALAPPDATA% folders of the old app identifier (sessions,
//   settings, credential list, WebView storage) -> the current identifier;
// - Windows Credential Manager entries "<id>.BananaXterm" -> "<id>.BananaConn";
// - temp folders of the old names are removed (only this app's own scratch).
//
// The Documents folder is moved where it is used (term.rs app_documents).

use std::path::Path;
use std::time::Duration;

/// The identifier every version up to 0.7.28 used.
const OLD_IDENTIFIER: &str = "com.administrator.bananaxterm";
/// The identifier whose data is moved over; other identifiers (the E2E build)
/// keep their own data and never touch the user's.
const IDENTIFIER: &str = "com.administrator.bananaconn";
/// The Credential Manager service name up to 0.7.28.
pub(crate) const OLD_VAULT_SERVICE: &str = "BananaXterm";

/// Before the app starts (no window, so nothing holds the folders yet).
/// An error means the old data is still in use by a running older copy: the
/// app must not start empty, so it says so and quits.
/// Only the released app takes over the old names; other builds (E2E, development)
/// share this PC with the user's installed copy and must not touch its data.
pub fn is_release(identifier: &str) -> bool {
    identifier == IDENTIFIER
}

pub fn move_data_dirs(identifier: &str) -> Result<(), String> {
    if !is_release(identifier) {
        return Ok(());
    }
    for base in [dirs::config_dir(), dirs::data_local_dir()].into_iter().flatten() {
        move_dir(&base.join(OLD_IDENTIFIER), &base.join(IDENTIFIER))?;
    }
    Ok(())
}

/// Rename `old` to `new` unless `new` already exists. A WebView process of an
/// older copy that is just exiting can hold files for a moment: retry briefly.
fn move_dir(old: &Path, new: &Path) -> Result<(), String> {
    if new.exists() || !old.is_dir() {
        return Ok(());
    }
    let mut last = None;
    for _ in 0..20 {
        match std::fs::rename(old, new) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "이전 버전의 데이터 폴더를 옮기지 못했습니다.\n{}\n\n이전 버전(BananaTerm)이 실행 중이면 모두 닫은 뒤 BananaConn을 다시 실행하세요.\n({})",
        old.display(),
        last.map(|e| e.to_string()).unwrap_or_default()
    ))
}

/// Shown when the app cannot start (no window exists yet).
pub fn fatal(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let (text, title) = (wide(message), wide("BananaConn."));
    // SAFETY: NUL-terminated buffers that outlive the call.
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
}

/// Ids of the Credential Manager entries saved under `service`.
fn vault_ids(service: &str) -> Vec<String> {
    use windows_sys::Win32::Security::Credentials::{CREDENTIALW, CredEnumerateW, CredFree};
    let suffix = format!(".{service}");
    let filter: Vec<u16> = format!("*{suffix}").encode_utf16().chain([0]).collect();
    let mut count = 0u32;
    let mut list: *mut *mut CREDENTIALW = std::ptr::null_mut();
    // SAFETY: CredEnumerateW fills `list` with `count` pointers, freed below.
    if unsafe { CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut list) } == 0 {
        return Vec::new();
    }
    let mut ids = Vec::new();
    for i in 0..count as usize {
        // SAFETY: i < count; each entry and its TargetName are valid until CredFree.
        let target = unsafe {
            let c = &**list.add(i);
            let mut len = 0;
            while *c.TargetName.add(len) != 0 {
                len += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(c.TargetName, len))
        };
        if let Some(id) = target.strip_suffix(&suffix).filter(|id| !id.is_empty()) {
            ids.push(id.to_string());
        }
    }
    // SAFETY: the buffer CredEnumerateW returned.
    unsafe { CredFree(list.cast()) };
    ids
}

/// Copy every old-named secret to the current name, check the copy reads
/// back the same, then remove the old entry. A secret that cannot be copied
/// stays where it is (vault.rs still reads it there).
pub fn move_vault_entries(service: &str) {
    move_vault_entries_from(OLD_VAULT_SERVICE, service);
}

fn move_vault_entries_from(old_service: &str, service: &str) {
    for id in vault_ids(old_service) {
        let (Ok(old), Ok(new)) = (keyring::Entry::new(old_service, &id), keyring::Entry::new(service, &id)) else { continue };
        let Ok(secret) = old.get_password() else { continue };
        let copied = match new.get_password() {
            // Saved again by this version meanwhile: the new one is current.
            Ok(_) => true,
            Err(_) => new.set_password(&secret).is_ok() && new.get_password().ok().as_deref() == Some(secret.as_str()),
        };
        if copied {
            let _ = old.delete_credential();
        }
    }
}

/// Scratch folders of the old names in %TEMP% (edit copies, update downloads,
/// RDP clipboard files); this app is their only user.
pub fn remove_old_temp() {
    let temp = std::env::temp_dir();
    for name in ["BananaTerm", "BananaXterm"] {
        let _ = std::fs::remove_dir_all(temp.join(name));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn moves_a_folder_once_and_never_over_an_existing_one() {
        let base = std::env::temp_dir().join(format!("bc-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (old, new) = (base.join("old"), base.join("new"));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("sessions.json"), "[1]").unwrap();
        super::move_dir(&old, &new).unwrap();
        assert_eq!(std::fs::read_to_string(new.join("sessions.json")).unwrap(), "[1]");
        assert!(!old.exists());
        // An old folder appearing later is left alone.
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("sessions.json"), "[2]").unwrap();
        super::move_dir(&old, &new).unwrap();
        assert_eq!(std::fs::read_to_string(new.join("sessions.json")).unwrap(), "[1]");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn other_identifiers_never_move_the_users_data() {
        assert!(!super::is_release("com.administrator.bananaconn.e2e"));
        assert!(super::move_data_dirs("com.administrator.bananaconn.e2e").is_ok());
    }

    #[test]
    fn vault_entries_move_to_the_new_service() {
        let id = format!("bc-legacy-test-{}", std::process::id());
        // Test-only service names: the real "BananaXterm" entries are never touched.
        let old_service = format!("BcOldTest{}", std::process::id());
        let old = keyring::Entry::new(&old_service, &id).unwrap();
        old.set_password("s3cret").unwrap();
        let service = format!("BcNewTest{}", std::process::id());
        super::move_vault_entries_from(&old_service, &service);
        let new = keyring::Entry::new(&service, &id).unwrap();
        assert_eq!(new.get_password().unwrap(), "s3cret");
        assert!(matches!(old.get_password(), Err(keyring::Error::NoEntry)));
        let _ = new.delete_credential();
    }
}
