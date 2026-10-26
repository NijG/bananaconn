// In-memory stand-in for the Rust backend, used only when the UI runs in a
// plain browser (design preview). Never loaded inside the Tauri app.

import { mockEmit, type Credential, type FileEntry } from "./api";

const LS = "bx.mock.sessions";
let creds: Credential[] = [
  { id: "c1", name: "운영 서버 키", username: "deploy", kind: "key", keyPath: "C:\\Users\\me\\.ssh\\id_ed25519", hasSecret: false },
  { id: "c2", name: "라우터 관리자", username: "admin", kind: "password", keyPath: null, hasSecret: true },
];

const now = Math.floor(Date.now() / 1000);
function fake(dir: string, names: [string, boolean, number][]): FileEntry[] {
  return names.map(([name, isDir, size], i) => ({
    name,
    path: dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + (dir.includes("\\") ? "\\" : "/") + name,
    isDir,
    isLink: false,
    size,
    modified: now - i * 86400,
    perm: isDir ? "drwxr-xr-x" : "-rw-r--r--",
  }));
}

const utf8 = (s: string) => new TextEncoder().encode(s);

// The preview's pretend shell edits its line the way a real one does:
// Backspace (DEL or ^H) erases a character, Ctrl-U the line, Enter starts a
// new prompt; cursor and function keys are ignored.
const mockLines = new Map<string, string>();
function mockLine(id: string, data: string): string {
  let line = mockLines.get(id) ?? "";
  let out = "";
  for (const ch of data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO.|\x1b./g, "")) {
    if (ch === "\r") {
      line = "";
      out += "\r\n$ ";
    } else if (ch === "\x7f" || ch === "\b") {
      if (!line) continue;
      // A wide character (Hangul) takes two cells.
      const last = [...line].pop()!;
      line = line.slice(0, -last.length);
      out += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(last) ? "\b\b  \b\b" : "\b \b";
    } else if (ch === "\x15") {
      out += "\b \b".repeat([...line].length);
      line = "";
    } else if (ch === "\x03") {
      line = "";
      out += "^C\r\n$ ";
    } else if (ch >= " ") {
      line += ch;
      out += ch;
    }
  }
  mockLines.set(id, line);
  return out;
}

// MobaXterm.ini sample in the bookmark format observed in MobaXterm 26.5.
const MOBA_TAIL = "%%-1%-1%%%22%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%-1%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1#0# #-1";
export const MOBA_SAMPLE = [
  "[Misc]",
  "Theme=0",
  "[Bookmarks]",
  "SubRep=",
  "ImgNum=42",
  `웹서버 01= #109#0%10.0.0.21%22%deploy${MOBA_TAIL}`,
  `윈도우 PC= #91#4%10.0.0.30%3389%CORP__BACKSLASH__kim${MOBA_TAIL}`,
  "[Bookmarks_1]",
  "SubRep=운영\\DB",
  "ImgNum=41",
  `DB 서버__PTVIRG__1차= #109#0%db1.corp.local%2222%dba${MOBA_TAIL}`,
  `라우터= #98#1%192.168.0.1%23%admin${MOBA_TAIL}`,
  `NAS FTP= #130#6%nas.local%21%%${MOBA_TAIL}`,
  `파일 서버= #140#7%files.corp.local%22%backup${MOBA_TAIL}`,
  `VNC 데모= #128#5%10.0.0.50%5901%${MOBA_TAIL}`,
  `옛날 장비= #100#2%10.9.9.9%513%root${MOBA_TAIL}`,
  `사내 위키= #313#11%https://wiki%${MOBA_TAIL}`,
].join("\r\n");
let ftpd: any = null;
const monitors = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- RDP preview: fake connection stages and a synthetic desktop ----------------

let rdpCertAnswer: ((ok: boolean) => void) | null = null;

function rdpFrame(x: number, y: number, w: number, h: number, dw: number, dh: number, paint: (px: number, py: number) => [number, number, number]) {
  const buf = new ArrayBuffer(12 + w * h * 4);
  const v = new DataView(buf);
  [x, y, w, h, dw, dh].forEach((n, i) => v.setUint16(i * 2, n, true));
  const px = new Uint8ClampedArray(buf, 12);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const [r, g, b] = paint(x + i, y + j);
      const o = (j * w + i) * 4;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = 255;
    }
  return buf;
}

function fakeDesktop(dw: number, dh: number) {
  const win = { x: Math.round(dw * 0.18), y: Math.round(dh * 0.14), w: Math.round(dw * 0.5), h: Math.round(dh * 0.55) };
  return rdpFrame(0, 0, dw, dh, dw, dh, (x, y) => {
    if (y >= dh - 44) return [24, 28, 38];
    const inWin = x >= win.x && x < win.x + win.w && y >= win.y && y < win.y + win.h;
    if (inWin) return y < win.y + 32 ? [243, 243, 243] : [252, 252, 252];
    const t = (x / dw + y / dh) / 2;
    return [Math.round(10 + 30 * t), Math.round(60 + 70 * t), Math.round(140 + 90 * t)];
  });
}

export async function mockRdpOpen(
  req: { width: number; height: number; password?: string | null; credentialId: string | null },
  onEvent: (e: any) => void,
  onFrame: (b: ArrayBuffer) => void,
) {
  if (!req.password && !req.credentialId) throw "NEED_CREDENTIALS";
  (async () => {
    for (const stage of ["tcp", "tls"]) {
      onEvent({ type: "status", stage });
      await sleep(350);
    }
    if (!sessionStorage.getItem("bx.mock.rdpTrusted")) {
      onEvent({ type: "cert", fingerprint: "SHA256:/SvjRsnlwddskovy5iTE+O7Md+PJC6QmWfoi/H3aeeo", previous: null });
      const ok = await new Promise<boolean>((r) => (rdpCertAnswer = r));
      if (!ok) return onEvent({ type: "error", kind: "cancelled", message: "서버 인증서를 신뢰하지 않아 연결을 취소했습니다" });
      sessionStorage.setItem("bx.mock.rdpTrusted", "1");
    }
    onEvent({ type: "status", stage: "auth" });
    await sleep(350);
    const w = req.width & ~1;
    const h = req.height;
    onEvent({ type: "connected", width: w, height: h });
    onFrame(fakeDesktop(w, h));
  })();
}

export async function mockInvoke(cmd: string, a: Record<string, any>): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 60));
  switch (cmd) {
    case "sessions_load":
      return JSON.parse(localStorage.getItem(LS) ?? "[]");
    case "sessions_save":
      localStorage.setItem(LS, JSON.stringify(a.sessions));
      return;
    case "term_open": {
      const { id, host, username, protocol } = a.req;
      setTimeout(() => {
        const lines = [
          `\x1b[90m${protocol.toUpperCase()} ${username || "user"}@${host} (미리보기 모드)\x1b[0m\r\n`,
          `Welcome to Ubuntu 24.04 LTS (GNU/Linux 6.8.0 x86_64)\r\n\r\n`,
          `\x1b[1;32m${username || "user"}@${host}\x1b[0m:\x1b[1;34m~\x1b[0m$ `,
        ];
        lines.forEach((l, i) => setTimeout(() => mockEmit("term-output", [id, utf8(l)]), i * 120));
      }, 200);
      return;
    }
    case "term_write":
      mockEmit("term-output", [a.id, utf8(mockLine(a.id, a.data))]);
      return;
    case "term_ack":
      return;
    case "windows_build":
      return 26100;
    case "risk_audit":
      return "C:\Users\me\Documents\BananaConn\logs\risky-commands.log";
    case "os_ui_language":
      return "ko";
    case "tftp_transfer":
      for (let i = 1; i <= 5; i++) setTimeout(() => mockEmit("tftp-progress", { id: a.req.id, done: i * 20000, total: 100000 }), i * 150);
      await new Promise((r) => setTimeout(r, 800));
      return { bytes: 100000, blockSize: a.req.blockSize, millis: 800 };
    case "tftp_cancel":
      return;
    case "monitor_pause":
    case "rdp_visible":
      return;
    case "term_set_logging":
    {
      if (!a.options) return null;
      // Mirror the backend: fill the time tokens; relative paths go to the logs folder.
      const p = String(a.options.path).replace(/%([YMDhmst%])/g, (_m: string, k: string) => (k === "%" ? "%" : k === "Y" ? "2026" : "01"));
      return /^[a-z]:|^\\\\/i.test(p) ? p : `C:\\Users\\me\\Documents\\BananaConn\\logs\\${p}`;
    }
    case "logs_folder":
      return "C:\\Users\\me\\Documents\\BananaConn\\logs";
    case "remote_connect":
      if (a.req.protocol === "sftp" && !a.req.trustedFingerprint && !sessionStorage.getItem("bx.mock.trusted")) {
        sessionStorage.setItem("bx.mock.trusted", "1");
        throw "HOSTKEY_UNKNOWN::SHA256:d7Te2DHmvBNSWJNBWik2KbDTjmWtYHe2bvXTMM9lVg4";
      }
      return { home: "/home/" + (a.req.username || "user"), banner: null };
    case "remote_list":
      return fake(a.path, [
        ["logs", true, 0],
        ["releases", true, 0],
        ["app.tar.gz", false, 48_213_004],
        ["config.yml", false, 2_311],
        ["README.md", false, 9_120],
      ]);
    case "local_home":
      return "C:\\Users\\me";
    case "local_list":
      if (!a.path) return fake("", [["C:\\", true, 0], ["E:\\", true, 0]]).map((e) => ({ ...e, path: e.name }));
      return fake(a.path, [
        ["Desktop", true, 0],
        ["Documents", true, 0],
        ["Downloads", true, 0],
        ["notes.txt", false, 1_204],
        ["backup.zip", false, 734_003_200],
      ]);
    case "transfer": {
      const total = 50_000_000;
      for (let done = 0; done <= total; done += 5_000_000) {
        await new Promise((r) => setTimeout(r, 120));
        mockEmit("transfer-progress", { transferId: a.req.transferId, file: a.req.remotePath, done, total, filesDone: 0 });
      }
      return { filesDone: 1, skipped: 0 };
    }
    case "vault_list":
      return creds;
    case "vault_save": {
      const c = { ...a.cred, hasSecret: a.secret ? true : a.cred.hasSecret };
      creds = creds.filter((x) => x.id !== c.id).concat(c);
      return c;
    }
    case "vault_delete":
      creds = creds.filter((x) => x.id !== a.id);
      return;
    case "vault_default_key_dir":
      return "C:\\Users\\me\\.ssh";
    case "vault_generate_key":
    case "vault_public_key":
      return "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewOnlyKeyMaterial bananaconn";
    case "vault_reveal":
      return null;
    case "read_text_file":
      // The preview picker returns a fake path named after the dialog title.
      if (/JSON/.test(a.path))
        return JSON.stringify({
          format: "bananaconn-sessions",
          sessions: [
            null,
            { protocol: "ssh", name: "빌드 서버", host: "build.lan", port: 99999, options: { jumpHost: "bastion.example.com", agentForward: true } },
            { protocol: "ftps", name: "자체 서명 NAS", host: "nas.lan", options: { allowInvalidCert: true } },
            { protocol: "telnet", name: "스위치", host: "10.0.0.2" },
          ],
        });
      return MOBA_SAMPLE;
    case "rdp_cert":
      rdpCertAnswer?.(a.accept);
      rdpCertAnswer = null;
      return;
    case "net_ping":
      return `Ping ${a.host} 32바이트 데이터 사용:
${a.host}의 응답: 바이트=32 시간<1ms TTL=128

${a.host}에 대한 Ping 통계:
    패킷: 보냄 = ${a.count}, 받음 = ${a.count}, 손실 = 0 (0% 손실)`;
    case "net_ports":
      return a.ports.map((p: number) => ({ port: p, open: p === 22 || p === 80, ms: p === 22 || p === 80 ? 3 : null, detail: p === 22 || p === 80 ? "열림" : "닫힘 (연결 거부)" }));
    case "net_dns":
      return { addresses: ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"], ms: 12 };
    case "file_server_status":
      return [];
    case "file_server_active":
      return 0;
    case "file_server_start": {
      const c = a.config;
      if (!c.root) throw "공유할 폴더가 없습니다. 폴더를 다시 선택하세요.";
      setTimeout(() => mockEmit("file-server-event", { server: c.kind, kind: "started", user: "", detail: `${c.kind}://127.0.0.1:${c.port}` }), 50);
      return { kind: c.kind, root: c.root, port: c.port, lan: c.lan, readOnly: c.kind === "http" || c.readOnly, auth: !!c.username, addresses: [`${c.kind}://127.0.0.1:${c.port}`] };
    }
    case "serial_ports":
      return [{ name: "COM3", description: "USB Serial Port · Prolific" }];
    case "monitor_start": {
      clearInterval(monitors.get(a.req.id));
      let t = 0;
      const host = String(a.req.host ?? "");
      const device = /fw/i.test(host)
        ? { kind: "fortigate", vendor: "Fortinet", label: "FortiGate-100F v7.2.5", name: "FW-HQ", network: true, backup: true }
        : /sw/i.test(host) || a.req.protocol === "telnet"
          ? { kind: "cisco-iosxe", vendor: "Cisco", label: "IOS-XE 17.06.04", name: "SW-CORE-01", network: true, backup: true }
          : { kind: "linux", vendor: "Linux", label: "Red Hat Enterprise Linux release 9.2 (Plow)", name: "web01", network: false, backup: false };
      setTimeout(() => mockEmit("monitor-stats", { id: a.req.id, device }), 300);
      monitors.set(a.req.id, window.setInterval(() => {
        t++;
        const stats = device.network
          ? { cpu: 8 + 4 * Math.sin(t / 3), memUsed: 0, memTotal: 0, memPercent: 41 }
          : { cpu: 20 + 15 * Math.sin(t / 3), memUsed: 3.2e9, memTotal: 7.8e9, diskUsed: 41e9, diskTotal: 100e9 };
        mockEmit("monitor-stats", { id: a.req.id, stats, warmup: t === 1 });
      }, 2000));
      return;
    }
    case "monitor_backup":
      if (!monitors.has(a.id)) throw "모니터링이 실행 중이 아닙니다";
      return "Building configuration...\n\nCurrent configuration : 1234 bytes\n!\nversion 17.6\nhostname SW-CORE-01\n!\nend\n";
    case "monitor_stop":
      clearInterval(monitors.get(a.id));
      monitors.delete(a.id);
      return;
    case "registry_export":
      return a.key.includes("PuTTY")
        ? 'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Default%20Settings]\r\n"HostName"=""\r\n\r\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\core%20sw01]\r\n"HostName"="10.9.0.1"\r\n"PortNumber"=dword:00000016\r\n"Protocol"="ssh"\r\n"UserName"="netops"\r\n\r\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\console]\r\n"Protocol"="serial"\r\n"SerialLine"="COM4"\r\n"SerialSpeed"=dword:00002580\r\n'
        : "";
    case "import_scan":
      return [];
    case "update_open_folder":
      return;
    case "update_check":
      if (a.source.includes("auth")) throw String.raw`UPDATE_AUTH::\\nas\share::지정된 네트워크 암호가 맞지 않습니다. (os error 86)`;
      return { current: "0.7.4", available: a.source.includes("new") ? "0.7.5" : null, notes: "- RDP 화면 크기 자동 조정\n- 로그 파일 이름 지정" };
    case "update_install":
      throw "미리보기에서는 설치하지 않습니다";
    case "monitor_commands":
      return ["journalctl", "jq", "systemctl", "ss", "tail"];
    case "monitor_top":
      if (!monitors.has(a.id)) throw "모니터링이 실행 중이 아닙니다";
      return [
        { title: "CPU 사용률 상위 10개", lines: ["    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND", "   2211 mysql     20   0 2534120 412300  21400 S  37.5   5.1  12:01.33 mysqld", "    981 root      20   0  812300  60100  12000 S   6.2   0.7   1:22.10 dockerd", "      1 root      20   0  171000  13200   8400 S   0.0   0.2   0:09.80 systemd"] },
        { title: "메모리 사용량 상위 10개", lines: ["  PID USER     %MEM   RSS COMMAND", " 2211 mysql     5.1 412300 mysqld", "  981 root      0.7 60100 dockerd"] },
        { title: "디스크", lines: ["Filesystem      Size  Used Avail Use% Mounted on", "/dev/sda1       100G   41G   59G  41% /", "/dev/sdb1       500G  120G  380G  24% /data"] },
      ];
    case "lock_status":
      return { enabled: false, locked: false };
    case "tunnel_list":
      return [];
    case "remote_read_text":
      return {
        text: "# 미리보기 파일\nserver:\n  port: 8080\n  host: 0.0.0.0\nlog_level: info  # ERROR, WARN\n",
        bom: false,
        stamp: [now, 64],
      };
    case "remote_write_text":
      return [now + 1, a.text.length];
    case "ftp_server_start": {
      const c = a.config;
      if (!c.root) throw "공유할 폴더가 없습니다. 폴더를 다시 선택하세요.";
      ftpd = {
        running: true, root: c.root, port: c.port, lan: c.lan, username: c.username, anonymous: c.anonymous,
        readOnly: c.readOnly, uptimeSecs: 0,
        addresses: [...(c.lan ? [`ftp://192.168.0.24:${c.port}`] : []), `ftp://127.0.0.1:${c.port}`],
      };
      const user = c.username || "anonymous";
      setTimeout(() => mockEmit("ftp-server-event", { kind: "started", user: "", detail: ftpd.addresses.join(", ") }), 50);
      setTimeout(() => mockEmit("ftp-server-event", { kind: "login", user, detail: "" }), 900);
      setTimeout(() => mockEmit("ftp-server-event", { kind: "download", user, detail: "/notes.txt (1204 bytes)" }), 1400);
      return ftpd;
    }
    case "ftp_server_stop":
      ftpd = null;
      setTimeout(() => mockEmit("ftp-server-event", { kind: "stopped", user: "", detail: "" }), 50);
      return;
    case "ftp_server_status":
      return ftpd;
    case "vnc_proxy_start":
      return { url: "ws://127.0.0.1:1/preview" };
    default:
      return;
  }
}
