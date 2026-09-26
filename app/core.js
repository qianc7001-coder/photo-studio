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

    // ---- 无缝融合：把生成块对齐到周围环境 ----
    // 校正量随「离接缝的距离」衰减，但不是衰减到 0：
    //   贴边处 100% 校正（否则必然出现色差/亮度台阶）
    //   中心处保留一部分（默认 35%）——色偏是模型带来的瑕疵，不是用户的意图，
    //   所以中心也要压一部分；但压太多会把用户想要的改动一起抹掉。
    const fus = opts.fusion || null;
    const useFusion = !!(fus && fus.strength > 0);
    let plan = null, grain = null;
    if (useFusion) {
      plan = planFusion({
        src, rect: { x: rect.x, y: rect.y, w, h },
        dst, dstFull: opts.dstFull, dstOffset: opts.dstOffset,
        ring: fus.ring || 10
      });
      // 颗粒补偿：模型输出比真实照片平滑，接缝处「那块太干净」也很显眼
      if (fus.grain > 0 && opts.dstFull) {
        grain = planGrain({
          src, w, h,
          dst: opts.dstFull, dstRect: { x: rect.x, y: rect.y, w, h },
          stride: 2, max: 10 * clamp01(fus.grain),
          seed: num(fus.seed, 1)
        });
      }
    }
    const centerFloor = fus && fus.centerFloor != null ? clamp01(fus.centerFloor) : 0.35;
    const fuseStrength = useFusion ? clamp01(fus.strength) : 0;
    const grainAmt = grain && grain.ok ? grain.amount : 0;

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
        // 无缝融合：分两类处理，这是避免「把用户要的颜色改掉」的关键。
        //
        //   结构性差异（光照梯度、对比度）—— 模型系统性偏差，延伸到中心更自然
        //   内容性差异（整体色调）—— 用户可能就是要改成那个颜色，只在接缝附近施加
        //
        // 若两类都用同一强度，用户要的纯红会被均值对齐拉成偏暗的浊红，
        // 相当于融合在跟用户意图对着干（实现中真实踩到的坑）。
        if (useFusion) {
          const t = clamp01(d / ramp);
          const edgeFactor = 1 - smoothstep(0, 1, t);        // 贴边 1 → ramp 处 0
          const kStruct = fuseStrength * (centerFloor + (1 - centerFloor) * edgeFactor);
          // 均值：接缝处 100%，中心 0% —— 保证中心是用户要的颜色
          const kMean = fuseStrength * edgeFactor;
          const fused = fuseColor(r, g, b, (x + 0.5) / w, (y + 0.5) / h,
            { mean: kMean, struct: kStruct }, plan);
          r = fused[0]; g = fused[1]; b = fused[2];
        }
        // 颗粒补偿：只在接缝附近补，中心不补（中心是用户要的内容，加噪只会变脏）
        if (grainAmt > 0) {
          const t = clamp01(d / ramp);
          const gk = (1 - smoothstep(0, 1, t)) * grainAmt;
          if (gk > 0.05) {
            const n = grainNoise(x, y, grain.seed);
            r += n * gk; g += n * gk; b += n * gk;
          }
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
   * 一次点击 = 一次调用（整块选区一次生成，不分块）。
   * 早期版本会把大选区切成多块分别生成，但每块是模型**独立生成**的，
   * 重叠区内容必然不一致，加权平均后接缝出现重影/发糊 ——
   * 这是分块方案本身的固有缺陷，不是参数能调好的，所以已彻底移除。
   *
   * 参数里仍保留 tiles/calls 字段（值恒为 1），避免调用方到处改。
   *
   * @param {object} o { rect, model, preset, priceOverride, usdCny }
   * @returns {{calls:number, tiles:number, unitUsd:number|null, totalUsd:number|null,
   *            totalCny:number|null, known:boolean, note:string}}
   */
  function estimateCost(o) {
    o = o || {};
    const tiles = 1;
    const calls = 1;

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
   * 导出尺寸的自定义选项（长边像素）。
   *
   * 用户明确要求「可以选择格式、大小」，所以除了内置预设，
   * 还要能自己定尺寸 —— 预设覆盖不到的场合（比如交付要求长边 2400）就得手动填。
   */
  const EXPORT_SIZES = [
    { id: 'orig', label: '原始尺寸', maxSide: 0 },
    { id: '4096', label: '4096 px（4K 级）', maxSide: 4096 },
    { id: '3000', label: '3000 px（长边）', maxSide: 3000 },
    { id: '2400', label: '2400 px', maxSide: 2400 },
    { id: '2000', label: '2000 px（微信）', maxSide: 2000 },
    { id: '1600', label: '1600 px（网页）', maxSide: 1600 },
    { id: '1080', label: '1080 px（手机屏）', maxSide: 1080 }
  ];

  const EXPORT_FORMATS = [
    { id: 'jpeg', label: 'JPEG（体积小，通用）', mime: 'image/jpeg', ext: 'jpg' },
    { id: 'png', label: 'PNG（无损，体积大）', mime: 'image/png', ext: 'png' }
  ];

  /**
   * 把「自定义导出设置」规范化成和预设一样的结构，供 exportImage 统一使用。
   *
   * 这样自定义与预设走同一条代码路径，不会出现「预设能用、自定义漏了某项」。
   *
   * @param {object} o { format, maxSide, quality, keepExif, keepGps, keepIcc }
   * @returns {object} 与 EXPORT_PRESETS 元素同构
   */
  function makeCustomPreset(o) {
    const opt = o || {};
    const fmt = EXPORT_FORMATS.find((f) => f.id === opt.format) || EXPORT_FORMATS[0];
    const maxSide = Math.max(0, Math.min(16384, Math.round(num(opt.maxSide, 0))));
    return {
      id: 'custom',
      label: '自定义',
      desc: '自己指定格式与长边像素',
      // explicit=true：这个预设自己带齐了格式与质量，
      // 调用方必须直接用，不能再去读设置页的 S.cfg.format / S.cfg.quality。
      // （设置页那个「自定义」预设的格式/质量存在 S.cfg 里，两者不能混为一谈）
      explicit: true,
      maxSide,
      format: fmt.id,
      // PNG 无损，质量参数无意义；JPEG 夹在 60~100
      quality: fmt.id === 'png' ? 1 : Math.max(0.6, Math.min(1, num(opt.quality, 0.95))),
      keepExif: opt.keepExif !== false,
      keepGps: opt.keepGps !== false,
      keepIcc: opt.keepIcc !== false
    };
  }

  /**
   * 规划导出的最终尺寸，并把「会不会被放大」这件事说清楚。
   *
   * 与 planExportSize 的区别：多返回一个 hint 文案。
   * 小图不该被放大（会糊），所以 maxSide 大于原图时按原图输出，
   * 但要告诉用户「你要的 4000px 做不到，已按原图 1200px 输出」——
   * 否则用户以为设置没生效。
   *
   * @returns {{w:number, h:number, scaled:boolean, upscaled:boolean, hint:string}}
   */
  function planExportWithHint(w, h, preset) {
    const W = Math.max(1, Math.round(num(w, 1)));
    const H = Math.max(1, Math.round(num(h, 1)));
    const maxSide = num(preset && preset.maxSide, 0);
    const cur = Math.max(W, H);
    if (maxSide <= 0) {
      return { w: W, h: H, scaled: false, upscaled: false, hint: '原始尺寸 ' + W + ' × ' + H };
    }
    if (cur <= maxSide) {
      const hint = cur < maxSide
        ? '原图长边 ' + cur + ' px，小于设定的 ' + maxSide + ' px —— 不放大（避免模糊），按原图输出'
        : '原图长边正好 ' + cur + ' px';
      return { w: W, h: H, scaled: false, upscaled: false, hint };
    }
    const k = maxSide / cur;
    const nw = Math.max(1, Math.round(W * k)), nh = Math.max(1, Math.round(H * k));
    return {
      w: nw, h: nh, scaled: true, upscaled: false,
      hint: '缩放到 ' + nw + ' × ' + nh + '（长边 ' + maxSide + ' px）'
    };
  }

  /**
   * 预估导出体积（粗略）。
   *
   * 为什么需要：用户在「格式/尺寸」之间权衡时最关心体积 ——
   * PNG 可能比 JPEG 大十倍，选之前应该心里有数。
   * 用「像素数 × 每像素经验字节数」估算，数量级正确即可。
   *
   * @param {object} o { w, h, format, quality }
   * @returns {{bytes:number, text:string}}
   */
  function estimateExportSize(o) {
    const opt = o || {};
    const px = Math.max(1, num(opt.w, 1)) * Math.max(1, num(opt.h, 1));
    let perPx;
    if (opt.format === 'png') {
      // PNG 取决于内容复杂度，照片类通常 1.2~2.5 字节/像素，取中值
      perPx = 1.8;
    } else {
      // JPEG：质量越高每像素字节越多（0.95 → 约 0.55 B/px）
      const q = Math.max(0.6, Math.min(1, num(opt.quality, 0.95)));
      perPx = 0.12 + (q - 0.6) * 1.05;
    }
    const bytes = Math.max(1024, Math.round(px * perPx));
    return { bytes, text: formatBytes(bytes) };
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
      size() { return { past: past.length, future: future.length }; },
      /** 取出命令列表的副本（时间线要用完整顺序重放） */
      list() { return { past: past.slice(), future: future.slice() }; },
      /**
       * 丢弃「未来」的命令。
       *
       * 用于历史时间线「跳回某一步」：跳回去之后，后面的步骤就作废了
       * （和文本编辑器里改一个旧位置会让后续内容需要重做是一个道理）。
       * 返回被丢弃的条数。
       */
      dropFuture() {
        const n = future.length;
        future.length = 0;
        return n;
      },
      /**
       * 编辑数组被裁剪（丢弃最老的 n 条）后，同步修正历史里的索引。
       *
       * 为什么必须做：命令里存的是**索引**，不是对象引用。丢弃最老的图层后，
       * 所有索引都会前移；不修正的话撤销会作用到错误的图层上（删错图）。
       * 引用了「已被丢弃图层」的命令则整条移除 —— 它已经没有可撤销的对象了。
       */
      adjustForDrop(dropCount) {
        const d = Math.max(0, Math.round(num(dropCount, 0)));
        if (!d) return;
        const remap = (arr) => {
          const out = [];
          for (const c of arr) {
            if (!c || !c.type) continue;
            if (typeof c.index !== 'number') { out.push(c); continue; }
            const ni = c.index - d;
            if (ni < 0) continue;          // 引用的图层已丢弃，命令作废
            c.index = ni;
            out.push(c);
          }
          return out;
        };
        const np = remap(past), nf = remap(future);
        past.length = 0; for (const c of np) past.push(c);
        future.length = 0; for (const c of nf) future.push(c);
      }
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
    const cmd = buildUndoCommand(type, payload);
    // 打时间戳：历史时间线要显示「什么时候做的」。
    // 允许 payload.time 覆盖，方便测试断言固定值。
    if (cmd && !cmd.time) cmd.time = num((payload && payload.time), Date.now());
    return cmd;
  }

  function buildUndoCommand(type, payload) {
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

  /* ====================== 7.01b 历史时间线 ====================== */

  /**
   * 把撤销栈 + 当前编辑状态整理成一条「时间线」。
   *
   * 设计要点：**不存图片快照**，而是复用撤销栈的差异命令。
   * 时间线上的位置 = 已执行了多少条命令；跳转 = 连续撤销/重做。
   * 这样 100 步历史的内存开销和现在一样（只有命令对象）。
   *
   * @param {object} stack  createUndoStack 的实例
   * @param {object} state  { edits, strokes } 当前状态（用于算出每步的摘要）
   * @returns {{items: Array, cursor: number}}
   *   items[0] 恒为「原图」（初始状态），之后每一步是一条已执行的操作；
   *   cursor 指向「当前所处的位置」（等于已执行命令数）。
   */
  function buildTimeline(stack, state) {
    const s = (stack && stack.list) ? stack.list() : { past: [], future: [] };
    const edits = (state && state.edits) || [];
    const strokes = (state && state.strokes) || [];
    const past = s.past || [];
    const future = s.future || [];
    const total = past.length + future.length;

    // 第 0 项：原图
    const items = [{
      kind: 'origin',
      label: '原图',
      detail: '还没有任何修改',
      layers: 0,
      strokes: 0,
      time: 0,
      undone: false
    }];

    // 逐条累加，算出「执行到这一步时」的图层数与笔迹数。
    // 注意 future 里的命令是「已撤销」的，按顺序接在后面即为「重做后」的状态。
    let layers = 0, strokeN = 0;
    for (let i = 0; i < total; i++) {
      const cmd = i < past.length ? past[i] : future[i - past.length];
      const isUndone = i >= past.length;
      switch (cmd.type) {
        case 'add-layer': layers++; break;
        case 'remove-layer': layers = Math.max(0, layers - 1); break;
        case 'stroke': strokeN++; break;
        case 'clear-strokes': strokeN = 0; break;
        default: break;
      }
      items.push({
        kind: cmd.type,
        label: cmd.label || '操作',
        detail: describeCommand(cmd),
        layers,
        strokes: strokeN,
        time: num(cmd.time, 0),
        undone: isUndone
      });
    }

    // 用当前真实状态校准最后一格（命令累计可能与实际有偏差，
    // 比如内存整理丢弃过老图层）。这样「现在」这一格的数字一定准确。
    if (items.length) {
      const last = items[items.length - 1];
      last.layers = edits.length;
      last.strokes = strokes.length;
    }

    return { items, cursor: past.length };
  }

  /** 给一条命令生成人话摘要（时间线上的副标题） */
  function describeCommand(cmd) {
    const c = cmd || {};
    const idx = (typeof c.index === 'number' && c.index >= 0) ? ('第 ' + (c.index + 1) + ' 处') : '';
    switch (c.type) {
      case 'add-layer':
        return c.layer && c.layer.rect
          ? (c.layer.rect.w + '×' + c.layer.rect.h + ' 的区域')
          : '新增一处修改';
      case 'remove-layer': return '删掉了 ' + (idx || '一处修改');
      case 'param-layer': {
        const names = { feather: '羽化', opacity: '不透明度', colorMatch: '色彩匹配' };
        return (names[c.key] || c.key || '参数') + '：' +
          formatParam(c.key, c.before) + ' → ' + formatParam(c.key, c.after);
      }
      case 'toggle-layer': return (c.after ? '启用' : '临时关闭') + (idx ? ' ' + idx : '');
      case 'stroke': return '画笔涂抹（' + ((c.stroke && c.stroke.points && c.stroke.points.length) || 0) + ' 个点）';
      case 'clear-strokes': return '清空了全部笔迹';
      case 'set-rect':
        return c.after
          ? ('选区改为 ' + c.after.w + '×' + c.after.h)
          : '取消选区';
      default: return '';
    }
  }

  /** 参数值转成好读的文字（0~1 的显示成百分比，羽化显示像素） */
  function formatParam(key, v) {
    const n = num(v, 0);
    if (key === 'feather') return Math.round(n) + 'px';
    return Math.round(n * 100) + '%';
  }

  /**
   * 计算从当前位置跳到目标位置需要执行的操作序列。
   *
   * @param {number} cursor   当前位置（已执行命令数）
   * @param {number} target   目标位置
   * @param {number} total    命令总数
   * @returns {{undo: number, redo: number}} 需要撤销/重做的步数
   */
  function planHistoryJump(cursor, target, total) {
    const c = Math.max(0, Math.min(num(cursor, 0), num(total, 0)));
    const t = Math.max(0, Math.min(num(target, 0), num(total, 0)));
    return t < c ? { undo: c - t, redo: 0 } : { undo: 0, redo: t - c };
  }

  /* ====================== 7.01c 配置迁移 ====================== */

  /**
   * 当前配置迁移版本。
   * 每次需要「强制修正老版本留下的配置」时 +1。
   */
  const CFG_REV = 3;

  /**
   * 把老版本留下的配置迁移到当前版本。
   *
   * 为什么必须有这个：只改默认值对**已安装的用户无效** ——
   * 他们的 localStorage 里已经存了旧值，启动时会被原样读回来，
   * 新默认值永远不生效。所以要让新默认真正落地，必须显式改一次。
   *
   * 关键约束：**只迁移一次**。改完打上 __cfgRev 标记，
   * 之后用户自己调的值不会再被覆盖（否则用户手动改回来也白改）。
   *
   * @param {object} cfg   已经合并好的配置对象（会被就地修改）
   * @param {object} saved 从存储里读出来的原始对象（用于判断迁移版本）
   * @returns {{cfg:object, changed:string[]}} changed 列出实际被改动的字段
   */
  function migrateCfg(cfg, saved) {
    const c = cfg || {};
    const changed = [];
    // 首次安装（没有存档）没有「旧值」需要迁移。
    // 不早退的话，会在全新配置上凭空记录迁移项，用户一打开就看到
    // 「设置已按新版本自动调整」—— 而他根本没调过任何设置。
    if (!saved || typeof saved !== 'object') { c.__cfgRev = CFG_REV; return { cfg: c, changed }; }
    const rev = num(saved.__cfgRev, 0);
    if (rev >= CFG_REV) { c.__cfgRev = rev; return { cfg: c, changed }; }

    // rev 2 → 3：分块功能已彻底移除，配置里的 tile 字段一并删掉。
    // 留着它会让用户在设置里看到「大选区自动分块」而实际没有任何作用 ——
    // 功能删了但开关还在，比没这个开关更让人困惑。
    //
    // 注意必须查 **saved**（原始存档）而不是只看 c：
    // tile 已从 PERSIST_KEYS 移除，loadCfg 根本不会把它读进 cfg，
    // 只看 c 的话这里永远认为「没有这个字段」→ 不触发迁移 → 不落盘，
    // 于是 localStorage 里的残留字段永远清不掉。
    if (rev < 3) {
      if (c.tile !== undefined) { delete c.tile; changed.push('tile-removed'); }
      if (saved.tile !== undefined) changed.push('tile-removed');
    }

    c.__cfgRev = CFG_REV;
    return { cfg: c, changed };
  }

  /* ====================== 7.01d 作品库（跨天的修图记录） ====================== */

  /**
   * 作品库：记录「修过的每一张照片」，跨天保留。
   *
   * 与 7.015/7.01b 的区别：
   *   - 撤销栈 / 时间线：**当前这张图**的操作步骤，换图即失效
   *   - 作品库：**历史上修过的所有照片**，关掉应用、换图、隔几天都还在
   *
   * 存储策略（分层，省钱又留得住）：
   *   - 缩略图：每条都存（几十 KB），保证「看得见」
   *   - 完整会话：只在预算够时存，保证「能继续编辑」
   *   - 超预算：先把老条目的完整会话降级掉（保缩略图），再不够才整条淘汰
   */

  /** localStorage 按 UTF-16 计费：1 个字符占 2 字节。不算这个会严重低估占用 */
  function storageBytes(str) {
    if (str === null || str === undefined) return 0;
    return String(str).length * 2;
  }

  /** 作品库预算：localStorage 通常共 5MB，要给配置与会话留余量 */
  const LIBRARY_BUDGET_BYTES = 2.5 * 1024 * 1024;
  const LIBRARY_MAX_ITEMS = 80;
  const THUMB_MAX_SIDE = 360;

  /** 估算一条作品记录占多少存储 */
  function estimateWorkBytes(rec) {
    const r = rec || {};
    let n = 400;                                    // 元数据（文件名/时间/尺寸/计数）
    n += storageBytes(r.thumb);
    n += storageBytes(r.before);
    if (r.session) n += storageBytes(JSON.stringify(r.session));
    return n;
  }

  /** 归一化一条作品记录：补齐字段、夹掉非法值，避免脏数据把界面搞崩 */
  function normalizeWork(rec) {
    const r = rec || {};
    return {
      id: typeof r.id === 'string' && r.id ? r.id : '',
      at: num(r.at, 0),
      createdAt: num(r.createdAt, num(r.at, 0)),
      name: typeof r.name === 'string' && r.name ? r.name : '照片',
      imgW: Math.max(0, Math.round(num(r.imgW, 0))),
      imgH: Math.max(0, Math.round(num(r.imgH, 0))),
      docW: Math.max(0, Math.round(num(r.docW, 0))),
      docH: Math.max(0, Math.round(num(r.docH, 0))),
      edits: Math.max(0, Math.round(num(r.edits, 0))),
      thumb: typeof r.thumb === 'string' ? r.thumb : '',
      before: typeof r.before === 'string' ? r.before : '',
      session: (r.session && typeof r.session === 'object') ? r.session : null
    };
  }

  /** 按时间从新到旧排序（不改原数组） */
  function sortWorksNewestFirst(entries) {
    return (entries || []).slice().sort((a, b) => num(b.at, 0) - num(a.at, 0));
  }

  /**
   * 规划作品库的取舍：决定哪些留、哪些降级、哪些淘汰。
   *
   * 纯函数（不修改入参），返回 id 列表交给调用方执行 —— 这样好测。
   *
   * 淘汰顺序刻意「先降级再淘汰」：完整会话很占地方（几百 KB），
   * 但缩略图只要几十 KB。把老条目的会话丢掉，能多留好几倍的历史可见性。
   *
   * @param {Array} entries 作品记录数组
   * @param {object} opts { maxBytes, maxItems, pinnedId }
   * @returns {{keepIds:Array, downgradeIds:Array, evictIds:Array, bytes:number, note:string}}
   */
  function planLibrary(entries, opts) {
    const o = opts || {};
    const maxBytes = num(o.maxBytes, LIBRARY_BUDGET_BYTES);
    const maxItems = Math.max(1, Math.round(num(o.maxItems, LIBRARY_MAX_ITEMS)));
    const pinnedId = o.pinnedId || null;

    const sorted = sortWorksNewestFirst(entries);
    const keepIds = [], downgradeIds = [], evictIds = [];
    const downgraded = new Set();

    // 第一轮：按条数裁（置顶的当前作品永不淘汰）
    const kept = [];
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      const isPinned = pinnedId && e.id === pinnedId;
      if (i < maxItems || isPinned) kept.push(e);
      else evictIds.push(e.id);
    }

    /**
     * 一条记录「降级之后」的实际占用：降级会丢掉完整会话，只剩元数据 + 缩略图。
     * 必须按这个口径算，否则会重复扣减会话体积 —— 那会让账面占用远小于真实占用，
     * 于是计划以为放得下、实际却写爆 localStorage 配额。
     */
    const remainBytes = (e) => {
      const r = normalizeWork(e);
      let n = 400 + storageBytes(r.thumb) + storageBytes(r.before);
      if (r.session && !downgraded.has(r.id)) n += storageBytes(JSON.stringify(r.session));
      return n;
    };

    // 第二轮：按体积裁。先降级最老的（丢完整会话），仍超再淘汰
    let bytes = kept.reduce((s, e) => s + estimateWorkBytes(e), 0);
    if (bytes > maxBytes) {
      // 从最老的开始降级
      for (let i = kept.length - 1; i >= 0 && bytes > maxBytes; i--) {
        const e = kept[i];
        const isPinned = pinnedId && e.id === pinnedId;
        if (isPinned || !e.session) continue;
        bytes -= storageBytes(JSON.stringify(e.session));
        downgraded.add(e.id);
        downgradeIds.push(e.id);
      }
      // 还超就淘汰最老的（保留至少 1 条，否则界面会空得莫名其妙）
      for (let i = kept.length - 1; i >= 0 && bytes > maxBytes && kept.length > 1; i--) {
        const e = kept[i];
        const isPinned = pinnedId && e.id === pinnedId;
        if (isPinned) continue;
        bytes -= remainBytes(e);        // 已降级的条目不能再扣一次会话体积
        evictIds.push(e.id);
        kept.splice(i, 1);
      }
    }

    const finalIds = kept.map((e) => e.id);
    for (const id of finalIds) if (!evictIds.includes(id)) keepIds.push(id);

    let note = '';
    if (evictIds.length) {
      note = '空间已满，最早的 ' + evictIds.length + ' 条记录已被清理';
      if (downgradeIds.length) note += '，另有 ' + downgradeIds.length + ' 条转为仅保留预览';
    } else if (downgradeIds.length) {
      note = downgradeIds.length + ' 条较早的记录已转为仅保留预览';
    }

    return { keepIds, downgradeIds, evictIds, bytes, note };
  }

  /** 某个时间戳所在「那一天」的零点（本地时区） */
  function dayStartTs(ts) {
    const d = new Date(num(ts, 0));
    if (isNaN(d.getTime())) return 0;
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /**
   * 相对时间描述：今天 / 昨天 / N 天前 / 具体日期。
   * 用「自然日」而不是「距今小时数」—— 昨晚 23 点修的和今早 1 点修的
   * 只差两小时，但用户心里是「昨天」和「今天」。
   */
  function describeWorkAge(ts, now) {
    const n = num(now, Date.now());
    const t = num(ts, 0);
    if (!(t > 0)) return '';          // 时间戳损坏：交给调用方决定怎么显示
    const a = dayStartTs(t), b = dayStartTs(n);
    if (!a) return '';
    const days = Math.round((b - a) / 86400000);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 7) return days + ' 天前';
    const d = new Date(a);
    const y = d.getFullYear(), cy = new Date(b).getFullYear();
    const md = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return (y === cy ? '' : y + '年') + md;
  }

  /** 时刻 HH:MM。时间戳无效时返回空串（与 describeWorkAge 保持一致） */
  function formatWorkClock(ts) {
    const n = num(ts, 0);
    if (!(n > 0)) return '';
    const d = new Date(n);
    if (isNaN(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /**
   * 按自然日分组，便于界面显示「今天 / 昨天 / 9月23日」这样的分隔。
   * @returns {Array<{key:string, label:string, items:Array}>}
   */
  function groupWorksByDay(entries, now) {
    const n = num(now, Date.now());
    const sorted = sortWorksNewestFirst(entries);
    const out = [];
    let curKey = null, cur = null;
    for (const e of sorted) {
      const w = normalizeWork(e);
      if (!w.id) continue;
      // 时间戳损坏（0 / 非法）的记录不能算出自然日，单独归一组并给出兜底标题，
      // 否则会出现一个没有标题的分隔条
      const bad = !(num(w.at, 0) > 0);
      const k = bad ? 'unknown' : String(dayStartTs(w.at));
      if (k !== curKey) {
        curKey = k;
        cur = { key: k, label: bad ? '时间未知' : describeWorkAge(w.at, n), items: [] };
        out.push(cur);
      }
      cur.items.push(w);
    }
    return out;
  }

  /** 作品库统计（用于界面显示用量） */
  function workLibraryStats(entries) {
    const list = (entries || []).map(normalizeWork).filter((e) => e.id);
    let bytes = 0, withSession = 0;
    for (const e of list) {
      bytes += estimateWorkBytes(e);
      if (e.session) withSession++;
    }
    return {
      count: list.length,
      bytes,
      withSession,
      editable: withSession
    };
  }

  /* ====================== 7.01e 后台保活 ====================== */

  /**
   * 保活策略：什么时候该开启「后台保活」。
   *
   * 背景：生图请求通常要 30~60 秒，多块串行时更久。这期间用户很容易切走
   * （去看微信、锁屏、拍下一张）。Android 在后台会很快回收进程 ——
   * 一旦被杀，这次请求就白花钱了（上游已经生成，图却收不到）。
   *
   * 所以策略是：
   *   - **生成中必须保活**（这是花钱的时刻，绝不能断）
   *   - 用户手动打开的「一直保活」开关优先（长时间连续修图时有用）
   *   - 其它时候不保活：常驻通知是有代价的，不该无条件挂着
   *
   * 纯函数，便于把各种组合都测到。
   *
   * @param {object} o { busy, userAlwaysOn, supported, enabled }
   * @returns {{on:boolean, reason:string, note:string}}
   */
  function planKeepAlive(o) {
    const opt = o || {};
    const supported = opt.supported !== false;   // 非 Android 环境（浏览器/PWA）不支持
    const enabled = opt.enabled !== false;       // 总开关（设置里可关）

    if (!supported) return { on: false, reason: 'unsupported', note: '当前环境不支持后台保活' };
    if (!enabled) return { on: false, reason: 'disabled', note: '后台保活已在设置中关闭' };
    if (opt.busy) return { on: true, reason: 'generating', note: '生成中，正在保活' };
    if (opt.userAlwaysOn) return { on: true, reason: 'always', note: '已开启常驻保活' };
    return { on: false, reason: 'idle', note: '' };
  }

  /**
   * 保活状态该显示成什么。
   *
   * 刻意区分「正在保活」和「保活已就绪」：用户最关心的是
   * 「我现在切走会不会断」，所以要能一眼看出当前是不是受保护。
   */
  function describeKeepAlive(state, o) {
    const opt = o || {};
    const supported = opt.supported !== false;
    const enabled = opt.enabled !== false;
    const alwaysOn = !!opt.userAlwaysOn;
    if (!supported) return { text: '当前环境不支持', tone: 'muted', canAlways: false };
    if (!enabled) return { text: '已关闭', tone: 'muted', canAlways: true };
    if (state && state.on) {
      const why = state.reason === 'always' ? '常驻保活中' : '正在保活';
      return { text: why + '，切到后台也不会中断', tone: 'ok', canAlways: true };
    }
    if (alwaysOn) return { text: '保活开启中', tone: 'ok', canAlways: true };
    return {
      text: '空闲时不保活；生成时会自动保活',
      tone: 'muted',
      canAlways: true
    };
  }

  /**
   * 判断「这次生成值不值得提醒用户别切走」。
   *
   * 一次生成通常 30~60 秒。保活能挡住系统回收，但挡不住用户主动杀应用
   * （从最近任务划掉）—— 那种情况必须提前说明。
   *
   * 只提醒**一次**（seen=true 后不再提醒）：这条提示的内容对同一个人永远一样，
   * 每次生成都弹一遍纯属打扰 —— 与工具提示同一个原则。
   *
   * @param {object} o { supported, enabled, keepAlive, seconds, seen }
   */
  function planGenForegroundNotice(o) {
    const opt = o || {};
    const supported = opt.supported !== false;
    const enabled = opt.enabled !== false;
    const keepOn = !!(opt.keepAlive && opt.keepAlive.on);
    const seen = opt.seen === true;
    const sec = Math.max(0, Math.round(num(opt.seconds, 0)));
    // 保活开着才需要提醒（没开保活的话切走本来就可能丢，提醒也没用）
    return {
      show: supported && enabled && keepOn && !seen,
      text: '生成中（约 ' + (sec > 0 ? sec + ' 秒' : '30~60 秒') +
        '），已开启后台保活，切走或锁屏都不会中断 —— 但请别从最近任务里划掉应用。'
    };
  }

  /* ====================== 7.01e2 工具栏高度 ====================== */

  /**
   * 工具栏高度档位。
   *
   * 为什么需要：修图时最缺的是画布高度。工具栏展开占 240px 左右，
   * 在 6 寸手机上画布只剩一半 —— 但不同人需求不同：
   * 有人喜欢全展开随时点工具，有人只要一个生成按钮。
   * 所以给一个「自由调节」而不是写死的两档。
   *
   * 设计取舍：用「露出多少像素」而不是「百分比」描述 ——
   * 百分比在不同屏幕高度下表现不一致（同一档在大屏上露出的内容完全不同），
   * 像素值才能保证「正好露出工具行」这类意图在任何设备上都成立。
   */
  const BAR_MIN = 40;      // 只露手柄 + 一行工具

  /**
   * 把工具栏高度夹到合法范围。
   *
   * @param {number} h 期望露出高度（px）
   * @param {number} full 完全展开时的高度（px）
   * @param {number} viewH 视口高度（px）
   * @returns {number} 夹取后的高度
   */
  function clampBarHeight(h, full, viewH) {
    const f = Math.max(0, num(full, 0));
    const vh = Math.max(0, num(viewH, 0));
    // 上限：工具栏自身高度，且不超过视口的 70% —— 否则画布被挤没了
    const max = Math.min(f, Math.max(BAR_MIN, vh * 0.7));
    return Math.round(Math.max(BAR_MIN, Math.min(max, num(h, max))));
  }

  /**
   * 判断当前高度算「收起」还是「展开」。
   *
   * 阈值取「完全展开高度的一半」而不是固定像素：
   * 不同机型工具栏高度不同，固定阈值会让小屏上「稍微拉一点就算展开」。
   */
  function isBarCollapsed(h, full) {
    const f = Math.max(1, num(full, 1));
    return num(h, f) < f * 0.5;
  }

  /**
   * 规划工具栏状态。
   *
   * @param {object} o { height, full, viewH, hasImage }
   * @returns {{height:number, collapsed:boolean, full:number, pct:number}}
   */
  function planToolbar(o) {
    const opt = o || {};
    const full = Math.max(BAR_MIN, num(opt.full, 0));
    const viewH = num(opt.viewH, 0);
    const height = clampBarHeight(opt.height, full, viewH);
    return {
      height,
      full,
      collapsed: isBarCollapsed(height, full),
      // 展开程度（0~1），用于提示与动画
      pct: full > 0 ? Math.round((height / full) * 100) / 100 : 1
    };
  }

  /* ====================== 7.01f 浏览器能力兼容 ====================== */

  /**
   * 解析 WebView / 浏览器的能力等级，决定要不要打兼容补丁。
   *
   * 为什么要做这个：
   *   国产 ROM 常把系统 WebView 冻结在旧版本（尤其是没有 Play 商店的机型），
   *   而不同特性落地的版本差得很远：
   *     async/await   Chrome 55   ← 低于这个，整个脚本语法错误、白屏
   *     flex gap      Chrome 84   ← 低于这个，元素全挤在一起（不是变丑，是错位）
   *     inset         Chrome 87
   *     aspect-ratio  Chrome 88
   *   所以启动时要探测一次，给老内核打补丁。
   *
   * 注意：**不能用 `@supports (gap: 1px)` 判断 flex gap** ——
   * Chrome 66~83 里 grid gap 早就支持，这条会返回 true 却仍然不支持 flex gap，
   * 必须实际渲染两个盒子量间距。
   *
   * 纯函数，便于把各版本组合都测到。
   *
   * @param {object} o { chrome, hasFlexGap, hasInset, hasAspectRatio, hasMinFn, hasAsync }
   * @returns {{level:string, patches:Array<string>, warn:string, blocking:boolean}}
   */
  function planCompat(o) {
    const opt = o || {};
    const c = num(opt.chrome, 0);
    const has = (k, fallback) => (opt[k] === undefined ? fallback : !!opt[k]);
    const patches = [];

    // 硬门槛：语法层面的特性缺失意味着整个脚本跑不起来，只能明确告知用户
    const hasAsync = has('hasAsync', c >= 55 || c === 0);
    if (!hasAsync) {
      return {
        level: 'unsupported',
        patches: [],
        blocking: true,
        warn: '当前系统的浏览器内核太旧（不支持 async/await），页面无法运行。'
          + '请到应用商店更新「Android System WebView」，或升级系统。'
      };
    }

    if (!has('hasFlexGap', c >= 84)) patches.push('no-flex-gap');
    if (!has('hasInset', c >= 87)) patches.push('no-inset');
    if (!has('hasAspectRatio', c >= 88)) patches.push('no-aspect-ratio');
    if (!has('hasMinFn', c >= 79)) patches.push('no-css-minmax');

    let level = 'modern';
    if (patches.length) level = c >= 70 ? 'patched' : 'legacy';

    let warn = '';
    if (patches.length) {
      warn = '当前系统的浏览器内核版本较旧，已自动启用兼容显示。'
        + '若界面有错位，建议到应用商店更新「Android System WebView」。';
    }

    return { level, patches, warn, blocking: false };
  }

  /**
   * 把补丁名转成根节点上的 class 名。
   * 分开成函数是为了让 HTML/CSS 与 JS 三处的命名约定有单一来源。
   */
  function compatClassNames(patches) {
    const list = patches || [];
    return list.map((p) => 'ps-' + String(p));
  }

  /* ====================== 7.01h 检查更新 ====================== */

  /**
   * 解析版本号成可比较的数字数组。
   *
   * 支持 `v2.8.2` / `2.8.2` / `2.8` 这几种写法（tag 常带 v 前缀）。
   * 非数字后缀（如 `2.8.2-beta.1`）会被忽略 —— 本项目的版本号都是纯数字，
   * 但接口返回的 tag 可能被人为加过后缀，不能因此崩掉。
   *
   * @returns {number[]} 形如 [2,8,2]；无法解析时返回 []
   */
  function parseVersion(str) {
    const s = String(str == null ? '' : str).trim().replace(/^v/i, '');
    if (!s) return [];
    // 只取开头的数字段（遇到非数字就停）
    const m = /^(\d+(?:\.\d+)*)/.exec(s);
    if (!m) return [];
    return m[1].split('.').map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n));
  }

  /**
   * 比较两个版本号。
   * @returns {number} a > b 返回 1，a < b 返回 -1，相等返回 0
   */
  function compareVersion(a, b) {
    const pa = parseVersion(a), pb = parseVersion(b);
    // 解析失败时退化成字符串比较（至少不会误判成「有更新」）
    if (!pa.length || !pb.length) {
      const sa = String(a == null ? '' : a), sb = String(b == null ? '' : b);
      return sa === sb ? 0 : (sa > sb ? 1 : -1);
    }
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  /**
   * 从 GitHub releases 列表里挑出**真正的最新版**。
   *
   * 关键：不能用 `/releases/latest` 接口！
   *   那个接口按「创建时间」判定最新，而不是按版本号。
   *   一旦事后补发旧版本的 Release（本项目就发生过：补齐 v1.8.0~v2.2.0 时
   *   它们的时间戳变成最新），`/releases/latest` 就会返回一个旧版本，
   *   用户会被提示「更新」到一个更老的版本上。
   *
   * 所以这里自己拉列表、按版本号排序、取最高。
   * 同时排除 draft 与 prerelease。
   *
   * @param {Array} releases GitHub API 返回的 release 数组
   * @returns {object|null} 最高版本；列表为空或都不可用时返回 null
   */
  function pickLatestRelease(releases) {
    const list = (releases || []).filter((r) =>
      r && !r.draft && !r.prerelease && parseVersion(r.tag_name).length);
    if (!list.length) return null;
    let best = null;
    for (const r of list) {
      if (!best || compareVersion(r.tag_name, best.tag_name) > 0) best = r;
    }
    return best;
  }

  /**
   * 判断是否需要提示更新。
   *
   * 只做「有新版本」的判断，不做自动下载 —— 装不装由用户决定。
   *
   * @param {object} o { current, latest, skipped, dismissed }
   *        current   当前版本（如 '2.8.2'）
   *        latest    远程最新版本（如 'v2.9.0'）
   *        skipped   用户点过「忽略此版本」的版本号
   * @returns {{hasUpdate:boolean, latest:string, reason:string}}
   */
  function planUpdate(o) {
    const opt = o || {};
    const cur = String(opt.current || '');
    const lat = String(opt.latest || '');
    if (!lat) return { hasUpdate: false, latest: '', reason: 'no-remote' };
    if (!cur) return { hasUpdate: false, latest: lat, reason: 'no-current' };

    const cmp = compareVersion(lat, cur);
    if (cmp <= 0) return { hasUpdate: false, latest: lat, reason: 'up-to-date' };

    // 用户明确忽略过这个版本就不再打扰。
    // 注意：只忽略「那一个版本」，出了更新的版本还要提示 ——
    // 否则用户忽略一次就永远收不到更新了。
    if (opt.skipped && compareVersion(opt.skipped, lat) === 0) {
      return { hasUpdate: false, latest: lat, reason: 'skipped' };
    }
    return { hasUpdate: true, latest: lat, reason: 'newer' };
  }

  /**
   * 从 release 的附件里挑出 APK 下载地址。
   *
   * 优先选名字里带版本号的（本项目发布时用的 `photo-studio-vX.Y.Z.apk`），
   * 其次任意 .apk。找不到返回空串 —— 调用方据此提示「请到网页下载」。
   */
  function pickApkAsset(release) {
    const assets = (release && release.assets) || [];
    const apks = assets.filter((a) => a && typeof a.name === 'string' &&
      /\.apk$/i.test(a.name) && a.browser_download_url);
    if (!apks.length) return null;
    const ver = release && release.tag_name ? String(release.tag_name).replace(/^v/i, '') : '';
    const exact = apks.find((a) => ver && a.name.indexOf(ver) >= 0);
    return exact || apks[0];
  }

  /**
   * 检查更新的触发时机规划。
   *
   * 不该每次启动都请求 GitHub（浪费流量、也可能被限流）。
   * 策略：
   *   - 距离上次检查不足 `intervalMs` 且用户没手动点 → 跳过
   *   - 用户手动点「检查更新」→ 总是请求
   *   - 失败后要退避（避免网络不通时反复重试）
   *
   * @param {object} o { now, lastCheck, force, failCount, intervalMs }
   * @returns {{should:boolean, reason:string, waitMs:number}}
   */
  function planUpdateCheck(o) {
    const opt = o || {};
    const now = num(opt.now, Date.now());
    const last = num(opt.lastCheck, 0);
    const interval = Math.max(60000, num(opt.intervalMs, 12 * 60 * 60 * 1000));  // 默认 12 小时
    if (opt.force) return { should: true, reason: 'manual', waitMs: 0 };
    if (!last) return { should: true, reason: 'first', waitMs: 0 };

    // 连续失败时指数退避，避免网络不通还反复打扰。
    // 封顶在 **4 倍间隔**（48 小时）—— 注意 fails 封顶是 2 而不是 4：
    // eff = interval * 2^fails，fails=4 会变成 16 倍（8 天），
    // 网络只是短暂故障的用户要等 8 天才重新检查更新，明显太久。
    const fails = Math.max(0, Math.min(2, Math.round(num(opt.failCount, 0))));
    const eff = interval * Math.pow(2, fails);
    const elapsed = now - last;
    if (elapsed >= eff) return { should: true, reason: 'due', waitMs: 0 };
    return { should: false, reason: 'too-soon', waitMs: eff - elapsed };
  }

  /* ====================== 7.01g 对比视图手势 ====================== */

  /**
   * 对比视图的缩放规划。
   *
   * 背景：对比视图里「拖分割线」和「双击放大」都用单指，必须区分开，
   * 否则双击会被当成两次拖动分割线（这正是之前的 bug —— 提示条写着
   * 「双击画面放大查看」，但双击永远不生效）。
   *
   * 区分策略（按优先级）：
   *   1. **靠近分割线**（水平 ±hitPx 内）→ 拖分割线（用户意图明确）
   *   2. 已放大（scale > fitScale）→ 单指拖动平移（此时更需要移动画面）
   *   3. 其它 → 交给双击判定
   *
   * 这样「放大后想拖分割线」也仍然可用：只要按在竖线附近即可。
   *
   * @param {object} o { x, splitX, hitPx, scale, fitScale, canPan }
   * @returns {'split'|'pan'|'tap'}
   */
  function planCompareDrag(o) {
    const opt = o || {};
    const x = num(opt.x, 0);
    const splitX = num(opt.splitX, 0);
    const hitPx = Math.max(8, num(opt.hitPx, 22));
    const scale = num(opt.scale, 1);
    const fitScale = num(opt.fitScale, scale);
    const canPan = opt.canPan !== false;

    if (Math.abs(x - splitX) <= hitPx) return 'split';
    if (canPan && scale > fitScale * 1.001) return 'pan';
    return 'tap';
  }

  /**
   * 双击缩放：在「适应窗口」和「放大」之间切换。
   *
   * 以双击点为中心放大（而不是画面中心）—— 用户点哪里就是想看清哪里。
   * 再次双击回到适应窗口，并把画面居中，避免用户「放大后找不到路回去」。
   *
   * 放大倍数取 max(基准×倍数, 填满视口所需比例)：
   * 只按倍数放大时，小图可能放大后**仍然小于视口**，画面四周还是空白 ——
   * 那不叫放大，用户看不出区别。所以至少放大到铺满视口。
   *
   * @param {object} o { view, fitView, px, py, zoom, imgW, imgH, viewW, viewH, maxScale }
   * @returns {{view:object, zoomed:boolean}}
   */
  function planCompareDoubleTap(o) {
    const opt = o || {};
    const fit = opt.fitView || makeView(1, 0, 0);
    const cur = opt.view || fit;
    const target = num(opt.zoom, 3);
    const fitScale = safeScale(fit);
    const isZoomed = safeScale(cur) > fitScale * 1.001;

    if (isZoomed) {
      // 已经是放大态 → 回到适应窗口（并居中）
      return { view: makeView(fit.scale, fit.tx, fit.ty), zoomed: false };
    }
    const maxS = num(opt.maxScale, 12);
    const imgW = Math.max(1, num(opt.imgW, 1)), imgH = Math.max(1, num(opt.imgH, 1));
    const vw = Math.max(1, num(opt.viewW, 1)), vh = Math.max(1, num(opt.viewH, 1));
    // 铺满视口所需比例：低于它放大后画面周围仍是空白
    const cover = Math.max(vw / imgW, vh / imgH);
    const want = Math.min(maxS, Math.max(fitScale * Math.max(1.2, target), cover));
    const z = zoomAt(cur, num(opt.px, 0), num(opt.py, 0), want / safeScale(cur),
      Math.max(0.02, fitScale * 0.4), maxS);
    const clamped = clampView(z, imgW, imgH, vw, vh);
    return { view: clamped, zoomed: true };
  }

  /**
   * 对比视图的显示信息（缩放倍数、是否可复位）。
   *
   * 放大后必须让用户看到「现在是几倍」和「怎么回去」，
   * 否则容易以为界面坏了。
   */
  function describeCompareZoom(view, fitView, o) {
    const opt = o || {};
    const s = safeScale(view);
    const f = safeScale(fitView);
    const ratio = f > 0 ? s / f : 1;
    const zoomed = ratio > 1.001;
    const rounded = ratio >= 10 ? Math.round(ratio) : Math.round(ratio * 10) / 10;
    return {
      zoomed,
      ratio,
      text: zoomed ? rounded + '×' : '',
      // 放大后提示怎么操作：拖动平移、双击还原
      hint: zoomed
        ? '拖动画面平移 · 按在竖线附近可拖动对比 · 双击还原'
        : (opt.baseHint || '拖动中间竖线对比 · 双击画面放大查看'),
      // 放大时给一个显式的复位按钮，不依赖用户记住手势
      canReset: zoomed
    };
  }

  /**
   * 把分割线的「图内比例」换算成屏幕位置，并在放大后夹到可触及范围内。
   *
   * 为什么需要夹取：
   *   分割线原本按「图内比例」定位。放大后画面远大于视口，
   *   比例 0.5 的分割线可能落到视口外（比如正好在右边缘之外）——
   *   这时用户只看得到「修改前」或只看得到「修改后」，
   *   对比功能等于废了。所以放大态下把线夹在视口内，保证随时能拖。
   *
   * @param {object} o { view, imgW, imgH, split, viewW, inset }
   * @returns {{screenX:number, split:number, clamped:boolean}}
   */
  function placeCompareSplit(o) {
    const opt = o || {};
    const view = opt.view || makeView(1, 0, 0);
    const W = Math.max(1, num(opt.viewW, 1));
    const inset = Math.max(0, num(opt.inset, 14));
    const dr = imageRectToScreen(
      { x: 0, y: 0, w: num(opt.imgW, 1), h: num(opt.imgH, 1) }, view);
    let split = clamp01(num(opt.split, 0.5));
    let sx = dr.x + dr.w * split;
    let clamped = false;

    // 只在画面宽于视口时才需要夹（否则整图可见，线不会跑出去）
    if (dr.w > W) {
      const lo = inset, hi = W - inset;
      if (sx < lo || sx > hi) {
        clamped = true;
        sx = clamp(sx, lo, hi);
        split = dr.w > 0 ? clamp01((sx - dr.x) / dr.w) : split;
      }
    }
    return { screenX: sx, split, clamped };
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
      // 无缝融合强度：null 表示「跟随全局设置」，数字表示该图层单独指定
      fusion: L.fusion == null ? null : clamp01(num(L.fusion, 0.7)),
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

  /* ====================== 7.03b 引导线（让模型按你的意图构图） ====================== */

  /**
   * 引导线的类型。
   *
   * 为什么需要这个功能：
   *   文字描述构图很吃力 —— 「把地平线放在画面下方三分之一处」这种要求，
   *   模型只能猜。而画一条线直接告诉它「地平线在这里」，准确率高得多。
   *   这是把「构图意图」从模糊的文字变成精确的几何约束。
   */
  const GUIDE_KINDS = [
    { id: 'horizon', zh: '地平线', en: 'horizon line', desc: '水平参考：地平线 / 水平面（只写进提示词）' },
    { id: 'vertical', zh: '垂直线', en: 'vertical line', desc: '垂直参考：墙角 / 立柱 / 树干（只写进提示词）' },
    { id: 'diagonal', zh: '对角线', en: 'diagonal line', desc: '视线引导：道路 / 河流 / 栏杆（只写进提示词）' },
    { id: 'subject', zh: '主体位置', en: 'subject placement', desc: '标出主体应出现的位置（只写进提示词）' },
    {
      id: 'freehand', zh: '自由绘制', en: 'freehand stroke', freehand: true,
      desc: '手画走向：发丝 / 水流 / 衣褶 —— 笔迹会画进发给模型的图片'
    }
  ];

  /**
   * 笔迹颜色。
   *
   * 为什么要可切换：不同底色上对比度差别很大（红发上画红线等于没画），
   * 而且各家模型对「什么颜色代表标注」的理解并不一致。
   * 颜色名必须和提示词里的说法严格对应 —— 画品红却说「红色线条」，模型会去找一条不存在的线。
   */
  const GUIDE_STROKE_COLORS = [
    { id: 'red', zh: '红色', en: 'red', hex: '#ff2d2d' },
    { id: 'magenta', zh: '品红色', en: 'magenta', hex: '#ff2df0' },
    { id: 'cyan', zh: '青色', en: 'cyan', hex: '#00e5ff' }
  ];

  /** 取笔迹颜色定义（未知退化为第一个） */
  function getStrokeColor(id) {
    return GUIDE_STROKE_COLORS.find((c) => c.id === id) || GUIDE_STROKE_COLORS[0];
  }

  /** 取引导线类型定义（未知类型退化为第一条） */
  function getGuideKind(id) {
    return GUIDE_KINDS.find((k) => k.id === id) || GUIDE_KINDS[0];
  }

  /** 是否自由笔迹（构图线只进提示词，笔迹还要画进请求图） */
  function isFreehandGuide(g) {
    return getGuideKind((g || {}).kind).freehand === true;
  }

  /**
   * 归一化一条引导线：夹取坐标、补齐字段。
   *
   * 两种形态：
   *   构图线（horizon/vertical/diagonal/subject）—— 两个端点，只翻译成文字；
   *   自由笔迹（freehand）—— 一整条折线，既要文字说明，还要画进请求图。
   */
  function normalizeGuide(g) {
    const G = g || {};
    const kind = getGuideKind(G.kind);
    const out = {
      kind: kind.id,
      x1: clamp01(num(G.x1, 0)),
      y1: clamp01(num(G.y1, 0)),
      x2: clamp01(num(G.x2, 0)),
      y2: clamp01(num(G.y2, 0))
    };
    if (kind.freehand) {
      const pts = Array.isArray(G.points) ? G.points : [];
      const clean = [];
      for (const p of pts) {
        if (!p) continue;
        const x = num(p.x, NaN), y = num(p.y, NaN);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        // **刻意不夹取到 0~1**：手指拖到选区外是常态，夹取会把越界部分压到边界上，
        // 让笔迹贴着选区边缘拉出一道假直线（模型会把它当成画面内容）。
        // 越界部分交给 clipPolyline 在画进请求图时真正裁掉。
        clean.push({ x, y });
      }
      out.points = clean;
      // 端点跟着折线走：否则会出现「points 有几十个点、x1..y2 却还是 0」的脏数据，
      // 让后续按端点算的中点/方向全部落在左上角
      if (clean.length) {
        out.x1 = clean[0].x; out.y1 = clean[0].y;
        out.x2 = clean[clean.length - 1].x; out.y2 = clean[clean.length - 1].y;
      }
    }
    return out;
  }

  /**
   * 把手画的线吸附到常见方向。
   *
   * 为什么需要：手指拖出来的线必然带抖动 —— 想画地平线却拖出 3~8 度的斜角。
   * 直接把这个斜角写进提示词，模型会以为「地平线是斜的」，比不画还糟。
   * 所以与水平/垂直偏差在 12 度以内时拉直，超出则保留原角度
   * （透视下的地平线确实可能倾斜，不能强行掰直）。
   *
   * 吸附后同步更新 kind：用户选的是「地平线」，但画出来明显是竖线时，
   * 以实际画的为准 —— 手上的动作比选中的按钮更可信。
   *
   * @param {object} g 引导线
   * @returns {object} 吸附后的引导线
   */
  const GUIDE_SNAP_DEG = 12;

  function snapGuide(g) {
    const G = normalizeGuide(g);
    // 自由笔迹是手画的形状本身，拉直等于毁掉它（头发弧度会被掰成直线）
    if (isFreehandGuide(G)) return G;
    const dx = G.x2 - G.x1, dy = G.y2 - G.y1;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return G;
    // 用屏幕上的角度判断（选区可能不是正方形，不能只看归一化坐标）
    const ang = Math.atan2(dy, dx) * 180 / Math.PI;
    const near = (target) => Math.abs(((ang - target + 540) % 180) - 90) > 90 - GUIDE_SNAP_DEG;
    const out = { kind: G.kind, x1: G.x1, y1: G.y1, x2: G.x2, y2: G.y2 };

    if (Math.abs(dy) < 1e-6 || near(0)) {
      // 拉平到两端点平均高度
      const y = (G.y1 + G.y2) / 2;
      out.y1 = y; out.y2 = y;
      // 竖着画的「地平线」其实是垂直线，以手上的动作为准
      if (out.kind === 'horizon' || out.kind === 'vertical') out.kind = 'horizon';
    } else if (Math.abs(dx) < 1e-6 || near(90)) {
      const x = (G.x1 + G.x2) / 2;
      out.x1 = x; out.x2 = x;
      if (out.kind === 'horizon' || out.kind === 'vertical') out.kind = 'vertical';
    }
    return out;
  }

  /**
   * 判断一条线接近水平还是垂直。
   * 不是硬性限制（透视下地平线也可能倾斜），只用于给出提示。
   */
  function guideOrientation(g) {
    const G = normalizeGuide(g);
    const dx = Math.abs(G.x2 - G.x1), dy = Math.abs(G.y2 - G.y1);
    if (dx < 1e-6 && dy < 1e-6) return 'point';
    if (dy < dx * 0.25) return 'horizontal';
    if (dx < dy * 0.25) return 'vertical';
    return 'diagonal';
  }

  /**
   * 把引导线翻译成**模型能理解的构图说明**。
   *
   * 关键设计：不用像素坐标（模型看不到我们的坐标系），而是用
   * 「画面位置 + 相对比例」描述 —— 例如「地平线在画面高度 62% 处」。
   * 同时给出三分法参考（33%/66%），因为这是摄影构图的通用语言。
   *
   * @param {object} o { guides, isZh }
   * @returns {string} 可直接拼进提示词的说明
   */
  function describeGuides(o) {
    const opt = o || {};
    const isZh = opt.isZh !== false;
    const list = (opt.guides || []).map(normalizeGuide);
    if (!list.length) return '';

    /** 把 0~1 的位置说成人话：百分比 + 三分法参考 */
    const posWord = (v) => {
      const pct = Math.round(v * 100);
      let ref = '';
      // 与三分法/中心线的偏差小于阈值时就点名，帮模型对齐构图
      if (Math.abs(v - 1 / 3) < 0.06) ref = isZh ? '（约三分之一处）' : ' (about one third)';
      else if (Math.abs(v - 2 / 3) < 0.06) ref = isZh ? '（约三分之二处）' : ' (about two thirds)';
      else if (Math.abs(v - 0.5) < 0.05) ref = isZh ? '（居中）' : ' (centered)';
      return pct + '%' + ref;
    };

    /** 折线的包围盒（相对选区，0~1） */
    const bboxOf = (pts) => {
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (const p of pts) {
        if (p.x < x0) x0 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.x > x1) x1 = p.x;
        if (p.y > y1) y1 = p.y;
      }
      return { x0, y0, x1, y1 };
    };

    const lines = [];
    const strokes = [];      // 自由笔迹单独收集，措辞完全不同
    for (const g of list) {
      const mx = (g.x1 + g.x2) / 2, my = (g.y1 + g.y2) / 2;
      if (isFreehandGuide(g)) {
        const pts = g.points && g.points.length ? g.points : [{ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }];
        const bb = bboxOf(pts);
        // 用包围盒 + 走向描述，而不是把几十个点念一遍 —— 模型读不了坐标列表
        const dir = (() => {
          const dx = g.x2 - g.x1, dy = g.y2 - g.y1;
          if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) return isZh ? '集中在一处' : 'in one spot';
          if (Math.abs(dy) < Math.abs(dx) * 0.4) return isZh ? '基本横向' : 'mostly horizontal';
          if (Math.abs(dx) < Math.abs(dy) * 0.4) return isZh ? '基本纵向' : 'mostly vertical';
          return isZh ? '斜向' : 'diagonal';
        })();
        const area = isZh
          ? '横向 ' + Math.round(bb.x0 * 100) + '%~' + Math.round(bb.x1 * 100) +
            '%、纵向 ' + Math.round(bb.y0 * 100) + '%~' + Math.round(bb.y1 * 100) + '%'
          : Math.round(bb.x0 * 100) + '%–' + Math.round(bb.x1 * 100) + '% horizontally and ' +
            Math.round(bb.y0 * 100) + '%–' + Math.round(bb.y1 * 100) + '% vertically';
        strokes.push({ g, area, dir, n: pts.length });
        continue;
      }
      if (isZh) {
        if (g.kind === 'horizon') {
          lines.push('水平参考线（地平线/水平面）位于画面高度 ' + posWord(my) +
            '，左右贯穿 —— 生成画面里的地平线必须落在这条线上');
        } else if (g.kind === 'vertical') {
          lines.push('垂直参考线位于画面宽度 ' + posWord(mx) +
            '，上下贯穿 —— 竖直结构（墙面/立柱/树干）必须沿它保持竖直');
        } else if (g.kind === 'diagonal') {
          lines.push('斜向引导线从画面横向 ' + posWord(g.x1) + ' 延伸到 ' + posWord(g.x2) +
            '，纵向从 ' + posWord(g.y1) + ' 到 ' + posWord(g.y2) +
            ' —— 让道路/河流/栏杆等线性元素沿这个方向延伸，形成纵深');
        } else {
          lines.push('主体应出现在：横向 ' + posWord(mx) + '、纵向 ' + posWord(my) +
            ' —— 把这个位置留给画面主体');
        }
      } else {
        if (g.kind === 'horizon') {
          lines.push('A horizontal reference line (horizon/waterline) sits at ' + posWord(my) +
            ' of the frame height, spanning the full width — the generated horizon must land on it');
        } else if (g.kind === 'vertical') {
          lines.push('A vertical reference line sits at ' + posWord(mx) +
            ' of the frame width, spanning top to bottom — vertical structures must stay vertical along it');
        } else if (g.kind === 'diagonal') {
          lines.push('A diagonal leading line runs from ' + posWord(g.x1) + ' to ' + posWord(g.x2) +
            ' horizontally and ' + posWord(g.y1) + ' to ' + posWord(g.y2) +
            ' vertically — let linear elements follow it to create depth');
        } else {
          lines.push('The main subject should be placed at ' + posWord(mx) +
            ' horizontally and ' + posWord(my) + ' vertically');
        }
      }
    }

    if (isZh) {
      const parts = [];
      if (lines.length) {
        parts.push('【构图引导】我画了 ' + lines.length + ' 条引导线，请严格按它们构图：' +
          lines.join('；') +
          '。这些线只用于说明构图位置，不要在画面里画出任何线条、标记或辅助线。');
      }
      if (strokes.length) {
        // 自由笔迹是「画在图片上的草图」，措辞必须和构图线区分开：
        // 前者要模型「沿着它生成内容」，后者要模型「别把线画出来」。
        const sDesc = strokes.map((x, i) =>
          '第 ' + (i + 1) + ' 笔（' + x.dir + '，位于' + x.area + '）').join('；');
        parts.push('【手绘草图】我在图片上用' + (opt.strokeColorZh || '红色') +
          '画了 ' + strokes.length + ' 笔走向草图：' + sDesc +
          '。这些笔迹表示我希望生成内容的**位置、走向和范围** —— ' +
          '请沿着笔迹生成相应的内容（例如头发、水流、衣褶、烟雾等线性或成束的形态），' +
          '让生成结果贴合笔迹的走向与范围。' +
          '笔迹只是我的示意，**绝对不要把' + (opt.strokeColorZh || '红色') +
          '线条本身画进画面**，最终画面里不能出现任何线条、涂鸦或标记。');
      }
      return parts.join('');
    }
    const enParts = [];
    if (lines.length) {
      enParts.push('[Composition guides] I drew ' + lines.length +
        ' guide line(s); compose strictly according to them: ' + lines.join('; ') +
        '. These lines only indicate composition — do not draw any lines, marks or overlays.');
    }
    if (strokes.length) {
      const sDesc = strokes.map((x, i) =>
        'stroke ' + (i + 1) + ' (' + x.dir + ', at ' + x.area + ')').join('; ');
      enParts.push('[Hand-drawn sketch] I drew ' + strokes.length + ' ' +
        (opt.strokeColorEn || 'red') + ' stroke(s) on the image showing the intended flow: ' + sDesc +
        '. These strokes indicate the position, direction and extent of the content I want — ' +
        'generate the corresponding content (hair strands, water flow, fabric folds, smoke, etc.) ' +
        'following the strokes. The strokes are only my indication: ' +
        '**never draw the ' + (opt.strokeColorEn || 'red') +
        ' lines themselves into the image**; the final image must contain no lines, scribbles or marks.');
    }
    return enParts.join(' ');
  }

  /**
   * 把引导线从「相对选区的归一化坐标」换算到「请求图坐标」。
   *
   * 请求图带上下文外扩（contextPct），所以必须换算，
   * 否则引导线位置会偏移，模型会按错误位置构图。
   *
   * @param {object} o { guides, rect, ctxRect }
   */
  function mapGuidesToRequest(o) {
    const opt = o || {};
    const rect = opt.rect || { x: 0, y: 0, w: 1, h: 1 };
    const ctx = opt.ctxRect || rect;
    const w = Math.max(1, num(ctx.w, 1)), h = Math.max(1, num(ctx.h, 1));
    // clip=true：分块生成时，落在本块之外的引导线直接丢掉。
    // 若不丢，clamp01 会把它压到边缘，模型会以为「地平线就在图片最上边」。
    if (opt.clip) {
      const mid = (g) => ({
        x: rect.x + ((g.x1 + g.x2) / 2) * rect.w,
        y: rect.y + ((g.y1 + g.y2) / 2) * rect.h
      });
      const pad = 0.02;
      return (opt.guides || [])
        .map(normalizeGuide)
        .filter((g) => {
          const m = mid(g);
          return m.x >= ctx.x - ctx.w * pad && m.x <= ctx.x + ctx.w * (1 + pad) &&
            m.y >= ctx.y - ctx.h * pad && m.y <= ctx.y + ctx.h * (1 + pad);
        })
        .map((g) => ({
          kind: g.kind,
          x1: clamp01((rect.x + g.x1 * rect.w - ctx.x) / w),
          y1: clamp01((rect.y + g.y1 * rect.h - ctx.y) / h),
          x2: clamp01((rect.x + g.x2 * rect.w - ctx.x) / w),
          y2: clamp01((rect.y + g.y2 * rect.h - ctx.y) / h)
        }));
    }
    const conv = (g) => {
      // 引导线存的是「相对选区」的归一化坐标：先还原成文档坐标，再换算到请求图
      const out = {
        kind: g.kind,
        x1: clamp01((rect.x + g.x1 * rect.w - ctx.x) / w),
        y1: clamp01((rect.y + g.y1 * rect.h - ctx.y) / h),
        x2: clamp01((rect.x + g.x2 * rect.w - ctx.x) / w),
        y2: clamp01((rect.y + g.y2 * rect.h - ctx.y) / h)
      };
      if (g.points && g.points.length) {
        out.points = g.points.map((pt) => ({
          x: clamp01((rect.x + pt.x * rect.w - ctx.x) / w),
          y: clamp01((rect.y + pt.y * rect.h - ctx.y) / h)
        }));
      }
      return out;
    };
    return (opt.guides || []).map((raw) => conv(normalizeGuide(raw)));
  }

  /* ====================== 7.03c 笔迹进图（让模型「看见」你画的走向） ====================== */

  /**
   * 为什么需要把笔迹画进图片：
   *
   * 构图线可以用文字说清楚（「地平线在 62% 处」），但「头发要往这个方向飘」
   * 用文字几乎说不明白 —— 模型看不到你的坐标系，也读不了几十个点。
   * 唯一可行的办法是把笔迹直接画在发给它的图片上：模型看图就懂。
   *
   * 为什么默认可以关掉：
   *   早期版本把选区涂成半透明蓝色当标记，模型把蓝色当成了画面内容，
   *   生成结果整体偏蓝。教训是「标记有可能被当成画面内容」。
   *   对认识标注的模型（Qwen-Image-Edit / Nano Banana 等）笔迹很有效，
   *   但某些模型或中转仍可能把线画进结果 —— 所以必须能一键关掉。
   *
   * 颜色可切换的原因：红发上画红线等于没画；不同模型对「什么颜色代表标注」
   * 理解也不同。颜色名必须和提示词里的说法严格一致。
   *
   * @param {object} o { guides, rect, ctxRect, enabled, colorId, width }
   * @returns {{draw:Array, note:string, count:number}}
   */
  /**
   * 把一条折线裁剪到 [0,w]×[0,h] 矩形内（逐段用 Liang-Barsky）。
   *
   * 为什么不能简单地把越界点 clamp 到边界：分块生成时笔迹常常跨出当前瓦片，
   * clamp 会让整条线**贴着瓦片边缘**拉出一道直线 —— 模型看到的就是一条沿边缘的
   * 假线，生成结果会莫名其妙多出一道光或一道痕。正确做法是真正裁掉框外的部分。
   *
   * @returns {Array<Array<{x:number,y:number}>>} 裁剪后的若干段折线（可能为空）
   */
  function clipPolyline(pts, w, h) {
    /** 裁剪单条线段；完全在框外返回 null */
    const clipSeg = (a, b) => {
      let t0 = 0, t1 = 1;
      const dx = b.x - a.x, dy = b.y - a.y;
      const tests = [[-dx, a.x], [dx, w - a.x], [-dy, a.y], [dy, h - a.y]];
      for (const [p, q] of tests) {
        if (p === 0) { if (q < 0) return null; continue; }
        const r = q / p;
        if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
        else { if (r < t0) return null; if (r < t1) t1 = r; }
      }
      return [
        { x: a.x + t0 * dx, y: a.y + t0 * dy },
        { x: a.x + t1 * dx, y: a.y + t1 * dy }
      ];
    };

    const out = [];
    let run = [];      // 当前正在累积的连续段
    for (let i = 1; i < pts.length; i++) {
      const seg = clipSeg(pts[i - 1], pts[i]);
      if (!seg) {                       // 这一段整个在框外 → 断开
        if (run.length > 1) out.push(run);
        run = [];
        continue;
      }
      const last = run[run.length - 1];
      // 上一段的终点与这一段的起点不重合 → 中间有内容被裁掉，另起一段
      if (last && Math.hypot(last.x - seg[0].x, last.y - seg[0].y) > 1e-6) {
        if (run.length > 1) out.push(run);
        run = [];
      }
      if (!run.length) run.push(seg[0]);
      run.push(seg[1]);
    }
    if (run.length > 1) out.push(run);
    return out;
  }

  function planStrokeOverlay(o) {
    const opt = o || {};
    const color = getStrokeColor(opt.colorId);
    const rect = opt.rect || { x: 0, y: 0, w: 1, h: 1 };
    const ctx = opt.ctxRect || rect;
    if (opt.enabled === false) {
      return { draw: [], note: '笔迹未画进图片（已关闭）', count: 0, color };
    }
    const rw = Math.max(1, num(rect.w, 1)), rh = Math.max(1, num(rect.h, 1));
    const w = Math.max(1, num(ctx.w, 1)), h = Math.max(1, num(ctx.h, 1));
    // 线宽跟着请求图大小走：小图用细线、大图用粗线，视觉粗细才一致。
    // 下限给到 4px 是实测出来的：2px 的细线在 JPEG 编码后会被压得几乎看不见
    // （600px 图上从 698 个像素掉到 42 个，位置也糊掉了），
    // 模型看不到笔迹，这个功能就等于没做。
    const width = Math.max(4, Math.round(num(opt.width, Math.min(w, h) * 0.012)));
    const draw = [];
    for (const raw of (opt.guides || [])) {
      const g = normalizeGuide(raw);
      if (!isFreehandGuide(g)) continue;
      const pts = (g.points && g.points.length >= 2)
        ? g.points
        : [{ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }];
      if (pts.length < 2) continue;
      // 选区归一化坐标 → 请求图像素坐标（**不夹取**：越界信息要留给裁剪用）
      const px = pts.map((pt) => ({
        x: (rect.x + pt.x * rw - ctx.x) / w * w,
        y: (rect.y + pt.y * rh - ctx.y) / h * h
      }));
      // 整笔都在框外的直接跳过，不浪费绘制。
      // 注意必须按**包围盒**判断，不能按「有没有点在框内」：
      // 一条从框上方穿到框下方的竖线，两个端点都在框外，但它明明穿过整个画面 ——
      // 按点判断会把它整条丢掉（这个坑真实踩过）。
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const q of px) {
        if (q.x < bx0) bx0 = q.x;
        if (q.y < by0) by0 = q.y;
        if (q.x > bx1) bx1 = q.x;
        if (q.y > by1) by1 = q.y;
      }
      const near = bx1 >= -width && bx0 <= w + width && by1 >= -width && by0 <= h + width;
      if (!near) continue;
      for (const seg of clipPolyline(px, w, h)) {
        if (seg.length < 2) continue;
        draw.push({ color: color.hex, width, points: seg });
      }
    }
    return {
      draw,
      color,
      count: draw.length,
      note: draw.length ? '已把 ' + draw.length + ' 笔草图用' + color.zh + '画进请求图' : ''
    };
  }

  /**
   * 在 canvas 上画笔迹。
   *
   * 只画线，不加箭头/圆点等任何装饰 —— 模型可能把装饰也当成画面内容。
   * 画两遍（先深色描边再本色）是为了在任何底色上都看得清：
   * 纯红笔在红色区域上等于没画，深色描边能保证轮廓可见。
   */
  function drawStrokeOverlay(c2d, plan) {
    if (!c2d || !plan || !plan.draw || !plan.draw.length) return 0;
    c2d.save();
    c2d.lineCap = 'round';
    c2d.lineJoin = 'round';
    let n = 0;
    for (const st of plan.draw) {
      if (st.points.length < 2) continue;
      const path = () => {
        c2d.beginPath();
        c2d.moveTo(st.points[0].x, st.points[0].y);
        for (let i = 1; i < st.points.length; i++) c2d.lineTo(st.points[i].x, st.points[i].y);
      };
      // 外描边：深色，保证在任何底色上都分得清
      c2d.strokeStyle = 'rgba(0,0,0,.55)';
      c2d.lineWidth = st.width + 2;
      path(); c2d.stroke();
      // 本色
      c2d.strokeStyle = st.color;
      c2d.lineWidth = st.width;
      path(); c2d.stroke();
      n++;
    }
    c2d.restore();
    return n;
  }

  /* ====================== 7.04 无缝融合（模型输出对齐原图） ====================== */

  /**
   * 为什么需要这一层：
   *
   * 提示词只能**请求**模型「保持光线、色彩、质感一致」，但模型看不到你照片的
   * 像素统计 —— 它只能猜。所以生成结果和周围环境总是差一点，表现为：
   *   - 色调能对上，但**明暗梯度**对不上（原图越往右越暗，生成块却是平的）
   *   - **对比度**对不上（模型出图常偏灰，或反而过艳）
   *   - **纹理**对不上（模型输出更平滑，接缝处一眼看出「那块是贴的」）
   *
   * 这些都无法靠提示词解决，但可以在**合成阶段强制对齐** ——
   * 而且这一步是免费的：不重新调用模型，只做像素运算。
   *
   * 下面几个函数各管一个层面，全部是纯函数，便于单测。
   */

  /**
   * 在环带上采样，返回 RGB 均值与**标准差**。
   *
   * 相比只取均值，多出来的标准差是关键：
   *   标准差 = 这一带的「明暗起伏程度」，也就是对比度。
   *   均值相同但标准差不同 → 一个平、一个艳，看着就是不契合。
   *
   * @param {object} o { pixels, rect, ring, full, offset }
   * @returns {{mean:number[], std:number[], n:number}}
   */
  function ringMoments(o) {
    const opt = o || {};
    const pix = opt.pixels;
    const rect = opt.rect || { x: 0, y: 0, w: 0, h: 0 };
    const ring = Math.max(1, round(num(opt.ring, 6)));
    const full = opt.full || null;
    const fox = full && full.offset ? num(full.offset.x, 0) : 0;
    const foy = full && full.offset ? num(full.offset.y, 0) : 0;

    const acc = { r: 0, g: 0, b: 0, count: 0 };
    const acc2 = { r: 0, g: 0, b: 0 };
    if (!pix || !pix.data) return { mean: [0, 0, 0], std: [0, 0, 0], n: 0 };

    const x0 = rect.x - ring, y0 = rect.y - ring;
    const x1 = rect.x + rect.w + ring, y1 = rect.y + rect.h + ring;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
        if (inside) continue;                      // 只要环带
        let R, G, B;
        if (full) {
          const gx = x + fox, gy = y + foy;
          if (gx < 0 || gy < 0 || gx >= full.width || gy >= full.height) continue;
          const i = (gy * full.width + gx) * 4;
          R = full.data[i]; G = full.data[i + 1]; B = full.data[i + 2];
        } else {
          if (x < 0 || y < 0 || x >= pix.width || y >= pix.height) continue;
          const i = (y * pix.width + x) * 4;
          R = pix.data[i]; G = pix.data[i + 1]; B = pix.data[i + 2];
        }
        acc.r += R; acc.g += G; acc.b += B; acc.count++;
        acc2.r += R * R; acc2.g += G * G; acc2.b += B * B;
      }
    }
    const c = Math.max(1, acc.count);
    const mean = [acc.r / c, acc.g / c, acc.b / c];
    const std = [
      Math.sqrt(Math.max(0, acc2.r / c - mean[0] * mean[0])),
      Math.sqrt(Math.max(0, acc2.g / c - mean[1] * mean[1])),
      Math.sqrt(Math.max(0, acc2.b / c - mean[2] * mean[2]))
    ];
    return { mean, std, n: acc.count };
  }

  /**
   * 整块统计（不取环带）—— 用于生成块自身。
   *
   * 生成块只有 rect 那么大，没有「外围环带」，所以不能套用 ringMoments。
   */
  function rectMoments(pixels) {
    if (!pixels || !pixels.data) return { mean: [0, 0, 0], std: [0, 0, 0], n: 0 };
    const w = pixels.width, h = pixels.height;
    let r = 0, g = 0, b = 0, r2 = 0, g2 = 0, b2 = 0;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const R = pixels.data[o], G = pixels.data[o + 1], B = pixels.data[o + 2];
      r += R; g += G; b += B;
      r2 += R * R; g2 += G * G; b2 += B * B;
    }
    const c = Math.max(1, n);
    const mean = [r / c, g / c, b / c];
    return {
      mean,
      std: [
        Math.sqrt(Math.max(0, r2 / c - mean[0] * mean[0])),
        Math.sqrt(Math.max(0, g2 / c - mean[1] * mean[1])),
        Math.sqrt(Math.max(0, b2 / c - mean[2] * mean[2]))
      ],
      n
    };
  }

  /**
   * 光照梯度拟合：用最小二乘拟合一个平面 `v ≈ a·u + b·v + c`。
   *
   * 解决什么：均值匹配是**常数偏移**，只能整体调亮调暗。
   * 但真实照片的光照是**渐变**的 —— 比如侧光下左边亮右边暗。
   * 如果原图有渐变、生成块是平的，接缝处就会出现一道「亮度台阶」，
   * 这是「一眼看出贴过」最常见的原因。
   *
   * @returns {{a:number[], b:number[], c:number[], ok:boolean}}
   */
  function fitLightPlane(o) {
    const opt = o || {};
    const pix = opt.pixels;
    const rect = opt.rect || { x: 0, y: 0, w: 0, h: 0 };
    const ring = Math.max(1, round(num(opt.ring, 8)));
    const full = opt.full || null;
    const fox = full && full.offset ? num(full.offset.x, 0) : 0;
    const foy = full && full.offset ? num(full.offset.y, 0) : 0;
    const none = { a: [0, 0, 0], b: [0, 0, 0], c: [0, 0, 0], ok: false };
    if (!pix || !pix.data) return none;

    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    const sv = [0, 0, 0], svx = [0, 0, 0], svy = [0, 0, 0];
    const x0 = rect.x - ring, y0 = rect.y - ring;
    const x1 = rect.x + rect.w + ring, y1 = rect.y + rect.h + ring;
    const W = Math.max(1, rect.w), H = Math.max(1, rect.h);

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
        if (inside) continue;
        let R, G, B;
        if (full) {
          const gx = x + fox, gy = y + foy;
          if (gx < 0 || gy < 0 || gx >= full.width || gy >= full.height) continue;
          const i = (gy * full.width + gx) * 4;
          R = full.data[i]; G = full.data[i + 1]; B = full.data[i + 2];
        } else {
          if (x < 0 || y < 0 || x >= pix.width || y >= pix.height) continue;
          const i = (y * pix.width + x) * 4;
          R = pix.data[i]; G = pix.data[i + 1]; B = pix.data[i + 2];
        }
        // 相对选区的归一化坐标
        const u = (x - rect.x) / W, v = (y - rect.y) / H;
        n++; sx += u; sy += v; sxx += u * u; sxy += u * v; syy += v * v;
        sv[0] += R; sv[1] += G; sv[2] += B;
        svx[0] += R * u; svx[1] += G * u; svx[2] += B * u;
        svy[0] += R * v; svy[1] += G * v; svy[2] += B * v;
      }
    }
    if (n < 12) return none;

    // 解 3×3 正规方程（三个通道共用系数矩阵）
    const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
    const det3 = (m) =>
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det3(M);
    // 退化（环带太窄、或全在一行/一列）时放弃梯度，退回均值匹配
    if (!Number.isFinite(D) || Math.abs(D) < 1e-9) return none;

    const solve = (rhs) => {
      const sub = (col) => M.map((row, i) => row.map((val, j) => (j === col ? rhs[i] : val)));
      return [det3(sub(0)) / D, det3(sub(1)) / D, det3(sub(2)) / D];
    };
    const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      const sol = solve([svx[ch], svy[ch], sv[ch]]);
      a[ch] = sol[0]; b[ch] = sol[1]; c[ch] = sol[2];
    }
    return { a, b, c, ok: true };
  }

  /**
   * 规划一次「无缝融合」所需的全部校正参数。
   *
   * 综合三件事，全部由环带统计推出：
   *   1. 均值差（delta）—— 整体色偏
   *   2. 梯度平面（plane）—— 光照方向/渐变
   *   3. 对比度比（gain）—— 模型出图偏灰或过艳
   *
   * @param {object} o { src, rect, dst, dstFull, dstOffset, ring }
   */
  function planFusion(o) {
    const opt = o || {};
    const rect = opt.rect || { x: 0, y: 0, w: 0, h: 0 };
    const ring = Math.max(2, round(num(opt.ring, 10)));
    const full = opt.dstFull
      ? { pixels: opt.dstFull, offset: opt.dstOffset || { x: 0, y: 0 } }
      : null;

    // 关键：src（生成块）只有 rect.w × rect.h 这么大，**没有环带**。
    // 所以不能在它身上采环带 —— 那样必然全越界，均值变成 0，
    // 校正量会等于「目标均值 - 0」，直接把画面推爆（这是实现中踩到的坑）。
    // 正确做法：整块取均值（srcRect 用 patch 自身尺寸）。
    const srcMom = rectMoments(opt.src);

    // dst（原图）才有环带可采
    const dstMom = ringMoments({
      pixels: opt.dst, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      ring, full: full ? full.pixels : null, offset: full ? full.offset : null
    });

    const delta = [
      dstMom.mean[0] - srcMom.mean[0],
      dstMom.mean[1] - srcMom.mean[1],
      dstMom.mean[2] - srcMom.mean[2]
    ];
    // 对比度增益：目标标准差 / 当前标准差。夹在合理范围，避免噪声被放大
    const gain = [1, 1, 1];
    for (let i = 0; i < 3; i++) {
      const s = srcMom.std[i], d = dstMom.std[i];
      if (s > 2 && d > 0.5) gain[i] = clamp(d / s, 0.75, 1.35);
    }
    const plane = fitLightPlane({
      pixels: opt.dst, rect, ring: ring + 6,
      full: full ? full.pixels : null, offset: full ? full.offset : null
    });

    return {
      rect, ring, delta, gain, plane,
      srcMean: srcMom.mean, srcStd: srcMom.std,
      dstMean: dstMom.mean, dstStd: dstMom.std,
      samples: { src: srcMom.n, dst: dstMom.n }
    };
  }

  /**
   * 按融合计划校正一个像素的颜色。
   *
   * 顺序很重要：
   *   ① 对比度：围绕**生成块自身均值**缩放（相对量，必须先做）
   *   ② 均值偏移：整体平移到目标色调
   *   ③ 光照梯度：叠加平面，修正明暗走向
   *
   * 最后按 `k` 衰减：k=1 完全校正（贴边处），k=0 不校正（中心处）。
   *
   * @param {number} r,g,b 生成块原始颜色
   * @param {number} u,v   相对选区的归一化坐标（0 左/上 → 1 右/下）
   * @param {number} k     校正强度 0~1
   */
  function fuseColor(r, g, b, u, v, k, plan) {
    const src = [r, g, b];
    if (!plan) return src;
    // 兼容旧签名：k 是数字时表示「均值与结构用同一强度」
    const kMean = typeof k === 'object' && k !== null ? clamp01(k.mean) : clamp01(k);
    const kStruct = typeof k === 'object' && k !== null ? clamp01(k.struct) : clamp01(k);
    if (kMean <= 0 && kStruct <= 0) return src;

    const gain = plan.gain || [1, 1, 1];
    const delta = plan.delta || [0, 0, 0];
    const plane = plan.plane || { a: [0, 0, 0], b: [0, 0, 0], ok: false };
    const srcMean = plan.srcMean || [128, 128, 128];
    const out = [0, 0, 0];

    for (let i = 0; i < 3; i++) {
      let val = src[i];
      // ① 对比度（结构性：模型系统性偏差，可以延伸到中心）
      if (kStruct > 0) {
        val = srcMean[i] + (val - srcMean[i]) * (1 + (gain[i] - 1) * kStruct);
      }
      // ② 均值偏移（内容性：用户可能就是要改色调，所以只在接缝附近施加）
      val += delta[i] * kMean;
      // ③ 光照梯度（结构性）：只取相对平面中心的偏差，避免与 ② 重复平移
      if (plane.ok && kStruct > 0) {
        const grad = plane.a[i] * (u - 0.5) + plane.b[i] * (v - 0.5);
        val += grad * kStruct;
      }
      out[i] = val;
    }
    // 按「结构性」强度在原值与校正值之间插值（均值部分已按 kMean 单独缩放）
    return [
      clamp(round(src[0] + (out[0] - src[0]) * Math.max(kStruct, kMean)), 0, 255),
      clamp(round(src[1] + (out[1] - src[1]) * Math.max(kStruct, kMean)), 0, 255),
      clamp(round(src[2] + (out[2] - src[2]) * Math.max(kStruct, kMean)), 0, 255)
    ];
  }

  /**
   * 估计「纹理强度」（高频能量），用相邻像素亮度差的平均绝对值衡量。
   *
   * 解决什么：模型输出普遍比真实照片**更平滑**（扩散模型倾向于抹掉噪点）。
   * 结果是一块干净的补丁贴在有颗粒感的照片上 —— 即使颜色完全一致，
   * 也会因为「那块太干净」而显得突兀。
   */
  function textureEnergy(pixels, rect, stride) {
    if (!pixels || !pixels.data) return 0;
    const r = rect || { x: 0, y: 0, w: pixels.width, h: pixels.height };
    const st = Math.max(1, round(num(stride, 2)));
    let sum = 0, n = 0;
    const yEnd = Math.min(r.y + r.h, pixels.height), xEnd = Math.min(r.x + r.w, pixels.width);
    for (let y = Math.max(0, r.y); y < yEnd - st; y += st) {
      for (let x = Math.max(0, r.x); x < xEnd - st; x += st) {
        const i = (y * pixels.width + x) * 4;
        const j = (y * pixels.width + x + st) * 4;
        const k = ((y + st) * pixels.width + x) * 4;
        const l1 = 0.299 * pixels.data[i] + 0.587 * pixels.data[i + 1] + 0.114 * pixels.data[i + 2];
        const l2 = 0.299 * pixels.data[j] + 0.587 * pixels.data[j + 1] + 0.114 * pixels.data[j + 2];
        const l3 = 0.299 * pixels.data[k] + 0.587 * pixels.data[k + 1] + 0.114 * pixels.data[k + 2];
        sum += Math.abs(l2 - l1) + Math.abs(l3 - l1);
        n += 2;
      }
    }
    return n ? sum / n : 0;
  }

  /**
   * 规划颗粒补偿量：生成块比周围干净多少，就补多少。
   *
   * @returns {{amount:number, seed:number, ok:boolean, srcEnergy:number, dstEnergy:number}}
   */
  function planGrain(o) {
    const opt = o || {};
    const srcE = textureEnergy(opt.src, { x: 0, y: 0, w: opt.w, h: opt.h }, opt.stride);
    const dstE = textureEnergy(opt.dst, opt.dstRect, opt.stride);
    // 周围比生成块更「有质感」时才补；反过来不补（不主动降质）
    const amount = Math.max(0, Math.min(num(opt.max, 10), (dstE - srcE) * 0.5));
    return {
      amount, seed: num(opt.seed, 1) | 0,
      ok: amount > 0.3,
      srcEnergy: Math.round(srcE * 100) / 100,
      dstEnergy: Math.round(dstE * 100) / 100
    };
  }

  /**
   * 确定性伪随机（同一 seed 每次结果一致）。
   *
   * 必须确定性：否则每次重绘（拖动滑块、撤销）颗粒位置都会变，
   * 画面会「闪烁」，用户会以为出了问题。
   */
  function grainNoise(x, y, seed) {
    let h = (x * 374761393 + y * 668265263 + (seed | 0) * 1442695041) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = Math.imul(h, 1274126177) | 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return (h / 4294967295) * 2 - 1;      // -1 ~ 1
  }

  /**
   * 评估「贴得好不好」—— 量化接缝两侧的差异，给用户一个客观分数。
   *
   * 为什么需要：用户调完羽化/匹配后，无法判断「是不是够好了」。
   * 给一个 0~100 的契合度评分 + 具体问题（色差/亮度台阶/对比度差异），
   * 用户就知道该往哪个方向调。
   */
  function assessSeam(o) {
    const opt = o || {};
    const rect = opt.rect || { x: 0, y: 0, w: 0, h: 0 };
    const ring = Math.max(2, round(num(opt.ring, 6)));
    const full = opt.dstFull
      ? { pixels: opt.dstFull, offset: opt.dstOffset || { x: 0, y: 0 } }
      : null;

    // 同 planFusion：src 是生成块本身，没有环带，用整块统计
    const srcMom = rectMoments(opt.src);
    const dstMom = ringMoments({
      pixels: opt.dst, rect, ring,
      full: full ? full.pixels : null, offset: full ? full.offset : null
    });

    // 色差：Oklab 感知距离（比 RGB 欧氏距离更贴近人眼）
    const dE = colorDistance(srcMom.mean, dstMom.mean);
    const lumOf = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    const lumStep = Math.abs(lumOf(dstMom.mean) - lumOf(srcMom.mean));
    // 对比度差异：两边都「很平」时视为一致。
    // 不能用 max(1, std) 做分母 —— 纯色块 std=0，会算出比值 0、
    // 判定为「100% 不一致」，把完全相同的两块误报成有问题（真实踩到的坑）。
    let contrastMismatch = 0;
    const FLAT = 3;      // 低于这个标准差视为「没有起伏」
    for (let i = 0; i < 3; i++) {
      const ss = srcMom.std[i], ds = dstMom.std[i];
      if (ss < FLAT && ds < FLAT) continue;            // 两边都平 → 一致
      const denom = Math.max(FLAT, ss, ds);
      contrastMismatch = Math.max(contrastMismatch, Math.abs(ss - ds) / denom);
    }

    const issues = [];
    if (dE > 0.06) issues.push('接缝处有色差');
    if (lumStep > 8) issues.push('接缝处有亮度台阶');
    if (contrastMismatch > 0.35) issues.push('对比度与周围不一致');

    let score = 100;
    score -= Math.min(45, dE * 400);
    score -= Math.min(35, lumStep * 1.6);
    score -= Math.min(20, contrastMismatch * 40);
    score = Math.max(0, Math.round(score));

    return {
      score, issues,
      detail: {
        deltaE: Math.round(dE * 1000) / 1000,
        lumStep: Math.round(lumStep * 10) / 10,
        contrastMismatch: Math.round(contrastMismatch * 100) / 100,
        srcMean: srcMom.mean.map((v) => Math.round(v)),
        dstMean: dstMom.mean.map((v) => Math.round(v))
      }
    };
  }

  /**
   * 把周围环境的客观特征**量化成文字**，写进提示词。
   *
   * 为什么这样做：
   *   只说「请保持光线、色彩、质感一致」，模型并不知道「一致」具体是什么 ——
   *   它看不到你照片的像素统计，只能猜，所以总差一点。
   *   但如果把测出来的客观特征写清楚（多亮、偏暖还是偏冷、反差大不大、
   *   主光来自哪个方向），模型就有了可对照的目标。
   *
   * 注意：这些描述是**从像素统计推出来的**，不是编的 —— 所以模型照着做，
   * 结果自然就贴近真实环境。贴回时的「无缝融合」再做最后的像素级对齐，
   * 两者配合：提示词让模型尽量做对，融合兜住剩下的残差。
   *
   * @param {object} o { stats, plane, isZh }
   * @returns {string} 一句可直接拼进提示词的描述
   */
  function describeEnvironment(o) {
    const opt = o || {};
    const isZh = opt.isZh !== false;
    const st = opt.stats || null;
    const plane = opt.plane || null;
    if (!st || !st.mean) return '';

    const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    const L = lum(st.mean);
    // 亮度分档（按人眼感受分档，不按线性刻度）
    const bright = L < 60 ? (isZh ? '整体偏暗' : 'fairly dark')
      : L < 110 ? (isZh ? '中等偏暗' : 'medium-dark')
        : L < 165 ? (isZh ? '中等亮度' : 'medium brightness')
          : L < 215 ? (isZh ? '整体明亮' : 'fairly bright')
            : (isZh ? '高亮（接近过曝）' : 'very bright');

    // 色温：比较红与蓝的相对强弱
    const warm = st.mean[0] - st.mean[2];
    const tone = warm > 18 ? (isZh ? '色调偏暖（偏黄橙）' : 'warm tone (yellow-orange)')
      : warm > 6 ? (isZh ? '色调略暖' : 'slightly warm')
        : warm < -18 ? (isZh ? '色调偏冷（偏蓝青）' : 'cool tone (blue-cyan)')
          : warm < -6 ? (isZh ? '色调略冷' : 'slightly cool')
            : (isZh ? '色调中性' : 'neutral tone');

    // 反差：三通道标准差的平均
    const sd = (st.std[0] + st.std[1] + st.std[2]) / 3;
    const contrast = sd < 18 ? (isZh ? '低反差（画面柔和、灰阶集中）' : 'low contrast (soft, narrow tonal range)')
      : sd < 42 ? (isZh ? '中低反差' : 'medium-low contrast')
        : sd < 68 ? (isZh ? '中等反差' : 'medium contrast')
          : (isZh ? '高反差（明暗对比强烈）' : 'high contrast (strong light-dark separation)');

    // 光照方向：从梯度平面推（只在大到能看出来时才说）
    let dirZh = '', dirEn = '';
    if (plane && plane.ok) {
      const ax = plane.a[0] + plane.a[1] + plane.a[2];   // 水平方向总斜率
      const by = plane.b[0] + plane.b[1] + plane.b[2];   // 垂直方向总斜率
      if (Math.hypot(ax, by) > 12) {
        // 符号约定：像素值 = a·u + b·v + c（u/v 是归一化坐标，0→1）。
        //   a > 0 表示「越往右越亮」→ 光来自右侧
        //   a < 0 表示「越往右越暗」→ 光来自左侧
        // 早期版本写反了，导致「左亮右暗」被描述成「主光来自右侧」——
        // 那会让模型往完全相反的方向打光，比不说更糟。
        const horiz = ax > 0 ? (isZh ? '右' : 'right') : (isZh ? '左' : 'left');
        const vert = by > 0 ? (isZh ? '下' : 'bottom') : (isZh ? '上' : 'top');
        if (Math.abs(ax) > Math.abs(by) * 1.6) {
          dirZh = '主光来自' + horiz + '侧'; dirEn = 'key light from the ' + horiz;
        } else if (Math.abs(by) > Math.abs(ax) * 1.6) {
          dirZh = '主光来自' + vert + '方'; dirEn = 'key light from the ' + vert;
        } else {
          dirZh = '主光来自' + horiz + vert + '方向';
          dirEn = 'key light from the ' + vert + '-' + horiz;
        }
      }
    }

    if (isZh) {
      let s = '周边环境的客观特征：' + bright + '、' + tone + '、' + contrast;
      if (dirZh) s += '、' + dirZh;
      s += '。你改动后的区域必须自然融入这些特征 —— 明暗走向、色调冷暖、反差强弱都要与周边连成一片';
      return s;
    }
    let s = 'Measured characteristics of the surrounding area: ' + bright + ', ' + tone + ', ' + contrast;
    if (dirEn) s += ', ' + dirEn;
    s += '. The area you modify must blend into these characteristics seamlessly — matching the light gradient, color temperature and contrast of its surroundings';
    return s;
  }

  /**
   * 组装「环境契合」约束段。
   *
   * 与 describeEnvironment 的分工：
   *   describeEnvironment —— 把**测出来的客观特征**说给模型听（有数据支撑）
   *   environmentClause  —— 补上**行为要求**（别改选区外、别加边框、别像拼贴）
   *
   * 两者合起来才完整：只讲特征模型不知道怎么用，只讲要求模型不知道目标长什么样。
   */
  function environmentClause(o) {
    const opt = o || {};
    const isZh = opt.isZh !== false;
    const env = opt.envDesc || '';
    const scope = opt.scope || 'region';
    if (isZh) {
      const parts = [];
      if (env) parts.push(env);
      if (scope !== 'global') {
        parts.push('不要改变周边参考区域的内容，也不要让改动区域的边缘出现可见边界');
        parts.push('不要给画面添加任何边框、暗角、光晕或装饰元素');
      }
      parts.push('输出必须是同一张照片的自然延续，看起来像一次拍摄完成的，而不是后期拼贴');
      return parts.join('。');
    }
    const parts = [];
    if (env) parts.push(env);
    if (scope !== 'global') {
      parts.push('Do not alter the surrounding reference area, and do not let any visible boundary appear at the edge of the edited region');
      parts.push('Do not add frames, vignettes, glows or decorative elements');
    }
    parts.push('The output must look like a natural continuation of the same photograph, as if captured in one shot, not a composite');
    return parts.join('. ');
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

  /* ====================== 7.1b EXIF 字段解析（给「照片信息」用） ====================== */

  /** EXIF 里我们关心的字段 → 标签 */
  const EXIF_TAGS = {
    0x010F: 'make',           // 厂商
    0x0110: 'model',          // 机型
    0x0112: 'orientation',
    0x011A: 'xResolution',
    0x011B: 'yResolution',
    0x0131: 'software',       // 软件
    0x0132: 'dateTime',       // 修改时间
    0x829A: 'exposureTime',   // 快门
    0x829D: 'fNumber',        // 光圈
    0x8827: 'iso',            // ISO
    0x9003: 'dateTimeOriginal',  // 拍摄时间
    0x920A: 'focalLength',    // 焦距
    0x9291: 'subSecOriginal',
    0xA002: 'pixelX',
    0xA003: 'pixelY',
    0xA405: 'focalLength35',  // 等效焦距
    0xA434: 'lensModel'       // 镜头
  };
  const EXIF_GPS_IFD = 0x8825;

  /**
   * 解析 EXIF，取出常用字段。
   *
   * 为什么需要：摄影师常要确认「这张是什么机器、什么参数拍的」，
   * 而修图台导出时会保留这些信息 —— 用户需要一个地方能看到它们，
   * 否则「保留了元数据」是看不见摸不着的。
   *
   * 实现上只解析 IFD0 与 ExifIFD（够用），遇到不认识的字段直接跳过，
   * 任何异常都退化成「读不到」而不是抛错。
   *
   * @param {Uint8Array} tiff EXIF 的 TIFF 段（extractExif 的返回值）
   * @returns {object} 字段名 → 值；读不到返回 {}
   */
  function parseExifFields(tiff) {
    const out = {};
    if (!tiff || tiff.length < 8) return out;
    try {
      const le = tiff[0] === 0x49 && tiff[1] === 0x49;
      const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
      if (!le && !be) return out;
      const u16 = (o) => (o + 2 <= tiff.length
        ? (le ? (tiff[o] | (tiff[o + 1] << 8)) : ((tiff[o] << 8) | tiff[o + 1])) : 0);
      const u32 = (o) => (o + 4 <= tiff.length
        ? (le
          ? ((tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)) >>> 0)
          : (((tiff[o] << 24) | (tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]) >>> 0))
        : 0);
      const i32 = (o) => {
        const v = u32(o);
        return v > 0x7fffffff ? v - 0x100000000 : v;
      };
      if (u16(2) !== 0x002a) return out;

      /** 读一条 IFD 条目指向的实际值 */
      const readValue = (entry) => {
        const type = u16(entry + 2);
        const count = u32(entry + 4);
        const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
        const sz = sizes[type] || 1;
        const total = count * sz;
        // 值不超过 4 字节时内联存放，否则存偏移
        const off = total <= 4 ? entry + 8 : u32(entry + 8);
        if (off < 0 || off + total > tiff.length) return null;

        if (type === 2) {                       // ASCII 字符串
          let s = '';
          for (let i = 0; i < count; i++) {
            const ch = tiff[off + i];
            if (ch === 0) break;
            s += String.fromCharCode(ch);
          }
          return s.trim();
        }
        if (type === 3) return u16(off);        // SHORT
        if (type === 4) return u32(off);        // LONG
        if (type === 9) return i32(off);        // SLONG
        if (type === 5 || type === 10) {        // RATIONAL / SRATIONAL
          const num = type === 5 ? u32(off) : i32(off);
          const den = type === 5 ? u32(off + 4) : i32(off + 4);
          return den === 0 ? null : num / den;
        }
        return null;
      };

      let gpsFound = false;
      const walk = (ifdOff, depth) => {
        if (depth > 2 || ifdOff <= 0 || ifdOff + 2 > tiff.length) return;
        const count = u16(ifdOff);
        // 防御：IFD 条目数异常大说明数据损坏，直接放弃
        if (count > 512) return;
        for (let k = 0; k < count; k++) {
          const e = ifdOff + 2 + k * 12;
          if (e + 12 > tiff.length) break;
          const tag = u16(e);
          if (tag === EXIF_GPS_IFD) { gpsFound = true; continue; }
          if (tag === 0x8769) {               // ExifIFD 指针，递归进去
            walk(u32(e + 8), depth + 1);
            continue;
          }
          const key = EXIF_TAGS[tag];
          if (!key) continue;
          const v = readValue(e);
          if (v !== null && v !== '' && out[key] === undefined) out[key] = v;
        }
      };
      walk(u32(4), 0);
      if (gpsFound) out.hasGps = true;
      return out;
    } catch (e) {
      return out;    // 元数据损坏不该影响看图
    }
  }

  /**
   * 把解析出来的 EXIF 字段整理成「给人看的信息列表」。
   *
   * 分成几组，每组若干条 —— 界面按组展示，用户一眼看到关心的项。
   *
   * @param {object} o { exif, width, height, sizeBytes, fileName, mime, icc, iccIsSrgb, metaSource }
   * @returns {Array<{group:string, items:Array<{label:string, value:string}>}>}
   */
  function describePhotoInfo(o) {
    const opt = o || {};
    const ex = opt.exif || {};
    const groups = [];
    const push = (group, items) => {
      const list = items.filter((x) => x && x.value !== '' && x.value != null);
      if (list.length) groups.push({ group, items: list });
    };
    const fmtNum = (v, digits) => {
      const n = num(v, NaN);
      if (!Number.isFinite(n)) return '';
      return digits == null ? String(Math.round(n)) : n.toFixed(digits);
    };

    // ---- 文件 ----
    push('文件', [
      { label: '文件名', value: String(opt.fileName || '') },
      { label: '格式', value: String(opt.mime || '').replace('image/', '').toUpperCase() },
      {
        label: '尺寸',
        value: opt.width && opt.height ? opt.width + ' × ' + opt.height + ' 像素' : ''
      },
      {
        label: '像素数',
        value: opt.width && opt.height
          ? ((opt.width * opt.height) / 1e6).toFixed(1) + ' MP' : ''
      },
      { label: '文件大小', value: opt.sizeBytes ? formatBytes(opt.sizeBytes) : '' }
    ]);

    // ---- 拍摄设备 ----
    const make = String(ex.make || '').trim();
    const model = String(ex.model || '').trim();
    // 机型里常已含厂商名（如 "Canon EOS R5"），避免重复显示
    const device = model && make && model.toLowerCase().indexOf(make.toLowerCase()) === 0
      ? model : [make, model].filter(Boolean).join(' ');
    push('拍摄设备', [
      { label: '相机 / 手机', value: device },
      { label: '镜头', value: String(ex.lensModel || '').trim() },
      { label: '软件', value: String(ex.software || '').trim() }
    ]);

    // ---- 拍摄参数 ----
    const shot = [];
    if (ex.exposureTime != null) {
      const t = num(ex.exposureTime, 0);
      // 快门速度：小于 1 秒用分数表示（摄影惯例）
      shot.push({
        label: '快门',
        value: t >= 1 ? t.toFixed(1) + ' 秒' : '1/' + Math.round(1 / t) + ' 秒'
      });
    }
    if (ex.fNumber != null) shot.push({ label: '光圈', value: 'f/' + num(ex.fNumber, 0).toFixed(1) });
    if (ex.iso != null) shot.push({ label: 'ISO', value: 'ISO ' + fmtNum(ex.iso) });
    if (ex.focalLength != null) {
      const f = num(ex.focalLength, 0);
      const f35 = ex.focalLength35 != null ? num(ex.focalLength35, 0) : null;
      shot.push({
        label: '焦距',
        value: f.toFixed(0) + ' mm' + (f35 && Math.abs(f35 - f) > 1 ? '（等效 ' + f35.toFixed(0) + ' mm）' : '')
      });
    }
    push('拍摄参数', shot);

    // ---- 时间 ----
    const dt = String(ex.dateTimeOriginal || ex.dateTime || '').trim();
    push('时间', [{ label: '拍摄时间', value: formatExifDate(dt) }]);

    // ---- 色彩与方向 ----
    push('色彩与方向', [
      { label: '色彩配置', value: opt.icc ? (opt.iccIsSrgb ? 'sRGB（标准）' : '广色域（导出时转 sRGB）') : '' },
      { label: '方向标记', value: ex.orientation != null && ex.orientation !== 1 ? '已校正（原图带旋转标记）' : '' }
    ]);

    // ---- 隐私 ----
    if (ex.hasGps) {
      groups.push({
        group: '隐私',
        items: [{ label: '定位信息', value: '照片含 GPS 定位（导出到社交平台时会自动移除）' }]
      });
    }
    return groups;
  }

  /**
   * EXIF 的日期格式是 `YYYY:MM:DD HH:MM:SS`（用冒号分隔日期），
   * 转成 `YYYY-MM-DD HH:MM:SS` 更符合阅读习惯。无法识别时原样返回。
   */
  function formatExifDate(s) {
    const str = String(s || '').trim();
    if (!str) return '';
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str);
    if (!m) return str;
    return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6];
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
    // 环境契合约束：每次调用都带上（默认开启，可关）
    // 这是「让模型主动贴合周围环境」的手段，与贴回时的像素级融合互补：
    //   提示词 → 让模型尽量做对；融合 → 兜住剩下的残差
    const envOn = o.envFit !== false;
    const envSeg = envOn
      ? environmentClause({ isZh, envDesc: o.envDesc || '', scope: o.scope || 'region' })
      : '';
    // 选区在请求图里的大致占比：四周留白是给模型看的周边环境。
    // 之前靠「把选区涂成蓝色」来告诉模型改哪里，结果蓝色被当成画面内容，
    // 生成结果整体偏蓝。现在改成用文字描述区域范围，图片保持原样。
    const center = Math.round(Math.min(100, Math.max(10, num(o.centerPct, 80))));
    // 构图引导线：用户亲手画的位置比任何文字描述都准。
    // 放在环境契合约束之后、收尾约束之前 —— 越靠近结尾，模型越当回事。
    const guideSeg = String(o.guideDesc || '').trim();

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
      if (envSeg) parts.push(envSeg);
      if (guideSeg) parts.push(guideSeg);
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
      if (envSeg) parts.push(envSeg);
      if (guideSeg) parts.push(guideSeg);
      parts.push('Change only what is described above and leave everything else untouched');
      parts.push('Output a single complete photorealistic photo, no seams, frames, watermarks or extra elements');
    }
    // 中文用「。」连接，英文用「. 」
    return parts.filter(Boolean).join(isZh ? '。' : '. ').replace(/。。+/g, '。');
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
    parseSize, snapTo, resolveOutputSize, resolveAspectRatio,
    SIZE_RULES, sizeRulesFor, validateSize, conformSize,
    planUpscale, mapUpscaledSelection,
    coverCrop, aspectMismatch, mapSelectionToResult,

    parseImageSize,
    patchMemory, planHistoryMemory, planSessionPersist, packMask, unpackMask,
    normalizeLayer, layerAlphaAt, layerAlphaMap, layerCoverage, sortLayers,
    createUndoStack, makeUndoCommand, commandDirection,
    buildTimeline, describeCommand, planHistoryJump,
    CFG_REV, migrateCfg,
    // 作品库（跨天记录）
    storageBytes, estimateWorkBytes, normalizeWork, sortWorksNewestFirst,
    planLibrary, dayStartTs, describeWorkAge, formatWorkClock,
    groupWorksByDay, workLibraryStats,
    LIBRARY_BUDGET_BYTES, LIBRARY_MAX_ITEMS, THUMB_MAX_SIDE,
    // 后台保活
    planKeepAlive, describeKeepAlive, planGenForegroundNotice,
    // 工具栏高度
    planToolbar, clampBarHeight, isBarCollapsed, BAR_MIN,
    // 浏览器能力兼容
    planCompat, compatClassNames,
    // 对比视图手势
    planCompareDrag, planCompareDoubleTap, describeCompareZoom, placeCompareSplit,
    // 检查更新
    parseVersion, compareVersion, pickLatestRelease, planUpdate, pickApkAsset, planUpdateCheck,
    // 无缝融合（模型输出对齐原图）
    ringMoments, rectMoments, fitLightPlane, planFusion, fuseColor,
    describeEnvironment, environmentClause,
    textureEnergy, planGrain, grainNoise, assessSeam,
    EXPORT_PRESETS, getExportPreset, planExportSize, stripGpsFromExif, planExportMetadata,
    EXPORT_SIZES, EXPORT_FORMATS, makeCustomPreset, planExportWithHint, estimateExportSize,
    MODEL_PRICES, DEFAULT_USD_CNY, modelPrice, estimateCost, accumulateSpend, formatUsd, formatCny,
    parseJpegSegments, extractExif, extractICC, readExifOrientation,
    parseExifFields, describePhotoInfo, formatExifDate, EXIF_TAGS,
    // 引导线
    GUIDE_KINDS, getGuideKind, getStrokeColor, GUIDE_STROKE_COLORS, isFreehandGuide,
    normalizeGuide, snapGuide, guideOrientation,
    planStrokeOverlay, drawStrokeOverlay,
    describeGuides, mapGuidesToRequest,
    normalizeExifOrientation, buildExifPayload, injectMetadata, isSrgbProfile,
    // 模型
    PROVIDERS, getProvider, findModel, joinUrl, buildImageRequest, parseImageResponse, extractError,
    dataUrlToBytes, resolveEndpoint, needsMultipart, buildMultipartBody,
    classifyModel, pickImageModels, findKnownModel, modelParams,
    validateImageRequest, diagnoseResponse,
    // 提示词
    STYLE_PRESETS, SCOPE_PRESETS, buildPrompt,
    // 导出
    formatBytes, timestampName
  };
});
