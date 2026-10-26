// The command line being typed: colours for its words, and suggestions from
// the commands run before. Pure text work; cmdAssist.ts applies it to a
// terminal.

import { COMMAND_DICTIONARY } from "./cmdDictionary";
import { findTypedRisk } from "./riskRules";
import { groupForKind } from "./snippetLibrary";
import { state } from "./store";

/** A prompt that ends where a command starts: shells ($ # % >) and network
 * gear (router#, FGT #, [~HUAWEI]). "login:" and "Password:" are not. */
export const PROMPT_END = /[#>$%\]]\s*$/;

export type WordKind = "cmd" | "opt" | "str" | "var" | "op" | "path" | "num" | "comment" | "neg";

export interface Span {
  start: number;
  end: number;
  kind: WordKind;
}

// Words in front of the command that actually runs; the next word is a command too.
const WRAPPERS = new Set(["sudo", "doas", "env", "time", "nohup", "nice", "xargs", "watch", "exec", "command", "builtin", "then", "do", "else", "elif", "if", "while", "until", "!"]);
const SHELL_OPS = /^(?:\|\||&&|;;|\|&|&>>?|[0-9]?>>?&?[0-9-]?|<<<?|[|;&<>()])/;
const DEVICE_OPS = /^[|?]/;
// Interface names on network gear: Gi1/0/1, TenGigabitEthernet1/1, port1, Vlan10, ae0 …
const INTERFACE = /^(?:gi|te|fa|fo|hu|tw|eth|et|ge|xe|mgmt|vlan|vl|lo|loopback|tunnel|tu|port-channel|po|ae|port|mgmt)[a-z-]*\d[\d/.:]*$/i;
const NUMBER = /^(?:\d+(?:[.:/]\d+)*|0x[0-9a-f]+|[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}(?:\/\d+)?)$/i;

/** The kind of each coloured word of a typed command line. `device` lines
 * follow network-gear syntax ("no shutdown", "show run | include x"). */
export function colorSpans(text: string, device: boolean): Span[] {
  const spans: Span[] = [];
  const ops = device ? DEVICE_OPS : SHELL_OPS;
  let cmd = true;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    const rest = text.slice(i);
    if (!device && c === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      spans.push({ start: i, end: text.length, kind: "comment" });
      break;
    }
    const op = ops.exec(rest);
    if (op) {
      spans.push({ start: i, end: i + op[0].length, kind: "op" });
      // After a pipe or a separator comes another command (Cisco: "| include").
      if (!/^[0-9]?[<>]|^&>/.test(op[0])) cmd = op[0] !== "?";
      i += op[0].length;
      continue;
    }
    // A word: up to a blank or an operator, with quoted parts kept whole.
    let j = i;
    while (j < text.length) {
      const q = text[j];
      if (/\s/.test(q) || (j > i && (device ? q === "|" : ops.test(text.slice(j))))) break;
      if (q === "'" || q === '"') {
        let k = j + 1;
        while (k < text.length && text[k] !== q) k += q === '"' && text[k] === "\\" ? 2 : 1;
        j = Math.min(k + 1, text.length);
      } else j += q === "\\" ? 2 : 1;
    }
    j = Math.min(j, text.length);
    const word = text.slice(i, j);
    let kind: WordKind | null = null;
    if (/^['"]/.test(word)) kind = "str";
    else if (cmd) {
      if (device && /^(no|undo)$/i.test(word)) kind = "neg";
      else if (!device && /^[A-Za-z_]\w*=/.test(word)) kind = "var";
      else {
        kind = "cmd";
        cmd = !device && WRAPPERS.has(word);
      }
    } else if (word.startsWith("-") && !device) kind = "opt";
    else if (word.startsWith("$")) kind = "var";
    else if (NUMBER.test(word)) kind = "num";
    else if (device ? INTERFACE.test(word) || word.includes("/") : /^[~.]?\//.test(word) || word.includes("/")) kind = "path";
    if (kind) spans.push({ start: i, end: j, kind });
    i = j;
  }
  return spans;
}

// ---- Command history (this PC only) ----

const KEY = "bx.cmdHistory";
// About 1 MB at most: localStorage holds 5 MB for the whole app.
const PER_HOST = 200;
const HOSTS = 100;
type History = Record<string, string[]>;

let cache: History | null = null;
/** Bumped on every change: cached candidate pools are rebuilt. */
let version = 0;
function load(): History {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    cache = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      for (const [host, list] of Object.entries(raw)) if (Array.isArray(list)) cache[host] = list.filter((c): c is string => typeof c === "string").slice(-PER_HOST);
  } catch {
    cache = {};
  }
  return cache;
}

// Saved a moment after the last change (one write for a burst of Enters, off
// the keystroke), and at once when the window goes away.
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache ?? {}));
  } catch {
    // Storage full or blocked: suggestions just stay in memory.
  }
}
function changed() {
  version++;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 1500);
}
if (typeof window !== "undefined") window.addEventListener("pagehide", () => saveTimer && save());

// Commands that carry a password or token in the line itself are not kept:
// mysql -pSECRET, sshpass -p x, --password=x, TOKEN=x, curl -u user:pass, user:pass@ URLs.
const SECRET =
  /(?<![a-z])(pass(word|wd)?|pwd|token|secret|api[_-]?key|auth)\w*\s*[=:]\s*\S|--?(pass(word|wd)?|token|secret|api[_-]?key)\b|\bsshpass\b|\bmysql(dump|admin)?\b.*\s-p\S|\bcurl\b.*\s(-u|--user)\s*\S+:\S|:\/\/[^\s/:@]+:[^\s/@]+@|\bsnmp\S*\b.*\s(community|-c)\s|\bkey\s+\d\s+\S|\b(enable\s+)?secret\s+\d?\s*\S/i;

/** A command line that holds a credential (never stored). */
export function holdsSecret(command: string): boolean {
  return SECRET.test(command);
}

/** Remember a command run at a prompt. Risky commands (riskRules.ts) are never
 * kept, so a suggestion cannot bring an "rm -r" back by accident, and neither
 * are lines with a password or token in them. */
export function rememberCommand(host: string, command: string) {
  const cmd = command.trim();
  if (!cmd || cmd.length > 500 || findTypedRisk(cmd) || holdsSecret(cmd)) return;
  const h = load();
  const list = (h[host] ?? []).filter((c) => c !== cmd);
  list.push(cmd);
  delete h[host];
  h[host] = list.slice(-PER_HOST);
  // Insertion order = last used: the oldest hosts go first.
  const hosts = Object.keys(h);
  for (const old of hosts.slice(0, Math.max(0, hosts.length - HOSTS))) delete h[old];
  changed();
}

/** Remove one command from every host's history (Shift+Delete in the list). */
export function forgetCommand(command: string): boolean {
  const h = load();
  let found = false;
  for (const host of Object.keys(h)) {
    const list = h[host].filter((c) => c !== command);
    if (list.length !== h[host].length) {
      found = true;
      if (list.length) h[host] = list;
      else delete h[host];
    }
  }
  if (found) changed();
  return found;
}

export function clearCommandHistory() {
  cache = {};
  changed();
  save();
}

export function commandHistoryCount(): number {
  return Object.values(load()).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
}

// Programs on each server's PATH (monitor_commands), for this app run only.
const remote = new Map<string, string[]>();

export function setRemoteCommands(host: string, names: string[]) {
  remote.set(host, names);
  version++;
}

export function hasRemoteCommands(host: string): boolean {
  return remote.has(host);
}

export interface Candidate {
  /** The whole command. */
  text: string;
  source: "history" | "snippet" | "dictionary" | "server";
}

/** Every command that starts with `typed`, best first, without the risk check. */
function scan(host: string, typed: string, group: string | undefined): Candidate[] {
  const h = load();
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (c: string, source: Candidate["source"]) => {
    if (c.length > typed.length && c.startsWith(typed) && !seen.has(c)) {
      seen.add(c);
      out.push({ text: c, source });
    }
  };
  // This host newest first, then the other hosts, the most recently used first.
  const mine = h[host] ?? [];
  for (let i = mine.length - 1; i >= 0; i--) add(mine[i], "history");
  const hosts = Object.keys(h);
  for (let j = hosts.length - 1; j >= 0; j--) {
    if (hosts[j] === host) continue;
    const list = h[hosts[j]];
    for (let i = list.length - 1; i >= 0; i--) add(list[i], "history");
  }
  // A recognised device: the user's own snippets and its library group only, that group first.
  const snippets = state.snippets.filter((s) => !s.macro && !/[\r\n]/.test(s.text) && (!group || !s.group || s.group === group));
  for (const s of snippets) if (s.group && s.group === group) add(s.text.trim(), "snippet");
  for (const s of snippets) if (!s.group) add(s.text.trim(), "snippet");
  for (const s of snippets) if (s.group && s.group !== group) add(s.text.trim(), "snippet");
  for (const c of group ? (COMMAND_DICTIONARY[group] ?? []) : []) add(c, "dictionary");
  if (!/\s/.test(typed)) {
    const names = (remote.get(host) ?? []).filter((n) => n.startsWith(typed)).sort((a, b) => a.length - b.length);
    for (const n of names) add(n, "server");
  }
  return out;
}

// The matches for the last prefix: typing one more character only narrows
// them, so a keystroke filters this pool instead of scanning everything.
let pool: { key: string; typed: string; items: Candidate[]; snippets: unknown } | null = null;
// Risk verdicts per command, for the current rule list.
let riskFor: unknown = null;
const risky = new Map<string, boolean>();
function isRisky(command: string): boolean {
  const rules = state.settings.riskRules;
  if (rules !== riskFor || risky.size > 5000) {
    riskFor = rules;
    risky.clear();
  }
  let r = risky.get(command);
  if (r === undefined) risky.set(command, (r = !!findTypedRisk(command)));
  return r;
}

/** Commands that start with what was typed, best first: this host's history
 * newest first, other hosts' history, single-line snippets (the device's
 * library group first), the device's command dictionary, then for the first
 * word the programs on the server's PATH. Never a risky command. */
export function candidates(host: string, typed: string, deviceKind: string | undefined, limit: number): Candidate[] {
  if (!typed.trim()) return [];
  const group = groupForKind(deviceKind);
  const key = `${version}\0${host}\0${group ?? ""}`;
  const narrowing = pool && pool.key === key && pool.typed && typed.startsWith(pool.typed) && pool.snippets === state.snippets;
  const items = narrowing ? pool!.items.filter((c) => c.text.length > typed.length && c.text.startsWith(typed)) : scan(host, typed, group);
  // The server's names are a first-word list: gone once a space is typed.
  pool = { key, typed, items: /\s/.test(typed) ? items.filter((c) => c.source !== "server") : items, snippets: state.snippets };
  const out: Candidate[] = [];
  for (const c of pool.items) {
    if (isRisky(c.text)) continue;
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

/** The rest of the best candidate (shown in grey after the cursor). */
export function suggest(host: string, typed: string, deviceKind?: string): string {
  return candidates(host, typed, deviceKind, 1)[0]?.text.slice(typed.length) ?? "";
}
