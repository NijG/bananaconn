// Network tools dialog: ping, TCP port check and DNS lookup (backend: nettools.rs).

import { api, on } from "./api";
import { writeClipboard } from "./clipboard";
import { icon } from "./icons";
import { tr, userText } from "./i18n";
import { macFormats, parseSubnetInput, subnetInfo } from "./ipLinks";
import { parseTarget, PROTOCOLS, type Session } from "./model";
import { state } from "./store";
import { beep, canOsNotify, contextMenu, errorText, esc, h, type MenuItem, modal, osNotify, requestAttention, sheetCell, toast } from "./ui";

export type NetTool = "ping" | "trace" | "ports" | "dns" | "subnet" | "sweep";

/** An IPv4 address as typed ("10.0.0.1"): the echo tools take only these. */
const isIPv4 = (a: string) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(a) && a.split(".").every((o) => Number(o) <= 255);

/** What a router's "unreachable" answer to a trace says (its IP status). */
const UNREACHABLE: Record<number, string> = {
  11002: "네트워크에 닿을 수 없음",
  11003: "호스트에 닿을 수 없음",
  11004: "프로토콜에 닿을 수 없음",
  11005: "포트에 닿을 수 없음",
};

/** Opens the session editor with these settings (main's): "new session at
 * this address" for an address a sweep found. `beforeConnect` runs when the
 * session is saved to connect, before its tab opens: the dialog closes, so
 * the tab (a host key or password question in it) is not left behind it. */
type NewSessionHandler = (defaults: Partial<Session>, beforeConnect: () => void) => void;
let newSession: NewSessionHandler | null = null;
export function setNewSessionHandler(f: NewSessionHandler) {
  newSession = f;
}
/** Opens a saved session in a tab (main's): "connect" on an address a sweep found. */
let openSaved: ((s: Session) => void) | null = null;
export function setSessionOpener(f: (s: Session) => void) {
  openSaved = f;
}
/** "Connect" items for the saved sessions to an address (the first five), for
 * an address menu in a dialog: `close` runs first, so the tab (a host key or
 * password question in it) is not left behind the dialog. One click, one connection. */
export function savedSessionItems(ip: string, close: () => void): MenuItem[] {
  const open = openSaved;
  if (!open) return [];
  const key = ip.trim().toLowerCase();
  return state.sessions
    .filter((s) => s.host.trim().toLowerCase() === key)
    .slice(0, 5)
    .map((s) => ({ label: "연결", icon: "Play", hint: s.name, userHint: true, action: () => (close(), open(s)) }));
}
/** The first saved session's name for each address (lower-case, as the menus match). */
function savedNames(): Map<string, string> {
  const byHost = new Map<string, string>();
  for (const s of state.sessions) {
    const host = s.host.trim().toLowerCase();
    if (host && !byHost.has(host)) byHost.set(host, s.name);
  }
  return byHost;
}
/** The saved sessions' addresses offered as the host box is typed in (a
 * serial port is no address), each once, with its session's name beside it. */
function savedHostOptions(): string {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const s of state.sessions) {
    const host = s.host.trim();
    const key = host.toLowerCase();
    if (!host || s.protocol === "serial" || seen.has(key)) continue;
    seen.add(key);
    options.push(`<option value="${esc(host)}" label="${esc(s.name)}"></option>`);
    if (options.length >= 500) break;
  }
  return options.join("");
}
/** Marks the open tabs connected to a host whose continuous ping went unanswered (main's). */
let markDevice: (host: string) => void = () => {};
export function setDeviceMarker(f: (host: string) => void) {
  markDevice = f;
}
/** The same opener for other windows' address menus (Syslog's senders); null before main sets it. */
export function newSessionHandler(): NewSessionHandler | null {
  return newSession;
}

/** A length of time as m:ss, or h:mm:ss from an hour (the same in every language). */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mmss = `${Math.floor((s % 3600) / 60)}:${String(s % 60).padStart(2, "0")}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mmss.padStart(5, "0")}` : mmss;
}

/** The port check's starting list. */
const DEFAULT_PORTS = "22, 23, 80, 443, 3389, 5900";

/** Sessions a direct TCP check can say something about (see checkReachable). */
const directlyCheckable = (s: Pick<Session, "protocol" | "host" | "options">) =>
  !!s.host.trim() && s.protocol !== "serial" && s.protocol !== "tftp" && !s.options.proxyType && !String(s.options.jumpHost ?? "").trim() && !s.options.gateway;

/** A checkReachableMany run is going: a second click would only stack a
 * second set of connects and a second result dialog. */
let manyRunning = false;

/** Check many saved sessions at once (8 at a time) and show one table. */
/** `connect`: double-clicking a row closes the dialog and opens that session. */
export async function checkReachableMany(list: Session[], connect?: (s: Session) => void): Promise<void> {
  if (!list.length) return void toast("확인할 세션이 없습니다", "info");
  if (manyRunning) return void toast("확인하는 중...", "info");
  manyRunning = true;
  try {
    await runReachableMany(list, connect);
  } finally {
    manyRunning = false;
  }
}

async function runReachableMany(list: Session[], connect?: (s: Session) => void): Promise<void> {
  const todo = list.filter(directlyCheckable);
  // Sessions to the same host:port (another user, another protocol option)
  // share one connect: same answer, fewer connects to the server.
  const target = (s: Session) => `${s.host.trim().toLowerCase()}\n${s.port || PROTOCOLS[s.protocol].port}`;
  const targets = [...new Set(todo.map(target))];
  const byTarget = new Map<string, { open: boolean; text: string }>();
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const key = targets[next++];
      const [host, port] = key.split("\n");
      try {
        const [r] = await api.netPorts(host, [Number(port)]);
        byTarget.set(key, r?.open ? { open: true, text: `열려 있음 (${r.ms ?? 0}ms)` } : { open: false, text: r?.detail ?? "응답 없음" });
      } catch (err) {
        byTarget.set(key, { open: false, text: errorText(err) });
      }
    }
  };
  // An unanswered host takes up to 3 s per address: say something meanwhile.
  const working = todo.length ? toast("확인하는 중...", "info", 120_000) : null;
  try {
    await Promise.all(Array.from({ length: Math.min(8, targets.length) }, worker));
  } finally {
    working?.();
  }
  const results = new Map<string, { open: boolean; text: string }>();
  for (const s of todo) {
    const r = byTarget.get(target(s));
    if (r) results.set(s.id, r);
  }
  const open = [...results.values()].filter((r) => r.open).length;
  // Problems first: failed, then not tested, then open (stable within each).
  const rank = (s: Session) => {
    const r = results.get(s.id);
    return r ? (r.open ? 2 : 0) : 1;
  };
  const rows = [...list]
    .sort((a, b) => rank(a) - rank(b))
    .map((s) => {
      const r = results.get(s.id);
      const port = s.port || PROTOCOLS[s.protocol].port;
      return `<tr data-sid="${esc(s.id)}"><td data-i18n-skip><b>${esc(s.name || s.host)}</b></td><td class="mono" data-i18n-skip>${esc(`${s.host}:${port}`)}</td>
        <td class="${r ? (r.open ? "ok" : "bad") : "muted"}">${esc(r ? r.text : "확인하지 않음 (프록시·점프 호스트·게이트웨이·시리얼·TFTP)")}</td></tr>`;
    })
    .join("");
  const failed = todo.filter((s) => results.get(s.id)?.open === false);
  const recheck = failed.length ? `<button class="btn" data-recheck>${icon("RefreshCw", 14)}실패한 세션 다시 확인</button>` : "";
  const m = modal({
    title: "연결 확인 결과",
    icon: "Activity",
    width: 640,
    body: `<p class="muted small">${esc(`${todo.length}개 중 ${open}개 열림`)}</p><table class="reach-table"><thead><tr><th>이름</th><th>주소</th><th>상태</th></tr></thead><tbody>${rows}</tbody></table>`,
    footer: `${recheck}<button class="btn" data-copy-result>${icon("Copy", 14)}결과 복사</button><button class="btn btn-primary" data-close>닫기</button>`,
  });
  m.root.querySelector("[data-recheck]")?.addEventListener("click", () => {
    m.close();
    void checkReachableMany(failed, connect);
  });
  if (connect) {
    m.root.querySelector(".reach-table")!.classList.add("can-open");
    // Rows are reachable with Tab and open with Enter too, not only by mouse.
    m.root.querySelectorAll("tbody tr").forEach((tr) => {
      tr.setAttribute("title", "두 번 누르면 연결합니다");
      tr.setAttribute("tabindex", "0");
    });
    const open = (e: Event) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("tr[data-sid]")?.dataset.sid;
      const s = id && list.find((x) => x.id === id);
      if (!s) return;
      m.close();
      connect(s);
    };
    const body = m.root.querySelector("tbody")!;
    body.addEventListener("dblclick", open);
    body.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !(e.target as HTMLElement).matches("tr[data-sid]")) return;
      e.preventDefault();
      open(e);
    });
  }
  // The table as shown (in the screen language), one tab-separated line per row,
  // to paste into a spreadsheet: a session name starting with "=" stays text.
  m.root.querySelector("[data-copy-result]")!.addEventListener("click", () => {
    const lines = [...m.root.querySelectorAll<HTMLTableRowElement>(".reach-table tr")].map((tr) => [...tr.cells].map((c) => sheetCell(c.innerText.trim())).join("\t"));
    void writeClipboard(lines.join("\n"));
    toast("결과를 복사했습니다", "success", 1500);
  });
}

/** Can this PC reach the session's host:port directly? Reported as a toast.
 * Not for serial/TFTP (no TCP port), and not through a proxy, jump host or
 * gateway, where a direct connect would not tell how the session connects. */
export async function checkReachable(s: Pick<Session, "protocol" | "host" | "port" | "options">): Promise<void> {
  const host = s.host.trim();
  if (!host) return void toast("호스트를 입력하세요", "warn");
  if (s.protocol === "serial" || s.protocol === "tftp") return void toast("시리얼과 TFTP는 연결 확인을 할 수 없습니다", "info");
  if (s.options.proxyType || String(s.options.jumpHost ?? "").trim() || s.options.gateway)
    return void toast("프록시·점프 호스트·게이트웨이를 거치는 세션은 직접 확인할 수 없습니다", "info");
  const port = s.port || PROTOCOLS[s.protocol].port;
  const working = toast("확인하는 중...", "info", 120_000);
  try {
    const [r] = await api.netPorts(host, [port]).finally(working);
    if (r?.open) toast(`${userText(`${host}:${port}`)} 포트가 열려 있습니다 (${r.ms ?? 0}ms)`, "success");
    else toast(`${userText(`${host}:${port}`)} — ${r?.detail ?? "응답 없음"}`, "warn", 6000);
  } catch (err) {
    toast(errorText(err), "error");
  }
}

/** "22, 80, 8000-8010" → ports; null if any part is invalid. */
export function parsePorts(text: string): number[] | null {
  const out = new Set<number>();
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const m = part.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || a > b || b - a > 64) return null;
    for (let p = a; p <= b; p++) out.add(p);
  }
  // The limit is for the whole list ("1-60, 100-160" is 121 ports).
  return out.size && out.size <= 64 ? [...out] : null;
}

/** What kind of IPv4 address it is (the special-purpose blocks a network
 * engineer meets; anything else is public). */
function addressKind(ip: string): string {
  const [a, b, c] = ip.split(".").map(Number);
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "사설 (RFC 1918)";
  if (a === 100 && b >= 64 && b <= 127) return "공유 주소 (CGNAT, RFC 6598)";
  if (a === 127) return "루프백";
  if (a === 169 && b === 254) return "링크 로컬 (APIPA)";
  if (a >= 224 && a <= 239) return "멀티캐스트";
  // "This network", reserved 240/4 and broadcast, IETF protocol assignments,
  // the documentation ranges and the benchmarking block.
  if (a === 0 || a >= 240 || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || (a === 198 && (b === 18 || b === 19)))
    return "특수 용도 (예약)";
  return "공인";
}

/** The subnet calculator's result for an address and prefix length. */
function subnetTable(ip: string, prefix: number): string {
  const s = subnetInfo(ip, prefix);
  const row = (label: string, value: string, mono = true) => `<tr><th>${label}</th><td${mono ? ` class="mono" data-i18n-skip` : ""}>${esc(value)}</td></tr>`;
  return `<table class="nettools-table subnet-table"><tbody>
      ${row("주소", `${ip}/${prefix}`)}
      ${row("종류", addressKind(ip), false)}
      ${row("네트워크", `${s.network}/${prefix}`)}
      ${prefix < 31 ? row("브로드캐스트", s.broadcast) : ""}
      ${row("사용 가능한 범위", s.first === s.last ? s.first : `${s.first} – ${s.last}`)}
      ${row("호스트 수", s.hosts.toLocaleString())}
      ${row("서브넷 마스크", s.mask)}
      ${row("와일드카드 마스크", s.wildcard)}
    </tbody></table>${prefix === 31 ? `<p class="muted small">/31은 점대점 링크라 두 주소를 모두 씁니다 (RFC 3021).</p>` : ""}`;
}

/** IANA service names of well-known TCP ports (the port check is TCP), as the
 * registry writes them, with the common name after a slash where the registry
 * name says little ("ms-wbt-server" is RDP). */
const WELL_KNOWN_PORTS: Record<number, string> = {
  20: "ftp-data", 21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "domain/DNS", 80: "http", 88: "kerberos",
  110: "pop3", 111: "sunrpc", 119: "nntp", 123: "ntp", 135: "epmap/RPC", 139: "netbios-ssn", 143: "imap", 179: "bgp",
  389: "ldap", 443: "https", 445: "microsoft-ds/SMB", 465: "submissions", 514: "shell/rsh", 515: "printer/LPD",
  587: "submission", 636: "ldaps", 830: "netconf-ssh", 873: "rsync", 990: "ftps", 993: "imaps", 995: "pop3s",
  1433: "ms-sql-s", 1521: "ncube-lm/Oracle", 1723: "pptp", 1883: "mqtt", 2049: "nfs", 3306: "mysql", 3389: "ms-wbt-server/RDP",
  5432: "postgresql", 5900: "rfb/VNC", 5985: "wsman/WinRM", 5986: "wsmans/WinRM", 6379: "redis", 8080: "http-alt",
  8443: "pcsync-https", 9100: "pdl-datastream/JetDirect", 27017: "mongodb",
};

/** The TCP ports whose kind of session the app opens (TFTP is UDP: not found by the port check). */
const PORT_PROTOCOL: Record<number, Session["protocol"]> = { 21: "ftp", 22: "ssh", 23: "telnet", 990: "ftps", 3389: "rdp", 5900: "vnc" };

/** A result table (a sweep's, a port check's) sorted by the column whose
 * heading is clicked (again: the other way). Each column's kind is read from
 * its cells at the click (names come in later): addresses as numbers, round
 * trips as times (none last), whole numbers (ports) as numbers, the rest as
 * text (empty last). */
function sortableTable(table: HTMLTableElement) {
  table.classList.add("sortable");
  const heads = [...table.tHead!.rows[0].cells];
  const ipNum = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
  heads.forEach((th, col) => {
    // By keyboard too: Tab to a heading, Enter or Space sorts (as the address links open).
    th.tabIndex = 0;
    th.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      th.click();
    });
    th.addEventListener("click", () => {
      const body = table.tBodies[0];
      const up = th.getAttribute("aria-sort") !== "ascending";
      heads.forEach((h) => h.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", up ? "ascending" : "descending");
      const text = (row: HTMLTableRowElement) => (row.cells[col]?.textContent ?? "").trim();
      const all = [...body.rows];
      const kind = all.some((r) => r.cells[col]?.querySelector("[data-ip]:not([data-port])"))
        ? "ip"
        : all.some((r) => /^\d+ ms$/.test(text(r)))
          ? "ms"
          : all.every((r) => /^\d*$/.test(text(r)))
            ? "num"
            : "text";
      const key = (row: HTMLTableRowElement): number | string => {
        const t = text(row);
        if (kind === "ip") return ipNum(row.cells[col].querySelector<HTMLElement>("[data-ip]:not([data-port])")?.dataset.ip ?? "");
        if (kind === "ms") return /^\d+ ms$/.test(t) ? Number.parseInt(t, 10) : Infinity;
        if (kind === "num") return t ? Number(t) : Infinity;
        return t.toLowerCase();
      };
      const rows = [...body.rows].map((r) => ({ r, k: key(r) }));
      rows.sort((a, b) => {
        // An empty name or MAC, or no round trip, stays at the end either way.
        const ea = a.k === "" || a.k === Infinity;
        const eb = b.k === "" || b.k === Infinity;
        if (ea !== eb) return ea ? 1 : -1;
        const c = typeof a.k === "number" && typeof b.k === "number" ? a.k - b.k : String(a.k).localeCompare(String(b.k), undefined, { numeric: true });
        return up ? c : -c;
      });
      body.append(...rows.map((x) => x.r));
    });
  });
}

/** The host addresses of a subnet, as a sweep pings them (the backend's
 * sweep_targets): the network and broadcast addresses left out, except in
 * a /31 (both are hosts) and a /32 (the one address). */
function hostsOf(ip: string, prefix: number): string[] {
  const s = subnetInfo(ip, prefix);
  const num = (d: string) => d.split(".").reduce((n, o) => n * 256 + Number(o), 0);
  const out: string[] = [];
  for (let n = num(s.first); n <= num(s.last); n++) out.push([24, 16, 8, 0].map((k) => Math.floor(n / 2 ** k) % 256).join("."));
  return out;
}

/** The addresses each range's last finished sweep found, keyed by its first
 * and last host: a later sweep of the same range shows what came and what no
 * longer answers (a device just plugged in, one gone down). Kept across runs
 * (the last SWEEPS_KEPT ranges) so today's sweep compares with yesterday's. */
const SWEEPS_KEY = "bx.lastSweeps";
const SWEEPS_KEPT = 20;
const lastSweeps = loadSweeps();

function loadSweeps(): Map<string, { at: number; ips: Set<string> }> {
  const out = new Map<string, { at: number; ips: Set<string> }>();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SWEEPS_KEY) ?? "[]");
    // An entry of another shape (an edited or older store) is left out.
    if (Array.isArray(raw))
      for (const e of raw)
        if (Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number" && Array.isArray(e[2]) && e[2].every((ip: unknown) => typeof ip === "string"))
          out.set(e[0], { at: e[1], ips: new Set(e[2] as string[]) });
  } catch {
    // None kept: the first sweep of each range has nothing to compare with.
  }
  return out;
}

/** This range's finished sweep, as the one the next compares with (the oldest ranges dropped). */
/** The addresses the kept sweeps found, the latest sweep's first, each once. */
export function recentSweepHosts(): string[] {
  const out = new Set<string>();
  for (const s of [...lastSweeps.values()].sort((a, b) => b.at - a.at)) for (const ip of s.ips) out.add(ip);
  return [...out];
}

function rememberSweep(key: string, ips: Set<string>) {
  lastSweeps.delete(key);
  lastSweeps.set(key, { at: Date.now(), ips });
  while (lastSweeps.size > SWEEPS_KEPT) lastSweeps.delete(lastSweeps.keys().next().value!);
  try {
    localStorage.setItem(SWEEPS_KEY, JSON.stringify([...lastSweeps].map(([k, v]) => [k, v.at, [...v.ips]])));
  } catch {
    // Not kept for the next run; this one still compares.
  }
}

/** When the last sweep was: its time today, its date and time before. */
function sweepTime(at: number): string {
  const d = new Date(at);
  const time = d.toTimeString().slice(0, 8);
  if (d.toDateString() === new Date().toDateString()) return time;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time.slice(0, 5)}`;
}

/** The network tools dialog, on `initialTool`. The subnet calculator can start
 * with a prefix length (one read next to the address in terminal output). */
/** `startNow`: start the tool at once on `initialHost` (an address picked in the output).
 * `continuous`: the ping as "Keep sending" (watching a device come back after a restart). */
export function openNetworkTools(initialHost = "", initialTool: NetTool = "ping", initialPrefix: number | null = null, startNow = false, continuous = false) {
  let tool: NetTool = "ping";
  /** The host box's suggestions (one list per dialog). */
  const hostListId = `nettools-hosts-${crypto.randomUUID()}`;
  let busy = false;
  /** The ping running now, so "Stop" and closing the dialog end ping.exe. */
  let pingId: string | null = null;
  const stopPing = () => pingId && api.netPingCancel(pingId).catch(() => {});
  /** The sweep running now: "Stop" and closing the dialog end it. */
  let sweepId: string | null = null;
  const stopSweep = () => sweepId && api.netSweepCancel(sweepId).catch(() => {});
  /** The continuous ping running now (Ping with "계속 보내기"). */
  let watchId: string | null = null;
  /** The echoes have started (net_watch called), so there is something to stop. */
  let watchStarted = false;
  const stopWatch = () => {
    const id = watchId;
    watchId = null;
    if (id && watchStarted) void api.netWatchStop(id).catch(() => {});
  };
  /** The trace running now, and whether net_trace has been called for it. */
  let traceId: string | null = null;
  let traceStarted = false;
  const stopTrace = () => {
    const id = traceId;
    traceId = null;
    if (id && traceStarted) void api.netTraceStop(id).catch(() => {});
  };
  const m = modal({
    title: "네트워크 도구",
    icon: "Activity",
    width: 640,
    body: `<div class="nettools">
        <div class="seg nettools-tabs" role="tablist">
          <button data-tool="ping" class="on">${icon("Activity", 14)}Ping</button>
          <button data-tool="trace">${icon("Waypoints", 14)}경로 추적</button>
          <button data-tool="ports">${icon("Unplug", 14)}포트 확인</button>
          <button data-tool="dns">${icon("Globe", 14)}DNS 조회</button>
          <button data-tool="subnet">${icon("Network", 14)}서브넷 계산</button>
          <button data-tool="sweep">${icon("Radar", 14)}IP 스캔</button>
        </div>
        <form class="form nettools-form" autocomplete="off" novalidate>
          <div class="inline">
            <input name="host" placeholder="호스트 또는 IP (예: 192.168.0.1)" spellcheck="false" value="${esc(initialHost)}" list="${hostListId}"/>
            <datalist id="${hostListId}" data-i18n-skip>${savedHostOptions()}</datalist>
            <input name="extra" class="nettools-extra" spellcheck="false"/>
            <label class="check nettools-cont" title="중지할 때까지 1초마다 보내고, 끊기거나 다시 응답하면 알립니다"><input type="checkbox" name="cont"/>계속 보내기</label>
            <button type="submit" class="btn btn-primary" data-run>${icon("Play", 14)}실행</button>
          </div>
        </form>
        <div class="nettools-out" role="log"><p class="muted">결과가 여기에 표시됩니다.</p></div>
      </div>`,
    footer: `<button class="btn" data-close>닫기</button><button class="btn" data-copy-free hidden>${icon("Copy", 14)}응답 없는 주소 복사</button><button class="btn" data-copy-result hidden>${icon("Copy", 14)}결과 복사</button>`,
    onClose: () => {
      void stopPing();
      void stopSweep();
      void stopWatch();
      void stopTrace();
    },
  });
  // novalidate: the code reads the boxes itself (count clamped, ports and
  // prefix parsed); the browser's own check would silently block Run when the
  // box it objects to is hidden (DNS lookup).
  const form = m.root.querySelector<HTMLFormElement>(".nettools-form")!;
  const host = form.querySelector<HTMLInputElement>("[name=host]")!;
  const extra = form.querySelector<HTMLInputElement>("[name=extra]")!;
  const cont = form.querySelector<HTMLInputElement>("[name=cont]")!;
  const contBox = form.querySelector<HTMLElement>(".nettools-cont")!;
  // A count means nothing to a ping that goes on until stopped.
  cont.addEventListener("change", () => (extra.disabled = cont.checked));
  const out = m.root.querySelector<HTMLElement>(".nettools-out")!;
  const run = m.root.querySelector<HTMLButtonElement>("[data-run]")!;
  const copyBtn = m.root.querySelector<HTMLButtonElement>("[data-copy-result]")!;
  // The addresses the last sweep found no answer at (a free one to take).
  const freeBtn = m.root.querySelector<HTMLButtonElement>("[data-copy-free]")!;
  let free: string[] = [];
  /** The network the last finished sweep was run on, and its results while
   * another tool is used (an address in them pinged): shown again together
   * on coming back to the sweep. */
  let swept: { host: string; prefix: string } | null = null;
  let kept: Node[] | null = null;
  freeBtn.addEventListener("click", () => {
    if (!free.length) return;
    void writeClipboard(free.join("\n"));
    toast(`응답 없는 주소 ${free.length}개를 복사했습니다`, "success", 2000);
  });
  copyBtn.addEventListener("click", () => {
    // As shown (a table as tab-separated rows), without the sweep's "new" marks:
    // an address cell pasted elsewhere stays just the address.
    out.classList.add("copying");
    const text = out.innerText.trim();
    out.classList.remove("copying");
    if (!text) return;
    void writeClipboard(text);
    toast("결과를 복사했습니다", "success", 1500);
  });

  const placeholder = () => {
    out.innerHTML = `<p class="muted">결과가 여기에 표시됩니다.</p>`;
    copyBtn.hidden = true;
    freeBtn.hidden = true;
  };
  /** A prefix typed with the address ("/24", a mask) is the one used: shown
   * in the prefix box, which then takes no input of its own. */
  const mirrorPrefix = () => {
    const parsed = parseSubnetInput(host.value);
    const carried = parsed?.prefix ?? null;
    extra.disabled = carried !== null;
    const shown = carried !== null ? String(carried) : ownPrefix;
    if (extra.value !== shown) extra.value = shown;
    return parsed;
  };
  /** The prefix box's own value (typed there, or read with the address in
   * terminal output): shown again once the address stops carrying one. */
  let ownPrefix = "24";
  /** The calculator works as it is typed into; `strict` (Enter, Run) also
   * says what is wrong with an entry it cannot read. A prefix typed with the
   * address ("/24", a mask) is the one used, and shown in the prefix box. */
  const calculate = (strict: boolean) => {
    const parsed = mirrorPrefix();
    const typed = /^\d{1,2}$/.test(extra.value.trim()) && Number(extra.value) <= 32 ? Number(extra.value) : null;
    const prefix = parsed?.prefix ?? typed;
    if (!parsed || prefix === null) {
      if (!strict) return placeholder();
      out.innerHTML = `<p class="danger-text">IPv4 주소와 접두사 길이를 입력하세요 (예: 10.0.0.5/24, 10.0.0.5 255.255.255.0)</p>`;
      copyBtn.hidden = true;
      return;
    }
    out.innerHTML = subnetTable(parsed.ip, prefix);
    copyBtn.hidden = false;
  };
  host.addEventListener("input", () => {
    if (tool === "subnet") calculate(false);
    else if (tool === "sweep") mirrorPrefix();
  });
  extra.addEventListener("input", () => {
    if (tool !== "subnet" && tool !== "sweep") return;
    ownPrefix = extra.value;
    if (tool === "subnet") calculate(false);
  });

  const setTool = (t: NetTool) => {
    const was = tool;
    tool = t;
    if (was === "sweep" && t !== "sweep" && swept !== null) kept = [...out.childNodes];
    m.root.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
    extra.hidden = t === "dns";
    extra.disabled = false;
    contBox.hidden = t !== "ping";
    if (t !== "sweep") freeBtn.hidden = true;
    host.placeholder = t === "subnet" ? "IP 주소 (예: 10.0.0.5/24)" : t === "sweep" ? "네트워크 (예: 192.168.0.0/24)" : "호스트 또는 IP (예: 192.168.0.1)";
    const withPrefix = (x: NetTool) => x === "subnet" || x === "sweep";
    if (withPrefix(was) && !withPrefix(t)) {
      // "10.0.0.5/24" is not a host ping or the port check can take.
      const p = parseSubnetInput(host.value);
      if (p) host.value = p.ip;
      placeholder();
    }
    if (t === "subnet") {
      extra.type = "number";
      extra.min = "0";
      extra.max = "32";
      extra.value = ownPrefix;
      extra.title = "접두사 길이 (0~32)";
      calculate(false);
    } else if (t === "sweep") {
      extra.type = "number";
      extra.min = "22";
      extra.max = "32";
      extra.title = "접두사 길이 (22~32)";
      if (was !== "sweep" && kept && swept !== null) {
        // The address and prefix the results are for, as they were typed.
        host.value = swept.host;
        if (parseSubnetInput(swept.host)?.prefix == null) ownPrefix = swept.prefix;
        out.replaceChildren(...kept);
        copyBtn.hidden = !out.querySelector("table.nettools-table");
        freeBtn.hidden = !free.length;
      } else if (was !== "sweep") placeholder();
      kept = null;
      mirrorPrefix();
    } else if (t === "ping") {
      extra.type = "number";
      extra.min = "1";
      extra.max = "20";
      extra.value = "4";
      extra.title = "보낼 횟수";
      extra.disabled = cont.checked;
    } else if (t === "trace") {
      extra.type = "number";
      extra.min = "1";
      extra.max = "64";
      extra.value = "30";
      extra.title = "최대 홉 수";
    } else if (t === "ports") {
      extra.type = "text";
      extra.value = DEFAULT_PORTS;
      extra.title = "포트 (쉼표, 범위 8000-8010)";
    }
    host.focus();
  };
  // Not while a run is going: its result would land under the other tool.
  m.root.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => b.addEventListener("click", () => !busy && setTool(b.dataset.tool as NetTool)));

  /** Ping every host of the subnet (sweep, in the backend): those that
   * answer, and the ones that did not for "copy the free addresses". */
  const runSweep = async () => {
    // The results on screen go, and with them what they were for (a later
    // return to this tool shows what is there now, not an older sweep).
    swept = null;
    free = [];
    const parsed = mirrorPrefix();
    const typed = /^\d{1,2}$/.test(extra.value.trim()) ? Number(extra.value) : NaN;
    const prefix = parsed?.prefix ?? typed;
    if (!parsed || !(prefix >= 22 && prefix <= 32)) {
      out.innerHTML = `<p class="danger-text">네트워크 주소와 접두사 길이를 입력하세요. 한 번에 /22(호스트 1022개)까지 검사할 수 있습니다 (예: 192.168.0.0/24)</p>`;
      copyBtn.hidden = freeBtn.hidden = true;
      return;
    }
    const all = hostsOf(parsed.ip, prefix);
    const input = { host: host.value, prefix: extra.value };
    busy = true;
    copyBtn.hidden = freeBtn.hidden = true;
    const label = run.innerHTML;
    run.innerHTML = `${icon("Square", 14)}중지`;
    const id = (sweepId = crypto.randomUUID());
    out.innerHTML = `<p class="muted"><span class="spinner sm"></span> <span data-sweep-progress>검사하는 중...</span></p>`;
    let unlisten = () => {};
    try {
      unlisten = await on<{ id: string; done: number; total: number }>("sweep-progress", (p) => {
        const el = p.id === id ? out.querySelector("[data-sweep-progress]") : null;
        if (el) el.textContent = tr(`검사하는 중... ${p.done} / ${p.total}`);
      });
      const hits = await api.netSweep(id, parsed.ip, prefix, 1000);
      // A host that answered ARP but not the ping is there all the same:
      // never among the free addresses.
      const present = new Set(hits.map((h) => h.ip));
      free = all.filter((ip) => !present.has(ip));
      const pinged = hits.filter((h) => h.ms != null).length;
      swept = input;
      // Against the last sweep of this same range (a stopped one never counts).
      const key = `${all[0]}-${all[all.length - 1]}`;
      const before = lastSweeps.get(key);
      rememberSweep(key, present);
      const added = new Set(before ? hits.filter((h) => !before.ips.has(h.ip)).map((h) => h.ip) : []);
      const gone = before ? [...before.ips].filter((ip) => !present.has(ip)) : [];
      // The ones that no longer answer, written out (a few) to look into; "this
      // time" as a lost ping or a busy device can be the cause, not only removal.
      // A saved session's device among them is told by its name, and first:
      // one of the user's own devices gone quiet matters most.
      const names = savedNames();
      const goneShown = [...gone.filter((ip) => names.has(ip)), ...gone.filter((ip) => !names.has(ip))]
        .slice(0, 12)
        .map((ip) => (names.has(ip) ? `<b>${esc(names.get(ip)!)}</b> ${esc(ip)}` : esc(ip)));
      const goneList = gone.length ? `: <span class="mono" data-i18n-skip>${goneShown.join(", ")}${gone.length > 12 ? " …" : ""}</span>` : "";
      const diff = before
        ? `<p class="muted small sweep-diff"><span>지난 스캔 이후</span> <span data-i18n-skip>(${sweepTime(before.at)})</span> · ${
            added.size || gone.length
              ? `<span class="sweep-new">${esc(`새로 응답 ${added.size}개`)}</span> · <span>${esc(`이번에 응답 없음 ${gone.length}개`)}</span>${goneList}`
              : `<span>바뀐 장비 없음</span>`
          }</p>`
        : "";
      // Two phrases, each translated as its own. An address opens what to do
      // with it; its name (DNS, the hosts file) is filled in once looked up.
      // A MAC column only when some host is on this PC's own segment.
      const withMac = hits.some((h) => h.mac);
      out.innerHTML = `<p class="muted small"><span>${esc(`${all.length}개 중 ${pinged}개 응답`)}</span>${
        hits.length > pinged ? ` · <span>${esc(`ping에 응답하지 않고 ARP로만 확인된 장비 ${hits.length - pinged}개`)}</span>` : ""
      } · <span>방화벽이 ping을 막는 장비는 응답 없음으로 보입니다</span></p>${diff}
        ${
          hits.length
            ? `<table class="nettools-table"><thead><tr><th>주소</th><th>이름</th>${withMac ? `<th title="이 PC의 ARP 표에서 읽습니다. 라우터 너머의 장비는 비어 있습니다">MAC</th>` : ""}<th>응답</th></tr></thead><tbody>${hits
                .map(
                  (h) => `<tr><td class="mono"><button type="button" class="sweep-link" data-ip="${esc(h.ip)}" title="Ping, 포트 확인, 새 세션 만들기"><span data-i18n-skip>${esc(h.ip)}</span></button>${
                    added.has(h.ip) ? ` <span class="sweep-new-tag" title="지난 스캔에는 없던 장비">새로</span>` : ""
                  }</td>
                    <td class="sweep-name" data-i18n-skip>…</td>${
                      withMac
                        ? `<td class="mono">${h.mac ? `<button type="button" class="sweep-link" data-mac="${esc(h.mac)}" title="다른 표기로 복사"><span data-i18n-skip>${esc(macFormats(h.mac)[0].text)}</span></button>` : ""}</td>`
                        : ""
                    }<td class="muted">${h.ms != null ? `${h.ms} ms` : "응답 없음 (ARP로 확인)"}</td></tr>`,
                )
                .join("")}</tbody></table>`
            : ""
        }`;
      freeBtn.hidden = !free.length;
      if (hits.length) void showNames(hits.map((h) => h.ip), [...out.querySelectorAll<HTMLElement>(".sweep-name")]);
      const table = out.querySelector<HTMLTableElement>("table.nettools-table");
      if (table) sortableTable(table);
    } catch (err) {
      const msg = errorText(err);
      out.innerHTML = msg === "CANCELLED" ? `<p class="muted">중지했습니다.</p>` : `<p class="danger-text">${esc(msg)}</p>`;
    } finally {
      unlisten();
      busy = false;
      if (sweepId === id) sweepId = null;
      run.innerHTML = label;
      copyBtn.hidden = !out.querySelector("table.nettools-table");
    }
  };

  /** Ping with "계속 보내기": an echo every second until Stop or the dialog closes
   * (nettools.rs net_watch), to watch a device go down and come back (a
   * reload). Shows whether it answers now and since when, the counts, the
   * last two minutes as bars and each change; a change is also told with a
   * sound, and as a Windows notification when the app is not in front. Down
   * means three echoes in a row unanswered, so one lost packet is not news. */
  const runWatch = async (target: string) => {
    busy = true;
    copyBtn.hidden = true;
    const label = run.innerHTML;
    run.innerHTML = `${icon("Square", 14)}중지`;
    out.innerHTML = `<p class="muted"><span class="spinner sm"></span> 주소를 확인하는 중...</p>`;
    let unlisten = () => {};
    /** A notice held back (tell), to give when its half minute is up. */
    let later = 0;
    const id = crypto.randomUUID();
    watchId = id;
    try {
      // The echo is IPv4: a name is looked up first, its first IPv4 address used.
      const ip = isIPv4(target) ? target : (await api.netDns(target)).addresses.find(isIPv4);
      if (!ip) throw new Error(`${userText(target)}의 IPv4 주소를 찾을 수 없습니다`);
      // Stopped while the name was looked up: nothing was sent.
      if (watchId !== id) return void (out.innerHTML = `<p class="muted">중지했습니다.</p>`);
      const shown = ip === target ? ip : `${target} (${ip})`;
      const LOST_AFTER = 3;
      const WIDTH = 120;
      const s = { sent: 0, got: 0, min: Infinity, max: 0, sum: 0, misses: 0, firstMiss: 0, answers: 0, down: null as number | null, told: 0, since: Date.now(), samples: [] as (number | null)[] };
      out.innerHTML = `<div class="watch">
          <p class="watch-head"><b class="watch-state" data-w-state></b> <span class="muted" data-i18n-skip>${esc(shown)}</span></p>
          <p class="muted small" data-w-stats></p>
          <svg class="watch-chart" viewBox="0 0 ${WIDTH} 40" preserveAspectRatio="none" aria-hidden="true"></svg>
          <ul class="watch-log" data-w-log></ul>
        </div>`;
      const stateEl = out.querySelector<HTMLElement>("[data-w-state]")!;
      const statsEl = out.querySelector<HTMLElement>("[data-w-stats]")!;
      const chart = out.querySelector<SVGSVGElement>(".watch-chart")!;
      const logEl = out.querySelector<HTMLElement>("[data-w-log]")!;
      // 24-hour hh:mm:ss, the same in every language.
      const time = () => {
        const d = new Date();
        return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
      };
      const log = (text: string) => {
        const li = h("li", {}, `<time>${time()}</time> <span>${esc(text)}</span>`);
        logEl.prepend(li);
        // A long night of flapping stays a readable list.
        while (logEl.children.length > 200) logEl.lastElementChild!.remove();
      };
      // A link that flaps every few seconds tells at most every half minute
      // (the record keeps every change).
      let toldTitle = "";
      const announce = (title: string) => {
        s.told = Date.now();
        toldTitle = title;
        beep();
        requestAttention();
        if (!document.hasFocus() && canOsNotify()) osNotify(tr(title), shown);
      };
      const tell = (title: string) => {
        const wait = 30_000 - (Date.now() - s.told);
        if (wait <= 0) return announce(title);
        // Within half a minute of the last one: told once when it is up, as
        // things stand then, unless that is what was told last.
        if (!later)
          later = window.setTimeout(() => {
            later = 0;
            if (watchId !== id) return;
            const now = s.down !== null ? "응답 없음" : "응답 재개";
            if (now !== toldTitle) announce(now);
          }, wait);
      };
      const render = () => {
        const now = Date.now();
        const last = s.samples[s.samples.length - 1];
        stateEl.textContent =
          s.down !== null ? tr(`응답 없음 · ${clock(now - s.down)}`)
          : !s.samples.length ? tr("보내는 중...")
          : last === null ? tr(`응답을 기다리는 중 (${s.misses}번 놓침)`)
          : tr(`응답 중 · ${last} ms`);
        stateEl.classList.toggle("down", s.down !== null);
        const loss = s.sent ? Math.round((100 * (s.sent - s.got)) / s.sent) : 0;
        const rtt = s.got ? `${s.min}/${Math.round(s.sum / s.got)}/${s.max}` : "-";
        statsEl.textContent = [`보냄 ${s.sent}`, `받음 ${s.got}`, `손실 ${loss}%`, `최소/평균/최대 ${rtt} ms`, `경과 ${clock(now - s.since)}`].map((p) => tr(p)).join(" · ");
        const top = Math.max(10, ...s.samples.map((v) => v ?? 0));
        const offset = WIDTH - s.samples.length;
        chart.innerHTML = s.samples
          .map((v, i) => (v === null ? `<rect class="lost" x="${offset + i}" y="0" width="0.8" height="40"/>` : `<rect x="${offset + i}" y="${40 - Math.max(1, (36 * v) / top)}" width="0.8" height="${Math.max(1, (36 * v) / top)}"/>`))
          .join("");
      };
      log(`모니터링 시작: ${userText(shown)}`);
      render();
      unlisten = await on<{ id: string; seq: number; ms: number | null }>("watch-reply", (p) => {
        if (p.id !== id) return;
        s.sent++;
        s.samples.push(p.ms);
        if (s.samples.length > WIDTH) s.samples.shift();
        if (p.ms !== null) {
          s.got++;
          s.min = Math.min(s.min, p.ms);
          s.max = Math.max(s.max, p.ms);
          s.sum += p.ms;
          s.misses = 0;
          // Back once two answers come in a row, not on one stray reply.
          if (s.down !== null && ++s.answers >= 2) {
            log(`응답 재개 (끊긴 시간 ${clock(Date.now() - s.down)})`);
            tell("응답 재개");
            s.down = null;
          }
        } else {
          s.answers = 0;
          // The first unanswered echo went out a wait (1 s) before its result came.
          if (++s.misses === 1) s.firstMiss = Date.now() - 1000;
          if (s.misses === LOST_AFTER && s.down === null) {
            s.down = s.firstMiss;
            log("응답 없음");
            tell("응답 없음");
            // Its tabs, by the name or the address it was given as.
            markDevice(target);
            if (ip !== target) markDevice(ip);
          }
        }
        render();
      });
      if (watchId !== id) return;
      watchStarted = true;
      await api.netWatch(id, ip, 1000);
      log("모니터링 중지");
    } catch (err) {
      out.innerHTML = `<p class="danger-text">${esc(errorText(err))}</p>`;
    } finally {
      unlisten();
      busy = false;
      clearTimeout(later);
      if (watchId === id) watchId = null;
      watchStarted = false;
      run.innerHTML = label;
      copyBtn.hidden = !out.querySelector(".watch");
    }
  };

  /** The route to a host (nettools.rs net_trace): each hop as it answers,
   * three round trips each ("*": none in time), its name (DNS) filled in
   * once looked up; an address opens what to do with it, as in the sweep. */
  const runTrace = async (target: string) => {
    busy = true;
    copyBtn.hidden = true;
    const label = run.innerHTML;
    run.innerHTML = `${icon("Square", 14)}중지`;
    out.innerHTML = `<p class="muted"><span class="spinner sm"></span> 주소를 확인하는 중...</p>`;
    let unlisten = () => {};
    const id = crypto.randomUUID();
    traceId = id;
    try {
      // The echoes are IPv4: a name is looked up first, its first IPv4 address used.
      const ip = isIPv4(target) ? target : (await api.netDns(target)).addresses.find(isIPv4);
      if (!ip) throw new Error(`${userText(target)}의 IPv4 주소를 찾을 수 없습니다`);
      // Stopped while the name was looked up: nothing was sent.
      if (traceId !== id) return void (out.innerHTML = `<p class="muted">중지했습니다.</p>`);
      const maxHops = Math.min(64, Math.max(1, Math.trunc(Number(extra.value)) || 30));
      const shown = ip === target ? ip : `${target} (${ip})`;
      out.innerHTML = `<p class="muted small"><span data-i18n-skip>${esc(shown)}</span> · <span>${esc(`최대 ${maxHops}홉`)}</span></p>
        <table class="nettools-table"><thead><tr><th>홉</th><th>주소</th><th>이름</th><th>응답</th></tr></thead><tbody></tbody></table>
        <p class="muted small" data-trace-state><span class="spinner sm"></span> <span>추적하는 중...</span></p>`;
      const body = out.querySelector("tbody")!;
      const stateEl = out.querySelector<HTMLElement>("[data-trace-state]")!;
      const time = (v: number | null) => (v === null ? "*" : v === 0 ? "&lt;1 ms" : `${v} ms`);
      unlisten = await on<{ id: string; ttl: number; addrs: string[]; ms: (number | null)[] }>("trace-hop", (p) => {
        if (p.id !== id) return;
        const row = document.createElement("tr");
        // Several addresses at one hop: routers sharing the load.
        row.innerHTML = `<td class="mono">${p.ttl}</td><td class="mono">${
          p.addrs.length
            ? p.addrs.map((a) => `<button type="button" class="sweep-link" data-ip="${esc(a)}" title="Ping, 포트 확인, 새 세션 만들기"><span data-i18n-skip>${esc(a)}</span></button>`).join("<br>")
            : `<span class="muted">*</span>`
        }</td><td class="sweep-name" data-i18n-skip>${p.addrs.length ? "…" : ""}</td><td class="muted mono">${p.ms.map(time).join(" · ")}</td>`;
        body.appendChild(row);
        if (!p.addrs.length) return;
        const cell = row.querySelector<HTMLElement>(".sweep-name")!;
        // A hop with no DNS or hosts name: its saved session's name, set apart
        // (muted), as the sweep's names (a router on the way is often a saved device).
        const fill = (names: (string | null)[]) => {
          const saved = savedNames();
          const shown = p.addrs.map((_, i) => names[i] ?? null);
          const fromSessions = shown.every((n) => !n) && p.addrs.some((a) => saved.has(a.toLowerCase()));
          cell.textContent = fromSessions
            ? p.addrs.flatMap((a) => saved.get(a.toLowerCase()) ?? []).join(", ")
            : shown.filter((n): n is string => !!n).join(", ");
          cell.classList.toggle("muted", fromSessions);
        };
        api.netNames(p.addrs).then(fill, () => fill([]));
      });
      if (traceId !== id) return void (out.innerHTML = `<p class="muted">중지했습니다.</p>`);
      traceStarted = true;
      const end = await api.netTrace(id, ip, maxHops);
      stateEl.innerHTML = end.reached
        ? `<span>${esc(`목적지에 도달했습니다 (${end.hops}홉)`)}</span>`
        : end.unreachable !== null
          ? `<span>라우터가 목적지에 닿을 수 없다고 응답했습니다</span> · <span>${esc(UNREACHABLE[end.unreachable] ?? `IP 상태 ${end.unreachable}`)}</span>`
          : `<span>${esc(`${end.hops}홉 안에 도달하지 못했습니다`)}</span> · <span>방화벽이 응답을 막는 구간은 *로 보입니다</span>`;
    } catch (err) {
      const msg = errorText(err);
      // The hops found so far stay; the end line says what happened.
      const stateEl = out.querySelector<HTMLElement>("[data-trace-state]");
      if (stateEl) {
        stateEl.classList.toggle("danger-text", msg !== "CANCELLED");
        stateEl.innerHTML = msg === "CANCELLED" ? `<span>중지했습니다.</span>` : `<span>${esc(msg)}</span>`;
      } else out.innerHTML = msg === "CANCELLED" ? `<p class="muted">중지했습니다.</p>` : `<p class="danger-text">${esc(msg)}</p>`;
    } finally {
      unlisten();
      busy = false;
      if (traceId === id) traceId = null;
      traceStarted = false;
      run.innerHTML = label;
      copyBtn.hidden = !out.querySelector("table.nettools-table tbody tr");
    }
  };

  /** The names of a sweep's addresses into their cells (kept with the results
   * when another tool is opened meanwhile); none when the lookup fails. */
  const showNames = async (ips: string[], cells: HTMLElement[]) => {
    let names: (string | null)[] = [];
    try {
      names = await api.netNames(ips);
    } catch {
      // Shown as no name.
    }
    // No DNS or hosts name: a saved session's name for the address, set apart (muted).
    const saved = savedNames();
    cells.forEach((c, i) => {
      const session = names[i] ? undefined : saved.get(ips[i]);
      c.textContent = names[i] ?? session ?? "";
      c.classList.toggle("muted", !!session);
    });
  };
  /** Ping or check the ports of an address from the sweep's results. */
  const runOn = (t: "ping" | "trace" | "ports", ip: string) => {
    if (busy) return;
    setTool(t);
    host.value = ip;
    form.requestSubmit();
  };
  out.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".sweep-link");
    if (!b || busy) return;
    // Under the address, by mouse or by keyboard (Enter on it).
    const r = b.getBoundingClientRect();
    // A MAC: copied in the notation the next tool or switch wants.
    const mac = b.dataset.mac;
    if (mac) return void contextMenu(r.left, r.bottom + 2, macFormats(mac).map((m) => ({ label: m.text, icon: "Copy", hint: m.style, action: () => void writeClipboard(m.text) })));
    const ip = b.dataset.ip;
    if (!ip) return;
    // An open port found by the port check: a session of its kind, to that port
    // (in the editor first: nothing connects from here).
    const port = Number(b.dataset.port);
    const protocol = PORT_PROTOCOL[port];
    if (protocol)
      return void contextMenu(r.left, r.bottom + 2, [
        { label: "이 포트로 새 세션 만들기…", icon: "Plus", hint: `${PROTOCOLS[protocol].label} :${port}`, action: () => newSession?.({ protocol, host: ip, port }, () => m.close()) },
        ...savedSessionItems(ip, () => m.close()),
      ]);
    contextMenu(r.left, r.bottom + 2, [
      // Each says which ping it is: the "Keep sending" box set to match.
      { label: "Ping", icon: "Activity", action: () => ((cont.checked = false), runOn("ping", ip)) },
      { label: "연속 ping으로 지켜보기", icon: "Activity", action: () => ((cont.checked = true), runOn("ping", ip)) },
      { label: "경로 추적", icon: "Waypoints", action: () => runOn("trace", ip) },
      { label: "포트 확인", icon: "Unplug", action: () => runOn("ports", ip) },
      ...savedSessionItems(ip, () => m.close()),
      ...(newSession ? [{ label: "이 주소로 새 세션 만들기…", icon: "Plus", action: () => newSession?.({ protocol: "ssh" as const, host: ip }, () => m.close()) }] : []),
      { label: "주소 복사", icon: "ClipboardList", action: () => void writeClipboard(ip) },
    ]);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (tool === "subnet") return calculate(true);
    if (tool === "sweep") return busy ? void stopSweep() : void runSweep();
    if (busy) return void (traceId ? stopTrace() : watchId ? stopWatch() : stopPing());
    // "root@10.0.0.1:22" or "https://server.lan/admin" pasted: the tools take a
    // host, so use the host part (as Quick connect reads it) and show it.
    const raw = host.value.trim();
    const parsed = parseTarget(raw);
    const target = parsed?.host ?? raw;
    if (target !== raw) host.value = target;
    // "10.0.0.1:2222" in the port check: that port is the one meant, unless
    // the port list was already changed from its default.
    if (tool === "ports" && parsed?.port && extra.value === DEFAULT_PORTS) extra.value = String(parsed.port);
    if (!target) return void host.focus();
    if (tool === "ping" && cont.checked) return void runWatch(target);
    if (tool === "trace") return void runTrace(target);
    busy = true;
    copyBtn.hidden = true;
    const label = run.innerHTML;
    if (tool === "ping") run.innerHTML = `${icon("Square", 14)}중지`;
    else run.disabled = true;
    out.innerHTML = `<p class="muted"><span class="spinner sm"></span> ${tool === "ping" ? "ping 보내는 중..." : "확인하는 중..."}</p>`;
    try {
      if (tool === "ping") {
        // A whole count the backend takes (1-20): "-3", "2.5" or "1e10" would be refused raw.
        const count = Math.min(20, Math.max(1, Math.trunc(Number(extra.value)) || 4));
        pingId = crypto.randomUUID();
        const text = await api.netPing(pingId, target, count);
        out.innerHTML = `<pre class="mono" data-i18n-skip>${esc(text)}</pre>`;
      } else if (tool === "ports") {
        const ports = parsePorts(extra.value);
        if (!ports) throw new Error("포트 형식: 22, 80, 8000-8010 (1~65535, 한 번에 64개까지)");
        const res = await api.netPorts(target, ports);
        const openCount = res.filter((r) => r.open).length;
        // The well-known service of a port, in a column of its own (the port
        // column stays a number when the table is pasted elsewhere); last, so
        // the state stays the second column its colour is set on.
        const named = res.some((r) => WELL_KNOWN_PORTS[r.port]);
        out.innerHTML = `<p class="muted small">${esc(`${res.length}개 중 ${openCount}개 열림`)}</p><table class="nettools-table"><thead><tr><th>포트</th><th>상태</th><th>응답</th>${named ? "<th>서비스</th>" : ""}</tr></thead><tbody>${res
          .map(
            (r) => `<tr class="${r.open ? "open" : "closed"}"><td class="mono">${
              // An open port of a kind of session the app has: a new session to it.
              r.open && PORT_PROTOCOL[r.port] && newSession
                ? `<button type="button" class="sweep-link" data-ip="${esc(target)}" data-port="${r.port}" title="이 포트로 새 세션 만들기">${r.port}</button>`
                : r.port
            }</td>
              <td>${r.open ? icon("Check", 13) : icon("X", 13)} ${esc(r.open ? "열려 있음" : r.detail)}</td><td class="muted">${r.ms != null ? `${r.ms} ms` : ""}</td>${
                named ? `<td class="muted mono" data-i18n-skip>${WELL_KNOWN_PORTS[r.port] ?? ""}</td>` : ""
              }</tr>`,
          )
          .join("")}</tbody></table>`;
        // Many ports (a range): sorted by state or round trip with a click.
        const portTable = out.querySelector<HTMLTableElement>("table.nettools-table");
        if (portTable) sortableTable(portTable);
      } else {
        const res = await api.netDns(target);
        out.innerHTML = res.addresses.length
          ? `<ul class="nettools-list">${res.addresses.map((a) => `<li class="mono">${esc(a)}</li>`).join("")}</ul><p class="muted small">${res.ms} ms</p>`
          : `<p class="muted">주소가 없습니다.</p>`;
      }
    } catch (err) {
      const msg = errorText(err);
      out.innerHTML = msg === "CANCELLED" ? `<p class="muted">중지했습니다.</p>` : `<p class="danger-text">${esc(msg)}</p>`;
    } finally {
      busy = false;
      pingId = null;
      run.innerHTML = label;
      run.disabled = false;
      // Offer "copy result" only when there is an actual result, not a spinner,
      // an error or the "cancelled" note.
      copyBtn.hidden = !out.querySelector("pre, table.nettools-table, ul.nettools-list");
    }
  });
  // The prefix read next to the address in terminal output, not /24.
  if (initialPrefix !== null) ownPrefix = String(initialPrefix);
  if (continuous && initialTool === "ping") cont.checked = true;
  setTool(initialTool);
  if (startNow && initialHost.trim()) form.requestSubmit();
}
