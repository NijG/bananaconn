// Colours for ls listings on Unix systems whose ls has none (AIX, HP-UX,
// Solaris, or a Linux ls without --color): folders, links, programs, archives
// … with GNU ls's default colours. The listing itself is left as it came:
// the colours are xterm decorations over the names, and nothing is typed into
// the engineer's shell.
//  - ls -l: the mode column tells each entry's type;
//  - ls -F / -p: the mark after each name (dir/ prog* link@ fifo| sock=);
//  - plain ls: the folder is read once more over the resource monitor's own
//    connection (ls -1aF there), when the prompt shows which folder it is.

import type { IDecoration, IMarker, ITheme, Terminal } from "@xterm/xterm";
import { PROMPT_END } from "./cmdLine";

export type Kind = "dir" | "link" | "exec" | "fifo" | "socket" | "device" | "archive" | "image" | "audio" | "file";

const ARCHIVE = /\.(tar|tgz|taz|tbz2?|txz|tz|t7z|tzo|tlz|tzst|zip|jar|war|ear|sar|rar|alz|ace|zoo|cpio|7z|rz|cab|arj|arc|lha|lzh|lzma|lz4|lz|lzo|lrz|xz|zst|gz|bz2?|z|dz|deb|rpm|wim|swm|esd)$/i;
const IMAGE = /\.(jpe?g|gif|bmp|pbm|pgm|ppm|tga|xbm|xpm|tiff?|png|svg|mng|pcx|mov|mpe?g|m2v|mkv|webm|ogm|mp4|m4v|mp4v|vob|qt|nuv|wmv|asf|rmvb|flc|avi|fli|flv|xcf|xwd|yuv|emf)$/i;
const AUDIO = /\.(aac|au|flac|m4a|mid|midi|mka|mp3|mpc|ogg|ra|wav|opus|oga|spx)$/i;

/** A regular file's kind from its name (archives, images, audio). */
export function byName(name: string): Kind {
  return ARCHIVE.test(name) ? "archive" : IMAGE.test(name) ? "image" : AUDIO.test(name) ? "audio" : "file";
}

/** An ls -F entry: the name without its mark, and the kind the mark tells. */
export function byMark(entry: string): { name: string; kind: Kind } {
  const mark = entry.slice(-1);
  const kind: Kind | undefined = ({ "/": "dir", "*": "exec", "@": "link", "|": "fifo", "=": "socket" } as const)[mark];
  return kind && entry.length > 1 ? { name: entry.slice(0, -1), kind } : { name: entry, kind: byName(entry) };
}

/** An ls -l line: where the name starts, its length and its kind; null for other lines ("total 12"). */
export function longEntry(line: string): { start: number; length: number; kind: Kind } | null {
  const m = /^([-bcdlpsD])([-rwxsStTlL]{9})\S*\s+\d+\s.*?\s(?:[A-Z][a-z]{2}\s+\d{1,2}|\d{1,2}\s+[A-Z][a-z]{2}|\d{1,2}월\s+\d{1,2}일?|\d{4}-\d\d-\d\d)\s+(?:\d{1,2}:\d\d(?::\d\d(?:\.\d+)?)?(?:\s+[+-]\d{4})?|\d{4})\s+(.+)$/.exec(line);
  if (!m) return null;
  const [, type, perms, rest] = m;
  // "name -> target": the name only.
  const name = type === "l" ? rest.split(" -> ")[0] : rest;
  const exec = /[xst]/.test(perms[2] + perms[5] + perms[8]);
  const kind: Kind = type === "d" ? "dir" : type === "l" ? "link" : type === "p" ? "fifo" : type === "s" ? "socket" : type === "b" || type === "c" ? "device" : exec ? "exec" : byName(name);
  return { start: line.length - rest.length, length: name.length, kind };
}

/** The folder a shell prompt shows: "host:/path#", "[user@host /path]$",
 * "user@host:~/x>" → "/path", "~/x"; null when it shows no full path. */
export function promptFolder(prompt: string): string | null {
  const m = /(?:^|[\s:[])(~(?:\/[^\s#$>%\]]*)?|\/[^\s#$>%\]]*)\]?\s*[#$>%]$/.exec(prompt.trim());
  return m ? (m[1].length > 1 ? m[1].replace(/\/+$/, "") : m[1]) : null;
}

/** "/a/b" + "../c" → "/a/c"; "~" forms kept; null without a known base. */
export function resolveFolder(cwd: string | null, arg: string): string | null {
  const path = arg.startsWith("/") || arg === "~" || arg.startsWith("~/") ? arg : cwd ? `${cwd}/${arg}` : null;
  if (!path) return null;
  const home = path.startsWith("~");
  const out: string[] = [];
  for (const part of path.slice(home ? 1 : 0).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return (home ? "~" : "") + (home && !out.length ? "" : `/${out.join("/")}`);
}

/** The line after typing `data`: text, Backspace and Ctrl+U are followed;
 * anything else (arrows, Tab, history) makes it unknown (null). */
export function keyLine(line: string | null, data: string): string | null {
  if (line === null) return null;
  for (const ch of data) {
    if (ch === "\x7f" || ch === "\b") line = line.slice(0, -1);
    else if (ch === "\x15") line = "";
    else if (ch >= " ") line += ch;
    else return null;
  }
  return line;
}

export interface LsRequest {
  long: boolean;
  classify: boolean;
  /** The folder listed, when known (for a plain listing). */
  folder: string | null;
}

/** An ls command line this module colours: plain ls / ll with options and at
 * most one folder, no pipes, redirections or substitutions. */
export function parseLs(command: string, cwd: string | null): LsRequest | null {
  const c = command.trim();
  if (!c || /[|;&<>`$(){}"'\\*?[]/.test(c)) return null;
  const [first, ...rest] = c.split(/\s+/);
  const ll = first === "ll";
  if (!ll && !/^(\/usr)?(\/bin)?\/?ls$/.test(first)) return null;
  const flags = rest.filter((w) => w.startsWith("-") && !w.startsWith("--")).join("");
  const args = rest.filter((w) => !w.startsWith("-"));
  if (rest.some((w) => w.startsWith("--") && w !== "--") || args.length > 1) return null;
  const long = ll || /[lngo]/.test(flags);
  const classify = /[Fp]/.test(flags);
  // -d lists the folder itself, -R several folders: no single folder to read.
  const single = !/[dR]/.test(flags);
  return { long, classify, folder: single ? resolveFolder(cwd, args[0] ?? ".") : null };
}

const COLOR: Record<Exclude<Kind, "file">, (t: ITheme) => string | undefined> = {
  dir: (t) => t.brightBlue ?? t.blue,
  link: (t) => t.brightCyan ?? t.cyan,
  exec: (t) => t.brightGreen ?? t.green,
  fifo: (t) => t.yellow,
  socket: (t) => t.brightMagenta ?? t.magenta,
  device: (t) => t.brightYellow ?? t.yellow,
  archive: (t) => t.brightRed ?? t.red,
  image: (t) => t.brightMagenta ?? t.magenta,
  audio: (t) => t.cyan,
};

/** Text of one logical line (wrapped rows joined) with each character's cell. */
interface Logical {
  text: string;
  cells: { row: number; x: number; w: number }[];
}

const MAX_DECORATIONS = 4000;
/** How long the folder read over the monitor connection may take. */
const TYPES_TIMEOUT = 5000;

/** `p`'s value, or null when it fails or takes longer than `ms`. */
function withTimeout<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  return Promise.race([p.catch(() => null), late]).finally(() => clearTimeout(timer));
}

export class LsColors {
  private decorations: IDecoration[] = [];
  private watching = 0;

  constructor(
    private term: Terminal,
    private theme: () => ITheme,
    /** The entries of a folder with ls -F marks, or null when they cannot be read. */
    private folderTypes: (folder: string) => Promise<string[] | null>,
    private enabled: () => boolean,
  ) {}

  /** The listing whose output is still coming (0: none). */
  private open = 0;

  /** An ls listing is being printed: the keyword highlighter (highlight.ts)
   * leaves it alone, or its colours ("error.log", "failed/") would read as
   * the server's own ls colours and the listing would stay uncoloured. */
  get listing(): boolean {
    return this.open !== 0;
  }

  /** The engineer pressed Enter on `command` after `prompt`. */
  submitted(command: string, prompt: string) {
    // Any Enter ends the previous listing's output.
    this.open = 0;
    if (!this.enabled() || this.term.buffer.active.type !== "normal") return;
    const req = parseLs(command, promptFolder(prompt));
    if (!req) return;
    const start = this.term.registerMarker(0);
    if (!start) return;
    const id = ++this.watching;
    this.open = id;
    // The plain listing's folder is read meanwhile; a monitor connection
    // that never answers must not hold the colours back for ever.
    const types = !req.long && !req.classify && req.folder ? withTimeout(this.folderTypes(req.folder), TYPES_TIMEOUT) : Promise.resolve(null);
    void this.whenDone(start, id).then(async (end) => {
      if (this.open === id) this.open = 0;
      const marks = end && id === this.watching ? await types : null;
      // The prompt row is a marker: rows shift while the folder is read
      // (scrollback trimmed, screen cleared), and the screen may have moved on.
      if (end && id === this.watching && !start.isDisposed && !end.isDisposed && this.term.buffer.active.type === "normal") this.paint(start, end.line, req, marks);
      start.dispose();
      end?.dispose();
    });
  }

  /** The next prompt's row as a marker (the listing is above it), or null if it never comes. */
  private async whenDone(start: IMarker, id: number): Promise<IMarker | null> {
    const began = Date.now();
    let seen = "";
    let changed = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 120));
      if (id !== this.watching || start.isDisposed || Date.now() - began > 15_000) return null;
      const buf = this.term.buffer.active;
      if (buf.type !== "normal") return null;
      const row = buf.baseY + buf.cursorY;
      const left = buf.getLine(row)?.translateToString(true, 0, buf.cursorX) ?? "";
      const now = `${buf.length}:${row}:${left}`;
      if (now !== seen) (seen = now), (changed = Date.now());
      if (row > start.line && PROMPT_END.test(left) && Date.now() - changed >= 250) return this.term.registerMarker(0) ?? null;
    }
  }

  private logical(from: number, to: number): Logical[] | null {
    const buf = this.term.buffer.active;
    const out: Logical[] = [];
    for (let row = from; row < to; row++) {
      const line = buf.getLine(row);
      if (!line) continue;
      if (!line.isWrapped || !out.length) out.push({ text: "", cells: [] });
      const cur = out[out.length - 1];
      const cell = line.getCell(0);
      if (!cell) continue;
      const cols = this.term.cols;
      for (let x = 0; x < cols; x++) {
        line.getCell(x, cell);
        const w = cell.getWidth();
        if (w === 0) continue;
        const chars = cell.getChars() || " ";
        // The server already coloured it: leave the listing alone.
        if (chars !== " " && !cell.isFgDefault()) return null;
        for (let i = 0; i < chars.length; i++) cur.cells.push({ row, x, w });
        cur.text += chars;
      }
    }
    for (const l of out) {
      const end = l.text.trimEnd().length;
      l.text = l.text.slice(0, end);
      l.cells.length = end;
    }
    return out;
  }

  private paint(start: IMarker, end: number, req: LsRequest, marks: string[] | null) {
    // From the line after the command (its wrapped rows skipped) to the prompt.
    const buf = this.term.buffer.active;
    let from = start.line + 1;
    while (from < end && buf.getLine(from)?.isWrapped) from++;
    const lines = this.logical(from, end);
    if (!lines) return;
    const known = new Map<string, Kind>();
    for (const entry of marks ?? []) {
      const { name, kind } = byMark(entry);
      if (name !== "." && name !== "..") known.set(name, kind);
    }
    const spans: { line: Logical; start: number; length: number; kind: Kind }[] = [];
    for (const line of lines) {
      if (req.long) {
        const e = longEntry(line.text);
        if (e) spans.push({ line, ...e });
        continue;
      }
      for (const m of line.text.matchAll(/\S+/g)) {
        const word = m[0];
        const { name, kind } = req.classify ? byMark(word) : { name: word, kind: known.get(word) ?? byName(word) };
        spans.push({ line, start: m.index!, length: req.classify ? name.length : word.length, kind });
      }
    }
    const t = this.theme();
    for (const s of spans.slice(0, MAX_DECORATIONS)) {
      if (s.kind === "file") continue;
      const color = COLOR[s.kind](t);
      if (!color || !/^#[0-9a-f]{6}$/i.test(color)) continue;
      this.decorate(s.line, s.start, s.length, color);
    }
    // Old listings scrolled far away: their colours go first.
    while (this.decorations.length > MAX_DECORATIONS) this.decorations.shift()!.dispose();
  }

  /** One coloured run, split where it wraps to the next row. */
  private decorate(line: Logical, start: number, length: number, color: string) {
    const buf = this.term.buffer.active;
    let i = start;
    while (i < start + length) {
      const first = line.cells[i];
      if (!first) return;
      let j = i;
      while (j + 1 < start + length && line.cells[j + 1]?.row === first.row) j++;
      const last = line.cells[j];
      const marker = this.term.registerMarker(first.row - (buf.baseY + buf.cursorY));
      if (marker) {
        const deco = this.term.registerDecoration({ marker, x: first.x, width: last.x + last.w - first.x, foregroundColor: color, layer: "top" });
        if (deco) {
          this.decorations.push(deco);
          marker.onDispose(() => deco.dispose());
        } else marker.dispose();
      }
      i = j + 1;
    }
  }

  dispose() {
    this.watching++;
    this.open = 0;
    for (const d of this.decorations) d.dispose();
    this.decorations = [];
  }
}
