// Keyboard shortcuts: every action that has (or can have) a shortcut, with
// its default keys, in one place. The user's changes live in
// settings.keybindings (action id -> keys; an empty list means "no shortcut")
// and are edited in the shortcut editor (shortcuts.ts).
//
// Keys are matched by their physical key (KeyboardEvent.code), so they work
// the same with the Korean IME on (key would be "ㅊ") and on any layout.

import { state, type Snippet } from "./store";

/** Where an action applies. "global" works everywhere (a terminal passes it
 * on); the others only while that part of the window has the focus. */
export type Scope = "global" | "terminal" | "tree" | "files";

export interface ActionDef {
  id: string;
  label: string;
  scope: Scope;
  /** Default keys, e.g. "Ctrl+Shift+N". */
  keys: string[];
  /** Shown under the label. */
  note?: string;
  /** Global action that a terminal keeps for the remote program (F1 for htop, Ctrl+F for less). */
  terminalKeeps?: boolean;
}

export const SCOPES: { scope: Scope; label: string }[] = [
  { scope: "global", label: "앱 전체" },
  { scope: "terminal", label: "터미널" },
  { scope: "tree", label: "세션 트리" },
  { scope: "files", label: "파일 브라우저" },
];

const g = (id: string, label: string, keys: string[] = [], more: Partial<ActionDef> = {}): ActionDef => ({ id, label, scope: "global", keys, ...more });
const t = (id: string, label: string, keys: string[] = [], more: Partial<ActionDef> = {}): ActionDef => ({ id, label, scope: "terminal", keys, ...more });

export const ACTIONS: ActionDef[] = [
  // App
  g("app.help", "도움말", ["F1"], { note: "터미널 안에서는 원격 프로그램으로 보냄", terminalKeeps: true }),
  g("app.newSession", "새 세션", ["Ctrl+Shift+N"]),
  g("app.quickConnect", "빠른 연결 칸으로", ["Ctrl+Shift+K"]),
  g("app.toggleSidebar", "사이드바 접기·펴기", ["Ctrl+Shift+B"]),
  g("app.searchSessions", "세션 검색", ["Ctrl+F"], { note: "열린 탭이 없을 때", terminalKeeps: true }),
  g("app.settings", "설정 열기"),
  g("app.shortcuts", "단축키 설정 열기"),
  g("app.vault", "자격 증명 보관함"),
  g("app.tunnels", "SSH 터널 관리자"),
  g("app.netTools", "네트워크 도구"),
  g("app.lock", "앱 잠그기", [], { note: "마스터 비밀번호를 설정했을 때" }),
  g("app.checkUpdate", "업데이트 확인"),
  // Tabs and panes
  g("tab.next", "다음 탭", ["Ctrl+Tab"]),
  g("tab.prev", "이전 탭", ["Ctrl+Shift+Tab"]),
  g("tab.close", "탭 닫기", ["Ctrl+F4", "Ctrl+Shift+W"]),
  g("tab.closeOthers", "다른 탭 모두 닫기"),
  g("tab.duplicate", "같은 세션 하나 더 열기", [], { note: "탭 더블클릭과 같음" }),
  g("tab.reconnect", "다시 연결"),
  ...Array.from({ length: 9 }, (_, i) => g(`tab.go${i + 1}`, `${i + 1}번째 탭으로`)),
  g("pane.next", "다음 칸으로 이동", [], { note: "화면을 나눴을 때" }),
  g("layout.single", "화면: 한 칸"),
  g("layout.cols", "화면: 좌우 나누기"),
  g("layout.rows", "화면: 상하 나누기"),
  g("layout.grid", "화면: 4분할"),
  g("broadcast.toggle", "동시 입력 켜기·끄기"),
  // Terminal
  t("term.copy", "복사", ["Ctrl+Shift+C"]),
  t("term.copySelection", "선택 영역 복사", ["Ctrl+C"], { note: "선택 영역이 없으면 원격으로 Ctrl+C를 보냄" }),
  t("term.paste", "붙여넣기", ["Ctrl+Shift+V", "Ctrl+V"]),
  t("term.find", "터미널에서 찾기", ["Ctrl+Shift+F"]),
  t("term.selectAll", "전체 선택"),
  t("term.clear", "화면 지우기"),
  t("term.log", "로그 켜기·끄기"),
  t("term.save", "출력을 파일로 저장"),
  t("term.zoomIn", "글자 크게"),
  t("term.zoomOut", "글자 작게"),
  t("term.sftp", "옆 칸에 SFTP 열기", [], { note: "SSH 탭" }),
  t("term.snippets", "스니펫 메뉴 열기"),
  t("term.record", "매크로 기록 시작·끝"),
  t("term.break", "Break 보내기", [], { note: "시리얼·Telnet" }),
  // Session tree
  { id: "tree.connect", label: "연결", scope: "tree", keys: ["Enter"] },
  { id: "tree.edit", label: "편집", scope: "tree", keys: ["F2"] },
  { id: "tree.delete", label: "삭제", scope: "tree", keys: ["Delete"] },
  { id: "tree.selectAll", label: "모두 선택", scope: "tree", keys: ["Ctrl+A"] },
  { id: "tree.copy", label: "세션 복사", scope: "tree", keys: ["Ctrl+C"] },
  { id: "tree.paste", label: "세션 붙여넣기", scope: "tree", keys: ["Ctrl+V"] },
  // File browser
  { id: "files.refresh", label: "새로 고침", scope: "files", keys: ["F5"] },
  { id: "files.open", label: "열기", scope: "files", keys: ["Enter"] },
  { id: "files.parent", label: "상위 폴더", scope: "files", keys: ["Backspace"] },
  { id: "files.rename", label: "이름 바꾸기", scope: "files", keys: ["F2"] },
  { id: "files.delete", label: "삭제", scope: "files", keys: ["Delete"] },
  { id: "files.selectAll", label: "모두 선택", scope: "files", keys: ["Ctrl+A"] },
];

/** Keys that work everywhere and cannot be changed, listed for reference. */
export const FIXED: { keys: string; label: string }[] = [
  { keys: "Esc", label: "대화 상자·메뉴 닫기, 찾기 막대 닫기" },
  { keys: "Enter", label: "대화 상자의 기본 버튼" },
  { keys: "↑ ↓", label: "세션 트리에서 이동 (Shift와 함께: 여러 개 선택)" },
  { keys: "Ctrl+휠", label: "터미널 글자 크기" },
  { keys: "Shift+Enter", label: "터미널 찾기 막대에서 이전 결과" },
];

/** A snippet or macro can be given a shortcut too (terminal scope). */
export const SNIPPET_PREFIX = "snippet:";
export function snippetAction(s: Snippet): ActionDef {
  return { id: SNIPPET_PREFIX + s.id, label: s.name, scope: "terminal", keys: [], note: s.macro ? "매크로 재생" : "스니펫 보내기" };
}

/** Every action, the snippets included. */
export function allActions(): ActionDef[] {
  return [...ACTIONS, ...state.snippets.map(snippetAction)];
}

const byId = (id: string) => allActions().find((a) => a.id === id);

// ---- key chords -----------------------------------------------------------------------

const NAMED: Record<string, string> = {
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Space: "Space", Enter: "Enter", NumpadEnter: "Enter", Tab: "Tab", Escape: "Esc", Backspace: "Backspace",
  Delete: "Delete", Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";",
  Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
  NumpadAdd: "Num+", NumpadSubtract: "Num-", NumpadMultiply: "Num*", NumpadDivide: "Num/", NumpadDecimal: "Num.",
  Pause: "Pause", ContextMenu: "Menu",
};

/** The key part of a chord, from the physical key; null for a modifier alone. */
function keyName(e: KeyboardEvent): string | null {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^Numpad\d$/.test(c)) return "Num" + c.slice(6);
  if (/^F\d{1,2}$/.test(c)) return c;
  if (NAMED[c]) return NAMED[c];
  // Synthetic events (and some remote-desktop tools) carry no code.
  const k = e.key;
  if (!c && k.length === 1) return /[a-z]/i.test(k) ? k.toUpperCase() : k;
  if (!c && /^(F\d{1,2}|Tab|Enter|Escape|Backspace|Delete|Home|End|PageUp|PageDown|Insert)$/.test(k)) return k === "Escape" ? "Esc" : k;
  if (!c && k.startsWith("Arrow")) return k.slice(5);
  return null;
}

/** "Ctrl+Alt+Shift+K" for a key event, or null when only a modifier is down. */
export function chordOf(e: KeyboardEvent): string | null {
  const key = keyName(e);
  if (!key) return null;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", key].filter(Boolean).join("+");
}

/** Same chord written another way ("shift+ctrl+n" -> "Ctrl+Shift+N"). */
export function normalizeChord(chord: string): string {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  const mods = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  let key = parts[parts.length - 1] ?? "";
  if (key.length === 1) key = key.toUpperCase();
  return [mods.has("ctrl") && "Ctrl", mods.has("alt") && "Alt", mods.has("shift") && "Shift", key].filter(Boolean).join("+");
}

/** A chord that would type a character (no Ctrl/Alt): fine for the tree and
 * the file list, never for the whole app or a terminal. */
export function typesText(chord: string): boolean {
  const parts = chord.split("+");
  const key = parts[parts.length - 1];
  const hasCtrlAlt = parts.includes("Ctrl") || parts.includes("Alt");
  const printable = key.length === 1 || key === "Space" || /^Num[\d+\-*/.]$/.test(key) || ["Enter", "Tab", "Backspace", "Delete", "Esc"].includes(key);
  return !hasCtrlAlt && printable && !/^F\d/.test(key);
}

// ---- bindings ---------------------------------------------------------------------------

/** The keys an action has now (the user's, else the defaults). */
export function bindings(id: string): string[] {
  const own = state.settings.keybindings?.[id];
  if (own) return own;
  return byId(id)?.keys ?? [];
}

/** First action of `scope` bound to this event's keys. */
export function actionFor(e: KeyboardEvent, scope: Scope): string | null {
  const chord = chordOf(e);
  if (!chord) return null;
  return allActions().find((a) => a.scope === scope && bindings(a.id).includes(chord))?.id ?? null;
}

/** A terminal passes these keys on to the app instead of the remote program. */
export function appTakesInTerminal(e: KeyboardEvent): boolean {
  const chord = chordOf(e);
  if (!chord) return false;
  return ACTIONS.some((a) => a.scope === "global" && !a.terminalKeeps && bindings(a.id).includes(chord));
}

/** Actions that would also react to `chord` if `id` had it: the same scope,
 * or the whole app (which applies everywhere). */
export function conflicts(id: string, chord: string): ActionDef[] {
  const self = byId(id);
  if (!self) return [];
  return allActions().filter(
    (a) => a.id !== id && (a.scope === self.scope || a.scope === "global" || self.scope === "global") && bindings(a.id).includes(chord),
  );
}

/** For display: "Ctrl+Shift+N" with keycaps. */
export function chordHtml(chord: string, kbd: (k: string) => string): string {
  return chord.split("+").map(kbd).join("+");
}
