// What a connection's output says about its SSH login. ssh.exe runs in a
// pseudo-console, so its own messages (password and host-key questions,
// warnings, errors) share the terminal with what the server prints; the
// terminal reads them back from there to tell a login that went through from
// one still asking for a password, one that failed, and a network failure
// before the server was ever reached. Pure functions over decoded output.

/** The output as lines of plain text: escape sequences removed, and a cursor
 * move to a row (how the Windows pseudo-console sometimes starts a line)
 * taken as a line break. The last line is the one the cursor is on. */
export function plainLines(text: string): string[] {
  return text
    .replace(/\x1b\[\d*(?:;\d*)?[Hf]/g, "\n")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g, "")
    .split(/\r\n|\r|\n/);
}

/** ssh.exe's own messages while it connects and logs in, sometimes after a
 * "user@host: " prefix. What it prints once a session is up ("Connection to …
 * closed by remote host.", "client_loop: …", "Timeout, server … not
 * responding.") is not among them: those come only after a login went through. */
const SSH_SAYS = new RegExp(
  `^(?:\\S+: )?(?:${[
    "Warning: ",
    "WARNING: ",
    "Load key ",
    "Enter passphrase",
    "Identity added",
    "Permission denied",
    "Received disconnect from ",
    "Disconnected from ",
    "Connection (?:closed|reset|refused|timed out)",
    "ssh: ",
    "kex_exchange_identification",
    "banner exchange",
    "Unable to negotiate",
    "Host key verification failed",
    "Too many authentication failures",
    "No supported authentication methods",
    "The authenticity of host",
    "\\S+ key fingerprint is",
    "This (?:host )?key is not known",
    "Are you sure you want to continue",
    "Please type",
    "@+$",
    "IT IS POSSIBLE",
    "Someone could be",
    "It is also possible",
    "The fingerprint for",
    "Please contact",
    "Add correct host key",
    "Offending ",
    "Host key for ",
    "Permissions for ",
    "It is required that",
    "This private key will be ignored",
    "Bad (?:owner|permissions)",
    "Authenticated to ",
    "Pseudo-terminal will not be allocated",
  ].join("|")})`,
  "i",
);

/** A line that asks for something: a password, passphrase or code, a host
 * key's "yes/no", a login name. Short, and ending in ":" or "?". */
const asks = (line: string) => line.length <= 200 && /\S\s*[:?]\s*$/.test(line);

/** The output ends in a question still waiting for its answer (the cursor
 * is right after it). */
export function asksAtEnd(lines: string[]): boolean {
  return asks(lines[lines.length - 1] ?? "");
}

/** The server itself has spoken since the last question ssh.exe asked (a
 * banner, a shell or device prompt): the login went through. ssh.exe's own
 * messages and blank lines do not count; an answered question that nothing
 * has followed yet (a server taking its time over a wrong password) does not
 * either. */
export function loginThrough(lines: string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || SSH_SAYS.test(line)) continue;
    return !asks(lines[i]);
  }
  return false;
}

const FAILED_AUTH =
  /Permission denied \(|Permission denied, please try again|Too many authentication failures|No supported authentication methods available|Authentications that can continue|Authentication failed|Access denied|account (?:is |has been )?locked|Login incorrect|Login invalid|Bad passwords/i;
const FAILED_HOSTKEY = /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i;

/** Why ssh.exe gave up on the login: "auth" (wrong password or key, too many
 * tries) or "hostkey" (the server's key is unknown or changed). Either keeps
 * failing however often it is retried, and repeated wrong logins are what gets
 * an account or address blocked. Read from ssh.exe's own messages at the very
 * end only: a session that showed such words and then lost its connection ends
 * with what the shell printed, or ssh.exe's drop message, after them. */
export function loginFailure(lines: string[]): "auth" | "hostkey" | null {
  const end: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!SSH_SAYS.test(line) && !FAILED_AUTH.test(line) && !FAILED_HOSTKEY.test(line)) break;
    end.push(line);
  }
  const text = end.join("\n");
  if (FAILED_HOSTKEY.test(text)) return "hostkey";
  if (FAILED_AUTH.test(text)) return "auth";
  return null;
}

/** A key file ssh.exe could not use (missing, not in a format it reads, or
 * readable by other users), so it moved on to other ways of logging in —
 * usually a password the user may not know. From ssh.exe's warning. */
export function unusableKey(lines: string[]): { path: string; why: "missing" | "format" | "permissions" } | null {
  for (const line of lines) {
    let m = /Identity file (.+?) not accessible/i.exec(line);
    if (m) return { path: m[1], why: "missing" };
    m = /Load key "(.+?)": (.+)$/i.exec(line);
    if (m) return { path: m[1], why: /permission|bad owner/i.test(m[2]) ? "permissions" : /no such file|not found|cannot find/i.test(m[2]) ? "missing" : "format" };
    m = /Permissions for '(.+?)' are too open/i.exec(line);
    if (m) return { path: m[1], why: "permissions" };
  }
  return null;
}
