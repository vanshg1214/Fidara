// Draws the home-screen icons (Fidara paw on forest green) into ../public/icons. No dependencies.
// Run: node make-icons.js    To use your own artwork instead, just replace the PNG files with the same names and sizes.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const BG = [0x1F, 0x5C, 0x45], FG = [0xFF, 0xC9, 0x3C];
// paw in a 64x64 box: four toes and a pad (ellipses: cx, cy, rx, ry)
const PAW = [[14, 26, 7, 9], [27, 14, 7, 10], [42, 14, 7, 10], [53, 27, 7, 9], [32, 43.5, 17.5, 12.5], [32, 36, 11, 8]];
const inPaw = (x, y) => PAW.some(([cx, cy, rx, ry]) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1);

// kind: 'rounded' (any-purpose, transparent corners) | 'full' (square, for maskable/iOS: the OS rounds it)
function render(size, kind, pawScale) {
  const px = Buffer.alloc(size * size * 4), SS = 4, R = size * 0.22;
  const inShape = (x, y) => {
    if (kind === 'full') return true;
    const dx = Math.max(R - x, 0, x - (size - R)), dy = Math.max(R - y, 0, y - (size - R));
    return dx * dx + dy * dy <= R * R;
  };
  const s = size * pawScale / 64, off = (size - 64 * s) / 2 + 0.5; // paw centred, nudged so the visual centre sits in the middle
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let a = 0, paw = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
      const sx = x + (i + .5) / SS, sy = y + (j + .5) / SS;
      if (inShape(sx, sy)) { a++; if (inPaw((sx - off) / s, (sy - off) / s)) paw++; }
    }
    const n = SS * SS, o = (y * size + x) * 4, t = a ? paw / a : 0;
    px[o] = Math.round(BG[0] + (FG[0] - BG[0]) * t); px[o + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * t); px[o + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * t);
    px[o + 3] = Math.round(255 * a / n);
  }
  return px;
}
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const files = [['icon-192.png', 192, 'rounded', .74], ['icon-512.png', 512, 'rounded', .74], ['icon-maskable-512.png', 512, 'full', .52], ['apple-touch-icon.png', 180, 'full', .66]];
files.forEach(([name, size, kind, k]) => { fs.writeFileSync(path.join(OUT, name), png(size, render(size, kind, k))); console.log('wrote icons/' + name); });
