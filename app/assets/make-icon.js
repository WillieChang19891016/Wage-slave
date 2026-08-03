// 產生 app icon（icon.ico）— 零依賴，node assets/make-icon.js 重新生成。
// 設計：深色圓角終端機視窗（app 同款配色）+ 紅黃綠窗鈕 + 綠色 prompt > + 藍色游標。
// ICO 內含 16/24/32/48（BMP）+ 256（PNG）五種尺寸。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- 調色盤（跟 styles.css 一致）----
const BG = hex('#0d1117');
const TITLE = hex('#161b22');
const GREEN = hex('#3fb950');
const BLUE = hex('#58a6ff');
const DOTS = [hex('#ff5f56'), hex('#ffbd2e'), hex('#27c93f')];

function hex(s) {
  return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
}
const clamp = (x) => Math.max(0, Math.min(1, x));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// ---- 幾何（normalized 0..1，v 軸向下）----
const M = 0.035; // 外邊距
const R0 = 0.115; // 圓角半徑
const TITLE_H = M + 0.16;

function sdRoundRect(u, v) {
  const qx = Math.abs(u - 0.5) - (0.5 - M - R0);
  const qy = Math.abs(v - 0.5) - (0.5 - M - R0);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - R0;
}

function sdSegment(u, v, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = clamp(((u - x1) * dx + (v - y1) * dy) / (dx * dx + dy * dy));
  return Math.hypot(u - (x1 + dx * t), v - (y1 + dy * t));
}

// 單一取樣點的顏色 → [r,g,b,a]（線性混合，e = 1px 的 normalized 寬度做 AA）
function shade(u, v, e) {
  const d = sdRoundRect(u, v);
  const shapeA = clamp(0.5 - d / e);
  if (shapeA <= 0) return [0, 0, 0, 0];

  let c = v < TITLE_H ? TITLE : BG;

  // 窗鈕三顆
  for (let i = 0; i < 3; i++) {
    const dd = Math.hypot(u - (M + 0.09 + i * 0.085), v - (M + 0.082)) - 0.034;
    c = mix(c, DOTS[i], clamp(0.5 - dd / e));
  }

  // prompt「>」（兩段線）
  const th = 0.048;
  const dc = Math.min(
    sdSegment(u, v, 0.24, 0.40, 0.44, 0.58),
    sdSegment(u, v, 0.44, 0.58, 0.24, 0.76)
  ) - th;
  c = mix(c, GREEN, clamp(0.5 - dc / e));

  // 游標底線
  const inX = Math.min(u - 0.52, 0.78 - u);
  const inY = Math.min(v - 0.70, 0.765 - v);
  c = mix(c, BLUE, clamp(0.5 + Math.min(inX, inY) / e));

  return [...c, shapeA];
}

// 2x supersample 渲染成 RGBA（straight alpha）
function render(S) {
  const img = Buffer.alloc(S * S * 4);
  const e = 1 / S;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const [sr, sg, sb, sa] = shade((x + ox) / S, (y + oy) / S, e);
        r += sr * sa; g += sg * sa; b += sb * sa; a += sa; // premultiply 再平均，避免邊緣黑邊
      }
      a /= 4;
      const o = (y * S + x) * 4;
      if (a > 0) {
        img[o] = Math.round((r / 4 / a) * 255);
        img[o + 1] = Math.round((g / 4 / a) * 255);
        img[o + 2] = Math.round((b / 4 / a) * 255);
        img[o + 3] = Math.round(a * 255);
      }
    }
  }
  return img;
}

// ---- PNG 編碼（IHDR/IDAT/IEND + CRC32）----
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function toPng(img, S) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) img.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO 的 BMP entry（32bpp BGRA，上下顛倒 + AND mask）----
function toBmp(img, S) {
  const andStride = Math.ceil(S / 32) * 4;
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(S, 4);
  head.writeInt32LE(S * 2, 8); // ICO 慣例：高度含 AND mask 要 ×2
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(S * S * 4 + andStride * S, 20);
  const px = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const s = ((S - 1 - y) * S + x) * 4; // bottom-up
      const o = (y * S + x) * 4;
      px[o] = img[s + 2]; px[o + 1] = img[s + 1]; px[o + 2] = img[s]; px[o + 3] = img[s + 3];
    }
  }
  return Buffer.concat([head, px, Buffer.alloc(andStride * S)]); // AND mask 全 0，走 alpha
}

// ---- 組 ICO ----
const sizes = [16, 24, 32, 48, 256];
const images = sizes.map((S) => {
  const img = render(S);
  return { S, data: S === 256 ? toPng(img, 256) : toBmp(img, S) };
});
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
const entries = [];
let offset = 6 + images.length * 16;
for (const { S, data } of images) {
  const e = Buffer.alloc(16);
  e[0] = S === 256 ? 0 : S;
  e[1] = S === 256 ? 0 : S;
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += data.length;
}
const out = path.join(__dirname, 'icon.ico');
fs.writeFileSync(out, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
console.log(`寫出 ${out}（${sizes.join('/')}px，${fs.statSync(out).size} bytes）`);
