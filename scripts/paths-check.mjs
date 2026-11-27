// Check which absolute server paths the terminal links (src/serverPaths.ts):
// paths in error messages, grep and ls output; not words with a slash,
// interface names, prefixes, URLs or home-relative paths.
//
//   node scripts/paths-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { findPaths } from "../src/serverPaths.ts";
import { QUOTE_UNSAFE, shellQuote } from "../src/shellQuote.ts";
import { grepCommand, grepRefused, grepUnsupported } from "../src/grepCommand.ts";
import { archiveCommands } from "../src/archiveCommands.ts";

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

// How a path goes on a shell command line (src/shellQuote.ts), including the
// ones run as root (sudo cp, systemctl): read back as POSIX sh reads '…' and
// '\'' (nothing inside single quotes is special), the path must come back
// whole, and nothing outside the quotes may remain.
const unquote = (s) => {
  let out = "";
  for (let i = 0; i < s.length; ) {
    if (s[i] === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      out += s.slice(i + 1, end);
      i = end + 1;
    } else if (s.startsWith("\\'", i)) {
      out += "'";
      i += 2;
    } else return null; // a character the shell would read itself
  }
  return out;
};
for (const p of ["/etc/app.conf", "/srv/a b/c", "/tmp/it's", "/x/$(rm -rf ~)", "/x/`id`", "/x;reboot", "/x/'", "''", "/x/&&/y", "/home/사용자/메모.txt", "-.mount"]) {
  check(`quote ${p}`, unquote(shellQuote(p)), p);
}
// Kept out: what '…' does not keep whole in every shell (fish's \', tcsh's !).
for (const [p, want] of [
  ["/etc/systemd/system/media-usb\\x2ddrive.mount", true],
  ["/x/a!b", true],
  ["/srv/a b/it's", false],
  ["getty@tty1.service", false],
]) check(`unsafe ${p}`, QUOTE_UNSAFE(p), want);

// The grep for "find text" (src/grepCommand.ts): the typed text comes back
// whole from its quoting, the path goes only where "{}" is, and what cannot
// be quoted safely is refused.
for (const [text, i] of [["Failed password", true], ["it's $(id)", false], ["-v", false], ["a;b|c", true]]) {
  const cmd = grepCommand(text, i);
  check(`grep flags ${text}`, cmd.startsWith(i ? "grep -rnIFi -- " : "grep -rnIF -- "), true);
  check(`grep ends with path slot ${text}`, cmd.endsWith(" {}") && cmd.indexOf("{}") === cmd.length - 2, true);
  check(`grep text ${text}`, unquote(cmd.slice(cmd.indexOf("-- ") + 3, -3)), text);
}
for (const [text, ok] of [["normal text", true], ["tab\there", false], ["a\\b", false], ["wow!", false], ["x{}y", false], ["{ }", true]]) {
  check(`grep refused ${JSON.stringify(text)}`, grepRefused(text) === null, ok);
}
check("grep unsupported", ["aix", "hpux", "solaris", "linux", undefined].map(grepUnsupported).join(), "true,true,true,false,false");

// An archive's listing and its unpacking beside it: tar for tarballs (never
// replacing a file already there, -k), unzip for zip; nothing for other names.
for (const [path, list, extract] of [
  ["/opt/app/release-1.2.tar.gz", "tar -tvf {}", "tar -xkf {} -C '/opt/app'"],
  ["/srv/x.TGZ", "tar -tvf {}", "tar -xkf {} -C '/srv'"],
  ["/srv/b.tar.bz2", "tar -tvf {}", "tar -xkf {} -C '/srv'"],
  ["/srv/b.tbz", "tar -tvf {}", "tar -xkf {} -C '/srv'"],
  ["/srv/c.tar.xz", "tar -tvf {}", "tar -xkf {} -C '/srv'"],
  ["/srv/d.tar", "tar -tvf {}", "tar -xkf {} -C '/srv'"],
  ["/x.tar", "tar -tvf {}", "tar -xkf {} -C '/'"],
  ["/home/kim's/a b.zip", "unzip -l {}", "unzip {} -d '/home/kim'\\''s'"],
]) {
  const c = archiveCommands(path);
  check(`archive list ${path}`, c?.list, list);
  check(`archive extract ${path}`, c?.extract, extract);
}
for (const path of ["/srv/a.gz", "/srv/a.tar.zst", "/srv/notes.txt", "/srv/tar", "a.zip", "/srv/.tar.gz.bak", "/srv/"]) check(`no archive ${path}`, archiveCommands(path), null);
// unzip reads its archive name as a pattern: a name with *, ? or [ could name another archive.
for (const path of ["/srv/photos [2024].zip", "/srv/a*.zip", "/srv/b?.zip", "/srv/x[1]/c.zip"]) check(`no unzip for ${path}`, archiveCommands(path), null);
check("tar with brackets", archiveCommands("/srv/photos [2024].tar.gz")?.tool, "tar");
// The tar of AIX, HP-UX and Solaris may lack -k, -C on extract and compression reading.
for (const kind of ["aix", "hpux", "solaris"]) check(`no tar on ${kind}`, archiveCommands("/srv/a.tar.gz", kind), null);
check("zip on aix", archiveCommands("/srv/a.zip", "aix")?.tool, "unzip");
check("tar on linux", archiveCommands("/srv/a.tar.gz", "linux")?.tool, "tar");

console.log(failed ? `${failed} problem(s)` : "server paths found as expected");
process.exit(failed ? 1 : 0);
