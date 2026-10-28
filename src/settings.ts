// Settings dialog.

import { api, revealInExplorer } from "./api";
import { icon } from "./icons";
import { state, updateSettings, type Settings, type TriggerRule } from "./store";
import { appLock, openMasterPassword } from "./lock";
import { LIGHT_THEMES, TERM_THEMES } from "./themes";
import { confirmDialog, esc, modal, toast } from "./ui";
import { clearCommandHistory, commandHistoryCount } from "./cmdLine";
import { aiSettingsSection, wireAiSettings } from "./ai/settings";
import { checkForUpdate } from "./updates";
import { compile, DEFAULT_RISK_RULES, riskRules, type RiskRule } from "./riskRules";
import { isLanguage, LANGUAGES, language as shownLanguage } from "./i18n";
import { logFields, runnableLogName, wireLogBrowse } from "./logOptions";

const FONTS = [
  ["'Cascadia Mono', Consolas, 'D2Coding', monospace", "Cascadia Mono"],
  ["Consolas, 'D2Coding', monospace", "Consolas"],
  ["'D2Coding', Consolas, monospace", "D2Coding"],
  ["'Courier New', monospace", "Courier New"],
];

/** Theme cards: a prompt preview plus the theme's eight main colors. */
function themeOptions(light: boolean, current: string): string {
  return Object.entries(TERM_THEMES)
    .filter(([key]) => LIGHT_THEMES.has(key) === light)
    .map(([key, t]) => {
      const c = t.theme;
      const dots = [c.red, c.green, c.yellow, c.blue, c.magenta, c.cyan, c.white, c.brightBlack]
        .map((color) => `<i class="dot" style="background:${color}"></i>`)
        .join("");
      return `<label class="theme-opt"><input type="radio" name="terminalTheme" value="${key}" ${key === current ? "checked" : ""}/>
        <span class="swatch" style="background:${c.background};color:${c.foreground}">
          <span class="swatch-line"><b style="color:${c.green}">$</b> ls <em style="color:${c.blue}">src</em></span>
          <span class="dots">${dots}</span></span><small>${esc(t.label)}</small></label>`;
    })
    .join("");
}

/** Settings pages, in menu order: the section id, its menu label and icon. */
const PAGES: { id: string; label: string; icon: string }[] = [
  { id: "general", label: "일반", icon: "Globe" },
  { id: "terminal", label: "터미널", icon: "SquareTerminal" },
  { id: "shortcuts", label: "단축키", icon: "Keyboard" },
  { id: "security", label: "보안", icon: "LockKeyhole" },
  { id: "session", label: "세션", icon: "Server" },
  { id: "risk", label: "위험 명령", icon: "ShieldAlert" },
  { id: "trigger", label: "트리거", icon: "Bell" },
  { id: "ai", label: "AI", icon: "Sparkles" },
  { id: "log", label: "로그", icon: "ScrollText" },
  { id: "update", label: "업데이트", icon: "RefreshCw" },
];

/** Split the settings form into pages at its section headings, with a menu
 * on the left; the fields stay in the one form, so saving is unchanged. */
function paginate(form: HTMLFormElement, start: string | undefined) {
  const pages = new Map<string, HTMLElement>();
  let current = document.createElement("div");
  current.className = "settings-page";
  current.dataset.page = "general";
  pages.set("general", current);
  for (const node of [...form.childNodes]) {
    const id = node instanceof HTMLElement && node.tagName === "H4" ? node.dataset.section : undefined;
    if (id) {
      current = document.createElement("div");
      current.className = "settings-page";
      current.dataset.page = id;
      pages.set(id, current);
    }
    current.append(node);
  }
  const nav = document.createElement("nav");
  nav.className = "settings-nav";
  nav.setAttribute("aria-label", "설정 항목");
  nav.innerHTML = PAGES.filter((p) => pages.has(p.id))
    .map((p) => `<button type="button" data-page="${p.id}">${icon(p.icon, 15)}<span>${p.label}</span></button>`)
    .join("");
  const body = document.createElement("div");
  body.className = "settings-pages";
  body.append(...pages.values());
  form.replaceChildren(nav, body);
  form.classList.add("paged");
  const show = (id: string) => {
    if (!pages.has(id)) id = "general";
    pages.forEach((el, key) => (el.hidden = key !== id));
    nav.querySelectorAll<HTMLElement>("[data-page]").forEach((b) => b.classList.toggle("on", b.dataset.page === id));
    body.scrollTop = 0;
    try {
      localStorage.setItem("bx.settingsPage", id);
    } catch {
      /* storage blocked: the menu still works */
    }
  };
  nav.addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-page]")?.dataset.page;
    if (id) show(id);
  });
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem("bx.settingsPage");
  } catch {
    /* ignore */
  }
  show(start ?? remembered ?? "general");
}

/** Show the settings page holding this field (a refused save points at it). */
function revealPage(el: Element | null | undefined) {
  const page = el?.closest<HTMLElement>(".settings-page")?.dataset.page;
  if (page) el!.closest("form")?.querySelector<HTMLElement>(`.settings-nav [data-page="${page}"]`)?.click();
}

/** `section`: open at that page (e.g. "update" from the update login guide). */
export function openSettings(section?: "update" | "risk" | "shortcuts" | "ai") {
  const s = state.settings;
  const passwords = state.credentials.filter((c) => c.kind === "password");
  const check = (name: keyof Settings, label: string, hint: string) =>
    `<label class="check block"><input type="checkbox" name="${name}" ${s[name] ? "checked" : ""}/>
       <span><b>${label}</b><small>${hint}</small></span></label>`;
  const m = modal({
    title: "설정",
    icon: "Settings",
    width: 860,
    body: `<form class="form settings">
        <div class="lang-row"><span>화면 언어 <span data-i18n-skip>(LANGUAGE)</span><small>고르기 전에는 Windows 표시 언어를 따릅니다</small></span>
          <select class="lang-select" name="uiLanguage" aria-label="화면 언어" data-i18n-skip>
            ${LANGUAGES.map(([code, name]) => `<option value="${code}" ${code === shownLanguage() ? "selected" : ""}>${name}</option>`).join("")}
          </select></div>
        <h4 data-section="terminal">터미널</h4>
        <div class="field"><span>색 테마 — 어두운 배경</span>
          <div class="theme-pick">${themeOptions(false, s.terminalTheme)}</div></div>
        <div class="field"><span>색 테마 — 밝은 배경</span>
          <div class="theme-pick">${themeOptions(true, s.terminalTheme)}</div></div>
        <div class="grid-2">
          <label class="field"><span>글꼴</span><select name="fontFamily">
            ${FONTS.map(([v, l]) => `<option value="${esc(v)}" ${v === s.fontFamily ? "selected" : ""}>${l}</option>`).join("")}
          </select></label>
          <label class="field"><span>글자 크기</span><input name="fontSize" type="number" min="8" max="32" value="${s.fontSize}"/></label>
          <label class="field"><span>커서 모양</span><select name="cursorStyle">
            ${[["block", "블록"], ["bar", "세로 막대"], ["underline", "밑줄"]].map(([v, l]) => `<option value="${v}" ${v === s.cursorStyle ? "selected" : ""}>${l}</option>`).join("")}
          </select></label>
          <label class="field"><span>스크롤백 (줄)</span><input name="scrollback" type="number" min="1000" max="200000" step="1000" value="${s.scrollback}"/></label>
          <label class="field"><span>화면 그리기</span><select name="renderer">
            ${[["auto", "자동 (그래픽 카드가 있으면 GPU 가속)"], ["webgl", "항상 GPU 가속 (WebGL)"], ["dom", "기본 (GPU 사용 안 함)"]].map(([v, l]) => `<option value="${v}" ${v === s.renderer ? "selected" : ""}>${l}</option>`).join("")}
          </select></label>
        </div>
        ${check("cmdColor", "입력 중인 명령에 색 입히기", "명령어·옵션·문자열·경로·연결 기호를 색으로 구분합니다. 위험 명령 규칙에 걸리는 명령은 Enter를 누르기 전에 빨간색으로 보입니다. 서버가 직접 색을 입히는 셸(zsh 강조 등)에는 적용하지 않습니다.")}
        ${check("lsColor", "ls 목록에 파일 종류별 색 입히기", "서버가 색을 입히지 않는 ls(AIX, HP-UX, Solaris 등)의 폴더·실행 파일·링크·압축 파일을 Linux처럼 색으로 구분합니다. ls -l과 ls -F는 출력만 보고, 그냥 ls는 리소스 모니터 연결로 폴더 내용을 따로 읽어 판단합니다. 터미널에는 아무 명령도 보내지 않습니다.")}
        ${check("cmdSuggest", "명령 자동 완성 제안", "전에 실행한 명령과 스니펫에서 나머지를 회색으로 보여 줍니다. → 또는 End로 모두, Ctrl+→로 한 단어씩 입력합니다. Tab은 서버의 자동 완성 그대로입니다. 위험 명령과 비밀번호·토큰이 든 명령은 기록하지도 제안하지도 않습니다.")}
        <div class="row"><button type="button" class="btn btn-sm" data-clear-history>${icon("Trash2", 14)}명령 기록 지우기</button></div>
        ${check("highlightKeywords", "출력 키워드 강조", "ERROR·FAIL은 빨강, WARN은 노랑, OK·SUCCESS는 초록으로 표시합니다. 색을 직접 쓰는 프로그램과 vim 같은 전체 화면 프로그램에는 적용하지 않습니다.")}
        ${check("copyOnSelect", "선택하면 바로 복사", "PuTTY처럼 드래그로 선택한 글자를 클립보드에 복사합니다.")}
        ${check("rightClickPaste", "오른쪽 클릭으로 붙여넣기", "터미널에서 오른쪽 버튼을 누르면 클립보드 내용을 붙여넣습니다.")}
        ${check("confirmMultiPaste", "여러 줄을 붙여넣기 전에 확인", "두 줄 이상을 붙여넣거나 텍스트 파일을 보낼 때 내용을 미리 보여 주고 보낼지 묻습니다.")}
        <div class="grid-2">
          <label class="field span-2"><span>장비 콘솔에 여러 줄 보내기 (시리얼 · 콘솔 서버 텔넷)</span><select name="pasteMode">
            ${[["echo", "장비가 줄을 받아들이는 대로 (권장)"], ["fixed", "정해진 지연으로"]].map(([v, l]) => `<option value="${v}" ${v === s.pasteMode ? "selected" : ""}>${l}</option>`).join("")}
          </select></label>
          <label class="field"><span>줄 지연 (ms)</span><input name="pasteLineDelay" type="number" min="0" max="5000" value="${s.pasteLineDelay}"/></label>
          <label class="field"><span>글자 지연 (ms)</span><input name="pasteCharDelay" type="number" min="0" max="200" value="${s.pasteCharDelay}"/></label>
        </div>
        <p class="muted small">권장 방식은 한 줄을 보낸 뒤 장비가 그 줄을 되돌려 보내고 프롬프트를 다시 띄우면 바로 다음 줄을 보냅니다. 빠른 장비에는 빠르게, 느린 장비에는 기다렸다가 보내므로 글자가 빠지지 않습니다. 줄 지연과 글자 지연은 "정해진 지연으로"를 고를 때 쓰입니다 (입력을 되돌려 보내지 않는 장비용).</p>
        ${check("serialAutoReconnect", "시리얼 포트가 빠지면 다시 꽂힐 때까지 기다렸다가 자동으로 연결", "USB 시리얼 어댑터를 뽑았다 꽂거나, 연결할 때 아직 꽂혀 있지 않으면 포트가 나타나는 대로 연결합니다.")}
        ${check("autoReconnect", "SSH·Telnet 연결이 끊기면 자동으로 다시 연결", "네트워크가 끊기거나 세션이 예기치 않게 종료되면 잠시 기다렸다가 자동으로 다시 연결합니다. 기다리는 동안 취소할 수 있고, 사용자가 종료한 연결은 다시 연결하지 않습니다.")}
        <label class="field"><span>시리얼 포트 입출력</span><select name="serialIo">
          ${[["fast", "빠르게 (권장) — 키 입력이 읽기 대기에 막히지 않음"], ["compat", "호환 모드 — 이전 방식 (드라이버에 문제가 있을 때)"]].map(([v, l]) => `<option value="${v}" ${v === s.serialIo ? "selected" : ""}>${l}</option>`).join("")}
        </select></label>
        <h4 data-section="shortcuts">단축키</h4>
        <div class="row"><button type="button" class="btn" data-shortcuts>${icon("Keyboard", 14)}단축키 보기·바꾸기</button>
          <span class="muted small">지금 쓰는 모든 단축키를 보고 바꾸거나, 단축키가 없는 동작과 스니펫에 새로 지정합니다.</span></div>
        <h4 data-section="security">보안</h4>
        <div class="grid-2">
          <div class="field"><span>마스터 비밀번호</span>
            <button type="button" class="btn" data-master>${icon("LockKeyhole", 14)}${appLock.enabled ? "바꾸기·해제" : "설정"}</button></div>
          <label class="field"><span>자리 비움 자동 잠금 (분, 0 = 사용 안 함)</span><input name="autoLockMinutes" type="number" min="0" max="1440" value="${s.autoLockMinutes}"/></label>
        </div>
        <h4 data-section="session">세션</h4>
        ${check("sftpWithSsh", "SSH 연결 시 SFTP 파일 창을 옆에 함께 열기", "SSH 터미널 옆 칸에 같은 서버의 파일 브라우저를 엽니다. 터미널 툴바의 \"파일\" 버튼으로도 열 수 있습니다.")}
        ${check("remoteMonitor", "SSH·Telnet 접속 대상의 CPU·메모리를 상태 표시줄에 표시", "탭마다 연결을 하나 더 열어 읽기 전용 명령으로 확인합니다. 리눅스는 2초, 네트워크 장비는 15초, AIX·HP-UX는 10초마다 읽고, 그 장비의 탭이 화면에 없으면 멈춥니다. 터미널 화면에는 아무것도 입력하지 않습니다.")}
        ${check("confirmClose", "연결된 탭을 닫을 때 확인", "실수로 연결을 끊지 않도록 묻습니다.")}
        <h4 data-section="risk">위험 명령</h4>
        <p class="muted small">보내는 내용을 줄마다 정규식(대소문자 무시)으로 검사합니다. <b>차단</b>: 보내지 않습니다. <b>경고</b>: 확인한 뒤에만 보내고, 그 탭의 로그를 켜며 위험 명령 기록(risky-commands.log)에 남깁니다.</p>
        ${check("checkTypedCommands", "직접 입력한 명령도 검사", "Enter를 누를 때 화면에 보이는 명령 줄을 같은 규칙으로 검사합니다. 명령 기록(↑↓)이나 Tab 자동 완성으로 만든 명령도 검사하고, vi·less처럼 화면 전체를 쓰는 프로그램 안에서는 검사하지 않습니다.")}
        <div class="risk-rules" data-risk-rules></div>
        <div class="row">
          <button type="button" class="btn btn-sm" data-risk-add>${icon("Plus", 14)}규칙 추가</button>
          <button type="button" class="btn btn-sm" data-risk-reset>${icon("RefreshCw", 14)}기본 규칙으로</button>
          <button type="button" class="btn btn-sm" data-risk-log>${icon("FolderOpen", 14)}위험 명령 기록 보기</button>
        </div>
        <h4 data-section="trigger">트리거</h4>
        <p class="muted small">터미널 출력을 줄마다 정규식으로 검사해, 맞으면 동작을 실행합니다. 알림은 토스트로 알리고, 소리는 짧은 소리를 내며, 자동 응답은 정해 둔 텍스트를 터미널로 보냅니다(줄바꿈은 \\n, 탭은 \\t). 예를 들어 묻는 말에 자동으로 응답을 보낼 수 있습니다.</p>
        <div class="risk-rules" data-trigger-rules></div>
        <div class="row">
          <button type="button" class="btn btn-sm" data-trigger-add>${icon("Plus", 14)}트리거 추가</button>
        </div>
        ${aiSettingsSection(check)}
        <h4 data-section="log">로그 (기본값 · 세션마다 따로 정할 수도 있습니다)</h4>
        ${logFields(
          {
            path: s.logTemplate,
            mode: s.logMode,
            linePrefix: s.logLinePrefix,
            midnight: s.logMidnight,
            onConnect: s.logOnConnect,
            onDisconnect: s.logOnDisconnect,
            auto: s.autoLog,
          },
          (k) => `log.${k}`,
          "모든 터미널 세션을 연결하면 자동으로 기록",
        )}
        ${check("logPrompt", "툴바의 로그 버튼으로 시작할 때 파일 이름 묻기", "SecureCRT의 Prompt for filename처럼 시작 전에 이름을 확인·수정할 수 있습니다.")}
        <div class="row"><button type="button" class="btn" data-logs>${icon("FolderOpen", 14)}기본 로그 폴더 열기</button></div>
        <h4 data-section="update">업데이트</h4>
        <p class="muted small">새 버전은 GitHub(github.com/NijG/bananaconn)에서 먼저 확인합니다. 보안 정책으로 GitHub에 접속할 수 없는 PC는 아래에 새 버전을 올려 두는 NAS 폴더를 지정하세요.</p>
        <label class="field"><span>NAS 업데이트 폴더 (GitHub에 접속할 수 없을 때, 예: \\\\NAS\\공유\\BananaConn)</span>
          <input name="updateFolder" value="${esc(s.updateFolder)}" spellcheck="false" autocomplete="off" placeholder="\\\\서버\\공유\\BananaConn"/></label>
        <label class="field"><span>NAS 계정 (공유 폴더가 Windows 계정을 받아 주지 않을 때 이 계정으로 로그인)</span><select name="updateCredentialId">
            <option value="">사용 안 함 (Windows 계정·저장된 자격 증명)</option>
            ${passwords.map((c) => `<option value="${esc(c.id)}" title="${esc(c.username)}" ${c.id === s.updateCredentialId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
          </select>${passwords.length ? "" : `<small class="muted">자격 증명 보관함에 NAS 계정(비밀번호 방식)을 먼저 추가하세요.</small>`}</label>
        ${check("autoUpdate", "새 버전 자동 확인 (시작할 때와 30분마다)", `새 버전이 있으면 설치할지 묻고, 상태 표시줄에도 업데이트 버튼이 나타납니다. 서명이 맞는 공식 빌드만 설치합니다.`)}
        <div class="row"><button type="button" class="btn" data-update-check>${icon("RefreshCw", 14)}지금 확인</button></div>
      </form>`,
    footer: `<button class="btn" data-close>취소</button><button class="btn btn-primary" data-save>${icon("Check", 14)}저장</button>`,
  });
  m.root.querySelector("[data-master]")!.addEventListener("click", () => openMasterPassword());
  m.root.querySelector("[data-shortcuts]")!.addEventListener("click", () => void import("./shortcuts").then((x) => x.openShortcuts()));
  paginate(m.root.querySelector<HTMLFormElement>("form.settings")!, section);
  // Applies at once (and is saved at once): the whole app switches language.
  m.root.querySelector<HTMLSelectElement>("[name=uiLanguage]")!.addEventListener("change", (e) => {
    const value = (e.target as HTMLSelectElement).value;
    if (isLanguage(value)) updateSettings({ uiLanguage: value });
  });
  wireLogBrowse(m.root, (k) => `log.${k}`);
  // Risky-command rules: edited here, saved with the other settings.
  let rules: RiskRule[] = riskRules().map((r) => ({ ...r }));
  const rulesEl = m.root.querySelector<HTMLElement>("[data-risk-rules]")!;
  const renderRules = () => {
    rulesEl.innerHTML = rules.length
      ? rules
          .map(
            (r, i) => `<div class="risk-rule" data-i="${i}">
              <select data-k="action"><option value="block" ${r.action === "block" ? "selected" : ""}>차단</option><option value="warn" ${r.action === "warn" ? "selected" : ""}>경고</option></select>
              <input data-k="pattern" class="mono${compile(r) ? "" : " invalid"}" value="${esc(r.pattern)}" spellcheck="false" placeholder="정규식, 예: ^\\s*reload\\b" />
              <input data-k="note" value="${esc(r.note)}" placeholder="설명" />
              <button type="button" class="icon-btn" data-del title="삭제">${icon("Trash2", 14)}</button></div>`,
          )
          .join("")
      : `<p class="muted small">규칙이 없습니다. 모든 스니펫이 확인 없이 전송됩니다.</p>`;
  };
  rulesEl.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const i = Number(el.closest<HTMLElement>("[data-i]")?.dataset.i);
    const k = el.dataset.k as keyof RiskRule | undefined;
    if (!k || !rules[i]) return;
    if (k === "action") rules[i].action = el.value === "block" ? "block" : "warn";
    else rules[i][k] = el.value;
    if (k === "pattern") el.classList.toggle("invalid", !compile(rules[i]));
  });
  rulesEl.addEventListener("click", (e) => {
    const del = (e.target as HTMLElement).closest("[data-del]");
    if (!del) return;
    rules.splice(Number(del.closest<HTMLElement>("[data-i]")!.dataset.i), 1);
    renderRules();
  });
  m.root.querySelector("[data-risk-add]")!.addEventListener("click", () => {
    rules.push({ action: "warn", pattern: "", note: "" });
    renderRules();
    rulesEl.querySelector<HTMLInputElement>(".risk-rule:last-child [data-k=pattern]")?.focus();
  });
  m.root.querySelector("[data-risk-reset]")!.addEventListener("click", () => {
    rules = DEFAULT_RISK_RULES.map((r) => ({ ...r }));
    renderRules();
  });
  // Output trigger rules: edited here, saved with the other settings.
  let trigs: TriggerRule[] = (s.triggers ?? []).map((t) => ({ ...t }));
  const trigEl = m.root.querySelector<HTMLElement>("[data-trigger-rules]")!;
  const safeRe = (p: string) => {
    try {
      new RegExp(p);
      return true;
    } catch {
      return false;
    }
  };
  const renderTrigs = () => {
    trigEl.innerHTML = trigs.length
      ? trigs
          .map(
            (t, i) => `<div class="risk-rule trigger-rule" data-i="${i}">
              <input type="checkbox" data-k="enabled" ${t.enabled ? "checked" : ""} title="사용" />
              <input data-k="pattern" class="mono${t.pattern && !safeRe(t.pattern) ? " invalid" : ""}" value="${esc(t.pattern)}" spellcheck="false" placeholder="정규식, 예: \\(yes/no\\)" />
              <select data-k="action"><option value="alert" ${t.action === "alert" ? "selected" : ""}>알림</option><option value="beep" ${t.action === "beep" ? "selected" : ""}>소리</option><option value="send" ${t.action === "send" ? "selected" : ""}>자동 응답</option></select>
              <input data-k="value" value="${esc(t.value ?? "")}" placeholder="보낼 텍스트 (자동 응답, 예: yes\\n)" ${t.action === "send" ? "" : "disabled"} />
              <button type="button" class="icon-btn" data-del title="삭제">${icon("Trash2", 14)}</button></div>`,
          )
          .join("")
      : `<p class="muted small">트리거가 없습니다.</p>`;
  };
  trigEl.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const i = Number(el.closest<HTMLElement>("[data-i]")?.dataset.i);
    const k = el.dataset.k as keyof TriggerRule | undefined;
    if (!k || !trigs[i]) return;
    if (k === "enabled") trigs[i].enabled = (el as HTMLInputElement).checked;
    else if (k === "action") {
      trigs[i].action = el.value as TriggerRule["action"];
      renderTrigs(); // the "send" text box enables/disables
    } else if (k === "pattern") {
      trigs[i].pattern = el.value;
      el.classList.toggle("invalid", !!el.value && !safeRe(el.value));
    } else if (k === "value") trigs[i].value = el.value;
  });
  trigEl.addEventListener("click", (e) => {
    const del = (e.target as HTMLElement).closest("[data-del]");
    if (!del) return;
    trigs.splice(Number(del.closest<HTMLElement>("[data-i]")!.dataset.i), 1);
    renderTrigs();
  });
  m.root.querySelector("[data-trigger-add]")!.addEventListener("click", () => {
    trigs.push({ pattern: "", action: "alert", value: "", enabled: true });
    renderTrigs();
    trigEl.querySelector<HTMLInputElement>(".trigger-rule:last-child [data-k=pattern]")?.focus();
  });
  renderTrigs();
  wireAiSettings(m.root);
  m.root.querySelector("[data-clear-history]")!.addEventListener("click", async () => {
    const n = commandHistoryCount();
    if (!n) return toast("지울 명령 기록이 없습니다", "info");
    const ok = await confirmDialog({ title: "명령 기록 지우기", icon: "Trash2", danger: true, message: `<p>자동 완성에 쓰는 명령 기록 ${n}개를 모두 지웁니다.</p>`, confirm: "지우기", cancel: "취소", focusCancel: true });
    if (!ok) return;
    clearCommandHistory();
    toast("명령 기록을 지웠습니다", "success");
  });
  m.root.querySelector("[data-risk-log]")!.addEventListener("click", async () => {
    try {
      const folder = await api.logsFolder();
      // Before the first risky command there is no file yet: show the folder.
      await revealInExplorer(`${folder}\\risky-commands.log`).catch(() => revealInExplorer(folder));
    } catch (err) {
      toast(String(err), "error");
    }
  });
  renderRules();
  m.root.querySelector("[data-update-check]")!.addEventListener("click", () => {
    // Check the folder as typed, and keep it.
    updateSettings({
      updateFolder: m.root.querySelector<HTMLInputElement>("[name=updateFolder]")!.value.trim(),
      updateCredentialId: m.root.querySelector<HTMLSelectElement>("[name=updateCredentialId]")!.value || null,
    });
    checkForUpdate(true);
  });
  m.root.querySelector("[data-logs]")!.addEventListener("click", async () => {
    try {
      await revealInExplorer(await api.logsFolder());
    } catch (err) {
      toast(String(err), "error");
    }
  });
  m.root.querySelector("[data-save]")!.addEventListener("click", () => {
    const form = m.root.querySelector("form")!;
    const val = (n: string) => form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${n}"]`)!;
    const bool = (n: string) => (val(n) as HTMLInputElement).checked;
    // A rule that does not compile never matches: saving it would quietly
    // turn off, say, the NTP block.
    const broken = rules.findIndex((r) => r.pattern.trim() && !compile(r));
    if (broken >= 0) {
      const input = rulesEl.querySelector<HTMLInputElement>(`[data-i="${broken}"] [data-k=pattern]`);
      input?.classList.add("invalid");
      revealPage(input);
      input?.scrollIntoView({ block: "center" });
      input?.focus();
      return toast("정규식이 잘못된 위험 명령 규칙이 있어 저장하지 않았습니다. 빨간 칸을 고치거나 지우세요", "error");
    }
    if (runnableLogName(val("log.path").value)) {
      revealPage(val("log.path"));
      val("log.path").focus();
      return toast("로그 파일 이름에 실행되는 확장자(.bat, .exe 등)는 쓸 수 없습니다", "error");
    }
    updateSettings({
      fontFamily: val("fontFamily").value,
      fontSize: Math.max(8, Math.min(32, Number(val("fontSize").value) || 14)),
      cursorStyle: val("cursorStyle").value as Settings["cursorStyle"],
      scrollback: Math.max(1000, Math.min(200000, Number(val("scrollback").value) || 10000)),
      renderer: val("renderer").value as Settings["renderer"],
      copyOnSelect: bool("copyOnSelect"),
      rightClickPaste: bool("rightClickPaste"),
      confirmMultiPaste: bool("confirmMultiPaste"),
      pasteMode: val("pasteMode").value === "fixed" ? "fixed" : "echo",
      pasteLineDelay: Math.max(0, Math.min(5000, Math.trunc(Number(val("pasteLineDelay").value)) || 0)),
      pasteCharDelay: Math.max(0, Math.min(200, Math.trunc(Number(val("pasteCharDelay").value)) || 0)),
      serialAutoReconnect: bool("serialAutoReconnect"),
      autoReconnect: bool("autoReconnect"),
      // Keep enabled rules and any with a pattern; a blank-pattern rule is dropped.
      triggers: trigs.filter((t) => t.pattern.trim()).map((t) => ({ pattern: t.pattern.trim(), action: t.action, value: t.action === "send" ? (t.value ?? "") : undefined, enabled: t.enabled })),
      serialIo: val("serialIo").value === "compat" ? "compat" : "fast",
      autoLog: bool("log.auto"),
      logTemplate: val("log.path").value.trim() || "%S_%Y%M%D_%h%m%s.log",
      logMode: val("log.mode").value as Settings["logMode"],
      logLinePrefix: val("log.linePrefix").value,
      logMidnight: bool("log.midnight"),
      logOnConnect: val("log.onConnect").value,
      logOnDisconnect: val("log.onDisconnect").value,
      logPrompt: bool("logPrompt"),
      sftpWithSsh: bool("sftpWithSsh"),
      remoteMonitor: bool("remoteMonitor"),
      confirmClose: bool("confirmClose"),
      updateFolder: val("updateFolder").value.trim(),
      updateCredentialId: val("updateCredentialId").value || null,
      autoUpdate: bool("autoUpdate"),
      highlightKeywords: bool("highlightKeywords"),
      cmdColor: bool("cmdColor"),
      lsColor: bool("lsColor"),
      cmdSuggest: bool("cmdSuggest"),
      aiPreview: bool("aiPreview"),
      aiMaskHosts: bool("aiMaskHosts"),
      checkTypedCommands: bool("checkTypedCommands"),
      autoLockMinutes: Math.max(0, Math.min(1440, Math.trunc(Number(val("autoLockMinutes").value)) || 0)),
      // Unchanged from the built-in list: keep following it (later versions may add rules).
      riskRules: (() => {
        const kept = rules.filter((r) => r.pattern.trim()).map((r) => ({ ...r, pattern: r.pattern.trim(), note: r.note.trim() }));
        return JSON.stringify(kept) === JSON.stringify(DEFAULT_RISK_RULES) ? undefined : kept;
      })(),
      terminalTheme: form.querySelector<HTMLInputElement>("[name=terminalTheme]:checked")?.value ?? "banana",
    });
    toast("설정을 저장했습니다", "success");
    m.close();
  });
}
