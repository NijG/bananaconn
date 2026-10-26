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
  awk: /\bsystem\s*\(|\|\s*getline|print\s*>/, sort: /\s-o\b/, uniq: null, wc: null, cut: null, tr: null, column: null,
  stat: null, file: null, du: null, df: null, free: null, uptime: null, w: null, who: null, last: null, lastb: null,
  id: null, whoami: null, groups: null, uname: null, ps: null, pgrep: null, pidof: null, vmstat: null, iostat: null,
  mpstat: null, sar: /\s-o\b/, pidstat: null, lsblk: null, blkid: null, lsof: null, ss: /\s-K\b/, netstat: null, lscpu: null,
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
  sed: /\s-i|--in-place/, find: /\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/, tail: /\s(-[a-zA-Z]*[fF]|--follow)\b/,
  journalctl: /\s(-f|--follow|--vacuum\S*|--rotate|--flush|--sync|--setup-keys|--relinquish-var)\b/, dmesg: /\s-[a-zA-Z]*[cCDEn]/,
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
  rpm: /^(?!.*\s-q)|\s-(e|i|U|F|-erase|-install|-upgrade|-freshen|-rebuilddb|-import|-setperms|-setugids)\b/,
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
  // Output may go to /dev/null or stderr may join stdout; any other redirect writes a file.
  const cleaned = line.replace(/\d?>>?\s*\/dev\/null|2>&1|&>\s*\/dev\/null/g, "");
  if (/>/.test(cleaned)) return false;
  const list = parts(cleaned);
  if (!list?.length) return false;
  return list.every((part) => {
    let p = part.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, "").replace(/^sudo\s+(?:-n\s+)?/, "");
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

/** Whether a command an AI wants to run may run without asking. */
export function judge(command: string, network: boolean): Verdict {
  const cmd = command.trim();
  if (!cmd) return { action: "block", reason: "빈 명령" };
  if (/[\r\n]/.test(cmd)) return { action: "approve", reason: "여러 줄 명령" };
  const risk = findTypedRisk(cmd);
  if (risk?.rule.action === "block") return { action: "block", reason: risk.rule.note };
  if (risk) return { action: "approve", reason: risk.rule.note };
  // A device not recognised may still be network gear: its CLI rules apply,
  // but never to a program the Unix table knows (Linux ping never ends).
  const first = /^[\w.+-]+/.exec(cmd.replace(/^(?:\S*\/)/, ""))?.[0] ?? "";
  const unixWord = first in UNIX || first === "firewall-cmd";
  const ok = network ? readOnlyDevice(cmd) || readOnlyUnix(cmd) : readOnlyUnix(cmd) || (!unixWord && readOnlyDevice(cmd));
  return ok ? { action: "auto", reason: "읽기 전용 명령" } : { action: "approve", reason: "시스템을 바꿀 수 있거나 확인할 수 없는 명령" };
}
