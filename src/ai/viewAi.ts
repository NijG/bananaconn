// The AI for a remote desktop view (RDP, VNC): the same panel as a terminal's,
// with screenshots instead of commands. Nothing typed into the remote screen:
// a command in an answer is copied for the engineer to paste.

import { writeClipboard } from "../clipboard";
import { contextMenu, toast } from "../ui";
import type { AiHost, AiPanel } from "./panel";

export function desktopHost(opts: { system: string; names: () => string[]; canvas: () => HTMLCanvasElement | null; focus: () => void }): AiHost {
  return {
    target: () => ({ system: opts.system, network: false }),
    hostNames: () => opts.names().filter((s) => s && s.length >= 3),
    selection: () => "",
    recentOutput: () => "",
    insert: (command) => {
      writeClipboard(command);
      toast("복사했습니다. 원격 화면에서 붙여넣으세요", "success", 3000);
    },
    insertTitle: "복사 (원격 화면에 붙여넣기)",
    focus: opts.focus,
    run: () => Promise.reject(new Error("원격 데스크톱에서는 AI가 명령을 실행하지 않습니다")),
    network: () => false,
    canRun: false,
    capture: opts.canvas,
  };
}

/** The AI panel of one remote desktop view, created on first use. */
export class ViewAi {
  private panel: AiPanel | null = null;

  constructor(
    private view: HTMLElement,
    private host: AiHost,
    private relayout: () => void,
  ) {}

  private async open(): Promise<AiPanel> {
    if (this.panel) return this.panel;
    const { AiPanel } = await import("./panel");
    this.panel = new AiPanel(this.host, () => this.close());
    this.view.append(this.panel.el);
    this.view.classList.add("with-ai");
    this.relayout();
    return this.panel;
  }

  close() {
    this.panel?.dispose();
    this.panel = null;
    this.view.classList.remove("with-ai");
    this.relayout();
    this.host.focus();
  }

  menu(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, [
      { label: "화면 설명 (캡처해서 묻기)", icon: "ScanEye", action: () => void this.open().then((p) => p.explainScreen()) },
      { label: "화면 캡처해 대화에 첨부", icon: "Camera", action: () => void this.open().then((p) => (p.captureScreen(), p.focus())) },
      { label: this.panel ? "AI 대화 닫기" : "AI 대화 열기", icon: "Bot", action: () => (this.panel ? this.close() : void this.open().then((p) => p.focus())) },
    ]);
  }

  refreshProviders() {
    this.panel?.refreshProviders();
  }

  dispose() {
    this.panel?.dispose();
    this.panel = null;
  }
}
