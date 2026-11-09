// Network tools: ping (the system ping.exe), TCP port check and DNS lookup.
// Inputs come from the user; hosts are validated so they can never become
// command-line options of ping.exe.

use std::net::{SocketAddr, ToSocketAddrs};
use std::os::windows::process::CommandExt;
use std::collections::HashMap;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::net::TcpStream;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A host name or IP literal: letters, digits, '.', '-', ':' (IPv6), '%'
/// (IPv6 zone), never starting with '-'.
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && !host.starts_with('-')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '%' | '_'))
}

/// The host the dialog sent, as the tools take it: trimmed, an IPv6 literal
/// out of its URL brackets ("[::1]"), and checked by valid_host.
fn parse_host(host: &str) -> Result<String, String> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if valid_host(host) { Ok(host.to_string()) } else { Err("호스트 이름이 올바르지 않습니다".into()) }
}

/// Running pings by the id the dialog gave, so closing it (or "Stop") ends
/// ping.exe instead of leaving it running for up to 20 x 2 s.
static PINGS: Mutex<Option<HashMap<String, Arc<Mutex<Child>>>>> = Mutex::new(None);

fn pings<R>(f: impl FnOnce(&mut HashMap<String, Arc<Mutex<Child>>>) -> R) -> R {
    f(PINGS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new))
}

#[tauri::command]
pub async fn net_ping(id: String, host: String, count: u32) -> Result<String, String> {
    let host = parse_host(&host)?;
    let count = count.clamp(1, 20);
    tauri::async_runtime::spawn_blocking(move || {
        let ping = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| "C:\\Windows".into())
            .join("System32")
            .join("PING.EXE");
        let mut child = std::process::Command::new(ping)
            // Windows ping has no "--"; valid_host already rules out a leading "-".
            .args(["-n", &count.to_string(), "-w", "2000", &host])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("ping을 실행할 수 없습니다: {e}"))?;
        // Drain both pipes on their own threads so a full pipe never stalls ping.
        let drain = |r: Option<Box<dyn std::io::Read + Send>>| {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                if let Some(mut r) = r {
                    let _ = r.read_to_end(&mut buf);
                }
                buf
            })
        };
        let out_t = drain(child.stdout.take().map(|r| Box::new(r) as _));
        let err_t = drain(child.stderr.take().map(|r| Box::new(r) as _));
        let child = Arc::new(Mutex::new(child));
        pings(|m| m.insert(id.clone(), child.clone()));
        let status = loop {
            match child.lock().unwrap_or_else(|e| e.into_inner()).try_wait() {
                Ok(Some(st)) => break Ok(st),
                Ok(None) => {}
                Err(e) => break Err(e.to_string()),
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let cancelled = pings(|m| m.remove(&id)).is_none();
        let stdout = out_t.join().unwrap_or_default();
        let stderr = err_t.join().unwrap_or_default();
        status?;
        if cancelled {
            return Err("CANCELLED".into());
        }
        // ping.exe writes in the console (OEM) code page.
        let cp = unsafe { windows_sys::Win32::Globalization::GetOEMCP() };
        let mut text = crate::store::decode_code_page(cp, &stdout, false).unwrap_or_else(|| String::from_utf8_lossy(&stdout).into_owned());
        text.push_str(&String::from_utf8_lossy(&stderr));
        Ok(text.trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// End a running ping; its net_ping call then fails with "CANCELLED".
#[tauri::command]
pub fn net_ping_cancel(id: String) {
    if let Some(child) = pings(|m| m.remove(&id)) {
        let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortResult {
    port: u16,
    open: bool,
    /// Connect time when open, milliseconds.
    ms: Option<u64>,
    detail: String,
}

/// When a port is closed on several addresses of one host, decide whether a
/// newly seen failure should replace the one kept so far. The first failure is
/// always kept; after that, only a definitive "refused" (the host answered: the
/// port is closed) replaces a less certain timeout or other error. This keeps
/// the reported reason stable and informative no matter which address of a
/// dual-stack host resolved first.
fn prefer_failure(have_refused: bool, have_any: bool, new_refused: bool) -> bool {
    !have_any || (new_refused && !have_refused)
}

/// Each item once, in the resolver's order (Vec::dedup alone keeps "a, b, a").
fn unique_in_order<T: Eq + std::hash::Hash + Clone>(v: &mut Vec<T>) {
    let mut seen = std::collections::HashSet::new();
    v.retain(|x| seen.insert(x.clone()));
}

#[tauri::command]
pub async fn net_ports(host: String, ports: Vec<u16>) -> Result<Vec<PortResult>, String> {
    let host = parse_host(&host)?;
    if ports.is_empty() || ports.len() > 64 || ports.contains(&0) {
        return Err("포트는 1~65535 사이로 64개까지 확인할 수 있습니다".into());
    }
    let h = host.clone();
    // Every address the name has: "localhost" is ::1 first, and a service
    // listening on 127.0.0.1 only is still open.
    // Whole addresses: an IPv6 one keeps its zone ("fe80::1%12").
    let mut ips: Vec<SocketAddr> = tauri::async_runtime::spawn_blocking(move || (h.as_str(), 0).to_socket_addrs().map(|a| a.collect::<Vec<_>>()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{host} 주소를 찾을 수 없습니다: {e}"))?;
    unique_in_order(&mut ips);
    if ips.is_empty() {
        return Err(format!("{host} 주소를 찾을 수 없습니다"));
    }
    let ips = &ips;
    let checks = ports.into_iter().map(|port| async move {
        // Every address at once: a dual-stack host whose IPv6 does not answer
        // takes 3 s, not 3 s per address. The outcome is chosen as before: open
        // on any address wins (the first one in the resolver's order), else the
        // failures in that order through prefer_failure.
        let attempts = ips.iter().map(|ip| async move {
            let started = Instant::now();
            let mut a = *ip;
            a.set_port(port);
            match tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(a)).await {
                Ok(Ok(_)) => (false, PortResult { port, open: true, ms: Some(started.elapsed().as_millis() as u64), detail: "열림".into() }),
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                    (true, PortResult { port, open: false, ms: None, detail: "닫힘 (연결 거부)".into() })
                }
                Ok(Err(e)) => (false, PortResult { port, open: false, ms: None, detail: format!("연결 실패: {e}") }),
                Err(_) => (false, PortResult { port, open: false, ms: None, detail: "응답 없음 (방화벽에서 막혔을 수 있음)".into() }),
            }
        });
        let outcomes = futures_util::future::join_all(attempts).await;
        let mut best: Option<PortResult> = None;
        let mut have_refused = false;
        for (refused, r) in outcomes {
            if r.open {
                return r;
            }
            if prefer_failure(have_refused, best.is_some(), refused) {
                best = Some(r);
                have_refused = refused;
            }
        }
        best.expect("at least one address")
    });
    Ok(futures_util::future::join_all(checks).await)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsResult {
    addresses: Vec<String>,
    ms: u64,
}

#[tauri::command]
pub async fn net_dns(host: String) -> Result<DnsResult, String> {
    let host = parse_host(&host)?;
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let mut addresses: Vec<String> = (host.as_str(), 0)
            .to_socket_addrs()
            .map_err(|e| format!("{host} 주소를 찾을 수 없습니다: {e}"))?
            .map(|a| a.ip().to_string())
            .collect();
        unique_in_order(&mut addresses);
        Ok(DnsResult { addresses, ms: started.elapsed().as_millis() as u64 })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Parse a MAC address — "AA:BB:CC:DD:EE:FF", "aa-bb-...", or 12 bare hex
/// digits — into its six bytes.
fn parse_mac(mac: &str) -> Option<[u8; 6]> {
    let hex: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 12 {
        return None;
    }
    let mut out = [0u8; 6];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// The Wake-on-LAN magic packet for a MAC: six 0xFF bytes then the MAC sixteen
/// times (102 bytes).
fn magic_packet(mac: &[u8; 6]) -> Vec<u8> {
    let mut packet = vec![0xFFu8; 6];
    for _ in 0..16 {
        packet.extend_from_slice(mac);
    }
    packet
}

/// Ports a Wake-on-LAN packet goes to: the caller's one when given, else both
/// standard ports (9 and 7). Some NICs listen on only one, so sending to both
/// makes the wake more reliable.
fn wol_ports(port: Option<u16>) -> Vec<u16> {
    match port {
        Some(p) => vec![p],
        None => vec![9, 7],
    }
}

/// Send a Wake-on-LAN magic packet to wake a PC that is off but still powered
/// (BIOS Wake-on-LAN enabled). `broadcast` defaults to the limited broadcast
/// address; a subnet-directed broadcast (e.g. 192.168.1.255) reaches another
/// subnet when the network forwards it. With no port it is sent to both standard
/// WoL ports (9 and 7); it succeeds if any send goes out.
#[tauri::command]
pub fn wake_on_lan(mac: String, broadcast: Option<String>, port: Option<u16>) -> Result<(), String> {
    let bytes = parse_mac(&mac).ok_or("MAC 주소가 올바르지 않습니다 (예: AA:BB:CC:DD:EE:FF)")?;
    let packet = magic_packet(&bytes);
    let target = broadcast.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("255.255.255.255");
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    sock.set_broadcast(true).map_err(|e| e.to_string())?;
    let mut sent = false;
    let mut last_err = None;
    for p in wol_ports(port) {
        let addr: SocketAddr = format!("{target}:{p}").parse().map_err(|_| "브로드캐스트 주소가 올바르지 않습니다".to_string())?;
        match sock.send_to(&packet, addr) {
            Ok(_) => sent = true,
            Err(e) => last_err = Some(e.to_string()),
        }
    }
    if sent {
        Ok(())
    } else {
        Err(last_err.unwrap_or_else(|| "매직 패킷을 보내지 못했습니다".to_string()))
    }
}

// ---- ping sweep ---------------------------------------------------------------------

/// A host of a swept subnet that is there: one that answered the ping, with
/// its round trip, or one on this PC's own segment that answered ARP just
/// now but not the ping (no round trip). A host on that segment has its MAC
/// (12 lowercase hex digits).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SweepHit {
    pub ip: String,
    pub ms: Option<u32>,
    pub mac: Option<String>,
}

/// The host addresses of `network`/`prefix` a sweep pings: without the
/// network and broadcast addresses, except /31 (both are hosts, RFC 3021)
/// and /32 (the one address). At most a /22 (1022 hosts) in one sweep.
fn sweep_targets(network: std::net::Ipv4Addr, prefix: u8) -> Result<Vec<std::net::Ipv4Addr>, String> {
    if !(22..=32).contains(&prefix) {
        return Err("한 번에 /22(호스트 1022개)까지 검사할 수 있습니다".into());
    }
    let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
    let first = u32::from(network) & mask;
    let last = first | !mask;
    let range = if prefix >= 31 { first..=last } else { first + 1..=last - 1 };
    Ok(range.map(std::net::Ipv4Addr::from).collect())
}

/// Sweeps running, by the id the dialog gave: "Stop" and closing the dialog end them.
static SWEEPS: Mutex<Option<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>> = Mutex::new(None);

fn sweeps<R>(f: impl FnOnce(&mut HashMap<String, Arc<std::sync::atomic::AtomicBool>>) -> R) -> R {
    f(SWEEPS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new))
}

/// The stop flag of sweep `id`, made on first use: a Stop that arrives before
/// net_sweep has started (the dialog closed at once) is kept and ends it.
fn sweep_flag(id: &str) -> Arc<std::sync::atomic::AtomicBool> {
    sweeps(|m| m.entry(id.to_string()).or_default().clone())
}

/// An ICMP handle, closed however its worker ends.
struct Icmp(windows_sys::Win32::Foundation::HANDLE);

impl Drop for Icmp {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::NetworkManagement::IpHelper::IcmpCloseHandle(self.0) };
    }
}

/// One ICMP echo through iphlpapi (no ping.exe per host, no administrator
/// rights needed); the round trip when `ip` itself answered in time.
fn echo(handle: windows_sys::Win32::Foundation::HANDLE, ip: std::net::Ipv4Addr, timeout_ms: u32) -> Option<u32> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{IcmpSendEcho, ICMP_ECHO_REPLY, IP_SUCCESS};
    let data = [0x42u8; 32];
    // The reply, the echoed data and room for an ICMP error, 8-byte aligned.
    let mut buf = [0u64; (std::mem::size_of::<ICMP_ECHO_REPLY>() + 32 + 8 + 64) / 8];
    let addr = u32::from_ne_bytes(ip.octets());
    let n = unsafe {
        IcmpSendEcho(handle, addr, data.as_ptr().cast(), data.len() as u16, std::ptr::null(), buf.as_mut_ptr().cast(), std::mem::size_of_val(&buf) as u32, timeout_ms)
    };
    if n == 0 {
        return None;
    }
    let reply = unsafe { &*(buf.as_ptr() as *const ICMP_ECHO_REPLY) };
    // A router's "unreachable" is a reply too: only the host's own echo counts.
    (reply.Status == IP_SUCCESS && reply.Address == addr).then_some(reply.RoundTripTime)
}

/// Ping `targets`, at most 64 at once (each worker with its own ICMP handle);
/// the hosts that answered, in address order. `progress` gets the number
/// done; a set `cancel` stops it ("CANCELLED"). With no ICMP handle at all
/// nothing was asked: an error, never "nobody answered".
fn sweep(targets: &[std::net::Ipv4Addr], timeout_ms: u32, cancel: &std::sync::atomic::AtomicBool, progress: &(dyn Fn(usize) + Sync)) -> Result<Vec<SweepHit>, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::NetworkManagement::IpHelper::IcmpCreateFile;
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let opened = AtomicUsize::new(0);
    let hits = Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..targets.len().min(64) {
            s.spawn(|| {
                let handle = unsafe { IcmpCreateFile() };
                if handle == INVALID_HANDLE_VALUE {
                    return;
                }
                let icmp = Icmp(handle);
                opened.fetch_add(1, Ordering::Relaxed);
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= targets.len() || cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    if let Some(ms) = echo(icmp.0, targets[i], timeout_ms) {
                        hits.lock().unwrap_or_else(|e| e.into_inner()).push((i, ms));
                    }
                    progress(done.fetch_add(1, Ordering::Relaxed) + 1);
                }
            });
        }
    });
    if cancel.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    if opened.load(Ordering::Relaxed) == 0 && !targets.is_empty() {
        return Err(format!("ICMP를 쓸 수 없어 검사하지 못했습니다: {}", std::io::Error::last_os_error()));
    }
    let mut hits = hits.into_inner().unwrap_or_else(|e| e.into_inner());
    hits.sort_unstable();
    Ok(hits.into_iter().map(|(i, ms)| SweepHit { ip: targets[i].to_string(), ms: Some(ms), mac: None }).collect())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SweepProgress {
    id: String,
    done: usize,
    total: usize,
}

/// Ping every host address of `network`/`prefix` (a /22 at most) and return
/// the ones that answered; "sweep-progress" events tell how far it is.
/// Fails with "CANCELLED" when net_sweep_cancel stops it.
#[tauri::command]
pub async fn net_sweep(app: tauri::AppHandle, id: String, network: String, prefix: u8, timeout_ms: u32) -> Result<Vec<SweepHit>, String> {
    use tauri::Emitter;
    let network: std::net::Ipv4Addr = network.trim().parse().map_err(|_| "IPv4 네트워크 주소가 올바르지 않습니다".to_string())?;
    let targets = sweep_targets(network, prefix)?;
    let timeout_ms = timeout_ms.clamp(200, 5000);
    let cancel = sweep_flag(&id);
    let total = targets.len();
    let last = Mutex::new(Instant::now());
    let res = tauri::async_runtime::spawn_blocking({
        let id = id.clone();
        let cancel = cancel.clone();
        move || {
            let hits = sweep(&targets, timeout_ms, &cancel, &|done| {
                // A few updates a second, and the last one.
                let mut at = last.lock().unwrap_or_else(|e| e.into_inner());
                if done == total || at.elapsed() >= Duration::from_millis(150) {
                    *at = Instant::now();
                    let _ = app.emit("sweep-progress", SweepProgress { id: id.clone(), done, total });
                }
            })?;
            Ok(with_neighbors(hits, &targets, &neighbor_macs()))
        }
    })
    .await
    .map_err(|e| e.to_string());
    sweeps(|m| m.remove(&id));
    res?
}

/// Stop sweep `id`, running or about to start; its net_sweep call then fails
/// with "CANCELLED". (The ids are new for every sweep, so a flag left by a
/// Stop that came after its sweep ended is never met again.)
#[tauri::command]
pub fn net_sweep_cancel(id: String) {
    sweep_flag(&id).store(true, std::sync::atomic::Ordering::Relaxed);
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WatchReply {
    id: String,
    seq: u32,
    /// The round trip; none for no answer within the wait.
    ms: Option<u32>,
}

/// Ping `ip` (an IPv4 address) every `interval_ms` until net_watch_stop (the
/// dialog's Stop or its closing), sending each result as a "watch-reply"
/// event: to watch a device go down and come back (a reload). Ends by itself
/// after a day, so one left running is never forgotten for good.
#[tauri::command]
pub async fn net_watch(app: tauri::AppHandle, id: String, ip: String, interval_ms: u32) -> Result<(), String> {
    use tauri::Emitter;
    let ip: std::net::Ipv4Addr = ip.trim().parse().map_err(|_| "IPv4 주소가 올바르지 않습니다".to_string())?;
    let interval = Duration::from_millis(interval_ms.clamp(500, 10_000) as u64);
    // Waiting longer than the interval would let the replies fall behind.
    let timeout_ms = (interval.as_millis() as u32).min(2000);
    let stop = sweep_flag(&id);
    let res = tauri::async_runtime::spawn_blocking({
        let id = id.clone();
        // The window gone (emit fails): nobody to tell, so it ends.
        move || watch(ip, interval, timeout_ms, &stop, Duration::from_secs(24 * 3600), |seq, ms| app.emit("watch-reply", WatchReply { id: id.clone(), seq, ms }).is_ok())
    })
    .await
    .map_err(|e| e.to_string());
    sweeps(|m| m.remove(&id));
    res?
}

/// net_watch's loop: an echo every `interval` until `stop`, `max` or `reply`
/// returns false; `reply` gets the sequence number and the round trip.
fn watch(ip: std::net::Ipv4Addr, interval: Duration, timeout_ms: u32, stop: &std::sync::atomic::AtomicBool, max: Duration, mut reply: impl FnMut(u32, Option<u32>) -> bool) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::NetworkManagement::IpHelper::IcmpCreateFile;
    let handle = unsafe { IcmpCreateFile() };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!("ICMP를 쓸 수 없습니다: {}", std::io::Error::last_os_error()));
    }
    let icmp = Icmp(handle);
    let started = Instant::now();
    let mut seq = 0u32;
    while !stop.load(Ordering::Relaxed) && started.elapsed() < max {
        let at = Instant::now();
        seq += 1;
        if !reply(seq, echo(icmp.0, ip, timeout_ms)) {
            break;
        }
        // The rest of the interval, in short steps so a Stop is quick.
        while !stop.load(Ordering::Relaxed) && at.elapsed() < interval {
            std::thread::sleep(Duration::from_millis(50).min(interval.saturating_sub(at.elapsed())));
        }
    }
    Ok(())
}

/// Stop net_watch `id` (also one about to start).
#[tauri::command]
pub fn net_watch_stop(id: String) {
    sweep_flag(&id).store(true, std::sync::atomic::Ordering::Relaxed);
}

/// What came back for one probe of a trace.
enum Probe {
    /// An answer from `from`: the target's echo (IP_SUCCESS), a router's
    /// "time exceeded" (IP_TTL_EXPIRED_TRANSIT) or its "unreachable".
    Reply { from: std::net::Ipv4Addr, ms: u32, status: u32 },
    /// No answer within the wait.
    Silent,
}

/// One echo to `ip` that may live `ttl` hops; Err with the IP status when
/// it could not be sent at all (no route from this PC, for one).
fn probe(handle: windows_sys::Win32::Foundation::HANDLE, ip: std::net::Ipv4Addr, ttl: u8, timeout_ms: u32) -> Result<Probe, u32> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{IcmpSendEcho, ICMP_ECHO_REPLY, IP_OPTION_INFORMATION, IP_REQ_TIMED_OUT};
    let data = [0x42u8; 32];
    let options = IP_OPTION_INFORMATION { Ttl: ttl, Tos: 0, Flags: 0, OptionsSize: 0, OptionsData: std::ptr::null_mut() };
    // The reply, the echoed data and room for a router's ICMP error (which
    // carries the original IP header and 8 bytes), 8-byte aligned.
    let mut buf = [0u64; (std::mem::size_of::<ICMP_ECHO_REPLY>() + 32 + 8 + 128) / 8];
    let n = unsafe {
        IcmpSendEcho(handle, u32::from_ne_bytes(ip.octets()), data.as_ptr().cast(), data.len() as u16, &options, buf.as_mut_ptr().cast(), std::mem::size_of_val(&buf) as u32, timeout_ms)
    };
    if n == 0 {
        let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32;
        return if code == IP_REQ_TIMED_OUT { Ok(Probe::Silent) } else { Err(code) };
    }
    let reply = unsafe { &*(buf.as_ptr() as *const ICMP_ECHO_REPLY) };
    if reply.Status == IP_REQ_TIMED_OUT {
        return Ok(Probe::Silent);
    }
    Ok(Probe::Reply { from: std::net::Ipv4Addr::from(reply.Address.to_ne_bytes()), ms: reply.RoundTripTime, status: reply.Status })
}

/// How a trace ended.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TraceEnd {
    /// The target answered (its own echo).
    reached: bool,
    /// A router said the target cannot be reached: the IP status
    /// (11002 network, 11003 host, 11004 protocol, 11005 port).
    unreachable: Option<u32>,
    /// The hops tried.
    hops: u8,
}

/// The route to `ip`: three echoes at each number of hops from 1 to
/// `max_hops`, as tracert sends them; `hop` gets each hop's answering
/// addresses (several when the load is shared) and round trips, and
/// returning false stops it. Ends at the target's answer or a router's
/// "unreachable"; a set `stop` ends it with "CANCELLED".
fn trace(ip: std::net::Ipv4Addr, max_hops: u8, timeout_ms: u32, stop: &std::sync::atomic::AtomicBool, mut hop: impl FnMut(u8, Vec<std::net::Ipv4Addr>, Vec<Option<u32>>) -> bool) -> Result<TraceEnd, String> {
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::NetworkManagement::IpHelper::{IcmpCreateFile, IP_DEST_HOST_UNREACHABLE, IP_DEST_NET_UNREACHABLE, IP_DEST_PORT_UNREACHABLE, IP_DEST_PROT_UNREACHABLE, IP_SUCCESS};
    let handle = unsafe { IcmpCreateFile() };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!("ICMP를 쓸 수 없습니다: {}", std::io::Error::last_os_error()));
    }
    let icmp = Icmp(handle);
    for ttl in 1..=max_hops {
        let mut addrs = Vec::new();
        let mut times = Vec::new();
        let mut reached = false;
        let mut unreachable = None;
        for _ in 0..3 {
            if stop.load(Ordering::Relaxed) {
                return Err("CANCELLED".into());
            }
            match probe(icmp.0, ip, ttl, timeout_ms) {
                Ok(Probe::Silent) => times.push(None),
                // An answer of another kind with no sender to show: as none.
                Ok(Probe::Reply { from, .. }) if from.is_unspecified() => times.push(None),
                Ok(Probe::Reply { from, ms, status }) => {
                    if !addrs.contains(&from) {
                        addrs.push(from);
                    }
                    times.push(Some(ms));
                    if status == IP_SUCCESS {
                        reached = true;
                    } else if [IP_DEST_NET_UNREACHABLE, IP_DEST_HOST_UNREACHABLE, IP_DEST_PROT_UNREACHABLE, IP_DEST_PORT_UNREACHABLE].contains(&status) {
                        unreachable = Some(status);
                    }
                }
                // The very first echo could not even be sent: no route from
                // this PC. Later, one probe failing is one without an answer.
                Err(code) if ttl == 1 && times.is_empty() => {
                    return Err(format!("경로를 추적할 수 없습니다. 이 PC에서 그 주소로 가는 경로가 없거나 네트워크 오류입니다 (IP 상태 {code})"));
                }
                Err(_) => times.push(None),
            }
        }
        if !hop(ttl, addrs, times) {
            return Err("CANCELLED".into());
        }
        if reached || unreachable.is_some() {
            return Ok(TraceEnd { reached, unreachable, hops: ttl });
        }
    }
    Ok(TraceEnd { reached: false, unreachable: None, hops: max_hops })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TraceHop {
    id: String,
    ttl: u8,
    addrs: Vec<String>,
    /// Each probe's round trip; none for no answer within the wait.
    ms: Vec<Option<u32>>,
}

/// Trace the route to `ip` (an IPv4 address), each hop sent as a
/// "trace-hop" event as it comes in; fails with "CANCELLED" when
/// net_trace_stop (the dialog's Stop or its closing) ends it.
#[tauri::command]
pub async fn net_trace(app: tauri::AppHandle, id: String, ip: String, max_hops: u8) -> Result<TraceEnd, String> {
    use tauri::Emitter;
    let ip: std::net::Ipv4Addr = ip.trim().parse().map_err(|_| "IPv4 주소가 올바르지 않습니다".to_string())?;
    let max_hops = max_hops.clamp(1, 64);
    let stop = sweep_flag(&id);
    let res = tauri::async_runtime::spawn_blocking({
        let id = id.clone();
        // The window gone (emit fails): nobody to tell, so it ends.
        move || {
            trace(ip, max_hops, 1500, &stop, |ttl, addrs, ms| {
                app.emit("trace-hop", TraceHop { id: id.clone(), ttl, addrs: addrs.iter().map(|a| a.to_string()).collect(), ms }).is_ok()
            })
        }
    })
    .await
    .map_err(|e| e.to_string());
    sweeps(|m| m.remove(&id));
    res?
}

/// Stop net_trace `id` (also one about to start).
#[tauri::command]
pub fn net_trace_stop(id: String) {
    sweep_flag(&id).store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Stop every sweep and continuous ping running: the page calls this as it
/// loads, so one left by a page that is gone (reloaded) ends. Its events
/// would reach no one, and an event with no listener does not fail, so the
/// loop could not tell by itself. Ids are new each time: nothing of the new
/// page is stopped.
#[tauri::command]
pub fn net_stop_all() {
    sweeps(|m| m.values().for_each(|f| f.store(true, std::sync::atomic::Ordering::Relaxed)));
}

/// A sweep's hits with what the ARP table read right after it says (the
/// pings just made filled it for the hosts on this segment; one behind a
/// router has no entry): the MAC of each hit, and the targets that answered
/// ARP but not the ping (a firewall dropping it), so that none of them is
/// ever taken for a free address. Only a reachable entry counts for those:
/// an older (stale) one may be a device that has gone. In address order.
fn with_neighbors(mut hits: Vec<SweepHit>, targets: &[std::net::Ipv4Addr], neighbors: &HashMap<std::net::Ipv4Addr, (String, bool)>) -> Vec<SweepHit> {
    for h in &mut hits {
        h.mac = h.ip.parse().ok().and_then(|ip| neighbors.get(&ip)).map(|(mac, _)| mac.clone());
    }
    let pinged: std::collections::HashSet<String> = hits.iter().map(|h| h.ip.clone()).collect();
    for t in targets {
        if let Some((mac, true)) = neighbors.get(t)
            && !pinged.contains(&t.to_string())
        {
            hits.push(SweepHit { ip: t.to_string(), ms: None, mac: Some(mac.clone()) });
        }
    }
    hits.sort_by_key(|h| h.ip.parse::<std::net::Ipv4Addr>().map(u32::from).unwrap_or(0));
    hits
}

/// The MAC of each IPv4 neighbor in this PC's ARP table (12 lowercase hex
/// digits) and whether the entry is reachable (confirmed lately), that one
/// preferred when two interfaces have one. Entries still resolving or
/// failed, and broadcast or empty ones, are left out. Empty when the table
/// cannot be read.
fn neighbor_macs() -> HashMap<std::net::Ipv4Addr, (String, bool)> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIpNetTable2, MIB_IPNET_ROW2, MIB_IPNET_TABLE2};
    use windows_sys::Win32::Networking::WinSock::{NlnsIncomplete, NlnsReachable, NlnsUnreachable, AF_INET};
    let mut out: HashMap<std::net::Ipv4Addr, (String, bool)> = HashMap::new();
    let mut table: *mut MIB_IPNET_TABLE2 = std::ptr::null_mut();
    if unsafe { GetIpNetTable2(AF_INET, &mut table) } != 0 || table.is_null() {
        return HashMap::new();
    }
    // SAFETY: on success the table holds NumEntries rows after its count (the
    // one-element array is the start of them), all freed by FreeMibTable.
    unsafe {
        let first = std::ptr::addr_of!((*table).Table) as *const MIB_IPNET_ROW2;
        let rows = std::slice::from_raw_parts(first, (*table).NumEntries as usize);
        for r in rows {
            if r.State == NlnsUnreachable || r.State == NlnsIncomplete || r.PhysicalAddressLength != 6 {
                continue;
            }
            let mac = &r.PhysicalAddress[..6];
            if mac.iter().all(|&b| b == 0) || mac.iter().all(|&b| b == 0xff) {
                continue;
            }
            let ip = std::net::Ipv4Addr::from(r.Address.Ipv4.sin_addr.S_un.S_addr.to_ne_bytes());
            let reachable = r.State == NlnsReachable;
            if out.get(&ip).is_none_or(|(_, was)| reachable && !was) {
                out.insert(ip, (mac.iter().map(|b| format!("{b:02x}")).collect(), reachable));
            }
        }
        FreeMibTable(table as *const core::ffi::c_void);
    }
    out
}

/// The DNS (or hosts file) name of an address, when it has one.
fn name_of(ip: std::net::Ipv4Addr) -> Option<String> {
    use windows_sys::Win32::Networking::WinSock::{GetNameInfoW, AF_INET, IN_ADDR, IN_ADDR_0, NI_NAMEREQD, SOCKADDR, SOCKADDR_IN};
    // Winsock must be started for the process; any std socket does that, once.
    static WINSOCK: std::sync::Once = std::sync::Once::new();
    WINSOCK.call_once(|| drop(std::net::UdpSocket::bind((std::net::Ipv4Addr::LOCALHOST, 0))));
    let sa = SOCKADDR_IN { sin_family: AF_INET, sin_port: 0, sin_addr: IN_ADDR { S_un: IN_ADDR_0 { S_addr: u32::from_ne_bytes(ip.octets()) } }, sin_zero: [0; 8] };
    // NI_MAXHOST characters and the terminating NUL.
    let mut host = [0u16; 1026];
    let r = unsafe {
        GetNameInfoW(&sa as *const SOCKADDR_IN as *const SOCKADDR, std::mem::size_of::<SOCKADDR_IN>() as i32, host.as_mut_ptr(), host.len() as u32, std::ptr::null_mut(), 0, NI_NAMEREQD as i32)
    };
    if r != 0 {
        return None;
    }
    let len = host.iter().position(|&c| c == 0).unwrap_or(host.len());
    let name = String::from_utf16_lossy(&host[..len]);
    (!name.is_empty() && name != ip.to_string()).then_some(name)
}

/// The names of `ips`, in their order, those found within `wait`. Lookups run
/// on 32 threads of their own: Windows can hold one for seconds when DNS does
/// not answer, so a late one is left to finish and simply not shown.
fn names(ips: Vec<std::net::Ipv4Addr>, wait: Duration) -> Vec<Option<String>> {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let ips = Arc::new(ips);
    let next = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = std::sync::mpsc::channel();
    for _ in 0..ips.len().min(32) {
        let (ips, next, stop, tx) = (ips.clone(), next.clone(), stop.clone(), tx.clone());
        std::thread::spawn(move || loop {
            let i = next.fetch_add(1, Ordering::Relaxed);
            if i >= ips.len() || stop.load(Ordering::Relaxed) || tx.send((i, name_of(ips[i]))).is_err() {
                break;
            }
        });
    }
    drop(tx);
    let deadline = Instant::now() + wait;
    let mut out = vec![None; ips.len()];
    while let Ok((i, name)) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        out[i] = name;
    }
    stop.store(true, Ordering::Relaxed);
    out
}

/// The names of the addresses a sweep found (DNS or the hosts file), in the
/// same order; none for one without a name or not found within 4 seconds.
#[tauri::command]
pub async fn net_names(ips: Vec<String>) -> Result<Vec<Option<String>>, String> {
    let ips = ips
        .iter()
        .take(1024)
        .map(|s| s.trim().parse::<std::net::Ipv4Addr>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "IPv4 주소가 올바르지 않습니다".to_string())?;
    tauri::async_runtime::spawn_blocking(move || names(ips, Duration::from_secs(4))).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod sweep_tests {
    use super::{net_sweep_cancel, sweep, sweep_flag, sweep_targets};
    use std::net::Ipv4Addr;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn targets_are_the_host_addresses() {
        let t = sweep_targets(Ipv4Addr::new(192, 168, 1, 77), 24).unwrap();
        assert_eq!((t.len(), t[0], t[253]), (254, Ipv4Addr::new(192, 168, 1, 1), Ipv4Addr::new(192, 168, 1, 254)));
        assert_eq!(sweep_targets(Ipv4Addr::new(10, 0, 0, 5), 30).unwrap(), vec![Ipv4Addr::new(10, 0, 0, 5), Ipv4Addr::new(10, 0, 0, 6)]);
        assert_eq!(sweep_targets(Ipv4Addr::new(10, 0, 0, 5), 31).unwrap(), vec![Ipv4Addr::new(10, 0, 0, 4), Ipv4Addr::new(10, 0, 0, 5)]);
        assert_eq!(sweep_targets(Ipv4Addr::new(10, 0, 0, 5), 32).unwrap(), vec![Ipv4Addr::new(10, 0, 0, 5)]);
        assert_eq!(sweep_targets(Ipv4Addr::new(10, 0, 0, 0), 22).unwrap().len(), 1022);
        assert!(sweep_targets(Ipv4Addr::new(10, 0, 0, 0), 21).is_err());
        assert!(sweep_targets(Ipv4Addr::new(10, 0, 0, 0), 33).is_err());
    }

    #[test]
    fn loopback_answers_and_cancel_stops() {
        let none = AtomicBool::new(false);
        let hits = sweep(&[Ipv4Addr::LOCALHOST], 1000, &none, &|_| {}).unwrap();
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].ip, "127.0.0.1");
        let stopped = AtomicBool::new(true);
        assert_eq!(sweep(&[Ipv4Addr::LOCALHOST], 1000, &stopped, &|_| {}).unwrap_err(), "CANCELLED");
    }

    #[test]
    fn names_come_back_in_order_within_the_wait() {
        let t = std::time::Instant::now();
        let n = super::names(vec![Ipv4Addr::LOCALHOST, Ipv4Addr::new(192, 0, 2, 1)], std::time::Duration::from_secs(4));
        assert_eq!(n.len(), 2);
        // The loopback has a name (this PC's, or "localhost"); TEST-NET-1 has none.
        assert!(n[0].as_deref().is_some_and(|s| !s.is_empty()), "{n:?}");
        assert!(t.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn arp_only_hosts_are_listed_and_hits_get_their_mac() {
        use super::{with_neighbors, SweepHit};
        let ip = |d: u8| Ipv4Addr::new(10, 0, 0, d);
        let hit = |d: u8, ms: u32| SweepHit { ip: ip(d).to_string(), ms: Some(ms), mac: None };
        let targets: Vec<Ipv4Addr> = (1..=20).map(ip).collect();
        let neighbors = std::collections::HashMap::from([
            (ip(2), ("aa0000000002".to_string(), false)),  // a stale entry still names a hit
            (ip(9), ("aa0000000009".to_string(), true)),   // ARP answered, ping did not
            (ip(12), ("aa000000000c".to_string(), false)), // stale, no ping: maybe gone
            (ip(30), ("aa000000001e".to_string(), true)),  // not a target
        ]);
        let out = with_neighbors(vec![hit(2, 3), hit(15, 1)], &targets, &neighbors);
        let got: Vec<(String, Option<u32>, Option<&str>)> = out.iter().map(|h| (h.ip.clone(), h.ms, h.mac.as_deref())).collect();
        assert_eq!(
            got,
            vec![
                ("10.0.0.2".into(), Some(3), Some("aa0000000002")),
                ("10.0.0.9".into(), None, Some("aa0000000009")),
                ("10.0.0.15".into(), Some(1), None),
            ]
        );
    }

    #[test]
    fn neighbor_macs_are_twelve_hex_digits() {
        // Whatever this PC's ARP table holds now (it may be empty): never
        // a broadcast or empty MAC, always the 12-digit form.
        for (ip, (mac, _)) in super::neighbor_macs() {
            assert!(mac.len() == 12 && mac.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{ip} {mac}");
            assert!(mac != "ffffffffffff" && mac != "000000000000", "{ip}");
        }
    }

    #[test]
    fn watch_replies_in_order_until_told_to_stop() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Duration;
        let stop = AtomicBool::new(false);
        let mut got = Vec::new();
        let t = std::time::Instant::now();
        super::watch(Ipv4Addr::LOCALHOST, Duration::from_millis(500), 500, &stop, Duration::from_secs(30), |seq, ms| {
            got.push((seq, ms.is_some()));
            if seq == 3 {
                stop.store(true, Ordering::Relaxed);
            }
            true
        })
        .unwrap();
        assert_eq!(got, vec![(1, true), (2, true), (3, true)]);
        // Two intervals between three echoes; the stop is not waited out.
        assert!(t.elapsed() >= Duration::from_millis(1000) && t.elapsed() < Duration::from_millis(2500), "{:?}", t.elapsed());
        // A reply that cannot be delivered ends it.
        let mut n = 0;
        super::watch(Ipv4Addr::LOCALHOST, Duration::from_millis(500), 500, &AtomicBool::new(false), Duration::from_secs(30), |_, _| {
            n += 1;
            false
        })
        .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn a_stop_before_the_start_is_kept() {
        net_sweep_cancel("early".into());
        assert!(sweep_flag("early").load(std::sync::atomic::Ordering::Relaxed));
        assert!(!sweep_flag("fresh").load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn a_trace_to_this_pc_ends_at_the_first_hop() {
        let stop = AtomicBool::new(false);
        let mut hops = Vec::new();
        let end = super::trace(Ipv4Addr::LOCALHOST, 30, 1000, &stop, |ttl, addrs, ms| {
            hops.push((ttl, addrs, ms.iter().filter(|m| m.is_some()).count()));
            true
        })
        .unwrap();
        assert_eq!(end, super::TraceEnd { reached: true, unreachable: None, hops: 1 });
        assert_eq!(hops, vec![(1, vec![Ipv4Addr::LOCALHOST], 3)]);
    }

    #[test]
    fn a_trace_stops_when_told_or_when_no_one_listens() {
        let stop = AtomicBool::new(true);
        assert_eq!(super::trace(Ipv4Addr::LOCALHOST, 30, 1000, &stop, |_, _, _| true), Err("CANCELLED".into()));
        super::net_trace_stop("trace-early".into());
        assert!(sweep_flag("trace-early").load(std::sync::atomic::Ordering::Relaxed));
        // The window gone: the hop could not be told.
        let stop = AtomicBool::new(false);
        assert_eq!(super::trace(Ipv4Addr::LOCALHOST, 30, 1000, &stop, |_, _, _| false), Err("CANCELLED".into()));
    }
}

#[cfg(test)]
mod wol_tests {
    use super::{magic_packet, parse_mac, wol_ports};

    #[test]
    fn defaults_to_both_standard_ports() {
        assert_eq!(wol_ports(None), vec![9, 7]);
        assert_eq!(wol_ports(Some(9)), vec![9]);
        assert_eq!(wol_ports(Some(12287)), vec![12287]);
    }

    #[test]
    fn parses_mac_in_several_forms() {
        let want = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF];
        assert_eq!(parse_mac("AA:BB:CC:DD:EE:FF"), Some(want));
        assert_eq!(parse_mac("aa-bb-cc-dd-ee-ff"), Some(want));
        assert_eq!(parse_mac("AABBCCDDEEFF"), Some(want));
        assert_eq!(parse_mac("AA:BB:CC:DD:EE"), None);
        assert_eq!(parse_mac("not a mac"), None);
    }

    #[test]
    fn magic_packet_is_six_ff_then_mac_sixteen_times() {
        let mac = [1u8, 2, 3, 4, 5, 6];
        let p = magic_packet(&mac);
        assert_eq!(p.len(), 102);
        assert_eq!(&p[..6], &[0xFF; 6]);
        assert_eq!(&p[6..12], &mac);
        assert_eq!(&p[96..102], &mac);
    }
}

#[cfg(test)]
mod tests {
    use super::{prefer_failure, unique_in_order, valid_host};

    #[test]
    fn duplicates_are_dropped_keeping_the_first_order() {
        let mut v = vec!["::1", "127.0.0.1", "::1", "10.0.0.1", "127.0.0.1"];
        unique_in_order(&mut v);
        assert_eq!(v, ["::1", "127.0.0.1", "10.0.0.1"]);
    }

    #[test]
    fn refused_is_preferred_over_less_certain_failures() {
        // The first failure is always taken.
        assert!(prefer_failure(false, false, false));
        assert!(prefer_failure(false, false, true));
        // A definitive "refused" replaces a kept timeout/other error...
        assert!(prefer_failure(false, true, true));
        // ...but nothing replaces a refused already kept, and a non-refused
        // never displaces an earlier non-refused (the first one stays).
        assert!(!prefer_failure(true, true, true));
        assert!(!prefer_failure(true, true, false));
        assert!(!prefer_failure(false, true, false));
    }

    #[test]
    fn rejects_hosts_that_could_be_options() {
        for ok in ["10.0.0.1", "example.com", "fe80::1%12", "my_host-01"] {
            assert!(valid_host(ok), "{ok}");
        }
        for bad in ["-t", "-n 100 x", "a b", "x;calc", "", "a\"b", "a&b"] {
            assert!(!valid_host(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn port_check_reports_open_and_closed() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let open = l.local_addr().unwrap().port();
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let r = super::net_ports("127.0.0.1".into(), vec![open, closed]).await.unwrap();
        assert!(r[0].open && !r[1].open, "{:?}", r.iter().map(|x| &x.detail).collect::<Vec<_>>());
    }
}

#[cfg(test)]
mod ping_tests {
    #[tokio::test(flavor = "multi_thread")]
    async fn pings_loopback() {
        let out = super::net_ping("a".into(), "127.0.0.1".into(), 1).await.unwrap();
        assert!(out.contains("127.0.0.1"), "{out}");
        assert!(super::net_ping("b".into(), "-t".into(), 1).await.is_err());
    }

    /// 20 pings to a blackhole address take ~40 s; cancel ends ping.exe at once.
    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_ends_a_long_ping() {
        let started = std::time::Instant::now();
        let run = tokio::spawn(super::net_ping("long".into(), "192.0.2.1".into(), 20));
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        super::net_ping_cancel("long".into());
        let r = run.await.unwrap();
        assert_eq!(r, Err("CANCELLED".into()));
        assert!(started.elapsed() < std::time::Duration::from_secs(3), "{:?}", started.elapsed());
        assert!(super::pings(|m| m.is_empty()));
    }
}

#[cfg(test)]
mod port_tests {
    /// "localhost" resolves to ::1 first; a service on 127.0.0.1 only is open.
    #[test]
    fn localhost_finds_a_service_bound_to_ipv4_only() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let res = tauri::async_runtime::block_on(super::net_ports("localhost".into(), vec![port])).unwrap();
        assert!(res[0].open, "{}", res[0].detail);
    }

    /// A bracketed IPv6 literal, as pasted from a URL, is looked up as the address.
    #[test]
    fn dns_takes_a_bracketed_ipv6_literal() {
        let res = tauri::async_runtime::block_on(super::net_dns(" [::1] ".into())).unwrap();
        assert_eq!(res.addresses, ["::1"]);
    }
}
