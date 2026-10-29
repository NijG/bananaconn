// The AI panel beside a terminal (conversation, explanations, file analysis)
// and the command bar (describe a task, get one command for the line).
//
// Whatever the AI answers is shown, never run: a command goes into the
// terminal's input line only when the user presses a button, and the risky-
// command rules apply to it there like to anything typed (a blocked command
// is not even inserted).

import { api, pickOpenFile } from "../api";
import { icon } from "../icons";
import { findTypedRisk } from "../riskRules";
import { state, updateSettings } from "../store";
import { confirmDialog, contextMenu, errorText, esc, h, promptDialog, toast } from "../ui";
import { writeClipboard } from "../clipboard";
import { tr } from "../i18n";
import { judge } from "./policy";
import { fromCanvas, fromFile, sizeLabel, type Attached } from "./attach";
import { ask, cliLabel, confirmSend, currentProvider, isLocal, Masker, maskSecrets, proposedCommands, commandLines, prompts, providerLabel, providers, type AiMessage, type AiProvider, type AiUsage, type Asking, type Target } from "./core";

/** What the panel needs from its terminal. */
export interface AiHost {
  target(): Target;
  /** Names that identify the server (masked for cloud AI when asked). */
  hostNames(): string[];
  /** Selected terminal text, or "". */
  selection(): string;
  /** The last lines on the screen (when nothing is selected). */
  recentOutput(lines: number): string;
  /** Put a command on the input line, replacing what is typed there; not run. */
  insert(command: string): void;
  focus(): void;
  /** Run a command in the terminal (in plain view) and return its output. */
  run(command: string, reason: string): Promise<{ output: string; timedOut: boolean }>;
  /** The terminal talks to network gear (device CLI rules apply). */
  network(): boolean;
  /** What the insert button does, when not "put on the input line". */
  insertTitle?: string;
  /** false: no command can run here (RDP, VNC); the panel only talks. */
  canRun?: boolean;
  /** The remote screen, for a screenshot attachment (RDP, VNC). */
  capture?(): HTMLCanvasElement | null;
  /** The connection this conversation belongs to (it is kept under this). */
  conversationKey?(): string;
}

// ---- Saved conversations (this PC only, one per connection) ----
//
// Each conversation is its own localStorage key, so a save rewrites only that
// one (not the whole set), and the oldest can be dropped one at a time when
// space runs out. Secrets are masked out before anything is written.

const SAVED_PREFIX = "bx.aiConv.";
const LEGACY_SAVED = "bx.aiConversations";
const SAVED_MAX = 30;
const SAVED_BYTES = 200_000; // one conversation, before the oldest turns are dropped
const SAVED_TOTAL = 3_000_000; // all of them together, well under the ~5 MB localStorage limit

interface SavedConversation {
  turns: Turn[];
  masker: ReturnType<Masker["save"]> | null;
  system: "chat" | "explain" | "config" | "log";
  providerId: string | null;
  at: number;
  /** Token totals, kept so a reopened conversation still shows its usage. */
  usage?: { input: number; output: number };
}

const storageKey = (key: string) => SAVED_PREFIX + key;

// Move conversations from the old single-blob store to per-conversation keys,
// dropping the large blob so it no longer counts against the budget.
try {
  const legacy = localStorage.getItem(LEGACY_SAVED);
  if (legacy) {
    localStorage.removeItem(LEGACY_SAVED);
    const all = JSON.parse(legacy);
    if (all && typeof all === "object" && !Array.isArray(all))
      for (const [k, c] of Object.entries(all)) if (c && Array.isArray((c as SavedConversation).turns)) try {
        localStorage.setItem(storageKey(k), JSON.stringify(c));
      } catch {
        // No room for the old conversations: they are dropped.
      }
  }
} catch {
  // Nothing to migrate.
}

/** Saved conversations' storage keys with their age and size, for trimming. */
function savedEntries(): { sk: string; at: number; size: number }[] {
  const out: { sk: string; at: number; size: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const sk = localStorage.key(i);
    if (!sk?.startsWith(SAVED_PREFIX)) continue;
    const raw = localStorage.getItem(sk) ?? "";
    let at = 0;
    try {
      at = JSON.parse(raw)?.at ?? 0;
    } catch {
      // A corrupt entry sorts oldest, so it is the first to go.
    }
    out.push({ sk, at, size: raw.length });
  }
  return out;
}

function loadConversation(key: string): SavedConversation | null {
  try {
    const c = JSON.parse(localStorage.getItem(storageKey(key)) || "null");
    return c && Array.isArray(c.turns) ? c : null;
  } catch {
    return null;
  }
}

/** Keep a conversation (null forgets it). Images keep their thumbnail only; the
 * oldest turns go first when one grows too large, and the oldest conversations
 * go first when the store is full. */
function storeConversation(key: string, c: SavedConversation | null) {
  const sk = storageKey(key);
  localStorage.removeItem(sk);
  if (!c || !c.turns.length) return;
  const slim = { ...c, turns: c.turns.map((t) => ({ ...t, media: t.media?.map((m) => ({ ...m, data: undefined })) })) };
  // Drop the fewest oldest turns to fit, keeping the last two. Measure each turn
  // once (re-stringifying the whole conversation per removed pair would be
  // O(N^2)); a final check covers any small estimate error from array
  // punctuation without re-measuring per pair.
  let data = JSON.stringify(slim);
  if (slim.turns.length > 2 && data.length > SAVED_BYTES) {
    const sizes = slim.turns.map((t) => JSON.stringify(t).length + 1);
    let total = data.length;
    let drop = 0;
    while (drop < slim.turns.length - 2 && total > SAVED_BYTES) total -= sizes[drop++];
    slim.turns.splice(0, drop);
    data = JSON.stringify(slim);
    while (slim.turns.length > 2 && data.length > SAVED_BYTES) {
      slim.turns.splice(0, 1);
      data = JSON.stringify(slim);
    }
  }
  for (let tries = 0; tries < SAVED_MAX + 2; tries++) {
    const others = savedEntries()
      .filter((e) => e.sk !== sk)
      .sort((a, b) => a.at - b.at);
    const total = others.reduce((n, e) => n + e.size, 0);
    if ((others.length >= SAVED_MAX || total + data.length > SAVED_TOTAL) && others.length) {
      localStorage.removeItem(others[0].sk);
      continue;
    }
    try {
      localStorage.setItem(sk, data);
      return;
    } catch {
      if (!others.length) return; // nothing left to drop: this session only
      localStorage.removeItem(others[0].sk);
    }
  }
}

// ---- AI chat sessions (several named conversations per connection) ----
//
// A connection keeps a list of named chat sessions. Each session's turns live
// under its own conversation key `<conn>#<id>` (storeConversation above); this
// index, one per connection, holds their names and which one is current.

const SESS_PREFIX = "bx.aiSess.";
const SESS_SEP = "#";

interface SessMeta {
  id: string;
  name: string;
  at: number;
}
interface SessIndex {
  current: string;
  /** Last id handed out, so a new session's number never repeats after deletes. */
  seq: number;
  list: SessMeta[];
}

/** The default name for the nth session, in the screen language. */
function sessDefault(n: number): string {
  return `${tr("대화")} ${n}`;
}

/** The session list for a connection. The first time it is read it adopts a
 * single pre-sessions conversation (stored under the bare connection key) as
 * session 1, so existing chats are not lost. */
function loadSessions(conn: string): SessIndex {
  try {
    const idx = JSON.parse(localStorage.getItem(SESS_PREFIX + conn) || "null");
    if (idx && Array.isArray(idx.list) && idx.list.length && typeof idx.current === "string")
      return { current: idx.current, seq: idx.seq || idx.list.length, list: idx.list };
  } catch {
    // A corrupt index is rebuilt below.
  }
  const legacy = localStorage.getItem(storageKey(conn));
  if (legacy) {
    try {
      localStorage.setItem(storageKey(conn + SESS_SEP + "1"), legacy);
      localStorage.removeItem(storageKey(conn));
    } catch {
      // Out of room: the legacy conversation stays where it is (just unused).
    }
  }
  const idx: SessIndex = { current: "1", seq: 1, list: [{ id: "1", name: sessDefault(1), at: Date.now() }] };
  saveSessions(conn, idx);
  return idx;
}

function saveSessions(conn: string, idx: SessIndex) {
  try {
    localStorage.setItem(SESS_PREFIX + conn, JSON.stringify(idx));
  } catch {
    // The index is a convenience; losing it only forgets session names.
  }
}

/** Commands an AI may run in one answer, at most. */
const MAX_STEPS = 8;

/** The command an answer asks to run (its ```run block), if any. */
function runRequest(answer: string): string | null {
  const block = /```run[ \t]*\r?\n([\s\S]*?)```/.exec(answer);
  return block ? (commandLines(block[1])[0] ?? null) : null;
}

/** Characters of an attached file sent at most (about 40 k tokens). */
const FILE_LIMIT = 150_000;

async function openAiSettings() {
  const { openSettings } = await import("../settings");
  openSettings("ai");
}

// The subscription CLIs on this PC, detected once per session (spawns a probe).
let cliProbe: Promise<{ name: string; path: string; version: string }[]> | null = null;
const detectClis = () => (cliProbe ??= api.aiDetectCli().catch(() => []));

/** The empty state when no AI service is set up. If a subscription CLI (Claude
 * Code, Codex, Gemini CLI) is already installed and logged in, it offers to
 * start with it in one click — no trip to settings, no API key. */
function noProvider(el: HTMLElement, onEnabled?: () => void) {
  el.innerHTML = `<div class="ai-empty">${icon("Sparkles", 28)}<p>AI를 쓰려면 AI 서비스가 필요합니다.</p>
    <div class="ai-cli-quick" data-clis hidden></div>
    <p class="muted small">API 키(Anthropic·OpenAI·Gemini), 구독 CLI(Claude Code·Codex·Gemini CLI), 로컬 LLM(Ollama·LM Studio)을 쓸 수 있습니다.</p>
    <button class="btn btn-primary" data-ai-settings>${icon("Settings", 14)}AI 설정 열기</button></div>`;
  el.querySelector("[data-ai-settings]")!.addEventListener("click", openAiSettings);
  void detectClis().then((clis) => {
    const box = el.querySelector<HTMLElement>("[data-clis]");
    if (!box || !clis.length) return;
    box.hidden = false;
    box.innerHTML =
      `<p class="small muted">${tr("이미 설치된 CLI로 바로 시작할 수 있습니다")}</p>` +
      clis.map((c) => `<button type="button" class="btn btn-primary" data-cli="${esc(c.name)}">${icon("Bot", 14)}<span data-i18n-skip>${esc(cliLabel(c.name))}</span> ${tr("사용")}</button>`).join("");
    box.querySelectorAll<HTMLElement>("[data-cli]").forEach((b) =>
      b.addEventListener("click", () => {
        const cli = b.dataset.cli!;
        const provider: AiProvider = { id: crypto.randomUUID(), name: "", kind: "cli", baseUrl: "", model: "", credentialId: null, cli };
        updateSettings({ aiProviders: [...providers(), provider], aiDefault: provider.id });
        toast(`${cliLabel(cli)} ${tr("사용을 시작합니다")}`, "success");
        onEnabled?.();
      }),
    );
  });
}

/** Risk verdict for a command the AI proposed. */
function riskOf(command: string): { action: "block" | "warn"; note: string } | null {
  const hit = findTypedRisk(command);
  return hit ? { action: hit.rule.action, note: hit.rule.note } : null;
}

/** Answer text as HTML: paragraphs, **bold**, `code`, and code blocks whose
 * lines can each be put on the input line. The text is the AI's, shown as is. */
function render(answer: string, insertable = true, insertTitle = "입력 줄에 넣기 (실행하지 않음)"): string {
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  const parts = answer.split(/```/);
  return parts
    .map((part, i) => {
      if (i % 2 === 0) return part.trim() ? `<div class="ai-text">${inline(part.trim())}</div>` : "";
      const body = part.replace(/^[\w-]*\r?\n/, "");
      const lines = commandLines(body);
      const done = insertable && i < parts.length - 1;
      const actions =
        done && lines.length && lines.length <= 12
          ? lines
              .map((l) => {
                const r = riskOf(l);
                return `<div class="ai-cmd${r ? ` risk-${r.action}` : ""}"><code>${esc(l)}</code>${
                  r?.action === "block"
                    ? `<span class="ai-risk" title="${esc(r.note)}">${icon("Ban", 13)}차단</span>`
                    : `<button class="tool" data-insert="${esc(l)}" title="${esc(insertTitle)}">${icon(insertTitle.startsWith("복사") ? "Copy" : "CornerDownLeft", 13)}</button>`
                }${r?.action === "warn" ? `<span class="ai-risk" title="${esc(r.note)}">${icon("TriangleAlert", 13)}</span>` : ""}</div>`;
              })
              .join("")
          : "";
      // Each runnable line has its own insert button, and the block copy button
      // copies them all at once (newlines preserved) to paste and run. A single
      // "insert all" onto the one-line terminal input can't work — the input is
      // one command and the terminal collapses newlines — so it is not offered.
      return `<div class="ai-code"><pre>${esc(body.replace(/\s+$/, ""))}</pre><div class="ai-code-actions"><button class="tool" data-copy="${esc(body.trim())}" title="복사">${icon("Copy", 13)}</button></div>${actions}</div>`;
    })
    .join("");
}

/** A long message (an attached file) as shown: its start, code fences closed. */
function shortened(text: string): string {
  if (text.length <= 20_000) return text;
  const cut = `${text.slice(0, 20_000)}\n…`;
  return (cut.split("```").length - 1) % 2 ? `${cut}\n\`\`\`` : cut;
}

/** A command's output trimmed for the model: a huge output (cat of a big file,
 * dmesg, find /) would overflow the context window and cost — and it is re-sent
 * on every agent step. The head and tail carry the command's start and its
 * result or error; the middle is elided. The UI still keeps the full output. */
function clampForAi(text: string, max = 24_000): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…(${text.length - max} characters omitted)…\n${text.slice(-half)}`;
}

interface Turn {
  role: "user" | "assistant";
  /** As shown (real hosts). */
  shown: string;
  /** As sent (masked for cloud AI). */
  sent: string;
  error?: string;
  /** An answer that asked to run a command, and what became of it. */
  run?: { command: string; reason: string; status: "approve" | "running" | "done" | "skipped" | "blocked" | "failed" | "auto" };
  /** A command's output sent back to the AI. */
  output?: { command: string; text: string; timedOut: boolean };
  /** Images and PDFs sent with this message. */
  media?: Attached[];
  /** A note from the app to the AI, not shown. */
  nudge?: boolean;
  /** A reasoning model's thinking: unmasked for display (`reasoning`) and as the
   *  masked stream so far (`reasoningSent`). Shown live in a collapsed block and
   *  kept out of the answer, the copy and the history sent back to the model. */
  reasoning?: string;
  reasoningSent?: string;
}

const RUN_STATUS: Record<NonNullable<Turn["run"]>["status"], string> = {
  auto: "자동 실행",
  approve: "실행할까요?",
  running: "실행 중…",
  done: "실행함",
  skipped: "실행하지 않음",
  blocked: "차단됨",
  failed: "실행 실패",
};

// The panel width, shared by every tab and kept across restarts (--ai-w).
const AI_WIDTH_KEY = "bx.aiWidth";
const setAiWidth = (px: number | null) => {
  const root = document.documentElement.style;
  if (px === null) root.removeProperty("--ai-w");
  else root.setProperty("--ai-w", `${Math.round(px)}px`);
};
try {
  const saved = Number(localStorage.getItem(AI_WIDTH_KEY));
  if (saved >= 260) setAiWidth(saved);
} catch {
  // Storage blocked: the default width.
}

/** Drag the panel's left edge to change its width; double-click resets it. */
function wireGrip(grip: HTMLElement) {
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const view = grip.closest<HTMLElement>(".view") ?? document.body;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add("ai-resizing");
    let width = 0;
    let frame = 0;
    const move = (ev: PointerEvent) => {
      const r = view.getBoundingClientRect();
      // Room for at least 240px of terminal or screen on the left.
      width = Math.max(260, Math.min(r.right - ev.clientX, r.width - 240));
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), setAiWidth(width)));
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      document.body.classList.remove("ai-resizing");
      try {
        if (width) localStorage.setItem(AI_WIDTH_KEY, String(Math.round(width)));
      } catch {
        // Not kept: this session only.
      }
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip.addEventListener("dblclick", () => {
    setAiWidth(null);
    try {
      localStorage.removeItem(AI_WIDTH_KEY);
    } catch {
      // Nothing kept.
    }
  });
}

export class AiPanel {
  el: HTMLElement;
  private log: HTMLElement;
  private input: HTMLTextAreaElement;
  private turns: Turn[] = [];
  private masker: Masker | null = null;
  private skip = { skip: false };
  private asking: Asking | null = null;
  private providerId: string | null = null;
  private system: "chat" | "explain" | "config" | "log" = "chat";
  /** Tokens this conversation has used (summed over its requests). */
  private usage = { input: 0, output: 0 };
  /** The connection these chat sessions belong to (null for a keyless host). */
  private conn: string | null = null;
  /** The chat session shown now, and the connection's session list. */
  private sessionId = "1";
  private sessions: SessMeta[] = [];

  /** The storage key of the conversation shown now (its session of its
   * connection); null when the host has no connection key. */
  private convKey(): string | null {
    return this.conn ? this.conn + SESS_SEP + this.sessionId : null;
  }

  constructor(
    private host: AiHost,
    private onClose: () => void,
  ) {
    this.el = h(
      "div",
      { class: "ai-panel" },
      `<div class="ai-grip" title="끌어서 너비 조절 (두 번 누르면 기본값)"></div>
      <div class="ai-head">${icon("Sparkles", 15)}<b>AI</b>
        <select class="ai-provider" title="AI 서비스"></select>
        <span class="ai-head-actions">
          <button class="tool" data-act="search" title="대화 내 검색">${icon("Search", 15)}</button>
          <button class="tool" data-act="file" title="파일 분석 (설정·로그)">${icon("FileSearch", 15)}</button>
          <button class="tool" data-act="copy-all" title="대화 전체 복사">${icon("Copy", 15)}</button>
          <button class="tool" data-act="close" title="닫기">${icon("X", 15)}</button>
        </span></div>
      <div class="ai-sessions" data-sessions hidden>
        <select class="ai-session" data-i18n-skip title="대화 세션"></select>
        <button class="tool" data-act="new" title="새 대화 세션">${icon("MessageSquarePlus", 15)}</button>
        <button class="tool" data-act="sess-rename" title="세션 이름 바꾸기">${icon("Pencil", 14)}</button>
        <button class="tool" data-act="sess-del" title="세션 삭제">${icon("Trash2", 14)}</button>
      </div>
      <div class="ai-search" data-search hidden>
        ${icon("Search", 14)}
        <input type="text" placeholder="대화 내 검색" spellcheck="false" />
        <span class="ai-search-count muted small" data-i18n-skip></span>
        <button class="tool" data-act="search-close" title="검색 닫기">${icon("X", 14)}</button>
      </div>
      <div class="ai-log" data-i18n-skip></div>
      <div class="ai-compose">
        <div class="ai-attach-row" data-pending hidden></div>
        <div class="ai-queued" data-queued hidden></div>
        <textarea rows="2" placeholder="질문하거나 할 일을 적으세요 (Enter 보내기, Shift+Enter 줄 바꿈, Ctrl+V로 이미지 붙여넣기)"></textarea>
        <div class="ai-compose-row">
          <button type="button" class="tool" data-act="pick" title="이미지·PDF·텍스트 파일 첨부 (끌어다 놓아도 됩니다)">${icon("Paperclip", 15)}</button>
          ${host.capture ? `<button type="button" class="tool" data-act="capture" title="원격 화면을 캡처해 첨부">${icon("Camera", 15)}</button>` : ""}
          ${host.canRun === false ? "" : `<label class="check small"><input type="checkbox" data-attach /><span>선택 영역 첨부</span></label>`}
          ${host.canRun === false ? "" : `<button type="button" class="tool ai-mode" data-act="mode" title="AI가 터미널에서 명령을 실행하는 방식"></button>`}
          <span class="ai-where muted small"></span>
          <button class="btn btn-sm btn-primary" data-act="send">${icon("Send", 13)}질문하기</button>
        </div>
        <input type="file" multiple hidden data-files accept="image/*,application/pdf,.pdf,.txt,.log,.conf,.cfg,.config,.ini,.json,.xml,.yml,.yaml,.csv,.md,.sh,.ps1,.py,.sql,.out" />
        <div class="ai-usage" data-usage hidden></div>
      </div>`,
    );
    this.log = this.el.querySelector(".ai-log")!;
    this.log.addEventListener("contextmenu", (e) => this.logMenu(e));
    this.input = this.el.querySelector("textarea")!;
    this.el.addEventListener("click", (e) => this.click(e));
    wireGrip(this.el.querySelector<HTMLElement>(".ai-grip")!);
    // Files: picked, pasted (screenshots) or dropped onto the panel.
    const files = this.el.querySelector<HTMLInputElement>("[data-files]")!;
    files.addEventListener("change", () => {
      void this.addFiles([...(files.files ?? [])]);
      files.value = "";
    });
    this.input.addEventListener("paste", (e) => {
      const list = [...(e.clipboardData?.files ?? [])];
      if (!list.length) return;
      e.preventDefault();
      void this.addFiles(list);
    });
    this.el.addEventListener("dragover", (e) => {
      if ([...(e.dataTransfer?.types ?? [])].includes("Files")) {
        e.preventDefault();
        this.el.classList.add("drop");
      }
    });
    this.el.addEventListener("dragleave", (e) => {
      if (!this.el.contains(e.relatedTarget as Node)) this.el.classList.remove("drop");
    });
    this.el.addEventListener("drop", (e) => {
      this.el.classList.remove("drop");
      const list = [...(e.dataTransfer?.files ?? [])];
      if (!list.length) return;
      e.preventDefault();
      void this.addFiles(list);
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      } else if (e.key === "Escape") {
        e.preventDefault();
        // While a run is in progress, Esc stops it; otherwise it returns focus
        // to the terminal.
        if (this.busy) this.stop();
        else this.host.focus();
      }
    });
    this.el.querySelector<HTMLSelectElement>(".ai-provider")!.addEventListener("change", async (e) => {
      const sel = e.target as HTMLSelectElement;
      // Switching service starts a fresh conversation (a local chat's unmasked
      // hosts must not carry over to a cloud service). Confirm first so a misclick
      // does not throw away the current chat.
      if (this.turns.length && !(await confirmDialog({ title: "AI 서비스 바꾸기", message: "AI 서비스를 바꾸면 지금 대화를 정리하고 새 대화를 시작합니다. 계속할까요?", confirm: "바꾸기" }))) {
        sel.value = this.providerId ?? sel.value; // keep the current service
        return;
      }
      this.providerId = sel.value;
      this.newConversation();
    });
    this.el.querySelector<HTMLSelectElement>(".ai-session")!.addEventListener("change", (e) => {
      this.switchSession((e.target as HTMLSelectElement).value);
    });
    this.el.querySelector<HTMLInputElement>(".ai-search input")!.addEventListener("input", (e) => {
      this.filterLog((e.target as HTMLInputElement).value);
    });
    // The connection's chat sessions: the current one is restored below.
    this.conn = this.host.conversationKey?.() ?? null;
    if (this.conn) {
      const idx = loadSessions(this.conn);
      this.sessions = idx.list;
      this.sessionId = idx.current;
    }
    this.restore();
    this.refreshProviders();
    this.drawSessions();
    this.draw();
    this.drawUsage();
  }

  /** Attachments waiting for the next message. */
  private pending: Attached[] = [];

  private async addFiles(files: File[]) {
    for (const f of files) {
      try {
        this.pending.push(await fromFile(f));
      } catch (err) {
        toast(errorText(err), "warn", 5000);
      }
    }
    this.drawPending();
    this.input.focus();
  }

  /** Capture the remote screen and ask what it shows (RDP, VNC). */
  explainScreen() {
    if (this.busy || !this.captureScreen()) return;
    void this.send(tr("이 화면에 보이는 내용을 설명하고, 오류나 문제가 있다면 원인과 해결 방법을 알려 주세요."), true);
  }

  /** Capture the remote screen (RDP, VNC) as the next message's image. */
  captureScreen(): boolean {
    const canvas = this.host.capture?.();
    if (!canvas || !canvas.width) {
      toast("캡처할 화면이 없습니다", "warn");
      return false;
    }
    this.pending.push(fromCanvas(canvas, `screen-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.png`));
    this.drawPending();
    return true;
  }

  private drawPending() {
    const row = this.el.querySelector<HTMLElement>("[data-pending]")!;
    row.hidden = !this.pending.length;
    row.innerHTML = this.pending
      .map(
        (a, i) =>
          `<span class="ai-chip" title="${esc(`${a.name} · ${sizeLabel(a.size)}`)}">${a.preview ? `<img class="ai-thumb small" src="${a.preview}" alt="" />` : icon(a.kind === "pdf" ? "FileText" : "File", 13)}<span data-i18n-skip>${esc(a.name)}</span><button type="button" class="tool" data-unattach="${i}" title="빼기">${icon("X", 12)}</button></span>`,
      )
      .join("");
  }

  /** Settings changed: the provider list may have too. */
  refreshProviders() {
    const sel = this.el.querySelector<HTMLSelectElement>(".ai-provider")!;
    const list = providers();
    const cur = currentProvider(this.providerId);
    sel.innerHTML = list.map((p) => `<option value="${esc(p.id)}" ${p.id === cur?.id ? "selected" : ""}>${esc(providerLabel(p))}</option>`).join("");
    sel.hidden = list.length < 2;
    const where = this.el.querySelector(".ai-where")!;
    where.textContent = cur ? (isLocal(cur) ? "이 PC에서 처리" : "외부 서비스로 전송") : "";
    if (!cur) noProvider(this.log, () => (this.refreshProviders(), this.draw(), this.input.focus()));
  }

  private get provider(): AiProvider | null {
    return currentProvider(this.providerId);
  }

  focus() {
    this.input.focus();
  }

  private copy(text: string) {
    if (!text.trim()) return;
    writeClipboard(text);
    toast("복사했습니다", "success", 1500);
  }

  /** One turn as plain text: a message, a command the AI ran, or its output. */
  private turnText(t: Turn | undefined): string {
    if (!t || t.nudge) return "";
    if (t.output) return `$ ${t.output.command}\n${t.output.text}`;
    if (t.role === "user") return this.turns[this.turns.indexOf(t) - 1]?.run ? "" : t.shown;
    const body = (t.run ? t.shown.replace(/```run[ \t]*\r?\n[\s\S]*?```/, "") : t.shown).trim();
    return [body, t.run ? `$ ${t.run.command}` : "", t.error ?? ""].filter(Boolean).join("\n");
  }

  /** The whole conversation as text, for the clipboard. */
  private conversationText(): string {
    return this.turns
      .map((t) => {
        const text = this.turnText(t);
        if (!text) return "";
        return t.output ? text : `${t.role === "user" ? tr("나") : "AI"}: ${text}`;
      })
      .filter(Boolean)
      .join("\n\n");
  }

  /** Right-click in the conversation: the selection, this message or all of it. */
  private logMenu(e: MouseEvent) {
    e.preventDefault();
    const selected = window.getSelection()?.toString() ?? "";
    const turn = (e.target as HTMLElement).closest<HTMLElement>("[data-turn]")?.dataset.turn;
    contextMenu(e.clientX, e.clientY, [
      { label: "복사", icon: "Copy", disabled: !selected, action: () => this.copy(selected) },
      { label: "이 메시지 복사", icon: "MessageSquarePlus", disabled: turn === undefined, action: () => this.copy(this.turnText(this.turns[+turn!])) },
      { label: "대화 전체 복사", icon: "Copy", action: () => this.copy(this.conversationText()) },
    ]);
  }

  newConversation() {
    // Abandon any in-flight run (token), and end its stream and pending approval
    // so it cannot keep talking to the provider or write into the new, empty
    // conversation.
    this.runSeq++;
    this.asking?.cancel();
    this.asking = null;
    const approval = this.approval;
    this.approval = null;
    approval?.(false);
    this.busy = false;
    this.stopped = false;
    this.interrupting = false;
    this.turns = [];
    this.masker = null;
    this.skip = { skip: false };
    this.system = "chat";
    this.queued = null;
    this.usage = { input: 0, output: 0 };
    this.drawQueued();
    this.drawUsage();
    this.persist();
    this.draw();
  }

  // ---- chat sessions (several named conversations per connection) ----

  /** Draw the session switcher; hidden for a host with no connection key. */
  private drawSessions() {
    const bar = this.el.querySelector<HTMLElement>("[data-sessions]");
    if (!bar) return;
    bar.hidden = !this.conn;
    if (!this.conn) return;
    const sel = bar.querySelector<HTMLSelectElement>(".ai-session")!;
    sel.innerHTML = this.sessions
      .map((s) => `<option value="${esc(s.id)}" ${s.id === this.sessionId ? "selected" : ""}>${esc(s.name)}</option>`)
      .join("");
  }

  /** Show the current session: abandon any in-flight run, then load its saved
   * conversation (empty when it has none). Shared by switch, create and delete. */
  private loadCurrent() {
    this.runSeq++;
    this.asking?.cancel();
    this.asking = null;
    const approval = this.approval;
    this.approval = null;
    approval?.(false);
    this.busy = false;
    this.stopped = false;
    this.interrupting = false;
    this.queued = null;
    this.turns = [];
    this.masker = null;
    this.skip = { skip: false };
    this.system = "chat";
    this.usage = { input: 0, output: 0 };
    this.pending = [];
    this.restore();
    this.drawPending();
    this.drawSessions();
    this.drawQueued();
    this.drawUsage();
    this.refreshProviders();
    this.draw();
    this.input.focus();
  }

  private switchSession(id: string) {
    if (!this.conn || id === this.sessionId) return;
    this.persist();
    const idx = loadSessions(this.conn);
    if (!idx.list.some((s) => s.id === id)) return;
    idx.current = id;
    saveSessions(this.conn, idx);
    this.sessions = idx.list;
    this.sessionId = id;
    this.loadCurrent();
  }

  /** Start a new, empty named session beside the current one. */
  private createSession() {
    if (!this.conn) return this.newConversation();
    this.persist();
    const idx = loadSessions(this.conn);
    idx.seq += 1;
    const id = String(idx.seq);
    idx.list.push({ id, name: sessDefault(idx.seq), at: Date.now() });
    idx.current = id;
    saveSessions(this.conn, idx);
    this.sessions = idx.list;
    this.sessionId = id;
    this.loadCurrent();
  }

  /** Rename the current session. */
  private async renameSession() {
    if (!this.conn) return;
    const cur = this.sessions.find((s) => s.id === this.sessionId);
    const res = await promptDialog({ title: tr("세션 이름 바꾸기"), label: tr("세션 이름"), value: cur?.name ?? "", confirm: tr("저장") });
    if (this.disposed || !res) return;
    const name = res.value.trim();
    if (!name) return;
    const idx = loadSessions(this.conn);
    const m = idx.list.find((s) => s.id === this.sessionId);
    if (!m) return;
    m.name = name;
    saveSessions(this.conn, idx);
    this.sessions = idx.list;
    this.drawSessions();
  }

  /** Delete the current session and its saved conversation. The connection
   * always keeps at least one session, so deleting the last starts a fresh one. */
  private async deleteSession() {
    if (!this.conn) return;
    const cur = this.sessions.find((s) => s.id === this.sessionId);
    const ok = await confirmDialog({
      title: tr("대화 세션 삭제"),
      icon: "Trash2",
      danger: true,
      message: `<p>${esc(tr("이 대화 세션을 삭제할까요? 되돌릴 수 없습니다."))}</p><p class="muted small" data-i18n-skip>${esc(cur?.name ?? "")}</p>`,
      confirm: tr("삭제"),
      cancel: tr("취소"),
      focusCancel: true,
    });
    if (this.disposed || !ok) return;
    storeConversation(this.convKey()!, null);
    const idx = loadSessions(this.conn);
    idx.list = idx.list.filter((s) => s.id !== this.sessionId);
    if (!idx.list.length) {
      idx.seq += 1;
      idx.list.push({ id: String(idx.seq), name: sessDefault(idx.seq), at: Date.now() });
    }
    idx.current = idx.list[idx.list.length - 1].id;
    saveSessions(this.conn, idx);
    this.sessions = idx.list;
    this.sessionId = idx.current;
    this.loadCurrent();
  }

  // ---- search within the conversation ----

  /** Show or hide the find box. Hiding (or opening) clears any active filter. */
  private toggleSearch(show?: boolean) {
    const bar = this.el.querySelector<HTMLElement>("[data-search]");
    if (!bar) return;
    const open = show ?? bar.hidden;
    bar.hidden = !open;
    const input = bar.querySelector<HTMLInputElement>("input")!;
    if (open) {
      input.focus();
      input.select();
    } else {
      input.value = "";
      this.filterLog("");
    }
  }

  /** Dim the turns that do not contain the query; show how many match. */
  private filterLog(query: string) {
    const q = query.trim().toLowerCase();
    let hits = 0;
    for (const el of Array.from(this.log.children) as HTMLElement[]) {
      if (el.classList.contains("ai-empty")) continue;
      const match = !q || (el.textContent ?? "").toLowerCase().includes(q);
      el.classList.toggle("ai-search-hidden", !!q && !match);
      if (q && match) hits++;
    }
    const count = this.el.querySelector<HTMLElement>(".ai-search-count");
    if (count) count.textContent = q ? tr(`${hits}개 일치`) : "";
  }

  /** Save this conversation under its connection, to come back after closing.
   * Secrets are masked out of the saved copy so they never reach localStorage,
   * and an answer still streaming when we save (closed mid-run) is marked so a
   * restored conversation shows the interruption instead of a stuck spinner and
   * never sends an empty assistant turn back to the provider. */
  private persist() {
    const key = this.convKey();
    if (!key) return;
    const turns: Turn[] = this.turns.map((t) => {
      const fixed: Turn =
        t.role === "assistant" && !t.shown && !t.error ? { ...t, error: "중지했습니다" } : t;
      return {
        ...fixed,
        shown: maskSecrets(fixed.shown),
        sent: maskSecrets(fixed.sent),
        // Reasoning may echo secrets too; mask it like the answer, and drop the
        // live-only stream accumulator so it never reaches localStorage.
        ...(fixed.reasoning ? { reasoning: maskSecrets(fixed.reasoning) } : {}),
        reasoningSent: undefined,
        // The command strings carry the same secrets as `shown` (mysql -p…,
        // net user … pw, curl -u a:pw): mask them too, not only the output.
        ...(fixed.run ? { run: { ...fixed.run, command: maskSecrets(fixed.run.command) } } : {}),
        ...(fixed.output ? { output: { ...fixed.output, command: maskSecrets(fixed.output.command), text: maskSecrets(fixed.output.text) } } : {}),
      };
    });
    storeConversation(key, turns.length ? { turns, masker: this.masker?.save() ?? null, system: this.system, providerId: this.providerId, at: Date.now(), usage: this.usage } : null);
  }

  /** The conversation this connection had before (panel closed, app restarted). */
  private restore() {
    const key = this.convKey();
    const saved = key ? loadConversation(key) : null;
    if (!saved) return;
    this.turns = saved.turns.map((t) => (t.run?.status === "running" || t.run?.status === "approve" ? { ...t, run: { ...t.run, status: "skipped" } } : t));
    this.masker = saved.masker ? Masker.restore(saved.masker) : null;
    this.system = saved.system ?? "chat";
    if (saved.usage) this.usage = { input: saved.usage.input || 0, output: saved.usage.output || 0 };
    if (saved.providerId && providers().some((p) => p.id === saved.providerId)) this.providerId = saved.providerId;
  }

  private click(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const ins = t.closest<HTMLElement>("[data-insert]");
    if (ins) {
      this.host.insert(ins.dataset.insert!);
      this.host.focus();
      return;
    }
    const copy = t.closest<HTMLElement>("[data-copy]");
    if (copy) {
      void navigator.clipboard.writeText(copy.dataset.copy!).then(() => toast("복사했습니다", "success", 1500));
      return;
    }
    const turn = t.closest<HTMLElement>("[data-copy-turn]")?.dataset.copyTurn;
    if (turn !== undefined) {
      this.copy(this.turnText(this.turns[+turn]));
      return;
    }
    const decide = t.closest<HTMLElement>("[data-run]")?.dataset.run;
    if (decide && this.approval) {
      const resolve = this.approval;
      this.approval = null;
      resolve(decide === "yes");
      return;
    }
    const unattach = t.closest<HTMLElement>("[data-unattach]")?.dataset.unattach;
    if (unattach !== undefined) {
      this.pending.splice(+unattach, 1);
      this.drawPending();
      return;
    }
    if (t.closest("[data-queued-now]")) return void this.interruptNow();
    if (t.closest("[data-queued-cancel]")) {
      this.queued = null;
      this.drawQueued();
      return;
    }
    if (t.closest("[data-regen]")) return void this.regenerate();
    const edit = t.closest<HTMLElement>("[data-edit]")?.dataset.edit;
    if (edit !== undefined) return void this.editTurn(+edit);
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "pick") this.el.querySelector<HTMLInputElement>("[data-files]")!.click();
    else if (act === "capture") this.captureScreen();
    else if (act === "close") this.onClose();
    else if (act === "new") this.createSession();
    else if (act === "sess-rename") void this.renameSession();
    else if (act === "sess-del") void this.deleteSession();
    else if (act === "search") this.toggleSearch();
    else if (act === "search-close") this.toggleSearch(false);
    else if (act === "copy-all") this.copy(this.conversationText());
    else if (act === "send") void (this.busy ? this.stop() : this.send());
    else if (act === "file") void this.analyseFile();
    else if (act === "mode") void this.pickRunMode();
  }

  /** Stop the answer, the waiting approval, and any further commands. A plain
   * stop also drops a queued interjection; an interrupt keeps it to send next. */
  private stop(keepQueued = false) {
    this.stopped = true;
    if (!keepQueued) {
      this.queued = null;
      this.drawQueued();
    }
    this.asking?.cancel();
    const resolve = this.approval;
    this.approval = null;
    resolve?.(false);
  }

  /** Cut in now: end the current run but send the queued message right after. */
  private interruptNow() {
    if (!this.queued || !this.busy) return;
    this.interrupting = true;
    this.stop(true);
  }

  /** Hold what is in the compose box to send when the current run ends. Several
   * notes pile onto one queued message; attachments are merged in. */
  private queueFromCompose() {
    const text = this.input.value.trim();
    const pending = this.pending;
    if (!text && !pending.length) return;
    this.queued = {
      text: [this.queued?.text, text].filter(Boolean).join("\n"),
      pending: [...(this.queued?.pending ?? []), ...pending],
    };
    this.input.value = "";
    this.pending = [];
    this.drawPending();
    this.drawQueued();
    toast(tr("응답이 끝나면 보냅니다"), "success", 1800);
  }

  /** Send the queued interjection (after a run ends), reusing the normal path. */
  private dequeue() {
    const q = this.queued;
    if (!q || this.disposed) return;
    this.queued = null;
    this.drawQueued();
    this.input.value = q.text;
    this.pending = q.pending;
    this.drawPending();
    void this.send();
  }

  /** The queued-message chip above the compose box, with send-now and cancel. */
  private drawQueued() {
    const row = this.el.querySelector<HTMLElement>("[data-queued]");
    if (!row) return;
    row.hidden = !this.queued;
    if (!this.queued) return (row.innerHTML = "");
    row.innerHTML = `<span class="ai-queued-label">${icon("CornerDownLeft", 13)}${tr("끼어들 메시지")}</span>
      <span class="ai-queued-text" data-i18n-skip>${esc(this.queued.text || tr("(첨부만)"))}</span>
      <button type="button" class="btn btn-sm btn-primary" data-queued-now>${tr("지금 보내기")}</button>
      <button type="button" class="tool" data-queued-cancel title="${tr("취소")}">${icon("X", 13)}</button>`;
  }

  /** Add a request's reported tokens to the running total and show it. */
  private addUsage(u: AiUsage) {
    this.usage.input += u.input ?? 0;
    this.usage.output += u.output ?? 0;
    this.drawUsage();
  }

  /** The token-usage line at the bottom; hidden until a provider reports any. */
  private drawUsage() {
    const el = this.el.querySelector<HTMLElement>("[data-usage]");
    if (!el) return;
    const { input, output } = this.usage;
    const total = input + output;
    el.hidden = total === 0;
    if (!total) return (el.innerHTML = "");
    const n = (v: number) => v.toLocaleString();
    el.innerHTML = `${icon("Sparkles", 12)}<span>${tr("토큰")}</span>
      <span title="${tr("입력(프롬프트) 토큰")}">${icon("ArrowUp", 11)}${n(input)}</span>
      <span title="${tr("출력(응답) 토큰")}">${icon("CornerDownLeft", 11)}${n(output)}</span>
      <span class="ai-usage-total" title="${tr("이 대화 누적")}">${tr("합계")} ${n(total)}</span>`;
  }

  /** Whether a turn is a real user question (not a command result or app nudge).
   * A command result is a user turn pushed right after an assistant turn that
   * ran a command, so its predecessor has a `run`. */
  private isQuestion(i: number): boolean {
    const t = this.turns[i];
    return !!t && t.role === "user" && !t.output && !t.nudge && !this.turns[i - 1]?.run;
  }

  /** Regenerate the last answer: drop it and re-ask the last question. */
  private regenerate() {
    if (this.busy) return;
    let i = this.turns.length - 1;
    while (i >= 0 && !this.isQuestion(i)) i--;
    if (i < 0) return;
    const userTurn = this.turns[i];
    this.turns = this.turns.slice(0, i);
    this.pending = (userTurn.media ?? []).filter((a) => a.data);
    this.drawPending();
    // internal: the stored text already holds any attached selection — don't
    // append the current terminal selection again.
    void this.send(userTurn.shown, true);
  }

  /** Load a past question back into the compose box to edit and send again;
   * everything from that question onward is dropped first. */
  private editTurn(i: number) {
    if (this.busy || !this.isQuestion(i)) return;
    const t = this.turns[i];
    this.turns = this.turns.slice(0, i);
    this.input.value = t.shown;
    this.pending = (t.media ?? []).filter((a) => a.data);
    this.drawPending();
    this.persist();
    this.draw();
    this.input.focus();
  }

  private async pickRunMode() {
    const { contextMenu } = await import("../ui");
    const r = this.el.querySelector<HTMLElement>('[data-act="mode"]')!.getBoundingClientRect();
    const set = (aiRunMode: "auto" | "confirm" | "off") => {
      updateSettings({ aiRunMode });
      this.draw();
    };
    const mark = (m: string) => (this.runMode === m ? "Check" : "Circle");
    contextMenu(r.left, r.top - 4, [
      { label: "읽기 전용 명령은 바로 실행, 나머지는 확인", icon: mark("auto"), action: () => set("auto") },
      { label: "모든 명령을 실행 전에 확인", icon: mark("confirm"), action: () => set("confirm") },
      { label: "명령을 실행하지 않음 (제안만)", icon: mark("off"), action: () => set("off") },
    ]);
  }

  private draw() {
    const btn = this.el.querySelector<HTMLElement>('[data-act="send"]')!;
    btn.innerHTML = this.busy ? `${icon("Square", 13)}중지` : `${icon("Send", 13)}질문하기`;
    // While answering, the box still takes input — hint that it will be queued.
    this.input.placeholder = this.busy
      ? tr("응답 중… 입력하면 끝난 뒤 이어서 보냅니다 (끼어들기)")
      : tr("질문하거나 할 일을 적으세요 (Enter 보내기, Shift+Enter 줄 바꿈, Ctrl+V로 이미지 붙여넣기)");
    const mode = this.el.querySelector<HTMLElement>('[data-act="mode"]');
    if (mode) mode.innerHTML = `${icon(this.runMode === "off" ? "Ban" : "SquareTerminal", 13)}<span>${this.runMode === "auto" ? "읽기 전용 자동 실행" : this.runMode === "confirm" ? "실행 전 확인" : "실행 안 함"}</span>`;
    if (!this.provider) return noProvider(this.log, () => (this.refreshProviders(), this.draw(), this.input.focus()));
    if (!this.turns.length) {
      this.log.innerHTML = `<div class="ai-empty small"><p>${
        this.runMode === "off"
          ? `터미널에서 텍스트를 선택하고 질문하면 함께 보냅니다. 답의 명령은 ${icon("CornerDownLeft", 12)} 버튼으로 입력 줄에 넣을 수 있고, 실행은 직접 Enter로 합니다.`
          : "할 일을 적으면 AI가 이 터미널에서 명령을 실행해 결과를 보고 분석합니다. 읽기 전용 명령은 바로 실행하고, 시스템을 바꿀 수 있는 명령은 실행 전에 묻습니다. 실행 방식은 아래 버튼에서 바꿉니다."
      }</p></div>`;
      return;
    }
    // Keep the outputs the engineer expanded and their place in the log open
    // across a rebuild, and only follow new content when already at the bottom.
    const open = new Set([...this.log.querySelectorAll<HTMLDetailsElement>("details[open][data-turn]")].map((d) => d.dataset.turn));
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
    this.log.innerHTML = this.turns.map((t) => this.drawTurn(t)).join("");
    for (const d of this.log.querySelectorAll<HTMLDetailsElement>("details[data-turn]")) if (open.has(d.dataset.turn)) d.open = true;
    if (atBottom) this.log.scrollTop = this.log.scrollHeight;
  }

  /** Redraw just one turn (the streaming answer), so a long conversation is not
   * rebuilt on every frame — which would fold open outputs, drop the reader's
   * text selection and jump the scroll. Falls back to a full draw if needed. */
  private updateTurn(t: Turn) {
    const i = this.turns.indexOf(t);
    const el = this.log.querySelector(`[data-turn="${i}"]`);
    if (!el) return this.draw();
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
    el.outerHTML = this.drawTurn(t);
    if (atBottom) this.log.scrollTop = this.log.scrollHeight;
  }

  private drawTurn(t: Turn): string {
    if (t.output) {
      // A command's output, folded: the AI reads it, the engineer may.
      const lines = t.output.text ? t.output.text.split("\n").length : 0;
      return `<details class="ai-output" data-turn="${this.turns.indexOf(t)}"><summary>${icon("SquareTerminal", 13)}<code data-i18n-skip>${esc(t.output.command)}</code><span class="muted">${tr(`${lines}줄`)}${t.output.timedOut ? tr(" · 30초 후 중지") : ""}</span></summary><pre data-i18n-skip>${esc(t.output.text || tr("(출력 없음)"))}</pre></details>`;
    }
    if (t.role === "user") {
      // A note to the AI about a command that did not run, or the app's own nudge.
      if (t.nudge || this.turns[this.turns.indexOf(t) - 1]?.run) return "";
      const media = t.media?.length ? `<div class="ai-attach-row">${t.media.map((a) => (a.preview ? `<img class="ai-thumb" src="${a.preview}" alt="" title="${esc(a.name)}" />` : `<span class="ai-chip">${icon("FileText", 13)}<span data-i18n-skip>${esc(a.name)}</span></span>`)).join("")}</div>` : "";
      const ui = this.turns.indexOf(t);
      const edit = this.busy ? "" : `<button type="button" class="tool ai-msg-edit" data-edit="${ui}" title="${tr("이 질문 수정")}">${icon("Pencil", 13)}</button>`;
      return `<div class="ai-msg user" data-turn="${ui}">${edit}${media}${render(shortened(t.shown), false)}</div>`;
    }
    const body = (t.run ? t.shown.replace(/```run[ \t]*\r?\n[\s\S]*?```/, "") : t.shown).trim();
    const run = t.run
      ? `<div class="ai-run ${t.run.status}">${icon(t.run.status === "blocked" ? "Ban" : t.run.status === "running" ? "LoaderCircle" : "SquareTerminal", 14, t.run.status === "running" ? "spin" : "")}
          <code data-i18n-skip>${esc(t.run.command)}</code>
          <span class="ai-run-state">${tr(RUN_STATUS[t.run.status])}</span>
          <span class="muted small ai-run-why">${esc(tr(t.run.reason))}</span>
          ${t.run.status === "approve" ? `<span class="ai-run-buttons"><button class="btn btn-sm btn-primary" data-run="yes">${icon("Play", 13)}${tr("실행")}</button><button class="btn btn-sm" data-run="no">${tr("건너뛰기")}</button></span>` : ""}
        </div>`
      : "";
    const ai = this.turns.indexOf(t);
    // A reasoning model's thinking: a folded block, open while it is still the
    // only thing we have, collapsed once the answer begins.
    const thought = t.reasoning?.trim();
    const reasoning = thought
      ? `<details class="ai-reasoning" data-turn="${ai}"${body ? "" : " open"}><summary>${icon("Brain", 13)}<span class="muted">${tr("추론 과정")}</span></summary><div class="ai-reasoning-body" data-i18n-skip>${render(thought, false)}</div></details>`
      : "";
    const waiting = !t.shown && !t.error && !thought ? `<div class="ai-wait">${icon("LoaderCircle", 14, "spin")}</div>` : "";
    const copyBtn = body ? `<button type="button" class="tool ai-msg-copy" data-copy-turn="${ai}" title="${tr("이 메시지 복사")}">${icon("Copy", 13)}</button>` : "";
    // Regenerate only the latest answer (re-running a middle one would throw away
    // everything the conversation did afterwards).
    const regen = !this.busy && ai === this.turns.length - 1 && (body || t.error) ? `<button type="button" class="tool ai-msg-regen" data-regen title="${tr("이 답변 다시 생성")}">${icon("RefreshCw", 13)}</button>` : "";
    return `<div class="ai-msg assistant" data-turn="${ai}">${regen}${copyBtn}${reasoning}${body ? render(body, true, this.host.insertTitle) : waiting}${run}${t.error ? `<div class="ai-error">${esc(tr(t.error))}</div>` : ""}</div>`;
  }

  /** Start a conversation that explains `text` (a selection, or the screen). */
  explain(text: string) {
    if (this.busy) return;
    // The request shows in the conversation: in the screen language.
    void this.send(`${tr("이 출력의 의미와 원인, 다음 단계를 설명해 주세요.")}\n\n\`\`\`text\n${text}\n\`\`\``, true);
  }

  /** Review a configuration or a log. */
  analyse(text: string, what: "config" | "log", name: string) {
    if (this.busy) return;
    // This one message is a review; the conversation goes on as a chat.
    this.system = what;
    const cut = text.length > FILE_LIMIT ? (what === "log" ? text.slice(-FILE_LIMIT) : text.slice(0, FILE_LIMIT)) : text;
    const n = FILE_LIMIT.toLocaleString();
    const note = text.length > FILE_LIMIT ? tr(what === "log" ? `(마지막 ${n}자만)` : `(처음 ${n}자만)`) : "";
    void this.send(`${tr(what === "config" ? "이 설정을 점검해 주세요" : "이 로그를 분석해 주세요")}: ${name} ${note}\n\n\`\`\`text\n${cut}\n\`\`\``, true).finally(() => (this.system = "chat"));
  }

  private async analyseFile() {
    const path = await pickOpenFile("분석할 설정·로그 파일");
    if (!path) return;
    let text: string;
    try {
      text = await api.readTextFile(path);
    } catch (err) {
      return toast(errorText(err), "error");
    }
    const name = path.split(/[\\/]/).pop() ?? path;
    const log = /\.(log|txt|out)$/i.test(name) && !/conf|cfg|config|backup|running|startup/i.test(name);
    this.analyse(text, log ? "log" : "config", name);
  }

  /** Send `typed` (or the text box), with the selection when asked for. */
  /** How the AI's commands may run: settings → AI (auto: read-only ones at once). */
  private get runMode(): "auto" | "confirm" | "off" {
    return state.settings.aiRunMode ?? "auto";
  }

  private approval: ((ok: boolean) => void) | null = null;
  private stopped = false;
  /** A message typed while a run is in progress, sent when it ends (끼어들기). */
  private queued: { text: string; pending: Attached[] } | null = null;
  /** The queued message should go even though the run was stopped to make room. */
  private interrupting = false;

  /** Wait for the engineer's Run / Skip on the card. */
  private approve(): Promise<boolean> {
    return new Promise((resolve) => (this.approval = resolve));
  }

  async send(typed?: string, internal = false) {
    const p = this.provider;
    if (!p) return void openAiSettings();
    if (this.asking || this.busy) {
      // A run is in progress: hold a composed message as an interjection (끼어들기).
      if (typed === undefined) this.queueFromCompose();
      return;
    }
    let text = (typed ?? this.input.value).trim();
    const attached = this.pending;
    if (!text && !attached.length) return;
    // Attachments without a question: ask about them.
    if (!text) text = tr(attached.some((a) => a.kind === "image") ? "첨부한 내용을 보고 무엇인지, 문제가 있다면 원인과 해결 방법을 알려 주세요." : "첨부한 파일을 분석해 주세요.");
    const attach = this.el.querySelector<HTMLInputElement>("[data-attach]");
    if (!internal && attach?.checked) {
      const sel = this.host.selection();
      if (sel.trim()) text += `\n\n\`\`\`text\n${sel}\n\`\`\``;
      attach.checked = false;
    }
    // Text files become part of the message (and are masked with it).
    for (const a of attached) if (a.kind === "text") text += `\n\n${a.name}:\n\`\`\`text\n${a.text}\n\`\`\``;
    const media = attached.filter((a) => a.kind !== "text");
    this.masker ??= new Masker(!isLocal(p) && state.settings.aiMaskHosts, this.host.hostNames());
    const masker = this.masker;
    const mask = (s: string) => (isLocal(p) ? s : masker.mask(s));
    const sent = mask(text);
    // With commands allowed, the AI may look around in the terminal itself.
    const agent = this.host.canRun !== false && this.runMode !== "off" && (this.system === "chat" || this.system === "explain");
    // Claim the run before the confirm dialog's await so a second Enter/Send is
    // queued rather than starting a parallel run; the run token lets a new
    // conversation or provider switch mid-run abandon this one cleanly.
    this.busy = true;
    this.stopped = false;
    const myRun = ++this.runSeq;
    this.draw();
    try {
      if (!(await confirmSend(p, sent, this.skip, agent, attached))) return;
      if (myRun !== this.runSeq) return; // abandoned during the confirm dialog
      if (typed === undefined) this.input.value = "";
      this.pending = [];
      this.drawPending();
      this.turns.push({ role: "user", shown: text, sent, media });
      const target = this.host.target();
      const system = agent ? prompts.agent(target, MAX_STEPS) : this.system === "explain" ? prompts.explain(target) : this.system === "chat" ? prompts.chat(target) : prompts.analyse(target, this.system);
      let nudged = false;
      for (let step = 0; ; step++) {
        if (myRun !== this.runSeq) return;
        const answer: Turn = { role: "assistant", shown: "", sent: "" };
        this.turns.push(answer);
        const history: AiMessage[] = this.turns
          .filter((t) => t !== answer && !t.error)
          // Images and PDFs are large: send them only on the first provider call
          // of this message, not again on every agent step that re-sends history.
          .map((t) => ({ role: t.role, content: t.sent, ...(step === 0 && t.media?.some((a) => a.data) ? { attachments: t.media.filter((a) => a.data).map((a) => ({ mime: a.mime!, data: a.data!, name: a.name })) } : {}) }));
        let frame = 0;
        let rframe = 0;
        this.asking = ask(
          p,
          system,
          history,
          (sofar) => {
            answer.sent = sofar;
            // Unmask once per animation frame, not per streamed delta: unmasking
            // the whole accumulated answer on every delta is O(N²) over a long reply.
            if (!frame)
              frame = requestAnimationFrame(() => {
                frame = 0;
                answer.shown = masker.unmask(answer.sent);
                this.updateTurn(answer);
              });
          },
          (u) => this.addUsage(u),
          // Reasoning-model thinking: shown live in a folded block, batched per
          // frame like the answer, and kept out of the answer itself.
          (sofar) => {
            answer.reasoningSent = sofar;
            if (!rframe)
              rframe = requestAnimationFrame(() => {
                rframe = 0;
                answer.reasoning = masker.unmask(answer.reasoningSent ?? "");
                this.updateTurn(answer);
              });
          },
        );
        this.draw();
        try {
          await this.asking.done;
        } catch (err) {
          const msg = errorText(err);
          answer.error = msg === "CANCELLED" ? "중지했습니다" : msg;
        } finally {
          this.asking = null;
          cancelAnimationFrame(frame);
          cancelAnimationFrame(rframe);
          // The per-frame unmask may not have run for the last delta (or at all
          // for a short answer): bring `shown` fully up to date before it is read.
          answer.shown = masker.unmask(answer.sent);
          if (answer.reasoningSent) answer.reasoning = masker.unmask(answer.reasoningSent);
        }
        if (myRun !== this.runSeq) return;
        const command = agent && !answer.error && !this.stopped ? runRequest(answer.shown) : null;
        // Commands handed to the engineer instead of run: ask once to run them itself.
        if (!command && agent && !nudged && !answer.error && !this.stopped && /```[\w-]*\r?\n[\s\S]*?```/.test(answer.shown)) {
          nudged = true;
          const note = "Run the commands yourself, one per run block, instead of asking the engineer to type them; then analyse the results.";
          this.turns.push({ role: "user", shown: "", sent: note, nudge: true });
          continue;
        }
        if (!command) break;
        if (step >= MAX_STEPS) {
          answer.error = `명령을 ${MAX_STEPS}개까지 실행해 멈췄습니다. 더 알아보려면 이어서 질문하세요.`;
          break;
        }
        const verdict = judge(command, this.host.network(), !!target.windows);
        answer.run = { command, reason: verdict.reason, status: verdict.action === "block" ? "blocked" : verdict.action === "auto" && this.runMode === "auto" ? "auto" : "approve" };
        // Only the answer turn changed (its run card) — update that one row, not
        // the whole conversation.
        this.updateTurn(answer);
        let result: string;
        let output: Turn["output"] | undefined;
        if (answer.run.status === "blocked") {
          result = `The command was blocked by the engineer's policy (${verdict.reason}) and did not run. Do not try to work around it.`;
        } else if (answer.run.status === "approve" && !(await this.approve())) {
          answer.run.status = "skipped";
          result = "The engineer chose not to run this command. Continue without it, or explain what you would need.";
        } else if (this.stopped) {
          answer.run.status = "skipped";
          break;
        } else {
          answer.run.status = "running";
          this.updateTurn(answer);
          try {
            const r = await this.host.run(command, `AI · ${verdict.reason}`);
            answer.run.status = "done";
            output = { command, text: r.output, timedOut: r.timedOut };
            result = `Output of \`${command}\`${r.timedOut ? " (it did not finish within 30 s and was stopped with Ctrl+C)" : ""}:\n\`\`\`\n${clampForAi(r.output) || "(no output)"}\n\`\`\``;
          } catch (err) {
            answer.run.status = "failed";
            result = `The command could not run: ${errorText(err)}`;
          }
        }
        if (myRun !== this.runSeq) return;
        this.turns.push({ role: "user", shown: result, sent: mask(result), output });
        this.draw();
        if (this.stopped) break;
      }
    } finally {
      // Only the active run cleans up. A run abandoned by a new conversation or
      // provider switch (runSeq moved on) must not clear a newer run's busy flag
      // or write its turns; that run already reset the state itself.
      const active = myRun === this.runSeq;
      // Send a queued interjection when the run finished on its own, or was
      // stopped only to make room for it (지금 보내기); a plain stop cleared it.
      const resume = active && !this.disposed && !!this.queued && (!this.stopped || this.interrupting);
      this.interrupting = false;
      if (active) {
        this.busy = false;
        this.approval = null;
        // When disposed, dispose() has already saved; persisting here would write
        // stale turns over a conversation that may have been reopened for the same
        // connection, so skip it (the panel is gone, nothing to draw).
        if (!this.disposed) {
          this.persist();
          this.draw();
        }
      }
      if (resume) this.dequeue();
    }
  }

  private busy = false;
  private disposed = false;
  /** Bumped per run; a new conversation or provider switch bumps it to abandon
   * an in-flight run so it stops writing into the fresh conversation. */
  private runSeq = 0;

  dispose() {
    // Closing the panel must end the whole agent run, not just the current
    // request: stop() sets the stopped flag, cancels the stream and answers any
    // waiting approval "no", so the loop cannot auto-run further commands or
    // keep talking to the provider with no visible panel.
    this.disposed = true;
    this.stop();
    this.persist();
    this.el.remove();
  }
}

/** The command bar: describe a task, get one command for the input line. */
export function commandBar(container: HTMLElement, host: AiHost, initial = ""): void {
  container.querySelector(".ai-bar")?.remove();
  const p0 = currentProvider();
  const bar = h(
    "div",
    { class: "ai-bar" },
    `<div class="ai-bar-row">${icon("Sparkles", 15)}<input placeholder="할 일을 적으세요 (예: 최근 1시간 동안의 에러 로그)" spellcheck="false" />
      <button class="btn btn-sm btn-primary" data-go>${icon("WandSparkles", 13)}명령 만들기</button>
      <button class="tool" data-x title="닫기 (Esc)">${icon("X", 14)}</button></div>
    <div class="ai-bar-out" hidden data-i18n-skip></div>`,
  );
  container.append(bar);
  const input = bar.querySelector("input")!;
  const out = bar.querySelector<HTMLElement>(".ai-bar-out")!;
  input.value = initial;
  let asking: Asking | null = null;
  let command = "";
  /** The request the current command answers. */
  let asked = "";
  const close = () => {
    asking?.cancel();
    bar.remove();
    host.focus();
  };
  if (!p0) {
    out.hidden = false;
    noProvider(out, () => {
      out.hidden = true;
      out.innerHTML = "";
      input.focus();
    });
  }
  const insert = () => {
    if (!command) return;
    host.insert(command);
    close();
  };
  const go = async () => {
    const p = currentProvider();
    const task = input.value.trim();
    if (!p) return void openAiSettings();
    if (!task || asking) return;
    asked = input.value;
    const masker = new Masker(!isLocal(p) && state.settings.aiMaskHosts, host.hostNames());
    const sent = isLocal(p) ? task : masker.mask(task);
    if (!(await confirmSend(p, sent, { skip: false }))) return;
    out.hidden = false;
    command = "";
    out.innerHTML = `<div class="ai-wait">${icon("LoaderCircle", 14, "spin")} ${esc(providerLabel(p))}</div>`;
    asking = ask(p, prompts.command(host.target()), [{ role: "user", content: sent }], (sofar) => {
      out.innerHTML = `<div class="ai-text">${esc(masker.unmask(sofar))}</div>`;
    });
    try {
      const answer = masker.unmask(await asking.done);
      const lines = proposedCommands(answer);
      command = lines[0] ?? "";
      const explanation = answer.replace(/```[\s\S]*?```/g, "").trim();
      const r = command ? riskOf(command) : null;
      out.innerHTML = command
        ? `<div class="ai-cmd big${r ? ` risk-${r.action}` : ""}"><code>${esc(command)}</code></div>
           ${lines.length > 1 ? `<div class="muted small">명령이 ${lines.length}줄입니다. 첫 줄만 넣습니다. 나머지는 AI 대화에서 하나씩 넣으세요.</div>` : ""}
           ${r ? `<div class="ai-error"><span>${r.action === "block" ? "차단된 명령이라 입력 줄에 넣지 않습니다" : "위험한 명령입니다. 실행하면 확인 창이 뜹니다"}</span>: <span>${esc(r.note)}</span></div>` : ""}
           <div class="ai-text muted">${esc(explanation)}</div>
           <div class="ai-bar-row end">${r?.action === "block" ? "" : `<button class="btn btn-sm btn-primary" data-insert>${icon("CornerDownLeft", 13)}입력 줄에 넣기 (Enter)</button>`}<button class="btn btn-sm" data-again>${icon("RefreshCw", 13)}다시</button></div>`
        : `<div class="ai-text">${esc(answer)}</div>`;
      if (r?.action === "block") command = "";
    } catch (err) {
      const msg = errorText(err);
      out.innerHTML = `<div class="ai-error">${esc(msg === "CANCELLED" ? "중지했습니다" : msg)}</div>`;
    } finally {
      asking = null;
    }
  };
  bar.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-x]")) close();
    else if (t.closest("[data-go]") || t.closest("[data-again]")) void go();
    else if (t.closest("[data-insert]")) insert();
  });
  bar.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      // Enter makes the command; Enter again (same request) puts it on the line.
      if (asking) return;
      if (command && input.value === asked) insert();
      else void go();
    }
  });
  input.focus();
}
