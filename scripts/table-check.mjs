// Check "copy as table" (src/tableCopy.ts): selected terminal output split
// into the cells a spreadsheet pastes. The outputs are the cases found so
// far, so a change to the column rules that breaks one is seen at once.
//
//   node scripts/table-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { codeBlock, splitTable } from "../src/tableCopy.ts";

/** [name, the selected lines, the rows expected]. */
const cases = [
  ["show ip interface brief", [
    "Interface              IP-Address      OK? Method Status                Protocol",
    "GigabitEthernet0/0     10.0.0.1        YES NVRAM  up                    up",
    "GigabitEthernet0/1     unassigned      YES unset  administratively down down",
  ], [
    ["Interface", "IP-Address", "OK?", "Method", "Status", "Protocol"],
    ["GigabitEthernet0/0", "10.0.0.1", "YES", "NVRAM", "up", "up"],
    ["GigabitEthernet0/1", "unassigned", "YES", "unset", "administratively down", "down"],
  ]],
  // The rule under the header is no row; a ports line continued stays in its column.
  ["show vlan brief", [
    "VLAN Name                             Status    Ports",
    "---- -------------------------------- --------- -------------------------------",
    "1    default                          active    Gi1/0/1, Gi1/0/2",
    "                                                Gi1/0/5, Gi1/0/6",
  ], [
    ["VLAN", "Name", "Status", "Ports"],
    ["1", "default", "active", "Gi1/0/1, Gi1/0/2"],
    ["", "", "", "Gi1/0/5, Gi1/0/6"],
  ]],
  // Title and rules above, the total sentence below: none of them joins columns.
  ["show mac address-table", [
    "          Mac Address Table",
    "-------------------------------------------",
    "",
    "Vlan    Mac Address       Type        Ports",
    "----    -----------       --------    -----",
    "   1    0011.2233.4455    DYNAMIC     Gi1/0/1",
    "Total Mac Addresses for this criterion: 1",
  ], [
    ["Mac Address Table"],
    ["Vlan", "Mac Address", "Type", "Ports"],
    ["1", "0011.2233.4455", "DYNAMIC", "Gi1/0/1"],
    ["Total Mac Addresses for this criterion: 1"],
  ]],
  // An indented header: the row names are a column of their own.
  ["free -h", [
    "               total        used        free      shared  buff/cache   available",
    "Mem:            15Gi       2.1Gi        10Gi       3.0Mi       3.2Gi        13Gi",
    "Swap:          4.0Gi          0B       4.0Gi",
  ], [
    ["", "total", "used", "free", "shared", "buff/cache", "available"],
    ["Mem:", "15Gi", "2.1Gi", "10Gi", "3.0Mi", "3.2Gi", "13Gi"],
    ["Swap:", "4.0Gi", "0B", "4.0Gi", "", "", ""],
  ]],
  // Values with spaces stay whole.
  ["docker ps", [
    "CONTAINER ID   IMAGE     COMMAND                  CREATED       STATUS       PORTS     NAMES",
    "1a2b3c4d5e6f   nginx     \"/docker-entrypoint.…\"   2 hours ago   Up 2 hours   80/tcp    web",
  ], [
    ["CONTAINER ID", "IMAGE", "COMMAND", "CREATED", "STATUS", "PORTS", "NAMES"],
    ["1a2b3c4d5e6f", "nginx", "\"/docker-entrypoint.…\"", "2 hours ago", "Up 2 hours", "80/tcp", "web"],
  ]],
  // A name too long for its column on a line of its own.
  ["df -h (a long name)", [
    "Filesystem      Size  Used Avail Use% Mounted on",
    "/dev/sda1        50G   20G   30G  40% /",
    "/dev/mapper/vg-very-long-root-name",
    "                 50G   20G   30G  40% /data",
  ], [
    ["Filesystem", "Size", "Used", "Avail", "Use%", "Mounted on"],
    ["/dev/sda1", "50G", "20G", "30G", "40%", "/"],
    ["/dev/mapper/vg-very-long-root-name"],
    ["", "50G", "20G", "30G", "40%", "/data"],
  ]],
  // A row packed with single spaces runs across the columns: one cell
  // (it has more words than columns), the other rows still split.
  ["show interfaces status", [
    "Port      Name               Status       Vlan       Duplex  Speed Type",
    "Gi1/0/1   uplink-to-core     connected    trunk        a-full a-1000 10/100/1000BaseTX",
    "Gi1/0/2 server-room-rack-a-01 connected 10 a-full a-1000 10/100/1000BaseTX",
    "Gi1/0/3                      notconnect   1              auto   auto 10/100/1000BaseTX",
  ], [
    ["Port", "Name", "Status", "Vlan", "Duplex  Speed Type"],
    ["Gi1/0/1", "uplink-to-core", "connected", "trunk", "a-full a-1000 10/100/1000BaseTX"],
    ["Gi1/0/2 server-room-rack-a-01 connected 10 a-full a-1000 10/100/1000BaseTX"],
    ["Gi1/0/3", "", "notconnect", "1", "auto   auto 10/100/1000BaseTX"],
  ]],
  // Only the rule under the header goes: a row of dashes further down is values.
  ["dash rows", [
    "Name    Value   Other",
    "-----   -----   -----",
    "a       1       x",
    "---     ---     ---",
  ], [
    ["Name", "Value", "Other"],
    ["a", "1", "x"],
    ["---", "---", "---"],
  ]],
  // "-" and "--" values are not rules.
  ["dash values", [
    "Name    Value",
    "a       -",
    "b       --",
  ], [
    ["Name", "Value"],
    ["a", "-"],
    ["b", "--"],
  ]],
];

let failed = 0;
for (const [name, lines, want] of cases) {
  const got = splitTable(lines.map((s) => [...s]));
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`FAIL ${name}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
  }
}
// Copy as a Markdown code block: line ends trimmed, outer blank lines dropped,
// CRLF as LF, a fence longer than any backtick run inside.
for (const [name, text, want] of [
  ["plain", "Gi1/0/1  up  \r\nGi1/0/2  down\r\n", "```\nGi1/0/1  up\nGi1/0/2  down\n```"],
  ["outer blank lines", "\n\n  x\n\n y \n\n", "```\n  x\n\n y\n```"],
  ["backticks inside", "a ``` b\n````", "`````\na ``` b\n````\n`````"],
  ["one backtick", "echo `date`", "```\necho `date`\n```"],
]) {
  const got = codeBlock(text);
  if (got !== want) {
    failed++;
    console.error(`FAIL codeBlock ${name}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
  }
}
if (failed) process.exit(1);
console.log(`${cases.length} tables split as expected`);
