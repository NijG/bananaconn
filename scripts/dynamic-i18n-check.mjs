// Check that texts put together at run time (a file name, a size and a time
// joined with " · ", a count in a sentence) come out whole in every language:
// translated as the page translator would (src/i18nTables.ts), no Korean may
// be left outside the user's own text (kept between isolation marks, as
// userText() puts it).
//
//   node scripts/dynamic-i18n-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import fs from "node:fs";
import { build, translate } from "../src/i18nTables.ts";

const U = (s) => `\u2068${s}\u2069`;
const samples = [
  // TFTP tab log lines and notices.
  `받기 ${U("running-config")} → ${U("C:\\preview\\running-config")} · 97.7 KB · 0.8초 · 122 KB/초 · 블록 1428`,
  `보내기 ${U("C:\\a.bin")} → ${U("a.bin")} · 1.2 MB · 3.1초 · 400 KB/초 · 블록 512`,
  `받기 ${U("x")} → ${U("C:\\x")} · 취소함`,
  `${U("running-config")} 받는 중…`,
  `받았습니다: ${U("C:\\x")}`,
  // A whole-configuration check put in the terminal (nginx, Apache).
  "터미널에 nginx 전체 설정 검사 명령을 넣었습니다. 이 파일은 설정에 포함되어 있을 때만 검사됩니다. Enter를 눌러 실행하세요",
  "터미널에 Apache 전체 설정 검사 명령을 넣었습니다. 이 파일은 설정에 포함되어 있을 때만 검사됩니다. Enter를 눌러 실행하세요",
  // A folder walk (size, find by name) ended at a listing it could not read.
  `목록을 읽지 못해 멈췄습니다: ${U("연결이 끊어졌습니다")}`,
  // File servers' status lines (the shared folder is the user's).
  `${U("D:\\공유")} · 읽기/쓰기 · 이전 파일 보관 · 인증 사용`,
  `${U("D:\\설정")} · 읽기 전용 · 익명 허용`,
  // The editor: saves, a sudo save taken in, a crontab's problem.
  `${U("config.yml")}: 서버의 파일이 편집한 내용과 같아져 저장된 것으로 표시했습니다`,
  `${U("app.service")} 을(를) 저장했습니다. systemd에 반영하려면 daemon-reload가 필요합니다`,
  `${U("config.yml")} 을(를) 저장했습니다`,
  `${U("config.yml")}: 서버의 파일이 바뀌었습니다. 저장하면 덮어쓸지 먼저 묻습니다`,
  "crontab 문제: 줄 3",
  "JSON 오류: 줄 12",
  `서버의 파일을 읽지 못했습니다: ${U("Permission denied")}`,
  `터미널에 sudo 명령을 넣었습니다. Enter를 누르고 비밀번호를 입력하면 visudo 검사를 통과한 경우에만 저장됩니다(실패하면 파일은 그대로입니다). 그다음 편집기에서 다시 읽어 확인하세요. 저장되지 않았으면 사본 ${U("/home/u/.c")}을(를) 지우세요`,
];

let failed = 0;
const dir = new URL("../src/i18n/", import.meta.url);
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const lang = file.replace(/\.json$/, "");
  const t = build(JSON.parse(fs.readFileSync(new URL(file, dir), "utf8")), lang);
  const tr = (s) => translate(t, s, tr);
  for (const s of samples) {
    const out = tr(s);
    if (/[\uAC00-\uD7A3]/.test(out.replace(/\u2068[^\u2069]*\u2069/g, ""))) {
      failed++;
      console.error(`FAIL ${lang}: ${JSON.stringify(s.slice(0, 50))} -> ${JSON.stringify(out.slice(0, 80))}`);
    }
  }
}
if (failed) {
  console.error(`${failed} text(s) left partly in Korean`);
  process.exit(1);
}
console.log("texts put together at run time translate");
