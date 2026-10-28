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

/// Running pings by the id the dialog gave, so closing it (or "Stop") ends
/// ping.exe instead of leaving it running for up to 20 x 2 s.
static PINGS: Mutex<Option<HashMap<String, Arc<Mutex<Child>>>>> = Mutex::new(None);

fn pings<R>(f: impl FnOnce(&mut HashMap<String, Arc<Mutex<Child>>>) -> R) -> R {
    f(PINGS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new))
}

#[tauri::command]
pub async fn net_ping(id: String, host: String, count: u32) -> Result<String, String> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']').to_string();
    if !valid_host(&host) {
        return Err("호스트 이름이 올바르지 않습니다".into());
    }
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

#[tauri::command]
pub async fn net_ports(host: String, ports: Vec<u16>) -> Result<Vec<PortResult>, String> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']').to_string();
    if !valid_host(&host) {
        return Err("호스트 이름이 올바르지 않습니다".into());
    }
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
    ips.dedup();
    if ips.is_empty() {
        return Err(format!("{host} 주소를 찾을 수 없습니다"));
    }
    let ips = &ips;
    let checks = ports.into_iter().map(|port| async move {
        let mut result = None;
        for ip in ips {
            let started = Instant::now();
            let r = match tokio::time::timeout(Duration::from_secs(3), TcpStream::connect({
                let mut a = *ip;
                a.set_port(port);
                a
            })).await {
                Ok(Ok(_)) => return PortResult { port, open: true, ms: Some(started.elapsed().as_millis() as u64), detail: "열림".into() },
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                    PortResult { port, open: false, ms: None, detail: "닫힘 (연결 거부)".into() }
                }
                Ok(Err(e)) => PortResult { port, open: false, ms: None, detail: format!("연결 실패: {e}") },
                Err(_) => PortResult { port, open: false, ms: None, detail: "응답 없음 (방화벽에서 막혔을 수 있음)".into() },
            };
            result.get_or_insert(r);
        }
        result.expect("at least one address")
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
    let host = host.trim().to_string();
    if !valid_host(&host) {
        return Err("호스트 이름이 올바르지 않습니다".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let mut addresses: Vec<String> = (host.as_str(), 0)
            .to_socket_addrs()
            .map_err(|e| format!("{host} 주소를 찾을 수 없습니다: {e}"))?
            .map(|a| a.ip().to_string())
            .collect();
        addresses.dedup();
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

/// Send a Wake-on-LAN magic packet to wake a PC that is off but still powered
/// (BIOS Wake-on-LAN enabled). `broadcast` defaults to the limited broadcast
/// address; a subnet-directed broadcast (e.g. 192.168.1.255) reaches another
/// subnet when the network forwards it. Standard WoL ports are 9 and 7.
#[tauri::command]
pub fn wake_on_lan(mac: String, broadcast: Option<String>, port: Option<u16>) -> Result<(), String> {
    let bytes = parse_mac(&mac).ok_or("MAC 주소가 올바르지 않습니다 (예: AA:BB:CC:DD:EE:FF)")?;
    let packet = magic_packet(&bytes);
    let target = broadcast.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("255.255.255.255");
    let port = port.unwrap_or(9);
    let addr: SocketAddr = format!("{target}:{port}").parse().map_err(|_| "브로드캐스트 주소가 올바르지 않습니다".to_string())?;
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    sock.set_broadcast(true).map_err(|e| e.to_string())?;
    sock.send_to(&packet, addr).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod wol_tests {
    use super::{magic_packet, parse_mac};

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
    use super::valid_host;

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
}
