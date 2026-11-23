// Absolute paths on a Linux or Unix server named in a line of terminal output
// ("cat: /var/log/app.log: Permission denied", grep's "/etc/x.conf:12:"),
// to open them from the terminal. Pure.

/** A "/" that starts a path: not inside a word ("and/or", "Gi1/0/1", a
 * prefix "/24"), a URL ("http://h/x"), a home-relative "~/x", a Windows
 * "C:/x", nor a "$VAR/x" or an escaped "\/". Then the usual file-name
 * characters, in segments. */
/** Letters and digits of any script ("/home/사용자/notes.txt" is one path). */
const PATH = /(?<![\p{L}\p{N}_.~/:@$\\-])\/[\p{L}\p{N}_.+@~-]+(?:\/+[\p{L}\p{N}_.+@~-]+)*\/*/gu;

/** The paths in `text`, each with where it is and its tidied form (no
 * doubled or trailing slash, no sentence's full stop after it). "/" alone
 * is not one, nor a path with a "." or ".." part ("/etc/.."): where it
 * leads is not what it says. */
export function findPaths(text: string): { index: number; length: number; path: string; line?: number }[] {
  const out: { index: number; length: number; path: string; line?: number }[] = [];
  for (const m of text.matchAll(PATH)) {
    // "/srv/" is "/srv"; "…/app.log." ends a sentence; "/etc/app/." is the
    // folder itself. A ".." stays, and so is no path to open.
    let raw = m[0].replace(/\/+$/, "");
    if (/[^./]\.+$/.test(raw)) raw = raw.replace(/\.+$/, "");
    else if (raw.endsWith("/.")) raw = raw.slice(0, -2).replace(/\/+$/, "");
    const path = raw.replace(/\/{2,}/g, "/");
    if (path.length < 2 || path.split("/").some((part) => part === "." || part === "..")) continue;
    // A line number right after it, as grep -n and compilers write it
    // ("/etc/x.conf:12:", "main.c:12:5: error"), as sshd -t (OpenSSH's
    // servconf.c: "%s line %d:" and "%s: line %d:") and bash -n ("%s: line
    // %d:") report a fault, or a Python traceback ('File "%s", line %d'):
    // the link covers it too, and the file opens at that line.
    const rest = text.slice(m.index + raw.length);
    const at = /^:(\d{1,7})(?=:|\s|$)/.exec(rest) ?? /^:? line (\d{1,7})(?=:)/.exec(rest) ?? /^", line (\d{1,7})(?!\d)/.exec(rest);
    const line = at && raw.length === m[0].length ? Number(at[1]) : 0;
    if (line > 0) out.push({ index: m.index, length: raw.length + at![0].length, path, line });
    else out.push({ index: m.index, length: raw.length, path });
  }
  return out;
}
