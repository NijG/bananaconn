// SSH tunnels: the "SSH gateway" option of RDP/VNC/Telnet sessions and the
// tunnel manager (saved local port forwards started on demand). The backend
// (tunnel.rs) does the forwarding in-process; this module handles the login
// dialogs (host key, password) and the saved tunnel list.

import { api, on, type TunnelInfo } from "./api";
import { icon } from "./icons";
import { endpoint, type Session } from "./model";
import { state } from "./store";
import { confirmDialog, errorText, esc, modal, promptDialog, toast } from "./ui";

// ---- connecting through a gateway -----------------------------------------------------

/** The saved SSH session a session tunnels through, or null if it has none. */
export function gatewayOf(s: Session): Session | null {
  const id = s.options.gateway;
  if (!id) return null;
  const gw = state.sessions.find((x) => x.id === id && x.protocol === "ssh");
  if (!gw) throw new Error("이 세션의 SSH 게이트웨이 세션이 삭제되었습니다. 세션 편집에서 다시 고르세요.");
  return gw;
}

/** Select field listing saved SSH sessions, for the session editor. */
export function gatewayField(current: unknown): string {
  // A session that itself goes through a jump host or gateway cannot be one.
  const ssh = state.sessions.filter((s) => s.protocol === "ssh" && ((!String(s.options.jumpHost ?? "").trim() && !s.options.gateway) || s.id === current)).sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return `<label class="field"><span>SSH 게이트웨이 (선택)</span><select name="opt.gateway">
      <option value="">사용 안 함 (직접 연결)</option>
      ${ssh.map((s) => `<option value="${esc(s.id)}" ${s.id === current ? "selected" : ""}>${esc(s.name)} · ${esc(endpoint(s))}</option>`).join("")}
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
  if (String(gw.options.jumpHost ?? "").trim() || gw.options.gateway)
    throw new Error(`게이트웨이로 고른 세션 "${gw.name || gw.host}"은(는) 점프 호스트나 다른 게이트웨이를 거쳐 접속합니다. 게이트웨이에는 직접 접속할 수 있는 SSH 세션을 고르세요.`);
  const extra: { password?: string; trustedFingerprint?: string } = {};
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
        ...extra,
      });
    } catch (err) {
      const msg = errorText(err);
      if (msg.startsWith("HOSTKEY_UNKNOWN::")) {
        const fp = msg.slice("HOSTKEY_UNKNOWN::".length);
        const ok = await confirmDialog({
          title: "처음 접속하는 게이트웨이",
          icon: "ShieldCheck",
          message: `게이트웨이 <b>${esc(gw.host)}</b>의 호스트 키를 아직 신뢰한 적이 없습니다.<br><br>
            지문: <code class="fp">${esc(fp)}</code><br><br>서버 관리자가 알려 준 지문과 같은지 확인한 다음 신뢰하세요.`,
          confirm: "신뢰하고 연결",
        });
        if (!ok) return null;
        extra.trustedFingerprint = fp;
        continue;
      }
      if (msg.startsWith("HOSTKEY_MISMATCH::"))
        throw new Error(`게이트웨이 ${gw.host}의 호스트 키가 바뀌어 연결을 차단했습니다(중간자 공격일 수 있음). ~/.ssh/known_hosts를 확인하세요.`);
      if (msg === "NEED_PASSWORD" || /인증에 실패/.test(msg)) {
        const res = await promptDialog({
          title: msg === "NEED_PASSWORD" ? "게이트웨이 비밀번호" : "게이트웨이 비밀번호가 올바르지 않습니다",
          label: `${gw.username || "사용자"}@${gw.host} 의 비밀번호`,
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
    toast(`${name ? `터널 ${name}: ` : "SSH 게이트웨이: "}${e.detail}`, e.kind === "error" ? "error" : "warn", 6000);
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
  });
  const listEl = m.root.querySelector<HTMLElement>(".tunnel-list")!;
  const form = m.root.querySelector<HTMLFormElement>(".tunnel-new")!;
  const sshSessions = () => state.sessions.filter((s) => s.protocol === "ssh");
  form.querySelector<HTMLSelectElement>("[name=gateway]")!.innerHTML = sshSessions().length
    ? sshSessions()
        .map((s) => `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(endpoint(s))}</option>`)
        .join("")
    : `<option value="">저장된 SSH 세션이 없습니다</option>`;

  const refresh = async () => {
    running = await api.tunnelList().catch(() => []);
    render();
  };

  function render() {
    if (!list.length) {
      listEl.innerHTML = `<p class="muted tunnel-empty">저장된 터널이 없습니다. 아래에서 추가하세요.</p>`;
      return;
    }
    listEl.innerHTML = list
      .map((t) => {
        const r = running.find((x) => x.id === t.id);
        const gw = state.sessions.find((s) => s.id === t.gatewayId);
        return `<div class="tunnel-row${r ? " on" : ""}" data-id="${esc(t.id)}">
          <span class="sb-dot ${r ? "connected" : "idle"}"></span>
          <div class="tunnel-main"><b>${esc(t.name || `${t.targetHost}:${t.targetPort}`)}</b>
            <span class="mono small">127.0.0.1:${esc(String(t.localPort))} → ${esc(t.targetHost)}:${esc(String(t.targetPort))}</span>
            <span class="muted small">${gw ? `${esc(gw.name)} 경유` : "SSH 세션이 삭제됨"}${r ? ` · 연결 ${r.active}개 / 누적 ${r.total}` : ""}</span></div>
          <button class="btn btn-sm ${r ? "btn-danger" : "btn-primary"}" data-toggle ${busy.has(t.id) || !gw ? "disabled" : ""}>
            ${r ? `${icon("Square", 13)}중지` : `${icon("Play", 13)}시작`}</button>
          <button class="tool" data-del title="삭제" ${r || busy.has(t.id) ? "disabled" : ""}>${icon("Trash2", 14)}</button>
        </div>`;
      })
      .join("");
  }

  listEl.addEventListener("click", async (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    const t = row && list.find((x) => x.id === row.dataset.id);
    if (!t) return;
    if ((e.target as HTMLElement).closest("[data-del]")) {
      if (busy.has(t.id) || running.some((r) => r.id === t.id)) return;
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
        if (info) toast(`터널을 열었습니다: 127.0.0.1:${info.localPort} → ${info.target}`, "success");
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
    const t: SavedTunnel = {
      id: crypto.randomUUID(),
      name: val("name"),
      gatewayId: val("gateway"),
      localPort: Number(val("localPort")),
      targetHost: val("targetHost"),
      targetPort: Number(val("targetPort")),
    };
    if (!t.gatewayId) return toast("먼저 SSH 세션을 저장하세요", "warn");
    if (!validPort(t.localPort) || !validPort(t.targetPort)) return toast("포트는 1부터 65535 사이의 정수여야 합니다", "warn");
    if (!t.targetHost) return toast("대상 호스트를 입력하세요", "warn");
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
  /** The login in progress; a second caller waits for it instead of opening another. */
  private opening: Promise<TunnelInfo | null> | null = null;
  private closed = false;

  constructor(
    private session: Session,
    private defaultPort: number,
  ) {}

  /** Local port to connect to: undefined without a gateway, null if the user cancelled. */
  async port(): Promise<number | null | undefined> {
    const gw = gatewayOf(this.session);
    if (!gw) return undefined;
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

  close() {
    this.closed = true;
    api.tunnelClose(this.id).catch(() => {});
    this.info = null;
  }
}
