// TFTP client tab: fetch a file from a TFTP server (network gear, firmware
// servers) or send one to it. TFTP has no listing and no login, so the user
// names the file on the server.

import { api, on, pickOpenFile, pickSavePath } from "../api";
import { icon } from "../icons";
import { endpoint, PROTOCOLS, type Session } from "../model";
import { patchSession } from "../store";
import { errorText, esc, formatBytes, h, toast } from "../ui";
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

export class TftpView implements View {
  el: HTMLElement;
  state: ViewState = "connected";
  private running: string | null = null;
  private localFile = "";
  private disposed = false;

  constructor(
    private session: Session,
    private ws: Workspace,
  ) {
    if (!routed) {
      routed = true;
      on<Progress>("tftp-progress", (p) => views.get(p.id)?.progress(p));
    }
    const p = PROTOCOLS.tftp;
    const block = Number(session.options.blockSize) || 1428;
    this.el = h(
      "div",
      { class: "view tftp-view" },
      `<div class="view-bar">
         <span class="proto-chip" style="--proto:${p.color}">${icon(p.icon, 14)}${p.label}</span>
         <span class="view-endpoint">${esc(endpoint(session))}</span>
         <span class="view-state" data-state>연결 없이 파일 단위로 주고받음</span>
       </div>
       <div class="tftp-body">
         <section class="tftp-card">
           <h3>${icon("Download", 16)}받기 <small>서버 → 내 PC</small></h3>
           <label class="field"><span>서버의 파일 이름</span><input name="getName" placeholder="예: running-config, c2960x-universalk9-mz.152-7.E2.bin" spellcheck="false"/></label>
           <button class="btn btn-primary" data-get>${icon("Download", 14)}받을 위치 정하고 받기</button>
         </section>
         <section class="tftp-card">
           <h3>${icon("Upload", 16)}보내기 <small>내 PC → 서버</small></h3>
           <div class="field"><span>내 PC의 파일</span>
             <div class="row"><button class="btn" data-pick>${icon("FolderOpen", 14)}파일 선택…</button><span class="tftp-local muted" data-local>선택한 파일 없음</span></div></div>
           <label class="field"><span>서버에 저장할 이름</span><input name="putName" placeholder="비워 두면 파일 이름 그대로" spellcheck="false"/></label>
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
    const local = await pickSavePath(remote.split(/[\\/]/).pop() || "tftp-file");
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
    this.showProgress(true, direction === "get" ? `${remote} 받는 중…` : `${remote} 보내는 중…`);
    this.ws.changed();
    const what = direction === "get" ? `받기 ${remote} → ${local}` : `보내기 ${local} → ${remote}`;
    try {
      const r = await api.tftpTransfer({ id, host: this.session.host, port: this.session.port, remote, local, direction, blockSize: this.blockSize });
      const secs = Math.max(r.millis, 1) / 1000;
      this.log(true, `${what} · ${formatBytes(r.bytes)} · ${secs.toFixed(1)}초 · ${formatBytes(r.bytes / secs)}/초 · 블록 ${r.blockSize}`);
      toast(direction === "get" ? `받았습니다: ${local}` : `보냈습니다: ${remote}`, "success");
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

  private log(ok: boolean, text: string) {
    const li = h("li", { class: ok ? "ok" : "fail" }, `${icon(ok ? "Check" : "TriangleAlert", 13)}<span>${new Date().toLocaleTimeString()}</span> ${esc(text)}`);
    this.el.querySelector("[data-log]")!.prepend(li);
  }

  dispose() {
    this.disposed = true;
    if (this.running) api.tftpCancel(this.running).catch(() => {});
  }
}
