// Self-update: the build machine publishes signed installers to a GitHub
// release and a shared folder; the app checks them at startup, every 30
// minutes and on request and,
// when the user agrees, installs the new version and restarts. Signature and SHA-256 checks
// happen in the backend (updater.rs).

import { api } from "./api";
import { icon } from "./icons";
import { language } from "./i18n";
import { DEFAULT_UPDATE_FOLDER, PREVIOUS_UPDATE_FOLDER, state, UPDATE_URL } from "./store";
import { choiceDialog, confirmDialog, errorText, esc, toast } from "./ui";

const credential = () => state.settings.updateCredentialId || null;

/** "UPDATE_AUTH::<\\server\share>::<reason>" from updater.rs: the share
 * refused the account (not offline). */
function authProblem(err: unknown): { share: string; reason: string } | null {
  const m = /^UPDATE_AUTH::(.*?)::([\s\S]*)$/.exec(errorText(err));
  return m ? { share: m[1], reason: m[2] } : null;
}

/** Windows logs in to a share with the user's own account and does not fall
 * back to guest access: say so, and offer the two ways out. */
async function authGuide(p: { share: string; reason: string }) {
  const named = !!credential();
  const choice = await choiceDialog({
    title: "업데이트 폴더에 로그인할 수 없습니다",
    icon: "KeyRound",
    message: `<p><b>${esc(p.share)}</b>: ${esc(p.reason)}</p>
      <p>Windows는 공유 폴더에 지금 로그인한 Windows 계정으로 먼저 접속하고, 공유 폴더가 익명(게스트) 읽기를 허용해도 게스트로 넘어가지 않습니다(Windows 10/11 기본 보안 설정).</p>
      <ul>
        <li><b>폴더 열기</b>: 탐색기에서 폴더를 엽니다. 로그인 창에 NAS 계정을 입력하고 "자격 증명 기억"을 체크하면 다음부터는 바로 접속됩니다.</li>
        <li><b>NAS 계정 지정</b>: 설정 → 업데이트에서 자격 증명 보관함의 NAS 계정을 고르면, 앱이 업데이트를 확인할 때 그 계정으로 로그인합니다.${named ? " (지금 고른 계정으로도 로그인하지 못했습니다.)" : ""}</li>
      </ul>`,
    choices: [
      { value: "open", label: "폴더 열기" },
      { value: "settings", label: "NAS 계정 지정", kind: "primary" },
    ],
  });
  if (choice === "open") api.updateOpenFolder(updateFolder()).catch((err) => toast(errorText(err), "error"));
  if (choice === "settings") import("./settings").then(({ openSettings }) => openSettings("update")).catch(() => {});
}
/** Automatic checks warn about a refused login once per run. */
let authWarned = false;

interface UpdateState {
  current: string;
  available: string | null;
  /** Korean release notes. */
  notes: string;
  /** Signed translations by screen language (see updater.rs). */
  notesI18n: Record<string, string>;
  checking: boolean;
}

export const update: UpdateState = { current: "", available: null, notes: "", notesI18n: {}, checking: false };

/** Release notes in the screen language: its own translation, else English, else the Korean. */
function notesShown(): string {
  const lang = language();
  if (lang === "ko") return update.notes;
  return update.notesI18n[lang] ?? update.notesI18n.en ?? update.notes;
}
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

export function onUpdateChange(fn: () => void) {
  listeners.add(fn);
}

/** The running version, for the status bar. */
export async function loadVersion() {
  try {
    update.current = await api.appVersion();
    changed();
  } catch {
    /* outside Tauri */
  }
}

/** How often the update folder is read while the app runs. */
const CHECK_EVERY = 30 * 60_000;
/** Coming back to the window re-checks when the last check is this old. */
const CHECK_ON_FOCUS = 10 * 60_000;
let lastCheck = 0;
/** Versions already offered in a popup (asked once per version per run). */
const offered = new Set<string>();
let liveConnections = () => 0;

/** Check at startup, then every 30 minutes and when the window comes back
 * after a while; a newer version is offered in a popup. */
export function startAutoUpdate(connections: () => number) {
  liveConnections = connections;
  const due = (age: number) => state.settings.autoUpdate && Date.now() - lastCheck >= age;
  // Give the window a moment; a slow share must not delay startup.
  setTimeout(() => due(0) && checkForUpdate(false), 5000);
  window.setInterval(() => due(CHECK_EVERY) && checkForUpdate(false), 60_000);
  window.addEventListener("focus", () => due(CHECK_ON_FOCUS) && checkForUpdate(false));
}

/** The folder to use: an empty setting means the default share (as the
 * settings hint says), not "no updates". */
function updateFolder(): string {
  return state.settings.updateFolder.trim() || DEFAULT_UPDATE_FOLDER;
}

/** Places to look, in order: GitHub first, the folder from the settings,
 * and while it is the default share also the previous one. A PC without
 * internet access gets its update from the share. */
function updateSources(): string[] {
  const folder = updateFolder();
  const list = [UPDATE_URL, folder, folder === DEFAULT_UPDATE_FOLDER ? PREVIOUS_UPDATE_FOLDER : ""];
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}
/** The source the available version was found in: installed from there. */
let foundIn = "";

/** The first source that answers. When none does, the error worth showing
 * is the settings folder's (a refused NAS login has its own guide). */
async function checkSources(): Promise<{ source: string; info: Awaited<ReturnType<typeof api.updateCheck>> }> {
  let shown: unknown = null;
  for (const source of updateSources()) {
    try {
      return { source, info: await api.updateCheck(source, credential()) };
    } catch (err) {
      if (shown === null || source === updateFolder()) shown = err;
    }
  }
  throw shown;
}

/** A manual check asked for while another check was running. */
let manualQueued = false;

/** Look for a newer version in the update folder. `manual` reports every outcome. */
export async function checkForUpdate(manual: boolean) {
  if (!updateSources().length) {
    if (manual) toast("설정에서 업데이트 폴더를 먼저 지정하세요", "warn");
    return;
  }
  if (update.checking) {
    // Another check (maybe of the old folder) is running: this one follows it.
    if (manual) manualQueued = true;
    return;
  }
  update.checking = true;
  lastCheck = Date.now();
  try {
    const { source, info } = await checkSources();
    foundIn = source;
    update.current = info.current;
    update.available = info.available;
    update.notes = info.notes;
    update.notesI18n = info.notesI18n ?? {};
    if (!info.available && manual) toast(`최신 버전입니다 (v${info.current})`, "success");
  } catch (err) {
    const auth = authProblem(err);
    if (auth && manual) authGuide(auth);
    else if (auth && !authWarned) {
      authWarned = true;
      toast("업데이트 폴더에 로그인할 수 없습니다. 설정 → 업데이트에서 \"지금 확인\"을 눌러 해결 방법을 확인하세요", "warn", 9000);
    }
    // A share that is offline is not worth a popup.
    else if (manual && !auth) toast(errorText(err), "error", 7000);
  } finally {
    update.checking = false;
    if (manualQueued) {
      manualQueued = false;
      void checkForUpdate(true);
    }
    changed();
  }
  if (update.available) offer(update.available, manual);
}

/** Ask once per version (or every time the user checks by hand). A popup
 * never covers another dialog: it waits for the next check instead. */
function offer(version: string, manual: boolean) {
  if (asking || (!manual && (offered.has(version) || document.querySelector(".modal")))) return;
  offered.add(version);
  installUpdate(liveConnections(), !manual);
}
/** An update dialog is open. */
let asking = false;
/** An installer is being fetched and started: never a second one. */
let installing = false;

/** Install the available version: the app closes, updates and restarts.
 * `found` is the automatic popup: it starts on "나중에", since it can appear
 * while the user is typing and an Enter must not restart the app. */
export async function installUpdate(connections = liveConnections(), found = false) {
  if (!update.available || asking || installing) return;
  asking = true;
  const ok = await confirmDialog({
    title: found ? `새 버전 v${update.available}이(가) 있습니다` : `BananaConn v${update.available} 설치`,
    icon: "Download",
    message: `v${esc(update.current)} → <b>v${esc(update.available)}</b>로 업데이트할까요? 앱이 닫혔다가 설치 후 다시 열립니다.${
      connections ? `<br><b>열려 있는 연결 ${connections}개가 끊어집니다.</b>` : ""
    }${notesShown() ? `<pre class="update-notes" data-i18n-skip>${esc(notesShown())}</pre>` : ""}${
      found ? `<span class="muted">나중에 하려면 상태 표시줄의 "업데이트" 버튼을 누르세요.</span>` : ""
    }`,
    confirm: "지금 업데이트",
    cancel: "나중에",
    focusCancel: found,
  }).finally(() => (asking = false));
  if (!ok) return;
  installing = true;
  try {
    toast("업데이트를 준비하는 중…", "info");
    await api.updateInstall(foundIn || updateFolder(), credential());
  } catch (err) {
    installing = false;
    const auth = authProblem(err);
    if (auth) authGuide(auth);
    else toast(errorText(err), "error", 8000);
  }
}

/** Status bar: version, or a button when an update is ready. */
export function updateBadge(): string {
  if (update.available) {
    return `<button class="sb-update" data-update title="클릭하면 설치하고 다시 시작합니다">${icon("Download", 13)}v${esc(update.available)} 업데이트</button>`;
  }
  return update.current ? `<span class="muted">v${esc(update.current)}</span>` : "";
}
