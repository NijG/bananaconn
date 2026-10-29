// AI providers: cloud APIs (Anthropic, OpenAI and OpenAI-compatible
// services, Google Gemini), local models (Ollama, or LM Studio / llama.cpp /
// vLLM through their OpenAI-compatible endpoint), and the official CLIs a
// subscription is signed in with (Claude Code, Codex, Gemini CLI).
//
// The app decides what is sent (the frontend masks and previews it); this
// module only talks to the provider. API keys come from the credential vault
// and never reach the WebView. Replies stream back as "ai-stream" events and
// end with "ai-done". Nothing an AI answers is ever run here.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::http;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    /// "anthropic", "openai", "compatible", "gemini", "ollama" or "cli".
    pub kind: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    /// Vault credential holding the API key (its password).
    #[serde(default)]
    pub credential_id: Option<String>,
    /// For "cli": "claude", "codex" or "gemini".
    #[serde(default)]
    pub cli: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Message {
    /// "user" or "assistant".
    pub role: String,
    pub content: String,
    /// Images and documents sent with this message (base64).
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Attachment {
    /// "image/png", "image/jpeg", "image/webp", "image/gif" or "application/pdf".
    pub mime: String,
    /// Base64 of the bytes.
    pub data: String,
    #[serde(default)]
    pub name: String,
}

fn base64_decode(data: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(data.trim()).ok()
}

fn is_image(a: &Attachment) -> bool {
    matches!(a.mime.as_str(), "image/png" | "image/jpeg" | "image/webp" | "image/gif")
}

/// The attachments a provider kind can take, or why not.
fn check_attachments(kind: &str, cli: &str, messages: &[Message]) -> Result<(), String> {
    for a in messages.iter().flat_map(|m| &m.attachments) {
        let pdf = a.mime == "application/pdf";
        if !is_image(a) && !pdf {
            return Err(format!("보낼 수 없는 첨부 형식입니다: {} ({})", a.name, a.mime));
        }
        let ok = match kind {
            "anthropic" | "gemini" | "openai" => true,
            "compatible" | "ollama" => !pdf,
            "cli" => match cli {
                "claude" => true,
                "codex" => !pdf,
                _ => false,
            },
            _ => false,
        };
        if !ok {
            return Err(if pdf { format!("이 AI 서비스는 PDF 첨부를 받지 않습니다: {}", a.name) } else { format!("이 AI 서비스는 이미지 첨부를 받지 않습니다: {}", a.name) });
        }
    }
    Ok(())
}

/// Anthropic content: images and PDFs as blocks, then the text.
fn anthropic_content(m: &Message) -> Value {
    if m.attachments.is_empty() {
        return json!(m.content);
    }
    let mut blocks: Vec<Value> = m
        .attachments
        .iter()
        .map(|a| {
            let kind = if is_image(a) { "image" } else { "document" };
            json!({ "type": kind, "source": { "type": "base64", "media_type": a.mime, "data": a.data } })
        })
        .collect();
    blocks.push(json!({ "type": "text", "text": m.content }));
    json!(blocks)
}

/// OpenAI (and compatible) content: the text, then images as data URLs and
/// PDFs as files.
fn openai_content(m: &Message) -> Value {
    if m.attachments.is_empty() {
        return json!(m.content);
    }
    let mut parts = vec![json!({ "type": "text", "text": m.content })];
    for a in &m.attachments {
        let url = format!("data:{};base64,{}", a.mime, a.data);
        parts.push(if is_image(a) {
            json!({ "type": "image_url", "image_url": { "url": url } })
        } else {
            json!({ "type": "file", "file": { "filename": if a.name.is_empty() { "document.pdf" } else { a.name.as_str() }, "file_data": url } })
        });
    }
    json!(parts)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    id: String,
    text: String,
    /// The model thinking out loud, not the answer itself: shown live but kept
    /// out of the saved answer.
    reasoning: bool,
}

#[derive(Serialize, Clone)]
struct Done {
    id: String,
    error: Option<String>,
    cancelled: bool,
    /// Prompt and completion tokens, when the provider reports them (CLIs and
    /// some servers do not): omitted when unknown so the UI shows nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<u32>,
}

/// Token counts a streamed answer reported.
#[derive(Default, Clone, Copy)]
struct Usage {
    input: u32,
    output: u32,
}

/// Pull token counts out of a streamed event, where the provider includes them.
/// The last value seen wins (Anthropic and Gemini resend a growing total; OpenAI
/// and Ollama send the final count once), so this is called for every event.
fn update_usage(kind: &str, v: &Value, u: &mut Usage) {
    let n = |x: &Value| x.as_u64().map(|v| v as u32);
    match kind {
        "anthropic" => {
            // input in message_start, output growing in message_delta.
            if let Some(x) = n(&v["message"]["usage"]["input_tokens"]).or_else(|| n(&v["usage"]["input_tokens"])) {
                u.input = x;
            }
            if let Some(x) = n(&v["usage"]["output_tokens"]) {
                u.output = x;
            }
        }
        "gemini" => {
            if let Some(x) = n(&v["usageMetadata"]["promptTokenCount"]) {
                u.input = x;
            }
            if let Some(x) = n(&v["usageMetadata"]["candidatesTokenCount"]) {
                u.output = x;
            }
        }
        "ollama" => {
            if let Some(x) = n(&v["prompt_eval_count"]) {
                u.input = x;
            }
            if let Some(x) = n(&v["eval_count"]) {
                u.output = x;
            }
        }
        // OpenAI and compatible servers: a final chunk with "usage".
        _ => {
            if let Some(x) = n(&v["usage"]["prompt_tokens"]) {
                u.input = x;
            }
            if let Some(x) = n(&v["usage"]["completion_tokens"]) {
                u.output = x;
            }
        }
    }
}

#[derive(Default)]
pub struct AiState {
    cancelled: Arc<Mutex<HashSet<String>>>,
    /// Ids of chats currently running, so a cancel for one that already ended
    /// (or never started) does not leave a stale id in `cancelled` forever.
    running: Arc<Mutex<HashSet<String>>>,
}

const MAX_TOKENS: u32 = 4096;
/// A local model may need a while for its first token on a slow PC.
const RECEIVE_TIMEOUT_MS: u32 = 180_000;

fn base(p: &Provider, default: &str) -> String {
    let b = p.base_url.trim();
    (if b.is_empty() { default } else { b }).trim_end_matches('/').to_string()
}

fn api_key(app: &AppHandle, p: &Provider) -> Result<String, String> {
    match p.credential_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => Ok(crate::vault::resolve(app, id)?.password.unwrap_or_default()),
        None => Ok(String::new()),
    }
}

/// The message of a provider's error body ({"error":{"message"}} and the like).
fn error_message(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => v["error"]["message"]
            .as_str()
            .or_else(|| v["error"].as_str())
            .or_else(|| v["message"].as_str())
            .or_else(|| v[0]["error"]["message"].as_str())
            .map(str::to_string)
            .unwrap_or_else(|| text.chars().take(300).collect()),
        Err(_) => text.chars().take(300).collect(),
    }
}

fn status_error(status: u16, body: &[u8]) -> String {
    let hint = match status {
        401 | 403 => " (API 키를 확인하세요)",
        404 => " (주소나 모델 이름을 확인하세요)",
        429 => " (요청 한도를 넘었습니다. 잠시 후 다시 시도하세요)",
        _ => "",
    };
    format!("HTTP {status}: {}{hint}", error_message(body))
}

/// Split a byte stream into lines (SSE and NDJSON both end lines with \n).
struct Lines {
    pending: Vec<u8>,
}

/// A single streamed line should never be this long; past it the buffer is
/// flushed so a misbehaving or hostile endpoint that never sends a newline
/// cannot grow memory without bound.
const MAX_LINE: usize = 4 * 1024 * 1024;

impl Lines {
    fn feed(&mut self, data: &[u8], mut each: impl FnMut(&str)) {
        self.pending.extend_from_slice(data);
        while let Some(i) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=i).collect();
            let line = String::from_utf8_lossy(&line);
            each(line.trim_end_matches(['\r', '\n']));
        }
        if self.pending.len() > MAX_LINE {
            let line = String::from_utf8_lossy(&std::mem::take(&mut self.pending)).into_owned();
            each(line.trim_end_matches(['\r', '\n']));
        }
    }
}

/// The text a streamed event adds, for each wire format, and whether it is the
/// model's reasoning (thinking out loud) rather than the answer. Reasoning is
/// shown live so the panel is not blank, but kept out of the saved answer.
fn delta(kind: &str, event: &Value) -> Result<Option<(String, bool)>, String> {
    if let Some(e) = event.get("error").filter(|e| !e.is_null()) {
        return Err(e["message"].as_str().or_else(|| e.as_str()).unwrap_or("알 수 없는 오류").to_string());
    }
    let answer = |s: &str| (!s.is_empty()).then(|| (s.to_string(), false));
    let reasoning = |s: &str| (!s.is_empty()).then(|| (s.to_string(), true));
    Ok(match kind {
        "anthropic" => (event["type"] == "content_block_delta")
            .then(|| event["delta"]["text"].as_str().and_then(answer))
            .flatten(),
        "gemini" => {
            let parts = event["candidates"][0]["content"]["parts"].as_array();
            parts.map(|p| p.iter().filter_map(|x| x["text"].as_str()).collect::<String>()).and_then(|s| answer(&s))
        }
        // Reasoning models stream their reasoning in `thinking` with `content`
        // empty until the end; surface that as reasoning so the panel is not
        // blank while the model thinks (the answer still follows in `content`).
        "ollama" => {
            let m = &event["message"];
            m["content"].as_str().and_then(answer).or_else(|| m["thinking"].as_str().and_then(reasoning))
        }
        // OpenAI and compatible servers. Some reasoning models (and proxies)
        // stream the thinking under `reasoning_content` or `reasoning` before the
        // final `content`; surface it as reasoning so the panel is not blank.
        _ => {
            let d = &event["choices"][0]["delta"];
            d["content"]
                .as_str()
                .and_then(answer)
                .or_else(|| d["reasoning_content"].as_str().and_then(reasoning))
                .or_else(|| d["reasoning"].as_str().and_then(reasoning))
        }
    })
}

/// One chat over HTTP, streamed. `on_text` gets each piece; false stops. Returns
/// the token usage the provider reported (zero when it reports none).
fn chat_http(key: String, p: &Provider, system: &str, messages: &[Message], on_text: &mut dyn FnMut(&str, bool) -> bool) -> Result<Usage, String> {
    if p.model.trim().is_empty() {
        return Err("모델을 지정하세요 (설정 → AI)".into());
    }
    check_attachments(&p.kind, &p.cli, messages)?;
    let model = p.model.trim();
    let mut headers: Vec<(&str, String)> = vec![("Content-Type", "application/json".into())];
    let (url, body) = match p.kind.as_str() {
        "anthropic" => {
            if key.is_empty() {
                return Err("API 키를 지정하세요 (설정 → AI)".into());
            }
            headers.push(("x-api-key", key));
            headers.push(("anthropic-version", "2023-06-01".into()));
            let msgs: Vec<Value> = messages.iter().map(|m| json!({ "role": m.role, "content": anthropic_content(m) })).collect();
            (format!("{}/v1/messages", base(p, "https://api.anthropic.com")), json!({ "model": model, "max_tokens": MAX_TOKENS, "system": system, "messages": msgs, "stream": true }))
        }
        "gemini" => {
            if key.is_empty() {
                return Err("API 키를 지정하세요 (설정 → AI)".into());
            }
            headers.push(("x-goog-api-key", key));
            let contents: Vec<Value> = messages
                .iter()
                .map(|m| {
                    let mut parts: Vec<Value> = m.attachments.iter().map(|a| json!({ "inline_data": { "mime_type": a.mime, "data": a.data } })).collect();
                    parts.push(json!({ "text": m.content }));
                    json!({ "role": if m.role == "assistant" { "model" } else { "user" }, "parts": parts })
                })
                .collect();
            let model = model.trim_start_matches("models/");
            (
                format!("{}/v1beta/models/{model}:streamGenerateContent?alt=sse", base(p, "https://generativelanguage.googleapis.com")),
                json!({ "systemInstruction": { "parts": [{ "text": system }] }, "contents": contents }),
            )
        }
        "ollama" => {
            let mut msgs = vec![json!({ "role": "system", "content": system })];
            msgs.extend(messages.iter().map(|m| {
                // Vision models take images as a list of base64 strings.
                let images: Vec<&str> = m.attachments.iter().map(|a| a.data.as_str()).collect();
                if images.is_empty() { json!({ "role": m.role, "content": m.content }) } else { json!({ "role": m.role, "content": m.content, "images": images }) }
            }));
            (format!("{}/api/chat", base(p, "http://127.0.0.1:11434")), json!({ "model": model, "messages": msgs, "stream": true }))
        }
        "openai" | "compatible" => {
            if !key.is_empty() {
                headers.push(("Authorization", format!("Bearer {key}")));
            } else if p.kind == "openai" {
                return Err("API 키를 지정하세요 (설정 → AI)".into());
            }
            let mut msgs = vec![json!({ "role": "system", "content": system })];
            msgs.extend(messages.iter().map(|m| json!({ "role": m.role, "content": openai_content(m) })));
            let default = if p.kind == "openai" { "https://api.openai.com/v1" } else { "http://127.0.0.1:1234/v1" };
            // include_usage adds a final chunk with the token counts.
            (format!("{}/chat/completions", base(p, default)), json!({ "model": model, "messages": msgs, "stream": true, "stream_options": { "include_usage": true } }))
        }
        other => return Err(format!("알 수 없는 AI 종류입니다: {other}")),
    };
    let body = body.to_string();
    let mut lines = Lines { pending: Vec::new() };
    let mut failure: Option<String> = None;
    let mut error_body = Vec::new();
    let mut usage = Usage::default();
    let kind = p.kind.clone();
    let status = http::send(
        &http::Request { method: "POST", url: &url, headers: &headers, body: Some(body.as_bytes()), receive_timeout_ms: RECEIVE_TIMEOUT_MS },
        &mut |status, data| {
            // An error reply is collected whole and read afterwards.
            if !(200..300).contains(&status) {
                error_body.extend_from_slice(data);
                return error_body.len() < 64 * 1024;
            }
            let mut go = true;
            lines.feed(data, |line| {
                if !go || failure.is_some() {
                    return;
                }
                // SSE: "data: {...}"; NDJSON (Ollama): "{...}".
                let payload = line.strip_prefix("data:").map(str::trim_start).unwrap_or(line);
                if payload.is_empty() || payload == "[DONE]" || line.starts_with("event:") || line.starts_with(':') {
                    return;
                }
                match serde_json::from_str::<Value>(payload) {
                    Ok(v) => {
                        update_usage(&kind, &v, &mut usage);
                        match delta(&kind, &v) {
                            Ok(Some((t, reasoning))) => go = on_text(&t, reasoning),
                            Ok(None) => {}
                            Err(e) => failure = Some(e),
                        }
                    }
                    // A non-JSON line in a 2xx stream: an error page or a proxy's
                    // notice. Cap the total so a misbehaving/hostile endpoint that
                    // streams endless non-JSON cannot grow this without bound (it
                    // is only read on a non-2xx status anyway).
                    Err(_) if !line.starts_with("data:") && error_body.len() < 64 * 1024 => error_body.extend_from_slice(line.as_bytes()),
                    Err(_) => {}
                }
            });
            go && failure.is_none()
        },
    )?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &error_body));
    }
    match failure {
        Some(e) => Err(e),
        None => Ok(usage),
    }
}

// ---- Subscription CLIs ----

/// Where a CLI is installed, preferring a real program over a .cmd shim.
fn find_cli(name: &str) -> Option<std::path::PathBuf> {
    find_in_path(name, &std::env::var_os("PATH")?, std::env::current_dir().ok().as_deref())
}

/// `name`.exe (else .cmd/.bat) in the folders of `path`, in their order.
/// Searched here rather than with where.exe, which looks in the current
/// folder first: a claude.exe dropped there would run. Relative entries
/// ("." or ".\bin") and the current folder itself are skipped for the same
/// reason.
fn find_in_path(name: &str, path: &std::ffi::OsStr, current: Option<&std::path::Path>) -> Option<std::path::PathBuf> {
    let current = current.and_then(|c| c.canonicalize().ok());
    let dirs: Vec<std::path::PathBuf> = std::env::split_paths(path)
        .filter(|d| d.is_absolute())
        .filter(|d| current.is_none() || d.canonicalize().ok() != current)
        .collect();
    let first = |exts: &[&str]| dirs.iter().find_map(|d| exts.iter().map(|e| d.join(format!("{name}.{e}"))).find(|p| p.is_file()));
    first(&["exe"]).or_else(|| first(&["cmd", "bat"]))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInfo {
    name: String,
    path: String,
    version: String,
}

/// The subscription CLIs installed on this PC.
#[tauri::command]
pub async fn ai_detect_cli() -> Vec<CliInfo> {
    tauri::async_runtime::spawn_blocking(|| {
        ["claude", "codex", "gemini"]
            .iter()
            .filter_map(|name| {
                let path = find_cli(name)?;
                let out = Command::new(&path).arg("--version").creation_flags(0x0800_0000).stdin(Stdio::null()).output().ok();
                let version = out.map(|o| String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").trim().to_string()).unwrap_or_default();
                Some(CliInfo { name: name.to_string(), path: path.display().to_string(), version })
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliModels {
    /// The model the CLI uses when none is given (its own config), if known.
    default: Option<String>,
    /// Models the CLI offers this account, best first: [id, label].
    models: Vec<(String, String)>,
}

/// `model = "…"` at the top level of a TOML file (before any [table]).
fn toml_top_model(text: &str) -> Option<String> {
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            break;
        }
        if let Some(rest) = l.strip_prefix("model").map(str::trim_start).and_then(|r| r.strip_prefix('=')) {
            let v = rest.trim().trim_matches('"').trim_matches('\'');
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// The models a CLI can use, read from its own files (never its sign-in):
/// Codex keeps the account's list in models_cache.json and its default in
/// config.toml; Claude Code takes model aliases; Gemini CLI its settings.
fn cli_models_in(cli: &str, home: &std::path::Path) -> CliModels {
    let read = |p: &str| std::fs::read_to_string(home.join(p)).ok();
    match cli {
        "codex" => {
            let default = read(".codex/config.toml").and_then(|t| toml_top_model(&t));
            let mut list: Vec<(i64, String, String)> = read(".codex/models_cache.json")
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .and_then(|v| v["models"].as_array().cloned())
                .unwrap_or_default()
                .iter()
                .filter(|m| m["visibility"].as_str() != Some("hide"))
                .filter_map(|m| {
                    let id = m["slug"].as_str()?.to_string();
                    let label = m["display_name"].as_str().unwrap_or(&id).to_string();
                    Some((m["priority"].as_i64().unwrap_or(99), id, label))
                })
                .collect();
            list.sort_by_key(|(p, _, _)| *p);
            CliModels { default, models: list.into_iter().map(|(_, id, label)| (id, label)).collect() }
        }
        "claude" => {
            let default = read(".claude/settings.json").and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["model"].as_str().map(str::to_string));
            let models = [("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
            CliModels { default, models }
        }
        "gemini" => {
            let default = read(".gemini/settings.json").and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["model"]["name"].as_str().or_else(|| v["model"].as_str()).map(str::to_string));
            CliModels { default, models: Vec::new() }
        }
        _ => CliModels::default(),
    }
}

/// The models a subscription CLI offers (for the settings list).
#[tauri::command]
pub fn ai_cli_models(cli: String) -> CliModels {
    match std::env::var_os("USERPROFILE") {
        Some(home) => cli_models_in(&cli, std::path::Path::new(&home)),
        None => CliModels::default(),
    }
}

/// The conversation as one prompt (CLIs take a single input).
fn cli_prompt(system: Option<&str>, messages: &[Message]) -> String {
    let mut out = String::new();
    if let Some(s) = system {
        out.push_str(&format!("<instructions>\n{s}\n</instructions>\n\n"));
    }
    if messages.len() == 1 {
        out.push_str(&messages[0].content);
    } else {
        for m in messages {
            out.push_str(if m.role == "assistant" { "[Assistant]\n" } else { "[User]\n" });
            out.push_str(&m.content);
            out.push_str("\n\n");
        }
        out.push_str("[Assistant]\n");
    }
    out
}

/// The processes of one CLI run. The CLIs are often .cmd shims that start
/// node, which may start more: killing the shim alone leaves those running,
/// holding the output pipes open (the read never ends) and the run's folder
/// in use (it cannot be removed). A job of its own ends them all at once; it
/// is nested in the app's job (crate::childjob), which ends them with the app.
struct RunJob(windows_sys::Win32::Foundation::HANDLE);

// The handle is only passed to job functions, which are thread-safe.
unsafe impl Send for RunJob {}
unsafe impl Sync for RunJob {}

impl RunJob {
    /// A job holding `child`, or None when Windows refuses (the run then
    /// falls back to taskkill /T).
    fn holding(child: &std::process::Child) -> Option<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        // SAFETY: a fresh job handle, owned by RunJob (closed on drop); the
        // info struct lives across the call.
        unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let job = RunJob(h);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            if SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const _, size) == 0 {
                return None;
            }
            (AssignProcessToJobObject(h, child.as_raw_handle() as _) != 0).then_some(job)
        }
    }

    /// Ends every process of the run, then waits (briefly) until they are
    /// gone, so their pipes are closed and the folder is free.
    fn end_all(&self) {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };
        // SAFETY: valid job handle; the info struct lives across each call.
        unsafe {
            TerminateJobObject(self.0, 1);
            let until = Instant::now() + Duration::from_secs(5);
            while Instant::now() < until {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                let size = std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32;
                let ok = QueryInformationJobObject(self.0, JobObjectBasicAccountingInformation, &mut info as *mut _ as *mut _, size, std::ptr::null_mut());
                if ok == 0 || info.ActiveProcesses == 0 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

impl Drop for RunJob {
    fn drop(&mut self) {
        // SAFETY: the handle came from CreateJobObjectW and is closed once.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

/// Ends a CLI run's whole process tree: its job, or taskkill /T without one.
fn end_run(job: Option<&RunJob>, pid: u32) {
    match job {
        Some(job) => job.end_all(),
        None => {
            let _ = Command::new(r"C:\Windows\System32\taskkill.exe")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .creation_flags(0x0800_0000)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

/// How long one CLI answer may take.
const CLI_LIMIT: Duration = Duration::from_secs(600);

/// One answer from a subscription CLI. It runs in an empty folder of its own;
/// Claude Code gets no tools at all (nothing it says can run or read
/// anything), Codex a read-only sandbox.
fn chat_cli(p: &Provider, system: &str, messages: &[Message], cancelled: &(dyn Fn() -> bool + Sync), on_text: &mut dyn FnMut(&str, bool) -> bool) -> Result<(), String> {
    let path = find_cli(&p.cli).ok_or_else(|| format!("{} CLI를 찾을 수 없습니다. 설치하고 로그인한 뒤 다시 시도하세요", p.cli))?;
    chat_cli_at(&path, p, system, messages, cancelled, on_text)
}

fn chat_cli_at(path: &std::path::Path, p: &Provider, system: &str, messages: &[Message], cancelled: &(dyn Fn() -> bool + Sync), on_text: &mut dyn FnMut(&str, bool) -> bool) -> Result<(), String> {
    let name = p.cli.as_str();
    let dir = std::env::temp_dir().join("BananaConn").join(format!("ai-{}-{}", std::process::id(), crate::wsutil::random_token()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(dir.clone());
    check_attachments("cli", name, messages)?;
    let attachments: Vec<&Attachment> = messages.iter().flat_map(|m| &m.attachments).collect();
    let mut cmd = Command::new(path);
    let stream_json = name == "claude";
    let stdin_text = match name {
        "claude" => {
            let sys = dir.join("system.txt");
            std::fs::write(&sys, system).map_err(|e| e.to_string())?;
            cmd.args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "", "--restricted", "--strict-mcp-config", "--no-session-persistence", "--system-prompt-file"]);
            cmd.arg(&sys);
            if attachments.is_empty() {
                cli_prompt(None, messages)
            } else {
                // Images and PDFs go in as content blocks of one stream-json user message.
                cmd.args(["--input-format", "stream-json"]);
                let mut blocks: Vec<Value> = attachments
                    .iter()
                    .map(|a| json!({ "type": if is_image(a) { "image" } else { "document" }, "source": { "type": "base64", "media_type": a.mime, "data": a.data } }))
                    .collect();
                blocks.push(json!({ "type": "text", "text": cli_prompt(None, messages) }));
                format!("{}\n", json!({ "type": "user", "message": { "role": "user", "content": blocks } }))
            }
        }
        "codex" => {
            // No MCP servers from the user's config: they are not needed for
            // an answer, slow it down, fail noisily, and are tools.
            cmd.args(["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", "-c", "mcp_servers={}"]);
            if !attachments.is_empty() {
                // Images as files beside the run, in one --image=a,b (the "-" after it stays the prompt).
                let mut files = Vec::new();
                for (i, a) in attachments.iter().enumerate() {
                    let ext = a.mime.trim_start_matches("image/").replace("jpeg", "jpg");
                    let file = dir.join(format!("image-{i}.{ext}"));
                    let bytes = base64_decode(&a.data).ok_or("첨부 이미지를 읽을 수 없습니다")?;
                    std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
                    files.push(file.display().to_string());
                }
                cmd.arg(format!("--image={}", files.join(",")));
            }
            cli_prompt(Some(system), messages)
        }
        "gemini" => cli_prompt(Some(system), messages),
        other => return Err(format!("알 수 없는 CLI입니다: {other}")),
    };
    if !p.model.trim().is_empty() {
        cmd.args(["--model", p.model.trim()]);
    }
    if name == "codex" {
        cmd.arg("-");
    }
    let mut child = cmd
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| format!("{name} CLI를 실행할 수 없습니다: {e}"))?;
    // The app's job first (ends the run with the app), then the run's own
    // job, which Windows nests inside it.
    crate::childjob::adopt(&child);
    let job = RunJob::holding(&child);
    let pid = child.id();
    // Fed on a thread of its own: a CLI that does not read its input (or a
    // big attachment filling the pipe) must not keep the watchdog from
    // starting.
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = stdin.write_all(stdin_text.as_bytes());
        });
    }
    let mut err = child.stderr.take().unwrap();
    let errors = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let out = child.stdout.take().unwrap();
    let mut streamed = false;
    let mut result: Option<String> = None;
    let mut cli_error: Option<String> = None;
    // A sign-in prompt appears only at the very start; checking just the first
    // few lines keeps a real answer that happens to contain "[y/n]" from aborting.
    let mut head_lines = 0u32;
    let finished = std::sync::atomic::AtomicBool::new(false);
    let timed_out = std::sync::atomic::AtomicBool::new(false);
    let status = std::thread::scope(|scope| {
        // Cancel and the time limit are checked here, not between output
        // lines: a CLI that prints nothing would otherwise never be stopped.
        scope.spawn(|| {
            let deadline = Instant::now() + CLI_LIMIT;
            while !finished.load(std::sync::atomic::Ordering::SeqCst) {
                let late = Instant::now() >= deadline;
                if cancelled() || late {
                    timed_out.store(late, std::sync::atomic::Ordering::SeqCst);
                    end_run(job.as_ref(), pid);
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            if !stream_json {
                // A CLI that is not logged in prints an interactive sign-in
                // prompt and waits on stdin (where our prompt is, which it then
                // eats as the answer) — it can never finish headlessly. Stop and
                // tell the user to log in once in a terminal.
                head_lines += 1;
                if head_lines <= 5 && needs_login(&line) {
                    cli_error = Some(login_hint(name));
                    end_run(job.as_ref(), pid);
                    break;
                }
                if !on_text(&format!("{line}\n"), false) {
                    end_run(job.as_ref(), pid);
                    break;
                }
                continue;
            }
            // Claude Code stream-json: partial text deltas, then a result line.
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            match v["type"].as_str() {
                Some("stream_event") if v["event"]["type"] == "content_block_delta" => {
                    if let Some(t) = v["event"]["delta"]["text"].as_str() {
                        streamed = true;
                        if !on_text(t, false) {
                            end_run(job.as_ref(), pid);
                            break;
                        }
                    }
                }
                Some("result") => {
                    if v["is_error"].as_bool() == Some(true) {
                        cli_error = Some(v["result"].as_str().unwrap_or("CLI 오류").to_string());
                    } else {
                        result = v["result"].as_str().map(str::to_string);
                    }
                }
                _ => {}
            }
        }
        let status = child.wait();
        finished.store(true, std::sync::atomic::Ordering::SeqCst);
        status
    });
    // Whatever the CLI left running ends now: it would hold stderr open
    // (the read below would never end) and the folder removed on return.
    if let Some(job) = &job {
        job.end_all();
    }
    let status = status.map_err(|e| e.to_string())?;
    let stderr = errors.join().unwrap_or_default();
    if timed_out.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(format!("{name} CLI가 {}분 안에 답하지 않아 중지했습니다", CLI_LIMIT.as_secs() / 60));
    }
    if let Some(e) = cli_error {
        return Err(e);
    }
    // Partial messages off (older CLI): the whole answer comes in the result.
    if let (true, false, Some(r)) = (stream_json, streamed, result) {
        on_text(&r, false);
        return Ok(());
    }
    if !status.success() && !cancelled() {
        return Err(cli_failure(name, &stderr, status.code()));
    }
    Ok(())
}

/// An interactive sign-in / confirmation prompt from a CLI that is not logged
/// in. Headless, it waits on stdin forever (or eats our prompt as the answer),
/// so the run can never finish — detect it and stop with guidance.
fn needs_login(line: &str) -> bool {
    let l = line.to_ascii_lowercase();
    l.contains("opening authentication page")
        || l.contains("do you want to continue?")
        || l.contains("[y/n]")
        || l.contains("please log in")
        || l.contains("please login")
        || l.contains("not logged in")
        || l.contains("login required")
        || l.contains("sign in to")
        || l.contains("press enter to")
        || l.contains("waiting for auth")
        || l.contains("authenticate in your browser")
}

/// Advice for a CLI that is not logged in.
fn login_hint(name: &str) -> String {
    match name {
        "gemini" => "Gemini CLI에 로그인되어 있지 않습니다. 터미널에서 `gemini`를 한 번 실행해 Google 계정으로 로그인한 뒤 다시 시도하세요. (또는 설정 → AI에서 Gemini API 키 방식을 쓰세요.)".into(),
        "codex" => "Codex CLI에 로그인되어 있지 않습니다. 터미널에서 `codex login`으로 로그인한 뒤 다시 시도하세요.".into(),
        "claude" => "Claude Code CLI에 로그인되어 있지 않습니다. 터미널에서 `claude`를 한 번 실행해 로그인한 뒤 다시 시도하세요.".into(),
        _ => format!("{name} CLI에 로그인되어 있지 않습니다. 터미널에서 로그인한 뒤 다시 시도하세요."),
    }
}

/// What went wrong in a CLI run, from its stderr: the service's own message
/// when it printed one (a JSON error body), else the last lines; with a hint
/// for the usual causes. Lines about MCP servers are the user's own tool
/// setup, not this answer, and are left out.
fn cli_failure(name: &str, stderr: &str, code: Option<i32>) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty() && !l.to_ascii_lowercase().contains("mcp")).collect();
    let message = lines.iter().rev().find_map(|l| {
        let json = &l[l.find('{')?..];
        let v: Value = serde_json::from_str(json).ok()?;
        v["error"]["message"].as_str().or_else(|| v["message"].as_str()).map(str::to_string)
    });
    let detail = message.unwrap_or_else(|| {
        let tail: Vec<&str> = lines.iter().rev().take(3).rev().copied().collect();
        if tail.is_empty() { format!("종료 코드 {code:?}") } else { tail.join(" / ").chars().take(400).collect() }
    });
    let low = lines.join("\n").to_ascii_lowercase();
    let hint = if low.contains("model") && (low.contains("not supported") || low.contains("model_not_found") || low.contains("does not exist") || low.contains("unknown model")) {
        " (설정 → AI에서 이 계정이 쓸 수 있는 모델을 적거나, CLI를 최신 버전으로 업데이트하세요)"
    } else if ["not logged in", "please log in", "please login", "login required", "codex login", "/login", "unauthorized", "authentication required"].iter().any(|p| low.contains(p)) {
        " (CLI에서 먼저 로그인하세요)"
    } else {
        ""
    };
    format!("{name} CLI가 실패했습니다: {detail}{hint}")
}

/// Ask a provider; the answer streams back as "ai-stream" events with this
/// id and ends with one "ai-done".
#[tauri::command]
pub fn ai_chat(app: AppHandle, state: State<'_, AiState>, id: String, provider: Provider, system: String, messages: Vec<Message>) {
    let cancelled = state.cancelled.clone();
    let running = state.running.clone();
    cancelled.lock().unwrap().remove(&id);
    running.lock().unwrap().insert(id.clone());
    std::thread::spawn(move || {
        let is_cancelled = || cancelled.lock().unwrap().contains(&id);
        let mut emit = |text: &str, reasoning: bool| {
            if is_cancelled() {
                return false;
            }
            let _ = app.emit("ai-stream", Chunk { id: id.clone(), text: text.to_string(), reasoning });
            true
        };
        // CLIs stream only text (no token counts); HTTP providers report usage.
        let r: Result<Usage, String> = if provider.kind == "cli" {
            chat_cli(&provider, &system, &messages, &is_cancelled, &mut emit).map(|()| Usage::default())
        } else {
            api_key(&app, &provider).and_then(|key| chat_http(key, &provider, &system, &messages, &mut emit))
        };
        // Lock `running` first, then `cancelled` (same order as ai_cancel), so a
        // concurrent cancel either marks this chat before it ends or sees it gone.
        let mut run = running.lock().unwrap();
        run.remove(&id);
        let was_cancelled = cancelled.lock().unwrap().remove(&id);
        drop(run);
        let (error, usage) = match r {
            Ok(u) => (None, u),
            Err(e) => (Some(e), Usage::default()),
        };
        let _ = app.emit(
            "ai-done",
            Done {
                id: id.clone(),
                error: if was_cancelled { None } else { error },
                cancelled: was_cancelled,
                input: (usage.input > 0).then_some(usage.input),
                output: (usage.output > 0).then_some(usage.output),
            },
        );
    });
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AiState>, id: String) {
    // Only a running chat can be cancelled; otherwise the id would linger in the
    // set with nothing to remove it.
    let running = state.running.lock().unwrap();
    if running.contains(&id) {
        state.cancelled.lock().unwrap().insert(id);
    }
}

/// The models a provider offers (for the settings list).
#[tauri::command]
pub async fn ai_models(app: AppHandle, provider: Provider) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = &provider;
        let key = api_key(&app, p)?;
        let mut headers: Vec<(&str, String)> = Vec::new();
        let url = match p.kind.as_str() {
            "anthropic" => {
                headers.push(("x-api-key", key));
                headers.push(("anthropic-version", "2023-06-01".into()));
                format!("{}/v1/models?limit=100", base(p, "https://api.anthropic.com"))
            }
            "gemini" => {
                headers.push(("x-goog-api-key", key));
                format!("{}/v1beta/models?pageSize=200", base(p, "https://generativelanguage.googleapis.com"))
            }
            "ollama" => format!("{}/api/tags", base(p, "http://127.0.0.1:11434")),
            "openai" | "compatible" => {
                if !key.is_empty() {
                    headers.push(("Authorization", format!("Bearer {key}")));
                }
                format!("{}/models", base(p, if p.kind == "openai" { "https://api.openai.com/v1" } else { "http://127.0.0.1:1234/v1" }))
            }
            _ => return Ok(Vec::new()),
        };
        let (status, body) = http::fetch(&http::Request { method: "GET", url: &url, headers: &headers, body: None, receive_timeout_ms: 30_000 }, 4 * 1024 * 1024)?;
        if !(200..300).contains(&status) {
            return Err(status_error(status, &body));
        }
        let v: Value = serde_json::from_slice(&body).map_err(|e| format!("모델 목록을 읽을 수 없습니다: {e}"))?;
        let mut names: Vec<String> = match p.kind.as_str() {
            "gemini" => v["models"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter(|m| m["supportedGenerationMethods"].as_array().is_some_and(|s| s.iter().any(|x| x == "generateContent")))
                        .filter_map(|m| m["name"].as_str().map(|n| n.trim_start_matches("models/").to_string()))
                        .collect()
                })
                .unwrap_or_default(),
            "ollama" => v["models"].as_array().map(|a| a.iter().filter_map(|m| m["name"].as_str().map(str::to_string)).collect()).unwrap_or_default(),
            _ => v["data"].as_array().map(|a| a.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect()).unwrap_or_default(),
        };
        names.sort();
        names.dedup();
        Ok(names)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_stream_format() {
        let a: Value = serde_json::from_str(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}"#).unwrap();
        assert_eq!(delta("anthropic", &a).unwrap(), Some(("Hel".to_string(), false)));
        let start: Value = serde_json::from_str(r#"{"type":"message_start","message":{}}"#).unwrap();
        assert_eq!(delta("anthropic", &start).unwrap(), None);
        let o: Value = serde_json::from_str(r#"{"choices":[{"delta":{"content":"lo"}}]}"#).unwrap();
        assert_eq!(delta("openai", &o).unwrap(), Some(("lo".to_string(), false)));
        let g: Value = serde_json::from_str(r#"{"candidates":[{"content":{"parts":[{"text":"a"},{"text":"b"}]}}]}"#).unwrap();
        assert_eq!(delta("gemini", &g).unwrap(), Some(("ab".to_string(), false)));
        let l: Value = serde_json::from_str(r#"{"message":{"role":"assistant","content":"x"},"done":false}"#).unwrap();
        assert_eq!(delta("ollama", &l).unwrap(), Some(("x".to_string(), false)));
        let e: Value = serde_json::from_str(r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#).unwrap();
        assert_eq!(delta("anthropic", &e).unwrap_err(), "Overloaded");
        let oe: Value = serde_json::from_str(r#"{"error":"model 'x' not found"}"#).unwrap();
        assert_eq!(delta("ollama", &oe).unwrap_err(), "model 'x' not found");
        // Reasoning models: thinking (Ollama) / reasoning_content (OpenAI-compatible)
        // show while content is still empty, and content wins once it arrives.
        let lt: Value = serde_json::from_str(r#"{"message":{"role":"assistant","content":"","thinking":"hmm"},"done":false}"#).unwrap();
        assert_eq!(delta("ollama", &lt).unwrap(), Some(("hmm".to_string(), true)));
        let lc: Value = serde_json::from_str(r#"{"message":{"content":"answer","thinking":"hmm"}}"#).unwrap();
        assert_eq!(delta("ollama", &lc).unwrap(), Some(("answer".to_string(), false)));
        let orc: Value = serde_json::from_str(r#"{"choices":[{"delta":{"reasoning_content":"why"}}]}"#).unwrap();
        assert_eq!(delta("compatible", &orc).unwrap(), Some(("why".to_string(), true)));
        let oc: Value = serde_json::from_str(r#"{"choices":[{"delta":{"content":"hi","reasoning_content":"why"}}]}"#).unwrap();
        assert_eq!(delta("compatible", &oc).unwrap(), Some(("hi".to_string(), false)));
    }

    #[test]
    fn spots_a_sign_in_prompt() {
        assert!(needs_login("Opening authentication page in your browser. Do you want to continue? [Y/n]:"));
        assert!(needs_login("Please log in to continue"));
        assert!(needs_login("You are not logged in"));
        assert!(!needs_login("Here is the answer to your question."));
        assert!(!needs_login("Run df -h to see disk usage"));
    }

    #[test]
    fn lines_split_across_reads() {
        let mut l = Lines { pending: Vec::new() };
        let mut got = Vec::new();
        l.feed(b"data: {\"a\":", |x| got.push(x.to_string()));
        l.feed(b"1}\r\n\r\ndata: [DONE]\n", |x| got.push(x.to_string()));
        assert_eq!(got, ["data: {\"a\":1}", "", "data: [DONE]"]);
    }

    #[test]
    fn errors_read_plainly() {
        assert_eq!(status_error(401, br#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#), "HTTP 401: invalid x-api-key (API 키를 확인하세요)");
        assert_eq!(status_error(404, br#"{"error":"model not found"}"#), "HTTP 404: model not found (주소나 모델 이름을 확인하세요)");
        assert_eq!(status_error(500, b"<html>bad gateway</html>"), "HTTP 500: <html>bad gateway</html>");
    }

    /// A one-shot HTTP server: answers with `reply` (status line included,
    /// chunked body) and returns the request it got.
    fn fake_api(reply_status: &'static str, content_type: &'static str, chunks: Vec<String>) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut got = Vec::new();
            let mut buf = [0u8; 8192];
            // Headers, then a Content-Length body.
            loop {
                let n = s.read(&mut buf).unwrap();
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).to_string();
                if let Some(i) = text.find("\r\n\r\n") {
                    let len = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                    if got.len() >= i + 4 + len {
                        break;
                    }
                }
            }
            write!(s, "HTTP/1.1 {reply_status}\r\nContent-Type: {content_type}\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
            for c in chunks {
                write!(s, "{:x}\r\n{c}\r\n", c.len()).unwrap();
            }
            s.write_all(b"0\r\n\r\n").unwrap();
            String::from_utf8_lossy(&got).into_owned()
        });
        (url, h)
    }

    fn ask(kind: &str, url: &str, key: &str) -> (Result<(), String>, String) {
        let p = Provider { kind: kind.into(), base_url: url.into(), model: "m-1".into(), credential_id: None, cli: String::new() };
        let mut out = String::new();
        let r = chat_http(key.into(), &p, "SYS", &[Message { role: "user".into(), content: "Q".into(), attachments: vec![] }], &mut |t, _| {
            out.push_str(t);
            true
        })
        .map(|_usage| ());
        (r, out)
    }

    #[test]
    fn anthropic_stream() {
        let (url, h) = fake_api(
            "200 OK",
            "text/event-stream",
            vec![
                "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{}}\n\n".into(),
                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"df \"}}\n\n".into(),
                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"-h\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".into(),
            ],
        );
        let (r, out) = ask("anthropic", &url, "sk-ant-1");
        let req = h.join().unwrap();
        assert_eq!((r, out.as_str()), (Ok(()), "df -h"));
        assert!(req.starts_with("POST /v1/messages ") && req.contains("x-api-key: sk-ant-1") && req.contains("anthropic-version: 2023-06-01"), "{req}");
        assert!(req.contains(r#""system":"SYS""#) && req.contains(r#""stream":true"#) && req.contains(r#""model":"m-1""#), "{req}");
    }

    #[test]
    fn openai_compatible_stream_without_a_key() {
        let (url, h) = fake_api(
            "200 OK",
            "text/event-stream",
            vec!["data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n".into(), "data: [DONE]\n\n".into()],
        );
        let (r, out) = ask("compatible", &format!("{url}/v1"), "");
        let req = h.join().unwrap();
        assert_eq!((r, out.as_str()), (Ok(()), "ok"));
        assert!(req.starts_with("POST /v1/chat/completions ") && !req.to_ascii_lowercase().contains("authorization"), "{req}");
        assert!(req.contains(r#"{"content":"SYS","role":"system"}"#) || req.contains(r#""role":"system""#), "{req}");
    }

    #[test]
    fn gemini_and_ollama_streams() {
        let (url, h) = fake_api("200 OK", "text/event-stream", vec!["data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"show \"}]}}]}\r\n\r\n".into(), "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"run\"}]}}]}\r\n\r\n".into()]);
        let (r, out) = ask("gemini", &url, "g-key");
        let req = h.join().unwrap();
        assert_eq!((r, out.as_str()), (Ok(()), "show run"));
        assert!(req.starts_with("POST /v1beta/models/m-1:streamGenerateContent?alt=sse ") && req.contains("x-goog-api-key: g-key") && req.contains("systemInstruction"), "{req}");

        let (url, h) = fake_api("200 OK", "application/x-ndjson", vec!["{\"message\":{\"role\":\"assistant\",\"content\":\"up\"},\"done\":false}\n".into(), "{\"message\":{\"role\":\"assistant\",\"content\":\"time\"},\"done\":false}\n{\"done\":true}\n".into()]);
        let (r, out) = ask("ollama", &url, "");
        let req = h.join().unwrap();
        assert_eq!((r, out.as_str()), (Ok(()), "uptime"));
        assert!(req.starts_with("POST /api/chat "), "{req}");
    }

    fn with_image(text: &str) -> Message {
        Message { role: "user".into(), content: text.into(), attachments: vec![Attachment { mime: "image/png".into(), data: "iVBORw0KGgo=".into(), name: "screen.png".into() }] }
    }

    /// Each API gets the image in its own shape, next to the text.
    #[test]
    fn images_reach_every_api_in_its_format() {
        let ask_with = |kind: &str, url: &str| {
            let p = Provider { kind: kind.into(), base_url: url.into(), model: "m".into(), credential_id: None, cli: String::new() };
            chat_http("k".into(), &p, "S", &[with_image("what is on screen?")], &mut |_, _| true)
        };
        let (url, h) = fake_api("200 OK", "text/event-stream", vec!["data: {\"type\":\"message_stop\"}\n\n".into()]);
        ask_with("anthropic", &url).unwrap();
        let req = h.join().unwrap();
        assert!(req.contains(r#"{"source":{"data":"iVBORw0KGgo=","media_type":"image/png","type":"base64"},"type":"image"}"#) && req.contains(r#"{"text":"what is on screen?","type":"text"}"#), "{req}");
        let (url, h) = fake_api("200 OK", "text/event-stream", vec!["data: [DONE]\n\n".into()]);
        ask_with("openai", &format!("{url}/v1")).unwrap();
        let req = h.join().unwrap();
        assert!(req.contains(r#""image_url":{"url":"data:image/png;base64,iVBORw0KGgo="}"#), "{req}");
        let (url, h) = fake_api("200 OK", "text/event-stream", vec!["data: {}\n\n".into()]);
        ask_with("gemini", &url).unwrap();
        let req = h.join().unwrap();
        assert!(req.contains(r#"{"inline_data":{"data":"iVBORw0KGgo=","mime_type":"image/png"}}"#), "{req}");
        let (url, h) = fake_api("200 OK", "application/x-ndjson", vec!["{\"done\":true}\n".into()]);
        ask_with("ollama", &url).unwrap();
        let req = h.join().unwrap();
        assert!(req.contains(r#""images":["iVBORw0KGgo="]"#), "{req}");
    }

    #[test]
    fn attachments_a_service_cannot_take_are_refused_before_sending() {
        let pdf = Message { role: "user".into(), content: "x".into(), attachments: vec![Attachment { mime: "application/pdf".into(), data: "JVBE".into(), name: "a.pdf".into() }] };
        assert!(check_attachments("compatible", "", std::slice::from_ref(&pdf)).unwrap_err().contains("PDF"));
        assert!(check_attachments("cli", "codex", std::slice::from_ref(&pdf)).is_err());
        assert!(check_attachments("cli", "gemini", &[with_image("x")]).unwrap_err().contains("이미지"));
        assert!(check_attachments("anthropic", "", &[pdf, with_image("x")]).is_ok());
        let exe = Message { role: "user".into(), content: "x".into(), attachments: vec![Attachment { mime: "application/x-msdownload".into(), data: "TVo=".into(), name: "a.exe".into() }] };
        assert!(check_attachments("anthropic", "", &[exe]).unwrap_err().contains("형식"));
    }

    /// Claude Code takes an image as a stream-json content block; Codex as a
    /// file beside the run (--image=), the prompt still on stdin.
    #[test]
    fn clis_take_images() {
        let dir = std::env::temp_dir().join(format!("bx-fake-img-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("args.txt");
        let claude = dir.join("claude.cmd");
        std::fs::write(&claude, format!("@echo off\r\n> \"{log}\" echo ARGS %*\r\nmore > \"{log}.stdin\"\r\necho {{\"type\":\"result\",\"is_error\":false,\"result\":\"a dialog\"}}\r\n", log = log.display())).unwrap();
        let p = Provider { kind: "cli".into(), base_url: String::new(), model: String::new(), credential_id: None, cli: "claude".into() };
        let mut out = String::new();
        let r = chat_cli_at(&claude, &p, "S", &[with_image("what is this?")], &|| false, &mut |t, _| {
            out.push_str(t);
            true
        });
        let args = std::fs::read_to_string(&log).unwrap_or_default();
        let stdin = std::fs::read_to_string(dir.join("args.txt.stdin")).unwrap_or_default();
        assert_eq!((r, out.as_str()), (Ok(()), "a dialog"));
        assert!(args.contains("--input-format stream-json"), "{args}");
        let v: Value = serde_json::from_str(stdin.trim()).unwrap();
        assert_eq!(v["message"]["content"][0]["type"], "image");
        assert_eq!(v["message"]["content"][1]["text"], "what is this?");

        let codex = dir.join("codex.cmd");
        // The fake copies the image it was given, to show the file existed during the run.
        std::fs::write(&codex, format!("@echo off\r\n> \"{log}\" echo ARGS %*\r\ncopy /y \"%CD%\\image-0.png\" \"{dir}\\seen.png\" >nul\r\nmore > nul\r\necho ok\r\n", log = log.display(), dir = dir.display())).unwrap();
        let p = Provider { cli: "codex".into(), ..p };
        let r = chat_cli_at(&codex, &p, "S", &[with_image("what is this?")], &|| false, &mut |_, _| true);
        let args = std::fs::read_to_string(&log).unwrap_or_default();
        let seen = std::fs::read(dir.join("seen.png")).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(r, Ok(()));
        assert!(args.contains("--image=") && args.contains("image-0.png") && args.trim_end().ends_with(" -"), "{args}");
        assert_eq!(seen, base64_decode("iVBORw0KGgo=").unwrap());
    }

    #[test]
    fn provider_errors_are_shown() {
        let (url, h) = fake_api("401 Unauthorized", "application/json", vec![r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#.into()]);
        let (r, _) = ask("anthropic", &url, "bad");
        h.join().unwrap();
        assert_eq!(r.unwrap_err(), "HTTP 401: invalid x-api-key (API 키를 확인하세요)");
        // An error in the middle of a stream.
        let (url, h) = fake_api("200 OK", "text/event-stream", vec!["data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"a\"}}\n\nevent: error\ndata: {\"type\":\"error\",\"error\":{\"message\":\"Overloaded\"}}\n\n".into()]);
        let (r, out) = ask("anthropic", &url, "k");
        h.join().unwrap();
        assert_eq!((r.unwrap_err().as_str(), out.as_str()), ("Overloaded", "a"));
        // No key where one is required: refused before anything is sent.
        let (r, _) = ask("openai", "http://127.0.0.1:9", "");
        assert!(r.unwrap_err().contains("API 키"));
    }

    /// The Claude Code CLI is run with no tools, restricted, in an empty
    /// folder, the system prompt in a file and the question on stdin; its
    /// stream-json deltas come back as text.
    #[test]
    fn claude_cli_runs_without_tools() {
        let dir = std::env::temp_dir().join(format!("bx-fake-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("args.txt");
        let script = dir.join("claude.cmd");
        std::fs::write(
            &script,
            format!(
                "@echo off\r\n> \"{log}\" echo ARGS %*\r\n>> \"{log}\" echo CWD %CD%\r\nmore > \"{log}.stdin\"\r\necho {{\"type\":\"stream_event\",\"event\":{{\"type\":\"content_block_delta\",\"delta\":{{\"type\":\"text_delta\",\"text\":\"ls \"}}}}}}\r\necho {{\"type\":\"stream_event\",\"event\":{{\"type\":\"content_block_delta\",\"delta\":{{\"type\":\"text_delta\",\"text\":\"-la\"}}}}}}\r\necho {{\"type\":\"result\",\"is_error\":false,\"result\":\"ls -la\"}}\r\n",
                log = log.display()
            ),
        )
        .unwrap();
        let p = Provider { kind: "cli".into(), base_url: String::new(), model: "sonnet".into(), credential_id: None, cli: "claude".into() };
        let mut out = String::new();
        let r = chat_cli_at(&script, &p, "SYSTEM RULES", &[Message { role: "user".into(), content: "list files".into(), attachments: vec![] }], &|| false, &mut |t, _| {
            out.push_str(t);
            true
        });
        let args = std::fs::read_to_string(&log).unwrap_or_default();
        let stdin = std::fs::read_to_string(dir.join("args.txt.stdin")).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((r, out.as_str()), (Ok(()), "ls -la"));
        assert!(args.contains("-p --output-format stream-json") && args.contains("--tools \"\"") && args.contains("--restricted") && args.contains("--strict-mcp-config"), "{args}");
        assert!(args.contains("--system-prompt-file") && args.contains("--model sonnet"), "{args}");
        assert!(args.contains("BananaConn\\ai-"), "runs in its own empty folder: {args}");
        assert_eq!(stdin.trim(), "list files");
    }

    #[test]
    fn cli_models_come_from_the_clis_own_files() {
        let home = std::env::temp_dir().join(format!("bx-cli-home-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".codex/config.toml"), "model = \"gpt-5.6-sol\"\nmodel_reasoning_effort = \"low\"\n\n[mcp_servers.x]\nmodel = \"no\"\n").unwrap();
        std::fs::write(
            home.join(".codex/models_cache.json"),
            r#"{"models":[{"slug":"b","display_name":"B","visibility":"list","priority":5},{"slug":"hidden","visibility":"hide","priority":1},{"slug":"a","display_name":"A","visibility":"list","priority":0}]}"#,
        )
        .unwrap();
        std::fs::write(home.join(".claude/settings.json"), r#"{"model":"opus"}"#).unwrap();
        let codex = cli_models_in("codex", &home);
        let claude = cli_models_in("claude", &home);
        let gemini = cli_models_in("gemini", &home);
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(codex, CliModels { default: Some("gpt-5.6-sol".into()), models: vec![("a".into(), "A".into()), ("b".into(), "B".into())] });
        assert_eq!(claude.default.as_deref(), Some("opus"));
        assert_eq!(claude.models.len(), 3);
        assert_eq!(gemini, CliModels::default());
    }

    /// Codex runs read-only with no MCP servers; the arguments survive the
    /// npm .cmd shim; the answer is its stdout.
    #[test]
    fn codex_cli_runs_read_only_without_mcp() {
        let dir = std::env::temp_dir().join(format!("bx-fake-codex-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("args.txt");
        let script = dir.join("codex.cmd");
        std::fs::write(&script, format!("@echo off\r\n> \"{log}\" echo ARGS %*\r\nmore > \"{log}.stdin\"\r\necho uptime\r\n", log = log.display())).unwrap();
        let p = Provider { kind: "cli".into(), base_url: String::new(), model: String::new(), credential_id: None, cli: "codex".into() };
        let mut out = String::new();
        let r = chat_cli_at(&script, &p, "SYS", &[Message { role: "user".into(), content: "load?".into(), attachments: vec![] }], &|| false, &mut |t, _| {
            out.push_str(t);
            true
        });
        let args = std::fs::read_to_string(&log).unwrap_or_default();
        let stdin = std::fs::read_to_string(dir.join("args.txt.stdin")).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((r, out.trim()), (Ok(()), "uptime"));
        // Rust quotes the braces for cmd; the program behind the shim gets mcp_servers={}.
        assert!(args.contains("exec --sandbox read-only --skip-git-repo-check --color never -c \"mcp_servers={}\" -"), "{args}");
        assert!(stdin.contains("<instructions>") && stdin.contains("SYS") && stdin.contains("load?"), "{stdin}");
    }

    /// A CLI that prints nothing is still stopped on cancel, with whatever it
    /// started (a .cmd shim's node), and its folder is removed afterwards.
    #[test]
    fn a_silent_cli_is_cancelled_with_its_whole_tree() {
        let dir = std::env::temp_dir().join(format!("bx-fake-silent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("cwd.txt");
        let script = dir.join("codex.cmd");
        // The background ping keeps the stderr pipe open after the shim is killed.
        let ping = r"C:\Windows\System32\PING.EXE -n 120 127.0.0.1 >nul";
        std::fs::write(&script, format!("@echo off\r\n> \"{log}\" echo %CD%\r\nstart /b \"\" {ping}\r\n{ping}\r\n", log = log.display())).unwrap();
        let p = Provider { kind: "cli".into(), base_url: String::new(), model: String::new(), credential_id: None, cli: "codex".into() };
        let start = Instant::now();
        let cancel = move || start.elapsed() > Duration::from_millis(1500);
        let r = chat_cli_at(&script, &p, "S", &[Message { role: "user".into(), content: "q".into(), attachments: vec![] }], &cancel, &mut |_, _| true);
        let took = start.elapsed();
        let cwd = std::fs::read_to_string(&log).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(r, Ok(()));
        assert!(took < Duration::from_secs(20), "stopped after {took:?}");
        assert!(cwd.contains("BananaConn\\ai-"), "{cwd}");
        assert!(!std::path::Path::new(cwd.trim()).exists(), "the run's folder is removed");
    }

    /// CLIs are looked up in PATH's absolute folders only, never in the
    /// current folder; a real program beats a .cmd shim.
    #[test]
    fn clis_are_found_in_path_but_not_in_the_current_folder() {
        let base = std::env::temp_dir().join(format!("bx-cli-path-{}", std::process::id()));
        let (cwd, shims, bin) = (base.join("cwd"), base.join("shims"), base.join("bin"));
        for d in [&cwd, &shims, &bin] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(cwd.join("claude.exe"), b"").unwrap();
        std::fs::write(shims.join("claude.cmd"), b"").unwrap();
        let path = std::env::join_paths([std::path::PathBuf::from("."), cwd.clone(), shims.clone(), bin.clone()]).unwrap();
        assert_eq!(find_in_path("claude", &path, Some(&cwd)), Some(shims.join("claude.cmd")));
        std::fs::write(bin.join("claude.exe"), b"").unwrap();
        assert_eq!(find_in_path("claude", &path, Some(&cwd)), Some(bin.join("claude.exe")));
        assert_eq!(find_in_path("codex", &path, Some(&cwd)), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A user's real Codex failure: an MCP server's auth noise must not read as
    /// "log in", and the service's own message is what is shown.
    #[test]
    fn cli_failures_name_the_real_cause() {
        let stderr = "warning: Model metadata for `gpt-5.5` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.\n\
2026-10-26T01:32:48.754626Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: \"Bearer resource_metadata=...\", error=\"invalid_token\" })\n\
ERROR: {\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.\",\"code\":\"model_not_found\"}}\n\
ERROR: {\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.\",\"code\":\"model_not_found\"}}\n";
        assert_eq!(
            cli_failure("codex", stderr, Some(1)),
            "codex CLI가 실패했습니다: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account. (설정 → AI에서 이 계정이 쓸 수 있는 모델을 적거나, CLI를 최신 버전으로 업데이트하세요)"
        );
        assert_eq!(cli_failure("codex", "Error: Not logged in. Run `codex login`.\n", Some(1)), "codex CLI가 실패했습니다: Error: Not logged in. Run `codex login`. (CLI에서 먼저 로그인하세요)");
        assert_eq!(cli_failure("gemini", "", Some(2)), "gemini CLI가 실패했습니다: 종료 코드 Some(2)");
    }

    #[test]
    fn conversation_becomes_one_prompt() {
        let m = |r: &str, c: &str| Message { role: r.into(), content: c.into(), attachments: vec![] };
        assert_eq!(cli_prompt(None, &[m("user", "hi")]), "hi");
        assert_eq!(cli_prompt(Some("S"), &[m("user", "a"), m("assistant", "b"), m("user", "c")]), "<instructions>\nS\n</instructions>\n\n[User]\na\n\n[Assistant]\nb\n\n[User]\nc\n\n[Assistant]\n");
    }
}
