// How a search typed in vi, vim or a pager reads, as those programs read it
// (fullScreenSearch.ts marks what these find): vi's expressions, the
// expressions every pager reads alike, which program a shell command starts,
// ":set ic", and vim's line-number column. Pure: checked by
// scripts/visearch-check.mjs.

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

/** vim's word character for \< and \> (its default 'iskeyword': letters,
 * digits, "_" and the Latin-1 letters 192-255). */
const KEYWORD = "[0-9A-Za-z_\\u00C0-\\u00FF]";

/** vim's character classes, exactly: \s is a space or a tab, no more. */
const VIM_CLASS: Record<string, string> = {
  s: "[ \\t]",
  S: "[^ \\t]",
  d: "[0-9]",
  D: "[^0-9]",
  w: "[0-9A-Za-z_]",
  W: "[^0-9A-Za-z_]",
  t: "\\t",
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
 * \+ \= \| \s \d \w \t \c \C. Anything else (\{n,m\}, ~, back references, a
 * quantified group, which could take very long to match): null.
 * `ignoreCase`: vi's 'ignorecase' as it is set now; \c and \C override it.
 * `vim`: the program is vim; a classic vi (AIX, HP-UX, Solaris) reads a
 * backslash before a plain letter as that letter, so vim's own escapes are
 * null there. More than two unbounded repeats ("a*b*c*", ".*.*.*"): null,
 * as matching them can take seconds a row. */
export function viPattern(src: string, delim: string, ignoreCase = false, vim = true): RegExp | null {
  let out = "";
  let caseless = ignoreCase;
  let forced = false;
  let repeats = 0;
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
    if (q !== "?" && ++repeats > 2) return false;
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
      } else if (n === "<") {
        out += `(?<!${KEYWORD})(?=${KEYWORD})`;
        prev = "zero";
      } else if (n === ">") {
        out += `(?<=${KEYWORD})(?!${KEYWORD})`;
        prev = "zero";
      } else if (vim && n === "|") {
        out += "|";
        prev = "start";
      } else if (vim && n === "+") {
        if (!quantify("+")) return null;
      } else if (vim && (n === "=" || (n === "?" && delim !== "?"))) {
        if (!quantify("?")) return null;
      } else if (vim && n === "c") {
        caseless = true;
        forced = true;
      } else if (vim && n === "C") {
        // \c anywhere wins over \C, as in vim.
        if (!forced) caseless = false;
      } else if (vim && n in VIM_CLASS) {
        atom(VIM_CLASS[n]);
      } else if (".*[]^$\\/?~".includes(n)) {
        atom(n.replace(REGEX_SPECIAL, "\\$&"));
      } else {
        return null;
      }
    } else if (c === "*") {
      // "*" first, or after "^" or "\(": a plain star in POSIX and vim alike.
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
    // "u": "." and "[^x]" take a whole character, never half an emoji.
    return new RegExp(out, caseless ? "giu" : "gu");
  } catch {
    return null;
  }
}

/** A search in a pager (less, more, man) or a program not known: their
 * expressions differ (POSIX extended in one build, PCRE in another, basic in
 * more), so only what all of them read alike is marked: plain text, ".", "*"
 * after something, "[...]", "^" first, "$" last, and a backslash before one
 * of . * [ ] ^ $ \ /. Anything else ("a+b", "x|y", "\<w\>"): null. */
export function pagerPattern(src: string): RegExp | null {
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      if (!".*[]^$\\/".includes(src[++i] ?? "+")) return null;
    } else if ("+?|(){}".includes(c)) return null;
    else if (c === "^" && i > 0) return null;
    else if (c === "$" && i < src.length - 1) return null;
    else if (c === "*" && (i === 0 || (i === 1 && src[0] === "^"))) return null;
    else if (c === "[") {
      let j = i + 1;
      if (src[j] === "^") j++;
      if (src[j] === "]") j++;
      while (j < src.length && src[j] !== "]") {
        // A backslash in brackets: an escape in PCRE, a plain one in POSIX.
        if (src[j] === "\\") return null;
        if (src.startsWith("[:", j)) {
          const end = src.indexOf(":]", j + 2);
          if (end < 0) return null;
          j = end + 2;
        } else j++;
      }
      if (j >= src.length) return null;
      i = j;
    }
  }
  return viPattern(src, "/", false, false);
}

/** Programs that are vim by name (its own escapes: \+ \| \s \c …). */
const VIM_PROGRAM = /^(?:vim(?:\.(?:tiny|basic|nox|gtk3?))?|vimdiff|rvim|rview|nvim)$/;
/** Programs that are a vi, maybe a classic one ("vi" is vim on Linux and the
 * classic vi on AIX, HP-UX and Solaris; "view" either). */
const VI_PROGRAM = /^(?:vi|view|nvi|elvis|vedit|visudo|vipw|vigr)$/;

/** What the command run at the shell starts, by its last pipeline part's
 * program ("sudo vi /etc/hosts", "/usr/bin/vim -R x"): "vim", "vi" (vi's
 * expressions without vim's own escapes) or null (a pager or anything else,
 * "sudo -u app vi" and "crontab -e" too: not plainly a vi). */
export function viCommand(command: string): "vim" | "vi" | null {
  const words = (command.split("|").pop() ?? "").trim().split(/\s+/);
  for (const w of words) {
    if (/^(?:sudo|doas|env|exec|command|nice|nohup|time)$/.test(w) || w.startsWith("-") || /^\w+=/.test(w)) continue;
    const name = w.replace(/^.*\//, "");
    return VIM_PROGRAM.test(name) ? "vim" : VI_PROGRAM.test(name) ? "vi" : null;
  }
  return null;
}

/** vim's commands that set a new last search (":s/x/y/", ":%s#a#b#",
 * ":g/x/d", ":v/x/d"): the marks of the one before no longer hold. */
export const NEW_SEARCH_COMMAND = /^:[\s\d,.$%'<>+-]*(?:s|su|substitute|g|global|v|vglobal)!?\s*[^\w\s"|]/;

/** vim's 'smartcase': a pattern with a capital letter (one not after a
 * backslash, "\S" is no capital) keeps case even with 'ignorecase'. */
export function hasCapital(text: string): boolean {
  return /[A-Z]/.test(text.replace(/\\./g, ""));
}

/** A ":set" line's effect on the case options: "ic", "noignorecase", "invic",
 * "ic!", "scs" … Options it does not name are left as they are. */
export function setCaseOptions(row: string, now: { ic: boolean; scs: boolean }): { ic: boolean; scs: boolean } | null {
  const m = /^:\s*(?:se|set|setl|setlocal|setg|setglobal)\s+(.+?)\s*$/.exec(row);
  if (!m) return null;
  const next = { ...now };
  let named = false;
  for (const word of m[1].split(/\s+/)) {
    const w = /^(no|inv)?(ic|ignorecase|scs|smartcase)(!)?$/.exec(word);
    if (!w) continue;
    const key = w[2] === "ic" || w[2] === "ignorecase" ? "ic" : "scs";
    next[key] = w[1] === "no" ? false : w[1] === "inv" || w[3] ? !next[key] : true;
    named = true;
  }
  return named ? next : null;
}

/** The width of a line-number column ("  12 " on every file row, blank on a
 * row a long line goes on in, "~" past the end), or 0. A file whose own
 * lines start with numbers may look so too: then less is marked, never more. */
export function numberGutter(rows: { text: string; status: boolean }[]): number {
  let width = 0;
  let numbered = 0;
  for (const r of rows) {
    if (r.status || r.text.trim() === "" || r.text === "~") continue;
    const m = /^ *\d+ /.exec(r.text);
    if (m) {
      if (width && m[0].length !== width) return 0;
      width = m[0].length;
      numbered++;
    } else if (!width || !r.text.startsWith(" ".repeat(width))) {
      return 0;
    }
  }
  return numbered >= 2 ? width : 0;
}
