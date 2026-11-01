// Session backup (JSON export/import) and imports from other tools (the
// parsers live in importers.ts; here: reading the files, review and saving).

import { api, pickFolder, pickOpenFile, pickSavePath, type ImportKeyKind } from "./api";
import {
  parseCsv,
  parseMobaXtermIni,
  parseMRemoteNg,
  parsePuttyReg,
  parseRdcMan,
  parseRdpFiles,
  parseSecureCrtFiles,
  parseSecureCrtXml,
  parseSshConfig,
  parseWinScp,
  parseXshellFiles,
  secureCrtGlobalKey,
  type ParsedImport,
} from "./importers";
import type { MenuItem } from "./ui";
import { icon } from "./icons";
import { endpoint, isSensitiveOption, normalizeSession, PROTOCOLS, sensitiveOptionKeys, type Protocol, type Session } from "./model";
import { addFolder, reloadCredentials, saveSnippets, state, upsertSessions, type Snippet } from "./store";
import { addSavedTunnels, parseTunnel, savedTunnels } from "./tunnels";
import { errorText, esc, modal, timestamp, toast } from "./ui";

// ---- review & save -----------------------------------------------------------------------

/** What makes two sessions the same one for an import: protocol, host (any
 * case), port, user and name. One already here, or an earlier repeat in the
 * same file, is not added again. A key, so a large import is matched in one
 * pass instead of every pair compared. */
const targetKey = (s: Session) => JSON.stringify([s.protocol, s.host.toLowerCase(), s.port, s.username, s.name]);

/** Why a key file a source names cannot be used, for the review. */
const KEY_PROBLEMS: Partial<Record<ImportKeyKind, string>> = {
  missing: "키 파일이 없습니다",
  foreign: "OpenSSH 형식이 아닙니다",
  unknown: "OpenSSH 형식이 아닙니다",
  public: "공개 키 파일입니다",
  store: "Windows 인증서 저장소의 키입니다",
};

/** Show what will be imported; resolves after the user saves or cancels. */
/** `tunnels`: SSH tunnels a backup carries; they come along only with the
 * security options (they are port forwards). */
/** `extras`: other things a backup restores (folders, snippets, tunnels)
 * that are missing here; with them the import can be confirmed even when
 * every session already exists. */
async function reviewImport(title: string, parsed: ParsedImport, tunnels = 0, extras = 0): Promise<{ saved: number; keep: boolean; confirmed: boolean }> {
  // Not already saved, and not a repeat within the file itself (a CSV with a
  // row twice): the first of each is kept, the rest count as existing.
  const saved0 = new Map(state.sessions.map((s) => [targetKey(s), s]));
  const seen = new Set(saved0.keys());
  const fresh: Session[] = [];
  // Sessions already here (an earlier import of the same tool) that have no
  // login set: a usable key this import names for them is linked to them too.
  const bare = new Map<string, Session>();
  for (const s of parsed.sessions) {
    const k = targetKey(s);
    if (seen.has(k)) {
      const old = saved0.get(k);
      if (old && !old.credentialId) bare.set(s.id, old);
      continue;
    }
    seen.add(k);
    fresh.push(s);
  }
  const dupes = parsed.sessions.length - fresh.length;
  const freshIds = new Set(fresh.map((s) => s.id));
  const target = new Map<string, Session>([...fresh.map((s) => [s.id, s] as const), ...bare]);
  // Key files named for those sessions, resolved and checked: a usable one is
  // linked as a key credential on save; one that is not is reported, as that
  // session will log in some other way (a password).
  const named = (parsed.keyLinks ?? []).filter((k) => target.has(k.sessionId));
  const raw = [...new Set(named.map((k) => k.keyPath))];
  const checks = raw.length ? await api.importCheckKeys(raw, parsed.configDir ?? null) : [];
  const checked = new Map(raw.map((r, i) => [r, checks[i]]));
  const keyLinks: { session: Session; keyPath: string; carried?: number[] }[] = [];
  const keyProblems: { name: string; reason: string }[] = [];
  let lockedPutty = 0;
  // A key file that is not on this PC but that the export itself carries is
  // saved to the .ssh folder on save, then linked.
  const carried = new Map((parsed.keyFiles ?? []).map((f) => [f.keyPath, f.contents]));
  for (const k of named) {
    const c = checked.get(k.keyPath);
    const session = target.get(k.sessionId)!;
    if (c && (c.kind === "openssh" || c.kind === "putty" || c.kind === "putty-encrypted")) {
      keyLinks.push({ session, keyPath: c.path });
      if (c.kind === "putty-encrypted") lockedPutty++;
    } else if (c?.kind === "missing" && carried.has(k.keyPath)) keyLinks.push({ session, keyPath: k.keyPath, carried: carried.get(k.keyPath) });
    else keyProblems.push({ name: session.name, reason: KEY_PROBLEMS[c?.kind ?? "unknown"] ?? "OpenSSH 형식이 아닙니다" });
  }
  const carriedFiles = new Set(keyLinks.filter((k) => k.carried).map((k) => k.keyPath)).size;
  const linkedFresh = keyLinks.filter((k) => freshIds.has(k.session.id)).length;
  const repairs = new Set(keyLinks.filter((k) => !freshIds.has(k.session.id)).map((k) => k.session)).size;
  const savedPasswords = (parsed.savedPasswords ?? []).filter((id) => freshIds.has(id)).length;
  return new Promise((resolve) => {
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
          <td><span data-i18n-skip>${esc(s.name)}</span>${flags.length ? `<br><small class="warn-text">${icon("ShieldAlert", 12)}${esc([...new Set(flags.map(labelOf))].join(", "))}</small>` : ""}</td>
          <td class="mono" data-i18n-skip>${esc(endpoint(s))}</td><td class="muted" data-i18n-skip>${esc(s.folder || "—")}</td></tr>`;
      })
      .join("");
    const m = modal({
      title,
      icon: "Download",
      width: 760,
      body: `<div class="import-summary">
          <b>${fresh.length}개 세션을 가져옵니다</b> ${counts.map(([p, n]) => `<span class="muted">${PROTOCOLS[p as Protocol].label} ${n}</span>`).join(" · ")}
          ${dupes ? `<br><span class="muted">이미 있는 세션 ${dupes}개는 건너뜁니다.</span>` : ""}
          ${linkedFresh ? `<br><span class="muted">키 파일 ${linkedFresh}개를 자격 증명 보관함에 연결합니다. 비밀번호는 저장하지 않습니다.</span>` : ""}
          ${repairs ? `<br><span class="muted">이미 있는 세션 중 로그인 정보가 없는 ${repairs}개에 키 파일을 연결합니다.</span>` : ""}
          ${carriedFiles ? `<br><span class="muted">이 PC에 없는 키 파일 ${carriedFiles}개는 내보낸 파일에 든 것을 .ssh 폴더에 저장해 씁니다.</span>` : ""}
          ${lockedPutty ? `<br><span class="muted">암호가 걸린 PuTTY 키를 쓰는 세션 ${lockedPutty}개는 자격 증명 보관함에서 키 암호를 저장해야 연결됩니다.</span>` : ""}
          ${
            // Each name kept as written (data-i18n-skip), each reason a text of its own to translate.
            keyProblems.length
              ? `<br><span class="import-warn">키 파일을 쓸 수 없는 세션 ${keyProblems.length}개: ${keyProblems
                  .slice(0, 4)
                  .map((p) => `<span data-i18n-skip>${esc(p.name)}</span> (<span>${esc(p.reason)}</span>)`)
                  .join(", ")}${keyProblems.length > 4 ? " <span>외</span>" : ""}</span>`
              : ""
          }
          ${savedPasswords ? `<br><span class="muted">원래 프로그램에 비밀번호가 저장되어 있던 세션 ${savedPasswords}개는 비밀번호를 가져오지 않으므로 연결할 때 입력해야 합니다.</span>` : ""}
          ${keyProblems.length || savedPasswords ? `<br><span class="warn-text">${icon("ShieldAlert", 12)}비밀번호를 모르면 짐작해서 넣지 마세요. 여러 번 틀리면 서버가 접속을 차단할 수 있습니다.</span>` : ""}
          ${!fresh.length && extras ? `<br><span class="muted">세션은 모두 이미 있습니다. 백업의 폴더·스니펫·터널 중 없는 것만 복원합니다.</span>` : ""}
          ${
            // Each name kept as written (data-i18n-skip), each reason a text of its own to translate.
            parsed.skipped.length
              ? `<br><span class="muted">가져올 수 없는 항목 ${parsed.skipped.length}개: ${parsed.skipped
                  .slice(0, 4)
                  .map((s) => `<span data-i18n-skip>${esc(s.name)}</span> (<span>${esc(s.reason)}</span>)`)
                  .join(", ")}${parsed.skipped.length > 4 ? " <span>외</span>" : ""}</span>`
              : ""
          }
        </div>
        ${fresh.length ? `<div class="import-table"><table><thead><tr><th>종류</th><th>이름</th><th>대상</th><th>폴더</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
        ${risky.length || tunnels ? `<label class="check block import-risky"><input type="checkbox" name="keepSensitive"/>
          <span><b>보안 관련 옵션도 가져오기 (${risky.length}개 세션)</b>${tunnels ? `<small>백업의 SSH 터널 ${tunnels}개는 이 옵션을 켤 때만 가져옵니다.</small>` : ""}
          <small>인증서 오류 무시, 에이전트 전달, 포트 포워딩, 점프 호스트, 프록시, 드라이브 공유, 로그 파일 위치 설정입니다. 직접 만든 백업이 아니라면 끈 채로 두세요. 끄면 이 옵션만 빼고 가져옵니다.</small></span></label>` : ""}
        <p class="muted small">비밀번호는 가져오지 않습니다. 처음 연결할 때 입력하거나 자격 증명 보관함에서 지정하세요.</p>`,
      footer: `<button class="btn" data-close>취소</button>
               <button class="btn btn-primary" data-ok ${fresh.length || extras || repairs ? "" : "disabled"}>${icon("Check", 14)}${fresh.length ? `${fresh.length}개 가져오기` : extras ? "백업 복원" : "키 파일 연결"}</button>`,
      onClose: () => resolve({ saved, keep, confirmed }),
    });
    m.root.querySelector("[data-ok]")!.addEventListener("click", async () => {
      try {
        keep = m.root.querySelector<HTMLInputElement>("[name=keepSensitive]")?.checked ?? false;
        if (!keep)
          for (const s of fresh) for (const k of Object.keys(s.options)) if (isSensitiveOption(k)) delete s.options[k];
        confirmed = true;
        // Key files the export carries go to the .ssh folder first (once per
        // file); one that cannot be saved leaves its sessions unlinked.
        const stored = new Map<string, string | null>();
        for (const k of keyLinks.filter((k) => k.carried)) {
          if (!stored.has(k.keyPath)) {
            const name = k.keyPath.split(/[\\/]/).pop() || "imported_key";
            stored.set(k.keyPath, await api.importStoreKey(name, k.carried!).catch((err) => (toast(errorText(err), "error"), null)));
          }
          k.keyPath = stored.get(k.keyPath) ?? "";
        }
        // Link key files first so the saved session already points at its key.
        const linkable = keyLinks.filter((k) => k.keyPath);
        if (linkable.length) await linkKeyCredentials(linkable);
        if (fresh.length) {
          await upsertSessions(fresh);
          saved = fresh.length;
          toast(`${saved}개 세션을 가져왔습니다`, "success");
        }
        const repaired = [...new Set(keyLinks.filter((k) => !freshIds.has(k.session.id) && k.session.credentialId).map((k) => k.session))];
        if (repaired.length) {
          await upsertSessions(repaired);
          toast(`이미 있는 세션 ${repaired.length}개에 키 파일을 연결했습니다`, "success");
        }
      } catch (err) {
        toast(errorText(err), "error");
      }
      m.close();
    });
  });
}

/** Link the usable key files of an import (absolute paths, from
 * import_check_keys) to their sessions as key credentials, so each logs in
 * with its key instead of being asked for a password. One credential per key
 * file, shared by every session that uses it (SecureCRT's key for all
 * sessions), and an existing one for the same file is reused; it names no
 * user, so each session logs in as its own. No secret is stored: an encrypted
 * key still asks for its passphrase. */
async function linkKeyCredentials(keyLinks: { session: Session; keyPath: string }[]) {
  const forKey = new Map(state.credentials.filter((c) => c.kind === "key" && c.keyPath).map((c) => [c.keyPath!.toLowerCase(), c.id]));
  let made = 0;
  for (const { session: s, keyPath } of keyLinks) {
    if (s.credentialId) continue;
    let id = forKey.get(keyPath.toLowerCase());
    if (!id) {
      try {
        const name = `${keyPath.split(/[\\/]/).pop() || keyPath} 키`;
        id = (await api.vaultSave({ id: crypto.randomUUID(), name, username: "", kind: "key", keyPath, hasSecret: false }, null)).id;
        forKey.set(keyPath.toLowerCase(), id);
        made++;
      } catch {
        // Leave the session without a credential; it will ask for a password.
        continue;
      }
    }
    s.credentialId = id;
  }
  if (made) await reloadCredentials();
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
    if (!dir) return null;
    // The configuration folder around Sessions keeps SSH2.ini, with the key file
    // set for all sessions, and is what ${VDS_CONFIG_PATH} in key paths means.
    const configDir = dir.replace(/[\\/]+$/, "").replace(/[\\/]Sessions$/i, "");
    const ssh2 = await api.readTextFile(`${configDir}\\SSH2.ini`).catch(() => "");
    return { ...parseSecureCrtFiles(await api.importScan(dir, "ini"), "SecureCRT", secureCrtGlobalKey(ssh2)), configDir };
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
    const text = await readChosenFile("CSV 선택 (첫 줄: Name, Protocol, Host, Port, Username, Folder, Domain)");
    return text === null ? null : parseCsv(text);
  });

export const importSshConfig = () =>
  runImport("OpenSSH 설정 가져오기", "OpenSSH 설정 파일", async () => {
    const text = await readChosenFile("OpenSSH 설정 파일 선택 (보통 .ssh 폴더의 config)");
    return text === null ? null : parseSshConfig(text);
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
    { label: "OpenSSH (~/.ssh/config)…", icon: "Download", action: () => importSshConfig() },
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
    // New ids for imported sessions. One already here keeps its id, and a
    // repeat within the backup gets the first one's (the review adds only that
    // one), so SSH gateway and tunnel references in the backup still point at
    // a session that exists.
    const idByKey = new Map<string, string>();
    for (const e of state.sessions) if (!idByKey.has(targetKey(e))) idByKey.set(targetKey(e), e.id);
    const newIds = parsed.map((s) => {
      const k = targetKey(s);
      if (!idByKey.has(k)) idByKey.set(k, crypto.randomUUID());
      return idByKey.get(k)!;
    });
    // Backup id → new id, for those references. A hand-edited backup may give
    // two sessions one id: references go to the first of them.
    const ids = new Map<string, string>();
    parsed.forEach((s, i) => {
      if (!ids.has(s.id)) ids.set(s.id, newIds[i]);
    });
    const sessions = parsed.map((s, i) => {
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
      return { ...s, id: newIds[i], credentialId, options };
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

/** Export the session list as CSV (the columns parseCsv reads back), for editing
 * in a spreadsheet or sharing. No secrets — passwords live only in the vault. */
export async function exportCsv() {
  if (!state.sessions.length) return toast("내보낼 세션이 없습니다", "warn");
  const path = await pickSavePath(`BananaConn-세션-${timestamp()}.csv`, [{ name: "CSV", extensions: ["csv"] }]);
  if (!path) return;
  const field = (v: unknown) => {
    // A leading = + - @ makes a spreadsheet run the cell as a formula: the
    // usual "'" guard keeps it text (parseCsv drops it again on import).
    const s = String(v ?? "").replace(/^(?=[=+\-@])/, "'");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Domain: an RDP session's Windows domain, which parseCsv reads back.
  const header = ["Name", "Protocol", "Host", "Port", "Username", "Folder", "Domain"];
  const rows = state.sessions.map((s) =>
    [s.name, s.protocol, s.host, s.port ?? "", s.username, s.folder, s.protocol === "rdp" ? (s.options.domain ?? "") : ""].map(field).join(","),
  );
  // A UTF-8 BOM so Excel reads Korean names correctly; parseCsv strips it on import.
  const csv = `﻿${[header.join(","), ...rows].join("\r\n")}\r\n`;
  try {
    await api.saveTextFile(path, csv);
    toast(`세션 ${state.sessions.length}개를 내보냈습니다`, "success");
  } catch (err) {
    toast(errorText(err), "error");
  }
}
