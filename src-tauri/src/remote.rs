// File-browser backend for SFTP, FTP and FTPS sessions, plus local file listing
// and recursive transfers with progress reporting and cancellation.
//
// SFTP uses russh (pure Rust) so ed25519 and OpenSSH-format keys work on
// Windows. Host keys are verified against ~/.ssh/known_hosts, the same file the
// OpenSSH terminal uses; an unknown key is surfaced to the user before it is
// trusted, and a changed key is refused.
//
// FTPS (explicit AUTH TLS or implicit TLS) uses rustls with one ClientConfig per
// connection, so data connections resume the control connection's TLS session
// (many servers require this). Certificates are verified against the Windows
// trust store; accepting an untrusted one requires an explicit opt-in.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use russh::client;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use suppaftp::types::FileType;
use suppaftp::{FtpResult, FtpStream, RustlsConnector, RustlsFtpStream};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::proxy::{Auth as ProxyAuth, ProxyConfig};
use crate::vault;

const CHUNK: usize = 64 * 1024;

#[derive(Default)]
pub struct RemoteState {
    conns: Mutex<HashMap<String, Arc<Remote>>>,
    /// transfer id → (connection id, cancel flag)
    cancels: Mutex<HashMap<String, (String, Arc<AtomicBool>)>>,
}

enum Remote {
    Sftp {
        sftp: SftpSession,
        _handle: client::Handle<HostCheck>,
    },
    /// opts is kept to reconnect: suppaftp leaves the control connection out
    /// of sync after an aborted transfer, so a fresh connection replaces it.
    Ftp {
        conn: Mutex<Box<dyn FtpOps>>,
        opts: FtpOptions,
        /// A transfer's own connection could not be opened (a server allowing
        /// one per user, a password changed meanwhile): transfers share the
        /// browsing one from then on, rather than log in once more per transfer.
        own_refused: AtomicBool,
    },
}

/// The FTP operations the browser needs, implemented for both the plain and the
/// TLS stream so every FTP code path below serves FTP and FTPS alike.
trait FtpOps: Send {
    fn cwd(&mut self, path: &str) -> FtpResult<()>;
    fn list(&mut self) -> FtpResult<Vec<String>>;
    fn rm(&mut self, path: &str) -> FtpResult<()>;
    fn rmdir(&mut self, path: &str) -> FtpResult<()>;
    fn mkdir(&mut self, path: &str) -> FtpResult<()>;
    fn rename(&mut self, from: &str, to: &str) -> FtpResult<()>;
    fn size(&mut self, path: &str) -> FtpResult<usize>;
    fn retr_with(&mut self, path: &str, f: &mut dyn FnMut(&mut dyn Read) -> FtpResult<()>) -> FtpResult<()>;
    fn put(&mut self, path: &str, r: &mut dyn Read) -> FtpResult<u64>;
    /// Upload appending to the file (APPE): creates a missing file, never
    /// truncates one that exists.
    fn append(&mut self, path: &str, r: &mut dyn Read) -> FtpResult<u64>;
    fn quit(&mut self) -> FtpResult<()>;
    /// A raw command; returns the reply body when it is one of `ok`.
    fn command(&mut self, cmd: &str, ok: &[suppaftp::Status]) -> FtpResult<String>;
    /// A connection that could not be opened again (DeadFtp): no command
    /// works, and none opens a new one (see reopen_ftp).
    fn is_dead(&self) -> bool {
        false
    }
}

macro_rules! impl_ftp_ops {
    ($t:ty) => {
        impl FtpOps for $t {
            fn cwd(&mut self, path: &str) -> FtpResult<()> {
                <$t>::cwd(self, path)
            }
            fn list(&mut self) -> FtpResult<Vec<String>> {
                <$t>::list(self, None)
            }
            fn rm(&mut self, path: &str) -> FtpResult<()> {
                <$t>::rm(self, path)
            }
            fn rmdir(&mut self, path: &str) -> FtpResult<()> {
                <$t>::rmdir(self, path)
            }
            fn mkdir(&mut self, path: &str) -> FtpResult<()> {
                <$t>::mkdir(self, path)
            }
            fn rename(&mut self, from: &str, to: &str) -> FtpResult<()> {
                <$t>::rename(self, from, to)
            }
            fn size(&mut self, path: &str) -> FtpResult<usize> {
                <$t>::size(self, path)
            }
            fn retr_with(&mut self, path: &str, f: &mut dyn FnMut(&mut dyn Read) -> FtpResult<()>) -> FtpResult<()> {
                <$t>::retr(self, path, |r| f(r))
            }
            fn put(&mut self, path: &str, r: &mut dyn Read) -> FtpResult<u64> {
                // std::io::copy reads 8 KB at a time; a big buffer in front makes
                // it write whole 256 KB pieces (fewer TLS records and syscalls).
                let mut big = std::io::BufReader::with_capacity(256 * 1024, r);
                <$t>::put_file(self, path, &mut big)
            }
            fn append(&mut self, path: &str, r: &mut dyn Read) -> FtpResult<u64> {
                let mut r = r;
                <$t>::append_file(self, path, &mut r)
            }
            fn quit(&mut self) -> FtpResult<()> {
                <$t>::quit(self)
            }
            fn command(&mut self, cmd: &str, ok: &[suppaftp::Status]) -> FtpResult<String> {
                <$t>::custom_command(self, cmd, ok).map(|r| String::from_utf8_lossy(&r.body).into_owned())
            }
        }
    };
}
impl_ftp_ops!(FtpStream);
impl_ftp_ops!(RustlsFtpStream);

/// Replaces an FTP connection that could not be re-established after an aborted
/// transfer. Every call fails, instead of reading the stale replies the old
/// control connection would return for the wrong command.
struct DeadFtp;

fn dead_ftp<T>() -> FtpResult<T> {
    Err(suppaftp::FtpError::ConnectionError(std::io::Error::new(
        std::io::ErrorKind::NotConnected,
        "연결이 끊어졌습니다. 다시 연결하세요.",
    )))
}

impl FtpOps for DeadFtp {
    fn cwd(&mut self, _: &str) -> FtpResult<()> {
        dead_ftp()
    }
    fn list(&mut self) -> FtpResult<Vec<String>> {
        dead_ftp()
    }
    fn rm(&mut self, _: &str) -> FtpResult<()> {
        dead_ftp()
    }
    fn rmdir(&mut self, _: &str) -> FtpResult<()> {
        dead_ftp()
    }
    fn mkdir(&mut self, _: &str) -> FtpResult<()> {
        dead_ftp()
    }
    fn rename(&mut self, _: &str, _: &str) -> FtpResult<()> {
        dead_ftp()
    }
    fn size(&mut self, _: &str) -> FtpResult<usize> {
        dead_ftp()
    }
    fn retr_with(&mut self, _: &str, _: &mut dyn FnMut(&mut dyn Read) -> FtpResult<()>) -> FtpResult<()> {
        dead_ftp()
    }
    fn put(&mut self, _: &str, _: &mut dyn Read) -> FtpResult<u64> {
        dead_ftp()
    }
    fn append(&mut self, _: &str, _: &mut dyn Read) -> FtpResult<u64> {
        dead_ftp()
    }
    fn quit(&mut self) -> FtpResult<()> {
        Ok(())
    }
    fn command(&mut self, _: &str, _: &[suppaftp::Status]) -> FtpResult<String> {
        dead_ftp()
    }
    fn is_dead(&self) -> bool {
        true
    }
}

/// suppaftp sets no read/write timeouts; without them a silently dropped
/// network blocks a transfer (and the connection lock) forever.
const FTP_IO_TIMEOUT: Duration = Duration::from_secs(30);

fn ftp_data_stream(addr: SocketAddr) -> FtpResult<TcpStream> {
    let s = TcpStream::connect_timeout(&addr, Duration::from_secs(15)).map_err(suppaftp::FtpError::ConnectionError)?;
    s.set_read_timeout(Some(FTP_IO_TIMEOUT))
        .and_then(|()| s.set_write_timeout(Some(FTP_IO_TIMEOUT)))
        .map_err(suppaftp::FtpError::ConnectionError)?;
    Ok(s)
}

/// Random suffix for temporary names next to a target.
fn rand_tag() -> String {
    use rand::Rng as _;
    let mut b = [0u8; 4];
    rand::rngs::ThreadRng::default().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A hidden, unique temporary name in the same remote folder as `path`.
fn remote_temp(path: &str, kind: &str) -> String {
    let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
    format!("{dir}/.{name}.{}.{kind}", rand_tag())
}

/// Names a server sent in a non-UTF-8 encoding arrive with U+FFFD and no
/// longer address the real entry, so they cannot be transferred or deleted.
fn undecodable(name: &str) -> bool {
    name.contains('\u{FFFD}')
}

/// Such a name cannot be sent back to the server: explain it rather than
/// pass on the server's bare "550 not found".
fn decodable(path: &str) -> Result<(), String> {
    if undecodable(path) {
        return Err("서버가 다른 문자 인코딩(예: CP949)으로 보낸 이름이라 이 항목은 다룰 수 없습니다. 서버에서 이름을 바꾸거나 UTF-8을 쓰도록 설정하세요".into());
    }
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub perm: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub id: String,
    /// "sftp", "ftp" or "ftps"
    pub protocol: String,
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub credential_id: Option<String>,
    /// Password typed at connect time (not stored).
    #[serde(default)]
    pub password: Option<String>,
    /// SFTP: fingerprint the user approved after a HOSTKEY_UNKNOWN prompt.
    #[serde(default)]
    pub trusted_fingerprint: Option<String>,
    #[serde(default)]
    pub active_mode: bool,
    /// FTPS: "explicit" (AUTH TLS, default) or "implicit".
    #[serde(default)]
    pub ftps_mode: Option<String>,
    /// FTPS: accept a certificate Windows does not trust (self-signed etc.).
    #[serde(default)]
    pub allow_invalid_cert: bool,
    /// FTPS: SHA-256 of the exact certificate the user approved after an
    /// `FTPS_CERT` prompt; only that certificate is accepted on reconnect.
    #[serde(default)]
    pub trusted_cert: Option<String>,
    /// The session's proxy (proxy.rs).
    #[serde(default)]
    pub proxy: Option<ProxyConfig>,
}

#[derive(Clone, Copy, PartialEq)]
enum FtpSecurity {
    Plain,
    Explicit,
    Implicit,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub home: String,
    pub banner: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    transfer_id: String,
    file: String,
    done: u64,
    total: u64,
    files_done: u32,
}

// ---- host key verification -------------------------------------------------

pub struct HostCheck {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    /// Fingerprint the user approved; only a key with exactly this fingerprint is learned.
    trusted_fingerprint: Option<String>,
    verdict: Arc<Mutex<Option<String>>>,
}

pub(crate) fn known_hosts_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".ssh")
        .join("known_hosts")
}

impl client::Handler for HostCheck {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            *self.verdict.lock().unwrap() = Some("HOSTKEY_UNKNOWN::(인증서 기반 호스트 키)".into());
            return Ok(false);
        };
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let path = self.known_hosts.clone();
        let known = if path.exists() {
            russh::keys::check_known_hosts_path(&self.host, self.port, key, &path)
        } else {
            Ok(false)
        };
        match known {
            Ok(true) => Ok(true),
            Err(russh::keys::Error::KeyChanged { .. }) => {
                *self.verdict.lock().unwrap() = Some(format!("HOSTKEY_MISMATCH::{fingerprint}"));
                Ok(false)
            }
            _ if self.trusted_fingerprint.as_deref() == Some(fingerprint.as_str()) => {
                russh::keys::known_hosts::learn_known_hosts_path(&self.host, self.port, key, &path)
                    .map_err(|_| russh::Error::Disconnect)?;
                Ok(true)
            }
            _ => {
                *self.verdict.lock().unwrap() = Some(format!("HOSTKEY_UNKNOWN::{fingerprint}"));
                Ok(false)
            }
        }
    }
}

// ---- connect -----------------------------------------------------------------

#[tauri::command]
pub async fn remote_connect(
    app: AppHandle,
    state: State<'_, RemoteState>,
    req: ConnectRequest,
) -> Result<Connected, String> {
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
    let proxy_auth = crate::proxy::auth_for(&app, req.proxy.as_ref())?;

    let (remote, connected) = match req.protocol.as_str() {
        "sftp" => connect_sftp(&req, &username, password, cred, known_hosts_path(), proxy_auth).await?,
        "ftp" | "ftps" => {
            let security = match (req.protocol.as_str(), req.ftps_mode.as_deref()) {
                ("ftp", _) => FtpSecurity::Plain,
                (_, Some("implicit")) => FtpSecurity::Implicit,
                _ => FtpSecurity::Explicit,
            };
            let default_port = if security == FtpSecurity::Implicit { 990 } else { 21 };
            let opts = FtpOptions {
                host: req.host.clone(),
                port: req.port.unwrap_or(default_port),
                username,
                password,
                active: req.active_mode,
                security,
                allow_invalid_cert: req.allow_invalid_cert,
                trusted_cert: req.trusted_cert.clone(),
                proxy: req.proxy.clone(),
                proxy_auth,
            };
            tauri::async_runtime::spawn_blocking(move || connect_ftp(&opts))
                .await
                .map_err(|e| e.to_string())??
        }
        other => return Err(format!("지원하지 않는 파일 프로토콜입니다: {other}")),
    };
    state.conns.lock().unwrap().insert(req.id.clone(), Arc::new(remote));
    Ok(connected)
}

/// An SSH server to log in to, for SFTP and for tunnels (gateway).
pub(crate) struct SshLogin {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub cred: Option<vault::Resolved>,
    pub trusted_fingerprint: Option<String>,
    pub known_hosts: PathBuf,
    /// The session's proxy, and its login from the vault.
    pub proxy: Option<ProxyConfig>,
    pub proxy_auth: ProxyAuth,
    /// Which keys to try with no credential or password (default_keys).
    pub keys: KeyHints,
}

/// What ~/.ssh/config says about keys for this host, as `ssh -G` resolves it
/// (term::ssh_config): its IdentityFile entries, in order, and IdentitiesOnly
/// (then the agent's other keys are not offered, as ssh.exe would not).
/// Empty: the default key files, agent keys first.
#[derive(Clone, Default)]
pub(crate) struct KeyHints {
    pub files: Vec<PathBuf>,
    pub identities_only: bool,
}

/// Connect and authenticate. Errors use the shared codes the UI understands:
/// HOSTKEY_UNKNOWN::, HOSTKEY_MISMATCH::, NEED_PASSWORD.
pub(crate) async fn ssh_login(l: SshLogin) -> Result<client::Handle<HostCheck>, String> {
    let port = l.port;
    let verdict = Arc::new(Mutex::new(None));
    let handler = HostCheck {
        host: l.host.clone(),
        port,
        known_hosts: l.known_hosts,
        trusted_fingerprint: l.trusted_fingerprint,
        verdict: verdict.clone(),
    };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        // Keys through a tunnel and short SFTP requests are small writes;
        // Nagle would hold each one until the previous is acknowledged.
        nodelay: true,
        ..Default::default()
    });
    let connecting = async {
        match l.proxy.clone().filter(|p| !p.bypasses(&l.host)) {
            // Through the proxy: its connection carries the SSH session.
            Some(p) => {
                let (host, auth) = (l.host.clone(), l.proxy_auth.clone());
                let stream = tauri::async_runtime::spawn_blocking(move || crate::proxy::dial(Some(&p), &auth, &host, port, &mut |_| {}))
                    .await
                    .map_err(|e| russh::Error::IO(std::io::Error::other(e.to_string())))?
                    .map_err(|e| russh::Error::IO(std::io::Error::other(e)))?;
                stream.set_nonblocking(true).map_err(russh::Error::IO)?;
                let stream = tokio::net::TcpStream::from_std(stream).map_err(russh::Error::IO)?;
                client::connect_stream(config, stream, handler).await
            }
            None => client::connect(config, (l.host.as_str(), port), handler).await,
        }
    };
    let mut handle = match tokio::time::timeout(Duration::from_secs(15), connecting).await {
        Err(_) => return Err(format!("{}:{port} 연결 시간이 초과되었습니다", l.host)),
        Ok(Err(e)) => {
            if let Some(v) = verdict.lock().unwrap().take() {
                return Err(v);
            }
            return Err(format!("{}:{port} 에 연결할 수 없습니다: {e}", l.host));
        }
        Ok(Ok(h)) => h,
    };
    let (username, password, cred) = (l.username.as_str(), l.password, l.cred);

    let key_path = cred.as_ref().and_then(|c| c.key_path.clone());
    // A key credential with a value typed at a prompt (asked only after a
    // failure): for an encrypted key it is the passphrase; for a plain key the
    // server refused the key, so it is the login password, tried instead of the
    // key (one attempt each time the user types, not two).
    let encrypted = match key_path.clone() {
        Some(p) => tauri::async_runtime::spawn_blocking(move || vault::key_is_encrypted(Path::new(&p))).await.map_err(|e| e.to_string())?,
        None => false,
    };
    let key_path = key_path.filter(|_| encrypted || password.is_none());
    let auth = if let Some(path) = key_path {
        // The vault's passphrase, else the one typed at the prompt.
        let passphrase = cred.as_ref().and_then(|c| c.passphrase.clone()).or(password);
        // Decrypting an encrypted key runs a bcrypt-pbkdf KDF (CPU-bound, up to
        // ~1 s); keep it off the async runtime so it does not stall other commands.
        let (p, pass) = (path.clone(), passphrase.clone());
        let loaded = tauri::async_runtime::spawn_blocking(move || {
            let key = russh::keys::load_secret_key(&p, pass.as_deref());
            (key, encrypted)
        })
        .await
        .map_err(|e| e.to_string())?;
        // A key that needs (another) passphrase is asked for again: decrypting
        // it happens here, so a wrong one never reaches the server.
        let key = match loaded {
            (Ok(key), _) => key,
            (Err(_), true) if passphrase.is_none() => return Err("NEED_PASSPHRASE".into()),
            (Err(_), true) => return Err("BAD_PASSPHRASE".into()),
            (Err(e), false) => return Err(format!("개인 키를 불러올 수 없습니다 ({path}): {e}")),
        };
        let hash = handle.best_supported_rsa_hash().await.map_err(|e| e.to_string())?.flatten();
        handle
            .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
    } else if let Some(pw) = password {
        // A given password goes first: hardened servers (MaxAuthTries 3)
        // would hang up after the default keys had used the tries.
        handle.authenticate_password(username, pw).await
    } else if default_keys(&mut handle, username, &l.keys).await {
        return Ok(handle);
    } else {
        return Err("NEED_PASSWORD".into());
    };
    let auth = auth.map_err(|e| format!("인증 중 오류가 발생했습니다: {e}"))?;
    if !auth.success() {
        return Err("인증에 실패했습니다. 사용자 이름과 비밀번호(또는 키)를 확인하세요.".into());
    }
    Ok(handle)
}

/// What ssh.exe tries before asking for a password: keys held by the SSH agent
/// (Windows OpenSSH's, else Pageant) and the unencrypted key files: those
/// ~/.ssh/config names for the host (`hints.files`), else the default ones in
/// ~/.ssh. At most three attempts in all: a failed key counts toward the
/// server's MaxAuthTries (6 by default), and the password must still get its
/// turn. As OpenSSH does: under IdentitiesOnly only the agent keys that are
/// one of those files' (by public key), and a key the agent offered already
/// is not tried again from its file. True when one of them logged in.
async fn default_keys(handle: &mut client::Handle<HostCheck>, username: &str, hints: &KeyHints) -> bool {
    use russh::keys::agent::client::AgentClient;
    let mut tries = 3;
    let hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
    let short = Duration::from_secs(3);

    let files: Vec<PathBuf> = if hints.files.is_empty() {
        let Some(dir) = dirs::home_dir().map(|h| h.join(".ssh")) else { return false };
        ["id_ed25519", "id_ecdsa", "id_rsa"].iter().map(|n| dir.join(n)).collect()
    } else {
        hints.files.clone()
    };
    // A security key's ("id_ed25519_sk", as `ssh -G` lists by default) needs
    // the device, which no login here can use: never a try spent on it.
    let files: Vec<PathBuf> = files.into_iter().filter(|f| !f.file_name().is_some_and(|n| n.to_string_lossy().ends_with("_sk"))).collect();
    // Each file's public key, from its ".pub" beside it or from the key itself
    // when it opens without a passphrase: what an agent key is matched with.
    let file_key = |f: &PathBuf| {
        let mut pub_path = f.clone().into_os_string();
        pub_path.push(".pub");
        russh::keys::load_public_key(PathBuf::from(pub_path))
            .ok()
            .map(|k| k.key_data().clone())
            .or_else(|| russh::keys::load_secret_key(f, None).ok().map(|k| k.public_key().key_data().clone()))
    };
    let wanted: Vec<_> = if hints.identities_only { files.iter().filter_map(file_key).collect() } else { Vec::new() };

    let agent = async {
        if let Ok(a) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            return Some(a.dynamic());
        }
        AgentClient::connect_pageant().await.ok().map(|a| a.dynamic())
    };
    let mut offered = Vec::new();
    if let Ok(Some(mut agent)) = tokio::time::timeout(short, agent).await
        && let Ok(Ok(ids)) = tokio::time::timeout(short, agent.request_identities()).await
    {
        for id in ids.iter() {
            let key = id.public_key().into_owned();
            if hints.identities_only && !wanted.contains(key.key_data()) {
                continue;
            }
            if tries == 0 {
                return false;
            }
            tries -= 1;
            offered.push(key.key_data().clone());
            if let Ok(r) = handle.authenticate_publickey_with(username, key, hash, &mut agent).await
                && r.success()
            {
                return true;
            }
        }
    }

    for file in files {
        // Encrypted keys need a passphrase: those go through the vault.
        let Ok(key) = russh::keys::load_secret_key(&file, None) else { continue };
        // Offered by the agent already: refused once, not again.
        if offered.contains(key.public_key().key_data()) {
            continue;
        }
        if tries == 0 {
            return false;
        }
        tries -= 1;
        if let Ok(r) = handle.authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await
            && r.success()
        {
            return true;
        }
    }
    false
}

async fn connect_sftp(
    req: &ConnectRequest,
    username: &str,
    password: Option<String>,
    cred: Option<vault::Resolved>,
    known_hosts: PathBuf,
    proxy_auth: ProxyAuth,
) -> Result<(Remote, Connected), String> {
    let handle = ssh_login(SshLogin {
        host: req.host.clone(),
        port: req.port.unwrap_or(22),
        username: username.to_string(),
        password,
        cred,
        trusted_fingerprint: req.trusted_fingerprint.clone(),
        known_hosts,
        proxy: req.proxy.clone(),
        proxy_auth,
        keys: Default::default(),
    })
    .await?;
    let channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("SFTP 서브시스템을 열 수 없습니다: {e}"))?;
    let sftp = SftpSession::new_with_config(channel.into_stream(), sftp_config())
        .await
        .map_err(|e| format!("SFTP 세션을 시작할 수 없습니다: {e}"))?;
    let home = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());
    Ok((Remote::Sftp { sftp, _handle: handle }, Connected { home, banner: None }))
}

/// russh-sftp keeps 16 reads in flight, and each must be answered within the
/// request timeout counted from when it was sent. With the server's maximum
/// read size (OpenSSH: 255 KB) and the default 10 s, downloads failed on links
/// slower than ~400 KB/s (VPN, mobile). 64 KB reads and 30 s work down to
/// ~35 KB/s, while a dead link still fails within 30 s. Writes get a deeper
/// pipeline for latency.
fn sftp_config() -> russh_sftp::client::Config {
    russh_sftp::client::Config {
        request_timeout_secs: 30,
        max_packet_len: 64 * 1024 + 1024,
        max_concurrent_writes: 64,
        ..Default::default()
    }
}

#[derive(Clone)]
struct FtpOptions {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    active: bool,
    security: FtpSecurity,
    allow_invalid_cert: bool,
    /// SHA-256 of the one certificate the user pinned (see `ConnectRequest`).
    trusted_cert: Option<String>,
    proxy: Option<ProxyConfig>,
    proxy_auth: ProxyAuth,
}

/// SHA-256 of a certificate as lower-case colon-separated hex ("ab:cd:…").
fn cert_fingerprint(cert: &[u8]) -> String {
    let d = ring::digest::digest(&ring::digest::SHA256, cert);
    d.as_ref().iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":")
}

/// Two fingerprints match ignoring case and separators (`:`, spaces).
fn same_fingerprint(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.chars().filter(|c| c.is_ascii_hexdigit()).flat_map(|c| c.to_lowercase()).collect::<String>();
    !a.is_empty() && norm(a) == norm(b)
}

/// Map a TLS-layer failure. An untrusted or mismatched certificate comes back
/// as `FTPS_CERT::<sha256>::<detail>` (the exact certificate the server
/// offered, recorded by the verifier) so the UI can pin that one certificate.
fn tls_error(e: suppaftp::FtpError, o: &FtpOptions, seen: &Arc<Mutex<Option<String>>>) -> String {
    match e {
        suppaftp::FtpError::SecureError(msg) if !o.allow_invalid_cert => match seen.lock().ok().and_then(|s| s.clone()) {
            Some(fp) => format!("FTPS_CERT::{fp}::{msg}"),
            // The handshake failed before a certificate was seen (e.g. no TLS).
            None => format!("TLS 연결에 실패했습니다: {msg}"),
        },
        suppaftp::FtpError::SecureError(msg) => format!("TLS 연결에 실패했습니다: {msg}"),
        suppaftp::FtpError::UnexpectedResponse(r) => format!(
            "서버가 FTPS(TLS)를 지원하지 않거나 거부했습니다: {}",
            String::from_utf8_lossy(&r.body).trim()
        ),
        other => format!("{}:{} 에 TLS로 연결할 수 없습니다: {other}", o.host, o.port),
    }
}

/// One rustls config per FTPS connection. Sharing it between the control and
/// data connections lets the data channel resume the control channel's TLS
/// session (rustls keeps an in-memory session cache by default).
fn tls_connector(allow_invalid_cert: bool, trusted_cert: Option<String>, seen: Arc<Mutex<Option<String>>>) -> Result<RustlsConnector, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS를 초기화할 수 없습니다: {e}"))?;
    // Native roots back the default chain-of-trust check; a pinned fingerprint
    // and the "accept any" option are layered on top of it.
    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(cert);
    }
    let native = (!roots.is_empty())
        .then(|| rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone()).build().ok())
        .flatten();
    let trusted = trusted_cert.filter(|t| !t.is_empty());
    // Without the native store there is no chain-of-trust check; only a pinned
    // fingerprint or the explicit "accept any" option can then approve a
    // certificate, so refuse rather than fall through to accepting anything.
    if native.is_none() && !allow_invalid_cert && trusted.is_none() {
        return Err("Windows 인증서 저장소를 읽을 수 없습니다".into());
    }
    let verifier = CertCheck { native, trusted, accept_any: allow_invalid_cert, seen, provider };
    let config = builder.dangerous().with_custom_certificate_verifier(Arc::new(verifier)).with_no_client_auth();
    Ok(RustlsConnector::from(Arc::new(config)))
}

/// The FTPS certificate check. It always records the server's end-entity
/// certificate fingerprint (so a failure can name it), then accepts the
/// certificate when: it matches the pinned fingerprint, or the native
/// chain-of-trust check passes, or the session opted in to any certificate.
/// Signatures are verified in every case.
#[derive(Debug)]
struct CertCheck {
    native: Option<Arc<rustls::client::WebPkiServerVerifier>>,
    trusted: Option<String>,
    accept_any: bool,
    seen: Arc<Mutex<Option<String>>>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl rustls::client::danger::ServerCertVerifier for CertCheck {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        ocsp_response: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let fingerprint = cert_fingerprint(end_entity);
        if let Ok(mut slot) = self.seen.lock() {
            *slot = Some(fingerprint.clone());
        }
        // The one certificate the user pinned is accepted on its own.
        if self.trusted.as_deref().is_some_and(|t| same_fingerprint(t, &fingerprint)) {
            return Ok(rustls::client::danger::ServerCertVerified::assertion());
        }
        // A pin was set but did not match: never fall back to accepting the
        // certificate, or pinning would silently weaken to accept-all.
        if self.trusted.is_some() && !self.accept_any {
            return Err(rustls::Error::General("pinned certificate did not match".into()));
        }
        // Otherwise the normal chain-of-trust check decides, unless the session
        // opted in to any certificate (self-signed internal server). Without a
        // native verifier, only the explicit opt-in can approve it.
        match &self.native {
            Some(v) => match v.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now) {
                Ok(ok) => Ok(ok),
                Err(e) if self.accept_any => {
                    let _ = e;
                    Ok(rustls::client::danger::ServerCertVerified::assertion())
                }
                Err(e) => Err(e),
            },
            None if self.accept_any => Ok(rustls::client::danger::ServerCertVerified::assertion()),
            None => Err(rustls::Error::General("no certificate trust anchors".into())),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

fn connect_ftp(o: &FtpOptions) -> Result<(Remote, Connected), String> {
    let (conn, connected) = open_ftp(o)?;
    Ok((Remote::Ftp { conn: Mutex::new(conn), opts: o.clone(), own_refused: AtomicBool::new(false) }, connected))
}

fn open_ftp(o: &FtpOptions) -> Result<(Box<dyn FtpOps>, Connected), String> {
    // Looked up here only for a direct connection: behind a proxy the name
    // may resolve on the proxy's side only.
    let lookup = || -> Result<Vec<SocketAddr>, String> {
        let addrs: Vec<SocketAddr> = (o.host.as_str(), o.port)
            .to_socket_addrs()
            .map_err(|e| format!("호스트 주소를 찾을 수 없습니다: {e}"))?
            .collect();
        if addrs.is_empty() {
            return Err("호스트 주소를 찾을 수 없습니다".into());
        }
        Ok(addrs)
    };
    let user = if o.username.is_empty() { "anonymous" } else { o.username.as_str() };
    let pass = o
        .password
        .clone()
        .unwrap_or_else(|| if user == "anonymous" { "anonymous@".into() } else { String::new() });
    if pass.is_empty() && user != "anonymous" {
        return Err("NEED_PASSWORD".into());
    }

    // Login and session setup are identical for both stream types.
    macro_rules! finish {
        ($ftp:expr) => {{
            let mut ftp = $ftp;
            let _ = ftp.get_ref().set_read_timeout(Some(FTP_IO_TIMEOUT));
            let _ = ftp.get_ref().set_write_timeout(Some(FTP_IO_TIMEOUT));
            let banner = ftp.get_welcome_msg().map(|s| s.trim().to_string());
            ftp.login(user, pass.as_str())
                .map_err(|e| format!("FTP 로그인에 실패했습니다: {e}"))?;
            ftp.transfer_type(FileType::Binary).map_err(|e| e.to_string())?;
            // Ask for UTF-8 names; servers that refuse simply answer with an error.
            let _ = ftp.custom_command("OPTS UTF8 ON", &[suppaftp::Status::CommandOk]);
            // Active mode needs the server to connect back: not through a proxy.
            if o.active && !o.proxy.as_ref().is_some_and(|p| !p.bypasses(&o.host)) {
                ftp.set_mode(suppaftp::Mode::Active);
            } else {
                ftp.set_passive_nat_workaround(true);
            }
            let home = ftp.pwd().unwrap_or_else(|_| "/".into());
            let boxed: Box<dyn FtpOps> = Box::new(ftp);
            (boxed, Connected { home, banner })
        }};
    }

    // Filled by the verifier with the server's certificate fingerprint, so a
    // trust failure can report exactly which certificate to pin.
    let seen = Arc::new(Mutex::new(None));
    let tls = || tls_connector(o.allow_invalid_cert, o.trusted_cert.clone(), seen.clone());
    let connect_err = |e: suppaftp::FtpError| format!("{}:{} 에 연결할 수 없습니다: {e}", o.host, o.port);
    // The control socket gets its timeouts before the first byte: a server
    // that accepts the connection but never greets (wrong port, a dead NAS)
    // fails after FTP_IO_TIMEOUT instead of hanging the tab and its queue.
    let proxied = o.proxy.clone().filter(|p| !p.bypasses(&o.host));
    // Passive data connections: through the proxy too, to the server's own
    // name (the address in its PASV reply is often a private one).
    let data: Arc<dyn Fn(SocketAddr) -> FtpResult<TcpStream> + Send + Sync> = match proxied.clone() {
        Some(p) => {
            let (host, auth) = (o.host.clone(), o.proxy_auth.clone());
            Arc::new(move |addr: SocketAddr| {
                let s = crate::proxy::dial(Some(&p), &auth, &host, addr.port(), &mut |_| {})
                    .map_err(|e| suppaftp::FtpError::ConnectionError(std::io::Error::other(e)))?;
                s.set_read_timeout(Some(FTP_IO_TIMEOUT))
                    .and_then(|()| s.set_write_timeout(Some(FTP_IO_TIMEOUT)))
                    .map_err(suppaftp::FtpError::ConnectionError)?;
                Ok(s)
            })
        }
        None => Arc::new(ftp_data_stream),
    };
    let builder = || {
        let data = data.clone();
        move |addr: SocketAddr| data(addr)
    };
    let control = || -> Result<TcpStream, String> {
        if let Some(p) = &proxied {
            let s = crate::proxy::dial(Some(p), &o.proxy_auth, &o.host, o.port, &mut |_| {})?;
            let _ = s.set_read_timeout(Some(FTP_IO_TIMEOUT));
            let _ = s.set_write_timeout(Some(FTP_IO_TIMEOUT));
            return Ok(s);
        }
        // The first address that answers ("localhost" is ::1 first; a server
        // may listen on 127.0.0.1 only).
        let mut last = None;
        let s = lookup()?
            .iter()
            .find_map(|a| TcpStream::connect_timeout(a, Duration::from_secs(15)).map_err(|e| last = Some(e)).ok())
            .ok_or_else(|| connect_err(suppaftp::FtpError::ConnectionError(last.take().expect("one address was tried"))))?;
        let _ = s.set_read_timeout(Some(FTP_IO_TIMEOUT));
        let _ = s.set_write_timeout(Some(FTP_IO_TIMEOUT));
        Ok(s)
    };

    let (ftp, connected) = match o.security {
        FtpSecurity::Plain => finish!(FtpStream::connect_with_stream(control()?)
            .map_err(connect_err)?
            .passive_stream_builder(builder())),
        FtpSecurity::Explicit => {
            let plain = RustlsFtpStream::connect_with_stream(control()?)
                .map_err(connect_err)?
                .passive_stream_builder(builder());
            finish!(plain.into_secure(tls()?, &o.host).map_err(|e| tls_error(e, o, &seen))?)
        }
        FtpSecurity::Implicit => {
            let mut secure = RustlsFtpStream::connect_secure_implicit_with_stream(control()?, tls()?, &o.host)
                .map_err(|e| tls_error(e, o, &seen))?
                .passive_stream_builder(builder());
            // suppaftp's implicit mode wraps data connections in TLS but never
            // negotiates data protection; servers then reject the data channel.
            for cmd in ["PBSZ 0", "PROT P"] {
                secure
                    .custom_command(cmd, &[suppaftp::Status::CommandOk])
                    .map_err(|e| format!("FTPS 데이터 보호 설정({cmd})에 실패했습니다: {e}"))?;
            }
            finish!(secure)
        }
    };
    Ok((ftp, connected))
}

type FtpConn = Mutex<Box<dyn FtpOps>>;

/// Lock an FTP connection. A panic inside the FTP library poisons the lock
/// and may have left the control connection mid-reply: start a fresh one.
fn lock_ftp<'a>(conn: &'a FtpConn, opts: &FtpOptions) -> std::sync::MutexGuard<'a, Box<dyn FtpOps>> {
    match conn.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            conn.clear_poison();
            let mut g = poisoned.into_inner();
            reopen_ftp(&mut g, opts);
            g
        }
    }
}

/// A connection out of step or broken, replaced by a fresh one (a login with
/// the session's credentials), or by a dead one if that fails. Once dead it
/// stays dead: no command opens it again, so a server gone or a password
/// changed meanwhile is not logged in to again and again (once per command,
/// per folder of a walk, per queued transfer); the user reconnects.
fn reopen_ftp(ftp: &mut Box<dyn FtpOps>, opts: &FtpOptions) {
    if ftp.is_dead() {
        return;
    }
    *ftp = open_ftp(opts).map(|(f, _)| f).unwrap_or_else(|_| Box::new(DeadFtp));
}

/// After a failed FTP command, make sure the next command will read its own
/// reply: a timeout or broken data connection leaves replies out of step.
/// A NOOP answered correctly proves the connection is in step; otherwise it
/// is replaced by a fresh one (or a dead one if the server is gone).
fn resync_ftp(ftp: &mut Box<dyn FtpOps>, opts: &FtpOptions) {
    if !ftp.is_dead() && ftp.command("NOOP", &[suppaftp::Status::CommandOk]).is_err() {
        reopen_ftp(ftp, opts);
    }
}

fn conn(state: &RemoteState, id: &str) -> Result<Arc<Remote>, String> {
    state
        .conns
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| "연결이 끊어졌습니다. 다시 연결하세요.".to_string())
}

#[tauri::command]
pub async fn remote_disconnect(state: State<'_, RemoteState>, id: String) -> Result<(), String> {
    // Stop this connection's transfers first so nothing holds the FTP lock.
    for (conn_id, flag) in state.cancels.lock().unwrap().values() {
        if *conn_id == id {
            flag.store(true, Ordering::Relaxed);
        }
    }
    // Then wait for them to stop (bounded). Closing in the middle would leave
    // a hidden ".bxpart" on the server, or a replaced file still renamed to
    // ".bxold" as if it had been deleted.
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && state.cancels.lock().unwrap().values().any(|(conn_id, _)| *conn_id == id) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let removed = state.conns.lock().unwrap().remove(&id);
    if let Some(remote) = removed {
        match remote.as_ref() {
            Remote::Sftp { sftp, .. } => {
                let _ = sftp.close().await;
            }
            Remote::Ftp { .. } => {
                let r = remote.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    if let Remote::Ftp { conn, .. } = r.as_ref() {
                        // A poisoned lock still holds a connection to close.
                        let _ = conn.lock().unwrap_or_else(|p| p.into_inner()).quit();
                    }
                })
                .await;
            }
        }
    }
    Ok(())
}

// ---- remote operations ---------------------------------------------------------

fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn perm_string(mode: u32, is_dir: bool) -> String {
    let mut s = String::with_capacity(10);
    s.push(if is_dir { 'd' } else { '-' });
    // setuid, setgid and sticky show in the execute place, as ls shows them:
    // lower case with the execute bit ("rwsr-xr-x"), upper case without ("rwSr--r--").
    for (shift, special, mark) in [(6, 0o4000, 's'), (3, 0o2000, 's'), (0, 0o1000, 't')] {
        let bits = (mode >> shift) & 7;
        s.push(if bits & 4 != 0 { 'r' } else { '-' });
        s.push(if bits & 2 != 0 { 'w' } else { '-' });
        s.push(match (mode & special != 0, bits & 1 != 0) {
            (true, true) => mark,
            (true, false) => mark.to_ascii_uppercase(),
            (false, true) => 'x',
            (false, false) => '-',
        });
    }
    s
}

/// An octal permission mode as typed: three digits ("755", the special bits
/// left as they are) or four ("4755", "0755": the special bits set too).
fn parse_mode(text: &str) -> Option<(u32, bool)> {
    if !(3..=4).contains(&text.len()) || !text.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
        return None;
    }
    u32::from_str_radix(text, 8).ok().map(|mode| (mode, text.len() == 4))
}

/// Create an empty file, only if nothing has that name (EXCLUDE: the server
/// refuses rather than truncate a file made since the listing was read).
async fn new_sftp_file(sftp: &SftpSession, path: &str) -> Result<(), String> {
    use russh_sftp::protocol::OpenFlags;
    match sftp.open_with_flags(path.to_string(), OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE).await {
        Ok(mut file) => file.shutdown().await.map_err(|e| format!("작업에 실패했습니다: {e}")),
        // SFTP v3 has no "already exists" status: look whether that is why.
        Err(_) if sftp.symlink_metadata(path.to_string()).await.is_ok() => Err("같은 이름이 이미 있습니다".into()),
        Err(e) => Err(format!("작업에 실패했습니다: {e}")),
    }
}

/// Set an entry's permissions (chmod; the target of a link). With a three-digit
/// mode its setuid, setgid and sticky bits are kept as they are.
async fn chmod_sftp(sftp: &SftpSession, path: &str, mode: &str) -> Result<(), String> {
    let (requested, with_special) = parse_mode(mode).ok_or("권한은 8진수 3~4자리로 입력하세요 (예: 755)")?;
    let mode = if with_special {
        requested
    } else {
        let current = sftp
            .metadata(path.to_string())
            .await
            .map_err(|e| format!("{path} 정보를 읽을 수 없습니다: {e}"))?;
        (current.permissions.unwrap_or(0) & 0o7000) | requested
    };
    let attrs = russh_sftp::protocol::FileAttributes { permissions: Some(mode), ..Default::default() };
    sftp.set_metadata(path.to_string(), attrs).await.map_err(|e| format!("권한을 바꾸지 못했습니다: {e}"))
}

async fn list_sftp(sftp: &SftpSession, path: &str) -> Result<Vec<FileEntry>, String> {
    let entries = sftp
        .read_dir(path)
        .await
        .map_err(|e| format!("폴더를 읽을 수 없습니다: {e}"))?;
    let mut out = Vec::new();
    for e in entries {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = e.metadata();
        let ft = e.file_type();
        // Links are followed below, all at once.
        let is_dir = ft.is_dir();
        let is_link = ft.is_symlink();
        let full = join_remote(path, &name);
        out.push(FileEntry {
            perm: meta.permissions.map(|p| perm_string(p, is_dir)),
            modified: meta.mtime.map(u64::from),
            size: meta.size.unwrap_or(0),
            name,
            path: full,
            is_dir,
            is_link,
        });
    }
    // Follow links so linked folders can be opened. The requests are
    // pipelined on the one SFTP channel (/etc/alternatives, /usr/lib: hundreds
    // of links would otherwise cost one round trip each).
    let links: Vec<usize> = out.iter().enumerate().filter(|(_, e)| e.is_link).map(|(i, _)| i).collect();
    let mut targets = Vec::with_capacity(links.len());
    for group in links.chunks(32) {
        let paths: Vec<String> = group.iter().map(|&i| out[i].path.clone()).collect();
        targets.extend(futures_util::future::join_all(paths.into_iter().map(|p| sftp.metadata(p))).await);
    }
    for (i, target) in links.into_iter().zip(targets) {
        if let Ok(target) = target {
            let entry = &mut out[i];
            entry.is_dir = target.file_type().is_dir();
            // A linked file downloads the target's bytes: count those, not
            // the link's own few bytes (totals and progress would fall short).
            if !entry.is_dir {
                entry.size = target.size.unwrap_or(entry.size);
                entry.modified = target.mtime.map(u64::from).or(entry.modified);
            }
            // The target's permissions, as `ls -lL` shows them: chmod changes
            // the target, and a link's own bits are rwxrwxrwx on Linux.
            if let Some(p) = target.permissions {
                entry.perm = Some(perm_string(p, entry.is_dir));
            } else if let Some(p) = entry.perm.as_mut().filter(|_| entry.is_dir) {
                // The type letter follows the target, as for folders.
                p.replace_range(0..1, "d");
            }
        }
    }
    Ok(out)
}

fn list_ftp(ftp: &mut dyn FtpOps, path: &str) -> Result<Vec<FileEntry>, String> {
    ftp.cwd(path).map_err(|e| format!("폴더로 이동할 수 없습니다: {e}"))?;
    let lines = ftp.list().map_err(|e| format!("폴더를 읽을 수 없습니다: {e}"))?;
    let mut out = Vec::new();
    let mut probed = false;
    for line in lines {
        let Ok(f) = suppaftp::list::File::try_from(line.as_str()) else {
            continue;
        };
        let name = f.name().to_string();
        if name == "." || name == ".." {
            continue;
        }
        let full = join_remote(path, &name);
        // LIST shows a link as "l..." without saying what it points to; a link to
        // a folder is one we can change into.
        let is_dir = if f.is_symlink() {
            probed = true;
            !undecodable(&name) && ftp.cwd(&full).is_ok()
        } else {
            f.is_directory()
        };
        out.push(FileEntry {
            path: full,
            is_dir,
            is_link: f.is_symlink(),
            size: f.size() as u64,
            modified: f.modified().duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs()),
            perm: ftp_mode(&f).map(|m| perm_string(m, is_dir)),
            name,
        });
    }
    if probed {
        let _ = ftp.cwd(path);
    }
    Ok(out)
}

/// Permission bits from a POSIX-style LIST line (None for DOS-style listings).
fn ftp_mode(f: &suppaftp::list::File) -> Option<u32> {
    use suppaftp::list::PosixPexQuery::{Group, Others, Owner};
    let bits = [Owner, Group, Others].into_iter().fold(0u32, |acc, who| {
        acc << 3 | u32::from(f.can_read(who)) << 2 | u32::from(f.can_write(who)) << 1 | u32::from(f.can_execute(who))
    });
    (f.uid().is_some() || bits != 0).then_some(bits)
}

/// What the server says about one entry, from its parent folder's LIST line
/// (link status there is the entry itself, not its target).
#[derive(Clone)]
struct FtpStat {
    is_dir: bool,
    is_link: bool,
    mode: Option<u32>,
}

fn ftp_stat(ftp: &mut dyn FtpOps, path: &str) -> Result<Option<FtpStat>, String> {
    let (dir, name) = split_remote(path);
    Ok(ftp_list_stats(ftp, dir)?.remove(name))
}

fn split_remote(path: &str) -> (&str, &str) {
    let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
    (if dir.is_empty() { "/" } else { dir }, name)
}

/// Every entry of one folder, from a single LIST.
fn ftp_list_stats(ftp: &mut dyn FtpOps, dir: &str) -> Result<HashMap<String, FtpStat>, String> {
    ftp.cwd(dir).map_err(|e| format!("폴더로 이동할 수 없습니다: {e}"))?;
    let lines = ftp.list().map_err(|e| format!("폴더를 읽을 수 없습니다: {e}"))?;
    Ok(lines
        .iter()
        .filter_map(|l| suppaftp::list::File::try_from(l.as_str()).ok())
        .map(|f| (f.name().to_string(), FtpStat { is_dir: f.is_directory(), is_link: f.is_symlink(), mode: ftp_mode(&f) }))
        .collect())
}

/// Folder listings read once per folder during a folder upload (N files in
/// one folder: one LIST, not N).
#[derive(Default)]
struct FtpStatCache(HashMap<String, HashMap<String, FtpStat>>);

impl FtpStatCache {
    fn stat(&mut self, ftp: &mut dyn FtpOps, path: &str) -> Result<Option<FtpStat>, String> {
        let (dir, name) = split_remote(path);
        if !self.0.contains_key(dir) {
            let listing = ftp_list_stats(ftp, dir)?;
            self.0.insert(dir.to_string(), listing);
        }
        Ok(self.0[dir].get(name).cloned())
    }
}

/// Create an empty file over FTP, never emptying one that exists. The listing
/// can miss it (servers hide dot files from LIST, Windows servers ignore
/// case), so the upload appends nothing (APPE: creates a missing file and
/// leaves an existing one as it is) rather than storing (STOR truncates).
fn new_ftp_file(ftp: &mut dyn FtpOps, path: &str) -> Result<(), String> {
    if ftp_exists(ftp, path)? {
        return Err("같은 이름이 이미 있습니다".into());
    }
    ftp.append(path, &mut std::io::empty()).map(|_| ()).map_err(|e| format!("작업에 실패했습니다: {e}"))
}

/// Whether `path` already exists, judged from its parent folder's listing.
fn ftp_exists(ftp: &mut dyn FtpOps, path: &str) -> Result<bool, String> {
    Ok(ftp_stat(ftp, path)?.is_some())
}

#[tauri::command]
pub async fn remote_list(state: State<'_, RemoteState>, id: String, path: String) -> Result<Vec<FileEntry>, String> {
    let remote = conn(&state, &id)?;
    match remote.as_ref() {
        Remote::Sftp { sftp, .. } => list_sftp(sftp, &path).await,
        Remote::Ftp { .. } => {
            let r = remote.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let Remote::Ftp { conn, opts, .. } = r.as_ref() else { unreachable!() };
                let mut ftp = lock_ftp(conn, opts);
                let res = list_ftp(ftp.as_mut(), &path);
                if res.is_err() {
                    resync_ftp(&mut ftp, opts);
                }
                res
            })
            .await
            .map_err(|e| e.to_string())?
        }
    }
}

/// Simple single-call operations: mkdir, delete, rename.
#[tauri::command]
pub async fn remote_op(
    state: State<'_, RemoteState>,
    id: String,
    op: String,
    path: String,
    target: Option<String>,
    is_dir: Option<bool>,
) -> Result<(), String> {
    decodable(&path)?;
    let remote = conn(&state, &id)?;
    match remote.as_ref() {
        Remote::Sftp { sftp, .. } => {
            let res = match op.as_str() {
                "mkdir" => sftp.create_dir(path).await,
                "rename" => sftp.rename(path, target.unwrap_or_default()).await,
                "delete" if is_dir == Some(true) => return delete_sftp_tree(sftp, &path).await,
                "delete" => sftp.remove_file(path).await,
                "chmod" => return chmod_sftp(sftp, &path, target.as_deref().unwrap_or_default()).await,
                "newfile" => return new_sftp_file(sftp, &path).await,
                _ => return Err("알 수 없는 작업입니다".into()),
            };
            res.map_err(|e| format!("작업에 실패했습니다: {e}"))
        }
        Remote::Ftp { .. } => {
            let r = remote.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let Remote::Ftp { conn, opts, .. } = r.as_ref() else { unreachable!() };
                let mut ftp = lock_ftp(conn, opts);
                let res = (|| match op.as_str() {
                    "mkdir" => ftp.mkdir(&path).map_err(|e| format!("작업에 실패했습니다: {e}")),
                    "rename" => {
                        // Most FTP servers silently replace an existing target.
                        let to = target.unwrap_or_default();
                        if ftp_exists(ftp.as_mut(), &to)? {
                            return Err("같은 이름이 이미 있습니다".into());
                        }
                        ftp.rename(&path, &to).map_err(|e| format!("작업에 실패했습니다: {e}"))
                    }
                    "delete" if is_dir == Some(true) => delete_ftp_tree(ftp.as_mut(), &path),
                    "delete" => ftp.rm(&path).map_err(|e| format!("작업에 실패했습니다: {e}")),
                    "newfile" => new_ftp_file(ftp.as_mut(), &path),
                    _ => Err("알 수 없는 작업입니다".into()),
                })();
                if res.is_err() {
                    resync_ftp(&mut ftp, opts);
                }
                res
            })
            .await
            .map_err(|e| e.to_string())?
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkTarget {
    /// The link's own text, as `ls -l` shows it after "->".
    pub target: String,
    /// Where it leads, as an absolute path.
    pub resolved: String,
    /// It leads to something (a broken link does not), and to a folder.
    pub exists: bool,
    pub is_dir: bool,
}

/// Where a link on the server leads (SFTP; FTP has no way to ask).
#[tauri::command]
pub async fn remote_link_target(state: State<'_, RemoteState>, id: String, path: String) -> Result<LinkTarget, String> {
    decodable(&path)?;
    let remote = conn(&state, &id)?;
    let Remote::Sftp { sftp, .. } = remote.as_ref() else {
        return Err("이 연결에서는 링크가 가리키는 곳을 읽을 수 없습니다".into());
    };
    link_target(sftp, &path).await
}

async fn link_target(sftp: &SftpSession, path: &str) -> Result<LinkTarget, String> {
    let target = sftp.read_link(path.to_string()).await.map_err(|e| format!("링크를 읽을 수 없습니다: {e}"))?;
    let parent = match path.rfind('/') {
        Some(0) | None => "/",
        Some(i) => &path[..i],
    };
    // The text taken from the link's folder ("../shared" from /srv/app/current).
    let written = normalize_remote(&if target.starts_with('/') { target.clone() } else { join_remote(parent, &target) });
    // Only "no such file" makes a link broken: a target this user may not
    // look at (permission denied) is there, and saying it is not would mislead.
    let followed = match sftp.metadata(path.to_string()).await {
        Ok(m) => Some(m),
        Err(russh_sftp::client::error::Error::Status(s)) if s.status_code == russh_sftp::protocol::StatusCode::NoSuchFile => None,
        Err(e) => return Err(format!("링크가 가리키는 곳을 확인할 수 없습니다: {e}")),
    };
    // The server's own answer when it resolves links (OpenSSH does, every
    // one on the way: a folder above that is itself a link, which ".." in
    // the text does not account for). One that only tidies the path gives
    // the link's own path back; a broken link has nowhere to resolve to.
    // Tidied as the file tab names folders ("/data/v2/" is "/data/v2").
    let resolved = match (&followed, sftp.canonicalize(path.to_string()).await) {
        (Some(_), Ok(real)) if real.starts_with('/') && normalize_remote(&real) != normalize_remote(path) => normalize_remote(&real),
        _ => written,
    };
    Ok(LinkTarget { target, resolved, exists: followed.is_some(), is_dir: followed.is_some_and(|m| m.file_type().is_dir()) })
}

/// One server path as the file list shows it, or None when there is no such
/// path (SFTP; FTP has no standard way to ask). Its own folder need not be
/// readable: a home folder of mode 711 can be passed through, not listed.
#[tauri::command]
pub async fn remote_stat(state: State<'_, RemoteState>, id: String, path: String) -> Result<Option<FileEntry>, String> {
    decodable(&path)?;
    let remote = conn(&state, &id)?;
    let Remote::Sftp { sftp, .. } = remote.as_ref() else {
        return Err("이 연결에서는 경로를 바로 확인할 수 없습니다".into());
    };
    stat_sftp(sftp, &path).await
}

async fn stat_sftp(sftp: &SftpSession, path: &str) -> Result<Option<FileEntry>, String> {
    let no_such = |e: &russh_sftp::client::error::Error| matches!(e, russh_sftp::client::error::Error::Status(s) if s.status_code == russh_sftp::protocol::StatusCode::NoSuchFile);
    // The entry itself (a link as a link), then what it leads to, as list_sftp shows it.
    let own = match sftp.symlink_metadata(path.to_string()).await {
        Ok(m) => m,
        Err(e) if no_such(&e) => return Ok(None),
        Err(e) => return Err(format!("경로를 확인할 수 없습니다: {e}")),
    };
    let is_link = own.file_type().is_symlink();
    let meta = if is_link { sftp.metadata(path.to_string()).await.unwrap_or(own) } else { own };
    let is_dir = meta.file_type().is_dir();
    Ok(Some(FileEntry {
        name: path.rsplit('/').next().unwrap_or(path).to_string(),
        path: path.to_string(),
        perm: meta.permissions.map(|p| perm_string(p, is_dir)),
        modified: meta.mtime.map(u64::from),
        size: meta.size.unwrap_or(0),
        is_dir,
        is_link,
    }))
}

/// An absolute server path without "." , ".." and doubled slashes ("/" stays
/// "/"; ".." above the root stays at the root, as the server takes it).
fn normalize_remote(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for p in path.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    format!("/{}", parts.join("/"))
}

async fn delete_sftp_tree(sftp: &SftpSession, root: &str) -> Result<(), String> {
    // A link to a folder is removed as a link; recursing would empty the target.
    // lstat here rather than trusting the caller's view of the entry.
    let root_meta = sftp
        .symlink_metadata(root.to_string())
        .await
        .map_err(|e| format!("{root} 정보를 읽을 수 없습니다: {e}"))?;
    if root_meta.file_type().is_symlink() {
        return sftp.remove_file(root.to_string()).await.map_err(|e| format!("{root} 삭제 실패: {e}"));
    }
    // Walk the whole tree first, so a problem is found before anything is deleted.
    let mut stack = vec![root.to_string()];
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    while let Some(dir) = stack.pop() {
        for e in list_sftp(sftp, &dir).await? {
            if undecodable(&e.name) {
                return Err(undecodable_error(&dir));
            }
            if e.is_dir && !e.is_link {
                stack.push(e.path);
            } else {
                files.push(e.path);
            }
        }
        dirs.push(dir);
    }
    // Files have no ordering constraint, so remove them pipelined on the one
    // SFTP channel (like list_sftp's metadata batching) instead of one blocking
    // round trip each — a big tree over a WAN would otherwise take minutes.
    for group in files.chunks(32) {
        let done = futures_util::future::join_all(group.iter().map(|f| sftp.remove_file(f.clone()))).await;
        for (f, r) in group.iter().zip(done) {
            r.map_err(|err| format!("{f} 삭제 실패: {err}"))?;
        }
    }
    for dir in dirs.into_iter().rev() {
        sftp.remove_dir(dir.clone())
            .await
            .map_err(|err| format!("{dir} 삭제 실패: {err}"))?;
    }
    Ok(())
}

fn undecodable_error(dir: &str) -> String {
    format!("{dir} 안에 이름을 읽을 수 없는 항목(서버 문자 인코딩 문제)이 있어 아무것도 지우지 않았습니다. 서버에서 직접 지우세요.")
}

fn delete_ftp_tree(ftp: &mut dyn FtpOps, root: &str) -> Result<(), String> {
    // A link to a folder is removed as a link; recursing would empty its target.
    if ftp_stat(ftp, root)?.is_some_and(|s| s.is_link) {
        return ftp.rm(root).map_err(|e| format!("{root} 삭제 실패: {e}"));
    }
    let mut stack = vec![root.to_string()];
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    while let Some(dir) = stack.pop() {
        for e in list_ftp(ftp, &dir)? {
            if undecodable(&e.name) {
                return Err(undecodable_error(&dir));
            }
            if e.is_dir && !e.is_link {
                stack.push(e.path);
            } else {
                files.push(e.path);
            }
        }
        dirs.push(dir);
    }
    for f in files {
        ftp.rm(&f).map_err(|err| format!("{f} 삭제 실패: {err}"))?;
    }
    let _ = ftp.cwd("/");
    for dir in dirs.into_iter().rev() {
        ftp.rmdir(&dir).map_err(|err| format!("{dir} 삭제 실패: {err}"))?;
    }
    Ok(())
}

// ---- transfers -------------------------------------------------------------------

struct Reporter {
    /// None for internal transfers (editor saves) that report no progress.
    app: Option<AppHandle>,
    id: String,
    cancel: Arc<AtomicBool>,
    done: u64,
    total: u64,
    files_done: u32,
    /// Entries left out of a folder download (unsafe names, linked folders).
    skipped: u32,
    /// A temp file a failed FTP upload could not remove (stale connection);
    /// removed once a fresh connection is open.
    leftover: Option<String>,
    file: String,
    last: Instant,
    /// Set for one of several files copied at once: progress is counted
    /// together for the whole transfer.
    lanes: Option<Arc<Lanes>>,
}

/// Progress shared by the files of one transfer copied at the same time.
struct Lanes {
    done: AtomicU64,
    files_done: AtomicU32,
    file: Mutex<String>,
    last: Mutex<Instant>,
}

impl Reporter {
    /// Cancel also counts where no bytes move: while a folder tree is listed
    /// and between files (a folder of empty files).
    fn check(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Relaxed) { Err("CANCELLED".into()) } else { Ok(()) }
    }

    fn add(&mut self, n: usize) -> Result<(), String> {
        let due = match &self.lanes {
            Some(l) => {
                l.done.fetch_add(n as u64, Ordering::Relaxed);
                let mut last = l.last.lock().unwrap();
                let due = last.elapsed() > Duration::from_millis(120);
                if due {
                    *last = Instant::now();
                }
                due
            }
            None => {
                self.done += n as u64;
                self.last.elapsed() > Duration::from_millis(120)
            }
        };
        if self.cancel.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        if due {
            self.emit();
        }
        Ok(())
    }

    fn emit(&mut self) {
        self.last = Instant::now();
        let Some(app) = &self.app else { return };
        let (done, files_done, file) = match &self.lanes {
            Some(l) => (l.done.load(Ordering::Relaxed), l.files_done.load(Ordering::Relaxed), l.file.lock().unwrap().clone()),
            None => (self.done, self.files_done, self.file.clone()),
        };
        let _ = app.emit("transfer-progress", Progress { transfer_id: self.id.clone(), file, done, total: self.total, files_done });
    }

    /// A reporter for one of several files copied at once.
    fn lane(&self, lanes: &Arc<Lanes>) -> Reporter {
        Reporter {
            app: self.app.clone(),
            id: self.id.clone(),
            cancel: self.cancel.clone(),
            done: 0,
            total: self.total,
            files_done: 0,
            skipped: 0,
            leftover: None,
            file: String::new(),
            last: Instant::now(),
            lanes: Some(lanes.clone()),
        }
    }

    fn start_file(&mut self, name: String) {
        if let Some(l) = &self.lanes {
            *l.file.lock().unwrap() = name.clone();
        }
        self.file = name;
    }

    fn file_finished(&mut self) {
        match &self.lanes {
            Some(l) => {
                l.files_done.fetch_add(1, Ordering::Relaxed);
            }
            None => self.files_done += 1,
        }
    }
}

/// Files of a folder transfer copied at the same time over one SFTP session.
/// Small files are dominated by round trips (open, close, rename), so a few
/// at once make folders of many files several times faster on a WAN.
const SFTP_PARALLEL: usize = 4;

/// Run `jobs` with SFTP_PARALLEL workers sharing one queue. After the first
/// error (or a cancel) no new file is started; files in progress finish or
/// fail cleanly (never dropped half-way), and the first error is returned.
async fn sftp_parallel<J, F, Fut>(jobs: Vec<J>, rep: &mut Reporter, run: F) -> Result<(), String>
where
    F: Fn(J, Reporter) -> Fut,
    Fut: std::future::Future<Output = (Result<(), String>, Reporter)>,
{
    let lanes = Arc::new(Lanes {
        done: AtomicU64::new(rep.done),
        files_done: AtomicU32::new(rep.files_done),
        file: Mutex::new(rep.file.clone()),
        last: Mutex::new(Instant::now()),
    });
    let queue = Mutex::new(VecDeque::from(jobs));
    let failed = AtomicBool::new(false);
    let first_error: Mutex<Option<String>> = Mutex::new(None);
    let worker = |mut lane: Reporter| {
        let (queue, failed, first_error, run) = (&queue, &failed, &first_error, &run);
        async move {
            loop {
                if failed.load(Ordering::Relaxed) {
                    break;
                }
                if let Err(e) = lane.check() {
                    failed.store(true, Ordering::Relaxed);
                    first_error.lock().unwrap().get_or_insert(e);
                    break;
                }
                let Some(job) = queue.lock().unwrap().pop_front() else { break };
                let (res, back) = run(job, lane).await;
                lane = back;
                if let Err(e) = res {
                    failed.store(true, Ordering::Relaxed);
                    first_error.lock().unwrap().get_or_insert(e);
                    break;
                }
            }
        }
    };
    futures_util::future::join_all((0..SFTP_PARALLEL).map(|_| worker(rep.lane(&lanes)))).await;
    rep.done = lanes.done.load(Ordering::Relaxed);
    rep.files_done = lanes.files_done.load(Ordering::Relaxed);
    rep.file = lanes.file.lock().unwrap().clone();
    match first_error.into_inner().unwrap() {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

fn register_cancel(state: &RemoteState, transfer_id: &str, conn_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    state
        .cancels
        .lock()
        .unwrap()
        .insert(transfer_id.to_string(), (conn_id.to_string(), flag.clone()));
    flag
}

#[tauri::command]
pub fn transfer_cancel(state: State<RemoteState>, transfer_id: String) {
    if let Some((_, flag)) = state.cancels.lock().unwrap().get(&transfer_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub id: String,
    pub transfer_id: String,
    /// "download" (remote → local) or "upload" (local → remote)
    pub direction: String,
    pub remote_path: String,
    pub local_path: String,
    pub is_dir: bool,
}

/// Copy a file or folder between the local disk and the remote side. Emits
/// `transfer-progress` events and resolves when finished.
#[tauri::command]
pub async fn transfer(app: AppHandle, state: State<'_, RemoteState>, req: TransferRequest) -> Result<TransferResult, String> {
    // The local side is chosen by the user; refuse paths that climb out of it.
    if Path::new(&req.local_path).components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("로컬 경로에 '..' 을 사용할 수 없습니다".into());
    }
    decodable(&req.remote_path)?;
    let remote = conn(&state, &req.id)?;
    let cancel = register_cancel(&state, &req.transfer_id, &req.id);
    let mut rep = Reporter {
        app: Some(app),
        id: req.transfer_id.clone(),
        cancel,
        done: 0,
        total: 0,
        files_done: 0,
        skipped: 0,
        leftover: None,
        file: String::new(),
        last: Instant::now(),
        lanes: None,
    };
    let result = match remote.as_ref() {
        Remote::Sftp { sftp, .. } => {
            if req.direction == "download" {
                sftp_download(sftp, &req.remote_path, Path::new(&req.local_path), req.is_dir, &mut rep).await
            } else {
                sftp_upload(sftp, Path::new(&req.local_path), &req.remote_path, req.is_dir, &mut rep).await
            }
        }
        Remote::Ftp { .. } => {
            let r = remote.clone();
            let mut moved = rep;
            let res = tauri::async_runtime::spawn_blocking(move || {
                let Remote::Ftp { conn, opts, own_refused } = r.as_ref() else { unreachable!() };
                let run = |ftp: &mut dyn FtpOps, rep: &mut Reporter| {
                    if req.direction == "download" {
                        ftp_download(ftp, &req.remote_path, Path::new(&req.local_path), req.is_dir, rep)
                    } else {
                        ftp_upload(ftp, Path::new(&req.local_path), &req.remote_path, req.is_dir, rep)
                    }
                };
                // A transfer gets its own connection (like FileZilla), so the
                // folder view and the editor keep working while it runs. A
                // server that allows one connection only shares the browsing one.
                // Not tried again once refused, nor while the browsing one is
                // dead (the server gone, or no longer taking the login): a
                // queue of transfers would otherwise log in once per file.
                let shared_dead = conn.try_lock().map(|g| g.is_dead()).unwrap_or(false);
                let own = if own_refused.load(Ordering::Relaxed) || shared_dead {
                    None
                } else {
                    let opened = open_ftp(opts).ok();
                    if opened.is_none() {
                        own_refused.store(true, Ordering::Relaxed);
                    }
                    opened
                };
                if let Some((mut own, _)) = own {
                    let res = run(own.as_mut(), &mut moved);
                    let _ = own.quit();
                    // Closed first: a server allowing two connections per user
                    // needs that slot for the cleanup.
                    drop(own);
                    // The temp file left by a failed upload goes over the
                    // browsing connection, already logged in: not one more
                    // login for it (a failing upload retried would log in
                    // twice per try). A dead one fails without logging in.
                    if res.is_err()
                        && let Some(tmp) = moved.leftover.take() {
                            let _ = lock_ftp(conn, opts).rm(&tmp);
                        }
                    return (res, moved);
                }
                let mut ftp = lock_ftp(conn, opts);
                let res = run(ftp.as_mut(), &mut moved);
                // An aborted transfer leaves unread replies on the control
                // connection; start a clean one so browsing keeps working. If
                // that fails, never keep using the desynchronised one.
                if res.is_err() {
                    reopen_ftp(&mut ftp, opts);
                    if let Some(tmp) = moved.leftover.take() {
                        let _ = ftp.rm(&tmp);
                    }
                }
                (res, moved)
            })
            .await;
            let res = match res {
                Ok(res) => res,
                Err(e) => {
                    state.cancels.lock().unwrap().remove(&req.transfer_id);
                    return Err(e.to_string());
                }
            };
            rep = res.1;
            res.0
        }
    };
    state.cancels.lock().unwrap().remove(&req.transfer_id);
    rep.emit();
    // Cancellation is decided by the flag, never by matching error text.
    let cancelled = rep.cancel.load(Ordering::Relaxed);
    result
        .map_err(|e| if cancelled { "CANCELLED".to_string() } else { e })
        .map(|_| TransferResult { files_done: rep.files_done, skipped: rep.skipped })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    files_done: u32,
    skipped: u32,
}

/// A remote name that is safe as a single Windows path component, or None.
/// Rejects separators, drive prefixes, control characters, trailing dots or
/// spaces (Windows strips them, aliasing other names) and device names.
pub(crate) fn local_component(name: &str) -> Option<&str> {
    // Windows also treats COM0/LPT0, the superscript digits and the console
    // names CONIN$/CONOUT$ as devices.
    const DEVICES: [&str; 32] = [
        "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "COM¹", "COM²", "COM³", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
        "LPT9", "LPT¹", "LPT²", "LPT³",
    ];
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with('.')
        || name.ends_with(' ')
        || name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'))
        || DEVICES.contains(&stem.as_str());
    (!bad).then_some(name)
}

/// Every file under a local folder, for upload.
struct LocalTree {
    /// (absolute file, path relative to the root with '/' separators)
    files: Vec<(PathBuf, String)>,
    dirs: Vec<String>,
    total: u64,
    /// Links/junctions (not followed: "My Music"-style junctions loop or fail).
    skipped: u32,
}

fn walk_local(root: &Path) -> Result<LocalTree, String> {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    let mut total = 0u64;
    let mut skipped = 0u32;
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let rd = std::fs::read_dir(&dir).map_err(|e| format!("{} 를 읽을 수 없습니다: {e}", dir.display()))?;
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            // file_type()/metadata() of a DirEntry do not follow links.
            if entry.file_type().is_ok_and(|t| t.is_symlink()) {
                skipped += 1;
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            if meta.is_dir() {
                dirs.push(child_rel.clone());
                stack.push((entry.path(), child_rel));
            } else {
                total += meta.len();
                files.push((entry.path(), child_rel));
            }
        }
    }
    Ok(LocalTree { files, dirs, total, skipped })
}

/// Claims a local target path for one download inside a folder transfer.
/// Windows names are case-insensitive, so "Readme" and "README" from a
/// case-sensitive server would land on the same file; the second is skipped.
fn claim(seen: &mut HashSet<String>, target: &Path) -> bool {
    seen.insert(target.to_string_lossy().to_lowercase())
}

async fn sftp_download(sftp: &SftpSession, remote: &str, local: &Path, is_dir: bool, rep: &mut Reporter) -> Result<(), String> {
    // Each file with the server's modification time (seconds), kept on the copy.
    let mut jobs: Vec<(String, PathBuf, Option<u64>)> = Vec::new();
    if is_dir {
        let mut seen = HashSet::new();
        let mut stack = vec![(remote.to_string(), local.to_path_buf())];
        while let Some((rdir, ldir)) = stack.pop() {
            rep.check()?;
            tokio::fs::create_dir_all(&ldir).await.map_err(|e| format!("로컬 폴더를 만들 수 없습니다: {e}"))?;
            for e in list_sftp(sftp, &rdir).await? {
                // Server-supplied names must stay one local path component, and
                // linked folders are not followed (a link to . or .. never ends).
                let Some(name) =
                    local_component(&e.name).filter(|_| !(e.is_dir && e.is_link) && !undecodable(&e.name))
                else {
                    rep.skipped += 1;
                    continue;
                };
                let target = ldir.join(name);
                if !claim(&mut seen, &target) {
                    rep.skipped += 1;
                    continue;
                }
                if e.is_dir {
                    stack.push((e.path, target));
                } else {
                    rep.total += e.size;
                    jobs.push((e.path, target, e.modified));
                }
            }
        }
    } else {
        let meta = sftp.metadata(remote.to_string()).await.ok();
        rep.total = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        jobs.push((remote.to_string(), local.to_path_buf(), meta.and_then(|m| m.mtime).map(u64::from)));
    }
    sftp_parallel(jobs, rep, |(rpath, lpath, modified): (String, PathBuf, Option<u64>), mut lane| async move {
        let mut buf = vec![0u8; CHUNK];
        lane.start_file(rpath.clone());
        let part = partial_path(&lpath);
        let res = sftp_fetch(sftp, &rpath, &part, &mut buf, &mut lane).await;
        let res = finish_partial(res, &part, &lpath);
        if res.is_ok() {
            keep_modified(&lpath, modified);
            lane.file_finished();
        }
        (res, lane)
    })
    .await
}

async fn sftp_fetch(sftp: &SftpSession, rpath: &str, part: &Path, buf: &mut [u8], rep: &mut Reporter) -> Result<(), String> {
    let mut src = sftp.open(rpath.to_string()).await.map_err(|e| format!("{rpath} 를 열 수 없습니다: {e}"))?;
    let mut dst = tokio::fs::File::create(part)
        .await
        .map_err(|e| format!("{} 를 만들 수 없습니다: {e}", part.display()))?;
    loop {
        let n = src.read(buf).await.map_err(|e| format!("읽기 오류: {e}"))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(|e| format!("쓰기 오류: {e}"))?;
        rep.add(n)?;
    }
    dst.flush().await.map_err(|e| format!("쓰기 오류: {e}"))?;
    if worth_syncing(&dst).await {
        dst.sync_all().await.map_err(|e| format!("쓰기 오류: {e}"))?;
    }
    Ok(())
}

/// A downloaded file keeps the server's modification time (as Explorer's copy
/// keeps a file's), so logs and configs sort and compare by when they were
/// written, not when they were fetched. Best effort: a file that cannot be
/// opened for writing (read-only) keeps the download time; the download
/// itself has succeeded either way. SFTP only, both ways (keep_remote_modified):
/// its times are exact seconds, while an FTP listing can give minutes or just
/// a date.
fn keep_modified(path: &Path, secs: Option<u64>) {
    let Some(secs) = secs.filter(|&s| s > 0) else { return };
    let at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = f.set_modified(at);
    }
}

/// A local file's modification time in whole seconds (none for 0 or past 2106).
fn local_secs(path: &Path) -> Option<u32> {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| u32::try_from(d.as_secs()).ok())
        .filter(|&s| s > 0)
}

/// An uploaded file keeps the local file's modification time on the server
/// (keep_modified's other way): only the times are set (ACMODTIME; access
/// time as the modification time, as Windows often does not keep access
/// times), never the permissions or the owner. Best effort: a server that
/// refuses (a file owned by someone else) keeps the upload time.
/// `before`/`after`: the local file's time read before and after sending; a
/// file rewritten meanwhile keeps the upload time (the server has bytes of
/// neither version for sure, and the same time would later pass for the same file).
async fn keep_remote_modified(sftp: &SftpSession, before: Option<u32>, after: Option<u32>, rpath: &str) {
    let Some(secs) = before.filter(|&b| Some(b) == after) else { return };
    let attrs = russh_sftp::protocol::FileAttributes { atime: Some(secs), mtime: Some(secs), ..Default::default() };
    let _ = sftp.set_metadata(rpath.to_string(), attrs).await;
}

/// Large downloads are flushed to disk before they replace the old file; for
/// small ones the per-file wait dominated folders of many files.
const SYNC_FROM: u64 = 8 * 1024 * 1024;

async fn worth_syncing(f: &tokio::fs::File) -> bool {
    f.metadata().await.map(|m| m.len() >= SYNC_FROM).unwrap_or(true)
}

/// Downloads land in a hidden, uniquely named ".<name>.<random>.bxpart" next to
/// the target and replace it only once complete, so a cancelled or failed
/// transfer never destroys an existing file (nor a real file named *.bxpart).
pub(crate) fn partial_path(target: &Path) -> PathBuf {
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    target.with_file_name(format!(".{name}.{}.bxpart", rand_tag()))
}

fn finish_partial(res: Result<(), String>, part: &Path, target: &Path) -> Result<(), String> {
    match res {
        Ok(()) => std::fs::rename(part, target).map_err(|e| {
            let _ = std::fs::remove_file(part);
            format!("{} 로 저장할 수 없습니다: {e}", target.display())
        }),
        Err(e) => {
            let _ = std::fs::remove_file(part);
            Err(e)
        }
    }
}

async fn sftp_upload(sftp: &SftpSession, local: &Path, remote: &str, is_dir: bool, rep: &mut Reporter) -> Result<(), String> {
    let mut jobs: Vec<(PathBuf, String)> = Vec::new();
    if is_dir {
        // Walking a big local tree (or a share) is blocking file-system work.
        let root = local.to_path_buf();
        let tree = tauri::async_runtime::spawn_blocking(move || walk_local(&root)).await.map_err(|e| e.to_string())??;
        rep.total = tree.total;
        rep.skipped += tree.skipped;
        let _ = sftp.create_dir(remote.to_string()).await;
        let mut dirs = tree.dirs;
        dirs.sort_by_key(|d| d.matches('/').count());
        for d in dirs {
            let _ = sftp.create_dir(join_remote(remote, &d)).await;
        }
        for (abs, rel) in tree.files {
            jobs.push((abs, join_remote(remote, &rel)));
        }
    } else {
        rep.total = std::fs::metadata(local).map(|m| m.len()).unwrap_or(0);
        jobs.push((local.to_path_buf(), remote.to_string()));
    }
    sftp_parallel(jobs, rep, |(lpath, rpath): (PathBuf, String), mut lane| async move {
        let mut buf = vec![0u8; CHUNK];
        lane.start_file(lpath.to_string_lossy().into_owned());
        // The time of the bytes about to be sent (read before them, not after).
        let before = local_secs(&lpath);
        let res = sftp_put(sftp, Source::File(&lpath), &rpath, &mut buf, &mut lane).await;
        if res.is_ok() {
            keep_remote_modified(sftp, before, local_secs(&lpath), &rpath).await;
            lane.file_finished();
        }
        (res, lane)
    })
    .await
}

/// Where an upload's bytes come from: a local file, or text from the editor.
#[derive(Clone, Copy)]
enum Source<'a> {
    File(&'a Path),
    Bytes(&'a [u8]),
}

impl<'a> Source<'a> {
    async fn open_async(self) -> Result<Box<dyn tokio::io::AsyncRead + Unpin + Send + 'a>, String> {
        Ok(match self {
            Source::File(p) => Box::new(
                tokio::fs::File::open(p).await.map_err(|e| format!("{} 를 열 수 없습니다: {e}", p.display()))?,
            ),
            Source::Bytes(b) => Box::new(b),
        })
    }

    fn open(self) -> Result<Box<dyn Read + 'a>, String> {
        Ok(match self {
            Source::File(p) => Box::new(std::fs::File::open(p).map_err(|e| format!("{} 를 열 수 없습니다: {e}", p.display()))?),
            Source::Bytes(b) => Box::new(b),
        })
    }
}

/// The staged copy `tmp` owned (uid and gid) as the file it will replace,
/// where the server lets the session do so: root saving an application's
/// config file leaves it the application's, not root's. Nothing when the
/// owner is not known (a new file, a server that does not say) or cannot be
/// given back (a user saving another's file by group write): the file then
/// becomes the saver's, as it always did; never written in place for it,
/// which would leave the original cut short if the save failed. Both ids
/// are set together: the protocol sends them as a pair (one missing is 0).
async fn give_owner_back(sftp: &SftpSession, tmp: &str, existing: Option<&russh_sftp::client::fs::Metadata>) {
    let Some((uid, gid)) = existing.and_then(|m| Some((m.uid?, m.gid?))) else {
        return;
    };
    let owned = |m: &russh_sftp::client::fs::Metadata| m.uid == Some(uid) && m.gid == Some(gid);
    if sftp.metadata(tmp.to_string()).await.is_ok_and(|m| owned(&m)) {
        return;
    }
    let attrs = russh_sftp::protocol::FileAttributes { uid: Some(uid), gid: Some(gid), ..Default::default() };
    let _ = sftp.set_metadata(tmp.to_string(), attrs).await;
}

/// Upload one file without ever leaving a truncated file at `rpath`: write a
/// hidden temporary next to it, then swap it into place (keeping the old
/// file's permissions, and its owner where the session may set it). A
/// symlink target is written through to keep the link; a folder that lets
/// files be replaced but not created is written in place.
async fn sftp_put(sftp: &SftpSession, source: Source<'_>, rpath: &str, buf: &mut [u8], rep: &mut Reporter) -> Result<(), String> {
    let mut src = source.open_async().await?;
    let existing = sftp.symlink_metadata(rpath.to_string()).await.ok();
    if existing.as_ref().is_some_and(|m| m.file_type().is_dir()) {
        return Err(format!("{rpath} 는 폴더라서 파일로 덮어쓸 수 없습니다"));
    }
    let is_link = existing.as_ref().is_some_and(|m| m.file_type().is_symlink());
    let tmp = remote_temp(rpath, "bxpart");
    // Folders where we may replace files but not create new ones fall back to
    // writing in place.
    let (mut dst, staged) = match (!is_link).then_some(()) {
        Some(()) => {
            // Replacing a file whose mode is restored before the swap: the
            // copy stays its owner's alone while written (a 0600 secret is
            // not readable under the umask's 0644 meanwhile). A new file
            // gets the server's default, as before.
            let attrs = russh_sftp::protocol::FileAttributes {
                permissions: existing.as_ref().and_then(|m| m.permissions).map(|_| 0o600),
                ..russh_sftp::protocol::FileAttributes::empty()
            };
            let flags = russh_sftp::protocol::OpenFlags::CREATE | russh_sftp::protocol::OpenFlags::TRUNCATE | russh_sftp::protocol::OpenFlags::WRITE;
            match sftp.open_with_flags_and_attributes(tmp.clone(), flags, attrs).await {
                Ok(f) => {
                    // Owned as the file it replaces where that can be done
                    // (root saving an account's file); else as before.
                    give_owner_back(sftp, &tmp, existing.as_ref()).await;
                    (f, true)
                }
                Err(_) => (sftp.create(rpath.to_string()).await.map_err(|e| format!("{rpath} 를 만들 수 없습니다: {e}"))?, false),
            }
        }
        None => (sftp.create(rpath.to_string()).await.map_err(|e| format!("{rpath} 를 만들 수 없습니다: {e}"))?, false),
    };
    let copied: Result<(), String> = async {
        loop {
            let n = src.read(buf).await.map_err(|e| format!("읽기 오류: {e}"))?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await.map_err(|e| format!("쓰기 오류: {e}"))?;
            rep.add(n)?;
        }
        dst.shutdown().await.map_err(|e| format!("업로드를 마무리할 수 없습니다: {e}"))
    }
    .await;
    drop(dst);
    if !staged {
        return copied;
    }
    if let Err(e) = copied {
        let _ = sftp.remove_file(tmp).await;
        return Err(e);
    }
    if let Some(perm) = existing.as_ref().and_then(|m| m.permissions) {
        let attrs = russh_sftp::protocol::FileAttributes { permissions: Some(perm & 0o7777), ..Default::default() };
        let _ = sftp.set_metadata(tmp.clone(), attrs).await;
    }
    if existing.is_none() {
        return match sftp.rename(tmp.clone(), rpath.to_string()).await {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = sftp.remove_file(tmp).await;
                Err(format!("{rpath} 로 저장할 수 없습니다: {e}"))
            }
        };
    }
    // SFTP v3 rename never replaces: move the old file aside, then swap.
    let old = remote_temp(rpath, "bxold");
    if let Err(e) = sftp.rename(rpath.to_string(), old.clone()).await {
        let _ = sftp.remove_file(tmp).await;
        return Err(format!("{rpath} 를 바꿀 수 없습니다: {e}"));
    }
    if let Err(e) = sftp.rename(tmp.clone(), rpath.to_string()).await {
        let _ = sftp.rename(old, rpath.to_string()).await;
        let _ = sftp.remove_file(tmp).await;
        return Err(format!("{rpath} 로 저장할 수 없습니다: {e}"));
    }
    let _ = sftp.remove_file(old).await;
    Ok(())
}

/// Wraps a reader to report progress (FTP upload path).
struct CountingReader<'a, R> {
    inner: R,
    rep: &'a mut Reporter,
}

impl<R: Read> Read for CountingReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.rep
            .add(n)
            .map_err(std::io::Error::other)?;
        Ok(n)
    }
}

fn ftp_download(ftp: &mut dyn FtpOps, remote: &str, local: &Path, is_dir: bool, rep: &mut Reporter) -> Result<(), String> {
    let mut jobs: Vec<(String, PathBuf)> = Vec::new();
    if is_dir {
        let mut seen = HashSet::new();
        let mut stack = vec![(remote.to_string(), local.to_path_buf())];
        while let Some((rdir, ldir)) = stack.pop() {
            rep.check()?;
            std::fs::create_dir_all(&ldir).map_err(|e| format!("로컬 폴더를 만들 수 없습니다: {e}"))?;
            for e in list_ftp(ftp, &rdir)? {
                let Some(name) =
                    local_component(&e.name).filter(|_| !(e.is_dir && e.is_link) && !undecodable(&e.name))
                else {
                    rep.skipped += 1;
                    continue;
                };
                let target = ldir.join(name);
                if !claim(&mut seen, &target) {
                    rep.skipped += 1;
                    continue;
                }
                if e.is_dir {
                    stack.push((e.path, target));
                } else {
                    rep.total += e.size;
                    jobs.push((e.path, target));
                }
            }
        }
    } else {
        rep.total = ftp.size(remote).map(|s| s as u64).unwrap_or(0);
        jobs.push((remote.to_string(), local.to_path_buf()));
    }
    for (rpath, lpath) in jobs {
        rep.check()?;
        rep.file = rpath.clone();
        let part = partial_path(&lpath);
        let mut dst = std::fs::File::create(&part).map_err(|e| format!("{} 를 만들 수 없습니다: {e}", part.display()))?;
        let res = ftp.retr_with(&rpath, &mut |stream| {
            let mut buf = vec![0u8; CHUNK];
            loop {
                let n = stream.read(&mut buf).map_err(suppaftp::FtpError::ConnectionError)?;
                if n == 0 {
                    return Ok(());
                }
                dst.write_all(&buf[..n]).map_err(suppaftp::FtpError::ConnectionError)?;
                rep.add(n).map_err(|e| {
                    suppaftp::FtpError::ConnectionError(std::io::Error::other(e))
                })?;
            }
        });
        let res = res
            .map_err(|e| format!("{rpath} 다운로드 실패: {e}"))
            .and_then(|()| {
                let big = dst.metadata().map(|m| m.len() >= SYNC_FROM).unwrap_or(true);
                if big { dst.sync_all().map_err(|e| format!("쓰기 오류: {e}")) } else { Ok(()) }
            });
        drop(dst);
        finish_partial(res, &part, &lpath)?;
        rep.files_done += 1;
    }
    Ok(())
}

fn ftp_upload(ftp: &mut dyn FtpOps, local: &Path, remote: &str, is_dir: bool, rep: &mut Reporter) -> Result<(), String> {
    let mut jobs: Vec<(PathBuf, String)> = Vec::new();
    if is_dir {
        let tree = walk_local(local)?;
        rep.total = tree.total;
        rep.skipped += tree.skipped;
        let _ = ftp.mkdir(remote);
        let mut dirs = tree.dirs;
        dirs.sort_by_key(|d| d.matches('/').count());
        for d in dirs {
            let _ = ftp.mkdir(&join_remote(remote, &d));
        }
        for (abs, rel) in tree.files {
            jobs.push((abs, join_remote(remote, &rel)));
        }
    } else {
        rep.total = std::fs::metadata(local).map(|m| m.len()).unwrap_or(0);
        jobs.push((local.to_path_buf(), remote.to_string()));
    }
    let mut stats = FtpStatCache::default();
    for (lpath, rpath) in jobs {
        rep.check()?;
        rep.file = lpath.to_string_lossy().into_owned();
        let existing = stats.stat(ftp, &rpath)?;
        ftp_put(ftp, Source::File(&lpath), &rpath, existing, rep)?;
        rep.files_done += 1;
    }
    Ok(())
}

/// Upload one file via a hidden temporary name and swap it into place, so a
/// failed or cancelled upload never truncates the existing remote file.
/// `existing` is what the server listed under `rpath` (None: nothing).
fn ftp_put(ftp: &mut dyn FtpOps, source: Source<'_>, rpath: &str, existing: Option<FtpStat>, rep: &mut Reporter) -> Result<(), String> {
    let open = || source.open();
    if existing.as_ref().is_some_and(|s| s.is_dir && !s.is_link) {
        return Err(format!("{rpath} 는 폴더라서 파일로 덮어쓸 수 없습니다"));
    }
    // A link is written through (in place), so the link itself survives.
    if existing.as_ref().is_some_and(|s| s.is_link) {
        return ftp
            .put(rpath, &mut CountingReader { inner: open()?, rep })
            .map(|_| ())
            .map_err(|e| format!("{rpath} 업로드 실패: {e}"));
    }
    let tmp = remote_temp(rpath, "bxpart");
    let before = rep.done;
    let staged = ftp.put(&tmp, &mut CountingReader { inner: open()?, rep: &mut *rep });
    if let Err(e) = staged {
        // The control connection may be out of sync now; the caller reconnects
        // and removes the temp file then.
        rep.leftover = Some(tmp.clone());
        let _ = ftp.rm(&tmp);
        // The server cleanly refused to create the temp name (no permission
        // to create new files, but the existing one may be writable): fall back
        // to writing in place. Any other failure (network, TLS, data channel)
        // must not lead to a STOR that could truncate the real file.
        let refused = matches!(&e, suppaftp::FtpError::UnexpectedResponse(r)
            if matches!(r.status, suppaftp::Status::FileUnavailable | suppaftp::Status::BadFilename | suppaftp::Status::StoringNeedAccount | suppaftp::Status::RequestFileActionIgnored));
        if refused && rep.done == before && !rep.cancel.load(Ordering::Relaxed) {
            return ftp
                .put(rpath, &mut CountingReader { inner: open()?, rep })
                .map(|_| ())
                .map_err(|e| format!("{rpath} 업로드 실패: {e}"));
        }
        return Err(format!("{rpath} 업로드 실패: {e}"));
    }
    let old = remote_temp(rpath, "bxold");
    let had_old = ftp.rename(rpath, &old).is_ok();
    if let Err(e) = ftp.rename(&tmp, rpath) {
        if had_old {
            let _ = ftp.rename(&old, rpath);
        }
        let _ = ftp.rm(&tmp);
        return Err(format!("{rpath} 로 저장할 수 없습니다: {e}"));
    }
    if had_old {
        let _ = ftp.rm(&old);
    }
    // The new file got the server's default mode: give it the old one back
    // (servers without SITE CHMOD just keep their default).
    if let Some(mode) = existing.and_then(|s| s.mode) {
        let _ = ftp.command(&format!("SITE CHMOD {mode:o} {rpath}"), &[suppaftp::Status::CommandOk]);
    }
    Ok(())
}

// ---- built-in editor: whole text files ------------------------------------------------

/// Largest file the built-in editor opens.
const EDIT_MAX: u64 = 5 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    text: String,
    /// The file started with a UTF-8 byte order mark (kept on save).
    bom: bool,
    /// (modified seconds, size) when read; a save checks it is unchanged.
    stamp: (u64, u64),
}

/// Modification time and size of a remote file, to detect changes by others.
/// A file's stamp now, as the editor's save compares it (remote_write_text):
/// for telling the editor the file changed on the server since it was read.
#[tauri::command]
pub async fn remote_file_stamp(state: State<'_, RemoteState>, id: String, path: String) -> Result<(u64, u64), String> {
    decodable(&path)?;
    let remote = conn(&state, &id)?;
    remote_stamp(&remote, &path).await
}

async fn remote_stamp(remote: &Arc<Remote>, path: &str) -> Result<(u64, u64), String> {
    match remote.as_ref() {
        Remote::Sftp { sftp, .. } => sftp_stamp(sftp, path).await,
        Remote::Ftp { .. } => {
            let r = remote.clone();
            let path = path.to_string();
            tauri::async_runtime::spawn_blocking(move || {
                let Remote::Ftp { conn, opts, .. } = r.as_ref() else { unreachable!() };
                let mut ftp = lock_ftp(conn, opts);
                // MDTM has second resolution (LIST often only minutes); fall
                // back to the listing for servers without it.
                let size = ftp.size(&path).ok().map(|s| s as u64);
                // MDTM is "YYYYMMDDHHMMSS" (UTC); convert to epoch seconds so it
                // shares the LIST fallback's unit. Otherwise reading via MDTM and
                // rechecking via LIST (a server that supports MDTM only sometimes)
                // would compare unlike numbers and report a false conflict, or miss
                // a real change.
                let mdtm = ftp
                    .command(&format!("MDTM {path}"), &[suppaftp::Status::File])
                    .ok()
                    .and_then(|body| {
                        let t = body.split_whitespace().last()?.get(..14)?.to_string();
                        chrono::NaiveDateTime::parse_from_str(&t, "%Y%m%d%H%M%S").ok().map(|d| d.and_utc().timestamp().max(0) as u64)
                    });
                if let (Some(t), Some(s)) = (mdtm, size) {
                    return Ok((t, s));
                }
                // A refused SIZE/MDTM is normal; a timed-out one would shift replies.
                resync_ftp(&mut ftp, opts);
                let (dir, name) = path.rsplit_once('/').unwrap_or(("", path.as_str()));
                let dir = if dir.is_empty() { "/" } else { dir };
                list_ftp(ftp.as_mut(), dir)?
                    .into_iter()
                    .find(|e| e.name == name)
                    .map(|e| (e.modified.unwrap_or(0), e.size))
                    .ok_or_else(|| format!("{path} 를 찾을 수 없습니다"))
            })
            .await
            .map_err(|e| e.to_string())?
        }
    }
}

/// Decode a file for editing: UTF-8 (BOM kept aside). Binary data and other
/// encodings are refused rather than silently changed on save.
fn decode_for_edit(bytes: Vec<u8>) -> Result<(String, bool), String> {
    let (body, bom) = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        Some(rest) => (rest.to_vec(), true),
        None => (bytes, false),
    };
    if body.contains(&0) {
        return Err("텍스트 파일이 아니라 편집할 수 없습니다".into());
    }
    String::from_utf8(body)
        .map(|t| (t, bom))
        .map_err(|_| "UTF-8이 아닌 파일이라 내장 편집기로 열 수 없습니다. 다운로드해서 편집하세요.".into())
}

/// Read a file for the editor with the stamp that goes with what was read:
/// stamped before and after the read, and (SFTP, whose size is the bytes')
/// the size against the bytes. A file being written meanwhile (a "sudo cp"
/// in the terminal) is read again, up to three times, so a save later is
/// checked against the stamp of the text the editor holds; still changing,
/// it is refused rather than given a stamp of another moment.
#[tauri::command]
pub async fn remote_read_text(state: State<'_, RemoteState>, id: String, path: String) -> Result<TextFile, String> {
    decodable(&path)?;
    let remote = conn(&state, &id)?;
    for _ in 0..3 {
        let stamp = remote_stamp(&remote, &path).await?;
        if stamp.1 > EDIT_MAX {
            return Err("5MB보다 큰 파일은 내장 편집기로 열 수 없습니다".into());
        }
        let bytes = read_for_edit(&remote, &path).await?;
        if bytes.len() as u64 > EDIT_MAX {
            return Err("5MB보다 큰 파일은 내장 편집기로 열 수 없습니다".into());
        }
        if read_matches_stamp(stamp, remote_stamp(&remote, &path).await?, bytes.len(), matches!(remote.as_ref(), Remote::Sftp { .. })) {
            let (text, bom) = decode_for_edit(bytes)?;
            return Ok(TextFile { text, bom, stamp });
        }
    }
    Err("파일이 바뀌는 중이라 읽지 못했습니다. 잠시 뒤 다시 여세요".into())
}

/// Whether bytes read between two stamps are the file as `before` names it:
/// the stamp unchanged, and over SFTP (a size in bytes; an FTP SIZE may count
/// ASCII-mode bytes) as many bytes as it says, unless it gave no size (0).
fn read_matches_stamp(before: (u64, u64), after: (u64, u64), read: usize, sized: bool) -> bool {
    before == after && (!sized || after.1 == 0 || after.1 == read as u64)
}

/// An SFTP file's (modified time, size) as its stat gives them (0 where it
/// gives none).
async fn sftp_stamp(sftp: &SftpSession, path: &str) -> Result<(u64, u64), String> {
    let m = sftp.metadata(path.to_string()).await.map_err(|e| format!("{path} 정보를 읽을 수 없습니다: {e}"))?;
    Ok((m.mtime.map(u64::from).unwrap_or(0), m.size.unwrap_or(0)))
}

/// An SFTP file's bytes for the editor, at most EDIT_MAX + 1.
async fn sftp_read_for_edit(sftp: &SftpSession, path: &str) -> Result<Vec<u8>, String> {
    let mut f = sftp.open(path.to_string()).await.map_err(|e| format!("{path} 를 열 수 없습니다: {e}"))?;
    let mut out = Vec::new();
    (&mut f).take(EDIT_MAX + 1).read_to_end(&mut out).await.map_err(|e| format!("읽기 오류: {e}"))?;
    Ok(out)
}

/// A file's bytes for the editor, at most EDIT_MAX + 1 (a larger one is told).
async fn read_for_edit(remote: &Arc<Remote>, path: &str) -> Result<Vec<u8>, String> {
    let path = path.to_string();
    let bytes = match remote.as_ref() {
        Remote::Sftp { sftp, .. } => sftp_read_for_edit(sftp, &path).await?,
        Remote::Ftp { .. } => {
            let r = remote.clone();
            let p = path.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let Remote::Ftp { conn, opts, .. } = r.as_ref() else { unreachable!() };
                let mut ftp = lock_ftp(conn, opts);
                let mut out = Vec::new();
                let res = ftp.retr_with(&p, &mut |s| {
                    s.take(EDIT_MAX + 1).read_to_end(&mut out).map(|_| ()).map_err(suppaftp::FtpError::ConnectionError)
                });
                if res.is_err() {
                    reopen_ftp(&mut ftp, opts);
                }
                res.map(|()| out).map_err(|e| format!("{p} 를 읽을 수 없습니다: {e}"))
            })
            .await
            .map_err(|e| e.to_string())??
        }
    };
    Ok(bytes)
}

/// Save editor text. Unless `force`, refuses with `CONFLICT::` when the file
/// changed on the server since it was read (`stamp`). Returns the new stamp.
#[tauri::command]
pub async fn remote_write_text(
    state: State<'_, RemoteState>,
    id: String,
    path: String,
    text: String,
    bom: bool,
    stamp: Option<(u64, u64)>,
    force: bool,
) -> Result<(u64, u64), String> {
    let remote = conn(&state, &id)?;
    if !force
        && let (Some(expected), Ok(now)) = (stamp, remote_stamp(&remote, &path).await)
            && expected != now {
                return Err("CONFLICT::".into());
            }
    let mut bytes = Vec::with_capacity(text.len() + 3);
    if bom {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(text.as_bytes());
    let mut rep = Reporter {
        app: None,
        id: String::new(),
        cancel: Arc::new(AtomicBool::new(false)),
        done: 0,
        total: bytes.len() as u64,
        files_done: 0,
        skipped: 0,
        leftover: None,
        file: path.clone(),
        last: Instant::now(),
        lanes: None,
    };
    match remote.as_ref() {
        Remote::Sftp { sftp, .. } => {
            let mut buf = vec![0u8; CHUNK];
            sftp_put(sftp, Source::Bytes(&bytes), &path, &mut buf, &mut rep).await?;
        }
        Remote::Ftp { .. } => {
            let r = remote.clone();
            let p = path.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let Remote::Ftp { conn, opts, .. } = r.as_ref() else { unreachable!() };
                let mut ftp = lock_ftp(conn, opts);
                let res = ftp_stat(ftp.as_mut(), &p).and_then(|existing| ftp_put(ftp.as_mut(), Source::Bytes(&bytes), &p, existing, &mut rep));
                if res.is_err() {
                    reopen_ftp(&mut ftp, opts);
                    if let Some(tmp) = rep.leftover.take() {
                        let _ = ftp.rm(&tmp);
                    }
                }
                res
            })
            .await
            .map_err(|e| e.to_string())??;
        }
    }
    remote_stamp(&remote, &path).await
}

// ---- local file system ------------------------------------------------------------

#[tauri::command]
pub fn local_home() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "C:\\".into())
}

/// Run local file-system work off the UI thread (slow disks, network drives).
async fn off_ui<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// List a local folder. An empty path lists the drive roots.
#[tauri::command]
pub async fn local_list(path: String) -> Result<Vec<FileEntry>, String> {
    off_ui(move || local_list_blocking(&path)).await
}

fn local_list_blocking(path: &str) -> Result<Vec<FileEntry>, String> {
    if path.is_empty() {
        // The drive bitmask needs no I/O; probing each letter would stall on
        // disconnected network or empty removable drives.
        let mask = unsafe { windows_sys::Win32::Storage::FileSystem::GetLogicalDrives() };
        return Ok((0..26u8)
            .filter(|i| mask & (1 << i) != 0)
            .map(|i| format!("{}:\\", (b'A' + i) as char))
            .map(|p| FileEntry {
                name: p.clone(),
                path: p,
                is_dir: true,
                is_link: false,
                size: 0,
                modified: None,
                perm: None,
            })
            .collect());
    }
    let rd = std::fs::read_dir(path).map_err(|e| format!("폴더를 읽을 수 없습니다: {e}"))?;
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let is_link = meta.file_type().is_symlink();
        // A DirEntry's metadata describes the link itself; follow it so linked
        // folders (junctions) can be opened. Broken links stay plain entries.
        let meta = if is_link { std::fs::metadata(entry.path()).unwrap_or(meta) } else { meta };
        out.push(FileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            is_link,
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
            perm: None,
        });
    }
    Ok(out)
}

/// A fresh private folder for editing one remote file locally. Returns the
/// full local path the file should be downloaded to.
#[tauri::command]
pub fn edit_temp_path(name: String) -> Result<String, String> {
    // The name must be a single valid Windows file name (no separators, devices,
    // trailing dots), so a remote name can neither escape nor alias the folder.
    let file = local_component(&name).ok_or_else(|| "Windows에서 쓸 수 없는 파일 이름이라 편집으로 열 수 없습니다".to_string())?;
    // The file is opened with its default Windows action; for these types that
    // action runs it instead of editing it.
    if runs_when_opened(file) {
        return Err("실행 파일이나 스크립트는 외부 앱으로 열 수 없습니다. 내장 편집기를 사용하세요.".into());
    }
    prune_edit_temp(Duration::from_secs(3 * 24 * 3600));
    let nonce = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = edit_root().join(format!("{nonce:x}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("임시 폴더를 만들 수 없습니다: {e}"))?;
    Ok(dir.join(file).to_string_lossy().into_owned())
}

/// File types whose default "open" action executes them (PATHEXT plus other
/// script and shortcut types Windows runs on double-click).
pub(crate) fn runs_when_opened(name: &str) -> bool {
    const RUN: [&str; 30] = [
        "exe", "com", "bat", "cmd", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msc", "ps1", "psm1", "hta", "lnk",
        "url", "scr", "msi", "msp", "pif", "cpl", "reg", "jar", "application", "appref-ms", "gadget", "inf", "scf",
        "settingcontent-ms", "library-ms",
    ];
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    let pathext = std::env::var("PATHEXT").unwrap_or_default().to_ascii_lowercase();
    RUN.contains(&ext.as_str()) || pathext.split(';').any(|p| p.trim_start_matches('.') == ext && !ext.is_empty())
}

fn edit_root() -> PathBuf {
    std::env::temp_dir().join("BananaConn").join("edit")
}

/// Remove edit folders left behind by earlier runs: those whose newest content
/// is older than `age`. Saving a file in place does not touch its folder's
/// time, so the files inside decide, not the folder.
fn prune_edit_temp(age: Duration) {
    let Ok(dirs) = std::fs::read_dir(edit_root()) else { return };
    for d in dirs.flatten() {
        if !d.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let newest = std::iter::once(d.path())
            .chain(std::fs::read_dir(d.path()).into_iter().flatten().flatten().map(|f| f.path()))
            .filter_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
            .max();
        if newest.and_then(|t| t.elapsed().ok()).is_some_and(|e| e > age) {
            let _ = std::fs::remove_dir_all(d.path());
        }
    }
}

/// Delete the private folder of a finished edit. Only folders directly under
/// the edit root are accepted.
#[tauri::command]
pub async fn edit_temp_release(path: String) -> Result<(), String> {
    off_ui(move || {
        let root = edit_root().canonicalize().map_err(|e| e.to_string())?;
        let Some(dir) = Path::new(&path).parent().and_then(|d| d.canonicalize().ok()) else { return Ok(()) };
        if dir.parent() != Some(root.as_path()) {
            return Err("편집 임시 폴더가 아닙니다".into());
        }
        std::fs::remove_dir_all(&dir).map_err(|e| format!("임시 파일을 지울 수 없습니다: {e}"))
    })
    .await
}

/// Modification time (ms since epoch) and size of a local file, for change detection.
#[tauri::command]
pub async fn local_stat(path: String) -> Result<(u64, u64), String> {
    off_ui(move || local_stat_blocking(&path)).await
}

fn local_stat_blocking(path: &str) -> Result<(u64, u64), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("파일 정보를 읽을 수 없습니다: {e}"))?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok((modified, meta.len()))
}

/// SHA-256 and SHA-512 of a local file (lower-case hex), read a piece at a
/// time in one pass: to check an image against the value its vendor publishes
/// before it is uploaded to a device.
#[tauri::command]
pub async fn local_hash(path: String) -> Result<(String, String), String> {
    off_ui(move || local_hash_blocking(&path)).await
}

fn local_hash_blocking(p: &str) -> Result<(String, String), String> {
    use std::io::Read;
    let mut file = std::fs::File::open(p).map_err(|e| format!("{p} 를 읽을 수 없습니다: {e}"))?;
    let mut sha256 = ring::digest::Context::new(&ring::digest::SHA256);
    let mut sha512 = ring::digest::Context::new(&ring::digest::SHA512);
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("{p} 를 읽을 수 없습니다: {e}"))?;
        if n == 0 {
            break;
        }
        sha256.update(&buf[..n]);
        sha512.update(&buf[..n]);
    }
    let hex = |d: ring::digest::Digest| d.as_ref().iter().map(|b| format!("{b:02x}")).collect::<String>();
    Ok((hex(sha256.finish()), hex(sha512.finish())))
}

#[tauri::command]
pub async fn local_op(window: tauri::WebviewWindow, op: String, path: String, target: Option<String>) -> Result<(), String> {
    // The window owns the shell's question before a permanent delete (no
    // Recycle Bin there): as a number, a window handle is not Send.
    let owner = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    off_ui(move || local_op_blocking(&op, &path, target, owner)).await
}

/// Delete a file or folder (with its contents) into the Recycle Bin, as
/// Explorer does, so a mistake can be undone. Where there is no Recycle Bin
/// (a network share, some removable drives) or the item is too large for it,
/// the shell asks before deleting it for good (FOF_WANTNUKEWARNING), owned by
/// the app's window; declining leaves it in place.
fn recycle(path: &Path, owner: isize) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOF_WANTNUKEWARNING, FO_DELETE, SHFILEOPSTRUCTW};
    use std::path::{Component, Prefix};
    // A relative path would be taken from the process's current folder.
    if !path.is_absolute() {
        return Err("작업에 실패했습니다: 전체 경로가 아닙니다".into());
    }
    // The shell reads "*" and "?" as wildcards and follows "..": a path is
    // only ever one listed item, named as it is (a "." inside still names the
    // same item; Path's components skip it). (A listed name never
    // holds them: Windows does not allow "*" or "?" in a name.)
    let plain = path.components().all(|c| match c {
        Component::Prefix(p) => !matches!(p.kind(), Prefix::Verbatim(_) | Prefix::VerbatimUNC(..) | Prefix::VerbatimDisk(_)),
        Component::RootDir => true,
        Component::Normal(n) => !n.to_string_lossy().contains(['*', '?']),
        Component::CurDir | Component::ParentDir => false,
    });
    // The shell takes no "\\?\" path and nothing of MAX_PATH (260) or more:
    // said plainly, never deleted for good some other way instead.
    let long = path.as_os_str().encode_wide().count() >= 260;
    if long || path.as_os_str().to_string_lossy().starts_with(r"\\?\") {
        return Err("경로가 너무 길어 휴지통으로 보낼 수 없습니다 (260자 이상). 탐색기에서 지우거나 이름을 줄이세요".into());
    }
    if !plain {
        return Err("작업에 실패했습니다: 이 경로는 지울 수 없습니다".into());
    }
    // The list of paths ends with two NULs: this one path, then an empty one.
    let from: Vec<u16> = path.as_os_str().encode_wide().chain([0, 0]).collect();
    let mut op = SHFILEOPSTRUCTW {
        hwnd: owner as _,
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT | FOF_WANTNUKEWARNING) as u16,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    // SAFETY: `from` is a double-NUL-terminated UTF-16 list that outlives the
    // call; no target, name mappings or title are used.
    let code = unsafe { SHFileOperationW(&mut op) };
    if op.fAnyOperationsAborted != 0 {
        return Err("삭제하지 않았습니다 (영구 삭제를 취소함)".into());
    }
    if code != 0 {
        return Err(format!("작업에 실패했습니다: 코드 {code:#x}"));
    }
    // The shell reports some refusals as success: it is gone or it is not.
    if path.symlink_metadata().is_ok() {
        return Err("작업에 실패했습니다: 삭제되지 않았습니다".into());
    }
    Ok(())
}

/// Rename that fails if the target exists (std::fs::rename silently replaces
/// it on Windows). A case-only rename of the same file still works.
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let wide = |p: &Path| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let (f, t) = (wide(from), wide(to));
    // SAFETY: both buffers are NUL-terminated UTF-16 and outlive the call.
    let ok = unsafe { windows_sys::Win32::Storage::FileSystem::MoveFileExW(f.as_ptr(), t.as_ptr(), 0) };
    if ok == 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
}

fn local_op_blocking(op: &str, path: &str, target: Option<String>, owner: isize) -> Result<(), String> {
    // A drive or share root has no parent: never delete or rename one.
    if matches!(op, "rename" | "delete") && Path::new(path).parent().is_none() {
        return Err("드라이브 전체는 지우거나 이름을 바꿀 수 없습니다".into());
    }
    let res = match op {
        "mkdir" => std::fs::create_dir(path),
        "rename" => {
            let to = PathBuf::from(target.unwrap_or_default());
            if to.file_name().and_then(|n| n.to_str()).and_then(local_component).is_none() {
                return Err("Windows에서 쓸 수 없는 이름입니다".into());
            }
            return rename_no_replace(Path::new(path), &to).map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists || e.raw_os_error() == Some(183) {
                    "같은 이름이 이미 있습니다".to_string()
                } else {
                    format!("작업에 실패했습니다: {e}")
                }
            });
        }
        "delete" => return recycle(Path::new(path), owner),
        _ => return Err("알 수 없는 작업입니다".into()),
    };
    res.map_err(|e| format!("작업에 실패했습니다: {e}"))
}

/// Test helper: in active FTP mode, download `file` and upload `data` as up.bin
/// through the app's own FTP code. Returns (downloaded, uploaded).
#[cfg(test)]
pub fn test_active_ftp(port: u16, user: &str, pw: &str, file: &str, data: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let opts = FtpOptions {
        host: "127.0.0.1".into(),
        port,
        username: user.into(),
        password: Some(pw.into()),
        active: true,
        security: FtpSecurity::Plain,
        allow_invalid_cert: false,
        trusted_cert: None,
        proxy: None,
        proxy_auth: Default::default(),
    };
    let (mut ftp, _) = open_ftp(&opts)?;
    let mut down = Vec::new();
    ftp.retr_with(file, &mut |s| s.read_to_end(&mut down).map(|_| ()).map_err(suppaftp::FtpError::ConnectionError))
        .map_err(|e| e.to_string())?;
    ftp.put("up.bin", &mut std::io::Cursor::new(data.to_vec())).map_err(|e| e.to_string())?;
    let _ = ftp.quit();
    Ok((down, data.to_vec()))
}

/// Test helper: connect with an isolated known_hosts file and list the home folder.
#[cfg(test)]
pub async fn test_connect_sftp(req: &ConnectRequest) -> Result<Vec<FileEntry>, String> {
    let kh = std::env::temp_dir().join("bananaconn-test-known_hosts");
    if req.trusted_fingerprint.is_none() {
        let _ = std::fs::remove_file(&kh);
    }
    let (remote, connected) = connect_sftp(req, &req.username, req.password.clone(), None, kh, Default::default()).await?;
    let Remote::Sftp { sftp, .. } = &remote else { unreachable!() };
    list_sftp(sftp, &connected.home).await
}

/// Test helper: an SFTP connection to 127.0.0.1:port as sf/sf-pass.
#[cfg(test)]
async fn test_sftp_connect(port: u16, trusted_fingerprint: Option<String>, known_hosts: &Path) -> Result<Remote, String> {
    let req = ConnectRequest {
        id: "t".into(),
        protocol: "sftp".into(),
        host: "127.0.0.1".into(),
        port: Some(port),
        username: "sf".into(),
        credential_id: None,
        password: Some("sf-pass".into()),
        trusted_fingerprint,
        active_mode: false,
        ftps_mode: None,
        allow_invalid_cert: false,
        trusted_cert: None,
        proxy: None,
    };
    let (conn, _) = connect_sftp(&req, &req.username, req.password.clone(), None, known_hosts.to_path_buf(), Default::default()).await?;
    Ok(conn)
}

/// Test helper: "New file" (remote_op "newfile") over SFTP at `path`.
#[cfg(test)]
pub async fn test_sftp_new_file(port: u16, trusted_fingerprint: Option<String>, known_hosts: &Path, path: &str) -> Result<(), String> {
    let conn = test_sftp_connect(port, trusted_fingerprint, known_hosts).await?;
    let Remote::Sftp { sftp, .. } = &conn else { unreachable!() };
    new_sftp_file(sftp, path).await
}

/// Test helper: upload or download a folder over SFTP (several files at once)
/// to 127.0.0.1:port as sf/sf-pass; returns (files, bytes, time taken).
#[cfg(test)]
pub async fn test_sftp_folder(
    port: u16,
    trusted_fingerprint: Option<String>,
    known_hosts: &Path,
    remote: &str,
    local: &Path,
    upload: bool,
) -> Result<(u32, u64, Duration), String> {
    let conn = test_sftp_connect(port, trusted_fingerprint, known_hosts).await?;
    let Remote::Sftp { sftp, .. } = &conn else { unreachable!() };
    let mut rep = Reporter {
        app: None,
        id: String::new(),
        cancel: Arc::new(AtomicBool::new(false)),
        done: 0,
        total: 0,
        files_done: 0,
        skipped: 0,
        leftover: None,
        file: String::new(),
        last: Instant::now(),
        lanes: None,
    };
    let started = Instant::now();
    if upload {
        sftp_upload(sftp, local, remote, true, &mut rep).await?;
    } else {
        sftp_download(sftp, remote, local, true, &mut rep).await?;
    }
    Ok((rep.files_done, rep.done, started.elapsed()))
}

/// Test helper: log in as demo/password, list root, download readme.txt.
/// `security`: "plain", "explicit" or "implicit".
#[cfg(test)]
pub fn test_connect_ftp(host: &str, port: u16, security: &str) -> Result<(Vec<FileEntry>, String), String> {
    let opts = FtpOptions {
        host: host.into(),
        port,
        username: "demo".into(),
        password: Some("password".into()),
        active: false,
        security: match security {
            "explicit" => FtpSecurity::Explicit,
            "implicit" => FtpSecurity::Implicit,
            _ => FtpSecurity::Plain,
        },
        allow_invalid_cert: false,
        trusted_cert: None,
        proxy: None,
        proxy_auth: Default::default(),
    };
    let (remote, connected) = connect_ftp(&opts)?;
    let Remote::Ftp { conn, .. } = remote else { unreachable!() };
    let mut ftp = conn.into_inner().unwrap();
    let entries = list_ftp(ftp.as_mut(), &connected.home)?;
    let mut readme = Vec::new();
    ftp.retr_with("/readme.txt", &mut |r| {
        r.read_to_end(&mut readme).map(|_| ()).map_err(suppaftp::FtpError::ConnectionError)
    })
    .map_err(|e| e.to_string())?;
    Ok((entries, String::from_utf8_lossy(&readme).into_owned()))
}

/// The file tab's SFTP operations against a server in memory, as the real
/// protocol carries them (russh-sftp's own server over a pipe): what a save
/// does to the file it replaces (content, permissions, owner) and leaves
/// behind, chmod, and a new file.
#[cfg(test)]
mod sftp_server_tests {
    use super::*;
    use russh_sftp::protocol::{Attrs, Data, File as Entry, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode};
    use std::collections::{HashMap, HashSet};

    #[derive(Clone)]
    struct Node {
        data: Vec<u8>,
        perm: u32,
        uid: u32,
        gid: u32,
    }

    /// A file system and the session's rights: `uid` its user, `root` whether
    /// it may give files to others. Every open is logged (path, truncate,
    /// permissions asked).
    #[derive(Default)]
    struct Fs {
        files: HashMap<String, Node>,
        uid: u32,
        root: bool,
        fail_writes: bool,
        opens: Vec<(String, bool, Option<u32>)>,
        /// Folders, and links (name → target), beside the files.
        dirs: HashSet<String>,
        links: HashMap<String, String>,
        /// The folder lets files be replaced, not created (a drop box with
        /// fixed names): an open that would create one is refused.
        no_new_files: bool,
        /// A link's text as readlink gives it, where it is not the target
        /// path in `links` (a relative one).
        link_text: HashMap<String, String>,
        /// How realpath answers: 0 not at all, 1 the path tidied only, 2 links followed.
        realpath: u8,
        /// Paths whose stat is refused (a folder this user may not enter);
        /// their lstat too when `lstat_denied`.
        denied: HashSet<String>,
        lstat_denied: bool,
    }

    impl Fs {
        /// A name with its links followed (one step is enough here).
        fn resolve(&self, path: &str) -> String {
            self.links.get(path).cloned().unwrap_or_else(|| path.to_string())
        }
        fn attrs(&self, path: &str, follow: bool) -> Option<FileAttributes> {
            if !follow && self.links.contains_key(path) {
                return Some(FileAttributes { permissions: Some(0o120777), ..FileAttributes::empty() });
            }
            let path = self.resolve(path);
            if self.dirs.contains(&path) {
                return Some(FileAttributes { permissions: Some(0o040755), ..FileAttributes::empty() });
            }
            let n = self.files.get(&path)?;
            Some(FileAttributes { size: Some(n.data.len() as u64), uid: Some(n.uid), gid: Some(n.gid), permissions: Some(0o100000 | n.perm), ..FileAttributes::empty() })
        }
        /// The names right inside `dir`.
        fn children(&self, dir: &str) -> Vec<String> {
            let prefix = format!("{dir}/");
            let all = self.files.keys().chain(self.dirs.iter()).chain(self.links.keys());
            all.filter(|p| p.strip_prefix(&prefix).is_some_and(|rest| !rest.is_empty() && !rest.contains('/'))).cloned().collect()
        }
    }

    struct Server {
        fs: Arc<Mutex<Fs>>,
        handles: HashMap<String, String>,
        next: u32,
        /// An open folder's listing, until it has been read once.
        listings: HashMap<String, Option<Vec<Entry>>>,
    }

    fn ok(id: u32) -> Status {
        Status { id, status_code: StatusCode::Ok, error_message: "Ok".into(), language_tag: "en-US".into() }
    }

    impl russh_sftp::server::Handler for Server {
        type Error = StatusCode;
        fn unimplemented(&self) -> StatusCode {
            StatusCode::OpUnsupported
        }
        async fn open(&mut self, id: u32, filename: String, pflags: OpenFlags, attrs: FileAttributes) -> Result<Handle, StatusCode> {
            let mut fs = self.fs.lock().unwrap();
            fs.opens.push((filename.clone(), pflags.contains(OpenFlags::TRUNCATE), attrs.permissions));
            // Opened through a link: its target.
            let filename = fs.resolve(&filename);
            let (uid, exists) = (fs.uid, fs.files.contains_key(&filename));
            if !exists && fs.no_new_files {
                return Err(StatusCode::PermissionDenied);
            }
            // "Create, not open": refused for a name taken (v3 says no more).
            if exists && pflags.contains(OpenFlags::EXCLUDE) {
                return Err(StatusCode::Failure);
            }
            if !exists {
                if !pflags.contains(OpenFlags::CREATE) {
                    return Err(StatusCode::NoSuchFile);
                }
                // Created as the session's own, with the mode asked for or the umask's.
                fs.files.insert(filename.clone(), Node { data: Vec::new(), perm: attrs.permissions.unwrap_or(0o644) & 0o7777, uid, gid: uid });
            } else if pflags.contains(OpenFlags::TRUNCATE) {
                fs.files.get_mut(&filename).unwrap().data.clear();
            }
            self.next += 1;
            let handle = self.next.to_string();
            self.handles.insert(handle.clone(), filename);
            Ok(Handle { id, handle })
        }
        async fn close(&mut self, id: u32, handle: String) -> Result<Status, StatusCode> {
            self.handles.remove(&handle);
            Ok(ok(id))
        }
        async fn read(&mut self, id: u32, handle: String, offset: u64, len: u32) -> Result<Data, StatusCode> {
            let path = self.handles.get(&handle).cloned().ok_or(StatusCode::Failure)?;
            let fs = self.fs.lock().unwrap();
            let node = fs.files.get(&path).ok_or(StatusCode::NoSuchFile)?;
            let start = offset as usize;
            // Past the end: EOF, as SFTP v3 ends a read.
            if start >= node.data.len() {
                return Err(StatusCode::Eof);
            }
            let end = (start + len as usize).min(node.data.len());
            Ok(Data { id, data: node.data[start..end].to_vec() })
        }
        async fn write(&mut self, id: u32, handle: String, offset: u64, data: Vec<u8>) -> Result<Status, StatusCode> {
            let path = self.handles.get(&handle).cloned().ok_or(StatusCode::Failure)?;
            let mut fs = self.fs.lock().unwrap();
            if fs.fail_writes {
                return Err(StatusCode::Failure);
            }
            let node = fs.files.get_mut(&path).ok_or(StatusCode::NoSuchFile)?;
            let end = offset as usize + data.len();
            if node.data.len() < end {
                node.data.resize(end, 0);
            }
            node.data[offset as usize..end].copy_from_slice(&data);
            Ok(ok(id))
        }
        async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
            let refused = {
                let fs = self.fs.lock().unwrap();
                fs.lstat_denied && fs.denied.contains(&path)
            };
            if refused {
                return Err(StatusCode::PermissionDenied);
            }
            let attrs = self.fs.lock().unwrap().attrs(&path, false).ok_or(StatusCode::NoSuchFile)?;
            Ok(Attrs { id, attrs })
        }
        async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
            if self.fs.lock().unwrap().denied.contains(&path) {
                return Err(StatusCode::PermissionDenied);
            }
            let attrs = self.fs.lock().unwrap().attrs(&path, true).ok_or(StatusCode::NoSuchFile)?;
            Ok(Attrs { id, attrs })
        }
        async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, StatusCode> {
            let fs = self.fs.lock().unwrap();
            let dir = fs.resolve(&path);
            if !fs.dirs.contains(&dir) {
                return Err(StatusCode::NoSuchFile);
            }
            // Listed with each entry's own attributes (a link as a link), under
            // the name asked for, as a server lists a linked folder.
            let entries = fs
                .children(&dir)
                .into_iter()
                .map(|p| {
                    let name = p.rsplit('/').next().unwrap().to_string();
                    Entry { filename: name.clone(), longname: name, attrs: fs.attrs(&p, false).unwrap() }
                })
                .collect();
            drop(fs);
            self.next += 1;
            let handle = self.next.to_string();
            self.listings.insert(handle.clone(), Some(entries));
            Ok(Handle { id, handle })
        }
        async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, StatusCode> {
            match self.listings.get_mut(&handle).and_then(Option::take) {
                Some(files) => Ok(Name { id, files }),
                None => Err(StatusCode::Eof),
            }
        }
        async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, StatusCode> {
            let mut fs = self.fs.lock().unwrap();
            if !fs.dirs.contains(&path) || !fs.children(&path).is_empty() {
                return Err(StatusCode::Failure);
            }
            fs.dirs.remove(&path);
            Ok(ok(id))
        }
        async fn setstat(&mut self, id: u32, path: String, attrs: FileAttributes) -> Result<Status, StatusCode> {
            let mut fs = self.fs.lock().unwrap();
            let (me, root) = (fs.uid, fs.root);
            let n = fs.files.get_mut(&path).ok_or(StatusCode::NoSuchFile)?;
            if let (Some(uid), Some(gid)) = (attrs.uid, attrs.gid) {
                // chown: root only (a group of one's own aside, not modelled).
                if !root && (uid != me || gid != n.gid) {
                    return Err(StatusCode::PermissionDenied);
                }
                n.uid = uid;
                n.gid = gid;
            }
            if let Some(p) = attrs.permissions {
                n.perm = p & 0o7777;
            }
            Ok(ok(id))
        }
        async fn rename(&mut self, id: u32, oldpath: String, newpath: String) -> Result<Status, StatusCode> {
            let mut fs = self.fs.lock().unwrap();
            // SFTP v3: never onto an existing name.
            if fs.files.contains_key(&newpath) {
                return Err(StatusCode::Failure);
            }
            let n = fs.files.remove(&oldpath).ok_or(StatusCode::NoSuchFile)?;
            fs.files.insert(newpath, n);
            Ok(ok(id))
        }
        async fn remove(&mut self, id: u32, filename: String) -> Result<Status, StatusCode> {
            let mut fs = self.fs.lock().unwrap();
            // A link goes as a link, never its target; a folder is no file.
            if fs.links.remove(&filename).is_none() {
                fs.files.remove(&filename).ok_or(StatusCode::Failure)?;
            }
            Ok(ok(id))
        }
        async fn readlink(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
            let fs = self.fs.lock().unwrap();
            let text = fs.link_text.get(&path).or_else(|| fs.links.get(&path)).cloned().ok_or(StatusCode::NoSuchFile)?;
            Ok(Name { id, files: vec![Entry { filename: text.clone(), longname: text, attrs: FileAttributes::empty() }] })
        }
        async fn realpath(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
            let fs = self.fs.lock().unwrap();
            let real = match fs.realpath {
                1 => path,
                // As some servers write it: a slash after a folder.
                2 => format!("{}/", fs.resolve(&path)),
                _ => return Err(StatusCode::OpUnsupported),
            };
            Ok(Name { id, files: vec![Entry { filename: real.clone(), longname: real, attrs: FileAttributes::empty() }] })
        }
    }

    async fn session(fs: Arc<Mutex<Fs>>) -> SftpSession {
        let (client, server) = tokio::io::duplex(1 << 16);
        tokio::spawn(russh_sftp::server::run(server, Server { fs, handles: HashMap::new(), next: 0, listings: HashMap::new() }));
        SftpSession::new(client).await.unwrap()
    }

    fn reporter() -> Reporter {
        Reporter { app: None, id: String::new(), cancel: Arc::new(AtomicBool::new(false)), done: 0, total: 3, files_done: 0, skipped: 0, leftover: None, file: String::new(), last: Instant::now(), lanes: None }
    }

    fn with(uid: u32, root: bool, file: Option<Node>) -> Arc<Mutex<Fs>> {
        let mut fs = Fs { uid, root, ..Fs::default() };
        if let Some(n) = file {
            fs.files.insert("/etc/app/app.conf".into(), n);
        }
        Arc::new(Mutex::new(fs))
    }

    async fn save(fs: &Arc<Mutex<Fs>>) -> Result<(), String> {
        let sftp = session(fs.clone()).await;
        let mut buf = vec![0u8; 64];
        sftp_put(&sftp, Source::Bytes(b"new"), "/etc/app/app.conf", &mut buf, &mut reporter()).await
    }

    fn only_the_file(fs: &Fs) -> Node {
        assert_eq!(fs.files.len(), 1, "temp files left: {:?}", fs.files.keys().collect::<Vec<_>>());
        fs.files["/etc/app/app.conf"].clone()
    }

    /// A deploy layout: /srv/app/current → releases/v2 (a folder), conf →
    /// ../shared/app.conf (a file), old → /gone (broken).
    fn deploy(realpath: u8) -> Arc<Mutex<Fs>> {
        let mut fs = Fs { realpath, ..Fs::default() };
        fs.dirs.extend(["/srv".to_string(), "/srv/app".into(), "/srv/app/releases".into(), "/srv/app/releases/v2".into(), "/srv/shared".into()]);
        fs.files.insert("/srv/shared/app.conf".into(), Node { data: b"x".to_vec(), perm: 0o644, uid: 0, gid: 0 });
        fs.links.insert("/srv/app/current".into(), "/srv/app/releases/v2".into());
        fs.link_text.insert("/srv/app/current".into(), "releases/v2".into());
        fs.links.insert("/srv/app/conf".into(), "/srv/shared/app.conf".into());
        fs.link_text.insert("/srv/app/conf".into(), "../shared/app.conf".into());
        fs.links.insert("/srv/app/old".into(), "/gone".into());
        Arc::new(Mutex::new(fs))
    }

    async fn target_of(fs: &Arc<Mutex<Fs>>, path: &str) -> (String, String, bool, bool) {
        let t = link_target(&session(fs.clone()).await, path).await.unwrap();
        (t.target, t.resolved, t.exists, t.is_dir)
    }

    /// The link's text, taken from its folder, when the server does not
    /// resolve links itself (no realpath, or one that only tidies the path).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_link_leads_where_its_text_says() {
        for realpath in [0, 1] {
            let fs = deploy(realpath);
            assert_eq!(target_of(&fs, "/srv/app/current").await, ("releases/v2".into(), "/srv/app/releases/v2".into(), true, true));
            assert_eq!(target_of(&fs, "/srv/app/conf").await, ("../shared/app.conf".into(), "/srv/shared/app.conf".into(), true, false));
            assert_eq!(target_of(&fs, "/srv/app/old").await, ("/gone".into(), "/gone".into(), false, false));
        }
    }

    /// A server that resolves links is believed over the text: a folder on the
    /// way may be a link itself, which ".." in the text does not see.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_servers_resolution_wins() {
        let fs = deploy(2);
        fs.lock().unwrap().links.insert("/srv/app/current".into(), "/data/v2".into());
        fs.lock().unwrap().dirs.insert("/data/v2".into());
        assert_eq!(target_of(&fs, "/srv/app/current").await, ("releases/v2".into(), "/data/v2".into(), true, true));
        // Broken: nothing to resolve to, the text it is.
        assert_eq!(target_of(&fs, "/srv/app/old").await.1, "/gone");
        // Not a link at all: said so, not guessed.
        assert!(link_target(&session(fs.clone()).await, "/srv/shared/app.conf").await.is_err());
    }

    /// One path looked up on its own: a file, a link to a folder (as a folder,
    /// and a link), nothing, and a path this user may not look at (an error).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_path_is_looked_up_on_its_own() {
        let fs = deploy(0);
        let sftp = session(fs.clone()).await;
        let f = stat_sftp(&sftp, "/srv/shared/app.conf").await.unwrap().unwrap();
        assert_eq!((f.name.as_str(), f.is_dir, f.is_link, f.size), ("app.conf", false, false, 1));
        let d = stat_sftp(&sftp, "/srv/app/current").await.unwrap().unwrap();
        assert_eq!((d.is_dir, d.is_link), (true, true));
        assert!(stat_sftp(&sftp, "/srv/nothing").await.unwrap().is_none());
        fs.lock().unwrap().denied.insert("/srv/shared/app.conf".into());
        fs.lock().unwrap().lstat_denied = true;
        assert!(stat_sftp(&sftp, "/srv/shared/app.conf").await.is_err());
    }

    /// A target this user may not look at is not called broken.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_target_out_of_reach_is_not_broken() {
        let fs = deploy(0);
        fs.lock().unwrap().denied.insert("/srv/app/current".into());
        // An error to show, not a link said to lead nowhere.
        assert!(link_target(&session(fs.clone()).await, "/srv/app/current").await.is_err());
    }

    #[test]
    fn remote_paths_are_tidied() {
        for (path, want) in [("/a/./b//c/", "/a/b/c"), ("/a/b/../c", "/a/c"), ("/../x", "/x"), ("/", "/"), ("/a/..", "/")] {
            assert_eq!(normalize_remote(path), want, "{path}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn root_saving_an_accounts_file_keeps_it_theirs() {
        let fs = with(0, true, Some(Node { data: b"old".to_vec(), perm: 0o640, uid: 1001, gid: 1001 }));
        save(&fs).await.unwrap();
        let fs = fs.lock().unwrap();
        let n = only_the_file(&fs);
        assert_eq!((n.data.as_slice(), n.perm, n.uid, n.gid), (b"new".as_slice(), 0o640, 1001, 1001));
        // Written to a temp copy made owner-only, never the file truncated in place.
        assert!(fs.opens.iter().all(|(p, ..)| p != "/etc/app/app.conf"), "{:?}", fs.opens);
        assert_eq!(fs.opens[0].2, Some(0o600));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_user_saving_anothers_file_replaces_it_whole() {
        let fs = with(1000, false, Some(Node { data: b"old".to_vec(), perm: 0o664, uid: 1001, gid: 1001 }));
        save(&fs).await.unwrap();
        let fs = fs.lock().unwrap();
        let n = only_the_file(&fs);
        // Its owner cannot be given back: the saver's, as always; its mode kept.
        assert_eq!((n.data.as_slice(), n.perm, n.uid), (b"new".as_slice(), 0o664, 1000));
        assert!(fs.opens.iter().all(|(p, ..)| p != "/etc/app/app.conf"), "{:?}", fs.opens);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_save_leaves_the_file_as_it_was() {
        let fs = with(0, true, Some(Node { data: b"old".to_vec(), perm: 0o600, uid: 1001, gid: 1001 }));
        fs.lock().unwrap().fail_writes = true;
        assert!(save(&fs).await.is_err());
        let fs = fs.lock().unwrap();
        let n = only_the_file(&fs);
        assert_eq!((n.data.as_slice(), n.perm, n.uid), (b"old".as_slice(), 0o600, 1001));
    }

    /// The editor's read over SFTP: the bytes as they are (CRLF, a BOM, more
    /// than one read's worth), and the stamp taken around them matches them;
    /// a file grown between two stamps does not.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_editor_reads_a_file_with_its_own_stamp() {
        let mut big = b"\xEF\xBB\xBFline one\r\n".to_vec();
        big.extend(std::iter::repeat_n(b'x', 200_000));
        for data in [b"a: 1\r\nb: 2\n".to_vec(), Vec::new(), big] {
            let fs = with(0, true, Some(Node { data: data.clone(), perm: 0o644, uid: 0, gid: 0 }));
            let sftp = session(fs.clone()).await;
            let before = sftp_stamp(&sftp, "/etc/app/app.conf").await.unwrap();
            let read = sftp_read_for_edit(&sftp, "/etc/app/app.conf").await.unwrap();
            let after = sftp_stamp(&sftp, "/etc/app/app.conf").await.unwrap();
            assert_eq!(read, data);
            assert_eq!(before.1, data.len() as u64);
            assert!(read_matches_stamp(before, after, read.len(), true));
        }
        // Written to between the stamps (a "sudo cp" under way).
        let fs = with(0, true, Some(Node { data: b"old".to_vec(), perm: 0o644, uid: 0, gid: 0 }));
        let sftp = session(fs.clone()).await;
        let before = sftp_stamp(&sftp, "/etc/app/app.conf").await.unwrap();
        let read = sftp_read_for_edit(&sftp, "/etc/app/app.conf").await.unwrap();
        fs.lock().unwrap().files.get_mut("/etc/app/app.conf").unwrap().data = b"new text".to_vec();
        let after = sftp_stamp(&sftp, "/etc/app/app.conf").await.unwrap();
        assert!(!read_matches_stamp(before, after, read.len(), true));
    }

    /// chmod as the file tab sends it ("권한 변경", "chmod +x"): three digits
    /// keep setuid, setgid and sticky; four set them too; anything else is
    /// refused before the server is asked.
    #[tokio::test(flavor = "multi_thread")]
    async fn chmod_keeps_special_bits_with_three_digits() {
        let fs = with(0, true, Some(Node { data: b"x".to_vec(), perm: 0o4644, uid: 0, gid: 0 }));
        let sftp = session(fs.clone()).await;
        let path = "/etc/app/app.conf";
        let perm = |fs: &Arc<Mutex<Fs>>| fs.lock().unwrap().files[path].perm;
        chmod_sftp(&sftp, path, "755").await.unwrap();
        assert_eq!(perm(&fs), 0o4755);
        chmod_sftp(&sftp, path, "0750").await.unwrap();
        assert_eq!(perm(&fs), 0o750);
        chmod_sftp(&sftp, path, "2750").await.unwrap();
        assert_eq!(perm(&fs), 0o2750);
        for bad in ["", "75", "8", "77777", "rwx", "-755"] {
            assert!(chmod_sftp(&sftp, path, bad).await.is_err(), "{bad:?} taken");
        }
        assert_eq!(perm(&fs), 0o2750);
        // The name is the target's, as chmod follows a link; a missing one says so.
        assert!(chmod_sftp(&sftp, "/etc/app/none", "644").await.unwrap_err().contains("/etc/app/none"));
    }

    /// "새 파일": made only where the name is free, never over a file there.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_new_file_never_replaces_one_there() {
        let fs = with(1000, false, Some(Node { data: b"keep".to_vec(), perm: 0o600, uid: 1000, gid: 1000 }));
        let sftp = session(fs.clone()).await;
        assert_eq!(new_sftp_file(&sftp, "/etc/app/app.conf").await.unwrap_err(), "같은 이름이 이미 있습니다");
        new_sftp_file(&sftp, "/etc/app/new.txt").await.unwrap();
        let fs = fs.lock().unwrap();
        assert_eq!(fs.files["/etc/app/app.conf"].data, b"keep");
        assert!(fs.files["/etc/app/new.txt"].data.is_empty());
    }

    /// A folder tree, with a link to a folder and one to a file elsewhere:
    /// /srv/app/{a.txt, sub/b.txt, data → /srv/shared, conf → /srv/shared/keep.conf}.
    fn tree() -> Arc<Mutex<Fs>> {
        let file = |s: &str| Node { data: s.as_bytes().to_vec(), perm: 0o644, uid: 1000, gid: 1000 };
        let mut fs = Fs { uid: 1000, ..Fs::default() };
        for d in ["/srv", "/srv/app", "/srv/app/sub", "/srv/shared"] {
            fs.dirs.insert(d.into());
        }
        for f in ["/srv/app/a.txt", "/srv/app/sub/b.txt", "/srv/shared/keep.conf", "/srv/shared/x.txt"] {
            fs.files.insert(f.into(), file(f));
        }
        fs.links.insert("/srv/app/data".into(), "/srv/shared".into());
        fs.links.insert("/srv/app/conf".into(), "/srv/shared/keep.conf".into());
        fs.links.insert("/srv/link".into(), "/srv/shared".into());
        Arc::new(Mutex::new(fs))
    }

    /// Deleting a folder takes it and everything in it, links as links: what
    /// they point to, outside it, is left whole.
    #[tokio::test(flavor = "multi_thread")]
    async fn deleting_a_folder_never_follows_its_links() {
        let fs = tree();
        let sftp = session(fs.clone()).await;
        delete_sftp_tree(&sftp, "/srv/app").await.unwrap();
        let fs = fs.lock().unwrap();
        let mut left: Vec<&str> = fs.files.keys().chain(fs.dirs.iter()).chain(fs.links.keys()).map(String::as_str).collect();
        left.sort_unstable();
        assert_eq!(left, ["/srv", "/srv/link", "/srv/shared", "/srv/shared/keep.conf", "/srv/shared/x.txt"]);
    }

    /// A link to a folder, deleted, goes alone: the folder it points to stays full.
    #[tokio::test(flavor = "multi_thread")]
    async fn deleting_a_link_to_a_folder_leaves_the_folder() {
        let fs = tree();
        let sftp = session(fs.clone()).await;
        delete_sftp_tree(&sftp, "/srv/link").await.unwrap();
        let fs = fs.lock().unwrap();
        assert!(!fs.links.contains_key("/srv/link"));
        assert!(fs.dirs.contains("/srv/shared") && fs.files.contains_key("/srv/shared/x.txt") && fs.files.contains_key("/srv/shared/keep.conf"));
    }

    /// A file saved through a link (/srv/app/conf → /srv/shared/keep.conf)
    /// changes the file it points to; the link stays a link, nothing is left.
    #[tokio::test(flavor = "multi_thread")]
    async fn saving_through_a_link_keeps_the_link() {
        let fs = tree();
        let sftp = session(fs.clone()).await;
        let mut buf = vec![0u8; 64];
        sftp_put(&sftp, Source::Bytes(b"new"), "/srv/app/conf", &mut buf, &mut reporter()).await.unwrap();
        let fs = fs.lock().unwrap();
        assert_eq!(fs.links["/srv/app/conf"], "/srv/shared/keep.conf");
        assert_eq!(fs.files["/srv/shared/keep.conf"].data, b"new");
        assert_eq!(fs.files.len(), 4, "{:?}", fs.files.keys().collect::<Vec<_>>());
    }

    /// A folder that lets a file be replaced but no new one made: saved in
    /// place, its mode and owner untouched, no temp file tried there twice.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_folder_without_new_files_is_written_in_place() {
        let fs = with(1000, false, Some(Node { data: b"old".to_vec(), perm: 0o640, uid: 1000, gid: 1000 }));
        fs.lock().unwrap().no_new_files = true;
        save(&fs).await.unwrap();
        let fs = fs.lock().unwrap();
        let n = only_the_file(&fs);
        assert_eq!((n.data.as_slice(), n.perm, n.uid), (b"new".as_slice(), 0o640, 1000));
        assert_eq!(fs.opens.len(), 2, "{:?}", fs.opens);
        assert_eq!(fs.opens[1].0, "/etc/app/app.conf");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_new_file_gets_the_servers_default_mode() {
        let fs = with(1000, false, None);
        save(&fs).await.unwrap();
        let fs = fs.lock().unwrap();
        let n = only_the_file(&fs);
        assert_eq!((n.data.as_slice(), n.perm, n.uid), (b"new".as_slice(), 0o644, 1000));
        assert_eq!(fs.opens[0].2, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bytes read for the editor go with the stamp taken before them only
    /// when the file did not change meanwhile: same stamp, and over SFTP as
    /// many bytes as its size (a server giving no size, 0, is not judged by it).
    #[test]
    fn read_matches_stamp_only_when_the_file_held_still() {
        assert!(read_matches_stamp((100, 5), (100, 5), 5, true));
        // Written meanwhile: a new time or size after the read.
        assert!(!read_matches_stamp((100, 5), (101, 5), 5, true));
        assert!(!read_matches_stamp((100, 5), (100, 9), 9, true));
        // Same stamp, other bytes: caught mid-write within the same second.
        assert!(!read_matches_stamp((100, 9), (100, 9), 4, true));
        // No size from the server; FTP sizes are not compared with the bytes.
        assert!(read_matches_stamp((100, 0), (100, 0), 7, true));
        assert!(read_matches_stamp((100, 9), (100, 9), 8, false));
    }

    /// A local delete goes to the Recycle Bin (and leaves nothing behind); a
    /// relative path is refused. Ignored by default: it puts a small file in
    /// the Recycle Bin of whoever runs it (`cargo test recycle -- --ignored`).
    #[test]
    #[ignore]
    fn local_delete_goes_to_the_recycle_bin() {
        let dir = std::env::temp_dir().join(format!("bananaconn-recycle-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("inner")).unwrap();
        std::fs::write(dir.join("inner").join("a.txt"), b"x").unwrap();
        recycle(&dir, 0).unwrap();
        assert!(!dir.exists());
        assert!(recycle(Path::new("relative-name.txt"), 0).is_err());
    }

    /// Paths the shell would read as more than the one item are refused before
    /// anything is deleted: wildcards, "..","\\?\" and MAX_PATH or
    /// more. Under a folder that does not exist, so a gap here deletes nothing.
    #[test]
    fn recycle_refuses_paths_the_shell_would_widen() {
        let none = std::env::temp_dir().join(format!("bananaconn-no-such-folder-{}", std::process::id()));
        assert!(!none.exists());
        for p in [none.join("*"), none.join("a?.txt"), none.join("sub").join("..")] {
            assert!(recycle(&p, 0).unwrap_err().contains("지울 수 없습니다"), "{}", p.display());
        }
        let verbatim = PathBuf::from(format!(r"\\?\{}", none.join("x").display()));
        assert!(recycle(&verbatim, 0).unwrap_err().contains("너무 길어"));
        let long = none.join("a".repeat(250));
        assert!(recycle(&long, 0).unwrap_err().contains("너무 길어"));
    }

    /// A fake FTP server answering from a script; `pasv` is its PASV reply.
    fn hostile_ftp(greeting: &'static str, pasv: &'static str) -> u16 {
        use std::io::{BufRead, BufReader, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let Ok((s, _)) = l.accept() else { return };
            let mut w = s.try_clone().unwrap();
            let _ = w.write_all(greeting.as_bytes());
            if pasv.is_empty() {
                return; // hang up right after the (partial) greeting
            }
            for line in BufReader::new(s).lines() {
                let Ok(line) = line else { break };
                let reply = match line.split(' ').next().unwrap_or("") {
                    "USER" => "331 pw\r\n",
                    "PASS" => "230 ok\r\n",
                    "TYPE" | "NOOP" => "200 ok\r\n",
                    "PWD" => "257 \"/\"\r\n",
                    "CWD" => "250 ok\r\n",
                    "PASV" => pasv,
                    "SIZE" => "213 99999999999999999999999999\r\n",
                    _ => "500 no\r\n",
                };
                if w.write_all(reply.as_bytes()).is_err() {
                    break;
                }
            }
        });
        port
    }

    fn ftp_opts(port: u16) -> FtpOptions {
        FtpOptions {
            host: "127.0.0.1".into(),
            port,
            username: "u".into(),
            password: Some("p".into()),
            active: false,
            security: FtpSecurity::Plain,
            allow_invalid_cert: false,
            trusted_cert: None,
            proxy: None,
            proxy_auth: Default::default(),
        }
    }

    /// A connection that could not be opened again stays dead: neither a
    /// resync after a failed command nor a reopen connects (logs in) again,
    /// however many commands fail after it (a walk, a queue of transfers).
    #[test]
    fn a_dead_ftp_connection_is_never_logged_in_again() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let opts = ftp_opts(listener.local_addr().unwrap().port());
        let mut ftp: Box<dyn FtpOps> = Box::new(DeadFtp);
        for _ in 0..5 {
            assert!(ftp.list().is_err());
            resync_ftp(&mut ftp, &opts);
            reopen_ftp(&mut ftp, &opts);
        }
        assert!(ftp.is_dead());
        assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock), "a dead connection connected again");
    }

    /// A server that accepts but never greets (wrong port, a hung NAS): every
    /// security mode gives up after the I/O timeout instead of waiting forever.
    #[test]
    #[ignore = "slow: waits out the 30 s FTP timeout three times"]
    fn a_silent_ftp_server_times_out() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for s in listener.incoming().flatten() {
                held.push(s);
            }
        });
        for security in [FtpSecurity::Plain, FtpSecurity::Explicit, FtpSecurity::Implicit] {
            let t = std::time::Instant::now();
            let res = open_ftp(&FtpOptions { security, ..ftp_opts(port) });
            assert!(res.is_err());
            // Implicit TLS can wait twice: the handshake, then the greeting.
            assert!(t.elapsed() < FTP_IO_TIMEOUT * 2 + Duration::from_secs(10), "{:?}", t.elapsed());
        }
    }

    #[test]
    fn malformed_ftp_replies_are_errors_not_crashes_or_hangs() {
        // Out-of-range PASV numbers and an overflowing SIZE used to panic.
        let port = hostile_ftp("220 hi\r\n", "227 Entering Passive Mode (256,0,0,1,4,1)\r\n");
        let (mut ftp, _) = open_ftp(&ftp_opts(port)).expect("login");
        assert!(list_ftp(ftp.as_mut(), "/").is_err());
        assert!(ftp.size("x").is_err());

        // A server closing in the middle of a multi-line reply used to make the
        // client spin forever.
        let port = hostile_ftp("220-welcome\r\n", "");
        let started = Instant::now();
        let res = std::thread::spawn(move || open_ftp(&ftp_opts(port)).map(|_| ()));
        std::thread::sleep(Duration::from_millis(50));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !res.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(res.is_finished(), "connect still hanging after {:?}", started.elapsed());
    }

    #[test]
    fn failed_download_keeps_the_existing_file() {
        let dir = std::env::temp_dir().join(format!("bx-part-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("data.txt");
        std::fs::write(&target, "original").unwrap();
        let part = partial_path(&target);
        let pname = part.file_name().unwrap().to_string_lossy().into_owned();
        assert!(pname.starts_with(".data.txt.") && pname.ends_with(".bxpart"), "{pname}");
        assert_ne!(partial_path(&target), part, "temp names must be unique");

        std::fs::write(&part, "trunc").unwrap();
        assert_eq!(finish_partial(Err("CANCELLED".into()), &part, &target), Err("CANCELLED".into()));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");
        assert!(!part.exists());

        std::fs::write(&part, "complete").unwrap();
        finish_partial(Ok(()), &part, &target).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "complete");
        assert!(!part.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_temp_paths_are_confined() {
        for bad in ["..", "a/b", "..\\x", "CON", "x:y", "trail.", "deploy.js", "run.BAT", "x.ps1", "s.lnk", "setup.exe"] {
            assert!(edit_temp_path(bad.into()).is_err(), "{bad}");
        }
        let ok = edit_temp_path("notes.txt".into()).unwrap();
        assert!(Path::new(&ok).starts_with(edit_root()));
        std::fs::write(&ok, "x").unwrap();
        tauri::async_runtime::block_on(edit_temp_release(ok.clone())).unwrap();
        assert!(!Path::new(&ok).parent().unwrap().exists());
        // Only folders directly under the edit root may be released.
        let outside = std::env::temp_dir().join(format!("bx-not-edit-{}", std::process::id())).join("f.txt");
        std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
        assert!(tauri::async_runtime::block_on(edit_temp_release(outside.to_string_lossy().into_owned())).is_err());
        assert!(outside.parent().unwrap().exists());
        let _ = std::fs::remove_dir_all(outside.parent().unwrap());
    }

    #[test]
    fn rejects_unsafe_local_names() {
        for bad in ["..\\..\\x.bat", "C:\\x", "a/b", "..", "CON", "nul.txt", "COM0", "lpt¹.txt", "CONIN$", "x.", "x ", "a\u{0}b", "a:b"] {
            assert!(local_component(bad).is_none(), "{bad:?}");
        }
        for ok in ["readme.txt", ".bashrc", "한글 파일.txt", "console.log"] {
            assert_eq!(local_component(ok), Some(ok));
        }
    }

    /// An FTP server in memory: LIST leaves out dot files (as vsftpd and
    /// Pure-FTPd do by default), STOR truncates and APPE appends.
    struct FakeFtp {
        files: HashMap<String, Vec<u8>>,
        cwd: String,
    }

    impl FtpOps for FakeFtp {
        fn cwd(&mut self, path: &str) -> FtpResult<()> {
            self.cwd = path.to_string();
            Ok(())
        }
        fn list(&mut self) -> FtpResult<Vec<String>> {
            Ok(self
                .files
                .iter()
                .filter_map(|(p, b)| {
                    let (dir, name) = split_remote(p);
                    (dir == self.cwd && !name.starts_with('.')).then(|| format!("-rw-r--r-- 1 u g {} Jan 01 00:00 {name}", b.len()))
                })
                .collect())
        }
        fn put(&mut self, path: &str, r: &mut dyn Read) -> FtpResult<u64> {
            let mut b = Vec::new();
            r.read_to_end(&mut b).unwrap();
            self.files.insert(path.to_string(), b);
            Ok(0)
        }
        fn append(&mut self, path: &str, r: &mut dyn Read) -> FtpResult<u64> {
            let mut b = Vec::new();
            r.read_to_end(&mut b).unwrap();
            self.files.entry(path.to_string()).or_default().extend(b);
            Ok(0)
        }
        fn rm(&mut self, _: &str) -> FtpResult<()> {
            unimplemented!()
        }
        fn rmdir(&mut self, _: &str) -> FtpResult<()> {
            unimplemented!()
        }
        fn mkdir(&mut self, _: &str) -> FtpResult<()> {
            unimplemented!()
        }
        fn rename(&mut self, _: &str, _: &str) -> FtpResult<()> {
            unimplemented!()
        }
        fn size(&mut self, _: &str) -> FtpResult<usize> {
            unimplemented!()
        }
        fn retr_with(&mut self, _: &str, _: &mut dyn FnMut(&mut dyn Read) -> FtpResult<()>) -> FtpResult<()> {
            unimplemented!()
        }
        fn quit(&mut self) -> FtpResult<()> {
            Ok(())
        }
        fn command(&mut self, _: &str, _: &[suppaftp::Status]) -> FtpResult<String> {
            unimplemented!()
        }
    }

    #[test]
    fn ftp_new_file_never_empties_an_existing_file() {
        let mut ftp = FakeFtp {
            files: HashMap::from([("/www/.htaccess".to_string(), b"deny from all\n".to_vec()), ("/www/index.html".to_string(), b"<html>".to_vec())]),
            cwd: "/".into(),
        };
        // Listed: refused.
        assert_eq!(new_ftp_file(&mut ftp, "/www/index.html"), Err("같은 이름이 이미 있습니다".into()));
        assert_eq!(ftp.files["/www/index.html"], b"<html>");
        // A dot file the listing leaves out: still left as it was.
        assert_eq!(new_ftp_file(&mut ftp, "/www/.htaccess"), Ok(()));
        assert_eq!(ftp.files["/www/.htaccess"], b"deny from all\n");
        // A free name: an empty file.
        assert_eq!(new_ftp_file(&mut ftp, "/www/new.txt"), Ok(()));
        assert_eq!(ftp.files["/www/new.txt"], b"");
    }

    #[test]
    fn formats_permissions_and_paths() {
        assert_eq!(perm_string(0o755, true), "drwxr-xr-x");
        assert_eq!(perm_string(0o640, false), "-rw-r-----");
        // st_mode with the file type bits, and the special bits as ls shows them.
        assert_eq!(perm_string(0o100755, false), "-rwxr-xr-x");
        assert_eq!(perm_string(0o4755, false), "-rwsr-xr-x");
        assert_eq!(perm_string(0o2644, false), "-rw-r-Sr--");
        assert_eq!(perm_string(0o1777, true), "drwxrwxrwt");
        assert_eq!(perm_string(0o1770, true), "drwxrwx--T");
        assert_eq!(parse_mode("755"), Some((0o755, false)));
        assert_eq!(parse_mode("0755"), Some((0o755, true)));
        assert_eq!(parse_mode("4755"), Some((0o4755, true)));
        assert_eq!(parse_mode("7555"), Some((0o7555, true)));
        for bad in ["", "75", "75a", "8755", "-755", "+x", "u+x", "07555", "７５５"] {
            assert_eq!(parse_mode(bad), None, "{bad}");
        }
        assert_eq!(join_remote("/", "a"), "/a");
        assert_eq!(join_remote("/home/u", "a"), "/home/u/a");
    }

    #[test]
    fn cert_fingerprints_and_pinning() {
        // SHA-256 of the empty input, lower-case colon hex.
        assert_eq!(
            cert_fingerprint(b""),
            "e3:b0:c4:42:98:fc:1c:14:9a:fb:f4:c8:99:6f:b9:24:27:ae:41:e4:64:9b:93:4c:a4:95:99:1b:78:52:b8:55"
        );
        assert_ne!(cert_fingerprint(b"a"), cert_fingerprint(b"b"));
        // A pinned fingerprint matches ignoring case and separators, and an
        // empty pin never matches (so it never silently accepts a certificate).
        let fp = cert_fingerprint(b"cert");
        assert!(same_fingerprint(&fp, &fp));
        assert!(same_fingerprint(&fp.replace(':', "").to_uppercase(), &fp));
        assert!(!same_fingerprint("", &fp));
        assert!(!same_fingerprint(&cert_fingerprint(b"other"), &fp));
    }

    #[test]
    fn a_download_keeps_the_server_time() {
        let path = std::env::temp_dir().join(format!("bx-keep-mtime-{}.txt", std::process::id()));
        std::fs::write(&path, b"x").unwrap();
        let secs = |p: &Path| std::fs::metadata(p).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        // 2023-11-14 22:13:20 UTC, as an SFTP listing gives it.
        keep_modified(&path, Some(1_700_000_000));
        assert_eq!(secs(&path), 1_700_000_000);
        // No time (or a zero one) from the server: the file is left as it is.
        keep_modified(&path, None);
        keep_modified(&path, Some(0));
        assert_eq!(secs(&path), 1_700_000_000);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn local_hash_of_known_text() {
        let p = std::env::temp_dir().join(format!("bananaconn-hash-{}.txt", std::process::id()));
        std::fs::write(&p, b"abc").unwrap();
        let (s256, s512) = local_hash_blocking(p.to_str().unwrap()).unwrap();
        let _ = std::fs::remove_file(&p);
        assert_eq!(s256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(s512, "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f");
        let missing = std::env::temp_dir().join("bananaconn-hash-no-such-file.bin");
        assert!(local_hash_blocking(missing.to_str().unwrap()).is_err());
    }
}
