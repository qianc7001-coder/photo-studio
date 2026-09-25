/* =============================================================================
 * Photo Studio · 核心逻辑（纯函数，无 DOM 依赖）
 *  - 视图几何：缩放 / 平移 / 框选手柄 / 命中测试 / 尺寸调整
 *  - 回贴合成：羽化掩膜、接缝色彩匹配、像素级 alpha 混合
 *  - 画笔掩膜：涂抹 / 擦除笔刷栅格化
 *  - 色彩科学：sRGB <-> 线性 <-> Oklab，ΔE 感知色差、自动对比色
 *  - 模型接入：服务商 / 模型能力表、请求体构造、响应解析、出图尺寸与分块规划
 *  - 提示词：编辑指令模板（中英）
 * 该文件同时支持浏览器（window.PSCore）与 Node（module.exports），便于单元测试。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PSCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ============================ 0. 基础工具 ============================ */

  /** 数值化：NaN/Infinity/非数字一律退化为 fallback，避免 NaN 静默传播到画布 */
  function num(v, fallback) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }
  const clamp = (v, a, b) => {
    const x = num(v, a);
    return x < a ? a : x > b ? b : x;
  };
  const clamp01 = (v) => clamp(v, 0, 1);
  const lerp = (a, b, t) => a + (b - a) * t;
  const round = Math.round;
  const HAS_CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f]/;

  /** 三次平滑插值：x<=e0 返回 0，x>=e1 返回 1 */
  function smoothstep(e0, e1, x) {
    if (e1 <= e0) return x < e0 ? 0 : 1;
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  }

  /** 把矩形规整为整数像素、并夹取在 [0,W]x[0,H] 内（最小 1x1） */
  function clampRect(rect, W, H) {
    const w0 = Math.max(1, num(W, 1)), h0 = Math.max(1, num(H, 1));
    const r = rect || {};
    let x = clamp(round(num(r.x, 0)), 0, Math.max(0, w0 - 1));
    let y = clamp(round(num(r.y, 0)), 0, Math.max(0, h0 - 1));
    let w = clamp(round(num(r.w, 1)), 1, w0 - x);
    let h = clamp(round(num(r.h, 1)), 1, h0 - y);
    return { x, y, w, h };
  }

  /** 由两点构造规范化矩形（左上 + 尺寸） */
  function rectFromPoints(a, b) {
    const A = a || {}, B = b || {};
    const ax = num(A.x, 0), ay = num(A.y, 0), bx = num(B.x, 0), by = num(B.y, 0);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  }

  function rectCenter(r) {
    const R = r || {};
    return { x: num(R.x, 0) + num(R.w, 0) / 2, y: num(R.y, 0) + num(R.h, 0) / 2 };
  }

  function rectsEqual(a, b, eps) {
    const e = eps == null ? 0.5 : eps;
    return Math.abs(a.x - b.x) < e && Math.abs(a.y - b.y) < e &&
      Math.abs(a.w - b.w) < e && Math.abs(a.h - b.h) < e;
  }

  /** 以 c 为中心按 factor 外扩矩形 */
  function expandRect(rect, factor, maxW, maxH) {
    const R = rect || {};
    const rx = num(R.x, 0), ry = num(R.y, 0), rw = num(R.w, 0), rh = num(R.h, 0);
    const cx = rx + rw / 2, cy = ry + rh / 2;
    let w = rw * (1 + 2 * num(factor, 0)), h = rh * (1 + 2 * num(factor, 0));
    let x = cx - w / 2, y = cy - h / 2;
    if (maxW != null) { x = clamp(x, 0, maxW - w); if (x < 0) { x = 0; w = maxW; } }
    if (maxH != null) { y = clamp(y, 0, maxH - h); if (y < 0) { y = 0; h = maxH; } }
    return clampRect({ x, y, w, h }, maxW == null ? x + w : maxW, maxH == null ? y + h : maxH);
  }

  /** 外扩 contextPx 像素（用于给模型提供上下文），并夹取在图内 */
  function expandRectByPx(rect, px, W, H) {
    const R = rect || {}, p = num(px, 0);
    return clampRect({
      x: num(R.x, 0) - p, y: num(R.y, 0) - p,
      w: num(R.w, 0) + 2 * p, h: num(R.h, 0) + 2 * p
    }, W, H);
  }

  /* ============================ 1. 视图变换 ============================ */

  function makeView(scale, tx, ty) { return { scale, tx, ty }; }

  /** 适配窗口：整图可见并居中 */
  function fitView(imgW, imgH, viewW, viewH, pad) {
    const p = pad == null ? 12 : pad;
    const W = Math.max(1, num(imgW, 1)), H = Math.max(1, num(imgH, 1));
    const VW = Math.max(1, num(viewW, 1)), VH = Math.max(1, num(viewH, 1));
    const sw = Math.max(1, VW - p * 2), sh = Math.max(1, VH - p * 2);
    let s = Math.min(sw / W, sh / H);
    if (!Number.isFinite(s) || s <= 0) s = 1;
    return makeView(s, (VW - W * s) / 2, (VH - H * s) / 2);
  }

  /** 视图缩放保证为正有限值，避免除零产生 NaN 坐标 */
  function safeScale(view) {
    const s = num(view && view.scale, 1);
    return s > 1e-6 ? s : 1e-6;
  }
  function screenToImage(pt, view) {
    const s = safeScale(view);
    const p = pt || {};
    return { x: (num(p.x, 0) - num(view.tx, 0)) / s, y: (num(p.y, 0) - num(view.ty, 0)) / s };
  }
  function imageToScreen(pt, view) {
    const s = safeScale(view);
    const p = pt || {};
    return { x: num(p.x, 0) * s + num(view.tx, 0), y: num(p.y, 0) * s + num(view.ty, 0) };
  }
  function imageRectToScreen(rect, view) {
    const s = safeScale(view);
    const r = rect || {};
    return {
      x: num(r.x, 0) * s + num(view.tx, 0),
      y: num(r.y, 0) * s + num(view.ty, 0),
      w: num(r.w, 0) * s,
      h: num(r.h, 0) * s
    };
  }

  /** 以屏幕点为中心缩放（保持该点下的图像位置不动） */
  function zoomAt(view, px, py, factor, minScale, maxScale) {
    const s0 = safeScale(view);
    const f = num(factor, 1) || 1;
    const ns = clamp(s0 * f, minScale, maxScale);
    const k = ns / s0;
    const X = num(px, 0), Y = num(py, 0), TX = num(view.tx, 0), TY = num(view.ty, 0);
    return makeView(ns, X - (X - TX) * k, Y - (Y - TY) * k);
  }

  /** 平移夹取：图比视口大时不允许露白，小于视口时居中 */
  function clampView(view, imgW, imgH, viewW, viewH) {
    const s = safeScale(view);
    const W = Math.max(1, num(imgW, 1)), H = Math.max(1, num(imgH, 1));
    const VW = Math.max(1, num(viewW, 1)), VH = Math.max(1, num(viewH, 1));
    const w = W * s, h = H * s;
    const tx = w <= VW ? (VW - w) / 2 : clamp(num(view.tx, 0), VW - w, 0);
    const ty = h <= VH ? (VH - h) / 2 : clamp(num(view.ty, 0), VH - h, 0);
    return makeView(s, tx, ty);
  }

  /* ========================= 2. 框选：手柄与调整 ========================= */

  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  /** 手柄在图像坐标系下的位置 */
  function handlePoints(rect) {
    const R = rect || {};
    const x = num(R.x, 0), y = num(R.y, 0), w = num(R.w, 0), h = num(R.h, 0);
    const cx = x + w / 2, cy = y + h / 2;
    return {
      nw: { x, y }, n: { x: cx, y }, ne: { x: x + w, y },
      e: { x: x + w, y: cy }, se: { x: x + w, y: y + h },
      s: { x: cx, y: y + h }, sw: { x, y: y + h }, w: { x, y: cy }
    };
  }

  /** 命中测试（屏幕坐标）。tol 为手柄半径（像素） */
  function hitTest(pt, rectScreen, tol) {
    const P = pt || {};
    const R0 = rectScreen || {};
    const r = { x: num(R0.x, 0), y: num(R0.y, 0), w: num(R0.w, 0), h: num(R0.h, 0) };
    const pt2 = { x: num(P.x, 0), y: num(P.y, 0) };
    // 容差要随选区大小收缩：固定 24px 时，小选区（屏幕上不足 48px）的
    // 中心到四角全在容差内，会永远命中 'nw'，导致选区根本拖不动。
    let t = Math.max(0, num(tol, 22) || 22);
    const half = Math.min(r.w, r.h) / 2;
    if (half < t) t = Math.max(4, half * 0.6);
    // 选区太小时优先允许整体移动，否则无法拖动
    if (r.w < 3 * t && r.h < 3 * t) {
      const pad = Math.max(6, t);
      if (pt2.x >= r.x - pad && pt2.x <= r.x + r.w + pad &&
          pt2.y >= r.y - pad && pt2.y <= r.y + r.h + pad) return 'move';
    }
    return hitTestInner(pt2, r, t);
  }
  function hitTestInner(pt, r, t) {
    const inX = pt.x >= r.x - t && pt.x <= r.x + r.w + t;
    const inY = pt.y >= r.y - t && pt.y <= r.y + r.h + t;
    const nearL = Math.abs(pt.x - r.x) <= t, nearR = Math.abs(pt.x - (r.x + r.w)) <= t;
    const nearT = Math.abs(pt.y - r.y) <= t, nearB = Math.abs(pt.y - (r.y + r.h)) <= t;
    if (nearL && nearT) return 'nw';
    if (nearR && nearT) return 'ne';
    if (nearR && nearB) return 'se';
    if (nearL && nearB) return 'sw';
    if (nearT && inX) return 'n';
    if (nearB && inX) return 's';
    if (nearL && inY) return 'w';
    if (nearR && inY) return 'e';
    if (pt.x > r.x && pt.x < r.x + r.w && pt.y > r.y && pt.y < r.y + r.h) return 'move';
    return null;
  }

  const CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize', w: 'ew-resize', e: 'ew-resize', move: 'move'
  };

  /**
   * 拖动某个手柄后计算新矩形。
   * @param {object} rect   原始矩形（图像坐标）
   * @param {string} handle 手柄名，或 'move'
   * @param {number} dx     图像坐标位移
   * @param {number} dy
   * @param {object} [opts] { min, aspect, fromCenter }
   */
  function resizeRect(rect, handle, dx, dy, opts) {
    opts = opts || {};
    const R0 = rect || {};
    const rect2 = {
      x: num(R0.x, 0), y: num(R0.y, 0),
      w: Math.max(1, num(R0.w, 1)), h: Math.max(1, num(R0.h, 1))
    };
    const DX = num(dx, 0), DY = num(dy, 0);
    const min = Math.max(1, num(opts.min, 16) || 16);
    const handle2 = typeof handle === 'string' ? handle : 'move';
    if (handle2 === 'move') {
      return { x: rect2.x + DX, y: rect2.y + DY, w: rect2.w, h: rect2.h };
    }
    return resizeRectInner(rect2, handle2, DX, DY, min, opts);
  }
  function resizeRectInner(rect, handle, dx, dy, min, opts) {
    let left = rect.x, top = rect.y, right = rect.x + rect.w, bottom = rect.y + rect.h;
    const west = handle.indexOf('w') >= 0, east = handle.indexOf('e') >= 0;
    const north = handle.indexOf('n') >= 0, south = handle.indexOf('s') >= 0;
    if (west) left += dx;
    if (east) right += dx;
    if (north) top += dy;
    if (south) bottom += dy;

    const aspect = num(opts.aspect, 0);
    if (aspect > 0) {
      if (west || east) {
        const w = Math.max(min, right - left);
        const nh = w / aspect;
        if (north) top = bottom - nh; else bottom = top + nh;
      } else if (north || south) {
        const h = Math.max(min, bottom - top);
        const nw = h * aspect;
        if (west) left = right - nw; else right = left + nw;
      }
    }
    if (opts.fromCenter) {
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      const hw = Math.max(min / 2, Math.abs(right - left) / 2);
      const hh = Math.max(min / 2, Math.abs(bottom - top) / 2);
      left = cx - hw; right = cx + hw; top = cy - hh; bottom = cy + hh;
    }
    // 防止翻转 / 尺寸过小
    if (right - left < min) { if (west) left = right - min; else right = left + min; }
    if (bottom - top < min) { if (north) top = bottom - min; else bottom = top + min; }
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  /** 点是否在矩形内（图像坐标） */
  function pointInRect(pt, rect) {
    return pt.x >= rect.x && pt.x <= rect.x + rect.w && pt.y >= rect.y && pt.y <= rect.y + rect.h;
  }

  function rectsIntersect(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  /* ======================= 3. 像素处理（ImageData 级） ======================= */
  // 约定：像素对象形如 { data: Uint8ClampedArray, width, height }（即 ImageData）

  function makePixels(w, h) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }

  /** 距离矩形边缘的像素距离（0.5 起算），用于羽化掩膜 */
  function edgeDistance(x, y, w, h) {
    return Math.min(Math.min(x, w - 1 - x), Math.min(y, h - 1 - y)) + 0.5;
  }

  /** 生成羽化 alpha 掩膜（Float32Array，长度 w*h，取值 0..1） */
  function featherMask(w, h, featherPx) {
    const m = new Float32Array(w * h);
    // 羽化从边界向内衰减，如果羽化半径超过选区一半，整块都达不到不透明，
    // 表现为「改了但永远只改一半」。这里限制在短边的 1/3 以内。
    const limit = Math.max(0, Math.min(w, h) / 3);
    const f = Math.max(0, Math.min(num(featherPx, 0), limit));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = edgeDistance(x, y, w, h);
        m[y * w + x] = f <= 0 ? 1 : smoothstep(0, f, d);
      }
    }
    return m;
  }

  /** 环形统计：src 为矩形内侧 ring 像素，dst 为外侧 ring 像素 */
  /**
   * 环形取样：内侧环取「要贴的内容」，外侧环取「原图周边」。
   *
   * dst 可能只是整图里裁出来的一块子图（app 里就是这么用的），
   * 这时外环坐标会落到子图之外。若只靠边界检查丢弃，外侧样本数会变成 0，
   * delta 退化为 0 —— 色彩匹配看起来"没生效"。所以额外支持传入整图引用，
   * 外环样本优先从整图上取。
   *
   * @param {object} dst 目标子图（ImageData 形状）
   * @param {object} src 要贴的内容（ImageData 形状）
   * @param {object} rect 选区在「子图坐标系」里的位置
   * @param {number} ringPx
   * @param {object} [full] { pixels, offset:{x,y} } 整图引用与子图在整图中的偏移
   */
  function ringStats(dst, src, rect, ringPx, full) {
    const ring = Math.max(1, round(ringPx || 6));
    const sumS = [0, 0, 0], sumD = [0, 0, 0];
    let nS = 0, nD = 0;
    const x0 = rect.x - ring, y0 = rect.y - ring;
    const x1 = rect.x + rect.w + ring, y1 = rect.y + rect.h + ring;
    // 整图采样上下文
    const fullPix = full && full.pixels ? full.pixels : null;
    const fox = full && full.offset ? num(full.offset.x, 0) : 0;
    const foy = full && full.offset ? num(full.offset.y, 0) : 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
        const inSrc = inside && (x < rect.x + ring || x >= rect.x + rect.w - ring || y < rect.y + ring || y >= rect.y + rect.h - ring);
        const inDst = !inside;
        if (!inSrc && !inDst) continue;
        if (inSrc) {
          const sx = x - rect.x, sy = y - rect.y;
          if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
          const i = (sy * src.width + sx) * 4;
          sumS[0] += src.data[i]; sumS[1] += src.data[i + 1]; sumS[2] += src.data[i + 2];
          nS++;
        } else if (fullPix) {
          // 外环：换算到整图坐标后取样
          const gx = x + fox, gy = y + foy;
          if (gx < 0 || gy < 0 || gx >= fullPix.width || gy >= fullPix.height) continue;
          const i = (gy * fullPix.width + gx) * 4;
          sumD[0] += fullPix.data[i]; sumD[1] += fullPix.data[i + 1]; sumD[2] += fullPix.data[i + 2];
          nD++;
        } else {
          if (x < 0 || y < 0 || x >= dst.width || y >= dst.height) continue;
          const i = (y * dst.width + x) * 4;
          sumD[0] += dst.data[i]; sumD[1] += dst.data[i + 1]; sumD[2] += dst.data[i + 2];
          nD++;
        }
      }
    }
    const s = nS ? [sumS[0] / nS, sumS[1] / nS, sumS[2] / nS] : [0, 0, 0];
    const d = nD ? [sumD[0] / nD, sumD[1] / nD, sumD[2] / nD] : s;
    return { src: s, dst: d, delta: [d[0] - s[0], d[1] - s[1], d[2] - s[2]], samples: nS + nD };
  }

  /**
   * 羽化回贴：把 patch（尺寸 = rect 尺寸）混合进 dst（整图），就地修改 dst。
   * @param {object} dst  整图像素（会被修改）
   * @param {object} src  patch 像素（尺寸需等于 rect.w/h）
   * @param {object} rect {x,y,w,h} 目标位置（dst 坐标）
   * @param {object} [opts] { feather, colorMatch:{ring, ramp, strength}, mask (Float32Array 长度 w*h，0..1) }
   * @returns {object} 统计信息
   */
  function compositeFeathered(dst, src, rect, opts) {
    opts = opts || {};
    const w = Math.min(rect.w, src.width), h = Math.min(rect.h, src.height);
    const feather = Math.max(0, Math.min(num(opts.feather, 0), Math.min(w, h) / 3));
    const cm = opts.colorMatch || null;
    const useCM = !!(cm && cm.strength > 0);
    let stats = null, delta = [0, 0, 0];
    if (useCM) {
      // dstOffset/dstFull 由调用方给出：dst 是整图某块子图时，外环样本需从整图取
      const full = opts.dstFull
        ? { pixels: opts.dstFull, offset: opts.dstOffset || { x: 0, y: 0 } }
        : null;
      stats = ringStats(dst, src, { x: rect.x, y: rect.y, w, h }, cm.ring || 8, full);
      delta = stats.delta;
    }
    const ramp = Math.max(1, (cm && cm.ramp) || Math.max(6, feather || 8));
    const strength = useCM ? clamp01(cm.strength) : 0;
    const customMask = opts.mask || null;

    for (let y = 0; y < h; y++) {
      const dy = rect.y + y;
      if (dy < 0 || dy >= dst.height) continue;
      for (let x = 0; x < w; x++) {
        const dx = rect.x + x;
        if (dx < 0 || dx >= dst.width) continue;
        const d = edgeDistance(x, y, w, h);
        // 羽化与自定义掩膜是相乘关系：掩膜控制「改哪里」，羽化控制「边界多柔和」
        const featherA = feather <= 0 ? 1 : smoothstep(0, feather, d);
        let a = customMask ? clamp01(customMask[y * w + x]) * featherA : featherA;
        if (a <= 0) continue;
        if (opts.maxAlpha != null) a = Math.min(a, opts.maxAlpha);
        const si = (y * src.width + x) * 4;
        const di = (dy * dst.width + dx) * 4;
        let r = src.data[si], g = src.data[si + 1], b = src.data[si + 2];
        if (useCM) {
          const t = clamp01(d / ramp);
          const k = (1 - t) * strength;
          r += delta[0] * k; g += delta[1] * k; b += delta[2] * k;
        }
        const ia = 1 - a;
        dst.data[di] = r * a + dst.data[di] * ia;
        dst.data[di + 1] = g * a + dst.data[di + 1] * ia;
        dst.data[di + 2] = b * a + dst.data[di + 2] * ia;
        dst.data[di + 3] = 255;
      }
    }
    return { delta, alpha: feather };
  }

  /** 打码（隐私保护用）：rect 内按 block 大小做块平均 */
  function mosaicRegion(pixels, rect, block) {
    const bs = Math.max(2, round(block || 12));
    const x0 = clamp(rect.x, 0, pixels.width), y0 = clamp(rect.y, 0, pixels.height);
    const x1 = clamp(rect.x + rect.w, 0, pixels.width), y1 = clamp(rect.y + rect.h, 0, pixels.height);
    const d = pixels.data, W = pixels.width;
    for (let by = y0; by < y1; by += bs) {
      for (let bx = x0; bx < x1; bx += bs) {
        const ex = Math.min(bx + bs, x1), ey = Math.min(by + bs, y1);
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) {
          const i = (y * W + x) * 4;
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
        if (!n) continue;
        r /= n; g /= n; b /= n;
        for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) {
          const i = (y * W + x) * 4;
          d[i] = r; d[i + 1] = g; d[i + 2] = b;
        }
      }
    }
  }

  /* ============================ 4. 画笔掩膜 ============================ */

  /**
   * 把笔画栅格化为掩膜。
   * @param {Array} strokes [{ mode:'erase'|'restore', radius, points:[{x,y}] }] 坐标为矩形局部坐标
   * @param {number} w
   * @param {number} h
   * @param {object} [opts] { initial: 1 }
   * @returns {Float32Array}
   */
  function strokesToMask(strokes, w, h, opts) {
    opts = opts || {};
    const mask = new Float32Array(w * h);
    const init = opts.initial == null ? 1 : opts.initial;
    if (init !== 0) mask.fill(clamp01(init));
    if (!strokes || !strokes.length) return mask;
    const tmp = new Float32Array(w * h);
    for (const s of strokes) {
      if (!s || !s.points || !s.points.length) continue;
      const r = Math.max(1, s.radius || 20);
      tmp.fill(0);
      const stamp = (px, py) => {
        const x0 = Math.max(0, Math.floor(px - r)), x1 = Math.min(w - 1, Math.ceil(px + r));
        const y0 = Math.max(0, Math.floor(py - r)), y1 = Math.min(h - 1, Math.ceil(py + r));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const dx = x + 0.5 - px, dy = y + 0.5 - py;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const v = 1 - smoothstep(r * 0.55, r, dist); // 中心 1 -> 边缘 0
            const i = y * w + x;
            if (v > tmp[i]) tmp[i] = v;
          }
        }
      };
      const pts = s.points;
      if (pts.length === 1) stamp(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.max(1, Math.ceil(dist / Math.max(1, r * 0.25)));
        for (let k = 0; k <= steps; k++) stamp(lerp(a.x, b.x, k / steps), lerp(a.y, b.y, k / steps));
      }
      const isErase = s.mode === 'erase';
      for (let i = 0; i < mask.length; i++) {
        const v = tmp[i];
        if (v <= 0) continue;
        if (isErase) mask[i] = mask[i] * (1 - v);
        else mask[i] = Math.max(mask[i], v);
      }
    }
    return mask;
  }

  /** 掩膜 -> RGBA 叠加层（用于把掩膜画成半透明蓝色提示） */
  function maskToRGBA(mask, w, h, color, maxAlpha) {
    const c = color || [64, 150, 255];
    const ma = maxAlpha == null ? 110 : maxAlpha;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
      const a = clamp01(mask[i]) * ma;
      out[j] = c[0]; out[j + 1] = c[1]; out[j + 2] = c[2]; out[j + 3] = a;
    }
    return out;
  }

  function maskCoverage(mask) {
    if (!mask || !mask.length) return 0;
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] > 0.5) n++;
    return n / mask.length;
  }

  /* ============================ 5. 色彩科学 ============================ */

  function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(c) {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return clamp(round(v * 255), 0, 255);
  }
  /** sRGB(0-255) -> Oklab */
  function rgbToOklab(r, g, b) {
    const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
    const l = 0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B;
    const m = 0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B;
    const s = 0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B;
    const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
    return {
      L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    };
  }
  function oklabToRgb(L, a, b) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    const R = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const B = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    return [linearToSrgb(R), linearToSrgb(G), linearToSrgb(B)];
  }
  /** 感知色差（Oklab 欧氏距离，约等于 ΔE 的现代替代） */
  function colorDistance(c1, c2) {
    const a = rgbToOklab(c1[0], c1[1], c1[2]), b = rgbToOklab(c2[0], c2[1], c2[2]);
    return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
  }
  function relativeLuminance(r, g, b) {
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  }
  /** 该底色上用黑字还是白字 */
  function bestTextColor(rgb) {
    return relativeLuminance(rgb[0], rgb[1], rgb[2]) > 0.42 ? '#0b0c0e' : '#ffffff';
  }
  function rgbToHex(rgb) {
    return '#' + rgb.slice(0, 3).map((v) => clamp(round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  }
  function hexToRgb(hex) {
    const s = String(hex || '').replace('#', '').trim();
    const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
    const n = parseInt(full.slice(0, 6), 16);
    if (!isFinite(n)) return [0, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /* ========================= 6. 出图尺寸与分块规划 ========================= */

  function parseSize(str) {
    const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(str || '').trim());
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
  }
  function snapTo(n, step) {
    const s = Math.max(1, num(step, 8) || 8);
    return Math.max(s, round(num(n, s) / s) * s);
  }

  /**
   * 从允许的尺寸列表里挑最贴近选区宽高比与面积的尺寸。
   * @param {number} w 选区宽（像素）
   * @param {number} h 选区高
   * @param {Array<string>} sizes 允许尺寸，如 ['1328x1328', ...]
   */
  function resolveOutputSize(w, h, sizes, providerId) {
    let W = num(w, 0), H = num(h, 0);
    if (W <= 0 || H <= 0) { W = H = Math.max(16, W || H || 16); }   // 退化输入按正方形处理
    if (!sizes || !sizes.length) {
      const sw = snapTo(W, 16), sh = snapTo(H, 16);
      return { w: sw, h: sh, size: sw + 'x' + sh };
    }
    const targetAspect = W / H;
    const targetArea = W * H;
    let best = null, bestScore = Infinity;
    for (const s of sizes) {
      const p = parseSize(s);
      if (!p) continue;
      // 服务商有硬性约束时，先把不合规的候选剔除，
      // 否则会挑出一个发过去必被拒的尺寸
      if (providerId && !validateSize(s, providerId).ok) continue;
      const aspect = p[0] / p[1];
      const arScore = Math.abs(Math.log(aspect / targetAspect));
      const areaScore = Math.abs(Math.log((p[0] * p[1]) / targetArea));
      const score = arScore * 3 + areaScore * 0.35;
      if (score < bestScore) { bestScore = score; best = { w: p[0], h: p[1], size: s }; }
    }
    // 候选表全被剔除时，按规范现场算一个合规尺寸
    if (!best && providerId) {
      const c = conformSize(W, H, providerId);
      return { w: c.w, h: c.h, size: c.size };
    }
    return best;
  }

  /**
   * 计算「填满且不变形」的裁剪窗口。
   *
   * 背景：生图模型只能输出它支持的固定比例。当用户框选的是细长条（比如 8:1 的天空带），
   * 模型仍会返回 16:9 的图。如果把返回图直接拉伸到选区长宽，画面会被严重压扁/拉长
   * —— 对修图来说这是不可接受的。正确做法是按比例放大到刚好盖住选区，再取居中部分，
   * 多余的边缘裁掉（这些边缘本来就是模型对选区外的想象）。
   *
   * @returns {{sx:number, sy:number, sw:number, sh:number}} 源图上的裁剪窗口
   */
  function coverCrop(srcW, srcH, dstW, dstH) {
    const SW = Math.max(1, num(srcW, 1)), SH = Math.max(1, num(srcH, 1));
    const DW = Math.max(1, num(dstW, 1)), DH = Math.max(1, num(dstH, 1));
    const srcAR = SW / SH, dstAR = DW / DH;
    let sw, sh;
    if (srcAR > dstAR) {
      sh = SH; sw = SH * dstAR;       // 源比目标更宽 → 裁左右
    } else {
      sw = SW; sh = SW / dstAR;       // 源比目标更高 → 裁上下
    }
    sw = Math.min(SW, sw); sh = Math.min(SH, sh);
    return { sx: (SW - sw) / 2, sy: (SH - sh) / 2, sw, sh };
  }

  /**
   * 计算「从模型返回图里取出选区对应内容」的源矩形。
   *
   * 这是修图流程里最容易错的一步。发给模型的图往往带上下文外扩
   * （选区在请求图里的位置是 off.x/off.y，尺寸是 reqW×reqH），
   * 而模型返回的图尺寸又是它自己的（可能被缩放到 1328×1328 等）。
   * 因此不能直接按比例缩放整张返回图 —— 那会把外扩的上下文也一起贴进选区，
   * 导致内容整体位移。正确做法分两步：
   *   1. 先把「请求图坐标系」里的选区区域换算到「返回图坐标系」
   *   2. 在这个区域内按目标比例做「盖满 + 居中裁切」，保证不变形
   *
   * @param {object} o { genW, genH, reqW, reqH, offX, offY, selW, selH }
   * @returns {{sx,sy,sw,sh}} 返回图上的源矩形
   */
  function mapSelectionToResult(o) {
    const genW = Math.max(1, num(o.genW, 1)), genH = Math.max(1, num(o.genH, 1));
    const reqW = Math.max(1, num(o.reqW, genW)), reqH = Math.max(1, num(o.reqH, genH));
    const selW = Math.max(1, num(o.selW, reqW)), selH = Math.max(1, num(o.selH, reqH));

    // 请求图 → 返回图 的缩放系数（模型可能改变输出分辨率）
    const kx = genW / reqW, ky = genH / reqH;

    // 选区在返回图坐标系里的矩形
    let rx = num(o.offX, 0) * kx, ry = num(o.offY, 0) * ky;
    let rw = selW * kx, rh = selH * ky;

    // 夹取到返回图范围内，避免模型输出尺寸异常时取到图外
    rw = Math.min(rw, genW); rh = Math.min(rh, genH);
    rx = clamp(rx, 0, Math.max(0, genW - rw));
    ry = clamp(ry, 0, Math.max(0, genH - rh));

    // 在这个区域内按目标比例盖满并居中裁切（区域比例通常已很接近目标）
    const inner = coverCrop(rw, rh, selW, selH);
    return { sx: rx + inner.sx, sy: ry + inner.sy, sw: inner.sw, sh: inner.sh };
  }

  /**
   * 计算分块瓦片在「重叠区」的 alpha 权重，用于把多块结果平滑拼起来。
   *
   * 背景：相邻瓦片有 overlap 像素的重叠。若后写的块直接覆盖先写的块，
   * 块边界会出现明显色差断层（每块的白平衡/曝光不可能完全一致）。
   * 这里让重叠区做线性过渡：靠近本块中心权重 1，靠近本块边缘权重 0，
   * 于是两块在重叠区自然各占一半，拼缝不可见。
   *
   * @param {object} tile 当前瓦片（选区坐标系）
   * @param {object} full 整个选区
   * @param {number} overlap 重叠像素
   * @returns {Float32Array} 长度 tile.w*tile.h 的权重
   */
  function tileBlendWeights(tile, full, overlap) {
    const w = Math.max(1, num(tile.w, 1)), h = Math.max(1, num(tile.h, 1));
    const ov = Math.max(0, num(overlap, 0));
    const W = new Float32Array(w * h);
    if (ov <= 0) { W.fill(1); return W; }

    // 本块相对整个选区的位置，决定哪条边需要渐隐（只有与邻块相接的边才渐隐）
    const leftEdge = num(tile.x, 0) > num(full.x, 0) + 0.5;
    const topEdge = num(tile.y, 0) > num(full.y, 0) + 0.5;
    const rightEdge = num(tile.x, 0) + w < num(full.x, 0) + num(full.w, 0) - 0.5;
    const bottomEdge = num(tile.y, 0) + h < num(full.y, 0) + num(full.h, 0) - 0.5;

    const band = Math.max(1, Math.min(ov, Math.floor(Math.min(w, h) / 2)));
    for (let y = 0; y < h; y++) {
      let wy = 1;
      if (topEdge) wy = Math.min(wy, smoothstep(0, band, y + 0.5));
      if (bottomEdge) wy = Math.min(wy, smoothstep(0, band, h - 0.5 - y));
      for (let x = 0; x < w; x++) {
        let wx = 1;
        if (leftEdge) wx = Math.min(wx, smoothstep(0, band, x + 0.5));
        if (rightEdge) wx = Math.min(wx, smoothstep(0, band, w - 0.5 - x));
        W[y * w + x] = Math.max(0, Math.min(1, wx * wy));
      }
    }
    return W;
  }

  /**
   * 把一块生成结果按权重累加进目标（加权平均），实现无缝拼接。
   * @param {object} acc  { data: Float32Array(w*h*3), w, h } 累加缓冲
   * @param {object} wacc { data: Float32Array(w*h), w, h } 权重累加缓冲
   * @param {object} patch 该块的像素（ImageData 形状）
   * @param {number} ox,oy 该块在选区里的偏移
   * @param {Float32Array} weights 该块权重
   */
  function accumulateTile(acc, wacc, patch, ox, oy, weights) {
    const W = acc.w, H = acc.h;
    const pw = patch.width, ph = patch.height;
    const d = patch.data;
    for (let y = 0; y < ph; y++) {
      const gy = oy + y;
      if (gy < 0 || gy >= H) continue;
      for (let x = 0; x < pw; x++) {
        const gx = ox + x;
        if (gx < 0 || gx >= W) continue;
        const a = weights ? weights[y * pw + x] : 1;
        if (a <= 0) continue;
        const si = (y * pw + x) * 4;
        const gi = (gy * W + gx);
        acc.data[gi * 3] += d[si] * a;
        acc.data[gi * 3 + 1] += d[si + 1] * a;
        acc.data[gi * 3 + 2] += d[si + 2] * a;
        wacc.data[gi] += a;
      }
    }
  }

  /** 把加权累加缓冲写回 ImageData */
  function resolveAccumulated(acc, wacc, out) {
    const n = acc.w * acc.h;
    for (let i = 0; i < n; i++) {
      const w = wacc.data[i];
      const o = i * 4;
      if (w > 1e-6) {
        out.data[o] = acc.data[i * 3] / w;
        out.data[o + 1] = acc.data[i * 3 + 1] / w;
        out.data[o + 2] = acc.data[i * 3 + 2] / w;
      } else {
        out.data[o] = 0; out.data[o + 1] = 0; out.data[o + 2] = 0;
      }
      out.data[o + 3] = 255;
    }
    return out;
  }

  /** 生图结果与选区的比例偏差程度：1 表示完全一致，>1.25 说明偏差明显 */
  function aspectMismatch(srcW, srcH, dstW, dstH) {
    const a = Math.max(1, num(srcW, 1)) / Math.max(1, num(srcH, 1));
    const b = Math.max(1, num(dstW, 1)) / Math.max(1, num(dstH, 1));
    return Math.max(a / b, b / a);
  }

  /**
   * 各家对出图尺寸都有硬性约束，不符合会在服务端直接拒单（请求根本进不了模型）。
   * 这里把约束做成可校验的规则，在「发出去之前」就挡住，避免用户收到一句看不懂的报错。
   *
   * 目前已知的约束：
   *  - OpenAI（gpt-image 系列）：总像素 ≥ 655360；宽高都必须是 16 的倍数；
   *    单边 ≤ 3840；宽高比在 1:3 ~ 3:1 之间
   *  - 硅基流动 Qwen-Image：给的是推荐值，不强制，但偏离太多质量会下降
   *  - FLUX Kontext：用 aspect_ratio 表达，不需要具体像素
   */
  const SIZE_RULES = {
    openai: { minPixels: 655360, multipleOf: 16, maxSide: 3840, minAspect: 1 / 3, maxAspect: 3 },
    siliconflow: { minPixels: 0, multipleOf: 1, maxSide: 8192, minAspect: 0, maxAspect: Infinity },
    custom: { minPixels: 0, multipleOf: 1, maxSide: 8192, minAspect: 0, maxAspect: Infinity }
  };

  function sizeRulesFor(providerId) {
    return SIZE_RULES[providerId] || SIZE_RULES.custom;
  }

  /**
   * 校验一个尺寸是否符合规范。
   * @returns {{ok:boolean, reasons:string[]}}
   */
  function validateSize(size, providerId) {
    const reasons = [];
    const p = parseSize(size);
    if (!p) return { ok: false, reasons: ['尺寸格式无法解析：' + size] };
    const [w, h] = p;
    const r = sizeRulesFor(providerId);
    const px = w * h;
    if (r.minPixels > 0 && px < r.minPixels) {
      reasons.push(`总像素 ${px} 低于下限 ${r.minPixels}（约 ${(r.minPixels / 1e6).toFixed(2)}MP）`);
    }
    if (r.multipleOf > 1 && (w % r.multipleOf !== 0 || h % r.multipleOf !== 0)) {
      reasons.push(`宽高必须是 ${r.multipleOf} 的倍数（当前 ${w}x${h}）`);
    }
    if (w > r.maxSide || h > r.maxSide) {
      reasons.push(`单边不能超过 ${r.maxSide}px（当前 ${w}x${h}）`);
    }
    const ar = w / h;
    if (r.minAspect > 0 && (ar < r.minAspect || ar > r.maxAspect)) {
      reasons.push(`宽高比需在 ${(1 / r.maxAspect).toFixed(2)}:1 ~ ${(r.maxAspect / 1).toFixed(2)}:1 之间（当前 ${ar.toFixed(2)}:1）`);
    }
    return { ok: reasons.length === 0, reasons };
  }

  /**
   * 把任意尺寸「修正」成符合规范的尺寸：调整到 16 的倍数、补足最小像素、限制边长与比例。
   * 尽量保持原有宽高比。
   */
  function conformSize(w, h, providerId) {
    const r = sizeRulesFor(providerId);
    let W = Math.max(1, Math.round(num(w, 1024)));
    let H = Math.max(1, Math.round(num(h, 1024)));

    // 先限制单边
    if (W > r.maxSide || H > r.maxSide) {
      const k = r.maxSide / Math.max(W, H);
      W = Math.round(W * k); H = Math.round(H * k);
    }
    // 再限制宽高比（超出就按比例回缩较长的一边）
    const ar = W / H;
    if (r.minAspect > 0 && (ar < r.minAspect || ar > r.maxAspect)) {
      if (ar > r.maxAspect) W = Math.round(H * r.maxAspect);
      else H = Math.round(W / r.minAspect);
    }
    // 对齐到倍数
    if (r.multipleOf > 1) {
      W = Math.max(r.multipleOf, Math.round(W / r.multipleOf) * r.multipleOf);
      H = Math.max(r.multipleOf, Math.round(H / r.multipleOf) * r.multipleOf);
    }
    // 补足最小像素：等比放大直到达标
    if (r.minPixels > 0 && W * H < r.minPixels) {
      const k = Math.sqrt(r.minPixels / (W * H)) * 1.001;
      W = Math.round(W * k); H = Math.round(H * k);
      if (r.multipleOf > 1) {
        W = Math.ceil(W / r.multipleOf) * r.multipleOf;
        H = Math.ceil(H / r.multipleOf) * r.multipleOf;
      }
      // 放大后可能又超边长，再夹一次
      if (W > r.maxSide || H > r.maxSide) {
        const k2 = r.maxSide / Math.max(W, H);
        W = Math.round(W * k2); H = Math.round(H * k2);
        if (r.multipleOf > 1) {
          W = Math.floor(W / r.multipleOf) * r.multipleOf;
          H = Math.floor(H / r.multipleOf) * r.multipleOf;
        }
      }
    }
    W = Math.max(1, W); H = Math.max(1, H);
    return { w: W, h: H, size: W + 'x' + H };
  }

  /** 从允许的宽高比列表里挑最接近的（FLUX Kontext 用） */
  function resolveAspectRatio(w, h, ratios) {
    const list = ratios || ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16', '9:21'];
    const W = num(w, 0), H = num(h, 0);
    const target = (W > 0 && H > 0) ? W / H : 1;
    let best = list[0], bestScore = Infinity;
    for (const r of list) {
      const m = /^(\d+):(\d+)$/.exec(r);
      if (!m) continue;
      const score = Math.abs(Math.log((+m[1] / +m[2]) / target));
      if (score < bestScore) { bestScore = score; best = r; }
    }
    return best;
  }

  /**
   * 分块规划：把大选区切成若干带重叠的瓦片（图像坐标），每块单独送模型。
   * @param {object} rect {x,y,w,h}
   * @param {object} opts { maxSide, overlap }
   */
  function planTileCrop(rect, opts) {
    opts = opts || {};
    const maxSide = Math.max(256, num(opts.maxSide, 1400) || 1400);
    const overlap = clamp(num(opts.overlap, 96), 0, maxSide / 3);
    const R = rect || {};
    const x = num(R.x, 0), y = num(R.y, 0);
    const w = Math.max(0, num(R.w, 0)), h = Math.max(0, num(R.h, 0));
    if (w <= 0 || h <= 0) return [];
    const cols = Math.max(1, Math.ceil((w - overlap) / Math.max(1, maxSide - overlap)));
    const rows = Math.max(1, Math.ceil((h - overlap) / Math.max(1, maxSide - overlap)));
    if (cols === 1 && rows === 1) return [{ x, y, w, h }];
    const spanW = Math.ceil((w + (cols - 1) * overlap) / cols);
    const spanH = Math.ceil((h + (rows - 1) * overlap) / rows);
    const tw = Math.min(maxSide, spanW), th = Math.min(maxSide, spanH);
    const tiles = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tx = cols === 1 ? x : x + round(c * (w - tw) / (cols - 1));
        const ty = rows === 1 ? y : y + round(r * (h - th) / (rows - 1));
        tiles.push({ x: tx, y: ty, w: tw, h: th });
      }
    }
    return tiles;
  }

  /* ============================ 7. 模型接入层 ============================ */

  const PROVIDERS = [
    {
      id: 'siliconflow',
      label: '硅基流动 SiliconFlow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      keyUrl: 'https://cloud.siliconflow.cn/account/ak',
      models: [
        {
          id: 'Qwen/Qwen-Image-Edit', label: 'Qwen-Image-Edit（推荐 · 局部编辑）', kind: 'edit',
          imageField: 'image', sizeMode: 'image_size',
          sizes: ['1328x1328', '1664x928', '928x1664', '1472x1140', '1140x1472', '1584x1056', '1056x1584'],
          maxBatch: 4, note: '中文提示词友好，擅长文字/语义/外观编辑'
        },
        {
          id: 'Qwen/Qwen-Image-Edit-2509', label: 'Qwen-Image-Edit-2509（多图编辑版）', kind: 'edit',
          imageField: 'image', sizeMode: 'image_size',
          sizes: ['1328x1328', '1664x928', '928x1664', '1472x1140', '1140x1472', '1584x1056', '1056x1584'],
          maxBatch: 4, note: '指令跟随更强，支持更复杂的编辑描述'
        },
        {
          id: 'black-forest-labs/FLUX.1-Kontext-pro', label: 'FLUX.1 Kontext pro（英文提示词强）', kind: 'edit',
          imageField: 'input_image', sizeMode: 'aspect_ratio',
          aspectRatios: ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16', '9:21'],
          maxBatch: 1, note: '写实风格与指令跟随优秀，建议用英文提示词'
        },
        {
          id: 'black-forest-labs/FLUX.1-Kontext-max', label: 'FLUX.1 Kontext max（质量优先）', kind: 'edit',
          imageField: 'input_image', sizeMode: 'aspect_ratio',
          aspectRatios: ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16', '9:21'],
          maxBatch: 1, note: '质量更高、更贵'
        },
        {
          id: 'black-forest-labs/FLUX.1-Kontext-dev', label: 'FLUX.1 Kontext dev（便宜）', kind: 'edit',
          imageField: 'input_image', sizeMode: 'aspect_ratio',
          aspectRatios: ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16', '9:21'],
          maxBatch: 1, note: '成本低，适合试效果'
        },
        {
          id: 'Qwen/Qwen-Image', label: 'Qwen-Image（文生图 · 无参考图）', kind: 't2i',
          imageField: null, sizeMode: 'image_size',
          sizes: ['1328x1328', '1664x928', '928x1664', '1472x1140', '1140x1472', '1584x1056', '1056x1584'],
          maxBatch: 4, note: '只按提示词生成，不参考原图'
        },
        {
          id: 'black-forest-labs/FLUX.2-pro', label: 'FLUX.2 pro（文生图 · 无参考图）', kind: 't2i',
          imageField: null, sizeMode: 'image_size',
          sizes: ['512x512', '768x1024', '1024x768', '576x1024', '1024x576'],
          maxBatch: 1, note: '只按提示词生成，不参考原图'
        }
      ]
    },
    {
      id: 'openai',
      label: 'OpenAI 兼容接口（自定义 / 中转）',
      baseUrl: 'https://api.openai.com/v1',
      keyUrl: '',
      models: [
        {
          id: 'gpt-image-1', label: 'gpt-image-1（图像编辑）', kind: 'edit', imageField: 'image',
          sizeMode: 'size',
          // OpenAI 对尺寸有硬性约束：总像素 ≥ 655360、宽高均为 16 的倍数、单边 ≤ 3840、比例 1:3~3:1
          sizes: ['1024x1024', '1536x1024', '1024x1536', '1280x720', '720x1280', '1920x1088', '1088x1920'],
          maxBatch: 1, note: 'OpenAI 官方图像编辑模型；尺寸需满足像素下限与 16 倍数要求'
        },
        {
          id: 'gpt-image-2', label: 'gpt-image-2 / GPT Image 2.5（图像编辑）', kind: 'edit', imageField: 'image',
          sizeMode: 'size',
          sizes: ['1024x1024', '1536x1024', '1024x1536', '1280x720', '720x1280', '1920x1088', '1088x1920'],
          maxBatch: 1, note: '尺寸约束同 gpt-image-1：≥0.66MP、16 倍数、单边 ≤3840'
        },
        {
          id: 'dall-e-3', label: 'dall-e-3（文生图）', kind: 't2i', imageField: null,
          sizeMode: 'size',
          sizes: ['1024x1024', '1792x1024', '1024x1792'],
          maxBatch: 1, note: '不支持参考图'
        }
      ]
    },
    {
      id: 'custom',
      label: '自定义（任意 OpenAI 兼容服务）',
      baseUrl: '',
      keyUrl: '',
      models: [
        { id: '', label: '手动填写模型名', kind: 'edit', imageField: 'image', sizeMode: 'image_size', sizes: [], maxBatch: 1, note: '按 OpenAI images/generations 格式发送' }
      ]
    }
  ];

  function getProvider(id) {
    return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
  }
  function findModel(providerId, modelId) {
    const p = getProvider(providerId);
    return p.models.find((m) => m.id === modelId) || null;
  }

  function joinUrl(base, path) {
    const b = String(base || '').replace(/\/+$/, '');
    const p = String(path || '').replace(/^\/+/, '');
    return b + '/' + p;
  }

  /**
   * 构造生图/编辑请求。
   * @param {object} o { baseUrl, model, prompt, imageDataUrl, size, aspectRatio, seed, batch, negativePrompt, kind, imageField, sizeMode, extra }
   * @returns {{url:string, headers:object, body:object}}
   */
  function buildImageRequest(o) {
    const baseUrl = o.baseUrl || 'https://api.siliconflow.cn/v1';
    const endpoint = resolveEndpoint(o);
    const url = joinUrl(baseUrl, endpoint);
    const headers = { 'Content-Type': 'application/json' };
    if (o.apiKey) headers['Authorization'] = 'Bearer ' + o.apiKey;
    const body = { model: o.model, prompt: o.prompt };
    const field = o.imageField;
    if (field && o.imageDataUrl) body[field] = o.imageDataUrl;
    if (o.sizeMode === 'image_size' && o.size) body.image_size = o.size;
    else if (o.sizeMode === 'size' && o.size) {
      // 最后一道保险：固定像素类接口若尺寸不合规，服务端会直接拒单，
      // 这里按服务商规范修正后再发，避免用户白等一次失败
      const pid = o.providerId || 'custom';
      const v = validateSize(o.size, pid);
      if (!v.ok) {
        const p = parseSize(o.size);
        const c = conformSize(p ? p[0] : 1024, p ? p[1] : 1024, pid);
        body.size = c.size;
      } else {
        body.size = o.size;
      }
    }
    else if (o.sizeMode === 'aspect_ratio' && o.aspectRatio) body.aspect_ratio = o.aspectRatio;
    if (o.negativePrompt) body.negative_prompt = o.negativePrompt;
    if (o.seed != null && o.seed !== '' && isFinite(o.seed)) body.seed = Number(o.seed);
    if (o.batch && o.batch > 1) body.batch_size = Math.min(o.batch, 4);
    if (o.extra && typeof o.extra === 'object') Object.assign(body, o.extra);
    return { url, headers, body };
  }

  /* ====================== 7.8 请求体编码（JSON / multipart） ====================== */

  function dataUrlToBytes(dataUrl) {
    const i = String(dataUrl || '').indexOf(',');
    if (i < 0) return { bytes: new Uint8Array(0), mime: 'image/png' };
    const head = dataUrl.slice(0, i);
    const m = /data:([^;]+)/.exec(head);
    const mime = m ? m[1] : 'image/png';
    const b64 = dataUrl.slice(i + 1);
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      return { bytes, mime };
    } catch (e) {
      return { bytes: new Uint8Array(0), mime };
    }
  }

  function mimeToExt(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    if (m.includes('webp')) return 'webp';
    return 'png';
  }

  /**
   * 判断一个模型应该用哪个接口。
   *
   * 这是本应用最容易踩的坑：OpenAI 的图像**编辑**接口是
   *   POST /v1/images/edits   —— multipart/form-data，image 作为文件字段
   * 而图像**生成**接口是
   *   POST /v1/images/generations —— application/json，只接受 prompt
   * 如果拿着参考图去打 generations，服务端只看到 prompt，图片被静默丢弃，
   * 表现为「上游回你一段文字」（code=upstream_text_reply）。
   */
  function resolveEndpoint(o) {
    const mode = o && o.endpoint;
    if (mode === 'edits') return 'images/edits';
    if (mode === 'generations') return 'images/generations';
    // 自动判断：需要带参考图的编辑任务，走 edits
    if (o && o.kind === 'edit' && o.imageDataUrl) {
      // 硅基流动的 Qwen-Image-Edit / Kontext 走 generations + JSON 里的图片字段
      if (o.providerId === 'siliconflow') return 'images/generations';
      return 'images/edits';
    }
    return 'images/generations';
  }

  /** 需要 multipart 的接口（目前只有 OpenAI 系的 edits） */
  function needsMultipart(endpoint) {
    return endpoint === 'images/edits';
  }

  /**
   * 构造 multipart/form-data 请求体。
   * @returns {{body:Uint8Array, contentType:string}}
   */
  function buildMultipartBody(o) {
    const boundary = '----PhotoStudio' + Math.random().toString(36).slice(2, 12);
    const enc = (s) => new TextEncoder().encode(s);
    const chunks = [];
    const push = (x) => chunks.push(typeof x === 'string' ? enc(x) : x);

    const field = (name, value) => {
      if (value === undefined || value === null || value === '') return;
      push(`--${boundary}\r\n`);
      push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
      push(String(value));
      push('\r\n');
    };

    const file = (name, dataUrl, filename) => {
      const { bytes, mime } = dataUrlToBytes(dataUrl);
      if (!bytes.length) return;
      push(`--${boundary}\r\n`);
      push(`Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`);
      push(`Content-Type: ${mime}\r\n\r\n`);
      push(bytes);
      push('\r\n');
    };

    file('image', o.imageDataUrl, 'source.' + mimeToExt(dataUrlToBytes(o.imageDataUrl).mime));
    if (o.maskDataUrl) file('mask', o.maskDataUrl, 'mask.png');
    field('model', o.model);
    field('prompt', o.prompt);
    if (o.size) field('size', o.size);
    if (o.quality) field('quality', o.quality);
    if (o.background) field('background', o.background);
    if (o.outputFormat) field('output_format', o.outputFormat);
    if (o.n != null) field('n', o.n);

    push(`--${boundary}--\r\n`);

    // 合并
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return { body: out, contentType: 'multipart/form-data; boundary=' + boundary };
  }

  /** 从各家响应里取出图片地址 / base64 */
  function parseImageResponse(json) {
    if (!json) return [];
    const out = [];
    const push = (url, b64) => {
      if (url) out.push({ url });
      else if (b64) out.push({ dataUrl: /^data:/.test(b64) ? b64 : 'data:image/png;base64,' + b64 });
    };
    if (Array.isArray(json.images)) for (const it of json.images) push(it && (it.url || it.image_url), it && (it.b64_json || it.base64));
    if (Array.isArray(json.data)) for (const it of json.data) push(it && (it.url || it.image_url), it && (it.b64_json || it.base64));
    if (Array.isArray(json.output)) for (const it of json.output) push(typeof it === 'string' ? it : (it && (it.url || it.image_url)), null);
    if (json.image) push(typeof json.image === 'string' ? json.image : json.image.url, null);
    if (json.url) push(json.url, null);
    if (json.result && json.result.images) for (const it of json.result.images) push(it && it.url, null);
    return out;
  }

  /**
   * 发送前的自检。返回 null 表示可以发；否则返回 {code, message} 供界面提示。
   * 这类问题最好在本地就拦住，别等接口报一句看不懂的错。
   */
  function validateImageRequest(o) {
    if (!o || !o.model) return { code: 'no-model', message: '还没有选择模型，请到设置里选择生图模型' };
    if (!o.prompt || !String(o.prompt).trim()) return { code: 'no-prompt', message: '请先写下要改什么' };
    const needsImage = o.kind !== 't2i';
    if (needsImage) {
      const f = o.imageField || 'image';
      const img = o.imageDataUrl;
      if (!img) {
        return {
          code: 'no-image',
          message: '选区图片没能准备好，请重新框选一次再生成'
        };
      }
      if (typeof img !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(img)) {
        return {
          code: 'bad-image',
          message: '选区图片编码异常（' + String(img).slice(0, 24) + '…）。请把「工作分辨率上限」调低后重试'
        };
      }
      // 去掉头部后估算真实字节数，太小的基本是空图
      const b64 = img.slice(img.indexOf(',') + 1);
      if (b64.length < 256) {
        return {
          code: 'empty-image',
          message: '选区图片内容为空（' + b64.length + ' 字节）。请重新框选，或把选区拉大一点'
        };
      }
      void f;
    }
    return null;
  }

  /**
   * 根据接口返回内容判断「问题出在哪」，给一句人能看懂的诊断。
   * 重点覆盖：请求被路由到对话模型、模型名不对、缺图、鉴权失败。
   */
  function diagnoseResponse(json, status, ctx) {
    ctx = ctx || {};
    // 接口报错未必是 JSON：可能是纯文本、HTML 错误页，甚至是被网关截断的片段。
    // 这里把 rawText 也纳入判断，否则「请上传图片」这类关键信息会被丢掉。
    const rawText = ctx.rawText ? String(ctx.rawText) : '';
    const raw = extractError(json, status);
    let text = String(raw || '');
    // extractError 在 json 为空时会退化成 "HTTP 400" 这种无信息量的串，
    // 这时原始响应文本（哪怕不是 JSON）才是有用信息，必须优先采用。
    if (rawText && (!text || /^HTTP \d+$/.test(text.trim()))) text = rawText;
    else if (rawText && rawText.length > text.length) text = rawText;
    const kind = ctx.kind || 'edit';
    // 去掉 HTML 标签，便于关键词匹配与展示
    const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    // 0) 最高优先级：上游明确表示「我回的是文字，不是图片」。
    //    这通常意味着接口后面配的是对话模型（或中转把请求路由错了），
    //    此时无论请求里有没有带图，都拿不到图片。必须先判这个，
    //    否则错误文案里的「上传照片」字样会把诊断带偏到「缺图」上。
    if (json && typeof json === 'object') {
      const errObj = json.error || json;
      const code = String((errObj && errObj.code) || json.code || '');
      if (/upstream_text_reply|text_reply|text.?only|not.?an?.?image.?model|returned.?text/i.test(code)) {
        return {
          code: 'text-model',
          message: '上游返回的是一段文字，不是图片',
          hint: '这说明当前接口地址或模型名指向的是「对话模型」，而不是生图模型。' +
            '请到设置里点「自动检测可用模型」，选一个标着「可编辑」的模型（例如 Qwen/Qwen-Image-Edit）；' +
            '如果你用的是中转接口，请确认该模型名在中转服务里对应的是图像生成接口。',
          raw: text
        };
      }
    }

    // 1) 响应结构不对：没有 images/data 数组，却明显是对话补全的结构
    //    注意：json.message 是各家通用的错误字段，不能当作对话回复的标志
    if (json && typeof json === 'object') {
      const looksLikeChat = !!(
        json.object === 'chat.completion' ||
        Array.isArray(json.choices) ||
        (json.choices && json.choices.length) ||
        (json.message && typeof json.message === 'object' && (json.message.role || json.message.content))
      );
      const hasImage = Array.isArray(json.images) || Array.isArray(json.data) || Array.isArray(json.output);
      if (!hasImage && looksLikeChat) {
        return {
          code: 'chat-endpoint',
          message: '接口返回的是对话回复，不是图片',
          hint: '当前地址或模型名指向的是对话模型。请确认「接口地址」是生图接口（硅基流动为 https://api.siliconflow.cn/v1），' +
            '「模型」填图像编辑模型（例如 Qwen/Qwen-Image-Edit）。',
          raw: text
        };
      }
    }

    // 2) 尺寸不合法：服务端在收单阶段就拒了，请求根本没进模型。
    //    这类错误里常带 image/size 字样，必须排在「缺图」判断之前，
    //    否则会被误诊成「没收到图片」，把用户引到错误的方向。
    if (/invalid.{0,12}(size|dimension|resolution)|size.{0,12}(invalid|not.{0,6}(allowed|supported|valid))|dimension.{0,12}(invalid|exceed)|must be at least \d+|total pixels|pixel.{0,12}(count|minimum|limit)|divisible by|must be a multiple of|分辨率|尺寸.{0,6}(不|无)合法|像素.{0,6}(不足|过少|低于)/i.test(plain)) {
      return {
        code: 'bad-size',
        message: '出图尺寸不符合接口要求，请求被拒',
        hint: '这类错误发生在服务端校验阶段，图片根本没送到模型。本应用已按服务商规范自动修正尺寸，' +
          '若仍出现，请把「工作分辨率上限」调低后重试，或在设置里换一个模型。原始信息里有服务商给出的具体限制。',
        raw: text
      };
    }

    // 2.5) 错误文案本身就是一段「助手口吻的回复」——典型的是把用户的提示词复述一遍，
    //      再以「我会……」「请上传……」作答。这也是对话模型的特征。
    // 长度阈值要照顾中文：中文一句话 20 字就够长了，英文才需要 40 字符
    const isLongEnough = HAS_CJK.test(plain) ? plain.length >= 14 : plain.length >= 40;
    if (isLongEnough &&
        /(我会|我将|请上传|请提供|很抱歉|抱歉|无法|不能|I will|I'll|Please upload|I cannot|Sorry)/i.test(plain) &&
        /(标记|选区|图片|照片|图像|image|photo)/i.test(plain) &&
        !/^\s*(invalid|error|failed|拒绝|失败)/i.test(plain)) {
      return {
        code: 'text-model',
        message: '上游返回的是一段文字回复，不是图片',
        hint: '回复内容像是在「复述你的要求并作答」，这是对话模型的典型行为。' +
          '请到设置里点「自动检测可用模型」，选择一个标注「可编辑」的生图模型后重试。',
        raw: text
      };
    }

    // 3) 文案里明显是在要图片 / 要求上传图片
    if (/请上传|上传.{0,6}图片|未收到图片|缺少.{0,4}图片|image.*required|missing.*image|需要.{0,4}原始照片|provide.*image|no image|image is empty|图片.{0,6}(为空|缺失|不存在)/i.test(plain)) {
      return {
        code: 'no-image',
        message: '接口说没收到图片',
        hint: '说明这次请求里没有带上选区图片。常见原因：① 选了「文生图」模型（如 Qwen/Qwen-Image、FLUX.2-pro），' +
          '它们不吃参考图，请换成 Qwen/Qwen-Image-Edit 或 FLUX.1-Kontext；② 选区太小导致图片为空，把选区拉大一点。',
        raw: text
      };
    }

    // 4) 鉴权
    if (status === 401 || status === 403 || /unauthor|invalid.*(token|api.?key)|认证|鉴权|token/i.test(plain)) {
      return {
        code: 'auth',
        message: 'API Key 无效或没有权限',
        hint: '请到设置里检查 API Key 是否填写正确、是否已过期，以及账号是否已开通该模型。',
        raw: text
      };
    }

    // 5) 模型不存在 / 名字写错
    if (status === 404 || /model.*(not.*exist|not.*found|invalid)|模型.{0,6}(不存在|无效)/i.test(plain)) {
      return {
        code: 'bad-model',
        message: '模型名不对或该账号没有这个模型',
        hint: '请到设置里重新选择模型，或到服务商控制台确认模型名（区分大小写，例如 Qwen/Qwen-Image-Edit）。',
        raw: text
      };
    }

    // 6) 限流 / 额度
    if (status === 429 || /rate.?limit|too many|quota|余额|额度|限流/i.test(plain)) {
      return {
        code: 'quota',
        message: '请求太频繁或额度不足',
        hint: '稍等一会儿再试；如果持续出现，请到服务商控制台查看余额与限流设置。',
        raw: text
      };
    }

    // 7) 内容审核
    if (/审核|违规|sensitive|moderation|safety|blocked/i.test(plain)) {
      return {
        code: 'moderation',
        message: '内容被服务商的安全审核拦下了',
        hint: '试试换一种描述方式，或把选区缩小到只包含需要修改的部分。',
        raw: text
      };
    }

    // 8) 服务端错误
    if (status >= 500) {
      return {
        code: 'server',
        message: '服务商那边出错了（HTTP ' + status + '）',
        hint: '通常是服务商临时故障，稍后重试；也可以换一个模型试试。',
        raw: text
      };
    }

    // 兜底：至少把接口原话完整呈现出来，再给方向性建议
    const shown = plain || ('请求失败（HTTP ' + status + '）');
    return {
      code: 'unknown',
      message: '接口返回：' + shown.slice(0, 200),
      hint: kind === 't2i'
        ? '当前选的是文生图模型，它不会参考原图。若要「改一块区域」，请换成图像编辑模型（如 Qwen/Qwen-Image-Edit）。'
        : '请核对设置里的接口地址、API Key 与模型名；若信息不明确，可展开原始信息查看完整返回。',
      raw: text
    };
  }

  function extractError(json, status) {
    if (!json) return 'HTTP ' + status;
    const m = json.message || (json.error && (json.error.message || json.error)) ||
      (json.data && typeof json.data === 'string' ? json.data : null);
    if (typeof m === 'string' && m) return m;
    try { return JSON.stringify(json).slice(0, 300); } catch (e) { return 'HTTP ' + status; }
  }

  /* ====================== 7.15 小选区上采样（应对上游最小尺寸限制） ====================== */

  /**
   * 把过小的请求图放大到满足上游最小尺寸。
   *
   * 背景：很多生图接口对输入图有硬性下限（OpenAI 类要求总像素 ≥ 655360，约 0.66MP）。
   * 摄影师却常常只框一小块（一颗痣、一处瑕疵、一行字），裁出来只有 100x100 左右，
   * 直接发过去会被服务端拒收。
   *
   * 解法：按整数倍放大到刚好达标，并在返回后按同一比例缩回去。
   * 关键约束：
   *   1. 放大倍数取「刚好达标的最小整数倍」，避免过度插值丢细节
   *   2. 长宽都必须对齐到 16 的倍数（部分接口的硬要求）
   *   3. 必须记录原始尺寸与放大倍数，供贴回时精确还原
   *
   * @param {number} w 原始宽
   * @param {number} h 原始高
   * @param {string} providerId
   * @returns {{needed:boolean, scale:number, w:number, h:number, srcW:number, srcH:number}}
   */
  function planUpscale(w, h, providerId) {
    const r = sizeRulesFor(providerId);
    const srcW = Math.max(1, Math.round(num(w, 1)));
    const srcH = Math.max(1, Math.round(num(h, 1)));

    // 先算「达标所需的最小放大倍数」
    let k = 1;
    if (r.minPixels > 0 && srcW * srcH < r.minPixels) {
      k = Math.sqrt(r.minPixels / (srcW * srcH));
      // 留 2% 余量，避免四舍五入后又差一点点
      k = k * 1.02;
    }
    // 边长限制：放大后不能超过 maxSide
    if (r.maxSide > 0 && Math.max(srcW, srcH) * k > r.maxSide) {
      k = r.maxSide / Math.max(srcW, srcH);
    }
    // 比例限制
    const ar = srcW / srcH;
    if (r.minAspect > 0 && (ar < r.minAspect || ar > r.maxAspect)) {
      // 比例本身越界时，放大也救不了 —— 交给调用方提示用户调整选区
      return { needed: false, scale: 1, w: srcW, h: srcH, srcW, srcH, aspectInvalid: true };
    }

    if (k <= 1.0001) {
      // 不需要放大，但仍要对齐到倍数（不改变内容比例）
      let W = srcW, H = srcH;
      if (r.multipleOf > 1) {
        W = Math.max(r.multipleOf, Math.round(srcW / r.multipleOf) * r.multipleOf);
        H = Math.max(r.multipleOf, Math.round(srcH / r.multipleOf) * r.multipleOf);
      }
      return { needed: W !== srcW || H !== srcH, scale: W / srcW, w: W, h: H, srcW, srcH };
    }

    let W = Math.ceil(srcW * k);
    let H = Math.ceil(srcH * k);
    if (r.multipleOf > 1) {
      W = Math.ceil(W / r.multipleOf) * r.multipleOf;
      H = Math.ceil(H / r.multipleOf) * r.multipleOf;
    }
    // 对齐后仍不足则继续加一档，确保一定达标
    let guard = 0;
    while (r.minPixels > 0 && W * H < r.minPixels && guard++ < 40) {
      if (r.multipleOf > 1) { W += r.multipleOf; H += r.multipleOf; }
      else { W = Math.ceil(W * 1.05); H = Math.ceil(H * 1.05); }
    }
    if (r.maxSide > 0 && (W > r.maxSide || H > r.maxSide)) {
      const k2 = r.maxSide / Math.max(W, H);
      W = Math.round(W * k2); H = Math.round(H * k2);
      if (r.multipleOf > 1) {
        W = Math.floor(W / r.multipleOf) * r.multipleOf;
        H = Math.floor(H / r.multipleOf) * r.multipleOf;
      }
    }
    W = Math.max(1, W); H = Math.max(1, H);
    return { needed: true, scale: W / srcW, w: W, h: H, srcW, srcH };
  }

  /**
   * 计算「从上游返回图里取出原始选区内容」的源矩形 —— 上采样版的精确逆运算。
   *
   * 这是最容易出错的一步：请求图被放大过，返回图又可能是另一种尺寸，
   * 所以必须用「原始选区尺寸 / 返回图尺寸」来定位，而不是用放大后的尺寸。
   *
   * @param {object} o { genW, genH, reqW, reqH, offX, offY, selW, selH }
   *   reqW/reqH 是「放大后」的请求图尺寸；offX/offY 是选区在「放大后请求图」中的位置；
   *   selW/selH 是选区「放大后」的尺寸
   * @returns {{sx,sy,sw,sh}}
   */
  function mapUpscaledSelection(o) {
    return mapSelectionToResult(o);
  }

  /* ====================== 7.005 成本预估 ====================== */

  /**
   * 各模型的单次调用价格（美元）。
   *
   * 数据来源（均为官方页面/官方博客，非猜测）：
   *   - 硅基流动官方博客：Qwen-Image-Edit $0.04、FLUX.1-Kontext-pro $0.04、Kontext-max $0.08
   *   - 硅基流动定价页：FLUX.2 [pro] $0.03、Z-Image-Turbo $0.005
   *   - OpenAI 官方模型页：gpt-image-1 分档 low $0.011 / medium $0.042 / high $0.167
   *
   * 注意：价格会变，这里只作为「量级参考」。用户可以在设置里覆盖单价。
   */
  const MODEL_PRICES = {
    // 硅基流动
    'Qwen/Qwen-Image-Edit': { usd: 0.04, note: '按张计费' },
    'Qwen/Qwen-Image-Edit-2509': { usd: 0.04, note: '按张计费' },
    'Qwen/Qwen-Image': { usd: 0.04, note: '按张计费' },
    'black-forest-labs/FLUX.1-Kontext-pro': { usd: 0.04, note: '按张计费' },
    'black-forest-labs/FLUX.1-Kontext-max': { usd: 0.08, note: '按张计费' },
    'black-forest-labs/FLUX.1-Kontext-dev': { usd: 0.02, note: '约值，按张计费' },
    'black-forest-labs/FLUX.2-pro': { usd: 0.03, note: '按张计费' },
    'black-forest-labs/FLUX.2-flex': { usd: 0.06, note: '按张计费' },
    'Tongyi-MAI/Z-Image-Turbo': { usd: 0.005, note: '按张计费' },
    // OpenAI（按质量档）
    'gpt-image-1': { usd: 0.042, note: 'medium 档；low $0.011 / high $0.167' },
    'gpt-image-2': { usd: 0.042, note: 'medium 档，约值' },
    'dall-e-3': { usd: 0.04, note: '标准档约值' }
  };

  /** 汇率用于人民币显示（仅作参考，用户可改） */
  const DEFAULT_USD_CNY = 7.1;

  /**
   * 查一个模型的单价。未收录的返回 null（界面显示「未知」而不是瞎猜）。
   */
  function modelPrice(modelId) {
    if (!modelId) return null;
    if (MODEL_PRICES[modelId]) return MODEL_PRICES[modelId];
    // 容错匹配：忽略大小写与分隔符
    const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(modelId);
    for (const k of Object.keys(MODEL_PRICES)) {
      if (norm(k) === target) return MODEL_PRICES[k];
    }
    return null;
  }

  /**
   * 预估一次生成的成本。
   *
   * 关键：一次点击可能产生**多次调用** ——
   * 选区过大时会自动分块（最多 9 块），每块各调用一次。
   * 所以不能简单按「1 次点击 = 1 张图」估算。
   *
   * @param {object} o { rect, tileMaxSide, overlap, model, preset, priceOverride, usdCny }
   * @returns {{calls:number, tiles:number, unitUsd:number|null, totalUsd:number|null,
   *            totalCny:number|null, known:boolean, note:string}}
   */
  function estimateCost(o) {
    o = o || {};
    const rect = o.rect || { w: 1, h: 1 };
    const tileMaxSide = num(o.tileMaxSide, 1400);
    // 分块数：与真实生成路径一致（超过上限才分块）
    let tiles = 1;
    if (tileMaxSide > 0) {
      tiles = planTileCrop(rect, { maxSide: tileMaxSide, overlap: num(o.overlap, 80) }).length || 1;
    }
    const calls = Math.max(1, tiles);

    const price = (o.priceOverride != null && num(o.priceOverride, -1) >= 0)
      ? { usd: num(o.priceOverride, 0), note: '自定义单价' }
      : modelPrice(o.model);

    if (!price) {
      return {
        calls, tiles, unitUsd: null, totalUsd: null, totalCny: null,
        known: false,
        note: '这个模型没有收录价格，可在设置里手动填写单价'
      };
    }
    const unitUsd = price.usd;
    const totalUsd = unitUsd * calls;
    const rate = num(o.usdCny, DEFAULT_USD_CNY);
    return {
      calls, tiles,
      unitUsd, totalUsd,
      totalCny: totalUsd * rate,
      known: true,
      note: price.note || ''
    };
  }

  /** 累计花费统计（会话内） */
  function accumulateSpend(prev, estimate) {
    const p = prev || { calls: 0, usd: 0, unknownCalls: 0 };
    // 没有 estimate 就不该计数（默认 0，不是 1）——
    // 否则「未知情况」会被当成发生了一次调用，把统计算多。
    if (!estimate || !estimate.calls) {
      return { calls: p.calls, usd: p.usd, unknownCalls: p.unknownCalls };
    }
    const calls = num(estimate.calls, 0);
    return {
      calls: p.calls + calls,
      usd: p.usd + (estimate.known ? num(estimate.totalUsd, 0) : 0),
      unknownCalls: p.unknownCalls + (estimate.known ? 0 : calls)
    };
  }

  /** 金额格式化：小额显示更多小数位，避免显示成 $0.00 */
  function formatUsd(v) {
    const n = num(v, 0);
    if (n === 0) return '$0';
    if (n < 0.01) return '$' + n.toFixed(4);
    if (n < 1) return '$' + n.toFixed(3);
    if (n < 100) return '$' + n.toFixed(2);
    return '$' + Math.round(n);
  }

  function formatCny(v) {
    const n = num(v, 0);
    if (n === 0) return '¥0';
    if (n < 0.1) return '¥' + n.toFixed(3);
    if (n < 100) return '¥' + n.toFixed(2);
    return '¥' + Math.round(n);
  }

  /* ====================== 7.01 导出预设 ====================== */

  /**
   * 导出预设。
   *
   * 摄影师的交付场景差别很大：客户要全尺寸带拍摄信息，朋友圈要压到长边 2000
   * 且最好别带 GPS，后期交接要最高质量。所以做成预设而不是一堆散装参数。
   *
   * 字段说明：
   *   maxSide   长边上限（0 = 保持原尺寸）
   *   format    jpeg | png
   *   quality   JPEG 质量 0~1
   *   keepExif  是否写回拍摄信息
   *   keepGps   是否保留 GPS（社交平台建议关闭，避免暴露位置）
   *   keepIcc   是否写回 ICC 色彩配置
   */
  const EXPORT_PRESETS = [
    {
      id: 'full',
      label: '原尺寸交付（客户/后期）',
      desc: '保持原始尺寸与最高画质，保留拍摄信息与色彩配置',
      maxSide: 0, format: 'jpeg', quality: 0.95,
      keepExif: true, keepGps: true, keepIcc: true
    },
    {
      id: 'print',
      label: '无损交接（印刷/精修）',
      desc: 'PNG 无损格式，保留全部元数据，适合后续再加工',
      maxSide: 0, format: 'png', quality: 1,
      keepExif: true, keepGps: true, keepIcc: true
    },
    {
      id: 'wechat',
      label: '微信 / 朋友圈',
      desc: '长边 2000px，体积小易发送，去除定位信息',
      maxSide: 2000, format: 'jpeg', quality: 0.85,
      keepExif: true, keepGps: false, keepIcc: true
    },
    {
      id: 'social',
      label: '小红书 / 微博',
      desc: '长边 1440px，画质与体积均衡，去除定位信息',
      maxSide: 1440, format: 'jpeg', quality: 0.88,
      keepExif: true, keepGps: false, keepIcc: true
    },
    {
      id: 'web',
      label: '网页 / 预览',
      desc: '长边 1600px，体积优先，不保留元数据',
      maxSide: 1600, format: 'jpeg', quality: 0.8,
      keepExif: false, keepGps: false, keepIcc: false
    },
    {
      id: 'custom',
      label: '自定义',
      desc: '手动指定格式与质量',
      maxSide: 0, format: 'jpeg', quality: 0.95,
      keepExif: true, keepGps: true, keepIcc: true
    }
  ];

  function getExportPreset(id) {
    return EXPORT_PRESETS.find((p) => p.id === id) || EXPORT_PRESETS[0];
  }

  /**
   * 按预设计算导出尺寸。只缩不放（避免把小图拉大导致模糊）。
   * @returns {{w:number,h:number,scaled:boolean}}
   */
  function planExportSize(w, h, preset) {
    const W = Math.max(1, Math.round(num(w, 1)));
    const H = Math.max(1, Math.round(num(h, 1)));
    const maxSide = num(preset && preset.maxSide, 0);
    if (maxSide <= 0 || Math.max(W, H) <= maxSide) {
      return { w: W, h: H, scaled: false };
    }
    const k = maxSide / Math.max(W, H);
    return { w: Math.max(1, Math.round(W * k)), h: Math.max(1, Math.round(H * k)), scaled: true };
  }

  /**
   * 从 EXIF 里移除 GPS 信息（社交平台分享前建议去掉，避免暴露拍摄位置）。
   *
   * 做法：找到 GPS IFD 指针（tag 0x8825）并清零，这样 GPS 数据就成了不可达的
   * 孤立数据，读取方不会解析它。比重新构造整个 EXIF 安全得多。
   */
  function stripGpsFromExif(tiff) {
    if (!tiff || tiff.length < 8) return { exif: tiff, removed: false };
    const out = new Uint8Array(tiff);
    const le = out[0] === 0x49 && out[1] === 0x49;
    const be = out[0] === 0x4d && out[1] === 0x4d;
    if (!le && !be) return { exif: out, removed: false };
    const u16 = (o) => (le ? (out[o] | (out[o + 1] << 8)) : ((out[o] << 8) | out[o + 1]));
    const u32 = (o) => (le
      ? ((out[o] | (out[o + 1] << 8) | (out[o + 2] << 16) | (out[o + 3] << 24)) >>> 0)
      : (((out[o] << 24) | (out[o + 1] << 16) | (out[o + 2] << 8) | out[o + 3]) >>> 0));
    if (u16(2) !== 0x002a) return { exif: out, removed: false };
    const ifd0 = u32(4);
    if (ifd0 + 2 > out.length) return { exif: out, removed: false };
    const count = u16(ifd0);
    for (let k = 0; k < count; k++) {
      const e = ifd0 + 2 + k * 12;
      if (e + 12 > out.length) break;
      if (u16(e) === 0x8825) {          // GPS IFD 指针
        for (let n = 0; n < 12; n++) out[e + n] = 0;   // 整条记录清零
        return { exif: out, removed: true };
      }
    }
    return { exif: out, removed: false };
  }

  /**
   * 按预设决定「这次导出要写回哪些元数据」。
   * @returns {{exif:Uint8Array|null, icc:Uint8Array|null, notes:string[]}}
   */
  function planExportMetadata(meta, preset) {
    const notes = [];
    if (!meta || meta.source !== 'jpeg') return { exif: null, icc: null, notes };
    const p = preset || EXPORT_PRESETS[0];
    let exif = null;
    if (p.keepExif && meta.exif) {
      exif = meta.exif;
      if (!p.keepGps) {
        const r = stripGpsFromExif(exif);
        exif = r.exif;
        if (r.removed) notes.push('已移除定位信息');
      }
    } else if (meta.exif && !p.keepExif) {
      notes.push('按预设未保留拍摄信息');
    }
    let icc = null;
    if (p.keepIcc && meta.icc && meta.iccIsSrgb) {
      icc = meta.icc;
    } else if (meta.icc && !meta.iccIsSrgb && p.keepIcc) {
      notes.push('原图是广色域，已按 sRGB 导出');
    }
    return { exif, icc, notes };
  }

  /* ====================== 7.015 撤销栈（命令式） ====================== */

  /**
   * 命令式撤销栈。
   *
   * 设计要点：**不存整张图快照**，只存「反向操作需要的最小数据」。
   * 比如删除一条图层，只需记录它的索引与内容引用（内容本身已存在），
   * 而不是把整张合成图复制一份 —— 否则 3072×2048 一次就是 24MB。
   *
   * 支持的操作类型：
   *   add-layer    新增图层
   *   remove-layer 删除图层
   *   param-layer  调整图层参数（羽化/强度/色彩匹配）
   *   toggle-layer 开关图层
   *   stroke       新增画笔笔迹
   *   clear-strokes 清空笔迹
   *   set-rect     选区变化
   */
  /** 支持撤销的命令类型（不在表里的一律拒绝） */
  const KNOWN_COMMANDS = {
    'add-layer': 1, 'remove-layer': 1, 'param-layer': 1, 'toggle-layer': 1,
    'stroke': 1, 'clear-strokes': 1, 'set-rect': 1
  };

  function createUndoStack(limit) {
    // 下限设为 1：调用方传什么就是什么（便于测试与按需裁剪），默认 100 条
    const max = Math.max(1, Math.round(num(limit, 100)));
    const past = [];
    const future = [];

    const api = {
      /** 记录一个已发生的操作。未知类型一律拒绝，避免历史里出现「撤销不掉」的条目 */
      push(cmd) {
        if (!cmd || !cmd.type) return;
        if (!KNOWN_COMMANDS[cmd.type]) return;
        past.push(cmd);
        if (past.length > max) past.shift();   // 超出上限丢最老的
        future.length = 0;                      // 新操作使重做栈失效
      },
      /** 取出反向操作（用于撤销），并把该命令移入重做栈 */
      undo() {
        const cmd = past.pop();
        if (!cmd) return null;
        future.push(cmd);
        return cmd;
      },
      /** 取出正向操作（用于重做） */
      redo() {
        const cmd = future.pop();
        if (!cmd) return null;
        past.push(cmd);
        return cmd;
      },
      canUndo() { return past.length > 0; },
      canRedo() { return future.length > 0; },
      /** 最近一次操作的描述（用于按钮提示） */
      lastLabel() { return past.length ? (past[past.length - 1].label || '') : ''; },
      nextRedoLabel() { return future.length ? (future[future.length - 1].label || '') : ''; },
      clear() { past.length = 0; future.length = 0; },
      size() { return { past: past.length, future: future.length }; }
    };
    return api;
  }

  /**
   * 生成「撤销某条命令」所需的参数。
   *
   * 关键：删除图层时记录**索引**，撤销时插回原位置 ——
   * 这样图层顺序不会乱（顺序会影响合成结果）。
   */
  function makeUndoCommand(type, payload) {
    const p = payload || {};
    switch (type) {
      case 'add-layer':
        // 撤销 = 删除这个图层；重做 = 再加回来（用同一个 patch 引用，不复制）
        return {
          type,
          label: p.label || '新增修改',
          layer: p.layer,
          index: num(p.index, -1)
        };
      case 'remove-layer':
        return {
          type,
          label: p.label || '删除修改',
          layer: p.layer,
          index: num(p.index, 0)
        };
      case 'param-layer':
        return {
          type,
          label: p.label || '调整参数',
          index: num(p.index, 0),
          key: p.key,                 // 'feather' | 'opacity' | 'colorMatch'
          before: p.before,
          after: p.after
        };
      case 'toggle-layer':
        return {
          type,
          label: p.label || '开关修改',
          index: num(p.index, 0),
          before: p.before,
          after: p.after
        };
      case 'stroke':
        return { type, label: p.label || '画笔笔迹', stroke: p.stroke };
      case 'clear-strokes':
        return { type, label: p.label || '清空笔迹', strokes: p.strokes || [] };
      case 'set-rect':
        return { type, label: p.label || '调整选区', before: p.before, after: p.after };
      default:
        return null;
    }
  }

  /**
   * 把命令「反向执行」或「正向执行」所需的参数归一化。
   * @param {object} cmd
   * @param {boolean} isRedo  true=重做（正向），false=撤销（反向）
   */
  function commandDirection(cmd, isRedo) {
    const c = cmd || {};
    switch (c.type) {
      case 'add-layer':
        // 撤销：删掉；重做：加回
        return { action: isRedo ? 'insert-layer' : 'remove-layer', index: c.index, layer: c.layer };
      case 'remove-layer':
        // 撤销：加回；重做：删掉
        return { action: isRedo ? 'remove-layer' : 'insert-layer', index: c.index, layer: c.layer };
      case 'param-layer':
        return { action: 'set-param', index: c.index, key: c.key, value: isRedo ? c.after : c.before };
      case 'toggle-layer':
        return { action: 'set-enabled', index: c.index, value: isRedo ? c.after : c.before };
      case 'stroke':
        return { action: isRedo ? 'add-stroke' : 'remove-last-stroke' };
      case 'clear-strokes':
        return { action: isRedo ? 'clear-strokes' : 'restore-strokes', strokes: c.strokes };
      case 'set-rect':
        return { action: 'set-rect', rect: isRedo ? c.after : c.before };
      default:
        return null;
    }
  }

  /* ====================== 7.02 编辑图层（非破坏性） ====================== */

  /**
   * 归一化一个编辑图层的参数，补齐缺省值并夹取到合法范围。
   *
   * 设计要点：羽化、色彩匹配强度、不透明度这些参数**不在生成时烧进 patch**，
   * 而是在「合成时」应用。因此可以随时调整它们而不需要重新调用模型（不花钱）。
   */
  function normalizeLayer(e) {
    const L = e || {};
    return {
      rect: L.rect,
      patch: L.patch,
      mask: L.mask || null,
      feather: Math.max(0, num(L.feather, 10)),
      colorMatch: clamp01(num(L.colorMatch, 0.5)),
      opacity: clamp01(num(L.opacity, 1)),          // 整体混合强度（0=不生效 1=完全生效）
      enabled: L.enabled !== false,                 // 图层开关
      label: typeof L.label === 'string' ? L.label : '',
      createdAt: num(L.createdAt, 0),
      downscaled: !!L.downscaled
    };
  }

  /**
   * 计算「某个像素实际应被替换的比例」。
   *
   * 把三个因素相乘：
   *   - 掩膜：用户用画笔排除的区域（0 = 完全不动）
   *   - 羽化：边界过渡（0 边缘 → 1 内部）
   *   - 不透明度：图层整体强度（用户可调，用来「减弱」效果）
   *
   * 三者独立，所以用户调不透明度时不会破坏画笔排除的区域。
   *
   * @returns {number} 0~1
   */
  function layerAlphaAt(px, py, layer, w, h) {
    const L = normalizeLayer(layer);
    if (!L.enabled) return 0;
    const d = edgeDistance(px, py, w, h);
    const featherA = L.feather <= 0 ? 1 : smoothstep(0, Math.min(L.feather, Math.min(w, h) / 3), d);
    const maskA = L.mask ? clamp01(L.mask[py * w + px]) : 1;
    return clamp01(featherA * maskA * L.opacity);
  }

  /** 生成整个图层的 alpha 图（0~1 的 Float32Array），供预览或导出使用 */
  function layerAlphaMap(layer, w, h) {
    const L = normalizeLayer(layer);
    const out = new Float32Array(w * h);
    if (!L.enabled) return out;   // 全 0
    const limit = Math.min(w, h) / 3;
    const f = Math.min(L.feather, limit);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const d = edgeDistance(x, y, w, h);
        const featherA = f <= 0 ? 1 : smoothstep(0, f, d);
        const maskA = L.mask ? clamp01(L.mask[i]) : 1;
        out[i] = clamp01(featherA * maskA * L.opacity);
      }
    }
    return out;
  }

  /**
   * 统计图层里「实际被改动」的像素比例（用于界面显示「这张图改了多少」）。
   */
  function layerCoverage(layer, w, h) {
    const L = normalizeLayer(layer);
    if (!L.enabled) return 0;
    const total = Math.max(1, w * h);
    const alpha = layerAlphaMap(L, w, h);
    let n = 0;
    for (let i = 0; i < alpha.length; i++) if (alpha[i] > 0.5) n++;
    return n / total;
  }

  /**
   * 图层排序辅助：把编辑列表按「影响面积」或「时间」排序展示。
   */
  function sortLayers(edits, by) {
    const list = (edits || []).map((e, i) => ({ e, i }));
    if (by === 'size') {
      list.sort((a, b) => (b.e.rect.w * b.e.rect.h) - (a.e.rect.w * a.e.rect.h));
    } else {
      list.sort((a, b) => a.i - b.i);   // 时间顺序
    }
    return list.map((x) => x.e);
  }

  /* ====================== 7.05 编辑历史内存管理 ====================== */

  /**
   * 估算一张 patch 画布的常驻内存（字节）。
   * canvas 的像素数据是 4 字节/像素，这是无法回避的硬开销。
   */
  function patchMemory(w, h) {
    return Math.max(0, num(w, 0) * num(h, 0) * 4);
  }

  /**
   * 规划编辑历史的内存预算。
   *
   * 背景：3072×2048 的图，每次编辑要存 24MB 的 patch。
   * 20 次编辑就是 480MB —— 手机上必然被系统杀掉。
   *
   * 策略（按优先级依次执行）：
   *   1. 先把较老的 patch 降采样保存（省内存，但撤销时清晰度略降）
   *   2. 仍超预算时，丢弃最老的编辑（并告知用户）
   *
   * @param {Array} edits        编辑列表（每项含 patch 画布）
   * @param {number} budgetBytes 允许的最大内存
   * @returns {{downscale:number[], drop:number, usedBytes:number, note:string}}
   *          downscale: 需要降采样的索引；drop: 需要丢弃的最老条目数
   */
  function planHistoryMemory(edits, budgetBytes) {
    const list = edits || [];
    const budget = Math.max(8 * 1024 * 1024, num(budgetBytes, 192 * 1024 * 1024));
    let used = 0;
    for (const e of list) used += patchMemory(e.patch.width, e.patch.height);

    const downscale = [];
    let drop = 0;
    let note = '';

    if (used <= budget) return { downscale, drop, usedBytes: used, note };

    // 策略 1：从最老的开始，把 patch 降到 1/2 边长（内存降到 1/4）
    // 保留最近 3 条不降采样，因为用户最可能回退最近的操作
    const keepSharp = Math.max(0, list.length - 3);
    for (let i = 0; i < keepSharp && used > budget; i++) {
      const e = list[i];
      const before = patchMemory(e.patch.width, e.patch.height);
      const after = before / 4;
      used -= (before - after);
      downscale.push(i);
    }
    if (used <= budget) {
      note = '较早的编辑已降采样保存（内存受限），最近几次不受影响';
      return { downscale, drop, usedBytes: used, note };
    }

    // 策略 2：仍超预算 → 丢弃最老的编辑
    let remain = used;
    for (let i = 0; i < list.length && remain > budget; i++) {
      remain -= patchMemory(list[i].patch.width, list[i].patch.height) / (downscale.indexOf(i) >= 0 ? 4 : 1);
      drop = i + 1;
    }
    note = '编辑次数较多，最早的 ' + drop + ' 次已无法回退（内存受限）';
    return { downscale, drop, usedBytes: Math.max(0, remain), note };
  }

  /**
   * 会话持久化：把编辑记录序列化成可存入 localStorage 的形式。
   *
   * 注意：不能直接存整张 patch（太大，localStorage 只有 5~10MB）。
   * 做法是把 patch 编码成 JPEG data URL，并限制总大小；超出时只保留最近的若干条。
   *
   * @param {Array} edits   编辑列表
   * @param {object} opts   { maxBytes, encode }
   * @returns {{items:Array, dropped:number, bytes:number}}
   */
  function planSessionPersist(edits, opts) {
    opts = opts || {};
    const maxBytes = num(opts.maxBytes, 3.5 * 1024 * 1024);   // 留余量给 localStorage
    const list = edits || [];
    const items = [];
    let bytes = 0;
    let dropped = 0;
    // 从最新往回取，保证「最近的工作」优先保住
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      // 只存必要信息：矩形、参数、掩膜、patch 的编码结果
      const item = {
        rect: { x: e.rect.x, y: e.rect.y, w: e.rect.w, h: e.rect.h },
        feather: e.feather,
        colorMatch: e.colorMatch,
        mask: e.mask ? Array.from(e.mask) : null,
        patch: opts.encode ? opts.encode(e.patch) : null
      };
      const size = item.patch ? String(item.patch).length : 0;
      if (bytes + size > maxBytes) { dropped = i + 1; break; }
      bytes += size;
      items.push(item);
    }
    items.reverse();   // 还原成时间顺序
    return { items, dropped, bytes };
  }

  /**
   * 掩膜压缩：掩膜是 0~1 的浮点数组，直接 JSON 存会膨胀。
   * 量化成 0~255 的字节并做 Base64，体积约降到 1/8。
   */
  function packMask(mask) {
    if (!mask || !mask.length) return null;
    const bytes = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) {
      bytes[i] = Math.max(0, Math.min(255, Math.round(mask[i] * 255)));
    }
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + CH)));
    }
    return btoaSafe(bin);
  }

  function unpackMask(str, length) {
    if (!str) return null;
    const bin = atobSafe(str);
    if (!bin) return null;
    const n = Math.min(bin.length, length || bin.length);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i) / 255;
    return out;
  }

  function btoaSafe(bin) {
    try {
      if (typeof btoa === 'function') return btoa(bin);
      if (typeof Buffer !== 'undefined') return Buffer.from(bin, 'binary').toString('base64');
    } catch (e) { /* ignore */ }
    return null;
  }

  function atobSafe(str) {
    try {
      if (typeof atob === 'function') return atob(str);
      if (typeof Buffer !== 'undefined') return Buffer.from(str, 'base64').toString('binary');
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ====================== 7.1 元数据（EXIF / ICC）读写 ====================== */

  /**
   * 解析 JPEG 的段结构。
   *
   * JPEG 由「标记段」组成：每段以 0xFF + 标记字节开头，后跟 2 字节长度（含长度本身）。
   * 元数据就藏在两类段里：
   *   APP1 (0xFFE1) —— EXIF（相机、镜头、光圈、快门、ISO、时间、GPS）
   *   APP2 (0xFFE2) —— ICC 色彩配置（可能分多段存放）
   * canvas 重绘会把这些段全部丢掉，所以导出时必须手动写回。
   *
   * @param {Uint8Array} bytes 整个 JPEG 文件
   * @returns {Array<{marker:number, start:number, end:number, data:Uint8Array}>}
   */
  function parseJpegSegments(bytes) {
    const out = [];
    if (!bytes || bytes.length < 4) return out;
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return out;   // 不是 JPEG
    let i = 2;
    while (i + 3 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      let marker = bytes[i + 1];
      // 填充字节 0xFF 可重复出现
      while (marker === 0xff && i + 2 < bytes.length) { i++; marker = bytes[i + 1]; }
      // 无长度字段的标记
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xd9) break;          // EOI
      if (marker === 0xda) break;          // SOS 之后是压缩数据，不再有元数据段
      if (i + 3 >= bytes.length) break;
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (len < 2) break;
      const start = i;
      const end = Math.min(bytes.length, i + 2 + len);
      out.push({ marker, start, end, data: bytes.subarray(i + 4, end) });
      i = end;
    }
    return out;
  }

  /** 从 JPEG 里取出 EXIF 的 TIFF 数据（不含 "Exif\0\0" 头） */
  function extractExif(bytes) {
    for (const seg of parseJpegSegments(bytes)) {
      if (seg.marker !== 0xe1) continue;
      const d = seg.data;
      if (d.length > 6 && d[0] === 0x45 && d[1] === 0x78 && d[2] === 0x69 && d[3] === 0x66 &&
          d[4] === 0x00 && d[5] === 0x00) {
        return d.subarray(6);   // 跳过 "Exif\0\0"
      }
    }
    return null;
  }

  /** 从 JPEG 里取出 ICC 色彩配置（APP2 可能分多段，需按序拼接） */
  function extractICC(bytes) {
    const chunks = [];
    for (const seg of parseJpegSegments(bytes)) {
      if (seg.marker !== 0xe2) continue;
      const d = seg.data;
      // 头部是 "ICC_PROFILE\0" + 序号(1B) + 总数(1B)
      if (d.length > 14 && d[0] === 0x49 && d[1] === 0x43 && d[2] === 0x43 && d[3] === 0x5f) {
        chunks.push({ seq: d[12], total: d[13], data: d.subarray(14) });
      }
    }
    if (!chunks.length) return null;
    chunks.sort((a, b) => a.seq - b.seq);
    let total = 0;
    for (const c of chunks) total += c.data.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c.data, off); off += c.data.length; }
    return out;
  }

  /**
   * 读取 EXIF 里的 Orientation（旋转标记）与几个常用字段。
   * 用来判断「像素是否已被浏览器旋转过」，避免写回时二次旋转。
   */
  function readExifOrientation(tiff) {
    if (!tiff || tiff.length < 8) return null;
    const le = tiff[0] === 0x49 && tiff[1] === 0x49;
    const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
    if (!le && !be) return null;
    const u16 = (o) => (le ? (tiff[o] | (tiff[o + 1] << 8)) : ((tiff[o] << 8) | tiff[o + 1]));
    const u32 = (o) => (le
      ? ((tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)) >>> 0)
      : (((tiff[o] << 24) | (tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]) >>> 0));
    if (u16(2) !== 0x002a) return null;
    const ifd0 = u32(4);
    if (ifd0 + 2 > tiff.length) return null;
    const count = u16(ifd0);
    for (let k = 0; k < count; k++) {
      const e = ifd0 + 2 + k * 12;
      if (e + 12 > tiff.length) break;
      if (u16(e) === 0x0112) return u16(e + 8);   // Orientation 是 SHORT，值内联存放
    }
    return null;
  }

  /** 把 EXIF 里的 Orientation 改写为 1（像素已被浏览器旋转，写回时不能再转） */
  function normalizeExifOrientation(tiff) {
    if (!tiff || tiff.length < 8) return tiff;
    const out = new Uint8Array(tiff);   // 复制一份，不改原数据
    const le = out[0] === 0x49 && out[1] === 0x49;
    const be = out[0] === 0x4d && out[1] === 0x4d;
    if (!le && !be) return out;
    const u16 = (o) => (le ? (out[o] | (out[o + 1] << 8)) : ((out[o] << 8) | out[o + 1]));
    const u32 = (o) => (le
      ? ((out[o] | (out[o + 1] << 8) | (out[o + 2] << 16) | (out[o + 3] << 24)) >>> 0)
      : (((out[o] << 24) | (out[o + 1] << 16) | (out[o + 2] << 8) | out[o + 3]) >>> 0));
    if (u16(2) !== 0x002a) return out;
    const ifd0 = u32(4);
    if (ifd0 + 2 > out.length) return out;
    const count = u16(ifd0);
    for (let k = 0; k < count; k++) {
      const e = ifd0 + 2 + k * 12;
      if (e + 12 > out.length) break;
      if (u16(e) === 0x0112) {
        // SHORT 类型值放在偏移 8 处（2 字节），按字节序写入 1
        if (le) { out[e + 8] = 1; out[e + 9] = 0; }
        else { out[e + 8] = 0; out[e + 9] = 1; }
        break;
      }
    }
    return out;
  }

  /** 把 TIFF 数据包成 EXIF 段内容（带 "Exif\0\0" 头） */
  function buildExifPayload(tiff) {
    if (!tiff || !tiff.length) return null;
    const out = new Uint8Array(6 + tiff.length);
    out[0] = 0x45; out[1] = 0x78; out[2] = 0x69; out[3] = 0x66; out[4] = 0x00; out[5] = 0x00;
    out.set(tiff, 6);
    return out;
  }

  /**
   * 把元数据段插入到 JPEG 的 SOI 之后。
   *
   * 注意：JPEG 单段数据上限 65533 字节。EXIF 若带缩略图可能超限，
   * 超限时优先保留 EXIF（丢掉其它段）并给出提示；ICC 按标准分片存放。
   *
   * @param {Uint8Array} jpeg   canvas 导出的 JPEG 字节
   * @param {object} meta       { exif: Uint8Array|null, icc: Uint8Array|null }
   * @returns {{bytes:Uint8Array, exifWritten:boolean, iccWritten:boolean, notes:string[]}}
   */
  function injectMetadata(jpeg, meta) {
    const notes = [];
    if (!jpeg || jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
      return { bytes: jpeg, exifWritten: false, iccWritten: false, notes: ['导出结果不是 JPEG，无法写入元数据'] };
    }
    const MAX = 65533;
    const segs = [];

    // ICC：按标准分片（每片头 14 字节 + 数据）
    let iccWritten = false;
    if (meta && meta.icc && meta.icc.length > 0) {
      const per = MAX - 14;
      const total = Math.ceil(meta.icc.length / per);
      if (total > 255) {
        notes.push('色彩配置过大，已跳过');
      } else {
        for (let k = 0; k < total; k++) {
          const part = meta.icc.subarray(k * per, Math.min(meta.icc.length, (k + 1) * per));
          const payload = new Uint8Array(14 + part.length);
          const hdr = 'ICC_PROFILE\0';
          for (let n = 0; n < 12; n++) payload[n] = hdr.charCodeAt(n);
          payload[12] = k + 1;
          payload[13] = total;
          payload.set(part, 14);
          segs.push({ marker: 0xe2, payload });
        }
        iccWritten = true;
      }
    }

    // EXIF：超限则尝试丢弃（但保留其它字段）
    let exifWritten = false;
    if (meta && meta.exif && meta.exif.length > 0) {
      const payload = buildExifPayload(meta.exif);
      if (payload.length <= MAX) {
        segs.push({ marker: 0xe1, payload });
        exifWritten = true;
      } else {
        notes.push('EXIF 数据过大（含缩略图），已跳过以保住照片本身');
      }
    }

    if (!segs.length) return { bytes: jpeg, exifWritten, iccWritten, notes };

    // 关键：先把 canvas 自带（或原有的）APP1/APP2 段全部剥掉，再写我们自己的。
    // canvas 导出 JPEG 时自带一个 sRGB ICC（约 456 字节），若不清掉就会出现
    // 两个 ICC 段，读回时被拼接成错误数据。
    const existing = parseJpegSegments(jpeg);
    const drop = existing.filter((x) => x.marker === 0xe1 || x.marker === 0xe2);

    // 逐段重建：把要丢弃的段跳过，其余（含 SOS 之后的压缩数据）原样保留
    const pieces = [];
    let cursor = 2;                                   // 跳过 SOI
    for (const d of drop) {
      if (d.start > cursor) pieces.push(jpeg.subarray(cursor, d.start));
      cursor = d.end;
    }
    if (cursor < jpeg.length) pieces.push(jpeg.subarray(cursor));

    let extra = 0;
    for (const sg of segs) extra += 2 + 2 + sg.payload.length;   // 0xFF + marker + 长度(2) + 数据
    let bodyLen = 0;
    for (const pc of pieces) bodyLen += pc.length;

    const out = new Uint8Array(2 + extra + bodyLen);
    out[0] = 0xff; out[1] = 0xd8;                                 // SOI
    let off = 2;
    for (const sg of segs) {
      const len = sg.payload.length + 2;
      out[off] = 0xff; out[off + 1] = sg.marker;
      out[off + 2] = (len >> 8) & 0xff; out[off + 3] = len & 0xff;
      out.set(sg.payload, off + 4);
      off += 4 + sg.payload.length;
    }
    for (const pc of pieces) { out.set(pc, off); off += pc.length; }
    return { bytes: out, exifWritten, iccWritten, notes, replaced: drop.length };
  }

  /**
   * 判断 ICC 配置是不是 sRGB（或极接近）。
   * 用途：canvas 会把像素转换到 sRGB，若原图是广色域，写回原配置会「错色」。
   */
  function isSrgbProfile(icc) {
    if (!icc || icc.length < 128) return true;   // 没有配置 = 按 sRGB 处理
    // ICC 文件头 12~15 字节是色彩空间签名，16~19 是连接空间
    const sig = String.fromCharCode(icc[16], icc[17], icc[18], icc[19]);
    if (sig !== 'XYZ ') return false;
    // 描述字段里通常含 "sRGB" 字样，做一次宽松匹配
    const n = Math.min(icc.length, 512);
    let desc = '';
    for (let i = 0; i < n; i++) {
      const c = icc[i];
      if (c >= 32 && c < 127) desc += String.fromCharCode(c);
    }
    return /sRGB|IEC61966/i.test(desc);
  }

  /* ====================== 7.2 图片头部解析（避免全尺寸解码） ====================== */

  /**
   * 只读文件头，解析出图片的像素尺寸。
   *
   * 为什么需要它：手机照片常达 8000x6000，若先全尺寸解码再缩放，
   * 仅解码就需要 180MB 以上，WebView 渲染进程极易被系统杀掉（表现为导入后黑屏）。
   * 有了尺寸就能在解码阶段直接指定目标大小（createImageBitmap 的 resizeWidth），
   * 完全跳过全尺寸位图。
   *
   * 支持 JPEG / PNG / WebP / GIF / BMP；解析不出来返回 null，由调用方兜底。
   * @param {Uint8Array} bytes 文件前若干字节（建议 >= 64KB，JPEG 的 SOF 段可能靠后）
   * @returns {{width:number,height:number,type:string}|null}
   */
  function parseImageSize(bytes) {
    if (!bytes || bytes.length < 16) return null;
    const b = bytes;
    const u16 = (i) => (b[i] << 8) | b[i + 1];
    const u32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

    // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return { width: u32(16), height: u32(20), type: 'png' };
    }
    // GIF: "GIF87a" / "GIF89a"
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
      return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8), type: 'gif' };
    }
    // BMP: "BM"，尺寸字段是小端序
    if (b[0] === 0x42 && b[1] === 0x4d) {
      const le32 = (i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) | 0;
      const w = le32(18), h = le32(22);
      if (w > 0 && h !== 0) return { width: w, height: Math.abs(h), type: 'bmp' };
      return null;
    }
    // WebP: "RIFF"...."WEBP"
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      const four = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (four === 'VP8X') {
        const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
        const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
        return { width: w, height: h, type: 'webp' };
      }
      if (four === 'VP8 ') {
        return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff, type: 'webp' };
      }
      if (four === 'VP8L') {
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, type: 'webp' };
      }
      return null;
    }
    // JPEG: FF D8 开头，扫描各段找 SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        let marker = b[i + 1];
        while (marker === 0xff && i + 2 < b.length) { i++; marker = b[i + 1]; }
        // 无长度字段的标记
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        if (marker === 0xd9 || marker === 0xda) break;   // 到扫描数据，后面没有尺寸信息了
        const len = u16(i + 2);
        if (len < 2) break;
        const isSOF = (marker >= 0xc0 && marker <= 0xc3) ||
                      (marker >= 0xc5 && marker <= 0xc7) ||
                      (marker >= 0xc9 && marker <= 0xcb) ||
                      (marker >= 0xcd && marker <= 0xcf);
        if (isSOF && i + 9 < b.length) {
          return { width: u16(i + 7), height: u16(i + 5), type: 'jpeg' };
        }
        i += 2 + len;
      }
      return null;
    }
    return null;
  }

  /* ====================== 7.5 模型自动检测与归类 ====================== */

  /** 判断一个模型 id 是不是图像生成/编辑模型，并推断它的能力 */
  function classifyModel(id) {
    const s = String(id || '').toLowerCase();
    if (!s) return null;

    // 明显不是图像模型的：文本 / 语音 / 视频 / 向量 / 重排
    if (/\b(chat|instruct|turbo|thinking|reasoner|coder|vl\b|vision|audio|speech|tts|asr|whisper|embedding|embed|rerank|bge|m3e|video|wan2|hunyuanvideo|cosyvoice|sensevoice)/.test(s)) {
      // 但带 image 字样的优先按图像处理，例如 qwen-vl 用于识图，不算生图
      if (!/(image|flux|kolors|sd3|stable-diffusion|dall-e|dalle|gpt-image|seedream|seededit|imagen|ideogram|recraft|qwen-image)/.test(s)) return null;
    }

    const isImage = /(image|flux|kolors|stable-diffusion|sd3|sdxl|dall-e|dalle|gpt-image|seedream|seededit|imagen|ideogram|recraft|z-image|janus|emu|hidream|lumina|playground|kandinsky|wanx|qwen-image)/.test(s);
    if (!isImage) return null;

    // 注意：gpt-image-1 既能文生图也支持传参考图做编辑，按「编辑」处理更贴合本应用用途；
    // dall-e-3 不支持参考图，保持文生图。
    const isEdit = /(edit|kontext|inpaint|img2img|image-to-image|refine|upscale|seededit|image-variation|gpt-image)/.test(s)
      && !/dall-?e/.test(s);
    return {
      id,
      kind: isEdit ? 'edit' : 't2i',
      sizeMode: /kontext/.test(s) ? 'aspect_ratio'
        : /(gpt-image|dall-e|dalle)/.test(s) ? 'size' : 'image_size',
      imageField: /kontext/.test(s) ? 'input_image' : 'image'
    };
  }

  /**
   * 从 /models 的返回里挑出可用的生图模型。
   * 不同服务商的返回结构不一样，这里做兼容。
   * @returns {Array<{id, kind, sizeMode, imageField, label, recommended}>}
   */
  function pickImageModels(json) {
    let list = [];
    if (Array.isArray(json)) list = json;
    else if (json && Array.isArray(json.data)) list = json.data;
    else if (json && Array.isArray(json.models)) list = json.models;
    else if (json && Array.isArray(json.result)) list = json.result;

    const out = [];
    const seen = new Set();
    for (const it of list) {
      const id = typeof it === 'string' ? it : (it && (it.id || it.model || it.name));
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const c = classifyModel(id);
      if (!c) continue;
      const known = findKnownModel(id);
      // 未收录的模型也要有可用的尺寸/比例参数，否则出图时挑不到尺寸、请求会缺参数
      const params = known || modelParams(id) || {};
      out.push({
        id,
        kind: params.kind || c.kind,
        sizeMode: params.sizeMode || c.sizeMode,
        imageField: params.imageField || c.imageField,
        sizes: params.sizes || null,
        aspectRatios: params.aspectRatios || null,
        maxBatch: params.maxBatch || 1,
        label: known ? known.label : id,
        known: !!known,
        // 编辑模型优先推荐：这个应用的主用途就是「框选局部修改」
        recommended: (params.kind || c.kind) === 'edit'
      });
    }
    // 编辑模型排前面，其次按名字稳定排序
    out.sort((a, b) => (b.recommended - a.recommended) || a.id.localeCompare(b.id));
    return out;
  }

  /** 在内置模型表里按 id 找（用于拿到官方推荐的尺寸/比例参数） */
  function findKnownModel(id) {
    for (const p of PROVIDERS) {
      for (const m of p.models) {
        if (m.id && m.id === id) return m;
      }
    }
    // 容错：忽略大小写与前后缀
    const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(id);
    for (const p of PROVIDERS) {
      for (const m of p.models) {
        if (m.id && norm(m.id) === target) return m;
      }
    }
    return null;
  }

  /** 给检测到的模型补上尺寸/比例参数（未收录的走通用兜底） */
  function modelParams(id) {
    const known = findKnownModel(id);
    if (known) return known;
    const c = classifyModel(id);
    if (!c) return null;
    return {
      id,
      kind: c.kind,
      sizeMode: c.sizeMode,
      imageField: c.imageField,
      sizes: c.sizeMode === 'image_size'
        ? ['1328x1328', '1664x928', '928x1664', '1472x1140', '1140x1472', '1584x1056', '1056x1584']
        : (c.sizeMode === 'size' ? ['1024x1024', '1536x1024', '1024x1536'] : null),
      aspectRatios: c.sizeMode === 'aspect_ratio'
        ? ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16', '9:21'] : null,
      maxBatch: 1
    };
  }

  /* ============================ 8. 提示词模板 ============================ */

  const STYLE_PRESETS = [
    { id: 'none', label: '不改风格', zh: '', en: '' },
    { id: 'retouch', label: '精细人像修图', zh: '按商业人像精修标准处理：皮肤通透自然、保留毛孔纹理，五官结构与人物身份完全不变', en: 'Apply high-end commercial portrait retouching: natural translucent skin with pores preserved; keep facial structure and identity exactly the same' },
    { id: 'remove', label: '去除多余物体', zh: '移除选区内的多余物体，并用周围环境合理补全背景，保持透视、光影与纹理一致', en: 'Remove the unwanted object in the selection and inpaint the background naturally, keeping perspective, lighting and texture consistent' },
    { id: 'sky', label: '替换天空', zh: '替换为通透的黄昏天空，云层自然，天空颜色与地面光影方向保持一致', en: 'Replace the sky with a clear golden-hour sky, natural clouds, consistent with the ground lighting direction' },
    { id: 'relight', label: '重塑光影', zh: '重塑光照：主光从画面左上方来，阴影自然过渡，高光不溢出', en: 'Relight the scene: key light from upper-left, natural shadow falloff, no blown highlights' },
    { id: 'film', label: '胶片调色', zh: '转为电影胶片质感：柔和对比、轻微颗粒、青橙色调，保持肤色自然', en: 'Grade as cinematic film: soft contrast, subtle grain, teal-and-orange palette, natural skin tones' },
    { id: 'expand', label: '扩展画面', zh: '自然延伸画面内容，补全被裁掉的构图，保持光线、景深与镜头视角一致', en: 'Extend the frame naturally, completing the cropped composition, matching light, depth of field and lens perspective' },
    { id: 'text', label: '改文字/招牌', zh: '把选区内的文字替换为指定内容，字体、透视、光照与原画面完全一致', en: 'Replace the text in the selection with the requested content, matching font, perspective and lighting exactly' }
  ];

  const SCOPE_PRESETS = [
    { id: 'region', label: '只改选区' },
    { id: 'object', label: '只改选区里的主体' },
    { id: 'global', label: '整张统一处理' }
  ];

  /**
   * 拼装提示词。
   * @param {object} o { instruction, style, extra, scope, hasMask, language }
   */
  function buildPrompt(o) {
    o = o || {};
    const instruction = String(o.instruction || '').trim();
    const style = STYLE_PRESETS.find((s) => s.id === o.style) || STYLE_PRESETS[0];
    const extra = String(o.extra || '').trim();
    // 语言判定只看用户输入，避免被预设里的中文说明带偏
    const userText = instruction + extra;
    const isZh = o.language ? o.language === 'zh' : (HAS_CJK.test(userText) || !userText.trim());
    const parts = [];
    const core = [instruction, style[isZh ? 'zh' : 'en']].filter(Boolean).join('；');
    // 选区在请求图里的大致占比：四周留白是给模型看的周边环境。
    // 之前靠「把选区涂成蓝色」来告诉模型改哪里，结果蓝色被当成画面内容，
    // 生成结果整体偏蓝。现在改成用文字描述区域范围，图片保持原样。
    const center = Math.round(Math.min(100, Math.max(10, num(o.centerPct, 80))));

    if (isZh) {
      if (o.scope === 'global') {
        parts.push('以这张照片为基础做整体调整');
        if (core) parts.push(core);
        parts.push('保持画面中的人物身份、五官特征、构图与透视不变，输出同一张照片的自然处理结果');
      } else if (o.scope === 'object') {
        parts.push('这是一张照片的局部裁切，请只修改画面中央约 ' + center + '% 区域内的主体');
        if (core) parts.push(core);
        parts.push('四周留出的部分是用于参考的周边环境，请保持构图、背景、光线方向、色彩基调、清晰度与颗粒感一致');
      } else {
        parts.push('这是一张照片的局部裁切，请修改画面中央约 ' + center + '% 的区域');
        if (core) parts.push(core);
        parts.push('四周留出的部分是用于参考的周边环境，请保持构图、背景、光线方向、色彩基调、清晰度与颗粒感一致');
      }
      if (extra) parts.push(extra);
      parts.push('只改动上面描述的内容，其余部分不要改动');
      parts.push('输出必须是一张完整的真实照片，不要出现拼接痕迹、边框、水印或多余元素');
    } else {
      if (o.scope === 'global') {
        parts.push('Adjust this photo globally');
        if (core) parts.push(core);
        parts.push('Keep the subject identity, facial features, composition and perspective unchanged; return a natural retouched version of the same photo');
      } else if (o.scope === 'object') {
        parts.push('This is a crop of a larger photo; modify only the main subject within the central ~' + center + '% area');
        if (core) parts.push(core);
        parts.push('The surrounding margin is reference context; keep composition, background, light direction, color grading, sharpness and grain consistent');
      } else {
        parts.push('This is a crop of a larger photo; edit the central ~' + center + '% area');
        if (core) parts.push(core);
        parts.push('The surrounding margin is reference context; keep composition, background, light direction, color grading, sharpness and grain consistent');
      }
      if (extra) parts.push(extra);
      parts.push('Change only what is described above and leave everything else untouched');
      parts.push('Output a single complete photorealistic photo, no seams, frames, watermarks or extra elements');
    }
    // 中文用「。」连接，英文用「. 」
    return parts.filter(Boolean).join(isZh ? '。' : '. ').replace(/。。+/g, '。');
  }

  /** 分块生成时给提示词附加的位置说明 */
  function tileHint(index, total, isZh) {
    if (total <= 1) return '';
    const pos = ['左上', '中上', '右上', '左中', '中央', '右中', '左下', '中下', '右下'];
    const p = pos[Math.min(index, pos.length - 1)];
    return isZh
      ? `这是同一张照片的局部（${p}区域，第 ${index + 1}/${total} 块），请与整张照片的风格、光线、色彩保持一致`
      : `This is a crop of a larger photo (${p} area, tile ${index + 1}/${total}); keep the style, lighting and colors consistent with the whole photo`;
  }

  /* ============================ 9. 导出 ============================ */

  function formatBytes(n) {
    if (!n && n !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 10 || i === 0 ? round(v) : v.toFixed(1)) + ' ' + u[i];
  }

  function timestampName(prefix, ext) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${prefix || 'photo'}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext || 'jpg'}`;
  }

  /** 估算某个选区要调用几次模型（分块） */
  function estimateCalls(rect, opts) {
    const tiles = planTileCrop(rect, opts);
    return tiles.length;
  }

  /* ============================ 导出 API ============================ */

  return {
    // 工具
    clamp, clamp01, lerp, smoothstep, round, num, HAS_CJK,
    // 几何
    clampRect, rectFromPoints, rectCenter, rectsEqual, expandRect, expandRectByPx,
    makeView, fitView, screenToImage, imageToScreen, imageRectToScreen, zoomAt, clampView,
    HANDLES, handlePoints, hitTest, CURSORS, resizeRect, pointInRect, rectsIntersect,
    // 像素
    makePixels, edgeDistance, featherMask, ringStats, compositeFeathered, mosaicRegion,
    // 掩膜
    strokesToMask, maskToRGBA, maskCoverage,
    // 色彩
    srgbToLinear, linearToSrgb, rgbToOklab, oklabToRgb, colorDistance,
    relativeLuminance, bestTextColor, rgbToHex, hexToRgb,
    // 尺寸
    parseSize, snapTo, resolveOutputSize, resolveAspectRatio, planTileCrop,
    SIZE_RULES, sizeRulesFor, validateSize, conformSize,
    planUpscale, mapUpscaledSelection,
    coverCrop, aspectMismatch, mapSelectionToResult,
    tileBlendWeights, accumulateTile, resolveAccumulated,
    parseImageSize,
    patchMemory, planHistoryMemory, planSessionPersist, packMask, unpackMask,
    normalizeLayer, layerAlphaAt, layerAlphaMap, layerCoverage, sortLayers,
    createUndoStack, makeUndoCommand, commandDirection,
    EXPORT_PRESETS, getExportPreset, planExportSize, stripGpsFromExif, planExportMetadata,
    MODEL_PRICES, DEFAULT_USD_CNY, modelPrice, estimateCost, accumulateSpend, formatUsd, formatCny,
    parseJpegSegments, extractExif, extractICC, readExifOrientation,
    normalizeExifOrientation, buildExifPayload, injectMetadata, isSrgbProfile,
    // 模型
    PROVIDERS, getProvider, findModel, joinUrl, buildImageRequest, parseImageResponse, extractError,
    dataUrlToBytes, resolveEndpoint, needsMultipart, buildMultipartBody,
    classifyModel, pickImageModels, findKnownModel, modelParams,
    validateImageRequest, diagnoseResponse,
    // 提示词
    STYLE_PRESETS, SCOPE_PRESETS, buildPrompt, tileHint,
    // 导出
    formatBytes, timestampName, estimateCalls
  };
});
