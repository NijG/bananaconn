// Session backup (JSON export/import) and imports from other tools
// (MobaXterm here; the other parsers live in importers.ts).

import { api, pickFolder, pickOpenFile, pickSavePath } from "./api";
import {
  parseCsv,
  parseMRemoteNg,
  parsePuttyReg,
  parseRdcMan,
  parseRdpFiles,
  parseSecureCrtFiles,
  parseSecureCrtXml,
  parseWinScp,
  parseXshellFiles,
} from "./importers";
import type { MenuItem } from "./ui";
import { icon } from "./icons";
import { endpoint, isSensitiveOption, normalizeSession, PROTOCOLS, sensitiveOptionKeys, type Protocol, type Session } from "./model";
import { addFolder, saveSnippets, state, upsertSessions, type Snippet } from "./store";
import { addSavedTunnels, parseTunnel, savedTunnels } from "./tunnels";
import { errorText, esc, modal, timestamp, toast } from "./ui";

// ---- MobaXterm.ini -----------------------------------------------------------------
//
// Seen in MobaXterm.ini files: bookmark sections named "Bookmarks",
// "Bookmarks_N" with "SubRep" (folder) and "ImgNum" keys; session values start
// with " #<type>#<icon>%" using these type codes, and these escape tokens.
// The field order after the icon (host%port%user%…) follows the commonly
// documented MobaXterm format; imports are shown for review before saving.

const MOBA_TYPES: Record<string, Protocol> = {
  "109": "ssh",
  "98": "telnet",
  "91": "rdp",
  "128": "vnc",
  "130": "ftp",
  "140": "sftp",
};

const MOBA_UNSUPPORTED: Record<string, string> = {
  "100": "rlogin",
  "313": "웹 브라우저",
};

const MOBA_ESCAPES: [string, string][] = [
  ["__PTVIRG__", ";"],
  ["__DIEZE__", "#"],
  ["__EQQUAL__", "="],
  ["__EQUAL__", "="],
  ["__POURCENT__", "%"],
  ["__PERCENT__", "%"],
  ["__PIIPE__", "|"],
  ["__PIPE__", "|"],
  ["__DBLQUO__", '"'],
  ["__BACKSLASH__", "\\"],
  ["__DBLDOT__", ":"],
  ["__INF__", "<"],
  ["__SUP__", ">"],
];

function mobaUnescape(s: string): string {
  let out = s;
  for (const [token, ch] of MOBA_ESCAPES) out = out.split(token).join(ch);
  return out.trim();
}

export interface ParsedImport {
  sessions: Session[];
  skipped: { name: string; reason: string }[];
}

/** Parse MobaXterm.ini text into BananaConn sessions (pure; no side effects). */
export function parseMobaXtermIni(text: string, rootFolder: string): ParsedImport {
  const out: ParsedImport = { sessions: [], skipped: [] };
  let inBookmarks = false;
  let folder = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      inBookmarks = /^Bookmarks(_\d+)?$/i.test(section[1]);
      folder = "";
      continue;
    }
    if (!inBookmarks) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (/^SubRep$/i.test(key)) {
      folder = mobaUnescape(value).split("\\").map((p) => p.trim()).filter(Boolean).join("/");
      continue;
    }
    if (/^ImgNum$/i.test(key)) continue;
    const parts = value.trim().split("#");
    // " #109#0%host%22%user%…#MobaFont%…" → ["", "109", "0%host%22%user%…", …]
    if (parts.length < 3 || parts[0] !== "") continue;
    const name = mobaUnescape(key);
    const protocol = MOBA_TYPES[parts[1]];
    if (!protocol) {
      out.skipped.push({ name, reason: MOBA_UNSUPPORTED[parts[1]] ? `${MOBA_UNSUPPORTED[parts[1]]}은(는) 지원하지 않습니다` : `알 수 없는 종류 (${parts[1]})` });
      continue;
    }
    const fields = parts[2].split("%");
    const host = mobaUnescape(fields[1] ?? "");
    if (!host) {
      out.skipped.push({ name, reason: "호스트가 비어 있습니다" });
      continue;
    }
    const port = Number(fields[2]);
    const fullFolder = [rootFolder, folder].filter(Boolean).join("/");
    out.sessions.push({
      id: crypto.randomUUID(),
      name: name || host,
      protocol,
      host,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : PROTOCOLS[protocol].port,
      username: protocol === "vnc" ? "" : mobaUnescape(fields[3] ?? ""),
      credentialId: null,
      folder: fullFolder,
      notes: "MobaXterm에서 가져옴",
      options: {},
      createdAt: Date.now(),
      lastUsed: null,
    });
  }
  return out;
}

// ---- review & save -----------------------------------------------------------------------

function sameTarget(a: Session, b: Session) {
  return a.protocol === b.protocol && a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.username === b.username && a.name === b.name;
}

/** Show what will be imported; resolves after the user saves or cancels. */
/** `tunnels`: SSH tunnels a backup carries; they come along only with the
 * security options (they are port forwards). */
/** `extras`: other things a backup restores (folders, snippets, tunnels)
 * that are missing here; with them the import can be confirmed even when
 * every session already exists. */
function reviewImport(title: string, parsed: ParsedImport, tunnels = 0, extras = 0): Promise<{ saved: number; keep: boolean; confirmed: boolean }> {
  return new Promise((resolve) => {
    const fresh = parsed.sessions.filter((s) => !state.sessions.some((e) => sameTarget(e, s)));
    const dupes = parsed.sessions.length - fresh.length;
    const counts = Object.entries(
      fresh.reduce<Record<string, number>>((acc, s) => ((acc[s.protocol] = (acc[s.protocol] ?? 0) + 1), acc), {}),
    );
    let saved = 0;
    let keep = false;
    let confirmed = false;
    const SENSITIVE_TEXT: Record<string, string> = {
      allowInvalidCert: "인증서 오류 무시",
      agentForward: "SSH 에이전트 전달",
      forwards: "포트 포워딩",
      jumpHost: "점프 호스트",
      drives: "내 PC 드라이브를 RDP 서버에 공유",
      logCustom: "로그 파일 위치·자동 기록",
      logPath: "로그 파일 위치·자동 기록",
      logMode: "로그 파일 위치·자동 기록",
      logAuto: "로그 파일 위치·자동 기록",
      logOnConnect: "로그 파일 위치·자동 기록",
      logOnDisconnect: "로그 파일 위치·자동 기록",
      logLinePrefix: "로그 파일 위치·자동 기록",
      proxyLocalCommand: "로컬 프록시 명령 (이 PC에서 명령 실행)",
    };
    // Any other proxy option (host, port, credential...) shares one label.
    const labelOf = (k: string) => SENSITIVE_TEXT[k] ?? (k.startsWith("proxy") ? "프록시 경유 연결" : k);
    const sensitiveOf = (s: Session) => sensitiveOptionKeys(s.options);
    const risky = fresh.filter((s) => sensitiveOf(s).length);
    const rows = fresh
      .slice(0, 200)
      .map((s) => {
        const p = PROTOCOLS[s.protocol];
        const flags = sensitiveOf(s);
        return `<tr><td><span class="proto-chip" style="--proto:${p.color}">${p.label}</span></td>
          <td>${esc(s.name)}${flags.length ? `<br><small class="warn-text">${icon("ShieldAlert", 12)}${esc([...new Set(flags.map(labelOf))].join(", "))}</small>` : ""}</td>
          <td class="mono">${esc(endpoint(s))}</td><td class="muted">${esc(s.folder || "—")}</td></tr>`;
      })
      .join("");
    const m = modal({
      title,
      icon: "Download",
      width: 760,
      body: `<div class="import-summary">
          <b>${fresh.length}</b>개 세션을 가져옵니다 ${counts.map(([p, n]) => `<span class="muted">${PROTOCOLS[p as Protocol].label} ${n}</span>`).join(" · ")}
          ${dupes ? `<br><span class="muted">이미 있는 세션 ${dupes}개는 건너뜁니다.</span>` : ""}
          ${!fresh.length && extras ? `<br><span class="muted">세션은 모두 이미 있습니다. 백업의 폴더·스니펫·터널 중 없는 것만 복원합니다.</span>` : ""}
          ${parsed.skipped.length ? `<br><span class="muted">가져올 수 없는 항목 ${parsed.skipped.length}개: ${esc(parsed.skipped.slice(0, 4).map((s) => `${s.name} (${s.reason})`).join(", "))}${parsed.skipped.length > 4 ? " 외" : ""}</span>` : ""}
        </div>
        ${fresh.length ? `<div class="import-table"><table><thead><tr><th>종류</th><th>이름</th><th>대상</th><th>폴더</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
        ${risky.length || tunnels ? `<label class="check block import-risky"><input type="checkbox" name="keepSensitive"/>
          <span><b>보안 관련 옵션도 가져오기 (${risky.length}개 세션)</b>${tunnels ? `<small>백업의 SSH 터널 ${tunnels}개는 이 옵션을 켤 때만 가져옵니다.</small>` : ""}
          <small>인증서 오류 무시, 에이전트 전달, 포트 포워딩, 점프 호스트, 프록시, 드라이브 공유, 로그 파일 위치 설정입니다. 직접 만든 백업이 아니라면 끈 채로 두세요. 끄면 이 옵션만 빼고 가져옵니다.</small></span></label>` : ""}
        <p class="muted small">비밀번호는 가져오지 않습니다. 처음 연결할 때 입력하거나 자격 증명 보관함에서 지정하세요.</p>`,
      footer: `<button class="btn" data-close>취소</button>
               <button class="btn btn-primary" data-ok ${fresh.length || extras ? "" : "disabled"}>${icon("Check", 14)}${fresh.length ? `${fresh.length}개 가져오기` : "백업 복원"}</button>`,
      onClose: () => resolve({ saved, keep, confirmed }),
    });
    m.root.querySelector("[data-ok]")!.addEventListener("click", async () => {
      try {
        keep = m.root.querySelector<HTMLInputElement>("[name=keepSensitive]")?.checked ?? false;
        if (!keep)
          for (const s of fresh) for (const k of Object.keys(s.options)) if (isSensitiveOption(k)) delete s.options[k];
        confirmed = true;
        if (fresh.length) {
          await upsertSessions(fresh);
          saved = fresh.length;
          toast(`${saved}개 세션을 가져왔습니다`, "success");
        }
      } catch (err) {
        toast(errorText(err), "error");
      }
      m.close();
    });
  });
}

async function readChosenFile(title: string, defaultPath?: string): Promise<string | null> {
  const path = await pickOpenFile(title, defaultPath);
  if (!path) return null;
  return api.readTextFile(path);
}

export async function importFromMobaXterm() {
  const appData = await api.roamingDir().catch(() => "");
  try {
    const text = await readChosenFile("MobaXterm.ini 선택", appData ? `${appData}\\MobaXterm\\MobaXterm.ini` : undefined);
    if (text === null) return;
    const parsed = parseMobaXtermIni(text, "MobaXterm");
    if (!parsed.sessions.length && !parsed.skipped.length) {
      return toast("이 파일에서 MobaXterm 세션을 찾지 못했습니다", "warn");
    }
    await reviewImport("MobaXterm 세션 가져오기", parsed);
  } catch (err) {
    toast(errorText(err), "error");
  }
}

// ---- other tools --------------------------------------------------------------------------

/** Run an importer: read, parse, then review. Problems become a toast. */
async function runImport(title: string, what: string, load: () => Promise<ParsedImport | null>) {
  try {
    const parsed = await load();
    if (!parsed) return;
    if (!parsed.sessions.length && !parsed.skipped.length) return toast(`${what}에서 세션을 찾지 못했습니다`, "warn");
    await reviewImport(title, parsed);
  } catch (err) {
    toast(err instanceof Error ? err.message : errorText(err), "error", 7000);
  }
}

const appDataDir = () => api.roamingDir().catch(() => "");

export const importSecureCrtFolder = () =>
  runImport("SecureCRT 세션 가져오기", "SecureCRT 세션 폴더", async () => {
    const appData = await appDataDir();
    const dir = await pickFolder("SecureCRT 세션 폴더 선택 (Config\\Sessions)", appData ? `${appData}\\VanDyke\\Config\\Sessions` : undefined);
    return dir ? parseSecureCrtFiles(await api.importScan(dir, "ini")) : null;
  });

export const importSecureCrtXml = () =>
  runImport("SecureCRT 세션 가져오기", "SecureCRT XML", async () => {
    const text = await readChosenFile("SecureCRT에서 내보낸 설정 XML 선택 (파일 → 설정 내보내기)");
    return text === null ? null : parseSecureCrtXml(text);
  });

export const importMRemoteNg = () =>
  runImport("mRemoteNG 연결 가져오기", "mRemoteNG 파일", async () => {
    const appData = await appDataDir();
    const text = await readChosenFile("mRemoteNG confCons.xml 선택", appData ? `${appData}\\mRemoteNG\\confCons.xml` : undefined);
    return text === null ? null : parseMRemoteNg(text);
  });

export const importPutty = (tool: "PuTTY" | "KiTTY") =>
  runImport(`${tool} 세션 가져오기`, `이 PC의 ${tool} 설정`, async () => {
    const key = tool === "PuTTY" ? "HKCU\\Software\\SimonTatham\\PuTTY\\Sessions" : "HKCU\\Software\\9bis.com\\KiTTY\\Sessions";
    return parsePuttyReg(await api.registryExport(key), tool);
  });

export const importWinScp = () =>
  runImport("WinSCP 세션 가져오기", "WinSCP 설정", async () => {
    const reg = await api.registryExport("HKCU\\Software\\Martin Prikryl\\WinSCP 2\\Sessions");
    const fromRegistry = parseWinScp(reg);
    if (fromRegistry.sessions.length || fromRegistry.skipped.length) return fromRegistry;
    // Portable WinSCP keeps its sessions in WinSCP.ini instead.
    const text = await readChosenFile("레지스트리에 WinSCP 세션이 없습니다. WinSCP.ini 선택");
    return text === null ? null : parseWinScp(text);
  });

export const importXshell = () =>
  runImport("Xshell 세션 가져오기", "Xshell 세션 폴더", async () => {
    const dir = await pickFolder("Xshell 세션 폴더 선택 (문서\\NetSarang Computer\\<버전>\\Xshell\\Sessions)");
    return dir ? parseXshellFiles(await api.importScan(dir, "xsh")) : null;
  });

export const importRdcMan = () =>
  runImport("RDCMan 서버 가져오기", "RDCMan 파일", async () => {
    const text = await readChosenFile("Remote Desktop Connection Manager 파일(.rdg) 선택");
    return text === null ? null : parseRdcMan(text);
  });

export const importRdpFiles = () =>
  runImport("원격 데스크톱 파일 가져오기", "선택한 폴더", async () => {
    const dir = await pickFolder(".rdp 파일이 있는 폴더 선택 (하위 폴더 포함)");
    return dir ? parseRdpFiles(await api.importScan(dir, "rdp")) : null;
  });

export const importCsv = () =>
  runImport("CSV에서 세션 가져오기", "CSV 파일", async () => {
    const text = await readChosenFile("CSV 선택 (첫 줄: Name, Protocol, Host, Port, Username, Folder)");
    return text === null ? null : parseCsv(text);
  });

/** Menu of every import source (sidebar, home screen). */
export function importMenuItems(): MenuItem[] {
  return [
    { label: "MobaXterm (MobaXterm.ini)…", icon: "Download", action: () => importFromMobaXterm() },
    { label: "SecureCRT (세션 폴더)…", icon: "Download", action: () => importSecureCrtFolder() },
    { label: "SecureCRT (내보낸 XML)…", icon: "Download", action: () => importSecureCrtXml() },
    { label: "mRemoteNG (confCons.xml)…", icon: "Download", action: () => importMRemoteNg() },
    { label: "PuTTY (이 PC)", icon: "Download", action: () => importPutty("PuTTY") },
    { label: "KiTTY (이 PC)", icon: "Download", action: () => importPutty("KiTTY") },
    { label: "WinSCP (이 PC 또는 WinSCP.ini)", icon: "Download", action: () => importWinScp() },
    { label: "Xshell (세션 폴더)…", icon: "Download", action: () => importXshell() },
    { label: "RDCMan (.rdg)…", icon: "Download", action: () => importRdcMan() },
    { label: "원격 데스크톱 파일 (.rdp 폴더)…", icon: "Download", action: () => importRdpFiles() },
    { label: "CSV…", icon: "Download", action: () => importCsv() },
  ];
}

export async function importFromBackup() {
  try {
    const text = await readChosenFile("BananaConn 세션 백업(JSON) 선택");
    if (text === null) return;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return toast("JSON 형식이 아닙니다", "error");
    }
    const list = Array.isArray(data) ? data : Array.isArray((data as { sessions?: unknown }).sessions) ? (data as { sessions: unknown[] }).sessions : null;
    if (!list) return toast("세션 목록을 찾지 못했습니다", "error");
    const parsed = list.map((raw) => normalizeSession(raw)).filter((s): s is Session => s !== null);
    // New ids for imported sessions; one already here (same target) keeps its id,
    // so SSH gateway references inside the backup can be rewritten to match.
    const ids = new Map<string, string>();
    for (const s of parsed) ids.set(s.id, state.sessions.find((e) => sameTarget(e, s))?.id ?? crypto.randomUUID());
    const sessions = parsed.map((s) => {
      const options = { ...s.options };
      if (typeof options.gateway === "string") {
        const gw = options.gateway;
        const mapped = ids.get(gw) ?? (state.sessions.some((e) => e.id === gw && e.protocol === "ssh") ? gw : undefined);
        if (mapped) options.gateway = mapped;
        else delete options.gateway;
      }
      // Credentials live in this PC's vault: a link is kept when that
      // credential exists here (a restore on the same PC), dropped otherwise.
      const credentialId = s.credentialId && state.credentials.some((c) => c.id === s.credentialId) ? s.credentialId : null;
      return { ...s, id: ids.get(s.id)!, credentialId, options };
    });
    const tunnels = Array.isArray((data as { tunnels?: unknown }).tunnels) ? (data as { tunnels: unknown[] }).tunnels.length : 0;
    const d = data as { folders?: unknown; snippets?: unknown };
    const extras =
      tunnels +
      (Array.isArray(d.folders) ? d.folders.filter((f) => typeof f === "string" && !state.extraFolders.has(f)).length : 0) +
      (Array.isArray(d.snippets) ? missingSnippets(d.snippets).length : 0);
    const { keep, confirmed } = await reviewImport("세션 백업 가져오기", { sessions, skipped: [] }, tunnels, extras);
    if (confirmed) restoreExtras(data, ids, keep);
  } catch (err) {
    toast(errorText(err), "error");
  }
}

/** A backup's snippets that are not here yet, parsed field by field. Each gets
 * a fresh id: the backup's id is untrusted text (it ends up in markup), so a
 * snippet counts as present when its content matches, not its id. */
function missingSnippets(raw: unknown[]): Snippet[] {
  const key = (s: Pick<Snippet, "name" | "text" | "macro" | "group">) => JSON.stringify([s.name, s.text, !!s.macro, s.group ?? ""]);
  const have = new Set(state.snippets.map(key));
  return raw.flatMap((x): Snippet[] => {
    if (!x || typeof x !== "object") return [];
    const s = x as Record<string, unknown>;
    if (typeof s.name !== "string" || typeof s.text !== "string") return [];
    const snippet: Snippet = { id: crypto.randomUUID(), name: s.name, text: s.text, run: s.run === true };
    if (s.macro === true) snippet.macro = true;
    if (typeof s.group === "string" && s.group.trim()) snippet.group = s.group.trim();
    const k = key(snippet);
    if (have.has(k)) return [];
    have.add(k);
    return [snippet];
  });
}

/** Folders, snippets and tunnels of a backup that are missing here. */
function restoreExtras(data: unknown, ids: Map<string, string>, withTunnels: boolean) {
  const d = (data ?? {}) as { folders?: unknown; snippets?: unknown; tunnels?: unknown };
  if (Array.isArray(d.folders)) for (const f of d.folders) if (typeof f === "string") addFolder(f);
  if (Array.isArray(d.snippets)) {
    const add = missingSnippets(d.snippets);
    if (add.length) saveSnippets([...state.snippets, ...add]);
  }
  if (withTunnels && Array.isArray(d.tunnels)) {
    // A tunnel goes through a gateway session: point it at that session here.
    const tunnels = d.tunnels
      .flatMap((raw) => parseTunnel(raw) ?? [])
      .flatMap((t) => {
        const gatewayId = ids.get(t.gatewayId) ?? (state.sessions.some((s) => s.id === t.gatewayId) ? t.gatewayId : null);
        return gatewayId ? [{ ...t, gatewayId }] : [];
      });
    if (tunnels.length) addSavedTunnels(tunnels);
  }
}

export async function exportBackup() {
  if (!state.sessions.length) return toast("내보낼 세션이 없습니다", "warn");
  const path = await pickSavePath(`BananaConn-세션-${timestamp()}.json`, [{ name: "JSON", extensions: ["json"] }]);
  if (!path) return;
  const payload = {
    format: "bananaconn-sessions",
    version: 2,
    exportedAt: new Date().toISOString(),
    // No secrets are stored on sessions. Credential ids only matter on this
    // PC (a restore after an accidental delete keeps the links).
    sessions: state.sessions,
    folders: [...state.extraFolders],
    snippets: state.snippets,
    tunnels: savedTunnels(),
  };
  try {
    await api.saveTextFile(path, JSON.stringify(payload, null, 2));
    toast(`세션 ${state.sessions.length}개를 내보냈습니다`, "success");
  } catch (err) {
    toast(errorText(err), "error");
  }
}
