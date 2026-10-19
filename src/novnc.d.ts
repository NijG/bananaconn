declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      url: string,
      options?: { shared?: boolean; credentials?: { username?: string; password?: string }; wsProtocols?: string[] },
    );
    viewOnly: boolean;
    focusOnClick: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    sendCredentials(credentials: { username?: string; password?: string; target?: string }): void;
    sendCtrlAltDel(): void;
    clipboardPasteFrom(text: string): void;
    focus(): void;
  }
}
