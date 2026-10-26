//! bx-rdp: BananaConn's built-in RDP client, run as a child process per session.
//!
//! Parent protocol:
//! - stdin: newline-delimited JSON. The first line is [`Init`] (credentials
//!   arrive here, never on the command line); later lines are [`Cmd`].
//! - stdout: framed messages `[kind: u8][len: u32 LE][payload]`.
//!   kind 1 = JSON event; kind 2 = screen update laid out as
//!   `[desktop_w, desktop_h, count]` (u16 LE each), then `count` regions, each
//!   `[x, y, w, h]` (u16 LE) followed by its RGBA rows.
//!
//! The parent closing stdin is treated as a request to disconnect.

use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use ironrdp::connector::connection_activation::ConnectionActivationState;
use ironrdp::connector::{self, ClientConnector, ConnectionResult, ConnectorErrorKind, Credentials, ServerName};
use ironrdp::core::WriteBuf;
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::displaycontrol::pdu::MonitorLayoutEntry;
use ironrdp::dvc::DrdynvcClient;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::geometry::InclusiveRectangle;
use ironrdp::pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags, SynchronizeFlags};
use ironrdp::pdu::rdp::capability_sets::{MajorPlatformType, client_codecs_capabilities};
use ironrdp::pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStageBuilder, ActiveStageOutput, fast_path};
use ironrdp_tokio::{FramedWrite as _, NetworkClient, TokioFramed, single_sequence_step_read, split_tokio_framed};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

const KIND_EVENT: u8 = 1;
const KIND_FRAME: u8 = 2;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Init {
    host: String,
    port: u16,
    username: String,
    password: String,
    #[serde(default)]
    domain: Option<String>,
    width: u16,
    height: u16,
    /// Local display scale in percent (150 on a 150% screen): the server then
    /// renders text at its normal size on the larger pixel desktop.
    #[serde(default)]
    scale: Option<u32>,
    /// Fingerprint the user trusted earlier for this host, if any.
    #[serde(default)]
    trusted_fingerprint: Option<String>,
    /// Where to open the TCP connection when it differs from host:port (an SSH
    /// gateway's local tunnel end). `host` still names the server for TLS/NLA.
    #[serde(default)]
    connect_addr: Option<String>,
    /// Share the clipboard with the server (CLIPRDR), like mstsc's option.
    #[serde(default = "yes")]
    clipboard: bool,
}

fn yes() -> bool {
    true
}

/// MS-RDPBCGR allows desktop scale factors of 100 to 500 percent.
fn valid_scale(scale: u32) -> Option<u32> {
    (100..=500).contains(&scale).then_some(scale)
}

/// How long a resize waits for the server to open Display Control before
/// it counts as unsupported (servers that never open it: 2008 R2, old xrdp).
const RESIZE_WAIT: Duration = Duration::from_secs(5);

// ---- clipboard (CLIPRDR) ------------------------------------------------------------------
//
// IronRDP's Windows backend works on the real OS clipboard through a hidden
// window, both ways, for every format except files (text, CF_DIB/PNG images,
// HTML …): a local copy is announced to the server, and a paste on either side
// fetches the data on demand. fileclip.rs wraps it to add files (Explorer copy
// and paste, like mstsc). The window and the OLE objects need a thread with a
// message loop of its own; the backend reports to the session loop through
// `ClipProxy`.

mod fileclip;

use ironrdp::cliprdr::backend::{ClipboardMessage, ClipboardMessageProxy, CliprdrBackendFactory};
use ironrdp::cliprdr::pdu::{ClipboardFormat, ClipboardFormatId};

#[derive(Debug)]
struct ClipProxy(mpsc::UnboundedSender<ClipboardMessage>);

impl ClipboardMessageProxy for ClipProxy {
    fn send_clipboard_message(&self, message: ClipboardMessage) {
        let _ = self.0.send(message);
    }
}

type ClipFactory = Box<dyn CliprdrBackendFactory + Send>;

struct Clipboard {
    factory: ClipFactory,
    messages: mpsc::UnboundedReceiver<ClipboardMessage>,
    files: Arc<fileclip::Shared>,
}

/// Start the clipboard bridge thread. None when the clipboard cannot be used
/// (the session then simply has no clipboard channel).
fn start_clipboard(out: &Out) -> Option<Clipboard> {
    fileclip::remove_stale_downloads();
    let (tx, rx) = mpsc::unbounded_channel();
    // File copy progress for the app (download of files copied on the remote).
    let (events_tx, mut events) = mpsc::unbounded_channel::<Value>();
    let events_out = out.clone();
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            events_out.event(event).await;
        }
    });
    let files = fileclip::Shared::new(tx.clone(), events_tx);
    let thread_files = files.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let window = fileclip::init_thread(&thread_files);
        match ironrdp_cliprdr_native::WinClipboard::new(ClipProxy(tx)) {
            Ok(clipboard) => {
                fileclip::mark_native_window_inactive();
                let _ = ready_tx.send(Some(clipboard.backend_factory()));
                fileclip::run_message_loop(&thread_files, window);
                drop(clipboard);
            }
            Err(e) => {
                eprintln!("clipboard unavailable: {e}");
                thread_files.trace("unavailable", format!("the local clipboard cannot be used: {e}"));
                let _ = ready_tx.send(None);
            }
        }
    });
    let inner = ready_rx.recv().ok().flatten()?;
    let factory: ClipFactory = Box::new(fileclip::FileClipFactory { inner, shared: files.clone() });
    Some(Clipboard { factory, messages: rx, files })
}

/// A file list copied before the clipboard channel finished its start-up
/// (files already on the local clipboard when the session connects): it is
/// announced as soon as the channel is ready (see `retry_file_copy`).
type PendingFiles = Option<Vec<ironrdp::cliprdr::pdu::FileDescriptor>>;

fn not_ready(e: &ironrdp::pdu::PduError) -> bool {
    e.to_string().contains("not in Ready state")
}

/// Hand one clipboard backend message to the CLIPRDR channel; returns the frame to send.
/// A clipboard failure never ends the session: it is logged and that one
/// message dropped (the remote desktop stays usable).
fn clipboard_frame(
    stage: &mut ironrdp::session::ActiveStage,
    files: &fileclip::Shared,
    pending: &mut PendingFiles,
    message: ClipboardMessage,
) -> Result<Option<Vec<u8>>, Fail> {
    use ironrdp::cliprdr::CliprdrClient;
    let Some(cliprdr) = stage.get_svc_processor_mut::<CliprdrClient>() else { return Ok(None) };
    let result = match message {
        // Copied locally before Monitor Ready (while logging on): the server's
        // clipboard program may not listen yet. Monitor Ready makes the native
        // backend announce the clipboard as it is then.
        ClipboardMessage::SendInitiateCopy(_) if !files.server_ready_for_copies() => {
            files.trace("held", "a local copy before the server was ready: announced at Monitor Ready");
            return Ok(None);
        }
        // The remote's own files, offered on our clipboard: nothing new to announce.
        ClipboardMessage::SendInitiateCopy(_) if files.is_own_clipboard() => return Ok(None),
        // Files copied in Explorer: announce them as a file list (FileGroupDescriptorW).
        ClipboardMessage::SendInitiateCopy(formats) => match files.local_copy(&formats) {
            Some(list) => match cliprdr.initiate_file_copy(list.clone()) {
                // Start-up: the first copy also carries the client capabilities,
                // so it must go out now (as an empty format list); the files follow.
                Err(e) if not_ready(&e) => {
                    *pending = Some(list);
                    cliprdr.initiate_copy(&[])
                }
                other => other,
            },
            None => {
                *pending = None;
                cliprdr.initiate_copy(&transferable(formats))
            }
        },
        ClipboardMessage::SendFormatData(response) => {
            files.trace(
                "pasteData",
                if response.is_error() { "no data in that format on the local clipboard".to_string() } else { format!("sent {} bytes", response.data().len()) },
            );
            cliprdr.submit_format_data(response)
        }
        ClipboardMessage::SendInitiatePaste(format) => cliprdr.initiate_paste(format),
        ClipboardMessage::SendInitiateFileCopy(list) => match cliprdr.initiate_file_copy(list.clone()) {
            Err(e) if not_ready(&e) => {
                *pending = Some(list);
                return Ok(None);
            }
            other => other,
        },
        ClipboardMessage::SendFileContentsRequest(request) => cliprdr.request_file_contents(request),
        ClipboardMessage::SendFileContentsResponse(response) => cliprdr.submit_file_contents(response),
        ClipboardMessage::Error(e) => {
            eprintln!("clipboard: {e}");
            files.trace("error", e.to_string());
            return Ok(None);
        }
    };
    let messages = match result {
        Ok(messages) => messages,
        Err(e) => {
            eprintln!("clipboard: {e}");
            files.trace("error", e.to_string());
            return Ok(None);
        }
    };
    let frame = stage.process_svc_processor_messages(messages).map_err(session_fail)?;
    Ok((!frame.is_empty()).then_some(frame))
}

/// Announce a file list that waited for the clipboard start-up, once it is done.
fn retry_file_copy(stage: &mut ironrdp::session::ActiveStage, pending: &mut PendingFiles) -> Result<Option<Vec<u8>>, Fail> {
    let Some(list) = pending.clone() else { return Ok(None) };
    let Some(cliprdr) = stage.get_svc_processor_mut::<ironrdp::cliprdr::CliprdrClient>() else { return Ok(None) };
    let messages = match cliprdr.initiate_file_copy(list) {
        Err(e) if not_ready(&e) => return Ok(None),
        Err(e) => {
            eprintln!("clipboard: {e}");
            *pending = None;
            return Ok(None);
        }
        Ok(messages) => {
            *pending = None;
            messages
        }
    };
    let frame = stage.process_svc_processor_messages(messages).map_err(session_fail)?;
    Ok((!frame.is_empty()).then_some(frame))
}

/// The local formats worth offering to the server. Formats whose clipboard
/// data is a GDI handle, not bytes (CF_BITMAP, metafiles, palettes, owner
/// display) cannot be sent, and OLE's internal formats mean nothing remotely;
/// offered anyway, the remote app may ask for exactly those (screenshot tools
/// put CF_BITMAP first) and the paste fails. A bitmap goes as CF_DIB / CF_DIBV5,
/// which Windows renders from any bitmap on request, and the server makes its
/// own CF_BITMAP from those — what mstsc does.
fn transferable(formats: Vec<ClipboardFormat>) -> Vec<ClipboardFormat> {
    const HANDLES: [u32; 8] = [2, 3, 9, 14, 0x80, 0x82, 0x83, 0x8E];
    const OLE_INTERNAL: [&str; 5] = ["DataObject", "Ole Private Data", "OleClipboardPersistOnFlush", "Object Descriptor", "Link Source Descriptor"];
    let had_bitmap = formats.iter().any(|f| matches!(f.id().value(), 2 | 8 | 17));
    let mut out: Vec<ClipboardFormat> = formats
        .into_iter()
        .filter(|f| !HANDLES.contains(&f.id().value()))
        .filter(|f| !f.name().is_some_and(|n| OLE_INTERNAL.contains(&n.value()) || n.value().starts_with("System.")))
        .collect();
    if had_bitmap && !out.iter().any(|f| f.id() == ClipboardFormatId::CF_DIB) {
        out.push(ClipboardFormat::new(ClipboardFormatId::CF_DIB));
    }
    out
}

/// Next clipboard message, or never when the session has no clipboard.
async fn next_clip(rx: &mut Option<mpsc::UnboundedReceiver<ClipboardMessage>>) -> Option<ClipboardMessage> {
    match rx {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
enum Cmd {
    Cert { accept: bool },
    Input { ops: Vec<Op> },
    Resize {
        width: u32,
        height: u32,
        #[serde(default)]
        scale: Option<u32>,
    },
    /// The app has drawn one screen update (flow control, see session()).
    Ack,
    /// The tab went off screen (no updates are sent; the image is kept up to
    /// date here) or came back (the whole screen is sent once).
    Visible { visible: bool },
    Close,
}

/// Screen updates sent but not yet drawn by the app. Beyond this, updates are
/// held back and merged into the dirty regions (nothing is lost: the full
/// image lives here), so a slow page never makes frames pile up in memory.
const MAX_IN_FLIGHT: u32 = 2;

/// Regions per screen update; beyond this the closest ones merge.
const MAX_RECTS: usize = 32;
/// An update goes out as soon as the page is free, but at most about once
/// per display refresh (60 Hz): faster updates are never seen, and the
/// regions changed meanwhile are merged into the next one.
const MIN_GAP: Duration = Duration::from_millis(15);
/// No acknowledgement for this long: the page lost one; stop waiting for it.
const ACK_STALL: Duration = Duration::from_secs(2);

/// Areas of the desktop changed since the last screen update. Separate areas
/// stay separate: a clock tick in one corner and the cursor trail in another
/// must not become a copy of the whole screen. Overlapping or adjacent areas
/// merge, so the set stays pairwise disjoint and never exceeds the desktop.
#[derive(Default)]
struct Dirty(Vec<InclusiveRectangle>);

impl Dirty {
    fn add(&mut self, r: &InclusiveRectangle) {
        self.absorb(r.clone());
        // Too many regions: merge the pair whose union adds the least area
        // (two neighbouring characters), never a stray clock and a cursor
        // trail into one box the size of the desktop.
        while self.0.len() > MAX_RECTS {
            let mut best = (0, 1, u64::MAX);
            for i in 0..self.0.len() {
                for j in i + 1..self.0.len() {
                    let (a, b) = (&self.0[i], &self.0[j]);
                    let grow = area(&union(Some(a.clone()), b)).saturating_sub(area(a) + area(b));
                    if grow < best.2 {
                        best = (i, j, grow);
                    }
                }
            }
            let b = self.0.swap_remove(best.1);
            let a = self.0.swap_remove(best.0);
            self.absorb(union(Some(a), &b));
        }
    }

    /// Add one region, merging every region it overlaps or nearly touches.
    fn absorb(&mut self, mut r: InclusiveRectangle) {
        loop {
            let before = self.0.len();
            self.0.retain(|o| {
                if near(o, &r) {
                    r = union(Some(o.clone()), &r);
                    false
                } else {
                    true
                }
            });
            if self.0.len() == before {
                break;
            }
        }
        self.0.push(r);
    }

    fn take(&mut self) -> Vec<InclusiveRectangle> {
        std::mem::take(&mut self.0)
    }
}

/// Overlapping or within a few pixels: cheaper to send as one region.
fn near(a: &InclusiveRectangle, b: &InclusiveRectangle) -> bool {
    const GAP: u16 = 8;
    a.left <= b.right.saturating_add(GAP)
        && b.left <= a.right.saturating_add(GAP)
        && a.top <= b.bottom.saturating_add(GAP)
        && b.top <= a.bottom.saturating_add(GAP)
}

#[derive(Deserialize, Debug)]
#[serde(tag = "t", rename_all = "camelCase")]
enum Op {
    Key {
        code: u8,
        ext: bool,
        down: bool,
        #[serde(default)]
        repeat: bool,
    },
    Unicode {
        ch: char,
        down: bool,
    },
    Move {
        x: u16,
        y: u16,
    },
    Button {
        b: u8,
        down: bool,
    },
    Wheel {
        delta: i16,
        vertical: bool,
    },
    ReleaseAll,
    /// Toggle-key state of the local keyboard (Scroll 1, Num 2, Caps 4, Kana 8):
    /// the server's Num/Caps/Scroll Lock are set to match, as mstsc does.
    Sync {
        flags: u8,
    },
}

/// A failure reported to the parent as `{"type":"error","kind":..,"message":..}`.
struct Fail {
    kind: &'static str,
    message: String,
}

impl Fail {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// Drop IronRDP's `[context @ source/file.rs:line]` location markers from an
/// error report so users see only the meaningful part.
fn clean_report(report: &str) -> String {
    let mut out = String::with_capacity(report.len());
    let mut rest = report;
    while let Some(start) = rest.find('[') {
        match rest[start..].find(']') {
            Some(end) if rest[start..start + end].contains(" @ ") => {
                out.push_str(&rest[..start]);
                rest = rest[start + end + 1..].trim_start();
            }
            _ => {
                out.push_str(&rest[..=start]);
                rest = &rest[start + 1..];
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

fn connector_fail(e: connector::ConnectorError) -> Fail {
    let detail = clean_report(&e.report().to_string());
    let auth = || {
        Fail::new("auth", format!("인증에 실패했습니다. 사용자 이름(필요하면 도메인\\사용자)과 비밀번호를 확인하세요. ({detail})"))
    };
    match e.kind() {
        ConnectorErrorKind::AccessDenied => auth(),
        // Only a rejected user name or password asks for them again; other
        // NLA failures (Kerberos-only server, CredSSP policy, a dropped
        // connection, a locked account) say what happened instead.
        ConnectorErrorKind::Credssp(err) => {
            use connector::sspi::{ErrorKind as Sspi, credssp::NStatusCode as St};
            let wrong = matches!(err.error_type, Sspi::LogonDenied | Sspi::UnknownCredentials | Sspi::NoCredentials | Sspi::IncompleteCredentials)
                || matches!(err.nstatus, Some(St::LOGON_FAILURE | St::WRONG_PASSWORD | St::NO_SUCH_USER));
            if wrong { auth() } else { Fail::new("negotiation", format!("NLA(CredSSP) 인증 단계에서 연결하지 못했습니다: {detail}")) }
        }
        ConnectorErrorKind::Negotiation(_) => Fail::new("negotiation", format!("서버와 보안 방식을 협상하지 못했습니다: {detail}")),
        _ => Fail::new("connect", detail),
    }
}

/// Share Data PDU types (MS-RDPBCGR 2.2.8.1.1.1.2) that IronRDP's active stage
/// accepts: Update, Pointer, Shutdown Denied, Save Session Info, Set Keyboard
/// Indicators, Set Error Info. It rejects every other type as "unhandled PDU"
/// and ends the session.
const HANDLED_DATA_PDUS: [u8; 6] = [0x02, 0x1B, 0x25, 0x26, 0x29, 0x2F];

/// Windows servers pack several Share Control PDUs into one MCS Send Data
/// Indication (for example Set Keyboard Indicators plus Set Keyboard IME Status
/// right after logon). IronRDP 0.17 decodes only the first one, and its
/// byte-blob variants swallow the rest of the packet, so the session fails with
/// "not enough bytes provided to decode: received 22 bytes, expected N".
///
/// Split an IO-channel frame into one frame per PDU, using each PDU's own
/// totalLength, and drop flow PDUs and informational data PDUs IronRDP would
/// reject. `None` means "pass the frame through unchanged".
fn split_io_frame(frame: &[u8], io_channel_id: u16) -> Option<Vec<Vec<u8>>> {
    use std::borrow::Cow;
    use ironrdp::pdu::mcs::{SendDataIndication, decode_send_data_indication};
    use ironrdp::pdu::x224::X224;

    let ctx = decode_send_data_indication(frame).ok()?;
    let data = ctx.user_data;
    // Multitransport requests start with a security header whose second word is 0.
    if ctx.channel_id != io_channel_id || data.len() < 6 || data[2..4] == [0, 0] {
        return None;
    }
    let mut chunks = Vec::new();
    let mut changed = false;
    let mut pos = 0;
    while pos < data.len() {
        let rest = &data[pos..];
        if rest.len() < 6 {
            return None;
        }
        let total = usize::from(u16::from_le_bytes([rest[0], rest[1]]));
        if total == 0x8000 {
            // Flow control PDU (8 bytes); IronRDP cannot decode it and it needs no reply.
            pos += 8.min(rest.len());
            changed = true;
            continue;
        }
        if total < 6 || total > rest.len() {
            return None; // malformed: let IronRDP report it
        }
        let pdu = &rest[..total];
        let pdu_type = u16::from_le_bytes([pdu[2], pdu[3]]) & 0x0F;
        if pdu_type == 0x7 && pdu.len() > 14 && !HANDLED_DATA_PDUS.contains(&pdu[14]) {
            eprintln!("ignoring share data PDU type 0x{:02X} ({} bytes)", pdu[14], pdu.len());
            changed = true;
        } else {
            chunks.push(pdu);
        }
        pos += total;
    }
    if !changed && chunks.len() == 1 {
        return None;
    }
    chunks
        .into_iter()
        .map(|pdu| {
            ironrdp::core::encode_vec(&X224(SendDataIndication {
                initiator_id: ctx.initiator_id,
                channel_id: ctx.channel_id,
                user_data: Cow::Borrowed(pdu),
            }))
            .ok()
        })
        .collect()
}

/// Run one decode step. A decoder panic on a malformed or unusual update skips
/// that update instead of tearing down the whole session.
fn guarded(
    step: impl FnOnce() -> ironrdp::session::SessionResult<Vec<ActiveStageOutput>>,
) -> Result<Vec<ActiveStageOutput>, Fail> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(step)) {
        Ok(result) => result.map_err(session_fail),
        Err(_) => {
            eprintln!("skipped a screen update that the decoder could not handle");
            Ok(Vec::new())
        }
    }
}

fn session_fail(e: ironrdp::session::SessionError) -> Fail {
    Fail::new("session", clean_report(&e.report().to_string()))
}

/// Serialized writer for stdout; every message goes through one task.
#[derive(Clone)]
struct Out(mpsc::Sender<Vec<u8>>);

impl Out {
    async fn send(&self, kind: u8, payload: &[u8]) {
        let mut msg = Vec::with_capacity(5 + payload.len());
        msg.push(kind);
        msg.extend_from_slice(&u32::try_from(payload.len()).unwrap_or(u32::MAX).to_le_bytes());
        msg.extend_from_slice(payload);
        let _ = self.0.send(msg).await;
    }

    /// Send a message built with `header` in front.
    async fn send_built(&self, mut msg: Vec<u8>) {
        let len = u32::try_from(msg.len() - 5).unwrap_or(u32::MAX).to_le_bytes();
        msg[1..5].copy_from_slice(&len);
        let _ = self.0.send(msg).await;
    }

    async fn event(&self, value: Value) {
        self.send(KIND_EVENT, value.to_string().as_bytes()).await;
    }

    async fn status(&self, stage: &str) {
        self.event(json!({ "type": "status", "stage": stage })).await;
    }

    /// Send regions of an RGBA desktop buffer (dw × dh) as one screen update,
    /// with opaque alpha. Returns false when there was nothing to send.
    async fn frame(&self, data: &[u8], dw: u16, dh: u16, rects: &[InclusiveRectangle]) -> bool {
        let stride = usize::from(dw) * 4;
        let mut regions = Vec::new();
        let mut bytes = 6;
        for r in rects {
            let left = r.left.min(dw.saturating_sub(1));
            let top = r.top.min(dh.saturating_sub(1));
            let right = r.right.min(dw.saturating_sub(1));
            let bottom = r.bottom.min(dh.saturating_sub(1));
            if right < left || bottom < top {
                continue;
            }
            let (w, h) = (right - left + 1, bottom - top + 1);
            bytes += 8 + usize::from(w) * usize::from(h) * 4;
            regions.push((left, top, w, h));
        }
        if regions.is_empty() {
            return false;
        }
        // The message header goes in front now, so the pixels are copied once.
        let mut payload = Vec::with_capacity(5 + bytes);
        payload.extend_from_slice(&[KIND_FRAME, 0, 0, 0, 0]);
        for v in [dw, dh, regions.len() as u16] {
            payload.extend_from_slice(&v.to_le_bytes());
        }
        for (left, top, w, h) in regions {
            for v in [left, top, w, h] {
                payload.extend_from_slice(&v.to_le_bytes());
            }
            for y in top..top + h {
                let start = usize::from(y) * stride + usize::from(left) * 4;
                let at = payload.len();
                payload.extend_from_slice(&data[start..start + usize::from(w) * 4]);
                for px in payload[at..].chunks_exact_mut(4) {
                    px[3] = 0xff;
                }
            }
        }
        self.send_built(payload).await;
        true
    }
}

/// Kerberos/KDC is not used (NTLM via CredSSP), so no network requests are made.
struct NoNetwork;

impl NetworkClient for NoNetwork {
    async fn send(&mut self, _req: &ironrdp::connector::sspi::generator::NetworkRequest) -> connector::ConnectorResult<Vec<u8>> {
        Err(connector::general_err!("network requests (Kerberos KDC) are not supported"))
    }
}

trait AsyncReadWrite: AsyncRead + AsyncWrite {}
impl<T: AsyncRead + AsyncWrite> AsyncReadWrite for T {}
type UpgradedFramed = TokioFramed<Box<dyn AsyncReadWrite + Unpin + Send + Sync>>;

fn fingerprint(public_key: &[u8]) -> String {
    let digest = Sha256::digest(public_key);
    format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest))
}

/// Accept `DOMAIN\user`, `user@domain` or a plain user name.
fn split_user(username: &str, domain: Option<String>) -> (Option<String>, String) {
    if let Some((d, u)) = username.split_once('\\') {
        return (Some(d.to_string()), u.to_string());
    }
    (domain.filter(|d| !d.is_empty()), username.to_string())
}

fn even_size(v: u16) -> u16 {
    (v.clamp(200, 8192)) & !1
}

/// This PC's keyboard as Windows reports it, sent to the server the way mstsc
/// does. The server's layout uses it to interpret scancodes: with a made-up
/// type or a zero layout, keys such as right Alt / right Ctrl (한/영 and 한자 on
/// Korean keyboards) can end up meaning something else remotely.
struct LocalKeyboard {
    kind: KeyboardType,
    subtype: u32,
    layout: u32,
    function_keys: u32,
}

fn local_keyboard() -> LocalKeyboard {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyboardLayoutNameW, GetKeyboardType};
    // SAFETY: plain queries.
    let (kind, subtype, keys) = unsafe { (GetKeyboardType(0), GetKeyboardType(1), GetKeyboardType(2)) };
    let mut name = [0u16; 9];
    // SAFETY: the buffer has the KL_NAMELENGTH (9) characters the API needs.
    let layout = unsafe { GetKeyboardLayoutNameW(&mut name) }
        .ok()
        .and_then(|_| u32::from_str_radix(String::from_utf16_lossy(&name[..8]).trim(), 16).ok())
        .unwrap_or(0x0409);
    LocalKeyboard {
        kind: match kind {
            1 => KeyboardType::IbmPcXt,
            2 => KeyboardType::OlivettiIco,
            3 => KeyboardType::IbmPcAt,
            5 => KeyboardType::Nokia1050,
            6 => KeyboardType::Nokia9140,
            7 => KeyboardType::Japanese,
            8 => KeyboardType::Korean,
            _ => KeyboardType::IbmEnhanced,
        },
        subtype: u32::try_from(subtype).unwrap_or(0),
        layout,
        function_keys: u32::try_from(keys).ok().filter(|k| *k > 0).unwrap_or(12),
    }
}

fn connector_config(init: &Init) -> Result<connector::Config, Fail> {
    let keyboard = local_keyboard();
    let (domain, username) = split_user(&init.username, init.domain.clone());
    let codecs = client_codecs_capabilities(&[]).map_err(|e| Fail::new("connect", e))?;
    Ok(connector::Config {
        credentials: Credentials::UsernamePassword {
            username,
            password: init.password.clone(),
        },
        domain,
        // NLA first; plain TLS (server-side logon screen) as a fallback.
        enable_tls: true,
        enable_credssp: true,
        keyboard_type: keyboard.kind,
        keyboard_subtype: keyboard.subtype,
        keyboard_layout: keyboard.layout,
        keyboard_functional_keys_count: keyboard.function_keys,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: connector::DesktopSize {
            width: even_size(init.width),
            height: init.height.clamp(200, 8192),
        },
        desktop_scale_factor: init.scale.and_then(valid_scale).unwrap_or(0),
        bitmap: Some(connector::BitmapConfig {
            color_depth: 32,
            lossy_compression: true,
            codecs,
        }),
        client_build: 0,
        client_name: "BananaConn".into(),
        client_dir: String::new(),
        alternate_shell: String::new(),
        work_dir: String::new(),
        platform: MajorPlatformType::WINDOWS,
        hardware_id: None,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        performance_flags: PerformanceFlags::default(),
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        // No bulk compression: IronRDP 0.17 decompresses fast-path updates only,
        // and a server may compress slow-path PDUs too. Bitmaps are still
        // compressed by their codecs.
        compression_type: None,
        enable_server_pointer: true,
        pointer_software_rendering: false,
        multitransport_flags: None,
    })
}

async fn connect(
    init: &Init,
    out: &Out,
    cmds: &mut mpsc::UnboundedReceiver<Cmd>,
    clipboard: Option<&ClipFactory>,
) -> Result<(ConnectionResult, UpgradedFramed), Fail> {
    out.status("tcp").await;
    let target = init.connect_addr.clone().unwrap_or_else(|| format!("{}:{}", init.host, init.port));
    let stream = tokio::time::timeout(Duration::from_secs(12), TcpStream::connect(&target))
        .await
        .map_err(|_| Fail::new("connect", format!("{target} 연결 시간이 초과되었습니다")))?
        .map_err(|e| Fail::new("connect", format!("{target} 에 연결할 수 없습니다: {e}")))?;
    let _ = stream.set_nodelay(true);
    let client_addr = stream.local_addr().map_err(|e| Fail::new("connect", e.to_string()))?;

    let drdynvc = DrdynvcClient::new().with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new())));
    let mut connector = ClientConnector::new(connector_config(init)?, client_addr).with_static_channel(drdynvc);
    if let Some(factory) = clipboard {
        connector.attach_static_channel(ironrdp::cliprdr::CliprdrClient::new(factory.build_cliprdr_backend()));
    }

    let mut framed = TokioFramed::new(stream);
    let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector)
        .await
        .map_err(connector_fail)?;

    out.status("tls").await;
    let (initial, leftover) = framed.into_inner();
    let (tls_stream, cert) = ironrdp_tls::upgrade(initial, &init.host)
        .await
        .map_err(|e| Fail::new("tls", format!("TLS 연결에 실패했습니다: {e}")))?;
    let public_key = ironrdp_tls::extract_tls_server_public_key(&cert)
        .ok_or_else(|| Fail::new("tls", "서버 인증서에서 공개 키를 읽을 수 없습니다"))?
        .to_owned();

    // The TLS layer accepts any certificate (RDP servers are usually
    // self-signed), so trust is decided here by pinning the key fingerprint.
    let fp = fingerprint(&public_key);
    if init.trusted_fingerprint.as_deref() != Some(fp.as_str()) {
        out.event(json!({ "type": "cert", "fingerprint": fp, "previous": init.trusted_fingerprint }))
            .await;
        loop {
            match cmds.recv().await {
                Some(Cmd::Cert { accept: true }) => break,
                Some(Cmd::Cert { accept: false }) | Some(Cmd::Close) | None => {
                    return Err(Fail::new("cancelled", "서버 인증서를 신뢰하지 않아 연결을 취소했습니다"));
                }
                Some(_) => {}
            }
        }
    }

    let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
    let erased: Box<dyn AsyncReadWrite + Unpin + Send + Sync> = Box::new(tls_stream);
    let mut framed = TokioFramed::new_with_leftover(erased, leftover);

    out.status("auth").await;
    let result = ironrdp_tokio::connect_finalize(
        upgraded,
        connector,
        &mut framed,
        &mut NoNetwork,
        ServerName::new(init.host.clone()),
        public_key,
        None,
    )
    .await
    .map_err(connector_fail)?;
    Ok((result, framed))
}

fn to_operation(op: Op) -> Option<Operation> {
    Some(match op {
        Op::Key { code, ext, down, .. } => {
            let s = Scancode::from_u8(ext, code);
            if down { Operation::KeyPressed(s) } else { Operation::KeyReleased(s) }
        }
        Op::Unicode { ch, down } => {
            if down { Operation::UnicodeKeyPressed(ch) } else { Operation::UnicodeKeyReleased(ch) }
        }
        Op::Move { x, y } => Operation::MouseMove(MousePosition { x, y }),
        Op::Button { b, down } => {
            let button = MouseButton::from_web_button(b)?;
            if down { Operation::MouseButtonPressed(button) } else { Operation::MouseButtonReleased(button) }
        }
        Op::Wheel { delta, vertical } => Operation::WheelRotations(WheelRotations {
            is_vertical: vertical,
            rotation_units: delta,
        }),
        Op::ReleaseAll | Op::Sync { .. } => return None,
    })
}

/// Translate one input batch into fast-path events. Key auto-repeat is sent
/// as a plain key-down (the input database would emit release+press instead).
fn input_events(db: &mut Database, ops: Vec<Op>) -> Vec<FastPathInputEvent> {
    let mut events = Vec::new();
    for op in ops {
        match op {
            Op::ReleaseAll => events.extend(db.release_all()),
            Op::Sync { flags } => events.push(FastPathInputEvent::SyncEvent(SynchronizeFlags::from_bits_truncate(flags))),
            Op::Key { code, ext, down: true, repeat: true } => {
                let flags = if ext { KeyboardFlags::EXTENDED } else { KeyboardFlags::empty() };
                events.push(FastPathInputEvent::KeyboardEvent(flags, code));
            }
            other => {
                if let Some(operation) = to_operation(other) {
                    events.extend(db.apply([operation]));
                }
            }
        }
    }
    events
}

fn area(r: &InclusiveRectangle) -> u64 {
    (u64::from(r.right.saturating_sub(r.left)) + 1) * (u64::from(r.bottom.saturating_sub(r.top)) + 1)
}

fn union(a: Option<InclusiveRectangle>, b: &InclusiveRectangle) -> InclusiveRectangle {
    match a {
        None => b.clone(),
        Some(a) => InclusiveRectangle {
            left: a.left.min(b.left),
            top: a.top.min(b.top),
            right: a.right.max(b.right),
            bottom: a.bottom.max(b.bottom),
        },
    }
}

fn full(image: &DecodedImage) -> InclusiveRectangle {
    InclusiveRectangle {
        left: 0,
        top: 0,
        right: image.width().saturating_sub(1),
        bottom: image.height().saturating_sub(1),
    }
}

async fn session(
    framed: UpgradedFramed,
    result: ConnectionResult,
    out: &Out,
    cmds: &mut mpsc::UnboundedReceiver<Cmd>,
    clip_rx: &mut Option<mpsc::UnboundedReceiver<ClipboardMessage>>,
    clip_files: Option<Arc<fileclip::Shared>>,
) -> Result<String, Fail> {
    // CLIPRDR clipboard locks expire on a timer (MS-RDPECLIP lock/unlock); the
    // same tick announces files that waited for the clipboard start-up.
    let mut clip_timer = tokio::time::interval(Duration::from_secs(1));
    let mut pending_files: PendingFiles = None;
    clip_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let (mut reader, mut writer) = split_tokio_framed(framed);
    let size = result.desktop_size;
    let mut image = DecodedImage::new(PixelFormat::RgbA32, size.width, size.height);
    let activation = result.activation_factory;
    let io_channel_id = result.io_channel_id;
    let mut stage = ActiveStageBuilder {
        static_channels: result.static_channels,
        user_channel_id: result.user_channel_id,
        io_channel_id: result.io_channel_id,
        message_channel_id: result.message_channel_id,
        share_id: result.share_id,
        compression_type: result.compression_type,
        enable_server_pointer: result.enable_server_pointer,
        pointer_software_rendering: result.pointer_software_rendering,
    }
    .build();
    let mut input = Database::new();
    let mut dirty = Dirty::default();
    let mut in_flight: u32 = 0;
    let mut last_ack = Instant::now();
    let mut last_frame = Instant::now();
    let mut visible = true;
    let mut closing = false;
    // A resize asked for before the server opened Display Control (the first
    // moments after connecting): sent as soon as the channel is there.
    let mut pending_resize: Option<(u32, u32, Option<u32>, Instant)> = None;
    // Coalesce screen updates to at most ~60 per second.
    let mut flush = tokio::time::interval(Duration::from_millis(16));
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    out.event(json!({ "type": "connected", "width": size.width, "height": size.height }))
        .await;

    loop {
        let outputs = tokio::select! {
            frame = reader.read_pdu() => {
                let (action, payload) = match frame {
                    Ok(f) => f,
                    Err(_) if closing => return Ok("사용자가 연결을 종료했습니다".into()),
                    Err(e) => return Err(Fail::new("session", format!("연결이 끊어졌습니다: {e}"))),
                };
                match (action, split_io_frame(&payload, io_channel_id)) {
                    (ironrdp::pdu::Action::X224, Some(frames)) => {
                        let mut all = Vec::new();
                        for frame in frames {
                            all.extend(guarded(|| stage.process(&mut image, action, &frame))?);
                        }
                        all
                    }
                    _ => guarded(|| stage.process(&mut image, action, &payload))?,
                }
            }
            cmd = cmds.recv() => match cmd {
                None | Some(Cmd::Close) => {
                    if closing {
                        return Ok("사용자가 연결을 종료했습니다".into());
                    }
                    closing = true;
                    stage.graceful_shutdown().map_err(session_fail)?
                }
                Some(Cmd::Input { ops }) => {
                    let events = input_events(&mut input, ops);
                    stage.process_fastpath_input(&mut image, &events).map_err(session_fail)?
                }
                Some(Cmd::Resize { width, height, scale }) => {
                    let (w, h) = MonitorLayoutEntry::adjust_display_size(width, height);
                    let scale = scale.and_then(valid_scale);
                    match stage.encode_resize(w, h, scale, None) {
                        Some(frame) => vec![ActiveStageOutput::ResponseFrame(frame.map_err(session_fail)?)],
                        // Display Control is not open (yet): wait for it, from
                        // the first such request on.
                        None => {
                            let since = pending_resize.map_or_else(Instant::now, |p| p.3);
                            pending_resize = Some((w, h, scale, since));
                            Vec::new()
                        }
                    }
                }
                Some(Cmd::Cert { .. }) => Vec::new(),
                Some(Cmd::Ack) => {
                    in_flight = in_flight.saturating_sub(1);
                    last_ack = Instant::now();
                    Vec::new()
                }
                Some(Cmd::Visible { visible: now }) => {
                    if now && !visible {
                        // Whatever changed while hidden: the whole screen once.
                        dirty.add(&full(&image));
                    }
                    visible = now;
                    Vec::new()
                }
            },
            _ = flush.tick() => {
                let mut resize = Vec::new();
                if let Some((w, h, scale, since)) = pending_resize {
                    if let Some(frame) = stage.encode_resize(w, h, scale, None) {
                        pending_resize = None;
                        resize.push(ActiveStageOutput::ResponseFrame(frame.map_err(session_fail)?));
                    } else if since.elapsed() > RESIZE_WAIT {
                        // The server never opened it: no live resize here.
                        pending_resize = None;
                        out.event(json!({ "type": "resizeUnsupported" })).await;
                    }
                }
                // A lost acknowledgement must not freeze the screen for good.
                if in_flight >= MAX_IN_FLIGHT && last_ack.elapsed() > ACK_STALL {
                    in_flight = 0;
                }
                if visible && in_flight < MAX_IN_FLIGHT && out.frame(image.data(), image.width(), image.height(), &dirty.take()).await {
                    if in_flight == 0 {
                        last_ack = Instant::now();
                    }
                    in_flight += 1;
                    last_frame = Instant::now();
                }
                resize
            }
            Some(message) = next_clip(clip_rx) => match clipboard_frame(&mut stage, clip_files.as_deref().expect("clipboard"), &mut pending_files, message)? {
                Some(frame) => vec![ActiveStageOutput::ResponseFrame(frame)],
                None => Vec::new(),
            },
            _ = clip_timer.tick(), if clip_rx.is_some() => {
                let mut out = Vec::new();
                if let Some(frame) = retry_file_copy(&mut stage, &mut pending_files)? {
                    out.push(ActiveStageOutput::ResponseFrame(frame));
                }
                let cliprdr = stage.get_svc_processor_mut::<ironrdp::cliprdr::CliprdrClient>();
                if let Some(Ok(messages)) = cliprdr.map(|c| c.drive_timeouts()) {
                    let frame = stage.process_svc_processor_messages(messages).map_err(session_fail)?;
                    if !frame.is_empty() {
                        out.push(ActiveStageOutput::ResponseFrame(frame));
                    }
                }
                out
            }
        };

        for output in outputs {
            match output {
                ActiveStageOutput::ResponseFrame(frame) => writer
                    .write_all(&frame)
                    .await
                    .map_err(|e| Fail::new("session", format!("전송 오류: {e}")))?,
                ActiveStageOutput::GraphicsUpdate(region) => dirty.add(&region),
                ActiveStageOutput::PointerDefault => out.event(json!({ "type": "pointer", "kind": "default" })).await,
                ActiveStageOutput::PointerHidden => out.event(json!({ "type": "pointer", "kind": "hidden" })).await,
                ActiveStageOutput::PointerBitmap(p) => {
                    out.event(json!({
                        "type": "pointerBitmap",
                        "width": p.width,
                        "height": p.height,
                        "hotX": p.hotspot_x,
                        "hotY": p.hotspot_y,
                        "rgba": base64::engine::general_purpose::STANDARD.encode(&p.bitmap_data),
                    }))
                    .await
                }
                ActiveStageOutput::DeactivateAll => {
                    // Deactivation-Reactivation Sequence (e.g. after a resolution change).
                    let mut activation_seq = activation.create();
                    let mut buf = WriteBuf::new();
                    loop {
                        let written = single_sequence_step_read(&mut reader, &mut activation_seq, &mut buf)
                            .await
                            .map_err(connector_fail)?;
                        if written.size().is_some() {
                            writer
                                .write_all(buf.filled())
                                .await
                                .map_err(|e| Fail::new("session", format!("전송 오류: {e}")))?;
                        }
                        if let ConnectionActivationState::Finalized {
                            desktop_size,
                            share_id,
                            enable_server_pointer,
                            pointer_software_rendering,
                        } = activation_seq.connection_activation_state()
                        {
                            image = DecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
                            stage.set_fastpath_processor(
                                fast_path::ProcessorBuilder {
                                    io_channel_id: activation_seq.io_channel_id(),
                                    user_channel_id: activation_seq.user_channel_id(),
                                    share_id,
                                    enable_server_pointer,
                                    pointer_software_rendering,
                                    bulk_decompressor: None,
                                }
                                .build(),
                            );
                            stage.set_share_id(share_id);
                            stage.set_enable_server_pointer(enable_server_pointer);
                            out.event(json!({
                                "type": "resized",
                                "width": desktop_size.width,
                                "height": desktop_size.height,
                            }))
                            .await;
                            dirty.add(&full(&image));
                            break;
                        }
                    }
                }
                ActiveStageOutput::Terminate(reason) => return Ok(reason.description()),
                _ => {}
            }
        }
        // New pixels, or the page just took the last update: send now instead
        // of on the next 16 ms tick (the tick stays as the fallback).
        if visible && in_flight < MAX_IN_FLIGHT && !dirty.0.is_empty() && last_frame.elapsed() >= MIN_GAP {
            if out.frame(image.data(), image.width(), image.height(), &dirty.take()).await {
                // The stall timer counts from when updates became outstanding.
                if in_flight == 0 {
                    last_ack = Instant::now();
                }
                in_flight += 1;
            }
            last_frame = Instant::now();
        }
    }
}

/// Writes every message to stdout from one thread, whole frames in one call.
fn writer_task(mut rx: mpsc::Receiver<Vec<u8>>) {
    use std::io::Write as _;
    let mut stdout = std::io::stdout().lock();
    while let Some(msg) = rx.blocking_recv() {
        if stdout.write_all(&msg).is_err() || stdout.flush().is_err() {
            break;
        }
    }
}

#[tokio::main]
async fn main() {
    let (tx, rx) = mpsc::channel::<Vec<u8>>(32);
    let writer = tokio::task::spawn_blocking(move || writer_task(rx));
    let out = Out(tx);

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let init: Init = match lines.next_line().await {
        Ok(Some(line)) => match serde_json::from_str(&line) {
            Ok(init) => init,
            Err(e) => {
                out.event(json!({ "type": "error", "kind": "protocol", "message": e.to_string() })).await;
                drop(out);
                let _ = writer.await;
                std::process::exit(2);
            }
        },
        _ => return,
    };

    let (cmd_tx, mut cmds) = mpsc::unbounded_channel::<Cmd>();
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(cmd) = serde_json::from_str::<Cmd>(&line)
                && cmd_tx.send(cmd).is_err() {
                    return;
                }
        }
        // stdin closed: the parent wants us gone.
        let _ = cmd_tx.send(Cmd::Close);
    });

    #[cfg(feature = "selftest")]
    if init.host == "bx-selftest" {
        selftest::run(&init, &out, &mut cmds).await;
        drop(out);
        let _ = writer.await;
        std::process::exit(0);
    }

    let clipboard = if init.clipboard { start_clipboard(&out) } else { None };
    let (factory, mut clip_rx, clip_files) = match clipboard {
        Some(c) => (Some(c.factory), Some(c.messages), Some(c.files)),
        None => (None, None, None),
    };
    let outcome = match connect(&init, &out, &mut cmds, factory.as_ref()).await {
        Ok((result, framed)) => session(framed, result, &out, &mut cmds, &mut clip_rx, clip_files).await,
        Err(fail) => Err(fail),
    };
    match outcome {
        Ok(reason) => out.event(json!({ "type": "closed", "reason": reason })).await,
        Err(fail) => {
            out.event(json!({ "type": "error", "kind": fail.kind, "message": fail.message }))
                .await
        }
    }
    drop(out);
    // The clipboard thread keeps a sender for as long as the process lives, so
    // the writer may never see the channel close: give it a moment to write the
    // last event, then exit. (tokio's stdin reader sits on a blocking thread
    // that the runtime would wait for at shutdown, hence the explicit exit.)
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    fileclip::remove_own_downloads();
    std::process::exit(0);
}

/// Synthetic session for end-to-end tests of the parent's frame and input path:
/// same event sequence as a real connection, a gradient desktop, and a white
/// square painted wherever a mouse-move arrives.
#[cfg(feature = "selftest")]
mod selftest {
    use super::*;

    pub async fn run(init: &Init, out: &Out, cmds: &mut mpsc::UnboundedReceiver<Cmd>) {
        for stage in ["tcp", "tls"] {
            out.status(stage).await;
        }
        out.event(json!({ "type": "cert", "fingerprint": "SHA256:selftest", "previous": Value::Null }))
            .await;
        loop {
            match cmds.recv().await {
                Some(Cmd::Cert { accept: true }) => break,
                Some(Cmd::Cert { accept: false }) | Some(Cmd::Close) | None => return,
                _ => {}
            }
        }
        out.status("auth").await;
        let (w, h) = (even_size(init.width), init.height.clamp(200, 8192));
        let stride = usize::from(w) * 4;
        let mut data = vec![0u8; stride * usize::from(h)];
        out.event(json!({ "type": "connected", "width": w, "height": h })).await;
        // A remote file copy in progress, for the app's progress display.
        out.event(json!({ "type": "clipFiles", "state": "downloading", "done": 31_457_280u64, "total": 62_914_560u64, "files": 3 })).await;
        for y in 0..h {
            for x in 0..w {
                let o = usize::from(y) * stride + usize::from(x) * 4;
                data[o..o + 4].copy_from_slice(&[(x / 8) as u8, (y / 8) as u8, 160, 255]);
            }
        }
        let whole = InclusiveRectangle { left: 0, top: 0, right: w - 1, bottom: h - 1 };
        // Same flow control as a real session: at most MAX_IN_FLIGHT updates
        // until the app acknowledges; held-back areas are merged.
        out.frame(&data, w, h, &[whole.clone()]).await;
        let mut in_flight = 1u32;
        let mut held = Dirty::default();
        let mut inputs = 0usize;
        let mut acks = 0usize;
        let mut visible = true;
        // Updates sent to the app (test hook: none while the tab is hidden).
        let mut sent = 1usize;
        const BENCH_FRAMES: u32 = 300;
        let mut bench_frames = 0u32;
        let mut bench_start: Option<Instant> = None;
        while let Some(cmd) = cmds.recv().await {
            match cmd {
                Cmd::Input { ops } => {
                    inputs += ops.len();
                    // Test hook: the exact input the helper received.
                    {
                        use std::io::Write as _;
                        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(std::env::temp_dir().join("bx-selftest-input.log")) {
                            for op in &ops {
                                let _ = writeln!(f, "{op:?}");
                            }
                        }
                    }
                    for op in ops {
                        if let Op::Move { x, y } = op {
                            let (x1, y1) = ((x + 7).min(w - 1), (y + 7).min(h - 1));
                            for py in y..=y1 {
                                for px in x..=x1 {
                                    let o = usize::from(py) * stride + usize::from(px) * 4;
                                    data[o..o + 4].copy_from_slice(&[255, 255, 255, 255]);
                                }
                            }
                            let r = InclusiveRectangle { left: x, top: y, right: x1, bottom: y1 };
                            if visible && in_flight < MAX_IN_FLIGHT {
                                out.frame(&data, w, h, &[r]).await;
                                in_flight += 1;
                                sent += 1;
                            } else {
                                held.add(&r);
                            }
                        }
                    }
                    out.event(json!({ "type": "selftestInput", "count": inputs })).await;
                }
                Cmd::Ack => {
                    in_flight = in_flight.saturating_sub(1);
                    // Benchmark (user "bench"): full-screen updates as fast as
                    // the app takes them; the rate goes to a file in %TEMP%.
                    if init.username == "bench" {
                        let started = *bench_start.get_or_insert_with(Instant::now);
                        bench_frames += 1;
                        if bench_frames < BENCH_FRAMES {
                            held.add(&whole);
                        } else if bench_frames == BENCH_FRAMES {
                            let secs = started.elapsed().as_secs_f64();
                            let _ = std::fs::write(
                                std::env::temp_dir().join("bx-selftest-bench.log"),
                                format!("{} frames {}x{} in {:.3} s = {:.1} fps
", BENCH_FRAMES, w, h, secs, f64::from(BENCH_FRAMES) / secs),
                            );
                        }
                    }
                    if visible && out.frame(&data, w, h, &held.take()).await {
                        in_flight += 1;
                        sent += 1;
                    }
                    acks += 1;
                    out.event(json!({ "type": "selftestAck", "count": acks, "sent": sent })).await;
                }
                Cmd::Visible { visible: now } => {
                    if now && !visible {
                        held.add(&whole);
                        if in_flight < MAX_IN_FLIGHT && out.frame(&data, w, h, &held.take()).await {
                            in_flight += 1;
                            sent += 1;
                        }
                    }
                    visible = now;
                    {
                        use std::io::Write as _;
                        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(std::env::temp_dir().join("bx-selftest-input.log")) {
                            let _ = writeln!(f, "Visible({visible}) sent={sent}");
                        }
                    }
                    out.event(json!({ "type": "selftestVisible", "visible": visible, "sent": sent })).await;
                }
                Cmd::Close => break,
                _ => {}
            }
        }
        out.event(json!({ "type": "closed", "reason": "selftest finished" })).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The keyboard description comes from Windows, not fixed values.
    #[test]
    fn describes_the_local_keyboard() {
        let k = local_keyboard();
        eprintln!("keyboard: {:?} subtype {} layout {:08X} fkeys {}", k.kind, k.subtype, k.layout, k.function_keys);
        assert_ne!(k.layout, 0, "a real input locale (e.g. 00000412 Korean)");
        assert!(k.function_keys >= 10);
    }

    /// A slow-path Share Data PDU: Share Control header + Share Data header + body.
    fn share_data(pdu_type2: u8, body: &[u8]) -> Vec<u8> {
        let total = (18 + body.len()) as u16;
        let mut v = Vec::new();
        v.extend(total.to_le_bytes());
        v.extend(0x17u16.to_le_bytes()); // PDUTYPE_DATAPDU | version 1
        v.extend(1002u16.to_le_bytes()); // pduSource
        v.extend(0x0001_03EAu32.to_le_bytes()); // shareId
        v.extend([0, 1]); // pad, streamId (low)
        v.extend((body.len() as u16 + 4).to_le_bytes()); // uncompressedLength
        v.extend([pdu_type2, 0]); // pduType2, compressedType
        v.extend(0u16.to_le_bytes()); // compressedLength
        v.extend(body);
        v
    }

    fn mcs_frame(user_data: &[u8]) -> Vec<u8> {
        use ironrdp::pdu::mcs::SendDataIndication;
        use ironrdp::pdu::x224::X224;
        ironrdp::core::encode_vec(&X224(SendDataIndication {
            initiator_id: 1002,
            channel_id: 1003,
            user_data: std::borrow::Cow::Borrowed(user_data),
        }))
        .unwrap()
    }

    fn decode_io(frame: &[u8]) -> ironrdp::pdu::rdp::headers::ShareDataPdu {
        let ctx = ironrdp::pdu::mcs::decode_send_data_indication(frame).unwrap();
        match ironrdp::pdu::rdp::headers::decode_io_channel(ctx).unwrap() {
            ironrdp::pdu::rdp::headers::IoChannelPdu::Data(d) => d.pdu,
            _ => panic!("not a data PDU"),
        }
    }

    /// The real-server crash: a bitmap 8 px wide (padded) for a 6 px wide
    /// rectangle at the image's bottom-right edge. Unpatched IronRDP split rows by
    /// the rectangle width, skewing the picture and indexing past the image end
    /// ("index out of bounds: the len is N but the index is N").
    #[test]
    fn padded_bitmap_lands_inside_its_rectangle() {
        use ironrdp::pdu::bitmap::{BitmapData, BitmapUpdateData, Compression};
        use ironrdp::session::fast_path::ProcessorBuilder;

        let mut processor = ProcessorBuilder {
            io_channel_id: 1003,
            user_channel_id: 1002,
            share_id: 0,
            enable_server_pointer: false,
            pointer_software_rendering: true,
            bulk_decompressor: None,
        }
        .build();
        let mut image = DecodedImage::new(PixelFormat::RgbA32, 16, 8);
        // 24 bpp BGR, bottom-up, 8 px per row: 6 red pixels then 2 blue padding pixels.
        let mut data = Vec::new();
        for _ in 0..4 {
            for col in 0..8 {
                data.extend(if col < 6 { [0, 0, 255] } else { [255, 0, 0] });
            }
        }
        let rect = InclusiveRectangle { left: 10, top: 4, right: 15, bottom: 7 };
        let update = BitmapUpdateData {
            rectangles: vec![BitmapData {
                rectangle: rect.clone(),
                width: 8,
                height: 4,
                bits_per_pixel: 24,
                compression_flags: Compression::empty(),
                compressed_data_header: None,
                bitmap_data: &data,
            }],
        };
        processor.process_bitmap_update(&mut image, update).expect("bitmap applied");

        let px = |x: usize, y: usize| {
            let i = (y * 16 + x) * 4;
            image.data()[i..i + 4].to_vec()
        };
        for y in 4..8 {
            for x in 10..16 {
                assert_eq!(px(x, y), [255, 0, 0, 255], "pixel ({x},{y}) inside the rectangle");
            }
            assert_eq!(px(9, y), [0, 0, 0, 0], "nothing drawn left of the rectangle");
        }
    }

    /// The real-server failure: Set Keyboard Indicators (22 bytes) packed with
    /// more PDUs in one MCS packet made IronRDP fail with "received 22 bytes,
    /// expected 114". Each PDU must decode on its own, and IME status (which
    /// IronRDP's session rejects as unhandled) must be dropped.
    #[test]
    fn splits_packed_slow_path_pdus() {
        use ironrdp::pdu::rdp::headers::ShareDataPdu;
        let mut packed = share_data(0x29, &[0, 0, 2, 0]); // Set Keyboard Indicators
        packed.extend(share_data(0x2D, &[0; 10])); // Set Keyboard IME Status
        packed.extend([0x00, 0x80, 0, 0x42, 0, 0, 0, 0]); // flow PDU
        packed.extend(share_data(0x02, &[1, 2, 3, 4, 5, 6, 7, 8])); // slow-path Update
        let frame = mcs_frame(&packed);
        assert!(ironrdp::pdu::mcs::decode_send_data_indication(&frame)
            .and_then(ironrdp::pdu::rdp::headers::decode_io_channel)
            .is_err(), "IronRDP alone should still fail on the packed frame");

        let frames = split_io_frame(&frame, 1003).expect("packed frame is split");
        assert_eq!(frames.len(), 2);
        assert_eq!(decode_io(&frames[0]), ShareDataPdu::SetKeyboardIndicators(vec![0, 0, 2, 0]));
        assert_eq!(decode_io(&frames[1]), ShareDataPdu::Update(vec![1, 2, 3, 4, 5, 6, 7, 8]));

        // A single ordinary PDU, or another channel, passes through untouched.
        assert!(split_io_frame(&mcs_frame(&share_data(0x02, &[9; 6])), 1003).is_none());
        assert!(split_io_frame(&frame, 1004).is_none());
    }

    #[test]
    fn splits_domain_users() {
        assert_eq!(split_user("CORP\\kim", None), (Some("CORP".into()), "kim".into()));
        assert_eq!(split_user("kim", Some("CORP".into())), (Some("CORP".into()), "kim".into()));
        assert_eq!(split_user("kim@corp.local", None), (None, "kim@corp.local".into()));
    }

    #[test]
    fn strips_source_locations_from_reports() {
        let raw = r"[CredSSP @ C:\x\connector.rs:107] CredSSP, caused by: InvalidToken: bad [x] y";
        assert_eq!(clean_report(raw), "CredSSP, caused by: InvalidToken: bad [x] y");
    }

    /// A tiny CF_DIB image of one colour, put on the clipboard by "another
    /// program" (this test thread), as a screenshot tool does.
    fn put_dib(colour: [u8; 4]) {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
        use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
        let (w, h) = (4i32, 4i32);
        let mut dib = Vec::new();
        {
        let v = 40u32; dib.extend(v.to_le_bytes()); }
        dib.extend(w.to_le_bytes());
        dib.extend(h.to_le_bytes());
        dib.extend(1u16.to_le_bytes());
        dib.extend(32u16.to_le_bytes());
        dib.extend([0u8; 24]); // BI_RGB, sizes, resolution, colours
        for _ in 0..w * h {
            dib.extend(colour);
        }
        unsafe {
            for _ in 0..50 {
                if OpenClipboard(None).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            EmptyClipboard().unwrap();
            let mem = GlobalAlloc(GMEM_MOVEABLE, dib.len()).unwrap();
            let p = GlobalLock(mem) as *mut u8;
            std::ptr::copy_nonoverlapping(dib.as_ptr(), p, dib.len());
            let _ = GlobalUnlock(mem);
            SetClipboardData(8, Some(HANDLE(mem.0))).unwrap();
            CloseClipboard().unwrap();
        }
    }

    /// Next "announce these formats to the server" from the clipboard thread.
    async fn next_copy(rx: &mut mpsc::UnboundedReceiver<ClipboardMessage>) -> Option<Vec<ClipboardFormat>> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(ClipboardMessage::SendInitiateCopy(formats))) => return Some(formats),
                Ok(Some(_)) => continue,
                _ => return None,
            }
        }
    }

    /// Copy an image, let the remote paste it, copy another: every copy must
    /// be announced again with the new data (the remote showed the first
    /// image for every later paste).
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "uses the Windows clipboard; run with --include-ignored"]
    async fn every_new_image_copy_reaches_the_remote() {
        use ironrdp::cliprdr::pdu::FormatDataRequest;
        let (tx, _rx) = mpsc::channel(64);
        let out = Out(tx);
        let mut clip = start_clipboard(&out).expect("clipboard");
        let mut backend = clip.factory.build_cliprdr_backend();
        backend.on_ready();
        while clip.messages.try_recv().is_ok() {}
        let mut seen = Vec::new();
        for (round, colour) in [[0u8, 0, 255, 0], [0, 255, 0, 0], [255, 0, 0, 0]].into_iter().enumerate() {
            std::thread::spawn(move || put_dib(colour)).join().unwrap();
            let formats = next_copy(&mut clip.messages).await;
            assert!(formats.is_some(), "copy #{} was not announced to the remote", round + 1);
            // The remote pastes: it asks for CF_DIB.
            backend.on_format_data_request(FormatDataRequest { format: ClipboardFormatId::CF_DIB });
            let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
            let data = loop {
                match tokio::time::timeout_at(deadline, clip.messages.recv()).await {
                    Ok(Some(ClipboardMessage::SendFormatData(r))) => break r.data().to_vec(),
                    Ok(Some(_)) => continue,
                    _ => panic!("no data for paste #{}", round + 1),
                }
            };
            let pixel = data[40..44].to_vec();
            seen.push(pixel.clone());
            assert_eq!(pixel, colour.to_vec(), "paste #{} got an older image", round + 1);
        }
        println!("pixels pasted: {seen:?}");
    }

    /// What screenshot tools put on the clipboard (seen with EnumClipboardFormats):
    /// a GDI bitmap first, or an OLE data object with its private formats.
    #[test]
    fn offers_images_as_dib_never_as_handles() {
        use ironrdp::cliprdr::pdu::ClipboardFormatName;
        let ids = |v: &[ClipboardFormat]| v.iter().map(|f| f.id().value()).collect::<Vec<_>>();
        let plain = |id: u32| ClipboardFormat::new(ClipboardFormatId::new(id));
        let named = |id: u32, n: &'static str| ClipboardFormat::new(ClipboardFormatId::new(id)).with_name(ClipboardFormatName::new_static(n));
        // PrintScreen / GDI tools: CF_BITMAP, then the synthesized CF_DIB, CF_DIBV5.
        assert_eq!(ids(&transferable(vec![plain(2), plain(8), plain(17)])), [8, 17]);
        // .NET / Qt (Snipaste) through OLE.
        let ole = vec![named(49161, "DataObject"), named(49848, "System.Drawing.Bitmap"), plain(2), named(49171, "Ole Private Data"), plain(8), plain(17), named(49300, "PNG")];
        assert_eq!(ids(&transferable(ole)), [8, 17, 49300]);
        // Only a bitmap handle listed: CF_DIB is offered (Windows renders it).
        assert_eq!(ids(&transferable(vec![plain(2)])), [8]);
        // Text is untouched.
        assert_eq!(ids(&transferable(vec![plain(13), plain(1), plain(16)])), [13, 1, 16]);
    }

    #[test]
    fn coalesces_dirty_regions() {
        let rect = |left, top, right, bottom| InclusiveRectangle { left, top, right, bottom };
        let corners = |d: &Dirty| d.0.iter().map(|r| (r.left, r.top, r.right, r.bottom)).collect::<Vec<_>>();
        let mut d = Dirty::default();
        // Overlapping areas merge.
        d.add(&rect(10, 10, 20, 20));
        d.add(&rect(5, 15, 30, 18));
        assert_eq!(corners(&d), [(5, 10, 30, 20)]);
        // A far-away area (the clock in the opposite corner) stays separate.
        d.add(&rect(1800, 1000, 1900, 1030));
        assert_eq!(d.0.len(), 2);
        // An area bridging both merges everything it touches, transitively.
        d.add(&rect(25, 15, 1805, 1005));
        assert_eq!(corners(&d), [(5, 10, 1900, 1030)]);
        // Too many scattered areas: the closest two merge, the rest stay small
        // (no bounding box over the whole desktop).
        let mut d = Dirty::default();
        for i in 0..MAX_RECTS as u16 {
            d.add(&rect(i * 50, i * 30, i * 50 + 1, i * 30 + 1));
        }
        d.add(&rect(53, 33, 54, 34)); // next to the second one
        assert_eq!(d.0.len(), MAX_RECTS);
        assert!(d.0.iter().all(|r| area(r) <= 10 * 10), "{:?}", corners(&d));
        assert!(d.take().len() == MAX_RECTS && d.0.is_empty());
    }

    #[test]
    fn auto_repeat_sends_plain_key_down() {
        let mut db = Database::new();
        let first = input_events(&mut db, vec![Op::Key { code: 0x1e, ext: false, down: true, repeat: false }]);
        let repeat = input_events(&mut db, vec![Op::Key { code: 0x1e, ext: false, down: true, repeat: true }]);
        assert_eq!(first.len(), 1);
        assert_eq!(repeat.len(), 1);
        assert!(matches!(repeat[0], FastPathInputEvent::KeyboardEvent(f, 0x1e) if !f.contains(KeyboardFlags::RELEASE)));
    }

    #[test]
    fn unicode_typing_emits_press_and_release() {
        let ops: Vec<Op> = serde_json::from_str(r#"[{"t":"unicode","ch":"가","down":true},{"t":"unicode","ch":"가","down":false}]"#).unwrap();
        let events = input_events(&mut Database::new(), ops);
        assert_eq!(events.len(), 2, "unicode press+release should emit two events: {events:?}");
    }

    #[test]
    fn sync_sets_the_server_lock_keys_in_order() {
        // From the page: {"t":"sync","flags":2} = Num Lock on, others off; it
        // goes out before the number pad key that follows it.
        let ops: Vec<Op> = serde_json::from_str(r#"[{"t":"sync","flags":2},{"t":"key","code":79,"ext":false,"down":true}]"#).unwrap();
        let events = input_events(&mut Database::new(), ops);
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], FastPathInputEvent::SyncEvent(f) if f == SynchronizeFlags::NUM_LOCK));
        assert!(matches!(events[1], FastPathInputEvent::KeyboardEvent(_, 79)));
    }
}
