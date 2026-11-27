// Clipboard history picker: choose something copied earlier to copy it again
// (and paste it wherever you like). The history itself lives in clipboard.ts.

import { clearClipboardHistory, clipboardHistory, removeClipboardHistory, writeClipboard } from "./clipboard";
import { icon } from "./icons";
import { tr } from "./i18n";
import { esc, markTerms, matchesTerms, modal, searchTerms, toast } from "./ui";

export function openClipboardHistory() {
  const m = modal({
    title: "클립보드 히스토리",
    icon: "ClipboardList",
    width: 560,
    // Only the copied texts are skipped (on .clip-item): the delete buttons'
    // tooltips and the "nothing yet" note are app text to translate.
    body: `<label class="pane-filter clip-filter">${icon("Search", 13)}<input placeholder="필터" spellcheck="false"/></label>
      <p class="muted small clip-hint" hidden>Ctrl+클릭으로 여러 개를 고르면 고른 순서대로 한 줄에 하나씩 한꺼번에 복사할 수 있습니다.</p>
      <div class="clip-hist"></div>`,
    footer: `<button class="btn" data-close>닫기</button><button class="btn btn-danger-ghost" data-clear>${icon("Trash2", 14)}기록 지우기</button><button class="btn btn-primary" data-join hidden>${icon("Copy", 14)}<span></span></button>`,
  });
  const list = m.root.querySelector<HTMLElement>(".clip-hist")!;
  const filter = m.root.querySelector<HTMLInputElement>(".clip-filter input")!;
  const filterBox = m.root.querySelector<HTMLElement>(".clip-filter")!;
  const hint = m.root.querySelector<HTMLElement>(".clip-hint")!;
  const clearBtn = m.root.querySelector<HTMLElement>("[data-clear]");
  const joinBtn = m.root.querySelector<HTMLButtonElement>("[data-join]")!;

  /** The texts picked with Ctrl+click, in the order picked: what is copied
   * together. By text, so a filter or a new copy meanwhile keeps them. */
  let picked: string[] = [];

  /** The entries the filter lets through, each with its place in the whole history. */
  const shown = () => {
    const terms = searchTerms(filter.value);
    return { terms, items: clipboardHistory().flatMap((t, i) => (matchesTerms(t.toLowerCase(), terms) ? [{ t, i }] : [])) };
  };

  /** The texts as drawn, by the number on their row: a click takes the text
   * it shows, even if something was copied meanwhile (the history moved on). */
  let drawn: string[] = [];
  const draw = () => {
    const all = clipboardHistory();
    drawn = [...all];
    // A picked text no longer in the history (deleted) is let go.
    picked = picked.filter((t) => all.includes(t));
    filterBox.hidden = all.length < 2;
    hint.hidden = all.length < 2;
    // The count in the screen language (the button's text is set here, not translated in place).
    joinBtn.hidden = picked.length < 2;
    joinBtn.querySelector("span")!.textContent = tr(`선택한 ${picked.length}개 복사`);
    if (!all.length) {
      list.innerHTML = `<p class="muted small">복사한 내용이 아직 없습니다.</p>`;
      if (clearBtn) clearBtn.hidden = true;
      return;
    }
    if (clearBtn) clearBtn.hidden = false;
    const { terms, items } = shown();
    // The words found marked in each text (the text is the user's: skipped by translation).
    list.innerHTML = items.length
      ? items
          .map(({ t, i }) => {
            const order = picked.indexOf(t);
            return `<div class="clip-row${order >= 0 ? " picked" : ""}" data-i="${i}"><button type="button" class="clip-item" data-pick="${i}" data-i18n-skip title="${esc(t.length > 1000 ? `${t.slice(0, 1000)}…` : t)}">${
              order >= 0 ? `<span class="clip-order">${order + 1}</span>` : ""
            }<span class="clip-text">${markTerms(t.length > 300 ? `${t.slice(0, 300)}…` : t, terms)}</span></button><button type="button" class="icon-btn clip-del" data-del="${i}" title="이 항목 삭제">${icon("Trash2", 13)}</button></div>`;
          })
          .join("")
      : `<p class="muted small">필터에 맞는 항목이 없습니다</p>`;
  };

  const pick = (t: string) => {
    void writeClipboard(t);
    m.close();
    toast("복사했습니다. 붙여넣으세요", "success", 2000);
  };

  list.addEventListener("click", (e) => {
    const items = drawn;
    const target = e.target as HTMLElement;
    const del = target.closest<HTMLElement>("[data-del]");
    if (del) {
      const t = items[Number(del.dataset.del)];
      if (t !== undefined) removeClipboardHistory(t);
      draw();
      return;
    }
    const chosen = target.closest<HTMLElement>("[data-pick]");
    if (!chosen) return;
    const t = items[Number(chosen.dataset.pick)];
    if (t === undefined) return;
    // Ctrl+click: picked (or let go) to copy with others; a plain click copies it alone.
    if (e.ctrlKey || e.metaKey) {
      picked = picked.includes(t) ? picked.filter((x) => x !== t) : [...picked, t];
      draw();
      // The list is drawn anew: the keyboard stays on the entry (Ctrl+Enter
      // picks the next one), found by its text: a copy meanwhile moves the rows.
      list.querySelector<HTMLElement>(`[data-pick="${drawn.indexOf(t)}"]`)?.focus();
      return;
    }
    pick(t);
  });

  joinBtn.addEventListener("click", () => {
    if (picked.length < 2) return;
    // One per line, each without the line break it may end with (a line copied
    // whole); joined with Windows' line break when one of them has it inside.
    const eol = picked.some((t) => t.replace(/\r?\n$/, "").includes("\r\n")) ? "\r\n" : "\n";
    void writeClipboard(picked.map((t) => t.replace(/\r?\n$/, "")).join(eol));
    const n = picked.length;
    m.close();
    toast(`${n}개를 한 줄에 하나씩 복사했습니다`, "success", 2500);
  });

  filter.addEventListener("input", draw);
  // Enter: the first entry the filter lets through; with several picked, those together.
  filter.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    if (picked.length >= 2) return joinBtn.click();
    const first = shown().items[0];
    if (first) pick(first.t);
  });

  clearBtn?.addEventListener("click", () => {
    clearClipboardHistory();
    m.close();
    toast("클립보드 기록을 지웠습니다", "info", 2000);
  });

  draw();
  if (!filterBox.hidden) filter.focus();
}
