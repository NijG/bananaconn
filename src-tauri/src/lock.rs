// Master password: locks the app at start (and on demand / after idle time in
// the UI). While locked, stored secrets cannot be used: vault reads, saves and
// key generation are refused here in the backend, not only hidden in the UI.
//
// Only a PBKDF2-HMAC-SHA256 hash (random salt, 600 000 iterations) is stored,
// in master.json in the app config folder. Secrets themselves stay in the
// Windows Credential Manager.

use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use base64::Engine;
use ring::pbkdf2;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

const ITERATIONS: u32 = 600_000;
static ALG: pbkdf2::Algorithm = pbkdf2::PBKDF2_HMAC_SHA256;
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Serialize, Deserialize)]
struct Stored {
    salt: String,
    iterations: u32,
    hash: String,
}

pub struct LockState {
    unlocked: AtomicBool,
    failures: AtomicU32,
}

impl Default for LockState {
    fn default() -> Self {
        // Locked until checked: start() unlocks when no master password is set.
        Self { unlocked: AtomicBool::new(false), failures: AtomicU32::new(0) }
    }
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| format!("설정 폴더를 찾을 수 없습니다: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("설정 폴더를 만들 수 없습니다: {e}"))?;
    Ok(dir.join("master.json"))
}

/// The stored hash. A missing file means no master password; an unreadable one
/// is an error (it must not silently turn the lock off).
fn stored(app: &AppHandle) -> Result<Option<Stored>, String> {
    let p = path(app)?;
    match std::fs::read_to_string(&p) {
        Ok(t) => serde_json::from_str(&t).map(Some).map_err(|e| format!("마스터 비밀번호 파일이 손상되었습니다({}): {e}", p.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("마스터 비밀번호 파일을 읽을 수 없습니다: {e}")),
    }
}

fn hash(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2::derive(ALG, NonZeroU32::new(iterations).unwrap(), salt, password.as_bytes(), &mut out);
    out
}

fn verify(s: &Stored, password: &str) -> bool {
    let (Ok(salt), Ok(expected), Some(iters)) = (B64.decode(&s.salt), B64.decode(&s.hash), NonZeroU32::new(s.iterations)) else {
        return false;
    };
    pbkdf2::verify(ALG, iters, &salt, password.as_bytes(), &expected).is_ok()
}

/// Refuse when a master password is set and the app is locked.
pub fn require_unlocked(app: &AppHandle) -> Result<(), String> {
    if app.state::<LockState>().unlocked.load(Ordering::Relaxed) {
        Ok(())
    } else {
        Err("BananaConn이 잠겨 있습니다. 마스터 비밀번호로 잠금을 해제하세요.".into())
    }
}

/// Called once at startup: without a master password the app is unlocked.
pub fn init(app: &AppHandle) {
    let enabled = !matches!(stored(app), Ok(None));
    app.state::<LockState>().unlocked.store(!enabled, Ordering::Relaxed);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    enabled: bool,
    locked: bool,
}

#[tauri::command]
pub fn lock_status(app: AppHandle, state: State<LockState>) -> Result<LockStatus, String> {
    let enabled = stored(&app)?.is_some();
    Ok(LockStatus { enabled, locked: enabled && !state.unlocked.load(Ordering::Relaxed) })
}

#[tauri::command]
pub async fn lock_unlock(app: AppHandle, password: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<LockState>();
        let Some(s) = stored(&app)? else {
            state.unlocked.store(true, Ordering::Relaxed);
            return Ok(());
        };
        if verify(&s, &password) {
            state.failures.store(0, Ordering::Relaxed);
            state.unlocked.store(true, Ordering::Relaxed);
            return Ok(());
        }
        // Each failure waits longer (1 s, 2 s, 4 s ... up to 30 s).
        let n = state.failures.fetch_add(1, Ordering::Relaxed);
        std::thread::sleep(Duration::from_secs((1u64 << n.min(5)).min(30)));
        Err("마스터 비밀번호가 올바르지 않습니다".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn lock_lock(app: AppHandle, state: State<LockState>) -> Result<(), String> {
    if stored(&app)?.is_some() {
        state.unlocked.store(false, Ordering::Relaxed);
    }
    Ok(())
}

/// Set, change (`current` required) or remove (`new` = None) the master password.
#[tauri::command]
pub async fn lock_set(app: AppHandle, current: Option<String>, new: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(s) = stored(&app)?
            && !verify(&s, current.as_deref().unwrap_or("")) {
                std::thread::sleep(Duration::from_secs(1));
                return Err("현재 마스터 비밀번호가 올바르지 않습니다".into());
            }
        let p = path(&app)?;
        match new {
            None => {
                match std::fs::remove_file(&p) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(format!("마스터 비밀번호를 지울 수 없습니다: {e}")),
                }
                app.state::<LockState>().unlocked.store(true, Ordering::Relaxed);
            }
            Some(pw) => {
                if pw.chars().count() < 8 {
                    return Err("마스터 비밀번호는 8자 이상이어야 합니다".into());
                }
                let mut salt = [0u8; 16];
                SystemRandom::new().fill(&mut salt).map_err(|_| "난수를 만들 수 없습니다".to_string())?;
                let s = Stored { salt: B64.encode(salt), iterations: ITERATIONS, hash: B64.encode(hash(&pw, &salt, ITERATIONS)) };
                let text = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
                crate::store::write_atomic(&p, text.as_bytes()).map_err(|e| format!("마스터 비밀번호를 저장할 수 없습니다: {e}"))?;
                app.state::<LockState>().unlocked.store(true, Ordering::Relaxed);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_verify_only_the_right_password() {
        let salt = [7u8; 16];
        let s = Stored { salt: B64.encode(salt), iterations: 1000, hash: B64.encode(hash("correct horse", &salt, 1000)) };
        assert!(verify(&s, "correct horse"));
        assert!(!verify(&s, "correct horsE"));
        assert!(!verify(&s, ""));
        let broken = Stored { salt: "%%".into(), iterations: 0, hash: String::new() };
        assert!(!verify(&broken, "x"));
    }
}
