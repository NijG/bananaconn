// Check the address helpers (src/ipLinks.ts) the terminal's links, the
// subnet calculator and the session search use: subnet arithmetic against a
// BigInt reference for random addresses and every prefix, the ways a prefix
// is written (/24, a mask, "mask …", an ACL wildcard, AIX's 0x mask), the
// subnet search, and what a MAC address's value says it is.
//
//   node scripts/address-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { hostAddresses, addressKind, arpPair, bandwidthAbove, findInterfaces, findIps, findIpv6s, interfaceDescription, interfaceNeighbor, interfaceVlan, findMacs, findMasks, findRates, findUptimes, findLogMnemonics, macFormats, macLinkLocal, maskForms, reverseName4, reverseName6, reverseZone4, reverseZone6, sameHost, hostKey, splitIpv6, trimSeparators, readableRate, interfaceNames, interfaceSearchPattern, interfaceStateChange, linkDowns, macKind, expandIpv6, formatIpv6, ipv6Kind, ipv6Subnet, parseIpv6, parseIpv6Input, parseNetworkList, parseRangeInput, parseSubnetInput, rangeAddresses, rangeToCidrs, summarizeNetworks, splitSubnet, subnetInfo, subnetMatcher } from "../src/ipLinks.ts";

let failed = 0;
const fail = (...what) => {
  failed++;
  if (failed <= 10) console.error("FAIL", ...what.map((w) => JSON.stringify(w)));
};

// ---- subnets: random addresses, every prefix (a fixed seed: the same cases each run)
let seed = 777;
const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
const ALL = (1n << 32n) - 1n;
const dot = (n) => [24, 16, 8, 0].map((s) => Number((n >> BigInt(s)) & 255n)).join(".");
for (let t = 0; t < 20000; t++) {
  const n = BigInt(rnd(65536)) * 65536n + BigInt(rnd(65536));
  const p = t < 33 ? t : rnd(33);
  const ip = dot(n);
  const mask = p === 0 ? 0n : ALL ^ ((1n << BigInt(32 - p)) - 1n);
  const net = n & mask;
  const bc = net | (ALL ^ mask);
  const want = {
    network: dot(net),
    broadcast: dot(bc),
    first: dot(p >= 31 ? net : net + 1n),
    last: dot(p >= 31 ? bc : bc - 1n),
    hosts: p >= 31 ? 2 ** (32 - p) : 2 ** (32 - p) - 2,
    mask: dot(mask),
    wildcard: dot(ALL ^ mask),
  };
  const got = subnetInfo(ip, p);
  if (JSON.stringify(got) !== JSON.stringify(want)) fail("subnetInfo", ip, p, got);
  for (const text of [`${ip}/${p}`, ...(p > 0 ? [`${ip} ${want.mask}`, `${ip} mask ${want.mask}`] : [])]) {
    const s = parseSubnetInput(text);
    if (!s || s.ip !== ip || s.prefix !== p) fail("parseSubnetInput", text, s);
  }
  // An ACL wildcard is read as one when it starts with "0." (/8 to /31).
  if (p >= 8 && p < 32) {
    const s = parseSubnetInput(`${ip} ${want.wildcard}`);
    if (!s || s.prefix !== p) fail("wildcard", ip, want.wildcard, s);
  }
  const inSubnet = subnetMatcher(`${ip}/${p}`);
  if (!inSubnet(want.network) || !inSubnet(want.broadcast)) fail("subnetMatcher in", ip, p);
  if (p > 0 && bc !== ALL && inSubnet(dot(bc + 1n))) fail("subnetMatcher out", ip, p);
}
// ---- splitting a network: the parts tile it in order, each as subnetInfo
// says, and the one holding the address given is marked.
for (let t = 0; t < 2000; t++) {
  const n = BigInt(rnd(65536)) * 65536n + BigInt(rnd(65536));
  const p = rnd(32);
  const into = p + 1 + rnd(Math.min(8, 32 - p));
  const ip = dot(n);
  const parts = splitSubnet(ip, p, into);
  const whole = subnetInfo(ip, p);
  if (!parts || parts.length !== 2 ** (into - p)) {
    fail("splitSubnet count", ip, p, into, parts?.length);
    continue;
  }
  if (parts[0].network !== whole.network || parts.at(-1).broadcast !== whole.broadcast) fail("splitSubnet ends", ip, p, into);
  for (let i = 0; i < parts.length; i++) {
    if (JSON.stringify({ ...parts[i], mine: undefined }) !== JSON.stringify({ ...subnetInfo(parts[i].network, into), mine: undefined })) fail("splitSubnet part", ip, p, into, i);
    if (i && subnetInfo(parts[i - 1].broadcast, 32).network.split(".").reduce((a, o) => a * 256 + Number(o), 0) + 1 !== parts[i].network.split(".").reduce((a, o) => a * 256 + Number(o), 0)) fail("splitSubnet gap", ip, p, into, i);
  }
  if (parts.filter((x) => x.mine).length !== 1 || !subnetMatcher(`${parts.find((x) => x.mine).network}/${into}`)(ip)) fail("splitSubnet mine", ip, p, into);
}
for (const [p, into] of [[24, 24], [24, 23], [24, 33], [16, 25], [24, 24.5]]) if (splitSubnet("10.0.0.1", p, into) !== null) fail("splitSubnet refused", p, into);
{
  const s = splitSubnet("192.168.1.77", 24, 26);
  if (JSON.stringify(s.map((x) => [x.network, x.first, x.last, x.broadcast, x.hosts, x.mine])) !== JSON.stringify([
    ["192.168.1.0", "192.168.1.1", "192.168.1.62", "192.168.1.63", 62, false],
    ["192.168.1.64", "192.168.1.65", "192.168.1.126", "192.168.1.127", 62, true],
    ["192.168.1.128", "192.168.1.129", "192.168.1.190", "192.168.1.191", 62, false],
    ["192.168.1.192", "192.168.1.193", "192.168.1.254", "192.168.1.255", 62, false],
  ])) fail("splitSubnet /24 into /26", s);
  const links = splitSubnet("10.0.0.0", 29, 31);
  if (links.map((x) => `${x.first}-${x.last}:${x.hosts}`).join(" ") !== "10.0.0.0-10.0.0.1:2 10.0.0.2-10.0.0.3:2 10.0.0.4-10.0.0.5:2 10.0.0.6-10.0.0.7:2") fail("splitSubnet /31 links", links);
  const top = splitSubnet("255.255.255.255", 24, 32);
  if (top.length !== 256 || top.at(-1).network !== "255.255.255.255" || !top.at(-1).mine) fail("splitSubnet top of the range", top.at(-1));
}
// ---- a range as CIDR blocks: exactly the range, in order, each aligned to
// its size, and as few as can be (no two neighbours of one size that a block
// twice as big, aligned, would take as one).
const num = (ip) => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
for (let t = 0; t < 3000; t++) {
  const a = rnd(65536) * 65536 + rnd(65536);
  const span = [rnd(4), rnd(300), rnd(70000), rnd(65536) * rnd(65536)][t % 4];
  const b = Math.min(2 ** 32 - 1, a + span);
  const blocks = rangeToCidrs(dot(BigInt(b)), dot(BigInt(a)));
  let at = a;
  for (const [i, x] of blocks.entries()) {
    const n = num(x.network);
    if (n !== at || x.size !== 2 ** (32 - x.prefix) || n % x.size !== 0) fail("rangeToCidrs block", dot(BigInt(a)), dot(BigInt(b)), x);
    const next = blocks[i + 1];
    if (next && next.size === x.size && n % (x.size * 2) === 0) fail("rangeToCidrs not fewest", dot(BigInt(a)), dot(BigInt(b)), x, next);
    at = n + x.size;
  }
  if (at !== b + 1) fail("rangeToCidrs cover", dot(BigInt(a)), dot(BigInt(b)), at);
}
for (const [from, to, want] of [
  ["10.0.0.5", "10.0.0.20", "10.0.0.5/32 10.0.0.6/31 10.0.0.8/29 10.0.0.16/30 10.0.0.20/32"],
  ["192.168.1.0", "192.168.1.255", "192.168.1.0/24"],
  ["10.0.0.0", "10.0.3.255", "10.0.0.0/22"],
  ["10.0.0.7", "10.0.0.7", "10.0.0.7/32"],
  ["0.0.0.0", "255.255.255.255", "0.0.0.0/0"],
  ["255.255.255.254", "255.255.255.255", "255.255.255.254/31"],
]) {
  const got = rangeToCidrs(from, to).map((x) => `${x.network}/${x.prefix}`).join(" ");
  if (got !== want) fail("rangeToCidrs", from, to, got);
}
if (rangeToCidrs("0.0.0.1", "255.255.255.254").length !== 62) fail("rangeToCidrs widest", rangeToCidrs("0.0.0.1", "255.255.255.254").length);
// ---- IPv6: canonical form (RFC 5952 section 4 and its examples), round trips,
// kinds, subnets, and what is refused.
for (const [text, want] of [
  ["2001:0db8:0000:0000:0000:0000:0002:0001", "2001:db8::2:1"],
  ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"], // two runs of two: the first
  ["2001:0:0:1:0:0:0:1", "2001:0:0:1::1"], // the longest run
  ["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"], // one zero group stays
  ["2001:DB8::ABCD", "2001:db8::abcd"],
  ["0:0:0:0:0:0:0:1", "::1"],
  ["::", "::"],
  ["fe80::0001", "fe80::1"],
  ["1:0:0:0:0:0:0:0", "1::"],
  ["::ffff:10.0.0.1", "::ffff:10.0.0.1"],
  ["0:0:0:0:0:ffff:a00:1", "::ffff:10.0.0.1"],
  ["1:2:3:4:5:6:7::", "1:2:3:4:5:6:7:0"],
]) {
  const n = parseIpv6(text);
  if (n === null || formatIpv6(n) !== want) fail("formatIpv6", text, n === null ? null : formatIpv6(n));
}
for (const bad of ["1.2.3.4", "1::2::3", "12345::", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7", ":1", "1:", "g::1", "::ffff:1.2.3.256", "fe80::1%eth0", "[::1]"]) {
  if (parseIpv6(bad) !== null) fail("parseIpv6 refuses", bad);
}
for (let t = 0; t < 3000; t++) {
  // Random groups, many of them zero, so every compression case comes up.
  const g = Array.from({ length: 8 }, () => (rnd(3) ? 0 : rnd(65536)));
  const n = g.reduce((a, x) => (a << 16n) | BigInt(x), 0n);
  const short = formatIpv6(n);
  if (parseIpv6(short) !== n || parseIpv6(expandIpv6(n)) !== n) fail("ipv6 round trip", g, short);
  if (/(^|:)0[0-9a-f]/.test(short) || /[A-F]/.test(short) || (short.match(/::/g) ?? []).length > 1) fail("ipv6 canonical", short);
  // "::" only where it replaces two or more zero groups.
  if (short.includes("::") && n >> 32n !== 0xffffn) {
    const shown = short.split("::").map((h) => (h ? h.split(":").length : 0)).reduce((a, b) => a + b, 0);
    if (8 - shown < 2) fail("ipv6 :: for one group", short);
  }
}
for (const [text, kind] of [
  ["::", "지정되지 않은 주소 (::)"],
  ["::1", "루프백 (::1)"],
  ["fe80::1", "링크 로컬 (fe80::/10)"],
  ["febf::1", "링크 로컬 (fe80::/10)"],
  ["fd12:3456::1", "고유 로컬 (ULA, fc00::/7)"],
  ["ff02::1", "멀티캐스트"],
  ["2001:db8::1", "문서용 (2001:db8::/32)"],
  ["2400:cb00::1", "글로벌 유니캐스트"],
  ["::ffff:10.0.0.1", "IPv4 매핑 주소"],
  ["100::1", "특수 용도 (예약)"],
]) {
  if (ipv6Kind(parseIpv6(text)) !== kind) fail("ipv6Kind", text, ipv6Kind(parseIpv6(text)));
}
{
  const s = ipv6Subnet(parseIpv6("2001:db8:abcd:12::1"), 56);
  if (formatIpv6(s.network) !== "2001:db8:abcd::" || formatIpv6(s.last) !== "2001:db8:abcd:ff:ffff:ffff:ffff:ffff" || s.size !== 1n << 72n) fail("ipv6Subnet /56", formatIpv6(s.network), formatIpv6(s.last));
  const all = ipv6Subnet(parseIpv6("2001:db8::1"), 0);
  if (all.network !== 0n || formatIpv6(all.last) !== "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" || all.size !== 1n << 128n) fail("ipv6Subnet /0");
  const one = ipv6Subnet(parseIpv6("2001:db8::7"), 128);
  if (one.network !== one.last || one.size !== 1n) fail("ipv6Subnet /128");
}
for (const [text, want] of [
  ["2001:db8::1/64", "64"],
  ["2001:db8::1 / 48", "48"],
  ["2001:db8::1", "null"],
  ["2001:db8::1/129", "bad"],
  ["10.0.0.1/24", "bad"],
]) {
  const r = parseIpv6Input(text);
  if ((r ? String(r.prefix) : "bad") !== want) fail("parseIpv6Input", text, r);
}

// ---- several networks summarized: the exact list covers the same addresses
// as the input (compared as merged spans), in order, aligned, and as few as
// can be; the covering network holds them all and is the smallest that does.
const spansOf = (blocks) => {
  const s = blocks.map((b) => [num(b.network), num(b.network) + b.size - 1]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return JSON.stringify(out);
};
for (let t = 0; t < 1500; t++) {
  const base = rnd(256) * 2 ** 24 + rnd(256) * 2 ** 16;
  const nets = Array.from({ length: 2 + rnd(6) }, () => {
    const prefix = 16 + rnd(17);
    const size = 2 ** (32 - prefix);
    const at = Math.floor((base + rnd(65536)) / size) * size;
    return { ip: dot(BigInt(at)), prefix, network: dot(BigInt(at)), size };
  });
  const s = summarizeNetworks(nets);
  if (spansOf(s.exact) !== spansOf(nets)) fail("summarize exact covers", nets, s.exact);
  for (const [i, x] of s.exact.entries()) {
    const n = num(x.network);
    const next = s.exact[i + 1];
    if (n % x.size !== 0) fail("summarize aligned", x);
    if (next && next.size === x.size && n % (x.size * 2) === 0 && num(next.network) === n + x.size) fail("summarize not fewest", x, next);
  }
  const csize = 2 ** (32 - s.covering.prefix);
  const c0 = num(s.covering.network);
  if (!nets.every((x) => num(x.network) >= c0 && num(x.network) + x.size - 1 <= c0 + csize - 1)) fail("summarize covering holds", nets, s.covering);
  if (s.covering.prefix < 32) {
    const half = csize / 2;
    const lo = Math.min(...nets.map((x) => num(x.network)));
    const hi = Math.max(...nets.map((x) => num(x.network) + x.size - 1));
    if (Math.floor(lo / half) === Math.floor(hi / half)) fail("summarize covering smallest", nets, s.covering);
  }
  if (s.total + s.extra !== csize) fail("summarize counts", s.total, s.extra, csize);
}
{
  const s = summarizeNetworks(parseNetworkList("10.0.0.0/24, 10.0.1.0/24, 10.0.2.0/23"));
  if (s.exact.map((x) => `${x.network}/${x.prefix}`).join(" ") !== "10.0.0.0/22" || s.extra !== 0) fail("summarize /22", s);
  const g = summarizeNetworks(parseNetworkList("192.168.1.0/24; 192.168.3.0/24"));
  if (g.exact.length !== 2 || `${g.covering.network}/${g.covering.prefix}` !== "192.168.0.0/22" || g.extra !== 512) fail("summarize gap", g);
  const o = summarizeNetworks(parseNetworkList("10.0.0.0/16, 10.0.5.0/24, 10.0.0.7"));
  if (o.exact.map((x) => `${x.network}/${x.prefix}`).join(" ") !== "10.0.0.0/16" || o.total !== 65536) fail("summarize overlap", o);
  // The entries already inside another: by their networks, the larger one named.
  const cov = (text) => summarizeNetworks(parseNetworkList(text)).covered.map((c) => `${c.net}<${c.by}`).join(" ");
  if (cov("10.0.0.0/16, 10.0.5.0/24, 10.0.0.7") !== "10.0.5.0/24<10.0.0.0/16 10.0.0.7<10.0.0.0/16") fail("covered nested", cov("10.0.0.0/16, 10.0.5.0/24, 10.0.0.7"));
  // The same network twice: the later one; "10.0.5.9/24" is the network 10.0.5.0/24.
  if (cov("10.0.5.0/24, 10.0.5.9/24") !== "10.0.5.9/24<10.0.5.0/24") fail("covered duplicate", cov("10.0.5.0/24, 10.0.5.9/24"));
  // Neighbours that only merge are inside none.
  if (cov("10.0.0.0/24, 10.0.1.0/24, 10.0.2.0/23") !== "") fail("covered neighbours", cov("10.0.0.0/24, 10.0.1.0/24, 10.0.2.0/23"));
  if (cov("10.0.5.0/24, 10.0.0.0/8") !== "10.0.5.0/24<10.0.0.0/8") fail("covered later larger", cov("10.0.5.0/24, 10.0.0.0/8"));
  // Against a plain pairwise look over random lists: the same entries found inside another.
  for (let k = 0; k < 300; k++) {
    const nets = Array.from({ length: 2 + rnd(12) }, () => ({ ip: dot(BigInt(rnd(4) * 256 + rnd(256)) + (10n << 24n)), prefix: 20 + rnd(13) }));
    const blocks = nets.map(({ ip, prefix }) => { const size = 2 ** (32 - prefix); const first = Math.floor(num(ip) / size) * size; return { first, last: first + size - 1, size }; });
    const want = blocks.map((x, i) => blocks.some((y, j) => j !== i && y.first <= x.first && x.last <= y.last && (y.size > x.size || j < i)));
    // As lists: the same text typed twice is two entries (the later one inside).
    const got = summarizeNetworks(nets).covered.map((c) => c.net).sort().join(" ");
    const typed = nets.map(({ ip, prefix }) => (prefix === 32 ? ip : `${ip}/${prefix}`));
    const expected = typed.filter((_, i) => want[i]).sort().join(" ");
    if (got !== expected) fail("covered vs pairwise", nets, got, expected);
  }
  // A pasted table of thousands: one pass, quickly.
  {
    const many = Array.from({ length: 20000 }, (_, i) => ({ ip: dot(BigInt(i * 256) + (10n << 24n)), prefix: 24 }));
    const t0 = Date.now();
    summarizeNetworks([...many, { ip: "10.0.0.0", prefix: 8 }]);
    if (Date.now() - t0 > 2000) fail("covered of 20000 slow", Date.now() - t0);
  }
}
for (const [text, n] of [
  ["10.0.0.0/24, 10.0.1.0/24", 2],
  ["10.0.0.0/24 10.0.1.0/24", 2],
  ["10.0.0.1, 10.0.0.2", 2],
  ["10.0.0.0/24\n10.0.1.0/24\n10.0.2.0/24", 3],
  ["10.0.0.5 255.255.255.0", null],
  ["10.0.0.1 10.0.0.2", null],
  ["10.0.0.0/24", null],
  ["10.0.0.0/33, 10.0.1.0/24", null],
  ["10.0.0.0/24, host", null],
  // Separators at the ends separate nothing; a single network is not a list.
  ["10.0.0.0/24, 10.0.1.0/24,", 2],
  [", 10.0.0.0/24; 10.0.1.0/24 ;", 2],
  ["10.0.0.0/24,", null],
  [",,", null],
  // Commas and spaces mixed; an address with its mask or wildcard between commas.
  ["10.0.0.0/24, 10.0.1.0/24 10.0.2.0/24", 3],
  ["10.0.0.5 255.255.255.0, 10.0.1.0/24", 2],
  ["10.0.0.5 0.0.0.255; 10.0.1.0/24", 2],
  ["10.0.0.1 10.0.0.2, 10.0.1.0/24", null], // bare addresses with only a space between: not read
  ["10.0.0.5 255.255.0.255, 10.0.1.0/24", null], // not a mask
  // A mask alone is the mask of the bare address before it (a pasted column).
  ["10.0.0.5, 255.255.255.0, 10.0.1.0/24", 2],
  ["10.0.0.5, 255.255.255.0", null], // one network: not a list
  ["10.0.0.0/24, 255.255.255.0, 10.0.1.0/24", null], // after a network with a prefix: not read
  ["255.255.255.0, 10.0.1.0/24", null],
]) {
  const got = parseNetworkList(text);
  if ((got?.length ?? null) !== n) fail("parseNetworkList", text, got);
}
{
  const got = parseNetworkList("10.0.0.5 255.255.255.0, 10.0.1.0/24")?.[0];
  if (got?.ip !== "10.0.0.5" || got.prefix !== 24) fail("parseNetworkList mask entry", "10.0.0.5 255.255.255.0", got);
  const mixed = parseNetworkList("10.0.0.0/24, 10.0.1.0/24 10.0.2.0/23")?.map((x) => `${x.ip}/${x.prefix}`).join(" ");
  if (mixed !== "10.0.0.0/24 10.0.1.0/24 10.0.2.0/23") fail("parseNetworkList mixed order", mixed);
  for (const [text, want] of [[" 10.0.0.0/24, ", "10.0.0.0/24"], [";10.0.0.5-10.0.0.9;", "10.0.0.5-10.0.0.9"], ["2001:db8::1/64,", "2001:db8::1/64"], ["a, b", "a, b"]])
    if (trimSeparators(text) !== want) fail("trimSeparators", text, trimSeparators(text));
}
// A range's addresses for an IP scan: every one, ends included, any order,
// none past the limit (the backend's own, nettools.rs RANGE_SWEEP_MAX).
{
  const a = rangeAddresses("10.0.0.250", "10.0.1.5");
  if (a?.length !== 12 || a[0] !== "10.0.0.250" || a[6] !== "10.0.1.0" || a[11] !== "10.0.1.5") fail("rangeAddresses across an octet", a);
  if (rangeAddresses("10.0.0.20", "10.0.0.5")?.length !== 16) fail("rangeAddresses reversed");
  if (rangeAddresses("10.0.0.0", "10.0.3.255")?.length !== 1024) fail("rangeAddresses 1024");
  if (rangeAddresses("10.0.0.0", "10.0.4.0") !== null) fail("rangeAddresses past the limit");
  if (rangeAddresses("255.255.255.250", "255.255.255.255")?.at(-1) !== "255.255.255.255") fail("rangeAddresses top");
}
for (const [text, want] of [
  ["10.0.0.5 - 10.0.0.20", "10.0.0.5-10.0.0.20"],
  ["10.0.0.20–10.0.0.5", "10.0.0.5-10.0.0.20"],
  ["10.0.0.5 ~ 10.0.0.20", "10.0.0.5-10.0.0.20"],
  ["10.0.0.5", null],
  ["10.0.0.5/24", null],
  ["10.0.0.5 - 10.0.0.256", null],
  ["10.0.0.5 - host", null],
]) {
  const r = parseRangeInput(text);
  if ((r ? `${r.from}-${r.to}` : null) !== want) fail("parseRangeInput", text, r);
}
for (const text of ["10.0.0.1/33", "10.0.0.1 255.0.255.0", "10.0.0.256", "10.0.0.1/24 x", "host"]) {
  const s = parseSubnetInput(text);
  if (s && s.prefix !== null) fail("not a subnet", text, s);
}

// ---- addresses in output, with the prefix written after them
for (const [line, ip, prefix] of [
  ["ip address 10.1.2.3 255.255.255.0", "10.1.2.3", 24],
  ["inet 192.168.1.5/24 brd 192.168.1.255", "192.168.1.5", 24],
  ["access-list 10 permit 10.0.0.0 0.0.255.255", "10.0.0.0", 16],
  ["inet 10.0.0.5 netmask 0xffffff00 broadcast 10.0.0.255", "10.0.0.5", 24],
  // route -n: the mask column is the destination's, not the gateway's.
  ["0.0.0.0         10.0.0.1        0.0.0.0         UG    0", "10.0.0.1", null],
]) {
  const m = findIps(line).find((x) => x.ip === ip);
  if (!m || m.prefix !== prefix) fail("findIps", line, m);
}

// Masks, wildcards and 0.x are not hosts: only the real addresses are links.
for (const [line, ips] of [
  ["access-list 10 permit 10.0.0.0 0.0.255.255", ["10.0.0.0"]],
  [" network 10.1.0.0 0.0.0.255 area 0", ["10.1.0.0"]],
  ["ip route 0.0.0.0 0.0.0.0 192.168.1.1", ["192.168.1.1"]],
  [" ip address 10.0.0.1 255.255.255.0", ["10.0.0.1"]],
]) {
  const got = findIps(line).map((m) => m.ip);
  if (JSON.stringify(got) !== JSON.stringify(ips)) fail("findIps hosts only", line, got);
}

// Masks and wildcards: found as such, and the same prefix the three ways.
for (const [line, prefixes] of [
  ["access-list 10 permit 10.0.0.0 0.0.255.255", [16]],
  [" ip address 10.0.0.1 255.255.255.0", [24]],
  ["ip route 0.0.0.0 0.0.0.0 192.168.1.1", []],
  ["255.0.255.0 0.255.0.255 version 255.1", []],
  ["Genmask 255.255.255.255 and 0.0.0.3", [32, 30]],
]) {
  const got = findMasks(line).map((m) => m.prefix);
  if (JSON.stringify(got) !== JSON.stringify(prefixes)) fail("findMasks", line, got);
}
for (let p = 0; p <= 32; p++) {
  const f = maskForms(p);
  const back = [f.netmask, f.wildcard].map((s) => parseSubnetInput(`10.0.0.0 ${s}`)?.prefix);
  // A wildcard is read back as one from /8 on (it must start "0."); a /0
  // netmask is 0.0.0.0, which is no mask.
  if (f.slash !== `/${p}` || (p > 0 && back[0] !== p) || (p >= 8 && p < 32 && back[1] !== p)) fail("maskForms", p, f, back);
}

// Data rates: written with a bit-rate unit and four digits or more, read in SI units.
for (const [line, want] of [
  ["  5 minute input rate 123456000 bits/sec, 1234 packets/sec", ["123.46 Mbit/s"]],
  ["  MTU 1500 bytes, BW 1000000 Kbit/sec, DLY 10 usec,", ["1 Gbit/s"]],
  ["  30 second output rate 0 bits/sec, 0 packets/sec", []],
  ["rate 8000 bps and 1.5 Gbps, 100 Mbps", ["8 kbit/s"]],
  ["rx 500 B/s 1200 bytes/sec 9999 packets/sec", []],
]) {
  const got = findRates(line).map((r) => readableRate(r.bitsPerSecond));
  if (JSON.stringify(got) !== JSON.stringify(want)) fail("findRates", line, got);
}

// Uptimes: seconds, whether a year (of unstated length) is in it, and the duration's text.
for (const [line, want] of [
  ["R1 uptime is 1 year, 2 weeks, 3 days, 4 hours, 5 minutes", [[(365 + 14 + 3) * 86400 + 4 * 3600 + 300, true, "1 year, 2 weeks, 3 days, 4 hours, 5 minutes"]]],
  ["SW1 uptime is 1 hour, 1 minute", [[3660, false, "1 hour, 1 minute"]]],
  ["Kernel uptime is 12 day(s), 3 hour(s), 4 minute(s), 5 second(s)", [[12 * 86400 + 3 * 3600 + 245, false, "12 day(s), 3 hour(s), 4 minute(s), 5 second(s)"]]],
  [" 10:22:01 up 12 days,  3:04,  2 users,  load average: 0.00, 0.01, 0.05", [[12 * 86400 + 184 * 60, false, "12 days,  3:04"]]],
  ["top - 10:22:01 up 5 min,  1 user,  load average: 0.10, 0.05, 0.01", [[300, false, "5 min"]]],
  [" 08:00:00 up 1 day, 12 min,  3 users,  load average: 1.00, 1.00, 1.00", [[86400 + 720, false, "1 day, 12 min"]]],
  [" 08:00:00 up 3:04,  1 user,  load average: 0.00", [[184 * 60, false, "3:04"]]],
  ["System uptime is 3 weeks 6 days 19 hours 21 minutes", [[27 * 86400 + 19 * 3600 + 21 * 60, false, "3 weeks 6 days 19 hours 21 minutes"]]],
  ["link went up 3:04 ago", []],
  ["uptime is unknown", []],
]) {
  const got = findUptimes(line).map((u) => [u.seconds, u.approximate, line.slice(u.index, u.index + u.length)]);
  if (JSON.stringify(got) !== JSON.stringify(want)) fail("findUptimes", line, got);
}

// An interface's description, the newest the output gives, from each IOS form.
{
  const gi = new RegExp(`^(?:${interfaceSearchPattern(0, "1/0/1")})$`, "i");
  const cases = [
    ["config", ["interface GigabitEthernet1/0/1", " switchport mode trunk", " description Uplink to core", "!", "interface GigabitEthernet1/0/2", " description Printer"], "Uplink to core"],
    ["config, another port's", ["interface GigabitEthernet1/0/2", " description Printer", "!"], null],
    ["config, a longer number", ["interface GigabitEthernet1/0/11", " description Not this one"], null],
    ["show interfaces", ["GigabitEthernet1/0/1 is up, line protocol is up (connected)", "  Hardware is Gigabit Ethernet, address is 0011.2233.4455", "  Description: AP-3F-East", "  MTU 1500 bytes"], "AP-3F-East"],
    ["show interfaces, another block", ["GigabitEthernet1/0/2 is up, line protocol is up", "  Description: Camera", "GigabitEthernet1/0/1 is down, line protocol is down", "  MTU 1500 bytes"], null],
    ["description table", ["Interface                      Status         Protocol Description", "Gi1/0/1                        up             up       Server rack 2", "Gi1/0/2                        admin down     down     Spare"], "Server rack 2"],
    ["table row with none", ["interface GigabitEthernet1/0/1", " description Old", "!", "Interface                      Status         Protocol Description", "Gi1/0/1                        down           down"], null],
    ["table ends at the prompt", ["Interface                      Status         Protocol Description", "Gi1/0/2                        up             up       Spare", "SW1#show ip interface brief", "Gi1/0/1                10.0.0.1        YES manual up                    up"], null],
    ["newest wins", ["interface GigabitEthernet1/0/1", " description Old name", "!", "GigabitEthernet1/0/1 is up, line protocol is up", "  Description: New name"], "New name"],
    ["config indented by two", ["interface GigabitEthernet1/0/1", "  description Two spaces", "", "interface GigabitEthernet1/0/2"], "Two spaces"],
    ["admin state line in the block", ["GigabitEthernet1/0/1 is up", "admin state is up, Dedicated Interface", "  Hardware: 1000/10000 Ethernet, address: 0011.2233.4455", "  Description: After admin state"], "After admin state"],
  ];
  for (const [name, lines, want] of cases) {
    const got = interfaceDescription(lines, gi);
    if (got !== want) fail("interfaceDescription", name, got);
  }
}

// The device a port leads to, the newest CDP or LLDP gives, from each IOS form.
{
  const gi = new RegExp(`^(?:${interfaceSearchPattern(0, "1/0/1")})$`, "i");
  const cdpHead = "Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID";
  const lldpHead = "Device ID           Local Intf     Hold-time  Capability      Port ID";
  // A row laid out under its header's columns, as the device prints it.
  const row = (head, ...cells) => {
    const at = [0, ...[...head.matchAll(/ {2,}(?=\S)/g)].map((m) => m.index + m[0].length)];
    return cells.reduce((s, c, i) => (i === 0 ? c : s.padEnd(at[i] ?? s.length + 1) + c), "");
  };
  const cdp = (...c) => row(cdpHead, ...c);
  const lldpRow = (...c) => row(lldpHead, ...c);
  const cases = [
    ["cdp table", [cdpHead, cdp("SW2", "Gig 1/0/1", "150", "S I", "WS-C3850-", "Gig 1/0/48"), cdp("SW3", "Gig 1/0/2", "150", "S I", "WS-C3850-", "Gig 1/0/47")], { device: "SW2", port: "Gig 1/0/48" }],
    ["cdp table, long name wrapped", [cdpHead, "core-switch-01.corp.local", cdp("", "Gig 1/0/1", "150", "R S I", "C9300-48P", "Ten 1/1/1")], { device: "core-switch-01.corp.local", port: "Ten 1/1/1" }],
    ["cdp table, another port", [cdpHead, cdp("SW3", "Gig 1/0/11", "150", "S I", "WS-C3850-", "Gig 1/0/47")], null],
    ["cdp table, a phone's and an AP's port", [cdpHead, cdp("SEP001122334455", "Gig 1/0/2", "150", "H P M", "IP Phone", "Port 1"), cdp("AP01", "Gig 1/0/1", "150", "T B I", "AIR-AP280", "Gig 0")], { device: "AP01", port: "Gig 0" }],
    // A Platform value one character too long: the port's first letter is
    // under the Platform column, and still read with it.
    ["cdp table, a port starting a column early", [cdpHead, cdp("SEP001122334455", "Gig 1/0/1", "150", "H P M", "IP Phone").padEnd(cdpHead.indexOf("Port ID") - 1) + "Port 1"], { device: "SEP001122334455", port: "Port 1" }],
    ["cdp table, a local port of another kind", [cdpHead, cdp("mgmtsw(FOC1)", "mgmt0", "179", "S I", "WS-C2960", "Gig 0/1")], null],
    ["lldp table, a server's port", [lldpHead, lldpRow("esxi01", "Gi1/0/1", "120", "B", "eth0"), "", "Total entries displayed: 1"], { device: "esxi01", port: "eth0" }],
    // A device name filling its 20-character column, the local port right after it.
    ["lldp table, a name filling its column", [lldpHead, "core-sw3.corp.locall" + lldpRow("", "Gi1/0/1", "120", "B", "Gi1/0/9").slice(20)], { device: "core-sw3.corp.locall", port: "Gi1/0/9" }],
    ["table ends at the prompt", [cdpHead, cdp("SW2", "Gig 1/0/2", "150", "S I", "WS-C3850-", "Gig 1/0/48"), "SW1#show ip interface brief", "GigabitEthernet1/0/1   10.0.0.1  YES manual up  up"], null],
    ["cdp detail", ["Device ID: SW2.corp.local", "Entry address(es):", "  IP address: 10.0.0.2", "Platform: cisco WS-C3850-48P,  Capabilities: Switch IGMP", "Interface: GigabitEthernet1/0/1,  Port ID (outgoing port): GigabitEthernet1/0/48"], { device: "SW2.corp.local", port: "GigabitEthernet1/0/48" }],
    ["cdp detail, another port", ["Device ID: SW2", "Interface: GigabitEthernet1/0/2,  Port ID (outgoing port): GigabitEthernet1/0/48"], null],
    ["lldp detail", ["Local Intf: Gi1/0/1", "Chassis id: 0011.2233.4455", "Port id: Gi1/0/48", "Port Description: GigabitEthernet1/0/48", "System Name: SW2"], { device: "SW2", port: "Gi1/0/48" }],
    ["newest wins", ["Device ID: OLD", "Interface: GigabitEthernet1/0/1,  Port ID (outgoing port): Gi0/1", cdpHead, cdp("NEW", "Gig 1/0/1", "150", "S I", "WS-C3850-", "Gig 1/0/9")], { device: "NEW", port: "Gig 1/0/9" }],
  ];
  for (const [name, lines, want] of cases) {
    const got = interfaceNeighbor(lines, gi);
    if (JSON.stringify(got) !== JSON.stringify(want)) fail("interfaceNeighbor", name, got);
  }
}

// The VLAN a port is in, as "show vlan brief" or "show interfaces status" gives it (the newest table).
{
  const gi = new RegExp(`^(?:${interfaceSearchPattern(0, "1/0/5")})$`, "i");
  const head = "VLAN Name                             Status    Ports";
  const rule = "---- -------------------------------- --------- -------------------------------";
  // "show interfaces status": its columns, and a row laid out under them.
  const sHead = "Port      Name               Status       Vlan       Duplex  Speed Type";
  const sAt = ["Name", "Status", "Vlan", "Duplex", "Speed", "Type"].map((w) => sHead.indexOf(w));
  const sRow = (p, name, st, vlan) => [p, name, st, vlan, "a-full", "a-1000", "10/100/1000BaseTX"].reduce((s, cell, i) => (i === 0 ? cell : s.padEnd(sAt[i - 1]) + cell), "");
  const cases = [
    ["listed on its row's line", [head, rule, "1    default                          active    Gi1/0/1, Gi1/0/2", "10   USERS                            active    Gi1/0/3, Gi1/0/5"], { id: 10, name: "USERS", trunk: false, state: null }],
    ["listed on a line going on", [head, rule, "1    default                          active    Gi1/0/1", "20   VOICE                            active    Gi1/0/3, Gi1/0/4,", "                                                Gi1/0/5, Gi1/0/6"], { id: 20, name: "VOICE", trunk: false, state: null }],
    ["a longer number is another port", [head, rule, "30   CAMERAS                          active    Gi1/0/50, Gi1/0/51"], null],
    ["a trunk port is in no list", [head, rule, "1    default                          active    Gi1/0/1"], null],
    ["the table ends at the prompt", [head, rule, "1    default                          active    Gi1/0/1", "SW1#", "                                                Gi1/0/5"], null],
    ["the newest table decides", [head, rule, "10   USERS                            active    Gi1/0/5", "", head, rule, "40   GUEST                            active    Gi1/0/5"], { id: 40, name: "GUEST", trunk: false, state: null }],
    ["moved off in the newest", [head, rule, "10   USERS                            active    Gi1/0/5", "", head, rule, "10   USERS                            active    Gi1/0/6"], null],
    ["status table: access", [sHead, sRow("Gi1/0/4", "AP-3F", "connected", "10"), sRow("Gi1/0/5", "Printer", "connected", "20")], { id: 20, name: null, trunk: false, state: "connected" }],
    ["status table: trunk", [sHead, sRow("Gi1/0/5", "uplink", "connected", "trunk")], { id: null, name: null, trunk: true, state: "connected" }],
    ["status table: err-disabled", [sHead, sRow("Gi1/0/5", "cam", "err-disabled", "30")], { id: 30, name: null, trunk: false, state: "err-disabled" }],
    ["status table: routed", [head, rule, "10   USERS                            active    Gi1/0/5", "", sHead, sRow("Gi1/0/5", "", "connected", "routed")], null],
    ["status table, named by vlan brief", [head, rule, "30   CAMERAS                          active    Gi1/0/9", "", sHead, sRow("Gi1/0/5", "cam", "connected", "30")], { id: 30, name: "CAMERAS", trunk: false, state: "connected" }],
    ["status table without the port says nothing", [head, rule, "10   USERS                            active    Gi1/0/5", "", sHead, sRow("Gi1/0/6", "", "notconnect", "1")], { id: 10, name: "USERS", trunk: false, state: null }],
    // The VLAN a column early (a value before it one character too long):
    // still read whole, not "00".
    ["status table, a VLAN starting a column early", [sHead, ("Gi1/0/5".padEnd(sAt[0]) + "uplink").padEnd(sAt[1]) + "connected".padEnd(sAt[2] - 1 - sAt[1]) + "300".padEnd(sAt[3] - sAt[2] + 1) + "a-full"], { id: 300, name: null, trunk: false, state: "connected" }],
    ["a longer number in the status table", [sHead, sRow("Gi1/0/50", "", "connected", "99")], null],
    // NX-OS rules the header off with dashes before the rows.
    ["status table with a rule line (NX-OS)", [sHead, "-".repeat(sHead.length), sRow("Gi1/0/5", "--", "connected", "10")], { id: 10, name: null, trunk: false, state: "connected" }],
    // A later vlan brief lists no trunk port: the trunk stays known.
    ["a trunk, then a vlan brief", [sHead, sRow("Gi1/0/5", "uplink", "connected", "trunk"), "", head, rule, "1    default                          active    Gi1/0/1"], { id: null, name: null, trunk: true, state: "connected" }],
  ];
  for (const [name, lines, want] of cases) {
    const got = interfaceVlan(lines, gi);
    if (JSON.stringify(got) !== JSON.stringify(want)) fail("interfaceVlan", name, got);
  }
}

// The bandwidth a rate is a share of: its own "show interfaces" block only.
{
  const out = [
    "GigabitEthernet1/0/1 is up, line protocol is up (connected)",
    "  Hardware is Gigabit Ethernet, address is 0011.2233.4455",
    "  MTU 1500 bytes, BW 1000000 Kbit/sec, DLY 10 usec,",
    "  5 minute input rate 123456000 bits/sec, 1234 packets/sec",
    "GigabitEthernet1/0/2 is down, line protocol is down (notconnect)",
    "  5 minute input rate 4000 bits/sec, 0 packets/sec",
    "random text",
    "  5 minute input rate 9000 bits/sec",
  ];
  const got = [3, 5, 7].map((i) => bandwidthAbove((k) => out[k], i));
  if (JSON.stringify(got) !== JSON.stringify([1e9, null, null])) fail("bandwidthAbove", got);
}

// ---- address kinds
for (const [ip, kind] of [
  ["10.1.2.3", "사설 (RFC 1918)"],
  ["172.31.255.255", "사설 (RFC 1918)"],
  ["172.32.0.1", "공인"],
  ["100.64.0.1", "공유 주소 (CGNAT, RFC 6598)"],
  ["100.128.0.1", "공인"],
  ["127.0.0.1", "루프백"],
  ["169.254.10.1", "링크 로컬 (APIPA)"],
  ["224.0.0.5", "멀티캐스트"],
  ["192.0.2.1", "특수 용도 (예약)"],
  ["8.8.8.8", "공인"],
]) {
  if (addressKind(ip) !== kind) fail("addressKind", ip, addressKind(ip));
}
for (const [text, kind] of [
  ["ffff.ffff.ffff", "브로드캐스트 주소"],
  ["0000.0c07.ac0a", "HSRP 가상 MAC (그룹 10)"],
  ["0000.0c07.acff", "HSRP 가상 MAC (그룹 255)"],
  ["0000.0c9f.f0c8", "HSRP v2 가상 MAC (그룹 200)"],
  ["00:00:5e:00:01:01", "VRRP 가상 MAC (VRID 1)"],
  ["00-00-5E-00-02-FF", "VRRP IPv6 가상 MAC (VRID 255)"],
  ["01:80:c2:00:00:00", "스패닝 트리(STP) 주소"],
  ["01:80:c2:00:00:02", "LACP 주소 (슬로우 프로토콜)"],
  ["01:80:c2:00:00:03", "802.1X(EAPOL) 주소"],
  ["01:80:c2:00:00:0e", "LLDP 주소"],
  ["01:80:c2:00:00:05", "IEEE 802.1 예약 주소"],
  ["01:80:c2:00:00:10", "멀티캐스트 주소"],
  ["0100.0ccc.cccc", "CDP·VTP·DTP 주소 (Cisco)"],
  ["0100.0ccc.cccd", "PVST+ 주소 (Cisco)"],
  ["01:00:5e:00:00:05", "IPv4 멀티캐스트 주소"],
  ["01:00:5e:80:00:05", "멀티캐스트 주소"],
  ["33:33:00:00:00:01", "IPv6 멀티캐스트 주소"],
  ["02:42:ac:11:00:02", "로컬 관리 주소 (가상 머신·무작위 MAC일 수 있음)"],
  ["00:1a:2b:3c:4d:5e", null],
]) {
  const [m] = findMacs(`x ${text} y`);
  if (!m) fail("findMacs", text);
  else if (macKind(m.hex) !== kind) fail("macKind", text, macKind(m.hex));
}

// ---- A MAC's modified EUI-64 link-local IPv6 address (RFC 4291 A): U/L bit
// flipped, ff:fe in the middle, written as RFC 5952 says; none for a group address
for (const [hex, want] of [
  ["005056abcdef", "fe80::250:56ff:feab:cdef"],
  ["020000000001", "fe80::ff:fe00:1"], // the zero first group joins "::"
  ["001122330000", "fe80::211:22ff:fe33:0"], // one zero group is not "::"
  ["fc0000000000", "fe80::fe00:ff:fe00:0"],
  ["0242ac110002", "fe80::42:acff:fe11:2"], // a Docker MAC: U/L set, so cleared
  ["01005e000005", null],
  ["ffffffffffff", null],
  ["333300000001", null],
]) {
  if (macLinkLocal(hex) !== want) fail("macLinkLocal", hex, macLinkLocal(hex));
  const listed = macFormats(hex).find((f) => f.style === "EUI-64 링크 로컬 IPv6")?.text ?? null;
  if (listed !== want) fail("macFormats EUI-64", hex, listed);
}
// The notations other code picks by position stay where they were.
if (macFormats("005056abcdef")[0].text !== "00:50:56:ab:cd:ef" || macFormats("005056abcdef")[2].text !== "0050.56ab.cdef") fail("macFormats order", "005056abcdef");

// ---- An IPv6 network split into longer prefixes: in order, contiguous, each
// the same size, together exactly the whole, the typed address's part marked
{
  const v6 = (t) => parseIpv6(t);
  const cases = [
    ["2001:db8:abcd:12::1", 48, 56, 256, "2001:db8:abcd::/56", "2001:db8:abcd:ff00::/56", "2001:db8:abcd::/56"],
    ["2001:db8:abcd:12::1", 56, 64, 256, "2001:db8:abcd::/64", "2001:db8:abcd:ff::/64", "2001:db8:abcd:12::/64"],
    ["2001:db8::ffff", 64, 66, 4, "2001:db8::/66", "2001:db8:0:0:c000::/66", "2001:db8::/66"],
    ["fe80::1", 126, 128, 4, "fe80::/128", "fe80::3/128", "fe80::1/128"],
    ["::", 0, 1, 2, "::/1", "8000::/1", "::/1"],
  ];
  for (const [addr, prefix, into, count, first, last, mine] of cases) {
    const n = v6(addr);
    const parts = splitIpv6(n, prefix, into);
    const name = `${addr}/${prefix} into /${into}`;
    if (!parts || parts.length !== count) { fail("splitIpv6 count", name, parts?.length); continue; }
    const fmt = (p) => `${formatIpv6(p.network)}/${into}`;
    if (fmt(parts[0]) !== first || fmt(parts.at(-1)) !== last) fail("splitIpv6 ends", name, `${fmt(parts[0])} … ${fmt(parts.at(-1))}`);
    const marked = parts.filter((p) => p.mine);
    if (marked.length !== 1 || fmt(marked[0]) !== mine) fail("splitIpv6 mine", name, marked.map(fmt).join(","));
    const whole = ipv6Subnet(n, prefix);
    if (parts[0].network !== whole.network || parts.at(-1).last !== whole.last) fail("splitIpv6 whole", name);
    for (let i = 1; i < parts.length; i++)
      if (parts[i].network !== parts[i - 1].last + 1n || parts[i].last - parts[i].network !== parts[0].last - parts[0].network) { fail("splitIpv6 contiguous", name, i); break; }
  }
  // Not longer, more than 8 bits longer, or past /128: no split.
  for (const [prefix, into] of [[64, 64], [64, 63], [48, 57], [127, 129], [64, 64.5]]) if (splitIpv6(v6("2001:db8::"), prefix, into) !== null) fail("splitIpv6 refused", `${prefix} into ${into}`);
}

// ---- IPv6 addresses in output: found where they are, with a "/n" prefix;
// MACs, times, C++ names, "::" alone and longer runs are not
for (const [line, want] of [
  ["GigabitEthernet0/0 [up/up]  FE80::1  2001:DB8:0:1::1", ["FE80::1", "2001:DB8:0:1::1"]],
  ["    inet6 2001:db8:abcd:12::5/64 scope global", ["2001:db8:abcd:12::5/64"]],
  ["    inet6 fe80::250:56ff:feab:cdef%ens192/64 scope link", ["fe80::250:56ff:feab:cdef"]],
  ["2001:db8::/32 via fe80::1 dev eth0 metric 1024", ["2001:db8::/32", "fe80::1"]],
  ["::ffff:10.0.0.1 port 22", ["::ffff:10.0.0.1"]],
  ["ssh [2001:db8::7]:2222", ["2001:db8::7"]],
  ["::1/128 (loopback), 0:0:0:0:0:0:0:1", ["::1/128", "0:0:0:0:0:0:0:1"]],
  ["prefix 2001:db8::/200 is wrong", ["2001:db8::"]],
  // Punctuation right after: a reply's colon, a sentence's dot (review findings).
  ["Reply from ::1: time<1ms", ["::1"]],
  ["Reply from 2001:db8::1: time=3ms", ["2001:db8::1"]],
  ["Neighbor fe80::1: state Full", ["fe80::1"]],
  ["Address is 2001:db8::1.", ["2001:db8::1"]],
  ["   Default Gateway . . . . . . . . . : fe80::1%12", ["fe80::1"]],
  // Eight colon groups with "::" at either end.
  ["1:2:3:4:5:6:7:: and ::1:2:3:4:5:6:7", ["1:2:3:4:5:6:7::", "::1:2:3:4:5:6:7"]],
  // 8-byte IDs (Fibre Channel WWNs, EUI-64s): not addresses.
  ["fc1/1  20:00:00:25:b5:00:00:0f  21:00:00:24:ff:4c:aa:bb  00:12:4b:00:01:02:03:04", []],
  ["2001:db8::1.5 10::1x", []],
  // Linux netstat's tcp6/udp6 lines: the last group is the port (checked below).
  ["tcp6       0      0 ::1:631                 :::*                    LISTEN", ["::1:631"]],
  ["udp6       0      0 fe80::1:546             :::*", ["fe80::1:546"]],
  ["tcp6       0      0 :::22                   :::*                    LISTEN", []],
  // Elsewhere the same text is one address.
  ["route ::1:631 via x", ["::1:631"]],
  // An IPv4 tail in netstat: the port follows the dotted part.
  ["tcp6       0      0 ::ffff:10.0.0.5:22      ::ffff:10.0.0.9:51000 ESTABLISHED", ["::ffff:10.0.0.5:22", "::ffff:10.0.0.9:51000"]],
  ["00:50:56:ab:cd:ef  10:20:30  12:34:56.789  std::vector<int>  a::b  ::  1:2:3:4:5:6:7:8:9  2001:db8::1abcde  x2001:db8::1", []],
]) {
  const got = findIpv6s(line).map((m) => line.slice(m.index, m.index + m.length));
  if (got.join("|") !== want.join("|")) fail("findIpv6s", line, got.join("|"));
}
{
  const [m] = findIpv6s("route 2001:db8:5::/48 x");
  if (m?.ip !== "2001:db8:5::" || m.prefix !== 48) fail("findIpv6s prefix", "2001:db8:5::/48", JSON.stringify(m));
}

// ---- A session's host and an address: the same IPv6 address however written
for (const [host, ip, same] of [
  ["2001:db8::1", "2001:db8::1", true],
  ["2001:0DB8::1", "2001:db8::1", true],
  ["[2001:db8:0:0::1]", "2001:db8::1", true],
  ["  2001:db8:0:0:0:0:0:1 ", "2001:db8::1", true],
  ["::ffff:10.0.0.1", "::ffff:a00:1", true],
  ["2001:db8::2", "2001:db8::1", false],
  ["10.0.0.1", "::ffff:10.0.0.1", false], // IPv4 and its mapped form: different hosts to connect to
  ["SW-CORE-01", "sw-core-01", true],
  ["router.example.com", "10.0.0.1", false],
  ["10.0.0.01", "10.0.0.1", false], // an IPv4 name matches as written
  ["", "", true],
  ["fe80::1%12", "fe80::1", false],
]) {
  if (sameHost(host, ip) !== same) fail("sameHost", `${host} ~ ${ip}`, !same);
}
// The key alerts are kept under (deviceAlerts): one per device, as sameHost decides.
for (const [host, key] of [["[2001:0DB8::1]", "2001:db8::1"], [" SW-Core ", "sw-core"], ["10.0.0.1", "10.0.0.1"], ["::FFFF:10.0.0.1", "::ffff:10.0.0.1"]])
  if (hostKey(host) !== key) fail("hostKey", host, hostKey(host));
{
  const [m] = findIpv6s("tcp6       0      0 ::1:631                 :::*                    LISTEN");
  if (m?.ip !== "::1" || m.port !== 631) fail("findIpv6s netstat port", "::1:631", JSON.stringify(m));
  const [o] = findIpv6s("route ::1:631 via x");
  if (o?.ip !== "::1:631" || o.port !== null) fail("findIpv6s no port", "::1:631", JSON.stringify(o));
}

// ---- Reverse DNS names: in-addr.arpa (RFC 1035 3.5) and ip6.arpa (RFC 3596 2.5)
{
  const eq = (what, got, want) => got !== want && fail(what, want, got);
  eq("reverseName4", reverseName4("10.0.0.5"), "5.0.0.10.in-addr.arpa");
  eq("reverseName4", reverseName4("192.168.1.200"), "200.1.168.192.in-addr.arpa");
  eq("reverseZone4 /24", reverseZone4("10.1.2.0", 24), "2.1.10.in-addr.arpa");
  eq("reverseZone4 /16", reverseZone4("172.16.0.0", 16), "16.172.in-addr.arpa");
  eq("reverseZone4 /8", reverseZone4("10.0.0.0", 8), "10.in-addr.arpa");
  for (const p of [0, 7, 25, 26, 32]) eq(`reverseZone4 /${p}`, reverseZone4("10.0.0.0", p), null);
  // RFC 3596 2.5's own example.
  eq("reverseName6 (RFC 3596)", reverseName6(parseIpv6("4321:0:1:2:3:4:567:89ab")), "b.a.9.8.7.6.5.0.4.0.0.0.3.0.0.0.2.0.0.0.1.0.0.0.0.0.0.0.1.2.3.4.ip6.arpa");
  eq("reverseName6 ::1", reverseName6(parseIpv6("::1")), `1.${"0.".repeat(31)}ip6.arpa`);
  eq("reverseZone6 /32", reverseZone6(parseIpv6("2001:db8:abcd:12::1"), 32), "8.b.d.0.1.0.0.2.ip6.arpa");
  eq("reverseZone6 /56", reverseZone6(parseIpv6("2001:db8:abcd:12::1"), 56), "0.0.d.c.b.a.8.b.d.0.1.0.0.2.ip6.arpa");
  eq("reverseZone6 /64", reverseZone6(parseIpv6("2001:db8:abcd:12::1"), 64), "2.1.0.0.d.c.b.a.8.b.d.0.1.0.0.2.ip6.arpa");
  for (const p of [0, 50, 62, 127, 128]) eq(`reverseZone6 /${p}`, reverseZone6(parseIpv6("2001:db8::1"), p), null);
  // A zone is the leading labels of every name in its network.
  for (let i = 0; i < 200; i++) {
    const n = BigInt.asUintN(128, BigInt(Math.floor(Math.random() * 2 ** 53)) * BigInt(Math.floor(Math.random() * 2 ** 53)) * 0x1234567n);
    const p = 4 * (1 + Math.floor(Math.random() * 31));
    if (!reverseName6(n).endsWith(`.${reverseZone6(n, p)}`)) { fail("reverseZone6 suffix", formatIpv6(n), p); break; }
  }
}

// ---- Cisco interface names: found however the switch writes them, and found
// again by the search pattern, never another port or a subinterface
for (const [line, found] of [
  ["interface GigabitEthernet1/0/1", ["GigabitEthernet1/0/1"]],
  ["sw2.lab   Gig 1/0/1   157   R S I  WS-C3750  Gig 1/0/24", ["Gig 1/0/1", "Gig 1/0/24"]],
  ["Te1/1/1 Fa0/1 Po1 Port-channel10 Lo0 Vlan10 Eth1/1", ["Te1/1/1", "Fa0/1", "Po1", "Port-channel10", "Lo0", "Vlan10", "Eth1/1"]],
  ["GigabitEthernet0/1.100 is up", ["GigabitEthernet0/1.100"]],
  ["For 3 hours the Ten 5 count, Gig 1, Gi1/0/10x, 15.2(4)E10, /dev/Gi1, x-Gi1/0/1", []],
  // "For" and "Ten" are words: spaced, only with a stack number.
  ["For 3/4 of the time, Ten 1/2 dozen", []],
  ["Ten 1/1/1 and Gig 0/1", ["Ten 1/1/1", "Gig 0/1"]],
]) {
  const got = findInterfaces(line).map((m) => line.slice(m.index, m.index + m.length));
  if (JSON.stringify(got) !== JSON.stringify(found)) fail("findInterfaces", line, got);
}
{
  const [gi] = findInterfaces("Gi1/0/1");
  const names = interfaceNames(gi.type, gi.number);
  if (names.full !== "GigabitEthernet1/0/1" || names.short !== "Gi1/0/1") fail("interfaceNames", names);
  const re = new RegExp(interfaceSearchPattern(gi.type, gi.number), "gi");
  const hits = [..."GigabitEthernet1/0/1 | Gi1/0/1 | Gig 1/0/1 | Gi1/0/10 | Gi1/0/1.100 | Gi11/0/1".matchAll(re)].map((m) => m[0]);
  if (JSON.stringify(hits) !== JSON.stringify(["GigabitEthernet1/0/1", "Gi1/0/1", "Gig 1/0/1"])) fail("interfaceSearchPattern", hits);
}

// ---- link state changes in Cisco log messages (the Syslog window's port changes)
for (const [text, want] of [
  ["%LINK-3-UPDOWN: Interface GigabitEthernet1/0/1, changed state to down", { iface: "GigabitEthernet1/0/1", protocol: false, state: "down" }],
  ["%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet1/0/1, changed state to up", { iface: "GigabitEthernet1/0/1", protocol: true, state: "up" }],
  ["%LINK-5-CHANGED: Interface Vlan10, changed state to administratively down", { iface: "Vlan10", protocol: false, state: "admin-down" }],
  ["%LINK-3-UPDOWN: Interface Port-channel1, changed state to down", { iface: "Port-channel1", protocol: false, state: "down" }],
  ["%SYS-5-CONFIG_I: Configured from console by admin on vty0", null],
]) {
  const got = interfaceStateChange(text);
  if (JSON.stringify(got) !== JSON.stringify(want)) fail("interfaceStateChange", text, got);
}

// ---- ARP table lines: one address and one MAC paired; anything else not
for (const [text, want] of [
  ["Internet  10.0.0.5        3   0011.2233.4455  ARPA   Vlan10", "10.0.0.5 001122334455"],
  ["? (10.0.0.5) at 00:11:22:33:44:55 [ether] on eth0", "10.0.0.5 001122334455"],
  ["10.0.0.5 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE", "10.0.0.5 001122334455"],
  ["  10.0.0.5            00-11-22-33-44-55     dynamic", "10.0.0.5 001122334455"],
  ["00:11:22:33:44:55 10.0.0.5        10.0.0.5                  ge-0/0/0.0  none", "10.0.0.5 001122334455"],
  ["10.0.0.5        0011-2233-4455  20        D-0  GE0/0/1", "10.0.0.5 001122334455"],
  // A command typed at a prompt that shows an address.
  ["admin@10.0.0.1:~$ echo 10 0011.2233.4455 DYNAMIC Gi1/0/1", null],
  ["[root@10.0.0.1 ~]# arping -s 00:11:22:33:44:55", null],
  // A log message, two addresses, two MACs.
  ["10.0.0.1: %SW_MATM-4-MACFLAP_NOTIF: Host 0011.2233.4455 in vlan 10 is flapping", null],
  ["DHCPACK on 10.0.0.77 to 00:15:5d:01:02:03 via 10.0.0.1", null],
  ["10.0.0.5 0011.2233.4455 0011.2233.4466", null],
]) {
  const p = arpPair(text);
  const got = p ? `${p.ip} ${p.hex}` : null;
  if (got !== want) fail("arpPair", text, got);
}

{
  const link = (iface, state) => `%LINK-3-UPDOWN: Interface ${iface}, changed state to ${state}`;
  const proto = (iface, state) => `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${iface}, changed state to ${state}`;
  const msgs = [
    // Gi1/0/1 flaps twice: a %LINK and a %LINEPROTO line each time.
    link("Gi1/0/1", "down"), proto("Gi1/0/1", "down"), link("Gi1/0/1", "up"), proto("Gi1/0/1", "up"),
    link("Gi1/0/1", "down"), proto("Gi1/0/1", "down"),
    // Gi1/0/2 is shut by hand: not a failure, so not listed.
    "%LINK-5-CHANGED: Interface Gi1/0/2, changed state to administratively down", proto("Gi1/0/2", "down"),
    // Gi1/0/3 only came up (a reload): not listed.
    link("Gi1/0/3", "up"), proto("Gi1/0/3", "up"),
    // Gi1/0/4 went down once, then was shut: listed with one, its state now shut.
    link("Gi1/0/4", "down"), proto("Gi1/0/4", "down"),
    "%LINK-5-CHANGED: Interface Gi1/0/4, changed state to administratively down",
  ].map((text) => ({ from: "10.0.0.2", text }));
  const got = linkDowns(msgs).map((c) => `${c.iface} ${c.downs} ${c.last}`);
  const want = ["Gi1/0/1 2 down", "Gi1/0/4 1 admin-down"];
  if (JSON.stringify(got) !== JSON.stringify(want)) fail("linkDowns", got);
}

// ---- Cisco log message names: %FACILITY-SEVERITY-MNEMONIC, severity 0-7, not inside a word
for (const [line, want] of [
  ["*Mar  1 00:01:02: %LINK-3-UPDOWN: Interface Gi0/1, changed state to down", [["%LINK-3-UPDOWN", 3]]],
  ["52: %SYS-5-CONFIG_I: Configured from console by admin on vty0", [["%SYS-5-CONFIG_I", 5]]],
  ["%LINEPROTO-5-UPDOWN and %SEC_LOGIN-4-LOGIN_FAILED", [["%LINEPROTO-5-UPDOWN", 5], ["%SEC_LOGIN-4-LOGIN_FAILED", 4]]],
  ["%FOO-8-BAR (severity past 7)", []],
  ["100%LINK-3-UPDOWN 50%%X-1-Y", []],
  ["%link-3-updown (lower case)", []],
  // IOS-XR: more name parts before the severity.
  ["RP/0/RSP0/CPU0:Nov 20 10:00:01: ifmgr[211]: %PKT_INFRA-LINK-3-UPDOWN : Interface Gi0/0/0/1", [["%PKT_INFRA-LINK-3-UPDOWN", 3]]],
  ["%ROUTING-BGP-5-ADJCHANGE : neighbor 10.0.0.2 Up", [["%ROUTING-BGP-5-ADJCHANGE", 5]]],
  ["000123: %SYS-5-RESTART: System restarted", [["%SYS-5-RESTART", 5]]],
]) {
  const got = findLogMnemonics(line).map((m) => [line.slice(m.index, m.index + m.length), m.severity]);
  if (JSON.stringify(got) !== JSON.stringify(want)) fail("findLogMnemonics", line, got);
}

// The hosts of a selected listing: each once, multicast left out, a written
// prefix's network and broadcast too; a line at a time.
{
  const cases = [
    ["Internet  10.0.0.1  5  aabb.cc00.0100  ARPA  Gi0/0\r\nInternet  10.0.0.2  5  aabb.cc00.0200\r\nInternet  10.0.0.2  5  aabb.cc00.0200", "10.0.0.1 10.0.0.2"],
    ["C   10.1.1.0/24 is directly connected, Gi0/1\nL   10.1.1.1/32 is directly connected, Gi0/1", "10.1.1.1"],
    ["ip address 10.0.0.255 255.255.255.0\nhost 10.0.0.254", "10.0.0.254"],
    ["mcast 224.0.0.5 and 239.1.1.1 and 240.0.0.1, host 192.168.1.10", "192.168.1.10"],
    ["p2p 10.9.9.0/31 and 10.9.9.1/31", "10.9.9.0 10.9.9.1"],
    ["no address here", ""],
    ["inet 10.0.0.5  netmask 255.255.255.0  broadcast 10.0.0.255", "10.0.0.5"],
    ["inet 10.0.0.5/24 brd 10.0.0.255 scope global eth0", "10.0.0.5"],
    ["inet addr:10.0.0.5  Bcast:10.0.0.255  Mask:255.255.255.0", "10.0.0.5"],
    ["lab-bcast 10.2.0.7\nip broadcast-address 10.2.0.255", "10.2.0.7"],
  ];
  for (const [text, want] of cases) {
    const got = hostAddresses(text).join(" ");
    if (got !== want) fail("hostAddresses", text, got, want);
  }
  // A long listing (select all on a route table): read a line at a time, quickly.
  const long = Array.from({ length: 20000 }, (_, i) => `S   10.${(i >> 8) & 255}.${i & 255}.0 255.255.255.0 [1/0] via 10.0.0.1`).join("\n");
  const t0 = Date.now();
  hostAddresses(long);
  if (Date.now() - t0 > 2000) fail("hostAddresses slow", Date.now() - t0);
}
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("address helpers ok (20000 subnets, output prefixes, address and MAC kinds, interface names and link changes, log message names)");
