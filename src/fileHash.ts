// A local file's SHA-256 and SHA-512 (the file browser's local side), with a
// box to paste the value the vendor publishes for an image: told at once
// whether it matches, before the file is uploaded to a device. Also for a
// file a device sent here (the file servers' and TFTP tab's received files),
// compared with the original's digest worked out on the device. Read on this
// PC only (api.localHash); nothing is sent anywhere.

import { api } from "./api";
import { writeClipboard } from "./clipboard";
import { icon } from "./icons";
import { errorText, esc, modal, toast } from "./ui";

/** A received file's hash, from the list that shows it (a file server's log, a
 * TFTP tab's transfers): a device's backup or image checked right where it
 * arrived. `path` is the saved file on this PC. */
export function openSavedFileHash(path: string) {
  openFileHash({ name: path.split(/[\\/]/).pop() || path, path }, true);
}

/** A pasted digest as the hex it stands for: case, spaces, line breaks and
 * ":" separators ("AB:CD…") left out, nothing else changed. */
const digestOf = (text: string) => text.replace(/[\s:]/g, "").toLowerCase();

/** After the upload: the same digest worked out on the device, to compare
 * with the one here. Copied only, never typed into a terminal; folded until
 * wanted. (Cisco flash names have no blanks or quotes to guard.) */
function deviceCommands(name: string, received: boolean): string {
  // Always single-quoted ("&", ";", "(" and the like are the shell's too), after
  // "--" so a name starting with "-" is never read as an option.
  const shell = `'${name.replace(/'/g, `'"'"'`)}'`;
  const rows: [string, string][] = [
    [`sha256sum -- ${shell}`, received ? "Linux·Unix 서버에서 (보낸 파일이 있는 폴더에서 실행)" : "Linux·Unix 서버에서 (올린 폴더에서 실행)"],
    [`verify /sha512 flash:${name}`, "Cisco IOS-XE 장비에서"],
  ];
  const why = received ? "장비에 있는 원본에서 같은 값이 나오는지 확인 (눌러서 복사)" : "올린 뒤 장비에서 같은 값이 나오는지 확인 (눌러서 복사)";
  return `<details class="tftp-cmds"><summary class="muted small" title="${why}">${icon("SquareTerminal", 13)}<span>장비에서 확인하는 명령</span></summary>${rows
    .map(([cmd, where]) => `<button type="button" class="ftpd-addr" data-cmd="${esc(cmd)}" title="${esc(where)}">${icon("Copy", 13)}<code data-i18n-skip>${esc(cmd)}</code></button>`)
    .join("")}</details>`;
}

/** `path`: the file on this PC; `name`: how it is shown (its file name).
 * `received`: a file a device sent here (a backup, an image), compared with
 * the original on the device rather than the vendor's published value. */
export function openFileHash(file: { name: string; path: string }, received = false) {
  const m = modal({
    title: "해시 확인",
    icon: "ShieldCheck",
    width: 620,
    body: `<p class="muted small"><b data-i18n-skip>${esc(file.name)}</b></p>
      <div class="hash-rows" data-rows><p class="muted">계산하는 중…</p></div>
      <label class="field hash-compare"><span>${received ? "비교할 값 (장비에서 계산한 SHA-256 또는 SHA-512)" : "비교할 값 (제조사가 알려 준 SHA-256 또는 SHA-512)"}</span>
        <input type="text" data-cmp spellcheck="false" autocomplete="off" placeholder="붙여 넣기" disabled /></label>
      <p class="small" data-verdict></p>
      ${deviceCommands(file.name, received)}`,
    footer: `<button class="btn btn-primary" data-close>닫기</button>`,
  });
  const rows = m.root.querySelector<HTMLElement>("[data-rows]")!;
  const cmp = m.root.querySelector<HTMLInputElement>("[data-cmp]")!;
  const verdict = m.root.querySelector<HTMLElement>("[data-verdict]")!;
  let sums: { name: string; hex: string }[] = [];
  const judge = () => {
    const want = digestOf(cmp.value);
    verdict.className = "small";
    if (!want) return void (verdict.textContent = "");
    const hit = sums.find((s) => s.hex === want);
    verdict.classList.add(hit ? "ok-text" : "danger-text");
    verdict.textContent = hit ? `${hit.name} 값과 일치합니다` : "일치하지 않습니다. 파일이 다르거나 손상되었을 수 있습니다";
  };
  cmp.addEventListener("input", judge);
  m.root.querySelectorAll<HTMLElement>("[data-cmd]").forEach((b) =>
    b.addEventListener("click", () => void writeClipboard(b.dataset.cmd!).then(() => toast("명령을 복사했습니다", "success", 1800))),
  );
  api.localHash(file.path).then(
    ([sha256, sha512]) => {
      if (!m.root.isConnected) return;
      sums = [
        { name: "SHA-256", hex: sha256 },
        { name: "SHA-512", hex: sha512 },
      ];
      rows.innerHTML = sums
        .map(
          (s, i) => `<div class="hash-row"><b>${s.name}</b><code data-i18n-skip>${esc(s.hex)}</code>
            <button class="icon-btn" data-copy="${i}" title="복사">${icon("Copy", 14)}</button></div>`,
        )
        .join("");
      rows.querySelectorAll<HTMLElement>("[data-copy]").forEach((b) =>
        b.addEventListener("click", () => void writeClipboard(sums[+b.dataset.copy!].hex).then(() => toast(`${sums[+b.dataset.copy!].name} 값을 복사했습니다`, "success", 1800))),
      );
      cmp.disabled = false;
      cmp.focus();
      judge();
    },
    (err) => {
      if (!m.root.isConnected) return;
      rows.innerHTML = `<p class="danger-text">${esc(errorText(err))}</p>`;
    },
  );
}
