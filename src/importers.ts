// Parsers for other tools' saved sessions (pure functions; no side effects).
// Passwords are never imported: most tools store them encrypted with their
// own keys, and BananaConn keeps secrets only in the Windows vault.
//
// Formats:
// - SecureCRT: one INI per session under Config\Sessions (folders = tree),
//   lines like  S:"Hostname"=10.0.0.1  D:"[SSH2] Port"=00000016 (hex DWORD);
//   or the XML from File → Export Settings (<key name=…> tree).
// - mRemoteNG: confCons.xml, nested <Node Type="Container|Connection">.
// - PuTTY / KiTTY / WinSCP: registry keys exported as .reg text, or WinSCP.ini.
// - Xshell: *.xsh INI files ([CONNECTION] Host=, Port=, Protocol=).
// - Remote Desktop Connection Manager: *.rdg XML; mstsc: *.rdp files.
// - CSV with a header row (comma, semicolon or tab separated).

import { PROTOCOLS, type Protocol } from "./model";
import type { ParsedImport } from "./importExport";

const empty = (): ParsedImport => ({ sessions: [], skipped: [] });
const joinFolder = (...parts: (string | undefined)[]) =>
  parts
    .flatMap((p) => String(p ?? "").split(/[\\/]/))
    .map((p) => p.trim())
    .filter(Boolean)
    .join("/");

function add(
  out: ParsedImport,
  source: string,
  s: { protocol: Protocol | null; name: string; host: string; port?: number | string | null; username?: string; folder?: string; options?: Record<string, unknown> },
  unsupported?: string,
) {
  const name = s.name.trim() || s.host.trim();
  if (!s.protocol) return out.skipped.push({ name: name || "(이름 없음)", reason: unsupported ? `${unsupported}은(는) 지원하지 않습니다` : "알 수 없는 종류" });
  const host = s.host.trim();
  if (!host) return out.skipped.push({ name: name || "(이름 없음)", reason: "호스트가 비어 있습니다" });
  const n = typeof s.port === "string" ? Number(s.port) : s.port;
  const port = s.protocol === "serial" ? 0 : n && Number.isInteger(n) && n > 0 && n < 65536 ? n : PROTOCOLS[s.protocol].port;
  out.sessions.push({
    id: crypto.randomUUID(),
    name,
    protocol: s.protocol,
    host,
    port,
    username: (s.username ?? "").trim(),
    credentialId: null,
    folder: s.folder ?? "",
    notes: `${source}에서 가져옴`,
    options: s.options ?? {},
    createdAt: Date.now(),
    lastUsed: null,
  });
}

// ---- SecureCRT -------------------------------------------------------------------------------

const CRT_PROTOCOLS: Record<string, Protocol> = { ssh2: "ssh", ssh1: "ssh", telnet: "telnet", serial: "serial", "telnet/ssl": "telnet" };
const CRT_PARITY = ["none", "odd", "even", "none", "none"];

/** Session values from SecureCRT, however they were stored. */
function crtSession(out: ParsedImport, get: (key: string) => string | undefined, name: string, folder: string) {
  const protoName = (get("Protocol Name") ?? "").trim();
  const protocol = CRT_PROTOCOLS[protoName.toLowerCase()] ?? null;
  const num = (key: string) => {
    const v = get(key);
    return v === undefined ? undefined : Number(v);
  };
  const options: Record<string, unknown> = {};
  let host = get("Hostname") ?? "";
  if (protocol === "serial") {
    host = (get("Com Port") ?? "").toUpperCase();
    const parity = num("Parity");
    const stop = num("Stop Bits");
    Object.assign(options, {
      baud: num("Baud Rate") ?? 9600,
      dataBits: num("Data Bits") ?? 8,
      parity: CRT_PARITY[parity ?? 0] ?? "none",
      stopBits: stop === 2 ? 2 : 1,
      flow: num("CTS Flow") || num("RTS Flow") ? "hardware" : num("XON Flow") ? "software" : "none",
      keyMode: "network",
    });
  }
  // Log settings use the same %-tokens as BananaConn.
  const logPath = get("Log Filename V2") ?? get("Log Filename");
  if (logPath) {
    Object.assign(options, {
      logCustom: "session",
      logPath,
      logMode: "append",
      logAuto: num("Start Log Upon Connect") === 1,
      logOnConnect: get("Custom Log Message Connect") ?? "",
      logOnDisconnect: get("Custom Log Message Disconnect") ?? "",
      logLinePrefix: get("Custom Log Message Each Line") ?? "",
    });
  }
  add(
    out,
    "SecureCRT",
    { protocol, name, host, port: protocol === "ssh" ? num("[SSH2] Port") ?? num("[SSH1] Port") : num("Port"), username: get("Username"), folder, options },
    protoName || undefined,
  );
}

/** One session INI file. `rel` is its path under the Sessions folder. */
export function parseSecureCrtFiles(files: { rel: string; text: string }[], rootFolder = "SecureCRT"): ParsedImport {
  const out = empty();
  for (const f of files) {
    const parts = f.rel.split("/");
    const file = parts.pop() ?? "";
    if (/^(__FolderData__|Default)\.ini$/i.test(file)) continue;
    const values = new Map<string, string>();
    for (const line of f.text.replace(/^﻿/, "").split(/\r?\n/)) {
      const m = line.match(/^([SDBZ]):"([^"]+)"=(.*)$/);
      if (!m) continue;
      values.set(m[2], m[1] === "D" ? String(parseInt(m[3], 16)) : m[3]);
    }
    if (!values.has("Protocol Name")) continue;
    crtSession(out, (k) => values.get(k), file.replace(/\.ini$/i, ""), joinFolder(rootFolder, ...parts));
  }
  return out;
}

/** SecureCRT "Export Settings" XML. */
export function parseSecureCrtXml(xml: string, rootFolder = "SecureCRT"): ParsedImport {
  const out = empty();
  const doc = parseXml(xml);
  const sessions = [...doc.querySelectorAll("key")].find((k) => k.getAttribute("name") === "Sessions" && k.parentElement?.tagName === "VanDyke");
  if (!sessions) return out;
  const walk = (node: Element, path: string[]) => {
    for (const child of [...node.children].filter((c) => c.tagName === "key")) {
      const name = child.getAttribute("name") ?? "";
      const values = new Map<string, string>();
      for (const v of child.children) if (v.tagName !== "key") values.set(v.getAttribute("name") ?? "", v.textContent ?? "");
      if (values.has("Protocol Name")) {
        if (name !== "Default") crtSession(out, (k) => values.get(k), name, joinFolder(rootFolder, ...path));
      } else walk(child, [...path, name]);
    }
  };
  walk(sessions, []);
  return out;
}

// ---- mRemoteNG --------------------------------------------------------------------------------

const MRNG_PROTOCOLS: Record<string, Protocol> = { rdp: "rdp", vnc: "vnc", ssh1: "ssh", ssh2: "ssh", telnet: "telnet" };

export function parseMRemoteNg(xml: string, rootFolder = "mRemoteNG"): ParsedImport {
  const out = empty();
  const doc = parseXml(xml);
  const root = doc.documentElement;
  if (root.getAttribute("FullFileEncryption") === "true" || root.getAttribute("FullFileEncryption") === "True") {
    throw new Error("mRemoteNG 파일 전체가 암호화되어 있습니다. mRemoteNG의 옵션 → 보안에서 '전체 파일 암호화'를 끄고 저장한 뒤 다시 가져오세요");
  }
  const walk = (node: Element, path: string[]) => {
    for (const n of [...node.children].filter((c) => c.tagName === "Node")) {
      const name = n.getAttribute("Name") ?? "";
      if ((n.getAttribute("Type") ?? "").toLowerCase() === "container") {
        walk(n, [...path, name]);
        continue;
      }
      const proto = (n.getAttribute("Protocol") ?? "").toLowerCase();
      const domain = n.getAttribute("Domain") ?? "";
      const protocol = MRNG_PROTOCOLS[proto] ?? null;
      add(
        out,
        "mRemoteNG",
        {
          protocol,
          name,
          host: n.getAttribute("Hostname") ?? "",
          port: n.getAttribute("Port"),
          username: n.getAttribute("Username") ?? "",
          folder: joinFolder(rootFolder, ...path),
          options: protocol === "rdp" && domain ? { domain } : {},
        },
        n.getAttribute("Protocol") ?? undefined,
      );
    }
  };
  walk(root, []);
  return out;
}

// ---- registry (.reg) and WinSCP.ini -----------------------------------------------------------

/** .reg / INI sections → name → values. Section names keep their path tail after `base`. */
function iniSections(text: string, base: RegExp): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      const m = sec[1].match(base);
      current = m ? new Map() : null;
      if (m && m[1]) sections.set(m[1], current!);
      continue;
    }
    if (!current) continue;
    // .reg: "Name"="value" / "Name"=dword:00000016 ; INI: Name=value
    const reg = line.match(/^"((?:[^"\\]|\\.)*)"=(?:"((?:[^"\\]|\\.)*)"|dword:([0-9a-fA-F]{8}))$/);
    if (reg) current.set(reg[1], reg[3] !== undefined ? String(parseInt(reg[3], 16)) : reg[2].replace(/\\(.)/g, "$1"));
    else {
      const eq = line.indexOf("=");
      if (eq > 0 && !line.startsWith(";")) current.set(line.slice(0, eq), line.slice(eq + 1));
    }
  }
  return sections;
}

/** PuTTY/WinSCP escape session names as %XX bytes, in UTF-8 or in the
 * system code page (CP949 on Korean Windows): decode the bytes, UTF-8 first. */
const unescapeName = (s: string) => {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (const part of s.match(/%[0-9a-fA-F]{2}|[^%]+|%/g) ?? []) {
    if (/^%[0-9a-fA-F]{2}$/.test(part)) bytes.push(parseInt(part.slice(1), 16));
    else bytes.push(...enc.encode(part));
  }
  const raw = Uint8Array.from(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return new TextDecoder("euc-kr").decode(raw);
  }
};

/** "host", "host:port", "[v6]:port" or a bare IPv6 address (several colons, no port). */
function splitHostPort(address: string): [string, string | undefined] {
  const bracket = address.match(/^\[(.+)\](?::(\d+))?$/);
  if (bracket) return [bracket[1], bracket[2]];
  const colons = address.split(":").length - 1;
  if (colons === 1) {
    const [h, port] = address.split(":");
    return [h, port];
  }
  return [address, undefined];
}

/** An XML document, or an error when the file is malformed (the browser's
 * parser does not throw; it would silently return what it read so far). */
function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const bad = doc.querySelector("parsererror");
  if (bad) throw new Error(`XML 파일이 손상되어 읽을 수 없습니다: ${(bad.querySelector("div")?.textContent ?? bad.textContent ?? "").trim().split("\n")[0]}`);
  return doc;
}

const PUTTY_PROTOCOLS: Record<string, Protocol> = { ssh: "ssh", telnet: "telnet", serial: "serial" };

/** PuTTY or KiTTY sessions from `reg export` text. */
export function parsePuttyReg(text: string, source: "PuTTY" | "KiTTY"): ParsedImport {
  const out = empty();
  const sections = iniSections(text, /\\Sessions\\([^\\]+)$/i);
  for (const [raw, v] of sections) {
    const name = unescapeName(raw);
    if (name === "Default Settings") continue;
    const proto = (v.get("Protocol") ?? "ssh").toLowerCase();
    const protocol = PUTTY_PROTOCOLS[proto] ?? null;
    const serial = protocol === "serial";
    // HostName may carry the user: "root@10.0.0.1".
    const hostName = v.get("HostName") ?? "";
    const at = hostName.lastIndexOf("@");
    const host = at > 0 ? hostName.slice(at + 1) : hostName;
    const username = v.get("UserName") || (at > 0 ? hostName.slice(0, at) : "");
    // PuTTY: parity 0 none / 1 odd / 2 even; stop bits in halves; flow 0 none,
    // 1 XON/XOFF (its default), 2 RTS/CTS.
    const parity = ["none", "odd", "even"][Number(v.get("SerialParity") ?? 0)] ?? "none";
    const flow = ({ "0": "none", "1": "software", "2": "hardware" } as Record<string, string>)[v.get("SerialFlowControl") ?? "1"] ?? "none";
    add(
      out,
      source,
      {
        protocol,
        name,
        host: serial ? (v.get("SerialLine") ?? "").toUpperCase() : host,
        port: v.get("PortNumber"),
        username,
        folder: source,
        options: serial
          ? { baud: Number(v.get("SerialSpeed") ?? 9600), dataBits: Number(v.get("SerialDataBits") ?? 8), parity, stopBits: Number(v.get("SerialStopHalfbits") ?? 2) >= 4 ? 2 : 1, flow, keyMode: "network" }
          : {},
      },
      proto,
    );
  }
  return out;
}

/** WinSCP sessions from the registry export or WinSCP.ini ("Folder/Name" names). */
export function parseWinScp(text: string): ParsedImport {
  const out = empty();
  const sections = iniSections(text, /^(?:.*\\)?Sessions\\(.+)$/i);
  for (const [raw, v] of sections) {
    const full = unescapeName(raw);
    if (full === "Default Settings") continue;
    const parts = full.split("/");
    const name = parts.pop() ?? full;
    // FSProtocol: 0 SCP, 1 SFTP (SCP fallback), 2 SFTP, 5 FTP, 6 WebDAV, 7 S3. Ftps: 0 none, 1 implicit, 3 explicit.
    const fs = Number(v.get("FSProtocol") ?? 2);
    const ftps = Number(v.get("Ftps") ?? 0);
    const protocol: Protocol | null = fs === 5 ? (ftps ? "ftps" : "ftp") : fs <= 2 ? "sftp" : null;
    add(
      out,
      "WinSCP",
      {
        protocol,
        name,
        host: v.get("HostName") ?? "",
        port: v.get("PortNumber") ?? (protocol === "ftps" && ftps === 1 ? 990 : undefined),
        username: v.get("UserName"),
        folder: joinFolder("WinSCP", ...parts),
        options: protocol === "ftps" ? { ftpsMode: ftps === 1 ? "implicit" : "explicit" } : {},
      },
      fs === 6 ? "WebDAV" : fs === 7 ? "S3" : undefined,
    );
  }
  return out;
}

// ---- Xshell -----------------------------------------------------------------------------------

export function parseXshellFiles(files: { rel: string; text: string }[]): ParsedImport {
  const out = empty();
  for (const f of files) {
    const parts = f.rel.split("/");
    const file = parts.pop() ?? "";
    const sections = iniSections(f.text, /^(.+)$/);
    const conn = sections.get("CONNECTION");
    if (!conn) continue;
    const proto = (conn.get("Protocol") ?? "").toUpperCase();
    const protocol: Protocol | null = proto === "SSH" ? "ssh" : proto === "TELNET" ? "telnet" : null;
    add(
      out,
      "Xshell",
      {
        protocol,
        name: file.replace(/\.xsh$/i, ""),
        host: conn.get("Host") ?? "",
        port: conn.get("Port"),
        username: sections.get("CONNECTION:AUTHENTICATION")?.get("UserName"),
        folder: joinFolder("Xshell", ...parts),
      },
      proto || undefined,
    );
  }
  return out;
}

// ---- RDCMan and .rdp ----------------------------------------------------------------------------

export function parseRdcMan(xml: string): ParsedImport {
  const out = empty();
  const doc = parseXml(xml);
  const direct = (el: Element, tag: string) => [...el.children].find((c) => c.tagName === tag);
  const prop = (el: Element, tag: string) => (direct(el, "properties") ? direct(direct(el, "properties")!, tag) : direct(el, tag))?.textContent?.trim() ?? "";
  const walk = (node: Element, path: string[]) => {
    for (const child of node.children) {
      if (child.tagName === "group" || child.tagName === "file") walk(child, [...path, prop(child, "name")]);
      else if (child.tagName === "server") {
        const host = prop(child, "name");
        const creds = direct(child, "logonCredentials");
        const [hostOnly, port] = splitHostPort(host);
        const settings = direct(child, "connectionSettings");
        const settingsPort = settings ? direct(settings, "port")?.textContent?.trim() : undefined;
        add(out, "RDCMan", {
          protocol: "rdp",
          name: prop(child, "displayName") || host,
          host: hostOnly,
          port: port ?? settingsPort ?? 3389,
          username: creds ? (direct(creds, "userName")?.textContent ?? "") : "",
          folder: joinFolder("RDCMan", ...path),
          options: creds && direct(creds, "domain")?.textContent ? { domain: direct(creds, "domain")!.textContent!.trim() } : {},
        });
      }
    }
  };
  walk(doc.documentElement, []);
  return out;
}

export function parseRdpFiles(files: { rel: string; text: string }[]): ParsedImport {
  const out = empty();
  for (const f of files) {
    const parts = f.rel.split("/");
    const file = parts.pop() ?? "";
    const v = new Map<string, string>();
    for (const line of f.text.replace(/^﻿/, "").split(/\r?\n/)) {
      const m = line.match(/^([^:]+):[si]:(.*)$/);
      if (m) v.set(m[1].trim().toLowerCase(), m[2].trim());
    }
    const address = v.get("full address") ?? "";
    const [host, port] = splitHostPort(address);
    let user = v.get("username") ?? "";
    let domain = "";
    if (user.includes("\\")) [domain, user] = user.split("\\");
    add(out, "원격 데스크톱 파일", {
      protocol: "rdp",
      name: file.replace(/\.rdp$/i, ""),
      host,
      port: port ?? v.get("server port") ?? 3389,
      username: user,
      folder: joinFolder("RDP 파일", ...parts),
      options: domain ? { domain } : {},
    });
  }
  return out;
}

// ---- CSV ----------------------------------------------------------------------------------------

/** CSV records: a quoted field may contain the separator, "" and line breaks. */
function csvRecords(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) row.push(cur.trim()), (cur = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur.trim());
      rows.push(row);
      row = [];
      cur = "";
    } else cur += c;
  }
  row.push(cur.trim());
  rows.push(row);
  return rows.filter((r) => r.some((c) => c));
}

const CSV_PROTOCOLS: Record<string, Protocol> = {
  ssh: "ssh", ssh2: "ssh", ssh1: "ssh", telnet: "telnet", rdp: "rdp", vnc: "vnc", sftp: "sftp", ftp: "ftp", ftps: "ftps", serial: "serial",
};

/** CSV with a header row; columns are found by name (mRemoteNG's CSV export works too). */
export function parseCsv(text: string): ParsedImport {
  const out = empty();
  const body = text.replace(/^﻿/, "");
  const head = body.split(/\r?\n/).find((l) => l.trim());
  if (!head) return out;
  const sep = [";", "\t", ","].map((s) => [s, head.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const records = csvRecords(body, sep);
  const cols = records[0].map((c) => c.toLowerCase().replace(/[\s_-]/g, ""));
  const col = (...names: string[]) => cols.findIndex((c) => names.includes(c));
  const at = { name: col("name", "이름", "sessionname"), host: col("host", "hostname", "address", "ip", "호스트"), port: col("port", "포트"), user: col("username", "user", "사용자"), proto: col("protocol", "type", "프로토콜"), folder: col("folder", "group", "path", "panel", "폴더"), domain: col("domain", "도메인") };
  if (at.host < 0) throw new Error("CSV 첫 줄에 호스트 열(Host, Hostname, Address 중 하나)이 있어야 합니다");
  for (const c of records.slice(1)) {
    const get = (i: number) => (i >= 0 ? c[i] ?? "" : "");
    const proto = get(at.proto).toLowerCase() || "ssh";
    const protocol = CSV_PROTOCOLS[proto] ?? null;
    add(
      out,
      "CSV",
      { protocol, name: get(at.name), host: get(at.host), port: get(at.port), username: get(at.user), folder: joinFolder("CSV", get(at.folder)), options: protocol === "rdp" && get(at.domain) ? { domain: get(at.domain) } : {} },
      proto,
    );
  }
  return out;
}
