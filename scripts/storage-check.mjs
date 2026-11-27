// Check that no localStorage write can throw out of an action: past the
// quota (or with storage unavailable) setItem throws, and the action that
// made the change (a server start, a tunnel saved, a setting changed) would
// fail with it. Each write is either store.ts saveLocal (which says once that
// it could not save) or inside a try block of its own.
//
//   node scripts/storage-check.mjs
//
// A write counts as guarded when a "try {" block still open at that point
// encloses it, found by matching braces back from the write (strings,
// regular expressions, comments and template text are skipped so their
// braces and quotes do not count). Not seen: a callback written inside a try
// but run later, outside it; such a write still needs its own guard.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));

/** The source with every string, regular expression literal, comment and
 * template literal text blanked to spaces (line breaks kept, so positions
 * stay), so only code, with its braces, remains. The code inside a template
 * literal's ${…} is kept (nested templates too): a write there is found. */
function code(source) {
  const out = [...source];
  const blank = (from, to) => {
    for (let k = from; k < to && k < source.length; k++) if (source[k] !== "\n") out[k] = " ";
  };
  // A "/" starts a regular expression where an expression may begin: after
  // these characters, or after these words (else it divides).
  const BEFORE_REGEX = /[(,=:[!&|?{};+\-*%<>~^]$|(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|new)$/;
  /** Skip code from `i` until the "}" that closes a ${…} (depth 0), or the end. */
  const scanCode = (i, inTemplate) => {
    let depth = 0;
    let last = ""; // the code before this point, trimmed, for the regex rule
    while (i < source.length) {
      const c = source[i];
      const next = source[i + 1];
      if (c === "/" && next === "/") {
        const end = source.indexOf("\n", i);
        const stop = end < 0 ? source.length : end;
        blank(i, stop);
        i = stop;
      } else if (c === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        const stop = end < 0 ? source.length : end + 2;
        blank(i, stop);
        i = stop;
      } else if (c === "/" && BEFORE_REGEX.test(last.trimEnd() || "(")) {
        let j = i + 1;
        let cls = false;
        while (j < source.length && source[j] !== "\n" && (cls || source[j] !== "/")) {
          if (source[j] === "\\") j++;
          else if (source[j] === "[") cls = true;
          else if (source[j] === "]") cls = false;
          j++;
        }
        while (/[a-z]/.test(source[j + 1] ?? "")) j++;
        blank(i, j + 1);
        i = j + 1;
        last += " /re/";
      } else if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < source.length && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
        blank(i, j + 1);
        i = j + 1;
        last += ' ""';
      } else if (c === "`") {
        i = scanTemplate(i + 1);
        last += " ``";
      } else {
        if (c === "{") depth++;
        else if (c === "}") {
          if (inTemplate && depth === 0) return i + 1;
          depth--;
        }
        last = (last + c).slice(-40);
        i++;
      }
    }
    return i;
  };
  /** Blank a template literal's text from `i` (after its "`"), keeping the
   * code of each ${…}; returns the position after its closing "`". */
  const scanTemplate = (i) => {
    const start = i - 1;
    let textFrom = start;
    while (i < source.length) {
      const c = source[i];
      if (c === "\\") i += 2;
      else if (c === "`") {
        blank(textFrom, i + 1);
        return i + 1;
      } else if (c === "$" && source[i + 1] === "{") {
        blank(textFrom, i + 2);
        i = scanCode(i + 2, true);
        // The "}" that closed the ${…} is the template's again.
        textFrom = i - 1;
      } else i++;
    }
    blank(textFrom, source.length);
    return i;
  };
  scanCode(0, false);
  return out.join("");
}

/** Whether position `at` lies inside an open "try {" block of `src` (code()). */
function insideTry(src, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = src[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth > 0) depth--;
      else if (/\btry\s*$/.test(src.slice(Math.max(0, i - 12), i))) return true;
    }
  }
  return false;
}

let checked = 0;
const bare = [];
for (const file of walk(root)) {
  const rel = path.relative(root, file).replace(/\\/g, "/");
  // The preview's stand-in backend never runs in the app.
  if (rel === "mock.ts") continue;
  const source = fs.readFileSync(file, "utf8");
  const src = code(source);
  for (const m of src.matchAll(/localStorage\.setItem\(/g)) {
    checked++;
    if (insideTry(src, m.index)) continue;
    bare.push(`${rel}:${source.slice(0, m.index).split("\n").length}`);
  }
}
// Nothing found means the search no longer fits the source.
if (checked < 25) {
  console.error(`only ${checked} localStorage writes found: the search no longer fits the source`);
  process.exit(1);
}
for (const b of bare) console.error(`unguarded localStorage.setItem at ${b}: use saveLocal (store.ts) or a try block`);
if (bare.length) process.exit(1);
console.log(`${checked} localStorage writes guarded`);
