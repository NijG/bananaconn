// Built-in RDP viewer. The remote desktop is drawn into a canvas from screen
// updates streamed by the bx-rdp helper; keyboard (as scancodes), mouse and
// wheel input go back the same way.

import { api, rdpOpen, type RdpEvent, type RdpFrames } from "../api";
import { readClipboard, writeClipboard } from "../clipboard";
import { icon } from "../icons";
import { endpoint, PROTOCOLS, type Session } from "../model";
import { patchSession, reloadCredentials } from "../store";
import { confirmDialog, errorText, esc, h, modal, toast } from "../ui";
import type { StatusInfo, View, ViewState, Workspace } from "../workspace";
import { GatewayLink } from "../tunnels";
import { desktopHost, ViewAi } from "../ai/viewAi";
import { tr } from "../i18n";
import { KEY, MODIFIER_CODES, namedKeyFor, scancodeFor } from "./rdpKeys";

type Op =
  | { t: "key"; code: number; ext: boolean; down: boolean; repeat?: boolean }
  | { t: "unicode"; ch: string; down: boolean }
  | { t: "move"; x: number; y: number }
  | { t: "button"; b: number; down: boolean }
  | { t: "wheel"; delta: number; vertical: boolean }
  | { t: "releaseAll" }
  /** Toggle keys (Scroll 1, Num 2, Caps 4): the server's state is set to these. */
  | { t: "sync"; flags: number };

/** Lock keys: pressing one toggles both ends, so the state is read again after. */
const LOCK_CODES = new Set(["NumLock", "CapsLock", "ScrollLock"]);

const STAGE_TEXT: Record<string, string> = {
  tcp: "서버에 연결하는 중...",
  tls: "보안 연결(TLS)을 맺는 중...",
  auth: "인증하는 중 (NLA)...",
};

export class RdpView implements View {
  el: HTMLElement;
  state: ViewState = "connecting";
  private id = "";
  private screen: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private overlay: HTMLElement;
  private desktop = { w: 0, h: 0 };
  private fit = true;
  private queue: Op[] = [];
  private flushPending = false;
  private pendingMove: { x: number; y: number } | null = null;
  private resizeTimer = 0;
  private password: string | null = null;
  private username: string;

  /** Tunnel through the session's SSH gateway, if it has one. */
  private gateway: GatewayLink;

  constructor(
    private session: Session,
    private ws: Workspace,
    private openExternal: (s: Session) => void,
    private openSession: (s: Session) => void,
  ) {
    this.gateway = new GatewayLink(session, 3389);
    const p = PROTOCOLS.rdp;
    this.username = session.username;
    this.el = h(
      "div",
      { class: "view rdp-view" },
      `<div class="view-bar">
         <span class="proto-chip" style="--proto:${p.color}">${icon(p.icon, 14)}${p.label}</span>
         <span class="view-endpoint">${esc(endpoint(session))}</span>
         <span class="view-state" data-state></span>
         <span class="rdp-clip" data-clip hidden></span>
         <div class="view-actions">
           <button class="tool" data-act="cad" title="Ctrl+Alt+Del 보내기">${icon("Keyboard", 15)}<span>Ctrl+Alt+Del</span></button>
           <button class="tool" data-act="win" title="Windows 키 보내기">${icon("AppWindow", 15)}<span>Win</span></button>
           <button class="tool" data-act="type" title="내 클립보드의 텍스트를 원격에 입력">${icon("ClipboardType", 15)}<span>클립보드 입력</span></button>
           <button class="tool clip-state" data-act="clipdiag" title="클립보드 공유 상태 (누르면 진단 기록)">${icon("ClipboardPaste", 15)}<span data-clip-label>클립보드: 준비 중</span></button>
           <button class="tool" data-act="keytest" title="누른 키가 원격에 어떻게 전달되는지 보기 (문제 확인용)">${icon("Keyboard", 15)}<span>키 확인</span></button>
           <span class="tool-sep"></span>
           <button class="tool" data-act="fit" title="창에 맞추기 / 실제 크기">${icon("Maximize2", 15)}<span>맞춤</span></button>
           <button class="tool" data-act="external" title="Windows 원격 데스크톱(mstsc)으로 열기">${icon("ExternalLink", 15)}</button>
           <button class="tool" data-act="ai" title="AI: 화면 설명·캡처·대화">${icon("Sparkles", 15)}<span>AI</span></button>
           <button class="tool" data-act="reconnect" title="다시 연결">${icon("RotateCw", 15)}</button>
         </div>
       </div>
       <div class="rdp-screen"><canvas tabindex="0"></canvas></div>
       <div class="view-overlay" hidden></div>`,
    );
    this.screen = this.el.querySelector(".rdp-screen")!;
    this.canvas = this.el.querySelector("canvas")!;
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;
    this.overlay = this.el.querySelector(".view-overlay")!;
    this.ai = new ViewAi(
      this.el,
      desktopHost({
        key: `rdp:${endpoint(session)}`,
        system: "a Windows computer seen through Remote Desktop (RDP); the engineer can attach screenshots of its screen",
        names: () => [session.host, session.name, session.username],
        canvas: () => (this.desktop.w ? this.canvas : null),
        focus: () => this.canvas.focus(),
      }),
      () => {},
      () => [{ label: "AI가 명령을 실행하도록 SSH 연결…", icon: "SquareTerminal", action: () => void import("../ai/sshSetup").then((m) => m.openSshSetup(this.session, this.openSession)) }],
    );
    this.wireToolbar();
    this.wireInput();
    this.resizer.observe(this.screen);
    this.watchDpi();
    this.syncFit();
    // Not if the tab was closed before the first frame (the helper would be orphaned).
    requestAnimationFrame(() => this.state !== "closed" && this.connect());
  }
  private ai: ViewAi;
  private resizer = new ResizeObserver(() => this.onScreenResize());
  private dpiQuery: MediaQueryList | null = null;
  /** Moving the window to a monitor with another scale changes the pixel
   * size without resizing the tab: follow it like a resize. */
  private watchDpi = () => {
    this.dpiQuery?.removeEventListener("change", this.watchDpi);
    if (this.state === "closed") return;
    this.dpiQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.dpiQuery.addEventListener("change", this.watchDpi);
    this.onScreenResize();
  };

  title() {
    return this.session.name || endpoint(this.session);
  }

  status(): StatusInfo {
    return {
      protocol: "rdp",
      endpoint: endpoint(this.session),
      state: this.state,
      detail: this.desktop.w ? `${this.desktop.w}×${this.desktop.h}` : undefined,
    };
  }

  focus() {
    this.canvas.focus();
  }

  layout() {
    this.applyCanvasSize();
  }

  // ---- connection -----------------------------------------------------------

  /** Requested desktop size: the tab's pixel size and the screen's scale
   * (so a 150% screen gets normal-size text, as with mstsc), or the
   * session's fixed resolution at 100%. */
  private wantedSize(): { width: number; height: number; scale: number | null } {
    const fixed = String(this.session.options.resolution ?? "");
    const [fw, fh] = fixed.split("x").map(Number);
    if (fw && fh) return { width: fw, height: fh, scale: null };
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(640, Math.floor((this.screen.clientWidth * dpr) / 2) * 2);
    const height = Math.max(480, Math.floor(this.screen.clientHeight * dpr));
    const scale = Math.min(500, Math.max(100, Math.round(dpr * 100)));
    return { width, height, scale: scale === 100 ? null : scale };
  }

  private async connect() {
    this.setState("connecting");
    this.showOverlay("progress", STAGE_TEXT.tcp);
    this.id = crypto.randomUUID();
    const id = this.id;
    this.resetClipboard();
    try {
      const tunnelPort = await this.gateway.port();
      if (id !== this.id) return;
      if (tunnelPort === null) return this.fail("SSH 게이트웨이 연결을 취소했습니다.", "closed");
      const frames = await rdpOpen(
        {
          id,
          host: this.session.host,
          port: this.session.port,
          username: this.username,
          domain: (this.session.options.domain as string) || null,
          credentialId: this.session.credentialId,
          password: this.password,
          ...this.wantedSize(),
          tunnelPort: tunnelPort ?? null,
          clipboard: this.session.options.clipboard !== false,
        },
        (e) => id === this.id && this.onEvent(e),
        (buf) => id === this.id && this.onFrame(buf),
        // The channel also closes when the session ends normally: the helper's
        // "closed"/"exit" events come first and decide what is shown then.
        () =>
          setTimeout(() => {
            if (id !== this.id || (this.state !== "connected" && this.state !== "connecting")) return;
            this.fail("화면 전송 채널이 끊어졌습니다. 다시 연결하세요.");
            // Log off the remote session too: it must not stay connected unseen.
            this.frames?.close();
            this.frames = null;
            api.rdpClose(id).catch(() => {});
          }, 500),
      );
      // Tab closed or reconnected while the helper was starting.
      if (id !== this.id) {
        frames.close();
        api.rdpClose(id).catch(() => {});
      } else this.frames = frames;
    } catch (err) {
      if (id !== this.id) return;
      const msg = errorText(err);
      if (msg === "NEED_CREDENTIALS") return this.askCredentials(false);
      this.fail(msg);
    }
  }

  private onEvent(e: RdpEvent) {
    switch (e.type) {
      case "status":
        this.showOverlay("progress", STAGE_TEXT[e.stage] ?? "연결하는 중...");
        break;
      case "cert":
        this.askCertificate(e.fingerprint, e.previous);
        break;
      case "resizeUnsupported":
        this.resizeByReconnect();
        break;
      case "connected":
      case "resized":
        clearTimeout(this.resizeFallback);
        this.setDesktop(e.width, e.height);
        if (e.type === "connected") {
          this.overlay.hidden = true;
          this.setState("connected");
          this.lockFlags = -1;
          this.canvas.focus();
          this.watchClipboard();
          // Connected while in the background: no screen updates until shown.
          if (!this.onScreen) api.rdpVisible(this.id, false).catch(() => {});
          // The tab changed size while connecting (window maximized, sidebar
          // hidden): ask for the new size now rather than at the next resize.
          if (this.sizeDiffers()) this.onScreenResize();
        }
        break;
      case "pointer":
        this.canvas.style.cursor = e.kind === "hidden" ? "none" : "default";
        break;
      case "pointerBitmap":
        this.setPointer(e);
        break;
      case "clipFiles":
        this.clipFiles(e);
        break;
      case "clipboard":
        this.clipboardStep(e.state, e.detail);
        break;
      case "error":
        if (e.kind === "auth") return this.askCredentials(true, e.message);
        if (e.kind === "cancelled") return this.fail(e.message, "closed");
        this.fail(e.message);
        break;
      case "closed":
        this.setState("closed");
        this.showOverlay("closed", e.reason || "원격 데스크톱 연결이 종료되었습니다");
        break;
      case "exit":
        if (this.state === "connecting" || this.state === "connected") {
          const detail = e.detail;
          this.setState(detail ? "error" : "closed");
          this.showOverlay("closed", detail ? `RDP 구성 요소가 비정상 종료되었습니다: ${detail.slice(-300)}` : "원격 데스크톱 연결이 종료되었습니다");
        }
        break;
    }
  }

  /** One screen update: `[desktopW, desktopH, count]`, then per region `[x, y, w, h]` + RGBA rows. */
  /** One update; rdpOpen acknowledges it afterwards, drawn or broken (the
   * helper holds back further updates until then). */
  private onFrame(buf: ArrayBuffer) {
    const v = new DataView(buf);
    const dw = v.getUint16(0, true);
    const dh = v.getUint16(2, true);
    const count = v.getUint16(4, true);
    if (dw !== this.desktop.w || dh !== this.desktop.h) this.setDesktop(dw, dh);
    let at = 6;
    for (let i = 0; i < count && at + 8 <= buf.byteLength; i++) {
      const [x, y, w, hgt] = [0, 2, 4, 6].map((o) => v.getUint16(at + o, true));
      at += 8;
      const size = w * hgt * 4;
      if (!w || !hgt || at + size > buf.byteLength) break;
      this.ctx.putImageData(new ImageData(new Uint8ClampedArray(buf, at, size), w, hgt), x, y);
      at += size;
    }
  }

  /** Files copied on the remote are downloaded for the local paste: show progress. */
  private clipFiles(e: { state: string; done?: number; total?: number; files?: number; message?: string }) {
    const chip = this.el.querySelector<HTMLElement>("[data-clip]")!;
    const mb = (n = 0) => (n / 1024 / 1024).toFixed(n >= 100 * 1024 * 1024 ? 0 : 1);
    if (e.state === "downloading") {
      const pct = e.total ? Math.floor(((e.done ?? 0) / e.total) * 100) : 0;
      chip.hidden = false;
      chip.textContent = `원격 파일 ${e.files ?? ""}개 받는 중 ${pct}% (${mb(e.done)}/${mb(e.total)} MB)`;
    } else if (e.state === "ready") {
      chip.hidden = true;
      // Small copies finish before anyone looks; say so only for real transfers.
      if ((e.total ?? 0) > 20 * 1024 * 1024) toast(`원격 파일 ${e.files}개(${mb(e.total)} MB)를 붙여넣을 수 있습니다`, "success");
    } else if (e.state === "failed") {
      chip.hidden = true;
      toast(`원격 파일을 붙여넣지 못했습니다: ${e.message ?? ""}`, "error", 7000);
    }
  }

  private setDesktop(w: number, h: number) {
    if (w === this.desktop.w && h === this.desktop.h) return;
    this.desktop = { w, h };
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.fillStyle = "#0d1017";
    this.ctx.fillRect(0, 0, w, h);
    this.applyCanvasSize();
    this.ws.changed();
  }

  private setPointer(p: { width: number; height: number; hotX: number; hotY: number; rgba: string }) {
    if (!p.width || !p.height) {
      this.canvas.style.cursor = "none";
      return;
    }
    const bytes = Uint8ClampedArray.from(atob(p.rgba), (c) => c.charCodeAt(0));
    const c = document.createElement("canvas");
    c.width = p.width;
    c.height = p.height;
    c.getContext("2d")!.putImageData(new ImageData(bytes, p.width, p.height), 0, 0);
    this.canvas.style.cursor = `url(${c.toDataURL()}) ${p.hotX} ${p.hotY}, default`;
  }

  private async askCertificate(fingerprint: string, previous: string | null) {
    const changed = !!previous;
    const ok = await confirmDialog({
      title: changed ? "서버 인증서가 바뀌었습니다" : "처음 접속하는 서버",
      icon: changed ? "ShieldAlert" : "ShieldCheck",
      danger: changed,
      message: changed
        ? `<b>${esc(this.session.host)}</b> 서버의 인증서가 이전과 다릅니다.<br><br>
           이전: <code class="fp">${esc(previous)}</code><br>새 인증서: <code class="fp">${esc(fingerprint)}</code><br><br>
           Windows의 RDP 자체 서명 인증서는 주기적으로 갱신되기도 하지만, 중간자 공격일 수도 있습니다.
           서버에서 인증서를 교체한 것이 확실할 때만 계속하세요.`
        : `<b>${esc(this.session.host)}</b> 서버의 인증서를 아직 신뢰한 적이 없습니다.<br><br>
           공개 키 지문: <code class="fp">${esc(fingerprint)}</code><br><br>
           서버 관리자가 알려 준 지문과 같은지 확인하세요. 신뢰하면 다음부터는 묻지 않습니다.`,
      confirm: changed ? "새 인증서 신뢰" : "신뢰하고 연결",
    });
    api.rdpCert(this.id, ok).catch((err) => this.fail(`인증서를 저장하지 못해 연결을 중단했습니다: ${errorText(err)}`));
  }

  private askCredentials(retry: boolean, detail = "") {
    let submitted = false;
    const m = modal({
      title: retry ? "로그인하지 못했습니다" : "원격 데스크톱 로그인",
      icon: "KeyRound",
      body: `<form class="form" autocomplete="off">
          ${retry ? `<p class="modal-text danger-text">${esc(detail)}</p>` : ""}
          <label class="field"><span>사용자 이름 (도메인 계정은 DOMAIN\\사용자)</span>
            <input name="user" value="${esc(this.username)}" spellcheck="false" /></label>
          <label class="field"><span>비밀번호</span><input name="pass" type="password" /></label>
          <label class="check"><input type="checkbox" name="save" /> 자격 증명 보관함에 저장하고 이 세션에 연결</label>
        </form>`,
      footer: `<button class="btn" data-close>취소</button><button class="btn btn-primary" data-ok>${icon("Play", 14)}연결</button>`,
      onClose: () => {
        if (!submitted) this.fail("로그인을 취소했습니다", "closed");
      },
    });
    const form = m.root.querySelector("form")!;
    if (this.username) setTimeout(() => form.querySelector<HTMLInputElement>("[name=pass]")?.focus(), 50);
    const submit = async () => {
      const get = (n: string) => form.querySelector<HTMLInputElement>(`[name=${n}]`)!;
      this.username = get("user").value.trim();
      this.password = get("pass").value;
      if (!this.username || !this.password) return toast("사용자 이름과 비밀번호를 입력하세요", "warn");
      submitted = true;
      if (get("save").checked) await this.saveCredential();
      m.close();
      this.cleanup();
      this.connect();
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submit();
    });
    m.root.querySelector("[data-ok]")!.addEventListener("click", submit);
  }

  private async saveCredential() {
    try {
      const cred = await api.vaultSave(
        { id: crypto.randomUUID(), name: `${this.username}@${this.session.host}`, username: this.username, kind: "password", keyPath: null, hasSecret: false },
        this.password,
      );
      await reloadCredentials();
      this.session.credentialId = cred.id;
      this.session.username = this.username;
      await patchSession(this.session.id, { credentialId: cred.id, username: this.username });
      toast("자격 증명을 저장했습니다", "success");
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  private setState(s: ViewState) {
    this.state = s;
    const label: Record<ViewState, string> = { connecting: "연결 중", connected: "연결됨", closed: "끊김", error: "오류" };
    const el = this.el.querySelector<HTMLElement>("[data-state]")!;
    el.textContent = label[s];
    el.dataset.state = s;
    this.ws.changed();
  }

  private fail(msg: string, state: ViewState = "error") {
    this.setState(state);
    this.showOverlay("closed", msg);
  }

  private showOverlay(kind: "progress" | "closed", text: string) {
    this.overlay.hidden = false;
    if (kind === "progress") {
      this.overlay.innerHTML = `<div class="overlay-card"><div class="spinner"></div><h3>${esc(endpoint(this.session))}</h3><p>${esc(text)}</p></div>`;
      return;
    }
    this.overlay.innerHTML = `<div class="overlay-card">${icon(this.state === "error" ? "WifiOff" : "Unlink", 26)}
      <h3>${esc(text)}</h3>
      <div class="row"><button class="btn btn-primary" data-o="re">${icon("RotateCw", 15)}다시 연결</button>
      <button class="btn" data-o="ext">${icon("ExternalLink", 15)}mstsc로 열기</button></div></div>`;
    this.overlay.querySelector('[data-o="re"]')!.addEventListener("click", () => this.reconnect());
    this.overlay.querySelector('[data-o="ext"]')!.addEventListener("click", () => this.openExternal(this.session));
  }

  reconnect() {
    this.cleanup();
    this.connect();
  }

  // ---- display ----------------------------------------------------------------

  private syncFit() {
    this.el.querySelector('[data-act="fit"]')!.classList.toggle("on", this.fit);
    this.screen.classList.toggle("actual", !this.fit);
    this.applyCanvasSize();
  }

  private applyCanvasSize() {
    const { w, h } = this.desktop;
    if (!w || !h) return;
    if (!this.fit) {
      this.canvas.style.width = `${w / (window.devicePixelRatio || 1)}px`;
      this.canvas.style.height = `${h / (window.devicePixelRatio || 1)}px`;
      return;
    }
    const scale = Math.min(this.screen.clientWidth / w, this.screen.clientHeight / h);
    this.canvas.style.width = `${Math.floor(w * scale)}px`;
    this.canvas.style.height = `${Math.floor(h * scale)}px`;
  }

  /** Follow the tab's size with the remote resolution: live through Display
   * Control when the server supports it, otherwise by reconnecting at the new
   * size (what mstsc does with such servers). */
  private onScreenResize() {
    // A tab parked off-screen measures 0×0; that is not a request to shrink
    // the remote desktop.
    if (!this.el.isConnected || this.screen.clientWidth === 0 || this.screen.clientHeight === 0) return;
    this.applyCanvasSize();
    if (this.state !== "connected" || this.session.options.resolution) return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      if (!this.sizeDiffers()) return;
      const { width, height, scale } = this.wantedSize();
      api.rdpResize(this.id, width, height, scale).catch(() => {});
      // No "resized" from the server in time: it ignored the request.
      clearTimeout(this.resizeFallback);
      this.resizeFallback = window.setTimeout(() => this.resizeByReconnect(), 3000);
    }, 500);
  }

  private resizeFallback = 0;
  /** Size last reconnected for, so a server that keeps its own size is not reconnected forever. */
  private reconnectedFor = "";

  private sizeDiffers() {
    const { width, height } = this.wantedSize();
    return Math.abs(width - this.desktop.w) > 8 || Math.abs(height - this.desktop.h) > 8;
  }

  private resizeByReconnect() {
    clearTimeout(this.resizeFallback);
    if (this.state !== "connected" || !this.sizeDiffers()) return;
    const { width, height } = this.wantedSize();
    const key = `${width}x${height}`;
    if (this.reconnectedFor === key) return;
    this.reconnectedFor = key;
    toast(`원격 컴퓨터가 실시간 해상도 변경을 지원하지 않아 ${width}×${height}로 다시 연결합니다`, "info");
    this.reconnect();
  }

  // ---- input ------------------------------------------------------------------

  /** Keys, buttons and the wheel go out at once (like mstsc); bare pointer
   * moves are merged and sent once per frame. A move still waiting is sent
   * before the ops that came after it, so a click lands where it happened. */
  private send(...ops: Op[]) {
    if (this.state !== "connected") return;
    if (ops.length) {
      this.takeMove();
      this.queue.push(...ops);
      if (!this.flushSoon) {
        this.flushSoon = true;
        queueMicrotask(() => {
          this.flushSoon = false;
          this.flush();
        });
      }
      return;
    }
    if (this.flushPending) return;
    this.flushPending = true;
    requestAnimationFrame(() => {
      this.flushPending = false;
      this.flush();
    });
  }
  private flushSoon = false;

  private takeMove() {
    if (!this.pendingMove) return;
    this.queue.push({ t: "move", ...this.pendingMove });
    this.pendingMove = null;
  }

  private flush() {
    this.takeMove();
    const ops = this.queue.splice(0);
    if (ops.length) api.rdpInput(this.id, ops).catch(() => {});
  }

  private point(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) * this.canvas.width) / r.width);
    const y = Math.round(((e.clientY - r.top) * this.canvas.height) / r.height);
    return {
      x: Math.max(0, Math.min(this.canvas.width - 1, x)),
      y: Math.max(0, Math.min(this.canvas.height - 1, y)),
    };
  }

  /** Last toggle-key state sent to the server (-1: unknown, send at the next event). */
  private lockFlags = -1;

  /** Make the server's Num/Caps/Scroll Lock match this keyboard. Without it the
   * server keeps its own state (often Num Lock off at the logon screen) and the
   * number pad types nothing until Num Lock is pressed twice. */
  private syncLocks(e: KeyboardEvent | MouseEvent, force = false) {
    const flags = (e.getModifierState("ScrollLock") ? 1 : 0) | (e.getModifierState("NumLock") ? 2 : 0) | (e.getModifierState("CapsLock") ? 4 : 0);
    if (this.state !== "connected" || (!force && flags === this.lockFlags)) return;
    this.lockFlags = flags;
    this.send({ t: "sync", flags });
  }

  private wireInput() {
    const c = this.canvas;
    c.addEventListener("keydown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (LOCK_CODES.has(e.code)) this.lockFlags = -1;
      // Number pad keys depend on Num Lock: confirm it every time (the server
      // may change its own state, e.g. when the logon screen hands over).
      else this.syncLocks(e, e.code.startsWith("Numpad") && !e.repeat);
      const sc = scancodeFor(e);
      this.noteKey(e, sc ? `스캔코드 0x${sc[0].toString(16)}${sc[1] ? " (확장)" : ""}` : namedKeyFor(e) ? "이름 키" : [...e.key].length === 1 ? "유니코드 문자" : "보내지 않음");
      if (!sc) {
        // Text without a physical key: Chrome Remote Desktop text events,
        // on-screen and phone keyboards (SendInput KEYEVENTF_UNICODE, VK_PACKET)
        // arrive with an empty code. Type the character itself; the matching
        // keyup says "Unidentified", so press and release it here.
        const named = namedKeyFor(e);
        if (named) return this.keyCombo([named[0], named[1]]);
        const ch = [...e.key];
        if (ch.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          this.send({ t: "unicode", ch: e.key, down: true }, { t: "unicode", ch: e.key, down: false });
        }
        return;
      }
      if (e.repeat && MODIFIER_CODES.has(e.code)) return;
      this.send({ t: "key", code: sc[0], ext: sc[1], down: true, repeat: e.repeat });
    });
    c.addEventListener("keyup", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sc = scancodeFor(e);
      this.noteKey(e, sc ? `떼기 0x${sc[0].toString(16)}${sc[1] ? " (확장)" : ""}` : "보내지 않음");
      if (sc) this.send({ t: "key", code: sc[0], ext: sc[1], down: false });
    });
    // Avoid stuck modifiers when focus leaves the remote screen.
    c.addEventListener("blur", () => this.send({ t: "releaseAll" }));
    // Lock keys may have been toggled in another window meanwhile.
    c.addEventListener("focus", () => (this.lockFlags = -1));
    c.addEventListener("pointermove", (e) => {
      this.syncLocks(e);
      this.pendingMove = this.point(e);
      this.send();
    });
    // Pointer capture keeps move/up events coming while a button is held, so a
    // drag released outside the canvas still releases the button remotely.
    c.addEventListener("pointerdown", (e) => {
      c.focus();
      e.preventDefault();
      this.syncLocks(e);
      c.setPointerCapture(e.pointerId);
      this.send({ t: "move", ...this.point(e) }, { t: "button", b: e.button, down: true });
    });
    c.addEventListener("pointerup", (e) => {
      e.preventDefault();
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      this.send({ t: "move", ...this.point(e) }, { t: "button", b: e.button, down: false });
    });
    c.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
        const raw = vertical ? -e.deltaY : e.deltaX;
        if (!raw) return;
        // One notch (≈100px or 3 lines) maps to the standard 120 units.
        const units = e.deltaMode === 1 ? raw * 40 : raw * 1.2;
        const delta = Math.max(-255, Math.min(255, Math.round(units)));
        this.send({ t: "wheel", delta, vertical });
      },
      { passive: false },
    );
  }

  private keyCombo(...keys: [number, boolean][]) {
    const down = keys.map(([code, ext]) => ({ t: "key" as const, code, ext, down: true }));
    const up = [...keys].reverse().map(([code, ext]) => ({ t: "key" as const, code, ext, down: false }));
    this.send(...down, ...up);
  }

  private async typeClipboard() {
    const text = (await readClipboard()).replace(/\r\n?/g, "\n");
    // Types text only: images and files go through the shared clipboard instead.
    if (!text) return toast("클립보드에 입력할 텍스트가 없습니다. 이미지·파일은 원격 화면을 클릭한 뒤 Ctrl+V로 붙여넣으세요.", "warn", 5000);
    if (text.length > 4000) return toast("클립보드 텍스트가 너무 깁니다 (4000자 이하)", "warn");
    const ops: Op[] = [];
    for (const ch of text) {
      if (ch === "\n") ops.push({ t: "key", code: KEY.enter[0], ext: false, down: true }, { t: "key", code: KEY.enter[0], ext: false, down: false });
      else if (ch === "\t") ops.push({ t: "key", code: KEY.tab[0], ext: false, down: true }, { t: "key", code: KEY.tab[0], ext: false, down: false });
      else ops.push({ t: "unicode", ch, down: true }, { t: "unicode", ch, down: false });
    }
    for (let i = 0; i < ops.length; i += 200) await api.rdpInput(this.id, ops.slice(i, i + 200)).catch(() => {});
    this.canvas.focus();
    toast(`${[...text].length}자를 원격에 입력했습니다`, "success");
  }

  // ---- clipboard sharing status ----------------------------------------------------------

  /** Steps of this connection's clipboard channel, for the diagnostic log. */
  private clipLog: { at: number; state: string; detail: string }[] = [];
  private clipState: "starting" | "ready" | "noResponse" | "error" | "unavailable" = "starting";
  private clipTimer = 0;

  private resetClipboard() {
    clearTimeout(this.clipTimer);
    this.clipLog = [];
    this.clipState = "starting";
    this.renderClipboard();
  }

  private clipboardStep(state: string, detail: string) {
    this.clipLog.push({ at: Date.now(), state, detail });
    if (this.clipLog.length > 200) this.clipLog.splice(0, this.clipLog.length - 200);
    if (state === "ready") this.clipState = "ready";
    else if (state === "rejected") this.clipState = "error";
    else if (state === "unavailable") this.clipState = "unavailable";
    this.renderClipboard();
  }

  /** The server's clipboard program announces itself within seconds of the
   * desktop; without it nothing can be pasted either way. Said once. */
  private watchClipboard() {
    clearTimeout(this.clipTimer);
    const id = this.id;
    this.clipTimer = window.setTimeout(() => {
      if (id !== this.id || this.clipState !== "starting") return;
      this.clipState = "noResponse";
      this.clipLog.push({ at: Date.now(), state: "noResponse", detail: "no Monitor Ready from the server within 20 s" });
      this.renderClipboard();
      toast("원격 PC의 클립보드가 응답하지 않아 복사·붙여넣기를 할 수 없습니다. 툴바의 클립보드 상태를 눌러 해결 방법을 확인하세요.", "warn", 8000);
    }, 20000);
  }

  private renderClipboard() {
    const label = this.el.querySelector<HTMLElement>("[data-clip-label]");
    const button = this.el.querySelector<HTMLElement>('[data-act="clipdiag"]');
    if (!label || !button) return;
    const text = {
      starting: "클립보드: 준비 중",
      ready: "클립보드: 연결됨",
      noResponse: "클립보드: 응답 없음",
      error: "클립보드: 오류",
      unavailable: "클립보드: 사용 불가",
    }[this.clipState];
    // An icon and a coloured dot in the toolbar; the words in the tooltip.
    label.textContent = text;
    button.title = tr(`${text} · 누르면 진단 기록`);
    button.classList.toggle("warn", this.clipState === "noResponse" || this.clipState === "error" || this.clipState === "unavailable");
    button.classList.toggle("ok", this.clipState === "ready");
  }

  private showClipboardLog() {
    const time = (t: number) => new Date(t).toTimeString().slice(0, 8);
    const text = this.clipLog.map((l) => `${time(l.at)}  ${l.state.padEnd(13)} ${l.detail}`).join("\n") || tr("(기록 없음: 서버가 클립보드 채널을 열지 않았습니다)");
    const hint =
      this.clipState === "ready"
        ? "클립보드가 연결되어 있습니다. 붙여넣기가 안 되면 원격에서 붙여넣을 때 기록에 pasteRequest가 생기는지 확인하세요."
        : "원격 PC의 클립보드 프로그램(rdpclip.exe)이 응답하지 않거나, 원격 PC가 클립보드 공유를 막고 있습니다. 원격에서 작업 관리자로 rdpclip.exe를 끝낸 다음 Win+R에 rdpclip을 입력해 다시 실행하면 대부분 해결됩니다. mstsc로 열어도 안 되면 원격 PC의 정책(클립보드 리디렉션)을 확인하세요.";
    const m = modal({
      title: "클립보드 공유 상태",
      icon: "ClipboardPaste",
      width: 640,
      body: `<p class="modal-text">${esc(hint)}</p>
        <pre class="clip-log" data-i18n-skip>${esc(text)}</pre>`,
      footer: `<button class="btn" data-copy>${icon("Copy", 14)}기록 복사</button><button class="btn btn-primary" data-close>닫기</button>`,
    });
    m.root.querySelector("[data-copy]")!.addEventListener("click", async () => {
      await writeClipboard(`BananaConn RDP clipboard log · ${this.session.host}\n${text}`);
      toast("기록을 복사했습니다", "success", 2000);
    });
  }

  /** Key check: the last keys pressed on the remote screen and what was sent
   * for them (to see, for example, whether Right Shift arrives at all). */
  private keyLog: HTMLElement | null = null;
  private toggleKeyTest() {
    if (this.keyLog) {
      this.keyLog.remove();
      this.keyLog = null;
    } else {
      this.keyLog = h("div", { class: "rdp-keylog" }, "<b>키 확인</b>: 원격 화면을 누른 뒤 키를 눌러 보세요");
      this.screen.appendChild(this.keyLog);
    }
    this.el.querySelector('[data-act="keytest"]')!.classList.toggle("on", !!this.keyLog);
    this.canvas.focus();
  }

  private noteKey(e: KeyboardEvent, sent: string) {
    if (!this.keyLog) return;
    const side = ["", " 왼쪽", " 오른쪽", " 숫자패드"][e.location] ?? "";
    const row = h("div", {}, `${e.type === "keydown" ? "↓" : "↑"} ${esc(e.code || "(코드 없음)")} · ${esc(e.key)}${side} → ${esc(sent)}`);
    this.keyLog.appendChild(row);
    while (this.keyLog.children.length > 13) this.keyLog.children[1].remove();
  }

  private wireToolbar() {
    this.el.querySelector(".view-actions")!.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "cad") this.keyCombo(KEY.ctrl, KEY.alt, KEY.del);
      if (act === "win") this.keyCombo(KEY.win);
      if (act === "type") this.typeClipboard();
      if (act === "keytest") this.toggleKeyTest();
      if (act === "clipdiag") this.showClipboardLog();
      if (act === "fit") {
        this.fit = !this.fit;
        this.syncFit();
      }
      if (act === "external") this.openExternal(this.session);
      if (act === "reconnect") this.reconnect();
      if (act === "ai") return this.ai.menu(this.el.querySelector<HTMLElement>('[data-act="ai"]')!);
      if (act !== "type") this.canvas.focus();
    });
  }

  private frames: RdpFrames | null = null;

  /** On screen, as the workspace last reported (false while minimised). */
  private onScreen = true;

  /** Off screen the helper keeps the image current but sends nothing to draw;
   * back on screen it sends the whole screen once. */
  shownChanged(shown: boolean) {
    this.onScreen = shown;
    if (this.id && this.state === "connected") api.rdpVisible(this.id, shown).catch(() => {});
  }

  private cleanup() {
    clearTimeout(this.clipTimer);
    this.frames?.close();
    this.frames = null;
    if (this.id) api.rdpClose(this.id).catch(() => {});
    this.id = "";
    this.desktop = { w: 0, h: 0 };
  }

  dispose() {
    this.ai.dispose();
    this.state = "closed";
    this.resizer.disconnect();
    this.dpiQuery?.removeEventListener("change", this.watchDpi);
    this.cleanup();
    this.gateway.close();
  }
}
