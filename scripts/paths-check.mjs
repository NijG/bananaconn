// Check which absolute server paths the terminal links (src/serverPaths.ts):
// paths in error messages, grep and ls output; not words with a slash,
// interface names, prefixes, URLs or home-relative paths.
//
//   node scripts/paths-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { findPaths } from "../src/serverPaths.ts";

let failed = 0;
const check = (what, got, want) => {
  if (got !== want) {
    failed++;
    console.error("FAIL", JSON.stringify(what), JSON.stringify(got), JSON.stringify(want));
  }
};

for (const [line, want] of [
  ["cat: /var/log/app.log: Permission denied", ["/var/log/app.log"]],
  ["/etc/nginx/nginx.conf:12:    listen 80;", ["/etc/nginx/nginx.conf"]],
  ["lrwxrwxrwx 1 root root 7 Nov 21 09:00 bin -> /usr/bin", ["/usr/bin"]],
  ["Config is in /etc/app/. Edit it.", ["/etc/app"]],
  ["see /srv//data/ and /opt/x-1.2_b+c@d~", ["/srv/data", "/opt/x-1.2_b+c@d~"]],
  ["'/home/u/a.txt' \"/tmp/b\" (/run/c) [/dev/sda1]", ["/home/u/a.txt", "/tmp/b", "/run/c", "/dev/sda1"]],
  // Any script's letters: one path, not two from its ASCII parts.
  ["cat /home/사용자/notes.txt", ["/home/사용자/notes.txt"]],
  ["설정은/etc/x 에", []],
  ["/srv/données/é.txt", ["/srv/données/é.txt"]],
  // "." and "..": the folder itself at the end; ".." anywhere is no path.
  ["ls /etc/app/.", ["/etc/app"]],
  ["cd /etc/..", []],
  ["/a/../b and /a/./b", []],
  ["/", []],
  ["ls /", []],
  ["and/or Gi1/0/1 10.0.0.0/24 1/2", []],
  ["http://host/path https://h.example/x/y", []],
  ["~/notes.txt $HOME/x C:/Windows a\\/b", []],
  ["user@host:/var/www$ ", []],
  ["Mon 2026/11/21", []],
  ["", []],
]) {
  check(line, JSON.stringify(findPaths(line).map((m) => m.path)), JSON.stringify(want));
}

// A line number after the path (grep -n, compilers), and what is not one.
for (const [line, want] of [
  ["/etc/nginx/nginx.conf:12:    listen 80;", [["/etc/nginx/nginx.conf", 12, "/etc/nginx/nginx.conf:12"]]],
  ["/src/main.c:7:5: error: x", [["/src/main.c", 7, "/src/main.c:7"]]],
  ["see /var/log/x.log:3", [["/var/log/x.log", 3, "/var/log/x.log:3"]]],
  ["/etc/hosts: No such file", [["/etc/hosts", undefined, "/etc/hosts"]]],
  ["/etc/hosts:0:", [["/etc/hosts", undefined, "/etc/hosts"]]],
  ["/etc/hosts:12abc", [["/etc/hosts", undefined, "/etc/hosts"]]],
  ["/srv/a/:12:", [["/srv/a", undefined, "/srv/a"]]],
  // Check tools' own forms: sshd -t (OpenSSH servconf.c "%s line %d:",
  // "%s: line %d:"), bash -n ("%s: line %d:"), a Python traceback.
  ["/etc/ssh/sshd_config line 12: missing argument.", [["/etc/ssh/sshd_config", 12, "/etc/ssh/sshd_config line 12"]]],
  ["/etc/ssh/sshd_config: line 7: Bad configuration option: Foo", [["/etc/ssh/sshd_config", 7, "/etc/ssh/sshd_config: line 7"]]],
  ["/opt/run.sh: line 3: syntax error near unexpected token `fi'", [["/opt/run.sh", 3, "/opt/run.sh: line 3"]]],
  ['  File "/srv/app/main.py", line 41', [["/srv/app/main.py", 41, '/srv/app/main.py", line 41']]],
  ['  File "/srv/app/main.py", line 41, in <module>', [["/srv/app/main.py", 41, '/srv/app/main.py", line 41']]],
  // Not a line number of the path: words between, no colon after, no digits.
  ["/etc/hosts has line 3: x", [["/etc/hosts", undefined, "/etc/hosts"]]],
  ["/etc/hosts line 3 is long", [["/etc/hosts", undefined, "/etc/hosts"]]],
  ["/etc/hosts: line x:", [["/etc/hosts", undefined, "/etc/hosts"]]],
]) {
  const got = findPaths(line).map((m) => [m.path, m.line, line.slice(m.index, m.index + m.length)]);
  check(`line ${line}`, JSON.stringify(got), JSON.stringify(want));
}

// A long line with no end to a path is read at once (no backtracking).
const started = Date.now();
findPaths("/" + "a/".repeat(50_000) + "!" + " /x".repeat(50_000));
check("long line in time", Date.now() - started < 500, true);

// Where each is in the line: the link covers the path, not what follows it.
const line = "cat: /var/log/app.log: x";
const [m] = findPaths(line);
check("place", line.slice(m.index, m.index + m.length), "/var/log/app.log");

console.log(failed ? `${failed} problem(s)` : "server paths found as expected");
process.exit(failed ? 1 : 0);
