// Credential vault. Non-secret metadata (name, username, key path) lives in
// credentials.json; the secret itself (password or key passphrase) is stored in
// the Windows Credential Manager and never written to disk by BananaConn.
//
// Commands run off the UI thread: keyring and file I/O can block.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use russh::keys::ssh_key::{Algorithm, LineEnding, PrivateKey};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Credential Manager entries are "<id>.BananaConn". Entries of earlier
/// versions ("<id>.BananaXterm") are moved at startup (legacy.rs) and read
/// from there until they are.
pub(crate) const SERVICE: &str = "BananaConn";

/// Held while credentials.json is read, changed and written back: two saves
/// at the same moment (two tabs storing a login) would otherwise each write
/// their own copy, and one credential would vanish from the list.
static LIST: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub username: String,
    /// "password" or "key".
    pub kind: String,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub has_secret: bool,
}

/// A credential with its secret loaded, for use by connection code only.
pub struct Resolved {
    pub username: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
}

fn meta_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("설정 폴더를 찾을 수 없습니다: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("설정 폴더를 만들 수 없습니다: {e}"))?;
    Ok(dir.join("credentials.json"))
}

fn read_all(app: &AppHandle) -> Result<Vec<Credential>, String> {
    let path = meta_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("자격 증명 목록을 읽을 수 없습니다: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("자격 증명 목록 형식이 올바르지 않습니다: {e}"))
}

/// Write via a temp file and rename so a crash mid-write cannot corrupt the list.
fn write_all(app: &AppHandle, creds: &[Credential]) -> Result<(), String> {
    let path = meta_path(app)?;
    let text = serde_json::to_string_pretty(creds).map_err(|e| e.to_string())?;
    crate::store::write_atomic(&path, text.as_bytes()).map_err(|e| format!("자격 증명 목록을 저장할 수 없습니다: {e}"))
}

fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, id).map_err(|e| format!("자격 증명 저장소에 접근할 수 없습니다: {e}"))
}

/// A missing entry is `None`; any other failure is reported, not hidden.
fn read_secret(id: &str) -> Result<Option<String>, String> {
    match entry(id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => match keyring::Entry::new(crate::legacy::OLD_VAULT_SERVICE, id).and_then(|e| e.get_password()) {
            Ok(secret) => Ok(Some(secret)),
            Err(_) => Ok(None),
        },
        Err(e) => Err(format!("저장된 비밀 값을 읽을 수 없습니다: {e}")),
    }
}

/// Remove the secret under the current name and under the old one (an entry
/// not moved yet must not come back through the read_secret fallback).
fn delete_secret(id: &str) -> Result<(), String> {
    let old = keyring::Entry::new(crate::legacy::OLD_VAULT_SERVICE, id).map_err(|e| format!("자격 증명 저장소에 접근할 수 없습니다: {e}"))?;
    for en in [entry(id)?, old] {
        match en.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("저장된 비밀 값을 지울 수 없습니다: {e}")),
        }
    }
    Ok(())
}

/// Load a credential together with its secret.
pub fn resolve(app: &AppHandle, id: &str) -> Result<Resolved, String> {
    crate::lock::require_unlocked(app)?;
    let cred = read_all(app)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "선택한 자격 증명이 삭제되었습니다. 세션 편집에서 다른 자격 증명을 고르세요.".to_string())?;
    let secret = if cred.has_secret { read_secret(&cred.id)? } else { None };
    Ok(if cred.kind == "key" {
        Resolved {
            username: cred.username,
            password: None,
            key_path: cred.key_path,
            passphrase: secret,
        }
    } else {
        Resolved {
            username: cred.username,
            password: secret,
            key_path: None,
            passphrase: None,
        }
    })
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vault_list(app: AppHandle) -> Result<Vec<Credential>, String> {
    blocking(move || read_all(&app)).await
}

/// Create or update a credential. `secret`: None keeps the stored secret,
/// Some("") removes it, any other value replaces it.
#[tauri::command]
pub async fn vault_save(app: AppHandle, cred: Credential, secret: Option<String>) -> Result<Credential, String> {
    blocking(move || {
        crate::lock::require_unlocked(&app)?;
        let _list = LIST.lock().unwrap_or_else(|p| p.into_inner());
        let mut cred = cred;
        let mut creds = read_all(&app)?;
        let previous = creds.iter().find(|c| c.id == cred.id).map(|c| c.has_secret);
        let kind_changed = creds.iter().any(|c| c.id == cred.id && c.kind != cred.kind);
        match secret.as_deref() {
            Some("") => {
                delete_secret(&cred.id)?;
                cred.has_secret = false;
            }
            Some(value) => {
                entry(&cred.id)?
                    .set_password(value)
                    .map_err(|e| format!("비밀 값을 저장할 수 없습니다: {e}"))?;
                cred.has_secret = true;
            }
            // A secret means something else per kind (key passphrase vs password):
            // switching kind without a new one must not reuse the old value.
            None if kind_changed => {
                delete_secret(&cred.id)?;
                cred.has_secret = false;
            }
            None => cred.has_secret = previous.unwrap_or(false),
        }
        if let Some(slot) = creds.iter_mut().find(|c| c.id == cred.id) {
            *slot = cred.clone();
        } else {
            creds.push(cred.clone());
        }
        if let Err(e) = write_all(&app, &creds) {
            // A new credential's secret must not stay behind without its entry.
            if previous.is_none() && cred.has_secret
                && let Ok(en) = entry(&cred.id) {
                    let _ = en.delete_credential();
                }
            return Err(e);
        }
        Ok(cred)
    })
    .await
}

#[tauri::command]
pub async fn vault_delete(app: AppHandle, id: String) -> Result<(), String> {
    blocking(move || {
        crate::lock::require_unlocked(&app)?;
        let _list = LIST.lock().unwrap_or_else(|p| p.into_inner());
        let mut creds = read_all(&app)?;
        creds.retain(|c| c.id != id);
        // Remove the secret first; if that fails keep the entry so it can be retried.
        delete_secret(&id)?;
        write_all(&app, &creds)
    })
    .await
}

/// Generate a new key pair in-process (no ssh-keygen, so the passphrase never
/// appears on a command line). Refuses to overwrite an existing file. Returns
/// the public key in OpenSSH format.
#[tauri::command]
pub async fn vault_generate_key(app: AppHandle, path: String, key_type: String, passphrase: String, comment: String) -> Result<String, String> {
    crate::lock::require_unlocked(&app)?;
    generate_key(path, key_type, passphrase, comment).await
}

async fn generate_key(path: String, key_type: String, passphrase: String, comment: String) -> Result<String, String> {
    blocking(move || {
        let target = Path::new(&path);
        let pub_path = PathBuf::from(format!("{path}.pub"));
        if target.exists() || pub_path.exists() {
            return Err("같은 이름의 키 파일이 이미 있습니다. 다른 경로를 선택하세요.".to_string());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("폴더를 만들 수 없습니다: {e}"))?;
        }
        let algorithm = if key_type == "rsa" { Algorithm::Rsa { hash: None } } else { Algorithm::Ed25519 };
        let mut rng = rand::rngs::ThreadRng::default();
        let mut key = PrivateKey::random(&mut rng, algorithm).map_err(|e| format!("키를 만들 수 없습니다: {e}"))?;
        key.set_comment(comment);
        let public = key
            .public_key()
            .to_openssh()
            .map_err(|e| format!("공개 키를 만들 수 없습니다: {e}"))?;
        let key = if passphrase.is_empty() {
            key
        } else {
            key.encrypt(&mut rng, passphrase.as_bytes())
                .map_err(|e| format!("키를 암호화할 수 없습니다: {e}"))?
        };
        let pem = key.to_openssh(LineEnding::LF).map_err(|e| format!("키를 저장할 수 없습니다: {e}"))?;
        // OpenSSH for Windows rejects private keys other accounts can read, and a
        // new file inherits its folder's ACL. Lock the empty file down first, then
        // write the key, so it is never readable by anyone else.
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(|e| format!("개인 키를 저장할 수 없습니다: {e}"))?;
        let written = restrict_to_owner(target)
            .and_then(|()| fs::write(target, pem.as_bytes()).map_err(|e| format!("개인 키를 저장할 수 없습니다: {e}")))
            .and_then(|()| fs::write(&pub_path, format!("{public}\n")).map_err(|e| format!("공개 키를 저장할 수 없습니다: {e}")));
        if let Err(e) = written {
            // Leave no half-made key pair behind.
            let _ = fs::remove_file(target);
            let _ = fs::remove_file(&pub_path);
            return Err(e);
        }
        Ok(public)
    })
    .await
}

/// Remove inherited permissions and grant access to the current user only
/// (the same protection ssh-keygen applies).
fn restrict_to_owner(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // Grant by SID: a bare %USERNAME% can resolve to a different (local vs.
    // domain) account with the same name.
    let sid = current_user_sid()?;
    let out = std::process::Command::new(system32("icacls.exe"))
        .arg(path)
        .args(["/inheritance:r", "/grant:r", &format!("*{sid}:F")])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("키 파일 권한을 설정할 수 없습니다: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("키 파일 권한을 설정할 수 없습니다: {}", String::from_utf8_lossy(&out.stdout).trim()))
    }
}

/// A Windows tool by absolute path, so a same-named program earlier on PATH
/// (e.g. Git's coreutils `whoami`) is never picked up.
fn system32(exe: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join(exe)
}

/// SID of the account this process runs as, from `whoami /user`.
fn current_user_sid() -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new(system32("whoami.exe"))
        .args(["/user", "/fo", "csv", "/nh"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("현재 사용자 계정을 확인할 수 없습니다: {e}"))?;
    parse_sid(&String::from_utf8_lossy(&out.stdout)).ok_or_else(|| "현재 사용자 계정을 확인할 수 없습니다".to_string())
}

/// Last CSV field of `whoami /user /fo csv /nh`, e.g. "DOMAIN\\me","S-1-5-21-…".
fn parse_sid(csv: &str) -> Option<String> {
    let sid = csv.trim().rsplit(',').next()?.trim().trim_matches('"');
    let valid = sid.starts_with("S-1-") && sid.len() > 4 && sid[4..].chars().all(|c| c.is_ascii_digit() || c == '-');
    valid.then(|| sid.to_string())
}

fn public_key(key_path: &str) -> Result<String, String> {
    let pub_path = format!("{key_path}.pub");
    fs::read_to_string(&pub_path)
        .map(|s| s.trim().to_string())
        .map_err(|_| format!("공개 키 파일을 찾을 수 없습니다: {pub_path}"))
}

#[tauri::command]
pub async fn vault_public_key(key_path: String) -> Result<String, String> {
    blocking(move || public_key(&key_path)).await
}

/// Return a stored password. Used only by the built-in VNC viewer, whose RFB
/// authentication runs in the frontend (noVNC); other protocols authenticate in
/// the backend and never expose the secret.
#[tauri::command]
pub async fn vault_reveal(app: AppHandle, id: String) -> Result<Option<String>, String> {
    blocking(move || {
        if !crate::store::vnc_credential_ids(&app).contains(&id) {
            return Err("VNC 세션에 연결된 자격 증명만 사용할 수 있습니다".into());
        }
        Ok(resolve(&app, &id)?.password)
    })
    .await
}

/// Default directory for new keys: ~/.ssh
#[tauri::command]
pub fn vault_default_key_dir() -> String {
    dirs::home_dir()
        .map(|h| h.join(".ssh").to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_whoami_sid() {
        assert_eq!(parse_sid("\"host\\me\",\"S-1-5-21-1-2-3-500\"\r\n").as_deref(), Some("S-1-5-21-1-2-3-500"));
        assert_eq!(parse_sid("garbage"), None);
        assert_eq!(parse_sid("\"a\",\"S-1-5-21-1;rm\""), None);
        assert!(current_user_sid().unwrap().starts_with("S-1-5-"));
    }

    #[test]
    fn generated_keys_round_trip_through_openssh_format() {
        let dir = std::env::temp_dir().join(format!("bx-keygen-{}", std::process::id()));
        let path = dir.join("id_test");
        let path_s = path.to_string_lossy().into_owned();
        let public = tauri::async_runtime::block_on(generate_key(
            path_s.clone(),
            "ed25519".into(),
            "s3cret".into(),
            "test@bananaconn".into(),
        ))
        .unwrap();
        assert!(public.starts_with("ssh-ed25519 ") && public.ends_with("test@bananaconn"));
        // russh (the SFTP client) must be able to load it with the passphrase only.
        assert!(russh::keys::load_secret_key(&path, Some("s3cret")).is_ok());
        assert!(russh::keys::load_secret_key(&path, Some("wrong")).is_err());
        // The system OpenSSH (used by the terminal) must accept it too.
        if let Ok(out) = std::process::Command::new("ssh-keygen").args(["-y", "-P", "s3cret", "-f", &path_s]).output() {
            let derived = String::from_utf8_lossy(&out.stdout);
            assert!(out.status.success(), "ssh-keygen: {}", String::from_utf8_lossy(&out.stderr));
            assert_eq!(derived.split_whitespace().nth(1), public.split_whitespace().nth(1));
        }
        // Never overwrites.
        assert!(tauri::async_runtime::block_on(generate_key(path_s, "ed25519".into(), String::new(), String::new())).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
