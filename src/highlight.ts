// Keyword highlighting for terminal output:
// colours words like ERROR, WARN and OK in plain output, even from servers
// that print no colours themselves.
//
// It works on the raw byte stream (one char per byte) and never touches escape
// sequences or the payload of string sequences (OSC, DCS, APC, PM, SOS: sixel
// and other graphics). It stays out of the way of programs that colour their
// own output (any SGR style in effect) and of full-screen programs (alternate
// screen).

// One pass over the text: the group that matched picks the colour.
const RULE =
  /\b(?:(errors?|fail(?:ed|ure|s)?|fatal|critical|panic|denied|refused|exception|unreachable|timed out|timeout)|(warn(?:ing|ings)?|deprecated|retry(?:ing)?)|(ok|success(?:ful(?:ly)?)?|succeeded|passed|enabled|active|running))\b/gi;
const bytesOf = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const COLORS = ["\x1b[1;31m", "\x1b[1;33m", "\x1b[1;32m"].map(bytesOf);
const RESET = bytesOf("\x1b[22;39m");

const enum Esc {
  Text,
  Esc,
  Csi,
  /** OSC, DCS, APC, PM or SOS payload: passed through until BEL or ST. */
  Str,
  StrEsc,
  /** ESC followed by an intermediate byte (charset selection etc.): one more byte. */
  Single,
}

/** The SGR state a program has set: any of it means "the program colours this". */
class Sgr {
  fg = false;
  bg = false;
  /** Attribute bits 1..9 (bold, dim, italic, underline, blink, inverse, hidden, strike). */
  attrs = 0;

  get styled() {
    return this.fg || this.bg || this.attrs !== 0;
  }

  apply(params: string) {
    const ps = params === "" ? [0] : params.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p === 0) {
        this.fg = this.bg = false;
        this.attrs = 0;
      } else if (p >= 1 && p <= 9) this.attrs |= 1 << p;
      else if (p === 21 || p === 22) this.attrs &= ~((1 << 1) | (1 << 2));
      else if (p >= 23 && p <= 29) this.attrs &= ~(1 << (p - 20));
      else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) this.fg = true;
      else if (p === 39) this.fg = false;
      else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) this.bg = true;
      else if (p === 49) this.bg = false;
      else if (p === 38 || p === 48) {
        if (p === 38) this.fg = true;
        else this.bg = true;
        // 38;5;n or 38;2;r;g;b: skip the colour's own parameters.
        i += ps[i + 1] === 5 ? 2 : ps[i + 1] === 2 ? 4 : 0;
      }
    }
  }
}

export class KeywordHighlighter {
  private esc = Esc.Text;
  private csi = "";
  private sgr = new Sgr();
  /** A full-screen program (vim, htop, less) is on the alternate screen. */
  private alt = false;

  /** Follow one chunk of output and, when `color` is on, colour its keywords.
   * Returns the input itself when nothing is coloured (no copy at all). */
  process(data: Uint8Array, color = true): Uint8Array {
    let pieces: Uint8Array[] | null = null;
    let copied = 0;
    let run = -1;
    const endRun = (end: number) => {
      const start = run;
      run = -1;
      if (start < 0 || !color || this.sgr.styled || this.alt) return;
      const colored = colorize(data, start, end);
      if (!colored) return;
      pieces ??= [];
      if (start > copied) pieces.push(data.subarray(copied, start));
      for (const p of colored) pieces.push(p);
      copied = end;
    };
    for (let i = 0; i < data.length; i++) {
      const code = data[i];
      switch (this.esc) {
        case Esc.Text:
          if (code === 0x1b) {
            endRun(i);
            this.esc = Esc.Esc;
          } else if (run < 0) run = i;
          break;
        case Esc.Esc:
          if (code === 0x5b /* [ */) {
            this.esc = Esc.Csi;
            this.csi = "";
          } else if (code === 0x5d || code === 0x50 || code === 0x5f || code === 0x5e || code === 0x58) this.esc = Esc.Str; // ] P _ ^ X
          else if (code >= 0x20 && code <= 0x2f) this.esc = Esc.Single;
          else this.esc = Esc.Text;
          break;
        case Esc.Single:
          this.esc = Esc.Text;
          break;
        case Esc.Csi:
          if (code >= 0x40 && code <= 0x7e) {
            this.endCsi(this.csi, String.fromCharCode(code));
            this.esc = Esc.Text;
          } else if (this.csi.length < 64) this.csi += String.fromCharCode(code);
          break;
        case Esc.Str:
          if (code === 0x07) this.esc = Esc.Text;
          else if (code === 0x1b) this.esc = Esc.StrEsc;
          break;
        case Esc.StrEsc:
          this.esc = code === 0x5c /* backslash */ ? Esc.Text : Esc.Str;
          break;
      }
    }
    endRun(data.length);
    if (!pieces) return data;
    const parts: Uint8Array[] = pieces;
    if (copied < data.length) parts.push(data.subarray(copied));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  private endCsi(params: string, final: string) {
    if (final === "m") {
      if (/^[\d;:]*$/.test(params)) this.sgr.apply(params);
    } else if ((final === "h" || final === "l") && /^\?(1049|1047|47)$/.test(params)) {
      this.alt = final === "h";
    }
  }
}

/** Bytes [start, end) as a binary string (one char per byte). */
function latin1(data: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i += 8192) s += String.fromCharCode.apply(null, data.subarray(i, Math.min(end, i + 8192)) as unknown as number[]);
  return s;
}

/** The text run as pieces with its keywords coloured (views into `data`
 * plus colour codes: the run itself is not copied), or null when there is
 * nothing to colour. */
function colorize(data: Uint8Array, start: number, end: number): Uint8Array[] | null {
  const text = latin1(data, start, end);
  RULE.lastIndex = 0;
  let m = RULE.exec(text);
  if (!m) return null;
  const pieces: Uint8Array[] = [];
  let at = 0;
  while (m) {
    const from = m.index;
    const to = from + m[0].length;
    if (from > at) pieces.push(data.subarray(start + at, start + from));
    pieces.push(m[1] ? COLORS[0] : m[2] ? COLORS[1] : COLORS[2], data.subarray(start + from, start + to), RESET);
    at = to;
    m = RULE.exec(text);
  }
  if (at < text.length) pieces.push(data.subarray(start + at, end));
  return pieces;
}
