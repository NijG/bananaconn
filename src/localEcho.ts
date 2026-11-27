// Local echo for a serial device that does not echo what is typed (a UPS, a
// PLC, a GPS module): the keys typed are also shown, as a reader would expect
// them on the screen. No imports: scripts/echo-check.mjs runs it under Node.

/** Characters two columns wide on the terminal (Hangul, CJK, full-width):
 * a Backspace rubs out both. */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

/** The text to show for typed `data`: printable characters as they are,
 * Enter (CR, LF or CR LF) as a new line, Backspace (DEL or ^H) as the last
 * character echoed on this line rubbed out (`line` keeps what is shown, so
 * the device's prompt before it is never touched), and nothing for an
 * escape sequence (an arrow or function key, Alt with a key) or another
 * control byte, which would move the cursor rather than show what was sent. */
export function localEcho(data: string, line: { text: string } = { text: "" }): string {
  let out = "";
  const chars = Array.from(data);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const code = c.codePointAt(0)!;
    if (c === "\r" || c === "\n") {
      // CR LF is one Enter.
      if (c === "\r" && chars[i + 1] === "\n") i++;
      out += "\r\n";
      line.text = "";
    } else if (code === 0x7f || code === 0x08) {
      const shown = Array.from(line.text);
      const last = shown.pop();
      if (last === undefined) continue;
      line.text = shown.join("");
      out += WIDE.test(last) ? "\b\b  \b\b" : "\b \b";
    } else if (code === 0x1b) {
      // ESC [ … final byte (CSI), ESC O x (SS3), or ESC and one character.
      if (chars[i + 1] === "[") {
        i += 2;
        while (i < chars.length && !/[\x40-\x7e]/.test(chars[i])) i++;
      } else if (chars[i + 1] === "O") i += 2;
      else i++;
    } else if (code >= 0x20 && !(code >= 0x7f && code < 0xa0)) {
      out += c;
      line.text += c;
    }
  }
  return out;
}
