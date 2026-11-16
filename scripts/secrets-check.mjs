// Check the secret rules (src/secrets.ts): every line that holds a password,
// key or community is masked before it reaches a cloud AI or a saved chat (and
// so is never kept in the command or clipboard history, cmdLine.holdsSecret),
// and ordinary commands and sentences are left as they are. The lines are the
// cases found so far, so a rule change that loses one is seen at once.
//
//   node scripts/secrets-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { holdsMaskable, maskSecrets, SECRET } from "../src/secrets.ts";

/** [line, what must be masked in it]. */
const masked = [
  ["standby 1 authentication md5 key-string k1", "k1"],
  ["standby 1 authentication cisco1", "cisco1"],
  ["ntp authentication-key 1 md5 k2 7", "k2"],
  ["ip ospf authentication-key OspfKey1", "OspfKey1"],
  ["ip ospf message-digest-key 1 md5 MdKey", "MdKey"],
  ["  key-string KcString1", "KcString1"],
  ["pre-shared-key address 1.1.1.1 key K3", "K3"],
  ["pre-shared-key address 1.1.1.0 255.255.255.0 key K3b", "K3b"],
  ["pre-shared-key local K4", "K4"],
  ["pre-shared-key cipher Huawei@1", "Huawei@1"],
  ["snmp-server community public RO", "public"],
  ["snmp-server host 1.1.1.1 c0mm1", "c0mm1"],
  ["snmp-server host 1.1.1.1 traps c0mm2", "c0mm2"],
  ["snmp-server host 1.1.1.1 vrf M version 2c c0mm3", "c0mm3"],
  ["snmp-server host 10.0.0.9 version 2c c0mm4", "c0mm4"],
  ["tacacs-server key MyKey", "MyKey"],
  ["tacacs-server host 10.0.0.5 key PlainTac1", "PlainTac1"],
  ["radius-server key RadKey1", "RadKey1"],
  ["R1(config-radius-server)#key mysecret", "mysecret"],
  [" key 7 094F471A1A0A", "094F471A1A0A"],
  [" key mykey", "mykey"],
  ["\tkey mykey2", "mykey2"],
  ["server-private 10.0.0.1 key 7 abc", "abc"],
  ["crypto isakmp key IsaKey1 address 1.2.3.4", "IsaKey1"],
  [" neighbor 10.0.0.2 password BgpPlain1", "BgpPlain1"],
  [" ppp chap password 7 13061E010803", "13061E010803"],
  ["ppp pap sent-username u password 0 k6", "k6"],
  [" wpa-psk ascii 0 WifiPass1", "WifiPass1"],
  ["enable secret 9 $9$abc", "$9$abc"],
  ["username admin privilege 15 password 0 cisco123", "cisco123"],
  ["ssh://root:pw@host", "pw"],
  ["ssh://:pw2@host", "pw2"],
  ["mysql -u root -pS3cret db", "S3cret"],
  ["curl -u admin:hunter2 https://x", "hunter2"],
];

/** Lines that hold no secret: nothing in them may be masked. */
const kept = [
  "key 1",
  "key 10",
  "R1(config-keychain)#key 1",
  "key chain OSPF",
  "Key points: blah",
  "show crypto isakmp key",
  "neighbor 10.0.0.1 remote-as 65001",
  "description uplink key switch",
  "ip rip authentication key-chain X",
  "snmp-server host 10.0.0.9 version 3 auth v3user",
  "standby 1 authentication md5 key-chain HSRP",
  "show running-config",
  "show snmp host",
  "crypto isakmp policy 10",
  "interface GigabitEthernet0/1",
  " ip address 10.0.0.1 255.255.255.0",
  "ping 10.0.0.1",
];

let problems = 0;
const report = (msg) => {
  problems++;
  console.log(`  ${msg}`);
};
for (const [line, secret] of masked) {
  const out = maskSecrets(line);
  if (out.includes(secret) || !out.includes(SECRET)) report(`not masked: "${line}" → "${out}"`);
  if (!holdsMaskable(line)) report(`not held back from the history: "${line}"`);
}
for (const line of kept) {
  const out = maskSecrets(line);
  if (out !== line) report(`masked though it holds no secret: "${line}" → "${out}"`);
}
// A long pasted line is read in linear time (a run in a rule is bounded):
// 20,000 repeats take some 30 ms so; an unbounded run takes over a second.
for (const unit of ["radius-server ", "server-private a ", "snmp-server host a ", "username a ", "mysql x ", "login x "]) {
  const t0 = performance.now();
  holdsMaskable(unit.repeat(20000));
  const ms = performance.now() - t0;
  if (ms > 300) report(`slow on a long line of "${unit.trim()}": ${ms.toFixed(0)} ms`);
}
console.log(`${masked.length} secret lines, ${kept.length} ordinary lines checked`);
console.log(problems ? `${problems} problem(s)` : "all secret rules hold");
process.exit(problems ? 1 : 0);
