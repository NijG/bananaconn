// Network tools dialog: ping, TCP port check and DNS lookup (backend: nettools.rs).

import { api } from "./api";
import { writeClipboard } from "./clipboard";
import { icon } from "./icons";
import { userText } from "./i18n";
import { parseTarget, PROTOCOLS, type Session } from "./model";
import { errorText, esc, modal, toast } from "./ui";

type Tool = "ping" | "ports" | "dns";

/** The port check's starting list. */
const DEFAULT_PORTS = "22, 23, 80, 443, 3389, 5900";

/** Sessions a direct TCP check can say something about (see checkReachable). */
const directlyCheckable = (s: Pick<Session, "protocol" | "host" | "options">) =>
  !!s.host.trim() && s.protocol !== "serial" && s.protocol !== "tftp" && !s.options.proxyType && !String(s.options.jumpHost ?? "").trim() && !s.options.gateway;

/** A checkReachableMany run is going: a second click would only stack a
 * second set of connects and a second result dialog. */
let manyRunning = false;

/** Check many saved sessions at once (8 at a time) and show one table. */
/** `connect`: double-clicking a row closes the dialog and opens that session. */
export async function checkReachableMany(list: Session[], connect?: (s: Session) => void): Promise<void> {
  if (!list.length) return void toast("확인할 세션이 없습니다", "info");
  if (manyRunning) return void toast("확인하는 중...", "info");
  manyRunning = true;
  try {
    await runReachableMany(list, connect);
  } finally {
    manyRunning = false;
  }
}

async function runReachableMany(list: Session[], connect?: (s: Session) => void): Promise<void> {
  const todo = list.filter(directlyCheckable);
  // Sessions to the same host:port (another user, another protocol option)
  // share one connect: same answer, fewer connects to the server.
  const target = (s: Session) => `${s.host.trim().toLowerCase()}\n${s.port || PROTOCOLS[s.protocol].port}`;
  const targets = [...new Set(todo.map(target))];
  const byTarget = new Map<string, { open: boolean; text: string }>();
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const key = targets[next++];
      const [host, port] = key.split("\n");
      try {
        const [r] = await api.netPorts(host, [Number(port)]);
        byTarget.set(key, r?.open ? { open: true, text: `열려 있음 (${r.ms ?? 0}ms)` } : { open: false, text: r?.detail ?? "응답 없음" });
      } catch (err) {
        byTarget.set(key, { open: false, text: errorText(err) });
      }
    }
  };
  // An unanswered host takes up to 3 s per address: say something meanwhile.
  const working = todo.length ? toast("확인하는 중...", "info", 120_000) : null;
  try {
    await Promise.all(Array.from({ length: Math.min(8, targets.length) }, worker));
  } finally {
    working?.();
  }
  const results = new Map<string, { open: boolean; text: string }>();
  for (const s of todo) {
    const r = byTarget.get(target(s));
    if (r) results.set(s.id, r);
  }
  const open = [...results.values()].filter((r) => r.open).length;
  // Problems first: failed, then not tested, then open (stable within each).
  const rank = (s: Session) => {
    const r = results.get(s.id);
    return r ? (r.open ? 2 : 0) : 1;
  };
  const rows = [...list]
    .sort((a, b) => rank(a) - rank(b))
    .map((s) => {
      const r = results.get(s.id);
      const port = s.port || PROTOCOLS[s.protocol].port;
      return `<tr data-sid="${esc(s.id)}"><td data-i18n-skip><b>${esc(s.name || s.host)}</b></td><td class="mono" data-i18n-skip>${esc(`${s.host}:${port}`)}</td>
        <td class="${r ? (r.open ? "ok" : "bad") : "muted"}">${esc(r ? r.text : "확인하지 않음 (프록시·점프 호스트·게이트웨이·시리얼·TFTP)")}</td></tr>`;
    })
    .join("");
  const failed = todo.filter((s) => results.get(s.id)?.open === false);
  const recheck = failed.length ? `<button class="btn" data-recheck>${icon("RefreshCw", 14)}실패한 세션 다시 확인</button>` : "";
  const m = modal({
    title: "연결 확인 결과",
    icon: "Activity",
    width: 640,
    body: `<p class="muted small">${esc(`${todo.length}개 중 ${open}개 열림`)}</p><table class="reach-table"><thead><tr><th>이름</th><th>주소</th><th>상태</th></tr></thead><tbody>${rows}</tbody></table>`,
    footer: `${recheck}<button class="btn" data-copy-result>${icon("Copy", 14)}결과 복사</button><button class="btn btn-primary" data-close>닫기</button>`,
  });
  m.root.querySelector("[data-recheck]")?.addEventListener("click", () => {
    m.close();
    void checkReachableMany(failed, connect);
  });
  if (connect) {
    m.root.querySelector(".reach-table")!.classList.add("can-open");
    // Rows are reachable with Tab and open with Enter too, not only by mouse.
    m.root.querySelectorAll("tbody tr").forEach((tr) => {
      tr.setAttribute("title", "두 번 누르면 연결합니다");
      tr.setAttribute("tabindex", "0");
    });
    const open = (e: Event) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("tr[data-sid]")?.dataset.sid;
      const s = id && list.find((x) => x.id === id);
      if (!s) return;
      m.close();
      connect(s);
    };
    const body = m.root.querySelector("tbody")!;
    body.addEventListener("dblclick", open);
    body.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !(e.target as HTMLElement).matches("tr[data-sid]")) return;
      e.preventDefault();
      open(e);
    });
  }
  // The table as shown (in the screen language), one tab-separated line per row.
  m.root.querySelector("[data-copy-result]")!.addEventListener("click", () => {
    const lines = [...m.root.querySelectorAll<HTMLTableRowElement>(".reach-table tr")].map((tr) => [...tr.cells].map((c) => c.innerText.trim()).join("\t"));
    void writeClipboard(lines.join("\n"));
    toast("결과를 복사했습니다", "success", 1500);
  });
}

/** Can this PC reach the session's host:port directly? Reported as a toast.
 * Not for serial/TFTP (no TCP port), and not through a proxy, jump host or
 * gateway, where a direct connect would not tell how the session connects. */
export async function checkReachable(s: Pick<Session, "protocol" | "host" | "port" | "options">): Promise<void> {
  const host = s.host.trim();
  if (!host) return void toast("호스트를 입력하세요", "warn");
  if (s.protocol === "serial" || s.protocol === "tftp") return void toast("시리얼과 TFTP는 연결 확인을 할 수 없습니다", "info");
  if (s.options.proxyType || String(s.options.jumpHost ?? "").trim() || s.options.gateway)
    return void toast("프록시·점프 호스트·게이트웨이를 거치는 세션은 직접 확인할 수 없습니다", "info");
  const port = s.port || PROTOCOLS[s.protocol].port;
  const working = toast("확인하는 중...", "info", 120_000);
  try {
    const [r] = await api.netPorts(host, [port]).finally(working);
    if (r?.open) toast(`${userText(`${host}:${port}`)} 포트가 열려 있습니다 (${r.ms ?? 0}ms)`, "success");
    else toast(`${userText(`${host}:${port}`)} — ${r?.detail ?? "응답 없음"}`, "warn", 6000);
  } catch (err) {
    toast(errorText(err), "error");
  }
}

/** "22, 80, 8000-8010" → ports; null if any part is invalid. */
export function parsePorts(text: string): number[] | null {
  const out = new Set<number>();
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const m = part.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || a > b || b - a > 64) return null;
    for (let p = a; p <= b; p++) out.add(p);
  }
  // The limit is for the whole list ("1-60, 100-160" is 121 ports).
  return out.size && out.size <= 64 ? [...out] : null;
}

export function openNetworkTools(initialHost = "") {
  let tool: Tool = "ping";
  let busy = false;
  /** The ping running now, so "Stop" and closing the dialog end ping.exe. */
  let pingId: string | null = null;
  const stopPing = () => pingId && api.netPingCancel(pingId).catch(() => {});
  const m = modal({
    title: "네트워크 도구",
    icon: "Activity",
    width: 640,
    body: `<div class="nettools">
        <div class="seg nettools-tabs" role="tablist">
          <button data-tool="ping" class="on">${icon("Activity", 14)}Ping</button>
          <button data-tool="ports">${icon("Unplug", 14)}포트 확인</button>
          <button data-tool="dns">${icon("Globe", 14)}DNS 조회</button>
        </div>
        <form class="form nettools-form" autocomplete="off">
          <div class="inline">
            <input name="host" placeholder="호스트 또는 IP (예: 192.168.0.1)" spellcheck="false" value="${esc(initialHost)}"/>
            <input name="extra" class="nettools-extra" spellcheck="false"/>
            <button type="submit" class="btn btn-primary" data-run>${icon("Play", 14)}실행</button>
          </div>
        </form>
        <div class="nettools-out" role="log"><p class="muted">결과가 여기에 표시됩니다.</p></div>
      </div>`,
    footer: `<button class="btn" data-close>닫기</button><button class="btn" data-copy-result hidden>${icon("Copy", 14)}결과 복사</button>`,
    onClose: () => void stopPing(),
  });
  const form = m.root.querySelector<HTMLFormElement>(".nettools-form")!;
  const host = form.querySelector<HTMLInputElement>("[name=host]")!;
  const extra = form.querySelector<HTMLInputElement>("[name=extra]")!;
  const out = m.root.querySelector<HTMLElement>(".nettools-out")!;
  const run = m.root.querySelector<HTMLButtonElement>("[data-run]")!;
  const copyBtn = m.root.querySelector<HTMLButtonElement>("[data-copy-result]")!;
  copyBtn.addEventListener("click", () => {
    const text = out.innerText.trim();
    if (!text) return;
    void writeClipboard(text);
    toast("결과를 복사했습니다", "success", 1500);
  });

  const setTool = (t: Tool) => {
    tool = t;
    m.root.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
    extra.hidden = t === "dns";
    if (t === "ping") {
      extra.type = "number";
      extra.min = "1";
      extra.max = "20";
      extra.value = "4";
      extra.title = "보낼 횟수";
    } else if (t === "ports") {
      extra.type = "text";
      extra.value = DEFAULT_PORTS;
      extra.title = "포트 (쉼표, 범위 8000-8010)";
    }
    host.focus();
  };
  // Not while a run is going: its result would land under the other tool.
  m.root.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => b.addEventListener("click", () => !busy && setTool(b.dataset.tool as Tool)));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return void stopPing();
    // "root@10.0.0.1:22" or "https://server.lan/admin" pasted: the tools take a
    // host, so use the host part (as Quick connect reads it) and show it.
    const raw = host.value.trim();
    const parsed = parseTarget(raw);
    const target = parsed?.host ?? raw;
    if (target !== raw) host.value = target;
    // "10.0.0.1:2222" in the port check: that port is the one meant, unless
    // the port list was already changed from its default.
    if (tool === "ports" && parsed?.port && extra.value === DEFAULT_PORTS) extra.value = String(parsed.port);
    if (!target) return void host.focus();
    busy = true;
    copyBtn.hidden = true;
    const label = run.innerHTML;
    if (tool === "ping") run.innerHTML = `${icon("Square", 14)}중지`;
    else run.disabled = true;
    out.innerHTML = `<p class="muted"><span class="spinner sm"></span> ${tool === "ping" ? "ping 보내는 중..." : "확인하는 중..."}</p>`;
    try {
      if (tool === "ping") {
        // A whole count the backend takes (1-20): "-3", "2.5" or "1e10" would be refused raw.
        const count = Math.min(20, Math.max(1, Math.trunc(Number(extra.value)) || 4));
        pingId = crypto.randomUUID();
        const text = await api.netPing(pingId, target, count);
        out.innerHTML = `<pre class="mono">${esc(text)}</pre>`;
      } else if (tool === "ports") {
        const ports = parsePorts(extra.value);
        if (!ports) throw new Error("포트 형식: 22, 80, 8000-8010 (1~65535, 한 번에 64개까지)");
        const res = await api.netPorts(target, ports);
        const openCount = res.filter((r) => r.open).length;
        out.innerHTML = `<p class="muted small">${esc(`${res.length}개 중 ${openCount}개 열림`)}</p><table class="nettools-table"><thead><tr><th>포트</th><th>상태</th><th>응답</th></tr></thead><tbody>${res
          .map(
            (r) => `<tr class="${r.open ? "open" : "closed"}"><td class="mono">${r.port}</td>
              <td>${r.open ? icon("Check", 13) : icon("X", 13)} ${esc(r.open ? "열려 있음" : r.detail)}</td><td class="muted">${r.ms != null ? `${r.ms} ms` : ""}</td></tr>`,
          )
          .join("")}</tbody></table>`;
      } else {
        const res = await api.netDns(target);
        out.innerHTML = res.addresses.length
          ? `<ul class="nettools-list">${res.addresses.map((a) => `<li class="mono">${esc(a)}</li>`).join("")}</ul><p class="muted small">${res.ms} ms</p>`
          : `<p class="muted">주소가 없습니다.</p>`;
      }
    } catch (err) {
      const msg = errorText(err);
      out.innerHTML = msg === "CANCELLED" ? `<p class="muted">중지했습니다.</p>` : `<p class="danger-text">${esc(msg)}</p>`;
    } finally {
      busy = false;
      pingId = null;
      run.innerHTML = label;
      run.disabled = false;
      // Offer "copy result" only when there is an actual result, not a spinner,
      // an error or the "cancelled" note.
      copyBtn.hidden = !out.querySelector("pre, table.nettools-table, ul.nettools-list");
    }
  });
  setTool("ping");
}
