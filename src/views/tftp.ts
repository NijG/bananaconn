// TFTP client tab: fetch a file from a TFTP server (network gear, firmware
// servers) or send one to it. TFTP has no listing and no login, so the user
// names the file on the server.

import { api, on, pickOpenFile, pickSavePath, revealInExplorer } from "../api";
import { icon } from "../icons";
import { endpoint, PROTOCOLS, type Session } from "../model";
import { patchSession } from "../store";
import { errorText, esc, formatBytes, h, toast } from "../ui";
import { notesButton } from "../sessionNotes";
import { userText } from "../i18n";
import type { StatusInfo, View, ViewState, Workspace } from "../workspace";

type Progress = { id: string; done: number; total: number | null };
const views = new Map<string, TftpView>();
let routed = false;

/** Block sizes offered: negotiated (most gear), plain RFC 1350, large for a LAN. */
const BLOCKS: [number, string][] = [
  [1428, "자동 1428 (대부분의 장비)"],
  [512, "512 (오래된 장비·옵션 미지원)"],
  [8192, "8192 (빠른 사내망)"],
];

/** The server file names that went through, by lower-case host, newest
 * first: offered as the names are typed again (the same running-config,
 * the same image, on each visit). A name that failed (mistyped) is not kept. */
const NAMES_KEY = "bx.tftpNames";
const NAMES_PER_HOST = 12;
const NAMES_HOSTS = 50;

/** [host, names] pairs, the host used last first (an array: an object's key
 * order puts number-like names first, whatever was used last). */
function readNames(): [string, string[]][] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(NAMES_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((e): [string, string[]][] =>
      Array.isArray(e) && typeof e[0] === "string" && Array.isArray(e[1])
        ? [[e[0], e[1].filter((n: unknown): n is string => typeof n === "string" && n !== "").slice(0, NAMES_PER_HOST)]]
        : [],
    );
  } catch {
    return [];
  }
}

function namesOf(host: string): string[] {
  const key = host.trim().toLowerCase();
  return readNames().find(([h]) => h === key)?.[1] ?? [];
}

function rememberName(host: string, name: string) {
  const key = host.trim().toLowerCase();
  if (!key || !name) return;
  const all = readNames();
  const list = [name, ...(all.find(([h]) => h === key)?.[1] ?? []).filter((n) => n !== name)].slice(0, NAMES_PER_HOST);
  const next = [[key, list] as [string, string[]], ...all.filter(([h]) => h !== key)].slice(0, NAMES_HOSTS);
  try {
    localStorage.setItem(NAMES_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the suggestion is a convenience only.
  }
}

/** "running-config" as "running-config-20261122-134625", "c.cfg" as
 * "c-20261122-134625.cfg": the local time put before the extension. */
function timedName(name: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${stamp}${name.slice(dot)}` : `${name}-${stamp}`;
}

/** A received file's copy on this PC: where, when, which save of that path, its size. */
type Copy = { local: string; at: string; gen: number; bytes: number };
type Comparison = { remote: string; old: Copy; now: Copy };
/** Copies compared as text up to this size (the editor's limit); a larger
 * one is an image, read whole for nothing. */
const COMPARE_MAX = 5 * 1024 * 1024;

let listSeq = 0;
/** The TFTP tabs open now: a name remembered in one is offered at once in
 * the others to the same server. */
const openViews = new Set<TftpView>();

export class TftpView implements View {
  /** The session's notes button in the bar. */
  private notes: ReturnType<typeof notesButton>;
  el: HTMLElement;
  state: ViewState = "connected";
  private running: string | null = null;
  private localFile = "";
  private disposed = false;
  /** Server files received in this tab: where each was saved last, and when
   * (a running-config fetched before and after a change, compared). */
  private received = new Map<string, Copy>();
  /** How many times this tab saved a received file to each local path: a
   * comparison offered earlier names its copies by these, and is refused
   * once one of them was received over again (it would show newer text
   * under the older time). */
  private writes = new Map<string, number>();

  constructor(
    private session: Session,
    private ws: Workspace,
  ) {
    if (!routed) {
      routed = true;
      on<Progress>("tftp-progress", (p) => views.get(p.id)?.progress(p));
    }
    const p = PROTOCOLS.tftp;
    // A stored size the backend can take (a u16 it clamps to 8..65464); one
    // from an edited backup outside that would fail every transfer.
    const stored = Number(session.options.blockSize);
    const block = Number.isInteger(stored) && stored >= 8 && stored <= 65464 ? stored : 1428;
    const listId = `tftp-names-${++listSeq}`;
    this.el = h(
      "div",
      { class: "view tftp-view" },
      `<div class="view-bar">
         <span class="proto-chip" style="--proto:${p.color}">${icon(p.icon, 14)}${p.label}</span>
         <span class="view-endpoint" data-i18n-skip>${esc(endpoint(session))}</span>
         <span class="view-state" data-state>연결 없이 파일 단위로 주고받음</span>
         <div class="view-actions"></div>
       </div>
       <div class="tftp-body">
         <section class="tftp-card">
           <h3>${icon("Download", 16)}받기 <small>서버 → 내 PC</small></h3>
           <label class="field"><span>서버의 파일 이름</span><input name="getName" list="${listId}" placeholder="예: running-config, c2960x-universalk9-mz.152-7.E2.bin" spellcheck="false"/></label>
           <datalist id="${listId}" data-names data-i18n-skip></datalist>
           <button class="btn btn-primary" data-get>${icon("Download", 14)}받을 위치 정하고 받기</button>
         </section>
         <section class="tftp-card">
           <h3>${icon("Upload", 16)}보내기 <small>내 PC → 서버</small></h3>
           <div class="field"><span>내 PC의 파일</span>
             <div class="row"><button class="btn" data-pick>${icon("FolderOpen", 14)}파일 선택…</button><span class="tftp-local muted" data-local>선택한 파일 없음</span></div></div>
           <label class="field"><span>서버에 저장할 이름</span><input name="putName" list="${listId}" placeholder="비워 두면 파일 이름 그대로" spellcheck="false"/></label>
           <button class="btn btn-primary" data-put>${icon("Upload", 14)}보내기</button>
         </section>
         <section class="tftp-card tftp-wide">
           <div class="row">
             <label class="field"><span>블록 크기</span><select name="blockSize">${(BLOCKS.some(([v]) => v === block) ? BLOCKS : [...BLOCKS, [block, String(block)] as [number, string]]).map(([v, l]) => `<option value="${v}" ${v === block ? "selected" : ""}>${l}</option>`).join("")}</select></label>
             <div class="tftp-progress" hidden><div class="tftp-bar"><i></i></div><span data-progress></span>
               <button class="btn btn-ghost" data-cancel>${icon("X", 14)}취소</button></div>
           </div>
           <ul class="tftp-log" data-log></ul>
         </section>
       </div>`,
    );
    // The saved session's notes, while it has any (sessionNotes.ts).
    this.notes = notesButton(session.id, (s) => this.ws.editHandler?.(s));
    this.el.querySelector(".view-actions")!.prepend(this.notes.el);
    const $ = <T extends HTMLElement>(sel: string) => this.el.querySelector<T>(sel)!;
    $("[data-get]").addEventListener("click", () => this.get());
    $("[data-put]").addEventListener("click", () => this.put());
    $("[data-pick]").addEventListener("click", () => this.pick());
    $("[data-cancel]").addEventListener("click", () => this.running && api.tftpCancel(this.running));
    $<HTMLSelectElement>("[name=blockSize]").addEventListener("change", (e) => {
      const v = Number((e.target as HTMLSelectElement).value);
      this.session.options.blockSize = v;
      if (!this.session.id.startsWith("quick-")) patchSession(this.session.id, {}, { blockSize: v }).catch(() => {});
    });
    $<HTMLInputElement>("[name=getName]").addEventListener("keydown", (e) => e.key === "Enter" && this.get());
    $<HTMLInputElement>("[name=putName]").addEventListener("keydown", (e) => e.key === "Enter" && this.put());
    this.fillNames();
    openViews.add(this);
    // A received file, shown where it was saved.
    $("[data-log]").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-reveal]");
      if (b?.dataset.reveal) revealInExplorer(b.dataset.reveal).catch((err) => toast(errorText(err), "error"));
      // Or its SHA-256/SHA-512 (a device's backup or image, checked where it arrived).
      const hash = (e.target as HTMLElement).closest<HTMLElement>("[data-hash]")?.dataset.hash;
      if (hash) void import("../fileHash").then((f) => f.openSavedFileHash(hash));
    });
  }

  /** The names that went through with this server, offered in both name boxes. */
  private fillNames() {
    this.el.querySelector("[data-names]")!.innerHTML = namesOf(this.session.host)
      .map((n) => `<option value="${esc(n)}"></option>`)
      .join("");
  }

  title() {
    return this.session.name || endpoint(this.session);
  }

  status(): StatusInfo {
    return { protocol: "tftp", endpoint: endpoint(this.session), state: this.state, detail: this.running ? "전송 중" : "" };
  }

  focus() {
    this.el.querySelector<HTMLInputElement>("[name=getName]")?.focus();
  }

  private get blockSize() {
    return Number(this.el.querySelector<HTMLSelectElement>("[name=blockSize]")!.value) || 1428;
  }

  private async pick() {
    const path = await pickOpenFile("TFTP로 보낼 파일");
    if (!path) return;
    this.localFile = path;
    this.el.querySelector("[data-local]")!.textContent = path;
    const name = this.el.querySelector<HTMLInputElement>("[name=putName]")!;
    if (!name.value) name.placeholder = path.split(/[\\/]/).pop() ?? "";
  }

  private async get() {
    const remote = this.el.querySelector<HTMLInputElement>("[name=getName]")!.value.trim();
    if (!remote) return toast("서버의 파일 이름을 입력하세요", "warn");
    // Busy is said before the file dialog, not after a file was picked.
    if (this.running) return toast("전송이 끝난 다음 시작할 수 있습니다", "warn");
    // Received before in this tab: offered under a name with the time, so
    // the earlier copy stays to compare with (running-config before and
    // after a change) unless the user picks it.
    const base = remote.split(/[\\/]/).pop() || "tftp-file";
    const local = await pickSavePath(this.received.has(remote) ? timedName(base) : base);
    // The tab may have closed while the dialog was open.
    if (!local || this.disposed) return;
    this.run("get", remote, local);
  }

  private put() {
    if (!this.localFile) return toast("먼저 보낼 파일을 선택하세요", "warn");
    const remote = this.el.querySelector<HTMLInputElement>("[name=putName]")!.value.trim() || (this.localFile.split(/[\\/]/).pop() ?? "");
    this.run("put", remote, this.localFile);
  }

  private async run(direction: "get" | "put", remote: string, local: string) {
    if (this.running) return toast("전송이 끝난 다음 시작할 수 있습니다", "warn");
    const id = crypto.randomUUID();
    this.running = id;
    views.set(id, this);
    // The file names are the user's: kept as written in the translated text
    // (a server file named "설정" is not "Settings").
    const remoteText = userText(remote);
    const localText = userText(local);
    this.showProgress(true, direction === "get" ? `${remoteText} 받는 중…` : `${remoteText} 보내는 중…`);
    this.ws.changed();
    const what = direction === "get" ? `받기 ${remoteText} → ${localText}` : `보내기 ${localText} → ${remoteText}`;
    try {
      const r = await api.tftpTransfer({ id, host: this.session.host, port: this.session.port, remote, local, direction, blockSize: this.blockSize });
      const secs = Math.max(r.millis, 1) / 1000;
      const at = new Date().toLocaleTimeString();
      // The same server file received before in this tab, saved elsewhere:
      // the two copies one click from a comparison.
      // Not for a large file (a firmware image, not text to compare).
      const before = direction === "get" ? this.received.get(remote) : undefined;
      const now: Copy = { local, at, gen: (this.writes.get(local) ?? 0) + 1, bytes: r.bytes };
      const compare = before && before.local !== local && before.bytes <= COMPARE_MAX && r.bytes <= COMPARE_MAX ? { remote, old: before, now } : undefined;
      if (direction === "get") {
        this.writes.set(local, now.gen);
        this.received.set(remote, now);
      }
      this.log(true, `${what} · ${formatBytes(r.bytes)} · ${secs.toFixed(1)}초 · ${formatBytes(r.bytes / secs)}/초 · 블록 ${r.blockSize}`, direction === "get" ? local : undefined, compare, at, direction === "get" ? remote : undefined);
      rememberName(this.session.host, remote);
      const host = this.session.host.trim().toLowerCase();
      openViews.forEach((v) => v.session.host.trim().toLowerCase() === host && v.fillNames());
      toast(direction === "get" ? `받았습니다: ${localText}` : `보냈습니다: ${remoteText}`, "success");
    } catch (err) {
      const msg = errorText(err);
      this.log(false, `${what} · ${msg === "CANCELLED" ? "취소함" : msg}`);
      if (msg !== "CANCELLED") toast(msg, "error", 6000);
    } finally {
      views.delete(id);
      this.running = null;
      if (!this.disposed) {
        this.showProgress(false);
        this.ws.changed();
      }
    }
  }

  private progress(p: Progress) {
    const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : null;
    this.el.querySelector<HTMLElement>(".tftp-bar i")!.style.width = `${pct ?? 100}%`;
    this.el.querySelector("[data-progress]")!.textContent = pct === null ? formatBytes(p.done) : `${pct.toFixed(0)}% · ${formatBytes(p.done)} / ${formatBytes(p.total!)}`;
  }

  private showProgress(on: boolean, text = "") {
    const box = this.el.querySelector<HTMLElement>(".tftp-progress")!;
    box.hidden = !on;
    this.el.querySelector<HTMLElement>(".tftp-bar i")!.style.width = "0%";
    this.el.querySelector("[data-progress]")!.textContent = text;
  }

  /** One transfer in the list; `saved`: the file it received, to show in
   * Explorer; `compare`: the same server file received before, to compare. */
  private log(ok: boolean, text: string, saved?: string, compare?: Comparison, at = new Date().toLocaleTimeString(), refetch?: string) {
    const reveal = saved
      ? ` <button type="button" class="btn btn-ghost btn-sm" data-reveal="${esc(saved)}">${icon("FolderOpen", 13)}탐색기에서 보기</button><button type="button" class="btn btn-ghost btn-sm" data-hash="${esc(saved)}">${icon("ShieldCheck", 13)}해시 확인</button>`
      : "";
    const diff = compare ? `<button type="button" class="btn btn-ghost btn-sm" data-compare>${icon("Columns2", 13)}앞서 받은 것과 비교</button>` : "";
    // The same server file fetched again (after a change on the device),
    // under a new name so it can be compared with this one.
    const again = refetch ? `<button type="button" class="btn btn-ghost btn-sm" data-again>${icon("RefreshCw", 13)}다시 받기</button>` : "";
    const li = h("li", { class: ok ? "ok" : "fail" }, `${icon(ok ? "Check" : "TriangleAlert", 13)}<span>${at}</span> ${esc(text)}${reveal}${again}${diff}`);
    if (compare) li.querySelector("[data-compare]")!.addEventListener("click", () => void this.compareReceived(compare));
    if (refetch)
      li.querySelector("[data-again]")!.addEventListener("click", () => {
        // A transfer under way: said, and the name being typed left alone.
        if (this.running) return void toast("전송이 끝난 다음 시작할 수 있습니다", "warn");
        this.el.querySelector<HTMLInputElement>("[name=getName]")!.value = refetch;
        void this.get();
      });
    this.el.querySelector("[data-log]")!.prepend(li);
  }

  /** The two copies of a server file received in this tab, read from where
   * they were saved and compared line by line; not a binary (an image). */
  private async compareReceived(c: Comparison) {
    if (this.writes.get(c.old.local) !== c.old.gen || this.writes.get(c.now.local) !== c.now.gen)
      return void toast("그 뒤에 같은 위치로 다시 받아 이 두 사본을 비교할 수 없습니다", "warn", 6000);
    try {
      // One after the other: a binary first one is told without reading the second.
      const a = await api.readTextFile(c.old.local);
      if (a.includes("\0")) return void toast("텍스트 파일이 아닙니다", "warn");
      const b = await api.readTextFile(c.now.local);
      if (b.includes("\0")) return void toast("텍스트 파일이 아닙니다", "warn");
      const d = await import("../diffView");
      d.openDiff({ title: `${c.remote} · ${c.old.at}`, text: a }, { title: `${c.remote} · ${c.now.at}`, text: b });
    } catch (err) {
      toast(errorText(err), "error", 6000);
    }
  }

  dispose() {
    this.disposed = true;
    openViews.delete(this);
    this.notes.dispose();
    if (this.running) api.tftpCancel(this.running).catch(() => {});
  }
}
