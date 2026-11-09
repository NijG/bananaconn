// A saved session's notes in its tab's bar ("운영 장비 — reload 금지",
// the rack, who to call): a button shown while the session has notes, which
// opens them to read during the work, with a way to edit them. It follows
// edits made while the tab is open.

import { icon } from "./icons";
import type { Session } from "./model";
import { state, subscribe } from "./store";
import { h, MODAL_OPENED, setPressed } from "./ui";

/** The notes the saved session has now (a quick connection has none). */
function notesOf(id: string): string {
  return state.sessions.find((s) => s.id === id)?.notes.trim() ?? "";
}

/** The notes button for a tab of the session `sessionId`; `edit` opens the
 * session editor. `dispose` with the tab. */
export function notesButton(sessionId: string, edit: (s: Session) => void): { el: HTMLButtonElement; dispose: () => void } {
  const el = h("button", { type: "button", class: "tool notes-tool", title: "세션 메모", "aria-pressed": "false" }, icon("StickyNote", 15));
  let pop: HTMLElement | null = null;
  const fill = () => {
    // User text: set as text, never parsed or translated.
    if (pop) pop.querySelector(".notes-text")!.textContent = notesOf(sessionId);
  };
  const outside = (e: MouseEvent) => {
    if (pop && !pop.contains(e.target as Node) && !el.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Only these notes close: not a dialog under them as well.
    e.stopImmediatePropagation();
    close();
    el.focus();
  };
  // Focus moving elsewhere (Ctrl+Tab to another tab), a dialog opening or the
  // window resized: the notes would float over something else.
  const away = (e: FocusEvent) => {
    if (pop && !pop.contains(e.target as Node) && !el.contains(e.target as Node)) close();
  };
  const elsewhere = () => close();
  const close = () => {
    pop?.remove();
    pop = null;
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", away, true);
    document.removeEventListener(MODAL_OPENED, elsewhere);
    window.removeEventListener("resize", elsewhere);
    setPressed(el, false);
  };
  const sync = () => {
    el.hidden = !notesOf(sessionId);
    if (el.hidden) close();
    else fill();
  };
  sync();
  const unsubscribe = subscribe("sessions", sync);
  el.addEventListener("click", () => {
    if (pop) return close();
    pop = h(
      "div",
      { class: "notes-pop", role: "dialog", "aria-label": "세션 메모" },
      `<header>${icon("StickyNote", 14)}<b>세션 메모</b></header>
       <div class="notes-text" data-i18n-skip></div>
       <div class="row"><button type="button" class="btn btn-sm" data-edit>${icon("Pencil", 13)}메모 편집</button></div>`,
    );
    fill();
    document.body.append(pop);
    // Under the button, its right edge with the button's, inside the window;
    // above it when there is no room below (a lower pane).
    const r = el.getBoundingClientRect();
    const w = pop.offsetWidth;
    const ph = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    const below = r.bottom + 6;
    const top = below + ph <= window.innerHeight - 8 ? below : r.top - 6 - ph >= 8 ? r.top - 6 - ph : Math.max(8, window.innerHeight - ph - 8);
    pop.style.top = `${top}px`;
    pop.querySelector("[data-edit]")!.addEventListener("click", () => {
      const s = state.sessions.find((x) => x.id === sessionId);
      close();
      if (s) edit(s);
    });
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", away, true);
    // A dialog opened by a shortcut moves no mouse and maybe no focus.
    document.addEventListener(MODAL_OPENED, elsewhere);
    window.addEventListener("resize", elsewhere);
    setPressed(el, true);
  });
  return {
    el,
    dispose: () => {
      close();
      unsubscribe();
    },
  };
}
