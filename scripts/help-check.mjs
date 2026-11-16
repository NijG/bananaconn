// Check that every translated help (src/help/*.ts) still says what the
// Korean help (src/help.ts) says, item by item: the same number of items,
// and in each item the same keys, code, bold terms and technical words
// (device messages such as %LINK-3-UPDOWN, names with digits such as
// Gi1/0/1, "show …" commands, numbers of three digits or more such as
// RFC 1918 or port 3389), which every language writes the same way. A sentence left out of one language (an edit script that
// skipped it) shows up as a word missing there.
//
//   node scripts/help-check.mjs

import fs from "node:fs";

const root = new URL("../src/", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), "utf8");
const items = (c) => [...c.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);

/** What an item holds that is written the same in every language, with counts. */
function marks(item) {
  const out = new Map();
  const add = (k) => out.set(k, (out.get(k) ?? 0) + 1);
  for (const m of item.matchAll(/\$\{kbd\("([^"]*)"\)\}|\$\{keyHint\("([^"]*)"\)\}/g)) add(`key ${m[1] ?? m[2]}`);
  for (const m of item.matchAll(/<code>/g)) add("<code>");
  for (const m of item.matchAll(/<b>/g)) add("<b>");
  const text = item.replace(/<[^>]+>/g, " ").replace(/\$\{[^}]*\}/g, " ");
  // A device message, a word with a digit in it, the first word of a show command.
  for (const m of text.matchAll(/%[A-Z0-9_-]+|\b[A-Za-z][A-Za-z0-9]*[0-9][A-Za-z0-9/.]*\b|\bshow [a-z-]+/g)) add(m[0]);
  // Numbers of three digits or more (a port, a limit, an RFC), each
  // language's thousands separator taken out ("20,000", "20 000", "20.000").
  const plain = text.replace(/(\d)[,. \u00a0\u202f](?=\d{3}(?!\d))/g, "$1");
  for (const m of plain.matchAll(/(?<![\d.,])\d{3,}(?![\d.,]\d)/g)) add(`#${m[0]}`);
  return out;
}

const ko = items(read("help.ts"));
let failed = 0;
for (const lang of ["en", "de", "es", "fr", "ja", "vi", "zh-CN", "zh-TW"]) {
  const tr = items(read(`help/${lang}.ts`));
  if (tr.length !== ko.length) {
    failed++;
    console.error(`FAIL ${lang}: ${tr.length} help items, Korean has ${ko.length}`);
    continue;
  }
  for (let i = 0; i < ko.length; i++) {
    const want = marks(ko[i]);
    const got = marks(tr[i]);
    // "show …" only as the Korean writes it: in English "show" is also a verb.
    const diff = [...new Set([...want.keys(), ...got.keys()])]
      .filter((k) => !(k.startsWith("show ") && !want.has(k)))
      .filter((k) => (want.get(k) ?? 0) !== (got.get(k) ?? 0))
      .map((k) => `${k} ${want.get(k) ?? 0}→${got.get(k) ?? 0}`);
    if (diff.length) {
      failed++;
      const title = /<b>([^<]*)<\/b>/.exec(ko[i])?.[1] ?? "";
      console.error(`FAIL ${lang} item ${i + 1} (${title}): ${diff.join(", ")}`);
    }
  }
}
if (failed) process.exit(1);
console.log(`help in 8 languages matches the Korean (${ko.length} items)`);
