// The translation tables and the lookup itself, without the DOM: i18n.ts swaps
// the screen's texts with these, and scripts/i18n-check.mjs runs every phrase
// through them so a change to the matching rules cannot silently mistranslate.

export const HANGUL = /[가-힣]/;

/** One language's lookup tables. need: the longest fixed piece of a phrase;
 * a text without it cannot match, and that check is far cheaper than the regex. */
export interface Tables {
  exact: Map<string, string>;
  /** Applied to a filled-in phrase: English singulars after a count of 1. */
  after?: (s: string) => string;
  /** fixed: the key's length without its {n}, for the most specific match first. */
  patterns: { re: RegExp; order: number[]; en: string; need: string; fixed: number; anchored: boolean }[];
}
export const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** A user's value (a session, file or snippet name) put into a translated
 * message: wrapped in Unicode isolates (U+2068 … U+2069, invisible), so the
 * lookup keeps it as written when it fills a phrase's {n} — "설정 업로드
 * 실패" must not become "Settings upload failed" for a file named 설정. */
export const userText = (s: string) => `⁨${s}⁩`;
const isUserText = (s: string) => s.startsWith("⁨") && s.endsWith("⁩");
/** Every user value opened in `s` is closed in it, and none closes before opening. */
function balanced(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === "⁨") depth++;
    else if (c === "⁩" && --depth < 0) return false;
  }
  return depth === 0;
}

/** Phrases were extracted from HTML source: decode the entities the DOM shows decoded. */
const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
/** "${icon(…)}저장": a leading {0} there is the button's icon, a separate DOM node.
 * Not "{0}: …" or "{0} · …", where {0} is a value in the text (a device name). */
export const ICON = /^\{0\}(?=[\p{L}\p{N}])/u;

/** Korean counts take no plural, so one phrase serves every number; English
 * does: "1 sessions" → "1 session" (also "1 selected sessions"), never "11". */
const ENGLISH_SINGULAR: Record<string, string> = {
  items: "item", sessions: "session", files: "file", folders: "folder", entries: "entry", lines: "line", tunnels: "tunnel",
  snippets: "snippet", credentials: "credential", matches: "match", ports: "port", tabs: "tab", connections: "connection",
};
const ONE_PLURAL = new RegExp(`(?<![\\d.,])(1 (?:[A-Za-z-]+ )?)(${Object.keys(ENGLISH_SINGULAR).join("|")})\\b`, "g");
/** Outside a user's value (userText): a file named "1 files.txt" stays so. */
export const englishSingulars = (s: string) =>
  s
    .split(/(⁨[^⁩]*⁩)/)
    .map((part) => (part.startsWith("⁨") ? part : part.replace(ONE_PLURAL, (_m, lead: string, noun: string) => lead + ENGLISH_SINGULAR[noun])))
    .join("");

/** `language`: rules that only one language's grammar needs (English counts). */
export function build(entries: { ko: string; t: string }[], language?: string): Tables {
  const exact = new Map<string, string>();
  const patterns: Tables["patterns"] = [];
  for (const entry of entries) {
    let key = norm(decode(entry.ko));
    let en = decode(entry.t);
    if (ICON.test(key) && ICON.test(en) && !/\{[1-9]\}/.test(key)) {
      key = key.replace(ICON, "");
      en = en.replace(ICON, "");
    }
    if (!key || key === en) continue;
    // "<b>키 확인</b>: …": the DOM has a text node per piece between tags.
    const TAG = /<[^>]+>/;
    if (TAG.test(key)) {
      const kp = key.split(TAG);
      const ep = en.split(TAG);
      if (kp.length === ep.length)
        kp.forEach((k, i) => {
          const kk = norm(k);
          if (HANGUL.test(kk) && !/\{\d+\}/.test(kk) && !exact.has(kk)) exact.set(kk, ep[i].trim());
        });
      continue;
    }
    if (!HANGUL.test(key)) continue;
    if (!/\{\d+\}/.test(key)) {
      if (!exact.has(key)) exact.set(key, en);
      continue;
    }
    // "설정을 저장했습니다 ({0}줄): {1}" → /^설정을 저장했습니다 \((.+?)줄\): (.+?)$/
    const order: number[] = [];
    const source = key
      .split(/(\{\d+\})/)
      .map((part) => {
        const m = /^\{(\d+)\}$/.exec(part);
        if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        order.push(Number(m[1]));
        // May be empty: `${hidden ? " · 2개 숨김" : ""}`.
        return "([\\s\\S]*?)";
      })
      .join("");
    const need = key.split(/\{\d+\}/).reduce((a, b) => (b.length > a.length ? b : a), "");
    patterns.push({ re: new RegExp(`^${source}$`), order, en, need, fixed: key.replace(/\{\d+\}/g, "").length, anchored: !key.startsWith("{") });
  }
  // A pattern that starts with fixed text first: it is the outer sentence
  // when a message is joined to another ("저장하지 못했습니다: {0}" holding
  // "로컬 포트를 열 수 없습니다: x"), whose own pattern starts with a value
  // and would otherwise swallow the prefix as that value. Then more fixed
  // text first: more specific. (Not the regex length, which grows with each
  // {n}, so "{0} 정보를 읽을 수 없습니다: {1}" would win over "파일 정보를 읽을
  // 수 없습니다: {0}" and leave "파일" untranslated.) Ties keep the earlier
  // order (longer regex first).
  patterns.sort((a, b) => Number(b.anchored) - Number(a.anchored) || b.fixed - a.fixed || b.re.source.length - a.re.source.length);
  return { exact, patterns, after: language === "en" ? englishSingulars : undefined };
}

/** The translation of a Korean UI text with these tables, or the text itself
 * when unknown. `tr` is used for the pieces (pattern values, " · " parts), so
 * the caller can cache them. */
export function translate(t: Tables, text: string, tr: (s: string) => string): string {
  const core = norm(text);
  const lead = text.match(/^\s*/)![0];
  const tail = text.match(/\s*$/)![0];
  // "(지원하지 않는 장비입니다)": a phrase in parentheses, often a pattern's value.
  const inner = /^\((.+)\)$/.exec(core)?.[1];
  // ": 경고" after "<b>name</b>": a value put right after markup leaves its
  // text node starting with the separator, which no phrase matches.
  const after = /^([:,·—]) (.+)$/.exec(core);
  const hit =
    t.exact.get(core) ??
    translatePattern(t, core, tr) ??
    translateParts(core, tr) ??
    (inner && HANGUL.test(inner) ? wrap(translate(t, inner, tr), inner) : undefined) ??
    (after && HANGUL.test(after[2]) ? prefix(after[1], translate(t, after[2], tr), after[2]) : undefined);
  return hit === undefined ? text : lead + hit + tail;
}

/** The separator back before a translated rest, or undefined when it was not known. */
const prefix = (sep: string, out: string, rest: string) => (out === rest ? undefined : `${sep} ${out}`);

/** "(…)" around a translated phrase, or undefined when it was not known. */
const wrap = (out: string, inner: string) => (out === inner ? undefined : `(${out})`);

/** "연결됨 · 80×24", "이름: 값": several phrases in one text, translated piece by piece. */
function translateParts(core: string, tr: (s: string) => string): string | undefined {
  for (const sep of [" · ", " — ", "\n"]) {
    if (!core.includes(sep)) continue;
    const parts = core.split(sep);
    const out = parts.map((p) => tr(p));
    if (out.some((p, i) => p !== parts[i])) return out.join(sep);
  }
  return undefined;
}

function translatePattern(t: Tables, core: string, tr: (s: string) => string): string | undefined {
  for (const p of t.patterns) {
    if (!core.includes(p.need)) continue;
    const m = p.re.exec(core);
    if (!m) continue;
    const values: string[] = [];
    p.order.forEach((n, i) => (values[n] = m[i + 1]));
    // A phrase may not cut through a user's value: its own words inside the
    // value ("⁨로컬 포트를 열 수 없습니다: x⁩ 을(를) 저장했습니다") are not
    // the sentence's. Try the next phrase.
    if (values.some((v) => v !== undefined && !balanced(v))) continue;
    // Values may themselves be Korean phrases ("{0}: 파일이 없습니다"), but
    // not one marked as the user's own (userText): kept as written.
    const out = p.en.replace(/\{(\d+)\}/g, (_s, n) => {
      const v = values[Number(n)] ?? "";
      return isUserText(v) ? v : tr(v);
    });
    return t.after ? t.after(out) : out;
  }
  return undefined;
}
