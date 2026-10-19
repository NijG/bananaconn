import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { api, isTauri, revealInExplorer } from "./api";
import { fileServerBadges, fileServers, initFileServers, openFileServer } from "./fileServers";
import { ftpServer, ftpServerBadge, initFtpServer, openFtpServer } from "./ftpServer";
import { mountHome } from "./home";
import { appLock, initLock, lockNow } from "./lock";
import { openNetworkTools } from "./nettools";
import { GatewayLink, openTunnelManager } from "./tunnels";
import { icon } from "./icons";
import { endpoint, newSession, parseTarget, PROTOCOLS, type Protocol, type Session } from "./model";
import { editSession } from "./sessionEditor";
import { openSettings } from "./settings";
import { Sidebar } from "./sidebar";
import { loadAll, savesSettled, state, subscribe, touchSession } from "./store";
import { isLanguage, LANGUAGES, setLanguage, type Language } from "./i18n";
import { confirmDialog, contextMenu, errorText, esc, toast } from "./ui";
import { openVault } from "./vault";

import { Workspace, type Layout, type MonitorInfo, type View } from "./workspace";
import { checkForUpdate, installUpdate, loadVersion, onUpdateChange, startAutoUpdate, updateBadge } from "./updates";
import { ACTIONS, actionFor } from "./keymap";
// Loaded on first use: noVNC probes the video decoder when imported, and
// help, the editor and the importers are big; none of it is needed at startup.
const openHelp = (section?: string) =>
  import("./help").then(
    (m) => m.openHelp(section),
    (err) => toast(errorText(err), "error"),
  );

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---- static icons ----------------------------------------------------------------
$("#btn-sidebar").innerHTML = icon("PanelLeft", 18);
$(".quick-go").innerHTML = icon("CornerDownLeft", 16);
$("#btn-vault").innerHTML = icon("KeyRound", 18);
$("#btn-server").innerHTML = icon("Server", 18);
$("#btn-tools").innerHTML = icon("Network", 18);
$("#btn-lock").innerHTML = icon("LockKeyhole", 18);
$("#btn-settings").innerHTML = icon("Settings", 18);
$("#btn-help").innerHTML = icon("CircleHelp", 18);
$("#btn-help").addEventListener("click", () => openHelp());
$("#btn-broadcast").innerHTML = `${icon("Radio", 16)}<span>동시 입력</span>`;
const LAYOUT_ICONS: Record<Layout, string> = { single: "Square", cols: "Columns2", rows: "Rows2", grid: "LayoutGrid" };
document.querySelectorAll<HTMLElement>("[data-layout]").forEach((b) => {
  b.innerHTML = icon(LAYOUT_ICONS[b.dataset.layout as Layout], 16);
});

// ---- workspace -------------------------------------------------------------------
const ws = new Workspace($("#tabbar"), $("#slots"), $("#home"));
ws.duplicateHandler = (s) => open(s);

// Views load on first use, so xterm.js and the file/RDP views stay out of the
// start-up bundle; they are fetched in the background once the app is idle.
const loadTerminal = () => import("./views/terminal");
const loadFiles = () => import("./views/files");
const loadRdp = () => import("./views/rdp");
const idle = window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1500));
idle(() => void Promise.all([loadTerminal(), loadFiles(), loadRdp()]).catch(() => {}), { timeout: 4000 });

/** Tabs are added in the order they were asked for, whichever view loads first. */
let opening: Promise<unknown> = Promise.resolve();
function addWhenLoaded(make: () => Promise<void>) {
  opening = opening.then(make).catch((err) => toast(errorText(err), "error"));
}

/** SFTP file browser for an SSH session; next to its terminal when `beside` is given. */
function openFiles(s: Session, beside?: View) {
  const files: Session = { ...s, id: `quick-${crypto.randomUUID()}`, protocol: "sftp", name: `${s.name || s.host} · 파일`, options: {} };
  if (!beside) return open(files);
  addWhenLoaded(async () => {
    const { FilesView } = await loadFiles();
    ws.addBeside(files, new FilesView(files, ws), beside);
  });
}

/** Gateway tunnels of RDP sessions opened in mstsc, reused per session. */
const externalLinks = new Map<string, { key: string; link: GatewayLink }>();

async function launchRdp(s: Session) {
  const o = s.options;
  const [w, h] = String(o.resolution ?? "").split("x").map(Number);
  try {
    // mstsc connects to the gateway tunnel's local end; one tunnel per session
    // stays open while the app runs (mstsc reconnects on its own).
    // Rebuilt whenever the target or the gateway changed since it was made.
    const gw = state.sessions.find((x) => x.id === s.options.gateway);
    const key = JSON.stringify([s.host, s.port, s.options.gateway ?? null, gw?.host, gw?.port, gw?.username, gw?.credentialId]);
    let entry = externalLinks.get(s.id);
    if (entry?.key !== key) {
      entry?.link.close();
      entry = { key, link: new GatewayLink(s, 3389) };
      externalLinks.set(s.id, entry);
    }
    const tunnelPort = await entry.link.port();
    if (tunnelPort === null) return;
    await api.rdpLaunch({
      name: s.name || s.host,
      host: tunnelPort ? "127.0.0.1" : s.host,
      port: tunnelPort ?? s.port,
      username: s.username,
      credentialId: s.credentialId,
      fullscreen: !!o.fullscreen,
      width: w || null,
      height: h || null,
      multimon: !!o.multimon,
      clipboard: o.clipboard !== false,
      drives: !!o.drives,
    });
    toast(`원격 데스크톱 창에서 ${endpoint(s)} 에 연결합니다`, "success");
  } catch (err) {
    toast(errorText(err), "error");
  }
}

function open(s: Session) {
  if (!s.host) return toast("호스트가 비어 있습니다", "warn");
  if (!s.id.startsWith("quick-")) touchSession(s.id);
  const kind = PROTOCOLS[s.protocol].view;
  if (kind === "rdp" && s.options.openMode === "external") return void launchRdp(s);
  addWhenLoaded(async () => {
    let view: View;
    if (kind === "terminal") view = new (await loadTerminal()).TerminalView(s, ws, openFiles);
    else if (kind === "files") view = new (await loadFiles()).FilesView(s, ws);
    else if (kind === "tftp") view = new (await import("./views/tftp")).TftpView(s, ws);
    else if (kind === "vnc") view = new (await import("./views/vnc")).VncView(s, ws);
    else view = new (await loadRdp()).RdpView(s, ws, launchRdp);
    ws.add(s, view);
  });
}

async function edit(existing: Session | null, defaults: Partial<Session> = {}) {
  const res = await editSession(existing, defaults);
  if (res?.connect) open(res.session);
}

// ---- sidebar & home ----------------------------------------------------------------
const sidebar = new Sidebar($("#sidebar"), { connect: open, edit, openFiles });
mountHome($("#home"), {
  create: (p: Protocol) => edit(null, { protocol: p }),
  connect: open,
  vault: () => openVault(),
});

const app = $("#app");
const savedWidth = Number(localStorage.getItem("bx.sidebarWidth")) || 272;
app.style.setProperty("--sidebar-w", `${savedWidth}px`);
if (localStorage.getItem("bx.sidebarHidden") === "1") app.classList.add("sidebar-hidden");

function toggleSidebar() {
  app.classList.toggle("sidebar-hidden");
  localStorage.setItem("bx.sidebarHidden", app.classList.contains("sidebar-hidden") ? "1" : "0");
}
$("#btn-sidebar").addEventListener("click", toggleSidebar);

$("#resizer").addEventListener("pointerdown", (e) => {
  const resizer = e.currentTarget as HTMLElement;
  resizer.setPointerCapture(e.pointerId);
  app.classList.add("resizing");
  const move = (ev: PointerEvent) => {
    const w = Math.max(200, Math.min(520, ev.clientX));
    app.style.setProperty("--sidebar-w", `${w}px`);
  };
  const up = () => {
    app.classList.remove("resizing");
    resizer.removeEventListener("pointermove", move);
    resizer.removeEventListener("pointerup", up);
    localStorage.setItem("bx.sidebarWidth", app.style.getPropertyValue("--sidebar-w").replace("px", ""));
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("pointerup", up);
});

// ---- top bar -------------------------------------------------------------------------
const quickProto = $<HTMLSelectElement>("#quick-proto");
const quickTarget = $<HTMLInputElement>("#quick-target");
quickProto.value = localStorage.getItem("bx.quickProto") ?? "ssh";

// Recent quick-connect targets per protocol, offered as suggestions.
const quickList = document.createElement("datalist");
quickList.id = "quick-history";
document.body.appendChild(quickList);
quickTarget.setAttribute("list", "quick-history");
const quickHistory = (): Record<string, string[]> => {
  try {
    return JSON.parse(localStorage.getItem("bx.quickHistory") ?? "{}");
  } catch {
    return {};
  }
};
function renderQuickHistory() {
  quickList.innerHTML = (quickHistory()[quickProto.value] ?? []).map((t) => `<option value="${esc(t)}">`).join("");
}
function rememberQuick(proto: string, target: string) {
  const all = quickHistory();
  all[proto] = [target, ...(all[proto] ?? []).filter((t) => t !== target)].slice(0, 12);
  localStorage.setItem("bx.quickHistory", JSON.stringify(all));
  renderQuickHistory();
}
renderQuickHistory();
const quickPlaceholder = () =>
  (quickTarget.placeholder = quickProto.value === "serial" ? "빠른 연결  ·  COM3 또는 COM3:115200" : "빠른 연결  ·  user@host:port");
quickPlaceholder();
quickProto.addEventListener("change", () => {
  quickPlaceholder();
  localStorage.setItem("bx.quickProto", quickProto.value);
  renderQuickHistory();
});
/** Quick serial: "COM3" or "COM3:115200" (the number after the colon is the speed). */
function openQuickSerial(text: string) {
  const m = text.trim().match(/^(COM\d{1,3})(?::(\d{3,7}))?$/i);
  if (!m) return toast("형식: COM3 또는 COM3:115200", "warn");
  const s: Session = {
    ...newSession("serial"),
    id: `quick-${crypto.randomUUID()}`,
    host: m[1].toUpperCase(),
    port: null,
    options: { baud: m[2] ? Number(m[2]) : 9600, keyMode: "network" },
  };
  s.name = s.host;
  open(s);
  rememberQuick("serial", text.trim());
  quickTarget.value = "";
}

$("#quick").addEventListener("submit", (e) => {
  e.preventDefault();
  const protocol = quickProto.value as Protocol;
  if (protocol === "serial") return void openQuickSerial(quickTarget.value);
  const target = parseTarget(quickTarget.value);
  if (!target) return toast("형식: user@host:port (예: root@192.168.0.10:22)", "warn");
  const s: Session = {
    ...newSession(protocol),
    id: `quick-${crypto.randomUUID()}`,
    host: target.host,
    port: target.port ?? PROTOCOLS[protocol].port,
    username: target.username,
  };
  s.name = endpoint(s);
  open(s);
  rememberQuick(protocol, quickTarget.value.trim());
  quickTarget.value = "";
});

document.querySelectorAll<HTMLElement>("[data-layout]").forEach((b) =>
  b.addEventListener("click", () => ws.setLayout(b.dataset.layout as Layout)),
);
$("#btn-broadcast").addEventListener("click", () => {
  ws.toggleBroadcast();
  const n = ws.broadcastTargets().length;
  toast(
    !ws.broadcast
      ? "동시 입력을 껐습니다"
      : n > 1
        ? `동시 입력을 켰습니다. 연결된 터미널 ${n}개 모두에 같은 입력이 전달됩니다(탭에 표시).`
        : "동시 입력을 켰습니다. 지금은 연결된 터미널이 하나라서 전달할 곳이 없습니다. 터미널을 더 열면 함께 입력됩니다.",
    ws.broadcast ? "warn" : "info",
    5000,
  );
});
$("#btn-vault").addEventListener("click", () => openVault());
$("#btn-server").addEventListener("click", (e) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const on = (k: "tftp" | "http") => (fileServers.status(k) ? "실행 중" : "");
  contextMenu(r.left, r.bottom + 4, [
    { label: "FTP 서버", icon: "Server", hint: ftpServer.status ? "실행 중" : "", action: () => openFtpServer() },
    { label: "TFTP 서버", icon: "Upload", hint: on("tftp") || "네트워크 장비용", action: () => openFileServer("tftp") },
    { label: "HTTP 서버", icon: "Globe", hint: on("http") || "브라우저로 내려받기", action: () => openFileServer("http") },
  ]);
});
$("#btn-lock").addEventListener("click", () => lockNow());
appLock.onChange(() => ($("#btn-lock").hidden = !appLock.enabled));
$("#btn-tools").addEventListener("click", (e) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  contextMenu(r.left, r.bottom + 4, [
    { label: "SSH 터널", icon: "Waypoints", hint: "포트 포워딩", action: () => openTunnelManager() },
    { label: "네트워크 도구", icon: "Activity", hint: "ping · 포트 · DNS", action: () => openNetworkTools() },
  ]);
});
$("#btn-settings").addEventListener("click", () => openSettings());

// ---- status bar ----------------------------------------------------------------------
const STATE_TEXT = { connecting: "연결 중", connected: "연결됨", closed: "종료됨", error: "오류" };
function renderStatus() {
  const bar = $("#statusbar");
  document.querySelectorAll<HTMLElement>("[data-layout]").forEach((b) => b.classList.toggle("on", b.dataset.layout === ws.layout));
  $("#btn-broadcast").classList.toggle("on", ws.broadcast);
  const tab = ws.activeTab;
  $("#btn-server").classList.toggle("live", !!ftpServer.status || !!fileServers.status("tftp") || !!fileServers.status("http"));
  const right = `${ftpServerBadge()}${fileServerBadges()}${ws.broadcast ? `<span class="sb-warn">${icon("Radio", 13)}동시 입력 켜짐</span>` : ""}
    <span>탭 ${ws.tabs.length}개</span>${updateBadge()}`;
  if (!tab) {
    setStatus(bar, `<div class="sb-left"><span class="sb-dot idle"></span><span>준비됨 · 저장된 세션 ${state.sessions.length}개</span></div><div class="sb-right">${right}</div>`);
    return;
  }
  const st = tab.view.status();
  const p = PROTOCOLS[st.protocol];
  setStatus(bar, `<div class="sb-left">
      <span class="sb-dot ${st.state}"></span>
      <b style="color:${p.color}">${p.label}</b><span>${esc(st.endpoint)}</span>
      <span class="muted">${STATE_TEXT[st.state]}</span>
      ${st.detail ? `<span class="muted">${esc(st.detail)}</span>` : ""}
      ${st.logPath ? `<button class="sb-log" title="${esc(st.logPath)}">${icon("ScrollText", 13)}로그 기록 중</button>` : ""}
      ${st.device ? `<span class="sb-device" title="자동으로 인식한 장비">${icon("Server", 13)}${esc(st.device)}</span>` : ""}
      ${monitorChip(st.monitor)}
    </div><div class="sb-right">${right}</div>`);
}

/** Replace the status bar only when its content changed: it is asked to
 * redraw on every monitor sample, and replacing the buttons under the mouse
 * would swallow clicks and make tooltips flicker. */
let statusHtml = "";
function setStatus(bar: HTMLElement, html: string) {
  if (html === statusHtml) return;
  statusHtml = html;
  bar.innerHTML = html;
}
// One listener for the buttons in the status bar (they are re-created).
$("#statusbar").addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const tab = ws.activeTab;
  if (target.closest(".sb-log")) {
    const path = tab?.view.status().logPath;
    if (path) revealInExplorer(path);
  } else if (target.closest("[data-monitor]")) tab?.view.monitorAction?.();
  else if (target.closest("[data-update]")) installUpdate(ws.tabs.filter((t) => t.view.state === "connected").length);
});
subscribe("sessions", () => !ws.activeTab && renderStatus());
onUpdateChange(renderStatus);
loadVersion();
// Screen language: the user's pick wins; until they pick, the Windows display language
// (remembered from the last start, so the first paint needs no backend call).
let osLanguage: Language = readOsLanguage();
const applyLanguage = () => setLanguage(state.settings.uiLanguage ?? osLanguage);
applyLanguage();
subscribe("settings", applyLanguage);
api
  .osUiLanguage()
  .then((lang) => {
    if (!isLanguage(lang)) return;
    osLanguage = lang;
    try {
      localStorage.setItem("bx.osLanguage", lang);
    } catch {}
    applyLanguage();
  })
  .catch(() => {});
function readOsLanguage(): Language {
  try {
    const saved = localStorage.getItem("bx.osLanguage");
    if (isLanguage(saved)) return saved;
  } catch {}
  // Before the backend answers on the very first start: the WebView's language.
  const nav = navigator.language;
  const exact = LANGUAGES.find(([code]) => code.toLowerCase() === nav.toLowerCase());
  if (exact) return exact[0];
  if (/^zh-(hant|tw|hk|mo)/i.test(nav)) return "zh-TW";
  if (/^zh/i.test(nav)) return "zh-CN";
  const base = LANGUAGES.find(([code]) => code === nav.slice(0, 2).toLowerCase());
  return base ? base[0] : "en";
}
startAutoUpdate(() => ws.tabs.filter((t) => t.view.state === "connected").length);

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1);
const level = (pct: number) => (pct >= 90 ? "hot" : pct >= 70 ? "warm" : "ok");
const meter = (pct: number) => `<span class="sb-meter ${level(pct)}"><i style="width:${Math.max(2, Math.min(100, pct)).toFixed(0)}%"></i></span>`;

/** Remote CPU / memory of the active SSH tab. */
function monitorChip(m: MonitorInfo | null | undefined): string {
  if (!m) return "";
  if (m.kind === "stats") {
    const mem = m.memTotal ? (m.memUsed / m.memTotal) * 100 : m.memPercent ?? 0;
    const disk = m.diskTotal ? ((m.diskUsed ?? 0) / m.diskTotal) * 100 : 0;
    const cpu = m.warmup ? "…" : `${m.cpu.toFixed(0)}%`;
    return `<button class="sb-monitor stats" data-monitor title="원격 서버 리소스 (주기적으로 갱신) · 클릭하면 CPU·메모리 상위 프로세스와 디스크를 봅니다">
        <span>CPU</span>${meter(m.warmup ? 0 : m.cpu)}<b>${cpu}</b>
        ${m.memTotal ? `<span>메모리</span>${meter(mem)}<b>${gb(m.memUsed)}/${gb(m.memTotal)} GB</b>` : m.memPercent !== undefined ? `<span>메모리</span>${meter(mem)}<b>${mem.toFixed(0)}%</b>` : ""}
        ${m.diskTotal ? `<span>디스크</span>${meter(disk)}<b>${disk.toFixed(0)}%</b>` : ""}</button>`;
  }
  const text: Record<string, string> = {
    starting: "리소스 확인 중…",
    login: `리소스 보기: 클릭해 로그인${m.message ? ` (${m.message})` : ""}`,
    hostkey: "리소스 보기: 호스트 키 확인 필요",
    unsupported: `리소스 표시 안 함${m.message ? ` (${m.message})` : ""}`,
    error: `리소스 표시 오류: ${m.message ?? ""} · 클릭해 다시 시도`,
  };
  const clickable = m.kind === "login" || m.kind === "hostkey" || m.kind === "error";
  return clickable
    ? `<button class="sb-monitor action" data-monitor>${icon("Activity", 13)}${esc(text[m.kind])}</button>`
    : `<span class="sb-monitor muted">${icon("Activity", 13)}${esc(text[m.kind])}</span>`;
}
ws.duplicateHandler = (s) => open(s);
ws.onChange(renderStatus);
ftpServer.onChange(renderStatus);
fileServers.onChange(renderStatus);
$("#statusbar").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("[data-ftp-server]")) openFtpServer();
  const kind = t.closest<HTMLElement>("[data-file-server]")?.dataset.fileServer;
  if (kind === "tftp" || kind === "http") openFileServer(kind);
});

// ---- keyboard shortcuts (keymap.ts; the user can change them) ----------------------
/** What each app-wide action does; false: not applicable now (the key goes on). */
const GLOBAL_ACTIONS: Record<string, () => void | boolean> = {
  "app.help": () => void openHelp(),
  "app.newSession": () => void edit(null),
  "app.quickConnect": () => quickTarget.focus(),
  "app.toggleSidebar": () => toggleSidebar(),
  "app.searchSessions": () => (ws.activeTab ? false : sidebar.focusSearch()),
  "app.settings": () => void openSettings(),
  "app.shortcuts": () => void import("./shortcuts").then((m) => m.openShortcuts()),
  "app.vault": () => void openVault(),
  "app.tunnels": () => openTunnelManager(),
  "app.netTools": () => openNetworkTools(),
  "app.lock": () => (appLock.enabled ? void lockNow() : false),
  "app.checkUpdate": () => void checkForUpdate(true),
  "tab.next": () => ws.cycle(1),
  "tab.prev": () => ws.cycle(-1),
  "tab.close": () => {
    const t = ws.activeTab;
    if (t) ws.close(t.id);
  },
  "tab.closeOthers": () => {
    const t = ws.activeTab;
    if (t) void ws.closeOthers(t.id);
  },
  "tab.duplicate": () => {
    const t = ws.activeTab;
    if (t) ws.duplicateHandler?.(t.session);
  },
  "tab.reconnect": () => {
    const v = ws.activeTab?.view;
    if (!v?.reconnect) return false;
    v.reconnect();
  },
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [
      `tab.go${i + 1}`,
      () => {
        const t = ws.tabs[i];
        if (t) ws.activate(t.id);
      },
    ]),
  ),
  "pane.next": () => ws.focusSlot((ws.focused + 1) % ws.slots.length),
  "layout.single": () => ws.setLayout("single"),
  "layout.cols": () => ws.setLayout("cols"),
  "layout.rows": () => ws.setLayout("rows"),
  "layout.grid": () => ws.setLayout("grid"),
  "broadcast.toggle": () => $("#btn-broadcast").click(),
};
window.addEventListener("keydown", (e) => {
  if (document.querySelector(".modal-backdrop") || appLock.locked) return;
  const id = actionFor(e, "global");
  const run = id && GLOBAL_ACTIONS[id];
  if (!run) return;
  // Some keys belong to the program in a terminal (F1 for htop, Ctrl+F for less).
  const inTerminal = !!(e.target as Element | null)?.closest?.(".xterm");
  if (inTerminal && ACTIONS.find((a) => a.id === id)?.terminalKeeps) return;
  if (run() === false) return;
  e.preventDefault();
});
// Block the browser's own context menu outside places that provide one.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea")) e.preventDefault();
});

// ---- window controls (the native title bar is replaced by the top bar) ---------------
if (isTauri) {
  import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
    const win = getCurrentWindow();
    const box = $(".win-controls");
    box.hidden = false;
    const maxBtn = box.querySelector<HTMLElement>('[data-win="max"]')!;
    box.querySelector<HTMLElement>('[data-win="min"]')!.innerHTML = icon("Minus", 16);
    box.querySelector<HTMLElement>('[data-win="close"]')!.innerHTML = icon("X", 17);
    const syncMax = async () => {
      const maximized = await win.isMaximized();
      maxBtn.innerHTML = icon(maximized ? "Copy" : "Square", maximized ? 14 : 13);
      maxBtn.title = maximized ? "이전 크기로" : "최대화";
      app.classList.toggle("maximized", maximized);
    };
    box.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-win]")?.dataset.win;
      if (act === "min") win.minimize();
      if (act === "max") win.toggleMaximize();
      if (act === "close") win.close(); // goes through onCloseRequested below
    });
    await syncMax();
    win.onResized(() => syncMax());
  });
}

// ---- quitting with live connections ----------------------------------------------------
if (isTauri) {
  import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    const win = getCurrentWindow();
    win.onCloseRequested(async (event) => {
      // Tauri closes the window after this handler: an edit made just before
      // must reach the disk first.
      await savesSettled();
      const live = ws.tabs.filter((t) => t.view.state === "connected" || t.view.state === "connecting");
      // Unsaved work is always asked about; open connections only if the user wants that.
      const work = ws.tabs.flatMap((t) => {
        const w = t.view.closeWarning?.();
        return w ? [`<li><b>${esc(t.view.title())}</b>: ${esc(w)}</li>`] : [];
      });
      if (!work.length && (!live.length || !state.settings.confirmClose)) return;
      event.preventDefault();
      const ok = await confirmDialog({
        title: "BananaConn 종료",
        message: `${work.length ? `저장하지 않았거나 끝나지 않은 작업이 사라집니다.<ul class="clash-list">${work.slice(0, 6).join("")}</ul>` : ""}${
          live.length
            ? `열려 있는 연결 ${live.length}개가 모두 끊어집니다.<br><span class="muted">${live
                .slice(0, 5)
                .map((t) => esc(t.view.title()))
                .join(", ")}${live.length > 5 ? " 외" : ""}</span>`
            : ""
        }`,
        confirm: "종료",
        danger: true,
      });
      if (ok) {
        for (const t of [...ws.tabs]) t.view.dispose();
        await win.destroy();
      }
    });
  });
}

// ---- start -------------------------------------------------------------------------
initLock().catch((err) => toast(`잠금 상태를 확인할 수 없습니다: ${errorText(err)}`, "error"));
loadAll()
  .then(renderStatus)
  .catch((err) => toast(`세션 목록을 불러오지 못했습니다: ${errorText(err)}`, "error"));
initFtpServer().catch((err) => console.warn("ftp server status", err));
initFileServers().catch((err) => console.warn("file server status", err));
renderStatus();
