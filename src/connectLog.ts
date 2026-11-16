// Each saved session's recent connections, oldest first: when one was made,
// when and how it ended, and the attempts that never connected. Written by the
// workspace as tabs change state (noteConnections), read by the session
// tree's "연결 기록". Kept in this PC's local storage, a few per session; never
// any login detail, only times and how each ended.


/** How a connection ended: the remote end or the user closed it, it broke
 * with an error, its tab was closed, the app was closed, it never connected,
 * or the app stopped without telling (a record from an earlier run left open). */
export type ConnectEnd = "closed" | "error" | "tab" | "app" | "failed" | "unknown";

export interface ConnectRecord {
  /** When the connection was made (for "failed", when the attempt started). */
  at: number;
  /** When it ended; none while it is open. */
  end?: number;
  how?: ConnectEnd;
  /** The session's protocol then (it may be edited since). */
  protocol: string;
}

const KEY = "bx.connectLog";
/** Records kept per session, and sessions kept (those used most recently). */
const PER_SESSION = 20;
const SESSIONS = 300;

type Log = Record<string, ConnectRecord[]>;

/** The log as last read or written: storage is parsed once, not on every
 * look (the home screen asks for each recent session). Callers get copies. */
let cache: Log | null = null;

function read(): Log {
  cache ??= parse();
  return structuredClone(cache);
}

function parse(): Log {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Log = {};
    for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const ok = list.filter((r): r is ConnectRecord => !!r && typeof r === "object" && Number.isFinite(r.at) && typeof r.protocol === "string");
      if (ok.length) out[id] = ok;
    }
    return out;
  } catch {
    return {};
  }
}

function write(log: Log) {
  cache = structuredClone(log);
  try {
    localStorage.setItem(KEY, JSON.stringify(log));
  } catch {
    // Storage full or unavailable: the history is a convenience, the connection goes on.
  }
}

// Records still open from an earlier run: that run stopped without telling
// how they ended (a crash, a forced quit). Settled once, at load.
{
  const log = read();
  let changed = false;
  for (const list of Object.values(log))
    for (const r of list)
      if (!r.how) {
        r.how = "unknown";
        changed = true;
      }
  if (changed) write(log);
}

/** Only saved sessions have a history ("quick-" ones are gone with their tab). */
const kept = (sessionId: string) => !sessionId.startsWith("quick-");

/** A record added for a session, in the order of `at` (a failed attempt is
 * added when it ends, after a connection begun later in another tab); the log
 * trimmed to its bounds, the sessions used longest ago dropped first.
 * Sessions are not dropped for being absent from the list: one this version
 * cannot read is kept in the file, and so is its history. Returns the
 * record's `at`, which names it. */
function add(sessionId: string, r: ConnectRecord): number | undefined {
  if (!kept(sessionId)) return undefined;
  const log = read();
  const list = (log[sessionId] ??= []);
  list.push(r);
  list.sort((a, b) => a.at - b.at);
  if (list.length > PER_SESSION) list.splice(0, list.length - PER_SESSION);
  const ids = Object.keys(log);
  ids.sort((a, b) => (log[b].at(-1)?.at ?? 0) - (log[a].at(-1)?.at ?? 0));
  const out: Log = {};
  for (const id of ids.slice(0, SESSIONS)) out[id] = log[id];
  write(out);
  return r.at;
}

/** A connection was made: its record, open until `connectEnded`. */
export function connectStarted(sessionId: string, protocol: string, at: number): number | undefined {
  return add(sessionId, { at, protocol });
}

/** The open record `at` (from connectStarted) ended now, as `how`. */
export function connectEnded(sessionId: string, at: number, how: ConnectEnd) {
  const log = read();
  const r = log[sessionId]?.find((x) => x.at === at && !x.how);
  if (!r) return;
  r.end = Date.now();
  r.how = how;
  write(log);
}

/** An attempt begun at `at` ended without connecting. */
export function connectFailed(sessionId: string, protocol: string, at: number) {
  add(sessionId, { at, end: Date.now(), how: "failed", protocol });
}

/** A session's records, newest first. */
export function connectHistory(sessionId: string): ConnectRecord[] {
  return [...(read()[sessionId] ?? [])].reverse();
}

/** Every session's records, newest first. */
export function allConnectHistory(): { sessionId: string; record: ConnectRecord }[] {
  return Object.entries(read())
    .flatMap(([sessionId, list]) => list.map((record) => ({ sessionId, record })))
    .sort((a, b) => b.record.at - a.record.at);
}

/** A session's newest record, if it has any. */
export function lastConnect(sessionId: string): ConnectRecord | undefined {
  cache ??= parse();
  const r = cache[sessionId]?.at(-1);
  return r && { ...r };
}

/** A session's records forgotten. */
export function clearConnectHistory(sessionId: string) {
  const log = read();
  if (!log[sessionId]) return;
  delete log[sessionId];
  write(log);
}
