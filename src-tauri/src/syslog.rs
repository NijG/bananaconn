// A syslog receiver (UDP): network devices send their log lines here while
// they are worked on ("logging host 10.0.0.5"). A message is read only for
// its <PRI> (facility and severity, RFC 3164 and 5424 alike); the rest is
// shown as it was sent. Messages go to the window in batches a few times a
// second, so a flood never sends the UI an event per datagram.

use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, State};
use tokio::net::UdpSocket;

/// Messages held for one batch at most (and their text, bytes); more in
/// that time are counted as dropped.
const BATCH_MAX: usize = 2000;
const BATCH_BYTES: usize = 512 * 1024;
/// The longest message kept (a syslog datagram is at most a few KB).
const TEXT_MAX: usize = 4096;
/// Lines waiting for the file at most: a share that stalls for a few seconds
/// (an SMB reconnect) holds them; more are counted as not saved.
const FILE_QUEUE: usize = 8192;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyslogStatus {
    port: u16,
    lan: bool,
    addresses: Vec<String>,
    /// The file every message is added to as it comes, if any.
    file: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SyslogMessage {
    /// When it arrived, ms since the epoch.
    at: u64,
    /// The sender's address.
    from: String,
    /// 0 (emergency) to 7 (debug), from the <PRI>; none without one.
    severity: Option<u8>,
    facility: Option<u8>,
    text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SyslogBatch {
    messages: Vec<SyslogMessage>,
    /// Messages beyond what one batch holds, not shown (still in the file).
    dropped: usize,
    /// Of those, err or worse (severity 0-3): alerts count them too.
    dropped_bad: usize,
    /// Messages the file did not get: its writing fell behind (a stalled share).
    unsaved: usize,
    /// Writing the file failed: why. It is written no more.
    file_error: Option<String>,
}

/// What the file's thread is given.
enum ToFile {
    Line(String),
    /// On disk now (the window shows what came, the file should hold it).
    Flush,
}

/// The file, written on a thread of its own: a slow disk or share never
/// holds the socket, where datagrams not read in time are lost for good.
struct FileOut {
    to: SyncSender<ToFile>,
    /// Why writing stopped, and how many lines it left unwritten (the one
    /// that failed, those still queued), set by the thread as it ends.
    error: Arc<Mutex<Option<(String, usize)>>>,
}

impl FileOut {
    /// The thread has ended (writing failed): why, and the lines it lost.
    fn error(&self) -> (String, usize) {
        let error = self.error.lock().unwrap_or_else(|p| p.into_inner()).clone();
        // Set before the thread lets go of its end; never told as nothing.
        let (why, lost) = error.unwrap_or_default();
        (if why.is_empty() { "write failed".into() } else { why }, lost)
    }
}

/// Start the file's thread. It writes until its sender is gone (the loop
/// ended), then puts the rest on disk; it ends early when a write fails.
fn file_writer(file: std::fs::File) -> std::io::Result<(FileOut, std::thread::JoinHandle<()>)> {
    use std::io::Write;
    let (to, from) = std::sync::mpsc::sync_channel(FILE_QUEUE);
    let error = Arc::new(Mutex::new(None));
    let failed = error.clone();
    let thread = std::thread::Builder::new().name("syslog-file".into()).spawn(move || {
        let mut w = std::io::BufWriter::new(file);
        let mut result = Ok(());
        // A line whose write failed is lost.
        let mut lost = 0;
        // Lines taken since the last flush that went through: held in the
        // buffer, they may never reach the disk when a later write fails.
        let mut unflushed = 0;
        while let Ok(item) = from.recv() {
            result = match item {
                ToFile::Line(line) => w.write_all(line.as_bytes()).map(|()| unflushed += 1).inspect_err(|_| lost += 1),
                ToFile::Flush => w.flush().map(|()| unflushed = 0),
            };
            if result.is_err() {
                break;
            }
        }
        if let Err(e) = result.and_then(|()| w.flush()) {
            // So are those in the buffer, and those still queued behind it.
            lost += unflushed + from.try_iter().filter(|item| matches!(item, ToFile::Line(_))).count();
            *failed.lock().unwrap_or_else(|p| p.into_inner()) = Some((e.to_string(), lost));
        }
        // Only now does the loop see this end gone, with the reason set.
        drop(from);
    })?;
    Ok((FileOut { to, error }, thread))
}

/// RFC 5424 severity keywords, written as devices print them.
const SEVERITY: [&str; 8] = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"];

/// A message as one line of the file: local time, sender, severity, the
/// message (its own line breaks made blanks), tab-separated.
fn file_line(m: &SyslogMessage) -> String {
    use chrono::TimeZone;
    let at = chrono::Local.timestamp_millis_opt(m.at as i64).single().map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string()).unwrap_or_default();
    let sev = m.severity.map_or("-", |s| SEVERITY[s as usize]);
    format!("{at}\t{}\t{sev}\t{}\r\n", m.from, m.text.replace(['\r', '\n'], " "))
}

struct Running {
    /// Which start this is: a loop that ends by itself clears only its own.
    id: u64,
    status: SyslogStatus,
    task: JoinHandle<()>,
    /// The file's thread, if saving.
    writer: Option<std::thread::JoinHandle<()>>,
}

static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[derive(Default)]
pub struct SyslogState {
    running: Mutex<Option<Running>>,
    /// File threads of stopped receivers still putting their last lines on
    /// disk (a stalled share): waited for before the app exits and before a
    /// new start opens a file (two writers would mix their lines' order).
    draining: Mutex<Vec<std::thread::JoinHandle<()>>>,
}

impl SyslogState {
    /// A receiver's end: its file thread finishes on its own, kept to be waited for.
    fn retire(&self, r: Running) {
        if let Some(writer) = r.writer {
            self.draining.lock().unwrap_or_else(|p| p.into_inner()).push(writer);
        }
    }

    /// File threads still writing (those that ended are let go).
    fn still_draining(&self) -> bool {
        let mut draining = self.draining.lock().unwrap_or_else(|p| p.into_inner());
        draining.retain(|w| !w.is_finished());
        !draining.is_empty()
    }
}

/// A datagram's <PRI> (0-191) and the text after it; none when it has none.
fn parse(data: &[u8]) -> (Option<u8>, &[u8]) {
    if data.first() == Some(&b'<')
        && let Some(end) = data.iter().take(5).position(|&b| b == b'>')
        && (2..=4).contains(&end)
        && data[1..end].iter().all(u8::is_ascii_digit)
        && let Ok(pri) = std::str::from_utf8(&data[1..end]).unwrap_or("").parse::<u16>()
        && pri <= 191
    {
        return (Some(pri as u8), &data[end + 1..]);
    }
    (None, data)
}

fn message(data: &[u8], from: std::net::SocketAddr, at: u64) -> SyslogMessage {
    let (pri, rest) = parse(data);
    let mut text = String::from_utf8_lossy(rest).trim_end_matches(['\0', '\r', '\n', ' ']).to_string();
    if text.len() > TEXT_MAX {
        let mut cut = TEXT_MAX;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
    }
    SyslogMessage { at, from: from.ip().to_string(), severity: pri.map(|p| p % 8), facility: pri.map(|p| p / 8), text }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Start receiving on `port` (all interfaces with `lan`, else this PC only),
/// every message also added to `file` as it comes when one is given.
#[tauri::command]
pub async fn syslog_start(app: AppHandle, state: State<'_, SyslogState>, port: u16, lan: bool, file: Option<String>) -> Result<SyslogStatus, String> {
    if state.running.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
        return Err("Syslog 수신이 이미 실행 중입니다".into());
    }
    if port == 0 {
        return Err("포트 번호가 올바르지 않습니다".into());
    }
    let file = file.map(|f| f.trim().to_string()).filter(|f| !f.is_empty());
    // A stopped receiver's file thread still writing (a share that stalled):
    // its lines go first, a few seconds at most.
    if file.is_some() {
        let until = Instant::now() + Duration::from_secs(3);
        while state.still_draining() && Instant::now() < until {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    // Opened (added to, never emptied) before anything is bound: a path that
    // cannot be written is told now, not after messages were lost.
    let out = match &file {
        Some(path) => Some(std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| format!("로그 파일을 열 수 없습니다: {e}"))?),
        None => None,
    };
    let in_use = |e: std::io::Error| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!("포트 {port}을(를) 이미 다른 프로그램이 사용 중입니다")
        } else {
            format!("포트 {port}을(를) 열 수 없습니다: {e}")
        }
    };
    // Windows lets 0.0.0.0:p bind while 127.0.0.1:p is taken; probe loopback too.
    if lan {
        std::net::UdpSocket::bind(("127.0.0.1", port)).map_err(in_use)?;
    }
    let sock = UdpSocket::bind(crate::fileservers::bind_addr(lan, port)).await.map_err(in_use)?;
    let (out, writer) = match out {
        Some(f) => file_writer(f).map(|(out, thread)| (Some(out), Some(thread))).map_err(|e| format!("로그 파일을 열 수 없습니다: {e}"))?,
        None => (None, None),
    };
    let status = SyslogStatus { port, lan, addresses: crate::fileservers::addresses("udp", port, lan), file };
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // Registered before the loop runs, so a loop ending at once finds itself.
    let mut running = state.running.lock().unwrap_or_else(|p| p.into_inner());
    // Another start won the race meanwhile: this one ends.
    if running.is_some() {
        return Err("Syslog 수신이 이미 실행 중입니다".into());
    }
    let task = tauri::async_runtime::spawn(receive(sock, out, app, id));
    *running = Some(Running { id, status: status.clone(), task, writer });
    Ok(status)
}

/// The receive loop of start `id`, its batches to the window; ended by
/// itself (the window gone), it is no longer shown as running.
async fn receive(sock: UdpSocket, out: Option<FileOut>, app: AppHandle, id: u64) {
    use tauri::Manager;
    let ours = |f: &mut dyn FnMut(&mut Option<Running>)| {
        let state = app.state::<SyslogState>();
        let mut running = state.running.lock().unwrap_or_else(|p| p.into_inner());
        // Only this start's entry (a stop and a new start may have come since).
        if running.as_ref().is_some_and(|r| r.id == id) {
            f(&mut running);
        }
    };
    batches(sock, Duration::from_millis(200), out, |batch| {
        // Saving stopped: a page loaded from now on must not show it saving.
        if batch.file_error.is_some() {
            ours(&mut |r| {
                if let Some(r) = r.as_mut() {
                    r.status.file = None;
                }
            });
        }
        app.emit("syslog-batch", batch).is_ok()
    })
    .await;
    ours(&mut |r| {
        if let Some(r) = r.take() {
            app.state::<SyslogState>().retire(r);
        }
    });
}

/// Datagrams in, each added to `file` (all of them, also those a batch has
/// no room for), a batch to `emit` every `every` when there is one; ends
/// when `emit` says nobody listens. A file that cannot be written any more
/// is told once (in the next batch) and let go.
async fn batches(sock: UdpSocket, every: Duration, mut file: Option<FileOut>, mut emit: impl FnMut(SyslogBatch) -> bool) {
    let mut file_error: Option<String> = None;
    let mut unsaved = 0usize;
    let mut buf = vec![0u8; 65536];
    let mut batch: Vec<SyslogMessage> = Vec::new();
    let mut bytes = 0usize;
    let mut dropped = 0usize;
    let mut dropped_bad = 0usize;
    // The first batch a whole interval on too (`interval` would tick at once).
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
    loop {
        tokio::select! {
            got = sock.recv_from(&mut buf) => match got {
                Ok((n, from)) => {
                    let m = message(&buf[..n], from, now_ms());
                    if let Some(f) = &file {
                        match f.to.try_send(ToFile::Line(file_line(&m))) {
                            Ok(()) => {}
                            // The thread is behind: the socket is never held for it.
                            Err(TrySendError::Full(_)) => unsaved += 1,
                            Err(TrySendError::Disconnected(_)) => {
                                // This line too did not reach the file.
                                let (why, lost) = f.error();
                                file_error = Some(why);
                                unsaved += lost + 1;
                                file = None;
                            }
                        }
                    }
                    if batch.len() < BATCH_MAX && bytes < BATCH_BYTES {
                        bytes += m.text.len();
                        batch.push(m);
                    } else {
                        dropped += 1;
                        dropped_bad += usize::from(m.severity.is_some_and(|s| s <= 3));
                    }
                }
                // A datagram that could not be read (an ICMP error on
                // Windows, a truncated one): the next one goes on.
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            },
            _ = tick.tick() => {
                // On disk a few times a second, as the window sees it (behind
                // a full queue it flushes as it writes anyway).
                if let Some(f) = &file
                    && let Err(TrySendError::Disconnected(_)) = f.to.try_send(ToFile::Flush)
                {
                    let (why, lost) = f.error();
                    file_error = Some(why);
                    unsaved += lost;
                    file = None;
                }
                if batch.is_empty() && dropped == 0 && unsaved == 0 && file_error.is_none() {
                    continue;
                }
                let out = SyslogBatch {
                    messages: std::mem::take(&mut batch),
                    dropped: std::mem::take(&mut dropped),
                    dropped_bad: std::mem::take(&mut dropped_bad),
                    unsaved: std::mem::take(&mut unsaved),
                    file_error: file_error.take(),
                };
                bytes = 0;
                if !emit(out) {
                    return;
                }
            }
        }
    }
}

#[tauri::command]
pub fn syslog_stop(state: State<SyslogState>) {
    // The loop's end lets the file's thread put the rest on disk and end.
    let running = state.running.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(r) = running {
        r.task.abort();
        state.retire(r);
    }
}

/// The app is closing (its runtime does not drop tasks on the way out):
/// the loop ends and every file gets what it was given, a few seconds at most.
pub fn end_on_exit(state: &SyslogState) {
    let running = state.running.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(mut r) = running {
        r.task.abort();
        // Gone with the loop: the file's sender, which ends the thread's writing.
        let _ = tauri::async_runtime::block_on(&mut r.task);
        state.retire(r);
    }
    let until = Instant::now() + Duration::from_secs(3);
    while state.still_draining() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[tauri::command]
pub fn syslog_status(state: State<SyslogState>) -> Option<SyslogStatus> {
    state.running.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|r| r.status.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pri_gives_facility_and_severity() {
        let from: std::net::SocketAddr = "10.0.0.2:514".parse().unwrap();
        // local7.notice (23*8+5): a Cisco "%LINK-3-UPDOWN" line.
        let m = message(b"<189>52: *Mar  1 00:01:02: %LINK-3-UPDOWN: Interface Gi0/1, changed state to down\n", from, 7);
        assert_eq!((m.facility, m.severity, m.from.as_str(), m.at), (Some(23), Some(5), "10.0.0.2", 7));
        assert_eq!(m.text, "52: *Mar  1 00:01:02: %LINK-3-UPDOWN: Interface Gi0/1, changed state to down");
        // RFC 5424 has its version after the PRI.
        let m = message(b"<34>1 2026-11-08T10:00:00Z host app - - - hello", from, 0);
        assert_eq!((m.facility, m.severity), (Some(4), Some(2)));
        assert_eq!(m.text, "1 2026-11-08T10:00:00Z host app - - - hello");
    }

    #[test]
    fn a_message_without_a_valid_pri_is_shown_whole() {
        let from: std::net::SocketAddr = "10.0.0.2:514".parse().unwrap();
        for raw in [&b"plain text"[..], b"<>x", b"<192>x", b"<1234>x", b"<a1>x", b"<12"] {
            let m = message(raw, from, 0);
            assert_eq!((m.severity, m.facility), (None, None), "{raw:?}");
            assert_eq!(m.text.as_bytes(), raw);
        }
    }

    #[test]
    fn a_long_message_is_cut_on_a_character_boundary() {
        let from: std::net::SocketAddr = "10.0.0.2:514".parse().unwrap();
        let raw = format!("<14>{}", "가".repeat(3000));
        let m = message(raw.as_bytes(), from, 0);
        assert!(m.text.len() <= TEXT_MAX && m.text.chars().all(|c| c == '가'));
    }

    /// Wait until `got` holds `n` batches (or two seconds have gone).
    async fn batches_of(got: &std::sync::Arc<Mutex<Vec<SyslogBatch>>>, n: usize) -> usize {
        for _ in 0..200 {
            if got.lock().unwrap().len() >= n {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        got.lock().unwrap().len()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_loop_sends_batches_and_ends_when_nobody_listens() {
        let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let to = sock.local_addr().unwrap();
        let got = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        // The second batch finds nobody listening.
        let task = tokio::spawn(batches(sock, Duration::from_millis(50), None, move |b| {
            let mut g = sink.lock().unwrap();
            g.push(b);
            g.len() < 2
        }));
        let send = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        for i in 0..5 {
            send.send_to(format!("<189>line {i}").as_bytes(), to).unwrap();
        }
        assert_eq!(batches_of(&got, 1).await, 1);
        {
            let g = got.lock().unwrap();
            let texts: Vec<&str> = g[0].messages.iter().map(|m| m.text.as_str()).collect();
            assert_eq!(texts, ["line 0", "line 1", "line 2", "line 3", "line 4"]);
            assert!(g[0].messages.iter().all(|m| m.severity == Some(5) && m.from == "127.0.0.1"));
            assert_eq!(g[0].dropped, 0);
        }
        send.send_to(b"<14>again", to).unwrap();
        tokio::time::timeout(Duration::from_secs(2), task).await.expect("the loop ends").unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_flood_beyond_a_batch_is_counted_not_kept() {
        let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let to = sock.local_addr().unwrap();
        let got = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let task = tokio::spawn(batches(sock, Duration::from_millis(1500), None, move |b| {
            sink.lock().unwrap().push(b);
            true
        }));
        let send = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let sent = BATCH_MAX + 100;
        for i in 0..sent {
            send.send_to(format!("<14>m{i}").as_bytes(), to).unwrap();
            // A pause now and then, so the system's own buffer never overflows.
            if i % 100 == 99 {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        assert!(batches_of(&got, 1).await >= 1);
        task.abort();
        let g = got.lock().unwrap();
        let kept: usize = g.iter().map(|b| b.messages.len()).sum();
        let dropped: usize = g.iter().map(|b| b.dropped).sum();
        // One batch holds BATCH_MAX at most; the rest is counted, never lost silently.
        assert!(g[0].messages.len() <= BATCH_MAX);
        assert!(dropped >= 1, "kept {kept}, dropped {dropped}");
        assert!(kept + dropped <= sent);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_message_goes_to_the_file_also_those_a_batch_drops() {
        let dir = std::env::temp_dir().join(format!("bx-syslog-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("syslog.log");
        // Added to what is there, never emptied.
        std::fs::write(&path, "earlier\r\n").unwrap();
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).unwrap();
        let (out, writer) = file_writer(file).unwrap();
        let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let to = sock.local_addr().unwrap();
        let got = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let task = tokio::spawn(batches(sock, Duration::from_millis(300), Some(out), move |b| {
            sink.lock().unwrap().push(b);
            true
        }));
        let send = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let sent = BATCH_MAX + 50;
        for i in 0..sent {
            send.send_to(format!("<189>line {i}\nsecond part").as_bytes(), to).unwrap();
            if i % 100 == 99 {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        assert!(batches_of(&got, 1).await >= 1);
        tokio::time::sleep(Duration::from_millis(400)).await;
        task.abort();
        let _ = task.await;
        // The loop gone, its thread puts the rest on disk and ends.
        writer.join().unwrap();
        assert!(got.lock().unwrap().iter().all(|b| b.unsaved == 0 && b.file_error.is_none()));
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.split("\r\n").filter(|l| !l.is_empty()).collect();
        let dropped: usize = got.lock().unwrap().iter().map(|b| b.dropped).sum();
        assert!(dropped >= 1, "the batch dropped some");
        assert_eq!(lines[0], "earlier");
        // Every datagram the socket gave is in the file (the system may drop
        // some of its own under such a burst, so at least what was kept and dropped).
        let kept: usize = got.lock().unwrap().iter().map(|b| b.messages.len()).sum();
        assert_eq!(lines.len() - 1, kept + dropped);
        let first: Vec<&str> = lines[1].split('\t').collect();
        assert_eq!(first.len(), 4);
        assert_eq!((first[1], first[2], first[3]), ("127.0.0.1", "notice", "line 0 second part"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stalled_file_never_holds_the_socket() {
        // The file's thread writes nothing (a share stalled): its queue of
        // one fills, every message still reaches the window, the rest is
        // counted as not saved.
        let (to_file, _stalled) = std::sync::mpsc::sync_channel(1);
        let out = FileOut { to: to_file, error: Arc::new(Mutex::new(None)) };
        let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let to = sock.local_addr().unwrap();
        let got = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let task = tokio::spawn(batches(sock, Duration::from_millis(100), Some(out), move |b| {
            sink.lock().unwrap().push(b);
            true
        }));
        let send = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        for i in 0..50 {
            send.send_to(format!("<14>m{i}").as_bytes(), to).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        task.abort();
        {
            let g = got.lock().unwrap();
            let kept: usize = g.iter().map(|b| b.messages.len()).sum();
            let unsaved: usize = g.iter().map(|b| b.unsaved).sum();
            assert_eq!((kept, unsaved), (50, 49));
        }

        // The thread ended on a failed write: told once, then let go.
        let (to_file, ended) = std::sync::mpsc::sync_channel(4);
        drop(ended);
        let out = FileOut { to: to_file, error: Arc::new(Mutex::new(Some(("disk full".into(), 2)))) };
        let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let to = sock.local_addr().unwrap();
        let got = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let task = tokio::spawn(batches(sock, Duration::from_millis(100), Some(out), move |b| {
            sink.lock().unwrap().push(b);
            true
        }));
        for i in 0..3 {
            send.send_to(format!("<14>m{i}").as_bytes(), to).unwrap();
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        task.abort();
        let g = got.lock().unwrap();
        let errors: Vec<_> = g.iter().filter_map(|b| b.file_error.clone()).collect();
        assert_eq!(errors, ["disk full"]);
        // The two the thread had left, and the one that met its closed end.
        assert_eq!(g.iter().map(|b| b.unsaved).sum::<usize>(), 3);
        assert_eq!(g.iter().map(|b| b.messages.len()).sum::<usize>(), 3);
    }

    #[test]
    fn datagrams_arrive_as_messages() {
        // The loop itself needs an AppHandle; a datagram's way in is checked here.
        let sock = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        sock.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let to = sock.local_addr().unwrap();
        let send = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        send.send_to(b"<30>dhcpd: lease 10.0.0.9", to).unwrap();
        let mut buf = [0u8; 2048];
        let (n, from) = sock.recv_from(&mut buf).unwrap();
        let m = message(&buf[..n], from, 1);
        assert_eq!((m.facility, m.severity, m.text.as_str(), m.from.as_str()), (Some(3), Some(6), "dhcpd: lease 10.0.0.9", "127.0.0.1"));
    }
}
