// The AI for a remote desktop view (RDP, VNC): the same panel as a terminal's,
// with screenshots instead of commands. Nothing typed into the remote screen:
// a command in an answer is copied for the engineer to paste.

import { writeClipboard } from "../clipboard";
import { subscribe } from "../store";
import { contextMenu, toast, type MenuItem } from "../ui";
import type { AiHost, AiPanel } from "./panel";

export function desktopHost(opts: { key: string; system: string; names: () => string[]; canvas: () => HTMLCanvasElement | null; focus: () => void }): AiHost {
  return {
    conversationKey: () => opts.key,
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
  /** The in-flight open(), so two quick menu actions do not each build a panel. */
  private opening: Promise<AiPanel> | null = null;
  /** Bumped by close()/dispose() so a load() finishing after that is discarded
   * instead of building a zombie panel into a closed or torn-down view. */
  private gen = 0;

  /** Keep the panel's provider list/label in sync when AI settings change. RDP
   * and VNC views have no settings subscription of their own (terminals do), so
   * the panel would otherwise show a stale provider list until reopened. */
  private unsub: () => void;

  constructor(
    private view: HTMLElement,
    private host: AiHost,
    private relayout: () => void,
    /** More menu items for this view (after a separator). */
    private extras: () => MenuItem[] = () => [],
  ) {
    this.unsub = subscribe("settings", () => this.panel?.refreshProviders());
  }

  private open(): Promise<AiPanel> {
    if (this.panel) return Promise.resolve(this.panel);
    return (this.opening ??= this.load());
  }

  private async load(): Promise<AiPanel> {
    const gen = this.gen;
    try {
      const { AiPanel } = await import("./panel");
      // Closed or disposed while the panel chunk was loading: don't build a panel
      // into a view the user already closed (or that is gone).
      if (gen !== this.gen) throw new Error("cancelled");
      this.panel = new AiPanel(this.host, () => this.close());
      this.view.append(this.panel.el);
      this.view.classList.add("with-ai");
      this.relayout();
      return this.panel;
    } finally {
      this.opening = null;
    }
  }

  close() {
    this.gen++;
    this.opening = null;
    this.panel?.dispose();
    this.panel = null;
    this.view.classList.remove("with-ai");
    this.relayout();
    this.host.focus();
  }

  menu(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, [
      { label: "화면 설명 (캡처해서 묻기)", icon: "ScanEye", action: () => void this.open().then((p) => p.explainScreen()).catch(() => {}) },
      { label: "화면 캡처해 대화에 첨부", icon: "Camera", action: () => void this.open().then((p) => (p.captureScreen(), p.focus())).catch(() => {}) },
      { label: this.panel ? "AI 대화 닫기" : "AI 대화 열기", icon: "Bot", action: () => (this.panel ? this.close() : void this.open().then((p) => p.focus()).catch(() => {})) },
      ...(this.extras().length ? ["-" as const, ...this.extras()] : []),
    ]);
  }

  dispose() {
    this.gen++;
    this.opening = null;
    this.unsub();
    this.panel?.dispose();
    this.panel = null;
  }
}
