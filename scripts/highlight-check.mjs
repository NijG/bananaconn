// Check the output keyword highlighting (src/highlight.ts): which words get
// which colour, and that it never changes anything else: escape sequences,
// a title or graphics payload, text a program colours itself, full-screen
// programs, sequences split between two chunks of output.
//
//   node scripts/highlight-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly). Control
// characters are built from their codes (an escape typed into a file can
// come out as the character itself).

import { KeywordHighlighter } from "../src/highlight.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const dec = (b) => String.fromCharCode(...b);
const MARKS = [
  [`${ESC}[1;31m`, "<R>"],
  [`${ESC}[1;33m`, "<Y>"],
  [`${ESC}[1;32m`, "<G>"],
  [`${ESC}[22;39m`, "</>"],
];
const show = (s) => MARKS.reduce((t, [a, b]) => t.split(a).join(b), s);

let failed = 0;
const expect = (name, got, want) => {
  if (got !== want) {
    failed++;
    console.error(`FAIL ${name}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
  }
};
/** The output of feeding `chunks` to one highlighter, with colours shown as marks. */
const run = (chunks, color = true) => {
  const h = new KeywordHighlighter();
  return show(chunks.map((c) => dec(h.process(enc(c), color))).join(""));
};

// Words and colours.
expect("general words", run(["error then warning then ok\r\n"]), "<R>error</> then <Y>warning</> then <G>ok</>\r\n");
expect("err-disabled", run(["Gi1/0/5  uplink  err-disabled 10\r\n"]), "Gi1/0/5  uplink  <R>err-disabled</> 10\r\n");
expect("errdisable", run(["errdisable recovery cause all\r\n"]), "<R>errdisable</> recovery cause all\r\n");
expect("flapping", run(["Host 0011.2233.4455 is flapping between ports\r\n"]), "Host 0011.2233.4455 is <Y>flapping</> between ports\r\n");
expect("not coloured", run(["link down, port up, interface disabled, shutdown\r\n"]), "link down, port up, interface disabled, shutdown\r\n");
expect("words only", run(["errors_total okay terror\r\n"]), "errors_total okay terror\r\n");

// A count of none is no trouble; any other count still is.
expect("zero counts", run(["     0 input errors, 0 CRC, 0 frame\r\n"]), "     0 input errors, 0 CRC, 0 frame\r\n");
expect("nonzero count", run(["     12 input errors, 10 errors, errors: 3\r\n"]), "     12 input <R>errors</>, 10 <R>errors</>, <R>errors</>: 3\r\n");
expect("zero after", run(["RX errors 0 dropped 0, failed: 0, 0 warnings\r\n"]), "RX errors 0 dropped 0, failed: 0, 0 warnings\r\n");

// A ping's loss: red when some packets were lost, plain when none were.
expect("ping loss", run(["3 packets transmitted, 0 received, 100% packet loss\r\n"]), "3 packets transmitted, 0 received, 100% <R>packet loss</>\r\n");
expect("ping no loss", run(["5 packets transmitted, 5 received, 0% packet loss\r\n"]), "5 packets transmitted, 5 received, 0% packet loss\r\n");
expect("windows ping", run(["    Packets: Sent = 4, Received = 0, Lost = 4 (100% loss),\r\n    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),\r\n"]), "    Packets: Sent = 4, Received = 0, Lost = 4 (100% <R>loss</>),\r\n    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),\r\n");
expect("zero loss written as a decimal", run(["Packet loss: 0.0%, loss 0.0%\r\n"]), "Packet loss: 0.0%, loss 0.0%\r\n");
expect("mtr column title", run(["                    Loss%   Snt   Last\r\n"]), "                    Loss%   Snt   Last\r\n");
expect("partial loss",run(["10 packets transmitted, 9 received, 10.0% packet loss\r\n"]), "10 packets transmitted, 9 received, 10.0% <R>packet loss</>\r\n");

// What it must leave alone.
expect("program's own colour", run([`${ESC}[31merror${ESC}[0m and error\r\n`]), `${ESC}[31merror${ESC}[0m and <R>error</>\r\n`);
expect("title payload", run([`${ESC}]0;error in title${BEL}ok\r\n`]), `${ESC}]0;error in title${BEL}<G>ok</>\r\n`);
expect("full-screen program", run([`${ESC}[?1049herror${ESC}[?1049l error\r\n`]), `${ESC}[?1049herror${ESC}[?1049l <R>error</>\r\n`);
expect("sequence split between chunks", run([`${ESC}[3`, `1merror${ESC}[0m\r\n`]), `${ESC}[31merror${ESC}[0m\r\n`);

// Nothing to colour, or colour off: the same bytes back, not a copy.
for (const [name, text, color] of [["no keyword", "plain text\r\n", true], ["colour off", "error\r\n", false]]) {
  const h = new KeywordHighlighter();
  const input = enc(text);
  if (h.process(input, color) !== input) {
    failed++;
    console.error(`FAIL ${name}: the input was copied or changed`);
  }
}

if (failed) process.exit(1);
console.log("keyword highlighting as expected");
