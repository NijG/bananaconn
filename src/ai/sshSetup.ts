// Let the AI work on a PC seen through RDP or VNC: its SSH server is turned
// on in one step, then an SSH session to the same host opens, where the AI
// agent can run read-only commands. Nothing is typed into the remote screen:
// the engineer pastes one line there (Win+R); this PC shares the setup script
// and the OpenSSH package over HTTP for a while, so a PC without internet
// (Windows 7 included) works too, and the script reports each step back.

import { api, on, type SshKitEvent } from "../api";
import { writeClipboard } from "../clipboard";
import { icon } from "../icons";
import { newSession, type Session } from "../model";
import { state, upsertSession } from "../store";
import { gatewayOf } from "../tunnels";
import { proxyOf } from "../proxy";
import { errorText, esc, modal, toast } from "../ui";
import { tr } from "../i18n";

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

const codeBox = (act: string, text = "") => `<div class="ssh-setup-script"><pre data-code="${act}">${esc(text)}</pre>
  <button class="btn" data-act="${act}">${icon("Copy", 14)}<span>복사</span></button></div>`;

/** The dialog: one line to run on the remote PC, its progress, then the SSH session. */
export function openSshSetup(desktop: Session, openSession: (s: Session) => void) {
  // Through a gateway or proxy this PC cannot see the port; the session itself will tell.
  let routed = false;
  try {
    routed = !!gatewayOf(desktop) || !!proxyOf(desktop);
  } catch (err) {
    return toast(errorText(err), "error");
  }
  const vnc = desktop.protocol === "vnc";
  let unlisten: (() => void) | null = null;
  let kitPort = 0;
  let closed = false;
  // The share is serving (sshKitStart resolved) and the flow has not finished.
  let started = false;
  let finished = false;
  const stopListening = () => {
    unlisten?.();
    unlisten = null;
  };
  const releaseShare = () => void api.sshKitStop().catch(() => {});
  const m = modal({
    title: "SSH로 AI 명령 실행 준비",
    icon: "Bot",
    width: 660,
    onClose: () => {
      closed = true;
      // The remote screen is behind this window, so the engineer must close it
      // to run the one line there. If setup is still pending, keep the share
      // serving in the background instead of stopping it (that was why the
      // remote reported "Unable to connect"): the flow finishes on its own and
      // opens the SSH session, and the share stops itself after its lifetime.
      if (finished || !started) {
        stopListening();
        releaseShare();
        return;
      }
      toast("공유 서버를 유지합니다. 원격 PC에서 복사한 한 줄을 실행하면, 설정이 끝나는 대로 SSH 세션이 자동으로 열립니다. (최대 30분)", "info", 7000);
      // Clean up if the engineer never runs the line within the share's lifetime.
      setTimeout(
        () => {
          if (!finished) {
            stopListening();
            releaseShare();
          }
        },
        31 * 60 * 1000,
      );
    },
    body: `<p class="modal-text">${
      vnc
        ? "원격 화면에서는 AI가 명령을 실행하지 않습니다. 이 PC의 SSH 서버를 켜면 같은 PC에 SSH 세션을 열고, 그 세션에서 AI가 읽기 전용 명령을 직접 실행하고 결과를 분석합니다."
        : "원격 화면에서는 AI가 명령을 실행하지 않습니다. 이 PC의 OpenSSH 서버를 켜면 같은 PC에 SSH 세션을 열고, 그 세션에서 AI가 읽기 전용 PowerShell 명령을 직접 실행하고 결과를 분석합니다."
    }</p>
      <section class="kit-card kit-card--win">
        <header class="kit-card__head">${icon("Monitor", 18)}<div><b>Windows PC</b><small>Windows 7 이상 · 인터넷이 없어도 됩니다</small></div></header>
        <div class="kit-card__body">
          <ol class="kit-steps">
            <li><span class="kit-step-no">1</span><span>원격 화면에서 <b>Win+R</b>(실행)을 열고 아래 한 줄을 붙여넣은 뒤 Enter를 누릅니다.</span></li>
            <li><span class="kit-step-no">2</span><span>관리자 확인 창에서 <b>예</b>를 누릅니다. 나머지는 자동입니다.</span></li>
          </ol>
          ${codeBox("copy-run")}
          <p class="kit-note">OpenSSH가 없으면 이 PC가 원격 PC로 보내 설치합니다. 서비스 시작, 모든 네트워크 프로필(개인·공용·도메인)에서 22번 포트 허용, 기본 셸을 PowerShell로 설정까지 한 번에 하고, 끝나면 SSH 세션을 자동으로 엽니다.</p>
          <details class="ssh-setup-more"><summary>관리자 PowerShell이 이미 열려 있다면</summary>${codeBox("copy-admin")}</details>
          <div class="kit-firewall" data-firewall hidden>
            <button type="button" class="btn btn-sm" data-act="allow" hidden>${icon("ShieldCheck", 13)}<span>이 PC 방화벽에서 허용</span></button>
            <p class="kit-firewall__note" data-note></p>
          </div>
        </div>
      </section>
      ${
        vnc
          ? `<section class="kit-card kit-card--nix">
        <header class="kit-card__head">${icon("SquareTerminal", 18)}<div><b>Linux · Unix</b><small>대부분 SSH 서버가 이미 켜져 있습니다</small></div></header>
        <div class="kit-card__body">
          <p class="kit-note">꺼져 있으면 원격 화면의 터미널에서 아래 명령을 실행합니다.</p>
          ${codeBox("copy-linux", LINUX_SSH_COMMAND)}
        </div>
      </section>`
          : ""
      }
      <section class="kit-card kit-card--log" data-progress hidden>
        <header class="kit-card__head">${icon("Activity", 18)}<div><b>진행 상황</b></div></header>
        <div class="kit-card__body">
          <ol class="ssh-setup-log" data-log></ol>
          <p class="ssh-setup-status" data-status hidden></p>
        </div>
      </section>`,
    footer: `<button class="btn" data-act="force" hidden>확인 없이 세션 열기</button>
      <button class="btn primary" data-act="check">${icon("Cable", 14)}<span>연결 확인 후 SSH 세션 열기</span></button>`,
  });
  const $ = <T extends HTMLElement>(sel: string) => m.root.querySelector<T>(sel)!;
  const status = $("[data-status]");
  const progress = $("[data-progress]");
  const force = $<HTMLButtonElement>('[data-act="force"]');
  const check = $<HTMLButtonElement>('[data-act="check"]');
  const logList = $("[data-log]");
  const lines: Record<string, string> = { "copy-linux": LINUX_SSH_COMMAND };
  const say = (text: string, kind: "info" | "error") => {
    progress.hidden = false;
    status.hidden = false;
    status.textContent = text;
    status.dataset.kind = kind;
  };
  const step = (text: string, kind = "") => {
    progress.hidden = false;
    const li = document.createElement("li");
    li.textContent = text;
    if (kind) li.dataset.kind = kind;
    logList.append(li);
    li.scrollIntoView({ block: "nearest" });
  };
  const unreachable = (detail: string) => {
    say(`${desktop.host}:22 에 연결할 수 없습니다${detail ? ` (${detail})` : ""}. 스크립트를 관리자 PowerShell에서 실행했는지, 중간 방화벽이 22번 포트를 막지 않는지 확인하세요.`, "error");
    force.hidden = false;
  };
  // Open the SSH session for this desktop. Works whether the window is still
  // open (close it, then open the session) or already closed (the flow finished
  // in the background): either way the share is released afterwards.
  const complete = async () => {
    if (finished) return;
    finished = true;
    try {
      const { session, existing } = sshSessionFor(desktop);
      if (!existing) await upsertSession(session);
      if (!closed) m.close();
      openSession(session);
      toast(existing ? `저장된 SSH 세션 '${session.name}'을 엽니다` : `SSH 세션 '${session.name}'을 추가했습니다`, "success");
    } catch (err) {
      finished = false; // let the engineer retry
      if (closed) toast(errorText(err), "error");
      else say(errorText(err), "error");
      return;
    }
    stopListening();
    releaseShare();
  };
  const checkAndGo = async () => {
    if (routed) return complete();
    if (!closed) {
      check.disabled = true;
      say(`${desktop.host}:22 연결을 확인하는 중…`, "info");
    }
    try {
      const [r] = await api.netPorts(desktop.host.trim(), [22]);
      // After the window is closed there is no "force" button to fall back to,
      // so open the session anyway: it reports any connection problem itself.
      if (r?.open || closed) return void (await complete());
      unreachable(r?.detail ?? "");
    } catch (err) {
      if (closed) await complete();
      else unreachable(errorText(err));
    } finally {
      if (!closed) check.disabled = false;
    }
  };

  // The share: the lines to run, and the remote PC's progress as it comes. The
  // listener is kept after the window closes so the background flow can finish;
  // then it reports through toasts instead of the (gone) progress list.
  void on<SshKitEvent>("ssh-kit", (e) => {
    if (closed) {
      if (e.kind === "error" || e.kind === "failed") toast(`${tr("원격 PC에서 설정하지 못했습니다")}: ${e.text}`, "error", 6000);
      else if (e.kind === "done") void checkAndGo();
      return;
    }
    if (e.kind === "remote") step(e.text);
    else if (e.kind === "log") step(e.text, "local");
    else if (e.kind === "error") (step(e.text, "error"), say(e.text, "error"), (force.hidden = false));
    else if (e.kind === "failed") (step(e.text, "error"), say(`${tr("원격 PC에서 설정하지 못했습니다")}: ${e.text}`, "error"), (force.hidden = false));
    else if (e.kind === "done") (step(tr("완료: SSH 연결을 확인합니다"), "ok"), void checkAndGo());
  }).then((u) => (closed ? u() : (unlisten = u)));
  api
    .sshKitStart(desktop.host.trim())
    .then((kit) => {
      if (closed) return void api.sshKitStop().catch(() => {});
      started = true;
      lines["copy-run"] = kit.runLine;
      lines["copy-admin"] = kit.adminLine;
      $('[data-code="copy-run"]').textContent = kit.runLine;
      $('[data-code="copy-admin"]').textContent = kit.adminLine;
      const ip = new URL(kit.url).host;
      kitPort = Number(new URL(kit.url).port) || 0;
      $("[data-firewall]").hidden = false;
      $<HTMLButtonElement>('[data-act="allow"]').hidden = !kitPort;
      $("[data-note]").textContent = `${tr("원격 PC는 이 PC({0})에서 설치 파일을 받습니다. 받지 못하면 이 PC의 Windows 방화벽에서 BananaConn을 허용하세요. OpenSSH는 처음 한 번 github.com/PowerShell/Win32-OpenSSH 에서 받아 보관합니다.").replace("{0}", ip)}${kit.routed || routed ? "" : ` ${tr("원격 PC로 가는 이 PC의 주소를 찾지 못했습니다.")}`}`;
    })
    .catch((err) => say(errorText(err), "error"));

  m.root.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (!act?.startsWith("copy-")) return;
    if (!lines[act]) return;
    writeClipboard(lines[act]);
    toast(act === "copy-linux" ? "복사했습니다. 원격 화면의 터미널에 붙여넣으세요" : act === "copy-run" ? "복사했습니다. 원격 화면에서 Win+R을 열고 붙여넣으세요" : "복사했습니다. 원격 화면의 관리자 PowerShell에 붙여넣으세요", "success", 3000);
  });
  force.addEventListener("click", () => void complete());
  // This PC's firewall often blocks the remote PC (no prompt on Windows Server
  // or a public network): one rule for that address and port, after UAC.
  const allow = $<HTMLButtonElement>('[data-act="allow"]');
  allow.addEventListener("click", async () => {
    allow.disabled = true;
    try {
      await api.sshKitAllow(desktop.host.trim(), kitPort);
      step(tr("이 PC 방화벽에서 원격 PC의 연결을 허용했습니다"), "ok");
    } catch (err) {
      say(errorText(err), "error");
    } finally {
      allow.disabled = false;
    }
  });
  check.addEventListener("click", () => void checkAndGo());
}
