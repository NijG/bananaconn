// Multi-line pastes to device consoles (serial, Telnet console servers), one
// line at a time. A console reads input into a small buffer while it applies
// the previous line; text sent faster than that is lost. A fixed gap per line
// is either slow (fast links) or unsafe (long lines at 9600 baud), so by
// default the next line goes as soon as the device shows it has taken the
// current one: it echoed the line's end and printed its prompt again (or went
// quiet). A fixed line/character delay is available for devices that do not
// echo.

use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;

/// After the line's end is echoed: output this quiet means the device is
/// waiting for input even without a recognisable prompt (banner text, a
/// question).
const QUIET: Duration = Duration::from_millis(120);
/// Nothing at all came back: a device without echo. Send on.
const NO_ECHO: Duration = Duration::from_millis(800);
/// Output keeps coming without a prompt (a long `show`): send on anyway; the
/// device holds what it has not read yet, like typed-ahead keys.
const MAX_WAIT: Duration = Duration::from_secs(4);
/// The last line of output kept for prompt detection.
const TAIL: usize = 256;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Mode {
    /// Wait for the echo and the prompt (default).
    Echo,
    /// Wait `line_ms` after each line and `char_ms` after each character.
    #[serde(rename_all = "camelCase")]
    Fixed { line_ms: u32, char_ms: u32 },
}

#[derive(Default)]
struct Seen {
    /// Any output since the line was sent.
    any: bool,
    /// A line break since the line was sent (its end was echoed).
    newline: bool,
    /// Output after the last line break.
    tail: Vec<u8>,
    last: Option<Instant>,
}

/// One paste in progress on a session: its remaining lines and what the
/// device has sent back since the current line went out.
pub struct Job {
    lines: Mutex<VecDeque<Vec<u8>>>,
    seen: Mutex<Seen>,
    cv: Condvar,
    stop: AtomicBool,
    /// `run` has returned (or is about to): `add` must not queue lines no
    /// one will send. Set and read under the `lines` lock, so a paste either
    /// lands in this job before it ends or is refused and starts a new one.
    finished: AtomicBool,
    total: AtomicUsize,
    sent: AtomicUsize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum End {
    Done,
    Stopped,
    /// The session can no longer take input.
    Failed,
}

impl Job {
    pub fn new() -> Self {
        Self {
            lines: Mutex::new(VecDeque::new()),
            seen: Mutex::new(Seen::default()),
            cv: Condvar::new(),
            stop: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            total: AtomicUsize::new(0),
            sent: AtomicUsize::new(0),
        }
    }

    /// Queue text: one entry per line, each ending with its CR (the last one
    /// may have none). None when the job has already ended: the caller
    /// starts a new one (the text would otherwise be dropped).
    pub fn add(&self, text: &[u8]) -> Option<usize> {
        let mut lines = self.lines.lock().unwrap();
        if self.finished.load(Ordering::Relaxed) {
            return None;
        }
        let mut n = 0;
        for line in text.split_inclusive(|&b| b == b'\r') {
            lines.push_back(line.to_vec());
            n += 1;
        }
        self.total.fetch_add(n, Ordering::Relaxed);
        self.cv.notify_all();
        Some(n)
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        self.cv.notify_all();
    }

    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    /// Lines sent and lines in total.
    pub fn progress(&self) -> (usize, usize) {
        (self.sent.load(Ordering::Relaxed), self.total.load(Ordering::Relaxed))
    }

    /// Output from the device.
    pub fn observe(&self, bytes: &[u8]) {
        let mut s = self.seen.lock().unwrap();
        s.any = true;
        s.last = Some(Instant::now());
        match bytes.iter().rposition(|&b| b == b'\n') {
            Some(i) => {
                s.newline = true;
                s.tail.clear();
                s.tail.extend_from_slice(&bytes[i + 1..]);
            }
            None => s.tail.extend_from_slice(bytes),
        }
        if s.tail.len() > TAIL {
            let cut = s.tail.len() - TAIL;
            s.tail.drain(..cut);
        }
        self.cv.notify_all();
    }

    /// Send every queued line (also lines added meanwhile). `char_time`: how
    /// long one character takes on the wire (serial), so a long line is never
    /// followed before it has even left. `send` refusing with WouldBlock (the
    /// write queue is full) is retried; any other error ends the paste.
    pub fn run(&self, mode: Mode, char_time: Duration, send: impl Fn(&[u8]) -> io::Result<()>, tick: impl FnMut()) -> End {
        let end = self.send_lines(mode, char_time, send, tick);
        // Stopped or failed: later text goes to a new job too.
        let _lines = self.lines.lock().unwrap();
        self.finished.store(true, Ordering::Relaxed);
        end
    }

    fn send_lines(&self, mode: Mode, char_time: Duration, send: impl Fn(&[u8]) -> io::Result<()>, mut tick: impl FnMut()) -> End {
        let mut ticked = Instant::now();
        loop {
            if self.stopped() {
                return End::Stopped;
            }
            let line = {
                let mut lines = self.lines.lock().unwrap();
                match lines.pop_front() {
                    Some(line) => line,
                    None => {
                        // Under the same lock as `add`: nothing can slip in
                        // between "queue empty" and "done".
                        self.finished.store(true, Ordering::Relaxed);
                        return End::Done;
                    }
                }
            };
            *self.seen.lock().unwrap() = Seen::default();
            let started = Instant::now();
            let ok = match mode {
                Mode::Fixed { char_ms, .. } if char_ms > 0 => utf8_chunks(&line).all(|c| self.send_all(&send, c) && self.pause(Duration::from_millis(char_ms.into()))),
                _ => self.send_all(&send, &line),
            };
            if !ok {
                return if self.stopped() { End::Stopped } else { End::Failed };
            }
            self.sent.fetch_add(1, Ordering::Relaxed);
            if ticked.elapsed() >= Duration::from_millis(100) {
                tick();
                ticked = Instant::now();
            }
            // Nothing follows the last line: no need to wait for the device.
            if self.lines.lock().unwrap().is_empty() {
                continue;
            }
            let on_wire = char_time * u32::try_from(line.len()).unwrap_or(u32::MAX);
            match mode {
                Mode::Fixed { line_ms, .. } => {
                    // The delay follows the line's end, like the usual "line send delay".
                    let gap = Duration::from_millis(line_ms.into()).max(on_wire.saturating_sub(started.elapsed()));
                    if !self.pause(gap) {
                        return End::Stopped;
                    }
                }
                Mode::Echo => {
                    if !self.wait_for_device(started, on_wire) {
                        return End::Stopped;
                    }
                }
            }
        }
    }

    fn send_all(&self, send: &impl Fn(&[u8]) -> io::Result<()>, data: &[u8]) -> bool {
        loop {
            if self.stopped() {
                return false;
            }
            match send(data) {
                Ok(()) => return true,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(5)),
                Err(_) => return false,
            }
        }
    }

    /// Sleep unless stopped meanwhile; false when stopped.
    fn pause(&self, d: Duration) -> bool {
        let deadline = Instant::now() + d;
        let mut s = self.seen.lock().unwrap();
        while !self.stopped() {
            let now = Instant::now();
            if now >= deadline {
                return true;
            }
            s = self.cv.wait_timeout(s, deadline - now).unwrap().0;
        }
        false
    }

    /// Wait until the device has taken the line; false when stopped.
    fn wait_for_device(&self, started: Instant, on_wire: Duration) -> bool {
        let mut s = self.seen.lock().unwrap();
        loop {
            if self.stopped() {
                return false;
            }
            let now = Instant::now();
            let since = now - started;
            let wait = if since < on_wire {
                on_wire - since
            } else if s.newline {
                if looks_like_prompt(&s.tail) {
                    return true;
                }
                let quiet = s.last.map_or(Duration::ZERO, |t| now - t);
                if quiet >= QUIET {
                    return true;
                }
                QUIET - quiet
            } else if !s.any {
                let limit = on_wire + NO_ECHO;
                if since >= limit {
                    return true;
                }
                limit - since
            } else {
                Duration::from_millis(50)
            };
            if since >= on_wire + MAX_WAIT {
                return true;
            }
            s = self.cv.wait_timeout(s, wait.min(on_wire + MAX_WAIT - since)).unwrap().0;
        }
    }
}

/// A byte slice taken one UTF-8 character at a time, so a fixed "character
/// delay" waits once per character rather than once per byte: a Korean (or
/// other multi-byte) character would otherwise be split across several delays
/// and sent a partial byte at a time. A byte that is not a UTF-8 lead byte is
/// joined to the one before it; a stray continuation byte (invalid UTF-8) goes
/// on its own.
fn utf8_chunks(line: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut i = 0;
    std::iter::from_fn(move || {
        if i >= line.len() {
            return None;
        }
        let start = i;
        i += 1;
        while i < line.len() && line[i] & 0xC0 == 0x80 {
            i += 1;
        }
        Some(&line[start..i])
    })
}

/// The end of a prompt: `Router#`, `Router(config-if)#`, `switch>`, `$ `,
/// `[admin@host ~]# `, `Password:`, `FGT # `. Escape sequences and trailing
/// blanks are ignored.
fn looks_like_prompt(tail: &[u8]) -> bool {
    let mut text = Vec::with_capacity(tail.len());
    let mut i = 0;
    while i < tail.len() {
        if tail[i] == 0x1b {
            // CSI: ESC [ params final(0x40..=0x7e); other escapes: ESC + one byte.
            if tail.get(i + 1) == Some(&b'[') {
                i += 2;
                while i < tail.len() && !(0x40..=0x7e).contains(&tail[i]) {
                    i += 1;
                }
            } else {
                i += 1;
            }
        } else if tail[i] != b'\r' {
            text.push(tail[i]);
        }
        i += 1;
    }
    let trimmed = text.trim_ascii_end();
    matches!(trimmed.last(), Some(b'#' | b'>' | b'$' | b'%' | b']' | b':'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn prompts_are_recognised() {
        for p in ["Router#", "Router(config-if)#", "switch> ", "$ ", "[admin@host ~]# ", "Password:", "FGT # ", "\x1b[1mR1#\x1b[0m "] {
            assert!(looks_like_prompt(p.as_bytes()), "{p:?}");
        }
        for p in ["Building configuration...", "", "  --More-- 12%x"] {
            assert!(!looks_like_prompt(p.as_bytes()), "{p:?}");
        }
    }

    #[test]
    fn lines_keep_their_line_ends() {
        let job = Job::new();
        assert_eq!(job.add(b"a\rb\r\rc"), Some(4));
        let lines: Vec<_> = job.lines.lock().unwrap().iter().cloned().collect();
        assert_eq!(lines, [b"a\r".to_vec(), b"b\r".to_vec(), b"\r".to_vec(), b"c".to_vec()]);
    }

    /// A fake console: echoes each line `apply` after receiving it, then
    /// prints its prompt. Records when every line arrived.
    /// When each write arrived, and what it was.
    type Arrivals = Arc<Mutex<Vec<(Instant, Vec<u8>)>>>;

    fn console(job: &Arc<Job>, apply: Duration, prompt: Option<&'static str>) -> (impl Fn(&[u8]) -> io::Result<()>, Arrivals) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let (job, rec) = (job.clone(), log.clone());
        let send = move |data: &[u8]| {
            rec.lock().unwrap().push((Instant::now(), data.to_vec()));
            let (job, data) = (job.clone(), data.to_vec());
            std::thread::spawn(move || {
                std::thread::sleep(apply);
                let mut out = data.clone();
                if out.ends_with(b"\r") {
                    out.push(b'\n');
                }
                job.observe(&out);
                if let Some(p) = prompt {
                    job.observe(p.as_bytes());
                }
            });
            Ok(())
        };
        (send, log)
    }

    #[test]
    fn echo_mode_follows_the_device() {
        let job = Arc::new(Job::new());
        job.add(&b"interface Gi0/1\r description uplink\r no shutdown\r exit\r".repeat(10));
        let (send, log) = console(&job, Duration::from_millis(15), Some("R1(config-if)#"));
        let t = Instant::now();
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done);
        let took = t.elapsed();
        let log = log.lock().unwrap();
        assert_eq!(log.len(), 40);
        // Never ahead of the device: each line goes after the previous was applied.
        for w in log.windows(2) {
            assert!(w[1].0 - w[0].0 >= Duration::from_millis(15), "{:?}", w[1].0 - w[0].0);
        }
        // And not much slower than it: ~15 ms a line, where a fixed 100 ms gap took 3.9 s.
        assert!(took < Duration::from_millis(1500), "{took:?}");
    }

    #[test]
    fn echo_mode_without_a_prompt_waits_for_quiet() {
        let job = Arc::new(Job::new());
        job.add(b"banner line 1\rbanner line 2\rend\r");
        let (send, log) = console(&job, Duration::from_millis(5), None);
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done);
        let log = log.lock().unwrap();
        for w in log.windows(2) {
            assert!(w[1].0 - w[0].0 >= QUIET, "{:?}", w[1].0 - w[0].0);
        }
    }

    #[test]
    fn no_echo_device_is_not_waited_on_forever() {
        let job = Arc::new(Job::new());
        job.add(b"a\rb\r");
        let t = Instant::now();
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, |_| Ok(()), || {}), End::Done);
        let took = t.elapsed();
        assert!(took >= NO_ECHO && took < NO_ECHO + Duration::from_millis(400), "{took:?}");
    }

    #[test]
    fn a_long_line_is_not_followed_before_it_left_the_wire() {
        // 9600 baud: ~1.04 ms a character; an 80-character line ~83 ms.
        let job = Arc::new(Job::new());
        job.add(&[vec![b'x'; 79], vec![b'\r'], b"next\r".to_vec()].concat());
        let (send, log) = console(&job, Duration::ZERO, Some("#"));
        assert_eq!(job.run(Mode::Echo, Duration::from_micros(1042), send, || {}), End::Done);
        let log = log.lock().unwrap();
        assert!(log[1].0 - log[0].0 >= Duration::from_millis(80), "{:?}", log[1].0 - log[0].0);
    }

    #[test]
    fn fixed_mode_uses_the_given_delays() {
        let job = Arc::new(Job::new());
        job.add(b"ab\rcd\r");
        let log = Arc::new(Mutex::new(Vec::new()));
        let rec = log.clone();
        let send = move |d: &[u8]| {
            rec.lock().unwrap().push((Instant::now(), d.to_vec()));
            Ok(())
        };
        assert_eq!(job.run(Mode::Fixed { line_ms: 60, char_ms: 10 }, Duration::ZERO, send, || {}), End::Done);
        let log = log.lock().unwrap();
        assert_eq!(log.len(), 6, "one write per character");
        assert!(log[3].0 - log[2].0 >= Duration::from_millis(60), "line delay");
        assert!(log[1].0 - log[0].0 >= Duration::from_millis(10), "character delay");
    }

    #[test]
    fn fixed_mode_paces_whole_characters_not_bytes() {
        // Korean (and other multi-byte UTF-8) must go one character per
        // character delay, not one byte: "가나\r" is two three-byte characters
        // and a CR, so three writes, each a whole character in order.
        let job = Arc::new(Job::new());
        job.add("가나\r".as_bytes());
        let log = Arc::new(Mutex::new(Vec::new()));
        let rec = log.clone();
        let send = move |d: &[u8]| {
            rec.lock().unwrap().push(d.to_vec());
            Ok(())
        };
        assert_eq!(job.run(Mode::Fixed { line_ms: 0, char_ms: 5 }, Duration::ZERO, send, || {}), End::Done);
        let log = log.lock().unwrap();
        assert_eq!(*log, ["가".as_bytes().to_vec(), "나".as_bytes().to_vec(), b"\r".to_vec()]);
    }

    #[test]
    fn stop_ends_at_once_and_a_dead_session_fails() {
        let job = Arc::new(Job::new());
        job.add(&b"x\r".repeat(100));
        let j = job.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            j.stop();
        });
        let t = Instant::now();
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, |_| Ok(()), || {}), End::Stopped);
        assert!(t.elapsed() < Duration::from_millis(300));
        assert!(job.progress().0 < 100);

        let job = Job::new();
        job.add(b"x\ry\r");
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, |_| Err(io::ErrorKind::BrokenPipe.into()), || {}), End::Failed);
    }

    /// Text pasted after the last line went out (before the session forgot
    /// the job) is refused, so the caller starts a new job instead of
    /// queueing lines no one sends.
    #[test]
    fn a_finished_job_takes_no_more_lines() {
        let job = Job::new();
        job.add(b"x\r");
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, |_| Ok(()), || {}), End::Done);
        assert_eq!(job.add(b"late\r"), None);
        assert_eq!(job.progress(), (1, 1));

        let job = Job::new();
        job.add(b"x\r");
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, |_| Err(io::ErrorKind::BrokenPipe.into()), || {}), End::Failed);
        assert_eq!(job.add(b"late\r"), None);
    }

    #[test]
    fn a_full_write_queue_is_retried() {
        let job = Job::new();
        job.add(b"x\r");
        let tries = AtomicUsize::new(0);
        let send = |_: &[u8]| if tries.fetch_add(1, Ordering::Relaxed) < 3 { Err(io::ErrorKind::WouldBlock.into()) } else { Ok(()) };
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done);
        assert_eq!(job.progress(), (1, 1));
    }
}
