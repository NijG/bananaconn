// Clipboard history picker: choose something copied earlier to copy it again
// (and paste it wherever you like). The history itself lives in clipboard.ts.

import { clearClipboardHistory, clipboardHistory, writeClipboard } from "./clipboard";
import { icon } from "./icons";
import { esc, modal, toast } from "./ui";

export function openClipboardHistory() {
  const items = clipboardHistory();
  const row = (t: string, i: number) =>
    `<button type="button" class="clip-item" data-i="${i}" title="${esc(t)}"><span class="clip-text">${esc(t.length > 300 ? `${t.slice(0, 300)}…` : t)}</span></button>`;
  const m = modal({
    title: "클립보드 히스토리",
    icon: "ClipboardList",
    width: 560,
    body: items.length
      ? `<p class="muted small">고르면 클립보드에 복사됩니다. 원하는 곳에 붙여넣으세요.</p>
         <div class="clip-hist" data-i18n-skip>${items.map(row).join("")}</div>`
      : `<p class="muted small">복사한 내용이 아직 없습니다.</p>`,
    footer: `<button class="btn" data-close>닫기</button>${items.length ? `<button class="btn btn-danger-ghost" data-clear>${icon("Trash2", 14)}기록 지우기</button>` : ""}`,
  });
  m.root.querySelector("[data-clear]")?.addEventListener("click", () => {
    clearClipboardHistory();
    m.close();
    toast("클립보드 기록을 지웠습니다", "info", 2000);
  });
  m.root.querySelectorAll<HTMLElement>(".clip-item").forEach((b) =>
    b.addEventListener("click", () => {
      const t = items[Number(b.dataset.i)];
      void writeClipboard(t);
      m.close();
      toast("복사했습니다. 붙여넣으세요", "success", 2000);
    }),
  );
}
