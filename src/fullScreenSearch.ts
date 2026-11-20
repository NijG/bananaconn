// A search typed in a full-screen program (vi, vim, less, more): the matches
// on the screen are marked, the searched text alone. Unix vi (AIX, HP-UX,
// Solaris) marks nothing itself and Linux vim often has hlsearch off, so the
// terminal does it, the same way for both.
//
// A search is told by the screen, not by guessing the program's mode: when
// Enter is typed with the cursor on the bottom row and that row reads
// "/text" or "?text" (vi's and less's search line), that text is searched for.
// Text typed in insert mode goes into the file, never onto that line.
//
// The text is read as vi reads it (viPattern): "^host", "a.b", "[0-9]*",
// "\<word\>" mark what vi finds, not those characters.
//
// Programs on the alternate screen are left when it closes; a vi drawn on the
// normal screen (no alternate screen with TERM=vt100) is left once the shell's
// command line is back at the cursor, or a command is run there. ":noh" ends
// the marks as vim's own does.

import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";

/** The most matches marked at once (a screen holds a few hundred cells of one word at most). */
const MAX_MARKS = 500;

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/]/g;

/** POSIX bracket classes ("[[:digit:]]") as JavaScript class contents. */
const POSIX_CLASS: Record<string, string> = {
  alpha: "a-zA-Z",
  digit: "0-9",
  alnum: "a-zA-Z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\r\\n\\v\\f",
  blank: " \\t",
  xdigit: "0-9A-Fa-f",
  punct: "!-\\/:-@\\[-`{-~",
};

/** The search's text up to its closing delimiter: "foo/e" (an offset) is "foo". */
export function searchText(row: string, delim: string): string {
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\") i++;
    else if (row[i] === delim) return row.slice(0, i);
  }
  return row;
}

/** A vi search pattern ("magic", the default) as a JavaScript RegExp: the POSIX
 * basic expressions vi and vim share (. * [...] ^ $ \( \) \< \>) and vim's
 * \+ \= \| \s \d \w \t \c. Anything else (\{n,m\}, ~, back references, a
 * quantified group, which could take very long to match): null. */
export function viPattern(src: string, delim: string): RegExp | null {
  let out = "";
  let flags = "g";
  // What came last: a quantifier may follow an atom only, "^" is an anchor
  // only first, "*" first is a plain star.
  let prev: "start" | "caret" | "atom" | "group" | "quant" | "zero" = "start";
  let depth = 0;
  const atom = (s: string) => {
    out += s;
    prev = "atom";
  };
  const quantify = (q: string) => {
    if (prev !== "atom") return false;
    out += q;
    prev = "quant";
    return true;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[++i];
      if (n === undefined) return null;
      if (n === "(") {
        out += "(";
        depth++;
        prev = "start";
      } else if (n === ")") {
        if (!depth) return null;
        depth--;
        out += ")";
        prev = "group";
      } else if (n === "|") {
        out += "|";
        prev = "start";
      } else if (n === "<") {
        out += "(?<!\\w)(?=\\w)";
        prev = "zero";
      } else if (n === ">") {
        out += "(?<=\\w)(?!\\w)";
        prev = "zero";
      } else if (n === "+") {
        if (!quantify("+")) return null;
      } else if (n === "=" || (n === "?" && delim !== "?")) {
        if (!quantify("?")) return null;
      } else if (n === "c") {
        if (!flags.includes("i")) flags += "i";
      } else if (n === "C") {
        // Case kept: already so.
      } else if ("sSdDwW".includes(n)) {
        atom(`\\${n}`);
      } else if (n === "t") {
        atom("\\t");
      } else if (".*[]^$\\/?~".includes(n)) {
        atom(n.replace(REGEX_SPECIAL, "\\$&"));
      } else {
        return null;
      }
    } else if (c === "*") {
      if (prev === "start" || prev === "caret") atom("\\*");
      else if (!quantify("*")) return null;
    } else if (c === "^") {
      if (prev === "start") {
        out += "^";
        prev = "caret";
      } else atom("\\^");
    } else if (c === "$") {
      const rest = src.slice(i + 1);
      if (rest === "" || rest.startsWith("\\)") || rest.startsWith("\\|")) {
        out += "$";
        prev = "zero";
      } else atom("\\$");
    } else if (c === ".") {
      atom(".");
    } else if (c === "[") {
      let j = i + 1;
      let body = "";
      const neg = src[j] === "^";
      if (neg) j++;
      if (src[j] === "]") {
        body += "\\]";
        j++;
      }
      let closed = false;
      for (; j < src.length; j++) {
        const b = src[j];
        if (b === "]") {
          closed = true;
          break;
        }
        if (src.startsWith("[:", j)) {
          const end = src.indexOf(":]", j + 2);
          const cls = end < 0 ? undefined : POSIX_CLASS[src.slice(j + 2, end)];
          if (cls === undefined) return null;
          body += cls;
          j = end + 1;
        } else if (b === "\\") {
          // A backslash in brackets: literal in vi, an escape in vim.
          return null;
        } else {
          body += b === "-" ? "-" : b.replace(REGEX_SPECIAL, "\\$&");
        }
      }
      // "[" with no "]": a plain bracket, as vim reads it.
      if (!closed || !body) atom("\\[");
      else {
        atom(`[${neg ? "^" : ""}${body}]`);
        i = j;
      }
    } else if (c === "~") {
      // The last substitute's text: not known here.
      return null;
    } else {
      atom(c.replace(REGEX_SPECIAL, "\\$&"));
    }
  }
  if (depth) return null;
  try {
    return new RegExp(out, flags);
  } catch {
    return null;
  }
}

/** What a search line's text marks: as vi reads it, or, a pattern vi's own
 * reading of which is not known here, the text itself. */
function searchRegex(text: string, delim: string): RegExp {
  const re = viPattern(text, delim);
  if (re) return re;
  const plain = text.replace(/\\(.)/g, "$1");
  return new RegExp(plain.replace(REGEX_SPECIAL, "\\$&"), "g");
}

export class FullScreenSearch {
  private pattern: RegExp | null = null;
  private marks: { marker: IMarker; deco: IDecoration | undefined }[] = [];
  private timer = 0;
  private disposers: { dispose(): void }[];

  /** `atShell`: the cursor's row is the shell's command line (its prompt
   * first): the program has ended. */
  constructor(
    private term: Terminal,
    private atShell: () => boolean,
  ) {
    this.disposers = [
      term.onWriteParsed(() => this.schedule()),
      term.onResize(() => this.schedule()),
      // The alternate screen closed (or opened): whatever was marked is gone.
      term.buffer.onBufferChange(() => this.stop()),
    ];
  }

  /** Enter typed (not pasted): the bottom row, if it is a search line, sets what is marked. */
  enterTyped() {
    const buf = this.term.buffer.active;
    // A command run at the shell (the program has ended, whatever the screen
    // shows now): the marks are for the program it searched in.
    if (buf.type === "normal" && this.pattern !== null && this.atShell()) return this.stop();
    if (buf.cursorY !== this.term.rows - 1) return;
    const line = buf.getLine(buf.baseY + buf.cursorY);
    // The rest of a long line wrapped onto the bottom row ("…/usr/lib"): no search line.
    if (!line || line.isWrapped) return;
    const row = line.translateToString(true);
    // vim's ":noh", ":nohl", ":nohls" … ":nohlsearch".
    if (/^:\s*noh(?:l(?:s(?:e(?:a(?:r(?:c(?:h)?)?)?)?)?)?)?\s*$/.test(row)) return this.stop();
    const m = /^([/?])(.+)$/.exec(row);
    if (!m) return;
    const text = searchText(m[2], m[1]);
    // "/" alone (or "//e") repeats the last search: the marks stay as they are.
    if (!text) return;
    this.pattern = searchRegex(text, m[1]);
    this.schedule();
  }

  stop() {
    this.pattern = null;
    clearTimeout(this.timer);
    this.clear();
  }

  dispose() {
    this.stop();
    for (const d of this.disposers) d.dispose();
  }

  /** Marked again once the program has drawn (scrolled, moved, redrawn). */
  private schedule() {
    if (this.pattern === null) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.paint(), 60);
  }

  private clear() {
    for (const m of this.marks) {
      m.deco?.dispose();
      m.marker.dispose();
    }
    this.marks = [];
  }

  private paint() {
    this.clear();
    const re = this.pattern;
    if (re === null) return;
    const buf = this.term.buffer.active;
    // A vi on the normal screen has ended once the shell's command line is back.
    if (buf.type === "normal" && this.atShell()) return this.stop();
    const cell = buf.getNullCell();
    // Every screen row but the bottom one (the program's command line).
    for (let y = 0; y < this.term.rows - 1 && this.marks.length < MAX_MARKS; y++) {
      const line = buf.getLine(buf.baseY + y);
      if (!line) continue;
      // The row's text with the screen column (and width) of each character:
      // a wide character (Hangul) takes two columns.
      let text = "";
      const cols: number[] = [];
      const widths: number[] = [];
      for (let x = 0; x < line.length; x++) {
        if (!line.getCell(x, cell) || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || " ";
        for (let k = 0; k < chars.length; k++) {
          cols.push(x);
          widths.push(cell.getWidth());
        }
        text += chars;
      }
      // The blank rest of the row is no part of the line ("host$" ends at "t").
      text = text.replace(/ +$/, "");
      re.lastIndex = 0;
      for (let m = re.exec(text); m && this.marks.length < MAX_MARKS; m = re.exec(text)) {
        // An empty match ("x*" where there is no x) marks nothing.
        if (!m[0]) {
          re.lastIndex++;
          continue;
        }
        const i = m.index;
        const last = i + m[0].length - 1;
        const x = cols[i];
        const width = cols[last] + widths[last] - x;
        // Markers are placed relative to the cursor's line.
        const marker = this.term.registerMarker(y - buf.cursorY);
        if (!marker) continue;
        const deco = this.term.registerDecoration({ marker, x, width, backgroundColor: "#F5C518", foregroundColor: "#111111", layer: "top" });
        this.marks.push({ marker, deco });
      }
    }
  }
}
