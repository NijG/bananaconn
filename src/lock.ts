// Master password lock screen and settings (backend: lock.rs). While locked the
// whole UI is covered and inert, and the backend refuses to use stored secrets.

import { api } from "./api";
import icon48 from "./assets/app-icon-48.png";
import icon96 from "./assets/app-icon-96.png";
import { icon } from "./icons";
import { state } from "./store";
import { errorText, h, modal, setScreenLocked, toast } from "./ui";

let enabled = false;
let screen: HTMLElement | null = null;
let lastActivity = Date.now();
const listeners = new Set<() => void>();

export const appLock = {
  get enabled() {
    return enabled;
  },
  get locked() {
    return !!screen;
  },
  onChange(f: () => void) {
    listeners.add(f);
  },
};
const changed = () => listeners.forEach((f) => f());

export async function initLock() {
  for (const ev of ["keydown", "pointerdown", "pointermove", "wheel"]) window.addEventListener(ev, () => (lastActivity = Date.now()), true);
  // Auto-lock after the configured idle time.
  window.setInterval(() => {
    const minutes = state.settings.autoLockMinutes;
    if (enabled && !screen && minutes > 0 && Date.now() - lastActivity > minutes * 60_000) lockNow();
  }, 15_000);
  let s;
  try {
    s = await api.lockStatus();
  } catch (err) {
    // The backend stays locked when the master password file cannot be read:
    // show the lock screen with the reason (it names the file) instead of an
    // app where every saved login fails for no visible reason.
    enabled = true;
    showLockScreen(errorText(err));
    return;
  }
  enabled = s.enabled;
  if (s.locked) showLockScreen();
  changed();
}

export async function lockNow() {
  if (!enabled) return;
  await api.lockLock();
  showLockScreen();
}

function showLockScreen(problem?: string) {
  if (screen) return;
  // Menus live outside #app; one left open would stay reachable under the lock.
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  setScreenLocked(true);
  screen = h(
    "div",
    { class: "lock-screen" },
    `<form class="lock-card" autocomplete="off">
       <div class="lock-mark"><img src="${icon48}" srcset="${icon48} 1x, ${icon96} 2x" width="48" height="48" alt="" draggable="false" /></div>
       <h2><span class="brand-y">Banana</span><span class="brand-c">Conn</span><span class="brand-x">.</span> 잠김</h2>
       <p class="muted">마스터 비밀번호를 입력하세요.</p>
       <input type="password" name="pw" autocomplete="current-password" aria-label="마스터 비밀번호" />
       <p class="lock-error" hidden></p>
       <button class="btn btn-primary btn-block" type="submit">${icon("LockKeyhole", 15)}잠금 해제</button>
     </form>`,
  );
  document.body.appendChild(screen);
  const form = screen.querySelector("form")!;
  const input = form.querySelector<HTMLInputElement>("input")!;
  const err = form.querySelector<HTMLElement>(".lock-error")!;
  const btn = form.querySelector<HTMLButtonElement>("button")!;
  if (problem) {
    err.textContent = problem;
    err.hidden = false;
  }
  setTimeout(() => input.focus(), 50);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;
    err.hidden = true;
    try {
      await api.lockUnlock(input.value);
      screen?.remove();
      screen = null;
      setScreenLocked(false);
      lastActivity = Date.now();
      changed();
    } catch (ex) {
      err.textContent = errorText(ex);
      err.hidden = false;
      input.select();
    } finally {
      btn.disabled = false;
    }
  });
  changed();
}

/** Set, change or remove the master password. */
export function openMasterPassword() {
  const m = modal({
    title: "마스터 비밀번호",
    icon: "LockKeyhole",
    width: 500,
    body: `<form class="form" autocomplete="off">
        <p class="muted small">앱을 시작할 때와 자리를 비운 뒤에 잠그고, 잠긴 동안에는 저장된 비밀번호와 키를 쓰지 못하게 합니다.
          비밀번호 자체는 계속 Windows 자격 증명 관리자에 암호화되어 있습니다. 마스터 비밀번호를 잊으면 되찾을 수 없습니다(설정 폴더의 master.json을 지우면 해제됨).</p>
        ${enabled ? `<label class="field"><span>현재 마스터 비밀번호</span><input type="password" name="current" autocomplete="current-password"/></label>` : ""}
        <label class="field"><span>${enabled ? "새 마스터 비밀번호 (해제하려면 비우기)" : "마스터 비밀번호 (8자 이상)"}</span><input type="password" name="next" autocomplete="new-password"/></label>
        <label class="field"><span>한 번 더 입력</span><input type="password" name="again" autocomplete="new-password"/></label>
      </form>`,
    footer: `<button class="btn" data-close>취소</button><button class="btn btn-primary" data-ok>${icon("Check", 14)}${enabled ? "변경" : "설정"}</button>`,
  });
  const val = (n: string) => m.root.querySelector<HTMLInputElement>(`[name=${n}]`)?.value ?? "";
  const ok = m.root.querySelector<HTMLButtonElement>("[data-ok]")!;
  ok.addEventListener("click", async () => {
    const next = val("next");
    if (next !== val("again")) return toast("두 번 입력한 비밀번호가 다릅니다", "warn");
    // A password being set or changed must be at least 8 characters; an empty
    // "new" while enabled means "remove it", which is allowed.
    if (next.length < 8 && (next || !enabled)) return toast("마스터 비밀번호는 8자 이상이어야 합니다", "warn");
    ok.disabled = true;
    try {
      await api.lockSet(enabled ? val("current") : null, next ? next : null);
      enabled = !!next;
      toast(next ? "마스터 비밀번호를 저장했습니다" : "마스터 비밀번호를 해제했습니다", "success");
      changed();
      m.close();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      ok.disabled = false;
    }
  });
}
