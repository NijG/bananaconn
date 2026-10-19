// Built-in FTP server: share a local folder with other machines (or apps on this
// PC). The backend (ftpserver.rs) confines clients to the chosen folder; this
// module owns the settings dialog, the activity log and the status-bar badge.

import { api, on, pickFolder, type FtpServerConfig, type FtpServerStatus } from "./api";
import { writeClipboard } from "./clipboard";
import { icon } from "./icons";
import { errorText, esc, modal, toast } from "./ui";

interface LogEntry {
  at: string;
  kind: string;
  user: string;
  detail: string;
}

const PREFS = "bx.ftpServer";
const LOG_MAX = 300;

let status: FtpServerStatus | null = null;
/** Password of the running server; kept only in memory, never persisted. */
let livePassword = "";
const log: LogEntry[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

export const ftpServer = {
  get status() {
    return status;
  },
  onChange(f: () => void) {
    listeners.add(f);
    return () => listeners.delete(f);
  },
};

type Prefs = Omit<FtpServerConfig, "password">;

function loadPrefs(): Prefs {
  const d: Prefs = { root: "", port: 2121, lan: false, username: "banana", anonymous: false, readOnly: true };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(PREFS) ?? "{}") };
  } catch {
    return d;
  }
}

/** True for an ftp://a.b.c.d:port address outside private, loopback and link-local ranges. */
export function isPublicAddress(url: string): boolean {
  const m = url.match(/^ftp:\/\/(\d+)\.(\d+)\.(\d+)\.(\d+):/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  const priv = a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  return !priv;
}

function randomPassword() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

const KIND_TEXT: Record<string, [string, string]> = {
  started: ["Play", "서버 시작"],
  stopped: ["Square", "서버 중지"],
  error: ["TriangleAlert", "오류"],
  login: ["KeyRound", "로그인"],
  logout: ["Unlink", "로그아웃"],
  download: ["Download", "다운로드"],
  upload: ["Upload", "업로드"],
  delete: ["Trash2", "삭제"],
  mkdir: ["FolderPlus", "폴더 생성"],
  rmdir: ["Trash2", "폴더 삭제"],
  rename: ["Pencil", "이름 변경"],
};

function pushLog(e: Omit<LogEntry, "at">) {
  const d = new Date();
  const at = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  log.push({ ...e, at });
  if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
}

/** Subscribe to backend events and pick up a server left running by a reload. */
export async function initFtpServer() {
  await on<{ kind: string; user: string; detail: string }>("ftp-server-event", (e) => {
    pushLog(e);
    // The backend is the owner of the running state (it may be started or
    // stopped from elsewhere): re-read it whenever it changes.
    if (e.kind === "started" || e.kind === "stopped" || e.kind === "error") {
      api.ftpServerStatus().then((s) => {
        status = s;
        if (!s) livePassword = "";
        notify();
      });
    } else notify();
  });
  status = await api.ftpServerStatus().catch(() => null);
  notify();
}

export function ftpServerBadge(): string {
  if (!status) return "";
  return `<button class="sb-server" data-ftp-server title="${esc(status.addresses.join("\n"))}">${icon("Server", 13)}FTP 서버 :${status.port}</button>`;
}

export function openFtpServer() {
  const p = loadPrefs();
  // A server left running by a page reload: its password is not known here.
  const password = status ? livePassword : randomPassword();

  const m = modal({
    title: "FTP 서버",
    icon: "Server",
    width: 640,
    body: `<div class="ftpd">
        <div class="ftpd-state"></div>
        <form class="form ftpd-form" autocomplete="off">
          <label class="field"><span>공유할 폴더</span>
            <div class="inline"><input name="root" spellcheck="false" placeholder="예: D:\\공유" value="${esc(p.root)}"/>
            <button type="button" class="btn" data-pick>${icon("FolderOpen", 14)}찾아보기</button></div></label>
          <div class="grid-2">
            <label class="field"><span>포트</span><input name="port" type="number" min="1" max="65535" value="${p.port}"/></label>
            <label class="field"><span>사용자 이름</span><input name="username" spellcheck="false" value="${esc(p.username)}"/></label>
          </div>
          <label class="field"><span>비밀번호 <small class="muted">· 저장되지 않으며, 서버를 켤 때마다 새로 정할 수 있습니다</small></span>
            <div class="inline"><input name="password" class="mono" spellcheck="false" value="${esc(password)}"/>
            <button type="button" class="btn" data-gen title="새 비밀번호 만들기">${icon("RefreshCw", 14)}</button>
            <button type="button" class="btn" data-copy-pw title="복사">${icon("Copy", 14)}</button></div></label>
          <div class="check-grid">
            <label class="check block"><input type="checkbox" name="readOnly" ${p.readOnly ? "checked" : ""}/>
              <span><b>읽기 전용</b><small>내려받기만 허용하고 올리기·삭제·이름 변경은 거부합니다.</small></span></label>
            <label class="check block"><input type="checkbox" name="lan" ${p.lan ? "checked" : ""}/>
              <span><b>다른 PC에서 접속 허용</b><small>끄면 이 PC(127.0.0.1)에서만 접속할 수 있습니다.</small></span></label>
            <label class="check block"><input type="checkbox" name="anonymous" ${p.anonymous ? "checked" : ""}/>
              <span><b>익명 접속 허용</b><small>비밀번호 없이 anonymous 계정으로도 들어올 수 있습니다.</small></span></label>
          </div>
          <p class="ftpd-warn" hidden></p>
        </form>
        <section class="ftpd-log-box">
          <header><b>${icon("ScrollText", 14)}활동 기록</b><button type="button" class="btn btn-sm" data-clear>${icon("Eraser", 13)}지우기</button></header>
          <div class="ftpd-log" role="log"></div>
        </section>
      </div>`,
    footer: `<button class="btn" data-close>닫기</button><button class="btn btn-primary" data-toggle></button>`,
    onClose: () => off(),
  });

  const form = m.root.querySelector<HTMLFormElement>(".ftpd-form")!;
  const field = <T extends HTMLInputElement>(n: string) => form.querySelector<T>(`[name=${n}]`)!;
  const stateBox = m.root.querySelector<HTMLElement>(".ftpd-state")!;
  const logBox = m.root.querySelector<HTMLElement>(".ftpd-log")!;
  const warn = m.root.querySelector<HTMLElement>(".ftpd-warn")!;
  const toggle = m.root.querySelector<HTMLButtonElement>("[data-toggle]")!;
  let busy = false;

  function renderWarn() {
    const msgs: string[] = [];
    if (field("anonymous").checked && !field("readOnly").checked)
      msgs.push("익명 접속과 쓰기를 함께 허용하면 누구나 이 폴더에 파일을 올리거나 지울 수 있습니다.");
    if (field("lan").checked)
      msgs.push("FTP는 암호화되지 않습니다. 비밀번호와 파일 내용이 네트워크에 그대로 보이므로 믿을 수 있는 내부망에서만 사용하세요. 처음 켤 때 Windows 방화벽이 허용 여부를 물을 수 있습니다.");
    warn.hidden = !msgs.length;
    warn.innerHTML = msgs.map((t) => `<span>${icon("TriangleAlert", 14)}${esc(t)}</span>`).join("");
  }

  function renderState() {
    const running = !!status;
    form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((el) => {
      el.disabled = el.matches("[data-copy-pw]") ? running && !livePassword : running || busy;
    });
    toggle.disabled = busy;
    toggle.className = `btn ${running ? "btn-danger" : "btn-primary"}`;
    toggle.innerHTML = running ? `${icon("Square", 14)}서버 중지` : `${icon("Play", 14)}서버 시작`;
    if (!status) {
      stateBox.innerHTML = `<div class="ftpd-off"><span class="sb-dot idle"></span><b>중지됨</b><span class="muted">폴더를 고르고 서버를 시작하세요.</span></div>`;
    } else {
      const s = status;
      stateBox.innerHTML = `<div class="ftpd-on"><span class="sb-dot connected"></span><b>실행 중</b>
          <span class="muted">${esc(s.root)} · ${s.readOnly ? "읽기 전용" : "읽기/쓰기"}${s.anonymous ? " · 익명 허용" : ""}</span></div>
        <div class="ftpd-addrs">${s.addresses
          .map((a) => `<button type="button" class="ftpd-addr" data-addr="${esc(a)}" title="주소 복사">${icon("Copy", 13)}<code>${esc(a)}</code></button>`)
          .join("")}</div>
        ${s.addresses.some(isPublicAddress) ? `<p class="ftpd-public">${icon("ShieldAlert", 14)}이 PC는 공인 IP를 쓰고 있어 방화벽이 허용하면 인터넷 어디에서나 접속을 시도할 수 있습니다. 필요할 때만 켜 두세요.</p>` : ""}
        <p class="muted small">계정: <code>${esc(s.username || "anonymous")}</code>${s.anonymous && s.username ? " 또는 <code>anonymous</code>" : ""}</p>`;
      stateBox.querySelectorAll<HTMLElement>("[data-addr]").forEach((b) =>
        b.addEventListener("click", async () => {
          await writeClipboard(b.dataset.addr!);
          toast("주소를 복사했습니다", "success", 1600);
        }),
      );
    }
  }

  function renderLog() {
    if (!log.length) {
      logBox.innerHTML = `<p class="muted ftpd-empty">아직 기록이 없습니다. 접속, 업로드, 다운로드가 여기에 표시됩니다.</p>`;
      return;
    }
    logBox.innerHTML = log
      .slice()
      .reverse()
      .map((e) => {
        const [ic, label] = KIND_TEXT[e.kind] ?? ["Info", e.kind];
        return `<div class="ftpd-row k-${esc(e.kind)}"><time>${esc(e.at)}</time>${icon(ic, 13)}<b>${esc(label)}</b>
          ${e.user ? `<span class="who">${esc(e.user)}</span>` : ""}<span class="what">${esc(e.detail)}</span></div>`;
      })
      .join("");
  }

  const refresh = () => {
    renderState();
    renderLog();
  };
  const off = ftpServer.onChange(refresh);

  form.addEventListener("change", renderWarn);
  form.addEventListener("submit", (e) => e.preventDefault());
  m.root.querySelector("[data-pick]")!.addEventListener("click", async () => {
    const dir = await pickFolder("공유할 폴더 선택", field("root").value || undefined);
    if (dir) field("root").value = dir;
  });
  m.root.querySelector("[data-gen]")!.addEventListener("click", () => {
    field("password").value = randomPassword();
  });
  m.root.querySelector("[data-copy-pw]")!.addEventListener("click", async () => {
    await writeClipboard(field("password").value);
    toast("비밀번호를 복사했습니다", "success", 1600);
  });
  m.root.querySelector("[data-clear]")!.addEventListener("click", () => {
    log.length = 0;
    renderLog();
  });

  toggle.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    renderState();
    try {
      if (status) {
        await api.ftpServerStop();
        status = null;
        livePassword = "";
        if (!field("password").value) field("password").value = randomPassword();
      } else {
        const cfg: FtpServerConfig = {
          root: field("root").value.trim(),
          port: Number(field("port").value),
          lan: field("lan").checked,
          username: field("username").value.trim(),
          password: field("password").value,
          anonymous: field("anonymous").checked,
          readOnly: field("readOnly").checked,
        };
        if (!cfg.root) throw new Error("공유할 폴더를 고르세요");
        if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error("포트는 1~65535 사이여야 합니다");
        const { password: _pw, ...prefs } = cfg;
        localStorage.setItem(PREFS, JSON.stringify(prefs));
        status = await api.ftpServerStart(cfg);
        livePassword = cfg.password;
        toast(`FTP 서버를 시작했습니다 (${status.addresses[0]})`, "success");
      }
    } catch (err) {
      toast(errorText(err), "error", 6000);
    } finally {
      busy = false;
      notify();
    }
  });

  renderWarn();
  refresh();
}
