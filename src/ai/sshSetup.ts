// Let the AI work on a PC seen through RDP or VNC: the engineer turns on its
// SSH server themselves (a script to copy; nothing is typed into the remote
// screen), then an SSH session to the same host opens, where the AI agent can
// run read-only commands.

import { api } from "../api";
import { writeClipboard } from "../clipboard";
import { icon } from "../icons";
import { newSession, type Session } from "../model";
import { state, upsertSession } from "../store";
import { gatewayOf } from "../tunnels";
import { proxyOf } from "../proxy";
import { errorText, esc, modal, toast } from "../ui";

/** Installs (if needed) and starts sshd, opens port 22 and makes PowerShell the SSH shell. */
export const OPENSSH_SCRIPT = String.raw`$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
if ($cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null
Get-Service sshd | Select-Object Name, Status, StartType`;

/** The same for a Linux desktop behind VNC (most already run sshd). */
export const LINUX_SSH_COMMAND = "sudo systemctl enable --now sshd 2>/dev/null || sudo systemctl enable --now ssh";

const PROXY_KEYS = ["proxyType", "proxyHost", "proxyPort", "proxyExclude", "proxyLocal", "proxyDns", "proxyCredentialId", "proxyTelnetCommand", "proxyLocalCommand", "proxyDiag"];

/** The SSH session for a remote desktop's PC: a saved one with the same host
 * and user, or a new one with its folder and route (gateway → jump host,
 * proxy). An RDP login is the Windows account and goes along; a VNC password
 * is not an account and does not. */
export function sshSessionFor(desktop: Session): { session: Session; existing: boolean } {
  const host = desktop.host.trim().toLowerCase();
  const found = state.sessions.find((s) => s.protocol === "ssh" && s.host.trim().toLowerCase() === host && s.username === desktop.username);
  if (found) return { session: found, existing: true };
  const s = newSession("ssh");
  // A quick connection's name is its target ("user@host:5999"): the host says more.
  s.name = `${desktop.id.startsWith("quick-") || !desktop.name ? desktop.host.trim() : desktop.name} (SSH)`;
  s.host = desktop.host.trim();
  s.username = desktop.username;
  s.folder = desktop.folder;
  if (desktop.protocol === "rdp") {
    s.credentialId = desktop.credentialId;
    s.notes = "Windows PowerShell (OpenSSH)";
  }
  const gw = gatewayOf(desktop);
  if (gw) s.options.jumpHost = `${gw.username ? `${gw.username}@` : ""}${gw.host.trim()}:${gw.port ?? 22}`;
  else for (const k of PROXY_KEYS) if (desktop.options[k] !== undefined) s.options[k] = desktop.options[k];
  return { session: s, existing: false };
}

/** The dialog: copy the script, then check port 22 and open the SSH session. */
export function openSshSetup(desktop: Session, openSession: (s: Session) => void) {
  // Through a gateway or proxy this PC cannot see the port; the session itself will tell.
  let routed = false;
  try {
    routed = !!gatewayOf(desktop) || !!proxyOf(desktop);
  } catch (err) {
    return toast(errorText(err), "error");
  }
  const vnc = desktop.protocol === "vnc";
  const m = modal({
    title: "SSH로 AI 명령 실행 준비",
    icon: "Bot",
    width: 640,
    body: `<p class="modal-text">${
      vnc
        ? "원격 화면에서는 AI가 명령을 실행하지 않습니다. 이 PC의 SSH 서버를 켜면 같은 PC에 SSH 세션을 열고, 그 세션에서 AI가 읽기 전용 명령을 직접 실행하고 결과를 분석합니다."
        : "원격 화면에서는 AI가 명령을 실행하지 않습니다. 이 PC의 OpenSSH 서버를 켜면 같은 PC에 SSH 세션을 열고, 그 세션에서 AI가 읽기 전용 PowerShell 명령을 직접 실행하고 결과를 분석합니다."
    }</p>
      ${vnc ? `<p class="modal-text"><b>Windows PC</b></p>` : ""}
      <ol class="ssh-setup-steps">
        <li>원격 화면에서 <b>관리자 권한 PowerShell</b>을 엽니다.</li>
        <li>아래 스크립트를 복사해 붙여넣고 실행합니다. (OpenSSH 서버 설치·시작, 방화벽 22번 포트 허용, 기본 셸을 PowerShell로 설정)</li>
        <li>아래 <b>연결 확인 후 SSH 세션 열기</b>를 누릅니다.</li>
      </ol>
      <div class="ssh-setup-script"><pre>${esc(OPENSSH_SCRIPT)}</pre>
        <button class="btn" data-act="copy">${icon("Copy", 14)}<span>복사</span></button></div>
      <p class="modal-text">OpenSSH 서버가 설치되어 있지 않으면 Windows Update에서 내려받습니다. 인터넷이 막힌 PC는 설치에 실패할 수 있습니다.</p>
      ${
        vnc
          ? `<p class="modal-text"><b>Linux·Unix</b></p>
      <p class="modal-text">대부분 SSH 서버가 이미 켜져 있습니다. 꺼져 있으면 원격 화면의 터미널에서 아래 명령을 실행합니다.</p>
      <div class="ssh-setup-script"><pre>${esc(LINUX_SSH_COMMAND)}</pre>
        <button class="btn" data-act="copy-linux">${icon("Copy", 14)}<span>복사</span></button></div>`
          : ""
      }
      <p class="ssh-setup-status" data-status hidden></p>`,
    footer: `<button class="btn" data-act="force" hidden>확인 없이 세션 열기</button>
      <button class="btn primary" data-act="check">${icon("Cable", 14)}<span>연결 확인 후 SSH 세션 열기</span></button>`,
  });
  const status = m.root.querySelector<HTMLElement>("[data-status]")!;
  const force = m.root.querySelector<HTMLButtonElement>('[data-act="force"]')!;
  const check = m.root.querySelector<HTMLButtonElement>('[data-act="check"]')!;
  const say = (text: string, kind: "info" | "error") => {
    status.hidden = false;
    status.textContent = text;
    status.dataset.kind = kind;
  };
  const unreachable = (detail: string) => {
    say(`${desktop.host}:22 에 연결할 수 없습니다${detail ? ` (${detail})` : ""}. 스크립트를 관리자 PowerShell에서 실행했는지, 중간 방화벽이 22번 포트를 막지 않는지 확인하세요.`, "error");
    force.hidden = false;
  };
  const go = async () => {
    try {
      const { session, existing } = sshSessionFor(desktop);
      if (!existing) await upsertSession(session);
      m.close();
      openSession(session);
      toast(existing ? `저장된 SSH 세션 '${session.name}'을 엽니다` : `SSH 세션 '${session.name}'을 추가했습니다`, "success");
    } catch (err) {
      say(errorText(err), "error");
    }
  };
  m.root.querySelector('[data-act="copy"]')!.addEventListener("click", () => {
    writeClipboard(OPENSSH_SCRIPT);
    toast("복사했습니다. 원격 화면의 관리자 PowerShell에 붙여넣으세요", "success", 3000);
  });
  m.root.querySelector('[data-act="copy-linux"]')?.addEventListener("click", () => {
    writeClipboard(LINUX_SSH_COMMAND);
    toast("복사했습니다. 원격 화면의 터미널에 붙여넣으세요", "success", 3000);
  });
  force.addEventListener("click", () => void go());
  check.addEventListener("click", async () => {
    if (routed) return go();
    check.disabled = true;
    say(`${desktop.host}:22 연결을 확인하는 중…`, "info");
    try {
      const [r] = await api.netPorts(desktop.host.trim(), [22]);
      if (r?.open) return void (await go());
      unreachable(r?.detail ?? "");
    } catch (err) {
      unreachable(errorText(err));
    } finally {
      check.disabled = false;
    }
  });
}
