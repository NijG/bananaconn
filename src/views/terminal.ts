// Terminal view for SSH and Telnet sessions.

import { Terminal, type IBuffer, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { FullScreenSearch } from "../fullScreenSearch";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { api, on, openExternal, pickOpenFile, pickSavePath, revealInExplorer } from "../api";
import type { PasteEvent } from "../api";
import { proxyOf } from "../proxy";
import { readClipboard, writeClipboard } from "../clipboard";
import {
  type UptimeMatch,
  addressKind,
  addressPattern,
  arpPair,
  bandwidthAbove,
  findInterfaces,
  findIps,
  hostAddresses,
  findIpv6s,
  sameHost,
  ipv6Kind,
  parseIpv6,
  interfaceDescription,
  interfaceNeighbor,
  interfaceStateChange,
  interfaceVlan,
  findMacs,
  findMasks,
  findRates,
  findUptimes,
  findLogMnemonics,
  MAY_HOLD_MNEMONIC,
  maskForms,
  readableRate,
  interfaceNames,
  interfaceSearchPattern,
  macFormats,
  macKind,
  macSearchPattern,
  mayHoldInterface,
} from "../ipLinks";
import { matchLines, type LineMatch, type OutputLine } from "../lineFilter";
import { clockText, LineTimes } from "../lineTimes";
import { splitTable, type CellLine, codeBlock } from "../tableCopy";
import { notesButton } from "../sessionNotes";
import { savedSessionItems } from "../nettools";
import { openSyslog, SEVERITY, syslogSender } from "../syslog";
import { icon } from "../icons";
import { DRAG_FROM_THIS_APP, endpoint, keepaliveOf, PROTOCOLS, REMOTE_PATHS_DRAG, serialSettings, type Protocol, type Session } from "../model";
import { fileSessionFor, fileTransferBlockedReason } from "../transfer";
import { addMacro, askSnippetValues, asksValues, saveSelectionAsSnippet, snippetMenu } from "../snippets";
import { findCommandRisk, findRisks, findTypedRisk, UNREADABLE_MACRO, type RiskHit } from "../riskRules";
import { patchSession, state, subscribe, takeSavedSession, updateSettings, type Snippet, type TriggerRule } from "../store";
import { termTheme } from "../themes";
import { KeywordHighlighter } from "../highlight";
import { CmdAssist } from "../cmdAssist";
import { keyLine, LsColors } from "../lsColors";
import type { AiHost, AiPanel } from "../ai/panel";

/** The AI panel and command bar load on first use. */
const aiModule = () => import("../ai/panel");
import { hasRemoteCommands, PROMPT_END, setRemoteCommands } from "../cmdLine";
import { deviceCommands, deviceTitle, type DeviceInfo } from "../deviceCommands";
import { backendLogOptions, LOG_TOKENS, logConfig, previewPath, type LogConfig } from "../logOptions";
import { GatewayLink } from "../tunnels";
import { forgetHostKey } from "../hostKeys";
import { afterExit, asksAtEnd, asksLogin, loginFailure, loginThrough, plainLines, SECRET_WORD, unusableKey, USER_WORD } from "../sshLogin";
import { tr, userText } from "../i18n";
import { findPerms, octal } from "../remotePerm";
import { findPaths } from "../serverPaths";
import { statusUnitOf, syntaxCheckFor } from "../shebang";
import { QUOTE_UNSAFE, QUOTE_UNSAFE_TEXT, shellQuote } from "../shellQuote";
import { archiveCommands } from "../archiveCommands";
import { decodedLabel, decodeSelection } from "../decodeText";
import { numberForms, printedSpan, timeForms } from "../numberForms";
import { oidName } from "../oidNames";
import { priText } from "../syslogPri";
import { localEcho } from "../localEcho";
import { askGrep, GREP_PUT } from "../grepPrompt";
import { grepUnsupported } from "../grepCommand";
import { actionFor, appTakesInTerminal, keyHint, SNIPPET_PREFIX, withKey } from "../keymap";

/** Editing keys in recorded macros, as private-use marks U+E100.. in this
 * order; each tab turns them into its own key mode's bytes. */
const MARKED_KEYS: EditKey[] = ["Delete", "Home", "End", "Backspace"];

import { beep, canOsNotify, confirmDialog, contextMenu, ensureNotifyPermission, errorText, esc, h, isScreenLocked, modal, osNotify, promptDialog, requestAttention, sheetCell, timestamp, toast, setPressed, type MenuItem } from "../ui";
import type { BroadcastInput, EditKey, InputKind, MonitorInfo, StatusInfo, Tab, View, ViewState, Workspace } from "../workspace";

/** An output line that asks for a login or a secret ("Password:", "Username:",
 * "Enter passphrase", "암호:", a one-time code): trigger rules never auto-answer
 * it (see fireTrigger). Erring toward a match only costs an unsent rule. */
const CREDENTIAL_PROMPT =
  /pass(?:word|phrase|code|wd)|\bpass\b|passwort|kennwort|contrase(?:ñ|n)a|mot de passe|senha|has(?:ł|l)o|пароль|m(?:ậ|a)t kh(?:ẩ|a)u|パスワード|暗証|密码|密碼|口令|암호|비밀번호|인증 ?(?:번호|코드)|one[- ]time|verification code|\botp\b|\bpin\b|continue connecting|fingerprint|host key/i;
/** A theme colour as xterm decorations take it (#RRGGBB): one with an alpha
 * ("#f5c51840") is mixed over the background as it would show. */
function opaque(color: string | undefined, background: string | undefined): string {
  const hex = (c: string | undefined) => (c && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c) ? c : null);
  const fg = hex(color) ?? "#264f78";
  if (fg.length === 7) return fg;
  const bg = hex(background)?.slice(0, 7) ?? "#000000";
  const a = parseInt(fg.slice(7, 9), 16) / 255;
  const mix = (i: number) => Math.round(parseInt(fg.slice(i, i + 2), 16) * a + parseInt(bg.slice(i, i + 2), 16) * (1 - a));
  return `#${[1, 3, 5].map((i) => mix(i).toString(16).padStart(2, "0")).join("")}`;
}

/** Words that ask for a login only on the prompt line itself ("login:",
 * "Username", "계정"): too common to be held against the line above. */
const LOGIN_WORD = /인증|로그인|아이디|계정|사용자 ?이름|\b(?:log ?in|user(?:\s*name)?|account|token|code|pin)\b/i;

/** A line that ends asking for a login ("login:", "Username>"): a repeated
 * command (term.repeat) is never sent there. */
const LOGIN_END = /(?:log ?in|user ?(?:name|id)|로그인|아이디|계정|사용자 ?이름)\s*[:>]?\s*$/i;
/** A line ending in a login question ("Username:", "login as:", "User:", full-width "：" too). */
const USER_QUESTION = new RegExp(`\\b${USER_WORD}\\s*[:：?？]$`, "i");
/** A login question with its answer typed after it, echoed ("Username: adm"). */
const USER_ANSWERED = new RegExp(`^[^:：]{0,80}?\\b${USER_WORD}\\s*[:：]\\s*\\S`, "i");
/** The same with ">" ("Username>admin"): before a login only (a host may be named "R1-login"). */
const USER_ANSWERED_ANGLE = new RegExp(`^[^>]{0,80}?\\b${USER_WORD}\\s*>\\s*\\S`, "i");
/** A secret asked with ">" ("Password>", "PIN>"): the word on its own right
 * before it (not a host named "R1-PASS" or "FW-PIN"). The same words as the
 * login check's (sshLogin), so a question is never a finished login there. */
const SECRET_ANGLE = new RegExp(String.raw`(?:^|\s)${SECRET_WORD}\s*[>＞]$`, "i");
/** What empties the input line before a command is put there: Ctrl+E (end
 * of line in readline and in device CLIs) then Ctrl+U (erase to the start).
 * Ctrl+U alone left whatever stood after a cursor moved back, which then ran
 * as part of the command; where Ctrl+E means nothing, Ctrl+U does as before. */
const LINE_CLEAR = "\x05\x15";
/** A clicked path that names a text log: a log's file suffix (rotated ones
 * too: "app.log.1"), or a syslog file's name under /var/log or /var/adm. Not
 * anything under /var/log: wtmp, btmp, lastlog and the journal are binary
 * (their bytes would set the terminal's modes), and folders cannot be followed. */
const LOG_PATH = /\.(?:log|out|err)(?:\.\d+)?$|^\/var\/(?:log|adm)\/(?:[^/]+\/)*(?:messages|syslog|secure|maillog|cron|dmesg|warn)(?:\.\d+)?$/i;

/** ssh.exe asking about a host key: "... continue connecting (yes/no/[fingerprint])?",
 * its "Please type 'yes', 'no' or the fingerprint:", an answer echoed after it. */
const HOSTKEY_WORDS = /continue connecting|fingerprint|host key/i;
/** A choice a command asks ("Change now? [Y/N]:", "Proceed with reload? [confirm]",
 * "(yes/no)", "Destination filename [startup-config]?"), its short answer
 * echoed after it or not. A space before the default's "[" (not a glob: "ls f[12]?"). */
const CONFIRM_QUESTION = /(?:\?\s*(?:\[[^\]]*\]|\([^)]*\))|\s\[[^\]]*\]\?|[[(](?:y\/n|yes\/no)[\])])\s*:?(?:\s*[\w.:/-]{1,64})?$/i;
/** A file command asking before it acts ("rm: remove regular file 'a'?",
 * "cp: overwrite 'b'?": rm -i and cp -i, root's aliases on some systems). */
const FILE_QUESTION = /^(?:rm|cp|mv|ln): .*\?(?:\s*\w{1,8})?$/;
/** A shell prompt by its shape ("user@host:~/dir$", "[root@h tmp]#", "PS C:\…>", "C:\…>"):
 * never a question, whatever words its host or directory name holds. */
const SHELL_PROMPT_SHAPE = /^[\w.-]+@[\w.-]+[:~ ]|^\[[^\]\s]+[ @][^\]]*\][#$%]|^(?:PS )?[A-Za-z]:\\/;
/** An answer echoed after a secret question ("********", "••••", a 6-digit code): left off before judging. */
const ECHOED_SECRET = /([:：?？>＞])\s*(?:[*•●]+|\d{4,8})$/;
/** A device's own command prompt, alone on its line ("router>", "R1#",
 * "[root@h ~]#", "*A:PE1#", "$"): not a banner ("#### Authorized only ####",
 * "[ Authorized users only ]", "%%% … %%%") or a boot status line
 * ("Starting sshd:   [  OK  ]"). */
const DEVICE_PROMPT = /^(?![^[]*\s\[\s*[\w ]+\s*\]$)(?:[#$>%]|(?:[^\s#[%=-]|\[\S)[^#]{0,78}[#>$%\]])$/;
/** A question a command asks ("Do you want to continue? [Y/n]", "Proceed
 * with reload? [confirm]", "Destination filename [startup-config]?",
 * "(yes/no)"): an answer typed there is no command of its own. */
const QUESTION = /\?\s*(?:\[[^\]]*\]|\([^)]*\))?\s*:?$|[[(](?:y\/n|yes\/no)[\])]\s*:?$/i;
/** A pager waiting for a key ("--More--", "---- More ----", "---(more 12%)---", "(END)"). */
const PAGER_PROMPT = /-+\s*\(?more\b[^-]*-+|press any key|\(END\)\s*$/i;
/** Said when input waited on a dialog and the line changed kind meanwhile (see lineStill). */
const LINE_CHANGED = "줄이 다른 종류(로그인 질문 등)로 바뀌어 보내지 않았습니다";
/** Said when several lines would go into a login or password question (each an attempt). */
const MANY_LINES_AT_LOGIN = "로그인·비밀번호를 묻는 줄에는 여러 줄을 보내지 않습니다";

/** A command that undoes itself unless confirmed in time, with the minutes it
 * gives, to offer the work timer for: Cisco's "reload in [hh:]mm" and
 * "commit confirmed [n]" (Junos: minutes, 10 when not given; IOS XR counts
 * seconds, so a number is read only on a device recognised as Junos). Null
 * when it is not one, or when its time cannot be told for sure. `kind`: the
 * operating system recognised on the device (devmon.rs). */
export function selfUndoing(command: string, kind: string | undefined): { minutes: number; note: string } | null {
  const line = command.trim();
  const reload = /^(?:do\s+)?reload\s+in\s+(?:(\d{1,3}):)?(\d{1,4})(?:\s|$)/i.exec(line);
  if (reload) {
    const minutes = (reload[1] ? Number(reload[1]) * 60 : 0) + Number(reload[2]);
    return minutes >= 1 && minutes <= 1440 ? { minutes, note: "reload cancel" } : null;
  }
  // Only the forms whose time is plain: an option before "confirmed" (Junos
  // takes any order) or an unknown one after it ("minutes 5" on IOS XR) is
  // left alone rather than read wrong.
  const commit = /^commit\s+confirmed(?:\s+(\d{1,5}))?(?:\s+(?:comment|and-quit|synchronize)\b.*)?\s*$/i.exec(line);
  if (commit) {
    if (!commit[1]) return { minutes: 10, note: "commit" };
    const n = Number(commit[1]);
    return kind?.startsWith("juniper") && n >= 1 && n <= 1440 ? { minutes: n, note: "commit" } : null;
  }
  return null;
}

/** A command that confirms or cancels what a work timer waits for: "reload
 * cancel", or a commit that is neither a check nor another confirmed one. */
const SETTLES = /^(?:(?:do\s+)?reload\s+cancel|commit(?![^\r\n]*\bconfirmed\b)(?!\s+check\b)(?:\s.*)?)\s*$/i;

/** The configuration backup last saved or compared per device (backupKey),
 * offered first the next time. This PC's browser storage only; at most 200. */
const LAST_BACKUP = "bx.lastConfigBackup";
/** Output lines read, the newest first, for the IP of a MAC (and the MAC of
 * an IP) in an address menu: in each terminal tab (an ARP table printed
 * lately is among them), and in all. Measured in the preview: 60,000 lines
 * read (three full tabs, nothing found) open the menu in about 90 ms. */
const PAIR_SCAN_TAB = 20_000;
const PAIR_SCAN = 100_000;

function lastBackup(key: string): string | undefined {
  try {
    const path = (JSON.parse(localStorage.getItem(LAST_BACKUP) ?? "{}") as Record<string, unknown>)[key];
    return typeof path === "string" ? path : undefined;
  } catch {
    return undefined;
  }
}

function rememberBackup(key: string, path: string) {
  try {
    const map = JSON.parse(localStorage.getItem(LAST_BACKUP) ?? "{}") as Record<string, string>;
    delete map[key];
    map[key] = path;
    // The newest last: the oldest go first once there are too many.
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete map[k];
    localStorage.setItem(LAST_BACKUP, JSON.stringify(map));
  } catch {
    // Not kept: the picker starts where it likes.
  }
}

/** A work timer's time left as m:ss (rounded up: 0:00 only at the end). */
function timerClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Row `y` as part of its logical line (a long line wraps over several rows),
 * as the search addon reads it: the line's last row trimmed at the end; a
 * row the line goes on from keeps its full width, less the blank cell xterm
 * leaves where a wide character (Hangul, CJK) did not fit and moved down. */
function rowText(buf: IBuffer, y: number): { text: string; continues: boolean } {
  const line = buf.getLine(y);
  if (!line) return { text: "", continues: false };
  const next = buf.getLine(y + 1);
  const continues = !!next?.isWrapped;
  let text = line.translateToString(!continues);
  if (continues) {
    const last = line.getCell(line.length - 1);
    if (last && last.getCode() === 0 && last.getWidth() === 1 && next?.getCell(0)?.getWidth() === 2) text = text.slice(0, -1);
  }
  return { text, continues };
}

/** A prompt without what changes on every command, so two runs at the same
 * prompt match: a clock ("[10:00:01 admin@web ~]$"), EXOS's unsaved mark and
 * command counter ("* X440G2-48p.5 #"). */
function steadyPrompt(prompt: string): string {
  return prompt
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "")
    .replace(/^\*\s+/, "")
    .replace(/\.\d+(\s*[#>]\s*)$/, (_m, end: string) => end)
    .trim();
}

/** A terminal's command marks and how to read them (TerminalView.commandBook). */
interface CommandBook {
  buf: IBuffer;
  /** Still in the scrollback, oldest first. */
  marks: IMarker[];
  /** A line's text, its wrapped rows joined. */
  text: (y: number) => string;
  /** The mark is a command typed at a prompt. */
  atPrompt: (m: IMarker) => boolean;
}

/** A command repeated at the prompt (TerminalView.toggleRepeat). */
interface RepeatState {
  /** The connection it runs on (TerminalView.runtimeId): a new one ends it. */
  rid: string;
  command: string;
  /** The prompt it started at: runs go out only there. */
  prompt: string;
  everyMs: number;
  total: number;
  sent: number;
  timer: number;
  /** The line the last run was entered on: the prompt must come back below it. */
  marker: IMarker | null;
  /** When the next run is due (from then it waits for the prompt, a minute at most). */
  dueAt: number;
  waiting: boolean;
}

/** A terminal's connection and its broadcast peers' (TerminalView.sendScope). */
interface SendScope {
  rid: string;
  peers: { tab: Tab; id: string | undefined }[];
}

/** `input` to each of `tabs` by broadcast: the tabs that took it (one whose
 * line is of another kind holds it, see TerminalView.receiveInput). */
function broadcastTo(tabs: Tab[], input: BroadcastInput): Tab[] {
  const took: Tab[] = [];
  for (const t of tabs) if (t.view.receiveBroadcast?.(input) === true) took.push(t);
  return took;
}

/** Input that riskGate confirmed, to the other broadcast tabs it was
 * confirmed for; each still checks its own line against `hits`. The tabs
 * that took it. */
function deliverConfirmed(others: Tab[], input: BroadcastInput, hits: RiskHit[], tag: string): Tab[] {
  const took: Tab[] = [];
  for (const t of others) {
    if (t.view.state !== "connected") continue;
    if (!(t.view instanceof TerminalView)) {
      if (t.view.receiveBroadcast?.(input) === true) took.push(t);
      continue;
    }
    // Recorded per tab as it went: sent with its own line, or held.
    const r = t.view.receiveInput(input, hits);
    if (r.sent) took.push(t);
    void auditRisk(r.sent ? "SENT" : "NOT SENT", tag, t.session, r.hit ? [r.hit] : hits);
  }
  return took;
}

/** A line of the risky-command record for each hit, for one session. */
function auditRisk(event: string, tag: string, session: Session, hits: RiskHit[]): Promise<boolean> {
  return Promise.all(hits.map((h) => api.riskAudit(tag ? `${event} ${tag}` : event, session.name || endpoint(session), endpoint(session), h.rule.note, h.line))).then(
    () => true,
    (err) => {
      toast(errorText(err), "error");
      return false;
    },
  );
}

/** Whether a screen line (its own prompt first, whatever it is) ends in
 * the command that was confirmed, spacing aside: the command must start
 * there, after the prompt or a space, not inside a longer word. */
function endsInCommand(line: string, command: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ");
  const l = norm(line);
  const cmd = norm(command);
  if (!cmd || !l.endsWith(cmd)) return false;
  const before = l.slice(0, l.length - cmd.length).trimEnd();
  // Right after the prompt ("host:~$ "), not after another word ("$ sudo ").
  return !before || PROMPT_END.test(before);
}

/** Asked once per app run. */
let build: Promise<number> | null = null;
const windowsBuild = () => (build ??= api.windowsBuild().catch(() => 0));

// Monitor events go to the views sharing that monitor.
let routed = false;
function ensureRouting() {
  if (routed) return;
  routed = true;

  on<MonitorEvent>("monitor-stats", (e) => {
    const m = monitorsById.get(e.id);
    if (!m) return;
    // A monitor that (re)started its sampling loop after the pause was set
    // (login just finished, device CLI fallback) is told again.
    if (m.paused && e.stats) api.monitorPause(m.id, true).catch(() => {});
    if (e.device) {
      m.device = e.device;
      m.views.forEach((v) => v.deviceDetected(e.device!));
    }
    setMonitorInfo(m, nextMonitorInfo(m.info, e));
  });
  on<PasteEvent>("term-paste", (e) => allViews.forEach((v) => v.pasteProgress(e)));
}

// ---- shared resource monitors ----------------------------------------------------------

type MonitorEvent = {
  id: string;
  /** What the monitor recognised (once, after logging in). */
  device?: DeviceInfo;
  stats?: { cpu: number; memUsed: number; memTotal: number; memPercent?: number; diskUsed?: number; diskTotal?: number };
  warmup?: boolean;
  unsupported?: boolean;
  closed?: boolean;
  error?: string;
};

/** One monitor connection per server (protocol, host, port, user). Tabs to the
 * same server share it, so ten tabs cost the device one extra login instead of
 * ten — network gear often allows only a handful of VTY sessions. */
interface SharedMonitor {
  id: string;
  key: string;
  info: MonitorInfo | null;
  views: Set<TerminalView>;
  /** Username typed at the monitor's login prompt (Telnet devices). */
  user: string;
  device?: DeviceInfo;
  /** No tab of this device on screen: sampling paused. */
  paused?: boolean;
  /** The credential of the last start (part of monitorNeedsLogin's key). */
  credentialId?: string | null;
}

/** Pause the monitor while none of its tabs is on screen, resume when one is. */
function syncPause(m: SharedMonitor) {
  const paused = ![...m.views].some((v) => v.onScreen);
  if (m.paused === paused) return;
  m.paused = paused;
  api.monitorPause(m.id, paused).catch(() => {});
}

/** A real graphics card (not a software rasteriser such as SwiftShader or
 * WARP, which is what servers and remote sessions without a GPU get). */
let gpu: boolean | null = null;
function realGpu(): boolean {
  if (gpu !== null) return gpu;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const name = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    gpu = !!name && !/swiftshader|basic render|llvmpipe|software|warp/i.test(name);
  } catch {
    gpu = false;
  }
  return gpu;
}
/** WebGL failed once (no context): DOM from then on. */
let webglFailed = false;
const monitors = new Map<string, SharedMonitor>();
const monitorsById = new Map<string, SharedMonitor>();

/** Monitors (server, user and credential) whose own login found no usable
 * key or saved password and asked for one. Kept for the app's run, past the
 * tabs: a later automatic start (each reconnect) shows the login prompt again
 * instead of trying the same keys on the server once more; failed key attempts
 * count toward its limits. The user starts it again from the status bar. */
const monitorNeedsLogin = new Set<string>();
/** Monitors whose start failed otherwise (an error during the login, a
 * Telnet login that timed out, a changed host key), with what it said: a
 * later automatic start shows that again rather than log in once more; the
 * user starts it from the status bar. One that ended after it was up
 * (`afterUp`: dropped, a device that hung up, samples it cannot read) had
 * logged in, and is started again. */
const monitorStartFailed = new Map<string, MonitorInfo>();
const loginKey = (m: SharedMonitor, credentialId: string | null) => `${m.key}|${credentialId ?? ""}`;
const DROPPED = "모니터링 연결이 끊어졌습니다";

function setMonitorInfo(m: SharedMonitor, info: MonitorInfo | null) {
  m.info = info;
  const lk = loginKey(m, m.credentialId ?? null);
  if (info?.kind === "login") monitorNeedsLogin.add(lk);
  else if (info?.kind === "stats" || info?.kind === "unsupported") {
    // Logged in (a device it cannot read logged in too): nothing held against it.
    monitorNeedsLogin.delete(lk);
    monitorStartFailed.delete(lk);
  } else if (info?.kind === "error" && !info.afterUp) monitorStartFailed.set(lk, info);
  // Only a tab on screen shows the monitor (status bar of the active tab), and
  // all tabs live in one workspace, so one redraw covers them; samples for
  // tabs in the background cost nothing.
  [...m.views].find((v) => v.shown())?.monitorChanged();
}

function failedMonitor(msg: string): MonitorInfo {
  // An encrypted key without its passphrase: the login prompt's value is used
  // as the passphrase (remote.rs), checked on this PC.
  if (msg === "NEED_PASSPHRASE" || msg === "BAD_PASSPHRASE") return { kind: "login", message: msg === "BAD_PASSPHRASE" ? "키 암호가 맞지 않습니다" : "키 암호가 필요합니다" };
  return msg === "NEED_PASSWORD" || msg === "NEED_USERNAME" || /인증에 실패/.test(msg)
    ? { kind: "login", message: /인증에 실패/.test(msg) ? "비밀번호가 올바르지 않습니다" : "", needUser: msg === "NEED_USERNAME" }
    : msg.startsWith("HOSTKEY_UNKNOWN::")
      ? { kind: "hostkey", fingerprint: msg.slice("HOSTKEY_UNKNOWN::".length) }
      : { kind: "error", message: msg.startsWith("HOSTKEY_MISMATCH::") ? "호스트 키가 바뀌었습니다" : msg };
}

function nextMonitorInfo(prev: MonitorInfo | null, e: MonitorEvent): MonitorInfo | null {
  if (e.error) {
    const info = failedMonitor(e.error);
    // Ended after it was up (a device that hung up, samples it cannot read):
    // it had logged in, so a later automatic start may try again.
    return info.kind === "error" && prev?.kind === "stats" ? { ...info, afterUp: true } : info;
  }
  if (e.stats) return { kind: "stats", ...e.stats, warmup: !!e.warmup };
  if (e.unsupported) return { kind: "unsupported", message: "지원하지 않는 장비입니다" };
  if (e.closed && prev?.kind === "stats") return { kind: "error", message: DROPPED, afterUp: true };
  return prev;
}

/** The server's busiest processes (and file systems), read over the monitor connection. */
function showTopProcesses(id: string, title: string) {
  const m = modal({
    title: `${userText(title)} · 상위 프로세스`,
    icon: "Activity",
    width: 900,
    body: `<div class="top-view"></div>`,
    footer: `<button class="btn" data-refresh>${icon("RefreshCw", 14)}새로 고침</button><button class="btn btn-primary" data-close>닫기</button>`,
  });
  const view = m.root.querySelector<HTMLElement>(".top-view")!;
  const header = (line: string) => /^\s*PID\b/.test(line) || /^Filesystem\b/.test(line) || line.startsWith("CPU utilization");
  const load = async () => {
    view.innerHTML = `<p class="muted">서버에서 읽는 중…</p>`;
    try {
      const sections = await api.monitorTop(id);
      view.innerHTML = sections
        .map((s) => `<section><h3>${esc(s.title)}</h3><pre data-i18n-skip>${s.lines.map((l) => (header(l) ? `<b>${esc(l)}</b>` : esc(l))).join("\n")}</pre></section>`)
        .join("");
    } catch (err) {
      view.innerHTML = `<p class="top-error">${esc(errorText(err))}</p>`;
    }
  };
  m.root.querySelector("[data-refresh]")!.addEventListener("click", load);
  load();
}

const allViews = new Set<TerminalView>();
/** The "Ctrl+click opens a link" hint is shown once per app run. */
let linkHintShown = false;
subscribe("settings", () => allViews.forEach((v) => v.applySettings()));

/** Terminal shortcut -> the toolbar button it presses. */
const TOOLBAR_KEYS: Record<string, string> = {
  "term.clear": "clear",
  "term.log": "log",
  "term.save": "save",
  "term.zoomIn": "zoomin",
  "term.zoomOut": "zoomout",
  "term.sftp": "sftp",
  "term.snippets": "snippet",
  "term.record": "record",
  "term.break": "break",
};

/** The host part of a prompt ("router" of "router(config)#", "web" of
 * "user@web:~$" and of "[root@web ~]#"): two prompts of one device in another
 * mode, folder or user (su -, sudo -i) share it; another host's does not. */
function promptHost(prompt: string): string {
  const head = promptHead(prompt);
  return head.slice(head.lastIndexOf("@") + 1);
}

/** The prompt's head with its user ("admin@web" of "admin@web:~$", "router" of
 * "router(config)#"): what sending a command again goes by (a repeat, the
 * pager-off button). Stricter than promptHost: many devices share a default
 * host name (raspberrypi, OpenWrt, ubuntu), so after "ssh other@ubuntu" only
 * a different user may tell them apart; telling the done notice a little
 * late is harmless, sending a command to another device is not. */
function promptHead(prompt: string): string {
  return /^[^\s(#>$%\]:]*/.exec(prompt)![0];
}

/** How long a command ran, as its line's mark shows it: "12.4s", "3m 05s", "1h 02m". */
function durationText(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export class TerminalView implements View {
  el: HTMLElement;
  state: ViewState = "connecting";
  private term: Terminal;
  private fit = new FitAddon();
  private search = new SearchAddon();
  /** Matches of a search typed in vi, less or more, marked on the screen. */
  private fullSearch!: FullScreenSearch;
  private runtimeId = "";
  private logPath: string | null = null;
  private host: HTMLElement;
  private overlay: HTMLElement;
  private findBar: HTMLElement;
  /** The session's notes button in the bar. */
  private notes: ReturnType<typeof notesButton>;
  private resizeTimer = 0;
  private gotOutput = false;
  private disposed = false;
  /** onData in the current event turn comes from the user (key, IME), not from
   * xterm answering a terminal query, focus or mouse report. */
  private userTurn = false;
  private pasting = false;
  /** Logging was on before a reconnect: turn it back on. */
  private relog = false;
  /** The log settings last started with (a reconnect continues with them). */
  private logUsed: LogConfig | null = null;
  private highlighter = new KeywordHighlighter();
  /** Colours and suggestions for the command line being typed. */
  private assist: CmdAssist;
  private lsColors: LsColors;
  /** Keys typed since the last Enter; null once they cannot tell the line (arrows, history). */
  private keyLine: string | null = "";
  /** The automatic SFTP panel was opened once for this tab. */
  private filesOpened = false;
  /** Keystrokes captured while a macro is being recorded. */
  private recording: string[] | null = null;
  /** Auto-reconnect (ssh/telnet): the connection is being closed on purpose
   * (user reconnect or tab close), so an unexpected-drop reconnect must not fire. */
  private closing = false;
  /** The session's startup commands have been sent for this connection. */
  private startupSent = false;
  /** Auto-reconnect attempt count, countdown timer, and "don't reconnect" choice. */
  private reAttempts = 0;
  /** An automatic reconnect chain under way, begun by a session that was
   * logged in and dropped: only then may an attempt that ends before any
   * login be tried again (when the server was not reached at all). */
  private reChain = false;
  private reTimer = 0;
  private reDeclined = false;
  /** The SSH login of the current connection, read from its output (sshLogin.ts).
   * Until the login has gone through, the connection is not established: no
   * resource-monitor login, startup commands or SFTP window (each would only add
   * failed logins to a wrong password), and no auto-reconnect once it ends after
   * a password or host-key question — an authentication failure keeps failing
   * however often it is retried, and repeated tries get an account or address
   * blocked. Telnet and a serial console log in inside the connection: through
   * at the device's own command prompt (inBandLoginThrough).
   * `loginText`: the latest output while the login is under way (last 8 KB).
   * `loginAsked`: ssh.exe asked for a password, passphrase or host-key answer.
   * `endBytes`: the connection's last output, read when it ends. */
  private loginText = "";
  private captureLogin = false;
  private loginDecoder = new TextDecoder();
  private loginSeen = 0;
  private loginTimer = 0;
  private loginAsked = false;
  private loggedIn = false;
  private loggedInAt = 0;
  /** How the last connection ended (exited), for its history: null until it does. */
  private endedAs: "failed" | "error" | "closed" | null = null;
  private keyWarned = false;
  private endBytes = new Uint8Array(0);
  /** "Notify when the task finishes" is on for this tab, with its silence timer
   * and whether output has been seen since it was armed. */
  private notifyDone = false;
  private notifyTimer = 0;
  private notifySaw = false;
  /** Output since the last newline, for matching trigger rules line by line. */
  private triggerBuf = "";
  /** "send" rules that already answered the unfinished line in triggerBuf (a
   *  question waiting at the cursor); the line completing does not fire them again. */
  private tailAnswered = new Set<string>();
  private tailTimer = 0;
  /** The last completed line of output (as on screen), for the credential
   * check of the line after it. */
  private lastLine = "";
  /** An OS guessed from the login banner when the resource monitor has not
   * recognised the device — enough for OS snippets and Up/Down history recall. */
  private osGuess?: string;
  private osSniff = "";
  private sniffDecoder = new TextDecoder();

  /** Telnet only: tunnel through the session's SSH gateway, if it has one. */
  private gateway: GatewayLink;

  constructor(
    private session: Session,
    private ws: Workspace,
    private openFiles: (s: Session, beside?: View) => void,
  ) {
    // Telnet's proxy goes to term_open (its steps then show in the terminal).
    this.gateway = new GatewayLink(session, 23, false);
    ensureRouting();
    allViews.add(this);
    const p = PROTOCOLS[session.protocol];
    this.el = h(
      "div",
      { class: "view term-view" },
      `<div class="view-bar">
         <span class="proto-chip" style="--proto:${p.color}">${icon(p.icon, 14)}${p.label}</span>
         <span class="view-endpoint" data-i18n-skip>${esc(endpoint(session))}</span>
         <span class="view-state" data-state></span>
         <div class="view-actions">
           <button class="tool" data-act="find" title="${esc(withKey("터미널에서 찾기", "term.find"))}">${icon("Search", 15)}</button>
           <button class="tool" data-act="log" title="로그 기록 켜기/끄기" aria-pressed="false">${icon("ScrollText", 15)}<span>로그</span></button>
           <button class="tool" data-act="save" title="출력 내용을 파일로 저장">${icon("Save", 15)}</button>
           <button class="tool" data-act="clear" title="화면 지우기">${icon("Eraser", 15)}</button>
           <span class="tool-sep"></span>
           <button class="tool" data-act="zoomout" title="글자 작게">${icon("ZoomOut", 15)}</button>
           <button class="tool" data-act="zoomin" title="글자 크게">${icon("ZoomIn", 15)}</button>
           ${
             session.protocol === "ssh"
               ? `<span class="tool-sep"></span><button class="tool" data-act="sftp" title="같은 서버의 파일 브라우저 열기">${icon("FolderLock", 15)}<span>SFTP</span></button>`
               : session.protocol === "telnet"
                 ? `<span class="tool-sep"></span><button class="tool" data-act="ftp" title="같은 서버의 FTP 파일 브라우저 열기 (접속 정보 재사용)">${icon("FolderLock", 15)}<span>FTP</span></button>`
                 : ""
           }
           <button class="tool" data-act="snippet" title="명령 스니펫·매크로 보내기">${icon("ClipboardType", 15)}<span>스니펫</span></button>
           <button class="tool" data-act="ai" title="AI: 명령 만들기·출력 설명·대화·파일 분석">${icon("Sparkles", 15)}<span>AI</span></button>
           <button class="tool device-tool" data-act="device" title="자동으로 인식한 장비: 자주 쓰는 명령, 설정 백업, 상위 프로세스" hidden>${icon("Server", 15)}<span data-device-label data-i18n-skip></span></button>
           <button class="tool" data-act="keys" title="Delete·Home·End 키를 보내는 방식 (네트워크 장비는 Ctrl-D·Ctrl-A·Ctrl-E)">${icon("Keyboard", 15)}<span data-keys-label></span></button>
           <button class="tool" data-act="sendfile" title="텍스트 파일 보내기 (설정 파일을 붙여넣듯이)">${icon("FileText", 15)}</button>
           ${session.protocol === "serial" ? `<button class="tool" data-act="break" title="Break 신호 보내기 (장비 ROMMON 진입 등)">${icon("Zap", 15)}<span>Break</span></button>` : ""}
           ${session.protocol === "telnet" ? `<button class="tool" data-act="break" title="Break 보내기 (텔넷 Break 명령: 콘솔 서버가 장비 포트에 Break 신호로 전달, ROMMON 진입 등)">${icon("Zap", 15)}<span>Break</span></button>` : ""}
           <button class="tool" data-act="record" title="매크로 기록 시작/끝">${icon("Circle", 15)}<span>기록</span></button>
           <button class="tool" data-act="notify" title="작업 완료 알림: 출력이 멈추면(명령이 끝나면) 알립니다. 다른 탭을 보고 있을 때만 알림이 옵니다" aria-pressed="false">${icon("Bell", 15)}</button>
           <button class="tool" data-act="reconnect" title="다시 연결">${icon("RotateCw", 15)}</button>
         </div>
       </div>
       <div class="find-bar" hidden>
         ${icon("Search", 14)}
         <input placeholder="터미널에서 찾기" spellcheck="false" />
         <span class="find-count" data-i18n-skip></span>
         <button class="tool find-case" data-find="case" title="대소문자 구분" aria-pressed="false">Aa</button>
         <button class="tool find-regex" data-find="regex" title="정규식" aria-pressed="false">.*</button>
         <button class="tool" data-find="list" title="일치하는 줄 모두 보기 (Alt+Enter)">${icon("ListFilter", 14)}</button>
         <button class="tool" data-find="prev" title="이전">${icon("ArrowUp", 14)}</button>
         <button class="tool" data-find="next" title="다음">${icon("ArrowUp", 14, "flip")}</button>
         <button class="tool" data-find="close" title="닫기">${icon("X", 14)}</button>
       </div>
       <div class="term-host"></div>
       <div class="view-overlay" hidden></div>`,
    );
    this.host = this.el.querySelector(".term-host")!;
    this.overlay = this.el.querySelector(".view-overlay")!;
    // The saved session's notes, while it has any (sessionNotes.ts).
    this.notes = notesButton(session.id, (s) => this.ws.editHandler?.(s));
    this.el.querySelector(".view-actions")!.prepend(this.notes.el);
    this.findBar = this.el.querySelector(".find-bar")!;

    const s = state.settings;
    this.term = new Terminal({
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      cursorStyle: s.cursorStyle,
      // Set per renderer (syncBlink).
      cursorBlink: false,
      scrollback: s.scrollback,
      allowProposedApi: true,
      theme: termTheme(s.terminalTheme),
      lineHeight: 1.15,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    // Ctrl+click opens a link (as Windows Terminal does): a plain click in a
    // terminal is for focus and selection, and output comes from the server.
    this.term.loadAddon(
      new WebLinksAddon((e, uri) => {
        if (e.ctrlKey || !state.settings.linkNeedsCtrl) return void openExternal(uri);
        if (!linkHintShown) {
          linkHintShown = true;
          toast("링크는 Ctrl+클릭으로 엽니다", "info", 3000);
        }
      }),
    );
    // "clear" and Ctrl+L blank the screen in place (ED 2) or drop the
    // scrollback (ED 3), and "reset" (RIS) starts over: command marks there
    // point at nothing now. Only for the normal screen — vi and less clear
    // their own (alternate) screen, which holds no marks. Never consumed.
    this.term.parser.registerCsiHandler({ final: "J" }, (params) => {
      const buf = this.term.buffer.active;
      if (buf.type !== "normal") return false;
      const p = Array.isArray(params[0]) ? params[0][0] : params[0];
      // The whole screen: ED 2, or ED 0 from its top left corner ("clear"
      // on vt100 and linux terminals is ESC [H ESC [J).
      const whole = p === 2 || (p === 0 && buf.cursorX === 0 && buf.cursorY === 0);
      if (p === 3) this.dropCommandMarks(() => true);
      else if (whole) {
        const top = buf.baseY;
        this.dropCommandMarks((m) => m.line >= top);
        this.dropLineMarks();
      }
      // A repeated command that clears the screen ("clear; df -h"): its
      // prompt comes back above the line it was entered on.
      if (whole || p === 3) this.repeat?.marker?.dispose();
      // What comes on erased lines next is new output. xterm frees the
      // markers of the rows it erases, the time probe's among them (on the
      // top row while there is no scrollback; ED 3 drops the scrollback it
      // sits on otherwise): it goes first, the lines gone counted here.
      const trimmed = this.trimmedLines();
      if (trimmed !== null && (p === 0 || p === 2)) {
        this.lineTimes.erased(trimmed + (p === 2 ? buf.baseY : buf.baseY + buf.cursorY + (buf.cursorX > 0 ? 1 : 0)));
        if (this.timeProbe && this.timeProbe.line >= buf.baseY) this.dropProbe(trimmed);
      } else if (trimmed !== null && p === 3) this.dropProbe(trimmed + Math.max(0, buf.length - this.term.rows));
      return false;
    });
    // Lines moved about on the normal screen (insert or delete lines, scroll
    // up or down, a scroll region, a reverse index at the top: vi and less on
    // a console without an alternate screen): the rows from there down hold
    // other lines now, whose times are no longer known. Never consumed.
    // `down`: how many rows the lines below are pushed down (lines inserted),
    // so rows past the last written one get lines too; null: no knowing.
    const linesMove = (fromCursor: boolean, down: number | null) => {
      const buf = this.term.buffer.active;
      if (buf.type !== "normal") return false;
      const trimmed = this.trimmedLines();
      if (trimmed === null) return false;
      const bottom = trimmed + buf.baseY + this.term.rows - 1;
      this.lineTimes.unknown(trimmed + buf.baseY + (fromCursor ? buf.cursorY : 0), down === null ? bottom : Math.min(bottom, this.lineTimes.end + down));
      return false;
    };
    const count = (params: (number | number[])[]) => Math.max(1, (Array.isArray(params[0]) ? params[0][0] : params[0]) || 1);
    this.term.parser.registerCsiHandler({ final: "L" }, (params) => linesMove(true, count(params)));
    this.term.parser.registerCsiHandler({ final: "M" }, () => linesMove(true, 0));
    this.term.parser.registerCsiHandler({ final: "S" }, () => linesMove(false, 0));
    this.term.parser.registerCsiHandler({ final: "T" }, (params) => linesMove(false, count(params)));
    // A scroll region other than the whole screen (setting it back is
    // nothing); one below the top row is remembered (see stampOutput).
    this.term.parser.registerCsiHandler({ final: "r" }, (params) => {
      const n = (i: number) => (Array.isArray(params[i]) ? params[i][0] : params[i]) ?? 0;
      if (this.term.buffer.active.type === "normal") this.scrollRegion = n(0) > 1 ? n(0) - 1 : 0;
      return n(0) > 1 || (n(1) > 0 && n(1) < this.term.rows) ? linesMove(false, null) : false;
    });
    // A soft reset (DECSTR) lets the region go.
    this.term.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
      // Only the screen in use is reset: the normal one keeps its region under vi.
      if (this.term.buffer.active.type === "normal") this.scrollRegion = 0;
      return false;
    });
    this.term.parser.registerEscHandler({ final: "M" }, () => (this.term.buffer.active.cursorY === 0 ? linesMove(false, 1) : false));
    this.term.parser.registerEscHandler({ final: "c" }, () => {
      this.dropCommandMarks(() => true);
      this.dropLineMarks();
      this.repeat?.marker?.dispose();
      // The screen starts over: so does the record of when its lines came.
      this.scrollRegion = 0;
      this.lineTimes.reset();
      this.timeProbe?.dispose();
      this.timeProbe = undefined;
      this.trimmed = 0;
      this.timesStarted = false;
      return false;
    });
    // IPv4 addresses in the output are links too, clicked as web links are:
    // they open a menu (a new session for it, the network tools, a copy).
    this.term.registerLinkProvider({
      provideLinks: (y, callback) => {
        const line = this.term.buffer.active.getLine(y - 1);
        // A cheap test first: an address (an IPv6 one may have no "hh:hh": "fe80::1"),
        // a MAC, an interface name ("Gi1/0/1", "Po1")
        // or a log message name ("%SYS-5-CONFIG_I", often on a line with nothing else).
        const lineText = line?.translateToString(true) ?? "";
        // Server paths: on SSH to a Linux or Unix host (a switch's CLI has none to open).
        const paths = this.session.protocol === "ssh" && !this.device?.network;
        if (!line || !((paths && /(?:^|[^\p{L}\p{N}_.~/:@$\\-])\/[\p{L}\p{N}_.+@~-]/u.test(lineText)) ||/\d\.\d+\.\d+\.\d|[0-9A-Fa-f]{2}[:.-][0-9A-Fa-f]{2}|[0-9A-Fa-f]::|::[0-9A-Fa-f]|[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){7}|\d{4}\s?[kKmMgG]?(?:bits?\/sec|bit\/s|bps)|uptime is \d|load average|[-dlcbps][-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT]/.test(lineText) || mayHoldInterface(lineText) || MAY_HOLD_MNEMONIC.test(lineText)))
          return callback(undefined);
        // The text with the screen cell of each character: a wide character
        // (Hangul) takes two cells, so string positions are not columns.
        let text = "";
        const cells: number[] = [];
        const reuse = this.term.buffer.active.getNullCell();
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x, reuse);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || " ";
          for (let k = 0; k < chars.length; k++) cells.push(x);
          text += chars;
        }
        // Clicked as web links are: Ctrl+click unless the setting says a click.
        const link = (index: number, length: number, open: (e: MouseEvent) => void) => ({
          range: { start: { x: cells[index] + 1, y }, end: { x: cells[index + length - 1] + 1, y } },
          text: text.slice(index, index + length),
          activate: (e: MouseEvent) => {
            if (state.settings.linkNeedsCtrl && !e.ctrlKey) {
              if (!linkHintShown) {
                linkHintShown = true;
                toast("링크는 Ctrl+클릭으로 엽니다", "info", 3000);
              }
              return;
            }
            open(e);
          },
        });
        // IPv6 addresses too; an IPv4 one inside an IPv6 address
        // ("::ffff:10.0.0.1") is that address's, not a link of its own.
        const v6 = findIpv6s(text);
        const addresses = [...v6, ...findIps(text).filter((m) => !v6.some((o) => m.index >= o.index && m.index < o.index + o.length))];
        const links = [
          ...addresses.map((m) => link(m.index, m.length, (e) => this.addressMenu(m.ip, m.port, m.prefix, e.clientX, e.clientY))),
          ...findMacs(text).map((m) => link(m.index, m.length, (e) => this.macMenu(m.hex, e.clientX, e.clientY))),
          ...findInterfaces(text).map((m) => link(m.index, m.length, (e) => this.interfaceMenu(m.type, m.number, e.clientX, e.clientY))),
          ...findMasks(text).map((m) => link(m.index, m.length, (e) => this.maskMenu(m.prefix, e.clientX, e.clientY))),
          ...findRates(text).map((m) => link(m.index, m.length, (e) => this.rateMenu(m.bitsPerSecond, y - 1, e.clientX, e.clientY))),
          ...findUptimes(text).map((m) => link(m.index, m.length, (e) => this.uptimeMenu(m, y - 1, e.clientX, e.clientY))),
          ...findLogMnemonics(text).map((m) => link(m.index, m.length, (e) => this.logMnemonicMenu(m.text, m.severity, e.clientX, e.clientY))),
          ...findPerms(text).map((m) => link(m.index, m.length, (e) => this.permMenu(m.perm, m.mode, e.clientX, e.clientY))),
          ...(paths ? findPaths(text).map((m) => link(m.index, m.length, (e) => this.pathMenu(m.path, m.line, e.clientX, e.clientY))) : []),
        ];
        callback(links.length ? links : undefined);
      },
    });
    this.term.open(this.host);
    this.fullSearch = new FullScreenSearch(this.term, () => this.shellCommandTyped());
    this.applyThemeBackground();
    this.wireBlink();
    this.assist = new CmdAssist(
      this.term,
      () => this.historyKey,
      () => this.effectiveDevice(),
      () => termTheme(state.settings.terminalTheme),
    );
    this.lsColors = new LsColors(
      this.term,
      () => termTheme(state.settings.terminalTheme),
      // Read over the resource monitor's connection; without one, names alone.
      (folder) => (this.shared && !this.device?.network ? api.monitorTypes(this.shared.id, folder) : Promise.resolve(null)),
      () => state.settings.lsColor,
    );
    // SSH runs ssh.exe inside ConPTY, which rewraps lines itself on resize:
    // xterm must know, or resized lines come out doubled or torn.
    if (session.protocol === "ssh") {
      windowsBuild().then((buildNumber) => {
        if (buildNumber && !this.disposed) this.term.options.windowsPty = { backend: "conpty", buildNumber };
      });
    }

    this.term.onData((data) => {
      if (this.state !== "connected" && this.state !== "connecting") return;
      // Enter typed: a search line at the bottom (vi's "/text") marks its matches.
      if (data.includes("\r")) {
        if (this.pasting) this.fullSearch.enterPasted();
        else this.fullSearch.enterTyped();
      }
      // Broadcast only what the user typed; xterm's automatic replies (device
      // reports, focus and mouse events) belong to this terminal alone, and
      // pastes are mirrored as text below.
      if (!this.pasting && this.userTurn) return this.typedInput(data);
      if (this.pasting) {
        // Follow the pasted text on the command line like typing, so a paste
        // with no line break (which stays on the line) is still risk-checked
        // when Enter is pressed, even before the server echoes it. keyLine()
        // returns null when the data holds a line break or other control byte
        // (a multi-line paste or a bracketed-paste wrapper), so those fall
        // back to the screen line as before.
        this.keyLine = keyLine(this.keyLine, data);
        this.assist.note(data);
      }
      this.sendInput(data);
    });
    // xterm turns a key or IME event into onData within the same event
    // dispatch; replies to terminal queries come later from output parsing.
    // So "user input" is exactly what arrives before this event turn ends.
    // xterm sends IME text (Korean syllables, keys typed in Hangul mode) from
    // its own setTimeout(0), queued after this capture listener runs; resetting
    // one timer later keeps that text marked as typed.
    const markUserInput = () => {
      this.userTurn = true;
      setTimeout(() => setTimeout(() => (this.userTurn = false), 0), 0);
    };
    for (const ev of ["keydown", "keypress", "compositionend", "input"]) this.host.addEventListener(ev, markUserInput, true);
    // Native pastes (Shift+Insert, Edit menu) go through our own paste path so
    // broadcast and macros see them as a paste, not as raw bracketed keys.
    this.host.addEventListener(
      "paste",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = e.clipboardData?.getData("text/plain");
        if (text) this.pasteFromUser(text);
      },
      true,
    );
    // Files and folders dragged from a file tab's server pane: their paths
    // typed at the cursor, as dropping files into a terminal does elsewhere.
    this.host.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(REMOTE_PATHS_DRAG)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    this.host.addEventListener("drop", (e) => {
      const raw = e.dataTransfer?.getData(REMOTE_PATHS_DRAG);
      if (!raw) return;
      e.preventDefault();
      // Not also a tab moved by the workspace's own drop handling.
      e.stopPropagation();
      let data: { from?: unknown; paths?: unknown };
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
      // Only a drag from this app's own file tab (not a web page's).
      const paths = data?.from === DRAG_FROM_THIS_APP ? data.paths : null;
      if (Array.isArray(paths) && paths.length && paths.every((p) => typeof p === "string" && p)) this.typePaths(paths);
    });
    this.term.onSelectionChange(() => {
      if (state.settings.copyOnSelect && this.term.hasSelection()) writeClipboard(this.term.getSelection());
    });
    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e));
    this.el.addEventListener("keydown", () => this.timerSeen(), true);
    this.el.addEventListener("mousedown", () => this.timerSeen(), true);
    // Ctrl + wheel changes the font size (one step per wheel notch; touchpads
    // send many small deltas, so they are accumulated).
    let wheel = 0;
    this.host.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        wheel += e.deltaY;
        if (Math.abs(wheel) < 40) return;
        this.zoom(wheel < 0 ? 1 : -1);
        wheel = 0;
      },
      { capture: true, passive: false },
    );
    this.host.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (state.settings.rightClickPaste) return void this.paste();
      // Right-click paste is off: the app's own menu (not the WebView's, which
      // xterm's input box under the pointer would otherwise bring up).
      const run = (f: () => unknown) => () => {
        f();
        this.term.focus();
      };
      // When the line under the pointer arrived (a console message, a ping
      // reply that prints no time of its own); a click copies it.
      const row = this.rowAt(e.clientY);
      const came = row === null ? null : this.lineTime(row);
      const when = came === null ? "" : clockText(came);
      const span = this.selectionSpan();
      // Between the first and the last time printed in the selected lines
      // (a log shown with cat or `show logging`: lines that came at once).
      // Under a minute to the millisecond the log gives ("2.500s").
      // The selection read once for the readings below (a large one is costly to rebuild).
      const selected = this.term.hasSelection() ? this.term.getSelection() : "";
      const watchIps = selected ? hostAddresses(selected) : [];
      const printed = selected ? printedSpan(selected) : null;
      const printedText = printed && `${printed.first.trim()} → ${printed.last.trim()} · ${printed.ms < 60_000 ? `${printed.ms % 1000 ? (printed.ms / 1000).toFixed(3) : printed.ms / 1000}s` : durationText(printed.ms)}`;
      // A selected number in its other forms (a Unix time's date, hex ↔
      // decimal, a netmask, a byte count's size): a click copies one.
      const forms = selected ? numberForms(selected) : [];
      // A selected time with its offset ("2024-11-24T07:13:20Z", a log's)
      // in this PC's time, UTC and Unix time: lining two logs up.
      const times = forms.length || !selected ? [] : timeForms(selected);
      // A selected SNMP OID by its MIB name ("IF-MIB::ifHCInOctets.10001").
      const oid = forms.length || times.length || !selected ? null : oidName(selected);
      // A raw syslog message's "<189>": its facility and severity ("local7.notice").
      const pri = forms.length || times.length || oid || !selected ? null : priText(selected);
      const shownForms = forms.length ? forms : times.length ? times : oid ? [{ kind: "MIB 이름", text: oid, time: false }] : pri ? [{ kind: "Syslog 시설.심각도", text: pri, time: false }] : [];
      // A selected Base64 value or JWT, decoded: a click copies it (not kept
      // in the clipboard history: such values are often secrets).
      const decoded = selected ? decodeSelection(selected) : null;
      contextMenu(e.clientX, e.clientY, [
        { label: "복사", icon: "Copy", hint: keyHint("term.copy"), disabled: !this.term.hasSelection(), action: run(() => writeClipboard(this.term.getSelection())) },
        { label: "붙여넣기", icon: "ClipboardPaste", hint: keyHint("term.paste"), action: run(() => this.paste()) },
        { label: "전체 선택", hint: keyHint("term.selectAll"), action: run(() => this.term.selectAll()) },
        { label: "선택 영역 비교", icon: "Columns2", hint: keyHint("term.compare"), disabled: !this.term.hasSelection(), action: () => this.compareSelection() },
        { label: "표로 복사 (엑셀용)", icon: "Table", hint: keyHint("term.copyTable"), disabled: !this.term.hasSelection(), action: run(() => this.copyTable()) },
        // For a ticket, a wiki or a chat: the selection in a Markdown code block.
        {
          label: "코드 블록으로 복사 (Markdown)",
          icon: "Braces",
          disabled: !this.term.hasSelection(),
          action: run(() => {
            void writeClipboard(codeBlock(this.term.getSelection()));
            toast("복사했습니다", "success", 1500);
          }),
        },
        // A command that worked, kept to send again from the snippet menu.
        { label: "선택한 내용을 스니펫으로 저장…", icon: "ClipboardType", disabled: !selected.trim(), action: () => void saveSelectionAsSnippet(selected) },
        // The hosts a selected listing names ("show arp", "show cdp neighbors",
        // a hosts file), each once, pinged together: which still answer in an
        // outage. Multicast and above (224.0.0.0 on) are no host to ping.
        ...(watchIps.length >= 2
          ? [
              {
                label: `선택한 주소 ${watchIps.length}개를 연속 ping으로 지켜보기`,
                icon: "Activity",
                hint: watchIps.length > 32 ? "처음 32개" : undefined,
                action: () => void import("../nettools").then((m) => m.openMultiWatch(watchIps.map((ip) => ({ name: ip, host: ip })))),
              },
            ]
          : []),
        { label: "명령 출력 복사", icon: "ClipboardList", hint: keyHint("term.copyOutput"), action: run(() => this.copyCommandOutput()) },
        { label: "명령 출력을 파일로 저장…", icon: "Save", hint: keyHint("term.saveOutput"), action: () => void this.saveCommandOutput() },
        { label: "이전 실행과 비교", icon: "History", hint: keyHint("term.compareRuns"), action: () => this.compareRuns() },
        "-",
        { label: "터미널에서 찾기", icon: "Search", hint: keyHint("term.find"), action: () => this.toggleFind(true) },
        { label: "화면 지우기", icon: "Eraser", hint: keyHint("term.clear"), action: run(() => this.clearScreen()) },
        this.repeatMenuItem(),
        this.timerMenuItem(),
        ...(when || span || printedText ? ["-" as const] : []),
        ...(when
          ? [
              {
                label: "이 줄을 받은 시각",
                icon: "Clock",
                hint: when,
                action: run(() => {
                  void writeClipboard(when);
                  toast("시각을 복사했습니다", "success", 1500);
                }),
              },
            ]
          : []),
        // Between the selection's first and last line: a click copies it.
        ...(span
          ? [
              {
                label: "선택한 줄 사이 시간",
                icon: "Timer",
                hint: span,
                action: run(() => {
                  void writeClipboard(span);
                  toast("시각을 복사했습니다", "success", 1500);
                }),
              },
            ]
          : []),
        ...(printedText
          ? [
              {
                label: "선택한 로그 시각 사이 시간",
                icon: "Timer",
                hint: printedText,
                userHint: true,
                action: run(() => {
                  void writeClipboard(printedText);
                  toast("시각을 복사했습니다", "success", 1500);
                }),
              },
            ]
          : []),
        ...(shownForms.length
          ? [
              "-" as const,
              { label: forms.length ? "선택한 숫자 풀이" : times.length ? "선택한 시각 풀이" : oid ? "선택한 OID 풀이" : "선택한 Syslog 우선순위 풀이", icon: "Info", heading: true },
              ...shownForms.map((f) => ({
                label: f.text,
                userLabel: true,
                icon: f.time ? "Clock" : "Copy",
                hint: f.kind,
                action: run(() => {
                  void writeClipboard(f.text);
                  toast("복사했습니다", "success", 1500);
                }),
              })),
            ]
          : []),
        ...(decoded
          ? [
              "-" as const,
              { label: decoded.heading, icon: "Info", heading: true },
              ...decoded.forms.map((f) => ({
                label: decodedLabel(f.text),
                userLabel: true,
                icon: f.time ? "Clock" : "Copy",
                hint: f.kind,
                action: run(() => {
                  void writeClipboard(f.text, { secret: true }).then((ok) => toast(ok ? "복사했습니다" : "클립보드에 복사하지 못했습니다", ok ? "success" : "error", 1500));
                }),
              })),
            ]
          : []),
      ]);
    });
    this.resizer.observe(this.host);

    this.wireToolbar();
    this.renderKeyMode();
    this.connect();
  }

  /** A quick connection, named only by its address (or COM port) as main.ts
   * names one, is called by the device's host name once the monitor reads it
   * ("SW-CORE-01", not "10.0.0.5"); a name the user gave is kept. */
  title() {
    return this.deviceName() || this.session.name || endpoint(this.session);
  }

  private autoNamed(): boolean {
    const s = this.session;
    return s.id.startsWith("quick-") && (!s.name || s.name === endpoint(s) || s.name === s.host);
  }

  /** The device's host name, for a tab with no name of its own (autoNamed); null otherwise. */
  deviceName(): string | null {
    return (this.autoNamed() && this.device?.name.trim()) || null;
  }

  status(): StatusInfo {
    return {
      protocol: this.session.protocol,
      endpoint: endpoint(this.session),
      state: this.state,
      detail: `${this.term.cols}×${this.term.rows}`,
      logPath: this.logPath,
      monitor: this.monitor,
      device: this.device ? `${deviceTitle(this.device)}${this.device.name ? ` · ${userText(this.device.name)}` : ""}` : undefined,
    };
  }

  // ---- remote resource monitor (SSH, Telnet) -----------------------------------------

  /** The shared monitor connection this tab shows (see SharedMonitor). */
  private shared: SharedMonitor | null = null;
  /** A reason shown without any connection (jump host, gateway). */
  private localMonitor: MonitorInfo | null = null;

  private get monitor(): MonitorInfo | null {
    return this.shared?.info ?? this.localMonitor;
  }

  /** The shared monitor changed: redraw the status bar. */
  monitorChanged() {
    if (!this.disposed) this.ws.changed();
  }

  /** Command history and the server's command list are kept under this. */
  private get historyKey(): string {
    return `${this.session.protocol}:${endpoint(this.session)}`;
  }

  /** The device behind this tab, as the monitor recognised it. */
  get device(): DeviceInfo | undefined {
    return this.shared?.device;
  }

  /** The monitor recognised the device: show it, and use the device key mode
   * for network gear unless this session already chose a mode. */
  deviceDetected(d: DeviceInfo) {
    if (this.disposed) return;
    // The resource monitor logged in and read the device: this session is past
    // its login, so stop watching for a login failure (and free the buffer).
    this.captureLogin = false;
    this.loginText = "";
    // Remember the OS the first time so later connections skip re-detecting it:
    // the monitor reuses it, and snippets, history recall and key mode apply at
    // once without waiting. Cleared if the monitor later finds it no longer fits.
    // The label and host name follow the device too (an upgrade, a rename): found by them in the session search.
    const o = this.session.options;
    if (!this.session.id.startsWith("quick-") && (o.osKind !== d.kind || (o.osLabel ?? "") !== (d.label ?? "") || (o.osName ?? "") !== (d.name ?? ""))) {
      this.session.options.osKind = d.kind;
      this.session.options.osLabel = d.label ?? "";
      this.session.options.osName = d.name ?? "";
      patchSession(this.session.id, {}, { osKind: d.kind, osLabel: d.label ?? "", osName: d.name ?? "" }).catch(() => {});
    }
    // A Unix server's command names for suggestions, read once per server and
    // app run over the monitor's own connection (never typed into this tab).
    const key = this.historyKey;
    if (!d.network && state.settings.cmdSuggest && this.shared && !hasRemoteCommands(key)) {
      setRemoteCommands(key, []);
      api.monitorCommands(this.shared.id).then((names) => setRemoteCommands(key, names), () => {});
    }
    const button = this.el.querySelector<HTMLElement>('[data-act="device"]')!;
    button.hidden = false;
    button.querySelector("[data-device-label]")!.textContent = d.network ? deviceTitle(d) : d.name || deviceTitle(d);
    // The name is the device's own (its prompt): kept as written in the translated tooltip.
    button.title = `${deviceTitle(d)}${d.name ? ` · ${userText(d.name)}` : ""} — 자주 쓰는 명령, ${d.backup ? "설정 백업, " : ""}상위 프로세스`;
    // AIX and HP-UX take ^H for Backspace (their login prompt prints ^? for DEL).
    if ((d.kind === "aix" || d.kind === "hpux") && !this.session.options.backspace) {
      this.setKeyOption("backspace", "ctrl-h");
      toast(`${deviceTitle(d)}: Backspace를 Ctrl-H(^H)로 바꿨습니다 (툴바 "키"에서 바꿀 수 있음)`, "info", 4000);
    }
    if (d.network && this.session.options.keyMode === undefined) {
      this.session.options.keyMode = "network";
      if (!this.session.id.startsWith("quick-")) patchSession(this.session.id, {}, { keyMode: "network" }).catch(() => {});
      this.renderKeyMode();
      toast(`${deviceTitle(d)} 장비로 인식해 키 입력을 장비 방식(Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E)으로 바꿨습니다`, "info", 4000);
    }
    // An unnamed tab is now called by the device's host name (title).
    if (this.autoNamed()) this.ws.changed();
  }

  /** `cd` to `path` in this shell, from the SFTP pane opened beside it:
   * only at an idle command prompt of a session past its login, never into a
   * question; not to a device recognised as other than a Unix shell (a
   * switch's CLI, Windows). Only this tab, not broadcast. */
  cdTo(path: string) {
    // A control character in a folder name is no part of a path to the
    // terminal: Ctrl+U, Ctrl+C or Enter in it would edit or end the line and
    // run what follows, quotes or not.
    if (/[\x00-\x1f\x7f-\x9f]/.test(path)) return void toast("폴더 이름에 제어 문자가 있어 보낼 수 없습니다", "warn", 6000);
    if (QUOTE_UNSAFE(path)) return void toast(QUOTE_UNSAFE_TEXT, "warn", 6000);
    const problem = this.idleShellProblem();
    if (problem) return void toast(problem, "warn", 5000);
    this.interruptRepeat();
    this.sendInput(`cd ${shellQuote(path)}\r`);
    this.ws.focusView(this);
  }

  /** Why a command cannot go to this shell now: as notAShellLine, and the
   * prompt must be idle (nothing typed) and, for a device not recognised,
   * look like a Unix shell's ("$" or "#" at its end, not "C:\>" or "R1>"). */
  private idleShellProblem(): string | null {
    const problem = this.notAShellLine();
    if (problem) return problem;
    const prompt = this.idlePrompt();
    if (prompt === null) return "명령 프롬프트에서 아무것도 입력하지 않았을 때 보낼 수 있습니다";
    if (!this.device?.kind && !/[$#]$/.test(prompt.trimEnd())) return "Linux·Unix 셸에서만 쓸 수 있습니다";
    return null;
  }

  /** A check of a file that does not run it ("bash -n 'file'", "sudo nginx
   * -t"), put on the input line for the user to run (Enter and any sudo
   * password are theirs). `command` holds "{}" for the quoted path. As
   * sudoCopy: an idle Unix shell prompt, this tab only. */
  offerCheck(command: string, path: string, sudo: boolean): boolean {
    // The path is typed only where "{}" is ("systemctl daemon-reload" has
    // none; a mount unit's name holds "\x2d", harmless there).
    const typed = command.includes("{}");
    if (typed && /[\x00-\x1f\x7f-\x9f]/.test(path)) return void toast("이름에 제어 문자가 있어 보낼 수 없습니다", "warn", 6000), false;
    if (typed && QUOTE_UNSAFE(path)) return void toast(QUOTE_UNSAFE_TEXT, "warn", 6000), false;
    const problem = this.idleShellProblem();
    if (problem) return void toast(problem, "warn", 5000), false;
    if (this.inputScope().peers.length) return void toast("동시 입력 중에는 보낼 수 없습니다", "warn", 5000), false;
    this.putOnInputLine(`${sudo ? "sudo " : ""}${command.replace("{}", () => shellQuote(path))}`);
    this.ws.focusView(this);
    return true;
  }

  /** "sudo cp" of a copy saved beside a file the editor could not write
   * (a root's /etc file opened as a user): put on the input line, never
   * run; the user presses Enter and types the sudo password. cp onto the
   * file keeps its owner and mode; the copy goes once it is in. False when
   * it could not be put there (said why). Only this tab, not broadcast. */
  sudoCopy(from: string, to: string, steps: { install?: (copy: string, file: string) => string; then?: string; status?: string } = {}): boolean {
    for (const p of [from, to]) {
      if (/[\x00-\x1f\x7f-\x9f]/.test(p)) return void toast("이름에 제어 문자가 있어 보낼 수 없습니다", "warn", 6000), false;
      if (QUOTE_UNSAFE(p)) return void toast(QUOTE_UNSAFE_TEXT, "warn", 6000), false;
    }
    const problem = this.idleShellProblem();
    if (problem) return void toast(problem, "warn", 5000), false;
    if (this.inputScope().peers.length) return void toast("동시 입력 중에는 보낼 수 없습니다", "warn", 5000), false;
    // "--": no path read as an option. "test -f" first: a file gone since it
    // was opened is not made anew as root's (with the copy's mode).
    const [src, dst] = [shellQuote(from), shellQuote(to)];
    // Fixed commands of this app's, never a user's text, run as root:
    // `install` in place of the plain copy, given the quoted paths (sudoers:
    // checked, put in, the whole policy checked and rolled back on failure,
    // installFor); `then` once it is in ("systemctl daemon-reload" after a
    // unit file). A failure stops the line there and the copy stays.
    const put = steps.install ? steps.install(src, dst) : `sudo test -f ${dst} && sudo cp -- ${src} ${dst} && rm -f -- ${src}`;
    const then = steps.then ? ` && sudo ${steps.then}` : "";
    // Then a unit's status (read only, no sudo): "bad-setting" and why, if the
    // file just put in has a mistake.
    const status = steps.status && !QUOTE_UNSAFE(steps.status) && !/[\x00-\x1f\x7f-\x9f]/.test(steps.status) ? ` && systemctl status --no-pager -- ${shellQuote(steps.status)}` : "";
    this.putOnInputLine(`${put}${then}${status}`);
    this.ws.focusView(this);
    return true;
  }

  /** Why a path from the file tab cannot be typed here now: not connected
   * and logged in, not at a command line (a password or other question), or
   * a device recognised as other than a Unix shell (a switch's CLI). */
  private notAShellLine(): string | null {
    // A full-screen program (vi, less) would take the text as its keys; a
    // paced paste under way would run it with the paste's next line.
    if (this.disposed || this.state !== "connected" || !this.loggedIn || this.inputKind() !== "shell" || this.term.buffer.active.type !== "normal" || this.pasteActive)
      return "명령 줄에서만 보낼 수 있습니다";
    const kind = this.device?.kind;
    if (kind && !["linux", "aix", "hpux", "solaris"].includes(kind)) return "Linux·Unix 셸에서만 쓸 수 있습니다";
    return null;
  }

  /** Server paths typed at the cursor, each single-quoted, a space after
   * (no Enter: the user finishes the command). As cdTo: a shell's command
   * line only, past its login, this tab only. Typed text there stays; the
   * paths go where the cursor is. */
  private typePaths(paths: string[]) {
    if (paths.some((p) => /[\x00-\x1f\x7f-\x9f]/.test(p))) return void toast("이름에 제어 문자가 있어 보낼 수 없습니다", "warn", 6000);
    if (paths.some(QUOTE_UNSAFE)) return void toast(QUOTE_UNSAFE_TEXT, "warn", 6000);
    const problem = this.notAShellLine();
    if (problem) return void toast(problem, "warn");
    // Typed in one tab only: with input going to other tabs too, they would
    // get the rest of the line (and its Enter) without the paths.
    if (this.inputScope().peers.length) return void toast("동시 입력 중에는 경로를 끌어다 놓을 수 없습니다", "warn", 5000);
    // Right after a word ("ls" typed without its space): set apart from it,
    // else the path would join that word ("ls'/etc'"). Not after "=", ":" or
    // a quote ("if=", "host:", where the path belongs to the word), nor after
    // a prompt's "$", "#" or ">" (a leading space keeps a command out of
    // bash's history with ignorespace).
    const buf = this.term.buffer.active;
    // The whole row up to the cursor: a wide character's second cell alone reads as "".
    const before = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(false, 0, buf.cursorX) ?? "";
    const data = (/[\p{L}\p{N}_.,/~+@%-]$/u.test(before) ? " " : "") + paths.map((p) => `${shellQuote(p)} `).join("");
    this.interruptRepeat();
    this.assist.note(data);
    this.sendInput(data);
    this.ws.focusView(this);
  }

  /** Commands for the recognised device, config backup, top processes. */
  private deviceMenu() {
    const d = this.device;
    const sh = this.shared;
    if (!d || !sh) return;
    const r = this.el.querySelector<HTMLElement>('[data-act="device"]')!.getBoundingClientRect();
    const rid = this.runtimeId;
    const commands = deviceCommands(d.kind).map(([label, command]) => ({
      label: `${label}  ·  ${command}`,
      icon: "ChevronRight",
      action: () => {
        // Not into a connection made while the menu was open (a login prompt).
        if (this.state !== "connected" || this.runtimeId !== rid || !this.loggedIn) return void toast("연결이 바뀌어 보내지 않았습니다", "warn");
        // Not into a password question (enable, sudo) the line is at now.
        if (this.inputKind() !== "shell") return void toast("명령 줄에서만 보낼 수 있습니다", "warn");
        this.interruptRepeat();
        this.sendInput(`${command}\r`);
        this.term.focus();
      },
    }));
    contextMenu(r.left, r.bottom + 4, [
      { label: `${deviceTitle(d)}${d.name ? ` · ${userText(d.name)}` : ""}`, icon: "Server", heading: true },
      "-",
      ...(d.backup ? [{ label: "설정 백업 (running-config를 파일로 저장)…", icon: "Save", action: () => this.backupConfig() }] : []),
      ...(d.backup ? [{ label: "설정을 백업 파일과 비교…", icon: "Columns2", action: () => void this.compareConfig() }] : []),
      ...(d.backup ? [{ label: "설정을 AI로 점검…", icon: "Sparkles", action: () => void this.aiConfigReview() }] : []),
      { label: "상위 프로세스·리소스", icon: "Activity", action: () => showTopProcesses(sh.id, this.ws.nameOf(this)) },
      ...(this.renameItem(d.name.trim()) ?? []),
      ...(commands.length ? ["-" as const, ...commands] : []),
    ]);
  }

  /** A saved session named otherwise (often its address) can take the name
   * the device gives itself, when the user picks it; undone from its notice. */
  private renameItem(name: string): MenuItem[] | null {
    const id = this.session.id;
    const saved = state.sessions.find((s) => s.id === id);
    if (!name || !saved || saved.name.trim().toLowerCase() === name.toLowerCase()) return null;
    const old = saved.name;
    const rename = (to: string) =>
      patchSession(id, { name: to }).then(() => {
        // The tab keeps its own copy when it was opened from one.
        this.session.name = to;
        this.ws.changed();
      });
    return [
      {
        label: `세션 이름을 장비 이름으로 바꾸기 · ${userText(name)}`,
        icon: "Pencil",
        action: () =>
          void rename(name).then(
            () =>
              toast(`세션 이름을 바꿨습니다: ${userText(old)} → ${userText(name)}`, "success", 8000, {
                label: "되돌리기",
                // Only while it still has the name given here: one the user typed since stays.
                run: () => {
                  if (state.sessions.find((s) => s.id === id)?.name !== name) return void toast("그 뒤에 이름이 바뀌어 되돌리지 않았습니다", "info");
                  void rename(old).catch((err) => toast(errorText(err), "error"));
                },
              }),
            (err) => toast(errorText(err), "error"),
          ),
      },
    ];
  }

  // ---- AI (ai/panel.ts) ----

  private aiPanel: AiPanel | null = null;

  /** What the AI sees of this tab. */
  private get aiHost(): AiHost {
    return {
      target: () => {
        const d = this.device;
        // Windows over OpenSSH: "PS C:\Users\me>" (PowerShell) or "C:\Users\me>" (cmd).
        if (this.windowsShell()) return { system: "Windows", network: false, windows: true };
        if (d) return { system: [deviceTitle(d), d.label].filter(Boolean).join(" · "), network: d.network };
        return { system: this.session.protocol === "serial" ? "a device on a serial console" : "", network: this.keyMode === "network" };
      },
      conversationKey: () => this.historyKey,
      hostNames: () => [this.session.host, this.session.name, this.device?.name ?? "", this.session.username ?? "", ...this.assist.promptNames()].filter((s) => s && s.length >= 3),
      selection: () => this.term.getSelection(),
      recentOutput: (lines) => {
        const buf = this.term.buffer.active;
        const end = buf.baseY + buf.cursorY;
        const out: string[] = [];
        for (let y = Math.max(0, end - lines); y <= end; y++) out.push(buf.getLine(y)?.translateToString(true) ?? "");
        return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      },
      insert: (command) => {
        if (this.state !== "connected") return toast("연결된 다음 넣을 수 있습니다", "warn");
        // Judged when the button is pressed: a line that is a login, password
        // or host-key question by then (a console that timed out, a sudo or
        // enable asking) must not get a command typed into it.
        if (!this.atCommandLine()) return toast("명령 줄에서만 보낼 수 있습니다", "warn");
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(command)) return toast("이름에 제어 문자가 있어 보낼 수 없습니다", "warn", 6000);
        this.putOnInputLine(command);
      },
      focus: () => this.term.focus(),
      run: (command, reason) => this.runForAi(command, reason),
      network: () => !!this.device?.network || this.keyMode === "network",
    };
  }

  private aiRunning = false;

  /** Run a command an AI chose in this terminal, in plain view, and return
   * what it printed up to the next prompt. Interactive programs and pagers
   * are left (q / space), a command still running after `timeoutMs` gets
   * Ctrl+C. Every run is written to the risky-command audit log. */
  /** A Windows shell over SSH, told by its prompt ("PS C:\Users\me>" or
   * "C:\Users\me>"): the one learnt, or the line the cursor is on. */
  private windowsShell(): boolean {
    const buf = this.term.buffer.active;
    const left = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true, 0, buf.cursorX) ?? "";
    return [this.assist.knownPrompt(), left].some((p) => /^(PS )?[A-Za-z]:\\[^>]*>$/.test(p.trim()));
  }

  private async runForAi(command: string, reason: string, timeoutMs = 30_000): Promise<{ output: string; timedOut: boolean }> {
    if (this.state !== "connected") throw new Error("연결이 끊어져 실행하지 않았습니다");
    // A control character would be a key, not text (Ctrl+U erasing what was
    // approved, Ctrl+O running the line): never sent (policy.judge blocks it too).
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(command)) throw new Error("제어 문자가 든 명령이라 실행하지 않았습니다");
    if (this.aiRunning) throw new Error("다른 명령이 실행 중입니다");
    this.interruptRepeat();
    if (this.term.buffer.active.type !== "normal") throw new Error("화면 전체를 쓰는 프로그램이 실행 중이라 실행하지 않았습니다");
    // Never into a login or password prompt (each run would be a failed login).
    if (!this.loggedIn || this.inputKind() !== "shell") throw new Error("로그인을 마친 다음 명령 줄에서 실행할 수 있습니다");
    const rid = this.runtimeId;
    this.aiRunning = true;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const marker = this.term.registerMarker(0);
    try {
      await api.riskAudit("AI RUN", this.session.name || endpoint(this.session), endpoint(this.session), reason, command).catch(() => {});
      if (this.state !== "connected" || this.runtimeId !== rid || !this.loggedIn) throw new Error("연결이 바뀌어 실행하지 않았습니다");
      // The prompt this line started with: the next one looks like it ("[root@host /]#" → "[root@host tmp]#").
      const prompt = this.assist.knownPrompt().trim();
      const stem = prompt.slice(0, Math.min(6, prompt.length));
      // Clear what the engineer left on the line: Ctrl+U, or Backspaces in
      // Windows PowerShell (PSReadLine does not bind Ctrl+U there).
      const typed = this.assist.typedText();
      const clear = !typed ? "" : this.windowsShell() ? "\x7f".repeat(typed.length) : LINE_CLEAR;
      const data = clear + command.replace(/[\r\n]+/g, " ") + "\r";
      this.assist.note(data);
      this.sendInput(data);
      const started = Date.now();
      let seen = "";
      let changed = Date.now();
      let timedOut = false;
      let interrupted = false;
      for (;;) {
        await sleep(150);
        if (this.state !== "connected" || this.disposed) throw new Error("연결이 끊어졌습니다");
        const buf = this.term.buffer.active;
        const row = buf.baseY + buf.cursorY;
        const left = buf.getLine(row)?.translateToString(true, 0, buf.cursorX) ?? "";
        const now = `${buf.type}:${buf.length}:${row}:${buf.cursorX}:${left}`;
        if (now !== seen) {
          seen = now;
          changed = Date.now();
        }
        const quiet = Date.now() - changed;
        if (buf.type !== "normal") {
          // A full-screen program (less, vi, top): leave it.
          if (quiet > 500) (this.sendInput("q"), (changed = Date.now()));
          continue;
        }
        if (quiet > 400 && /--More--|\(END\)|^:\s*$|<--- More --->|---- More ----/.test(left.trim())) {
          this.sendInput(this.device?.network || this.keyMode === "network" ? " " : "q");
          changed = Date.now();
          continue;
        }
        const atPrompt = row > marker.line && PROMPT_END.test(left) && (!stem || left.trimStart().startsWith(stem));
        if (atPrompt && quiet >= 500) break;
        if (Date.now() - started > timeoutMs) {
          if (interrupted) break;
          timedOut = interrupted = true;
          this.sendInput("\x03");
          timeoutMs += 3000;
        }
      }
      // From the line after the command (its wrapped rows skipped) to the prompt.
      const buf = this.term.buffer.active;
      const end = buf.baseY + buf.cursorY;
      let y = marker.line + 1;
      while (y < end && buf.getLine(y)?.isWrapped) y++;
      const lines: string[] = [];
      for (; y < end; y++) {
        const line = buf.getLine(y);
        if (!line) continue;
        const text = line.translateToString(true);
        if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
        else lines.push(text);
      }
      let output = lines.join("\n").replace(/\s+$/, "");
      if (output.length > 12_000) output = `${output.slice(0, 4000)}\n…(${output.length - 12_000}자 생략)…\n${output.slice(-8000)}`;
      return { output, timedOut };
    } finally {
      marker.dispose();
      this.aiRunning = false;
    }
  }

  private aiMenu() {
    const r = this.el.querySelector<HTMLElement>('[data-act="ai"]')!.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, [
      { label: "명령 만들기 (할 일을 말로 적기)", icon: "WandSparkles", action: () => void this.aiCommand() },
      { label: this.term.hasSelection() ? "선택 영역 설명" : "화면 출력 설명", icon: "Sparkles", action: () => void this.aiExplain() },
      { label: this.aiPanel ? "AI 대화 닫기" : "AI 대화 열기", icon: "Bot", action: () => void this.toggleAiPanel() },
      { label: "파일 분석 (설정·로그)…", icon: "FileSearch", action: () => void this.openAiPanel().then((p) => p.el.querySelector<HTMLElement>('[data-act="file"]')?.click()) },
      ...(this.device?.backup ? [{ label: "장비 설정을 AI로 점검", icon: "ShieldCheck", action: () => void this.aiConfigReview() }] : []),
    ]);
  }

  private async aiCommand() {
    const m = await aiModule();
    m.commandBar(this.el, this.aiHost);
  }

  private async openAiPanel(): Promise<AiPanel> {
    if (this.aiPanel) return this.aiPanel;
    const m = await aiModule();
    this.aiPanel = new m.AiPanel(this.aiHost, () => this.closeAiPanel());
    this.el.append(this.aiPanel.el);
    this.el.classList.add("with-ai");
    this.layout();
    return this.aiPanel;
  }

  private closeAiPanel() {
    this.aiPanel?.dispose();
    this.aiPanel = null;
    this.el.classList.remove("with-ai");
    this.layout();
    this.term.focus();
  }

  private async toggleAiPanel() {
    if (this.aiPanel) return this.closeAiPanel();
    (await this.openAiPanel()).focus();
  }

  /** Explain the selection, or the last screenful when nothing is selected. */
  private async aiExplain() {
    const text = this.term.getSelection().trim() || this.aiHost.recentOutput(40);
    if (!text) return toast("설명할 출력이 없습니다", "info");
    (await this.openAiPanel()).explain(text);
  }

  /** Read the running configuration over the monitor connection and review it. */
  private async aiConfigReview() {
    const d = this.device;
    const sh = this.shared;
    if (!d || !sh) return;
    toast("장비에서 설정을 읽는 중…", "info", 2500);
    try {
      const text = await api.monitorBackup(sh.id);
      (await this.openAiPanel()).analyse(text, "config", `${deviceTitle(d)} ${d.name || this.session.host} running-config`);
    } catch (err) {
      toast(`설정을 읽지 못했습니다: ${errorText(err)}`, "error", 6000);
    }
  }

  /** Save the device's running configuration, read over the monitor connection. */
  private async backupConfig() {
    const d = this.device;
    const sh = this.shared;
    if (!d || !sh) return;
    toast("장비에서 설정을 읽는 중…", "info", 2500);
    try {
      const text = await api.monitorBackup(sh.id);
      const name = (d.name || this.session.host).replace(/[<>:"/\\|?*]/g, "_");
      const path = await pickSavePath(`${name}_${timestamp()}.cfg`, [{ name: "설정 파일", extensions: ["cfg", "txt", "conf"] }]);
      if (!path) return;
      await api.saveTextFile(path, text);
      rememberBackup(this.backupKey, path);
      toast(`설정을 저장했습니다 (${text.split("\n").length}줄): ${userText(path)}`, "success", 6000);
    } catch (err) {
      toast(`설정 백업 실패: ${errorText(err)}`, "error", 6000);
    }
  }

  /** Which device a remembered backup belongs to: the saved session, or the
   * address of a quick connection. */
  private get backupKey(): string {
    const s = this.session;
    return s.id.startsWith("quick-") ? `quick:${s.protocol}:${s.host.trim().toLowerCase()}:${s.port ?? ""}` : s.id;
  }

  /** The device's configuration as it is now against a backup file (one saved
   * before a change, to see what the change did), side by side in the
   * comparison window. The file last saved or compared for this device is
   * offered first. Read through the resource monitor's connection, as the
   * backup is: nothing is typed into this terminal. */
  private async compareConfig() {
    const d = this.device;
    const sh = this.shared;
    if (!d || !sh) return;
    const path = await pickOpenFile("비교할 설정 백업 파일", lastBackup(this.backupKey));
    if (!path || this.disposed) return;
    let saved: string;
    try {
      saved = await api.readTextFile(path);
    } catch (err) {
      return void toast(errorText(err), "error", 6000);
    }
    if (saved.includes("\0")) return void toast("텍스트 파일이 아니라 비교할 수 없습니다", "warn");
    rememberBackup(this.backupKey, path);
    toast("장비에서 설정을 읽는 중…", "info", 2500);
    try {
      const now = await api.monitorBackup(sh.id);
      const { openDiff } = await import("../diffView");
      // Names as they are (a path, a device name and the time): the source titles are not translated.
      openDiff({ title: path.split(/[\\/]/).pop() ?? path, text: saved }, { title: `${d.name || this.session.host} ${timestamp()}`, text: now });
    } catch (err) {
      toast(`설정을 읽지 못했습니다: ${errorText(err)}`, "error", 6000);
    }
  }

  /** Change this tab's font size by `step` points (8–32). It stays this tab's
   * own size when the settings change. */
  private zoom(step: number) {
    const size = Math.max(8, Math.min(32, (this.term.options.fontSize ?? 14) + step));
    if (size === this.term.options.fontSize) return;
    this.zoomed = size;
    this.term.options.fontSize = size;
    this.layout();
    this.showZoom(size);
  }

  /** Back to the font size from Settings; this tab then follows that setting again. */
  private zoomReset() {
    const size = state.settings.fontSize;
    this.zoomed = null;
    if (size !== this.term.options.fontSize) {
      this.term.options.fontSize = size;
      this.layout();
    }
    this.showZoom(size);
  }

  private showZoom(size: number) {
    let badge = this.el.querySelector<HTMLElement>(".zoom-badge");
    if (!badge) {
      badge = h("div", { class: "zoom-badge" });
      this.host.parentElement!.appendChild(badge);
    }
    badge.textContent = `글자 크기 ${size}`;
    badge.classList.add("show");
    clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => badge.classList.remove("show"), 900);
  }
  private zoomTimer = 0;
  /** The find button's tooltip as last set (the toolbar builds the same text). */
  private findTitle = withKey("터미널에서 찾기", "term.find");
  /** Font size chosen with Ctrl+wheel / the zoom buttons, if any. */
  private zoomed: number | null = null;

  /** Show the CPU/memory monitor for this server, starting its connection
   * (a second, quiet login) unless another tab already runs it. */
  /** `auto`: started by a login going through, not by the user. */
  async startMonitor(extra: { password?: string; trustedFingerprint?: string; noPassword?: boolean } = {}, auto = false) {
    const proto = this.session.protocol;
    if ((proto !== "ssh" && proto !== "telnet") || !state.settings.remoteMonitor || this.disposed) return;
    if (this.session.options.jumpHost || this.session.options.gateway) {
      this.localMonitor = { kind: "unsupported", message: "점프 호스트·게이트웨이 세션" };
      return this.ws.changed();
    }
    const key = [proto, this.session.host.trim().toLowerCase(), this.session.port ?? "", this.session.username].join("|");
    let m = monitors.get(key);
    if (!m) {
      m = { id: crypto.randomUUID(), key, info: null, views: new Set(), user: "" };
      monitors.set(key, m);
      monitorsById.set(m.id, m);
    }
    if (this.shared !== m) {
      this.leaveMonitor();
      m.views.add(this);
      this.shared = m;
      if (m.device) this.deviceDetected(m.device);
      syncPause(m);
    }
    // Another tab's connection is already up (or logging in): just show it.
    const running = m.info?.kind === "stats" || m.info?.kind === "starting";
    if (running && !extra.password && !extra.trustedFingerprint && !extra.noPassword) return this.ws.changed();
    // An earlier start asked for a login: ask again rather than try once more.
    const lk = loginKey(m, this.session.credentialId);
    m.credentialId = this.session.credentialId;
    if (auto && monitorNeedsLogin.has(lk)) return setMonitorInfo(m, { kind: "login", message: "" });
    // An earlier start failed otherwise: shown again, not tried again on its own.
    const failed = auto ? monitorStartFailed.get(lk) : undefined;
    if (failed) return setMonitorInfo(m, failed);
    setMonitorInfo(m, { kind: "starting" });
    try {
      await api.monitorStart({
        id: m.id,
        protocol: proto,
        host: this.session.host,
        port: this.session.port,
        username: this.session.username || m.user,
        credentialId: this.session.credentialId,
        proxy: this.session.options.gateway ? null : proxyOf(this.session),
        ...extra,
      });
      // Over SSH the call returns once its login went through: an earlier
      // failure is past, before any sample (a device's CLI is read later).
      if (proto === "ssh") monitorStartFailed.delete(lk);
      // The login can outlast the tabs: if all of them closed meanwhile, the
      // connection would otherwise stay open.
      if (monitorsById.get(m.id) !== m) api.monitorStop(m.id).catch(() => {});
    } catch (err) {
      if (monitorsById.get(m.id) === m) setMonitorInfo(m, failedMonitor(errorText(err)));
    }
  }

  /** Stop showing the shared monitor; the last tab closes its connection. */
  private leaveMonitor() {
    const m = this.shared;
    this.shared = null;
    if (!m) return;
    m.views.delete(this);
    if (m.views.size) return syncPause(m);
    monitors.delete(m.key);
    monitorsById.delete(m.id);
    api.monitorStop(m.id).catch(() => {});
  }

  private stopMonitor() {
    this.leaveMonitor();
    this.localMonitor = null;
  }

  /** Status bar click on the monitor chip: top processes, log in, or approve the host key. */
  async monitorAction() {
    const m = this.monitor;
    const sh = this.shared;
    if (!m) return;
    if (m.kind === "stats" && sh) return showTopProcesses(sh.id, this.ws.nameOf(this));
    if (m.kind === "login" && sh) {
      // A user name typed here (the session has none) is asked again after a
      // failed login, filled in: it may be the wrong one, not only the password.
      // (A key passphrase refused is not about the name.)
      const typedFailed = !this.session.username && !!sh.user && m.message === "비밀번호가 올바르지 않습니다";
      if (m.needUser || typedFailed || (!this.session.username && !sh.user && this.session.protocol === "telnet")) {
        const u = await promptDialog({ title: "리소스 모니터링 로그인", label: "사용자 이름", icon: "Activity", confirm: "다음", value: sh.user });
        if (!u?.value.trim()) return;
        sh.user = u.value.trim();
      }
      // The user's values kept as written in a translated label; "사용자" is app text.
      const user = this.session.username || sh.user;
      const who = user ? userText(user) : "사용자";
      const res = await promptDialog({
        title: "리소스 모니터링 로그인",
        label: /키 암호/.test(m.message ?? "")
          ? `${who}@${userText(this.session.host)} 의 개인 키 암호 (모니터링에만 쓰고 저장하지 않음)`
          : `${who}@${userText(this.session.host)} 의 비밀번호 (모니터링에만 쓰고 저장하지 않음)`,
        type: "password",
        icon: "Activity",
        confirm: "모니터링 시작",
        extra: this.session.protocol === "telnet" ? `<p class="muted small">비밀번호 없이 들어가는 장비라면 비워 두고 시작하세요.</p>` : undefined,
      });
      if (!res) return;
      if (res.value) this.startMonitor({ password: res.value });
      else if (this.session.protocol === "telnet") this.startMonitor({ noPassword: true });
    } else if (m.kind === "hostkey") {
      const ok = await confirmDialog({
        title: "처음 보는 호스트 키",
        icon: "ShieldCheck",
        message: `모니터링 연결이 <b data-i18n-skip>${esc(this.session.host)}</b>의 호스트 키를 확인해야 합니다.<br><br>지문: <code class="fp">${esc(m.fingerprint ?? "")}</code>`,
        confirm: "신뢰하고 시작",
      });
      if (ok) this.startMonitor({ trustedFingerprint: m.fingerprint });
    } else if (m.kind === "error") {
      this.startMonitor();
    }
  }

  /** Fit the terminal to its box, once per frame however many observers
   * ask. Only a real change of rows/columns reflows the buffer and is
   * reported to the server (and to the status bar). */
  layout() {
    if (this.layoutFrame) return;
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = 0;
      if (this.disposed || !this.el.isConnected || this.host.clientWidth === 0) return;
      try {
        const want = this.fit.proposeDimensions();
        if (!want || isNaN(want.cols) || isNaN(want.rows)) return;
        if (want.cols !== this.term.cols || want.rows !== this.term.rows) {
          // New columns reflow the wrapped lines and renumber the rows: the
          // line times are carried over by logical line.
          const reflow = want.cols !== this.term.cols;
          const keep = reflow ? this.timesBeforeReflow() : null;
          this.fit.fit();
          // xterm lets a scroll region go with the size.
          this.scrollRegion = 0;
          if (keep) this.timesAfterReflow(keep);
          else if (reflow) this.timesUnknown();
        }
      } catch {
        return;
      }
      const size = `${this.term.cols}x${this.term.rows}`;
      if (size === this.sentSize) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        if (this.disposed) return;
        this.sentSize = size;
        if (this.runtimeId) api.termResize(this.runtimeId, this.term.rows, this.term.cols).catch(() => {});
        this.ws.changed();
      }, 80);
    });
  }
  private layoutFrame = 0;
  /** Rows/columns last reported (a new connection reports again). */
  private sentSize = "";

  /** This tab is on screen (active, or in a visible split pane). */
  shown(): boolean {
    return this.ws.visibleTabs().some((t) => t.view === this);
  }

  /** On screen, as the workspace last reported (false while minimised). */
  onScreen = false;

  shownChanged(shown: boolean) {
    this.onScreen = shown;
    if (this.shared) syncPause(this.shared);
    this.updateRenderer();
  }

  /** The DOM renderer blinks the cursor with an endless CSS animation, which
   * makes the page redraw every frame even when nothing changes (on a PC
   * without a GPU about 3% of a core while a terminal has the focus). There a
   * timer hides the cursor every other half second instead; WebGL blinks with
   * a timer of its own. */
  private blinkTimer = 0;
  private wireBlink() {
    const el = this.term.element!;
    const stop = () => {
      clearInterval(this.blinkTimer);
      this.blinkTimer = 0;
      el.classList.remove("bx-cursor-off");
    };
    const start = () => {
      stop();
      if (this.webgl || this.disposed) return;
      this.blinkTimer = window.setInterval(() => el.classList.toggle("bx-cursor-off"), 530);
    };
    this.term.textarea?.addEventListener("focus", start);
    this.term.textarea?.addEventListener("blur", stop);
    // Typing keeps the cursor on, as with xterm's own blink.
    this.term.onData(() => this.blinkTimer && start());
    this.restartBlink = () => (document.activeElement === this.term.textarea ? start() : stop());
  }
  private restartBlink = () => {};

  /** WebGL draws terminals on screen only (browsers allow ~16 contexts). */
  private webgl: { dispose(): void } | null = null;
  private rendererSeq = 0;
  private async updateRenderer() {
    const mode = state.settings.renderer;
    const want = this.onScreen && !this.disposed && !webglFailed && (mode === "webgl" || (mode === "auto" && realGpu()));
    if (want === !!this.webgl) return this.syncBlink();
    const seq = ++this.rendererSeq;
    if (!want) {
      this.webgl?.dispose();
      this.webgl = null;
      return this.syncBlink();
    }
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      if (seq !== this.rendererSeq || this.disposed || this.webgl) return;
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        if (this.webgl === addon) this.webgl = null;
        this.syncBlink();
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch {
      webglFailed = true;
    }
    this.syncBlink();
  }

  /** xterm blinks under WebGL; under the DOM renderer the timer does. */
  private syncBlink() {
    const own = !!this.webgl;
    if (this.term.options.cursorBlink !== own) this.term.options.cursorBlink = own;
    this.restartBlink();
  }

  focus() {
    this.term.focus();
  }

  /** Input for the connection. Typed while it is still being opened (a
   * Telnet connect, a gateway login), it waits and goes out once open. */
  sendInput(data: string) {
    // An Enter or Ctrl+C from any path (typed, a snippet, an AI run, a device
    // menu, a startup command) ends this line: the next starts its own
    // broadcast (lineScope).
    if (/[\r\n\x03]/.test(data)) this.setLineScope(null);
    if (this.opened !== this.runtimeId) {
      if (this.early.length < 1000) this.early.push(data);
      return;
    }
    if (this.pasting && this.paced && /\r[^]/.test(data)) return this.pacePaste(data);
    if (this.pasteActive && data.includes("\x03")) this.stopPaste();
    api.termWrite(this.runtimeId, data).catch((err) => this.inputRefused(err));
  }

  /** Multi-line input reaches a device console one line at a time, as fast
   * as the device takes it (paste.rs): serial ports, and Telnet sessions
   * marked as console-server connections. */
  private get paced(): boolean {
    return this.session.protocol === "serial" || (this.session.protocol === "telnet" && !!this.session.options.pacedPaste);
  }

  /** A paced paste is running on this connection. */
  private pasteActive = false;
  private pasteStarted = 0;

  private pacePaste(data: string) {
    const s = state.settings;
    const mode = s.pasteMode === "fixed" ? { kind: "fixed" as const, lineMs: s.pasteLineDelay, charMs: s.pasteCharDelay } : { kind: "echo" as const };
    if (!this.pasteActive) this.pasteStarted = Date.now();
    this.pasteActive = true;
    api.termPaste(this.runtimeId, data, mode).catch((err) => {
      this.pasteActive = false;
      this.inputRefused(err);
    });
  }

  /** Stop the paced paste; `quiet`: the connection is going away anyway. */
  private stopPaste(quiet = false) {
    if (!this.pasteActive) return;
    api.termPasteStop(this.runtimeId).catch(() => {});
    if (quiet) {
      this.pasteActive = false;
      this.renderPasteProgress(null);
    }
  }

  pasteProgress(e: PasteEvent) {
    if (e.id !== this.runtimeId || this.disposed) return;
    if (e.state === "running") {
      this.pasteActive = true;
      this.renderPasteProgress(e);
      return;
    }
    this.pasteActive = false;
    this.renderPasteProgress(null);
    // Lines left out on purpose are not "not sent" ones the user must send again.
    const skipped = e.skipped ?? 0;
    const left = e.total - e.sent - skipped;
    const secs = Math.max(1, Math.round((Date.now() - this.pasteStarted) / 1000));
    if (e.state === "login") toast(`장비가 로그인을 물어 붙여넣기를 멈췄습니다 (${left}줄은 보내지 않음). 로그인한 다음 다시 보내세요`, "warn", 10000);
    else if (e.state === "noprompt") toast(`장비의 프롬프트가 다시 나타나지 않아 붙여넣기를 멈췄습니다 (${left}줄은 보내지 않음). 화면을 확인한 다음 남은 줄을 다시 보내세요`, "warn", 10000);
    else if (e.state === "stopped" && left) toast(`붙여넣기를 멈췄습니다 (${left}줄은 보내지 않음)`, "warn");
    else if (e.state === "failed") toast(`연결이 끊어져 붙여넣기를 마치지 못했습니다 (${left}줄은 보내지 않음)`, "error", 6000);
    else if (e.state === "done" && e.total >= 20) toast(`${e.sent}줄을 보냈습니다 (${secs}초)`, "success", 3000);
    if (skipped) toast("enable이 비밀번호를 묻지 않아서, 비밀번호로 보이는 다음 줄은 명령으로 보내지 않고 건너뛰었습니다", "info", 8000);
  }

  /** Lines sent, time left and a stop button over the terminal while a
   * paced paste of more than a few lines runs; null removes it. */
  private renderPasteProgress(e: PasteEvent | null) {
    let box = this.el.querySelector<HTMLElement>(".paste-progress");
    if (!e || e.total < 5) {
      box?.remove();
      return;
    }
    if (!box) {
      box = h("div", { class: "paste-progress", role: "status" });
      box.innerHTML = `<div class="pp-row"><span>붙여넣는 중</span><b data-pp-count></b><span class="muted" data-pp-eta></span>
          <button type="button" class="btn sm" data-pp-stop title="남은 줄을 보내지 않습니다 (Ctrl+C)">${icon("CircleStop", 13)}<span>중지</span></button></div>
        <div class="pp-bar"><i></i></div>`;
      box.querySelector("[data-pp-stop]")!.addEventListener("click", () => {
        this.stopPaste();
        this.term.focus();
      });
      this.host.parentElement!.appendChild(box);
    }
    const done = e.sent + (e.skipped ?? 0);
    box.querySelector<HTMLElement>("[data-pp-count]")!.textContent = `${done} / ${e.total}`;
    box.querySelector<HTMLElement>(".pp-bar i")!.style.width = `${(100 * done) / e.total}%`;
    const elapsed = (Date.now() - this.pasteStarted) / 1000;
    // Lines still to send (those left out on purpose need no time).
    const eta = e.sent > 2 && elapsed > 0.5 ? Math.ceil(((e.total - done) * elapsed) / e.sent) : 0;
    box.querySelector<HTMLElement>("[data-pp-eta]")!.textContent = eta ? tr(`약 ${eta}초 남음`) : "";
  }

  /** Send a text file (a configuration) as if it were pasted. */
  private async sendFile() {
    if (this.state !== "connected") return toast("연결된 다음에 보낼 수 있습니다", "warn");
    // Taken before the file is picked: see sendScope.
    const scope = this.inputScope();
    const path = await pickOpenFile("보낼 텍스트 파일");
    if (!path) return;
    try {
      const text = await api.readTextFile(path);
      if (!text) return toast("빈 파일입니다", "warn");
      this.pasteFromUser(text, path.split(/[\\/]/).pop(), scope);
    } catch (err) {
      toast(errorText(err), "error", 6000);
    }
  }
  /** The runtime id whose backend session exists (termOpen returned). */
  private opened = "";
  private early: string[] = [];

  /** termOpen returned: send what was typed meanwhile and what was acknowledged. */
  private connectionOpened(rid: string) {
    this.opened = rid;
    const early = this.early.splice(0);
    if (early.length) api.termWrite(rid, early.join("")).catch(() => {});
    if (this.acked) this.ack(rid, 0);
  }

  receiveBroadcast(input: BroadcastInput): boolean {
    return this.receiveInput(input, null).sent;
  }

  /** The line (its first row) this tab last took broadcast input on: one the
   * output has moved it to since is checked again (see receiveInput). */
  private recvMark: IMarker | undefined;
  /** That line up to the cursor when its first key came (its prompt). */
  private recvPrefix = "";

  /** The screen was cleared in place or reset: the line marks of broadcast
   * point at whatever is drawn on those rows now, another line. */
  private dropLineMarks() {
    this.recvMark?.dispose();
    this.recvMark = undefined;
    this.lineScope?.mark?.dispose();
  }

  /** Broadcast input; `confirmed`: what the sender's riskGate confirmed for
   * this tab too (null when nothing was confirmed). An Enter runs what is on
   * THIS tab's line, which may differ from the sender's (keys typed before
   * broadcast was turned on, its own history or completion): it is checked
   * here, and a risky line other than the very one confirmed gets neither the
   * Enter nor what follows. */
  receiveInput(input: BroadcastInput, confirmed: RiskHit[] | null): { sent: boolean; hit: RiskHit | null } {
    // Input for a line of another kind than this one is at now (it timed out
    // to "Username:", it asks for a password) is held, and the sender sends
    // this tab no more of that line. On the line this tab last took input on,
    // only an Enter is checked: an answer echoed there may only look like a
    // question. On a line the output moved it to, every key is: keys going
    // into an unseen password (or out of one into a shell) would show only
    // at its Enter. Nothing is sent to clear the line (Ctrl+U goes into an
    // ssh.exe question as a character, and a device may bind it to something else).
    const body = "editKey" in input ? "" : "keys" in input ? input.keys : input.paste;
    const enterAt = body.search(/[\r\n]/);
    if (input.kind) {
      const sameLine = !!this.recvMark && !this.recvMark.isDisposed && this.recvMark.line === this.lineRow();
      // On that line, what was there when its first key came (the prompt)
      // still there: only the keys typed after it can make it look like a
      // question ("show logging | include user: admin"), not the device.
      const asItWas = sameLine && !!this.recvPrefix && (this.lineBeforeCursor(4000) ?? "").startsWith(this.recvPrefix);
      if ((enterAt >= 0 || !sameLine) && !asItWas && this.inputKind() !== input.kind) {
        if ("keys" in input && enterAt >= 0) toast(`${userText(this.ws.nameOf(this))}: 이 탭의 줄이 다른 종류(비밀번호 질문 등)라 동시 입력의 Enter를 보내지 않았습니다`, "warn", 6000);
        else toast(`${userText(this.ws.nameOf(this))}: 이 탭의 줄이 다른 종류(비밀번호 질문 등)라 동시 입력을 보내지 않았습니다`, "warn", 6000);
        return { sent: false, hit: null };
      }
      if (!sameLine) {
        this.recvMark?.dispose();
        this.recvMark = this.lineMark();
        this.recvPrefix = (this.lineBeforeCursor(4000) ?? "").trimEnd();
      }
    }
    this.interruptRepeat();
    if ("editKey" in input) {
      this.keyLine = input.editKey === "Backspace" ? keyLine(this.keyLine, "\b") : null;
      this.sendInput(this.editKeyBytes(input.editKey));
      return { sent: true, hit: null };
    }
    const text = "keys" in input ? this.expandKeys(input.keys) : input.paste;
    // What lands on the line before the first Enter (a paste's line breaks are Enters too).
    const enter = /[\r\n]/.exec(text);
    let own: RiskHit | null = null;
    // An answer to a password question is no command: never checked (and so
    // never shown or recorded as one).
    if (enter && input.kind !== "secret" && (confirmed || state.settings.checkTypedCommands || "paste" in input)) {
      const hit = this.enterRisk(text.slice(0, enter.index));
      own = hit;
      if (hit && !(hit.rule.action !== "block" && confirmed?.some((c) => c.rule === hit.rule && endsInCommand(hit.line, c.line)))) {
        toast(`${userText(this.ws.nameOf(this))}: 줄에 위험한 명령이 있어 동시 입력의 Enter를 보내지 않았습니다 (${hit.rule.note}). 확인한 뒤 이 탭에서 직접 Enter를 누르세요`, "warn", 8000);
        // Keys before the Enter still arrive, so the line matches what was typed.
        if ("keys" in input && enter.index) {
          const head = input.keys.slice(0, input.keys.search(/[\r\n]/));
          this.assist.note(head);
          this.keyLine = keyLine(this.keyLine, this.expandKeys(head));
          this.sendInput(this.expandKeys(head));
        }
        return { sent: false, hit };
      }
    }
    if ("keys" in input) {
      this.assist.note(input.keys);
      // The line after these keys: an Enter starts a new one.
      const last = Math.max(text.lastIndexOf("\r"), text.lastIndexOf("\n"));
      this.keyLine = last < 0 ? keyLine(this.keyLine, text) : keyLine("", text.slice(last + 1));
      this.sendInput(text);
    } else {
      this.pasteText(input.paste);
    }
    return { sent: true, hit: own };
  }

  /** A recorded macro's editing-key marks as this tab's own bytes. */
  private expandKeys(data: string): string {
    return data.replace(/[\uE100-\uE103]/g, (m) => this.editKeyBytes(MARKED_KEYS[m.charCodeAt(0) - 0xe100]));
  }

  /** Bytes for an editing key in this tab's key mode: control keys for network
   * gear, the VT sequences (honouring application cursor mode) otherwise. */
  private editKeyBytes(key: EditKey): string {
    // AIX and HP-UX logins (and their default stty erase) take ^H, not DEL.
    if (key === "Backspace") return this.session.options.backspace === "ctrl-h" ? "\x08" : "\x7f";
    if (this.keyMode === "network") return { Delete: "\x04", Home: "\x01", End: "\x05" }[key];
    const app = this.term.modes.applicationCursorKeysMode;
    return { Delete: "\x1b[3~", Home: app ? "\x1bOH" : "\x1b[H", End: app ? "\x1bOF" : "\x1b[F" }[key];
  }

  /** Paste through xterm so this terminal's bracketed-paste mode applies. */
  private pasteText(text: string) {
    this.pasting = true;
    try {
      this.term.paste(text);
    } finally {
      this.pasting = false;
    }
  }

  private refusedAt = 0;
  /** Typed input the session did not take (the device holds XOFF and the
   * queue is full): say so, at most every few seconds, instead of losing
   * keystrokes silently. */
  private inputRefused(err: unknown) {
    if (this.state !== "connected" || Date.now() - this.refusedAt < 5000) return;
    this.refusedAt = Date.now();
    toast(`입력을 보내지 못했습니다: ${errorText(err)}`, "warn");
  }

  /** Risky commands (riskRules.ts): blocked ones never go out; the others
   * only after a confirmation, with the tab's log on and an audit line.
   * Resolves to the other tabs (broadcast) the confirmed input goes to, or
   * null when nothing may be sent. A risky command goes exactly to the tabs
   * that were confirmed, logged and audited, even if another tab connects
   * while the dialog is open. `source` names where the command came from;
   * `tag` marks the audit events ("" for snippets and macros). */
  private async riskGate(hits: RiskHit[], source: string, tag: string, scope: SendScope & { kind?: InputKind | null; mark?: IMarker } = this.sendScope()): Promise<Tab[] | null> {
    // With broadcast on the same input also goes to these tabs.
    const same = this.stillSame(scope);
    if (!same) {
      toast("연결이 바뀌어 보내지 않았습니다", "warn");
      return null;
    }
    // Before any login, no text goes to the other tabs (see mirrorTyped).
    const prelogin = scope.kind === "prelogin";
    const others = prelogin ? [] : same;
    const targets = [{ session: this.session, view: this as View }, ...others];
    const where = targets.map((t) => endpoint(t.session)).join(", ");
    const audit = (event: string, to: { session: Session }[] = targets) =>
      Promise.all(
        to.flatMap((t) => hits.map((h) => api.riskAudit(tag ? `${event} ${tag}` : event, t.session.name || endpoint(t.session), endpoint(t.session), h.rule.note, h.line))),
      ).then(
        () => true,
        (err) => {
          toast(errorText(err), "error");
          return false;
        },
      );
    // User data (commands, names) is shown as is, never run through translation.
    const item = (h: RiskHit) => `<li><code data-i18n-skip>${esc(h.line)}</code> — <span>${esc(h.rule.note)}</span></li>`;
    const blocked = hits.filter((h) => h.rule.action === "block");
    if (blocked.length) {
      await audit("BLOCKED");
      await confirmDialog({
        title: "차단된 명령입니다",
        icon: "ShieldAlert",
        danger: true,
        message: `<p>보낼 수 없는 명령이 있어 아무것도 보내지 않았습니다.</p><p class="muted small">${source}</p><ul>${blocked.map(item).join("")}</ul>
          <p class="muted small">이 시도는 위험 명령 기록(risky-commands.log)에 남았습니다. 규칙은 설정 → 위험 명령에서 바꿀 수 있습니다.</p>`,
        confirm: "확인",
        cancel: null,
      });
      return null;
    }
    const ok = await confirmDialog({
      title: "위험한 명령이 있습니다",
      icon: "TriangleAlert",
      danger: true,
      message: `<p>보내면 다음 명령이 실행됩니다.</p><p class="muted small"><span>${source}</span> · 대상: <b data-i18n-skip>${esc(where)}</b></p><ul>${hits.map(item).join("")}</ul>
        ${others.length ? `<p class="muted small">${others.length}개 탭에 동시 입력이 켜져 있어 함께 보냅니다.</p>` : ""}
        <p class="muted small">보내면 받는 탭의 로그 기록이 켜지고, 위험 명령 기록(risky-commands.log)에 남습니다.</p>`,
      confirm: "로그를 켜고 보내기",
      cancel: "취소",
      focusCancel: true,
    });
    if (!ok) {
      await audit("CANCELLED");
      return null;
    }
    // Only to the connections the dialog was about: not to one that
    // reconnected while it was open (it may be at a login prompt).
    const changed = async () => {
      await audit("NOT SENT");
      toast(this.state !== "connected" ? "연결이 끊어져 보내지 않았습니다" : "연결이 바뀌어 보내지 않았습니다", "warn");
      return null;
    };
    let now = this.stillSame(scope);
    if (!now) return changed();
    // The log and the audit line are the condition for sending: when
    // either cannot be written, nothing goes out. Recorded for the tabs it
    // goes to now: "CONFIRMED" first, then "SENT" or "NOT SENT".
    const to = [{ session: this.session, view: this as View }, ...now];
    const logged = await Promise.all(to.map((t) => t.view.ensureLog?.() ?? Promise.resolve(false)));
    if (logged.includes(false) || !(await audit("CONFIRMED", to))) {
      await audit("NOT SENT", to);
      toast("로그를 켜거나 위험 명령 기록을 남길 수 없어 보내지 않았습니다", "error");
      return null;
    }
    now = this.stillSame(scope);
    if (!now) return changed();
    // This tab's own line is another kind now (see lineStill).
    if (scope.kind !== undefined && !this.lineStill(scope)) {
      await audit("NOT SENT", to);
      toast(LINE_CHANGED, "warn", 6000);
      return null;
    }
    // Broadcast turned off or a tab left out meanwhile: not to it; before any
    // login, no text to the other tabs (see mirrorTyped).
    const live = new Set(this.ws.mirrorTargets(this, false));
    now = prelogin ? [] : now.filter((t) => live.has(t));
    // It goes out right after this returns, with nothing in between; each
    // other tab is recorded as it is delivered (deliverConfirmed).
    void audit("SENT", [{ session: this.session }]);
    this.noteLeftOut(scope, now);
    return now;
  }

  /** Where input typed here goes now: this connection and, with broadcast
   * on, the other tabs' connections. Taken before a dialog, so that what it
   * confirms goes only to the connections still the same afterwards: one
   * that reconnected meanwhile may sit at a login or password prompt, where
   * a command must never land. */
  private sendScope(): SendScope {
    return { rid: this.runtimeId, peers: this.ws.mirrorTargets(this).map((tab) => ({ tab, id: tab.view.connectionId?.() })) };
  }

  /** The scope's other tabs still on the same connection; null when this
   * tab is not (disconnected, or reconnected since). */
  private stillSame(scope: SendScope): Tab[] | null {
    if (this.state !== "connected" || this.runtimeId !== scope.rid) return null;
    return scope.peers.filter((p) => p.tab.view.state === "connected" && p.tab.view.connectionId?.() === p.id).map((p) => p.tab);
  }

  connectionId(): string {
    return this.runtimeId;
  }

  /** What typing at the cursor goes into now, from the cursor line: a host
   * key, secret or user name question (also after the login: an enable or
   * sudo password), else a logged-in session ("shell") or one before its
   * login ("prelogin"); null while not connected. */
  inputKind(): InputKind | null {
    if (this.state !== "connected") return null;
    // A question is the line it ends with (its echoed answer aside: a user
    // name shows, a password does not): all of it when it wraps in a narrow
    // pane ("Enter passphrase for key '/home/…'"), its end when even longer.
    const normal = this.term.buffer.active.type === "normal";
    const line = normal ? (this.lineBeforeCursor(160) ?? this.lineBeforeCursor(4000)?.slice(-160) ?? "") : "";
    const before = line.trimEnd();
    const bare = before.replace(ECHOED_SECRET, "$1");
    const shell = SHELL_PROMPT_SHAPE.test(before);
    if (!shell && HOSTKEY_WORDS.test(bare) && (/[:：?？]$/.test(bare) || /\(yes\/no/i.test(bare))) return "hostkey";
    // A [y/N] choice before a secret: "Change the password now? [y/N]:" asks no password.
    if (!shell && (CONFIRM_QUESTION.test(bare) || FILE_QUESTION.test(before))) return "confirm";
    // A secret before a user name: "[sudo] password for user:" asks a password.
    if (CREDENTIAL_PROMPT.test(bare) && /[:：?？]$/.test(bare)) return "secret";
    // A line shaped as a shell prompt is one, whatever its host or
    // directory is named ("deploy@sso-login:~$", "PS C:\passwords>").
    if (!shell) {
      if (CREDENTIAL_PROMPT.test(bare) && SECRET_ANGLE.test(bare)) return "secret";
      if (USER_QUESTION.test(before) || USER_ANSWERED.test(before) || (!this.loggedIn && (LOGIN_END.test(before) || USER_ANSWERED_ANGLE.test(before)))) return "user";
      // A console that timed out to its welcome: the next Enter starts a login.
      if (normal && !before && this.waitsToStart()) return "prelogin";
    }
    return this.loggedIn ? "shell" : "prelogin";
  }

  /** A console timed out to its welcome ("Press RETURN to get started."),
   * the cursor on a blank line under it: what is typed next wakes it into a
   * login (a line pasted there would go in as a user name and a password). */
  private waitsToStart(): boolean {
    const buf = this.term.buffer.active;
    for (let y = buf.baseY + buf.cursorY - 1, n = 0; y >= 0 && n < 4; y--, n++) {
      const text = buf.getLine(y)?.translateToString(true).trim() ?? "";
      if (text) return /press (?:return|enter) to get started/i.test(text);
    }
    return false;
  }

  /** This line's broadcast: the tabs of the same kind of line when its first
   * key was typed, kept until it ends (Enter, Ctrl+C), so no tab ever gets
   * the end of a line without its start; a tab that comes to fit later
   * joins at the next line. */
  private lineScope: (SendScope & { kind: InputKind | null; mark: IMarker | undefined }) | null = null;

  /** A new or no line scope (its marker freed). */
  private setLineScope(scope: (SendScope & { kind: InputKind | null; mark: IMarker | undefined }) | null) {
    if (this.lineScope?.mark && this.lineScope.mark !== scope?.mark) this.lineScope.mark.dispose();
    this.lineScope = scope;
  }

  /** The cursor's line up to the cursor, its wrapped rows joined; null when
   * longer than `max` characters. */
  private lineBeforeCursor(max: number): string | null {
    const buf = this.term.buffer.active;
    const cursor = buf.baseY + buf.cursorY;
    let text = buf.getLine(cursor)?.translateToString(true, 0, buf.cursorX) ?? "";
    for (let y = cursor; y > 0 && buf.getLine(y)?.isWrapped; y--) {
      if (text.length > max) return null;
      text = rowText(buf, y - 1).text + text;
    }
    return text.length > max ? null : text;
  }

  /** A marker on the line the cursor is on now (its first row when it wraps). */
  private lineMark(): IMarker | undefined {
    const buf = this.term.buffer.active;
    return this.term.registerMarker(this.lineRow() - (buf.baseY + buf.cursorY));
  }

  /** The buffer row the cursor's line starts on (a long line wraps over several). */
  private lineRow(): number {
    const buf = this.term.buffer.active;
    let y = buf.baseY + buf.cursorY;
    while (y > 0 && buf.getLine(y)?.isWrapped) y--;
    return y;
  }

  /** A new line scope: the tabs and the kind of line as it starts now. */
  private newLineScope() {
    return { ...this.sendScope(), kind: this.inputKind(), mark: this.lineMark() };
  }

  /** This line's scope while the line is still the one it was taken on; else
   * none (it is let go). A line on a connection made since is a new one; so
   * is one the output moved to that asks something else (a key answered
   * without Enter, then a password question). */
  private currentLineScope() {
    const s = this.lineScope;
    if (!s) return null;
    const moved = !s.mark || s.mark.isDisposed || s.mark.line !== this.lineRow();
    if (s.rid === this.runtimeId && !(moved && this.inputKind() !== s.kind)) return s;
    this.setLineScope(null);
    return null;
  }

  /** Where input sent here (a paste, a snippet, a held Enter) goes, and the
   * kind of line it goes to: this line's broadcast when one is under way, so
   * no tab gets the end of a line without its start; else a new one. */
  private inputScope(): SendScope & { kind: InputKind | null; mark?: IMarker } {
    return this.currentLineScope() ?? { ...this.sendScope(), kind: this.inputKind() };
  }

  /** This tab's line is still what `scope` was taken at (after a dialog): the
   * same line, which the user's own typing may make look otherwise, or one of
   * the same kind. A console that timed out to "Username:" meanwhile is not:
   * each line sent there would be a failed login. */
  private lineStill(scope: { kind?: InputKind | null; mark?: IMarker }): boolean {
    if (scope.mark && !scope.mark.isDisposed && scope.mark.line === this.lineRow()) return true;
    return this.inputKind() === (scope.kind ?? null);
  }

  /** After a paste or snippet `sent` here and to `took`: ending in an Enter
   * (or Ctrl+C), a new line starts; else its last line goes on, in the tabs
   * it went to (the keys typed next go to them, not to others). */
  private continueLine(scope: SendScope & { kind: InputKind | null }, took: Tab[], sent: string) {
    const tabs = new Set(took);
    this.setLineScope(!sent || /[\r\n\x03]$/.test(sent) ? null : { rid: scope.rid, peers: scope.peers.filter((p) => tabs.has(p.tab)), kind: scope.kind, mark: this.lineMark() });
  }

  /** Typed input to this line's broadcast tabs (see lineScope). */
  private mirrorTyped(input: BroadcastInput, endsLine: boolean) {
    if (!this.currentLineScope()) {
      this.setLineScope(this.newLineScope());
      if (this.ws.broadcast) this.ws.tabsChanged();
    }
    const scope = this.lineScope!;
    if (endsLine) this.setLineScope(null);
    if (!scope.kind) return;
    // Before any login, between tabs nothing is known of: only the Enter or
    // Ctrl+C that wakes a console, never text (a login question not
    // recognised would take it).
    if (scope.kind === "prelogin" && !("keys" in input && /^[\r\n\x03]+$/.test(input.keys))) return;
    // Still connected the same way, and broadcast still on for them. The
    // kind goes along: each receiver looks at its line (see receiveInput).
    const live = new Set(this.ws.mirrorTargets(this, false));
    const took = new Set(broadcastTo((this.stillSame(scope) ?? []).filter((t) => live.has(t)), { ...input, kind: scope.kind }));
    // A tab that did not take it (its line is another kind now, it left
    // broadcast, it reconnected) gets no more of this line.
    scope.peers = scope.peers.filter((p) => took.has(p.tab));
  }

  /** Say so when some broadcast tabs of `scope` are left out of `sent`. */
  private noteLeftOut(scope: SendScope, sent: Tab[]) {
    const n = scope.peers.length - sent.length;
    if (n > 0) toast(`동시 입력 대상 중 ${n}개 탭은 연결이 바뀌어 보내지 않았습니다`, "warn", 6000);
  }

  /** Keys the user typed here. Enter is CR or LF (Ctrl+J), and one key event
   * can bring text and Enter together (Alt+Enter is ESC CR): every Enter is
   * checked and ends the line, whatever came with it. */
  private typedInput(data: string) {
    this.interruptRepeat();
    for (const part of data.split(/(?<=[\r\n])/)) {
      const enter = /[\r\n]$/.test(part) ? part.slice(-1) : "";
      const keys = enter ? part.slice(0, -1) : part;
      if (keys) {
        this.keyLine = keyLine(this.keyLine, keys);
        this.typedOut(keys);
      }
      if (!enter) continue;
      // Held: it goes out after the confirmation, or never; keys typed after
      // it in the same event would land on the wrong line, so they are dropped.
      if (this.holdRiskyEnter(enter)) return;
      this.enterSent();
      this.typedOut(enter);
    }
  }

  /** Typed input to the connection, the broadcast tabs and a macro being recorded. */
  private typedOut(data: string) {
    this.assist.note(data);
    this.mirrorTyped({ keys: data }, /[\r\n\x03]/.test(data));
    this.echoTyped(data);
    this.sendInput(data);
    this.recording?.push(data);
  }

  /** What this serial session's own line shows of the keys typed on it
   * (localEcho), for Backspace to rub out only that, and the row it is on:
   * once the device's output moves the cursor to another line, nothing
   * echoed is on it. */
  private echoLine = { text: "", row: -1 };

  /** Local echo (a serial device that does not echo): only keys typed here,
   * one Enter at a time (typedInput splits them), each judged by the line it
   * goes to. Not a paste, a snippet, a macro or a sent file, whose later
   * lines may answer a password question, be held back or come before the
   * device's replies; not the terminal's automatic replies; not before the
   * port is open; never the answer to a password question. */
  private echoTyped(data: string) {
    if (this.session.protocol !== "serial" || this.session.options.localEcho !== true) return;
    if (this.opened !== this.runtimeId || this.inputKind() === "secret") {
      // Nothing of this line is on screen to rub out.
      if (/[\r\n]/.test(data)) this.echoLine.text = "";
      return;
    }
    const row = this.lineRow();
    if (row !== this.echoLine.row) this.echoLine = { text: "", row };
    const shown = localEcho(data, this.echoLine);
    if (shown) this.term.write(shown);
    // Where the cursor will be once this is drawn: an Enter echoed moves it down.
    if (/[\r\n]/.test(data)) this.echoLine.row = -1;
  }

  /** Enter goes out now (typed, held and confirmed, or a repeated command's):
   * the command line ends. `command`: the line on screen; before its echo
   * arrives (fast typing, slow links), the keys pressed since the last Enter. */
  private enterSent(command = this.assist.typedText() || this.keyLine || "") {
    this.markCommand(command);
    this.lsColors.submitted(command, this.assist.knownPrompt());
    this.keyLine = "";
  }

  /** Where commands were entered at the prompt, oldest first, to jump back to
   * them in long output (term.prevCommand / term.nextCommand). xterm disposes
   * a marker whose line leaves the scrollback. */
  private commandMarks: IMarker[] = [];
  /** The prompt each mark's command was typed at (copyCommandOutput). */
  private markPrompts = new WeakMap<IMarker, string>();
  /** The command line last jumped to, and where the view was then: pressing
   * again goes on from it even when the view could not scroll (the last screen). */
  private lastJump: { line: number; viewportY: number } | null = null;

  /** A command was entered: remember its line. Not inside vi, less and other
   * full-screen programs, and not for an empty Enter. Only the position is
   * kept, never what was typed. */
  private markCommand(command: string) {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal" || !command.trim()) return;
    const cursor = buf.baseY + buf.cursorY;
    // An answer to a password prompt ("[sudo] password for …:") is not a
    // command: the command it belongs to stays marked and timed.
    const before = buf.getLine(cursor)?.translateToString(true, 0, buf.cursorX) ?? "";
    if (CREDENTIAL_PROMPT.test(before)) return;
    // Typed at a prompt, not a repeated run: the work timer it may be for.
    if (!this.repeat) this.offerTimer(command);
    let y = cursor;
    while (y > 0 && buf.getLine(y)?.isWrapped) y--;
    const marker = this.term.registerMarker(y - cursor);
    if (!marker) return;
    // Marks at or below this line are from before a "clear" (the screen is
    // blanked in place, so their rows were reused): they point at nothing now.
    this.dropCommandMarks((m) => m.line >= marker.line);
    this.commandMarks.push(marker);
    if (this.commandMarks.length > 1000) this.commandMarks.shift()!.dispose();
    // A new command: the next jump starts from where the view is.
    this.lastJump = null;
    // Timed until the prompt comes back (watchCommandEnd), when it is known.
    const prompt = this.assist.knownPrompt().trimEnd();
    if (prompt) this.markPrompts.set(marker, prompt);
    clearTimeout(this.commandEndTimer);
    this.runningCommand = prompt ? { marker, prompt, start: Date.now() } : null;
    this.pagerSeen = false;
  }

  /** Dispose the command marks `which` picks (their ⏱ labels go with them). */
  private dropCommandMarks(which: (m: IMarker) => boolean) {
    this.commandMarks = this.commandMarks.filter((m) => {
      if (m.isDisposed) return false;
      if (!which(m)) return true;
      m.dispose();
      return false;
    });
    this.lastJump = null;
  }

  /** The command being timed: its line, the prompt it was entered at, and when. */
  private runningCommand: { marker: IMarker; prompt: string; start: number } | null = null;
  private commandEndTimer = 0;
  private lastOutputAt = 0;

  /** Output arrived while a command runs: once it pauses, see whether the
   * prompt is back (the command is done). */
  private watchCommandEnd() {
    if (!this.runningCommand) return;
    this.lastOutputAt = Date.now();
    clearTimeout(this.commandEndTimer);
    this.commandEndTimer = window.setTimeout(() => !this.disposed && this.commandEnded(), 300);
  }

  /** The cursor waits after the prompt the command was entered at (or one of
   * the same device: "router#" → "router(config)#") on a later line: the
   * command is done. A long one gets its time shown at the end of its line. */
  private commandEnded() {
    const run = this.runningCommand;
    if (!run || run.marker.isDisposed) return void (this.runningCommand = null);
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return; // vi, less …: not back yet
    const row = buf.baseY + buf.cursorY;
    if (row <= run.marker.line) return;
    // Up to the cursor's column (cells, so a wide character counts as two).
    const before = (buf.getLine(row)?.translateToString(true, 0, buf.cursorX) ?? "").trimEnd();
    // The device's pager stopped the output ("--More--"): offered off once the
    // prompt is back (keys typed now would go to the pager).
    if (PAGER_PROMPT.test(before)) this.pagerSeen = true;
    if (!before || !PROMPT_END.test(before)) return;
    // The same prompt, or the same host's in another mode or folder ("router#"
    // → "router(config)#", "user@web:~$" → "user@web:/tmp$"); not another
    // host's ("router2#", the prompt of a server reached by ssh).
    if (before !== run.prompt && !(promptHost(run.prompt) && promptHost(before) === promptHost(run.prompt))) return;
    this.runningCommand = null;
    if (this.pagerSeen) {
      this.pagerSeen = false;
      this.offerPagerOff(before);
    }
    const ms = this.lastOutputAt - run.start;
    if (ms >= 2000) this.showDuration(run.marker, ms);
    this.commandDone(run, ms);
  }

  /** The running command's output met the device's pager ("--More--"). */
  private pagerSeen = false;
  /** Turning the pager off was offered in this connection (once is enough). */
  private pagerOffered = false;

  /** A command's output stopped at the device's pager and its prompt is back:
   * once per connection, the device's own session-only command that turns
   * paging off (devmon.rs Kind::pager_off, as the monitor uses it) is offered.
   * Sent only on a click, and only to an empty prompt of this tab that is
   * still the same device's (`prompt`: the one the output came back to; after
   * ssh or telnet to another device the command would mean nothing there). */
  private offerPagerOff(prompt: string) {
    const command = this.device?.pagerOff;
    if (!command || this.pagerOffered || !this.loggedIn) return;
    this.pagerOffered = true;
    toast(`이 장비가 긴 출력을 페이지로 나눕니다 (--More--). 이 연결에서만 끄는 명령: ${userText(command)}`, "info", 12000, {
      label: "페이지 나눔 끄기",
      run: () => {
        // As cdTo, and not in the middle of a paced paste.
        if (this.disposed || this.state !== "connected" || !this.loggedIn || this.pasteActive || this.inputKind() !== "shell") return void toast("명령 줄에서만 보낼 수 있습니다", "warn");
        const now = this.idlePrompt();
        if (now === null) return void toast("명령 프롬프트에서 아무것도 입력하지 않았을 때 보낼 수 있습니다", "warn", 5000);
        // The same device's prompt, by its head (user included); a prompt with
        // no head ("$ ", "# ") cannot tell devices apart: not sent.
        if (!promptHead(prompt) || promptHead(now.trimEnd()) !== promptHead(prompt)) return void toast("다른 장비의 프롬프트라 보내지 않았습니다", "warn", 5000);
        this.interruptRepeat();
        this.sendInput(`${command}\r`);
        this.ws.focusView(this);
      },
    });
  }

  /** "작업 완료" on, the prompt back: told now (not after the silence of
   * armNotify), with the command and how long it took, unless this tab is
   * being watched. The silence timer's notice is then not needed. */
  private commandDone(run: { marker: IMarker; prompt: string }, ms: number) {
    if (!this.notifyDone || this.disposed) return;
    clearTimeout(this.notifyTimer);
    this.notifySaw = false;
    // A repeat sends its command again and again: told once, when it stops (stopRepeat).
    if (this.repeat || (this.isOnScreen() && document.hasFocus())) return;
    // The line as typed (wrapped rows joined); a line that does not start with
    // the prompt was no command (an answer to a question, keys typed into
    // output): no command named then, rather than a piece of output.
    const line = this.commandBook().text(run.marker.line);
    const typed = line.startsWith(run.prompt) ? line.slice(run.prompt.length).trim() : "";
    const command = typed.length > 80 ? `${typed.slice(0, 79)}…` : typed;
    const body = [this.ws.nameOf(this), command && `${command} (${durationText(ms)})`].filter(Boolean).join("\n");
    osNotify(tr("작업 완료"), body, () => this.ws.focusView(this));
  }

  /** "⏱ 12.4s" at the right end of a command's line, where it does not cover
   * the command itself. */
  private showDuration(marker: IMarker, ms: number) {
    const label = `⏱ ${durationText(ms)}`;
    const width = label.length + 1;
    // Columns the line uses: up to its last non-blank cell (a wide character
    // takes two, so the text's length would undercount).
    const line = this.term.buffer.active.getLine(marker.line);
    if (!line) return;
    const cell = this.term.buffer.active.getNullCell();
    let used = 0;
    for (let x = line.length - 1; x >= 0; x--) {
      if (line.getCell(x, cell)?.getChars().trim()) {
        used = x + Math.max(1, cell.getWidth());
        break;
      }
    }
    if (used + width + 2 > this.term.cols) return;
    const deco = this.term.registerDecoration({ marker, x: this.term.cols - width, width, layer: "top" });
    deco?.onRender((el) => {
      el.textContent = label;
      el.classList.add("cmd-duration");
      // Centred in the row: the line as high as the row xterm sized it to.
      el.style.lineHeight = el.style.height;
    });
  }

  /** Scroll to the previous (-1) or next (1) command line and flash it. */
  private jumpCommand(dir: -1 | 1) {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return;
    this.commandMarks = this.commandMarks.filter((m) => !m.isDisposed && m.line >= 0);
    const lines = this.commandMarks.map((m) => m.line);
    const atBottom = buf.viewportY >= buf.baseY;
    const here =
      this.lastJump && this.lastJump.viewportY === buf.viewportY
        ? this.lastJump.line
        : dir < 0 && atBottom
          ? buf.baseY + buf.cursorY
          : buf.viewportY;
    const target = dir < 0 ? [...lines].reverse().find((l) => l < here) : lines.find((l) => l > here);
    if (target === undefined) {
      // Past the last command: back to the live end of the output.
      if (dir > 0) this.term.scrollToBottom();
      this.lastJump = null;
      return;
    }
    this.term.scrollToLine(target);
    this.lastJump = { line: target, viewportY: buf.viewportY };
    this.flashLine(target);
  }

  /** Light up a buffer line briefly (the selection colour, made opaque). */
  private flashLine(line: number) {
    const buf = this.term.buffer.active;
    const marker = this.term.registerMarker(line - (buf.baseY + buf.cursorY));
    if (!marker) return;
    const theme = this.term.options.theme ?? {};
    const deco = this.term.registerDecoration({ marker, width: this.term.cols, backgroundColor: opaque(theme.selectionBackground, theme.background) });
    window.setTimeout(() => {
      deco?.dispose();
      marker.dispose();
    }, 900);
  }

  /** The command line the cursor is on, wrapped rows joined; null on a
   * full-screen program's screen (vi, less, top, menus own it: no command line there). */
  private screenLine(): string | null {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return null;
    let y = buf.baseY + buf.cursorY;
    while (y > 0 && buf.getLine(y)?.isWrapped) y--;
    const parts: string[] = [];
    for (; buf.getLine(y); y++) {
      const { text, continues } = rowText(buf, y);
      parts.push(text);
      if (!continues) break;
    }
    return parts.join("");
  }

  /** The risk of pressing Enter here after `more` is added to the line: the
   * screen line (history recall, Tab completion and in-line edits count as
   * they ended up), and the keys typed since the last Enter, which are ahead
   * of their echo on a slow link. A block rule outranks a warning. */
  private enterRisk(more = ""): RiskHit | null {
    const screen = this.screenLine();
    if (screen === null) return null;
    const keys = this.keyLine === null ? null : keyLine(this.keyLine, more);
    const hits = [findTypedRisk(screen + more), keys === null ? null : findCommandRisk(keys)].filter((h): h is RiskHit => !!h);
    return hits.find((h) => h.rule.action === "block") ?? hits[0] ?? null;
  }

  /** Enter typed on a command line that a risk rule matches is held and goes
   * through riskGate like a snippet. True when the Enter was held (it is
   * sent later, or never). */
  private holdRiskyEnter(enter: string): boolean {
    if (this.state !== "connected" || !state.settings.checkTypedCommands) return false;
    // The tabs that got this line's keys (see lineScope), and its kind.
    const line = this.inputScope();
    // An answer to a password question is no command: never checked, shown or recorded.
    if (line.kind === "secret") return false;
    const hit = this.enterRisk();
    if (!hit) return false;
    // The command after this tab's prompt, which the other tabs' lines must
    // end in to get the Enter (their prompts differ).
    const command = (this.assist.typedText() || this.keyLine || "").trim();
    const confirmedHit = command ? { ...hit, line: command } : hit;
    // The line goes on until the Enter goes out (sendInput ends it): if this
    // is cancelled, an edit and another Enter still go to the same tabs.
    void this.riskGate([hit], "직접 입력한 명령", "(typed)", line).then((others) => {
      if (others) {
        this.enterSent();
        this.sendInput(enter);
        this.assist.sent();
        deliverConfirmed(others, { keys: enter, kind: line.kind ?? undefined }, [confirmedHit], "(typed)");
        this.recording?.push(enter);
      }
      this.term.focus();
    });
    return true;
  }

  /** Values this output offers for a snippet's {{?name}}, by what the name
   * asks for: the interfaces it shows for an interface or a port ("인터페이스",
   * "port"), the IPv4 addresses for an address or a target ("대상", "IP",
   * "host"); the newest first, each once. Nothing for any other name. */
  private valuesFor(name: string, text: string): string[] {
    // Whole words in English: no "ip" in "zip", no "port" in "report". A
    // MAC address is no IP address. "포트"/"port" alone may be a TCP port
    // ("telnet {{?host}} {{?port}}"): a switch port only in a snippet about
    // interfaces.
    const aboutInterfaces = /\b(?:int(?:erface)?|switchport|shut(?:down)?)\b/i.test(text.replace(/\{\{\?[^}]*\}\}/g, " "));
    const wantsPort = /인터페이스|\b(?:interface|intf|if)\b/i.test(name) || (/포트|\bport\b/i.test(name) && aboutInterfaces);
    const wantsAddress = !/mac/i.test(name) && /대상|주소|호스트|\b(?:ip|host|address|target|peer|neighbor)\b/i.test(name);
    if (!wantsPort && !wantsAddress) return [];
    const out = new Set<string>();
    const lines = [...this.outputLines()];
    for (let i = lines.length - 1; i >= 0 && out.size < 50; i--) {
      const text = lines[i].text;
      if (wantsPort) for (const m of findInterfaces(text)) out.add(interfaceNames(m.type, m.number).short);
      if (wantsAddress) for (const m of findIps(text)) if (!m.ip.includes(":")) out.add(m.ip);
    }
    return [...out];
  }

  /** Send a saved command; it follows broadcast like typed input does. True
   * once sent; nothing when not (its values cancelled, a risk refused, not
   * connected). */
  async sendSnippet(s: Snippet): Promise<true | void> {
    if (this.state !== "connected") return void toast("연결된 다음 보낼 수 있습니다", "warn");
    // Its {{?name}} values first, if it has any: then sent only to the
    // connections it was asked on (see sendScope), and the line it joins.
    const scope = this.inputScope();
    let text = s.text;
    if (asksValues(s)) {
      const filled = await askSnippetValues(s, (name, text) => this.valuesFor(name, text));
      this.term.focus();
      if (filled === null) return;
      if (!this.stillSame(scope)) return void toast("연결이 바뀌어 보내지 않았습니다", "warn");
      if (!this.lineStill(scope)) return void toast(LINE_CHANGED, "warn", 6000);
      text = filled;
    }
    this.interruptRepeat();
    // Macro text may hold editing-key marks; other tabs expand them their own way.
    const marked = s.macro ? s.text : text.replace(/\r?\n/g, "\r") + (s.run ? "\r" : "");
    const data = this.expandKeys(marked);
    // Several lines into a login, password or host-key question: each would
    // be an attempt; before a login, only when the user says so.
    const enters = data.match(/\r\n?|\n/g)?.length ?? 0;
    if ((scope.kind === "user" || scope.kind === "secret" || scope.kind === "hostkey") && enters > 1) return void toast(MANY_LINES_AT_LOGIN, "warn", 6000);
    if (scope.kind === "prelogin" && enters > 1) {
      if (!(await this.confirmBeforeLogin(enters))) return;
      if (!this.stillSame(scope)) return void toast("연결이 바뀌어 보내지 않았습니다", "warn");
      if (!this.lineStill(scope)) return void toast(LINE_CHANGED, "warn", 6000);
    }
    const hits = findRisks(data);
    // Its first line joins what is already on the command line, as a paste's does.
    const enterAt = s.macro ? -1 : data.search(/[\r\n]/);
    const first = enterAt >= 0 && this.term.buffer.active.type === "normal" ? this.enterRisk(data.slice(0, enterAt)) : null;
    if (first && !hits.some((h) => h.rule === first.rule)) hits.unshift(first);
    let confirmedOthers: Tab[] | null = null;
    if (hits.length) {
      confirmedOthers = await this.riskGate(hits, `스니펫: <b data-i18n-skip>${esc(s.name)}</b>`, "", scope);
      if (!confirmedOthers) return void this.term.focus();
    }
    const peers = confirmedOthers ?? this.stillSame(scope);
    if (!peers) return void toast("연결이 바뀌어 보내지 않았습니다", "warn");
    if (!confirmedOthers) this.noteLeftOut(scope, peers);
    this.sendInput(data);
    const kind = scope.kind ?? undefined;
    const live = new Set(this.ws.mirrorTargets(this, false));
    const took = confirmedOthers
      ? deliverConfirmed(confirmedOthers, { keys: marked, kind }, hits, "")
      : kind !== "prelogin"
        ? broadcastTo(peers.filter((t) => live.has(t)), { keys: marked, kind })
        : [];
    this.continueLine(scope, took, data);
    this.recording?.push(marked);
    this.term.focus();
    // The lines it ran (the last one only with "Enter after sending"): the
    // work timer one of them may be for.
    if (!s.macro && this.term.buffer.active.type === "normal") {
      const lines = text.split(/\r?\n/);
      for (const line of s.run ? lines : lines.slice(0, -1)) this.offerTimer(line);
    }
    // Sent (every earlier return is a "not sent": cancelled, refused, not connected).
    return true;
  }

  /** A command sent again every few seconds (term.repeat), as `watch` would
   * on gear that has none. It goes out only at the prompt it started at, once
   * the previous run's output has ended, and never to a login or password
   * prompt. Input to this tab, a disconnect, or a prompt that does not come
   * back stops it. Only this tab: not broadcast, not recorded. */
  private repeat: RepeatState | null = null;
  /** The last repeat's settings, offered the next time (this tab, not saved). */
  private repeatLast = { command: "", every: 5, count: 60 };
  /** When output last arrived: a prompt is judged only once output pauses. */
  private lastRx = 0;

  /** The prompt the cursor waits at with nothing typed, or null (output on
   * the line, a full-screen program, a login, password or pager prompt). */
  private idlePrompt(): string | null {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return null;
    const line = buf.getLine(buf.baseY + buf.cursorY);
    const before = (line?.translateToString(true, 0, buf.cursorX) ?? "").trimEnd();
    // Nothing after the cursor either (a command being edited in the middle).
    if ((line?.translateToString(true) ?? "").trimEnd() !== before) return null;
    if (!before || !PROMPT_END.test(before) || CREDENTIAL_PROMPT.test(before) || LOGIN_END.test(before) || PAGER_PROMPT.test(before)) return null;
    // Known prompt plus more ("user@web:~$ ls >"): a command is typed on it.
    const known = this.assist.knownPrompt().trimEnd();
    if (this.assist.typedText() || (known && before !== known && before.startsWith(known))) return null;
    return before;
  }

  /** A work timer (term.timer): a reminder at a set time, for a change that
   * undoes itself unless confirmed in time ("reload in 10", "commit confirmed
   * 10"). It shows its time left on the tab and warns a minute before and at
   * the end, with a sound, a flashing taskbar button and a message (a Windows
   * notification when the app is not in front or is locked). An ended timer
   * stays on the tab, marked, until this tab is used. It runs whatever the
   * connection does: the device's own countdown goes on. Nothing is sent. */
  private timer: {
    /** The end by the wall clock and by the monotonic one: the earlier is
     * taken, so neither a clock change nor sleep makes the warning late. */
    endWall: number;
    endMono: number;
    note: string;
    warned: boolean;
    ended: boolean;
    tick: number;
    /** One-off wake-ups at the warning and the end: a hidden window slows a
     * repeating timer to once a minute, a one-off one far less. */
    wakeups: number[];
  } | null = null;
  /** The last timer's settings, offered the next time (this tab, not saved). */
  private timerLast = { minutes: 10, note: "" };

  private timerLeft(): number {
    const t = this.timer;
    return t ? Math.min(t.endWall - Date.now(), t.endMono - performance.now()) : 0;
  }

  /** Start or stop the work timer, in the snippet and right-click menus. */
  private timerMenuItem(): MenuItem {
    return this.timer && !this.timer.ended
      ? {
          label: "작업 타이머 멈추기",
          icon: "TimerOff",
          hint: timerClock(this.timerLeft()),
          action: () => {
            this.stopTimer("작업 타이머를 멈췄습니다");
            this.term.focus();
          },
        }
      : { label: "작업 타이머…", icon: "Timer", hint: keyHint("term.timer"), action: () => void this.toggleTimer() };
  }

  /** term.timer: ask for the time and a note and start, or stop. */
  private async toggleTimer() {
    if (this.timer && !this.timer.ended) {
      this.stopTimer("작업 타이머를 멈췄습니다");
      return this.term.focus();
    }
    return this.openTimer();
  }

  /** The timer dialog, starting with `preset` (read from a command just
   * sent) or the last settings; a timer it starts replaces one running. */
  private async openTimer(preset?: { minutes: number; note: string; sent?: { wall: number; mono: number } }) {
    const last = preset ?? this.timerLast;
    const minutesOf = (v: string) => (/^\s*\d{1,4}\s*$/.test(v) ? Number(v) : NaN);
    const res = await promptDialog({
      title: "작업 타이머",
      label: "시간(분)",
      type: "number",
      icon: "Timer",
      confirm: "시작",
      value: String(last.minutes),
      extra: `<label class="field"><span>메모 (선택)</span><input name="note" maxlength="200" value="${esc(last.note)}" placeholder="예: reload cancel 입력" spellcheck="false" autocomplete="off"/></label>
        <p class="muted small">끝나기 1분 전과 끝날 때 소리와 알림으로 알려 줍니다. 명령은 보내지 않습니다. 탭을 닫거나 앱을 끄면 타이머도 사라집니다.</p>`,
      // Checked in the dialog: a wrong number keeps it open, note and all.
      validate: (v) => {
        const n = minutesOf(v);
        return n >= 1 && n <= 1440 ? null : "시간은 1~1440분 사이의 정수로 입력하세요";
      },
    });
    if (this.disposed) return;
    this.term.focus();
    if (!res) return;
    const minutes = minutesOf(res.value);
    const note = res.form.querySelector<HTMLInputElement>("[name=note]")!.value.trim();
    this.timerLast = { minutes, note };
    this.stopTimer();
    // The OS notification needs the permission asked from a user action: this one.
    ensureNotifyPermission();
    const ms = minutes * 60_000;
    // Offered for a command just sent: the device counts from then, not from
    // this click (the dialog may have stood open a while). Edited, from now.
    const from = preset?.sent && minutes === preset.minutes ? preset.sent : { wall: Date.now(), mono: performance.now() };
    const left = Math.min(from.wall + ms - Date.now(), from.mono + ms - performance.now());
    const wake = (after: number) => window.setTimeout(() => this.timerTick(), Math.max(0, after));
    this.timer = {
      endWall: from.wall + ms,
      endMono: from.mono + ms,
      note,
      warned: left <= 60_000,
      ended: false,
      tick: window.setInterval(() => this.timerTick(), 1000),
      wakeups: [...(left > 60_000 ? [wake(left - 60_000)] : []), wake(left)],
    };
    this.ws.badgeChanged(this);
    toast(`작업 타이머를 시작했습니다 (${minutes}분)`, "success", 2000);
  }

  /** A command just entered here that a work timer is for ("reload in 10",
   * "commit confirmed"): offered, its time and the command that settles it
   * filled in, to start after a look; one that settles it ("reload cancel",
   * "commit") while a timer runs: stopping it offered. Only offered: the
   * dialog or the button is the user's to take. */
  private offerTimer(command: string) {
    const found = selfUndoing(command, this.device?.kind ?? this.osGuess);
    if (found) {
      const undo = { ...found, sent: { wall: Date.now(), mono: performance.now() } };
      const message = undo.note === "reload cancel" ? `${undo.minutes}분 뒤 장비를 다시 시작하도록 예약하는 명령입니다` : `${undo.minutes}분 안에 commit으로 확정하지 않으면 설정이 되돌아가는 명령입니다`;
      return void toast(message, "info", 12_000, { label: "작업 타이머…", run: () => void this.openTimer(undo) });
    }
    if (this.timer && !this.timer.ended && SETTLES.test(command.trim()))
      toast("확정하거나 취소하는 명령을 보냈습니다. 작업 타이머를 멈출까요?", "info", 12_000, {
        label: "타이머 멈추기",
        run: () => {
          this.stopTimer("작업 타이머를 멈췄습니다");
          this.term.focus();
        },
      });
  }

  /** Its clocks and wake-ups stopped (an ended timer keeps its mark). */
  private quietTimer() {
    if (!this.timer) return;
    clearInterval(this.timer.tick);
    this.timer.wakeups.forEach((w) => clearTimeout(w));
  }

  private stopTimer(message?: string) {
    if (!this.timer) return;
    this.quietTimer();
    this.timer = null;
    this.ws.badgeChanged(this);
    if (message) toast(message, "info", 1500);
  }

  /** This tab used (a key, a click): an ended timer's mark has been seen. */
  private timerSeen() {
    if (this.timer?.ended) this.stopTimer();
  }

  private timerTick() {
    const t = this.timer;
    if (!t || t.ended) return;
    // From the clocks, not from counting ticks: a wake-up can come a little
    // early or, after the PC slept, late.
    const left = this.timerLeft();
    if (left <= 250) {
      this.quietTimer();
      t.ended = true;
      this.ws.badgeChanged(this);
      return this.timerAlert("작업 타이머가 끝났습니다", t.note);
    }
    if (!t.warned && left <= 60_250) {
      t.warned = true;
      this.timerAlert("작업 타이머 1분 남음", t.note);
    }
    this.ws.badgeChanged(this);
  }

  /** The warning and the end: a sound and the taskbar button flashing, and
   * the message in the app when it is in front and unlocked, else as a
   * Windows notification that brings this tab back (a long message in the
   * app when Windows notifications are not allowed). */
  private timerAlert(title: string, note: string) {
    const name = this.ws.nameOf(this);
    const body = note ? `${name}: ${note}` : name;
    beep();
    requestAttention();
    if ((!document.hasFocus() || isScreenLocked()) && canOsNotify()) osNotify(tr(title), body, () => this.ws.focusView(this));
    else toast(`${title}: ${userText(body)}`, "warn", 30_000);
  }

  badge(): { text: string; alert: boolean; title: string } | null {
    const t = this.timer;
    if (!t) return null;
    if (t.ended) return { text: "0:00", alert: true, title: t.note ? `작업 타이머가 끝났습니다: ${userText(t.note)}` : "작업 타이머가 끝났습니다" };
    const left = Math.max(0, this.timerLeft());
    return { text: timerClock(left), alert: left <= 60_000, title: t.note ? `작업 타이머: ${userText(t.note)}` : "작업 타이머" };
  }

  closeWarning(): string | null {
    return this.timer && !this.timer.ended ? `작업 타이머가 ${timerClock(this.timerLeft())} 남아 있습니다` : null;
  }

  /** Start or stop the repeat, in the snippet and right-click menus. */
  private repeatMenuItem(): MenuItem {
    return this.repeat
      ? { label: "반복 실행 멈추기", icon: "CircleStop", hint: keyHint("term.repeat"), action: () => this.stopRepeat("반복 실행을 멈췄습니다") }
      : { label: "명령 반복 실행…", icon: "Repeat", hint: keyHint("term.repeat"), disabled: this.state !== "connected", action: () => void this.toggleRepeat() };
  }

  /** term.repeat: ask for the command and timing and start, or stop. */
  private async toggleRepeat() {
    if (this.repeat) return this.stopRepeat("반복 실행을 멈췄습니다");
    if (this.state !== "connected") return void toast("연결된 다음 사용할 수 있습니다", "warn");
    // Never before the login has gone through: no run may meet a login prompt.
    if (!this.loggedIn) return void toast("로그인을 마친 다음 사용할 수 있습니다", "warn");
    // A paced paste still going out line by line: a run would land between its lines.
    if (this.pasteActive) return void toast("붙여넣기가 끝난 다음 시작할 수 있습니다", "warn");
    // The connection and prompt it is asked at: it starts only if both are
    // still there after the dialog (a reconnect meanwhile lands on a new screen).
    const asked = { rid: this.runtimeId, prompt: this.idlePrompt() };
    if (asked.prompt === null) return void toast("명령 프롬프트에서 아무것도 입력하지 않았을 때 시작할 수 있습니다", "warn", 5000);
    const last = this.repeatLast;
    const res = await promptDialog({
      title: "명령 반복 실행",
      label: "명령",
      icon: "Repeat",
      confirm: "시작",
      value: last.command,
      extra: `<div class="grid-2">
          <label class="field"><span>간격(초)</span><input name="every" type="number" min="1" max="3600" value="${last.every}"/></label>
          <label class="field"><span>횟수</span><input name="count" type="number" min="1" max="1000" value="${last.count}"/></label>
        </div>
        <p class="muted small">앞 결과가 끝나고 프롬프트가 돌아온 뒤에 보냅니다. 이 탭에 입력하거나, 연결이 끊기거나, 프롬프트가 1분 넘게 돌아오지 않으면 멈춥니다. 페이지 나눔(--More--)은 먼저 끄세요 (예: terminal length 0).</p>`,
    });
    if (!res) return;
    const command = res.value.trim();
    if (!command) return;
    if (/[\x00-\x1f\x7f]/.test(command)) return void toast("한 줄 명령만 반복할 수 있습니다", "warn");
    const hits = findRisks(`${command}\r`);
    if (hits.length) return void toast(`위험 명령 규칙에 걸리는 명령은 반복할 수 없습니다 (${hits[0].rule.note})`, "warn", 6000);
    const num = (name: string, min: number, max: number, fallback: number) =>
      Math.min(max, Math.max(min, Math.trunc(Number(res.form.querySelector<HTMLInputElement>(`[name=${name}]`)!.value)) || fallback));
    const every = num("every", 1, 3600, 5);
    const count = num("count", 1, 1000, 60);
    this.repeatLast = { command, every, count };
    // Things may have moved on while the dialog was open.
    const still = !this.repeat && this.state === "connected" && this.loggedIn && !this.pasteActive && this.runtimeId === asked.rid && this.idlePrompt() === asked.prompt;
    if (!still) return void toast("대화 상자를 연 사이에 화면이 바뀌어 시작하지 않았습니다", "warn", 5000);
    this.repeat = { rid: asked.rid, command, prompt: asked.prompt, everyMs: every * 1000, total: count, sent: 0, timer: 0, marker: null, dueAt: Date.now(), waiting: false };
    this.repeatTick();
    this.term.focus();
  }

  /** Send the next run when the prompt is back, or look again shortly. */
  private repeatTick() {
    const r = this.repeat;
    if (!r || this.disposed) return;
    clearTimeout(r.timer);
    if (this.state !== "connected" || this.runtimeId !== r.rid || !this.loggedIn) return this.stopRepeat("연결이 끊어져 반복 실행을 멈췄습니다", "warn");
    const buf = this.term.buffer.active;
    const row = buf.baseY + buf.cursorY;
    // Judged only once output pauses (a line of output can end in "#" or ">"),
    // and not while a paced paste is going out.
    if (Date.now() - this.lastRx >= 300 && buf.type === "normal" && !this.pasteActive) {
      const before = (buf.getLine(row)?.translateToString(true, 0, buf.cursorX) ?? "").trimEnd();
      if (CREDENTIAL_PROMPT.test(before) || LOGIN_END.test(before)) return this.stopRepeat("로그인·비밀번호를 묻는 줄이 나타나 반복 실행을 멈췄습니다", "warn");
      if (PAGER_PROMPT.test(before)) return this.stopRepeat("페이지 나눔(--More--)이 나타나 반복 실행을 멈췄습니다. 끈 다음 다시 시작하세요 (예: terminal length 0)", "warn");
      const prompt = this.idlePrompt();
      // Below the last run's line (a disposed marker scrolled out: long past it).
      if (prompt !== null && (!r.marker || r.marker.isDisposed || row > r.marker.line)) {
        // The same prompt, or the same device's ("router#" → "router(config)#");
        // another host's (the run logged out or jumped) ends the repeat.
        if (prompt !== r.prompt && !(promptHead(r.prompt) && promptHead(prompt) === promptHead(r.prompt))) return this.stopRepeat("프롬프트가 바뀌어 반복 실행을 멈췄습니다", "warn");
        if (Date.now() >= r.dueAt) return this.repeatRun(r);
      }
    }
    if (Date.now() >= r.dueAt + 60_000) return this.stopRepeat("프롬프트가 1분 넘게 돌아오지 않아 반복 실행을 멈췄습니다", "warn");
    const waiting = Date.now() >= r.dueAt;
    if (waiting !== r.waiting) {
      r.waiting = waiting;
      this.renderRepeat();
    }
    r.timer = window.setTimeout(() => this.repeatTick(), waiting ? 300 : Math.min(500, Math.max(50, r.dueAt - Date.now())));
  }

  private repeatRun(r: RepeatState) {
    r.marker?.dispose();
    r.marker = this.term.registerMarker(0) ?? null;
    this.enterSent(r.command);
    this.sendInput(`${r.command}\r`);
    r.sent++;
    r.waiting = false;
    if (r.sent >= r.total) return this.stopRepeat(tr(`반복 실행을 마쳤습니다 (${r.sent}회)`), "success");
    r.dueAt = Date.now() + r.everyMs;
    this.renderRepeat();
    r.timer = window.setTimeout(() => this.repeatTick(), Math.min(500, r.everyMs));
  }

  /** End the repeat; `message` says why (none when the tab is closing). */
  private stopRepeat(message?: string, kind: "info" | "warn" | "success" = "info") {
    const r = this.repeat;
    if (!r) return;
    this.repeat = null;
    clearTimeout(r.timer);
    r.marker?.dispose();
    this.renderRepeat();
    if (message) toast(message, kind, 5000);
    // "작업 완료" on: the repeat as a whole is the task (its runs were not told one by one).
    if (this.notifyDone && !this.disposed && !(this.isOnScreen() && document.hasFocus())) osNotify(tr("작업 완료"), `${this.ws.nameOf(this)}\n${r.command}`, () => this.ws.focusView(this));
  }

  /** Input from the user or for them (keys, paste, snippet, AI) takes the line: the repeat stops. */
  private interruptRepeat() {
    if (this.repeat) this.stopRepeat("입력이 있어 반복 실행을 멈췄습니다");
  }

  /** Runs sent, the command and a stop button over the terminal while a repeat runs. */
  private renderRepeat() {
    const r = this.repeat;
    let box = this.el.querySelector<HTMLElement>(".repeat-progress");
    if (!r) return void box?.remove();
    if (!box) {
      box = h("div", { class: "repeat-progress", role: "status" });
      box.innerHTML = `<div class="pp-row">${icon("Repeat", 13)}<span>반복 실행</span><b data-rp-count></b><span class="muted" data-rp-state></span>
          <button type="button" class="btn sm" data-rp-stop>${icon("CircleStop", 13)}<span>중지</span></button></div>
        <div class="rp-command mono" data-i18n-skip></div>
        <div class="pp-bar"><i></i></div>`;
      box.querySelector("[data-rp-stop]")!.addEventListener("click", () => {
        this.stopRepeat("반복 실행을 멈췄습니다");
        this.term.focus();
      });
      this.host.parentElement!.appendChild(box);
    }
    box.querySelector<HTMLElement>("[data-rp-count]")!.textContent = `${r.sent} / ${r.total}`;
    box.querySelector<HTMLElement>("[data-rp-state]")!.textContent = r.waiting ? tr("프롬프트를 기다리는 중") : tr(`${r.everyMs / 1000}초마다`);
    const command = box.querySelector<HTMLElement>(".rp-command")!;
    command.textContent = r.command;
    command.title = r.command;
    box.querySelector<HTMLElement>(".pp-bar i")!.style.width = `${(100 * r.sent) / r.total}%`;
  }

  /** Start recording typed input as a macro, or stop and save it. */
  private async toggleRecording() {
    const btn = this.el.querySelector<HTMLElement>('[data-act="record"]')!;
    if (!this.recording) {
      this.recording = [];
      btn.classList.add("recording");
      btn.innerHTML = `${icon("CircleStop", 15)}<span>기록 끝</span>`;
      toast("매크로 기록을 시작했습니다. 입력한 키가 그대로 저장되므로 비밀번호는 입력하지 마세요.", "warn", 5000);
      this.term.focus();
      return;
    }
    const keys = this.recording.join("");
    this.recording = null;
    btn.classList.remove("recording");
    btn.innerHTML = `${icon("Circle", 15)}<span>기록</span>`;
    if (!keys) return toast("기록된 입력이 없습니다", "info");
    const res = await promptDialog({ title: "매크로 저장", label: "매크로 이름", icon: "Circle", confirm: "저장", value: `매크로 ${state.snippets.filter((s) => s.macro).length + 1}` });
    if (!res?.value.trim()) return toast("매크로를 저장하지 않았습니다", "info");
    addMacro(res.value.trim(), keys);
    toast(`매크로 "${userText(res.value.trim())}"를 저장했습니다. 스니펫 메뉴에서 다른 터미널에 재생할 수 있습니다.`, "success", 5000);
  }

  /** The host's padding should match the terminal theme's background. */
  private applyThemeBackground() {
    this.host.style.background = termTheme(state.settings.terminalTheme).background ?? "";
  }

  /** Apply changed settings only: an unrelated change (a "don't ask again"
   * box) must not re-render every terminal or undo this tab's zoom. */
  applySettings() {
    this.aiPanel?.refreshProviders();
    // The find key may have changed in the shortcut settings. Compared with the
    // last text set, not the attribute: on screen it holds the translation.
    const findTitle = withKey("터미널에서 찾기", "term.find");
    if (findTitle !== this.findTitle) {
      this.findTitle = findTitle;
      this.el.querySelector<HTMLElement>('[data-act="find"]')?.setAttribute("title", findTitle);
    }
    const s = state.settings;
    const o = this.term.options;
    if (o.fontFamily !== s.fontFamily) o.fontFamily = s.fontFamily;
    if (this.zoomed === null && o.fontSize !== s.fontSize) o.fontSize = s.fontSize;
    if (o.cursorStyle !== s.cursorStyle) o.cursorStyle = s.cursorStyle;
    if (o.scrollback !== s.scrollback) o.scrollback = s.scrollback;
    if (this.theme !== s.terminalTheme) {
      this.theme = s.terminalTheme;
      o.theme = termTheme(s.terminalTheme);
      this.applyThemeBackground();
    }
    if (this.renderer !== s.renderer) {
      this.renderer = s.renderer;
      this.updateRenderer();
    }
    this.layout();
  }
  private theme = state.settings.terminalTheme;
  private renderer = state.settings.renderer;

  // ---- connection ------------------------------------------------------------

  private async connect() {
    this.setState("connecting");
    this.gotOutput = false;
    // A fresh connection: it is not being closed on purpose, and its startup
    // commands have not run yet.
    this.closing = false;
    this.startupSent = false;
    this.triggerBuf = "";
    this.tailAnswered.clear();
    clearTimeout(this.tailTimer);
    this.lastLine = "";
    this.runningCommand = null;
    // A new session on the device: its pager is on again.
    this.pagerSeen = this.pagerOffered = false;
    clearTimeout(this.commandEndTimer);
    // A new TextDecoder so a partial multibyte character left over from a dropped
    // connection does not corrupt the first trigger line of this one.
    this.decoder = new TextDecoder();
    // A new login, not established until it has gone through (watchLogin). A
    // Telnet login runs inside the connection ("Username:", "Password:"), so it
    // is read from the output the same way, and so is a serial console's.
    this.loginText = "";
    this.captureLogin = this.session.protocol === "ssh" || this.session.protocol === "telnet" || this.session.protocol === "serial";
    this.loginDecoder = new TextDecoder();
    this.loginSeen = 0;
    clearTimeout(this.loginTimer);
    this.loginAsked = false;
    this.loggedIn = false;
    this.loggedInAt = 0;
    this.endedAs = null;
    this.keyWarned = false;
    this.endBytes = new Uint8Array(0);
    // Reuse the OS detected on an earlier connection (no re-sniff, no re-detect).
    this.osGuess = String(this.session.options.osKind ?? "") || undefined;
    this.osSniff = "";
    // A new connection starts on the normal screen with default colours.
    this.highlighter = new KeywordHighlighter();
    // Keys typed into the old connection are not on the new one's line.
    this.keyLine = "";
    this.overlay.hidden = true;
    this.layout();
    this.runtimeId = crypto.randomUUID();
    // Acknowledgements and early input of the previous connection are void.
    clearTimeout(this.ackTimer);
    this.ackTimer = 0;
    this.acked = 0;
    this.early = [];
    const p = this.session.protocol as "ssh" | "telnet" | "serial";
    // Text written into the terminal is not translated on screen; tr() does it here.
    this.writeNote(`\x1b[90m${tr(`${PROTOCOLS[p].label} ${endpoint(this.session)}에 연결하는 중...`)}\x1b[0m\r\n`);
    const rid = this.runtimeId;
    try {
      // Telnet can go through an SSH gateway (SSH has its own jump host option).
      const tunnelPort = p === "telnet" ? await this.gateway.port() : undefined;
      if (this.disposed || rid !== this.runtimeId) return;
      if (tunnelPort === null) throw new Error("SSH 게이트웨이 연결을 취소했습니다.");
      await api.termOpen(
        {
        id: rid,
        protocol: p,
        host: tunnelPort ? "127.0.0.1" : this.session.host,
        port: tunnelPort ?? this.session.port,
        username: this.session.username,
        credentialId: this.session.credentialId,
        keepalive: keepaliveOf(this.session.options),
        jumpHost: String(this.session.options.jumpHost ?? ""),
        forwards: String(this.session.options.forwards ?? ""),
        compression: !!this.session.options.compression,
        agentForward: !!this.session.options.agentForward,
        rows: this.term.rows,
        cols: this.term.cols,
        serial: p === "serial" ? { ...serialSettings(this.session.options), io: state.settings.serialIo } : null,
        // Through a gateway tunnel the proxy is the gateway's business.
        proxy: tunnelPort ? null : proxyOf(this.session),
        },
        (bytes) => this.receive(rid, bytes),
        (code) => this.exited(rid, code),
      );
      // Closed or reconnected while connecting: this connection is orphaned.
      if (this.disposed || rid !== this.runtimeId) {
        api.termClose(rid).catch(() => {});
        return;
      }
      this.connectionOpened(rid);
      // termOpen used the size from before the tab was laid out, and a Telnet
      // session only exists once connected: report the real size now.
      api.termResize(rid, this.term.rows, this.term.cols).catch(() => {});
      this.sentSize = `${this.term.cols}x${this.term.rows}`;
      // The connection may already have ended (its exit can arrive first).
      // SSH counts as connected once it prints something; Telnet and serial
      // lines are open as soon as the connection is.
      if (p !== "ssh" && this.state === "connecting") this.setState("connected");
      const alive = this.state !== "closed" && this.state !== "error";
      if ((logConfig(this.session).auto || this.relog) && alive) {
        await this.setLogging(true);
        // Owed until a log is actually running again.
        if (this.logPath) this.relog = false;
      }
    } catch (err) {
      if (this.disposed || rid !== this.runtimeId) return;
      this.setState("error");
      this.writeNote(`\r\n\x1b[31m${tr(`연결 실패: ${errorText(err)}`)}\x1b[0m\r\n`);
      // A COM port that is not plugged in (yet): connect when it appears.
      if (/찾을 수 없습니다/.test(errorText(err)) && this.waitForPort(errorText(err))) return;
      this.showOverlay("연결하지 못했습니다", errorText(err));
    }
  }

  async reconnect(userInitiated = true) {
    // Suppress the dropped-connection auto-reconnect for the old connection and
    // clear any countdown. A reconnect the user asked for also starts the backoff
    // over and clears an earlier "stop reconnecting" choice; an automatic retry
    // must keep the backoff count so the wait grows while the server stays down.
    this.closing = true;
    this.stopAutoReconnect();
    if (userInitiated) {
      this.reDeclined = false;
      this.reAttempts = 0;
      // A connection the user starts begins no automatic chain of its own.
      this.reChain = false;
    }
    this.stopPortWait();
    this.portWaitDeclined = false;
    if (takeSavedSession(this.session)) this.ws.changed();
    this.stopPaste(true);
    this.stopMonitor();
    if (this.runtimeId) {
      // Wait for the old connection to let go (a COM port can be opened once).
      await api.termClose(this.runtimeId).catch(() => {});
    }
    // The log belonged to the old connection; it is reopened for the new one
    // (still owed if an earlier reconnect failed before it could).
    this.relog ||= !!this.logPath;
    this.logPath = null;
    setPressed(this.el.querySelector('.view-actions [data-act="log"]'), false);
    this.writeNote(`\r\n\x1b[90m──────── ${tr("다시 연결")} ────────\x1b[0m\r\n`);
    this.connect();
  }

  /** A note of the app's own (connecting, failed, closed) on the screen, timed as output is. */
  private writeNote(text: string) {
    const at = Date.now();
    this.term.write(text, () => this.stampOutput(at));
  }

  /** When the output's lines arrived (see LineTimes), numbered from the
   * output's start: `trimmed` lines have left the scrollback so far, told by
   * how far `timeProbe` (a marker) has moved up since it was looked at. The
   * probe sits on the scrollback's last row, which the screen's own edits
   * (insert or delete a line, scroll a region) never move: only lines
   * leaving the scrollback, its erasure (ED 3) and a reflow do. With no
   * scrollback yet it sits on the top row, which those edits can only push
   * down or delete: either is taken as lost, never as lines gone. */
  private lineTimes = new LineTimes();
  private timeProbe: IMarker | undefined;
  private probeLine = 0;
  private trimmed = 0;
  /** Output has been recorded since the terminal started (or was reset). */
  private timesStarted = false;

  /** The lines dropped from the scrollback so far; null when that is no
   * longer known (the screen was cleared or reset, more output than the
   * scrollback came at once and took the probe with it, it moved down, or
   * there is scrollback and no probe on it). */
  private trimmedLines(): number | null {
    const p = this.timeProbe;
    // No probe: lines leave the scrollback only once it is full.
    if (!p) {
      const buf = this.term.buffer.normal;
      const full = buf.length >= (this.term.options.scrollback ?? 1000) + this.term.rows;
      return this.timesStarted && full ? null : this.trimmed;
    }
    const moved = p.isDisposed ? -1 : this.probeLine - p.line;
    if (moved < 0) return null;
    this.trimmed += moved;
    this.probeLine = p.line;
    return this.trimmed;
  }

  /** The probe let go before xterm frees it (an erase), with the lines that
   * have left the scrollback by then: `trimmed`. Placed again at the next output. */
  private dropProbe(trimmed: number) {
    this.trimmed = trimmed;
    this.timeProbe?.dispose();
    this.timeProbe = undefined;
  }

  /** The probe on the scrollback's last row (the top row while there is no
   * scrollback); placed only while the normal screen is in use, as a marker
   * goes on the screen shown. `trimmedLines()` has counted up to now. */
  private placeProbe() {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return;
    const at = Math.max(0, buf.baseY - 1);
    if (this.timeProbe && !this.timeProbe.isDisposed && this.timeProbe.line === at) return;
    this.timeProbe?.dispose();
    this.timeProbe = this.term.registerMarker(at - (buf.baseY + buf.cursorY));
    this.probeLine = this.timeProbe?.line ?? at;
  }

  /** Output written at `at` has been drawn: the lines it reached on the
   * normal screen have arrived then (also when it went on to start vi or
   * less, whose own screen is gone when they end). */
  private stampOutput(at: number) {
    if (this.disposed) return;
    const buf = this.term.buffer.normal;
    const active = this.term.buffer.active.type === "normal";
    const row = buf.baseY + buf.cursorY;
    // The last line with anything on it: not the empty one after a line break.
    const end = buf.cursorX > 0 ? row : row - 1;
    // The last one drawn below the cursor (a status line, a progress bar, a
    // menu: the cursor moved back up after it), or -1.
    let below = -1;
    for (let y = buf.baseY + this.term.rows - 1; y > row; y--) {
      if (buf.getLine(y)?.translateToString(true)) {
        below = y;
        break;
      }
    }
    let trimmed = this.trimmedLines();
    if (trimmed === null) {
      // Lost: the lines still there came at times no longer known, which
      // are never shown as this output's.
      this.lineTimes.reset();
      this.lineTimes.skip(Math.max(end, below));
      this.trimmed = trimmed = 0;
      this.timeProbe?.dispose();
      this.timeProbe = undefined;
    }
    if (active) this.placeProbe();
    // A scroll region below the top row: lines move inside it with every
    // line break at its bottom and no sign of it here, so what is on the
    // screen has no known time until the region is let go.
    if (this.scrollRegion) this.lineTimes.unknown(trimmed + buf.baseY + this.scrollRegion, trimmed + buf.baseY + this.term.rows - 1);
    else {
      this.lineTimes.wrote(trimmed + end, at);
      // Rows from the cursor down to what is drawn below it: what lands there
      // later (lines pushed in above a progress bar) shows no time, never
      // this one's.
      if (below > end) this.lineTimes.unknown(trimmed + end + 1, trimmed + below);
    }
    this.lineTimes.forget(trimmed);
    this.timesStarted = true;
  }

  /** The top row (from 0) of a scroll region set below the screen's top
   * (CSI r), or 0 while there is none. */
  private scrollRegion = 0;

  /** Before the columns change: the line times by logical line (a wrapped
   * line is one), which the reflow keeps while it renumbers the rows. */
  private timesBeforeReflow(): { byLine: Map<number, number | null>; coveredLine: number; cursorLine: number } | null {
    const trimmed = this.trimmedLines();
    const snap = this.lineTimes.snapshot();
    if (trimmed === null || !snap.lines.length) return null;
    const { of, first, cursor } = this.logicalLines();
    if (!of.length) return null;
    const byLine = new Map<number, number | null>();
    for (let i = 0; i < snap.lines.length; i++) {
      const r = snap.lines[i] - trimmed;
      if (r >= of.length) continue;
      // An entry inside a wrapped line tells the lines after it.
      const k = r < 0 ? 0 : first[of[r]] === r ? of[r] : of[r] + 1;
      byLine.set(k, snap.times[i]);
    }
    const cr = snap.covered - trimmed;
    return { byLine, coveredLine: cr < 0 ? -1 : of[Math.min(cr, of.length - 1)], cursorLine: cursor };
  }

  /** After the columns changed: the line times put back on the rows their
   * lines are on now. The cursor's line is the same line before and after
   * (blank rows below it come and go), so lines the reflow pushed out of
   * the scrollback are counted off the top from it; anything else
   * unexpected leaves the lines without a time. */
  private timesAfterReflow(keep: NonNullable<ReturnType<TerminalView["timesBeforeReflow"]>>) {
    const { first, last, cursor } = this.logicalLines();
    const gone = keep.cursorLine - cursor;
    const probe = this.timeProbe;
    if (gone < 0 || probe?.isDisposed) return this.timesUnknown();
    const lines: number[] = [];
    const times: (number | null)[] = [];
    for (const k of [...keep.byLine.keys()].sort((a, b) => a - b)) {
      const line = Math.max(0, k - gone);
      if (line >= first.length) continue;
      const t = keep.byLine.get(k) ?? null;
      // Two now on the same line (lines gone off the top): the later tells it.
      if (lines.length && lines[lines.length - 1] === first[line]) times[times.length - 1] = t;
      else {
        lines.push(first[line]);
        times.push(t);
      }
    }
    const ck = keep.coveredLine - gone;
    this.lineTimes.restore(lines, times, ck < 0 ? -1 : last[Math.min(ck, last.length - 1)]);
    // Numbered from the rows as they are now; the probe moved with its line.
    this.trimmed = 0;
    if (probe) this.probeLine = probe.line;
    this.placeProbe();
  }

  /** The record no longer matches the rows (they were renumbered and could
   * not be followed): the lines there now show no time; later ones do. */
  private timesUnknown() {
    const buf = this.term.buffer.normal;
    const row = buf.baseY + buf.cursorY;
    this.lineTimes.reset();
    this.lineTimes.skip(buf.cursorX > 0 ? row : row - 1);
    this.trimmed = 0;
    this.timeProbe?.dispose();
    this.timeProbe = undefined;
    this.placeProbe();
  }

  /** The normal screen's logical lines: each row's line (a wrapped row
   * belongs to the line it continues) and each line's first and last row. */
  private logicalLines(): { of: Int32Array; first: number[]; last: number[]; cursor: number } {
    const buf = this.term.buffer.normal;
    const of = new Int32Array(buf.length);
    const first: number[] = [];
    const last: number[] = [];
    for (let y = 0; y < buf.length; y++) {
      if (!first.length || !buf.getLine(y)?.isWrapped) {
        first.push(y);
        last.push(y);
      } else last[last.length - 1] = y;
      of[y] = first.length - 1;
    }
    const row = Math.min(buf.baseY + buf.cursorY, buf.length - 1);
    return { of, first, last, cursor: row < 0 ? 0 : of[row] };
  }

  /** The screen and scrollback cleared but for the cursor's row (xterm's
   * clear, which frees every marker): that row, now the first, keeps when it came. */
  private clearScreen() {
    const buf = this.term.buffer.active;
    const normal = buf.type === "normal";
    // xterm leaves a screen with its cursor at the very top alone.
    const cleared = normal && !(buf.baseY === 0 && buf.cursorY === 0);
    const row = buf.baseY + buf.cursorY;
    const kept = normal ? this.lineTime(row) : null;
    const blank = !buf.getLine(row)?.translateToString(true).trim();
    this.term.clear();
    if (!cleared) return;
    this.timeProbe?.dispose();
    this.timeProbe = undefined;
    this.trimmed = 0;
    this.lineTimes.reset();
    // The row left: its time, or none when not known.
    if (kept !== null) this.lineTimes.wrote(0, kept);
    else if (!blank) this.lineTimes.skip(0);
    this.placeProbe();
  }

  /** The buffer row under the pointer at `clientY`, or null off the rows. */
  private rowAt(clientY: number): number | null {
    const screen = this.term.element?.querySelector(".xterm-screen");
    if (!screen) return null;
    const r = screen.getBoundingClientRect();
    if (!r.height) return null;
    const y = Math.floor(((clientY - r.top) / r.height) * this.term.rows);
    return y < 0 || y >= this.term.rows ? null : this.term.buffer.active.viewportY + y;
  }

  /** When the line at buffer `row` arrived (its first row, when it wraps), or
   * null: a blank row, vi's screen, or one from before the record. */
  private lineTime(row: number): number | null {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return null;
    while (row > 0 && buf.getLine(row)?.isWrapped) row--;
    if (!buf.getLine(row)?.translateToString(true).trim()) return null;
    const trimmed = this.trimmedLines();
    return trimmed === null ? null : this.lineTimes.at(trimmed + row);
  }

  /** Output of connection `rid`. Acknowledged once xterm has processed it, so
   * the backend pauses a flood instead of piling it up here. */
  receive(rid: string, bytes: Uint8Array) {
    if (rid !== this.runtimeId || this.disposed) return;
    const n = bytes.length;
    // The highlighter always follows the escape state (alternate screen,
    // program colours), so turning it on mid-session is right at once.
    this.lastRx = Date.now();
    this.checkDelEcho(bytes);
    // An ls listing being coloured (lsColors.ts) is left as the server sent it.
    const shown = this.highlighter.process(bytes, state.settings.highlightKeywords && !this.lsColors.listing);
    const at = Date.now();
    this.term.write(shown, () => {
      this.ack(rid, n);
      this.stampOutput(at);
    });
    this.sniffOs(bytes);
    this.watchLogin(bytes);
    this.onOutput(bytes);
    this.watchCommandEnd();
    if (!this.gotOutput) {
      this.gotOutput = true;
      if (this.state === "connecting") this.setState("connected");
    }
  }

  /** Operating systems that are not network gear (so the key mode and AI target
   * treat them as a general-purpose host). */
  private static UNIX_KINDS = ["linux", "aix", "hpux", "solaris", "windows"];

  /** The device the monitor recognised, or, failing that, an OS guessed from the
   * login banner — used for OS snippets, key mode and client-side history recall. */
  private effectiveDevice(): { kind: string; network: boolean } | undefined {
    if (this.device) return this.device;
    if (!this.osGuess) return undefined;
    return { kind: this.osGuess, network: !TerminalView.UNIX_KINDS.includes(this.osGuess) };
  }

  /** The resource monitor will detect this session's device (ssh/telnet, direct,
   * monitor on). When it will not — Serial, or a jump-host/gateway session, or
   * the monitor turned off — the banner sniff is the only OS source. */
  private monitorWillRun(): boolean {
    const p = this.session.protocol;
    return (p === "ssh" || p === "telnet") && state.settings.remoteMonitor && !this.session.options.jumpHost && !this.session.options.gateway;
  }

  /** Guess the device from the first output (login banner, prompt) when the
   * monitor has not recognised it — for Serial and network gear on a serial
   * console especially. Best-effort and cheap; when no monitor will run, the
   * guess is remembered on the session so later connections skip it. */
  private sniffOs(bytes: Uint8Array) {
    if (this.osGuess || this.device || this.osSniff.length > 8192) return;
    this.osSniff += this.sniffDecoder.decode(bytes, { stream: true });
    const t = this.osSniff;
    const kind = /HP-?UX|Hewlett-Packard/i.test(t)
      ? "hpux"
      : /\bAIX\b/.test(t)
        ? "aix"
        : /SunOS|Solaris/i.test(t)
          ? "solaris"
          : /NX-OS|Nexus/i.test(t)
            ? "cisco-nxos"
            : /Adaptive Security Appliance|ASA Version/i.test(t)
              ? "cisco-asa"
              : /Cisco IOS|IOS[ -]?XE|Cisco Systems|Cisco Internetwork/i.test(t)
                ? "cisco-ios"
                : /FortiGate|FortiOS|\bFGT\b/i.test(t)
                  ? "fortigate"
                  : /JUNOS|Juniper/i.test(t)
                    ? "juniper-junos"
                    : /Huawei|\bVRP\b/i.test(t)
                      ? "huawei-vrp"
                      : /ArubaOS|\bAruba\b/i.test(t)
                        ? "aruba-cx"
                        : /\bLinux\b/.test(t)
                          ? "linux"
                          : undefined;
    if (!kind) return;
    this.osGuess = kind;
    // No monitor will detect this one (Serial, gateway, or monitor off): the
    // sniff is the only source, so remember it for next time.
    if (!this.monitorWillRun()) this.cacheOs(kind);
  }

  /** Remember an OS guessed by the sniff on the session (kind only; the monitor,
   * when it runs, caches the fuller device in deviceDetected). */
  private cacheOs(kind: string) {
    if (this.session.id.startsWith("quick-") || this.session.options.osKind === kind) return;
    this.session.options.osKind = kind;
    patchSession(this.session.id, {}, { osKind: kind }).catch(() => {});
  }

  /** Follow an SSH connection's output: keep its last part for exited(), and
   * while the login is under way, read it for ssh.exe's questions and warnings.
   * The login has gone through once the server has spoken since the last
   * question and the output has settled (a banner can come just before a
   * password question). */
  private watchLogin(bytes: Uint8Array) {
    // Telnet keeps its last output too: its login runs inside the connection.
    if (this.session.protocol !== "ssh" && this.session.protocol !== "telnet" && this.session.protocol !== "serial") return;
    const keep = 4096;
    if (bytes.length >= keep) this.endBytes = bytes.slice(bytes.length - keep);
    else {
      const prev = this.endBytes.subarray(Math.max(0, this.endBytes.length + bytes.length - keep));
      const next = new Uint8Array(prev.length + bytes.length);
      next.set(prev);
      next.set(bytes, prev.length);
      this.endBytes = next;
    }
    if (!this.captureLogin) return;
    clearTimeout(this.loginTimer);
    // No login prints this much: the server is plainly talking.
    this.loginSeen += bytes.length;
    if (this.loginSeen > 256 * 1024) return this.loginComplete();
    this.loginText = (this.loginText + this.loginDecoder.decode(bytes, { stream: true })).slice(-8192);
    const lines = plainLines(this.loginText);
    if (!this.keyWarned) {
      const key = unusableKey(lines);
      if (key) {
        this.keyWarned = true;
        this.warnUnusableKey(key);
      }
    }
    if (asksAtEnd(lines)) this.loginAsked = true;
    // Telnet and a serial console log in inside the connection: through only
    // once the device's own command prompt shows (inBandLoginThrough).
    else if (loginThrough(lines) && (this.session.protocol === "ssh" || this.inBandLoginThrough(lines))) this.loginTimer = window.setTimeout(() => this.loginComplete(), 1500);
  }

  /** A Telnet or serial login (inside the connection) went through: the
   * device's own command prompt shows, with no failure in the last lines; a
   * login question ending in ">" ("Login ID>") is none, nor is a banner. */
  private inBandLoginThrough(lines: string[]): boolean {
    const shown = lines.filter((l) => l.trim());
    // A failure anywhere in the last lines ("Login incorrect" and a note after it).
    if (shown.slice(-4).some((l) => loginFailure([l]))) return false;
    const last = (shown[shown.length - 1] ?? "").trim();
    return DEVICE_PROMPT.test(last) && !asksLogin(last);
  }

  /** ssh.exe could not use the session's key file and went on to other ways of
   * logging in, usually a password: say so before a password the user may not
   * know is guessed at, since a few wrong ones can get the account or address
   * blocked. */
  private warnUnusableKey(key: { path: string; why: "missing" | "format" | "permissions" }) {
    const why = { missing: "키 파일이 없습니다", format: "OpenSSH 형식이 아닙니다", permissions: "다른 사용자도 읽을 수 있는 파일입니다" }[key.why];
    // A key others can read is fixed in place: once it is, connect again with it.
    const fix =
      key.why === "permissions"
        ? {
            label: "키 파일 권한 고치기",
            run: async () => {
              if ((await (await import("../vault")).protectKeyFile(key.path)) && !this.disposed) this.reconnect();
            },
          }
        : undefined;
    toast(`키 파일을 쓰지 못했습니다 (${why}): ${userText(key.path)}. 비밀번호를 물어도 모르면 입력하지 마세요. 틀린 비밀번호를 여러 번 넣으면 서버가 접속을 차단할 수 있습니다.`, "warn", fix ? 30000 : 15000, fix);
  }

  /** The login went through (watchLogin). Only now is the connection
   * established: what needs a logged-in
   * session starts, and a later drop may auto-reconnect. */
  private loginComplete() {
    clearTimeout(this.loginTimer);
    this.captureLogin = false;
    if (this.loggedIn || this.disposed || this.state !== "connected") return;
    this.loggedIn = true;
    this.loggedInAt = Date.now();
    // Broadcast now reaches it from logged-in tabs (the tab bar shows which).
    this.ws.changed();
    // A question already waiting (after the login) was left for now (answerTail).
    queueMicrotask(() => !this.disposed && this.answerTail(state.settings.triggers ?? []));
    this.startMonitor({}, true);
    this.runStartupCommands();
    // The SFTP browser opens next to a new SSH session (Settings).
    if (!this.filesOpened && this.session.protocol === "ssh" && state.settings.sftpWithSsh) {
      this.filesOpened = true;
      // The file backend connects directly, so a jump-host/gateway session's
      // SFTP cannot tunnel: say so instead of opening a window that just fails.
      if (fileTransferBlockedReason(this.session)) toast("점프 호스트·게이트웨이를 쓰는 세션은 SFTP 창을 자동으로 열지 않습니다", "info");
      else queueMicrotask(() => !this.disposed && this.openFiles(this.session, this));
    }
  }

  /** The overlay for a login that failed (wrong credentials or a changed host
   * key): a manual "reconnect" only, never the automatic countdown, so a wrong
   * password or key is not sent to the server over and over. */
  private showLoginFailure(why: "auth" | "hostkey") {
    this.stopAutoReconnect();
    if (why === "hostkey") {
      this.showOverlay("호스트 키가 바뀌었습니다", "서버의 호스트 키가 알려진 것과 다릅니다. 서버가 교체된 것인지 확인한 뒤 다시 연결하세요. 잘못된 서버일 수 있어 자동으로 다시 연결하지 않습니다.");
      // A reinstalled server: forget the old key; the reconnect then shows the
      // new fingerprint for approval in the terminal.
      const row = this.overlay.querySelector(".overlay-card .row");
      const forget = h("button", { class: "btn" });
      forget.innerHTML = `${icon("ShieldAlert", 15)}저장된 키 지우기`;
      forget.addEventListener("click", async () => {
        if ((await forgetHostKey(this.session.host, this.session.port || 22, this.session.username)) && !this.disposed) this.reconnect();
      });
      row?.insertBefore(forget, row.lastElementChild);
      return;
    }
    const detail = this.session.credentialId
      ? "사용자 이름과 비밀번호 또는 키가 맞는지 확인하세요. 틀린 로그인 정보로 계속 다시 연결하면 서버가 접속을 차단할 수 있어 자동 재연결을 멈췄습니다."
      : "이 세션에는 저장된 로그인 정보가 없습니다. 자격 증명 보관함에서 비밀번호나 키를 지정하면 다음부터 묻지 않습니다. 틀린 로그인 정보로 계속 다시 연결하면 서버가 접속을 차단할 수 있어 자동 재연결을 멈췄습니다.";
    this.showOverlay("로그인하지 못했습니다", detail);
    // The session's key file the login could not use (missing, another format,
    // readable by others): said on the card, as the likely cause.
    const card = this.overlay.querySelector<HTMLElement>(".overlay-card");
    const cred = state.credentials.find((c) => c.id === this.session.credentialId);
    import("../vault")
      .then((v) => v.credentialIssue(cred))
      .then((issue) => {
        if (!issue || !card?.isConnected) return;
        const line = h("p", { class: "key-issue" });
        // Two texts of their own, so the screen translation follows a language change.
        line.innerHTML = `${icon("TriangleAlert", 12)}<span>이 세션의 키 파일:</span> <span>${esc(issue)}</span>`;
        card.querySelector(".row")?.before(line);
      })
      .catch(() => {});
    // A saved session's login is fixed in its editor; "save and connect"
    // reconnects this tab with what was saved.
    if (!state.sessions.some((s) => s.id === this.session.id)) return;
    const row = this.overlay.querySelector(".overlay-card .row");
    const edit = h("button", { class: "btn" });
    edit.innerHTML = `${icon("Pencil", 15)}세션 편집`;
    edit.addEventListener("click", async () => {
      const saved = state.sessions.find((s) => s.id === this.session.id);
      if (!saved) return;
      const res = await (await import("../sessionEditor")).editSession(saved);
      if (res?.connect && !this.disposed) this.reconnect();
    });
    row?.insertBefore(edit, row.lastElementChild);
  }

  private decoder = new TextDecoder();
  /** Trigger patterns compiled once and cached by source, so a busy stream does
   *  not rebuild the same regex for every output line. null = malformed pattern. */
  private triggerRe = new Map<string, RegExp | null>();
  /** When each "send" trigger last auto-sent, to rate-limit it and stop a rule
   *  that matches its own echo from looping. Keyed by pattern. */
  private sendTriggerAt = new Map<string, number>();
  /** "send" rules that matched a login prompt and were not sent (fireTrigger):
   *  the user is told once per rule in this tab. */
  private credentialRuleWarned = new Set<string>();
  /** React to server output: arm the "done" notification, and match trigger
   * rules line by line. Only decodes when one of those is actually in use. */
  private onOutput(bytes: Uint8Array) {
    if (this.notifyDone) this.armNotify();
    const rules = state.settings.triggers;
    if (!this.notifyDone && !(rules && rules.length)) return;
    const text = this.decoder.decode(bytes, { stream: true });
    if (rules && rules.length) this.matchTriggers(text, rules);
  }

  /** Output arrived: restart the silence timer. When it has been quiet for a
   * few seconds after output — the command finished — notify, but only when
   * this tab is not the one on screen (no alert for what you are watching). */
  private armNotify() {
    this.notifySaw = true;
    clearTimeout(this.notifyTimer);
    // A command whose prompt is known is told when the prompt comes back
    // (commandDone): a pause in its output (a TFTP copy between files) is
    // not its end. The silence still tells after a while, should the prompt
    // never be recognised (another host's, reached from this one).
    const quiet = this.runningCommand && !this.runningCommand.marker.isDisposed ? 30_000 : 4000;
    this.notifyTimer = window.setTimeout(() => {
      if (!this.notifyDone || !this.notifySaw || this.disposed || this.repeat) return;
      this.notifySaw = false;
      if (this.isOnScreen() && document.hasFocus()) return; // you are watching it
      osNotify(tr("작업 완료"), this.ws.nameOf(this), () => this.ws.focusView(this));
    }, quiet);
  }

  /** This tab is shown in a visible slot right now. */
  private isOnScreen(): boolean {
    return this.ws.visibleTabs().some((t) => t.view === (this as View));
  }

  /** Match each enabled trigger rule against new output, line by line. The tail
   * after the last newline is kept for the next chunk so a rule can match a line
   * split across reads. */
  private matchTriggers(text: string, rules: TriggerRule[]) {
    this.triggerBuf += text.replace(/\r/g, "");
    const parts = this.triggerBuf.split("\n");
    this.triggerBuf = parts.pop() ?? "";
    // Keep the running tail bounded (a program printing no newlines).
    if (this.triggerBuf.length > 4096) this.triggerBuf = this.triggerBuf.slice(-4096);
    // The first completed line is the one that was unfinished before: "send"
    // rules that answered it there are done with it.
    const answered = this.tailAnswered;
    if (parts.length) this.tailAnswered = new Set();
    // Rules match (and alerts show) the text as on screen: no colour codes, and
    // a cursor move to a row (the Windows pseudo-console) starts a new line.
    // Each rule acts at most once per line of output (a repaint packing many
    // rows into one line must not raise a toast per row).
    parts.forEach((raw, i) => {
      const fired = new Set<string>();
      for (const line of plainLines(raw)) {
        if (!line) continue;
        const context = `${this.lastLine}\n${line}`;
        this.lastLine = line;
        for (const rule of rules) {
          if (!rule.enabled || !rule.pattern || fired.has(rule.pattern)) continue;
          if (i === 0 && rule.action === "send" && answered.has(rule.pattern)) continue;
          const re = this.ruleRe(rule.pattern);
          if (!re || !re.test(line)) continue;
          fired.add(rule.pattern);
          this.fireTrigger(rule, line, context);
        }
      }
    });
    // The unfinished last line is looked at once output pauses (below).
    clearTimeout(this.tailTimer);
    if (this.triggerBuf) this.tailTimer = window.setTimeout(() => !this.disposed && this.answerTail(state.settings.triggers ?? []), 250);
  }

  /** A trigger pattern, compiled once; null for a malformed one (never matches). */
  private ruleRe(pattern: string): RegExp | null {
    let re = this.triggerRe.get(pattern);
    if (re === undefined) {
      try {
        re = new RegExp(pattern);
      } catch {
        re = null;
      }
      this.triggerRe.set(pattern, re);
    }
    return re;
  }

  /** "send" rules also answer the unfinished last line: a question waiting at
   * the cursor ("Continue? (y/n) ", "--More--") has no line break until it is
   * answered. Looked at once output has paused (a prompt split across reads is
   * whole by then), only after the login (never ssh's host-key question or a
   * login prompt), and once per line: the line completing later does not
   * answer again. Rate-limited (it sent under a second ago): dropped, which is
   * what stops a rule that matches its own echo or a re-asked question. */
  private answerTail(rules: TriggerRule[]) {
    clearTimeout(this.tailTimer);
    if (!this.loggedIn) return; // loginComplete() looks again
    const rows = plainLines(this.triggerBuf);
    const tail = rows[rows.length - 1] ?? "";
    if (!tail.trim()) return;
    // What the credential check reads: the unfinished output and the line before
    // it, so "Enter your one-time code" above a bare "> " still counts.
    const context = [this.lastLine, ...rows].join("\n");
    for (const rule of rules) {
      if (!rule.enabled || !rule.pattern || rule.action !== "send" || this.tailAnswered.has(rule.pattern)) continue;
      const re = this.ruleRe(rule.pattern);
      if (!re || !re.test(tail)) continue;
      this.tailAnswered.add(rule.pattern);
      this.fireTrigger(rule, tail, context);
    }
  }

  /** Run a rule's action for a matching line; `context`: the text around it
   * that the credential check reads. */
  private fireTrigger(rule: TriggerRule, line: string, context = line) {
    if (rule.action === "alert") toast(`${userText(this.ws.nameOf(this))}: ${userText(line.trim().slice(0, 200))}`, "warn", 6000);
    else if (rule.action === "beep") beep();
    // Sends only once logged in: before that the output is the login itself
    // (ssh's host-key question, login prompts), which no rule may answer.
    else if (rule.action === "send" && rule.value && this.state === "connected" && this.loggedIn) {
      // A send writes to the terminal; its echo and the server's reply can match
      // the same rule again, so an unguarded "send" rule can loop and flood the
      // server. Let one rule auto-send at most once a second to break the loop.
      const now = Date.now();
      if (now - (this.sendTriggerAt.get(rule.pattern) ?? 0) < 1000) return;
      // Never to a login, password or host-key question: every prompt line is
      // answered once, so a refused value would go again to each new prompt
      // (repeated failed logins that lock accounts), a late match (the prompt
      // line completed by the user's own answer) would put the secret in the
      // shell, and a host key must be the user's own decision. Saved
      // credentials are typed once per connection by the backend instead.
      if (CREDENTIAL_PROMPT.test(context) || CREDENTIAL_PROMPT.test(line) || LOGIN_WORD.test(line)) {
        if (!this.credentialRuleWarned.has(rule.pattern)) {
          this.credentialRuleWarned.add(rule.pattern);
          toast("로그인·비밀번호·호스트 키를 묻는 줄에는 트리거의 자동 응답을 보내지 않습니다. 로그인 정보는 세션 편집의 사용자 이름과 자격 증명에 저장하세요", "warn", 8000);
        }
        return;
      }
      this.sendTriggerAt.set(rule.pattern, now);
      this.sendInput(rule.value.replace(/\\n/g, "\r").replace(/\\t/g, "\t"));
    }
  }

  /** A MAC address clicked in the output: copy it in another vendor's notation,
   * or find it on screen in any of them. */
  private macMenu(hex: string, x: number, y: number) {
    // Its IPv4 address, as an ARP table in this tab or another one gives it
    // (a router's, beside a switch's MAC table): each opens that address's menu.
    const ips = this.ipsOfMac(hex);
    // What the address itself says it is (an HSRP group, STP, multicast), when anything.
    const kind = macKind(hex);
    contextMenu(x, y, [
      ...(kind ? [{ label: kind, icon: "Info", heading: true }, "-" as const] : []),
      ...macFormats(hex).map((f) => ({ label: f.text, icon: "Copy", hint: f.style, action: () => void writeClipboard(f.text) })),
      "-" as const,
      ...ips.map((m) => ({ label: m.value, userLabel: true, icon: "Network", hint: m.tab, userHint: true, action: () => this.addressMenu(m.value, null, null, x, y) })),
      ...(ips.length ? ["-" as const] : []),
      { label: "이 MAC을 모든 형식으로 찾기", icon: "Search", action: () => this.findInTerminal(macSearchPattern(hex), true) },
      // Which switch's output holds it (a MAC table, an ARP table on each).
      ...(this.otherTerminals().length
        ? [{ label: "모든 터미널 탭에서 찾기", icon: "ListFilter", action: () => this.matchList(macSearchPattern(hex), { regex: true, caseSensitive: false }, true) }]
        : []),
    ]);
  }

  /** A server path clicked in the output ("cat: /var/log/x: …", grep's
   * "/etc/x.conf:12:"): opened over SFTP beside this terminal (a file in
   * the editor, a folder in the file tab), or copied. */
  private pathMenu(path: string, line: number | undefined, x: number, y: number) {
    // A system configuration known by its path alone (sshd_config, sudoers,
    // nginx, a unit file…), not by a "#!" line this menu cannot see: its
    // check run in this shell, the one that printed the path.
    const check = syntaxCheckFor(path.slice(path.lastIndexOf("/") + 1), path, "");
    const unit = statusUnitOf(path);
    const archive = archiveCommands(path, this.device?.kind);
    contextMenu(x, y, [
      // With grep's line number: the file opens at that line.
      { label: line ? `${path}:${line}` : path, userLabel: true, icon: "File", heading: true },
      // On this session's server: after an ssh or su inside the shell, the
      // path printed may be another machine's, so the server is named.
      { label: "파일 탭에서 열기", icon: "FolderLock", hint: this.session.host, userHint: true, action: () => this.openServerPath(path, line) },
      // The same transfer as dragging it to the PC side of that file tab (its
      // open folder; asks before overwriting).
      { label: "내 PC로 받기", icon: "Download", hint: this.session.host, userHint: true, action: () => this.openServerPath(path, undefined, true) },
      { label: "경로 복사", icon: "Copy", action: () => void writeClipboard(path) },
      // Into the command being written, quoted, where the cursor is.
      { label: "명령 줄에 경로 넣기", icon: "SquareTerminal", action: () => this.typePaths([path]) },
      // A log named in the output, followed from here: put on the idle
      // input line, not run (Enter is the user's; Ctrl+C ends it). "-f" as
      // every Unix tail has it; "--" so no name is read as an option.
      // Text under it (a folder's files, or the file itself), searched in this shell.
      ...(grepUnsupported(this.device?.kind) ? [] : [{ label: "내용 찾기 (grep)…", icon: "FileSearch", action: () => void this.grepUnder(path) }]),
      ...(LOG_PATH.test(path) ? [{ label: "tail -f로 따라 보기", icon: "ScrollText", action: () => void this.offerCheck("tail -f -- {}", path, false) }] : []),
      // An archive (archiveCommands, as the file tab offers it): its listing,
      // or its unpacking into its own folder, on this shell's input line.
      ...(archive && !QUOTE_UNSAFE(path)
        ? [
            { label: "압축 파일 내용 보기", icon: "FileSearch", hint: archive.tool, action: () => void this.offerCheck(archive.list, path, false) },
            {
              label: "같은 폴더에 압축 풀기",
              icon: "FolderOpen",
              hint: archive.tool,
              action: () => {
                if (this.offerCheck(archive.extract, path, false))
                  toast(
                    archive.tool === "tar"
                      ? "터미널에 압축 풀기 명령을 넣었습니다. Enter를 누르면 같은 폴더에 풉니다 (이미 있는 파일은 바꾸지 않습니다)"
                      : "터미널에 압축 풀기 명령을 넣었습니다. Enter를 누르면 같은 폴더에 풉니다 (이미 있는 파일은 바꿀지 묻습니다)",
                    "info",
                    8000,
                  );
              },
            },
          ]
        : []),
      // sudo left out at a root shell's "#" prompt (one may have no sudo).
      // Not offered when the path would be refused (see offerCheck).
      ...(check?.system && !(check.command.includes("{}") && QUOTE_UNSAFE(path))
        ? [{ label: "문법 검사 넣기", icon: "ShieldCheck", hint: check.command.replace("{}", path.slice(path.lastIndexOf("/") + 1)), userHint: true, action: () => void this.offerCheck(check.command, path, check.sudo && !/#$/.test(this.idlePrompt()?.trimEnd() ?? "")) }]
        : []),
      // A unit file (or a unit's drop-in): its unit's state and latest log
      // lines, read only (systemctl(1) "status"; "--" as "-.mount" is a
      // unit's name; no pager so it stays in the output); statusUnitOf leaves
      // templates out. A user unit asks the shell's own user manager. Not a
      // name no quoting keeps whole ("\x2d" in a mount's), which would be refused.
      ...(unit && !QUOTE_UNSAFE(unit.name)
        ? [{ label: "systemctl status로 상태 보기", icon: "Activity", hint: unit.name, userHint: true, action: () => void this.offerCheck(`systemctl ${unit.user ? "--user " : ""}status --no-pager -- {}`, unit.name, false) }]
        : []),
    ]);
  }

  /** Text under a clicked server path (askGrep), put on this shell's input line. */
  private async grepUnder(path: string) {
    const command = await askGrep();
    if (command && this.offerCheck(command, path, false)) toast(GREP_PUT, "info", 8000);
  }

  /** The file tab beside this terminal (its SFTP browser) opens `path` (or,
   * with `download`, sends it to its PC-side folder); one is opened first
   * when there is none, and takes the path once connected. */
  private openServerPath(path: string, line?: number, download = false) {
    type Files = View & { terminal?: unknown; openPath?(p: string, line?: number, download?: boolean): void };
    const beside = () => this.ws.tabs.map((t) => t.view as Files).find((v) => v.terminal === this && typeof v.openPath === "function");
    const files = beside();
    if (files) {
      // A request still waiting for that tab to appear is older than this one.
      this.filesComing = null;
      return files.openPath!(path, line, download);
    }
    // A file tab already on its way (a second click before it appeared):
    // it takes this path instead, and no second tab (or login) is made.
    if (this.filesComing) {
      this.filesComing = Object.assign(this.filesComing, { path, line, download });
      return;
    }
    const blocked = fileTransferBlockedReason(this.session);
    if (blocked) return void toast(blocked, "error", 7000);
    const coming = (this.filesComing = { path, line, download });
    this.openFiles(this.session, this);
    // The file tab is made once its code has loaded: given the path then.
    let tries = 0;
    const handOver = () => {
      const f = !this.disposed && beside();
      if (f || this.disposed || ++tries >= 50) {
        // Handed over only if no later click reached the tab first (it
        // cleared this request), so the last click is the one done.
        const mine = this.filesComing === coming;
        if (mine) this.filesComing = null;
        if (f && mine) f.openPath!(coming.path, coming.line, coming.download);
        return;
      }
      window.setTimeout(handOver, 100);
    };
    window.setTimeout(handOver, 100);
  }

  /** A file tab opened for a clicked path, not yet made, and the path it takes. */
  private filesComing: { path: string; line?: number; download?: boolean } | null = null;

  /** An "ls -l" permission string clicked: what it allows whom, and its
   * number for chmod ("-rwsr-xr-x" is 4755). */
  private permMenu(perm: string, mode: number, x: number, y: number) {
    const rights = (shift: number) =>
      [
        [4, "읽기(r)"],
        [2, "쓰기(w)"],
        [1, "실행(x)"],
      ]
        .filter(([bit]) => (mode >> shift) & (bit as number))
        .map(([, word]) => tr(word as string))
        .join(" · ") || tr("권한 없음");
    const special = [
      // A folder's setuid and a file's sticky bit do nothing on Linux.
      [0o4000, perm[0] === "d" ? "setuid: 폴더에는 보통 효과 없음" : "setuid: 실행하면 파일 소유자의 권한으로 실행"],
      [0o2000, perm[0] === "d" ? "setgid: 안에 만든 파일이 이 폴더의 그룹을 가짐" : "setgid: 실행하면 파일 그룹의 권한으로 실행"],
      [0o1000, perm[0] === "d" ? "sticky: 파일 주인만 지우거나 이름을 바꿀 수 있음" : "sticky: 파일에는 보통 효과 없음"],
    ] as const;
    const number = octal(mode);
    contextMenu(x, y, [
      { label: perm, userLabel: true, icon: "Info", heading: true },
      { label: "소유자", icon: "User", hint: rights(6), userHint: true, disabled: true },
      { label: "그룹", icon: "Users", hint: rights(3), userHint: true, disabled: true },
      { label: "기타 사용자", icon: "Globe", hint: rights(0), userHint: true, disabled: true },
      ...special.filter(([bit]) => mode & bit).map(([, text]) => ({ label: text, icon: "TriangleAlert", disabled: true })),
      "-",
      { label: `${number} 복사`, icon: "Copy", hint: `chmod ${number}`, userHint: true, action: () => void writeClipboard(number) },
    ]);
  }

  /** Put a command on the input line, replacing what is typed there (Ctrl-U);
   * Enter is never pressed: the user reads it and runs it. */
  private putOnInputLine(command: string) {
    const typed = this.assist.typedText();
    const clear = !typed ? "" : this.windowsShell() ? "\x7f".repeat(typed.length) : LINE_CLEAR;
    const data = clear + command.replace(/[\r\n]+/g, " ");
    this.interruptRepeat();
    this.assist.note(data);
    this.sendInput(data);
  }

  /** The cursor is at a shell or device prompt after the login: not at a
   * login, password or host-key question, nor in a pager or a full-screen
   * program, where typed text would answer something else. */
  private atCommandLine(): boolean {
    if (this.disposed || this.state !== "connected" || !this.loggedIn || this.pasteActive) return false;
    // The same judgement typed keys and broadcasts get: a login, password,
    // host-key or confirm question, or a console about to start a login, is
    // not a command line (a device that timed out back to "Username:" while
    // the connection stayed up included).
    if (this.inputKind() !== "shell") return false;
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return false;
    const before = (buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true, 0, buf.cursorX) ?? "").trimEnd();
    if (!before || PAGER_PROMPT.test(before) || CREDENTIAL_PROMPT.test(before) || LOGIN_END.test(before) || USER_ANSWERED_ANGLE.test(before)) return false;
    // And a prompt it knows, or one by its shape ("R1#", "user@h:~$"), with
    // anything typed after it.
    const known = this.assist.knownPrompt().trimEnd();
    return (!!known && before.startsWith(known)) || PROMPT_END.test(before);
  }

  /** A data rate clicked in the output ("123456000 bits/sec"): read in
   * Mbit/s or Gbit/s, to copy either way. */
  private rateMenu(bitsPerSecond: number, row: number, x: number, y: number) {
    const readable = readableRate(bitsPerSecond);
    const raw = String(bitsPerSecond);
    // In "show interfaces", the share of the interface's bandwidth (its BW
    // line in the same block above). Not for the BW line itself.
    const buf = this.term.buffer.active;
    const here = buf.getLine(row)?.translateToString(true) ?? "";
    const bw = /\bBW \d/.test(here) ? null : bandwidthAbove((i) => buf.getLine(i)?.translateToString(true), row);
    const share = bw ? (bitsPerSecond / bw) * 100 : null;
    contextMenu(x, y, [
      ...(bw && share !== null
        ? [{ label: share > 0 && share < 0.01 ? `대역폭 ${readableRate(bw)}의 0.01% 미만` : `대역폭 ${readableRate(bw)}의 ${Number(share.toFixed(2))}%`, icon: "Activity", heading: true }, "-" as const]
        : []),
      { label: readable, userLabel: true, icon: "Copy", action: () => void writeClipboard(readable) },
      { label: raw, userLabel: true, icon: "Copy", hint: "bit/s", userHint: true, action: () => void writeClipboard(raw) },
    ]);
  }

  /** A device's uptime clicked in the output ("uptime is 3 weeks, 2 days,
   * …", "up 12 days, 3:04"): when it booted, counted back from when that
   * line arrived, not from now (the output may be hours old). To the
   * minute, the precision the devices give. */
  private uptimeMenu(found: UptimeMatch, row: number, x: number, y: number) {
    // The link sees one screen row; a long line wrapped onto the next
    // ("… 3 days, 4 ho" | "urs, 12 minutes") is read whole, or its first
    // part alone would give a boot time hours off.
    const buf = this.term.buffer.active;
    let first = row;
    while (first > 0 && buf.getLine(first)?.isWrapped) first--;
    let whole = "";
    let offset = -1;
    for (let r = first; ; r++) {
      const l = buf.getLine(r);
      if (!l || (r > first && !l.isWrapped)) break;
      if (r === row) offset = whole.length + found.index;
      whole += l.translateToString(r === row ? false : !buf.getLine(r + 1)?.isWrapped);
    }
    const m = findUptimes(whole).find((u) => offset >= u.index && offset < u.index + u.length) ?? found;
    const { seconds, approximate } = m;
    const text = m === found ? (buf.getLine(row)?.translateToString(false) ?? "").slice(found.index, found.index + found.length) : whole.slice(m.index, m.index + m.length);
    const at = this.lineTime(row);
    const boot = at === null ? null : clockText(at - seconds * 1000).slice(0, -3);
    contextMenu(x, y, [
      {
        label: boot === null ? "받은 시각을 몰라 부팅 시각을 셀 수 없습니다" : approximate ? `${boot} 무렵 부팅` : `${boot}에 부팅`,
        icon: "Clock",
        heading: true,
      },
      "-" as const,
      ...(boot === null ? [] : [{ label: boot, userLabel: true, icon: "Copy", hint: "부팅 시각", action: () => void writeClipboard(boot) }]),
      { label: text, userLabel: true, icon: "Copy", hint: "가동 시간", action: () => void writeClipboard(text) },
    ]);
  }

  /** A netmask or ACL/OSPF wildcard clicked in the output: the same prefix
   * written the other ways, to copy ("0.0.0.255" in an ACL is /24, and
   * 255.255.255.0 as a wildcard is 0.0.0.255). */
  private maskMenu(prefix: number, x: number, y: number) {
    const f = maskForms(prefix);
    contextMenu(x, y, [
      { label: f.slash, userLabel: true, icon: "Copy", hint: "접두사", action: () => void writeClipboard(f.slash) },
      { label: f.netmask, userLabel: true, icon: "Copy", hint: "서브넷 마스크", action: () => void writeClipboard(f.netmask) },
      { label: f.wildcard, userLabel: true, icon: "Copy", hint: "와일드카드 마스크", action: () => void writeClipboard(f.wildcard) },
    ]);
  }

  /** A Cisco log message name clicked in the output ("%LINK-3-UPDOWN"): its
   * severity in words, a copy, and every line with it (in this tab or in
   * every terminal tab): how often a port flapped, when the config changed. */
  private logMnemonicMenu(name: string, severity: number, x: number, y: number) {
    const exact = { regex: false, caseSensitive: true };
    contextMenu(x, y, [
      { label: name, userLabel: true, icon: "Copy", hint: `심각도 ${severity} · ${SEVERITY[severity]}`, action: () => void writeClipboard(name) },
      "-",
      { label: "이 메시지가 나온 줄 모아 보기", icon: "ListFilter", action: () => this.matchList(name, exact, false) },
      ...(this.otherTerminals().length ? [{ label: "모든 터미널 탭에서 찾기", icon: "ListFilter", action: () => this.matchList(name, exact, true) }] : []),
    ]);
  }

  /** A Cisco interface clicked in the output ("Gi1/0/1", CDP's "Gig 1/0/1",
   * "GigabitEthernet1/0/1" in the configuration): copy it by its full or short
   * name, or find it however it is written, here or in every terminal tab. */
  private interfaceMenu(type: number, number: string, x: number, y: number) {
    const names = interfaceNames(type, number);
    const pattern = interfaceSearchPattern(type, number);
    // What is on that port, as this switch's MAC table shows it; each opens
    // that MAC's menu, which finds its IP in an ARP table (a router's tab).
    const macs = this.macsOnInterface(pattern);
    // What the port is for, as this tab's output describes it (its
    // configuration, "show interfaces", "show interfaces description").
    const whole = new RegExp(`^(?:${pattern})$`, "i");
    const lines = [...this.outputLines()];
    const texts = lines.map((l) => l.text);
    const description = interfaceDescription(texts, whole);
    // The device at its other end, as CDP or LLDP told it here; its tab
    // when one is open (a session named as CDP names it, "SW2" for
    // "SW2.corp.local", or with that address).
    const neighbor = interfaceNeighbor(texts, whole);
    // The VLAN it is in, as "show vlan brief" here lists it.
    const vlan = interfaceVlan(texts, whole);
    const neighborTab = neighbor
      ? this.ws.liveTab((t) => {
          if (t.view === this) return false;
          // NX-OS adds the serial number: "SW2(FOC1234X0AB)".
          const d = neighbor.device.replace(/\([^()]*\)$/, "").toLowerCase();
          const name = t.session.name.trim().toLowerCase();
          const host = t.session.host.trim().toLowerCase();
          return (!!name && (d === name || d.startsWith(`${name}.`))) || (!!host && (d === host || d.startsWith(`${host}.`)));
        })
      : undefined;
    // Its last link or line-protocol change in this tab's output (a console
    // message, "show logging"), with when that line arrived: told as when it
    // was received, which for an old log line is not when it happened (the
    // message's own time is on the line, which the item goes to).
    let change: { line: OutputLine; state: "up" | "down" | "admin-down"; protocol: boolean } | null = null;
    for (let i = lines.length - 1; i >= 0 && !change; i--) {
      const c = interfaceStateChange(lines[i].text);
      if (c && whole.test(c.iface)) change = { line: lines[i], state: c.state, protocol: c.protocol };
    }
    // What the last change was, and when its line came (null: not known).
    const changeWhat =
      change && (change.protocol ? (change.state === "up" ? "프로토콜 올라옴" : "프로토콜 내려감") : change.state === "up" ? "링크 올라옴" : change.state === "down" ? "링크 내려감" : "관리자가 끔");
    const changeAt = change && this.lineTime(change.line.row);
    const changeItems = (() => {
      if (!change || !changeWhat) return [];
      const { line, state } = change;
      const what = changeWhat;
      const at = changeAt;
      return [
        {
          label: "마지막 상태 변화 메시지로 이동",
          icon: state === "up" ? "Cable" : "Unplug",
          hint: at === null ? what : `${what} · ${clockText(at)}에 받음`,
          action: () => {
            const row = this.locateLine(line.row, line.text);
            if (row < 0) return void toast("그 줄은 스크롤 기록에서 이미 사라졌습니다", "info");
            this.revealLine(row);
          },
        },
        "-" as const,
      ];
    })();
    // All that is known of the port in one text, for a ticket or a chat:
    // its name, then what this output says of it. Words in the screen's
    // language; the device's own values (a description, a name) as written.
    const facts = [
      ...(description ? [`${tr("설명")}: ${description}`] : []),
      ...(vlan ? [vlan.trunk ? tr("트렁크 포트") : `VLAN ${vlan.id}${vlan.name ? ` (${vlan.name})` : ""}`] : []),
      ...(vlan?.state ? [`${tr("상태")}: ${vlan.state}`] : []),
      ...(neighbor ? [`${tr("이웃 장비")}: ${neighbor.device} (${neighbor.port})`] : []),
      ...(changeWhat ? [`${tr("마지막 상태 변화")}: ${tr(changeWhat)}${changeAt === null ? "" : ` (${tr(`${clockText(changeAt)}에 받음`)})`}`] : []),
    ];
    const copyFacts = facts.length
      ? [
          {
            label: "포트 정보 복사",
            icon: "ClipboardList",
            action: () => {
              void writeClipboard([names.full, ...facts].join("\n"));
              toast("포트 정보를 복사했습니다", "success", 1500);
            },
          },
        ]
      : [];
    // Its configuration and state, put on the input line to run (forms both
    // IOS and NX-OS take), only at a command line after the login.
    const commands = this.atCommandLine() ? [`show running-config interface ${names.full}`, `show interface ${names.full}`] : [];
    const rid = this.runtimeId;
    const putCommand = (cmd: string) => {
      if (this.runtimeId !== rid || !this.atCommandLine()) return void toast("명령 줄에서만 보낼 수 있습니다", "warn");
      this.putOnInputLine(cmd);
    };
    contextMenu(x, y, [
      ...(description ? [{ label: description, userLabel: true, icon: "StickyNote", heading: true }, "-" as const] : []),
      // The device's own words (a VLAN number and name): not translated.
      // With the port's state as show interfaces status gives it
      // ("connected", "err-disabled"), the device's own word.
      ...(vlan?.trunk
        ? [{ label: `트렁크 포트${vlan.state ? ` · ${vlan.state}` : ""}`, icon: "Columns2", heading: true }, "-" as const]
        : vlan
          ? [{ label: `VLAN ${vlan.id}${vlan.name ? ` · ${vlan.name}` : ""}${vlan.state ? ` · ${vlan.state}` : ""}`, userLabel: true, icon: "Columns2", heading: true }, "-" as const]
          : []),
      ...(neighbor
        ? [
            { label: `이웃 장비: ${userText(neighbor.device)} (${userText(neighbor.port)})`, icon: "Network", heading: true },
            ...(neighborTab ? [{ label: "이웃 장비의 탭으로 이동", icon: "SquareTerminal", action: () => this.ws.activate(neighborTab.id) }] : []),
            "-" as const,
          ]
        : []),
      ...changeItems,
      { label: names.full, userLabel: true, icon: "Copy", hint: "전체 이름", action: () => void writeClipboard(names.full) },
      ...(names.short !== names.full ? [{ label: names.short, userLabel: true, icon: "Copy", hint: "줄인 이름", action: () => void writeClipboard(names.short) }] : []),
      ...copyFacts,
      "-" as const,
      { label: "이 인터페이스를 모든 형식으로 찾기", icon: "Search", action: () => this.findInTerminal(pattern, true) },
      // Its lines alone: its status, its CDP neighbour, its configuration.
      { label: "이 인터페이스가 나온 줄 모아 보기", icon: "ListFilter", action: () => this.matchList(pattern, { regex: true, caseSensitive: false }, false) },
      ...(this.otherTerminals().length
        ? [{ label: "모든 터미널 탭에서 찾기", icon: "ListFilter", action: () => this.matchList(pattern, { regex: true, caseSensitive: false }, true) }]
        : []),
      ...(commands.length ? ["-" as const] : []),
      ...commands.map((cmd) => ({ label: cmd, userLabel: true, icon: "CornerDownLeft", hint: "입력 줄에 넣기", action: () => putCommand(cmd) })),
      ...(macs.length ? ["-" as const, { label: "이 포트의 MAC 주소", icon: "Cable", heading: true }] : []),
      ...macs.map((m) => ({ label: macFormats(m.value)[2].text, userLabel: true, icon: "Cable", action: () => this.macMenu(m.value, x, y) })),
    ]);
  }

  /** The MAC addresses on an interface's lines of this terminal's output
   * ("show mac address-table": "10  0011.2233.4455  DYNAMIC  Gi1/0/1"), a
   * line with one MAC only; at most eight. This terminal alone: "Gi1/0/1"
   * on another switch is another port. */
  private macsOnInterface(pattern: string): { value: string; tab: string }[] {
    const port = new RegExp(pattern, "i");
    return this.pairedInOutput(
      8,
      (text) => {
        if (!port.test(text)) return null;
        const macs = findMacs(text);
        return macs.length === 1 ? macs[0].hex : null;
      },
      true,
    );
  }

  /** The IPv4 addresses that ARP table lines (arpPair) give this MAC, in
   * this terminal and then the others, each once with the tab it was seen
   * in; at most five. */
  private ipsOfMac(hex: string): { value: string; tab: string }[] {
    // A cheap test first: most lines hold no MAC, or another one.
    const mac = new RegExp(`(?<![0-9a-f])${macSearchPattern(hex)}(?![0-9a-f])`, "i");
    return this.pairedInOutput(5, (text) => {
      if (!mac.test(text)) return null;
      const pair = arpPair(text);
      return pair?.hex === hex ? pair.ip : null;
    });
  }

  /** ipsOfMac the other way: the MACs that ARP table lines give this IPv4
   * address; at most three. */
  private macsOfIp(ip: string): { value: string; tab: string }[] {
    if (ip.includes(":")) return [];
    const addr = new RegExp(addressPattern(ip));
    return this.pairedInOutput(3, (text) => {
      if (!addr.test(text)) return null;
      const pair = arpPair(text);
      return pair?.ip === ip ? pair.hex : null;
    });
  }

  /** What `pick` reads from the output's lines (an address paired with
   * another on an ARP table's line), each once with the tab it was seen in:
   * this terminal first, then the others, each from its newest line back
   * (the table printed last is the one that holds now). At most `max`, from
   * at most PAIR_SCAN_TAB lines of each and PAIR_SCAN in all: a menu opens
   * at once even with many tabs of the longest scrollback. */
  private pairedInOutput(max: number, pick: (text: string) => string | null, hereOnly = false): { value: string; tab: string }[] {
    const found = new Map<string, string>();
    let left = PAIR_SCAN;
    for (const view of hereOnly ? [this] : [this, ...this.otherTerminals()]) {
      let tabLeft = PAIR_SCAN_TAB;
      for (const text of view.recentLines()) {
        if (--left < 0 || --tabLeft < 0) break;
        const value = pick(text);
        if (value === null || found.has(value)) continue;
        // As the tab bar names it: two tabs of one session told apart.
        found.set(value, this.ws.nameOf(view));
        if (found.size >= max) break;
      }
      if (left < 0 || found.size >= max) break;
    }
    return [...found].map(([value, tab]) => ({ value, tab }));
  }

  /** The output's logical lines (a wrapped line joined into one), the newest first. */
  private *recentLines(): Generator<string> {
    const buf = this.term.buffer.active;
    const parts: string[] = [];
    for (let y = buf.length - 1; y >= 0; y--) {
      const line = buf.getLine(y);
      if (!line) continue;
      parts.push(rowText(buf, y).text);
      if (line.isWrapped) continue;
      yield parts.reverse().join("");
      parts.length = 0;
    }
    // A line whose start has left the scrollback.
    if (parts.length) yield parts.reverse().join("");
  }

  /** The output as logical lines (a wrapped line joined into one) and the
   * buffer row each starts on. */
  private *outputLines(): Generator<OutputLine> {
    const buf = this.term.buffer.active;
    let row = 0;
    let parts: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      if (!line.isWrapped && parts.length) {
        yield { row, text: parts.join("") };
        parts = [];
      }
      if (!parts.length) row = y;
      parts.push(rowText(buf, y).text);
    }
    if (parts.length) yield { row, text: parts.join("") };
  }

  /** The find bar's "show all matching lines": every line of the output with
   * what is searched for (case and regex as set there), to read or copy at
   * once, as "| include" would on the device; a click goes to the line. */
  private showMatchingLines() {
    const input = this.findBar.querySelector("input")!;
    const on = (f: string) => !!this.findBar.querySelector(`[data-find="${f}"]`)?.classList.contains("on");
    if (!input.value) return void toast("찾을 내용을 입력하세요", "info");
    this.matchList(input.value, { regex: on("regex"), caseSensitive: on("case") }, false);
  }

  /** This output's lines matching `query` (see matchLines), at most `limit`,
   * and `line(row)`: where a listed row is now (output arriving meanwhile
   * pushes the oldest lines out of the scrollback, moving every row up by as
   * many as the anchor moved), -1 once it is gone. Null for a regular
   * expression that does not compile. */
  findLines(query: string, opts: { regex: boolean; caseSensitive: boolean }, limit: number) {
    const res = matchLines(this.outputLines(), query, opts, limit);
    if (!res) return null;
    const anchor = this.term.registerMarker(0);
    const anchorAt = anchor?.line ?? 0;
    return {
      ...res,
      line: (row: number) => (anchor && !anchor.isDisposed ? row - (anchorAt - anchor.line) : -1),
      dispose: () => anchor?.dispose(),
    };
  }

  /** The row of the line reading exactly `text` (a listed match) nearest to
   * `near`, or -1 when no line reads so any more. */
  locateLine(near: number, text: string): number {
    const want = text.trimEnd();
    let best = -1;
    for (const l of this.outputLines()) {
      if (l.text.trimEnd() !== want) continue;
      if (best < 0 || Math.abs(l.row - near) < Math.abs(best - near)) best = l.row;
    }
    return best;
  }

  /** Show buffer `line`: scrolled to, flashed, this terminal focused. */
  revealLine(line: number) {
    this.term.scrollToLine(line);
    this.flashLine(line);
    this.term.focus();
  }

  /** The other terminal tabs' views, in tab order (for "every terminal tab"). */
  private otherTerminals(): TerminalView[] {
    return this.ws.tabs.map((t) => t.view).filter((v): v is TerminalView => v instanceof TerminalView && v !== this && !v.disposed);
  }

  /** Every line matching `query`, to read or copy at once, as "| include"
   * would on the device: in this terminal, or in every terminal tab
   * (`everywhere`: which switch's output holds a MAC address), each tab's
   * under its name. A click goes to the line, in its tab. */
  private matchList(query: string, opts: { regex: boolean; caseSensitive: boolean }, everywhere: boolean) {
    const LIMIT = 5000;
    const views = everywhere ? this.ws.tabs.map((t) => t.view).filter((v): v is TerminalView => v instanceof TerminalView && !v.disposed) : [this];
    const groups: { view: TerminalView; name: string; res: NonNullable<ReturnType<TerminalView["findLines"]>> }[] = [];
    let left = LIMIT;
    let more = false;
    for (const view of views) {
      const res = view.findLines(query, opts, left);
      // A regex that does not compile: the find bar already says so.
      if (!res) return groups.forEach((g) => g.res.dispose());
      more ||= res.more;
      if (!res.matches.length) {
        res.dispose();
        continue;
      }
      left -= res.matches.length;
      groups.push({ view, name: this.ws.nameOf(view), res });
    }
    const total = LIMIT - left;
    if (!total) return void toast(everywhere ? "어느 터미널 탭에도 일치하는 줄이 없습니다" : "일치하는 줄이 없습니다", "info");
    const marked = (m: LineMatch) => {
      let out = "";
      let at = 0;
      for (const [start, end] of m.ranges) {
        if (start < at) continue;
        out += `${esc(m.text.slice(at, start))}<mark>${esc(m.text.slice(start, end))}</mark>`;
        at = end;
      }
      return out + esc(m.text.slice(at));
    };
    // When each line arrived (a console message or a log line carries no
    // time of its own): a column only when some line's time is known, blank
    // for a line whose time is not (never another line's).
    const now = Date.now();
    const times = groups.map((g) => g.res.matches.map((x) => g.view.lineTime(x.row)));
    const timed = times.some((t) => t.some((v) => v !== null));
    const timeCell = (t: number | null) => (timed ? `<span class="tm">${t === null ? "" : clockText(t, now)}</span>` : "");
    const rows = (g: (typeof groups)[number], gi: number) =>
      g.res.matches
        .map((x, i) => `<button type="button" class="match-row" data-g="${gi}" data-i="${i}" data-i18n-skip><span class="ln">${x.row + 1}</span>${timeCell(times[gi][i])}<span class="tx">${marked(x) || " "}</span></button>`)
        .join("");
    // The tab names are the user's own (never translated); the counts are not.
    const list = groups
      .map((g, gi) => (everywhere ? `<div class="match-tab"><b data-i18n-skip>${esc(g.name)}</b><span class="muted">${g.res.matches.length}개 줄</span></div>` : "") + rows(g, gi))
      .join("");
    const others = !everywhere && this.otherTerminals().length > 0;
    const m = modal({
      title: everywhere ? "모든 터미널 탭에서 일치하는 줄" : "일치하는 줄",
      icon: "ListFilter",
      width: 860,
      body: `<p class="muted small"><span>${total}개 줄</span>${everywhere ? ` · <span>${groups.length}개 탭</span>` : ""}${more ? ` · <span>처음 ${LIMIT}줄만 보여 줍니다</span>` : ""}</p>
        <div class="match-list mono">${list}</div>`,
      footer: `<button class="btn" data-close>닫기</button>${others ? `<button class="btn" data-everywhere>${icon("Search", 14)}모든 터미널 탭에서</button>` : ""}${timed ? `<button class="btn" data-copy-times>${icon("Clock", 14)}시각과 함께 복사</button>` : ""}<button class="btn" data-copy>${icon("Copy", 14)}모두 복사</button>`,
      onClose: () => groups.forEach((g) => g.res.dispose()),
    });
    m.root.querySelector(".match-list")!.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (!el) return;
      const g = groups[Number(el.dataset.g)];
      const x = g.res.matches[Number(el.dataset.i)];
      // Where the row is now, before closing frees the anchors.
      const mapped = g.res.line(x.row);
      m.close();
      if (g.view.disposed || !this.ws.tabs.some((t) => t.view === g.view)) return void toast("그 탭은 이미 닫혔습니다", "info");
      // The listed line itself, near where it should be: a cleared screen,
      // a reflow (new columns) or a reset moves lines in ways the anchor
      // does not follow, and another line must not be shown for it.
      const line = g.view.locateLine(mapped < 0 ? x.row : mapped, x.text);
      if (line < 0) return void toast("그 줄은 스크롤 기록에서 이미 사라졌습니다", "info");
      this.ws.focusView(g.view);
      g.view.revealLine(line);
    });
    m.root.querySelector("[data-everywhere]")?.addEventListener("click", () => {
      m.close();
      this.matchList(query, opts, true);
    });
    // Each line as it reads, or with the time it arrived in front (a record
    // of when a link went down, for a report); a line whose time is not
    // known gets blanks as wide, so the lines stay aligned.
    const copy = (withTimes: boolean) => {
      const shown = times.map((ts) => ts.map((t) => (t === null ? "" : clockText(t, now))));
      const width = Math.max(0, ...shown.flat().map((s) => s.length));
      const lines = (g: (typeof groups)[number], gi: number) =>
        g.res.matches.map((x, i) => (withTimes ? `${shown[gi][i].padEnd(width)}  ` : "") + x.text.trimEnd()).join("\n");
      void writeClipboard(everywhere ? groups.map((g, gi) => `[${g.name}]\n${lines(g, gi)}`).join("\n\n") : lines(groups[0], 0));
      toast(`${total}줄을 복사했습니다`, "success", 2000);
    };
    m.root.querySelector("[data-copy]")!.addEventListener("click", () => copy(false));
    m.root.querySelector("[data-copy-times]")?.addEventListener("click", () => copy(true));
  }

  /** Case and regex as the user had them before findInTerminal set its own. */
  private findRestore: { regex: boolean; matchCase: boolean } | null = null;

  /** Open the find bar on `text` (a regular expression when `regex`), case ignored. */
  private findInTerminal(text: string, regex: boolean) {
    // The user's own case and regex choice comes back when the bar closes
    // (unless they change it meanwhile).
    if (!this.findRestore) {
      const on = (f: string) => !!this.findBar.querySelector(`[data-find="${f}"]`)?.classList.contains("on");
      this.findRestore = { regex: on("regex"), matchCase: on("case") };
    }
    setPressed(this.findBar.querySelector('[data-find="regex"]'), regex);
    setPressed(this.findBar.querySelector('[data-find="case"]'), false);
    this.term.clearSelection();
    this.toggleFind(true);
    const input = this.findBar.querySelector("input")!;
    input.value = text;
    input.dispatchEvent(new Event("input"));
  }

  /** What to do with an address clicked in the output. A new session opens in
   * the editor first; only a saved session's own "Connect" item connects, once
   * per click (as in the network tools and the Syslog window). */
  private addressMenu(ip: string, port: number | null, prefix: number | null, x: number, y: number) {
    // An IPv6 address with a port is written in brackets ("[::1]:631", RFC 3986).
    const address = port ? (ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`) : ip;
    // A port names the protocol when it is a well-known one ("10.0.0.5:3389");
    // another (":443" in netstat output) is not taken for a terminal's port.
    const byPort: Record<number, Protocol> = { 22: "ssh", 23: "telnet", 21: "ftp", 990: "ftps", 69: "tftp", 3389: "rdp", 5900: "vnc" };
    const known = port ? byPort[port] : undefined;
    const protocol: Protocol = known ?? (this.session.protocol === "telnet" ? "telnet" : "ssh");
    const sender = syslogSender(ip);
    // That device's tab, already open (a neighbour in an ARP table): gone to.
    // Otherwise its saved sessions, to connect; none for this tab's own device.
    const theirs = this.ws.liveTab((t) => t.view !== this && sameHost(t.session.host, ip));
    const own = sameHost(this.session.host, ip);
    // Its MAC, as an ARP table in a tab gives it: each opens that MAC's menu
    // (which switch port: "모든 터미널 탭에서 찾기" there).
    const macs = this.macsOfIp(ip);
    contextMenu(x, y, [
      // What kind of address it is (private, CGNAT, loopback…), as the subnet calculator says.
      { label: ip.includes(":") ? ipv6Kind(parseIpv6(ip) ?? 0n) : addressKind(ip), icon: "Info", heading: true },
      "-" as const,
      ...(theirs
        ? [{ label: "이 장비의 탭으로 이동", icon: "SquareTerminal", action: () => this.ws.activate(theirs.id) }]
        : own
          ? []
          : savedSessionItems(ip, () => {})),
      { label: "이 주소로 새 세션 만들기…", icon: "Plus", hint: address, action: () => this.ws.newSessionHandler?.({ protocol, host: ip, ...(known ? { port } : {}) }) },
      { label: "네트워크 도구", icon: "Activity", hint: "ping · 포트 · DNS", action: () => void import("../nettools").then((m) => m.openNetworkTools(ip)) },
      // Watching it come back after a restart, at once.
      // IPv4 only, as the continuous ping's echo is.
      ...(ip.includes(":") ? [] : [{ label: "연속 ping으로 지켜보기", icon: "Activity", action: () => void import("../nettools").then((m) => m.openNetworkTools(ip, "ping", null, true, true)) }]),
      // IPv4 only, as the trace is.
      ...(ip.includes(":") ? [] : [{ label: "경로 추적", icon: "Waypoints", hint: ip, action: () => void import("../nettools").then((m) => m.openNetworkTools(ip, "trace", null, true)) }]),
      // With the prefix written next to it ("/24", a netmask) when there is one.
      { label: "서브넷 계산", icon: "Network", hint: prefix !== null ? `${ip}/${prefix}` : undefined, action: () => void import("../nettools").then((m) => (ip.includes(":") ? m.openNetworkTools(prefix !== null ? `${ip}/${prefix}` : ip, "subnet") : m.openNetworkTools(ip, "subnet", prefix))) },
      // The other devices on its subnet (an interface's address in "show ip
      // interface"): the IP scan filled in, started by its Run button. Only a
      // prefix the scan takes (/22 at most); none written is the scan's /24.
      ...(!ip.includes(":") && (prefix === null || (prefix >= 22 && prefix <= 32))
        ? [{ label: "이 서브넷 스캔…", icon: "Radar", hint: `${ip}/${prefix ?? 24}`, action: () => void import("../nettools").then((m) => m.openNetworkTools(ip, "sweep", prefix)) }]
        : []),
      { label: "주소 복사", icon: "ClipboardList", action: () => void writeClipboard(address) },
      // The device's own log messages, when the Syslog receiver has some from it.
      ...(sender ? [{ label: "이 장비의 Syslog 메시지", icon: "ScrollText", action: () => openSyslog(sender) }] : []),
      // Which device's output holds it (an ARP table, a neighbor list on each).
      ...(this.otherTerminals().length ? [{ label: "모든 터미널 탭에서 찾기", icon: "ListFilter", hint: ip, action: () => this.matchList(addressPattern(ip), { regex: true, caseSensitive: false }, true) }] : []),
      ...(macs.length ? ["-" as const] : []),
      ...macs.map((m) => ({ label: macFormats(m.value)[0].text, userLabel: true, icon: "Cable", hint: m.tab, userHint: true, action: () => this.macMenu(m.value, x, y) })),
    ]);
  }

  /** The command marks still in the scrollback, oldest first, and how to read
   * them (copyCommandOutput, compareRuns).
   *
   * Every Enter is marked (markCommand), not only commands at the prompt: an
   * answer ("[Y/n] y") or keys typed ahead while output still runs land
   * inside a command's output. A command is a mark whose line starts with
   * the prompt it was typed at, that prompt not being a question the
   * previous command asked. */
  private commandBook(): CommandBook {
    const buf = this.term.buffer.active;
    const marks = this.commandMarks.filter((m) => !m.isDisposed && m.line >= 0);
    const text = (y: number) => {
      let t = rowText(buf, y);
      let s = t.text;
      for (let r = y + 1; t.continues; r++) s += (t = rowText(buf, r)).text;
      return s;
    };
    const atPrompt = (m: IMarker) => {
      const p = this.markPrompts.get(m);
      return !!p && !QUESTION.test(p) && text(m.line).startsWith(p);
    };
    return { buf, marks, text, atPrompt };
  }

  /** The command meant now: the one last jumped to (term.prevCommand /
   * nextCommand) while the view is still there, else the latest one typed
   * at a prompt. An index into `book.marks`, which must not be empty. */
  private currentCommand(book: CommandBook): number {
    const { buf, marks, atPrompt } = book;
    const jumped = this.lastJump && this.lastJump.viewportY === buf.viewportY ? marks.findIndex((m) => m.line === this.lastJump!.line) : -1;
    if (jumped >= 0) return jumped;
    let i = marks.length - 1;
    while (i > 0 && !atPrompt(marks[i]) && marks.slice(0, i).some(atPrompt)) i--;
    return i;
  }

  /** term.copyOutput: the output of the command meant now (currentCommand).
   * A command still running gives what it printed so far. */
  private copyCommandOutput() {
    const out = this.commandOutputNow();
    if (!out) return;
    const { lines, running } = out;
    void writeClipboard(lines.join("\n"));
    toast(running ? `명령 출력 ${lines.length}줄을 복사했습니다 (실행 중: 지금까지의 출력)` : `명령 출력 ${lines.length}줄을 복사했습니다`, "success", 3000);
  }

  /** The command meant now (currentCommand), its line flashed: the command as
   * typed after its prompt and its output, trailing blanks trimmed. Nothing
   * (a toast says why) when there is no such command or no output. */
  private commandOutputNow(): { command: string; lines: string[]; running: boolean } | undefined {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return void toast("화면 전체를 쓰는 프로그램 안에서는 쓸 수 없습니다", "info");
    const book = this.commandBook();
    if (!book.marks.length) return void toast("복사할 명령이 없습니다. 프롬프트에서 입력한 명령이 기록된 다음 쓸 수 있습니다", "info", 5000);
    const i = this.currentCommand(book);
    const mark = book.marks[i];
    const { lines, running } = this.outputOf(book, i);
    this.flashLine(mark.line);
    if (!lines.length) return void toast("그 명령은 출력이 없습니다", "info");
    // Named only when the line starts with its prompt (as commandDone reads it).
    const line = book.text(mark.line);
    const prompt = this.markPrompts.get(mark) ?? "";
    const command = line.startsWith(prompt) ? line.slice(prompt.length).trim() : "";
    return { command, lines: lines.map((l) => l.trimEnd()), running };
  }

  /** term menu: the output of the command meant now saved as a text file
   * ("show tech-support" is too long for the clipboard to be handy), named
   * by the tab, the command and the time. */
  private async saveCommandOutput() {
    const out = this.commandOutputNow();
    if (!out) return;
    const { command, lines, running } = out;
    // Name parts with blanks as "_", kept short; characters Windows refuses
    // are replaced where every suggested save name is (pickSavePath).
    const part = (s: string) =>
      s
        .replace(/\s+/g, "_")
        .slice(0, 60)
        .replace(/^_+|_+$/g, "");
    const name = [part(this.title()), part(command), timestamp()].filter(Boolean).join("_");
    const path = await pickSavePath(`${name}.txt`, [{ name: "텍스트", extensions: ["txt", "log"] }]);
    if (!path) return;
    try {
      await api.saveTextFile(path, `${lines.join("\r\n")}\r\n`);
      toast(running ? `명령 출력 ${lines.length}줄을 저장했습니다 (실행 중: 지금까지의 출력)` : `명령 출력 ${lines.length}줄을 저장했습니다`, "success", 3000);
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  /** term.compareRuns: the output of the command meant now (currentCommand)
   * against the last time the same command was typed at the same prompt
   * ("show interfaces status" before and after a change), line by line in
   * the comparison window. Only runs the scrollback still holds are found. */
  private compareRuns() {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return void toast("화면 전체를 쓰는 프로그램 안에서는 쓸 수 없습니다", "info");
    const book = this.commandBook();
    const i = book.marks.length ? this.currentCommand(book) : -1;
    const mark = book.marks[i];
    if (!mark || !book.atPrompt(mark)) return void toast("비교할 명령이 없습니다. 프롬프트에서 입력한 명령이 기록된 다음 쓸 수 있습니다", "info", 5000);
    const prompt = steadyPrompt(this.markPrompts.get(mark)!);
    // The command as typed after its own prompt, blanks evened out.
    const command = (m: IMarker) =>
      book
        .text(m.line)
        .slice((this.markPrompts.get(m) ?? "").length)
        .trim()
        .replace(/\s+/g, " ");
    const now = command(mark);
    let j = i - 1;
    while (j >= 0 && !(steadyPrompt(this.markPrompts.get(book.marks[j]) ?? "") === prompt && book.atPrompt(book.marks[j]) && command(book.marks[j]) === now)) j--;
    this.flashLine(mark.line);
    if (j < 0) return void toast("이 명령을 같은 프롬프트에서 앞서 실행한 기록이 없습니다 (터미널에 남아 있는 출력에서만 찾습니다)", "info", 5000);
    const latest = this.outputOf(book, i);
    // Half an output would show as lines removed.
    if (latest.running) return void toast("명령이 아직 실행 중입니다. 끝난 다음 비교하세요", "info", 4000);
    const earlier = this.outputOf(book, j);
    // Named by the command line as shown and when it ran (both the user's
    // own text: shown as text, never translated).
    const side = (m: IMarker, lines: string[]) => {
      const came = this.lineTime(m.line);
      return { title: `${book.text(m.line).trim()}${came === null ? "" : ` (${clockText(came)})`}`, text: lines.map((l) => l.trimEnd()).join("\n") };
    };
    void import("../diffView").then((d) => d.openDiff(side(book.marks[j], earlier.lines), side(mark, latest.lines)));
  }

  /** Command `i`'s output, from the line after it to the line where its
   * prompt comes back: the next line that starts with the prompt it was
   * typed at, or the next mark that does (other marks inside it are not
   * ends). Lines wrapped over several rows are joined; blank lines at the
   * end are left out. `running`: its prompt has not come back yet. */
  private outputOf(book: CommandBook, i: number): { lines: string[]; running: boolean } {
    const { buf, marks, text, atPrompt } = book;
    const mark = marks[i];
    const prompt = this.markPrompts.get(mark) ?? "";
    // The command's own line may wrap over several rows.
    let from = mark.line;
    while (buf.getLine(from + 1)?.isWrapped) from++;
    from++;
    // The prompt the cursor waits at now (its first row).
    const cursorRow = buf.baseY + buf.cursorY;
    let promptRow = cursorRow;
    while (promptRow > 0 && buf.getLine(promptRow)?.isWrapped) promptRow--;
    const later = new Set(marks.slice(i + 1).filter(atPrompt).map((m) => m.line));
    // A prompt as short as "$" or "#" also starts lines of output ("$HOME …"):
    // only a longer one ("user@web:~$", "router#") is looked for in the text.
    const findable = prompt.length >= 3;
    let end = -1;
    for (let y = from; y <= promptRow; y++) {
      if (buf.getLine(y)?.isWrapped) continue;
      if (later.has(y) || (findable && y < promptRow && text(y).startsWith(prompt))) {
        end = y;
        break;
      }
    }
    // Back at a prompt (another host's after "exit" counts), also one with
    // the next command being typed after it ("R1#sh"): the line the cursor
    // waits at is no output. Otherwise the command still runs.
    const typingAtPrompt = findable && promptRow > mark.line && text(promptRow).startsWith(prompt);
    const idle = typingAtPrompt || PROMPT_END.test((buf.getLine(cursorRow)?.translateToString(true, 0, buf.cursorX) ?? "").trimEnd());
    const running = end < 0 && !idle;
    let to = end >= 0 ? end - 1 : running ? cursorRow : promptRow - 1;
    // A two-line prompt drawn with box lines ("┌──(user㉿host)-[~]" over
    // "└─$"): its first line is no output either.
    const first = mark.line > 0 ? text(mark.line - 1) : "";
    if (!running && /^[└╰]/.test(prompt) && /^[┌╭]/.test(first) && to >= from && text(to) === first) to--;
    const lines: string[] = [];
    for (let y = from; y <= to; y++) {
      if (buf.getLine(y)?.isWrapped && lines.length) {
        lines[lines.length - 1] += rowText(buf, y).text;
        continue;
      }
      lines.push(rowText(buf, y).text);
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return { lines, running };
  }

  /** The cursor's row is the shell's command line: it starts with the prompt
   * this tab learnt (by its head, "admin@web" of "admin@web:/tmp$", so another
   * folder still counts), or, no prompt learnt, an idle prompt waits on the
   * bottom row. A vi's file rows ("# comment") are neither. */
  private atShellLine(): boolean {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return false;
    const row = (buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "").trimStart();
    const learnt = this.assist?.knownPrompt().trim() ?? "";
    const head = learnt ? promptHead(learnt) : "";
    if (head) return promptHead(row) === head;
    // A bare prompt ("$ ", "# " on Unix): a vi's "# comment" row starts so
    // too, so only with what the user typed after it, as the command
    // assistant followed it, or an idle prompt on the bottom row.
    const typed = this.assist?.typedText().trim() ?? "";
    if (learnt && typed && row.startsWith(learnt) && row.slice(learnt.length).trim() === typed) return true;
    if (buf.cursorY !== this.term.rows - 1) return false;
    // Idle on the bottom row: that very prompt, not any row that ends like
    // one (vi's search "/[0-9]" or "/end$", a "#####" banner line).
    // (Another bare prompt after "su": an idle one, never a vi's command line.)
    if (learnt && row.trimEnd() === learnt) return true;
    return !/^[/?:]/.test(row) && this.idlePrompt() !== null;
  }

  /** At the shell's command line (atShellLine), the command typed on it: as
   * the command assistant follows it, else the row after the learnt prompt,
   * else "" (not known). Null away from the shell. */
  private shellCommandTyped(): string | null {
    if (!this.atShellLine()) return null;
    const typed = this.assist?.typedText() ?? "";
    if (typed) return typed;
    const buf = this.term.buffer.active;
    const row = (buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "").trimStart();
    const learnt = this.assist?.knownPrompt().trim() ?? "";
    return learnt && row.startsWith(learnt) ? row.slice(learnt.length).trim() : "";
  }

  /** The selection's lines, whole: its first and last buffer row, wrapped
   * rows taken in; none without a selection. */
  private selectedRows(): { first: number; last: number } | null {
    const pos = this.term.hasSelection() ? this.term.getSelectionPosition() : undefined;
    if (!pos) return null;
    const buf = this.term.buffer.active;
    // Buffer rows, from 0 (xterm's docs say 1, its selection service gives 0).
    // A selection ending at the very start of a row does not take that row.
    let first = pos.start.y;
    let last = pos.end.x === 0 && pos.end.y > first ? pos.end.y - 1 : pos.end.y;
    while (first > 0 && buf.getLine(first)?.isWrapped) first--;
    while (buf.getLine(last + 1)?.isWrapped) last++;
    return { first, last };
  }

  /** The time between the selection's first and last line, by when each
   * arrived (a reload's outage, a routing change settling): "12:01:03 →
   * 12:03:40 · 2m 37s"; none for one line or a line with no time. */
  private selectionSpan(): string | null {
    const rows = this.selectedRows();
    if (!rows) return null;
    // A drag often ends (or starts) on a blank row, which has no time: the
    // nearest line with text at each end counts.
    const buf = this.term.buffer.active;
    const blank = (y: number) => !buf.getLine(y)?.translateToString(true).trim();
    let { first, last } = rows;
    while (first < last && blank(first)) first++;
    while (last > first && blank(last)) last--;
    // One line (wrapped over several rows or not) spans no time.
    while (last > first && buf.getLine(last)?.isWrapped) last--;
    if (first === last) return null;
    const from = this.lineTime(first);
    const to = this.lineTime(last);
    if (from === null || to === null || to <= from) return null;
    return `${clockText(from)} → ${clockText(to)} · ${durationText(to - from)}`;
  }

  /** term.copyTable: the selected lines, whole (from the selection's first
   * row to its last, wrapped rows joined), as a tab-separated table a
   * spreadsheet pastes one value per cell; columns as tableCopy.ts reads them
   * from the header, by screen cell so wide characters keep them aligned. */
  private copyTable() {
    const picked = this.selectedRows();
    if (!picked) return void toast("표로 복사할 줄을 머리글 줄부터 먼저 선택하세요", "info", 4000);
    const { first, last } = picked;
    const buf = this.term.buffer.active;
    const nul = buf.getNullCell();
    const lines: CellLine[] = [];
    for (let y = first; y <= last; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const cells: CellLine = [];
      for (let x = 0; x < line.length; x++) {
        const c = line.getCell(x, nul);
        if (!c) break;
        // The right half of a wide character is "", so a position stays a column.
        cells.push(c.getWidth() === 0 ? "" : c.getChars() || " ");
      }
      // The blank xterm leaves at a row's end where a wide character moved down.
      const next = buf.getLine(y + 1);
      if (next?.isWrapped && line.getCell(line.length - 1)?.getCode() === 0 && next.getCell(0)?.getWidth() === 2) cells.pop();
      if (line.isWrapped && lines.length) lines[lines.length - 1].push(...cells);
      else lines.push(cells);
    }
    const rows = splitTable(lines);
    if (!rows) return void toast("머리글과 함께 두 줄 이상 선택하세요", "info", 4000);
    const columns = Math.max(...rows.map((r) => r.length));
    void writeClipboard(rows.map((r) => r.map(sheetCell).join("\t")).join("\n"));
    toast(`표로 복사했습니다 (${rows.length}행 × ${columns}열). 엑셀에 붙여 넣으세요`, "success", 3500);
  }

  /** term.compare: the selection goes into the output comparison (the first
   * one is kept; the second opens it). */
  private compareSelection() {
    const text = this.term.getSelection();
    if (!text.trim()) return void toast("비교할 부분을 먼저 선택하세요", "info", 3000);
    void import("../diffView").then((m) => m.takeForDiff({ title: this.ws.nameOf(this), text }));
  }

  /** Toggle "notify when the task finishes" for this tab. */
  private toggleNotify() {
    this.notifyDone = !this.notifyDone;
    setPressed(this.el.querySelector('.view-actions [data-act="notify"]'), this.notifyDone);
    if (this.notifyDone) {
      ensureNotifyPermission();
      toast("작업이 끝나면 알립니다 (다른 탭을 보고 있을 때)", "info", 2500);
    } else {
      clearTimeout(this.notifyTimer);
      this.notifySaw = false;
      toast("작업 완료 알림을 껐습니다", "info", 2000);
    }
  }

  private acked = 0;
  private ackTimer = 0;
  private ack(rid: string, n: number) {
    if (rid !== this.runtimeId) return;
    this.acked += n;
    // Output (a banner) can arrive before termOpen returns, while the backend
    // cannot take acknowledgements yet: they are sent once it is open.
    if (rid !== this.opened) return;
    const send = () => {
      clearTimeout(this.ackTimer);
      this.ackTimer = 0;
      const bytes = this.acked;
      this.acked = 0;
      if (bytes && rid === this.runtimeId) api.termAck(rid, bytes).catch(() => {});
    };
    // Big batches at once (the backend may be waiting); small echoes later, together.
    if (this.acked >= 64 * 1024) send();
    else if (!this.ackTimer) this.ackTimer = window.setTimeout(send, 50);
  }

  /** How a connection that ended with `code` went, from what exited() reads
   * below: given up on purpose ("다시 연결", closing), a login that never went
   * through (only ssh.exe's own messages, a failed or unfinished login: the
   * attempt failed though output came), a drop, or an ordinary end. */
  private endedHow(code: number): "failed" | "error" | "closed" {
    if (this.closing) return "closed";
    const p = this.session.protocol;
    if (p === "ssh" || p === "telnet") {
      const lines = plainLines(new TextDecoder().decode(this.endBytes));
      const refused = loginFailure(lines);
      // A login refused, or (ssh) nothing but ssh.exe's own messages before it ended.
      if (!this.loggedIn && (refused || (p === "ssh" && code && !loginThrough(lines)))) return "failed";
      if (refused && code) return "failed";
      // As exited() decides a Telnet end: not through unless the device's own prompt was last.
      if (p === "telnet" && code && (!this.loggedIn || !loginThrough(lines))) return "failed";
    }
    if (!code) return "closed";
    if (p === "ssh") return code === 255 ? "error" : "closed";
    return "error";
  }

  historyEnd(): "failed" | "error" | "closed" | null {
    return this.endedAs;
  }

  exited(id: string, code: number) {
    if (id === this.runtimeId) this.stopPaste(true);
    if (id !== this.runtimeId) return;
    this.stopMonitor();
    clearTimeout(this.loginTimer);
    this.endedAs = this.endedHow(code);
    this.setState("closed");
    this.writeNote(`\r\n\x1b[90m[${tr("연결이 종료되었습니다")}${code ? ` ${tr(`· 종료 코드 ${code}`)}` : ""}]\x1b[0m\r\n`);
    // A serial line ends with an error only when the port went away.
    if (code && this.waitForPort("연결이 끊어졌습니다.")) return;
    // What the end calls for, never another login where one failed or did
    // not finish (afterExit says why for each case).
    const next = afterExit({
      protocol: this.session.protocol,
      code,
      lines: code ? plainLines(new TextDecoder().decode(this.endBytes)) : [],
      loginAsked: this.loginAsked,
      loggedIn: this.loggedIn,
      chain: this.reChain,
    });
    this.reChain = next.chain;
    if (next.verdict === "failed") return this.showLoginFailure(next.failure!);
    if (next.verdict === "unfinished")
      return this.showOverlay("로그인하지 못했습니다", "로그인을 마치기 전에 연결이 끝나 자동으로 다시 연결하지 않았습니다. 다시 연결하거나 탭을 닫을 수 있습니다.");
    if (next.verdict === "unreached")
      return this.showOverlay("연결하지 못했습니다", "로그인하기 전에 연결이 끝나 자동으로 다시 연결하지 않았습니다. 다시 연결하거나 탭을 닫을 수 있습니다.");
    if (next.verdict === "dropped" && this.scheduleAutoReconnect()) return;
    this.showOverlay("연결이 종료되었습니다", "다시 연결하거나 탭을 닫을 수 있습니다.");
  }

  /** Auto-reconnect an SSH/Telnet session that dropped unexpectedly, after a
   * short backing-off wait shown as a countdown the user can cancel. False when
   * this tab does not auto-reconnect (not ssh/telnet, closing on purpose, turned
   * off in Settings, or the user chose not to). */
  private scheduleAutoReconnect(): boolean {
    const p = this.session.protocol;
    if ((p !== "ssh" && p !== "telnet") || this.closing || this.disposed || this.reDeclined || !state.settings.autoReconnect) return false;
    // A session that ran for a while before it dropped starts the backoff over;
    // one that keeps ending at once (a server that is down, or that hangs up
    // right after the login) is retried less and less often.
    if (this.loggedInAt && Date.now() - this.loggedInAt >= 60_000) this.reAttempts = 0;
    const delays = [2, 4, 8, 15, 30];
    let left = delays[Math.min(this.reAttempts, delays.length - 1)];
    this.reAttempts++;
    this.stopAutoReconnect();
    const rid = this.runtimeId;
    const show = () => this.showReconnectOverlay(left);
    show();
    const tick = () => {
      if (!this.reTimer || this.disposed || rid !== this.runtimeId) return;
      if (--left <= 0) {
        this.stopAutoReconnect();
        // Keep the backoff count (userInitiated = false) so a server that stays
        // down is retried after 2, 4, 8, 15, then 30s, not every 2s.
        if (!this.disposed && rid === this.runtimeId) this.reconnect(false);
        return;
      }
      show();
      this.reTimer = window.setTimeout(tick, 1000);
    };
    this.reTimer = window.setTimeout(tick, 1000);
    return true;
  }

  private stopAutoReconnect() {
    clearTimeout(this.reTimer);
    this.reTimer = 0;
  }

  /** The overlay shown while waiting to auto-reconnect: a countdown, reconnect
   * now, or stop auto-reconnecting. */
  private showReconnectOverlay(secs: number) {
    this.overlay.hidden = false;
    this.overlay.innerHTML = `<div class="overlay-card">
      ${icon("Unlink", 26)}
      <h3>${esc(tr("연결이 끊어졌습니다"))}</h3>
      <p>${esc(tr(`${secs}초 후 자동으로 다시 연결합니다`))}</p>
      <div class="row"><button class="btn btn-primary" data-o="re">${icon("RotateCw", 15)}${tr("지금 다시 연결")}</button>
      <button class="btn" data-o="stop">${tr("자동 재연결 끄기")}</button></div></div>`;
    this.overlay.querySelector('[data-o="re"]')!.addEventListener("click", () => this.reconnect());
    this.overlay.querySelector('[data-o="stop"]')!.addEventListener("click", () => {
      this.stopAutoReconnect();
      this.reDeclined = true;
      this.showOverlay("연결이 종료되었습니다", "다시 연결하거나 탭을 닫을 수 있습니다.");
    });
  }

  /** Run the session's startup commands once the shell is ready (sent like a
   * paste, so each line runs; device consoles are paced). */
  private runStartupCommands() {
    if (this.startupSent) return;
    const raw = String(this.session.options.onConnectCmds ?? "").trim();
    if (!raw) return;
    this.startupSent = true;
    const text = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join("\r") + "\r";
    // A short wait lets the login banner and first prompt settle first. Only
    // into the logged-in connection it was meant for: one made meanwhile (a
    // quick drop and reconnect) may be at a login prompt.
    const rid = this.runtimeId;
    window.setTimeout(() => {
      if (this.disposed || this.state !== "connected" || this.runtimeId !== rid || !this.loggedIn || this.inputKind() !== "shell") {
        // Not sent: the next login sends them instead.
        this.startupSent = false;
        return;
      }
      this.interruptRepeat();
      this.pasteText(text);
    }, 600);
  }

  /** Timer of the wait for a serial port to come back (0: not waiting). */
  private portWait = 0;
  /** "Stop waiting" was chosen: an attempt still under way must not start
   * the wait again; the next reconnect by the user allows it again. */
  private portWaitDeclined = false;

  /** A COM port that went away (USB adapter unplugged) or is not there yet:
   * check every second and reconnect once it shows up. False when this tab
   * does not wait (not serial, or turned off in Settings). */
  private waitForPort(reason: string): boolean {
    if (this.session.protocol !== "serial" || !state.settings.serialAutoReconnect || this.portWaitDeclined || this.disposed) return false;
    const name = this.session.host.trim().toUpperCase();
    this.stopPortWait();
    this.showOverlay(`${name} 포트를 기다리는 중`, reason, true);
    const rid = this.runtimeId;
    const tick = async () => {
      if (!this.portWait || this.disposed || rid !== this.runtimeId) return;
      const ports = await api.serialPorts().catch(() => []);
      if (!this.portWait) return;
      if (ports.some((p) => p.name === name)) {
        this.stopPortWait();
        // Give the driver a moment to finish setting the port up.
        window.setTimeout(() => !this.disposed && rid === this.runtimeId && this.reconnect(), 500);
        return;
      }
      this.portWait = window.setTimeout(tick, 1000);
    };
    this.portWait = window.setTimeout(tick, 1000);
    return true;
  }

  private stopPortWait() {
    clearTimeout(this.portWait);
    this.portWait = 0;
  }

  private setState(s: ViewState) {
    if (s !== "connected" && this.repeat) this.stopRepeat("연결이 끊어져 반복 실행을 멈췄습니다", "warn");
    this.state = s;
    const label: Record<ViewState, string> = {
      connecting: "연결 중",
      connected: "연결됨",
      closed: "종료됨",
      error: "오류",
    };
    const el = this.el.querySelector<HTMLElement>("[data-state]")!;
    el.textContent = label[s];
    el.dataset.state = s;
    this.ws.changed();
  }

  /** `waiting`: waiting for a COM port to come back (waitForPort). */
  private showOverlay(title: string, detail: string, waiting = false) {
    this.overlay.hidden = false;
    this.overlay.innerHTML = waiting
      ? `<div class="overlay-card port-wait">
        ${icon("Usb", 26)}
        <h3>${esc(title)}</h3><p>${esc(detail)}</p>
        <p class="muted small">케이블(USB 어댑터)을 다시 연결하면 자동으로 연결합니다.</p>
        <div class="row"><button class="btn btn-primary" data-o="re">${icon("RotateCw", 15)}지금 다시 연결</button>
        <button class="btn" data-o="stop">기다리지 않기</button></div></div>`
      : `<div class="overlay-card">
        ${icon(this.state === "error" ? "WifiOff" : "Unlink", 26)}
        <h3>${esc(title)}</h3><p>${esc(detail)}</p>
        <div class="row"><button class="btn btn-primary" data-o="re">${icon("RotateCw", 15)}다시 연결</button>
        <button class="btn" data-o="hide">닫기</button></div></div>`;
    this.overlay.querySelector('[data-o="re"]')!.addEventListener("click", () => this.reconnect());
    this.overlay.querySelector('[data-o="hide"]')?.addEventListener("click", () => (this.overlay.hidden = true));
    this.overlay.querySelector('[data-o="stop"]')?.addEventListener("click", () => {
      this.stopPortWait();
      this.portWaitDeclined = true;
      this.showOverlay("연결이 종료되었습니다", detail);
    });
  }

  // ---- toolbar ---------------------------------------------------------------

  private wireToolbar() {
    this.el.querySelector(".view-actions")!.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (!act) return;
      switch (act) {
        case "find":
          return this.toggleFind(true);
        case "log":
          return this.setLogging(!this.logPath, true);
        case "save":
          return this.saveOutput();
        case "clear":
          return this.clearScreen();
        case "zoomin":
        case "zoomout":
          return this.zoom(act === "zoomin" ? 1 : -1);
        case "sftp": {
          const blocked = fileTransferBlockedReason(this.session);
          if (blocked) return void toast(blocked, "error", 7000);
          return this.openFiles(this.session, this);
        }
        case "ftp": {
          // Telnet has no SFTP; reuse this session's host and login for FTP.
          const blocked = fileTransferBlockedReason(this.session);
          if (blocked) return void toast(blocked, "error", 7000);
          return this.openFiles(fileSessionFor(this.session, "ftp"), this);
        }
        case "reconnect":
          return this.reconnect();
        case "device":
          return this.deviceMenu();
        case "keys":
          return this.keysMenu();
        case "sendfile":
          return void this.sendFile();
        case "break":
          this.stopPaste();
          return void api.termBreak(this.runtimeId).then(
            () => toast("Break 신호를 보냈습니다", "success", 2000),
            (err) => toast(errorText(err), "error"),
          );
        case "ai":
          return this.aiMenu();
        case "snippet":
          return snippetMenu(this.el.querySelector('[data-act="snippet"]')!, (s) => this.sendSnippet(s), this.device?.kind ?? this.osGuess, [this.repeatMenuItem(), this.timerMenuItem()]);
        case "record":
          return this.toggleRecording();
        case "notify":
          return this.toggleNotify();
      }
    });
    const input = this.findBar.querySelector("input")!;
    const count = this.findBar.querySelector<HTMLElement>(".find-count")!;
    // Show how many matches there are and which one is active ("3/12").
    this.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      count.textContent = resultCount === 0 ? (input.value ? tr("결과 없음") : "") : `${resultIndex >= 0 ? resultIndex + 1 : "–"}/${resultCount}`;
    });
    const caseBtn = this.findBar.querySelector<HTMLElement>('[data-find="case"]')!;
    const regexBtn = this.findBar.querySelector<HTMLElement>('[data-find="regex"]')!;
    const find = (dir: "next" | "prev") => {
      const regex = regexBtn.classList.contains("on");
      // The search addon builds the RegExp unguarded: a pattern still being
      // typed ("(ab") would throw on every key and leave the old count shown.
      let bad = false;
      if (regex && input.value) {
        try {
          new RegExp(input.value, "g");
        } catch {
          bad = true;
        }
      }
      input.classList.toggle("invalid", bad);
      input.setAttribute("aria-invalid", String(bad));
      if (bad) {
        this.search.clearDecorations();
        count.textContent = tr("잘못된 정규식");
        return;
      }
      const opts = { caseSensitive: caseBtn.classList.contains("on"), regex, decorations: { matchOverviewRuler: "#f5c518", activeMatchColorOverviewRuler: "#f5c518", activeMatchBackground: "#f5c51866", matchBackground: "#f5c51833" } };
      if (dir === "next") this.search.findNext(input.value, opts);
      else this.search.findPrevious(input.value, opts);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.altKey) {
        e.preventDefault();
        return this.showMatchingLines();
      }
      if (e.key === "Enter") find(e.shiftKey ? "prev" : "next");
      if (e.key === "Escape") this.toggleFind(false);
    });
    input.addEventListener("input", () => find("next"));
    this.findBar.addEventListener("click", (e) => {
      const f = (e.target as HTMLElement).closest<HTMLElement>("[data-find]")?.dataset.find;
      if (f === "close") this.toggleFind(false);
      else if (f === "list") this.showMatchingLines();
      else if (f === "case" || f === "regex") {
        const btn = f === "case" ? caseBtn : regexBtn;
        setPressed(btn, !btn.classList.contains("on"));
        this.findRestore = null; // the user's own choice now
        find("next"); // re-run with the new case/regex setting
      } else if (f === "next" || f === "prev") find(f);
    });
  }

  private toggleFind(show: boolean) {
    this.findBar.hidden = !show;
    if (show) {
      const input = this.findBar.querySelector("input")!;
      // A selection over several lines: its first line with text (a one-line
      // box drops the line breaks, running the lines together into a text
      // found nowhere), the cells' blanks at its end left out.
      // Blanks alone: the query kept (as with no selection).
      const line = this.term.hasSelection() ? this.term.getSelection().split(/\r\n?|\n/).find((l) => l.trim()) : undefined;
      if (line) input.value = line.replace(/[ \t]+$/, "");
      input.focus();
      input.select();
      // Highlight matches at once when opening on a selection or a kept query,
      // instead of waiting for the next keystroke.
      if (input.value) input.dispatchEvent(new Event("input"));
    } else {
      this.search.clearDecorations();
      this.findBar.querySelector<HTMLElement>(".find-count")!.textContent = "";
      if (this.findRestore) {
        setPressed(this.findBar.querySelector('[data-find="regex"]'), this.findRestore.regex);
        setPressed(this.findBar.querySelector('[data-find="case"]'), this.findRestore.matchCase);
        this.findRestore = null;
      }
      this.term.focus();
    }
    this.layout();
  }

  /** Start or stop the log. `ask`: started from the toolbar, so offer to edit
   * the file name first (when the settings say so). */
  private async setLogging(enable: boolean, ask = false) {
    try {
      let options = null;
      if (enable) {
        const c = this.relog && this.logUsed ? { ...this.logUsed } : logConfig(this.session);
        if (ask && state.settings.logPrompt) {
          const res = await promptDialog({
            title: "로그 기록 시작",
            label: "로그 파일 이름",
            value: c.path,
            icon: "ScrollText",
            confirm: "기록 시작",
            extra: `<p class="muted small">지금 시작하면: <b data-log-preview>${esc(previewPath(c.path, this.session))}</b></p>
                    <p class="muted small">치환 문자: ${LOG_TOKENS}</p>`,
            onInput: (value, form) => {
              form.querySelector("[data-log-preview]")!.textContent = previewPath(value.trim() || c.path, this.session);
            },
          });
          if (!res || this.disposed) return;
          c.path = res.value.trim() || c.path;
        }
        this.logUsed = c;
        options = backendLogOptions(c, this.session);
      }
      this.logPath = await api.termSetLogging(this.runtimeId, options);
      setPressed(this.el.querySelector('.view-actions [data-act="log"]'), !!this.logPath);
      if (this.logPath) toast(`로그 기록을 시작했습니다: ${userText(this.logPath)}`, "success");
      else toast("로그 기록을 중지했습니다");
      this.ws.changed();
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  async ensureLog(): Promise<boolean> {
    if (!this.logPath) await this.setLogging(true);
    return !!this.logPath;
  }

  revealLog() {
    if (this.logPath) revealInExplorer(this.logPath);
  }

  private async saveOutput() {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    const path = await pickSavePath(`${this.title()}_${timestamp()}.txt`, [{ name: "텍스트", extensions: ["txt", "log"] }]);
    if (!path) return;
    try {
      await api.saveTextFile(path, lines.join("\r\n") + "\r\n");
      toast(`출력 내용을 저장했습니다 (${lines.length}줄)`, "success");
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  private async paste() {
    // Taken before the clipboard is read: see sendScope.
    const scope = this.inputScope();
    const text = await readClipboard();
    if (text) this.pasteFromUser(text, undefined, scope);
  }

  /** Several lines at a line before any login (or a console's welcome): the
   * device may ask for a login, and each line would then go in as a user
   * name or a password, a failed login each. Sent only when the user says so. */
  /** `paced`: the lines go as a paced paste, which stops at a login question (a snippet's do not). */
  private async confirmBeforeLogin(lines: number, paced = false): Promise<boolean> {
    const ok = await confirmDialog({
      title: "로그인 전입니다",
      icon: "TriangleAlert",
      danger: true,
      message: `<p><b>${esc(`${lines}줄을 보냅니다: ${userText(this.ws.nameOf(this))}`)}</b></p>
        <p>이 탭은 아직 로그인 전이거나 로그인을 기다리는 콘솔입니다. 장비가 로그인을 물으면 각 줄이 사용자 이름이나 비밀번호로 들어가 로그인 실패가 됩니다.</p>
        ${paced ? `<p class="muted small">장비 콘솔에서 한 줄씩 보낼 때는 로그인을 묻는 줄이 나타나면 거기서 멈춥니다.</p>` : ""}`,
      confirm: "그래도 보내기",
      cancel: "취소",
      focusCancel: true,
    });
    if (this.disposed) return false;
    this.term.focus();
    return ok;
  }

  /** `file`: the name of the file being sent (the confirmation names it). */
  private async pasteFromUser(text: string, file?: string, scope = this.inputScope()) {
    if (this.state !== "connected") return void toast("연결된 다음에 붙여넣을 수 있습니다", "warn");
    // The kind of line it is pasted at (see inputKind), for the broadcast tabs.
    const kind = scope.kind;
    this.interruptRepeat();
    const lines = text.replace(/(?:\r\n|\r|\n)$/, "").split(/\r?\n|\r/);
    // Several lines into a login, password or host-key question: each would be an attempt.
    if (lines.length > 1 && (kind === "user" || kind === "secret" || kind === "hostkey")) return void toast(MANY_LINES_AT_LOGIN, "warn", 6000);
    // Before a login, or at a console's welcome: only when the user says so.
    const beforeLogin = lines.length > 1 && kind === "prelogin";
    if (beforeLogin && !(await this.confirmBeforeLogin(lines.length, this.paced))) return;
    // A pasted line break is an Enter: those lines run at once, so they go
    // through riskGate like a snippet (one line with a trailing line break
    // too). The text after the last break waits on the line for the user's
    // own Enter, which is checked then. A paste is text, not keys: tabs in a
    // configuration file do not make it an unreadable macro.
    // A full-screen program (vi, less) owns the screen: nothing runs there.
    const breakAt = this.term.buffer.active.type === "normal" ? text.search(/[\r\n][^\r\n]*$/) : -1;
    // A password pasted at its question is no command: never checked, shown or recorded.
    const runs = breakAt < 0 || kind === "secret" ? "" : text.slice(0, breakAt + 1);
    const hits = runs ? findRisks(runs).filter((h) => h.rule !== UNREADABLE_MACRO) : [];
    // The first line joins what is already on the command line.
    const first = runs ? this.enterRisk(runs.slice(0, runs.search(/[\r\n]/))) : null;
    if (first && !hits.some((h) => h.rule === first.rule)) hits.unshift(first);
    if (hits.length) {
      const others = await this.riskGate(hits, file ? `텍스트 파일: <b data-i18n-skip>${esc(file)}</b>` : "붙여넣기", "(paste)", scope);
      if (this.disposed) return; // the tab may have been closed while the dialog was up
      this.term.focus();
      if (!others) return;
      this.pasteText(text);
      this.continueLine(scope, deliverConfirmed(others, { paste: text, kind: kind ?? undefined }, hits, "(paste)"), text);
      this.recording?.push(text.replace(/\r?\n/g, "\r"));
      return;
    }
    // (Asked already when before a login.)
    if (lines.length > 1 && state.settings.confirmMultiPaste && !beforeLogin) {
      const preview = lines.slice(0, 6).map((l) => esc(l.length > 120 ? `${l.slice(0, 120)}…` : l)).join("\n");
      const how = this.paced
        ? state.settings.pasteMode === "fixed"
          ? "장비 콘솔이라 정해진 지연을 두고 한 줄씩 보냅니다. 보내는 중에 Ctrl+C를 누르면 멈춥니다."
          : "장비 콘솔이라 장비가 각 줄을 받아들이는 대로 한 줄씩 보냅니다. 보내는 중에 Ctrl+C를 누르면 멈춥니다."
        : "";
      // One text node per sentence, so each is translated whole; the preview
      // is the user's own text and is never translated.
      const ok = await confirmDialog({
        title: file ? "텍스트 파일 보내기" : "여러 줄 붙여넣기",
        icon: "ClipboardPaste",
        message: `<p><b>${esc(`${lines.length}줄을 보냅니다: ${userText(this.ws.nameOf(this))}`)}</b></p>
          ${file ? `<p class="muted small">${esc(`파일: ${userText(file)}`)}</p>` : ""}
          <pre class="paste-preview" data-i18n-skip>${preview}${lines.length > 6 ? "\n…" : ""}</pre>
          ${how ? `<p class="muted small">${how}</p>` : ""}`,
        confirm: "보내기",
        dontAsk: () => updateSettings({ confirmMultiPaste: false }),
      });
      if (this.disposed) return; // the tab may have been closed while the dialog was up
      this.term.focus();
      if (!ok) return;
    }
    // Only to the connections it was meant for (a reconnect meanwhile may
    // sit at a login prompt, where each line would be a failed login).
    const peers = this.stillSame(scope);
    if (!peers) return void toast("연결이 바뀌어 보내지 않았습니다", "warn");
    // A file picked or a dialog answered meanwhile: still the same kind of line.
    if (!this.lineStill(scope)) return void toast(LINE_CHANGED, "warn", 6000);
    this.noteLeftOut(scope, peers);
    this.pasteText(text);
    const live = new Set(this.ws.mirrorTargets(this, false));
    const took = kind !== "prelogin" ? broadcastTo(peers.filter((t) => live.has(t)), { paste: text, kind: kind ?? undefined }) : [];
    this.continueLine(scope, took, text);
    this.recording?.push(text.replace(/\r?\n/g, "\r"));
  }

  private get keyMode(): "standard" | "network" {
    return this.session.options.keyMode === "network" ? "network" : "standard";
  }

  private renderKeyMode() {
    const label = this.el.querySelector<HTMLElement>("[data-keys-label]");
    const bs = this.session.options.backspace === "ctrl-h" ? " · ^H" : "";
    if (label) label.textContent = (this.keyMode === "network" ? "키: 장비" : "키: 표준") + bs;
    setPressed(this.el.querySelector('[data-act="keys"]'), this.keyMode === "network");
  }

  /** Key options for this tab, remembered in the saved session. */
  private keysMenu() {
    const r = this.el.querySelector<HTMLElement>('[data-act="keys"]')!.getBoundingClientRect();
    const ctrlH = this.session.options.backspace === "ctrl-h";
    const network = this.keyMode === "network";
    contextMenu(r.left, r.bottom + 4, [
      { label: "표준: Delete·Home·End를 VT 코드로", icon: network ? "Circle" : "Check", action: () => this.setKeyOption("keyMode", "standard") },
      { label: "장비: Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E", icon: network ? "Check" : "Circle", action: () => this.setKeyOption("keyMode", "network") },
      "-",
      { label: "Backspace = DEL (^?)", icon: ctrlH ? "Circle" : "Check", action: () => this.setKeyOption("backspace", "del") },
      { label: "Backspace = Ctrl-H (^H) — AIX·HP-UX", icon: ctrlH ? "Check" : "Circle", action: () => this.setKeyOption("backspace", "ctrl-h") },
    ]);
  }

  /** When a Backspace went out as DEL while the session has no choice yet. */
  private delSentAt = 0;
  /** The row the cursor was on then (absolute, normal buffer). */
  private delSentRow = -1;

  /** The server echoed DEL as "^?": its erase key is ^H (AIX, HP-UX, many
   * Telnet logins). Switch this session to ^H, and take the DEL character
   * off the line, then erase what the user meant to. Only an echo counts:
   * on the command line the cursor was on, before any line break or escape
   * sequence in the output, so a "^?" that a program prints (tail -f, a
   * full-screen program) never changes the session. */
  private checkDelEcho(bytes: Uint8Array) {
    if (!this.delSentAt || Date.now() - this.delSentAt > 1500) return;
    const buf = this.term.buffer.active;
    if (buf.type !== "normal" || buf.baseY + buf.cursorY !== this.delSentRow) return;
    for (let i = 0; i + 1 < bytes.length && bytes[i] >= 0x20; i++) {
      if (bytes[i] === 0x5e && bytes[i + 1] === 0x3f) {
        this.delSentAt = 0;
        this.setKeyOption("backspace", "ctrl-h");
        this.sendInput("\x08\x08");
        toast("이 서버는 Backspace로 Ctrl-H(^H)를 씁니다. 이 세션을 ^H로 바꿨습니다 (툴바 \"키\"에서 바꿀 수 있음)", "info", 5000);
        return;
      }
    }
  }

  private setKeyOption(name: "keyMode" | "backspace", value: string) {
    this.session.options[name] = value;
    if (!this.session.id.startsWith("quick-")) patchSession(this.session.id, {}, { [name]: value }).catch(() => {});
    this.renderKeyMode();
    this.term.focus();
  }

  private handleKey(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    // Command suggestions and the candidates list (cmdAssist.ts) come first.
    if (this.assist.key(e) === false) return false;
    // Network gear (Cisco IOS & co.) does not understand ESC [ 3 ~ and prints
    // the "~"; it edits lines with Emacs-style control keys instead.
    // Delete/Home/End are sent here in both key modes, and broadcast as the key
    // itself: each receiving tab turns it into its own bytes, so a network-gear
    // tab never sends Ctrl-D (EOF) into a Linux shell, or ESC [ 3 ~ to a switch.
    const plainBackspace = e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.metaKey;
    if (plainBackspace || (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && (e.key === "Delete" || e.key === "Home" || e.key === "End"))) {
      e.preventDefault();
      if (this.state === "connected" || this.state === "connecting") {
        const bytes = this.editKeyBytes(e.key as EditKey);
        // Not chosen yet: watch whether the server takes DEL (receive()).
        if (bytes === "\x7f" && !this.session.options.backspace) {
          const buf = this.term.buffer.active;
          this.delSentAt = buf.type === "normal" ? Date.now() : 0;
          this.delSentRow = buf.baseY + buf.cursorY;
        }
        this.interruptRepeat();
        this.sendInput(bytes);
        // The line a Backspace edits; other editing keys move within it.
        this.keyLine = e.key === "Backspace" ? keyLine(this.keyLine, "\b") : null;
        this.mirrorTyped({ editKey: e.key as EditKey }, false);
        // Recorded as the key, not these bytes: replayed in another tab it
        // becomes that tab's bytes.
        this.recording?.push(String.fromCharCode(0xe100 + MARKED_KEYS.indexOf(e.key as EditKey)));
      }
      return false;
    }
    // Terminal shortcuts (keymap.ts; the user can change them).
    const act = actionFor(e, "terminal");
    if (act?.startsWith(SNIPPET_PREFIX)) {
      const snippet = state.snippets.find((x) => SNIPPET_PREFIX + x.id === act);
      if (snippet) {
        e.preventDefault();
        void this.sendSnippet(snippet);
        return false;
      }
    }
    switch (act) {
      case "term.copy":
        if (this.term.hasSelection()) writeClipboard(this.term.getSelection());
        return false;
      // Copies when there is a selection; otherwise the key goes to the remote (Ctrl+C is ^C).
      case "term.copySelection":
        if (!this.term.hasSelection()) break;
        writeClipboard(this.term.getSelection());
        this.term.clearSelection();
        return false;
      case "term.paste":
        e.preventDefault(); // otherwise WebView2 also fires a native paste into xterm
        this.paste();
        return false;
      case "term.find":
        this.toggleFind(true);
        return false;
      case "term.compare":
        e.preventDefault();
        this.compareSelection();
        return false;
      case "term.repeat":
        e.preventDefault();
        void this.toggleRepeat();
        return false;
      case "term.timer":
        e.preventDefault();
        void this.toggleTimer();
        return false;
      case "term.copyTable":
        e.preventDefault();
        this.copyTable();
        return false;
      case "term.copyOutput":
        // In vi, less … the key is the program's (no command marks there).
        if (this.term.buffer.active.type !== "normal") break;
        e.preventDefault();
        this.copyCommandOutput();
        return false;
      case "term.compareRuns":
        if (this.term.buffer.active.type !== "normal") break;
        e.preventDefault();
        this.compareRuns();
        return false;
      case "term.saveOutput":
        if (this.term.buffer.active.type !== "normal") break;
        e.preventDefault();
        void this.saveCommandOutput();
        return false;
      case "term.prevCommand":
      case "term.nextCommand":
        // In vi, tmux, mc … the key is the program's (no command marks there).
        if (this.term.buffer.active.type !== "normal") break;
        e.preventDefault();
        this.jumpCommand(act === "term.prevCommand" ? -1 : 1);
        return false;
      case "term.selectAll":
        this.term.selectAll();
        return false;
      // Without a typed command the key goes to the remote as usual (Ctrl+Space = NUL).
      case "term.aiCommand":
        e.preventDefault();
        void this.aiCommand();
        return false;
      case "term.aiExplain":
        e.preventDefault();
        void this.aiExplain();
        return false;
      case "term.aiChat":
        e.preventDefault();
        void this.toggleAiPanel();
        return false;
      case "term.complete":
        if (!this.assist.openList()) break;
        e.preventDefault();
        return false;
      case "term.zoomReset":
        this.zoomReset();
        return false;
      default: {
        // The rest do what their toolbar button does (hidden buttons do not apply here).
        const button = act && TOOLBAR_KEYS[act];
        const el = button ? this.el.querySelector<HTMLElement>(`.view-actions [data-act="${button}"]`) : null;
        if (el && !el.hidden && !(el as HTMLButtonElement).disabled) {
          e.preventDefault();
          el.click();
          return false;
        }
      }
    }
    // App-wide shortcuts (new tab, close tab, Ctrl+Tab …) go to the app, not the remote.
    if (appTakesInTerminal(e)) return false;
    return true;
  }

  private resizer = new ResizeObserver(() => this.layout());

  dispose() {
    this.disposed = true;
    this.closing = true;
    this.fullSearch?.dispose();
    this.notes.dispose();
    this.stopTimer();
    this.stopAutoReconnect();
    clearTimeout(this.notifyTimer);
    clearTimeout(this.loginTimer);
    this.stopPortWait();
    this.resizer.disconnect();
    clearInterval(this.blinkTimer);
    clearTimeout(this.resizeTimer);
    clearTimeout(this.zoomTimer);
    clearTimeout(this.ackTimer);
    cancelAnimationFrame(this.layoutFrame);
    this.stopMonitor();
    this.stopRepeat();
    allViews.delete(this);
    if (this.runtimeId) {
      api.termClose(this.runtimeId).catch(() => {});
    }
    // Release each part independently so a throw in one does not skip the
    // scarce native resources below (the xterm WebGL context, the SSH tunnel).
    for (const close of [() => this.assist.dispose(), () => this.lsColors.dispose(), () => this.aiPanel?.dispose()]) {
      try {
        close();
      } catch {
        /* keep tearing down */
      }
    }
    this.term.dispose();
    this.gateway.close();
  }
}
