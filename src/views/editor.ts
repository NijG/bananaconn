// Built-in text editor for remote files (SFTP/FTP/FTPS), opened from the file
// browser. Reads and writes go through the file tab's connection; a save is
// refused when the file changed on the server since it was opened, and the
// upload replaces the file only once it is complete.

import { defaultKeymap, history, historyKeymap, indentWithTab, invertedEffects } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting, type LanguageSupport, type StreamParser } from "@codemirror/language";
import { c, cpp, csharp, dart, java, kotlin, scala } from "@codemirror/legacy-modes/mode/clike";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { go } from "@codemirror/legacy-modes/mode/go";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { r } from "@codemirror/legacy-modes/mode/r";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { gotoLine, highlightSelectionMatches, openSearchPanel, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, StateEffect, StateField, Text, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView as CodeView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightTrailingWhitespace,
  highlightWhitespace,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { api, pickSavePath } from "../api";
import { icon } from "../icons";
import type { Session } from "../model";
import { jsonProblem } from "../jsonCheck";
import { cronProblem } from "../cronCheck";
import { indentOf } from "../indentStyle";
import { interpreterOf, languageOfInterpreter, statusUnitOf, syntaxCheckFor, unitReloadFor } from "../shebang";
import { QUOTE_UNSAFE } from "../shellQuote";
import { choiceDialog, contextMenu, errorText, esc, h, toast, setPressed } from "../ui";
import { lacksExecute, modeOf, SCRIPT_NAME, withExecute } from "../remotePerm";
import type { StatusInfo, View, ViewState, Workspace } from "../workspace";
import { language, onLanguageApplied, tr, userText, type Language } from "../i18n";

/** CodeMirror's own words (find/replace and go-to-line panels). The editor is
 * outside the app's DOM translation, so they are given per language here; the
 * shared dictionary cannot be used ("바꾸기" there means Rename). English is
 * CodeMirror's default. */
const CM_KEYS = ["Find", "Replace", "next", "previous", "all", "match case", "regexp", "by word", "replace", "replace all", "close", "Go to line", "go", "current match", "on line", "replaced $ matches", "replaced match on line $"];
const CM_WORDS: Partial<Record<Language, string[]>> = {
  ko: ["찾기", "바꿀 내용", "다음", "이전", "모두", "대소문자 구분", "정규식", "단어 단위", "바꾸기", "모두 바꾸기", "닫기", "줄로 이동", "이동", "현재 일치 항목", "줄", "일치 항목 $개를 바꿨습니다", "$번째 줄의 일치 항목을 바꿨습니다"],
  de: ["Suchen", "Ersetzen", "weiter", "zurück", "alle", "Groß/Klein", "Regex", "ganzes Wort", "ersetzen", "alle ersetzen", "schließen", "Gehe zu Zeile", "los", "aktueller Treffer", "in Zeile", "$ Treffer ersetzt", "Treffer in Zeile $ ersetzt"],
  es: ["Buscar", "Reemplazar", "siguiente", "anterior", "todo", "mayús./minús.", "regex", "palabra completa", "reemplazar", "reemplazar todo", "cerrar", "Ir a la línea", "ir", "coincidencia actual", "en la línea", "$ coincidencias reemplazadas", "coincidencia de la línea $ reemplazada"],
  fr: ["Rechercher", "Remplacer", "suivant", "précédent", "tout", "respecter la casse", "regex", "mot entier", "remplacer", "tout remplacer", "fermer", "Aller à la ligne", "aller", "correspondance actuelle", "à la ligne", "$ correspondances remplacées", "correspondance de la ligne $ remplacée"],
  ja: ["検索", "置換", "次へ", "前へ", "すべて", "大文字小文字を区別", "正規表現", "単語単位", "置換", "すべて置換", "閉じる", "行へ移動", "移動", "現在の一致", "行", "$ 件を置換しました", "$ 行目の一致を置換しました"],
  vi: ["Tìm", "Thay thế", "tiếp", "trước", "tất cả", "phân biệt hoa thường", "regex", "nguyên từ", "thay thế", "thay thế tất cả", "đóng", "Đi tới dòng", "đi", "kết quả hiện tại", "ở dòng", "đã thay thế $ kết quả", "đã thay thế kết quả ở dòng $"],
  "zh-CN": ["查找", "替换", "下一个", "上一个", "全部", "区分大小写", "正则", "全词匹配", "替换", "全部替换", "关闭", "转到行", "转到", "当前匹配", "行", "已替换 $ 处", "已替换第 $ 行的匹配"],
  "zh-TW": ["尋找", "取代", "下一個", "上一個", "全部", "區分大小寫", "規則運算式", "全字拼寫須符合", "取代", "全部取代", "關閉", "移至行", "移至", "目前符合項目", "行", "已取代 $ 處", "已取代第 $ 行的符合項目"],
};
function cmPhrases(): Record<string, string> {
  const words = CM_WORDS[language()];
  return words ? Object.fromEntries(CM_KEYS.map((k, i) => [k, words[i]])) : {};
}

/** What the editor needs from the file tab that owns the connection. */
export interface EditorHost {
  readonly remoteId: string;
  readonly state: ViewState;
  readonly closed: boolean;
  editorClosed(editor: EditorView): void;
  /** The file was read (true) or could not be (false): its recent-files entry. */
  editorRead(path: string, ok: boolean): void;
  refreshRemote(): void;
  /** An SSH terminal is beside (SFTP): a refused save (a root's file opened
   * as a user) done with sudo there, a saved file checked there. */
  readonly hasShellBeside: boolean;
  /** Permissions can be set on this server (SFTP). */
  readonly canChmod: boolean;
  sudoSave(path: string, text: string, bom: boolean): Promise<void>;
  /** A command about the saved file (a check, a reload) put on that
   * terminal's input line ("{}" the quoted path), `said` told once it is. */
  offerInTerminal(command: string, path: string, sudo: boolean, said: string): void;
  /** Its SFTP login is root's (no sudo needed on that server). */
  readonly asRoot: boolean;
  /** That login's home folder on the server (whose user units "--user" reloads). */
  readonly home: string;
}

const legacy = (p: StreamParser<unknown>) => StreamLanguage.define(p);

/** A line-ending conversion: the separator it sets (EditorView.convertEol). */
const setEol = StateEffect.define<"\n" | "\r\n">();

/** Where the file has a problem (a .json file stops being JSON, jsonProblem;
 * a crontab entry cron refuses, cronProblem), or null: its line
 * tinted and the character there underlined, moved with later edits until
 * the check runs again. */
const setProblem = StateEffect.define<number | null>();
const problemField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (!e.is(setProblem)) continue;
      if (e.value === null) return Decoration.none;
      const doc = tr.state.doc;
      const at = Math.min(e.value, doc.length);
      const line = doc.lineAt(at);
      const marks = [Decoration.line({ class: "cm-problem-line" }).range(line.from)];
      // Not a line's end (an error found at the end of the text).
      if (at < line.to) marks.push(Decoration.mark({ class: "cm-problem" }).range(at, at + 1));
      return Decoration.set(marks, true);
    }
    return deco.map(tr.changes);
  },
  provide: (f) => CodeView.decorations.from(f),
});

/** The backend's own words for a name already in use (new_sftp_file, new_ftp_file). */
const NAME_TAKEN = "같은 이름이 이미 있습니다";

/** Crontabs: /etc/crontab, /etc/cron.d/*, a user's in /var/spool/cron
 * (RHEL) or /var/spool/cron/crontabs (Debian); not at's jobs (atjobs).
 * crontab(5): each entry must end in a newline, or cron does not run it. */
const CRON_FILE = /(?:^|\/)crontab$|\/cron\.d\/[^/]+$|\/var\/spool\/cron\/(?:crontabs\/)?[^/]+$/;
const CRON_CR = "cron 파일의 줄 끝이 CRLF라 명령과 변수 끝에 CR(\\r)이 붙어 작업이 제대로 실행되지 않을 수 있습니다";
const CRON_NO_NEWLINE ="cron 파일의 마지막 줄이 줄바꿈으로 끝나지 않아 마지막 작업이 실행되지 않을 수 있습니다";

/** Told of a script saved with a UTF-8 BOM (EditorView.scriptBOM). */
const SCRIPT_BOM = "이 스크립트는 UTF-8 BOM으로 시작해 리눅스·유닉스에서 #! 줄을 읽지 못해 실행되지 않을 수 있습니다";

/** Told of a script with Windows line endings (EditorView.scriptCR). */
const SCRIPT_CR = "이 스크립트는 줄 끝이 CRLF라 리눅스·유닉스에서 \"bad interpreter: ^M\"으로 실행되지 않을 수 있습니다";
function languageFor(name: string): Extension | null {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (lower === "dockerfile") return legacy(dockerFile);
  if (lower === "cmakelists.txt") return legacy(cmake);
  if (lower === "jenkinsfile") return legacy(groovy);
  // Extension-less Ruby DSL files common in projects.
  if (/^(gemfile|rakefile|vagrantfile|brewfile|podfile|fastfile|guardfile|capfile|berksfile|thorfile)$/.test(lower)) return legacy(ruby);
  if (/^(\.bashrc|\.profile|\.bash_profile|\.zshrc)$/.test(lower)) return legacy(shell);
  const map: Record<string, () => LanguageSupport | Extension> = {
    js: javascript, mjs: javascript, cjs: javascript,
    ts: () => javascript({ typescript: true }), tsx: () => javascript({ typescript: true, jsx: true }), jsx: () => javascript({ jsx: true }),
    json: json, py: python, sql: sql, md: markdown, markdown: markdown,
    html: html, htm: html, css: css, xml: xml, svg: xml, yml: yaml, yaml: yaml,
    sh: () => legacy(shell), bash: () => legacy(shell), zsh: () => legacy(shell),
    conf: () => legacy(nginx), toml: () => legacy(toml),
    ini: () => legacy(properties), properties: () => legacy(properties), env: () => legacy(properties), cfg: () => legacy(properties),
    c: () => legacy(c), h: () => legacy(c),
    cpp: () => legacy(cpp), cc: () => legacy(cpp), cxx: () => legacy(cpp), hpp: () => legacy(cpp), hh: () => legacy(cpp),
    java: () => legacy(java), cs: () => legacy(csharp), kt: () => legacy(kotlin), kts: () => legacy(kotlin), scala: () => legacy(scala), dart: () => legacy(dart),
    go: () => legacy(go), rs: () => legacy(rust), lua: () => legacy(lua),
    groovy: () => legacy(groovy), gradle: () => legacy(groovy),
    pl: () => legacy(perl), pm: () => legacy(perl), rb: () => legacy(ruby),
    ps1: () => legacy(powerShell), psm1: () => legacy(powerShell), psd1: () => legacy(powerShell),
    r: () => legacy(r), cmake: () => legacy(cmake), diff: () => legacy(diff), patch: () => legacy(diff),
  };
  return map[ext]?.() ?? null;
}

/** By name first; for a name that tells nothing, by what the file is:
 * systemd units and yum/dnf repo files (INI-like), a file in an nginx
 * folder (sites-available/default), and a script by its "#!" line
 * (/etc/init.d/app, /usr/local/bin/backup). */
function languageOf(name: string, path: string, text: string): Extension {
  const byName = languageFor(name);
  if (byName) return byName;
  if (/\.(?:service|socket|timer|target|mount|automount|swap|path|slice|repo)$/i.test(name)) return legacy(properties);
  // A "#!" line before the folder: a script kept in /etc/nginx is a script.
  const program = interpreterOf(text.slice(0, text.search(/\r?\n|$/)));
  const languages = { shell: () => legacy(shell), python, perl: () => legacy(perl), ruby: () => legacy(ruby), javascript, lua: () => legacy(lua), r: () => legacy(r), powershell: () => legacy(powerShell) };
  const language = program ? languageOfInterpreter(program) : null;
  if (language) return languages[language]();
  return /\/nginx\//.test(path) && !name.includes(".") ? legacy(nginx) : [];
}

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "#c792ea" },
  { tag: [t.string, t.special(t.string)], color: "#c3e88d" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#f78c6c" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#7a8199", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#82aaff" },
  { tag: [t.propertyName, t.attributeName], color: "#ffcb6b" },
  { tag: [t.typeName, t.className, t.tagName], color: "#f07178" },
  { tag: [t.heading], color: "#f5c518", fontWeight: "bold" },
  { tag: [t.meta, t.processingInstruction], color: "#89ddff" },
]);

const theme = CodeView.theme(
  {
    "&": { height: "100%", backgroundColor: "var(--bg-1, #0f1218)", color: "var(--text, #e6e8ee)", fontSize: "13.5px" },
    ".cm-scroller": { fontFamily: "'Cascadia Mono', Consolas, 'D2Coding', monospace", lineHeight: "1.5" },
    ".cm-gutters": { backgroundColor: "var(--bg-2, #161a23)", color: "var(--muted, #6b7280)", border: "none" },
    ".cm-activeLine": { backgroundColor: "#ffffff08" },
    // Where a .json file stops being JSON, or a crontab's entry is wrong (problemField).
    ".cm-problem-line": { backgroundColor: "color-mix(in srgb, var(--danger) 12%, transparent)" },
    ".cm-problem": { textDecoration: "underline wavy var(--danger)", textUnderlineOffset: "3px" },
    ".cm-activeLineGutter": { backgroundColor: "#ffffff0d" },
    ".cm-cursor": { borderLeftColor: "var(--accent, #f5c518)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "#f5c51833 !important" },
    ".cm-panels": { backgroundColor: "var(--bg-2, #161a23)", color: "var(--text, #e6e8ee)" },
    ".cm-searchMatch": { backgroundColor: "#f5c51840" },
  },
  { dark: true },
);

export class EditorView implements View {
  el: HTMLElement;
  state: ViewState = "connecting";
  /** A file of another tab's connection, not a connection of its own. */
  readonly noConnection = true;
  private code: CodeView | null = null;
  private bom = false;
  /** The BOM as last loaded or saved: taking it out makes the file unsaved. */
  private savedBom = false;
  private stamp: [number, number] | null = null;
  /** The document as last loaded or saved, to tell whether there are changes. */
  private savedDoc = "";
  /** The file's text exactly as read or last written: what a backup copies
   * (after a line-ending conversion not saved yet, `text()` already has the
   * new endings). */
  private savedRaw = "";
  private saving = false;
  private isDirty = false;
  private dirtyTimer = 0;
  private disposed = false;
  private wrap = new Compartment();
  /** CodeMirror's panel words follow a language change without reopening. */
  private phrases = new Compartment();
  /** The line endings saving writes (the file's own, or as converted). */
  private eol = new Compartment();
  // A new UI language in place (its dictionary loaded): CodeMirror's own
  // words, and the line-ending/indent label kept from the page translation,
  // given in it.
  private unsubscribe = onLanguageApplied(() => {
    if (this.disposed || !this.code) return;
    this.code.dispatch({ effects: this.phrases.reconfigure(EditorState.phrases.of(cmPhrases())) });
    this.renderMeta();
  });
  private wrapping = false;
  /** Tabs, spaces and trailing blanks drawn (a YAML file indented with a tab,
   * a Makefile's line that needs one): this PC's choice, kept for the next. */
  private showSpace = (() => {
    try {
      return localStorage.getItem("bx.editorWhitespace") === "1";
    } catch {
      return false;
    }
  })();
  private space = new Compartment();
  /** What Tab indents with: read from the file (indentOf), changed from the
   * "UTF-8 · LF" menu when the guess is wrong ("\t" or 2–8 spaces). */
  private indent = new Compartment();
  private indentText = "  ";
  private host: HTMLElement;
  private overlay: HTMLElement;

  constructor(
    private session: Session,
    private ws: Workspace,
    private owner: EditorHost,
    readonly path: string,
  ) {
    this.el = h(
      "div",
      { class: "view editor-view" },
      `<div class="view-bar">
         <span class="proto-chip" style="--proto:#82aaff">${icon("FileText", 14)}편집</span>
         <span class="view-endpoint" data-i18n-skip title="${esc(path)}">${esc(path)}</span>
         <span class="view-state" data-state></span>
         <div class="view-actions">
           <button type="button" class="editor-meta editor-pos muted" data-act="goto" data-pos title="줄로 이동 (Ctrl+Alt+G)"></button>
           <button type="button" class="editor-meta editor-pos danger-text" data-act="problem" data-problem title="JSON 문법 오류 위치로 이동" hidden></button>
           <button type="button" class="editor-meta editor-pos muted" data-act="eol" data-meta data-i18n-skip></button>
           <button class="tool" data-act="find" title="찾기·바꾸기 (Ctrl+F)">${icon("Search", 15)}</button>
           <button class="tool" data-act="wrap" title="자동 줄 바꿈">${icon("WrapText", 15)}</button>
           <button class="tool" data-act="space" title="공백 문자 보기 (탭·공백·줄 끝 공백)">${icon("Pilcrow", 15)}</button>
           <button class="tool" data-act="changes" title="저장 전 변경 내용 보기">${icon("Columns2", 15)}</button>
           <button class="tool" data-act="across" title="다른 서버의 같은 파일과 비교">${icon("Server", 15)}</button>
           <button class="tool" data-act="backup" title="서버에 백업 사본 만들기 (마지막으로 저장된 내용)">${icon("CopyPlus", 15)}</button>
           <button class="tool" data-act="check" title="저장된 파일을 서버에서 문법 검사 (터미널에 명령 넣기)" hidden>${icon("ShieldCheck", 15)}</button>
           <button class="tool" data-act="reload" title="서버에서 다시 읽기">${icon("RefreshCw", 15)}</button>
           <button class="tool" data-act="local" title="내 PC에 다른 이름으로 저장">${icon("Download", 15)}</button>
           <button class="btn btn-sm btn-primary" data-act="save" title="서버에 저장 (Ctrl+S)">${icon("Save", 14)}<span>저장</span></button>
         </div>
       </div>
       <div class="editor-host"></div>
       <div class="view-overlay" hidden></div>`,
    );
    this.host = this.el.querySelector(".editor-host")!;
    this.overlay = this.el.querySelector(".view-overlay")!;
    this.el.querySelector(".view-actions")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
      const act = b?.dataset.act;
      if (act === "save") this.save(false);
      if (act === "reload") this.reload();
      if (act === "local") this.saveLocal();
      if (act === "find" && this.code) openSearchPanel(this.code);
      if (act === "wrap") this.toggleWrap();
      if (act === "space") this.toggleSpace();
      if (act === "goto" && this.code) gotoLine(this.code);
      if (act === "changes") this.showChanges();
      if (act === "across" && b) void this.compareAcross(b);
      if (act === "backup") void this.backup();
      if (act === "check") this.checkSyntax();
      if (act === "eol" && b) this.eolMenu(b);
      if (act === "problem") this.goToProblem();
    });
    // Pressed from the start, the file read or not (it may fail to open).
    setPressed(this.el.querySelector('[data-act="space"]'), this.showSpace);
    this.load();
  }

  private get name() {
    return this.path.slice(this.path.lastIndexOf("/") + 1);
  }

  title() {
    return `${this.dirty ? "● " : ""}${this.name}`;
  }

  /** The document with the file's own line endings (doc.toString() always uses LF). */
  private text(): string {
    const st = this.code!.state;
    return st.doc.sliceString(0, st.doc.length, st.lineBreak);
  }

  /** Cached: comparing the whole document on every render would cost a full
   * copy of a large file per keystroke. Refreshed shortly after edits stop. */
  get dirty() {
    return this.isDirty;
  }

  /** What saving would change: the document as last loaded or saved against
   * the one being edited, line by line in the comparison window (a server's
   * config file looked over before it is replaced). The sides are named by
   * the file and, in the screen language, which is which. */
  private showChanges() {
    if (!this.code) return;
    const now = this.text();
    if (now === this.savedDoc) return void toast("바뀐 내용이 없습니다", "info");
    void import("../diffView").then((d) =>
      d.openDiff({ title: `${this.name} · ${tr("저장된 내용")}`, text: this.savedDoc }, { title: `${this.name} · ${tr("편집 중")}`, text: now }),
    );
  }

  /** The file on the server now (changed by someone else since it was read)
   * against the one being edited, in the comparison window. Read only: the
   * stamp kept is the one read or saved here, so a save still asks first. */
  private async compareWithServer() {
    if (!this.code) return;
    const problem = this.connectionProblem();
    if (problem) return void toast(problem, "warn", 6000);
    try {
      const file = await api.remoteReadText(this.owner.remoteId, this.path);
      if (this.disposed || !this.code) return;
      const d = await import("../diffView");
      d.openDiff({ title: `${this.name} · ${tr("서버의 현재 내용")}`, text: file.text }, { title: `${this.name} · ${tr("편집 중")}`, text: this.text() });
    } catch (err) {
      toast(`서버의 파일을 읽지 못했습니다: ${errorText(err)}`, "error", 8000);
    }
  }

  /** The same path on another server (one whose file tab is open and
   * connected) against the text being edited: configuration drift between
   * servers seen at once. One server: compared at once; several: chosen. */
  private async compareAcross(anchor: HTMLElement) {
    type Files = { remoteId?: string; state?: ViewState; serverLabel?: string; openPath?: unknown; title?: () => string; isFtp?: boolean };
    // SFTP tabs only: an FTP login's paths may start at its own folder (a
    // chroot) and ignore case, so "the same path" there may be another file.
    const others = this.ws.tabs
      .map((t) => t.view as unknown as Files)
      .filter((v) => v !== (this.owner as unknown) && typeof v.openPath === "function" && !v.isFtp && v.state === "connected" && v.remoteId && v.remoteId !== this.owner.remoteId);
    if (!others.length) return void toast("같은 파일을 읽을 다른 서버가 없습니다. 비교할 서버의 SFTP 탭을 먼저 여세요", "info", 6000);
    // Named as its tab is ("admin@10.0.0.7", or the session's name): two
    // logins to one host are told apart.
    const nameOf = (v: Files) => v.title?.() || v.serverLabel || "";
    const compare = async (v: Files) => {
      if (!this.code) return;
      const server = nameOf(v);
      try {
        const file = await api.remoteReadText(v.remoteId!, this.path);
        if (this.disposed || !this.code) return;
        const d = await import("../diffView");
        d.openDiff({ title: `${server} · ${this.name}`, text: file.text }, { title: `${this.name} · ${tr("편집 중")}`, text: this.text() });
      } catch (err) {
        toast(`${userText(server)}에서 읽지 못했습니다: ${errorText(err)}`, "error", 8000);
      }
    };
    if (others.length === 1) return compare(others[0]);
    const r = anchor.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, [
      { label: "비교할 서버", icon: "Server", heading: true },
      ...others.map((v) => ({ label: nameOf(v), userLabel: true, icon: "FolderLock", action: () => void compare(v) })),
    ]);
  }

  private recheckDirty() {
    // The first line edited: the script warning follows.
    this.renderMeta();
    const dirty = !!this.code && (this.text() !== this.savedDoc || this.bom !== this.savedBom);
    if (dirty !== this.isDirty) {
      this.isDirty = dirty;
      this.ws.changed();
    }
  }

  status(): StatusInfo {
    return {
      protocol: this.session.protocol,
      endpoint: this.path,
      state: this.state,
      detail: this.code ? `${this.code.state.doc.lines}줄 · UTF-8${this.bom ? " (BOM)" : ""}${this.dirty ? " · 저장 안 됨" : ""}` : "",
    };
  }

  closeWarning() {
    return this.dirty ? "저장하지 않은 변경 내용이 있습니다" : null;
  }

  focus() {
    this.code?.focus();
    // Brought to the front: the file may have changed on the server meanwhile
    // (a "sudo cp" run in the terminal, another session).
    void this.checkServerChange();
  }

  private stampCheckedAt = 0;
  private checkingStamp = false;
  /** The change last told about while there were edits: told once. */
  private toldStamp = "";

  /** The file's stamp on the server now against the one read or saved:
   * changed and not edited here, read again (at the same line); changed with
   * edits here, said once, with "discard and read again" one click away (a
   * save would ask first anyway). At most every 3 s. */
  private async checkServerChange() {
    const before = this.stamp;
    if (!this.code || this.disposed || this.saving || this.reading || this.checkingStamp || !before) return;
    if (Date.now() - this.stampCheckedAt < 3000 || this.connectionProblem()) return;
    this.stampCheckedAt = Date.now();
    this.checkingStamp = true;
    try {
      const now = await api.remoteFileStamp(this.owner.remoteId, this.path);
      // Saved or read again meanwhile: that stamp is the one to go by.
      if (this.disposed || this.stamp !== before || this.saving || this.reading) return;
      if (now[0] === before[0] && now[1] === before[1]) return;
      if (!this.dirty) return void (await this.refreshUnedited(before));
      const key = now.join(",");
      if (key === this.toldStamp) return;
      this.toldStamp = key;
      // Changed to just what is being edited (the "sudo cp" of a sudo save
      // run in the terminal): that is the saved text now, nothing to warn of.
      // Saved, read again or closed while it was read: nothing to warn of.
      if ((await this.adoptIfSaved(before)) !== "differs") return;
      // What changed is shown, not acted on: a click here dropping the edits
      // unasked lost work ("다시 읽기" in the bar still asks first).
      toast(`${userText(this.name)}: 서버의 파일이 바뀌었습니다. 저장하면 덮어쓸지 먼저 묻습니다`, "warn", 10_000, { label: "서버 내용과 비교", run: () => void this.compareWithServer() });
    } catch {
      // Not readable now (gone, no connection): the save will say so.
    } finally {
      this.checkingStamp = false;
    }
  }

  /** The file on the server read: when it holds exactly the text and BOM
   * being edited, it is taken as saved (its stamp, no edits pending) and
   * said so: "adopted". "differs" when it holds other text, or the text was
   * edited while it was read; "aborted" when the view moved on meanwhile
   * (saved, read again, closed), whose own outcome stands. */
  private async adoptIfSaved(before: [number, number]): Promise<"adopted" | "differs" | "aborted"> {
    const code = this.code;
    if (!code) return "aborted";
    const doc = code.state.doc;
    let file: { text: string; bom: boolean; stamp: [number, number] };
    try {
      file = await api.remoteReadText(this.owner.remoteId, this.path);
    } catch {
      return "differs";
    }
    if (this.disposed || this.code !== code || this.saving || this.reading || this.stamp !== before) return "aborted";
    if (code.state.doc !== doc || file.text !== this.text() || file.bom !== this.bom) return "differs";
    this.stamp = file.stamp;
    this.toldStamp = "";
    this.savedDoc = file.text;
    this.savedRaw = file.text;
    this.savedBom = file.bom;
    this.isDirty = false;
    this.renderMeta();
    // The file pane's size and time, as after a save made here.
    this.owner.refreshRemote();
    this.ws.changed();
    // A configuration a system service reads (a sudo save is how a root's
    // file gets saved): its check one click away, as after a save here.
    const check = this.syntaxCheck()?.system && this.owner.hasShellBeside;
    toast(
      `${userText(this.name)}: 서버의 파일이 편집한 내용과 같아져 저장된 것으로 표시했습니다`,
      "success",
      check ? 8000 : 5000,
      check ? { label: "문법 검사 넣기", run: () => this.checkSyntax() } : undefined,
    );
    return "adopted";
  }

  layout() {
    this.code?.requestMeasure();
  }

  private setState(s: ViewState, label: string) {
    this.state = s;
    const el = this.el.querySelector<HTMLElement>("[data-state]")!;
    el.textContent = label;
    el.dataset.state = s;
    this.ws.changed();
  }

  private renderMeta() {
    const meta = this.el.querySelector<HTMLElement>("[data-meta]")!;
    // Kept from the page translation (data-i18n-skip): its words given here.
    // The word alone ("공백"), not a "공백 {0}" pattern that other texts
    // starting with it could fall into.
    const indent = this.indentText === "\t" ? tr("탭") : `${tr("공백")} ${this.indentText.length}`;
    meta.textContent = this.code ? `UTF-8${this.bom ? " BOM" : ""} · ${this.code.state.lineBreak === "\r\n" ? "CRLF" : "LF"} · ${indent}` : "";
    // A script that would not run on Linux or Unix: said where its endings are.
    const cr = this.scriptCR();
    const cronCr = this.cronCR();
    const bom = this.scriptBOM();
    meta.classList.toggle("warn", cr || cronCr || bom);
    meta.title = tr(cr ? SCRIPT_CR : cronCr ? CRON_CR : bom ? SCRIPT_BOM : "줄 끝·들여쓰기 바꾸기");
    setPressed(this.el.querySelector('[data-act="wrap"]'), this.wrapping);
    setPressed(this.el.querySelector('[data-act="space"]'), this.showSpace);
    // Shown for a file with a check (a script, sshd_config, nginx) beside a shell.
    const check = this.el.querySelector<HTMLElement>('[data-act="check"]');
    if (check) check.hidden = !this.syntaxCheck();
  }

  /** The file is being read (first or again): the view shown will be replaced. */
  private reading = false;

  private async load() {
    this.setState("connecting", "여는 중");
    this.reading = true;
    try {
      const file = await api.remoteReadText(this.owner.remoteId, this.path);
      this.reading = false;
      if (this.disposed) return;
      this.bom = file.bom;
      this.stamp = file.stamp;
      this.mount(file.text);
      this.overlay.hidden = true;
      this.setState("connected", "열림");
      this.owner.editorRead(this.path, true);
    } catch (err) {
      this.reading = false;
      if (this.disposed) return;
      this.owner.editorRead(this.path, false);
      this.setState("error", "오류");
      this.overlay.hidden = false;
      this.overlay.innerHTML = `<div class="overlay-card">${icon("FileText", 26)}<h3>파일을 열 수 없습니다</h3><p>${esc(errorText(err))}</p></div>`;
    }
  }

  private mount(text: string) {
    // Keep the file's line endings: CodeMirror would otherwise save CRLF files as LF.
    const crlf = (text.match(/\r\n/g)?.length ?? 0) > (text.match(/(?<!\r)\n/g)?.length ?? 0);
    const state = EditorState.create({
      doc: text,
      extensions: [
        this.eol.of(EditorState.lineSeparator.of(crlf ? "\r\n" : "\n")),
        // A conversion (or its undo) sets the separator with the text.
        EditorState.transactionExtender.of((tr) => {
          const e = tr.effects.find((x) => x.is(setEol));
          return e ? { effects: this.eol.reconfigure(EditorState.lineSeparator.of(e.value)) } : null;
        }),
        invertedEffects.of((tr) => tr.effects.filter((x) => x.is(setEol)).map(() => setEol.of(tr.startState.lineBreak as "\n" | "\r\n"))),
        this.phrases.of(EditorState.phrases.of(cmPhrases())),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        highlightSelectionMatches(),
        syntaxHighlighting(highlight),
        languageOf(this.name, this.path, text),
        // Tab indents as the file does: a tab in a Makefile (spaces there
        // are "missing separator") or a tab-indented file, else its spaces.
        this.indent.of(indentUnit.of((this.indentText = indentOf(this.name, text)))),
        theme,
        this.wrap.of(this.wrapping ? CodeView.lineWrapping : []),
        this.space.of(this.showSpace ? [highlightWhitespace(), highlightTrailingWhitespace()] : []),
        problemField,
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (this.save(false), true) },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        CodeView.updateListener.of((u) => {
          if (u.selectionSet || u.docChanged) this.renderPos(u.state);
          if (!u.docChanged) return;
          // An edit makes the file dirty at once; whether undo brought it back
          // to the saved text is checked once typing pauses.
          if (!this.isDirty) {
            this.isDirty = true;
            this.ws.changed();
          }
          clearTimeout(this.dirtyTimer);
          this.dirtyTimer = window.setTimeout(() => this.recheckDirty(), 400);
          // A .json file or a crontab checked again once typing pauses.
          clearTimeout(this.problemTimer);
          this.problemTimer = window.setTimeout(() => this.checkProblem(), 600);
        }),
      ],
    });
    this.code?.destroy();
    this.code = new CodeView({ state, parent: this.host });
    this.savedDoc = this.text();
    this.savedRaw = text;
    // Read anew: a change told about before is past.
    this.toldStamp = "";
    this.savedBom = this.bom;
    this.isDirty = false;
    this.renderMeta();
    this.checkProblem();
    // Told on opening, with the fix one click away (saving is still the user's).
    if (this.scriptCR()) toast(SCRIPT_CR, "warn", 10_000, { label: "LF로 바꾸기", run: () => this.convertEol("\n") });
    else if (this.cronCR()) toast(CRON_CR, "warn", 10_000, { label: "LF로 바꾸기", run: () => this.convertEol("\n") });
    else if (this.scriptBOM()) toast(SCRIPT_BOM, "warn", 10_000, { label: "BOM 빼기", run: () => this.dropBom() });
    else if (CRON_FILE.test(this.path) && this.lacksFinalNewline())
      toast(CRON_NO_NEWLINE, "warn", 10_000, { label: "줄바꿈 넣기", run: () => this.addFinalNewline() });
    else {
      const tabbed = this.yamlTabLines();
      if (tabbed.length) toast(`탭으로 들여쓴 줄이 ${tabbed.length}개 있습니다. YAML은 들여쓰기에 탭을 쓸 수 없습니다`, "warn", 10_000, { label: "첫 줄 보기", run: () => this.showLine(tabbed[0]) });
    }
    this.renderPos(state);
    this.ws.changed();
    // The line asked for before the file was read (once: not again on "다시
    // 읽기"); after the position above, which it moves on from.
    if (this.startLine !== null) {
      const line = this.startLine;
      this.startLine = null;
      this.goToLine(line);
    }
  }

  /** "줄 12, 열 5": where the cursor is, to find the line a device's error names. */
  private renderPos(st: EditorState) {
    const head = st.selection.main.head;
    const line = st.doc.lineAt(head);
    const el = this.el.querySelector<HTMLElement>("[data-pos]");
    if (el) el.textContent = `줄 ${line.number}, 열 ${head - line.from + 1}`;
  }

  /** The line endings, changed for saving: "bad interpreter: ^M" from a
   * script edited on Windows is fixed by LF, a file for Notepad by CRLF.
   * Mixed endings (some lines edited on Windows) become all one kind. The
   * file changes only when the user saves; changed back by the other item. */
  private async eolMenu(anchor: HTMLElement) {
    const code = this.code;
    if (!code) return;
    // A script its owner cannot run yet (a new one made in the file tab):
    // made runnable from here too.
    const mode = await this.scriptMode();
    if (this.disposed || this.code !== code) return;
    const now = code.state.lineBreak;
    // LF lines that still end in a CR (some lines edited on Windows).
    const strayCR = now === "\n" && /\r(?=\n|$)/.test(code.state.doc.sliceString(0, code.state.doc.length, "\n"));
    // CRLF lines with a lone LF inside (a line added on Linux).
    const strayLF = now === "\r\n" && /(?<!\r)\n/.test(code.state.doc.sliceString(0, code.state.doc.length, "\r\n"));
    const trailing = this.trailingBlanks().length;
    const r = anchor.getBoundingClientRect();
    const to = (eol: "\n" | "\r\n") => this.convertEol(eol);
    contextMenu(r.left, r.bottom + 4, [
      { label: "LF로 바꾸기 (리눅스·유닉스)", icon: "WrapText", disabled: now === "\n" && !strayCR, action: () => to("\n") },
      { label: "CRLF로 바꾸기 (Windows)", icon: "WrapText", disabled: now === "\r\n" && !strayLF, action: () => to("\r\n") },
      // Spaces and tabs left at line ends (the ¶ button shows them).
      ...(trailing ? ["-" as const, { label: `줄 끝 공백 지우기 (${trailing}줄)`, icon: "Eraser", action: () => this.trimTrailing() }] : []),
      // The last line has no line break (cron skips such a line).
      ...(this.lacksFinalNewline() ? ["-" as const, { label: "마지막 줄 끝에 줄바꿈 넣기", icon: "CornerDownLeft", action: () => this.addFinalNewline() }] : []),
      // The file starts with a UTF-8 BOM (older Notepad): saved without it.
      ...(this.bom ? ["-" as const, { label: "BOM 빼기", icon: "Eraser", action: () => this.dropBom() }] : []),
      ...(mode !== null && lacksExecute(mode) ? ["-" as const, { label: "실행 권한 주기 (chmod +x)", icon: "Play", action: () => void this.makeExecutable(mode) }] : []),
      // What Tab indents with, when the file's own guess is wrong (a file
      // with few indented lines). YAML never with a tab.
      "-" as const,
      { label: "들여쓰기 (Tab 키)", icon: "WrapText", heading: true },
      ...(/\.ya?ml$/i.test(this.name) ? [] : [{ label: "탭", icon: this.indentText === "\t" ? "Check" : "Circle", action: () => this.setIndent("\t") }]),
      ...[2, 4, 8].map((n) => ({ label: `공백 ${n}칸`, icon: this.indentText === " ".repeat(n) ? "Check" : "Circle", action: () => this.setIndent(" ".repeat(n)) })),
    ]);
  }

  /** Tab indents with `unit` from now on (this editor only; the file's
   * own indentation is read again when it is opened next time). */
  private setIndent(unit: string) {
    const code = this.code;
    if (!code || this.disposed) return;
    this.indentText = unit;
    code.dispatch({ effects: this.indent.reconfigure(indentUnit.of(unit)) });
    this.renderMeta();
  }

  /** The file's mode as the server lists it now, for a script on SFTP
   * (a "#!" first line or a script's name); null otherwise or unknown. */
  private async scriptMode(): Promise<number | null> {
    if (this.session.protocol !== "sftp" || !this.code) return null;
    if (!this.code.state.doc.line(1).text.startsWith("#!") && !SCRIPT_NAME.test(this.name)) return null;
    const dir = this.path.slice(0, this.path.lastIndexOf("/")) || "/";
    try {
      const entry = (await api.remoteList(this.owner.remoteId, dir)).find((e) => e.path === this.path);
      return entry && !entry.isDir && !entry.isLink ? modeOf(entry.perm) : null;
    } catch {
      return null;
    }
  }

  private async makeExecutable(mode: number) {
    const problem = this.connectionProblem();
    if (problem) return void toast(problem, "warn", 6000);
    try {
      await api.remoteOp(this.owner.remoteId, "chmod", this.path, withExecute(mode));
      toast(`실행 권한을 주었습니다 (1개)`, "success", 3000);
      this.owner.refreshRemote();
    } catch (err) {
      toast(`${userText(this.name)} 권한 변경 실패: ${errorText(err)}`, "error", 8000);
    }
  }

  /** One transaction, one undo step: the new lines (a Text, not a string,
   * which the old separator would split) and the separator, set by the
   * effect (eolFollows); undo puts both back (invertedEffects). A stray CR
   * before a line break goes ("\r\r\n" too). */
  private convertEol(eol: "\n" | "\r\n") {
    const code = this.code;
    // The tab closed while the notice was up: nothing to change.
    if (!code || this.disposed) return;
    const lines = this.text().split(/\r*\n/);
    const head = code.state.selection.main.head;
    const length = lines.reduce((n, l) => n + l.length, 0) + lines.length - 1;
    code.dispatch({
      changes: { from: 0, to: code.state.doc.length, insert: Text.of(lines) },
      effects: setEol.of(eol),
      selection: { anchor: Math.min(head, length) },
    });
    this.renderMeta();
    toast(eol === "\n" ? "줄 끝을 LF로 바꿨습니다. 저장하면 서버에 반영됩니다" : "줄 끝을 CRLF로 바꿨습니다. 저장하면 서버에 반영됩니다", "success", 3500);
  }

  /** Each line as the file has it, with where it starts: a CRLF document
   * keeps a lone LF (a line added on Linux) inside one editor line. */
  private *fileLines(): Generator<{ from: number; text: string }> {
    const doc = this.code?.state.doc;
    if (!doc) return;
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      let from = line.from;
      for (const text of line.text.split("\n")) {
        yield { from, text };
        from += text.length + 1;
      }
    }
  }

  /** Spaces and tabs at the ends of lines (before a stray CR too), as
   * changes; none in Markdown, where two of them break the line, nor in
   * a patch, whose blank context lines are a single space. */
  private trailingBlanks(): { from: number; to: number }[] {
    if (/\.(?:md|markdown|diff|patch)$/i.test(this.name)) return [];
    const out: { from: number; to: number }[] = [];
    for (const { from, text } of this.fileLines()) {
      const m = /[ \t]+(?=\r?$)/.exec(text);
      if (m) out.push({ from: from + m.index, to: from + m.index + m[0].length });
    }
    return out;
  }

  /** Where a YAML file's lines with a tab in their indentation start: YAML
   * forbids it ("found character '\t' that cannot start any token"). Blank
   * lines and comments may have one, and so may a block scalar's ("key: |")
   * content past its indentation (a script or a Makefile kept in YAML). */
  private yamlTabLines(): number[] {
    if (!/\.ya?ml$/i.test(this.name)) return [];
    const out: number[] = [];
    // The indentation of the line that opened a block scalar, while in one.
    let block = -1;
    for (const { from, text } of this.fileLines()) {
      const indent = text.search(/[^ ]|$/);
      if (/^\s*\r?$/.test(text)) continue;
      if (block >= 0 && indent > block) continue;
      block = -1;
      if (text[indent] === "\t" && !/^\s*#/.test(text)) out.push(from);
      if (/(?:^|[\s:-])[|>][-+1-9]*[ \t]*(?:#.*)?\r?$/.test(text)) block = indent;
    }
    return out;
  }

  /** The cursor at the start of that line, in view, with tabs and spaces
   * shown for this editor (not kept as the choice for the next). */
  private showLine(pos: number) {
    const code = this.code;
    if (!code || this.disposed || pos > code.state.doc.length) return;
    if (!this.showSpace) this.setSpace(true);
    this.goTo(pos);
  }

  /** The file has text and its last line ends without a line break. */
  private lacksFinalNewline(): boolean {
    const doc = this.code?.state.doc;
    if (!doc || !doc.length) return false;
    // A CRLF file keeps a lone LF inside its last line ("c\n"): ended already.
    const last = doc.line(doc.lines).text;
    return last.length > 0 && !last.endsWith("\n");
  }

  /** A line break after the last line, in the file's own kind (one undo
   * step; the file changes when saved). */
  private addFinalNewline() {
    const code = this.code;
    if (!code || this.disposed || !this.lacksFinalNewline()) return;
    // A Text of two empty lines is one line break in whatever separator the
    // file uses ("\n" inserted into a CRLF file would be a character).
    code.dispatch({ changes: { from: code.state.doc.length, insert: Text.of(["", ""]) } });
    toast("마지막 줄 끝에 줄바꿈을 넣었습니다. 저장하면 서버에 반영됩니다", "success", 3500);
  }

  /** One transaction, one undo step; the cursor stays where it was. */
  private trimTrailing() {
    const code = this.code;
    if (!code || this.disposed) return;
    const changes = this.trailingBlanks();
    if (!changes.length) return;
    code.dispatch({ changes });
    toast(`줄 끝 공백을 지웠습니다 (${changes.length}줄). 저장하면 서버에 반영됩니다`, "success", 3500);
  }

  /** Saved without the UTF-8 BOM from now on (the file changes when saved;
   * "다시 읽기" brings it back). */
  private dropBom() {
    if (!this.code || this.disposed || !this.bom) return;
    this.bom = false;
    this.renderMeta();
    this.recheckDirty();
    // The status bar's "UTF-8 (BOM)" too, dirty before or not.
    this.ws.changed();
    toast("BOM을 뺐습니다. 저장하면 서버에 반영됩니다", "success", 3500);
  }

  /** A script ("#!" first) saved with a UTF-8 BOM: the kernel reads the BOM
   * before "#!" and does not see a script ("#!/bin/sh: not found"). */
  private scriptBOM(): boolean {
    return !!this.code && this.bom && this.code.state.doc.line(1).text.startsWith("#!");
  }

  /** A script ("#!" first) whose first line ends in a CR: Linux and Unix
   * look for "/bin/sh\r" and refuse it ("bad interpreter: ^M"). */
  /** A crontab with CRLF line ends: cron keeps the CR in each command and
   * variable (cronie and Debian's cron read them up to the LF). */
  private cronCR(): boolean {
    return !!this.code && this.code.state.lineBreak === "\r\n" && CRON_FILE.test(this.path);
  }

  private scriptCR(): boolean {
    const st = this.code?.state;
    if (!st) return false;
    const first = st.doc.line(1).text;
    return first.startsWith("#!") && (st.lineBreak === "\r\n" || first.endsWith("\r"));
  }

  /** The ¶ button: the choice is kept for the next editor. */
  private toggleSpace() {
    this.setSpace(!this.showSpace);
    try {
      localStorage.setItem("bx.editorWhitespace", this.showSpace ? "1" : "0");
    } catch {
      // Not kept: this editor still shows it.
    }
  }

  private setSpace(on: boolean) {
    this.showSpace = on;
    this.code?.dispatch({ effects: this.space.reconfigure(on ? [highlightWhitespace(), highlightTrailingWhitespace()] : []) });
    setPressed(this.el.querySelector('[data-act="space"]'), on);
  }

  private toggleWrap() {
    this.wrapping = !this.wrapping;
    this.code?.dispatch({ effects: this.wrap.reconfigure(this.wrapping ? CodeView.lineWrapping : []) });
    this.renderMeta();
  }

  private connectionProblem(): string | null {
    if (this.owner.closed) return "파일 탭이 닫혀 서버에 저장할 수 없습니다. 내 PC에 저장하세요.";
    if (this.owner.state !== "connected") return "파일 탭의 연결이 끊어졌습니다. 다시 연결한 다음 저장하세요.";
    return null;
  }

  private async save(force: boolean): Promise<void> {
    if (!this.code || this.saving) return;
    const problem = this.connectionProblem();
    if (problem) return void toast(problem, "warn", 6000);
    this.saving = true;
    const text = this.text();
    // As written: a "BOM 빼기" while the save is in flight is not saved yet.
    const bom = this.bom;
    try {
      // A broken .json file over the server's: asked first (not again for
      // the overwrite after a conflict, asked about already).
      if (!force && !(await this.jsonSaveOk())) return;
      // The connection may have dropped while the question was up.
      const lost = this.connectionProblem();
      if (lost) return void toast(lost, "warn", 6000);
      this.stamp = await api.remoteWriteText(this.owner.remoteId, this.path, text, bom, this.stamp, force);
      // A change told about earlier is past: the next one is told again.
      this.toldStamp = "";
      this.savedDoc = text;
      this.savedRaw = text;
      this.savedBom = bom;
      // A "#!" line saved now (or taken away): the check button follows.
      this.renderMeta();
      // Edits made while the save was in flight keep the file dirty.
      this.isDirty = this.text() !== text || this.bom !== bom;
      // A unit file: systemd goes on with the old one until it reloads, and
      // the reload is one click from the terminal beside (Enter is the user's).
      const reload = unitReloadFor(this.path, this.owner.home);
      // Then the unit's status (read only), which says "bad-setting" and why
      // once the reloaded file has a mistake: its own unit or the one whose
      // drop-in this is; none for a template or a whole type's drop-ins.
      // A name no quoting keeps whole in every shell ("media-usb\x2ddrive.mount")
      // leaves the status out, so the reload is still offered.
      const unit = statusUnitOf(this.path);
      const status = unit && !QUOTE_UNSAFE(unit.name) ? ` && systemctl ${reload?.system ? "" : "--user "}status --no-pager -- {}` : "";
      if (reload && this.owner.hasShellBeside)
        toast(`${userText(this.name)} 을(를) 저장했습니다. systemd에 반영하려면 daemon-reload가 필요합니다`, "success", 10_000, {
          label: "daemon-reload 넣기",
          run: () =>
            this.owner.offerInTerminal(
              reload.command + status,
              status ? unit!.name : this.path,
              reload.system && !this.owner.asRoot,
              status ? "터미널에 daemon-reload 뒤 유닛 상태를 보는 명령을 넣었습니다. Enter를 눌러 실행하세요" : "터미널에 daemon-reload 명령을 넣었습니다. Enter를 눌러 실행하세요",
            ),
        });
      // A configuration a system service or the boot reads (sshd_config,
      // sudoers, nginx, fstab): its check one click away before the service
      // is restarted, sudo used or the server rebooted.
      else if (this.syntaxCheck()?.system && this.owner.hasShellBeside)
        toast(`${userText(this.name)} 을(를) 저장했습니다`, "success", 8000, { label: "문법 검사 넣기", run: () => this.checkSyntax() });
      else toast(`${userText(this.name)} 을(를) 저장했습니다`, "success", 2500);
      this.owner.refreshRemote();
      this.ws.changed();
    } catch (err) {
      const msg = errorText(err);
      if (msg.startsWith("CONFLICT::")) {
        this.saving = false;
        const choice = await choiceDialog({
          title: "서버의 파일이 바뀌었습니다",
          icon: "TriangleAlert",
          message: `<b data-i18n-skip>${esc(this.name)}</b>을(를) 연 뒤에 다른 곳에서 서버의 파일이 바뀌었습니다.`,
          choices: [
            { value: "reload", label: "내 변경 버리고 다시 읽기" },
            { value: "compare", label: "서버 내용과 비교" },
            { value: "overwrite", label: "내 내용으로 덮어쓰기", kind: "danger" as const },
          ],
        });
        // Looked at before deciding: nothing saved or dropped, the next save
        // asks again. Not awaited: a save started while the server's copy is
        // read would otherwise have its "saving" cleared by this one's finally.
        if (choice === "compare") return void this.compareWithServer();
        // Await the forced save/reload so the outer `finally` (which clears
        // `saving`) runs only after it completes — otherwise `saving` is cleared
        // while the forced write is still in flight, allowing a second concurrent
        // write of the same file.
        if (choice === "overwrite") return await this.save(true);
        if (choice === "reload") return await this.reload(true);
        return;
      }
      // Refused (often a root's file opened as a user): the same text can be
      // put in place with sudo from the SSH terminal beside.
      toast(`저장하지 못했습니다: ${msg}`, "error", 10_000, this.owner.hasShellBeside ? { label: "sudo로 저장…", run: () => this.sudoSave() } : undefined);
    } finally {
      this.saving = false;
    }
  }

  /** Where the file has a problem as last checked (a .json file stops being
   * JSON, a crontab entry cron refuses), and what it is for a crontab; null
   * when there is none, it is not judged, or the file is of neither kind. */
  private problemAt: number | null = null;
  private problemText: string | null = null;
  private problemTimer = 0;

  /** The file checked now (a .json file, a crontab): the place marked in the
   * text and named in the bar ("JSON 오류: 줄 4"), or both cleared. */
  private checkProblem() {
    const code = this.code;
    if (!code || this.disposed) return;
    const json = /\.json$/i.test(this.name);
    const cron = !json && CRON_FILE.test(this.path);
    if (!json && !cron) return;
    const text = code.state.doc.sliceString(0, code.state.doc.length, "\n");
    // /etc/crontab and /etc/cron.d: a user before each command; root's own
    // (and a system one) may start an entry with "-".
    const system = /^\/etc\/(?:crontab$|cron\.d\/)/.test(this.path);
    const found = json ? jsonProblem(text) : cronProblem(text, { system, root: system || /\/var\/spool\/cron\/(?:crontabs\/)?root$/.test(this.path) });
    const at = found === null ? null : typeof found === "number" ? found : found.at;
    this.problemAt = at;
    this.problemText = found !== null && typeof found === "object" ? found.message : null;
    code.dispatch({ effects: setProblem.of(at) });
    const el = this.el.querySelector<HTMLElement>("[data-problem]");
    if (!el) return;
    el.hidden = at === null;
    if (at === null) return;
    const line = code.state.doc.lineAt(at).number;
    el.textContent = json ? `JSON 오류: 줄 ${line}` : `crontab 문제: 줄 ${line}`;
    el.title = this.problemText ?? "JSON 문법 오류 위치로 이동";
  }

  /** A line to show once the file has loaded (a "path:12:" clicked in a terminal). */
  private startLine: number | null = null;

  /** Line `line` (1-based; past the end, the last), its start under the
   * cursor and in view; at once, or once the file has loaded. */
  goToLine(line: number) {
    const code = this.code;
    // Not yet read, or being read again ("다시 읽기"): the new view takes it.
    if (!code || this.reading) {
      this.startLine = line;
      return;
    }
    const doc = code.state.doc;
    this.goTo(doc.line(Math.max(1, Math.min(line, doc.lines))).from);
  }

  /** To the error marked in the text: where its mark is now (edits since the
   * last check have moved it), else its line, else as last checked. */
  private goToProblem() {
    // Edited within the check's pause: checked now, so what is said and
    // where it goes are the text's as it is.
    clearTimeout(this.problemTimer);
    this.checkProblem();
    const code = this.code;
    if (!code || this.problemAt === null) return;
    let at: number | null = null;
    code.state.field(problemField).between(0, code.state.doc.length, (from, to) => {
      // The underlined character, past the line's own (empty) decoration.
      if (from < to) {
        at = from;
        return false;
      }
      at ??= from;
    });
    this.goTo(at ?? this.problemAt);
    // A crontab's problem said in words (the bar names only its line).
    if (this.problemText) toast(this.problemText, "warn", 8000);
  }

  /** The cursor at `pos`, in view. */
  private goTo(pos: number) {
    const code = this.code;
    if (!code || this.disposed) return;
    code.dispatch({ selection: { anchor: Math.min(pos, code.state.doc.length) }, scrollIntoView: true });
    code.focus();
  }

  /** The check this file has (syntaxCheckFor), when a shell is beside to run it in. */
  private syntaxCheck(): ReturnType<typeof syntaxCheckFor> {
    if (!this.code || !this.owner.hasShellBeside) return null;
    // The saved file is what is checked: its own first line, not an edit's.
    return syntaxCheckFor(this.name, this.path, this.savedRaw.slice(0, this.savedRaw.search(/\r?\n|$/)));
  }

  /** The check put on the terminal's input line; it reads the file on the
   * server, so edits not saved yet would not be in it: saved first. */
  private checkSyntax() {
    if (!this.code || this.disposed) return;
    if (this.dirty) return void toast("저장하지 않은 변경 내용이 있습니다. 저장한 뒤 검사하세요", "warn", 5000);
    const check = this.syntaxCheck();
    if (!check) return;
    // "nginx -t" or "apachectl configtest" reads the whole configuration,
    // which reads this file only when it is included (a site in
    // sites-available but not enabled is not).
    const said = check.whole ? `터미널에 ${check.whole} 전체 설정 검사 명령을 넣었습니다. 이 파일은 설정에 포함되어 있을 때만 검사됩니다. Enter를 눌러 실행하세요` : "터미널에 검사 명령을 넣었습니다. Enter를 눌러 실행하세요";
    // Logged in as root: no sudo (a root-only server may have none).
    const sudo = check.sudo && !this.owner.asRoot;
    const only = () => this.owner.offerInTerminal(check.command, this.path, sudo, said);
    if (!check.reload) return only();
    // A service that reads it (nginx, Apache, HAProxy): the check, or the
    // check and then its reload, which runs only if the check passed ("&&").
    const reload = `${sudo ? "sudo " : ""}${check.reload}`;
    // Shown first (from a toast, the tab may be in the background), then measured.
    this.ws.focusView(this);
    const b = this.el.querySelector<HTMLElement>('[data-act="check"]');
    const r = (b && !b.hidden ? b : this.el.querySelector<HTMLElement>(".view-actions")!).getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, [
      { label: "검사만", icon: "ShieldCheck", hint: check.command.replace("{}", this.name), userHint: true, action: only },
      {
        label: "검사 후 통과하면 다시 읽기",
        icon: "RefreshCw",
        hint: check.reload,
        userHint: true,
        action: () => this.owner.offerInTerminal(`${check.command} && ${reload}`, this.path, sudo, "터미널에 검사 후 다시 읽는 명령을 넣었습니다. 검사를 통과해야만 다시 읽습니다. Enter를 눌러 실행하세요"),
      },
    ]);
  }

  /** A copy of the file as last saved (as opened, before any save) beside
   * it on the server: "nginx.conf.bak-20261121-153000", made owner-only
   * before anything is written to it (a config may hold secrets; over FTP,
   * which has no chmod, the server's default). The edits are not in it. */
  private async backup() {
    if (!this.code || this.disposed || this.backingUp) return;
    const problem = this.connectionProblem();
    if (problem) return void toast(problem, "warn", 6000);
    const d = new Date();
    const two = (n: number) => String(n).padStart(2, "0");
    const base = `${this.path}.bak-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
    const id = this.owner.remoteId;
    // Taken now: a save while this runs does not change what is copied.
    const [raw, bom] = [this.savedRaw, this.savedBom];
    this.backingUp = true;
    let made = false;
    let copy = base;
    try {
      // A copy made the same second already there: "-2", "-3"… (never over it).
      for (let n = 2; ; n++) {
        try {
          await api.remoteOp(id, "newfile", copy);
          break;
        } catch (err) {
          if (n > 9 || !errorText(err).includes(NAME_TAKEN)) throw err;
          copy = `${base}-${n}`;
        }
      }
      made = true;
      if (this.owner.canChmod) await api.remoteOp(id, "chmod", copy, "600");
      await api.remoteWriteText(id, copy, raw, bom, null, true);
      toast(`백업 사본을 만들었습니다: ${userText(copy.slice(copy.lastIndexOf("/") + 1))}`, "success", 4000);
      this.owner.refreshRemote();
    } catch (err) {
      // Only a copy this made goes (a name already there is left alone).
      if (made) api.remoteOp(id, "delete", copy).catch(() => {});
      toast(`백업 사본을 만들지 못했습니다: ${errorText(err)}`, "error", 8000);
    } finally {
      this.backingUp = false;
    }
  }
  private backingUp = false;

  /** The file read again because it changed on the server and nothing was
   * edited here: put in only if still nothing was (typed, saved, read again)
   * while it was read; else left, and told on the next return to the tab.
   * A read that fails leaves the editor as it is (no overlay over a good
   * text): the save will say what is wrong. Same line kept. */
  private async refreshUnedited(stamp: [number, number]) {
    const code = this.code;
    if (!code) return;
    const doc = code.state.doc;
    const line = doc.lineAt(code.state.selection.main.head).number;
    let file: Awaited<ReturnType<typeof api.remoteReadText>>;
    try {
      file = await api.remoteReadText(this.owner.remoteId, this.path);
    } catch {
      return;
    }
    const untouched = !this.disposed && this.code === code && code.state.doc === doc && !this.saving && !this.reading && this.stamp === stamp;
    if (!untouched) {
      // Edited (or saved) meanwhile: the warning path, at the next look.
      this.stampCheckedAt = 0;
      return;
    }
    this.bom = file.bom;
    this.stamp = file.stamp;
    this.mount(file.text);
    this.goToLine(line);
    toast(`${userText(this.name)}: 서버에서 바뀐 내용을 다시 읽었습니다`, "info", 4000);
  }

  /** The text as it is now (edits made while the error was up included),
   * put in place with sudo from the SSH terminal beside. */
  private sudoSave() {
    if (!this.code || this.disposed) return;
    void this.owner.sudoSave(this.path, this.text(), this.bom);
  }

  /** A .json file that is not JSON (a comma too many, a quote missing):
   * shown where, or saved as it is when the user says so. JSON with
   * comments and an empty file are not judged. */
  private async jsonSaveOk(): Promise<boolean> {
    const code = this.code;
    if (!code || !/\.json$/i.test(this.name)) return true;
    // One character per line break, as the editor counts positions.
    const at = jsonProblem(code.state.doc.sliceString(0, code.state.doc.length, "\n"));
    if (at === null) return true;
    const line = code.state.doc.lineAt(at);
    const choice = await choiceDialog({
      title: "JSON 문법 오류",
      icon: "TriangleAlert",
      message: `줄 ${line.number}, 열 ${at - line.from + 1}에서 JSON 문법이 맞지 않습니다. 이대로 저장하면 이 파일을 읽는 프로그램이 실패할 수 있습니다.`,
      choices: [
        { value: "show", label: "오류 위치 보기" },
        { value: "save", label: "그대로 저장", kind: "danger" as const },
      ],
    });
    if (choice === "show" && this.code === code) this.goTo(at);
    return choice === "save" && !this.disposed && this.code === code;
  }

  private async reload(skipConfirm = false): Promise<void> {
    if (this.dirty && !skipConfirm) {
      const choice = await choiceDialog({
        title: "다시 읽기",
        icon: "RefreshCw",
        message: "저장하지 않은 변경 내용이 사라집니다.",
        choices: [{ value: "reload", label: "버리고 다시 읽기", kind: "danger" as const }],
      });
      if (choice !== "reload") return;
    }
    if (this.connectionProblem()) return void toast(this.connectionProblem()!, "warn");
    await this.load();
  }

  private async saveLocal() {
    if (!this.code) return;
    const path = await pickSavePath(this.name);
    if (!path) return;
    try {
      const bom = this.bom ? "\uFEFF" : "";
      await api.saveTextFile(path, bom + this.text());
      toast(`내 PC에 저장했습니다: ${userText(path)}`, "success");
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  dispose() {
    this.disposed = true;
    this.unsubscribe();
    clearTimeout(this.dirtyTimer);
    clearTimeout(this.problemTimer);
    this.code?.destroy();
    this.owner.editorClosed(this);
  }
}
