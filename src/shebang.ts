// The program a script's "#!" line names, for the editor to colour a file
// with no telling name ("/etc/init.d/app", "/usr/local/bin/backup"). Pure.

/** The interpreter's name from a first line: "#!/bin/bash" is "bash",
 * "#!/usr/bin/env python3" and "#!/usr/bin/env -S python3 -u" are
 * "python3"; null when the line is no "#!" line. */
export function interpreterOf(firstLine: string): string | null {
  const m = /^#!\s*(\S+)(.*)$/.exec(firstLine.replace(/\r$/, ""));
  if (!m) return null;
  const program = m[1].slice(m[1].lastIndexOf("/") + 1);
  if (program !== "env") return program || null;
  // env's own options and VAR=value come first: "-u NAME", "-C DIR" and
  // "-P PATH" take the next word; "-S" (split) may hold the program itself
  // ("-Spython3 -u", "--split-string=python3 -u"), quoted or not.
  const words = m[2].trim().split(/\s+/).filter(Boolean);
  const name = (w: string) => {
    const bare = w.replace(/^['"]+|['"]+$/g, "");
    return bare.slice(bare.lastIndexOf("/") + 1) || null;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^(?:-u|--unset|-C|--chdir|-P)$/.test(w)) i++;
    else if (w.startsWith("--split-string=")) return name(w.slice("--split-string=".length));
    else if (/^-S./.test(w)) return name(w.slice(2));
    else if (w.startsWith("-") || /^\w+=/.test(w)) continue;
    else return name(w);
  }
  return null;
}

/** How a file on the server is checked without running any of it, by the
 * tools' own documented flags. `{}` stands for the file's quoted path;
 * `whole`: the check reads the whole configuration (nginx), not the file
 * alone. Null when there is no check that runs nothing:
 * - a shell's "-n" (read, don't execute); bash with BASH_ENV emptied, which
 *   a non-interactive bash would otherwise source; not zsh, which always
 *   sources /etc/zshenv first;
 * - Python 3 compiling the text in isolated mode (-I: no current folder or
 *   PYTHON* variables on its path; -S: no site), importing nothing and
 *   writing no __pycache__ (py_compile would do both);
 * - not Perl: "perl -c" runs BEGIN blocks and "use";
 * - "sshd -t -f FILE"; "visudo -c -f FILE" for sudoers (SUDOERS); "nginx
 *   -t" for files under /etc/nginx (it tests the configuration that
 *   includes them);
 * - /etc/fstab: "findmnt --verify --tab-file FILE" (findmnt(8), util-linux:
 *   parsability and usability; read by anyone). Its exit status on a
 *   finding is not documented, so it is shown to read, never gated on.
 * `system`: a configuration a system service or the boot reads, whose check
 * is offered once it is saved (a mistake there stops sshd, sudo or booting). */
export function syntaxCheckFor(name: string, path: string, firstLine: string): { command: string; sudo: boolean; whole?: string; system?: boolean; reload?: string } | null {
  if (name === "sshd_config") return { command: "sshd -t -f {}", sudo: true, system: true };
  if (SUDOERS.test(path)) return { command: SUDOERS_CHECK, sudo: true, system: true };
  if (path === "/etc/fstab") return { command: "findmnt --verify --tab-file {}", sudo: false, system: true };
  // A systemd unit file (not a drop-in: verify loads units): systemd-analyze(1)
  // "verify" loads it and prints what it finds wrong (unknown sections and
  // directives, missing dependencies, ExecStart= commands missing or not
  // executable); its exit status says nothing of warnings, so it is read.
  // A user unit's dependencies (default.target and the like) are the user manager's.
  const unit = unitFileOf(path);
  if (unit) return { command: unit.user ? "systemd-analyze --user verify {}" : "systemd-analyze verify {}", sudo: false, system: true };
  const program = interpreterOf(firstLine);
  if (program === "bash") return { command: "env BASH_ENV= bash -n {}", sudo: false };
  if (program && /^(?:sh|dash|ksh\d*|mksh)$/.test(program)) return { command: `${program} -n {}`, sudo: false };
  const python = program && /^python3[\d.]*$/.test(program) ? program : !program && /\.py$/i.test(name) ? "python3" : null;
  if (python) return { command: `${python} -I -S -c 'import sys;compile(open(sys.argv[1],"rb").read(),sys.argv[1],"exec")' {}`, sudo: false };
  if (!program && /\.sh$/i.test(name)) return { command: "sh -n {}", sudo: false };
  if (!program && /\.bash$/i.test(name)) return { command: "env BASH_ENV= bash -n {}", sudo: false };
  // `reload`: the service's own reload (systemd unit named as the packages
  // name it), offered after a passing check; none where distributions name
  // it differently (sshd/ssh, named/bind9) or a mistake locks the user out.
  if (/^\/etc\/nginx\//.test(path) && (/\.conf$/i.test(name) || !name.includes(".")))
    return { command: "nginx -t", sudo: true, whole: "nginx", system: true, reload: "systemctl reload nginx" };
  // Apache httpd: "apachectl configtest" runs a syntax test of the whole
  // configuration (Debian's wrapper is apache2ctl, its files /etc/apache2,
  // its unit apache2; RHEL's files /etc/httpd, its unit httpd).
  if (/^\/etc\/apache2\/.+\.conf$/i.test(path)) return { command: "apache2ctl configtest", sudo: true, whole: "Apache", system: true, reload: "systemctl reload apache2" };
  if (/^\/etc\/httpd\/.+\.conf$/i.test(path)) return { command: "apachectl configtest", sudo: true, whole: "Apache", system: true, reload: "systemctl reload httpd" };
  // HAProxy (its management guide): "-c" only checks the configuration and
  // exits before binding, silent on success unless "-V" ("Configuration file
  // is valid"), so a pass is seen too.
  // The reload only after the main file's check: another .cfg (conf.d) is
  // checked alone, while a reload reads the service's whole configuration.
  if (/^\/etc\/haproxy\/[^/]+\.cfg$/i.test(path))
    return { command: "haproxy -c -V -f {}", sudo: true, system: true, ...(path === "/etc/haproxy/haproxy.cfg" ? { reload: "systemctl reload haproxy" } : {}) };
  // BIND: named-checkconf reads named.conf and the files it includes. Debian's
  // pieces (named.conf.options, .local) are checked through the main file
  // (its default), as one alone may name an ACL or key defined in another.
  if (path === "/etc/named.conf") return { command: "named-checkconf {}", sudo: true, system: true };
  if (/^\/etc\/bind\/named\.conf[^/]*$/.test(path)) return { command: "named-checkconf", sudo: true, whole: "BIND", system: true };
  // Samba: testparm(1) loads the named smb.conf and reports what it cannot
  // parse (exit 1 on an error); "-s" leaves out its "press enter" prompt
  // before the dump. No reload: the unit is smbd on Debian, smb on RHEL.
  if (path === "/etc/samba/smb.conf") return { command: "testparm -s {}", sudo: false, system: true };
  return null;
}

/** The sudoers policy: /etc/sudoers and its /etc/sudoers.d fragments. A
 * broken one leaves sudo refusing every command, so it is checked before it
 * is put in place: "visudo -c -f FILE" checks a file's syntax without its
 * owner and mode (visudo(8): those only when no file is named), exit 0 when
 * it parses. A fragment checked alone may name aliases defined elsewhere:
 * not strict (-s), so those are warnings, not failures. */
const SUDOERS = /^\/etc\/sudoers(?:\.d\/[^/]+)?$/;
const SUDOERS_CHECK = "visudo -c -f {}";
/** An include named relative to the file ("@include sudoers.local",
 * "#includedir sudoers.d"): sudoers(5) looks for it beside the including
 * file, so a copy elsewhere would be checked against other files. */
const RELATIVE_INCLUDE = /^[ \t]*[@#]include(?:dir)?[ \t]+(?!"?\/)/m;

/** How a sudo save puts `path` in place when plain "sudo cp" is not safe
 * enough, as one command run as root ("sudo sh -c '…' sh COPY FILE", the
 * paths given already quoted): null for any other file. For sudoers the copy
 * is checked alone first (not when it names relative includes, which would
 * be looked for beside the copy), then put in with a backup beside it, and
 * the whole policy checked ("visudo -c": a fragment can pass alone and still
 * clash with the rest, an alias defined twice). If that fails the backup is
 * put back in the same root shell, as sudo may refuse once the policy is
 * broken. The backup's name holds a ".", which @includedir skips. The copy
 * is removed only once the file is in; on any failure it stays (and the
 * file is as it was). */
export function installFor(path: string, text: string): ((copy: string, file: string) => string) | null {
  if (!SUDOERS.test(path)) return null;
  const pre = RELATIVE_INCLUDE.test(text) ? "" : `visudo -c -f "$1" && `;
  const script = `[ -f "$2" ] && ${pre}b="$2.bak.$$" && cp -p -- "$2" "$b" && cp -- "$1" "$2" && if visudo -c; then rm -f -- "$b"; else cp -p -- "$b" "$2"; rm -f -- "$b"; exit 1; fi`;
  return (copy, file) => `sudo sh -c '${script}' sh ${copy} ${file} && rm -f -- ${copy}`;
}

/** A systemd unit file or a unit's drop-in (systemd.unit(5): its unit types
 * and load paths), changed on disk: systemd reads it again only after
 * "systemctl daemon-reload". The system manager's (root's to reload), or the
 * user manager's in the login's own ~/.config/systemd/user ("--user" reaches
 * only the caller's manager: another user's home is left alone). A drop-in is
 * a unit's ("app.service.d/x.conf") or a whole type's ("service.d/x.conf");
 * scopes have no unit files (systemd.scope(5)), only drop-ins. */
const TYPES = "service|socket|device|mount|automount|swap|target|path|timer|slice";
/** A unit file itself (not one of its drop-ins) in a folder the system
 * manager loads units from, or a user manager's (~/.config/systemd/user,
 * /etc/systemd/user): not a copy elsewhere (a source tree, a backup). */
const UNIT_FILE_NAME = new RegExp(String.raw`^/(?:etc|run|lib|usr/lib|usr/local/lib)/systemd/system/[^/]+\.(?:${TYPES})$`);
const USER_UNIT_FILE_NAME = new RegExp(String.raw`(?:/\.config/systemd/user|^/etc/systemd/user)/[^/]+\.(?:${TYPES})$`);
/** A unit file itself (UNIT_FILE_NAME, USER_UNIT_FILE_NAME): its unit's
 * name and whether the user manager's folders hold it. */
export function unitFileOf(path: string): { name: string; user: boolean } | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (UNIT_FILE_NAME.test(path)) return { name, user: false };
  if (USER_UNIT_FILE_NAME.test(path)) return { name, user: true };
  return null;
}
const UNIT_FILE = String.raw`(?:[^/]+\.(?:${TYPES})|(?:[^/]+\.(?:${TYPES}|scope)|${TYPES}|scope)\.d/[^/]+\.conf)`;
const SYSTEM_UNIT = new RegExp(String.raw`^/(?:etc|run|lib|usr/lib|usr/local/lib)/systemd/system/${UNIT_FILE}$`);
const USER_UNIT = new RegExp(String.raw`^${UNIT_FILE}$`);
export function unitReloadFor(path: string, home: string): { command: string; system: boolean } | null {
  if (SYSTEM_UNIT.test(path)) return { command: "systemctl daemon-reload", system: true };
  const dir = `${home.replace(/\/+$/, "")}/.config/systemd/user/`;
  if (home.startsWith("/") && path.startsWith(dir) && USER_UNIT.test(path.slice(dir.length))) return { command: "systemctl --user daemon-reload", system: false };
  return null;
}

/** The editor's language for an interpreter, by family: "python3.11" is
 * Python, "dash" a shell. */
export function languageOfInterpreter(program: string): "shell" | "python" | "perl" | "ruby" | "javascript" | "lua" | "r" | "powershell" | null {
  if (/^(?:sh|bash|dash|ash|ksh\d*|mksh|zsh|busybox)$/.test(program)) return "shell";
  if (/^python[\d.]*$/.test(program)) return "python";
  if (/^perl[\d.]*$/.test(program)) return "perl";
  if (/^ruby[\d.]*$/.test(program)) return "ruby";
  if (/^(?:node|nodejs|deno|bun)$/.test(program)) return "javascript";
  if (/^lua[\d.]*$/.test(program)) return "lua";
  if (program === "Rscript") return "r";
  if (program === "pwsh") return "powershell";
  return null;
}
