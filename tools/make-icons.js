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
/** 超采样渲染：把 fn 在 ss×ss 个子像素上求平均，消除锯齿 */
function renderPNG(size, fn, ss) {
  const n = Math.max(1, ss | 0);
  return writePNG(size, size, (x, y) => {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < n; sy++) {
      for (let sx = 0; sx < n; sx++) {
        const p = fn((x + (sx + 0.5) / n) / size, (y + (sy + 0.5) / n) / size);
        const al = p[3] / 255;
        r += p[0] * al; g += p[1] * al; b += p[2] * al; a += al;
      }
    }
    const total = n * n;
    if (a <= 0) return [0, 0, 0, 0];
    // 按 alpha 加权还原颜色，避免边缘发黑
    return [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(255 * a / total)];
  });
}

/** 圆角矩形的内部判定（含圆角） */
function inRoundRect(u, v, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  if (Math.hypot(u - cx, v - cy) > r) return false;
  return u >= x0 && u <= x1 && v >= y0 && v <= y1;
}

/**
 * 通知栏小图标。
 *
 * 规则（Android 强制）：必须是**纯白 + 透明底**的剪影，系统会自己染色。
 * 带彩色的图会被系统直接涂成一坨白块，看不出形状。
 * 尺寸按 24dp 出，各密度分别生成。
 */
function statIcon(size) {
  return renderPNG(size, (u, v) => {
    // 相框：外圆角矩形 - 内圆角矩形 = 边框
    const x0 = 0.09, y0 = 0.15, x1 = 0.91, y1 = 0.85, r = 0.13;
    const bw = 0.085;
    const outer = inRoundRect(u, v, x0, y0, x1, y1, r);
    const inner = inRoundRect(u, v, x0 + bw, y0 + bw, x1 - bw, y1 - bw, Math.max(0.02, r - bw));
    if (outer && !inner) return [255, 255, 255, 255];
    // 框内的「山 + 太阳」：一眼认出是照片
    if (inner) {
      // 太阳
      if (Math.hypot(u - 0.36, v - 0.38) < 0.062) return [255, 255, 255, 255];
      // 山：两条斜边构成的三角
      const by = y1 - bw;             // 底线
      const peakY = 0.50, leftX = 0.22, rightX = 0.78, peakX = 0.56;
      if (v <= by && v >= peakY) {
        // 在峰高范围内，判断是否落在三角形里
        const t = (v - peakY) / (by - peakY);      // 0=峰顶 1=底
        const lo = peakX + (leftX - peakX) * t;
        const hi = peakX + (rightX - peakX) * t;
        if (u >= lo && u <= hi) return [255, 255, 255, 255];
      }
    }
    return [0, 0, 0, 0];
  }, 4);
}

const out = process.argv[2] || path.join(__dirname, '..', 'app');
fs.mkdirSync(out, { recursive: true });
for (const s of [192, 512]) {
  fs.writeFileSync(path.join(out, `icon-${s}.png`), icon(s));
}
console.log('图标已生成：icon-192.png / icon-512.png → ' + out);

// 第二个参数是 Android res 目录：额外生成通知栏图标（各密度）
const resDir = process.argv[3];
if (resDir) {
  // 通知图标按 24dp，各密度对应像素数
  const DENSITIES = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 };
  for (const [d, px] of Object.entries(DENSITIES)) {
    const dir = path.join(resDir, 'drawable-' + d);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_stat_photostudio.png'), statIcon(px));
  }
  console.log('通知图标已生成（5 种密度）→ ' + resDir + '/drawable-*');
}
