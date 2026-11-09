// "Show all matching lines" of the terminal's find bar: which lines of the
// output contain what is searched for, with where (to highlight), as
// "| include" would on the device, without running the command again.

/** One line of output (a wrapped line joined) and the buffer row it starts on. */
export interface OutputLine {
  row: number;
  text: string;
}

export interface LineMatch extends OutputLine {
  /** [start, end) of each match in `text` (none for an empty regex match). */
  ranges: [number, number][];
}

/** The lines that contain `query` (a regular expression when `regex`), at most
 * `limit` of them; `more` when there were others. Null for a regular
 * expression that does not compile, and an empty query matches nothing. */
export function matchLines(
  lines: Iterable<OutputLine>,
  query: string,
  opts: { regex: boolean; caseSensitive: boolean },
  limit: number,
): { matches: LineMatch[]; more: boolean } | null {
  if (!query) return { matches: [], more: false };
  // Plain text is searched as an escaped regex too: lower-casing both sides
  // instead can change a line's length ("İ" becomes two characters) and so
  // move every highlight after it.
  let re: RegExp;
  try {
    re = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), opts.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
  const find = (text: string): [number, number][] | null => {
    const ranges: [number, number][] = [];
    let hit = false;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      hit = true;
      if (m[0].length) ranges.push([m.index, m.index + m[0].length]);
      // An empty match ("^", "x*") would match at the same place forever.
      else re.lastIndex++;
      if (re.lastIndex > text.length) break;
    }
    return hit ? ranges : null;
  };
  const matches: LineMatch[] = [];
  for (const line of lines) {
    const ranges = find(line.text);
    if (!ranges) continue;
    if (matches.length === limit) return { matches, more: true };
    matches.push({ ...line, ranges });
  }
  return { matches, more: false };
}
