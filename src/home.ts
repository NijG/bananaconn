// Home screen shown when no tabs are open.

// The app icon itself (an emoji would look different on every Windows version).
import icon48 from "./assets/app-icon-48.png";
import icon96 from "./assets/app-icon-96.png";
import { icon } from "./icons";
import { endpoint, PROTOCOL_ORDER, PROTOCOLS, type Protocol, type Session } from "./model";
import { ACTIONS, bindings } from "./keymap";
import { state, subscribe } from "./store";

/** The shortcuts the home screen lists (their current keys). */
const HOME_KEYS = ["app.newSession", "app.quickConnect", "tab.next", "tab.close", "term.find", "app.toggleSidebar"];
import { esc, relativeTime } from "./ui";

export function mountHome(
  root: HTMLElement,
  actions: { create(p: Protocol): void; connect(s: Session): void; vault(): void },
) {
  const render = () => {
    const recent = [...state.sessions]
      .filter((s) => s.lastUsed)
      .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
      .slice(0, 6);
    root.innerHTML = `<div class="home-inner">
        <header class="home-hero">
          <div class="hero-mark"><img src="${icon48}" srcset="${icon48} 1x, ${icon96} 2x" width="48" height="48" alt="" draggable="false" /></div>
          <div><h1><span class="brand-y">Banana</span><span class="brand-c">Conn</span><span class="brand-x">.</span></h1><p>SSH · Telnet · SFTP · FTP · FTPS · TFTP · RDP · VNC를 한 곳에서</p></div>
        </header>
        <section>
          <h3>새 연결</h3>
          <div class="proto-cards">${PROTOCOL_ORDER.map((p) => {
            const info = PROTOCOLS[p];
            return `<button class="proto-card" data-create="${p}" style="--proto:${info.color}">
                <span class="pc-icon">${icon(info.icon, 22)}</span><b>${info.label}</b><small>${info.desc}</small></button>`;
          }).join("")}</div>
        </section>
        <div class="home-cols">
          <section>
            <h3>최근 연결</h3>
            ${
              recent.length
                ? `<div class="recent">${recent
                    .map((s) => {
                      const info = PROTOCOLS[s.protocol];
                      return `<button class="recent-item" data-id="${s.id}" style="--proto:${info.color}">
                        <span class="proto-ico">${icon(info.icon, 16)}</span>
                        <span class="ri-text"><b>${esc(s.name)}</b><small>${esc(endpoint(s))}</small></span>
                        <span class="ri-time">${relativeTime(s.lastUsed)}</span></button>`;
                    })
                    .join("")}</div>`
                : `<p class="muted">아직 연결한 세션이 없습니다. 위에서 프로토콜을 골라 시작하세요.</p>`
            }
          </section>
          <section>
            <h3>단축키</h3>
            <dl class="keys">${HOME_KEYS.map((id) => {
              const keys = bindings(id);
              const label = ACTIONS.find((a) => a.id === id)?.label ?? id;
              return keys.length ? `<dt>${keys.map((k) => k.split("+").map((p) => `<kbd>${esc(p)}</kbd>`).join("+")).join(" · ")}</dt><dd>${esc(label)}</dd>` : "";
            }).join("")}</dl>
            <div class="row"><button class="btn" data-shortcuts>${icon("Keyboard", 14)}단축키 설정</button>
              <button class="btn" data-vault>${icon("KeyRound", 14)}자격 증명 보관함</button></div>
          </section>
        </div>
      </div>`;
    root.querySelectorAll<HTMLElement>("[data-create]").forEach((b) =>
      b.addEventListener("click", () => actions.create(b.dataset.create as Protocol)),
    );
    root.querySelectorAll<HTMLElement>("[data-id]").forEach((b) =>
      b.addEventListener("click", () => {
        const s = state.sessions.find((x) => x.id === b.dataset.id);
        if (s) actions.connect(s);
      }),
    );
    root.querySelector("[data-vault]")!.addEventListener("click", () => actions.vault());
    root.querySelector("[data-shortcuts]")!.addEventListener("click", () => void import("./shortcuts").then((m) => m.openShortcuts()));
  };
  subscribe("sessions", render);
  // The shortcut list follows the user's keys.
  subscribe("settings", render);
  // Shown again after the last tab closed: "방금 전" from an hour ago must be
  // recomputed. The workspace shows it by clearing `hidden`.
  new MutationObserver(() => {
    if (!root.hidden) render();
  }).observe(root, { attributes: true, attributeFilter: ["hidden"] });
  render();
}
