// Values a snippet asks for when it is sent: {{?name}}, or {{?name=default}},
// in its text ("show interface {{?인터페이스}}", "ping {{?대상}} repeat
// {{?횟수=100}}"). A name used twice is asked once and filled in both places.
// "{{?" begins nothing a shell, a Go template ({{.Names}} in docker or
// kubectl output formats) or a device CLI takes, so text without it is sent
// exactly as written.

// Within one line: a value box takes one line, and a mark spanning a line
// break would join the lines it splits.
const VAR = /\{\{\?([^{}=\r\n]+?)(?:=([^{}\r\n]*))?\}\}/g;

export interface SnippetVar {
  name: string;
  /** The default written after "=", or "". */
  value: string;
  /** "=" was written: an empty value is then allowed. */
  hasDefault: boolean;
}

/** The values `text` asks for, in the order they first appear. */
export function snippetVars(text: string): SnippetVar[] {
  const out = new Map<string, SnippetVar>();
  for (const m of text.matchAll(VAR)) {
    const name = m[1].trim();
    if (!name) continue;
    const known = out.get(name);
    if (!known) out.set(name, { name, value: m[2] ?? "", hasDefault: m[2] !== undefined });
    // A default written at a later use counts as well.
    else if (!known.hasDefault && m[2] !== undefined) Object.assign(known, { value: m[2], hasDefault: true });
  }
  return [...out.values()];
}

/** `text` with each {{?name}} replaced by its value; one without a value stays as written. */
export function fillSnippetVars(text: string, values: ReadonlyMap<string, string>): string {
  return text.replace(VAR, (whole, name: string) => values.get(name.trim()) ?? whole);
}
