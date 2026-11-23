// Check the translations: every language dictionary (src/i18n/<lang>.json)
// covers the same Korean phrases as English, keeps each phrase's "{n}"
// placeholders and HTML tags, and every guide (src/help/<lang>.ts) has the
// same sections as the Korean one (src/help.ts).
//
//   node scripts/i18n-check.mjs [lang …]
//
// Needs Node.js 23.6 or later (the pinned 24 in release.yml): it imports the
// app's TypeScript lookup (src/i18nTables.ts) directly.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The app's own lookup (Node runs the TypeScript with its types stripped).
import { build, HANGUL, translate, userText } from "../src/i18nTables.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dictDir = path.join(root, "src", "i18n");
const helpDir = path.join(root, "src", "help");
const wanted = process.argv.slice(2);

const placeholders = (s) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join(",");
// Real HTML tags only ("<버전>" in a path example is text).
const HTML = /<\/?(a|b|br|code|em|i|kbd|li|ol|p|pre|small|span|strong|table|td|th|tr|ul|h[1-6])\b[^>]*>/gi;
const tags = (s) => [...s.matchAll(HTML)].map((m) => m[0].startsWith("</") ? `/${m[1]}` : m[1]).sort().join(",");
// A leading "{0}" that is a button's icon (same rule as ICON in src/i18n.ts).
const ICON = /^\{0\}(?=[\p{L}\p{N}])/u;
// LF line ends first: in a CRLF checkout (Windows CI) "$" would never match.
const sectionIds = (file) => [...fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").matchAll(/^\s*id: "([^"]+)",$/gm)].map((m) => m[1]);

const reference = JSON.parse(fs.readFileSync(path.join(dictDir, "en.json"), "utf8"));
const keys = new Set(reference.map((e) => e.ko));
const koSections = sectionIds(path.join(root, "src", "help.ts"));
// No sections found means the pattern no longer fits help.ts: every language
// would then "match" an empty list and the comparison below would check nothing.
if (!koSections.length) {
  console.error("no help sections found in src/help.ts");
  process.exit(1);
}
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
  /** Plain phrase → translation, for the icon-key check below. */
  const plain = new Map();
  for (const e of entries) {
    if (typeof e.ko !== "string" || typeof e.t !== "string") {
      report(lang, `bad entry ${JSON.stringify(e).slice(0, 80)}`);
      continue;
    }
    // The translator keeps the first entry of a phrase: a second is never used.
    if (seen.has(e.ko)) report(lang, `duplicate phrase: ${e.ko.slice(0, 60)}`);
    seen.add(e.ko);
    if (!/\{\d+\}/.test(e.ko)) plain.set(e.ko, e.t);
    if (!keys.has(e.ko)) report(lang, `not a source phrase: ${e.ko.slice(0, 60)}`);
    if (!e.t.trim()) report(lang, `empty: ${e.ko.slice(0, 60)}`);
    if (placeholders(e.ko) !== placeholders(e.t)) report(lang, `placeholders ${placeholders(e.ko)} vs ${placeholders(e.t)}: ${e.ko.slice(0, 60)}`);
    if (tags(e.ko) !== tags(e.t)) report(lang, `tags ${tags(e.ko)} vs ${tags(e.t)}: ${e.ko.slice(0, 60)}`);
    if (lang !== "ko" && /[가-힣]/.test(e.t)) report(lang, `Korean left in: ${e.t.slice(0, 60)}`);
  }
  // "{0}저장" (an icon, then the label) is stripped to "저장" by the translator
  // (ICON in src/i18n.ts): it is the same text on screen as a plain "저장", so
  // the two must agree, or whichever comes first wins for both.
  for (const e of entries) {
    if (typeof e.ko !== "string" || !ICON.test(e.ko) || !ICON.test(e.t) || /\{[1-9]\}/.test(e.ko)) continue;
    const k = e.ko.replace(ICON, "");
    const t = e.t.replace(ICON, "");
    if (plain.has(k) && plain.get(k) !== t) report(lang, `icon key "${e.ko.slice(0, 40)}" (${t}) differs from "${k.slice(0, 40)}" (${plain.get(k)})`);
  }
  // Every phrase, run through the app's own lookup (src/i18nTables.ts), must
  // come out as its own translation: a rule change, or a broader phrase that
  // takes precedence, would otherwise mistranslate it silently on screen.
  // Left out: tag and entity phrases (split as the DOM splits them), icon keys
  // and adjacent values ("{0}{1}"), which have no single text to try.
  if (lang !== "ko") {
    const tables = build(entries, lang);
    const sample = (s) => s.replace(/\{(\d+)\}/g, (_m, n) => `Q${n}`);
    const tr = (s) => (HANGUL.test(s) ? translate(tables, s, tr) : s);
    const tried = new Set();
    for (const e of entries) {
      if (/<[^>]+>|&#|&[a-z]+;|\}\{/.test(e.ko) || ICON.test(e.ko) || tried.has(e.ko)) continue;
      tried.add(e.ko);
      const got = tr(sample(e.ko)).trim();
      if (got !== sample(e.t).trim()) report(lang, `"${e.ko.slice(0, 40)}" comes out as "${got.slice(0, 50)}"`);
    }
    // A user's value (userText) fills a phrase as written, while a plain value
    // that is itself a phrase is still translated. The value is one a broader
    // pattern ("{0} 포트를 열 수 없습니다: {1}") would match even with the
    // isolates around it, so only the userText rule keeps it.
    const name = "로컬 포트를 열 수 없습니다: x";
    const plainValue = tr(`${name} 을(를) 저장했습니다`);
    const userValue = tr(`${userText(name)} 을(를) 저장했습니다`);
    if (!userValue.includes(userText(name))) report(lang, `a userText value was translated: ${userValue}`);
    if (plainValue.includes(name)) report(lang, `a plain phrase value was not translated: ${plainValue}`);
    // Phrases joined by " · " (a tooltip, a status line) come out as each
    // translated alone: no phrase's value may take in the ones around it
    // ("Telnet · ⁨10.0.0.2⁩ · 23:15부터 연결됨" read as "{0}부터 연결됨" gave
    // "Connected since Telnet · …"). Pairs of the phrases, their values
    // filled (a number, a user's value), in a fixed pseudo-random order.
    {
      const phrases = [...tried]
        .filter((k) => !k.includes(" · ") && !k.includes("\n") && k.length < 70)
        .map((k, i) => k.replace(/\{(\d+)\}/g, (_m, n) => ((Number(n) + i) % 2 ? "12" : userText("web01"))));
      let seed = 11;
      const pick = () => phrases[(seed = (seed * 1103515245 + 12345) % 2147483648) % phrases.length];
      const wrong = [];
      for (let i = 0; i < 4000; i++) {
        const parts = i % 4 === 3 ? ["Telnet", userText("10.0.0.2"), pick()] : [pick(), pick()];
        const whole = tr(parts.join(" · "));
        const apart = parts.map(tr).join(" · ");
        if (whole !== apart) wrong.push(`"${parts.join(" · ").slice(0, 60)}" comes out as "${whole.slice(0, 60)}", not "${apart.slice(0, 60)}"`);
      }
      for (const w of wrong.slice(0, 3)) report(lang, w);
      if (wrong.length > 3) report(lang, `${wrong.length - 3} more phrases joined by " · " come out wrong`);
      // Texts the app makes, translated in full (a user's value aside): a
      // message holding " · " in parentheses shown inside another (devmon.rs's
      // timeout in a toast), and a tail added with its " · " (the editor's
      // status line, a transfer's result).
      for (const text of [
        "설정을 읽지 못했습니다: 장비가 응답하지 않습니다 (show running-config · 마지막 화면: Router#)",
        "리소스 표시 오류: 장비가 응답하지 않습니다 (로그인 후 · 마지막 화면: 없음) · 클릭해 다시 시도",
        `SSH · ${userText("10.0.0.2")} · 23:15부터 연결됨 · 장비가 응답하지 않습니다 (로그인 후 · 마지막 화면: 없음) · 23:20`,
        "120줄 · UTF-8 (BOM) · 저장 안 됨",
        "완료 · 파일 3개 · 안전하지 않은 이름·링크 1개 건너뜀",
      ]) {
        const got = tr(text);
        if (/[가-힣]/.test(got.replace(/⁨[^⁨⁩]*⁩/g, ""))) report(lang, `"${text.slice(0, 50)}" comes out as "${got.slice(0, 70)}"`);
      }
    }
    // English counts: a singular after 1 (not 11), never inside a user's value.
    if (lang === "en") {
      for (const [ko, want] of [
        ["1개 세션 연결 확인", "Test connection of 1 session"],
        ["11개 세션 연결 확인", "Test connection of 11 sessions"],
        ["선택한 세션 1개를 여기로 이동", "Move 1 selected session here"],
      ]) {
        const got = tr(ko);
        if (got !== want) report(lang, `"${ko}" comes out as "${got}", not "${want}"`);
      }
      const kept = tr(`${userText("1 files.txt")} 을(를) 저장했습니다`);
      if (!kept.includes(userText("1 files.txt"))) report(lang, `a user's value was changed: ${kept}`);
      // Every phrase counting something ("{0}개", "{0}대", "{0}번" …) read
      // with a count of 1 and of 2: the words after the count must differ
      // ("1 address" / "2 addresses"). The same plural after both ("1
      // scripts" / "2 scripts") is a noun missing from i18nTables.ts
      // ENGLISH_SINGULAR. Units that keep their form ("1 ms") are no nouns.
      const KEEP = new Set(["ms", "s"]);
      const after = (s, n) => new RegExp(`(?<![\\w.,])${n} ((?:[A-Za-z-]+ )?[A-Za-z]+)`).exec(s)?.[1];
      for (const e of entries) {
        for (const m of e.ko.matchAll(/\{(\d)\}\s*(?:개|대|번|줄|건|명|홉|초|분|시간|일)/g)) {
          const at = (n) => e.ko.replace(/\{(\d)\}/g, (_, i) => (i === m[1] ? String(n) : `Q${i}`));
          const one = after(tr(at(1)), 1);
          const two = after(tr(at(2)), 2);
          const noun = one?.split(" ").pop();
          if (one && one === two && noun.endsWith("s") && !KEEP.has(noun)) report(lang, `"${at(1).slice(0, 40)}" comes out as "${tr(at(1)).slice(0, 60)}": "${noun}" needs a singular in ENGLISH_SINGULAR`);
        }
      }
      // A count with a verb that must agree with it ("{0} lines are …"): the
      // noun becomes singular for 1, the verb does not ("1 line are"). Such a
      // message is put as "Lines indented with tabs: {0}" instead.
      for (const e of entries) {
        if (/\{\d\}\s+(?:[A-Za-z-]+\s+)?[A-Za-z]+s\s+(?:are|were|have|need|aren't|weren't|don't)\b/.test(e.t)) report(lang, `"${e.t.slice(0, 60)}" reads wrong for 1 (the verb does not follow the count); put the count after a label`);
      }
    }
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
