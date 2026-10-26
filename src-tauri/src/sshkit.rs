//! OpenSSH for a Windows PC seen through RDP or VNC, in one step and without
//! internet on that PC (Windows 7 included): this app shares, for a while and
//! under a random path, a setup script and the Win32-OpenSSH package over
//! HTTP. The engineer pastes one line on the remote screen; the script
//! downloads what it needs from here, installs or reuses sshd, opens port 22
//! to this PC (on every network profile) and makes PowerShell the SSH shell, and reports
//! each step back so the app can open the SSH session when it is done.
//!
//! The package comes from github.com/PowerShell/Win32-OpenSSH the first time a
//! remote PC asks for it (this PC needs internet then) and is kept in the
//! app's local data folder; a zip copied there by hand works as well.

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

/// The share's port (another one when it is taken).
pub(crate) const SHARE_PORT: u16 = 47622;
/// The rule `ssh_kit_allow` keeps in this PC's Windows Firewall. It is not
/// removed when a share ends: it only lets one remote address reach the
/// share's port, nothing listens there between shares, and every later
/// allow replaces it (one rule, reused), so it never piles up and later
/// shares need no second administrator prompt for the same PC.
const RULE: &str = "BananaConn OpenSSH share";

/// How long a share stays open without being stopped.
const LIFETIME: Duration = Duration::from_secs(30 * 60);

/// The packages a remote PC may ask for: (served name, release tag, asset).
/// Windows 7 / Server 2008 R2 get an 8.x build; later Windows the newer one.
const PACKAGES: [(&str, &str, &str); 4] = [
    ("OpenSSH-Win64.zip", "v9.8.3.0p2-Preview", "OpenSSH-Win64.zip"),
    ("OpenSSH-Win32.zip", "v9.8.3.0p2-Preview", "OpenSSH-Win32.zip"),
    ("OpenSSH-Win64-legacy.zip", "v8.1.0.0p1-Beta", "OpenSSH-Win64.zip"),
    ("OpenSSH-Win32-legacy.zip", "v8.1.0.0p1-Beta", "OpenSSH-Win32.zip"),
];

/// The setup script (PowerShell 2.0 and later, ASCII only). `__BASE__` is the
/// share's URL. Steps are reported to `log`, the end to `done`.
///
/// Port 22 is opened only to this PC (the host of the share's URL, the
/// address this PC uses toward the remote one), on every profile because the
/// remote's network is often "Public". Windows' own OpenSSH rule is left as
/// the remote's administrator set it: enabling it would open port 22 to any
/// address again.
const SETUP_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$base = '__BASE__'
function Tell($what, $m) { try { (New-Object Net.WebClient).DownloadString($base + '/' + $what + [Uri]::EscapeDataString($m)) | Out-Null } catch { } }
function Say($m) { Write-Host $m; Tell 'log?m=' $m }
try {
  $v = [Environment]::OSVersion.Version
  Say ('Windows ' + $v + ', PowerShell ' + $PSVersionTable.PSVersion)
  if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
    $arch = 'Win32'
    if ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'AMD64') { $arch = 'Win64' }
    $name = 'OpenSSH-' + $arch
    if ($v.Major -lt 6 -or ($v.Major -eq 6 -and $v.Minor -le 1)) { $name += '-legacy' }
    $zip = Join-Path $env:TEMP ($name + '.zip')
    Say ('Downloading ' + $name + '.zip from BananaConn')
    (New-Object Net.WebClient).DownloadFile($base + '/' + $name + '.zip', $zip)
    $tmp = Join-Path $env:TEMP 'bx-openssh'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item $tmp -ItemType Directory | Out-Null
    $shell = New-Object -ComObject Shell.Application
    $shell.Namespace($tmp).CopyHere($shell.Namespace($zip).Items(), 0x14)
    for ($i = 0; $i -lt 120 -and -not (Get-ChildItem $tmp -Recurse -Filter sshd.exe); $i++) { Start-Sleep -Milliseconds 500 }
    $sshd = Get-ChildItem $tmp -Recurse -Filter sshd.exe | Select-Object -First 1
    if (-not $sshd) { throw 'sshd.exe is not in the downloaded package' }
    Start-Sleep -Seconds 2
    $dest = Join-Path $env:ProgramFiles 'OpenSSH'
    if (-not (Test-Path $dest)) { New-Item $dest -ItemType Directory | Out-Null }
    Copy-Item (Join-Path $sshd.DirectoryName '*') $dest -Recurse -Force
    Say ('Installing the sshd service in ' + $dest)
    $setup = Join-Path $dest 'install-sshd.ps1'
    if (Test-Path $setup) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $setup | Out-Null }
    if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
      & sc.exe create sshd binPath= ('"' + (Join-Path $dest 'sshd.exe') + '"') start= auto DisplayName= 'OpenSSH SSH Server' | Out-Null
      & sc.exe privs sshd SeAssignPrimaryTokenPrivilege/SeTcbPrivilege/SeBackupPrivilege/SeRestorePrivilege/SeImpersonatePrivilege | Out-Null
    }
    if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { throw 'the sshd service could not be created' }
  } else { Say 'The OpenSSH server is already installed' }
  Set-Service sshd -StartupType Automatic
  if (-not (Test-Path 'HKLM:\SOFTWARE\OpenSSH')) { New-Item 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null }
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value ($env:SystemRoot + '\System32\WindowsPowerShell\v1.0\powershell.exe') -PropertyType String -Force | Out-Null
  Say 'Starting sshd'
  if ((Get-Service sshd).Status -ne 'Running') {
    try { Start-Service sshd } catch {
      $keygen = Join-Path (Join-Path $env:ProgramFiles 'OpenSSH') 'ssh-keygen.exe'
      if (-not (Test-Path $keygen)) { throw }
      Say 'Making host keys'
      Push-Location (Split-Path $keygen)
      & $keygen -A | Out-Null
      Pop-Location
      Start-Service sshd
    }
  }
  $me = ([Uri]$base).Host
  Say ('Opening port 22 in the firewall for ' + $me + ' on every network profile')
  & netsh.exe advfirewall firewall delete rule name="BananaConn OpenSSH" | Out-Null
  & netsh.exe advfirewall firewall add rule name="BananaConn OpenSSH" dir=in action=allow protocol=TCP localport=22 "remoteip=$me" profile=any | Out-Null
  $state = (Get-Service sshd).Status
  if ($state -ne 'Running') { throw ('sshd is ' + $state) }
  Say 'OpenSSH is ready'
  Tell 'done?ok=1&m=' 'ready'
} catch {
  Say ('Failed: ' + $_.Exception.Message)
  Tell 'done?ok=0&m=' $_.Exception.Message
}
"#;

/// The running share: its stop signal and its task, which owns the listener.
struct Running {
    stop: watch::Sender<bool>,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub struct SshKitState(Mutex<Option<Running>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KitInfo {
    /// Where the remote PC reaches this one ("http://10.1.2.3:51234/ab12cd34").
    pub url: String,
    /// For Win+R: asks for administrator rights, then runs the script.
    pub run_line: String,
    /// For a PowerShell already running as administrator.
    pub admin_line: String,
    /// Whether the address was found from the route to the target.
    pub routed: bool,
}

/// The first IPv4 address of `target` (port 22). Resolved by tokio, off the
/// command's async thread: a slow DNS server would block it otherwise.
async fn ipv4_of(target: &str) -> Option<SocketAddr> {
    tokio::net::lookup_host((target.trim(), 22)).await.ok()?.find(SocketAddr::is_ipv4)
}

/// This PC's address on the way to `target` (no packet is sent).
async fn local_ip_toward(target: &str) -> Option<IpAddr> {
    let to = ipv4_of(target).await?;
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect(to).ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then_some(ip)
}

fn random_token() -> String {
    (0..6).map(|_| format!("{:02x}", rand::random::<u8>())).collect()
}

/// The one-line commands for the remote PC.
pub(crate) fn lines_for(url: &str) -> (String, String) {
    let script = format!("{url}/s");
    let admin = format!("iex ((New-Object Net.WebClient).DownloadString('{script}'))");
    let run = format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -Command \"Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -Command {}'\"",
        admin.replace('\'', "''")
    );
    (run, admin)
}

#[tauri::command]
pub async fn ssh_kit_start(app: AppHandle, state: State<'_, SshKitState>, target: String) -> Result<KitInfo, String> {
    // One share at a time: a new dialog replaces the previous one. Its task
    // owns the listener, so wait for it to end: binding before that would
    // find the fixed port still taken and fall back to another one.
    let previous = state.0.lock().unwrap().take();
    if let Some(previous) = previous {
        let _ = previous.stop.send(true);
        let _ = previous.task.await;
    }
    // A fixed port, so one firewall rule on this PC serves every share.
    let listener = match TcpListener::bind(("0.0.0.0", SHARE_PORT)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind("0.0.0.0:0").await.map_err(|e| format!("공유를 열 수 없습니다: {e}"))?,
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let found = local_ip_toward(&target).await;
    let ip = found.map(|ip| ip.to_string()).unwrap_or_else(|| "127.0.0.1".into());
    let token = random_token();
    let url = format!("http://{ip}:{port}/{token}");
    let cache = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("openssh-kit");
    let (stop, stopped) = watch::channel(false);
    let share = Arc::new(Share { app: Some(app.clone()), token, base: url.clone(), cache, fetching: tokio::sync::Mutex::new(()) });
    let task = tauri::async_runtime::spawn(serve(listener, share, stopped));
    // A start running in parallel may have registered its share meanwhile:
    // this one replaces it, and it must not keep serving unseen.
    let replaced = state.0.lock().unwrap().replace(Running { stop, task });
    if let Some(replaced) = replaced {
        let _ = replaced.stop.send(true);
    }
    let (run_line, admin_line) = lines_for(&url);
    Ok(KitInfo { url, run_line, admin_line, routed: found.is_some() })
}

/// The netsh commands that let `remote` (an IPv4 address) reach the share's
/// port through this PC's firewall, replacing an earlier rule.
pub(crate) fn allow_commands(remote: &str, port: u16) -> Result<String, String> {
    let ip: std::net::Ipv4Addr = remote.trim().parse().map_err(|_| "원격 PC의 IPv4 주소가 필요합니다".to_string())?;
    Ok(format!(
        "netsh advfirewall firewall delete rule name=\"{RULE}\" & netsh advfirewall firewall add rule name=\"{RULE}\" dir=in action=allow protocol=TCP localport={port} remoteip={ip} profile=any"
    ))
}

/// Lets the remote PC through this PC's Windows Firewall to the share: one
/// rule, for that address and port only. Windows asks the engineer for
/// administrator rights (UAC); nothing changes without that consent.
#[tauri::command]
pub async fn ssh_kit_allow(remote: String, port: u16) -> Result<(), String> {
    let remote = match remote.trim().parse::<IpAddr>() {
        Ok(ip) => ip.to_string(),
        Err(_) => ipv4_of(&remote).await.map(|a| a.ip().to_string()).ok_or("원격 PC의 주소를 찾지 못했습니다")?,
    };
    let commands = allow_commands(&remote, port)?;
    let script = allow_script(&commands);
    let status = tauri::async_runtime::spawn_blocking(move || {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x0800_0000)
            .status()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err("방화벽 규칙을 만들지 못했습니다 (관리자 권한을 허용하지 않았거나 실패)".into()) }
}

/// PowerShell that runs `commands` elevated and exits with their exit code.
/// A declined UAC prompt makes Start-Process fail without a process object;
/// `exit $null.ExitCode` would then exit 0 and report success, so any error
/// stops the script and every path without a process exits 1.
fn allow_script(commands: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'; try {{ $p = Start-Process cmd.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '/c {}' }} catch {{ exit 1 }}; if (-not $p) {{ exit 1 }}; exit $p.ExitCode",
        commands.replace('\'', "''")
    )
}

#[tauri::command]
pub fn ssh_kit_stop(state: State<'_, SshKitState>) {
    if let Some(running) = state.0.lock().unwrap().take() {
        let _ = running.stop.send(true);
    }
}

struct Share {
    app: Option<AppHandle>,
    token: String,
    base: String,
    cache: PathBuf,
    /// One download from GitHub at a time.
    fetching: tokio::sync::Mutex<()>,
}

impl Share {
    fn emit(&self, kind: &str, text: &str) {
        if let Some(app) = &self.app {
            let _ = app.emit("ssh-kit", json!({ "kind": kind, "text": text }));
        }
    }
}

async fn serve(listener: TcpListener, share: Arc<Share>, mut stopped: watch::Receiver<bool>) {
    let deadline = tokio::time::sleep(LIFETIME);
    tokio::pin!(deadline);
    let for_requests = stopped.clone();
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            _ = stopped.changed() => break,
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { continue };
                let share = share.clone();
                let mut stopped = for_requests.clone();
                tauri::async_runtime::spawn(async move {
                    // A stopped share stops serving at once, a package being
                    // sent included (a dropped sender counts as stopped).
                    tokio::select! {
                        _ = tokio::time::timeout(Duration::from_secs(600), handle(stream, peer, &share)) => {}
                        _ = stopped.wait_for(|stop| *stop) => {}
                    }
                });
            }
        }
    }
}

/// The request path, or None when it is not a GET this share answers.
fn request_path(head: &str) -> Option<&str> {
    let mut parts = head.lines().next()?.split(' ');
    (parts.next()? == "GET").then_some(())?;
    parts.next()
}

/// "%41b+c" → "Ab c"; a stray "%" stays as it is.
fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
                continue;
            }
            (b'+', _) => out.push(b' '),
            (b, _) => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query<'a>(path: &'a str, key: &str) -> Option<&'a str> {
    path.split_once('?')?.1.split('&').find_map(|kv| kv.strip_prefix(key)?.strip_prefix('='))
}

async fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8]) -> std::io::Result<()> {
    let head = format!("HTTP/1.0 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len());
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}

async fn handle(mut stream: TcpStream, peer: SocketAddr, share: &Share) -> std::io::Result<()> {
    let mut head = Vec::new();
    let mut buf = [0u8; 2048];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") && head.len() < 8192 {
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        head.extend_from_slice(&buf[..n]);
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    let Some(path) = request_path(&head) else { return respond(&mut stream, "405 Method Not Allowed", "text/plain", b"").await };
    // Only under the share's random path.
    let Some(rest) = path.strip_prefix('/').and_then(|p| p.strip_prefix(share.token.as_str())).and_then(|p| p.strip_prefix('/')) else {
        return respond(&mut stream, "404 Not Found", "text/plain", b"").await;
    };
    let name = rest.split('?').next().unwrap_or("");
    match name {
        "s" => {
            share.emit("log", &format!("{} 이(가) 설치 스크립트를 받았습니다", peer.ip()));
            let script = SETUP_SCRIPT.replace("__BASE__", &share.base).replace('\n', "\r\n");
            respond(&mut stream, "200 OK", "text/plain; charset=utf-8", script.as_bytes()).await
        }
        "log" => {
            share.emit("remote", &decode(query(rest, "m").unwrap_or("")));
            respond(&mut stream, "200 OK", "text/plain", b"ok").await
        }
        "done" => {
            let ok = query(rest, "ok") == Some("1");
            share.emit(if ok { "done" } else { "failed" }, &decode(query(rest, "m").unwrap_or("")));
            respond(&mut stream, "200 OK", "text/plain", b"ok").await
        }
        _ => match PACKAGES.iter().find(|(n, _, _)| *n == name) {
            Some(&(served, tag, asset)) => match package(share, served, tag, asset).await {
                Ok(path) => {
                    let body = tokio::fs::read(&path).await?;
                    share.emit("log", &format!("{} 을(를) 원격 PC로 보냅니다 ({} KB)", served, body.len() / 1024));
                    respond(&mut stream, "200 OK", "application/zip", &body).await
                }
                Err(e) => {
                    share.emit("error", &e);
                    respond(&mut stream, "502 Bad Gateway", "text/plain; charset=utf-8", e.as_bytes()).await
                }
            },
            None => respond(&mut stream, "404 Not Found", "text/plain", b"").await,
        },
    }
}

/// Whether `data` is a Win32-OpenSSH zip (a zip naming sshd.exe).
fn is_openssh_zip(data: &[u8]) -> bool {
    data.starts_with(b"PK\x03\x04") && data.windows(8).any(|w| w == b"sshd.exe")
}

/// The cached package, downloaded from GitHub the first time.
async fn package(share: &Share, served: &str, tag: &str, asset: &str) -> Result<PathBuf, String> {
    let _one = share.fetching.lock().await;
    let path = share.cache.join(served);
    if let Ok(data) = tokio::fs::read(&path).await
        && is_openssh_zip(&data)
    {
        return Ok(path);
    }
    let url = format!("https://github.com/PowerShell/Win32-OpenSSH/releases/download/{tag}/{asset}");
    share.emit("log", &format!("{served} 을(를) 받는 중: {url}"));
    let fetched = tauri::async_runtime::spawn_blocking(move || {
        let req = crate::http::Request { method: "GET", url: &url, headers: &[], body: None, receive_timeout_ms: 60_000 };
        crate::http::fetch(&req, 64 * 1024 * 1024)
    })
    .await
    .map_err(|e| e.to_string())?;
    let (status, data) = fetched.map_err(|e| format!("OpenSSH를 받지 못했습니다: {e}. 인터넷이 안 되면 {served} 을(를) {} 에 직접 넣으세요", share.cache.display()))?;
    if status != 200 || !is_openssh_zip(&data) {
        return Err(format!("OpenSSH를 받지 못했습니다 (HTTP {status}). {served} 을(를) {} 에 직접 넣어도 됩니다", share.cache.display()));
    }
    write_atomic(&share.cache, &path, &data).await?;
    Ok(path)
}

async fn write_atomic(dir: &Path, path: &Path, data: &[u8]) -> Result<(), String> {
    tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    let tmp = path.with_extension("part");
    tokio::fs::write(&tmp, data).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, path).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_quote_the_url_for_powershell() {
        let (run, admin) = lines_for("http://10.0.0.5:5000/ab12");
        assert_eq!(admin, "iex ((New-Object Net.WebClient).DownloadString('http://10.0.0.5:5000/ab12/s'))");
        assert!(run.contains("DownloadString(''http://10.0.0.5:5000/ab12/s'')"), "{run}");
        // Win+R takes at most 259 characters.
        assert!(run.len() < 259, "{} characters", run.len());
    }

    #[test]
    fn firewall_rule_is_for_one_address_and_port() {
        let c = allow_commands("12.0.0.9", 47622).unwrap();
        assert!(c.contains("localport=47622 remoteip=12.0.0.9 profile=any") && c.starts_with("netsh advfirewall firewall delete rule"), "{c}");
        assert!(allow_commands("12.0.0.9 & calc", 47622).is_err() && allow_commands("host", 1).is_err());
    }

    #[test]
    fn paths_and_queries() {
        assert_eq!(request_path("GET /t/s HTTP/1.1\r\nHost: x\r\n\r\n"), Some("/t/s"));
        assert_eq!(request_path("POST /t/s HTTP/1.1\r\n\r\n"), None);
        assert_eq!(query("log?m=Starting%20sshd", "m"), Some("Starting%20sshd"));
        assert_eq!(decode("Starting%20sshd+now%21"), "Starting sshd now!");
        assert_eq!(decode("100%"), "100%");
        assert_eq!(query("done?ok=1&m=ready", "ok"), Some("1"));
    }

    #[test]
    fn recognises_the_package() {
        assert!(is_openssh_zip(b"PK\x03\x04....OpenSSH-Win64/sshd.exe...."));
        assert!(!is_openssh_zip(b"<html>Not Found</html>"));
    }

    #[test]
    fn the_script_is_ascii_and_reports_back() {
        assert!(SETUP_SCRIPT.is_ascii());
        assert!(SETUP_SCRIPT.contains("profile=any") && SETUP_SCRIPT.contains("'done?ok=1&m='"));
        // Port 22 only for this PC, and Windows' own any-address rule untouched.
        assert!(SETUP_SCRIPT.contains("$me = ([Uri]$base).Host") && SETUP_SCRIPT.contains("localport=22 \"remoteip=$me\" profile=any"));
        assert!(!SETUP_SCRIPT.contains("OpenSSH-Server-In-TCP"));
    }

    /// A declined UAC prompt must not count as success.
    #[test]
    fn allow_script_fails_without_a_process() {
        let s = allow_script(&allow_commands("12.0.0.9", 47622).unwrap());
        assert!(s.starts_with("$ErrorActionPreference = 'Stop'; try {"), "{s}");
        assert!(s.contains("catch { exit 1 }; if (-not $p) { exit 1 }; exit $p.ExitCode"), "{s}");
    }

    /// Stopping a share frees its port for the next one as soon as its task
    /// ends, and a request still being answered is cut off too.
    #[tokio::test]
    async fn a_stopped_share_frees_its_port_and_stops_answering() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let share = Arc::new(Share { app: None, token: "tok".into(), base: String::new(), cache: PathBuf::new(), fetching: tokio::sync::Mutex::new(()) });
        let (stop, stopped) = watch::channel(false);
        let task = tokio::spawn(serve(listener, share, stopped));
        // A request whose head never ends keeps its handler waiting.
        let mut pending = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        pending.write_all(b"GET /tok/s HTTP/1.1\r\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        stop.send(true).unwrap();
        task.await.unwrap();
        TcpListener::bind(("127.0.0.1", port)).await.expect("the port is free again");
        let mut rest = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(5), pending.read_to_end(&mut rest)).await;
        assert!(read.is_ok(), "the pending request was closed");
    }

    /// A share answers only under its token: the script with its base URL,
    /// remote steps and the end as events, a package from the cache.
    #[tokio::test]
    async fn serves_the_script_and_cached_packages() {
        let dir = std::env::temp_dir().join(format!("bx-kit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("OpenSSH-Win64-legacy.zip"), b"PK\x03\x04 OpenSSH-Win64/sshd.exe ").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let share = Arc::new(Share { app: None, token: "tok".into(), base: format!("http://127.0.0.1:{port}/tok"), cache: dir.clone(), fetching: tokio::sync::Mutex::new(()) });
        let (_stop, stopped) = watch::channel(false);
        tokio::spawn(serve(listener, share, stopped));
        let get = |path: &'static str| async move {
            let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
            let mut out = Vec::new();
            s.read_to_end(&mut out).await.unwrap();
            String::from_utf8_lossy(&out).into_owned()
        };
        let script = get("/tok/s").await;
        assert!(script.starts_with("HTTP/1.0 200") && script.contains(&format!("$base = 'http://127.0.0.1:{port}/tok'")), "{script}");
        assert!(get("/other/s").await.starts_with("HTTP/1.0 404"));
        assert!(get("/tok/../s").await.starts_with("HTTP/1.0 404"));
        let zip = get("/tok/OpenSSH-Win64-legacy.zip").await;
        assert!(zip.starts_with("HTTP/1.0 200") && zip.contains("sshd.exe"), "{zip}");
        assert!(get("/tok/log?m=hi").await.ends_with("ok"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
