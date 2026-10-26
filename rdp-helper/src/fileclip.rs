//! Copy and paste of files through the RDP clipboard (CLIPRDR file streams),
//! like mstsc. IronRDP's CLIPRDR core speaks the protocol (file lists,
//! FileContents requests, clipboard locks); IronRDP's native Windows backend
//! moves every other format (text, images …) but ignores files. This module
//! wraps that backend and adds files in both directions:
//!
//! - remote → local: when the server announces FileGroupDescriptorW, the file
//!   list is fetched and CF_HDROP goes on the Windows clipboard with delayed
//!   rendering. Pasting (Explorer or any app that takes files) renders it: the
//!   files are downloaded into a private temp folder (already in the
//!   background when small) and their paths handed over. Plain CF_HDROP works
//!   with every consumer; a virtual-file OLE data object did not reach
//!   Explorer reliably across processes.
//! - local → remote: when the local clipboard holds files (CF_HDROP from
//!   Explorer's copy), the file list is announced instead of the raw formats,
//!   and the server's FileContents requests are answered from the files.
//!
//! Threads: the clipboard window lives on the clipboard thread (with the
//! native backend's window and a message loop); CLIPRDR runs in the session
//! loop; downloads run on a worker thread. Requests go to the session loop as
//! backend messages, and replies come back through `State` + `Condvar`.

use std::collections::HashMap;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use ironrdp::cliprdr::backend::{ClipboardMessage, CliprdrBackend, CliprdrBackendFactory};
use ironrdp::cliprdr::pdu::{
    ClipboardFileAttributes, ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsFlags,
    FileContentsRequest, FileContentsResponse, FileDescriptor, FormatDataRequest, FormatDataResponse, LockDataId,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use windows::Win32::Foundation::{CloseHandle, GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, STILL_ACTIVE, WPARAM};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW,
    SetClipboardData,
};
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GMEM_ZEROINIT, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows::Win32::System::Threading::{GetCurrentThreadId, GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Shell::{CFSTR_PREFERREDDROPEFFECT, DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, MSG, PostThreadMessageW, RegisterClassW, TranslateMessage,
    WINDOW_EX_STYLE, WM_APP, WM_DESTROYCLIPBOARD, WM_RENDERALLFORMATS, WM_RENDERFORMAT, WNDCLASSW, WS_POPUP,
};
use windows_core::w;

/// Thread message telling the clipboard thread to put `Shared::offer` on the clipboard.
const WM_FILECLIP: u32 = WM_APP + 0x42;
const CF_HDROP: u32 = 15;
/// Bytes asked from the server per FileContents request.
const CHUNK: u32 = 4 * 1024 * 1024;
/// Remote copies up to this size are downloaded right away, so a paste is instant.
const EAGER_BYTES: u64 = 512 * 1024 * 1024;
/// Local files announced at most (folders are walked recursively).
const MAX_LOCAL_ENTRIES: usize = 20_000;
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const DATA_TIMEOUT: Duration = Duration::from_secs(120);
/// FILETIME of 1970-01-01 (100 ns units since 1601).
const UNIX_EPOCH_FILETIME: u64 = 116_444_736_000_000_000;

struct LocalEntry {
    path: PathBuf,
    size: u64,
    dir: bool,
}

#[derive(Clone, Debug, PartialEq)]
enum Download {
    Idle,
    Running,
    Done,
    Failed(String),
}

#[derive(Default)]
struct State {
    /// Bumped on every remote copy; downloads stop when it moves on.
    generation: u64,
    remote_format: Option<ClipboardFormatId>,
    /// None: not fetched yet; Some(Err): the server could not give it.
    remote_files: Option<Result<Vec<FileDescriptor>, ()>>,
    list_requested: bool,
    clip_data_id: Option<u32>,
    /// FileContents responses by stream id (None = error response).
    responses: HashMap<u32, Option<Vec<u8>>>,
    /// Download of the current remote copy, and where it goes.
    download: Option<Download>,
    folder: Option<PathBuf>,
    /// Files we announced to the server, by list index.
    local: Vec<LocalEntry>,
}

pub struct Shared {
    to_session: mpsc::UnboundedSender<ClipboardMessage>,
    events: mpsc::UnboundedSender<Value>,
    state: Mutex<State>,
    changed: Condvar,
    next_stream: AtomicU32,
    /// Clipboard sequence number right after we put remote files on the clipboard.
    own_sequence: AtomicU32,
    sta_thread: AtomicU32,
    /// Generation whose files should go on the clipboard next (clipboard thread).
    offer: AtomicUsize,
    /// How far the channel start-up got (CLIP_* below).
    stage: AtomicU32,
}

/// Clipboard channel start-up ([MS-RDPECLIP] 1.3.2.1): the server sends its
/// capabilities, then Monitor Ready once its clipboard program (rdpclip.exe)
/// runs; the client answers with its capabilities and format list, and the
/// server's Format List Response makes the channel ready.
const CLIP_WAITING: u32 = 0;
const CLIP_CAPABILITIES: u32 = 1;
const CLIP_MONITOR_READY: u32 = 2;
const CLIP_READY: u32 = 3;

impl core::fmt::Debug for Shared {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("fileclip::Shared")
    }
}

/// Root of the downloads (one folder per remote copy).
fn temp_root() -> PathBuf {
    std::env::temp_dir().join("BananaConn").join("rdp-clipboard")
}

/// Download folders are named `<helper pid>-<generation>`.
fn download_owner(name: &str) -> Option<u32> {
    let (pid, generation) = name.split_once('-')?;
    generation.parse::<u64>().ok()?;
    pid.parse().ok()
}

fn remove_downloads(of: impl Fn(u32) -> bool) {
    let Ok(dirs) = std::fs::read_dir(temp_root()) else { return };
    for dir in dirs.flatten() {
        if download_owner(&dir.file_name().to_string_lossy()).is_some_and(&of) {
            let _ = std::fs::remove_dir_all(dir.path());
        }
    }
}

/// Removes this helper's downloads: a paste copies the files away at once,
/// so nothing needs them once the session (and the helper) ends.
pub fn remove_own_downloads() {
    let own = std::process::id();
    remove_downloads(|pid| pid == own);
}

/// Removes downloads left by helpers that did not get to clean up (killed
/// with the app, crashed). Other running helpers keep theirs.
pub fn remove_stale_downloads() {
    let own = std::process::id();
    remove_downloads(|pid| pid != own && !process_alive(pid));
}

/// False only when `pid` surely names no running process (a reused pid keeps
/// a folder until a later start, which is harmless).
fn process_alive(pid: u32) -> bool {
    // SAFETY: plain process query; the handle is closed right after.
    match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(handle) => {
            let mut code = 0u32;
            // SAFETY: valid handle and out pointer.
            let known = unsafe { GetExitCodeProcess(handle, &mut code) }.is_ok();
            // SAFETY: the handle came from OpenProcess above.
            let _ = unsafe { CloseHandle(handle) };
            !known || code == STILL_ACTIVE.0 as u32
        }
        // ERROR_INVALID_PARAMETER: no such process. Anything else (access
        // denied) means it exists.
        Err(e) => e.code() != windows_core::HRESULT::from_win32(87),
    }
}

/// True for a remote name part that is one plain component below the
/// download folder. Path::join alone does not keep it there: Windows reads
/// `C:x` relative to drive C's current folder, `/` as a separator, `a:b` as
/// an alternate data stream, and device names (NUL, COM1.txt …) as devices,
/// and it drops trailing dots and spaces ("... " becomes "..").
fn safe_component(part: &str) -> bool {
    if part.is_empty()
        || part.ends_with(['.', ' '])
        || part.chars().any(|c| c.is_control() || matches!(c, ':' | '/' | '\\' | '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return false;
    }
    let mut components = Path::new(part).components();
    if !matches!((components.next(), components.next()), (Some(std::path::Component::Normal(_)), None)) {
        return false;
    }
    !is_device_name(part)
}

/// Windows device names, which stay devices with any extension ("NUL.txt")
/// or spaces before it ("NUL .txt").
fn is_device_name(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or(part).trim_end_matches(' ').to_ascii_uppercase();
    match stem.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" => true,
        s if s.starts_with("COM") || s.starts_with("LPT") => {
            matches!(&s[3..], "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
        }
        _ => false,
    }
}

/// `rel` (backslash-separated, as the server sends it) below `folder`, or
/// None when any part of it is not a plain name.
fn resolve_below(folder: &Path, rel: &str) -> Option<PathBuf> {
    let mut path = folder.to_path_buf();
    for part in rel.split('\\') {
        if !safe_component(part) {
            return None;
        }
        path.push(part);
    }
    Some(path)
}

/// True when the existing `path` really lies inside `folder` (after links).
fn stays_inside(folder: &Path, path: &Path) -> bool {
    match (folder.canonicalize(), path.canonicalize()) {
        (Ok(folder), Ok(path)) => path.starts_with(folder),
        _ => false,
    }
}

impl Shared {
    pub fn new(to_session: mpsc::UnboundedSender<ClipboardMessage>, events: mpsc::UnboundedSender<Value>) -> Arc<Self> {
        Arc::new(Self {
            to_session,
            events,
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            next_stream: AtomicU32::new(1),
            own_sequence: AtomicU32::new(0),
            sta_thread: AtomicU32::new(0),
            offer: AtomicUsize::new(0),
            stage: AtomicU32::new(CLIP_WAITING),
        })
    }

    /// One step of the clipboard channel, for the app's clipboard status and
    /// its diagnostic log.
    pub fn trace(&self, state: &str, detail: impl Into<String>) {
        self.report(json!({ "type": "clipboard", "state": state, "detail": detail.into() }));
    }

    /// The server sent Monitor Ready: a format list may go out now. Before
    /// that its clipboard program may not even run yet (Windows 7 starts it a
    /// few seconds after the logon) and would never see it.
    pub fn server_ready_for_copies(&self) -> bool {
        self.stage.load(Ordering::SeqCst) >= CLIP_MONITOR_READY
    }

    fn advance(&self, stage: u32) {
        self.stage.fetch_max(stage, Ordering::SeqCst);
    }

    fn send(&self, message: ClipboardMessage) -> bool {
        self.to_session.send(message).is_ok()
    }

    fn report(&self, event: Value) {
        let _ = self.events.send(event);
    }

    /// Wait until `ready` yields a value (or the timeout passes).
    fn wait<T>(&self, timeout: Duration, mut ready: impl FnMut(&mut State) -> Option<T>) -> Option<T> {
        let deadline = Instant::now() + timeout;
        let mut st = self.state.lock().unwrap();
        loop {
            if let Some(v) = ready(&mut st) {
                return Some(v);
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            st = self.changed.wait_timeout(st, left).unwrap().0;
        }
    }

    // ---- remote → local ---------------------------------------------------------------

    /// The remote copied files. A worker fetches the list (the session loop
    /// must stay free to receive it), puts CF_HDROP on the clipboard through
    /// the clipboard thread, and downloads small copies right away.
    fn remote_copied(self: &Arc<Self>, format: ClipboardFormatId) {
        let generation = {
            let mut st = self.state.lock().unwrap();
            st.generation += 1;
            st.remote_format = Some(format);
            st.remote_files = None;
            st.list_requested = false;
            st.clip_data_id = None;
            st.download = Some(Download::Idle);
            st.folder = None;
            st.generation
        };
        self.changed.notify_all();
        let shared = self.clone();
        std::thread::spawn(move || {
            let Some(files) = shared.remote_list(generation) else { return };
            shared.offer.store(generation as usize, Ordering::SeqCst);
            let thread = shared.sta_thread.load(Ordering::SeqCst);
            // SAFETY: plain thread message; the clipboard thread's loop picks it up.
            let _ = unsafe { PostThreadMessageW(thread, WM_FILECLIP, WPARAM(0), LPARAM(0)) };
            let total: u64 = files.iter().filter_map(|f| f.file_size).sum();
            if total <= EAGER_BYTES {
                shared.ensure_download(generation);
            }
        });
    }

    /// The file list for `generation`, fetched from the server on first use.
    fn remote_list(&self, generation: u64) -> Option<Vec<FileDescriptor>> {
        let request = {
            let mut st = self.state.lock().unwrap();
            if st.generation != generation {
                return None;
            }
            match &st.remote_files {
                Some(Ok(files)) => return Some(files.clone()),
                Some(Err(())) => return None,
                None => {}
            }
            let first = !st.list_requested;
            st.list_requested = true;
            first.then_some(st.remote_format).flatten()
        };
        if let Some(format) = request {
            self.send(ClipboardMessage::SendInitiatePaste(format));
        }
        self.wait(LIST_TIMEOUT, |st| {
            if st.generation != generation {
                return Some(None);
            }
            match &st.remote_files {
                Some(Ok(files)) => Some(Some(files.clone())),
                Some(Err(())) => Some(None),
                None => None,
            }
        })
        .flatten()
    }

    /// One FileContents request; the reply's bytes, or None on error/timeout.
    fn request_contents(&self, index: usize, flags: FileContentsFlags, position: u64, size: u32) -> Option<Vec<u8>> {
        let stream_id = self.next_stream.fetch_add(1, Ordering::SeqCst);
        let data_id = self.state.lock().unwrap().clip_data_id;
        let request = FileContentsRequest {
            stream_id,
            index: i32::try_from(index).ok()?,
            flags,
            position,
            requested_size: size,
            data_id,
        };
        if !self.send(ClipboardMessage::SendFileContentsRequest(request)) {
            return None;
        }
        self.wait(DATA_TIMEOUT, |st| st.responses.remove(&stream_id)).flatten()
    }

    /// Start downloading `generation` unless that already happened.
    fn ensure_download(self: &Arc<Self>, generation: u64) {
        {
            let mut st = self.state.lock().unwrap();
            if st.generation != generation || st.download != Some(Download::Idle) {
                return;
            }
            st.download = Some(Download::Running);
        }
        let shared = self.clone();
        std::thread::spawn(move || {
            let result = shared.download(generation);
            let mut st = shared.state.lock().unwrap();
            if st.generation == generation {
                match result {
                    Ok(folder) => {
                        st.folder = Some(folder);
                        st.download = Some(Download::Done);
                    }
                    Err(e) => st.download = Some(Download::Failed(e)),
                }
            }
            drop(st);
            shared.changed.notify_all();
        });
    }

    /// Download every file of `generation` into a fresh folder; returns it.
    fn download(&self, generation: u64) -> Result<PathBuf, String> {
        let files = self.remote_list(generation).ok_or("원격 파일 목록을 받지 못했습니다")?;
        // Earlier copies of this session are done with (a paste copies them away at once).
        remove_own_downloads();
        let folder = temp_root().join(format!("{}-{generation}", std::process::id()));
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let total: u64 = files.iter().filter_map(|f| f.file_size).sum();
        let mut done = 0u64;
        let mut last = Instant::now();
        self.report(json!({ "type": "clipFiles", "state": "downloading", "done": 0, "total": total, "files": files.len() }));
        for (index, f) in files.iter().enumerate() {
            let rel = match &f.relative_path {
                Some(p) if !p.is_empty() => format!("{p}\\{}", f.name),
                _ => f.name.clone(),
            };
            // Names come from the remote PC: anything that is not a plain name
            // below the folder is skipped.
            let Some(path) = resolve_below(&folder, &rel) else { continue };
            if f.attributes.is_some_and(|a| a.contains(ClipboardFileAttributes::DIRECTORY)) {
                std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
                continue;
            }
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                if !stays_inside(&folder, dir) {
                    continue;
                }
            }
            let size = match f.file_size {
                Some(s) => s,
                None => {
                    let data = self.request_contents(index, FileContentsFlags::SIZE, 0, 8).ok_or("파일 크기를 받지 못했습니다")?;
                    u64::from_le_bytes(data.get(..8).and_then(|b| b.try_into().ok()).ok_or("파일 크기가 올바르지 않습니다")?)
                }
            };
            let mut out = std::fs::File::create(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let mut pos = 0u64;
            while pos < size {
                if self.state.lock().unwrap().generation != generation {
                    return Err("원격에서 다른 내용을 복사했습니다".into());
                }
                let want = (size - pos).min(u64::from(CHUNK)) as u32;
                let data = self
                    .request_contents(index, FileContentsFlags::RANGE, pos, want)
                    .filter(|d| !d.is_empty())
                    .ok_or_else(|| format!("{} 을(를) 받는 중 연결이 끊어졌습니다", f.name))?;
                out.write_all(&data).map_err(|e| e.to_string())?;
                pos += data.len() as u64;
                done += data.len() as u64;
                if last.elapsed() > Duration::from_millis(300) {
                    last = Instant::now();
                    self.report(json!({ "type": "clipFiles", "state": "downloading", "done": done, "total": total, "files": files.len() }));
                }
            }
        }
        self.report(json!({ "type": "clipFiles", "state": "ready", "done": done, "total": total, "files": files.len() }));
        Ok(folder)
    }

    /// Wait for the download of `generation` (starting it if needed); the
    /// top-level paths to hand to the paste.
    fn downloaded_roots(self: &Arc<Self>, generation: u64) -> Option<Vec<PathBuf>> {
        self.ensure_download(generation);
        let (folder, files) = self.wait(Duration::from_secs(24 * 3600), |st| {
            if st.generation != generation {
                return Some(None);
            }
            match &st.download {
                Some(Download::Done) => Some(st.folder.clone().zip(st.remote_files.clone().and_then(Result::ok))),
                Some(Download::Failed(_)) => Some(None),
                _ => None,
            }
        })??;
        let mut roots: Vec<PathBuf> = Vec::new();
        for f in &files {
            let top = match &f.relative_path {
                Some(p) if !p.is_empty() => p.split('\\').next().unwrap_or(&f.name).to_string(),
                _ => f.name.clone(),
            };
            let Some(path) = resolve_below(&folder, &top) else { continue };
            if !roots.contains(&path) && path.exists() && stays_inside(&folder, &path) {
                roots.push(path);
            }
        }
        Some(roots)
    }

    // ---- local → remote ----------------------------------------------------------------

    /// True when the local clipboard still holds the remote files we offered
    /// (no need to announce them back to the server).
    pub fn is_own_clipboard(&self) -> bool {
        let own = self.own_sequence.load(Ordering::SeqCst);
        // SAFETY: no preconditions.
        own != 0 && own == unsafe { GetClipboardSequenceNumber() }
    }

    /// Files on the local clipboard, as the list to announce; None when there are none.
    pub fn local_copy(&self, formats: &[ClipboardFormat]) -> Option<Vec<FileDescriptor>> {
        if !formats.iter().any(|f| f.id() == ClipboardFormatId::CF_HDROP) {
            return None;
        }
        let roots = read_hdrop()?;
        // Files we downloaded from the remote and put there ourselves.
        if roots.iter().all(|p| p.starts_with(temp_root())) {
            return None;
        }
        let mut entries = Vec::new();
        let mut files = Vec::new();
        for root in roots {
            collect(&root, None, &mut entries, &mut files);
        }
        if files.is_empty() {
            return None;
        }
        self.state.lock().unwrap().local = entries;
        Some(files)
    }

    fn answer_local(&self, request: &FileContentsRequest) -> FileContentsResponse<'static> {
        let st = self.state.lock().unwrap();
        let entry = usize::try_from(request.index).ok().and_then(|i| st.local.get(i));
        let Some(entry) = entry.filter(|e| !e.dir) else { return FileContentsResponse::new_error(request.stream_id) };
        if request.flags.contains(FileContentsFlags::SIZE) {
            return FileContentsResponse::new_size_response(request.stream_id, entry.size);
        }
        let limit = request.requested_size.min(8 * 1024 * 1024);
        let read = || -> std::io::Result<Vec<u8>> {
            let mut f = std::fs::File::open(&entry.path)?;
            f.seek(SeekFrom::Start(request.position))?;
            let mut buf = Vec::with_capacity(limit as usize);
            f.take(u64::from(limit)).read_to_end(&mut buf)?;
            Ok(buf)
        };
        match read() {
            Ok(data) => FileContentsResponse::new_data_response(request.stream_id, data),
            Err(_) => FileContentsResponse::new_error(request.stream_id),
        }
    }
}

/// Paths of the files/folders Explorer put on the clipboard (CF_HDROP).
fn read_hdrop() -> Option<Vec<PathBuf>> {
    // SAFETY: standard clipboard read; the clipboard is closed on every path.
    unsafe {
        let mut opened = false;
        for _ in 0..10 {
            if OpenClipboard(None).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if !opened {
            return None;
        }
        let paths = (|| {
            let handle = GetClipboardData(CF_HDROP).ok()?;
            let drop = HDROP(handle.0);
            let count = DragQueryFileW(drop, u32::MAX, None);
            let mut out = Vec::new();
            for i in 0..count {
                let len = DragQueryFileW(drop, i, None) as usize;
                let mut buf = vec![0u16; len + 1];
                let n = DragQueryFileW(drop, i, Some(&mut buf)) as usize;
                out.push(PathBuf::from(String::from_utf16_lossy(&buf[..n])));
            }
            Some(out)
        })();
        let _ = CloseClipboard();
        paths
    }
}

fn filetime_of(meta: &std::fs::Metadata) -> Option<u64> {
    let since = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(UNIX_EPOCH_FILETIME + since.as_nanos() as u64 / 100)
}

/// Add `path` (and a folder's contents) to the list; `parent` is its relative folder.
fn collect(path: &Path, parent: Option<&str>, entries: &mut Vec<LocalEntry>, files: &mut Vec<FileDescriptor>) {
    if entries.len() >= MAX_LOCAL_ENTRIES {
        return;
    }
    // Never follow links/junctions out of what was copied.
    let Ok(meta) = std::fs::symlink_metadata(path) else { return };
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else { return };
    let mut d = FileDescriptor::new(name.clone());
    if let Some(p) = parent {
        d = d.with_relative_path(p);
    }
    if let Some(t) = filetime_of(&meta) {
        d = d.with_last_write_time(t);
    }
    if meta.is_dir() {
        files.push(d.with_attributes(ClipboardFileAttributes::DIRECTORY));
        entries.push(LocalEntry { path: path.to_path_buf(), size: 0, dir: true });
        let here = match parent {
            Some(p) => format!("{p}\\{name}"),
            None => name,
        };
        let Ok(children) = std::fs::read_dir(path) else { return };
        let mut children: Vec<_> = children.flatten().map(|c| c.path()).collect();
        children.sort();
        for child in children {
            collect(&child, Some(&here), entries, files);
        }
    } else if meta.is_file() {
        files.push(d.with_attributes(ClipboardFileAttributes::ARCHIVE).with_file_size(meta.len()));
        entries.push(LocalEntry { path: path.to_path_buf(), size: meta.len(), dir: false });
    }
}

// ---- the CLIPRDR backend wrapper -------------------------------------------------------------

#[derive(Debug)]
pub struct FileClipBackend {
    inner: Box<dyn CliprdrBackend>,
    shared: Arc<Shared>,
}

impl ironrdp::core::AsAny for FileClipBackend {
    fn as_any(&self) -> &dyn core::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn core::any::Any {
        self
    }
}

impl CliprdrBackend for FileClipBackend {
    fn temporary_directory(&self) -> &str {
        self.inner.temporary_directory()
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        self.inner.client_capabilities()
            | ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
            | ClipboardGeneralCapabilityFlags::FILECLIP_NO_FILE_PATHS
            | ClipboardGeneralCapabilityFlags::CAN_LOCK_CLIPDATA
            | ClipboardGeneralCapabilityFlags::HUGE_FILE_SUPPORT_ENABLED
    }

    fn on_ready(&mut self) {
        self.shared.advance(CLIP_READY);
        self.shared.trace("ready", "the server accepted our format list");
        self.inner.on_ready()
    }

    fn on_request_format_list(&mut self) {
        // Monitor Ready: the local clipboard is announced now (the native
        // backend answers with the current formats).
        self.shared.advance(CLIP_MONITOR_READY);
        self.shared.trace("monitorReady", "the server's clipboard program is running");
        self.inner.on_request_format_list()
    }

    fn on_format_list_response(&mut self, ok: bool) {
        if !ok {
            self.shared.trace("rejected", "the server refused our format list");
        }
        self.inner.on_format_list_response(ok)
    }

    fn on_process_negotiated_capabilities(&mut self, capabilities: ClipboardGeneralCapabilityFlags) {
        self.shared.advance(CLIP_CAPABILITIES);
        self.shared.trace("capabilities", format!("negotiated {capabilities:?}"));
        self.inner.on_process_negotiated_capabilities(capabilities)
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        let files = available_formats
            .iter()
            .find(|f| f.name().is_some_and(|n| n.value().eq_ignore_ascii_case("FileGroupDescriptorW")));
        match files {
            Some(format) => self.shared.remote_copied(format.id()),
            None => self.inner.on_remote_copy(available_formats),
        }
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        self.shared.trace("pasteRequest", format!("the remote asks for format {}", request.format.value()));
        self.inner.on_format_data_request(request)
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        {
            // Our file list request failed (a successful one arrives as on_remote_file_list).
            let mut st = self.shared.state.lock().unwrap();
            if st.list_requested && st.remote_files.is_none() && response.is_error() {
                st.remote_files = Some(Err(()));
                drop(st);
                self.shared.changed.notify_all();
                return;
            }
        }
        self.inner.on_format_data_response(response)
    }

    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        let response = self.shared.answer_local(&request);
        self.shared.send(ClipboardMessage::SendFileContentsResponse(response));
    }

    fn on_file_contents_response(&mut self, response: FileContentsResponse<'_>) {
        let data = (!response.is_error()).then(|| response.data().to_vec());
        self.shared.state.lock().unwrap().responses.insert(response.stream_id(), data);
        self.shared.changed.notify_all();
    }

    // Locks only matter for file streams, which the native backend does not do.
    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}

    fn on_remote_file_list(&mut self, files: &[FileDescriptor], clip_data_id: Option<u32>) {
        let mut st = self.shared.state.lock().unwrap();
        st.remote_files = Some(Ok(files.to_vec()));
        st.clip_data_id = clip_data_id;
        drop(st);
        self.shared.changed.notify_all();
    }
}

pub struct FileClipFactory {
    pub inner: Box<dyn CliprdrBackendFactory + Send>,
    pub shared: Arc<Shared>,
}

impl CliprdrBackendFactory for FileClipFactory {
    fn build_cliprdr_backend(&self) -> Box<dyn CliprdrBackend> {
        Box::new(FileClipBackend { inner: self.inner.build_cliprdr_backend(), shared: self.shared.clone() })
    }
}

// ---- clipboard thread: delayed CF_HDROP ------------------------------------------------------

/// The shared state the clipboard window works for (one session per process).
static WINDOW_SHARED: OnceLock<Arc<Shared>> = OnceLock::new();
/// Generation whose CF_HDROP is on the clipboard (rendered on paste).
static OFFERED: AtomicUsize = AtomicUsize::new(0);

/// Prepare the current thread as the clipboard thread: our window, and the
/// thread id for our messages. Call before creating the native backend.
pub fn init_thread(shared: &Arc<Shared>) -> Option<HWND> {
    // SAFETY: no preconditions.
    shared.sta_thread.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
    let _ = WINDOW_SHARED.set(shared.clone());
    // SAFETY: register a private class and create a hidden window on this thread.
    unsafe {
        let class = WNDCLASSW { lpfnWndProc: Some(window_proc), lpszClassName: w!("BananaConnRdpFiles"), ..Default::default() };
        RegisterClassW(&class);
        CreateWindowExW(WINDOW_EX_STYLE::default(), w!("BananaConnRdpFiles"), None, WS_POPUP, 0, 0, 0, 0, None, None, None, None).ok()
    }
}

/// IronRDP's native clipboard announces a local copy to the server only while
/// its monitor window is inactive (it was made for clients whose RDP window
/// is that window), and it starts out "active". Here the window is hidden and
/// never activated or deactivated, so without this no copy made after
/// connecting would ever reach the remote (only what the clipboard held at
/// connect time, which the server asks for). Call on the clipboard thread
/// after creating the WinClipboard.
pub fn mark_native_window_inactive() {
    use windows_core::BOOL;
    use windows::Win32::UI::WindowsAndMessaging::{EnumThreadWindows, GetClassNameW, SendMessageW, WA_INACTIVE, WM_ACTIVATE};
    unsafe extern "system" fn each(window: HWND, _: LPARAM) -> BOOL {
        let mut name = [0u16; 64];
        // SAFETY: a valid window of this thread and a writable buffer.
        let n = unsafe { GetClassNameW(window, &mut name) } as usize;
        if String::from_utf16_lossy(&name[..n]) == "IronRDPClipboardMonitor" {
            // SAFETY: a window of this thread; handled synchronously by its subclass.
            unsafe { SendMessageW(window, WM_ACTIVATE, Some(WPARAM(WA_INACTIVE as usize)), Some(LPARAM(0))) };
        }
        BOOL(1)
    }
    // SAFETY: enumerates this thread's own windows.
    let _ = unsafe { EnumThreadWindows(GetCurrentThreadId(), Some(each), LPARAM(0)) };
}

/// The clipboard thread's message loop (also runs our offers). Never returns
/// while the process lives.
pub fn run_message_loop(shared: &Arc<Shared>, window: Option<HWND>) {
    // SAFETY: plain Win32 message loop on this thread.
    unsafe {
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.hwnd == HWND::default() && msg.message == WM_FILECLIP {
                if let Some(window) = window {
                    offer_remote_files(shared, window);
                }
                continue;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn hglobal(bytes: &[u8]) -> Option<HGLOBAL> {
    // SAFETY: allocate, copy into the locked block, unlock.
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len().max(1)).ok()?;
        let p = GlobalLock(h);
        if p.is_null() {
            let _ = GlobalFree(Some(h));
            return None;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p.cast::<u8>(), bytes.len());
        let _ = GlobalUnlock(h);
        Some(h)
    }
}

/// DROPFILES header + double-NUL terminated UTF-16 paths (the CF_HDROP layout).
pub(crate) fn dropfiles(paths: &[PathBuf]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&20u32.to_le_bytes()); // pFiles: offset of the list
    out.extend_from_slice(&[0u8; 8]); // pt
    out.extend_from_slice(&0u32.to_le_bytes()); // fNC
    out.extend_from_slice(&1u32.to_le_bytes()); // fWide
    for p in paths {
        for unit in p.as_os_str().to_string_lossy().encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out.extend_from_slice(&[0, 0]);
    }
    out.extend_from_slice(&[0, 0]);
    out
}

/// Put the current remote files on the clipboard: CF_HDROP delay-rendered,
/// Preferred DropEffect = copy.
fn offer_remote_files(shared: &Arc<Shared>, window: HWND) {
    let generation = shared.offer.load(Ordering::SeqCst);
    // SAFETY: clipboard calls on the thread that owns `window`.
    unsafe {
        if OpenClipboard(Some(window)).is_err() {
            return;
        }
        let _ = EmptyClipboard();
        let _ = SetClipboardData(CF_HDROP, None);
        if let Some(h) = hglobal(&1u32.to_le_bytes()) {
            let effect = RegisterClipboardFormatW(CFSTR_PREFERREDDROPEFFECT);
            if SetClipboardData(effect, Some(HANDLE(h.0))).is_err() {
                let _ = GlobalFree(Some(h));
            }
        }
        let _ = CloseClipboard();
        OFFERED.store(generation, Ordering::SeqCst);
        shared.own_sequence.store(GetClipboardSequenceNumber(), Ordering::SeqCst);
    }
}

unsafe extern "system" fn window_proc(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        // A paste wants the files: download (or wait for the running download), then hand them over.
        WM_RENDERFORMAT if wparam.0 as u32 == CF_HDROP => {
            if let Some(shared) = WINDOW_SHARED.get() {
                let generation = OFFERED.load(Ordering::SeqCst) as u64;
                match shared.downloaded_roots(generation) {
                    Some(roots) if !roots.is_empty() => {
                        if let Some(h) = hglobal(&dropfiles(&roots)) {
                            // SAFETY: during WM_RENDERFORMAT the clipboard is open for us.
                            if unsafe { SetClipboardData(CF_HDROP, Some(HANDLE(h.0))) }.is_err() {
                                // SAFETY: the system did not take the block.
                                let _ = unsafe { GlobalFree(Some(h)) };
                            }
                        }
                    }
                    _ => {
                        let reason = match &shared.state.lock().unwrap().download {
                            Some(Download::Failed(e)) => e.clone(),
                            _ => "원격 파일을 받지 못했습니다".into(),
                        };
                        shared.report(json!({ "type": "clipFiles", "state": "failed", "message": reason }));
                    }
                }
            }
            LRESULT(0)
        }
        // Leaving the clipboard (we exit): nothing to render then.
        WM_RENDERALLFORMATS | WM_DESTROYCLIPBOARD => LRESULT(0),
        // SAFETY: default handling.
        _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp::cliprdr::pdu::ClipboardFormatName;

    /// Stand-in for the native backend (only files matter here).
    #[derive(Debug)]
    struct Noop;
    impl ironrdp::core::AsAny for Noop {
        fn as_any(&self) -> &dyn core::any::Any {
            self
        }
        fn as_any_mut(&mut self) -> &mut dyn core::any::Any {
            self
        }
    }
    impl CliprdrBackend for Noop {
        fn temporary_directory(&self) -> &str {
            ""
        }
        fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
            ClipboardGeneralCapabilityFlags::empty()
        }
        fn on_ready(&mut self) {}
        fn on_request_format_list(&mut self) {}
        fn on_process_negotiated_capabilities(&mut self, _: ClipboardGeneralCapabilityFlags) {}
        fn on_remote_copy(&mut self, _: &[ClipboardFormat]) {}
        fn on_format_data_request(&mut self, _: FormatDataRequest) {}
        fn on_format_data_response(&mut self, _: FormatDataResponse<'_>) {}
        fn on_file_contents_request(&mut self, _: FileContentsRequest) {}
        fn on_file_contents_response(&mut self, _: FileContentsResponse<'_>) {}
        fn on_lock(&mut self, _: LockDataId) {}
        fn on_unlock(&mut self, _: LockDataId) {}
    }

    /// Files on the local clipboard when a session connects: the first copy
    /// comes before the channel is ready. A file list is refused then (that
    /// error used to end the whole session), and the start-up copy the helper
    /// sends instead (an empty format list) must still go out.
    #[test]
    fn file_copy_before_clipboard_start_up_waits_instead_of_failing() {
        let mut client = ironrdp::cliprdr::CliprdrClient::new(Box::new(Noop));
        let files = vec![FileDescriptor::new("a.txt").with_attributes(ClipboardFileAttributes::ARCHIVE).with_file_size(1)];
        let err = client.initiate_file_copy(files).err().expect("a file list is refused before start-up");
        assert!(crate::not_ready(&err), "{err}");
        assert!(client.initiate_copy(&[]).is_ok(), "the start-up copy goes out");
    }

    /// Remote file names that Path::join would take out of the download
    /// folder (drive-relative, separators, streams, devices) are refused.
    #[test]
    fn remote_names_stay_in_the_download_folder() {
        let folder = Path::new(r"C:\Temp\BananaConn\rdp-clipboard\1-1");
        assert_eq!(resolve_below(folder, r"logs\a.txt"), Some(folder.join("logs").join("a.txt")));
        assert_eq!(resolve_below(folder, "보고서 v1.2.txt"), Some(folder.join("보고서 v1.2.txt")));
        for bad in [
            r"C:evil.dll", r"C:\evil.dll", "a/../../evil.dll", "/evil.dll", r"..\evil.dll", r"a\..\..\b", r"\\server\share\x",
            "file.txt:stream", "", r"a\\b", "...", "x. ", "NUL", "nul.txt", "COM1", "com9.log", "LPT¹", "CON .txt", "CONOUT$",
            "a?b", "a\u{1}b",
        ] {
            assert_eq!(resolve_below(folder, bad), None, "{bad:?}");
        }
        assert!(!is_device_name("COM10") && !is_device_name("CONSOLE.txt") && !is_device_name("NULL"));
    }

    #[test]
    fn download_folders_are_matched_by_owner() {
        assert_eq!(download_owner("1234-7"), Some(1234));
        assert_eq!(download_owner("1234-x"), None);
        assert_eq!(download_owner("notes"), None);
        assert!(process_alive(std::process::id()));
    }

    /// The clipboard channel is declared like mstsc and FreeRDP declare it
    /// (vendor/ironrdp-svc): Windows 7 starts its clipboard only then.
    #[test]
    fn clipboard_channel_is_declared_like_mstsc() {
        let channel = ironrdp::svc::StaticVirtualChannel::new(ironrdp::cliprdr::CliprdrClient::new(Box::new(Noop)));
        let def = ironrdp::svc::make_channel_definition(&channel);
        assert_eq!(def.name.as_str(), Some("cliprdr"));
        assert_eq!(def.options.bits(), 0xC0A0_0000, "INITIALIZED | ENCRYPT_RDP | COMPRESS_RDP | SHOW_PROTOCOL");
    }

    /// The start-up as a server runs it: capabilities, then Monitor Ready once
    /// its clipboard program runs (Windows 7: seconds after the logon), then
    /// the Format List Response. Local copies may go out only from Monitor
    /// Ready on, and every step reaches the app's clipboard status.
    #[test]
    fn local_copies_wait_for_monitor_ready() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let (events_tx, mut events) = mpsc::unbounded_channel::<Value>();
        let shared = Shared::new(tx, events_tx);
        let mut backend = FileClipBackend { inner: Box::new(Noop), shared: shared.clone() };
        assert!(!shared.server_ready_for_copies(), "nothing from the server yet");
        backend.on_process_negotiated_capabilities(ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES);
        assert!(!shared.server_ready_for_copies(), "capabilities alone: the clipboard program may not run yet");
        backend.on_request_format_list();
        assert!(shared.server_ready_for_copies(), "Monitor Ready");
        backend.on_format_list_response(true);
        backend.on_ready();
        backend.on_format_data_request(FormatDataRequest { format: ClipboardFormatId::CF_UNICODETEXT });
        let states: Vec<String> = std::iter::from_fn(|| events.try_recv().ok()).map(|e| e["state"].as_str().unwrap_or("").to_string()).collect();
        assert_eq!(states, ["capabilities", "monitorReady", "ready", "pasteRequest"]);
    }

    fn powershell(script: &str) -> String {
        let out = std::process::Command::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
            .args(["-NoProfile", "-STA", "-Command", script])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr)
    }

    fn pattern(len: usize, seed: u8) -> Vec<u8> {
        (0..len).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
    }

    /// Remote → local with the real Windows shell: the "server" (a thread that
    /// answers like IronRDP's CLIPRDR core) copies a file and a folder; the
    /// shell's Paste into a folder must recreate them byte for byte, the 9 MiB
    /// file arriving in several FileContents ranges.
    #[test]
    #[ignore = "uses the Windows clipboard and shell; run with --include-ignored"]
    fn shell_paste_of_remote_files() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (events_tx, mut events) = mpsc::unbounded_channel();
        let shared = Shared::new(tx, events_tx);
        let sta = shared.clone();
        std::thread::spawn(move || {
            let window = init_thread(&sta);
            run_message_loop(&sta, window);
        });
        while shared.sta_thread.load(Ordering::SeqCst) == 0 {
            std::thread::sleep(Duration::from_millis(10));
        }
        let backend = Arc::new(Mutex::new(FileClipBackend { inner: Box::new(Noop), shared: shared.clone() }));

        let small = b"hello from the remote desktop\r\n".to_vec();
        let big = pattern(9 * 1024 * 1024 + 123, 7);
        let files = vec![
            FileDescriptor::new("note.txt").with_attributes(ClipboardFileAttributes::ARCHIVE).with_file_size(small.len() as u64),
            FileDescriptor::new("logs").with_attributes(ClipboardFileAttributes::DIRECTORY),
            FileDescriptor::new("big.bin")
                .with_relative_path("logs")
                .with_attributes(ClipboardFileAttributes::ARCHIVE)
                .with_file_size(big.len() as u64),
        ];
        let contents = [small.clone(), Vec::new(), big.clone()];
        let requests = Arc::new(AtomicU32::new(0));

        // The "session loop": answer list and range requests like the server would.
        let responder_backend = backend.clone();
        let responder_files = files.clone();
        let counter = requests.clone();
        std::thread::spawn(move || {
            while let Some(message) = rx.blocking_recv() {
                let mut b = responder_backend.lock().unwrap();
                match message {
                    ClipboardMessage::SendInitiatePaste(_) => b.on_remote_file_list(&responder_files, Some(7)),
                    ClipboardMessage::SendFileContentsRequest(r) => {
                        counter.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(r.data_id, Some(7), "requests use the locked snapshot");
                        let data = &contents[r.index as usize];
                        let start = (r.position as usize).min(data.len());
                        let end = (start + r.requested_size as usize).min(data.len());
                        b.on_file_contents_response(FileContentsResponse::new_data_response(r.stream_id, data[start..end].to_vec()));
                    }
                    _ => {}
                }
            }
        });

        backend.lock().unwrap().on_remote_copy(&[
            ClipboardFormat::new(ClipboardFormatId(13)),
            ClipboardFormat::new(ClipboardFormatId(0xC0F1)).with_name(ClipboardFormatName::new("FileGroupDescriptorW")),
            ClipboardFormat::new(ClipboardFormatId(0xC0F2)).with_name(ClipboardFormatName::new("FileContents")),
        ]);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !shared.is_own_clipboard() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(shared.is_own_clipboard(), "remote files are on the local clipboard");

        let dest = std::env::temp_dir().join(format!("bx-fileclip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::create_dir_all(&dest).unwrap();
        let log = powershell(&format!(
            "$f = (New-Object -ComObject Shell.Application).Namespace('{}'); $f.Self.InvokeVerb('Paste'); \
             $t = [Diagnostics.Stopwatch]::StartNew(); while ($t.Elapsed.TotalSeconds -lt 60 -and -not (Test-Path '{}')) {{ Start-Sleep -Milliseconds 100 }}; Start-Sleep -Seconds 2",
            dest.display(),
            dest.join("logs").join("big.bin").display()
        ));
        let got_small = std::fs::read(dest.join("note.txt")).unwrap_or_default();
        let got_big = std::fs::read(dest.join("logs").join("big.bin")).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dest);
        assert_eq!(got_small, small, "note.txt (shell said: {log})");
        assert_eq!(got_big.len(), big.len(), "big.bin size");
        assert!(got_big == big, "big.bin contents");
        assert!(requests.load(Ordering::SeqCst) >= 3, "9 MiB came in several ranges");
        let mut states = Vec::new();
        while let Ok(e) = events.try_recv() {
            states.push(e["state"].as_str().unwrap_or("").to_string());
        }
        assert!(states.first().is_some_and(|s| s == "downloading") && states.last().is_some_and(|s| s == "ready"), "{states:?}");
        // The pasted copy is ours: not announced back to the server.
        assert!(shared.local_copy(&[ClipboardFormat::new(ClipboardFormatId::CF_HDROP)]).is_none());
    }

    /// Local → remote: files and a folder copied in Explorer (CF_HDROP) become
    /// a file list with relative paths, and FileContents requests are answered
    /// from the files.
    #[test]
    #[ignore = "uses the Windows clipboard; run with --include-ignored"]
    fn explorer_copy_becomes_a_file_list() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let (events_tx, _events) = mpsc::unbounded_channel();
        let shared = Shared::new(tx, events_tx);
        let src = std::env::temp_dir().join(format!("bx-fileclip-src-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&src);
        std::fs::create_dir_all(src.join("conf").join("sub")).unwrap();
        let data = pattern(200_000, 3);
        std::fs::write(src.join("a.txt"), b"alpha").unwrap();
        std::fs::write(src.join("conf").join("sub").join("data.bin"), &data).unwrap();
        powershell(&format!("Set-Clipboard -Path '{}','{}'", src.join("a.txt").display(), src.join("conf").display()));

        let list = shared.local_copy(&[ClipboardFormat::new(ClipboardFormatId::CF_HDROP)]).expect("file list");
        let names: Vec<String> = list
            .iter()
            .map(|f| match &f.relative_path {
                Some(p) => format!("{p}\\{}", f.name),
                None => f.name.clone(),
            })
            .collect();
        assert_eq!(names, ["a.txt", "conf", "conf\\sub", "conf\\sub\\data.bin"]);
        assert!(list[1].attributes.unwrap().contains(ClipboardFileAttributes::DIRECTORY));
        assert_eq!(list[3].file_size, Some(data.len() as u64));

        let req = |index, flags, position, size| FileContentsRequest { stream_id: 9, index, flags, position, requested_size: size, data_id: None };
        let size = shared.answer_local(&req(3, FileContentsFlags::SIZE, 0, 8));
        assert_eq!(size.data(), (data.len() as u64).to_le_bytes());
        let range = shared.answer_local(&req(3, FileContentsFlags::RANGE, 1000, 5000));
        assert_eq!(range.data(), &data[1000..6000]);
        assert!(shared.answer_local(&req(1, FileContentsFlags::RANGE, 0, 10)).is_error(), "a folder has no contents");
        assert!(shared.answer_local(&req(99, FileContentsFlags::RANGE, 0, 10)).is_error());
        let _ = std::fs::remove_dir_all(&src);
    }

    #[test]
    fn dropfiles_layout() {
        let bytes = dropfiles(&[PathBuf::from(r"C:\t\a.txt"), PathBuf::from(r"C:\t\dir")]);
        assert_eq!(&bytes[..4], &20u32.to_le_bytes());
        assert_eq!(&bytes[16..20], &1u32.to_le_bytes(), "wide paths");
        let units: Vec<u16> = bytes[20..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(String::from_utf16_lossy(&units), "C:\\t\\a.txt\0C:\\t\\dir\0\0");
    }
}
