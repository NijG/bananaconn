// What the Tab key indents with in a file opened in the editor: a tab where
// the file is indented with tabs (a Makefile's recipe lines must start with
// one), else as many spaces as the file uses. Pure.

/** Makefiles: a recipe line indented with spaces is "missing separator". */
const MAKEFILE = /^(?:GNUmakefile|makefile|Makefile)$|\.mk$/i;
/** YAML: tabs may not indent at all. */
const YAML = /\.ya?ml$/i;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** "\t", or two to eight spaces: from the file's name where its format
 * decides, else from how its lines are indented (more lines starting with
 * a tab than with spaces: a tab; else the step its space indents share).
 * Indents of one space (a " * " line in a C comment) say nothing. A file
 * with no indented lines gets two spaces. */
export function indentOf(name: string, text: string): string {
  if (MAKEFILE.test(name)) return "\t";
  // Counted as they come (a large file has hundreds of thousands of lines:
  // no list of widths, no spreading it into Math.min).
  let tabs = 0;
  let spaced = 0;
  let step = 0;
  let least = Infinity;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (line[0] === "\t") tabs++;
    else if (line.startsWith("  ")) {
      const w = line.length - line.trimStart().length;
      spaced++;
      step = gcd(step, w);
      least = Math.min(least, w);
    }
  }
  if (tabs > spaced && !YAML.test(name)) return "\t";
  if (!spaced) return "  ";
  // Of indents of 4, 8 and 12 the step is 4; a stray odd one falls back to
  // the smallest indent.
  const width = step >= 2 ? step : least;
  return " ".repeat(Math.max(2, Math.min(8, width)));
}
