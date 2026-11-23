// Check what an SSH or Telnet connection that ended calls for
// (src/sshLogin.ts afterExit): never another login where one failed or did
// not finish, an automatic reconnect only after a logged-in session dropped,
// and, inside that chain, again only while the server was not reached.
//
//   node scripts/login-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { afterExit, asksLogin, loginFailure, loginThrough, plainLines, unusableKey } from "../src/sshLogin.ts";

let failed = 0;
const check = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error("FAIL", what, JSON.stringify(got), JSON.stringify(want));
  }
};
// The end of a connection's output, CRLF as the Windows pseudo-console writes it.
const out = (...lines) => plainLines(lines.join("\r\n"));
const ssh = (code, lines, s = {}) => afterExit({ protocol: "ssh", code, lines, loginAsked: false, loggedIn: false, chain: false, ...s });
const telnet = (code, lines, s = {}) => afterExit({ protocol: "telnet", code, lines, loginAsked: false, loggedIn: false, chain: false, ...s });

const prompt = out("Welcome to Ubuntu 24.04", "", "user@web01:~$ ");
const refused = out("user@10.0.0.5: Permission denied (publickey,password).");
const hostkey = out("@@@@@@@@@@@@", "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @", "Host key verification failed.");
const timedOut = out("ssh: connect to host 10.0.0.5 port 22: Connection timed out");
const noName = out("ssh: Could not resolve hostname web01: No such host is known. ");
const closed = out("Connection closed by 10.0.0.5 port 22");
const reset = out("kex_exchange_identification: read: Connection reset");

// A logged-in session that dropped: reconnects, and starts a chain.
check("ssh logged-in drop", ssh(255, out("user@web01:~$ ", "client_loop: send disconnect: Connection reset"), { loggedIn: true }), { verdict: "dropped", chain: true });
// The user ended the shell (exit 0, or the shell's own status): no reconnect.
check("ssh exit 0", ssh(0, [], { loggedIn: true }), { verdict: "ended", chain: false });
check("ssh exit 1", ssh(1, prompt, { loggedIn: true }), { verdict: "ended", chain: false });
// Failure words in a session the user ended are no failed login.
check("ssh exit 0 after words", ssh(0, refused, { loggedIn: true }), { verdict: "ended", chain: false });
// A refused login inside a chain: never again (the chain is kept, not used).
check("chain then refused", ssh(255, refused, { chain: true, loggedIn: false }), { verdict: "failed", failure: "auth", chain: true });
// Another protocol (a serial port that went away is handled before this).
check("other protocol", afterExit({ protocol: "serial", code: 1, lines: [], loginAsked: false, loggedIn: true, chain: false }), { verdict: "dropped", chain: true });
// A refused login or a changed host key: never again on its own, chain or not.
check("ssh refused", ssh(255, refused, { chain: true }), { verdict: "failed", failure: "auth", chain: true });
check("ssh host key", ssh(255, hostkey), { verdict: "failed", failure: "hostkey", chain: false });
// Ended after a password question, the login not through: not again.
check("ssh unfinished", ssh(255, out("user@10.0.0.5's password: "), { loginAsked: true, chain: true }), { verdict: "unfinished", chain: true });
// A new tab's first attempt that never logged in: not again, whatever ended it.
check("ssh first timed out", ssh(255, timedOut), { verdict: "unreached", chain: false });
check("ssh first closed", ssh(255, closed), { verdict: "unreached", chain: false });
// Inside a chain: again only while the server was not reached at all.
check("chain timed out", ssh(255, timedOut, { chain: true }), { verdict: "dropped", chain: true });
check("chain no name", ssh(255, noName, { chain: true }), { verdict: "dropped", chain: true });
check("chain closed by server", ssh(255, closed, { chain: true }), { verdict: "unreached", chain: true });
check("chain reset at kex", ssh(255, reset, { chain: true }), { verdict: "unreached", chain: true });
check("chain no output", ssh(255, [], { chain: true }), { verdict: "unreached", chain: true });
// Telnet: reconnects only from the device's own prompt after its login.
check("telnet drop at prompt", telnet(1, out("R1#"), { loggedIn: true }), { verdict: "dropped", chain: true });
check("telnet drop at login", telnet(1, out("Username: "), { loggedIn: false }), { verdict: "unfinished", chain: false });
check("telnet failed", telnet(1, out("Username: admin", "Password: ", "% Login invalid"), { loggedIn: false }), { verdict: "failed", failure: "auth", chain: false });
check("telnet closed cleanly", telnet(0, [], { loggedIn: true }), { verdict: "ended", chain: false });
check("telnet asked again after a failure", telnet(1, out("Password: ", "% Login invalid", "", "Username: "), { loggedIn: false }), { verdict: "unfinished", chain: false });

// ---- what the end of the output says, read by the cases above ----------------

// A refused login, in OpenSSH's words (sshconnect2.c, packet.c) and devices':
// never retried. The words earlier in a session, followed by the shell, are not.
for (const [what, lines, want] of [
  ["publickey refused", out("user@10.0.0.5: Permission denied (publickey)."), "auth"],
  ["password tries used", out("user@10.0.0.5's password: ", "Permission denied, please try again.", "user@10.0.0.5's password: ", "user@10.0.0.5: Permission denied (publickey,password)."), "auth"],
  ["too many keys", out("Received disconnect from 10.0.0.5 port 22:2: Too many authentication failures", "Disconnected from 10.0.0.5 port 22"), "auth"],
  ["host key changed", hostkey, "hostkey"],
  ["unknown host key refused", out("The authenticity of host '10.0.0.5 (10.0.0.5)' can't be established.", "Host key verification failed."), "hostkey"],
  ["telnet login invalid", out("Username: admin", "Password: ", "% Login invalid"), "auth"],
  // Asked again after it: read from the very end only, so not "failed" here;
  // the connection that ends there is "unfinished" (below), never retried.
  ["telnet asked again", out("Username: admin", "Password: ", "% Login invalid", "", "Username: "), null],
  ["words then the shell", out("Permission denied, please try again.", "Last login: Sat Nov 22 09:00:01 2026", "user@web01:~$ "), null],
  ["network failure", timedOut, null],
]) check(`failure ${what}`, loginFailure(lines), want);

// Through: the server spoke after the last question (a banner, a prompt).
for (const [what, lines, want] of [
  ["linux prompt", prompt, true],
  ["bracket prompt", out("[root@db1 ~]# "), true],
  ["device prompt", out("R1#"), true],
  ["windows prompt", out("PS C:\\Users\\admin> "), true],
  ["password asked", out("user@10.0.0.5's password: "), false],
  ["answer echoed", out("Username: admin"), false],
  ["device asks with >", out("Password> "), false],
  ["only ssh's words", out("Warning: Permanently added '10.0.0.5' (ED25519) to the list of known hosts."), false],
]) check(`through ${what}`, loginThrough(lines), want);

// A login question, not a device prompt named like one.
for (const [line, want] of [
  ["login as: ", true],
  ["Username: admin", true],
  ["Password> ", true],
  ["vpn-login# ", false],
  ["R1-PASS> ", false],
]) check(`asks ${JSON.stringify(line)}`, asksLogin(line), want);

// A key ssh.exe could not use, in its words (ssh.c, authfile.c); inside quotes
// OpenSSH for Windows doubles each backslash.
for (const [what, lines, want] of [
  ["missing", out("Warning: Identity file C:\\Users\\me\\.ssh\\work not accessible: No such file or directory."), { path: "C:\\Users\\me\\.ssh\\work", why: "missing" }],
  ["format", out('Load key "C:\\\\Users\\\\me\\\\.ssh\\\\work": invalid format'), { path: "C:\\Users\\me\\.ssh\\work", why: "format" }],
  ["too open", out("Permissions for 'C:\\\\Users\\\\me\\\\.ssh\\\\work' are too open."), { path: "C:\\Users\\me\\.ssh\\work", why: "permissions" }],
  ["bad owner", out('Load key "C:\\\\k": bad permissions'), { path: "C:\\k", why: "permissions" }],
  ["fine", prompt, null],
]) check(`key ${what}`, unusableKey(lines), want);

if (failed) {
  console.error(`${failed} case(s) failed`);
  process.exit(1);
}
console.log("ended connections handled as expected");
