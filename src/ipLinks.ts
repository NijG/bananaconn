// IPv4 and MAC addresses in terminal output ("show arp", "show ip int brief",
// "ip route", "show mac address-table", traceroute …): the terminal makes each
// one a link that offers what to do with it (a new session, the network tools,
// a copy in another vendor's notation). Pure text matching; the terminal maps
// the matches to screen cells.

/** An address found in a line: where it is in the text, and an optional port. */
export interface IpMatch {
  ip: string;
  port: number | null;
  /** UTF-16 index of the first character, and the length linked. */
  index: number;
  length: number;
  /** The prefix length written with it ("/24", a netmask or an ACL wildcard
   * after it), when there is one. */
  prefix: number | null;
}

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
// Not part of a longer dotted number (a version "1.2.3.4.5", an OID) or a word;
// a trailing "/24", ",", ")" or sentence dot is fine.
const IPV4 = new RegExp(`(?<![\\w.])(${OCTET}(?:\\.${OCTET}){3})(?::(\\d{1,5}))?(?!\\w|\\.\\d)`, "g");

/** The IPv4 addresses in a line of output. Netmasks (255.x.x.x) and 0.x.x.x
 * are left out: they fill routing and interface tables but are not hosts.
 * 0.0.0.0/8 is "this network" (RFC 1122), never a host: written in output it
 * is a default route or an ACL/OSPF wildcard ("permit 10.0.0.0 0.0.0.255"),
 * which still gives the address before it its prefix. */
export function findIps(text: string): IpMatch[] {
  if (!/\d\.\d+\.\d+\.\d/.test(text)) return [];
  const out: IpMatch[] = [];
  for (const m of text.matchAll(IPV4)) {
    const ip = m[1];
    if (ip.startsWith("255.") || ip.startsWith("0.")) continue;
    const port = m[2] ? Number(m[2]) : null;
    // A number after a colon that is not a port (":99999") is not linked.
    const okPort = port !== null && port >= 1 && port <= 65535 ? port : null;
    const prefix = prefixAfter(text.slice(m.index! + m[0].length), text.slice(0, m.index!));
    out.push({ ip, port: okPort, index: m.index!, length: okPort ? m[0].length : ip.length, prefix });
  }
  return out;
}

/** The prefix length written right after an address: "/24", a netmask
 * ("255.255.255.0", "netmask 255.255.255.0", AIX's "netmask 0xffffff00") or an
 * ACL/OSPF wildcard ("0.0.0.255"). Anything else (another address) is none.
 * `before`: the text before the address. */
function prefixAfter(rest: string, before: string): number | null {
  const slash = /^\/(\d{1,2})(?!\d)/.exec(rest);
  if (slash) return Number(slash[1]) <= 32 ? Number(slash[1]) : null;
  const mask = /^\s+((?:net)?mask\s+)?((?:\d{1,3}\.){3}\d{1,3}|0x[0-9A-Fa-f]{8})(?![\w.])/i.exec(rest);
  if (!mask) return null;
  // A bare mask belongs to the address only when that address starts a run of
  // dotted columns, or follows another address's mask ("permit ip 10.1.0.0
  // 0.0.255.255 10.2.0.0 0.0.255.255"). After a lone address it is a route
  // table's mask column ("route -n": Destination Gateway Genmask), the
  // first address's, not the gateway's.
  if (!mask[1]) {
    const [prev, prevPrev] = dottedBefore(before);
    if (prev !== undefined && !(maskPrefix(prev) !== null && prevPrev !== undefined)) return null;
  }
  return maskPrefix(mask[2]);
}

/** The prefix length a netmask (ones then zeros) or wildcard (zeros then ones,
 * written "0.…") stands for. 0.0.0.0 is as often a gateway or a route
 * table's other column as a mask or a host wildcard: null, like any other
 * number. */
function maskPrefix(s: string): number | null {
  const n = maskNumber(s);
  if (n === null || n === 0) return null;
  return contiguous(n) ?? (s.startsWith("0.") ? contiguous(~n >>> 0) : null);
}

/** The (up to two) dotted quads right before an address, separated from it
 * and each other by spaces only, nearest first. */
function dottedBefore(before: string): string[] {
  const out: string[] = [];
  let s = before;
  while (out.length < 2) {
    const m = /(?<![\w.])((?:\d{1,3}\.){3}\d{1,3})\s+$/.exec(s);
    if (!m) break;
    out.push(m[1]);
    s = s.slice(0, m.index);
  }
  return out;
}

/** A dotted or 0x-hex mask as a 32-bit number. */
function maskNumber(s: string): number | null {
  if (/^0x/i.test(s)) return parseInt(s.slice(2), 16) >>> 0;
  const parts = s.split(".").map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** The prefix length of a netmask (ones then zeros), or null for any other number. */
function contiguous(n: number): number | null {
  const inv = ~n >>> 0;
  if ((inv & (inv + 1)) !== 0) return null;
  let bits = 0;
  for (let v = n; v; v = (v << 1) >>> 0) bits++;
  return bits;
}

/** What a subnet calculator shows for an address and prefix length. */
export interface SubnetInfo {
  network: string;
  broadcast: string;
  first: string;
  last: string;
  hosts: number;
  mask: string;
  wildcard: string;
}

const dotted = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");

/** A netmask or wildcard found in a line ("255.255.255.0", an ACL's
 * "0.0.0.255"): the prefix length it stands for and where it is. */
export interface MaskMatch {
  prefix: number;
  index: number;
  length: number;
}

/** The netmasks and wildcards in a line of output: the dotted quads findIps
 * leaves out (255.x.x.x, 0.x.x.x) that are one (ones then zeros, or zeros
 * then ones); 0.0.0.0 is not one (it is as often a route's or a gateway). */
export function findMasks(text: string): MaskMatch[] {
  if (!/(?<![\w.])(?:255|0)\.\d/.test(text)) return [];
  const out: MaskMatch[] = [];
  for (const m of text.matchAll(IPV4)) {
    const s = m[1];
    if (m[2] || !(s.startsWith("255.") || s.startsWith("0."))) continue;
    const prefix = maskPrefix(s);
    if (prefix !== null) out.push({ prefix, index: m.index!, length: s.length });
  }
  return out;
}

/** A data rate found in a line ("123456000 bits/sec", "BW 1000000 Kbit/sec",
 * "8000 bps"): bits per second, and where its number and unit are. */
export interface RateMatch {
  bitsPerSecond: number;
  index: number;
  length: number;
}

// A number, then a bit-rate unit written out: never a bare number, nor
// bytes or packets ("B/s", "packets/sec").
const RATE = /(?<![\w.])(\d{1,15})\s?([kKmMgG]?)(?:bits?\/sec|bit\/s|bps)\b/g;

/** The data rates in a line of output (IOS "show interfaces" rates and
 * bandwidth) written with four digits or more: the ones hard to read at a
 * glance ("0 bits/sec" or "100 Mbps" need no help). */
export function findRates(text: string): RateMatch[] {
  if (!/bit|bps/.test(text)) return [];
  const scale: Record<string, number> = { "": 1, k: 1e3, m: 1e6, g: 1e9 };
  return [...text.matchAll(RATE)]
    .filter((m) => m[1].length >= 4)
    .map((m) => ({ bitsPerSecond: Number(m[1]) * scale[m[2].toLowerCase()], index: m.index!, length: m[0].length }));
}

/** The bandwidth an interface's block of "show interfaces" gives the line
 * at index `at` of `lines` (the output, oldest first): its "BW … Kbit/sec"
 * line, only when the block's heading ("GigabitEthernet1/0/1 is up, …") is
 * found above it, within 60 lines, so another interface's bandwidth is never
 * taken. Bits per second, or null. */
export function bandwidthAbove(lines: (i: number) => string | undefined, at: number): number | null {
  let bw: number | null = null;
  for (let i = at - 1; i >= 0 && i >= at - 60; i--) {
    const text = lines(i);
    if (text === undefined) return null;
    const m = /\bBW (\d{1,12}) Kbit(?:\/sec)?\b/.exec(text);
    if (m) {
      // A second bandwidth before the heading: two blocks run together.
      if (bw !== null) return null;
      bw = Number(m[1]) * 1000;
    }
    if (/^\S+ is (?:up|down|administratively down|deleted)\b/.test(text)) return bw;
  }
  return null;
}

/** A rate the way people read it: "123.46 Mbit/s", "1 Gbit/s", "800 bit/s"
 * (decimal prefixes, as link speeds are counted). */
export function readableRate(bitsPerSecond: number): string {
  const units: [number, string][] = [[1e12, "Tbit/s"], [1e9, "Gbit/s"], [1e6, "Mbit/s"], [1e3, "kbit/s"]];
  for (const [size, unit] of units) {
    if (bitsPerSecond >= size) return `${Number((bitsPerSecond / size).toFixed(2))} ${unit}`;
  }
  return `${bitsPerSecond} bit/s`;
}

/** How long a device has been up, found in a line of output, and where the
 * duration is. `approximate`: a year in it, whose length the device does
 * not say (taken as 365 days). */
export interface UptimeMatch {
  seconds: number;
  approximate: boolean;
  index: number;
  length: number;
}

const UPTIME_UNIT = "\\d{1,5} (?:year|week|day|hour|minute|second)(?:s|\\(s\\))?";
// IOS "show version" ("R1 uptime is 1 year, 2 weeks, 3 days, 4 hours, 5
// minutes") and NX-OS ("Kernel uptime is 12 day(s), 3 hour(s), 4 minute(s),
// 5 second(s)").
// The parts joined by ", " or by a space alone ("3 weeks 6 days 19 hours"):
// stopping at a space would count part of the time and call it exact.
const UPTIME_IS = new RegExp(`\\buptime is (${UPTIME_UNIT}(?:,? ${UPTIME_UNIT})*)`, "g");
// Linux uptime and top ("10:22:01 up 12 days,  3:04,  2 users,  load
// average: …", "up 5 min,", "up 1 day, 12 min,"): only on a line with its load average.
const UP_LOAD = /\bup ((?:(\d{1,5}) days?, +)?(?:(\d{1,2}):(\d\d)|(\d{1,2}) min))\b/g;
const UNIT_SECONDS: Record<string, number> = { year: 365 * 86400, week: 7 * 86400, day: 86400, hour: 3600, minute: 60, second: 1 };

/** The uptimes in a line of output (IOS, NX-OS, Linux uptime/top). */
export function findUptimes(text: string): UptimeMatch[] {
  const found: UptimeMatch[] = [];
  if (text.includes("uptime is ")) {
    for (const m of text.matchAll(UPTIME_IS)) {
      let seconds = 0;
      for (const [, n, unit] of m[1].matchAll(/(\d+) (year|week|day|hour|minute|second)/g)) seconds += Number(n) * UNIT_SECONDS[unit];
      found.push({ seconds, approximate: /year/.test(m[1]), index: m.index! + m[0].length - m[1].length, length: m[1].length });
    }
  }
  if (text.includes("load average")) {
    for (const m of text.matchAll(UP_LOAD)) {
      const days = Number(m[2] ?? 0);
      const minutes = m[3] !== undefined ? Number(m[3]) * 60 + Number(m[4]) : Number(m[5]);
      found.push({ seconds: days * 86400 + minutes * 60, approximate: false, index: m.index! + 3, length: m[1].length });
    }
  }
  return found;
}

/** A prefix length written the three ways a device takes it: "/24", the
 * netmask "255.255.255.0" and the ACL/OSPF wildcard "0.0.0.255". */
export function maskForms(prefix: number): { slash: string; netmask: string; wildcard: string } {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { slash: `/${prefix}`, netmask: dotted(mask), wildcard: dotted(~mask >>> 0) };
}

/** Subnet of `ip`/`prefix`. A /31 has two usable addresses (point-to-point
 * links, RFC 3021) and a /32 one; otherwise the network and broadcast
 * addresses are not hosts. */
export function subnetInfo(ip: string, prefix: number): SubnetInfo {
  const [a, b, c, d] = ip.split(".").map(Number);
  const n = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (n & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const size = 2 ** (32 - prefix);
  const pointToPoint = prefix >= 31;
  return {
    network: dotted(network),
    broadcast: dotted(broadcast),
    first: dotted(pointToPoint ? network : network + 1),
    last: dotted(pointToPoint ? broadcast : broadcast - 1),
    hosts: pointToPoint ? size : size - 2,
    mask: dotted(mask),
    wildcard: dotted(~mask >>> 0),
  };
}

const IPV4_START = new RegExp(`^(${OCTET}(?:\\.${OCTET}){3})(.*)$`);

/** What is typed into the subnet calculator: "10.0.0.5", "10.0.0.5/24" or
 * "10.0.0.5 255.255.255.0" (a mask or wildcard read as in terminal output).
 * Null when it is not one of those. */
export function parseSubnetInput(text: string): { ip: string; prefix: number | null } | null {
  const m = IPV4_START.exec(text.trim());
  if (!m) return null;
  if (!m[2]) return { ip: m[1], prefix: null };
  // The rest must be the prefix and nothing more.
  if (!/^(?:\/\d{1,2}|\s+(?:(?:net)?mask\s+)?\S+)$/i.test(m[2])) return null;
  const prefix = prefixAfter(m[2], "");
  return prefix === null ? null : { ip: m[1], prefix };
}

/** An IPv4 address as a number, or null when `text` is not exactly one. */
function ipv4Number(text: string): number | null {
  const m = IPV4_START.exec(text.trim());
  if (!m || m[2]) return null;
  return m[1].split(".").reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
}

/** A subnet written with its prefix ("10.0.0.0/24", "10.0.0.0 255.255.255.0"),
 * as a test of whether an address is in it; null for anything else (a bare
 * address, a name). For finding saved sessions by network. */
export function subnetMatcher(text: string): ((host: string) => boolean) | null {
  const s = parseSubnetInput(text);
  if (!s || s.prefix === null) return null;
  const mask = s.prefix === 0 ? 0 : (0xffffffff << (32 - s.prefix)) >>> 0;
  const network = ((ipv4Number(s.ip) ?? 0) & mask) >>> 0;
  return (host) => {
    const n = ipv4Number(host);
    return n !== null && ((n & mask) >>> 0) === network;
  };
}

/** What kind of IPv4 address it is (the special-purpose blocks a network
 * engineer meets; anything else is public). */
export function addressKind(ip: string): string {
  const [a, b, c] = ip.split(".").map(Number);
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "사설 (RFC 1918)";
  if (a === 100 && b >= 64 && b <= 127) return "공유 주소 (CGNAT, RFC 6598)";
  if (a === 127) return "루프백";
  if (a === 169 && b === 254) return "링크 로컬 (APIPA)";
  if (a >= 224 && a <= 239) return "멀티캐스트";
  // "This network", reserved 240/4 and broadcast, IETF protocol assignments,
  // the documentation ranges and the benchmarking block.
  if (a === 0 || a >= 240 || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || (a === 198 && (b === 18 || b === 19)))
    return "특수 용도 (예약)";
  return "공인";
}

/** A MAC address found in a line: its 12 hex digits (lower case) and where it is. */
export interface MacMatch {
  hex: string;
  index: number;
  length: number;
}

// The four ways gear writes one: aa:bb:cc:dd:ee:ff (Linux), aa-bb-cc-dd-ee-ff
// (Windows), aabb.ccdd.eeff (Cisco), aabb-ccdd-eeff (Huawei). Not part of a
// longer run of hex groups (an IPv6 address, an EUI-64).
const MAC = /(?<![0-9A-Fa-f:.-])(?:[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}|[0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5}|[0-9A-Fa-f]{4}(?:\.[0-9A-Fa-f]{4}){2}|[0-9A-Fa-f]{4}(?:-[0-9A-Fa-f]{4}){2})(?![:.-]?[0-9A-Fa-f])/g;

/** The MAC addresses in a line of output. */
export function findMacs(text: string): MacMatch[] {
  if (!/[0-9A-Fa-f]{2}[:.-][0-9A-Fa-f]{2}/.test(text)) return [];
  return [...text.matchAll(MAC)].map((m) => ({ hex: m[0].replace(/[:.-]/g, "").toLowerCase(), index: m.index!, length: m[0].length }));
}

/** One MAC in each vendor's notation, for copying where it is looked up next. */
export function macFormats(hex: string): { text: string; style: string }[] {
  const pairs = hex.match(/../g)!;
  const quads = hex.match(/..../g)!;
  return [
    { text: pairs.join(":"), style: "Linux" },
    { text: pairs.join("-").toUpperCase(), style: "Windows" },
    { text: quads.join("."), style: "Cisco" },
    { text: quads.join("-"), style: "Huawei" },
  ];
}

/** What a MAC address is, when its value says so by standard: a protocol's
 * fixed address (IEEE 802.1, Cisco's CDP and PVST+), a first-hop redundancy
 * group's virtual MAC (VRRP RFC 5798, HSRP), multicast or broadcast, or a
 * locally administered one (a VM, a phone's random MAC). Null for an
 * ordinary vendor-assigned address (no vendor lookup is attempted). */
export function macKind(hex: string): string | null {
  const h = hex.toLowerCase();
  if (h === "ffffffffffff") return "브로드캐스트 주소";
  const fixed: Record<string, string> = {
    "0180c2000000": "스패닝 트리(STP) 주소",
    "0180c2000002": "LACP 주소 (슬로우 프로토콜)",
    "0180c2000003": "802.1X(EAPOL) 주소",
    "0180c200000e": "LLDP 주소",
    "01000ccccccc": "CDP·VTP·DTP 주소 (Cisco)",
    "01000ccccccd": "PVST+ 주소 (Cisco)",
  };
  if (fixed[h]) return fixed[h];
  if (/^0180c200000[0-9a-f]$/.test(h)) return "IEEE 802.1 예약 주소";
  const group = (from: number) => String(parseInt(h.slice(from), 16));
  if (h.startsWith("00005e0001")) return `VRRP 가상 MAC (VRID ${group(10)})`;
  if (h.startsWith("00005e0002")) return `VRRP IPv6 가상 MAC (VRID ${group(10)})`;
  if (h.startsWith("00000c07ac")) return `HSRP 가상 MAC (그룹 ${group(10)})`;
  if (h.startsWith("00000c9ff")) return `HSRP v2 가상 MAC (그룹 ${group(9)})`;
  // 01:00:5e with the next bit clear: the low 23 bits of an IPv4 group.
  if (h.startsWith("01005e") && parseInt(h[6], 16) < 8) return "IPv4 멀티캐스트 주소";
  if (h.startsWith("3333")) return "IPv6 멀티캐스트 주소";
  const first = parseInt(h.slice(0, 2), 16);
  if (first & 1) return "멀티캐스트 주소";
  if (first & 2) return "로컬 관리 주소 (가상 머신·무작위 MAC일 수 있음)";
  return null;
}

/** Cisco interface types: the full name, then the short forms the same
 * switch prints elsewhere ("GigabitEthernet1/0/1" in the configuration,
 * "Gi1/0/1" in "show interfaces status", "Gig 1/0/1" in "show cdp
 * neighbors"; NX-OS "Ethernet1/1" and "Eth1/1"). */
const INTERFACE_TYPES: [string, ...string[]][] = [
  ["GigabitEthernet", "Gig", "Gi"],
  ["TenGigabitEthernet", "Ten", "Te"],
  ["TwentyFiveGigE", "Twe"],
  ["FortyGigabitEthernet", "For", "Fo"],
  ["HundredGigE", "Hun", "Hu"],
  ["FastEthernet", "Fas", "Fa"],
  ["Ethernet", "Eth", "Et"],
  ["Port-channel", "Po"],
  ["Loopback", "Lo"],
  ["Vlan", "Vl"],
  ["Tunnel", "Tu"],
];
/** Each written name (longest first, so "GigabitEthernet" is not read as
 * "Gi…") to its type. */
const INTERFACE_NAMES = INTERFACE_TYPES.flatMap((t, i) => t.map((name) => [name, i] as const)).sort((a, b) => b[0].length - a[0].length);
const INTERFACE_BY_NAME = new Map(INTERFACE_NAMES);
const nameAlternatives = INTERFACE_NAMES.map(([n]) => n.replace("-", "\\-")).join("|");
// A name and its number ("1/0/1", "0/1.100" a subinterface, "10" a VLAN or
// port-channel), not inside a word or a longer path. A space between them
// only as CDP prints it: a three-letter form and a slot/port number (for
// "For" and "Ten", English words, a stack's member/slot/port: "Ten 1/1/1").
const INTERFACE = new RegExp(
  `(?<![\\w/-])(?:(${nameAlternatives})(\\d+(?:/\\d+)*(?:\\.\\d+)?)|(Gig|Twe|Hun|Fas|Eth) (\\d+(?:/\\d+)+(?:\\.\\d+)?)|(For|Ten) (\\d+(?:/\\d+){2,}(?:\\.\\d+)?))(?![\\w/]|\\.\\d)`,
  "g",
);

/** A cheap first test for a line (the terminal's links run on every line
 * hovered): one of the interface names' first two letters before a digit,
 * at a word's start (else a long run of letters is tried from every place). */
const INTERFACE_HINT = new RegExp(`(?<![A-Za-z])(?:${[...new Set(INTERFACE_TYPES.flat().map((n) => n.slice(0, 2)))].join("|")})[A-Za-z-]* ?\\d`);
export const mayHoldInterface = (text: string) => INTERFACE_HINT.test(text);

/** A Cisco interface found in a line: its type (an index for the helpers
 * below), its number and where it is. */
export interface InterfaceMatch {
  type: number;
  number: string;
  index: number;
  length: number;
}

/** The Cisco interface names in a line of output. */
export function findInterfaces(text: string): InterfaceMatch[] {
  if (!mayHoldInterface(text)) return [];
  const byName = INTERFACE_BY_NAME;
  return [...text.matchAll(INTERFACE)].map((m) => ({
    type: byName.get(m[1] ?? m[3] ?? m[5])!,
    number: m[2] ?? m[4] ?? m[6],
    index: m.index!,
    length: m[0].length,
  }));
}

/** The interface's full and shortest names ("GigabitEthernet1/0/1", "Gi1/0/1"). */
export function interfaceNames(type: number, number: string): { full: string; short: string } {
  const names = INTERFACE_TYPES[type];
  return { full: names[0] + number, short: names[names.length - 1] + number };
}

/** A find pattern (regular expression) that matches the interface however
 * it is written, and not another one ("Gi1/0/1" in "Gi1/0/10" or a
 * subinterface "Gi1/0/1.100"). */
/** The description the output gives an interface (`port`: a whole name,
 * written any way; interfaceSearchPattern anchored), the newest found or
 * null. Read from IOS output as written:
 * - the configuration ("interface GigabitEthernet1/0/1", then
 *   " description Uplink to core" in its indented lines);
 * - "show interfaces" (a "Gi… is up, line protocol is up" block, then
 *   "  Description: Uplink to core");
 * - "show interfaces description" (under its "Interface Status Protocol
 *   Description" header, rows "Gi1/0/1  up  up  Uplink to core"; a row
 *   with no description says it has none). */
export function interfaceDescription(lines: Iterable<string>, port: RegExp): string | null {
  let found: string | null = null;
  let inConfig = false;
  let inShow = false;
  let inTable = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const stanza = /^interface (\S+)$/.exec(line);
    if (stanza) {
      inConfig = port.test(stanza[1]);
      inShow = inTable = false;
      continue;
    }
    if (inConfig) {
      // Indented by one space (IOS) or two (NX-OS).
      if (/^ +\S/.test(line)) {
        const d = /^ +description (.+)$/.exec(line);
        if (d) found = d[1].trim();
        continue;
      }
      inConfig = false;
    }
    const head = /^(\S+) is (?:up|down|administratively down|deleted)\b/.exec(line);
    if (head) {
      inShow = port.test(head[1]);
      inTable = false;
      continue;
    }
    if (inShow) {
      // NX-OS puts "admin state is up, Dedicated Interface" unindented in the block.
      if (/^\s/.test(line) || /^admin state is /.test(line)) {
        const d = /^\s+Description: (.+)$/.exec(line);
        if (d) found = d[1].trim();
        continue;
      }
      inShow = false;
    }
    if (/^Interface\s+Status\s+Protocol\s+Description$/.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable) {
      const row = /^(\S+)\s+(?:up|down|admin down|deleted)\s+(?:up|down)(?:\s+(.*))?$/.exec(line);
      // Anything else (the prompt, the next command's output) ends the table.
      if (!row) inTable = false;
      else if (port.test(row[1])) found = row[2]?.trim() || null;
    }
  }
  return found;
}

/** A table cell: the text of `line` between the columns starting at `from`
 * and `to` (as its header places them), trimmed. A word the boundary cuts
 * into belongs to the column on its right, as a value one character too
 * long before it pushes it there: "IP Phone  Port 1" with "Port 1" a
 * column early is still "Port 1" under Port ID, and no "P" under Platform. */
function cell(line: string, from: number, to: number): string {
  // Moved left only for a word that starts at most two characters early: a
  // value that fills its own column and runs straight on ("core-sw3.corp.local"
  // then "Gi1/0/3" with no gap) is cut at the column as the header places it.
  const start = (at: number) => {
    let p = at;
    while (p > 0 && p < line.length && line[p - 1] !== " " && line[p] !== " ") p--;
    return at - p <= 2 && (p === 0 || line[p - 1] === " ") ? p : at;
  };
  return line.slice(start(from), to >= line.length ? line.length : start(to)).trim();
}

/** The device a port leads to, as CDP or LLDP told it in the output
 * (`port`: a whole interface name, written any way), the newest found or
 * null. Read from IOS output as written:
 * - "show cdp neighbors" / "show lldp neighbors" (under their "Device ID
 *   Local Intrfce Holdtme …" / "Device ID Local Intf Hold-time …" header:
 *   the device, then the local interface, then the far end's port last; a
 *   long device name on a line of its own, the rest on the next);
 * - "show cdp neighbors detail" ("Device ID: SW2", then "Interface:
 *   GigabitEthernet1/0/1,  Port ID (outgoing port): GigabitEthernet1/0/48");
 * - "show lldp neighbors detail" ("Local Intf: Gi1/0/1", "Port id:
 *   Gi1/0/48", "System Name: SW2"). */
export function interfaceNeighbor(lines: Iterable<string>, port: RegExp): { device: string; port: string } | null {
  let found: { device: string; port: string } | null = null;
  // The table's columns, from its header: where the local interface, the
  // hold time, the capability and the far end's port start.
  let cols: { local: number; hold: number; cap: number; port: number } | null = null;
  let wrapped = "";
  let cdpDevice = "";
  let lldp: { local: string; port: string } | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const head = /^Device[ -]ID\s+(Local Intr?f(?:ce)?)\s+(Holdtme|Hldtme|Hold-time)\s+(Capability)\b.*\b(Port ID)$/.exec(line);
    if (head) {
      cols = { local: line.indexOf(head[1]), hold: line.indexOf(head[2]), cap: line.indexOf(head[3]), port: line.lastIndexOf(head[4]) };
      wrapped = "";
      continue;
    }
    if (cols) {
      // A long device name alone on its line: its row follows, indented.
      if (/^\S+$/.test(line)) {
        wrapped = line;
        continue;
      }
      // A row: its hold time a number. Anything else (the total, a blank
      // line, the prompt) ends the table.
      if (/^\d+$/.test(cell(line, cols.hold, cols.cap))) {
        const device = cell(line, 0, cols.local) || wrapped;
        const local = cell(line, cols.local, cols.hold);
        // As the far end names it: "Gig 1/0/48", a server's "eth0", a phone's "Port 1".
        const far = cell(line, cols.port, line.length);
        wrapped = "";
        if (device && far && port.test(local)) found = { device, port: far };
        continue;
      }
      cols = null;
      wrapped = "";
    }
    const dev = /^Device ID: ?(\S+)/.exec(line);
    if (dev) {
      cdpDevice = dev[1];
      continue;
    }
    const cdp = /^Interface: ([^,]+),\s+Port ID \(outgoing port\): (\S+)/.exec(line);
    if (cdp) {
      if (cdpDevice && port.test(cdp[1].trim())) found = { device: cdpDevice, port: cdp[2] };
      cdpDevice = "";
      continue;
    }
    const local = /^Local Intf: (\S+)/.exec(line);
    if (local) {
      lldp = { local: local[1], port: "" };
      continue;
    }
    const lport = /^Port id: (\S+)/.exec(line);
    if (lport && lldp) {
      lldp.port = lport[1];
      continue;
    }
    const sys = /^System Name: (\S+)/.exec(line);
    if (sys && lldp) {
      if (lldp.port && port.test(lldp.local)) found = { device: sys[1], port: lldp.port };
      lldp = null;
    }
  }
  return found;
}

/** The VLAN a port is in, from the newest of two IOS (and NX-OS) tables:
 * - "show vlan brief": under its "VLAN Name Status Ports" header, rows
 *   "10   USERS   active   Gi1/0/3, Gi1/0/4," whose port list goes on in
 *   lines of its own further right; a port in none of its lists is in none
 *   (a trunk port);
 * - "show interfaces status": under its "Port Name Status Vlan Duplex Speed
 *   Type" header, the port's row's Vlan column ("10", "trunk"), read at the
 *   header's columns; a table without the port says nothing about it.
 * A VLAN's name comes from the newest "show vlan brief" that lists it.
 * Null when neither says, or the newest says it is in none (or "routed"). */
export function interfaceVlan(lines: Iterable<string>, port: RegExp): { id: number | null; name: string | null; trunk: boolean; state: string | null } | null {
  const names = new Map<number, string>();
  // The newest table's word on the port: a VLAN number, "trunk", or none.
  // (state: the Status column of show interfaces status, "connected", "err-disabled"...)
  let said: { id: number | null; trunk: boolean; state?: string } | null = null;
  let kind: "brief" | "status" | null = null;
  // show vlan brief: the row a continued port list belongs to, where its
  // ports start, and this table's answer so far.
  let row: { id: number; col: number } | null = null;
  let mine: number | null = null;
  // show interfaces status: its columns, and this table's answer.
  let cols: { status: number; vlan: number; duplex: number } | null = null;
  let status: { id: number | null; trunk: boolean; state?: string } | null = null;
  const end = () => {
    // A port in none of its lists is in no access VLAN: a trunk already
    // known (from show interfaces status) stays one.
    if (kind === "brief") said = mine !== null ? { id: mine, trunk: false } : (said as { trunk: boolean } | null)?.trunk ? said : null;
    else if (kind === "status" && status) said = status;
    kind = null;
    row = null;
    cols = null;
  };
  const take = (ports: string) => {
    if (row && ports.split(/,\s*/).some((p) => p.trim() && port.test(p.trim()))) mine = row.id;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^VLAN\s+Name\s+Status\s+Ports$/.test(line)) {
      end();
      kind = "brief";
      mine = null;
      continue;
    }
    const head = /^Port\s+Name\s+Status\s+(Vlan)\s+(Duplex)\s+Speed\s+Type\b/.exec(line);
    if (head) {
      end();
      kind = "status";
      cols = { status: line.search(/\bStatus\b/), vlan: line.indexOf("Vlan"), duplex: line.indexOf("Duplex") };
      status = null;
      continue;
    }
    if (kind === "brief") {
      if (/^-{3,}(\s+-{3,})+$/.test(line)) continue;
      const r = /^(\d{1,4})\s+(\S+)\s+(?:active|suspended|act\/lshut|sus\/lshut|act\/ishut|sus\/ishut|act\/unsup)\b\s*(.*)$/.exec(line);
      if (r) {
        row = { id: Number(r[1]), col: r[3] ? line.length - r[3].length : 0 };
        names.set(row.id, r[2]);
        take(r[3]);
        continue;
      }
      // A port list going on: indented to where the ports start.
      if (row && row.col && line.length > row.col && /^\s+\S/.test(line) && !line.slice(0, row.col).trim()) {
        take(line);
        continue;
      }
    } else if (kind === "status" && cols) {
      // NX-OS rules its header off with a line of dashes.
      if (/^-[-\s]*$/.test(line)) continue;
      const first = /^(\S+)\s/.exec(line);
      // A row: a port in its first column. Anything else ends the table.
      if (first && findInterfaces(first[1]).length) {
        if (port.test(first[1])) {
          const v = cell(line, cols.vlan, cols.duplex);
          // A number, "trunk", or another word ("routed"): in no VLAN.
          const state = cell(line, cols.status, cols.vlan) || undefined;
          status = /^\d{1,4}$/.test(v) ? { id: Number(v), trunk: false, state } : { id: null, trunk: v === "trunk", state };
        }
        continue;
      }
    } else continue;
    // Anything else (a blank line, the prompt, the next command) ends it.
    end();
  }
  end();
  // Set in end(), which TypeScript does not follow: its type said again.
  const s = said as { id: number | null; trunk: boolean; state?: string } | null;
  if (!s || (s.id === null && !s.trunk)) return null;
  return { id: s.id, name: s.id === null ? null : (names.get(s.id) ?? null), trunk: s.trunk, state: s.state ?? null };
}

export function interfaceSearchPattern(type: number, number: string): string {
  const names = INTERFACE_TYPES[type].map((n) => n.replace("-", "\\-")).join("|");
  const escaped = number.replace(/[./]/g, "\\$&");
  return `(?<![\\w/-])(?:${names}) ?${escaped}(?![\\w/]|\\.\\d)`;
}

// Cisco IOS's link messages: "%LINK-3-UPDOWN: Interface GigabitEthernet1/0/1,
// changed state to down" and "%LINEPROTO-5-UPDOWN: Line protocol on Interface
// GigabitEthernet1/0/1, changed state to down" (one of each per flap).
// The name is read one way only (letters, then from the first digit on):
// "[\w-]*\d" tried a long run of digits every way, quadratic on a long message.
const STATE_CHANGE = /(Line protocol on )?Interface ([A-Za-z][A-Za-z-]*\d[\w/.:-]*), changed state to (administratively down|down|up)\b/;

/** A link going down or up in a device's log message (Cisco IOS wording):
 * its interface as written, whether it is the line protocol's message, and
 * the new state. "administratively down" (shut by hand) is not a failure. */
export function interfaceStateChange(text: string): { iface: string; protocol: boolean; state: "up" | "down" | "admin-down" } | null {
  // Most messages are other ones: not searched at all.
  if (!text.includes(", changed state to ")) return null;
  const m = STATE_CHANGE.exec(text);
  if (!m) return null;
  return { iface: m[2], protocol: !!m[1], state: m[3] === "up" ? "up" : m[3] === "down" ? "down" : "admin-down" };
}

/** A port's link failures in a device's log messages: how many times its link
 * went down, and its state at the last message. */
export interface LinkDowns {
  from: string;
  iface: string;
  downs: number;
  last: "up" | "down" | "admin-down";
}

/** The ports whose link went down in `messages` (in arrival order), the most
 * often first. Each flap logs a %LINK and a %LINEPROTO line: the larger of the
 * two counts is the number of times it went down. A port shut by hand logs
 * "administratively down" and then its line protocol "down": not a failure,
 * so that protocol line is not counted while the port stays shut. Ports that
 * never went down (all coming up after a reload) are left out. */
export function linkDowns(messages: Iterable<{ from: string; text: string }>): LinkDowns[] {
  const per = new Map<string, { from: string; iface: string; link: number; proto: number; last: LinkDowns["last"]; shut: boolean }>();
  for (const x of messages) {
    const s = interfaceStateChange(x.text);
    if (!s) continue;
    const key = `${x.from}\u0000${s.iface}`;
    const c = per.get(key) ?? { from: x.from, iface: s.iface, link: 0, proto: 0, last: s.state, shut: false };
    per.set(key, c);
    if (s.state === "down" && s.protocol && c.shut) continue;
    if (s.state === "down") c[s.protocol ? "proto" : "link"]++;
    c.shut = s.state === "admin-down";
    c.last = s.state;
  }
  return [...per.values()]
    .map((c) => ({ from: c.from, iface: c.iface, downs: Math.max(c.link, c.proto), last: c.last }))
    .filter((c) => c.downs > 0)
    .sort((a, b) => b.downs - a.downs || a.from.localeCompare(b.from) || a.iface.localeCompare(b.iface));
}

/** A device log message's mnemonic ("%SW_MATM-4-MACFLAP_NOTIF"). */
const LOG_MNEMONIC = /%[A-Z][A-Z0-9_]*-\d-[A-Z0-9_]+/;
/** Fields an ARP table's line has at most (address, age, MAC, type,
 * interface, VLAN, flags…); a sentence has more. */
const ARP_FIELDS = 12;

/** An ARP table's line ("show ip arp", "arp -a", "ip neigh"): its one IPv4
 * address and its one MAC, else null. A log message naming a device's own
 * address and some host's MAC ("10.0.0.1: %SW_MATM-4-MACFLAP_NOTIF: Host
 * aabb.ccdd.eeff in vlan 10 is flapping…") pairs nothing, nor does a line
 * with two addresses or two MACs (a DHCP lease's server and client). A MAC
 * is one written as one (with its separators), not any 12 hex digits. A
 * command typed at a prompt that shows an address ("admin@10.0.0.1:~$ echo
 * 0011.2233.4455") pairs nothing either: a prompt's end ("$ ", "# ", "> ")
 * between the two, which no ARP table's line has. */
export function arpPair(text: string): { ip: string; hex: string } | null {
  if (LOG_MNEMONIC.test(text) || text.trim().split(/\s+/).length > ARP_FIELDS) return null;
  const ips = findIps(text);
  // The same address twice is one: Junos "show arp" repeats it in its Name
  // column when the name is not resolved.
  if (!ips.length || ips.some((x) => x.ip !== ips[0].ip)) return null;
  const macs = findMacs(text);
  if (macs.length !== 1) return null;
  const [ip, mac] = [ips[0], macs[0]];
  const between = ip.index < mac.index ? text.slice(ip.index + ip.length, mac.index) : text.slice(mac.index + mac.length, ip.index);
  return /[$#>]\s/.test(between) ? null : { ip: ip.ip, hex: mac.hex };
}

/** A find pattern (regular expression) that matches the MAC in any of those notations. */
export function macSearchPattern(hex: string): string {
  return hex.match(/../g)!.join("[:.-]?");
}

/** A regular expression finding `ip` as a whole address in output, not
 * inside a longer one ("10.0.0.1" in "10.0.0.15" or "110.0.0.1"), while
 * "addr:10.0.0.1", "10.0.0.1/24" and a sentence's "10.0.0.1." still match.
 * IPv6 by the form written, not its other spellings. */
export function addressPattern(ip: string): string {
  const escaped = ip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return ip.includes(":") ? `(?<![\\w:])${escaped}(?![\\w:])` : `(?<![\\d.])${escaped}(?!\\d|\\.\\d)`;
}
