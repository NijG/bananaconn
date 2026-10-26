// Built-in FTP server: share one local folder over FTP (libunftp).
//
// - Sessions are confined to the shared folder by the cap-std based filesystem
//   backend (no `..` or symlink escapes).
// - A password is required unless anonymous access is explicitly enabled.
// - Repeated failed logins block the user/IP for a while.
// - "Read only" rejects every write operation at the storage layer.
// - Logins and file activity are reported to the UI as `ftp-server-event`.

use std::fmt::Debug;
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use async_trait::async_trait;
use libunftp::ServerBuilder;
use libunftp::notification::{DataEvent, DataListener, EventMeta, PresenceEvent, PresenceListener};
use libunftp::options::{FailedLoginsBlock, FailedLoginsPolicy, Shutdown};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncRead, ReadBuf};
use tokio::sync::{oneshot, watch};
use unftp_core::auth::{AuthenticationError, Authenticator, Credentials, DefaultUser, Principal};
use unftp_core::storage::{Error as StorageError, ErrorKind, Fileinfo, Metadata, Permissions, Result as StorageResult, StorageBackend};
use unftp_sbe_fs::{Filesystem, Meta};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub root: String,
    pub port: u16,
    /// Listen on all interfaces (LAN) instead of loopback only.
    pub lan: bool,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub anonymous: bool,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub root: String,
    pub port: u16,
    pub lan: bool,
    pub username: String,
    pub anonymous: bool,
    pub read_only: bool,
    pub addresses: Vec<String>,
    pub uptime_secs: u64,
}

struct Running {
    /// Generation, so a finished listener only clears its own entry.
    id: u64,
    config: ServerConfig,
    started: Instant,
    stop: Option<oneshot::Sender<()>>,
    /// Set on stop: storage refuses new work and running transfers fail.
    stopped: Arc<AtomicBool>,
    /// Becomes true once the listener has exited and released the port.
    finished: watch::Receiver<bool>,
}

#[derive(Default)]
pub struct FtpServerState {
    running: Mutex<Option<Running>>,
    next_id: AtomicU64,
}

// ---- storage: shared folder, optionally read-only ---------------------------------------

#[derive(Debug, Clone)]
struct SharedFolder {
    fs: Arc<Filesystem>,
    /// The shared folder with links resolved: a folder listed by the fast path
    /// must resolve to a place inside it.
    root: Arc<PathBuf>,
    read_only: bool,
    /// libunftp's shutdown closes control connections only; data transfers hold
    /// their own session and would keep running. This flag ends them.
    stopped: Arc<AtomicBool>,
}

/// An entry's metadata: from the sandboxed backend (single lookups) or from
/// one scan of a folder (listings).
pub enum EntryMeta {
    Sandboxed(Meta),
    Scanned { len: u64, dir: bool, modified: Option<SystemTime> },
}

impl Metadata for EntryMeta {
    fn len(&self) -> u64 {
        match self {
            Self::Sandboxed(m) => m.len(),
            Self::Scanned { len, .. } => *len,
        }
    }
    fn is_dir(&self) -> bool {
        match self {
            Self::Sandboxed(m) => m.is_dir(),
            Self::Scanned { dir, .. } => *dir,
        }
    }
    fn is_file(&self) -> bool {
        match self {
            Self::Sandboxed(m) => m.is_file(),
            Self::Scanned { dir, .. } => !dir,
        }
    }
    fn is_symlink(&self) -> bool {
        match self {
            Self::Sandboxed(m) => m.is_symlink(),
            Self::Scanned { .. } => false,
        }
    }
    fn modified(&self) -> StorageResult<SystemTime> {
        match self {
            Self::Sandboxed(m) => m.modified(),
            Self::Scanned { modified, .. } => modified.ok_or_else(|| StorageError::from(ErrorKind::LocalError)),
        }
    }
    fn gid(&self) -> u32 {
        match self {
            Self::Sandboxed(m) => m.gid(),
            Self::Scanned { .. } => 0,
        }
    }
    fn uid(&self) -> u32 {
        match self {
            Self::Sandboxed(m) => m.uid(),
            Self::Scanned { .. } => 0,
        }
    }
    fn links(&self) -> u64 {
        match self {
            Self::Sandboxed(m) => m.links(),
            Self::Scanned { .. } => 1,
        }
    }
    fn permissions(&self) -> Permissions {
        match self {
            Self::Sandboxed(m) => m.permissions(),
            Self::Scanned { .. } => Permissions(0o7755),
        }
    }
    fn readlink(&self) -> Option<&Path> {
        match self {
            Self::Sandboxed(m) => m.readlink(),
            Self::Scanned { .. } => None,
        }
    }
}

/// One scan of a folder inside `root`. The sandboxed backend looks up every
/// entry separately (about half a millisecond each on Windows: 5000 files took
/// 2.7 s); the scan already carries size, time and type. None when the folder
/// is not plainly inside the shared folder or holds links: the sandboxed
/// listing then decides (and reports errors) as before.
fn scan_folder(root: &Path, rel: &Path) -> Option<Vec<Fileinfo<PathBuf, EntryMeta>>> {
    use std::path::Component;
    let rel = rel.strip_prefix("/").unwrap_or(rel);
    if rel.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return None;
    }
    let dir = std::fs::canonicalize(root.join(rel)).ok()?;
    if !dir.starts_with(root) {
        return None;
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).ok()? {
        let entry = entry.ok()?;
        let meta = entry.metadata().ok()?;
        if meta.file_type().is_symlink() {
            return None;
        }
        out.push(Fileinfo {
            path: PathBuf::from(entry.file_name()),
            metadata: EntryMeta::Scanned { len: meta.len(), dir: meta.is_dir(), modified: meta.modified().ok() },
        });
    }
    Some(out)
}

impl SharedFolder {
    fn deny<T>(&self) -> StorageResult<T> {
        Err(StorageError::from(ErrorKind::PermissionDenied))
    }

    fn live(&self) -> StorageResult<()> {
        if self.stopped.load(Ordering::Relaxed) {
            Err(StorageError::from(ErrorKind::ConnectionClosed))
        } else {
            Ok(())
        }
    }

    fn writable(&self) -> StorageResult<()> {
        self.live()?;
        if self.read_only { self.deny() } else { Ok(()) }
    }
}

/// A transfer stream that fails as soon as the server is stopped.
struct StopRead<R> {
    inner: R,
    stopped: Arc<AtomicBool>,
}

impl<R: AsyncRead + Unpin> AsyncRead for StopRead<R> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        if self.stopped.load(Ordering::Relaxed) {
            return Poll::Ready(Err(std::io::Error::other("FTP 서버가 중지되었습니다")));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

#[async_trait]
impl StorageBackend<DefaultUser> for SharedFolder {
    type Metadata = EntryMeta;

    fn supported_features(&self) -> u32 {
        StorageBackend::<DefaultUser>::supported_features(self.fs.as_ref())
    }

    async fn metadata<P: AsRef<Path> + Send + Debug>(&self, user: &DefaultUser, path: P) -> StorageResult<Self::Metadata> {
        self.live()?;
        self.fs.metadata(user, path).await.map(EntryMeta::Sandboxed)
    }

    async fn list<P: AsRef<Path> + Send + Debug>(&self, user: &DefaultUser, path: P) -> StorageResult<Vec<Fileinfo<PathBuf, Self::Metadata>>>
    where
        <Self as StorageBackend<DefaultUser>>::Metadata: unftp_core::storage::Metadata,
    {
        self.live()?;
        let (root, rel) = (self.root.clone(), path.as_ref().to_path_buf());
        if let Ok(Some(list)) = tokio::task::spawn_blocking(move || scan_folder(&root, &rel)).await {
            return Ok(list);
        }
        let list = self.fs.list(user, path).await?;
        Ok(list.into_iter().map(|f| Fileinfo { path: f.path, metadata: EntryMeta::Sandboxed(f.metadata) }).collect())
    }

    async fn get<P: AsRef<Path> + Send + Debug>(&self, user: &DefaultUser, path: P, start_pos: u64) -> StorageResult<Box<dyn AsyncRead + Send + Sync + Unpin>> {
        self.live()?;
        let inner = self.fs.get(user, path, start_pos).await?;
        Ok(Box::new(StopRead { inner, stopped: self.stopped.clone() }))
    }

    async fn put<P: AsRef<Path> + Send + Debug, R: AsyncRead + Send + Sync + Unpin + 'static>(
        &self,
        user: &DefaultUser,
        input: R,
        path: P,
        start_pos: u64,
    ) -> StorageResult<u64> {
        self.writable()?;
        let input = StopRead { inner: input, stopped: self.stopped.clone() };
        self.fs.put(user, input, path, start_pos).await
    }

    async fn del<P: AsRef<Path> + Send + Debug>(&self, user: &DefaultUser, path: P) -> StorageResult<()> {
        self.writable()?;
        self.fs.del(user, path).await
    }

    async fn mkd<P: AsRef<Path> + Send + Debug>(&self, user: &DefaultUser, path: P) -> StorageResult<()> {
        self.writable()?;
        self.fs.mkd(user, path).await
    }

    async fn rename<P: AsRef<Path> + Send + Debug>(&self, user: &DefaultUser, from: P, to: P) -> StorageResult<()> {
        self.writable()?;
        self.fs.rename(user, from, to).await
    }

    async fn rmd<P: AsRef<Path> + Send + Debug>(&self, user: &DefaultUser, path: P) -> StorageResult<()> {
        self.writable()?;
        self.fs.rmd(user, path).await
    }

    async fn cwd<P: AsRef<Path> + Send + Debug>(&self, user: &DefaultUser, path: P) -> StorageResult<()> {
        self.live()?;
        self.fs.cwd(user, path).await
    }
}

// ---- authentication ----------------------------------------------------------------------

#[derive(Debug)]
struct Login {
    username: String,
    password: String,
    anonymous: bool,
}

/// Compare without an early exit so response timing does not leak the password.
pub(crate) fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= usize::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
    }
    diff == 0
}

#[async_trait]
impl Authenticator for Login {
    async fn authenticate(&self, username: &str, creds: &Credentials) -> Result<Principal, AuthenticationError> {
        let anonymous_name = username.eq_ignore_ascii_case("anonymous") || username.eq_ignore_ascii_case("ftp");
        if self.anonymous && anonymous_name {
            return Ok(Principal { username: "anonymous".into() });
        }
        if !self.username.is_empty() && same(username, &self.username) && same(creds.password.as_deref().unwrap_or(""), &self.password) {
            return Ok(Principal { username: username.into() });
        }
        Err(AuthenticationError::BadPassword)
    }
}

// ---- activity events ---------------------------------------------------------------------

#[derive(Debug)]
struct Activity(AppHandle);

impl Activity {
    fn emit(&self, kind: &str, user: &str, detail: String) {
        let _ = self.0.emit("ftp-server-event", json!({ "kind": kind, "user": user, "detail": detail }));
    }
}

#[async_trait]
impl PresenceListener for Activity {
    async fn receive_presence_event(&self, e: PresenceEvent, m: EventMeta) {
        match e {
            PresenceEvent::LoggedIn => self.emit("login", &m.username, String::new()),
            PresenceEvent::LoggedOut => self.emit("logout", &m.username, String::new()),
        }
    }
}

#[async_trait]
impl DataListener for Activity {
    async fn receive_data_event(&self, e: DataEvent, m: EventMeta) {
        let (kind, detail) = match e {
            DataEvent::Got { path, bytes } => ("download", format!("{path} ({bytes} bytes)")),
            DataEvent::Put { path, bytes } => ("upload", format!("{path} ({bytes} bytes)")),
            DataEvent::Deleted { path } => ("delete", path),
            DataEvent::MadeDir { path } => ("mkdir", path),
            DataEvent::RemovedDir { path } => ("rmdir", path),
            DataEvent::Renamed { from, to } => ("rename", format!("{from} → {to}")),
        };
        self.emit(kind, &m.username, detail);
    }
}

// ---- commands ----------------------------------------------------------------------------------

/// Addresses other machines can use: the primary LAN IPv4 (found without sending
/// any packet) when listening on all interfaces, plus loopback.
fn addresses(port: u16, lan: bool) -> Vec<String> {
    let mut out = Vec::new();
    if lan
        && let Some(ip) = UdpSocket::bind("0.0.0.0:0")
            .and_then(|s| s.connect("192.0.2.1:9").map(|_| s))
            .and_then(|s| s.local_addr())
            .ok()
            .map(|a| a.ip())
            .filter(|ip| !ip.is_unspecified())
        {
            out.push(format!("ftp://{ip}:{port}"));
        }
    out.push(format!("ftp://127.0.0.1:{port}"));
    out
}

fn status_of(r: &Running) -> ServerStatus {
    let c = &r.config;
    ServerStatus {
        running: true,
        root: c.root.clone(),
        port: c.port,
        lan: c.lan,
        username: c.username.clone(),
        anonymous: c.anonymous,
        read_only: c.read_only,
        addresses: addresses(c.port, c.lan),
        uptime_secs: r.started.elapsed().as_secs(),
    }
}

#[tauri::command]
pub async fn ftp_server_start(app: AppHandle, state: State<'_, FtpServerState>, config: ServerConfig) -> Result<ServerStatus, String> {
    if state.running.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
        return Err("FTP 서버가 이미 실행 중입니다".into());
    }
    if !Path::new(&config.root).is_dir() {
        return Err("공유할 폴더가 없습니다. 폴더를 다시 선택하세요.".into());
    }
    if config.port == 0 {
        return Err("포트 번호가 올바르지 않습니다".into());
    }
    if !config.anonymous && (config.username.trim().is_empty() || config.password.len() < 4) {
        return Err("사용자 이름과 4자 이상의 비밀번호를 정하거나, 익명 접속을 허용하세요".into());
    }

    // Probe the port ourselves: libunftp reports bind failures only as "io error".
    // Windows lets 0.0.0.0:port bind while another program holds 127.0.0.1:port,
    // so LAN mode probes loopback too.
    let bind = if config.lan { format!("0.0.0.0:{}", config.port) } else { format!("127.0.0.1:{}", config.port) };
    let mut probes = vec![bind.clone()];
    if config.lan {
        probes.push(format!("127.0.0.1:{}", config.port));
    }
    for addr in &probes {
        if let Err(e) = std::net::TcpListener::bind(addr) {
            return Err(match e.kind() {
                std::io::ErrorKind::AddrInUse => format!("포트 {}을(를) 이미 다른 프로그램이 사용 중입니다. 다른 포트를 고르세요.", config.port),
                std::io::ErrorKind::PermissionDenied => format!("포트 {}을(를) 열 권한이 없습니다. 다른 포트를 고르세요.", config.port),
                _ => format!("포트 {}을(를) 열 수 없습니다: {e}", config.port),
            });
        }
    }

    // Pooled mode binds every data port at start; name a taken one clearly.
    let ip = if config.lan { "0.0.0.0" } else { "127.0.0.1" };
    if let Some(port) = PASSIVE.clone().find(|p| std::net::TcpListener::bind((ip, *p)).is_err()) {
        return Err(format!("데이터 포트 {port}(범위 {}–{})를 다른 프로그램이 사용 중입니다", PASSIVE.start(), PASSIVE.end()));
    }

    let stopped = Arc::new(AtomicBool::new(false));
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let server = build_server(&config, stopped.clone(), stop_rx, PASSIVE, Some(&app), false)?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (done_tx, mut done_rx) = oneshot::channel::<Result<(), String>>();
    let (finished_tx, finished_rx) = watch::channel(false);
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = server.listen(bind).await.map_err(|e| e.to_string());
        release_passive_ports(PASSIVE).await;
        if let Err(e) = &result {
            let _ = task_app.emit("ftp-server-event", json!({ "kind": "error", "user": "", "detail": e }));
        }
        let _ = done_tx.send(result);
        // Mark finished first: start() checks this flag under the lock, so either it
        // sees the flag or the entry it stored is cleared here. No phantom "running".
        finished_tx.send_replace(true);
        let st = task_app.state::<FtpServerState>();
        let mut running = st.running.lock().unwrap_or_else(|p| p.into_inner());
        if running.as_ref().is_some_and(|r| r.id == id) {
            *running = None;
        }
        drop(running);
        let _ = task_app.emit("ftp-server-event", json!({ "kind": "stopped", "user": "", "detail": "" }));
    });

    // Bind failures (port in use, permission) surface almost immediately.
    if let Ok(Ok(Err(e))) = tokio::time::timeout(Duration::from_millis(500), &mut done_rx).await {
        return Err(if e.to_lowercase().contains("in use") || e.contains("10048") {
            format!("포트 {}을(를) 이미 다른 프로그램이 사용 중입니다", config.port)
        } else {
            format!("FTP 서버를 시작할 수 없습니다: {e}")
        });
    }

    let running = Running { id, config, started: Instant::now(), stop: Some(stop_tx), stopped, finished: finished_rx };
    let status = status_of(&running);
    {
        let mut slot = state.running.lock().unwrap_or_else(|p| p.into_inner());
        // The listener may have died right after the bind check.
        if *running.finished.borrow() {
            return Err("FTP 서버가 시작 직후 종료되었습니다".into());
        }
        *slot = Some(running);
    }
    let _ = app.emit("ftp-server-event", json!({ "kind": "started", "user": "", "detail": status.addresses.join(", ") }));
    Ok(status)
}

/// Stop the server and wait (bounded) until the port is free again, so an
/// immediate restart on the same port works.
#[tauri::command]
pub async fn ftp_server_stop(state: State<'_, FtpServerState>) -> Result<(), String> {
    let Some(mut r) = state.running.lock().unwrap_or_else(|p| p.into_inner()).take() else { return Ok(()) };
    r.stopped.store(true, Ordering::Relaxed);
    if let Some(stop) = r.stop.take() {
        let _ = stop.send(());
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), r.finished.wait_for(|done| *done)).await;
    Ok(())
}

#[tauri::command]
pub fn ftp_server_status(state: State<FtpServerState>) -> Option<ServerStatus> {
    state.running.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(status_of)
}

/// Data ports for passive transfers.
const PASSIVE: std::ops::RangeInclusive<u16> = 50000..=50100;

/// libunftp's pooled mode leaves one accept task per data port running after
/// shutdown, each holding its port until a connection arrives. Connect to every
/// port once: each task then finds its server gone, exits and frees the port,
/// so the server can be started again right away.
async fn release_passive_ports(ports: std::ops::RangeInclusive<u16>) {
    let pokes = ports.map(|p| async move {
        let _ = tokio::time::timeout(Duration::from_millis(500), tokio::net::TcpStream::connect(("127.0.0.1", p))).await;
    });
    futures_util::future::join_all(pokes).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
}

/// The one place the server is configured, for the app and for tests.
fn build_server(
    config: &ServerConfig,
    stopped: Arc<AtomicBool>,
    stop_rx: oneshot::Receiver<()>,
    passive: std::ops::RangeInclusive<u16>,
    app: Option<&AppHandle>,
    // Active mode (server connects to the client) stays off in the app: it
    // allows FTP bounce. Tests turn it on to exercise the client side.
    allow_active: bool,
) -> Result<libunftp::Server<SharedFolder, DefaultUser>, String> {
    let fs = Arc::new(Filesystem::new(PathBuf::from(&config.root)).map_err(|e| format!("공유 폴더를 열 수 없습니다: {e}"))?);
    let root = Arc::new(std::fs::canonicalize(&config.root).map_err(|e| format!("공유 폴더를 열 수 없습니다: {e}"))?);
    let shared = SharedFolder { fs, root, read_only: config.read_only, stopped };
    let login = Login {
        username: config.username.trim().to_string(),
        password: config.password.clone(),
        anonymous: config.anonymous,
    };
    let mut builder = ServerBuilder::with_authenticator(Box::new(move || shared.clone()), Arc::new(login))
        .greeting("BananaConn FTP server")
        .passive_ports(passive)
        // Pooled: data ports are bound once and each reservation is tied to the
        // client's IP, so parallel transfers never share a port and another
        // machine cannot take over a data connection.
        .pooled_listener_mode()
        .idle_session_timeout(600)
        .failed_logins_policy(FailedLoginsPolicy::new(5, Duration::from_secs(300), FailedLoginsBlock::UserAndIP))
        .shutdown_indicator(async move {
            let _ = stop_rx.await;
            Shutdown::new().grace_period(Duration::from_secs(2))
        });
    if allow_active {
        builder = builder.active_passive_mode(libunftp::options::ActivePassiveMode::ActiveAndPassive);
    }
    if let Some(app) = app {
        builder = builder.notify_presence(Activity(app.clone())).notify_data(Activity(app.clone()));
    }
    builder.build().map_err(|e| format!("FTP 서버를 준비할 수 없습니다: {e}"))
}

/// Start a server without Tauri (tests). Returns the stop handle and flag.
#[cfg(test)]
pub async fn test_start(config: ServerConfig) -> (oneshot::Sender<()>, Arc<AtomicBool>) {
    let stopped = Arc::new(AtomicBool::new(false));
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let base = 50200 + (config.port % 10) * 20;
    let server = build_server(&config, stopped.clone(), stop_rx, base..=base + 19, None, true).unwrap();
    let bind = format!("127.0.0.1:{}", config.port);
    tokio::spawn(async move {
        let _ = server.listen(bind).await;
        release_passive_ports(base..=base + 19).await;
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    (stop_tx, stopped)
}

#[cfg(test)]
mod tests {
    use super::{same, scan_folder};
    use unftp_core::storage::Metadata;

    #[test]
    fn folder_scan_lists_inside_and_refuses_ways_out() {
        let base = std::env::temp_dir().join(format!("bx-scan-{}", std::process::id()));
        let (root, outside) = (base.join("share"), base.join("outside"));
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("sub").join("보고서.txt"), b"12345").unwrap();
        std::fs::write(outside.join("secret.txt"), b"x").unwrap();
        let root = std::fs::canonicalize(&root).unwrap();

        let list = scan_folder(&root, std::path::Path::new("/sub")).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path.to_str(), Some("보고서.txt"));
        assert!(list[0].metadata.is_file() && list[0].metadata.len() == 5 && list[0].metadata.modified().is_ok());
        assert_eq!(scan_folder(&root, std::path::Path::new("/")).unwrap().len(), 1);

        // Up and out, or through a junction that leads outside: not this path.
        assert!(scan_folder(&root, std::path::Path::new("../outside")).is_none());
        assert!(scan_folder(&root, std::path::Path::new("/sub/../../outside")).is_none());
        let junction = root.join("way-out");
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&junction).arg(&outside).output().map(|o| o.status.success()).unwrap_or(false);
        if made {
            assert!(scan_folder(&root, std::path::Path::new("/way-out")).is_none());
            // A folder that holds a link is left to the sandboxed listing too.
            assert!(scan_folder(&root, std::path::Path::new("/")).is_none());
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn compares_passwords_exactly() {
        assert!(same("s3cret", "s3cret"));
        assert!(!same("s3cret", "s3cre"));
        assert!(!same("s3cret", "s3cret!"));
        assert!(!same("", "x"));
        assert!(same("", ""));
    }
}
