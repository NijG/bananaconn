// Output comparison: two pieces of text (a selection from one terminal and one
// from another, or anything pasted) compared line by line, as needed when two
// switches' configurations or a "show" output before and after a change are
// set side by side. Nothing is sent anywhere; it all happens in this window.

import { api, pickOpenFile } from "./api";
import { writeClipboard } from "./clipboard";
import { tr } from "./i18n";
import { icon } from "./icons";
import { errorText, esc, modal, toast } from "./ui";

export interface DiffSide {
  /** Where the text came from (a tab's name), or empty. */
  title: string;
  text: string;
}

/** A line of the result: in both texts, only in the right one, or only in the left. */
export type DiffOp = { kind: "same" | "add" | "del"; text: string };

/** The first piece taken with term.compare, waiting for the second. */
let pending: DiffSide | null = null;
/** Numbers each comparison window, so its inputs' ids are its own. */
let windows = 0;

/** Most edit steps the comparison walks before giving up (Myers' D; a changed
 * line is two: one removed, one added, so about 1000 changed lines). The
 * trace kept for the walk back grows with D² (about 16 MB at this limit). */
const MAX_EDITS = 2000;

/** Line diff (Myers): the shortest list of kept, added and removed lines that
 * turns `a` into `b`; null when they differ in more than MAX_EDITS lines.
 * `key`: what is compared (lines whose keys are equal count as the same),
 * worked out once per line rather than on every comparison. */
export function diffLines(a: string[], b: string[], key: (line: string) => string = (line) => line): DiffOp[] | null {
  const ka = a.map(key);
  const kb = b.map(key);
  // What both start and end with needs no search.
  let start = 0;
  while (start < a.length && start < b.length && ka[start] === kb[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) {
    endA--;
    endB--;
  }
  const B = b.slice(start, endB);
  const A = a.slice(start, endA);
  const KA = ka.slice(start, endA);
  const KB = kb.slice(start, endB);
  const n = A.length;
  const m = B.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = n === 0 && m === 0;
  for (let d = 0; d <= max && !found; d++) {
    if (d > MAX_EDITS) return null;
    // Only diagonals -d-1 … d+1 are read back for this step.
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && KA[x] === KB[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Walk the trace back from the end.
  const middle: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    // trace[d] holds diagonal k at index k + d + 1.
    const t = trace[d];
    const at = (diag: number) => t[diag + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      middle.push({ kind: "same", text: B[y - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) middle.push({ kind: "add", text: B[y - 1] });
      else middle.push({ kind: "del", text: A[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  middle.reverse();
  return [
    ...b.slice(0, start).map((text): DiffOp => ({ kind: "same", text })),
    ...middle,
    ...b.slice(endB).map((text): DiffOp => ({ kind: "same", text })),
  ];
}

/** Lines of a terminal selection or a paste: CRLF and trailing blanks dropped
 * (a terminal pads lines with spaces), and no empty last line. */
function lines(text: string): string[] {
  const out = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** What the result shows: changed lines with a few unchanged ones around
 * them; a longer unchanged run is one row counting its lines. */
function shownRows(ops: DiffOp[]): (DiffOp | { folded: number })[] {
  const CONTEXT = 3;
  const changed = ops.map((o) => o.kind !== "same");
  const near = (i: number) => {
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(ops.length - 1, i + CONTEXT); j++) if (changed[j]) return true;
    return false;
  };
  const rows: (DiffOp | { folded: number })[] = [];
  let hidden = 0;
  const flush = () => {
    if (hidden) rows.push({ folded: hidden });
    hidden = 0;
  };
  ops.forEach((o, i) => {
    if (o.kind === "same" && !near(i)) {
      hidden++;
      return;
    }
    flush();
    rows.push(o);
  });
  flush();
  return rows;
}

/** The result as HTML. */
function render(ops: DiffOp[]): string {
  return shownRows(ops)
    .map((row) => {
      if ("folded" in row) return `<div class="diff-fold">… ${row.folded}줄 같음</div>`;
      const mark = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
      return `<div class="diff-line diff-${row.kind}" data-i18n-skip><span class="diff-mark">${mark}</span>${esc(row.text) || " "}</div>`;
    })
    .join("");
}

/** The result as text to paste into a change record: unified-diff marks
 * ("-" removed, "+" added, a space unchanged) right before each line, so its
 * own indentation shows as it is, under the two sources' names. */
function resultText(ops: DiffOp[], leftName: string, rightName: string): string {
  const body = shownRows(ops).map((row) => ("folded" in row ? tr(`… ${row.folded}줄 같음`) : `${row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}${row.text}`));
  return [`--- ${leftName}`, `+++ ${rightName}`, ...body].join("\n");
}

/** Open the comparison with what is given (either side may be empty, to paste
 * into or to fill from a file such as a saved configuration). */
export function openDiff(left?: DiffSide, right?: DiffSide) {
  const labels = { left: "기준", right: "비교 대상" };
  const id = (key: "left" | "right") => `diff-${key}-${windows}`;
  windows++;
  const side = (key: "left" | "right") =>
    `<div class="field diff-side">
       <div class="diff-side-head"><label for="${id(key)}">${labels[key]}</label><b class="diff-src" data-src="${key}" data-i18n-skip></b>
         <button type="button" class="btn btn-sm" data-file="${key}" title="텍스트 파일 불러오기 (설정 백업 등)">${icon("FolderOpen", 13)}파일…</button></div>
       <textarea id="${id(key)}" name="${key}" rows="9" spellcheck="false" class="mono" data-i18n-skip></textarea>
     </div>`;
  const m = modal({
    title: "출력 비교",
    icon: "Columns2",
    width: 980,
    body: `<div class="diff-inputs">${side("left")}${side("right")}</div>
      <div class="row diff-options">
        <label class="check"><input type="checkbox" data-ws checked /><span>공백 차이 무시</span></label>
        <button type="button" class="btn btn-sm" data-swap title="기준과 비교 대상 바꾸기">${icon("ArrowLeftRight", 13)}좌우 바꾸기</button>
        <span class="muted small diff-summary"></span>
        <span class="grow"></span>
        <button type="button" class="btn btn-primary" data-run>${icon("Columns2", 14)}비교</button>
      </div>
      <div class="diff-result mono" hidden></div>`,
    footer: `<button class="btn" data-close>닫기</button><button class="btn" data-copy hidden>${icon("Copy", 14)}결과 복사</button>`,
  });
  const area = { left: m.root.querySelector<HTMLTextAreaElement>("textarea[name=left]")!, right: m.root.querySelector<HTMLTextAreaElement>("textarea[name=right]")! };
  /** Where each side's text came from (a tab's name, a file's name), or "". */
  const source = { left: left?.title ?? "", right: right?.title ?? "" };
  const showSource = (key: "left" | "right") => {
    // User data: set as text, never parsed as HTML or translated.
    m.root.querySelector<HTMLElement>(`[data-src="${key}"]`)!.textContent = source[key] ? `· ${source[key]}` : "";
  };
  area.left.value = left?.text ?? "";
  area.right.value = right?.text ?? "";
  showSource("left");
  showSource("right");
  // Other text in place of the whole side (emptied, or a paste over all of
  // it) no longer comes from that tab or file.
  for (const key of ["left", "right"] as const) {
    const a = area[key];
    const forget = () => {
      source[key] = "";
      showSource(key);
    };
    a.addEventListener("input", () => !a.value && source[key] && forget());
    a.addEventListener("paste", () => a.selectionStart === 0 && a.selectionEnd === a.value.length && source[key] && forget());
  }
  const result = m.root.querySelector<HTMLElement>(".diff-result")!;
  const summary = m.root.querySelector<HTMLElement>(".diff-summary")!;
  const copy = m.root.querySelector<HTMLButtonElement>("[data-copy]")!;
  /** The result shown now, for "copy result" (null: none, or no difference). */
  let shown: DiffOp[] | null = null;
  const run = () => {
    const ws = m.root.querySelector<HTMLInputElement>("[data-ws]")!.checked;
    const norm = (s: string) => (ws ? s.trim().replace(/\s+/g, " ") : s);
    const ops = diffLines(lines(area.left.value), lines(area.right.value), norm);
    result.hidden = false;
    shown = null;
    copy.hidden = true;
    if (!ops) {
      summary.textContent = "";
      result.innerHTML = `<p class="muted">차이가 너무 많아 비교하지 않았습니다. 범위를 줄여 다시 선택하세요.</p>`;
      return;
    }
    const added = ops.filter((o) => o.kind === "add").length;
    const removed = ops.filter((o) => o.kind === "del").length;
    // Two elements: each is translated as its own phrase ("추가 {0}줄"), which a
    // single "…줄 · …줄" text would not be.
    summary.innerHTML = added || removed ? `<span>추가 ${added}줄</span> · <span>삭제 ${removed}줄</span>` : "";
    result.innerHTML = added || removed ? render(ops) : `<p class="muted">두 내용이 같습니다.</p>`;
    if (added || removed) {
      shown = ops;
      copy.hidden = false;
    }
  };
  m.root.querySelector("[data-run]")!.addEventListener("click", run);
  m.root.querySelector("[data-ws]")!.addEventListener("change", () => !result.hidden && run());
  m.root.querySelector("[data-swap]")!.addEventListener("click", () => {
    [area.left.value, area.right.value] = [area.right.value, area.left.value];
    [source.left, source.right] = [source.right, source.left];
    showSource("left");
    showSource("right");
    if (!result.hidden) run();
  });
  copy.addEventListener("click", () => {
    if (!shown) return;
    const name = (key: "left" | "right") => source[key] || tr(labels[key]);
    void writeClipboard(resultText(shown, name("left"), name("right")));
    toast("결과를 복사했습니다", "success", 1500);
  });
  m.root.querySelectorAll<HTMLButtonElement>("[data-file]").forEach((b) =>
    b.addEventListener("click", async () => {
      const key = b.dataset.file as "left" | "right";
      const path = await pickOpenFile("비교할 텍스트 파일");
      if (!path) return;
      try {
        const text = await api.readTextFile(path);
        // A picked binary (an image, a firmware file) is not compared as text.
        if (text.includes("\0")) return void toast("텍스트 파일이 아닙니다", "warn");
        area[key].value = text;
        source[key] = path.split(/[\\/]/).pop() ?? path;
        showSource(key);
        if (area.left.value && area.right.value) run();
        else area[key === "left" ? "right" : "left"].focus();
      } catch (err) {
        toast(errorText(err), "error", 6000);
      }
    }),
  );
  // Both sides given (taken from terminals, a file and a terminal): show the
  // result at once, also when one of them is empty (a command that printed
  // nothing the other time).
  if (left && right) run();
  else (area.left.value ? area.right : area.left).focus();
}

/** Whether a first piece is kept, waiting for its other side. */
export function hasPendingDiff(): boolean {
  return pending !== null;
}

/** Where the piece kept came from, or null. */
export function pendingTitle(): string | null {
  return pending?.title ?? null;
}

/** term.compare: the first selection is kept; the second opens the comparison. */
/** `next`: how the second piece is taken where this one came from (a file's menu). */
export function takeForDiff(piece: DiffSide, next = "비교할 첫 내용을 담았습니다. 다른 탭(또는 다른 부분)을 선택하고 다시 누르면 비교합니다") {
  if (!pending) {
    pending = piece;
    toast(next, "info", 6000);
    return;
  }
  const left = pending;
  pending = null;
  openDiff(left, piece);
}

/** The comparison opened from the palette: with the piece kept so far, if any. */
export function openDiffFromMenu() {
  const left = pending ?? undefined;
  pending = null;
  openDiff(left);
}
