/* 从 icon.svg 生成 PWA 用的 PNG 图标（纯 Node，无需外部库） */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePNG(w, h, pix) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const p = pix(x, y), o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = p[0]; raw[o + 1] = p[1]; raw[o + 2] = p[2]; raw[o + 3] = p[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}
/** 与应用图标同款：圆角底 + 照片框 + 蓝色虚线选区 */
function icon(size) {
  const S = size;
  return writePNG(S, S, (x, y) => {
    const u = x / S, v = y / S, rad = 0.22;
    const cx = Math.min(Math.max(u, rad), 1 - rad), cy = Math.min(Math.max(v, rad), 1 - rad);
    if (Math.hypot(u - cx, v - cy) > rad) return [0, 0, 0, 0];
    const t = (u + v) / 2;
    const bg = [Math.round(27 + (13 - 27) * t), Math.round(34 + (16 - 34) * t), Math.round(48 + (23 - 48) * t)];
    const [fx0, fy0, fx1, fy1] = [0.19, 0.235, 0.81, 0.765];
    if (u >= fx0 && u <= fx1 && v >= fy0 && v <= fy1) {
      const hy = 0.62 + 0.13 * Math.abs(u - 0.5) * 2;
      if (v > hy - 0.06 && v < fy1) return [40, 52, 72, 255];
      if (Math.hypot(u - 0.34, v - 0.36) < 0.055) return [51, 64, 90, 255];
      return [24, 30, 42, 255];
    }
    const onV = (Math.abs(u - fx0) < 0.014 || Math.abs(u - fx1) < 0.014) && v >= fy0 - 0.02 && v <= fy1 + 0.02;
    const onH = (Math.abs(v - fy0) < 0.014 || Math.abs(v - fy1) < 0.014) && u >= fx0 - 0.02 && u <= fx1 + 0.02;
    if (onV || onH) return [51, 64, 90, 255];
    const [sx0, sy0, sx1, sy1] = [0.35, 0.40, 0.70, 0.70];
    if ((Math.abs(u - sx0) < 0.022 || Math.abs(u - sx1) < 0.022) && v >= sy0 && v <= sy1 && Math.floor(v * 14) % 2 === 0) return [108, 184, 255, 255];
    if ((Math.abs(v - sy0) < 0.022 || Math.abs(v - sy1) < 0.022) && u >= sx0 && u <= sx1 && Math.floor(u * 14) % 2 === 0) return [108, 184, 255, 255];
    for (const [hx, hy2] of [[sx0, sy0], [sx1, sy0], [sx0, sy1], [sx1, sy1]]) {
      if (Math.hypot(u - hx, v - hy2) < 0.032) return [255, 255, 255, 255];
    }
    if (Math.hypot(u - 0.80, v - 0.20) < 0.075) return [108, 184, 255, 255];
    return [bg[0], bg[1], bg[2], 255];
  });
}
const out = process.argv[2] || path.join(__dirname, '..', 'app');
fs.mkdirSync(out, { recursive: true });
for (const s of [192, 512]) {
  fs.writeFileSync(path.join(out, `icon-${s}.png`), icon(s));
}
console.log('图标已生成：icon-192.png / icon-512.png → ' + out);
