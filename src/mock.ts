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
/** Sweeps the preview's "Stop" ended. */
const sweepsCancelled = new Set<string>();
/** The preview's open tunnels (no SSH behind them: the manager's rows and buttons). */
const mockTunnels = new Map<string, { id: string; localPort: number; target: string; gateway: string; active: number; total: number }>();
/** Sweeps run so far: every other one answers a little differently. */
let sweepRuns = 0;
/** The mock syslog receiver: a batch of device messages every second while it runs. */
let syslogMock: { status: { port: number; lan: boolean; addresses: string[]; file: string | null }; timer: number } | null = null;
const SYSLOG_SAMPLES: [string, number, string][] = [
  ["10.0.0.2", 189, "52: *Nov  8 10:00:01: %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down"],
  ["10.0.0.2", 189, "53: *Nov  8 10:00:02: %LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/1, changed state to down"],
  ["10.0.0.3", 187, "11: *Nov  8 10:00:03: %SYS-3-CPUHOG: Task is running for (2004)msecs"],
  ["10.0.0.4", 30, "dhcpd: DHCPACK on 10.0.0.77 to 00:15:5d:01:02:03"],
  ["10.0.0.3", 190, "12: *Nov  8 10:00:04: %SEC_LOGIN-6-LOGIN_SUCCESS: Login Success [user: admin]"],
];

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

// A SecureCRT Sessions folder: the key set for all sessions (SSH2.ini), a
// session's own PuTTY key, a key in SecureCRT's own format, a missing one, and
// a password SecureCRT had saved.
const crt = (lines: string[]) => `\uFEFF${lines.join("\r\n")}\r\n`;
// An Export Settings XML whose key file is not on this PC but rides along in its Files key.
const CRT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Sessions">
    <key name="app01"><string name="Protocol Name">SSH2</string><string name="Hostname">10.0.1.21</string><string name="Username">app</string>
      <dword name="Use Global Public Key">0</dword><string name="Identity Filename V2">${"$"}{VDS_CONFIG_PATH}\\Keys\\missing_app.ppk</string></key>
  </key>
  <key name="Files">
    <key name="File 0"><string name="Path">${"$"}{VDS_CONFIG_PATH}\\Keys\\missing_app.ppk</string><binary name="Contents">50 75 54 54 59 2d 55 73 65 72 2d 4b 65 79 2d 46 69 6c 65 2d 33 3a 20 73 73 68 2d 65 64 32 35 35 31 39 0a 45 6e 63 72 79 70 74 69 6f 6e 3a 20 6e 6f 6e 65 0a 43 6f 6d 6d 65 6e 74 3a 20 70 72 65 76 69 65 77 0a</binary></key>
  </key>
</VanDyke>`;
// An OpenSSH config: shared settings under Host *, forwards on one host.
const SSH_SAMPLE = [
  "Host *",
  "  ServerAliveInterval 30",
  "Host web",
  "  HostName 10.0.3.1",
  "  User deploy",
  "  LocalForward 8080 localhost:80",
  "  DynamicForward 1080",
  "  ForwardAgent yes",
  "  Compression yes",
  "Host db",
  "  HostName 10.0.3.2",
  "  ProxyJump web",
].join("\n");
// An Xshell Sessions folder: a key kept in Xshell's own store, a saved password, a plain one.
const XSH_SAMPLE = [
  { rel: "prod/api.xsh", text: "[CONNECTION]\r\nHost=10.0.2.1\r\nPort=22\r\nProtocol=SSH\r\n[CONNECTION:AUTHENTICATION]\r\nUserName=api\r\nMethod=1\r\nUserKey=id_rsa_2048\r\n" },
  { rel: "prod/db.xsh", text: "[CONNECTION]\r\nHost=10.0.2.2\r\nPort=22\r\nProtocol=SSH\r\n[CONNECTION:AUTHENTICATION]\r\nUserName=dba\r\nPassword=preview\r\nUserKey=\r\n" },
  { rel: "sw.xsh", text: "[CONNECTION]\r\nHost=10.0.2.3\r\nPort=23\r\nProtocol=TELNET\r\n" },
];
const CRT_SAMPLE = [
  { rel: "Linux/web01.ini", text: crt(['S:"Protocol Name"=SSH2', 'S:"Hostname"=10.0.0.11', 'S:"Username"=root', 'D:"[SSH2] Port"=00000016', 'S:"SSH2 Authentications V2"=publickey,password', 'D:"Use Global Public Key"=00000001', 'S:"Identity Filename V2"=']) },
  { rel: "Linux/db01.ini", text: crt(['S:"Protocol Name"=SSH2', 'S:"Hostname"=10.0.0.12', 'S:"Username"=dba', 'D:"Use Global Public Key"=00000000', 'S:"Identity Filename V2"=${VDS_CONFIG_PATH}\\Keys\\db.ppk']) },
  { rel: "Linux/old-app.ini", text: crt(['S:"Protocol Name"=SSH2', 'S:"Hostname"=10.0.0.13', 'S:"Username"=app', 'D:"Use Global Public Key"=00000000', 'S:"Identity Filename V2"=${VDS_CONFIG_PATH}\\Identity']) },
  { rel: "Linux/batch.ini", text: crt(['S:"Protocol Name"=SSH2', 'S:"Hostname"=10.0.0.14', 'S:"Username"=batch', 'D:"Use Global Public Key"=00000000', 'S:"Identity Filename V2"=D:\\keys\\missing_batch']) },
  { rel: "Network/core-sw.ini", text: crt(['S:"Protocol Name"=SSH2', 'S:"Hostname"=10.9.0.1', 'S:"Username"=netops', 'S:"SSH2 Authentications V2"=password,keyboard-interactive', 'D:"Session Password Saved"=00000001', 'S:"Password V2"=02:preview']) },
];
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
      // Preview of a damaged sessions.json: localStorage "bx.mock.sessionsBroken" = "1".
      if (localStorage.getItem("bx.mock.sessionsBroken"))
        throw "세션 목록 형식이 올바르지 않습니다: expected `,` or `]` at line 1 column 12. 원본을 C:\\Users\\me\\AppData\\Roaming\\com.bananaconn.app\\sessions.json.bad-1793795507 에 보관했습니다.";
      return JSON.parse(localStorage.getItem(LS) ?? "[]");
    case "sessions_reset":
      if (!localStorage.getItem("bx.mock.sessionsBroken")) throw "세션 목록 파일을 이제 읽을 수 있습니다. 앱을 다시 시작하면 불러옵니다.";
      localStorage.removeItem("bx.mock.sessionsBroken");
      localStorage.setItem(LS, "[]");
      return "C:\\Users\\me\\AppData\\Roaming\\com.bananaconn.app\\sessions.json.bad-1793795507";
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
    case "local_stat":
      // [modified, size]: a file that grows as the preview runs (the Syslog file's
      // size). Its time stays put: the file windows read it to tell an edited
      // download, and one that always looks newer would ask to upload again.
      // A path with "big" in it: a file past 1 GB (the Syslog window's warning).
      return [1_700_000_000_000, (String(a.path).includes("big") ? 1_610_612_736 : 1_200_000) + (Date.now() % 100_000) * 37];
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
      if (/SecureCRT.*XML/i.test(a.path)) return CRT_XML;
      if (/SSH2\.ini$/i.test(a.path)) return crt(['S:"Identity Filename V2"=${VDS_CONFIG_PATH}\\Keys\\id_ed25519', 'D:"Public Key Type"=00000000']);
      // The preview picker returns a fake path named after the dialog title.
      if (/OpenSSH/.test(a.path)) return SSH_SAMPLE;
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
    case "net_sweep": {
      // The host addresses of the range, as nettools.rs sweep_targets has them.
      const num = String(a.network).split(".").reduce((n: number, o: string) => n * 256 + Number(o), 0);
      const size = 2 ** (32 - a.prefix);
      const net = Math.floor(num / size) * size;
      const hosts = a.prefix >= 31 ? Array.from({ length: size }, (_, i) => net + i) : Array.from({ length: size - 2 }, (_, i) => net + 1 + i);
      const total = hosts.length;
      const dotted = (n: number) => [24, 16, 8, 0].map((k) => Math.floor(n / 2 ** k) % 256).join(".");
      // A Stop that came before the start counts (as in nettools.rs).
      for (let i = 1; i <= 10; i++) {
        if (sweepsCancelled.has(a.id)) throw "CANCELLED";
        await new Promise((r) => setTimeout(r, 200));
        if (sweepsCancelled.has(a.id)) throw "CANCELLED";
        mockEmit("sweep-progress", { id: a.id, done: Math.round((total * i) / 10), total });
      }
      // Eight that answer ping, the fourth of them off this segment (no MAC),
      // and one that answers ARP only (no round trip). Every other sweep one
      // goes away and another comes (the comparison with the last sweep).
      const mac = (n: number) => `00155d${(n % 16777216).toString(16).padStart(6, "0")}`;
      const changed = ++sweepRuns % 2 === 0;
      return [0, 1, 9, 10, 19, 30, changed ? 77 : 53, 99, 199]
        .filter((i) => i < total)
        .map((i, k) => ({ ip: dotted(hosts[i]), ms: k === 5 ? null : (k % 4) + 1, mac: k % 4 === 3 && k !== 5 ? null : mac(hosts[i]) }));
    }
    case "net_sweep_cancel":
      sweepsCancelled.add(a.id);
      return;
    case "net_watch": {
      // Answers, then down for 6 (a reload), then back; until stopped.
      for (let seq = 1; !sweepsCancelled.has(a.id) && seq < 3600; seq++) {
        const lost = seq % 20 >= 8 && seq % 20 < 14;
        mockEmit("watch-reply", { id: a.id, seq, ms: lost ? null : 1 + (seq % 5) });
        await new Promise((r) => setTimeout(r, Math.max(50, a.intervalMs / 4)));
      }
      return;
    }
    case "net_stop_all":
      return;
    case "net_watch_stop":
    case "net_trace_stop":
      sweepsCancelled.add(a.id);
      return;
    case "net_trace": {
      // Two hops on the way, one that does not answer, then the target.
      const route = [["192.168.0.1"], ["10.10.0.1", "10.10.0.2"], [], [a.ip]];
      for (let i = 0; i < route.length && i < a.maxHops; i++) {
        await new Promise((r) => setTimeout(r, 300));
        if (sweepsCancelled.has(a.id)) throw "CANCELLED";
        const silent = !route[i].length;
        mockEmit("trace-hop", { id: a.id, ttl: i + 1, addrs: route[i], ms: silent ? [null, null, null] : [i, i + 1, i === 0 ? 0 : null] });
      }
      return { reached: a.maxHops >= route.length, unreachable: null, hops: Math.min(route.length, a.maxHops) };
    }
    case "net_names":
      await new Promise((r) => setTimeout(r, 600));
      // The trace's 10.10.x.x hop has no name (its saved session's name shows instead).
      return a.ips.map((ip: string, i: number) => (i % 3 === 2 || ip.startsWith("10.10.") ? null : `host-${ip.split(".").pop()}.lan`));
    case "net_dns":
      return { addresses: ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"], ms: 12 };
    case "file_server_status":
      return [];
    case "syslog_status":
      return syslogMock?.status ?? null;
    case "syslog_stop":
      if (syslogMock) clearInterval(syslogMock.timer);
      syslogMock = null;
      return;
    case "syslog_start": {
      if (syslogMock) throw "Syslog 수신이 이미 실행 중입니다";
      let n = 0;
      const timer = window.setInterval(() => {
        const messages = [0, 1].map(() => {
          const [from, pri, text] = SYSLOG_SAMPLES[n++ % SYSLOG_SAMPLES.length];
          return { at: Date.now(), from, severity: pri % 8, facility: Math.floor(pri / 8), text };
        });
        mockEmit("syslog-batch", { messages, dropped: 0, unsaved: 0, fileError: null });
      }, 1000);
      syslogMock = { status: { port: a.port, lan: a.lan, addresses: [`udp://127.0.0.1:${a.port}`], file: a.file ?? null }, timer };
      return syslogMock.status;
    }
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
      return a.ext === "ini" ? CRT_SAMPLE : a.ext === "xsh" ? XSH_SAMPLE : [];
    case "vault_protect_key":
      ((window as any).__protected ??= []).push(a.keyPath);
      return;
    case "ai_detect_cli":
      return [];
    case "known_host_forget":
      return true;
    case "import_store_key":
      return `C:\\Users\\me\\.ssh\\${a.name}`;
    case "import_check_keys":
      return a.paths.map((p: string) => ({
        path: p.replace("${VDS_CONFIG_PATH}", a.configDir ?? "C:\\Users\\me\\AppData\\Roaming\\VanDyke\\Config"),
        kind: /^capi::/i.test(p) ? "store" : /missing/i.test(p) ? "missing" : /\.ppk$/i.test(p) ? "putty" : /Identity$/.test(p) ? "foreign" : "openssh",
        open: /open/i.test(p) && !(window as any).__protected?.includes(p),
      }));
    case "update_open_folder":
      return;
    case "update_check":
      if (a.source.includes("auth")) throw String.raw`UPDATE_AUTH::\\nas\share::지정된 네트워크 암호가 맞지 않습니다. (os error 86)`;
      return { current: "0.7.4", available: a.source.includes("new") ? "0.7.5" : null, notes: "- RDP 화면 크기 자동 조정\n- 로그 파일 이름 지정" };
    case "update_install":
      throw "미리보기에서는 설치하지 않습니다";
    case "monitor_commands":
      return ["journalctl", "jq", "systemctl", "ss", "tail"];
    case "ssh_kit_start": {
      const url = "http://192.168.0.10:51234/ab12cd34ef56";
      const admin = `iex ((New-Object Net.WebClient).DownloadString('${url}/s'))`;
      return { url, adminLine: admin, runLine: `powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -Command ${admin.replace(/'/g, "''")}'"`, routed: true };
    }
    case "ssh_kit_stop":
    case "ssh_kit_allow":
      return;
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
      return [...mockTunnels.values()];
    case "tunnel_open": {
      const r = a.req;
      const info = { id: r.id, localPort: r.localPort, target: `${r.targetHost}:${r.targetPort}`, gateway: r.gatewayHost, active: 0, total: 0 };
      mockTunnels.set(r.id, info);
      return info;
    }
    case "tunnel_close":
      mockTunnels.delete(a.id);
      return;
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
