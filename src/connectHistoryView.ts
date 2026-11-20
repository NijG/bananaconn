// The connection history dialogs (connectLog.ts): one saved session's, from
// its menu in the session tree, or every saved session's together, newest
// first (the command palette's "전체 연결 기록"), for a day's work log. Only
// reads the history; nothing connects.

import { writeClipboard } from "./clipboard";
import { allConnectHistory, clearConnectHistory, connectHistory, type ConnectEnd, type ConnectRecord } from "./connectLog";
import { tr } from "./i18n";
import { icon } from "./icons";
import { endpoint, PROTOCOLS, type Session } from "./model";
import { state } from "./store";
import { elapsedText, esc, matchesTerms, modal, searchTerms, sheetCell, toast } from "./ui";
import { clockAt, sheetTime } from "./workspace";

const ENDED: Record<ConnectEnd, string> = {
  closed: "끊김",
  error: "오류로 끊김",
  tab: "탭을 닫음",
  app: "앱을 닫음",
  failed: "연결하지 못함",
  unknown: "끝난 시각 모름",
};

/** How a record's connection ended, in the words this dialog uses; none while it is open. */
export function endedWord(r: ConnectRecord): string | null {
  return r.how ? ENDED[r.how] : null;
}

/** The most records the dialog of every session lists. */
const ALL_LIMIT = 300;

/** One record's words, once, for the table and its copy. */
function facts(s: Session, r: ConnectRecord) {
  return {
    s,
    r,
    how: r.how ? ENDED[r.how] : "연결되어 있음",
    long: r.how === "failed" || r.how === "unknown" ? "" : ((ms: number) => (ms < 60000 ? "1분 미만" : elapsedText(ms)))((r.end ?? Date.now()) - r.at),
    proto: PROTOCOLS[r.protocol as Session["protocol"]]?.label ?? r.protocol,
  };
}

/** `one`: that session's history (with its "기록 지우기"); none: every saved
 * session's, newest first, the session named on each row. */
export function openConnectHistory(one?: Session, connect?: (s: Session) => void) {
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  const rows = one
    ? connectHistory(one.id).map((r) => facts(one, r))
    : allConnectHistory()
        .flatMap(({ sessionId, record }) => {
          // A session deleted since has no name to show.
          const s = byId.get(sessionId);
          return s ? [facts(s, record)] : [];
        })
        .slice(0, ALL_LIMIT);
  if (!rows.length) return void toast("연결 기록이 없습니다", "info");
  const failed = rows.filter((x) => x.r.how === "failed").length;
  const sessions = new Set(rows.map((x) => x.s.id)).size;
  const named = !one;
  const rowHtml = ({ s, r, how, long, proto }: (typeof rows)[number]) => {
    const cls = r.how === "failed" || r.how === "error" ? "danger-text" : r.how ? "" : "ok-text";
    const name = named ? `<td class="history-name" data-i18n-skip>${esc(s.name || s.host)}</td>` : "";
    return `<tr data-sid="${esc(s.id)}"><td>${esc(clockAt(r.at))}</td>${name}<td>${esc(long)}</td><td class="${cls}">${esc(how)}</td><td data-i18n-skip>${esc(proto)}</td></tr>`;
  };
  const body = rows.map(rowHtml).join("");
  // Every session's: narrowed to today or to words (a name, an address, a
  // result in Korean or the screen language); the copy takes what is shown.
  const hay = rows.map(({ s, how, proto }) => `${s.name} ${s.host} ${endpoint(s)} ${how} ${tr(how)} ${proto}`.toLowerCase());
  let shown = rows;
  const tools = named
    ? `<div class="history-tools"><input type="search" class="list-search" data-find placeholder="이름·주소·결과 검색" spellcheck="false" autocomplete="off" />
        <label class="check"><input type="checkbox" data-today />오늘만</label>
        <label class="check" title="연결하지 못했거나 오류로 끊긴 기록만"><input type="checkbox" data-trouble />문제만</label><span class="muted small" data-count></span></div>`
    : "";
  const head = one ? `<b data-i18n-skip>${esc(one.name || one.host)}</b> · 최근 ${rows.length}번` : `세션 ${sessions}개 · 기록 ${rows.length}개`;
  const m = modal({
    title: one ? "연결 기록" : "전체 연결 기록",
    icon: "History",
    width: one ? 520 : 640,
    body: `<p class="muted small">${head}${failed ? ` · 연결하지 못함 ${failed}번` : ""}</p>${tools}
      <div class="history-wrap"><table class="reach-table history-table"><thead><tr><th>연결 시각</th>${named ? "<th>이름</th>" : ""}<th>연결 시간</th><th>결과</th><th>방식</th></tr></thead><tbody>${body}</tbody></table></div>
      <p class="muted small">이 PC에만 세션마다 최근 20번까지 남습니다. 로그인 정보는 남기지 않습니다.</p>`,
    footer: `${one ? `<button class="btn" data-clear>기록 지우기</button>` : ""}<button class="btn" data-copy>${icon("Table", 14)}표로 복사</button><button class="btn btn-primary" data-close>닫기</button>`,
  });
  // For a work log or a fault report: tab-separated with a header row in the
  // screen language, full dates (the table's short times need today), the
  // session's name on each row; cells guarded against spreadsheet formulas.
  // A row double-clicked connects to its session again, as the session list's does
  // (a session deleted since is gone: nothing to connect to).
  if (connect) {
    m.root.querySelector(".history-wrap")!.setAttribute("title", "행을 더블클릭하면 그 세션에 연결합니다");
    m.root.querySelector("tbody")!.addEventListener("dblclick", (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-sid]")?.dataset.sid;
      const s = id ? state.sessions.find((x) => x.id === id) : undefined;
      if (!s) return;
      m.close();
      connect(s);
    });
  }
  m.root.querySelector("[data-copy]")!.addEventListener("click", async () => {
    const cell = (v: string) => sheetCell(v.replace(/[\t\r\n]+/g, " ").trim());
    const lines = [
      ["이름", "주소", "연결 시각", "끝난 시각", "연결 시간", "결과", "방식"].map(tr),
      ...shown.map(({ s, r, how, long, proto }) => [s.name || s.host, endpoint(s), sheetTime(r.at), r.end && r.how !== "unknown" ? sheetTime(r.end) : "", tr(long), tr(how), proto]),
    ];
    await writeClipboard(lines.map((l) => l.map(cell).join("\t")).join("\n"));
    toast(`연결 기록 ${shown.length}개를 표로 복사했습니다`, "success", 2000);
  });
  const find = m.root.querySelector<HTMLInputElement>("[data-find]");
  const today = m.root.querySelector<HTMLInputElement>("[data-today]");
  const trouble = m.root.querySelector<HTMLInputElement>("[data-trouble]");
  if (find && today && trouble) {
    const tbody = m.root.querySelector<HTMLElement>("tbody")!;
    const count = m.root.querySelector<HTMLElement>("[data-count]")!;
    const copy = m.root.querySelector<HTMLButtonElement>("[data-copy]")!;
    const cols = named ? 5 : 4;
    const filter = () => {
      const terms = searchTerms(find.value);
      const day = new Date().toDateString();
      shown = rows.filter(
        (x, i) =>
          (!today.checked || new Date(x.r.at).toDateString() === day) &&
          // The rows the table paints red: never connected, or dropped by an error.
          (!trouble.checked || x.r.how === "failed" || x.r.how === "error") &&
          matchesTerms(hay[i], terms),
      );
      tbody.innerHTML = shown.length ? shown.map(rowHtml).join("") : `<tr><td colspan="${cols}" class="muted">결과 없음</td></tr>`;
      count.textContent = shown.length === rows.length ? "" : `${shown.length}개 표시`;
      copy.disabled = !shown.length;
    };
    find.addEventListener("input", filter);
    today.addEventListener("change", filter);
    trouble.addEventListener("change", filter);
  }
  m.root.querySelector("[data-clear]")?.addEventListener("click", () => {
    if (!one) return;
    clearConnectHistory(one.id);
    m.close();
    toast("연결 기록을 지웠습니다", "info");
  });
}
