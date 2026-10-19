// Terminal sessions. SSH runs the system OpenSSH client inside a ConPTY; Telnet
// is a direct TCP connection speaking the protocol in telnet.rs. Both feed the
// same output path, which handles per-tab logging, credential auto-fill and
// delivery to the frontend.
//
// Auto-fill keeps secrets in the backend: the frontend never receives a stored
// password. A rule fires only on a matching prompt, a limited number of times,
// within a short window after connecting.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};

use crate::telnet;
use crate::termout::OutPump;
use crate::vault;

const AUTOFILL_WINDOW: Duration = Duration::from_secs(45);

#[derive(Default)]
pub struct TermState {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

enum Backend {
    Pty {
        /// Dropped as soon as the session ends: closing the pseudoconsole is
        /// what lets the reader thread reach end-of-file on Windows.
        master: Mutex<Option<Box<dyn MasterPty + Send>>>,
        killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    },
    Telnet {
        /// Clone of the socket used only to shut it down (never locked).
        control: TcpStream,
        /// Set on close: the reader stops at its next poll even when the
        /// shutdown failed (Windows can refuse it with WSAENOTCONN), so every
        /// handle of the socket is dropped and the connection really ends.
        closed: Arc<std::sync::atomic::AtomicBool>,
        naws: Mutex<bool>,
        size: Mutex<(u16, u16)>,
    },
    /// COM port. Reader and writer poll with a short timeout and stop once
    /// `closed` is set; `control` is a clone used for the Break signal.
    /// Closing joins both threads and drops `control`, so every handle to the
    /// (exclusive) port is gone when term_close returns and a reconnect can
    /// open it again at once.
    Serial {
        control: Mutex<Option<Box<dyn serialport::SerialPort>>>,
        closed: Arc<std::sync::atomic::AtomicBool>,
        threads: Mutex<Vec<std::thread::JoinHandle<()>>>,
    },
}

struct AutofillRule {
    /// Lower-case texts; the prompt line must contain one of them.
    keywords: Vec<String>,
    reply: String,
    remaining: u8,
}

struct Session {
    backend: Backend,
    /// All writes go through a dedicated writer thread so a slow peer can never
    /// block the caller (Tauri runs sync commands on the UI thread).
    input: SyncSender<Vec<u8>>,
    log: Mutex<Option<crate::termlog::LogSink>>,
    ansi: Mutex<AnsiStripper>,
    autofill: Mutex<Vec<AutofillRule>>,
    tail: Mutex<String>,
    started: Instant,
    out: Arc<OutPump>,
}

/// Run blocking writes on their own thread; the session keeps the sender.
/// Writes queued for a session. Bounded: a peer that stops reading (while
/// e.g. a Telnet server keeps asking for replies) must not make the queue
/// grow until the app runs out of memory.
const WRITE_QUEUE: usize = 1024;

fn spawn_writer(mut sink: impl Write + Send + 'static) -> SyncSender<Vec<u8>> {
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(WRITE_QUEUE);
    std::thread::spawn(move || {
        for chunk in rx {
            if sink.write_all(&chunk).and_then(|_| sink.flush()).is_err() {
                break;
            }
        }
    });
    tx
}

impl Session {
    fn new(backend: Backend, input: SyncSender<Vec<u8>>, autofill: Vec<AutofillRule>, out: Arc<OutPump>) -> Self {
        Self {
            backend,
            input,
            log: Mutex::new(None),
            ansi: Mutex::new(AnsiStripper::default()),
            autofill: Mutex::new(autofill),
            tail: Mutex::new(String::new()),
            started: Instant::now(),
            out,
        }
    }

    /// Never blocks (callers include the UI thread): a full queue means the
    /// peer has stopped reading, and the data is refused.
    fn send_raw(&self, data: &[u8]) -> std::io::Result<()> {
        self.input.try_send(data.to_vec()).map_err(|e| match e {
            TrySendError::Full(_) => std::io::Error::new(std::io::ErrorKind::WouldBlock, "상대가 입력을 받지 않고 있습니다"),
            TrySendError::Disconnected(_) => std::io::Error::new(std::io::ErrorKind::BrokenPipe, "세션이 종료되었습니다"),
        })
    }

    fn send_input(&self, data: &[u8]) -> std::io::Result<()> {
        match &self.backend {
            Backend::Pty { .. } | Backend::Serial { .. } => self.send_raw(data),
            Backend::Telnet { .. } => self.send_raw(&telnet::encode_input(data)),
        }
    }

    /// Release the pseudoconsole (off the calling thread: closing it can wait
    /// for pending output to drain).
    fn release_pty(&self) {
        if let Backend::Pty { master, .. } = &self.backend
            && let Some(m) = master.lock().unwrap().take() {
                std::thread::spawn(move || drop(m));
            }
    }
    /// Common output path: log, auto-fill, then forward to the frontend.
    /// `idle`: the read did not fill the buffer, so nothing more is waiting
    /// (the log is flushed then, so its end is on disk while the session idles).
    fn deliver(&self, bytes: &[u8], idle: bool) {
        if bytes.is_empty() {
            return;
        }
        // The screen first: a log on a slow share must not delay the echo.
        self.out.push(bytes);
        if let Some(sink) = self.log.lock().unwrap().as_mut() {
            let clean = self.ansi.lock().unwrap().strip(bytes);
            sink.write(&clean, idle);
        }
        if let Some(reply) = self.match_prompt(bytes) {
            let mut data = reply.into_bytes();
            data.push(b'\r');
            let _ = self.send_input(&data);
        }
    }

    /// A message of our own (an error), written and flushed at once.
    fn deliver_line(&self, bytes: &[u8]) {
        self.deliver(bytes, true);
    }

    /// Write out and close the log (the app is exiting).
    fn end_log(&self) {
        let mut log = self.log.lock().unwrap();
        let rest = self.ansi.lock().unwrap().finish();
        if let Some(sink) = log.as_mut() {
            sink.write(&rest, true);
        }
        log.take();
    }

    fn match_prompt(&self, bytes: &[u8]) -> Option<String> {
        if self.started.elapsed() > AUTOFILL_WINDOW {
            return None;
        }
        let mut rules = self.autofill.lock().unwrap();
        if rules.iter().all(|r| r.remaining == 0) {
            return None;
        }
        let mut tail = self.tail.lock().unwrap();
        tail.push_str(&String::from_utf8_lossy(bytes).to_lowercase());
        if tail.len() > 512 {
            let cut = tail.len() - 512;
            let at = tail.char_indices().map(|(i, _)| i).find(|&i| i >= cut).unwrap_or(0);
            tail.drain(..at);
        }
        let trimmed = tail.trim_end();
        if !trimmed.ends_with(':') {
            return None;
        }
        let last_line = trimmed.rsplit(['\n', '\r']).next().unwrap_or("");
        for rule in rules.iter_mut() {
            if rule.remaining > 0 && rule.keywords.iter().any(|k| last_line.contains(k)) {
                rule.remaining -= 1;
                tail.clear();
                return Some(rule.reply.clone());
            }
        }
        None
    }
}

/// Turns terminal output into log text: removes escape sequences (CSI
/// ESC [ ..., string sequences OSC/DCS/APC/PM/SOS up to BEL or ESC \, ESC
/// with intermediate bytes such as ESC ( B), ends a line at CR LF or at a CR
/// alone (bootloaders, some consoles), applies Backspace to what was written
/// (line editing, "--More--" erased by the pager) and drops other control
/// bytes (the NUL of Telnet's CR NUL, BEL).
#[derive(Default)]
struct AnsiStripper {
    state: u8, // 0 text, 1 after ESC, 2 CSI, 3 string, 4 string after ESC, 5 ESC intermediates
    /// A CR was seen; a LF next makes it CR LF, anything else a lone CR.
    cr: bool,
    /// The line being written: kept until it ends (or grows past LINE_MAX),
    /// so Backspace can still erase what an earlier read wrote.
    line: Vec<u8>,
}

/// A "line" longer than this (binary output, no line breaks) goes out as is.
const LINE_MAX: usize = 64 * 1024;

impl AnsiStripper {
    fn strip(&mut self, input: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(input.len());
        for &b in input {
            if self.state == 0 && self.cr && b != b'\n' && b != b'\r' && b != 0 {
                self.end_line(&mut out);
            }
            if self.state == 0 && b != 0 {
                self.cr = false;
            }
            self.state = match (self.state, b) {
                (0, 0x1b) => 1,
                (0, b'\r') => {
                    self.cr = true;
                    0
                }
                (0, 0x08 | 0x7f) => {
                    // Erase one character of the current line (a whole UTF-8
                    // sequence), never across a line break.
                    while self.line.last().is_some_and(|&c| (0x80..0xc0).contains(&c)) {
                        self.line.pop();
                    }
                    self.line.pop();
                    0
                }
                (0, b'\n') => {
                    self.end_line(&mut out);
                    0
                }
                (0, b'\t') => {
                    self.line.push(b);
                    0
                }
                (0, 0x00..=0x1f) => 0,
                (0, _) => {
                    self.line.push(b);
                    0
                }
                (1, b'[') => 2,
                (1, b']' | b'P' | b'X' | b'^' | b'_') => 3,
                (1, 0x20..=0x2f) => 5,
                (1, _) => 0,
                (2, 0x40..=0x7e) => 0,
                (2, _) => 2,
                (3, 0x07) => 0,
                (3, 0x1b) => 4,
                (3, _) => 3,
                (4, b'\\') => 0,
                (4, _) => 3,
                (5, 0x20..=0x2f) => 5,
                (5, _) => 0,
                _ => 0,
            };
        }
        if self.line.len() > LINE_MAX {
            out.append(&mut self.line);
        }
        out
    }

    fn end_line(&mut self, out: &mut Vec<u8>) {
        out.append(&mut self.line);
        out.push(b'\n');
    }

    /// The line not ended yet (a prompt): written when the log stops.
    fn finish(&mut self) -> Vec<u8> {
        self.cr = false;
        std::mem::take(&mut self.line)
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub id: String,
    /// "ssh" or "telnet"
    pub protocol: String,
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub credential_id: Option<String>,
    #[serde(default)]
    pub keepalive: Option<u32>,
    /// SSH: bastion host(s) for -J, e.g. "user@bastion:22" (comma separated hops).
    #[serde(default)]
    pub jump_host: String,
    /// SSH: port forwards, one per line: "L 8080:localhost:80", "R 9000:localhost:3000", "D 1080".
    #[serde(default)]
    pub forwards: String,
    #[serde(default)]
    pub compression: bool,
    #[serde(default)]
    pub agent_forward: bool,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default = "default_cols")]
    pub cols: u16,
    /// Serial: line settings (the COM port name is in `host`).
    #[serde(default)]
    pub serial: Option<SerialSettings>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SerialSettings {
    pub baud: u32,
    #[serde(default = "eight")]
    pub data_bits: u8,
    /// "none", "odd" or "even"
    #[serde(default)]
    pub parity: String,
    #[serde(default = "one")]
    pub stop_bits: u8,
    /// "none", "hardware" (RTS/CTS) or "software" (XON/XOFF)
    #[serde(default)]
    pub flow: String,
}

fn eight() -> u8 {
    8
}
fn one() -> u8 {
    1
}

fn default_rows() -> u16 {
    24
}
fn default_cols() -> u16 {
    80
}

/// Open an SSH or Telnet terminal session.
#[tauri::command]
pub async fn term_open(
    app: AppHandle,
    state: State<'_, TermState>,
    req: OpenRequest,
    output: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let cred = match req.credential_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => Some(vault::resolve(&app, id)?),
        None => None,
    };
    let out = OutPump::start(output);
    let pump = out.clone();
    let opened = match req.protocol.as_str() {
        // Starting ssh.exe (and "ssh -G" before it) blocks: not on a runtime thread.
        "ssh" => {
            let req2 = req.clone();
            tauri::async_runtime::spawn_blocking(move || open_ssh(&req2, cred, out))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r)
        }
        "telnet" => {
                        let host = req.host.clone();
            let port = req.port.unwrap_or(23);
            let (rows, cols) = (req.rows, req.cols);
            let username = req.username.clone();
            tauri::async_runtime::spawn_blocking(move || open_telnet(&host, port, &username, cred, rows, cols, out))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r)
        }
        "serial" => {
            let req2 = req.clone_serial();
            tauri::async_runtime::spawn_blocking(move || open_serial(&req2.1, &req2.2, out))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r)
        }
        other => Err(format!("지원하지 않는 터미널 프로토콜입니다: {other}")),
    };
    let session = match opened {
        Ok(session) => session,
        Err(e) => {
            pump.close();
            return Err(e);
        }
    };
    state.sessions.lock().unwrap().insert(req.id.clone(), session);
    Ok(())
}

impl OpenRequest {
    /// (id, port name, settings) for the serial opener thread.
    fn clone_serial(&self) -> (String, String, Option<SerialSettings>) {
        (self.id.clone(), self.host.clone(), self.serial.clone())
    }
}

/// A COM port name as Windows uses it: COM1..COM256 (case-insensitive).
fn valid_com_name(name: &str) -> bool {
    let upper = name.trim().to_ascii_uppercase();
    upper.strip_prefix("COM").and_then(|n| n.parse::<u16>().ok()).is_some_and(|n| (1..=256).contains(&n))
}

fn open_serial(port_name: &str, settings: &Option<SerialSettings>, out: Arc<OutPump>) -> Result<Arc<Session>, String> {
    use serialport::{DataBits, FlowControl, Parity, StopBits};
    let name = port_name.trim().to_ascii_uppercase();
    if !valid_com_name(&name) {
        return Err(format!("COM 포트 이름이 올바르지 않습니다: {port_name} (예: COM3)"));
    }
    let s = settings.clone().unwrap_or(SerialSettings { baud: 9600, data_bits: 8, parity: String::new(), stop_bits: 1, flow: String::new() });
    if !(50..=4_000_000).contains(&s.baud) {
        return Err(format!("통신 속도가 올바르지 않습니다: {}", s.baud));
    }
    let data_bits = match s.data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    };
    let parity = match s.parity.as_str() {
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => Parity::None,
    };
    let stop_bits = if s.stop_bits == 2 { StopBits::Two } else { StopBits::One };
    let flow = match s.flow.as_str() {
        "hardware" => FlowControl::Hardware,
        "software" => FlowControl::Software,
        _ => FlowControl::None,
    };
    // Windows needs the \\.\ prefix for COM10 and above.
    let path = format!(r"\\.\{name}");
    let port = serialport::new(&path, s.baud)
        .data_bits(data_bits)
        .parity(parity)
        .stop_bits(stop_bits)
        .flow_control(flow)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| match e.kind() {
            serialport::ErrorKind::NoDevice | serialport::ErrorKind::Io(std::io::ErrorKind::NotFound) => format!("{name} 포트를 찾을 수 없습니다. 케이블 연결과 포트 번호를 확인하세요."),
            serialport::ErrorKind::Io(std::io::ErrorKind::PermissionDenied) => {
                format!("{name} 포트를 다른 프로그램이 쓰고 있습니다. 그 프로그램을 닫은 다음 다시 연결하세요.")
            }
            _ => format!("{name} 포트를 열 수 없습니다: {e}"),
        })?;
    let mut reader = port.try_clone().map_err(|e| format!("{name} 포트를 열 수 없습니다: {e}"))?;
    let control = port.try_clone().map_err(|e| format!("{name} 포트를 열 수 없습니다: {e}"))?;
    let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (input, writer) = spawn_serial_writer(port, closed.clone());
    let session = Arc::new(Session::new(
        Backend::Serial { control: Mutex::new(Some(control)), closed: closed.clone(), threads: Mutex::new(vec![writer]) },
        input,
        Vec::new(),
        out,
    ));

    let rs = session.clone();
    let reader_thread = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut code = 0;
        while !closed.load(std::sync::atomic::Ordering::Relaxed) {
            match reader.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => rs.deliver(&buf[..n], n < buf.len()),
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                // Unplugged USB adapter, driver error: the session ends.
                Err(e) => {
                    rs.deliver_line(format!("\r\n[{e}]\r\n").as_bytes());
                    code = 1;
                    // The writer polls this flag: it lets go of the port too.
                    closed.store(true, std::sync::atomic::Ordering::Relaxed);
                    break;
                }
            }
        }
        rs.out.finish(code);
    });
    if let Backend::Serial { threads, .. } = &session.backend {
        threads.lock().unwrap().push(reader_thread);
    }
    Ok(session)
}

/// Serial writer: a device pausing us (XOFF, CTS low) makes writes time out
/// after 100 ms; that is a pause, not an error, so the write is retried until
/// it completes or the session is closed. No flush: FlushFileBuffers would wait
/// for the device without a timeout.
fn spawn_serial_writer(
    mut port: Box<dyn serialport::SerialPort>,
    closed: Arc<std::sync::atomic::AtomicBool>,
) -> (SyncSender<Vec<u8>>, std::thread::JoinHandle<()>) {
    use std::sync::atomic::Ordering;
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(WRITE_QUEUE);
    let handle = std::thread::spawn(move || {
        while !closed.load(Ordering::Relaxed) {
            let chunk = match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(c) => c,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let mut rest = &chunk[..];
            while !rest.is_empty() && !closed.load(Ordering::Relaxed) {
                match port.write(rest) {
                    Ok(0) => std::thread::sleep(Duration::from_millis(10)),
                    Ok(n) => rest = &rest[n..],
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted) => {}
                    // The port is gone (USB adapter unplugged): end the
                    // session rather than drop every later keystroke.
                    Err(_) => {
                        closed.store(true, Ordering::Relaxed);
                        return;
                    }
                }
            }
        }
    });
    (tx, handle)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    name: String,
    /// e.g. "USB Serial Port (Prolific)" — what to show next to the name.
    description: String,
}

/// COM ports present on this PC, sorted by number.
#[tauri::command]
pub async fn serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut ports: Vec<SerialPortInfo> = serialport::available_ports()
            .map_err(|e| format!("COM 포트 목록을 읽을 수 없습니다: {e}"))?
            .into_iter()
            .filter(|p| valid_com_name(&p.port_name))
            .map(|p| {
                let description = match p.port_type {
                    serialport::SerialPortType::UsbPort(u) => {
                        [u.product, u.manufacturer].into_iter().flatten().collect::<Vec<_>>().join(" · ")
                    }
                    serialport::SerialPortType::BluetoothPort => "Bluetooth".into(),
                    serialport::SerialPortType::PciPort => "PCI".into(),
                    serialport::SerialPortType::Unknown => String::new(),
                };
                SerialPortInfo { name: p.port_name.to_ascii_uppercase(), description }
            })
            .collect();
        ports.sort_by_key(|p| p.name.trim_start_matches("COM").parse::<u16>().unwrap_or(0));
        ports.dedup_by(|a, b| a.name == b.name);
        Ok(ports)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Send a serial Break (e.g. Cisco ROMMON / password recovery).
#[tauri::command]
pub async fn term_break(state: State<'_, TermState>, id: String) -> Result<(), String> {
    let session = get(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || match &session.backend {
        Backend::Serial { control, .. } => {
            let guard = control.lock().unwrap();
            let port = guard.as_ref().ok_or("세션이 종료되었습니다")?;
            port.set_break().map_err(|e| format!("Break 신호를 보낼 수 없습니다: {e}"))?;
            std::thread::sleep(Duration::from_millis(500));
            port.clear_break().map_err(|e| format!("Break 신호를 끝낼 수 없습니다: {e}"))
        }
        _ => Err("Break 신호는 시리얼 연결에서만 보낼 수 있습니다".into()),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Values that reach ssh.exe as arguments. Anything starting with '-' would be
/// parsed as an option (e.g. `-oProxyCommand=...` runs a command), so every
/// user-, import- or file-supplied value is checked against a strict charset.
fn safe_token(value: &str, what: &str, extra: &str) -> Result<(), String> {
    let ok = !value.is_empty()
        && !value.starts_with('-')
        && value.chars().all(|c| c.is_ascii_alphanumeric() || "._-@:[]".contains(c) || extra.contains(c) || (!c.is_ascii() && !c.is_whitespace()));
    if ok { Ok(()) } else { Err(format!("{what} 값에 사용할 수 없는 문자가 있습니다: {value}")) }
}

/// Parse forward lines ("L spec" / "R spec" / "D spec") into ssh arguments.
fn forward_args(lines: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    for line in lines.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let (kind, spec) = line
            .split_once(char::is_whitespace)
            .ok_or_else(|| format!("포트 포워딩 형식이 올바르지 않습니다: {line}"))?;
        let flag = match kind.to_ascii_uppercase().as_str() {
            "L" => "-L",
            "R" => "-R",
            "D" => "-D",
            _ => return Err(format!("포트 포워딩 종류는 L, R, D 중 하나여야 합니다: {line}")),
        };
        let spec = spec.trim();
        safe_token(spec, "포트 포워딩", "*")?;
        args.push(flag.to_string());
        args.push(spec.to_string());
    }
    Ok(args)
}

/// User and host as OpenSSH will print them in its password prompt, from
/// `ssh -G` (which applies ~/.ssh/config). Falls back to the typed values.
fn ssh_prompt_target(host: &str, port: u16, username: &str) -> (String, String) {
    let cfg = ssh_config(host, port, username);
    (cfg.user.to_lowercase(), cfg.key_host.to_lowercase())
}

/// What ssh.exe will actually use for a destination, from `ssh -G` (which
/// applies ~/.ssh/config: Host aliases, HostName, User, Port, HostKeyAlias).
/// Falls back to the given values when ssh is unavailable.
pub(crate) struct SshConfig {
    pub user: String,
    /// Address to connect to.
    pub hostname: String,
    pub port: u16,
    /// Name the host key is recorded under (HostKeyAlias or hostname).
    pub key_host: String,
}

pub(crate) fn ssh_config(host: &str, port: u16, username: &str) -> SshConfig {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("ssh");
    cmd.args(["-G", "-p", &port.to_string()]);
    if !username.is_empty() {
        cmd.args(["-l", username]);
    }
    let out = cmd.arg("--").arg(host).creation_flags(0x0800_0000).output();
    let text = out.ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    let get = |key: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(key).and_then(|v| v.strip_prefix(' ')).map(str::trim).map(str::to_string))
            .filter(|v| !v.is_empty() && v != "none")
    };
    let hostname = get("hostname").unwrap_or_else(|| host.to_string());
    SshConfig {
        user: get("user").unwrap_or_else(|| username.to_string()),
        key_host: get("hostkeyalias").unwrap_or_else(|| hostname.clone()),
        port: get("port").and_then(|p| p.parse().ok()).unwrap_or(port),
        hostname,
    }
}

fn open_ssh(req: &OpenRequest, cred: Option<vault::Resolved>, out: Arc<OutPump>) -> Result<Arc<Session>, String> {
    safe_token(&req.host, "호스트", "")?;
    let forwards = forward_args(&req.forwards)?;
    if !req.jump_host.trim().is_empty() {
        safe_token(req.jump_host.trim(), "점프 호스트", ",")?;
    }
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: req.rows,
            cols: req.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("터미널을 열 수 없습니다: {e}"))?;

    let username = if req.username.is_empty() {
        cred.as_ref().map(|c| c.username.clone()).unwrap_or_default()
    } else {
        req.username.clone()
    };

    let mut cmd = CommandBuilder::new("ssh");
    cmd.env("TERM", "xterm-256color");
    cmd.args(["-p", &req.port.unwrap_or(22).to_string()]);
    cmd.args(["-o", &format!("ServerAliveInterval={}", req.keepalive.unwrap_or(30))]);
    let mut rules = Vec::new();
    if let Some(c) = &cred {
        if let Some(key) = &c.key_path {
            cmd.args(["-i", key, "-o", "IdentitiesOnly=yes"]);
            if let Some(p) = &c.passphrase {
                rules.push(AutofillRule {
                    // OpenSSH prints at most 100 characters of the path ('%.100s').
                    keywords: vec![format!("passphrase for key '{}", key.to_lowercase().chars().take(100).collect::<String>())],
                    reply: p.clone(),
                    remaining: 1,
                });
            }
        }
        if let Some(pw) = &c.password {
            // Only OpenSSH's own prompt for this exact target ("user@host's
            // password:" or keyboard-interactive "(user@host) Password:"): never
            // a jump host's prompt, sudo, or text a server prints later.
            // The prompt names the user and host OpenSSH resolved (ssh_config
            // HostName / User / HostKeyAlias), not what was typed.
            let (user, host) = ssh_prompt_target(&req.host, req.port.unwrap_or(22), &username);
            let target = format!("{user}@{host}");
            rules.push(AutofillRule {
                keywords: vec![format!("{target}'s password"), format!("({target}) password")],
                reply: pw.clone(),
                remaining: 1,
            });
            // Try the stored password first (so an agent key does not log in
            // first and leave the rule armed), but keep every other method for
            // servers that need a key or a second factor.
            if c.key_path.is_none() {
                cmd.args(["-o", "PreferredAuthentications=password,keyboard-interactive,publickey,gssapi-with-mic,hostbased"]);
            }
        }
    }
    if !req.jump_host.trim().is_empty() {
        cmd.args(["-J", req.jump_host.trim()]);
    }
    if req.compression {
        cmd.arg("-C");
    }
    if req.agent_forward {
        cmd.arg("-A");
    }
    if !forwards.is_empty() {
        // Keep the session alive if a forward's port is already taken.
        cmd.args(["-o", "ExitOnForwardFailure=no"]);
        cmd.args(&forwards);
    }
    if !username.is_empty() {
        safe_token(&username, "사용자 이름", "\\")?;
    }
    // End of options: nothing after this can be parsed as an ssh flag.
    cmd.arg("--");
    cmd.arg(if username.is_empty() {
        req.host.clone()
    } else {
        format!("{username}@{}", req.host)
    });

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("ssh를 시작할 수 없습니다 (OpenSSH 클라이언트 필요): {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    let session = Arc::new(Session::new(
        Backend::Pty {
            master: Mutex::new(Some(pair.master)),
            killer: Mutex::new(killer),
        },
        spawn_writer(writer),
        rules,
        out,
    ));

    // The exit code is known first; the reader reaches end-of-file once the
    // pseudoconsole is released after it, having delivered the last output.
    let exit_code = Arc::new(std::sync::atomic::AtomicI32::new(0));
    let (rs, rcode) = (session.clone(), exit_code.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            rs.deliver(&buf[..n], n < buf.len());
        }
        rs.out.finish(rcode.load(std::sync::atomic::Ordering::SeqCst));
    });
    let ws = session.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        exit_code.store(code as i32, std::sync::atomic::Ordering::SeqCst);
        ws.release_pty();
    });
    Ok(session)
}

#[allow(clippy::too_many_arguments)]
fn open_telnet(
    host: &str,
    port: u16,
    username: &str,
    cred: Option<vault::Resolved>,
    rows: u16,
    cols: u16,
    out: Arc<OutPump>,
) -> Result<Arc<Session>, String> {
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("호스트 주소를 찾을 수 없습니다: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err("호스트 주소를 찾을 수 없습니다".into());
    }
    // Try every address: "localhost" often resolves to ::1 first while the
    // server listens on IPv4 only.
    let mut last = None;
    let mut connected = None;
    for addr in &addrs {
        match TcpStream::connect_timeout(addr, Duration::from_secs(10)) {
            Ok(s) => {
                connected = Some(s);
                break;
            }
            Err(e) => last = Some(e),
        }
    }
    let stream = connected.ok_or_else(|| {
        format!("{host}:{port} 에 연결할 수 없습니다: {}", last.map(|e| e.to_string()).unwrap_or_default())
    })?;
    let _ = stream.set_nodelay(true);
    let mut reader = stream.try_clone().map_err(|e| e.to_string())?;
    let control = stream.try_clone().map_err(|e| e.to_string())?;

    let mut rules = Vec::new();
    let user = if username.is_empty() {
        cred.as_ref().map(|c| c.username.clone()).unwrap_or_default()
    } else {
        username.to_string()
    };
    if !user.is_empty() {
        rules.push(AutofillRule {
            keywords: ["login", "username", "user name"].map(String::from).to_vec(),
            reply: user,
            remaining: 1,
        });
    }
    if let Some(pw) = cred.and_then(|c| c.password) {
        rules.push(AutofillRule {
            keywords: vec!["password".into()],
            reply: pw,
            remaining: 1,
        });
    }

    let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop = closed.clone();
    // Short reads let the reader notice a close (see Backend::Telnet::closed).
    let _ = reader.set_read_timeout(Some(Duration::from_millis(500)));
    let session = Arc::new(Session::new(
        Backend::Telnet {
            control,
            closed,
            naws: Mutex::new(false),
            size: Mutex::new((cols, rows)),
        },
        spawn_writer(stream),
        rules,
        out,
    ));

    let rs = session.clone();
    std::thread::spawn(move || {
        let mut parser = telnet::Parser::new();
        let mut buf = [0u8; 16384];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                    if stop.load(std::sync::atomic::Ordering::Relaxed) {
                        break;
                    }
                    continue;
                }
                Err(_) => break,
            };
            let feed = parser.feed(&buf[..n]);
            if !feed.replies.is_empty() {
                let _ = rs.send_raw(&feed.replies);
            }
            if let Backend::Telnet { naws, size, .. } = &rs.backend {
                // The parser owns the negotiated state (a later DONT turns it off).
                *naws.lock().unwrap() = parser.naws;
                if feed.send_size {
                    let (c, r) = *size.lock().unwrap();
                    let _ = rs.send_raw(&telnet::naws(c, r));
                }
            }
            rs.deliver(&feed.data, n < buf.len());
        }
        rs.out.finish(0);
    });
    Ok(session)
}

fn get(state: &TermState, id: &str) -> Result<Arc<Session>, String> {
    state
        .sessions
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| "세션을 찾을 수 없습니다".to_string())
}

#[tauri::command]
pub fn term_write(state: State<TermState>, id: String, data: String) -> Result<(), String> {
    get(&state, &id)?
        .send_input(data.as_bytes())
        .map_err(|e| format!("입력을 보낼 수 없습니다: {e}"))
}

/// The Windows display language as one of the app's screen languages
/// (i18n.ts LANGUAGES); English for any other.
#[tauri::command]
pub fn os_ui_language() -> &'static str {
    // SAFETY: no arguments; returns the user's UI LANGID.
    let id = unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() };
    ui_language(id)
}

/// LANGID → app language: the primary language is the low 10 bits; Chinese
/// also needs the sub-language (Taiwan, Hong Kong, Macao: traditional).
fn ui_language(id: u16) -> &'static str {
    match id & 0x3ff {
        0x12 => "ko",
        0x11 => "ja",
        0x04 => match id >> 10 {
            0x01 | 0x03 | 0x05 => "zh-TW",
            _ => "zh-CN",
        },
        0x2a => "vi",
        0x0a => "es",
        0x0c => "fr",
        0x07 => "de",
        _ => "en",
    }
}

#[cfg(test)]
mod ui_language_tests {
    #[test]
    fn maps_windows_display_languages() {
        for (id, lang) in [(0x0412, "ko"), (0x0411, "ja"), (0x0804, "zh-CN"), (0x0404, "zh-TW"), (0x0c04, "zh-TW"), (0x1004, "zh-CN"), (0x042a, "vi"), (0x0c0a, "es"), (0x040c, "fr"), (0x0407, "de"), (0x0409, "en"), (0x0419, "en")] {
            assert_eq!(super::ui_language(id), lang, "{id:#06x}");
        }
    }
}

/// Windows build number (xterm.js needs it for terminals hosted in ConPTY:
/// how ConPTY rewraps lines decides whether xterm reflows them itself).
#[tauri::command]
pub fn windows_build() -> u32 {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let (key, name) = (wide(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"), wide("CurrentBuildNumber"));
    let mut buf = [0u16; 32];
    let mut size = std::mem::size_of_val(&buf) as u32;
    // SAFETY: valid NUL-terminated strings; buf/size describe a writable buffer.
    let status = unsafe {
        RegGetValueW(HKEY_LOCAL_MACHINE, key.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size)
    };
    if status != 0 {
        return 0;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len]).trim().parse().unwrap_or(0)
}

/// The page has processed `bytes` more bytes of this tab's output.
#[tauri::command]
pub fn term_ack(state: State<TermState>, id: String, bytes: usize) {
    if let Ok(session) = get(&state, &id) {
        session.out.ack(bytes);
    }
}

#[tauri::command]
pub fn term_resize(state: State<TermState>, id: String, rows: u16, cols: u16) -> Result<(), String> {
    let session = match get(&state, &id) {
        Ok(s) => s,
        Err(_) => return Ok(()),
    };
    match &session.backend {
        Backend::Pty { master, .. } => match master.lock().unwrap().as_ref() {
            Some(m) => m
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string()),
            None => Ok(()),
        },
        Backend::Telnet { naws, size, .. } => {
            *size.lock().unwrap() = (cols, rows);
            if *naws.lock().unwrap() {
                let _ = session.send_raw(&telnet::naws(cols, rows));
            }
            Ok(())
        }
        // A serial line has no window size.
        Backend::Serial { .. } => Ok(()),
    }
}

/// The app is exiting: close every log, so buffered output and the "on
/// disconnect" text reach the files (sessions are not dropped on exit).
pub fn end_all_logs(state: &TermState) {
    for session in state.sessions.lock().unwrap().values() {
        session.end_log();
    }
}

#[tauri::command]
pub async fn term_close(state: State<'_, TermState>, id: String) -> Result<(), String> {
    let Some(session) = state.sessions.lock().unwrap().remove(&id) else { return Ok(()) };
    session.out.close();
    match &session.backend {
        Backend::Pty { killer, .. } => {
            let _ = killer.lock().unwrap().kill();
            session.release_pty();
        }
        Backend::Telnet { control, closed, .. } => {
            closed.store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = control.shutdown(std::net::Shutdown::Both);
        }
        // Wait until the port is really released (threads stop within their
        // 100 ms poll), so an immediate reconnect can open it.
        Backend::Serial { closed, control, threads } => {
            closed.store(true, std::sync::atomic::Ordering::Relaxed);
            let handles = std::mem::take(&mut *threads.lock().unwrap());
            let _ = tauri::async_runtime::spawn_blocking(move || {
                for h in handles {
                    let _ = h.join();
                }
            })
            .await;
            control.lock().unwrap().take();
        }
    }
    Ok(())
}

fn logs_dir() -> Result<PathBuf, String> {
    let base = dirs::document_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "문서 폴더를 찾을 수 없습니다".to_string())?;
    let dir = app_documents(&base).join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("로그 폴더를 만들 수 없습니다: {e}"))?;
    Ok(dir)
}

/// Documents\BananaConn. A folder left under a previous product name (the
/// most recent first) is moved over once; when it cannot be moved (a log
/// still open elsewhere) it stays in use so no log is split across two folders.
fn app_documents(base: &Path) -> PathBuf {
    let current = base.join("BananaConn");
    if current.exists() {
        return current;
    }
    for name in ["BananaTerm", "BananaXterm"] {
        let previous = base.join(name);
        if previous.is_dir() {
            return if fs::rename(&previous, &current).is_ok() { current } else { previous };
        }
    }
    current
}

/// Turn per-tab logging on or off (see termlog.rs for the options). Returns
/// the log file path when enabled. Stopping writes the "on disconnect" text.
#[tauri::command]
pub async fn term_set_logging(
    state: State<'_, TermState>,
    id: String,
    options: Option<crate::termlog::LogOptions>,
) -> Result<Option<String>, String> {
    let session = get(&state, &id)?;
    off_ui(move || {
        let mut log = session.log.lock().unwrap();
        // The line still being written (the prompt) belongs to the old log.
        let rest = session.ansi.lock().unwrap().finish();
        if let Some(sink) = log.as_mut() {
            sink.write(&rest, true);
        }
        // Close the current file first: re-opening the same file in overwrite
        // mode must not race with the old handle's final write.
        *log = None;
        let Some(options) = options else { return Ok(None) };
        let sink = crate::termlog::LogSink::open(options, &logs_dir()?)?;
        let path = sink.path().to_string_lossy().into_owned();
        *log = Some(sink);
        Ok(Some(path))
    })
    .await
}

/// Commands run on the UI thread unless they are async: file work (a log
/// folder on a slow or unreachable share) goes to a blocking thread.
async fn off_ui<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn logs_folder() -> Result<String, String> {
    off_ui(|| logs_dir().map(|p| p.to_string_lossy().into_owned())).await
}

/// One line in the risky-command audit log (logs folder, risky-commands.log):
/// when, what happened (sent, cancelled, blocked), where, the rule and the
/// command. Returns the log file's path.
#[tauri::command]
pub async fn risk_audit(event: String, session: String, host: String, rule: String, command: String) -> Result<String, String> {
    off_ui(move || write_risk_audit(&event, &session, &host, &rule, &command)).await
}

fn write_risk_audit(event: &str, session: &str, host: &str, rule: &str, command: &str) -> Result<String, String> {
    let path = logs_dir()?.join("risky-commands.log");
    let clean = |s: &str| s.replace(['\t', '\r', '\n'], " ");
    let line = format!(
        "{}\t{}\t{}\t{}\t{}\t{}\r\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        clean(event),
        clean(session),
        clean(host),
        clean(rule),
        clean(command)
    );
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("위험 명령 기록을 남길 수 없습니다: {e}"))?;
    use std::io::Write as _;
    file.write_all(line.as_bytes()).map_err(|e| format!("위험 명령 기록을 남길 수 없습니다: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Write text chosen by the user (e.g. terminal scrollback) to a file.
#[tauri::command]
pub async fn save_text_file(path: String, content: String) -> Result<(), String> {
    off_ui(move || fs::write(&path, content).map_err(|e| format!("파일을 저장할 수 없습니다: {e}"))).await
}

#[cfg(test)]
mod ssh_arg_tests {
    use super::{forward_args, safe_token};

    #[test]
    fn rejects_option_injection() {
        assert!(safe_token("-oProxyCommand=calc", "호스트", "").is_err());
        assert!(safe_token("host name", "호스트", "").is_err());
        assert!(safe_token("10.0.0.5", "호스트", "").is_ok());
        assert!(safe_token("[fe80::1]", "호스트", "").is_ok());
        assert!(safe_token("서버.example.com", "호스트", "").is_ok());
    }

    #[test]
    fn parses_forwards() {
        let args = forward_args("L 8080:localhost:80\n# comment\nD 1080\nr 9000:127.0.0.1:3000").unwrap();
        assert_eq!(args, ["-L", "8080:localhost:80", "-D", "1080", "-R", "9000:127.0.0.1:3000"]);
        assert!(forward_args("X 1").is_err());
        assert!(forward_args("L -oProxyCommand=x").is_err());
        assert!(forward_args("L 80 ; calc").is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::AnsiStripper;

    #[test]
    fn reads_the_windows_build_number() {
        // Windows 10 1809 (17763) or later is required for ConPTY at all.
        assert!(super::windows_build() >= 17763, "{}", super::windows_build());
    }

    #[test]
    fn strips_ansi_sequences() {
        let mut s = AnsiStripper::default();
        let out = s.strip(b"\x1b[1;32mok\x1b[0m\r\n\x1b]0;title\x07done");
        assert_eq!(out, b"ok\n");
        assert_eq!(s.finish(), b"done");
        // Charset selection (tput sgr0) and a DCS string leave nothing behind.
        let out = s.strip(b"A\x1b(B\x1b[mB\x1bPq#0;2;0;0;0\x1b\\C\n");
        assert_eq!(out, b"ABC\n");
    }

    #[test]
    fn log_text_keeps_lines_and_applies_backspace() {
        let mut s = AnsiStripper::default();
        // A lone CR ends a line; CR LF and Telnet's CR NUL stay one break.
        assert_eq!(s.strip(b"boot 1\rboot 2\r\nnext\r\0x\r\n"), b"boot 1\nboot 2\nnext\nx\n");
        // Cisco's pager erases "--More--"; a typo corrected with Backspace; BEL dropped.
        assert_eq!(s.strip(b"--More--\x08\x08\x08\x08\x08\x08\x08\x08        \x08\x08\x08\x08\x08\x08\x08\x08line\x07\n"), b"line\n");
        assert_eq!(s.strip("show verx\x08sion 가\x08나\n".as_bytes()), "show version 나\n".as_bytes());
        // A CR at the end of one read and a LF at the start of the next.
        assert_eq!(s.strip(b"a\r"), b"");
        assert_eq!(s.strip(b"\nb"), b"a\n");
        // Interactive echo: the typo, then "\b \b" in a read of its own.
        assert_eq!(s.strip(b"x"), b"");
        assert_eq!(s.strip(b"\x08 \x08"), b"");
        assert_eq!(s.strip(b"c\n"), b"bc\n");
        assert_eq!(s.strip(b"Router#"), b"");
        assert_eq!(s.finish(), b"Router#");
    }
}

#[cfg(test)]
mod prompt_target_tests {
    #[test]
    fn resolves_like_openssh() {
        // No config entry: the typed host, lower-cased; the user as given.
        let (u, h) = super::ssh_prompt_target("Example.COM", 22, "Admin");
        assert_eq!((u.as_str(), h.as_str()), ("admin", "example.com"));
    }
}

#[cfg(test)]
mod write_queue_tests {
    /// A sink that never accepts data, like a peer that stopped reading.
    struct Stuck;
    impl std::io::Write for Stuck {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            std::thread::sleep(std::time::Duration::from_secs(3600));
            Ok(0)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_peer_that_stops_reading_cannot_grow_the_queue() {
        let tx = super::spawn_writer(Stuck);
        let refused = (0..super::WRITE_QUEUE + 50).filter(|_| tx.try_send(vec![0u8; 20]).is_err()).count();
        assert!(refused >= 49, "queue accepted everything ({refused} refused)");
    }
}

#[cfg(test)]
mod serial_tests {
    #[test]
    fn com_names() {
        for ok in ["COM1", "com3", "COM256", " COM12 "] {
            assert!(super::valid_com_name(ok), "{ok}");
        }
        for bad in ["COM0", "COM257", "LPT1", "COM", "COM3; calc", r"\.\COM3", "../COM3"] {
            assert!(!super::valid_com_name(bad), "{bad}");
        }
    }

    #[test]
    fn missing_port_is_a_clear_error_and_listing_works() {
        assert!(tauri::async_runtime::block_on(super::serial_ports()).is_ok());
        let path = r"\.\COM250";
        let err = serialport::new(path, 9600).open().expect_err("COM250 should not exist here");
        // The app maps exactly these kinds to "port not found".
        assert!(matches!(err.kind(), serialport::ErrorKind::NoDevice | serialport::ErrorKind::Io(std::io::ErrorKind::NotFound)), "{err:?}");
        println!("ports here: {:?}", tauri::async_runtime::block_on(super::serial_ports()).unwrap().iter().map(|p| &p.name).collect::<Vec<_>>());
    }
}

#[cfg(test)]
mod folder_tests {
    #[test]
    fn previous_documents_folder_is_moved_once_and_kept_afterwards() {
        let base = std::env::temp_dir().join(format!("bt-docs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("BananaXterm").join("logs")).unwrap();
        std::fs::write(base.join("BananaXterm").join("logs").join("a.log"), "old").unwrap();
        let dir = super::app_documents(&base);
        assert_eq!(dir, base.join("BananaConn"));
        assert_eq!(std::fs::read_to_string(dir.join("logs").join("a.log")).unwrap(), "old");
        assert!(!base.join("BananaXterm").exists());
        // A previous folder appearing later does not replace the current one.
        std::fs::create_dir_all(base.join("BananaXterm")).unwrap();
        assert_eq!(super::app_documents(&base), base.join("BananaConn"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_most_recent_previous_folder_wins() {
        let base = std::env::temp_dir().join(format!("bt-docs2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("BananaTerm").join("logs")).unwrap();
        std::fs::write(base.join("BananaTerm").join("logs").join("b.log"), "term").unwrap();
        std::fs::create_dir_all(base.join("BananaXterm")).unwrap();
        let dir = super::app_documents(&base);
        assert_eq!(dir, base.join("BananaConn"));
        assert_eq!(std::fs::read_to_string(dir.join("logs").join("b.log")).unwrap(), "term");
        assert!(!base.join("BananaTerm").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
