// Check Unix permissions as the file tab and the editor read and change them
// (src/remotePerm.ts): a listing's "-rwsr-xr-x" as a mode, which files are
// scripts, who may be offered "chmod +x", and what it sends.
//
//   node scripts/perm-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { findPerms, lacksExecute, modeOf, octal, permString, SCRIPT_NAME, withExecute } from "../src/remotePerm.ts";

let failed = 0;
const check = (what, got, want) => {
  if (got !== want) {
    failed++;
    console.error("FAIL", JSON.stringify(what), JSON.stringify(got), JSON.stringify(want));
  }
};

// A listing's permission string as a mode, its special bits included.
for (const [perm, want] of [
  ["-rw-r--r--", 0o644],
  ["-rwxr-xr-x", 0o755],
  ["drwxr-xr-x", 0o755],
  ["lrwxrwxrwx", 0o777],
  ["-rwsr-xr-x", 0o4755],
  ["-rwSr--r--", 0o4644],
  ["-rwxr-sr-x", 0o2755],
  ["drwxrwxrwt", 0o1777],
  ["drwxrwxrwT", 0o1776],
  ["----------", 0],
  ["rw-r--r--", null],
  ["-rw-r--r--+", null],
  ["-rw-r--r--.", null],
  ["", null],
  [null, null],
  [undefined, null],
]) check(`modeOf ${perm}`, modeOf(perm), want);

// Offered only where its owner may read it and not run it.
for (const [mode, want] of [[0o644, true], [0o600, true], [0o4644, true], [0o755, false], [0o700, false], [0o244, false], [0o044, false], [0o000, false]]) {
  check(`lacksExecute ${mode.toString(8)}`, lacksExecute(mode), want);
}

// What "chmod +x" sends: execute where read is, three digits.
for (const [mode, want] of [[0o644, "755"], [0o600, "700"], [0o640, "750"], [0o604, "705"], [0o4644, "755"], [0o664, "775"], [0o400, "500"]]) {
  check(`withExecute ${mode.toString(8)}`, withExecute(mode), want);
}

// The mode as chmod takes it: four digits only with a special bit.
for (const [mode, want] of [[0o644, "644"], [0o755, "755"], [0o4755, "4755"], [0o1777, "1777"], [0o2750, "2750"], [0o7, "007"], [0, "000"]]) {
  check(`octal ${mode.toString(8)}`, octal(mode), want);
}

// Permission strings in "ls -l" lines: where they are and what they mean.
for (const [line, want] of [
  ["-rwxr-xr-x 1 root root 1234 Jan  1 12:00 run.sh", [[0, "-rwxr-xr-x", 0o755]]],
  ["drwxrwxrwt. 10 root root 4096 Nov 21 09:00 tmp", [[0, "drwxrwxrwt", 0o1777]]],
  ["-rw-r--r--+ 1 a b 0 Nov 21 09:00 acl", [[0, "-rw-r--r--", 0o644]]],
  ["-rw-r--r--@ 1 a staff 0 Nov 21 09:00 mac", [[0, "-rw-r--r--", 0o644]]],
  ["1234567 -rwsr-xr-x 1 root root 0 Nov 21 09:00 su", [[8, "-rwsr-xr-x", 0o4755]]],
  ["crw-rw-rw- 1 root root 1, 3 Nov 21 09:00 null", [[0, "crw-rw-rw-", 0o666]]],
  ["lrwxrwxrwx 1 root root 7 Nov 21 09:00 bin -> usr/bin", [[0, "lrwxrwxrwx", 0o777]]],
  ["\u001b-rw-r--r--x 1", []],
  ["x-rw-r--r-- 1", []],
  ["-rw-r--r--x 1", []],
  ["mode=-rw-r--r-- 1", []],
  ["total 12", []],
  ["---------- ---------- ------", []],
  ["Interface  ---------- x", []],
  ["d--------- 2 root root 4096 Nov 21 09:00 locked", [[0, "d---------", 0]]],
  ["", []],
]) {
  const got = findPerms(line).map((m) => [m.index, m.perm, m.mode]);
  check(`findPerms ${line}`, JSON.stringify(got), JSON.stringify(want));
}

// Script names (case aside), not their look-alikes.
for (const [name, want] of [
  ["install.sh", true], ["RUN.SH", true], ["a.bash", true], ["b.ksh", true], ["c.zsh", true], ["d.csh", true], ["e.pl", true], ["f.py", true], ["g.awk", true],
  ["sh", false], ["notes.shx", false], ["config.yml", false], ["a.sh.bak", false], ["x.pyc", false], ["Makefile", false],
]) check(`script ${name}`, SCRIPT_NAME.test(name), want);

// A mode written as "ls -l" does: s/S for setuid and setgid, t/T for sticky.
for (const [mode, want] of [
  [0o755, "rwxr-xr-x"],
  [0o644, "rw-r--r--"],
  [0o600, "rw-------"],
  [0o4755, "rwsr-xr-x"],
  [0o4644, "rwSr--r--"],
  [0o2755, "rwxr-sr-x"],
  [0o2745, "rwxr-Sr-x"],
  [0o1777, "rwxrwxrwt"],
  [0o1776, "rwxrwxrwT"],
  [0o7777, "rwsrwsrwt"],
  [0, "---------"],
]) check(`permString ${mode.toString(8)}`, permString(mode), want);
// The inverse of modeOf for every mode.
for (let mode = 0; mode <= 0o7777; mode++) {
  if (modeOf(`-${permString(mode)}`) !== mode) {
    check(`permString round trip ${mode.toString(8)}`, modeOf(`-${permString(mode)}`), mode);
    break;
  }
}

console.log(failed ? `${failed} problem(s)` : "permissions read and changed as expected");
process.exit(failed ? 1 : 0);
