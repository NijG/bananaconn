// Terminal log settings (SecureCRT style): a file name template with
// substitutions, write mode, per-line prefix, midnight rollover and custom
// text on connect/disconnect. App-wide defaults live in Settings; a session can
// use its own (options.logCustom === "session"). The backend (termlog.rs)
// fills in the time tokens; the session tokens are filled in here.

import { pickSavePath } from "./api";
import { icon } from "./icons";
import { newSession, type Session } from "./model";
import { state } from "./store";
import { esc } from "./ui";

export type LogMode = "append" | "overwrite" | "unique";

export interface LogConfig {
  path: string;
  mode: LogMode;
  linePrefix: string;
  midnight: boolean;
  onConnect: string;
  onDisconnect: string;
  /** Start logging as soon as the session connects. */
  auto: boolean;
}

export const LOG_TOKENS = "%S 세션 이름 · %H 호스트 · %U 사용자 · %P 포트 · %Y 연 · %M 월 · %D 일 · %h 시 · %m 분 · %s 초 · %t 밀리초 · %% 기호 %";

/** The log settings that apply to a session. */
/** A log file name Windows would run (the backend refuses those, see
 * remote.rs runs_when_opened): said when saving, not at the next connect. */
export function runnableLogName(template: string): boolean {
  const ext = template.trim().split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
  return template.includes(".") && RUNNABLE.has(ext);
}
const RUNNABLE = new Set("exe com bat cmd vbs vbe js jse wsf wsh msc ps1 psm1 hta lnk url scr msi msp pif cpl reg jar application appref-ms gadget inf scf".split(" "));

export function logConfig(s: Session): LogConfig {
  const o = s.options;
  const g = state.settings;
  if (o.logCustom === "session") {
    return {
      path: String(o.logPath ?? "") || g.logTemplate,
      mode: (o.logMode as LogMode) || "append",
      linePrefix: String(o.logLinePrefix ?? ""),
      midnight: !!o.logMidnight,
      onConnect: String(o.logOnConnect ?? ""),
      onDisconnect: String(o.logOnDisconnect ?? ""),
      auto: !!o.logAuto || g.autoLog,
    };
  }
  return {
    path: g.logTemplate,
    mode: g.logMode,
    linePrefix: g.logLinePrefix,
    midnight: g.logMidnight,
    onConnect: g.logOnConnect,
    onDisconnect: g.logOnDisconnect,
    auto: g.autoLog,
  };
}

/** Fill in %S %H %U %P. In file names the values lose characters Windows
 * forbids; '%' in a value is escaped so the backend keeps it literal. */
export function fillSession(template: string, s: Session, forFileName: boolean): string {
  const clean = (v: unknown) => {
    const text = String(v ?? "");
    return (forFileName ? text.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") : text).replace(/%/g, "%%");
  };
  const values: Record<string, string> = {
    S: clean(s.name || s.host),
    H: clean(s.host),
    U: clean(s.username),
    P: clean(s.port ?? ""),
  };
  return template.replace(/%([SHUP%])/g, (_m, k: string) => (k === "%" ? "%%" : values[k]));
}

/** What the backend gets: session tokens filled, time tokens left for it. */
export function backendLogOptions(c: LogConfig, s: Session) {
  return {
    path: fillSession(c.path, s, true),
    mode: c.mode,
    linePrefix: fillSession(c.linePrefix, s, false),
    midnight: c.midnight,
    onConnect: fillSession(c.onConnect, s, false),
    onDisconnect: fillSession(c.onDisconnect, s, false),
  };
}

/** Preview of a template with every token filled in for now. */
export function previewPath(template: string, s: Session, now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const time: Record<string, string> = {
    Y: String(now.getFullYear()),
    M: two(now.getMonth() + 1),
    D: two(now.getDate()),
    h: two(now.getHours()),
    m: two(now.getMinutes()),
    s: two(now.getSeconds()),
    t: String(now.getMilliseconds()).padStart(3, "0"),
  };
  return fillSession(template, s, true).replace(/%([YMDhmst%])/g, (_m, k: string) => (k === "%" ? "%" : time[k]));
}

/** A stand-in session so Settings can preview the default template. */
const SAMPLE_SESSION: Session = { ...newSession("ssh"), name: "myserver", host: "10.0.0.5", username: "admin", port: 22 };

/** Preview the app-wide default template (Settings) with placeholder values. */
export function previewDefaultPath(template: string): string {
  return previewPath(template, SAMPLE_SESSION);
}

/** Form fields for log settings; `name` maps a field key to its form name. */
export function logFields(c: Omit<LogConfig, "auto"> & { auto?: boolean }, name: (key: string) => string, autoLabel?: string): string {
  const modes: [LogMode, string][] = [
    ["append", "이어 쓰기 (같은 파일이 있으면 끝에 추가)"],
    ["overwrite", "덮어쓰기"],
    ["unique", "새 파일 (같은 이름이 있으면 -2, -3 …)"],
  ];
  return `<div class="log-fields">
      <label class="field"><span>로그 파일 이름</span>
        <div class="inline"><input name="${name("path")}" value="${esc(c.path)}" spellcheck="false" autocomplete="off" placeholder="%S_%Y%M%D_%h%m%s.log"/>
        <button type="button" class="btn" data-log-browse title="폴더 고르기">${icon("FolderOpen", 14)}</button></div>
        <small class="muted">상대 경로는 문서\\BananaConn\\logs 아래에 만듭니다. 예: D:\\점검\\CRT_Log\\%S (%H)_%Y%M%D.log</small></label>
      <div class="grid-2">
        <label class="field"><span>파일이 이미 있으면</span><select name="${name("mode")}">
          ${modes.map(([v, l]) => `<option value="${v}" ${v === c.mode ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="field"><span>각 줄 앞에</span><input name="${name("linePrefix")}" value="${esc(c.linePrefix)}" spellcheck="false" placeholder="예: [%h:%m:%s] "/></label>
        <label class="field"><span>기록을 시작할 때</span><input name="${name("onConnect")}" value="${esc(c.onConnect)}" spellcheck="false" placeholder="예: ===== %S 접속 %Y-%M-%D %h:%m:%s ====="/></label>
        <label class="field"><span>기록을 끝낼 때</span><input name="${name("onDisconnect")}" value="${esc(c.onDisconnect)}" spellcheck="false" placeholder="예: ===== 종료 %h:%m:%s ====="/></label>
      </div>
      <label class="check"><input type="checkbox" name="${name("midnight")}" ${c.midnight ? "checked" : ""}/> 자정이 지나면 새 파일로 이어서 기록 (파일 이름에 %D가 있어야 합니다)</label>
      ${autoLabel ? `<label class="check"><input type="checkbox" name="${name("auto")}" ${c.auto ? "checked" : ""}/> ${autoLabel}</label>` : ""}
      <p class="muted small log-tokens">치환 문자: ${LOG_TOKENS}</p>
    </div>`;
}

/** "Browse" next to the path field: keep the file name template, pick the folder. */
export function wireLogBrowse(root: HTMLElement, name: (key: string) => string) {
  root.querySelectorAll<HTMLButtonElement>("[data-log-browse]").forEach((b) =>
    b.addEventListener("click", async () => {
      const input = root.querySelector<HTMLInputElement>(`[name="${name("path")}"]`)!;
      const current = input.value.trim() || state.settings.logTemplate;
      const fileName = current.split(/[\\/]/).pop() || "%S_%Y%M%D_%h%m%s.log";
      const picked = await pickSavePath(fileName.replace(/%/g, "_"), [{ name: "로그", extensions: ["log", "txt"] }]);
      if (!picked) return;
      // The dialog cannot keep %-tokens in a name: keep the folder it chose
      // with the template's own file name.
      const folder = picked.replace(/[\\/][^\\/]*$/, "");
      input.value = `${folder}\\${fileName}`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }),
  );
}
