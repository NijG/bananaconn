// Forgetting a server's recorded host key after it changed (a reinstalled
// server): the user confirms, ssh-keygen removes the old lines, and the next
// connection shows the new key's fingerprint for approval. Nothing is trusted
// here, so a key changed by an attacker is still caught at that approval.

import { api } from "./api";
import { userText } from "./i18n";
import { confirmDialog, errorText, esc, toast } from "./ui";

/** True when a recorded key was removed (the caller may reconnect). */
export async function forgetHostKey(host: string, port: number, username: string): Promise<boolean> {
  const ok = await confirmDialog({
    title: "저장된 호스트 키 지우기",
    icon: "ShieldAlert",
    message: `<b data-i18n-skip>${esc(host)}</b>의 저장된 호스트 키를 <code>~/.ssh/known_hosts</code>에서 지웁니다.<br><br>
      서버를 다시 설치했거나 키를 바꾼 것이 확실할 때만 지우세요. 다음에 연결할 때 새 키의 지문이 나오면, 서버 관리자가 알려 준 지문과 같은지 확인한 뒤 신뢰하세요.`,
    confirm: "키 지우기",
    danger: true,
    focusCancel: true,
  });
  if (!ok) return false;
  try {
    const removed = await api.knownHostForget(host, port, username);
    if (removed) toast("저장된 호스트 키를 지웠습니다. 다시 연결하면 새 키의 지문을 확인합니다.", "success", 5000);
    else toast(`${userText(host)}의 저장된 호스트 키를 찾지 못했습니다`, "warn");
    return removed;
  } catch (err) {
    toast(errorText(err), "error");
    return false;
  }
}
