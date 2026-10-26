// TFTP client (RFC 1350 with the blksize and tsize options of RFC 2347-2349):
// fetch a file from, or send one to, a TFTP server on network gear or a
// firmware server. TFTP has no listing and no login: the user names the file.
//
// Runs on a blocking thread with a plain UDP socket. Every packet is
// retransmitted after a timeout; block numbers roll over past 65535 for big
// images. A server that ignores the options gets plain 512-byte blocks.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

const RRQ: u16 = 1;
const WRQ: u16 = 2;
const DATA: u16 = 3;
const ACK: u16 = 4;
const ERROR: u16 = 5;
const OACK: u16 = 6;

/// Wait for a reply this long before sending again, this many times.
const TIMEOUT: Duration = Duration::from_secs(3);
const RETRIES: u32 = 5;

#[derive(Default)]
pub struct TftpState {
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TftpRequest {
    /// Transfer id (progress events, cancel).
    pub id: String,
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    /// File name on the server.
    pub remote: String,
    /// File on this PC.
    pub local: String,
    /// "get" (server → PC) or "put" (PC → server).
    pub direction: String,
    /// Block size to ask for (512 = plain RFC 1350, no options).
    #[serde(default)]
    pub block_size: Option<u16>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TftpResult {
    pub bytes: u64,
    pub block_size: u16,
    pub millis: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    id: &'a str,
    done: u64,
    total: Option<u64>,
}

#[tauri::command]
pub async fn tftp_transfer(app: AppHandle, state: State<'_, TftpState>, req: TftpRequest) -> Result<TftpResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    state.cancels.lock().unwrap().insert(req.id.clone(), cancel.clone());
    let id = req.id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        // About eight events a second: with 512-byte blocks every block
        // would otherwise be a UI event (131 072 for a 64 MB image).
        let mut last: Option<Instant> = None;
        let mut report = |done: u64, total: Option<u64>| {
            let now = Instant::now();
            if total != Some(done) && last.is_some_and(|t| now - t < Duration::from_millis(120)) {
                return;
            }
            last = Some(now);
            let _ = app.emit("tftp-progress", Progress { id: &req.id, done, total });
        };
        transfer(&req, &cancel, &mut report)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    state.cancels.lock().unwrap().remove(&id);
    result
}

#[tauri::command]
pub fn tftp_cancel(state: State<TftpState>, id: String) {
    if let Some(flag) = state.cancels.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

pub(crate) fn transfer(req: &TftpRequest, cancel: &AtomicBool, report: &mut dyn FnMut(u64, Option<u64>)) -> Result<TftpResult, String> {
    let remote = req.remote.trim();
    if remote.is_empty() || remote.contains('\0') {
        return Err("서버의 파일 이름을 입력하세요".into());
    }
    let server: SocketAddr = (req.host.trim(), req.port.unwrap_or(69))
        .to_socket_addrs()
        .map_err(|e| format!("호스트 주소를 찾을 수 없습니다: {e}"))?
        .next()
        .ok_or("호스트 주소를 찾을 수 없습니다")?;
    let bind = if server.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" };
    let sock = UdpSocket::bind(bind).map_err(|e| format!("UDP 소켓을 열 수 없습니다: {e}"))?;
    sock.set_read_timeout(Some(TIMEOUT)).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let wanted = req.block_size.unwrap_or(1428).clamp(8, 65464);
    let local = PathBuf::from(&req.local);
    let (bytes, block_size) = match req.direction.as_str() {
        "get" => get(&sock, server, remote, &local, wanted, cancel, report)?,
        "put" => put(&sock, server, remote, &local, wanted, cancel, report)?,
        other => return Err(format!("알 수 없는 방향입니다: {other}")),
    };
    Ok(TftpResult { bytes, block_size, millis: started.elapsed().as_millis() as u64 })
}

/// RRQ/WRQ packet, with the options when a block size other than 512 is wanted.
fn request(op: u16, file: &str, blksize: u16, tsize: Option<u64>) -> Vec<u8> {
    let mut p = op.to_be_bytes().to_vec();
    for part in [file, "octet"] {
        p.extend_from_slice(part.as_bytes());
        p.push(0);
    }
    if blksize != 512 {
        for part in ["blksize".to_string(), blksize.to_string(), "tsize".to_string(), tsize.unwrap_or(0).to_string()] {
            p.extend_from_slice(part.as_bytes());
            p.push(0);
        }
    }
    p
}

fn ack(block: u16) -> [u8; 4] {
    let b = block.to_be_bytes();
    [0, ACK as u8, b[0], b[1]]
}

/// "option\0value\0…" of an OACK.
fn options(body: &[u8]) -> HashMap<String, String> {
    let parts: Vec<String> = body.split(|&b| b == 0).map(|s| String::from_utf8_lossy(s).to_ascii_lowercase()).collect();
    parts.chunks(2).filter(|c| c.len() == 2 && !c[0].is_empty()).map(|c| (c[0].clone(), c[1].clone())).collect()
}

/// The block size an OACK settles on: 512 when it names none. RFC 2348
/// allows 8..=65464, and a server may only lower what was asked; anything
/// else is refused (0 made an upload send empty blocks forever).
fn negotiated_blksize(oack: &HashMap<String, String>, wanted: u16) -> Result<u16, String> {
    let Some(value) = oack.get("blksize") else { return Ok(512) };
    value
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|b| (8..=65464).contains(b) && *b <= wanted)
        .ok_or_else(|| format!("TFTP 서버가 올바르지 않은 블록 크기를 보냈습니다 ({value})"))
}

fn server_error(packet: &[u8]) -> String {
    let code = u16::from_be_bytes([packet[2], packet[3]]);
    let msg = String::from_utf8_lossy(&packet[4..]).trim_end_matches('\0').to_string();
    let what = match code {
        1 => "파일이 없습니다",
        2 => "접근이 거부되었습니다",
        3 => "서버 디스크가 가득 찼습니다",
        6 => "파일이 이미 있습니다",
        _ => "서버가 거부했습니다",
    };
    if msg.is_empty() { format!("TFTP 오류: {what}") } else { format!("TFTP 오류: {what} ({msg})") }
}

/// Wait for the next packet from `peer` without sending anything: None when
/// nothing comes before `deadline`.
fn listen(sock: &UdpSocket, peer: SocketAddr, deadline: Instant, cancel: &AtomicBool, buf: &mut [u8]) -> Result<Option<usize>, String> {
    while Instant::now() < deadline {
        if cancel.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        match sock.recv_from(buf) {
            Ok((n, from)) if from == peer && n >= 4 => return Ok(Some(n)),
            Ok(_) => continue,
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => break,
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => return Err("TFTP 서버가 응답하지 않습니다 (UDP 포트가 닫혀 있음)".into()),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(None)
}

/// Send `packet` to `to` and wait for a reply from the server, sending again
/// on timeout. The first reply fixes the server's transfer port (`peer`).
fn exchange(sock: &UdpSocket, packet: &[u8], to: SocketAddr, peer: &mut Option<SocketAddr>, cancel: &AtomicBool, buf: &mut [u8]) -> Result<usize, String> {
    for _ in 0..=RETRIES {
        if cancel.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        sock.send_to(packet, to).map_err(|e| format!("보낼 수 없습니다: {e}"))?;
        let deadline = Instant::now() + TIMEOUT;
        while Instant::now() < deadline {
            match sock.recv_from(buf) {
                Ok((n, from)) => {
                    // Only the server (its address; its first port fixes the transfer).
                    if from.ip() != to.ip() || peer.is_some_and(|p| p != from) || n < 4 {
                        continue;
                    }
                    peer.get_or_insert(from);
                    return Ok(n);
                }
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => break,
                // ICMP port unreachable surfaces as ConnectionReset on Windows.
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => return Err("TFTP 서버가 응답하지 않습니다 (UDP 포트가 닫혀 있음)".into()),
                Err(e) => return Err(e.to_string()),
            }
        }
    }
    Err("TFTP 서버가 응답하지 않습니다".into())
}

fn get(
    sock: &UdpSocket,
    server: SocketAddr,
    remote: &str,
    local: &Path,
    wanted: u16,
    cancel: &AtomicBool,
    report: &mut dyn FnMut(u64, Option<u64>),
) -> Result<(u64, u16), String> {
    // A unique hidden name: two downloads to the same file do not share it,
    // and a user's own "x.bin.bxpart" is never touched.
    let part = crate::remote::partial_path(local);
    let mut out = File::create(&part).map_err(|e| format!("{} 를 만들 수 없습니다: {e}", part.display()))?;
    let res = (|| {
        let mut buf = vec![0u8; 65536 + 4];
        let mut peer = None;
        let mut block_size = 512u16;
        let mut total = None;
        let mut n = exchange(sock, &request(RRQ, remote, wanted, Some(0)), server, &mut peer, cancel, &mut buf)?;
        let mut expect: u16 = 1;
        let mut done = 0u64;
        loop {
            let op = u16::from_be_bytes([buf[0], buf[1]]);
            match op {
                OACK => {
                    let o = options(&buf[2..n]);
                    block_size = negotiated_blksize(&o, wanted)?;
                    total = o.get("tsize").and_then(|v| v.parse().ok());
                    n = exchange(sock, &ack(0), peer.unwrap(), &mut peer, cancel, &mut buf)?;
                }
                DATA => {
                    let block = u16::from_be_bytes([buf[2], buf[3]]);
                    let data = &buf[4..n];
                    if block != expect {
                        // A repeat of the previous block: our ACK was lost; send it again.
                        n = exchange(sock, &ack(expect.wrapping_sub(1)), peer.unwrap(), &mut peer, cancel, &mut buf)?;
                        continue;
                    }
                    out.write_all(data).map_err(|e| format!("쓰기 오류: {e}"))?;
                    done += data.len() as u64;
                    report(done, total);
                    if data.len() < usize::from(block_size) {
                        // Last block: acknowledge once, no reply expected.
                        let _ = sock.send_to(&ack(block), peer.unwrap());
                        return Ok((done, block_size));
                    }
                    expect = block.wrapping_add(1);
                    n = exchange(sock, &ack(block), peer.unwrap(), &mut peer, cancel, &mut buf)?;
                }
                ERROR => return Err(server_error(&buf[..n])),
                _ => return Err("TFTP 서버가 알 수 없는 응답을 보냈습니다".into()),
            }
        }
    })();
    drop(out);
    match res {
        Ok(r) => {
            std::fs::rename(&part, local).map_err(|e| {
                let _ = std::fs::remove_file(&part);
                format!("{} 로 저장할 수 없습니다: {e}", local.display())
            })?;
            Ok(r)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

fn put(
    sock: &UdpSocket,
    server: SocketAddr,
    remote: &str,
    local: &Path,
    wanted: u16,
    cancel: &AtomicBool,
    report: &mut dyn FnMut(u64, Option<u64>),
) -> Result<(u64, u16), String> {
    let mut file = File::open(local).map_err(|e| format!("{} 를 열 수 없습니다: {e}", local.display()))?;
    let total = file.metadata().map(|m| m.len()).ok();
    let mut buf = vec![0u8; 65536 + 4];
    let mut peer = None;
    let mut n = exchange(sock, &request(WRQ, remote, wanted, total), server, &mut peer, cancel, &mut buf)?;
    let block_size = match u16::from_be_bytes([buf[0], buf[1]]) {
        OACK => negotiated_blksize(&options(&buf[2..n]), wanted)?,
        ACK if u16::from_be_bytes([buf[2], buf[3]]) == 0 => 512,
        ERROR => return Err(server_error(&buf[..n])),
        _ => return Err("TFTP 서버가 알 수 없는 응답을 보냈습니다".into()),
    };
    let mut block: u16 = 0;
    let mut done = 0u64;
    let mut chunk = vec![0u8; usize::from(block_size)];
    loop {
        let mut filled = 0;
        while filled < chunk.len() {
            let r = file.read(&mut chunk[filled..]).map_err(|e| format!("읽기 오류: {e}"))?;
            if r == 0 {
                break;
            }
            filled += r;
        }
        block = block.wrapping_add(1);
        let mut packet = vec![0, DATA as u8];
        packet.extend_from_slice(&block.to_be_bytes());
        packet.extend_from_slice(&chunk[..filled]);
        // Until the server acknowledges this block. A stale ACK (a duplicate
        // of the previous one) is not a reason to send again: resending on it
        // would send every later block twice. Only a timeout resends.
        // The resend deadline is set when the block goes out: a server that
        // repeats its last ACK every second (tftpd-hpa waiting for a lost
        // block) must not keep pushing it back.
        n = exchange(sock, &packet, peer.unwrap(), &mut peer, cancel, &mut buf)?;
        let mut resend_at = Instant::now() + TIMEOUT;
        loop {
            match u16::from_be_bytes([buf[0], buf[1]]) {
                ACK if u16::from_be_bytes([buf[2], buf[3]]) == block => break,
                ACK => {
                    n = match listen(sock, peer.unwrap(), resend_at, cancel, &mut buf)? {
                        Some(n) => n,
                        None => {
                            let n = exchange(sock, &packet, peer.unwrap(), &mut peer, cancel, &mut buf)?;
                            resend_at = Instant::now() + TIMEOUT;
                            n
                        }
                    }
                }
                ERROR => return Err(server_error(&buf[..n])),
                _ => return Err("TFTP 서버가 알 수 없는 응답을 보냈습니다".into()),
            }
        }
        done += filled as u64;
        report(done, total);
        if filled < chunk.len() {
            return Ok((done, block_size));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_block_sizes_outside_the_rfc_or_above_the_request() {
        let oack = |v: &str| HashMap::from([("blksize".to_string(), v.to_string())]);
        assert_eq!(negotiated_blksize(&HashMap::new(), 1428), Ok(512));
        assert_eq!(negotiated_blksize(&oack("1428"), 1428), Ok(1428));
        assert_eq!(negotiated_blksize(&oack("1024"), 1428), Ok(1024));
        assert_eq!(negotiated_blksize(&oack("8"), 1428), Ok(8));
        for bad in ["0", "7", "1429", "65465", "-1", "x", ""] {
            assert!(negotiated_blksize(&oack(bad), 1428).is_err(), "{bad}");
        }
        assert!(negotiated_blksize(&oack("65465"), 65464).is_err());
    }

    /// Block 3 is lost once; meanwhile the server repeats its last ACK every
    /// second (as tftpd-hpa does). The client must still resend block 3 when
    /// its own timeout runs out, and the upload completes.
    #[test]
    fn a_lost_block_is_resent_despite_repeated_stale_acks() {
        let server = UdpSocket::bind("127.0.0.1:0").unwrap();
        let addr = server.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let mut buf = [0u8; 2048];
            let (_, client) = server.recv_from(&mut buf).unwrap();
            let xfer = UdpSocket::bind("127.0.0.1:0").unwrap();
            xfer.set_read_timeout(Some(Duration::from_millis(1000))).unwrap();
            xfer.send_to(&ack(0), client).unwrap();
            let (mut last, mut dropped) = (0u16, false);
            loop {
                match xfer.recv_from(&mut buf) {
                    Ok((n, from)) => {
                        let block = u16::from_be_bytes([buf[2], buf[3]]);
                        if block == 3 && !dropped {
                            dropped = true;
                            continue;
                        }
                        last = block;
                        xfer.send_to(&ack(block), from).unwrap();
                        if n - 4 < 512 {
                            return dropped;
                        }
                    }
                    // Waiting for block 3: repeat the last ACK.
                    Err(_) => {
                        xfer.send_to(&ack(last), client).unwrap();
                    }
                }
            }
        });
        let dir = std::env::temp_dir().join(format!("bx-tftp-lost-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("image.bin");
        std::fs::write(&file, vec![9u8; 512 * 4 + 10]).unwrap();
        let sock = UdpSocket::bind("127.0.0.1:0").unwrap();
        sock.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        let cancel = AtomicBool::new(false);
        let t = Instant::now();
        let (sent, _) = put(&sock, addr, "image.bin", &file, 512, &cancel, &mut |_, _| {}).unwrap();
        assert_eq!(sent, 512 * 4 + 10);
        assert!(worker.join().unwrap(), "the server dropped block 3 once");
        assert!(t.elapsed() < TIMEOUT * 3, "{:?}", t.elapsed());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A server that answers every DATA block with two identical ACKs: the
    /// duplicate must not make the client send blocks twice.
    #[test]
    fn a_duplicated_ack_does_not_double_the_upload() {
        let server = UdpSocket::bind("127.0.0.1:0").unwrap();
        let addr = server.local_addr().unwrap();
        let counts = std::thread::spawn(move || {
            let mut buf = [0u8; 2048];
            let (_, client) = server.recv_from(&mut buf).unwrap();
            let xfer = UdpSocket::bind("127.0.0.1:0").unwrap();
            xfer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            xfer.send_to(&ack(0), client).unwrap();
            let mut per_block = std::collections::BTreeMap::<u16, u32>::new();
            while let Ok((n, from)) = xfer.recv_from(&mut buf) {
                let block = u16::from_be_bytes([buf[2], buf[3]]);
                *per_block.entry(block).or_default() += 1;
                xfer.send_to(&ack(block), from).unwrap();
                xfer.send_to(&ack(block), from).unwrap();
                if n - 4 < 512 {
                    break;
                }
            }
            per_block
        });
        let dir = std::env::temp_dir().join(format!("bx-tftp-dup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("image.bin");
        std::fs::write(&file, vec![7u8; 512 * 5 + 100]).unwrap();
        let sock = UdpSocket::bind("127.0.0.1:0").unwrap();
        sock.set_read_timeout(Some(TIMEOUT)).unwrap();
        let cancel = AtomicBool::new(false);
        let (sent, _) = put(&sock, addr, "image.bin", &file, 512, &cancel, &mut |_, _| {}).unwrap();
        assert_eq!(sent, 512 * 5 + 100);
        let per_block = counts.join().unwrap();
        assert_eq!(per_block.len(), 6);
        assert!(per_block.values().all(|&c| c == 1), "{per_block:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Against the app's own TFTP server: upload and download round trips,
    /// with the block size negotiated, plain RFC 1350 (512), and 8-byte blocks
    /// so the block number rolls over past 65535.
    #[tokio::test(flavor = "multi_thread")]
    async fn round_trips_against_the_builtin_server() {
        let root = std::env::temp_dir().join(format!("bx-tftpc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let port = {
            let s = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
            s.local_addr().unwrap().port()
        };
        let server = crate::fileservers::test_start(crate::fileservers::FileServerConfig {
            kind: "tftp".into(),
            root: root.to_string_lossy().into_owned(),
            port,
            lan: false,
            read_only: false,
            username: String::new(),
            password: String::new(),
        })
        .await;
        let local = root.join("local");
        std::fs::create_dir_all(&local).unwrap();
        let data: Vec<u8> = (0..600_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(local.join("image.bin"), &data).unwrap();

        let run = |direction: &str, remote: &str, file: &str, block: u16| {
            let req = TftpRequest {
                id: "t".into(),
                host: "127.0.0.1".into(),
                port: Some(port),
                remote: remote.into(),
                local: local.join(file).to_string_lossy().into_owned(),
                direction: direction.into(),
                block_size: Some(block),
            };
            let mut calls = 0u32;
            let r = transfer(&req, &AtomicBool::new(false), &mut |_, _| calls += 1);
            (r, calls)
        };
        for (block, name) in [(1428u16, "negotiated"), (512, "plain"), (8, "rollover")] {
            let remote = format!("{name}.bin");
            let up = tokio::task::block_in_place(|| run("put", &remote, "image.bin", block));
            let up = up.0.unwrap_or_else(|e| panic!("put {name}: {e}"));
            assert_eq!(std::fs::read(root.join(&remote)).unwrap(), data, "uploaded {name}");
            let back = format!("{name}.back");
            let down = tokio::task::block_in_place(|| run("get", &remote, &back, block));
            let (down, calls) = (down.0.unwrap_or_else(|e| panic!("get {name}: {e}")), down.1);
            assert_eq!(std::fs::read(local.join(&back)).unwrap(), data, "downloaded {name}");
            assert_eq!((up.bytes, down.bytes, down.block_size), (600_000, 600_000, block.min(8192)));
            assert!(calls > 0);
        }
        // A missing file is the server's error, and no partial file is left.
        let (missing, _) = tokio::task::block_in_place(|| run("get", "nope.bin", "nope.bin", 1428));
        assert!(missing.as_ref().is_err_and(|e| e.contains("파일이 없습니다")), "{missing:?}");
        assert!(!local.join("nope.bin").exists() && !local.join("nope.bin.bxpart").exists());
        server.abort();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_closed_port_is_reported_quickly() {
        let port = std::net::UdpSocket::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let req = TftpRequest {
            id: "t".into(),
            host: "127.0.0.1".into(),
            port: Some(port),
            remote: "x".into(),
            local: std::env::temp_dir().join("bx-tftpc-none").to_string_lossy().into_owned(),
            direction: "get".into(),
            block_size: None,
        };
        let started = Instant::now();
        let r = transfer(&req, &AtomicBool::new(false), &mut |_, _| {});
        assert!(r.is_err() && started.elapsed() < Duration::from_secs(20), "{:?}", r.err());
    }
}
