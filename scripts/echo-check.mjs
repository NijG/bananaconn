// Check src/localEcho.ts: what a serial session with local echo shows for
// what it sends (typed keys, an Enter, a Backspace, a paste, arrow keys).
//
//   node scripts/echo-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { localEcho } from "../src/localEcho.ts";

const cases = [
  ["show ver", "show ver"],
  ["\r", "\r\n"],
  ["ATZ\r", "ATZ\r\n"],
  // A paste with CR LF or LF line ends: one new line each.
  ["a\r\nb\nc\r", "a\r\nb\r\nc\r\n"],
  // Backspace as DEL (the terminal's) or ^H.
  ["ab\x7f", "ab\b \b"],
  ["x\x08", "x\b \b"],
  // Arrow and function keys, Ctrl+C: nothing shown.
  ["\x1b[A\x1b[D", ""],
  ["\x1bOP", ""],
  ["\x1b[15~x", "x"],
  ["\x03", ""],
  ["\t", ""],
  // Korean and other text as typed.
  ["전원 상태\r", "전원 상태\r\n"],
  ["", ""],
  // Backspace rubs out only what was echoed on this line: never the
  // device's prompt before it (nothing typed yet, or after an Enter).
  ["\x7f", ""],
  ["a\r\x7f", "a\r\n"],
  ["a\x7f\x7f", "a\b \b"],
  // A wide character (Hangul) is two columns: both rubbed out.
  ["한\x7f", "한\b\b  \b\b"],
  ["a한\x7f\x7f", "a한\b\b  \b\b\b \b"],
];
let problems = 0;
for (const [data, want] of cases) {
  const got = localEcho(data);
  if (got !== want) {
    problems++;
    console.log(`  ${JSON.stringify(data)} → ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
}
// The line carries over between keys typed one at a time.
{
  const line = { text: "" };
  const got = ["a", "b", "\x7f", "\x7f", "\x7f"].map((k) => localEcho(k, line)).join("");
  if (got !== "ab\b \b\b \b") {
    problems++;
    console.log(`  keys one at a time → ${JSON.stringify(got)}`);
  }
}
console.log(`${cases.length} echo cases checked`);
console.log(problems ? `${problems} problem(s)` : "local echo as expected");
process.exit(problems ? 1 : 0);
