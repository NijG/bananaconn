// Built-in text editor for remote files (SFTP/FTP/FTPS), opened from the file
// browser. Reads and writes go through the file tab's connection; a save is
// refused when the file changed on the server since it was opened, and the
// upload replaces the file only once it is complete.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type LanguageSupport, type StreamParser } from "@codemirror/language";
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
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView as CodeView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { api, pickSavePath } from "../api";
import { icon } from "../icons";
import type { Session } from "../model";
import { choiceDialog, errorText, esc, h, toast, setPressed } from "../ui";
import type { StatusInfo, View, ViewState, Workspace } from "../workspace";
import { language, type Language } from "../i18n";
import { subscribe } from "../store";

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
  refreshRemote(): void;
}

const legacy = (p: StreamParser<unknown>) => StreamLanguage.define(p);
function languageFor(name: string): Extension {
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
  return map[ext]?.() ?? [];
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
  private code: CodeView | null = null;
  private bom = false;
  private stamp: [number, number] | null = null;
  /** The document as last loaded or saved, to tell whether there are changes. */
  private savedDoc = "";
  private saving = false;
  private isDirty = false;
  private dirtyTimer = 0;
  private disposed = false;
  private wrap = new Compartment();
  /** CodeMirror's panel words follow a language change without reopening. */
  private phrases = new Compartment();
  private lang = language();
  // Read the language on the next tick: the app applies a new UI language from
  // its own settings listener, which may run after this one.
  private unsubscribe = subscribe("settings", () =>
    setTimeout(() => {
      if (this.disposed || !this.code || language() === this.lang) return;
      this.lang = language();
      this.code.dispatch({ effects: this.phrases.reconfigure(EditorState.phrases.of(cmPhrases())) });
    }),
  );
  private wrapping = false;
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
           <span class="editor-meta muted" data-meta></span>
           <button class="tool" data-act="find" title="찾기·바꾸기 (Ctrl+F)">${icon("Search", 15)}</button>
           <button class="tool" data-act="wrap" title="자동 줄 바꿈">${icon("WrapText", 15)}</button>
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
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "save") this.save(false);
      if (act === "reload") this.reload();
      if (act === "local") this.saveLocal();
      if (act === "find" && this.code) openSearchPanel(this.code);
      if (act === "wrap") this.toggleWrap();
      if (act === "goto" && this.code) gotoLine(this.code);
    });
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

  private recheckDirty() {
    const dirty = !!this.code && this.text() !== this.savedDoc;
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
    meta.textContent = this.code ? `UTF-8${this.bom ? " BOM" : ""} · ${this.code.state.lineBreak === "\r\n" ? "CRLF" : "LF"}` : "";
    setPressed(this.el.querySelector('[data-act="wrap"]'), this.wrapping);
  }

  private async load() {
    this.setState("connecting", "여는 중");
    try {
      const file = await api.remoteReadText(this.owner.remoteId, this.path);
      if (this.disposed) return;
      this.bom = file.bom;
      this.stamp = file.stamp;
      this.mount(file.text);
      this.overlay.hidden = true;
      this.setState("connected", "열림");
    } catch (err) {
      if (this.disposed) return;
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
        EditorState.lineSeparator.of(crlf ? "\r\n" : "\n"),
        this.phrases.of(EditorState.phrases.of(cmPhrases())),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        highlightSelectionMatches(),
        syntaxHighlighting(highlight),
        languageFor(this.name),
        theme,
        this.wrap.of(this.wrapping ? CodeView.lineWrapping : []),
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
        }),
      ],
    });
    this.code?.destroy();
    this.code = new CodeView({ state, parent: this.host });
    this.savedDoc = this.text();
    this.isDirty = false;
    this.renderMeta();
    this.renderPos(state);
    this.ws.changed();
  }

  /** "줄 12, 열 5": where the cursor is, to find the line a device's error names. */
  private renderPos(st: EditorState) {
    const head = st.selection.main.head;
    const line = st.doc.lineAt(head);
    const el = this.el.querySelector<HTMLElement>("[data-pos]");
    if (el) el.textContent = `줄 ${line.number}, 열 ${head - line.from + 1}`;
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
    if (problem) return toast(problem, "warn", 6000);
    this.saving = true;
    const text = this.text();
    try {
      this.stamp = await api.remoteWriteText(this.owner.remoteId, this.path, text, this.bom, this.stamp, force);
      this.savedDoc = text;
      // Edits made while the save was in flight keep the file dirty.
      this.isDirty = this.text() !== text;
      toast(`${this.name} 을(를) 저장했습니다`, "success", 2500);
      this.owner.refreshRemote();
      this.ws.changed();
    } catch (err) {
      const msg = errorText(err);
      if (msg.startsWith("CONFLICT::")) {
        this.saving = false;
        const choice = await choiceDialog({
          title: "서버의 파일이 바뀌었습니다",
          icon: "TriangleAlert",
          message: `<b>${esc(this.name)}</b>을(를) 연 뒤에 다른 곳에서 서버의 파일이 바뀌었습니다.`,
          choices: [
            { value: "reload", label: "내 변경 버리고 다시 읽기" },
            { value: "overwrite", label: "내 내용으로 덮어쓰기", kind: "danger" as const },
          ],
        });
        // Await the forced save/reload so the outer `finally` (which clears
        // `saving`) runs only after it completes — otherwise `saving` is cleared
        // while the forced write is still in flight, allowing a second concurrent
        // write of the same file.
        if (choice === "overwrite") return await this.save(true);
        if (choice === "reload") return await this.reload(true);
        return;
      }
      toast(`저장하지 못했습니다: ${msg}`, "error", 8000);
    } finally {
      this.saving = false;
    }
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
    if (this.connectionProblem()) return toast(this.connectionProblem()!, "warn");
    await this.load();
  }

  private async saveLocal() {
    if (!this.code) return;
    const path = await pickSavePath(this.name);
    if (!path) return;
    try {
      const bom = this.bom ? "﻿" : "";
      await api.saveTextFile(path, bom + this.text());
      toast(`내 PC에 저장했습니다: ${path}`, "success");
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  dispose() {
    this.disposed = true;
    this.unsubscribe();
    clearTimeout(this.dirtyTimer);
    this.code?.destroy();
    this.owner.editorClosed(this);
  }
}
