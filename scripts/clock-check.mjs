// Check how a device's clock is read from its log messages (src/deviceClock.ts,
// the Syslog window's sender menu): Cisco's timestamp forms, its "*" and "."
// marks, the year guessed at a year's turn, UTC with and without its name,
// and messages with no such time. Any time zone: expectations are worked
// out from this PC's local time, as the app reads them.
//
//   node scripts/clock-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { deviceClock, skewText } from "../src/deviceClock.ts";

let failed = 0;
const fail = (...what) => {
  failed++;
  console.error("FAIL", ...what.map((w) => JSON.stringify(w)));
};
const at = new Date(2026, 10, 21, 10, 0, 0).getTime();
const read = (text, when = at) => deviceClock({ text, at: when });
const expect = (text, want, when = at) => {
  const got = read(text, when);
  const pick = got && { skew: got.skew, mark: got.mark, utcGuess: got.utcGuess };
  if (JSON.stringify(pick) !== JSON.stringify(want)) fail(text, pick, want);
};
const clock = (skew, mark = "", utcGuess = false) => ({ skew, mark, utcGuess });

// The forms Cisco devices put first in a message.
expect("52: *Nov 21 10:00:01: %LINK-3-UPDOWN: x", clock(1000, "*"));
expect("52: .Nov 21 10:00:01: %LINK-3-UPDOWN: x", clock(1000, "."));
expect("Nov 21 09:56:48.123: %SYS-5-CONFIG_I: x", clock(-191877));
expect("7: Nov 21 10:05:00: %X: y", clock(300000));
expect("Nov 21 2026 10:00:00.500: %X", clock(500));
expect("53: 000045: *Nov 21 10:00:01: %X", clock(1000, "*"));
expect("52: R1: *Nov 21 10:00:01: %X", clock(1000, "*"));
expect("Nov  8 10:00:01: %X", clock(1000), new Date(2026, 10, 8, 10, 0, 0).getTime());
expect("Nov 08 10:00:01: %X", clock(1000), new Date(2026, 10, 8, 10, 0, 0).getTime());
// A year's turn: the year nearest to when it came.
expect("Dec 31 23:59:59: %X", clock(-6000), new Date(2027, 0, 1, 0, 0, 5).getTime());
expect("Jan  1 00:00:05: %X", clock(6000), new Date(2026, 11, 31, 23, 59, 59).getTime());
// UTC named: read as UTC whatever this PC's zone.
const utcText = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
expect(`*${utcText(at + 2000)} UTC: %X`, clock(2000, "*"));
expect(`RP/0/RSP0/CPU0:${utcText(at + 2000)}.250 UTC: %X`, clock(2250));
// UTC not named: taken for local time, and called a UTC log where this PC's
// offset is the whole difference (not on a PC in UTC itself).
const offset = -new Date(at).getTimezoneOffset() * 60_000;
if (offset !== 0) expect(`52: ${utcText(at)}: %X`, clock(-offset, "", true));
// No device time, or another zone's name: nothing read.
for (const text of ["dhcpd: DHCPACK on 10.0.0.77", "%LINK-3-UPDOWN: Nov 21 10:00:01:", "Foo 21 10:00:00: x", "Nov 21 10:00:00 KST: %X", "<189>Nov 21 10:00:00 R1 %X", ""]) {
  if (read(text) !== null) fail(text, read(text), null);
}
// How a difference is shown.
for (const [ms, want] of [[45_000, "45s"], [-192_000, "3m 12s"], [9 * 3_600_000, "9h 00m"], [-(2 * 86_400_000 + 4 * 3_600_000), "2d 4h"], [400, "0s"]]) {
  if (skewText(ms) !== want) fail(ms, skewText(ms), want);
}

console.log(failed ? `${failed} problem(s)` : "device clocks read as expected");
process.exit(failed ? 1 : 0);
