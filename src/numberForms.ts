// A number selected in a terminal, in the other forms it is read in: a Unix
// time (journal and application logs, `date +%s`, `stat -c %Y`) as a date, a
// hexadecimal value (a register, a flag word, a netmask "0xffffff00" in BSD and
// AIX ifconfig) as decimal, binary and an IPv4 address, a decimal one as
// hexadecimal, and a byte count (ifconfig's RX bytes, `df -B1`, `du -b`) as a
// size. Each form is something to copy; none is guessed beyond what the digits
// say, so a 10-digit number shows as a time only within 2000–2099.
//
// Imports only modules without imports of their own (written with ".ts"):
// scripts/numbers-check.mjs runs it under Node.

import { permString } from "./remotePerm.ts";
import { WELL_KNOWN_PORTS } from "./wellKnownPorts.ts";

export interface NumberForm {
  /** What the text is (shown as the menu item's hint; translated). */
  kind: string;
  /** The value in that form, as copied. */
  text: string;
  /** A date and time (the number read as a Unix time). */
  time?: boolean;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "2024-11-24 07:13:20 (UTC+9)": this PC's clock, with its offset so the copy is unambiguous. */
function localTime(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const zone = off === 0 ? "UTC" : `UTC${off > 0 ? "+" : "-"}${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? `:${pad(Math.abs(off) % 60)}` : ""}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${ms % 1000 ? `.${pad(((ms % 1000) + 1000) % 1000, 3)}` : ""} (${zone})`;
}

/** A length of time as days and a clock: "3d 04:05:06", "00:01:30", with
 * the milliseconds when there are some ("00:01:00.250"). */
function durationText(ms: number): string {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const clock = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}${ms % 1000 ? `.${pad(ms % 1000, 3)}` : ""}`;
  return days ? `${days}d ${clock}` : clock;
}

/** 2000-01-01 to 2099-12-31 (UTC), as seconds. */
const FROM = 946_684_800;
const UNTIL = 4_102_444_800;

/** "117.7 MiB · 123.5 MB": both, as tools differ in which they print. */
function size(bytes: bigint): string {
  const n = Number(bytes);
  const unit = (base: number, names: string[]) => {
    let v = n;
    let i = 0;
    while (v >= base && i < names.length - 1) {
      v /= base;
      i++;
    }
    // Rounded up to the base ("1024 KiB"): one unit up instead.
    if (Number(v >= 100 ? v.toFixed(0) : v.toFixed(1)) >= base && i < names.length - 1) {
      v /= base;
      i++;
    }
    return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${names[i]}`;
  };
  return `${unit(1024, ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"])} · ${unit(1000, ["B", "kB", "MB", "GB", "TB", "PB", "EB"])}`;
}

/** Binary in groups of four, for values up to 32 bits (a flag word); longer is unreadable. */
const binary = (v: bigint) => {
  const bits = v.toString(2);
  return bits.padStart(Math.ceil(bits.length / 4) * 4, "0").replace(/(.{4})(?=.)/g, "$1 ");
};

/** A 32-bit value as a dotted address: a netmask (contiguous ones) also as its prefix. */
function dotted(v: bigint): NumberForm | null {
  if (v > 0xffffffffn) return null;
  const n = Number(v);
  const ip = [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
  const inverted = ~n >>> 0;
  const mask = n !== 0 && (inverted & (inverted + 1)) === 0;
  // The host bits are the low ones of the inverse; the prefix is what lies above them.
  if (mask) return { kind: "넷마스크", text: `${ip} (/${Math.clz32(inverted)})` };
  return { kind: "IPv4 주소로 볼 때", text: ip };
}

/** Digits that read as a mode someone sets (755, 644, 640, 4755, 1777):
 * the owner may read, the group has no right the owner lacks, others none
 * the group lacks. A year or a port (2024, 3306, 443) is seldom that. */
function likelyMode(mode: number): boolean {
  const [u, g, o] = [(mode >> 6) & 7, (mode >> 3) & 7, mode & 7];
  return (u & 4) !== 0 && (g & ~u) === 0 && (o & ~g) === 0;
}

/** The forms of `selection` when it is one number (decimal, with or without
 * thousands separators, or 0x hexadecimal); [] for anything else. */
export function numberForms(selection: string): NumberForm[] {
  const s = selection.trim();
  if (!s || s.length > 40) return [];
  const forms: NumberForm[] = [];
  const hex = /^0x([0-9a-f]{1,16})$/i.exec(s);
  if (hex) {
    const v = BigInt(`0x${hex[1]}`);
    forms.push({ kind: "10진수", text: v.toString() });
    if (v <= 0xffffffffn) forms.push({ kind: "2진수", text: binary(v) });
    // Eight digits is how a 32-bit address or mask is written ("0xffffff00").
    if (hex[1].length === 8) {
      const d = dotted(v);
      if (d) forms.push(d);
    }
    return forms;
  }
  // A length of time with its unit ("86400s", "3456789 seconds", "1500ms":
  // a timeout, an uptime, a TTL): as days and a clock, "1d 00:00:00", which
  // reads the same in every language. Only with the unit: a bare number is
  // too often something else.
  const span = /^(\d{1,12})\s?(ms|s|secs?|seconds?)$/i.exec(s);
  if (span) {
    const ms = span[2].toLowerCase() === "ms" ? Number(span[1]) : Number(span[1]) * 1000;
    return ms >= 60_000 ? [{ kind: "기간으로 볼 때", text: durationText(ms) }] : [];
  }
  // "0644", "04755": written in octal (chmod, stat): the mode and its value.
  // Zero-padded digits that make no mode anyone sets ("0123", "0000": an ID
  // or a counter) are read as the decimal number they are, below.
  if (/^0[0-7]{3,4}$/.test(s) && likelyMode(parseInt(s, 8))) {
    const mode = parseInt(s, 8);
    return [
      { kind: "권한으로 볼 때", text: permString(mode) },
      { kind: "10진수", text: String(mode) },
    ];
  }
  if (!/^(?:\d{1,20}|\d{1,3}(?:,\d{3}){1,6})$/.test(s)) return [];
  const v = BigInt(s.replace(/,/g, ""));
  // Below 16 every form reads the same; past 64 bits nothing prints such a number.
  if (v < 16n || v > 0xffffffffffffffffn) return [];
  // A port in "ss -tlnp" or netstat output: its service, first.
  const service = v <= 65535n ? WELL_KNOWN_PORTS[Number(v)] : undefined;
  if (service) forms.push({ kind: "잘 알려진 포트", text: service });
  // A Unix time in this century: seconds, or milliseconds (the two ranges do
  // not meet: 4.1e9 seconds at most, 9.4e11 milliseconds at least).
  const n = Number(v);
  const ms = n >= FROM && n < UNTIL ? n * 1000 : n >= FROM * 1000 && n < UNTIL * 1000 ? n : NaN;
  if (!Number.isNaN(ms)) {
    forms.push({ kind: "이 PC 시각", text: localTime(ms), time: true });
    forms.push({ kind: "UTC", text: new Date(ms).toISOString().replace(/\.000Z$/, "Z"), time: true });
  }
  // Octal digits as chmod takes them ("755", "0644", "4755"): the mode as
  // "ls -l" shows it (the other way from a listing's link, remotePerm).
  if (/^[0-7]{3,4}$/.test(s) && likelyMode(parseInt(s, 8))) forms.push({ kind: "권한으로 볼 때", text: permString(parseInt(s, 8)) });
  forms.push({ kind: "16진수", text: `0x${v.toString(16)}` });
  if (v >= 1024n) forms.push({ kind: "바이트로 볼 때", text: size(v) });
  return forms;
}

/** A time of day a log prints ("14:30:01", "00:01:23.456" in a Cisco
 * console's "*Mar  1 00:01:23.456:", log4j's "10:01:02,123"), with the date
 * before it when there is one in numbers ("2024-11-25 14:30:01",
 * "2024-11-25T14:30:01.5") and the offset after it ("Z", "+09:00", "+09").
 * Not part of a longer run of colon-separated digits (a MAC address
 * "00:11:22:33:44:55", an IPv6 address, a duration "1:02:03:04") or of a
 * dotted number ("v1.12:30:45"; after a word's full stop it is one), except
 * after a year and a colon, as Apache and nginx write a time
 * ("[10/Oct/2024:13:55:36 +0900]"). */
const STAMP = /(?<!\d)(?<!\d\.)(?<!(?<!\/\d{4}):)(?:(\d{4})-(\d\d)-(\d\d)[T ])?(\d{1,2}):(\d\d):(\d\d)(?:[.,](\d{1,9}))?(Z|[+-]\d\d(?::?\d\d)?)?(?![:.,]?\d)/gi;

/** An offset as minutes east of UTC ("Z", "+09:00", "+0900", "-05"). */
function offsetMinutes(zone: string): number {
  if (zone.toUpperCase() === "Z") return 0;
  const digits = zone.slice(1).replace(":", "");
  return (zone[0] === "-" ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0));
}

/** The first and the last time printed in a selection of log lines (a
 * console's, `show logging`, a file shown with cat: lines that all arrived
 * at once), and the time between them. Both with a date in numbers: by the
 * dates (a span over midnight); otherwise by the time of day alone. None
 * when fewer than two, when the last comes before the first (over midnight
 * with no date, or lines not in order: unknown), or when only one has an
 * offset. Offsets that differ ("Z" and "+09:00") are taken into account. */
export function printedSpan(selection: string): { first: string; last: string; ms: number } | null {
  if (selection.length > 1_000_000) return null;
  const stamps = [...selection.matchAll(STAMP)].filter((m) => {
    const [h, mi, se] = [m[4], m[5], m[6]].map(Number);
    if (h > 23 || mi > 59 || se > 59) return false;
    if (m[8] && m[8].toUpperCase() !== "Z") {
      const digits = m[8].slice(1).replace(":", "");
      if (Number(digits.slice(0, 2)) > 23 || Number(digits.slice(2) || 0) > 59) return false;
    }
    if (!m[1]) return true;
    const [y, mo, d] = [m[1], m[2], m[3]].map(Number);
    return y >= 1970 && mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
  });
  if (stamps.length < 2) return null;
  const a = stamps[0];
  const b = stamps[stamps.length - 1];
  if (!a[8] !== !b[8]) return null;
  const withDate = !!a[1] && !!b[1];
  // By the time of day alone, offsets that differ cannot be applied: which
  // day each is on is not known ("00:30+09:00" may be the day before "16:00Z").
  if (!withDate && a[8] && offsetMinutes(a[8]) !== offsetMinutes(b[8]!)) return null;
  const at = (m: RegExpMatchArray) => {
    const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
    const [h, mi, se] = [m[4], m[5], m[6]].map(Number);
    const local = withDate ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, mi, se, ms) : ((h * 60 + mi) * 60 + se) * 1000 + ms;
    return local - (withDate && m[8] ? offsetMinutes(m[8]) : 0) * 60_000;
  };
  const ms = at(b) - at(a);
  if (ms < 0) return null;
  return { first: a[0], last: b[0], ms };
}

/** A date and time as RFC 3339 writes it, with its offset ("2024-11-24T07:13:20Z",
 * "2024-11-24 16:13:20.5+09:00", journalctl -o short-iso's "+0900"): the
 * same instant in this PC's time, in UTC and as a Unix time, to line it up
 * with another log. One with no offset says nothing of its zone: [] (as for
 * anything else). Leap seconds (":60") are left out (a Date cannot hold them). */
export function timeForms(selection: string): NumberForm[] {
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:[.,](\d{1,9}))?(Z|[+-]\d\d(?::?\d\d)?)$/i.exec(selection.trim());
  if (!m) return [];
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  // Date.UTC reads years below 100 as 1900 on: those (and any other year an
  // offset cannot bring to 1970) are no log's time.
  if (y < 1969) return [];
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || se > 59) return [];
  const zone = m[8].toUpperCase();
  let offset = 0;
  if (zone !== "Z") {
    const oh = Number(zone.slice(1, 3));
    const om = zone.length > 3 ? Number(zone.slice(-2)) : 0;
    if (oh > 23 || om > 59) return [];
    offset = (zone[0] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const fraction = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
  const ms = Date.UTC(y, mo - 1, d, h, mi, se, fraction) - offset * 60_000;
  // From 1970 (a log's, and what Unix time counts from) to 9999 (four-digit
  // years, as written), by the instant: "1969-12-31T23:00:00-01:00" is 0.
  if (!Number.isFinite(ms) || ms < 0 || ms > Date.UTC(9999, 11, 31, 23, 59, 59, 999)) return [];
  const utc = new Date(ms).toISOString().replace(/\.000Z$/, "Z");
  return [
    { kind: "이 PC 시각", text: localTime(ms), time: true },
    ...(zone === "Z" ? [] : [{ kind: "UTC", text: utc, time: true }]),
    { kind: "Unix 시각", text: ms % 1000 ? (ms / 1000).toFixed(3) : String(ms / 1000) },
  ];
}
