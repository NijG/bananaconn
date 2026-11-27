// "Copy as table": selected lines of terminal output ("show ip interface
// brief", "show mac address-table", "df -h") as tab-separated cells, which a
// spreadsheet pastes one value per cell. The columns come from where the
// header's words start, each moved left to the gap all lines leave blank
// (right-aligned numbers start left of their header); where no line leaves
// such a gap, a value runs across ("0011.2233.4455" under "Mac Address") and
// it is not a column edge.

/** One line of output by screen cell: what each cell shows, and "" for the
 * right half of a wide character (so a position is a screen column). */
export type CellLine = string[];

/** A cell that shows nothing (past the end of the line counts too). */
const blank = (c: string | undefined) => c === undefined || (c !== "" && c.trim() === "");

/** A line with no column gap (two blanks or more between words): a title
 * ("Mac Address Table") or a rule ("-----"), never a table header. */
function titleLike(r: CellLine): boolean {
  const text = r.map((c) => (c === "" ? "x" : blank(c) ? " " : c)).join("").trim();
  return !/\S\s{2,}\S/.test(text);
}

/** Column edges (screen columns) with rows[0] as the header. An edge is put
 * where every line leaves the column left of it blank; `strict`: only right
 * at a header word, never moved left into a gap. */
function edgesFor(rows: CellLine[], strict = false): number[] {
  const head = rows[0];
  const width = Math.max(...rows.map((r) => r.length));
  const gap = (word: number, after: number) => {
    for (let edge = word; edge > (strict ? Math.max(after, word - 1) : after); edge--) if (rows.every((r) => blank(r[edge - 1]))) return edge;
    return -1;
  };
  const first = head.findIndex((c) => !blank(c));
  const cols: { edge: number; word: number }[] = [{ edge: 0, word: 0 }];
  // An indented header ("free": "total" far right, "Mem:" under nothing):
  // the row names left of it are a column of their own, when some line has
  // one and a gap separates them.
  if (first > 0) {
    const edge = gap(first, 0);
    if (edge > 0 && rows.some((r) => r.slice(0, edge).some((c) => !blank(c)))) cols.push({ edge, word: first });
  }
  for (let x = first + 1; x < head.length; x++) {
    if (blank(head[x]) || !blank(head[x - 1])) continue;
    // The previous header word's last cell, and the previous edge: this one stays right of both.
    let prevEnd = x - 1;
    while (prevEnd >= 0 && blank(head[prevEnd])) prevEnd--;
    const edge = gap(x, Math.max(prevEnd + 1, cols[cols.length - 1].edge));
    if (edge > 0) cols.push({ edge, word: x });
  }
  // Two header words one space apart, with nothing under one of them in any
  // line, are one header: "Mounted on" (df), "Peer Address:Port" (ss).
  const emptyUnder = (from: number, to: number) => rows.slice(1).every((r) => r.slice(from, to).every((x) => blank(x)));
  return cols
    .filter((c, i) => {
      if (i === 0 || c.word === first) return true;
      const oneSpace = !blank(head[c.word - 2]);
      const end = cols[i + 1]?.edge ?? width;
      return !(oneSpace && (emptyUnder(c.edge, end) || emptyUnder(cols[i - 1].edge, c.edge)));
    })
    .map((c) => c.edge);
}

/** Cells of `r` between `edges`. */
function cut(r: CellLine, edges: number[]): string[] {
  return edges.map((x, j) => r.slice(x, j + 1 < edges.length ? edges[j + 1] : r.length).join("").trim());
}

/** More values in a cell (split at wide gaps: "web    up" is two) than its
 * header has words: values from different columns ended up together. A
 * header-less row-name column ("" over "Mem:") is not judged. */
const overfull = (value: string, header: string) => !!header && value.split(/\s{2,}/).length > header.split(/\s+/).length;

/** The table in `lines`: rows of trimmed cells. The header is the first line,
 * or the first line after titles and rules ("Mac Address Table", "-----")
 * when there are any; those come as one cell each. Data lines never stand in
 * for the header: values with spaces in them ("Regular background program",
 * "Up 2 hours") must not become columns. Null when there are not at least a
 * header and one row. */
export function splitTable(lines: CellLine[]): string[][] | null {
  const rows = lines.filter((l) => l.some((c) => !blank(c)));
  let h = 0;
  while (h < rows.length - 1 && titleLike(rows[h]) && rows.slice(h + 1).some((r) => !titleLike(r))) h++;
  if (rows.length - h < 2) return null;
  // Lines below the header that start at the left edge with no column gap
  // may run across the gaps: a sentence after the table ("Total Mac
  // Addresses for this criterion: 1"), a name too long for its column on a
  // line of its own (df's "/dev/mapper/…", its values on the next line).
  // They place no edge; one that runs across an edge comes as one cell, as
  // titles do. Rules stay: their gaps are the columns'. An indented line (a
  // value continued, "show vlan" ports) is a row like any other.
  const loose = (r: CellLine, i: number) => i > h && titleLike(r) && !blank(r[0]) && !ruleLine(r);
  const fixed = rows.filter((r, i) => i >= h && !loose(r, i));
  const table = fixed.length >= 2 ? fixed : rows.slice(h);
  let edges = edgesFor(table);
  // A value that ran past its column (a wide first value pushing the rest
  // right) can make a moved edge split each line differently: a cell then
  // holds more values than its header has words. Read it again with edges
  // only at header words: columns may merge, but no value lands in another's.
  const head = cut(table[0], edges);
  if (table.slice(1).some((r) => cut(r, edges).some((v, j) => overfull(v, head[j] ?? "")))) edges = edgesFor(table, true);
  const across = (r: CellLine) => edges.some((x) => x > 0 && !blank(r[x - 1]) && !blank(r[x]));
  const columns = edges.length;
  /** A line that runs across the edges: a row packed with single spaces
   * ("show interfaces status" with a full description) when it has one word
   * per column, one cell per word; otherwise (a sentence, a long name) one cell. */
  const acrossCells = (r: CellLine): string[] => {
    const text = r.join("").trim();
    const words = text.split(/\s+/);
    return words.length === columns ? words : [text];
  };
  // Rules ("---- ------", "=====") only draw the table: no row of their own in
  // a spreadsheet (they still helped place the edges above). Only above the
  // header and right under it: further down, a row of dashes is values ("-"
  // for none in every column).
  const drawn = (r: CellLine, i: number) => (i < h || i === h + 1) && ruleLine(r);
  return rows.flatMap((r, i) => (drawn(r, i) ? [] : [i < h ? [r.join("").trim()] : loose(r, i) && across(r) ? acrossCells(r) : cut(r, edges)]));
}

/** A line of only dashes, equals signs and the like, with a run of three:
 * a rule. A value of "-" or "--" in a row of values is not one. */
const ruleLine = (r: CellLine) => {
  const text = r.join("");
  return /^[\s\-=+_]+$/.test(text) && /[-=_]{3}/.test(text);
};

/** Text as a Markdown fenced code block (CommonMark 4.5), to paste device
 * output into a ticket, a wiki or a chat that keeps its columns: line
 * endings as "\n", spaces at line ends and blank lines at either end
 * dropped, and a fence of backticks longer than any run inside (a line of
 * three backticks in the output would otherwise end the block early). */
export function codeBlock(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${lines.join("\n")}\n${fence}`;
}
