// Remote resource monitor for SSH tabs (status bar CPU/memory): a
// second, in-process SSH connection runs a small read-only loop on the server
// that prints /proc/stat, /proc/meminfo and the root file system's usage every
// 2 seconds. CPU % comes from the difference between two samples. Linux only;
// other systems report "unsupported" once and the connection is closed.
// `monitor_top` asks the same connection for the busiest processes on demand.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot};

use crate::remote::{known_hosts_path, ssh_login, SshLogin};
use crate::vault;

/// Read-only: for every line the app sends, prints the first line of
/// /proc/stat and the memory lines, then a "." separator; the root file system
/// every 15th sample. Nothing is written on the server. Shell built-ins read
/// /proc, so a sample starts no program at all, and while no tab of the server
/// is on screen the app sends nothing and the loop just waits.
const SCRIPT: &str = "LC_ALL=C; export LC_ALL; i=0; while read go; do read l </proc/stat && echo \"$l\"; \
while read k v u; do case $k in MemTotal:|MemAvailable:|MemFree:|Buffers:|Cached:) echo \"$k $v kB\";; esac; done </proc/meminfo; \
[ $((i % 15)) -eq 0 ] && df -Pk / 2>/dev/null; i=$((i + 1)); echo .; done";

/// Seconds between Linux samples while a tab of the server is on screen.
const SAMPLE_EVERY: Duration = Duration::from_secs(2);

/// Read-only snapshot of the busiest processes and the file systems. Section
/// markers are split with quotes (`@@C''PU`) so the command's own echo on a
/// Telnet line never looks like a marker. `top` takes two frames because the
/// first one averages since boot; without procps `top`, `ps` is used.
pub(crate) const TOP_SCRIPT: &str = "LC_ALL=C; export LC_ALL; echo @@C''PU; \
(top -b -n 2 -d 0.5 -w 200 2>/dev/null | awk '/^ *PID /{n++} n==2' | head -n 11 | grep .) || \
ps -eo pid,user,pcpu,pmem,rss,comm --sort=-pcpu 2>/dev/null | head -n 11; \
echo @@M''EM; ps -eo pid,user,pmem,rss,comm --sort=-rss 2>/dev/null | head -n 11; \
echo @@D''ISK; df -hP 2>/dev/null | grep -vE '^(tmpfs|devtmpfs|overlay|shm|udev|none|efivarfs) '; echo @@EN''D";

/// Read-only list of the programs on the server's PATH, for command-line
/// suggestions. Plain sh syntax, so ksh on AIX and HP-UX runs it too; markers
/// are split with quotes like TOP_SCRIPT's.
pub(crate) const COMMANDS_SCRIPT: &str = "echo @@C''MDS; ( IFS=:; for d in $PATH; do ls -1 \"$d\" 2>/dev/null; done ) | sort -u | head -n 5000; echo @@EN''D";

/// Command names from COMMANDS_SCRIPT output (lines between the markers).
pub(crate) fn parse_commands(text: &str) -> Vec<String> {
    let mut inside = false;
    let mut names = Vec::new();
    for line in text.lines() {
        match line.trim() {
            "@@CMDS" => inside = true,
            "@@END" => break,
            name if inside && !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c)) => names.push(name.to_string()),
            _ => {}
        }
    }
    names
}

/// The script that lists one folder with type marks (ls -F: dir/ exec* link@
/// fifo| socket=), one name per line, for colouring a plain \`ls\` on Unix
/// systems whose ls has no colours. "~" and "~/sub" stay unquoted so the
/// shell expands them; the rest is single-quoted.
pub(crate) fn types_script(folder: &str) -> Result<String, String> {
    if folder.is_empty() || folder.len() > 1024 || folder.chars().any(|c| c.is_control()) || !(folder.starts_with('/') || folder.starts_with('~')) {
        return Err("폴더 경로가 올바르지 않습니다".into());
    }
    let quote = |s: &str| format!("'{}'", s.replace('\'', r"'\''"));
    let target = match folder.strip_prefix('~') {
        Some("") => "~".to_string(),
        Some(rest) if rest.starts_with('/') => format!("~{}", quote(rest)),
        // "~user" forms: not expanded inside quotes, not worth guessing.
        Some(_) => return Err("폴더 경로가 올바르지 않습니다".into()),
        None => quote(folder),
    };
    Ok(format!("echo @@T''YPES; ( cd {target} 2>/dev/null && ls -1aF 2>/dev/null | head -n 5000 ); echo @@EN''D"))
}

/// The lines between "@@TYPES" and "@@END" (names with their ls -F mark).
pub(crate) fn parse_types(text: &str) -> Vec<String> {
    let mut inside = false;
    let mut names = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        match line.trim() {
            "@@TYPES" => inside = true,
            "@@END" => break,
            name if inside && !name.is_empty() => names.push(line.to_string()),
            _ => {}
        }
    }
    names
}

/// One table in the "top processes" view.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Section {
    pub title: String,
    pub lines: Vec<String>,
}

/// Split TOP_SCRIPT output into its sections (lines between exact markers).
pub(crate) fn parse_top(text: &str) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    for line in text.lines() {
        let title = match line.trim() {
            "@@CPU" => Some("CPU 사용률 상위 10개"),
            "@@MEM" => Some("메모리 사용량 상위 10개"),
            "@@DISK" => Some("디스크"),
            "@@END" => break,
            _ => None,
        };
        match (title, sections.last_mut()) {
            (Some(t), _) => sections.push(Section { title: t.into(), lines: Vec::new() }),
            (None, Some(s)) if !line.trim().is_empty() && s.lines.len() < 40 => s.lines.push(line.trim_end().to_string()),
            _ => {}
        }
    }
    sections.retain(|s| !s.lines.is_empty());
    sections
}

/// A running monitor's way to answer `monitor_top`.
#[derive(Clone)]
enum Probe {
    /// Opens another exec channel on the monitor's SSH connection; the
    /// switch pauses the /proc loop.
    Ssh(Arc<russh::client::Handle<crate::remote::HostCheck>>, Arc<tokio::sync::watch::Sender<bool>>),
    /// Asks the device CLI loop (Telnet, or an SSH shell) between two polls.
    Line(mpsc::Sender<crate::devmon::Query>),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorRequest {
    /// The terminal tab's id; events carry it back.
    pub id: String,
    /// "ssh" (default) or "telnet".
    #[serde(default)]
    pub protocol: String,
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub credential_id: Option<String>,
    /// Typed at the status bar prompt; kept only for this connection.
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub trusted_fingerprint: Option<String>,
    /// Telnet: the user said this device takes no password, so the user name
    /// alone is sent (otherwise the login stops before it).
    #[serde(default)]
    pub no_password: bool,
    /// The session's proxy (proxy.rs): the monitor's own login goes through it too.
    #[serde(default)]
    pub proxy: Option<crate::proxy::ProxyConfig>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Percent busy since the previous sample, 0-100.
    pub cpu: f64,
    pub mem_used: u64,
    pub mem_total: u64,
    /// Devices that report memory only as a percentage (Aruba AOS-CX).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem_percent: Option<f64>,
    /// Root file system, bytes (Linux only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_used: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_total: Option<u64>,
}

#[derive(Default)]
pub struct MonitorState {
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
    probes: Mutex<HashMap<String, Probe>>,
}

/// `df -Pk /` data line: "dev 1K-blocks used available capacity /" → (used, total) bytes.
fn disk_root(lines: &[String]) -> Option<(u64, u64)> {
    lines.iter().find_map(|l| {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() < 6 || f[f.len() - 1] != "/" || !f[f.len() - 2].ends_with('%') {
            return None;
        }
        let n = f.len();
        let total: u64 = f[n - 5].parse().ok()?;
        let used: u64 = f[n - 4].parse().ok()?;
        Some((used * 1024, total * 1024))
    })
}

/// Cumulative CPU times from the "cpu" line: (busy, total).
fn cpu_times(line: &str) -> Option<(u64, u64)> {
    let mut it = line.split_whitespace();
    if it.next()? != "cpu" {
        return None;
    }
    let v: Vec<u64> = it.map_while(|x| x.parse().ok()).collect();
    if v.len() < 4 {
        return None;
    }
    let total: u64 = v.iter().take(8).sum(); // user nice system idle iowait irq softirq steal
    let idle = v[3] + v.get(4).copied().unwrap_or(0);
    Some((total - idle, total))
}

/// Parses one block; `prev` holds the last CPU sample for the delta.
pub(crate) fn parse_block(lines: &[String], prev: &mut Option<(u64, u64)>) -> Option<Stats> {
    let now = lines.iter().find_map(|l| cpu_times(l))?;
    let kb = |key: &str| {
        lines
            .iter()
            .find_map(|l| l.strip_prefix(key)?.trim().strip_suffix("kB")?.trim().parse::<u64>().ok())
    };
    let total = kb("MemTotal:")?;
    // Without MemAvailable (kernels before 3.14): free + buffers + cache.
    let available = kb("MemAvailable:").or_else(|| Some(kb("MemFree:")? + kb("Buffers:").unwrap_or(0) + kb("Cached:").unwrap_or(0)))?;
    let cpu = match prev.replace(now) {
        Some((b0, t0)) if now.1 > t0 => (now.0.saturating_sub(b0)) as f64 * 100.0 / (now.1 - t0) as f64,
        _ => 0.0,
    };
    let disk = disk_root(lines);
    Some(Stats {
        cpu: cpu.clamp(0.0, 100.0),
        mem_used: total.saturating_sub(available) * 1024,
        mem_total: total * 1024,
        disk_used: disk.map(|d| d.0),
        disk_total: disk.map(|d| d.1),
        ..Stats::default()
    })
}

/// Unencrypted default keys in ~/.ssh, tried when the session has no vault
/// credential (the terminal's ssh.exe would use them too).
fn default_keys() -> Vec<String> {
    let Some(dir) = dirs::home_dir().map(|h| h.join(".ssh")) else { return Vec::new() };
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|n| dir.join(n))
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[tauri::command]
pub async fn monitor_start(app: AppHandle, state: State<'_, MonitorState>, req: MonitorRequest) -> Result<(), String> {
    let cred = match req.credential_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => Some(vault::resolve(&app, id)?),
        None => None,
    };
    let proxy_auth = crate::proxy::auth_for(&app, req.proxy.as_ref())?;
    if req.protocol == "telnet" {
        // Its own Telnet login; problems (password needed, unsupported device)
        // arrive as events because they show up only after connecting.
        let username = if req.username.is_empty() { cred.as_ref().map(|c| c.username.clone()).unwrap_or_default() } else { req.username.clone() };
        let password = req.password.clone().filter(|p| !p.is_empty()).or_else(|| cred.and_then(|c| c.password));
        let (id, host, port, no_password) = (req.id.clone(), req.host.clone(), req.port.unwrap_or(23), req.no_password);
        let route = req.proxy.clone().map(|p| (p, proxy_auth.clone()));
        let (query_tx, queries) = mpsc::channel(2);
        let task = tauri::async_runtime::spawn(async move {
            let emit = |mut event: serde_json::Value| {
                event["id"] = json!(id);
                let _ = app.emit("monitor-stats", event);
            };
            match crate::devmon::run_telnet(&host, port, &username, password.as_deref(), no_password, emit, queries, route).await {
                Ok(()) => {}
                Err(e) => {
                    let _ = app.emit("monitor-stats", json!({ "id": id, "error": e }));
                }
            }
        });
        state.probes.lock().unwrap().insert(req.id.clone(), Probe::Line(query_tx));
        if let Some(old) = state.tasks.lock().unwrap().insert(req.id, task) {
            old.abort();
        }
        return Ok(());
    }
    let typed_user = if req.username.is_empty() { cred.as_ref().map(|c| c.username.clone()).unwrap_or_default() } else { req.username.clone() };
    // Follow ~/.ssh/config like the terminal's ssh.exe does (alias, user, port).
    let (host, port) = (req.host.clone(), req.port.unwrap_or(22));
    let cfg = tauri::async_runtime::spawn_blocking(move || crate::term::ssh_config(&host, port, &typed_user))
        .await
        .map_err(|e| e.to_string())?;
    let username = cfg.user.clone();
    if username.is_empty() {
        return Err("사용자 이름을 알 수 없습니다".into());
    }
    let password = req.password.clone().filter(|p| !p.is_empty()).or_else(|| cred.as_ref().and_then(|c| c.password.clone()));
    let login = |cred: Option<vault::Resolved>, password: Option<String>| SshLogin {
        host: cfg.hostname.clone(),
        port: cfg.port,
        username: username.clone(),
        password,
        cred,
        trusted_fingerprint: req.trusted_fingerprint.clone(),
        known_hosts: known_hosts_path(),
        proxy: req.proxy.clone(),
        proxy_auth: proxy_auth.clone(),
    };

    // Vault credential or typed password first; otherwise the default keys.
    let mut result = if cred.is_some() || password.is_some() { ssh_login(login(cred, password)).await } else { Err("NEED_PASSWORD".into()) };
    if matches!(&result, Err(e) if e == "NEED_PASSWORD") {
        for key in default_keys() {
            let as_key = vault::Resolved { username: username.clone(), password: None, key_path: Some(key), passphrase: None };
            match ssh_login(login(Some(as_key), None)).await {
                Ok(h) => {
                    result = Ok(h);
                    break;
                }
                Err(e) if e.starts_with("HOSTKEY_") => {
                    result = Err(e);
                    break;
                }
                Err(_) => {}
            }
        }
    }
    let handle = Arc::new(result?);
    let channel = handle.channel_open_session().await.map_err(|e| format!("모니터링 채널을 열 수 없습니다: {e}"))?;
    // Network devices may refuse exec; they get the interactive shell below.
    let exec_ok = channel.exec(true, SCRIPT).await.is_ok();

    let id = req.id.clone();
    let (pause_tx, paused) = tokio::sync::watch::channel(false);
    state.probes.lock().unwrap().insert(req.id.clone(), Probe::Ssh(handle.clone(), Arc::new(pause_tx)));
    let task = tauri::async_runtime::spawn(async move {
        let emit = |mut event: serde_json::Value| {
            event["id"] = json!(id);
            let _ = app.emit("monitor-stats", event);
        };
        if exec_ok
            && let Some(device) = linux_device(&handle).await {
                emit(json!({ "device": device }));
            }
        let end = if exec_ok { pump(channel, &emit, paused).await } else { PumpEnd::Unsupported };
        match end {
            PumpEnd::Closed => {
                forget_probe(&app, &id, &handle);
                emit(json!({ "closed": true }))
            }
            // Not Linux (network gear, AIX, HP-UX): drive the device's own CLI
            // in an interactive shell on the same connection.
            PumpEnd::Unsupported => match open_shell(&handle).await {
                Ok(line) => {
                    let (query_tx, queries) = mpsc::channel(2);
                    app.state::<MonitorState>().probes.lock().unwrap().insert(id.clone(), Probe::Line(query_tx));
                    if let Err(e) = crate::devmon::run_shell(line, &emit, queries).await {
                        emit(json!({ "error": e }));
                    }
                }
                Err(_) => {
                    // Nothing to run here: let go of the logged-in connection.
                    forget_probe(&app, &id, &handle);
                    emit(json!({ "unsupported": true }))
                }
            },
        }
    });
    if let Some(old) = state.tasks.lock().unwrap().insert(req.id, task) {
        old.abort();
    }
    Ok(())
}

/// Drop this monitor's SSH probe (and so its connection), unless a newer
/// monitor for the same id has replaced it meanwhile.
fn forget_probe(app: &AppHandle, id: &str, handle: &Arc<russh::client::Handle<crate::remote::HostCheck>>) {
    let state = app.state::<MonitorState>();
    let mut probes = state.probes.lock().unwrap();
    if matches!(probes.get(id), Some(Probe::Ssh(h, _)) if Arc::ptr_eq(h, handle)) {
        probes.remove(id);
    }
}

/// How the /proc script ended.
enum PumpEnd {
    /// The connection closed after samples (or the task was stopped).
    Closed,
    /// No Linux /proc here (or no exec): try the device CLI instead.
    Unsupported,
}

/// An interactive shell with a wide PTY on the monitor's connection.
async fn open_shell(handle: &russh::client::Handle<crate::remote::HostCheck>) -> Result<crate::devmon::Line, String> {
    let channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.request_pty(true, "vt100", 250, 60, 0, 0, &[]).await.map_err(|e| e.to_string())?;
    channel.request_shell(true).await.map_err(|e| e.to_string())?;
    Ok(crate::devmon::Line::shell(channel.into_stream()))
}

/// Distribution and hostname of a Linux server (RHEL …), for the status bar.
async fn linux_device(handle: &russh::client::Handle<crate::remote::HostCheck>) -> Option<serde_json::Value> {
    let mut channel = handle.channel_open_session().await.ok()?;
    channel
        .exec(true, "uname -s; cat /etc/redhat-release 2>/dev/null || (. /etc/os-release 2>/dev/null; echo \"$PRETTY_NAME\"); hostname")
        .await
        .ok()?;
    let mut out = Vec::new();
    let read = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                russh::ChannelMsg::Data { data } if out.len() < 8192 => out.extend_from_slice(&data),
                russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(5), read).await.ok()?;
    let text = String::from_utf8_lossy(&out);
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.first() != Some(&"Linux") {
        return None;
    }
    Some(json!({
        "kind": "linux",
        "vendor": "Linux",
        "label": lines.get(1).filter(|_| lines.len() > 2).copied().unwrap_or("Linux"),
        "name": lines.last().copied().unwrap_or(""),
        "network": false,
        "backup": false,
    }))
}

/// Read the script's output and report one event per sample ({stats, warmup}).
async fn pump(
    mut channel: russh::Channel<russh::client::Msg>,
    report: impl FnMut(serde_json::Value),
    mut paused: tokio::sync::watch::Receiver<bool>,
) -> PumpEnd {
    // Ask for a sample every 2 s while not paused; at once when resumed.
    let mut writer = channel.make_writer();
    let ticker = async move {
        use tokio::io::AsyncWriteExt as _;
        loop {
            if !*paused.borrow_and_update() && writer.write_all(b"\n").await.is_err() {
                break;
            }
            tokio::select! {
                _ = tokio::time::sleep(SAMPLE_EVERY) => {}
                changed = paused.changed() => if changed.is_err() { break },
            }
        }
        std::future::pending::<()>().await
    };
    tokio::select! {
        end = read_samples(&mut channel, report) => end,
        _ = ticker => unreachable!(),
    }
}

async fn read_samples(channel: &mut russh::Channel<russh::client::Msg>, mut report: impl FnMut(serde_json::Value)) -> PumpEnd {
    let mut pending = String::new();
    let mut block: Vec<String> = Vec::new();
    let mut disk = (None, None);
    let mut prev = None;
    let mut samples = 0u32;
    while let Some(msg) = channel.wait().await {
        let russh::ChannelMsg::Data { data } = msg else { continue };
        pending.push_str(&String::from_utf8_lossy(&data));
        if pending.len() > 64 * 1024 {
            pending.clear(); // not our script's output
        }
        while let Some(nl) = pending.find('\n') {
            let line: String = pending.drain(..=nl).collect();
            let line = line.trim_end().to_string();
            if line != "." {
                if block.len() < 16 {
                    block.push(line);
                }
                continue;
            }
            samples += 1;
            match parse_block(&block, &mut prev) {
                Some(mut stats) => {
                    // The disk is read every 15th sample: keep showing the last value.
                    if stats.disk_total.is_some() {
                        disk = (stats.disk_used, stats.disk_total);
                    } else {
                        (stats.disk_used, stats.disk_total) = disk;
                    }
                    report(json!({ "stats": stats, "warmup": samples == 1 }))
                }
                None => return PumpEnd::Unsupported,
            }
            block.clear();
        }
    }
    // Closed before a single sample: the script could not run here.
    if samples == 0 { PumpEnd::Unsupported } else { PumpEnd::Closed }
}

/// Test helper: run the monitor loop over an already logged-in connection.
#[cfg(test)]
pub(crate) async fn test_pump(handle: &russh::client::Handle<crate::remote::HostCheck>, samples: usize) -> Vec<serde_json::Value> {
    let channel = handle.channel_open_session().await.unwrap();
    channel.exec(true, SCRIPT).await.unwrap();
    let mut events = Vec::new();
    let collected = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = collected.clone();
    let (_keep, paused) = tokio::sync::watch::channel(false);
    let end = tokio::time::timeout(std::time::Duration::from_secs(10), pump(channel, move |e| sink.lock().unwrap().push(e), paused)).await;
    if matches!(end, Ok(PumpEnd::Closed)) {
        collected.lock().unwrap().push(json!({ "closed": true }));
    }
    events.extend(collected.lock().unwrap().drain(..).take(samples));
    events
}

/// Test helper: run the monitor loop over a logged-in connection in the
/// background; returns the samples so far and the pause switch.
#[cfg(test)]
pub(crate) async fn test_pump_live(
    handle: &russh::client::Handle<crate::remote::HostCheck>,
) -> (std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>, tokio::sync::watch::Sender<bool>) {
    let channel = handle.channel_open_session().await.unwrap();
    channel.exec(true, SCRIPT).await.unwrap();
    let samples = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = samples.clone();
    let (pause, paused) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        pump(channel, move |e| if e.get("stats").is_some() { sink.lock().unwrap().push(e) }, paused).await;
    });
    (samples, pause)
}

#[tauri::command]
pub fn monitor_stop(state: State<MonitorState>, id: String) {
    state.probes.lock().unwrap().remove(&id);
    if let Some(task) = state.tasks.lock().unwrap().remove(&id) {
        task.abort(); // drops the channel and the SSH connection
    }
}

/// No tab of this monitor is on screen (or the window is minimised): pause
/// sampling; Linux servers then run nothing at all, devices are asked only
/// every few minutes to keep the login alive.
#[tauri::command]
pub async fn monitor_pause(state: State<'_, MonitorState>, id: String, paused: bool) -> Result<(), String> {
    let probe = state.probes.lock().unwrap().get(&id).cloned();
    match probe {
        Some(Probe::Ssh(_, switch)) => {
            switch.send_replace(paused);
        }
        Some(Probe::Line(tx)) => {
            let _ = tx.send(crate::devmon::Query::Pause(paused)).await;
        }
        None => {}
    }
    Ok(())
}

/// Run a read-only script in a fresh exec channel and collect its output.
async fn ssh_exec(handle: &russh::client::Handle<crate::remote::HostCheck>, script: &str) -> Result<String, String> {
    let mut channel = handle.channel_open_session().await.map_err(|e| format!("모니터링 연결이 끊어졌습니다: {e}"))?;
    channel.exec(true, script).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let read = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                russh::ChannelMsg::Data { data } if out.len() < 256 * 1024 => out.extend_from_slice(&data),
                russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(15), read).await.map_err(|_| "서버가 응답하지 않습니다".to_string())?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Run TOP_SCRIPT in a fresh exec channel.
pub(crate) async fn ssh_top(handle: &russh::client::Handle<crate::remote::HostCheck>) -> Result<Vec<Section>, String> {
    Ok(parse_top(&ssh_exec(handle, TOP_SCRIPT).await?))
}

/// The programs on a monitored Unix server's PATH (for command suggestions),
/// read over the monitor's own connection. Network devices have none.
#[tauri::command]
pub async fn monitor_commands(state: State<'_, MonitorState>, id: String) -> Result<Vec<String>, String> {
    let probe = state.probes.lock().unwrap().get(&id).cloned().ok_or("모니터링이 실행 중이 아닙니다")?;
    match probe {
        Probe::Ssh(handle, _) => Ok(parse_commands(&ssh_exec(&handle, COMMANDS_SCRIPT).await?)),
        Probe::Line(tx) => {
            let (reply, answer) = oneshot::channel();
            tx.send(crate::devmon::Query::Commands(reply)).await.map_err(|_| "모니터링 연결이 끊어졌습니다".to_string())?;
            tokio::time::timeout(Duration::from_secs(30), answer)
                .await
                .map_err(|_| "장비가 응답하지 않습니다".to_string())?
                .map_err(|_| "모니터링 연결이 끊어졌습니다".to_string())?
        }
    }
}

/// The entries of a folder on a monitored Unix server with their ls -F type
/// marks, read over the monitor's own connection (not the engineer's shell).
#[tauri::command]
pub async fn monitor_types(state: State<'_, MonitorState>, id: String, folder: String) -> Result<Vec<String>, String> {
    let script = types_script(&folder)?;
    let probe = state.probes.lock().unwrap().get(&id).cloned().ok_or("모니터링이 실행 중이 아닙니다")?;
    match probe {
        Probe::Ssh(handle, _) => Ok(parse_types(&ssh_exec(&handle, &script).await?)),
        Probe::Line(tx) => {
            let (reply, answer) = oneshot::channel();
            tx.send(crate::devmon::Query::Types(script, reply)).await.map_err(|_| "모니터링 연결이 끊어졌습니다".to_string())?;
            tokio::time::timeout(Duration::from_secs(20), answer)
                .await
                .map_err(|_| "장비가 응답하지 않습니다".to_string())?
                .map_err(|_| "모니터링 연결이 끊어졌습니다".to_string())?
        }
    }
}

/// The busiest processes (and file systems) of a monitored server, read over
/// the monitor's own connection.
#[tauri::command]
pub async fn monitor_top(state: State<'_, MonitorState>, id: String) -> Result<Vec<Section>, String> {
    let probe = state.probes.lock().unwrap().get(&id).cloned().ok_or("모니터링이 실행 중이 아닙니다")?;
    let sections = match probe {
        Probe::Ssh(handle, _) => ssh_top(&handle).await?,
        Probe::Line(tx) => {
            let (reply, answer) = oneshot::channel();
            tx.send(crate::devmon::Query::Top(reply)).await.map_err(|_| "모니터링 연결이 끊어졌습니다".to_string())?;
            tokio::time::timeout(Duration::from_secs(30), answer)
                .await
                .map_err(|_| "장비가 응답하지 않습니다".to_string())?
                .map_err(|_| "모니터링 연결이 끊어졌습니다".to_string())??
        }
    };
    if sections.is_empty() {
        return Err("프로세스 목록을 읽지 못했습니다".into());
    }
    Ok(sections)
}

/// The running configuration of a monitored network device (read over the
/// monitor's own connection, never typed into the user's terminal).
#[tauri::command]
pub async fn monitor_backup(state: State<'_, MonitorState>, id: String) -> Result<String, String> {
    let probe = state.probes.lock().unwrap().get(&id).cloned().ok_or("모니터링이 실행 중이 아닙니다")?;
    let Probe::Line(tx) = probe else { return Err("이 장비는 설정 백업을 지원하지 않습니다".into()) };
    let (reply, answer) = oneshot::channel();
    tx.send(crate::devmon::Query::Backup(reply)).await.map_err(|_| "모니터링 연결이 끊어졌습니다".to_string())?;
    tokio::time::timeout(Duration::from_secs(240), answer)
        .await
        .map_err(|_| "장비가 응답하지 않습니다".to_string())?
        .map_err(|_| "모니터링 연결이 끊어졌습니다".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_list_keeps_names_between_the_markers() {
        // The echoed command line (Telnet) carries the quoted markers, not the real ones.
        let out = "echo @@C''MDS; ( IFS=:; ...\r\n@@CMDS\r\nawk\r\ngit-upload-pack\r\npython3.11\r\nweird name\r\n\x1b[0m\r\n@@END\r\nbxmon> ";
        assert_eq!(parse_commands(out), ["awk", "git-upload-pack", "python3.11"]);
    }

    /// COMMANDS_SCRIPT in a real sh (Git for Windows), PATH = two folders.
    #[test]
    fn command_list_script_reads_every_path_folder() {
        let sh = r"C:\Program Files\Git\usr\bin\sh.exe";
        if !std::path::Path::new(sh).exists() {
            eprintln!("no Git sh: skipped");
            return;
        }
        let dir = std::env::temp_dir().join(format!("bx-cmds-{}", std::process::id()));
        let (a, b) = (dir.join("a b"), dir.join("c"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        for (d, n) in [(&a, "zeta"), (&a, "alpha"), (&b, "alpha"), (&b, "mid")] {
            std::fs::write(d.join(n), "").unwrap();
        }
        let path = |p: &std::path::Path| {
            let s = p.to_string_lossy().replace('\\', "/");
            format!("/{}{}", s[..1].to_lowercase(), &s[2..])
        };
        let out = std::process::Command::new(sh)
            // /usr/bin last: the script's own sort and head come from there.
            .args(["-c", &format!("PATH='{}:{}:/nonexistent:/usr/bin'; {COMMANDS_SCRIPT}", path(&a), path(&b))])
            .output()
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let names = parse_commands(&String::from_utf8_lossy(&out.stdout));
        let found = |n: &str| names.iter().filter(|x| *x == n).count();
        assert_eq!((found("alpha"), found("mid"), found("zeta"), found("sort.exe")), (1, 1, 1, 1), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(names.windows(2).all(|w| w[0] < w[1]), "sorted and unique");
    }

    /// The folder-types script in a real sh: marks per type, quotes kept, the
    /// shell's own folder unchanged, bad paths refused.
    #[test]
    fn types_script_lists_a_folder_with_marks() {
        assert!(types_script("relative/dir").is_err() && types_script("/a\nb").is_err() && types_script("~bob").is_err());
        assert_eq!(types_script("/it's").unwrap(), r"echo @@T''YPES; ( cd '/it'\''s' 2>/dev/null && ls -1aF 2>/dev/null | head -n 5000 ); echo @@EN''D");
        assert!(types_script("~/logs").unwrap().contains("cd ~'/logs'"));
        let sh = r"C:\Program Files\Git\usr\bin\sh.exe";
        if !std::path::Path::new(sh).exists() {
            eprintln!("no Git sh: skipped");
            return;
        }
        let dir = std::env::temp_dir().join(format!("bx-types-{}", std::process::id())).join("it's here");
        std::fs::create_dir_all(dir.join("sub dir")).unwrap();
        std::fs::write(dir.join("notes.txt"), "").unwrap();
        std::fs::write(dir.join("run.sh"), "#!/bin/sh\n").unwrap();
        let s = dir.to_string_lossy().replace('\\', "/");
        let folder = format!("/{}{}", s[..1].to_lowercase(), &s[2..]);
        let out = std::process::Command::new(sh)
            .args(["-c", &format!("PATH=/usr/bin; {}; pwd", types_script(&folder).unwrap())])
            .output()
            .unwrap();
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
        let text = String::from_utf8_lossy(&out.stdout);
        let names = parse_types(&text);
        assert!(names.contains(&"sub dir/".to_string()) && names.contains(&"notes.txt".to_string()) && names.contains(&"run.sh*".to_string()), "{names:?} {}", String::from_utf8_lossy(&out.stderr));
        assert!(!text.trim_end().ends_with("here"), "the shell stays in its folder: {text}");
    }

    fn block(cpu: &str, avail: bool) -> Vec<String> {
        let mut v = vec![cpu.to_string(), "MemTotal:        8000000 kB".into()];
        if avail {
            v.push("MemAvailable:    6000000 kB".into());
        } else {
            v.extend(["MemFree:         1000000 kB".into(), "Buffers:          500000 kB".into(), "Cached:          2500000 kB".into()]);
        }
        v
    }

    #[test]
    fn reads_root_disk_and_top_sections() {
        let lines = vec!["/dev/mapper/rhel-root 52403200 13107200 39295999  26% /".to_string()];
        assert_eq!(disk_root(&lines), Some((13107200 * 1024, 52403200 * 1024)));
        assert_eq!(disk_root(&["tmpfs 100 1 99 1% /run".to_string()]), None);

        // Telnet output: the echoed command (with split markers) comes first.
        let out = "$ LC_ALL=C; export LC_ALL; echo @@C''PU; top ... echo @@EN''D\n@@CPU\n    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n   1234 root      20   0  100000  20000   1000 R  42.0   0.5   1:00.00 java\n@@MEM\n  PID USER     %MEM   RSS COMMAND\n 1234 root      0.5 20000 java\n@@DISK\nFilesystem Size Used Avail Use% Mounted on\n/dev/sda1 50G 13G 37G 26% /\n@@END\n[root@h ~]# ";
        let s = parse_top(out);
        assert_eq!(s.iter().map(|x| x.title.as_str()).collect::<Vec<_>>(), ["CPU 사용률 상위 10개", "메모리 사용량 상위 10개", "디스크"]);
        assert!(s[0].lines[1].contains("java") && s[2].lines.len() == 2);
    }

    #[test]
    fn computes_cpu_from_deltas_and_memory_from_available() {
        let mut prev = None;
        let first = parse_block(&block("cpu  100 0 100 800 0 0 0 0 0 0", true), &mut prev).unwrap();
        assert_eq!(first.cpu, 0.0, "no delta yet");
        assert_eq!((first.mem_used, first.mem_total), (2_000_000 * 1024, 8_000_000 * 1024));
        // +150 busy, +50 idle → 75 %
        let second = parse_block(&block("cpu  200 0 150 850 0 0 0 0 0 0", false), &mut prev).unwrap();
        assert!((second.cpu - 75.0).abs() < 0.01, "{}", second.cpu);
        assert_eq!(second.mem_used, 4_000_000 * 1024, "free+buffers+cached fallback");
        assert!(parse_block(&["% Invalid input detected".to_string()], &mut prev).is_none());
    }
}
