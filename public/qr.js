/* Minimal QR Code generator (byte mode, ISO/IEC 18004). No dependencies.
   FidaraQR.encode(text, 'M') -> { size, get(x, y) }   FidaraQR.svg(text, opts) -> SVG string */
(function (root) {
  const ECC = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]];
  const BLK = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]];
  const ECL = { L: [0, 1], M: [1, 0], Q: [2, 3], H: [3, 2] };
  const bit = (x, i) => ((x >>> i) & 1) !== 0;
  const rawModules = (v) => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; };
  const dataCW = (v, e) => Math.floor(rawModules(v) / 8) - ECC[e][v] * BLK[e][v];
  const gmul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 255; };
  function rsDiv(d) { const r = new Array(d).fill(0); r[d - 1] = 1; let root = 1; for (let i = 0; i < d; i++) { for (let j = 0; j < d; j++) { r[j] = gmul(r[j], root); if (j + 1 < d) r[j] ^= r[j + 1]; } root = gmul(root, 2); } return r; }
  function rsRem(data, div) { const r = div.map(() => 0); for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= gmul(c, f); }); } return r; }
  const utf8 = (s) => Array.from(new TextEncoder().encode(s));

  function encode(text, level) {
    const [e, fmtE] = ECL[level || 'M'];
    const data = utf8(text);
    let v = 1;
    for (; v <= 40; v++) { const need = 4 + (v <= 9 ? 8 : 16) + data.length * 8; if (need <= dataCW(v, e) * 8) break; }
    if (v > 40) throw new Error('Text too long for a QR code');
    const cap = dataCW(v, e) * 8, bits = [];
    const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(data.length, v <= 9 ? 8 : 16); data.forEach((b) => put(b, 8));
    put(0, Math.min(4, cap - bits.length)); put(0, (8 - bits.length % 8) % 8);
    for (let p = 0xEC; bits.length < cap; p ^= 0xEC ^ 0x11) put(p, 8);
    const cw = []; for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; cw.push(b); }
    // ECC + interleave
    const nb = BLK[e][v], el = ECC[e][v], raw = Math.floor(rawModules(v) / 8), nShort = nb - raw % nb, shortLen = Math.floor(raw / nb), div = rsDiv(el), blocks = [];
    for (let i = 0, k = 0; i < nb; i++) { const d = cw.slice(k, k + shortLen - el + (i < nShort ? 0 : 1)); k += d.length; const ec = rsRem(d, div); if (i < nShort) d.push(0); blocks.push(d.concat(ec)); }
    const all = []; for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - el || j >= nShort) all.push(b[i]); });
    // matrix
    const size = v * 4 + 17, M = [], F = [];
    for (let y = 0; y < size; y++) { M.push(new Array(size).fill(false)); F.push(new Array(size).fill(false)); }
    const setF = (x, y, d) => { M[y][x] = d; F[y][x] = true; };
    for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy; if (x >= 0 && x < size && y >= 0 && y < size) setF(x, y, d !== 2 && d !== 4); } };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    let al = [];
    if (v > 1) { const n = Math.floor(v / 7) + 2, step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2; al = [6]; for (let p = size - 7; al.length < n; p -= step) al.splice(1, 0, p); }
    al.forEach((a, i) => al.forEach((b, j) => { if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
    const drawFormat = (mask) => {
      const d = (fmtE << 3) | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      const b = ((d << 10) | r) ^ 0x5412;
      for (let i = 0; i <= 5; i++) setF(8, i, bit(b, i));
      setF(8, 7, bit(b, 6)); setF(8, 8, bit(b, 7)); setF(7, 8, bit(b, 8));
      for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(b, i));
      for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(b, i));
      for (let i = 8; i < 15; i++) setF(8, size - 15 + i, bit(b, i));
      setF(8, size - 8, true);
    };
    drawFormat(0);
    if (v >= 7) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25); const b = (v << 12) | r; for (let i = 0; i < 18; i++) { const x = size - 11 + i % 3, y = Math.floor(i / 3); setF(x, y, bit(b, i)); setF(y, x, bit(b, i)); } }
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!F[y][x] && i < all.length * 8) { M[y][x] = bit(all[i >>> 3], 7 - (i & 7)); i++; }
      }
    }
    const maskFn = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
      (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
    const applyMask = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!F[y][x] && maskFn[m](x, y)) M[y][x] = !M[y][x]; };
    const penalty = () => {
      let p = 0, dark = 0;
      const line = (get) => { for (let a = 0; a < size; a++) { let run = 1; for (let b = 1; b <= size; b++) { if (b < size && get(a, b) === get(a, b - 1)) run++; else { if (run >= 5) p += run - 2; run = 1; } } } };
      line((a, b) => M[a][b]); line((a, b) => M[b][a]);
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = M[y][x]; if (c === M[y][x + 1] && c === M[y + 1][x] && c === M[y + 1][x + 1]) p += 3; }
      const pat = [1, 0, 1, 1, 1, 0, 1], chk = (get) => { for (let a = 0; a < size; a++) for (let b = 0; b + 7 <= size; b++) {
        if (!pat.every((q, k) => get(a, b + k) === !!q)) continue;
        const lightBefore = b >= 4 && [1, 2, 3, 4].every((k) => !get(a, b - k)), lightAfter = b + 11 <= size && [7, 8, 9, 10].every((k) => !get(a, b + k));
        if (lightBefore || lightAfter) p += 40; } };
      chk((a, b) => M[a][b]); chk((a, b) => M[b][a]);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (M[y][x]) dark++;
      p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
      return p;
    };
    let best = 0, bestP = Infinity;
    for (let m = 0; m < 8; m++) { applyMask(m); drawFormat(m); const p = penalty(); if (p < bestP) { bestP = p; best = m; } applyMask(m); }
    applyMask(best); drawFormat(best);
    return { size, version: v, get: (x, y) => x >= 0 && y >= 0 && x < size && y < size && M[y][x] };
  }

  function svg(text, o) {
    o = o || {}; const q = encode(text, o.level || 'M'), b = o.border == null ? 4 : o.border, n = q.size + b * 2;
    let d = ''; for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.get(x, y)) d += 'M' + (x + b) + ',' + (y + b) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges"' + (o.px ? ' width="' + o.px + '" height="' + o.px + '"' : '') +
      '><rect width="100%" height="100%" fill="' + (o.light || '#fff') + '"/><path d="' + d + '" fill="' + (o.dark || '#000') + '"/></svg>';
  }
  const api = { encode, svg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FidaraQR = api;
})(typeof self !== 'undefined' ? self : this);
