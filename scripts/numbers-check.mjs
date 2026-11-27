// Check src/numberForms.ts: a number selected in the terminal shows the forms
// it is read in (a Unix time as a date, hexadecimal as decimal, binary, an
// address or a netmask, a byte count as a size), and text that is not one
// number shows none.
//
//   node scripts/numbers-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { numberForms, printedSpan, timeForms } from "../src/numberForms.ts";
import { parsePorts } from "../src/wellKnownPorts.ts";
import { oidName } from "../src/oidNames.ts";
import { priText } from "../src/syslogPri.ts";

let problems = 0;
const report = (msg) => {
  problems++;
  console.log(`  ${msg}`);
};
const formsOf = (s) => Object.fromEntries(numberForms(s).map((f) => [f.kind, f.text]));

/** [selection, { kind: text expected }] — only the kinds named are compared. */
const cases = [
  ["1732400000", { UTC: "2024-11-23T22:13:20Z", "16진수": "0x67425380" }],
  ["1732400000123", { UTC: "2024-11-23T22:13:20.123Z" }],
  ["  1700000000\n", { UTC: "2023-11-14T22:13:20Z" }],
  ["0xffffff00", { "10진수": "4294967040", "넷마스크": "255.255.255.0 (/24)" }],
  ["0xFFFFFFFF", { "넷마스크": "255.255.255.255 (/32)" }],
  ["0x80000000", { "넷마스크": "128.0.0.0 (/1)" }],
  ["0x0a000001", { "10진수": "167772161", "IPv4 주소로 볼 때": "10.0.0.1" }],
  ["0x1f4", { "10진수": "500", "2진수": "0001 1111 0100" }],
  ["0x00000000", { "IPv4 주소로 볼 때": "0.0.0.0" }],
  ["123456789", { "16진수": "0x75bcd15", "바이트로 볼 때": "118 MiB · 123 MB" }],
  ["1,048,576", { "바이트로 볼 때": "1.0 MiB · 1.0 MB" }],
  ["18446744073709551615", { "16진수": "0xffffffffffffffff" }],
  ["16", { "16진수": "0x10" }],
  // A well-known port: its service too (and still its other forms).
  ["443", { "잘 알려진 포트": "https", "16진수": "0x1bb" }],
  ["3389", { "잘 알려진 포트": "ms-wbt-server/RDP", "바이트로 볼 때": "3.3 KiB · 3.4 kB" }],
  ["22", { "잘 알려진 포트": "ssh" }],
  // Octal digits as chmod takes them: the mode as "ls -l" shows it.
  ["755", { "권한으로 볼 때": "rwxr-xr-x", "16진수": "0x2f3" }],
  ["0644", { "권한으로 볼 때": "rw-r--r--" }],
  ["4755", { "권한으로 볼 때": "rwsr-xr-x" }],
  ["1777", { "권한으로 볼 때": "rwxrwxrwt" }],
  // 2000-01-01 to 2001-09-09: nine digits of seconds, twelve of milliseconds.
  ["946684800", { UTC: "2000-01-01T00:00:00Z" }],
  ["999999999", { UTC: "2001-09-09T01:46:39Z" }],
  ["946684800000", { UTC: "2000-01-01T00:00:00Z" }],
  // Just under a unit: one unit up, not "1024 KiB" / "1000 kB".
  ["1048575", { "바이트로 볼 때": "1.0 MiB · 1.0 MB" }],
  ["999999", { "바이트로 볼 때": "977 KiB · 1.0 MB" }],
];
for (const [sel, want] of cases) {
  const got = formsOf(sel);
  for (const [kind, text] of Object.entries(want)) if (got[kind] !== text) report(`${JSON.stringify(sel)} ${kind}: "${got[kind]}", expected "${text}"`);
}

/** Kinds that must not be offered. */
const absent = [
  ["123456789", "이 PC 시각"], // 9 digits: not a time
  ["4102444800", "이 PC 시각"], // 2100: outside the range read as a time
  ["0x0a000001", "넷마스크"],
  ["0x1f4", "IPv4 주소로 볼 때"], // three digits: not written as an address
  ["1000", "바이트로 볼 때"],
  ["0x1ffffffff", "2진수"], // past 32 bits
  ["4444", "잘 알려진 포트"], // not in the table
  ["758", "권한으로 볼 때"], // 8 is no octal digit
  ["12345", "권한으로 볼 때"], // five digits
  ["8080", "권한으로 볼 때"],
  // A year or a port is not read as a mode; nor is a mode nobody sets.
  ["2024", "권한으로 볼 때"],
  ["3306", "권한으로 볼 때"],
  ["443", "권한으로 볼 때"],
  ["5432", "권한으로 볼 때"],
  ["604", "권한으로 볼 때"],
  // Written in octal ("0644"): its forms are the octal value's, not 644's.
  ["0644", "16진수"],
  ["0x1bb", "잘 알려진 포트"], // ports are written in decimal
  ["65979", "잘 알려진 포트"], // past 65535
];
// The service comes first: what a port number is selected for.
if (numberForms("443")[0]?.kind !== "잘 알려진 포트") report(`"443": the service is not the first form`);
for (const [sel, kind] of absent) if (kind in formsOf(sel)) report(`${JSON.stringify(sel)} offers "${kind}"`);

// Not one number: nothing.
for (const sel of ["", "7", "15", "abc", "12 34", "0x", "0xg1", "1.5", "-12", "10.0.0.1", "1,23,456", "12345678901234567890123", "0x12345678901234567", "ff00"]) {
  const n = numberForms(sel).length;
  if (n) report(`${JSON.stringify(sel)} shows ${n} form(s)`);
}

// A length of time with its unit, as days and a clock; under a minute, or with no unit, none.
for (const [sel, want] of [
  ["86400s", "1d 00:00:00"],
  ["3456789 seconds", "40d 00:13:09"],
  ["90 sec", "00:01:30"],
  ["300S", "00:05:00"],
  ["60500ms", "00:01:00.500"],
  ["1 second", null],
  ["59s", null],
  ["1500ms", null],
  ["86400 days", null],
  ["86400sx", null],
]) {
  const got = formsOf(sel)["기간으로 볼 때"] ?? null;
  if (got !== want) report(`${JSON.stringify(sel)} duration: ${got}, expected ${want}`);
}
if ("기간으로 볼 때" in formsOf("86400")) report("a bare number read as a duration");

// SNMP OIDs by their standard MIB names (SNMPv2-MIB, IF-MIB), an enterprise by its number.
for (const [sel, want] of [
  ["1.3.6.1.2.1.31.1.1.1.6.10001", "IF-MIB::ifHCInOctets.10001"],
  // sysUpTime's instance as net-snmp names it (DISMAN-EVENT-MIB, loaded by default).
  [".1.3.6.1.2.1.1.3.0", "DISMAN-EVENT-MIB::sysUpTimeInstance"],
  ["1.3.6.1.2.1.1.3", "SNMPv2-MIB::sysUpTime"],
  ["1.3.6.1.2.1.1.5.0", "SNMPv2-MIB::sysName.0"],
  ["1.3.6.1.2.1.2.2.1.8.3", "IF-MIB::ifOperStatus.3"],
  ["1.3.6.1.2.1.2.2.1.2", "IF-MIB::ifDescr"],
  ["1.3.6.1.2.1.31.1.1.1.18.5", "IF-MIB::ifAlias.5"],
  ["1.3.6.1.2.1.2.1.0", "IF-MIB::ifNumber.0"],
  ["1.3.6.1.6.3.1.1.4.1.0", "SNMPv2-MIB::snmpTrapOID.0"],
  ["1.3.6.1.6.3.1.1.5.3", "IF-MIB::linkDown"],
  ["1.3.6.1.6.3.1.1.5.4", "IF-MIB::linkUp"],
  ["1.3.6.1.4.1.9.9.46.1", "SNMPv2-SMI::enterprises.9.9.46.1"],
  ["1.3.6.1.2.1.25.2.3.1.6.31", "HOST-RESOURCES-MIB::hrStorageUsed.31"],
  ["1.3.6.1.2.1.25.3.3.1.2.196608", "HOST-RESOURCES-MIB::hrProcessorLoad.196608"],
  ["1.3.6.1.2.1.25.1.1.0", "HOST-RESOURCES-MIB::hrSystemUptime.0"],
  ["1.3.6.1.2.1.47.1.1.1.1.11.1001", "ENTITY-MIB::entPhysicalSerialNum.1001"],
  ["1.3.6.1.2.1.47.1.1.1.1.13.1", "ENTITY-MIB::entPhysicalModelName.1"],
  ["1.3.6.1.2.1.4.20.1.3.10.0.0.1", "IP-MIB::ipAdEntNetMask.10.0.0.1"],
  ["1.3.6.1.2.1.25.3.3.1.3.1", null],
  // net-snmp's own MIBs (NET-SNMP-MIB, UCD-SNMP-MIB) and the bare enterprises node.
  ["1.3.6.1.4.1.8072.3.2.10", "NET-SNMP-MIB::netSnmpAgentOIDs.10"],
  ["1.3.6.1.4.1.2021.10.1.3.1", "UCD-SNMP-MIB::laLoad.1"],
  ["1.3.6.1.4.1.2021.10.1.101.2", "UCD-SNMP-MIB::laErrMessage.2"],
  // A laEntry column with no name here: named by the enterprises node above it.
  ["1.3.6.1.4.1.2021.10.1.7.1", "SNMPv2-SMI::enterprises.2021.10.1.7.1"],
  // The deepest known node names it: sysUpTime.0's instance, not sysUpTime.
  ["1.3.6.1.2.1.1.3.0.5", "DISMAN-EVENT-MIB::sysUpTimeInstance.5"],
  ["1.3.6.1.4.1", "SNMPv2-SMI::enterprises"],
  // A sub-identifier past 4294967295 is no SNMP OID.
  ["1.3.6.1.4.1.4294967296", null],
  ["1.3.6.1.4.1.4294967295", "SNMPv2-SMI::enterprises.4294967295"],
  ["1.3.6.1.2.1.47.1.1.1.1.19.1", null],
  // Not named: past a table's columns, outside these MIBs, addresses, versions, leading zeros.
  ["1.3.6.1.2.1.2.2.1.23.1", null],
  ["1.3.6.1.2.1.1.9.1", null],
  ["1.3.6.1.2.1.10.7", null],
  ["10.0.0.1", null],
  ["1.2.3.4.5", null],
  ["1.3.6.01.2.1.1.3.0", null],
  ["1.3.6.1.2.1.1.3.0.", null],
]) {
  const got = oidName(sel);
  if (got !== want) report(`oidName ${JSON.stringify(sel)}: ${got}, expected ${want}`);
}

// A raw syslog message's PRI (RFC 5424 6.2.1): facility × 8 + severity.
for (const [sel, want] of [
  ["<189>", "local7.notice"],
  ["<34>", "auth.crit"], // RFC 5424's own example
  ["<13>", "user.notice"],
  ["<0>", "kern.emerg"],
  ["<191>", "local7.debug"],
  ["<86>", "authpriv.info"],
  ["<100>", "facility 12.warning"], // 12 to 15 are named differently by system
  ["<192>", null],
  ["<010>", null],
  ["189", null],
  ["< 189>", null],
]) {
  const got = priText(sel);
  if (got !== want) report(`priText ${JSON.stringify(sel)}: ${got}, expected ${want}`);
}

// The port check's list: numbers, ranges and service names (the table's, any case).
for (const [text, want] of [
  ["22, 80, 8000-8002", "22,80,8000,8001,8002"],
  ["ssh, https, RDP", "22,443,3389"],
  ["ms-wbt-server", "3389"],
  ["winrm", "5985,5986"], // a name two ports share
  ["DNS 53", "53"], // the same port twice is once
  ["vnc,5900-5901", "5900,5901"],
  ["nosuchservice", null],
  ["ssh, 70000", null],
  ["1-65", null], // 65 ports
  ["", null],
]) {
  const got = parsePorts(text)?.join(",") ?? null;
  if (got !== want) report(`parsePorts ${JSON.stringify(text)}: ${got}, expected ${want}`);
}

// This PC's time: the same instant, written with its offset.
const local = formsOf("1732400000")["이 PC 시각"] ?? "";
const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) \((UTC(?:[+-]\d{1,2}(?::\d\d)?)?)\)$/.exec(local);
if (!m) report(`local time not written as expected: "${local}"`);
else {
  const off = m[7] === "UTC" ? 0 : (m[7][3] === "-" ? -1 : 1) * (Number(m[7].slice(4).split(":")[0]) * 60 + Number(m[7].split(":")[1] ?? 0));
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - off * 60000;
  if (at !== 1732400000000) report(`local time "${local}" is not the instant 1732400000`);
}

// A time written with its offset (RFC 3339): UTC and Unix time; this PC's
// time is the same instant. Without an offset, or not a real date: nothing.
const timesOf = (s) => Object.fromEntries(timeForms(s).map((f) => [f.kind, f.text]));
const timeCases = [
  ["2024-11-24T07:13:20Z", { "Unix 시각": "1732432400" }],
  ["2024-11-24 16:13:20+09:00", { UTC: "2024-11-24T07:13:20Z", "Unix 시각": "1732432400" }],
  ["2024-11-24T16:13:20+0900", { UTC: "2024-11-24T07:13:20Z" }],
  ["2024-11-24T02:13:20-05", { UTC: "2024-11-24T07:13:20Z" }],
  ["2024-11-24T07:13:20.25z", { "Unix 시각": "1732432400.250" }],
  ["2024-11-24T07:13:20,123456+00:00", { UTC: "2024-11-24T07:13:20.123Z" }],
  ["2024-02-29T00:00:00Z", { "Unix 시각": "1709164800" }],
  // The instant decides, not the written year: this is Unix time 0.
  ["1969-12-31T23:00:00-01:00", { UTC: "1970-01-01T00:00:00Z", "Unix 시각": "0" }],
];
for (const [sel, want] of timeCases) {
  const got = timesOf(sel);
  for (const [kind, text] of Object.entries(want)) if (got[kind] !== text) report(`${JSON.stringify(sel)} ${kind}: "${got[kind]}", expected "${text}"`);
}
if ("UTC" in timesOf("2024-11-24T07:13:20Z")) report("a UTC time offers itself again as UTC");
for (const sel of ["2024-11-24T07:13:20", "2024-11-24", "2023-02-29T00:00:00Z", "2024-13-01T00:00:00Z", "2024-11-24T24:00:00Z", "2024-11-24T07:13:60Z", "2024-11-24T07:13:20+25:00", "1969-12-31T23:59:59Z", "x2024-11-24T07:13:20Z", "1970-01-01T08:59:59.5+09:00", "9999-12-31T23:59:59-23:59", "0099-06-01T00:00:00Z", "0070-01-01T00:00:00Z"])
  if (timeForms(sel).length) report(`${JSON.stringify(sel)} read as a time`);
{
  const local = timesOf("2024-11-24 16:13:20+09:00")["이 PC 시각"] ?? "";
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) \((UTC(?:[+-]\d{1,2}(?::\d\d)?)?)\)$/.exec(local);
  const off = !m ? NaN : m[7] === "UTC" ? 0 : (m[7][3] === "-" ? -1 : 1) * (Number(m[7].slice(4).split(":")[0]) * 60 + Number(m[7].split(":")[1] ?? 0));
  if (!m || Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - off * 60000 !== 1732432400000) report(`this PC's time "${local}" is not the instant`);
}

// The time between the first and the last time printed in selected log lines.
for (const [sel, want] of [
  // A Cisco console's lines (CRLF, as a capture keeps them): by the time of day.
  ["*Mar  1 00:01:23.456: %LINK-3-UPDOWN: down\r\n*Mar  1 00:01:25.956: %LINK-3-UPDOWN: up", "00:01:23.456 → 00:01:25.956 · 2500"],
  ["Nov 25 14:30:01 web sshd[1]: a\nNov 25 14:32:41 web sshd[1]: b\nNov 25 14:35:00 web sshd[1]: c", "14:30:01 → 14:35:00 · 299000"],
  // With dates: over midnight.
  ["2024-11-24 23:59:58,100 INFO a\n2024-11-25 00:00:01,600 INFO b", "2024-11-24 23:59:58,100 → 2024-11-25 00:00:01,600 · 3500"],
  ["2024-11-24T23:59:59Z a\n2024-11-25T00:00:01Z b", "2024-11-24T23:59:59Z → 2024-11-25T00:00:01Z · 2000"],
  // Over midnight with no date, or lines out of order: unknown.
  ["23:59:58 a\n00:00:02 b", null],
  // Offsets that differ: by the instant ("Z" is "+00:00"); only one has one: not compared.
  ["2024-11-24T10:00:00Z a\n2024-11-24T19:00:03+09:00 b", "2024-11-24T10:00:00Z → 2024-11-24T19:00:03+09:00 · 3000"],
  ["12:00:00Z a\n12:00:01+00:00 b", "12:00:00Z → 12:00:01+00:00 · 1000"],
  // By the time of day alone, different offsets: which day each is on is unknown.
  ["00:30:00+09:00 a\n16:00:00Z b", null],
  ["10:00:00+09:00 a\n10:00:04+0900 b", "10:00:00+09:00 → 10:00:04+0900 · 4000"],
  // Part of a dotted number (a version) is no time; after a word's full stop it is.
  ["v1.12:30:45 a\nv1.12:30:50 b", null],
  ["1.2.3.12:00:00 and 1.2.3.12:00:09", null],
  ["2024-11-24T10:00:00-05 a\n2024-11-24T15:00:02Z b", "2024-11-24T10:00:00-05 → 2024-11-24T15:00:02Z · 2000"],
  ["2024-11-24T10:00:00Z a\n2024-11-24T10:00:05 b", null],
  ["12:00:00+25:00 a\n12:00:05+25:00 b", null],
  // Apache and nginx ("[10/Oct/2024:13:55:36 +0900]"), and a time after a full stop.
  ['1.2.3.4 - - [10/Oct/2024:13:55:36 +0900] "GET /" 200\n1.2.3.4 - - [10/Oct/2024:13:56:06 +0900] "GET /a" 200', "13:55:36 → 13:56:06 · 30000"],
  ["done.12:00:00 then 12:00:05", "12:00:00 → 12:00:05 · 5000"],
  // A fraction past nanoseconds is no log's time.
  ["12:00:00.1234567890 a\n12:00:05 b", null],
  ["2024-11-24T10:00:00+09:00 a\n2024-11-24T10:00:05+0900 b", "2024-11-24T10:00:00+09:00 → 2024-11-24T10:00:05+0900 · 5000"],
  // One time only, or none.
  ["14:30:01 only one", null],
  ["no time here", null],
  // A MAC or IPv6 address, a 4-part duration, an impossible time: no times.
  ["00:11:22:33:44:55 and 00:11:22:33:44:66", null],
  ["fe80::10:20:30 and 2001:db8::11:22:33", null],
  ["1:02:03:04 and 1:02:03:09", null],
  ["25:00:00 a\n26:00:00 b", null],
]) {
  const s = printedSpan(sel);
  const got = s && `${s.first} → ${s.last} · ${s.ms}`;
  if (got !== want) report(`printedSpan ${JSON.stringify(sel)}: ${got}, expected ${want}`);
}

{
  const f = formsOf("0644");
  if (f["권한으로 볼 때"] !== "rw-r--r--" || f["10진수"] !== "420") report(`"0644" forms: ${JSON.stringify(f)}`);
  // Zero-padded digits that make no mode (an ID, a counter): the decimal number.
  for (const sel of ["0123", "0000", "0100"]) if ("권한으로 볼 때" in formsOf(sel)) report(`${sel} read as a mode`);
  if (formsOf("0123")["16진수"] !== "0x7b") report(`"0123" not read as decimal 123`);
  if (formsOf("0750")["권한으로 볼 때"] !== "rwxr-x---") report(`"0750" not read as a mode`);
  if (formsOf("00644")["권한으로 볼 때"] !== "rw-r--r--") report(`"00644" (an extra leading zero, as chmod takes it) not read as 0644`);
  const g = formsOf("04755");
  if (g["권한으로 볼 때"] !== "rwsr-xr-x" || g["10진수"] !== "2541" || "16진수" in g) report(`"04755" forms: ${JSON.stringify(g)}`);
  const local = timesOf("1970-01-01T00:00:01.250Z")["이 PC 시각"] ?? "";
  if (!/:\d\d\.250 \(/.test(local)) report(`fraction written as "${local}"`);
}

console.log(`${cases.length + absent.length} number cases and ${timeCases.length + 14} time cases checked`);
console.log(problems ? `${problems} problem(s)` : "number forms as expected");
process.exit(problems ? 1 : 0);
