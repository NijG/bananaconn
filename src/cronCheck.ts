// Where a crontab has an entry cron would refuse or run otherwise than it
// reads: the editor marks the first one, as it does a .json file's error.
// Judged as cronie and Debian's cron (Vixie cron) read it (their entry.c,
// env.c and crontab(5)); only what both refuse or never run is marked (a
// value out of its field's range, a field that is no cron syntax, a backwards
// range, too few fields, a sixth time field, an "@" word in another case),
// and a "%" in a command, which they and POSIX crontab turn into a newline
// (the rest is the command's input; busybox crond alone leaves it). Pure.

/** What is wrong, as the editor says it (Korean, translated where shown). */
export const CRON_FEW = "시간 필드 5개 뒤에 명령이 있어야 합니다";
export const CRON_FEW_SYSTEM = "시간 필드 5개 뒤에 사용자와 명령이 있어야 합니다";
export const CRON_FEW_MACRO = "@ 예약어 뒤에 명령이 있어야 합니다";
export const CRON_FEW_MACRO_SYSTEM = "@ 예약어 뒤에 사용자와 명령이 있어야 합니다";
export const CRON_SIX = "시간 필드가 6개 이상입니다. cron은 5개(분 시 일 월 요일)만 쓰며 초 필드가 없습니다";
export const CRON_BACKWARDS = "범위의 시작이 끝보다 큽니다 (cronie는 이 줄을 거부하고, 다른 cron은 실행하지 않습니다)";
export const CRON_MACRO = "알 수 없는 @ 예약어입니다 (@reboot, @daily, @hourly 등)";
export const CRON_PERCENT = "명령의 %는 cron에서 줄바꿈으로 바뀝니다. 글자 그대로 쓰려면 \\%로 쓰세요";
export const CRON_FIELD = [
  "분 필드에 쓸 수 없는 값입니다 (0–59)",
  "시 필드에 쓸 수 없는 값입니다 (0–23)",
  "일 필드에 쓸 수 없는 값입니다 (1–31)",
  "월 필드에 쓸 수 없는 값입니다 (1–12, jan–dec)",
  "요일 필드에 쓸 수 없는 값입니다 (0–7, sun–sat)",
] as const;

const MACROS = new Set(["reboot", "yearly", "annually", "monthly", "weekly", "daily", "midnight", "hourly"]);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** Each field's [lowest, highest] and its names (month 1 = "jan", weekday 0 = "sun"). */
const FIELDS: [number, number, string[] | null, number][] = [
  [0, 59, null, 0],
  [0, 23, null, 0],
  [1, 31, null, 0],
  [1, 12, MONTHS, 1],
  [0, 7, DAYS, 0],
];

/** One value of field `f` as its number: a number in its range, or one
 * of its names (any case); null when it is neither. */
function value(text: string, f: number): number | null {
  const [lo, hi, names, first] = FIELDS[f];
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n >= lo && n <= hi ? n : null;
  }
  const i = names?.indexOf(text.toLowerCase()) ?? -1;
  return i < 0 ? null : i + first;
}

/** Field `f` as cron reads it: a comma list of "*" or a range ("1-5"), each
 * with an optional "/step", or a single value; cronie's random "~" ("1~5",
 * "~30", "5~", "~") without a step. "ok", "bad", or "backwards" for a range
 * whose start is past its end (cronie refuses it, Vixie cron never runs it;
 * a weekday range ending in Sunday as 0, "fri-sun", cronie reads as 5-7). */
function field(text: string, f: number): "ok" | "bad" | "backwards" {
  let backwards = false;
  const ok = text.split(",").every((item) => {
    const m = /^([^/]*)(?:\/(\d+))?$/.exec(item);
    if (!m) return false;
    const [, base, step] = m;
    if (step !== undefined && Number(step) < 1) return false;
    if (base === "*") return true;
    const range = /^([^-~]*)([-~])([^-~]*)$/.exec(base);
    // A single value takes no step ("5/10": cronie and Vixie cron refuse it).
    if (!range) return step === undefined && value(base, f) !== null;
    const [, from, sep, to] = range;
    if (sep === "~") return step === undefined && (from === "" || value(from, f) !== null) && (to === "" || value(to, f) !== null);
    const [a, b] = [value(from, f), value(to, f)];
    if (a === null || b === null) return false;
    if (a > b && !(f === 4 && b === 0)) backwards = true;
    return true;
  });
  return !ok ? "bad" : backwards ? "backwards" : "ok";
}

/** Whose crontab it is, as cron reads it: a system one (/etc/crontab,
 * /etc/cron.d) has a user before each command; root's (or a system one) may
 * start an entry with "-" (cronie: not logged; other users' are refused). */
export type CronTable = { system: boolean; root: boolean };

/** The first problem in a crontab, with where it is (a character offset in
 * `text`, "\n" line breaks) and what it is; null when there is none. */
export function cronProblem(text: string, table: CronTable): { at: number; message: string } | null {
  let start = 0;
  for (const line of text.split("\n")) {
    const found = lineProblem(line, table);
    if (found) return { at: start + found.at, message: found.message };
    start += line.length + 1;
  }
  return null;
}

function lineProblem(line: string, table: CronTable): { at: number; message: string } | null {
  // The line's words, each with where it starts.
  const words = [...line.matchAll(/[^ \t]+/g)].map((m) => ({ text: m[0], at: m.index! }));
  if (!words.length || words[0].text.startsWith("#")) return null;
  // A variable ("MAILTO=root", "PATH = /bin", "'MY VAR' = x"): cron reads a
  // line as one first; no field of an entry holds "=".
  const head = line.trimStart();
  if (/^[^ \t=]*[ \t]*=/.test(head) || /^(['"])[^'"]*\1[ \t]*=/.test(head)) return null;
  // cronie's "-" before an entry of root's or a system table: not logged.
  if ((table.system || table.root) && words[0].text.length > 1 && words[0].text.startsWith("-"))
    words[0] = { text: words[0].text.slice(1), at: words[0].at + 1 };
  const macro = words[0].text.startsWith("@");
  if (macro) {
    // Compared as written: "@Daily" is no cron's.
    if (!MACROS.has(words[0].text.slice(1))) return { at: words[0].at, message: CRON_MACRO };
  } else {
    for (let f = 0; f < 5 && f < words.length; f++) {
      const judged = field(words[f].text, f);
      if (judged !== "ok") return { at: words[f].at, message: judged === "bad" ? CRON_FIELD[f] : CRON_BACKWARDS };
    }
  }
  const fields = macro ? 1 : 5;
  const need = fields + (table.system ? 2 : 1);
  if (words.length < need) return { at: words[0].at, message: macro ? (table.system ? CRON_FEW_MACRO_SYSTEM : CRON_FEW_MACRO) : table.system ? CRON_FEW_SYSTEM : CRON_FEW };
  // A sixth time field (a seconds field, as other schedulers have): read as
  // the user or command, which cron refuses when it starts with "*".
  if (!macro && words[fields].text.startsWith("*")) return { at: words[fields].at, message: CRON_SIX };
  // The command: from its first word to the end of the line.
  const command = words[need - 1].at;
  for (let i = command; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "%") return { at: i, message: CRON_PERCENT };
  }
  return null;
}
