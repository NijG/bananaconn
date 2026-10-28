// Which commands an AI may run on its own in the terminal.
//
// "auto": read-only (shows state, changes nothing) and finite — runs at once.
// "approve": anything that could change the system, never ends by itself,
//            or cannot be read with confidence — the engineer decides.
// "block": a block rule of the risky-command list (time and NTP …) — never.
// The check is deliberately narrow: a command is read-only only when every
// part of it (pipes, ; && ||) is a known read-only program used a read-only
// way, with no output redirected to a file and no command substitution.

import { findTypedRisk } from "../riskRules";

export interface Verdict {
  action: "auto" | "approve" | "block";
  /** Why, for the engineer (approval card, audit log). */
  reason: string;
}

/** Programs that only read, with the arguments that would make them write
 * or never end (checked against the whole command part). */
const UNIX: Record<string, RegExp | null> = {
  ls: null, ll: null, cat: null, head: null, zcat: null, grep: null, egrep: null, fgrep: null, zgrep: null,
  awk: /\bsystem\s*\(|\|\s*getline|print\s*>/, sort: /\s-o(\b|\S)|--output\b/, uniq: null, wc: null, cut: null, tr: null, column: null,
  stat: null, file: null, du: null, df: null, free: null, uptime: null, w: null, who: null, last: null, lastb: null,
  id: null, whoami: null, groups: null, uname: null, ps: null, pgrep: null, pidof: null, vmstat: null, iostat: null,
  mpstat: null, sar: /\s-o(\b|\S)|--output\b/, pidstat: null, lsblk: null, blkid: null, lsof: /\s[+-]r\d*/, ss: /\s-K\b/, netstat: /\s-[a-zA-Z]*c\b|--continuous\b/, lscpu: null,
  lsmem: null, lspci: null, lsusb: null, dmidecode: null, findmnt: null, env: null, printenv: null, getenforce: null,
  sestatus: null, lsmod: null, modinfo: null, nproc: null, sensors: null, echo: null, printf: null, which: null,
  whereis: null, type: null, readlink: null, realpath: null, basename: null, dirname: null, cal: null, tree: null,
  xxd: null, hexdump: null, od: null, strings: null, md5sum: null, sha1sum: null, sha256sum: null, cksum: null,
  jq: null, getconf: null, pvs: null, vgs: null, lvs: null, pvdisplay: null, vgdisplay: null, lvdisplay: null,
  lsattr: null, getfacl: null, ulimit: /\s-[a-zA-Z]+\s+\d/, nslookup: null, dig: null, host: null, tracepath: null,
  traceroute: null, mtr: /^(?!.*(--report|-r\b))/, test: null, true: null,
  // Unix systems at work: AIX, HP-UX, Solaris.
  lsdev: null, lspv: null, lsvg: null, lslv: null, lsps: null, lslpp: null, oslevel: null, errpt: null, prtconf: null,
  svmon: null, entstat: /\s-r\b/, lssrc: null, instfix: /\s-[kf]\b/, lsuser: null, lsgroup: null, bdf: null, swlist: null,
  ioscan: null, lanscan: null, machinfo: null, model: null, cmviewcl: null, kctune: /\S+=/, prtdiag: null, psrinfo: null,
  svcs: null, prstat: /^(?!.*\s\d+\s+\d+)/, zoneadm: /\s(boot|halt|reboot|install|uninstall|clone|move|attach|detach|mark)\b/,
  // With limits below.
  // sed "w"/"W" write a file and "e" runs a shell command, as a standalone
  // command or as a flag on s///e / s///w (which execute or write per line).
  sed: /\s-i|--in-place|\s-f\b|--file\b|(?<![A-Za-z])[wW]\s+\S|(?:^|[\s;'"{])e(?:\s|$|['"}])|[sy]([/|,#:~@!%]).*?\1.*?\1[a-z0-9]*[ew]/,
  find: /\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/, tail: /\s(-[a-zA-Z]*[fF]|--follow)\b/,
  journalctl: /\s(-f|--follow|--vacuum\S*|--rotate|--flush|--sync|--setup-keys|--relinquish-var)\b/, dmesg: /\s-[a-zA-Z]*[cCDEn]|--(clear|read-clear)\b/,
  top: /^(?!.*\s-[a-zA-Z]*b)|^(?!.*\s-[a-zA-Z]*n\s*\d)/, ping: /^(?!.*\s-[a-zA-Z]*c\s*\d)/, ping6: /^(?!.*\s-[a-zA-Z]*c\s*\d)/,
  date: /\s(?!\+)\S/, hostname: /\s(?!-[fiIsdA]\b)\S/, mount: /\s(?!-l\b)\S/, ifconfig: /\s(up|down|add|del|inet|netmask|broadcast|mtu|hw|promisc|arp|-arp)\b|\d+\.\d+\.\d+\.\d+/,
  ip: /\s(add|del|delete|change|replace|set|flush|append|prepend|save|restore|exec|monitor)\b/, route: /\s(add|del|delete|flush|change)\b/, arp: /\s-[ds]\b/,
  sysctl: /\s-w\b|=|\s-p\b|--load|--system/, ethtool: /\s(-[sKAGCEPLW]\b|--change|--set-\S+|--flash|--reset|--offload|--pause|--coalesce|--set-ring|--set-channels)/,
  smartctl: /\s(-t|--test|-X|--abort|-s|--smart|-o|--offline-auto|-S|--saveauto)\b/,
  chronyc: /^(?!.*\s(tracking|sources|sourcestats|activity|ntpdata|serverstats|clients)\b)/,
  timedatectl: /^(?!(.*\s)?(status|show|list-timezones|timesync-status|show-timesync)\b|\s*timedatectl\s*$)/,
  hostnamectl: /\s(set-\S+|hostname\s+\S+)/,
  systemctl: /^(?!.*\s(status|show|is-active|is-enabled|is-failed|is-system-running|list-units|list-unit-files|list-timers|list-sockets|list-dependencies|list-jobs|cat|--failed|get-default)\b)/,
  firewall_cmd: /^(?!.*\s--(list-\S+|state|get-\S+|query-\S+|info-\S+)\b)|\s--(add|remove|change|set|new|delete|reload|complete-reload|runtime-to-permanent|panic)/,
  iptables: /\s-[ADIRNXFPZE]\b|--(append|delete|insert|replace|new|flush|zero|policy|rename|delete-chain)/,
  ip6tables: /\s-[ADIRNXFPZE]\b|--(append|delete|insert|replace|new|flush|zero|policy|rename|delete-chain)/,
  nft: /^(?!.*\slist\b)/, crontab: /^(?!.*\s-l\b)|\s-[er]\b/, multipath: /^(?!.*\s-l)|\s-[fFrw]\b/,
  docker: /^(?!.*\s(ps|images|logs|inspect|stats|info|version|top|port|history|network\s+ls|network\s+inspect|volume\s+ls|volume\s+inspect|system\s+df|compose\s+ps)\b)|\s(-f|--follow)\b|\sstats\b(?!.*--no-stream)/,
  podman: /^(?!.*\s(ps|images|logs|inspect|stats|info|version|top|port|history)\b)|\s(-f|--follow)\b|\sstats\b(?!.*--no-stream)/,
  kubectl: /^(?!.*\s(get|describe|logs|top|version|cluster-info|api-resources|api-versions|explain|events)\b)|\s(-f|--follow|-w|--watch)\b/,
  // "%(…)" in a macro or query format runs a shell command.
  rpm: /^(?!.*\s-q)|\s-(e|i|U|F|-erase|-install|-upgrade|-freshen|-rebuilddb|-import|-setperms|-setugids)\b|%\(/,
  dpkg: /^(?!.*\s(-l|-s|-L|-S|-p|--list|--status|--listfiles|--search|--print-avail|--get-selections)\b)/,
  apt: /^(?!.*\s(list|show|policy|search|depends|rdepends)\b)/, "apt-cache": null,
  yum: /^(?!.*\s(list|info|repolist|search|provides|deplist|check-update)\b)/, dnf: /^(?!.*\s(list|info|repolist|search|provides|repoquery|check-update)\b)/,
  zypper: /^(?!.*\s(se|search|info|if|lr|repos|lu|list-updates|pa|packages)\b)/,
  ipmitool: /^(?!.*\s(sdr|sel\s+list|sel\s+elist|sel\s+info|sensor|fru|lan\s+print|chassis\s+status|mc\s+info|power\s+status)\b)/,
  bootlist: /^(?!.*\s-o\b)/, zpool: /^(?!.*\s(status|list|iostat|get|history)\b)/, zfs: /^(?!.*\s(list|get)\b)/, pkg: /^(?!.*\s(list|info|search|contents)\b)/,
};

/** First words of read-only device CLI commands (Cisco, Aruba, FortiGate, Juniper, Huawei …). */
const DEVICE = /^(show|sh|display|dis|get|ping|traceroute|tracert|dir|more|terminal\s+(length|width)\s+\d+|screen-length\s+0\s+temporary|set\s+cli\s+screen-(length|width)\s+\d+|no\s+page|diagnose\s+(sys\s+(top|session\s+stat|top-summary|performance\s+status)|hardware\s+deviceinfo|netlink\s+interface\s+list|ip\s+arp\s+list)|execute\s+(ping|traceroute|ping6)|request\s+support\s+information)\b/i;
const DEVICE_PIPE = /^(include|exclude|begin|section|count|match|grep|except|no-more|display|last|find|i|e|b|s|in|ex|be|sec)\b/i;

/** Commands that run another program (sudo env nice …): they must be peeled
 * off so the program they actually run is the one judged. Each maps to the
 * short options that take a value, so the value is not mistaken for the
 * program. A bare wrapper with no program ("env" alone) prints the environment
 * and is left for the read-only table below. */
const WRAPPER_VALUE_OPTS: Record<string, RegExp> = {
  sudo: /^-(u|g|U|C|h|p|R|T|D)$/,
  doas: /^-(u|C)$/,
  env: /^-(u|C|S)$/,
  nice: /^-n$/,
  ionice: /^-(c|n|p|t)$/,
  timeout: /^(-s|-k|--signal|--kill-after)$/,
  stdbuf: /^-(i|o|e)$/,
  nohup: /^$/,
  setsid: /^$/,
  time: /^-(o|f)$/,
};
const WRAPPERS = new Set(Object.keys(WRAPPER_VALUE_OPTS));

/** Strip a wrapper's own options, assignments and (for timeout) the duration,
 * returning the program it runs, or null when it was given none. */
function unwrap(name: string, rest: string): string | null {
  let s = rest.trim();
  const valOpt = WRAPPER_VALUE_OPTS[name] ?? /^$/;
  while (s) {
    const tok = /^\S+/.exec(s)![0];
    if (/^[A-Za-z_]\w*=/.test(tok) || /^--[\w-]+=/.test(tok)) {
      s = s.slice(tok.length).trimStart(); // env VAR=val, --opt=val
    } else if (tok.startsWith("-")) {
      s = s.slice(tok.length).trimStart();
      if (valOpt.test(tok)) s = s.replace(/^\S+\s*/, ""); // consume the option's value
    } else if (name === "timeout" && /^\d+(\.\d+)?[smhd]?$/i.test(tok)) {
      s = s.slice(tok.length).trimStart(); // the timeout duration
    } else {
      return s; // the program and its arguments
    }
  }
  return null;
}

/** The parts of a shell line (split at | ; && || &), quotes kept whole. */
function parts(line: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"') cur += line[++i] ?? "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "\\") {
      cur += c + (line[++i] ?? "");
    } else if (c === "|" || c === ";" || c === "&") {
      if (c === "&" && line[i + 1] !== "&" && line[i - 1] !== "&" && line[i - 1] !== ">") return null; // background job
      out.push(cur.trim());
      cur = "";
      if (line[i + 1] === c) i++;
    } else cur += c;
  }
  if (quote) return null;
  out.push(cur.trim());
  return out.filter(Boolean);
}

function readOnlyUnix(line: string): boolean {
  // Command substitution, here-docs, process substitution: cannot be read with confidence.
  if (/`|\$\(|<<|<\(|>\(/.test(line)) return false;
  // /dev/tcp and /dev/udp open a network socket (a bash feature), not a file.
  if (/\/dev\/(tcp|udp)\//.test(line)) return false;
  // Another process's root/cwd/fd crosses mount or namespace boundaries.
  if (/\/proc\/\d+\/(root|cwd|fd)\b/.test(line)) return false;
  // Output may go to /dev/null or stderr may join stdout; any other redirect writes a file.
  const cleaned = line.replace(/\d?>>?\s*\/dev\/null|2>&1|&>\s*\/dev\/null/g, "");
  if (/>/.test(cleaned)) return false;
  const list = parts(cleaned);
  if (!list?.length) return false;
  return list.every((part) => {
    // Peel command wrappers (sudo/env/nice/timeout/…) with their options and
    // leading assignments, then judge the program they run.
    let p = part.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, "");
    for (let guard = 0; guard < 8; guard++) {
      const m = /^([a-z][\w-]*)\s+(.*)$/i.exec(p);
      if (!m || !WRAPPERS.has(m[1].toLowerCase())) break;
      const prog = unwrap(m[1].toLowerCase(), m[2]);
      if (prog === null) break; // no program followed: judge the wrapper itself
      p = prog.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, "");
    }
    p = p.replace(/^(?:\S*\/)?/, "");
    const word = /^[\w.+-]+/.exec(p)?.[0] ?? "";
    const key = word === "firewall-cmd" ? "firewall_cmd" : word;
    if (!(key in UNIX)) return false;
    const deny = UNIX[key];
    // The arguments, starting with a blank when there are any (" -la /tmp").
    const args = p.slice(word.length);
    return !deny || !deny.test(args);
  });
}

function readOnlyDevice(line: string): boolean {
  const [first, ...pipes] = line.split("|").map((s) => s.trim());
  return DEVICE.test(first) && pipes.every((p) => DEVICE_PIPE.test(p)) && !/[;`]/.test(line);
}

/** A Where/Sort/Select argument that runs something rather than naming a
 * property to read (| Where-Object Kill, | Select-Object Delete): a bare member
 * whose name is a destructive verb. Plain properties (CPU, Name, WS) stay read-only. */
const PS_DESTRUCTIVE_MEMBER =
  /(?:^|[\s(){@])(kill|delete|remove|dispose|close|stop|terminate|create|start|move|rename|save|write|clear|set|add|invoke|run|send|format|disable|enable|restart|suspend|resume|truncate|flush|commit|abort|exec|execute)\b/i;
/** ForEach-Object invokes whatever member it is given (| ForEach-Object Kill,
 * | % Delete, | ForEach-Object 'Kill', -MemberName Kill), so any non-switch
 * argument — a bare name or a quoted one — is treated as a call. */
const PS_FOREACH_MEMBER = /(?:^|[\s(])(?!-)['"A-Za-z]/;
/** Get-WmiObject/gwmi (and CIM) invoke a WMI method with these: not a read. */
const PS_WMI_METHOD = /\s-(name|methodname|argumentlist)\b/i;

/** Read-only PowerShell cmdlets other than Get-* (and aliases), with the
 * arguments that would make them write or never end. */
const PS_CMDLETS: Record<string, RegExp | null> = {
  "select-object": PS_DESTRUCTIVE_MEMBER, select: PS_DESTRUCTIVE_MEMBER, "where-object": PS_DESTRUCTIVE_MEMBER, where: PS_DESTRUCTIVE_MEMBER, "?": PS_DESTRUCTIVE_MEMBER,
  "sort-object": PS_DESTRUCTIVE_MEMBER, sort: PS_DESTRUCTIVE_MEMBER,
  "format-table": null, ft: null, "format-list": null, fl: null, "format-wide": null, fw: null, "format-custom": null, fc: null,
  "measure-object": null, measure: null, "group-object": null, group: null, "compare-object": null, compare: null, diff: null,
  "foreach-object": PS_FOREACH_MEMBER, foreach: PS_FOREACH_MEMBER, "%": PS_FOREACH_MEMBER, "out-string": null, "out-null": null, "write-output": null, echo: null, write: null,
  "convertto-json": null, "convertto-csv": null, "convertto-html": null, "convertfrom-json": null, "convertfrom-csv": null,
  "select-string": null, sls: null, "test-path": null, "test-connection": /\s-(continuous|t|repeat)\b|\s-count\s+\d{5,}/i, "test-netconnection": null, tnc: null,
  "resolve-dnsname": null,
  // Aliases of Get-* cmdlets.
  gci: null, ls: null, dir: null, gc: /\s-wai?t?\b/i, cat: /\s-wai?t?\b/i, type: /\s-wai?t?\b/i, gps: null, ps: null, gsv: null, gwmi: PS_WMI_METHOD,
  gcim: PS_WMI_METHOD, gp: null, gpv: null, gi: null, gl: null, pwd: null, gm: null, gal: null, gcm: null, gv: null, history: null, ghy: null, gjb: null, gdr: null,
};
/** Get-* cmdlets that ask for input or never end with these arguments. */
const PS_GET_DENY: Record<string, RegExp> = {
  "get-credential": /(?:)/, "get-content": /\s-wai?t?\b/i, "get-counter": /\s-continuous\b/i, "get-help": /\s-online\b/i,
  "get-wmiobject": PS_WMI_METHOD, "get-ciminstance": PS_WMI_METHOD,
};
/** Windows programs that only read, with the arguments that would change something. */
const WIN_EXES: Record<string, RegExp | null> = {
  ipconfig: /\/(release6?|renew6?|flushdns|registerdns|setclassid6?)\b/i, systeminfo: null, tasklist: /\s\/(s|u|p)\b/i, netstat: null, whoami: null,
  hostname: /\s\S/, ver: null, getmac: null, driverquery: null, ping: /\s[-/]t\b|\s[-/]n\s+\d{5,}/i, tracert: null, pathping: null, nslookup: null,
  quser: null, qwinsta: null, findstr: null, more: null, "where.exe": null, route: /^(?!\s*print\b)/i, arp: /\s-[ds]\b/i,
  // Only the explicit sc.exe is the service tool; bare "sc" in PowerShell is the
  // Set-Content alias (a write), so it must not be treated as read-only.
  "sc.exe": /^(?!\s*(query|queryex|qc|qdescription|qfailure|qtriggerinfo|qprivs|qsidtype|getdisplayname|getkeyname|enumdepend)\b)/i,
  netsh: /^(?!.*\sshow\b)|\s(set|add|delete|reset|dump|exec|import|export|install|uninstall|start|stop)\b/i,
  reg: /^(?!\s*query\b)/i, schtasks: /^(?!\s*\/query\b)|\/(create|delete|run|end|change)\b/i,
  wmic: /\s(call|delete|set|create)\b|\/(output|append|record):/i, powercfg: /^(?!\s*\/(list|l|query|q|a|availablesleepstates|getactivescheme)\b)/i,
  // Only the forms that list or show one thing. "net user bob pass" would set a
  // password (two tokens → not matched → approve). "net share name=path" creates
  // a share and "net use \\host\share" connects/maps, so the show-one token
  // excludes "=", and "use" is read-only only when bare (any argument changes).
  net: /^(?!\s*(?:(?:user|localgroup|group|share|session|view|accounts)(?:\s+(?:"[^"]*"|[^\s"/*=]+))?|(?:statistics|config)(?:\s+(?:workstation|server))?|use|start)?\s*$)/i,
};
/** .NET methods that only compute a value ((Get-Date).AddDays(-1), $s.Trim()). */
const SAFE_METHODS = /^(AddDays|AddHours|AddMinutes|AddSeconds|AddMonths|ToString|ToLower|ToUpper|Trim|TrimStart|TrimEnd|Split|Substring|Contains|StartsWith|EndsWith|Replace|IndexOf|GetType|Equals|PadLeft|PadRight|ToShortDateString|ToLongDateString)$/i;

const psAllowed = (name: string) => {
  const n = name.toLowerCase();
  return n.startsWith("get-") ? !(n in PS_GET_DENY && PS_GET_DENY[n].source === "(?:)") : n in PS_CMDLETS;
};

/** A one-line PowerShell (or cmd) command that only reads: every command in it
 * is a known read-only one, script blocks only test and pick values, and
 * nothing is assigned, redirected to a file, invoked or called on .NET. */
function readOnlyWindows(line: string): boolean {
  if (/`/.test(line)) return false;
  // Strings become '' (a double-quoted string with $ may expand a command).
  const s = line.replace(/'[^']*'|"[^"$`]*"/g, "''");
  if (/["]|'[^']/.test(s.replace(/''/g, ""))) return false;
  // "&" is the call operator and a standalone "." dot-sources a script; both run code.
  if (/\$\(|@\(|::|&|<|(?:^|[\s;|({])\.(?=[\s'"])|\b(iex|icm|invoke-\w+|start-\w+)\b/i.test(s)) return false;
  if (/>/.test(s.replace(/[\d*]?>\s*\$null\b/gi, ""))) return false;
  for (const m of s.matchAll(/\.(\w+)\s*\(/g)) if (!SAFE_METHODS.test(m[1])) return false;
  // Every cmdlet named anywhere (also in parentheses and script blocks).
  for (const m of s.matchAll(/(?<![\w$.-])([A-Za-z]+-[A-Za-z]\w*)/g)) if (!psAllowed(m[1])) return false;
  // A parenthesis runs what it holds: only allowed cmdlets ((Get-Date), not (shutdown /r)).
  for (const m of s.matchAll(/(?<![\w.])\(\s*([A-Za-z_][\w.-]*)/g)) if (!psAllowed(m[1])) return false;
  // Script blocks: values, operators and allowed cmdlets only (no programs).
  for (const m of s.matchAll(/(?<!@)\{([^{}]*)\}/g)) {
    const words = m[1].replace(/''/g, " ").replace(/(?<![\w$.-])[A-Za-z]+-[A-Za-z]\w*/g, " ").replace(/\$[\w:?]+(\.\w+)*/g, " ").replace(/\.\w+/g, " ").replace(/-\w+/g, " ").replace(/\b\d[\w.]*\b/g, " ");
    for (const w of words.match(/[A-Za-z_][\w-]*/g) ?? []) if (!psAllowed(w) && !/^(true|false|null)$/i.test(w)) return false;
  }
  // Hashtables (@{LogName=''; Level=2}) may hold '=' and ';'; then no assignment may remain.
  const flat = s.replace(/@\{[^{}]*\}/g, "@{}").replace(/\{[^{}]*\}/g, "{}");
  if (/(^|[^=!<>-])=(?!=)/.test(flat)) return false;
  const list = flat.split(/[|;]/).map((p) => p.trim()).filter(Boolean);
  if (!list.length) return false;
  return list.every((part) => {
    const p = part.replace(/^\(+/, "");
    const word = /^[\w.?%-]+/.exec(p)?.[0].toLowerCase() ?? "";
    const exe = word.replace(/\.exe$/, "");
    const args = p.slice(word.length);
    if (word.startsWith("get-")) return psAllowed(word) && !(word in PS_GET_DENY && PS_GET_DENY[word].test(args));
    if (word in PS_CMDLETS) return !PS_CMDLETS[word]?.test(args);
    if (exe in WIN_EXES || word in WIN_EXES) return !WIN_EXES[word in WIN_EXES ? word : exe]?.test(args);
    // A bare value or variable to show ($env:COMPUTERNAME, $PSVersionTable).
    return /^\$[\w:]+(\.\w+)*$/.test(p);
  });
}

/** Whether a command an AI wants to run may run without asking. `windows`:
 * the shell is PowerShell (or cmd) on Windows, where Unix rules do not apply. */
export function judge(command: string, network: boolean, windows = false): Verdict {
  const cmd = command.trim();
  if (!cmd) return { action: "block", reason: "빈 명령" };
  if (/[\r\n]/.test(cmd)) return { action: "approve", reason: "여러 줄 명령" };
  // A real read-only command is short; cap the length before the allowlist
  // regexes run, both as a safety net against a pathological line and to keep
  // any one pattern from backtracking over thousands of characters.
  if (cmd.length > 2000) return { action: "approve", reason: "명령이 너무 깁니다" };
  const risk = findTypedRisk(cmd);
  if (risk?.rule.action === "block") return { action: "block", reason: risk.rule.note };
  if (risk) return { action: "approve", reason: risk.rule.note };
  if (windows) return readOnlyWindows(cmd) ? { action: "auto", reason: "읽기 전용 명령" } : { action: "approve", reason: "시스템을 바꿀 수 있거나 확인할 수 없는 명령" };
  // A device not recognised may still be network gear: its CLI rules apply,
  // but never to a program the Unix table knows (Linux ping never ends).
  const first = /^[\w.+-]+/.exec(cmd.replace(/^(?:\S*\/)/, ""))?.[0] ?? "";
  const unixWord = first in UNIX || first === "firewall-cmd";
  const ok = network ? readOnlyDevice(cmd) || readOnlyUnix(cmd) : readOnlyUnix(cmd) || (!unixWord && readOnlyDevice(cmd));
  return ok ? { action: "auto", reason: "읽기 전용 명령" } : { action: "approve", reason: "시스템을 바꿀 수 있거나 확인할 수 없는 명령" };
}
