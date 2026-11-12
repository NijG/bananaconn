// Shared UI primitives: element helper, toasts, modal dialogs, context menus,
// and formatting.

import { icon } from "./icons";
import { userText } from "./i18nTables";

/** A cell of text meant for a spreadsheet (a CSV file, a tab-separated copy):
 * a leading = + - @ (or a tab or CR, skipped before one) would make the
 * spreadsheet run it as a formula, so it gets the usual "'" guard that keeps it
 * text. parseCsv (importers.ts) drops the guard again on import. */
export function sheetCell(s: string): string {
  // A value that already starts with "'" before one gets a guard too, so that
  // removing exactly one on import gives it back unchanged ("'=x" stays "'=x").
  return s.replace(/^(?='*[=+\-@\t\r])/, "'");
}

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  html = "",
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (html) el.innerHTML = html;
  return el;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(secs: number | null): string {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function timestamp(): string {
  const d = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function relativeTime(ms: number | null): string {
  if (!ms) return "사용 기록 없음";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "방금 전";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

// ---- toasts --------------------------------------------------------------------

type ToastKind = "info" | "success" | "error" | "warn";
const TOAST_ICON: Record<ToastKind, string> = {
  info: "Info",
  success: "Check",
  error: "TriangleAlert",
  warn: "ShieldAlert",
};

/** At most this many toasts on screen at once, so a burst (repeated errors, a
 * trigger, a broadcast to many tabs) cannot fill the screen. */
const TOAST_MAX = 5;

/** `action`: a button in the toast (clicking it closes the toast and runs it). */
export function toast(message: string, kind: ToastKind = "info", ms = 3800, action?: { label: string; run: () => void }) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = h("div", { id: "toasts" });
    document.body.appendChild(host);
  }
  // Drop the oldest so the stack stays bounded (a detached node's own timers no-op).
  while (host.children.length >= TOAST_MAX) host.firstElementChild!.remove();
  const t = h("div", { class: `toast toast-${kind}` }, `${icon(TOAST_ICON[kind], 16)}<span>${esc(message)}</span>`);
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  const close = () => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 250);
  };
  if (action) {
    const btn = h("button", { class: "btn toast-action" });
    btn.textContent = action.label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      close();
      action.run();
    });
    t.appendChild(btn);
  }
  t.addEventListener("click", close);
  setTimeout(close, ms);
  // For a "working…" toast whose job may end before `ms`.
  return close;
}

/** A search box's text as lower-case terms: "web  Prod" → ["web", "prod"]. */
export const searchTerms = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/** Every term appears somewhere in `hay` (already lower-case), in any order:
 * "web prod" finds a "prod" session on a "web…" host. No terms: everything. */
export const matchesTerms = (hay: string, terms: string[]) => terms.every((t) => hay.includes(t));

/** `text` as HTML with every place a search term is found marked
 * (<mark class="term-hit">), case ignored: which part of a row matched. */
export function markTerms(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  // A letter whose lower case is longer ("İ") would shift the places: unmarked.
  if (!terms.length || lower.length !== text.length) return esc(text);
  const hit = new Array<boolean>(text.length).fill(false);
  for (const t of terms) for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + t.length)) hit.fill(true, i, i + t.length);
  let out = "";
  for (let i = 0; i < text.length; ) {
    let j = i;
    while (j < text.length && hit[j] === hit[i]) j++;
    out += hit[i] ? `<mark class="term-hit">${esc(text.slice(i, j))}</mark>` : esc(text.slice(i, j));
    i = j;
  }
  return out;
}

/** Arrow keys between a search box and the list it filters: ↓ from the box
 * goes to the first item, ↑/↓ move between items, ↑ on the first item goes
 * back to the box. Items are re-read on every key (lists are redrawn). */
export function listKeys(search: HTMLInputElement, list: HTMLElement, itemSelector: string) {
  const items = () => [...list.querySelectorAll<HTMLElement>(itemSelector)];
  search.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown") return;
    const first = items()[0];
    if (!first) return;
    e.preventDefault();
    first.focus();
  });
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && at === 0) return search.focus();
    all[Math.max(0, Math.min(all.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))].focus();
  });
}

/** A toggle button's look ("on") and its state for screen readers, together. */
export function setPressed(el: Element | null, on: boolean) {
  if (!el) return;
  el.classList.toggle("on", on);
  el.setAttribute("aria-pressed", String(on));
}

export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return JSON.stringify(err);
}

// ---- desktop notification & beep -----------------------------------------------

/** Ask for OS-notification permission, once, from a user gesture (a toggle). */
export function ensureNotifyPermission() {
  try {
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  } catch {
    // No Notification API (or blocked): osNotify falls back to a toast.
  }
}

/** Show an OS notification when allowed, otherwise an in-app toast. `body`
 * is the user's text (a tab title), kept as written in the toast. `onClick`
 * (focus the tab that finished) runs when the notification is clicked. */
export function osNotify(title: string, body: string, onClick?: () => void) {
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification(title, { body });
      n.onclick = () => {
        try {
          window.focus();
        } catch {
          // ignore
        }
        onClick?.();
        n.close();
      };
      return;
    }
  } catch {
    // Fall through to the toast.
  }
  toast(`${title} — ${userText(body)}`, "info", 5000);
}

/** Whether osNotify shows a Windows notification (permission given), not a toast. */
export function canOsNotify(): boolean {
  try {
    return "Notification" in window && Notification.permission === "granted";
  } catch {
    return false;
  }
}

/** Flash the app's taskbar button until the window is brought to the front
 * (nothing when it is in front already). Best-effort. */
export function requestAttention() {
  if (document.hasFocus()) return;
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow, UserAttentionType }) => getCurrentWindow().requestUserAttention(UserAttentionType.Critical))
    .catch(() => {});
}

/** A short beep (trigger rules). Best-effort: silent when audio is unavailable. */
export function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    osc.onended = () => void ctx.close();
  } catch {
    // No audio: a trigger beep is best-effort.
  }
}

// ---- modal ---------------------------------------------------------------------

// Open modals, topmost last. Only the topmost one reacts to Escape, and
// everything beneath it (the app and lower modals) is inert, so Tab cannot move
// focus — and typed keys — into a terminal behind the dialog.
const modalStack: { close: () => void; backdrop: HTMLElement }[] = [];

/** The lock screen covers everything: the app and every open dialog. */
let screenLocked = false;

/** Whether the lock screen is up (a message in the app would be under it). */
export function isScreenLocked(): boolean {
  return screenLocked;
}

export function setScreenLocked(locked: boolean) {
  screenLocked = locked;
  syncInert();
}

function syncInert() {
  const app = document.getElementById("app");
  app?.toggleAttribute("inert", screenLocked || modalStack.length > 0);
  modalStack.forEach((m, i) => m.backdrop.toggleAttribute("inert", screenLocked || i < modalStack.length - 1));
}

export interface ModalHandle {
  root: HTMLElement;
  body: HTMLElement;
  close: () => void;
}

/** Dispatched on the document whenever a modal opens. */
export const MODAL_OPENED = "bx-modal-opened";

/** Open a modal. `onClose` runs once when it is dismissed by any route. */
export function modal(opts: {
  title: string;
  icon?: string;
  body: string;
  footer?: string;
  width?: number;
  onClose?: () => void;
  /** Asked before Esc or a click outside dismisses the dialog (both easy to do
   * by accident); false keeps it open. Its own buttons and `close()` don't ask. */
  beforeDismiss?: () => boolean | Promise<boolean>;
}): ModalHandle {
  const backdrop = h("div", { class: "modal-backdrop" });
  const box = h(
    "div",
    { class: "modal", role: "dialog", "aria-modal": "true", style: `width:${opts.width ?? 460}px` },
    `<header class="modal-head">
        ${opts.icon ? `<span class="modal-icon">${icon(opts.icon, 18)}</span>` : ""}
        <h2>${esc(opts.title)}</h2>
        <button class="icon-btn" data-close title="닫기">${icon("X", 16)}</button>
     </header>
     <div class="modal-body">${opts.body}</div>
     ${opts.footer ? `<footer class="modal-foot">${opts.footer}</footer>` : ""}`,
  );
  backdrop.appendChild(box);
  document.body.appendChild(backdrop);
  // Floating panels (a tab's notes) close: they would stay over the dialog.
  document.dispatchEvent(new Event(MODAL_OPENED));
  const returnFocus = document.activeElement as HTMLElement | null;
  requestAnimationFrame(() => backdrop.classList.add("show"));

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    modalStack.splice(modalStack.findIndex((m) => m.close === close), 1);
    syncInert();
    // Back to where focus was, also inside a dialog that opened this one
    // (it is active again by now).
    if (returnFocus?.isConnected) returnFocus.focus();
    document.removeEventListener("keydown", onKey, true);
    backdrop.classList.remove("show");
    setTimeout(() => backdrop.remove(), 180);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && modalStack[modalStack.length - 1]?.close === close) {
      e.stopPropagation();
      // Esc in a search box with text clears it first; the next Esc closes.
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type === "search" && t.value && backdrop.contains(t)) {
        e.preventDefault();
        t.value = "";
        t.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      // The same from a list of what was found (marked data-clears-search):
      // back to the dialog's search box, emptied.
      const box = t instanceof Element && t.closest("[data-clears-search]") ? backdrop.querySelector<HTMLInputElement>("input[type=search]") : null;
      if (box?.value) {
        e.preventDefault();
        box.value = "";
        box.dispatchEvent(new Event("input", { bubbles: true }));
        box.focus();
        return;
      }
      void dismiss();
    }
  };
  let asking = false;
  const dismiss = async () => {
    if (asking || closed) return;
    if (opts.beforeDismiss) {
      asking = true;
      let ok = false;
      try {
        ok = await opts.beforeDismiss();
      } catch (err) {
        // Kept open: input is not dropped because the check itself failed.
        console.error(err);
      } finally {
        asking = false;
      }
      if (!ok) return;
    }
    close();
  };
  modalStack.push({ close, backdrop });
  syncInert();
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) void dismiss();
  });
  box.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  const first = box.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), select, textarea");
  // Unless the caller already put the focus somewhere in the dialog.
  setTimeout(() => !box.contains(document.activeElement) && (first ?? box.querySelector<HTMLElement>(".btn-primary"))?.focus(), 30);
  return { root: box, body: box.querySelector(".modal-body")!, close };
}

/** The values a form's named fields show now (checkboxes as checked), to tell
 * whether the user changed any since an earlier reading. */
export function formValues(root: ParentNode): string {
  const fields = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input[name], textarea[name], select[name]");
  return JSON.stringify(
    [...fields].map((f) => [f.name, f instanceof HTMLInputElement && (f.type === "checkbox" || f.type === "radio") ? f.checked : f.value]),
  );
}

/** Ask before a dialog with unsaved input closes (a modal's `beforeDismiss`). */
export function confirmDiscard(message = "저장하지 않은 내용이 있습니다. 저장하지 않고 닫을까요?", confirm = "저장하지 않고 닫기"): Promise<boolean> {
  return confirmDialog({ title: "저장하지 않은 변경 내용", message, confirm, danger: true, focusCancel: true });
}

/** Ask yes/no. Enter confirms. With `dontAsk`, a "don't ask again" box is
 * shown and `dontAsk` runs when the user confirms with it checked. */
export function confirmDialog(opts: {
  title: string;
  message: string;
  confirm?: string;
  danger?: boolean;
  icon?: string;
  dontAsk?: () => void;
  /** Label of the cancel button ("취소"); null: no cancel button (a notice). */
  cancel?: string | null;
  /** Start with the cancel button focused, so an Enter meant for something
   * else (a popup that appears while the user types) does not confirm. */
  focusCancel?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const m = modal({
      title: opts.title,
      icon: opts.icon ?? (opts.danger ? "TriangleAlert" : "Info"),
      body: `<div class="modal-text">${opts.message}</div>${
        opts.dontAsk ? `<label class="check dont-ask"><input type="checkbox" data-dont-ask/><span>다시 묻지 않기</span></label>` : ""
      }`,
      footer: `${opts.cancel === null ? "" : `<button class="btn" data-close>${esc(opts.cancel ?? "취소")}</button>`}
               <button class="btn ${opts.danger ? "btn-danger" : "btn-primary"}" data-ok>${esc(opts.confirm ?? "확인")}</button>`,
      onClose: () => resolve(result),
    });
    const ok = m.root.querySelector<HTMLButtonElement>("[data-ok]")!;
    const confirm = () => {
      if (result) return;
      result = true;
      if (m.root.querySelector<HTMLInputElement>("[data-dont-ask]")?.checked) opts.dontAsk?.();
      m.close();
    };
    ok.addEventListener("click", confirm);
    // Enter confirms, unless another button (Cancel, close) has the focus.
    m.root.addEventListener("keydown", (e) => {
      const button = (e.target as HTMLElement).closest("button");
      // A held Enter (auto-repeat) confirms nothing, not even by pressing the
      // focused button natively: only a fresh press does.
      if (e.key === "Enter" && e.repeat) return e.preventDefault();
      // Whichever button this Enter presses (Cancel too), its held repeats
      // must not reach the terminal the focus goes back to.
      if (e.key === "Enter" && !e.isComposing) swallowHeldEnter();
      if (e.key !== "Enter" || e.isComposing || (button && button !== ok)) return;
      e.preventDefault();
      confirm();
    });
    // At once: there must be no moment in which "confirm" has the focus when
    // the dialog should start on "cancel" (an Enter typed just then).
    ((opts.focusCancel && m.root.querySelector<HTMLElement>(".btn[data-close]")) || ok).focus();
  });
}

/** Ask the user to pick one of several actions. Resolves with the chosen value, or null when dismissed. */
export function choiceDialog(opts: {
  title: string;
  message: string;
  icon?: string;
  choices: { value: string; label: string; kind?: "primary" | "danger" }[];
}): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const m = modal({
      title: opts.title,
      icon: opts.icon ?? "Info",
      body: `<div class="modal-text">${opts.message}</div>`,
      footer: `<button class="btn" data-close>취소</button>${opts.choices
        .map((c) => `<button class="btn ${c.kind === "primary" ? "btn-primary" : c.kind === "danger" ? "btn-danger" : ""}" data-choice="${esc(c.value)}">${esc(c.label)}</button>`)
        .join("")}`,
      onClose: () => resolve(result),
    });
    m.root.querySelectorAll<HTMLElement>("[data-choice]").forEach((b) =>
      b.addEventListener("click", () => {
        result = b.dataset.choice!;
        m.close();
      }),
    );
  });
}

export function promptDialog(opts: {
  title: string;
  label: string;
  value?: string;
  type?: string;
  confirm?: string;
  icon?: string;
  extra?: string;
  /** Called as the user types (e.g. to update a preview inside `extra`). */
  onInput?: (value: string, form: HTMLElement) => void;
  /** What is wrong with the entry, if anything: a message, shown, or the box
   * to fill next, focused. Either way the dialog stays open with what was
   * typed (nothing to type again). */
  validate?: (value: string, form: HTMLElement) => string | HTMLElement | null;
}): Promise<{ value: string; form: HTMLElement } | null> {
  return new Promise((resolve) => {
    let result: { value: string; form: HTMLElement } | null = null;
    const m = modal({
      title: opts.title,
      icon: opts.icon ?? "Pencil",
      body: `<form class="form" data-form>
               <label class="field"><span>${esc(opts.label)}</span>
               <input name="v" type="${opts.type ?? "text"}" value="${esc(opts.value ?? "")}" autocomplete="off" spellcheck="false"/></label>
               ${opts.extra ?? ""}
             </form>`,
      footer: `<button class="btn" data-close>취소</button>
               <button class="btn btn-primary" data-ok>${esc(opts.confirm ?? "확인")}</button>`,
      onClose: () => resolve(result),
    });
    const form = m.root.querySelector<HTMLFormElement>("[data-form]")!;
    const input = form.querySelector<HTMLInputElement>("input[name=v]")!;
    if (opts.onInput) input.addEventListener("input", () => opts.onInput!(input.value, form));
    setTimeout(() => input.select(), 40);
    const submit = () => {
      const problem = opts.validate?.(input.value, form);
      if (problem instanceof HTMLElement) return void problem.focus();
      if (problem) {
        toast(problem, "warn");
        return void input.focus();
      }
      result = { value: input.value, form };
      m.close();
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submit();
    });
    enterSubmits(form, submit);
    m.root.querySelector("[data-ok]")!.addEventListener("click", submit);
  });
}

/** Enter in any text box of `form` runs `submit`. A form whose button is in
 * the dialog's footer has no submit button of its own, and the browser
 * submits such a form on Enter only while it has a single text box. Not the
 * Enter that ends Korean (IME) composition, and not in a text area. */
export function enterSubmits(form: HTMLElement, submit: () => void) {
  form.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (!(e.target instanceof HTMLInputElement) || ["checkbox", "radio", "button", "submit", "file"].includes(e.target.type)) return;
    e.preventDefault();
    // A held Enter (auto-repeat) submits nothing: only a fresh press does.
    if (e.repeat) return;
    swallowHeldEnter();
    submit();
  });
}

/** After an Enter that closed a dialog: while that key is still held, its
 * auto-repeats go nowhere, not into the terminal the focus returns to (where
 * each would run whatever is on the line). Ends when the key is let go. */
export function swallowHeldEnter() {
  const repeat = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || !e.repeat) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const done = (e: Event) => {
    if (e instanceof KeyboardEvent && e.key !== "Enter") return;
    window.removeEventListener("keydown", repeat, true);
    window.removeEventListener("keyup", done, true);
    window.removeEventListener("blur", done);
  };
  window.addEventListener("keydown", repeat, true);
  window.addEventListener("keyup", done, true);
  // A key let go elsewhere (the window lost the focus) sends no keyup here.
  window.addEventListener("blur", done);
}

// ---- context menu ----------------------------------------------------------------

export interface MenuItem {
  label: string;
  icon?: string;
  action?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  /** The label is the user's own text (a name, a path): shown as it is, never translated. */
  userLabel?: boolean;
  /** The hint is such text too (a command): never translated. */
  userHint?: boolean;
}

/** The open context menu's close: there is one at a time. */
let openMenuClose: (() => void) | null = null;

/** Close the context menu that is open, if any, listeners and all (a new
 * menu replaces it; the lock screen hides it). */
export function closeContextMenu() {
  openMenuClose?.();
}

export function contextMenu(x: number, y: number, items: (MenuItem | "-")[]) {
  closeContextMenu();
  const menu = h("div", { class: "ctx-menu", role: "menu" });
  for (const item of items) {
    if (item === "-") {
      menu.appendChild(h("div", { class: "ctx-sep" }));
      continue;
    }
    const btn = h(
      "button",
      { class: `ctx-item${item.danger ? " danger" : ""}`, role: "menuitem" },
      `${item.icon ? icon(item.icon, 15) : '<span class="ico-pad"></span>'}<span${item.userLabel ? " data-i18n-skip" : ""}>${esc(item.label)}</span>${
        // A word hint ("포트 포워딩") reads better in the UI font than in the
        // monospace one meant for commands and keys.
        // A command stays in the monospace font, Korean names in it or not.
        item.hint ? `<kbd${/[가-힣]/.test(item.hint) && !item.userHint ? ' class="word"' : ""}${item.userHint ? " data-i18n-skip" : ""}>${esc(item.hint)}</kbd>` : ""
      }`,
    );
    if (item.disabled) btn.setAttribute("disabled", "");
    btn.addEventListener("click", () => {
      close();
      item.action?.();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  // Never past the top or left edge: a menu taller than the window scrolls.
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  const opener = document.activeElement as HTMLElement | null;
  const enabledItems = () => [...menu.querySelectorAll<HTMLButtonElement>(".ctx-item:not([disabled])")];
  const close = () => {
    if (openMenuClose === close) openMenuClose = null;
    const hadFocus = menu.contains(document.activeElement);
    menu.remove();
    window.removeEventListener("mousedown", dismiss, true);
    window.removeEventListener("keydown", dismiss, true);
    window.removeEventListener("blur", dismiss);
    // Keyboard use: hand focus back to whatever opened the menu.
    if (hadFocus && opener?.isConnected) opener.focus?.();
  };
  const dismiss = (e: Event) => {
    // Taken off the page some other way: only stop listening, and let the
    // key or click through (an Esc it swallowed would be lost to a dialog
    // or to the terminal).
    if (!menu.isConnected) return close();
    if (e instanceof KeyboardEvent) {
      // Esc closes the menu only: not the dialog it was opened in, and it
      // is not sent on to a terminal under it either.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return close();
      }
      // Arrow / Home / End move a roving focus through the enabled items; the
      // focused <button> activates on Enter or Space by itself. The menu is not
      // focused on open, so a mouse user is never pulled into it.
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        const list = enabledItems();
        if (!list.length) return;
        e.preventDefault();
        const at = list.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          e.key === "Home" ? 0
          : e.key === "End" ? list.length - 1
          : at < 0 ? (e.key === "ArrowDown" ? 0 : list.length - 1)
          : (at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
        list[next]?.focus();
        return;
      }
      // Typeahead: a letter jumps to the next item starting with it. Only while
      // the menu has the focus, so typing into a terminal is never taken.
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && menu.contains(document.activeElement)) {
        const list = enabledItems();
        const ch = e.key.toLocaleLowerCase();
        const at = list.indexOf(document.activeElement as HTMLButtonElement);
        for (let i = 1; i <= list.length; i++) {
          const b = list[(at + i) % list.length];
          if (b.textContent?.trim().toLocaleLowerCase().startsWith(ch)) {
            e.preventDefault();
            b.focus();
            break;
          }
        }
      }
      return;
    }
    if (e.type === "mousedown" && menu.contains(e.target as Node)) return;
    close();
  };
  openMenuClose = close;
  // Listening from the next turn, so the click that opened it does not close
  // it; not at all when it was closed (or replaced) before that.
  setTimeout(() => {
    if (!menu.isConnected) return;
    window.addEventListener("mousedown", dismiss, true);
    window.addEventListener("keydown", dismiss, true);
    window.addEventListener("blur", dismiss);
  });
}
