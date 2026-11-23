// Check how the editor judges a .json file before saving it (src/jsonCheck.ts):
// JSON as RFC 8259 defines it, where it first breaks, and what is left alone
// (an empty file, comments). Every case that passes is also one JSON.parse
// takes, and every one that fails one it refuses.
//
//   node scripts/json-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import { jsonProblem } from "../src/jsonCheck.ts";

let failed = 0;
const check = (what, got, want) => {
  if (got !== want) {
    failed++;
    console.error("FAIL", JSON.stringify(what), JSON.stringify(got), JSON.stringify(want));
  }
};
const parses = (text) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

// JSON: no problem, and JSON.parse agrees.
for (const text of [
  "{}",
  "[]",
  '{"a": 1, "b": [true, false, null], "c": {"d": "e"}}',
  '  {\r\n  "port": 8080,\r\n  "host": "0.0.0.0"\r\n}\r\n',
  '"text"',
  "0",
  "-0.5e+10",
  "1E3",
  '"\\u00e9\\n\\t\\"\\\\\\/"',
  '["한글", "é"]',
  "\t[ 1 ,2 ]\n",
]) {
  check(`ok ${text}`, jsonProblem(text), null);
  check(`JSON.parse ok ${text}`, parses(text), true);
}

// Not JSON: where it breaks, and JSON.parse refuses it too.
for (const [text, at] of [
  // A trailing comma: the comma itself, not the bracket after it.
  ['{"a": 1,}', 7],
  ['{\n  "a": 1,\n}\n', 10],
  ["[1, 2,]", 5],
  ["[1, 2, ]", 5],
  ["[,]", 1],
  ["[1,,2]", 3],
  ['{"a": 1 "b": 2}', 8],
  ["{a: 1}", 1],
  ["{'a': 1}", 1],
  ['{"a": 01}', 7],
  ['{"a": .5}', 6],
  ['{"a": 1.}', 8],
  ['{"a": tru}', 9],
  ['{"a": "x', 8],
  ['{"a": "\\x"}', 7],
  ['{"a": "\\u12"}', 7],
  ['{"a": "line\nbreak"}', 11],
  ["[1, 2", 5],
  ["[1, 2]]", 6],
  ['{"a": 1}\n{"b": 2}', 9],
  ["[NaN]", 1],
  ["[+1]", 1],
  ['{"a": 1}x', 8],
]) {
  check(`at ${text}`, jsonProblem(text), at);
  check(`JSON.parse refuses ${text}`, parses(text), false);
}

// Not judged: a new empty file, and JSON with comments (tsconfig.json).
for (const text of ["", "  \n", '{\n  // port\n  "port": 1\n}', '{"a": 1, /* note */ "b": 2}', '// all\n{"a": 1,}']) {
  check(`not judged ${JSON.stringify(text)}`, jsonProblem(text), null);
}
// A "//" inside a string is text, not a comment.
check("url in a string", jsonProblem('{"url": "http://x/"}'), null);
check("url, then broken", jsonProblem('{"url": "http://x/",}'), 19);

// Deep nesting is not judged rather than overflowing.
check("deep", jsonProblem("[".repeat(5000) + "]".repeat(5000)), null);

console.log(failed ? `${failed} problem(s)` : "JSON judged as expected");
process.exit(failed ? 1 : 0);
