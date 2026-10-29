// Clipboard history picker: choose something copied earlier to copy it again
// (and paste it wherever you like). The history itself lives in clipboard.ts.

import { clearClipboardHistory, clipboardHistory, removeClipboardHistory, writeClipboard } from "./clipboard";
import { icon } from "./icons";
import { esc, modal, toast } from "./ui";

export function openClipboardHistory() {
  const m = modal({
    title: "클립보드 히스토리",
    icon: "ClipboardList",
    width: 560,
    body: `<div class="clip-hist" data-i18n-skip></div>`,
    footer: `<button class="btn" data-close>닫기</button><button class="btn btn-danger-ghost" data-clear>${icon("Trash2", 14)}기록 지우기</button>`,
  });
  const list = m.root.querySelector<HTMLElement>(".clip-hist")!;
  const clearBtn = m.root.querySelector<HTMLElement>("[data-clear]");

  const draw = () => {
    const items = clipboardHistory();
    if (!items.length) {
      list.innerHTML = `<p class="muted small">복사한 내용이 아직 없습니다.</p>`;
      if (clearBtn) clearBtn.hidden = true;
      return;
    }
    if (clearBtn) clearBtn.hidden = false;
    list.innerHTML = items
      .map(
        (t, i) =>
          `<div class="clip-row" data-i="${i}"><button type="button" class="clip-item" data-pick="${i}" title="${esc(t)}"><span class="clip-text">${esc(t.length > 300 ? `${t.slice(0, 300)}…` : t)}</span></button><button type="button" class="icon-btn clip-del" data-del="${i}" title="이 항목 삭제">${icon("Trash2", 13)}</button></div>`,
      )
      .join("");
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
    const pick = target.closest<HTMLElement>("[data-pick]");
    if (pick) {
      const t = items[Number(pick.dataset.pick)];
      if (t !== undefined) void writeClipboard(t);
      m.close();
      toast("복사했습니다. 붙여넣으세요", "success", 2000);
    }
  });

  clearBtn?.addEventListener("click", () => {
    clearClipboardHistory();
    m.close();
    toast("클립보드 기록을 지웠습니다", "info", 2000);
  });

  draw();
}
