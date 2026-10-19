// Taskbar icon proposals: the BananaConn. mark with an outline or on a fixed
// background, so it stays visible on light and dark taskbars.
//   node design/taskbar-variants.cjs -> design/variants/*.svg + preview.html
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "variants");
fs.mkdirSync(dir, { recursive: true });
const src = fs.readFileSync(path.join(__dirname, "bananaconn-mark.svg"), "utf8");
const inner = src.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const VB = [-25, -10, 860, 860];

// The mark scaled into a 1024 canvas: `scale` of the canvas, centred.
const mark = (id, scale, extra = "") => {
  const s = (1024 * scale) / VB[2];
  const off = (1024 * (1 - scale)) / 2;
  return `<g transform="translate(${off} ${off}) scale(${s}) translate(${-VB[0]} ${-VB[1]})"${extra}>${inner.replace(/id="(\w+)"/g, `id="${id}$1"`).replace(/url\(#(\w+)\)/g, `url(#${id}$1)`)}</g>`;
};
// Outline: the silhouette grown by `r` (in 1024 units) in `color`, drawn behind.
const outline = (id, layers) => `<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%">
  ${layers.map(([r, c], i) => `<feMorphology in="SourceAlpha" operator="dilate" radius="${r}" result="d${i}"/><feFlood flood-color="${c}"/><feComposite in2="d${i}" operator="in" result="s${i}"/>`).join("")}
  <feMerge>${layers.map((_, i) => `<feMergeNode in="s${layers.length - 1 - i}"/>`).join("")}<feMergeNode in="SourceGraphic"/></feMerge></filter>`;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${body}</svg>`;

const variants = [
  {
    key: "1-dark-outline",
    title: "1. 어두운 테두리",
    note: "지금 모양 그대로, 바깥에 짙은 갈색 테두리. 배경은 투명",
    body: svg(`<defs>${outline("f1", [[26, "#2a1d08"]])}</defs><g filter="url(#f1)">${mark("a", 0.86)}</g>`),
  },
  {
    key: "2-sticker",
    title: "2. 스티커 (흰색 + 어두운 이중 테두리)",
    note: "흰 테두리 바깥에 얇은 짙은 선. 어떤 배경에서도 윤곽이 보임",
    body: svg(`<defs>${outline("f2", [[30, "#ffffff"], [44, "#2a1d08"]])}</defs><g filter="url(#f2)">${mark("b", 0.82)}</g>`),
  },
  {
    key: "3-dark-tile",
    title: "3. 어두운 둥근 사각 배경",
    note: "앱 배경색(#11141B) 타일 위에 로고. 앱 화면과 같은 느낌",
    body: svg(`<defs><linearGradient id="g3" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c212c"/><stop offset="1" stop-color="#0b0d12"/></linearGradient></defs>
      <rect x="40" y="40" width="944" height="944" rx="200" fill="url(#g3)"/><rect x="40" y="40" width="944" height="944" rx="200" fill="none" stroke="#3a4152" stroke-width="12"/>${mark("c", 0.74)}`),
  },
  {
    key: "4-dark-circle",
    title: "4. 어두운 원형 배지",
    note: "원 안에 로고. 둥근 모양이라 다른 아이콘과 겹쳐 보이지 않음",
    body: svg(`<defs><radialGradient id="g4" cx="0.5" cy="0.35" r="0.7"><stop offset="0" stop-color="#232937"/><stop offset="1" stop-color="#0b0d12"/></radialGradient></defs>
      <circle cx="512" cy="512" r="480" fill="url(#g4)"/><circle cx="512" cy="512" r="474" fill="none" stroke="#3a4152" stroke-width="12"/>${mark("d", 0.72)}`),
  },
  {
    key: "5-cone-tile",
    title: "5. 와플콘색 둥근 사각 배경",
    note: "따뜻한 갈색 타일 위에 로고. 콘에 짙은 테두리를 더해 타일과 구분",
    body: svg(`<defs><linearGradient id="g5" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6b4220"/><stop offset="1" stop-color="#3a230f"/></linearGradient>${outline("f5", [[14, "#24160a"]])}</defs>
      <rect x="40" y="40" width="944" height="944" rx="200" fill="url(#g5)"/><g filter="url(#f5)">${mark("e", 0.74)}</g>`),
  },
  {
    key: "6-gold-outline",
    title: "6. 진한 노랑 테두리 (투명)",
    note: "바나나와 같은 계열의 진한 금색 선. 가장 원래 모양에 가깝지만 밝은 배경에서 효과는 약함",
    body: svg(`<defs>${outline("f6", [[22, "#a87a00"]])}</defs><g filter="url(#f6)">${mark("f", 0.86)}</g>`),
  },
];
for (const v of variants) fs.writeFileSync(path.join(dir, `${v.key}.svg`), v.body);

// Taskbar colours: Windows 11 dark and light, and Windows 10 dark.
const bars = [["#1f1f1f", "다크 작업 표시줄"], ["#f3f3f3", "라이트 작업 표시줄"], ["#dfe7f3", "라이트 + 강조색"]];
const row = (v) => `<div class="v"><div class="t"><b>${v.title}</b><span>${v.note}</span></div>
  <div class="cells"><img class="big" src="variants/${v.key}.svg">${bars.map(([c, n]) => `<div class="bar" style="background:${c}" title="${n}">${[48, 32, 24, 16].map((s) => `<img src="variants/${v.key}.svg" width="${s}" height="${s}">`).join("")}</div>`).join("")}</div></div>`;
const head = `<div class="v hdr"><div class="t"></div><div class="cells"><div class="big"></div>${bars.map(([, n]) => `<div class="bar lbl">${n}<br><small>48 · 32 · 24 · 16 px</small></div>`).join("")}</div></div>`;
fs.writeFileSync(
  path.join(__dirname, "taskbar-preview.html"),
  `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;padding:18px 20px;background:#2b2f38;font-family:"Segoe UI","Malgun Gothic",sans-serif;color:#e6e8ee;width:1260px}
  .v{display:flex;align-items:center;gap:16px;padding:10px 0;border-bottom:1px solid #3a3f4b}
  .t{width:300px;display:flex;flex-direction:column;gap:4px}.t span{font-size:13px;color:#aab0bd;line-height:1.35}
  .cells{display:flex;align-items:center;gap:14px}.big{width:96px;height:96px}
  .bar{display:flex;align-items:center;gap:16px;padding:10px 16px;border-radius:8px;width:230px;height:60px;box-sizing:border-box}
  .lbl{background:none;height:auto;font-size:13px;color:#cfd3dc;display:block}.lbl small{color:#8a91a0}
  .hdr{padding:0 0 6px}
</style>${head}${variants.map(row).join("")}`,
);
console.log(variants.length + " variants");
