// A syslog message's priority (RFC 5424 6.2.1, RFC 3164 4.1.1 alike): PRI =
// facility × 8 + severity, written "<189>" at the start of a raw message.
// The names are syslog's own (syslog.h, as rsyslog's "local7.notice"
// selectors write them). Facilities 12 to 15 are named differently from one
// system to another (ntp, security, console, a second clock or cron), so
// they are given by number. No imports: scripts/numbers-check.mjs runs it.

/** Severity names by number, 0 (emerg) to 7 (debug). */
export const SEVERITY = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"];

const FACILITY = ["kern", "user", "mail", "daemon", "auth", "syslog", "lpr", "news", "uucp", "cron", "authpriv", "ftp"];

/** The facility's name ("local7"), or "facility 13" where systems disagree. */
export function facilityName(n: number): string {
  if (n >= 16 && n <= 23) return `local${n - 16}`;
  return FACILITY[n] ?? `facility ${n}`;
}

/** "<189>" (a raw message's PRI, as tcpdump or a relay's log shows it) as
 * "local7.notice"; null for anything else (PRI is 0 to 191, no leading zero
 * but "<0>"). */
export function priText(selection: string): string | null {
  const m = /^<(0|[1-9]\d{0,2})>$/.exec(selection.trim());
  if (!m) return null;
  const pri = Number(m[1]);
  if (pri > 191) return null;
  return `${facilityName(pri >> 3)}.${SEVERITY[pri & 7]}`;
}
