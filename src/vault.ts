// Credential vault manager: passwords and SSH keys. Secrets are stored in the
// Windows Credential Manager by the backend; this UI only sends new values and
// never displays stored ones.

import { api, pickOpenFile, type Credential } from "./api";
import { writeClipboard } from "./clipboard";
import { icon } from "./icons";
import { detachCredential, reloadCredentials, state } from "./store";
import { confirmDialog, errorText, esc, listKeys, modal, toast } from "./ui";

/** A strong random password: at least one upper, lower, digit and symbol, the
 * rest mixed, shuffled. Ambiguous characters (O/0, l/1) are left out. */
function generatePassword(len = 20): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*()-_=+?"];
  const rand = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const pick = (s: string) => s[rand(s.length)];
  const all = sets.join("");
  const out = sets.map(pick); // one of each kind to start
  while (out.length < len) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

export function openVault(): Promise<void> {
  return new Promise((resolve) => {
    let selected: string | null = state.credentials[0]?.id ?? null;
    let draft: Credential | null = null;
    /** Unsaved changes to the selected existing credential (kind toggle).
     * Kept here, never written into state.credentials before a save. */
    let edited: Credential | null = null;

    const m = modal({
      title: "자격 증명 보관함",
      icon: "KeyRound",
      width: 780,
      body: `<div class="vault">
          <aside class="vault-list">
            <button class="btn btn-primary btn-block" data-new>${icon("Plus", 14)}새 자격 증명</button>
            <input type="search" class="list-search" placeholder="이름·사용자 검색" spellcheck="false" autocomplete="off" />
            <div class="vault-items"></div>
          </aside>
          <section class="vault-detail"></section>
        </div>
        <p class="vault-note">${icon("ShieldCheck", 14)}비밀번호와 키 암호는 Windows 자격 증명 관리자에 암호화되어 저장되며, 설정 파일에는 기록되지 않습니다.</p>`,
      footer: `<button class="btn" data-close>닫기</button>`,
      onClose: () => resolve(),
    });
    const listEl = m.root.querySelector<HTMLElement>(".vault-items")!;
    const detailEl = m.root.querySelector<HTMLElement>(".vault-detail")!;

    const search = m.root.querySelector<HTMLInputElement>(".list-search")!;
    /** Search terms: each must appear in the name or user name. */
    let terms: string[] = [];
    const renderList = () => {
      const items = state.credentials.filter((c) => {
        const hay = `${c.name} ${c.username}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
      listEl.innerHTML = items.length
        ? items
            .map(
              (c) => `<button class="vault-item${c.id === selected && !draft ? " on" : ""}" data-id="${c.id}">
                ${icon(c.kind === "key" ? "Key" : "Lock", 15)}
                <span><b data-i18n-skip>${esc(c.name)}</b><small>${c.kind === "key" ? "SSH 키" : "비밀번호"}${c.username ? `<span data-i18n-skip> · ${esc(c.username)}</span>` : ""}</small></span>
              </button>`,
            )
            .join("")
        : `<p class="muted small pad">${state.credentials.length ? "일치하는 자격 증명이 없습니다." : "저장된 자격 증명이 없습니다."}</p>`;
      listEl.querySelectorAll<HTMLElement>("[data-id]").forEach((b) =>
        b.addEventListener("click", () => {
          selected = b.dataset.id!;
          draft = null;
          edited = null;
          renderList();
          renderDetail();
        }),
      );
    };

    const renderDetail = () => {
      const c = draft ?? (edited?.id === selected ? edited : null) ?? state.credentials.find((x) => x.id === selected);
      if (!c) {
        detailEl.innerHTML = `<div class="empty-state">${icon("KeyRound", 30)}<p>왼쪽에서 자격 증명을 선택하거나 새로 만드세요.</p></div>`;
        return;
      }
      const isNew = !!draft;
      const isKey = c.kind === "key";
      detailEl.innerHTML = `<form class="form" autocomplete="off">
          <div class="seg" role="tablist">
            <button type="button" data-kind="password" class="${!isKey ? "on" : ""}">${icon("Lock", 14)}비밀번호</button>
            <button type="button" data-kind="key" class="${isKey ? "on" : ""}">${icon("Key", 14)}SSH 키</button>
          </div>
          <label class="field"><span>이름</span><input name="name" value="${esc(c.name)}" placeholder="예: 운영 서버 root" /></label>
          <label class="field"><span>사용자 이름</span><input name="username" value="${esc(c.username)}" spellcheck="false" /></label>
          ${
            isKey
              ? `<label class="field"><span>개인 키 파일</span><div class="inline">
                   <input name="keyPath" value="${esc(c.keyPath ?? "")}" placeholder="C:\\Users\\...\\.ssh\\id_ed25519" spellcheck="false" />
                   <button type="button" class="btn" data-browse>${icon("FolderOpen", 14)}찾기</button>
                   <button type="button" class="btn" data-gen>${icon("Sparkles", 14)}새로 만들기</button></div></label>
                 <label class="field"><span>키 암호 ${c.hasSecret ? '<em class="ok">저장됨</em>' : ""}</span>
                   <input name="secret" type="password" placeholder="${c.hasSecret ? "바꾸려면 새로 입력" : "암호가 없으면 비워 두세요"}" /></label>
                 <div class="pubkey" hidden><span>공개 키 (서버의 ~/.ssh/authorized_keys 에 추가)</span>
                   <div class="inline"><code></code><button type="button" class="btn" data-copy>${icon("Copy", 14)}복사</button></div></div>`
              : `<label class="field"><span>비밀번호 ${c.hasSecret ? '<em class="ok">저장됨</em>' : ""}</span>
                   <div class="inline">
                     <input name="secret" type="password" placeholder="${c.hasSecret ? "바꾸려면 새로 입력" : "비밀번호"}" />
                     <button type="button" class="icon-btn" data-reveal title="비밀번호 보기/숨기기">${icon("Eye", 14)}</button>
                     <select name="pwlen" title="비밀번호 길이">${[12, 16, 20, 24, 32].map((n) => `<option value="${n}"${n === 20 ? " selected" : ""}>${n}</option>`).join("")}</select>
                     <button type="button" class="btn" data-genpass title="강력한 비밀번호를 만들어 넣고 복사합니다">${icon("Sparkles", 14)}생성</button>
                   </div></label>`
          }
          <div class="row end">
            ${!isNew ? `<button type="button" class="btn btn-danger-ghost" data-del>${icon("Trash2", 14)}삭제</button>` : ""}
            ${!isNew && c.hasSecret ? `<button type="button" class="btn" data-clear>저장된 비밀 값 지우기</button>` : ""}
            <button type="submit" class="btn btn-primary">${icon("Check", 14)}${isNew ? "추가" : "저장"}</button>
          </div>
        </form>`;

      const form = detailEl.querySelector("form")!;
      const field = (n: string) => form.querySelector<HTMLInputElement>(`[name=${n}]`);
      const current = (): Credential => ({
        ...c,
        name: field("name")!.value.trim() || "이름 없음",
        username: field("username")!.value.trim(),
        keyPath: isKey ? field("keyPath")!.value.trim() || null : null,
      });
      detailEl.querySelectorAll<HTMLElement>("[data-kind]").forEach((b) =>
        b.addEventListener("click", () => {
          const next = { ...current(), kind: b.dataset.kind as Credential["kind"] };
          if (draft) draft = next;
          else edited = next;
          renderDetail();
        }),
      );
      if (isKey) showPublicKey(c.keyPath);
      form.querySelector("[data-browse]")?.addEventListener("click", async () => {
        const path = await pickOpenFile("개인 키 파일 선택", c.keyPath ?? undefined);
        if (path) {
          field("keyPath")!.value = path;
          showPublicKey(path);
        }
      });
      form.querySelector("[data-gen]")?.addEventListener("click", () => generateKey(current(), (path, pass) => {
        field("keyPath")!.value = path;
        if (pass) field("secret")!.value = pass;
        showPublicKey(path);
      }));
      form.querySelector("[data-copy]")?.addEventListener("click", () => {
        writeClipboard(detailEl.querySelector(".pubkey code")!.textContent ?? "");
        toast("공개 키를 복사했습니다", "success");
      });
      form.querySelector("[data-reveal]")?.addEventListener("click", (e) => {
        const el = field("secret")!;
        const reveal = el.type === "password";
        el.type = reveal ? "text" : "password";
        // Eye = hidden (click to show), EyeOff = shown (click to hide).
        (e.currentTarget as HTMLElement).innerHTML = icon(reveal ? "EyeOff" : "Eye", 14);
      });
      form.querySelector("[data-genpass]")?.addEventListener("click", () => {
        const len = Math.max(8, Math.min(64, Number(form.querySelector<HTMLSelectElement>("[name=pwlen]")?.value) || 20));
        const pw = generatePassword(len);
        const el = field("secret")!;
        el.type = "text"; // show it so it can be checked before saving
        el.value = pw;
        // Keep the reveal toggle's icon in step with the now-visible field.
        const reveal = form.querySelector("[data-reveal]");
        if (reveal) reveal.innerHTML = icon("EyeOff", 14);
        writeClipboard(pw, { secret: true }); // keep the generated password out of clipboard history
        toast("강력한 비밀번호를 만들어 클립보드에 복사했습니다", "success", 3000);
      });
      form.querySelector("[data-del]")?.addEventListener("click", async () => {
        const used = state.sessions.filter((s) => s.credentialId === c.id).length;
        const ok = await confirmDialog({
          title: "자격 증명 삭제",
          message: `<b>${esc(c.name)}</b>을(를) 삭제합니다.${used ? `<br>이 자격 증명을 쓰는 세션 ${used}개는 접속할 때 직접 입력하게 됩니다.` : ""}${
            isKey ? "<br>키 파일 자체는 삭제하지 않습니다." : ""
          }`,
          confirm: "삭제",
          danger: true,
        });
        if (!ok) return;
        try {
          await api.vaultDelete(c.id);
          await detachCredential(c.id);
          await reloadCredentials();
        } catch (err) {
          return toast(errorText(err), "error");
        }
        selected = state.credentials[0]?.id ?? null;
        renderList();
        renderDetail();
      });
      form.querySelector("[data-clear]")?.addEventListener("click", async () => {
        try {
          await api.vaultSave(current(), "");
          await reloadCredentials();
        } catch (err) {
          return toast(errorText(err), "error");
        }
        renderDetail();
        toast("저장된 비밀 값을 지웠습니다");
      });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const secret = field("secret")?.value ?? "";
        const cred = current();
        if (isKey && !cred.keyPath) return toast("개인 키 파일을 지정하세요", "warn");
        try {
          const saved = await api.vaultSave(cred, secret ? secret : null);
          await reloadCredentials();
          selected = saved.id;
          draft = null;
          edited = null;
          renderList();
          renderDetail();
          toast(isNew ? "자격 증명을 추가했습니다" : "저장했습니다", "success");
        } catch (err) {
          toast(errorText(err), "error");
        }
      });
    };

    const showPublicKey = async (keyPath: string | null) => {
      const box = detailEl.querySelector<HTMLElement>(".pubkey");
      if (!box) return;
      if (!keyPath) return void (box.hidden = true);
      try {
        box.querySelector("code")!.textContent = await api.vaultPublicKey(keyPath);
        box.hidden = false;
      } catch {
        box.hidden = true;
      }
    };

    listKeys(search, listEl, "[data-id]");
    search.addEventListener("input", () => {
      terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      renderList();
    });
    m.root.querySelector("[data-new]")!.addEventListener("click", () => {
      search.value = "";
      terms = [];
      draft = { id: crypto.randomUUID(), name: "", username: "", kind: "password", keyPath: null, hasSecret: false };
      renderList();
      renderDetail();
      detailEl.querySelector<HTMLInputElement>("[name=name]")?.focus();
    });

    renderList();
    renderDetail();
  });
}

async function generateKey(cred: Credential, done: (path: string, passphrase: string) => void) {
  const dir = await api.vaultDefaultKeyDir();
  const base = (cred.name || "bananaconn").replace(/[^\w.-]+/g, "_").toLowerCase();
  const m = modal({
    title: "새 SSH 키 만들기",
    icon: "Sparkles",
    width: 520,
    body: `<form class="form" autocomplete="off">
        <div class="seg"><button type="button" class="on" data-t="ed25519">Ed25519 (권장)</button><button type="button" data-t="rsa">RSA 4096</button></div>
        <label class="field"><span>저장 위치</span><input name="path" value="${esc(`${dir}\\${base}`)}" spellcheck="false" /></label>
        <label class="field"><span>키 암호 (선택)</span><input name="pass" type="password" placeholder="비워 두면 암호 없이 생성" /></label>
        <label class="field"><span>설명 (comment)</span><input name="comment" value="${esc(cred.username ? `${cred.username}@bananaconn` : "bananaconn")}" /></label>
      </form>`,
    footer: `<button class="btn" data-close>취소</button><button class="btn btn-primary" data-go>${icon("Sparkles", 14)}만들기</button>`,
  });
  let type = "ed25519";
  m.root.querySelectorAll<HTMLElement>("[data-t]").forEach((b) =>
    b.addEventListener("click", () => {
      type = b.dataset.t!;
      m.root.querySelectorAll("[data-t]").forEach((x) => x.classList.toggle("on", x === b));
    }),
  );
  m.root.querySelector("[data-go]")!.addEventListener("click", async () => {
    const get = (n: string) => m.root.querySelector<HTMLInputElement>(`[name=${n}]`)!.value;
    try {
      await api.vaultGenerateKey(get("path"), type, get("pass"), get("comment"));
      toast("키를 만들었습니다. 저장을 누른 뒤 공개 키를 서버에 등록하세요.", "success");
      done(get("path"), get("pass"));
      m.close();
    } catch (err) {
      toast(errorText(err), "error");
    }
  });
}
