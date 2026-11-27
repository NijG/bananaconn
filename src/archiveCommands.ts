// Commands for an archive on a server, put on the SSH terminal's input line
// beside the file tab (offerInTerminal: "{}" is the quoted archive path;
// Enter is the user's): its listing, and its unpacking into its own folder.
//
// tar reads a compressed archive with no option saying how (GNU tar and
// bsdtar both detect gzip, bzip2 and xz when reading), and "-C" names the
// folder to unpack into. "-k" (--keep-old-files) refuses to replace a file
// that is already there: an archive unpacked beside a running service's
// files leaves them as they are. The tar of AIX, HP-UX and Solaris may take
// none of that: not offered there. unzip asks before replacing a file; it
// reads its archive name as a pattern ("*", "?", "[…]", quoted or not), so a
// name holding one could name another archive: not offered then. Pure, with
// only shellQuote (which imports nothing): scripts/paths-check.mjs runs it.

import { shellQuote } from "./shellQuote.ts";

export interface ArchiveCommands {
  /** Lists what is in it, changing nothing. */
  list: string;
  /** Unpacks it into the folder it is in. */
  extract: string;
  /** The program, shown in the menu ("tar", "unzip"). */
  tool: "tar" | "unzip";
}

/** Names tar reads: a tarball, plain or gzip/bzip2/xz-compressed. */
const TAR = /\.(?:tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz)$/i;

/** The commands for the archive at `path` (an absolute server path) on a
 * server of `kind` (the device kind the terminal recognised, if any), or
 * null for a name that is no archive these read. */
export function archiveCommands(path: string, kind?: string): ArchiveCommands | null {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  if (slash < 0 || !name) return null;
  const folder = shellQuote(path.slice(0, slash) || "/");
  if (TAR.test(name)) return kind && /^(?:aix|hpux|solaris)$/.test(kind) ? null : { tool: "tar", list: "tar -tvf {}", extract: `tar -xkf {} -C ${folder}` };
  if (/\.zip$/i.test(name) && !/[*?[]/.test(path)) return { tool: "unzip", list: "unzip -l {}", extract: `unzip {} -d ${folder}` };
  return null;
}
