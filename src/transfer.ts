// File transfer that reuses a terminal or desktop session's own connection
// details, so a server registered only for SSH/Telnet, or a PC reached by VNC,
// gets a file browser without a second entry. SSH uses SFTP; a host without SSH
// falls back to plain FTP. A VNC-only host (no SSH or FTP server) is not covered
// here — that needs the VNC server's own transfer protocol.

import { api } from "./api";
import { gatewayOf } from "./tunnels";
import { newSession, type Session } from "./model";
import { errorText } from "./ui";

export type FileProtocol = "sftp" | "ftp" | "ftps";

/** Route options carried over so the file browser reaches the host the same way. */
const PROXY_KEYS = ["proxyType", "proxyHost", "proxyPort", "proxyExclude", "proxyLocal", "proxyDns", "proxyCredentialId", "proxyTelnetCommand", "proxyLocalCommand", "proxyDiag"];

/** The port a file protocol uses: SFTP rides the source's SSH port, FTP/FTPS
 * their own (the source's telnet/VNC port must not be reused). */
function portFor(source: Session, protocol: FileProtocol): number {
  if (protocol === "sftp") return source.protocol === "ssh" && source.port ? source.port : 22;
  if (protocol === "ftps") return source.options.ftpsMode === "implicit" ? 990 : 21;
  return 21;
}

/** A quick (unsaved) file-browser session reusing `source`'s host, account and
 * proxy. SSH credentials carry to SFTP; a telnet or VNC login is reused for FTP.
 * An SSH gateway is not reused here — the file backend connects directly, so
 * callers check {@link fileTransferBlockedReason} first. */
export function fileSessionFor(source: Session, protocol: FileProtocol): Session {
  const s = newSession(protocol);
  s.id = `quick-${crypto.randomUUID()}`;
  s.name = `${source.name || source.host} · 파일`;
  s.host = source.host.trim();
  s.port = portFor(source, protocol);
  s.username = source.username;
  s.credentialId = source.credentialId;
  s.folder = source.folder;
  if (protocol === "ftps" && source.options.ftpsMode) s.options.ftpsMode = source.options.ftpsMode;
  // Carry the route the file backend understands (SOCKS/HTTP proxy); it has no
  // SSH-gateway tunneling, so that is handled by the blocked-reason check.
  for (const k of PROXY_KEYS) if (source.options[k] !== undefined) s.options[k] = source.options[k];
  return s;
}

/** Why file transfer can't reuse this session as-is, or null when it can. The
 * file backend dials the host directly, so a jump host or SSH gateway is not
 * supported; this returns a clear message instead of a silent connect failure. */
export function fileTransferBlockedReason(source: Session): string | null {
  if (String(source.options.jumpHost ?? "").trim() || source.options.gateway)
    try {
      // Touch gatewayOf so a deleted-gateway session reports its own error.
      if (source.options.gateway) gatewayOf(source);
      return "점프 호스트나 SSH 게이트웨이를 거치는 세션은 파일 전송을 직접 지원하지 않습니다. 대상에 직접 연결되는 세션에서 사용하세요.";
    } catch (e) {
      return errorText(e);
    }
  return null;
}

/** Which file protocol a non-SSH host answers on: SFTP when port 22 is open,
 * otherwise FTP when 21 is open, else null (nothing to connect to). */
export async function detectFileProtocol(host: string): Promise<FileProtocol | null> {
  try {
    const r = await api.netPorts(host.trim(), [22, 21]);
    const open = (p: number) => r.find((x) => x.port === p)?.open;
    if (open(22)) return "sftp";
    if (open(21)) return "ftp";
  } catch {
    // Unreachable or probe failed: caller treats null as "no file service".
  }
  return null;
}
