// Check the translations: every language dictionary (src/i18n/<lang>.json)
// covers the same Korean phrases as English, keeps each phrase's "{n}"
// placeholders and HTML tags, and every guide (src/help/<lang>.ts) has the
// same sections as the Korean one (src/help.ts).
//
//   node scripts/i18n-check.mjs [lang …]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dictDir = path.join(root, "src", "i18n");
const helpDir = path.join(root, "src", "help");
const wanted = process.argv.slice(2);

const placeholders = (s) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join(",");
// Real HTML tags only ("<버전>" in a path example is text).
const HTML = /<\/?(a|b|br|code|em|i|kbd|li|ol|p|pre|small|span|strong|table|td|th|tr|ul|h[1-6])\b[^>]*>/gi;
const tags = (s) => [...s.matchAll(HTML)].map((m) => m[0].startsWith("</") ? `/${m[1]}` : m[1]).sort().join(",");
const sectionIds = (file) => [...fs.readFileSync(file, "utf8").matchAll(/^\s*id: "([^"]+)",$/gm)].map((m) => m[1]);

const reference = JSON.parse(fs.readFileSync(path.join(dictDir, "en.json"), "utf8"));
const keys = new Set(reference.map((e) => e.ko));
const koSections = sectionIds(path.join(root, "src", "help.ts"));
let problems = 0;
const report = (lang, msg) => {
  problems++;
  if (problems <= 200) console.log(`${lang}: ${msg}`);
};

for (const file of fs.readdirSync(dictDir).filter((f) => f.endsWith(".json"))) {
  const lang = file.slice(0, -5);
  if (wanted.length && !wanted.includes(lang)) continue;
  const entries = JSON.parse(fs.readFileSync(path.join(dictDir, file), "utf8"));
  const seen = new Set();
  for (const e of entries) {
    if (typeof e.ko !== "string" || typeof e.t !== "string") {
      report(lang, `bad entry ${JSON.stringify(e).slice(0, 80)}`);
      continue;
    }
    seen.add(e.ko);
    if (!keys.has(e.ko)) report(lang, `not a source phrase: ${e.ko.slice(0, 60)}`);
    if (!e.t.trim()) report(lang, `empty: ${e.ko.slice(0, 60)}`);
    if (placeholders(e.ko) !== placeholders(e.t)) report(lang, `placeholders ${placeholders(e.ko)} vs ${placeholders(e.t)}: ${e.ko.slice(0, 60)}`);
    if (tags(e.ko) !== tags(e.t)) report(lang, `tags ${tags(e.ko)} vs ${tags(e.t)}: ${e.ko.slice(0, 60)}`);
    if (lang !== "ko" && /[가-힣]/.test(e.t)) report(lang, `Korean left in: ${e.t.slice(0, 60)}`);
  }
  const missing = [...keys].filter((k) => !seen.has(k));
  if (missing.length) report(lang, `${missing.length} phrases missing, e.g. ${missing.slice(0, 3).map((m) => m.slice(0, 40)).join(" | ")}`);
  const help = path.join(helpDir, `${lang}.ts`);
  if (!fs.existsSync(help)) report(lang, "no help file");
  else {
    const ids = sectionIds(help);
    if (ids.join(",") !== koSections.join(",")) report(lang, `help sections ${ids.join(",")} differ from ${koSections.join(",")}`);
  }
  console.log(`${lang}: ${entries.length} entries checked`);
}
console.log(problems ? `${problems} problem(s)` : "all translations consistent");
process.exit(problems ? 1 : 0);
