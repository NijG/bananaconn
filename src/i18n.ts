// Screen languages. The app is written in Korean; in any other language every
// Korean UI text on screen (text, title, placeholder, aria-label) is swapped
// for its translation as it appears, and swapped back when Korean is chosen
// again — no reload, so open connections stay. Translations come from
// i18n/<language>.json (Korean source phrase → translation), extracted from the
// sources: "{0}"-style placeholders stand for values filled in at run time.
//
// Terminal output, the editor and other user data are never touched.

import { build, HANGUL, translate, type Tables } from "./i18nTables";
export { userText } from "./i18nTables";

/** Languages offered, each named in itself (the order of the settings list). */
export const LANGUAGES = [
  ["ko", "한국어"],
  ["en", "English"],
  ["ja", "日本語"],
  ["zh-CN", "简体中文"],
  ["zh-TW", "繁體中文"],
  ["vi", "Tiếng Việt"],
  ["es", "Español"],
  ["fr", "Français"],
  ["de", "Deutsch"],
] as const;
export type Language = (typeof LANGUAGES)[number][0];
export const isLanguage = (x: unknown): x is Language => LANGUAGES.some(([code]) => code === x);

const SKIP = ".xterm, .cm-editor, [data-i18n-skip]";
const ATTRS = ["title", "placeholder", "aria-label"];

/** Each dictionary is loaded (and its patterns built) the first time its
 * language is chosen: Korean, the default, never pays for any at startup. */
const DICTIONARIES = import.meta.glob<{ default: { ko: string; t: string }[] }>("./i18n/*.json");
const loaded = new Map<Language, Promise<Tables | null>>();
function loadDictionary(language: Language): Promise<Tables | null> {
  let p = loaded.get(language);
  if (!p) {
    const load = DICTIONARIES[`./i18n/${language}.json`];
    p = load ? load().then(({ default: entries }) => build(entries, language)) : Promise.resolve(null);
    loaded.set(language, p);
  }
  return p;
}
/** The tables of the language on screen (null: Korean, or still loading). */
let active: Tables | null = null;

/** Results by text for the language on screen: the same labels and file names
 * come up again and again. Bounded; cleared when full or on a language change. */
const memo = new Map<string, string>();
const MEMO_MAX = 20000;

/** The on-screen language's text for a Korean UI text, or the text itself when unknown. */
export function tr(text: string): string {
  if (!active || !HANGUL.test(text)) return text;
  const known = memo.get(text);
  if (known !== undefined) return known;
  const out = translate(active, text, tr);
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(text, out);
  return out;
}

let lang: Language = "ko";
/** Original Korean of what was translated, to put back. */
const originals = new WeakMap<Node, { text?: string; attrs?: Record<string, string> }>();
const touched = new Set<WeakRef<Node>>();
/** Translated nodes are replaced all the time (the status bar every 2 s): drop
 * the dead references whenever the set has doubled, so it stays the size of
 * what is still alive. */
let pruneAt = 1024;
function track(node: Node) {
  touched.add(new WeakRef(node));
  if (touched.size < pruneAt) return;
  for (const ref of touched) {
    const n = ref.deref();
    if (!n || !originals.has(n)) touched.delete(ref);
  }
  pruneAt = Math.max(1024, touched.size * 2);
}
/** What this module wrote last, so its own writes are not translated again. */
const written = new WeakMap<Node, string>();

/** inTree: reached by translateTree's walk, which already left out skipped parts. */
function translateText(node: Text, inTree = false) {
  const value = node.data;
  if (!HANGUL.test(value) || written.get(node) === value) return;
  // Most Korean text in English mode is user data with no translation: find
  // that out (cached) before the costlier ancestor check.
  const en = tr(value);
  if (en === value) return;
  if (!inTree && node.parentElement?.closest(SKIP)) return;
  const o = originals.get(node);
  if (!o) track(node); // once per node, however often its text changes
  originals.set(node, { ...o, text: value });
  written.set(node, en);
  node.data = en;
}

function translateAttrs(el: Element, inTree = false) {
  for (const name of ATTRS) {
    const value = el.getAttribute(name);
    if (!value || !HANGUL.test(value) || written.get(el) === `${name}=${value}`) continue;
    const en = tr(value);
    if (en === value) continue;
    if (!inTree && el.closest(SKIP)) return;
    const o = originals.get(el);
    if (!o) track(el);
    originals.set(el, { ...o, attrs: { ...o?.attrs, [name]: value } });
    written.set(el, `${name}=${en}`);
    el.setAttribute(name, en);
  }
}

function translateTree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return translateText(root as Text);
  if (!(root instanceof Element)) return;
  if (root.closest(SKIP)) return;
  translateAttrs(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n instanceof Element && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n as Text, true);
    else translateAttrs(n as Element, true);
  }
}

const observer = new MutationObserver((records) => {
  for (const r of records) {
    if (r.type === "childList") r.addedNodes.forEach(translateTree);
    else if (r.type === "characterData") translateText(r.target as Text);
    else if (r.type === "attributes") translateAttrs(r.target as Element);
  }
});

function restore() {
  for (const ref of touched) {
    const node = ref.deref();
    const o = node && originals.get(node);
    if (!node || !o) continue;
    if (o.text !== undefined && node.nodeType === Node.TEXT_NODE && (node as Text).data === written.get(node)) (node as Text).data = o.text;
    if (o.attrs && node instanceof Element) for (const [k, v] of Object.entries(o.attrs)) node.setAttribute(k, v);
    originals.delete(node);
    written.delete(node);
  }
  touched.clear();
  pruneAt = 1024;
}

/** Switch the UI language now (and keep following new UI in English). */
export function setLanguage(next: Language) {
  if (next === lang) return;
  lang = next;
  document.documentElement.lang = next;
  // Back to the Korean source first; another language is applied over it.
  observer.disconnect();
  active = null;
  memo.clear();
  restore();
  if (next === "ko") return;
  // Watch at once (nothing added meanwhile is missed); the walk over what is
  // already there waits for the dictionary. A language without its own
  // dictionary shows English.
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  loadDictionary(next)
    .then((t) => t ?? loadDictionary("en"))
    .then((t) => {
      if (lang !== next || !t) return;
      active = t;
      translateTree(document.body);
    });
}

export function language(): Language {
  return lang;
}
