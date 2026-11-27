// The grep command for "find text under a server path". Pure (checked by
// scripts/paths-check.mjs); the asking is grepPrompt.ts.

// With its extension: scripts/paths-check.mjs loads this file in Node, which
// resolves no extensionless relative import (Vite and tsc take either).
import { QUOTE_UNSAFE, QUOTE_UNSAFE_TEXT, shellQuote } from "./shellQuote.ts";

/** The command for `text`, "{}" where the quoted path goes. "grep -rnIF":
 * recursive (a file alone too), line numbers, binary files skipped, the text
 * taken as typed (not a pattern); "-i" to ignore case; "--" so neither the
 * text nor the path reads as an option. */
export function grepCommand(text: string, ignoreCase: boolean): string {
  return `grep -rnIF${ignoreCase ? "i" : ""} -- ${shellQuote(text)} {}`;
}

/** Why the text cannot be sent, or null. */
export function grepRefused(text: string): string | null {
  if (/[\x00-\x1f\x7f-\x9f]/.test(text)) return "이름에 제어 문자가 있어 보낼 수 없습니다";
  if (QUOTE_UNSAFE(text)) return QUOTE_UNSAFE_TEXT;
  // The path goes where "{}" is: a "{}" in the text would be taken for it.
  if (text.includes("{}")) return "찾을 글자에 {}는 쓸 수 없습니다";
  return null;
}

/** A recognised system whose stock grep has no "-r" or "-F" (Solaris 10's
 * /usr/bin/grep refuses -r; AIX and HP-UX alike): the item is not offered
 * there. GNU, BSD/macOS and busybox grep take "-rnIF --". */
export function grepUnsupported(deviceKind: string | undefined): boolean {
  return deviceKind === "aix" || deviceKind === "hpux" || deviceKind === "solaris";
}
