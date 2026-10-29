// Clipboard access. Inside Tauri the clipboard-manager plugin is used so
// reads never depend on WebView clipboard-permission prompts.

import { isTauri } from "./api";

// ---- clipboard history (this PC only) ------------------------------------------
// Recent copies, newest first, so the user can paste something copied earlier.
// Kept in localStorage; capped and de-duplicated. Very large copies are skipped.

const HIST_KEY = "bx.clipHistory";
const HIST_MAX = 30;
const HIST_ITEM_MAX = 100_000;

function loadHistory(): string[] {
  try {
    const a = JSON.parse(localStorage.getItem(HIST_KEY) || "[]");
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
let history: string[] = loadHistory();

function record(text: string) {
  if (!text || text.length > HIST_ITEM_MAX) return;
  history = [text, ...history.filter((t) => t !== text)].slice(0, HIST_MAX);
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

export async function writeClipboard(text: string) {
  record(text);
  try {
    if (isTauri) {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
  } catch {
    /* clipboard unavailable: ignore */
  }
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
