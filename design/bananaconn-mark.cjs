// BananaConn. mark: a peeled banana on a waffle cone with a red dot on the
// banana's tip, drawn in the coordinates of the logo's 4x crop (800x860).
// The dot is drawn here to scale; dotpixel.ps1 then sets its centre pixel to
// pure red at every size, so even 16 px icons show a red pixel.
//
//   node design/bananaconn-mark.cjs   -> design/bananaconn-mark.svg (+ dot centre)
const fs = require("fs");
const BANANA = `M 42 405 C 60 360, 160 285, 250 268 C 280 262, 292 170, 325 105
  C 350 58, 375 40, 396 39 C 417 40, 442 58, 467 105
  C 500 170, 512 262, 542 268 C 632 285, 735 360, 750 400
  C 755 420, 720 440, 640 445 C 560 448, 455 420, 397 314
  C 340 420, 250 448, 160 440 C 80 435, 35 425, 42 405 Z`;
// The top rises to a point behind the banana so the notch between the two
// flaps shows cone, not a dark triangle; the sides keep their slope.
const CONE = `M 193 330 L 397 288 L 591 330 L 400 805 Q 385 832 370 805 Z`;
const DOT = { cx: 396, cy: 30, r: 26 };
const lines = [];
for (let k = -400; k <= 1200; k += 92) {
  lines.push(`<line x1="${k}" y1="300" x2="${k + 600}" y2="900"/>`, `<line x1="${k}" y1="300" x2="${k - 600}" y2="900"/>`);
}
// Square canvas around the mark (x 35..755, y 4..832).
const VB = "-25 -10 860 860";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB}" width="1024" height="1024">
<defs>
  <clipPath id="cone"><path d="${CONE}"/></clipPath>
  <mask id="gap" maskUnits="userSpaceOnUse" x="-100" y="-100" width="1100" height="1100">
    <rect x="-100" y="-100" width="1100" height="1100" fill="#fff"/>
    <path d="${BANANA}" fill="#000" stroke="#000" stroke-width="26" stroke-linejoin="round"/>
  </mask>
</defs>
<g mask="url(#gap)">
  <path d="${CONE}" fill="#D1914B"/>
  <g clip-path="url(#cone)" stroke="#9D622B" stroke-width="17">${lines.join("")}</g>
</g>
<path d="${BANANA}" fill="#FEDB2E"/>
<circle cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.r}" fill="#E8302C"/>
</svg>`;
fs.writeFileSync(__dirname + "/bananaconn-mark.svg", svg);
// Dot centre in a 1024 render of the viewBox (for dotpixel.ps1 -DotX -DotY).
const [vx, vy, vw] = VB.split(" ").map(Number);
console.log(JSON.stringify({ dotX: ((DOT.cx - vx) / vw) * 1024, dotY: ((DOT.cy - vy) / vw) * 1024 }));
