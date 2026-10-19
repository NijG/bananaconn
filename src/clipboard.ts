// Clipboard access. Inside Tauri the clipboard-manager plugin is used so
// reads never depend on WebView clipboard-permission prompts.

import { isTauri } from "./api";

export async function writeClipboard(text: string) {
  try {
    if (isTauri) {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
  } catch {
    /* clipboard unavailable: ignore */
  }
}

export async function readClipboard(): Promise<string> {
  try {
    if (isTauri) {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return (await readText()) ?? "";
    }
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}
