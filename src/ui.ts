// Shared UI primitives: element helper, toasts, modal dialogs, context menus,
// and formatting.

import { icon } from "./icons";

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

export function toast(message: string, kind: ToastKind = "info", ms = 3800) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = h("div", { id: "toasts" });
    document.body.appendChild(host);
  }
  const t = h("div", { class: `toast toast-${kind}` }, `${icon(TOAST_ICON[kind], 16)}<span>${esc(message)}</span>`);
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  const close = () => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 250);
  };
  t.addEventListener("click", close);
  setTimeout(close, ms);
}

export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return JSON.stringify(err);
}

// ---- modal ---------------------------------------------------------------------

// Open modals, topmost last. Only the topmost one reacts to Escape, and
// everything beneath it (the app and lower modals) is inert, so Tab cannot move
// focus — and typed keys — into a terminal behind the dialog.
const modalStack: { close: () => void; backdrop: HTMLElement }[] = [];

/** The lock screen covers everything: the app and every open dialog. */
let screenLocked = false;

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

/** Open a modal. `onClose` runs once when it is dismissed by any route. */
export function modal(opts: {
  title: string;
  icon?: string;
  body: string;
  footer?: string;
  width?: number;
  onClose?: () => void;
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
      close();
    }
  };
  modalStack.push({ close, backdrop });
  syncInert();
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  box.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  const first = box.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), select, textarea");
  // Unless the caller already put the focus somewhere in the dialog.
  setTimeout(() => !box.contains(document.activeElement) && (first ?? box.querySelector<HTMLElement>(".btn-primary"))?.focus(), 30);
  return { root: box, body: box.querySelector(".modal-body")!, close };
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
      result = { value: input.value, form };
      m.close();
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submit();
    });
    m.root.querySelector("[data-ok]")!.addEventListener("click", submit);
  });
}

// ---- context menu ----------------------------------------------------------------

export interface MenuItem {
  label: string;
  icon?: string;
  action?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

export function contextMenu(x: number, y: number, items: (MenuItem | "-")[]) {
  document.querySelector(".ctx-menu")?.remove();
  const menu = h("div", { class: "ctx-menu", role: "menu" });
  for (const item of items) {
    if (item === "-") {
      menu.appendChild(h("div", { class: "ctx-sep" }));
      continue;
    }
    const btn = h(
      "button",
      { class: `ctx-item${item.danger ? " danger" : ""}`, role: "menuitem" },
      `${item.icon ? icon(item.icon, 15) : '<span class="ico-pad"></span>'}<span>${esc(item.label)}</span>${
        // A word hint ("포트 포워딩") reads better in the UI font than in the
        // monospace one meant for commands and keys.
        item.hint ? `<kbd${/[가-힣]/.test(item.hint) ? ' class="word"' : ""}>${esc(item.hint)}</kbd>` : ""
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
  const close = () => {
    menu.remove();
    window.removeEventListener("mousedown", dismiss, true);
    window.removeEventListener("keydown", dismiss, true);
    window.removeEventListener("blur", dismiss);
  };
  const dismiss = (e: Event) => {
    if (e instanceof KeyboardEvent && e.key !== "Escape") return;
    if (e.type === "mousedown" && menu.contains(e.target as Node)) return;
    close();
  };
  setTimeout(() => {
    window.addEventListener("mousedown", dismiss, true);
    window.addEventListener("keydown", dismiss, true);
    window.addEventListener("blur", dismiss);
  });
}
