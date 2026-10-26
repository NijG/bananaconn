// Connections through a proxy, as PuTTY offers them (Connection → Proxy):
// SOCKS 4/4a, SOCKS 5 (with username/password), HTTP CONNECT (Basic auth), a
// "Telnet" proxy (a command typed at the proxy), or a local command whose
// stdin/stdout is the connection. Hosts on the exclude list, and local
// addresses unless asked otherwise, are reached directly.
//
// Everything that opens a connection for a session dials through `dial`:
// directly in the backend (SFTP, FTP, monitors, SSH gateways), or through a
// local forward (`forward_open`) for Telnet, RDP and VNC, and for ssh.exe,
// whose ProxyCommand (`bananaconn.exe --proxy-stdio`) is piped to a forward.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Longest proxy reply header (HTTP) read before giving up.
const MAX_HEADER: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Socks4,
    Socks5,
    Http,
    Telnet,
    Local,
}

/// Where host names are looked up (PuTTY "Do DNS name lookup at proxy end").
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Dns {
    No,
    #[default]
    Auto,
    Yes,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub kind: Kind,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    /// Hosts reached directly: names or addresses with `*` wildcards, or
    /// IPv4 networks like 10.0.0.0/8, separated by commas or spaces.
    #[serde(default)]
    pub exclude: String,
    /// Proxy connections to this PC too (localhost, 127.x, ::1).
    #[serde(default)]
    pub local: bool,
    #[serde(default)]
    pub dns: Dns,
    /// Vault credential with the proxy's username and password.
    #[serde(default)]
    pub credential_id: Option<String>,
    /// Telnet proxy: what is typed at the proxy (%host %port %user %pass, \n \r \t \\ \xHH).
    #[serde(default)]
    pub telnet_command: String,
    /// Local proxy: the command whose stdin/stdout is the connection.
    #[serde(default)]
    pub local_command: String,
    /// Show the proxy steps in the terminal (PuTTY "Print proxy diagnostics").
    #[serde(default)]
    pub diagnostics: bool,
}

/// Proxy login, resolved from the vault by the caller.
#[derive(Clone, Default)]
pub struct Auth {
    pub user: String,
    pub pass: String,
}

impl ProxyConfig {
    /// The connection to `host` goes directly (excluded, or a local address
    /// while local connections are not proxied).
    pub fn bypasses(&self, host: &str) -> bool {
        let host = host.trim().trim_start_matches('[').trim_end_matches(']');
        if !self.local && is_local(host) {
            return true;
        }
        self.exclude
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|p| !p.is_empty())
            .any(|p| matches_pattern(p, host))
    }

    fn label(&self) -> &'static str {
        match self.kind {
            Kind::Socks4 => "SOCKS 4",
            Kind::Socks5 => "SOCKS 5",
            Kind::Http => "HTTP",
            Kind::Telnet => "Telnet",
            Kind::Local => "local command",
        }
    }
}

fn is_local(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn matches_pattern(pattern: &str, host: &str) -> bool {
    if let Some((net, bits)) = pattern.split_once('/')
        && let (Ok(net), Ok(bits), Ok(ip)) = (net.parse::<Ipv4Addr>(), bits.parse::<u32>(), host.parse::<Ipv4Addr>())
        && bits <= 32
    {
        let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
        return u32::from(net) & mask == u32::from(ip) & mask;
    }
    wildcard(&pattern.to_ascii_lowercase(), &host.to_ascii_lowercase())
}

/// `*` matches any run of characters.
fn wildcard(pattern: &str, text: &str) -> bool {
    let (p, t) = (pattern.as_bytes(), text.as_bytes());
    let (mut pi, mut ti, mut star, mut mark) = (0, 0, None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == b'*')
}

/// PuTTY's substitutions in proxy commands: %host %port %user %pass %%, and
/// backslash escapes \n \r \t \\ \xHH.
pub fn expand(template: &str, host: &str, port: u16, auth: &Auth) -> Vec<u8> {
    // Works on bytes only: every token is ASCII, and slicing the str at `i`
    // would panic inside a multi-byte character (a Korean folder name in the
    // command's path). Bytes that are not part of a token are copied as they
    // are, so the UTF-8 output stays intact.
    let mut out = Vec::new();
    let b = template.as_bytes();
    let hex = |at: usize| b.get(at..at + 2).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
    let mut i = 0;
    while i < b.len() {
        let rest = &b[i..];
        if rest.starts_with(b"%host") {
            out.extend_from_slice(host.as_bytes());
            i += 5;
        } else if rest.starts_with(b"%port") {
            out.extend_from_slice(port.to_string().as_bytes());
            i += 5;
        } else if rest.starts_with(b"%user") {
            out.extend_from_slice(auth.user.as_bytes());
            i += 5;
        } else if rest.starts_with(b"%pass") {
            out.extend_from_slice(auth.pass.as_bytes());
            i += 5;
        } else if rest.starts_with(b"%%") {
            out.push(b'%');
            i += 2;
        } else if b[i] == b'\\' && i + 1 < b.len() {
            match b[i + 1] {
                b'n' => out.push(b'\n'),
                b'r' => out.push(b'\r'),
                b't' => out.push(b'\t'),
                b'\\' => out.push(b'\\'),
                b'x' if hex(i + 2).is_some() => {
                    out.push(hex(i + 2).unwrap_or(0));
                    i += 2;
                }
                // Not an escape: both kept as they are. A multi-byte
                // character after the backslash is copied by the plain path.
                other if other.is_ascii() => {
                    out.push(b'\\');
                    out.push(other);
                }
                _ => {
                    out.push(b'\\');
                    i += 1;
                    continue;
                }
            }
            i += 2;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out
}

/// Connect to `host:port`, through the proxy when there is one and the host
/// is not excluded. `log` receives the proxy steps (PuTTY's "proxy
/// diagnostics"); secrets never appear in it.
pub fn dial(proxy: Option<&ProxyConfig>, auth: &Auth, host: &str, port: u16, log: &mut dyn FnMut(String)) -> Result<TcpStream, String> {
    let Some(p) = proxy.filter(|p| !p.bypasses(host)) else {
        return direct(host, port);
    };
    if p.kind == Kind::Local {
        log(format!("Starting local proxy command for {host}:{port}"));
        return local_command(&p.local_command, host, port, auth);
    }
    log(format!("Connecting to {} proxy at {}:{}", p.label(), p.host, p.port));
    let mut s = direct(&p.host, p.port).map_err(|e| format!("프록시({}:{})에 연결할 수 없습니다: {e}", p.host, p.port))?;
    let _ = s.set_read_timeout(Some(CONNECT_TIMEOUT));
    let remote_dns = match p.dns {
        Dns::Yes => true,
        Dns::No => false,
        Dns::Auto => p.kind != Kind::Socks4,
    };
    let target = if remote_dns || host.parse::<IpAddr>().is_ok() {
        Target::Name(host.trim_start_matches('[').trim_end_matches(']').to_string())
    } else {
        log(format!("Looking up {host} locally"));
        Target::Ip(lookup(host, port)?)
    };
    match p.kind {
        Kind::Socks4 => socks4(&mut s, &target, port, auth),
        Kind::Socks5 => socks5(&mut s, &target, port, auth),
        Kind::Http => http(&mut s, &target, port, auth),
        Kind::Telnet => {
            let cmd = if p.telnet_command.is_empty() { "connect %host %port\\n" } else { &p.telnet_command };
            s.write_all(&expand(cmd, &target.text(), port, auth))
        }
        Kind::Local => unreachable!(),
    }
    .map_err(|e| format!("프록시({} {}:{})가 연결을 거부했습니다: {e}", p.label(), p.host, p.port))?;
    log(format!("Proxy connection to {}:{port} established", target.text()));
    let _ = s.set_read_timeout(None);
    let _ = s.set_nodelay(true);
    Ok(s)
}

enum Target {
    Name(String),
    Ip(IpAddr),
}

impl Target {
    fn text(&self) -> String {
        match self {
            Target::Name(n) => n.clone(),
            Target::Ip(ip) => ip.to_string(),
        }
    }
}

/// Local lookup for the proxy request: an IPv4 address when there is one
/// (SOCKS 4 has no other kind, and "localhost" often lists ::1 first).
fn lookup(host: &str, port: u16) -> Result<IpAddr, String> {
    let ips: Vec<IpAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("{host} 주소를 찾을 수 없습니다: {e}"))?
        .map(|a| a.ip())
        .collect();
    ips.iter()
        .find(|ip| ip.is_ipv4())
        .or(ips.first())
        .copied()
        .ok_or_else(|| format!("{host} 주소를 찾을 수 없습니다"))
}

fn direct(host: &str, port: u16) -> Result<TcpStream, String> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    let addrs: Vec<SocketAddr> = (host, port).to_socket_addrs().map_err(|e| format!("{host} 주소를 찾을 수 없습니다: {e}"))?.collect();
    let mut last = None;
    for a in &addrs {
        match TcpStream::connect_timeout(a, CONNECT_TIMEOUT) {
            Ok(s) => {
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
            Err(e) => last = Some(e),
        }
    }
    Err(format!("{host}:{port}에 연결할 수 없습니다: {}", last.map(|e| e.to_string()).unwrap_or_else(|| "주소 없음".into())))
}

fn socks4(s: &mut TcpStream, target: &Target, port: u16, auth: &Auth) -> io::Result<()> {
    let mut req = vec![4, 1];
    req.extend_from_slice(&port.to_be_bytes());
    match target {
        Target::Ip(IpAddr::V4(ip)) => req.extend_from_slice(&ip.octets()),
        Target::Ip(IpAddr::V6(_)) => return Err(io::Error::other("SOCKS 4 cannot reach IPv6 addresses")),
        // SOCKS 4a: 0.0.0.1, then the name after the user id.
        Target::Name(_) => req.extend_from_slice(&[0, 0, 0, 1]),
    }
    req.extend_from_slice(auth.user.as_bytes());
    req.push(0);
    if let Target::Name(n) = target {
        req.extend_from_slice(n.as_bytes());
        req.push(0);
    }
    s.write_all(&req)?;
    let mut reply = [0u8; 8];
    s.read_exact(&mut reply)?;
    match reply[1] {
        90 => Ok(()),
        91 => Err(io::Error::other("request rejected or failed (91)")),
        92 | 93 => Err(io::Error::other("identd check failed")),
        c => Err(io::Error::other(format!("unexpected reply {c}"))),
    }
}

fn socks5(s: &mut TcpStream, target: &Target, port: u16, auth: &Auth) -> io::Result<()> {
    let with_login = !auth.user.is_empty();
    s.write_all(if with_login { &[5, 2, 0, 2] } else { &[5, 1, 0] })?;
    let mut choice = [0u8; 2];
    s.read_exact(&mut choice)?;
    if choice[0] != 5 {
        return Err(io::Error::other("not a SOCKS 5 proxy"));
    }
    match choice[1] {
        0 => {}
        2 if with_login => {
            let (u, p) = (auth.user.as_bytes(), auth.pass.as_bytes());
            if u.len() > 255 || p.len() > 255 {
                return Err(io::Error::other("username or password longer than 255 bytes"));
            }
            let mut req = vec![1, u.len() as u8];
            req.extend_from_slice(u);
            req.push(p.len() as u8);
            req.extend_from_slice(p);
            s.write_all(&req)?;
            let mut r = [0u8; 2];
            s.read_exact(&mut r)?;
            if r[1] != 0 {
                return Err(io::Error::other("username or password refused"));
            }
        }
        2 => return Err(io::Error::other("the proxy needs a username and password")),
        0xFF => return Err(io::Error::other("no acceptable authentication method")),
        m => return Err(io::Error::other(format!("unsupported authentication method {m}"))),
    }
    let mut req = vec![5, 1, 0];
    match target {
        Target::Ip(IpAddr::V4(ip)) => {
            req.push(1);
            req.extend_from_slice(&ip.octets());
        }
        Target::Ip(IpAddr::V6(ip)) => {
            req.push(4);
            req.extend_from_slice(&ip.octets());
        }
        Target::Name(n) => match n.parse::<IpAddr>() {
            Ok(IpAddr::V4(ip)) => {
                req.push(1);
                req.extend_from_slice(&ip.octets());
            }
            Ok(IpAddr::V6(ip)) => {
                req.push(4);
                req.extend_from_slice(&ip.octets());
            }
            Err(_) => {
                if n.len() > 255 {
                    return Err(io::Error::other("host name longer than 255 bytes"));
                }
                req.push(3);
                req.push(n.len() as u8);
                req.extend_from_slice(n.as_bytes());
            }
        },
    }
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req)?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head)?;
    if head[1] != 0 {
        let why = match head[1] {
            1 => "general failure",
            2 => "connection not allowed by ruleset",
            3 => "network unreachable",
            4 => "host unreachable",
            5 => "connection refused",
            6 => "TTL expired",
            7 => "command not supported",
            8 => "address type not supported",
            _ => "unknown error",
        };
        return Err(io::Error::other(format!("{why} ({})", head[1])));
    }
    // The bound address that follows: skip it.
    let skip = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l)?;
            l[0] as usize
        }
        t => return Err(io::Error::other(format!("unknown address type {t}"))),
    };
    let mut rest = vec![0u8; skip + 2];
    s.read_exact(&mut rest)
}

fn http(s: &mut TcpStream, target: &Target, port: u16, auth: &Auth) -> io::Result<()> {
    let host = match target {
        Target::Ip(IpAddr::V6(ip)) => format!("[{ip}]"),
        Target::Name(n) if n.contains(':') => format!("[{n}]"),
        t => t.text(),
    };
    let mut req = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
    if !auth.user.is_empty() {
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", auth.user, auth.pass));
        req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes())?;
    // Read the reply header byte by byte: what follows it belongs to the session.
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > MAX_HEADER {
            return Err(io::Error::other("reply header too long"));
        }
        if s.read(&mut byte)? == 0 {
            return Err(io::Error::other("the proxy closed the connection"));
        }
        head.push(byte[0]);
    }
    let status = String::from_utf8_lossy(&head);
    let line = status.lines().next().unwrap_or_default().to_string();
    let code: u16 = line.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    match code {
        200..=299 => Ok(()),
        407 => Err(io::Error::other(if auth.user.is_empty() { "the proxy needs a username and password (407)" } else { "username or password refused (407)" })),
        _ => Err(io::Error::other(line)),
    }
}

/// Run the local proxy command; its stdin/stdout become one end of a
/// loopback connection, which is returned.
fn local_command(template: &str, host: &str, port: u16, auth: &Auth) -> Result<TcpStream, String> {
    if template.trim().is_empty() {
        return Err("로컬 프록시 명령이 비어 있습니다".into());
    }
    let command = String::from_utf8_lossy(&expand(template, host, port, auth)).into_owned();
    use std::os::windows::process::CommandExt;
    // `cmd /C <command>`, the command passed as typed (cmd parses it), like PuTTY.
    let mut child = std::process::Command::new(r"C:\Windows\System32\cmd.exe")
        .raw_arg("/C")
        .raw_arg(&command)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("로컬 프록시 명령을 실행할 수 없습니다: {e}"))?;
    let (ours, theirs) = loopback_pair().map_err(|e| e.to_string())?;
    let mut to_child = child.stdin.take().ok_or("로컬 프록시 명령의 입력을 열 수 없습니다")?;
    let mut from_child = child.stdout.take().ok_or("로컬 프록시 명령의 출력을 열 수 없습니다")?;
    let mut a = theirs.try_clone().map_err(|e| e.to_string())?;
    let mut b = theirs;
    std::thread::spawn(move || {
        let _ = io::copy(&mut a, &mut to_child);
    });
    std::thread::spawn(move || {
        let _ = io::copy(&mut from_child, &mut b);
        let _ = b.shutdown(Shutdown::Both);
        let _ = child.kill();
        let _ = child.wait();
    });
    Ok(ours)
}

fn loopback_pair() -> io::Result<(TcpStream, TcpStream)> {
    let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let a = TcpStream::connect(l.local_addr()?)?;
    let (b, _) = l.accept()?;
    Ok((a, b))
}

// ---- local forwards (Telnet, RDP, VNC, ssh.exe) -------------------------------------------

struct Forward {
    stop: Arc<AtomicBool>,
    port: u16,
}

#[derive(Default)]
pub struct ProxyState {
    forwards: Mutex<HashMap<String, Forward>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyLog {
    id: String,
    line: String,
    error: bool,
}

/// Resolve the proxy's login from the vault.
pub fn auth_for(app: &AppHandle, proxy: Option<&ProxyConfig>) -> Result<Auth, String> {
    match proxy.and_then(|p| p.credential_id.as_deref()).filter(|id| !id.is_empty()) {
        Some(id) => {
            let r = crate::vault::resolve(app, id)?;
            Ok(Auth { user: r.username, pass: r.password.unwrap_or_default() })
        }
        None => Ok(Auth::default()),
    }
}

/// A local port that reaches `host:port` through the proxy, one proxied
/// connection per accepted one, until `forward_close`. Each step is reported
/// as a "proxy-log" event with this id. With `announce` (the `--proxy-stdio`
/// helper of an SSH terminal is the client), each connection starts with an
/// announcement (see `stdio_main`) carrying the diagnostics (when the proxy
/// asks for them) and any error.
pub fn open_forward(app: &AppHandle, state: &ProxyState, id: &str, host: &str, port: u16, proxy: ProxyConfig, announce: bool) -> Result<u16, String> {
    if let Some(f) = state.forwards.lock().unwrap().get(id) {
        return Ok(f.port);
    }
    let auth = auth_for(app, Some(&proxy))?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| format!("프록시 중계 포트를 열 수 없습니다: {e}"))?;
    let local = listener.local_addr().map_err(|e| e.to_string())?.port();
    // Blocking accept (no idle polling); close_forward wakes it with a throwaway
    // connection so an idle forward costs no CPU.
    let stop = Arc::new(AtomicBool::new(false));
    // Check and insert under one lock: a parallel open for the same id may
    // have registered its forward meanwhile. That one wins and this listener
    // is dropped before any thread serves it (an overwritten entry could
    // never be stopped).
    match state.forwards.lock().unwrap().entry(id.to_string()) {
        std::collections::hash_map::Entry::Occupied(existing) => return Ok(existing.get().port),
        std::collections::hash_map::Entry::Vacant(slot) => {
            slot.insert(Forward { stop: stop.clone(), port: local });
        }
    }
    let (app, id, host) = (app.clone(), id.to_string(), host.to_string());
    std::thread::spawn(move || {
        loop {
            let (client, peer) = match listener.accept() {
                Ok(v) => v,
                Err(_) => break,
            };
            // Set on close, then woken by a local connection: exit without serving it.
            if stop.load(Ordering::Relaxed) {
                break;
            }
            if !peer.ip().is_loopback() {
                continue;
            }
            let _ = client.set_nonblocking(false);
            let (app, id, host, proxy, auth) = (app.clone(), id.clone(), host.clone(), proxy.clone(), auth.clone());
            std::thread::spawn(move || {
                let emit = |line: String, error: bool| {
                    let _ = app.emit("proxy-log", ProxyLog { id: id.clone(), line, error });
                };
                let mut said = Vec::new();
                let result = dial(Some(&proxy), &auth, &host, port, &mut |l| {
                    if proxy.diagnostics {
                        said.push(l.clone());
                    }
                    emit(l, false)
                });
                if let Err(e) = &result {
                    emit(e.clone(), true);
                    said.push(format!("BananaConn proxy: {e}"));
                }
                let mut client = client;
                if announce && announcement(&mut client, &said).is_err() {
                    return;
                }
                match result {
                    Ok(server) => pipe(client, server),
                    Err(_) => {
                        let _ = client.shutdown(Shutdown::Both);
                    }
                }
            });
        }
    });
    Ok(local)
}

/// The announcement a term forward sends before the connection's bytes: a
/// 4-byte big-endian length, then that many bytes of UTF-8 lines.
fn announcement(client: &mut TcpStream, lines: &[String]) -> io::Result<()> {
    let text = lines.join("\n");
    let mut head = (text.len() as u32).to_be_bytes().to_vec();
    head.extend_from_slice(text.as_bytes());
    client.write_all(&head)
}

/// Read a term forward's announcement (at most 64 KiB of lines).
fn read_announcement(s: &mut TcpStream) -> io::Result<String> {
    let mut len = [0u8; 4];
    s.read_exact(&mut len)?;
    let n = u32::from_be_bytes(len) as usize;
    if n > 64 * 1024 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "announcement too long"));
    }
    let mut text = vec![0u8; n];
    s.read_exact(&mut text)?;
    Ok(String::from_utf8_lossy(&text).into_owned())
}

/// Copy both ways until either side closes.
pub fn pipe(a: TcpStream, b: TcpStream) {
    let (Ok(mut a2), Ok(mut b2)) = (a.try_clone(), b.try_clone()) else { return };
    let (mut a1, mut b1) = (a, b);
    let t = std::thread::spawn(move || {
        let _ = io::copy(&mut a2, &mut b2);
        let _ = b2.shutdown(Shutdown::Write);
    });
    let _ = io::copy(&mut b1, &mut a1);
    let _ = a1.shutdown(Shutdown::Write);
    let _ = t.join();
}

pub fn close_forward(state: &ProxyState, id: &str) {
    if let Some(f) = state.forwards.lock().unwrap().remove(id) {
        f.stop.store(true, Ordering::Relaxed);
        // Wake the blocking accept so the thread sees the flag and exits.
        let _ = TcpStream::connect((Ipv4Addr::LOCALHOST, f.port));
    }
}

#[tauri::command]
pub async fn proxy_forward_open(app: AppHandle, state: State<'_, ProxyState>, id: String, host: String, port: u16, proxy: ProxyConfig) -> Result<u16, String> {
    let state: &ProxyState = &state;
    // Vault access and the bind are quick; no blocking work here otherwise.
    open_forward(&app, state, &id, &host, port, proxy, false)
}

#[tauri::command]
pub fn proxy_forward_close(state: State<ProxyState>, id: String) {
    close_forward(&state, &id);
}

/// `bananaconn.exe --proxy-stdio <port>`: ssh.exe's ProxyCommand. Its stdin
/// and stdout are piped to the app's local forward on 127.0.0.1:<port>.
pub fn stdio_main(args: &[String]) -> i32 {
    let Some(port) = args.first().and_then(|p| p.parse::<u16>().ok()) else {
        eprintln!("usage: bananaconn --proxy-stdio <port>");
        return 2;
    };
    let mut s = match TcpStream::connect((Ipv4Addr::LOCALHOST, port)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("BananaConn proxy: {e}");
            return 1;
        }
    };
    let _ = s.set_nodelay(true);
    // The forward's diagnostics and errors go to ssh.exe's console (stderr),
    // so they are part of the terminal's own screen: lines the app wrote
    // there itself would be lost when ConPTY repaints.
    match read_announcement(&mut s) {
        Ok(text) => {
            for line in text.lines() {
                eprintln!("{line}");
            }
        }
        Err(e) => {
            eprintln!("BananaConn proxy: {e}");
            return 1;
        }
    }
    let mut up = match s.try_clone() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("BananaConn proxy: {e}");
            return 1;
        }
    };
    std::thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let _ = io::copy(&mut stdin, &mut up);
        let _ = up.shutdown(Shutdown::Write);
    });
    let mut down = s;
    let mut stdout = io::stdout().lock();
    let mut buf = [0u8; 16 * 1024];
    loop {
        match down.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if stdout.write_all(&buf[..n]).and_then(|_| stdout.flush()).is_err() {
                    break;
                }
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    fn read_line(r: &mut BufReader<TcpStream>) -> String {
        let mut s = String::new();
        let _ = r.read_line(&mut s);
        s
    }

    /// An echo server standing for the target.
    fn echo_server() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            while let Ok((mut s, _)) = l.accept() {
                std::thread::spawn(move || {
                    let mut c = s.try_clone().unwrap();
                    let _ = io::copy(&mut c, &mut s);
                });
            }
        });
        port
    }

    /// A fake proxy: runs `handshake` on the client, then connects it to the
    /// echo server; returns the port and what the handshake saw.
    fn fake_proxy(target: u16, handshake: impl Fn(&mut TcpStream) -> String + Send + 'static) -> (u16, Arc<Mutex<Vec<String>>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        std::thread::spawn(move || {
            while let Ok((mut c, _)) = l.accept() {
                let note = handshake(&mut c);
                s2.lock().unwrap().push(note);
                let server = TcpStream::connect(("127.0.0.1", target)).unwrap();
                std::thread::spawn(move || pipe(c, server));
            }
        });
        (port, seen)
    }

    fn cfg(kind: Kind, port: u16) -> ProxyConfig {
        ProxyConfig { kind, host: "127.0.0.1".into(), port, exclude: String::new(), local: true, dns: Dns::Auto, credential_id: None, telnet_command: String::new(), local_command: String::new(), diagnostics: false }
    }

    fn roundtrip(mut s: TcpStream) {
        s.write_all(b"hello through the proxy").unwrap();
        let mut buf = [0u8; 23];
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"hello through the proxy");
    }

    /// A term forward's announcement reaches the helper whole (Korean text
    /// included), and the connection's own bytes follow untouched.
    #[test]
    fn term_forward_announcement_comes_before_the_stream() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut c, _) = listener.accept().unwrap();
            announcement(&mut c, &["Connecting to HTTP proxy at 127.0.0.1:3128".into(), "BananaConn proxy: 프록시가 연결을 거부했습니다".into()]).unwrap();
            c.write_all(b"SSH-2.0-Fake\r\n").unwrap();
        });
        let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let text = read_announcement(&mut s).unwrap();
        assert_eq!(text.lines().collect::<Vec<_>>(), ["Connecting to HTTP proxy at 127.0.0.1:3128", "BananaConn proxy: 프록시가 연결을 거부했습니다"]);
        let mut rest = Vec::new();
        s.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, b"SSH-2.0-Fake\r\n");
        server.join().unwrap();
        // No diagnostics: an empty announcement, the stream starts at once.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut c, _) = listener.accept().unwrap();
            announcement(&mut c, &[]).unwrap();
            c.write_all(b"x").unwrap();
        });
        let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        assert_eq!(read_announcement(&mut s).unwrap(), "");
    }

    #[test]
    fn socks5_with_login_and_a_remote_name() {
        let echo = echo_server();
        let (port, seen) = fake_proxy(echo, |c| {
            let mut g = [0u8; 4];
            c.read_exact(&mut g).unwrap();
            assert_eq!(g, [5, 2, 0, 2], "offers no-auth and username/password");
            c.write_all(&[5, 2]).unwrap();
            let mut h = [0u8; 2];
            c.read_exact(&mut h).unwrap();
            let mut user = vec![0u8; h[1] as usize];
            c.read_exact(&mut user).unwrap();
            let mut pl = [0u8; 1];
            c.read_exact(&mut pl).unwrap();
            let mut pass = vec![0u8; pl[0] as usize];
            c.read_exact(&mut pass).unwrap();
            c.write_all(&[1, 0]).unwrap();
            let mut r = [0u8; 5];
            c.read_exact(&mut r).unwrap();
            assert_eq!(&r[..4], &[5, 1, 0, 3], "CONNECT by name");
            let mut name = vec![0u8; r[4] as usize + 2];
            c.read_exact(&mut name).unwrap();
            c.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).unwrap();
            format!("{}:{} {}", String::from_utf8_lossy(&user), String::from_utf8_lossy(&pass), String::from_utf8_lossy(&name[..name.len() - 2]))
        });
        let auth = Auth { user: "alice".into(), pass: "s3cret".into() };
        let mut log = Vec::new();
        let s = dial(Some(&cfg(Kind::Socks5, port)), &auth, "localhost", echo, &mut |l| log.push(l)).unwrap();
        roundtrip(s);
        assert_eq!(seen.lock().unwrap()[0], "alice:s3cret localhost");
        assert!(log.iter().any(|l| l.contains("SOCKS 5")) && !log.iter().any(|l| l.contains("s3cret")), "{log:?}");
    }

    #[test]
    fn socks4_looks_up_locally_and_4a_sends_the_name() {
        let echo = echo_server();
        let handshake = |c: &mut TcpStream| {
            let mut h = [0u8; 8];
            c.read_exact(&mut h).unwrap();
            let mut rest = Vec::new();
            let mut b = [0u8; 1];
            // user id, then (4a) the name, each ending with 0
            let zeros = if h[4..8] == [0, 0, 0, 1] { 2 } else { 1 };
            let mut seen = 0;
            while seen < zeros {
                c.read_exact(&mut b).unwrap();
                if b[0] == 0 { seen += 1 } else { rest.push(b[0]) }
            }
            c.write_all(&[0, 90, 0, 0, 0, 0, 0, 0]).unwrap();
            format!("{}.{}.{}.{} {}", h[4], h[5], h[6], h[7], String::from_utf8_lossy(&rest))
        };
        let (port, seen) = fake_proxy(echo, handshake);
        roundtrip(dial(Some(&cfg(Kind::Socks4, port)), &Auth::default(), "localhost", echo, &mut |_| {}).unwrap());
        let mut remote = cfg(Kind::Socks4, port);
        remote.dns = Dns::Yes;
        roundtrip(dial(Some(&remote), &Auth::default(), "localhost", echo, &mut |_| {}).unwrap());
        let seen = seen.lock().unwrap();
        assert!(seen[0].starts_with("127.0.0.1"), "auto: SOCKS 4 sends an address: {}", seen[0]);
        assert_eq!(seen[1], "0.0.0.1 localhost", "yes: SOCKS 4a sends the name");
    }

    #[test]
    fn http_connect_with_basic_auth_and_refusal() {
        let echo = echo_server();
        let (port, seen) = fake_proxy(echo, |c| {
            let mut r = BufReader::new(c.try_clone().unwrap());
            let first = read_line(&mut r);
            let mut auth = String::new();
            loop {
                let l = read_line(&mut r);
                if l == "\r\n" || l.is_empty() {
                    break;
                }
                if l.starts_with("Proxy-Authorization") {
                    auth = l.trim().to_string();
                }
            }
            c.write_all(b"HTTP/1.1 200 Connection established\r\nVia: fake\r\n\r\n").unwrap();
            format!("{} {}", first.trim(), auth)
        });
        let auth = Auth { user: "bob".into(), pass: "pw".into() };
        roundtrip(dial(Some(&cfg(Kind::Http, port)), &auth, "example.test", echo, &mut |_| {}).unwrap());
        let seen = seen.lock().unwrap()[0].clone();
        assert!(seen.starts_with(&format!("CONNECT example.test:{echo} HTTP/1.1")), "{seen}");
        assert!(seen.ends_with("Basic Ym9iOnB3"), "{seen}");

        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let deny = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut buf = [0u8; 512];
            let _ = c.read(&mut buf);
            c.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n").unwrap();
        });
        let err = dial(Some(&cfg(Kind::Http, deny)), &Auth::default(), "example.test", echo, &mut |_| {}).unwrap_err();
        assert!(err.contains("407"), "{err}");
    }

    #[test]
    fn telnet_proxy_types_the_command() {
        let echo = echo_server();
        // Byte by byte: what follows the command is the session's.
        let (port, seen) = fake_proxy(echo, |c| {
            let mut line = Vec::new();
            let mut b = [0u8; 1];
            while line.last() != Some(&b'\n') {
                c.read_exact(&mut b).unwrap();
                line.push(b[0]);
            }
            String::from_utf8_lossy(&line).into_owned()
        });
        let mut p = cfg(Kind::Telnet, port);
        p.telnet_command = "open %host %port\\n".into();
        roundtrip(dial(Some(&p), &Auth::default(), "router1", echo, &mut |_| {}).unwrap());
        assert_eq!(seen.lock().unwrap()[0], format!("open router1 {echo}\n"));
    }

    #[test]
    fn excluded_and_local_hosts_go_directly() {
        let mut p = cfg(Kind::Socks5, 1);
        p.local = false;
        p.exclude = "*.corp.example, 10.0.0.0/8 192.168.1.*".into();
        assert!(p.bypasses("localhost") && p.bypasses("127.0.0.5") && p.bypasses("[::1]"));
        assert!(p.bypasses("db.corp.example") && p.bypasses("DB.CORP.EXAMPLE"));
        assert!(p.bypasses("10.20.30.40") && p.bypasses("192.168.1.9"));
        assert!(!p.bypasses("192.168.2.9") && !p.bypasses("corp.example.org") && !p.bypasses("11.0.0.1"));
        // Excluded: no proxy is contacted (port 1 would refuse).
        let echo = echo_server();
        p.exclude = "127.0.0.1".into();
        p.local = true;
        roundtrip(dial(Some(&p), &Auth::default(), "127.0.0.1", echo, &mut |_| {}).unwrap());
    }

    #[test]
    fn expands_putty_substitutions() {
        let auth = Auth { user: "u".into(), pass: "p".into() };
        assert_eq!(expand("connect %host %port\\n", "h", 22, &auth), b"connect h 22\n");
        assert_eq!(expand("%user:%pass 100%% \\r\\t\\\\ \\x41", "h", 1, &auth), b"u:p 100% \r\t\\ A");
    }

    /// Multi-byte characters anywhere (after `%`, after `\`, before `\x`)
    /// are copied unchanged instead of panicking.
    #[test]
    fn expands_around_korean_text() {
        let auth = Auth { user: "사용자".into(), pass: "p".into() };
        let template = r"C:\Users\김철수\plink.exe -nc %host:%port %김 \x4 %user\김";
        let expected = r"C:\Users\김철수\plink.exe -nc 서버:22 %김 \x4 사용자\김";
        assert_eq!(String::from_utf8(expand(template, "서버", 22, &auth)).unwrap(), expected);
        assert_eq!(expand("\\x김 끝\\", "h", 1, &auth), "\\x김 끝\\".as_bytes());
    }

    #[test]
    fn local_command_is_the_connection() {
        // A "proxy" that reads one line from the connection and answers at
        // once, naming the target it was started for.
        let mut p = cfg(Kind::Local, 0);
        p.local_command = "set /p LINE=& call echo %host %port got %LINE%".into();
        let mut s = dial(Some(&p), &Auth::default(), "router1", 23, &mut |_| {}).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(b"hello\r\n").unwrap();
        let mut r = BufReader::new(s);
        assert_eq!(read_line(&mut r).trim_end(), "router1 23 got hello");
    }

    #[test]
    fn a_refusing_proxy_is_reported() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut g = [0u8; 3];
            c.read_exact(&mut g).unwrap();
            c.write_all(&[5, 0]).unwrap();
            let mut r = [0u8; 64];
            let _ = c.read(&mut r);
            c.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).unwrap();
        });
        let err = dial(Some(&cfg(Kind::Socks5, port)), &Auth::default(), "host.test", 22, &mut |_| {}).unwrap_err();
        assert!(err.contains("connection refused"), "{err}");
    }
}
