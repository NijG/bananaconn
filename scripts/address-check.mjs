// Check the address helpers (src/ipLinks.ts) the terminal's links, the
// subnet calculator and the session search use: subnet arithmetic against a
// BigInt reference for random addresses and every prefix, the ways a prefix
// is written (/24, a mask, "mask …", an ACL wildcard, AIX's 0x mask), the
// subnet search, and what a MAC address's value says it is.
//
//   node scripts/address-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { addressKind, arpPair, bandwidthAbove, findInterfaces, findIps, interfaceDescription, interfaceNeighbor, interfaceVlan, findMacs, findMasks, findRates, findUptimes, maskForms, readableRate, interfaceNames, interfaceSearchPattern, interfaceStateChange, linkDowns, macKind, parseSubnetInput, subnetInfo, subnetMatcher } from "../src/ipLinks.ts";

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

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("address helpers ok (20000 subnets, output prefixes, address and MAC kinds, interface names and link changes)");
