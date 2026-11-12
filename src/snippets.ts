// Command snippets: saved commands sent to a terminal with one click.

import { icon } from "./icons";
import { saveSnippets, state, type Snippet } from "./store";
import { groupForKind } from "./snippetLibrary";
import { confirmDialog, confirmDiscard, contextMenu, enterSubmits, esc, formValues, listKeys, markTerms, matchesTerms, modal, searchTerms, toast, type MenuItem } from "./ui";
import { tr } from "./i18n";
import { fillSnippetVars, snippetVars } from "./snippetVars";

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

/** The values last typed for each snippet's {{?name}}, offered the next time
 * it is sent (while the app runs; not saved). */
const lastValues = new Map<string, string>();

/** Whether sending `s` asks for values first ({{?name}} in its text; never a macro). */
export function asksValues(s: Snippet): boolean {
  return !s.macro && snippetVars(s.text).length > 0;
}

/** Ask for the values of `s`'s {{?name}}s and give its text with them filled
 * in; null when cancelled. Each value starts as the one typed last time, else
 * the default written in the snippet. One without a default must be given. */
export function askSnippetValues(s: Snippet): Promise<string | null> {
  const vars = snippetVars(s.text);
  const key = (name: string) => `${s.id}\n${name}`;
  return new Promise((resolve) => {
    let result: string | null = null;
    const m = modal({
      title: "스니펫 값 입력",
      icon: "Braces",
      width: 520,
      body: `<form class="form snippet-vars" autocomplete="off" novalidate>
          <p class="muted small"${s.group ? "" : " data-i18n-skip"}>${esc(s.name)}</p>
          ${vars
            .map(
              (v, i) => `<label class="field"><span data-i18n-skip>${esc(v.name)}</span>
                <input name="v${i}" value="${esc(lastValues.get(key(v.name)) ?? v.value)}" spellcheck="false" autocomplete="off"/></label>`,
            )
            .join("")}
          <div class="field"><span>보낼 내용</span><pre class="mono snippet-preview" data-i18n-skip></pre></div>
        </form>`,
      footer: `<button class="btn" data-close>취소</button><button class="btn btn-primary" data-ok>${icon("Send", 14)}보내기</button>`,
      onClose: () => resolve(result),
    });
    const form = m.root.querySelector<HTMLFormElement>("form")!;
    const inputs = vars.map((_, i) => form.querySelector<HTMLInputElement>(`[name=v${i}]`)!);
    const ok = m.root.querySelector<HTMLButtonElement>("[data-ok]")!;
    const preview = form.querySelector<HTMLElement>(".snippet-preview")!;
    const values = () => new Map(vars.map((v, i) => [v.name, inputs[i].value]));
    /** The first box still to fill: one without a default, left empty. */
    const missing = () => inputs.find((el, i) => !vars[i].hasDefault && !el.value.trim());
    const update = () => {
      // Exactly what goes out, the Enter added on sending aside; a value
      // still to give shows as its {{?name}}.
      const given = new Map([...values()].filter(([, v], i) => vars[i].hasDefault || v.trim()));
      preview.textContent = fillSnippetVars(s.text, given);
      ok.disabled = !!missing();
    };
    const send = () => {
      const empty = missing();
      if (empty) return void empty.focus();
      const v = values();
      for (const [name, value] of v) lastValues.set(key(name), value);
      result = fillSnippetVars(s.text, v);
      m.close();
    };
    form.addEventListener("input", update);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      send();
    });
    // Enter in any box: to the first one still empty, else send.
    enterSubmits(form, send);
    ok.addEventListener("click", send);
    update();
    // The first box still to fill, else the first one, its text selected to type over.
    setTimeout(() => (missing() ?? inputs[0])?.select(), 40);
  });
}

/** Save a recorded macro. */
export function addMacro(name: string, keys: string) {
  saveSnippets([...state.snippets, { id: crypto.randomUUID(), name, text: keys, run: false, macro: true }]);
}

/** Show the snippet menu at a toolbar button; `send` delivers the text.
 * The user's own snippets come first, then the group for the operating system
 * recognised in this tab (`kind`, devmon.rs); every other group is one click
 * further, so the menu stays short with the whole library loaded. */
/** `extra`: the terminal's own sending items, above the manager. */
export function snippetMenu(anchor: HTMLElement, send: (s: Snippet) => void, kind?: string, extra: MenuItem[] = []) {
  const r = anchor.getBoundingClientRect();
  const entry = (s: Snippet): MenuItem => ({
    label: s.name,
    // The built-in library's names are translated; the user's own are not (as in the keymap).
    userLabel: !s.group,
    icon: s.macro ? "Circle" : s.run ? "Play" : "ClipboardType",
    hint: s.macro ? "매크로 재생" : s.text.split("\n")[0].slice(0, 28),
    // The command is the user's (or a device's) text: never translated.
    userHint: !s.macro,
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
    items.push(...extra);
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
          <input type="search" class="list-search" placeholder="이름·내용 검색" spellcheck="false" autocomplete="off" />
          <div class="vault-items"></div>
        </aside>
        <section class="vault-detail"></section>
      </div>
      <p class="vault-note">${icon("Info", 14)}터미널 툴바의 스니펫 버튼으로 보냅니다. 동시 입력이 켜져 있으면 같은 종류의 줄에 있는 다른 터미널에도 갑니다.</p>`,
    footer: `<button class="btn" data-close>닫기</button>`,
    beforeDismiss: () => formValues(detail) === detailShown || confirmDiscard(),
  });
  const listEl = m.root.querySelector<HTMLElement>(".vault-items")!;
  const detail = m.root.querySelector<HTMLElement>(".vault-detail")!;
  /** The edit form's values when its snippet was opened or last saved (see the
   * vault's); `shownFor` names that snippet. */
  let detailShown = "[]";
  let shownFor: string | null = "";
  const search = m.root.querySelector<HTMLInputElement>(".list-search")!;
  /** Search terms: each must appear in the name, text or group. A built-in
   * snippet (one with a group) is shown translated, so its name is searched
   * as shown too ("disk" finds "디스크 사용량" in English); the user's own
   * snippets are never translated. */
  let terms: string[] = [];
  const shown = (s: Snippet) => {
    return !terms.length || matchesTerms(`${s.name} ${s.group ? tr(s.name) : ""} ${s.text} ${s.group ?? ""}`.toLowerCase(), terms);
  };

  /** Created with "새 스니펫" but never saved: not written by other commits. */
  const unsaved = new Set<string>();
  const commit = () => saveSnippets(list.filter((s) => !unsaved.has(s.id)).map((s) => ({ ...s })));

  /** `listOnly`: the search changed: the edit form (and its typing) stays. */
  const render = (listOnly = false) => {
    if (!listOnly) {
      const key = selected;
      queueMicrotask(() => {
        if (key === shownFor) return;
        shownFor = key;
        detailShown = formValues(detail);
      });
    }
    // The user's own snippets first, then one section per operating system.
    const visible = list.filter(shown);
    const groups = [...new Set(visible.flatMap((s) => (s.group ? [s.group] : [])))];
    const item = (s: Snippet) => `<button class="vault-item${s.id === selected ? " on" : ""}" data-id="${esc(s.id)}">
              ${icon(s.macro ? "Circle" : s.run ? "Play" : "ClipboardType", 15)}
              <span data-i18n-skip><b>${
                // The user's own snippets are kept as written; the built-in
                // library (grouped by OS) is app text, translated here (not on
                // screen) so the search's marks do not split it.
                markTerms(s.group ? tr(s.name) : s.name, terms)
              }</b><small class="mono-ellipsis">${markTerms(s.macro ? showKeys(s.text) : s.text.split("\n")[0], terms)}</small></span></button>`;
    const own = visible.filter((s) => !s.group);
    listEl.innerHTML = visible.length
      ? [
          own.length ? `<div class="vault-group">내 스니펫</div>${own.map(item).join("")}` : "",
          ...groups.map((g) => `<div class="vault-group">${esc(g)}</div>${visible.filter((s) => s.group === g).map(item).join("")}`),
        ].join("")
      : `<p class="muted small pad">${list.length ? "일치하는 스니펫이 없습니다." : "스니펫이 없습니다."}</p>`;
    listEl.querySelectorAll<HTMLElement>("[data-id]").forEach((b) =>
      b.addEventListener("click", async () => {
        // The one already open: nothing to switch, the typing stays.
        if (b.dataset.id === selected) return;
        if (formValues(detail) !== detailShown && !(await confirmDiscard("저장하지 않은 내용이 있습니다. 저장하지 않고 다른 항목으로 넘어갈까요?", "저장하지 않고 넘어가기"))) return;
        selected = b.dataset.id!;
        render();
      }),
    );
    if (listOnly) return;
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
                 <pre class="macro-keys mono" data-i18n-skip>${esc(showKeys(s.text))}</pre></div>`
            : `<label class="field"><span>보낼 내용 (여러 줄 가능)</span>
                 <textarea name="text" rows="6" spellcheck="false" class="mono">${esc(s.text)}</textarea></label>
               <p class="muted small">{{?이름}}을 넣으면 보낼 때 값을 묻습니다 (예: show interface {{?인터페이스}}). 기본값은 {{?횟수=5}}처럼 씁니다.</p>
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
      shownFor = "";
      render();
      toast("저장했습니다", "success");
    });
    detail.querySelector("[data-del]")!.addEventListener("click", async () => {
      // A never-saved new snippet has nothing to lose; a saved one confirms,
      // since the delete is immediate and cannot be undone.
      if (!unsaved.has(s.id)) {
        const ok = await confirmDialog({
          title: "스니펫 삭제",
          message: `<b data-i18n-skip>${esc(s.name)}</b>을(를) 삭제합니다.`,
          confirm: "삭제",
          danger: true,
        });
        if (!ok) return;
      }
      list = list.filter((x) => x.id !== s.id);
      unsaved.delete(s.id);
      selected = list[0]?.id ?? null;
      commit();
      render();
    });
  };

  listKeys(search, listEl, "[data-id]");
  search.addEventListener("input", () => {
    terms = searchTerms(search.value);
    render(true);
  });
  m.root.querySelector("[data-new]")!.addEventListener("click", async () => {
    if (formValues(detail) !== detailShown && !(await confirmDiscard("저장하지 않은 내용이 있습니다. 저장하지 않고 다른 항목으로 넘어갈까요?", "저장하지 않고 넘어가기"))) return;
    // A new snippet must be visible in the list it is added to.
    search.value = "";
    terms = [];
    const s: Snippet = { id: crypto.randomUUID(), name: "새 스니펫", text: "", run: true };
    unsaved.add(s.id);
    list.push(s);
    selected = s.id;
    render();
    detail.querySelector<HTMLInputElement>("[name=name]")?.select();
  });
  render();
}
