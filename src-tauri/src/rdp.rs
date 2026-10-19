// RDP sessions.
//
// Built-in (default): each session runs the bx-rdp helper process (IronRDP),
// which is kept in its own binary because its pinned crypto crates cannot share
// a build with russh, and so decoder faults cannot take the app down. The
// helper gets credentials over stdin, streams screen updates back on stdout,
// and receives input as JSON lines. Server certificates are pinned per host in
// rdp_known_hosts.json after the user confirms the fingerprint.
//
// Screen updates go to the page over a loopback WebSocket opened for the tab
// (token in the path, page origin only, one connection), with the page's
// acknowledgements coming back on it: no main-thread IPC round trip per frame.
//
// External: write a .rdp file and open it in the Windows client (mstsc). The
// password is entered in mstsc's own prompt, so no secret is written to disk.

use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::vault;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct Helper {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    host_key: String,
    pending_fingerprint: Mutex<Option<String>>,
    /// Serves the screen updates to the page.
    frames_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl Helper {
    fn send(&self, value: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().unwrap();
        writeln!(stdin, "{value}")
            .and_then(|_| stdin.flush())
            .map_err(|_| "RDP 세션이 이미 종료되었습니다".to_string())
    }
}

#[derive(Default)]
pub struct RdpState {
    sessions: Mutex<HashMap<String, Arc<Helper>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpOpen {
    pub id: String,
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub credential_id: Option<String>,
    /// Typed at connect time; never stored.
    #[serde(default)]
    pub password: Option<String>,
    pub width: u16,
    pub height: u16,
    /// Local display scale in percent (see the helper's Init.scale).
    #[serde(default)]
    pub scale: Option<u32>,
    /// Local port of an SSH gateway tunnel to the server; host/port still
    /// identify the server (certificate pin, TLS name).
    #[serde(default)]
    pub tunnel_port: Option<u16>,
    /// Share the clipboard with the server (session option, on by default).
    #[serde(default)]
    pub clipboard: Option<bool>,
}

fn known_hosts_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("rdp_known_hosts.json"))
}

/// Serialises read-modify-write of the pin store between tabs.
static KNOWN_LOCK: Mutex<()> = Mutex::new(());

/// Pinned fingerprints. A missing file is empty; an unreadable one is an error
/// (fail closed): treating it as empty would turn "certificate changed" into a
/// harmless-looking "first connection" prompt and drop every other pin on save.
fn load_known(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    let path = known_hosts_path(app)?;
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("저장된 RDP 인증서 목록({})이 손상되었습니다: {e}. 파일을 확인하거나 지운 다음 다시 연결하세요.", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(e) => Err(format!("저장된 RDP 인증서 목록을 읽을 수 없습니다: {e}")),
    }
}

fn helper_path() -> Result<PathBuf, String> {
    let dir = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .map(PathBuf::from)
        .unwrap_or_default();
    let path = dir.join("bx-rdp.exe");
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("내장 RDP 구성 요소(bx-rdp.exe)를 찾을 수 없습니다: {}", path.display()))
    }
}

/// Start a built-in RDP session. `events` receives JSON events (status, cert,
/// connected, pointer, error, closed, exit). Returns the WebSocket URL that
/// streams the screen updates (binary messages; the page sends one byte back
/// per update drawn).
#[tauri::command]
pub async fn rdp_open(app: AppHandle, req: RdpOpen, events: Channel<Value>) -> Result<String, String> {
    // Keyring access and process start-up stay off the UI thread.
    tauri::async_runtime::spawn_blocking(move || open_blocking(app, req, events))
        .await
        .map_err(|e| e.to_string())?
}

/// How long the page has to open the screen-update socket.
const FRAMES_ACCEPT: Duration = Duration::from_secs(20);

/// Serve one tab's screen updates: accept exactly one connection on `path`
/// from the app's page, send every update as a binary message, and pass the
/// page's acknowledgements to the helper. The socket closing ends the session.
#[allow(clippy::result_large_err)] // tungstenite fixes the handshake error type
async fn serve_frames(listener: std::net::TcpListener, path: String, mut frames: mpsc::Receiver<Vec<u8>>, helper: Arc<Helper>) {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return };
    // Until the page's own handshake passes (another local program connecting
    // first must not take the only slot), within the deadline.
    let deadline = tokio::time::Instant::now() + FRAMES_ACCEPT;
    let ws = loop {
        let Ok(Ok((stream, _))) = tokio::time::timeout_at(deadline, listener.accept()).await else { return };
        let _ = stream.set_nodelay(true);
        let check = |req: &tokio_tungstenite::tungstenite::handshake::server::Request, resp| crate::wsutil::check(req, &path).map(|()| resp);
        // Each attempt gets a short timeout: a silent connection from another
        // program must not hold the slot until the deadline.
        let attempt = (tokio::time::Instant::now() + Duration::from_secs(2)).min(deadline);
        if let Ok(Ok(ws)) = tokio::time::timeout_at(attempt, tokio_tungstenite::accept_hdr_async(stream, check)).await {
            break ws;
        }
    };
    drop(listener);
    let (mut tx, mut rx) = ws.split();
    loop {
        tokio::select! {
            frame = frames.recv() => match frame {
                Some(payload) => if tx.send(Message::Binary(payload)).await.is_err() { break },
                None => break,
            },
            msg = rx.next() => match msg {
                Some(Ok(Message::Binary(_))) => {
                    let _ = helper.send(&json!({ "cmd": "ack" }));
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                _ => break,
            },
        }
    }
    let _ = tx.close().await;
}

/// Upper bound for one helper message: a full 8192×8192 RGBA desktop split
/// into the helper's maximum number of disjoint regions, plus headers.
/// Anything larger means the stream is corrupt; allocating it could abort the app.
const MAX_MESSAGE: usize = 6 + 33 * 8 + 8192 * 8192 * 4;

fn open_blocking(app: AppHandle, req: RdpOpen, events: Channel<Value>) -> Result<String, String> {
    let cred = match req.credential_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => Some(vault::resolve(&app, id)?),
        None => None,
    };
    let username = if req.username.is_empty() {
        cred.as_ref().map(|c| c.username.clone()).unwrap_or_default()
    } else {
        req.username.clone()
    };
    let password = req
        .password
        .clone()
        .filter(|p| !p.is_empty())
        .or_else(|| cred.as_ref().and_then(|c| c.password.clone()));
    let (Some(password), false) = (password, username.is_empty()) else {
        return Err("NEED_CREDENTIALS".into());
    };

    let port = req.port.unwrap_or(3389);
    let host_key = format!("{}:{port}", req.host.to_lowercase());
    let trusted = load_known(&app)?.get(&host_key).cloned();

    let mut child = Command::new(helper_path()?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("내장 RDP 구성 요소를 시작할 수 없습니다: {e}"))?;
    // Never outlives the app, even when the app is killed mid-connect.
    crate::childjob::adopt(&child);
    let stdin = child.stdin.take().ok_or("RDP 입력 채널을 열 수 없습니다")?;
    let stdout = child.stdout.take().ok_or("RDP 출력 채널을 열 수 없습니다")?;
    let stderr = child.stderr.take().ok_or("RDP 오류 채널을 열 수 없습니다")?;

    // Keep the tail of the helper's stderr (panic messages) for the exit report.
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let tail = stderr_tail.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut chunk = [0u8; 4096];
        while let Ok(n) = reader.read(&mut chunk) {
            if n == 0 {
                break;
            }
            let mut t = tail.lock().unwrap();
            t.push_str(&String::from_utf8_lossy(&chunk[..n]));
            if t.len() > 4096 {
                let cut = t.len() - 4096;
                let at = t.char_indices().map(|(i, _)| i).find(|&i| i >= cut).unwrap_or(0);
                t.drain(..at);
            }
        }
    });

    let helper = Arc::new(Helper {
        stdin: Mutex::new(stdin),
        child: Mutex::new(child),
        host_key,
        pending_fingerprint: Mutex::new(None),
        frames_task: Mutex::new(None),
    });
    // The screen-update socket. A few updates may wait for the page to connect;
    // the helper never has more than two outstanding.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("화면 전송 채널을 열 수 없습니다: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let ws_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = crate::wsutil::random_token();
    let (frames, frames_rx) = mpsc::channel::<Vec<u8>>(4);
    let task = tauri::async_runtime::spawn(serve_frames(listener, format!("/{token}"), frames_rx, helper.clone()));
    *helper.frames_task.lock().unwrap() = Some(task);
    helper.send(&json!({
        "host": req.host,
        "port": port,
        "username": username,
        "password": password,
        "domain": req.domain,
        "width": req.width,
        "height": req.height,
        "scale": req.scale,
        "trustedFingerprint": trusted,
        "connectAddr": req.tunnel_port.map(|p| format!("127.0.0.1:{p}")),
        "clipboard": req.clipboard.unwrap_or(true),
    }))?;
    let replaced = app.state::<RdpState>().sessions.lock().unwrap().insert(req.id.clone(), helper.clone());
    if let Some(old) = replaced {
        stop(old);
    }

    // Relay the helper's output until it exits.
    let id = req.id.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::with_capacity(1 << 20, stdout);
        let mut header = [0u8; 5];
        let mut corrupt = false;
        while reader.read_exact(&mut header).is_ok() {
            let len = u32::from_le_bytes([header[1], header[2], header[3], header[4]]) as usize;
            if len > MAX_MESSAGE || !matches!(header[0], 1 | 2) {
                corrupt = true;
                let _ = helper.child.lock().unwrap().kill();
                break;
            }
            // Read straight into an uninitialised buffer (no zero-fill of a full screen).
            let mut payload = Vec::with_capacity(len);
            match (&mut reader).take(len as u64).read_to_end(&mut payload) {
                Ok(n) if n == len => {}
                _ => break,
            }
            match header[0] {
                1 => {
                    let Ok(event) = serde_json::from_slice::<Value>(&payload) else { continue };
                    if event["type"] == "cert" {
                        *helper.pending_fingerprint.lock().unwrap() = event["fingerprint"].as_str().map(String::from);
                    }
                    let _ = events.send(event);
                }
                2 => {
                    // Gone (tab closed, socket refused): updates are dropped.
                    let _ = frames.blocking_send(payload);
                }
                _ => {}
            }
        }
        // Poll instead of wait() so the child lock is never held while blocking
        // (rdp_close needs it to force-stop a lingering helper).
        let mut code = None;
        for _ in 0..100 {
            if let Ok(Some(status)) = helper.child.lock().unwrap().try_wait() {
                code = status.code();
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // Forget the session unless a newer helper already took over this id.
        {
            let state = app.state::<RdpState>();
            let mut sessions = state.sessions.lock().unwrap();
            if sessions.get(&id).is_some_and(|h| Arc::ptr_eq(h, &helper)) {
                sessions.remove(&id);
            }
        }
        let detail = if corrupt {
            "RDP 구성 요소가 잘못된 데이터를 보내 연결을 종료했습니다".to_string()
        } else if code.is_some_and(|c| c != 0) {
            stderr_tail.lock().unwrap().trim().to_string()
        } else {
            String::new()
        };
        let _ = events.send(json!({ "type": "exit", "code": code, "id": id, "detail": detail }));
    });
    Ok(format!("ws://127.0.0.1:{ws_port}/{token}"))
}

/// Ask a helper to disconnect, force-stopping it if it lingers.
fn stop(h: Arc<Helper>) {
    if let Some(task) = h.frames_task.lock().unwrap().take() {
        task.abort();
    }
    let _ = h.send(&json!({ "cmd": "close" }));
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        let _ = h.child.lock().unwrap().kill();
    });
}

fn helper(state: &RdpState, id: &str) -> Result<Arc<Helper>, String> {
    state
        .sessions
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| "RDP 세션을 찾을 수 없습니다".to_string())
}

/// Answer a certificate prompt. Accepting pins the fingerprint for this host.
#[tauri::command]
pub fn rdp_cert(app: AppHandle, state: State<RdpState>, id: String, accept: bool) -> Result<(), String> {
    let h = helper(&state, &id)?;
    // Accepting means pinning: if the pin cannot be saved, the helper is told
    // "no" (it must never be left waiting), and the error is reported.
    let saved = match h.pending_fingerprint.lock().unwrap().take() {
        Some(fp) if accept => pin(&app, &h.host_key, fp),
        _ => Ok(()),
    };
    h.send(&json!({ "cmd": "cert", "accept": accept && saved.is_ok() }))?;
    saved
}

fn pin(app: &AppHandle, host_key: &str, fingerprint: String) -> Result<(), String> {
    let _guard = KNOWN_LOCK.lock().unwrap();
    let mut known = load_known(app)?;
    known.insert(host_key.to_string(), fingerprint);
    let text = serde_json::to_string_pretty(&known).map_err(|e| e.to_string())?;
    crate::store::write_atomic(&known_hosts_path(app)?, text.as_bytes()).map_err(|e| format!("인증서 정보를 저장할 수 없습니다: {e}"))
}

/// Forward a batch of input operations (keys, mouse, wheel) to the session.
#[tauri::command]
pub fn rdp_input(state: State<RdpState>, id: String, ops: Vec<Value>) -> Result<(), String> {
    helper(&state, &id)?.send(&json!({ "cmd": "input", "ops": ops }))
}

/// The tab went off screen or came back: no screen updates while hidden.
#[tauri::command]
pub fn rdp_visible(state: State<RdpState>, id: String, visible: bool) -> Result<(), String> {
    helper(&state, &id)?.send(&json!({ "cmd": "visible", "visible": visible }))
}

#[tauri::command]
pub fn rdp_resize(state: State<RdpState>, id: String, width: u32, height: u32, scale: Option<u32>) -> Result<(), String> {
    helper(&state, &id)?.send(&json!({ "cmd": "resize", "width": width, "height": height, "scale": scale }))
}

/// Disconnect gracefully; the helper is force-stopped if it lingers.
#[tauri::command]
pub fn rdp_close(state: State<RdpState>, id: String) {
    if let Some(h) = state.sessions.lock().unwrap().remove(&id) {
        stop(h);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpRequest {
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub credential_id: Option<String>,
    #[serde(default)]
    pub fullscreen: bool,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub multimon: bool,
    #[serde(default = "yes")]
    pub clipboard: bool,
    #[serde(default)]
    pub drives: bool,
}

fn yes() -> bool {
    true
}

#[tauri::command]
pub async fn rdp_launch(app: AppHandle, req: RdpRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || launch_blocking(app, req))
        .await
        .map_err(|e| e.to_string())?
}

fn launch_blocking(app: AppHandle, req: RdpRequest) -> Result<(), String> {
    let username = if req.username.is_empty() {
        match req.credential_id.as_deref().filter(|s| !s.is_empty()) {
            Some(id) => vault::resolve(&app, id)?.username,
            None => String::new(),
        }
    } else {
        req.username.clone()
    };

    // Values are written as lines of the .rdp file; a line break would inject settings.
    if [&req.host, &username, &req.name].iter().any(|v| v.chars().any(char::is_control)) || req.host.is_empty() {
        return Err("호스트·사용자 이름에 사용할 수 없는 문자가 있습니다".into());
    }
    // An IPv6 literal needs brackets once a port is appended.
    let host = if req.host.contains(':') && !req.host.starts_with('[') { format!("[{}]", req.host) } else { req.host.clone() };
    let address = match req.port {
        Some(p) if p != 3389 => format!("{host}:{p}"),
        _ => host,
    };
    let mut lines = vec![
        format!("full address:s:{address}"),
        format!("screen mode id:i:{}", if req.fullscreen { 2 } else { 1 }),
        format!("use multimon:i:{}", u8::from(req.multimon)),
        format!("redirectclipboard:i:{}", u8::from(req.clipboard)),
        "prompt for credentials:i:0".into(),
        "authentication level:i:2".into(),
        "smart sizing:i:1".into(),
    ];
    if let (Some(w), Some(h)) = (req.width, req.height) {
        lines.push(format!("desktopwidth:i:{w}"));
        lines.push(format!("desktopheight:i:{h}"));
    }
    if req.drives {
        lines.push("drivestoredirect:s:*".into());
    }
    if !username.is_empty() {
        lines.push(format!("username:s:{username}"));
    }

    let dir = std::env::temp_dir().join("BananaConn");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = req
        .name
        .chars()
        .map(|c| if c.is_alphanumeric() || "-_".contains(c) { c } else { '_' })
        .collect();
    let file = dir.join(format!("{safe}.rdp"));
    fs::write(&file, lines.join("\r\n")).map_err(|e| format!("RDP 연결 파일을 만들 수 없습니다: {e}"))?;

    Command::new("mstsc")
        .arg(&file)
        .spawn()
        .map_err(|e| format!("원격 데스크톱 클라이언트(mstsc)를 실행할 수 없습니다: {e}"))?;
    Ok(())
}
