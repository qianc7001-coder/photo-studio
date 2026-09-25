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
/**
 * 应用图标：亮蓝底 + 白色相框照片 + 虚线选区。
 *
 * 设计约束（都是踩过的坑）：
 *   1. **底色必须够亮** —— 之前用 #1b2230 深灰蓝，在深色壁纸/深色主题上
 *      跟背景糊成一片，用户会以为「没有图标」。改成亮蓝渐变后任何壁纸都看得清。
 *   2. **缩到 48px 仍要能认** —— 桌面图标最小显示尺寸很小，
 *      细节太多会糊成一团。所以只保留三个可辨识元素：相框、选区、火花。
 *   3. **留安全边距** —— 圆形/方形/圆角矩形三种桌面遮罩都可能切边，
 *      主体图形收在中心 80% 区域内。
 *
 * 与 app/icon.svg 保持同一套配色与构图（SVG 是设计源，这里是等价的像素实现，
 * 因为构建环境没有 SVG 光栅化库）。
 */
function icon(size) {
  return renderPNG(size, iconAt, 4);
}

/** 图标绘制体：(u,v) ∈ [0,1] 归一化坐标 → RGBA。方形与圆形图标共用 */
function iconAt(u, v) {
  // ---- 1. 圆角底（亮蓝渐变）----
  const rad = 0.2227;
  const cx = Math.min(Math.max(u, rad), 1 - rad);
  const cy = Math.min(Math.max(v, rad), 1 - rad);
  if (Math.hypot(u - cx, v - cy) > rad) return [0, 0, 0, 0];

  const t = Math.min(1, Math.max(0, (u + v) / 2));
  let bg;
  if (t < 0.55) {
    const k = t / 0.55;
    bg = [Math.round(90 + (43 - 90) * k), Math.round(176 + (127 - 176) * k), Math.round(255 + (224 - 255) * k)];
  } else {
    const k = (t - 0.55) / 0.45;
    bg = [Math.round(43 + (26 - 43) * k), Math.round(127 + (92 - 127) * k), Math.round(224 + (191 - 224) * k)];
  }

  // ---- 2. 照片本体 ----
  const [px0, py0, px1, py1, pr] = [0.2031, 0.2422, 0.7969, 0.7578, 0.0664];
  const [ix0, iy0, ix1, iy1, ir] = [0.2305, 0.2695, 0.7695, 0.7305, 0.0508];
  const inFrame = inRoundRect(u, v, px0, py0, px1, py1, pr);
  const inInner = inRoundRect(u, v, ix0, iy0, ix1, iy1, ir);

  /** 照片内容（暖色天空 + 太阳 + 山峦） */
  const photoContent = () => {
    const skyT = (v - iy0) / (iy1 - iy0);
    // 天空：上暖黄 → 下橙
    const col = skyT < 0.62
      ? [255, Math.round(212 - 58 * (skyT / 0.62)), Math.round(121 - 29 * (skyT / 0.62))]
      : [255, Math.round(154 - 0), Math.round(92 - 0)];
    // 太阳
    if (Math.hypot(u - 0.4023, v - 0.4141) < 0.0605) return [255, 246, 216, 255];
    // 近山（主峰偏右）
    const ridge = (x) => 0.7305 - Math.max(0, 0.42 - Math.abs(x - 0.5859) * 1.25) * 0.46;
    if (v >= ridge(u)) {
      const k = Math.min(1, (v - ridge(u)) / 0.22);
      return [Math.round(47 + (29 - 47) * k), Math.round(111 + (74 - 111) * k), Math.round(79 + (53 - 79) * k), 255];
    }
    // 远山（左侧小丘，压暗）
    const ridge2 = (x) => 0.7305 - Math.max(0, 0.26 - Math.abs(x - 0.3281) * 1.6) * 0.30;
    if (v >= ridge2(u)) return [26, 66, 48, 255];
    // 山脚压暗
    if (v > 0.6641) {
      const k = 0.45;
      return [Math.round(col[0] * (1 - k) + 18 * k), Math.round(col[1] * (1 - k) + 48 * k),
        Math.round(col[2] * (1 - k) + 38 * k), 255];
    }
    return [col[0], col[1], col[2], 255];
  };

  // 相框（白）→ 照片内容
  if (inFrame && !inInner) return [255, 255, 255, 255];

  // ---- 3. 选区与手柄（叠在照片之上；必须在 photoContent 之前判断，
  //         否则会被照片的 return 挡掉，永远画不出来）----
  // 选区必须完全落在照片内区（iy0..iy1 = 0.2695..0.7305）之内，
  // 否则虚线会压到白相框上，看起来像「框歪了」。
  // 手柄半径 0.0352，所以上下各留出这个余量。
  const [sx0, sy0, sx1, sy1, sr] = [0.3438, 0.4609, 0.6719, 0.6836, 0.0273];
  const sw = 0.0234;
  const per = 0.0781;

  // 四角手柄（画在最上层，先判）
  for (const [hx, hy] of [[sx0, sy0], [sx1, sy0], [sx0, sy1], [sx1, sy1]]) {
    const dd = Math.hypot(u - hx, v - hy);
    if (dd < 0.0352) {
      if (dd > 0.0254) return [26, 92, 191, 255];
      return [255, 255, 255, 255];
    }
  }

  // 虚线选区
  if (inInner) {
    const dEdge = Math.min(
      Math.min(Math.abs(u - sx0), Math.abs(u - sx1)),
      Math.min(Math.abs(v - sy0), Math.abs(v - sy1))
    );
    const ccx = Math.min(Math.max(u, sx0 + sr), sx1 - sr);
    const ccy = Math.min(Math.max(v, sy0 + sr), sy1 - sr);
    const dCorner = Math.abs(Math.hypot(u - ccx, v - ccy) - sr);
    if (Math.min(dEdge, dCorner) <= sw / 2) {
      // 沿边界取模生成虚线：上/下边沿 u，左/右边沿 v
      const along = (Math.abs(v - sy0) < sw || Math.abs(v - sy1) < sw) ? (u - sx0) : (v - sy0);
      if ((along % per) < per * 0.6) return [255, 255, 255, 255];
      return [255, 255, 255, 60];
    }
  }

  if (inInner) return photoContent();

  // ---- 4. 右上角火花（AI 生成）----
  const fx = u - 0.7695, fy = v - 0.2617;
  if (Math.abs(fx) + Math.abs(fy) < 0.0801 && (Math.abs(fx) < 0.0313 || Math.abs(fy) < 0.0313)) {
    return [255, 255, 255, 255];
  }

  return [bg[0], bg[1], bg[2], 255];
}

/**
 * 自适应图标的前景层（Android 8+）。
 *
 * 为什么必须单独做：
 *   Android 8 起如果找不到 adaptive-icon，系统会把传统图标硬塞进
 *   白底圆形/方形里 —— 看起来就是「图标怪怪的」。这是很多应用在
 *   新系统上显示异常的根因。
 *
 * 规格：画布 108dp，**保证可见区只有中心 72dp**（各厂商遮罩形状不同：
 * 圆形/方形/水滴/圆角矩形…）。所以内容必须收在中心 66.7% 内，否则会被切掉。
 *
 * 本设计的内容跨度约 60%（u 0.20~0.80），天然落在安全区内，
 * 所以这里直接复用 iconAt 的坐标，只把「底」变成透明。
 */
function adaptiveForeground(size) {
  return renderPNG(size, (u, v) => {
    // 右上角火花落在安全区之外（u≈0.77 > 0.833 的一半），
    // 自适应图标里必须去掉 —— 留着会被厂商遮罩切掉半截，反而更脏
    const px = u - 0.7695, py = v - 0.2617;
    if (Math.abs(px) + Math.abs(py) < 0.0801 && (Math.abs(px) < 0.0313 || Math.abs(py) < 0.0313)) {
      return [0, 0, 0, 0];
    }
    const c = iconAt(u, v);
    // 判定「这一像素是不是底色」：底色是蓝渐变，相框/天空/山/选区都不是纯蓝
    // 用 iconAt 的返回值反推：蓝色通道明显高于红且整体偏蓝 → 视为底
    const [r, g, b, a] = c;
    if (a === 0) return [0, 0, 0, 0];
    const isBg = b > r + 40 && b > 120 && r < 140;
    if (isBg) return [0, 0, 0, 0];
    return c;
  }, 4);
}

/**
 * 圆形桌面图标（Android 7.1+ 部分启动器使用）。
 *
 * 做法：把方形图标的内容按 0.72 缩进后再裁成圆。
 * 不缩进的话四角内容会被圆切掉，相框会缺角。
 */
function roundIcon(size) {
  return renderPNG(size, (u, v) => {
    const dx = u - 0.5, dy = v - 0.5;
    if (Math.hypot(dx, dy) > 0.5) return [0, 0, 0, 0];   // 圆外透明
    // 把坐标映射回「方形图标」的坐标系（内容缩到中心 72%）
    const k = 0.72;
    const su = 0.5 + dx / k, sv = 0.5 + dy / k;
    if (su < 0 || su > 1 || sv < 0 || sv > 1) {
      // 缩进后落在方形之外：用底色填满，避免出现空洞
      const t = Math.min(1, Math.max(0, (u + v) / 2));
      const bg = t < 0.55
        ? [Math.round(90 + (43 - 90) * (t / 0.55)), Math.round(176 + (127 - 176) * (t / 0.55)), Math.round(255 + (224 - 255) * (t / 0.55))]
        : [Math.round(43 + (26 - 43) * ((t - 0.55) / 0.45)), Math.round(127 + (92 - 127) * ((t - 0.55) / 0.45)), Math.round(224 + (191 - 224) * ((t - 0.55) / 0.45))];
      return [bg[0], bg[1], bg[2], 255];
    }
    return iconAt(su, sv);
  }, 4);
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

// 第二个参数是 Android res 目录：生成桌面图标与通知图标（各密度）
const resDir = process.argv[3];
if (resDir) {
  // 桌面图标：48dp 基准，各密度对应像素数
  const LAUNCHER = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [d, px] of Object.entries(LAUNCHER)) {
    const dir = path.join(resDir, 'mipmap-' + d);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), icon(px));
    // 圆形图标：Android 7.1+ 部分启动器会用
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), roundIcon(px));
  }
  console.log('桌面图标已生成（5 种密度）→ ' + resDir + '/mipmap-*');

  // 自适应图标（Android 8+）：前景层按 108dp，保证可见区是中心 72dp
  const ADAPTIVE = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
  for (const [d, px] of Object.entries(ADAPTIVE)) {
    const dir = path.join(resDir, 'mipmap-' + d);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), adaptiveForeground(px));
  }
  // 背景层：纯渐变（矢量，任意尺寸都清晰）
  const drawableDir = path.join(resDir, 'drawable');
  fs.mkdirSync(drawableDir, { recursive: true });
  fs.writeFileSync(path.join(drawableDir, 'ic_launcher_bg.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">\n' +
    '    <gradient\n' +
    '        android:startColor="#5ab0ff"\n' +
    '        android:centerColor="#2b7fe0"\n' +
    '        android:endColor="#1a5cbf"\n' +
    '        android:angle="315" />\n' +
    '</shape>\n');
  // 自适应图标描述（圆形与方形共用同一套前景/背景）
  const anydpiDir = path.join(resDir, 'mipmap-anydpi-v26');
  fs.mkdirSync(anydpiDir, { recursive: true });
  const adaptiveXml = (round) =>
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <background android:drawable="@drawable/ic_launcher_bg" />\n' +
    '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n' +
    (round ? '    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />\n' : '') +
    '</adaptive-icon>\n';
  fs.writeFileSync(path.join(anydpiDir, 'ic_launcher.xml'), adaptiveXml(false));
  fs.writeFileSync(path.join(anydpiDir, 'ic_launcher_round.xml'), adaptiveXml(true));
  console.log('自适应图标已生成（Android 8+）→ ' + resDir + '/mipmap-anydpi-v26');

  // 通知图标：24dp 基准，各密度对应像素数
  const NOTIF = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 };
  for (const [d, px] of Object.entries(NOTIF)) {
    const dir = path.join(resDir, 'drawable-' + d);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_stat_photostudio.png'), statIcon(px));
  }
  console.log('通知图标已生成（5 种密度）→ ' + resDir + '/drawable-*');
}
