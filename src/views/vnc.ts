// Built-in VNC viewer: noVNC rendering into the tab, connected through the
// backend's loopback WebSocket relay.

import RFB from "@novnc/novnc";
import { api } from "../api";
import { readClipboard, writeClipboard } from "../clipboard";
import { icon } from "../icons";
import { endpoint, PROTOCOLS, type Session } from "../model";
import { contextMenu, errorText, esc, h, promptDialog, toast } from "../ui";
import { patchSession, state } from "../store";

type Quality = "fast" | "balanced" | "sharp";
/** [JPEG quality, zlib compression] asked of the server. */
/** Speed first by default: blocky JPEG and strong compression send far less. */
const QUALITY: Record<Quality, [number, number]> = { fast: [2, 6], balanced: [6, 2], sharp: [8, 1] };
const ENCODING_NAMES: Record<number, string> = {
  0: "Raw (무압축)", 1: "CopyRect", 2: "RRE", 5: "Hextile", 6: "Zlib", 7: "Tight", 16: "ZRLE", 21: "JPEG", 50: "H.264", [-260]: "TightPNG",
};
import { GatewayLink } from "../tunnels";
import { desktopHost, ViewAi } from "../ai/viewAi";
import type { StatusInfo, View, ViewState, Workspace } from "../workspace";

export class VncView implements View {
  el: HTMLElement;
  state: ViewState = "connecting";
  private rfb: RFB | null = null;
  private proxyId = crypto.randomUUID();
  private screen: HTMLElement;
  private overlay: HTMLElement;
  private desktopName = "";
  private scale: boolean;
  private viewOnly: boolean;
  private disposed = false;
  private ai: ViewAi;
  /** The last attempt failed authentication. */
  private authFailed = false;
  /** A refusal the server explained (not a wrong password). */
  private securityReason = "";
  /** Prompt for the password even if a credential is stored. */
  private askPassword = false;

  /** Tunnel through the session's SSH gateway, if it has one. */
  private gateway: GatewayLink;

  constructor(
    private session: Session,
    private ws: Workspace,
  ) {
    this.gateway = new GatewayLink(session, 5900);
    const p = PROTOCOLS.vnc;
    this.scale = session.options.scale !== false;
    this.viewOnly = !!session.options.viewOnly;
    this.el = h(
      "div",
      { class: "view vnc-view" },
      `<div class="view-bar">
         <span class="proto-chip" style="--proto:${p.color}">${icon(p.icon, 14)}${p.label}</span>
         <span class="view-endpoint">${esc(endpoint(session))}</span>
         <span class="view-state" data-state></span>
         <div class="view-actions">
           <button class="tool" data-act="scale" title="창 크기에 맞추기">${icon("Maximize2", 15)}<span>맞춤</span></button>
           <button class="tool" data-act="viewonly" title="보기 전용 (입력 차단)">${icon("Eye", 15)}<span>보기 전용</span></button>
           <span class="tool-sep"></span>
           <button class="tool" data-act="paste" title="내 클립보드 내용을 원격으로 보내기">${icon("Copy", 15)}<span>클립보드 보내기</span></button>
           <button class="tool" data-act="cad" title="Ctrl+Alt+Del 보내기">${icon("Keyboard", 15)}<span>Ctrl+Alt+Del</span></button>
           <button class="tool" data-act="quality" title="화질과 속도 (JPEG 화질·압축)">${icon("Sparkles", 15)}<span data-quality-label></span></button>
           <button class="tool" data-act="stats" title="전송 상태: 서버가 쓰는 인코딩, 초당 갱신, 받는 양">${icon("Activity", 15)}<span>상태</span></button>
           <button class="tool" data-act="ai" title="AI: 화면 설명·캡처·대화">${icon("Sparkles", 15)}<span>AI</span></button>
           <button class="tool" data-act="reconnect" title="다시 연결">${icon("RotateCw", 15)}</button>
         </div>
       </div>
       <div class="vnc-screen"></div>
       <div class="view-overlay" hidden></div>`,
    );
    this.screen = this.el.querySelector(".vnc-screen")!;
    this.ai = new ViewAi(
      this.el,
      desktopHost({
        system: "a computer seen through VNC; the engineer can attach screenshots of its screen",
        names: () => [session.host, session.name, session.username, this.desktopName],
        canvas: () => this.screen.querySelector("canvas"),
        focus: () => this.rfb?.focus(),
      }),
      () => {},
    );
    this.overlay = this.el.querySelector(".view-overlay")!;
    this.el.querySelector(".view-actions")!.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "scale") this.setScale(!this.scale);
      if (act === "viewonly") this.setViewOnly(!this.viewOnly);
      if (act === "ai") return this.ai.menu(this.el.querySelector<HTMLElement>('[data-act="ai"]')!);
      if (act === "cad") this.rfb?.sendCtrlAltDel();
      if (act === "paste") this.pasteClipboard();
      if (act === "reconnect") this.reconnect();
      if (act === "quality") this.qualityMenu();
      if (act === "stats") this.toggleStats();
    });
    this.syncToggles();
    this.applyQuality();
    this.connect();
  }

  title() {
    return this.session.name || this.desktopName || endpoint(this.session);
  }

  // ---- quality ------------------------------------------------------------------------

  private get quality(): Quality {
    const q = this.session.options.vncQuality;
    return q === "balanced" || q === "sharp" ? q : "fast";
  }

  /** JPEG quality (0-9) and zlib compression (0-9) the server is asked for:
   * lower quality and more compression for slow links, the reverse on a LAN
   * (less work for both ends). Applies at once to a running connection. */
  private applyQuality(rfb: RFB | null = this.rfb) {
    const [quality, compression] = QUALITY[this.quality];
    if (rfb) {
      rfb.qualityLevel = quality;
      rfb.compressionLevel = compression;
    }
    const label = this.el.querySelector<HTMLElement>("[data-quality-label]");
    if (label) label.textContent = { fast: "화질: 빠르게", balanced: "화질: 보통", sharp: "화질: 선명" }[this.quality];
  }

  private qualityMenu() {
    const r = this.el.querySelector<HTMLElement>('[data-act="quality"]')!.getBoundingClientRect();
    const item = (q: Quality, label: string) => ({
      label,
      icon: this.quality === q ? "Check" : "Circle",
      action: () => {
        this.session.options.vncQuality = q;
        if (!this.session.id.startsWith("quick-")) patchSession(this.session.id, {}, { vncQuality: q }).catch(() => {});
        this.applyQuality();
      },
    });
    contextMenu(r.left, r.bottom + 4, [
      item("fast", "빠르게 (기본): 색·화질을 낮추고 최대한 압축"),
      item("balanced", "보통"),
      item("sharp", "선명하게: 압축을 줄여 사내망에서 빠르게"),
    ]);
  }

  // ---- status view --------------------------------------------------------------------

  /** Rectangles drawn per encoding (noVNC's decoders, counted as they finish). */
  private rects = new Map<number, number>();

  private countRects(rfb: RFB) {
    const decoders = (rfb as unknown as { _decoders?: Record<string, { decodeRect: (...a: unknown[]) => boolean }> })._decoders;
    if (!decoders) return;
    for (const [enc, decoder] of Object.entries(decoders)) {
      const decode = decoder.decodeRect.bind(decoder);
      decoder.decodeRect = (...args: unknown[]) => {
        const done = decode(...args);
        if (done) this.rects.set(Number(enc), (this.rects.get(Number(enc)) ?? 0) + 1);
        return done;
      };
    }
  }

  private statsBox: HTMLElement | null = null;
  private statsTimer = 0;

  private toggleStats() {
    if (this.statsBox) {
      clearInterval(this.statsTimer);
      this.statsBox.remove();
      this.statsBox = null;
    } else {
      this.statsBox = h("div", { class: "rdp-keylog" }, "<b>전송 상태</b>: 측정 중…");
      this.screen.appendChild(this.statsBox);
      let lastBytes = -1;
      let lastRects = new Map(this.rects);
      const tick = async () => {
        const bytes = await api.vncProxyStats(this.proxyId).catch(() => 0);
        const box = this.statsBox;
        if (!box) return;
        const rate = lastBytes < 0 ? 0 : (bytes - lastBytes) / 1024;
        lastBytes = bytes;
        const parts = [...this.rects].map(([enc, n]) => {
          const per = n - (lastRects.get(enc) ?? 0);
          return `${ENCODING_NAMES[enc] ?? enc} ${per}/초 (누적 ${n})`;
        });
        lastRects = new Map(this.rects);
        box.innerHTML = `<b>전송 상태</b><div>받는 양: ${rate >= 1024 ? (rate / 1024).toFixed(1) + " MB" : rate.toFixed(0) + " KB"}/초 · 화질 ${QUALITY[this.quality].join("/")}</div><div>인코딩별 갱신: ${esc(parts.join(" · ") || "아직 없음")}</div>`;
      };
      tick();
      this.statsTimer = window.setInterval(tick, 1000);
    }
    this.el.querySelector('[data-act="stats"]')!.classList.toggle("on", !!this.statsBox);
  }

  status(): StatusInfo {
    return { protocol: "vnc", endpoint: endpoint(this.session), state: this.state, detail: this.desktopName };
  }

  focus() {
    this.rfb?.focus();
  }

  private setState(s: ViewState) {
    this.state = s;
    const label: Record<ViewState, string> = { connecting: "연결 중", connected: "연결됨", closed: "끊김", error: "오류" };
    const el = this.el.querySelector<HTMLElement>("[data-state]")!;
    el.textContent = label[s];
    el.dataset.state = s;
    this.ws.changed();
  }

  private async connect() {
    this.setState("connecting");
    this.authFailed = false;
    this.securityReason = "";
    this.overlay.hidden = false;
    this.overlay.innerHTML = `<div class="overlay-card"><div class="spinner"></div><h3>${esc(endpoint(this.session))}</h3><p>VNC 서버에 연결하는 중...</p></div>`;
    const proxyId = this.proxyId;
    try {
      const tunnelPort = await this.gateway.port();
      if (this.disposed || proxyId !== this.proxyId) return;
      if (tunnelPort === null) return this.fail("SSH 게이트웨이 연결을 취소했습니다.");
      const { url } = tunnelPort
        ? await api.vncProxyStart(proxyId, "127.0.0.1", tunnelPort)
        : await api.vncProxyStart(proxyId, this.session.host, this.session.port ?? 5900);
      // Closed or reconnected while the relay was starting.
      if (this.disposed || proxyId !== this.proxyId) {
        api.vncProxyStop(proxyId).catch(() => {});
        return;
      }
      const rfb = new RFB(this.screen, url, { wsProtocols: ["binary"], shared: true });
      // Events from a replaced connection must not touch the current one.
      const live = () => this.rfb === rfb;
      rfb.scaleViewport = this.scale;
      rfb.clipViewport = !this.scale;
      rfb.viewOnly = this.viewOnly;
      rfb.focusOnClick = true;
      rfb.background = "#0d1017";
      this.applyQuality(rfb);
      this.countRects(rfb);
      rfb.addEventListener("connect", () => {
        if (!live()) return;
        this.overlay.hidden = true;
        this.setState("connected");
      });
      rfb.addEventListener("disconnect", (e: Event) => {
        if (!live()) return;
        const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean;
        if (this.state === "connecting" && this.authFailed)
          this.fail("VNC 비밀번호가 올바르지 않습니다. 다시 시도하면 비밀번호를 새로 묻습니다.");
        else if (this.state === "connecting") {
          // The relay knows why the server could not be reached (refused,
          // no answer, unknown host); noVNC only sees the socket close.
          const id = this.proxyId;
          void api
            .vncProxyError(id)
            .catch(() => null)
            .then((why) => {
              if (!live() || id !== this.proxyId) return;
              const detail = this.securityReason ? `VNC 서버가 연결을 거부했습니다: ${this.securityReason}` : why;
              this.fail(detail || "VNC 서버에 연결하지 못했습니다. 호스트와 포트를 확인하세요.");
            });
        }
        else {
          this.setState("closed");
          this.showClosed(clean ? "연결이 종료되었습니다" : "연결이 예기치 않게 끊어졌습니다");
        }
      });
      rfb.addEventListener("credentialsrequired", (e: Event) => live() && this.provideCredentials(e as CustomEvent<{ types: string[] }>));
      rfb.addEventListener("securityfailure", (e: Event) => {
        if (!live()) return;
        const reason = (e as CustomEvent<{ reason?: string }>).detail?.reason;
        // A refusal for another reason ("Too many security failures", an
        // unsupported security type) is not a wrong password: say what the
        // server said and keep the stored password.
        if (reason && /too many|unsupported|not supported|no matching|blacklist/i.test(reason)) {
          this.securityReason = reason;
          return;
        }
        // The stored password is wrong: ask on the next attempt instead of
        // reusing it forever.
        this.authFailed = true;
        this.askPassword = true;
        toast(`VNC 인증에 실패했습니다${reason ? `: ${reason}` : ""}`, "error");
      });
      rfb.addEventListener("desktopname", (e: Event) => {
        if (!live()) return;
        this.desktopName = (e as CustomEvent<{ name: string }>).detail.name;
        this.ws.changed();
      });
      rfb.addEventListener("clipboard", (e: Event) => writeClipboard((e as CustomEvent<{ text: string }>).detail.text));
      this.rfb = rfb;
    } catch (err) {
      if (this.disposed || proxyId !== this.proxyId) return;
      this.fail(errorText(err));
    }
  }

  private async provideCredentials(e: CustomEvent<{ types: string[] }>) {
    const types = e.detail?.types ?? ["password"];
    // macOS Screen Sharing, VeNCrypt Plain and UltraVNC MS-Logon also want a
    // user name: the session's, else the stored credential's, else ask.
    let username = "";
    if (types.includes("username")) {
      username = this.session.username || state.credentials.find((c) => c.id === this.session.credentialId)?.username || "";
      if (!username) {
        const res = await promptDialog({ title: "VNC 사용자 이름", label: `${this.session.host} 의 사용자 이름`, icon: "User", confirm: "다음" });
        if (!res) {
          this.rfb?.disconnect();
          return;
        }
        username = res.value.trim();
      }
    }
    let password: string | null = null;
    if (this.session.credentialId && !this.askPassword) {
      try {
        password = await api.vaultReveal(this.session.credentialId);
      } catch {
        password = null;
      }
    }
    if (password === null) {
      const res = await promptDialog({
        title: "VNC 비밀번호",
        label: `${this.session.host} 의 VNC 비밀번호`,
        type: "password",
        icon: "KeyRound",
        confirm: "연결",
      });
      if (!res) {
        this.rfb?.disconnect();
        return;
      }
      password = res.value;
    }
    const creds: { username?: string; password: string; target?: string } = { password };
    if (types.includes("username")) creds.username = username;
    if (types.includes("target")) creds.target = "";
    this.rfb?.sendCredentials(creds);
  }

  private fail(msg: string) {
    this.setState("error");
    this.showClosed(msg);
  }

  private showClosed(msg: string) {
    this.overlay.hidden = false;
    this.overlay.innerHTML = `<div class="overlay-card">${icon("WifiOff", 26)}<h3>${esc(msg)}</h3>
      <div class="row"><button class="btn btn-primary" data-o="re">${icon("RotateCw", 15)}다시 연결</button></div></div>`;
    this.overlay.querySelector('[data-o="re"]')!.addEventListener("click", () => this.reconnect());
  }

  private setScale(on: boolean) {
    this.scale = on;
    if (this.rfb) {
      this.rfb.scaleViewport = on;
      this.rfb.clipViewport = !on;
    }
    this.syncToggles();
  }

  private setViewOnly(on: boolean) {
    this.viewOnly = on;
    if (this.rfb) this.rfb.viewOnly = on;
    this.syncToggles();
  }

  private syncToggles() {
    this.el.querySelector('[data-act="scale"]')!.classList.toggle("on", this.scale);
    this.el.querySelector('[data-act="viewonly"]')!.classList.toggle("on", this.viewOnly);
  }

  private async pasteClipboard() {
    const text = await readClipboard();
    if (!text) return toast("클립보드가 비어 있습니다", "warn");
    this.rfb?.clipboardPasteFrom(text);
    toast("클립보드 내용을 원격 컴퓨터로 보냈습니다. 원격에서 붙여넣기 하세요.", "success");
  }

  reconnect() {
    this.teardown();
    this.proxyId = crypto.randomUUID();
    this.connect();
  }

  private teardown() {
    try {
      this.rfb?.disconnect();
    } catch {
      /* already closed */
    }
    this.rfb = null;
    this.screen.innerHTML = "";
    api.vncProxyStop(this.proxyId).catch(() => {});
  }

  dispose() {
    this.ai.dispose();
    this.disposed = true;
    clearInterval(this.statsTimer);
    this.state = "closed";
    this.teardown();
    this.gateway.close();
  }
}
