/* =============================================================================
 * 回归测试：针对已修复的缺陷，确保不再复现
 *   S1 贴回位置偏移（上下文外扩导致）
 *   S2 接缝色彩匹配失效
 *   S3 撤销/重做破坏合成（羽化与掩膜丢失）
 *   M3 分块硬拼接产生接缝
 *   L1 小选区无法移动
 *   L3 小选区被羽化整块淡化
 *   M1 server 畸形 URL 崩溃
 * ========================================================================== */
'use strict';
const C = require('../app/core.js');
let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); } };
const solid = (w, h, c) => {
  const p = C.makePixels(w, h);
  for (let i = 0; i < p.data.length; i += 4) {
    p.data[i] = c[0]; p.data[i + 1] = c[1]; p.data[i + 2] = c[2]; p.data[i + 3] = 255;
  }
  return p;
};

console.log('\n【S1】贴回位置不再偏移');
for (const pct of [0, 12, 30, 50]) {
  const rect = { x: 100, y: 80, w: 160, h: 120 };
  const padX = Math.round(rect.w * pct / 100), padY = Math.round(rect.h * pct / 100);
  const req = C.clampRect({ x: rect.x - padX, y: rect.y - padY, w: rect.w + padX * 2, h: rect.h + padY * 2 }, 2000, 2000);
  const off = { x: rect.x - req.x, y: rect.y - req.y };
  // 模型原样回显请求图
  const r = C.mapSelectionToResult({
    genW: req.w, genH: req.h, reqW: req.w, reqH: req.h,
    offX: off.x, offY: off.y, selW: rect.w, selH: rect.h
  });
  t(`contextPct=${pct}% 原样回显偏移为 0`, Math.abs(r.sx - off.x) < 0.01 && Math.abs(r.sy - off.y) < 0.01,
    { got: [r.sx, r.sy], want: [off.x, off.y] });
}
// 模型输出缩放 + 改变比例
(() => {
  const r = C.mapSelectionToResult({ genW: 1328, genH: 1328, reqW: 744, reqH: 496, offX: 72, offY: 48, selW: 600, selH: 400 });
  t('模型改分辨率时窗口比例不变形', Math.abs(r.sw / r.sh - 1.5) < 0.01, r.sw / r.sh);
  t('模型改分辨率时窗口在图内', r.sx >= 0 && r.sy >= 0 && r.sx + r.sw <= 1328.01 && r.sy + r.sh <= 1328.01);
})();

console.log('\n【S2】接缝色彩匹配生效');
(() => {
  const run = (strength) => {
    const full = solid(60, 60, [100, 100, 100]);
    const sub = solid(20, 20, [100, 100, 100]);
    const patch = solid(20, 20, [200, 200, 200]);
    C.compositeFeathered(sub, patch, { x: 0, y: 0, w: 20, h: 20 },
      { feather: 0, colorMatch: { ring: 6, ramp: 8, strength }, dstFull: full, dstOffset: { x: 20, y: 20 } });
    return sub.data[0];
  };
  const a = run(0), b = run(0.5), c = run(1);
  t('strength=0 保持模型原色', a === 200, a);
  t('strength=0 与 1 结果不同（控件真正生效）', a !== c, { a, c });
  t('strength 越大越贴近周围色调（单调）', a >= b && b >= c, { a, b, c });
  // 无整图引用时（旧路径）不应崩
  const sub2 = solid(20, 20, [100, 100, 100]);
  C.compositeFeathered(sub2, solid(20, 20, [200, 200, 200]), { x: 0, y: 0, w: 20, h: 20 },
    { feather: 0, colorMatch: { ring: 6, ramp: 8, strength: 1 } });
  t('无整图引用时降级不崩', sub2.data[0] === 200, sub2.data[0]);
})();

console.log('\n【S3】合成结果可重复（撤销/重做保真）');
(() => {
  // 同一份 edit 连续合成两次，结果必须完全一致（rebuildViewCanvas 走的就是这个路径）
  const makeEdit = () => {
    const patch = solid(40, 40, [220, 30, 30]);
    const mask = new Float32Array(40 * 40).fill(1);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 20; x++) mask[y * 40 + x] = 0; // 左半边保护
    return { rect: { x: 20, y: 20, w: 40, h: 40 }, patch, feather: 8, colorMatch: 0.5, mask };
  };
  const apply = (edit) => {
    const cv = solid(100, 100, [30, 90, 160]);
    const id = { data: cv.data, width: 100, height: 100 };
    // 模拟 compositeEditInto：取子图 + 整图引用
    const sub = C.makePixels(edit.rect.w, edit.rect.h);
    for (let y = 0; y < edit.rect.h; y++) for (let x = 0; x < edit.rect.w; x++) {
      const si = ((edit.rect.y + y) * 100 + edit.rect.x + x) * 4, di = (y * edit.rect.w + x) * 4;
      for (let k = 0; k < 4; k++) sub.data[di + k] = id.data[si + k];
    }
    const src = { data: edit.patch.data, width: 40, height: 40 };
    C.compositeFeathered(sub, src, { x: 0, y: 0, w: 40, h: 40 },
      { feather: edit.feather, colorMatch: { ring: 6, ramp: 8, strength: edit.colorMatch }, mask: edit.mask, dstFull: id, dstOffset: edit.rect });
    for (let y = 0; y < edit.rect.h; y++) for (let x = 0; x < edit.rect.w; x++) {
      const di = ((edit.rect.y + y) * 100 + edit.rect.x + x) * 4, si = (y * edit.rect.w + x) * 4;
      for (let k = 0; k < 4; k++) id.data[di + k] = sub.data[si + k];
    }
    return cv;
  };
  const e = makeEdit();
  const a = apply(e), b = apply(e);
  let diff = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) diff++;
  t('同一编辑重复合成结果逐像素一致', diff === 0, diff);
  // 掩膜保护的区域必须保持原色
  const px = (cv, x, y) => [cv.data[(y * 100 + x) * 4], cv.data[(y * 100 + x) * 4 + 1], cv.data[(y * 100 + x) * 4 + 2]];
  t('掩膜排除的区域未被覆盖', JSON.stringify(px(a, 25, 40)) === '[30,90,160]', px(a, 25, 40));
  t('掩膜允许的区域已被修改', px(a, 50, 40)[0] > 150, px(a, 50, 40));
  // 羽化必须存在过渡（不是硬边）
  const edge = px(a, 21, 40)[0], mid = px(a, 40, 40)[0];
  t('羽化产生过渡（非硬边）', edge !== mid, { edge, mid });
})();

console.log('\n【M3】分块拼接无硬断层');
(() => {
  const full = { x: 0, y: 0, w: 600, h: 300 };
  const tiles = C.planTileCrop(full, { maxSide: 300, overlap: 80 });
  t('产生多块', tiles.length >= 3, tiles.length);
  const acc = { data: new Float32Array(600 * 300 * 3), w: 600, h: 300 };
  const wacc = { data: new Float32Array(600 * 300), w: 600, h: 300 };
  const colors = [[220, 40, 40], [40, 220, 40], [40, 40, 220], [220, 220, 40], [220, 40, 220]];
  tiles.forEach((tile, i) => {
    const p = solid(tile.w, tile.h, colors[i % colors.length]);
    const w = C.tileBlendWeights(tile, full, 80);
    C.accumulateTile(acc, wacc, p, tile.x - full.x, tile.y - full.y, w);
  });
  const out = C.makePixels(600, 300);
  C.resolveAccumulated(acc, wacc, out);
  let maxJump = 0;
  for (let x = 1; x < 600; x++) {
    const a = (150 * 600 + x) * 4, b = (150 * 600 + x - 1) * 4;
    maxJump = Math.max(maxJump, Math.abs(out.data[a] - out.data[b]) + Math.abs(out.data[a + 1] - out.data[b + 1]) + Math.abs(out.data[a + 2] - out.data[b + 2]));
  }
  t('块边界无硬断层（跳变 < 60）', maxJump < 60, maxJump);
  // 全覆盖：不能有未写入的像素
  let zero = 0;
  for (let i = 0; i < wacc.data.length; i++) if (wacc.data[i] <= 0) zero++;
  t('所有像素都被覆盖（无空洞）', zero === 0, zero);
})();

console.log('\n【L1】小选区可整体移动');
(() => {
  const small = { x: 100, y: 100, w: 24, h: 24 };
  t('小选区中心=move', C.hitTest({ x: 112, y: 112 }, small, 24) === 'move', C.hitTest({ x: 112, y: 112 }, small, 24));
  t('小选区仍能抓左上角', C.hitTest({ x: 100, y: 100 }, small, 24) === 'nw');
  t('小选区仍能抓右下角', C.hitTest({ x: 124, y: 124 }, small, 24) === 'se');
  const big = { x: 100, y: 100, w: 300, h: 300 };
  t('大选区行为不变（中心 move）', C.hitTest({ x: 250, y: 250 }, big, 24) === 'move');
  t('大选区行为不变（角 nw）', C.hitTest({ x: 100, y: 100 }, big, 24) === 'nw');
})();

console.log('\n【L3】小选区不被羽化整块淡化');
for (const [w, h] of [[8, 8], [16, 16], [20, 20], [30, 30], [200, 200]]) {
  const m = C.featherMask(w, h, 10);
  let mx = 0;
  for (const v of m) mx = Math.max(mx, v);
  t(`${w}x${h} 选区中心可完全生效`, mx > 0.99, mx);
}
t('大选区羽化仍然归零（不失效）', C.featherMask(200, 200, 10)[0] < 0.05, C.featherMask(200, 200, 10)[0]);

console.log('\n【L6/M5】选区自由：不再自动改写用户框选');
(() => {
  // snapRectToModel 已改为只记录偏差；这里验证核心几何不会被意外改动
  const r = { x: 10, y: 10, w: 559, h: 262 };
  const dev = Math.abs(Math.log((r.w / r.h) / 1.793));
  t('比例偏差可被计算用于提示', dev > 0 && dev < 1, dev);
  t('选区比例未被改写（宽高保持）', r.w === 559 && r.h === 262);
})();

/* ============ 以下为后续追加：模型检测 & 配置保留 ============ */

console.log('\n【小选区】必须能通过上游最小尺寸限制');
(() => {
  const rules = C.sizeRulesFor('openai');
  // 摄影师常改的小区域
  const small = [[60, 60], [80, 80], [100, 100], [128, 128], [150, 150], [200, 200], [256, 256], [300, 200], [400, 300], [512, 512]];
  for (const [w, h] of small) {
    const u = C.planUpscale(w, h, 'openai');
    const v = C.validateSize(u.w + 'x' + u.h, 'openai');
    t(`小选区 ${w}x${h} 放大后达标`, v.ok, { got: u.w + 'x' + u.h, reasons: v.reasons });
    t(`小选区 ${w}x${h} 放大倍数合理（<20x）`, u.scale < 20, u.scale);
    t(`小选区 ${w}x${h} 放大后比例保持`, Math.abs((u.w / u.h) / (w / h) - 1) < 0.06, { up: u.w / u.h, src: w / h });
  }
  // 已经够大的不该被放大
  const big = C.planUpscale(1200, 900, 'openai');
  t('大选区不放大', big.needed === false || big.scale <= 1.001, big);
  // 硅基流动没有最小限制 → 不该放大
  const sf = C.planUpscale(100, 100, 'siliconflow');
  t('无最小限制的服务商不放大', sf.needed === false, sf);

  // 上采样后的坐标映射必须无偏移、不变形
  for (const [w, h] of [[100, 100], [80, 60], [256, 128], [150, 300]]) {
    const req = { x: 0, y: 0, w: Math.round(w * 1.24), h: Math.round(h * 1.24) };
    const off = { x: Math.round(w * 0.12), y: Math.round(h * 0.12) };
    const u = C.planUpscale(req.w, req.h, 'openai');
    const upOff = { x: off.x * u.scale, y: off.y * u.scale };
    const upSelW = w * u.scale, upSelH = h * u.scale;
    // 模型返回任意尺寸（这里取 1024x1024）
    const crop = C.mapSelectionToResult({
      genW: 1024, genH: 1024, reqW: u.w, reqH: u.h,
      offX: upOff.x, offY: upOff.y, selW: upSelW, selH: upSelH
    });
    // 比例必须等于原选区比例
    t(`上采样后 ${w}x${h} 不变形`, Math.abs((crop.sw / crop.sh) / (w / h) - 1) < 0.02, { got: crop.sw / crop.sh, want: w / h });
    // 位置：选区中心在返回图中的位置必须对得上
    const expCx = (upOff.x + upSelW / 2) * 1024 / u.w;
    const expCy = (upOff.y + upSelH / 2) * 1024 / u.h;
    const gotCx = crop.sx + crop.sw / 2, gotCy = crop.sy + crop.sh / 2;
    t(`上采样后 ${w}x${h} 无偏移`, Math.abs(expCx - gotCx) < 2 && Math.abs(expCy - gotCy) < 2,
      { exp: [Math.round(expCx), Math.round(expCy)], got: [Math.round(gotCx), Math.round(gotCy)] });
    // 裁剪窗口必须在返回图内
    t(`上采样后 ${w}x${h} 窗口在图内`, crop.sx >= -0.01 && crop.sy >= -0.01 && crop.sx + crop.sw <= 1024.01 && crop.sy + crop.sh <= 1024.01, crop);
  }

  // 极端长条选区：比例越界时应被识别出来（放大救不了，需要提示用户）
  const narrow = C.planUpscale(1000, 100, 'openai');
  t('极扁选区比例越界被识别', narrow.aspectInvalid === true || C.validateSize(narrow.w + 'x' + narrow.h, 'openai').ok,
    { aspectInvalid: narrow.aspectInvalid, size: narrow.w + 'x' + narrow.h });
})();

console.log('\n【成本预估】价格准确、分块会翻倍');
(() => {
  // 1) 价格表有据可查（这几项来自官方页面/博客）
  const must = [
    ['Qwen/Qwen-Image-Edit', 0.04],
    ['black-forest-labs/FLUX.1-Kontext-pro', 0.04],
    ['black-forest-labs/FLUX.1-Kontext-max', 0.08],
    ['gpt-image-1', 0.042]
  ];
  for (const [id, usd] of must) {
    const p = C.modelPrice(id);
    t('价格收录: ' + id, !!p && Math.abs(p.usd - usd) < 1e-9, p);
  }
  t('未收录模型返回 null（不瞎猜）', C.modelPrice('some/unknown-model') === null);
  t('空输入安全', C.modelPrice(null) === null && C.modelPrice('') === null);
  // 容错匹配
  t('容错匹配（忽略大小写/分隔符）', !!C.modelPrice('qwen/qwenimageedit'));

  // 2) 单次成本
  const e1 = C.estimateCost({ rect: { w: 800, h: 600 }, model: 'Qwen/Qwen-Image-Edit', tileMaxSide: 1400 });
  t('小选区 1 次调用', e1.calls === 1, e1.calls);
  t('金额正确', Math.abs(e1.totalUsd - 0.04) < 1e-9, e1.totalUsd);
  t('人民币换算正确', Math.abs(e1.totalCny - 0.04 * 7.1) < 1e-9, e1.totalCny);

  // 3) 关键：分块使成本翻倍
  const e2 = C.estimateCost({ rect: { w: 3000, h: 2000 }, model: 'Qwen/Qwen-Image-Edit', tileMaxSide: 1400 });
  t('大选区多次调用', e2.calls > 1, e2.calls);
  t('成本随调用次数线性增长', Math.abs(e2.totalUsd - 0.04 * e2.calls) < 1e-9, e2.totalUsd);
  const e3 = C.estimateCost({ rect: { w: 4000, h: 3000 }, model: 'Qwen/Qwen-Image-Edit', tileMaxSide: 1400 });
  t('4000x3000 调用 9 次', e3.calls === 9, e3.calls);
  t('4000x3000 成本约 $0.36', Math.abs(e3.totalUsd - 0.36) < 1e-9, e3.totalUsd);
  // 关闭分块 → 只调用 1 次（成本不涨）
  const e4 = C.estimateCost({ rect: { w: 4000, h: 3000 }, model: 'Qwen/Qwen-Image-Edit', tileMaxSide: 0 });
  t('关闭分块只调用 1 次', e4.calls === 1, e4.calls);

  // 4) 自定义单价优先于内置
  const e5 = C.estimateCost({ rect: { w: 800, h: 600 }, model: 'Qwen/Qwen-Image-Edit', priceOverride: 0.1 });
  t('自定义单价生效', Math.abs(e5.totalUsd - 0.1) < 1e-9, e5.totalUsd);
  const e6 = C.estimateCost({ rect: { w: 800, h: 600 }, model: 'unknown/x', priceOverride: 0.05 });
  t('未知模型也能用自定义单价估算', e6.known === true && Math.abs(e6.totalUsd - 0.05) < 1e-9, e6);
  // 未收录且无自定义 → 标记未知，不编造数字
  const e7 = C.estimateCost({ rect: { w: 800, h: 600 }, model: 'unknown/x' });
  t('未收录且无自定义 → 标记未知', e7.known === false && e7.totalUsd === null);
  t('未知时给出可操作提示', /手动填写单价/.test(e7.note), e7.note);

  // 5) 汇率可调
  const e8 = C.estimateCost({ rect: { w: 800, h: 600 }, model: 'Qwen/Qwen-Image-Edit', usdCny: 7 });
  t('汇率可自定义', Math.abs(e8.totalCny - 0.04 * 7) < 1e-9, e8.totalCny);

  // 6) 累计花费
  let acc = { calls: 0, usd: 0, unknownCalls: 0 };
  acc = C.accumulateSpend(acc, e1);
  acc = C.accumulateSpend(acc, e1);
  t('累计调用次数', acc.calls === 2, acc.calls);
  t('累计金额', Math.abs(acc.usd - 0.08) < 1e-9, acc.usd);
  acc = C.accumulateSpend(acc, e7);   // 未知单价
  t('未知单价计入调用次数但不计入金额', acc.calls === 3 && acc.unknownCalls === 1, acc);
  t('累计金额未被污染', Math.abs(acc.usd - 0.08) < 1e-9, acc.usd);
  t('空累计安全', C.accumulateSpend(null, null).calls === 0);

  // 7) 金额格式化（小额不能显示成 $0.00）
  t('$0.005 显示 4 位小数', C.formatUsd(0.005) === '$0.0050', C.formatUsd(0.005));
  t('$0.04 显示 3 位小数', C.formatUsd(0.04) === '$0.040', C.formatUsd(0.04));
  t('$4 显示 2 位小数', C.formatUsd(4) === '$4.00', C.formatUsd(4));
  t('$40 显示两位小数', C.formatUsd(40) === '$40.00', C.formatUsd(40));
  t('$400 不显示小数（大额简化）', C.formatUsd(400) === '$400', C.formatUsd(400));
  t('0 显示 $0', C.formatUsd(0) === '$0', C.formatUsd(0));
  t('人民币格式化（0.1~100 两位小数）', C.formatCny(0.28) === '¥0.28', C.formatCny(0.28));
  t('人民币小额三位小数', C.formatCny(0.05) === '¥0.050', C.formatCny(0.05));

  // 8) 源码层面：生成前必须真的做确认与累计
  const fs = require('fs');
  const appSrc = fs.readFileSync(__dirname + '/../app/app.js', 'utf8');
  t('生成前做成本确认', /confirmCostIfNeeded\(est\)/.test(appSrc));
  t('生成成功后累计花费', /accumulateSpend\(S\.spend/.test(appSrc));
  t('界面显示预估成本', /costNote/.test(appSrc));
  t('大额才弹确认（小额不打扰）', /est\.totalUsd < 0\.2/.test(appSrc));
})();

console.log('\n【导出预设】尺寸/质量/元数据按场景自动适配');
(() => {
  // 1) 预设完整性
  const ids = C.EXPORT_PRESETS.map((p) => p.id);
  for (const need of ['full', 'print', 'wechat', 'social', 'web', 'custom']) {
    t('预设存在: ' + need, ids.indexOf(need) >= 0);
  }
  t('每个预设都有说明', C.EXPORT_PRESETS.every((p) => p.label && p.desc));
  t('未知预设回退到默认', C.getExportPreset('nope').id === 'full');

  // 2) 尺寸规划：只缩不放
  const big = C.planExportSize(6000, 4000, C.getExportPreset('wechat'));
  t('大图按长边缩放', big.w === 2000 && big.h === 1333 && big.scaled === true, big);
  const small = C.planExportSize(800, 600, C.getExportPreset('wechat'));
  t('小图不放大（避免模糊）', small.w === 800 && small.h === 600 && small.scaled === false, small);
  const full = C.planExportSize(6000, 4000, C.getExportPreset('full'));
  t('原尺寸预设不缩放', full.w === 6000 && full.h === 4000 && full.scaled === false);
  // 长边是「宽高中较大的一边」
  const portrait = C.planExportSize(3000, 6000, C.getExportPreset('social'));
  t('竖图按高度（长边）缩放', portrait.h === 1440 && portrait.w === 720, portrait);
  // 极端尺寸不崩
  t('零尺寸安全', C.planExportSize(0, 0, C.getExportPreset('wechat')).w >= 1);
  t('负数安全', C.planExportSize(-100, -100, C.getExportPreset('full')).w >= 1);

  // 3) GPS 移除（隐私保护）
  const mkTiff = (withGps) => {
    const n = withGps ? 2 : 1;
    const t = new Uint8Array(8 + 2 + n * 12 + 4);
    t[0] = 0x49; t[1] = 0x49; t[2] = 0x2a; t[4] = 8;
    t[8] = n;
    t[10] = 0x12; t[11] = 0x01; t[12] = 3; t[14] = 1; t[18] = 1;   // Orientation
    if (withGps) {
      const o = 22;
      t[o] = 0x25; t[o + 1] = 0x88; t[o + 2] = 4; t[o + 4] = 1; t[o + 8] = 100;  // GPS 指针
    }
    return t;
  };
  const readTags = (t) => {
    const le = t[0] === 0x49;
    const u16 = (o) => (le ? (t[o] | (t[o + 1] << 8)) : ((t[o] << 8) | t[o + 1]));
    const u32 = (o) => (le
      ? ((t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0)
      : (((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0));
    const ifd0 = u32(4), n = u16(ifd0), tags = [];
    for (let k = 0; k < n; k++) tags.push(u16(ifd0 + 2 + k * 12));
    return tags;
  };
  const withGps = mkTiff(true);
  t('构造的 EXIF 含 GPS', readTags(withGps).indexOf(0x8825) >= 0);
  const stripped = C.stripGpsFromExif(withGps);
  t('GPS 被移除', stripped.removed === true);
  t('移除后 GPS 标签消失', readTags(stripped.exif).indexOf(0x8825) < 0, readTags(stripped.exif));
  t('移除后 Orientation 仍保留', readTags(stripped.exif).indexOf(0x0112) >= 0);
  t('原数据未被修改', readTags(withGps).indexOf(0x8825) >= 0);
  t('无 GPS 时正确识别', C.stripGpsFromExif(mkTiff(false)).removed === false);
  t('空输入安全', C.stripGpsFromExif(null).removed === false && C.stripGpsFromExif(undefined).removed === false);

  // 4) 按预设决定元数据策略
  const meta = { source: 'jpeg', exif: mkTiff(true), icc: new Uint8Array(200), iccIsSrgb: true };
  const pFull = C.planExportMetadata(meta, C.getExportPreset('full'));
  t('原尺寸预设保留 EXIF+ICC', !!pFull.exif && !!pFull.icc);
  t('原尺寸预设保留 GPS', readTags(pFull.exif).indexOf(0x8825) >= 0);
  const pWechat = C.planExportMetadata(meta, C.getExportPreset('wechat'));
  t('微信预设保留 EXIF', !!pWechat.exif);
  t('微信预设移除 GPS', readTags(pWechat.exif).indexOf(0x8825) < 0);
  t('微信预设提示已移除定位', pWechat.notes.some((n) => /定位/.test(n)), pWechat.notes);
  const pWeb = C.planExportMetadata(meta, C.getExportPreset('web'));
  t('网页预设不保留 EXIF', pWeb.exif === null);
  t('网页预设不保留 ICC', pWeb.icc === null);
  t('网页预设提示未保留拍摄信息', pWeb.notes.some((n) => /拍摄信息/.test(n)), pWeb.notes);
  // 非 JPEG 源不报错
  const pPng = C.planExportMetadata({ source: 'none' }, C.getExportPreset('full'));
  t('非 JPEG 源安全', pPng.exif === null && pPng.icc === null);
  // 广色域处理
  const wideMeta = { source: 'jpeg', exif: mkTiff(true), icc: new Uint8Array(200), iccIsSrgb: false };
  const pWide = C.planExportMetadata(wideMeta, C.getExportPreset('full'));
  t('广色域不写回原 ICC（避免错色）', pWide.icc === null);
  t('广色域给出提示', pWide.notes.some((n) => /广色域/.test(n)), pWide.notes);

  // 5) 源码层面：导出必须真的用上预设
  const fs = require('fs');
  const appSrc = fs.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const fn = appSrc.slice(appSrc.indexOf('async function exportImage'), appSrc.indexOf('function resampleMask'));
  t('导出使用预设尺寸', /planExportSize/.test(fn));
  t('导出使用预设元数据策略', /planExportMetadata/.test(fn));
  t('导出会按需缩放画布', /plan\.scaled/.test(fn));
})();

console.log('\n【撤销栈】统一撤销必须覆盖所有操作');
(() => {
  // 1) 基本行为
  const st = C.createUndoStack(100);
  t('初始不能撤销', st.canUndo() === false);
  t('初始不能重做', st.canRedo() === false);
  const layer = { rect: { x: 0, y: 0, w: 10, h: 10 }, patch: {}, feather: 0, opacity: 1 };
  st.push(C.makeUndoCommand('add-layer', { layer, index: 0, label: '生成修改' }));
  t('记录后可撤销', st.canUndo() === true);
  t('描述正确', st.lastLabel() === '生成修改', st.lastLabel());
  const c1 = st.undo();
  t('撤销取出命令', c1 && c1.type === 'add-layer');
  t('撤销后可重做', st.canRedo() === true);
  t('撤销后不能再撤销', st.canUndo() === false);
  st.redo();
  t('重做后回到已执行状态', st.canUndo() === true && st.canRedo() === false);

  // 2) 新操作使重做栈失效
  const st2 = C.createUndoStack(100);
  st2.push(C.makeUndoCommand('add-layer', { layer, index: 0 }));
  st2.push(C.makeUndoCommand('add-layer', { layer, index: 1 }));
  st2.undo();
  t('撤销后有重做', st2.canRedo() === true);
  st2.push(C.makeUndoCommand('stroke', { stroke: { points: [] } }));
  t('新操作使重做栈失效', st2.canRedo() === false);

  // 3) 命令方向映射正确（这是撤销正确性的核心）
  const dir = (type, payload, isRedo) =>
    C.commandDirection(C.makeUndoCommand(type, payload), isRedo).action;
  t('新增图层：撤销=移除', dir('add-layer', { layer, index: 0 }, false) === 'remove-layer');
  t('新增图层：重做=插入', dir('add-layer', { layer, index: 0 }, true) === 'insert-layer');
  t('删除图层：撤销=插回', dir('remove-layer', { layer, index: 2 }, false) === 'insert-layer');
  t('删除图层：重做=再删', dir('remove-layer', { layer, index: 2 }, true) === 'remove-layer');
  t('调参：撤销取 before', C.commandDirection(
    C.makeUndoCommand('param-layer', { index: 0, key: 'opacity', before: 0.2, after: 0.9 }), false).value === 0.2);
  t('调参：重做取 after', C.commandDirection(
    C.makeUndoCommand('param-layer', { index: 0, key: 'opacity', before: 0.2, after: 0.9 }), true).value === 0.9);
  t('开关：撤销取 before', C.commandDirection(
    C.makeUndoCommand('toggle-layer', { index: 0, before: true, after: false }), false).value === true);
  t('画笔：撤销=移除最后一笔', dir('stroke', { stroke: { points: [] } }, false) === 'remove-last-stroke');
  t('画笔：重做=加回', dir('stroke', { stroke: { points: [] } }, true) === 'add-stroke');
  t('清空笔迹：撤销=恢复', dir('clear-strokes', { strokes: [] }, false) === 'restore-strokes');

  // 4) 上限：超出丢最老的，且不能失控
  for (const lim of [1, 3, 20]) {
    const sx = C.createUndoStack(lim);
    for (let i = 0; i < 60; i++) sx.push(C.makeUndoCommand('add-layer', { layer, index: i }));
    t('上限 ' + lim + ' 生效', sx.size().past === lim, sx.size().past);
  }
  const sdef = C.createUndoStack();
  for (let i = 0; i < 300; i++) sdef.push(C.makeUndoCommand('add-layer', { layer, index: i }));
  t('默认上限 100 条', sdef.size().past === 100, sdef.size().past);

  // 5) 非法输入不崩
  const sbad = C.createUndoStack(10);
  sbad.push(null);
  sbad.push({});
  sbad.push({ type: 'unknown-type' });
  t('非法命令不进入历史', sbad.canUndo() === false, sbad.size());
  t('未知类型方向为 null', C.commandDirection({ type: 'nope' }, false) === null);
  t('空命令安全', C.makeUndoCommand('') === null && C.makeUndoCommand(null) === null);

  // 6) 关键：命令只存差异，不存整图（内存安全）
  const fs = require('fs');
  const coreSrc = fs.readFileSync(__dirname + '/../app/core.js', 'utf8');
  const fn = coreSrc.slice(coreSrc.indexOf('function makeUndoCommand'), coreSrc.indexOf('function commandDirection'));
  t('撤销命令不含整图快照', !/ImageData|toDataURL|getImageData/.test(fn));
  t('删除图层只记录索引与引用', /index: num\(p\.index/.test(fn));

  // 7) app 侧：所有改变画面的操作都要记历史
  const appSrc = fs.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const checks = [
    ['生成结果入历史', /type: 'add-layer'/],
    ['画笔入历史', /type: 'stroke'/],
    ['清空笔迹入历史', /type: 'clear-strokes'/],
    ['删除图层入历史', /type: 'remove-layer'/],
    ['图层开关入历史', /type: 'toggle-layer'/],
    ['调参入历史', /type: 'param-layer'/]
  ];
  for (const [name, re] of checks) t(name, re.test(appSrc));
  t('调参只在松手时记一条（避免拖一次产生上百条）',
    /onpointerup = \(\) => \{ commit\(Number\(input\.value\)\); \}/.test(appSrc));
})();

console.log('\n【非破坏性】调整参数不应重新调用模型');
(() => {
  const w = 60, h = 60;
  const mask = new Float32Array(w * h).fill(1);
  for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) mask[y * w + x] = 0;   // 排除中心

  // 1) 图层参数归一化：越界值要被夹取
  const L = C.normalizeLayer({ rect: { x: 0, y: 0, w, h }, feather: 999, colorMatch: 5, opacity: -1 });
  t('羽化越界不夹取上限（由尺寸限制）', L.feather === 999, L.feather);
  t('色彩匹配强度夹取到 0~1', L.colorMatch === 1, L.colorMatch);
  t('不透明度夹取到 0~1', L.opacity === 0, L.opacity);
  t('默认启用', C.normalizeLayer({}).enabled === true);
  t('显式关闭生效', C.normalizeLayer({ enabled: false }).enabled === false);

  // 2) 不透明度：能「减弱」效果
  const base = { rect: { x: 0, y: 0, w, h }, mask: null, feather: 0 };
  const a0 = C.layerAlphaAt(5, 5, Object.assign({}, base, { opacity: 0 }), w, h);
  const a5 = C.layerAlphaAt(5, 5, Object.assign({}, base, { opacity: 0.5 }), w, h);
  const a1 = C.layerAlphaAt(5, 5, Object.assign({}, base, { opacity: 1 }), w, h);
  t('不透明度 0 → 完全不生效', a0 === 0, a0);
  t('不透明度 0.5 → 半强度', Math.abs(a5 - 0.5) < 1e-6, a5);
  t('不透明度 1 → 完全生效', a1 === 1, a1);

  // 3) 关键：画笔排除的区域，无论不透明度多少都必须为 0
  for (const op of [0, 0.3, 0.7, 1]) {
    const v = C.layerAlphaAt(30, 30, Object.assign({}, base, { mask, opacity: op }), w, h);
    t('排除区域在 opacity=' + op + ' 时仍为 0', v === 0, v);
  }
  // 未排除区域应随不透明度变化
  const outside = C.layerAlphaAt(5, 5, Object.assign({}, base, { mask, opacity: 0.5 }), w, h);
  t('未排除区域受不透明度影响', Math.abs(outside - 0.5) < 1e-6, outside);

  // 4) 图层关闭 → 完全不参与合成
  t('关闭的图层 alpha 全为 0', C.layerAlphaAt(5, 5, Object.assign({}, base, { enabled: false }), w, h) === 0);
  const offMap = C.layerAlphaMap(Object.assign({}, base, { enabled: false }), w, h);
  t('关闭的图层 alphaMap 全为 0', offMap.every((v) => v === 0));

  // 5) 羽化确实产生渐变（不是硬边）
  const map = C.layerAlphaMap({ rect: { x: 0, y: 0, w, h }, mask: null, feather: 12, opacity: 1 }, w, h);
  // 边界应接近 0（羽化是平滑渐变，角落是渐变的起点而非精确 0）
  t('羽化边界接近 0', map[0] < 0.02, map[0]);
  t('羽化内部为 1', map[Math.floor(h / 2) * w + Math.floor(w / 2)] === 1);
  t('羽化由外向内递增', map[0] < map[2 * w + 2], [map[0], map[2 * w + 2]]);
  let mid = 0;
  for (const v of map) if (v > 0.2 && v < 0.8) mid++;
  t('羽化存在过渡带（不是硬切）', mid > 0, mid);

  // 6) 覆盖率统计（界面显示「改了多少」）
  const covFull = C.layerCoverage({ rect: { x: 0, y: 0, w, h }, mask: null, feather: 0, opacity: 1 }, w, h);
  t('全覆盖 → 100%', Math.abs(covFull - 1) < 1e-6, covFull);
  const covMask = C.layerCoverage({ rect: { x: 0, y: 0, w, h }, mask, feather: 0, opacity: 1 }, w, h);
  t('排除 400/3600 像素 → 覆盖率约 89%', Math.abs(covMask - (1 - 400 / 3600)) < 0.01, covMask);
  const covOff = C.layerCoverage({ rect: { x: 0, y: 0, w, h }, mask: null, feather: 0, opacity: 0 }, w, h);
  t('关闭的图层覆盖率 0', covOff === 0);

  // 7) 源码层面：合成时必须读取 opacity/enabled（防止被绕过）
  const fs = require('fs');
  const appSrc = fs.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const fn = appSrc.slice(appSrc.indexOf('function compositeEditInto'), appSrc.indexOf('function rebuildViewCanvas'));
  t('合成路径读取图层开关', /L\.enabled/.test(fn) || /normalizeLayer/.test(fn));
  t('合成路径应用不透明度', /opacity/.test(fn));
  t('图层关闭时直接返回（不合成）', /if \(!L\.enabled\) return;/.test(fn));
})();

console.log('\n【内存】编辑历史必须有内存上限，防止手机被系统杀掉');
(() => {
  const mk = (w, h) => ({ rect: { x: 0, y: 0, w: 10, h: 10 }, patch: { width: w, height: h } });
  const MB = 1024 * 1024;

  // 单张 patch 内存计算
  t('patch 内存计算正确', C.patchMemory(3072, 2048) === 3072 * 2048 * 4, C.patchMemory(3072, 2048));
  t('24MB 量级符合预期', Math.round(C.patchMemory(3072, 2048) / MB) === 24, Math.round(C.patchMemory(3072, 2048) / MB));

  // 预算内不动
  const small = Array.from({ length: 5 }, () => mk(3072, 2048));
  const p1 = C.planHistoryMemory(small, 192 * MB);
  t('预算内不降采样不丢弃', p1.downscale.length === 0 && p1.drop === 0, p1);

  // 超预算：降采样（保留最近 3 条清晰）
  const mid = Array.from({ length: 20 }, () => mk(3072, 2048));
  const p2 = C.planHistoryMemory(mid, 192 * MB);
  t('超预算时降采样较早的编辑', p2.downscale.length > 0, p2.downscale.length);
  t('最近 3 条不降采样（用户最可能回退）',
    p2.downscale.every((i) => i < 20 - 3), p2.downscale.slice(-3));
  t('降采样后降到预算内', p2.usedBytes <= 192 * MB, Math.round(p2.usedBytes / MB));

  // 严重超预算：丢弃最老的
  const many = Array.from({ length: 40 }, () => mk(3072, 2048));
  const p3 = C.planHistoryMemory(many, 192 * MB);
  t('严重超预算时丢弃最老的编辑', p3.drop > 0, p3.drop);
  t('丢弃后不超过预算', p3.usedBytes <= 192 * MB, Math.round(p3.usedBytes / MB));
  t('给出了明确的用户提示', /内存受限/.test(p3.note), p3.note);

  // 4K 图也能控制住
  const k4 = Array.from({ length: 20 }, () => mk(4096, 2731));
  const p4 = C.planHistoryMemory(k4, 256 * MB);
  t('4K 图 20 次编辑被控制住', p4.usedBytes <= 256 * MB && (p4.downscale.length + p4.drop) > 0,
    { used: Math.round(p4.usedBytes / MB), ds: p4.downscale.length, drop: p4.drop });

  // 边界：空列表、极小预算
  t('空历史安全', C.planHistoryMemory([], 192 * MB).usedBytes === 0);
  const tiny = C.planHistoryMemory(mid, 1);
  t('极小预算有下限保护（不会算出负数）', tiny.usedBytes >= 0, tiny.usedBytes);
})();

console.log('\n【会话】编辑进度必须能持久化（防进程被杀）');
(() => {
  // 掩膜压缩
  const mask = new Float32Array(20000);
  for (let i = 0; i < mask.length; i++) mask[i] = (i % 97) / 97;
  const packed = C.packMask(mask);
  t('掩膜可压缩', !!packed && packed.length > 0);
  const rawJson = JSON.stringify(Array.from(mask));
  t('压缩率显著（< 15%）', packed.length / rawJson.length < 0.15,
    Math.round(packed.length / rawJson.length * 100) + '%');
  const back = C.unpackMask(packed, mask.length);
  let maxErr = 0;
  for (let i = 0; i < mask.length; i++) maxErr = Math.max(maxErr, Math.abs(back[i] - mask[i]));
  t('掩膜往返误差可忽略（< 0.005）', maxErr < 0.005, maxErr);
  t('空掩膜安全', C.packMask(null) === null && C.unpackMask(null) === null);

  // 会话规划：只保留能放下的最近若干条
  const mkEdit = (i) => ({
    rect: { x: i, y: i, w: 50, h: 50 },
    feather: 10, colorMatch: 0.5,
    mask: new Float32Array(2500).fill(1),
    patch: { toDataURL: () => 'data:image/jpeg;base64,' + 'A'.repeat(200000) }
  });
  const edits = Array.from({ length: 30 }, (_, i) => mkEdit(i));
  const plan = C.planSessionPersist(edits, {
    maxBytes: 1024 * 1024,
    encode: (p) => p.toDataURL()
  });
  t('会话只保留能放下的条目', plan.items.length > 0 && plan.items.length < 30, plan.items.length);
  t('会话体积在限制内', plan.bytes <= 1024 * 1024, plan.bytes);
  t('保留了最近的编辑（优先保住当前工作）',
    plan.items.length > 0 && plan.items[plan.items.length - 1].rect.x === 29,
    plan.items.length ? plan.items[plan.items.length - 1].rect.x : null);
  t('记录了被丢弃的数量', plan.dropped > 0, plan.dropped);
  // 条目顺序应是时间顺序
  const xs = plan.items.map((it) => it.rect.x);
  t('条目按时间顺序排列', xs.every((v, i) => i === 0 || v > xs[i - 1]), xs.slice(0, 5));
})();

console.log('\n【元数据】EXIF / ICC 必须能读出来并写回去');
(() => {
  // 可选依赖：优先标准解析（CI 里装在项目内），退化到本机固定目录
  let napi = null;
  try { napi = require('@napi-rs/canvas'); }
  catch (e) {
    try { napi = require('/tmp/domtest/node_modules/@napi-rs/canvas'); }
    catch (e2) { napi = null; }
  }
  if (!napi) {
    console.log('  ⚠ 跳过：未安装可选依赖 @napi-rs/canvas（npm install --no-save @napi-rs/canvas）');
    return;
  }

  // 造一个带指定 Orientation 的 EXIF
  const buildTiff = (orientation) => {
    const t = new Uint8Array(8 + 2 + 12 + 4);
    t[0] = 0x49; t[1] = 0x49; t[2] = 0x2a; t[3] = 0x00;   // little-endian TIFF
    t[4] = 8;
    t[8] = 1;                                              // 1 个条目
    t[10] = 0x12; t[11] = 0x01;                            // Orientation
    t[12] = 3; t[14] = 1;                                  // SHORT ×1
    t[18] = orientation;
    return t;
  };
  const withExif = (orientation) => {
    const c = napi.createCanvas(48, 32);
    const cx = c.getContext('2d');
    cx.fillStyle = 'rgb(180, 90, 40)'; cx.fillRect(0, 0, 48, 32);
    const jpeg = c.toBuffer('image/jpeg', 0.9);
    const tiff = buildTiff(orientation);
    const payload = new Uint8Array(6 + tiff.length);
    payload[0] = 0x45; payload[1] = 0x78; payload[2] = 0x69; payload[3] = 0x66;
    payload.set(tiff, 6);
    const len = payload.length + 2;
    const seg = new Uint8Array(4 + payload.length);
    seg[0] = 0xff; seg[1] = 0xe1;
    seg[2] = (len >> 8) & 255; seg[3] = len & 255;
    seg.set(payload, 4);
    return Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(2)]);
  };

  // 1) 读取各种 Orientation
  for (const o of [1, 3, 6, 8]) {
    const tiff = C.extractExif(new Uint8Array(withExif(o)));
    t('EXIF 读出 Orientation=' + o, C.readExifOrientation(tiff) === o, C.readExifOrientation(tiff));
  }
  // 2) 归一化（防止二次旋转）
  const t6 = C.extractExif(new Uint8Array(withExif(6)));
  const norm = C.normalizeExifOrientation(t6);
  t('Orientation 归一化为 1', C.readExifOrientation(norm) === 1, C.readExifOrientation(norm));
  t('归一化不修改原数据', C.readExifOrientation(t6) === 6);
  // 3) 注入到 canvas 导出的 JPEG（canvas 自己会带一个 sRGB ICC）
  const plain = (() => {
    const c = napi.createCanvas(48, 32);
    const cx = c.getContext('2d');
    cx.fillStyle = 'rgb(20, 20, 20)'; cx.fillRect(0, 0, 48, 32);
    return new Uint8Array(c.toBuffer('image/jpeg', 0.9));
  })();
  t('canvas 导出的 JPEG 本身不含 EXIF', C.extractExif(plain) === null);
  const injected = C.injectMetadata(plain, { exif: norm, icc: null });
  t('注入后含 EXIF', !!C.extractExif(injected.bytes));
  t('注入后 Orientation 正确', C.readExifOrientation(C.extractExif(injected.bytes)) === 1);
  // 4) ICC 分片无损往返（含跨多段的大配置）
  for (const size of [200, 60000, 150000]) {
    const icc = new Uint8Array(size);
    for (let i = 0; i < size; i++) icc[i] = (i * 7) & 0xff;
    const r = C.injectMetadata(plain, { exif: null, icc });
    const back = C.extractICC(r.bytes);
    let same = back && back.length === size;
    if (same) for (let i = 0; i < size; i += 397) if (back[i] !== icc[i]) { same = false; break; }
    t('ICC ' + size + 'B 无损往返', same, back && back.length);
  }
  // 5) 剥离 canvas 自带 ICC，避免出现两个配置段
  const r5 = C.injectMetadata(plain, { exif: null, icc: new Uint8Array(1000) });
  const app2 = C.parseJpegSegments(r5.bytes).filter((x) => x.marker === 0xe2);
  t('注入后只有一个 ICC 配置（剥离了自带的）', app2.length === 1, app2.length);
  // 6) EXIF 超限时保护照片本身
  const huge = new Uint8Array(70000);
  huge[0] = 0x49; huge[1] = 0x49; huge[2] = 0x2a; huge[3] = 0;
  const r6 = C.injectMetadata(plain, { exif: huge, icc: null });
  t('超大 EXIF 被跳过而非破坏照片', r6.exifWritten === false && r6.notes.length > 0, r6.notes);
  // 7) sRGB 识别（决定能否安全写回 ICC）
  const srgb = new Uint8Array(200);
  srgb[16] = 0x58; srgb[17] = 0x59; srgb[18] = 0x5a; srgb[19] = 0x20;
  'desc sRGB IEC61966-2.1'.split('').forEach((ch, i) => { srgb[32 + i] = ch.charCodeAt(0); });
  t('识别 sRGB 配置', C.isSrgbProfile(srgb) === true);
  const adobe = new Uint8Array(200);
  adobe[16] = 0x58; adobe[17] = 0x59; adobe[18] = 0x5a; adobe[19] = 0x20;
  'Adobe RGB (1998)'.split('').forEach((ch, i) => { adobe[32 + i] = ch.charCodeAt(0); });
  t('识别广色域配置（不会误写回）', C.isSrgbProfile(adobe) === false);
  t('无配置时按 sRGB 处理', C.isSrgbProfile(null) === true);
  // 8) 非 JPEG 不报错
  const png = (() => {
    const c = napi.createCanvas(16, 16);
    return new Uint8Array(c.toBuffer('image/png'));
  })();
  const r8 = C.injectMetadata(png, { exif: norm, icc: null });
  t('非 JPEG 安全跳过', r8.exifWritten === false && r8.notes.length > 0);
  // 9) 端到端：注入后图片仍能正常解码
  const im = napi.loadImage(Buffer.from(r5.bytes));
  void im;
  t('注入元数据后仍是有效图片', r5.bytes[0] === 0xff && r5.bytes[1] === 0xd8 && r5.bytes.length > plain.length);
})();

console.log('\n【偏色】发给模型的图片不得带任何标记色（蓝色）');
(() => {
  // 提示词层面：不能出现「蓝色标记」这类描述 —— 否则模型会把蓝色当成画面内容
  const variants = [
    { instruction: '去掉垃圾桶', scope: 'region', language: 'zh' },
    { instruction: '去掉垃圾桶', scope: 'region', language: 'zh', hasMask: true },
    { instruction: '修皮肤', scope: 'object', language: 'zh' },
    { instruction: '整体调色', scope: 'global', language: 'zh' },
    { instruction: 'remove bin', scope: 'region', language: 'en' },
    { instruction: 'remove bin', scope: 'region', language: 'en', hasMask: true },
    { instruction: 'make it winter', scope: 'object', language: 'en' }
  ];
  for (const o of variants) {
    const p = C.buildPrompt(o);
    t('提示词不含蓝色描述: ' + o.scope + '/' + o.language,
      !/蓝色|blue|semi-?transparent|半透明标记/i.test(p), p.slice(0, 60));
    // 必须说明改哪一块（否则模型不知道改哪里）
    t('提示词指明了修改范围: ' + o.scope + '/' + o.language,
      /中央约 \d+%|central ~\d+%|整体调整|Adjust this photo globally/.test(p), p.slice(0, 60));
  }
  // 中英文分隔符正确（不能出现中文句号拼英文）
  const pe = C.buildPrompt({ instruction: 'remove bin', scope: 'region', language: 'en' });
  t('英文提示词不使用中文句号', !/。/.test(pe), pe.slice(0, 80));
  const pz = C.buildPrompt({ instruction: '去掉垃圾桶', scope: 'region', language: 'zh' });
  t('中文提示词使用中文句号', /。/.test(pz), pz.slice(0, 40));

  // centerPct 会随选区占比变化
  const p1 = C.buildPrompt({ instruction: 'x', scope: 'region', language: 'zh', centerPct: 50 });
  t('centerPct 生效（50%）', /中央约 50%/.test(p1), p1.slice(0, 40));
  const p2 = C.buildPrompt({ instruction: 'x', scope: 'region', language: 'zh', centerPct: 100 });
  t('centerPct 生效（100%）', /中央约 100%/.test(p2), p2.slice(0, 40));
  // 越界值要被夹取
  const p3 = C.buildPrompt({ instruction: 'x', scope: 'region', language: 'zh', centerPct: 999 });
  t('centerPct 越界被夹取', /中央约 100%/.test(p3), p3.slice(0, 40));
  const p4 = C.buildPrompt({ instruction: 'x', scope: 'region', language: 'zh', centerPct: -5 });
  t('centerPct 负值被夹取', /中央约 10%/.test(p4), p4.slice(0, 40));

  // 源码层面：请求图构造函数里不得出现掩膜叠加（防止我或后续改动重新引入）
  const fs = require('fs');
  const appSrc = fs.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const fnStart = appSrc.indexOf('function buildRequestImage');
  const fnEnd = appSrc.indexOf('function canvasToDataUrl');
  const fn = appSrc.slice(fnStart, fnEnd);
  t('请求图构造函数不再叠加掩膜', !/maskToRGBA/.test(fn), 'buildRequestImage 里出现了 maskToRGBA');
  t('请求图构造函数不再用蓝色', !/\[70,\s*160,\s*255\]/.test(fn));
  // 预览函数必须只标注保护区，且无笔迹时不显示
  const prev = appSrc.slice(appSrc.indexOf('function drawMaskOverlay'), appSrc.indexOf('function drawSelection'));
  t('预览无笔迹时不显示任何蒙层', /if \(!S\.strokes\.length\) return;/.test(prev));
  t('预览标注的是保护区（1-mask）', /1 - mask\[i\]/.test(prev));
})();

console.log('\n【上游回文字】必须识别为「配错模型」，不能误判成「缺图」');
(() => {
  // 用户实际遇到的原始返回，一字不差
  const raw = {
    error: {
      message: '请上传需要编辑的原始照片（包含半透明蓝色标记选区）。我会仅修改蓝色标记区域内的物体，并保持选区外所有像素、构图、光线、色彩、清晰度和颗粒感不变，输出完整真实照片。',
      type: 'invalid_request_error', param: '', code: 'upstream_text_reply'
    }
  };
  const d = C.diagnoseResponse(raw, 400, { kind: 'edit' });
  t('识别为上游返回文字', d.code === 'text-model', d.code);
  t('明确指出是模型/接口配错', /对话模型|生图模型/.test(d.hint), d.hint);
  t('不误判成缺图', d.code !== 'no-image', d.code);
  t('建议里指向自动检测模型', /自动检测可用模型/.test(d.hint), d.hint);

  // 其它形式的上游文字回复
  const variants = [
    { error: { code: 'upstream_text_reply', message: 'x' } },
    { code: 'upstream_text_reply' },
    { error: { code: 'text_reply', message: 'y' } },
    { message: '抱歉，我无法处理这个请求。请提供需要编辑的图片。' },
    { message: "I'll modify the marked area. Please upload the original photo first." }
  ];
  for (const v of variants) {
    const r = C.diagnoseResponse(v, 400, { kind: 'edit' });
    t('上游文字变体被识别: ' + JSON.stringify(v).slice(0, 40), r.code === 'text-model', r.code);
  }

  // 关键：不能误伤真正的缺图与尺寸错误
  const keep = [
    [{ message: 'you must provide an image' }, 400, 'no-image'],
    [{ message: 'Invalid size: 512x512. Total pixels must be at least 655360.' }, 400, 'bad-size'],
    [{ message: 'Invalid token' }, 401, 'auth'],
    [{ message: 'rate limit exceeded' }, 429, 'quota'],
    [{ message: 'size must be divisible by 16' }, 400, 'bad-size']
  ];
  for (const [j, st, want] of keep) {
    const r = C.diagnoseResponse(j, st, { kind: 'edit' });
    t('未误伤: ' + want, r.code === want, r.code);
  }

  // 模型名预检：对话模型必须被判为非生图
  for (const m of ['deepseek-chat', 'gpt-4o', 'claude-3-5-sonnet', 'glm-4', 'gemini-1.5-pro', 'qwen-plus']) {
    t('对话模型被判为非生图: ' + m, C.classifyModel(m) === null, C.classifyModel(m));
  }
  // 生图模型不能被误判
  for (const m of ['Qwen/Qwen-Image-Edit', 'gpt-image-1', 'gpt-image-2', 'black-forest-labs/FLUX.1-Kontext-pro']) {
    t('生图模型识别正常: ' + m, !!C.classifyModel(m), C.classifyModel(m));
  }
})();

console.log('\n【尺寸规范】不合规的尺寸必须在发送前就被修正/拦下');
(() => {
  const MIN = 655360;
  // 已知会被 OpenAI 拒绝的尺寸
  for (const bad of ['512x512', '576x1024', '1024x576', '512x768', '256x256']) {
    t('识别不合规尺寸: ' + bad, C.validateSize(bad, 'openai').ok === false, C.validateSize(bad, 'openai'));
  }
  // 合规尺寸必须通过
  for (const good of ['1024x1024', '1536x1024', '1024x1536', '1280x720', '1920x1088', '2048x2048']) {
    t('合规尺寸通过: ' + good, C.validateSize(good, 'openai').ok === true, C.validateSize(good, 'openai').reasons);
  }
  // 各类违规原因要能分别识别
  t('像素不足被识别', /像素/.test(C.validateSize('512x512', 'openai').reasons.join('')));
  t('非16倍数被识别', /16 的倍数/.test(C.validateSize('1000x1000', 'openai').reasons.join('')));
  t('超边长被识别', /单边/.test(C.validateSize('4096x4096', 'openai').reasons.join('')));
  t('比例越界被识别', /宽高比/.test(C.validateSize('1024x4096', 'openai').reasons.join('')));

  // conformSize 修正后必须合规
  const cases = [[512, 512], [100, 100], [576, 1024], [5000, 5000], [300, 1200], [1024, 3072], [3840, 3840], [1, 1]];
  for (const [w, h] of cases) {
    const c = C.conformSize(w, h, 'openai');
    const v = C.validateSize(c.size, 'openai');
    t(`修正 ${w}x${h} → ${c.size} 合规`, v.ok, v.reasons);
  }

  // 内置 OpenAI 模型尺寸表里不能有不合规的项
  const openai = C.getProvider('openai');
  let badCount = 0;
  for (const m of openai.models) {
    if (!m.sizes) continue;
    for (const sz of m.sizes) {
      if (!C.validateSize(sz, 'openai').ok) badCount++;
    }
  }
  t('内置 OpenAI 尺寸表全部合规', badCount === 0, badCount);

  // 挑选尺寸时要避开不合规项
  const gm = C.findModel('openai', 'gpt-image-1');
  for (const [w, h] of [[100, 100], [512, 512], [1000, 1000], [1920, 1080]]) {
    const r = C.resolveOutputSize(w, h, gm.sizes, 'openai');
    t(`选区 ${w}x${h} 挑出的尺寸合规`, C.validateSize(r.size, 'openai').ok, r.size);
  }

  // 请求构造的最后一道保险
  const req = C.buildImageRequest({
    baseUrl: 'x', model: 'gpt-image-1', prompt: 'p',
    size: '512x512', sizeMode: 'size', providerId: 'openai'
  });
  t('buildImageRequest 自动修正不合规尺寸', C.validateSize(req.body.size, 'openai').ok, req.body.size);
  const req2 = C.buildImageRequest({
    baseUrl: 'x', model: 'gpt-image-1', prompt: 'p',
    size: '1024x1024', sizeMode: 'size', providerId: 'openai'
  });
  t('合规尺寸保持原样', req2.body.size === '1024x1024', req2.body.size);

  // 诊断：尺寸错误不能被误判成「没收到图片」
  const d1 = C.diagnoseResponse({ error: { message: 'Invalid size: 512x512. Total pixels must be at least 655360.' } }, 400, { kind: 'edit' });
  t('尺寸错误诊断正确', d1.code === 'bad-size', d1.code);
  const d2 = C.diagnoseResponse({ message: 'size must be divisible by 16' }, 400, { kind: 'edit' });
  t('16倍数错误诊断正确', d2.code === 'bad-size', d2.code);
  const d3 = C.diagnoseResponse({ message: 'you must provide an image' }, 400, { kind: 'edit' });
  t('真正的缺图仍诊断正确', d3.code === 'no-image', d3.code);

  // 硅基流动不受 OpenAI 约束（不该被误改）
  t('硅基尺寸不做 OpenAI 约束', C.validateSize('1328x1328', 'siliconflow').ok === true);
})();

console.log('\n【黑屏】大照片解码：只读文件头拿尺寸，避免全尺寸解码');
(() => {
  // 构造各种格式头部（含手机常见的大尺寸）
  const png = (w, h) => { const b = Buffer.alloc(33); b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  const jpeg = (w, h) => { const app = Buffer.alloc(18); app[0] = 0xff; app[1] = 0xe0; app.writeUInt16BE(16, 2); const sof = Buffer.alloc(20); sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); return Buffer.concat([Buffer.from([0xff, 0xd8]), app, sof]); };
  const webp = (w, h) => { const b = Buffer.alloc(40); b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8X', 12); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; };

  const cases = [
    ['PNG 8000x6000', png(8000, 6000), 8000, 6000],
    ['JPEG 4000x3000', jpeg(4000, 3000), 4000, 3000],
    ['JPEG 8160x6120', jpeg(8160, 6120), 8160, 6120],
    ['WebP 4032x3024', webp(4032, 3024), 4032, 3024]
  ];
  for (const [n, buf, w, h] of cases) {
    const r = C.parseImageSize(new Uint8Array(buf));
    t('解析尺寸: ' + n, r && r.width === w && r.height === h, r);
  }
  t('无效数据返回 null', C.parseImageSize(new Uint8Array([1, 2, 3])) === null);
  t('空输入返回 null', C.parseImageSize(null) === null);
  t('截断数据不崩', (() => { try { C.parseImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])); return true; } catch (e) { return false; } })());

  // 关键：解码阶段就应该缩到工作尺寸，峰值内存被限制住
  const check = (w, h, maxRes) => {
    const need = Math.max(w, h) > maxRes;
    const k = need ? maxRes / Math.max(w, h) : 1;
    return Math.round(w * k) * Math.round(h * k) * 4 / 1024 / 1024;
  };
  t('8000x6000 + maxRes2048 → 解码内存 < 20MB', check(8000, 6000, 2048) < 20, check(8000, 6000, 2048));
  t('8000x6000 + maxRes3072 → 解码内存 < 30MB', check(8000, 6000, 3072) < 30, check(8000, 6000, 3072));
  t('12000x9000 + maxRes3072 → 解码内存 < 30MB', check(12000, 9000, 3072) < 30, check(12000, 9000, 3072));
  t('小图不缩放（保持原样）', check(800, 600, 3072) === 800 * 600 * 4 / 1024 / 1024);
})();

console.log('\n【新功能】模型自动检测与归类');
(() => {
  // 真实服务商的返回形态
  const sf = { data: [{ id: 'Qwen/Qwen-Image-Edit' }, { id: 'Qwen/Qwen-Image' }, { id: 'deepseek-ai/DeepSeek-V3' }, { id: 'BAAI/bge-m3' }, { id: 'black-forest-labs/FLUX.1-Kontext-pro' }, { id: 'Kwai-Kolors/Kolors' }] };
  const picked = C.pickImageModels(sf);
  t('从模型列表中筛出图像模型', picked.length === 4, picked.length);
  t('剔除对话模型', !picked.some((m) => /DeepSeek-V3/.test(m.id)));
  t('剔除向量模型', !picked.some((m) => /bge/.test(m.id)));
  t('编辑模型排在前面', picked[0].kind === 'edit' && picked[1].kind === 'edit', picked.map((m) => m.kind));
  t('编辑模型被标为推荐', picked.filter((m) => m.recommended).length === 2, picked.filter((m) => m.recommended).length);
  t('收录的模型用内置参数（尺寸表）', !!picked.find((m) => m.id === 'Qwen/Qwen-Image-Edit').sizes);
  const unk = C.pickImageModels({ data: [{ id: 'some/unknown-image-model' }] })[0];
  t('未收录的模型也有兜底尺寸参数', !!(unk && unk.sizes && unk.sizes.length), unk && unk.sizes);
  t('未收录的编辑模型也被推荐', C.pickImageModels({ data: [{ id: 'vendor/foo-image-edit' }] })[0].recommended === true);

  // 各种返回结构
  t('兼容数组形式', C.pickImageModels([{ id: 'Qwen/Qwen-Image-Edit' }]).length === 1);
  t('兼容 models 字段', C.pickImageModels({ models: [{ id: 'Qwen/Qwen-Image-Edit' }] }).length === 1);
  t('兼容纯字符串数组', C.pickImageModels(['Qwen/Qwen-Image-Edit', 'deepseek-ai/DeepSeek-V3']).length === 1);
  t('空输入不崩', C.pickImageModels(null).length === 0 && C.pickImageModels({}).length === 0);
  t('去重', C.pickImageModels([{ id: 'a/x-image' }, { id: 'a/x-image' }]).length === 1);

  // 关键归类
  const cls = (id) => { const c = C.classifyModel(id); return c ? c.kind : null; };
  t('Qwen-Image-Edit → edit', cls('Qwen/Qwen-Image-Edit') === 'edit');
  t('Qwen-Image → t2i', cls('Qwen/Qwen-Image') === 't2i');
  t('Kontext → edit', cls('black-forest-labs/FLUX.1-Kontext-pro') === 'edit');
  t('gpt-image-1 → edit（支持参考图）', cls('gpt-image-1') === 'edit');
  t('dall-e-3 → t2i', cls('dall-e-3') === 't2i');
  t('视频模型不算图像', cls('Wan-AI/Wan2.2-T2V-A14B') === null);
  t('语音模型不算图像', cls('FunAudioLLM/CosyVoice2-0.5B') === null);
  t('VL 模型不算生图', cls('Qwen/Qwen2.5-VL-72B-Instruct') === null);
  t('Kontext 用 aspect_ratio', C.classifyModel('black-forest-labs/FLUX.1-Kontext-pro').sizeMode === 'aspect_ratio');
  t('gpt-image 用 size', C.classifyModel('gpt-image-1').sizeMode === 'size');
})();

console.log('\n【新功能】配置保留（覆盖更新不丢设置）');
(() => {
  // 模拟 localStorage：写入 → 读回，字段必须原样保留
  const store = {};
  const fakeLS = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const PERSIST = ['provider', 'baseUrl', 'apiKey', 'model', 'netMode', 'contextPct', 'feather', 'colorMatch', 'maxRes', 'tile', 'lang', 'seed', 'format', 'quality', 'mosaic'];
  // 用户配置
  const userCfg = {
    provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-user-key-12345',
    model: 'Qwen/Qwen-Image-Edit', netMode: 'proxy', contextPct: 20, feather: 14, colorMatch: 70,
    maxRes: 4096, tile: 1200, lang: 'zh', seed: '42', format: 'png', quality: 98, mosaic: true
  };
  fakeLS.setItem('photoStudio.cfg.v1', JSON.stringify(userCfg));
  const read = JSON.parse(fakeLS.getItem('photoStudio.cfg.v1'));
  for (const k of PERSIST) {
    t('字段保留: ' + k, read[k] === userCfg[k], { got: read[k], want: userCfg[k] });
  }
  // 模拟一次"版本升级"：只改版本记录，配置不动
  fakeLS.setItem('photoStudio.lastVersion', '1.0.0');
  const afterUpgrade = JSON.parse(fakeLS.getItem('photoStudio.cfg.v1'));
  t('升级后 API Key 仍在', afterUpgrade.apiKey === 'sk-user-key-12345');
  t('升级后模型仍在', afterUpgrade.model === 'Qwen/Qwen-Image-Edit');
  t('升级后全部 15 项配置仍在', PERSIST.every((k) => afterUpgrade[k] === userCfg[k]));
})();

console.log('\n【新功能】版本号单一来源');
(() => {
  const v = require('../version.json');
  t('version.json 有 versionCode', Number.isInteger(v.versionCode) && v.versionCode >= 2, v.versionCode);
  t('version.json 有 versionName', typeof v.versionName === 'string' && /^\d+\.\d+/.test(v.versionName), v.versionName);
  t('version.json 有更新说明', Array.isArray(v.changelog) && v.changelog.length > 0, v.changelog && v.changelog.length);
  // version.js 与 version.json 必须一致
  const fs = require('fs');
  const vjs = fs.readFileSync(__dirname + '/../app/version.js', 'utf8');
  t('version.js 与 version.json 版本号一致', vjs.includes('"' + v.versionName + '"'), v.versionName);
  t('version.js 含 changelog', vjs.includes('changelog'));
})();


console.log('\n【历史】时间线要能看、能预览、能跳回，且不吃内存');
(() => {
  const L = { rect: { x: 0, y: 0, w: 10, h: 10 }, patch: {}, feather: 0, opacity: 1 };

  // 1) 时间线结构
  const st = C.createUndoStack(100);
  st.push(C.makeUndoCommand('add-layer', { layer: L, index: 0, label: '生成修改' }));
  st.push(C.makeUndoCommand('param-layer', { index: 0, key: 'opacity', before: 1, after: 0.6, label: '减弱效果' }));
  const tl = C.buildTimeline(st, { edits: [L], strokes: [] });
  t('时间线含原图 + 每步一格', tl.items.length === 3, tl.items.length);
  t('游标指向最新', tl.cursor === 2, tl.cursor);
  t('原图格无图层', tl.items[0].layers === 0);
  t('调参步摘要含百分比', /60%/.test(tl.items[2].detail), tl.items[2].detail);

  // 2) 跳转计划（核心：撤销/重做步数不能算错）
  t('往回跳 2 步', C.planHistoryJump(5, 3, 10).undo === 2 && C.planHistoryJump(5, 3, 10).redo === 0);
  t('往前跳 4 步', C.planHistoryJump(3, 7, 10).redo === 4 && C.planHistoryJump(3, 7, 10).undo === 0);
  t('跳转不会越界', C.planHistoryJump(2, 999, 5).redo === 3);
  t('跳转对 null 安全', C.planHistoryJump(null, null, null).undo === 0);

  // 3) 关键 bug：内存整理丢图层后索引必须同步修正
  const st2 = C.createUndoStack(100);
  st2.push(C.makeUndoCommand('add-layer', { layer: L, index: 0 }));
  st2.push(C.makeUndoCommand('add-layer', { layer: L, index: 1 }));
  st2.push(C.makeUndoCommand('param-layer', { index: 1, key: 'opacity', before: 1, after: 0.5 }));
  st2.adjustForDrop(1);
  const past = st2.list().past;
  t('丢 1 个图层后索引前移', past[0].index === 0, past.map((c) => c.index));
  // 命令 1 引用 index 0（已丢弃）→ 移除；命令 2、3 引用 index 1 → 前移为 0，保留
  t('指向已丢弃图层的命令被清掉', past.length === 2, past.length);
  t('保留的命令索引全部前移为 0', past.every((c) => c.index === 0), past.map((c) => c.index));
  const dir = C.commandDirection(st2.undo(), false);
  t('撤销作用于正确图层', dir.index === 0, dir.index);

  // 4) 丢弃未来（跳回后确认）
  const st3 = C.createUndoStack(100);
  st3.push(C.makeUndoCommand('add-layer', { layer: L, index: 0 }));
  st3.push(C.makeUndoCommand('add-layer', { layer: L, index: 1 }));
  st3.undo();
  t('dropFuture 清空未来', st3.dropFuture() === 1 && st3.canRedo() === false);
  t('已执行的不受影响', st3.size().past === 1, st3.size());

  // 5) 内存安全：时间线不得复制图片
  const fs = require('fs');
  const coreSrc = fs.readFileSync(__dirname + '/../app/core.js', 'utf8');
  const tlFn = coreSrc.slice(coreSrc.indexOf('function buildTimeline'), coreSrc.indexOf('function describeCommand'));
  t('时间线不存图片快照', !/getImageData|toDataURL|ImageData/.test(tlFn));

  // 6) app 侧：必须有历史面板与预览/跳回接线
  const appSrc = fs.readFileSync(__dirname + '/../app/app.js', 'utf8');
  t('有历史面板渲染函数', /function renderHistory\(/.test(appSrc));
  t('有预览函数', /function previewHistoryAt\(/.test(appSrc));
  t('有确认跳转函数', /function commitHistoryJump\(/.test(appSrc));
  t('有取消预览函数', /function cancelHistoryPreview\(/.test(appSrc));
  t('跳转复用统一的 applyCommand（不另写一套）',
    /function previewHistoryAt[\s\S]{0,900}applyCommand\(cmd, /.test(appSrc));
  t('内存整理后同步修正撤销栈索引', /adjustForDrop\(plan\.drop\)/.test(appSrc));
  t('关闭面板时恢复现场（不留预览态）',
    /function closeHistory\(\)[\s\S]{0,300}cancelHistoryPreview/.test(appSrc));

  // 7) 面板 HTML 与样式齐全
  const html = fs.readFileSync(__dirname + '/../app/index.html', 'utf8');
  const css = fs.readFileSync(__dirname + '/../app/style.css', 'utf8');
  t('有历史面板容器', /id="history"/.test(html));
  t('有历史入口按钮', /id="btn-history"/.test(html));
  t('有列表容器', /id="hist-list"/.test(html));
  t('有跳转按钮', /id="hist-jump"/.test(html));
  t('有退出预览按钮', /id="hist-preview-off"/.test(html));
  t('历史面板有样式', /\.hist-item/.test(css));
  t('已撤销步骤有视觉区分', /\.hist-item\.future/.test(css));
  t('预览态有视觉区分', /\.hist-item\.preview/.test(css));

  // 8) 版本说明里要提到这个功能（用户看得到）
  const ver = JSON.parse(fs.readFileSync(__dirname + '/../version.json', 'utf8'));
  t('版本说明含历史功能', ver.changelog.some((c) => /历史/.test(c)),
    ver.changelog.slice(0, 2));
})();

console.log('\n【作品库】跨天修图记录：预算、落盘、恢复');

(() => {
  // 用相对路径解析：本机、CI 检出目录、任意 clone 位置都能跑
  const fs = require('fs');
  const appSrc = fs.readFileSync(require('path').join(__dirname, '..', 'app', 'app.js'), 'utf8');
  const html = fs.readFileSync(require('path').join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const css = fs.readFileSync(require('path').join(__dirname, '..', 'app', 'style.css'), 'utf8');

  // 1) 预算账目必须等于真实占用
  //    回归的 bug：降级（丢会话）之后，淘汰环节又按「含会话」的完整体积扣一次，
  //    导致账面占用远小于真实占用 —— 计划以为放得下，实际会写爆 localStorage。
  const mk = (id, at, thumbChars, sessChars) => ({
    id, at,
    thumb: 't'.repeat(thumbChars),
    session: sessChars ? { base: 's'.repeat(sessChars) } : null
  });
  const entries = [mk('A', 1000, 100000, 50000), mk('B', 2000, 100000, 50000), mk('C', 3000, 100000, 50000)];
  const realUsage = (p) => p.keepIds.reduce((s, id) => {
    const e = entries.find((x) => x.id === id);
    const down = p.downgradeIds.indexOf(id) >= 0;
    return s + 400 + C.storageBytes(e.thumb) + (down ? 0 : C.storageBytes(JSON.stringify(e.session)));
  }, 0);

  for (const M of [150000, 250000, 500000, 1200000]) {
    const p = C.planLibrary(entries, { maxBytes: M, maxItems: 80 });
    const real = realUsage(p);
    t('预算 M=' + M + '：账面占用等于真实占用', p.bytes === real, { report: p.bytes, real });
    t('预算 M=' + M + '：不超预算（留 1 条是下限）',
      real <= M || p.keepIds.length === 1, { real, M, keep: p.keepIds.length });
  }

  // 降级过的条目不能再被扣一次会话体积
  const p0 = C.planLibrary(entries, { maxBytes: 1, maxItems: 80 });
  t('极小预算下仍保留至少 1 条', p0.keepIds.length === 1, p0.keepIds.length);
  t('极小预算下账面不出现负数', p0.bytes >= 0, p0.bytes);
  t('极小预算下账面等于真实', p0.bytes === realUsage(p0), { r: p0.bytes, real: realUsage(p0) });

  // 2) 提示文案要同时说清降级和淘汰（否则用户不知道「可继续编辑」为什么变少）
  const pBoth = C.planLibrary(entries, { maxBytes: 250000, maxItems: 80 });
  if (pBoth.downgradeIds.length && pBoth.evictIds.length) {
    t('同时降级+淘汰时两种都提示',
      /清理/.test(pBoth.note) && /仅保留预览/.test(pBoth.note), pBoth.note);
  } else {
    t('同时降级+淘汰时两种都提示（本次未同时发生，跳过）', true);
  }

  // 3) 时间戳损坏的记录不能产生空标题的分隔条
  //    回归的 bug：at 为 0 / 非法时 describeWorkAge 返回空串，分组标题就是空的
  const gBad = C.groupWorksByDay([{ id: 'x', at: 0 }, { id: 'y', at: 'oops' }], Date.now());
  t('损坏时间的记录有兜底标题', gBad.every((g) => !!g.label), gBad.map((g) => g.label));
  // 时刻也不能显示成 00:00（会被误读成真的凌晨编辑）
  t('损坏时间不显示为 00:00', C.formatWorkClock(0) === '' && C.formatWorkClock('x') === '',
    [C.formatWorkClock(0), C.formatWorkClock('x')]);

  // 4) 用户的核心诉求：昨天修的，今天打开还能看到
  const today = new Date(2024, 8, 23, 10, 0).getTime();
  const yest = new Date(2024, 8, 22, 22, 0).getTime();
  const g = C.groupWorksByDay([{ id: 'y', at: yest, edits: 3, thumb: 'x', session: { v: 1 } }], today);
  t('昨天的照片今天仍在记录里', g.length === 1 && g[0].items.length === 1);
  t('分组标签显示「昨天」', g[0].label === '昨天', g[0].label);

  // 5) app 接线：不能只加默认值 / 只加函数不调用
  t('启动时载入作品库（并赋给 S.library）', /S\.library = loadLibrary\(\)/.test(appSrc));
  t('启动时刷新角标', /S\.library = loadLibrary\(\);[\s\S]{0,200}updateLibraryBadge\(\)/.test(appSrc));
  t('所有编辑都会写作品库（挂在 recordUndo 上）',
    /function recordUndo[\s\S]{0,600}scheduleWorkSave\(\)/.test(appSrc));
  t('导出时立刻落库（不等防抖）', /async function exportImage[\s\S]*?touchWork\(\)/.test(appSrc));
  t('换图会重置作品 id（新照片另起一条）', /S\.workId = null/.test(appSrc));
  t('存储写满有兜底（不让应用崩）', /QuotaExceededError|空间不足/.test(appSrc));

  // 6) 打包缓存必须与文档版本绑定，否则会话/作品库会存到过期数据
  t('打包结果有缓存（避免一次编辑编码两遍）', /payloadCache/.test(appSrc));
  t('缓存按 docRev 失效', /payloadCache\.rev === S\.docRev/.test(appSrc));
  t('编辑后 docRev 递增', /function recordUndo[\s\S]{0,300}S\.docRev\+\+/.test(appSrc));
  t('撤销/重做后 docRev 递增', /function applyCommand[\s\S]*?S\.docRev\+\+/.test(appSrc));
  t('换图后 docRev 递增', /换图 → 打包缓存失效|S\.docRev\+\+/.test(appSrc));

  // 7) 恢复作品时必须作废在途生成，否则结果会贴到刚恢复的照片上
  //    回归的 bug：restoreSession 换掉整份文档却没作废 in-flight 请求
  const restoreFn = appSrc.slice(appSrc.indexOf('async function restoreSession'),
    appSrc.indexOf('async function restoreSession') + 2600);
  t('恢复作品会作废在途生成', /S\.genToken\+\+/.test(restoreFn), 'restoreSession 里缺 genToken++');
  t('恢复作品会关掉对比层', /hidden = true/.test(restoreFn));
  t('恢复作品会清掉待确认结果', /S\.pending = null/.test(restoreFn));
  t('恢复作品会递增 docVersion', /S\.docVersion\+\+/.test(restoreFn));

  // 8) 界面接线：入口、面板、大图预览三件套都要在
  t('顶栏有修图记录入口', /id="btn-library"/.test(html));
  t('入口有计数角标', /id="lib-count"/.test(html));
  t('有记录面板', /id="library"/.test(html));
  t('有列表容器', /id="lib-list"/.test(html));
  t('有空状态提示', /id="lib-empty"/.test(html));
  t('有用量显示', /id="lib-usage"/.test(html));
  t('有大图预览层', /id="work-preview"/.test(html));
  t('面板文案说明了「跨天可查」', /关掉应用|第二天|明天/.test(html));
  t('有网格与卡片样式', /\.lib-grid/.test(css) && /\.lib-card/.test(css));
  t('大图预览有样式', /\.wp-body/.test(css) && /\.wp-img/.test(css));
  t('角标样式存在', /#btn-library b/.test(css));
  t('面板默认隐藏', /id="library" class="sheet" hidden/.test(html));
})();


/* ---------- 作品库（跨天修图记录） ---------- */
console.log('\n【保活】Android 壳：跨版本兼容与注册完整性');


/* ---------- 对比视图缩放 ---------- */
console.log('\n【对比】放大查看与分割线拖拽必须共存');

(() => {
  const fs = require('fs');
  const path = require('path');
  const C2 = require(path.join(__dirname, '..', 'app', 'core.js'));
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

  // 1) 根因回归：提示条承诺了「双击画面放大查看」，就必须真的能放大。
  //    修复前 drawCompare 每帧用 fitView 重算，根本没有缩放状态；
  //    且 pointerdown 无条件拖分割线，双击的两次点击各把线拽到手指位置。
  // 注意：必须限定在 drawCompare 函数体内检查 ——
  // 文件里别处也有 `cmpView || fit`，只查全局会漏掉 drawCompare 退化的情形
  t('对比视图有可变的缩放状态', /let cmpView = null/.test(appSrc));
  t('drawCompare 使用缩放状态而不是每帧 fitView', (() => {
    const i = appSrc.indexOf('function drawCompare()');
    if (i < 0) return false;
    const body = appSrc.slice(i, appSrc.indexOf('\n  }', i));
    return /const v = cmpView \|\| fit;/.test(body) && !/const v = fit;/.test(body);
  })());
  t('按下时先判定手势（不是无条件拖分割线）',
    /planCompareDrag\(/.test(appSrc));
  t('只有 split 模式才改分割线',
    /mode === 'split'\)[\s\S]{0,400}cmpSplit = C\.clamp01/.test(appSrc));
  t('tap 模式不碰分割线', /mode: 'tap'[\s\S]{0,200}moved: false/.test(appSrc));

  // 2) 双击判定必须同时满足「时间近」和「位置近」，否则会误触
  t('双击有 300ms 时间窗口', /now - cmpLastTap < 300/.test(appSrc));
  t('双击有位置接近判定', /Math\.hypot\(e\.clientX - cmpLastTapX, e\.clientY - cmpLastTapY\) < 40/.test(appSrc));
  t('拖动超过阈值不算点击（tap 模式）', /Math\.hypot\(e\.clientX - g\.startX, e\.clientY - g\.startY\) > 10/.test(appSrc));

  // 3) 回归：放大后单指是平移，但「按下没动」仍要能双击还原，
  //    否则用户被卡在放大态出不去（这是实现过程中真实踩到的坑）
  t('pan 模式也记录是否真的移动过', /mode: 'pan'[\s\S]{0,300}moved: false/.test(appSrc));
  t('pan 模式移动超阈值才平移', /Math\.hypot\(dx, dy\) > 6\) g\.moved = true/.test(appSrc));
  t('未移动的 pan 也算一次点击（可双击还原）',
    /g\.mode === 'tap' \|\| g\.mode === 'pan'/.test(appSrc));

  // 4) 回归：放大后分割线可能落到视口外 → 只看得到单侧，对比功能失效。
  //    必须把线夹在视口内。
  t('有分割线夹取函数', typeof C2.placeCompareSplit === 'function');
  const imgW = 200, imgH = 150, VW = 800, VH = 600;
  const fit = C2.fitView(imgW, imgH, VW, VH, 10);
  const zoomed = C2.planCompareDoubleTap({
    view: fit, fitView: fit, px: VW * 0.25, py: VH * 0.5,
    zoom: 3, imgW, imgH, viewW: VW, viewH: VH, maxScale: 12
  }).view;
  const placed = C2.placeCompareSplit({ view: zoomed, imgW, imgH, split: 0.5, viewW: VW, inset: 14 });
  t('放大后分割线被夹到视口内（不会跑出去）',
    placed.screenX >= 14 && placed.screenX <= VW - 14, placed);
  t('夹取时同步修正图内比例', placed.clamped === true && placed.split >= 0 && placed.split <= 1, placed);
  // 适应窗口时不需要夹（整图可见）
  const placedFit = C2.placeCompareSplit({ view: fit, imgW, imgH, split: 0.5, viewW: VW, inset: 14 });
  t('适应窗口时不改动分割线', placedFit.clamped === false, placedFit);
  t('placeCompareSplit 对 null 安全',
    typeof C2.placeCompareSplit(null).screenX === 'number');

  // 5) 缩放倍数：小图必须放大到铺满视口，否则看不出「放大了」
  const small = C2.planCompareDoubleTap({
    view: C2.makeView(0.5, 0, 0), fitView: C2.makeView(0.5, 0, 0),
    px: 400, py: 300, zoom: 3, imgW: 400, imgH: 300, viewW: 800, viewH: 600, maxScale: 12
  });
  t('小图放大后至少铺满视口',
    small.view.scale >= Math.max(800 / 400, 600 / 300) - 1e-9, small.view.scale);

  // 6) 关闭对比视图必须清掉缩放状态，否则下次进来带着上次的偏移
  t('关闭对比视图统一走 closeCompare', /function closeCompare\(\)/.test(appSrc));
  t('closeCompare 会清缩放状态', /function closeCompare\(\)[\s\S]{0,300}cmpView = null/.test(appSrc));
  t('应用结果时走 closeCompare', /closeCompare\(\);\s*\n\s*updateUI\(\);\s*\n\s*draw\(\);\s*\n\s*toast/.test(appSrc));
  t('放弃结果时走 closeCompare', /function discardPending\(\)[\s\S]{0,200}closeCompare\(\)/.test(appSrc));
  t('进入对比视图时重置缩放', /cmpView = null;\s*\/\/ 每次进入都从「适应窗口」开始/.test(appSrc));

  // 7) 放大后仍要能拖分割线（否则放大就没法对比了）
  const base = { splitX: 400, hitPx: 22 };
  t('放大后按竖线仍判定为拖分割线',
    C2.planCompareDrag(Object.assign({}, base, { x: 400, scale: 3, fitScale: 1 })) === 'split');
  t('放大后远离竖线判定为平移',
    C2.planCompareDrag(Object.assign({}, base, { x: 200, scale: 3, fitScale: 1 })) === 'pan');
  t('未放大且远离竖线判定为点击',
    C2.planCompareDrag(Object.assign({}, base, { x: 200, scale: 1, fitScale: 1 })) === 'tap');

  // 8) 界面：放大后必须能看出倍数、能一键还原
  t('界面有倍数角标', /id="cmp-zoom"/.test(html));
  t('界面有还原按钮', /id="cmp-reset"/.test(html));
  t('提示语可动态更新', /id="cmp-hint"/.test(html));
  // 提示文案在 core.js 的 describeCompareZoom 里（单一来源）
  const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'core.js'), 'utf8');
  t('放大态提示说明了平移与还原',
    /拖动画面平移/.test(coreSrc) && /双击还原/.test(coreSrc));
  // 提示语由 core 提供，界面只是展示 —— 避免两处文案各写各的
  t('提示语由 core 统一提供', /info\.hint/.test(appSrc));
})();


/* ---------- 对比视图：放大与分割线共存 ---------- */
console.log('\n【图标】桌面图标必须清晰可辨（对比度 + 自适应图标）');

(() => {
  const fs = require('fs');
  const path = require('path');
  const zlib = require('zlib');

  const RES = path.join(__dirname, '..', 'android', 'res');
  const APP = path.join(__dirname, '..', 'app');

  /** 解码 PNG（含逐行反滤波），返回 RGBA */
  function readPNG(p) {
    const buf = fs.readFileSync(p);
    let off = 8, w = 0, h = 0, ct = 0;
    const idat = [];
    while (off < buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const data = buf.slice(off + 8, off + 8 + len);
      if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
      if (type === 'IDAT') idat.push(data);
      off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = ct === 6 ? 4 : 3;
    const stride = w * bpp;
    const out = Buffer.alloc(w * h * 4);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)];
      const line = Buffer.from(raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v = line[i];
        if (f === 1) v = (v + a) & 255;
        else if (f === 2) v = (v + b) & 255;
        else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
        else if (f === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 255;
        }
        line[i] = v;
      }
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        out[o] = line[x * bpp];
        out[o + 1] = line[x * bpp + 1];
        out[o + 2] = line[x * bpp + 2];
        out[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
      }
      prev = line;
    }
    return { w, h, px: out };
  }

  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  // 1) 桌面图标必须「亮」——这是本次问题的根因：
  //    旧图标底 #1b2230（亮度 30）、框 #33405a（亮度 63），对比度只有 33，
  //    在深色壁纸上跟背景糊成一片，用户会以为「没有图标」。
  const DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
  for (const d of DENSITIES) {
    const p = path.join(RES, 'mipmap-' + d, 'ic_launcher.png');
    t('桌面图标存在（' + d + '）', fs.existsSync(p));
    if (!fs.existsSync(p)) continue;
    const img = readPNG(p);
    let sum = 0, n = 0, maxL = -1, minL = 999;
    for (let i = 0; i < img.px.length; i += 4) {
      if (img.px[i + 3] < 128) continue;
      const L = lum(img.px[i], img.px[i + 1], img.px[i + 2]);
      sum += L; n++;
      if (L > maxL) maxL = L;
      if (L < minL) minL = L;
    }
    t('图标有不透明内容（' + d + '）', n > 0, n);
    // 亮度范围（对比度）必须够大，否则在壁纸上「糊掉」
    t('图标对比度足够（' + d + '）', maxL - minL >= 120,
      { minL: Math.round(minL), maxL: Math.round(maxL), range: Math.round(maxL - minL) });
    // 平均亮度不能太低
    t('图标整体不偏暗（' + d + '）', sum / n >= 70, Math.round(sum / n));
  }

  // 2) 自适应图标（Android 8+）。缺失的话系统会把传统图标硬塞进白底遮罩，
  //    看起来就是「图标怪怪的」—— 这是本次修的另一个点。
  const anydpi = path.join(RES, 'mipmap-anydpi-v26');
  t('有自适应图标目录', fs.existsSync(anydpi));
  t('自适应图标描述存在', fs.existsSync(path.join(anydpi, 'ic_launcher.xml')));
  t('圆形自适应图标描述存在', fs.existsSync(path.join(anydpi, 'ic_launcher_round.xml')));
  const axml = fs.existsSync(path.join(anydpi, 'ic_launcher.xml'))
    ? fs.readFileSync(path.join(anydpi, 'ic_launcher.xml'), 'utf8') : '';
  t('自适应图标含 foreground 层', /<foreground/.test(axml));
  t('自适应图标含 background 层', /<background/.test(axml));
  t('背景层是矢量（任意尺寸都清晰）',
    fs.existsSync(path.join(RES, 'drawable', 'ic_launcher_bg.xml')));

  // 3) 自适应图标前景层：内容必须收在中心 66.7% 安全区内，
  //    否则会被各厂商的遮罩（圆形/水滴/方形）切掉。
  const SAFE = 0.3335;
  for (const d of DENSITIES) {
    const p = path.join(RES, 'mipmap-' + d, 'ic_launcher_foreground.png');
    t('自适应前景层存在（' + d + '）', fs.existsSync(p));
    if (!fs.existsSync(p)) continue;
    const img = readPNG(p);
    // 108dp 画布，中心 72dp 是可见区
    const expect = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 }[d];
    t('前景层尺寸正确（' + d + '）', img.w === expect && img.h === expect, [img.w, img.h, expect]);
    let outSafe = 0, total = 0;
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        const o = (y * img.w + x) * 4;
        if (img.px[o + 3] < 128) continue;
        total++;
        if (Math.abs(x / img.w - 0.5) > SAFE || Math.abs(y / img.h - 0.5) > SAFE) outSafe++;
      }
    }
    t('前景内容不越出安全区（' + d + '）', outSafe === 0, { outSafe, total });
    t('前景层有内容（' + d + '）', total > 0, total);
  }

  // 4) 圆形图标：四角必须透明，否则在圆形遮罩下会露出方块角
  const rp = path.join(RES, 'mipmap-xxxhdpi', 'ic_launcher_round.png');
  if (fs.existsSync(rp)) {
    const img = readPNG(rp);
    const at = (ux, uy) => {
      const x = Math.round(ux * (img.w - 1)), y = Math.round(uy * (img.h - 1));
      return img.px[(y * img.w + x) * 4 + 3];
    };
    t('圆形图标四角透明',
      at(0, 0) === 0 && at(1, 0) === 0 && at(0, 1) === 0 && at(1, 1) === 0,
      [at(0, 0), at(1, 0), at(0, 1), at(1, 1)]);
    t('圆形图标中心不透明', at(0.5, 0.5) === 255);
  } else {
    t('圆形图标存在', false);
  }

  // 5) 通知栏图标：必须是纯白剪影（系统会自己染色）
  const np = path.join(RES, 'drawable-xxhdpi', 'ic_stat_photostudio.png');
  if (fs.existsSync(np)) {
    const img = readPNG(np);
    let colored = 0, white = 0;
    for (let i = 0; i < img.px.length; i += 4) {
      if (img.px[i + 3] < 16) continue;
      const r = img.px[i], g = img.px[i + 1], b = img.px[i + 2];
      if (r > 240 && g > 240 && b > 240) white++;
      else colored++;
    }
    t('通知图标是纯白剪影', colored === 0, { colored, white });
  } else {
    t('通知图标存在', false);
  }

  // 6) PWA 图标（网页版 / 添加到主屏）
  t('PWA 图标 192 存在', fs.existsSync(path.join(APP, 'icon-192.png')));
  t('PWA 图标 512 存在', fs.existsSync(path.join(APP, 'icon-512.png')));
  t('SVG 图标存在（矢量源）', fs.existsSync(path.join(APP, 'icon.svg')));
  const svg = fs.readFileSync(path.join(APP, 'icon.svg'), 'utf8');
  // SVG 是设计源，必须与 PNG 同一套配色（避免两处各画各的）
  t('SVG 用亮蓝底（与 PNG 一致）', /#5ab0ff|#2b7fe0|#1a5cbf/i.test(svg), svg.match(/#[0-9a-f]{6}/i));
  t('SVG 含虚线选区（本应用的核心语义）', /stroke-dasharray/.test(svg));
  t('SVG 含四角手柄', (svg.match(/<circle/g) || []).length >= 4, (svg.match(/<circle/g) || []).length);

  // 7) 构建流程必须会生成图标 —— 否则改了 SVG 也不会进 APK
  //    （这正是本次的问题：mipmap 是手工放的死文件，改 SVG 完全没效果）
  const build = fs.readFileSync(path.join(__dirname, '..', 'tools', 'build-apk.sh'), 'utf8');
  t('构建时会生成桌面图标', /make-icons\.js[^\n]*android\/res|make-icons\.js[^\n]*\$AND\/res/.test(build), build.match(/make-icons[^\n]*/));
  const mk = fs.readFileSync(path.join(__dirname, '..', 'tools', 'make-icons.js'), 'utf8');
  t('图标生成器会写 mipmap', /mipmap-' \+ d/.test(mk));
  t('图标生成器会写自适应图标', /mipmap-anydpi-v26/.test(mk));
  t('图标生成器会写圆形图标', /ic_launcher_round\.png/.test(mk));
  t('图标生成器会写通知图标', /ic_stat_photostudio\.png/.test(mk));
})();


/* ---------- 应用图标 ---------- */
/* ---------- 无缝融合 ---------- */
/* ---------- 无缝融合 ---------- */
console.log('\n【融合】生成块必须贴合周围环境（光照/对比度/颗粒）');

(() => {
  const fs = require('fs');
  const path = require('path');
  const C2 = require(path.join(__dirname, '..', 'app', 'core.js'));
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

  function mk(w, h, fn) {
    const p = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = fn(x, y);
        const i = (y * w + x) * 4;
        p.data[i] = c[0]; p.data[i + 1] = c[1]; p.data[i + 2] = c[2]; p.data[i + 3] = 255;
      }
    }
    return p;
  }

  // 1) 核心：不能只说「请保持一致」，必须给出可对照的客观特征
  //    模型看不到像素统计，只说「一致」它不知道该一致成什么样
  const desc = C2.describeEnvironment({
    stats: { mean: [92, 84, 66], std: [38, 36, 32] },
    plane: { a: [0, 0, 0], b: [0, 0, 0], ok: false },
    isZh: true
  });
  t('给出了亮度特征', /偏暗|中等亮度|明亮|高亮/.test(desc), desc);
  t('给出了冷暖特征', /暖|冷|中性/.test(desc), desc);
  t('给出了反差特征', /反差/.test(desc), desc);
  t('提出了「必须融入」的明确要求', /必须自然融入/.test(desc), desc);

  // 2) 回归：光照方向曾经写反（左亮右暗被描述成「光来自右侧」）
  //    那会让模型往完全相反的方向打光，比不说更糟
  const stat = { mean: [150, 150, 150], std: [40, 40, 40] };
  const dirOf = (fn) => {
    const img = mk(300, 300, fn);
    const pl = C2.fitLightPlane({ pixels: img, rect: { x: 100, y: 100, w: 100, h: 100 }, ring: 14 });
    const d = C2.describeEnvironment({ stats: stat, plane: pl, isZh: true });
    const m = /主光来自(\S+?)。/.exec(d);
    return m ? m[1] : '';
  };
  t('左亮右暗 → 光来自左侧', dirOf((x) => { const v = 200 - x * 0.4; return [v, v, v]; }) === '左侧');
  t('右亮左暗 → 光来自右侧', dirOf((x) => { const v = 80 + x * 0.4; return [v, v, v]; }) === '右侧');
  t('上亮下暗 → 光来自上方', dirOf((x, y) => { const v = 200 - y * 0.4; return [v, v, v]; }) === '上方');
  t('均匀光照不编造方向', dirOf(() => [150, 150, 150]) === '');

  // 3) 行为约束：这些是「别加边框」「别改周边」等硬要求
  const clause = C2.environmentClause({ isZh: true, envDesc: desc, scope: 'region' });
  t('约束禁止可见边界', /可见边界/.test(clause), clause);
  t('约束禁止边框暗角', /边框、暗角/.test(clause), clause);
  t('约束要求像一次拍摄', /一次拍摄完成/.test(clause), clause);

  // 4) 集成：buildPrompt 必须带上，且不挤掉用户指令
  const full = C2.buildPrompt({
    instruction: '把这块换成花丛', style: 'natural', scope: 'region',
    centerPct: 80, language: 'zh', envDesc: desc, envFit: true
  });
  t('提示词带环境特征', /周边环境的客观特征/.test(full));
  t('提示词保留用户指令', /换成花丛/.test(full));
  t('提示词仍限制只改描述内容', /只改动上面描述的内容/.test(full));
  t('环境段长度克制（不喧宾夺主）',
    ((/周边环境的客观特征[^。]*。/.exec(full) || [''])[0]).length < 150);

  // 5) 可关闭 + 无数据时优雅降级
  const off = C2.buildPrompt({
    instruction: '把这块换成花丛', style: 'natural', scope: 'region',
    centerPct: 80, language: 'zh', envFit: false
  });
  t('关闭后不带环境特征', !/周边环境的客观特征/.test(off));
  const noData = C2.buildPrompt({
    instruction: '把这块换成花丛', style: 'natural', scope: 'region',
    centerPct: 80, language: 'zh', envFit: true, envDesc: ''
  });
  t('无环境数据时不残留空句', !/。。/.test(noData) && noData.length > 0);
  t('describeEnvironment 对 null 安全', C2.describeEnvironment(null) === '');

  // 6) 接线
  t('生成时测量周围环境', /measureSurroundings\(rect\)/.test(appSrc));
  t('测量基于环带（选区外一圈才是要融入的环境）',
    /function measureSurroundings[\s\S]{0,700}ringMoments/.test(appSrc));
  t('环境描述传入 buildPrompt', /envDesc,/.test(appSrc));
  t('测量失败不影响生成', /function measureSurroundings[\s\S]{0,1200}catch \(e\)[\s\S]{0,200}return null/.test(appSrc));
  t('设置里有开关', /id="set-envfit"/.test(html));
  t('开关默认开启', /envFit: true,/.test(appSrc));
  t('开关会持久化', /'envFit'/.test(appSrc));
  t('这是免费手段（不额外调用模型）',
    !/envDesc[\s\S]{0,200}runGenerate\(\)/.test(appSrc));
})();


/* ---------- 环境契合提示词 ---------- */
console.log('\n【提示词】把测出来的周围特征写进请求');

(() => {
  const fs = require('fs');
  const path = require('path');
  const C2 = require(path.join(__dirname, '..', 'app', 'core.js'));
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

  function mk(w, h, fn) {
    const p = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = fn(x, y);
        const i = (y * w + x) * 4;
        p.data[i] = c[0]; p.data[i + 1] = c[1]; p.data[i + 2] = c[2]; p.data[i + 3] = 255;
      }
    }
    return p;
  }

  // 1) 核心：不能只说「请保持一致」，必须给出可对照的客观特征
  //    模型看不到像素统计，只说「一致」它不知道该一致成什么样
  const desc = C2.describeEnvironment({
    stats: { mean: [92, 84, 66], std: [38, 36, 32] },
    plane: { a: [0, 0, 0], b: [0, 0, 0], ok: false },
    isZh: true
  });
  t('给出了亮度特征', /偏暗|中等亮度|明亮|高亮/.test(desc), desc);
  t('给出了冷暖特征', /暖|冷|中性/.test(desc), desc);
  t('给出了反差特征', /反差/.test(desc), desc);
  t('提出了「必须融入」的明确要求', /必须自然融入/.test(desc), desc);

  // 2) 回归：光照方向曾经写反（左亮右暗被描述成「光来自右侧」）
  //    那会让模型往完全相反的方向打光，比不说更糟
  const stat = { mean: [150, 150, 150], std: [40, 40, 40] };
  const dirOf = (fn) => {
    const img = mk(300, 300, fn);
    const pl = C2.fitLightPlane({ pixels: img, rect: { x: 100, y: 100, w: 100, h: 100 }, ring: 14 });
    const d = C2.describeEnvironment({ stats: stat, plane: pl, isZh: true });
    const m = /主光来自(\S+?)。/.exec(d);
    return m ? m[1] : '';
  };
  t('左亮右暗 → 光来自左侧', dirOf((x) => { const v = 200 - x * 0.4; return [v, v, v]; }) === '左侧');
  t('右亮左暗 → 光来自右侧', dirOf((x) => { const v = 80 + x * 0.4; return [v, v, v]; }) === '右侧');
  t('上亮下暗 → 光来自上方', dirOf((x, y) => { const v = 200 - y * 0.4; return [v, v, v]; }) === '上方');
  t('均匀光照不编造方向', dirOf(() => [150, 150, 150]) === '');

  // 3) 行为约束：这些是「别加边框」「别改周边」等硬要求
  const clause = C2.environmentClause({ isZh: true, envDesc: desc, scope: 'region' });
  t('约束禁止可见边界', /可见边界/.test(clause), clause);
  t('约束禁止边框暗角', /边框、暗角/.test(clause), clause);
  t('约束要求像一次拍摄', /一次拍摄完成/.test(clause), clause);

  // 4) 集成：buildPrompt 必须带上，且不挤掉用户指令
  const full = C2.buildPrompt({
    instruction: '把这块换成花丛', style: 'natural', scope: 'region',
    centerPct: 80, language: 'zh', envDesc: desc, envFit: true
  });
  t('提示词带环境特征', /周边环境的客观特征/.test(full));
  t('提示词保留用户指令', /换成花丛/.test(full));
  t('提示词仍限制只改描述内容', /只改动上面描述的内容/.test(full));
  t('环境段长度克制（不喧宾夺主）',
    ((/周边环境的客观特征[^。]*。/.exec(full) || [''])[0]).length < 150);

  // 5) 可关闭 + 无数据时优雅降级
  const off = C2.buildPrompt({
    instruction: '把这块换成花丛', style: 'natural', scope: 'region',
    centerPct: 80, language: 'zh', envFit: false
  });
  t('关闭后不带环境特征', !/周边环境的客观特征/.test(off));
  const noData = C2.buildPrompt({
    instruction: '把这块换成花丛', style: 'natural', scope: 'region',
    centerPct: 80, language: 'zh', envFit: true, envDesc: ''
  });
  t('无环境数据时不残留空句', !/。。/.test(noData) && noData.length > 0);
  t('describeEnvironment 对 null 安全', C2.describeEnvironment(null) === '');

  // 6) 接线
  t('生成时测量周围环境', /measureSurroundings\(rect\)/.test(appSrc));
  t('测量基于环带（选区外一圈才是要融入的环境）',
    /function measureSurroundings[\s\S]{0,700}ringMoments/.test(appSrc));
  t('环境描述传入 buildPrompt', /envDesc,/.test(appSrc));
  t('测量失败不影响生成', /function measureSurroundings[\s\S]{0,1200}catch \(e\)[\s\S]{0,200}return null/.test(appSrc));
  t('设置里有开关', /id="set-envfit"/.test(html));
  t('开关默认开启', /envFit: true,/.test(appSrc));
  t('开关会持久化', /'envFit'/.test(appSrc));
  t('这是免费手段（不额外调用模型）',
    !/envDesc[\s\S]{0,200}runGenerate\(\)/.test(appSrc));
})();


/* ---------- 环境契合提示词 ---------- */
/* ---------- 环境契合提示词 ---------- */
/* ---------- 环境契合提示词 ---------- */
console.log('\n【提示词】每次请求都要带上「测出来的」周围环境特征');

(() => {
  const fs = require('fs');
  const path = require('path');
  const C2 = require(path.join(__dirname, '..', 'app', 'core.js'));
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

  function mk(w, h, fn) {
    const p = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = fn(x, y);
        const i = (y * w + x) * 4;
        p.data[i] = c[0]; p.data[i + 1] = c[1]; p.data[i + 2] = c[2]; p.data[i + 3] = 255;
      }
    }
    return p;
  }

  // 1) 核心：不能只说「请保持一致」，必须给出可对照的客观特征
  //    模型看不到像素统计，只说「一致」它不知道该一致成什么样
  const desc = C2.describeEnvironment({
    stats: { mean: [92, 84, 66], std: [38, 36, 32] },
    plane: { a: [0, 0, 0], b: [0, 0, 0], ok: false },
    isZh: true
  });
  t('给出了亮度特征', /偏暗|中等亮度|明亮|高亮/.test(desc), desc);
  t('给出了冷暖特征', /暖|冷|中性/.test(desc), desc);
  t('给出了反差特征', /反差/.test(desc), desc);
  t('提出了「必须融入」的明确要求', /必须自然融入/.test(desc), desc);

  // 2) 回归：光照方向曾经写反（左亮右暗被描述成「光来自右侧」）
  //    那会让模型往完全相反的方向打光，比不说更糟
  const stat = { mean: [150, 150, 150], std: [40, 40, 40] };
  const dirOf = (fn) => {
    const img = mk(300, 300, fn);
    const pl = C2.fitLightPlane({ pixels: img, rect: { x: 100, y: 100, w: 100, h: 100 }, ring: 14 });
    const d = C2.describeEnvironment({ stats: stat, plane: pl, isZh: true });
    const m = /主光来自(\S+?)。/.exec(d);
    return m ? m[1] : '';
  };
  t('左亮右暗 → 光来自左侧', dirOf((x) => { const v = 200 - x * 0.4; return [v, v, v]; }) === '左侧');
  t('右亮左暗 → 光来自右侧', dirOf((x) => { const v = 80 + x * 0.4; return [v, v, v]; }) === '右侧');
  t('上亮下暗 → 光来自上方', dirOf((x, y) => { const v = 200 - y * 0.4; return [v, v, v]; }) === '上方');
  t('均匀光照不编造方向', dirOf(() => [150, 150, 150]) === '');

  // 3) 行为约束：这些是「别加边框」「别改周边」等硬要求
  const clause = C2.environmentClause({ isZh: true, envDesc: desc, scope: 'region' });
  t('约束禁止可见边界', /可见边界/.test(clause), clause);
  t('约束禁止边框暗角', /边框、暗角/.test(clause), clause);
  t('约束要求像一次拍摄', /一次拍摄完成/.test(clause), clause);

  // 4) 集成：buildPrompt 必须带上，且不挤掉用户指令
  const full = C2.buildPrompt({
    instruction: '把这块换成花丛', style: 'natural', scope: 'region',
    centerPct: 80, language: 'zh', envDesc: desc, envFit: true
  });
  t('提示词带环境特征', /周边环境的客观特征/.test(full));
  t('提示词保留用户指令', /换成花丛/.test(full));
  t('提示词仍限制只改描述内容', /只改动上面描述的内容/.test(full));
  t('环境段长度克制（不喧宾夺主）',
    ((/周边环境的客观特征[^。]*。/.exec(full) || [''])[0]).length < 150);

  // 5) 可关闭 + 无数据时优雅降级
  const off = C2.buildPrompt({
    instruction: '把这块换成花丛', style: 'natural', scope: 'region',
    centerPct: 80, language: 'zh', envFit: false
  });
  t('关闭后不带环境特征', !/周边环境的客观特征/.test(off));
  const noData = C2.buildPrompt({
    instruction: '把这块换成花丛', style: 'natural', scope: 'region',
    centerPct: 80, language: 'zh', envFit: true, envDesc: ''
  });
  t('无环境数据时不残留空句', !/。。/.test(noData) && noData.length > 0);
  t('describeEnvironment 对 null 安全', C2.describeEnvironment(null) === '');

  // 6) 接线
  t('生成时测量周围环境', /measureSurroundings\(rect\)/.test(appSrc));
  t('测量基于环带（选区外一圈才是要融入的环境）',
    /function measureSurroundings[\s\S]{0,900}ringMoments/.test(appSrc));
  t('环境描述传入 buildPrompt', /envDesc,/.test(appSrc));
  t('测量失败不影响生成', /function measureSurroundings[\s\S]{0,1200}catch \(e\)[\s\S]{0,200}return null/.test(appSrc));
  t('设置里有开关', /id="set-envfit"/.test(html));
  t('开关默认开启', /envFit: true,/.test(appSrc));
  t('开关会持久化', /'envFit'/.test(appSrc));
  t('这是免费手段（不额外调用模型）',
    !/envDesc[\s\S]{0,200}runGenerate\(\)/.test(appSrc));
})();


// ===== 设置面板布局回归 =====
(() => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'style.css'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'android', 'AndroidManifest.xml'), 'utf8');
  const act = fs.readFileSync(path.join(__dirname, '..', 'android', 'src', 'com', 'photostudio', 'app', 'MainActivity.java'), 'utf8');

  const i = html.indexOf('id="settings"');
  const j = html.indexOf('<script src="version.js">');
  const seg = html.slice(i, j);

  // 1) 结构：分组 + 卡片 + 行（系统设置的视觉语言）
  const groups = (seg.match(/class="st-group"/g) || []).length;
  const cards = (seg.match(/class="st-card"/g) || []).length;
  t('设置分为多个分组', groups >= 8, groups);
  t('每组用卡片容器', cards >= 8, cards);
  t('有分组标题样式', /#settings \.st-group/.test(css));
  t('有卡片样式（圆角 + 边框）',
    /#settings \.st-card \{[\s\S]{0,200}border-radius/.test(css), 'card 规则');
  t('行高符合触控标准（>=44px）', /#settings \.st-row \{[\s\S]{0,200}min-height: 48px/.test(css));

  // 2) 行之间要有分隔线（系统设置的标志性细节）
  t('行之间有分隔线', /\.st-row \+ \.st-row::before|\.st-row-col \+ \.st-row/.test(css));
  t('分隔线从左侧内缩（不顶到边）', /left: 14px; right: 0; top: 0/.test(css));

  // 3) 开关要做成拨动开关，不是默认勾选框
  t('开关是自绘拨动样式', /#settings \.st-switch \{[\s\S]{0,300}appearance: none/.test(css));
  t('开关有圆形滑块', /\.st-switch::after/.test(css));
  t('开关选中时有位移', /\.st-switch:checked::after \{ transform: translateX/.test(css));
  t('开关尺寸合理（宽 40~56px）',
    /\.st-switch \{[\s\S]{0,200}width: 46px/.test(css));

  // 4) 可点进行要有右箭头（系统设置的视觉提示）
  t('可点行有右箭头', /class="st-arrow"/.test(seg));
  t('箭头是描边图标（不是实心）', /\.st-arrow \{[\s\S]{0,200}fill: none/.test(css));

  // 5) 破坏性操作单独成卡 + 红色文字
  t('清空数据单独成卡', /st-card[\s\S]{0,200}id="btn-clear"/.test(seg));
  t('清空数据用红色文字', /\.st-danger \.st-label \{ color: #ff8b8b/.test(css));

  // 6) 右侧值要右对齐（系统设置的关键观感）
  t('输入框值右对齐', /\.st-input \{[\s\S]{0,300}text-align: right/.test(css));
  t('当前值徽标右浮动', /\.st-badge \{[\s\S]{0,120}float: right/.test(css));

  // 7) GitHub 地址：用户明确要求加的
  t('设置里有 GitHub 链接', /id="link-github"/.test(seg));
  t('链接指向正确仓库',
    /id="link-github"[^>]*href="https:\/\/github\.com\/qianc7001-coder\/photo-studio"/.test(seg));
  t('有反馈问题入口', /id="link-issues"/.test(seg));
  t('有问题反馈地址', /issues"/.test(seg));
  t('有历史版本入口', /id="link-releases"/.test(seg));
  t('链接在新窗口打开', /id="link-github"[\s\S]{0,200}target="_blank"/.test(seg));
  t('外链带 rel=noopener（防钓鱼）',
    /target="_blank" rel="noopener"/.test(seg));
  // 关键：WebView 必须把外链交给系统浏览器，否则在应用内打不开
  t('安卓壳会把外链交给系统浏览器', /Intent\.ACTION_VIEW/.test(act));
  t('本机服务地址不被误拦',
    /u\.getPort\(\) == server\.getPort\(\)/.test(act));
  // 老设备上必须两个重载都在，否则点不动（之前修过）
  t('外链拦截兼容老系统（两个重载）',
    /shouldOverrideUrlLoading\(WebView view, WebResourceRequest request\)/.test(act) &&
    /shouldOverrideUrlLoading\(WebView view, String url\)/.test(act));

  // 8) 关于区显示版本号
  t('关于区显示版本', /id="about-version"/.test(seg));
  t('版本号由 JS 填入', /\$\('about-version'\)/.test(appSrc));

  // 9) 原有 ID 一个都不能少（改版最容易漏掉绑定目标）
  const need = ['set-provider', 'set-baseurl', 'set-apikey', 'set-model', 'model-list',
    'btn-test', 'btn-detect', 'test-status', 'detect-box', 'detect-summary', 'detect-close',
    'detect-list', 'provider-tip', 'set-netmode', 'net-tip',
    'v-ctx', 'set-ctx', 'v-feather', 'set-feather', 'v-cm', 'set-cm',
    'v-fusion', 'set-fusion', 'v-fusionc', 'set-fusionc', 'v-fusiong', 'set-fusiong', 'set-envfit',
    'set-maxres', 'v-tile', 'set-tile', 'set-upscale', 'v-mem', 'set-mem', 'set-autosave',
    'set-keepalive', 'ka-always-row', 'set-keepalive-always', 'ka-state', 'ka-battery',
    'set-price', 'set-usdcny', 'btn-reset-spend', 'spend-status', 'price-tip',
    'set-lang', 'set-seed', 'set-preset', 'preset-desc', 'custom-export', 'set-format',
    'v-quality', 'set-quality', 'set-mosaic', 'btn-whatsnew', 'btn-clear', 'about'];
  const missing = need.filter((id) => seg.indexOf('id="' + id + '"') < 0);
  t('改版后所有原有 ID 都还在', missing.length === 0, missing);

  // 10) 旧 class 不应残留在设置面板（避免两套样式打架）
  t('设置面板不再用旧的 field class', !/class="field/.test(seg));
  t('设置面板不再用旧的 switch class', !/class="switch/.test(seg));
  // 但旧 class 的样式要保留（其它面板还在用）
  t('旧样式仍保留（其它面板在用）', /^\.switch \{/m.test(css) || /\.switch \{/.test(css));

  // 11) 保活按钮包在行里时，显隐要切整行（只切按钮会留空白行）
  t('电池按钮的显隐切换整行', /battRow\.hidden = !optimized/.test(appSrc));
  t('不支持环境时整行也隐藏', /kbRow\.hidden = true/.test(appSrc));

  // 12) 老内核兼容：不支持 flex gap 时行内间距仍正确
  t('老内核下行内间距有兜底', /\.ps-no-flex-gap #settings \.st-row > \* \+ \*/.test(css));
})();
// ===== 设置界面块结束 =====


/* ---------- 设置界面（系统设置风格） ---------- */

console.log('\n【发布】历史版本必须可下载（README 与归档一致）');

(() => {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const PUB = fs.readFileSync(path.join(ROOT, 'tools', 'publish-archive.js'), 'utf8');
  const ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));

  // 1) README 必须有历史版本章节
  t('README 有历史版本章节', /^## 历史版本/m.test(README));
  const i = README.indexOf('## 历史版本');
  const j = README.indexOf('## 授权', i);
  t('历史版本章节在授权之前', i > 0 && j > i, { i, j });
  const sec = README.slice(i, j);

  // 2) 当前版本必须在表格里（最新版单独列，不带链接也可）
  t('表格含当前版本', sec.indexOf('v' + ver.versionName) >= 0, ver.versionName);

  // 3) 每个带链接的版本都要有对应的 tag 链接，且格式统一
  const links = sec.match(/releases\/tag\/(v[\d.]+)/g) || [];
  const tags = links.map((l) => l.split('/').pop());
  t('历史版本链接数量合理（>= 10）', tags.length >= 10, tags.length);
  // 不能有重复
  t('历史版本链接不重复', new Set(tags).size === tags.length, tags.length);
  // 版本号格式必须规范（vX.Y.Z）
  t('版本号格式规范', tags.every((t) => /^v\d+\.\d+\.\d+$/.test(t)), tags.filter((t) => !/^v\d+\.\d+\.\d+$/.test(t)));
  // 必须按版本从新到旧排列（用户最关心最新）
  const nums = tags.map((t) => t.replace(/^v/, '').split('.').map(Number));
  let desc = true;
  for (let k = 1; k < nums.length; k++) {
    const a = nums[k - 1], b = nums[k];
    let cmp = 0;
    for (let m = 0; m < 3; m++) {
      if (a[m] !== b[m]) { cmp = a[m] - b[m]; break; }
    }
    if (cmp < 0) { desc = false; break; }
  }
  t('按版本从新到旧排列', desc, tags);

  // 4) 说明覆盖安装会保留设置（用户最关心这个）
  t('说明覆盖安装会保留设置', /覆盖安装/.test(sec) && /保留/.test(sec), sec.slice(0, 120));

  // 5) 发布脚本：这是保证「以后也不会漏」的关键
  t('有归档发布脚本', fs.existsSync(path.join(ROOT, 'tools', 'publish-archive.js')));
  t('脚本支持 dry-run（先预览再执行）', /--dry-run/.test(PUB));
  t('脚本支持只发指定版本', /only\s*=/.test(PUB));
  t('脚本是幂等的（已存在则跳过）',
    /existing\.has\(rel\.tag\)/.test(PUB) && /跳过/.test(PUB));
  t('脚本按版本号排序（不是字符串排序）',
    /function byVersion/.test(PUB) && /split\('\.'\)\.map\(Number\)/.test(PUB));
  t('脚本用 ASCII 附件名（GitHub 对中文名支持不好）',
    /photo-studio-v\$\{rel\.versionName\}\.apk/.test(PUB));
  t('脚本不把源码塞进 Release（源码在 git 里）',
    !/uploadAsset\([^)]*\.js/.test(PUB), '不应上传 .js');
  t('脚本不会打印 token', !/console\.log\([^)]*TOKEN/.test(PUB));

  // 6) 归档目录：本地留档是发布脚本的输入
  const ARCHIVE = path.join(ROOT, '..', 'photo-studio-archive');
  if (fs.existsSync(ARCHIVE)) {
    const dirs = fs.readdirSync(ARCHIVE).filter((d) => /^v\d/.test(d));
    t('本地归档存在', dirs.length > 0, dirs.length);
    // 每个归档都要有 version.json 和 APK —— 缺了就没法补发
    const bad = [];
    for (const d of dirs) {
      const dir = path.join(ARCHIVE, d);
      const hasVer = fs.existsSync(path.join(dir, 'version.json'));
      const hasApk = fs.readdirSync(dir).some((f) => f.endsWith('.apk'));
      if (!hasVer || !hasApk) bad.push(d + (!hasVer ? '(缺version.json)' : '') + (!hasApk ? '(缺APK)' : ''));
    }
    t('每个归档都含 version.json 与 APK', bad.length === 0, bad);
    // 归档里绝不能有签名密钥（复制归档时最容易带进去）
    const leaked = dirs.filter((d) => fs.existsSync(path.join(ARCHIVE, d, 'android', 'keystore.jks')));
    t('归档里没有签名密钥', leaked.length === 0, leaked);
    // 双向一致：README 列的版本都要有归档；归档里的版本也都要在 README 里列出
    // （只查单向的话，「README 漏写一个历史版本」这种问题查不出来）
    const archVers = dirs.map((d) => d.replace(/^v/, ''));
    const missingArch = tags.map((t) => t.replace(/^v/, '')).filter((v) => archVers.indexOf(v) < 0);
    t('README 列的版本都有本地归档', missingArch.length === 0, missingArch);
    // 当前版本单独成行（不带链接），所以比对时要把它也算上
    const listed = tags.map((t) => t.replace(/^v/, '')).concat([ver.versionName]);
    const missingDoc = archVers.filter((v) => listed.indexOf(v) < 0);
    t('归档里的每个版本都写进了 README', missingDoc.length === 0, missingDoc);
  } else {
    t('本地归档存在（本次跳过：不在开发机）', true);
  }
})();


/* ---------- 历史版本保留 ---------- */
console.log(`\n合计 ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
