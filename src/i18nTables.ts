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
  times: "time",
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
    patterns.push({ re: new RegExp(`^${source}$`, "d"), order, en, need, fixed: key.replace(/\{\d+\}/g, "").length, anchored: !key.startsWith("{") });
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
  let hit =
    t.exact.get(core) ??
    ownParts(t, core, tr) ??
    translatePattern(t, core, tr) ??
    translateParts(t, core, tr) ??
    (inner && HANGUL.test(inner) ? wrap(translate(t, inner, tr), inner) : undefined) ??
    (after && HANGUL.test(after[2]) ? prefix(after[1], translate(t, after[2], tr), after[2]) : undefined) ??
    dotted(t, core, tr);
  // A " · " not inside parentheses may still be within one phrase's value
  // ("리소스 표시 오류: {0} · 클릭해 다시 시도" given "시간 초과 · 재시도"):
  // when cutting there left Korean, a phrase read over the whole text that
  // leaves less is the better reading.
  if (core.includes(" · ") && (hit === undefined || koreanLeft(hit) > 0)) {
    const whole = translatePattern(t, core, tr, true);
    if (whole !== undefined && (hit === undefined || koreanLeft(whole) < koreanLeft(hit))) hit = whole;
  }
  return hit === undefined ? text : lead + hit + tail;
}

/** A phrase known only as the tail added after another ("· 저장 안 됨",
 * "· 안전하지 않은 이름·링크 {0}개 건너뜀": `${…}${dirty ? " · 저장 안 됨" : ""}`),
 * met as a piece of its own once the text is cut at its " · ": translated
 * as that tail, without the "·". */
function dotted(t: Tables, core: string, tr: (s: string) => string): string | undefined {
  if (core.startsWith("·")) return undefined;
  const tailed = `· ${core}`;
  const out = t.exact.get(tailed) ?? translatePattern(t, tailed, tr);
  return out?.startsWith("·") ? out.slice(1).trim() : undefined;
}

/** Korean letters still in a translation, a user's own values not counted. */
function koreanLeft(s: string): number {
  return (s.replace(/⁨[^⁨⁩]*⁩/g, "").match(/[가-힣]/g) ?? []).length;
}

/** The separator back before a translated rest, or undefined when it was not known. */
const prefix = (sep: string, out: string, rest: string) => (out === rest ? undefined : `${sep} ${out}`);

/** "(…)" around a translated phrase, or undefined when it was not known. */
const wrap = (out: string, inner: string) => (out === inner ? undefined : `(${out})`);

/** Where `sep` joins phrases in `text`: not inside a user's value (userText),
 * nor inside parentheses, where it is part of one phrase ("장비가 응답하지
 * 않습니다 (show running-config · 마지막 화면: Router#)", a message that is
 * often itself the value of another). */
function cuts(text: string, sep: string): number[] {
  const at: number[] = [];
  let user = 0;
  let paren = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "⁨") user++;
    else if (c === "⁩") user = Math.max(0, user - 1);
    else if (user > 0) continue;
    else if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    else if (paren === 0 && text.startsWith(sep, i)) {
      at.push(i);
      i += sep.length - 1;
    }
  }
  return at;
}

/** `text` split where `sep` joins phrases (cuts). */
function splitOutside(text: string, sep: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const i of cuts(text, sep)) {
    parts.push(text.slice(start, i));
    start = i + sep.length;
  }
  parts.push(text.slice(start));
  return parts;
}

/** Phrases joined by " · " that are each a phrase of their own (known as
 * they are, or a pattern's with its values, or no Korean at all), each
 * translated in full: each one's translation. Before the patterns, as one that holds " · " itself
 * ("{0}개 선택 · {1}") would read "파일 1~2개 선택 · 이름으로 거르기" as its
 * own, with "파일 1~2" for {0}. */
function ownParts(t: Tables, core: string, tr: (s: string) => string): string | undefined {
  if (!core.includes(" · ")) return undefined;
  const parts = splitOutside(core, " · ").map(norm);
  if (parts.length < 2) return undefined;
  const out: string[] = [];
  for (const p of parts) {
    const hit = !HANGUL.test(p) ? p : (t.exact.get(p) ?? translatePattern(t, p, tr));
    // Only one read whole: a broad pattern ("{0}개") leaving Korean in its
    // value ("파일 3" of "완료 · 파일 3개") is no phrase of its own.
    if (hit === undefined || HANGUL.test(hit)) return undefined;
    out.push(hit);
  }
  return out.join(" · ");
}

/** Whether a pattern's values keep to their own phrase: none takes in any of
 * a " · " joining it to another, not even its space ("{0} 전송" over
 * "네트워크 인터페이스 · 전송" would take "네트워크 인터페이스 ·"), unless the
 * value starts with the " · ", as the tail a phrase is given on purpose
 * ("{0}줄 · UTF-8{1}{2}" with " · 저장 안 됨" as {2}, "폴더 {0}개 · 파일
 * {1}개{2}" with " · 2개 숨김 · 1.2 MB"). */
function keepsToOwn(m: RegExpExecArray, at: number[]): boolean {
  for (let i = 1; i < m.length; i++) {
    const span = m.indices?.[i];
    if (!span) continue;
    const [a, b] = span;
    for (const s of at) {
      if (a === s) break;
      if (a < s + 3 && s < b) return false;
    }
  }
  return true;
}

/** Pieces of a " · " text tried as one phrase at most (translateParts). */
const RUN_MAX = 6;

/** "연결됨 · 80×24", "이름: 값": several phrases in one text, translated piece by piece.
 *
 * At " · " a phrase may itself hold the separator ("{0}개 선택 · {1}", "{0}
 * · 누르면 진단 기록"): from the front, the longest run of pieces that is one
 * phrase (exactly, or a pattern whose values keep to it) is taken whole,
 * else the piece alone. "A · 12개 선택 · ⁨x⁩" → "A" · "12개 선택 · ⁨x⁩". */
function translateParts(t: Tables, core: string, tr: (s: string) => string): string | undefined {
  for (const sep of [" · ", " — ", "\n"]) {
    if (!core.includes(sep)) continue;
    const parts = splitOutside(core, sep);
    // Only inside a user's value: not phrases to split (and translating the
    // same text again would never end).
    if (parts.length < 2) continue;
    const out: string[] = [];
    const kept: string[] = [];
    for (let i = 0; i < parts.length; ) {
      // A phrase holds a few " · " at most (the TFTP log line, 5 pieces): a
      // long text is not tried in every run, which grew as its square.
      let len = sep === " · " ? Math.min(parts.length - i, RUN_MAX) : 1;
      let hit: string | undefined;
      // The whole text was tried before it came here.
      for (; len >= 2; len--) {
        if (i === 0 && len === parts.length) continue;
        const run = norm(parts.slice(i, i + len).join(sep));
        hit = t.exact.get(run) ?? translatePattern(t, run, tr);
        if (hit !== undefined) break;
      }
      if (hit === undefined) {
        len = 1;
        hit = tr(parts[i]);
      }
      out.push(hit);
      kept.push(parts.slice(i, i + len).join(sep));
      i += len;
    }
    if (out.some((p, i) => p !== kept[i])) return out.join(sep);
  }
  return undefined;
}

/** A phrase with values (patterns) that reads all of `core`. A value may
 * not reach into the phrases joined to it by " · " (keepsToOwn): "Telnet ·
 * ⁨10.0.0.2⁩ · 23:15부터 연결됨" read as "{0}부터 연결됨" would put all before
 * the last phrase into {0} ("Connected since Telnet · …"), and "키 암호
 * 입력 · …" read as a phrase ending in a value would carry the next one in
 * it untranslated. Such a text is cut into its phrases (translateParts).
 * `whole`: the first phrase that reads it, values reaching or not (translate's
 * last resort). */
function translatePattern(t: Tables, core: string, tr: (s: string) => string, whole = false): string | undefined {
  const at = !whole && core.includes(" · ") ? cuts(core, " · ") : [];
  for (const p of t.patterns) {
    if (!core.includes(p.need)) continue;
    const m = p.re.exec(core);
    if (!m) continue;
    // A phrase may not cut through a user's value: its own words inside the
    // value ("⁨로컬 포트를 열 수 없습니다: x⁩ 을(를) 저장했습니다") are not
    // the sentence's. Try the next phrase.
    if (m.slice(1).some((v) => v !== undefined && !balanced(v))) continue;
    if (at.length && !keepsToOwn(m, at)) continue;
    return fill(t, p, m, tr);
  }
  return undefined;
}

/** A phrase's translation with its values put in. Values may themselves be
 * Korean phrases ("{0}: 파일이 없습니다"), but not one marked as the user's
 * own (userText): kept as written. */
function fill(t: Tables, p: Tables["patterns"][number], m: RegExpExecArray, tr: (s: string) => string): string {
  const values: string[] = [];
  p.order.forEach((n, i) => (values[n] = m[i + 1]));
  const out = p.en.replace(/\{(\d+)\}/g, (_s, n) => {
    const v = values[Number(n)] ?? "";
    return isUserText(v) ? v : tr(v);
  });
  return t.after ? t.after(out) : out;
}
