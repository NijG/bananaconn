// Shortcut editor: every action with its keys, grouped by where it applies.
// Keys can be added (press them), removed and reset; snippets and macros can
// get a shortcut of their own. Changes apply at once (settings.keybindings).

import { icon } from "./icons";
import {
  ACTIONS,
  bindings,
  chordOf,
  conflicts,
  FIXED,
  SCOPES,
  snippetAction,
  SNIPPET_PREFIX,
  typesText,
  type ActionDef,
} from "./keymap";
import { state, subscribe, updateSettings } from "./store";
import { confirmDialog, esc, modal, toast } from "./ui";

const kbd = (chord: string) => chord.split("+").map((k) => `<kbd>${esc(k)}</kbd>`).join("+");
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Store an action's keys; the defaults are stored as "no change" so a later
 * version's new default still applies. */
function setKeys(def: ActionDef, keys: string[]) {
  const map = { ...(state.settings.keybindings ?? {}) };
  if (same(keys, def.keys)) delete map[def.id];
  else map[def.id] = keys;
  updateSettings({ keybindings: map });
}

export function openShortcuts() {
  let filter = "";
  /** The action whose new keys are being captured. */
  let capturing: string | null = null;

  const m = modal({
    title: "단축키",
    icon: "Keyboard",
    width: 760,
    body: `<div class="shortcuts">
        <div class="shortcuts-top">
          <input type="search" class="shortcuts-search" placeholder="동작 이름이나 키로 찾기 (예: 탭, Ctrl+Shift)" spellcheck="false"/>
          <button type="button" class="btn" data-reset-all>${icon("RotateCcw", 14)}모두 기본값으로</button>
        </div>
        <p class="muted small">바꾼 단축키는 바로 적용됩니다. "키 추가"를 누른 뒤 원하는 키를 누르세요(Esc: 취소). 앱 전체와 터미널 단축키에는 글자 입력을 막지 않도록 Ctrl이나 Alt, 또는 F1~F12가 들어가야 합니다.</p>
        <div class="shortcuts-list"></div>
      </div>`,
    footer: `<button class="btn btn-primary" data-close>닫기</button>`,
    onClose: () => {
      stopCapture();
      unsubscribe.forEach((u) => u());
    },
  });
  const unsubscribe: (() => void)[] = [];
  const list = m.root.querySelector<HTMLElement>(".shortcuts-list")!;
  const search = m.root.querySelector<HTMLInputElement>(".shortcuts-search")!;

  const matchesFilter = (a: ActionDef) => {
    if (!filter) return true;
    const f = filter.toLowerCase();
    return a.label.toLowerCase().includes(f) || (a.note ?? "").toLowerCase().includes(f) || bindings(a.id).some((k) => k.toLowerCase().includes(f));
  };

  const row = (a: ActionDef) => {
    const keys = bindings(a.id);
    const changed = !same(keys, a.keys);
    return `<tr data-id="${esc(a.id)}"${changed ? ' class="changed"' : ""}>
        <td class="sc-label"><span>${esc(a.label)}</span>${a.note ? `<small class="muted">${esc(a.note)}</small>` : ""}</td>
        <td class="sc-keys"><div class="sc-chips">${keys.map((k) => `<span class="sc-chip">${kbd(k)}<button type="button" class="icon-btn" data-remove="${esc(k)}" title="이 키 빼기">${icon("X", 12)}</button></span>`).join("") || `<span class="muted small">없음</span>`}</div></td>
        <td class="sc-acts">
          <button type="button" class="btn btn-sm" data-add>${capturing === a.id ? "키를 누르세요… (Esc: 취소)" : `${icon("Plus", 13)}키 추가`}</button>
          ${changed ? `<button type="button" class="btn btn-sm btn-ghost" data-default title="기본값: ${esc(a.keys.join(", ") || "없음")}">${icon("RotateCcw", 13)}기본값</button>` : ""}
        </td></tr>`;
  };

  const section = (title: string, actions: ActionDef[], empty = "") => {
    const shown = actions.filter(matchesFilter);
    if (!shown.length && (filter || !empty)) return "";
    return `<h4>${esc(title)}</h4><table class="shortcut-table"><tbody>${shown.map(row).join("") || `<tr><td class="muted small" colspan="3">${empty}</td></tr>`}</tbody></table>`;
  };

  /** Snippets: the user's own first, then the built-in library by system,
   * folded unless a shortcut is set there or the search matches. */
  const snippetSections = () => {
    const own = state.snippets.filter((s) => !s.group).map(snippetAction);
    const groups = new Map<string, ActionDef[]>();
    for (const s of state.snippets.filter((x) => x.group)) {
      const list = groups.get(s.group!) ?? [];
      list.push(snippetAction(s));
      groups.set(s.group!, list);
    }
    let html = section("내 스니펫·매크로 (터미널에서 보내기)", own, "직접 만든 스니펫이 없습니다. 터미널 툴바의 스니펫 메뉴에서 만들 수 있습니다.");
    const library = [...groups].map(([group, actions]) => {
      const shown = actions.filter(matchesFilter);
      if (!shown.length) return "";
      const bound = actions.some((a) => bindings(a.id).length);
      return `<details class="sc-group"${filter || bound ? " open" : ""}><summary>${esc(group)} <span class="muted small">${shown.length}</span></summary>
        <table class="shortcut-table"><tbody>${shown.map(row).join("")}</tbody></table></details>`;
    });
    if (library.some(Boolean)) html += `<h4>기본 제공 스니펫 (운영체제·장비별)</h4>${library.join("")}`;
    return html;
  };

  const render = () => {
    const fixed = FIXED.filter((f) => !filter || f.label.toLowerCase().includes(filter.toLowerCase()) || f.keys.toLowerCase().includes(filter.toLowerCase()));
    const open = new Set([...list.querySelectorAll<HTMLDetailsElement>("details.sc-group[open] summary")].map((s) => s.firstChild?.textContent?.trim()));
    list.innerHTML =
      SCOPES.map(({ scope, label }) => section(label, ACTIONS.filter((a) => a.scope === scope))).join("") +
      snippetSections() +
      (fixed.length
        ? `<h4>바꿀 수 없는 키</h4><table class="shortcut-table fixed"><tbody>${fixed.map((f) => `<tr><td class="sc-label">${esc(f.label)}</td><td class="sc-keys">${f.keys.split(" ").map((k) => (k.includes("+") ? kbd(k) : `<kbd>${esc(k)}</kbd>`)).join(" ")}</td><td></td></tr>`).join("")}</tbody></table>`
        : "") ||
      `<p class="muted">"${esc(filter)}"와 일치하는 단축키가 없습니다.</p>`;
    list.querySelectorAll<HTMLDetailsElement>("details.sc-group").forEach((d) => {
      if (open.has(d.querySelector("summary")?.firstChild?.textContent?.trim())) d.open = true;
    });
  };

  const defOf = (id: string): ActionDef | undefined =>
    id.startsWith(SNIPPET_PREFIX) ? state.snippets.map(snippetAction).find((a) => a.id === id) : ACTIONS.find((a) => a.id === id);

  // ---- capturing a new key ------------------------------------------------------------
  const onCapture = async (e: KeyboardEvent) => {
    if (!capturing) return;
    // The editor owns this key press: not the dialog (Esc), not the app.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === "Escape") return stopCapture();
    const chord = chordOf(e);
    if (!chord) return; // a modifier alone: wait for the key
    const def = defOf(capturing)!;
    stopCapture();
    if ((def.scope === "global" || def.scope === "terminal") && typesText(chord)) {
      toast(`${chord}는 글자 입력에 쓰이는 키라서 ${def.scope === "global" ? "앱 전체" : "터미널"} 단축키로 쓸 수 없습니다. Ctrl이나 Alt를 함께 누르세요.`, "warn", 6000);
      return;
    }
    if (bindings(def.id).includes(chord)) return;
    const others = conflicts(def.id, chord);
    if (others.length) {
      const ok = await confirmDialog({
        title: "이미 쓰는 단축키",
        icon: "Keyboard",
        message: esc(`${chord}는 지금 ${others.map((o) => o.label).join(", ")}에 쓰이고 있습니다. 그 동작에서 빼고 ${def.label}에 지정할까요?`),
        confirm: "옮기기",
      });
      if (!ok) return;
      for (const o of others) setKeys(o, bindings(o.id).filter((k) => k !== chord));
    }
    setKeys(def, [...bindings(def.id), chord]);
  };
  function stopCapture() {
    if (!capturing) return;
    capturing = null;
    window.removeEventListener("keydown", onCapture, true);
    render();
  }

  list.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const id = target.closest<HTMLElement>("tr[data-id]")?.dataset.id;
    const def = id ? defOf(id) : undefined;
    if (!def) return;
    const remove = target.closest<HTMLElement>("[data-remove]")?.dataset.remove;
    if (remove) return setKeys(def, bindings(def.id).filter((k) => k !== remove));
    if (target.closest("[data-default]")) {
      const taken = def.keys.flatMap((k) => conflicts(def.id, k).map((o) => `${k} (${o.label})`));
      if (taken.length) toast(`기본 키가 다른 동작에도 지정되어 있습니다: ${taken.join(", ")}`, "warn", 6000);
      return setKeys(def, def.keys);
    }
    if (target.closest("[data-add]")) {
      if (capturing === def.id) return stopCapture();
      if (capturing) window.removeEventListener("keydown", onCapture, true);
      capturing = def.id;
      window.addEventListener("keydown", onCapture, true);
      render();
    }
  });
  search.addEventListener("input", () => {
    filter = search.value.trim();
    render();
  });
  m.root.querySelector("[data-reset-all]")!.addEventListener("click", async () => {
    if (!Object.keys(state.settings.keybindings ?? {}).length) return toast("이미 모두 기본값입니다", "info");
    const ok = await confirmDialog({ title: "모두 기본값으로", icon: "RotateCcw", message: "바꾼 단축키와 스니펫에 지정한 단축키를 모두 지우고 기본값으로 되돌릴까요?", confirm: "되돌리기", danger: true });
    if (ok) updateSettings({ keybindings: {} });
  });
  // Re-draw on any change (also from another window part, e.g. a snippet saved meanwhile).
  unsubscribe.push(subscribe("settings", render), subscribe("snippets", render));
  render();
  search.focus();
}
