// Syslog receiver (backend: syslog.rs): network devices send their log lines
// here (UDP 514 by default, "logging host <this PC>") while they are worked
// on. The messages are kept while it runs, the window open or not.

import { api, on, pickSavePath, pickSavePathAt, type SyslogMessage, type SyslogStatus } from "./api";
import { writeClipboard } from "./clipboard";
import { onLanguageApplied, tr, userText } from "./i18n";
import { icon } from "./icons";
import { findLogMnemonics, linkDowns } from "./ipLinks";
import { clockText } from "./lineTimes";
import { state } from "./store";
import { deviceClock, skewText } from "./deviceClock";
import { deviceItems, isIPv4, newSessionHandler, openMultiWatch, openNetworkTools } from "./nettools";
import { beep, canOsNotify, contextMenu, ensureNotifyPermission, errorText, esc, formatBytes, markTerms, modal, osNotify, promptDialog, requestAttention, searchTerms, setPressed, sheetCell, timestamp, toast } from "./ui";

/** Messages kept (the oldest go first), and the text they may hold in all. */
const KEEP = 20000;
const KEEP_CHARS = 8_000_000;
/** Rows drawn at once: the newest of those the filter lets through. */
const SHOW = 2000;
/** RFC 5424 severity keywords 0-7, as devices print them (Cisco's log
 * message numbers too): owned by syslogPri.ts, which names a PRI with them. */
import { facilityName, SEVERITY } from "./syslogPri";
export { SEVERITY };

/** A message kept: numbered in arrival order, its text lower-cased once for
 * the filter. `name`: the message's own name ("%link-3-updown", lower case:
 * the first in its text), or null; another name quoted later in the text is not it. */
type Kept = SyslogMessage & { seq: number; lower: string; name: string | null };

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
    // Each message's lower case made once: the alert words and the filter both use it.
    const kept: Kept[] = b.messages.map((m) => ({ ...m, seq: ++seq, lower: m.text.toLowerCase(), name: findLogMnemonics(m.text)[0]?.text.toLowerCase() ?? null }));
    alertOf(kept, b.droppedBad ?? 0);
    for (const m of kept) {
      messages.push(m);
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
 * worse message, also with the window closed; `words`: the alert words as
 * typed (comma-separated), a message with one is alerted whatever its severity. */
type Prefs = { port: number; lan: boolean; save: boolean; file: string; alert: boolean; words: string };

function loadPrefs(): Prefs {
  const d: Prefs = { port: 514, lan: true, save: false, file: "", alert: false, words: "" };
  try {
    const p = { ...d, ...JSON.parse(localStorage.getItem("bx.syslog") ?? "{}") };
    // An older or edited file: a value of another type is the default.
    return { ...p, words: typeof p.words === "string" ? p.words : "" };
  } catch {
    return d;
  }
}

/** The alert words to look for: lower-case, each once, at most 20. */
function parseWords(typed: string): string[] {
  return [...new Set(typed.split(/[,\n]/).map((w) => w.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
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
/** A saving file this large is shown in the warning colour (1 GiB). */
const BIG_LOG_FILE = 1024 ** 3;
const ALERT_EVERY = 30_000;
let alertOn = loadPrefs().alert;
let alertWords = parseWords(loadPrefs().words);
/** Whether a message's text (lower-case) has one of the alert words: alerted, and marked in the list. */
const hasAlertWord = (lower: string) => alertWords.some((w) => lower.includes(w));
let alertedAt = 0;
/** The alerts waiting to be told; `from`: their one sender, null when they
 * came from several (or some in a flood, whose senders are not known). */
type Held = { count: number; last: SyslogMessage | null; from: string | null };
const NONE_HELD: Held = { count: 0, last: null, from: null };
let held: Held = NONE_HELD;
let heldTimer = 0;

/** `unshown`: err-or-worse messages a flood kept out of the batch (still alerted, counted). */
function alertOf(batch: Kept[], unshown: number) {
  const bad = batch.filter((m) => (m.severity !== null && m.severity <= ALERT_SEVERITY) || hasAlertWord(m.lower));
  const senders = new Set(bad.map((m) => m.from));
  // The devices' tabs and saved sessions (main's markDevice) are marked
  // whether or not the alert is on: a quiet sign, not a sound.
  senders.forEach((ip) => markTabsOf(ip));
  if (!alertOn) return;
  if (!bad.length && !unshown) return;
  const first = held.count === 0;
  const one = !unshown && senders.size === 1 && (first || held.from === bad[0].from) ? bad[0].from : null;
  held = { count: held.count + bad.length + unshown, last: bad.length ? bad[bad.length - 1] : held.last, from: one };
  const wait = ALERT_EVERY - (Date.now() - alertedAt);
  if (wait <= 0) raiseAlert();
  else if (!heldTimer) heldTimer = window.setTimeout(raiseAlert, wait);
}

function raiseAlert() {
  heldTimer = 0;
  const { count, last, from } = held;
  held = NONE_HELD;
  if (!alertOn || !count) return;
  alertedAt = Date.now();
  beep();
  requestAttention();
  // The device's words as it sent them (never translated); none when every
  // one of them came in a flood the window could not keep.
  // The sender by its saved session's name too, when it has one ("core-sw (10.0.0.2)").
  const name = last ? sessionNames().get(last.from) : undefined;
  const sender = last ? (name ? `${name} (${last.from})` : last.from) : "";
  // A message alerted for a word may have no severity: shown as in the list ("-").
  const what = last ? `${sender} ${last.severity !== null ? SEVERITY[last.severity] : "-"}: ${last.text}` : "";
  // All from one device: its messages alone; from several, all of them.
  const show = () => openSyslog(from ?? undefined);
  if (!document.hasFocus() && canOsNotify()) return osNotify(tr(count > 1 ? `Syslog 경보 ${count}개` : "Syslog 경보"), what, show);
  const message = !what ? (count > 1 ? `Syslog 경보 ${count}개` : "Syslog 경보") : count > 1 ? `Syslog 경보 ${count}개: ${userText(what)}` : `Syslog 경보: ${userText(what)}`;
  toast(message, "warn", 10_000, { label: "보기", run: show });
}

function setAlert(on: boolean) {
  alertOn = on;
  savePrefs({ ...loadPrefs(), alert: on });
  if (on) ensureNotifyPermission();
  else {
    clearTimeout(heldTimer);
    heldTimer = 0;
    held = NONE_HELD;
  }
}

/** A message as one line of text: time, sender, severity, the message,
 * tab-separated. The message is any sender's text: its own tabs and line
 * breaks become blanks (as syslog.rs file_line writes them), so one message
 * stays one line of four columns. `sheet` (the clipboard, often pasted into
 * a spreadsheet): a cell starting with "=" stays text. */
const asText = (m: SyslogMessage, withDate: boolean, sheet = false) =>
  [withDate ? new Date(m.at).toLocaleString("sv-SE").replace(",", "") : clockText(m.at), m.from, m.severity !== null ? SEVERITY[m.severity] : "-", m.text.replace(/[\t\r\n]/g, " ")]
    .map((c) => (sheet ? sheetCell(c) : c))
    .join("\t");

/** The filter box's words: those a message must hold (`want`), and those
 * after "!" it must not (`not`): "!ipaccesslog" leaves a flood out. Not "-":
 * "-3-" is a search for a message number. A lone "!" is a word to find. */
function filterTerms(query: string): { want: string[]; not: string[] } {
  const all = searchTerms(query);
  const out = (t: string) => t.length > 1 && t.startsWith("!");
  return { want: all.filter((t) => !out(t)), not: all.filter(out).map((t) => t.slice(1)) };
}

/** Saved sessions' names by their host (lower-case): a sender shown by its address is found by its name too. */
function sessionNames(): Map<string, string> {
  const byHost = new Map<string, string[]>();
  for (const s of state.sessions) {
    const host = s.host.trim().toLowerCase();
    if (host) byHost.set(host, [...(byHost.get(host) ?? []), s.name]);
  }
  return new Map([...byHost].map(([host, names]) => [host, names.join(", ")]));
}

/** A message's row; the filter's words (`terms`) marked in its sender and
 * text, the sender's session names as its tooltip (user data: never translated). */
const rowHtml = (x: Kept, names: Map<string, string>, terms: string[]) =>
  `<div class="syslog-row sev-${x.severity ?? "x"}${hasAlertWord(x.lower) ? " word-hit" : ""}" data-seq="${x.seq}"><time>${clockText(x.at)}</time><span class="from" data-i18n-skip${names.has(x.from) ? ` title="${esc(names.get(x.from)!)}"` : ""}>${markTerms(x.from, terms)}</span><span class="sev"${x.facility !== null && x.severity !== null ? ` title="${facilityName(x.facility)}.${SEVERITY[x.severity]}" data-i18n-skip` : ""}>${x.severity !== null ? SEVERITY[x.severity] : "-"}</span><span class="tx" data-i18n-skip>${markTerms(x.text, terms)}</span></div>`;

/** Marks the open tabs connected to an address that sent an alert-worthy message (main's). */
let markTabsOf: (ip: string) => void = () => {};
export function setSyslogTabMarker(f: (ip: string) => void) {
  markTabsOf = f;
}

/** The Syslog window while it is open: opened again (an alert's "보기", the
 * status bar), it is the same window, not a second one. */
let openWindow: HTMLElement | null = null;
/** The open window's sender filter. */
let showSender: ((from: string | null) => void) | null = null;

/** The senders of the kept messages, the latest first, each once. */
export function syslogSenderList(): string[] {
  const out = new Set<string>();
  for (let i = messages.length - 1; i >= 0 && out.size < 300; i--) out.add(messages[i].from);
  return [...out];
}

/** Whether messages from this address are kept (a terminal's address menu offers them): the address as they came from it. */
export function syslogSender(host: string): string | undefined {
  const key = host.trim().toLowerCase();
  return key ? messages.find((m) => m.from.toLowerCase() === key)?.from : undefined;
}

/** The Syslog window; `from`: showing only that sender's messages. */
export function openSyslog(from?: string) {
  if (openWindow?.isConnected) {
    if (from) showSender?.(from);
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
          <label class="pane-filter syslog-filter" title="주소나 내용으로 거르기 (!낱말: 그 낱말이 든 메시지 빼기)">${icon("Search", 13)}<input placeholder="필터" spellcheck="false"/></label>
          <button type="button" class="syslog-only" data-only hidden title="모든 장비의 메시지 보기">${icon("X", 12)}<span>보낸 곳</span><code data-i18n-skip></code></button>
          <button type="button" class="syslog-only" data-hidden-names hidden data-i18n-skip>${icon("X", 12)}<span></span></button>
          <button type="button" class="btn btn-sm" data-senders title="메시지를 보낸 장비를 많이 보낸 순서로 보고 하나만 거르기 · 링크가 자주 끊긴 포트와 많이 온 메시지 종류도 함께 보기">${icon("Server", 13)}보낸 곳</button>
          <select name="level" title="심각도">
            <option value="7">모든 심각도</option>
            <option value="4">warning 이상</option>
            <option value="3">err 이상</option>
            <option value="2">crit 이상</option>
          </select>
          <button type="button" class="btn btn-sm syslog-bell" data-bell title="err 이상 메시지나 경보 낱말이 든 메시지가 오면 소리, 작업 표시줄 깜박임, 알림으로 알립니다 (창을 닫아도)">${icon("Bell", 13)}경보</button>
          <button type="button" class="btn btn-sm syslog-bell" data-bell-words title="경보 낱말: 이 낱말이 든 메시지도 심각도와 상관없이 알립니다">${icon("Highlighter", 13)}</button>
          <span class="muted small syslog-count" data-count></span>
          <span class="syslog-actions">
            <button type="button" class="btn btn-sm" data-copy>${icon("Copy", 13)}보이는 줄 복사</button>
            <button type="button" class="btn btn-sm" data-save>${icon("Save", 13)}파일로 저장</button>
            <button type="button" class="btn btn-sm" data-clear>${icon("Eraser", 13)}지우기</button>
          </span>
        </div>
        <div class="syslog-rate" data-rate hidden><span class="muted small" data-rate-label></span><svg viewBox="0 0 60 24" preserveAspectRatio="none" aria-hidden="true"></svg></div>
        <div class="syslog-list-wrap">
          <div class="syslog-list mono" role="log"></div>
          <button type="button" class="syslog-newer" data-newer hidden>${icon("ArrowDown", 13)}<span></span></button>
        </div>
      </div>`,
    footer: `<button class="btn" data-close>닫기</button><button class="btn btn-primary" data-toggle></button>`,
    onClose: () => {
      clearInterval(sizeTimer);
      clearInterval(rateTimer);
      clearTimeout(rateLater);
      openWindow = null;
      showSender = null;
      off();
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", onSelection);
      window.removeEventListener("pointerup", letGo);
    },
  });
  openWindow = m.root;
  const form = m.root.querySelector<HTMLFormElement>(".syslog-form")!;
  const portIn = form.querySelector<HTMLInputElement>("[name=port]")!;
  const lanIn = form.querySelector<HTMLInputElement>("[name=lan]")!;
  const saveIn = form.querySelector<HTMLInputElement>("[name=save]")!;
  const fileIn = form.querySelector<HTMLInputElement>("[name=file]")!;
  form.querySelector("[data-pick-file]")!.addEventListener("click", async () => {
    // The field holds a full path (picked or typed before): its folder is kept.
    const typed = fileIn.value.trim();
    const filters = [{ name: "로그", extensions: ["log", "txt"] }];
    const path = typed ? await pickSavePathAt(typed, filters) : await pickSavePath(`syslog_${timestamp()}.log`, filters);
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
  // The names hidden (their count; the names on hover): a click shows them again.
  const hiddenChip = m.root.querySelector<HTMLButtonElement>("[data-hidden-names]")!;
  let busy = false;
  let frame = 0;

  /** The last hour's messages a minute at a time, as bars (all received,
   * whatever the filter): a storm of messages, or when a device went quiet,
   * seen at a glance; a minute with an err-or-worse message in red. Drawn at
   * most once a second however fast they come, and moved on as minutes pass. */
  const rateBox = m.root.querySelector<HTMLElement>("[data-rate]")!;
  const rateSvg = rateBox.querySelector("svg")!;
  const rateLabel = rateBox.querySelector<HTMLElement>("[data-rate-label]")!;
  let rateAt = 0;
  let rateLater = 0;
  const drawRate = (force = false) => {
    const now = Date.now();
    if (!force && now - rateAt < 1000) {
      // Drawn once the second is up, so the last messages are not left out.
      if (!rateLater) rateLater = window.setTimeout(() => ((rateLater = 0), drawRate(true)), 1000 - (now - rateAt));
      return;
    }
    clearTimeout(rateLater);
    rateLater = 0;
    rateAt = now;
    const MIN = 60_000;
    // The current minute is the last bar.
    const end = Math.floor(now / MIN) * MIN + MIN;
    const counts = new Array<number>(60).fill(0);
    const bad = new Array<boolean>(60).fill(false);
    // Kept in the order they came: from the newest back, until an hour ago.
    for (let i = messages.length - 1; i >= 0; i--) {
      const x = messages[i];
      const k = 59 - Math.floor((end - 1 - x.at) / MIN);
      if (k < 0) break;
      if (k > 59) continue;
      counts[k]++;
      if (x.severity !== null && x.severity <= 3) bad[k] = true;
    }
    const top = Math.max(...counts);
    rateBox.hidden = top === 0;
    if (!top) return;
    rateLabel.textContent = `최근 60분 분당 메시지 (최대 ${top}개)`;
    rateSvg.innerHTML = counts
      .map((c, k) => {
        if (!c) return "";
        const hgt = Math.max(1.5, (22 * c) / top);
        const at = new Date(end - (60 - k) * MIN);
        const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
        return `<rect class="${bad[k] ? "bad" : ""}" data-from="${at.getTime()}" x="${k + 0.1}" y="${24 - hgt}" width="0.8" height="${hgt}"><title>${hm} · ${c}</title></rect>`;
      })
      .join("");
  };
  const rateTimer = window.setInterval(() => drawRate(true), 15_000);
  // A bar clicked: the list goes to that minute's first message it shows
  // (the filter or the list's length may leave it out: then said so).
  rateSvg.addEventListener("click", (e) => {
    const from = Number((e.target as Element).closest("rect")?.getAttribute("data-from"));
    if (!from) return;
    // The rows shown, by their message's number: looked up once, not per message.
    const shown = new Map<number, HTMLElement>();
    for (const el of list.querySelectorAll<HTMLElement>(".syslog-row")) shown.set(Number(el.dataset.seq), el);
    const first = messages.find((x) => x.at >= from && x.at < from + 60_000 && shown.has(x.seq));
    const row = first && shown.get(first.seq);
    if (!row) return void toast("그 분의 메시지가 목록에 없습니다 (필터나 표시 개수 때문)", "info", 2500);
    // Read there: new messages do not pull the list away (back at the bottom, they do).
    follow = false;
    row.scrollIntoView({ block: "center" });
    row.classList.remove("flash");
    void row.offsetWidth;
    row.classList.add("flash");
    row.addEventListener("animationend", () => row.classList.remove("flash"), { once: true });
  });
  /** Only the messages of this sender, its address exactly (the filter box
   * matches parts: "10.0.0.2" there lets "10.0.0.20" through too). */
  let onlyFrom: string | null = null;
  /** Message names hidden from the list ("%SEC-6-IPACCESSLOGP" that floods
   * it), lower case; for this window only, so nothing stays hidden unseen. */
  const hiddenNames = new Set<string>();
  /** `find` as the filter's new words, the words left out ("!flood") as the
   * user typed them kept after it: a pick from a menu does not bring a flood
   * back. One the pick itself holds ("!gi0" and the port "Gi0/1") is let go:
   * kept, it would leave out every line picked. */
  const withExclusions = (find: string) => {
    const picked = find.toLowerCase();
    return [find, ...filterTerms(filterIn.value).not.filter((t) => !picked.includes(t)).map((t) => `!${t}`)].join(" ");
  };
  /** The list shows some messages only (a word, a severity, one device, names hidden). */
  const filtered = () => filterIn.value.trim() !== "" || level.value !== "7" || onlyFrom !== null || hiddenNames.size > 0;

  /** Whether the sender, the filter and the severity let a message through. */
  const passes = () => {
    const { want: terms, not } = filterTerms(filterIn.value);
    const max = Number(level.value);
    const from = onlyFrom;
    const names = sessionNames();
    // A term matches the address, the message, or a saved session's name for that address.
    // A hidden name: the message's own, exactly ("%X-5-FAIL" leaves "%X-5-FAILED",
    // and an EEM line quoting it, alone).
    return (x: Kept) =>
      (from === null || x.from === from) &&
      !(x.name !== null && hiddenNames.has(x.name)) &&
      (max >= 7 || (x.severity !== null && x.severity <= max)) &&
      terms.every((t) => x.from.includes(t) || x.lower.includes(t) || !!names.get(x.from)?.toLowerCase().includes(t)) &&
      !not.some((t) => x.from.includes(t) || x.lower.includes(t) || !!names.get(x.from)?.toLowerCase().includes(t));
  };
  const showOnly = (from: string | null) => {
    onlyFrom = from;
    onlyChip.hidden = from === null;
    // The address as text: never parsed as HTML or translated.
    onlyChip.querySelector("code")!.textContent = from ?? "";
    render();
  };
  /** A message name hidden, or (null) every one shown again. */
  const hideName = (name: string | null) => {
    if (name === null) hiddenNames.clear();
    else hiddenNames.add(name.toLowerCase());
    render();
  };
  /** The chip: how many names are hidden, in the screen language (drawn on
   * every render, so a language change reaches it). */
  const drawHiddenChip = () => {
    hiddenChip.hidden = !hiddenNames.size;
    if (!hiddenNames.size) return;
    hiddenChip.querySelector("span")!.textContent = tr(`숨긴 메시지 ${hiddenNames.size}종류`);
    hiddenChip.title = `${tr("숨긴 메시지 다시 보기")}: ${[...hiddenNames].join(", ").toUpperCase()}`;
  };
  const visible = () => messages.filter(passes());
  // Ports whose link went down, the most often first (ipLinks.linkDowns), as
  // menu items that show that port's lines.
  const portItems = (names: Map<string, string>) => {
    return linkDowns(messages)
      .slice(0, 10)
      .map((c) => ({
        // The port and its device, as written (never translated).
        label: `${c.iface} · ${names.get(c.from) ?? c.from}`,
        userLabel: true,
        icon: c.last === "up" ? "Activity" : c.last === "admin-down" ? "Ban" : "TriangleAlert",
        // Cisco's own words: how many times down, and its state now.
        hint: `down ${c.downs} · ${c.last === "admin-down" ? "administratively down" : c.last}`,
        userHint: true,
        action: () => {
          // That device alone, and that port's lines: "Gi1/0/1," so that
          // Gi1/0/10's are not let through.
          filterIn.value = withExclusions(`${c.iface},`);
          showOnly(c.from);
        },
      }));
  };
  // The senders of the kept messages, the busiest first, with how many of
  // theirs are err or worse: which device is the noisy or failing one; then
  // their ports whose link went down.
  m.root.querySelector<HTMLElement>("[data-senders]")!.addEventListener("click", (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // `last`: when its latest message came (kept in arrival order): a device
    // that went quiet in an outage stands out by an old time.
    const per = new Map<string, { n: number; bad: number; last: number }>();
    for (const x of messages) {
      const c = per.get(x.from) ?? { n: 0, bad: 0, last: 0 };
      c.n++;
      if (x.severity !== null && x.severity <= 3) c.bad++;
      c.last = x.at;
      per.set(x.from, c);
    }
    if (!per.size) return void toast("아직 받은 메시지가 없습니다.", "info");
    const names = sessionNames();
    const top = [...per].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).slice(0, 20);
    const ports = portItems(names);
    // The busiest senders (IPv4, as the pings go), up: a storm of messages
    // in an outage, and whether those devices still answer.
    const watch = top.map(([ip]) => ip).filter(isIPv4);
    // The kinds of message (their own names, "%SEC-6-IPACCESSLOGP") that came
    // the most, of the device shown alone if one is and of the severity
    // chosen (kept when one is picked): what a storm is made of.
    // One picked: those alone (a hidden one shown again for it).
    const kinds = new Map<string, number>();
    const max = Number(level.value);
    for (const x of messages)
      if (x.name !== null && (onlyFrom === null || x.from === onlyFrom) && (max >= 7 || (x.severity !== null && x.severity <= max))) kinds.set(x.name, (kinds.get(x.name) ?? 0) + 1);
    const kindItems = [...kinds]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([name, n]) => ({
        // The name as devices print it (upper case), never translated.
        label: name.toUpperCase(),
        userLabel: true,
        icon: hiddenNames.has(name) ? "EyeOff" : "ListFilter",
        hint: `${n}`,
        userHint: true,
        action: () => {
          hiddenNames.delete(name);
          filterIn.value = withExclusions(name.toUpperCase());
          render();
        },
      }));
    contextMenu(r.left, r.bottom + 4, [
      ...(onlyFrom !== null ? [{ label: "모든 장비의 메시지 보기", icon: "ListFilter", action: () => showOnly(null) }, "-" as const] : []),
      ...top.map(([ip, c]) => ({
        label: names.has(ip) ? `${names.get(ip)} (${ip})` : ip,
        userLabel: true,
        icon: c.bad ? "TriangleAlert" : "Server",
        hint: `${c.bad ? `${c.n} · err+ ${c.bad}` : `${c.n}`} · ${clockText(c.last)}`,
        userHint: true,
        action: () => showOnly(ip),
      })),
      ...(watch.length
        ? [
            "-" as const,
            {
              label: `보낸 장비 ${watch.length}대를 연속 ping으로 지켜보기`,
              icon: "Activity",
              // Going to a device's tab from there closes this window too.
              action: () => openMultiWatch(watch.map((ip) => ({ name: names.get(ip) ?? ip, host: ip })), () => m.close()),
            },
          ]
        : []),
      ...(ports.length ? ["-" as const, { label: "포트 상태 변화", icon: "Activity", heading: true }, ...ports] : []),
      ...(kindItems.length ? ["-" as const, { label: "많이 온 메시지 종류", icon: "ListFilter", heading: true }, ...kindItems] : []),
    ]);
  });

  let drawnState = "";
  function renderState() {
    form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((el) => (el.disabled = !!status || busy));
    toggle.disabled = busy;
    toggle.className = `btn ${status ? "btn-danger" : "btn-primary"}`;
    // Redrawn once per batch of messages: its icon and label replaced only
    // when they change, so a press is not lost to a redraw under the mouse.
    const label = status ? "stop" : "start";
    if (toggle.dataset.drawn !== label) {
      toggle.dataset.drawn = label;
      toggle.innerHTML = status ? `${icon("Square", 14)}수신 중지` : `${icon("Play", 14)}수신 시작`;
    }
    const html = status
      ? `<div class="ftpd-on"><span class="sb-dot connected"></span><b>수신 중</b><span class="muted">UDP ${status.port}</span></div>
         <div class="ftpd-addrs">${status.addresses
           .map((a) => `<button type="button" class="ftpd-addr" data-addr="${esc(a)}" title="주소 복사">${icon("Copy", 13)}<code>${esc(a)}</code></button>`)
           .join("")}</div>
         ${status.file ? `<p class="muted small syslog-saving">${icon("Save", 13)}<span>파일에 저장 중</span> <code data-i18n-skip>${esc(status.file)}</code> <span class="muted" data-file-size data-i18n-skip></span></p>` : ""}`
      : `<div class="ftpd-off"><span class="sb-dot idle"></span><b>중지됨</b><span class="muted">수신을 시작하면 장비가 보내는 로그가 여기에 나타납니다.</span></div>`;
    if (html !== drawnState) {
      drawnState = html;
      stateBox.innerHTML = html;
      void showFileSize();
    }
  }
  /** The saving file's size, read again every few seconds while the window is
   * open: a file a busy network keeps growing is seen growing. */
  const showFileSize = async () => {
    const file = status?.file;
    const el = stateBox.querySelector<HTMLElement>("[data-file-size]");
    if (!file || !el) return;
    try {
      const [, size] = await api.localStat(file);
      if (status?.file !== file) return;
      el.textContent = `(${formatBytes(size)})`;
      // Never split or deleted by the app: past a size worth tidying, said so
      // (the element skips the screen's translation: the note is translated here).
      const big = size >= BIG_LOG_FILE;
      el.classList.toggle("syslog-big", big);
      el.title = big ? tr("파일이 1GB를 넘었습니다. 오래된 로그를 옮기거나 지우세요") : "";
    } catch {
      // Not there yet (nothing written) or unreadable: no size shown.
    }
  };
  const sizeTimer = window.setInterval(() => void showFileSize(), 5000);

  /** What the list shows: the filter it was drawn for, the last message
   * in it, and how many of the kept messages pass the filter. */
  let drawnFor = "";
  let drawnUpTo = 0;
  let shownCount = 0;
  let firstKept = 0;
  /** Messages (passing the filter) that came below while the list was
   * scrolled up to read: told on a button that goes down to them. */
  let unseen = 0;
  const newer = m.root.querySelector<HTMLButtonElement>("[data-newer]")!;
  const showUnseen = () => {
    newer.hidden = unseen === 0;
    if (unseen) newer.querySelector("span")!.textContent = tr(`새 메시지 ${unseen}개`);
  };
  /** The list follows new messages until the user scrolls up, and again once
   * back at the bottom. Kept as a state, not read off the geometry each time:
   * rows out of view are laid out at a guessed height (content-visibility),
   * so a long wrapped message grows the list after it was scrolled to the
   * bottom, and the next batch would have taken that for a scroll up. Only
   * the user's own scrolling (wheel, scroll bar, a drag, keys) stops it;
   * the code's scrolling and rows taken from the top never do. */
  let follow = true;
  /** A row was put in view for the user (a time's "around it"): not left by
   * itself even at the bottom, until the user scrolls. */
  let hold = false;
  /** When the user last scrolled, or holds a pointer down on the list. */
  let userAt = -Infinity;
  let pressing = false;
  const userScrolling = () => pressing || performance.now() - userAt < 1000;
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  /** Where the list was last seen or put: a scroll up is a move above it
   * (rows growing to their real height below the view move nothing). */
  let lastTop = 0;
  const seenAll = () => {
    if (!unseen) return;
    unseen = 0;
    showUnseen();
  };
  /** To the bottom, again over the next frames while rows coming into view
   * take their real height (a few at most). */
  const toBottom = () => {
    list.scrollTop = list.scrollHeight;
    lastTop = list.scrollTop;
    let height = list.scrollHeight;
    let left = 3;
    const again = () =>
      requestAnimationFrame(() => {
        if (!follow) return;
        list.scrollTop = list.scrollHeight;
        lastTop = list.scrollTop;
        if (list.scrollHeight !== height && --left > 0) {
          height = list.scrollHeight;
          again();
        }
      });
    again();
  };
  const userInput = () => {
    userAt = performance.now();
    hold = false;
  };
  list.addEventListener(
    "wheel",
    (e) => {
      userInput();
      // Up: stop at once (a batch drawn before the scroll event would pull it back).
      if (e.deltaY < 0) follow = false;
    },
    { passive: true },
  );
  list.addEventListener("pointerdown", () => {
    userInput();
    pressing = true;
  });
  const letGo = () => (pressing = false);
  window.addEventListener("pointerup", letGo);
  // Keys that scroll the list (not typing in the filter box).
  m.root.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (/^(?:PageUp|PageDown|ArrowUp|ArrowDown|Home|End| )$/.test(e.key) && !t.closest("input, select, textarea")) userInput();
  });
  newer.addEventListener("click", () => {
    hold = false;
    follow = true;
    toBottom();
    seenAll();
  });
  list.addEventListener("scroll", () => {
    const up = list.scrollTop < lastTop - 1;
    lastTop = list.scrollTop;
    if (nearBottom()) {
      if (!hold) {
        follow = true;
        seenAll();
      }
    } else if (up && userScrolling()) follow = false;
  });

  /** The list: new messages appended to what is there (a whole redraw only
   * for another filter, or a clear), the oldest rows over SHOW taken away;
   * it follows new lines only when it was at its bottom. */
  function renderList() {
    const names = sessionNames();
    // The words to find are marked; those left out ("!word") are in no row shown.
    const terms = filterTerms(filterIn.value).want;
    const atBottom = follow;
    // A time clicked then shows the messages around it (below).
    list.classList.toggle("filtered", filtered());
    const key = `${filterIn.value}\u0000${level.value}\u0000${onlyFrom ?? ""}\u0000${[...hiddenNames].join(",")}`;
    const lead = messages[0]?.seq ?? seq + 1;
    if (key !== drawnFor || !messages.length || messages[messages.length - 1].seq < drawnUpTo) {
      // Another filter, or the messages cleared: drawn again whole.
      const shown = visible();
      shownCount = shown.length;
      const rows = shown.slice(-SHOW);
      list.innerHTML = rows.length
        ? rows.map((x) => rowHtml(x, names, terms)).join("")
        : `<p class="muted ftpd-empty">${messages.length ? "필터에 맞는 메시지가 없습니다." : "아직 받은 메시지가 없습니다."}</p>`;
      drawnFor = key;
      unseen = 0;
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
        if (!atBottom) unseen += fresh.length;
        list.querySelector(".ftpd-empty")?.remove();
        list.insertAdjacentHTML("beforeend", fresh.slice(-SHOW).map((x) => rowHtml(x, names, terms)).join(""));
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
        if (removed) {
          list.scrollTop -= removed;
          lastTop = list.scrollTop;
        }
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
    // Nothing to scroll any more (a filter or a clear left a short list): no
    // scroll event can say the bottom is reached, so it is taken so here.
    if (!follow && !hold && list.scrollHeight <= list.clientHeight + 1) follow = true;
    if (atBottom || follow) {
      toBottom();
      unseen = 0;
    }
    showUnseen();
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
      drawHiddenChip();
      drawRate();
      if (selecting()) waiting = true;
      else renderList();
    });
  };
  // Messages in, and a new UI language in place (the hidden-names chip is
  // kept from the page translation): drawn again.
  const offMessages = syslog.onChange(render);
  const offLanguage = onLanguageApplied(render);
  const off = () => (offMessages(), offLanguage());

  stateBox.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-addr]");
    if (!b) return;
    await writeClipboard(b.dataset.addr!);
    toast("주소를 복사했습니다", "success", 1600);
  });
  filterIn.addEventListener("input", render);
  level.addEventListener("change", render);
  onlyChip.addEventListener("click", () => showOnly(null));
  hiddenChip.addEventListener("click", () => hideName(null));
  const bell = m.root.querySelector<HTMLButtonElement>("[data-bell]")!;
  setPressed(bell, alertOn);
  bell.addEventListener("click", () => {
    setAlert(!alertOn);
    setPressed(bell, alertOn);
    toast(alertOn ? "err 이상 메시지가 오면 알립니다 (창을 닫아도)" : "Syslog 경보를 껐습니다", "info", 3000);
  });
  // Words that alert whatever the severity ("UPDOWN" for a link going down,
  // which a device sends as an error or only as a notice).
  const wordsBtn = m.root.querySelector<HTMLButtonElement>("[data-bell-words]")!;
  setPressed(wordsBtn, alertWords.length > 0);
  wordsBtn.addEventListener("click", async () => {
    const r = await promptDialog({
      title: "Syslog 경보 낱말",
      icon: "Highlighter",
      label: "이 낱말이 든 메시지도 심각도와 상관없이 알립니다 (쉼표로 구분, 대소문자 무시)",
      value: loadPrefs().words,
      confirm: "저장",
    });
    if (!r) return;
    setWords(r.value.trim());
  });
  /** The alert words as typed: kept, used, and the rows shown marked again. */
  const setWords = (typed: string) => {
    alertWords = parseWords(typed);
    savePrefs({ ...loadPrefs(), words: typed });
    setPressed(wordsBtn, alertWords.length > 0);
    // The rows already shown get their marks for the new words.
    drawnFor = "";
    render();
    if (!alertWords.length) return void toast("경보 낱말을 지웠습니다", "info", 3000);
    toast(alertOn ? `경보 낱말 ${alertWords.length}개를 저장했습니다` : `경보 낱말 ${alertWords.length}개를 저장했습니다. 경보를 켜야 알립니다`, "success", 4000);
  };
  // A Cisco log message name in a message ("%LINK-3-UPDOWN"): those messages
  // alone (the filter), or an alert word, so they alert whatever their severity.
  // Only when the text holds one: a click elsewhere in a message does nothing.
  // A double click selects a word in the text: the menu waits for a second
  // click (and for the selection it makes) before it opens.
  let menuTimer = 0;
  list.addEventListener("click", (e) => {
    clearTimeout(menuTimer);
    const tx = (e.target as HTMLElement).closest<HTMLElement>(".syslog-row .tx");
    if (!tx || e.detail > 1 || !document.getSelection()?.isCollapsed) return;
    const names = [...new Set(findLogMnemonics(tx.textContent ?? "").map((m) => m.text))];
    if (!names.length) return;
    const x = e.clientX;
    menuTimer = window.setTimeout(() => {
      if (!tx.isConnected || !document.getSelection()?.isCollapsed) return;
      openMnemonicMenu(tx, names, x);
    }, 300);
  });
  const openMnemonicMenu = (tx: HTMLElement, names: string[], x: number) => {
    const r = tx.getBoundingClientRect();
    contextMenu(
      x || r.left,
      r.bottom + 2,
      names.flatMap((name) => {
        const known = alertWords.includes(name.toLowerCase());
        return [
          { label: "이 메시지만 보기", icon: "ListFilter", hint: name, userHint: true, action: () => ((filterIn.value = withExclusions(name)), render()) },
          // A flood of one kind (ACL logs, a flapping port) out of the way.
          { label: "이 메시지 숨기기", icon: "EyeOff", hint: name, userHint: true, action: () => hideName(name) },
          {
            label: known ? "경보 낱말에 있음" : "경보 낱말에 추가",
            icon: "Bell",
            hint: name,
            userHint: true,
            disabled: known,
            action: () => {
              // parseWords keeps the first 20: a 21st would be dropped without a word.
              if (alertWords.length >= 20) return void toast("경보 낱말은 20개까지입니다", "warn", 4000);
              const typed = loadPrefs().words.trim();
              setWords(typed ? `${typed}, ${name}` : name);
            },
          },
        ];
      }),
    );
  };
  // A sender's address: its messages alone, the network tools, a session, a copy.
  // A message's time clicked while the list is filtered (one device, a word,
  // a severity): every device's messages around it, to see what came just
  // before and after (the uplink that went down first, the neighbor that
  // reacted).
  list.addEventListener("click", (e) => {
    const time = (e.target as HTMLElement).closest<HTMLElement>(".syslog-row time");
    if (!time || !filtered() || !document.getSelection()?.isCollapsed) return;
    const seq = Number(time.parentElement!.dataset.seq);
    const r = time.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, [
      {
        label: "이 시각 앞뒤의 모든 메시지 보기",
        icon: "ListFilter",
        hint: time.textContent ?? "",
        userHint: true,
        action: () => {
          filterIn.value = "";
          level.value = "7";
          onlyFrom = null;
          onlyChip.hidden = true;
          onlyChip.querySelector("code")!.textContent = "";
          hiddenNames.clear();
          drawHiddenChip();
          // Drawn now, the view kept where the row will be put.
          follow = false;
          hold = true;
          cancelAnimationFrame(frame);
          frame = 0;
          renderState();
          drawRate();
          renderList();
          const row = list.querySelector<HTMLElement>(`.syslog-row[data-seq="${seq}"]`);
          if (!row) return void toast(`그 메시지는 모든 메시지 중 최근 ${SHOW}개 밖이라 목록에 없습니다`, "info", 4000);
          row.scrollIntoView({ block: "center" });
          // Again once the rows around it have their real height.
          requestAnimationFrame(() => row.isConnected && hold && row.scrollIntoView({ block: "center" }));
          row.classList.remove("flash");
          void row.offsetWidth;
          row.classList.add("flash");
        },
      },
    ]);
  });
  list.addEventListener("click", (e) => {
    const from = (e.target as HTMLElement).closest<HTMLElement>(".syslog-row .from");
    // A drag that selected text is no click on the address.
    if (!from || !document.getSelection()?.isCollapsed) return;
    const ip = from.textContent ?? "";
    if (!ip) return;
    const r = from.getBoundingClientRect();
    const make = newSessionHandler();
    // Its clock against this PC's, by its latest message with a time of its
    // own: log times of devices that disagree do not line up in an outage.
    let clock: ReturnType<typeof deviceClock> = null;
    for (let i = messages.length - 1, n = 0; i >= 0 && n < 500 && !clock; i--) {
      if (messages[i].from !== ip) continue;
      n++;
      clock = deviceClock(messages[i]);
    }
    const clockItem = clock && {
      label: clock.utcGuess
        ? "장비 시계: UTC로 기록하는 것으로 보임"
        : Math.abs(clock.skew) < 2000
          ? "장비 시계: 이 PC와 같음"
          : clock.skew > 0
            ? `장비 시계: 이 PC보다 ${skewText(clock.skew)} 빠름`
            : `장비 시계: 이 PC보다 ${skewText(clock.skew)} 느림`,
      icon: "Clock",
      hint: clock.mark === "*" ? "동기화 안 됨 (*)" : clock.mark === "." ? "NTP 동기화 끊김 (.)" : undefined,
      disabled: true,
    };
    contextMenu(r.left, r.bottom + 2, [
      ...(clockItem ? [clockItem, "-" as const] : []),
      onlyFrom === ip
        ? { label: "모든 장비의 메시지 보기", icon: "ListFilter", action: () => showOnly(null) }
        : { label: "이 장비의 메시지만 보기", icon: "ListFilter", action: () => showOnly(ip) },
      // Its console or shell, already open: the window steps aside for it.
      // Otherwise its saved sessions, to connect (the window closes first; receiving goes on).
      ...deviceItems(ip, () => m.close()),
      { label: "네트워크 도구", icon: "Activity", hint: "ping · 포트 · DNS", action: () => openNetworkTools(ip, "ping", null, false, false, () => m.close()) },
      // Does it still answer (a device sending "link down" or a reload)?
      { label: "연속 ping으로 지켜보기", icon: "Activity", action: () => openNetworkTools(ip, "ping", null, true, true, () => m.close()) },
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
    void writeClipboard(rows.map((x) => asText(x, false, true)).join("\n"));
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
        const prefs: Prefs = { port, lan: lanIn.checked, save: saveIn.checked, file: fileIn.value.trim(), alert: alertOn, words: loadPrefs().words };
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
  showSender = showOnly;
  if (from) showOnly(from);
}
