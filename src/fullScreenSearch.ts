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
// "\<word\>" mark what vi finds, not those characters. That is when the
// command run at the shell started a vi; in a pager (less, more, man), whose
// expressions differ by build, only what every reading agrees on is marked
// (pagerPattern). What the program would find is never guessed: such a
// search marks nothing.
//
// Programs on the alternate screen are left when it closes; a vi drawn on the
// normal screen (no alternate screen with TERM=vt100) is left once the shell's
// command line is back at the cursor, or a command is run there. ":noh" ends
// the marks as vim's own does.

import type { IBuffer, IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { hasCapital, NEW_SEARCH_COMMAND, numberGutter, pagerPattern, searchText, setCaseOptions, viCommand, viPattern } from "./viSearch";

/** The most matches marked at once (a screen holds a few hundred cells of one word at most). */
const MAX_MARKS = 500;

export class FullScreenSearch {
  private pattern: RegExp | null = null;
  /** The last search as typed, read again when the case options change. */
  private searched: { text: string; delim: string; typed: string } | null = null;
  /** vi's 'ignorecase' and 'smartcase' as set in this program (":set ic"). */
  private caseOpts = { ic: false, scs: false };
  private marks: { marker: IMarker; deco: IDecoration | undefined }[] = [];
  private timer = 0;
  private disposers: { dispose(): void }[];

  /** The program searched in, as the command that started it named it:
   * "vim", a "vi", or null, a pager's or one not known (pagerPattern). */
  private vi: "vim" | "vi" | null = null;
  /** The marks were put off by vim's ":noh"; its search kept (shownAgain). */
  private nohed = false;

  /** `shellCommand`: the cursor's row is the shell's command line (its prompt
   * first): the command typed on it ("" when it cannot be read), else null. */
  constructor(
    private term: Terminal,
    private shellCommand: () => string | null,
  ) {
    this.disposers = [
      term.onWriteParsed(() => {
        this.shownAgain();
        this.schedule();
      }),
      term.onResize(() => this.schedule()),
      // The alternate screen opened (the program the shell started: what it
      // is stays known) or closed (it has ended): whatever was marked is gone.
      term.buffer.onBufferChange((b) => (b.type === "normal" ? this.ended() : this.stop())),
    ];
  }

  /** Enter typed (not pasted): the bottom row, if it is a search line, sets what is marked. */
  enterTyped() {
    const buf = this.term.buffer.active;
    // A command run at the shell (the program has ended, whatever the screen
    // shows now): the marks are for the program it searched in.
    // (A ":set ic" with no search yet goes too.) What it starts tells how
    // the next search is read.
    if (buf.type === "normal") {
      const command = this.shellCommand();
      if (command !== null) {
        this.ended();
        this.vi = viCommand(command);
        return;
      }
    }
    if (buf.cursorY !== this.term.rows - 1) return;
    const line = buf.getLine(buf.baseY + buf.cursorY);
    // The rest of a long line wrapped onto the bottom row ("…/usr/lib"): no search line.
    if (!line || line.isWrapped) return;
    // Up to the cursor, which follows what was typed: "/foo " keeps its blank.
    const row = line.translateToString(false, 0, buf.cursorX);
    // vim's ":noh", ":nohl", ":nohls" … ":nohlsearch".
    if (/^:\s*noh(?:l(?:s(?:e(?:a(?:r(?:c(?:h)?)?)?)?)?)?)?\s*$/.test(row)) {
      this.stop();
      // vim marks again at the next "n": the search kept, to be shown then.
      this.nohed = this.vi === "vim" && this.searched !== null;
      return;
    }
    if (this.vi && NEW_SEARCH_COMMAND.test(row)) {
      // Its search is vim's last one now: "n" no longer brings the old back.
      this.nohed = false;
      return this.stop();
    }
    // ":set ic" / ":set noic" / ":set scs": what is marked follows, as
    // vim's own marks do, and the next search is read so.
    const opts = setCaseOptions(row, this.caseOpts);
    if (opts) {
      this.caseOpts = opts;
      if (this.searched && this.pattern !== null) this.mark(this.regexFor(this.searched.text, this.searched.delim));
      return;
    }
    const m = /^([/?])(.+)$/.exec(row);
    if (!m) return;
    // A pager has no offset after a delimiter: "/var/log" is all its text.
    const text = this.vi ? searchText(m[2], m[1]) : m[2];
    // "/" alone (or "//e") repeats the last search: the marks stay as they are.
    if (!text) return;
    this.searched = { text, delim: m[1], typed: m[2].trimEnd() };
    this.mark(this.regexFor(text, m[1]));
  }

  /** Marks what `re` finds; nothing (the old marks gone too) when what the
   * program finds is not known here. */
  private mark(re: RegExp | null) {
    this.nohed = false;
    if (!re) return this.stop();
    this.pattern = re;
    this.schedule();
  }

  private regexFor(text: string, delim: string): RegExp | null {
    // less reads a first "!", "*" or "@" as how to search ("!": lines
    // without it), not as part of the text.
    if (!this.vi) return /^[!*@]/.test(text) ? null : pagerPattern(text);
    const { ic, scs } = this.caseOpts;
    return viPattern(text, delim, ic && !(scs && hasCapital(text)), this.vi === "vim");
  }

  /** Enter pasted: a command pasted at the shell is not read (its text is
   * not on the line yet), so the next search is read the careful way. */
  enterPasted() {
    if (this.term.buffer.active.type === "normal" && this.shellCommand() !== null) this.ended();
  }

  /** After ":noh", vim's "n" or "N" (or the same search typed again) writes
   * that search on the bottom row ("/foo", "?foo"): marked again, as vim
   * marks it again. Another text there (a new search, "search hit BOTTOM")
   * changes nothing. */
  private shownAgain() {
    if (!this.nohed || !this.searched) return;
    const buf = this.term.buffer.active;
    // Still typed on the command line (incsearch shows it before Enter, and
    // Esc may follow): vim marks again only once back in the text.
    if (buf.cursorY === this.term.rows - 1) return;
    // vim's own "[1/5]" count after it (Neovim, shortmess without "S").
    const row = (buf.getLine(buf.baseY + this.term.rows - 1)?.translateToString(true) ?? "").replace(/\s+\[>?\d+\/>?\d+\]$/, "");
    const { text, delim, typed } = this.searched;
    // As typed ("/foo/e" with its offset) or as the pattern alone.
    if ([text, typed].some((s) => row === `/${s}` || row === `?${s}`)) this.mark(this.regexFor(text, delim));
  }

  /** The marks off (":noh"); the program's options stay. */
  stop() {
    this.pattern = null;
    clearTimeout(this.timer);
    this.clear();
  }

  /** The program has ended: the next one starts with its own options, and
   * is not known to be a vi until a command run at the shell says so. */
  private ended() {
    this.stop();
    this.searched = null;
    this.nohed = false;
    this.caseOpts = { ic: false, scs: false };
    this.vi = null;
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
    if (buf.type === "normal" && this.shellCommand() !== null) return this.ended();
    const rows = this.screenRows(buf);
    // vim's line numbers (":set nu", "less -N"): a column of numbers the
    // same width on the rows, no part of the file's lines.
    const gutter = numberGutter(rows);
    // A file line longer than the screen goes on in the next row (vi draws
    // it so itself): "^" is no line start there, nor "$" a line end before.
    const anchoredStart = /(?:^|[|(])\^/.test(re.source);
    const anchoredEnd = /(?<!\\)\$(?:$|[|)])/.test(re.source);
    const began = performance.now();
    for (const [n, row] of rows.entries()) {
      if (this.marks.length >= MAX_MARKS) break;
      // A pattern slow on this screen is left unmarked past a moment, not
      // left to stall the terminal.
      if (performance.now() - began > 50) break;
      if (row.status || (anchoredEnd && row.full) || (anchoredStart && rows[n - 1]?.full)) continue;
      const skip = gutter && row.text.length >= gutter ? gutter : 0;
      const text = row.text.slice(skip);
      re.lastIndex = 0;
      for (let m = re.exec(text); m && this.marks.length < MAX_MARKS; m = re.exec(text)) {
        // An empty match ("x*" where there is no x) marks nothing.
        if (!m[0]) {
          re.lastIndex++;
          continue;
        }
        const i = m.index + skip;
        const last = i + m[0].length - 1;
        const x = row.cols[i];
        const width = row.cols[last] + row.widths[last] - x;
        const y = row.y;
        // Markers are placed relative to the cursor's line.
        const marker = this.term.registerMarker(y - buf.cursorY);
        if (!marker) continue;
        // On top: xterm still draws the cursor above it (checked with the DOM
        // and the WebGL renderer), where vi leaves it on the match it found.
        const deco = this.term.registerDecoration({ marker, x, width, backgroundColor: "#F5C518", foregroundColor: "#111111", layer: "top" });
        this.marks.push({ marker, deco });
      }
    }
  }

  /** Every screen row but the bottom one (the program's command line), with
   * its text, the screen column and width of each character (a wide one,
   * Hangul, takes two columns), and whether it is drawn to the last column
   * (`full`) or is a status line drawn reversed across the screen. */
  private screenRows(buf: IBuffer): ScreenRow[] {
    const cell = buf.getNullCell();
    const out: ScreenRow[] = [];
    for (let y = 0; y < this.term.rows - 1; y++) {
      const line = buf.getLine(buf.baseY + y);
      if (!line) continue;
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
      const lastCell = line.getCell(line.length - 1, cell);
      // Drawn there, a blank too (an erased cell holds nothing).
      const full = !!lastCell && lastCell.getChars() !== "";
      const reversed = (x: number) => !!line.getCell(x, cell)?.isInverse();
      const status = line.length > 0 && reversed(0) && reversed(line.length - 1);
      // The blank rest of the row is no part of the line ("host$" ends at "t").
      out.push({ y, text: text.replace(/ +$/, ""), cols, widths, full, status });
    }
    return out;
  }
}

interface ScreenRow {
  y: number;
  text: string;
  cols: number[];
  widths: number[];
  full: boolean;
  status: boolean;
}
