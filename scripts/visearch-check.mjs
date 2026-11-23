// Check how a search typed in vi, vim or a pager is read (src/viSearch.ts,
// the terminal's search marks): what vi's and vim's expressions find, what a
// pager's are trusted with, which program a command starts, ":set ic", the
// search text's delimiter, and vim's line-number column.
//
//   node scripts/visearch-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { hasCapital, NEW_SEARCH_COMMAND, numberGutter, pagerPattern, searchText, setCaseOptions, viCommand, viPattern } from "../src/viSearch.ts";

let failed = 0;
const fail = (...what) => {
  failed++;
  console.error("FAIL", ...what.map((w) => JSON.stringify(w)));
};
/** What `re` finds in `s`, joined ("-" for nothing, "null" for no pattern). */
const finds = (re, s) => (re ? (s.match(re) ?? []).join("|") || "-" : "null");
const vi = (p, s, opts = {}) => finds(viPattern(p, opts.delim ?? "/", opts.ic ?? false, opts.vim ?? true), s);
const check = (what, got, want) => got !== want && fail(what, got, want);

// vi's expressions (vim's own escapes where the program is vim).
for (const [p, s, want, opts] of [
  ["^host", "host host", "host"],
  ["a^b", "a^b", "a^b"],
  ["end$", "end end", "end"],
  ["a$b", "a$b", "a$b"],
  ["a.c", "abc a.c axc", "abc|a.c|axc"],
  ["ab*c", "ac abc abbbc", "ac|abc|abbbc"],
  ["*x", "*x x", "*x"],
  ["^*x", "*x", "*x"],
  ["[0-9][0-9]*", "port 22 and 8080", "22|8080"],
  ["[^a-z ]", "ab1 c-d", "1|-"],
  ["[[:digit:]]\\+", "a 123 b 45", "123|45"],
  ["[]a]", "x]a", "]|a"],
  ["a[b", "a[b", "a[b"],
  ["\\<ip\\>", "ip zip ipv4 ip", "ip|ip"],
  ["\\(foo\\|bar\\)", "foo bar baz", "foo|bar"],
  ["usr\\/lib", "/usr/lib", "usr/lib"],
  ["why\\?", "why? wh", "why?", { delim: "?" }],
  ["colou\\?r", "color colour", "color|colour"],
  ["\\cerror", "Error ERROR error", "Error|ERROR|error"],
  ["error", "Error ERROR error", "Error|ERROR|error", { ic: true }],
  ["err\\Cor", "Error error", "error", { ic: true }],
  ["\\cerr\\C", "ERR", "ERR"],
  ["a+b(c)", "a+b(c)", "a+b(c)"],
  ["호스트.", "호스트명", "호스트명"],
  ["a\\sb", "a\u00a0b a\tb", "a\tb"],
  ["\\<foo", "éfoo foo", "foo"],
  ["a..b", "a😀b", "-"],
]) check(`vi ${p}`, vi(p, s, opts), want);
// Unknown to us, or slow to match: no pattern (nothing marked).
for (const [p, opts] of [["\\(ab\\)*", {}], ["a\\{2\\}", {}], ["~", {}], [".*.*.*x", {}], ["a*b*c*d", {}], ["[\\d]", {}], ["a\\", {}], ["a\\+b", { vim: false }], ["\\sx", { vim: false }]]) {
  check(`vi null ${p}`, vi(p, "", opts), "null");
}
check("vi two repeats", vi("a.*b.*c", "a1b2c"), "a1b2c");
check("classic \\<\\>", vi("\\<ip\\>", "ip zip", { vim: false }), "ip");

// A pager's: only what every build reads alike.
for (const [p, want] of [
  ["host", "host"], ["^host", "^host"], ["end$", "end$"], ["a.c", "a.c"], ["ab*c", "ab*c"], ["[0-9][0-9]*", "[0-9][0-9]*"],
  ["usr\\/lib", "usr\\/lib"], ["[+]", "[\\+]"],
  ["a+b", null], ["x|y", null], ["(a)", null], ["a{2}", null], ["\\<w\\>", null], ["a^b", null], ["a$b", null], ["*x", null],
  ["^*x", null], ["a\\+b", null], ["[\\d]", null], ["a?b", null], ["a[b", null],
]) check(`pager ${p}`, pagerPattern(p)?.source ?? null, want);

// Which program a command starts.
for (const [c, want] of [
  ["vi /etc/hosts", "vi"], ["sudo vim x", "vim"], ["/usr/bin/vim -R x", "vim"], ["env TERM=vt100 vi x", "vi"], ["view x", "vi"], ["nvim x", "vim"],
  ["vim.tiny x", "vim"], ["visudo", "vi"], ["less x", null], ["cat x | less", null], ["man ls", null], ["sudo -u app vi x", null], ["", null],
]) check(`command ${c}`, viCommand(c), want);

// ":set" lines and the case they set.
const none = { ic: false, scs: false };
for (const [row, from, want] of [
  [":set ic", none, { ic: true, scs: false }],
  [":se noignorecase", { ic: true, scs: false }, none],
  [":set invic", none, { ic: true, scs: false }],
  [":set ic!", none, { ic: true, scs: false }],
  [":set ic scs", none, { ic: true, scs: true }],
  [":setlocal ic", none, { ic: true, scs: false }],
  [":set number", none, null],
  [":set ic?", none, null],
  [":setx ic", none, null],
]) check(`set ${row}`, JSON.stringify(setCaseOptions(row, from)), JSON.stringify(want));
check("capital Error", hasCapital("Error"), true);
check("capital \\S", hasCapital("a\\Sb"), false);

// The search text up to its delimiter, and commands that make a new search.
for (const [row, d, want] of [["foo/e+1", "/", "foo"], ["usr\\/lib/e", "/", "usr\\/lib"], ["/e", "/", ""], ["why\\?", "?", "why\\?"], ["plain", "/", "plain"]]) {
  check(`text ${row}`, searchText(row, d), want);
}
for (const [row, want] of [[":%s/a/b/", true], [":s#a#b#", true], [":g/x/d", true], [":v/x/d", true], [":1,5s/x/y/", true], [":set ic", false], [":sp file", false], [":noh", false]]) {
  check(`new search ${row}`, NEW_SEARCH_COMMAND.test(row), want);
}

// vim's line-number column.
const rows = (...texts) => texts.map((text) => ({ text, status: false }));
check("gutter", numberGutter(rows("  1 host", "  2 foo", "    cont", "~")), 4);
check("no gutter", numberGutter(rows("host 1", "x")), 0);
check("one numbered row", numberGutter(rows("10 apples", "pear 10")), 0);
check("mixed widths", numberGutter(rows("  1 a", "   2 b")), 0);

console.log(failed ? `${failed} problem(s)` : "searches read as vi and the pagers read them");
process.exit(failed ? 1 : 0);
