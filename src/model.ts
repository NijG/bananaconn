// Session model and protocol catalogue.

export type Protocol = "ssh" | "telnet" | "serial" | "sftp" | "ftp" | "ftps" | "tftp" | "rdp" | "vnc";

/** How a protocol is presented: in-app terminal, file browser, or embedded remote screen. */
export type ViewKind = "terminal" | "files" | "tftp" | "vnc" | "rdp";

export interface Session {
  id: string;
  name: string;
  protocol: Protocol;
  host: string;
  port: number | null;
  username: string;
  credentialId: string | null;
  folder: string;
  notes: string;
  options: Record<string, unknown>;
  createdAt: number;
  lastUsed: number | null;
  /** Kept on the home screen (set from the session's menu). */
  pinned?: boolean;
}

export interface ProtocolInfo {
  label: string;
  color: string;
  port: number;
  icon: string;
  view: ViewKind;
  desc: string;
}

/** Drag data of rows dragged from a file tab's server pane: their paths, as
 * JSON `{ from, paths }` (a terminal they are dropped on types them). `from`
 * is DRAG_FROM_THIS_APP: a web page dragged into the window may set the same
 * type, never this value. */
export const REMOTE_PATHS_DRAG = "application/x-bananaconn-remote-paths";
export const DRAG_FROM_THIS_APP = crypto.randomUUID();

export const PROTOCOLS: Record<Protocol, ProtocolInfo> = {
  ssh: { label: "SSH", color: "#4ade80", port: 22, icon: "SquareTerminal", view: "terminal", desc: "보안 셸 터미널" },
  telnet: { label: "Telnet", color: "#c084fc", port: 23, icon: "Cable", view: "terminal", desc: "네트워크 장비·레거시 터미널" },
  // `host` holds the COM port name; there is no network port.
  serial: { label: "Serial", color: "#a3e635", port: 0, icon: "Usb", view: "terminal", desc: "COM 포트 콘솔 (장비 콘솔 케이블)" },
  sftp: { label: "SFTP", color: "#38bdf8", port: 22, icon: "FolderLock", view: "files", desc: "SSH 기반 파일 전송" },
  ftp: { label: "FTP", color: "#fb923c", port: 21, icon: "FolderSync", view: "files", desc: "FTP 파일 전송" },
  ftps: { label: "FTPS", color: "#2dd4bf", port: 21, icon: "FolderKey", view: "files", desc: "TLS로 암호화한 FTP" },
  tftp: { label: "TFTP", color: "#facc15", port: 69, icon: "HardDrive", view: "tftp", desc: "장비 설정·이미지 받기/보내기" },
  rdp: { label: "RDP", color: "#60a5fa", port: 3389, icon: "Monitor", view: "rdp", desc: "내장 원격 데스크톱" },
  vnc: { label: "VNC", color: "#f472b6", port: 5900, icon: "ScreenShare", view: "vnc", desc: "내장 VNC 뷰어" },
};

export const PROTOCOL_ORDER: Protocol[] = ["ssh", "telnet", "serial", "sftp", "ftp", "ftps", "tftp", "rdp", "vnc"];

/** Common serial line speeds. */
export const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

/** The SSH keepalive interval stored in a session's options, as the backend
 * takes it: whole seconds 1..3600 (the editor's range), else null for the
 * default (30). Anything else, such as text from an edited backup, would fail
 * the connection. */
export function keepaliveOf(o: Record<string, unknown>): number | null {
  const v = o.keepalive;
  const n = typeof v === "number" || typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 3600 ? n : null;
}

/** Serial line settings stored in a session's options. */
export function serialSettings(o: Record<string, unknown>) {
  const num = (v: unknown, d: number) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    baud: num(o.baud, 9600),
    dataBits: num(o.dataBits, 8),
    parity: o.parity === "odd" || o.parity === "even" ? o.parity : "none",
    stopBits: o.stopBits === 2 || o.stopBits === "2" ? 2 : 1,
    flow: o.flow === "hardware" || o.flow === "software" ? o.flow : "none",
  };
}

/** Default port, which for FTPS depends on explicit (21) vs implicit (990) TLS. */
export function defaultPort(protocol: Protocol, options: Record<string, unknown> = {}): number {
  if (protocol === "ftps" && options.ftpsMode === "implicit") return 990;
  return PROTOCOLS[protocol].port;
}

export function newSession(protocol: Protocol): Session {
  return {
    id: crypto.randomUUID(),
    name: "",
    protocol,
    host: "",
    port: PROTOCOLS[protocol].port,
    username: "",
    credentialId: null,
    folder: "",
    notes: "",
    options: {},
    createdAt: Date.now(),
    lastUsed: null,
  };
}

/** Options that weaken security or reach other hosts; imports must surface them. */
export const SENSITIVE_OPTIONS = [
  "allowInvalidCert",
  "agentForward",
  "forwards",
  "jumpHost",
  "drives",
  // Where a log goes and what it starts with: an imported file could aim it
  // at a script in the Startup folder.
  "logCustom",
  "logPath",
  "logMode",
  "logAuto",
  "logOnConnect",
  "logOnDisconnect",
  "logLinePrefix",
  // A local proxy runs a command on this PC for every connection.
  "proxyLocalCommand",
] as const;

/** Every proxy setting is sensitive, not only the local command: an imported
 * proxy host routes logins through someone else's machine. Matched by prefix so
 * a proxy option added later is covered without touching this list. */
export function isSensitiveOption(key: string): boolean {
  return key.startsWith("proxy") || (SENSITIVE_OPTIONS as readonly string[]).includes(key);
}

/** The sensitive options a session actually sets (empty or off ones do not count). */
export function sensitiveOptionKeys(options: Record<string, unknown>): string[] {
  return Object.keys(options).filter((k) => {
    const v = options[k];
    return isSensitiveOption(k) && v !== undefined && v !== null && v !== false && v !== "";
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Canonical folder path: "/운영/ DB/" → "운영/DB". Folder matching relies on it. */
export function normalizeFolder(path: unknown): string {
  return String(path ?? "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean)
    .join("/");
}

/** Parse a stored or imported session. Anything malformed yields null or a default. */
export function normalizeSession(input: unknown): Session | null {
  if (!isRecord(input)) return null;
  const raw = input;
  const protocol = String(raw.protocol ?? raw.kind ?? "");
  if (!Object.prototype.hasOwnProperty.call(PROTOCOLS, protocol)) return null;
  const p = protocol as Protocol;
  const port = Number(raw.port);
  return {
    id: String(raw.id ?? crypto.randomUUID()),
    name: String(raw.name ?? raw.host ?? "세션"),
    protocol: p,
    host: String(raw.host ?? ""),
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : PROTOCOLS[p].port,
    username: String(raw.username ?? ""),
    credentialId: typeof raw.credentialId === "string" && raw.credentialId ? raw.credentialId : null,
    folder: normalizeFolder(raw.folder),
    notes: String(raw.notes ?? ""),
    options: isRecord(raw.options) ? { ...raw.options } : {},
    createdAt: Number(raw.createdAt ?? Date.now()),
    lastUsed: raw.lastUsed ? Number(raw.lastUsed) : null,
    ...(raw.pinned === true ? { pinned: true } : {}),
  };
}

export function endpoint(s: Pick<Session, "protocol" | "host" | "port" | "username">): string {
  if (s.protocol === "serial") return s.host;
  const user = s.username ? `${s.username}@` : "";
  const port = s.port && s.port !== PROTOCOLS[s.protocol].port ? `:${s.port}` : "";
  // An IPv6 address takes brackets when a port follows ("[::1]:2222").
  const host = port && s.host.includes(":") ? `[${s.host}]` : s.host;
  return `${user}${host}${port}`;
}

/** A saved host that cannot be connected to: one with a space inside. (Other
 * odd forms are left alone: what a host may look like differs by protocol and
 * by the program a session was imported from.) */
export const unusableHost = (host: string) => /\s/.test(host);

/** Whether a value passes the check ssh.exe's arguments get when connecting
 * (term.rs safe_token, with the same `extra` characters allowed). */
export function sshArgOk(value: string, extra = ""): boolean {
  return (
    value !== "" &&
    !value.startsWith("-") &&
    [...value].every((c) => /[A-Za-z0-9._\-@:[\]]/.test(c) || extra.includes(c) || (c > "\x7f" && !/\s/u.test(c)))
  );
}

/** A port forward spec ("8080:localhost:80", "1080"), as term.rs forward_args checks it. */
export const forwardSpecOk = (spec: string) => sshArgOk(spec, "*");

/** A jump host list ("user@bastion:22,next"), as term.rs open_ssh checks it. */
export const jumpHostOk = (jump: string) => sshArgOk(jump.trim(), ",");

/** A saved SSH server as one hop of a jump host list ("user@host:port", the
 * port left out when it is 22). An IPv6 address is always in brackets: ssh -J
 * takes the first ":" of a bare one for the port and refuses it. */
export function jumpHop(s: Pick<Session, "host" | "port" | "username">): string {
  const host = s.host.trim();
  const user = s.username ? `${s.username}@` : "";
  const port = s.port && s.port !== 22 ? `:${s.port}` : "";
  return `${user}${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}${port}`;
}

/** A jump host list as it is kept: each "ssh://user@host:port" URI (which
 * ProxyJump and ssh -J also take) as "user@host:port", the same hop in the
 * form the check above lets through, without spaces or empty hops (which ssh
 * refuses) between the commas. */
export function normalizeJumpHost(jump: string): string {
  return jump
    .split(",")
    .map((j) => j.trim().replace(/^ssh:\/\/([^/?#]+)\/?$/i, "$1"))
    .filter(Boolean)
    .join(",");
}

/** The first port forward line connecting would refuse (term.rs forward_args):
 * each is "L|R|D <spec>"; blank lines and "#" comments are skipped. */
export function badForwardLine(text: string): string | null {
  for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([LRD])\s+(.*)$/i.exec(line);
    if (!m || !forwardSpecOk(m[2].trim())) return line;
  }
  return null;
}

/** What a session search looks in, lower-cased (the sidebar and the command
 * palette both use it, so a query finds the same sessions in either). */
export function sessionSearchText(s: Session): string {
  return [s.name, s.host, s.username, endpoint(s), s.folder, PROTOCOLS[s.protocol].label, s.notes, ...deviceWords(s)].join(" ").toLowerCase();
}

/** What the app recognised of the device behind a session when it last
 * connected (TerminalView.deviceDetected): its kind ("cisco ios"), model or
 * software ("IOS-XE 17.06.04") and host name, so a search for any finds it. */
export function deviceWords(s: Session): string[] {
  const o = s.options;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return [text(o.osKind).replace(/-/g, " "), text(o.osLabel), text(o.osName)].filter(Boolean);
}

/** Parse quick-connect input such as "root@10.0.0.5:2222", "[fe80::1]:22",
 * "fe80::1" or "john@corp.com@10.0.0.5" (the user ends at the last "@"). */
/** A new session's settings for a typed address (the session list's search,
 * the command palette): the protocol its URL scheme names ("telnet://…"),
 * else the one a well-known port stands for, else SSH. Null when the text is
 * no address. */
export function sessionDefaultsFor(text: string): Partial<Session> | null {
  const t = parseTarget(text);
  // A URL of something this app does not open ("https://host"): no address
  // here either, as quick connect refuses it (not an SSH session to a web host).
  if (!t || (hasScheme(text) && !schemeProtocol(text))) return null;
  const byPort: Record<number, Protocol> = { 22: "ssh", 23: "telnet", 21: "ftp", 990: "ftps", 69: "tftp", 3389: "rdp", 5900: "vnc" };
  const protocol = schemeProtocol(text) ?? ((t.port && byPort[t.port]) || "ssh");
  return { protocol, host: t.host, username: t.username, ...(t.port ? { port: t.port } : {}) };
}

/** The protocol a pasted URL's scheme names ("telnet://10.0.0.1" is Telnet,
 * "SFTP://host" SFTP), or null: no scheme, or one that is no protocol here
 * ("https://", and "serial://", which a port name is not written as). */
/** A parsed target written back ("root@10.0.0.1:22"; an IPv6 address with a
 * port in brackets), so that parseTarget reads the same target from it. */
export function formatTarget(t: { username: string; host: string; port: number | null }): string {
  const host = t.port !== null && t.host.includes(":") ? `[${t.host}]` : t.host;
  return `${t.username ? `${t.username}@` : ""}${host}${t.port !== null ? `:${t.port}` : ""}`;
}

export const hasScheme =(text: string) => /^[a-z][\w+.-]*:\/\//i.test(text.trim());

export function schemeProtocol(text: string): Protocol | null {
  const scheme = /^([a-z]+):\/\//i.exec(text.trim())?.[1].toLowerCase();
  return scheme && scheme !== "serial" && Object.hasOwn(PROTOCOLS, scheme) ? (scheme as Protocol) : null;
}

export function parseTarget(text: string): { host: string; port: number | null; username: string } | null {
  // A pasted URL form ("ssh://root@host:22", "sftp://host") keeps its scheme;
  // drop it so the user is not parsed as "ssh://root". A bare IPv6 ("fe80::1")
  // and "COM3:115200" have no "://", so they are untouched.
  // A URL's path, query or fragment ("ssh://host:22/", "https://host/admin")
  // is not part of the target either.
  const raw = text.trim();
  const url = hasScheme(raw);
  let t = url ? raw.replace(/^[a-zA-Z][\w+.-]*:\/\//, "").replace(/[/?#].*$/, "") : raw;
  // "user:password@" (a URL's userinfo, RFC 3986, and the same typed without
  // a scheme; up to the last "@", the user name up to its first ":"): the
  // password is not part of the user name, nor kept anywhere (a session, the
  // quick connect history); the login asks for it as for any other connection.
  const at = t.lastIndexOf("@");
  if (at >= 0 && t.slice(0, at).includes(":")) {
    const user = t.slice(0, at).split(":")[0];
    t = user ? `${user}@${t.slice(at + 1)}` : t.slice(at + 1);
  }
  // A bare IPv6 address: two or more colons, no brackets, so no port.
  const v6 = t.match(/^(?:(\S+)@)?([0-9A-Fa-f.]*:[0-9A-Fa-f.]*:[0-9A-Fa-f:.]*(?:%\w+)?)$/);
  if (v6) return { username: v6[1] ?? "", host: v6[2], port: null };
  // No "/" in a host name: "10.0.0.0/24" is a subnet (a search by network), not a target.
  const m = t.match(/^(?:(\S+)@)?(\[[^\]]+\]|[^:@\s/]+)(?::(\d{1,5}))?$/);
  if (!m) return null;
  if (m[3] && !(Number(m[3]) >= 1 && Number(m[3]) <= 65535)) return null;
  return {
    username: m[1] ?? "",
    host: m[2].replace(/^\[|\]$/g, ""),
    port: m[3] ? Number(m[3]) : null,
  };
}
