// Whether a text is JSON as RFC 8259 defines it, and where it first is not:
// the editor asks before saving a broken .json file over the server's (a
// service reading it would fail to start). Pure.

/** Where the text first stops being JSON (a character offset), or null when
 * it is JSON, or when it is not judged: an empty file (a new one), comments
 * (JSON with comments, as tsconfig.json and editor settings files are), or
 * nesting deeper than any configuration file goes. */
export function jsonProblem(text: string): number | null {
  if (!text.trim()) return null;
  let i = 0;
  const NOT_JUDGED = -1;
  const fail = (at: number): never => {
    throw at;
  };
  const ws = () => {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) fail(NOT_JUDGED);
      else return;
    }
  };
  const word = (w: string) => {
    for (let k = 0; k < w.length; k++) if (text[i + k] !== w[k]) fail(i + k);
    i += w.length;
  };
  const digits = () => {
    const from = i;
    while (text[i] >= "0" && text[i] <= "9") i++;
    if (i === from) fail(i);
  };
  const string = () => {
    i++; // the opening quote
    for (;;) {
      if (i >= text.length) fail(i);
      const c = text.charCodeAt(i);
      if (c === 0x22) return void i++;
      if (c < 0x20) fail(i);
      if (c === 0x5c) {
        const e = text[i + 1];
        if (e === "u") {
          if (!/^[0-9A-Fa-f]{4}$/.test(text.slice(i + 2, i + 6))) fail(i);
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else fail(i);
      } else i++;
    }
  };
  // Past a "," that the closing bracket follows: the comma is the mistake
  // (the commonest in a hand-edited file), so it is where the text breaks,
  // not the bracket on the line after it.
  const trailingComma = (close: string) => {
    const comma = i++;
    ws();
    if (text[i] === close) fail(comma);
  };
  const value = (depth: number): void => {
    if (depth > 512) fail(NOT_JUDGED);
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") return void i++;
      for (;;) {
        ws();
        if (text[i] !== '"') fail(i);
        string();
        ws();
        if (text[i] !== ":") fail(i);
        i++;
        value(depth + 1);
        ws();
        if (text[i] === ",") trailingComma("}");
        else if (text[i] === "}") return void i++;
        else fail(i);
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") return void i++;
      for (;;) {
        value(depth + 1);
        ws();
        if (text[i] === ",") trailingComma("]");
        else if (text[i] === "]") return void i++;
        else fail(i);
      }
    }
    if (c === '"') return string();
    if (c === "t") return word("true");
    if (c === "f") return word("false");
    if (c === "n") return word("null");
    if (c === "-" || (c >= "0" && c <= "9")) {
      if (c === "-") i++;
      if (text[i] === "0") i++;
      else digits();
      if (text[i] === ".") {
        i++;
        digits();
      }
      if (text[i] === "e" || text[i] === "E") {
        i++;
        if (text[i] === "+" || text[i] === "-") i++;
        digits();
      }
      return;
    }
    fail(i);
  };
  try {
    value(0);
    ws();
    return i < text.length ? i : null;
  } catch (at) {
    if (typeof at !== "number") throw at;
    return at === NOT_JUDGED ? null : Math.min(at, text.length);
  }
}
