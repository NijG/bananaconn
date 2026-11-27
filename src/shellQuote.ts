// How a path or name is put on a remote shell's command line. Pure.

/** Single-quoted, so no character of the path means anything to the shell. */
export const shellQuote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;

/** A path the '…' quoting (with '\'' for a quote) does not keep whole in
 * every shell: fish reads \' inside quotes as a quote, tcsh expands ! there. */
export const QUOTE_UNSAFE = (path: string) => /[\\!]/.test(path);

export const QUOTE_UNSAFE_TEXT = "이름에 \\ 또는 !가 있어 셸에 따라 다르게 읽히므로 보내지 않습니다";
