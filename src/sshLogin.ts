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
  return stripEscapes(
    text
      .replace(/\x1b\[\d*(?:;\d*)?[Hf]/g, "\n")
      // A cursor move forward stands for the blanks it skips ("login:" after it).
      .replace(/\x1b\[(\d*)C/g, (_m, n: string) => " ".repeat(Math.min(Number(n) || 1, 200))),
  ).split(/\r\n|\r|\n/);
}

/** Text without its escape sequences (colours, cursor moves, OSC titles,
 * character-set switches such as "ESC ( B" from tput sgr0): what the screen
 * shows of one line of output. */
function stripEscapes(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()*+][ -~]|\x1b[@-Z\\-_]/g, "");
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

/** Words a login question asks with ("Username", "login as", "Login ID",
 * "Account"): one list for every check of a login question. */
export const USER_WORD = String.raw`(?:log ?in(?: as| name| id| account)?|user ?(?:name|id)?|account|로그인|아이디|계정|사용자 ?이름)`;

/** Words a secret is asked with on a line ending in ">" ("Password>", "PIN>",
 * "비밀번호>"): one list for the login check here and the broadcast's, so a
 * question one of them knows is never a device prompt to the other. */
export const SECRET_WORD = String.raw`(?:pass(?:word|phrase|code|wd)?|pin|otp|암호|비밀번호|パスワード|密码|密碼)`;

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
    if (SHELL_PROMPT_SHAPE.test(line)) return true;
    return !asks(lines[i]) && !ANSWERED.test(line) && !ASKS_ANGLE.test(line);
  }
  return false;
}

/** A login or password question with the answer typed after it, echoed back
 * on the same line ("Username: admin", Telnet): the user speaking, not the
 * server. */
const ANSWERED = new RegExp(String.raw`^[^:]{0,40}?\b(?:${USER_WORD}|pass(?:word|phrase|code|wd)?|비밀번호|암호)\s*:\s*\S`, "i");

/** A login question some devices end with ">" ("Username>", "Password>",
 * "Login ID>", "PIN>"), the word on its own (not a host named "vpn-login" or "R1-PASS"). */
const ASKS_ANGLE = new RegExp(String.raw`(?:^|\s)(?:${USER_WORD}|${SECRET_WORD})\s*[>＞]\s*$`, "i");

/** A line asking for a login or a password, or one with its answer echoed
 * after the question: never a device's own command prompt. */
export function asksLogin(line: string): boolean {
  const l = line.trim();
  return asks(l) || ANSWERED.test(l) || ASKS_ANGLE.test(l);
}

/** A shell prompt by its shape ("root@login:~#", "[root@h tmp]#", "PS C:\…>"):
 * the server speaking, whatever words its host or directory name holds. */
const SHELL_PROMPT_SHAPE = /^[\w.-]+@[\w.-]+[:~ ].*[#$%>]$|^\[[^\]\s]+[ @][^\]]*\][#$%]$|^(?:PS )?[A-Za-z]:\\.*>$/;

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
  // Inside quotes OpenSSH for Windows doubles each backslash
  // ('C:\\Users\\me\\key'); the unquoted form is printed as given.
  const quoted = (p: string) => p.replace(/\\\\/g, "\\");
  for (const line of lines) {
    let m = /Identity file (.+?) not accessible/i.exec(line);
    if (m) return { path: m[1], why: "missing" };
    m = /Load key "(.+?)": (.+)$/i.exec(line);
    if (m) return { path: quoted(m[1]), why: /permission|bad owner/i.test(m[2]) ? "permissions" : /no such file|not found|cannot find/i.test(m[2]) ? "missing" : "format" };
    m = /Permissions for '(.+?)' are too open/i.exec(line);
    if (m) return { path: quoted(m[1]), why: "permissions" };
  }
  return null;
}
