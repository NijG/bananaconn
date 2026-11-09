// SSH tunnels: the "SSH gateway" option of RDP/VNC/Telnet sessions and the
// tunnel manager (saved local port forwards started on demand). The backend
// (tunnel.rs) does the forwarding in-process; this module handles the login
// dialogs (host key, password) and the saved tunnel list.

import { api, on, type ProxyLogEvent, type TunnelInfo } from "./api";
import { proxyOf } from "./proxy";
import { icon } from "./icons";
import { endpoint, parseTarget, unusableHost, type Session } from "./model";
import { state } from "./store";
import { confirmDialog, confirmDiscard, errorText, esc, formValues, modal, promptDialog, toast } from "./ui";
import { userText } from "./i18n";
import { forgetHostKey } from "./hostKeys";

// ---- connecting through a gateway -----------------------------------------------------

/** The saved SSH session a session tunnels through, or null if it has none. */
export function gatewayOf(s: Session): Session | null {
  const id = s.options.gateway;
  if (!id) return null;
  const gw = state.sessions.find((x) => x.id === id && x.protocol === "ssh");
  if (!gw) throw new Error("이 세션의 SSH 게이트웨이 세션이 삭제되었습니다. 세션 편집에서 다시 고르세요.");
  return gw;
}

/** Protocols that can reach their server through an SSH gateway session (SSH
 * itself uses a jump host instead). */
export const GATEWAY_PROTOCOLS: ReadonlySet<string> = new Set(["telnet", "rdp", "vnc"]);

/** Whether a tunnel can log in to this session as a gateway: an SSH session
 * that itself goes through no jump host or gateway (openSshTunnel's rule). */
export const canBeGateway = (s: Session) => s.protocol === "ssh" && !String(s.options.jumpHost ?? "").trim() && !s.options.gateway;

/** Saved SSH sessions that can be a gateway, by name; `current` stays listed. */
export function gatewayChoices(current?: unknown): Session[] {
  return state.sessions
    .filter((s) => canBeGateway(s) || (s.protocol === "ssh" && s.id === current))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

/** Sessions that reach their server through `id` as their SSH gateway, in
 * `sessions` (the saved list, or the list as an edit will leave it). */
export function gatewayUsers(id: string, sessions: Session[] = state.sessions): Session[] {
  return sessions.filter((s) => s.id !== id && s.options.gateway === id && GATEWAY_PROTOCOLS.has(s.protocol));
}

/** A few of `users` by name, then how many more. */
export function gatewayUserList(users: Session[]): string {
  const names = users.slice(0, 6).map((u) => `<li><span data-i18n-skip>${esc(u.name || u.host)}</span></li>`);
  return `<ul class="clash-list">${names.join("")}${users.length > 6 ? `<li>외 ${users.length - 6}개</li>` : ""}</ul>`;
}

/** Ask before saving a gateway session in a form no tunnel can use (with a
 * jump host, or no longer SSH: openSshTunnel refuses it), which leaves
 * `users` unable to connect. */
export function confirmGatewayBreak(users: Session[]): Promise<boolean> {
  return confirmDialog({
    title: "게이트웨이로 쓰이는 세션",
    message: `다른 세션 ${users.length}개가 지금 바꾸는 세션을 SSH 게이트웨이로 씁니다. 점프 호스트를 거치거나 SSH가 아닌 세션은 게이트웨이가 될 수 없어서, 이대로 저장하면 그 세션들은 연결할 수 없습니다.${gatewayUserList(users)}`,
    confirm: "그래도 저장",
    danger: true,
    focusCancel: true,
  });
}

/** Select field listing saved SSH sessions, for the session editor. */
export function gatewayField(current: unknown): string {
  const ssh = gatewayChoices(current);
  return `<label class="field"><span>SSH 게이트웨이 (선택)</span><select name="opt.gateway">
      <option value="">사용 안 함 (직접 연결)</option>
      ${ssh.map((s) => `<option value="${esc(s.id)}" data-i18n-skip ${s.id === current ? "selected" : ""}>${esc(s.name)} · ${esc(endpoint(s))}</option>`).join("")}
    </select></label>
    <p class="muted small">고르면 그 SSH 서버에 먼저 로그인한 다음, 그 서버를 거쳐 대상에 연결합니다(방화벽 뒤의 장비).</p>`;
}

/**
 * Open a tunnel to `targetHost:targetPort` through `gw`, asking for host-key
 * approval and a password when needed. Resolves with the tunnel, or null if
 * the user cancelled.
 */
export async function openSshTunnel(
  gw: Session,
  targetHost: string,
  targetPort: number,
  id: string,
  localPort = 0,
): Promise<TunnelInfo | null> {
  // The tunnel logs in to the gateway itself and cannot go through that
  // session's own jump host or gateway: say so instead of a connect failure.
  if (!canBeGateway(gw))
    throw new Error(`게이트웨이로 고른 세션 "${gw.name || gw.host}"은(는) 점프 호스트나 다른 게이트웨이를 거쳐 접속합니다. 게이트웨이에는 직접 접속할 수 있는 SSH 세션을 고르세요.`);
  const extra: { password?: string; trustedFingerprint?: string } = {};
  let forgot = false;
  for (;;) {
    try {
      return await api.tunnelOpen({
        id,
        gatewayHost: gw.host,
        gatewayPort: gw.port,
        gatewayUsername: gw.username,
        gatewayCredentialId: gw.credentialId,
        targetHost,
        targetPort,
        localPort,
        gatewayProxy: proxyOf(gw),
        ...extra,
      });
    } catch (err) {
      const msg = errorText(err);
      if (msg.startsWith("HOSTKEY_UNKNOWN::")) {
        const fp = msg.slice("HOSTKEY_UNKNOWN::".length);
        const ok = await confirmDialog({
          title: "처음 접속하는 게이트웨이",
          icon: "ShieldCheck",
          message: `게이트웨이 <b data-i18n-skip>${esc(gw.host)}</b>의 호스트 키를 아직 신뢰한 적이 없습니다.<br><br>
            지문: <code class="fp">${esc(fp)}</code><br><br>서버 관리자가 알려 준 지문과 같은지 확인한 다음 신뢰하세요.`,
          confirm: "신뢰하고 연결",
        });
        if (!ok) return null;
        extra.trustedFingerprint = fp;
        continue;
      }
      if (msg.startsWith("HOSTKEY_MISMATCH::")) {
        const blocked = new Error(`게이트웨이 ${gw.host}의 호스트 키가 바뀌어 연결을 차단했습니다(중간자 공격일 수 있음). ~/.ssh/known_hosts를 확인하세요.`);
        // A reinstalled gateway: forget its old key once; the next attempt then
        // asks to trust the new one (above). Still mismatched after that (a key
        // kept under another name): stop instead of asking again.
        if (forgot) throw blocked;
        const fp = msg.slice("HOSTKEY_MISMATCH::".length);
        const wants = await confirmDialog({
          title: "호스트 키가 바뀌었습니다",
          icon: "ShieldAlert",
          message: `게이트웨이 <b data-i18n-skip>${esc(gw.host)}</b>가 이전과 다른 호스트 키를 보냈습니다. 중간자 공격일 수 있으므로 연결을 차단했습니다.<br><br>
            새 지문: <code class="fp">${esc(fp)}</code>`,
          confirm: "저장된 키 지우기",
          cancel: "닫기",
          focusCancel: true,
        });
        if (!wants || !(await forgetHostKey(gw.host, gw.port || 22, gw.username))) throw blocked;
        forgot = true;
        continue;
      }
      // An encrypted key without its passphrase (checked on this PC, nothing sent).
      if (msg === "NEED_PASSPHRASE" || msg === "BAD_PASSPHRASE") {
        const res = await promptDialog({
          title: msg === "BAD_PASSPHRASE" ? "키 암호가 맞지 않습니다" : "게이트웨이 키 암호",
          label: `${gw.username ? userText(gw.username) : "사용자"}@${userText(gw.host)} 의 개인 키 암호`,
          type: "password",
          icon: "KeyRound",
          confirm: "연결",
        });
        if (!res) return null;
        extra.password = res.value;
        continue;
      }
      if (msg === "NEED_PASSWORD" || /인증에 실패/.test(msg)) {
        const res = await promptDialog({
          title: msg === "NEED_PASSWORD" ? "게이트웨이 비밀번호" : "게이트웨이 비밀번호가 올바르지 않습니다",
          label: `${gw.username ? userText(gw.username) : "사용자"}@${userText(gw.host)} 의 비밀번호`,
          type: "password",
          icon: "KeyRound",
          confirm: "연결",
        });
        if (!res) return null;
        extra.password = res.value;
        continue;
      }
      throw new Error(`SSH 게이트웨이(${gw.host}): ${msg}`);
    }
  }
}

// ---- tunnel manager ------------------------------------------------------------------------

export interface SavedTunnel {
  id: string;
  name: string;
  gatewayId: string;
  localPort: number;
  targetHost: string;
  targetPort: number;
}

const KEY = "bx.tunnels";

/** A saved tunnel as stored or restored from a backup, or null when any
 * field is not what it must be (ports are whole numbers 1-65535). */
export function parseTunnel(raw: unknown): SavedTunnel | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const port = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535 ? (v as number) : null);
  const localPort = port(t.localPort);
  const targetPort = port(t.targetPort);
  if (typeof t.id !== "string" || typeof t.gatewayId !== "string" || typeof t.targetHost !== "string" || !localPort || !targetPort) return null;
  return { id: t.id, name: typeof t.name === "string" ? t.name : "", gatewayId: t.gatewayId, localPort, targetHost: t.targetHost, targetPort };
}

function loadSaved(): SavedTunnel[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.flatMap((t) => parseTunnel(t) ?? []) : [];
  } catch {
    return [];
  }
}

function storeSaved(list: SavedTunnel[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

/** Saved tunnels, for the session backup. */
export function savedTunnels(): SavedTunnel[] {
  return loadSaved();
}

/** Add tunnels from a backup that are not here yet (by id). */
export function addSavedTunnels(list: SavedTunnel[]) {
  const have = loadSaved();
  const ids = new Set(have.map((t) => t.id));
  storeSaved([...have, ...list.filter((t) => !ids.has(t.id))]);
}

let eventsWired = false;
function wireEvents() {
  if (eventsWired) return;
  eventsWired = true;
  on<{ id: string; kind: string; detail: string }>("tunnel-event", (e) => {
    const name = loadSaved().find((t) => t.id === e.id)?.name;
    toast(`${name ? `터널 ${userText(name)}: ` : "SSH 게이트웨이: "}${e.detail}`, e.kind === "error" ? "error" : "warn", 6000);
  });
}
wireEvents();

const validPort = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;

export function openTunnelManager() {
  let list = loadSaved();
  let running: TunnelInfo[] = [];
  const busy = new Set<string>();
  let timer = 0;

  const m = modal({
    title: "SSH 터널",
    icon: "Waypoints",
    width: 760,
    body: `<div class="tunnels">
        <p class="muted small">내 PC의 포트로 들어온 연결을 SSH 서버를 거쳐 다른 주소로 보냅니다(ssh -L). 예: 로컬 15432 → db.internal:5432</p>
        <div class="tunnel-list"></div>
        <form class="form tunnel-new" autocomplete="off">
          <h4>새 터널</h4>
          <div class="tunnel-grid">
            <label class="field"><span>이름</span><input name="name" placeholder="사내 DB" spellcheck="false"/></label>
            <label class="field"><span>SSH 서버</span><select name="gateway"></select></label>
            <label class="field"><span>내 PC 포트</span><input name="localPort" type="number" min="1" max="65535" placeholder="15432"/></label>
            <label class="field"><span>대상 호스트 (SSH 서버에서 본 주소)</span><input name="targetHost" placeholder="db.internal" spellcheck="false"/></label>
            <label class="field"><span>대상 포트</span><input name="targetPort" type="number" min="1" max="65535" placeholder="5432"/></label>
          </div>
          <div class="row"><button type="submit" class="btn btn-primary">${icon("Plus", 14)}추가</button></div>
        </form>
      </div>`,
    footer: `<button class="btn" data-close>닫기</button>`,
    onClose: () => clearInterval(timer),
    // A new tunnel typed in but not added yet.
    beforeDismiss: () => formValues(form) === formEmpty || confirmDiscard(),
  });
  const listEl = m.root.querySelector<HTMLElement>(".tunnel-list")!;
  const form = m.root.querySelector<HTMLFormElement>(".tunnel-new")!;
  const sshSessions = () => state.sessions.filter((s) => s.protocol === "ssh");
  form.querySelector<HTMLSelectElement>("[name=gateway]")!.innerHTML = sshSessions().length
    ? sshSessions()
        .map((s) => `<option value="${esc(s.id)}" data-i18n-skip>${esc(s.name)} · ${esc(endpoint(s))}</option>`)
        .join("")
    : `<option value="">저장된 SSH 세션이 없습니다</option>`;
  /** The new-tunnel form as it starts (and as "추가" leaves it). */
  const formEmpty = formValues(form);

  const refresh = async () => {
    running = await api.tunnelList().catch(() => []);
    render();
  };

  /** Each row's markup without its connection counters, as last drawn. */
  const drawn = new Map<string, string>();

  /** Called every 2 s: rows are rebuilt only when their state changed, and the
   * counters are updated as text, so a click on 시작/중지/삭제 is not lost to a
   * re-render between mousedown and mouseup. */
  function render() {
    if (!list.length) {
      drawn.clear();
      if (!listEl.querySelector(".tunnel-empty")) listEl.innerHTML = `<p class="muted tunnel-empty">저장된 터널이 없습니다. 아래에서 추가하세요.</p>`;
      return;
    }
    const rows = list.map((t) => {
      const r = running.find((x) => x.id === t.id);
      const gw = state.sessions.find((s) => s.id === t.gatewayId);
      const html = `<div class="tunnel-row${r ? " on" : ""}" data-id="${esc(t.id)}">
          <span class="sb-dot ${r ? "connected" : "idle"}"></span>
          <div class="tunnel-main"><b data-i18n-skip>${esc(t.name || `${t.targetHost}:${t.targetPort}`)}</b>
            <span class="mono small" data-i18n-skip>127.0.0.1:${esc(String(t.localPort))} → ${esc(t.targetHost)}:${esc(String(t.targetPort))}</span>
            <span class="muted small">${
              // The session name is the user's: kept out of the "{0} 경유" pattern,
              // whose value the translator would translate too ("삭제" → "Delete").
              gw ? `<span title="SSH 서버">${icon("Server", 12)}</span> <span data-i18n-skip>${esc(gw.name)}</span>` : "SSH 세션이 삭제됨"
            }<span class="tunnel-stats"></span></span></div>
          <button class="btn btn-sm ${r ? "btn-danger" : "btn-primary"}" data-toggle ${busy.has(t.id) || !gw ? "disabled" : ""}>
            ${r ? `${icon("Square", 13)}중지` : `${icon("Play", 13)}시작`}</button>
          <button class="tool" data-del title="삭제" ${r || busy.has(t.id) ? "disabled" : ""}>${icon("Trash2", 14)}</button>
        </div>`;
      return { id: t.id, html, stats: r ? ` · 연결 ${r.active}개 / 누적 ${r.total}` : "" };
    });
    let els = [...listEl.querySelectorAll<HTMLElement>(".tunnel-row")];
    if (els.length !== rows.length || els.some((el, i) => el.dataset.id !== rows[i].id)) {
      // Tunnels added or removed: draw the list again.
      listEl.innerHTML = rows.map((r) => r.html).join("");
      drawn.clear();
      for (const r of rows) drawn.set(r.id, r.html);
      els = [...listEl.querySelectorAll<HTMLElement>(".tunnel-row")];
    }
    rows.forEach((r, i) => {
      let el = els[i];
      if (drawn.get(r.id) !== r.html) {
        el.outerHTML = r.html;
        el = listEl.querySelectorAll<HTMLElement>(".tunnel-row")[i];
        drawn.set(r.id, r.html);
      }
      const stats = el.querySelector(".tunnel-stats")!;
      if (stats.textContent !== r.stats) stats.textContent = r.stats;
    });
  }

  listEl.addEventListener("click", async (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    const t = row && list.find((x) => x.id === row.dataset.id);
    if (!t) return;
    if ((e.target as HTMLElement).closest("[data-del]")) {
      if (busy.has(t.id) || running.some((r) => r.id === t.id)) return;
      const ok = await confirmDialog({
        title: "터널 삭제",
        message: `<b data-i18n-skip>${esc(t.name || `${t.targetHost}:${t.targetPort}`)}</b>을(를) 삭제합니다.`,
        confirm: "삭제",
        danger: true,
      });
      // While the dialog was open the tunnel may have been deleted or opened.
      if (!ok || !list.some((x) => x.id === t.id) || busy.has(t.id) || running.some((r) => r.id === t.id)) return;
      list = list.filter((x) => x.id !== t.id);
      storeSaved(list);
      return render();
    }
    if (!(e.target as HTMLElement).closest("[data-toggle]") || busy.has(t.id)) return;
    busy.add(t.id);
    render();
    try {
      if (running.some((r) => r.id === t.id)) {
        await api.tunnelClose(t.id);
      } else {
        const gw = state.sessions.find((s) => s.id === t.gatewayId);
        if (!gw) throw new Error("SSH 세션이 삭제되었습니다");
        const info = await openSshTunnel(gw, t.targetHost, t.targetPort, t.id, t.localPort);
        if (info) toast(`터널을 열었습니다: 127.0.0.1:${info.localPort} → ${userText(info.target)}`, "success");
      }
    } catch (err) {
      toast(errorText(err), "error", 7000);
    } finally {
      busy.delete(t.id);
      await refresh();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = (n: string) => form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name=${n}]`)!.value.trim();
    // "db.internal:5432", "[fe80::1]:22" or "http://db:8080/" pasted into the
    // host field: split off the port (the port field, if filled, wins), as
    // the SSH server would otherwise be asked for a host named "db.internal:5432".
    // A forward has no user, so "root@db:22" is refused here rather than saved
    // as a tunnel that can never open.
    let targetHost = val("targetHost");
    let targetPort = val("targetPort");
    const parsed = parseTarget(targetHost);
    if (parsed?.username) return toast("호스트 이름이 올바르지 않습니다", "warn");
    if (parsed) {
      targetHost = parsed.host;
      targetPort ||= parsed.port ? String(parsed.port) : "";
    }
    const t: SavedTunnel = {
      id: crypto.randomUUID(),
      name: val("name"),
      gatewayId: val("gateway"),
      localPort: Number(val("localPort")),
      targetHost,
      targetPort: Number(targetPort),
    };
    if (!t.gatewayId) return toast("먼저 SSH 세션을 저장하세요", "warn");
    if (!validPort(t.localPort) || !validPort(t.targetPort)) return toast("포트는 1부터 65535 사이의 정수여야 합니다", "warn");
    if (!t.targetHost) return toast("대상 호스트를 입력하세요", "warn");
    if (unusableHost(t.targetHost)) return toast("호스트 이름이 올바르지 않습니다", "warn");
    if (list.some((x) => x.localPort === t.localPort)) return toast(`내 PC 포트 ${t.localPort}을(를) 쓰는 터널이 이미 있습니다`, "warn");
    list.push(t);
    storeSaved(list);
    form.reset();
    render();
  });

  timer = window.setInterval(refresh, 2000);
  refresh();
}

/** The tunnel one tab keeps to its session's gateway, reused across reconnects
 * of the tab (so a wrong RDP password does not mean a new gateway login). */
export class GatewayLink {
  readonly id = `gw-${crypto.randomUUID()}`;
  private info: TunnelInfo | null = null;
  /** Local port of the session's proxy forward (no gateway), once open. */
  private proxyPort: number | null = null;
  private unlisten: (() => void) | null = null;
  /** The proxy-log subscription was requested (on() resolves later). */
  private listening = false;
  /** The proxy forward being opened; a second caller waits for it. */
  private forwarding: Promise<number> | null = null;
  /** The login in progress; a second caller waits for it instead of opening another. */
  private opening: Promise<TunnelInfo | null> | null = null;
  private closed = false;

  /** `viaProxy`: without a gateway, reach a proxied session through a local
   * proxy forward (RDP, VNC); Telnet and SSH hand the proxy to term_open. */
  constructor(
    private session: Session,
    private defaultPort: number,
    private viaProxy = true,
  ) {}

  /** Local port to connect to: undefined without a gateway or proxy, null if the user cancelled. */
  async port(): Promise<number | null | undefined> {
    const gw = gatewayOf(this.session);
    if (!gw) return this.viaProxy ? this.proxyForward() : undefined;
    if (this.closed) return null;
    if (this.info && (await api.tunnelList()).some((t) => t.id === this.id)) return this.info.localPort;
    if (!this.opening) {
      this.opening = openSshTunnel(gw, this.session.host, this.session.port ?? this.defaultPort, this.id).finally(() => (this.opening = null));
    }
    const info = await this.opening;
    // Closed while the login was in progress: do not leave the tunnel behind.
    if (this.closed) {
      if (info) api.tunnelClose(this.id).catch(() => {});
      return null;
    }
    this.info = info;
    return info?.localPort ?? null;
  }

  private async proxyForward(): Promise<number | null | undefined> {
    const proxy = proxyOf(this.session);
    if (!proxy) return undefined;
    if (this.closed) return null;
    if (this.proxyPort) return this.proxyPort;
    // Each proxied connection is dialled when the view connects: its failure
    // arrives as an event, said here (the view only sees a closed connection).
    // Marked before on() resolves, so concurrent callers subscribe once.
    if (!this.listening) {
      this.listening = true;
      const id = this.id;
      on<ProxyLogEvent>("proxy-log", (e) => {
        if (e.id === id && e.error) toast(`프록시: ${e.line}`, "error", 8000);
      }).then((u) => (this.closed ? u() : (this.unlisten = u)));
    }
    // A second caller waits for the forward being opened instead of opening another.
    if (!this.forwarding) {
      this.forwarding = api
        .proxyForwardOpen(this.id, this.session.host, this.session.port ?? this.defaultPort, proxy)
        .finally(() => (this.forwarding = null));
    }
    const port = await this.forwarding;
    // Closed while the forward was opening: close() saw no port, so close it here.
    if (this.closed) {
      api.proxyForwardClose(this.id).catch(() => {});
      return null;
    }
    this.proxyPort = port;
    return port;
  }

  close() {
    this.closed = true;
    api.tunnelClose(this.id).catch(() => {});
    if (this.proxyPort) api.proxyForwardClose(this.id).catch(() => {});
    this.unlisten?.();
    this.info = null;
    this.proxyPort = null;
  }
}
