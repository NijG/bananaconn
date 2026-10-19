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
