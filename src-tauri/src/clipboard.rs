// A secret (a password) put on the clipboard without Windows keeping it:
// marked with the formats Windows documents for this ("Cloud Clipboard and
// Clipboard History Formats"), it is left out of the clipboard history
// (Win+V), not synced to other devices by the cloud clipboard, and skipped
// by clipboard monitors. The clipboard plugin writes plain text only.

use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

const CF_UNICODETEXT: u32 = 13;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A movable global block holding `bytes`, for SetClipboardData.
fn global_copy(bytes: &[u8]) -> Result<HGLOBAL, String> {
    // SAFETY: a fresh block of at least `bytes.len()` bytes (one byte for an
    // empty slice), locked while it is written and unlocked after.
    unsafe {
        let mem = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1));
        if mem.is_null() {
            return Err("클립보드에 쓸 메모리를 얻지 못했습니다".into());
        }
        let p = GlobalLock(mem) as *mut u8;
        if p.is_null() {
            GlobalFree(mem);
            return Err("클립보드에 쓸 메모리를 얻지 못했습니다".into());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        GlobalUnlock(mem);
        Ok(mem)
    }
}

/// Put one format on the open clipboard; the block is the system's once set.
fn set(format: u32, bytes: &[u8]) -> Result<(), String> {
    let mem = global_copy(bytes)?;
    // SAFETY: the clipboard is open and emptied by this window; on failure
    // the block is still ours to free.
    unsafe {
        if SetClipboardData(format, mem as HANDLE).is_null() {
            GlobalFree(mem);
            return Err("클립보드에 쓰지 못했습니다".into());
        }
    }
    Ok(())
}

/// The text, plus the three marks, on the clipboard. The window must own the
/// clipboard (OpenClipboard with a window): with none, EmptyClipboard leaves
/// no owner and SetClipboardData fails.
fn write_private(hwnd: HWND, text: &str) -> Result<(), String> {
    // Another program may hold the clipboard for a moment: a few short tries.
    let mut opened = false;
    for _ in 0..10 {
        // SAFETY: a window handle of this process.
        if unsafe { OpenClipboard(hwnd) } != 0 {
            opened = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    if !opened {
        return Err("다른 프로그램이 클립보드를 사용 중입니다".into());
    }
    let result = (|| {
        // SAFETY: the clipboard is open by this window.
        if unsafe { EmptyClipboard() } == 0 {
            return Err("클립보드에 쓰지 못했습니다".to_string());
        }
        let text: Vec<u8> = wide(text).iter().flat_map(|u| u.to_le_bytes()).collect();
        set(CF_UNICODETEXT, &text)?;
        // A DWORD 0: "not in the history", "not to the cloud"; any data
        // in the exclusion format keeps monitors away.
        let zero = 0u32.to_le_bytes();
        for name in ["ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"] {
            let w = wide(name);
            // SAFETY: a NUL-terminated UTF-16 name.
            let format = unsafe { RegisterClipboardFormatW(w.as_ptr()) };
            if format == 0 {
                return Err("클립보드에 쓰지 못했습니다".to_string());
            }
            set(format, &zero)?;
        }
        Ok(())
    })();
    // SAFETY: opened above. On a failure the clipboard is emptied before it
    // is closed: the secret is never left there without its marks (Windows
    // records the content when the clipboard closes).
    unsafe {
        if result.is_err() {
            EmptyClipboard();
        }
        CloseClipboard();
    }
    result
}

/// Copy a secret (a generated password) so that Windows does not keep it in
/// the clipboard history or sync it. Synchronous: runs on the main thread,
/// whose window owns the clipboard while it is written.
#[tauri::command]
pub fn clipboard_write_private(window: tauri::WebviewWindow, text: String) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    write_private(hwnd.0, &text)
}
