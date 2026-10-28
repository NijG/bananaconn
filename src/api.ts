// Typed bridge to the Rust backend. Outside Tauri (plain browser preview) calls
// are routed to an in-memory mock so the UI can be developed and inspected.

import { invoke } from "@tauri-apps/api/core";
import type { ProxyConfig } from "./proxy";
import { listen } from "@tauri-apps/api/event";
import { tr } from "./i18n";

export const isTauri = "__TAURI_INTERNALS__" in window;

/** What ai.rs needs of a provider (no secrets: the key is a vault credential). */
export interface AiProviderWire {
  kind: string;
  baseUrl: string;
  model: string;
  credentialId: string | null;
  cli: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  modified: number | null;
  perm: string | null;
}

export interface Credential {
  id: string;
  name: string;
  username: string;
  kind: "password" | "key";
  keyPath: string | null;
  hasSecret: boolean;
}

export interface TransferProgress {
  transferId: string;
  file: string;
  done: number;
  total: number;
  filesDone: number;
}

type Listener = (payload: any) => void;
const mockListeners = new Map<string, Set<Listener>>();

export type PasteMode = { kind: "echo" } | { kind: "fixed"; lineMs: number; charMs: number };

/** Progress of a paced paste (term::PasteProgress). */
export interface PasteEvent {
  id: string;
  sent: number;
  total: number;
  state: "running" | "done" | "stopped" | "failed";
}

export function mockEmit(event: string, payload: unknown) {
  mockListeners.get(event)?.forEach((l) => l(payload));
}

async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri) return invoke<T>(cmd, args);
  const { mockInvoke } = await import("./mock");
  return mockInvoke(cmd, args) as Promise<T>;
}

export async function on<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (isTauri) return listen<T>(event, (e) => handler(e.payload));
  if (!mockListeners.has(event)) mockListeners.set(event, new Set());
  mockListeners.get(event)!.add(handler);
  return () => mockListeners.get(event)?.delete(handler);
}

/** One step of a proxy forward (proxy.rs): diagnostics, or why it failed. */
export interface ProxyLogEvent {
  id: string;
  line: string;
  error: boolean;
}

export interface TermOpen {
  id: string;
  protocol: "ssh" | "telnet" | "serial";
  /** Serial: the COM port name. */
  host: string;
  port: number | null;
  username: string;
  credentialId: string | null;
  keepalive?: number | null;
  jumpHost?: string;
  forwards?: string;
  compression?: boolean;
  agentForward?: boolean;
  rows: number;
  cols: number;
  serial?: { baud: number; dataBits: number; parity: string; stopBits: number; flow: string; io?: "fast" | "compat" } | null;
  proxy?: ProxyConfig | null;
}

export interface RemoteConnect {
  id: string;
  protocol: "sftp" | "ftp" | "ftps";
  host: string;
  port: number | null;
  username: string;
  credentialId: string | null;
  password?: string | null;
  /** SFTP: fingerprint the user approved after a HOSTKEY_UNKNOWN prompt. */
  trustedFingerprint?: string;
  activeMode?: boolean;
  ftpsMode?: "explicit" | "implicit";
  allowInvalidCert?: boolean;
  /** FTPS: SHA-256 of the one certificate the user pinned after an FTPS_CERT prompt. */
  trustedCert?: string;
  proxy?: ProxyConfig | null;
}

export interface RdpOpen {
  id: string;
  host: string;
  port: number | null;
  username: string;
  domain?: string | null;
  credentialId: string | null;
  password?: string | null;
  width: number;
  height: number;
  /** Local port of an SSH gateway tunnel to the server. */
  tunnelPort?: number | null;
  /** Share the clipboard with the server (CLIPRDR). */
  clipboard?: boolean;
}

/** Events from the built-in RDP client (see rdp-helper). */
export type RdpEvent =
  | { type: "status"; stage: "tcp" | "tls" | "auth" }
  | { type: "cert"; fingerprint: string; previous: string | null }
  | { type: "connected" | "resized"; width: number; height: number }
  /** The server cannot change the resolution during a session. */
  | { type: "resizeUnsupported" }
  /** Files copied on the remote, downloaded for a local paste. */
  | { type: "clipFiles"; state: "downloading" | "ready" | "failed"; done?: number; total?: number; files?: number; message?: string }
  /** A step of the clipboard channel (capabilities, monitorReady, held,
   * ready, rejected, pasteRequest, pasteData, error, unavailable). */
  | { type: "clipboard"; state: string; detail: string }
  | { type: "pointer"; kind: "default" | "hidden" }
  | { type: "pointerBitmap"; width: number; height: number; hotX: number; hotY: number; rgba: string }
  | { type: "error"; kind: string; message: string }
  | { type: "closed"; reason: string }
  | { type: "exit"; code: number | null; detail?: string };

/** A running RDP session's screen-update stream. */
export interface RdpFrames {
  close(): void;
}

const FRAME_ACK = new Uint8Array([1]);

/** Start a built-in RDP session; events and screen updates stream to the
 * callbacks. Screen updates come over the tab's own loopback WebSocket and are
 * acknowledged once `onFrame` has drawn them (the helper waits for that). */
export async function rdpOpen(
  req: RdpOpen,
  onEvent: (e: RdpEvent) => void,
  onFrame: (buf: ArrayBuffer) => void,
  onLost: () => void,
): Promise<RdpFrames> {
  if (!isTauri) {
    const { mockRdpOpen } = await import("./mock");
    await mockRdpOpen(req, onEvent, onFrame);
    return { close() {} };
  }
  const { Channel } = await import("@tauri-apps/api/core");
  const events = new Channel<RdpEvent>();
  events.onmessage = onEvent;
  const url = await invoke<string>("rdp_open", { req, events });
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (m) => {
    try {
      onFrame(m.data as ArrayBuffer);
    } finally {
      if (ws.readyState === WebSocket.OPEN) ws.send(FRAME_ACK);
    }
  };
  // The screen channel failed or broke while the session was meant to run.
  let closing = false;
  ws.onclose = () => !closing && onLost();
  return {
    close: () => {
      closing = true;
      ws.close();
    },
  };
}

export interface FtpServerConfig {
  root: string;
  port: number;
  lan: boolean;
  username: string;
  password: string;
  anonymous: boolean;
  readOnly: boolean;
}

export interface FtpServerStatus {
  running: boolean;
  root: string;
  port: number;
  lan: boolean;
  username: string;
  anonymous: boolean;
  readOnly: boolean;
  addresses: string[];
  uptimeSecs: number;
}

export interface TunnelInfo {
  id: string;
  localPort: number;
  target: string;
  gateway: string;
  active: number;
  total: number;
}

export interface TunnelRequest {
  id: string;
  gatewayHost: string;
  gatewayPort: number | null;
  gatewayUsername: string;
  gatewayCredentialId: string | null;
  password?: string;
  trustedFingerprint?: string;
  targetHost: string;
  targetPort: number;
  localPort: number;
  /** The gateway session's own proxy. */
  gatewayProxy?: ProxyConfig | null;
}

export type FileServerKind = "tftp" | "http";

/** The OpenSSH share for a remote PC: its URL and the lines to run there. */
export interface SshKit {
  url: string;
  /** For Win+R: asks for administrator rights, then sets OpenSSH up. */
  runLine: string;
  /** For a PowerShell already running as administrator. */
  adminLine: string;
  /** Whether this PC found its address toward the remote PC. */
  routed: boolean;
}
/** A step of the OpenSSH setup: here (log, error) or on the remote PC (remote, done, failed). */
export interface SshKitEvent {
  kind: "log" | "error" | "remote" | "done" | "failed";
  text: string;
}

export interface FileServerStatus {
  kind: FileServerKind;
  root: string;
  port: number;
  lan: boolean;
  readOnly: boolean;
  auth: boolean;
  addresses: string[];
}

export const api = {
  sessionsLoad: () => call<Record<string, unknown>[]>("sessions_load"),
  sessionsSave: (sessions: unknown[]) => call<void>("sessions_save", { sessions }),
  readTextFile: (path: string) => call<string>("read_text_file", { path }),
  /** Roaming AppData (where other tools keep their session files). */
  roamingDir: async () => (isTauri ? (await import("@tauri-apps/api/path")).dataDir() : "C:\\Users\\me\\AppData\\Roaming"),
  /** Every *.ext file under a folder, with its path relative to it (session importers). */
  importScan: (root: string, ext: string) => call<{ rel: string; text: string }[]>("import_scan", { root, ext }),
  /** PuTTY / KiTTY / WinSCP sessions as .reg text ("" when the tool was never used). */
  registryExport: (key: string) => call<string>("registry_export", { key }),
  /** The running app's version (tauri.conf.json). */
  appVersion: async () => (isTauri ? (await import("@tauri-apps/api/app")).getVersion() : "0.7.4"),
  /** Compare the update folder's signed latest.json with this version. */
  updateCheck: (source: string, credentialId: string | null) =>
    call<{ current: string; available: string | null; notes: string; notesI18n?: Record<string, string> }>("update_check", { source, credentialId }),
  /** Open the update folder in Explorer (Windows asks for the share's account). */
  updateOpenFolder: (source: string) => call<void>("update_open_folder", { source }),
  /** Verify, close the app, install and restart. */
  updateInstall: (source: string, credentialId: string | null) => call<void>("update_install", { source, credentialId }),

  /** Open a terminal; its output arrives as raw bytes in `onOutput`, and
   * every processed byte must be acknowledged with termAck (flow control).
   * `onExit` gets the exit code, after the last output. */
  termOpen: async (req: TermOpen, onOutput: (bytes: Uint8Array) => void, onExit: (code: number) => void) => {
    if (!isTauri) {
      on<[string, Uint8Array]>("term-output", ([id, bytes]) => id === req.id && onOutput(bytes));
      return call<void>("term_open", { req });
    }
    const { Channel } = await import("@tauri-apps/api/core");
    const output = new Channel<ArrayBuffer | number>();
    output.onmessage = (msg) => (typeof msg === "number" ? onExit(msg) : onOutput(new Uint8Array(msg)));
    return call<void>("term_open", { req, output });
  },
  termAck: (id: string, bytes: number) => call<void>("term_ack", { id, bytes }),
  /** Windows build number (0 when unknown). */
  windowsBuild: () => call<number>("windows_build"),
  /** The Windows display language, as one of the app's languages. */
  osUiLanguage: () => call<string>("os_ui_language"),
  /** Append to the risky-command audit log; returns its path. */
  riskAudit: (event: string, session: string, host: string, rule: string, command: string) =>
    call<string>("risk_audit", { event, session, host, rule, command }),
  termWrite: (id: string, data: string) => call<void>("term_write", { id, data }),
  termResize: (id: string, rows: number, cols: number) => call<void>("term_resize", { id, rows, cols }),
  termClose: (id: string) => call<void>("term_close", { id }),
  termBreak: (id: string) => call<void>("term_break", { id }),
  /** Paste to a device console line by line (paste.rs); progress comes as "term-paste" events. */
  termPaste: (id: string, text: string, mode: PasteMode) => call<void>("term_paste", { id, text, mode }),
  termPasteStop: (id: string) => call<void>("term_paste_stop", { id }),
  monitorStart: (req: {
    id: string;
    protocol: "ssh" | "telnet";
    host: string;
    port: number | null;
    username: string;
    credentialId: string | null;
    password?: string;
    trustedFingerprint?: string;
    noPassword?: boolean;
    proxy?: ProxyConfig | null;
  }) => call<void>("monitor_start", { req }),
  monitorStop: (id: string) => call<void>("monitor_stop", { id }),
  /** No tab of this monitor on screen: pause sampling (or resume). */
  monitorPause: (id: string, paused: boolean) => call<void>("monitor_pause", { id, paused }),
  /** RDP tab off screen (no screen updates) or back. */
  rdpVisible: (id: string, visible: boolean) => call<void>("rdp_visible", { id, visible }),
  /** Running configuration of a monitored network device. */
  monitorBackup: (id: string) => call<string>("monitor_backup", { id }),
  monitorCommands: (id: string) => call<string[]>("monitor_commands", { id }),
  monitorTypes: (id: string, folder: string) => call<string[]>("monitor_types", { id, folder }),
  sshKitStart: (target: string) => call<SshKit>("ssh_kit_start", { target }),
  sshKitStop: () => call<void>("ssh_kit_stop"),
  sshKitAllow: (remote: string, port: number) => call<void>("ssh_kit_allow", { remote, port }),
  // AI (ai.rs): the answer streams back as "ai-stream" events, then "ai-done".
  aiChat: (id: string, provider: AiProviderWire, system: string, messages: { role: string; content: string; attachments?: { mime: string; data: string; name: string }[] }[]) => call<void>("ai_chat", { id, provider, system, messages }),
  aiCancel: (id: string) => call<void>("ai_cancel", { id }),
  aiModels: (provider: AiProviderWire) => call<string[]>("ai_models", { provider }),
  aiCliModels: (cli: string) => call<{ default: string | null; models: [string, string][] }>("ai_cli_models", { cli }),
  aiDetectCli: () => call<{ name: string; path: string; version: string }[]>("ai_detect_cli"),
  /** Busiest processes and file systems of a monitored server. */
  monitorTop: (id: string) => call<{ title: string; lines: string[] }[]>("monitor_top", { id }),
  serialPorts: () => call<{ name: string; description: string }[]>("serial_ports"),
  /** Start logging with these options (null stops it); returns the file path. */
  termSetLogging: (
    id: string,
    options: { path: string; mode: string; linePrefix: string; midnight: boolean; onConnect: string; onDisconnect: string } | null,
  ) => call<string | null>("term_set_logging", { id, options }),
  logsFolder: () => call<string>("logs_folder"),
  saveTextFile: (path: string, content: string) => call<void>("save_text_file", { path, content }),

  remoteConnect: (req: RemoteConnect) => call<{ home: string; banner: string | null }>("remote_connect", { req }),
  remoteDisconnect: (id: string) => call<void>("remote_disconnect", { id }),
  remoteList: (id: string, path: string) => call<FileEntry[]>("remote_list", { id, path }),
  remoteOp: (id: string, op: string, path: string, target?: string, isDir?: boolean) =>
    call<void>("remote_op", { id, op, path, target: target ?? null, isDir: isDir ?? null }),
  transfer: (req: {
    id: string;
    transferId: string;
    direction: "download" | "upload";
    remotePath: string;
    localPath: string;
    isDir: boolean;
  }) => call<{ filesDone: number; skipped: number }>("transfer", { req }),
  transferCancel: (transferId: string) => call<void>("transfer_cancel", { transferId }),
  localHome: () => call<string>("local_home"),
  localList: (path: string) => call<FileEntry[]>("local_list", { path }),
  localOp: (op: string, path: string, target?: string) => call<void>("local_op", { op, path, target: target ?? null }),
  editTempPath: (name: string) => call<string>("edit_temp_path", { name }),
  editTempRelease: (path: string) => call<void>("edit_temp_release", { path }),
  remoteReadText: (id: string, path: string) =>
    call<{ text: string; bom: boolean; stamp: [number, number] }>("remote_read_text", { id, path }),
  /** Returns the file's new stamp. Fails with "CONFLICT::" if it changed since `stamp`. */
  remoteWriteText: (id: string, path: string, text: string, bom: boolean, stamp: [number, number] | null, force: boolean) =>
    call<[number, number]>("remote_write_text", { id, path, text, bom, stamp, force }),
  /** [modified ms, size] */
  localStat: (path: string) => call<[number, number]>("local_stat", { path }),

  rdpLaunch: (req: Record<string, unknown>) => call<void>("rdp_launch", { req }),
  rdpCert: (id: string, accept: boolean) => call<void>("rdp_cert", { id, accept }),
  rdpInput: (id: string, ops: unknown[]) => call<void>("rdp_input", { id, ops }),
  rdpResize: (id: string, width: number, height: number, scale: number | null) => call<void>("rdp_resize", { id, width, height, scale }),
  rdpClose: (id: string) => call<void>("rdp_close", { id }),

  vncProxyStart: (id: string, host: string, port: number) =>
    call<{ url: string }>("vnc_proxy_start", { id, host, port }),
  vncProxyStop: (id: string) => call<void>("vnc_proxy_stop", { id }),
  /** TFTP get (server → PC) or put (PC → server); progress in "tftp-progress". */
  tftpTransfer: (req: { id: string; host: string; port: number | null; remote: string; local: string; direction: "get" | "put"; blockSize: number }) =>
    call<{ bytes: number; blockSize: number; millis: number }>("tftp_transfer", { req }),
  tftpCancel: (id: string) => call<void>("tftp_cancel", { id }),
  /** Bytes relayed from the VNC server so far (status view). */
  vncProxyStats: (id: string) => call<number>("vnc_proxy_stats", { id }),
  vncProxyError: (id: string) => call<string | null>("vnc_proxy_error", { id }),

  /** Fails with "CANCELLED" after netPingCancel(id). */
  netPing: (id: string, host: string, count: number) => call<string>("net_ping", { id, host, count }),
  netPingCancel: (id: string) => call<void>("net_ping_cancel", { id }),
  netPorts: (host: string, ports: number[]) =>
    call<{ port: number; open: boolean; ms: number | null; detail: string }[]>("net_ports", { host, ports }),
  netDns: (host: string) => call<{ addresses: string[]; ms: number }>("net_dns", { host }),
  /** Send a Wake-on-LAN magic packet to a MAC (optionally a subnet broadcast address and port). */
  wakeOnLan: (mac: string, broadcast?: string, port?: number) => call<void>("wake_on_lan", { mac, broadcast: broadcast ?? null, port: port ?? null }),

  fileServerStart: (config: { kind: FileServerKind; root: string; port: number; lan: boolean; readOnly: boolean; username: string; password: string }) =>
    call<FileServerStatus>("file_server_start", { config }),
  fileServerStop: (kind: FileServerKind) => call<void>("file_server_stop", { kind }),
  fileServerStatus: () => call<FileServerStatus[]>("file_server_status"),
  fileServerActive: (kind: FileServerKind) => call<number>("file_server_active", { kind }),

  lockStatus: () => call<{ enabled: boolean; locked: boolean }>("lock_status"),
  lockUnlock: (password: string) => call<void>("lock_unlock", { password }),
  lockLock: () => call<void>("lock_lock"),
  lockSet: (current: string | null, next: string | null) => call<void>("lock_set", { current, new: next }),

  tunnelOpen: (req: TunnelRequest) => call<TunnelInfo>("tunnel_open", { req }),
  /** A local port reaching host:port through the proxy (RDP, VNC). */
  proxyForwardOpen: (id: string, host: string, port: number, proxy: ProxyConfig) => call<number>("proxy_forward_open", { id, host, port, proxy }),
  proxyForwardClose: (id: string) => call<void>("proxy_forward_close", { id }),
  tunnelClose: (id: string) => call<void>("tunnel_close", { id }),
  tunnelList: () => call<TunnelInfo[]>("tunnel_list"),

  ftpServerStart: (config: FtpServerConfig) => call<FtpServerStatus>("ftp_server_start", { config }),
  ftpServerStop: () => call<void>("ftp_server_stop"),
  ftpServerStatus: () => call<FtpServerStatus | null>("ftp_server_status"),

  vaultList: () => call<Credential[]>("vault_list"),
  vaultSave: (cred: Credential, secret: string | null) => call<Credential>("vault_save", { cred, secret }),
  vaultDelete: (id: string) => call<void>("vault_delete", { id }),
  vaultGenerateKey: (path: string, keyType: string, passphrase: string, comment: string) =>
    call<string>("vault_generate_key", { path, keyType, passphrase, comment }),
  vaultPublicKey: (keyPath: string) => call<string>("vault_public_key", { keyPath }),
  vaultReveal: (id: string) => call<string | null>("vault_reveal", { id }),
  vaultDefaultKeyDir: () => call<string>("vault_default_key_dir"),
};

// ---- native dialogs / shell (with browser fallbacks) ----------------------------

export async function pickSavePath(defaultPath: string, filters?: { name: string; extensions: string[] }[]) {
  if (!isTauri) return `C:\\preview\\${defaultPath}`;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath, filters });
}

export async function pickOpenFile(title: string, defaultPath?: string) {
  if (!isTauri) return defaultPath || `C:\\preview\\${title}`;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ title: tr(title), defaultPath, multiple: false, directory: false });
  return typeof res === "string" ? res : null;
}

export async function pickFolder(title: string, defaultPath?: string) {
  if (!isTauri) return defaultPath || "C:\\preview\\shared";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ title, defaultPath, multiple: false, directory: true });
  return typeof res === "string" ? res : null;
}

export async function openExternal(url: string) {
  if (!isTauri) return void window.open(url, "_blank");
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/** Open a local file with its default Windows application. */
export async function openWithDefaultApp(path: string) {
  if (!isTauri) return;
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(path);
}

export async function revealInExplorer(path: string) {
  if (!isTauri) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}
