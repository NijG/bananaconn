// Command snippets: saved commands sent to a terminal with one click.

import { icon } from "./icons";
import { saveSnippets, state, type Snippet } from "./store";
import { groupForKind } from "./snippetLibrary";
import { contextMenu, esc, modal, toast, type MenuItem } from "./ui";

/** Recorded keystrokes made readable: Enter ⏎, Tab ⇥, Esc ␛, other controls ^X. */
export function showKeys(data: string): string {
  return [...data]
    .map((c) => {
      const code = c.charCodeAt(0);
      if (c === "\r") return "⏎\n";
      if (c === "\t") return "⇥";
      if (code === 27) return "␛";
      if (code === 127) return "⌫";
      if (code < 32) return `^${String.fromCharCode(code + 64)}`;
      return c;
    })
    .join("");
}

/** Save a recorded macro. */
export function addMacro(name: string, keys: string) {
  saveSnippets([...state.snippets, { id: crypto.randomUUID(), name, text: keys, run: false, macro: true }]);
}

/** Show the snippet menu at a toolbar button; `send` delivers the text.
 * The user's own snippets come first, then the group for the operating system
 * recognised in this tab (`kind`, devmon.rs); every other group is one click
 * further, so the menu stays short with the whole library loaded. */
export function snippetMenu(anchor: HTMLElement, send: (s: Snippet) => void, kind?: string) {
  const r = anchor.getBoundingClientRect();
  const entry = (s: Snippet): MenuItem => ({
    label: s.name,
    icon: s.macro ? "Circle" : s.run ? "Play" : "ClipboardType",
    hint: s.macro ? "매크로" : s.text.split("\n")[0].slice(0, 28),
    action: () => send(s),
  });
  const groups = [...new Set(state.snippets.flatMap((s) => (s.group ? [s.group] : [])))];
  const detected = groupForKind(kind);
  const show = (group: string | undefined) => {
    const items: (MenuItem | "-")[] = state.snippets.filter((s) => !s.group).map(entry);
    if (group) {
      if (items.length) items.push("-");
      items.push({ label: group, icon: "Server", disabled: true });
      items.push(...state.snippets.filter((s) => s.group === group).map(entry));
    }
    const others = groups.filter((g) => g !== group);
    if (others.length) {
      items.push("-");
      for (const g of others) {
        const n = state.snippets.filter((s) => s.group === g).length;
        // Opens that group's menu in place of this one.
        items.push({ label: `${g} 스니펫`, icon: "ChevronRight", hint: `${n}개`, action: () => setTimeout(() => show(g)) });
      }
    }
    items.push("-");
    items.push({ label: "스니펫 관리…", icon: "Pencil", action: () => openSnippetManager() });
    contextMenu(r.left, r.bottom + 4, items);
  };
  show(detected && groups.includes(detected) ? detected : undefined);
}

export function openSnippetManager() {
  let list: Snippet[] = state.snippets.map((s) => ({ ...s }));
  let selected = list[0]?.id ?? null;

  const m = modal({
    title: "명령 스니펫",
    icon: "ClipboardType",
    width: 720,
    body: `<div class="vault">
        <aside class="vault-list">
          <button class="btn btn-primary btn-block" data-new>${icon("Plus", 14)}새 스니펫</button>
          <div class="vault-items"></div>
        </aside>
        <section class="vault-detail"></section>
      </div>
      <p class="vault-note">${icon("Info", 14)}터미널 툴바의 스니펫 버튼으로 보냅니다. 동시 입력이 켜져 있으면 보이는 모든 터미널로 갑니다.</p>`,
    footer: `<button class="btn" data-close>닫기</button>`,
  });
  const listEl = m.root.querySelector<HTMLElement>(".vault-items")!;
  const detail = m.root.querySelector<HTMLElement>(".vault-detail")!;

  /** Created with "새 스니펫" but never saved: not written by other commits. */
  const unsaved = new Set<string>();
  const commit = () => saveSnippets(list.filter((s) => !unsaved.has(s.id)).map((s) => ({ ...s })));

  const render = () => {
    // The user's own snippets first, then one section per operating system.
    const groups = [...new Set(list.flatMap((s) => (s.group ? [s.group] : [])))];
    const item = (s: Snippet) => `<button class="vault-item${s.id === selected ? " on" : ""}" data-id="${esc(s.id)}">
              ${icon(s.macro ? "Circle" : s.run ? "Play" : "ClipboardType", 15)}
              <span><b>${esc(s.name)}</b><small class="mono-ellipsis">${esc(s.macro ? showKeys(s.text) : s.text.split("\n")[0])}</small></span></button>`;
    const own = list.filter((s) => !s.group);
    listEl.innerHTML = list.length
      ? [
          own.length ? `<div class="vault-group">내 스니펫</div>${own.map(item).join("")}` : "",
          ...groups.map((g) => `<div class="vault-group">${esc(g)}</div>${list.filter((s) => s.group === g).map(item).join("")}`),
        ].join("")
      : `<p class="muted small pad">스니펫이 없습니다.</p>`;
    listEl.querySelectorAll<HTMLElement>("[data-id]").forEach((b) =>
      b.addEventListener("click", () => {
        selected = b.dataset.id!;
        render();
      }),
    );
    const s = list.find((x) => x.id === selected);
    if (!s) {
      detail.innerHTML = `<div class="empty-state">${icon("ClipboardType", 30)}<p>왼쪽에서 스니펫을 고르거나 새로 만드세요.</p></div>`;
      return;
    }
    detail.innerHTML = `<form class="form" autocomplete="off">
        <div class="grid-2">
          <label class="field"><span>이름</span><input name="name" value="${esc(s.name)}" /></label>
          <label class="field"><span>OS 분류 (비우면 내 스니펫)</span><input name="group" list="snippet-groups" value="${esc(s.group ?? "")}" placeholder="예: Linux" />
            <datalist id="snippet-groups">${[...new Set(list.flatMap((x) => (x.group ? [x.group] : [])))].map((g) => `<option value="${esc(g)}"></option>`).join("")}</datalist></label>
        </div>
        ${
          s.macro
            ? `<div class="field"><span>기록된 키 입력 (터미널 툴바에서 다시 기록)</span>
                 <pre class="macro-keys mono">${esc(showKeys(s.text))}</pre></div>`
            : `<label class="field"><span>보낼 내용 (여러 줄 가능)</span>
                 <textarea name="text" rows="6" spellcheck="false" class="mono">${esc(s.text)}</textarea></label>
               <label class="check"><input type="checkbox" name="run" ${s.run ? "checked" : ""}/> 보낸 뒤 Enter 로 실행</label>`
        }
        <div class="row end">
          <button type="button" class="btn btn-danger-ghost" data-del>${icon("Trash2", 14)}삭제</button>
          <button type="submit" class="btn btn-primary">${icon("Check", 14)}저장</button>
        </div>
      </form>`;
    const form = detail.querySelector("form")!;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const get = (n: string) => form.querySelector<HTMLInputElement>(`[name=${n}]`)!;
      s.group = get("group").value.trim() || undefined;
      if (s.macro) {
        s.name = get("name").value.trim() || s.name;
      } else {
        const text = (form.querySelector("textarea") as HTMLTextAreaElement).value;
        if (!text.trim()) return toast("보낼 내용을 입력하세요", "warn");
        s.name = get("name").value.trim() || text.split("\n")[0].slice(0, 30);
        s.text = text;
        s.run = get("run").checked;
      }
      unsaved.delete(s.id);
      commit();
      render();
      toast("저장했습니다", "success");
    });
    detail.querySelector("[data-del]")!.addEventListener("click", () => {
      list = list.filter((x) => x.id !== s.id);
      unsaved.delete(s.id);
      selected = list[0]?.id ?? null;
      commit();
      render();
    });
  };

  m.root.querySelector("[data-new]")!.addEventListener("click", () => {
    const s: Snippet = { id: crypto.randomUUID(), name: "새 스니펫", text: "", run: true };
    unsaved.add(s.id);
    list.push(s);
    selected = s.id;
    render();
    detail.querySelector<HTMLInputElement>("[name=name]")?.select();
  });
  render();
}
