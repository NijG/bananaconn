// Check that the Korean messages the Rust backend returns (errors shown in
// toasts and dialogs) are in the dictionaries: every Korean string literal
// in src-tauri/src (tests and comments left out), with its format!
// placeholders filled in, must translate into English with no Korean left.
// Strings that never reach the screen are listed in NOT_SHOWN with why.
//
//   node scripts/rust-i18n-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript lookup directly).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, HANGUL, translate } from "../src/i18nTables.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dict = JSON.parse(fs.readFileSync(path.join(root, "src", "i18n", "en.json"), "utf8"));
const tables = build(dict, "en");
const tr = (s) => translate(tables, s, tr);

/** Literals that are not messages for the screen. */
const NOT_SHOWN = new Map([
  // The app turns a failed private copy into its own message (clipboard.ts).
  ["다른 프로그램이 클립보드를 사용 중입니다", "replaced by the front end"],
  ["클립보드에 쓰지 못했습니다", "replaced by the front end"],
  ["클립보드에 쓸 메모리를 얻지 못했습니다", "replaced by the front end"],
  // Prefixes the backend matches its own messages by (the messages themselves are checked).
  ["설정의 끝을", "prefix match"],
  ["장비가 설정 보기를 거부", "prefix match"],
  // Shown in a native dialog before the window (and its dictionaries) exists.
  ["이전 버전의 데이터 폴더를 옮기지 못했습니다.\\n{}\\n\\n이전 버전(BananaTerm)이 실행 중이면 모두 닫은 뒤 BananaConn을 다시 실행하세요.\\n({})", "before the UI"],
  // Words a login prompt is recognised by, not text to show.
  ["사용자명", "prompt word"],
  ["아이디", "prompt word"],
  ["암호", "prompt word"],
  // An example host name in a placeholder test of the backend.
  ["서버.example.com", "example"],
  // updates.ts takes the reason after "UPDATE_AUTH::<share>::" (checked as its own key).
  ["UPDATE_AUTH::{root}::BADCRED::선택한 NAS 계정({})의 이름이나 비밀번호가 맞지 않습니다", "parsed by updates.ts"],
  ["UPDATE_AUTH::{root}::이 PC가 이미 다른 계정으로 {root} 에 연결되어 있습니다. 탐색기에서 연결을 끊거나 로그아웃한 뒤 다시 시도하세요", "parsed by updates.ts"],
]);

const dir = path.join(root, "src-tauri", "src");
const missing = [];
const seen = new Set();
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".rs") && !n.endsWith("tests.rs"))) {
  // A Windows checkout (CI) has CRLF line ends; the test marker below is LF.
  let src = fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");
  const testAt = src.indexOf("#[cfg(test)]\nmod tests");
  if (testAt >= 0) src = src.slice(0, testAt);
  src = src.replace(/\/\/[^\n]*/g, "");
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    const lit = m[1];
    if (!HANGUL.test(lit) || NOT_SHOWN.has(lit)) continue;
    seen.add(lit);
    let n = 0;
    const sample = lit
      .replace(/\{[^{}]*\}/g, () => `X${n++}Y`)
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
    if (HANGUL.test(tr(sample))) missing.push(`${f}: ${lit}`);
  }
}
// A NOT_SHOWN entry that is gone from the code is stale.
const stale = [...NOT_SHOWN.keys()].filter((k) => !fs.readdirSync(dir).some((f) => f.endsWith(".rs") && fs.readFileSync(path.join(dir, f), "utf8").includes(`"${k}"`)));
if (missing.length || stale.length) {
  for (const m of missing) console.error(`not in the dictionaries: ${m}`);
  for (const s of stale) console.error(`NOT_SHOWN entry no longer in the code: ${s}`);
  process.exit(1);
}
console.log(`${seen.size} backend messages translate`);
