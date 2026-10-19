// Built-in TFTP and HTTP servers (backend: fileservers.rs). Same look as the
// FTP server dialog: share a folder, see addresses and an activity log.

import { api, on, pickFolder, type FileServerKind, type FileServerStatus } from "./api";
import { writeClipboard } from "./clipboard";
import { isPublicAddress } from "./ftpServer";
import { icon } from "./icons";
import { errorText, esc, modal, toast } from "./ui";

interface LogEntry {
  at: string;
  kind: string;
  user: string;
  detail: string;
}

const INFO: Record<FileServerKind, { title: string; icon: string; port: number; hint: string }> = {
  tftp: {
    title: "TFTP 서버",
    icon: "Upload",
    port: 69,
    hint: "스위치·라우터 같은 네트워크 장비의 설정 백업이나 펌웨어 올리기에 씁니다. 인증이 없으므로 필요할 때만 켜세요.",
  },
  http: {
    title: "HTTP 서버",
    icon: "Globe",
    port: 8000,
    hint: "웹 브라우저로 폴더의 파일을 내려받게 합니다(읽기 전용). 다른 PC에 공개할 때는 사용자 이름과 비밀번호를 정하세요.",
  },
};

const status: Partial<Record<FileServerKind, FileServerStatus>> = {};
const logs: Record<FileServerKind, LogEntry[]> = { tftp: [], http: [] };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

export const fileServers = {
  status: (k: FileServerKind) => status[k] ?? null,
  onChange(f: () => void) {
    listeners.add(f);
    return () => listeners.delete(f);
  },
};

const KIND_TEXT: Record<string, [string, string]> = {
  started: ["Play", "서버 시작"],
  stopped: ["Square", "서버 중지"],
  download: ["Download", "다운로드"],
  upload: ["Upload", "업로드"],
  denied: ["ShieldAlert", "거부"],
  error: ["TriangleAlert", "오류"],
};

const now = () => {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
};

export async function initFileServers() {
  await on<{ server: string; kind: string; user: string; detail: string }>("file-server-event", (e) => {
    const kind = e.server as FileServerKind;
    if (!logs[kind]) return;
    logs[kind].push({ at: now(), kind: e.kind, user: e.user, detail: e.detail });
    if (logs[kind].length > 300) logs[kind].splice(0, logs[kind].length - 300);
    if (e.kind === "started" || e.kind === "stopped") refreshStatus();
    else notify();
  });
  await refreshStatus();
}

/** Re-read which servers run: the backend owns that state. */
async function refreshStatus() {
  const list = await api.fileServerStatus().catch(() => null);
  if (!list) return;
  for (const k of Object.keys(INFO) as FileServerKind[]) delete status[k];
  for (const s of list) status[s.kind] = s;
  notify();
}

export function fileServerBadges(): string {
  return (Object.keys(INFO) as FileServerKind[])
    .filter((k) => status[k])
    .map((k) => `<button class="sb-server" data-file-server="${k}" title="${esc(status[k]!.addresses.join("\n"))}">${icon(INFO[k].icon, 13)}${k.toUpperCase()} :${status[k]!.port}</button>`)
    .join("");
}

type Prefs = { root: string; port: number; lan: boolean; readOnly: boolean; username: string };

function loadPrefs(kind: FileServerKind): Prefs {
  const d: Prefs = { root: "", port: INFO[kind].port, lan: kind === "tftp", readOnly: true, username: "" };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(`bx.${kind}Server`) ?? "{}") };
  } catch {
    return d;
  }
}

export function openFileServer(kind: FileServerKind) {
  const info = INFO[kind];
  const p = loadPrefs(kind);
  const m = modal({
    title: info.title,
    icon: info.icon,
    width: 620,
    body: `<div class="ftpd">
        <div class="ftpd-state"></div>
        <p class="muted small">${esc(info.hint)}</p>
        <form class="form ftpd-form" autocomplete="off">
          <label class="field"><span>공유할 폴더</span>
            <div class="inline"><input name="root" spellcheck="false" placeholder="예: D:\\tftp" value="${esc(p.root)}"/>
            <button type="button" class="btn" data-pick>${icon("FolderOpen", 14)}찾아보기</button></div></label>
          <div class="grid-2">
            <label class="field"><span>포트</span><input name="port" type="number" min="1" max="65535" value="${p.port}"/></label>
            ${kind === "http" ? `<label class="field"><span>사용자 이름 (선택)</span><input name="username" spellcheck="false" value="${esc(p.username)}"/></label>` : "<span></span>"}
          </div>
          ${kind === "http" ? `<label class="field"><span>비밀번호 <small class="muted">· 비우면 인증 없이 공개, 저장하지 않습니다</small></span><input name="password" type="password" autocomplete="new-password"/></label>` : ""}
          <div class="check-grid">
            ${
              kind === "tftp"
                ? `<label class="check block"><input type="checkbox" name="readOnly" ${p.readOnly ? "checked" : ""}/>
                     <span><b>읽기 전용</b><small>끄면 장비가 이 폴더로 파일을 올릴 수 있습니다(설정 백업).</small></span></label>`
                : ""
            }
            <label class="check block"><input type="checkbox" name="lan" ${p.lan ? "checked" : ""}/>
              <span><b>다른 PC·장비에서 접속 허용</b><small>끄면 이 PC(127.0.0.1)에서만 접속할 수 있습니다.</small></span></label>
          </div>
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
  const field = (n: string) => form.querySelector<HTMLInputElement>(`[name=${n}]`);
  const stateBox = m.root.querySelector<HTMLElement>(".ftpd-state")!;
  const logBox = m.root.querySelector<HTMLElement>(".ftpd-log")!;
  const toggle = m.root.querySelector<HTMLButtonElement>("[data-toggle]")!;
  let busy = false;

  function render() {
    const s = status[kind];
    form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((el) => (el.disabled = !!s || busy));
    toggle.disabled = busy;
    toggle.className = `btn ${s ? "btn-danger" : "btn-primary"}`;
    toggle.innerHTML = s ? `${icon("Square", 14)}서버 중지` : `${icon("Play", 14)}서버 시작`;
    stateBox.innerHTML = s
      ? `<div class="ftpd-on"><span class="sb-dot connected"></span><b>실행 중</b>
           <span class="muted">${esc(s.root)} · ${s.readOnly ? "읽기 전용" : "읽기/쓰기"}${s.auth ? " · 인증 사용" : ""}</span></div>
         <div class="ftpd-addrs">${s.addresses
           .map((a) => `<button type="button" class="ftpd-addr" data-addr="${esc(a)}" title="주소 복사">${icon("Copy", 13)}<code>${esc(a)}</code></button>`)
           .join("")}</div>
         ${s.addresses.some((a) => isPublicAddress(a.replace(/^\w+:/, "ftp:"))) ? `<p class="ftpd-public">${icon("ShieldAlert", 14)}이 PC는 공인 IP를 쓰고 있어 방화벽이 허용하면 인터넷에서 접속을 시도할 수 있습니다.</p>` : ""}`
      : `<div class="ftpd-off"><span class="sb-dot idle"></span><b>중지됨</b><span class="muted">폴더를 고르고 서버를 시작하세요.</span></div>`;
    stateBox.querySelectorAll<HTMLElement>("[data-addr]").forEach((b) =>
      b.addEventListener("click", async () => {
        await writeClipboard(b.dataset.addr!);
        toast("주소를 복사했습니다", "success", 1600);
      }),
    );
    const log = logs[kind];
    logBox.innerHTML = log.length
      ? log
          .slice()
          .reverse()
          .map((e) => {
            const [ic, label] = KIND_TEXT[e.kind] ?? ["Info", e.kind];
            return `<div class="ftpd-row k-${esc(e.kind)}"><time>${esc(e.at)}</time>${icon(ic, 13)}<b>${esc(label)}</b>
              ${e.user ? `<span class="who">${esc(e.user)}</span>` : ""}<span class="what">${esc(e.detail)}</span></div>`;
          })
          .join("")
      : `<p class="muted ftpd-empty">아직 기록이 없습니다.</p>`;
  }
  const off = fileServers.onChange(render);

  m.root.querySelector("[data-pick]")!.addEventListener("click", async () => {
    const dir = await pickFolder("공유할 폴더 선택", field("root")!.value || undefined);
    if (dir) field("root")!.value = dir;
  });
  m.root.querySelector("[data-clear]")!.addEventListener("click", () => {
    logs[kind].length = 0;
    render();
  });
  form.addEventListener("submit", (e) => e.preventDefault());

  toggle.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    render();
    try {
      if (status[kind]) {
        const active = await api.fileServerActive(kind).catch(() => 0);
        if (active) toast(`진행 중이던 전송 ${active}건이 끊어집니다`, "warn");
        await api.fileServerStop(kind);
        delete status[kind];
      } else {
        const port = Number(field("port")!.value);
        const root = field("root")!.value.trim();
        if (!root) throw new Error("공유할 폴더를 고르세요");
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("포트는 1~65535 사이여야 합니다");
        const cfg = {
          kind,
          root,
          port,
          lan: field("lan")!.checked,
          readOnly: field("readOnly")?.checked ?? true,
          username: field("username")?.value.trim() ?? "",
          password: field("password")?.value ?? "",
        };
        if (kind === "http" && cfg.lan && !cfg.username)
          toast("인증 없이 다른 PC에 공개합니다. 폴더의 모든 파일을 누구나 내려받을 수 있습니다.", "warn", 6000);
        const { password: _pw, ...prefs } = cfg;
        localStorage.setItem(`bx.${kind}Server`, JSON.stringify(prefs));
        status[kind] = await api.fileServerStart(cfg);
        toast(`${info.title}를 시작했습니다 (${status[kind]!.addresses[0]})`, "success");
      }
    } catch (err) {
      toast(errorText(err), "error", 6000);
    } finally {
      busy = false;
      notify();
    }
  });
  render();
}
