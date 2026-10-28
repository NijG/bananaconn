// Colours and suggestions for the command line typed in a terminal tab.
//
// The line is read from the screen, never from the keys: what the remote
// shell made of them (its own Tab completion, history, line editing) is what
// counts, and a password, which is not echoed, is never seen. Where the
// command starts is learnt from the prompt: the text left of the cursor when
// the first key of a line is typed. When the screen line no longer starts with
// that prompt, nothing is shown. Colours are xterm decorations over the cells:
// the output stream itself is never changed.

import type { IBufferCell, IDecoration, IMarker, ITheme, Terminal } from "@xterm/xterm";
import { candidates, colorSpans, forgetCommand, PROMPT_END, recentCommands, rememberCommand, suggest, type Candidate, type WordKind } from "./cmdLine";
import { findCommandRisk } from "./riskRules";
import { state } from "./store";
import { esc } from "./ui";

const SOURCE_LABEL: Record<Candidate["source"], string> = { history: "실행 기록", snippet: "스니펫", dictionary: "명령 사전", server: "서버" };

interface Cell {
  /** Offset of this cell's text in the line string. */
  off: number;
  row: number;
  col: number;
  width: number;
  /** The remote coloured this cell itself. */
  styled: boolean;
}

export interface TypedLine {
  /** The command as typed so far (after the prompt). */
  text: string;
  /** The screen cells of `text`, in order. */
  cells: Cell[];
  /** The cursor sits after the last typed character. */
  atEnd: boolean;
  /** Where the next character would go. */
  endRow: number;
  endCol: number;
}

export class CmdAssist {
  private prompt: string | null = null;
  /** The last prompt learnt (kept after Enter, for promptNames). */
  private lastPrompt = "";

  /** The prompt learnt last ("" when none yet). */
  knownPrompt(): string {
    return this.prompt ?? this.lastPrompt;
  }

  /** Host and user names the shell or device prompt shows: "root@web1",
   * "[root@web1 ~]#", "router(config)#", "<HUAWEI>", "FGT #". */
  promptNames(): string[] {
    const p = (this.prompt ?? this.lastPrompt).trim();
    if (!p) return [];
    const at = /([\w.-]+)@([\w.-]+)/.exec(p);
    // Generic accounts are words in ordinary text too ("root cause"): only the host then.
    if (at) return /^(root|admin|administrator|user|ubuntu|ec2-user|centos|oracle)$/i.test(at[1]) ? [at[2]] : [at[1], at[2]];
    const device = /^[<[]?([A-Za-z][\w.-]*)/.exec(p);
    return device ? [device[1]] : [];
  }
  /** Decorations on screen, by what they show (row, column, width, colour, text). */
  private marks = new Map<string, { marker: IMarker; deco?: IDecoration }>();
  private frame = 0;
  /** The suggestion shown after the cursor, accepted with → or End. */
  ghost = "";
  /** The candidates list (Ctrl+Space) while it is open. */
  private list: { el: HTMLElement; items: Candidate[]; at: number } | null = null;
  /** Up/Down history recall for shells with no server-side history (AIX, HP-UX,
   * Solaris): the commands (newest first), where we are in them, and the line
   * the user had typed before recall started. */
  private recall: { items: string[]; at: number; stash: string } | null = null;
  private cell: IBufferCell | undefined;
  private disposers: { dispose(): void }[] = [];

  constructor(
    private term: Terminal,
    private host: () => string,
    private device: () => { kind: string; network: boolean } | undefined,
    private theme: () => ITheme,
  ) {
    this.disposers.push(
      term.onWriteParsed(() => this.schedule()),
      term.onResize(() => this.schedule()),
      term.buffer.onBufferChange(() => this.reset()),
    );
    // The list belongs to the focused terminal (another tab, a dialog: closed).
    const blur = () => this.closeList();
    term.textarea?.addEventListener("blur", blur);
    this.disposers.push({ dispose: () => term.textarea?.removeEventListener("blur", blur) });
  }

  private get on(): boolean {
    return state.settings.cmdColor || state.settings.cmdSuggest;
  }

  /** Input that came from the user (typed, pasted, broadcast to this tab). */
  note(data: string) {
    // The prompt is learnt even with colours and suggestions off: the AI's
    // masking uses the names it shows (promptNames).
    if (this.prompt === null && !/^[\r\x03]/.test(data)) this.learn();
    // Enter, Ctrl+C and Ctrl+D end the line; Enter keeps it in the history.
    const end = data.search(/[\r\x03\x04]/);
    if (end >= 0) {
      if (data[end] === "\r") this.remember();
      this.reset();
    }
    if (this.on) this.schedule();
  }

  /** A held Enter went out after all (riskRules confirmation). */
  sent() {
    this.reset();
  }

  private learn() {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return;
    const line = this.logicalLine();
    if (!line) return;
    const at = line.cells.findIndex((c) => c.row === line.cursorRow && c.col >= line.cursorCol);
    const prompt = line.text.slice(0, at < 0 ? line.text.length : line.cells[at].off);
    if (prompt.trim() && PROMPT_END.test(prompt)) this.prompt = this.lastPrompt = prompt;
  }

  private remember() {
    if (!state.settings.cmdSuggest) return;
    const line = this.typed();
    if (line?.text.trim()) rememberCommand(this.host(), line.text);
  }

  private reset() {
    this.prompt = null;
    this.recall = null;
    this.clear();
    this.closeList();
  }

  /** This shell keeps no command history of its own, so Up/Down must recall it
   * here instead of being sent to a server that ignores them. */
  private clientHistory(): boolean {
    if (!state.settings.cmdSuggest) return false;
    const kind = this.device()?.kind;
    return kind === "aix" || kind === "hpux" || kind === "solaris";
  }

  /** Move through this host's history and put the command on the line (clearing
   * it first with Ctrl-U). Returns false when there is nothing to recall, so the
   * arrow key falls through to the server. */
  private recallStep(up: boolean): boolean {
    if (!this.recall) {
      if (!up) return false; // Down with no recall under way: leave the line alone
      const items = recentCommands(this.host());
      if (!items.length) return false;
      this.recall = { items, at: -1, stash: this.typedText() };
    }
    const r = this.recall;
    r.at = up ? Math.min(r.at + 1, r.items.length - 1) : Math.max(r.at - 1, -1);
    const target = r.at < 0 ? r.stash : r.items[r.at];
    // Kill the current line (Ctrl-U, the tty kill character) and type the command.
    this.term.input(`\x15${target}`, true);
    if (r.at < 0) this.recall = null; // back at the original line: recall ends
    return true;
  }

  /** Keys while a suggestion or the candidates list is shown: false when the
   * key was used here, undefined to let it go on as usual. */
  key(e: KeyboardEvent): false | undefined {
    if (e.type !== "keydown") return undefined;
    const plain = !e.altKey && !e.metaKey && !e.shiftKey;
    if (this.list) {
      const l = this.list;
      if (plain && !e.ctrlKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        l.at = (l.at + (e.key === "ArrowDown" ? 1 : l.items.length - 1)) % Math.max(1, l.items.length);
        this.drawList();
        return false;
      }
      if (plain && !e.ctrlKey && (e.key === "Enter" || e.key === "Tab")) {
        // Nothing to pick: the key does what it always does.
        if (!l.items.length) {
          this.closeList();
          return undefined;
        }
        e.preventDefault();
        if (l.items[l.at]) this.take(l.items[l.at].text);
        this.closeList();
        return false;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeList();
        return false;
      }
      // A mistyped command in the history: Shift+Delete removes it.
      if (e.key === "Delete" && e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const c = l.items[l.at];
        if (c?.source === "history" && forgetCommand(c.text)) this.refreshList(this.typed());
        return false;
      }
      // Anything else is typed on; the list follows the line (render).
      return undefined;
    }
    // Up/Down recalls earlier commands on a shell that keeps no history of its
    // own (AIX, HP-UX, Solaris), where the arrow keys otherwise do nothing.
    if (this.clientHistory() && plain && !e.ctrlKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (this.recallStep(e.key === "ArrowUp")) {
        e.preventDefault();
        return false;
      }
    }
    // Any other key ends the recall run, so the next Up starts from the newest.
    if (this.recall && e.key !== "ArrowUp" && e.key !== "ArrowDown") this.recall = null;
    // → or End takes all of the suggestion, Ctrl+→ the next word. It is typed
    // like keys, so broadcast and macro recording see it too.
    if (this.ghost && plain && (e.key === "ArrowRight" || (e.key === "End" && !e.ctrlKey))) {
      e.preventDefault();
      this.term.input(e.ctrlKey ? (/^\s*\S+/.exec(this.ghost)?.[0] ?? this.ghost) : this.ghost, true);
      return false;
    }
    return undefined;
  }

  /** The command typed on the line now ("" when none or unknown). */
  typedText(): string {
    return this.typed()?.text ?? "";
  }

  /** Type the rest of `command` after what is on the line now. */
  private take(command: string) {
    const line = this.typed();
    if (line && command.startsWith(line.text) && command.length > line.text.length) this.term.input(command.slice(line.text.length), true);
  }

  /** Open the candidates list under the typed command. False when there is
   * no typed command line (the key then goes to the remote as usual). */
  openList(): boolean {
    if (!state.settings.cmdSuggest) return false;
    const line = this.typed();
    if (!line || !line.text.trim()) return false;
    this.closeList();
    const el = document.createElement("div");
    el.className = "cmd-list";
    el.setAttribute("role", "listbox");
    // Clicks must not take the focus away from the terminal.
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const i = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i;
      if (i !== undefined && this.list?.items[+i]) {
        this.take(this.list.items[+i].text);
        this.closeList();
      }
    });
    document.body.append(el);
    this.list = { el, items: [], at: 0 };
    this.refreshList(line);
    return true;
  }

  private closeList() {
    this.list?.el.remove();
    this.list = null;
  }

  private refreshList(line: TypedLine | null) {
    const l = this.list;
    if (!l) return;
    if (!line || !line.text.trim()) return this.closeList();
    const prev = l.items[l.at]?.text;
    l.items = candidates(this.host(), line.text, this.device()?.kind, 8);
    l.at = Math.max(0, l.items.findIndex((c) => c.text === prev));
    this.drawList(line);
  }

  private drawList(line = this.typed()) {
    const l = this.list;
    if (!l || !line) return;
    const n = line.text.length;
    // Commands are the user's own data: never translated.
    l.el.innerHTML = l.items.length
      ? l.items
          .map(
            (c, i) =>
              `<div class="cmd-item${i === l.at ? " on" : ""}" role="option" data-i="${i}"><code data-i18n-skip><b>${esc(c.text.slice(0, n))}</b>${esc(c.text.slice(n))}</code><span class="src">${SOURCE_LABEL[c.source]}</span></div>`,
          )
          .join("")
      : `<div class="empty">후보가 없습니다</div>`;
    if (l.items.length) l.el.insertAdjacentHTML("beforeend", `<div class="cmd-hint">↑↓ 고르기 · Enter 입력 · Shift+Del 기록에서 지우기 · Esc 닫기</div>`);
    // Under the start of the typed command (above it near the bottom).
    const screen = this.term.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
    const first = line.cells[0];
    if (!screen || !first) return;
    const cw = screen.width / this.term.cols;
    const ch = screen.height / this.term.rows;
    const row = line.endRow - this.term.buffer.active.viewportY;
    const left = Math.min(screen.left + first.col * cw, window.innerWidth - l.el.offsetWidth - 8);
    const below = screen.top + (row + 1) * ch + 2;
    l.el.style.left = `${Math.max(8, left)}px`;
    l.el.style.top = `${below + l.el.offsetHeight > window.innerHeight - 8 ? screen.top + (line.cells[0].row - this.term.buffer.active.viewportY) * ch - l.el.offsetHeight - 2 : below}px`;
  }

  private schedule() {
    if (this.frame || this.prompt === null) {
      if (this.prompt === null && this.marks.size) this.clear();
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** The cursor's line with wrapped rows joined: its text and cells. */
  private logicalLine(): { text: string; cells: Cell[]; cursorRow: number; cursorCol: number } | null {
    const buf = this.term.buffer.active;
    const cursorRow = buf.baseY + buf.cursorY;
    let y = cursorRow;
    while (y > 0 && buf.getLine(y)?.isWrapped) y--;
    const cells: Cell[] = [];
    let text = "";
    for (let r = y; r < y + 50; r++) {
      const line = buf.getLine(r);
      if (!line) break;
      for (let x = 0; x < this.term.cols; x++) {
        const c = line.getCell(x, this.cell);
        if (!c) break;
        this.cell = c;
        const width = c.getWidth();
        if (width === 0) continue;
        const ch = c.getChars() || " ";
        cells.push({ off: text.length, row: r, col: x, width, styled: !c.isFgDefault() });
        text += ch;
      }
      if (!buf.getLine(r + 1)?.isWrapped) break;
    }
    return { text, cells, cursorRow, cursorCol: buf.cursorX };
  }

  /** The command typed after the learnt prompt, or null when the screen line
   * does not start with it (the screen was cleared, output came in between). */
  typed(): TypedLine | null {
    if (this.prompt === null || this.term.buffer.active.type !== "normal") return null;
    const line = this.logicalLine();
    if (!line || !line.text.startsWith(this.prompt)) return null;
    const from = line.cells.findIndex((c) => c.off >= this.prompt!.length);
    const cells = from < 0 ? [] : line.cells.slice(from);
    let last = cells.length;
    while (last > 0 && line.text[cells[last - 1].off] === " ") last--;
    let cursor = cells.findIndex((c) => c.row > line.cursorRow || (c.row === line.cursorRow && c.col >= line.cursorCol));
    if (cursor < 0) cursor = cells.length;
    const end = Math.max(last, Math.min(cursor, cells.length));
    const used = cells.slice(0, end);
    const text = used.length ? line.text.slice(used[0].off, end < cells.length ? cells[end].off : line.text.length) : "";
    const tail = used[used.length - 1];
    const prev = from > 0 ? line.cells[from - 1] : undefined;
    return {
      text,
      cells: used,
      atEnd: cursor >= last,
      endRow: tail ? tail.row : (prev?.row ?? line.cursorRow),
      endCol: tail ? tail.col + tail.width : prev ? prev.col + prev.width : line.cursorCol,
    };
  }

  private clear() {
    for (const m of this.marks.values()) m.marker.dispose();
    this.marks.clear();
    this.ghost = "";
  }

  private decorate(key: string, row: number, col: number, width: number, color: string, text?: string) {
    const buf = this.term.buffer.active;
    const marker = this.term.registerMarker(row - (buf.baseY + buf.cursorY));
    if (!marker) return;
    const deco = this.term.registerDecoration({ marker, x: col, width, layer: "top", ...(text === undefined ? { foregroundColor: color } : {}) });
    if (deco && text !== undefined) {
      deco.onRender((el) => {
        el.textContent = text;
        el.classList.add("ghost-text");
        el.style.color = color;
        el.style.lineHeight = el.style.height;
        el.style.fontFamily = this.term.options.fontFamily ?? "";
        el.style.fontSize = `${this.term.options.fontSize}px`;
      });
    }
    this.marks.set(key, { marker, deco });
  }

  /** Only the decorations that changed are replaced: a keystroke usually
   * touches the last word and the suggestion, not the whole line. */
  private render() {
    const line = this.typed();
    this.refreshList(line);
    const want: { row: number; col: number; width: number; color: string; text?: string }[] = [];
    const ghost = line?.text ? this.plan(line, want) : "";
    const keys = new Map(want.map((d) => [`${d.row}:${d.col}:${d.width}:${d.color}:${d.text ?? ""}`, d]));
    for (const [key, m] of this.marks) {
      if (!keys.has(key)) {
        m.marker.dispose();
        this.marks.delete(key);
      }
    }
    for (const [key, d] of keys) if (!this.marks.has(key)) this.decorate(key, d.row, d.col, d.width, d.color, d.text);
    this.ghost = ghost;
  }

  /** The decorations a typed line needs (colours, then the suggestion); returns the suggestion. */
  private plan(line: TypedLine, want: { row: number; col: number; width: number; color: string; text?: string }[]): string {
    const t = this.theme();
    const device = this.device();
    if (state.settings.cmdColor) {
      // The prompt is already off the line: no prompt tails to try.
      const risk = findCommandRisk(line.text);
      // The remote colours its own command line (zsh-syntax-highlighting, fish): leave it.
      const own = line.cells.slice(0, line.text.indexOf(" ") < 0 ? line.cells.length : line.text.indexOf(" ")).some((c) => c.styled);
      const colors: Record<WordKind, string | undefined> = {
        cmd: t.green,
        opt: t.cyan,
        str: t.yellow,
        var: t.magenta,
        op: t.brightMagenta,
        path: t.blue,
        num: t.brightBlue,
        comment: t.brightBlack,
        neg: t.magenta,
      };
      const spans = risk ? [{ start: 0, end: line.text.length, color: t.red ?? t.brightRed }] : own ? [] : colorSpans(line.text, !!device?.network).map((s) => ({ ...s, color: colors[s.kind] }));
      const base = line.cells[0]?.off ?? 0;
      for (const s of spans) {
        if (!s.color || !/^#[0-9a-f]{6}$/i.test(s.color)) continue;
        // One decoration per screen row the span covers.
        let run: Cell[] = [];
        const flush = () => {
          if (run.length) want.push({ row: run[0].row, col: run[0].col, width: run[run.length - 1].col + run[run.length - 1].width - run[0].col, color: s.color! });
          run = [];
        };
        for (const c of line.cells) {
          const o = c.off - base;
          if (o < s.start || o >= s.end) continue;
          if (run.length && c.row !== run[0].row) flush();
          run.push(c);
        }
        flush();
      }
    }
    if (state.settings.cmdSuggest && !this.list && line.atEnd && !line.text.endsWith("  ")) {
      const rest = suggest(this.host(), line.text, device?.kind);
      // Only what fits on the row after the cursor; wide characters take two cells.
      let width = 0;
      let shown = "";
      for (const ch of rest) {
        const w = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
        if (line.endCol + width + w > this.term.cols) break;
        width += w;
        shown += ch;
      }
      if (shown && shown === rest) {
        want.push({ row: line.endRow, col: line.endCol, width, color: t.brightBlack ?? "#808080", text: shown });
        return rest;
      }
    }
    return "";
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.clear();
    this.closeList();
    for (const d of this.disposers) d.dispose();
  }
}
