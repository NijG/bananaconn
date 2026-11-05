// Credential vault manager: passwords and SSH keys. Secrets are stored in the
// Windows Credential Manager by the backend; this UI only sends new values and
// never displays stored ones.

import { api, pickOpenFile, type Credential, type ImportKeyKind } from "./api";
import { writeClipboard } from "./clipboard";
import { icon } from "./icons";
import { detachCredential, reloadCredentials, state } from "./store";
import { confirmDialog, errorText, esc, h, listKeys, matchesTerms, modal, searchTerms, toast } from "./ui";

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

/** What is wrong with a key credential's file for logging in, or null when
 * the logins can use it (import_check_keys, the same check as an import). */
function keyIssue(kind: ImportKeyKind | undefined, hasSecret: boolean, open = false): string | null {
  if (open) return OPEN_KEY;
  switch (kind) {
    case undefined:
    case "openssh":
    case "putty":
      return null;
    case "putty-encrypted":
      return hasSecret ? null : "암호가 걸린 PuTTY 키입니다. 키 암호를 저장해야 터미널에서 쓸 수 있습니다";
    case "missing":
      return "키 파일이 없습니다. 경로를 확인하세요";
    case "public":
      return "공개 키 파일입니다. 개인 키 파일을 고르세요";
    case "store":
      return "Windows 인증서 저장소의 키는 쓸 수 없습니다";
    default:
      return "OpenSSH 형식이 아닙니다. 만든 프로그램에서 OpenSSH 형식으로 내보내세요";
  }
}

/** Let only this user read a key file other accounts can read (ssh.exe
 * ignores such a key and asks for a password), after the user agrees. True
 * when it was changed. */
export async function protectKeyFile(keyPath: string): Promise<boolean> {
  const ok = await confirmDialog({
    title: "키 파일 권한 고치기",
    icon: "ShieldCheck",
    message: `<code data-i18n-skip>${esc(keyPath)}</code><br><br>다른 사용자도 이 키 파일을 읽을 수 있어 OpenSSH가 키를 쓰지 않았습니다. 이 파일을 지금 Windows 사용자만 읽을 수 있게 바꿉니다(ssh-keygen이 만든 키와 같은 권한).`,
    confirm: "권한 고치기",
  });
  if (!ok) return false;
  try {
    await api.vaultProtectKey(keyPath);
    toast("키 파일을 이 사용자만 읽을 수 있게 바꿨습니다", "success");
    return true;
  } catch (err) {
    toast(errorText(err), "error", 7000);
    return false;
  }
}

/** A private key other accounts can read: fixed with protectKeyFile. */
const OPEN_KEY = "다른 사용자도 읽을 수 있는 파일이라 OpenSSH가 이 키를 쓰지 않습니다";

/** Why a credential's key file cannot be used for logging in, or null (a
 * password, or a usable key). For pickers outside the vault (session editor). */
export async function credentialIssue(c: Credential | undefined): Promise<string | null> {
  return (await credentialCheck(c)).issue;
}

/** The problem with a credential's key file, and the file when it is one
 * protectKeyFile can fix (readable by other users). */
export async function credentialCheck(c: Credential | undefined): Promise<{ issue: string | null; fixable?: string }> {
  if (!c || c.kind !== "key" || !c.keyPath) return { issue: null };
  const [res] = await api.importCheckKeys([c.keyPath], null).catch(() => []);
  return { issue: keyIssue(res?.kind, c.hasSecret, res?.open), fixable: res?.open ? c.keyPath : undefined };
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

    /** Each key file's kind, by path, read when the vault opens and when a
     * path is chosen; a key whose file the logins cannot use is marked. */
    const kinds = new Map<string, ImportKeyKind>();
    /** Key files other accounts can read (OpenSSH ignores them). */
    const open = new Set<string>();
    const checkKeys = async (paths: string[]) => {
      const todo = [...new Set(paths.filter(Boolean))];
      if (!todo.length) return;
      const res = await api.importCheckKeys(todo, null).catch(() => []);
      todo.forEach((p, i) => {
        if (!res[i]) return;
        kinds.set(p, res[i].kind);
        if (res[i].open) open.add(p);
        else open.delete(p);
      });
    };
    const issueOf = (c: Credential) => (c.kind === "key" && c.keyPath ? keyIssue(kinds.get(c.keyPath), c.hasSecret, open.has(c.keyPath)) : null);

    const search = m.root.querySelector<HTMLInputElement>(".list-search")!;
    /** Search terms: each must appear in the name or user name. */
    let terms: string[] = [];
    const renderList = () => {
      const items = state.credentials.filter((c) => matchesTerms(`${c.name} ${c.username}`.toLowerCase(), terms));
      listEl.innerHTML = items.length
        ? items
            .map(
              (c) => `<button class="vault-item${c.id === selected && !draft ? " on" : ""}" data-id="${c.id}">
                ${icon(c.kind === "key" ? "Key" : "Lock", 15)}
                <span><b data-i18n-skip>${esc(c.name)}</b><small>${c.kind === "key" ? "SSH 키" : "비밀번호"}${c.username ? `<span data-i18n-skip> · ${esc(c.username)}</span>` : ""}</small></span>
                ${issueOf(c) ? `<span class="vault-warn" title="${esc(issueOf(c)!)}">${icon("TriangleAlert", 14)}</span>` : ""}
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
                   <button type="button" class="btn" data-gen>${icon("Sparkles", 14)}새로 만들기</button></div>
                   <small class="key-issue" hidden></small></label>
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
      if (isKey) {
        showPublicKey(c.keyPath);
        showKeyIssue(c.keyPath, c.hasSecret);
        // A path typed or pasted by hand is checked once the field is left.
        field("keyPath")!.addEventListener("change", () => showKeyIssue(field("keyPath")!.value.trim(), c.hasSecret, true));
      }
      form.querySelector("[data-browse]")?.addEventListener("click", async () => {
        const path = await pickOpenFile("개인 키 파일 선택", c.keyPath ?? undefined);
        if (path) {
          field("keyPath")!.value = path;
          showPublicKey(path);
          showKeyIssue(path, c.hasSecret, true);
        }
      });
      form.querySelector("[data-gen]")?.addEventListener("click", () => generateKey(current(), (path, pass) => {
        field("keyPath")!.value = path;
        if (pass) field("secret")!.value = pass;
        showPublicKey(path);
        showKeyIssue(path, c.hasSecret, true);
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
          message: `<b data-i18n-skip>${esc(c.name)}</b>을(를) 삭제합니다.${used ? `<br>이 자격 증명을 쓰는 세션 ${used}개는 접속할 때 직접 입력하게 됩니다.` : ""}${
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

    /** The status line under the key file field. `fresh`: read the file
     * again (it was just chosen or written). */
    const showKeyIssue = async (keyPath: string | null, hasSecret: boolean, fresh = false) => {
      const line = detailEl.querySelector<HTMLElement>(".key-issue");
      if (!line) return;
      if (keyPath && (fresh || !kinds.has(keyPath))) await checkKeys([keyPath]);
      // The form may have moved on to another credential meanwhile.
      if (!line.isConnected) return;
      const issue = keyPath ? keyIssue(kinds.get(keyPath), hasSecret, open.has(keyPath)) : null;
      line.hidden = !issue;
      line.innerHTML = issue ? `${icon("TriangleAlert", 12)}<span>${esc(issue)}</span>` : "";
      // Fixable in place: only this user may read the file afterwards.
      if (keyPath && open.has(keyPath)) {
        const fix = h("button", { type: "button", class: "btn btn-sm" });
        fix.textContent = "권한 고치기";
        fix.addEventListener("click", async () => {
          if (await protectKeyFile(keyPath)) showKeyIssue(keyPath, hasSecret, true);
        });
        line.appendChild(fix);
      }
      if (fresh) renderList();
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
      terms = searchTerms(search.value);
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
    // Every key file once; the list then marks the ones the logins cannot use.
    checkKeys(state.credentials.filter((c) => c.kind === "key").map((c) => c.keyPath ?? "")).then(() => listEl.isConnected && renderList());
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
