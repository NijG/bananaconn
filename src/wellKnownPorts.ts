// Service names of well-known TCP ports, for the port check's results
// (nettools.ts) and a port number selected in a terminal (numberForms.ts).
// No imports: the Node check scripts load it.

/** IANA service names of well-known TCP ports (the port check is TCP), as the
 * registry writes them, with the common name after a slash where the registry
 * name says little ("ms-wbt-server" is RDP). */
export const WELL_KNOWN_PORTS: Record<number, string> = {
  20: "ftp-data", 21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "domain/DNS", 80: "http", 88: "kerberos",
  110: "pop3", 111: "sunrpc", 119: "nntp", 123: "ntp", 135: "epmap/RPC", 139: "netbios-ssn", 143: "imap", 179: "bgp",
  389: "ldap", 443: "https", 445: "microsoft-ds/SMB", 465: "submissions", 514: "shell/rsh", 515: "printer/LPD",
  587: "submission", 636: "ldaps", 830: "netconf-ssh", 873: "rsync", 990: "ftps", 993: "imaps", 995: "pop3s",
  1433: "ms-sql-s", 1521: "ncube-lm/Oracle", 1723: "pptp", 1883: "mqtt", 2049: "nfs", 3306: "mysql", 3389: "ms-wbt-server/RDP",
  5432: "postgresql", 5900: "rfb/VNC", 5985: "wsman/WinRM", 5986: "wsmans/WinRM", 6379: "redis", 8080: "http-alt",
  8443: "pcsync-https", 9100: "pdl-datastream/JetDirect", 27017: "mongodb",
};

/** The ports a service name stands for, by the names above, any letter case:
 * each part of a "registry/common" name ("ms-wbt-server", "rdp"); a name two
 * ports share gives both ("winrm": 5985, 5986). */
const BY_NAME = new Map<string, number[]>();
for (const [port, names] of Object.entries(WELL_KNOWN_PORTS))
  for (const name of names.toLowerCase().split("/")) BY_NAME.set(name, [...(BY_NAME.get(name) ?? []), Number(port)]);

/** "22, 80, 8000-8010" (or service names: "ssh, https, rdp") → ports; null
 * if any part is neither. At most 64 ports in all ("1-60, 100-160" is 121). */
export function parsePorts(text: string): number[] | null {
  const out = new Set<number>();
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const named = BY_NAME.get(part.toLowerCase());
    if (named) {
      named.forEach((p) => out.add(p));
      continue;
    }
    const m = part.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || a > b || b - a > 64) return null;
    for (let p = a; p <= b; p++) out.add(p);
  }
  return out.size && out.size <= 64 ? [...out] : null;
}
