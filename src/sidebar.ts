// Session sidebar: searchable folder tree. Sessions and folders are dragged
// into folders and, in the manual order, to any place among their siblings.

import { icon } from "./icons";
import { actionFor } from "./keymap";

/** Row heights (.folder-row, .session-row) and when to draw only the rows in view. */
const FOLDER_H = 30;
const SESSION_H = 42;
const TREE_WINDOW_MIN = 400;
const TREE_MARGIN = 40;

import { endpoint, PROTOCOLS, type Session } from "./model";
import { fileSessionFor, fileTransferBlockedReason } from "./transfer";
import { folderCompare, sessionCompare, type SessionSort } from "./sessionOrder";
import {
  adoptManualOrder,
  folderSnapshot,
  addFolder,
  allFolders,
  deleteFolder,
  moveSessions,
  placeFolder,
  placeSessions,
  sessionPositions,
  sortFolder,
  startManualOrder,
  updateSettings,
  removeSession,
  removeSessions,
  renameFolder,
  state,
  subscribe,
  upsertSession,
  upsertSessions,
} from "./store";
import { api } from "./api";
import { confirmDialog, contextMenu, errorText, esc, modal, promptDialog, toast } from "./ui";

export interface SidebarActions {
  connect(s: Session): void;
  edit(s: Session | null, defaults?: Partial<Session>): void;
  openFiles(s: Session): void;
}

interface FolderNode {
  name: string;
  path: string;
  children: Map<string, FolderNode>;
  sessions: Session[];
}

/** Collapsed folders, kept across restarts. Read defensively: this runs at
 * module load (a static import of main.ts), so a corrupt or wrong-shaped value
 * must not throw and blank the whole app. */
function loadCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem("bx.collapsed") ?? "[]");
    return new Set<string>(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set<string>();
  }
}
const collapsed = loadCollapsed();
const saveCollapsed = () => {
  try {
    localStorage.setItem("bx.collapsed", JSON.stringify([...collapsed]));
  } catch {
    // Storage full or blocked: the collapsed state just isn't remembered.
  }
};

/** Where a dragged row would land: before/after a row, into a folder, or (no
 * row) at the top level. */
interface DropAt {
  row: HTMLElement | null;
  where: "before" | "after" | "into";
}

export class Sidebar {
  private tree: HTMLElement;
  private redrawQueued = false;
  private query = "";
  /** The tree markup now on screen. */
  private shown = "";
  /** The focused session (keyboard actions, F2, Ctrl+C). */
  private selected: string | null = null;
  /** All selected sessions (Ctrl+click toggles, Shift+click selects a range). */
  private picked = new Set<string>();
  /** Where a Shift+click range starts. */
  private anchor: string | null = null;
  /** Sessions being dragged: the whole selection when the dragged row is part of it. */
  private dragIds: string[] | null = null;
  /** The folder being dragged. */
  private dragFolder: string | null = null;
  /** The row showing where a drop would land. */
  private dropMark: HTMLElement | null = null;

  constructor(
    private root: HTMLElement,
    private actions: SidebarActions,
  ) {
    root.innerHTML = `
      <div class="side-head">
        <span>세션</span>
        <div class="side-tools">
          <button class="icon-btn" data-a="sort" title="정렬">${icon("ArrowUpDown", 16)}</button>
          <button class="icon-btn" data-a="more" title="가져오기·내보내기">${icon("Download", 16)}</button>
          <button class="icon-btn" data-a="folder" title="새 폴더">${icon("FolderPlus", 16)}</button>
          <button class="icon-btn" data-a="new" title="새 세션 (Ctrl+Shift+N)">${icon("Plus", 16)}</button>
        </div>
      </div>
      <label class="side-search">${icon("Search", 14)}<input placeholder="이름·호스트 검색" spellcheck="false" /></label>
      <div class="tree" tabindex="0"></div>`;
    this.tree = root.querySelector(".tree")!;
    root.querySelector('[data-a="new"]')!.addEventListener("click", () => actions.edit(null));
    root.querySelector('[data-a="folder"]')!.addEventListener("click", () => this.newFolder(""));
    root.querySelector('[data-a="sort"]')!.addEventListener("click", (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      this.sortMenu(r.left, r.bottom + 4);
    });
    root.querySelector('[data-a="more"]')!.addEventListener("click", async (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const mod = await import("./importExport").catch((err) => void toast(errorText(err), "error"));
      if (!mod) return;
      const { exportBackup, importFromBackup, importMenuItems } = mod;
      contextMenu(r.left, r.bottom + 4, [
        ...importMenuItems(),
        "-",
        { label: "세션 백업 가져오기(JSON)…", icon: "Upload", action: () => importFromBackup() },
        "-",
        { label: "세션 백업 내보내기(JSON)…", icon: "Save", action: () => exportBackup() },
      ]);
    });
    // Re-filter once typing pauses, not on every key (thousands of sessions).
    let searchTimer = 0;
    root.querySelector<HTMLInputElement>(".side-search input")!.addEventListener("input", (e) => {
      const query = (e.target as HTMLInputElement).value.trim().toLowerCase();
      clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        this.query = query;
        this.render();
      }, 80);
    });
    this.wireSessionRows();
    const redraw = () => {
      if (!this.rows.length || this.redrawQueued) return;
      this.redrawQueued = true;
      requestAnimationFrame(() => {
        this.redrawQueued = false;
        this.drawWindow();
      });
    };
    this.tree.addEventListener("scroll", redraw, { passive: true });
    new ResizeObserver(redraw).observe(this.tree);
    this.tree.addEventListener("keydown", (e) => this.onKey(e));
    this.tree.addEventListener("contextmenu", (e) => {
      if ((e.target as HTMLElement).closest(".session-row, .folder-row")) return;
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: "새 세션", icon: "Plus", action: () => this.actions.edit(null) },
        { label: "맨 위에 붙여넣기", icon: "ClipboardPaste", hint: "Ctrl+V", disabled: !this.clip, action: () => this.pasteSession("") },
        "-",
        { label: "맨 위 단계를 이름순으로 정렬", icon: "ArrowUpDown", action: () => this.sortOnce("", "name") },
        { label: "맨 위 단계를 주소순으로 정렬", icon: "ArrowUpDown", action: () => this.sortOnce("", "address") },
      ]);
    });
    // Drops are handled here for every row (rows are redrawn, and only the
    // rows in view exist when there are many).
    this.tree.addEventListener("dragover", (e) => {
      if (!this.dragIds && !this.dragFolder) return;
      const at = this.dropAt(e);
      this.markDrop(at);
      if (at) e.preventDefault();
    });
    this.tree.addEventListener("dragleave", (e) => {
      if (!this.tree.contains(e.relatedTarget as Node | null)) this.markDrop(null);
    });
    this.tree.addEventListener("drop", (e) => {
      const at = this.dropAt(e);
      const [folder, ids] = [this.dragFolder, this.dragIds];
      // The drag ends here: the redraw below can remove the dragged row, and
      // a detached row's dragend reaches no listener.
      this.endDrag();
      if (!at) return;
      e.preventDefault();
      if (folder) void this.dropFolder(folder, at);
      else if (ids) void this.dropSessions(ids, at);
    });
    subscribe("sessions", () => this.render());
    subscribe("folders", () => this.render());
    // The tree depends on only two settings; skip the full walk for unrelated
    // settings writes (AI run mode, "don't ask again", keybindings, …).
    subscribe("settings", () => {
      const key = `${state.settings.sessionSort}\0${state.settings.folderOrder.join("\0")}`;
      if (key === this.sortKey) return;
      this.sortKey = key;
      this.render();
    });
    this.render();
  }

  focusSearch() {
    this.root.querySelector<HTMLInputElement>(".side-search input")!.focus();
  }

  private matches(s: Session) {
    if (!this.query) return true;
    return [s.name, s.host, s.username, s.folder, PROTOCOLS[s.protocol].label, s.notes]
      .join(" ")
      .toLowerCase()
      .includes(this.query);
  }

  private build(): FolderNode {
    const root: FolderNode = { name: "", path: "", children: new Map(), sessions: [] };
    // Sessions share a few folders: walk each folder path once.
    const nodes = new Map<string, FolderNode>([["", root]]);
    const ensure = (path: string) => {
      const known = nodes.get(path);
      if (known) return known;
      let node = root;
      let acc = "";
      for (const part of path.split("/").filter(Boolean)) {
        acc = acc ? `${acc}/${part}` : part;
        if (!node.children.has(part)) node.children.set(part, { name: part, path: acc, children: new Map(), sessions: [] });
        node = node.children.get(part)!;
      }
      nodes.set(path, node);
      return node;
    };
    if (!this.query) allFolders().forEach(ensure);
    for (const s of state.sessions) if (this.matches(s)) ensure(s.folder).sessions.push(s);
    return root;
  }

  private count(node: FolderNode): number {
    let n = node.sessions.length;
    node.children.forEach((c) => (n += this.count(c)));
    return n;
  }

  render() {
    // Selected sessions that were deleted, or are hidden by a search or a
    // closed folder, are dropped below (only shown rows stay selected).
    const root = this.build();
    const html: string[] = [];
    const heights: number[] = [];
    const order: string[] = [];
    this.rowIndex.clear();
    const mode = state.settings.sessionSort;
    const bySession = sessionCompare(mode, mode === "manual" ? sessionPositions() : new Map());
    const byFolder = folderCompare(mode, state.settings.folderOrder);
    const walk = (node: FolderNode, depth: number) => {
      const folders = [...node.children.values()].sort((a, b) => byFolder(a.path, b.path));
      for (const f of folders) {
        const open = this.query ? true : !collapsed.has(f.path);
        html.push(`<div class="folder-row" data-folder="${esc(f.path)}" draggable="true" style="--depth:${depth}">
            <span class="chev">${icon(open ? "ChevronDown" : "ChevronRight", 14)}</span>
            ${icon(open ? "FolderOpen" : "Folder", 15, "folder-ico")}
            <span class="fname" data-i18n-skip>${esc(f.name)}</span><span class="count">${this.count(f)}</span></div>`);
        heights.push(FOLDER_H);
        if (open) walk(f, depth + 1);
      }
      const sessions = [...node.sessions].sort(bySession);
      for (const s of sessions) {
        const p = PROTOCOLS[s.protocol];
        this.rowIndex.set(s.id, html.length);
        html.push(`<div class="session-row${this.picked.has(s.id) ? " selected" : ""}" data-session="${s.id}" draggable="true"
            style="--depth:${depth};--proto:${p.color}" title="${esc(`${p.label} · ${endpoint(s)}${s.notes ? `\n${s.notes}` : ""}`)}">
            <span class="proto-ico">${icon(p.icon, 15)}</span>
            <span class="srow-text"><span class="sname" data-i18n-skip>${esc(s.name)}</span><span class="shost" data-i18n-skip>${esc(endpoint(s))}</span></span>
            <button class="row-go" data-go title="연결" tabindex="-1">${icon("Play", 13)}</button></div>`);
        heights.push(SESSION_H);
        order.push(s.id);
      }
    };
    walk(root, 0);
    this.order = order;
    // A selection hidden by a search or a collapsed folder is dropped: keys
    // and bulk actions act only on rows the user can see highlighted.
    const shown = new Set(order);
    for (const id of this.picked) if (!shown.has(id)) this.picked.delete(id);
    if (this.selected && !shown.has(this.selected)) this.selected = null;
    if (this.anchor && !shown.has(this.anchor)) this.anchor = null;
    if (!html.length) {
      html.push(
        this.query
          ? `<div class="tree-empty">${icon("Search", 22)}<p>"${esc(this.query)}"와 일치하는 세션이 없습니다</p></div>`
          : `<div class="tree-empty">${icon("Server", 26)}<p>저장된 세션이 없습니다</p>
               <button class="btn btn-primary btn-sm" data-first>${icon("Plus", 14)}첫 세션 만들기</button>
               <button class="btn btn-sm" data-import>${icon("Download", 14)}다른 프로그램에서 가져오기</button></div>`,
      );
    }
    // Most changes do not alter what the tree shows (a connect only updates the
    // session's last-used time): keep the DOM as it is then.
    const markup = html.join("");
    if (markup === this.shown) return;
    this.shown = markup;
    if (html.length > TREE_WINDOW_MIN) {
      this.rows = html;
      this.tops = [];
      let y = 0;
      for (const h of heights) {
        this.tops.push(y);
        y += h;
      }
      this.total = y;
      this.drawn = null;
      return this.drawWindow();
    }
    this.rows = [];
    this.tree.innerHTML = markup;
    this.tree.querySelector("[data-first]")?.addEventListener("click", () => this.actions.edit(null));
    this.tree.querySelector("[data-import]")?.addEventListener("click", async (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const mod = await import("./importExport").catch((err) => void toast(errorText(err), "error"));
      if (!mod) return;
      const { importMenuItems } = mod;
      contextMenu(r.left, r.bottom + 4, importMenuItems());
    });
    this.wireRows();
  }

  /** Many sessions: rows in display order, and each one's offset in the tree. */
  private rows: string[] = [];
  private tops: number[] = [];
  private total = 0;
  private drawn: { first: number; last: number } | null = null;
  /** Session ids in display order (sessions inside closed folders are left out). */
  private order: string[] = [];
  /** Session id → its index in `rows`/`tops`, so reveal() is O(1), not a scan. */
  private rowIndex = new Map<string, number>();
  /** sessionSort + folderOrder at the last settings-driven render (skip if unchanged). */
  private sortKey = "";

  /** Thousands of sessions: only the rows in view (and a margin) are in the
   * DOM, between spacers that keep the scroll height. A full tree of 3000
   * sessions took about 0.2 s to draw on every change. */
  private drawWindow() {
    const n = this.rows.length;
    if (!n) return;
    const top = Math.max(0, this.tree.scrollTop - 2);
    const view = this.tree.clientHeight || 800;
    const at = (y: number) => {
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (this.tops[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const vFirst = at(top);
    const vLast = Math.min(n, at(top + view) + 1);
    const d = this.drawn;
    if (d && (vFirst >= d.first + TREE_MARGIN / 3 || d.first === 0) && (vLast <= d.last - TREE_MARGIN / 3 || d.last === n)) return;
    const first = Math.max(0, vFirst - TREE_MARGIN);
    const last = Math.min(n, vLast + TREE_MARGIN);
    this.drawn = { first, last };
    const after = this.total - (last < n ? this.tops[last] : this.total);
    this.tree.innerHTML =
      `<div class="tree-spacer" style="height:${this.tops[first]}px"></div>` + this.rows.slice(first, last).join("") + `<div class="tree-spacer" style="height:${after}px"></div>`;
    // The row markup was made at render time; the selection may have changed since.
    this.tree.querySelectorAll<HTMLElement>(".session-row").forEach((r) => r.classList.toggle("selected", this.picked.has(r.dataset.session!)));
    this.wireRows();
  }

  /** Scroll a session's row into view (drawing it first when rows are windowed). */
  private reveal(id: string) {
    if (this.rows.length) {
      const i = this.rowIndex.get(id) ?? -1;
      if (i >= 0) {
        const y = this.tops[i];
        const h = (i + 1 < this.rows.length ? this.tops[i + 1] : this.total) - y;
        if (y < this.tree.scrollTop) this.tree.scrollTop = y;
        else if (y + h > this.tree.scrollTop + this.tree.clientHeight) this.tree.scrollTop = y + h - this.tree.clientHeight;
        this.drawWindow();
      }
    }
    this.tree.querySelector(`[data-session="${id}"]`)?.scrollIntoView({ block: "nearest" });
  }

  private session(id: string) {
    return state.sessions.find((s) => s.id === id);
  }

  /** Selected sessions in tree order. */
  private pickedSessions(): Session[] {
    const byId = new Map(state.sessions.map((s) => [s.id, s]));
    return this.visibleIds().flatMap((id) => (this.picked.has(id) && byId.get(id)) || []);
  }

  private visibleIds(): string[] {
    return this.order;
  }

  /** Select exactly `ids` and focus `focus`, updating the rows without a re-render. */
  private select(ids: Iterable<string>, focus: string | null, anchor = focus) {
    this.picked = new Set(ids);
    this.selected = focus;
    this.anchor = anchor;
    this.tree.querySelectorAll<HTMLElement>(".session-row").forEach((r) => r.classList.toggle("selected", this.picked.has(r.dataset.session!)));
  }

  /** Click with Ctrl (toggle) / Shift (range from the anchor) / nothing (single). */
  private clickSelect(id: string, e: MouseEvent | KeyboardEvent) {
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(this.picked);
      if (next.has(id)) {
        next.delete(id);
        // Keys act on the focused row: never leave it on one just deselected.
        const rest = this.visibleIds().filter((x) => next.has(x));
        return this.select(next, rest.at(-1) ?? null);
      }
      next.add(id);
      return this.select(next, id);
    }
    if (e.shiftKey && this.anchor) {
      const ids = this.visibleIds();
      const [a, b] = [ids.indexOf(this.anchor), ids.indexOf(id)];
      if (a >= 0 && b >= 0) return this.select(ids.slice(Math.min(a, b), Math.max(a, b) + 1), id, this.anchor);
    }
    this.select([id], id);
  }

  private wireRows() {
    this.tree.querySelectorAll<HTMLElement>(".folder-row").forEach((row) => {
      const path = row.dataset.folder!;
      row.addEventListener("click", () => {
        // While searching every folder is shown open; a click must not
        // silently collapse it for later.
        if (this.query) return;
        if (collapsed.has(path)) collapsed.delete(path);
        else collapsed.add(path);
        saveCollapsed();
        this.render();
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const n = this.picked.size;
        contextMenu(e.clientX, e.clientY, [
          ...(n ? [{ label: `선택한 세션 ${n}개를 여기로 이동`, icon: "FolderSync", action: () => this.moveTo([...this.picked], path) }, "-" as const] : []),
          { label: "이 폴더에 새 세션", icon: "Plus", action: () => this.actions.edit(null, { folder: path }) },
          { label: "여기에 붙여넣기", icon: "ClipboardPaste", hint: "Ctrl+V", disabled: !this.clip, action: () => this.pasteSession(path) },
          { label: "하위 폴더 만들기", icon: "FolderPlus", action: () => this.newFolder(path) },
          { label: "이 폴더 안을 이름순으로 정렬", icon: "ArrowUpDown", action: () => this.sortOnce(path, "name") },
          { label: "이 폴더 안을 주소순으로 정렬", icon: "ArrowUpDown", action: () => this.sortOnce(path, "address") },
          { label: "이름 바꾸기", icon: "Pencil", action: () => this.renameFolder(path) },
          "-",
          { label: "폴더 삭제", icon: "Trash2", danger: true, action: () => this.deleteFolder(path) },
        ]);
      });
    });

  }

  /** Session rows: one listener per event on the tree (not five per row,
   * re-created on every redraw of thousands of sessions). */
  private wireSessionRows() {
    const rowSession = (e: Event) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".session-row");
      return row ? this.session(row.dataset.session!) : undefined;
    };
    this.tree.addEventListener("click", (e) => {
      const s = rowSession(e);
      if (!s) return;
      if ((e.target as HTMLElement).closest("[data-go]")) return this.actions.connect(s);
      this.clickSelect(s.id, e);
    });
    this.tree.addEventListener("dblclick", (e) => {
      const s = rowSession(e);
      if (s && !(e.target as HTMLElement).closest("[data-go]")) this.actions.connect(s);
    });
    this.tree.addEventListener("contextmenu", (e) => {
      const s = rowSession(e);
      if (!s) return;
      e.preventDefault();
      if (this.picked.has(s.id) && this.picked.size > 1) return this.bulkMenu(e.clientX, e.clientY);
      this.select([s.id], s.id);
      this.sessionMenu(s, e.clientX, e.clientY);
    });
    this.tree.addEventListener("dragstart", (e) => {
      // A drag whose end was never reported (its row was redrawn) is over.
      this.endDrag();
      const folderRow = (e.target as HTMLElement).closest<HTMLElement>(".folder-row");
      if (folderRow) {
        this.dragFolder = folderRow.dataset.folder!;
        e.dataTransfer!.effectAllowed = "move";
        e.dataTransfer!.setData("text/plain", this.dragFolder);
        folderRow.classList.add("dragging");
        return;
      }
      const s = rowSession(e);
      if (!s) return;
      if (!this.picked.has(s.id)) this.select([s.id], s.id);
      this.dragIds = [...this.picked];
      e.dataTransfer!.effectAllowed = "move";
      e.dataTransfer!.setData("text/plain", this.dragIds.join("\n"));
      this.tree.querySelectorAll<HTMLElement>(".session-row.selected").forEach((r) => r.classList.add("dragging"));
    });
    // On the document: the dragged row may have been replaced by a redraw
    // (a save mid-drag), and then its dragend never reaches the tree.
    document.addEventListener("dragend", () => this.endDrag());
  }

  /** Open the file browser for a session, warning when its route (jump host /
   * SSH gateway) is one the file backend cannot use. */
  private openFileBrowser(source: Session, fileSession: Session) {
    const blocked = fileTransferBlockedReason(source);
    if (blocked) return toast(blocked, "error", 7000);
    this.actions.openFiles(fileSession);
  }

  private sessionMenu(s: Session, x: number, y: number) {
    contextMenu(x, y, [
      { label: "연결", icon: "Play", hint: "Enter", action: () => this.actions.connect(s) },
      ...(s.protocol === "ssh" ? [{ label: "SFTP 파일 브라우저 열기", icon: "FolderLock", action: () => this.openFileBrowser(s, s) }] : []),
      ...(s.protocol === "telnet" ? [{ label: "FTP 파일 브라우저 열기", icon: "FolderLock", action: () => this.openFileBrowser(s, fileSessionFor(s, "ftp")) }] : []),
      ...(String(s.options.wolMac ?? "").trim() ? [{ label: "Wake-on-LAN (전원 켜기)", icon: "Power", action: () => void this.wake(s) }] : []),
      "-",
      { label: "편집", icon: "Pencil", hint: "F2", action: () => this.actions.edit(s) },
      { label: "복사", icon: "Copy", hint: "Ctrl+C", action: () => this.copySession(s) },
      { label: "붙여넣기", icon: "ClipboardPaste", hint: "Ctrl+V", disabled: !this.clip, action: () => this.pasteSession(s.folder) },
      { label: "복제", icon: "CopyPlus", action: () => this.pasteSession(s.folder, s) },
      "-",
      { label: "삭제", icon: "Trash2", hint: "Del", danger: true, action: () => this.deleteSession(s) },
    ]);
  }

  /** Send a Wake-on-LAN magic packet to the session's saved MAC address. */
  private async wake(s: Session) {
    const mac = String(s.options.wolMac ?? "").trim();
    if (!mac) return;
    const broadcast = String(s.options.wolBroadcast ?? "").trim() || undefined;
    try {
      await api.wakeOnLan(mac, broadcast);
      toast(`${s.name || s.host}에 Wake-on-LAN 신호를 보냈습니다`, "success", 3000);
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  /** Menu for a multi-selection. */
  private bulkMenu(x: number, y: number) {
    const list = this.pickedSessions();
    contextMenu(x, y, [
      { label: `${list.length}개 세션 연결`, icon: "Play", hint: "Enter", action: () => list.forEach((s) => this.actions.connect(s)) },
      "-",
      { label: "한꺼번에 수정…", icon: "Pencil", hint: "F2", action: () => this.bulkEdit(list) },
      { label: "폴더로 이동…", icon: "FolderSync", action: () => this.bulkMove(list) },
      "-",
      { label: `${list.length}개 삭제`, icon: "Trash2", hint: "Del", danger: true, action: () => this.bulkDelete(list) },
    ]);
  }

  private endDrag() {
    if (!this.dragIds && !this.dragFolder) return;
    this.dragIds = null;
    this.dragFolder = null;
    this.markDrop(null);
    this.tree.querySelectorAll(".dragging").forEach((r) => r.classList.remove("dragging"));
  }

  private sortMenu(x: number, y: number) {
    const mode = state.settings.sessionSort;
    const item = (m: SessionSort, label: string, action: () => unknown) => ({ label, icon: mode === m ? "Check" : "Circle", action });
    contextMenu(x, y, [
      item("name", "이름순 (AP2가 AP10보다 먼저)", () => updateSettings({ sessionSort: "name" })),
      item("address", "주소순 (IP를 숫자로)", () => updateSettings({ sessionSort: "address" })),
      item("recent", "최근 연결순", () => updateSettings({ sessionSort: "recent" })),
      item("manual", "사용자 지정 (끌어서 순서 바꾸기)", () => startManualOrder()),
    ]);
  }

  /** Sort what a folder holds once (the manual order keeps it). */
  private async sortOnce(folder: string, by: "name" | "address") {
    const wasManual = state.settings.sessionSort === "manual";
    await sortFolder(folder, by);
    if (!wasManual) toast("정렬을 '사용자 지정'으로 바꿨습니다. 이제 끌어서 순서를 바꿀 수 있습니다", "info", 4000);
  }

  /** Where the dragged rows would land at this point, or null where they
   * cannot go. Sessions: before/after a session (upper/lower half), into a
   * folder, or the top level. Folders: before/after a folder (its upper or
   * lower quarter), into it (the middle), or the top level. */
  private dropAt(e: DragEvent): DropAt | null {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".session-row, .folder-row");
    if (!row) return { row: null, where: "into" };
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / Math.max(1, r.height);
    if (row.classList.contains("folder-row")) {
      if (this.dragIds) return { row, where: "into" };
      const path = row.dataset.folder!;
      if (this.dragFolder && (path === this.dragFolder || path.startsWith(this.dragFolder + "/"))) return null;
      return { row, where: y < 0.25 ? "before" : y > 0.75 ? "after" : "into" };
    }
    if (this.dragFolder) return null;
    if (this.dragIds?.includes(row.dataset.session!)) return null;
    return { row, where: y < 0.5 ? "before" : "after" };
  }

  private markDrop(at: DropAt | null) {
    const el = at?.row ?? null;
    const cls = at ? (at.where === "into" ? "drop-target" : `drop-${at.where}`) : "";
    if (this.dropMark && (this.dropMark !== el || !this.dropMark.classList.contains(cls))) {
      this.dropMark.classList.remove("drop-target", "drop-before", "drop-after");
    }
    this.dropMark = el;
    if (el && cls) el.classList.add(cls);
  }

  private async dropSessions(ids: string[], at: DropAt) {
    // Dragged in the order they are shown.
    const shown = new Map(this.order.map((id, i) => [id, i]));
    const list = [...ids].sort((a, b) => (shown.get(a) ?? 0) - (shown.get(b) ?? 0));
    if (!at.row) return this.moveTo(list, "");
    if (at.row.classList.contains("folder-row")) return this.moveTo(list, at.row.dataset.folder!);
    const target = this.session(at.row.dataset.session!);
    if (!target) return;
    // Onto a row of another folder in an automatic order: only the folder
    // changes. Among its own folder (or in the manual order) it is a reorder.
    const sameFolder = list.every((id) => this.session(id)?.folder === target.folder);
    if (state.settings.sessionSort !== "manual" && !sameFolder) return this.moveTo(list, target.folder);
    const undo = folderSnapshot();
    const switched = adoptManualOrder();
    await placeSessions(list, target.folder, target.id, at.where === "before" ? "before" : "after", switched ? undo : undefined);
    if (switched) toast("정렬을 '사용자 지정'으로 바꿨습니다. 끌어서 놓은 순서가 그대로 유지됩니다", "info", 4000);
    this.refocus();
  }

  private async dropFolder(path: string, at: DropAt) {
    const anchor = at.row?.dataset.folder ?? "";
    // Before/after another folder sets the manual order; into one does not.
    const undo = folderSnapshot();
    const switched = at.where !== "into" && adoptManualOrder();
    const err = await placeFolder(path, anchor, at.where, switched ? undo : undefined);
    if (err) return void toast(err, "warn");
    if (at.where === "into" && anchor) {
      collapsed.delete(anchor);
      saveCollapsed();
    }
    if (switched) toast("정렬을 '사용자 지정'으로 바꿨습니다. 끌어서 놓은 순서가 그대로 유지됩니다", "info", 4000);
    this.render();
  }

  /** Alt+Up / Alt+Down: move the selected session one place within its folder. */
  private async nudge(step: -1 | 1) {
    const s = this.selected && this.picked.size <= 1 ? this.session(this.selected) : undefined;
    if (!s) return;
    // One id→session map instead of a find() per visible row (O(n) not O(n²)).
    const byId = new Map(state.sessions.map((x) => [x.id, x]));
    const siblings = this.order.filter((id) => byId.get(id)?.folder === s.folder);
    const next = siblings[siblings.indexOf(s.id) + step];
    if (!next) return;
    const undo = folderSnapshot();
    const switched = adoptManualOrder();
    await placeSessions([s.id], s.folder, next, step < 0 ? "before" : "after", switched ? undo : undefined);
    if (switched) toast("정렬을 '사용자 지정'으로 바꿨습니다", "info", 3000);
    this.reveal(s.id);
  }

  private async moveTo(ids: string[], folder: string) {
    collapsed.delete(folder);
    saveCollapsed();
    await moveSessions(ids, folder);
    this.refocus();
  }

  /** After a dialog, keep keyboard control in the tree (the menu item that opened it is gone). */
  private refocus() {
    setTimeout(() => this.tree.focus({ preventScroll: true }), 0);
  }

  private bulkMove(list: Session[]) {
    const folders = allFolders();
    const m = modal({
      title: `세션 ${list.length}개를 폴더로 이동`,
      icon: "FolderSync",
      body: `<form class="form" data-form>
          <label class="field"><span>대상 폴더 (비우면 최상위, 없는 폴더는 새로 만듭니다)</span>
            <input name="folder" list="bx-folders" value="${esc(list[0].folder)}" autocomplete="off" spellcheck="false" placeholder="예: 서버/운영"/></label>
          <datalist id="bx-folders">${folders.map((f) => `<option value="${esc(f)}"></option>`).join("")}</datalist>
        </form>`,
      footer: `<button class="btn" data-close>취소</button><button class="btn btn-primary" data-ok>이동</button>`,
    });
    const form = m.root.querySelector<HTMLFormElement>("[data-form]")!;
    const submit = async () => {
      const folder = form.querySelector<HTMLInputElement>("[name=folder]")!.value.split("/").map((p) => p.trim()).filter(Boolean).join("/");
      m.close();
      await this.moveTo(list.map((s) => s.id), folder);
      toast(`세션 ${list.length}개를 ${folder ? `"${folder}"` : "최상위"}(으)로 옮겼습니다`, "success");
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submit();
    });
    m.root.querySelector("[data-ok]")!.addEventListener("click", submit);
  }

  /** Change the checked fields on every selected session at once. */
  private bulkEdit(list: Session[]) {
    const row = (key: string, label: string, control: string) =>
      `<div class="bulk-row"><label class="check"><input type="checkbox" data-on="${key}"/><span>${label}</span></label>
         <div class="field">${control}</div></div>`;
    const creds = state.credentials;
    const terminals = list.filter((s) => PROTOCOLS[s.protocol].view === "terminal").length;
    const m = modal({
      title: `세션 ${list.length}개 한꺼번에 수정`,
      icon: "Pencil",
      width: 520,
      body: `<form class="form" data-form>
          <p class="modal-text">체크한 항목만 선택한 모든 세션에 적용합니다. 나머지 설정은 그대로 둡니다.</p>
          <button type="submit" hidden></button>
          ${row("username", "사용자 이름", `<input name="username" autocomplete="off" spellcheck="false" disabled/>`)}
          ${row("port", "포트", `<input name="port" type="number" min="1" max="65535" placeholder="비우면 프로토콜 기본값" disabled/>`)}
          ${row(
            "credentialId",
            "자격 증명",
            `<select name="credentialId" disabled><option value="">사용 안 함 (접속할 때 입력)</option>${creds
              .map((c) => `<option value="${c.id}" data-i18n-skip title="${c.kind === "key" ? "키" : "비밀번호"}${c.username ? ` · ${esc(c.username)}` : ""}">${esc(c.name)}</option>`)
              .join("")}</select>`,
          )}
          ${row("folder", "폴더", `<input name="folder" list="bx-folders-edit" autocomplete="off" spellcheck="false" placeholder="비우면 최상위" disabled/>`)}
          <datalist id="bx-folders-edit">${allFolders().map((f) => `<option value="${esc(f)}"></option>`).join("")}</datalist>
          ${
            terminals
              ? row(
                  "keyMode",
                  "키 입력 방식",
                  `<select name="keyMode" disabled><option value="standard">표준 (리눅스·유닉스 서버)</option><option value="network">네트워크 장비 (Cisco IOS 등)</option></select>`,
                )
              : ""
          }
        </form>`,
      footer: `<button class="btn" data-close>취소</button><button class="btn btn-primary" data-ok>적용</button>`,
    });
    const form = m.root.querySelector<HTMLFormElement>("[data-form]")!;
    form.querySelectorAll<HTMLInputElement>("[data-on]").forEach((box) =>
      box.addEventListener("change", () => {
        const input = form.querySelector<HTMLInputElement>(`[name=${box.dataset.on}]`)!;
        input.disabled = !box.checked;
        if (box.checked) input.focus();
      }),
    );
    const on = (key: string) => !!form.querySelector<HTMLInputElement>(`[data-on=${key}]`)?.checked;
    const val = (key: string) => form.querySelector<HTMLInputElement>(`[name=${key}]`)!.value.trim();
    const submit = async () => {
      if (on("port") && val("port") && !/^\d+$/.test(val("port"))) return toast("포트는 1~65535 사이 숫자로 입력하세요", "error");
      const port = on("port") && val("port") ? Number(val("port")) : null;
      if (port !== null && (port < 1 || port > 65535)) return toast("포트는 1~65535 사이 숫자로 입력하세요", "error");
      if (!["username", "port", "credentialId", "folder", "keyMode"].some(on)) return toast("바꿀 항목을 하나 이상 체크하세요", "error");
      const folder = val("folder").split("/").map((p) => p.trim()).filter(Boolean).join("/");
      // `list` was taken when the dialog opened: start from each stored record
      // as it is now (a tab may have linked a credential or touched lastUsed),
      // and leave out sessions deleted meanwhile rather than bring them back.
      const current = list.flatMap((orig) => state.sessions.find((x) => x.id === orig.id) ?? []);
      const gone = list.length - current.length;
      const updated = current.map((orig) => {
        const s = structuredClone(orig);
        if (on("username")) s.username = val("username");
        // A serial session's "port" is its COM port name, not a TCP port.
        if (on("port") && s.protocol !== "serial") s.port = port;
        if (on("credentialId")) s.credentialId = val("credentialId") || null;
        if (on("folder")) s.folder = folder;
        if (on("keyMode") && PROTOCOLS[s.protocol].view === "terminal") s.options = { ...s.options, keyMode: val("keyMode") };
        return s;
      });
      m.close();
      if (updated.length) await upsertSessions(updated);
      this.refocus();
      if (gone) toast(`편집하는 동안 삭제된 세션 ${gone}개는 건너뛰었습니다`, "warn");
      if (updated.length) toast(`세션 ${updated.length}개를 수정했습니다`, "success");
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submit();
    });
    m.root.querySelector("[data-ok]")!.addEventListener("click", submit);
  }

  private async bulkDelete(list: Session[]) {
    const names = list.slice(0, 6).map((s) => `<b>${esc(s.name)}</b>`).join(", ") + (list.length > 6 ? ` 외 ${list.length - 6}개` : "");
    const ok = await confirmDialog({
      title: `세션 ${list.length}개 삭제`,
      message: `${names} 세션을 목록에서 삭제합니다. 열려 있는 탭은 그대로 유지됩니다.`,
      confirm: `${list.length}개 삭제`,
      danger: true,
    });
    if (ok) await removeSessions(list.map((s) => s.id));
    this.refocus();
  }

  /** Snapshot of the copied session, so later edits to the original don't change what gets pasted. */
  private clip: Session | null = null;

  private copySession(s: Session) {
    this.clip = structuredClone(s);
    toast(`"${s.name}" 세션을 복사했습니다. Ctrl+V로 붙여넣을 때마다 새 세션이 만들어집니다`, "info");
  }

  /** Paste `from` (default: the copied session) into `folder` as a new session with a free name. */
  private async pasteSession(folder: string, from: Session | null = this.clip) {
    if (!from) return;
    const base = from.name.replace(/ \(\d+\)$/, "");
    const taken = new Set(state.sessions.map((x) => x.name));
    let n = 2;
    while (taken.has(`${base} (${n})`)) n++;
    const copy: Session = { ...structuredClone(from), id: crypto.randomUUID(), name: `${base} (${n})`, folder, lastUsed: null, createdAt: Date.now() };
    collapsed.delete(folder);
    saveCollapsed();
    await upsertSession(copy);
    this.select([copy.id], copy.id);
    this.render();
    this.reveal(copy.id);
  }

  private async deleteSession(s: Session) {
    const ok = await confirmDialog({
      title: "세션 삭제",
      message: `<b>${esc(s.name)}</b> 세션을 목록에서 삭제합니다. 열려 있는 탭은 그대로 유지됩니다.`,
      confirm: "삭제",
      danger: true,
    });
    if (ok) await removeSession(s.id);
  }

  private async newFolder(parent: string) {
    const res = await promptDialog({
      title: parent ? `"${parent}" 안에 폴더 만들기` : "새 폴더",
      label: "폴더 이름",
      icon: "FolderPlus",
      confirm: "만들기",
    });
    const name = res?.value.trim().replace(/\//g, "-");
    if (!name) return;
    addFolder(parent ? `${parent}/${name}` : name);
  }

  private async renameFolder(path: string) {
    const res = await promptDialog({ title: "폴더 이름 바꾸기", label: "새 이름", value: path.split("/").pop(), confirm: "바꾸기" });
    const name = res?.value.trim().replace(/\//g, "-");
    if (!name) return;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    await renameFolder(path, parent + name);
  }

  private async deleteFolder(path: string) {
    const inside = state.sessions.filter((s) => s.folder === path || s.folder.startsWith(path + "/")).length;
    const ok = await confirmDialog({
      title: "폴더 삭제",
      message: `<b>${esc(path)}</b> 폴더를 삭제합니다.${inside ? `<br>안에 있는 세션 ${inside}개는 상위 폴더로 옮겨지며 삭제되지 않습니다.` : ""}`,
      confirm: "삭제",
      danger: true,
    });
    if (ok) await deleteFolder(path);
  }

  private onKey(e: KeyboardEvent) {
    // A row's own button (connect) handles its keys; the tree must not act
    // on the selected session as well.
    if (e.target !== this.tree) return;
    const s = this.selected ? this.session(this.selected) : undefined;
    const ids = this.visibleIds();
    // Shortcuts of the tree (keymap.ts; the user can change them). Arrows and Esc are fixed.
    const act = actionFor(e, "tree");
    if (act === "tree.moveUp" || act === "tree.moveDown") {
      e.preventDefault();
      return void this.nudge(act === "tree.moveUp" ? -1 : 1);
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = this.selected ? ids.indexOf(this.selected) : -1;
      const next = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (!next) return;
      // Shift+arrow extends the selection from the anchor.
      if (e.shiftKey && this.anchor && ids.includes(this.anchor)) {
        const [a, b] = [ids.indexOf(this.anchor), ids.indexOf(next)];
        this.select(ids.slice(Math.min(a, b), Math.max(a, b) + 1), next, this.anchor);
      } else {
        this.select([next], next);
      }
      this.reveal(next);
      return;
    }
    if (act === "tree.selectAll") {
      e.preventDefault();
      return this.select(ids, this.selected ?? ids[0] ?? null);
    }
    if (e.key === "Escape" && this.picked.size > 1) return this.select(this.selected ? [this.selected] : [], this.selected);
    if (this.picked.size > 1) {
      const list = this.pickedSessions();
      if (act === "tree.delete") return void this.bulkDelete(list);
      if (act === "tree.edit") return this.bulkEdit(list);
      if (act === "tree.connect") return list.forEach((x) => this.actions.connect(x));
    }
    if (act === "tree.paste" && this.clip) {
      e.preventDefault();
      return void this.pasteSession(s ? s.folder : this.clip.folder);
    }
    if (!s) return;
    if (act === "tree.copy") {
      e.preventDefault();
      return this.copySession(s);
    }
    if (act === "tree.connect") this.actions.connect(s);
    if (act === "tree.edit") this.actions.edit(s);
    if (act === "tree.delete") this.deleteSession(s);
  }
}
