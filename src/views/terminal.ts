// Terminal view for SSH and Telnet sessions.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { api, on, openExternal, pickOpenFile, pickSavePath, revealInExplorer } from "../api";
import type { PasteEvent } from "../api";
import { readClipboard, writeClipboard } from "../clipboard";
import { icon } from "../icons";
import { endpoint, PROTOCOLS, serialSettings, type Session } from "../model";
import { addMacro, snippetMenu } from "../snippets";
import { findRisks } from "../riskRules";
import { patchSession, state, subscribe, updateSettings, type Snippet } from "../store";
import { termTheme } from "../themes";
import { KeywordHighlighter } from "../highlight";
import { deviceCommands, deviceTitle, type DeviceInfo } from "../deviceCommands";
import { backendLogOptions, LOG_TOKENS, logConfig, previewPath, type LogConfig } from "../logOptions";
import { GatewayLink } from "../tunnels";
import { tr } from "../i18n";
import { actionFor, appTakesInTerminal, SNIPPET_PREFIX } from "../keymap";

/** Editing keys in recorded macros, as private-use marks U+E100.. in this
 * order; each tab turns them into its own key mode's bytes. */
const MARKED_KEYS: EditKey[] = ["Delete", "Home", "End", "Backspace"];

import { confirmDialog, contextMenu, errorText, esc, h, modal, promptDialog, timestamp, toast } from "../ui";
import type { BroadcastInput, EditKey, MonitorInfo, StatusInfo, Tab, View, ViewState, Workspace } from "../workspace";



/** Asked once per app run. */
let build: Promise<number> | null = null;
const windowsBuild = () => (build ??= api.windowsBuild().catch(() => 0));

// Monitor events go to the views sharing that monitor.
let routed = false;
function ensureRouting() {
  if (routed) return;
  routed = true;


  on<MonitorEvent>("monitor-stats", (e) => {
    const m = monitorsById.get(e.id);
    if (!m) return;
    // A monitor that (re)started its sampling loop after the pause was set
    // (login just finished, device CLI fallback) is told again.
    if (m.paused && e.stats) api.monitorPause(m.id, true).catch(() => {});
    if (e.device) {
      m.device = e.device;
      m.views.forEach((v) => v.deviceDetected(e.device!));
    }
    setMonitorInfo(m, nextMonitorInfo(m.info, e));
  });
  on<PasteEvent>("term-paste", (e) => allViews.forEach((v) => v.pasteProgress(e)));
}

// ---- shared resource monitors ----------------------------------------------------------

type MonitorEvent = {
  id: string;
  /** What the monitor recognised (once, after logging in). */
  device?: DeviceInfo;
  stats?: { cpu: number; memUsed: number; memTotal: number; memPercent?: number; diskUsed?: number; diskTotal?: number };
  warmup?: boolean;
  unsupported?: boolean;
  closed?: boolean;
  error?: string;
};

/** One monitor connection per server (protocol, host, port, user). Tabs to the
 * same server share it, so ten tabs cost the device one extra login instead of
 * ten — network gear often allows only a handful of VTY sessions. */
interface SharedMonitor {
  id: string;
  key: string;
  info: MonitorInfo | null;
  views: Set<TerminalView>;
  /** Username typed at the monitor's login prompt (Telnet devices). */
  user: string;
  device?: DeviceInfo;
  /** No tab of this device on screen: sampling paused. */
  paused?: boolean;
}

/** Pause the monitor while none of its tabs is on screen, resume when one is. */
function syncPause(m: SharedMonitor) {
  const paused = ![...m.views].some((v) => v.onScreen);
  if (m.paused === paused) return;
  m.paused = paused;
  api.monitorPause(m.id, paused).catch(() => {});
}

/** A real graphics card (not a software rasteriser such as SwiftShader or
 * WARP, which is what servers and remote sessions without a GPU get). */
let gpu: boolean | null = null;
function realGpu(): boolean {
  if (gpu !== null) return gpu;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const name = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    gpu = !!name && !/swiftshader|basic render|llvmpipe|software|warp/i.test(name);
  } catch {
    gpu = false;
  }
  return gpu;
}
/** WebGL failed once (no context): DOM from then on. */
let webglFailed = false;
const monitors = new Map<string, SharedMonitor>();
const monitorsById = new Map<string, SharedMonitor>();

function setMonitorInfo(m: SharedMonitor, info: MonitorInfo | null) {
  m.info = info;
  // Only a tab on screen shows the monitor (status bar of the active tab), and
  // all tabs live in one workspace, so one redraw covers them; samples for
  // tabs in the background cost nothing.
  [...m.views].find((v) => v.shown())?.monitorChanged();
}

function failedMonitor(msg: string): MonitorInfo {
  return msg === "NEED_PASSWORD" || msg === "NEED_USERNAME" || /인증에 실패/.test(msg)
    ? { kind: "login", message: /인증에 실패/.test(msg) ? "비밀번호가 올바르지 않습니다" : "", needUser: msg === "NEED_USERNAME" }
    : msg.startsWith("HOSTKEY_UNKNOWN::")
      ? { kind: "hostkey", fingerprint: msg.slice("HOSTKEY_UNKNOWN::".length) }
      : { kind: "error", message: msg.startsWith("HOSTKEY_MISMATCH::") ? "호스트 키가 바뀌었습니다" : msg };
}

function nextMonitorInfo(prev: MonitorInfo | null, e: MonitorEvent): MonitorInfo | null {
  if (e.error) return failedMonitor(e.error);
  if (e.stats) return { kind: "stats", ...e.stats, warmup: !!e.warmup };
  if (e.unsupported) return { kind: "unsupported", message: "지원하지 않는 장비입니다" };
  if (e.closed && prev?.kind === "stats") return { kind: "error", message: "모니터링 연결이 끊어졌습니다" };
  return prev;
}

/** The server's busiest processes (and file systems), read over the monitor connection. */
function showTopProcesses(id: string, title: string) {
  const m = modal({
    title: `${title} · 상위 프로세스`,
    icon: "Activity",
    width: 900,
    body: `<div class="top-view"></div>`,
    footer: `<button class="btn" data-refresh>${icon("RefreshCw", 14)}새로 고침</button><button class="btn btn-primary" data-close>닫기</button>`,
  });
  const view = m.root.querySelector<HTMLElement>(".top-view")!;
  const header = (line: string) => /^\s*PID\b/.test(line) || /^Filesystem\b/.test(line) || line.startsWith("CPU utilization");
  const load = async () => {
    view.innerHTML = `<p class="muted">서버에서 읽는 중…</p>`;
    try {
      const sections = await api.monitorTop(id);
      view.innerHTML = sections
        .map((s) => `<section><h3>${esc(s.title)}</h3><pre>${s.lines.map((l) => (header(l) ? `<b>${esc(l)}</b>` : esc(l))).join("\n")}</pre></section>`)
        .join("");
    } catch (err) {
      view.innerHTML = `<p class="top-error">${esc(errorText(err))}</p>`;
    }
  };
  m.root.querySelector("[data-refresh]")!.addEventListener("click", load);
  load();
}

const allViews = new Set<TerminalView>();
subscribe("settings", () => allViews.forEach((v) => v.applySettings()));

/** Terminal shortcut -> the toolbar button it presses. */
const TOOLBAR_KEYS: Record<string, string> = {
  "term.clear": "clear",
  "term.log": "log",
  "term.save": "save",
  "term.zoomIn": "zoomin",
  "term.zoomOut": "zoomout",
  "term.sftp": "sftp",
  "term.snippets": "snippet",
  "term.record": "record",
  "term.break": "break",
};

export class TerminalView implements View {
  el: HTMLElement;
  state: ViewState = "connecting";
  private term: Terminal;
  private fit = new FitAddon();
  private search = new SearchAddon();
  private runtimeId = "";
  private logPath: string | null = null;
  private host: HTMLElement;
  private overlay: HTMLElement;
  private findBar: HTMLElement;
  private resizeTimer = 0;
  private gotOutput = false;
  private disposed = false;
  /** onData in the current event turn comes from the user (key, IME), not from
   * xterm answering a terminal query, focus or mouse report. */
  private userTurn = false;
  private pasting = false;
  /** Logging was on before a reconnect: turn it back on. */
  private relog = false;
  /** The log settings last started with (a reconnect continues with them). */
  private logUsed: LogConfig | null = null;
  private highlighter = new KeywordHighlighter();
  /** The automatic SFTP panel was opened once for this tab. */
  private filesOpened = false;
  /** Keystrokes captured while a macro is being recorded. */
  private recording: string[] | null = null;

  /** Telnet only: tunnel through the session's SSH gateway, if it has one. */
  private gateway: GatewayLink;

  constructor(
    private session: Session,
    private ws: Workspace,
    private openFiles: (s: Session, beside?: View) => void,
  ) {
    this.gateway = new GatewayLink(session, 23);
    ensureRouting();
    allViews.add(this);
    const p = PROTOCOLS[session.protocol];
    this.el = h(
      "div",
      { class: "view term-view" },
      `<div class="view-bar">
         <span class="proto-chip" style="--proto:${p.color}">${icon(p.icon, 14)}${p.label}</span>
         <span class="view-endpoint">${esc(endpoint(session))}</span>
         <span class="view-state" data-state></span>
         <div class="view-actions">
           <button class="tool" data-act="find" title="찾기 (Ctrl+Shift+F)">${icon("Search", 15)}</button>
           <button class="tool" data-act="log" title="로그 기록 켜기/끄기">${icon("ScrollText", 15)}<span>로그</span></button>
           <button class="tool" data-act="save" title="출력 내용을 파일로 저장">${icon("Save", 15)}</button>
           <button class="tool" data-act="clear" title="화면 지우기">${icon("Eraser", 15)}</button>
           <span class="tool-sep"></span>
           <button class="tool" data-act="zoomout" title="글자 작게">${icon("ZoomOut", 15)}</button>
           <button class="tool" data-act="zoomin" title="글자 크게">${icon("ZoomIn", 15)}</button>
           ${session.protocol === "ssh" ? `<span class="tool-sep"></span><button class="tool" data-act="sftp" title="같은 서버의 파일 브라우저 열기">${icon("FolderLock", 15)}<span>SFTP</span></button>` : ""}
           <button class="tool" data-act="snippet" title="명령 스니펫·매크로 보내기">${icon("ClipboardType", 15)}<span>스니펫</span></button>
           <button class="tool device-tool" data-act="device" title="자동으로 인식한 장비: 자주 쓰는 명령, 설정 백업, 상위 프로세스" hidden>${icon("Server", 15)}<span data-device-label></span></button>
           <button class="tool" data-act="keys" title="Delete·Home·End 키를 보내는 방식 (네트워크 장비는 Ctrl-D·Ctrl-A·Ctrl-E)">${icon("Keyboard", 15)}<span data-keys-label></span></button>
           <button class="tool" data-act="sendfile" title="텍스트 파일 보내기 (설정 파일을 붙여넣듯이)">${icon("FileText", 15)}</button>
           ${session.protocol === "serial" ? `<button class="tool" data-act="break" title="Break 신호 보내기 (장비 ROMMON 진입 등)">${icon("Zap", 15)}<span>Break</span></button>` : ""}
           <button class="tool" data-act="record" title="매크로 기록 시작/끝">${icon("Circle", 15)}<span>기록</span></button>
           <button class="tool" data-act="reconnect" title="다시 연결">${icon("RotateCw", 15)}</button>
         </div>
       </div>
       <div class="find-bar" hidden>
         ${icon("Search", 14)}
         <input placeholder="터미널에서 찾기" spellcheck="false" />
         <button class="tool" data-find="prev" title="이전">${icon("ArrowUp", 14)}</button>
         <button class="tool" data-find="next" title="다음">${icon("ArrowUp", 14, "flip")}</button>
         <button class="tool" data-find="close" title="닫기">${icon("X", 14)}</button>
       </div>
       <div class="term-host"></div>
       <div class="view-overlay" hidden></div>`,
    );
    this.host = this.el.querySelector(".term-host")!;
    this.overlay = this.el.querySelector(".view-overlay")!;
    this.findBar = this.el.querySelector(".find-bar")!;

    const s = state.settings;
    this.term = new Terminal({
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      cursorStyle: s.cursorStyle,
      // Set per renderer (syncBlink).
      cursorBlink: false,
      scrollback: s.scrollback,
      allowProposedApi: true,
      theme: termTheme(s.terminalTheme),
      lineHeight: 1.15,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon((_e, uri) => openExternal(uri)));
    this.term.open(this.host);
    this.applyThemeBackground();
    this.wireBlink();
    // SSH runs ssh.exe inside ConPTY, which rewraps lines itself on resize:
    // xterm must know, or resized lines come out doubled or torn.
    if (session.protocol === "ssh") {
      windowsBuild().then((buildNumber) => {
        if (buildNumber && !this.disposed) this.term.options.windowsPty = { backend: "conpty", buildNumber };
      });
    }

    this.term.onData((data) => {
      if (this.state !== "connected" && this.state !== "connecting") return;
      this.sendInput(data);
      // Broadcast only what the user typed; xterm's automatic replies (device
      // reports, focus and mouse events) belong to this terminal alone, and
      // pastes are mirrored as text below.
      const typed = !this.pasting && this.userTurn;
      if (typed) this.ws.mirrorInput(this, { keys: data });
      if (typed && this.recording) this.recording.push(data);
    });
    // xterm turns a key or IME event into onData within the same event
    // dispatch; replies to terminal queries come later from output parsing.
    // So "user input" is exactly what arrives before this event turn ends.
    // xterm sends IME text (Korean syllables, keys typed in Hangul mode) from
    // its own setTimeout(0), queued after this capture listener runs; resetting
    // one timer later keeps that text marked as typed.
    const markUserInput = () => {
      this.userTurn = true;
      setTimeout(() => setTimeout(() => (this.userTurn = false), 0), 0);
    };
    for (const ev of ["keydown", "keypress", "compositionend", "input"]) this.host.addEventListener(ev, markUserInput, true);
    // Native pastes (Shift+Insert, Edit menu) go through our own paste path so
    // broadcast and macros see them as a paste, not as raw bracketed keys.
    this.host.addEventListener(
      "paste",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = e.clipboardData?.getData("text/plain");
        if (text) this.pasteFromUser(text);
      },
      true,
    );
    this.term.onSelectionChange(() => {
      if (state.settings.copyOnSelect && this.term.hasSelection()) writeClipboard(this.term.getSelection());
    });
    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e));
    // Ctrl + wheel changes the font size (one step per wheel notch; touchpads
    // send many small deltas, so they are accumulated).
    let wheel = 0;
    this.host.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        wheel += e.deltaY;
        if (Math.abs(wheel) < 40) return;
        this.zoom(wheel < 0 ? 1 : -1);
        wheel = 0;
      },
      { capture: true, passive: false },
    );
    this.host.addEventListener("contextmenu", async (e) => {
      if (!state.settings.rightClickPaste) return;
      e.preventDefault();
      this.paste();
    });
    this.resizer.observe(this.host);

    this.wireToolbar();
    this.renderKeyMode();
    this.connect();
  }

  title() {
    return this.session.name || endpoint(this.session);
  }

  status(): StatusInfo {
    return {
      protocol: this.session.protocol,
      endpoint: endpoint(this.session),
      state: this.state,
      detail: `${this.term.cols}×${this.term.rows}`,
      logPath: this.logPath,
      monitor: this.monitor,
      device: this.device ? `${deviceTitle(this.device)}${this.device.name ? ` · ${this.device.name}` : ""}` : undefined,
    };
  }

  // ---- remote resource monitor (SSH, Telnet) -----------------------------------------

  /** The shared monitor connection this tab shows (see SharedMonitor). */
  private shared: SharedMonitor | null = null;
  /** A reason shown without any connection (jump host, gateway). */
  private localMonitor: MonitorInfo | null = null;

  private get monitor(): MonitorInfo | null {
    return this.shared?.info ?? this.localMonitor;
  }

  /** The shared monitor changed: redraw the status bar. */
  monitorChanged() {
    if (!this.disposed) this.ws.changed();
  }

  /** The device behind this tab, as the monitor recognised it. */
  get device(): DeviceInfo | undefined {
    return this.shared?.device;
  }

  /** The monitor recognised the device: show it, and use the device key mode
   * for network gear unless this session already chose a mode. */
  deviceDetected(d: DeviceInfo) {
    if (this.disposed) return;
    const button = this.el.querySelector<HTMLElement>('[data-act="device"]')!;
    button.hidden = false;
    button.querySelector("[data-device-label]")!.textContent = d.network ? deviceTitle(d) : d.name || deviceTitle(d);
    button.title = `${deviceTitle(d)}${d.name ? ` · ${d.name}` : ""} — 자주 쓰는 명령, ${d.backup ? "설정 백업, " : ""}상위 프로세스`;
    // AIX and HP-UX take ^H for Backspace (their login prompt prints ^? for DEL).
    if ((d.kind === "aix" || d.kind === "hpux") && !this.session.options.backspace) {
      this.setKeyOption("backspace", "ctrl-h");
      toast(`${deviceTitle(d)}: Backspace를 Ctrl-H(^H)로 바꿨습니다 (툴바 "키"에서 바꿀 수 있음)`, "info", 4000);
    }
    if (d.network && this.session.options.keyMode === undefined) {
      this.session.options.keyMode = "network";
      if (!this.session.id.startsWith("quick-")) patchSession(this.session.id, {}, { keyMode: "network" }).catch(() => {});
      this.renderKeyMode();
      toast(`${deviceTitle(d)} 장비로 인식해 키 입력을 장비 방식(Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E)으로 바꿨습니다`, "info", 4000);
    }
  }

  /** Commands for the recognised device, config backup, top processes. */
  private deviceMenu() {
    const d = this.device;
    const sh = this.shared;
    if (!d || !sh) return;
    const r = this.el.querySelector<HTMLElement>('[data-act="device"]')!.getBoundingClientRect();
    const commands = deviceCommands(d.kind).map(([label, command]) => ({
      label: `${label}  ·  ${command}`,
      icon: "ChevronRight",
      action: () => {
        this.sendInput(`${command}\r`);
        this.term.focus();
      },
    }));
    contextMenu(r.left, r.bottom + 4, [
      { label: `${deviceTitle(d)}${d.name ? ` · ${d.name}` : ""}`, icon: "Server", disabled: true },
      "-",
      ...(d.backup ? [{ label: "설정 백업 (running-config를 파일로 저장)…", icon: "Save", action: () => this.backupConfig() }] : []),
      { label: "상위 프로세스·리소스", icon: "Activity", action: () => showTopProcesses(sh.id, this.title()) },
      ...(commands.length ? ["-" as const, ...commands] : []),
    ]);
  }

  /** Save the device's running configuration, read over the monitor connection. */
  private async backupConfig() {
    const d = this.device;
    const sh = this.shared;
    if (!d || !sh) return;
    toast("장비에서 설정을 읽는 중…", "info", 2500);
    try {
      const text = await api.monitorBackup(sh.id);
      const name = (d.name || this.session.host).replace(/[<>:"/\\|?*]/g, "_");
      const path = await pickSavePath(`${name}_${timestamp()}.cfg`, [{ name: "설정 파일", extensions: ["cfg", "txt", "conf"] }]);
      if (!path) return;
      await api.saveTextFile(path, text);
      toast(`설정을 저장했습니다 (${text.split("\n").length}줄): ${path}`, "success", 6000);
    } catch (err) {
      toast(`설정 백업 실패: ${errorText(err)}`, "error", 6000);
    }
  }

  /** Change this tab's font size by `step` points (8–32). It stays this tab's
   * own size when the settings change. */
  private zoom(step: number) {
    const size = Math.max(8, Math.min(32, (this.term.options.fontSize ?? 14) + step));
    if (size === this.term.options.fontSize) return;
    this.zoomed = size;
    this.term.options.fontSize = size;
    this.layout();
    let badge = this.el.querySelector<HTMLElement>(".zoom-badge");
    if (!badge) {
      badge = h("div", { class: "zoom-badge" });
      this.host.parentElement!.appendChild(badge);
    }
    badge.textContent = `글자 크기 ${size}`;
    badge.classList.add("show");
    clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => badge.classList.remove("show"), 900);
  }
  private zoomTimer = 0;
  /** Font size chosen with Ctrl+wheel / the zoom buttons, if any. */
  private zoomed: number | null = null;

  /** Show the CPU/memory monitor for this server, starting its connection
   * (a second, quiet login) unless another tab already runs it. */
  async startMonitor(extra: { password?: string; trustedFingerprint?: string; noPassword?: boolean } = {}) {
    const proto = this.session.protocol;
    if ((proto !== "ssh" && proto !== "telnet") || !state.settings.remoteMonitor || this.disposed) return;
    if (this.session.options.jumpHost || this.session.options.gateway) {
      this.localMonitor = { kind: "unsupported", message: "점프 호스트·게이트웨이 세션" };
      return this.ws.changed();
    }
    const key = [proto, this.session.host.trim().toLowerCase(), this.session.port ?? "", this.session.username].join("|");
    let m = monitors.get(key);
    if (!m) {
      m = { id: crypto.randomUUID(), key, info: null, views: new Set(), user: "" };
      monitors.set(key, m);
      monitorsById.set(m.id, m);
    }
    if (this.shared !== m) {
      this.leaveMonitor();
      m.views.add(this);
      this.shared = m;
      if (m.device) this.deviceDetected(m.device);
      syncPause(m);
    }
    // Another tab's connection is already up (or logging in): just show it.
    const running = m.info?.kind === "stats" || m.info?.kind === "starting";
    if (running && !extra.password && !extra.trustedFingerprint && !extra.noPassword) return this.ws.changed();
    setMonitorInfo(m, { kind: "starting" });
    try {
      await api.monitorStart({
        id: m.id,
        protocol: proto,
        host: this.session.host,
        port: this.session.port,
        username: this.session.username || m.user,
        credentialId: this.session.credentialId,
        ...extra,
      });
      // The login can outlast the tabs: if all of them closed meanwhile, the
      // connection would otherwise stay open.
      if (monitorsById.get(m.id) !== m) api.monitorStop(m.id).catch(() => {});
    } catch (err) {
      if (monitorsById.get(m.id) === m) setMonitorInfo(m, failedMonitor(errorText(err)));
    }
  }

  /** Stop showing the shared monitor; the last tab closes its connection. */
  private leaveMonitor() {
    const m = this.shared;
    this.shared = null;
    if (!m) return;
    m.views.delete(this);
    if (m.views.size) return syncPause(m);
    monitors.delete(m.key);
    monitorsById.delete(m.id);
    api.monitorStop(m.id).catch(() => {});
  }

  private stopMonitor() {
    this.leaveMonitor();
    this.localMonitor = null;
  }

  /** Status bar click on the monitor chip: top processes, log in, or approve the host key. */
  async monitorAction() {
    const m = this.monitor;
    const sh = this.shared;
    if (!m) return;
    if (m.kind === "stats" && sh) return showTopProcesses(sh.id, this.title());
    if (m.kind === "login" && sh) {
      if (m.needUser || (!this.session.username && !sh.user && this.session.protocol === "telnet")) {
        const u = await promptDialog({ title: "리소스 모니터링 로그인", label: "사용자 이름", icon: "Activity", confirm: "다음", value: sh.user });
        if (!u?.value.trim()) return;
        sh.user = u.value.trim();
      }
      const res = await promptDialog({
        title: "리소스 모니터링 로그인",
        label: `${this.session.username || sh.user || "사용자"}@${this.session.host} 의 비밀번호 (모니터링에만 쓰고 저장하지 않음)`,
        type: "password",
        icon: "Activity",
        confirm: "모니터링 시작",
        extra: this.session.protocol === "telnet" ? `<p class="muted small">비밀번호 없이 들어가는 장비라면 비워 두고 시작하세요.</p>` : undefined,
      });
      if (!res) return;
      if (res.value) this.startMonitor({ password: res.value });
      else if (this.session.protocol === "telnet") this.startMonitor({ noPassword: true });
    } else if (m.kind === "hostkey") {
      const ok = await confirmDialog({
        title: "처음 보는 호스트 키",
        icon: "ShieldCheck",
        message: `모니터링 연결이 <b>${esc(this.session.host)}</b>의 호스트 키를 확인해야 합니다.<br><br>지문: <code class="fp">${esc(m.fingerprint ?? "")}</code>`,
        confirm: "신뢰하고 시작",
      });
      if (ok) this.startMonitor({ trustedFingerprint: m.fingerprint });
    } else if (m.kind === "error") {
      this.startMonitor();
    }
  }

  /** Fit the terminal to its box, once per frame however many observers
   * ask. Only a real change of rows/columns reflows the buffer and is
   * reported to the server (and to the status bar). */
  layout() {
    if (this.layoutFrame) return;
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = 0;
      if (this.disposed || !this.el.isConnected || this.host.clientWidth === 0) return;
      try {
        const want = this.fit.proposeDimensions();
        if (!want || isNaN(want.cols) || isNaN(want.rows)) return;
        if (want.cols !== this.term.cols || want.rows !== this.term.rows) this.fit.fit();
      } catch {
        return;
      }
      const size = `${this.term.cols}x${this.term.rows}`;
      if (size === this.sentSize) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        if (this.disposed) return;
        this.sentSize = size;
        if (this.runtimeId) api.termResize(this.runtimeId, this.term.rows, this.term.cols).catch(() => {});
        this.ws.changed();
      }, 80);
    });
  }
  private layoutFrame = 0;
  /** Rows/columns last reported (a new connection reports again). */
  private sentSize = "";

  /** This tab is on screen (active, or in a visible split pane). */
  shown(): boolean {
    return this.ws.visibleTabs().some((t) => t.view === this);
  }

  /** On screen, as the workspace last reported (false while minimised). */
  onScreen = false;

  shownChanged(shown: boolean) {
    this.onScreen = shown;
    if (this.shared) syncPause(this.shared);
    this.updateRenderer();
  }

  /** The DOM renderer blinks the cursor with an endless CSS animation, which
   * makes the page redraw every frame even when nothing changes (on a PC
   * without a GPU about 3% of a core while a terminal has the focus). There a
   * timer hides the cursor every other half second instead; WebGL blinks with
   * a timer of its own. */
  private blinkTimer = 0;
  private wireBlink() {
    const el = this.term.element!;
    const stop = () => {
      clearInterval(this.blinkTimer);
      this.blinkTimer = 0;
      el.classList.remove("bx-cursor-off");
    };
    const start = () => {
      stop();
      if (this.webgl || this.disposed) return;
      this.blinkTimer = window.setInterval(() => el.classList.toggle("bx-cursor-off"), 530);
    };
    this.term.textarea?.addEventListener("focus", start);
    this.term.textarea?.addEventListener("blur", stop);
    // Typing keeps the cursor on, as with xterm's own blink.
    this.term.onData(() => this.blinkTimer && start());
    this.restartBlink = () => (document.activeElement === this.term.textarea ? start() : stop());
  }
  private restartBlink = () => {};

  /** WebGL draws terminals on screen only (browsers allow ~16 contexts). */
  private webgl: { dispose(): void } | null = null;
  private rendererSeq = 0;
  private async updateRenderer() {
    const mode = state.settings.renderer;
    const want = this.onScreen && !this.disposed && !webglFailed && (mode === "webgl" || (mode === "auto" && realGpu()));
    if (want === !!this.webgl) return this.syncBlink();
    const seq = ++this.rendererSeq;
    if (!want) {
      this.webgl?.dispose();
      this.webgl = null;
      return this.syncBlink();
    }
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      if (seq !== this.rendererSeq || this.disposed || this.webgl) return;
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        if (this.webgl === addon) this.webgl = null;
        this.syncBlink();
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch {
      webglFailed = true;
    }
    this.syncBlink();
  }

  /** xterm blinks under WebGL; under the DOM renderer the timer does. */
  private syncBlink() {
    const own = !!this.webgl;
    if (this.term.options.cursorBlink !== own) this.term.options.cursorBlink = own;
    this.restartBlink();
  }

  focus() {
    this.term.focus();
  }

  /** Input for the connection. Typed while it is still being opened (a
   * Telnet connect, a gateway login), it waits and goes out once open. */
  sendInput(data: string) {
    if (this.opened !== this.runtimeId) {
      if (this.early.length < 1000) this.early.push(data);
      return;
    }
    if (this.pasting && this.paced && /\r[^]/.test(data)) return this.pacePaste(data);
    if (this.pasteActive && data.includes("\x03")) this.stopPaste();
    api.termWrite(this.runtimeId, data).catch((err) => this.inputRefused(err));
  }

  /** Multi-line input reaches a device console one line at a time, as fast
   * as the device takes it (paste.rs): serial ports, and Telnet sessions
   * marked as console-server connections. */
  private get paced(): boolean {
    return this.session.protocol === "serial" || (this.session.protocol === "telnet" && !!this.session.options.pacedPaste);
  }

  /** A paced paste is running on this connection. */
  private pasteActive = false;
  private pasteStarted = 0;

  private pacePaste(data: string) {
    const s = state.settings;
    const mode = s.pasteMode === "fixed" ? { kind: "fixed" as const, lineMs: s.pasteLineDelay, charMs: s.pasteCharDelay } : { kind: "echo" as const };
    if (!this.pasteActive) this.pasteStarted = Date.now();
    this.pasteActive = true;
    api.termPaste(this.runtimeId, data, mode).catch((err) => {
      this.pasteActive = false;
      this.inputRefused(err);
    });
  }

  /** Stop the paced paste; `quiet`: the connection is going away anyway. */
  private stopPaste(quiet = false) {
    if (!this.pasteActive) return;
    api.termPasteStop(this.runtimeId).catch(() => {});
    if (quiet) {
      this.pasteActive = false;
      this.renderPasteProgress(null);
    }
  }

  pasteProgress(e: PasteEvent) {
    if (e.id !== this.runtimeId || this.disposed) return;
    if (e.state === "running") {
      this.pasteActive = true;
      this.renderPasteProgress(e);
      return;
    }
    this.pasteActive = false;
    this.renderPasteProgress(null);
    const left = e.total - e.sent;
    const secs = Math.max(1, Math.round((Date.now() - this.pasteStarted) / 1000));
    if (e.state === "stopped" && left) toast(`붙여넣기를 멈췄습니다 (${left}줄은 보내지 않음)`, "warn");
    else if (e.state === "failed") toast(`연결이 끊어져 붙여넣기를 마치지 못했습니다 (${left}줄은 보내지 않음)`, "error", 6000);
    else if (e.state === "done" && e.total >= 20) toast(`${e.total}줄을 보냈습니다 (${secs}초)`, "success", 3000);
  }

  /** Lines sent, time left and a stop button over the terminal while a
   * paced paste of more than a few lines runs; null removes it. */
  private renderPasteProgress(e: PasteEvent | null) {
    let box = this.el.querySelector<HTMLElement>(".paste-progress");
    if (!e || e.total < 5) {
      box?.remove();
      return;
    }
    if (!box) {
      box = h("div", { class: "paste-progress", role: "status" });
      box.innerHTML = `<div class="pp-row"><span>붙여넣는 중</span><b data-pp-count></b><span class="muted" data-pp-eta></span>
          <button type="button" class="btn sm" data-pp-stop title="남은 줄을 보내지 않습니다 (Ctrl+C)">${icon("CircleStop", 13)}<span>중지</span></button></div>
        <div class="pp-bar"><i></i></div>`;
      box.querySelector("[data-pp-stop]")!.addEventListener("click", () => {
        this.stopPaste();
        this.term.focus();
      });
      this.host.parentElement!.appendChild(box);
    }
    box.querySelector<HTMLElement>("[data-pp-count]")!.textContent = `${e.sent} / ${e.total}`;
    box.querySelector<HTMLElement>(".pp-bar i")!.style.width = `${(100 * e.sent) / e.total}%`;
    const elapsed = (Date.now() - this.pasteStarted) / 1000;
    const eta = e.sent > 2 && elapsed > 0.5 ? Math.ceil(((e.total - e.sent) * elapsed) / e.sent) : 0;
    box.querySelector<HTMLElement>("[data-pp-eta]")!.textContent = eta ? tr(`약 ${eta}초 남음`) : "";
  }

  /** Send a text file (a configuration) as if it were pasted. */
  private async sendFile() {
    if (this.state !== "connected") return toast("연결된 다음에 보낼 수 있습니다", "warn");
    const path = await pickOpenFile("보낼 텍스트 파일");
    if (!path) return;
    try {
      const text = await api.readTextFile(path);
      if (!text) return toast("빈 파일입니다", "warn");
      this.pasteFromUser(text, path.split(/[\\/]/).pop());
    } catch (err) {
      toast(errorText(err), "error", 6000);
    }
  }
  /** The runtime id whose backend session exists (termOpen returned). */
  private opened = "";
  private early: string[] = [];

  /** termOpen returned: send what was typed meanwhile and what was acknowledged. */
  private connectionOpened(rid: string) {
    this.opened = rid;
    const early = this.early.splice(0);
    if (early.length) api.termWrite(rid, early.join("")).catch(() => {});
    if (this.acked) this.ack(rid, 0);
  }

  receiveBroadcast(input: BroadcastInput) {
    if ("keys" in input) this.sendInput(this.expandKeys(input.keys));
    else if ("editKey" in input) this.sendInput(this.editKeyBytes(input.editKey));
    else this.pasteText(input.paste);
  }

  /** A recorded macro's editing-key marks as this tab's own bytes. */
  private expandKeys(data: string): string {
    return data.replace(/[\uE100-\uE103]/g, (m) => this.editKeyBytes(MARKED_KEYS[m.charCodeAt(0) - 0xe100]));
  }

  /** Bytes for an editing key in this tab's key mode: control keys for network
   * gear, the VT sequences (honouring application cursor mode) otherwise. */
  private editKeyBytes(key: EditKey): string {
    // AIX and HP-UX logins (and their default stty erase) take ^H, not DEL.
    if (key === "Backspace") return this.session.options.backspace === "ctrl-h" ? "\x08" : "\x7f";
    if (this.keyMode === "network") return { Delete: "\x04", Home: "\x01", End: "\x05" }[key];
    const app = this.term.modes.applicationCursorKeysMode;
    return { Delete: "\x1b[3~", Home: app ? "\x1bOH" : "\x1b[H", End: app ? "\x1bOF" : "\x1b[F" }[key];
  }

  /** Paste through xterm so this terminal's bracketed-paste mode applies. */
  private pasteText(text: string) {
    this.pasting = true;
    try {
      this.term.paste(text);
    } finally {
      this.pasting = false;
    }
  }

  private refusedAt = 0;
  /** Typed input the session did not take (the device holds XOFF and the
   * queue is full): say so, at most every few seconds, instead of losing
   * keystrokes silently. */
  private inputRefused(err: unknown) {
    if (this.state !== "connected" || Date.now() - this.refusedAt < 5000) return;
    this.refusedAt = Date.now();
    toast(`입력을 보내지 못했습니다: ${errorText(err)}`, "warn");
  }

  /** Send a saved command; it follows broadcast like typed input does. */
  private async sendSnippet(s: Snippet) {
    if (this.state !== "connected") return toast("연결된 다음 보낼 수 있습니다", "warn");
    // Macro text may hold editing-key marks; other tabs expand them their own way.
    const marked = s.macro ? s.text : s.text.replace(/\r?\n/g, "\r") + (s.run ? "\r" : "");
    const data = this.expandKeys(marked);
    // Risky commands (riskRules.ts): blocked ones never go out; the others
    // only after a confirmation, with the tab's log on and an audit line.
    const hits = findRisks(data);
    // A risky command goes exactly to the tabs that were confirmed, logged and
    // audited, even if another tab connects while the dialog is open.
    let confirmedOthers: Tab[] | null = null;
    if (hits.length) {
      // With broadcast on the same text also goes to these tabs.
      const others = this.ws.mirrorTargets(this);
      confirmedOthers = others;
      const targets = [{ session: this.session, view: this as View }, ...others];
      const where = targets.map((t) => endpoint(t.session)).join(", ");
      const audit = (event: string) =>
        Promise.all(
          targets.flatMap((t) => hits.map((h) => api.riskAudit(event, t.session.name || endpoint(t.session), endpoint(t.session), h.rule.note, h.line))),
        ).then(
          () => true,
          (err) => {
            toast(errorText(err), "error");
            return false;
          },
        );
      // User data (commands, names) is shown as is, never run through translation.
      const item = (h: (typeof hits)[number]) => `<li><code data-i18n-skip>${esc(h.line)}</code> — <span>${esc(h.rule.note)}</span></li>`;
      const blocked = hits.filter((h) => h.rule.action === "block");
      if (blocked.length) {
        await audit("BLOCKED");
        await confirmDialog({
          title: "차단된 명령입니다",
          icon: "ShieldAlert",
          danger: true,
          message: `<p>보낼 수 없는 명령이 있어 아무것도 보내지 않았습니다.</p><p class="muted small">스니펫: <b data-i18n-skip>${esc(s.name)}</b></p><ul>${blocked.map(item).join("")}</ul>
            <p class="muted small">이 시도는 위험 명령 기록(risky-commands.log)에 남았습니다. 규칙은 설정 → 위험 명령에서 바꿀 수 있습니다.</p>`,
          confirm: "확인",
          cancel: null,
        });
        return;
      }
      const ok = await confirmDialog({
        title: "위험한 명령이 있습니다",
        icon: "TriangleAlert",
        danger: true,
        message: `<p>보내면 다음 명령이 실행됩니다.</p><p class="muted small">스니펫: <b data-i18n-skip>${esc(s.name)}</b> · 대상: <b data-i18n-skip>${esc(where)}</b></p><ul>${hits.map(item).join("")}</ul>
          ${others.length ? `<p class="muted small">${others.length}개 탭에 동시 입력이 켜져 있어 함께 보냅니다.</p>` : ""}
          <p class="muted small">보내면 받는 탭의 로그 기록이 켜지고, 위험 명령 기록(risky-commands.log)에 남습니다.</p>`,
        confirm: "로그를 켜고 보내기",
        cancel: "취소",
        focusCancel: true,
      });
      if (!ok) {
        await audit("CANCELLED");
        return;
      }
      if (this.state !== "connected") return toast("연결이 끊어져 보내지 않았습니다", "warn");
      // The log and the audit line are the condition for sending: when
      // either cannot be written, nothing goes out.
      const logged = await Promise.all(targets.map((t) => t.view.ensureLog?.() ?? Promise.resolve(false)));
      if (logged.includes(false) || !(await audit("SENT"))) {
        await audit("NOT SENT");
        return toast("로그를 켜거나 위험 명령 기록을 남길 수 없어 보내지 않았습니다", "error");
      }
    }
    this.sendInput(data);
    if (confirmedOthers) {
      for (const t of confirmedOthers) if (t.view.state === "connected") t.view.receiveBroadcast?.({ keys: marked });
    } else this.ws.mirrorInput(this, { keys: marked });
    this.recording?.push(marked);
    this.term.focus();
  }

  /** Start recording typed input as a macro, or stop and save it. */
  private async toggleRecording() {
    const btn = this.el.querySelector<HTMLElement>('[data-act="record"]')!;
    if (!this.recording) {
      this.recording = [];
      btn.classList.add("recording");
      btn.innerHTML = `${icon("CircleStop", 15)}<span>기록 끝</span>`;
      toast("매크로 기록을 시작했습니다. 입력한 키가 그대로 저장되므로 비밀번호는 입력하지 마세요.", "warn", 5000);
      this.term.focus();
      return;
    }
    const keys = this.recording.join("");
    this.recording = null;
    btn.classList.remove("recording");
    btn.innerHTML = `${icon("Circle", 15)}<span>기록</span>`;
    if (!keys) return toast("기록된 입력이 없습니다", "info");
    const res = await promptDialog({ title: "매크로 저장", label: "매크로 이름", icon: "Circle", confirm: "저장", value: `매크로 ${state.snippets.filter((s) => s.macro).length + 1}` });
    if (!res?.value.trim()) return toast("매크로를 저장하지 않았습니다", "info");
    addMacro(res.value.trim(), keys);
    toast(`매크로 "${res.value.trim()}"를 저장했습니다. 스니펫 메뉴에서 다른 터미널에 재생할 수 있습니다.`, "success", 5000);
  }

  /** The host's padding should match the terminal theme's background. */
  private applyThemeBackground() {
    this.host.style.background = termTheme(state.settings.terminalTheme).background ?? "";
  }

  /** Apply changed settings only: an unrelated change (a "don't ask again"
   * box) must not re-render every terminal or undo this tab's zoom. */
  applySettings() {
    const s = state.settings;
    const o = this.term.options;
    if (o.fontFamily !== s.fontFamily) o.fontFamily = s.fontFamily;
    if (this.zoomed === null && o.fontSize !== s.fontSize) o.fontSize = s.fontSize;
    if (o.cursorStyle !== s.cursorStyle) o.cursorStyle = s.cursorStyle;
    if (o.scrollback !== s.scrollback) o.scrollback = s.scrollback;
    if (this.theme !== s.terminalTheme) {
      this.theme = s.terminalTheme;
      o.theme = termTheme(s.terminalTheme);
      this.applyThemeBackground();
    }
    if (this.renderer !== s.renderer) {
      this.renderer = s.renderer;
      this.updateRenderer();
    }
    this.layout();
  }
  private theme = state.settings.terminalTheme;
  private renderer = state.settings.renderer;

  // ---- connection ------------------------------------------------------------

  private async connect() {
    this.setState("connecting");
    this.gotOutput = false;
    // A new connection starts on the normal screen with default colours.
    this.highlighter = new KeywordHighlighter();
    this.overlay.hidden = true;
    this.layout();
    this.runtimeId = crypto.randomUUID();
    // Acknowledgements and early input of the previous connection are void.
    clearTimeout(this.ackTimer);
    this.ackTimer = 0;
    this.acked = 0;
    this.early = [];
    const p = this.session.protocol as "ssh" | "telnet" | "serial";
    // Text written into the terminal is not translated on screen; tr() does it here.
    this.term.write(`\x1b[90m${tr(`${PROTOCOLS[p].label} ${endpoint(this.session)}에 연결하는 중...`)}\x1b[0m\r\n`);
    const rid = this.runtimeId;
    try {
      // Telnet can go through an SSH gateway (SSH has its own jump host option).
      const tunnelPort = p === "telnet" ? await this.gateway.port() : undefined;
      if (this.disposed || rid !== this.runtimeId) return;
      if (tunnelPort === null) throw new Error("SSH 게이트웨이 연결을 취소했습니다.");
      await api.termOpen(
        {
        id: rid,
        protocol: p,
        host: tunnelPort ? "127.0.0.1" : this.session.host,
        port: tunnelPort ?? this.session.port,
        username: this.session.username,
        credentialId: this.session.credentialId,
        keepalive: (this.session.options.keepalive as number) || null,
        jumpHost: String(this.session.options.jumpHost ?? ""),
        forwards: String(this.session.options.forwards ?? ""),
        compression: !!this.session.options.compression,
        agentForward: !!this.session.options.agentForward,
        rows: this.term.rows,
        cols: this.term.cols,
        serial: p === "serial" ? { ...serialSettings(this.session.options), io: state.settings.serialIo } : null,
        },
        (bytes) => this.receive(rid, bytes),
        (code) => this.exited(rid, code),
      );
      // Closed or reconnected while connecting: this connection is orphaned.
      if (this.disposed || rid !== this.runtimeId) {
        api.termClose(rid).catch(() => {});
        return;
      }
      this.connectionOpened(rid);
      // termOpen used the size from before the tab was laid out, and a Telnet
      // session only exists once connected: report the real size now.
      api.termResize(rid, this.term.rows, this.term.cols).catch(() => {});
      this.sentSize = `${this.term.cols}x${this.term.rows}`;
      // The connection may already have ended (its exit can arrive first).
      // SSH counts as connected once it prints something; Telnet and serial
      // lines are open as soon as the connection is.
      if (p !== "ssh" && this.state === "connecting") this.setState("connected");
      const alive = this.state !== "closed" && this.state !== "error";
      if ((logConfig(this.session).auto || this.relog) && alive) {
        await this.setLogging(true);
        // Owed until a log is actually running again.
        if (this.logPath) this.relog = false;
      }
    } catch (err) {
      if (this.disposed || rid !== this.runtimeId) return;
      this.setState("error");
      this.term.write(`\r\n\x1b[31m${tr(`연결 실패: ${errorText(err)}`)}\x1b[0m\r\n`);
      // A COM port that is not plugged in (yet): connect when it appears.
      if (/찾을 수 없습니다/.test(errorText(err)) && this.waitForPort(errorText(err))) return;
      this.showOverlay("연결하지 못했습니다", errorText(err));
    }
  }

  async reconnect() {
    this.stopPortWait();
    this.portWaitDeclined = false;
    this.stopPaste(true);
    this.stopMonitor();
    if (this.runtimeId) {
      // Wait for the old connection to let go (a COM port can be opened once).
      await api.termClose(this.runtimeId).catch(() => {});
    }
    // The log belonged to the old connection; it is reopened for the new one
    // (still owed if an earlier reconnect failed before it could).
    this.relog ||= !!this.logPath;
    this.logPath = null;
    this.el.querySelector('[data-act="log"]')!.classList.remove("on");
    this.term.write(`\r\n\x1b[90m──────── ${tr("다시 연결")} ────────\x1b[0m\r\n`);
    this.connect();
  }

  /** Output of connection `rid`. Acknowledged once xterm has processed it, so
   * the backend pauses a flood instead of piling it up here. */
  receive(rid: string, bytes: Uint8Array) {
    if (rid !== this.runtimeId || this.disposed) return;
    const n = bytes.length;
    // The highlighter always follows the escape state (alternate screen,
    // program colours), so turning it on mid-session is right at once.
    const shown = this.highlighter.process(bytes, state.settings.highlightKeywords);
    this.term.write(shown, () => this.ack(rid, n));
    if (!this.gotOutput) {
      this.gotOutput = true;
      if (this.state === "connecting") this.setState("connected");
    }
  }

  private acked = 0;
  private ackTimer = 0;
  private ack(rid: string, n: number) {
    if (rid !== this.runtimeId) return;
    this.acked += n;
    // Output (a banner) can arrive before termOpen returns, while the backend
    // cannot take acknowledgements yet: they are sent once it is open.
    if (rid !== this.opened) return;
    const send = () => {
      clearTimeout(this.ackTimer);
      this.ackTimer = 0;
      const bytes = this.acked;
      this.acked = 0;
      if (bytes && rid === this.runtimeId) api.termAck(rid, bytes).catch(() => {});
    };
    // Big batches at once (the backend may be waiting); small echoes later, together.
    if (this.acked >= 64 * 1024) send();
    else if (!this.ackTimer) this.ackTimer = window.setTimeout(send, 50);
  }

  exited(id: string, code: number) {
    if (id === this.runtimeId) this.stopPaste(true);
    if (id !== this.runtimeId) return;
    this.stopMonitor();
    this.setState("closed");
    this.term.write(`\r\n\x1b[90m[${tr("연결이 종료되었습니다")}${code ? ` ${tr(`· 종료 코드 ${code}`)}` : ""}]\x1b[0m\r\n`);
    // A serial line ends with an error only when the port went away.
    if (code && this.waitForPort("연결이 끊어졌습니다.")) return;
    this.showOverlay("연결이 종료되었습니다", "다시 연결하거나 탭을 닫을 수 있습니다.");
  }

  /** Timer of the wait for a serial port to come back (0: not waiting). */
  private portWait = 0;
  /** "Stop waiting" was chosen: an attempt still under way must not start
   * the wait again; the next reconnect by the user allows it again. */
  private portWaitDeclined = false;

  /** A COM port that went away (USB adapter unplugged) or is not there yet:
   * check every second and reconnect once it shows up. False when this tab
   * does not wait (not serial, or turned off in Settings). */
  private waitForPort(reason: string): boolean {
    if (this.session.protocol !== "serial" || !state.settings.serialAutoReconnect || this.portWaitDeclined || this.disposed) return false;
    const name = this.session.host.trim().toUpperCase();
    this.stopPortWait();
    this.showOverlay(`${name} 포트를 기다리는 중`, reason, true);
    const rid = this.runtimeId;
    const tick = async () => {
      if (!this.portWait || this.disposed || rid !== this.runtimeId) return;
      const ports = await api.serialPorts().catch(() => []);
      if (!this.portWait) return;
      if (ports.some((p) => p.name === name)) {
        this.stopPortWait();
        // Give the driver a moment to finish setting the port up.
        window.setTimeout(() => !this.disposed && rid === this.runtimeId && this.reconnect(), 500);
        return;
      }
      this.portWait = window.setTimeout(tick, 1000);
    };
    this.portWait = window.setTimeout(tick, 1000);
    return true;
  }

  private stopPortWait() {
    clearTimeout(this.portWait);
    this.portWait = 0;
  }

  private setState(s: ViewState) {
    if (s === "connected" && this.state !== "connected") queueMicrotask(() => this.startMonitor());
    // The SFTP browser opens next to a new SSH session (Settings).
    if (s === "connected" && this.state !== "connected" && !this.filesOpened && this.session.protocol === "ssh" && state.settings.sftpWithSsh) {
      this.filesOpened = true;
      if (this.session.options.jumpHost) toast("점프 호스트를 쓰는 세션은 SFTP 창을 자동으로 열지 않습니다", "info");
      else queueMicrotask(() => !this.disposed && this.openFiles(this.session, this));
    }
    this.state = s;
    const label: Record<ViewState, string> = {
      connecting: "연결 중",
      connected: "연결됨",
      closed: "종료됨",
      error: "오류",
    };
    const el = this.el.querySelector<HTMLElement>("[data-state]")!;
    el.textContent = label[s];
    el.dataset.state = s;
    this.ws.changed();
  }

  /** `waiting`: waiting for a COM port to come back (waitForPort). */
  private showOverlay(title: string, detail: string, waiting = false) {
    this.overlay.hidden = false;
    this.overlay.innerHTML = waiting
      ? `<div class="overlay-card port-wait">
        ${icon("Usb", 26)}
        <h3>${esc(title)}</h3><p>${esc(detail)}</p>
        <p class="muted small">케이블(USB 어댑터)을 다시 연결하면 자동으로 연결합니다.</p>
        <div class="row"><button class="btn btn-primary" data-o="re">${icon("RotateCw", 15)}지금 다시 연결</button>
        <button class="btn" data-o="stop">기다리지 않기</button></div></div>`
      : `<div class="overlay-card">
        ${icon(this.state === "error" ? "WifiOff" : "Unlink", 26)}
        <h3>${esc(title)}</h3><p>${esc(detail)}</p>
        <div class="row"><button class="btn btn-primary" data-o="re">${icon("RotateCw", 15)}다시 연결</button>
        <button class="btn" data-o="hide">닫기</button></div></div>`;
    this.overlay.querySelector('[data-o="re"]')!.addEventListener("click", () => this.reconnect());
    this.overlay.querySelector('[data-o="hide"]')?.addEventListener("click", () => (this.overlay.hidden = true));
    this.overlay.querySelector('[data-o="stop"]')?.addEventListener("click", () => {
      this.stopPortWait();
      this.portWaitDeclined = true;
      this.showOverlay("연결이 종료되었습니다", detail);
    });
  }

  // ---- toolbar ---------------------------------------------------------------

  private wireToolbar() {
    this.el.querySelector(".view-actions")!.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (!act) return;
      switch (act) {
        case "find":
          return this.toggleFind(true);
        case "log":
          return this.setLogging(!this.logPath, true);
        case "save":
          return this.saveOutput();
        case "clear":
          return this.term.clear();
        case "zoomin":
        case "zoomout":
          return this.zoom(act === "zoomin" ? 1 : -1);
        case "sftp":
          return this.openFiles(this.session, this);
        case "reconnect":
          return this.reconnect();
        case "device":
          return this.deviceMenu();
        case "keys":
          return this.keysMenu();
        case "sendfile":
          return void this.sendFile();
        case "break":
          this.stopPaste();
          return void api.termBreak(this.runtimeId).then(
            () => toast("Break 신호를 보냈습니다", "success", 2000),
            (err) => toast(errorText(err), "error"),
          );
        case "snippet":
          return snippetMenu(this.el.querySelector('[data-act="snippet"]')!, (s) => this.sendSnippet(s), this.device?.kind);
        case "record":
          return this.toggleRecording();
      }
    });
    const input = this.findBar.querySelector("input")!;
    const find = (dir: "next" | "prev") => {
      const opts = { decorations: { matchOverviewRuler: "#f5c518", activeMatchColorOverviewRuler: "#f5c518", activeMatchBackground: "#f5c51866", matchBackground: "#f5c51833" } };
      if (dir === "next") this.search.findNext(input.value, opts);
      else this.search.findPrevious(input.value, opts);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") find(e.shiftKey ? "prev" : "next");
      if (e.key === "Escape") this.toggleFind(false);
    });
    input.addEventListener("input", () => find("next"));
    this.findBar.addEventListener("click", (e) => {
      const f = (e.target as HTMLElement).closest<HTMLElement>("[data-find]")?.dataset.find;
      if (f === "close") this.toggleFind(false);
      else if (f === "next" || f === "prev") find(f);
    });
  }

  private toggleFind(show: boolean) {
    this.findBar.hidden = !show;
    if (show) {
      const input = this.findBar.querySelector("input")!;
      if (this.term.hasSelection()) input.value = this.term.getSelection();
      input.focus();
      input.select();
    } else {
      this.search.clearDecorations();
      this.term.focus();
    }
    this.layout();
  }

  /** Start or stop the log. `ask`: started from the toolbar, so offer to edit
   * the file name first (when the settings say so). */
  private async setLogging(enable: boolean, ask = false) {
    try {
      let options = null;
      if (enable) {
        const c = this.relog && this.logUsed ? { ...this.logUsed } : logConfig(this.session);
        if (ask && state.settings.logPrompt) {
          const res = await promptDialog({
            title: "로그 기록 시작",
            label: "로그 파일 이름",
            value: c.path,
            icon: "ScrollText",
            confirm: "기록 시작",
            extra: `<p class="muted small">지금 시작하면: <b data-log-preview>${esc(previewPath(c.path, this.session))}</b></p>
                    <p class="muted small">치환 문자: ${LOG_TOKENS}</p>`,
            onInput: (value, form) => {
              form.querySelector("[data-log-preview]")!.textContent = previewPath(value.trim() || c.path, this.session);
            },
          });
          if (!res || this.disposed) return;
          c.path = res.value.trim() || c.path;
        }
        this.logUsed = c;
        options = backendLogOptions(c, this.session);
      }
      this.logPath = await api.termSetLogging(this.runtimeId, options);
      this.el.querySelector('[data-act="log"]')!.classList.toggle("on", !!this.logPath);
      if (this.logPath) toast(`로그 기록을 시작했습니다: ${this.logPath}`, "success");
      else toast("로그 기록을 중지했습니다");
      this.ws.changed();
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  async ensureLog(): Promise<boolean> {
    if (!this.logPath) await this.setLogging(true);
    return !!this.logPath;
  }

  revealLog() {
    if (this.logPath) revealInExplorer(this.logPath);
  }

  private async saveOutput() {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    const path = await pickSavePath(`${this.title()}_${timestamp()}.txt`, [{ name: "텍스트", extensions: ["txt", "log"] }]);
    if (!path) return;
    try {
      await api.saveTextFile(path, lines.join("\r\n") + "\r\n");
      toast(`출력 내용을 저장했습니다 (${lines.length}줄)`, "success");
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  private async paste() {
    const text = await readClipboard();
    if (text) this.pasteFromUser(text);
  }

  /** `file`: the name of the file being sent (the confirmation names it). */
  private async pasteFromUser(text: string, file?: string) {
    const lines = text.replace(/\r?\n$/, "").split(/\r?\n|\r/);
    if (lines.length > 1 && state.settings.confirmMultiPaste) {
      const preview = lines.slice(0, 6).map((l) => esc(l.length > 120 ? `${l.slice(0, 120)}…` : l)).join("\n");
      const how = this.paced
        ? state.settings.pasteMode === "fixed"
          ? "장비 콘솔이라 정해진 지연을 두고 한 줄씩 보냅니다. 보내는 중에 Ctrl+C를 누르면 멈춥니다."
          : "장비 콘솔이라 장비가 각 줄을 받아들이는 대로 한 줄씩 보냅니다. 보내는 중에 Ctrl+C를 누르면 멈춥니다."
        : "";
      // One text node per sentence, so each is translated whole; the preview
      // is the user's own text and is never translated.
      const ok = await confirmDialog({
        title: file ? "텍스트 파일 보내기" : "여러 줄 붙여넣기",
        icon: "ClipboardPaste",
        message: `<p><b>${esc(`${lines.length}줄을 보냅니다: ${this.title()}`)}</b></p>
          ${file ? `<p class="muted small">${esc(`파일: ${file}`)}</p>` : ""}
          <pre class="paste-preview" data-i18n-skip>${preview}${lines.length > 6 ? "\n…" : ""}</pre>
          ${how ? `<p class="muted small">${how}</p>` : ""}`,
        confirm: "보내기",
        dontAsk: () => updateSettings({ confirmMultiPaste: false }),
      });
      this.term.focus();
      if (!ok) return;
    }
    this.pasteText(text);
    this.ws.mirrorInput(this, { paste: text });
    this.recording?.push(text.replace(/\r?\n/g, "\r"));
  }

  private get keyMode(): "standard" | "network" {
    return this.session.options.keyMode === "network" ? "network" : "standard";
  }

  private renderKeyMode() {
    const label = this.el.querySelector<HTMLElement>("[data-keys-label]");
    const bs = this.session.options.backspace === "ctrl-h" ? " · ^H" : "";
    if (label) label.textContent = (this.keyMode === "network" ? "키: 장비" : "키: 표준") + bs;
    this.el.querySelector('[data-act="keys"]')?.classList.toggle("on", this.keyMode === "network");
  }

  /** Key options for this tab, remembered in the saved session. */
  private keysMenu() {
    const r = this.el.querySelector<HTMLElement>('[data-act="keys"]')!.getBoundingClientRect();
    const ctrlH = this.session.options.backspace === "ctrl-h";
    const network = this.keyMode === "network";
    contextMenu(r.left, r.bottom + 4, [
      { label: "표준: Delete·Home·End를 VT 코드로", icon: network ? "Circle" : "Check", action: () => this.setKeyOption("keyMode", "standard") },
      { label: "장비: Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E", icon: network ? "Check" : "Circle", action: () => this.setKeyOption("keyMode", "network") },
      "-",
      { label: "Backspace = DEL (^?)", icon: ctrlH ? "Circle" : "Check", action: () => this.setKeyOption("backspace", "del") },
      { label: "Backspace = Ctrl-H (^H) — AIX·HP-UX", icon: ctrlH ? "Check" : "Circle", action: () => this.setKeyOption("backspace", "ctrl-h") },
    ]);
  }

  private setKeyOption(name: "keyMode" | "backspace", value: string) {
    this.session.options[name] = value;
    if (!this.session.id.startsWith("quick-")) patchSession(this.session.id, {}, { [name]: value }).catch(() => {});
    this.renderKeyMode();
    this.term.focus();
  }

  private handleKey(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    // Network gear (Cisco IOS & co.) does not understand ESC [ 3 ~ and prints
    // the "~"; it edits lines with Emacs-style control keys instead.
    // Delete/Home/End are sent here in both key modes, and broadcast as the key
    // itself: each receiving tab turns it into its own bytes, so a network-gear
    // tab never sends Ctrl-D (EOF) into a Linux shell, or ESC [ 3 ~ to a switch.
    const plainBackspace = e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.metaKey;
    if (plainBackspace || (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && (e.key === "Delete" || e.key === "Home" || e.key === "End"))) {
      e.preventDefault();
      if (this.state === "connected" || this.state === "connecting") {
        const bytes = this.editKeyBytes(e.key as EditKey);
        this.sendInput(bytes);
        this.ws.mirrorInput(this, { editKey: e.key as EditKey });
        // Recorded as the key, not these bytes: replayed in another tab it
        // becomes that tab's bytes.
        this.recording?.push(String.fromCharCode(0xe100 + MARKED_KEYS.indexOf(e.key as EditKey)));
      }
      return false;
    }
    // Terminal shortcuts (keymap.ts; the user can change them).
    const act = actionFor(e, "terminal");
    if (act?.startsWith(SNIPPET_PREFIX)) {
      const snippet = state.snippets.find((x) => SNIPPET_PREFIX + x.id === act);
      if (snippet) {
        e.preventDefault();
        void this.sendSnippet(snippet);
        return false;
      }
    }
    switch (act) {
      case "term.copy":
        if (this.term.hasSelection()) writeClipboard(this.term.getSelection());
        return false;
      // Copies when there is a selection; otherwise the key goes to the remote (Ctrl+C is ^C).
      case "term.copySelection":
        if (!this.term.hasSelection()) break;
        writeClipboard(this.term.getSelection());
        this.term.clearSelection();
        return false;
      case "term.paste":
        e.preventDefault(); // otherwise WebView2 also fires a native paste into xterm
        this.paste();
        return false;
      case "term.find":
        this.toggleFind(true);
        return false;
      case "term.selectAll":
        this.term.selectAll();
        return false;
      default: {
        // The rest do what their toolbar button does (hidden buttons do not apply here).
        const button = act && TOOLBAR_KEYS[act];
        const el = button ? this.el.querySelector<HTMLElement>(`.view-actions [data-act="${button}"]`) : null;
        if (el && !el.hidden && !(el as HTMLButtonElement).disabled) {
          e.preventDefault();
          el.click();
          return false;
        }
      }
    }
    // App-wide shortcuts (new tab, close tab, Ctrl+Tab …) go to the app, not the remote.
    if (appTakesInTerminal(e)) return false;
    return true;
  }

  private resizer = new ResizeObserver(() => this.layout());

  dispose() {
    this.disposed = true;
    this.stopPortWait();
    this.resizer.disconnect();
    clearInterval(this.blinkTimer);
    clearTimeout(this.resizeTimer);
    clearTimeout(this.zoomTimer);
    clearTimeout(this.ackTimer);
    cancelAnimationFrame(this.layoutFrame);
    this.stopMonitor();
    allViews.delete(this);
    if (this.runtimeId) {
      api.termClose(this.runtimeId).catch(() => {});
    }
    this.term.dispose();
    this.gateway.close();
  }
}
