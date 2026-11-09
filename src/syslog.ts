// Syslog receiver (backend: syslog.rs): network devices send their log lines
// here (UDP 514 by default, "logging host <this PC>") while they are worked
// on. The messages are kept while it runs, the window open or not.

import { api, on, pickSavePath, type SyslogMessage, type SyslogStatus } from "./api";
import { writeClipboard } from "./clipboard";
import { tr, userText } from "./i18n";
import { icon } from "./icons";
import { clockText } from "./lineTimes";
import { newSessionHandler, openNetworkTools } from "./nettools";
import { beep, canOsNotify, contextMenu, ensureNotifyPermission, errorText, esc, modal, osNotify, requestAttention, setPressed, timestamp, toast } from "./ui";

/** Messages kept (the oldest go first), and the text they may hold in all. */
const KEEP = 20000;
const KEEP_CHARS = 8_000_000;
/** Rows drawn at once: the newest of those the filter lets through. */
const SHOW = 2000;
/** RFC 5424 severity keywords, shown as devices print them. */
const SEVERITY = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"];

/** A message kept: numbered in arrival order, its text lower-cased once for the filter. */
type Kept = SyslogMessage & { seq: number; lower: string };

let status: SyslogStatus | null = null;
const messages: Kept[] = [];
let chars = 0;
let seq = 0;
/** Messages that came faster than a batch holds: not shown or kept here (still in the file when saving). */
let dropped = 0;
/** Messages the file did not get: writing it fell behind (a stalled share). */
let unsaved = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

export const syslog = {
  get status() {
    return status;
  },
  onChange(f: () => void) {
    listeners.add(f);
    return () => listeners.delete(f);
  },
};

export async function initSyslog() {
  await on<{ messages: SyslogMessage[]; dropped: number; droppedBad?: number; unsaved: number; fileError: string | null }>("syslog-batch", (b) => {
    // The file could not be written: receiving goes on, saving stops (told once).
    if (b.fileError && status?.file) {
      toast(`로그 파일에 쓰지 못해 파일 저장을 멈췄습니다: ${userText(b.fileError)}`, "error", 10000);
      status = { ...status, file: null };
    }
    alertOf(b.messages, b.droppedBad ?? 0);
    for (const m of b.messages) {
      messages.push({ ...m, seq: ++seq, lower: m.text.toLowerCase() });
      chars += m.text.length;
    }
    let cut = 0;
    while (messages.length - cut > KEEP || (chars > KEEP_CHARS && cut < messages.length - 1)) chars -= messages[cut++].text.length;
    if (cut) messages.splice(0, cut);
    dropped += b.dropped;
    unsaved += b.unsaved;
    notify();
  });
  // The backend owns whether it runs (a reloaded page finds it running).
  status = await api.syslogStatus().catch(() => null);
  notify();
}

/** The status bar's button while it runs. */
export function syslogBadge(): string {
  return status ? `<button class="sb-server" data-syslog title="${esc(status.addresses.join("\n"))}">${icon("ScrollText", 13)}Syslog :${status.port}</button>` : "";
}

/** `alert`: a beep, the taskbar flashing and a notification for an err or
 * worse message, also with the window closed. */
type Prefs = { port: number; lan: boolean; save: boolean; file: string; alert: boolean };

function loadPrefs(): Prefs {
  const d: Prefs = { port: 514, lan: true, save: false, file: "", alert: false };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem("bx.syslog") ?? "{}") };
  } catch {
    return d;
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem("bx.syslog", JSON.stringify(p));
  } catch {
    // Not kept: the window starts with the defaults next time.
  }
}

/** Alerts: messages this bad or worse (err, crit, alert, emerg), told at most
 * every ALERT_EVERY (a flapping link sends many); those that came meanwhile
 * are told together when that time is up. */
const ALERT_SEVERITY = 3;
const ALERT_EVERY = 30_000;
let alertOn = loadPrefs().alert;
let alertedAt = 0;
let held: { count: number; last: SyslogMessage | null } = { count: 0, last: null };
let heldTimer = 0;

/** `unshown`: err-or-worse messages a flood kept out of the batch (still alerted, counted). */
function alertOf(batch: SyslogMessage[], unshown: number) {
  if (!alertOn) return;
  const bad = batch.filter((m) => m.severity !== null && m.severity <= ALERT_SEVERITY);
  if (!bad.length && !unshown) return;
  held.count += bad.length + unshown;
  if (bad.length) held.last = bad[bad.length - 1];
  const wait = ALERT_EVERY - (Date.now() - alertedAt);
  if (wait <= 0) raiseAlert();
  else if (!heldTimer) heldTimer = window.setTimeout(raiseAlert, wait);
}

function raiseAlert() {
  heldTimer = 0;
  const { count, last } = held;
  held = { count: 0, last: null };
  if (!alertOn || !count) return;
  alertedAt = Date.now();
  beep();
  requestAttention();
  // The device's words as it sent them (never translated); none when every
  // one of them came in a flood the window could not keep.
  const what = last ? `${last.from} ${SEVERITY[last.severity ?? 3]}: ${last.text}` : "";
  if (!document.hasFocus() && canOsNotify()) return osNotify(tr(count > 1 ? `Syslog 경보 ${count}개` : "Syslog 경보"), what, () => openSyslog());
  const message = !what ? (count > 1 ? `Syslog 경보 ${count}개` : "Syslog 경보") : count > 1 ? `Syslog 경보 ${count}개: ${userText(what)}` : `Syslog 경보: ${userText(what)}`;
  toast(message, "warn", 10_000, { label: "보기", run: () => openSyslog() });
}

function setAlert(on: boolean) {
  alertOn = on;
  savePrefs({ ...loadPrefs(), alert: on });
  if (on) ensureNotifyPermission();
  else {
    clearTimeout(heldTimer);
    heldTimer = 0;
    held = { count: 0, last: null };
  }
}

/** A message as one line of text: time, sender, severity, the message. */
const asText = (m: SyslogMessage, withDate: boolean) =>
  [withDate ? new Date(m.at).toLocaleString("sv-SE").replace(",", "") : clockText(m.at), m.from, m.severity !== null ? SEVERITY[m.severity] : "-", m.text].join("\t");

const rowHtml = (x: Kept) =>
  `<div class="syslog-row sev-${x.severity ?? "x"}" data-seq="${x.seq}"><time>${clockText(x.at)}</time><span class="from" data-i18n-skip>${esc(x.from)}</span><span class="sev">${x.severity !== null ? SEVERITY[x.severity] : "-"}</span><span class="tx" data-i18n-skip>${esc(x.text)}</span></div>`;

/** The Syslog window while it is open: opened again (an alert's "보기", the
 * status bar), it is the same window, not a second one. */
let openWindow: HTMLElement | null = null;

export function openSyslog() {
  if (openWindow?.isConnected) {
    openWindow.querySelector<HTMLElement>(".syslog-list")?.focus();
    return;
  }
  const p = loadPrefs();
  const m = modal({
    title: "Syslog 수신",
    icon: "ScrollText",
    width: 920,
    body: `<div class="ftpd syslog">
        <div class="ftpd-state"></div>
        <p class="muted small">장비가 이 PC로 로그를 보내게 하면(Cisco의 logging host 등) 받은 메시지를 여기에 보여 줍니다. 창을 닫아도 수신은 계속됩니다.</p>
        <form class="form ftpd-form syslog-form" autocomplete="off">
          <label class="field"><span>포트 (UDP)</span><input name="port" type="number" min="1" max="65535" value="${p.port}"/></label>
          <label class="check block"><input type="checkbox" name="lan" ${p.lan ? "checked" : ""}/>
            <span><b>다른 PC·장비에서 보내기 허용</b><small>끄면 이 PC(127.0.0.1)에서 보낸 것만 받습니다.</small></span></label>
          <div class="syslog-file">
            <label class="check" title="창에 다 보이지 않는 메시지까지 모두 이 파일 끝에 덧붙입니다."><input type="checkbox" name="save" ${p.save ? "checked" : ""}/>받는 대로 파일에 저장</label>
            <input name="file" spellcheck="false" placeholder="예: D:\\logs\\syslog.log" value="${esc(p.file)}"/>
            <button type="button" class="btn" data-pick-file>${icon("FolderOpen", 14)}찾아보기</button></div>
        </form>
        <div class="syslog-tools">
          <label class="pane-filter syslog-filter" title="주소나 내용으로 거르기">${icon("Search", 13)}<input placeholder="필터" spellcheck="false"/></label>
          <button type="button" class="syslog-only" data-only hidden title="모든 장비의 메시지 보기">${icon("X", 12)}<span>보낸 곳</span><code data-i18n-skip></code></button>
          <select name="level" title="심각도">
            <option value="7">모든 심각도</option>
            <option value="4">warning 이상</option>
            <option value="3">err 이상</option>
            <option value="2">crit 이상</option>
          </select>
          <button type="button" class="btn btn-sm syslog-bell" data-bell title="err 이상 메시지가 오면 소리, 작업 표시줄 깜박임, 알림으로 알립니다 (창을 닫아도)">${icon("Bell", 13)}경보</button>
          <span class="muted small syslog-count" data-count></span>
          <span class="syslog-actions">
            <button type="button" class="btn btn-sm" data-copy>${icon("Copy", 13)}보이는 줄 복사</button>
            <button type="button" class="btn btn-sm" data-save>${icon("Save", 13)}파일로 저장</button>
            <button type="button" class="btn btn-sm" data-clear>${icon("Eraser", 13)}지우기</button>
          </span>
        </div>
        <div class="syslog-list mono" role="log"></div>
      </div>`,
    footer: `<button class="btn" data-close>닫기</button><button class="btn btn-primary" data-toggle></button>`,
    onClose: () => {
      openWindow = null;
      off();
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", onSelection);
    },
  });
  openWindow = m.root;
  const form = m.root.querySelector<HTMLFormElement>(".syslog-form")!;
  const portIn = form.querySelector<HTMLInputElement>("[name=port]")!;
  const lanIn = form.querySelector<HTMLInputElement>("[name=lan]")!;
  const saveIn = form.querySelector<HTMLInputElement>("[name=save]")!;
  const fileIn = form.querySelector<HTMLInputElement>("[name=file]")!;
  form.querySelector("[data-pick-file]")!.addEventListener("click", async () => {
    const path = await pickSavePath(fileIn.value.trim() || `syslog_${timestamp()}.log`, [{ name: "로그", extensions: ["log", "txt"] }]);
    if (!path) return;
    fileIn.value = path;
    saveIn.checked = true;
  });
  const stateBox = m.root.querySelector<HTMLElement>(".ftpd-state")!;
  const list = m.root.querySelector<HTMLElement>(".syslog-list")!;
  const filterIn = m.root.querySelector<HTMLInputElement>(".syslog-filter input")!;
  const level = m.root.querySelector<HTMLSelectElement>("[name=level]")!;
  const count = m.root.querySelector<HTMLElement>("[data-count]")!;
  const toggle = m.root.querySelector<HTMLButtonElement>("[data-toggle]")!;
  const onlyChip = m.root.querySelector<HTMLButtonElement>("[data-only]")!;
  let busy = false;
  let frame = 0;
  /** Only the messages of this sender, its address exactly (the filter box
   * matches parts: "10.0.0.2" there lets "10.0.0.20" through too). */
  let onlyFrom: string | null = null;

  /** Whether the sender, the filter and the severity let a message through. */
  const passes = () => {
    const terms = filterIn.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const max = Number(level.value);
    const from = onlyFrom;
    return (x: Kept) =>
      (from === null || x.from === from) && (max >= 7 || (x.severity !== null && x.severity <= max)) && terms.every((t) => x.from.includes(t) || x.lower.includes(t));
  };
  const showOnly = (from: string | null) => {
    onlyFrom = from;
    onlyChip.hidden = from === null;
    // The address as text: never parsed as HTML or translated.
    onlyChip.querySelector("code")!.textContent = from ?? "";
    render();
  };
  const visible = () => messages.filter(passes());

  let drawnState = "";
  function renderState() {
    form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((el) => (el.disabled = !!status || busy));
    toggle.disabled = busy;
    toggle.className = `btn ${status ? "btn-danger" : "btn-primary"}`;
    toggle.innerHTML = status ? `${icon("Square", 14)}수신 중지` : `${icon("Play", 14)}수신 시작`;
    const html = status
      ? `<div class="ftpd-on"><span class="sb-dot connected"></span><b>수신 중</b><span class="muted">UDP ${status.port}</span></div>
         <div class="ftpd-addrs">${status.addresses
           .map((a) => `<button type="button" class="ftpd-addr" data-addr="${esc(a)}" title="주소 복사">${icon("Copy", 13)}<code>${esc(a)}</code></button>`)
           .join("")}</div>
         ${status.file ? `<p class="muted small syslog-saving">${icon("Save", 13)}<span>파일에 저장 중</span> <code data-i18n-skip>${esc(status.file)}</code></p>` : ""}`
      : `<div class="ftpd-off"><span class="sb-dot idle"></span><b>중지됨</b><span class="muted">수신을 시작하면 장비가 보내는 로그가 여기에 나타납니다.</span></div>`;
    if (html !== drawnState) {
      drawnState = html;
      stateBox.innerHTML = html;
    }
  }

  /** What the list shows: the filter it was drawn for, the last message
   * in it, and how many of the kept messages pass the filter. */
  let drawnFor = "";
  let drawnUpTo = 0;
  let shownCount = 0;
  let firstKept = 0;

  /** The list: new messages appended to what is there (a whole redraw only
   * for another filter, or a clear), the oldest rows over SHOW taken away;
   * it follows new lines only when it was at its bottom. */
  function renderList() {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    const key = `${filterIn.value}\u0000${level.value}\u0000${onlyFrom ?? ""}`;
    const lead = messages[0]?.seq ?? seq + 1;
    if (key !== drawnFor || !messages.length || messages[messages.length - 1].seq < drawnUpTo) {
      // Another filter, or the messages cleared: drawn again whole.
      const shown = visible();
      shownCount = shown.length;
      const rows = shown.slice(-SHOW);
      list.innerHTML = rows.length
        ? rows.map(rowHtml).join("")
        : `<p class="muted ftpd-empty">${messages.length ? "필터에 맞는 메시지가 없습니다." : "아직 받은 메시지가 없습니다."}</p>`;
      drawnFor = key;
    } else {
      const ok = passes();
      // The messages that came since (at the end: they are in arrival order).
      let i = messages.length;
      while (i > 0 && messages[i - 1].seq > drawnUpTo) i--;
      const fresh = messages.slice(i).filter(ok);
      // The oldest kept ones went meanwhile: the count is taken again.
      if (lead !== firstKept) shownCount = messages.filter(ok).length;
      else shownCount += fresh.length;
      if (fresh.length) {
        list.querySelector(".ftpd-empty")?.remove();
        list.insertAdjacentHTML("beforeend", fresh.slice(-SHOW).map(rowHtml).join(""));
      }
      // Rows go from the top: those over SHOW, and those of messages no
      // longer kept (copied lines must be the ones shown). Measured once and
      // taken away in one step: a layout per row froze a full list.
      const rows = list.children;
      let cut = Math.max(0, rows.length - SHOW);
      while (cut < rows.length && Number((rows[cut] as HTMLElement).dataset.seq) < lead) cut++;
      if (cut) {
        const keep = rows[cut] as HTMLElement | undefined;
        const removed = !atBottom && keep ? keep.offsetTop - (rows[0] as HTMLElement).offsetTop : 0;
        const range = document.createRange();
        range.setStartBefore(rows[0]);
        if (keep) range.setEndBefore(keep);
        else range.setEndAfter(rows[rows.length - 1]);
        range.deleteContents();
        if (removed) list.scrollTop -= removed;
      }
      if (!list.querySelector(".syslog-row"))
        list.innerHTML = `<p class="muted ftpd-empty">${messages.length ? "필터에 맞는 메시지가 없습니다." : "아직 받은 메시지가 없습니다."}</p>`;
    }
    drawnUpTo = messages[messages.length - 1]?.seq ?? seq;
    firstKept = lead;
    count.innerHTML = [
      `<span>${esc(`전체 ${messages.length}개`)}</span>`,
      shownCount !== messages.length ? `<span>${esc(`표시 ${shownCount}개`)}</span>` : "",
      shownCount > SHOW ? `<span>${esc(`최근 ${SHOW}개만 보여 줍니다`)}</span>` : "",
      dropped ? `<span class="danger-text">${esc(`너무 빨리 와서 화면에 표시하지 못한 메시지 ${dropped}개`)}</span>` : "",
      unsaved ? `<span class="danger-text">${esc(`파일에 저장하지 못한 메시지 ${unsaved}개`)}</span>` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  /** Text being selected in the list: redrawn once the selection is let go. */
  const selecting = () => {
    const sel = document.getSelection();
    return !!sel && !sel.isCollapsed && !!sel.anchorNode && list.contains(sel.anchorNode);
  };
  let waiting = false;
  const onSelection = () => {
    if (waiting && !selecting()) {
      waiting = false;
      render();
    }
  };
  document.addEventListener("selectionchange", onSelection);

  /** Redrawn once per frame however many batches came. */
  const render = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderState();
      if (selecting()) waiting = true;
      else renderList();
    });
  };
  const off = syslog.onChange(render);

  stateBox.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-addr]");
    if (!b) return;
    await writeClipboard(b.dataset.addr!);
    toast("주소를 복사했습니다", "success", 1600);
  });
  filterIn.addEventListener("input", render);
  level.addEventListener("change", render);
  onlyChip.addEventListener("click", () => showOnly(null));
  const bell = m.root.querySelector<HTMLButtonElement>("[data-bell]")!;
  setPressed(bell, alertOn);
  bell.addEventListener("click", () => {
    setAlert(!alertOn);
    setPressed(bell, alertOn);
    toast(alertOn ? "err 이상 메시지가 오면 알립니다 (창을 닫아도)" : "Syslog 경보를 껐습니다", "info", 3000);
  });
  // A sender's address: its messages alone, the network tools, a session, a copy.
  list.addEventListener("click", (e) => {
    const from = (e.target as HTMLElement).closest<HTMLElement>(".syslog-row .from");
    // A drag that selected text is no click on the address.
    if (!from || !document.getSelection()?.isCollapsed) return;
    const ip = from.textContent ?? "";
    if (!ip) return;
    const r = from.getBoundingClientRect();
    const make = newSessionHandler();
    contextMenu(r.left, r.bottom + 2, [
      onlyFrom === ip
        ? { label: "모든 장비의 메시지 보기", icon: "ListFilter", action: () => showOnly(null) }
        : { label: "이 장비의 메시지만 보기", icon: "ListFilter", action: () => showOnly(ip) },
      { label: "네트워크 도구", icon: "Activity", hint: "ping · 포트 · DNS", action: () => openNetworkTools(ip) },
      // The window closes as the session connects (receiving goes on), so its tab is not left behind it.
      ...(make ? [{ label: "이 주소로 새 세션 만들기…", icon: "Plus", action: () => make({ protocol: "ssh", host: ip }, () => m.close()) }] : []),
      { label: "주소 복사", icon: "ClipboardList", action: () => void writeClipboard(ip) },
    ]);
  });
  m.root.querySelector("[data-clear]")!.addEventListener("click", () => {
    messages.length = 0;
    chars = 0;
    dropped = 0;
    unsaved = 0;
    drawnFor = "";
    notify();
  });
  m.root.querySelector("[data-copy]")!.addEventListener("click", () => {
    const rows = visible().slice(-SHOW);
    if (!rows.length) return void toast("복사할 메시지가 없습니다", "info");
    void writeClipboard(rows.map((x) => asText(x, false)).join("\n"));
    toast(`${rows.length}줄을 복사했습니다`, "success", 2000);
  });
  m.root.querySelector("[data-save]")!.addEventListener("click", async () => {
    const rows = visible();
    if (!rows.length) return void toast("저장할 메시지가 없습니다", "info");
    const path = await pickSavePath(`syslog_${timestamp()}.log`, [{ name: "로그", extensions: ["log", "txt"] }]);
    if (!path) return;
    try {
      await api.saveTextFile(path, `${rows.map((x) => asText(x, true)).join("\r\n")}\r\n`);
      toast(`${rows.length}줄을 저장했습니다`, "success", 2500);
    } catch (err) {
      toast(errorText(err), "error", 6000);
    }
  });
  form.addEventListener("submit", (e) => e.preventDefault());

  toggle.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    renderState();
    try {
      if (status) {
        await api.syslogStop();
        status = null;
      } else {
        const port = Number(portIn.value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("포트는 1~65535 사이여야 합니다");
        const prefs: Prefs = { port, lan: lanIn.checked, save: saveIn.checked, file: fileIn.value.trim(), alert: alertOn };
        if (prefs.save && !prefs.file) throw new Error("저장할 파일을 고르세요");
        savePrefs(prefs);
        status = await api.syslogStart(port, prefs.lan, prefs.save ? prefs.file : null);
        toast(`Syslog 수신을 시작했습니다 (${status.addresses[0]})`, "success");
      }
    } catch (err) {
      toast(errorText(err), "error", 6000);
    } finally {
      busy = false;
      notify();
    }
  });
  renderState();
  renderList();
}
