// Session store: the user's saved connections, persisted as JSON in the app
// config directory. The frontend owns the session schema; the backend stores
// the list as-is.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("설정 폴더를 찾을 수 없습니다: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("설정 폴더를 만들 수 없습니다: {e}"))?;
    Ok(dir.join("sessions.json"))
}

/// Replace `path` with `bytes` without ever leaving a partial file: write a
/// temp file, flush it to disk, then rename it over the original.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    // Its own temp file per write: two writers never truncate each other's.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("{}-{n}.tmp", std::process::id()));
    let mut f = fs::File::create(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[tauri::command]
pub fn sessions_load(app: AppHandle) -> Result<Vec<Value>, String> {
    let path = store_path(&app)?;
    read_sessions(&path).map_err(|e| keep_aside(&path, e))
}

/// A missing file is an empty list; anything unreadable is an error.
fn read_sessions(path: &Path) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    fs::read_to_string(path)
        .map_err(|e| format!("세션 목록을 읽을 수 없습니다: {e}"))
        .and_then(|text| serde_json::from_str::<Vec<Value>>(&text).map_err(|e| format!("세션 목록 형식이 올바르지 않습니다: {e}")))
}

/// Copy an unreadable session file aside (once per distinct content), so a
/// later save can never destroy the only copy.
fn keep_aside(path: &Path, err: String) -> String {
    let Ok(bytes) = fs::read(path) else { return err };
    let prefix = format!("{}.bad-", path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default());
    let dir = path.parent().unwrap_or(Path::new("."));
    let existing = fs::read_dir(dir).into_iter().flatten().flatten().find(|e| {
        e.file_name().to_string_lossy().starts_with(&prefix) && fs::read(e.path()).is_ok_and(|b| b == bytes)
    });
    let aside = match existing {
        Some(e) => e.path(),
        None => {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let aside = dir.join(format!("{prefix}{stamp}"));
            if fs::write(&aside, &bytes).is_err() {
                return err;
            }
            aside
        }
    };
    format!("{err}. 원본을 {} 에 보관했습니다.", aside.display())
}

/// Credential ids used by saved VNC sessions: the only ones whose password
/// may be handed to the frontend (noVNC does the RFB authentication there).
pub(crate) fn vnc_credential_ids(app: &AppHandle) -> Vec<String> {
    let Ok(sessions) = store_path(app).and_then(|p| read_sessions(&p)) else { return Vec::new() };
    sessions
        .iter()
        .filter(|s| s.get("protocol").and_then(Value::as_str) == Some("vnc"))
        .filter_map(|s| s.get("credentialId").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// Read a text file chosen by the user for import (JSON backups, other tools' files).
/// Accepts UTF-8 (with or without BOM), UTF-16 LE with BOM, and the system ANSI
/// code page (INI files of other tools are often CP949 on Korean Windows).
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(&path).map_err(|e| format!("파일을 읽을 수 없습니다: {e}"))?;
        if bytes.len() > 20 * 1024 * 1024 {
            return Err("파일이 너무 큽니다 (20MB 이하)".into());
        }
        Ok(decode_text(&bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn decode_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    // Korean INI files are CP949 even when this PC's ANSI code page
    // is something else (CP1252 decodes those bytes "successfully" as mojibake),
    // so try strict CP949 first and keep it only if it yields Hangul.
    if let Some(text) = decode_code_page(949, bytes, true)
        && text.chars().any(|c| ('\u{AC00}'..='\u{D7A3}').contains(&c)) {
            return text;
        }
    use windows_sys::Win32::Globalization::CP_ACP;
    decode_code_page(CP_ACP, bytes, false).unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
}

/// Decode bytes in a Windows code page. `strict` fails on any invalid sequence.
pub(crate) fn decode_code_page(code_page: u32, bytes: &[u8], strict: bool) -> Option<String> {
    use windows_sys::Win32::Globalization::{MB_ERR_INVALID_CHARS, MultiByteToWideChar};
    let len = i32::try_from(bytes.len()).ok()?;
    if len == 0 {
        return Some(String::new());
    }
    let flags = if strict { MB_ERR_INVALID_CHARS } else { 0 };
    // SAFETY: buffers and lengths come from live slices sized by the first call.
    unsafe {
        let n = MultiByteToWideChar(code_page, flags, bytes.as_ptr(), len, std::ptr::null_mut(), 0);
        if n <= 0 {
            return None;
        }
        let mut wide = vec![0u16; n as usize];
        let written = MultiByteToWideChar(code_page, flags, bytes.as_ptr(), len, wide.as_mut_ptr(), n);
        (written > 0).then(|| String::from_utf16_lossy(&wide[..written as usize]))
    }
}

#[cfg(test)]
mod tests {
    use super::decode_text;

    #[test]
    fn decodes_utf8_utf16_and_cp949() {
        assert_eq!(decode_text("한글 세션".as_bytes()), "한글 세션");
        assert_eq!(decode_text(&[0xEF, 0xBB, 0xBF, b'a']), "a");
        assert_eq!(decode_text(&[0xFF, 0xFE, 0x5C, 0xD5, 0x00, 0xAE]), "한글");
        // "한글 세션" in CP949, whatever this PC's ANSI code page is.
        assert_eq!(decode_text(&[0xC7, 0xD1, 0xB1, 0xDB, 0x20, 0xBC, 0xBC, 0xBC, 0xC7]), "한글 세션");
    }
}

/// Off the main thread: the atomic write waits for the disk (fsync), and a
/// sync command would freeze the window meanwhile.
#[tauri::command]
pub async fn sessions_save(app: AppHandle, sessions: Vec<Value>) -> Result<(), String> {
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let text = serde_json::to_string_pretty(&sessions).map_err(|e| e.to_string())?;
        write_atomic(&path, text.as_bytes()).map_err(|e| format!("세션 목록을 저장할 수 없습니다: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
