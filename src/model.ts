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
}

export interface ProtocolInfo {
  label: string;
  color: string;
  port: number;
  icon: string;
  view: ViewKind;
  desc: string;
}

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

/** Accept sessions saved by older builds and drop protocols no longer supported. */
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

/** Parse quick-connect input such as "root@10.0.0.5:2222", "[fe80::1]:22",
 * "fe80::1" or "john@corp.com@10.0.0.5" (the user ends at the last "@"). */
export function parseTarget(text: string): { host: string; port: number | null; username: string } | null {
  const t = text.trim();
  // A bare IPv6 address: two or more colons, no brackets, so no port.
  const v6 = t.match(/^(?:(\S+)@)?([0-9A-Fa-f.]*:[0-9A-Fa-f.]*:[0-9A-Fa-f:.]*(?:%\w+)?)$/);
  if (v6) return { username: v6[1] ?? "", host: v6[2], port: null };
  const m = t.match(/^(?:(\S+)@)?(\[[^\]]+\]|[^:@\s]+)(?::(\d{1,5}))?$/);
  if (!m) return null;
  if (m[3] && !(Number(m[3]) >= 1 && Number(m[3]) <= 65535)) return null;
  return {
    username: m[1] ?? "",
    host: m[2].replace(/^\[|\]$/g, ""),
    port: m[3] ? Number(m[3]) : null,
  };
}
