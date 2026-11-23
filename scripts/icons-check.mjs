// Check that every icon the code names is in the ICONS map of src/icons.ts:
// an unknown name only logs a warning and draws nothing, so a button or menu
// item would lose its icon without any other sign.
//
//   node scripts/icons-check.mjs
//
// The names are read where they are given: the first argument of icon(...)
// and the value of an "icon:" property, each up to where that expression
// ends, taking every "PascalCase" string in it (both sides of a ?: too). A
// name kept in a variable or a table elsewhere is not seen here.

import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..", "src");
const iconsSrc = fs.readFileSync(path.join(root, "icons.ts"), "utf8");
const start = iconsSrc.indexOf("const ICONS");
const end = iconsSrc.indexOf("};", start);
if (start < 0 || end < 0) {
  console.error("FAIL src/icons.ts: no ICONS map found");
  process.exit(1);
}
const known = new Set(iconsSrc.slice(iconsSrc.indexOf("{", start) + 1, end).match(/\b[A-Z][A-Za-z0-9]*\b/g) ?? []);
if (known.size < 10) {
  console.error(`FAIL src/icons.ts: only ${known.size} icons in the ICONS map`);
  process.exit(1);
}

/** The expression starting at `from`, up to a "," or ";" or a closing
 * bracket at its own depth (inside a template's "${…}", up to its "}"); its
 * double-quoted strings go to `names`. Comments and the text of strings are
 * skipped so their quotes and brackets do not count; a template's "${…}"
 * parts are read as expressions. Returns where it stopped. */
function scan(text, from, names, inTemplate) {
  let depth = 0;
  let i = from;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      if (c === '"') {
        const s = text.slice(i + 1, j);
        if (/^[A-Z][A-Za-z0-9]*$/.test(s)) names.push(s);
      }
      i = j;
    } else if (c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== "`") {
        if (text[j] === "\\") j += 2;
        else if (text[j] === "$" && text[j + 1] === "{") j = scan(text, j + 2, names, true) + 1;
        else j++;
      }
      i = j;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if ((c === "," || c === ";") && depth === 0 && !inTemplate) break;
  }
  return i;
}

function namesIn(text, from) {
  const names = [];
  scan(text, from, names, false);
  return names;
}

let failed = 0;
let seen = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts") && e.name !== "icons.ts") {
      const text = fs.readFileSync(p, "utf8");
      for (const m of text.matchAll(/\bicon\(|\bicon:\s*/g)) {
        // Named in a comment ("// icon(…)", a "/* … */" block's "* " line): not drawn.
        const lineStart = text.lastIndexOf("\n", m.index) + 1;
        if (/^\s*(?:\/\/|\/\*|\*)/.test(text.slice(lineStart, m.index))) continue;
        for (const name of namesIn(text, m.index + m[0].length)) {
          seen++;
          if (!known.has(name)) {
            failed++;
            const line = text.slice(0, m.index).split("\n").length;
            console.error(`FAIL ${path.relative(path.join(root, ".."), p)}:${line}: icon "${name}" is not in the ICONS map of src/icons.ts`);
          }
        }
      }
    }
  }
};
walk(root);
if (!seen) {
  console.error("FAIL no icon names found in src");
  process.exit(1);
}
console.log(failed ? `${failed} problem(s)` : `${seen} icon uses, all registered (${known.size} icons)`);
process.exit(failed ? 1 : 0);
