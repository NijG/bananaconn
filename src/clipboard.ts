// Clipboard access. Inside Tauri the clipboard-manager plugin is used so
// reads never depend on WebView clipboard-permission prompts.

import { api, isTauri } from "./api";
import { holdsSecret } from "./cmdLine";
import { endpoint, type Session } from "./model";
import { toast } from "./ui";

// ---- clipboard history (this PC only) ------------------------------------------
// Recent copies, newest first, so the user can paste something copied earlier.
// Kept in localStorage; capped and de-duplicated. Very large copies are skipped,
// and so is text with a password or token in a line of it (a command copied
// from the terminal such as "mysql -pS3cret"): the history would otherwise
// keep it on disk and show it in the picker. The same rules as the command
// history (cmdLine.holdsSecret).

const HIST_KEY = "bx.clipHistory";
const HIST_MAX = 30;
const HIST_ITEM_MAX = 100_000;
/** All entries together, in characters: 30 copies of 100,000 would take
 * some 3 MB of localStorage, which the AI conversations (ai/panel.ts, 3 MB)
 * share with the settings, snippets and folders; past the quota those could
 * no longer be saved. The oldest entries go first. */
const HIST_TOTAL = 1_000_000;

const secretIn = (text: string) => text.split(/\r?\n/).some(holdsSecret);

/** The newest entries that fit HIST_TOTAL (the newest always stays). */
function fit(list: string[]): string[] {
  let total = 0;
  const kept: string[] = [];
  for (const t of list) {
    total += t.length;
    if (kept.length && total > HIST_TOTAL) break;
    kept.push(t);
  }
  return kept;
}

function loadHistory(): string[] {
  try {
    const a = JSON.parse(localStorage.getItem(HIST_KEY) || "[]");
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
let history: string[] = loadHistory();
// Entries kept by an earlier version that hold a secret leave the store too,
// and so do those past the total it keeps now.
if (history.some(secretIn) || fit(history).length < history.length) {
  history = fit(history.filter((t) => !secretIn(t)));
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(history));
  } catch {
    // best-effort
  }
}

function record(text: string) {
  if (!text || text.length > HIST_ITEM_MAX || secretIn(text)) return;
  history = fit([text, ...history.filter((t) => t !== text)].slice(0, HIST_MAX));
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(history));
  } catch {
    // localStorage full or unavailable: history is best-effort.
  }
}

/** Recent copies, newest first. */
export function clipboardHistory(): string[] {
  return history;
}

export function clearClipboardHistory() {
  history = [];
  try {
    localStorage.removeItem(HIST_KEY);
  } catch {
    // ignore
  }
}

/** Drop one entry (e.g. a password copied by mistake) without clearing the rest. */
export function removeClipboardHistory(text: string) {
  history = history.filter((t) => t !== text);
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(history));
  } catch {
    // best-effort
  }
}

/** `secret`: do not keep this in the clipboard history (a generated password
 * must not be left in localStorage or shown in the history picker), nor let
 * Windows keep it (its clipboard history, the cloud clipboard). False when it
 * could not be copied: a secret is then not copied the plain way instead. */
export async function writeClipboard(text: string, opts?: { secret?: boolean }): Promise<boolean> {
  if (opts?.secret) removeClipboardHistory(text);
  else record(text);
  try {
    if (isTauri && opts?.secret) await api.clipboardWritePrivate(text);
    else if (isTauri) {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
    return true;
  } catch {
    // Clipboard unavailable: most callers ignore it; a secret's caller says so.
    return false;
  }
}

/** A secret put on the clipboard (writeClipboard with `secret`) taken off it
 * again after `ms`, if it is still what the clipboard holds: something copied
 * since is left alone. Nothing is said: the caller said when it copied. */
export function clearSecretLater(text: string, ms = 60_000) {
  window.setTimeout(async () => {
    if (text && (await readClipboard()) === text) await writeClipboard("", { secret: true });
  }, ms);
}

export async function readClipboard(): Promise<string> {
  try {
    if (isTauri) {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return (await readText()) ?? "";
    }
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

/** Sessions' addresses ("user@host:port", the COM port for serial) on the
 * clipboard, one per line: the tab menu and the session list share it. */
export async function copyAddresses(sessions: Pick<Session, "protocol" | "host" | "port" | "username">[]) {
  if (!sessions.length) return;
  await writeClipboard(sessions.map(endpoint).join("\n"));
  toast(sessions.length > 1 ? `주소 ${sessions.length}개를 복사했습니다` : "주소를 복사했습니다", "success", 2000);
}
