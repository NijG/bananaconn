// A device's own clock, as its log messages show it (the Syslog window's
// sender menu): read from the time Cisco devices put first in a message, and
// set against when the message came, this PC's clock. Pure: checked by
// scripts/clock-check.mjs.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The device's own clock in a message, against this PC's (when it came):
 * the time Cisco devices put first in a log message ("service timestamps",
 * "52: *Nov  8 10:00:01.123:", a year and "UTC" if set so). Another zone
 * named after it ("KST") is not read: null, as without a time. A time with
 * no year takes the year that puts it nearest to when it came.
 * Before the time: the syslog counter and a sequence number ("53: 000045:"),
 * an origin name or an IOS XR node ("R1:", "RP/0/RSP0/CPU0:"). "*": the
 * clock is not authoritative (never set, or no NTP); ".": it was, and NTP is
 * not in sync now. `utcGuess`: no zone shown and the difference is this
 * PC's offset from UTC (within a minute and a half): a device logging in
 * UTC, IOS's default, more likely than a clock off by exactly that. */
export function deviceClock(x: { text: string; at: number }): { skew: number; mark: "" | "*" | "."; utcGuess: boolean } | null {
  const m = /^(?:\d+:\s*)*(?:[\w./-]+:\s*)?([*.])?([A-Z][a-z]{2}) {1,2}(\d{1,2}) (?:(\d{4}) )?(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?( UTC| GMT)?:/.exec(x.text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]);
  if (month < 0) return null;
  const [day, h, min, s] = [m[3], m[5], m[6], m[7]].map(Number);
  const ms = m[8] ? Number(m[8].padEnd(3, "0")) : 0;
  const at = (year: number) => (m[9] ? Date.UTC(year, month, day, h, min, s, ms) : new Date(year, month, day, h, min, s, ms).getTime());
  let device: number;
  if (m[4]) device = at(Number(m[4]));
  else {
    const year = new Date(x.at).getFullYear();
    device = [year - 1, year, year + 1].map(at).reduce((a, b) => (Math.abs(b - x.at) < Math.abs(a - x.at) ? b : a));
  }
  if (!Number.isFinite(device)) return null;
  const skew = device - x.at;
  // Local time read off a UTC time: off by the PC's own offset (KST: -9h).
  const offset = -new Date(x.at).getTimezoneOffset() * 60_000;
  const utcGuess = !m[9] && offset !== 0 && Math.abs(skew + offset) < 90_000;
  return { skew, mark: (m[1] ?? "") as "" | "*" | ".", utcGuess };
}

/** A clock difference as a menu shows it: "45s", "3m 12s", "9h 00m", "2d 4h". */
export function skewText(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
