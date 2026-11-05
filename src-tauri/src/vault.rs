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
        // The keyring changes before the list is written; if that write fails,
        // the two would disagree. Keep the old secret so the keyring can be put
        // back. (`touched` is set whenever the keyring entry is mutated below.)
        let touched = secret.is_some() || kind_changed;
        // read_secret includes the legacy store, so a not-yet-migrated secret
        // can still be restored if the list write later fails.
        let old_secret = if touched && previous == Some(true) { read_secret(&cred.id).ok().flatten() } else { None };
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
            // The list write failed: undo the keyring change so the two agree.
            if touched {
                match &old_secret {
                    // Restore the secret that was there before this save.
                    Some(old) => {
                        let _ = entry(&cred.id).and_then(|en| en.set_password(old).map_err(|e| e.to_string()));
                    }
                    // There was none; remove the one this save had just added.
                    None => {
                        if let Ok(en) = entry(&cred.id) {
                            let _ = en.delete_credential();
                        }
                    }
                }
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
        let written = write_private(target, pem.as_bytes())
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

/// Write a new private key file that only this user can read. OpenSSH for
/// Windows rejects private keys other accounts can read, and a new file
/// inherits its folder's ACL: the empty file is locked down first, then
/// written, so the key is never readable by anyone else. Nothing is left
/// behind when it fails.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("개인 키를 저장할 수 없습니다: {e}"))?;
    let written = restrict_to_owner(path).and_then(|()| fs::write(path, bytes).map_err(|e| format!("개인 키를 저장할 수 없습니다: {e}")));
    if written.is_err() {
        let _ = fs::remove_file(path);
    }
    written
}

/// What a key file is, for logging in with it, from its first lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyFileKind {
    /// No such file, or it cannot be read.
    Missing,
    /// OpenSSH or PEM: ssh.exe and the SFTP client read it.
    OpenSsh,
    /// PuTTY (.ppk): the SFTP client reads it; the terminal uses a converted
    /// copy (terminal_key).
    Putty { encrypted: bool },
    /// The SSH.com format of keys SecureCRT made: neither reads it.
    Foreign,
    /// A public key, not the private one.
    Public,
    Unknown,
}

pub(crate) fn key_file_kind(path: &Path) -> KeyFileKind {
    use std::io::Read as _;
    let Ok(file) = fs::File::open(path) else { return KeyFileKind::Missing };
    let mut head = Vec::new();
    if file.take(4096).read_to_end(&mut head).is_err() {
        return KeyFileKind::Missing;
    }
    key_kind_of(&head)
}

/// What a key file is, from its first bytes.
pub(crate) fn key_kind_of(head: &[u8]) -> KeyFileKind {
    let text = String::from_utf8_lossy(&head[..head.len().min(4096)]);
    let text = text.trim_start_matches('\u{feff}').trim_start();
    let first = text.lines().next().unwrap_or("").trim();
    let pem = first.strip_prefix("-----BEGIN ").and_then(|r| r.strip_suffix("-----"));
    if let Some(label) = pem {
        return match label {
            "OPENSSH PRIVATE KEY" | "RSA PRIVATE KEY" | "EC PRIVATE KEY" | "DSA PRIVATE KEY" | "PRIVATE KEY" | "ENCRYPTED PRIVATE KEY" => KeyFileKind::OpenSsh,
            "PUBLIC KEY" | "RSA PUBLIC KEY" => KeyFileKind::Public,
            _ => KeyFileKind::Unknown,
        };
    }
    if first.starts_with("PuTTY-User-Key-File-") {
        let encryption = text.lines().find_map(|l| l.strip_prefix("Encryption:")).map(str::trim).unwrap_or("none");
        return KeyFileKind::Putty { encrypted: encryption != "none" };
    }
    if first.starts_with("---- BEGIN SSH2 ") {
        return if first.contains("PUBLIC KEY") { KeyFileKind::Public } else { KeyFileKind::Foreign };
    }
    let algorithm = first.split_whitespace().next().unwrap_or("");
    if ["ssh-", "ecdsa-", "sk-"].iter().any(|p| algorithm.starts_with(p)) && first.split_whitespace().nth(1).is_some_and(|b| b.starts_with("AAAA")) {
        return KeyFileKind::Public;
    }
    KeyFileKind::Unknown
}

/// Whether a private key file is protected by a passphrase: a PuTTY key with
/// an Encryption other than none, an OpenSSH key with a cipher, or a PEM key
/// marked ENCRYPTED.
pub(crate) fn key_is_encrypted(path: &Path) -> bool {
    match key_file_kind(path) {
        KeyFileKind::Putty { encrypted } => encrypted,
        KeyFileKind::OpenSsh => fs::read_to_string(path).is_ok_and(|t| {
            t.contains("ENCRYPTED") || PrivateKey::from_openssh(t.trim()).is_ok_and(|k| k.is_encrypted())
        }),
        _ => false,
    }
}

/// A converted copy of a key for ssh.exe, encrypted with a one-time
/// passphrase; the file is removed when this is dropped.
pub(crate) struct TempKey {
    pub path: PathBuf,
    pub passphrase: String,
}

impl Drop for TempKey {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// The key file ssh.exe should use for a credential's key: `None` when it
/// reads the key itself (OpenSSH, PEM, or a file that is not there, which it
/// reports); for a PuTTY key (.ppk), which it cannot read, a temporary
/// OpenSSH copy. The copy is encrypted with a one-time passphrase that the
/// terminal answers when ssh.exe asks, so the key never lies on disk
/// unprotected, and it is removed once the session ends (copies left by a
/// crash are swept on the next conversion).
pub(crate) fn terminal_key(app: &AppHandle, key_path: &str, passphrase: Option<&str>) -> Result<Option<TempKey>, String> {
    let KeyFileKind::Putty { encrypted } = key_file_kind(Path::new(key_path)) else { return Ok(None) };
    if encrypted && passphrase.is_none() {
        return Err(format!("암호가 걸린 PuTTY 키(.ppk)입니다: {key_path}. 자격 증명 보관함에서 이 키의 암호를 저장하면 터미널에서도 쓸 수 있습니다."));
    }
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("데이터 폴더를 찾을 수 없습니다: {e}"))?
        .join("terminal-keys");
    convert_putty(Path::new(key_path), passphrase, &dir).map(Some)
}

pub(crate) fn convert_putty(key_path: &Path, passphrase: Option<&str>, dir: &Path) -> Result<TempKey, String> {
    use rand::distr::{Alphanumeric, SampleString};
    let text = fs::read_to_string(key_path).map_err(|e| format!("키 파일을 읽을 수 없습니다 ({}): {e}", key_path.display()))?;
    let key = russh::keys::decode_secret_key(&text, passphrase).map_err(|e| format!("PuTTY 키(.ppk)를 열 수 없습니다 ({}): {e}", key_path.display()))?;
    fs::create_dir_all(dir).map_err(|e| format!("폴더를 만들 수 없습니다: {e}"))?;
    sweep_stale(dir);
    let mut rng = rand::rngs::ThreadRng::default();
    let one_time = Alphanumeric.sample_string(&mut rng, 32);
    let pem = key
        .encrypt(&mut rng, one_time.as_bytes())
        .and_then(|k| k.to_openssh(LineEnding::LF))
        .map_err(|e| format!("키를 변환할 수 없습니다: {e}"))?;
    let path = dir.join(format!("{}.key", Alphanumeric.sample_string(&mut rng, 16)));
    write_private(&path, pem.as_bytes())?;
    Ok(TempKey { path, passphrase: one_time })
}

/// Remove converted keys older than an hour: ssh.exe reads its key while it
/// logs in, and each connection makes its own copy.
fn sweep_stale(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let stale = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() > 3600);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Make a key credential's file readable by this user only, as ssh-keygen
/// does for the keys it makes: OpenSSH for Windows ignores a private key
/// other accounts can read ("UNPROTECTED PRIVATE KEY FILE") and asks for a
/// password instead. Only the file of a saved key credential, and only a
/// private key, so this cannot change the permissions of any other file.
#[tauri::command]
pub async fn vault_protect_key(app: AppHandle, key_path: String) -> Result<(), String> {
    blocking(move || {
        crate::lock::require_unlocked(&app)?;
        let known: Vec<String> = read_all(&app)?.into_iter().filter(|c| c.kind == "key").filter_map(|c| c.key_path).collect();
        let ssh_dir = dirs::home_dir().map(|h| h.join(".ssh"));
        let path = protectable_key(&key_path, &known, ssh_dir.as_deref()).ok_or("자격 증명 보관함이나 .ssh 폴더의 키 파일만 고칠 수 있습니다")?;
        if !matches!(key_file_kind(&path), KeyFileKind::OpenSsh | KeyFileKind::Putty { .. }) {
            return Err("개인 키 파일이 아닙니다".into());
        }
        restrict_to_owner(&path)
    })
    .await
}

/// The file `vault_protect_key` may change: a saved key credential's file, or
/// a file directly in the user's .ssh folder (the default keys ssh.exe tries
/// on its own). Compared as real paths, so a short name (ADMINI~1) matches and
/// ".." cannot reach out of the folder.
fn protectable_key(key_path: &str, known: &[String], ssh_dir: Option<&Path>) -> Option<PathBuf> {
    let real = fs::canonicalize(key_path.trim()).ok()?;
    if known.iter().any(|p| fs::canonicalize(p.trim()).is_ok_and(|k| k == real)) {
        return Some(real);
    }
    let dir = fs::canonicalize(ssh_dir?).ok()?;
    (real.parent() == Some(dir.as_path())).then_some(real)
}

/// Whether accounts other than this user, SYSTEM and Administrators may access
/// the file: OpenSSH for Windows then ignores it as a private key
/// ("UNPROTECTED PRIVATE KEY FILE"). None when its permissions cannot be read.
pub(crate) fn others_can_read(path: &Path) -> Option<bool> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{GetAce, ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    let me = current_user_sid().ok()?;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: the DACL points into `sd`, which is freed once it has been read;
    // each SID string is freed after it is copied.
    unsafe {
        let rc = GetNamedSecurityInfoW(wide.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), &mut dacl, std::ptr::null_mut(), &mut sd);
        if rc != 0 {
            return None;
        }
        // No DACL at all: everyone has full access.
        let mut open = dacl.is_null();
        let count = if dacl.is_null() { 0 } else { (*dacl).AceCount };
        for i in 0..u32::from(count) {
            let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
            if GetAce(dacl, i, &mut ace) == 0 {
                continue;
            }
            let allowed = ace as *const ACCESS_ALLOWED_ACE;
            if (*allowed).Header.AceType != ACCESS_ALLOWED_ACE_TYPE || (*allowed).Mask == 0 {
                continue;
            }
            let sid = std::ptr::addr_of!((*allowed).SidStart) as *mut core::ffi::c_void;
            let mut text: windows_sys::core::PWSTR = std::ptr::null_mut();
            if ConvertSidToStringSidW(sid, &mut text) == 0 {
                continue;
            }
            let len = (0..).take_while(|&n| *text.add(n) != 0).count();
            let name = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
            LocalFree(text as _);
            if name != me && name != "S-1-5-18" && name != "S-1-5-32-544" {
                open = true;
                break;
            }
        }
        LocalFree(sd as _);
        Some(open)
    }
}

/// Make the file's permissions full control for the current user and nothing
/// else: no inherited entries, and no explicit ones left from before (a key
/// copied from another program's folder may carry its own grants), which is
/// what OpenSSH for Windows requires of a private key.
fn restrict_to_owner(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{GetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};
    let fail = |what: String| format!("키 파일 권한을 설정할 수 없습니다: {what}");
    // By SID: a bare %USERNAME% can resolve to a different (local vs. domain)
    // account with the same name. "P": not inherited from the folder.
    let sid = current_user_sid()?;
    let sddl: Vec<u16> = format!("D:P(A;;FA;;;{sid})").encode_utf16().chain([0]).collect();
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: valid NUL-terminated strings; `sd` is freed with LocalFree below,
    // and the DACL pointer only borrows from it until then.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) == 0 {
            return Err(fail(std::io::Error::last_os_error().to_string()));
        }
        let (mut present, mut defaulted) = (0, 0);
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let read = GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted);
        let rc = if read == 0 || present == 0 {
            None
        } else {
            Some(SetNamedSecurityInfoW(wide.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), dacl, std::ptr::null()))
        };
        LocalFree(sd as _);
        match rc {
            None => Err(fail("DACL".into())),
            Some(0) => Ok(()),
            Some(code) => Err(fail(std::io::Error::from_raw_os_error(code as i32).to_string())),
        }
    }
}

/// A Windows tool by absolute path, so a same-named program earlier on PATH
/// (e.g. Git's coreutils `whoami`) is never picked up.
fn system32(exe: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join(exe)
}

/// SID of the account this process runs as. Read once (it cannot change while
/// the app runs): each key file check needs it, and `whoami` takes ~20 ms.
fn current_user_sid() -> Result<String, String> {
    static SID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    if let Some(sid) = SID.get() {
        return Ok(sid.clone());
    }
    // A failure is not kept: the next call tries again.
    let sid = read_user_sid()?;
    Ok(SID.get_or_init(|| sid).clone())
}

/// The SID from `whoami /user`.
fn read_user_sid() -> Result<String, String> {
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
pub(crate) mod tests {
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

    // PuTTY's example keys from the ssh-key crate's tests (the second one's
    // passphrase is "123").
    pub(crate) const PPK: &str = "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: user@example.com\nPublic-Lines: 2\nAAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XF\nSqti\nPrivate-Lines: 1\nAAAAILYGwiLRDBba4WxwpNRRc0cuxhfgXGVpINJuVsCPtZHt\nPrivate-MAC: 94140d0344fad6aa1bf7b71e9c93db11ccac8a232f8a51e11c024869d608c82d\n";
    const PPK_ENC: &str = "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: aes256-cbc\nComment: user@example.com\nPublic-Lines: 2\nAAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XF\nSqti\nKey-Derivation: Argon2id\nArgon2-Memory: 8192\nArgon2-Passes: 34\nArgon2-Parallelism: 1\nArgon2-Salt: 63d1d43f7bf7700720496646a2f5ec17\nPrivate-Lines: 1\nDyWtExZ3dxFutnb12tIwXBC6kWdozrvP+r6faHKBGDb4+qEar9XBiC0BmGySMHUi\nPrivate-MAC: 52fd00d4ef47ebc506e4e709486c0c6bc0606e24fe2c6cb1b3d168f4da238a66\n";
    pub(crate) const PPK_PUBLIC: &str = "AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti";

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bx-keys-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn key_files_are_told_apart_by_their_first_lines() {
        let dir = scratch("kinds");
        let kind = |name: &str, text: &str| {
            let p = dir.join(name);
            fs::write(&p, text).unwrap();
            key_file_kind(&p)
        };
        assert_eq!(kind("a", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n"), KeyFileKind::OpenSsh);
        assert_eq!(kind("b", "\u{feff}-----BEGIN RSA PRIVATE KEY-----\r\nMIIE\r\n"), KeyFileKind::OpenSsh);
        assert_eq!(kind("c", PPK), KeyFileKind::Putty { encrypted: false });
        assert_eq!(kind("d", PPK_ENC), KeyFileKind::Putty { encrypted: true });
        assert_eq!(kind("e", "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nSubject: me\nP2/56wAAA\n"), KeyFileKind::Foreign);
        assert_eq!(kind("f", "---- BEGIN SSH2 PUBLIC KEY ----\nAAAAB3\n"), KeyFileKind::Public);
        assert_eq!(kind("g", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA me@pc\n"), KeyFileKind::Public);
        assert_eq!(kind("h", "not a key"), KeyFileKind::Unknown);
        assert_eq!(key_file_kind(&dir.join("absent")), KeyFileKind::Missing);
        // A folder is not a key file.
        assert_eq!(key_file_kind(&dir), KeyFileKind::Missing);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn putty_keys_convert_to_a_protected_openssh_copy() {
        let dir = scratch("putty");
        let ppk = dir.join("web.ppk");
        fs::write(&ppk, PPK).unwrap();
        let copies = dir.join("copies");
        let temp = convert_putty(&ppk, None, &copies).unwrap();
        let path = temp.path.clone();
        // OpenSSH format, unreadable without the one-time passphrase.
        assert!(fs::read_to_string(&path).unwrap().starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(russh::keys::load_secret_key(&path, None).is_err());
        let key = russh::keys::load_secret_key(&path, Some(&temp.passphrase)).unwrap();
        assert_eq!(key.public_key().to_openssh().unwrap().split_whitespace().nth(1), Some(PPK_PUBLIC));
        // The system OpenSSH (the terminal's ssh.exe) reads it with that passphrase.
        if let Ok(out) = std::process::Command::new("ssh-keygen").args(["-y", "-P", &temp.passphrase, "-f"]).arg(&path).output() {
            assert!(out.status.success(), "ssh-keygen: {}", String::from_utf8_lossy(&out.stderr));
            assert_eq!(String::from_utf8_lossy(&out.stdout).split_whitespace().nth(1), Some(PPK_PUBLIC));
        }
        // Gone with the session.
        drop(temp);
        assert!(!path.exists());

        // An encrypted one needs its passphrase.
        let enc = dir.join("enc.ppk");
        fs::write(&enc, PPK_ENC).unwrap();
        assert!(convert_putty(&enc, None, &copies).is_err());
        assert!(convert_putty(&enc, Some("wrong"), &copies).is_err());
        let temp = convert_putty(&enc, Some("123"), &copies).unwrap();
        let key = russh::keys::load_secret_key(&temp.path, Some(&temp.passphrase)).unwrap();
        assert_eq!(key.public_key().to_openssh().unwrap().split_whitespace().nth(1), Some(PPK_PUBLIC));
        drop(temp);
        let _ = fs::remove_dir_all(dir);
    }

    /// A key other accounts can read is refused by the system OpenSSH, and
    /// accepted once it is restricted to this user.
    #[test]
    fn an_unprotected_key_is_accepted_after_restricting_it() {
        let dir = scratch("protect");
        let path = dir.join("id_open");
        let key = PrivateKey::random(&mut rand::rngs::ThreadRng::default(), Algorithm::Ed25519).unwrap();
        fs::write(&path, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
        // Everyone (S-1-1-0) may read it.
        let granted = std::process::Command::new(system32("icacls.exe")).arg(&path).args(["/grant", "*S-1-1-0:R"]).output().unwrap();
        assert!(granted.status.success());
        assert_eq!(others_can_read(&path), Some(true), "Everyone may read it");
        // Windows OpenSSH (what the terminal runs), not another ssh-keygen on PATH
        // (Git's ignores Windows permissions).
        let keygen = system32("OpenSSH").join("ssh-keygen.exe");
        let Ok(before) = std::process::Command::new(&keygen).args(["-y", "-f"]).arg(&path).output() else {
            return; // no OpenSSH client here
        };
        assert!(!before.status.success(), "accepted while others can read it");
        assert!(String::from_utf8_lossy(&before.stderr).contains("UNPROTECTED"), "{}", String::from_utf8_lossy(&before.stderr));
        restrict_to_owner(&path).unwrap();
        assert_eq!(others_can_read(&path), Some(false), "only this user now");
        let after = std::process::Command::new(&keygen).args(["-y", "-f"]).arg(&path).output().unwrap();
        assert!(after.status.success(), "{}", String::from_utf8_lossy(&after.stderr));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn only_vault_keys_and_ssh_folder_keys_may_be_protected() {
        let dir = scratch("scope");
        let ssh = dir.join(".ssh");
        fs::create_dir_all(&ssh).unwrap();
        let (default_key, saved, other) = (ssh.join("id_ed25519"), dir.join("saved_key"), dir.join("elsewhere"));
        for p in [&default_key, &saved, &other] {
            fs::write(p, "-----BEGIN OPENSSH PRIVATE KEY-----\n").unwrap();
        }
        let known = vec![saved.to_string_lossy().replace('\\', "/")];
        let s = |p: &Path| p.to_string_lossy().into_owned();
        assert!(protectable_key(&s(&default_key), &known, Some(&ssh)).is_some(), "a default key in .ssh");
        assert!(protectable_key(&s(&saved), &known, Some(&ssh)).is_some(), "a saved key, written with /");
        assert!(protectable_key(&s(&other), &known, Some(&ssh)).is_none(), "any other file");
        // Out of .ssh through "..", or a subfolder of it.
        assert!(protectable_key(&format!(r"{}\..\elsewhere", s(&ssh)), &known, Some(&ssh)).is_none());
        fs::create_dir_all(ssh.join("sub")).unwrap();
        fs::write(ssh.join("sub").join("k"), "x").unwrap();
        assert!(protectable_key(&s(&ssh.join("sub").join("k")), &known, Some(&ssh)).is_none());
        assert!(protectable_key(&s(&dir.join("missing")), &known, Some(&ssh)).is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn encrypted_keys_are_recognised() {
        let dir = scratch("enc");
        let w = |name: &str, text: &str| {
            let p = dir.join(name);
            fs::write(&p, text).unwrap();
            p
        };
        assert!(key_is_encrypted(&w("ppk_enc", PPK_ENC)));
        assert!(!key_is_encrypted(&w("ppk", PPK)));
        let mut rng = rand::rngs::ThreadRng::default();
        let key = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
        assert!(!key_is_encrypted(&w("plain", &key.to_openssh(LineEnding::LF).unwrap())));
        assert!(key_is_encrypted(&w("locked", &key.encrypt(&mut rng, b"pw").unwrap().to_openssh(LineEnding::LF).unwrap())));
        assert!(key_is_encrypted(&w("pem", "-----BEGIN RSA PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
")));
        assert!(!key_is_encrypted(&dir.join("absent")));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn copies_left_behind_are_swept() {
        let dir = scratch("sweep");
        let old = dir.join("old.key");
        let new = dir.join("new.key");
        fs::write(&old, "x").unwrap();
        fs::write(&new, "x").unwrap();
        let file = fs::OpenOptions::new().write(true).open(&old).unwrap();
        file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(7200)).unwrap();
        drop(file);
        sweep_stale(&dir);
        assert!(!old.exists() && new.exists());
        let _ = fs::remove_dir_all(dir);
    }
}
