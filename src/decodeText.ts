// Text selected in a terminal that is encoded, decoded to read and copy: a
// Base64 value (a Kubernetes Secret's data in `kubectl get secret -o yaml`, an
// "Authorization: Basic" header, a config value) when it decodes to readable
// UTF-8 text, and a JSON Web Token (RFC 7519: base64url header.payload.signature)
// as its header and claims, with the registered times (exp, nbf, iat: seconds
// since 1970) as UTC dates. Nothing is decoded that does not follow the format
// exactly, and binary data is not shown: a value that decodes to anything but
// printable text shows nothing.
//
// No imports: scripts/decode-check.mjs runs it under Node.

export interface DecodedForm {
  /** What the text is (shown as the menu item's hint; translated). */
  kind: string;
  /** The decoded value, as copied. */
  text: string;
  /** A date and time. */
  time?: boolean;
}

export interface Decoded {
  /** The heading over the forms (translated). */
  heading: string;
  forms: DecodedForm[];
}

/** Bytes of a Base64 (RFC 4648 §4) or base64url (§5) string; null when it is
 * neither: one alphabet only, padding only at the end and only to a multiple of 4. */
function base64Bytes(s: string): Uint8Array | null {
  const m = /^([A-Za-z0-9+/_-]+)(={0,2})$/.exec(s);
  if (!m) return null;
  const body = m[1];
  if (/[+/]/.test(body) && /[-_]/.test(body)) return null;
  if (m[2] ? s.length % 4 !== 0 : body.length % 4 === 1) return null;
  const std = body.replace(/-/g, "+").replace(/_/g, "/");
  let bin: string;
  try {
    bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  } catch {
    return null;
  }
  // The last character's unused bits must be zero (RFC 4648 §3.5): atob
  // ignores them, so "YWJjZB==" would read as "abcd" ("YWJjZA==").
  if (btoa(bin).replace(/=+$/, "") !== std) return null;
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Scripts a decoded text's non-ASCII letters may come from, as one language
 * writes them (Japanese mixes kanji and kana; Korean may hold hanja). */
const SCRIPT_GROUPS: RegExp[] = [
  /^[\p{Script=Hangul}\p{Script=Han}]$/u,
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u,
  /^\p{Script=Latin}$/u,
  /^\p{Script=Cyrillic}$/u,
  /^\p{Script=Greek}$/u,
  /^\p{Script=Arabic}$/u,
  /^\p{Script=Hebrew}$/u,
  /^\p{Script=Thai}$/u,
  /^\p{Script=Devanagari}$/u,
];

/** Whether a decoded text reads as written text rather than bytes that
 * happen to be valid UTF-8 ("big-endian" decodes to a mix of Latin, Hebrew
 * and CJK): its non-ASCII letters all fit one writing system, and nothing
 * else in it is a symbol from outside punctuation, digits, spaces and emoji. */
function writtenText(text: string): boolean {
  let groups = SCRIPT_GROUPS.map((_, i) => i);
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) continue;
    if (/^\p{L}$/u.test(ch)) {
      groups = groups.filter((i) => SCRIPT_GROUPS[i].test(ch));
      if (!groups.length) return false;
    } else if (!/^[\p{M}\p{N}\p{P}\p{Zs}\p{Extended_Pictographic}\u200d\ufe0f]$/u.test(ch)) return false;
  }
  return true;
}

/** Base64 as `base64` and `openssl base64` print it, wrapped at 76 or 64
 * columns and selected across the lines: joined, when every line but the
 * last is the same whole number of groups; the text as it is otherwise. */
function unwrap(s: string): string {
  const lines = s.split(/\r?\n/).map((l) => l.trim());
  if (lines.length < 2) return s;
  const width = lines[0].length;
  const whole = width >= 16 && width % 4 === 0 && lines.slice(0, -1).every((l) => l.length === width) && lines.at(-1)!.length <= width && lines.at(-1)!.length > 0;
  return whole ? lines.join("") : s;
}

/** The bytes as UTF-8 text when they are that and nothing in it is a control
 * character (tabs and line breaks aside); null for binary data. */
function readableText(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  // Control characters (C0 but tab and line breaks, DEL, C1), and the BOM.
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufeff]/.test(text) ? null : text;
}

/** Characters that join nothing and show nothing, so they only hide what is
 * between two letters ("pay" + one + "pal"): the zero-width space, the word
 * joiner, the zero-width no-break space, the invisible operators (U+2061 to
 * U+2064), the Mongolian vowel separator, the combining grapheme joiner and
 * the Hangul fillers (written by code: the characters themselves would be
 * invisible here). */
const HIDING = new RegExp(`[${String.fromCharCode(0x200b, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff, 0x180e, 0x034f, 0x115f, 0x1160, 0x3164, 0xffa0)}]`);

/** Tag characters (U+E0000 to U+E007F) hide text too, but for a flag of a
 * country's part: the black flag, tag letters, and the cancel tag
 * ("England"). Those flags are taken out before looking for others. */
const TAG = new RegExp(`[${String.fromCodePoint(0xe0000)}-${String.fromCodePoint(0xe007f)}]`, "u");
// A subdivision flag's tags are digits and lower-case letters (a region
// code, "gbeng": 3 to 7 of them): other tag characters, or a longer run,
// inside one would still hide text.
const TAG_FLAG = new RegExp(`${String.fromCodePoint(0x1f3f4)}[${String.fromCodePoint(0xe0030)}-${String.fromCodePoint(0xe0039)}${String.fromCodePoint(0xe0061)}-${String.fromCodePoint(0xe007a)}]{3,7}${String.fromCodePoint(0xe007f)}`, "gu");
const hides = (text: string) => HIDING.test(text) || TAG.test(text.replace(TAG_FLAG, ""));

/** A JWT's registered time claims, in the order a reader checks them. */
const TIMES: [claim: string, kind: string][] = [
  ["exp", "만료 시각 (exp, UTC)"],
  ["nbf", "유효 시작 (nbf, UTC)"],
  ["iat", "발급 시각 (iat, UTC)"],
];

/** A JSON object from base64url: its text as the token holds it (shown and
 * copied, so a large ID keeps its digits and the keys their order) and the
 * object read from it (for the times); null when it is not one. */
function jsonPart(part: string): { text: string; value: Record<string, unknown> } | null {
  const bytes = base64Bytes(part);
  const text = bytes && readableText(bytes);
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? { text, value: v as Record<string, unknown> } : null;
  } catch {
    return null;
  }
}

/** What `selection` decodes to, or null when it is not one encoded value.
 * `now` (ms) says whether a token has expired. */
export function decodeSelection(selection: string, now = Date.now()): Decoded | null {
  const s = selection.trim();
  if (s.length > 16_384) return null;
  // A JWT: two JSON objects and a signature (empty for an unsigned token).
  const jwt = /^(eyJ[A-Za-z0-9_-]+)\.(eyJ[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/.exec(s);
  if (jwt) {
    const header = jsonPart(jwt[1]);
    const payload = jsonPart(jwt[2]);
    if (!header || !payload) return null;
    const forms: DecodedForm[] = [
      { kind: "헤더", text: header.text },
      { kind: "페이로드", text: payload.text },
    ];
    for (const [claim, kind] of TIMES) {
      const v = payload.value[claim];
      // NumericDate: seconds, possibly with a fraction; one a Date can hold.
      if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 8.64e12) {
        forms.push({ kind, text: new Date(Math.floor(v * 1000)).toISOString().replace(/\.000Z$/, "Z"), time: true });
      }
    }
    const exp = payload.value.exp;
    const expired = typeof exp === "number" && Number.isFinite(exp) && exp * 1000 <= now;
    return { heading: expired ? "JWT 풀이 (만료됨)" : "JWT 풀이", forms };
  }
  // Percent-encoding (RFC 3986 2.1: a URL or a query in a web server's log,
  // "%2Fapi%2Fv1%3Fq%3D%ED%95%9C"): the text, its escapes read as UTF-8.
  // A "+" stays a "+" (only a form's query means a space by it). An escape
  // that is not UTF-8, or text with control characters, shows nothing.
  // Only text a URI may hold (RFC 3986 2: no quotes, spaces or backslashes:
  // printf("%5d") is code), and no escape of a character URIs never need to
  // escape (2.3: letters, digits, "-._~": "%2d" is a printf format).
  const uriText = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/.test(s);
  const needless = /%(?:[46][1-9A-Fa-f]|[57][0-9Aa]|3[0-9]|2[Dd]|2[Ee]|5[Ff]|7[Ee])/.test(s);
  // One escape alone ("%5d") is a printf format as often as a character, and
  // so is text whose every escape is a digit and a lower-case letter ("%5d,%5d",
  // "x=%3d", "%2f%2f"): a URL's escapes are upper case (RFC 3986 2.1 says
  // they should be) or hold more than that ("%ea%b9%80").
  const printfLike = (s.match(/%[0-9A-Fa-f]{2}/g) ?? []).every((e) => /^%\d[a-f]$/.test(e));
  if (/%[0-9A-Fa-f]{2}/.test(s) && uriText && !needless && !printfLike && !/^%[0-9A-Fa-f]{2}$/.test(s)) {
    let url: string | null = null;
    try {
      url = decodeURIComponent(s);
    } catch {
      url = null;
    }
    // No control characters, no bidirectional controls (a right-to-left
    // override would reverse the label, "foo%E2%80%AEtxt.exe"), nor line or
    // paragraph separators. Other format characters belong to the text (the
    // zero-width joiner inside an emoji sequence, the non-joiner of Persian words), and so
    // do symbols ("€", "°C", "→"): escapes in a URL were written on purpose.
    if (url !== null && url !== s && readableText(new TextEncoder().encode(url)) !== null && !/[\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(url) && !hides(url))
      return { heading: "URL 디코딩", forms: [{ kind: "텍스트", text: url }] };
  }
  // Base64: not shorter than 8 characters (two groups), and not what reads
  // as something else first: a number, or hex digits (a hash, an ID).
  const b = unwrap(s);
  if (b.length < 8 || /^[0-9]+$/.test(b) || /^[0-9a-f]+$/i.test(b)) return null;
  // Short and unpadded, a word or a name ("UltraVNC", "big-endian",
  // "0o040755") is far more likely than a value, and some decode to text:
  // read only when that is plain ASCII, and never with base64url's "-" or "_".
  const short = b.length < 16 && !b.endsWith("=");
  if (short && (/^[A-Za-z]+$/.test(b) || /[-_]/.test(b))) return null;
  const bytes = base64Bytes(b);
  const text = bytes && readableText(bytes);
  if (!text || !text.trim() || !writtenText(text)) return null;
  if (short && /[^\t\n\r\x20-\x7e]/.test(text)) return null;
  return { heading: "Base64 풀이", forms: [{ kind: "텍스트", text }] };
}

/** A decoded value as a one-line menu label: line breaks shown as "⏎", long
 * text cut (between characters, not inside an emoji's surrogate pair). */
export function decodedLabel(text: string, max = 80): string {
  const chars = Array.from(text.replace(/\r\n|\r|\n/g, " ⏎ ").replace(/\t/g, " "));
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}
