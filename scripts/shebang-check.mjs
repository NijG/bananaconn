// Check how the editor reads a script's "#!" line (src/shebang.ts) to colour
// files with no telling name.
//
//   node scripts/shebang-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { installFor, interpreterOf, languageOfInterpreter, syntaxCheckFor, unitFileOf, unitReloadFor } from "../src/shebang.ts";

let failed = 0;
const check = (what, got, want) => {
  if (got !== want) {
    failed++;
    console.error("FAIL", JSON.stringify(what), JSON.stringify(got), JSON.stringify(want));
  }
};

for (const [line, program, language] of [
  ["#!/bin/sh", "sh", "shell"],
  ["#!/bin/bash -e", "bash", "shell"],
  ["#! /bin/ksh93", "ksh93", "shell"],
  ["#!/usr/bin/env bash", "bash", "shell"],
  ["#!/usr/bin/env python3", "python3", "python"],
  ["#!/usr/bin/python3.11", "python3.11", "python"],
  ["#!/usr/bin/env -S python3 -u", "python3", "python"],
  ["#!/usr/bin/env -i PATH=/bin perl -w", "perl", "perl"],
  ["#!/usr/bin/env -u LANG ruby", "ruby", "ruby"],
  ["#!/usr/bin/env node", "node", "javascript"],
  ["#!/usr/bin/lua5.4", "lua5.4", "lua"],
  ["#!/usr/bin/Rscript", "Rscript", "r"],
  ["#!/usr/bin/env pwsh", "pwsh", "powershell"],
  ["#!/bin/bash\r", "bash", "shell"],
  // env options with a value, and -S holding the program.
  ["#!/usr/bin/env -C /tmp python3", "python3", "python"],
  ["#!/usr/bin/env --chdir /srv -P /usr/bin perl", "perl", "perl"],
  ["#!/usr/bin/env -S 'python3 -u'", "python3", "python"],
  ["#!/usr/bin/env -Spython3 -u", "python3", "python"],
  ["#!/usr/bin/env --split-string=bash -e", "bash", "shell"],
  ["#!/usr/bin/env -S \"node --max-old-space-size=512\"", "node", "javascript"],
  ["#!/usr/bin/awk -f", "awk", null],
  ["#!/usr/bin/env", null, null],
  ["# comment", null, null],
  ["", null, null],
  ["echo #!/bin/sh", null, null],
]) {
  const p = interpreterOf(line);
  check(`interpreter ${line}`, p, program);
  check(`language ${line}`, p ? languageOfInterpreter(p) : null, language);
}

// The check run without executing the file, and when there is none.
for (const [name, path, first, want] of [
  ["deploy.sh", "/srv/deploy.sh", "#!/bin/bash", "env BASH_ENV= bash -n {}"],
  ["run", "/usr/local/bin/run", "#!/usr/bin/env dash", "dash -n {}"],
  ["k", "/srv/k", "#!/bin/ksh93", "ksh93 -n {}"],
  ["old.sh", "/srv/old.sh", "echo hi", "sh -n {}"],
  ["x.bash", "/srv/x.bash", "", "env BASH_ENV= bash -n {}"],
  ["tool.py", "/srv/tool.py", "import os", "python3 -I -S -c 'import sys;compile(open(sys.argv[1],\"rb\").read(),sys.argv[1],\"exec\")' {}"],
  ["tool", "/srv/tool", "#!/usr/bin/env python3.11", "python3.11 -I -S -c 'import sys;compile(open(sys.argv[1],\"rb\").read(),sys.argv[1],\"exec\")' {}"],
  // Nothing that runs code to check, or no check at all: zsh (/etc/zshenv),
  // Perl (-c runs BEGIN), Python 2 or an unversioned "python".
  ["z", "/srv/z", "#!/bin/zsh", null],
  ["a.pl", "/srv/a.pl", "use strict;", null],
  ["p", "/srv/p", "#!/usr/bin/perl", null],
  ["old.py", "/srv/old.py", "#!/usr/bin/python2", null],
  ["any.py", "/srv/any.py", "#!/usr/bin/python", null],
  ["sshd_config", "/etc/ssh/sshd_config", "# comment", "sudo sshd -t -f {}"],
  ["sudoers", "/etc/sudoers", "Defaults env_reset", "sudo visudo -c -f {}"],
  ["fstab", "/etc/fstab", "# /etc/fstab", "findmnt --verify --tab-file {}"],
  // Apache (Debian's apache2ctl, RHEL's apachectl), HAProxy, BIND.
  ["000-default.conf", "/etc/apache2/sites-available/000-default.conf", "<VirtualHost *:80>", "sudo apache2ctl configtest"],
  ["httpd.conf", "/etc/httpd/conf/httpd.conf", "ServerRoot", "sudo apachectl configtest"],
  ["ssl.conf", "/etc/httpd/conf.d/ssl.conf", "Listen 443", "sudo apachectl configtest"],
  ["envvars", "/etc/apache2/envvars", "", null],
  ["haproxy.cfg", "/etc/haproxy/haproxy.cfg", "global", "sudo haproxy -c -V -f {}"],
  ["errors.http", "/etc/haproxy/errors/503.http", "", null],
  ["named.conf", "/etc/named.conf", "options {", "sudo named-checkconf {}"],
  ["named.conf.options", "/etc/bind/named.conf.options", "options {", "sudo named-checkconf"],
  ["named.conf", "/etc/bind/named.conf", "include", "sudo named-checkconf"],
  ["web.cfg", "/etc/haproxy/web.cfg", "backend web", "sudo haproxy -c -V -f {}"],
  ["db.local", "/etc/bind/db.local", "$TTL", null],
  ["smb.conf", "/etc/samba/smb.conf", "[global]", "testparm -s {}"],
  ["smb.conf", "/home/u/smb.conf", "[global]", null],
  ["lmhosts", "/etc/samba/lmhosts", "", null],
  ["app.service", "/etc/systemd/system/app.service", "[Unit]", "systemd-analyze verify {}"],
  ["backup.timer", "/usr/lib/systemd/system/backup.timer", "[Unit]", "systemd-analyze verify {}"],
  ["sync.service", "/home/u/.config/systemd/user/sync.service", "[Unit]", "systemd-analyze --user verify {}"],
  ["x.service", "/etc/systemd/user/x.service", "[Unit]", "systemd-analyze --user verify {}"],
  // A copy outside the unit folders (a source tree, a backup) is not checked.
  ["app.service", "/home/me/src/app/systemd/system/app.service", "[Unit]", null],
  ["x.service", "/srv/backup/etc/systemd/system/x.service", "[Unit]", null],
  ["bar.service", "/etc/systemd/system/foo.service.wants/bar.service", "[Unit]", null],
  // A drop-in is no unit of its own; a unit file elsewhere is not judged.
  ["override.conf", "/etc/systemd/system/app.service.d/override.conf", "[Service]", null],
  ["app.service", "/srv/app.service", "[Unit]", null],
  ["fstab", "/home/u/fstab", "", null],
  ["fstab.bak", "/etc/fstab.bak", "", null],
  ["deploy", "/etc/sudoers.d/deploy", "deploy ALL=(ALL) NOPASSWD: /bin/systemctl", "sudo visudo -c -f {}"],
  ["sudoers", "/home/u/sudoers", "", null],
  ["x", "/etc/sudoers.d/sub/x", "", null],
  ["default", "/etc/nginx/sites-available/default", "server {", "sudo nginx -t"],
  ["nginx.conf", "/etc/nginx/nginx.conf", "user www-data;", "sudo nginx -t"],
  ["notes", "/home/u/nginx/notes", "", null],
  ["mime.types", "/etc/nginx/mime.types", "types {", null],
  ["config.yml", "/srv/config.yml", "a: 1", null],
  ["notes.txt", "/srv/notes.txt", "", null],
  ["awk.sh", "/srv/awk.sh", "#!/usr/bin/awk -f", null],
]) {
  const c = syntaxCheckFor(name, path, first);
  check(`check ${path}`, c ? `${c.sudo ? "sudo " : ""}${c.command}` : null, want);
}

// A service's reload offered after a passing check: only where its unit's
// name is certain (none for sshd/ssh or named/bind9).
for (const [path, want] of [
  ["/etc/nginx/nginx.conf", "systemctl reload nginx"],
  ["/etc/apache2/apache2.conf", "systemctl reload apache2"],
  ["/etc/httpd/conf/httpd.conf", "systemctl reload httpd"],
  ["/etc/haproxy/haproxy.cfg", "systemctl reload haproxy"],
  ["/etc/haproxy/web.cfg", undefined],
  ["/etc/ssh/sshd_config", undefined],
  ["/etc/named.conf", undefined],
  ["/etc/samba/smb.conf", undefined],
  ["/etc/sudoers", undefined],
]) check(`reload of ${path}`, syntaxCheckFor(path.split("/").pop(), path, "")?.reload, want);

// A unit file saved: the reload systemd needs (system or user manager).
for (const [path, want] of [
  ["/etc/systemd/system/app.service", "system"],
  ["/etc/systemd/system/backup.timer", "system"],
  ["/etc/systemd/system/nginx.service.d/override.conf", "system"],
  ["/usr/lib/systemd/system/sshd.service", "system"],
  ["/lib/systemd/system/getty@.service", "system"],
  ["/run/systemd/system/x.mount", "system"],
  ["/usr/local/lib/systemd/system/x.socket", "system"],
  ["/home/u/.config/systemd/user/sync.service", "user"],
  ["/home/u/.config/systemd/user/sync.service.d/env.conf", "user"],
  ["/etc/systemd/system/multi-user.target.wants/app.service", null],
  ["/etc/systemd/system.conf", null],
  ["/etc/systemd/journald.conf", null],
  ["/etc/systemd/system/app.service.d/notes.txt", null],
  ["/srv/app.service", null],
  ["/etc/systemd/system/app.service.bak", null],
  // A whole type's drop-ins; a scope has no unit file, only drop-ins.
  ["/etc/systemd/system/service.d/10-limits.conf", "system"],
  ["/etc/systemd/system/x.scope", null],
  ["/etc/systemd/system/x.scope.d/limits.conf", "system"],
  ["/etc/systemd/system/mnt-data\\x2dbackup.mount", "system"],
  // "--user" reaches the login's own manager: not another user's home.
  ["/home/bob/.config/systemd/user/sync.service", null],
  ["/tmp/x/.config/systemd/user/a.service", null],
  ["/home/u/.config/systemd/user/timer.d/x.conf", "user"],
]) {
  const r = unitReloadFor(path, "/home/u");
  check(`reload ${path}`, r ? (r.system ? "system" : "user") : null, want);
}

// A unit file's unit (the terminal's "systemctl status"): not a drop-in or a
// copy elsewhere.
for (const [path, want] of [
  ["/etc/systemd/system/app.service", "app.service"],
  ["/lib/systemd/system/-.mount", "-.mount"],
  ["/home/u/.config/systemd/user/sync.service", "user sync.service"],
  ["/etc/systemd/user/x.timer", "user x.timer"],
  ["/etc/systemd/system/app.service.d/override.conf", null],
  ["/srv/app.service", null],
  ["/etc/systemd/system/multi-user.target.wants/app.service", null],
]) {
  const u = unitFileOf(path);
  check(`unit ${path}`, u ? `${u.user ? "user " : ""}${u.name}` : null, want);
}

// A sudo save of the sudoers policy: one root shell that checks the copy,
// puts it in with a backup, checks the whole policy and puts the backup back
// if that fails; the copy is checked alone only when its includes are
// absolute (relative ones would be looked for beside the copy).
{
  const q = (s) => `'${s}'`;
  const line = (path, text) => installFor(path, text)?.(q("/home/u/.copy"), q(path)) ?? null;
  const main = line("/etc/sudoers", "Defaults env_reset\n@includedir /etc/sudoers.d\n");
  check("install main", main, `sudo sh -c '[ -f "$2" ] && visudo -c -f "$1" && b="$2.bak.$$" && cp -p -- "$2" "$b" && cp -- "$1" "$2" && if visudo -c; then rm -f -- "$b"; else cp -p -- "$b" "$2"; rm -f -- "$b"; exit 1; fi' sh '/home/u/.copy' '/etc/sudoers' && rm -f -- '/home/u/.copy'`);
  const frag = line("/etc/sudoers.d/deploy", "deploy ALL=(ALL) /bin/true\n");
  check("install fragment checks alone and whole", !!frag && frag.includes('visudo -c -f "$1"') && frag.includes("if visudo -c;"), true);
  for (const text of ["@include sudoers.local\n", "#includedir sudoers.d\n", '  @include "local file"\n'])
    check(`install relative ${JSON.stringify(text)}`, line("/etc/sudoers", text)?.includes('visudo -c -f "$1"'), false);
  for (const text of ["@include /etc/sudoers.local\n", '#includedir "/etc/sudoers.d"\n', "# include sudoers.local\n"])
    check(`install absolute ${JSON.stringify(text)}`, line("/etc/sudoers", text)?.includes('visudo -c -f "$1"'), true);
  check("install other", line("/etc/ssh/sshd_config", ""), null);
  check("install dist", line("/etc/sudoers.dist", ""), null);
}

console.log(failed ? `${failed} problem(s)` : "#! lines read as expected");
process.exit(failed ? 1 : 0);
