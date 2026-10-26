// AI providers, what is sent to them, and how answers come back.
//
// Providers live in the settings (no secrets: an API key is a vault
// credential). Before anything goes to a cloud provider it is masked here:
// passwords, keys and tokens always, IP addresses and host names when the
// user asks for it, and (by default) the user sees exactly what will be sent.
// Masked hosts become IP_1, HOST_1 …; the answer is unmasked before it is
// shown, so a suggested command names the real host again. A local model
// (Ollama, or an OpenAI-compatible server on this PC) gets the text as is.

import { api, on } from "../api";
import { state } from "../store";
import { confirmDialog, esc } from "../ui";
import { language } from "../i18n";
import type { Attached } from "./attach";

export type AiKind = "anthropic" | "openai" | "gemini" | "compatible" | "ollama" | "cli";

export interface AiProvider {
  id: string;
  name: string;
  kind: AiKind;
  /** Empty: the kind's default address. */
  baseUrl: string;
  model: string;
  /** Vault credential whose password is the API key. */
  credentialId: string | null;
  /** kind "cli": "claude" | "codex" | "gemini". */
  cli: string;
}

export const AI_KINDS: { kind: AiKind; label: string; base: string; key: "required" | "optional" | "none" }[] = [
  { kind: "anthropic", label: "Anthropic Claude (API 키)", base: "https://api.anthropic.com", key: "required" },
  { kind: "openai", label: "OpenAI (API 키)", base: "https://api.openai.com/v1", key: "required" },
  { kind: "gemini", label: "Google Gemini (API 키)", base: "https://generativelanguage.googleapis.com", key: "required" },
  { kind: "compatible", label: "OpenAI 호환 서버 (LM Studio·vLLM·llama.cpp·OpenRouter 등)", base: "http://127.0.0.1:1234/v1", key: "optional" },
  { kind: "ollama", label: "Ollama (로컬 LLM)", base: "http://127.0.0.1:11434", key: "none" },
  { kind: "cli", label: "구독 CLI (Claude Code·Codex·Gemini CLI 로그인)", base: "", key: "none" },
];

export const AI_CLIS: [string, string][] = [
  ["claude", "Claude Code (Claude 구독)"],
  ["codex", "Codex CLI (ChatGPT 구독)"],
  ["gemini", "Gemini CLI (Google 계정)"],
];

export function kindInfo(kind: AiKind) {
  return AI_KINDS.find((k) => k.kind === kind) ?? AI_KINDS[0];
}

/** The provider's model runs on this PC: nothing leaves it. */
export function isLocal(p: AiProvider): boolean {
  if (p.kind !== "ollama" && p.kind !== "compatible") return false;
  try {
    const host = new URL(p.baseUrl.trim() || kindInfo(p.kind).base).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

export function providers(): AiProvider[] {
  return state.settings.aiProviders ?? [];
}

/** The provider to use (the default, else the first). */
export function currentProvider(id?: string | null): AiProvider | null {
  const list = providers();
  return list.find((p) => p.id === (id ?? state.settings.aiDefault)) ?? list[0] ?? null;
}

const SHORT: Record<AiKind, string> = { anthropic: "Claude API", openai: "OpenAI API", gemini: "Gemini API", compatible: "OpenAI 호환", ollama: "Ollama", cli: "CLI" };
const CLI_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex CLI", gemini: "Gemini CLI" };

/** The name shown for a provider, always made from the service and the
 * model (a name typed in an earlier version is not used). */
export function providerLabel(p: AiProvider): string {
  const what = p.kind === "cli" ? (CLI_NAMES[p.cli] ?? p.cli) : SHORT[p.kind];
  return `${what} · ${p.model || "기본 모델"}`;
}

// ---- Masking ----

const SECRET = "«SECRET»";
// [pattern, index of the group to keep before the secret]
const SECRET_RULES: RegExp[] = [
  // key = value, key: value (password=, api_key:, TOKEN=, "secret": "…")
  /((?<![a-z])(?:pass(?:word|wd|phrase)?|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token|client[_-]?secret)\w*["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
  // --password x, --token=x
  /(\s--?(?:pass(?:word|wd)?|token|secret|api[_-]?key)(?:=|\s+))(\S+)/gi,
  // mysql -pSECRET
  /(\bmysql\w*\b[^\n]*?\s-p)(\S+)/g,
  // curl -u user:pass
  /(\s(?:-u|--user)\s*[^\s:]+:)(\S+)/g,
  // scheme://user:pass@host
  /(:\/\/[^\s/:@]+:)([^\s/@]+)(?=@)/g,
  // Authorization: Bearer x
  /(\bBearer\s+)([A-Za-z0-9._~+/=-]{8,})/g,
  // Cisco / Aruba / Huawei / Juniper / FortiGate configuration secrets
  /^(\s*(?:enable\s+)?(?:secret|password)\s+(?:\d+\s+)?)(\S+)/gim,
  /(\busername\s+\S+[^\n]*?\s(?:secret|password)\s+(?:\d+\s+)?)(\S+)/gi,
  /(\bsnmp-server\s+community\s+)(\S+)/gi,
  /(\b(?:pre-shared-key|key-string|authentication-key|md5)\s+(?:\d+\s+|ascii\s+|hex\s+)?)(\S+)/gi,
  /(\b(?:password|cipher)\s+(?:irreversible-)?cipher\s+)(\S+)/gi,
  /(\bset\s+(?:password|passwd|psksecret|secret|key|private-key|passphrase|auth-pwd|sso-password)\s+(?:ENC\s+)?)(\S+)/gi,
  /(\b(?:encrypted-password|secret|authentication-key)\s+)("\$\d\$[^"]*"|\$\d\$\S+)/gi,
];
// Whole-token secrets: keys with a recognisable shape, private key blocks.
const SECRET_TOKENS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g,
];
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const IPV6 = /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi;
/** An IPv6 address, not a time (10:20:30) or a MAC address (aa:bb:cc:dd:ee:ff). */
const isIpv6 = (m: string) => (/[a-f]/i.test(m) || m.includes("::")) && !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(m) && m.replace(/:/g, "").length > 0;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
// Addresses that say nothing about the network: masks, any, loopback.
const PLAIN_IP = /^(?:0\.0\.0\.0|255\.255\.\d+\.\d+|255\.\d+\.0\.0|127\.0\.0\.1|::1?)$/;

export class Masker {
  private toReal = new Map<string, string>();
  private toMask = new Map<string, string>();
  private n = { IP: 0, HOST: 0, MAIL: 0 };
  secrets = 0;
  private hosts: boolean;
  /** Host names to hide (the session's host, the device's name …). */
  private names: string[];

  constructor(hosts: boolean, names: string[] = []) {
    this.hosts = hosts;
    this.names = names;
  }

  /** What a saved conversation needs to keep its placeholders meaning the same hosts. */
  save(): { hosts: boolean; names: string[]; map: [string, string][]; secrets: number } {
    return { hosts: this.hosts, names: this.names, map: [...this.toReal], secrets: this.secrets };
  }

  static restore(s: { hosts: boolean; names: string[]; map: [string, string][]; secrets: number }): Masker {
    const m = new Masker(s.hosts, s.names);
    for (const [mask, real] of s.map) {
      m.toReal.set(mask, real);
      m.toMask.set(real, mask);
      const kind = mask.split("_")[0] as "IP" | "HOST" | "MAIL";
      const n = Number(mask.split("_")[1]);
      if (kind in m.n && n > m.n[kind]) m.n[kind] = n;
    }
    m.secrets = s.secrets;
    return m;
  }

  private placeholder(kind: "IP" | "HOST" | "MAIL", real: string): string {
    const known = this.toMask.get(real);
    if (known) return known;
    const mask = `${kind}_${++this.n[kind]}`;
    this.toMask.set(real, mask);
    this.toReal.set(mask, real);
    return mask;
  }

  mask(text: string): string {
    let out = text;
    for (const re of SECRET_TOKENS)
      out = out.replace(re, () => {
        this.secrets++;
        return SECRET;
      });
    for (const re of SECRET_RULES)
      out = out.replace(re, (_m, keep: string) => {
        this.secrets++;
        return keep + SECRET;
      });
    if (!this.hosts) return out;
    // The server's own names first (longest first, whole words, any case), so
    // "admin@web01.corp.local" keeps its user and hides the host.
    for (const name of [...new Set(this.names.map((s) => s.trim()).filter((s) => s.length >= 3 && !/^\d/.test(s)))].sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`(?<![\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "gi");
      out = out.replace(re, (m) => this.placeholder("HOST", m));
    }
    out = out.replace(IPV4, (m) => (PLAIN_IP.test(m) ? m : this.placeholder("IP", m)));
    out = out.replace(IPV6, (m) => (PLAIN_IP.test(m) || !isIpv6(m) ? m : this.placeholder("IP", m)));
    out = out.replace(EMAIL, (m) => this.placeholder("MAIL", m));
    return out;
  }

  /** The answer with the real hosts back (secrets stay hidden). */
  unmask(text: string): string {
    return text.replace(/\b(?:IP|HOST|MAIL)_\d+\b/g, (m) => this.toReal.get(m) ?? m);
  }

  get masked(): number {
    return this.toReal.size;
  }
}

/** Ask the user before text goes to a cloud provider (Settings → AI decides).
 * Resolves to false when the user says no. `skip` remembers "don't ask again"
 * for the rest of the conversation. */
export async function confirmSend(p: AiProvider, text: string, masker: Masker, skip: { skip: boolean }, agent = false, attached: Attached[] = []): Promise<boolean> {
  if (isLocal(p) || skip.skip || state.settings.aiPreview === false) return true;
  const media = attached.filter((a) => a.kind !== "text");
  const shown = text.length > 6000 ? `${text.slice(0, 6000)}\n…(${text.length - 6000}자 더)` : text;
  return confirmDialog({
    title: "AI로 보낼 내용",
    icon: "Send",
    confirm: "AI에 보내기",
    message: `<p><b data-i18n-skip>${esc(providerLabel(p))}</b>에 아래 내용을 보냅니다. 이 PC 밖의 서비스입니다.</p>
      ${agent ? `<p class="muted small">AI가 터미널에서 실행한 명령의 결과도 같은 방식으로 가린 뒤 이 대화에 보냅니다.</p>` : ""}
      ${
        masker.secrets || masker.masked
          ? `<p class="muted small">${masker.secrets ? `<span>비밀번호·키·토큰 ${masker.secrets}곳을 가렸습니다.</span>` : ""}${masker.masked ? ` <span>IP·호스트 이름 ${masker.masked}개를 IP_1, HOST_1 같은 이름으로 바꿨습니다 (답에서는 원래 값으로 보입니다).</span>` : ""}</p>`
          : ""
      }
      <pre class="ai-preview" data-i18n-skip>${esc(shown)}</pre>
      ${
        media.length
          ? `<p class="muted small">첨부한 이미지·PDF는 가릴 수 없어 그대로 보냅니다.</p><div class="ai-attach-row">${media
              .map((a) => (a.preview ? `<img class="ai-thumb" src="${a.preview}" alt="" title="${esc(a.name)}" />` : `<span class="ai-chip" data-i18n-skip>${esc(a.name)}</span>`))
              .join("")}</div>`
          : ""
      }`,
    dontAsk: () => (skip.skip = true),
  });
}

// ---- Asking ----

let seq = 0;
const listeners = new Map<string, { onText: (t: string) => void; done: (err: string | null, cancelled: boolean) => void }>();
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  void on<{ id: string; text: string }>("ai-stream", (e) => listeners.get(e.id)?.onText(e.text));
  void on<{ id: string; error: string | null; cancelled: boolean }>("ai-done", (e) => {
    const l = listeners.get(e.id);
    listeners.delete(e.id);
    l?.done(e.error, e.cancelled);
  });
}

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
  /** Images and PDFs sent with the message (base64). */
  attachments?: { mime: string; data: string; name: string }[];
}

export interface Asking {
  /** The whole answer once it is complete. */
  done: Promise<string>;
  cancel(): void;
}

/** Ask a provider; `onText` gets the answer so far, piece by piece. */
export function ask(p: AiProvider, system: string, messages: AiMessage[], onText: (sofar: string) => void): Asking {
  wire();
  const id = `ai-${Date.now()}-${++seq}`;
  let text = "";
  let finish!: (v: string) => void;
  let fail!: (e: Error) => void;
  const done = new Promise<string>((res, rej) => ((finish = res), (fail = rej)));
  listeners.set(id, {
    onText: (t) => {
      text += t;
      onText(text);
    },
    done: (err, cancelled) => (err ? fail(new Error(err)) : cancelled ? fail(new Error("CANCELLED")) : finish(text)),
  });
  const { id: _pid, name: _n, ...provider } = p;
  api.aiChat(id, { ...provider, credentialId: p.credentialId || null }, system, messages).catch((e) => {
    listeners.delete(id);
    fail(e instanceof Error ? e : new Error(String(e)));
  });
  return { done, cancel: () => void api.aiCancel(id).catch(() => {}) };
}

// ---- Prompts ----

const LANG_NAMES: Record<string, string> = { ko: "Korean", en: "English", ja: "Japanese", "zh-CN": "Simplified Chinese", "zh-TW": "Traditional Chinese", vi: "Vietnamese", es: "Spanish", fr: "French", de: "German" };

export interface Target {
  /** "Red Hat Enterprise Linux 9.2", "Cisco IOS 15.2", … or "" when unknown. */
  system: string;
  /** Network gear CLI rather than a shell. */
  network: boolean;
  /** A Windows shell (PowerShell or cmd over OpenSSH), told by its prompt. */
  windows?: boolean;
}

function base(target: Target, agent = false): string {
  const lang = LANG_NAMES[language()] ?? "English";
  return [
    "You are the assistant built into BananaConn, a remote terminal (SSH, Telnet, serial) used by system and network engineers.",
    target.windows
      ? "The connected system is Windows, reached over OpenSSH; the shell is PowerShell. Use PowerShell and Windows commands (Get-CimInstance, Get-Process, Get-Service, Get-WinEvent, Get-NetIPConfiguration, ipconfig, systeminfo …), never Unix ones; each run block is one PowerShell line."
      : target.system ? `The connected system is: ${target.system}${target.network ? " (a network device CLI, not a Unix shell)" : ""}.` : "The connected system is unknown; find out with a first command (uname -a, or show version on network gear) when it matters.",
    `Answer in ${lang}. Be concise and practical.`,
    agent ? "" : "Commands you write are never run automatically: the engineer reviews them first.",
    "Never suggest changing the system clock, the time zone or NTP settings.",
    "Placeholders such as IP_1, HOST_1 and «SECRET» stand for hidden values; keep them exactly as they are in commands.",
  ]
    .filter(Boolean)
    .join("\n");
}

export const prompts = {
  command: (t: Target) =>
    `${base(t)}\nThe engineer describes a task. Reply with exactly one command (or one short pipeline) for this system inside a single \`\`\`sh code block, then one sentence explaining it. Prefer read-only commands. If the task is destructive or changes configuration, still answer, but say so clearly in the sentence.`,
  explain: (t: Target) =>
    `${base(t)}\nExplain the terminal output or error the engineer selected: what it means, the most likely cause, and the next steps (with commands in code blocks where useful).`,
  chat: (t: Target) => `${base(t)}\nPut every command in its own code block so the engineer can insert it into the terminal.`,
  /** The AI investigates by running commands in the engineer's terminal. */
  agent: (t: Target, max: number) =>
    [
      base(t, true),
      "You can run commands in the engineer's terminal to investigate. To run one, end your reply with exactly one block:",
      "```run",
      "<one command>",
      "```",
      "and write nothing after it. The command runs in plain view and its output comes back in the next message. Run one command at a time; you may combine quick checks with ; on one line.",
      "Do the checking yourself: never ask the engineer to run a command, paste output or check something you can check with a command, and never answer with a list of commands to type. If a question needs information from the system, your first reply is a run block.",
      "Investigate with read-only commands. Do not change configuration, restart or stop services, kill processes, delete or move files, or change the time unless the engineer asked for exactly that; such commands need the engineer's approval and may be refused or blocked — never try to work around a refusal.",
      "Never use interactive or endless commands (top without -b -n 1, less, more, vi, watch, tail -f, journalctl -f, ping without -c): use non-interactive forms, --no-pager, and limits such as | tail -n 50. On network devices turn paging off first if needed (terminal length 0, screen-length 0 temporary).",
      `Use at most ${max} commands. When you know enough, reply with your findings and recommendations, without a run block.`,
    ].join("\n"),
  analyse: (t: Target, what: "config" | "log") =>
    what === "config"
      ? `${base(t)}\nReview the device or server configuration the engineer attached. List security problems, risky or inconsistent settings and best-practice gaps, most important first, each with the line it concerns and how to fix it.`
      : `${base(t)}\nAnalyse the log the engineer attached. Summarise what happened, list errors and anomalies with their time and likely cause, most important first, and suggest next steps.`,
};

/** The command lines of a code block: "# " comment lines dropped, "$ " and
 * "> " prompts removed, "\" continuations joined. Each line is one command
 * for the terminal. */
export function commandLines(code: string): string[] {
  return code
    .replace(/[ \t]*\\\r?\n\s*/g, " ")
    .split("\n")
    .filter((l) => !/^\s*#(\s|$)/.test(l))
    .map((l) => l.replace(/^\s*[$>]\s+/, "").trimEnd())
    .filter((l) => l.trim());
}

/** The command an answer proposes: the first code block's lines (or the
 * answer's first line when it has no code block). */
export function proposedCommands(answer: string): string[] {
  const block = /```[\w-]*\r?\n([\s\S]*?)```/.exec(answer);
  return commandLines(block ? block[1] : (answer.trim().split("\n")[0] ?? ""));
}
