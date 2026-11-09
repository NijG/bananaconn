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

/** The IPv4 addresses in a line of output. Netmasks (255.x.x.x) and 0.0.0.0
 * are left out: they fill routing and interface tables but are not hosts. */
export function findIps(text: string): IpMatch[] {
  if (!/\d\.\d+\.\d+\.\d/.test(text)) return [];
  const out: IpMatch[] = [];
  for (const m of text.matchAll(IPV4)) {
    const ip = m[1];
    if (ip.startsWith("255.") || ip === "0.0.0.0") continue;
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
