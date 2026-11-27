// Check src/decodeText.ts: a Base64 value or a JSON Web Token selected in the
// terminal is decoded when it follows the format and decodes to readable
// text; anything else (words, hashes, numbers, binary data) shows nothing.
//
//   node scripts/decode-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { decodedLabel, decodeSelection } from "../src/decodeText.ts";

let problems = 0;
const report = (msg) => {
  problems++;
  console.log(`  ${msg}`);
};
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");

// Base64 that decodes to text: the text.
const texts = [
  [b64("admin"), "admin"], // "YWRtaW4=": a Kubernetes Secret's value
  [b64("s3cr3t-P@ss"), "s3cr3t-P@ss"],
  [b64("user:password"), "user:password"], // Basic authorization
  [b64("한글 비밀번호"), "한글 비밀번호"],
  [b64("line one\nline two\n"), "line one\nline two\n"],
  [b64url("??>>??>>a~??>>??>>"), "??>>??>>a~??>>??>>"], // base64url alphabet ("-", "_")
  [b64("hello world").replace(/=+$/, ""), "hello world"], // padding left off
  [`  ${b64("trimmed")}\n`, "trimmed"],
  [b64("こんにちは、世界"), "こんにちは、世界"], // kana and kanji: one writing system
  [b64("Привет, мир"), "Привет, мир"],
  [b64("café ✅ ok"), "café ✅ ok"],
  // Wrapped as `base64` prints it (76 columns), selected across the lines.
  [b64("x".repeat(100)).replace(/(.{76})/g, "$1\n"), "x".repeat(100)],
  [b64("y".repeat(100)).replace(/(.{76})/g, "$1\r\n"), "y".repeat(100)],
];
for (const [sel, want] of texts) {
  const d = decodeSelection(sel);
  if (d?.heading !== "Base64 풀이" || d.forms.length !== 1 || d.forms[0].text !== want) report(`${JSON.stringify(sel)}: ${JSON.stringify(d)}, expected "${want}"`);
}

// Not Base64 text: nothing.
const none = [
  "",
  "abc", // too short
  "password", // a word: decodes to binary
  "abcdefgh",
  "12345678", // a number
  "deadbeefcafebabe", // hex (a hash, an ID)
  "d41d8cd98f00b204e9800998ecf8427e",
  b64("x").slice(0, 1) + "A=", // padding where it cannot be
  "YWRtaW4=YWRt", // padding inside
  "YWRtaW4===", // three "="
  "YWR+aW4_", // two alphabets
  "YWRta", // 5 characters: never a Base64 length
  b64("hello world").slice(0, -3), // cut to 13 characters: an invalid length
  Buffer.from([0, 1, 2, 3, 255, 254, 10, 11]).toString("base64"), // binary
  b64("bell\u0007here"), // a control character
  b64("\ufeffbom"),
  b64("   \n  "), // only spaces
  "YWRt aW4=", // two words
  "/usr/local/bin/x", // a path (its slashes are Base64 characters)
  "ABCDEFGHIJKLMNOP", // capitals that decode to binary
  // Words and names that decode to (odd) text: letters alone under 16 are not read.
  "UltraVNC",
  "diskUsed",
  "CircleStop",
  "endsWith",
  // What a terminal shows that only looks like Base64.
  "GigabitEthernet1/0/1",
  "/etc/ssh/sshd_config",
  "Port-channel10",
  "coredns-5d78c9869d-abcde",
  "x86_64-linux-gnu",
  // Identifiers that decode to valid UTF-8 in mixed scripts (review findings).
  "big-endian",
  "0o040755",
  "0o100644",
  "alpha-master",
  "alpha-edge",
  "alpha-admin",
  "V-Worlds",
  "YWJjZB==", // unused bits not zero (RFC 4648 3.5); "YWJjZA==" is "abcd"
  b64("abc") + "\n" + b64("def"), // two short lines: not one wrapped value
  b64("x".repeat(100)).replace(/(.{76})/g, "$1\n").replace("\n", "\nAAAA"), // lines of differing width
];
if (decodeSelection("YWJjZA==")?.forms[0].text !== "abcd") report(`"YWJjZA==" is not "abcd"`);
for (const sel of none) {
  const d = decodeSelection(sel);
  if (d) report(`${JSON.stringify(sel)} decodes: ${JSON.stringify(d)}`);
}

// A JWT: header and payload as JSON, the time claims as UTC dates, the
// heading saying whether it has expired.
const jwt = (header, payload, sig = "c2lnbmF0dXJl") => `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.${sig}`;
const now = Date.UTC(2026, 0, 1);
const token = jwt({ alg: "HS256", typ: "JWT" }, { sub: "1234567890", name: "Kim", iat: 1516239022, exp: 1893456000, nbf: 1516239022.5 });
const d = decodeSelection(token, now);
const byKind = Object.fromEntries((d?.forms ?? []).map((f) => [f.kind, f.text]));
const want = {
  "헤더": '{"alg":"HS256","typ":"JWT"}',
  "페이로드": '{"sub":"1234567890","name":"Kim","iat":1516239022,"exp":1893456000,"nbf":1516239022.5}',
  "만료 시각 (exp, UTC)": "2030-01-01T00:00:00Z",
  "유효 시작 (nbf, UTC)": "2018-01-18T01:30:22.500Z",
  "발급 시각 (iat, UTC)": "2018-01-18T01:30:22Z",
};
if (d?.heading !== "JWT 풀이") report(`JWT heading: ${d?.heading}`);
for (const [kind, text] of Object.entries(want)) if (byKind[kind] !== text) report(`JWT ${kind}: "${byKind[kind]}", expected "${text}"`);
if (d && d.forms.map((f) => f.kind).join() !== Object.keys(want).join()) report(`JWT forms in order: ${d.forms.map((f) => f.kind).join()}`);
if (decodeSelection(jwt({ alg: "RS256" }, { exp: 1600000000 }), now)?.heading !== "JWT 풀이 (만료됨)") report("an expired JWT is not said to be");
// Unsigned (empty signature) still reads; no time claims, no time forms; a
// string "exp" is not a NumericDate.
const plain = decodeSelection(jwt({ alg: "none" }, { sub: "x", exp: "soon" }, ""), now);
if (plain?.heading !== "JWT 풀이" || plain.forms.length !== 2) report(`unsigned JWT: ${JSON.stringify(plain)}`);
// Not a JWT: a part that is not a JSON object, a missing part, a fourth part.
for (const sel of [
  `${b64url('{"alg":"HS256"}')}.${b64url("[1,2]")}.sig`,
  `${b64url('{"alg":"HS256"}')}.${b64url('{"a":1')}.sig`,
  `${b64url('{"alg":"HS256"}')}.${b64url('{"a":1}')}`,
  `${b64url('{"alg":"HS256"}')}.${b64url('{"a":1}')}.sig.more`,
]) {
  const r = decodeSelection(sel, now);
  if (r?.heading?.startsWith("JWT")) report(`${sel} read as a JWT`);
}

// Percent-encoding (RFC 3986 2.1): the text, escapes read as UTF-8, "+" kept.
for (const [sel, want] of [
  ["%2Fapi%2Fv1%3Fq%3D%ED%95%9C", "/api/v1?q=한"],
  ["/search?q=hello%20world+x", "/search?q=hello world+x"],
  ["50%25off", "50%off"],
  ["name=%EA%B9%80%EC%B2%A0%EC%88%98", "name=김철수"],
  // Symbols written on purpose decode too.
  ["price%3D10%E2%82%AC", "price=10€"],
  ["%C2%B0C", "°C"],
  ["a%E2%86%92b", "a→b"],
  ["%ea%b9%80", "김"],
]) {
  const d = decodeSelection(sel);
  if (d?.heading !== "URL 디코딩" || d.forms[0].text !== want) report(`${JSON.stringify(sel)}: ${JSON.stringify(d)}, expected "${want}"`);
}
// Format characters that belong to the text decode: the zero-width joiner of
// an emoji sequence, the non-joiner of a Persian word, a soft hyphen. Bidi
// controls (an isolate, an override) and line separators do not.
for (const sel of ["%F0%9F%91%A8%E2%80%8D%F0%9F%92%BB", "/q=%D9%85%DB%8C%E2%80%8C%D8%AE%D9%88%D8%A7%D9%87%D9%85", "soft%C2%ADhyphen", "/wiki/%F0%9F%8F%B4%F3%A0%81%A7%F3%A0%81%A2%F3%A0%81%A5%F3%A0%81%AE%F3%A0%81%A7%F3%A0%81%BF"]) {
  const d = decodeSelection(sel);
  if (d?.heading !== "URL 디코딩" || d.forms[0].text !== decodeURIComponent(sel)) report(`${JSON.stringify(sel)} not decoded: ${JSON.stringify(d)}`);
}
for (const sel of ["a%E2%81%A6b", "a%E2%80%8Fb", "%E2%80%A8x", "pay%F3%A0%81%81pal", "pay%E2%81%A2pal", "pay%E1%A0%8Epal", "pay%E3%85%A4pal", "pay%CD%8Fpal", "a%F0%9F%8F%B4%F3%A0%81%90%F3%A0%81%81%F3%A0%81%99%F3%A0%81%BFb", "pay%F0%9F%8F%B4%F3%A0%81%B3%F3%A0%81%A5%F3%A0%81%AE%F3%A0%81%A4%F3%A0%81%A1%F3%A0%81%AC%F3%A0%81%AC%F3%A0%81%A6%F3%A0%81%B5%F3%A0%81%AE%F3%A0%81%A4%F3%A0%81%B3%F3%A0%81%BFpal"]) if (decodeSelection(sel)?.heading === "URL 디코딩") report(`${JSON.stringify(sel)} decoded with a bidi control or separator`);
// Not UTF-8, a lone "%", control characters, spaces (a sentence), nothing to decode: none.
// printf formats ("%2d", printf("%5d")), escapes of characters URIs never escape,
// and format characters (a right-to-left override, a zero-width space) are not read.
for (const sel of ["%E0%A4", "100%", "%00x", "%1Bx", "50% off and 20%2F", "%zz", "plain/text", "%2d", 'printf("%5d")', "%41BC", "foo%E2%80%AEtxt.exe", "%E2%80%A8", "a%E2%80%8Bb", "C:\\x%20y", "%5d", "%2F", "%5d,%5d", "%5d:%5d", "x=%3d", "%7b%7d", "%2f%2f"]) {
  const d = decodeSelection(sel);
  if (d?.heading === "URL 디코딩") report(`${JSON.stringify(sel)} URL-decoded: ${JSON.stringify(d)}`);
}

// Labels: one line, cut with "…".
if (decodedLabel("a\r\nb\tc") !== "a ⏎ b c") report(`label: "${decodedLabel("a\r\nb\tc")}"`);
// Cut between characters: an emoji is not split into half a surrogate pair.
const emoji = decodedLabel("😀".repeat(100));
if (Array.from(emoji).length !== 80 || /[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji)) report(`emoji label cut inside a character`);
// The JSON as the token holds it: a large ID keeps its digits, keys their order.
const rawPayload = '{"sub":1234567890123456789,"b":1,"2":2,"exp":1.0e3}';
const raw = decodeSelection(`${b64url('{"alg":"HS256"}')}.${b64url(rawPayload)}.sig`, now);
if (raw?.forms[1]?.text !== rawPayload) report(`payload not as the token holds it: ${raw?.forms[1]?.text}`);
if (raw?.forms.find((f) => f.kind === "만료 시각 (exp, UTC)")?.text !== "1970-01-01T00:16:40Z") report("exp written 1.0e3 not read as 1000");
const long = decodedLabel("x".repeat(200));
if (long.length !== 80 || !long.endsWith("…")) report(`long label: ${long.length} characters`);

console.log(`${texts.length + none.length} Base64 cases and ${Object.keys(want).length + 6} JWT cases checked`);
console.log(problems ? `${problems} problem(s)` : "decoding as expected");
process.exit(problems ? 1 : 0);
