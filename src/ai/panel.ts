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
import { state } from "../store";
import { errorText, esc, h, toast } from "../ui";
import { tr } from "../i18n";
import { ask, confirmSend, currentProvider, isLocal, Masker, proposedCommands, commandLines, prompts, providerLabel, providers, type AiMessage, type AiProvider, type Asking, type Target } from "./core";

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
}

/** Characters of an attached file sent at most (about 40 k tokens). */
const FILE_LIMIT = 150_000;

async function openAiSettings() {
  const { openSettings } = await import("../settings");
  openSettings("ai");
}

function noProvider(el: HTMLElement) {
  el.innerHTML = `<div class="ai-empty">${icon("Sparkles", 28)}<p>AI를 쓰려면 먼저 설정에서 AI 서비스를 추가하세요.</p>
    <p class="muted small">API 키(Anthropic·OpenAI·Gemini), 구독 CLI(Claude Code·Codex·Gemini CLI), 로컬 LLM(Ollama·LM Studio)을 쓸 수 있습니다.</p>
    <button class="btn btn-primary" data-ai-settings>${icon("Settings", 14)}AI 설정 열기</button></div>`;
  el.querySelector("[data-ai-settings]")!.addEventListener("click", openAiSettings);
}

/** Risk verdict for a command the AI proposed. */
function riskOf(command: string): { action: "block" | "warn"; note: string } | null {
  const hit = findTypedRisk(command);
  return hit ? { action: hit.rule.action, note: hit.rule.note } : null;
}

/** Answer text as HTML: paragraphs, **bold**, `code`, and code blocks whose
 * lines can each be put on the input line. The text is the AI's, shown as is. */
function render(answer: string, insertable = true): string {
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
                    : `<button class="tool" data-insert="${esc(l)}" title="입력 줄에 넣기 (실행하지 않음)">${icon("CornerDownLeft", 13)}</button>`
                }${r?.action === "warn" ? `<span class="ai-risk" title="${esc(r.note)}">${icon("TriangleAlert", 13)}</span>` : ""}</div>`;
              })
              .join("")
          : "";
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

interface Turn {
  role: "user" | "assistant";
  /** As shown (real hosts). */
  shown: string;
  /** As sent (masked for cloud AI). */
  sent: string;
  error?: string;
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

  constructor(
    private host: AiHost,
    private onClose: () => void,
  ) {
    this.el = h(
      "div",
      { class: "ai-panel" },
      `<div class="ai-head">${icon("Sparkles", 15)}<b>AI</b>
        <select class="ai-provider" title="AI 서비스"></select>
        <span class="ai-head-actions">
          <button class="tool" data-act="file" title="파일 분석 (설정·로그)">${icon("FileSearch", 15)}</button>
          <button class="tool" data-act="new" title="새 대화">${icon("MessageSquarePlus", 15)}</button>
          <button class="tool" data-act="close" title="닫기">${icon("X", 15)}</button>
        </span></div>
      <div class="ai-log" data-i18n-skip></div>
      <div class="ai-compose">
        <textarea rows="2" placeholder="질문하거나 할 일을 적으세요 (Enter 보내기, Shift+Enter 줄 바꿈)"></textarea>
        <div class="ai-compose-row">
          <label class="check small"><input type="checkbox" data-attach /><span>선택 영역 첨부</span></label>
          <span class="ai-where muted small"></span>
          <button class="btn btn-sm btn-primary" data-act="send">${icon("Send", 13)}질문하기</button>
        </div>
      </div>`,
    );
    this.log = this.el.querySelector(".ai-log")!;
    this.input = this.el.querySelector("textarea")!;
    this.el.addEventListener("click", (e) => this.click(e));
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.host.focus();
      }
    });
    this.el.querySelector<HTMLSelectElement>(".ai-provider")!.addEventListener("change", (e) => {
      this.providerId = (e.target as HTMLSelectElement).value;
      this.newConversation();
    });
    this.refreshProviders();
    this.draw();
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
    if (!cur) noProvider(this.log);
  }

  private get provider(): AiProvider | null {
    return currentProvider(this.providerId);
  }

  focus() {
    this.input.focus();
  }

  newConversation() {
    this.asking?.cancel();
    this.asking = null;
    this.turns = [];
    this.masker = null;
    this.skip = { skip: false };
    this.system = "chat";
    this.draw();
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
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "close") this.onClose();
    else if (act === "new") this.newConversation();
    else if (act === "send") void (this.asking ? this.stop() : this.send());
    else if (act === "file") void this.analyseFile();
  }

  private stop() {
    this.asking?.cancel();
  }

  private draw() {
    if (!this.provider) return noProvider(this.log);
    if (!this.turns.length) {
      this.log.innerHTML = `<div class="ai-empty small"><p>터미널에서 텍스트를 선택하고 질문하면 함께 보냅니다. 답의 명령은 ${icon("CornerDownLeft", 12)} 버튼으로 입력 줄에 넣을 수 있고, 실행은 직접 Enter로 합니다.</p></div>`;
      return;
    }
    this.log.innerHTML = this.turns
      .map((t) =>
        t.role === "user"
          ? `<div class="ai-msg user">${render(shortened(t.shown), false)}</div>`
          : `<div class="ai-msg assistant">${t.shown ? render(t.shown) : t.error ? "" : `<div class="ai-wait">${icon("LoaderCircle", 14, "spin")}</div>`}${t.error ? `<div class="ai-error">${esc(t.error)}</div>` : ""}</div>`,
      )
      .join("");
    this.log.scrollTop = this.log.scrollHeight;
    const btn = this.el.querySelector<HTMLElement>('[data-act="send"]')!;
    btn.innerHTML = this.asking ? `${icon("Square", 13)}중지` : `${icon("Send", 13)}질문하기`;
  }

  /** Start a conversation that explains `text` (a selection, or the screen). */
  explain(text: string) {
    this.newConversation();
    this.system = "explain";
    // The request shows in the conversation: in the screen language.
    void this.send(`${tr("이 출력의 의미와 원인, 다음 단계를 설명해 주세요.")}\n\n\`\`\`text\n${text}\n\`\`\``, true);
  }

  /** Review a configuration or a log. */
  analyse(text: string, what: "config" | "log", name: string) {
    this.newConversation();
    this.system = what;
    const cut = text.length > FILE_LIMIT ? (what === "log" ? text.slice(-FILE_LIMIT) : text.slice(0, FILE_LIMIT)) : text;
    const n = FILE_LIMIT.toLocaleString();
    const note = text.length > FILE_LIMIT ? tr(what === "log" ? `(마지막 ${n}자만)` : `(처음 ${n}자만)`) : "";
    void this.send(`${tr(what === "config" ? "이 설정을 점검해 주세요" : "이 로그를 분석해 주세요")}: ${name} ${note}\n\n\`\`\`text\n${cut}\n\`\`\``, true);
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
  async send(typed?: string, internal = false) {
    const p = this.provider;
    if (!p) return void openAiSettings();
    if (this.asking) return;
    let text = (typed ?? this.input.value).trim();
    if (!text) return;
    const attach = this.el.querySelector<HTMLInputElement>("[data-attach]")!;
    if (!internal && attach.checked) {
      const sel = this.host.selection();
      if (sel.trim()) text += `\n\n\`\`\`text\n${sel}\n\`\`\``;
      attach.checked = false;
    }
    this.masker ??= new Masker(!isLocal(p) && state.settings.aiMaskHosts, this.host.hostNames());
    const sent = isLocal(p) ? text : this.masker.mask(text);
    if (!(await confirmSend(p, sent, this.masker, this.skip))) return;
    if (typed === undefined) this.input.value = "";
    this.turns.push({ role: "user", shown: text, sent });
    const answer: Turn = { role: "assistant", shown: "", sent: "" };
    this.turns.push(answer);
    const history: AiMessage[] = this.turns.filter((t) => t !== answer && !t.error).map((t) => ({ role: t.role, content: t.sent }));
    const target = this.host.target();
    const system = this.system === "explain" ? prompts.explain(target) : this.system === "chat" ? prompts.chat(target) : prompts.analyse(target, this.system);
    let frame = 0;
    const masker = this.masker;
    this.asking = ask(p, system, history, (sofar) => {
      answer.sent = sofar;
      answer.shown = masker.unmask(sofar);
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), this.draw()));
    });
    this.draw();
    try {
      await this.asking.done;
    } catch (err) {
      const msg = errorText(err);
      answer.error = msg === "CANCELLED" ? "중지했습니다" : msg;
    } finally {
      this.asking = null;
      cancelAnimationFrame(frame);
      this.draw();
    }
  }

  dispose() {
    this.asking?.cancel();
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
    noProvider(out);
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
    if (!(await confirmSend(p, sent, masker, { skip: false }))) return;
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
