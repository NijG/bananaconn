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
struct Chunk {
    id: String,
    text: String,
}

#[derive(Serialize, Clone)]
struct Done {
    id: String,
    error: Option<String>,
    cancelled: bool,
}

#[derive(Default)]
pub struct AiState {
    cancelled: Arc<Mutex<HashSet<String>>>,
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

impl Lines {
    fn feed(&mut self, data: &[u8], mut each: impl FnMut(&str)) {
        self.pending.extend_from_slice(data);
        while let Some(i) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=i).collect();
            let line = String::from_utf8_lossy(&line);
            each(line.trim_end_matches(['\r', '\n']));
        }
    }
}

/// The text a streamed event adds, for each wire format.
fn delta(kind: &str, event: &Value) -> Result<Option<String>, String> {
    if let Some(e) = event.get("error").filter(|e| !e.is_null()) {
        return Err(e["message"].as_str().or_else(|| e.as_str()).unwrap_or("알 수 없는 오류").to_string());
    }
    Ok(match kind {
        "anthropic" => (event["type"] == "content_block_delta").then(|| event["delta"]["text"].as_str().map(str::to_string)).flatten(),
        "gemini" => {
            let parts = event["candidates"][0]["content"]["parts"].as_array();
            parts.map(|p| p.iter().filter_map(|x| x["text"].as_str()).collect::<String>()).filter(|s| !s.is_empty())
        }
        "ollama" => event["message"]["content"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
        // OpenAI and compatible servers.
        _ => event["choices"][0]["delta"]["content"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
    })
}

/// One chat over HTTP, streamed. `on_text` gets each piece; false stops.
fn chat_http(key: String, p: &Provider, system: &str, messages: &[Message], on_text: &mut dyn FnMut(&str) -> bool) -> Result<(), String> {
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
            (format!("{}/chat/completions", base(p, default)), json!({ "model": model, "messages": msgs, "stream": true }))
        }
        other => return Err(format!("알 수 없는 AI 종류입니다: {other}")),
    };
    let body = body.to_string();
    let mut lines = Lines { pending: Vec::new() };
    let mut failure: Option<String> = None;
    let mut error_body = Vec::new();
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
                    Ok(v) => match delta(&kind, &v) {
                        Ok(Some(t)) => go = on_text(&t),
                        Ok(None) => {}
                        Err(e) => failure = Some(e),
                    },
                    // A non-JSON line in a stream: an error page or a proxy's notice.
                    Err(_) if !line.starts_with("data:") => error_body.extend_from_slice(line.as_bytes()),
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
        None => Ok(()),
    }
}

// ---- Subscription CLIs ----

/// Where a CLI is installed (`where`), preferring a real program over a .cmd shim.
fn find_cli(name: &str) -> Option<std::path::PathBuf> {
    let out = Command::new(r"C:\Windows\System32\where.exe").arg(name).creation_flags(0x0800_0000).output().ok()?;
    let paths: Vec<std::path::PathBuf> = String::from_utf8_lossy(&out.stdout).lines().map(|l| std::path::PathBuf::from(l.trim())).filter(|p| p.extension().is_some()).collect();
    let ext = |p: &std::path::PathBuf, e: &str| p.extension().is_some_and(|x| x.eq_ignore_ascii_case(e));
    paths.iter().find(|p| ext(p, "exe")).or_else(|| paths.iter().find(|p| ext(p, "cmd") || ext(p, "bat"))).cloned()
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

/// One answer from a subscription CLI. It runs in an empty folder of its own;
/// Claude Code gets no tools at all (nothing it says can run or read
/// anything), Codex a read-only sandbox.
fn chat_cli(p: &Provider, system: &str, messages: &[Message], cancelled: &dyn Fn() -> bool, on_text: &mut dyn FnMut(&str) -> bool) -> Result<(), String> {
    let path = find_cli(&p.cli).ok_or_else(|| format!("{} CLI를 찾을 수 없습니다. 설치하고 로그인한 뒤 다시 시도하세요", p.cli))?;
    chat_cli_at(&path, p, system, messages, cancelled, on_text)
}

fn chat_cli_at(path: &std::path::Path, p: &Provider, system: &str, messages: &[Message], cancelled: &dyn Fn() -> bool, on_text: &mut dyn FnMut(&str) -> bool) -> Result<(), String> {
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
    crate::childjob::adopt(&child);
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(stdin_text.as_bytes());
    }
    let mut err = child.stderr.take().unwrap();
    let errors = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let out = child.stdout.take().unwrap();
    let start = Instant::now();
    let mut streamed = false;
    let mut result: Option<String> = None;
    let mut cli_error: Option<String> = None;
    for line in BufReader::new(out).lines() {
        let Ok(line) = line else { break };
        if cancelled() || start.elapsed() > Duration::from_secs(600) {
            let _ = child.kill();
            break;
        }
        if !stream_json {
            if !on_text(&format!("{line}\n")) {
                let _ = child.kill();
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
                    if !on_text(t) {
                        let _ = child.kill();
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
    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr = errors.join().unwrap_or_default();
    if let Some(e) = cli_error {
        return Err(e);
    }
    // Partial messages off (older CLI): the whole answer comes in the result.
    if let (true, false, Some(r)) = (stream_json, streamed, result) {
        on_text(&r);
        return Ok(());
    }
    if !status.success() && !cancelled() {
        return Err(cli_failure(name, &stderr, status.code()));
    }
    Ok(())
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
    cancelled.lock().unwrap().remove(&id);
    std::thread::spawn(move || {
        let is_cancelled = || cancelled.lock().unwrap().contains(&id);
        let mut emit = |text: &str| {
            if is_cancelled() {
                return false;
            }
            let _ = app.emit("ai-stream", Chunk { id: id.clone(), text: text.to_string() });
            true
        };
        let r = if provider.kind == "cli" { chat_cli(&provider, &system, &messages, &is_cancelled, &mut emit) } else { api_key(&app, &provider).and_then(|key| chat_http(key, &provider, &system, &messages, &mut emit)) };
        let was_cancelled = cancelled.lock().unwrap().remove(&id);
        let _ = app.emit("ai-done", Done { id: id.clone(), error: if was_cancelled { None } else { r.err() }, cancelled: was_cancelled });
    });
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AiState>, id: String) {
    state.cancelled.lock().unwrap().insert(id);
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
        assert_eq!(delta("anthropic", &a).unwrap().as_deref(), Some("Hel"));
        let start: Value = serde_json::from_str(r#"{"type":"message_start","message":{}}"#).unwrap();
        assert_eq!(delta("anthropic", &start).unwrap(), None);
        let o: Value = serde_json::from_str(r#"{"choices":[{"delta":{"content":"lo"}}]}"#).unwrap();
        assert_eq!(delta("openai", &o).unwrap().as_deref(), Some("lo"));
        let g: Value = serde_json::from_str(r#"{"candidates":[{"content":{"parts":[{"text":"a"},{"text":"b"}]}}]}"#).unwrap();
        assert_eq!(delta("gemini", &g).unwrap().as_deref(), Some("ab"));
        let l: Value = serde_json::from_str(r#"{"message":{"role":"assistant","content":"x"},"done":false}"#).unwrap();
        assert_eq!(delta("ollama", &l).unwrap().as_deref(), Some("x"));
        let e: Value = serde_json::from_str(r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#).unwrap();
        assert_eq!(delta("anthropic", &e).unwrap_err(), "Overloaded");
        let oe: Value = serde_json::from_str(r#"{"error":"model 'x' not found"}"#).unwrap();
        assert_eq!(delta("ollama", &oe).unwrap_err(), "model 'x' not found");
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
        let r = chat_http(key.into(), &p, "SYS", &[Message { role: "user".into(), content: "Q".into(), attachments: vec![] }], &mut |t| {
            out.push_str(t);
            true
        });
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
            chat_http("k".into(), &p, "S", &[with_image("what is on screen?")], &mut |_| true)
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
        let r = chat_cli_at(&claude, &p, "S", &[with_image("what is this?")], &|| false, &mut |t| {
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
        let r = chat_cli_at(&codex, &p, "S", &[with_image("what is this?")], &|| false, &mut |_| true);
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
        let r = chat_cli_at(&script, &p, "SYSTEM RULES", &[Message { role: "user".into(), content: "list files".into(), attachments: vec![] }], &|| false, &mut |t| {
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
        let r = chat_cli_at(&script, &p, "SYS", &[Message { role: "user".into(), content: "load?".into(), attachments: vec![] }], &|| false, &mut |t| {
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
