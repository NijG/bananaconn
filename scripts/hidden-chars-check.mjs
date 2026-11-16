// Check that no invisible or look-alike character hides in the code, the
// guides or the dictionaries: a no-break hyphen or space, a zero-width or
// direction mark, a byte order mark written as the character itself. They
// cannot be seen in an editor, a tool may drop or change them unnoticed,
// and in a guide they break words or searches. Code that means one writes
// it escaped (backslash-u FEFF). The user-text isolates (U+2068, U+2069) of
// i18nTables.ts are the one intended exception.
//
//   node scripts/hidden-chars-check.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The characters by code point (written as numbers: an escape typed into a
// file can come out as the character itself).
// Raw control characters too (tab, line feed and carriage return aside): code
// that sends one (Ctrl-U to a terminal) writes it escaped.
const CODES = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f], [0xa0], [0xad], [0x200b, 0x200f], [0x2011], [0x202a, 0x202e], [0x2060, 0x2065], [0x206a, 0x206f], [0xfeff], [0x3000]];
// A backslash by its code too (92), for the same reason.
const hex = (n) => `${String.fromCharCode(92)}u${n.toString(16).padStart(4, "0")}`;
const HIDDEN = new RegExp(`[${CODES.map(([a, b]) => (b ? `${hex(a)}-${hex(b)}` : hex(a))).join("")}]`, "g");
const BOM = String.fromCharCode(0xfeff);

const files = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
      if (!["node_modules", "target", "target-check", "assets"].includes(name)) walk(p);
    } else if (/\.(ts|mjs|rs|css|html|json)$/.test(name)) files.push(p);
  }
};
for (const dir of ["src", "src-tauri/src", "scripts"]) walk(path.join(root, dir));
files.push(path.join(root, "index.html"));

const found = [];
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const text = fs.readFileSync(f, "utf8");
  for (const m of text.matchAll(HIDDEN)) {
    // A byte order mark at the very start is the file's own, not text.
    if (m.index === 0 && m[0] === BOM) continue;
    const line = text.slice(0, m.index).split("\n").length;
    found.push(`${path.relative(root, f)}:${line}: U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
  }
}
if (found.length) {
  for (const x of found.slice(0, 50)) console.error(x);
  console.error(`${found.length} hidden character(s); write them escaped (\\uXXXX) or remove them`);
  process.exit(1);
}
console.log(`no hidden characters in ${files.length} files`);
