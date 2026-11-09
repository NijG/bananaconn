// Multi-line pastes to device consoles (serial, Telnet console servers), one
// line at a time. A console reads input into a small buffer while it applies
// the previous line; text sent faster than that is lost. A fixed gap per line
// is either slow (fast links) or unsafe (long lines at 9600 baud), so by
// default the next line goes as soon as the device shows it has taken the
// current one: its prompt is back after the line's echo. Without the prompt a
// line goes on only where the device plainly waits for more (it echoed the
// line and asks a question, or takes text in such as a banner's lines) or has
// answered nothing at all in this paste (a device without echo). A device
// that answers and then goes quiet is busy, never "done". Output that may be
// a console waking into its login is waited for; the paste stops at a login,
// password or host-key question, at a console that logged out or a pager, and
// when the prompt does not come back. A fixed line/character delay sets the
// least time per line, for devices that need it.

use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;

/// After the line's echo: output this quiet means the device waits for input
/// (banner text, a question, a prompt of a shape not known).
const QUIET: Duration = Duration::from_millis(120);
/// Nothing at all came back from a device that has answered nothing in this
/// paste: one without echo. Send on.
const NO_ECHO: Duration = Duration::from_millis(800);
/// The same for the paste's first line, which may wake a console slowly.
const MUTE_FIRST: Duration = Duration::from_secs(3);
/// A login question in a complete line with output flowing on after it
/// (that never rests): the paste stops this long after the line went.
const QUESTION_FLOOD: Duration = Duration::from_secs(3);
/// A prompt not known, after a line that may lead to a login: waited this
/// long at rest (a read may end at "[sudo]" of a password question).
const WAKE_QUIET: Duration = Duration::from_secs(1);
/// No sign the device took the line and no output for this long: the paste
/// stops (a console doing something else, a login question that never came,
/// a key being generated for longer than this).
const HARD_WAIT: Duration = if cfg!(test) { Duration::from_secs(5) } else { Duration::from_secs(60) };
/// Output that never shows the prompt (a debug stream): the paste stops this late at most.
const LONG_WAIT: Duration = if cfg!(test) { Duration::from_secs(8) } else { Duration::from_secs(30 * 60) };
/// The last line of output kept: the one the cursor is on.
const TAIL: usize = 256;
/// The output kept since a line was sent (its echo, what it printed), and
/// the session's output kept for a new paste (term.rs).
pub const RECENT: usize = 2048;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Mode {
    /// Wait for the device to take each line (default).
    Echo,
    /// As Echo, and at least `line_ms` after each line and `char_ms` after
    /// each character.
    #[serde(rename_all = "camelCase")]
    Fixed { line_ms: u32, char_ms: u32 },
}

#[derive(Default)]
struct Seen {
    /// Any output since the line was sent.
    any: bool,
    /// Line breaks since the line was sent.
    breaks: usize,
    /// Output after the last line break.
    tail: Vec<u8>,
    /// All output since the line was sent, its last RECENT bytes.
    recent: Vec<u8>,
    last: Option<Instant>,
    /// Before the first line: where in `recent` the user last pressed Enter (0: not within it).
    answered: usize,
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
    /// Lines left out: a password after an `enable` that asked for none.
    skipped: AtomicUsize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum End {
    Done,
    Stopped,
    /// The session can no longer take input.
    Failed,
    /// The device asked for a login name, a password or to accept a host
    /// key (a console that had timed out to its login and was woken by a
    /// line, sudo, ssh): the next lines would go in as a user name and a
    /// password, a failed login each.
    Login,
    /// The device did not come back to its prompt (a console that logged
    /// out, a pager, output that never ends): the next line could land
    /// anywhere, a login among them.
    NoPrompt,
}

/// How a line was let go.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Step {
    /// The device's prompt came back.
    Prompt,
    /// The device asked a question the next line answers ("[confirm]", the
    /// password of `enable`).
    Answer,
    /// Without the prompt: the device takes text (a banner's lines), rests at
    /// a prompt of a shape not known, or answers nothing. The next line's
    /// prompt counts only after that line's own echo.
    Blind,
}

/// What to do after a line, judged from the output since it went out.
#[derive(Debug, PartialEq)]
enum Next {
    /// Send the next line. `echoed`: the device showed this line's echo.
    Go { step: Step, echoed: bool },
    End(End),
    /// Look again after this long, or when output comes.
    Wait(Duration),
}

/// How a line was taken: what the next one is judged with.
struct Took {
    step: Step,
    echoed: bool,
    /// Any output came after the line.
    any: bool,
}

/// The output since a line went out, as `judge` sees it.
struct Look<'a> {
    recent: &'a [u8],
    breaks: usize,
    any: bool,
    /// Time since the last output (since the line left the wire when none came).
    quiet: Duration,
    /// Time since the line left the wire.
    since: Duration,
}

/// A line that went out.
struct Typed<'a> {
    /// The line, blanks and its CR left out.
    text: &'a [u8],
    /// The line the cursor was on as it went out (its text only).
    at: &'a [u8],
    /// The line queued after it (blanks left out): what a password question
    /// right after `enable` would get.
    next: Option<&'a [u8]>,
    /// The paste's first line.
    first: bool,
    /// Fixed mode: the line delay has passed already.
    fixed: bool,
    /// The device answered an earlier line of this paste: it is not one
    /// without echo, and silence means it is busy.
    answered: bool,
    /// The device echoed an earlier line of this paste.
    echoes: bool,
    /// The line before went without the prompt (Step::Blind): what comes
    /// before this line's echo may be the line before's.
    blind_before: bool,
    /// The line the cursor was on as the paste began, when it may be a
    /// prompt of a shape not known (is_home); empty otherwise.
    home: &'a [u8],
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
            skipped: AtomicUsize::new(0),
        }
    }

    /// Queue text: one entry per line, each ending with its CR (the last one
    /// may have none). None when the job has already ended: the caller
    /// starts a new one (the text would otherwise be dropped).
    pub fn add(&self, text: &[u8]) -> Option<usize> {
        // A bracketed paste's markers (bash asks for them): typed line by line
        // here, the device must see plain lines (with the markers, the shell
        // prints nothing until the end, and the first line's checks miss it).
        let text = without_paste_marks(text);
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

    /// Lines left out on purpose (a password `enable` did not ask for).
    pub fn skipped(&self) -> usize {
        self.skipped.load(Ordering::Relaxed)
    }

    /// What the session showed before this job (its last output), checked
    /// before the first line goes out: a login question on the screen that
    /// no prompt of the device followed (log messages may have) is never
    /// answered with several lines, and the device's prompt there is the one
    /// the lines are typed at. `answered`: where in `before` the user last
    /// pressed Enter (0: not within it); a question up to that line had its
    /// answer from the user.
    pub fn prime(&self, before: &[u8], answered: usize) {
        let cut = before.len().saturating_sub(RECENT);
        let before = &before[cut..];
        let answered = answered.saturating_sub(cut).min(before.len());
        let line = &before[before.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1)..];
        let mut s = self.seen.lock().unwrap();
        s.recent = before.to_vec();
        s.tail = line[line.len().saturating_sub(TAIL)..].to_vec();
        s.answered = answered;
    }

    /// Output from the device.
    pub fn observe(&self, bytes: &[u8]) {
        let mut s = self.seen.lock().unwrap();
        s.any = true;
        s.last = Some(Instant::now());
        s.breaks += bytes.iter().filter(|&&b| b == b'\n').count();
        s.recent.extend_from_slice(bytes);
        if s.recent.len() > RECENT {
            let cut = s.recent.len() - RECENT;
            s.recent.drain(..cut);
            // Where the user's Enter came moves with the bytes (gone with them: none answered).
            s.answered = s.answered.saturating_sub(cut);
        }
        match bytes.iter().rposition(|&b| b == b'\n') {
            Some(i) => {
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
        let mut first = true;
        // The device's prompt as last seen: the next line goes when it is back.
        let mut prompt = Vec::new();
        // The line the cursor was on as the paste began (a prompt of a shape
        // not known, "❯", "➜  ~"): the device is back when it shows it again.
        let mut home = Vec::new();
        // What the lines so far showed of the device.
        let (mut answered, mut echoes, mut blind) = (false, false, false);
        loop {
            if self.stopped() {
                return End::Stopped;
            }
            let (line, more) = {
                let mut lines = self.lines.lock().unwrap();
                match lines.pop_front() {
                    Some(line) => {
                        let more = !lines.is_empty();
                        (line, more)
                    }
                    None => {
                        // Under the same lock as `add`: nothing can slip in
                        // between "queue empty" and "done".
                        self.finished.store(true, Ordering::Relaxed);
                        return End::Done;
                    }
                }
            };
            let first_line = std::mem::take(&mut first);
            // The line the cursor is on as this line goes out: the device's
            // prompt, or (the job's first line) what the session showed last.
            let at = {
                let s = self.seen.lock().unwrap();
                if first_line {
                    let shown = text_lines(&s.recent);
                    if let Some(p) = shown.iter().rev().find(|l| is_prompt(l)) {
                        prompt = p.trim_ascii().to_vec();
                    }
                    // Several lines into a login or password question on the
                    // screen (drawn after the paste was checked, or above log
                    // messages since): each one an attempt. One the user
                    // answered (pressed Enter at or after) is no more; the
                    // line the Enter was pressed on only once the device went
                    // on past it (before that, the answer may still be refused
                    // and the question asked again).
                    let at_enter = s.answered.min(s.recent.len());
                    let answered = if at_enter == 0 {
                        0
                    } else {
                        s.recent[..at_enter].iter().filter(|&&b| b == b'\n').count() + usize::from(s.recent[at_enter..].contains(&b'\n'))
                    }
                    .min(shown.len());
                    let open: Vec<&[u8]> = shown[answered..].iter().map(Vec::as_slice).collect();
                    if more && pending_question(&open, &prompt).is_some() {
                        return End::Login;
                    }
                }
                let at = plain(&s.tail).trim_ascii().to_vec();
                if first_line && is_home(&at) {
                    home.clone_from(&at);
                }
                at
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
            let Some(next) = self.lines.lock().unwrap().front().cloned() else { continue };
            let on_wire = char_time * u32::try_from(line.len()).unwrap_or(u32::MAX);
            let fixed = match mode {
                Mode::Fixed { line_ms, .. } => {
                    // The delay follows the line's end, like the usual "line send delay".
                    let gap = Duration::from_millis(line_ms.into()).max(on_wire.saturating_sub(started.elapsed()));
                    if !self.pause(gap) {
                        return End::Stopped;
                    }
                    true
                }
                Mode::Echo => false,
            };
            let typed = Typed { text: line.trim_ascii(), at: &at, home: &home, next: Some(next.trim_ascii()), first: first_line, fixed, answered, echoes, blind_before: blind };
            match self.await_device(started, on_wire, &typed, &mut prompt) {
                Ok(took) => {
                    answered |= took.any;
                    echoes |= took.echoed;
                    blind = took.step == Step::Blind;
                    // `enable` asked for no password (privileged already, or
                    // none set: "% No password set"), its prompt back: the line
                    // queued after it, its password, would go in as a command
                    // (IOS looks a word up as a host name, out on the network
                    // and into logs). Left out, and told at the end.
                    if is_enable(typed.text) && took.step == Step::Prompt {
                        let mut lines = self.lines.lock().unwrap();
                        if lines.front().is_some_and(|n| looks_secret(n.trim_ascii())) {
                            lines.pop_front();
                            self.skipped.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
                Err(end) => return end,
            }
        }
    }

    /// Wait until the device has taken the line: how, or how the paste ends.
    fn await_device(&self, started: Instant, on_wire: Duration, line: &Typed, prompt: &mut Vec<u8>) -> Result<Took, End> {
        let mut s = self.seen.lock().unwrap();
        loop {
            if self.stopped() {
                return Err(End::Stopped);
            }
            let now = Instant::now();
            let wait = match (now - started).checked_sub(on_wire) {
                // Still on the wire (a long line at 9600 baud).
                None => on_wire - (now - started),
                Some(since) => {
                    let look = Look { recent: &s.recent, breaks: s.breaks, any: s.any, quiet: s.last.map_or(since, |t| now - t), since };
                    match judge(&look, line, prompt) {
                        Next::Go { step, echoed } => return Ok(Took { step, echoed, any: s.any }),
                        Next::End(end) => return Err(end),
                        Next::Wait(d) => d,
                    }
                }
            };
            s = self.cv.wait_timeout(s, wait.clamp(Duration::from_millis(1), Duration::from_millis(500))).unwrap().0;
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
}

/// After `line`, from the output since it went out: send the next line, end
/// the paste, or wait. `prompt`: the device's prompt as last seen, updated
/// when it comes back changed. The next line goes on the device's prompt
/// after the line's echo; without it only where the device plainly waits for
/// input, never after a line that may lead to a login, and never on silence
/// from a device that has answered before (it is busy).
fn judge(look: &Look, line: &Typed, prompt: &mut Vec<u8>) -> Next {
    let lines = text_lines(look.recent);
    let last = lines.len() - 1;
    let tail = lines[last].as_slice();
    let echo_at = echo_line(&lines, look.breaks, line.text);
    let echoed = echo_at.is_some();
    let go = |step| Next::Go { step, echoed };
    // The echo and the line after it, where the cursor waits.
    let right_after = echo_at.is_some_and(|e| e + 1 == last);
    let quiet = look.quiet;
    let mut wait = Duration::from_millis(500);

    // A login, password or host-key question nothing has answered: the
    // next line would be an attempt. The echo is the paste's own text
    // ("user:" of a file). Only `enable` typed at the device's ">" prompt,
    // asked for its password right after its echo, with what looks like a
    // password queued next, goes on: enable and its password pasted
    // together (typed at a login question instead, "enable" was the user
    // name; followed by a command, that would be a failed attempt).
    let printed: Vec<&[u8]> = lines.iter().enumerate().filter(|&(i, _)| Some(i) != echo_at).map(|(_, l)| l.as_slice()).collect();
    if let Some(i) = pending_question(&printed, prompt) {
        let enable = right_after && asks_password(tail) && is_enable(line.text) && at_user_prompt(line.at) && line.next.is_some_and(looks_secret);
        // Once the output rests: a read may end inside a line ("[user:" of
        // "Login Success [user: admin]") or before the line that makes a
        // question something else (an indented "  user:" and the line under
        // it). A question with output flowing on after it stops the paste
        // too, a few seconds on.
        let flowing_on = !enable && i + 1 < printed.len() && look.since >= QUESTION_FLOOD;
        if !rested(quiet, QUIET, &mut wait) && !flowing_on {
            return Next::Wait(wait);
        }
        return if enable { go(Step::Answer) } else { Next::End(End::Login) };
    }

    // A line that may lead to a login (sudo, ssh, a console connection,
    // "exit" logging the console out, a bare host name or address at an
    // exec prompt: IOS connects to it) takes no shortcut, and its prompt
    // counts only after its own echo when the device echoes (a prompt drawn
    // again for a log message may come first).
    // (The word rule only at a network device's "#"/">" exec prompt: at a
    // shell's "$" a word starts a program — python3, bc — with a prompt of its own.)
    let exec_prompt = is_prompt(line.at) && matches!(line.at.trim_ascii_end().last(), Some(b'#' | b'>'));
    let may_ask = may_ask_login(line.text) || (one_word(line.text) && exec_prompt);
    // `enable` always: its prompt back without a password question leaves its
    // password line out (send_lines), so a prompt drawn before it was read
    // must never pass for that.
    let need_echo = (line.echoes && (line.blind_before || may_ask)) || is_enable(line.text);

    // The device holds the output (a pager) or waits for a key, not a line
    // ("Press RETURN to get started" of a console that logged out): unless
    // its prompt came after that, the next line would go there. A pager is
    // where the output stops, never a line of it (help text naming "more").
    let hold = (0..=last).rev().find(|&i| Some(i) != echo_at && (asks_key(&lines[i]) || (i == last && pager(&lines[i]))));
    if let Some(h) = hold
        && !lines[h + 1..].iter().any(|l| is_prompt(l))
    {
        return if rested(quiet, QUIET, &mut wait) { Next::End(End::NoPrompt) } else { Next::Wait(wait) };
    }
    // Where this line's answer starts: after its echo (before it: the line
    // before's output, still coming) and after anything that held the output.
    let from = echo_at.map_or(0, |e| e + 1).max(hold.map_or(0, |h| h + 1));

    // Back at the device's prompt: on at once. Anywhere in the answer (a
    // debug message may follow it), also where a log message went on in its
    // line ("R1#*Mar  1 00:00:01: …"), or the line the cursor was on as the
    // paste began, shown again exactly (a prompt of a shape not known).
    if !(need_echo && !echoed) {
        let named = !device_part(prompt).is_empty();
        let mut back = false;
        for l in &lines[from..] {
            if !prompt.is_empty() && is_prompt(l) && same_device(l, prompt) {
                *prompt = l.trim_ascii().to_vec();
                back = true;
            } else if named && l.len() > prompt.len() && l.starts_with(prompt) && log_text(&l[prompt.len()..]) {
                back = true;
            }
        }
        // The cursor's line from before the paste counts only where the
        // output rests now, after this line's echo (a waking banner may
        // repeat a row of its own on the way).
        back |= !line.home.is_empty() && echoed && from <= last && tail.trim_ascii() == line.home;
        if back {
            return go(Step::Prompt);
        }
    }

    // A prompt not known, where the answer ends (a new host name, a shell
    // inside the device): on once the output rests there; longer after a line
    // that may lead to a login (a read may end at "[sudo]"). Never a known
    // prompt given up for one with no name ("[OK]", "# " of a banner).
    // A nameless one (">>> " of python3 started at a shell) after a line that
    // may not lead to a login, once it has rested a while.
    let named_tail = prompt.is_empty() || !device_part(tail).is_empty();
    let need = if may_ask || !named_tail { WAKE_QUIET } else { QUIET };
    if echoed && from <= last && is_prompt(tail) && (named_tail || !may_ask) && !is_confirm(tail) && rested(quiet, need, &mut wait) {
        *prompt = tail.trim_ascii().to_vec();
        return go(Step::Prompt);
    }

    // A question for the next line to answer: "[confirm]", "(yes/no)?",
    // "Destination filename [startup-config]?". One for a host key, or for a
    // user name in a shape of its own ("Source username [admin]?"), ends the
    // paste.
    if echoed && from <= last && is_confirm(tail) {
        if !rested(quiet, QUIET, &mut wait) {
            return Next::Wait(wait);
        }
        return if mentions_login(tail) || host_key(tail) { Next::End(End::Login) } else { go(Step::Answer) };
    }

    // Without the prompt; never after a line that may lead to a login (sudo,
    // ssh, a console connection, "exit" logging the console out).
    if !may_ask {
        let blank = tail.trim_ascii().is_empty();
        // Right after the echo, the device rests at something: a prompt of a
        // shape not known ("(gdb)", "... "), a question of its own. Not a
        // progress bar (the device at work).
        if right_after && !blank && !mentions_login(tail) && !progress(tail) && !progress_like(tail) && rested(quiet, QUIET, &mut wait) {
            return go(Step::Blind);
        }
        // Only the echo of a line typed at no prompt: text taken in line by
        // line (a banner's lines). At a prompt, it is a command at work.
        if right_after && blank && !is_prompt(line.at) && rested(quiet, QUIET, &mut wait) {
            return go(Step::Blind);
        }
        // The device said it takes text now ("Enter TEXT message.  End with
        // the character '^'.", "[Type ^D at a new line to end input]").
        if echoed && blank && lines[from..].iter().any(|l| takes_text(l)) && rested(quiet, QUIET, &mut wait) {
            return go(Step::Blind);
        }
        // A modem's result for an AT command, on a line of its own.
        let result = lines[from..].iter().rev().map(|l| l.trim_ascii()).find(|l| !l.is_empty());
        if echoed && blank && matches!(result, Some(b"OK" | b"ERROR")) && rested(quiet, QUIET, &mut wait) {
            return go(Step::Blind);
        }
        // Nothing at all, from a device that answered nothing in this paste:
        // one without echo. The first line waits longer, as a console may
        // wake slowly (a console server across a WAN, a busy CPU); later
        // ones in Fixed mode have had their delay already.
        if !look.any && !line.answered {
            let need = if line.first {
                MUTE_FIRST
            } else if line.fixed {
                Duration::ZERO
            } else {
                NO_ECHO
            };
            if look.since >= need {
                return go(Step::Blind);
            }
            wait = wait.min(need - look.since);
        }
    }
    if quiet >= HARD_WAIT || look.since >= LONG_WAIT {
        return Next::End(End::NoPrompt);
    }
    Next::Wait(wait.min(HARD_WAIT - quiet).min(LONG_WAIT - look.since))
}

/// The output has rested `need`; else `wait` is cut to when it will have.
fn rested(quiet: Duration, need: Duration, wait: &mut Duration) -> bool {
    if quiet >= need {
        return true;
    }
    *wait = (*wait).min(need - quiet);
    false
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

/// `text` without a bracketed paste's start and end markers.
fn without_paste_marks(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text[i..].starts_with(b"\x1b[200~") || text[i..].starts_with(b"\x1b[201~") {
            i += 6;
        } else {
            out.push(text[i]);
            i += 1;
        }
    }
    out
}

/// The text of a line of output: escape sequences and CRs left out.
fn plain(tail: &[u8]) -> Vec<u8> {
    let mut text = Vec::with_capacity(tail.len());
    let mut i = 0;
    while i < tail.len() {
        if tail[i] == 0x1b {
            match tail.get(i + 1) {
                // CSI: ESC [ params final (0x40..=0x7e).
                Some(b'[') => {
                    i += 2;
                    while i < tail.len() && !(0x40..=0x7e).contains(&tail[i]) {
                        i += 1;
                    }
                }
                // OSC (a title), DCS, SOS, PM, APC: up to BEL or ESC \.
                Some(b']' | b'P' | b'X' | b'^' | b'_') => {
                    i += 2;
                    while i < tail.len() && tail[i] != 0x07 && !(tail[i] == 0x1b && tail.get(i + 1) == Some(&b'\\')) {
                        i += 1;
                    }
                    if tail.get(i) == Some(&0x1b) {
                        i += 1;
                    }
                }
                // ESC, intermediates (0x20..=0x2f, "ESC ( B"), a final byte.
                _ => {
                    i += 1;
                    while i < tail.len() && (0x20..=0x2f).contains(&tail[i]) {
                        i += 1;
                    }
                }
            }
        } else if tail[i] >= 0x20 || tail[i] == b'\t' {
            // Control characters (CR, Telnet's CR NUL, BEL) show nothing.
            text.push(tail[i]);
        }
        i += 1;
    }
    text
}

/// The output's lines as shown, blanks at their ends left out (at their
/// starts kept: an indented "  user:" is a file's, not a question).
fn text_lines(out: &[u8]) -> Vec<Vec<u8>> {
    out.split(|&b| b == b'\n').map(|l| plain(l).trim_ascii_end().to_vec()).collect()
}

/// Which complete line of `lines` is the echo of `sent`: the first that ends
/// with it (the line before's output may come first; a long line may be
/// drawn scrolled, "$…", so its last characters are compared). An empty line
/// echoes as the first line, empty.
fn echo_line(lines: &[Vec<u8>], breaks: usize, sent: &[u8]) -> Option<usize> {
    let last = lines.len().checked_sub(1)?;
    if breaks == 0 || last == 0 {
        return None;
    }
    if sent.is_empty() {
        return lines[0].trim_ascii().is_empty().then_some(0);
    }
    lines[..last].iter().position(|l| echoes(l.trim_ascii(), sent))
}

/// `line` shows `sent` as typed: its last characters (a long line drawn
/// scrolled, "$…"); the same without blanks (bash breaks a line at the edge
/// with " \r"); or word by word, each typed word the start of the shown one
/// (Junos completes "req sys reboot" to "request system reboot").
fn echoes(line: &[u8], sent: &[u8]) -> bool {
    let end = |t: &[u8]| t[t.len().saturating_sub(16)..].to_vec();
    if line.ends_with(&end(sent)) {
        return true;
    }
    let solid = |t: &[u8]| t.iter().copied().filter(|b| !b.is_ascii_whitespace()).collect::<Vec<u8>>();
    let (line_solid, sent_solid) = (solid(line), solid(sent));
    if !sent_solid.is_empty() && line_solid.ends_with(&end(&sent_solid)) {
        return true;
    }
    let typed: Vec<&[u8]> = sent.split(|b| b.is_ascii_whitespace()).filter(|w| !w.is_empty()).collect();
    let shown: Vec<&[u8]> = line.split(|b| b.is_ascii_whitespace()).filter(|w| !w.is_empty()).collect();
    typed.len() > 1 && shown.len() >= typed.len() && shown[shown.len() - typed.len()..].iter().zip(&typed).all(|(s, t)| s.starts_with(t))
}

/// One word, no blanks: at an exec prompt, IOS takes a word it does not know
/// as a host to connect to ("10.0.0.2", an "ip host" name).
fn one_word(text: &[u8]) -> bool {
    !text.is_empty() && !text.iter().any(u8::is_ascii_whitespace)
}

/// The line the cursor was on may be a prompt of a shape not known ("❯",
/// "➜  ~", a long MikroTik path): not empty, no question, no pager or key
/// question, no log message, and ending in a mark rather than a word (a
/// banner sentence ends in a letter).
fn is_home(at: &[u8]) -> bool {
    // A letter, a digit or a mark of its own (❯, ➜): not a banner's "*" or "####" row.
    let named = at.iter().any(|b| b.is_ascii_alphanumeric() || !b.is_ascii());
    !at.is_empty() && at.len() <= 160 && named && !progress_like(at) && !asks(at) && !pager(at) && !asks_key(at) && !has_mnemonic(at) && at.last().is_some_and(|b| !b.is_ascii_alphanumeric())
}

/// Text after a prompt or a question in its line that is a log message, not
/// typing or a value: it starts with "*" or ".Mar" (IOS), "%", "[" (a kernel
/// time), a sequence number and ":" ("000123:"), or a month ("Nov  8 …"), or
/// holds a "%FACILITY-…" tag.
fn log_text(rest: &[u8]) -> bool {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let r = rest.trim_ascii_start();
    let digits = r.iter().take_while(|b| b.is_ascii_digit()).count();
    // "*Mar", ".Mar" (IOS), "[  612.04]" (a kernel time); not "********" or "[Local]".
    (matches!(r.first(), Some(b'*' | b'.')) && r.get(1).is_some_and(u8::is_ascii_uppercase))
        || (r.first() == Some(&b'[') && r.get(1).is_some_and(|b| *b == b' ' || b.is_ascii_digit()))
        || (r.first() == Some(&b'%') && r.get(1).is_some_and(u8::is_ascii_uppercase))
        || (digits > 0 && r.get(digits) == Some(&b':'))
        || MONTHS.iter().any(|m| r.starts_with(m.as_bytes()) && r.get(3) == Some(&b' '))
        || has_mnemonic(r)
}

/// A Cisco-style message tag: "%" and a capital letter ("%LINK-3-UPDOWN").
fn has_mnemonic(text: &[u8]) -> bool {
    text.windows(2).any(|w| w[0] == b'%' && w[1].is_ascii_uppercase())
}

/// A prompt's device part: "R1" of "R1#" and "R1(config-if)#", "HUAWEI" of
/// "<HUAWEI>" and "[~HUAWEI]", "router" of "admin@router>", "host" of
/// Aruba's "(host) (config) #", "X440G2-48p" of EXOS's "* X440G2-48p.5 #".
fn device_part(prompt: &[u8]) -> &[u8] {
    let mut p = prompt.trim_ascii();
    // "user@host" anywhere ("admin@web:~$", "[10:59:59 admin@web ~]$"): the
    // host (the user changes with su or a new login; a clock before it, every second).
    if let Some(at) = p.iter().position(|&b| b == b'@') {
        let host = &p[at + 1..];
        let host = &host[..host.iter().position(|b| b" :]#>$%()".contains(b)).unwrap_or(host.len())];
        if !host.is_empty() {
            p = host;
        }
    }
    // Marks before the name: Huawei's "<", "[~", "[*", EXOS's "* " (unsaved).
    while let [b'[' | b'<' | b'~' | b'*' | b' ', rest @ ..] = p {
        p = rest;
    }
    p = match p {
        // The name in the first parentheses.
        [b'(', rest @ ..] => &rest[..rest.iter().position(|&b| b == b')').unwrap_or(rest.len())],
        _ => &p[..p.iter().position(|b| b"(#>$%]: ".contains(b)).unwrap_or(p.len())],
    };
    // EXOS counts commands in its prompt.
    if let Some(dot) = p.iter().rposition(|&b| b == b'.')
        && dot + 1 < p.len()
        && p[dot + 1..].iter().all(u8::is_ascii_digit)
    {
        p = &p[..dot];
    }
    p
}

/// `line` is a prompt of the device whose prompt was `prompt` ("R1#" →
/// "R1(config)#", "<HUAWEI>" → "[HUAWEI-GigabitEthernet0/0/1]", "# " → "# "):
/// the same device name, or (Huawei and H3C views, in brackets, where a
/// banner line hardly is) that name and "-…".
fn same_device(line: &[u8], prompt: &[u8]) -> bool {
    let (line, prompt) = (line.trim_ascii(), prompt.trim_ascii());
    if !line.is_empty() && line == prompt {
        return true;
    }
    let (a, b) = (device_part(line), device_part(prompt));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    let (short, long, long_line) = if a.len() < b.len() { (a, b, prompt) } else { (b, a, line) };
    long_line.starts_with(b"[") && long_line.ends_with(b"]") && long.starts_with(short) && long.get(short.len()) == Some(&b'-')
}

/// Blanks outside () and [] (a banner sentence has many; a prompt a few:
/// "(host) (config) #", "[admin@MikroTik] /ip hotspot user>").
fn loose_blanks(text: &[u8]) -> usize {
    let mut depth = 0usize;
    let mut n = 0;
    for &b in text {
        match b {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth = depth.saturating_sub(1),
            b' ' | b'\t' if depth == 0 => n += 1,
            _ => {}
        }
    }
    n
}

/// A device's prompt: `Router#`, `Router(config-if)#`, `switch>`, `$`,
/// `[admin@host ~]#`, `<HUAWEI>`, `FGT #`. Not a question (`Username>`), a
/// line ending in ":" (a banner line or a question does too), a sentence or
/// a log message that happens to end in one of these (`… - sshd[1234]`).
fn is_prompt(line: &[u8]) -> bool {
    let text = plain(line);
    let text = text.trim_ascii();
    matches!(text.last(), Some(b'#' | b'>' | b'$' | b'%' | b']'))
        && text.len() <= 96
        && loose_blanks(text) <= 3
        && !has_mnemonic(text)
        && !asks_login_name(text)
        && !asks_password(text)
        && !progress_like(text)
}

/// A progress or status line that happens to end like a prompt: "45%",
/// "0% [Waiting for headers]", "[#####     ]  25%", "[OK]", "[ DONE ]" (not
/// Huawei's "[HUAWEI]", a name).
fn progress_like(text: &[u8]) -> bool {
    const STATUS: [&str; 12] = ["OK", "DONE", "FAIL", "FAILED", "ERROR", "WARN", "WARNING", "PASS", "PASSED", "SKIP", "SKIPPED", "BUSY"];
    // A number of its own and "%" ("25%"), not a name ending in a digit ("server1%" of tcsh).
    let percent = (1..text.len()).any(|i| {
        let digits = text[..i].iter().rev().take_while(|b| b.is_ascii_digit()).count();
        text[i] == b'%' && digits > 0 && text[..i - digits].last().is_none_or(|b| !b.is_ascii_alphanumeric())
    });
    let bar = holds(text, "####") || holds(text, "====");
    let status = text.len() >= 2 && text[0] == b'[' && text[text.len() - 1] == b']' && STATUS.iter().any(|s| text[1..text.len() - 1].trim_ascii() == s.as_bytes());
    percent || bar || status
}

/// The device's ">" prompt (its user mode), where `enable` asks for its own password.
fn at_user_prompt(at: &[u8]) -> bool {
    at.trim_ascii_end().ends_with(b">") && is_prompt(at)
}

/// A line asking for a login name or a password, also with a log message
/// printed on after it ("Username: *Mar  1 00:10:01: %LINK-…"), or ssh
/// asking to accept a host key ("… (yes/no/[fingerprint])?", "Please type
/// 'yes', 'no' or the fingerprint:"): a pasted line must never answer them.
fn asks(line: &[u8]) -> bool {
    let text = plain(line).to_ascii_lowercase();
    let text = text.trim_ascii_end();
    // A host-key question offers a choice; a "Fingerprint:" label does not.
    let host_key_question = host_key(text) && matches!(text.last(), Some(b'?' | b':')) && ["yes", "y/n"].iter().any(|w| holds(text, w));
    asks_login_name(line) || asks_password(line) || question_then_log(line) || host_key_question
}

/// "Username: *Mar  1 …", "web login: [  612.04] usb …": the question, and a
/// log message that came before anything was typed.
fn question_then_log(line: &[u8]) -> bool {
    let t = plain(line);
    let t = t.trim_ascii();
    let Some(colon) = t.iter().take(48).position(|&b| b == b':') else { return false };
    let q = t[..colon].trim_ascii().to_ascii_lowercase();
    let rest = &t[colon + 1..];
    let asked = ["username", "user name", "user", "login", "login id", "password", "passcode", "passphrase", "account"].iter().any(|w| q == w.as_bytes()) || (q.ends_with(b" login") && q != b"last login");
    asked && !rest.trim_ascii().is_empty() && log_text(rest)
}

/// The last line asking for a login name or a password that no prompt of
/// the device followed (log messages may have: the question still stands).
/// An indented question line followed by another indented line is a file's
/// ("  user:" of YAML), not a device's.
fn pending_question(lines: &[&[u8]], prompt: &[u8]) -> Option<usize> {
    let indented = |l: &[u8]| l.first().is_some_and(u8::is_ascii_whitespace);
    let mut asked = None;
    for (i, &l) in lines.iter().enumerate() {
        if asks(l) && !(indented(l) && lines.get(i + 1).is_some_and(|&n| indented(n))) {
            asked = Some(i);
        } else if is_prompt(l) && (prompt.is_empty() || same_device(l, prompt)) {
            asked = None;
        }
    }
    asked
}

/// The line, lower-cased, ending in ":" or ">" (a question): the text before
/// that mark (a default offered in brackets left out: "Login [admin]:") and
/// the mark, or none.
fn question(tail: &[u8]) -> Option<(Vec<u8>, u8)> {
    let text = plain(tail).to_ascii_lowercase();
    let text = text.trim_ascii_end();
    let (&last, before) = text.split_last()?;
    if last != b':' && last != b'>' {
        return None;
    }
    let mut q = before.trim_ascii_end();
    if last == b':'
        && let Some(&close) = q.last()
        && let Some(open) = match close {
            b']' => q.iter().rposition(|&b| b == b'['),
            b')' => q.iter().rposition(|&b| b == b'('),
            _ => None,
        }
    {
        q = q[..open].trim_ascii_end();
    }
    Some((q.to_vec(), last))
}

/// `word` stands on its own in `text`: no letter or digit right before or after it.
fn has_word(text: &[u8], word: &str) -> bool {
    let w = word.as_bytes();
    text.windows(w.len()).enumerate().any(|(i, x)| {
        x == w && (i == 0 || !text[i - 1].is_ascii_alphanumeric()) && text.get(i + w.len()).is_none_or(|b| !b.is_ascii_alphanumeric())
    })
}

/// `text` holds `part` anywhere.
fn holds(text: &[u8], part: &str) -> bool {
    text.windows(part.len()).any(|x| x == part.as_bytes())
}

/// A login name asked for: `Username:`, `User Name:`, `login:`, `login as:`,
/// `User:`, `Login ID:`, `host login:`, `Username>`, `Login [admin]:` (not
/// `Last login: Mon …`, which goes on, nor a prompt named so: `core-login>`,
/// `<HQ-User>`, MikroTik's `[admin@MikroTik] /ip hotspot user>`).
fn asks_login_name(tail: &[u8]) -> bool {
    let Some((q, mark)) = question(tail) else { return false };
    const WORDS: [&str; 11] = ["username", "user name", "login", "login as", "login name", "login id", "user", "user id", "userid", "account", "name"];
    // Ended by ">", only the word alone ("Username>"): a prompt ends so too.
    if mark == b'>' {
        return WORDS.iter().any(|w| q == w.as_bytes());
    }
    // The words on their own: at the start or after a blank ("Name" of
    // ftp's "Name (10.0.0.5:admin):"), or in other languages anywhere.
    WORDS.iter().any(|w| q.ends_with(w.as_bytes()) && q.len().checked_sub(w.len() + 1).is_none_or(|i| q[i].is_ascii_whitespace()))
        || LOGIN_WORDS.iter().any(|w| holds(&q, w))
        // git's "Username for 'https://github.com':", pip's "User for pypi.example.com:".
        || ["username for ", "user for ", "login for "].iter().any(|w| q.starts_with(w.as_bytes()))
}

/// A login name asked for in other languages (lower-cased).
const LOGIN_WORDS: [&str; 15] = ["사용자 이름", "사용자명", "아이디", "로그인", "用户名", "用戶名", "账号", "帳號", "ユーザー名", "ユーザ名", "ログイン名", "benutzername", "nom d'utilisateur", "identifiant", "usuario"];

/// Secrets asked for anywhere in a question.
const SECRET_WORDS: [&str; 13] = ["password", "passphrase", "pass phrase", "passcode", "passwd", "verification code", "암호", "비밀번호", "パスワード", "密码", "密碼", "口令", "kennwort"];

/// A password, PIN or one-time code asked for: `Password:`, `Enter
/// password:`, `Password>`, `[sudo] password for admin:`, `admin@host's
/// password:`, `Enter passphrase …:`, `Enter PIN:`, `Verification code:`,
/// `OTP:`, `[sudo] admin의 암호:`, `비밀번호:`.
fn asks_password(tail: &[u8]) -> bool {
    let Some((q, _)) = question(tail) else { return false };
    // Short ones only as words of their own ("Pinging 10.0.0.1 …:" asks nothing).
    SECRET_WORDS.iter().any(|w| holds(&q, w)) || ["pin", "otp", "token", "secret"].iter().any(|w| has_word(&q, w))
}

/// Login words in a line, whatever its shape ("Source username [admin]?").
fn mentions_login(line: &[u8]) -> bool {
    let t = line.to_ascii_lowercase();
    ["user", "username", "login", "logon", "account", "pin", "otp", "token", "secret"].iter().any(|w| has_word(&t, w)) || SECRET_WORDS.iter().any(|w| holds(&t, w)) || LOGIN_WORDS.iter().any(|w| holds(&t, w))
}

/// ssh asking to accept a host key ("Are you sure you want to continue
/// connecting (yes/no/[fingerprint])?"; Huawei's "The server is not
/// authenticated. Continue to access it? [Y/N]:", "Save the server's public
/// key? [Y/N]:"): a security choice, never pasted.
fn host_key(line: &[u8]) -> bool {
    let t = line.to_ascii_lowercase();
    ["continue connecting", "fingerprint", "host key", "authenticity of host", "key in cache", "not authenticated", "public key"].iter().any(|w| holds(&t, w))
}

/// A question for the next line to answer: `[confirm]`, `(yes/no)?`, `[y/n]`,
/// `Destination filename [startup-config]?`, `How many bits in the modulus [512]:`,
/// Junos's `Reboot the system ? [yes,no] (no)`.
fn is_confirm(line: &[u8]) -> bool {
    let t = line.to_ascii_lowercase();
    let t = t.trim_ascii_end();
    t.ends_with(b"?") || t.ends_with(b"]:") || t.ends_with(b"):") || ["[confirm]", "y/n", "yes/no", "yes,no"].iter().any(|w| holds(t, w))
}

/// Output still being drawn as a progress bar ("Self decompressing the image
/// : ####", "Loading …: !!!!", dots): the device is at work, not waiting.
fn progress(line: &[u8]) -> bool {
    // Four alike at least: Python's "..." is a prompt.
    let t = line.trim_ascii_end();
    let run = t.len() >= 4 && {
        let end = &t[t.len() - 4..];
        b"#!.*=-|".contains(&end[0]) && end.iter().all(|&b| b == end[0])
    };
    // Words, then "..." or "…": "Trying 10.0.0.2 ...", "Building configuration...".
    let ellipsis = (t.ends_with(b"...") || t.ends_with("…".as_bytes())) && t.iter().any(u8::is_ascii_alphanumeric);
    run || ellipsis
}

/// A pager holding the output: ` --More-- `, `-- MORE --, next page: Space`,
/// `  ---- More ----`, `---(more)---`, MikroTik's `-- [Q quit|D dump|down]`,
/// `less`'s `:` and `(END)`. ("more" by the dashes, not anywhere near them;
/// and only where the output stops, see `judge`.)
fn pager(line: &[u8]) -> bool {
    let t = line.to_ascii_lowercase();
    let t = t.trim_ascii();
    ["--more", "more--", "-- more", "more --", "(more)", "(more ", "[q quit"].iter().any(|w| holds(t, w)) || t == b":" || t == b"(end)"
}

/// A key asked for rather than a line: "Press RETURN to get started." of a
/// console that logged out, "Press any key to continue", EXOS's "Press
/// <SPACE> to continue or <Q> to quit:".
fn asks_key(line: &[u8]) -> bool {
    let t = line.to_ascii_lowercase();
    ["press return", "press enter", "press any key", "hit any key", "hit enter", "press <space>", "press space", "<space> to continue"].iter().any(|w| holds(&t, w))
}

/// The device says it takes text now, up to an end mark: Cisco's "Enter
/// TEXT message.  End with the character '^'.", Huawei's "… quit with the
/// character '%'.", Junos's "[Type ^D at a new line to end input]".
fn takes_text(line: &[u8]) -> bool {
    let t = line.to_ascii_lowercase();
    ["end with", "quit with", "type ^d", "end of input", "to end input"].iter().any(|w| holds(&t, w))
}

/// `enable` (or its short forms): a password question right after it is its
/// own, and its password pasted on the next line is a usual thing.
fn is_enable(sent: &[u8]) -> bool {
    let line = String::from_utf8_lossy(sent).to_ascii_lowercase();
    let mut words = line.split_whitespace();
    ["en", "ena", "enab", "enabl", "enable"].contains(&words.next().unwrap_or("")) && words.next().is_none_or(|w| w.bytes().all(|b| b.is_ascii_digit()))
}

/// The line queued after `enable` looks like its password: one word with a
/// letter or digit in it (not a "!" comment), not a command one pastes after
/// enable ("configure terminal", "end", "write", "ping", "setup").
fn looks_secret(next: &[u8]) -> bool {
    const COMMANDS: &[&str] = &[
        "end", "exit", "quit", "logout", "disable", "enable", "en", "write", "wr", "reload", "show", "sh", "conf", "configure", "config", "terminal", "term", "dir", "copy", "save", "commit", "return", "system-view", "sys", "ping",
        "traceroute", "trace", "telnet", "ssh", "clear", "setup", "help", "history", "who", "debug", "undebug", "verify", "erase", "delete", "more", "cd", "pwd", "ls", "display", "dis", "undo", "run", "start", "request", "tclsh", "bash", "where", "guestshell", "python", "lock",
    ];
    let word = String::from_utf8_lossy(next).trim().to_ascii_lowercase();
    !word.is_empty() && word.len() <= 128 && !word.contains(char::is_whitespace) && word.chars().any(char::is_alphanumeric) && !COMMANDS.contains(&word.as_str())
}

/// The line runs something that may ask for a login or a password in its own
/// time (sudo asking LDAP, ssh, telnet, a console connection, `enable` with
/// TACACS+, a copy from a server) or log the console out (`exit`): followed
/// only once the device shows a prompt or a question.
fn may_ask_login(sent: &[u8]) -> bool {
    const COMMANDS: &[&str] = &[
        "sudo", "su", "doas", "pkexec", "runas", "login", "passwd", "newgrp", "lock", "ssh", "ssh2", "stelnet", "slogin", "telnet", "rlogin", "rsh", "mosh", "scp", "sftp", "ftp", "lftp", "smbclient", "mount", "mysql", "psql", "git", "svn",
        "kinit", "gpg", "openssl", "ssh-keygen", "ssh-add", "ssh-copy-id", "sshfs", "rsync", "connect", "session", "attach", "console", "screen", "minicom", "picocom", "cu", "nc", "ncat", "netcat", "socat", "copy", "archive", "execute",
        "system", "en", "ena", "enab", "enabl", "enable", "exit", "logout", "quit", "disconnect", "reload", "reboot",
    ];
    let line = String::from_utf8_lossy(sent).to_ascii_lowercase();
    let mut words = line.split_whitespace();
    let mut first = words.next().unwrap_or("");
    // Cisco's "do" and Junos's "run" run an operational command from
    // configuration mode ("do ssh …", "run telnet …").
    if first == "do" || first == "run" {
        first = words.next().unwrap_or("");
    }
    // MikroTik's "/system ssh", a path to a program.
    let command = first.rsplit(['/', '\\']).find(|w| !w.is_empty()).unwrap_or(first);
    COMMANDS.contains(&command)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::mpsc;

    #[test]
    fn prompts_are_recognised() {
        for p in ["Router#", "Router(config-if)#", "switch> ", "$ ", "[admin@host ~]# ", "FGT # ", "\x1b[1mR1#\x1b[0m ", "<HUAWEI>", "(host) (config) #", "[admin@MikroTik] /ip hotspot user>", "admin@web:~/my dir$"] {
            assert!(is_prompt(p.as_bytes()), "{p:?}");
        }
        // A question or a banner line is none, also "Router:" (a banner's
        // "Router: authorised use only" read in part), a sentence, a log line.
        for p in [
            "Building configuration...",
            "",
            "  --More-- 12%x",
            "Password:",
            "Username>",
            "Router:",
            "* WARNING:",
            "R1 - authorised use only and nothing else #",
            "2026 Nov  8 10:00:00 sw1 %AUTHPRIV-6-SYSTEM_MSG: pam_unix(sshd:auth): authentication failure - dcos_sshd[12345]",
        ] {
            assert!(!is_prompt(p.as_bytes()), "{p:?}");
        }
    }

    #[test]
    fn login_name_questions_are_recognised() {
        for p in ["Username: ", "User Name:", "login: ", "Login as:", "User:", "\x1b[1mLogin ID:\x1b[0m ", "Username>", "Login ID> ", "Account:", "Login [admin]:", "Username (admin): "] {
            assert!(asks_login_name(p.as_bytes()), "{p:?}");
        }
        for p in ["Password:", "R1#", "Last login: Mon Nov  8 10:00:00 2026", "username admin privilege 15", "", "superuser:", "R1>", "core-login>", "<HQ-User>", "edge_account>", "admin@user>", "Login Success [user:", "./user:"] {
            assert!(!asks_login_name(p.as_bytes()), "{p:?}");
        }
        for p in ["Password: ", "Enter password:", "Password>", "\x1b[0mPassword:", "[sudo] password for admin: ", "admin@10.0.0.1's password:", "Enter passphrase for key 'k':"] {
            assert!(asks_password(p.as_bytes()), "{p:?}");
        }
        assert!(!asks_password(b"R1-PASS>"));
        assert!(!asks_password(b"R1#"));
        // Escape sequences of every kind are left out ("ESC ( B" from sgr0, a title).
        assert!(asks_login_name(b"Login: \x1b(B\x1b[m"));
        assert!(asks_login_name(b"\x1b]0;sw1\x07Username: "));
        // A log message printed on after the question.
        for p in ["Username: *Mar  1 00:10:01.123: %LINK-3-UPDOWN: Interface Gi0/1, changed state to up", "web login: [  612.04] usb 1-1: new device", "Password: %SYS-5-CONFIG_I: x"] {
            assert!(asks(p.as_bytes()), "{p:?}");
        }
        for p in ["Last login: 2026-11-08 10:00:00 from 10.0.0.1", "Uptime: 3 days", "user: 10", "login: 10.0.0.5"] {
            assert!(!question_then_log(p.as_bytes()), "{p:?}");
        }
    }

    #[test]
    fn other_secrets_and_odd_bytes_are_questions_too() {
        for p in ["[sudo] admin의 암호: ", "비밀번호:", "Enter PIN:", "Verification code:", "OTP:", "Token:"] {
            assert!(asks_password(p.as_bytes()), "{p:?}");
        }
        // Short words only on their own.
        assert!(!asks_password(b"Pinging 10.0.0.1 with 32 bytes of data:"));
        // Telnet's CR NUL, a bell: no hiding place.
        assert!(asks_login_name(b"\0Username:"));
        assert!(asks_login_name(b"\x07Username: \x07"));
        // A menu prompt named "user" is no question.
        assert!(!asks_login_name(b"[admin@MikroTik] /ip hotspot user> "));
        assert!(!asks_login_name(b"/user-manager user> "));
    }

    #[test]
    fn prompts_of_one_device() {
        for (a, b) in [
            ("R1(config)#", "R1#"),
            ("[HUAWEI-GigabitEthernet0/0/1]", "<HUAWEI>"),
            ("[~HUAWEI]", "<HUAWEI>"),
            ("[*HUAWEI-10GE1/0/1]", "[~HUAWEI]"),
            ("admin@router#", "admin@router>"),
            ("root@web:/etc#", "admin@web:~$"),
            ("(host) (config) #", "(host) #"),
            ("* X440G2-48p.5 #", "X440G2-48p.4 #"),
            ("FGT (interface) #", "FGT #"),
            ("#", "#"),
            ("[admin@MikroTik] /ip address>", "[admin@MikroTik] >"),
            ("[11:00:00 admin@web ~]$", "[10:59:59 admin@web /etc]$"),
        ] {
            assert!(same_device(a.as_bytes(), b.as_bytes()), "{a:?} {b:?}");
        }
        // Banner lines that start with the host name are not its prompt.
        for (a, b) in [("* WARNING:", "R1#"), ("Username:", ""), ("R2#", "R1#"), ("R10#", "R1#"), ("#", ""), ("R1.lab.example.com ####", "R1#"), ("R1-CORE [Seoul DC]", "R1#")] {
            assert!(!same_device(a.as_bytes(), b.as_bytes()), "{a:?} {b:?}");
        }
    }

    #[test]
    fn commands_that_may_lead_to_a_login() {
        for l in [
            "sudo -v",
            "ssh -l admin 10.0.0.2",
            "stelnet 10.0.0.2",
            "ssh2 10.0.0.2",
            "execute ssh admin@10.0.0.2",
            "/system ssh 10.0.0.2 user=admin",
            "run ssh 10.0.0.2",
            "do telnet 10.0.0.2",
            "rsync -a x host:/y",
            "ssh-copy-id admin@host",
            "sshfs host:/ /mnt",
            "/usr/bin/ssh host",
            "enable",
            "exit",
        ] {
            assert!(may_ask_login(l.as_bytes()), "{l:?}");
        }
        for l in ["interface Gi0/1", "show version", "description ssh uplink", "ping 10.0.0.1", "banner motd ^"] {
            assert!(!may_ask_login(l.as_bytes()), "{l:?}");
        }
    }

    /// A line as `judge` gets it: after a line taken at the prompt, from a
    /// device that answers, nothing queued after it.
    fn typed<'a>(sent: &'a str, at: &'a str) -> Typed<'a> {
        Typed { text: sent.as_bytes(), at: at.as_bytes(), home: b"", next: None, first: false, fixed: false, answered: true, echoes: false, blind_before: false }
    }

    /// `judge` on output already in, quiet for `quiet_ms`, the device's prompt
    /// known as the line's `at` when that is one.
    fn judged(out: &str, line: Typed, quiet_ms: u64) -> Next {
        let mut prompt = if is_prompt(line.at) { line.at.trim_ascii().to_vec() } else { Vec::new() };
        let quiet = Duration::from_millis(quiet_ms);
        let look = Look { recent: out.as_bytes(), breaks: out.matches('\n').count(), any: !out.is_empty(), quiet, since: quiet };
        judge(&look, &line, &mut prompt)
    }

    fn verdict(out: &str, sent: &str, at: &str, quiet_ms: u64) -> Next {
        judged(out, typed(sent, at), quiet_ms)
    }

    fn goes(next: &Next) -> bool {
        matches!(next, Next::Go { .. })
    }

    #[test]
    fn a_password_question_stops_unless_enable_asked_it_right_away() {
        // "enable" echoed, then its question on the next line, a password queued: on.
        let enable = |sent: &'static str, at: &'static str, next: &'static str| judged(&format!("{sent}\r\nPassword: "), Typed { next: Some(next.as_bytes()), ..typed(sent, at) }, 200);
        assert!(goes(&enable("enable", "R1>", "s3cr3t!")));
        assert!(goes(&enable("en 15", "R1>", "s3cr3t!")));
        // A command queued next would be a failed attempt.
        assert_eq!(enable("enable", "R1>", "configure terminal"), Next::End(End::Login));
        assert_eq!(enable("enable", "R1>", "end"), Next::End(End::Login));
        assert_eq!(verdict("enable\r\nPassword: ", "enable", "R1>", 200), Next::End(End::Login));
        // Typed at a login question (a blank screen, "Username:"), "enable" was the user name.
        for at in ["", "Username: ", "sw1 login:"] {
            assert_eq!(enable("enable", at, "s3cr3t!"), Next::End(End::Login), "{at:?}");
        }
        // sudo and the rest: a failed one counts against the account.
        assert_eq!(verdict("sudo systemctl restart nginx\r\n[sudo] password for admin: ", "sudo systemctl restart nginx", "admin@web:~$", 200), Next::End(End::Login));
        assert_eq!(verdict("\r\nPassword: ", "interface Gi1/0/1", "R1(config)#", 200), Next::End(End::Login));
        // Woken into a password-only login, even by "enable": lines of the device's own first.
        let woken = Typed { next: Some(b"s3cr3t!"), ..typed("enable", "R1>") };
        assert_eq!(judged("enable\r\n\r\nUser Access Verification\r\n\r\nPassword: ", woken, 200), Next::End(End::Login));
        // "enable secret …" in a configuration asks nothing; a question after it is not its own.
        assert_eq!(verdict("enable secret x\r\nPassword: ", "enable secret x", "R1(config)#", 200), Next::End(End::Login));
        // Not before the output rests: a read may end inside a line.
        assert!(matches!(verdict("show users\r\nPassword: ", "show users", "R1#", 50), Next::Wait(_)));
        // A question in a complete line, a log message after it: once the
        // output rests, or a few seconds on while it keeps coming.
        let logged = "\r\nUsername: \r\n*Mar  1 00:10:01: %CDP-4-NATIVE_VLAN_MISMATCH: x\r\n";
        assert_eq!(verdict(logged, "a", "R1#", 200), Next::End(End::Login));
        let mut prompt = b"R1#".to_vec();
        let flowing = Look { recent: logged.as_bytes(), breaks: 3, any: true, quiet: Duration::from_millis(50), since: QUESTION_FLOOD };
        assert_eq!(judge(&flowing, &typed("a", "R1#"), &mut prompt), Next::End(End::Login));
        // Answered (the device's prompt after it): nothing stands.
        assert!(goes(&verdict("\r\nPassword: \r\n% Password:  timeout expired!\r\nR1>", "x", "R1>", 0)));
        // ssh's host key is never accepted by a paste.
        let ssh = "ssh admin@10.0.0.2\r\nThe authenticity of host '10.0.0.2 (10.0.0.2)' can't be established.\r\nED25519 key fingerprint is SHA256:abc.\r\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
        assert_eq!(verdict(ssh, "ssh admin@10.0.0.2", "admin@web:~$", 200), Next::End(End::Login));
        // Asked again after a line typed at it: still never answered.
        assert_eq!(verdict("show ver\r\nPlease type 'yes', 'no' or the fingerprint: ", "show ver", "", 200), Next::End(End::Login));
        // A fingerprint shown, not asked about, is no question.
        assert!(goes(&verdict("show crypto key\r\nKey fingerprint: AB:CD:EF\r\nR1#", "show crypto key", "R1#", 0)));
        // An indented "user:" of a file (kubectl config view) is no question.
        assert!(goes(&verdict("kubectl config view\r\nusers:\r\n- name: admin\r\n  user:\r\n    token: x\r\nadmin@web:~$ ", "kubectl config view", "admin@web:~$", 0)));
    }

    #[test]
    fn the_device_waiting_for_input_takes_the_next_line() {
        // Its prompt back: at once.
        assert!(goes(&verdict("interface Gi1/0/1\r\nR1(config-if)#", "interface Gi1/0/1", "R1(config)#", 0)));
        // A new host name: once it rests there.
        assert!(matches!(verdict("hostname R2\r\nR2(config)#", "hostname R2", "R1(config)#", 50), Next::Wait(_)));
        assert!(goes(&verdict("hostname R2\r\nR2(config)#", "hostname R2", "R1(config)#", 200)));
        // Questions of a command.
        assert!(goes(&verdict("copy running-config startup-config\r\nDestination filename [startup-config]? ", "copy running-config startup-config", "R1#", 200)));
        assert!(goes(&verdict("reload\r\nProceed with reload? [confirm]", "reload", "R1#", 200)));
        assert_eq!(verdict("request system reboot\r\nReboot the system ? [yes,no] (no) ", "request system reboot", "user@r1>", 200), Next::Go { step: Step::Answer, echoed: true });
        assert_eq!(verdict("10.0.0.5\r\nSource username [admin]? ", "10.0.0.5", "", 200), Next::End(End::Login));
        // A prompt of a shape not known, right after the echo.
        assert!(goes(&verdict("def f():\r\n... ", "def f():", ">>>", 200)));
        // The paste's own text is no question ("user:" of a YAML file).
        assert!(goes(&verdict("user:\r\n", "user:", "", 200)));
        // With the echo: text mode (a banner), once it rests.
        assert!(goes(&verdict("banner motd ^\r\nEnter TEXT message.  End with the character '^'.\r\n", "banner motd ^", "R1(config)#", 200)));
    }

    #[test]
    fn a_busy_device_is_waited_for() {
        // Only the echo, typed at the prompt: a command at work (Junos commit), however long.
        assert!(matches!(verdict("commit\r\n", "commit", "user@r1#", 4500), Next::Wait(_)));
        // Lines of its own and quiet: still at work (ping dots, write memory, a key being made).
        assert!(matches!(verdict("ping 10.0.0.9\r\nType escape sequence to abort.\r\nSending 5, 100-byte ICMP Echos to 10.0.0.9, timeout is 2 seconds:\r\n..", "ping 10.0.0.9", "R1#", 2000), Next::Wait(_)));
        assert!(matches!(verdict("write memory\r\nBuilding configuration...\r\n", "write memory", "R1#", 2000), Next::Wait(_)));
        // A progress bar right after the echo: at work, not a prompt.
        assert!(matches!(verdict("\r\nSelf decompressing the image : ##########", "", "", 1100), Next::Wait(_)));
        assert!(matches!(verdict("verify /md5 flash:img.bin\r\n.....................", "verify /md5 flash:img.bin", "R1#", 1100), Next::Wait(_)));
        // Silence from a device that answered before: busy, not one without echo.
        let silent = Typed { answered: true, ..typed("show version", "R1#") };
        assert!(matches!(judged("", silent, 2000), Next::Wait(_)));
        // Fixed mode: the delay is the least, not a reason to skip waiting.
        let fixed = Typed { fixed: true, answered: true, ..typed("show version", "R1#") };
        assert!(matches!(judged("", fixed, 50), Next::Wait(_)));
        // A device that never answered: one without echo.
        let mute = Typed { answered: false, ..typed("x", "") };
        assert!(goes(&judged("", mute, 900)));
        let mute = Typed { answered: false, fixed: true, ..typed("x", "") };
        assert!(goes(&judged("", mute, 0)));
        // Never for a line that may lead to a login.
        let mute = Typed { answered: false, ..typed("ssh admin@10.0.0.2", "") };
        assert!(matches!(judged("", mute, 900), Next::Wait(_)));
        // Nothing more for HARD_WAIT: the paste stops.
        assert_eq!(verdict("\r\n\r\nUser Access Verification\r\n\r\n", "show clock", "R1#", HARD_WAIT.as_millis() as u64), Next::End(End::NoPrompt));
    }

    #[test]
    fn after_a_line_sent_without_the_prompt_only_its_own_echo_counts() {
        // The prompt before this line's echo is the line before's.
        let after_blind = Typed { echoes: true, blind_before: true, ..typed("show version", "R1#") };
        assert!(matches!(judged("Building configuration...\r\n[OK]\r\nR1#", after_blind, 0), Next::Wait(_)));
        let in_step = typed("show version", "R1#");
        assert!(goes(&judged("Building configuration...\r\n[OK]\r\nR1#", in_step, 0)));
        let after_blind = Typed { echoes: true, blind_before: true, ..typed("show version", "R1#") };
        assert!(goes(&judged("[OK]\r\nR1#show version\r\nCisco IOS Software\r\nR1#", after_blind, 0)));
        // A prompt and the line typed ahead in its line is no prompt to go on.
        assert!(matches!(verdict("[OK]\r\nR1#show version", "show users", "R1#", 0), Next::Wait(_)));
    }

    #[test]
    fn a_pager_or_a_logged_out_console_stops_the_paste() {
        for out in [
            "show running-config\r\nBuilding configuration...\r\n\r\nversion 15.2\r\n --More-- ",
            "exit\r\n\r\nR1 con0 is now available\r\n\r\nPress RETURN to get started.\r\n\r\n",
            "print\r\n 0 name=ether1\r\n-- [Q quit|D dump|down]",
            "show log\r\nline\r\nPress <SPACE> to continue or <Q> to quit:",
            "less /var/log/syslog\r\nline\r\n:",
            // The prompt before the key question is no longer where the cursor waits.
            "write memory\r\n[OK]\r\nR1#exit\r\n\r\nR1 con0 is now available\r\n\r\nPress RETURN to get started.\r\n",
        ] {
            let sent = &out[..out.find('\r').unwrap()];
            assert_eq!(verdict(out, sent, "R1#", 200), Next::End(End::NoPrompt), "{out:?}");
        }
    }

    #[test]
    fn bracketed_paste_markers_are_left_out() {
        let job = Job::new();
        assert_eq!(job.add(b"\x1b[200~a\rb\r\x1b[201~"), Some(2));
        let lines: Vec<_> = job.lines.lock().unwrap().iter().cloned().collect();
        assert_eq!(lines, [b"a\r".to_vec(), b"b\r".to_vec()]);
    }

    /// Chunks of a device's output, each after its delay (ms).
    type Answer = Vec<(u64, Vec<u8>)>;
    /// The lines a paste sent, their CRs left out.
    type SentLines = Arc<Mutex<Vec<String>>>;

    /// A fake device: answers the n-th line it reads with `answer(n, line)`.
    /// Lines sent meanwhile wait in its input, as on a console. Records every
    /// line the paste sent.
    fn device(job: &Arc<Job>, answer: impl Fn(usize, &str) -> Answer + Send + 'static) -> (impl Fn(&[u8]) -> io::Result<()>, SentLines) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let j = job.clone();
        std::thread::spawn(move || {
            let mut n = 0;
            while let Ok(line) = rx.recv() {
                let text = String::from_utf8_lossy(&line).trim_end_matches('\r').to_string();
                for (ms, out) in answer(n, &text) {
                    std::thread::sleep(Duration::from_millis(ms));
                    j.observe(&out);
                }
                n += 1;
            }
        });
        let rec = sent.clone();
        let send = move |d: &[u8]| {
            rec.lock().unwrap().push(String::from_utf8_lossy(d).trim_end_matches('\r').to_string());
            let _ = tx.send(d.to_vec());
            Ok(())
        };
        (send, sent)
    }

    const IOS_WAKE: &str = "\r\n\r\n\r\nUser Access Verification\r\n\r\n";

    #[test]
    fn a_banner_in_small_reads_never_lets_a_line_through() {
        // A console waking: its banner arrives 16 bytes at a time, a read
        // often ending at something that looks like a prompt ("####", "* WARNING:").
        let banner = "\r\n\r\n#########################\r\n* WARNING: authorised use only *\r\n#########################\r\n\r\nUser Access Verification\r\n\r\nUsername: ";
        for offset in 0..16 {
            let job = Arc::new(Job::new());
            job.add(b"interface Gi0/1\r description x\r no shutdown\r exit\r");
            let (send, sent) = device(&job, move |n, _| {
                if n > 0 {
                    return vec![];
                }
                let mut out = b"interface Gi0/1".to_vec();
                out.extend_from_slice(banner.as_bytes());
                let first = offset.min(out.len());
                let mut chunks = vec![(0, out[..first].to_vec())];
                chunks.extend(out[first..].chunks(16).map(|c| (16, c.to_vec())));
                chunks
            });
            assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login, "offset {offset}");
            assert_eq!(sent.lock().unwrap().len(), 1, "offset {offset}: a line went into the banner");
        }
    }

    #[test]
    fn a_stale_prompt_and_a_banner_line_named_like_it_let_nothing_through() {
        // "Router#" still on screen, the console logged out without a word;
        // its banner starts with the host name, read 16 bytes at a time, and
        // TACACS+ asks for the user name 1.5 s later.
        for banner in [
            "\r\n\r\nRouter: authorised use only\r\n\r\nUser Access Verification\r\n\r\n",
            "\r\n\r\nRouter.lab.example.com ####\r\n\r\nUser Access Verification\r\n\r\n",
            "\r\n\r\nRouter-CORE [Seoul DC]\r\n\r\nUser Access Verification\r\n\r\n",
        ] {
            let job = Arc::new(Job::new());
            job.prime(b"Router#", 0);
            job.add(b"show clock\rshow users\rshow version\r");
            let (send, sent) = device(&job, move |n, _| {
                if n > 0 {
                    return vec![];
                }
                let mut chunks: Answer = banner.as_bytes().chunks(16).map(|c| (16, c.to_vec())).collect();
                chunks.push((1500, b"Username: ".to_vec()));
                chunks
            });
            assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login, "{banner:?}");
            assert_eq!(sent.lock().unwrap().len(), 1, "{banner:?}");
        }
    }

    #[test]
    fn a_login_question_long_after_the_banner_takes_no_lines() {
        // TACACS+ out of reach: IOS asks for the user name seconds after its banner.
        for mode in [Mode::Echo, Mode::Fixed { line_ms: 100, char_ms: 0 }] {
            for password_only in [false, true] {
                let job = Arc::new(Job::new());
                job.add(b"interface Gi0/1\r description uplink\r no shutdown\r exit\r");
                let question: &[u8] = if password_only { b"Password: " } else { b"Username: " };
                let (send, sent) = device(&job, move |n, _| if n == 0 { vec![(0, IOS_WAKE.as_bytes().to_vec()), (1500, question.to_vec())] } else { vec![] });
                assert_eq!(job.run(mode, Duration::ZERO, send, || {}), End::Login, "{mode:?}");
                assert_eq!(sent.lock().unwrap().len(), 1, "{mode:?}");
            }
        }
    }

    #[test]
    fn a_slow_command_before_ssh_keeps_the_paste_in_step() {
        // ping to an address that does not answer prints a dot now and then;
        // the ssh after it asks for a password 1.5 s after connecting. No line
        // may go ahead of the ping and end up as the ssh password.
        let job = Arc::new(Job::new());
        job.prime(b"R1#", 0);
        job.add(b"ping 10.0.0.9\rssh -l admin 10.0.0.2\rshow version\r");
        let (send, sent) = device(&job, |n, t| match n {
            0 => vec![
                (2, format!("{t}\r\nType escape sequence to abort.\r\nSending 5, 100-byte ICMP Echos to 10.0.0.9, timeout is 2 seconds:\r\n").into_bytes()),
                (1200, b".".to_vec()),
                (1200, b".".to_vec()),
                (300, b"\r\nSuccess rate is 0 percent (0/2)\r\nR1#".to_vec()),
            ],
            1 => vec![(2, format!("{t}\r\n").into_bytes()), (1500, b"Password: ".to_vec())],
            _ => vec![],
        });
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login);
        assert_eq!(*sent.lock().unwrap(), ["ping 10.0.0.9", "ssh -l admin 10.0.0.2"]);
    }

    #[test]
    fn a_silent_commit_and_a_logout_take_no_lines_into_the_login() {
        // Junos: commit works for 2 s without a word; two exits leave the
        // console at its login.
        let job = Arc::new(Job::new());
        job.prime(b"user@r1# ", 0);
        job.add(b"commit\rexit\rexit\rshow version\rshow interfaces terse\r");
        let (send, sent) = device(&job, |n, t| match n {
            0 => vec![(2, format!("{t}\r\n").into_bytes()), (2000, b"commit complete\r\n\r\n[edit]\r\nuser@r1# ".to_vec())],
            1 => vec![(2, format!("{t}\r\nExiting configuration mode\r\n\r\nuser@r1> ").into_bytes())],
            2 => vec![(2, format!("{t}\r\n").into_bytes()), (300, b"\r\n\r\nr1 (ttyu0)\r\n\r\nlogin: ".to_vec())],
            _ => vec![],
        });
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login);
        assert_eq!(sent.lock().unwrap().len(), 3);
    }

    #[test]
    fn fixed_mode_waits_for_a_slow_echo() {
        // NX-OS over a slow link: the echo comes 150 ms after each line, later
        // than the line delay; "exit" logs the console out.
        for line_ms in [0, 100] {
            let job = Arc::new(Job::new());
            job.prime(b"sw1# ", 0);
            job.add(b"show clock\rexit\rshow version\rshow interface brief\r");
            let (send, sent) = device(&job, |n, t| match n {
                0 => vec![(150, format!("{t}\r\n10:00:00.000 UTC Mon Nov 08 2026\r\nsw1# ").into_bytes())],
                1 => vec![(150, format!("{t}\r\n").into_bytes()), (100, b"\r\nUser Access Verification\r\nsw1 login: ".to_vec())],
                _ => vec![],
            });
            assert_eq!(job.run(Mode::Fixed { line_ms, char_ms: 0 }, Duration::ZERO, send, || {}), End::Login, "{line_ms}");
            assert_eq!(sent.lock().unwrap().len(), 2, "{line_ms}");
        }
    }

    #[test]
    fn a_vendor_ssh_client_waits_for_its_question() {
        for command in ["stelnet 10.0.0.2", "execute ssh admin@10.0.0.2", "/system ssh 10.0.0.2", "run ssh 10.0.0.2", "ssh-copy-id admin@10.0.0.2"] {
            let job = Arc::new(Job::new());
            job.prime(b"<HUAWEI>", 0);
            job.add(format!("{command}\rdisplay version\r").as_bytes());
            let (send, sent) = device(&job, |n, t| if n == 0 { vec![(2, format!("{t}\r\nTrying 10.0.0.2 ...\r\nPress CTRL+K to abort\r\nConnected to 10.0.0.2 ...\r\n").into_bytes()), (1500, b"Password: ".to_vec())] } else { vec![] });
            assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login, "{command}");
            assert_eq!(sent.lock().unwrap().len(), 1, "{command}");
        }
    }

    const LOG: &str = "\r\n*Mar  1 00:10:01.123: %CDP-4-NATIVE_VLAN_MISMATCH: Native VLAN mismatch discovered on GigabitEthernet0/1 (1), with sw2 GigabitEthernet0/2 (10).\r\n";

    #[test]
    fn a_log_message_after_a_login_question_hides_nothing() {
        for q in ["Username: ", "Password: "] {
            // Woken by the paste; the message comes before the output rests.
            let job = Arc::new(Job::new());
            job.add(b"interface Gi0/1\r description uplink\r no shutdown\r");
            let (send, sent) = device(&job, move |n, _| if n == 0 { vec![(0, format!("{IOS_WAKE}{q}").into_bytes()), (50, LOG.as_bytes().to_vec())] } else { vec![] });
            assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login, "{q:?}");
            assert_eq!(sent.lock().unwrap().len(), 1, "{q:?}");
        }
        // On the screen before the paste, however many messages came after it.
        for screen in [
            format!("R1 con0 is now available{IOS_WAKE}Password: {}", LOG.repeat(6)),
            "web login: \r\n[  612.04] usb 1-1: new device\r\n[  612.05] usb 1-1: a\r\n[  612.06] usb 1-1: b\r\n[  612.07] usb 1-1: c\r\n[  612.08] usb 1-1: d\r\n".to_string(),
            "sw1 login: \r\n2026 Nov  8 10:00:00 sw1 %AUTHPRIV-6-SYSTEM_MSG: pam_unix(sshd:auth): authentication failure - dcos_sshd[12345]\r\n".to_string(),
            "Username: *Mar  1 00:10:01.123: %LINK-3-UPDOWN: Interface Gi0/1, changed state to up\r\n".to_string(),
            "web login: [  612.04] usb 1-1: new device\r\n".to_string(),
            "ssh admin@10.0.0.2\r\nThe authenticity of host '10.0.0.2' can't be established.\r\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ".to_string(),
        ] {
            let job = Arc::new(Job::new());
            job.prime(screen.as_bytes(), 0);
            job.add(b"interface Gi0/1\r description uplink\r");
            let (send, sent) = device(&job, |_, _| vec![]);
            assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login, "{screen:?}");
            assert!(sent.lock().unwrap().is_empty(), "{screen:?}");
        }
    }

    #[test]
    fn a_slow_sudo_password_question_is_waited_for() {
        // PAM asking LDAP: the question comes 300 ms after the echo.
        let job = Arc::new(Job::new());
        job.prime(b"admin@web:~$ ", 0);
        job.add(b"sudo systemctl restart nginx\rsystemctl status nginx\r");
        let (send, sent) = device(&job, |n, t| if n == 0 { vec![(0, format!("{t}\r\n").into_bytes()), (300, b"[sudo] password for admin: ".to_vec())] } else { vec![] });
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login);
        assert_eq!(sent.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_console_that_logged_out_stops_the_paste() {
        // One "exit" too many at R1#: the console logs out and waits for Return.
        for mode in [Mode::Echo, Mode::Fixed { line_ms: 100, char_ms: 0 }] {
            let job = Arc::new(Job::new());
            job.prime(b"R1#", 0);
            job.add(b"exit\rshow clock\rshow users\r");
            let (send, sent) = device(&job, |n, t| {
                if n > 0 {
                    return vec![];
                }
                vec![(2, format!("{t}\r\n").into_bytes()), (30, b"\r\n\r\n\r\nR1 con0 is now available\r\n\r\n\r\n\r\nPress RETURN to get started.\r\n\r\n\r\n".to_vec())]
            });
            assert_eq!(job.run(mode, Duration::ZERO, send, || {}), End::NoPrompt, "{mode:?}");
            assert_eq!(sent.lock().unwrap().len(), 1, "{mode:?}");
        }
    }

    #[test]
    fn output_without_the_prompt_stops_the_paste_in_time() {
        // Lines of the console's own, no echo, no prompt, no question: whatever it is doing, nothing more goes in.
        let job = Arc::new(Job::new());
        job.prime(b"R1#", 0);
        job.add(b"show clock\rshow users\r");
        let (send, sent) = device(&job, |n, _| if n == 0 { vec![(2, b"\r\n\r\nR1 line 0 is in use\r\n\r\n".to_vec())] } else { vec![] });
        let t = Instant::now();
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::NoPrompt);
        assert!(t.elapsed() >= HARD_WAIT && t.elapsed() < HARD_WAIT + Duration::from_secs(1), "{:?}", t.elapsed());
        assert_eq!(sent.lock().unwrap().len(), 1);
    }

    #[test]
    fn prompts_of_many_devices_are_followed_at_once() {
        // A command printing a line of its own, then the prompt: the prompt
        // before the paste, the prompt after its n-th line.
        type Case = (&'static str, fn(usize) -> String);
        let cases: [Case; 6] = [
            ("(host) (config) #", |_| "(host) (config) #".into()),
            ("X440G2-48p.4 # ", |n| format!("* X440G2-48p.{} # ", 5 + n)),
            ("# ", |_| "# ".into()),
            ("[~HUAWEI]", |_| "[*HUAWEI-10GE1/0/1]".into()),
            ("user@r1# ", |_| "\r\n[edit interfaces]\r\nuser@r1# ".into()),
            ("admin@web:~$ ", |n| format!("admin@web:/d{n}$ ")),
        ];
        for (prime, prompt) in cases {
            let job = Arc::new(Job::new());
            job.prime(prime.as_bytes(), 0);
            job.add(b"one\rtwo\rthree\rfour\r");
            let (send, _) = device(&job, move |n, t| vec![(2, format!("{t}\r\nWarning: something\r\n{}", prompt(n)).into_bytes())]);
            let t = Instant::now();
            assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done, "{prime:?}");
            assert!(t.elapsed() < Duration::from_millis(100), "{prime:?}: {:?}", t.elapsed());
        }
    }

    #[test]
    fn a_debug_stream_does_not_hold_the_paste() {
        // Debug messages every 80 ms; the prompt comes with the next message in its line.
        let job = Arc::new(Job::new());
        job.prime(b"R1#", 0);
        job.add(b"show clock\rshow users\rshow version\r");
        let flood = Arc::new(AtomicBool::new(true));
        {
            let (j, flood) = (job.clone(), flood.clone());
            std::thread::spawn(move || {
                while flood.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(80));
                    j.observe(b"*Mar  1 00:00:01.123: IP: s=10.0.0.1 (Gi0/1), d=224.0.0.5, len 80, rcvd 0\r\n");
                }
            });
        }
        let (send, _) = device(&job, |_, t| vec![(3, format!("{t}\r\n*00:00:01.123 UTC Mon Mar 1 1993\r\nR1#*Mar  1 00:00:01.130: IP: s=10.0.0.1 (Gi0/1), d=224.0.0.5, len 80, rcvd 0\r\n").into_bytes())]);
        let t = Instant::now();
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done);
        flood.store(false, Ordering::Relaxed);
        assert!(t.elapsed() < Duration::from_millis(500), "{:?}", t.elapsed());
    }

    #[test]
    fn questions_of_a_command_are_answered_by_the_next_line() {
        let job = Arc::new(Job::new());
        job.prime(b"R1#", 0);
        job.add(b"copy running-config startup-config\r\rshow clock\r");
        let (send, sent) = device(&job, |n, t| match n {
            0 => vec![(2, format!("{t}\r\nDestination filename [startup-config]? ").into_bytes())],
            1 => vec![(2, b"\r\nBuilding configuration...\r\n".to_vec()), (300, b"[OK]\r\nR1#".to_vec())],
            _ => vec![(2, format!("{t}\r\n*10:00:00.000 UTC Mon Nov 8 2026\r\nR1#").into_bytes())],
        });
        let t = Instant::now();
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done);
        assert_eq!(sent.lock().unwrap().len(), 3);
        // The last line waited for the prompt after "[OK]".
        assert!(t.elapsed() >= Duration::from_millis(300), "{:?}", t.elapsed());
    }

    #[test]
    fn a_banner_is_typed_in_as_text() {
        let job = Arc::new(Job::new());
        job.prime(b"R1(config)#", 0);
        job.add(b"banner motd ^\rAuthorised use only\rContact the NOC\r^\rend\r");
        let (send, sent) = device(&job, |n, t| match n {
            0 => vec![(2, format!("{t}\r\nEnter TEXT message.  End with the character '^'.\r\n").into_bytes())],
            1 | 2 => vec![(2, format!("{t}\r\n").into_bytes())],
            3 => vec![(2, format!("{t}\r\nR1(config)#").into_bytes())],
            _ => vec![(2, format!("{t}\r\nR1#").into_bytes())],
        });
        let t = Instant::now();
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done);
        assert_eq!(sent.lock().unwrap().len(), 5);
        assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
    }

    #[test]
    fn fixed_mode_waits_for_what_the_first_line_wakes() {
        // The question comes 200 ms after the first line; the fixed gap is 100 ms.
        let job = Arc::new(Job::new());
        job.add(b"a\rb\rc\rd\re\r");
        let (send, sent) = device(&job, |n, _| if n == 0 { vec![(200, b"\r\n\r\nUser Access Verification\r\n\r\nUsername: ".to_vec())] } else { vec![] });
        assert_eq!(job.run(Mode::Fixed { line_ms: 100, char_ms: 0 }, Duration::ZERO, send, || {}), End::Login);
        assert_eq!(sent.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_console_woken_by_enable_into_a_password_login_stops() {
        let job = Arc::new(Job::new());
        job.add(b"enable\rsecret\rconf t\r");
        let (send, log) = console(&job, Duration::from_millis(5), Some("\r\nLogin authentication\r\n\r\n\r\nPassword:"));
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login);
        assert_eq!(log.lock().unwrap().len(), 1, "nothing goes in as the login password");
    }

    #[test]
    fn a_console_woken_into_a_password_login_stops_the_paste() {
        let job = Arc::new(Job::new());
        job.add(b"interface Gi0/1\r description uplink\r no shutdown\r");
        let (send, log) = console(&job, Duration::from_millis(5), Some("\r\nUser Access Verification\r\n\r\nPassword: "));
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login);
        assert_eq!(log.lock().unwrap().len(), 1, "nothing goes in as the password");
    }

    #[test]
    fn a_login_question_coming_late_after_a_banner_is_waited_for() {
        // The console prints its banner as it wakes, goes quiet, and AAA asks
        // for the user name half a second later.
        let job = Arc::new(Job::new());
        job.add(b"line one\rline two\rline three\r");
        let (send, sent) = device(&job, |n, _| if n == 0 { vec![(0, b"\r\n\r\nsw1 con0 is now available\r\n\r\n".to_vec()), (500, b"Username: ".to_vec())] } else { vec![] });
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login);
        assert_eq!(sent.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_question_already_on_screen_takes_no_lines() {
        // Drawn just before the paste came: several lines never go into it.
        let job = Arc::new(Job::new());
        job.prime(b"Username: ", 0);
        job.add(b"a\rb\r");
        let (send, log) = console(&job, Duration::from_millis(5), Some("#"));
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login);
        assert!(log.lock().unwrap().is_empty());
        // Answered long ago, the prompt after it: no question.
        let job = Arc::new(Job::new());
        job.prime(b"Username: admin\r\nPassword: \r\n\r\nR1>", 0);
        job.add(b"a\rb\r");
        let (send, log) = console(&job, Duration::from_millis(5), Some("R1>"));
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done);
        assert_eq!(log.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_login_name_question_stops_the_paste() {
        // A console that had timed out: the first line wakes it, and it asks
        // for a login. The rest must not go in as a user name and a password.
        let job = Arc::new(Job::new());
        job.add(b"interface Gi0/1\r description uplink\r no shutdown\r exit\r");
        let (send, log) = console(&job, Duration::from_millis(5), Some("\r\nUser Access Verification\r\n\r\nUsername: "));
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login);
        assert_eq!(log.lock().unwrap().len(), 1, "nothing after the question");
        assert_eq!(job.progress(), (1, 4));
    }

    #[test]
    fn enable_and_its_password_pasted_together_go_on() {
        // "enable" and its password, at the device's ">" prompt.
        let job = Arc::new(Job::new());
        job.prime(b"R1>", 0);
        job.add(b"enable\rs3cr3t!\rshow clock\r");
        let (send, sent) = device(&job, |n, t| match n {
            0 => vec![(5, format!("{t}\r\nPassword: ").into_bytes())],
            1 => vec![(5, b"\r\nR1#".to_vec())],
            _ => vec![(5, format!("{t}\r\n10:00:00\r\nR1#").into_bytes())],
        });
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done);
        assert_eq!(sent.lock().unwrap().len(), 3);
        // A command after enable is no password: it would be a failed attempt.
        let job = Arc::new(Job::new());
        job.prime(b"R1>", 0);
        job.add(b"enable\rconfigure terminal\r");
        let (send, sent) = device(&job, |n, t| if n == 0 { vec![(5, format!("{t}\r\nPassword: ").into_bytes())] } else { vec![] });
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login);
        assert_eq!(sent.lock().unwrap().len(), 1);
        // A log message and the prompt drawn again before enable is read: its
        // question still comes, and its password still goes.
        let job = Arc::new(Job::new());
        job.prime(b"R1>", 0);
        job.add(b"enable\rs3cr3t!\rshow clock\r");
        let (send, sent) = device(&job, |n, t| match n {
            0 => vec![(2, b"\r\n*Mar  1 00:10:01.123: %LINK-3-UPDOWN: Interface Gi0/1, changed state to up\r\nR1>".to_vec()), (30, format!("{t}\r\nPassword: ").into_bytes())],
            1 => vec![(5, b"\r\nR1#".to_vec())],
            _ => vec![(5, format!("{t}\r\n10:00:00\r\nR1#").into_bytes())],
        });
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done);
        assert_eq!(*sent.lock().unwrap(), ["enable", "s3cr3t!", "show clock"]);
        assert_eq!(job.skipped(), 0);
    }

    #[test]
    fn a_password_enable_did_not_ask_for_is_left_out() {
        // Privileged already, or no enable password set: the prompt comes back
        // at once, and the password line must not go in as a command (IOS
        // would look it up as a host name, out on the network).
        for answer in ["\r\nR1#", "\r\n% No password set\r\nR1>"] {
            let job = Arc::new(Job::new());
            job.prime(b"R1>", 0);
            job.add(b"enable\rs3cr3t!\rshow clock\r");
            let (send, sent) = device(&job, move |n, t| if n == 0 { vec![(5, format!("{t}{answer}").into_bytes())] } else { vec![(5, format!("{t}\r\n10:00:00\r\nR1#").into_bytes())] });
            assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done, "{answer:?}");
            assert_eq!(*sent.lock().unwrap(), ["enable", "show clock"], "{answer:?}");
            assert_eq!(job.skipped(), 1, "{answer:?}");
        }
        // A command after it is sent as it is.
        let job = Arc::new(Job::new());
        job.prime(b"R1>", 0);
        job.add(b"enable\rconfigure terminal\rhostname R1\r");
        let (send, sent) = device(&job, |n, t| vec![(5, format!("{t}\r\n{}", if n == 0 { "R1#" } else { "R1(config)#" }).into_bytes())]);
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done);
        assert_eq!(sent.lock().unwrap().len(), 3);
        assert_eq!(job.skipped(), 0);
    }

    #[test]
    fn a_bare_address_at_an_exec_prompt_is_a_connection() {
        // IOS takes "10.0.0.2" for "telnet 10.0.0.2"; the remote asks for a
        // password (a vty with only a line password) after "Trying … Open".
        for mode in [Mode::Echo, Mode::Fixed { line_ms: 100, char_ms: 0 }] {
            let job = Arc::new(Job::new());
            job.prime(b"R1#", 0);
            job.add(b"show ip interface brief\r10.0.0.2\rshow clock\rshow users\r");
            let (send, sent) = device(&job, |n, t| match n {
                0 => vec![(2, format!("{t}\r\nInterface  IP-Address  OK? Method Status  Protocol\r\nR1#").into_bytes())],
                1 => vec![(2, format!("{t}\r\nTrying 10.0.0.2 ... ").into_bytes()), (400, b"Open\r\n\r\n\r\nUser Access Verification\r\n\r\nPassword: ".to_vec())],
                _ => vec![],
            });
            assert_eq!(job.run(mode, Duration::ZERO, send, || {}), End::Login, "{mode:?}");
            assert_eq!(sent.lock().unwrap().len(), 2, "{mode:?}");
        }
    }

    #[test]
    fn a_console_that_wakes_slowly_takes_no_lines() {
        // Nothing on screen; the first line wakes the console into its login
        // only after a second or more (a console server across a WAN).
        for (mode, after) in [(Mode::Echo, 1700), (Mode::Echo, 1000), (Mode::Fixed { line_ms: 100, char_ms: 0 }, 1000)] {
            let job = Arc::new(Job::new());
            job.add(b"interface Gi0/1\r description uplink\r no shutdown\r");
            let (send, sent) = device(&job, move |n, _| if n == 0 { vec![(after, format!("{IOS_WAKE}Username: ").into_bytes())] } else { vec![] });
            assert_eq!(job.run(mode, Duration::ZERO, send, || {}), End::Login, "{mode:?} {after}");
            assert_eq!(sent.lock().unwrap().len(), 1, "{mode:?} {after}");
        }
    }

    #[test]
    fn a_prompt_drawn_again_before_the_echo_does_not_count() {
        // logging synchronous: a log message and the prompt drawn again come
        // before the ssh line is read; its password question after it.
        let job = Arc::new(Job::new());
        job.prime(b"R1#", 0);
        job.add(b"show clock\rssh -l admin 10.0.0.2\rshow version\r");
        let (send, sent) = device(&job, |n, t| match n {
            0 => vec![(2, format!("{t}\r\n10:00:00.000 UTC Mon Nov 8 2026\r\nR1#").into_bytes())],
            1 => vec![
                (2, b"\r\n*Mar  1 00:10:01.123: %LINK-3-UPDOWN: Interface Gi0/1, changed state to up\r\nR1#".to_vec()),
                (30, format!("{t}\r\n").into_bytes()),
                (200, b"Password: ".to_vec()),
            ],
            _ => vec![],
        });
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login);
        assert_eq!(*sent.lock().unwrap(), ["show clock", "ssh -l admin 10.0.0.2"]);
    }

    #[test]
    fn questions_in_other_shapes_and_words_stop_the_paste() {
        for (out, sent, at) in [
            ("ftp 10.0.0.5\r\nConnected to 10.0.0.5.\r\n220 FTP server ready.\r\nName (10.0.0.5:admin): ", "ftp 10.0.0.5", "admin@web:~$"),
            ("curl --cert c.pem https://x\r\nEnter PEM pass phrase:", "curl --cert c.pem https://x", "admin@web:~$"),
            ("vpnc office\r\nEnter IPSec secret for office@vpn: ", "vpnc office", "admin@web:~$"),
            ("ssh admin@10.0.0.2\r\n사용자 이름: ", "ssh admin@10.0.0.2", "admin@web:~$"),
            ("x\r\n用户名: ", "x", "<HUAWEI>"),
            ("stelnet 10.0.0.2\r\nThe server is not authenticated. Continue to access it? [Y/N]:", "stelnet 10.0.0.2", "<HUAWEI>"),
            ("y\r\nSave the server's public key? [Y/N]:", "y", ""),
            ("git pull\r\nUsername for 'https://github.com': ", "git pull", "admin@web:~$"),
            ("pip install x\r\nUser for pypi.example.com: ", "pip install x", "admin@web:~$"),
        ] {
            assert_eq!(verdict(out, sent, at, 200), Next::End(End::Login), "{out:?}");
        }
        // Not questions: a value after the colon, a "Fingerprint:" label, a password shown masked.
        for (out, sent, at) in [
            ("show ssh\r\nPassword: ********\r\nR1#", "show ssh", "R1#"),
            ("show users\r\nAccount: [Local]\r\nR1#", "show users", "R1#"),
            ("ssh-keygen -lf k.pub\r\nThe key fingerprint is:\r\nSHA256:abc\r\nadmin@web:~$ ", "ssh-keygen -lf k.pub", "admin@web:~$"),
        ] {
            assert!(goes(&verdict(out, sent, at, 200)), "{out:?}");
        }
        // A question in a complete line is sure only once the output rests
        // (the line under an indented "  user:" may still come).
        assert!(matches!(verdict("kubectl config view\r\nusers:\r\n- name: admin\r\n  user:\r\n", "kubectl config view", "admin@web:~$", 0), Next::Wait(_)));
    }

    #[test]
    fn what_follows_enable_must_look_like_a_password() {
        for next in ["!", "ping", "setup", "clear", "configure terminal", "end"] {
            assert!(!looks_secret(next.as_bytes()), "{next:?}");
        }
        for next in ["s3cr3t!", "Cisco123", "p@ss"] {
            assert!(looks_secret(next.as_bytes()), "{next:?}");
        }
    }

    #[test]
    fn progress_lines_are_no_prompts() {
        for p in ["0% [Waiting for headers]", "[#####               ]  25%", "[OK]", "[ DONE ]", "45%", "0% [Connecting to archive.ubuntu.com]"] {
            assert!(!is_prompt(p.as_bytes()), "{p:?}");
        }
        for p in ["[HUAWEI]", "[H3C]", "server1%", "host% "] {
            assert!(is_prompt(p.as_bytes()), "{p:?}");
        }
        // apt-get at work for 2 s: the next line waits for the shell's prompt.
        let job = Arc::new(Job::new());
        job.prime(b"admin@web:~$ ", 0);
        job.add(b"apt-get update\rapt-get -y install nginx\r");
        let (send, sent) = device(&job, |n, t| {
            if n > 0 {
                return vec![];
            }
            let mut out: Answer = vec![(2, format!("{t}\r\n0% [Waiting for headers]").into_bytes())];
            out.extend((0..4).map(|i| (500, format!("\r{}% [Working]", 20 * (i + 1)).into_bytes())));
            out.push((50, b"\r\nReading package lists... Done\r\nadmin@web:~$ ".to_vec()));
            out
        });
        let t = Instant::now();
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done);
        assert_eq!(sent.lock().unwrap().len(), 2);
        assert!(t.elapsed() >= Duration::from_millis(2000), "{:?}", t.elapsed());
    }

    #[test]
    fn a_prompt_of_a_shape_not_known_is_learnt_from_the_screen() {
        // starship, oh-my-zsh, a long MikroTik menu path: the line the cursor
        // was on comes back after each command.
        for home in ["❯ ", "➜  ~ ", "[admin@MikroTik] /ip hotspot user profile> "] {
            let job = Arc::new(Job::new());
            job.prime(home.as_bytes(), 0);
            job.add(b"one\rtwo\rthree\rfour\r");
            let (send, sent) = device(&job, move |_, t| vec![(2, format!("{t}\r\nsome output\r\n{home}").into_bytes())]);
            let t = Instant::now();
            assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done, "{home:?}");
            assert_eq!(sent.lock().unwrap().len(), 4, "{home:?}");
            assert!(t.elapsed() < Duration::from_millis(200), "{home:?}: {:?}", t.elapsed());
        }
        // A banner sentence the cursor stood after is no prompt to learn.
        assert!(!is_home(b"R1 con0 is now available"));
        assert!(!is_home(b"Password:"));
        assert!(is_home(b"\xe2\x9d\xaf"));
    }

    #[test]
    fn an_answer_the_device_has_not_taken_yet_still_stands() {
        // The user typed a password and pressed Enter; TACACS+ is still
        // checking it (no line break yet). A paste now must not go in as the
        // next attempt.
        let screen = "\r\nUser Access Verification\r\n\r\nPassword: ";
        let job = Arc::new(Job::new());
        job.prime(screen.as_bytes(), screen.len());
        job.add(b"interface Gi0/1\r description x\r");
        let (send, sent) = device(&job, |_, _| vec![]);
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login);
        assert!(sent.lock().unwrap().is_empty());
        // Where the Enter came moves when output pushes the oldest bytes out.
        let job = Job::new();
        let screen = format!("{}R1#\r\nUsername: ", "x".repeat(RECENT - 14));
        job.prime(screen.as_bytes(), RECENT - 11);
        job.observe(b"\r\n*Mar  1: %SYS-5\r\n");
        let s = job.seen.lock().unwrap();
        assert_eq!(&s.recent[s.answered - 3..s.answered], b"R1#");
    }

    #[test]
    fn a_shell_program_with_a_nameless_prompt_takes_its_lines() {
        // python3 started at a shell: banner lines, then ">>> ".
        let job = Arc::new(Job::new());
        job.prime(b"admin@web:~$ ", 0);
        job.add(b"python3\rprint(1)\rprint(2)\r");
        let (send, sent) = device(&job, |n, t| vec![(2, format!("{t}\r\n{}>>> ", if n == 0 { "Python 3.12.3\r\nType \"help\" for more information.\r\n" } else { "1\r\n" }).into_bytes())]);
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done);
        assert_eq!(sent.lock().unwrap().len(), 3);
        // A banner's row of marks is no prompt to learn.
        assert!(!is_home(b"*"));
        assert!(!is_home(b"##########################"));
    }

    #[test]
    fn a_question_the_user_answered_blocks_no_paste() {
        // A login a while ago, answered at the keyboard; the shell's prompt is
        // of a shape not known, so it does not mark the question answered.
        let screen = "web login: admin\r\nPassword: \r\nLast login: Mon Nov  8 10:00:00 2026\r\n➜  ~ ";
        let answered = screen.find("Password: ").unwrap() + "Password: ".len();
        let job = Arc::new(Job::new());
        job.prime(screen.as_bytes(), answered);
        job.add(b"ls\rpwd\r");
        let (send, sent) = device(&job, |_, t| vec![(2, format!("{t}\r\nout\r\n➜  ~ ").into_bytes())]);
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done);
        assert_eq!(sent.lock().unwrap().len(), 2);
        // Not answered (no Enter since): it still stands.
        let job = Arc::new(Job::new());
        job.prime(screen.as_bytes(), 0);
        job.add(b"ls\rpwd\r");
        let (send, sent) = device(&job, |_, _| vec![]);
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Login);
        assert!(sent.lock().unwrap().is_empty());
    }

    #[test]
    fn a_modem_takes_at_commands_line_by_line() {
        let job = Arc::new(Job::new());
        job.add(b"AT\rATI\rAT+CSQ\r");
        let (send, sent) = device(&job, |_, t| vec![(2, format!("{t}\r\n\r\n{}\r\n", if t == "ATI" { "Quectel\r\nEC25\r\n\r\nOK" } else { "OK" }).into_bytes())]);
        let t = Instant::now();
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, send, || {}), End::Done);
        assert_eq!(sent.lock().unwrap().len(), 3);
        assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
    }

    #[test]
    fn echoes_drawn_otherwise_are_found() {
        assert!(echoes(b"user@r1> request system reboot", b"req sys reboot"));
        assert!(echoes(b"load merge terminal", b"load merge term"));
        assert!(echoes(b"admin@web:~$ echo aaaaaaaaaaaaaaa bbbbbbbbbbbb \x20 ccc", b"echo aaaaaaaaaaaaaaa bbbbbbbbbbbbccc"));
        assert!(!echoes(b"Trying 10.0.0.2 ...", b"show clock"));
    }

    #[test]
    fn lines_keep_their_line_ends() {
        let job = Job::new();
        assert_eq!(job.add(b"a\rb\r\rc"), Some(4));
        let lines: Vec<_> = job.lines.lock().unwrap().iter().cloned().collect();
        assert_eq!(lines, [b"a\r".to_vec(), b"b\r".to_vec(), b"\r".to_vec(), b"c".to_vec()]);
    }

    /// When each write arrived, and what it was.
    type Arrivals = Arc<Mutex<Vec<(Instant, Vec<u8>)>>>;

    /// A fake console: echoes each line `apply` after receiving it, then
    /// prints its prompt. Records when every line arrived.
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
        job.prime(b"R1(config)#", 0);
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
        // Text taken in line by line (a banner's text, typed at no prompt).
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
        job.add(b"a\rb\rc\r");
        let t = Instant::now();
        assert_eq!(job.run(Mode::Echo, Duration::ZERO, |_| Ok(()), || {}), End::Done);
        let took = t.elapsed();
        // The first line waits longer (a console may wake slowly), later ones NO_ECHO.
        assert!(took >= MUTE_FIRST + NO_ECHO && took < MUTE_FIRST + NO_ECHO + Duration::from_millis(400), "{took:?}");
    }

    #[test]
    fn a_long_line_is_not_followed_before_it_left_the_wire() {
        // 9600 baud: ~1.04 ms a character; an 80-character line ~83 ms.
        let job = Arc::new(Job::new());
        job.prime(b"#", 0);
        job.add(&[vec![b'x'; 79], vec![b'\r'], b"next\r".to_vec()].concat());
        let (send, log) = console(&job, Duration::ZERO, Some("#"));
        assert_eq!(job.run(Mode::Echo, Duration::from_micros(1042), send, || {}), End::Done);
        let log = log.lock().unwrap();
        assert!(log[1].0 - log[0].0 >= Duration::from_millis(80), "{:?}", log[1].0 - log[0].0);
    }

    #[test]
    fn fixed_mode_uses_the_given_delays() {
        // A device that answers nothing: the first line waits for what it may
        // wake, later ones only the line delay.
        let job = Arc::new(Job::new());
        job.add(b"ab\rcd\ref\r");
        let log = Arc::new(Mutex::new(Vec::new()));
        let rec = log.clone();
        let send = move |d: &[u8]| {
            rec.lock().unwrap().push((Instant::now(), d.to_vec()));
            Ok(())
        };
        assert_eq!(job.run(Mode::Fixed { line_ms: 60, char_ms: 10 }, Duration::ZERO, send, || {}), End::Done);
        let log = log.lock().unwrap();
        assert_eq!(log.len(), 9, "one write per character");
        assert!(log[1].0 - log[0].0 >= Duration::from_millis(10), "character delay");
        assert!(log[3].0 - log[0].0 >= NO_ECHO, "first line");
        let gap = log[6].0 - log[5].0;
        assert!(gap >= Duration::from_millis(60) && gap < Duration::from_millis(300), "line delay {gap:?}");
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
