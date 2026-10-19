// Terminal output on its way to the webview. Reads are coalesced into larger
// messages and sent as raw bytes over the tab's own IPC channel (no base64, no
// JSON, no global event). The page acknowledges what xterm has processed; while
// too much is unacknowledged the reader thread waits, so a flood (`cat` of a
// big file, `yes`) is slowed down at the peer instead of piling up in the
// webview, and Ctrl+C takes effect at once. The session's exit code is the
// channel's last message (a number), so it can never overtake the output.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::{Channel, InvokeResponseBody};

/// After the first byte, gather more output for this long before sending.
const COALESCE: Duration = Duration::from_millis(4);
/// Largest single message to the page.
const MAX_MESSAGE: usize = 256 * 1024;
/// Output the page may hold unprocessed before the reader is paused.
const HIGH_WATER: usize = 2 * 1024 * 1024;
/// A page that acknowledges nothing for this long (lost acknowledgement,
/// stuck tab) no longer holds the session back. Each escape in a row doubles
/// the wait (up to 64x): a page that is only slow, such as a minimized window
/// whose timers are throttled, is not sent another HIGH_WATER every few
/// seconds while its unprocessed output grows without bound.
const STALL: Duration = Duration::from_secs(5);
const MAX_STALL_DOUBLINGS: u32 = 6;

struct State {
    buf: Vec<u8>,
    /// Sent to the page, not yet acknowledged.
    unacked: usize,
    /// Last acknowledgement, or when output started to be outstanding.
    progress: Instant,
    exit: Option<i32>,
    closed: bool,
    /// Stall escapes since the last acknowledgement.
    stalls: u32,
}

impl State {
    /// The page is far behind and still making progress.
    fn behind(&self, pending: usize) -> bool {
        !self.closed && pending >= HIGH_WATER && self.progress.elapsed() < self.stall()
    }

    fn stall(&self) -> Duration {
        STALL * 2u32.pow(self.stalls.min(MAX_STALL_DOUBLINGS))
    }
}

pub struct OutPump {
    state: Mutex<State>,
    cv: Condvar,
}

impl OutPump {
    /// Start the sender thread for one terminal tab.
    pub fn start(channel: Channel<InvokeResponseBody>) -> Arc<Self> {
        let pump = Arc::new(Self {
            state: Mutex::new(State { buf: Vec::new(), unacked: 0, progress: Instant::now(), exit: None, closed: false, stalls: 0 }),
            cv: Condvar::new(),
        });
        let sender = pump.clone();
        let _ = std::thread::Builder::new().name("term-out".into()).spawn(move || sender.run(&channel));
        pump
    }

    /// Queue output. Blocks the calling reader while the page is far behind.
    pub fn push(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut s = self.state.lock().unwrap();
        if s.closed {
            return;
        }
        s.buf.extend_from_slice(bytes);
        self.cv.notify_all();
        while s.behind(s.unacked + s.buf.len()) {
            s = self.cv.wait_timeout(s, Duration::from_millis(100)).unwrap().0;
        }
    }

    /// The page processed `n` more bytes.
    pub fn ack(&self, n: usize) {
        let mut s = self.state.lock().unwrap();
        s.unacked = s.unacked.saturating_sub(n);
        s.progress = Instant::now();
        s.stalls = 0;
        self.cv.notify_all();
    }

    /// The session ended: send what is queued, then the exit code.
    pub fn finish(&self, code: i32) {
        let mut s = self.state.lock().unwrap();
        s.exit.get_or_insert(code);
        self.cv.notify_all();
    }

    /// The tab is gone: drop queued output and release a waiting reader.
    pub fn close(&self) {
        let mut s = self.state.lock().unwrap();
        s.closed = true;
        s.buf = Vec::new();
        self.cv.notify_all();
    }

    fn run(&self, channel: &Channel<InvokeResponseBody>) {
        let mut last_send: Option<Instant> = None;
        let recent = |at: Option<Instant>| at.is_some_and(|t| t.elapsed() < Duration::from_millis(20));
        loop {
            let mut s = self.state.lock().unwrap();
            while s.buf.is_empty() && s.exit.is_none() && !s.closed {
                s = self.cv.wait(s).unwrap();
            }
            if s.closed {
                return;
            }
            if s.buf.is_empty() {
                let code = s.exit.unwrap_or(0);
                drop(s);
                let _ = channel.send(InvokeResponseBody::Json(code.to_string()));
                return;
            }
            // Coalesce while output keeps coming (a burst of small reads
            // becomes one message); after a pause, the first bytes (an echoed
            // key) go out at once.
            let deadline = Instant::now() + COALESCE;
            while recent(last_send) && s.buf.len() < MAX_MESSAGE && s.exit.is_none() && !s.closed {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                s = self.cv.wait_timeout(s, deadline - now).unwrap().0;
            }
            while s.behind(s.unacked) {
                s = self.cv.wait_timeout(s, Duration::from_millis(100)).unwrap().0;
            }
            if s.closed {
                return;
            }
            if s.unacked >= HIGH_WATER {
                // Stalled page: carry on rather than freeze the session.
                s.unacked = 0;
                s.stalls += 1;
            }
            let chunk = if s.buf.len() <= MAX_MESSAGE { std::mem::take(&mut s.buf) } else { s.buf.drain(..MAX_MESSAGE).collect() };
            if s.unacked == 0 {
                s.progress = Instant::now();
            }
            s.unacked += chunk.len();
            self.cv.notify_all();
            drop(s);
            last_send = Some(Instant::now());
            if channel.send(InvokeResponseBody::Raw(chunk)).is_err() {
                self.close();
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stall_escapes_back_off_and_reset_on_progress() {
        let mut s = State { buf: Vec::new(), unacked: HIGH_WATER, progress: Instant::now(), exit: None, closed: false, stalls: 0 };
        assert_eq!(s.stall(), STALL);
        s.stalls = 3;
        assert_eq!(s.stall(), STALL * 8);
        s.stalls = 40;
        assert_eq!(s.stall(), STALL * 64);
        // Freshly stalled for longer than the base wait, but within the backed-off one.
        s.progress = Instant::now() - STALL * 2;
        assert!(s.behind(HIGH_WATER));
        s.stalls = 0;
        assert!(!s.behind(HIGH_WATER));
    }
}
