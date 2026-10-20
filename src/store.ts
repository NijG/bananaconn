// Application state: saved sessions, credentials, folders and user settings,
// with a tiny change-notification bus.

import { api, type Credential } from "./api";
import type { Language } from "./i18n";
import type { RiskRule } from "./riskRules";
import { SNIPPET_LIBRARY, SNIPPET_LIBRARY_VERSION } from "./snippetLibrary";
import { normalizeFolder, normalizeSession, type Session } from "./model";
import { errorText, toast } from "./ui";

export interface Settings {
  fontSize: number;
  fontFamily: string;
  cursorStyle: "block" | "bar" | "underline";
  scrollback: number;
  /** Terminal drawing: WebGL (GPU) when a real GPU is there, or always DOM / WebGL. */
  renderer: "auto" | "dom" | "webgl";
  /** Screen language the user picked (한 / ENG). Unset until they pick one:
   * the app then follows the Windows display language. */
  uiLanguage?: Language;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  /** Ask before pasting more than one line into a terminal. */
  confirmMultiPaste: boolean;
  /** How multi-line pastes reach device consoles (serial, console-server
   * Telnet): when the device has taken each line ("echo"), or after fixed
   * delays. */
  pasteMode: "echo" | "fixed";
  pasteLineDelay: number;
  pasteCharDelay: number;
  /** COM ports: overlapped I/O ("fast"), or the previous synchronous I/O
   * ("compat") should a driver misbehave. */
  serialIo: "fast" | "compat";
  /** Wait for a serial port that went away (USB adapter unplugged) or is not
   * there yet, and connect when it shows up. */
  serialAutoReconnect: boolean;
  autoLog: boolean;
  confirmClose: boolean;
  terminalTheme: string;
  /** Colour ERROR/WARN/OK words in plain terminal output. */
  highlightKeywords: boolean;
  /** Lock after this many idle minutes when a master password is set (0 = never). */
  autoLockMinutes: number;
  /** Open the SFTP browser next to every new SSH session. */
  sftpWithSsh: boolean;
  /** Show the remote server's CPU and memory in the status bar for SSH tabs. */
  remoteMonitor: boolean;
  /** Default log file name template (see logOptions.ts for the tokens). */
  logTemplate: string;
  logMode: "append" | "overwrite" | "unique";
  logLinePrefix: string;
  logMidnight: boolean;
  logOnConnect: string;
  logOnDisconnect: string;
  /** Ask for the file name when logging is started from the toolbar. */
  logPrompt: boolean;
  /** Folder (network share) the build machine publishes signed updates to. */
  updateFolder: string;
  /** Look for a new version there when the app starts. */
  autoUpdate: boolean;
  /** Shortcut changes: action id -> keys (keymap.ts); unset: the defaults. */
  keybindings?: Record<string, string[]>;
  /** Risky-command rules for snippets and macros (riskRules.ts); unset: the built-in list. */
  riskRules?: RiskRule[];
  /** Vault credential (password) to log in to the update share with when it
   * refuses the Windows account. */
  updateCredentialId?: string | null;
}

/** Where signed updates are published (the GitHub release download address).
 * When it cannot be reached (blocked by security policy), the update folder
 * from the settings is used: each user's own share; there is no default. */
export const UPDATE_URL = "https://github.com/NijG/bananaconn/releases/latest/download/";

const DEFAULT_SETTINGS: Settings = {
  fontSize: 14,
  fontFamily: "'Cascadia Mono', Consolas, 'D2Coding', monospace",
  cursorStyle: "block",
  scrollback: 10000,
  renderer: "auto",
  copyOnSelect: true,
  rightClickPaste: true,
  confirmMultiPaste: true,
  pasteMode: "echo",
  pasteLineDelay: 100,
  pasteCharDelay: 0,
  serialIo: "fast",
  serialAutoReconnect: true,
  autoLog: false,
  confirmClose: true,
  terminalTheme: "banana",
  highlightKeywords: true,
  autoLockMinutes: 15,
  sftpWithSsh: false,
  remoteMonitor: true,
  updateFolder: "",
  autoUpdate: true,
  logTemplate: "%S_%Y%M%D_%h%m%s.log",
  logMode: "unique",
  logLinePrefix: "",
  logMidnight: false,
  logOnConnect: "",
  logOnDisconnect: "",
  logPrompt: true,
};

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export interface Snippet {
  id: string;
  name: string;
  text: string;
  /** Press Enter after sending. */
  run: boolean;
  /** A recorded macro: `text` is the exact keystroke data, replayed as-is. */
  macro?: boolean;
  /** Operating system it is meant for ("Linux", "AIX", "Cisco IOS" …); none for the user's own. */
  group?: string;
}

type Topic = "sessions" | "credentials" | "settings" | "folders" | "snippets";
const listeners = new Map<Topic, Set<() => void>>();

/** Returns a function that stops the subscription. */
export function subscribe(topic: Topic, fn: () => void): () => void {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic)!.add(fn);
  return () => listeners.get(topic)?.delete(fn);
}

function notify(topic: Topic) {
  listeners.get(topic)?.forEach((fn) => fn());
}

/** Remembered empty folders; a damaged entry must not stop the app from starting. */
function loadFolders(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem("bx.folders") ?? "[]");
    return new Set((Array.isArray(raw) ? raw : []).map(normalizeFolder).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Saved settings over the defaults. */
function loadSettings(): Settings {
  const s = readLS<Settings>("bx.settings", DEFAULT_SETTINGS);
  s.updateFolder ??= "";
  // 0.7.18 saved "language" with a "ko" default, so only "en" is a real choice.
  const old = s as Settings & { language?: string };
  if (old.language !== undefined) {
    if (old.language === "en" && !s.uiLanguage) s.uiLanguage = "en";
    delete old.language;
  }
  return s;
}

export const state = {
  sessions: [] as Session[],
  credentials: [] as Credential[],
  settings: loadSettings(),
  /** Explicitly created folders (folders also exist implicitly through sessions). */
  extraFolders: loadFolders(),
  snippets: readSnippets(),
};

/** Saved snippets; the built-in per-OS library (snippetLibrary.ts) is added
 * once per library version, so snippets the user deleted stay deleted and
 * their own come first. The three snippets of older versions are part of the
 * Linux group. */
function readSnippets(): Snippet[] {
  let list: Snippet[] | null = null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem("bx.snippets");
    const saved = JSON.parse(raw ?? "null");
    if (Array.isArray(saved)) list = saved;
  } catch {
    // Not readable: keep the text aside rather than overwrite the user's macros.
    try {
      if (raw) localStorage.setItem("bx.snippets.unreadable", raw);
    } catch {}
  }
  let seen = 0;
  let offered: Set<string> | null = null;
  try {
    seen = Number(localStorage.getItem("bx.snippetLibrary")) || 0;
    const o = JSON.parse(localStorage.getItem("bx.snippetOffered") ?? "null");
    if (Array.isArray(o)) offered = new Set(o.map(String));
  } catch {}
  if (list && seen >= SNIPPET_LIBRARY_VERSION) {
    // Remember what this version offered, before a later one adds more.
    if (!offered)
      try {
        localStorage.setItem("bx.snippetOffered", JSON.stringify(SNIPPET_LIBRARY.map((s) => s.id)));
      } catch {}
    return list;
  }
  // Built-ins already offered once (all of version 1's, for lists seeded by
  // it) stay deleted if the user deleted them; only new ones are added.
  if (!offered) offered = new Set(list && seen >= 1 ? SNIPPET_LIBRARY.map((s) => s.id) : []);
  const out = list ?? [];
  const ids = new Set(out.map((s) => s.id));
  for (const s of out) {
    const lib = SNIPPET_LIBRARY.find((x) => x.id === s.id);
    if (lib && !s.group) s.group = lib.group;
  }
  for (const s of SNIPPET_LIBRARY) if (!ids.has(s.id) && !offered.has(s.id)) out.push({ ...s });
  try {
    localStorage.setItem("bx.snippets", JSON.stringify(out));
    localStorage.setItem("bx.snippetLibrary", String(SNIPPET_LIBRARY_VERSION));
    localStorage.setItem("bx.snippetOffered", JSON.stringify(SNIPPET_LIBRARY.map((s) => s.id)));
  } catch {}
  return out;
}

export function saveSnippets(list: Snippet[]) {
  state.snippets = list;
  localStorage.setItem("bx.snippets", JSON.stringify(list));
  notify("snippets");
}

/** Saving is refused until the stored list was read, so a failed load can
 * never be followed by a save that replaces the user's sessions. */
let sessionsLoaded = false;
/** Stored entries this version cannot read; written back untouched. */
let unreadable: unknown[] = [];
/** The list as last read from or written to disk. */
let savedSessions: Session[] = [];

export async function loadAll() {
  const raw = await api.sessionsLoad();
  const parsed = raw.map((r) => [r, normalizeSession(r)] as const);
  state.sessions = parsed.flatMap(([, s]) => (s ? [s] : []));
  unreadable = parsed.flatMap(([r, s]) => (s ? [] : [r]));
  savedSessions = structuredClone(state.sessions);
  sessionsLoaded = true;
  notify("sessions");
  await reloadCredentials();
}

export async function reloadCredentials() {
  state.credentials = await api.vaultList();
  notify("credentials");
}

/** The save that will include changes made now, and the previous saves it waits for. */
let nextSave: Promise<void> | null = null;
let saves: Promise<unknown> = Promise.resolve();

/** Save all sessions. Changes made in the same moment (20 tabs opening, a
 * device detected on each) share one write and one sidebar redraw; saves run
 * one after another, so an older list never lands after a newer one. */
/** Resolves once every session save started so far has finished (or failed). */
export function savesSettled(): Promise<unknown> {
  return saves;
}

async function persistSessions() {
  if (!sessionsLoaded) {
    const err = new Error("세션 목록을 읽지 못해 저장하지 않았습니다. 앱을 다시 시작하세요.");
    toast(`세션을 저장하지 못했습니다: ${errorText(err)}`, "error");
    throw err;
  }
  if (!nextSave) {
    const save = saves
      .then(() => new Promise((r) => setTimeout(r, 0)))
      .then(async () => {
        nextSave = null;
        const list = [...state.sessions];
        try {
          await api.sessionsSave([...list, ...unreadable]);
        } catch (err) {
          // Not on disk (file locked by antivirus, say). Said once for this
          // write. With a newer save queued, that one writes the current list
          // (this change and later edits); otherwise the screen goes back to
          // what is really stored.
          toast(`세션을 저장하지 못했습니다: ${errorText(err)}`, "error");
          if (!nextSave) {
            state.sessions = structuredClone(savedSessions);
            notify("sessions");
          }
          throw err;
        }
        savedSessions = structuredClone(list);
        notify("sessions");
      });
    nextSave = save;
    saves = save.catch(() => {});
  }
  await nextSave;
}

export async function upsertSession(s: Session) {
  const i = state.sessions.findIndex((x) => x.id === s.id);
  if (i >= 0) state.sessions[i] = s;
  else state.sessions.push(s);
  await persistSessions();
}

/** Add many sessions at once (imports) with a single save. */
export async function upsertSessions(list: Session[]) {
  for (const s of list) {
    const i = state.sessions.findIndex((x) => x.id === s.id);
    if (i >= 0) state.sessions[i] = s;
    else state.sessions.push(s);
  }
  await persistSessions();
}

/**
 * Change fields of the stored session. Tabs hold a snapshot taken when they
 * opened, so saving that whole object would undo later edits (or resurrect a
 * deleted session); this patches the current record and skips deleted ones.
 */
export async function patchSession(id: string, patch: Partial<Omit<Session, "id" | "options">>, options?: Record<string, unknown>) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  Object.assign(s, patch);
  if (options) s.options = { ...s.options, ...options };
  await persistSessions();
}

/** After a credential is deleted, sessions that used it fall back to asking. */
export async function detachCredential(credentialId: string) {
  let changed = false;
  for (const s of state.sessions) {
    if (s.credentialId === credentialId) {
      s.credentialId = null;
      changed = true;
    }
  }
  // The update share's NAS account may be the same credential.
  if (state.settings.updateCredentialId === credentialId) updateSettings({ updateCredentialId: null });
  if (changed) await persistSessions();
}

export async function removeSession(id: string) {
  state.sessions = state.sessions.filter((s) => s.id !== id);
  await persistSessions();
}

export async function touchSession(id: string) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  s.lastUsed = Date.now();
  await persistSessions();
}

/** Delete several sessions with a single save. */
export async function removeSessions(ids: Iterable<string>) {
  const gone = new Set(ids);
  state.sessions = state.sessions.filter((s) => !gone.has(s.id));
  await persistSessions();
}

/** Move several sessions into `folder` with a single save. */
export async function moveSessions(ids: Iterable<string>, folder: string) {
  const moving = new Set(ids);
  let changed = false;
  for (const s of state.sessions) {
    if (moving.has(s.id) && s.folder !== folder) {
      s.folder = folder;
      changed = true;
    }
  }
  if (changed) await persistSessions();
}

export async function moveSession(id: string, folder: string) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s || s.folder === folder) return;
  s.folder = folder;
  await persistSessions();
}

export function allFolders(): string[] {
  const set = new Set<string>(state.extraFolders);
  for (const s of state.sessions) {
    if (!s.folder) continue;
    // Include every ancestor of a nested folder path.
    const parts = s.folder.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join("/"));
  }
  return [...set].sort((a, b) => a.localeCompare(b, "ko"));
}

function saveFolders() {
  localStorage.setItem("bx.folders", JSON.stringify([...state.extraFolders]));
  notify("folders");
}

export function addFolder(path: string) {
  const clean = normalizeFolder(path);
  if (!clean) return;
  state.extraFolders.add(clean);
  saveFolders();
}

export async function renameFolder(from: string, to: string) {
  const clean = normalizeFolder(to);
  if (!clean || clean === from) return;
  const remap = (f: string) => (f === from ? clean : f.startsWith(from + "/") ? clean + f.slice(from.length) : f);
  state.sessions.forEach((s) => (s.folder = remap(s.folder)));
  state.extraFolders = new Set([...state.extraFolders].map(remap));
  saveFolders();
  await persistSessions();
}

/** Delete a folder; its sessions move to the parent folder. */
export async function deleteFolder(path: string) {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const remap = (f: string) => (f === path ? parent : f.startsWith(path + "/") ? parent + f.slice(path.length) : f);
  state.sessions.forEach((s) => (s.folder = remap(s.folder).replace(/^\//, "")));
  // Subfolders move up with the sessions, so empty ones are not lost.
  state.extraFolders = new Set(
    [...state.extraFolders].filter((f) => f !== path).map((f) => remap(f).replace(/^\//, "")).filter(Boolean),
  );
  saveFolders();
  await persistSessions();
}

export function updateSettings(patch: Partial<Settings>) {
  state.settings = { ...state.settings, ...patch };
  localStorage.setItem("bx.settings", JSON.stringify(state.settings));
  notify("settings");
}

export function credentialName(id: string | null): string {
  if (!id) return "";
  return state.credentials.find((c) => c.id === id)?.name ?? "";
}
