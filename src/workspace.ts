// Workspace: tabs, split layouts and input broadcast.
//
// Every open connection is a Tab owning a View. The content area is divided
// into 1, 2 or 4 slots; each slot shows one tab. Clicking a tab shows it in the
// focused slot (or focuses the slot already showing it). Tabs can be dragged
// onto a slot to place them there.

import { icon } from "./icons";
import { PROTOCOLS, type Protocol, type Session } from "./model";
import { state, updateSettings } from "./store";
import { confirmDialog, contextMenu, esc, h, toast } from "./ui";

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

/** What one terminal's user typed or pasted, replayed in the others. Pastes are
 * sent as text so each target applies its own bracketed-paste mode. */
export type BroadcastInput =
  | { keys: string }
  | { paste: string }
  /** An editing key whose bytes depend on each target's key mode. */
  | { editKey: EditKey };

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
  /** Terminal views accept broadcast input from another terminal. */
  receiveBroadcast?(input: BroadcastInput): void;
  /** Turn this tab's log on for a risky command sent to it; false when it could not start. */
  ensureLog?(): Promise<boolean>;
  /** Why closing this tab would lose work (pending uploads, unsaved edits), if so. */
  closeWarning?(): string | null;
  reconnect?(): void;
  /** Status bar monitor chip clicked (log in, approve host key, retry). */
  monitorAction?(): void;
  dispose(): void;
}

export interface Tab {
  id: string;
  session: Session;
  view: View;
  el: HTMLElement;
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
          ? `<b>${esc(tab.view.title())}</b>: ${esc(warning)}<br>그래도 탭을 닫을까요?`
          : `<b>${esc(tab.view.title())}</b> 연결이 아직 열려 있습니다. 탭을 닫고 연결을 끊을까요?`,
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
    const others = this.tabs.filter((t) => t.id !== id);
    const live = others.filter((t) => t.view.state === "connected" || t.view.closeWarning?.());
    if (live.length && (state.settings.confirmClose || live.some((t) => t.view.closeWarning?.()))) {
      const ok = await confirmDialog({
        title: "다른 탭 모두 닫기",
        message: `연결 중이거나 작업이 남은 탭 ${live.length}개도 닫힙니다.<br><span class="muted">${live
          .slice(0, 5)
          .map((t) => esc(t.view.title()))
          .join(", ")}${live.length > 5 ? " 외" : ""}</span>`,
        confirm: "모두 닫기",
        danger: true,
      });
      if (!ok) return;
    }
    for (const t of others) await this.close(t.id, true);
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
    return this.tabs.filter((t) => t.view.receiveBroadcast && t.view.state === "connected");
  }

  /** The other tabs that input typed in `from` is mirrored to (none unless
   * broadcast is on and `from` is the terminal the user is working in). */
  mirrorTargets(from: View): Tab[] {
    if (!this.broadcast || this.activeTab?.view !== from) return [];
    return this.broadcastTargets().filter((t) => t.view !== from);
  }

  mirrorInput(from: View, input: BroadcastInput) {
    for (const t of this.mirrorTargets(from)) t.view.receiveBroadcast!(input);
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
      contextMenu(e.clientX, e.clientY, [
        { label: "다시 연결", icon: "RotateCw", action: () => tab.view.reconnect?.(), disabled: !tab.view.reconnect },
        { label: "같은 세션 하나 더 열기", icon: "Copy", hint: "더블클릭", action: () => this.duplicateHandler?.(tab.session) },
        "-",
        { label: "탭 닫기", icon: "X", hint: "Ctrl+F4", action: () => this.close(tab.id) },
        { label: "다른 탭 모두 닫기", icon: "X", action: () => this.closeOthers(tab.id), disabled: this.tabs.length < 2 },
      ]);
    });
  }

  /** Set by the app to reopen a session from the tab menu. */
  duplicateHandler: ((s: Session) => void) | null = null;

  private renderTabs() {
    const active = this.slots[this.focused];
    for (const t of this.tabs) {
      const p = PROTOCOLS[t.session.protocol];
      const shownElsewhere = this.slots.includes(t.id) && t.id !== active;
      const receives = this.broadcast && !!t.view.receiveBroadcast && t.view.state === "connected";
      t.el.className = `tab state-${t.view.state}${t.id === active ? " active" : ""}${shownElsewhere ? " visible" : ""}${receives ? " broadcasting" : ""}`;
      t.el.style.setProperty("--proto", p.color);
      t.el.title = `${p.label} · ${t.view.status().endpoint}`;
      // The protocol shows as the dot's color and in the tooltip; the label
      // itself cost too much width with many tabs open.
      const html = `<span class="tab-dot"></span>
        <span class="tab-title" data-i18n-skip>${esc(t.view.title())}</span>
        <button class="tab-close" data-close title="닫기">${icon("X", 13)}</button>`;
      if (t.el.dataset.html !== html) {
        t.el.innerHTML = html;
        t.el.dataset.html = html;
        t.el.querySelector("[data-close]")!.addEventListener("click", (e) => {
          e.stopPropagation();
          this.close(t.id);
        });
      }
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

  /** Last tab scrolled into view (scrolling only when the active tab changes). */
  private shownTab: string | null = null;
}
