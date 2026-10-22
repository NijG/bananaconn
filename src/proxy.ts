// A session's proxy, as PuTTY sets it (Connection → Proxy). Stored in the
// session's options (proxy*), read here only; the backend (proxy.rs) dials.

import type { Protocol, Session } from "./model";
import { state } from "./store";
import { esc } from "./ui";

export type ProxyKind = "socks4" | "socks5" | "http" | "telnet" | "local";

/** What the backend takes (proxy.rs ProxyConfig). */
export interface ProxyConfig {
  kind: ProxyKind;
  host: string;
  port: number;
  exclude: string;
  local: boolean;
  dns: "no" | "auto" | "yes";
  credentialId: string | null;
  telnetCommand: string;
  localCommand: string;
  diagnostics: boolean;
}

const KINDS: [ProxyKind | "", string][] = [
  ["", "사용 안 함"],
  ["socks4", "SOCKS 4 / 4a"],
  ["socks5", "SOCKS 5"],
  ["http", "HTTP (CONNECT)"],
  ["telnet", "Telnet (명령으로 연결)"],
  ["local", "로컬 명령"],
];

/** Protocols that connect over TCP to a host (serial and TFTP do not). */
export const PROXY_PROTOCOLS = new Set<Protocol>(["ssh", "sftp", "telnet", "ftp", "ftps", "rdp", "vnc"]);

export const DEFAULT_TELNET_COMMAND = "connect %host %port\\n";

function defaultPort(kind: ProxyKind): number {
  return kind === "http" ? 8080 : kind === "telnet" ? 23 : 1080;
}

function kindOf(v: unknown): ProxyKind | null {
  return KINDS.some(([k]) => k && k === v) ? (v as ProxyKind) : null;
}

/** The session's proxy, or null without one. */
export function proxyOf(s: Session): ProxyConfig | null {
  const o = s.options;
  const kind = kindOf(o.proxyType);
  if (!kind || !PROXY_PROTOCOLS.has(s.protocol)) return null;
  const port = Number(o.proxyPort);
  return {
    kind,
    host: String(o.proxyHost ?? "").trim(),
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : defaultPort(kind),
    exclude: String(o.proxyExclude ?? ""),
    local: !!o.proxyLocal,
    dns: o.proxyDns === "no" || o.proxyDns === "yes" ? o.proxyDns : "auto",
    credentialId: (o.proxyCredentialId as string) || null,
    telnetCommand: String(o.proxyTelnetCommand ?? DEFAULT_TELNET_COMMAND) || DEFAULT_TELNET_COMMAND,
    localCommand: String(o.proxyLocalCommand ?? ""),
    diagnostics: !!o.proxyDiag,
  };
}

/** What makes the proxy unusable, for the editor's save check. */
export function proxyProblem(s: Session): string | null {
  const p = proxyOf(s);
  if (!p) return null;
  if (p.kind === "local") return p.localCommand.trim() ? null : "로컬 프록시 명령을 입력하세요";
  if (!p.host) return "프록시 호스트를 입력하세요";
  return null;
}

/** Options that belong to the proxy (kept when the protocol changes). */
export function proxyOptions(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => k.startsWith("proxy")));
}

/** The editor's "프록시" section (empty for protocols without one). */
export function proxyFields(s: Session): string {
  if (!PROXY_PROTOCOLS.has(s.protocol)) return "";
  const o = s.options;
  const kind = kindOf(o.proxyType);
  const sel = (name: string, values: [string, string][], current: string, rerender = false) =>
    `<select name="opt.${name}"${rerender ? " data-rerender" : ""}>${values.map(([v, l]) => `<option value="${v}" ${v === current ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  const creds = state.credentials.filter((c) => c.kind !== "key");
  const remote = kind && kind !== "local";
  return `<details class="advanced" ${kind ? "open" : ""}><summary>프록시</summary>
      <div class="grid-2">
        <label class="field span-2"><span>프록시 종류</span>${sel("proxyType", KINDS, kind ?? "", true)}</label>
        ${
          remote
            ? `<label class="field"><span>프록시 호스트 <em>*</em></span><input name="opt.proxyHost" value="${esc(o.proxyHost ?? "")}" placeholder="proxy.example.com" spellcheck="false" /></label>
        <label class="field"><span>포트</span><input name="opt.proxyPort" type="number" min="0" max="65535" value="${esc(o.proxyPort ?? defaultPort(kind ?? "socks5"))}" /></label>
        <label class="field span-2"><span>프록시 로그인 (자격 증명)</span><select name="opt.proxyCredentialId">
          <option value="">사용 안 함</option>
          ${creds.map((c) => `<option value="${c.id}" ${c.id === o.proxyCredentialId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
        </select></label>
        <label class="field span-2"><span>DNS 이름 조회</span>${sel(
          "proxyDns",
          [
            ["auto", "자동 (SOCKS 4는 이 PC에서, 나머지는 프록시에서)"],
            ["yes", "프록시에서"],
            ["no", "이 PC에서"],
          ],
          String(o.proxyDns ?? "auto"),
        )}</label>`
            : ""
        }
        ${
          kind === "telnet"
            ? `<label class="field span-2"><span>프록시에 보낼 명령</span><input name="opt.proxyTelnetCommand" value="${esc(o.proxyTelnetCommand ?? DEFAULT_TELNET_COMMAND)}" spellcheck="false" /></label>`
            : ""
        }
        ${
          kind === "local"
            ? `<label class="field span-2"><span>로컬 명령 <em>*</em></span><input name="opt.proxyLocalCommand" value="${esc(o.proxyLocalCommand ?? "")}" placeholder="plink.exe -nc %host:%port jumpbox" spellcheck="false" /></label>`
            : ""
        }
        ${
          kind
            ? `<label class="field span-2"><span>프록시를 거치지 않을 호스트·IP</span><input name="opt.proxyExclude" value="${esc(o.proxyExclude ?? "")}" placeholder="*.corp.local, 10.0.0.0/8" spellcheck="false" /></label>
        <label class="check span-2"><input type="checkbox" name="opt.proxyLocal" ${o.proxyLocal ? "checked" : ""}/> 이 PC(localhost)로 가는 연결도 프록시를 거침</label>
        <label class="check span-2"><input type="checkbox" name="opt.proxyDiag" ${o.proxyDiag ? "checked" : ""}/> 프록시 진단 메시지를 터미널에 표시</label>`
            : ""
        }
      </div>
      ${
        kind
          ? `<p class="muted small">명령에는 %host, %port, %user, %pass, %%와 \\n, \\r, \\t, \\\\, \\xHH를 쓸 수 있습니다. 비밀번호는 자격 증명 보관함에만 저장됩니다.</p>`
          : `<p class="muted small">회사 방화벽처럼 프록시를 거쳐야만 나갈 수 있을 때 씁니다 (PuTTY의 Connection → Proxy와 같습니다).</p>`
      }
    </details>`;
}
