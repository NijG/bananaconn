// Built-in TFTP and HTTP file servers, sharing one local folder.
//
// - TFTP (RFC 1350, with blksize/tsize options RFC 2347-2349): for network
//   devices backing up configs or loading firmware. Read-only unless uploads
//   are allowed.
// - HTTP: read-only GET/HEAD with folder listings, optional Basic auth.
//
// Every requested path is resolved inside the shared folder: absolute paths,
// drive letters, ".." and invalid Windows names are refused, and the final path
// is canonicalised and must still lie under the folder (links cannot escape).

use std::collections::HashMap;
use std::net::{SocketAddr, UdpSocket as StdUdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileServerConfig {
    /// "tftp" or "http"
    pub kind: String,
    pub root: String,
    pub port: u16,
    pub lan: bool,
    /// TFTP: refuse uploads (WRQ).
    #[serde(default = "yes")]
    pub read_only: bool,
    /// HTTP: Basic auth when both are set.
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileServerStatus {
    pub kind: String,
    pub root: String,
    pub port: u16,
    pub lan: bool,
    pub read_only: bool,
    pub auth: bool,
    pub addresses: Vec<String>,
}

struct Running {
    status: FileServerStatus,
    task: JoinHandle<()>,
    ctl: Control,
}

#[derive(Default)]
pub struct FileServersState {
    running: Mutex<HashMap<String, Running>>,
}

/// Events for the UI log: kind = started/stopped/download/upload/denied/error.
#[derive(Clone)]
struct Notify(Option<AppHandle>, &'static str);

impl Notify {
    fn emit(&self, kind: &str, peer: &str, detail: String) {
        if let Some(app) = &self.0 {
            let _ = app.emit("file-server-event", json!({ "server": self.1, "kind": kind, "user": peer, "detail": detail }));
        }
    }
}

// ---- path confinement ------------------------------------------------------------------

/// Resolve a client-supplied path inside `root` (already canonical). None if
/// it is absolute, climbs out, names a device, or (after resolving links)
/// ends up outside the folder.
pub(crate) fn resolve_in_root(root: &Path, request: &str, must_exist: bool) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    for part in request.split(['/', '\\']).filter(|p| !p.is_empty() && *p != ".") {
        crate::remote::local_component(part)?;
        path.push(part);
    }
    // A write needs a file name; "", "." or "/" would name the folder itself.
    if !must_exist && path == root {
        return None;
    }
    // Resolve links: the existing part of the path must stay under the root.
    let check = if must_exist { path.canonicalize().ok()? } else { path.parent()?.canonicalize().ok()?.join(path.file_name()?) };
    check.starts_with(root).then_some(check)
}

fn bind_addr(lan: bool, port: u16) -> String {
    if lan { format!("0.0.0.0:{port}") } else { format!("127.0.0.1:{port}") }
}

fn addresses(scheme: &str, port: u16, lan: bool) -> Vec<String> {
    let mut out = Vec::new();
    if lan
        && let Some(ip) = StdUdpSocket::bind("0.0.0.0:0")
            .and_then(|s| s.connect("192.0.2.1:9").map(|_| s))
            .and_then(|s| s.local_addr())
            .ok()
            .map(|a| a.ip())
            .filter(|ip| !ip.is_unspecified())
        {
            out.push(format!("{scheme}://{ip}:{port}"));
        }
    out.push(format!("{scheme}://127.0.0.1:{port}"));
    out
}

// ---- commands -----------------------------------------------------------------------------

#[tauri::command]
pub async fn file_server_start(app: AppHandle, state: State<'_, FileServersState>, config: FileServerConfig) -> Result<FileServerStatus, String> {
    let kind = config.kind.clone();
    if kind != "tftp" && kind != "http" {
        return Err("알 수 없는 서버 종류입니다".into());
    }
    if state.running.lock().unwrap().contains_key(&kind) {
        return Err(format!("{} 서버가 이미 실행 중입니다", kind.to_uppercase()));
    }
    let root = Path::new(&config.root)
        .canonicalize()
        .ok()
        .filter(|p| p.is_dir())
        .ok_or_else(|| "공유할 폴더가 없습니다. 폴더를 다시 선택하세요.".to_string())?;
    if config.port == 0 {
        return Err("포트 번호가 올바르지 않습니다".into());
    }
    let auth = !config.username.is_empty() || !config.password.is_empty();
    if kind == "http" && auth && (config.username.is_empty() || config.password.len() < 4) {
        return Err("사용자 이름과 4자 이상의 비밀번호를 함께 정하세요(인증을 쓰지 않으려면 둘 다 비우세요)".into());
    }
    let notify = Notify(Some(app.clone()), if kind == "tftp" { "tftp" } else { "http" });
    let ctl = Control::default();
    let task = start(&config, root.clone(), notify.clone(), ctl.clone()).await?;
    let status = FileServerStatus {
        kind: kind.clone(),
        root: root.to_string_lossy().trim_start_matches(r"\\?\").to_string(),
        port: config.port,
        lan: config.lan,
        read_only: kind == "http" || config.read_only,
        auth: kind == "http" && auth,
        addresses: addresses(&kind, config.port, config.lan),
    };
    state.running.lock().unwrap().insert(kind, Running { status: status.clone(), task, ctl });
    notify.emit("started", "", status.addresses.join(", "));
    Ok(status)
}

/// Bind and spawn the server; bind errors are reported here.
async fn start(config: &FileServerConfig, root: PathBuf, notify: Notify, ctl: Control) -> Result<JoinHandle<()>, String> {
    let addr = bind_addr(config.lan, config.port);
    let in_use = |e: std::io::Error| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!("포트 {}을(를) 이미 다른 프로그램이 사용 중입니다", config.port)
        } else {
            format!("포트 {}을(를) 열 수 없습니다: {e}", config.port)
        }
    };
    if config.kind == "tftp" {
        // Windows lets 0.0.0.0:p bind while 127.0.0.1:p is taken; probe loopback too.
        if config.lan {
            StdUdpSocket::bind(("127.0.0.1", config.port)).map_err(in_use)?;
        }
        let sock = UdpSocket::bind(&addr).await.map_err(in_use)?;
        let opts = TftpOptions { read_only: config.read_only, lan: config.lan };
        Ok(tauri::async_runtime::spawn(tftp_serve(sock, root, opts, notify, ctl)))
    } else {
        if config.lan {
            std::net::TcpListener::bind(("127.0.0.1", config.port)).map_err(in_use)?;
        }
        let listener = TcpListener::bind(&addr).await.map_err(in_use)?;
        let auth = (!config.username.is_empty()).then(|| {
            base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", config.username, config.password))
        });
        Ok(tauri::async_runtime::spawn(http_serve(listener, Arc::new(root), auth.map(Arc::new), notify, ctl)))
    }
}

#[tauri::command]
pub fn file_server_stop(app: AppHandle, state: State<FileServersState>, kind: String) {
    if let Some(r) = state.running.lock().unwrap().remove(&kind) {
        // Ends transfers already running too, not only the listener.
        r.ctl.stopped.store(true, Ordering::Relaxed);
        r.task.abort();
        Notify(Some(app), if kind == "tftp" { "tftp" } else { "http" }).emit("stopped", "", String::new());
    }
}

#[tauri::command]
pub fn file_server_status(state: State<FileServersState>) -> Vec<FileServerStatus> {
    state.running.lock().unwrap().values().map(|r| r.status.clone()).collect()
}

/// Number of transfers in progress, per server kind (for a confirmation on stop).
#[tauri::command]
pub fn file_server_active(state: State<FileServersState>, kind: String) -> u32 {
    state.running.lock().unwrap().get(&kind).map(|r| r.ctl.active.load(Ordering::Relaxed)).unwrap_or(0)
}

// ---- TFTP --------------------------------------------------------------------------------------

const RRQ: u16 = 1;
const WRQ: u16 = 2;
const DATA: u16 = 3;
const ACK: u16 = 4;
const ERROR: u16 = 5;
const OACK: u16 = 6;
const RETRIES: u32 = 5;
const TIMEOUT: Duration = Duration::from_secs(3);
/// Largest upload accepted over TFTP (firmware images are well below this).
const TFTP_MAX_UPLOAD: u64 = 1 << 30;
/// Transfers at once; more requests are answered "busy".
const TFTP_MAX_TRANSFERS: u32 = 16;

#[derive(Clone, Copy)]
struct TftpOptions {
    read_only: bool,
    lan: bool,
}

/// Shared by a server's transfers: stop flag and transfer count.
#[derive(Clone, Default)]
pub(crate) struct Control {
    stopped: Arc<AtomicBool>,
    active: Arc<AtomicU32>,
}

impl Control {
    fn stopped(&self) -> bool {
        self.stopped.load(Ordering::Relaxed)
    }
}

/// Holds one transfer slot; released however the transfer ends.
struct Slot(Arc<AtomicU32>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Take a slot if fewer than `max` are in use.
fn take_slot(active: &Arc<AtomicU32>, max: u32) -> Option<Slot> {
    active
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| (n < max).then_some(n + 1))
        .ok()
        .map(|_| Slot(active.clone()))
}

fn tftp_error(code: u16, msg: &str) -> Vec<u8> {
    let mut p = vec![0, ERROR as u8];
    p.extend_from_slice(&code.to_be_bytes());
    p.extend_from_slice(msg.as_bytes());
    p.push(0);
    p
}

struct Request {
    op: u16,
    file: String,
    mode: String,
    options: Vec<(String, String)>,
}

fn parse_request(buf: &[u8]) -> Option<Request> {
    if buf.len() < 4 {
        return None;
    }
    let op = u16::from_be_bytes([buf[0], buf[1]]);
    let mut fields = buf[2..].split(|b| *b == 0).map(|f| String::from_utf8_lossy(f).into_owned());
    let file = fields.next()?;
    let mode = fields.next()?.to_ascii_lowercase();
    let mut options = Vec::new();
    while let (Some(k), Some(v)) = (fields.next(), fields.next()) {
        if k.is_empty() {
            break;
        }
        options.push((k.to_ascii_lowercase(), v));
    }
    Some(Request { op, file, mode, options })
}

async fn tftp_serve(sock: UdpSocket, root: PathBuf, opts: TftpOptions, notify: Notify, ctl: Control) {
    let mut buf = vec![0u8; 1024];
    loop {
        let Ok((n, peer)) = sock.recv_from(&mut buf).await else { continue };
        let Some(req) = parse_request(&buf[..n]) else { continue };
        if req.op != RRQ && req.op != WRQ {
            let _ = sock.send_to(&tftp_error(4, "Illegal TFTP operation"), peer).await;
            continue;
        }
        let Some(slot) = take_slot(&ctl.active, TFTP_MAX_TRANSFERS) else {
            let _ = sock.send_to(&tftp_error(0, "Server busy, try again later"), peer).await;
            continue;
        };
        let (root, notify, ctl) = (root.clone(), notify.clone(), ctl.clone());
        tauri::async_runtime::spawn(async move {
            let _slot = slot;
            if let Err((kind, msg)) = tftp_transfer(req, peer, &root, opts, &notify, &ctl).await {
                notify.emit(kind, &peer.ip().to_string(), msg);
            }
        });
    }
}

/// One transfer on its own socket (the server's transfer ID).
async fn tftp_transfer(
    req: Request,
    peer: SocketAddr,
    root: &Path,
    opts: TftpOptions,
    notify: &Notify,
    ctl: &Control,
) -> Result<(), (&'static str, String)> {
    let ip = if opts.lan { "0.0.0.0" } else { "127.0.0.1" };
    let sock = UdpSocket::bind((ip, 0)).await.map_err(|e| ("error", e.to_string()))?;
    sock.connect(peer).await.map_err(|e| ("error", e.to_string()))?;
    let who = peer.ip().to_string();
    let deny = |code: u16, msg: &str, log: String| {
        let p = tftp_error(code, msg);
        let s = &sock;
        async move {
            let _ = s.send(&p).await;
            Err::<(), _>(("denied", log))
        }
    };
    if req.mode != "octet" && req.mode != "netascii" {
        return deny(0, "Only octet mode is supported", format!("{} (모드 {})", req.file, req.mode)).await;
    }
    let mut blksize: usize = 512;
    let mut oack: Vec<(String, String)> = Vec::new();
    for (k, v) in &req.options {
        match k.as_str() {
            "blksize" => {
                if let Ok(b) = v.parse::<usize>() {
                    blksize = b.clamp(8, 8192);
                    oack.push(("blksize".into(), blksize.to_string()));
                }
            }
            "tsize" => oack.push(("tsize".into(), v.clone())),
            _ => {}
        }
    }
    let t = Transfer { sock: &sock, blksize, ctl };

    if req.op == WRQ {
        if opts.read_only {
            return deny(2, "Server is read-only", format!("{} 올리기 거부 (읽기 전용)", req.file)).await;
        }
        let Some(path) = resolve_in_root(root, &req.file, false) else {
            return deny(2, "Access violation", format!("{} 경로 거부", req.file)).await;
        };
        let bytes = t.receive(&path, oack).await.map_err(|e| ("error", format!("{}: {e}", req.file)))?;
        notify.emit("upload", &who, format!("{} ({bytes} bytes)", req.file));
    } else {
        let Some(path) = resolve_in_root(root, &req.file, true).filter(|p| p.is_file()) else {
            return deny(1, "File not found", format!("{} 없음 또는 경로 거부", req.file)).await;
        };
        let mut file = tokio::fs::File::open(&path).await.map_err(|e| ("error", e.to_string()))?;
        let size = file.metadata().await.map_err(|e| ("error", e.to_string()))?.len();
        for o in oack.iter_mut() {
            if o.0 == "tsize" {
                o.1 = size.to_string();
            }
        }
        t.send(&mut file, oack).await.map_err(|e| ("error", format!("{}: {e}", req.file)))?;
        notify.emit("download", &who, format!("{} ({size} bytes)", req.file));
    }
    Ok(())
}

fn oack_packet(oack: &[(String, String)]) -> Vec<u8> {
    let mut p = vec![0, OACK as u8];
    for (k, v) in oack {
        p.extend_from_slice(k.as_bytes());
        p.push(0);
        p.extend_from_slice(v.as_bytes());
        p.push(0);
    }
    p
}

fn is_ack(p: &[u8], block: u16) -> bool {
    p.len() >= 4 && u16::from_be_bytes([p[0], p[1]]) == ACK && u16::from_be_bytes([p[2], p[3]]) == block
}

fn is_data(p: &[u8], block: u16) -> bool {
    p.len() >= 4 && u16::from_be_bytes([p[0], p[1]]) == DATA && u16::from_be_bytes([p[2], p[3]]) == block
}

struct Transfer<'a> {
    sock: &'a UdpSocket,
    blksize: usize,
    ctl: &'a Control,
}

impl Transfer<'_> {
    /// Send `packet` until a reply satisfying `accept` arrives (retransmitting on timeout).
    async fn exchange(&self, packet: &[u8], accept: impl Fn(&[u8]) -> bool) -> Result<Vec<u8>, String> {
        let mut buf = vec![0u8; self.blksize + 4];
        for _ in 0..RETRIES {
            if self.ctl.stopped() {
                let _ = self.sock.send(&tftp_error(0, "Server stopped")).await;
                return Err("서버를 중지해 전송을 끝냈습니다".into());
            }
            self.sock.send(packet).await.map_err(|e| e.to_string())?;
            let deadline = Instant::now() + TIMEOUT;
            while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                match tokio::time::timeout(left, self.sock.recv(&mut buf)).await {
                    Ok(Ok(n)) => {
                        let reply = &buf[..n];
                        if reply.len() >= 2 && u16::from_be_bytes([reply[0], reply[1]]) == ERROR {
                            let msg = String::from_utf8_lossy(reply.get(4..).unwrap_or_default()).trim_end_matches('\0').to_string();
                            return Err(format!("상대가 전송을 중단했습니다: {msg}"));
                        }
                        if accept(reply) {
                            return Ok(reply.to_vec());
                        }
                    }
                    Ok(Err(e)) => return Err(e.to_string()),
                    Err(_) => break,
                }
            }
        }
        Err("응답이 없어 전송을 중단했습니다".into())
    }

    /// Stream a file block by block (never the whole file in memory).
    async fn send(&self, file: &mut tokio::fs::File, oack: Vec<(String, String)>) -> Result<(), String> {
        if !oack.is_empty() {
            self.exchange(&oack_packet(&oack), |p| is_ack(p, 0)).await?;
        }
        let mut block: u16 = 1;
        let mut chunk = vec![0u8; self.blksize];
        loop {
            // Fill a whole block unless the file ends.
            let mut filled = 0;
            while filled < self.blksize {
                let n = file.read(&mut chunk[filled..]).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                filled += n;
            }
            let mut p = Vec::with_capacity(filled + 4);
            p.extend_from_slice(&[0, DATA as u8]);
            p.extend_from_slice(&block.to_be_bytes());
            p.extend_from_slice(&chunk[..filled]);
            self.exchange(&p, |r| is_ack(r, block)).await?;
            // A final block shorter than blksize (possibly empty) ends the transfer.
            if filled < self.blksize {
                return Ok(());
            }
            block = block.wrapping_add(1);
        }
    }

    /// Receive into a hidden temp file next to `path`, then move it into place.
    /// The final ACK goes out only once the file is saved, so the device learns
    /// whether its backup really landed. Returns the size.
    async fn receive(&self, path: &Path, oack: Vec<(String, String)>) -> Result<u64, String> {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let tag: u32 = rand::random();
        let tmp = path.with_file_name(format!(".{name}.{tag:08x}.bxpart"));
        let saved = match self.receive_into(&tmp, oack).await {
            Ok((size, last_ack)) => std::fs::rename(&tmp, path).map(|()| (size, last_ack)).map_err(|e| format!("저장할 수 없습니다: {e}")),
            Err(e) => Err(e),
        };
        match saved {
            Ok((size, last_ack)) => {
                let _ = self.sock.send(&last_ack).await;
                Ok(size)
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                let _ = self.sock.send(&tftp_error(3, "Could not save the file")).await;
                Err(e)
            }
        }
    }

    async fn receive_into(&self, tmp: &Path, oack: Vec<(String, String)>) -> Result<(u64, Vec<u8>), String> {
        let mut out = tokio::fs::File::create(tmp).await.map_err(|e| format!("파일을 만들 수 없습니다: {e}"))?;
        let mut reply = if oack.is_empty() { vec![0, ACK as u8, 0, 0] } else { oack_packet(&oack) };
        let mut block: u16 = 1;
        let mut size = 0u64;
        loop {
            let packet = self.exchange(&reply, |p| is_data(p, block)).await?;
            let payload = &packet[4..];
            size += payload.len() as u64;
            if size > TFTP_MAX_UPLOAD {
                return Err("1GB보다 커서 거부했습니다".into());
            }
            out.write_all(payload).await.map_err(|e| format!("쓰기 오류: {e}"))?;
            let mut ack = vec![0, ACK as u8];
            ack.extend_from_slice(&block.to_be_bytes());
            if payload.len() < self.blksize {
                out.sync_all().await.map_err(|e| format!("쓰기 오류: {e}"))?;
                return Ok((size, ack));
            }
            reply = ack;
            block = block.wrapping_add(1);
        }
    }
}

// ---- HTTP ----------------------------------------------------------------------------------------

const MAX_HTTP_CONNECTIONS: u32 = 64;

async fn http_serve(listener: TcpListener, root: Arc<PathBuf>, auth: Option<Arc<String>>, notify: Notify, ctl: Control) {
    loop {
        let Ok((stream, peer)) = listener.accept().await else { continue };
        // Counted before spawning, so a burst cannot get past the limit.
        let Some(slot) = take_slot(&ctl.active, MAX_HTTP_CONNECTIONS) else { continue };
        let (root, auth, notify, ctl) = (root.clone(), auth.clone(), notify.clone(), ctl.clone());
        tauri::async_runtime::spawn(async move {
            let _slot = slot;
            let _ = http_one(stream, peer, &root, auth.as_deref(), &notify, &ctl).await;
        });
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("txt" | "log" | "md" | "conf" | "cfg" | "ini" | "csv") => "text/plain; charset=utf-8",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

async fn respond(stream: &mut TcpStream, status: &str, extra: &str, body: &[u8], head_only: bool) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n{extra}\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    if !head_only {
        stream.write_all(body).await?;
    }
    stream.flush().await
}

async fn http_one(mut stream: TcpStream, peer: SocketAddr, root: &Path, auth: Option<&String>, notify: &Notify, ctl: &Control) -> std::io::Result<()> {
    // Read the request head (bounded in size and time).
    let mut head = Vec::new();
    let mut buf = [0u8; 4096];
    let read = tokio::time::timeout(Duration::from_secs(10), async {
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut buf).await?;
            if n == 0 || head.len() + n > 16 * 1024 {
                return Ok::<bool, std::io::Error>(false);
            }
            head.extend_from_slice(&buf[..n]);
        }
        Ok(true)
    })
    .await;
    if !matches!(read, Ok(Ok(true))) {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&head);
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let head_only = method == "HEAD";
    let who = peer.ip().to_string();
    if method != "GET" && !head_only {
        return respond(&mut stream, "405 Method Not Allowed", "Allow: GET, HEAD\r\n", b"", false).await;
    }
    if let Some(expected) = auth {
        let given = lines
            .filter_map(|l| l.split_once(':'))
            .find(|(k, _)| k.trim().eq_ignore_ascii_case("authorization"))
            .and_then(|(_, v)| v.trim().strip_prefix("Basic ").map(str::trim).map(str::to_string));
        if given.as_deref().map(|g| crate::ftpserver::same(g, expected)) != Some(true) {
            notify.emit("denied", &who, format!("{target} 인증 실패"));
            return respond(&mut stream, "401 Unauthorized", "WWW-Authenticate: Basic realm=\"BananaConn\", charset=\"UTF-8\"\r\n", b"401", head_only).await;
        }
    }
    let raw_path = target.split(['?', '#']).next().unwrap_or("/");
    let Some(decoded) = percent_decode(raw_path) else {
        return respond(&mut stream, "400 Bad Request", "", b"400", head_only).await;
    };
    let Some(path) = resolve_in_root(root, &decoded, true) else {
        notify.emit("denied", &who, format!("{decoded} 없음 또는 경로 거부"));
        return respond(&mut stream, "404 Not Found", "Content-Type: text/plain; charset=utf-8\r\n", "404 찾을 수 없습니다".as_bytes(), head_only).await;
    };
    if path.is_dir() {
        if !decoded.ends_with('/') {
            let loc = format!("Location: {}/\r\n", percent_encode(&decoded));
            return respond(&mut stream, "301 Moved Permanently", &loc, b"", head_only).await;
        }
        // Off the runtime threads: a big folder or a network share is slow.
        let dir = path.clone();
        let mut entries: Vec<(String, bool, u64)> = tauri::async_runtime::spawn_blocking(move || {
            Ok::<_, std::io::Error>(
                std::fs::read_dir(&dir)?
                    .flatten()
                    .filter_map(|e| {
                        let name = e.file_name().to_string_lossy().into_owned();
                        let meta = e.metadata().ok()?;
                        (!e.file_type().ok()?.is_symlink()).then_some((name, meta.is_dir(), meta.len()))
                    })
                    .collect(),
            )
        })
        .await
        .map_err(std::io::Error::other)??;
        entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase())));
        let title = html_escape(&decoded);
        let mut html = format!(
            "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>{title}</title>\
             <style>body{{font:14px system-ui,sans-serif;margin:24px;color:#222}}a{{text-decoration:none}}td{{padding:3px 14px 3px 0}}.s{{color:#888;text-align:right}}</style>\
             <h2>{title}</h2><table>"
        );
        if decoded != "/" {
            html.push_str("<tr><td><a href=\"../\">../</a></td><td></td></tr>");
        }
        for (name, dir, size) in entries {
            let href = percent_encode(&name) + if dir { "/" } else { "" };
            let label = html_escape(&name) + if dir { "/" } else { "" };
            let size = if dir { String::new() } else { size.to_string() };
            html.push_str(&format!("<tr><td><a href=\"{href}\">{label}</a></td><td class=s>{size}</td></tr>"));
        }
        html.push_str("</table><p style=color:#888>BananaConn</p>");
        return respond(
            &mut stream,
            "200 OK",
            "Content-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n",
            html.as_bytes(),
            head_only,
        )
        .await;
    }
    let mut file = tokio::fs::File::open(&path).await?;
    let len = file.metadata().await?.len();
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {len}\r\nContent-Type: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: sandbox\r\n\r\n",
        content_type(&path)
    );
    stream.write_all(headers.as_bytes()).await?;
    if !head_only {
        // Copy in chunks: a stalled client times out per chunk (not per file, so
        // big files on slow links finish), and a stopped server ends the copy.
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            if ctl.stopped() {
                return Ok(());
            }
            let n = file.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            tokio::time::timeout(Duration::from_secs(60), stream.write_all(&chunk[..n]))
                .await
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "client stalled"))??;
        }
        notify.emit("download", &who, format!("{decoded} ({len} bytes)"));
    }
    stream.flush().await
}

/// Start a server without Tauri (tests). Returns the task to abort.
#[cfg(test)]
pub(crate) async fn test_start(config: FileServerConfig) -> JoinHandle<()> {
    let root = Path::new(&config.root).canonicalize().unwrap();
    start(&config, root, Notify(None, "test"), Control::default()).await.unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside_the_root() {
        let dir = std::env::temp_dir().join(format!("bx-fs-root-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("a.txt"), "a").unwrap();
        let root = dir.canonicalize().unwrap();
        assert!(resolve_in_root(&root, "/sub/a.txt", true).is_some());
        assert!(resolve_in_root(&root, "sub\\a.txt", true).is_some());
        for bad in ["../x", "/../../Windows/win.ini", "..\\x", "C:\\Windows\\win.ini", "sub/../../x", "CON", "a:b", "sub/aux.txt"] {
            assert!(resolve_in_root(&root, bad, false).is_none(), "{bad}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_tftp_requests_with_options() {
        let mut p = vec![0, 1];
        p.extend_from_slice(b"cfg.txt\0octet\0blksize\x001428\0tsize\x000\0");
        let r = parse_request(&p).unwrap();
        assert_eq!((r.op, r.file.as_str(), r.mode.as_str()), (RRQ, "cfg.txt", "octet"));
        assert_eq!(r.options, vec![("blksize".into(), "1428".into()), ("tsize".into(), "0".into())]);
    }
}
