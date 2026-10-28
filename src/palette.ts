// Command palette (Ctrl+K): type to find and run any app command or open any
// saved session, so nothing depends on remembering where a button is. It reads
// the action list and sessions; the caller runs the chosen action or session.

import { icon } from "./icons";
import { endpoint, PROTOCOLS, type Session } from "./model";
import { ACTIONS, bindings } from "./keymap";
import { state } from "./store";
import { esc } from "./ui";
import { tr } from "./i18n";

interface Item {
  label: string;
  sub: string;
  icon: string;
  keys: string[];
  hay: string;
  run: () => void;
}

/** Open the palette. Only one at a time. */
export function openCommandPalette(opts: { runAction: (id: string) => void; openSession: (s: Session) => void }): void {
  if (document.querySelector(".cmdk-backdrop")) return;

  // Sessions first (most recently used), then the app-wide commands. Per-tab
  // "go to tab N" entries are left out — they would only clutter the list.
  const items: Item[] = [];
  for (const s of [...state.sessions].sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))) {
    const info = PROTOCOLS[s.protocol];
    const ep = endpoint(s);
    // Session names are the user's own data — never run them through translation.
    items.push({
      label: s.name || s.host,
      sub: `${info.label} · ${ep}`,
      icon: info.icon,
      keys: [],
      hay: `${s.name} ${s.host} ${ep} ${s.folder ?? ""}`.toLowerCase(),
      run: () => opts.openSession(s),
    });
  }
  for (const a of ACTIONS) {
    if (a.scope !== "global" || a.id === "app.commandPalette" || /^tab\.go\d/.test(a.id)) continue;
    // Command labels are app strings — translate them (the list is i18n-skipped).
    const label = tr(a.label);
    const sub = a.note ? tr(a.note) : tr("명령");
    items.push({ label, sub, icon: "Zap", keys: bindings(a.id), hay: `${label} ${a.label} ${a.note ?? ""}`.toLowerCase(), run: () => opts.runAction(a.id) });
  }

  const root = document.createElement("div");
  root.className = "cmdk-backdrop";
  root.innerHTML = `<div class="cmdk" role="dialog" aria-modal="true">
      <div class="cmdk-input">${icon("Search", 16)}<input type="text" placeholder="${esc(tr("명령 또는 세션 검색…"))}" spellcheck="false" autocomplete="off" /></div>
      <div class="cmdk-list" data-i18n-skip></div>
    </div>`;
  document.body.appendChild(root);
  const input = root.querySelector<HTMLInputElement>("input")!;
  const list = root.querySelector<HTMLElement>(".cmdk-list")!;

  let shown: Item[] = [];
  let sel = 0;

  const matches = (q: string): Item[] => {
    if (!q) return items.slice(0, 50);
    const needle = q.toLowerCase();
    return items.filter((it) => it.hay.includes(needle) || it.label.toLowerCase().includes(needle)).slice(0, 50);
  };

  const render = () => {
    shown = matches(input.value.trim());
    if (sel >= shown.length) sel = Math.max(0, shown.length - 1);
    list.innerHTML = shown.length
      ? shown
          .map(
            (it, i) =>
              `<div class="cmdk-item${i === sel ? " sel" : ""}" data-i="${i}">${icon(it.icon, 15)}
                <span class="cmdk-text"><b>${esc(it.label)}</b><small>${esc(it.sub)}</small></span>
                ${it.keys.length ? `<span class="cmdk-keys">${it.keys[0].split("+").map((k) => `<kbd>${esc(k)}</kbd>`).join("+")}</span>` : ""}</div>`,
          )
          .join("")
      : `<div class="cmdk-empty">${esc(tr("결과 없음"))}</div>`;
    list.querySelector(".cmdk-item.sel")?.scrollIntoView({ block: "nearest" });
  };

  // Move the highlight without rebuilding the list (a full re-render on every
  // arrow press / mousemove would flicker and re-run layout for 50 rows).
  const moveSel = (i: number) => {
    if (!shown.length) return;
    sel = ((i % shown.length) + shown.length) % shown.length;
    const rows = list.querySelectorAll<HTMLElement>(".cmdk-item");
    rows.forEach((el, j) => el.classList.toggle("sel", j === sel));
    rows[sel]?.scrollIntoView({ block: "nearest" });
  };

  const close = () => {
    root.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const choose = (i: number) => {
    const it = shown[i];
    if (!it) return;
    close();
    it.run();
  };

  // Capture so navigation keys never reach the page behind the palette.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSel(sel + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSel(sel - 1);
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      choose(sel);
    }
  };
  document.addEventListener("keydown", onKey, true);
  input.addEventListener("input", () => {
    sel = 0;
    render();
  });
  list.addEventListener("click", (e) => {
    const i = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i;
    if (i !== undefined) choose(+i);
  });
  list.addEventListener("mousemove", (e) => {
    const i = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i;
    if (i !== undefined && +i !== sel) moveSel(+i);
  });
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close();
  });

  render();
  input.focus();
}
