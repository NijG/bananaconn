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
  ['curl -H "Authorization: Basic YWRtaW46aHVudGVyMg==" https://x', "YWRtaW46aHVudGVyMg=="],
  ["Proxy-Authorization: basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
  ["Authorization: Token abcd1234", "abcd1234"],
  ["Cookie: sid=AbC123xyz; theme=dark", "AbC123xyz"],
  ["< Set-Cookie: JSESSIONID=8F3A2B; Path=/; HttpOnly", "8F3A2B"],
  ["curl -H 'cookie: sess=Q9w8e7' https://x", "Q9w8e7"],
  ["curl -b 'sess=R5t6y7' https://x", "R5t6y7"],
  ["curl --cookie sess=Z1x2c3 https://x", "Z1x2c3"],
  ["export OPENAI_KEY=abcdef123456", "abcdef123456"],
  ['SIGNING_KEY="k-9 9"', "k-9 9"],
  ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI", "wJalrXUtnFEMI"],
  ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "dozjgNryP4J3jVmNHl0w5N"],
  ["root:$6$Zq1w$HashHashHash.Hash/1:19000:0:99999:7:::", "HashHashHash"],
  ["admin:!$y$j9T$Salt$YesHash:19500::::::", "YesHash"],
  // "BEGIN" is split from the rest so the public export's key scan does not flag these fake samples.
  ["-----BEGIN" + " PGP PRIVATE KEY BLOCK-----\n\nlQOYBF1mPgpPrivBody\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----", "PgpPrivBody"],
  ["$ head -3 id_rsa\n-----BEGIN" + " OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAHeadOnly", "HeadOnly"],
  ["$ tail -2 id_rsa\nAAAAB3NzaC1yc2EAAAADTailOnly1234\n-----END RSA PRIVATE KEY-----", "TailOnly"],
  ["$ tail -3 id_rsa\nMIIEowIBAAKCAQEA1x2y3z4w5v6u7t8s9r0q1p2o3n4m5l6k7j8i9h0g1f2e3d4c5b6a\nZ9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0f9e8d7c6b5a4z3y2x1w0v9u8t\nq3eD9Kx==\n-----END RSA PRIVATE KEY-----", "q3eD9Kx"],
  ["AAAAAAECAwQF\n-----END OPENSSH PRIVATE KEY-----", "AAAAAAECAwQF"],
  ['{"name": "Cookie", "Cookie": "sid=Jw3kQ9"}', "Jw3kQ9"],
  ['Authorization: Digest username="a", realm="r", nonce="n", uri="/", response="6629fae49393a05397450978507c4ef1"', "6629fae49393a05397450978507c4ef1"],
  ["X-Amz-Signature=fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024", "fe5f80f77d5fa3beca038a248ff027d0"],
  ["PuTTY-User-Key-File-2: ssh-rsa\nEncryption: none\nPrivate-Lines: 2\nAAAAgQCPpkPrivA1\nBBBBPpkPrivB2==\nPrivate-MAC: 0a1b", "PpkPriv"],
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
  "Basic settings are applied",
  "Authorization: required for this endpoint",
  "the cookie jar is empty",
  "curl -b cookies.txt https://x",
  "ls -b",
  "grep -b foo=bar log.txt",
  "du -b x=1",
  "PRIMARY_KEY = id",
  "FOREIGN_KEY=1",
  "ok\n-----END RSA PUBLIC KEY-----",
  "root:x:0:0:root:/root:/bin/bash",
  "daemon:*:19000:0:99999:7:::",
  "nobody:!:19000::::::",
  "PRIMARY KEY (id)",
  "echo $HOME",
  "-----BEGIN CERTIFICATE-----",
  "-----BEGIN PUBLIC KEY-----",
  "Public-Lines: 6",
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
// Many key-like lines with no END marker (a base64 dump), and long header runs.
for (const [what, text] of [
  ["base64 lines", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldY\n".repeat(20000)],
  ["base64 lines (CRLF)", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldY\r\n".repeat(20000)],
  ["short lines", "abc\n".repeat(50000)],
  ["base64 lines then short", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldY\nab\n".repeat(20000)],
  ["Cookie headers", "Cookie: a=b ".repeat(20000)],
  ["Digest headers", "Authorization: Digest response ".repeat(20000)],
  ["curl -b", "curl -b ".repeat(20000)],
  ["eyJ runs", "eyJabcdefghij.".repeat(20000)],
  ["Private-Lines", "Private-Lines: 1\n".repeat(20000)],
]) {
  const t0 = performance.now();
  holdsMaskable(text);
  const ms = performance.now() - t0;
  if (ms > 300) report(`slow on ${what}: ${ms.toFixed(0)} ms`);
}
// The line after a masked key stays on its own line.
for (const [text, want] of [
  ["Private-Lines: 2\nAAAAgQCPpkPrivA1\nBBBBPpkPrivB2==\nPrivate-MAC: 0a1b", `Private-Lines: 2\n${SECRET}\nPrivate-MAC: 0a1b`],
  ["x\nAAAAB3NzaC1yc2EAAAADTailOnly1234\n-----END RSA PRIVATE KEY-----\n$ ", `x\n${SECRET}\n$ `],
]) {
  const out = maskSecrets(text);
  if (out !== want) report(`kept lines changed: ${JSON.stringify(text)} → ${JSON.stringify(out)}`);
}
// Windows line ends: the same key cases with CRLF.
for (const [line, secret] of masked.filter(([l]) => l.includes("\n"))) {
  const out = maskSecrets(line.replace(/\n/g, "\r\n"));
  if (out.includes(secret)) report(`not masked with CRLF: ${JSON.stringify(line)} → ${JSON.stringify(out)}`);
}
console.log(`${masked.length} secret lines, ${kept.length} ordinary lines checked`);
console.log(problems ? `${problems} problem(s)` : "all secret rules hold");
process.exit(problems ? 1 : 0);
