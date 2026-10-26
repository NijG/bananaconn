// Settings → AI: the providers (cloud API, subscription CLI, local LLM), the
// default one, and what may leave this PC.

import { api } from "../api";
import { icon } from "../icons";
import { reloadCredentials, state, updateSettings } from "../store";
import { confirmDialog, errorText, esc, modal, toast } from "../ui";
import { AI_CLIS, AI_KINDS, ask, isLocal, kindInfo, providerLabel, providers, type AiKind, type AiProvider } from "./core";

/** The AI page of the settings form (its two checkboxes are saved with the form). */
export function aiSettingsSection(check: (name: "aiPreview" | "aiMaskHosts", label: string, hint: string) => string): string {
  return `<h4 data-section="ai">AI</h4>
    <p class="muted small">터미널 툴바의 "AI"와 단축키(Ctrl+Shift+A 명령 만들기, Ctrl+Shift+E 출력 설명, Ctrl+Shift+L 대화)에서 씁니다. AI의 답은 실행되지 않습니다. 명령은 버튼으로 입력 줄에 넣은 뒤 직접 Enter를 눌러야 실행되고, 위험 명령 규칙도 그대로 적용됩니다.</p>
    <div class="ai-providers" data-ai-providers></div>
    <div class="row"><button type="button" class="btn btn-sm" data-ai-add>${icon("Plus", 14)}AI 서비스 추가</button></div>
    ${check("aiPreview", "클라우드 AI로 보내기 전에 보낼 내용 보여 주기", "보낼 내용을 매번 보여 주고 확인을 받습니다. 로컬 LLM(이 PC의 Ollama·LM Studio 등)은 묻지 않습니다. 비밀번호·키·토큰은 이 설정과 관계없이 항상 가립니다.")}
    ${check("aiMaskHosts", "클라우드 AI로 보낼 때 IP 주소·호스트 이름 가리기", "IP 주소, 메일 주소, 접속한 서버의 이름을 IP_1, HOST_1 같은 이름으로 바꿔 보냅니다. 답에서는 원래 값으로 바꿔 보여 줍니다.")}`;
}

function drawList(root: HTMLElement) {
  const box = root.querySelector<HTMLElement>("[data-ai-providers]");
  if (!box) return;
  const list = providers();
  const def = state.settings.aiDefault ?? list[0]?.id;
  box.innerHTML = list.length
    ? list
        .map(
          (p) => `<div class="ai-provider-row" data-id="${esc(p.id)}">
            <label class="check" title="기본으로 쓸 AI"><input type="radio" name="aiDefaultPick" value="${esc(p.id)}" ${p.id === def ? "checked" : ""} data-ai-default /></label>
            <div class="grow"><b data-i18n-skip>${esc(providerLabel(p))}</b><div class="muted small"><span>${esc(kindInfo(p.kind).label)}</span> · <span>${isLocal(p) ? "이 PC에서 처리" : "외부 서비스"}</span></div></div>
            <button type="button" class="tool" data-ai-edit title="편집">${icon("Pencil", 14)}</button>
            <button type="button" class="tool" data-ai-delete title="삭제">${icon("Trash2", 14)}</button></div>`,
        )
        .join("")
    : `<p class="muted small">추가된 AI 서비스가 없습니다.</p>`;
}

/** Wire the AI page of an open settings dialog. */
export function wireAiSettings(root: HTMLElement) {
  drawList(root);
  root.querySelector("[data-ai-add]")?.addEventListener("click", () => openProviderEditor(null, () => drawList(root)));
  root.querySelector("[data-ai-providers]")?.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const id = t.closest<HTMLElement>("[data-id]")?.dataset.id;
    const p = providers().find((x) => x.id === id);
    if (!p) return;
    if (t.closest("[data-ai-edit]")) openProviderEditor(p, () => drawList(root));
    else if (t.closest("[data-ai-delete]")) {
      const ok = await confirmDialog({ title: "AI 서비스 삭제", danger: true, confirm: "삭제", focusCancel: true, message: `<p><b data-i18n-skip>${esc(providerLabel(p))}</b>을(를) 목록에서 지웁니다. 보관함의 API 키는 그대로 둡니다.</p>` });
      if (!ok) return;
      const rest = providers().filter((x) => x.id !== p.id);
      updateSettings({ aiProviders: rest, aiDefault: state.settings.aiDefault === p.id ? (rest[0]?.id ?? null) : state.settings.aiDefault });
      drawList(root);
    }
  });
  root.querySelector("[data-ai-providers]")?.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.matches("[data-ai-default]")) updateSettings({ aiDefault: t.value });
  });
}

/** Add or edit one provider. API keys go to the credential vault. */
export function openProviderEditor(existing: AiProvider | null, saved: () => void) {
  const p: AiProvider = existing ? { ...existing } : { id: crypto.randomUUID(), name: "", kind: "anthropic", baseUrl: "", model: "", credentialId: null, cli: "claude" };
  const m = modal({
    title: existing ? "AI 서비스 편집" : "AI 서비스 추가",
    icon: "Sparkles",
    width: 620,
    body: `<form class="form ai-editor" autocomplete="off"></form>`,
    footer: `<button class="btn" data-test>${icon("Send", 14)}연결 확인</button><span class="grow"></span><button class="btn" data-close>취소</button><button class="btn btn-primary" data-save>저장</button>`,
  });
  const form = m.root.querySelector<HTMLFormElement>("form")!;
  let models: string[] = [];
  const keyCreds = () => state.credentials.filter((c) => c.kind === "password");
  const draw = () => {
    const info = kindInfo(p.kind);
    form.innerHTML = `<div class="grid-2">
      <label class="field span-2"><span>종류</span><select name="kind">${AI_KINDS.map((k) => `<option value="${k.kind}" ${k.kind === p.kind ? "selected" : ""}>${esc(k.label)}</option>`).join("")}</select></label>
      <label class="field span-2"><span>이름 (목록에 보일 이름, 비우면 자동)</span><input name="name" value="${esc(p.name)}" spellcheck="false" /></label>
      ${
        p.kind === "cli"
          ? `<label class="field span-2"><span>CLI</span><select name="cli">${AI_CLIS.map(([v, l]) => `<option value="${v}" ${v === p.cli ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
             <div class="span-2 muted small" data-cli-status>설치·로그인 상태를 확인하는 중…</div>
             <p class="span-2 muted small">구독은 각 회사의 공식 CLI로만 씁니다: 이 PC에 CLI를 설치하고 한 번 로그인해 두면, 앱은 질문을 CLI에 넘기고 답을 받아 옵니다. Claude Code는 도구를 모두 끈 채(명령 실행·파일 읽기 없음) 빈 폴더에서 실행하고, Codex는 읽기 전용 샌드박스로 실행합니다. 로그인 정보는 앱이 다루지 않습니다.</p>`
          : `<label class="field span-2"><span>주소${p.kind === "compatible" ? " (…/v1까지)" : ""}</span><input name="baseUrl" value="${esc(p.baseUrl)}" placeholder="${esc(info.base)}" spellcheck="false" /></label>
             ${
               info.key === "none"
                 ? ""
                 : `<label class="field span-2"><span>API 키${info.key === "optional" ? " (필요한 서버만)" : ""}</span>
                    <div class="row"><select name="credentialId" class="grow"><option value="">${info.key === "optional" ? "사용 안 함" : "선택하세요"}</option>${keyCreds()
                      .map((c) => `<option value="${esc(c.id)}" ${c.id === p.credentialId ? "selected" : ""}>${esc(c.name)}</option>`)
                      .join("")}</select></div></label>
                    <label class="field span-2"><span>새 API 키 입력 (자격 증명 보관함에 저장)</span><input name="newKey" type="password" placeholder="sk-…" autocomplete="new-password" spellcheck="false" /></label>`
             }`
      }
      <label class="field span-2"><span>모델${p.kind === "cli" ? " (비우면 CLI 기본값)" : ""}</span>
        <div class="row"><input name="model" class="grow" list="ai-models" value="${esc(p.model)}" spellcheck="false" placeholder="${p.kind === "ollama" ? "llama3.1:8b" : p.kind === "cli" ? "" : "모델 이름"}" />
        ${p.kind === "cli" ? "" : `<button type="button" class="btn btn-sm" data-models>${icon("RefreshCw", 13)}목록 불러오기</button>`}</div>
        <datalist id="ai-models">${models.map((x) => `<option value="${esc(x)}"></option>`).join("")}</datalist></label>
      <p class="span-2 muted small">${isLocal(p) ? "이 PC에서 처리합니다. 보낼 내용을 묻거나 가리지 않습니다." : "외부 서비스입니다. 보낼 내용은 설정에 따라 미리 보여 주고, 비밀번호·키·토큰은 항상 가립니다."}</p>
    </div>`;
    if (p.kind === "cli") void showCli();
  };
  const read = () => {
    const v = (n: string) => form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name=${n}]`)?.value ?? "";
    p.kind = (v("kind") as AiKind) || p.kind;
    p.name = v("name").trim();
    p.baseUrl = v("baseUrl").trim();
    p.model = v("model").trim();
    p.credentialId = form.querySelector("[name=credentialId]") ? v("credentialId") || null : p.kind === "cli" || p.kind === "ollama" ? null : p.credentialId;
    if (p.kind === "cli") p.cli = v("cli") || p.cli;
  };
  // A new key goes to the vault first; the provider keeps only its id.
  const storeKey = async () => {
    const key = form.querySelector<HTMLInputElement>("[name=newKey]")?.value.trim();
    if (!key) return;
    const cred = await api.vaultSave({ id: crypto.randomUUID(), name: `${kindInfo(p.kind).label.split(" (")[0]} API 키`, username: "", kind: "password", keyPath: null, hasSecret: false }, key);
    await reloadCredentials();
    p.credentialId = cred.id;
    form.querySelector<HTMLInputElement>("[name=newKey]")!.value = "";
  };
  const showCli = async () => {
    const box = form.querySelector<HTMLElement>("[data-cli-status]");
    if (!box) return;
    const found = await api.aiDetectCli().catch(() => []);
    const mine = found.find((c) => c.name === p.cli);
    box.innerHTML = mine
      ? `${icon("Check", 13)} <span data-i18n-skip>${esc(mine.version || mine.name)}</span> · <code data-i18n-skip>${esc(mine.path)}</code>`
      : `${icon("TriangleAlert", 13)} <span>이 PC에서 CLI를 찾지 못했습니다</span> (<code data-i18n-skip>${esc(p.cli)}</code>). <span>설치하고 터미널에서 한 번 실행해 로그인하세요.</span>`;
  };
  form.addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    if (t.matches("[name=kind]")) {
      read();
      p.baseUrl = "";
      p.model = "";
      models = [];
      draw();
    } else if (t.matches("[name=cli]")) {
      read();
      draw();
    }
  });
  form.addEventListener("click", async (e) => {
    if (!(e.target as HTMLElement).closest("[data-models]")) return;
    read();
    try {
      await storeKey();
      models = await api.aiModels(p);
      if (!models.length) return toast("모델 목록이 비어 있습니다", "warn");
      draw();
      toast(`모델 ${models.length}개를 불러왔습니다. 모델 칸에서 고르세요`, "success");
    } catch (err) {
      toast(`모델 목록을 읽지 못했습니다: ${errorText(err)}`, "error", 6000);
    }
  });
  m.root.querySelector("[data-test]")!.addEventListener("click", async () => {
    read();
    try {
      await storeKey();
    } catch (err) {
      return toast(errorText(err), "error");
    }
    if (!isLocal(p)) {
      const ok = await confirmDialog({ title: "연결 확인", confirm: "AI에 보내기", message: `<p><b data-i18n-skip>${esc(providerLabel(p))}</b>에 짧은 확인 질문("ping")을 보냅니다. 요금이나 사용량이 조금 들 수 있습니다.</p>` });
      if (!ok) return;
    }
    toast("응답을 기다리는 중…", "info", 2000);
    const started = performance.now();
    try {
      const answer = await ask(p, "Reply with the single word OK.", [{ role: "user", content: "ping" }], () => {}).done;
      toast(`연결됐습니다 (${((performance.now() - started) / 1000).toFixed(1)}초): ${answer.trim().slice(0, 60)}`, "success", 6000);
    } catch (err) {
      toast(`연결하지 못했습니다: ${errorText(err)}`, "error", 8000);
    }
  });
  m.root.querySelector("[data-save]")!.addEventListener("click", async () => {
    read();
    try {
      await storeKey();
    } catch (err) {
      return toast(errorText(err), "error");
    }
    if (p.kind !== "cli" && !p.model) return toast("모델을 지정하세요", "warn");
    if (kindInfo(p.kind).key === "required" && !p.credentialId) return toast("API 키를 고르거나 입력하세요", "warn");
    const list = providers();
    const at = list.findIndex((x) => x.id === p.id);
    const next = at < 0 ? [...list, p] : list.map((x) => (x.id === p.id ? p : x));
    updateSettings({ aiProviders: next, aiDefault: state.settings.aiDefault ?? p.id });
    m.close();
    saved();
    toast("AI 서비스를 저장했습니다", "success");
  });
  draw();
}
