// Risky commands in snippets and macros. A rule is a regular expression
// matched against each line sent (case-insensitive): "block" never sends it
// (time and NTP changes, which break logins, logs and certificates across
// systems), "warn" asks first and, when sent, turns the tab's log on and
// records it in risky-commands.log. The list is edited in Settings.

import { state } from "./store";

export interface RiskRule {
  action: "block" | "warn";
  /** Regular expression (case-insensitive), tested per line. */
  pattern: string;
  /** What the command does, shown in the warning. */
  note: string;
}

const block = (pattern: string, note: string): RiskRule => ({ action: "block", pattern, note });
const warn = (pattern: string, note: string): RiskRule => ({ action: "warn", pattern, note });
const SUDO = String.raw`^\s*(sudo\s+)?`;

export const DEFAULT_RISK_RULES: RiskRule[] = [
  // Time and NTP: never from a snippet.
  block(SUDO + String.raw`timedatectl(\s+-\S+)*\s+(set-ntp|set-time|set-timezone|set-local-rtc)\b`, "시간·NTP 설정 변경"),
  block(SUDO + String.raw`date(\s+\S+)*\s+(-s|--set)(=|\s|$)`, "시스템 시간 변경"),
  block(SUDO + String.raw`date\s+\d{4,}`, "시스템 시간 변경"),
  block(SUDO + String.raw`ntpdate\b(?!.*\s-[a-zA-Z]*[qd])`, "NTP로 시간 즉시 변경"),
  block(SUDO + String.raw`sntp\b.*\s-[a-zA-Z]*[sS]\b`, "NTP로 시간 즉시 변경"),
  block(SUDO + String.raw`rdate\b(?!(\s+-p)+\s+\S+\s*$)`, "NTP로 시간 즉시 변경"),
  block(SUDO + String.raw`chronyc(\s+-\S+)*\s+(makestep|settime|add|delete|burst|offline|online)\b`, "chrony 시간 조정"),
  block(SUDO + String.raw`hwclock(\s+\S+)*\s+(--set|-w|-s|--systohc|--hctosys)(=|\s|$)`, "하드웨어 시계 변경"),
  block(SUDO + String.raw`(systemctl|service)\s+(stop|disable|mask|restart)\s+(ntpd?|chronyd?|systemd-timesyncd|xntpd)\b`, "시간 동기화 서비스 중지·재시작"),
  block(String.raw`^\s*(stopsrc|startsrc)\s+-s\s+xntpd\b`, "AIX 시간 동기화 서비스 변경"),
  block(String.raw`^\s*setclock\b`, "시스템 시계 변경 (AIX·HP-UX)"),
  block(String.raw`^\s*(no\s+)?ntp\s+(server|peer|master|source|update-calendar|authenticate|trusted-key)\b`, "장비 NTP 설정 변경"),
  block(String.raw`^\s*clock\s+(set|timezone|summer-time|update-calendar|datetime)\b`, "장비 시계 변경"),
  block(String.raw`^\s*(undo\s+)?ntp-service\b`, "장비 NTP 설정 변경 (Huawei)"),
  block(String.raw`^\s*set\s+(date|system\s+ntp)\b`, "장비 시간·NTP 설정 변경 (Juniper)"),
  block(String.raw`^\s*(execute\s+(time|date)|config\s+system\s+ntp)\b`, "장비 시간·NTP 설정 변경 (FortiGate)"),
  block(String.raw`^\s*w32tm\s+/(config|resync|register|unregister)\b`, "Windows 시간 설정 변경"),
  block(String.raw`^\s*Set-Date\b`, "Windows 시간 변경"),
  // Destructive or disruptive: ask, then log.
  warn(String.raw`\brm\s+-[a-z]*[rf][a-z]*\b`, "파일 강제·재귀 삭제"),
  warn(SUDO + String.raw`(reboot|shutdown|halt|poweroff|init\s+[06])\b`, "재부팅·종료 (장비에서는 포트 끄기)"),
  warn(String.raw`\b(mkfs(\.\w+)?|fdisk|parted|wipefs)\b`, "디스크 포맷·파티션 변경"),
  warn(String.raw`\bdd\s+.*\bof=`, "디스크에 직접 쓰기"),
  warn(String.raw`>\s*/dev/(sd|nvme|hd|xvd|vd)`, "장치 덮어쓰기"),
  warn(String.raw`\bkill(all)?\s+-(9|KILL)\b`, "프로세스 강제 종료"),
  warn(String.raw`\b(chmod\s+-R\s+0?777|chown\s+-R)\b`, "권한·소유자 일괄 변경"),
  warn(SUDO + String.raw`systemctl\s+(stop|disable|mask)\b`, "서비스 중지"),
  warn(String.raw`^\s*(rmlv|rmvg|reducevg|rmdev|lvremove|vgremove)\b`, "볼륨·장치 제거 (AIX·HP-UX)"),
  warn(String.raw`^\s*reload\b`, "장비 재시작"),
  warn(String.raw`^\s*(write\s+erase|erase\s+(startup-config|nvram:|flash:))`, "장비 설정 삭제"),
  warn(String.raw`^\s*(delete|format)\s+(flash|bootflash|disk|nvram|usb)`, "장비 저장소 삭제·포맷"),
  warn(String.raw`^\s*copy\s+\S+\s+(running-config|startup-config)\b`, "장비 설정 덮어쓰기"),
  warn(String.raw`^\s*(configure(\s+terminal)?|conf\s+t)\s*$`, "장비 설정 모드 진입"),
  warn(String.raw`^\s*execute\s+(reboot|shutdown|factoryreset|formatlogdisk)\b`, "장비 재시작·초기화 (FortiGate)"),
  warn(String.raw`^\s*request\s+system\s+(reboot|halt|power-off|zeroize)\b`, "장비 재시작·초기화 (Juniper)"),
  warn(String.raw`^\s*(Restart-Computer|Stop-Computer|shutdown\s+/[rsp])\b`, "Windows 재시작·종료"),
  warn(String.raw`^\s*(drop|truncate)\s+(table|database)\b`, "데이터베이스 삭제"),
];

export function riskRules(): RiskRule[] {
  return state.settings.riskRules ?? DEFAULT_RISK_RULES;
}

/** A rule that cannot be compiled is reported in Settings and never matches. */
export function compile(rule: RiskRule): RegExp | null {
  try {
    return new RegExp(rule.pattern, "i");
  } catch {
    return null;
  }
}

export interface RiskHit {
  rule: RiskRule;
  line: string;
}

/** Shown for a macro whose keys cannot be read back as a command line. */
export const UNREADABLE_MACRO: RiskRule = warn("", "Tab 자동 완성이나 명령 기록(↑↓)을 써서 실제로 보낼 명령을 확인할 수 없는 매크로");

/** Lines as the device receives them. Macros hold raw keys: escape sequences
 * (arrows, function keys) are dropped and Backspace / Ctrl-U are applied, and
 * a shell line ending in "\" continues on the next one. `unreadable` is set
 * when Tab completion or history keys decide what actually runs. */
function sentLines(text: string): { lines: string[]; unreadable: boolean } {
  // Keys that move the cursor or pull up history decide what the line
  // finally is: Tab, arrows, Home/End/Delete, Ctrl-A/B/D/E/F/N/P/R/W.
  const unreadable = /\t|\x1b\[[ABCDHF]|\x1bO[ABCDHF]|\x1b\[[1-8]~|[\x01\x02\x04\x05\x06\x0e\x10\x12\x17]/.test(text);
  const lines: string[] = [];
  let pending = "";
  for (const raw of text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO.|\x1b./g, "").split(/\r\n|\r|\n/)) {
    let line = "";
    for (const ch of raw) {
      if (ch === "\x7f" || ch === "\b") line = line.slice(0, -1);
      else if (ch === "\x15") line = "";
      else if (ch === "\t") line += " ";
      else if (ch >= " ") line += ch;
    }
    if (line.endsWith("\\")) {
      pending += line.slice(0, -1);
      continue;
    }
    lines.push(pending + line);
    pending = "";
  }
  if (pending) lines.push(pending);
  return { lines, unreadable };
}

// Wrappers in front of the command that actually runs: sudo/doas and their
// options, env and variable assignments, sh -c, nohup, time, nice, timeout ...
const WRAPPER = new RegExp(
  [
    String.raw`(?:sudo|doas)(?:\s+(?:-[ughpCrtUDT]\s*\S+|--[\w-]+(?:=\S+)?|-[A-Za-z]+))*\s+`,
    String.raw`env(?:\s+-\S+)*\s+`,
    String.raw`[A-Za-z_]\w*=\S*\s+`,
    String.raw`(?:ba|da|k|z)?sh\s+(?:-\w+\s+)*-\w*c\w*\s+`,
    String.raw`su(?:\s+-\w*)*(?:\s+[\w.-]+)?\s+-c\s+`,
    // Shell keywords and wrappers in front of a command: if/for bodies, eval.
    String.raw`(?:then|do|else|elif|eval|pkexec|xargs|watch|--)\s+`,
    String.raw`(?:nohup|time|exec|command|builtin|stdbuf(?:\s+-\S+)*|nice(?:\s+-n)?(?:\s+-?\d+)?|timeout(?:\s+-\S+)*\s+\S+)\s+`,
    String.raw`["'(]+`,
  ]
    .map((p) => `(?:${p})`)
    .join("|"),
  "iy",
);

/** Each command of a shell line, as it will run: split at ; && || | & ` $(
 * and stripped of wrappers, its directory and ".exe". */
function commands(line: string): string[] {
  return line
    .split(/;|&&|\|\||\||&|`|\$\(|\)/)
    .map((part) => {
      let cmd = part.trim();
      for (let i = 0; i < 8; i++) {
        WRAPPER.lastIndex = 0;
        const m = WRAPPER.exec(cmd);
        if (!m || !m[0]) break;
        cmd = cmd.slice(m[0].length).trimStart();
      }
      // Only an absolute path is a directory to drop ("./configure" stays).
      if (/^([A-Za-z]:)?[\\/]/.test(cmd)) cmd = cmd.replace(/^\S*[\\/](?=[^\\/\s]+(\s|$))/, "");
      return cmd.replace(/^([^\s.]+)\.exe\b/i, "$1");
    })
    .filter(Boolean);
}

/** The risky lines of what a snippet or macro sends; a block rule outranks a
 * warning. Each line is tested as written and as every command it runs. */
export function findRisks(text: string): RiskHit[] {
  const rules = riskRules().map((rule) => ({ rule, re: compile(rule) }));
  const { lines, unreadable } = sentLines(text);
  const hits: RiskHit[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    // Commands inside quotes run too: su -c '...', bash -lc "...", eval "...",
    // echo "..." | sh.
    const quoted = [...line.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]).filter((q) => q.trim());
    const forms = [line, ...commands(line), ...quoted.flatMap((q) => [q, ...commands(q)])];
    const matches = (r: (typeof rules)[number]) => !!r.re && forms.some((f) => r.re!.test(f));
    const hit = rules.find((r) => r.rule.action === "block" && matches(r)) ?? rules.find(matches);
    if (hit) hits.push({ rule: hit.rule, line: line.trim() });
  }
  if (unreadable && !hits.some((h) => h.rule.action === "block"))
    hits.push({ rule: UNREADABLE_MACRO, line: lines.filter((l) => l.trim()).join(" ⏎ ").slice(0, 200) });
  return hits;
}
