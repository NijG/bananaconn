// "Find text under a server path": the text asked for, from the file tab or a
// path clicked in the terminal; the command itself is grepCommand.ts.

import { grepCommand, grepRefused } from "./grepCommand";
import { promptDialog } from "./ui";

/** The text to find, asked for; the command with "{}" where the quoted path
 * goes, or null when cancelled. Text that cannot be sent is said in the
 * dialog, which stays open with it. Its "path:line:" results open at that
 * line when Ctrl+clicked in the terminal. */
export async function askGrep(): Promise<string | null> {
  const res = await promptDialog({
    title: "내용으로 찾기",
    label: "찾을 글자 (쓴 그대로 찾음)",
    icon: "FileSearch",
    confirm: "터미널에 넣기",
    extra: `<label class="check"><input type="checkbox" name="i" /><span>대소문자 무시 (-i)</span></label>`,
    validate: (value) => (value ? grepRefused(value) : null),
  });
  const text = res?.value ?? "";
  if (!text || grepRefused(text)) return null;
  return grepCommand(text, !!res!.form.querySelector<HTMLInputElement>("input[name=i]")?.checked);
}

/** Said once the command is on the input line. */
export const GREP_PUT = "터미널에 grep 명령을 넣었습니다. Enter를 눌러 실행하고, 결과의 경로:줄을 Ctrl+클릭하면 그 줄을 엽니다";
