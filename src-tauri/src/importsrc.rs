// Read-only access to other tools' session stores for the importers (the
// parsing itself happens in the frontend, src/importers.ts):
//
// - `import_scan`: session files under a folder (SecureCRT *.ini, Xshell
//   *.xsh, *.rdp), with their path relative to the folder (= folder tree),
// - `registry_export`: one allow-listed registry key (PuTTY, KiTTY, WinSCP)
//   as .reg text, read through reg.exe so nothing in the registry changes,
// - `import_check_keys`: where the key files a source names really are, and
//   whether the logins can use them.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Registry keys the importers may read.
const REGISTRY_KEYS: [&str; 3] = [
    r"HKCU\Software\SimonTatham\PuTTY\Sessions",
    r"HKCU\Software\9bis.com\KiTTY\Sessions",
    r"HKCU\Software\Martin Prikryl\WinSCP 2\Sessions",
];

const MAX_FILES: usize = 5000;
const MAX_DEPTH: usize = 12;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    /// Path relative to the scanned folder, '/' separated.
    pub rel: String,
    pub text: String,
}

fn walk(dir: &Path, rel: &str, ext: &str, depth: usize, out: &mut Vec<ScannedFile>) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        // Never follow links or junctions out of the chosen folder.
        let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if meta.is_dir() {
            walk(&entry.path(), &child, ext, depth + 1, out);
        } else if meta.is_file() && meta.len() <= MAX_FILE_BYTES && name.to_lowercase().ends_with(ext)
            && let Ok(bytes) = fs::read(entry.path()) {
                out.push(ScannedFile { rel: child, text: crate::store::decode_text(&bytes) });
            }
        if out.len() >= MAX_FILES {
            return;
        }
    }
}

/// Every `*.ext` file under `root` (texts decoded like read_text_file).
#[tauri::command]
pub async fn import_scan(root: String, ext: String) -> Result<Vec<ScannedFile>, String> {
    let ext = format!(".{}", ext.trim_start_matches('.').to_lowercase());
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&root);
        if !root.is_dir() {
            return Err(format!("폴더를 찾을 수 없습니다: {}", root.display()));
        }
        let mut out = Vec::new();
        walk(root, "", &ext, 0, &mut out);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyCheck {
    /// The path with its placeholders filled in.
    pub path: String,
    /// "openssh" (ssh.exe reads it), "putty" or "putty-encrypted" (the
    /// terminal converts it), "foreign" (SecureCRT's own format), "public",
    /// "unknown", "missing", or "store" (a key in the Windows certificate
    /// store, which is not a file).
    pub kind: &'static str,
}

/// The key files an import names, resolved and checked, in the same order.
/// `config_dir`: SecureCRT's configuration folder, for its key paths (the
/// default one when not given). Only the start of each file is read.
#[tauri::command]
pub async fn import_check_keys(paths: Vec<String>, config_dir: Option<String>) -> Result<Vec<KeyCheck>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = config_dir
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::config_dir().map(|d| d.join("VanDyke").join("Config")));
        paths.iter().take(MAX_FILES).map(|raw| check_key(raw, config.as_deref())).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

fn check_key(raw: &str, config: Option<&Path>) -> KeyCheck {
    let raw = raw.trim();
    // SecureCRT's "capi::rawkey::my": a key in the Windows certificate store.
    if raw.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("capi::")) {
        return KeyCheck { path: raw.to_string(), kind: "store" };
    }
    let path = resolve_key_path(raw, config, dirs::home_dir().as_deref(), dirs::document_dir().as_deref());
    use crate::vault::KeyFileKind as K;
    let kind = match crate::vault::key_file_kind(Path::new(&path)) {
        K::Missing => "missing",
        K::OpenSsh => "openssh",
        K::Putty { encrypted: false } => "putty",
        K::Putty { encrypted: true } => "putty-encrypted",
        K::Foreign => "foreign",
        K::Public => "public",
        K::Unknown => "unknown",
    };
    KeyCheck { path, kind }
}

/// A key path as another tool wrote it, made absolute: SecureCRT's
/// ${VDS_CONFIG_PATH} (its configuration folder), ${VDS_SSH_DATA_PATH} (the
/// .ssh folder) and ${VDS_USER_DATA_PATH} (Documents), OpenSSH's leading ~,
/// and %VARIABLE%s. Separators become Windows ones.
fn resolve_key_path(raw: &str, config: Option<&Path>, home: Option<&Path>, documents: Option<&Path>) -> String {
    let under = |dir: &Path, rest: &str| {
        let rest = rest.trim_start_matches(['/', '\\']).replace('/', "\\");
        if rest.is_empty() { dir.to_path_buf() } else { dir.join(rest) }.to_string_lossy().into_owned()
    };
    let ssh = home.map(|h| h.join(".ssh"));
    // ${VDS_USER_DATA_PATH} is taken as Documents, which no source confirms:
    // when the file is not there but is under the home folder, that one.
    if let Some(rest) = raw.strip_prefix("${VDS_USER_DATA_PATH}") {
        let found = [documents, home].into_iter().flatten().map(|d| under(d, rest)).find(|p| Path::new(p).exists());
        if let Some(p) = found.or_else(|| documents.map(|d| under(d, rest))) {
            return p;
        }
    }
    for (placeholder, dir) in [("${VDS_CONFIG_PATH}", config), ("${VDS_SSH_DATA_PATH}", ssh.as_deref())] {
        if let (Some(rest), Some(dir)) = (raw.strip_prefix(placeholder), dir) {
            return under(dir, rest);
        }
    }
    if let (Some(rest), Some(home)) = (raw.strip_prefix('~').filter(|r| r.is_empty() || r.starts_with(['/', '\\'])), home) {
        return under(home, rest);
    }
    expand_env(raw).replace('/', "\\")
}

/// `path` with each %NAME% of a set environment variable replaced by its value.
fn expand_env(path: &str) -> String {
    let mut out = String::new();
    let mut rest = path;
    while let Some(start) = rest.find('%') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else { break };
        match std::env::var(&after[..end]) {
            Ok(value) if end > 0 => {
                out.push_str(&rest[..start]);
                out.push_str(&value);
                rest = &after[end + 1..];
            }
            _ => {
                out.push_str(&rest[..=start]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Save a private key an import carries (SecureCRT's Export Settings holds the
/// key files its sessions name) in the .ssh folder, readable by this user
/// only, and return its path. `name`: the file name it had. A file already
/// there with the same contents is used as it is; another name is chosen
/// rather than overwriting a different file. Only a private key the logins can
/// use (OpenSSH, PEM, PuTTY) is saved.
#[tauri::command]
pub async fn import_store_key(name: String, contents: Vec<u8>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = dirs::home_dir().ok_or("홈 폴더를 찾을 수 없습니다")?.join(".ssh");
        store_key(&dir, &name, &contents).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn store_key(dir: &Path, name: &str, contents: &[u8]) -> Result<PathBuf, String> {
    use crate::vault::KeyFileKind as K;
    if contents.len() > 64 * 1024 || !matches!(crate::vault::key_kind_of(contents), K::OpenSsh | K::Putty { .. }) {
        return Err("가져온 파일에 든 키를 쓸 수 없습니다".into());
    }
    fs::create_dir_all(dir).map_err(|e| format!("폴더를 만들 수 없습니다: {e}"))?;
    // A plain file name, whatever the source wrote (no folders or odd characters).
    let clean: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || "._-".contains(*c)).collect();
    let clean = clean.trim_matches('.');
    let (stem, ext) = match clean.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (if clean.is_empty() { "imported_key".to_string() } else { clean.to_string() }, String::new()),
    };
    for n in 0..100 {
        let path = dir.join(if n == 0 { format!("{stem}{ext}") } else { format!("{stem}-{n}{ext}") });
        if path.exists() {
            if fs::read(&path).is_ok_and(|b| b == contents) {
                return Ok(path);
            }
            continue;
        }
        crate::vault::write_private(&path, contents)?;
        return Ok(path);
    }
    Err("키 파일 이름을 정할 수 없습니다".into())
}

/// An allow-listed registry key as .reg text; empty when the key is absent.
#[tauri::command]
pub async fn registry_export(key: String) -> Result<String, String> {
    if !REGISTRY_KEYS.contains(&key.as_str()) {
        return Err("읽을 수 없는 레지스트리 위치입니다".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use std::os::windows::process::CommandExt as _;
        // One file per export: PuTTY and KiTTY imports may run at the same time.
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let file = std::env::temp_dir().join(format!("bx-import-{}-{n}.reg", std::process::id()));
        let status = std::process::Command::new(r"C:\Windows\System32\reg.exe")
            .args(["export", &key])
            .arg(&file)
            .arg("/y")
            .creation_flags(0x0800_0000) // no console window
            .output()
            .map_err(|e| format!("reg.exe를 실행할 수 없습니다: {e}"))?;
        if !status.status.success() {
            let _ = fs::remove_file(&file);
            return Ok(String::new()); // the tool was never used on this PC
        }
        let bytes = fs::read(&file).map_err(|e| e.to_string());
        let _ = fs::remove_file(&file);
        Ok(crate::store::decode_text(&bytes?))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_paths_resolve_their_placeholders() {
        let (config, home, docs) = (Path::new(r"C:\Users\ops\AppData\Roaming\VanDyke\Config"), Path::new(r"C:\Users\ops"), Path::new(r"D:\Docs"));
        let r = |raw: &str| resolve_key_path(raw, Some(config), Some(home), Some(docs));
        assert_eq!(r(r"${VDS_CONFIG_PATH}\Keys\id_rsa"), r"C:\Users\ops\AppData\Roaming\VanDyke\Config\Keys\id_rsa");
        assert_eq!(r("${VDS_CONFIG_PATH}/Keys/id_rsa"), r"C:\Users\ops\AppData\Roaming\VanDyke\Config\Keys\id_rsa");
        assert_eq!(r(r"${VDS_SSH_DATA_PATH}\id_ed25519"), r"C:\Users\ops\.ssh\id_ed25519");
        assert_eq!(r(r"${VDS_USER_DATA_PATH}\keys\web.ppk"), r"D:\Docs\keys\web.ppk");
        assert_eq!(r("~/.ssh/id_ed25519"), r"C:\Users\ops\.ssh\id_ed25519");
        assert_eq!(r("~"), r"C:\Users\ops");
        // Only a leading "~" alone or before a separator is the home folder.
        assert_eq!(r("~ops/key"), r"~ops\key");
        assert_eq!(r("C:/keys/web.ppk"), r"C:\keys\web.ppk");
        assert_eq!(r(r"${OTHER}\key"), r"${OTHER}\key");
        let windir = std::env::var("windir").unwrap();
        assert_eq!(r(r"%windir%\key"), format!(r"{windir}\key"));
        assert_eq!(r(r"100% %NOT_SET_BX% x"), r"100% %NOT_SET_BX% x");
        // Without a configuration folder the placeholder stays (and the file is missing).
        assert_eq!(resolve_key_path(r"${VDS_CONFIG_PATH}\k", None, Some(home), Some(docs)), r"${VDS_CONFIG_PATH}\k");
    }

    #[test]
    fn key_checks_say_what_each_file_is() {
        let dir = std::env::temp_dir().join(format!("bx-import-keys-{}", std::process::id()));
        fs::create_dir_all(dir.join("Keys")).unwrap();
        fs::write(dir.join("Keys").join("id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n").unwrap();
        fs::write(dir.join("Identity"), "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nP2/56w\n").unwrap();
        fs::write(dir.join("web.ppk"), "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: aes256-cbc\n").unwrap();
        let check = |raw: &str| check_key(raw, Some(&dir));
        let found = check(r"${VDS_CONFIG_PATH}\Keys\id_rsa");
        assert_eq!((found.kind, found.path), ("openssh", dir.join("Keys").join("id_rsa").to_string_lossy().into_owned()));
        assert_eq!(check(r"${VDS_CONFIG_PATH}\Identity").kind, "foreign");
        assert_eq!(check(r"${VDS_CONFIG_PATH}\web.ppk").kind, "putty-encrypted");
        assert_eq!(check(r"${VDS_CONFIG_PATH}\nothing").kind, "missing");
        assert_eq!(check("capi::rawkey::my"), KeyCheck { path: "capi::rawkey::my".into(), kind: "store" });
        assert_eq!(check("CAPI::RawKey::My").kind, "store");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn carried_keys_are_saved_once_and_never_overwrite() {
        let dir = std::env::temp_dir().join(format!("bx-store-key-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let key = crate::vault::tests::PPK.as_bytes();
        let first = store_key(&dir, "web.ppk", key).unwrap();
        assert_eq!(first, dir.join("web.ppk"));
        // The same key again: the file already there.
        assert_eq!(store_key(&dir, "web.ppk", key).unwrap(), first);
        // Another key by that name: a name of its own, the first one untouched.
        let other = b"-----BEGIN OPENSSH PRIVATE KEY-----
b3Bl
";
        assert_eq!(store_key(&dir, "web.ppk", other).unwrap(), dir.join("web-1.ppk"));
        assert_eq!(fs::read(&first).unwrap(), key);
        // A path in the name is not followed; odd characters are dropped.
        assert_eq!(store_key(&dir, r"....evil key", other).unwrap().parent(), Some(dir.as_path()));
        // Not a usable private key.
        assert!(store_key(&dir, "pub", b"ssh-ed25519 AAAAC3 me").is_err());
        assert!(store_key(&dir, "crt", b"---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----").is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
