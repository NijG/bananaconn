// Workspace: tabs, split layouts and input broadcast.
//
// Every open connection is a Tab owning a View. The content area is divided
// into 1, 2 or 4 slots; each slot shows one tab. Clicking a tab shows it in the
// focused slot (or focuses the slot already showing it). Tabs can be dragged
// onto a slot to place them there.

import { icon } from "./icons";
import { PROTOCOLS, type Protocol, type Session } from "./model";
import { copyAddresses } from "./clipboard";
import { keyHint } from "./keymap";
import { userText } from "./i18nTables";
import { state, updateSettings } from "./store";
import { confirmDialog, contextMenu, esc, h, promptDialog, toast } from "./ui";

export type ViewState = "connecting" | "connected" | "closed" | "error";

export interface StatusInfo {
  protocol: Protocol;
  endpoint: string;
  state: ViewState;
  detail?: string;
  logPath?: string | null;
  /** Remote CPU/memory of an SSH tab (status bar monitor). */
  monitor?: MonitorInfo | null;
  /** The device the monitor recognised ("Cisco IOS-XE 17.06" …). */
  device?: string;
}

export type MonitorInfo =
  | { kind: "stats"; cpu: number; memUsed: number; memTotal: number; memPercent?: number; diskUsed?: number; diskTotal?: number; warmup: boolean }
  /** Waiting, or needs the user: login (password), hostkey (approve), or a message. */
  | { kind: "starting" | "login" | "hostkey" | "unsupported" | "error"; message?: string; fingerprint?: string; needUser?: boolean };

/** What typing at a terminal's cursor goes into (View.inputKind), judged as
 * a line is started: a session past its login ("shell": a command line, a
 * running program), one before it ("prelogin": a banner, a menu, nothing
 * shown yet), a choice a command asks ("[y/N]", "[confirm]"), or a
 * question asking for a user name, a secret (password,
 * passphrase, one-time code, also an enable or sudo password) or a host key. */
export type InputKind = "shell" | "prelogin" | "user" | "secret" | "hostkey" | "confirm";

/** What one terminal's user typed or pasted, replayed in the others. Pastes are
 * sent as text so each target applies its own bracketed-paste mode. */
export type BroadcastInput = (
  | { keys: string }
  | { paste: string }
  /** An editing key whose bytes depend on each target's key mode. */
  | { editKey: EditKey }
) & {
  /** The kind of line it was typed at: a tab whose own line has become
   * another kind by the time an Enter arrives (a console that timed out to
   * "Username:") gets the keys before it, not the Enter. */
  kind?: InputKind;
};

export type EditKey = "Delete" | "Home" | "End" | "Backspace";

export interface View {
  el: HTMLElement;
  state: ViewState;
  title(): string;
  status(): StatusInfo;
  /** Called after the view becomes visible or its slot is resized. */
  layout?(): void;
  /** The view went on screen or off it (another tab, minimised window). */
  shownChanged?(shown: boolean): void;
  focus?(): void;
  /** Terminal views accept broadcast input from another terminal: true when
   * it was sent, false when held (its line is of another kind). */
  receiveBroadcast?(input: BroadcastInput): boolean;
  /** Turn this tab's log on for a risky command sent to it; false when it could not start. */
  ensureLog?(): Promise<boolean>;
  /** Why closing this tab would lose work (pending uploads, unsaved edits), if so. */
  closeWarning?(): string | null;
  reconnect?(): void;
  /** Status bar monitor chip clicked (log in, approve host key, retry). */
  monitorAction?(): void;
  /** The connection it is on now (a new one after a reconnect), for a
   * check that input confirmed in a dialog still goes where it was meant to. */
  connectionId?(): string;
  /** What typing at its cursor goes into now (InputKind); null while not
   * connected. Broadcast goes only between tabs of the same kind: a command must never
   * land at a login or password question (each a failed login), and what is
   * typed at one must never land in a shell. */
  inputKind?(): InputKind | null;
  /** A short mark on the tab (a work timer's time left), or null. `alert`
   * draws attention to it; `title` explains it. */
  badge?(): { text: string; alert: boolean; title: string } | null;
  dispose(): void;
}

/** Two views whose input goes into the same kind of line (see View.inputKind). */
function samePhase(a: View, b: View): boolean {
  const kind = a.inputKind?.();
  return !!kind && kind === b.inputKind?.();
}

export interface Tab {
  id: string;
  session: Session;
  view: View;
  el: HTMLElement;
  /** A name the user gave this tab (tab menu), shown instead of the view's
   * title while the tab is open. */
  label?: string;
  /** Left out of broadcast input (tab menu): it neither gets what is typed in
   * the others nor sends what is typed in it. While the tab is open. */
  noBroadcast?: boolean;
}

export type Layout = "single" | "cols" | "rows" | "grid";
const SLOT_COUNT: Record<Layout, number> = { single: 1, cols: 2, rows: 2, grid: 4 };

type Listener = () => void;

export class Workspace {
  tabs: Tab[] = [];
  layout: Layout = "single";
  slots: (string | null)[] = [null];
  focused = 0;
  broadcast = false;

  private listeners = new Set<Listener>();
  private tabBar: HTMLElement;
  private grid: HTMLElement;
  private home: HTMLElement;
  private slotEls: HTMLElement[] = [];
  private dragTab: string | null = null;

  constructor(tabBar: HTMLElement, grid: HTMLElement, home: HTMLElement) {
    this.tabBar = tabBar;
    // The bar hides its scrollbar: let the mouse wheel scroll it sideways.
    tabBar.addEventListener(
      "wheel",
      (e) => {
        if (tabBar.scrollWidth <= tabBar.clientWidth) return;
        e.preventDefault();
        tabBar.scrollLeft += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      },
      { passive: false },
    );
    this.grid = grid;
    this.home = home;
    new ResizeObserver(() => this.layoutVisible()).observe(grid);
    document.addEventListener("visibilitychange", () => this.notifyShown());
    this.buildSlots();
  }

  onChange(fn: Listener) {
    this.listeners.add(fn);
  }

  /** Views call this when their state or title changes. */
  changed() {
    this.renderTabs();
    this.listeners.forEach((fn) => fn());
  }

  get activeTab(): Tab | undefined {
    const id = this.slots[this.focused];
    return this.tabs.find((t) => t.id === id);
  }

  visibleTabs(): Tab[] {
    return this.slots.map((id) => this.tabs.find((t) => t.id === id)).filter((t): t is Tab => !!t);
  }

  add(session: Session, view: View): Tab {
    const tab: Tab = { id: crypto.randomUUID(), session, view, el: h("div", { class: "tab", draggable: "true" }) };
    this.tabs.push(tab);
    this.wireTab(tab);
    this.activate(tab.id);
    return tab;
  }

  /** Add a tab and show it next to `anchor` (switching to two panes if needed),
   * keeping the anchor's pane focused. */
  addBeside(session: Session, view: View, anchor: View): Tab {
    const tab: Tab = { id: crypto.randomUUID(), session, view, el: h("div", { class: "tab", draggable: "true" }) };
    this.tabs.push(tab);
    this.wireTab(tab);
    const anchorId = this.tabs.find((t) => t.view === anchor)?.id;
    if (this.layout === "single") this.setLayout("cols");
    const at = anchorId ? this.slots.indexOf(anchorId) : -1;
    // An empty pane first; only then one showing another tab.
    const empty = this.slots.findIndex((sl, i) => i !== at && !sl);
    const target = at < 0 ? this.focused : empty >= 0 ? empty : this.slots.findIndex((_, i) => i !== at);
    this.slots[target] = tab.id;
    if (at >= 0) this.focused = at;
    this.placeViews();
    this.activeTab?.view.focus?.();
    this.changed();
    return tab;
  }

  /** Bring the tab showing this view to the front. */
  focusView(view: View) {
    const tab = this.tabs.find((t) => t.view === view);
    if (tab) this.activate(tab.id);
  }

  activate(id: string) {
    // A tab closed meanwhile (picked from a list made before) must not take a slot.
    if (!this.tabs.some((t) => t.id === id)) return;
    const existing = this.slots.indexOf(id);
    if (existing >= 0) {
      this.focused = existing;
    } else {
      this.slots[this.focused] = id;
    }
    this.placeViews();
    this.activeTab?.view.focus?.();
    this.changed();
  }

  focusSlot(i: number) {
    if (i === this.focused) return;
    this.focused = i;
    this.highlightFocus();
    this.activeTab?.view.focus?.();
    this.changed();
  }

  async close(id: string, force = false) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    // Lost work is always asked about; an open connection only if the user wants that.
    const warning = tab.view.closeWarning?.() ?? null;
    if (!force && (warning || (state.settings.confirmClose && tab.view.state === "connected"))) {
      const ok = await confirmDialog({
        title: warning ? "닫으면 작업이 사라집니다" : "연결된 탭 닫기",
        message: warning
          ? `<b data-i18n-skip>${esc(this.tabTitles().get(tab.id) ?? tab.view.title())}</b>: <span>${esc(warning)}</span><br>그래도 탭을 닫을까요?`
          : `<b data-i18n-skip>${esc(this.tabTitles().get(tab.id) ?? tab.view.title())}</b> 연결이 아직 열려 있습니다. 탭을 닫고 연결을 끊을까요?`,
        confirm: "닫기",
        danger: true,
        // Unsaved work is always asked about; an open connection can stop asking.
        dontAsk: warning
          ? undefined
          : () => {
              updateSettings({ confirmClose: false });
              toast("이제 연결된 탭도 묻지 않고 닫습니다. 설정에서 다시 켤 수 있습니다", "info");
            },
      });
      if (!ok) return;
    }
    // Remember the session so the tab can be reopened (Ctrl+Shift+T).
    this.closedStack.push(tab.session);
    if (this.closedStack.length > 20) this.closedStack.shift();
    tab.view.dispose();
    tab.view.el.remove();
    tab.el.remove();
    this.tabs = this.tabs.filter((t) => t.id !== id);
    const slot = this.slots.indexOf(id);
    if (slot >= 0) {
      this.slots[slot] = this.nextHiddenTab() ?? null;
      if (!this.slots[this.focused]) {
        const filled = this.slots.findIndex((s) => s);
        if (filled >= 0) this.focused = filled;
      }
    }
    this.placeViews();
    // The closed tab's input had the focus: give it to the tab shown now.
    this.activeTab?.view.focus?.();
    this.changed();
  }

  async closeOthers(id: string) {
    await this.closeTabs(this.tabs.filter((t) => t.id !== id), "다른 탭 모두 닫기");
  }

  /** Close the tabs after `id` in the tab bar. */
  async closeRight(id: string) {
    const at = this.tabs.findIndex((t) => t.id === id);
    if (at >= 0) await this.closeTabs(this.tabs.slice(at + 1), "오른쪽 탭 모두 닫기");
  }

  /** Close several tabs, asking first (titled `title`) when some are
   * connected or have work left, as closing one tab does. */
  private async closeTabs(tabs: Tab[], title: string) {
    const live = tabs.filter((t) => t.view.state === "connected" || t.view.closeWarning?.());
    if (live.length && (state.settings.confirmClose || live.some((t) => t.view.closeWarning?.()))) {
      const ok = await confirmDialog({
        title,
        message: `연결 중이거나 작업이 남은 탭 ${live.length}개도 닫힙니다.<br><span class="muted" data-i18n-skip>${live
          .slice(0, 5)
          .map((t) => esc(this.tabTitles().get(t.id) ?? t.view.title()))
          .join(", ")}</span>${live.length > 5 ? ` 외 ${live.length - 5}개` : ""}`,
        confirm: "모두 닫기",
        danger: true,
      });
      if (!ok) return;
    }
    for (const t of tabs) await this.close(t.id, true);
  }

  setLayout(layout: Layout) {
    this.layout = layout;
    const count = SLOT_COUNT[layout];
    const kept = this.slots.slice(0, count);
    while (kept.length < count) kept.push(null);
    // Fill empty slots with tabs that are not visible yet.
    for (let i = 0; i < kept.length; i++) {
      if (!kept[i]) kept[i] = this.tabs.find((t) => !kept.includes(t.id))?.id ?? null;
    }
    this.slots = kept;
    this.focused = Math.min(this.focused, count - 1);
    this.buildSlots();
    this.placeViews();
    this.changed();
  }

  toggleBroadcast() {
    this.broadcast = !this.broadcast;
    this.grid.classList.toggle("broadcasting", this.broadcast);
    this.changed();
  }

  /** Called by a terminal view for every keystroke it sends. */
  /** Terminal tabs that receive broadcast input: every connected terminal tab,
   * shown or not (with one pane only the active tab is shown, and broadcast
   * then had nothing to send to). */
  broadcastTargets(): Tab[] {
    return this.tabs.filter((t) => t.view.receiveBroadcast && t.view.state === "connected" && !t.noBroadcast);
  }

  /** The other tabs that input typed in `from` is mirrored to (none unless
   * broadcast is on and `from` is the terminal the user is working in). */
  mirrorTargets(from: View, sameKind = true): Tab[] {
    if (!this.broadcast || this.activeTab?.view !== from || this.activeTab.noBroadcast) return [];
    return this.broadcastTargets().filter((t) => t.view !== from && (!sameKind || samePhase(t.view, from)));
  }

  /** The tab bar again (which tabs broadcast reaches, as a line is started). */
  tabsChanged() {
    this.renderTabs();
  }

  cycle(step: number) {
    if (this.tabs.length < 2) return;
    const cur = this.tabs.findIndex((t) => t.id === this.slots[this.focused]);
    const next = this.tabs[(cur + step + this.tabs.length) % this.tabs.length];
    this.activate(next.id);
  }

  // ---- rendering ---------------------------------------------------------

  private nextHiddenTab(): string | undefined {
    return this.tabs.find((t) => !this.slots.includes(t.id))?.id;
  }

  private buildSlots() {
    this.grid.innerHTML = "";
    this.grid.className = `slots layout-${this.layout}${this.broadcast ? " broadcasting" : ""}`;
    this.slotEls = this.slots.map((_, i) => {
      const slot = h("div", { class: "slot" });
      slot.addEventListener("mousedown", () => this.focusSlot(i), true);
      slot.addEventListener("dragover", (e) => {
        if (!this.dragTab) return;
        e.preventDefault();
        slot.classList.add("drop-target");
      });
      slot.addEventListener("dragleave", () => slot.classList.remove("drop-target"));
      slot.addEventListener("drop", (e) => {
        slot.classList.remove("drop-target");
        if (!this.dragTab) return;
        e.preventDefault();
        const from = this.slots.indexOf(this.dragTab);
        if (from >= 0) this.slots[from] = this.slots[i];
        this.slots[i] = this.dragTab;
        this.focused = i;
        this.placeViews();
        this.activeTab?.view.focus?.();
        this.changed();
      });
      this.grid.appendChild(slot);
      return slot;
    });
  }

  private placeViews() {
    const hasTabs = this.tabs.length > 0;
    this.home.hidden = hasTabs;
    this.grid.hidden = !hasTabs;
    // Park every view, then mount the visible ones into their slots.
    const parking = document.getElementById("view-parking")!;
    for (const t of this.tabs) if (!this.slots.includes(t.id)) parking.appendChild(t.view.el);
    this.slots.forEach((id, i) => {
      const slot = this.slotEls[i];
      const tab = this.tabs.find((t) => t.id === id);
      slot.querySelector(".slot-empty")?.remove();
      if (tab) {
        if (tab.view.el.parentElement !== slot) {
          slot.querySelectorAll(":scope > .view").forEach((v) => parking.appendChild(v));
          slot.appendChild(tab.view.el);
        }
      } else {
        slot.querySelectorAll(":scope > .view").forEach((v) => parking.appendChild(v));
        slot.appendChild(
          h("div", { class: "slot-empty" }, `${icon("LayoutGrid", 28)}<p>탭을 클릭하거나 이곳으로 끌어 놓으세요</p>`),
        );
      }
    });
    this.highlightFocus();
    this.layoutVisible();
    this.notifyShown();
  }

  /** Last on-screen state reported to each view. */
  private shownState = new WeakMap<View, boolean>();
  /** Tell views that went on or off screen; a hidden window hides them all. */
  private notifyShown() {
    for (const t of this.tabs) {
      const shown = !document.hidden && this.slots.includes(t.id);
      if (this.shownState.get(t.view) === shown) continue;
      this.shownState.set(t.view, shown);
      t.view.shownChanged?.(shown);
    }
  }

  private highlightFocus() {
    this.slotEls.forEach((s, i) => s.classList.toggle("focused", i === this.focused && this.slots.length > 1));
    this.renderTabs();
  }

  private layoutVisible() {
    requestAnimationFrame(() => this.visibleTabs().forEach((t) => t.view.layout?.()));
  }

  private wireTab(tab: Tab) {
    tab.el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-close]")) return;
      this.activate(tab.id);
    });
    tab.el.addEventListener("auxclick", (e) => {
      if (e.button === 1) this.close(tab.id);
    });
    // Double-click: open the same session again in a new tab (keep this one).
    tab.el.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("[data-close]")) return;
      this.duplicateHandler?.(tab.session);
    });
    tab.el.querySelector("[data-close]")?.addEventListener("click", () => this.close(tab.id));
    tab.el.addEventListener("dragstart", (e) => {
      this.dragTab = tab.id;
      e.dataTransfer?.setData("text/plain", tab.id);
      tab.el.classList.add("dragging");
    });
    tab.el.addEventListener("dragend", () => {
      this.dragTab = null;
      tab.el.classList.remove("dragging");
    });
    tab.el.addEventListener("dragover", (e) => {
      if (this.dragTab && this.dragTab !== tab.id) e.preventDefault();
    });
    tab.el.addEventListener("drop", (e) => {
      if (!this.dragTab || this.dragTab === tab.id) return;
      e.preventDefault();
      // Reorder: move the dragged tab before this one. Guard a stale drag source
      // (findIndex === -1), or splice(-1, 1) would remove the wrong (last) tab.
      const from = this.tabs.findIndex((t) => t.id === this.dragTab);
      if (from < 0) return;
      const [moved] = this.tabs.splice(from, 1);
      this.tabs.splice(this.tabs.indexOf(tab), 0, moved);
      this.renderTabs();
    });
    tab.el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const saved = state.sessions.find((s) => s.id === tab.session.id);
      contextMenu(e.clientX, e.clientY, [
        { label: "다시 연결", icon: "RotateCw", hint: keyHint("tab.reconnect"), action: () => tab.view.reconnect?.(), disabled: !tab.view.reconnect },
        { label: "같은 세션 하나 더 열기", icon: "CopyPlus", hint: keyHint("tab.duplicate") || "더블클릭", action: () => this.duplicateHandler?.(tab.session) },
        // The saved session behind the tab; a quick connection can become one
        // (one deleted since cannot be edited).
        !saved && tab.session.id.startsWith("quick-")
          ? { label: "세션으로 저장…", icon: "Save", action: () => this.saveAsHandler?.(tab.session), disabled: !this.saveAsHandler }
          : { label: "세션 편집…", icon: "Pencil", action: () => saved && this.editHandler?.(saved), disabled: !saved || !this.editHandler },
        { label: "주소 복사", icon: "ClipboardList", action: () => void copyAddresses([tab.session]) },
        { label: "탭 이름 바꾸기…", icon: "Pencil", action: () => void this.renameTab(tab) },
        // Broadcast to some of the open terminals: the others are left out.
        ...(tab.view.receiveBroadcast
          ? [
              tab.noBroadcast
                ? { label: "동시 입력에 다시 넣기", icon: "Radio", action: () => this.setNoBroadcast(tab, false) }
                : { label: "동시 입력에서 빼기", icon: "Ban", action: () => this.setNoBroadcast(tab, true) },
            ]
          : []),
        "-",
        { label: "탭 닫기", icon: "X", hint: keyHint("tab.close"), action: () => this.close(tab.id) },
        { label: "다른 탭 모두 닫기", icon: "X", hint: keyHint("tab.closeOthers"), action: () => this.closeOthers(tab.id), disabled: this.tabs.length < 2 },
        { label: "오른쪽 탭 모두 닫기", icon: "X", action: () => this.closeRight(tab.id), disabled: this.tabs.indexOf(tab) === this.tabs.length - 1 },
      ]);
    });
  }

  private setNoBroadcast(tab: Tab, out: boolean) {
    tab.noBroadcast = out || undefined;
    this.changed();
    const name = userText(this.tabTitles().get(tab.id) ?? tab.view.title());
    toast(out ? `${name}: 동시 입력에서 뺐습니다` : `${name}: 동시 입력에 다시 넣었습니다`, "info", 2500);
  }

  /** Give a tab a name of its own (empty: back to the session's). */
  private async renameTab(tab: Tab) {
    const res = await promptDialog({
      title: "탭 이름 바꾸기",
      label: "탭 이름",
      value: tab.label ?? tab.view.title(),
      confirm: "바꾸기",
      extra: `<p class="muted small">비우면 원래 이름으로 돌아갑니다. 바꾼 이름은 탭을 닫을 때까지만 유지됩니다.</p>`,
    });
    if (!res || !this.tabs.includes(tab)) return;
    const name = res.value.trim();
    tab.label = name && name !== tab.view.title() ? name : undefined;
    this.changed();
  }

  /** Set by the app to reopen a session from the tab menu. */
  duplicateHandler: ((s: Session) => void) | null = null;
  /** Set by the app to open the session editor on a new session filled in
   * (an address clicked in a terminal's output). */
  newSessionHandler: ((defaults: Partial<Session>) => void) | null = null;
  /** Set by the app to open the session editor from the tab menu. */
  editHandler: ((s: Session) => void) | null = null;
  /** Set by the app to save a quick connection's settings as a new session. */
  saveAsHandler: ((s: Session) => void) | null = null;


  /** Sessions of recently closed tabs, for "reopen closed tab" (Ctrl+Shift+T). */
  private closedStack: Session[] = [];

  /** Reopen the most recently closed tab; false when there is none to reopen. */
  reopenLastClosed(): boolean {
    while (this.closedStack.length) {
      const session = this.closedNow(this.closedStack.pop()!);
      if (!session) continue;
      this.duplicateHandler?.(session);
      return true;
    }
    return false;
  }

  /** A closed tab's session as it is now: the saved one, so edits made since
   * apply (a corrected user or credential is not the refused one sent again)
   * and a deleted one is gone; a quick connection's own copy otherwise. */
  private closedNow(s: Session): Session | null {
    if (s.id.startsWith("quick-")) return s;
    return state.sessions.find((x) => x.id === s.id) ?? null;
  }

  /** Sessions of recently closed tabs, newest first, each once (the command palette). */
  recentlyClosed(limit = 5): Session[] {
    const seen = new Set<string>();
    const out: Session[] = [];
    for (let i = this.closedStack.length - 1; i >= 0 && out.length < limit; i--) {
      const s = this.closedNow(this.closedStack[i]);
      if (!s || seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
    return out;
  }

  /** Reopen a closed tab's session picked from recentlyClosed(), as
   * reopenLastClosed() does; it leaves the closed list. */
  reopenClosed(session: Session) {
    this.closedStack = this.closedStack.filter((s) => s.id !== session.id);
    const now = this.closedNow(session);
    if (now) this.duplicateHandler?.(now);
  }

  /** Each tab's title as the tab bar shows it. The same session opened twice
   * shows the same title: the later ones are numbered, in tab order ("web",
   * "web (2)"), so they can be told apart. */
  tabTitles(): Map<string, string> {
    const seen = new Map<string, number>();
    const titles = new Map<string, string>();
    for (const t of this.tabs) {
      const base = t.label || t.view.title();
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      titles.set(t.id, n > 1 ? `${base} (${n})` : base);
    }
    return titles;
  }

  /** The name the tab bar shows for a view's tab (the user's label, numbered
   * like the bar), for messages that must say which tab they are about. */
  nameOf(view: View): string {
    const tab = this.tabs.find((t) => t.view === view);
    return (tab && this.tabTitles().get(tab.id)) ?? view.title();
  }

  private renderTabs() {
    const active = this.slots[this.focused];
    const titles = this.tabTitles();
    for (const t of this.tabs) {
      const p = PROTOCOLS[t.session.protocol];
      const title = titles.get(t.id)!;
      const shownElsewhere = this.slots.includes(t.id) && t.id !== active;
      // Marked when what is typed in the active tab reaches it (see mirrorTargets).
      const from = this.activeTab?.view;
      // Not a tab left out, and nothing at all while the tab typed in is one.
      const receives =
        this.broadcast && !!t.view.receiveBroadcast && t.view.state === "connected" && !t.noBroadcast && !this.activeTab?.noBroadcast && (!from || samePhase(t.view, from));
      t.el.className = `tab state-${t.view.state}${t.id === active ? " active" : ""}${shownElsewhere ? " visible" : ""}${receives ? " broadcasting" : ""}${this.broadcast && t.noBroadcast ? " no-broadcast" : ""}`;
      t.el.style.setProperty("--proto", p.color);
      // The address is the user's: kept as written in the translated tooltip.
      t.el.title = `${p.label} · ${userText(t.view.status().endpoint)}${t.noBroadcast ? " · 동시 입력에서 뺌" : ""}`;
      // The protocol shows as the dot's color and in the tooltip; the label
      // itself cost too much width with many tabs open.
      const html = `<span class="tab-dot"></span>
        <span class="tab-title" data-i18n-skip>${esc(title)}</span>
        <span class="tab-badge" hidden></span>
        <button class="tab-close" data-close title="닫기">${icon("X", 13)}</button>`;
      if (t.el.dataset.html !== html) {
        t.el.innerHTML = html;
        t.el.dataset.html = html;
        t.el.querySelector("[data-close]")!.addEventListener("click", (e) => {
          e.stopPropagation();
          this.close(t.id);
        });
      }
      this.renderBadge(t);
      if (t.el.parentElement !== this.tabBar) this.tabBar.appendChild(t.el);
    }
    // Keep DOM order in sync with the tab array (moving nodes only when it differs).
    const order = this.tabBar.querySelectorAll(":scope > .tab");
    if (order.length !== this.tabs.length || this.tabs.some((t, i) => order[i] !== t.el)) {
      this.tabs.forEach((t) => this.tabBar.appendChild(t.el));
    }
    // Keep the active tab in view when the bar overflows.
    if (active !== this.shownTab) {
      this.shownTab = active ?? null;
      this.tabs.find((t) => t.id === active)?.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  /** A view's badge changed (a timer ticking): that tab's mark only, not the
   * whole bar, so a click on the tab is never lost to a redraw. */
  badgeChanged(view: View) {
    const t = this.tabs.find((x) => x.view === view);
    if (t) this.renderBadge(t);
  }

  private renderBadge(t: Tab) {
    const el = t.el.querySelector<HTMLElement>(".tab-badge");
    if (!el) return;
    const b = t.view.badge?.() ?? null;
    el.hidden = !b;
    if (!b) return;
    if (el.textContent !== b.text) el.textContent = b.text;
    el.classList.toggle("alert", b.alert);
    if (el.dataset.title !== b.title) {
      // Kept to compare: the attribute itself is translated on screen.
      el.dataset.title = b.title;
      el.title = b.title;
    }
  }

  /** Last tab scrolled into view (scrolling only when the active tab changes). */
  private shownTab: string | null = null;
}
