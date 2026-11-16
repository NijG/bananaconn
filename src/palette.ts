// Command palette (Ctrl+K): type to find and run any app command or open any
// saved session, so nothing depends on remembering where a button is. It reads
// the action list and sessions; the caller runs the chosen action or session.

import { icon } from "./icons";
import { endpoint, PROTOCOLS, sessionDefaultsFor, sessionSearchText, type Session } from "./model";
import { ACTIONS, bindings, SNIPPET_PREFIX } from "./keymap";
import { state, updateSettings, type Snippet } from "./store";
import { TERM_THEMES } from "./themes";
import { deviceAlert, deviceAlertAt } from "./deviceAlerts";
import { esc, markTerms, matchesTerms, searchTerms } from "./ui";
import { tr } from "./i18n";
import { parseSubnetInput, subnetMatcher } from "./ipLinks";

interface Item {
  label: string;
  sub: string;
  icon: string;
  keys: string[];
  hay: string;
  run: () => void;
  /** A session's or tab's address: found by a subnet typed too ("10.0.0.0/24"). */
  host?: string;
  /** Listed only for a search, not before anything is typed. */
  searchedOnly?: boolean;
}

/** Open the palette. Only one at a time. */
export function openCommandPalette(opts: {
  runAction: (id: string) => void;
  openSession: (s: Session) => void;
  /** Open tabs to switch to (the shown one left out), in tab-bar order. */
  tabs?: { id: string; title: string; endpoint: string; session: Session }[];
  showTab?: (id: string) => void;
  /** Sessions of recently closed tabs, newest first, to open again. */
  closed?: Session[];
  reopen?: (s: Session) => void;
  /** An address typed into the palette: a new session for it (the editor
   * opens filled in; nothing connects before it is saved), its network tools. */
  newSession?: (defaults: Partial<Session>) => void;
  netTools?: (host: string) => void;
  /** A subnet typed into the palette ("10.0.0.0/24"): the network tools'
   * IP scan or subnet calculator with it filled in (a scan runs with its own button). */
  subnetTools?: (ip: string, prefix: number, tool: "sweep" | "subnet") => void;
  /** The tab in front takes snippets (a terminal): searched snippets and
   * macros are sent to it, `tab` named on each. */
  snippets?: { tab: string; send: (s: Snippet) => void };
}): void {
  if (document.querySelector(".cmdk-backdrop")) return;

  // Sessions first (most recently used), then the app-wide commands. Per-tab
  // "go to tab N" entries are left out — they would only clutter the list.
  const items: Item[] = [];
  // Tabs already open first: picking one switches to it instead of opening the
  // same device a second time.
  for (const t of opts.tabs ?? []) {
    const info = PROTOCOLS[t.session.protocol];
    items.push({
      label: t.title,
      sub: `${tr("열린 탭")} · ${info.label} · ${t.endpoint}`,
      icon: "AppWindow",
      keys: [],
      // "탭" / "tab" (the word in the screen language) lists the open tabs.
      hay: `${t.title} ${t.endpoint} ${sessionSearchText(t.session)} 열린 탭 ${tr("열린 탭")}`.toLowerCase(),
      run: () => opts.showTab?.(t.id),
      host: t.session.host,
    });
  }
  for (const s of opts.closed ?? []) {
    const info = PROTOCOLS[s.protocol];
    const ep = endpoint(s);
    items.push({
      label: s.name || s.host,
      sub: `${tr("닫은 탭")} · ${info.label} · ${ep}`,
      icon: "RotateCcw",
      keys: [],
      hay: `${sessionSearchText(s)} 닫은 탭 ${tr("닫은 탭")}`.toLowerCase(),
      run: () => opts.reopen?.(s),
      host: s.host,
    });
  }
  // Devices needing attention (deviceAlerts.ts) first, then pinned sessions (the
  // home screen's), then by last use.
  // The newest mark first (an unmarked session's time is 0).
  for (const s of [...state.sessions].sort((a, b) => deviceAlertAt(b.host) - deviceAlertAt(a.host) || Number(!!b.pinned) - Number(!!a.pinned) || (b.lastUsed ?? 0) - (a.lastUsed ?? 0))) {
    const info = PROTOCOLS[s.protocol];
    const ep = endpoint(s);
    const alert = deviceAlert(s.host);
    // Session names are the user's own data — never run them through translation.
    // The alert is app text: translated here (the list is skipped on screen).
    items.push({
      label: s.name || s.host,
      sub: alert ? `${tr(alert)} · ${info.label} · ${ep}` : `${info.label} · ${ep}`,
      icon: alert ? "TriangleAlert" : info.icon,
      keys: [],
      hay: sessionSearchText(s),
      run: () => opts.openSession(s),
      host: s.host,
    });
  }
  for (const a of ACTIONS) {
    if (a.scope !== "global" || a.id === "app.commandPalette" || /^tab\.go\d/.test(a.id)) continue;
    // Command labels are app strings — translate them (the list is i18n-skipped).
    const label = tr(a.label);
    const sub = a.note ? tr(a.note) : tr("명령");
    items.push({ label, sub, icon: "Zap", keys: bindings(a.id), hay: `${label} ${a.label} ${a.note ?? ""}`.toLowerCase(), run: () => opts.runAction(a.id) });
  }
  // Snippets and macros for the terminal in front, found by name or group
  // ("스니펫", "snippet" lists them all); only when searched for. Their
  // commands are not searched: an address typed would match half of them.
  if (opts.snippets) {
    const { tab, send } = opts.snippets;
    for (const s of state.snippets) {
      // The built-in library's names are translated; the user's own are not (as in the snippet menu).
      const name = s.group ? tr(s.name) : s.name;
      const kind = tr(s.macro ? "매크로 재생" : "스니펫 보내기");
      items.push({
        label: name,
        sub: [kind, s.group ? tr(s.group) : "", tab].filter(Boolean).join(" · "),
        icon: s.macro ? "Circle" : s.run ? "Play" : "ClipboardType",
        keys: bindings(SNIPPET_PREFIX + s.id),
        hay: `${name} ${s.name} ${s.group ?? ""} ${s.group ? tr(s.group) : ""} 스니펫 매크로 snippet macro ${kind}`.toLowerCase(),
        run: () => send(s),
        searchedOnly: true,
      });
    }
  }
  // The terminal color themes, each applied at once ("테마", "theme",
  // "banana"…), the one in use marked; only when searched for, so the list
  // shown before typing stays the sessions and commands.
  const themeWord = tr("터미널 테마");
  for (const [key, t] of Object.entries(TERM_THEMES)) {
    const current = state.settings.terminalTheme === key;
    items.push({
      label: `${themeWord}: ${tr(t.label)}`,
      sub: current ? tr("지금 쓰는 테마") : tr("명령"),
      icon: current ? "Check" : "Palette",
      keys: [],
      hay: `${themeWord} 터미널 테마 terminal theme ${t.label} ${tr(t.label)} ${key}`.toLowerCase(),
      run: () => updateSettings({ terminalTheme: key }),
      searchedOnly: true,
    });
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

  /** What can be done with the query when it is an address ("10.0.0.9",
   * "root@sw1:22"), after what it matched: one not saved yet starts a session. */
  const forAddress = (q: string): Item[] => {
    const defaults = /[.@:]/.test(q) ? sessionDefaultsFor(q) : null;
    if (!defaults?.host) return [];
    const shown = endpoint({ protocol: defaults.protocol ?? "ssh", host: defaults.host, port: defaults.port ?? null, username: defaults.username ?? "" });
    const host = defaults.host;
    return [
      ...(opts.newSession ? [{ label: tr("이 주소로 새 세션 만들기…"), sub: shown, icon: "Plus", keys: [], hay: "", run: () => opts.newSession!(defaults) }] : []),
      ...(opts.netTools ? [{ label: tr("네트워크 도구"), sub: host, icon: "Activity", keys: [], hay: "", run: () => opts.netTools!(host) }] : []),
    ];
  };

  /** What can be done with the query when it is a subnet: scan it (what the
   * scan takes, /22 to /32) or work it out. */
  const forSubnet = (q: string): Item[] => {
    const s = parseSubnetInput(q);
    if (!s || s.prefix === null || !opts.subnetTools) return [];
    const { ip, prefix } = s;
    const sub = `${ip}/${prefix}`;
    return [
      ...(prefix >= 22 ? [{ label: tr("이 서브넷 스캔…"), sub, icon: "Radar", keys: [], hay: "", run: () => opts.subnetTools!(ip, prefix, "sweep") }] : []),
      { label: tr("서브넷 계산"), sub, icon: "Network", keys: [], hay: "", run: () => opts.subnetTools!(ip, prefix, "subnet") },
    ];
  };

  const matches = (q: string): Item[] => {
    if (!q) return items.filter((it) => !it.searchedOnly).slice(0, 50);
    const terms = searchTerms(q);
    // A subnet ("10.0.0.0/24") also finds what is in it, as the session list's search does.
    const inSubnet = subnetMatcher(q);
    return [...items.filter((it) => matchesTerms(it.hay, terms) || (inSubnet !== null && it.host !== undefined && inSubnet(it.host))).slice(0, 50), ...forAddress(q), ...forSubnet(q)];
  };

  const render = () => {
    shown = matches(input.value.trim());
    const terms = searchTerms(input.value.trim());
    if (sel >= shown.length) sel = Math.max(0, shown.length - 1);
    list.innerHTML = shown.length
      ? shown
          .map(
            (it, i) =>
              `<div class="cmdk-item${i === sel ? " sel" : ""}" data-i="${i}">${icon(it.icon, 15)}
                <span class="cmdk-text"><b>${markTerms(it.label, terms)}</b><small>${markTerms(it.sub, terms)}</small></span>
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
