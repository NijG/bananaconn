// Dual-pane file browser for SFTP and FTP sessions: local disk on the left,
// remote server on the right, with a transfer queue at the bottom.

import { api, on, openWithDefaultApp, type FileEntry, type TransferProgress } from "../api";
import { proxyOf } from "../proxy";
import { writeClipboard } from "../clipboard";
import { icon } from "../icons";
import { actionFor, keyHint, withKey } from "../keymap";
import { defaultPort, endpoint, PROTOCOLS, type Session } from "../model";
import { natural } from "../sessionOrder";
import { patchSession, reloadCredentials, state as store, takeSavedSession } from "../store";
import { forgetHostKey } from "../hostKeys";
import { choiceDialog, confirmDialog, contextMenu, errorText, esc, formatBytes, formatDate, h, markTerms, matchesTerms, modal, promptDialog, searchTerms, toast, setPressed, type MenuItem } from "../ui";
import type { StatusInfo, View, ViewState, Workspace } from "../workspace";
import type { EditorHost, EditorView } from "./editor";
import { userText } from "../i18n";
import { hasPendingDiff, openDiff, pendingTitle, takeForDiff, type DiffSide } from "../diffView";

/** The file last taken for a comparison (Pane.fileKey), to tell it from another of the same name. */
let takenKey: string | null = null;
import { notesButton } from "../sessionNotes";

type Side = "local" | "remote";
type ConnectExtra = { password?: string; trustedFingerprint?: string; allowInvalidCert?: boolean; trustedCert?: string };
type SortKey = "name" | "size" | "modified";

interface Job {
  id: string;
  direction: "download" | "upload";
  name: string;
  src: string;
  dest: string;
  isDir: boolean;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  done: number;
  total: number;
  filesDone: number;
  skipped?: number;
  error?: string;
  /** Interrupted by a reconnect: run again on the new connection. */
  requeue?: boolean;
  el: HTMLElement;
}

/** Same rule as the backend's local_component: one safe Windows path component. */
function isSafeLocalName(name: string): boolean {
  if (!name || name === "." || name === ".." || /[\\/:<>"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) return false;
  const stem = name.split(".")[0].trimEnd().toUpperCase();
  // Every Windows device name the backend (local_component) rejects: COM0/LPT0
  // and the superscripts ¹²³, and the console streams CONIN$/CONOUT$.
  return !/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])$/.test(stem);
}

/** The mode an "-rwsr-xr-x" listing string stands for (setuid, setgid and
 * sticky included), or null when there is none. */
function modeOf(perm: string | null): number | null {
  if (!perm || !/^[-dl][-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT]$/.test(perm)) return null;
  let mode = 0;
  [0o4000, 0o2000, 0o1000].forEach((special, i) => {
    const [r, w, x] = perm.slice(1 + 3 * i, 4 + 3 * i);
    const shift = 6 - 3 * i;
    if (r === "r") mode |= 4 << shift;
    if (w === "w") mode |= 2 << shift;
    if ("xst".includes(x)) mode |= 1 << shift;
    if ("sStT".includes(x)) mode |= special;
  });
  return mode;
}

/** Bookmarked remote folders, per server ("sftp://user@host:port", FTP and
 * FTPS as "ftp://…"): a saved session, a quick connection and the SFTP pane
 * of an SSH tab to the same server share them. Kept on this PC. */
const BOOKMARKS = "bx.folderBookmarks";
const MAX_BOOKMARKS = 30;

function bookmarkMap(): Record<string, string[]> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(BOOKMARKS) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    // Only lists of paths survive a damaged or hand-edited entry.
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : []]),
    );
  } catch {
    return {};
  }
}

function folderBookmarks(server: string): string[] {
  return bookmarkMap()[server] ?? [];
}

function saveFolderBookmarks(server: string, paths: string[]) {
  const all = bookmarkMap();
  if (paths.length) all[server] = paths.slice(0, MAX_BOOKMARKS);
  else delete all[server];
  try {
    localStorage.setItem(BOOKMARKS, JSON.stringify(all));
  } catch {
    toast("즐겨찾기를 저장하지 못했습니다", "error");
  }
}

/** A remote file opened in a local app, watched for saves. */
interface EditWatch {
  remote: string;
  local: string;
  name: string;
  /** Last uploaded (or downloaded) modification time. */
  mtime: number;
  /** A newer mtime seen once, uploaded when it is seen again unchanged. */
  pending: number;
  /** The poll's upload in flight; stopping waits for it before releasing the temp file. */
  upload: Promise<void> | null;
  /** "Stop watching" is in progress (dialog open or final upload): the poll keeps out. */
  stopping: boolean;
  /** mtime whose upload last failed (0 = none); reported once, retried each poll. */
  failedAt: number;
}

/** Folders with more entries than this draw only the rows in view (see drawWindow). */
const VIRTUAL_MIN = 300;
/** .file-row height in px, and rows drawn above and below the view. */
const ROW_H = 28;
const MARGIN = 45;
const jobs = new Map<string, { job: Job; view: FilesView }>();
let progressRouted = false;
function routeProgress() {
  if (progressRouted) return;
  progressRouted = true;
  on<TransferProgress>("transfer-progress", (p) => {
    const entry = jobs.get(p.transferId);
    if (!entry) return;
    Object.assign(entry.job, { done: p.done, total: p.total, filesDone: p.filesDone });
    entry.view.renderJob(entry.job);
  });
}

class Pane {
  el: HTMLElement;
  path = "";
  entries: FileEntry[] = [];
  selected = new Set<string>();
  private anchor: string | null = null;
  /** The row the arrow keys move from (the last one clicked or moved to). */
  private cursor: string | null = null;
  private sortKey: SortKey = "name";
  private sortDir = 1;
  private listEl: HTMLElement;
  /** Redraws the visible rows when the list is resized; ended by dispose(). */
  private resizer: ResizeObserver;
  private redrawQueued = false;
  private pathInput: HTMLInputElement;
  private filterInput: HTMLInputElement;
  private filter = "";
  /** The filter's words, as the rows were last picked by them (marked in the names). */
  private filterTerms: string[] = [];
  /** Each load gets a number; only the latest one updates the pane. */
  private loadSeq = 0;
  /** Folder of the newest load request (null once it has finished). */
  private requested: string | null = null;
  private pendingLoads = 0;
  /** Shared by all panes; remembered between sessions. */
  static showHidden = localStorage.getItem("bx.showHidden") === "1";

  constructor(
    readonly side: Side,
    private owner: FilesView,
  ) {
    const remote = side === "remote";
    this.el = h(
      "section",
      { class: `pane pane-${side}`, tabindex: "0" },
      `<header class="pane-head">
         <span class="pane-title">${icon(remote ? "Server" : "HardDrive", 15)}${remote ? "원격 서버" : "내 PC"}</span>
         <div class="pane-tools">
           <button class="tool" data-p="back" title="${esc(withKey("이전 폴더로", "files.back"))}" disabled>${icon("ArrowLeft", 15)}</button>
           <button class="tool" data-p="forward" title="${esc(withKey("다음 폴더로", "files.forward"))}" disabled>${icon("ArrowRight", 15)}</button>
           <button class="tool" data-p="up" title="${esc(withKey("상위 폴더", "files.parent"))}">${icon("ArrowUp", 15)}</button>
           <button class="tool" data-p="home" title="홈 폴더">${icon("House", 15)}</button>
           <button class="tool" data-p="refresh" title="${esc(withKey("새로 고침", "files.refresh"))}">${icon("RefreshCw", 15)}</button>
           <button class="tool" data-p="mkdir" title="새 폴더">${icon("FolderPlus", 15)}</button>
           <button class="btn btn-sm btn-accent" data-p="send" title="${remote ? "선택한 항목을 내 PC로 내려받기" : "선택한 항목을 서버로 올리기"}">
             ${remote ? `${icon("Download", 14)}<span class="btn-label">다운로드</span>` : `<span class="btn-label">업로드</span>${icon("Upload", 14)}`}
           </button>
         </div>
       </header>
       <div class="pane-path">
         <input class="path-input" spellcheck="false" />
         <label class="pane-filter" title="이름으로 거르기">${icon("Search", 13)}<input placeholder="필터" spellcheck="false" /></label>
         <button class="tool" data-p="hidden" title="숨김 파일(.으로 시작) 표시">${icon("Eye", 15)}</button>
         ${remote ? `<button class="tool" data-p="bookmarks" title="즐겨찾는 폴더">${icon("Star", 15)}</button>` : ""}
       </div>
       <div class="file-head" style="--cols:${remote ? "var(--cols-remote)" : "var(--cols-local)"}">
         <button data-sort="name">이름</button><button data-sort="size">크기</button>
         <button data-sort="modified">수정한 날짜</button>${remote ? "<span>권한</span>" : ""}
       </div>
       <div class="file-list" style="--cols:${remote ? "var(--cols-remote)" : "var(--cols-local)"}"></div>
       <footer class="pane-foot"></footer>`,
    );
    this.listEl = this.el.querySelector(".file-list")!;
    const redraw = () => {
      if (this.rows.length <= VIRTUAL_MIN || this.redrawQueued) return;
      this.redrawQueued = true;
      requestAnimationFrame(() => {
        this.redrawQueued = false;
        if (this.rows.length > VIRTUAL_MIN) this.drawWindow();
      });
    };
    this.listEl.addEventListener("scroll", redraw, { passive: true });
    this.resizer = new ResizeObserver(redraw);
    this.resizer.observe(this.listEl);
    this.pathInput = this.el.querySelector(".path-input")!;
    this.filterInput = this.el.querySelector(".pane-filter input")!;
    this.syncHiddenButton();
    this.wire();
  }

  private sep() {
    return this.side === "local" ? "\\" : "/";
  }

  join(dir: string, name: string) {
    const s = this.sep();
    return dir.endsWith(s) || dir === "" ? dir + name : dir + s + name;
  }

  private parent(path: string): string {
    if (this.side === "local") {
      if (/^[A-Za-z]:\\?$/.test(path)) return "";
      const trimmed = path.replace(/\\+$/, "");
      const parent = trimmed.slice(0, trimmed.lastIndexOf("\\"));
      return /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent;
    }
    if (path === "/" || !path.includes("/")) return "/";
    const trimmed = path.replace(/\/+$/, "");
    const parent = trimmed.slice(0, trimmed.lastIndexOf("/"));
    return parent || "/";
  }

  /** The step the newest load request takes (with `requested`). */
  private requestedNav: "back" | "forward" | undefined;
  /** Folders gone through (as a browser's back and forward), newest last. */
  private back: string[] = [];
  private forward: string[] = [];
  /** A listing has been shown (the first load is not a step to go back to). */
  private visited = false;

  /** Back or forward one folder (Alt+Left/Right, the mouse's side buttons). */
  private goBack() {
    const to = this.back[this.back.length - 1];
    if (to !== undefined) void this.load(to, "back");
  }
  private goForward() {
    const to = this.forward[this.forward.length - 1];
    if (to !== undefined) void this.load(to, "forward");
  }

  /** `nav`: a step back or forward through the history (others start a new branch). */
  async load(path: string, nav?: "back" | "forward") {
    // "C:" alone means the current folder of drive C to Windows, while joins
    // would put files in C: — always use the drive's root.
    // One spelling per folder (bookmarks, history and "same folder" compare
    // strings): no trailing separator, except a drive's root or "/".
    if (this.side === "local") path = path.replace(/\\+$/, "").replace(/^([A-Za-z]:)$/, "$1\\");
    else path = path.replace(/\/+$/, "") || "/";
    // The latest request wins: a refresh after an upload or a reconnect must
    // not be dropped because an older listing is still in flight.
    const seq = ++this.loadSeq;
    this.requested = path;
    this.requestedNav = nav;
    this.pendingLoads++;
    this.el.classList.add("busy");
    try {
      const list =
        this.side === "local" ? await api.localList(path) : await api.remoteList(this.owner.remoteId, path);
      if (seq !== this.loadSeq) return;
      this.entries = list;
      // Windows names ignore case: "c:\\users" is the folder shown as "C:\\Users".
      const same = this.side === "local" ? path.toLowerCase() === this.path.toLowerCase() : path === this.path;
      if (!same) {
        this.filter = "";
        this.filterInput.value = "";
      }
      // A refresh of the same folder (after a transfer) keeps the selection.
      if (!same) {
        this.selected.clear();
        this.anchor = null;
        this.cursor = null;
        // A new folder starts at its top, not at the old folder's scroll position.
        this.listEl.scrollTop = 0;
      } else {
        const names = new Set(list.map((e) => e.path));
        for (const p of this.selected) if (!names.has(p)) this.selected.delete(p);
      }
      // History changes only once the folder is shown: a refused or failed
      // step leaves it as it was.
      if (this.visited && !same) {
        if (nav === "back") {
          this.back.pop();
          this.forward.push(this.path);
        } else if (nav === "forward") {
          this.forward.pop();
          this.back.push(this.path);
        } else {
          this.back.push(this.path);
          this.forward = [];
        }
        if (this.back.length > 50) this.back.shift();
      }
      this.visited = true;
      this.path = path;
      this.render();
    } catch (err) {
      if (seq !== this.loadSeq) return;
      toast(errorText(err), "error");
      this.pathInput.value = this.path;
    } finally {
      if (seq === this.loadSeq) this.requested = null;
      if (--this.pendingLoads === 0) this.el.classList.remove("busy");
    }
  }

  /** A listing is on its way: `path` and `entries` are about to change. */
  get loading() {
    return this.pendingLoads > 0;
  }

  /** Reload the folder being shown, or the one being opened right now. */
  refresh() {
    // A refresh while a back or forward step is loading stays that step.
    return this.requested !== null ? this.load(this.requested, this.requestedNav) : this.load(this.path);
  }

  /** Entries after the hidden-file and name filters. */
  private visible(): FileEntry[] {
    // "log 2025" finds "app-2025-10.log", as the session searches match.
    const terms = (this.filterTerms = searchTerms(this.filter));
    return this.entries.filter((e) => (Pane.showHidden || !e.name.startsWith(".")) && matchesTerms(e.name.toLowerCase(), terms));
  }

  /** The star in the remote path bar: bookmark the folder shown (or take it
   * off), and go to any bookmarked folder. */
  private bookmarkMenu() {
    const btn = this.el.querySelector<HTMLElement>('[data-p="bookmarks"]')!;
    const r = btn.getBoundingClientRect();
    const server = this.owner.bookmarkKey;
    const list = folderBookmarks(server);
    const here = this.path;
    const save = (paths: string[]) => {
      saveFolderBookmarks(server, paths);
      setPressed(btn, !!here && paths.includes(here));
    };
    contextMenu(r.left, r.bottom + 4, [
      list.includes(here)
        ? { label: "이 폴더를 즐겨찾기에서 빼기", icon: "X", action: () => save(list.filter((p) => p !== here)) }
        : {
            label: "이 폴더를 즐겨찾기에 추가",
            icon: "Star",
            disabled: !here || list.length >= MAX_BOOKMARKS,
            hint: list.length >= MAX_BOOKMARKS ? `${MAX_BOOKMARKS}개까지` : undefined,
            action: () => save([...list, here]),
          },
      "-",
      ...(list.length
        ? list.map((p) => ({ label: p, icon: "Folder", userLabel: true, action: () => void this.load(p) }))
        : [{ label: "즐겨찾는 폴더가 없습니다", disabled: true }]),
    ]);
  }

  syncHiddenButton() {
    setPressed(this.el.querySelector('[data-p="hidden"]'), Pane.showHidden);
  }

  private sorted(vis: FileEntry[]): FileEntry[] {
    const k = this.sortKey;
    return vis.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      // Natural, locale-aware order (shared with the session tree): "log2"
      // before "log10", Korean and accented names in dictionary order.
      if (k === "name") return natural.compare(a.name, b.name) * this.sortDir;
      const av = a[k] ?? 0;
      const bv = b[k] ?? 0;
      return (av < bv ? -1 : av > bv ? 1 : 0) * this.sortDir;
    });
  }

  render() {
    // Compute the visible set once and reuse it (filter, foot count, sort) — a
    // big folder otherwise filters the whole list several times per render.
    const vis = this.visible();
    // What the filter or hidden-file toggle hides can no longer be selected:
    // it must never be deleted or transferred without being seen.
    const shown = new Set(vis.map((e) => e.path));
    for (const p of [...this.selected]) if (!shown.has(p)) this.selected.delete(p);
    if (this.anchor && !shown.has(this.anchor)) this.anchor = null;
    this.pathInput.value = this.path || (this.side === "local" ? "내 PC (드라이브)" : "/");
    this.el.querySelector<HTMLButtonElement>('[data-p="back"]')!.disabled = !this.back.length;
    this.el.querySelector<HTMLButtonElement>('[data-p="forward"]')!.disabled = !this.forward.length;
    if (this.side === "remote") setPressed(this.el.querySelector('[data-p="bookmarks"]'), !!this.path && folderBookmarks(this.owner.bookmarkKey).includes(this.path));
    this.el.querySelectorAll<HTMLElement>("[data-sort]").forEach((b) => {
      b.classList.toggle("sorted", b.dataset.sort === this.sortKey);
      b.dataset.dir = this.sortDir > 0 ? "asc" : "desc";
    });
    this.rows = this.sorted(vis);
    this.drawn = null;
    if (!this.rows.length) {
      this.listEl.innerHTML = `<div class="file-empty">${icon("FolderOpen", 26)}<p>${this.entries.length ? "조건에 맞는 항목이 없습니다" : "빈 폴더입니다"}</p></div>`;
    } else if (this.rows.length <= VIRTUAL_MIN) {
      this.listEl.innerHTML = this.rows.map((e) => this.rowHtml(e)).join("");
    } else {
      this.drawWindow();
    }
    this.renderFoot(this.entries.length - vis.length);
  }

  private rowHtml(e: FileEntry): string {
    const ico = e.isDir ? (this.path === "" && this.side === "local" ? "HardDrive" : "Folder") : "File";
    return `<div class="file-row${this.selected.has(e.path) ? " selected" : ""}${e.isDir ? " dir" : ""}" draggable="true" data-path="${esc(e.path)}">
          <span class="fname">${icon(ico, 15)}<span data-i18n-skip>${markTerms(e.name, this.filterTerms)}</span>${e.isLink ? `<em>링크</em>` : ""}</span>
          <span class="fsize">${e.isDir ? "" : formatBytes(e.size)}</span>
          <span class="fdate">${formatDate(e.modified)}</span>
          ${this.side === "remote" ? `<span class="fperm">${esc(e.perm ?? "")}</span>` : ""}
        </div>`;
  }

  /** Rows of the current listing in display order. */
  private rows: FileEntry[] = [];
  /** Big folders: the range of rows now in the DOM (null: redraw). */
  private drawn: { first: number; last: number } | null = null;

  /** A folder with thousands of entries draws only the rows in view and a
   * margin around them, between two spacers that keep the scroll height:
   * sorting 5000 entries rebuilt 5000 rows (about 0.4 s) before. */
  private drawWindow() {
    const n = this.rows.length;
    const top = this.listEl.scrollTop;
    const view = this.listEl.clientHeight || 800;
    // A list that just got shorter (filter) may still report the old scroll
    // position for a moment: draw its last screen rather than nothing.
    const vFirst = Math.min(Math.floor(top / ROW_H), Math.max(0, n - Math.ceil(view / ROW_H)));
    const vLast = Math.min(n, Math.ceil((top + view) / ROW_H));
    const d = this.drawn;
    if (d && (vFirst >= d.first + MARGIN / 3 || d.first === 0) && (vLast <= d.last - MARGIN / 3 || d.last === n)) return;
    const first = Math.max(0, vFirst - MARGIN);
    const last = Math.min(n, vLast + MARGIN);
    this.drawn = { first, last };
    this.listEl.innerHTML =
      `<div class="file-spacer" style="height:${first * ROW_H}px"></div>` +
      this.rows.slice(first, last).map((e) => this.rowHtml(e)).join("") +
      `<div class="file-spacer" style="height:${(n - last) * ROW_H}px"></div>`;
  }

  private renderFoot(hidden = this.entries.length - this.visible().length) {
    const files = this.entries.filter((e) => !e.isDir).length;
    const dirs = this.entries.length - files;
    const sel = this.selection();
    const selSize = sel.filter((e) => !e.isDir).reduce((n, e) => n + e.size, 0);
    // The folder's files together (its subfolders' contents are not listed, so not counted).
    const total = files ? this.entries.reduce((n, e) => (e.isDir ? n : n + e.size), 0) : 0;
    this.el.querySelector(".pane-foot")!.textContent = sel.length
      ? `${sel.length}개 선택 · ${formatBytes(selSize)}`
      : `폴더 ${dirs}개 · 파일 ${files}개${hidden ? ` · ${hidden}개 숨김` : ""}${files ? ` · ${formatBytes(total)}` : ""}`;
  }

  selection(): FileEntry[] {
    return this.entries.filter((e) => this.selected.has(e.path));
  }

  private entry(path: string) {
    return this.entries.find((e) => e.path === path);
  }

  private select(path: string, e: MouseEvent) {
    // The sorted order is needed for Shift ranges only (a full sort per click
    // is slow in folders with thousands of entries).
    const order = e.shiftKey && this.anchor ? this.sorted(this.visible()).map((x) => x.path) : [];
    if (e.shiftKey && this.anchor && order.includes(this.anchor)) {
      const [a, b] = [order.indexOf(this.anchor), order.indexOf(path)].sort((x, y) => x - y);
      if (!e.ctrlKey) this.selected.clear();
      order.slice(a, b + 1).forEach((p) => this.selected.add(p));
    } else if (e.ctrlKey) {
      if (this.selected.has(path)) this.selected.delete(path);
      else this.selected.add(path);
      this.anchor = path;
    } else {
      this.selected = new Set([path]);
      this.anchor = path;
    }
    this.cursor = path;
    this.listEl.querySelectorAll<HTMLElement>(".file-row").forEach((r) =>
      r.classList.toggle("selected", this.selected.has(r.dataset.path!)),
    );
    this.renderFoot();
  }

  /** Arrow keys, Home and End: move the selection over the rows as shown
   * (Shift: extend it from the anchor), keeping the row in view. */
  private moveCursor(key: string, extend: boolean) {
    const n = this.rows.length;
    if (!n) return;
    const at = this.cursor ? this.rows.findIndex((r) => r.path === this.cursor) : -1;
    const i =
      key === "Home" ? 0 : key === "End" ? n - 1 : at < 0 ? (key === "ArrowUp" ? n - 1 : 0) : Math.max(0, Math.min(n - 1, at + (key === "ArrowDown" ? 1 : -1)));
    const path = this.rows[i].path;
    if (extend && this.anchor) {
      const a = this.rows.findIndex((r) => r.path === this.anchor);
      const [x, y] = a < 0 ? [i, i] : [Math.min(a, i), Math.max(a, i)];
      this.selected = new Set(this.rows.slice(x, y + 1).map((r) => r.path));
    } else {
      this.selected = new Set([path]);
      this.anchor = path;
    }
    this.cursor = path;
    // Rows are ROW_H high whether all are drawn or only those in view, below
    // the list's own top padding.
    const top = i * ROW_H + (parseFloat(getComputedStyle(this.listEl).paddingTop) || 0);
    if (top < this.listEl.scrollTop) this.listEl.scrollTop = top;
    else if (top + ROW_H > this.listEl.scrollTop + this.listEl.clientHeight) this.listEl.scrollTop = top + ROW_H - this.listEl.clientHeight;
    if (n > VIRTUAL_MIN) this.drawWindow();
    this.listEl.querySelectorAll<HTMLElement>(".file-row").forEach((r) => r.classList.toggle("selected", this.selected.has(r.dataset.path!)));
    this.renderFoot();
  }

  private open(entry: FileEntry) {
    if (entry.isDir) this.load(entry.path);
    // A remote text file opens in the built-in editor.
    else if (this.side === "remote" && entry.size <= EDITOR_MAX) this.owner.openEditor(entry);
    else this.owner.send(this.side, [entry]);
  }

  /** The tab is closing: stop watching the list's size. */
  dispose() {
    this.resizer.disconnect();
  }

  private wire() {
    this.el.querySelector(".pane-tools")!.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-p]")?.dataset.p;
      if (act === "back") this.goBack();
      if (act === "forward") this.goForward();
      if (act === "up") this.load(this.parent(this.path));
      if (act === "home") this.owner.goHome(this.side);
      if (act === "refresh") this.refresh();
      if (act === "mkdir") this.mkdir();
      if (act === "send") {
        const sel = this.selection();
        if (sel.length) this.owner.send(this.side, sel);
        else toast("먼저 전송할 항목을 선택하세요", "warn");
      }
    });
    // Typing in the filter re-renders once the keys pause (big folders).
    let filterTimer = 0;
    this.filterInput.addEventListener("input", () => {
      clearTimeout(filterTimer);
      filterTimer = window.setTimeout(() => {
        this.filter = this.filterInput.value.trim();
        this.render();
      }, 120);
    });
    this.filterInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.filterInput.value) {
        e.stopPropagation();
        this.filterInput.value = "";
        this.filter = "";
        this.render();
      }
    });
    this.el.querySelector('[data-p="bookmarks"]')?.addEventListener("click", () => this.bookmarkMenu());
    this.el.querySelector('[data-p="hidden"]')!.addEventListener("click", () => {
      Pane.showHidden = !Pane.showHidden;
      localStorage.setItem("bx.showHidden", Pane.showHidden ? "1" : "0");
      this.owner.onHiddenToggled();
    });
    this.pathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.load(this.pathInput.value.trim());
      if (e.key === "Escape") this.pathInput.value = this.path;
    });
    this.el.querySelectorAll<HTMLElement>("[data-sort]").forEach((b) =>
      b.addEventListener("click", () => {
        const key = b.dataset.sort as SortKey;
        this.sortDir = this.sortKey === key ? -this.sortDir : 1;
        this.sortKey = key;
        this.render();
      }),
    );
    this.listEl.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".file-row");
      if (row) this.select(row.dataset.path!, e);
      else {
        this.selected.clear();
        this.render();
      }
    });
    this.listEl.addEventListener("dblclick", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".file-row");
      const entry = row && this.entry(row.dataset.path!);
      if (entry) this.open(entry);
    });
    this.listEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const row = (e.target as HTMLElement).closest<HTMLElement>(".file-row");
      if (row && !this.selected.has(row.dataset.path!)) this.select(row.dataset.path!, e);
      this.menu(e.clientX, e.clientY, row ? this.entry(row.dataset.path!) : undefined);
    });
    // The drag carries its origin in its own data type, so nothing depends on
    // a dragend event (lost when the dragged row is re-rendered) and a tab or
    // any other drag can never be mistaken for a file drag.
    const other = this.side === "local" ? "remote" : "local";
    this.listEl.addEventListener("dragstart", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".file-row");
      if (!row) return;
      if (!this.selected.has(row.dataset.path!)) this.select(row.dataset.path!, e);
      e.dataTransfer!.effectAllowed = "copy";
      e.dataTransfer!.setData(this.owner.dragType(this.side), "1");
    });
    const fromOther = (e: DragEvent) => !!e.dataTransfer?.types.includes(this.owner.dragType(other));
    this.el.addEventListener("dragover", (e) => {
      if (fromOther(e)) {
        e.preventDefault();
        this.el.classList.add("drop-target");
      }
    });
    this.el.addEventListener("dragleave", (e) => {
      if (!this.el.contains(e.relatedTarget as Node)) this.el.classList.remove("drop-target");
    });
    this.el.addEventListener("drop", (e) => {
      this.el.classList.remove("drop-target");
      if (!fromOther(e)) return;
      e.preventDefault();
      e.stopPropagation();
      this.owner.send(other, this.owner.pane(other).selection());
    });
    // The mouse's back and forward buttons, as in a browser or Explorer.
    this.el.addEventListener("mouseup", (e) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.button === 3) this.goBack();
      else this.goForward();
    });
    this.el.addEventListener("keydown", (e) => {
      // Keys on a focused button/field belong to that control, not the selection.
      if ((e.target as HTMLElement).closest("input, textarea, select, button")) return;
      const sel = this.selection();
      // Shortcuts of the file list (keymap.ts; the user can change them).
      const act = actionFor(e, "files");
      if (act === "files.refresh") {
        e.preventDefault();
        this.refresh();
      } else if (act === "files.parent") {
        e.preventDefault();
        this.load(this.parent(this.path));
      } else if (act === "files.back" || act === "files.forward") {
        e.preventDefault();
        if (act === "files.back") this.goBack();
        else this.goForward();
      } else if (act === "files.delete" && sel.length) {
        this.remove(sel);
      } else if (act === "files.rename" && sel.length === 1) {
        e.preventDefault();
        this.rename(sel[0]);
      } else if (act === "files.open" && sel.length === 1) {
        this.open(sel[0]);
      } else if (act === "files.selectAll") {
        e.preventDefault();
        this.selected = new Set(this.visible().map((x) => x.path));
        this.render();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        this.moveCursor(e.key, e.shiftKey);
      }
    });
  }

  private menu(x: number, y: number, target?: FileEntry) {
    const sel = this.selection();
    const remote = this.side === "remote";
    // The folder a "cd" in the terminal beside goes to: the one clicked, or
    // the one shown.
    const cdTarget = target?.isDir ? target.path : this.path;
    const term = remote ? this.owner.terminal : undefined;
    contextMenu(x, y, [
      ...(target?.isDir ? [{ label: "열기", icon: "FolderOpen", action: () => this.load(target.path) }] : []),
      ...(remote && target && !target.isDir
        ? [
            { label: "편집", icon: "FileText", hint: "더블클릭", disabled: target.size > EDITOR_MAX, action: () => this.owner.openEditor(target) },
            { label: "내 PC 앱으로 열어 편집", icon: "ExternalLink", hint: "저장하면 자동 업로드", action: () => this.owner.editRemote(target) },
          ]
        : []),
      {
        label: remote ? "내 PC로 다운로드" : "서버로 업로드",
        icon: remote ? "Download" : "Upload",
        disabled: !sel.length,
        action: () => this.owner.send(this.side, sel),
      },
      "-",
      { label: "이름 바꾸기", icon: "Pencil", hint: keyHint("files.rename"), disabled: sel.length !== 1, action: () => this.rename(sel[0]) },
      { label: "경로 복사", icon: "Copy", disabled: !sel.length, action: () => writeClipboard(sel.map((s) => s.path).join("\n")) },
      this.compareItem(sel),
      ...(term?.cdTo && cdTarget
        ? [{ label: "터미널에서 이 폴더로 이동 (cd)", icon: "SquareTerminal", hint: cdTarget.split("/").filter(Boolean).pop() || "/", userHint: true, action: () => term.cdTo?.(cdTarget) }]
        : []),
      ...(remote && this.owner.canChmod ? [{ label: "권한 변경…", icon: "LockKeyhole", hint: "chmod", disabled: !sel.length, action: () => this.chmod(sel) }] : []),
      { label: "새 폴더", icon: "FolderPlus", action: () => this.mkdir() },
      ...(remote ? [{ label: "새 파일", icon: "FilePlus", hint: "편집기로 열기", action: () => void this.newFile() }] : []),
      { label: "새로 고침", icon: "RefreshCw", hint: keyHint("files.refresh"), action: () => this.refresh() },
      "-",
      { label: "삭제", icon: "Trash2", hint: keyHint("files.delete"), danger: true, disabled: !sel.length, action: () => this.remove(sel) },
    ]);
  }

  /** Compare files as text (a configuration backup with the one on the
   * server): two selected here, or one with what was taken before (a file of
   * the other pane or another tab, or a terminal selection; term.compare). */
  private compareItem(sel: FileEntry[]): MenuItem {
    const usable = (sel.length === 1 || sel.length === 2) && sel.every((s) => !s.isDir);
    if (!usable) return { label: "파일 비교", icon: "Columns2", hint: "파일 1~2개 선택", disabled: true };
    const label = sel.length === 2 ? "선택한 두 파일 비교" : hasPendingDiff() ? "담아 둔 내용과 비교" : "비교할 내용으로 담기";
    // Too big to read for it: said here, as "Edit" does, not after a click.
    if (sel.some((s) => s.size > EDITOR_MAX)) return { label, icon: "Columns2", hint: "5MB 이하만", disabled: true };
    return { label, icon: "Columns2", action: () => void this.compare(sel) };
  }

  private async compare(files: FileEntry[]) {
    if (files.length === 2) {
      const [a, b] = await Promise.all(files.map((f) => this.textOf(f)));
      if (a && b) openDiff(a, b);
      return;
    }
    // The file kept already, unchanged since: compared with itself it would
    // only say "the same". Another server at the same address (a tunnel's
    // port) or the file saved since is another one.
    const key = this.fileKey(files[0]);
    if (pendingTitle() === this.titleOf(files[0]) && takenKey === key) return void toast("이미 담아 둔 파일입니다. 비교할 다른 파일을 고르세요", "info");
    const one = await this.textOf(files[0]);
    if (one) takenKey = key;
    if (one) takeForDiff(one, "비교할 첫 파일을 담았습니다. 비교할 다른 파일을 오른쪽 클릭해 \"담아 둔 내용과 비교\"를 고르세요 (터미널의 선택 영역 비교도 됩니다)");
  }

  /** Which file, where, as it is now: the connection, the path, its size and time. */
  private fileKey(e: FileEntry): string {
    return [this.side === "remote" ? this.owner.remoteId : "local", e.path, e.size, e.modified ?? ""].join("\n");
  }

  /** How a comparison names the file: "host:/path" on the server, the path here. */
  private titleOf(entry: FileEntry): string {
    return this.side === "remote" ? `${this.owner.serverLabel}:${entry.path}` : entry.path;
  }

  /** A file as text for the comparison, named by where it is; null (and
   * said why) when it is too big or not text. */
  private async textOf(entry: FileEntry): Promise<DiffSide | null> {
    const refuse = (why: string, kind: "warn" | "error" = "warn") => {
      // Two phrases: the name kept as written, the reason translated.
      toast(`${userText(entry.name)} — ${why}`, kind, 6000);
      return null;
    };
    if (entry.size > EDITOR_MAX) return refuse("5MB보다 큰 파일은 비교할 수 없습니다");
    try {
      const text = this.side === "remote" ? (await api.remoteReadText(this.owner.remoteId, entry.path)).text : await api.readTextFile(entry.path);
      // The local reading decodes whatever it gets: a binary file shows here.
      if (text.includes("\0")) return refuse("텍스트 파일이 아니라 비교할 수 없습니다");
      return { title: this.titleOf(entry), text };
    } catch (err) {
      return refuse(errorText(err), "error");
    }
  }

  private async op(op: string, path: string, target?: string, isDir?: boolean) {
    if (this.side === "local") await api.localOp(op, path, target);
    else await api.remoteOp(this.owner.remoteId, op, path, target, isDir);
  }

  private async mkdir() {
    if (this.side === "local" && !this.path) return toast("드라이브 목록에는 폴더를 만들 수 없습니다", "warn");
    const res = await promptDialog({ title: "새 폴더", label: "폴더 이름", icon: "FolderPlus", confirm: "만들기" });
    if (!res?.value.trim()) return;
    try {
      await this.op("mkdir", this.join(this.path, res.value.trim()));
      await this.refresh();
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  /** An empty file on the server, then opened in the built-in editor. The
   * server creates it only while the name is free: it never overwrites. */
  private async newFile() {
    const res = await promptDialog({ title: "새 파일", label: "파일 이름", icon: "FilePlus", confirm: "만들기" });
    const name = res?.value.trim();
    if (!name) return;
    if (name === "." || name === ".." || name.includes("/") || /[\x00-\x1f]/.test(name)) return toast("쓸 수 없는 이름입니다", "warn");
    // An FTP server may be a Windows one, where names ignore case.
    const key = (n: string) => (this.owner.isFtp ? n.toLowerCase() : n);
    if (this.entries.some((e) => key(e.name) === key(name))) return toast(`같은 이름(${userText(name)})이 이미 있습니다`, "warn");
    const path = this.join(this.path, name);
    try {
      await this.op("newfile", path);
    } catch (err) {
      return toast(errorText(err), "error");
    }
    await this.refresh();
    this.owner.openEditor({ name, path, isDir: false, isLink: false, size: 0, modified: null, perm: null });
  }

  /** Drive roots in the local drive list cannot be renamed or deleted. */
  private inDriveList() {
    return this.side === "local" && this.path === "";
  }

  private async rename(entry: FileEntry) {
    if (this.inDriveList()) return toast("드라이브는 이름을 바꿀 수 없습니다", "warn");
    const res = await promptDialog({ title: "이름 바꾸기", label: "새 이름", value: entry.name, confirm: "바꾸기" });
    const name = res?.value.trim();
    if (!name || name === entry.name) return;
    if (this.side === "local" && !isSafeLocalName(name)) return toast("Windows에서 쓸 수 없는 이름입니다", "warn");
    // Never replace another entry by renaming onto it (Windows names ignore
    // case, but renaming a file to a different case of its own name is fine).
    const key = (n: string) => (this.side === "local" ? n.toLowerCase() : n);
    if (this.entries.some((e) => e.path !== entry.path && key(e.name) === key(name)))
      return toast(`같은 이름(${userText(name)})이 이미 있습니다`, "warn");
    try {
      await this.op("rename", entry.path, this.join(this.parent(entry.path), name));
      await this.refresh();
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  /** chmod on the server (SFTP): one mode for every selected entry, nothing
   * inside a folder. Three digits leave setuid, setgid and sticky as they
   * are (the backend keeps them); four set them too. */
  private chmod(entries: FileEntry[]) {
    const start = modeOf(entries[0].perm) ?? (entries[0].isDir ? 0o755 : 0o644);
    // One entry: its own special bits as the fourth digit. Several: three
    // digits, so each keeps its own (one's setuid is not copied to the rest).
    const startDigits = entries.length === 1 && start & 0o7000 ? 4 : 3;
    const octal = (mode: number, digits: number) => mode.toString(8).padStart(digits, "0");
    const who = [["소유자(u)", 6], ["그룹(g)", 3], ["기타(o)", 0]] as const;
    const what = [["읽기(r)", 4], ["쓰기(w)", 2], ["실행(x)", 1]] as const;
    const m = modal({
      title: "권한 변경",
      icon: "LockKeyhole",
      body: `<form class="form" data-form>
          <p class="muted small">${entries.length === 1 ? `<b data-i18n-skip>${esc(entries[0].name)}</b>` : `<span>${entries.length}개 항목</span> · <span>선택한 항목 모두에 같은 권한을 적용합니다</span>`}</p>
          <table class="chmod-grid">
            <thead><tr><th></th>${what.map(([label]) => `<th>${label}</th>`).join("")}</tr></thead>
            <tbody>${who
              .map(([label, shift]) => `<tr><th>${label}</th>${what.map(([, bit]) => `<td><input type="checkbox" data-bit="${bit << shift}"/></td>`).join("")}</tr>`)
              .join("")}</tbody>
          </table>
          <label class="field chmod-mode"><span>8진수</span><input name="mode" class="mono" inputmode="numeric" maxlength="4" spellcheck="false" autocomplete="off"/></label>
          <p class="muted small">세 자리(755)면 setuid·setgid·sticky 비트는 그대로 두고, 네 자리(4755, 0755)면 함께 바꿉니다. 폴더 안의 항목은 바뀌지 않습니다.</p>
          ${entries.some((e) => e.isLink) ? `<p class="muted small">링크는 링크가 가리키는 대상의 권한이 바뀝니다.</p>` : ""}
        </form>`,
      footer: `<button class="btn" data-close>취소</button><button class="btn btn-primary" data-ok>적용</button>`,
    });
    const form = m.root.querySelector<HTMLFormElement>("[data-form]")!;
    const input = form.querySelector<HTMLInputElement>("[name=mode]")!;
    const boxes = [...form.querySelectorAll<HTMLInputElement>("[data-bit]")];
    const valid = (text: string) => /^[0-7]{3,4}$/.test(text);
    const showBits = (mode: number) => boxes.forEach((b) => (b.checked = (mode & Number(b.dataset.bit)) !== 0));
    // Typed digits tick the boxes; ticking a box rewrites the digits (keeping
    // a typed fourth, special digit).
    input.addEventListener("input", () => {
      const ok = valid(input.value.trim());
      input.classList.toggle("invalid", !ok && input.value.trim() !== "");
      if (ok) showBits(parseInt(input.value.trim(), 8));
    });
    boxes.forEach((b) =>
      b.addEventListener("change", () => {
        const text = input.value.trim();
        // Only a valid fourth digit is kept; anything else falls back to three
        // digits (special bits left as they are), never to a "0…" that clears them.
        const four = valid(text) && text.length === 4;
        const special = four ? parseInt(text, 8) & 0o7000 : 0;
        const bits = boxes.reduce((acc, x) => acc | (x.checked ? Number(x.dataset.bit) : 0), 0);
        input.value = octal(special | bits, four ? 4 : 3);
        input.classList.remove("invalid");
      }),
    );
    input.value = octal(startDigits === 4 ? start : start & 0o777, startDigits);
    showBits(start);
    setTimeout(() => input.select(), 40);
    const submit = async () => {
      const mode = input.value.trim();
      if (!valid(mode)) {
        input.classList.add("invalid");
        return void toast("권한은 8진수 3~4자리로 입력하세요 (예: 755)", "warn");
      }
      m.close();
      let changed = 0;
      for (const e of entries) {
        try {
          await this.op("chmod", e.path, mode);
          changed++;
        } catch (err) {
          toast(errorText(err), "error");
          break;
        }
      }
      if (changed) toast(`권한을 ${mode}(으)로 바꿨습니다`, "success", 2500);
      await this.refresh();
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void submit();
    });
    m.root.querySelector("[data-ok]")!.addEventListener("click", () => void submit());
  }

  private async remove(entries: FileEntry[]) {
    if (this.inDriveList()) return toast("드라이브 전체는 삭제할 수 없습니다", "warn");
    const dirs = entries.filter((e) => e.isDir).length;
    const ok = await confirmDialog({
      title: "삭제",
      message: `${entries.length === 1 ? `<b data-i18n-skip>${esc(entries[0].name)}</b>` : `${entries.length}개 항목`}을(를) 영구히 삭제합니다.${
        dirs ? "<br>폴더는 안의 내용까지 모두 삭제됩니다." : ""
      }<br>${
        // Whole sentences, not "{0}에서 …" with the place filled in: a
        // translated place cannot take the case or article the sentence needs.
        this.side === "remote" ? "서버에서 삭제하며 되돌릴 수 없습니다." : "내 PC에서 삭제하며 되돌릴 수 없습니다."
      }`,
      confirm: "삭제",
      danger: true,
    });
    if (!ok) return;
    for (const e of entries) {
      try {
        await this.op("delete", e.path, undefined, e.isDir);
      } catch (err) {
        toast(errorText(err), "error");
        break;
      }
    }
    await this.refresh();
  }
}

/** Same limit as the backend's built-in editor. */
const EDITOR_MAX = 5 * 1024 * 1024;

export class FilesView implements View, EditorHost {
  el: HTMLElement;
  /** Which server the folder bookmarks belong to (see BOOKMARKS). */
  get bookmarkKey(): string {
    const s = this.session;
    const family = s.protocol === "sftp" ? "sftp" : "ftp";
    // The login the server sees: the credential's user when the session names none.
    const user = s.username || (s.credentialId ? (store.credentials.find((c) => c.id === s.credentialId)?.username ?? "") : "");
    return `${family}://${user}@${s.host.trim().toLowerCase()}:${s.port ?? defaultPort(s.protocol, s.options)}`;
  }
  /** An FTP or FTPS server (its file names may ignore case: a Windows server). */
  get isFtp(): boolean {
    return this.session.protocol === "ftp" || this.session.protocol === "ftps";
  }
  /** The server as a comparison names a file of it ("host:/path"). */
  get serverLabel(): string {
    return this.session.host.trim();
  }
  /** Permissions can be set on this server (SFTP; FTP has no standard command). */
  get canChmod(): boolean {
    return this.session.protocol === "sftp";
  }
  state: ViewState = "connecting";
  remoteId = crypto.randomUUID();
  /** Stable for the view's lifetime (remoteId changes on reconnect). */
  private readonly viewKey = crypto.randomUUID().slice(0, 8);
  /** A password typed at the prompt, saved to the vault once it worked. */
  private pendingCredential: string | null = null;
  /** A key passphrase typed at the prompt, saved to the session's key
   * credential once it opened the key and the login went through. */
  private pendingPassphrase: string | null = null;
  /** Built-in editor tabs using this connection. */
  private editors = new Set<EditorView>();
  /** Files whose editor is being created (CodeMirror still loading). */
  private editorsLoading = new Set<string>();
  private localPane: Pane;
  private remotePane: Pane;
  private remoteHome = "/";
  private localHome = "";
  private queue: Job[] = [];
  /** Jobs queued or running, kept in step with every status change so the
   * counter does not scan the whole queue after each of 500 transfers. */
  private active = 0;
  private running = false;
  private jobsEl: HTMLElement;
  private overlay: HTMLElement;
  private disposed = false;
  private editing: EditWatch[] = [];
  private editTimer = 0;
  private polling = false;
  /** Remote paths whose edit is being prepared (download + open). */
  private opening = new Set<string>();
  /** The session's notes button in the bar. */
  private notes: ReturnType<typeof notesButton>;

  constructor(
    private session: Session,
    private ws: Workspace,
    /** The terminal this was opened beside (an SSH tab's SFTP), for "cd here". */
    readonly terminal?: View & { cdTo?(path: string): void },
  ) {
    routeProgress();
    const p = PROTOCOLS[session.protocol];
    this.el = h(
      "div",
      { class: "view files-view" },
      `<div class="view-bar">
         <span class="proto-chip" style="--proto:${p.color}">${icon(p.icon, 14)}${p.label}</span>
         <span class="view-endpoint" data-i18n-skip>${esc(endpoint(session))}</span>
         <span class="view-state" data-state></span>
         <div class="editing" hidden></div>
         <div class="view-actions">
           <button class="tool" data-act="reconnect" title="다시 연결">${icon("RotateCw", 15)}</button>
         </div>
       </div>
       <div class="panes"></div>
       <section class="transfers collapsed">
         <header><button class="transfers-toggle">${icon("ChevronRight", 14)}<span>전송</span><b data-count>0</b></button>
           <button class="tool" data-clear title="완료된 항목 지우기">${icon("Eraser", 14)}</button></header>
         <div class="transfer-list"></div>
       </section>
       <div class="view-overlay" hidden></div>`,
    );
    this.localPane = new Pane("local", this);
    this.remotePane = new Pane("remote", this);
    const panes = this.el.querySelector(".panes")!;
    panes.append(this.localPane.el, this.remotePane.el);
    this.jobsEl = this.el.querySelector(".transfer-list")!;
    this.jobsEl.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-cancel]");
      const id = btn?.closest<HTMLElement>("[data-job]")?.dataset.job;
      if (id) this.cancelJob(id);
    });
    this.overlay = this.el.querySelector(".view-overlay")!;
    // The saved session's notes, while it has any (sessionNotes.ts).
    this.notes = notesButton(session.id, (s) => this.ws.editHandler?.(s));
    this.el.querySelector(".view-actions")!.prepend(this.notes.el);
    this.el.querySelector('[data-act="reconnect"]')!.addEventListener("click", () => this.reconnect());
    this.el.querySelector(".transfers-toggle")!.addEventListener("click", () =>
      this.el.querySelector(".transfers")!.classList.toggle("collapsed"),
    );
    this.el.querySelector("[data-clear]")!.addEventListener("click", () => {
      this.queue = this.queue.filter((j) => {
        const keep = j.status === "queued" || j.status === "running";
        if (!keep) {
          j.el.remove();
          jobs.delete(j.id);
        }
        return keep;
      });
      this.updateCount();
    });
    void this.init();
  }

  pane(side: Side) {
    return side === "local" ? this.localPane : this.remotePane;
  }

  /** Drag data type naming this view and the pane a file drag started in. */
  dragType(side: Side) {
    return `application/x-bananaconn-files-${this.viewKey}-${side}`;
  }

  closeWarning(): string | null {
    const pending = this.active;
    const dirty = [...this.editors].filter((e) => e.dirty).length;
    const parts = [
      pending ? `전송 ${pending}건이 끝나지 않았습니다` : "",
      this.editing.length ? `내 PC 앱으로 편집 중인 파일 ${this.editing.length}개가 있습니다` : "",
      dirty ? `편집기에 저장하지 않은 파일 ${dirty}개가 있습니다(이 탭을 닫으면 서버에 저장할 수 없습니다)` : "",
    ];
    // " · " between them: the lookup translates each part (not at commas).
    return parts.filter(Boolean).join(" · ") || null;
  }

  // ---- built-in editor ------------------------------------------------------------

  get closed() {
    return this.disposed;
  }

  openEditor(entry: FileEntry) {
    if (this.state !== "connected") return toast("서버에 연결된 다음 열 수 있습니다", "warn");
    const open = [...this.editors].find((e) => e.path === entry.path);
    if (open) return this.ws.focusView(open);
    if (this.editorsLoading.has(entry.path)) return;
    const tabSession: Session = { ...this.session, id: `quick-${crypto.randomUUID()}`, name: entry.name };
    // CodeMirror loads with the first editor.
    this.editorsLoading.add(entry.path);
    import("./editor")
      .then(({ EditorView }) => {
        if (this.disposed) return;
        const editor = new EditorView(tabSession, this.ws, this, entry.path);
        this.editors.add(editor);
        this.ws.add(tabSession, editor);
      }, (err) => toast(errorText(err), "error"))
      .finally(() => this.editorsLoading.delete(entry.path));
  }

  editorClosed(editor: EditorView) {
    this.editors.delete(editor);
  }

  refreshRemote() {
    this.remotePane.refresh();
  }

  // ---- edit remote files in a local app -----------------------------------------

  /**
   * Download a remote file to a private temp folder, open it with its default
   * Windows app, and upload it again whenever it is saved. A save is detected
   * once the modification time changes and then stays put for a second (editors
   * often write in several steps).
   */
  async editRemote(entry: FileEntry) {
    if (this.state !== "connected") return;
    if (this.editing.some((w) => w.remote === entry.path) || this.opening.has(entry.path))
      return toast("이미 편집 중인 파일입니다", "info");
    if (!isSafeLocalName(entry.name)) return toast("Windows에서 쓸 수 없는 파일 이름이라 편집으로 열 수 없습니다", "warn");
    if (entry.size > 50 * 1024 * 1024) return toast("50MB보다 큰 파일은 편집으로 열 수 없습니다. 다운로드하세요.", "warn");
    this.opening.add(entry.path);
    let local = "";
    try {
      local = await api.editTempPath(entry.name);
      await api.transfer({ id: this.remoteId, transferId: crypto.randomUUID(), direction: "download", remotePath: entry.path, localPath: local, isDir: false });
      const [mtime] = await api.localStat(local);
      await openWithDefaultApp(local);
      // Watch only once the editor actually opened; a failed open leaves nothing behind.
      if (this.disposed) throw new Error("탭이 닫혔습니다");
      this.editing.push({ remote: entry.path, local, name: entry.name, mtime, pending: 0, upload: null, stopping: false, failedAt: 0 });
      toast(`${userText(entry.name)} 을(를) 열었습니다. 저장하면 서버에 자동으로 올립니다.`, "success", 5000);
      this.renderEditing();
      this.ensureEditTimer();
    } catch (err) {
      if (local) api.editTempRelease(local).catch(() => {});
      if (!this.disposed) toast(errorText(err), "error");
    } finally {
      this.opening.delete(entry.path);
    }
  }

  private ensureEditTimer() {
    if (this.editTimer || !this.editing.length) return;
    this.editTimer = window.setInterval(() => this.pollEdits(), 1000);
  }

  private async pollEdits() {
    // One poll at a time, and only while connected: uploads resume after a reconnect.
    if (this.polling || this.disposed || this.state !== "connected") return;
    this.polling = true;
    try {
      await this.pollEditsOnce();
    } finally {
      this.polling = false;
    }
  }

  private async pollEditsOnce() {
    for (const w of [...this.editing]) {
      if (this.disposed || this.state !== "connected") return;
      if (w.upload || w.stopping || !this.editing.includes(w)) continue;
      let mtime: number;
      try {
        [mtime] = await api.localStat(w.local);
      } catch {
        continue; // file briefly missing while an editor replaces it
      }
      if (mtime === w.mtime) {
        w.pending = 0;
        continue;
      }
      // Wait for the timestamp to settle before uploading.
      if (w.pending !== mtime) {
        w.pending = mtime;
        continue;
      }
      const upload = (async () => {
        try {
          await api.transfer({ id: this.remoteId, transferId: crypto.randomUUID(), direction: "upload", remotePath: w.remote, localPath: w.local, isDir: false });
          w.mtime = mtime;
          w.failedAt = 0;
          if (this.disposed) return;
          toast(`${userText(w.name)} 변경 내용을 서버에 저장했습니다`, "success");
          this.remotePane.refresh();
        } catch (err) {
          // Retried on the next poll; report each failing version only once.
          if (w.failedAt !== mtime && !this.disposed && this.state === "connected")
            toast(`${userText(w.name)} 업로드 실패: ${errorText(err)} (저장한 내용은 내 PC에 남아 있으며 다시 시도합니다)`, "error", 8000);
          w.failedAt = mtime;
        } finally {
          w.upload = null;
          w.pending = 0;
        }
      })();
      w.upload = upload;
      await upload;
    }
  }

  private async stopEditing(remote: string) {
    const w = this.editing.find((x) => x.remote === remote);
    // A second click while the first is still asking or uploading does nothing.
    if (!w || w.stopping) return;
    // From here the poll leaves this file alone, so it cannot start a second
    // upload of the same file or upload a temp file that is being released.
    w.stopping = true;
    try {
      // An upload the poll already started finishes first; it may make the
      // question below unnecessary.
      if (w.upload) await w.upload;
      // Saved in the editor but not uploaded yet (settling, failed, offline)?
      const [mtime] = await api.localStat(w.local).catch(() => [w.mtime] as [number]);
      if (mtime !== w.mtime) {
        const choice = await choiceDialog({
          title: "올리지 않은 변경이 있습니다",
          icon: "TriangleAlert",
          message: `<b data-i18n-skip>${esc(w.name)}</b>에 서버로 아직 올리지 않은 변경이 있습니다. 감시를 끝내면 내 PC의 임시 파일도 지워집니다.`,
          choices: [
            ...(this.state === "connected" ? [{ value: "upload", label: "올리고 끝내기" }] : []),
            { value: "discard", label: "버리고 끝내기", kind: "danger" as const },
          ],
        });
        if (!choice) return;
        if (choice === "upload") {
          try {
            await api.transfer({ id: this.remoteId, transferId: crypto.randomUUID(), direction: "upload", remotePath: w.remote, localPath: w.local, isDir: false });
            toast(`${userText(w.name)} 변경 내용을 서버에 저장했습니다`, "success");
            this.remotePane.refresh();
          } catch (err) {
            return toast(`${userText(w.name)} 업로드 실패: ${errorText(err)} (감시를 계속합니다)`, "error", 8000);
          }
        }
      }
      if (!this.editing.includes(w)) return;
      api.editTempRelease(w.local).catch(() => {});
      this.editing = this.editing.filter((x) => x !== w);
      if (!this.editing.length && this.editTimer) {
        clearInterval(this.editTimer);
        this.editTimer = 0;
      }
      this.renderEditing();
    } finally {
      w.stopping = false;
      // If the tab was closed while the dialog was open, an early return above
      // (cancel, or upload failure) would leave the temp file behind, since
      // dispose() deliberately left this stopping watch to us. Release it now.
      if (this.disposed) {
        api.editTempRelease(w.local).catch(() => {});
        this.editing = this.editing.filter((x) => x !== w);
      }
    }
  }

  private renderEditing() {
    const box = this.el.querySelector<HTMLElement>(".editing")!;
    box.hidden = !this.editing.length;
    box.innerHTML = this.editing
      .map(
        (w) => `<span class="edit-chip" title="${esc(userText(w.remote))}">${icon("ExternalLink", 13)}<span data-i18n-skip>${esc(w.name)}</span>
          <button class="tool" data-stop="${esc(w.remote)}" title="편집 감시 끝내기">${icon("X", 12)}</button></span>`,
      )
      .join("");
    box.querySelectorAll<HTMLElement>("[data-stop]").forEach((b) => b.addEventListener("click", () => this.stopEditing(b.dataset.stop!)));
  }

  onHiddenToggled() {
    for (const p of [this.localPane, this.remotePane]) {
      p.syncHiddenButton();
      p.render();
    }
  }

  title() {
    return this.session.name || endpoint(this.session);
  }

  status(): StatusInfo {
    const running = this.active;
    return {
      protocol: this.session.protocol,
      endpoint: endpoint(this.session),
      state: this.state,
      detail: running ? `전송 대기 ${running}건` : userText(this.remotePane.path),
    };
  }

  focus() {
    this.remotePane.el.focus();
  }

  goHome(side: Side) {
    if (side === "local") this.localPane.load(this.localHome);
    else this.remotePane.load(this.remoteHome);
  }

  private async init() {
    // connect() handles its own errors; this guards localHome()/local load so a
    // failure there shows the retry overlay instead of a silently dead tab.
    try {
      this.localHome = await api.localHome();
      await this.localPane.load(this.localHome);
      await this.connect({});
    } catch (err) {
      if (!this.disposed) this.fail(errorText(err));
    }
  }

  private setState(s: ViewState) {
    this.state = s;
    const label: Record<ViewState, string> = { connecting: "연결 중", connected: "연결됨", closed: "끊김", error: "오류" };
    const el = this.el.querySelector<HTMLElement>("[data-state]")!;
    el.textContent = label[s];
    el.dataset.state = s;
    this.ws.changed();
  }

  private async connect(extra: ConnectExtra) {
    this.setState("connecting");
    this.showOverlay("connecting");
    const rid = this.remoteId;
    try {
      const res = await api.remoteConnect({
        id: rid,
        protocol: this.session.protocol as "sftp" | "ftp" | "ftps",
        host: this.session.host,
        port: this.session.port,
        username: this.session.username,
        credentialId: this.session.credentialId,
        activeMode: !!this.session.options.activeMode,
        ftpsMode: this.session.options.ftpsMode === "implicit" ? "implicit" : "explicit",
        allowInvalidCert: !!this.session.options.allowInvalidCert,
        trustedCert: (this.session.options.trustedCert as string) || undefined,
        proxy: proxyOf(this.session),
        ...extra,
      });
      // Closed or reconnected while connecting: drop the orphaned connection.
      if (this.disposed || rid !== this.remoteId) {
        api.remoteDisconnect(rid).catch(() => {});
        return;
      }
      this.remoteHome = (this.session.options.startPath as string) || res.home;
      this.overlay.hidden = true;
      this.setState("connected");
      if (res.banner) toast(res.banner, "info");
      // The typed password worked: only now is it worth keeping.
      if (this.pendingCredential !== null) {
        const pw = this.pendingCredential;
        this.pendingCredential = null;
        await this.saveCredential(pw);
      }
      if (this.pendingPassphrase !== null) {
        const pass = this.pendingPassphrase;
        this.pendingPassphrase = null;
        await this.savePassphrase(pass);
      }
      // Jobs queued before a reconnect continue on the new connection.
      this.pump();
      await this.remotePane.load(this.remoteHome);
    } catch (err) {
      if (this.disposed || rid !== this.remoteId) return;
      await this.handleConnectError(errorText(err), extra);
    }
  }

  private async handleConnectError(msg: string, extra: ConnectExtra) {
    this.pendingCredential = null;
    this.pendingPassphrase = null;
    // The session's key is encrypted and its passphrase is not in the vault
    // (or the one typed was wrong). It is checked on this PC, so asking again
    // sends nothing to the server.
    if (msg === "NEED_PASSPHRASE" || msg === "BAD_PASSPHRASE") {
      const key = store.credentials.find((c) => c.id === this.session.credentialId)?.keyPath ?? "";
      const res = await promptDialog({
        title: msg === "BAD_PASSPHRASE" ? "키 암호가 맞지 않습니다" : "키 암호 입력",
        label: "개인 키의 암호",
        type: "password",
        icon: "KeyRound",
        confirm: "연결",
        extra: `${key ? `<p class="muted small"><code data-i18n-skip>${esc(key)}</code></p>` : ""}<label class="check"><input type="checkbox" name="save" /> 자격 증명 보관함의 이 키에 암호 저장</label>`,
      });
      if (!res) return this.fail("키 암호 입력을 취소했습니다.");
      if (res.form.querySelector<HTMLInputElement>("input[name=save]")!.checked) this.pendingPassphrase = res.value;
      return this.connect({ ...extra, password: res.value });
    }
    if (msg.startsWith("FTPS_CERT::")) {
      // "FTPS_CERT::<sha256>::<detail>": the exact certificate the server sent.
      const rest = msg.slice("FTPS_CERT::".length);
      const sep = rest.indexOf("::");
      const fp = sep >= 0 ? rest.slice(0, sep) : "";
      const detail = sep >= 0 ? rest.slice(sep + 2) : rest;
      const ok = await confirmDialog({
        title: "신뢰할 수 없는 서버 인증서",
        icon: "ShieldAlert",
        danger: true,
        message: `<b data-i18n-skip>${esc(this.session.host)}</b> 서버의 TLS 인증서를 Windows가 신뢰하지 않습니다.<br><br>
          서버가 보낸 인증서 지문 (SHA-256):<br><code class="fp">${esc(fp || detail)}</code><br><br>
          서버 관리자가 알려 준 지문과 같은지 확인한 다음 신뢰하세요. 내부망의 자체 서명 인증서 서버라면 계속해도 되지만,
          인터넷 서버라면 중간자 공격일 수 있습니다. 신뢰하면 이 지문의 인증서만 다음 접속에서 자동으로 허용합니다.`,
        confirm: "이 인증서를 신뢰하고 연결",
      });
      if (!ok) return this.fail("인증서를 신뢰하지 않아 연결을 취소했습니다.");
      // Pin this one certificate: only a certificate with exactly this
      // fingerprint is accepted later, so a man-in-the-middle certificate is
      // rejected and prompts again. Fall back to the one-connection override
      // only if the backend gave no fingerprint (e.g. a non-TLS failure).
      if (!fp) return this.connect({ ...extra, allowInvalidCert: true });
      await patchSession(this.session.id, {}, { trustedCert: fp });
      return this.connect({ ...extra, trustedCert: fp });
    }
    if (msg.startsWith("HOSTKEY_UNKNOWN::")) {
      const fp = msg.slice("HOSTKEY_UNKNOWN::".length);
      const ok = await confirmDialog({
        title: "처음 접속하는 서버",
        icon: "ShieldCheck",
        message: `<b data-i18n-skip>${esc(this.session.host)}</b> 서버의 호스트 키를 아직 신뢰한 적이 없습니다.<br><br>
          지문: <code class="fp">${esc(fp)}</code><br><br>
          서버 관리자가 알려 준 지문과 같은지 확인한 다음 신뢰하세요. 신뢰하면 <code>~/.ssh/known_hosts</code>에 기록됩니다.`,
        confirm: "신뢰하고 연결",
      });
      // Only a key with exactly this fingerprint will be trusted on reconnect.
      if (ok) return this.connect({ ...extra, trustedFingerprint: fp });
      return this.fail("호스트 키를 신뢰하지 않아 연결을 취소했습니다.");
    }
    if (msg.startsWith("HOSTKEY_MISMATCH::")) {
      const fp = msg.slice("HOSTKEY_MISMATCH::".length);
      const m = modal({
        title: "호스트 키가 바뀌었습니다",
        icon: "ShieldAlert",
        body: `<p class="modal-text danger-text"><b data-i18n-skip>${esc(this.session.host)}</b> 서버가 이전과 다른 호스트 키를 보냈습니다.
          중간자 공격일 수 있으므로 연결을 차단했습니다.<br><br>새 지문: <code class="fp">${esc(fp)}</code><br><br>
          서버를 다시 설치했거나 키를 교체한 것이 확실하다면, <code>~/.ssh/known_hosts</code>에서 이 서버의 줄을 지운 다음 다시 연결하세요.</p>`,
        footer: `<button class="btn" data-forget>${icon("ShieldAlert", 14)}저장된 키 지우기</button><button class="btn btn-primary" data-close>확인</button>`,
      });
      // A reinstalled server: forget the old key; the reconnect then asks to trust the new one.
      m.root.querySelector("[data-forget]")!.addEventListener("click", async () => {
        if (!(await forgetHostKey(this.session.host, this.session.port || 22, this.session.username))) return;
        m.close();
        this.reconnect();
      });
      return this.fail("호스트 키 불일치로 연결을 차단했습니다.");
    }
    if (msg === "NEED_PASSWORD" || /인증에 실패|로그인에 실패/.test(msg)) {
      const retry = msg !== "NEED_PASSWORD";
      // Telnet (and other) sessions have no stored username (you log in at the
      // prompt), so a reused FTP/SFTP connection must ask for the account too —
      // otherwise it tries to log in with an empty user. For FTP an empty name
      // means anonymous.
      const ftp = this.session.protocol === "ftp" || this.session.protocol === "ftps";
      const saveRow = `<label class="check"><input type="checkbox" name="save" /> 자격 증명 보관함에 저장하고 이 세션에 연결</label>`;
      let password: string;
      if (!this.session.username) {
        const res = await promptDialog({
          title: retry ? "로그인 정보가 올바르지 않습니다" : "로그인 정보 입력",
          label: `사용자 이름${ftp ? " (비우면 anonymous)" : ""}`,
          value: "",
          icon: "KeyRound",
          confirm: "연결",
          extra: `<label class="field"><span>${esc(userText(this.session.host))} 의 비밀번호</span>
                    <input name="pw" type="password" autocomplete="off" /></label>
                  ${saveRow}`,
          // Enter in the name box goes on to the password, not out with none
          // (an empty password is a login attempt of its own, or anonymous FTP).
          validate: (_, form) => {
            const pw = form.querySelector<HTMLInputElement>("input[name=pw]")!;
            return !pw.value && document.activeElement !== pw ? pw : null;
          },
        });
        if (!res) return this.fail("로그인 정보 입력을 취소했습니다.");
        this.session.username = res.value.trim();
        password = res.form.querySelector<HTMLInputElement>("input[name=pw]")!.value;
        const save = res.form.querySelector<HTMLInputElement>("input[name=save]")!.checked;
        this.pendingCredential = save ? password : null;
      } else {
        const res = await promptDialog({
          title: retry ? "비밀번호가 올바르지 않습니다" : "비밀번호 입력",
          label: `${userText(this.session.username)}@${userText(this.session.host)} 의 비밀번호`,
          type: "password",
          icon: "KeyRound",
          confirm: "연결",
          extra: saveRow,
        });
        if (!res) return this.fail("비밀번호 입력을 취소했습니다.");
        password = res.value;
        const save = res.form.querySelector<HTMLInputElement>("input[name=save]")!.checked;
        this.pendingCredential = save ? password : null;
      }
      return this.connect({ ...extra, password });
    }
    this.fail(msg);
  }

  /** Keep the typed passphrase in the session's key credential. */
  private async savePassphrase(passphrase: string) {
    const cred = store.credentials.find((c) => c.id === this.session.credentialId);
    if (!cred || cred.kind !== "key") return;
    try {
      await api.vaultSave(cred, passphrase);
      await reloadCredentials();
      toast("키 암호를 저장했습니다", "success");
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  private async saveCredential(password: string) {
    try {
      const cred = await api.vaultSave(
        {
          id: crypto.randomUUID(),
          name: `${this.session.username}@${this.session.host}`,
          username: this.session.username,
          kind: "password",
          keyPath: null,
          hasSecret: false,
        },
        password,
      );
      await reloadCredentials();
      this.session.credentialId = cred.id;
      await patchSession(this.session.id, { credentialId: cred.id });
      toast("자격 증명을 저장했습니다", "success");
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  private fail(msg: string) {
    this.setState("error");
    this.showOverlay("error", msg);
  }

  private showOverlay(kind: "connecting" | "error", msg = "") {
    this.overlay.hidden = false;
    if (kind === "connecting") {
      this.overlay.innerHTML = `<div class="overlay-card"><div class="spinner"></div><h3 data-i18n-skip>${esc(endpoint(this.session))}</h3><p>서버에 연결하는 중...</p></div>`;
      return;
    }
    this.overlay.innerHTML = `<div class="overlay-card">${icon("WifiOff", 26)}<h3>연결하지 못했습니다</h3><p>${esc(msg)}</p>
      <div class="row"><button class="btn btn-primary" data-o="re">${icon("RotateCw", 15)}다시 시도</button></div></div>`;
    this.overlay.querySelector('[data-o="re"]')!.addEventListener("click", () => this.connect({}));
  }

  reconnect() {
    for (const j of this.queue)
      if (j.status === "running") {
        j.requeue = true;
        api.transferCancel(j.id);
      }
    api.remoteDisconnect(this.remoteId).catch(() => {});
    this.remoteId = crypto.randomUUID();
    if (takeSavedSession(this.session)) this.ws.changed();
    this.connect({});
  }

  // ---- transfers --------------------------------------------------------------

  /** Queue the given entries from one side to the other side's current folder. */
  async send(from: Side, entries: FileEntry[]) {
    if (this.state !== "connected") return toast("서버에 연결된 다음 전송할 수 있습니다", "warn");
    const to = from === "local" ? "remote" : "local";
    const dest = this.pane(to);
    // No folder listed yet (the first listing failed, or the drive list on the
    // PC side) or a listing still on its way: the target folder and the clash
    // check below would both be wrong, so a name could land relative to the
    // server's working folder and overwrite without asking.
    if (!dest.path || dest.loading)
      return toast(to === "local" ? "내 PC 쪽에서 저장할 폴더를 먼저 여세요" : "서버 쪽 폴더 목록을 연 다음 올리세요", "warn");
    // Captured now: the user can open another folder while the dialog below is up.
    const destDir = dest.path;
    const destEntries = dest.entries;

    // A server can name entries "..\x" or "C:\x"; such names cannot become a
    // local file name (the backend refuses them too).
    if (to === "local") {
      const unsafe = entries.filter((e) => !isSafeLocalName(e.name));
      if (unsafe.length) {
        toast(`Windows에 저장할 수 없는 이름 ${unsafe.length}개를 건너뜁니다: ${userText(unsafe.slice(0, 3).map((u) => u.name).join(", "))}`, "warn", 6000);
        entries = entries.filter((e) => isSafeLocalName(e.name));
        if (!entries.length) return;
      }
    }

    // Never overwrite silently: ask when names already exist at the destination.
    // Windows file names are case-insensitive; remote (POSIX) names are not.
    const key = (n: string) => (to === "local" ? n.toLowerCase() : n);
    // Two remote names differing only in case would land on one Windows file.
    const seen = new Set<string>();
    const dupes = entries.filter((e) => {
      const k = key(e.name);
      if (seen.has(k)) return true;
      seen.add(k);
      return false;
    });
    if (dupes.length) {
      toast(`대소문자만 다른 같은 이름 ${dupes.length}개를 건너뜁니다: ${userText(dupes.slice(0, 3).map((d) => d.name).join(", "))}`, "warn", 6000);
      const drop = new Set(dupes);
      entries = entries.filter((e) => !drop.has(e));
    }
    // Clash with what is there now and with what is already queued for this folder.
    const existing = new Set(destEntries.map((d) => key(d.name)));
    const queuedHere = new Set(
      this.queue
        .filter((j) => (j.status === "queued" || j.status === "running") && (j.direction === "download") === (to === "local"))
        .map((j) => key(j.dest)),
    );
    const clashes = entries.filter((e) => existing.has(key(e.name)) || queuedHere.has(key(dest.join(destDir, e.name))));
    if (clashes.length) {
      const list = clashes.slice(0, 6).map((c) => `<li><span data-i18n-skip>${esc(c.name)}</span>${c.isDir ? " (폴더 — 안의 같은 파일을 덮어씀)" : ""}</li>`).join("");
      const choice = await choiceDialog({
        title: "같은 이름이 이미 있습니다",
        icon: "TriangleAlert",
        message: `${to === "local" ? "내 PC" : "서버"}의 <b data-i18n-skip>${esc(destDir)}</b> 에 같은 이름 ${clashes.length}개가 있습니다.
          <ul class="clash-list">${list}${clashes.length > 6 ? `<li>외 ${clashes.length - 6}개</li>` : ""}</ul>`,
        choices: [
          ...(clashes.length < entries.length ? [{ value: "skip", label: "겹치는 항목 건너뛰기" }] : []),
          { value: "overwrite", label: "덮어쓰기", kind: "danger" as const },
        ],
      });
      if (!choice) return;
      if (choice === "skip") {
        const drop = new Set(clashes);
        entries = entries.filter((e) => !drop.has(e));
      }
    }
    // Closed or disconnected while the dialog was up.
    if (this.disposed) return;

    for (const e of entries) {
      const job: Job = {
        id: crypto.randomUUID(),
        direction: from === "remote" ? "download" : "upload",
        name: e.name,
        src: e.path,
        dest: dest.join(destDir, e.name),
        isDir: e.isDir,
        status: "queued",
        done: 0,
        total: e.isDir ? 0 : e.size,
        filesDone: 0,
        el: h("div", { class: "job" }),
      };
      jobs.set(job.id, { job, view: this });
      this.queue.push(job);
      this.active++;
      this.jobsEl.prepend(job.el);
      this.renderJob(job);
    }
    this.el.querySelector(".transfers")!.classList.remove("collapsed");
    this.updateCount();
    this.pump();
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    let job: Job | undefined;
    // Pauses while disconnected; connect() calls pump() again.
    while (!this.disposed && this.state === "connected" && (job = this.queue.find((j) => j.status === "queued"))) {
      job.status = "running";
      this.renderJob(job);
      this.ws.changed();
      try {
        const remotePath = job.direction === "download" ? job.src : job.dest;
        const localPath = job.direction === "download" ? job.dest : job.src;
        const result = await api.transfer({
          id: this.remoteId,
          transferId: job.id,
          direction: job.direction,
          remotePath,
          localPath,
          isDir: job.isDir,
        });
        job.filesDone = result.filesDone;
        job.skipped = result.skipped;
        job.status = "done";
        job.done = Math.max(job.done, job.total);
      } catch (err) {
        const msg = errorText(err);
        job.status = msg === "CANCELLED" ? "cancelled" : "error";
        job.error = msg === "CANCELLED" ? undefined : msg;
      }
      if (job.requeue && job.status !== "done") {
        job.requeue = false;
        job.status = "queued";
        job.error = undefined;
        job.done = 0;
        this.renderJob(job);
        continue;
      }
      job.requeue = false;
      this.active--;
      jobs.delete(job.id);
      if (this.disposed) break;
      this.renderJob(job);
      // The next transfer starts at once; the folder is re-read once things calm down.
      this.refreshSoon(job.direction === "download" ? "local" : "remote");
      this.trimFinished();
      this.updateCount();
    }
    this.running = false;
    this.ws.changed();
  }

  /** Keep only the most recent finished rows, so a long session of many small
   * transfers (never cleared by hand) doesn't grow the queue and DOM without
   * bound. Queued/running jobs are always kept. */
  private trimFinished() {
    const MAX_DONE = 50;
    const finished = this.queue.filter((j) => j.status === "done" || j.status === "cancelled" || j.status === "error");
    const excess = finished.length - MAX_DONE;
    if (excess <= 0) return;
    // queue keeps insertion order, so the first `excess` finished are the oldest.
    const drop = new Set(finished.slice(0, excess));
    this.queue = this.queue.filter((j) => {
      if (!drop.has(j)) return true;
      j.el.remove();
      jobs.delete(j.id);
      return false;
    });
  }

  private refreshTimers: Partial<Record<"local" | "remote", number>> = {};
  /** Re-read a pane after transfers, at most every 0.5 s (500 files sent one
   * after another must not mean 500 listings in between). */
  private refreshSoon(side: "local" | "remote") {
    if (this.refreshTimers[side]) return;
    this.refreshTimers[side] = window.setTimeout(() => {
      this.refreshTimers[side] = 0;
      if (!this.disposed) this.pane(side).refresh();
    }, 500);
  }

  /** Progress updates touch only the bar and status text; the row and its
   * cancel button are rebuilt only when the status changes, so a click on
   * cancel is never lost to a re-render between mousedown and mouseup. */
  renderJob(j: Job) {
    const pct = j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : j.status === "done" ? 100 : 0;
    const statusText: Record<Job["status"], string> = {
      queued: "대기 중",
      running: j.total ? `${pct}% · ${formatBytes(j.done)} / ${formatBytes(j.total)}` : `${formatBytes(j.done)} 전송`,
      done: (j.isDir ? `완료 · 파일 ${j.filesDone}개` : "완료") + (j.skipped ? ` · 안전하지 않은 이름·링크 ${j.skipped}개 건너뜀` : ""),
      error: j.error ?? "실패",
      cancelled: "취소됨",
    };
    if (j.el.dataset.status !== j.status) {
      j.el.dataset.status = j.status;
      j.el.dataset.job = j.id;
      j.el.className = `job job-${j.status}`;
      j.el.innerHTML = `${icon(j.direction === "download" ? "Download" : "Upload", 15)}
        <div class="job-main"><div class="job-name"><span data-i18n-skip>${esc(j.name)}</span>${j.isDir ? " (폴더)" : ""}</div>
          <div class="job-bar"><i></i></div>
          <div class="job-status"></div></div>
        ${j.status === "running" || j.status === "queued" ? `<button class="tool" data-cancel title="취소">${icon("X", 14)}</button>` : ""}`;
    }
    j.el.querySelector<HTMLElement>(".job-bar i")!.style.width = `${pct}%`;
    j.el.querySelector(".job-status")!.textContent = statusText[j.status];
  }

  private cancelJob(id: string) {
    const j = this.queue.find((x) => x.id === id);
    if (!j) return;
    if (j.status === "queued") {
      j.status = "cancelled";
      this.active--;
      jobs.delete(j.id);
      this.renderJob(j);
      this.updateCount();
    } else if (j.status === "running") {
      // Clear a pending requeue (set by reconnect()) so an explicit cancel during
      // a reconnect window actually cancels instead of re-running the transfer.
      j.requeue = false;
      api.transferCancel(j.id);
    }
  }

  private updateCount() {
    const count = this.el.querySelector("[data-count]")!;
    count.textContent = this.active ? `${this.active}` : `${this.queue.length}`;
    count.classList.toggle("active", this.active > 0);
  }

  dispose() {
    this.disposed = true;
    this.notes.dispose();
    if (this.editTimer) clearInterval(this.editTimer);
    this.localPane.dispose();
    this.remotePane.dispose();
    // An upload still reading the temp file finishes (or fails) before it goes.
    // A watch being stopped owns its own cleanup (its dialog may still be open
    // and about to upload), so releasing its temp here would pull the file out
    // from under that upload: leave those to stopEditing.
    for (const w of this.editing) {
      if (w.stopping) continue;
      void (w.upload ?? Promise.resolve()).then(() => api.editTempRelease(w.local)).catch(() => {});
    }
    this.editing = this.editing.filter((w) => w.stopping);
    for (const j of this.queue) {
      if (j.status === "running") api.transferCancel(j.id);
      if (j.status === "queued") j.status = "cancelled";
      jobs.delete(j.id);
    }
    api.remoteDisconnect(this.remoteId).catch(() => {});
  }
}
