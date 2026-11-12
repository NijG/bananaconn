// Clipboard history picker: choose something copied earlier to copy it again
// (and paste it wherever you like). The history itself lives in clipboard.ts.

import { clearClipboardHistory, clipboardHistory, removeClipboardHistory, writeClipboard } from "./clipboard";
import { icon } from "./icons";
import { esc, markTerms, matchesTerms, modal, searchTerms, toast } from "./ui";

export function openClipboardHistory() {
  const m = modal({
    title: "클립보드 히스토리",
    icon: "ClipboardList",
    width: 560,
    // Only the copied texts are skipped (on .clip-item): the delete buttons'
    // tooltips and the "nothing yet" note are app text to translate.
    body: `<label class="pane-filter clip-filter">${icon("Search", 13)}<input placeholder="필터" spellcheck="false"/></label><div class="clip-hist"></div>`,
    footer: `<button class="btn" data-close>닫기</button><button class="btn btn-danger-ghost" data-clear>${icon("Trash2", 14)}기록 지우기</button>`,
  });
  const list = m.root.querySelector<HTMLElement>(".clip-hist")!;
  const filter = m.root.querySelector<HTMLInputElement>(".clip-filter input")!;
  const filterBox = m.root.querySelector<HTMLElement>(".clip-filter")!;
  const clearBtn = m.root.querySelector<HTMLElement>("[data-clear]");

  /** The entries the filter lets through, each with its place in the whole history. */
  const shown = () => {
    const terms = searchTerms(filter.value);
    return { terms, items: clipboardHistory().flatMap((t, i) => (matchesTerms(t.toLowerCase(), terms) ? [{ t, i }] : [])) };
  };

  const draw = () => {
    const all = clipboardHistory();
    filterBox.hidden = all.length < 2;
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
          .map(
            ({ t, i }) =>
              `<div class="clip-row" data-i="${i}"><button type="button" class="clip-item" data-pick="${i}" data-i18n-skip title="${esc(t.length > 1000 ? `${t.slice(0, 1000)}…` : t)}"><span class="clip-text">${markTerms(t.length > 300 ? `${t.slice(0, 300)}…` : t, terms)}</span></button><button type="button" class="icon-btn clip-del" data-del="${i}" title="이 항목 삭제">${icon("Trash2", 13)}</button></div>`,
          )
          .join("")
      : `<p class="muted small">필터에 맞는 항목이 없습니다</p>`;
  };

  const pick = (t: string) => {
    void writeClipboard(t);
    m.close();
    toast("복사했습니다. 붙여넣으세요", "success", 2000);
  };

  list.addEventListener("click", (e) => {
    const items = clipboardHistory();
    const target = e.target as HTMLElement;
    const del = target.closest<HTMLElement>("[data-del]");
    if (del) {
      const t = items[Number(del.dataset.del)];
      if (t !== undefined) removeClipboardHistory(t);
      draw();
      return;
    }
    const chosen = target.closest<HTMLElement>("[data-pick]");
    if (chosen) {
      const t = items[Number(chosen.dataset.pick)];
      if (t !== undefined) pick(t);
    }
  });

  filter.addEventListener("input", draw);
  // Enter: the first entry the filter lets through.
  filter.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
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
