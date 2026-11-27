// Check the app's own Korean texts against the dictionaries: every whole
// Korean literal in a place the page translator reads (a title, placeholder
// or aria-label attribute; a dialog's or menu item's text property; a
// toast's text; tr("…"); a textContent set whole; an Error's message; the
// text between two tags of an HTML template) must come out in English with
// no Korean left,
// through the app's own lookup (src/i18nTables.ts). i18n-check.mjs compares
// the dictionaries with each other only, so a phrase dropped from all of them
// at once, or never added, is found here.
//
// Texts put together from parts (a template with ${…}) are left out: their
// pieces are checked where they are written whole, and the patterns in
// dynamic-i18n-check.mjs.
//
//   node scripts/source-i18n-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, HANGUL, translate } from "../src/i18nTables.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    // The dictionaries and guides themselves; the preview's stand-in backend.
    if (e.isDirectory()) {
      if (e.name !== "i18n" && e.name !== "help") walk(p);
    } else if (e.name.endsWith(".ts") && e.name !== "help.ts" && e.name !== "mock.ts") files.push(p);
  }
};
walk(root);

const tables = build(JSON.parse(fs.readFileSync(path.join(root, "i18n", "en.json"), "utf8")), "en");
const tr = (s) => (HANGUL.test(s) ? translate(tables, s, tr) : s);
// A string literal's body with Korean in it, escapes ("\\", "\"") allowed.
const Q = String.raw`"((?:[^"\\]|\\.)*?[가-힣](?:[^"\\]|\\.)*)"`;
// A template literal's, with no ${…} in it (a text put together is not one phrase).
const B = String.raw`\x60((?:[^\x60$\\]|\\.)*?[가-힣](?:[^\x60$\\]|\\.)*)\x60`;
/** Where the page translator meets a text, each with the fewest it must
 * find (about half of today's): a pattern that stops fitting the source
 * fails the check rather than checking nothing. `html`: the text is markup,
 * where entities ("&#10;", "&amp;") are what the page shows decoded. */
const SPOTS = [
  { name: "attributes", re: /\b(?:title|placeholder|aria-label)="([^"$`{}<>]*[가-힣][^"$`{}<>]*)"/g, html: true, floor: 120 },
  { name: "properties", re: new RegExp(String.raw`\b(?:label|hint|title|message|confirm|cancel|heading|body|placeholder|description|note|text):\s*` + Q, "g"), floor: 250 },
  { name: "toasts", re: new RegExp(String.raw`\btoast\(\s*(?:` + Q + "|" + B + ")", "g"), floor: 100 },
  // Translated in code (tr), put on the page whole, or an error shown as it is.
  { name: "tr()", re: new RegExp(String.raw`\btr\(\s*` + Q + String.raw`\s*\)`, "g"), floor: 40 },
  { name: "textContent", re: new RegExp(String.raw`\.textContent\s*=\s*` + Q, "g"), floor: 1 },
  { name: "errors", re: new RegExp(String.raw`\bnew Error\(\s*` + Q, "g"), floor: 8 },
  // Text between two tags in an HTML template ("<span>보내기</span>"), whole:
  // no ${…} in it, no quote or backtick (then it is not markup text). The DOM
  // translator takes each such text node alone. Not inside an element marked
  // data-i18n-skip (a user's own text).
  { name: "text between tags", re: />([^<>$`{}"]*[가-힣][^<>$`{}"]*)</g, html: true, tag: true, floor: 240 },
];
/** The text as the page has it: the source's escapes undone ("\\" in a
 * literal is one "\"), then, in markup, its entities. */
const shown = (literal, html) => {
  const text = literal.replace(/\\(.)/g, (_m, c) => ({ n: "\n", t: "\t" })[c] ?? c);
  if (!html) return text;
  return text
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
};

let checked = 0;
const found = new Map(SPOTS.map((s) => [s.name, 0]));
const missing = [];
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  for (const spot of SPOTS)
    for (const m of source.matchAll(spot.re)) {
      if (spot.tag) {
        const opening = source.slice(Math.max(0, m.index - 300), m.index + 1);
        if (/data-i18n-skip/.test(opening.slice(opening.lastIndexOf("<")))) continue;
      }
      const literal = m.slice(1).find((g) => g !== undefined);
      const text = shown(literal, spot.html).trim();
      if (!text) continue;
      checked++;
      found.set(spot.name, found.get(spot.name) + 1);
      if (/[가-힣]/.test(tr(text))) missing.push(`${path.relative(root, file)}:${source.slice(0, m.index).split("\n").length}: ${literal.slice(0, 80)}`);
    }
}
// A pattern that no longer fits the source finds next to nothing: the check
// would then pass while checking nothing there.
const short = SPOTS.filter((s) => found.get(s.name) < s.floor);
for (const s of short) console.error(`only ${found.get(s.name)} ${s.name} found (at least ${s.floor} expected): the pattern no longer fits the source`);
for (const m of missing) console.error(`not translated: ${m}`);
if (missing.length) console.error(`${missing.length} of ${checked} texts have no translation (add them to src/i18n/*.json)`);
if (short.length || missing.length) process.exit(1);
console.log(`${checked} source texts translate (${SPOTS.map((s) => `${s.name} ${found.get(s.name)}`).join(", ")})`);
