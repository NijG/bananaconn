// Create / edit session dialog.

import { icon } from "./icons";
import { proxyFields, proxyOptions, proxyProblem } from "./proxy";
import { BAUD_RATES, defaultPort, newSession, normalizeFolder, PROTOCOL_ORDER, PROTOCOLS, serialSettings, type Protocol, type Session } from "./model";
import { allFolders, state, upsertSession } from "./store";
import { api } from "./api";
import { errorText, esc, modal, toast } from "./ui";
import { gatewayField } from "./tunnels";
import { logFields, wireLogBrowse } from "./logOptions";
import { openVault } from "./vault";

const VNC_QUALITY: [string, string][] = [
  ["fast", "빠르게 (기본: 화질을 낮추고 최대한 압축)"],
  ["balanced", "보통"],
  ["sharp", "선명하게 (빠른 사내망용)"],
];

const RESOLUTIONS = ["", "1280x720", "1366x768", "1600x900", "1920x1080", "2560x1440"];

function optionsFields(p: Protocol, o: Record<string, unknown>): string {
  const check = (name: string, label: string, on: boolean) =>
    `<label class="check"><input type="checkbox" name="opt.${name}" ${on ? "checked" : ""}/> ${label}</label>`;
  switch (p) {
    case "ssh":
      return `${keyModeField(o.keyMode, o.backspace)}<div class="grid-2">
          <label class="field"><span>점프 호스트 (선택)</span>
            <input name="opt.jumpHost" value="${esc(o.jumpHost ?? "")}" placeholder="user@bastion:22" spellcheck="false"/></label>
          <label class="field"><span>연결 유지 간격 (초)</span>
            <input name="opt.keepalive" type="number" min="0" max="3600" value="${esc(o.keepalive ?? 30)}"/></label>
        </div>
        <label class="field"><span>포트 포워딩 (한 줄에 하나)</span>
          <textarea name="opt.forwards" rows="3" spellcheck="false" placeholder="L 8080:localhost:80    로컬 8080 → 원격의 localhost:80&#10;R 9000:localhost:3000  원격 9000 → 내 PC의 3000&#10;D 1080                 SOCKS 프록시">${esc(o.forwards ?? "")}</textarea></label>
        <div class="check-grid">
          ${check("compression", "압축 사용 (느린 회선)", !!o.compression)}
          ${check("agentForward", "SSH 에이전트 전달", !!o.agentForward)}
        </div>`;
    case "sftp":
    case "ftp":
    case "ftps":
      return `${
        p === "ftps"
          ? `<label class="field"><span>TLS 방식</span><select name="opt.ftpsMode">
               <option value="explicit" ${o.ftpsMode !== "implicit" ? "selected" : ""}>명시적 FTPS (AUTH TLS, 기본 포트 21)</option>
               <option value="implicit" ${o.ftpsMode === "implicit" ? "selected" : ""}>암시적 FTPS (처음부터 TLS, 기본 포트 990)</option>
             </select></label>`
          : ""
      }
        <label class="field"><span>시작 폴더 (비우면 홈 폴더)</span>
        <input name="opt.startPath" value="${esc(o.startPath ?? "")}" placeholder="/var/www" spellcheck="false"/></label>
        ${p !== "sftp" ? check("activeMode", "액티브 모드 사용 (기본은 패시브)", !!o.activeMode) : ""}
        ${
          p === "ftps"
            ? `${check("allowInvalidCert", "신뢰할 수 없는 인증서 허용 (자체 서명 인증서 서버)", !!o.allowInvalidCert)}
               <p class="muted small">이 옵션을 켜면 서버 인증서의 신뢰 여부를 확인하지 않습니다. 내부망의 자체 서명 서버에만 사용하세요.</p>`
            : ""
        }`;
    case "rdp": {
      const external = o.openMode === "external";
      return `<label class="field"><span>열기 방식</span><select name="opt.openMode" data-rerender>
          <option value="embedded" ${!external ? "selected" : ""}>앱 안의 탭에서 열기 (내장)</option>
          <option value="external" ${external ? "selected" : ""}>Windows 원격 데스크톱(mstsc) 창으로 열기</option>
        </select></label>
        <div class="grid-2">
          <label class="field"><span>도메인 (선택)</span><input name="opt.domain" value="${esc(o.domain ?? "")}" placeholder="CORP" spellcheck="false"/></label>
          <label class="field"><span>해상도</span><select name="opt.resolution">
            ${RESOLUTIONS.map((r) => `<option value="${r}" ${o.resolution === r ? "selected" : ""}>${r ? r.replace("x", " × ") : external ? "자동" : "자동 (탭 크기에 맞춤)"}</option>`).join("")}
          </select></label>
        </div>
        ${
          external
            ? `<div class="check-grid">
                 ${check("fullscreen", "전체 화면", !!o.fullscreen)}
                 ${check("multimon", "다중 모니터", !!o.multimon)}
                 ${check("clipboard", "클립보드 공유", o.clipboard !== false)}
                 ${check("drives", "내 PC 드라이브 공유", !!o.drives)}
               </div>`
            : `<p class="muted small">내장 모드는 탭 크기가 바뀌면 원격 해상도도 따라 바뀝니다. 클립보드는 툴바의 "클립보드 입력"으로 텍스트를 보낼 수 있습니다.</p>`
        }
        ${gatewayField(o.gateway)}`;
    }
    case "vnc":
      return `<div class="check-grid">
          ${check("scale", "창 크기에 맞추기", o.scale !== false)}
          ${check("viewOnly", "보기 전용으로 시작", !!o.viewOnly)}
        </div>
        <label class="field"><span>화질</span><select name="opt.vncQuality">
          ${VNC_QUALITY.map(([v, l]) => `<option value="${v}" ${v === (o.vncQuality ?? "fast") ? "selected" : ""}>${l}</option>`).join("")}
        </select></label>
        ${gatewayField(o.gateway)}`;
    case "telnet":
      return `${keyModeField(o.keyMode, o.backspace)}
        ${check("pacedPaste", "콘솔 서버 연결 (여러 줄을 장비가 받아들이는 대로 한 줄씩 보냄)", !!o.pacedPaste)}
        ${gatewayField(o.gateway)}`;
    case "tftp":
      return `<p class="muted small">TFTP는 로그인과 폴더 목록이 없습니다. 탭에서 서버의 파일 이름을 적어 받거나 보냅니다. 사용자 이름은 쓰지 않습니다.</p>`;
    case "serial": {
      const st = serialSettings(o);
      const sel = (name: string, values: [string | number, string][], current: string | number) =>
        `<select name="opt.${name}">${values.map(([v, l]) => `<option value="${v}" ${String(v) === String(current) ? "selected" : ""}>${l}</option>`).join("")}</select>`;
      return `<div class="grid-2">
          <label class="field"><span>속도 (baud)</span>${sel("baud", BAUD_RATES.map((b) => [b, String(b)]), st.baud)}</label>
          <label class="field"><span>데이터 비트</span>${sel("dataBits", [[8, "8"], [7, "7"], [6, "6"], [5, "5"]], st.dataBits)}</label>
          <label class="field"><span>패리티</span>${sel("parity", [["none", "없음"], ["even", "짝수 (Even)"], ["odd", "홀수 (Odd)"]], st.parity)}</label>
          <label class="field"><span>정지 비트</span>${sel("stopBits", [[1, "1"], [2, "2"]], st.stopBits)}</label>
          <label class="field span-2"><span>흐름 제어</span>${sel("flow", [["none", "없음 (대부분의 장비 콘솔)"], ["hardware", "하드웨어 (RTS/CTS)"], ["software", "소프트웨어 (XON/XOFF)"]], st.flow)}</label>
        </div>
        ${keyModeField(o.keyMode ?? "network", o.backspace)}
        <p class="muted small">Cisco 등 장비 콘솔의 일반 설정은 9600 · 8 · 없음 · 1 · 흐름 제어 없음입니다. 툴바의 Break 버튼으로 Break 신호를 보낼 수 있습니다.</p>`;
    }
    default:
      return `<p class="muted small">이 프로토콜은 추가 옵션이 없습니다.</p>`;
  }
}

/** Form name of a per-session log field: path → opt.logPath. */
const logName = (k: string) => `opt.log${k[0].toUpperCase()}${k.slice(1)}`;

/** Log settings for terminal sessions: the app defaults, or this session's own. */
function logSection(s: Session): string {
  if (PROTOCOLS[s.protocol].view !== "terminal") return "";
  const o = s.options;
  const g = state.settings;
  const own = o.logCustom === "session";
  return `<details class="advanced" ${own ? "open" : ""}><summary>로그</summary>
      <label class="field"><span>로그 설정</span><select name="opt.logCustom">
        <option value="" ${own ? "" : "selected"}>기본 설정 사용 (설정 → 로그)</option>
        <option value="session" ${own ? "selected" : ""}>이 세션 전용으로 지정</option></select></label>
      <div class="log-session">${logFields(
        {
          path: String(o.logPath ?? "") || g.logTemplate,
          mode: (o.logMode as "append" | "overwrite" | "unique") || "append",
          linePrefix: String(o.logLinePrefix ?? ""),
          midnight: !!o.logMidnight,
          onConnect: String(o.logOnConnect ?? ""),
          onDisconnect: String(o.logOnDisconnect ?? ""),
          auto: !!o.logAuto,
        },
        logName,
        "이 세션은 연결하면 자동으로 기록",
      )}</div>
    </details>`;
}

/** How Delete/Home/End are sent: VT sequences, or the control keys network
 * gear (Cisco IOS and others) understands; and what Backspace sends. */
function keyModeField(current: unknown, backspace: unknown): string {
  const network = current === "network";
  const bs = backspace === "ctrl-h" || backspace === "del" ? backspace : "";
  return `<div class="grid-2">
      <label class="field"><span>키 입력 방식</span><select name="opt.keyMode">
        <option value="standard" ${!network ? "selected" : ""}>표준 (리눅스·유닉스 서버)</option>
        <option value="network" ${network ? "selected" : ""}>네트워크 장비 (Cisco IOS 등: Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E)</option>
      </select></label>
      <label class="field"><span>Backspace 키</span><select name="opt.backspace">
        <option value="" ${bs === "" ? "selected" : ""}>자동 (AIX·HP-UX는 ^H, 그 밖에는 DEL)</option>
        <option value="del" ${bs === "del" ? "selected" : ""}>DEL (^?) — 리눅스·네트워크 장비</option>
        <option value="ctrl-h" ${bs === "ctrl-h" ? "selected" : ""}>Ctrl-H (^H) — AIX·HP-UX 등 (지울 때 ^? 가 찍히면)</option>
      </select></label>
    </div>`;
}

/** Session fields the editor form sets; the rest (id, createdAt, lastUsed) it never touches. */
const EDITED_FIELDS = ["name", "protocol", "host", "port", "username", "credentialId", "folder", "notes"] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `current` with the changes made in the form (`before` → `after`) applied:
 * a field or option the user left alone keeps whatever is stored now. */
function applyEdits(before: Session, after: Session, current: Session): Session {
  const out = structuredClone(current);
  for (const k of EDITED_FIELDS) if (!same(before[k], after[k])) Object.assign(out, { [k]: after[k] });
  for (const k of new Set([...Object.keys(before.options), ...Object.keys(after.options)])) {
    if (same(before.options[k], after.options[k])) continue;
    if (k in after.options) out.options[k] = after.options[k];
    else delete out.options[k];
  }
  return out;
}

/** Open the editor. Resolves with the saved session and whether to connect now. */
export function editSession(
  existing: Session | null,
  defaults: Partial<Session> = {},
): Promise<{ session: Session; connect: boolean } | null> {
  return new Promise((resolve) => {
    const s: Session = existing ? structuredClone(existing) : { ...newSession(defaults.protocol ?? "ssh"), ...defaults };
    /** The record as the form first showed it; save compares against it. */
    const original = existing ? structuredClone(existing) : null;
    let result: { session: Session; connect: boolean } | null = null;

    const m = modal({
      title: existing ? "세션 편집" : "새 세션",
      icon: existing ? "Pencil" : "Plus",
      width: 720,
      body: `<div class="editor">
          <nav class="proto-pick">${PROTOCOL_ORDER.map((p) => {
            const info = PROTOCOLS[p];
            return `<button type="button" data-proto="${p}" style="--proto:${info.color}">
              <span class="pp-icon">${icon(info.icon, 18)}</span>
              <span class="pp-text"><b>${info.label}</b><small>${info.desc}</small></span></button>`;
          }).join("")}</nav>
          <form class="form editor-form" autocomplete="off"></form>
        </div>`,
      footer: `<button class="btn" data-close>취소</button>
               <button class="btn" data-save>저장</button>
               <button class="btn btn-primary" data-connect>${icon("Play", 14)}저장 후 연결</button>`,
      onClose: () => resolve(result),
    });
    const form = m.root.querySelector<HTMLFormElement>(".editor-form")!;

    const render = () => {
      const info = PROTOCOLS[s.protocol];
      m.root.querySelectorAll<HTMLElement>("[data-proto]").forEach((b) => b.classList.toggle("on", b.dataset.proto === s.protocol));
      const creds = state.credentials;
      const serial = s.protocol === "serial";
      form.innerHTML = serial
        ? `
        <div class="grid-2">
          <label class="field span-2"><span>세션 이름</span>
            <input name="name" value="${esc(s.name)}" placeholder="예: 코어 스위치 콘솔" /></label>
          <label class="field span-2"><span>COM 포트 <em>*</em></span>
            <div class="inline"><input name="host" value="${esc(s.host)}" list="com-list" placeholder="COM3" spellcheck="false" required />
              <datalist id="com-list"></datalist>
              <button type="button" class="btn" data-scan>${icon("RefreshCw", 14)}포트 찾기</button></div>
            <small class="muted com-found"></small></label>
          <input type="hidden" name="port" value="" />
          <label class="field span-2"><span>폴더</span>
            <input name="folder" value="${esc(s.folder)}" list="folder-list" placeholder="예: 운영/웹서버 (슬래시로 하위 폴더)" />
            <datalist id="folder-list">${allFolders().map((f) => `<option value="${esc(f)}">`).join("")}</datalist></label>
        </div>
        <details class="advanced" open><summary>${info.label} 옵션</summary>${optionsFields(s.protocol, s.options)}</details>
        ${logSection(s)}
        <label class="field"><span>메모</span><textarea name="notes" rows="2" placeholder="이 장비에 대한 메모">${esc(s.notes)}</textarea></label>`
        : `
        <div class="grid-2">
          <label class="field span-2"><span>세션 이름</span>
            <input name="name" value="${esc(s.name)}" placeholder="예: 운영 웹서버" /></label>
          <label class="field span-2"><span>호스트 <em>*</em></span>
            <input name="host" value="${esc(s.host)}" placeholder="192.168.0.10 또는 server.example.com" spellcheck="false" required /></label>
          <label class="field"><span>포트</span>
            <input name="port" type="number" min="1" max="65535" value="${esc(s.port ?? info.port)}" /></label>
          <label class="field"><span>사용자 이름</span>
            <input name="username" value="${esc(s.username)}" placeholder="${s.protocol === "ftp" || s.protocol === "ftps" ? "비우면 anonymous" : s.protocol === "rdp" ? "Administrator 또는 DOMAIN\\사용자" : "root"}" spellcheck="false" /></label>
          <label class="field span-2"><span>자격 증명</span>
            <div class="inline">
              <select name="credentialId">
                <option value="">사용 안 함 (접속할 때 입력)</option>
                ${creds.map((c) => `<option value="${c.id}" title="${c.kind === "key" ? "키" : "비밀번호"}${c.username ? ` · ${esc(c.username)}` : ""}" ${c.id === s.credentialId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
              </select>
              <button type="button" class="btn" data-vault>${icon("KeyRound", 14)}관리</button>
            </div></label>
          <label class="field span-2"><span>폴더</span>
            <input name="folder" value="${esc(s.folder)}" list="folder-list" placeholder="예: 운영/웹서버 (슬래시로 하위 폴더)" />
            <datalist id="folder-list">${allFolders().map((f) => `<option value="${esc(f)}">`).join("")}</datalist></label>
        </div>
        <details class="advanced" open><summary>${info.label} 옵션</summary>${optionsFields(s.protocol, s.options)}</details>
        ${proxyFields(s)}
        ${logSection(s)}
        <label class="field"><span>메모</span><textarea name="notes" rows="2" placeholder="이 서버에 대한 메모">${esc(s.notes)}</textarea></label>`;
      wireLogBrowse(form, logName);
      const custom = form.querySelector<HTMLSelectElement>("[name='opt.logCustom']");
      const syncLog = () => form.querySelector<HTMLElement>(".log-session")?.toggleAttribute("hidden", custom?.value !== "session");
      custom?.addEventListener("change", syncLog);
      syncLog();
      form.querySelector("[data-vault]")?.addEventListener("click", async () => {
        collect();
        await openVault();
        render();
      });
      // Serial: list the COM ports present now.
      const scan = async () => {
        const found = form.querySelector<HTMLElement>(".com-found");
        const list = form.querySelector<HTMLElement>("#com-list");
        if (!found || !list) return;
        try {
          const ports = await api.serialPorts();
          list.innerHTML = ports.map((p) => `<option value="${esc(p.name)}">${esc(p.description)}</option>`).join("");
          found.textContent = ports.length
            ? `이 PC의 포트: ${ports.map((p) => p.name + (p.description ? ` (${p.description})` : "")).join(", ")}`
            : "찾은 COM 포트가 없습니다. USB 콘솔 케이블과 드라이버를 확인하세요.";
          const host = form.querySelector<HTMLInputElement>("[name=host]")!;
          if (!host.value && ports.length === 1) host.value = ports[0].name;
        } catch (err) {
          found.textContent = errorText(err);
        }
      };
      form.querySelector("[data-scan]")?.addEventListener("click", scan);
      if (serial) scan();
      // Options that change which other fields apply.
      form.querySelectorAll<HTMLSelectElement>("[data-rerender]").forEach((el) =>
        el.addEventListener("change", () => {
          collect();
          render();
        }),
      );
      // FTPS: keep the port in step with explicit (21) / implicit (990) TLS.
      form.querySelector<HTMLSelectElement>("[name='opt.ftpsMode']")?.addEventListener("change", (e) => {
        const mode = (e.target as HTMLSelectElement).value;
        const portInput = form.querySelector<HTMLInputElement>("[name=port]")!;
        const previous = defaultPort("ftps", { ftpsMode: mode === "implicit" ? "explicit" : "implicit" });
        if (Number(portInput.value) === previous) portInput.value = String(defaultPort("ftps", { ftpsMode: mode }));
      });
    };

    /** Set by collect() when the port field holds something that is not a port. */
    let badPort = false;
    const collect = () => {
      const data = new FormData(form);
      s.name = String(data.get("name") ?? "").trim();
      s.host = String(data.get("host") ?? "").trim();
      const rawPort = String(data.get("port") ?? "").trim();
      const port = Number(rawPort);
      badPort = rawPort !== "" && !(Number.isInteger(port) && port >= 1 && port <= 65535);
      s.username = String(data.get("username") ?? "").trim();
      s.credentialId = String(data.get("credentialId") ?? "") || null;
      s.folder = normalizeFolder(data.get("folder"));
      s.notes = String(data.get("notes") ?? "");
      // Start from the stored options: the form shows only some of them (the
      // TFTP tab keeps its block size here, RDP hides drive/monitor options in
      // external mode), and those must survive an edit.
      const opts: Record<string, unknown> = { ...s.options };
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[name^='opt.']").forEach((el) => {
        const key = el.name.slice(4);
        if (el instanceof HTMLInputElement && el.type === "checkbox") opts[key] = el.checked;
        else if (el instanceof HTMLInputElement && el.type === "number") {
          // Whole numbers within the field's own limits (the backend expects u32/u16).
          const n = Math.trunc(Number(el.value)) || 0;
          const min = el.min === "" ? -Infinity : Number(el.min);
          const max = el.max === "" ? Infinity : Number(el.max);
          opts[key] = Math.min(max, Math.max(min, n));
        } else opts[key] = el.value;
      });
      s.options = opts;
      s.port = rawPort === "" || badPort ? defaultPort(s.protocol, s.options) : port;
    };

    m.root.querySelectorAll<HTMLElement>("[data-proto]").forEach((b) =>
      b.addEventListener("click", () => {
        collect();
        const next = b.dataset.proto as Protocol;
        // Swap a default port (including FTPS implicit 990) for the new protocol's default.
        if (s.port === defaultPort(s.protocol, s.options)) s.port = PROTOCOLS[next].port;
        // The proxy is not tied to the protocol: it stays.
        if (next !== s.protocol) s.options = proxyOptions(s.options);
        s.protocol = next;
        render();
      }),
    );

    const save = async (connect: boolean) => {
      collect();
      if (badPort) {
        toast("포트는 1부터 65535 사이의 정수여야 합니다", "warn");
        form.querySelector<HTMLInputElement>("[name=port]")?.focus();
        return;
      }
      const proxyIssue = proxyProblem(s);
      if (proxyIssue) {
        toast(proxyIssue, "warn");
        form.querySelector<HTMLInputElement>("[name='opt.proxyHost'], [name='opt.proxyLocalCommand']")?.focus();
        return;
      }
      if (s.protocol === "serial") {
        s.host = s.host.toUpperCase();
        s.port = null;
        s.username = "";
        s.credentialId = null;
        if (!/^COM\d{1,3}$/.test(s.host)) {
          toast("COM 포트 이름을 입력하세요 (예: COM3)", "warn");
          form.querySelector<HTMLInputElement>("[name=host]")?.focus();
          return;
        }
      }
      if (!s.host) {
        toast("호스트를 입력하세요", "warn");
        form.querySelector<HTMLInputElement>("[name=host]")?.focus();
        return;
      }
      if (!s.name) s.name = s.host;
      let saved = s;
      if (original) {
        // The stored record may have changed while the dialog was open (a
        // credential linked from a tab, a certificate accepted, lastUsed) or
        // been deleted: apply only what was edited here, and never revive it.
        const current = state.sessions.find((x) => x.id === original.id);
        if (!current) {
          toast("편집하는 동안 삭제된 세션이라 저장하지 않았습니다", "warn");
          m.close();
          return;
        }
        saved = applyEdits(original, s, current);
      }
      await upsertSession(saved);
      result = { session: saved, connect };
      m.close();
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      save(true);
    });
    m.root.querySelector("[data-save]")!.addEventListener("click", () => save(false));
    m.root.querySelector("[data-connect]")!.addEventListener("click", () => save(true));
    render();
    setTimeout(() => form.querySelector<HTMLInputElement>(s.host ? "[name=name]" : "[name=host]")?.focus(), 40);
  });
}
