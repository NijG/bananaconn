// Check how a typed or pasted address is read (src/model.ts): user, host and
// port, a URL's scheme as the protocol, and what is no address.
//
//   node scripts/target-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { formatTarget, hasScheme, parseTarget, schemeProtocol, sessionDefaultsFor } from "../src/model.ts";

let failed = 0;
const check = (what, got, want) => {
  const [g, w] = [JSON.stringify(got), JSON.stringify(want)];
  if (g !== w) {
    failed++;
    console.error("FAIL", JSON.stringify(what), g, w);
  }
};

for (const [text, want] of [
  ["root@10.0.0.1:22", { username: "root", host: "10.0.0.1", port: 22 }],
  ["10.0.0.1", { username: "", host: "10.0.0.1", port: null }],
  ["ssh://admin@sw1:2222/", { username: "admin", host: "sw1", port: 2222 }],
  ["telnet://10.0.0.1", { username: "", host: "10.0.0.1", port: null }],
  ["sftp://u:secret@h.example:22?x", { username: "u", host: "h.example", port: 22 }],
  ["fe80::1", { username: "", host: "fe80::1", port: null }],
  ["[fe80::1]:22", { username: "", host: "fe80::1", port: 22 }],
  ["10.0.0.0/24", null],
  ["h:70000", null],
  ["", null],
]) {
  const t = parseTarget(text);
  check(`parse ${text}`, t && { username: t.username, host: t.host, port: t.port }, want);
}

for (const [text, want] of [
  ["telnet://10.0.0.1", "telnet"],
  ["SFTP://host", "sftp"],
  ["  rdp://pc1:3389", "rdp"],
  ["vnc://h", "vnc"],
  ["ftps://h", "ftps"],
  ["https://h/admin", null],
  ["serial://COM3", null],
  ["constructor://h", null],
  ["10.0.0.1", null],
  ["ssh:/h", null],
]) check(`scheme ${text}`, schemeProtocol(text), want);

// The session defaults: the scheme first, else the port, else SSH.
for (const [text, want] of [
  ["telnet://10.0.0.1", "telnet"],
  ["10.0.0.1:23", "telnet"],
  ["ssh://h:23", "ssh"],
  ["10.0.0.1", "ssh"],
  // Not an address to make a session for: a URL of something else.
  ["https://intranet.example/admin", undefined],
  ["serial://COM3", undefined],
]) check(`defaults ${text}`, sessionDefaultsFor(text)?.protocol, want);
// Written back as remembered: read again, the same target, never a password.
for (const text of ["root@10.0.0.1:22", "10.0.0.1", "fe80::1", "[fe80::1]:22", "sftp://u:secret@h.example:22?x", "ftp://h:21/a@b", "admin@sw1"]) {
  const t = parseTarget(text);
  const back = formatTarget(t);
  check(`round trip ${text}`, parseTarget(back), t);
  check(`no password ${text}`, back.includes("secret"), false);
}
check("path @ kept out", formatTarget(parseTarget("ftp://h:21/a@b")), "h:21");

for (const [text, want] of [["https://h", true], ["sftp://h", true], ["10.0.0.1", false], ["COM3:115200", false], ["fe80::1", false]]) {
  check(`has scheme ${text}`, hasScheme(text), want);
}

console.log(failed ? `${failed} problem(s)` : "addresses read as expected");
process.exit(failed ? 1 : 0);
