// Tiny animated-GIF writer for README demos: PNG frames in (as CDP captures
// them), one GIF out, no dependencies (zlib only).
//   import { writeGif } from "./gif.mjs"; writeGif("demo.gif", [{ png, delay }])
// One global 255-colour palette (median cut over all frames); each frame stores
// only the rectangle that changed, unchanged pixels inside it transparent.
import fs from "node:fs";
import zlib from "node:zlib";

/** PNG (8-bit RGB or RGBA, not interlaced) -> { width, height, rgba }. */
export function decodePng(buf) {
  let pos = 8;
  let width = 0, height = 0, type = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (name === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new Error("only 8-bit, non-interlaced PNG");
      type = body[9];
    } else if (name === "IDAT") idat.push(body);
    else if (name === "IEND") break;
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error("PNG colour type " + type);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = line[x * bpp]; out[o + 1] = line[x * bpp + 1]; out[o + 2] = line[x * bpp + 2]; out[o + 3] = 255;
    }
    prev = line;
  }
  return { width, height, rgba: out };
}

/** Median cut over 15-bit colours weighted by count -> up to `n` [r,g,b]. */
function palette(hist, n) {
  let boxes = [[...hist.keys()]];
  const ch = (c, k) => ((c >> (10 - 5 * k)) & 31);
  while (boxes.length < n) {
    let best = -1, bestRange = 0, bestCh = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let k = 0; k < 3; k++) {
        let lo = 31, hi = 0;
        for (const c of b) { const v = ch(c, k); if (v < lo) lo = v; if (v > hi) hi = v; }
        const range = (hi - lo) * Math.log2(1 + b.reduce((s, c) => s + hist.get(c), 0));
        if (range > bestRange) { bestRange = range; best = i; bestCh = k; }
      }
    });
    if (best < 0) break;
    const b = boxes[best].sort((x, y) => ch(x, bestCh) - ch(y, bestCh));
    const total = b.reduce((s, c) => s + hist.get(c), 0);
    let acc = 0, cut = 1;
    for (; cut < b.length; cut++) { acc += hist.get(b[cut - 1]); if (acc >= total / 2) break; }
    boxes.splice(best, 1, b.slice(0, cut), b.slice(cut));
  }
  return boxes.map((b) => {
    let r = 0, g = 0, bl = 0, w = 0;
    for (const c of b) { const k = hist.get(c); r += ch(c, 0) * k; g += ch(c, 1) * k; bl += ch(c, 2) * k; w += k; }
    return [Math.round((r / w) * 255 / 31), Math.round((g / w) * 255 / 31), Math.round((bl / w) * 255 / 31)];
  });
}

/** GIF LZW for one frame's indices (code widths as gif.js grows them). */
function lzw(indices, minSize) {
  const out = [];
  let cur = 0, bits = 0;
  const clear = 1 << minSize, end = clear + 1;
  let size = minSize + 1, next = end + 1;
  let dict = new Map();
  const emit = (code) => {
    cur |= code << bits;
    bits += size;
    while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; }
    // The decoder widens once the next free code no longer fits.
    if (next > (1 << size) - 1 && size < 12) size++;
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) dict.set(key, next++);
    else {
      emit(clear);
      dict = new Map();
      size = minSize + 1;
      next = end + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(end);
  if (bits > 0) out.push(cur & 255);
  return Buffer.from(out);
}

const sub = (data) => {
  const parts = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, i + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
};

/** frames: [{ png: Buffer, delay: ms }] -> GIF file (loops forever). */
export function writeGif(file, frames) {
  const imgs = frames.map((f) => ({ ...decodePng(f.png), delay: f.delay }));
  const { width, height } = imgs[0];
  const TRANSPARENT = 255;
  // Palette from every 3rd pixel of every frame.
  const hist = new Map();
  for (const im of imgs)
    for (let o = 0; o < im.rgba.length; o += 12) {
      const c = ((im.rgba[o] >> 3) << 10) | ((im.rgba[o + 1] >> 3) << 5) | (im.rgba[o + 2] >> 3);
      hist.set(c, (hist.get(c) ?? 0) + 1);
    }
  const pal = palette(hist, 255);
  while (pal.length < 256) pal.push([0, 0, 0]);
  // 15-bit colour -> nearest palette index (never the transparent slot).
  const near = new Uint8Array(32768);
  for (let c = 0; c < 32768; c++) {
    const r = ((c >> 10) & 31) * 255 / 31, g = ((c >> 5) & 31) * 255 / 31, b = (c & 31) * 255 / 31;
    let best = 0, bd = Infinity;
    for (let i = 0; i < 255; i++) {
      const d = (pal[i][0] - r) ** 2 * 3 + (pal[i][1] - g) ** 2 * 4 + (pal[i][2] - b) ** 2 * 2;
      if (d < bd) { bd = d; best = i; }
    }
    near[c] = best;
  }
  const out = [];
  out.push(Buffer.from("GIF89a", "latin1"));
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0); lsd.writeUInt16LE(height, 2); lsd[4] = 0xf7; lsd[5] = 0; lsd[6] = 0;
  out.push(lsd, Buffer.from(pal.flat()));
  out.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from("NETSCAPE2.0", "latin1"), Buffer.from([3, 1, 0, 0, 0]));
  let prev = null;
  for (const im of imgs) {
    const idx = new Uint8Array(width * height);
    for (let p = 0, o = 0; p < idx.length; p++, o += 4)
      idx[p] = near[((im.rgba[o] >> 3) << 10) | ((im.rgba[o + 1] >> 3) << 5) | (im.rgba[o + 2] >> 3)];
    let x0 = 0, y0 = 0, x1 = width - 1, y1 = height - 1;
    if (prev) {
      x0 = width; y0 = height; x1 = -1; y1 = -1;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          if (idx[y * width + x] !== prev[y * width + x]) {
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
      if (x1 < 0) { x0 = y0 = 0; x1 = y1 = 0; } // nothing changed: one transparent pixel
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const part = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = (y + y0) * width + x + x0;
        part[y * w + x] = prev && idx[p] === prev[p] ? TRANSPARENT : idx[p];
      }
    const gce = Buffer.from([0x21, 0xf9, 4, prev ? 0x05 : 0x04, 0, 0, TRANSPARENT, 0]);
    gce.writeUInt16LE(Math.round(im.delay / 10), 4);
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c; desc.writeUInt16LE(x0, 1); desc.writeUInt16LE(y0, 3); desc.writeUInt16LE(w, 5); desc.writeUInt16LE(h, 7); desc[9] = 0;
    out.push(gce, desc, Buffer.from([8]), sub(lzw(part, 8)));
    prev = idx;
  }
  out.push(Buffer.from([0x3b]));
  fs.writeFileSync(file, Buffer.concat(out));
  return { width, height, frames: imgs.length, bytes: fs.statSync(file).size };
}
