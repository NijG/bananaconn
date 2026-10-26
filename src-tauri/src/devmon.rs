// Device-aware resource monitor over a CLI session: a second Telnet login, or
// an interactive SSH shell for devices that cannot run the Linux /proc script
// (network gear, AIX, HP-UX). It never types into the user's terminal.
//
// After login it identifies the device with read-only commands, then polls
// that device's own commands:
//
// - Linux (RHEL …): /proc/stat, /proc/meminfo, df
// - IBM AIX: vmstat, svmon, df          - HP-UX: vmstat, machinfo, bdf
// - Cisco IOS / IOS-XE: show processes cpu / memory
// - Cisco NX-OS: show system resources  - Cisco ASA: show cpu usage / memory
// - Fortinet FortiGate: get system performance status
// - Aruba AOS-CX: show system resource-utilization
// - Aruba AOS-Switch (ProCurve): show cpu / show system
// - Aruba controllers (ArubaOS): show cpuload / show memory
//
// On request (between polls) it also lists the busiest processes and, for
// network devices, reads the running configuration for a backup. Pagers
// ("--More--") are answered automatically.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};

use crate::monitor::{parse_block, parse_commands, parse_top, Section, Stats, COMMANDS_SCRIPT, TOP_SCRIPT};
use crate::telnet;

const STEP: Duration = Duration::from_secs(15);
const BACKUP_LIMIT: Duration = Duration::from_secs(180);

/// A question for the polling loop, answered between two polls.
/// Sampling interval while paused (keeps the login alive).
const PAUSED_INTERVAL: Duration = Duration::from_secs(300);

pub(crate) enum Query {
    Top(oneshot::Sender<Result<Vec<Section>, String>>),
    Backup(oneshot::Sender<Result<String, String>>),
    /// The programs on a Unix server's PATH (command suggestions).
    Commands(oneshot::Sender<Result<Vec<String>, String>>),
    /// Pause (no tab of this device on screen) or resume sampling.
    Pause(bool),
}

pub(crate) trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// A line-oriented CLI session (Telnet with option handling, or an SSH shell).
pub(crate) struct Line {
    io: Box<dyn Io>,
    telnet: Option<telnet::Parser>,
    text: String,
    /// Bytes of a character or escape sequence cut off at the end of a read.
    partial: Vec<u8>,
    /// The device's prompt line once known ("SW-CORE-01#").
    prompt: Option<String>,
}

/// How much of `data` can be decoded now: a UTF-8 character or an escape
/// sequence split across two reads is kept for the next one (otherwise a
/// Korean hostname turns into U+FFFD and "[0m" leaks into the prompt line).
fn complete_len(data: &[u8]) -> usize {
    let mut end = data.len();
    // An escape sequence without its final byte yet.
    let starts = |i: &usize| data.get(i + 1) != Some(&b'\\');
    if let Some(esc) = (0..data.len()).rev().filter(|&i| data[i] == 0x1b).find(starts).filter(|&i| data.len() - i < 256) {
        let rest = &data[esc + 1..];
        let open = match rest.first() {
            None => true,
            Some(b'[') => !rest[1..].iter().any(|b| (0x40..=0x7e).contains(b)),
            // A string sequence (window title) runs to BEL or ESC \.
            Some(b']' | b'P' | b'_' | b'^' | b'X') => !rest.contains(&0x07) && !rest.windows(2).any(|w| w == b"\x1b\\"),
            Some(_) => false,
        };
        if open {
            end = esc;
        }
    }
    match std::str::from_utf8(&data[..end]) {
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        _ => end,
    }
}

/// Remove ANSI escape sequences and carriage returns; apply backspaces.
fn clean(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.peek() {
                Some('[') => {
                    chars.next();
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                // String sequences (OSC window title from bash's PROMPT_COMMAND
                // on RHEL, DCS, APC, PM): up to BEL or ESC \.
                Some(']' | 'P' | '_' | '^' | 'X') => {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\x07' {
                            break;
                        }
                        if c == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {
                    chars.next();
                }
            },
            '\r' | '\x07' | '\0' => {}
            '\x08' => {
                out.pop();
            }
            _ => out.push(c),
        }
    }
    out
}

fn last_line(text: &str) -> &str {
    text.trim_end_matches([' ', '\n']).rsplit('\n').next().unwrap_or("").trim()
}

/// A shell or device prompt: "Switch>", "Router#", "user@host:~$", "(Aruba7010) #".
/// A longer prompt has a name in it ("Router#", "user@host:~$", "<SW01>"); a banner
/// border such as "##########" or "=====>" does not.
fn is_prompt(line: &str) -> bool {
    !line.is_empty()
        && line.len() < 100
        && line.ends_with(['>', '#', '$', '%'])
        // A bare "$" or "#" (ksh, root) is a prompt; a run of symbols is a border.
        && (line.trim().chars().count() <= 2 || line.chars().any(|c| c.is_alphanumeric()))
        && !is_pager(line)
}

/// "--More--", "-- MORE --, next page: Space …", "<--- More --->".
fn is_pager(line: &str) -> bool {
    let l = line.to_lowercase();
    // Junos: "---(more)---", "---(more 45%)---".
    l.contains("more") && (l.contains("--more--") || l.contains("-- more --") || l.contains("--- more ---") || l.contains("---(more"))
}

fn lower_tail(text: &str) -> String {
    last_line(text).to_lowercase()
}

impl Line {
    /// `proxy`: the session's proxy and its login (proxy.rs).
    pub(crate) async fn telnet(host: &str, port: u16, proxy: Option<&Route>) -> Result<Self, String> {
        let stream = match proxy.filter(|(p, _)| !p.bypasses(host)) {
            Some((p, auth)) => {
                let (p, auth, h) = (p.clone(), auth.clone(), host.to_string());
                let s = tokio::task::spawn_blocking(move || crate::proxy::dial(Some(&p), &auth, &h, port, &mut |_| {}))
                    .await
                    .map_err(|e| e.to_string())??;
                s.set_nonblocking(true).map_err(|e| e.to_string())?;
                TcpStream::from_std(s).map_err(|e| e.to_string())?
            }
            None => tokio::time::timeout(Duration::from_secs(10), TcpStream::connect((host, port)))
                .await
                .map_err(|_| format!("{host}:{port} 연결 시간이 초과되었습니다"))?
                .map_err(|e| format!("{host}:{port} 에 연결할 수 없습니다: {e}"))?,
        };
        let _ = stream.set_nodelay(true);
        Ok(Self { io: Box::new(stream), telnet: Some(telnet::Parser::new()), text: String::new(), partial: Vec::new(), prompt: None })
    }

    /// An interactive SSH shell (already authenticated).
    pub(crate) fn shell(io: impl Io + 'static) -> Self {
        Self { io: Box::new(io), telnet: None, text: String::new(), partial: Vec::new(), prompt: None }
    }

    async fn write_raw(&mut self, data: &[u8]) -> Result<(), String> {
        let data = if self.telnet.is_some() { telnet::encode_input(data) } else { data.to_vec() };
        self.io.write_all(&data).await.map_err(|e| e.to_string())?;
        self.io.flush().await.map_err(|e| e.to_string())
    }

    async fn send(&mut self, line: &str) -> Result<(), String> {
        let mut data = line.as_bytes().to_vec();
        data.push(b'\r');
        self.write_raw(&data).await
    }

    /// Read until `done(text)` holds after a short quiet period, or time out.
    /// Pagers are answered with a space on the way. Once the text ends in the
    /// device's own prompt, a much shorter pause ends the wait (every command
    /// no longer costs 0.4 s of silence). Output lines that merely look like a
    /// prompt ("banner motd #", "... 5%") and backups keep the full pause.
    async fn until(&mut self, done: impl Fn(&str) -> bool, limit: Duration) -> Result<String, String> {
        let deadline = tokio::time::Instant::now() + limit;
        let mut buf = [0u8; 8192];
        loop {
            let at_prompt = limit < BACKUP_LIMIT && self.prompt.as_deref().is_some_and(|p| last_line(&self.text) == p);
            let pause = if at_prompt && done(&self.text) { Duration::from_millis(150) } else { Duration::from_millis(400) };
            let quiet = tokio::time::timeout(pause, self.io.read(&mut buf)).await;
            match quiet {
                Ok(Ok(0)) => return Err("상대가 연결을 끊었습니다".into()),
                Ok(Ok(n)) => {
                    let data = match self.telnet.as_mut() {
                        Some(parser) => {
                            let feed = parser.feed(&buf[..n]);
                            if !feed.replies.is_empty() {
                                let _ = self.io.write_all(&feed.replies).await;
                            }
                            if feed.send_size {
                                // Wide window so long output lines are not wrapped.
                                let _ = self.io.write_all(&telnet::naws(250, 60)).await;
                            }
                            feed.data
                        }
                        None => buf[..n].to_vec(),
                    };
                    self.partial.extend_from_slice(&data);
                    let n = complete_len(&self.partial);
                    let rest = self.partial.split_off(n);
                    let ready = std::mem::replace(&mut self.partial, rest);
                    self.text.push_str(&clean(&String::from_utf8_lossy(&ready)));
                    if is_pager(last_line(&self.text)) {
                        let cut = self.text.trim_end_matches([' ', '\n']).rfind('\n').map(|i| i + 1).unwrap_or(0);
                        self.text.truncate(cut);
                        self.write_raw(b" ").await?;
                    }
                    if self.text.len() > 4 * 1024 * 1024 {
                        return Err("출력이 너무 깁니다".into());
                    }
                }
                Ok(Err(e)) => return Err(e.to_string()),
                Err(_) if done(&self.text) => return Ok(std::mem::take(&mut self.text)),
                Err(_) => {}
            }
            if tokio::time::Instant::now() > deadline {
                return Err("장비가 응답하지 않습니다".into());
            }
        }
    }

    /// Run a Unix script whose output ends with an "@@END" marker line; done
    /// at the next prompt, the shell's own one included ("[user@aix01 /home/user]",
    /// kept by csh and the like).
    async fn run_script(&mut self, script: &str) -> Result<String, String> {
        self.send(script).await?;
        let learned = self.prompt.clone();
        self.until(move |x| x.contains("\n@@END") && (is_prompt(last_line(x)) || learned.as_deref() == Some(last_line(x))), STEP)
            .await
    }

    /// Run a command and return its output (up to the next prompt).
    async fn run(&mut self, cmd: &str) -> Result<String, String> {
        self.run_for(cmd, STEP).await
    }

    async fn run_for(&mut self, cmd: &str, limit: Duration) -> Result<String, String> {
        self.send(cmd).await?;
        let learned = self.prompt.clone();
        self.until(
            move |t| {
                let last = last_line(t);
                (is_prompt(last) || learned.as_deref() == Some(last)) && t.contains('\n')
            },
            limit,
        )
        .await
    }

    /// Wait for the first prompt after logging in. Answers what login scripts
    /// ask on the way: "TERM = (hp)" (HP-UX tset: the default is taken),
    /// "press any key". A prompt this code does not recognise (a custom PS1
    /// such as "[user@aix01 /home/user]") is learned: it is the line that
    /// comes back after an empty Enter. A login prompt again means the
    /// password was refused.
    async fn first_prompt(&mut self) -> Result<String, String> {
        let mut seen = String::new();
        let mut candidate: Option<String> = None;
        for _ in 0..8 {
            let text = match self.until(|t| is_prompt(last_line(t)) || asks_something(t), FIRST_QUIET).await {
                Ok(text) => text,
                // Quiet without anything recognised: look at what came.
                Err(_) => std::mem::take(&mut self.text),
            };
            seen.push_str(&text);
            let last = last_line(&seen).to_string();
            let tail = last.to_lowercase();
            if tail.ends_with("login:") || tail.ends_with("username:") || tail.ends_with("password:") {
                return Err("인증에 실패했습니다".into());
            }
            if is_prompt(&last) {
                return Ok(seen);
            }
            if is_term_question(&last) {
                self.send("").await?;
                continue;
            }
            if tail.contains("press any key") || tail.contains("any key to continue") {
                self.write_raw(b" ").await?;
                continue;
            }
            if !last.is_empty() && last.len() < 100 && candidate.as_deref() == Some(last.as_str()) {
                // The same line again after an empty Enter: that is the prompt.
                self.prompt = Some(last);
                return Ok(seen);
            }
            // A question after the password (a one-time passcode, "Change now?
            // [Y/N]", a menu) must not get blind Enters: each could be a failed
            // attempt. Not a prompt we know: stop.
            // A custom prompt may end in "]" ("[user@aix01 /home]"); a question
            // ends in ":" or "?", or offers a choice.
            let low = last.to_lowercase();
            if last.trim_end().ends_with([':', '?']) || last.contains('?') || low.contains("y/n") || low.contains("yes/no") {
                return Err(format!("로그인 뒤에 장비가 묻는 것이 있어 자원 표시를 하지 않습니다: {}", last.trim()));
            }
            candidate = Some(last).filter(|l| !l.is_empty());
            self.send("").await?;
        }
        Err("로그인 후 프롬프트를 찾지 못했습니다".into())
    }
}

/// Quiet time that ends a wait for the first prompt (banners, MOTD, profile).
const FIRST_QUIET: Duration = Duration::from_secs(3);

/// Longest a Telnet login may take, banners and login scripts included.
const LOGIN_LIMIT: Duration = Duration::from_secs(60);

/// HP-UX login scripts (tset): "TERM = (hp) " waits for an answer.
fn is_term_question(line: &str) -> bool {
    let l = line.trim();
    l.starts_with("TERM = (") || l.starts_with("TERM=(")
}

/// A login script waits for a key or a terminal type.
fn asks_something(text: &str) -> bool {
    let last = last_line(text);
    let tail = last.to_lowercase();
    is_term_question(last) || tail.contains("press any key") || tail.contains("any key to continue") || tail.ends_with("login:") || tail.ends_with("password:")
}

/// The command's output without its echo line and the final prompt.
fn body(out: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = out.lines().collect();
    if lines.first().is_some_and(|l| !l.trim().is_empty()) {
        lines.remove(0); // the echoed command
    }
    while lines.last().is_some_and(|l| l.trim().is_empty() || is_prompt(l.trim())) {
        lines.pop();
    }
    lines
}

/// Log in over Telnet (username may be empty for devices that ask only a password).
/// `no_password`: the user said the device takes none; otherwise, without a
/// password, the login stops before the user name.
async fn login(t: &mut Line, username: &str, password: Option<&str>, no_password: bool) -> Result<String, String> {
    let wants = |t: &str| {
        let l = lower_tail(t);
        is_prompt(last_line(t)) || l.ends_with("login:") || l.ends_with("username:") || l.ends_with("password:") || l.contains("press any key")
    };
    let mut text = t.until(wants, STEP).await?;
    for _ in 0..4 {
        let l = lower_tail(&text);
        if l.contains("press any key") {
            t.write_raw(b" ").await?;
        } else if l.ends_with("login:") || l.ends_with("username:") {
            if username.is_empty() {
                return Err("NEED_USERNAME".into());
            }
            // Without a password, a user name alone would end in an aborted
            // login the device records as failed: hang up before sending it.
            if password.is_none() && !no_password {
                return Err("NEED_PASSWORD".into());
            }
            t.send(username).await?;
        } else if l.ends_with("password:") {
            let Some(pw) = password else { return Err("NEED_PASSWORD".into()) };
            t.send(pw).await?;
            // A shell prompt means success even when a banner says "Last failed
            // login"; only another login prompt means the password was rejected.
            // Login scripts may ask for TERM, and the prompt may be custom.
            return t.first_prompt().await;
        } else if is_prompt(last_line(&text)) {
            return Ok(text);
        }
        text = t.until(wants, STEP).await?;
    }
    if is_prompt(last_line(&text)) { Ok(text) } else { Err("로그인 후 프롬프트를 찾지 못했습니다".into()) }
}

// ---- device kinds --------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Linux,
    Aix,
    Hpux,
    Ios,
    IosXe,
    Nxos,
    Asa,
    Fortigate,
    ArubaCx,
    ArubaSwitch,
    ArubaController,
    Solaris,
    Junos,
    Vrp,
}

impl Kind {
    fn id(self) -> &'static str {
        match self {
            Kind::Linux => "linux",
            Kind::Aix => "aix",
            Kind::Hpux => "hpux",
            Kind::Ios => "cisco-ios",
            Kind::IosXe => "cisco-iosxe",
            Kind::Nxos => "cisco-nxos",
            Kind::Asa => "cisco-asa",
            Kind::Fortigate => "fortigate",
            Kind::ArubaCx => "aruba-cx",
            Kind::ArubaSwitch => "aruba-switch",
            Kind::ArubaController => "aruba-controller",
            Kind::Solaris => "solaris",
            Kind::Junos => "juniper-junos",
            Kind::Vrp => "huawei-vrp",
        }
    }

    fn vendor(self) -> &'static str {
        match self {
            Kind::Linux => "Linux",
            Kind::Aix => "IBM",
            Kind::Hpux => "HPE",
            Kind::Ios | Kind::IosXe | Kind::Nxos | Kind::Asa => "Cisco",
            Kind::Fortigate => "Fortinet",
            Kind::ArubaCx | Kind::ArubaSwitch | Kind::ArubaController => "Aruba",
            Kind::Solaris => "Oracle",
            Kind::Junos => "Juniper",
            Kind::Vrp => "Huawei",
        }
    }

    fn network(self) -> bool {
        !matches!(self, Kind::Linux | Kind::Aix | Kind::Hpux | Kind::Solaris)
    }

    /// Session-only command that turns paging off (nothing is saved).
    fn pager_off(self) -> Option<&'static str> {
        match self {
            Kind::Ios | Kind::IosXe | Kind::Nxos => Some("terminal length 0"),
            Kind::Asa => Some("terminal pager 0"),
            Kind::ArubaCx | Kind::ArubaSwitch => Some("no page"),
            Kind::ArubaController => Some("no paging"),
            Kind::Junos => Some("set cli screen-length 0"),
            Kind::Vrp => Some("screen-length 0 temporary"),
            _ => None,
        }
    }

    /// Seconds between samples. Network gear is polled gently: every sample
    /// is two or three CLI commands (command accounting on TACACS+, CPU on
    /// small switches), and the status bar does not need more.
    fn interval(self) -> u64 {
        match self {
            Kind::Linux => 2,
            Kind::Aix | Kind::Hpux | Kind::Solaris => 10,
            _ => 15,
        }
    }

    fn backup(self) -> Option<&'static str> {
        match self {
            Kind::Fortigate => Some("show"),
            Kind::Junos => Some("show configuration"),
            Kind::Vrp => Some("display current-configuration"),
            k if k.network() => Some("show running-config"),
            _ => None,
        }
    }
}

/// "Linux 5.14…", "AIX 3", "HP-UX B.11.31" from `uname -sr`.
pub(crate) fn unix_kind(out: &str) -> Option<Kind> {
    body(out).iter().map(|l| l.trim()).find_map(|l| {
        if l == "Linux" || l.starts_with("Linux ") {
            Some(Kind::Linux)
        } else if l == "AIX" || l.starts_with("AIX ") {
            Some(Kind::Aix)
        } else if l.starts_with("HP-UX") {
            Some(Kind::Hpux)
        } else if l.starts_with("SunOS") {
            Some(Kind::Solaris)
        } else {
            None
        }
    })
}

/// The word after `key` on the first line containing it.
fn after<'a>(out: &'a str, key: &str) -> Option<&'a str> {
    out.lines().find_map(|l| l.find(key).map(|i| l[i + key.len()..].trim().trim_start_matches([':', '=', ' '])))
}

fn first_word(s: &str) -> &str {
    s.split(|c: char| c.is_whitespace() || c == ',').next().unwrap_or("")
}

/// Classify by "show version"; the label carries the software version.
pub(crate) fn version_kind(out: &str) -> Option<(Kind, String)> {
    let v = |key: &str| after(out, key).map(first_word).unwrap_or("").to_string();
    if out.contains("Cisco Adaptive Security Appliance") {
        return Some((Kind::Asa, format!("ASA {}", v("Software Version"))));
    }
    if out.contains("Cisco Nexus Operating System") || out.contains("NX-OS") {
        let ver = after(out, "NXOS: version").or_else(|| after(out, "system:    version")).map(first_word).unwrap_or("");
        return Some((Kind::Nxos, format!("NX-OS {ver}")));
    }
    if out.contains("IOS XE") || out.contains("IOS-XE") {
        return Some((Kind::IosXe, format!("IOS-XE {}", v("Version"))));
    }
    if out.contains("Cisco IOS Software") || out.contains("Cisco Internetwork Operating System") {
        return Some((Kind::Ios, format!("IOS {}", v("Version"))));
    }
    if out.contains("ArubaOS-CX") || out.contains("AOS-CX") {
        return Some((Kind::ArubaCx, format!("AOS-CX {}", v("Version"))));
    }
    if out.contains("Aruba Operating System Software") || out.contains("ArubaOS (MODEL") {
        return Some((Kind::ArubaController, format!("ArubaOS {}", v("Version"))));
    }
    if out.contains("JUNOS") || out.contains("Junos:") {
        // "Junos: 21.4R3-S1.5", or "JUNOS Software Release [12.3R12.4]" on older releases.
        let ver = after(out, "Junos:")
            .map(first_word)
            .or_else(|| out.split_once("JUNOS").and_then(|(_, r)| r.split_once('[')).and_then(|(_, r)| r.split(']').next()))
            .unwrap_or("");
        return Some((Kind::Junos, format!("Junos {ver}")));
    }
    if out.contains("Image stamp") {
        // AOS-Switch / ProCurve: the version is a token like WC.16.10.0012.
        let ver = out
            .split_whitespace()
            .find(|w| w.len() > 6 && w.as_bytes()[2] == b'.' && w[..2].chars().all(|c| c.is_ascii_uppercase()))
            .unwrap_or("");
        return Some((Kind::ArubaSwitch, format!("AOS-Switch {ver}")));
    }
    None
}

/// "Version: FortiGate-60F v7.2.5,build1517,…" from "get system status".
pub(crate) fn fortios_label(out: &str) -> Option<String> {
    let v = after(out, "Version:")?;
    v.contains("Forti").then(|| v.split(',').next().unwrap_or(v).trim().to_string())
}

/// Hostname from a device prompt: "SW1#", "(Aruba7010) #", "FGT60F (global) #".
pub(crate) fn prompt_name(prompt: &str) -> String {
    let p = prompt.trim().trim_end_matches(['#', '>', '$', '%', ' ']);
    // "(config)#", Huawei "<SW01>", Junos "user@router>".
    let p = p.trim_start_matches(['(', '<']);
    let p = p.rsplit_once('@').map_or(p, |(_, host)| host);
    let name = p.split([')', ' ', '(']).next().unwrap_or("");
    name.to_string()
}

// ---- parsers --------------------------------------------------------------------------------

fn num(s: &str) -> Option<f64> {
    let t: String = s.trim().chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',').filter(|c| *c != ',').collect();
    t.parse().ok()
}

/// "CPU utilization for five seconds: 7%/0%; one minute: 5%; ..."
fn ios_cpu(out: &str) -> Option<f64> {
    num(after(out, "five seconds:")?)
}

/// "Processor Pool Total:  123456 Used:  65432 Free: ..." or the
/// "show memory statistics" Processor row (head, total, used, free ...).
fn ios_memory(out: &str) -> Option<(u64, u64)> {
    for line in out.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("Processor Pool Total:") {
            let total: u64 = rest.split_whitespace().next()?.parse().ok()?;
            let used: u64 = rest.split("Used:").nth(1)?.split_whitespace().next()?.parse().ok()?;
            return Some((used, total));
        }
        if l.starts_with("Processor") && !l.contains("Pool") {
            // Columns end with Total, Used, Free, Lowest, Largest; Head is hex.
            let nums: Vec<u64> = l.split_whitespace().skip(1).filter_map(|w| w.parse().ok()).collect();
            if nums.len() >= 5 {
                let n = nums.len();
                return Some((nums[n - 4], nums[n - 5]));
            }
        }
    }
    None
}

/// Idle % before the word "idle" ("93.89% idle", "idle 92.0%").
fn idle_percent(line: &str) -> Option<f64> {
    let words: Vec<&str> = line.split([' ', ',']).filter(|w| !w.is_empty()).collect();
    let i = words.iter().position(|w| w.eq_ignore_ascii_case("idle"))?;
    // "user 3.6%, … idle 92.0%" puts values after labels; "2% user … 97% idle" before.
    let user = words.iter().position(|w| w.eq_ignore_ascii_case("user"));
    let label_first = !user.and_then(|u| u.checked_sub(1)).and_then(|p| words.get(p)).is_some_and(|w| w.ends_with('%'));
    let value = if label_first { words.get(i + 1) } else { words.get(i.checked_sub(1)?) };
    value.and_then(|w| w.strip_suffix('%')).and_then(num)
}

/// Cisco NX-OS "show system resources".
pub(crate) fn nxos_stats(out: &str) -> Option<Stats> {
    let cpu = 100.0 - idle_percent(out.lines().find(|l| l.contains("CPU states"))?)?;
    let mem = out.lines().find(|l| l.contains("Memory usage"))?;
    let k = |key: &str| mem.split(',').find(|p| p.contains(key)).and_then(|p| num(p.split(':').next_back()?.trim().trim_end_matches(|c: char| !c.is_ascii_digit())));
    let total = k("total")? as u64 * 1024;
    let used = k("used")? as u64 * 1024;
    Some(Stats { cpu, mem_used: used, mem_total: total, ..Stats::default() })
}

/// Cisco ASA "show cpu usage" + "show memory".
pub(crate) fn asa_stats(cpu_out: &str, mem_out: &str) -> Option<Stats> {
    let cpu = num(after(cpu_out, "5 seconds =")?)?;
    let bytes = |key: &str| after(mem_out, key).and_then(num).map(|n| n as u64);
    Some(Stats { cpu, mem_used: bytes("Used memory").unwrap_or(0), mem_total: bytes("Total memory").unwrap_or(0), ..Stats::default() })
}

/// FortiGate "get system performance status".
pub(crate) fn fortigate_stats(out: &str) -> Option<Stats> {
    let cpu = 100.0 - idle_percent(out.lines().find(|l| l.trim_start().starts_with("CPU states"))?)?;
    let mem = after(out, "Memory:")?;
    let k = |key: &str| mem.split(',').find(|p| p.contains(key)).and_then(|p| num(p.trim()));
    Some(Stats { cpu, mem_used: (k("used")? * 1024.0) as u64, mem_total: (k("total")? * 1024.0) as u64, ..Stats::default() })
}

/// Aruba AOS-CX "show system resource-utilization" (percentages only).
pub(crate) fn aruba_cx_stats(out: &str) -> Option<Stats> {
    let pct = |key: &str| out.lines().find(|l| l.contains(key)).and_then(|l| num(l.rsplit(':').next()?));
    let cpu = pct("CPU usage")?;
    Some(Stats { cpu, mem_percent: pct("Memory usage"), ..Stats::default() })
}

/// Aruba AOS-Switch "show cpu" + "show system".
pub(crate) fn aruba_switch_stats(cpu_out: &str, sys_out: &str) -> Option<Stats> {
    let cpu = cpu_out
        .lines()
        .find(|l| l.contains("1 sec ave"))
        .or_else(|| cpu_out.lines().find(|l| l.contains("percent busy")))
        .and_then(|l| {
            let before = l.split("percent").next()?;
            num(before.rsplit([' ', ':']).find(|w| !w.is_empty())?)
        })?;
    let total = sys_out.lines().find(|l| l.contains("Total") && l.contains(':')).and_then(|l| num(l.rsplit(':').next()?));
    let free = sys_out.lines().find(|l| l.trim_start().starts_with("Free") && l.contains(':')).and_then(|l| num(l.rsplit(':').next()?));
    let (used, total) = match (total, free) {
        (Some(t), Some(f)) if t >= f => ((t - f) as u64, t as u64),
        _ => (0, 0),
    };
    Some(Stats { cpu, mem_used: used, mem_total: total, ..Stats::default() })
}

/// Aruba controller "show cpuload" + "show memory".
pub(crate) fn aruba_controller_stats(cpu_out: &str, mem_out: &str) -> Option<Stats> {
    let cpu = 100.0 - idle_percent(cpu_out.lines().find(|l| l.contains("idle"))?)?;
    let line = mem_out.lines().find(|l| l.contains("total:"))?;
    let kb = |key: &str| line.split(',').find(|p| p.contains(key)).and_then(|p| num(p.rsplit(':').next()?));
    Some(Stats { cpu, mem_used: kb("used").unwrap_or(0.0) as u64 * 1024, mem_total: kb("total").unwrap_or(0.0) as u64 * 1024, ..Stats::default() })
}

/// Junos "show chassis routing-engine" (first routing engine): CPU from the
/// "Idle N percent" row; memory from "Total memory 2048 MB Max 983 MB used",
/// or on older releases "DRAM 2048 MB" with "Memory utilization 46 percent".
pub(crate) fn junos_stats(out: &str) -> Option<Stats> {
    let idle = out.lines().find(|l| l.trim_start().starts_with("Idle")).and_then(|l| num(l.trim_start().trim_start_matches("Idle")))?;
    let mb = |v: f64| (v * 1024.0 * 1024.0) as u64;
    let (used, total) = if let Some(l) = out.lines().find(|l| l.trim_start().starts_with("Total memory")) {
        let n: Vec<f64> = l.split_whitespace().filter_map(|w| w.parse().ok()).collect();
        (n.get(1).copied().map(mb).unwrap_or(0), n.first().copied().map(mb).unwrap_or(0))
    } else {
        let dram = out.lines().find(|l| l.trim_start().starts_with("DRAM")).and_then(|l| num(l.trim_start().trim_start_matches("DRAM")));
        let pct = out.lines().find(|l| l.contains("Memory utilization")).and_then(|l| num(l.split("utilization").nth(1)?));
        match (dram, pct) {
            (Some(d), Some(p)) => (mb(d * p / 100.0), mb(d)),
            _ => (0, 0),
        }
    };
    Some(Stats { cpu: 100.0 - idle, mem_used: used, mem_total: total, ..Stats::default() })
}

/// Huawei VRP "display cpu-usage" ("CPU Usage : 6% Max: 23%", or "CPU
/// utilization for five seconds: 6%: ...") and "display memory-usage"
/// ("System Total Memory Is: N bytes|Kbytes", "Total Memory Used Is: ...").
pub(crate) fn vrp_stats(cpu_out: &str, mem_out: &str) -> Option<Stats> {
    let cpu = cpu_out.lines().find_map(|l| {
        let rest = if l.trim_start().starts_with("CPU Usage") && !l.contains("Stat") {
            l.split_once(':')?.1
        } else {
            l.split_once("five seconds:")?.1
        };
        num(rest)
    })?;
    let bytes = |key: &str| {
        mem_out.lines().find(|l| l.contains(key)).and_then(|l| {
            let rest = l.split_once(':')?.1;
            let n = num(rest)?;
            Some(if rest.to_lowercase().contains("kbyte") { n * 1024.0 } else { n } as u64)
        })
    };
    Some(Stats { cpu, mem_used: bytes("Memory Used Is").unwrap_or(0), mem_total: bytes("Total Memory Is").unwrap_or(0), ..Stats::default() })
}

/// "VRP (R) software, Version 5.170 (S5735 V200R021C00SPC100)" -> "VRP 5.170 (S5735 V200R021C00SPC100)".
pub(crate) fn vrp_label(out: &str) -> Option<String> {
    if !out.contains("Huawei Versatile Routing Platform") && !out.contains("VRP (R) software") {
        return None;
    }
    let ver = out.lines().find_map(|l| l.split_once("VRP (R) software, Version").map(|(_, r)| r.trim())).unwrap_or("");
    Some(format!("VRP {ver}").trim().to_string())
}

/// vmstat (AIX, HP-UX): CPU busy % from the last sample row, and the "free"
/// column (pages) if present.
pub(crate) fn vmstat_cpu(out: &str) -> Option<(f64, Option<f64>)> {
    let lines: Vec<&str> = out.lines().collect();
    let header = lines.iter().rposition(|l| {
        let w: Vec<&str> = l.split_whitespace().collect();
        w.contains(&"us") && w.contains(&"sy") && w.contains(&"id")
    })?;
    let names: Vec<&str> = lines[header].split_whitespace().collect();
    let row: Vec<f64> = lines[header + 1..]
        .iter()
        .rev()
        .map(|l| l.split_whitespace().filter_map(|w| w.parse::<f64>().ok()).collect::<Vec<_>>())
        .find(|r| r.len() == names.len())?;
    let col = |name: &str| names.iter().position(|n| *n == name).map(|i| row[i]);
    Some((100.0 - col("id")?, col("free")))
}

/// AIX "svmon -G -O unit=KB": the "memory" row (size, inuse, …) in KB.
pub(crate) fn svmon_memory(out: &str) -> Option<(u64, u64)> {
    let l = out.lines().find(|l| l.trim_start().starts_with("memory"))?;
    let n: Vec<f64> = l.split_whitespace().skip(1).filter_map(|w| w.parse().ok()).collect();
    Some(((n.get(1)? * 1024.0) as u64, (n.first()? * 1024.0) as u64))
}

/// AIX "vmstat -v" (no root needed): "4194304 memory pages", "1234567 free
/// pages", 4 KB pages → (used, total) bytes.
pub(crate) fn vmstat_v_memory(out: &str) -> Option<(u64, u64)> {
    let pages = |what: &str| {
        out.lines().find_map(|l| {
            let l = l.trim();
            l.strip_suffix(what)?.trim().parse::<u64>().ok()
        })
    };
    let (total, free) = (pages("memory pages")?, pages("free pages")?);
    Some(((total.saturating_sub(free)) * 4096, total * 4096))
}

/// HP-UX machinfo "Memory: 16353 MB (15.97 GB)" / "Memory = 16353 MB".
pub(crate) fn machinfo_memory(out: &str) -> Option<u64> {
    let l = out.lines().find(|l| l.trim_start().starts_with("Memory"))?;
    let rest = l.split([':', '=']).nth(1)?.trim();
    let n = num(rest)?;
    let unit = rest.split_whitespace().nth(1).unwrap_or("MB").to_uppercase();
    let mul = match unit.as_str() {
        "GB" => 1024.0 * 1024.0 * 1024.0,
        "KB" => 1024.0,
        _ => 1024.0 * 1024.0,
    };
    Some((n * mul) as u64)
}

/// Root file system from `df -Pk /` or `bdf /` (rows may wrap): (used, total) bytes.
pub(crate) fn df_root(out: &str) -> Option<(u64, u64)> {
    let words: Vec<&str> = out.split_whitespace().collect();
    let i = words.iter().rposition(|w| *w == "/")?;
    if i < 4 || !words[i - 1].ends_with('%') {
        return None;
    }
    let total: f64 = words[i - 4].parse().ok()?;
    let used: f64 = words[i - 3].parse().ok()?;
    Some(((used * 1024.0) as u64, (total * 1024.0) as u64))
}

// ---- per-kind commands --------------------------------------------------------------------

const LINUX_CMD: &str = "head -n 1 /proc/stat; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached):' /proc/meminfo; df -Pk / 2>/dev/null | tail -n 1";

const AIX_TOP: &str = "echo @@C''PU; ps aux | head -n 1; ps aux | sed 1d | sort -rn -k3 | head -n 10; \
echo @@M''EM; ps aux | head -n 1; ps aux | sed 1d | sort -rn -k4 | head -n 10; echo @@D''ISK; df -k; echo @@EN''D";

const HPUX_TOP: &str = "echo @@C''PU; UNIX95=1 ps -eo pcpu,vsz,pid,user,comm | head -n 1; \
UNIX95=1 ps -eo pcpu,vsz,pid,user,comm | sed 1d | sort -rn | head -n 10; \
echo @@M''EM; UNIX95=1 ps -eo vsz,pcpu,pid,user,comm | head -n 1; \
UNIX95=1 ps -eo vsz,pcpu,pid,user,comm | sed 1d | sort -rn | head -n 10; echo @@D''ISK; bdf; echo @@EN''D";

const SOLARIS_TOP: &str = "echo @@C''PU; ps -eo pcpu,vsz,pid,user,comm | head -n 1; \
ps -eo pcpu,vsz,pid,user,comm | sed 1d | sort -rn | head -n 10; \
echo @@M''EM; ps -eo vsz,pcpu,pid,user,comm | head -n 1; \
ps -eo vsz,pcpu,pid,user,comm | sed 1d | sort -rn | head -n 10; echo @@D''ISK; df -k; echo @@EN''D";

/// `memstat`: this IOS device answers only "show memory statistics" (learned
/// on the first poll, so later polls send two commands, not three).
async fn stats(t: &mut Line, kind: Kind, prev: &mut Option<(u64, u64)>, memstat: &mut bool) -> Result<Option<Stats>, String> {
    Ok(match kind {
        Kind::Linux => {
            let out = t.run(LINUX_CMD).await?;
            let lines: Vec<String> = out.lines().map(str::to_string).collect();
            parse_block(&lines, prev)
        }
        Kind::Aix => {
            let out = t
                .run("vmstat 1 2; svmon -G -O unit=KB 2>/dev/null | grep '^memory'; vmstat -v 2>/dev/null | grep -E 'memory pages|free pages'; df -Pk / 2>/dev/null")
                .await?;
            vmstat_cpu(&out).map(|(cpu, _)| {
                let (mem_used, mem_total) = svmon_memory(&out).or_else(|| vmstat_v_memory(&out)).unwrap_or((0, 0));
                let disk = df_root(&out);
                Stats { cpu, mem_used, mem_total, disk_used: disk.map(|d| d.0), disk_total: disk.map(|d| d.1), ..Stats::default() }
            })
        }
        Kind::Hpux => {
            let out = t.run("vmstat 1 2; /usr/contrib/bin/machinfo 2>/dev/null | grep -i '^ *memory'; bdf / 2>/dev/null").await?;
            vmstat_cpu(&out).map(|(cpu, free_pages)| {
                let total = machinfo_memory(&out).unwrap_or(0);
                let free = free_pages.map(|p| p as u64 * 4096).unwrap_or(0);
                let disk = df_root(&out);
                Stats {
                    cpu,
                    mem_used: total.saturating_sub(free),
                    mem_total: if total > free { total } else { 0 },
                    disk_used: disk.map(|d| d.0),
                    disk_total: disk.map(|d| d.1),
                    ..Stats::default()
                }
            })
        }
        Kind::Ios | Kind::IosXe => {
            let cpu = t.run("show processes cpu | include CPU utilization").await?;
            let mem = if *memstat {
                t.run("show memory statistics | include Processor").await?
            } else {
                let m = t.run("show processes memory | include Processor Pool").await?;
                if ios_memory(&m).is_none() {
                    *memstat = true;
                    t.run("show memory statistics | include Processor").await?
                } else {
                    m
                }
            };
            ios_cpu(&cpu).map(|c| {
                let (used, total) = ios_memory(&mem).unwrap_or((0, 0));
                Stats { cpu: c, mem_used: used, mem_total: total, ..Stats::default() }
            })
        }
        Kind::Nxos => nxos_stats(&t.run("show system resources").await?),
        Kind::Asa => {
            let cpu = t.run("show cpu usage").await?;
            let mem = t.run("show memory").await?;
            asa_stats(&cpu, &mem)
        }
        Kind::Fortigate => fortigate_stats(&t.run("get system performance status").await?),
        Kind::ArubaCx => aruba_cx_stats(&t.run("show system resource-utilization").await?),
        Kind::ArubaSwitch => {
            let cpu = t.run("show cpu").await?;
            let sys = t.run("show system").await?;
            aruba_switch_stats(&cpu, &sys)
        }
        Kind::ArubaController => {
            let cpu = t.run("show cpuload").await?;
            let mem = t.run("show memory").await?;
            aruba_controller_stats(&cpu, &mem)
        }
        Kind::Solaris => {
            // vmstat "free" is in KB on Solaris.
            let out = t.run("vmstat 1 2; /usr/sbin/prtconf 2>/dev/null | grep 'Memory size'; df -k / 2>/dev/null").await?;
            vmstat_cpu(&out).map(|(cpu, free_kb)| {
                let total = machinfo_memory(&out).unwrap_or(0);
                let free = free_kb.map(|k| k as u64 * 1024).unwrap_or(0);
                let disk = df_root(&out);
                Stats {
                    cpu,
                    mem_used: total.saturating_sub(free),
                    mem_total: if total > free { total } else { 0 },
                    disk_used: disk.map(|d| d.0),
                    disk_total: disk.map(|d| d.1),
                    ..Stats::default()
                }
            })
        }
        Kind::Junos => junos_stats(&t.run("show chassis routing-engine").await?),
        Kind::Vrp => {
            let cpu = t.run("display cpu-usage").await?;
            let mem = t.run("display memory-usage").await?;
            vrp_stats(&cpu, &mem)
        }
    })
}

/// A command's output as a table section (first rows only).
fn raw_section(title: &str, out: &str, rows: usize) -> Section {
    Section { title: title.into(), lines: body(out).into_iter().take(rows).map(|l| l.trim_end().to_string()).collect() }
}

/// Header plus the first `n` rows of an IOS "show processes ... sorted" table.
fn ios_table(out: &str, header: &str, n: usize) -> Vec<String> {
    let lines: Vec<&str> = out.lines().collect();
    let Some(start) = lines.iter().position(|l| l.contains("PID") && l.contains(header)) else { return Vec::new() };
    lines[start..]
        .iter()
        .take(n + 1)
        .take_while(|l| !is_prompt(l.trim()))
        .map(|l| l.trim_end().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// The busiest processes, read between two polls.
async fn top(t: &mut Line, kind: Kind) -> Result<Vec<Section>, String> {
    let cpu_title = "CPU 사용률 상위";
    let mut sections = match kind {
        Kind::Linux | Kind::Aix | Kind::Hpux | Kind::Solaris => {
            let script = match kind {
                Kind::Linux => TOP_SCRIPT,
                Kind::Aix => AIX_TOP,
                Kind::Solaris => SOLARIS_TOP,
                _ => HPUX_TOP,
            };
            parse_top(&t.run_script(script).await?)
        }
        Kind::Ios | Kind::IosXe => {
            let cpu = t.run("show processes cpu sorted").await?;
            let mem = t.run("show processes memory sorted").await?;
            let mut s = vec![
                Section { title: "CPU 사용률 상위 10개".into(), lines: ios_table(&cpu, "Process", 10) },
                Section { title: "메모리 사용량 상위 10개".into(), lines: ios_table(&mem, "Holding", 10) },
            ];
            if let Some(line) = cpu.lines().find(|l| l.contains("CPU utilization")) {
                s[0].lines.insert(0, line.trim().to_string());
            }
            s
        }
        Kind::Nxos => vec![raw_section(cpu_title, &t.run("show processes cpu sort").await?, 16)],
        Kind::Asa => vec![raw_section(cpu_title, &t.run("show processes cpu-usage sorted non-zero").await?, 16)],
        Kind::Fortigate => vec![raw_section(cpu_title, &t.run("diagnose sys top 1 15 1").await?, 20)],
        Kind::ArubaCx => vec![raw_section("리소스 사용률", &t.run("show system resource-utilization").await?, 30)],
        Kind::ArubaSwitch => vec![raw_section(cpu_title, &t.run("show cpu process").await?, 20)],
        Kind::ArubaController => vec![raw_section(cpu_title, &t.run("show processes sort-by cpu").await?, 16)],
        Kind::Junos => vec![raw_section(cpu_title, &t.run("show system processes extensive").await?, 24)],
        Kind::Vrp => vec![raw_section("CPU 사용률", &t.run("display cpu-usage").await?, 30)],
    };
    sections.retain(|s| !s.lines.is_empty());
    Ok(sections)
}

async fn backup(t: &mut Line, kind: Kind) -> Result<String, String> {
    let cmd = kind.backup().ok_or("이 장비는 설정 백업을 지원하지 않습니다")?;
    let out = t.run_for(cmd, BACKUP_LIMIT).await?;
    let lines = body(&out);
    let text = lines.join("\r\n");
    if text.trim().is_empty() {
        return Err("설정을 읽지 못했습니다".into());
    }
    backup_complete(kind, &lines)?;
    Ok(text + "\r\n")
}

/// The device's refusal ("% Invalid input" at user EXEC, a read-only login)
/// or a configuration cut short is not a backup.
pub(crate) fn backup_complete(kind: Kind, lines: &[&str]) -> Result<(), String> {
    let refused = lines.iter().take(5).map(|l| l.trim()).find(|l| {
        let low = l.to_lowercase();
        l.starts_with('%') || low.starts_with("error") || low.starts_with("command fail") || low.contains("unrecognized command") || low.contains("invalid input")
    });
    if let Some(line) = refused {
        return Err(format!("장비가 설정 보기를 거부했습니다: {line}"));
    }
    let last = lines.iter().rev().map(|l| l.trim()).find(|l| !l.is_empty()).unwrap_or("");
    let complete = match kind {
        Kind::Ios | Kind::IosXe | Kind::Asa | Kind::ArubaSwitch | Kind::ArubaController => last == "end" || last == ": end",
        Kind::Vrp => last == "return",
        Kind::Fortigate => lines.iter().any(|l| l.trim_start().starts_with("#config-version")),
        _ => true,
    };
    if !complete {
        return Err("설정의 끝을 받지 못해 백업하지 않았습니다. 다시 시도하세요".into());
    }
    Ok(())
}

/// Identify the device behind `prompt`. Read-only commands only; on other
/// systems they just print an error.
async fn detect(t: &mut Line, prompt: &str) -> Result<Option<(Kind, String, String)>, String> {
    let uname = t.run("uname -sr").await?;
    if let Some(kind) = unix_kind(&uname) {
        let label = match kind {
            Kind::Linux => {
                let os = t.run("cat /etc/redhat-release 2>/dev/null || (. /etc/os-release 2>/dev/null; echo \"$PRETTY_NAME\")").await?;
                body(&os).iter().map(|l| l.trim()).find(|l| !l.is_empty()).unwrap_or("Linux").to_string()
            }
            // `uname -sr` says "AIX 3"; the technology level is more useful.
            Kind::Aix => {
                let level = t.run("oslevel -s").await?;
                match body(&level).iter().map(|l| l.trim()).find(|l| l.starts_with(|c: char| c.is_ascii_digit())) {
                    Some(level) => format!("AIX {level}"),
                    None => "AIX".to_string(),
                }
            }
            // "Oracle Solaris 11.4 X86" says more than "SunOS 5.11".
            Kind::Solaris => {
                let release = t.run("head -n 1 /etc/release").await?;
                body(&release)
                    .iter()
                    .map(|l| l.trim())
                    .find(|l| l.contains("Solaris"))
                    .map(str::to_string)
                    .unwrap_or_else(|| body(&uname).first().map(|l| l.trim().to_string()).unwrap_or_default())
            }
            _ => body(&uname).first().map(|l| l.trim().to_string()).unwrap_or_default(),
        };
        let host = t.run("hostname").await?;
        let name = body(&host).first().map(|l| l.trim().to_string()).unwrap_or_default();
        return Ok(Some((kind, label, name)));
    }
    let name = prompt_name(last_line(prompt));
    let version = t.run("show version").await?;
    if let Some((kind, label)) = version_kind(&version) {
        return Ok(Some((kind, label, name)));
    }
    let status = t.run("get system status").await?;
    if let Some(label) = fortios_label(&status) {
        let host = after(&status, "Hostname:").map(|h| h.to_string()).filter(|h| !h.is_empty()).unwrap_or(name);
        return Ok(Some((Kind::Fortigate, label, host)));
    }
    // Huawei answers "show version" with an error; its own word is "display".
    let display = t.run("display version").await?;
    if let Some(label) = vrp_label(&display) {
        return Ok(Some((Kind::Vrp, label, name)));
    }
    Ok(None)
}

/// Identify the device, then poll it until the connection fails or the task
/// is stopped. `report` gets {device} once, then {stats, warmup} events.
pub(crate) async fn drive(
    mut t: Line,
    prompt: String,
    mut report: impl FnMut(Value),
    mut queries: mpsc::Receiver<Query>,
) -> Result<(), String> {
    t.prompt = Some(last_line(&prompt).to_string()).filter(|p| !p.is_empty());
    let Some((kind, label, name)) = detect(&mut t, &prompt).await? else {
        report(json!({ "unsupported": true }));
        return Ok(());
    };
    if let Some(cmd) = kind.pager_off() {
        let _ = t.run(cmd).await;
    }
    if !kind.network() {
        // This hidden shell's polls stay out of the user's shell history
        // (ksh shares ~/.sh_history with the user's own session).
        t.send("PROMPT_COMMAND=; PS1='bxmon> '; export PS1; set +o history 2>/dev/null; HISTFILE=/dev/null; export HISTFILE; unset HISTFILE").await?;
        let old = t.prompt.clone();
        let out = t
            .until(move |x| { let l = last_line(x); l == "bxmon>" || ((old.as_deref() == Some(l) || is_prompt(l)) && x.contains('\n') && !l.contains("PS1=")) }, STEP)
            .await?;
        // csh and the like keep their own prompt; that one stays learned.
        if last_line(&out) == "bxmon>" {
            t.prompt = Some("bxmon>".into());
        }
    }
    report(json!({ "device": {
        "kind": kind.id(),
        "vendor": kind.vendor(),
        "label": label.trim(),
        "name": name,
        "network": kind.network(),
        "backup": kind.backup().is_some(),
    }}));

    let mut prev = None;
    let mut memstat = false;
    let mut first = true;
    // No tab of this device on screen: sample only every few minutes, enough
    // to keep the login from timing out (Cisco exec-timeout is 10 minutes).
    let mut paused = false;
    let mut sample = true;
    loop {
        if sample {
            match stats(&mut t, kind, &mut prev, &mut memstat).await? {
                // Device counters are ready averages; Linux /proc needs two samples.
                Some(s) => report(json!({ "stats": s, "warmup": first && kind == Kind::Linux })),
                None => {
                    report(json!({ "unsupported": true }));
                    return Ok(());
                }
            }
            first = false;
        }
        // Here every sample runs programs in an interactive shell (Telnet,
        // or the SSH shell fallback; plain SSH Linux uses an exec channel and
        // does not come here): sample Linux as gently as AIX.
        let every = if kind == Kind::Linux { Kind::Aix.interval() } else { kind.interval() };
        let wait = if paused { PAUSED_INTERVAL } else { Duration::from_secs(every) };
        sample = tokio::select! {
            _ = tokio::time::sleep(wait) => true,
            query = queries.recv() => match query {
                // A failed query can leave the device mid-output (at --More--,
                // or still printing): later replies would be out of step, so
                // the monitor stops rather than type into the pager.
                Some(Query::Top(reply)) => {
                    let r = top(&mut t, kind).await;
                    let failed = r.is_err();
                    let _ = reply.send(r);
                    if failed { return Err(OUT_OF_STEP.into()) }
                    !paused
                }
                Some(Query::Backup(reply)) => {
                    let r = backup(&mut t, kind).await;
                    let lost = matches!(&r, Err(e) if !e.starts_with("장비가 설정 보기를 거부") && !e.starts_with("설정의 끝을"));
                    let _ = reply.send(r);
                    if lost { return Err(OUT_OF_STEP.into()) }
                    !paused
                }
                Some(Query::Commands(reply)) => {
                    if kind.network() {
                        let _ = reply.send(Err("네트워크 장비는 명령 목록을 읽지 않습니다".into()));
                    } else {
                        let r = t.run_script(COMMANDS_SCRIPT).await.map(|out| parse_commands(&out));
                        let failed = r.is_err();
                        let _ = reply.send(r);
                        if failed { return Err(OUT_OF_STEP.into()) }
                    }
                    false
                }
                // Shown again: a fresh sample at once.
                Some(Query::Pause(p)) => { let resumed = paused && !p; paused = p; resumed }
                None => return Ok(()),
            }
        };
    }
}

const OUT_OF_STEP: &str = "장비의 응답이 끝나지 않아 자원 표시를 멈췄습니다. 탭을 다시 연결하면 다시 시작합니다";

/// Telnet: connect, log in, then `drive`.
/// A session's proxy and its login.
pub(crate) type Route = (crate::proxy::ProxyConfig, crate::proxy::Auth);

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_telnet(
    host: &str,
    port: u16,
    username: &str,
    password: Option<&str>,
    no_password: bool,
    report: impl FnMut(Value),
    queries: mpsc::Receiver<Query>,
    proxy: Option<Route>,
) -> Result<(), String> {
    let mut t = Line::telnet(host, port, proxy.as_ref()).await?;
    // Each wait has its own limit, but a login can keep going (banners, Enter
    // after Enter): never leave the status bar at "checking" without a reason.
    let prompt = match tokio::time::timeout(LOGIN_LIMIT, login(&mut t, username, password, no_password)).await {
        Ok(r) => r?,
        Err(_) => {
            let last = last_line(&t.text).chars().take(80).collect::<String>();
            return Err(format!("로그인이 {}초 안에 끝나지 않았습니다 (마지막 화면: {})", LOGIN_LIMIT.as_secs(), if last.is_empty() { "없음".into() } else { last }));
        }
    };
    drive(t, prompt, report, queries).await
}

/// SSH shell (already authenticated): wait for the prompt, then `drive`.
pub(crate) async fn run_shell(mut t: Line, report: impl FnMut(Value), queries: mpsc::Receiver<Query>) -> Result<(), String> {
    let prompt = t.first_prompt().await?;
    drive(t, prompt, report, queries).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_devices() {
        assert_eq!(unix_kind("uname -sr\nLinux 5.14.0-362.el9.x86_64\n[root@h ~]#"), Some(Kind::Linux));
        assert_eq!(unix_kind("uname -sr\nAIX 3\n$"), Some(Kind::Aix));
        assert_eq!(unix_kind("uname -sr\nHP-UX B.11.31\n#"), Some(Kind::Hpux));
        assert_eq!(unix_kind("uname -sr\n% Invalid input detected at '^' marker.\nSW1#"), None);
        assert_eq!(unix_kind("uname -sr\nUnknown action 0\nFGT # "), None);

        let k = |s: &str| version_kind(s);
        assert_eq!(k("Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E2, RELEASE SOFTWARE (fc3)"), Some((Kind::Ios, "IOS 15.2(7)E2".into())));
        assert_eq!(k("Cisco IOS XE Software, Version 17.06.04\nCisco IOS Software [Bengaluru], Catalyst L3 Switch Software"), Some((Kind::IosXe, "IOS-XE 17.06.04".into())));
        assert_eq!(k("Cisco Nexus Operating System (NX-OS) Software\n  NXOS: version 9.3(8)\n"), Some((Kind::Nxos, "NX-OS 9.3(8)".into())));
        assert_eq!(k("Cisco Adaptive Security Appliance Software Version 9.16(3)19\nFirepower Extensible"), Some((Kind::Asa, "ASA 9.16(3)19".into())));
        assert_eq!(k("-----------------------------------------------------------------------------\nArubaOS-CX\n(c) Copyright Hewlett Packard Enterprise\nVersion      : FL.10.10.1010\nBuild Date   : 2022-08-04"), Some((Kind::ArubaCx, "AOS-CX FL.10.10.1010".into())));
        assert_eq!(k("Aruba Operating System Software.\nArubaOS (MODEL: Aruba7010), Version 8.10.0.6\n"), Some((Kind::ArubaController, "ArubaOS 8.10.0.6".into())));
        assert_eq!(k("Image stamp:    /ws/swbuildm/rel_orlando_qaoff/code/build/anm(swbuildm_rel_orlando_qaoff_rel_orlando)\n                Jun 17 2021 14:28:04\n                WC.16.10.0012\n                1258\nBoot Image:     Primary"), Some((Kind::ArubaSwitch, "AOS-Switch WC.16.10.0012".into())));
        assert_eq!(k("bash: show: command not found"), None);
        assert_eq!(fortios_label("Version: FortiGate-60F v7.2.5,build1517,230606 (GA.F)\nSerial-Number: FGT60F\nHostname: FW-HQ"), Some("FortiGate-60F v7.2.5".into()));

        assert_eq!(prompt_name("SW-CORE-01#"), "SW-CORE-01");
        assert_eq!(prompt_name("(Aruba7010) #"), "Aruba7010");
        assert_eq!(prompt_name("FGT60F (global) #"), "FGT60F");
        assert!(is_pager(" --More-- ") && is_pager("-- MORE --, next page: Space, next line: Enter, quit: Control-C") && is_pager("<--- More --->"));
        assert!(!is_prompt("--More--") && is_prompt("SW1#"));
    }

    #[test]
    fn parses_device_counters() {
        let s = nxos_stats("Load average:   1 minute: 0.34   5 minutes: 0.41   15 minutes: 0.43\nCPU states  :   3.21% user,   2.88% kernel,   93.89% idle\nMemory usage:   16400084K total,   7213252K used,   9186832K free\n").unwrap();
        assert!((s.cpu - 6.11).abs() < 0.01 && s.mem_total == 16400084 * 1024 && s.mem_used == 7213252 * 1024);

        let s = asa_stats("CPU utilization for 5 seconds = 12%; 1 minute: 9%; 5 minutes: 8%", "Free memory:        2913374512 bytes (68%)\nUsed memory:        1381618896 bytes (32%)\n-------------     ------------------\nTotal memory:       4294993408 bytes (100%)").unwrap();
        assert_eq!((s.cpu, s.mem_used, s.mem_total), (12.0, 1381618896, 4294993408));

        let s = fortigate_stats("CPU states: 2% user 1% system 0% nice 97% idle 0% iowait 0% irq 0% softirq\nCPU0 states: 2% user 1% system 0% nice 97% idle\nMemory: 1903740k total, 1084376k used (57.0%), 698412k free (36.7%), 120952k freeable (6.3%)\n").unwrap();
        assert!((s.cpu - 3.0).abs() < 0.01 && s.mem_total == 1903740 * 1024 && s.mem_used == 1084376 * 1024);

        let s = aruba_cx_stats("System Resource utilization:\n  CPU usage(%)       : 6\n  Memory usage(%)    : 27\n  Open FD's          : 1696\n").unwrap();
        assert_eq!((s.cpu, s.mem_percent), (6.0, Some(27.0)));

        let s = aruba_switch_stats(
            "4 percent busy, from 300 sec ago\n1 sec ave: 3 percent busy\n5 sec ave: 5 percent busy",
            " Memory   - Total   : 339,738,624\n            Free    : 196,111,104\n",
        )
        .unwrap();
        assert_eq!((s.cpu, s.mem_total, s.mem_used), (3.0, 339738624, 339738624 - 196111104));

        let s = aruba_controller_stats("user 3.6%, system 4.4%, idle 92.0%", "Memory (Kb): total: 4012908, used: 2283764, free: 1729144").unwrap();
        assert!((s.cpu - 8.0).abs() < 0.01 && s.mem_total == 4012908 * 1024 && s.mem_used == 2283764 * 1024);

        // AIX: vmstat header + rows, svmon in KB, df -Pk.
        let aix = "System configuration: lcpu=8 mem=16384MB ent=2.00\n\nkthr    memory              page              faults              cpu\n----- ----------- ------------------------ ------------ -----------------------\n r  b   avm   fre  re  pi  po  fr   sr  cy  in   sy  cs us sy id wa    pc    ec\n 1  0 2010432 1234567   0   0   0   0    0   0  12  345  67  5  3 92  0  0.10   5.0\n 2  0 2010432 1234560   0   0   0   0    0   0  15  400  70 10  5 84  1  0.20  10.0\nmemory        16777216      9437184      7340032      2097152      8388608\nFilesystem    1024-blocks      Used Available Capacity Mounted on\n/dev/hd4         2097152    786432   1310720      38% /\n";
        assert_eq!(vmstat_cpu(aix).map(|v| v.0), Some(16.0));
        assert_eq!(svmon_memory(aix), Some((9437184 * 1024, 16777216 * 1024)));
        assert_eq!(df_root(aix), Some((786432 * 1024, 2097152 * 1024)));

        // HP-UX: vmstat with a free column, machinfo, wrapped bdf row.
        let hp = "         procs           memory                   page                              faults       cpu\n    r     b     w      avm    free   re   at    pi   po    fr   de    sr     in     sy    cs  us sy id\n    1     0     0   612345  1048576    0    0     0    0     0    0     0    120   3456   234   4  2 94\n    1     0     0   612345  1048000    0    0     0    0     0    0     0    130   3500   240   7  3 90\nMemory: 16353 MB (15.97 GB)\nFilesystem          kbytes    used   avail %used Mounted on\n/dev/vg00/lvol3\n                   1048576  245680  796032   24% /\n";
        let (cpu, free) = vmstat_cpu(hp).unwrap();
        assert_eq!((cpu, free), (10.0, Some(1048000.0)));
        assert_eq!(machinfo_memory(hp), Some(16353 * 1024 * 1024));
        assert_eq!(df_root(hp), Some((245680 * 1024, 1048576 * 1024)));

        let ios = "show processes cpu | include CPU utilization\nCPU utilization for five seconds: 17%/2%; one minute: 9%; five minutes: 8%\nSwitch>";
        assert_eq!(ios_cpu(ios), Some(17.0));
        assert_eq!(ios_memory("Processor Pool Total:  826441600 Used:  271838136 Free:  554603464\nSwitch>"), Some((271838136, 826441600)));
        assert_eq!(ios_cpu("% Invalid input detected at '^' marker."), None);
    }

    #[test]
    fn prompts_and_cleaning() {
        assert!(is_prompt("Switch>") && is_prompt("Router#") && is_prompt("user@host:~$"));
        assert!(!is_prompt("Password:") && !is_prompt(""));
        assert_eq!(clean("\x1b[1;32mok\x1b[0m\r\nx\x08y"), "ok\ny");
    }
}

#[cfg(test)]
mod device_tests {
    use super::*;

    #[test]
    fn keeps_split_characters_and_escapes_for_the_next_read() {
        let word = "스위치".as_bytes();
        assert_eq!(complete_len(&word[..4]), 3); // second syllable cut after one byte
        assert_eq!(complete_len(word), word.len());
        assert_eq!(complete_len(b"Switch\x1b[0"), 6);
        assert_eq!(complete_len(b"Switch\x1b"), 6);
        assert_eq!(complete_len(b"Switch\x1b[0m#"), 11);
    }

    /// Linux login: a "Last failed login" banner before the shell prompt is a
    /// success; "Login incorrect" followed by another login prompt is a failure.
    #[tokio::test]
    async fn login_judges_by_the_next_prompt() {
        async fn attempt(password: &str) -> Result<(), String> {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            tokio::spawn(async move {
                let (mut s, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 1024];
                s.write_all(b"host login: ").await.unwrap();
                let mut line = String::new();
                loop {
                    let n = s.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    line.push_str(&String::from_utf8_lossy(&buf[..n]));
                    while let Some(i) = line.find('\r') {
                        let cmd: String = line.drain(..=i).collect();
                        let reply: &[u8] = match cmd.trim() {
                            "root" => b"Password: ",
                            "good" => b"\r\nLast failed login: Tue Oct 14 from 10.0.0.9 on ssh:notty\r\nThere was 1 failed login attempt since the last successful login.\r\n[root@host ~]# ",
                            _ => b"\r\nLogin incorrect\r\nhost login: ",
                        };
                        let _ = s.write_all(reply).await;
                    }
                }
            });
            let mut t = Line::telnet("127.0.0.1", port, None).await?;
            login(&mut t, "root", Some(password), false).await.map(|_| ())
        }
        assert_eq!(attempt("good").await, Ok(()));
        assert_eq!(attempt("bad").await, Err("인증에 실패했습니다".to_string()));
    }

    /// A fake Cisco IOS device over Telnet: login, identification by "show
    /// version", paging off, stats, the sorted process tables between two
    /// polls, and a running-config backup that goes through a --More-- pager.
    #[tokio::test]
    async fn monitors_a_fake_ios_device() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            s.write_all(b"\r\nUser Access Verification\r\n\r\nUsername: ").await.unwrap();
            let mut line = String::new();
            let mut paging = false;
            loop {
                let n = s.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    return;
                }
                line.push_str(&String::from_utf8_lossy(&buf[..n]));
                if paging && line.contains(' ') {
                    // The pager's space: the rest of the configuration.
                    line.clear();
                    paging = false;
                    let _ = s.write_all(b"\x08\x08\x08\x08\x08\x08\x08\x08        \x08\x08\x08\x08\x08\x08\x08\x08hostname SW-CORE-01\r\n!\r\nend\r\n\r\nSW-CORE-01#").await;
                    continue;
                }
                while let Some(i) = line.find('\r') {
                    let cmd: String = line.drain(..=i).collect();
                    let cmd = cmd.trim().to_string();
                    let reply = match cmd.as_str() {
                        "admin" => "Password: ".to_string(),
                        "secret" => "\r\nSW-CORE-01#".to_string(),
                        "terminal length 0" => "\r\nSW-CORE-01#".to_string(),
                        "show version" => "\r\nCisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E2, RELEASE SOFTWARE (fc3)\r\nSW-CORE-01 uptime is 3 weeks\r\nSW-CORE-01#".to_string(),
                        "show running-config" => {
                            paging = true;
                            "\r\nBuilding configuration...\r\n\r\nCurrent configuration : 1234 bytes\r\n!\r\nversion 15.2\r\n --More-- ".to_string()
                        }
                        "show processes cpu sorted" => "\r\nCPU utilization for five seconds: 12%/1%; one minute: 9%; five minutes: 8%\r\n PID Runtime(ms)     Invoked      uSecs   5Sec   1Min   5Min TTY Process \r\n 187     4523460    13398219        337  6.47%  2.11%  1.96%   0 IP Input         \r\n  86      921060     4527321        203  0.31%  0.27%  0.25%   0 ARP Input        \r\nSW-CORE-01#".to_string(),
                        "show processes memory sorted" => "\r\nProcessor Pool Total:  1000 Used:  250 Free:  750\r\n\r\n PID TTY  Allocated      Freed    Holding    Getbufs    Retbufs Process\r\n   0   0  112045640   37012312   68920560          0          0 *Init*          \r\nSW-CORE-01#".to_string(),
                        c if c.starts_with("show processes cpu") => "\r\nCPU utilization for five seconds: 12%/1%; one minute: 9%; five minutes: 8%\r\nSW-CORE-01#".to_string(),
                        c if c.starts_with("show processes memory") => "\r\nProcessor Pool Total:  1000 Used:  250 Free:  750\r\nSW-CORE-01#".to_string(),
                        _ => "\r\n% Invalid input detected at '^' marker.\r\nSW-CORE-01#".to_string(),
                    };
                    if s.write_all(reply.as_bytes()).await.is_err() {
                        return;
                    }
                }
            }
        });
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        let (query, queries) = mpsc::channel(1);
        let monitor = tokio::spawn(async move {
            run_telnet("127.0.0.1", port, "admin", Some("secret"), false, move |e| sink.lock().unwrap().push(e), queries, None).await
        });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !events.lock().unwrap().iter().any(|e: &Value| e.get("stats").is_some()) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let (reply, answer) = oneshot::channel();
        query.send(Query::Top(reply)).await.unwrap();
        let top = tokio::time::timeout(Duration::from_secs(8), answer).await.unwrap().unwrap().unwrap();
        let (reply, answer) = oneshot::channel();
        query.send(Query::Backup(reply)).await.unwrap();
        let config = tokio::time::timeout(Duration::from_secs(10), answer).await.unwrap().unwrap().unwrap();
        // Network gear has no PATH: refused without typing anything.
        let (reply, answer) = oneshot::channel();
        query.send(Query::Commands(reply)).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(5), answer).await.unwrap().unwrap().is_err());
        monitor.abort();

        let events = events.lock().unwrap();
        let device = &events.iter().find(|e| e.get("device").is_some()).expect("device")["device"];
        assert_eq!((device["kind"].as_str(), device["label"].as_str(), device["name"].as_str()), (Some("cisco-ios"), Some("IOS 15.2(7)E2"), Some("SW-CORE-01")));
        assert_eq!((device["network"].as_bool(), device["backup"].as_bool()), (Some(true), Some(true)));
        let first = events.iter().find(|e| e.get("stats").is_some()).expect("no sample");
        assert_eq!(first["stats"]["cpu"], 12.0, "{events:?}");
        assert_eq!(first["stats"]["memUsed"], 250);
        assert_eq!(first["warmup"], false);
        assert_eq!(top.len(), 2, "{top:?}");
        assert!(top[0].lines[0].starts_with("CPU utilization") && top[0].lines[2].contains("IP Input"), "{top:?}");
        assert!(config.contains("version 15.2") && config.contains("hostname SW-CORE-01") && config.trim_end().ends_with("end"), "{config:?}");
        assert!(!config.contains("More"), "the pager line is not part of the backup: {config:?}");
    }

    /// A Unix shell as a PTY shows it: the command echoed, its output, then
    /// the prompt. Answers the monitor's commands from \`replies\`; PS1 changes
    /// the prompt like a real shell; Enter alone shows the prompt again.
    async fn fake_unix<S>(mut io: S, banner: &str, mut prompt: String, replies: Vec<(&'static str, &'static str)>)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let _ = io.write_all(format!("{banner}{prompt}").as_bytes()).await;
        let mut buf = [0u8; 4096];
        let mut line = String::new();
        loop {
            let n = io.read(&mut buf).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            line.push_str(&String::from_utf8_lossy(&buf[..n]));
            while let Some(i) = line.find('\r') {
                let cmd: String = line.drain(..=i).collect();
                let cmd = cmd.trim().to_string();
                if cmd.starts_with("PS1=") {
                    prompt = "bxmon> ".into();
                }
                let out = replies.iter().find(|(c, _)| cmd.starts_with(c)).map(|(_, o)| *o).unwrap_or("");
                let out = if out.is_empty() { String::new() } else { format!("{out}\r\n") };
                if io.write_all(format!("{cmd}\r\n{out}{prompt}").as_bytes()).await.is_err() {
                    return;
                }
            }
        }
    }

    /// Events of a monitor until it reported a sample (or 15 s).
    async fn first_sample(events: &std::sync::Arc<std::sync::Mutex<Vec<Value>>>) -> (Value, Value) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while !events.lock().unwrap().iter().any(|e: &Value| e.get("stats").is_some() || e.get("unsupported").is_some()) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let events = events.lock().unwrap();
        let device = events.iter().find(|e| e.get("device").is_some()).map(|e| e["device"].clone()).unwrap_or_default();
        let stats = events.iter().find(|e| e.get("stats").is_some()).map(|e| e["stats"].clone()).unwrap_or_else(|| json!({ "events": *events }));
        (device, stats)
    }

    const AIX_VMSTAT: &str = "\r\nSystem configuration: lcpu=8 mem=16384MB ent=1.00\r\n\r\nkthr    memory              page              faults              cpu\r\n----- ----------- ------------------------ ------------ -----------------------\r\n r  b   avm   fre  re  pi  po  fr   sr  cy  in   sy  cs us sy id wa    pc    ec\r\n 1  0 2345678 456789   0   0   0   0    0   0  12  345  67  5  3 90  2  0.10  10.0\r\n 2  0 2345678 456700   0   0   0   0    0   0  20  400  80 12  8 78  2  0.20  20.0\r\n      4194304 memory pages\r\n      1048576 free pages\r\nFilesystem    1024-blocks      Used Available Capacity Mounted on\r\n/dev/hd4          2097152    524288   1572864      25% /";

    /// AIX over SSH with a custom prompt that ends in "]" (not $ # >) and an
    /// account without root (svmon refuses): recognised, prompt learned,
    /// memory from vmstat -v.
    #[tokio::test]
    async fn monitors_aix_with_a_custom_prompt() {
        let (client, server) = tokio::io::duplex(64 * 1024);
        tokio::spawn(fake_unix(
            server,
            "*******************************************************************************\r\n*  Welcome to AIX Version 7.3!  *\r\n*******************************************************************************\r\nLast login: Thu Oct 15 09:12:01 KST 2026 on ssh from 10.1.2.3\r\n",
            "[monitor@aix01 /home/monitor]".into(),
            vec![
                ("uname -sr", "AIX 3"),
                ("oslevel -s", "7300-02-01-2346"),
                ("hostname", "aix01"),
                ("show version", "ksh: show:  not found."),
                ("get system status", "ksh: get:  not found."),
                ("vmstat 1 2", AIX_VMSTAT),
                ("echo @@C''MDS", "@@CMDS\r\nlsdev\r\nlslpp\r\nsvmon\r\n@@END"),
            ],
        ));
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        let (query, queries) = mpsc::channel(1);
        let monitor = tokio::spawn(async move { run_shell(Line::shell(client), move |e| sink.lock().unwrap().push(e), queries).await });
        let (device, stats) = first_sample(&events).await;
        // The command list for suggestions, asked between two samples.
        let (reply, answer) = oneshot::channel();
        query.send(Query::Commands(reply)).await.unwrap();
        let names = tokio::time::timeout(Duration::from_secs(8), answer).await.unwrap().unwrap().unwrap();
        assert_eq!(names, ["lsdev", "lslpp", "svmon"]);
        monitor.abort();
        assert_eq!((device["kind"].as_str(), device["label"].as_str(), device["name"].as_str()), (Some("aix"), Some("AIX 7300-02-01-2346"), Some("aix01")), "{stats}");
        assert_eq!(stats["cpu"], 22.0, "{stats}");
        assert_eq!((stats["memUsed"].as_u64(), stats["memTotal"].as_u64()), (Some(3145728 * 4096), Some(4194304 * 4096)));
        assert_eq!(stats["diskTotal"].as_u64(), Some(2097152 * 1024));
    }

    /// HP-UX over Telnet: the login script asks "TERM = (hp)" and waits; the
    /// default is taken, then the device is recognised.
    #[tokio::test]
    async fn monitors_hpux_after_the_term_question() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let mut line = String::new();
            let _ = s.write_all(b"\r\nHP-UX hpux01 B.11.31 U ia64 (ta)\r\n\r\nlogin: ").await;
            let mut stage = 0;
            loop {
                let n = s.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    return;
                }
                line.push_str(&String::from_utf8_lossy(&buf[..n]));
                while let Some(i) = line.find('\r') {
                    let cmd: String = line.drain(..=i).collect();
                    let reply: &[u8] = match (stage, cmd.trim()) {
                        (0, _) => b"\r\nPassword:",
                        (1, "hp-pass") => b"\r\nPlease wait...checking for disk quotas\r\n(c)Copyright 1983-2006 Hewlett-Packard Development Company, L.P.\r\n\r\nTERM = (hp) ",
                        (1, _) => b"\r\nLogin incorrect\r\nlogin: ",
                        _ => b"",
                    };
                    stage += 1;
                    if stage == 3 {
                        // Answered the TERM question: a normal shell from here.
                        let _ = s.write_all(b"\r\n").await;
                        fake_unix(
                            s,
                            "",
                            "$ ".into(),
                            vec![
                                ("uname -sr", "HP-UX B.11.31"),
                                ("hostname", "hpux01"),
                                ("show version", "sh: show:  not found."),
                                ("get system status", "sh: get:  not found."),
                                ("vmstat 1 2", "         procs           memory                   page                              faults       cpu\r\n    r     b     w      avm    free   re   at    pi   po    fr   de    sr     in     sy    cs  us sy id\r\n    1     0     0   123456  262144    0    0     0    0     0    0     0   1234   5678   123   1  2 97\r\n    2     0     0   123456  262144    0    0     0    0     0    0     0   1300   6000   130   6  4 90\r\nMemory: 4096 MB (4 GB)\r\nFilesystem          kbytes    used   avail %used Mounted on\r\n/dev/vg00/lvol3    1048576  262144  786432   25% /"),
                            ],
                        )
                        .await;
                        return;
                    }
                    let _ = s.write_all(reply).await;
                }
            }
        });
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        let (_query, queries) = mpsc::channel(1);
        let monitor = tokio::spawn(async move {
            run_telnet("127.0.0.1", port, "monitor", Some("hp-pass"), false, move |e| sink.lock().unwrap().push(e), queries, None).await
        });
        let (device, stats) = first_sample(&events).await;
        monitor.abort();
        assert_eq!((device["kind"].as_str(), device["label"].as_str(), device["name"].as_str()), (Some("hpux"), Some("HP-UX B.11.31"), Some("hpux01")), "{stats}");
        assert_eq!(stats["cpu"], 10.0, "{stats}");
        assert_eq!(stats["memTotal"].as_u64(), Some(4096 * 1024 * 1024));
        assert_eq!(stats["diskTotal"].as_u64(), Some(1048576 * 1024));
    }

    /// AIX 5.3 over Telnet, as a user's server greets: a "**" banner box
    /// before "login:", "root's Password:", a "*" welcome box, last-login
    /// lines with an address, then the prompt "pstcp:/# ".
    #[tokio::test]
    async fn monitors_aix_53_over_telnet() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let mut line = String::new();
            let star = |t: &str| format!("**  {t:<56}**\r\n");
            let banner = format!(
                "\r\ntelnet (pstcp)\r\n\r\n\r\n{0}\r\n{1}{2}{1}{3}{4}{1}{5}{1}{0}\r\nlogin: ",
                "*".repeat(62),
                star(""),
                star("              WARNING NOTICE !!!"),
                star("YOU ARE CONNECTED TO A PRIVATE NETWORK."),
                star("UNAUTHORIZED USE IS PROHIBITED."),
                star("EXAMPLE CORP"),
            );
            let _ = s.write_all(banner.as_bytes()).await;
            let mut stage = 0;
            loop {
                let n = s.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    return;
                }
                line.push_str(&String::from_utf8_lossy(&buf[..n]));
                while let Some(i) = line.find('\r') {
                    let cmd: String = line.drain(..=i).collect();
                    match (stage, cmd.trim()) {
                        (0, _) => {
                            let _ = s.write_all(b"root\r\nroot's Password: ").await;
                        }
                        (1, "aix-pass") => {
                            let welcome = format!(
                                "\r\n{0}\r\n*{1}*\r\n*  Welcome to AIX Version 5.3!{2}*\r\n*{1}*\r\n{0}\r\nLast unsuccessful login: Wed Aug 17 14:53:49 PST 2022 on /dev/pts/49 from 192.0.2.199\r\nLast login: Tue Jun 23 17:53:43 PST 2026 on /dev/pts/1 from pstcs_per\r\n\r\n",
                                "*".repeat(80),
                                " ".repeat(78),
                                " ".repeat(49)
                            );
                            fake_unix(
                                s,
                                &welcome,
                                "pstcp:/# ".into(),
                                vec![
                                    ("uname -sr", "AIX 3"),
                                    ("oslevel -s", "5300-12-04-1119"),
                                    ("hostname", "pstcp"),
                                    ("show version", "ksh: show:  not found."),
                                    ("get system status", "ksh: get:  not found."),
                                    ("vmstat 1 2", "\r\nSystem Configuration: lcpu=4 mem=7936MB\r\n\r\nkthr    memory              page              faults        cpu\r\n----- ----------- ------------------------ ------------ -----------\r\n r  b   avm   fre  re  pi  po  fr   sr  cy  in   sy  cs us sy id wa\r\n 1  0 1234567 456789   0   0   0   0    0   0  12  345  67  5  3 90  2\r\n 1  0 1234567 456700   0   0   0   0    0   0  20  400  80 12  8 78  2\r\n      2031616 memory pages\r\n       456700 free pages\r\nFilesystem    1024-blocks      Used Available Capacity Mounted on\r\n/dev/hd4          1048576    524288    524288      50% /"),
                                ],
                            )
                            .await;
                            return;
                        }
                        (1, _) => {
                            let _ = s.write_all(b"\r\n3004-007 You entered an invalid login name or password.\r\nlogin: ").await;
                        }
                        _ => {}
                    }
                    stage += 1;
                }
            }
        });
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        let (_query, queries) = mpsc::channel(1);
        let monitor = tokio::spawn(async move { run_telnet("127.0.0.1", port, "root", Some("aix-pass"), false, move |e| sink.lock().unwrap().push(e), queries, None).await });
        let (device, stats) = first_sample(&events).await;
        let ended = if monitor.is_finished() { format!("{:?}", monitor.await) } else { monitor.abort(); String::new() };
        assert_eq!((device["kind"].as_str(), device["name"].as_str()), (Some("aix"), Some("pstcp")), "{stats} {ended}");
        assert_eq!(stats["cpu"], 22.0, "{stats}");
    }

    /// RHEL over Telnet: bash's PROMPT_COMMAND sets the window title (an OSC
    /// sequence, ESC ] 0;user@host:~ BEL) right before every prompt, also
    /// after the monitor changed PS1. The monitor must still see its prompt.
    #[tokio::test]
    async fn monitors_rhel_whose_prompt_sets_the_window_title() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let title = "\x1b]0;root@rhel9:~\x07";
            let mut prompt = "[root@rhel9 ~]# ".to_string();
            let _ = s.write_all(b"\r\nRed Hat Enterprise Linux 9.2 (Plow)\r\nKernel 5.14.0 on an x86_64\r\n\r\nrhel9 login: ").await;
            let mut buf = [0u8; 4096];
            let mut line = String::new();
            let mut stage = 0;
            loop {
                let n = s.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    return;
                }
                line.push_str(&String::from_utf8_lossy(&buf[..n]));
                while let Some(i) = line.find('\r') {
                    let cmd: String = line.drain(..=i).collect();
                    let cmd = cmd.trim().to_string();
                    let reply = match stage {
                        0 => "\r\nPassword: ".to_string(),
                        1 => format!("\r\nLast login: Fri Oct 16 09:00:00 from 10.0.0.9\r\n{title}{prompt}"),
                        _ => {
                            if cmd.starts_with("PS1=") {
                                prompt = "bxmon> ".into();
                            }
                            let out = if cmd == "uname -sr" {
                                "Linux 5.14.0-284.11.1.el9_2.x86_64\r\n"
                            } else if cmd.starts_with("cat /etc/redhat-release") {
                                "Red Hat Enterprise Linux release 9.2 (Plow)\r\n"
                            } else if cmd == "hostname" {
                                "rhel9\r\n"
                            } else if cmd.starts_with("head -n 1 /proc/stat") {
                                "cpu  100 0 100 800 0 0 0 0 0 0\r\nMemTotal:        8000000 kB\r\nMemAvailable:    6000000 kB\r\n/dev/mapper/rhel-root 52403200 13107200 39295999  26% /\r\n"
                            } else {
                                ""
                            };
                            format!("{cmd}\r\n{out}{title}{prompt}")
                        }
                    };
                    stage += 1;
                    if s.write_all(reply.as_bytes()).await.is_err() {
                        return;
                    }
                }
            }
        });
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        let (_query, queries) = mpsc::channel(1);
        let monitor = tokio::spawn(async move { run_telnet("127.0.0.1", port, "root", Some("pw"), false, move |e| sink.lock().unwrap().push(e), queries, None).await });
        let (device, stats) = first_sample(&events).await;
        let ended = monitor.is_finished();
        monitor.abort();
        assert!(!ended, "the monitor gave up: {:?}", events.lock().unwrap());
        assert_eq!((device["kind"].as_str(), device["name"].as_str()), (Some("linux"), Some("rhel9")), "{stats}");
        assert_eq!(stats["memTotal"].as_u64(), Some(8000000 * 1024), "{stats}");
    }

    #[test]
    fn cleaning_removes_window_titles() {
        assert_eq!(clean("\x1b]0;root@h:~\x07[root@h ~]# "), "[root@h ~]# ");
        assert_eq!(clean("\x1b]2;title\x1b\\bxmon> "), "bxmon> ");
        // A title cut at the end of a read is kept for the next one.
        assert_eq!(complete_len(b"ok\r\n\x1b]0;root@h"), 4);
    }

    #[test]
    fn reads_aix_memory_without_root() {
        assert_eq!(vmstat_v_memory("      4194304 memory pages\n      1048576 free pages\n"), Some((3145728 * 4096, 4194304 * 4096)));
        assert_eq!(vmstat_v_memory("nothing"), None);
    }

    /// FortiGate over an SSH-like shell (no Telnet): identified by "get system
    /// status" after "uname"/"show version" fail harmlessly.
    #[tokio::test]
    async fn identifies_a_fortigate_shell() {
        let (client, mut server) = tokio::io::duplex(64 * 1024);
        tokio::spawn(async move {
            let _ = server.write_all(b"FW-HQ # ").await;
            let mut buf = [0u8; 1024];
            let mut line = String::new();
            loop {
                let n = server.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    return;
                }
                line.push_str(&String::from_utf8_lossy(&buf[..n]));
                while let Some(i) = line.find('\r') {
                    let cmd: String = line.drain(..=i).collect();
                    let cmd = cmd.trim().to_string();
                    let reply = match cmd.as_str() {
                        "get system status" => "Version: FortiGate-100F v7.2.5,build1517,230606 (GA.F)\r\nSerial-Number: FG100F\r\nHostname: FW-HQ\r\n".to_string(),
                        "get system performance status" => "CPU states: 2% user 1% system 0% nice 97% idle 0% iowait 0% irq 0% softirq\r\nMemory: 1903740k total, 1084376k used (57.0%), 698412k free (36.7%)\r\n".to_string(),
                        "uname -sr" | "show version" => "Unknown action 0\r\nCommand fail. Return code -1\r\n".to_string(),
                        _ => "Unknown action 0\r\n".to_string(),
                    };
                    if server.write_all(format!("{cmd}\r\n{reply}\r\nFW-HQ # ").as_bytes()).await.is_err() {
                        return;
                    }
                }
            }
        });
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        let (_query, queries) = mpsc::channel(1);
        let monitor = tokio::spawn(async move { run_shell(Line::shell(client), move |e| sink.lock().unwrap().push(e), queries).await });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !events.lock().unwrap().iter().any(|e: &Value| e.get("stats").is_some()) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        monitor.abort();
        let events = events.lock().unwrap();
        let device = &events.iter().find(|e| e.get("device").is_some()).expect("device")["device"];
        assert_eq!((device["kind"].as_str(), device["label"].as_str(), device["name"].as_str()), (Some("fortigate"), Some("FortiGate-100F v7.2.5"), Some("FW-HQ")));
        let stats = &events.iter().find(|e| e.get("stats").is_some()).expect("stats")["stats"];
        assert_eq!(stats["cpu"], 3.0);
        assert_eq!(stats["memTotal"], 1903740u64 * 1024);
    }
}

#[cfg(test)]
mod more_vendor_tests {
    use super::*;

    #[test]
    fn solaris_is_a_unix_kind_with_kb_free_memory() {
        assert_eq!(unix_kind("uname -sr\r\nSunOS 5.11\r\n$ "), Some(Kind::Solaris));
        let out = " kthr      memory            page            disk          faults      cpu\n r b w   swap  free  re  mf pi po fr de sr s0 s1 s2 s3   in   sy   cs us sy id\n 0 0 0 9001224 1048576 12 40 0 0 0 0 0 0 0 0 0 1200 3400 900 3 2 95\n 0 0 0 9000000 1048576 0 1 0 0 0 0 0 0 0 0 0 1100 3000 800 7 3 90\nMemory size: 16384 Megabytes\nFilesystem            kbytes    used   avail capacity  Mounted on\nrpool/ROOT/solaris  41029632 12345678 28000000    31%    /\n";
        let (cpu, free) = vmstat_cpu(out).unwrap();
        assert_eq!(cpu, 10.0);
        assert_eq!(free, Some(1048576.0));
        assert_eq!(machinfo_memory(out), Some(16384 * 1024 * 1024));
        assert_eq!(df_root(out), Some((12345678 * 1024, 41029632 * 1024)));
    }

    #[test]
    fn junos_version_and_routing_engine() {
        let (k, label) = version_kind("Hostname: edge1\nModel: mx204\nJunos: 21.4R3-S1.5\nJUNOS OS Kernel 64-bit\n").unwrap();
        assert_eq!((k, label.as_str()), (Kind::Junos, "Junos 21.4R3-S1.5"));
        let (_, old) = version_kind("Hostname: ex1\nModel: ex4200-48t\nJUNOS Base OS boot [12.3R12.4]\n").unwrap();
        assert_eq!(old, "Junos 12.3R12.4");
        let re = "Routing Engine status:\n    Temperature                 39 degrees C / 102 degrees F\n    Total memory              2048 MB Max   983 MB used ( 48 percent)\n    CPU utilization:\n      User                       2 percent\n      Kernel                     3 percent\n      Idle                      95 percent\n";
        let s = junos_stats(re).unwrap();
        assert_eq!(s.cpu, 5.0);
        assert_eq!((s.mem_used, s.mem_total), (983 * 1024 * 1024, 2048 * 1024 * 1024));
        let older = "    DRAM                      1024 MB\n    Memory utilization          50 percent\n    Idle                      80 percent\n";
        let s = junos_stats(older).unwrap();
        assert_eq!((s.cpu, s.mem_used, s.mem_total), (20.0, 512 * 1024 * 1024, 1024 * 1024 * 1024));
    }

    #[test]
    fn huawei_vrp_version_cpu_and_memory() {
        let v = "Huawei Versatile Routing Platform Software\r\nVRP (R) software, Version 5.170 (S5735 V200R021C00SPC100)\r\nCopyright (C) 2000-2021 HUAWEI TECH Co., Ltd.\r\n";
        assert_eq!(vrp_label(v).as_deref(), Some("VRP 5.170 (S5735 V200R021C00SPC100)"));
        assert_eq!(vrp_label("% Invalid input detected at '^' marker."), None);
        let cpu = "CPU Usage Stat. Cycle: 60 (Second)\r\nCPU Usage            : 6% Max: 23%\r\n";
        let mem = "Memory utilization statistics at 2026-10-18 06:00:00\r\nSystem Total Memory Is: 2147483648 bytes\r\nTotal Memory Used Is: 1015802176 bytes\r\nMemory Using Percentage Is: 47%\r\n";
        let s = vrp_stats(cpu, mem).unwrap();
        assert_eq!((s.cpu, s.mem_used, s.mem_total), (6.0, 1015802176, 2147483648));
        let s = vrp_stats("CPU utilization for five seconds: 12%: one minute: 9%: five minutes: 8%", "System Total Memory Is: 4194304 Kbytes\nTotal Memory Used Is: 2097152 Kbytes").unwrap();
        assert_eq!((s.cpu, s.mem_used, s.mem_total), (12.0, 2097152 * 1024, 4194304 * 1024));
    }

    #[test]
    fn prompt_names_of_huawei_and_junos() {
        assert_eq!(prompt_name("<CORE-SW01>"), "CORE-SW01");
        assert_eq!(prompt_name("admin@edge1>"), "edge1");
        assert_eq!(prompt_name("SW01(config)#"), "SW01");
    }
}

#[cfg(test)]
mod safety_tests {
    use super::*;

    #[test]
    fn banner_borders_are_not_prompts() {
        assert!(!is_prompt("##########"));
        assert!(!is_prompt("=====>"));
        assert!(is_prompt("Router#"));
        assert!(is_prompt("user@host:~$"));
        assert!(is_prompt("<SW01>"));
        assert!(is_prompt("$ ".trim_end()));
        assert!(is_prompt("#"));
        assert!(is_pager("---(more 45%)---"));
    }

    #[test]
    fn backups_must_be_complete_configurations() {
        let refused = ["show running-config", "               ^", "% Invalid input detected at '^' marker."];
        assert!(backup_complete(Kind::Ios, &refused[1..]).is_err());
        assert!(backup_complete(Kind::Ios, &["Building configuration...", "hostname R1", "end"]).is_ok());
        assert!(backup_complete(Kind::Ios, &["Building configuration...", "hostname R1", "banner motd ^C"]).is_err());
        assert!(backup_complete(Kind::Vrp, &["sysname HW", "return"]).is_ok());
        assert!(backup_complete(Kind::Fortigate, &["#config-version=FGT100F-7.2.5", "config system global", "end"]).is_ok());
        assert!(backup_complete(Kind::Fortigate, &["Command fail. Return code -61"]).is_err());
        assert!(backup_complete(Kind::Nxos, &["version 9.3(8)", "hostname N9K"]).is_ok());
    }
}
