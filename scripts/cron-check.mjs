// Check how the editor judges a crontab (src/cronCheck.ts): the entries
// cronie and Debian's cron take are left alone, and the first problem of the
// others is found where it is. CRLF files are given to it with "\n" breaks
// (the editor reads its document that way), so the cases are written with "\n".
//
//   node scripts/cron-check.mjs
//
// Needs Node.js 23.6 or later (it imports the TypeScript directly).

import {
  cronProblem,
  CRON_BACKWARDS,
  CRON_FEW,
  CRON_FEW_MACRO,
  CRON_FEW_MACRO_SYSTEM,
  CRON_FEW_SYSTEM,
  CRON_FIELD,
  CRON_MACRO,
  CRON_PERCENT,
  CRON_SIX,
} from "../src/cronCheck.ts";

let failed = 0;
const check = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error("FAIL", JSON.stringify(what), JSON.stringify(got), JSON.stringify(want));
  }
};
const USER = { system: false, root: false };
const ROOT = { system: false, root: true };
const SYSTEM = { system: true, root: true };

// Taken as they are (a user's crontab).
for (const text of [
  "",
  "# m h dom mon dow command\n",
  "   # indented comment\n",
  "MAILTO=root\nSHELL=/bin/bash\nPATH = /usr/bin:/bin\nCRON_TZ=Asia/Seoul\n",
  "'A' = 'b'\n\"MY VAR\" = x\n",
  "0 3 * * * /usr/local/bin/backup.sh\n",
  "*/5 * * * * /bin/true\n",
  "0,30 8-18/2 1-15 jan-jun mon-fri echo hi\n",
  "0 0 * * mon-fri/2 echo\n",
  "0 0 * * 7 echo sunday\n",
  "0 0 * * SUN echo sunday\n",
  "0 0 * * fri-sun echo weekend\n",
  "30 4 1,15 * 5 cmd\n",
  "0~30 * * * * cmd\n",
  "~ * * * * cmd\n",
  "~30 5~ * * * cmd\n",
  "@reboot /usr/bin/start\n",
  "@daily /usr/bin/rotate\n",
  "  15 2 * * *   cmd   \n",
  "\t15\t2\t*\t*\t*\tcmd\n",
  "0 1 * * * date +\\%F > /tmp/d\n",
  "0 1 * * * echo '*' starts no field\n",
  "\t\n",
]) check(text, cronProblem(text, USER), null);

// cronie's "-" (not logged): root's table and system ones only.
check("dash root", cronProblem("-0 1 * * * quiet\n", ROOT), null);
check("dash system", cronProblem("-0 1 * * * root quiet\n", SYSTEM), null);
check("dash user", cronProblem("-0 1 * * * quiet\n", USER), { at: 0, message: CRON_FIELD[0] });

// A system crontab: a user before the command.
check("system ok", cronProblem("17 * * * * root cd / && run-parts --report /etc/cron.hourly\n", SYSTEM), null);
check("system @", cronProblem("@reboot root /usr/bin/start\n", SYSTEM), null);
check("system no user", cronProblem("17 * * * * run-parts\n", SYSTEM), { at: 0, message: CRON_FEW_SYSTEM });
check("system macro no user", cronProblem("@reboot /usr/bin/start\n", SYSTEM), { at: 0, message: CRON_FEW_MACRO_SYSTEM });

// Problems, the first one, where it is.
check("minute 60", cronProblem("60 * * * * cmd\n", USER), { at: 0, message: CRON_FIELD[0] });
check("hour 24", cronProblem("0 24 * * * cmd\n", USER), { at: 2, message: CRON_FIELD[1] });
check("day 0", cronProblem("0 0 0 * * cmd\n", USER), { at: 4, message: CRON_FIELD[2] });
check("month 13", cronProblem("0 0 1 13 * cmd\n", USER), { at: 6, message: CRON_FIELD[3] });
check("weekday 8", cronProblem("0 0 * * 8 cmd\n", USER), { at: 8, message: CRON_FIELD[4] });
check("quartz ?", cronProblem("0 0 ? * MON cmd\n", USER), { at: 4, message: CRON_FIELD[2] });
check("quartz L", cronProblem("0 0 L * * cmd\n", USER), { at: 4, message: CRON_FIELD[2] });
check("step 0", cronProblem("*/0 * * * * cmd\n", USER), { at: 0, message: CRON_FIELD[0] });
check("single value step", cronProblem("5/10 * * * * cmd\n", USER), { at: 0, message: CRON_FIELD[0] });
check("name step", cronProblem("0 0 * jan/2 * cmd\n", USER), { at: 6, message: CRON_FIELD[3] });
check("random step", cronProblem("1~30/5 * * * * cmd\n", USER), { at: 0, message: CRON_FIELD[0] });
check("range end", cronProblem("0 8-25 * * * cmd\n", USER), { at: 2, message: CRON_FIELD[1] });
check("backwards", cronProblem("30-10 * * * * cmd\n", USER), { at: 0, message: CRON_BACKWARDS });
check("backwards names", cronProblem("0 0 * jun-jan * cmd\n", USER), { at: 6, message: CRON_BACKWARDS });
check("month name in day", cronProblem("0 0 jan * * cmd\n", USER), { at: 4, message: CRON_FIELD[2] });
check("empty list item", cronProblem("0,,5 * * * * cmd\n", USER), { at: 0, message: CRON_FIELD[0] });
check("no command", cronProblem("0 3 * * *\n", USER), { at: 0, message: CRON_FEW });
check("four fields", cronProblem("0 3 * * \n", USER), { at: 0, message: CRON_FEW });
check("macro no command", cronProblem("@daily\n", USER), { at: 0, message: CRON_FEW_MACRO });
check("macro", cronProblem("@everyday cmd\n", USER), { at: 0, message: CRON_MACRO });
check("macro case", cronProblem("@Daily cmd\n", USER), { at: 0, message: CRON_MACRO });
check("six fields", cronProblem("0 1 * * * * cmd\n", USER), { at: 10, message: CRON_SIX });
check("six fields system", cronProblem("0 1 * * * * root cmd\n", SYSTEM), { at: 10, message: CRON_SIX });
check("percent", cronProblem("0 1 * * * date +%F\n", USER), { at: 16, message: CRON_PERCENT });
check("percent after user", cronProblem("0 1 * * * root echo 100%\n", SYSTEM), { at: 23, message: CRON_PERCENT });
check("second line", cronProblem("MAILTO=a\n0 1 * * * ok\n99 * * * * x\n", USER), { at: 22, message: CRON_FIELD[0] });

if (failed) {
  console.error(`${failed} crontab case(s) failed`);
  process.exit(1);
}
console.log("crontab checks as expected");
