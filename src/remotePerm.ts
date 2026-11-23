// Unix permissions as the file tab and the editor read and change them:
// a listing's "-rwxr-xr-x" as a mode, which files are scripts, and what
// "chmod +x" makes of a mode. Pure.

/** File names of scripts (shell, Perl, Python, awk): their line endings and
 * execute permission matter once they are on a Linux or Unix server. */
export const SCRIPT_NAME = /\.(?:sh|bash|ksh|zsh|csh|pl|py|awk)$/i;

/** The mode an "-rwsr-xr-x" listing string stands for (setuid, setgid and
 * sticky included), or null when there is none. */
export function modeOf(perm: string | null | undefined): number | null {
  if (!perm || !/^[-dlcbps][-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT]$/.test(perm)) return null;
  let mode = 0;
  [0o4000, 0o2000, 0o1000].forEach((special, i) => {
    const [r, w, x] = perm.slice(1 + 3 * i, 4 + 3 * i);
    const shift = 6 - 3 * i;
    if (r === "r") mode |= 4 << shift;
    if (w === "w") mode |= 2 << shift;
    if ("xst".includes(x)) mode |= 1 << shift;
    if ("sStT".includes(x)) mode |= special;
  });
  return mode;
}

/** The mode as chmod takes it: three digits, four with setuid, setgid or
 * sticky ("4755"). */
export const octal = (mode: number) => (mode > 0o777 ? mode.toString(8).padStart(4, "0") : mode.toString(8).padStart(3, "0"));

/** The permission strings of an "ls -l" listing in a line of output (after
 * an "ls -li" inode or "ls -ls" size too), with a trailing ACL "+", SELinux
 * "." or macOS "@" mark left out of the match. Ten dashes alone are a
 * column's underline far more often than a file nobody may read. */
export function findPerms(text: string): { index: number; length: number; perm: string; mode: number }[] {
  const out: { index: number; length: number; perm: string; mode: number }[] = [];
  const re = /(?<!\S)(?!-{10})[-dlcbps][-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT](?=[.+@]?(?:\s|$))/g;
  for (let m; (m = re.exec(text)); ) {
    const mode = modeOf(m[0]);
    if (mode !== null) out.push({ index: m.index, length: 10, perm: m[0], mode });
  }
  return out;
}

/** A file its owner may read but not run: "chmod +x" would let it run. */
export const lacksExecute = (mode: number) => (mode & 0o400) !== 0 && (mode & 0o100) === 0;

/** "chmod +x" with the usual umask: execute where read is (644 → 755,
 * 600 → 700), as three digits, which leave setuid, setgid and sticky as
 * they are on the server. */
export const withExecute = (mode: number) => ((mode | ((mode & 0o444) >> 2)) & 0o777).toString(8).padStart(3, "0");
