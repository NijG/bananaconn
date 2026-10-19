// Read-only access to other tools' session stores for the importers (the
// parsing itself happens in the frontend, src/importers.ts):
//
// - `import_scan`: session files under a folder (SecureCRT *.ini, Xshell
//   *.xsh, *.rdp), with their path relative to the folder (= folder tree),
// - `registry_export`: one allow-listed registry key (PuTTY, KiTTY, WinSCP)
//   as .reg text, read through reg.exe so nothing in the registry changes.

use std::fs;
use std::path::Path;

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
