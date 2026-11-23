// Check what the editor's Tab key indents with (src/indentStyle.ts): a tab
// in Makefiles and tab-indented files, the file's own step of spaces else.
//
//   node scripts/indent-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { indentOf } from "../src/indentStyle.ts";

let failed = 0;
const check = (what, got, want) => {
  if (got !== want) {
    failed++;
    console.error("FAIL", JSON.stringify(what), JSON.stringify(got), JSON.stringify(want));
  }
};
const lines = (...l) => l.join("\n");

for (const [name, text, want] of [
  // Makefiles: a tab, whatever the text (a new, empty one too).
  ["Makefile", "", "\t"],
  ["makefile", lines("all:", "    echo hi"), "\t"],
  ["GNUmakefile", "", "\t"],
  ["rules.mk", "", "\t"],
  // Tab-indented files.
  ["main.go", lines("func main() {", "\tfmt.Println()", "\tif x {", "\t\treturn", "\t}", "}"), "\t"],
  ["fstab", lines("# c", "UUID=1\t/\text4", "\tx", "\ty"), "\t"],
  // Spaces: the step the indents share.
  ["app.py", lines("def f():", "    if x:", "        return 1", "    return 2"), "    "],
  ["a.js", lines("{", "  a: {", "    b: 1", "  }", "}"), "  "],
  ["nginx.conf", lines("server {", "        listen 80;", "        location / {", "                root /x;"), "        "],
  // Mixed, spaces winning; a C comment's one-space lines ignored.
  ["x.c", lines("/*", " * note", " */", "int f() {", "    return 0;", "    \tx;", "\ty;", "}"), "    "],
  // A stray odd indent: the smallest indent.
  ["odd.txt", lines("a", "   b", "    c"), "   "],
  // Wider than 8: eight.
  ["wide.txt", lines("a", "            b"), "        "],
  // CRLF text: the same as LF.
  ["crlf.py", "def f():\r\n    return 1\r\n", "    "],
  // Nothing indented: two spaces (the editor's default).
  ["notes.txt", lines("a", "b"), "  "],
  ["new.sh", "", "  "],
  // YAML: never a tab, even in a file indented with tabs.
  ["bad.yml", lines("a:", "\tb: 1", "\tc: 2"), "  "],
  ["ok.yaml", lines("a:", "    b: 1"), "    "],
]) check(name, indentOf(name, text), want);

// A large file with no common step (4 and 5 spaces): read, not a stack overflow.
const big = Array.from({ length: 300_000 }, (_, i) => (i % 2 ? "     x" : "    y")).join("\n");
let got;
try {
  got = indentOf("big.txt", big);
} catch (e) {
  got = String(e);
}
check("300000 lines of 4 and 5 spaces", got, "    ");

console.log(failed ? `${failed} problem(s)` : "indentation read as expected");
process.exit(failed ? 1 : 0);
