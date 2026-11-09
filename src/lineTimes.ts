// When each line of a terminal's output arrived, to the second, for the
// terminal menu's "이 줄을 받은 시각" (device console messages and ping replies
// carry no time of their own). Lines are numbered from the start of the
// output, so the scrollback dropping its oldest lines moves no number; and
// only the first line of each second's new output is kept: a line's time is
// that of the last entry at or above it. A line rewritten in place (a
// progress bar, a redrawn prompt) keeps the time it first came. Lines whose
// time is not known (there before the record, or moved about on the screen)
// are told by an entry with no time: they show none, never another's.

export class LineTimes {
  /** Line numbers (ascending) and their times (ms since the epoch; null: not known). */
  private lines: number[] = [];
  private times: (number | null)[] = [];
  /** The last line whose output is accounted for (-1: none yet). */
  private covered = -1;

  /** The last line whose output is accounted for (-1: none yet). */
  get end(): number {
    return this.covered;
  }

  /** Output up to line `end` (the last one with anything on it) has arrived, at `t`. */
  wrote(end: number, t: number) {
    if (end <= this.covered) return;
    const last = this.times.length ? this.times[this.times.length - 1] : null;
    // Lines of the same second as the last entry are told by it.
    if (last === null || Math.floor(last / 1000) !== Math.floor(t / 1000)) this.push(this.covered + 1, t);
    this.covered = end;
  }

  /** Lines from `line` on were erased (a cleared screen): what comes there next is new. */
  erased(line: number) {
    this.dropFrom(line);
    this.covered = Math.min(this.covered, line - 1);
  }

  /** Lines `from` to `to` hold lines of unknown time now (moved about on the
   * screen: inserted, deleted, scrolled in a region), and so does what is
   * written there until output goes past `to`. */
  unknown(from: number, to: number) {
    const at = Math.min(from, this.covered + 1);
    this.dropFrom(at);
    this.push(at, null);
    this.covered = Math.max(this.covered, to);
  }

  /** Lines up to `end` are there already, at times not known: they show
   * none, and the next output starts after them. */
  skip(end: number) {
    if (end <= this.covered) return;
    this.push(this.covered + 1, null);
    this.covered = end;
  }

  /** Lines before `line` have left the scrollback: their entries go, but for
   * the one that still tells `line`'s time. */
  forget(line: number) {
    let n = 0;
    while (n + 1 < this.lines.length && this.lines[n + 1] <= line) n++;
    if (n) {
      this.lines.splice(0, n);
      this.times.splice(0, n);
    }
  }

  /** When `line` arrived, or null: no output there yet, or its time not known. */
  at(line: number): number | null {
    if (line > this.covered) return null;
    let lo = 0;
    let hi = this.lines.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.lines[mid] <= line) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found < 0 ? null : this.times[found];
  }

  /** Nothing is known any more (the screen was reset, or the lines counted from are gone). */
  reset() {
    this.lines = [];
    this.times = [];
    this.covered = -1;
  }

  /** The entries and the last line accounted for, to be renumbered (see restore). */
  snapshot(): { lines: number[]; times: (number | null)[]; covered: number } {
    return { lines: [...this.lines], times: [...this.times], covered: this.covered };
  }

  /** Entries at new line numbers (ascending, one per line), and the last
   * line accounted for: after the lines were renumbered (a reflow). */
  restore(lines: number[], times: (number | null)[], covered: number) {
    this.lines = lines;
    this.times = times;
    this.covered = covered;
  }

  private push(line: number, t: number | null) {
    // One entry per line: a later one at the same line replaces it.
    if (this.lines.length && this.lines[this.lines.length - 1] === line) this.times[this.times.length - 1] = t;
    else {
      this.lines.push(line);
      this.times.push(t);
    }
  }

  private dropFrom(line: number) {
    while (this.lines.length && this.lines[this.lines.length - 1] >= line) {
      this.lines.pop();
      this.times.pop();
    }
  }
}

/** A time as "14:03:22", with its date first when not today ("2026-11-07 14:03:22"). */
export function clockText(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}
