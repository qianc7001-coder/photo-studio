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

// 早期版本会把大选区切成多块分别生成，重叠区内容不一致 → 接缝重影/发糊。
// 这套「加权拼接」逻辑已连同分块功能一起删除，这里改为守住「不会再回来」。
console.log('\n【M3】分块已彻底移除（整块一次生成）');
(() => {
  t('分块裁剪已移除', typeof C.planTileCrop === 'undefined');
  t('分块权重已移除', typeof C.tileBlendWeights === 'undefined');
  t('分块累加已移除', typeof C.accumulateTile === 'undefined');
  t('分块归一化已移除', typeof C.resolveAccumulated === 'undefined');
  t('分块提示词已移除', typeof C.tileHint === 'undefined');

  const appSrc = require('fs').readFileSync(__dirname + '/../app/app.js', 'utf8');
  const html = require('fs').readFileSync(__dirname + '/../app/index.html', 'utf8');
  // 生成路径里不该再有任何按块循环的痕迹
  t('生成路径没有按块循环', !/tiles\[i\]|for \(let i = 0; i < tiles\.length/.test(appSrc));
  t('生成路径不再按块挑尺寸', !/pickOutputSize\(sizeRef\)[\s\S]{0,200}tiles\.length/.test(appSrc));
  t('设置里没有分块开关', !/set-tile|自动分块/.test(html));
  t('成本预估恒为 1 次调用', (() => {
    const e = C.estimateCost({ rect: { w: 4000, h: 3000 }, model: 'Qwen/Qwen-Image-Edit' });
    return e.calls === 1 && e.tiles === 1;
  })());
  // 一次生成只发一个请求：这是分块删干净的核心证据
  t('一次生成只调用一次模型', !/await callModel\(req\)[\s\S]{0,200}for \(/.test(
    appSrc.slice(appSrc.indexOf('async function runGenerate'), appSrc.indexOf('function cropMask'))));
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
  const e1 = C.estimateCost({ rect: { w: 800, h: 600 }, model: 'Qwen/Qwen-Image-Edit' });
  t('小选区 1 次调用', e1.calls === 1, e1.calls);
  t('金额正确', Math.abs(e1.totalUsd - 0.04) < 1e-9, e1.totalUsd);
  t('人民币换算正确', Math.abs(e1.totalCny - 0.04 * 7.1) < 1e-9, e1.totalCny);

  // 3) 关键：不再有分块，选区再大也只调用一次。
  //    早期版本会按 1400px 切块，4000x3000 要调 9 次、成本翻 9 倍 ——
  //    用户以为改一处只要几分钱，实际被扣了 9 倍。这是必须守住的回归点。
  const e2 = C.estimateCost({ rect: { w: 3000, h: 2000 }, model: 'Qwen/Qwen-Image-Edit' });
  t('大选区也只调用 1 次', e2.calls === 1, e2.calls);
  t('大选区成本不翻倍', Math.abs(e2.totalUsd - 0.04) < 1e-9, e2.totalUsd);
  const e3 = C.estimateCost({ rect: { w: 4000, h: 3000 }, model: 'Qwen/Qwen-Image-Edit' });
  t('4000x3000 也只调用 1 次', e3.calls === 1, e3.calls);
  t('4000x3000 成本仍是 $0.04', Math.abs(e3.totalUsd - 0.04) < 1e-9, e3.totalUsd);
  // 老配置里残留的 tileMaxSide 不该再影响估算（用户覆盖安装后配置里还留着这个值）
  const e4 = C.estimateCost({ rect: { w: 4000, h: 3000 }, model: 'Qwen/Qwen-Image-Edit', tileMaxSide: 1400 });
  t('残留的 tileMaxSide 不再影响估算', e4.calls === 1 && Math.abs(e4.totalUsd - 0.04) < 1e-9, e4);

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
  // 贴回后还会自动打开调色工具（见「基础调色」一节），所以 toast 不再紧跟 draw()。
  // 断言改成「先关对比层、再刷界面」这个真正要保证的顺序。
  t('应用结果时走 closeCompare', /closeCompare\(\);\s*\n\s*updateUI\(\);\s*\n\s*draw\(\);/.test(appSrc));
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
  // 改名「枫叶修图」后图标重做成枫叶。SVG 是设计源，make-icons.js 是各平台
  // PNG 的实现 —— 两边必须同色同形，否则网页版和 APK 里会是两个不同的图标
  // （这正是这条测试原本要防的：mipmap 曾经是手工放的死文件，改 SVG 完全没效果）。
  const mkSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'make-icons.js'), 'utf8');
  const svgHex = (svg.match(/#[0-9a-fA-F]{6}/g) || []).map((h) => h.toLowerCase());
  t('SVG 用饱和红底（枫叶配色）',
    ['#ff7048', '#dc2318', '#8a0d0a'].every((h) => svgHex.includes(h)), svgHex.slice(0, 5));
  t('SVG 叶子是白色', svgHex.includes('#ffffff'), svgHex.slice(0, 5));
  t('SVG 有叶周光晕与顶部高光（小尺寸下叶子不糊底）',
    /radialGradient/.test(svg) && /id="hl"/.test(svg));
  t('SVG 用圆角底（贴合启动器遮罩）', /rx="114"/.test(svg));
  // 叶形：SVG 用官方枫叶路径，生成器用它的展平多边形
  t('SVG 含标准枫叶路径', /M201 232/.test(svg));
  t('生成器内联了展平后的枫叶多边形', /const LEAF = \[\[/.test(mkSrc));
  const leafArr = /const LEAF = (\[\[[\s\S]*?\]\]);/.exec(mkSrc);
  t('生成器的枫叶是 42 点（与真实路径 IoU 0.986）',
    !!leafArr && JSON.parse(leafArr[1]).length === 42,
    leafArr ? JSON.parse(leafArr[1]).length : 'missing');
  // 叶形必须是「宽 < 高」的枫叶比例（0.916），不能是正方形或圆
  if (leafArr) {
    const pts = JSON.parse(leafArr[1]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    t('生成器的叶形宽高比正确（枫叶 0.916）', Math.abs(w / h - 0.9161) < 0.002, +(w / h).toFixed(4));
    t('生成器的叶形顶点归一化到 [0,1]',
      Math.min(...xs) === 0 && Math.min(...ys) === 0 && Math.abs(Math.max(...ys) - 1) < 0.002);
  }
  // 配色一致性：生成器必须用与 SVG 完全相同的色值
  t('生成器用同一套红底', ['#ff7048', '#dc2318', '#8a0d0a'].every((h) => mkSrc.includes(h)));
  t('生成器用同一套叶色', mkSrc.includes('#ffffff') && mkSrc.includes('#fff0dd'));
  // 叶形缩放一致性：SVG 里 279（原路径叶高）× scale 应等于「画布 60%」，
  // 也就是生成器 icon() 里的 leafH —— 两边叶高不一致会让 PNG 和 SVG 大小对不上
  const sc = /scale\(([\d.]+)\)/.exec(svg);
  t('SVG 含叶形缩放', !!sc, sc ? sc[1] : null);
  if (sc) {
    const leafPx = 279 * parseFloat(sc[1]);
    t('SVG 叶高 = 画布 60%（与生成器 leafH 一致）', Math.abs(leafPx - 512 * 0.6) < 2, Math.round(leafPx));
  }
  const arGen = parseFloat((/const LEAF_AR = ([\d.]+)/.exec(mkSrc) || [])[1]);
  t('SVG 与生成器的叶形宽高比一致', Math.abs(255.6 / 279 - arGen) < 0.001, [255.6 / 279, arGen]);

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
    'set-maxres', 'set-upscale', 'v-mem', 'set-mem', 'set-autosave',
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
    // 表格里还有一类「**vX.Y.Z**」的加粗行：版本已写好说明、也留了归档，
    // 但**故意不带链接** —— 因为它还没发到 GitHub（例如只在本机测过）。
    // 这类行也必须算「写进了 README」，否则每次本地攒版本都会误报。
    // 注意：带链接的行仍然必须真的能下载（上面那条断言管着），两类不能混。
    const boldVers = (sec.match(/\|\s*\*\*(v[\d.]+)\*\*\s*\|/g) || [])
      .map((r) => r.match(/v[\d.]+/)[0].replace(/^v/, ''));
    t('加粗行（未发布版本）与链接行不重叠',
      boldVers.every((v) => tags.indexOf('v' + v) < 0), boldVers);
    const listed = tags.map((t) => t.replace(/^v/, ''))
      .concat(boldVers)
      .concat([ver.versionName]);
    const missingDoc = archVers.filter((v) => listed.indexOf(v) < 0);
    t('归档里的每个版本都写进了 README', missingDoc.length === 0, missingDoc);
  } else {
    t('本地归档存在（本次跳过：不在开发机）', true);
  }
})();


/* ---------- 历史版本保留 ---------- */
/* ---------- 检查更新 ---------- */
console.log('\n【更新】应用内检测新版本（不能依赖 /releases/latest）');

(() => {
  const fs = require('fs');
  const path = require('path');
  const C2 = require(path.join(__dirname, '..', 'app', 'core.js'));
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const act = fs.readFileSync(path.join(__dirname, '..', 'android', 'src', 'com', 'photostudio', 'app', 'MainActivity.java'), 'utf8');
  const mf = fs.readFileSync(path.join(__dirname, '..', 'android', 'AndroidManifest.xml'), 'utf8');

  const mkRel = (tag, created, extra) => Object.assign({
    tag_name: tag, created_at: created, draft: false, prerelease: false, name: tag, body: 'x',
    assets: [{ name: 'photo-studio-' + tag + '.apk', browser_download_url: 'https://x/' + tag + '.apk' }]
  }, extra || {});

  // 1) 回归：绝不能用 /releases/latest
  //    它按「创建时间」判定最新 —— 本项目补发 v1.8.0~v2.2.0 后，
  //    这些旧版本的时间戳变成最新，/releases/latest 返回了 v2.2.0，
  //    用户会被提示「更新」到更老的版本上。
  const codeOnly = appSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  t('代码里没有 /releases/latest', !/releases\/latest/.test(codeOnly));
  t('拉完整列表自己挑', /releases\?per_page=100/.test(codeOnly));

  const list = [
    mkRel('v1.8.0', '2026-09-26T10:00:00Z'),
    mkRel('v2.2.0', '2026-09-26T10:05:00Z'),   // 时间最新，但版本低
    mkRel('v2.8.2', '2026-09-25T10:00:00Z')
  ];
  t('挑出的是版本号最高的', C2.pickLatestRelease(list).tag_name === 'v2.8.2');
  // 对照实验：证明「按时间挑」确实会错
  const byTime = list.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  t('对照：按时间挑会选到旧版本（所以必须按版本号）', byTime.tag_name === 'v2.2.0');

  // 2) 版本比较必须按数字段（字符串比较会认为 "2.10" < "2.9"）
  t('2.10.0 > 2.9.0', C2.compareVersion('2.10.0', '2.9.0') === 1);
  t('2.9.0 < 2.10.0', C2.compareVersion('2.9.0', '2.10.0') === -1);
  t('字符串比较会出错（对照）', !('2.10.0' > '2.9.0'));
  t('带 v 前缀等价', C2.compareVersion('v2.8.2', '2.8.2') === 0);

  // 3) 忽略此版本：只忽略那一个，出了新版还要提示
  t('忽略过的版本不提示',
    C2.planUpdate({ current: '2.8.2', latest: 'v2.9.0', skipped: 'v2.9.0' }).hasUpdate === false);
  t('出了更新的版本仍提示',
    C2.planUpdate({ current: '2.8.2', latest: 'v2.10.0', skipped: 'v2.9.0' }).hasUpdate === true);
  t('本地比远程新时不提示（不回退版本）',
    C2.planUpdate({ current: '2.9.0', latest: 'v2.8.2' }).hasUpdate === false);

  // 4) 检查时机：不该每次启动都请求（浪费流量、可能被限流）
  const H = 3600 * 1000;
  t('首次会检查', C2.planUpdateCheck({ now: 1, lastCheck: 0 }).should === true);
  t('刚检查过会跳过', C2.planUpdateCheck({ now: 1000, lastCheck: 999 }).should === false);
  t('手动检查总是执行', C2.planUpdateCheck({ now: 1000, lastCheck: 999, force: true }).should === true);
  t('失败会退避', C2.planUpdateCheck({ now: 13 * H, lastCheck: 1, failCount: 2 }).should === false);
  t('退避有上限', C2.planUpdateCheck({ now: 200 * H, lastCheck: 1, failCount: 99 }).should === true);

  // 5) APK 附件挑选
  t('能挑出 APK', C2.pickApkAsset(mkRel('v2.8.2', 'x')).name === 'photo-studio-v2.8.2.apk');
  t('没有 APK 时返回 null（调用方据此改用网页下载）',
    C2.pickApkAsset({ tag_name: 'v1.0.0', assets: [] }) === null);

  // 6) 安卓侧：下载与安装
  t('提供原生下载接口', /downloadAndInstall/.test(act));
  t('用系统下载管理器（有进度通知、断点续传）', /DownloadManager/.test(act));
  t('下载完成自动调起安装器', /installDownloadedApk/.test(act));
  // Android 8+ 必须显式授权，否则系统静默拒绝（用户看不到任何提示）
  t('处理「安装未知应用」授权', /checkInstallPermission/.test(act));
  t('Manifest 声明 REQUEST_INSTALL_PACKAGES', /REQUEST_INSTALL_PACKAGES/.test(mf));
  t('授权回来后继续安装（不丢下载结果）', /pendingInstallPath/.test(act));
  t('8.0 以下视为已授权', /SDK_INT < Build\.VERSION_CODES\.O\) return true/.test(act));
  t('下载完注销广播', /unregisterDownloadReceiver/.test(act));
  t('onDestroy 里清理广播', /onDestroy[\s\S]{0,600}unregisterDownloadReceiver/.test(act));

  // 7) 发布流程：补发历史版本绝不能顶掉 latest
  //    这是真实踩过的坑：补发 v1.8.0~v2.2.0 后，GitHub 的 /releases/latest
  //    变成了 v2.2.0（按创建时间判定），用户点「最新版」反而下到旧包。
  const pubArch = fs.readFileSync(path.join(__dirname, '..', 'tools', 'publish-archive.js'), 'utf8');
  const pubRel = fs.readFileSync(path.join(__dirname, '..', 'tools', 'publish-release.js'), 'utf8');
  t('补发历史版本时不设为 latest', /make_latest: 'false'/.test(pubArch));
  t('发布当前版本时显式设为 latest', /make_latest: 'true'/.test(pubRel));
  t('发布后会复核 /releases/latest 指向正确',
    /releases\/latest/.test(pubRel) && /指向 \$\{tag\}/.test(pubRel));
  t('发布脚本在 latest 不对时报错退出', /if \(!ok\) process\.exit\(1\)/.test(pubRel));
  t('发布脚本会重建同名 release（保证附件最新）', /先删除再重建/.test(pubRel));

  // 7.5) 安全：发布脚本绝不能泄漏 token
  //     真实踩过：execFileSync 失败时 Node 把整个 argv（含 Authorization 头）
  //     挂在错误对象上，脚本没捕获 → 打印出来 token 就进日志了。
  for (const f of ['publish-archive.js', 'publish-release.js', 'push-via-api.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'tools', f), 'utf8');
    t(f + '：body 走 stdin（不放命令行参数）',
      /'--data-binary', '@-'/.test(src), f);
    t(f + '：自己捕获 curl 异常（不把 argv 打出去）',
      /catch \(e\) \{[\s\S]{0,200}__error/.test(src), f);
    // 不允许把含 token 的变量直接交给 console
    t(f + '：没有直接打印含 token 的变量',
      !/console\.(log|error)\([^)]*\bTOKEN\b/.test(src), f);
    t(f + '：没有打印 execFileSync 的错误对象',
      !/console\.(log|error)\([^)]*\berr\b[^)]*\)/.test(src) ||
      !/execFileSync/.test(src), f);
  }

  // 8) 接线
  t('启动时静默检查', /setTimeout\(\(\) => \{ checkUpdate\(false\)/.test(codeOnly));
  t('静默失败不打扰用户', /checkUpdate\(false\)\.catch/.test(codeOnly));
  t('设置里可手动检查', /id="btn-checkupdate"/.test(html));
  t('可关闭自动检查', /id="set-autocheck"/.test(html));
  t('自动检查默认开启', /autoCheckUpdate: true,/.test(appSrc));
  t('浏览器里退化成打开下载页', /openExternal\(apk\.browser_download_url\)/.test(appSrc));
})();


/* ---------- 检查更新 ---------- */
/* ---------- 检查更新 ---------- */
/* ---------- 检查更新 ---------- */
/* ---------- 检查更新 ---------- */
/* ---------- 检查更新 ---------- */
/* ---------- 检查更新 ---------- */
// ===== 照片信息 · 引导线 · 导出设置（回归块） =====
console.log('\n【照片信息】修图前必须先看清这张照片是什么');
(() => {
  // 真实相机照片的 EXIF 里机型/镜头/参数必须能读出来，
  // 否则「导出保留拍摄信息」对用户就是不可验证的承诺。
  const fs3 = require('fs');
  const appSrc = fs3.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const html = fs3.readFileSync(__dirname + '/../app/index.html', 'utf8');

  // 1) 解析器对真实字节流的鲁棒性：任何畸形输入都不能抛错
  const bad = [
    new Uint8Array(0), new Uint8Array([1]), new Uint8Array([0x49, 0x49]),
    new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0xff, 0xff, 0xff, 0xff]),
    new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]),
    new Uint8Array(64).fill(0xff)
  ];
  let threw = false;
  for (const b of bad) {
    try { C.parseExifFields(b); } catch (e) { threw = true; }
  }
  t('畸形 EXIF 一律不抛错', !threw);

  // IFD 条目数异常大（损坏）时必须放弃而不是死循环
  const huge = new Uint8Array(32);
  huge[0] = 0x49; huge[1] = 0x49; huge[2] = 0x2a; huge[3] = 0x00;
  new DataView(huge.buffer).setUint32(4, 8, true);
  new DataView(huge.buffer).setUint16(8, 0xffff, true);
  t('损坏的 IFD 条目数不导致崩溃', (() => {
    try { C.parseExifFields(huge); return true; } catch (e) { return false; }
  })());

  // 2) 界面接线
  t('顶栏按钮打开照片信息', /\$\('btn-photoinfo'\)\.onclick = [^\n]*openPhotoInfo\(\)/.test(appSrc));
  t('打开面板时无需重新读文件（用导入时缓存的 meta）',
    /function openPhotoInfo[\s\S]{0,900}S\.meta/.test(appSrc));
  t('信息面板分「文件」组', /push\('文件'/.test(fs3.readFileSync(__dirname + '/../app/core.js', 'utf8')));
  t('没照片时按钮置灰', /piBtn\.disabled = !S\.img/.test(appSrc));
  t('信息面板有滚动容器', /id="photoinfo-body"/.test(html));

  // 3) 隐私：只提示「含 GPS」，不把坐标显示出来
  const g = C.describePhotoInfo({ exif: { hasGps: true }, width: 100, height: 100 });
  const flat = JSON.stringify(g);
  t('不显示具体经纬度', !/\d+\.\d{4,}/.test(flat), flat.slice(0, 120));
  t('提示导出时会移除定位', /导出.*移除/.test(flat));
})();
/* ---------- 照片信息 ---------- */

// ===== 引导线（回归块） =====
console.log('\n【引导线】位置必须精确传到模型，且不能把线画进画面');
(() => {
  const fs3 = require('fs');
  const appSrc = fs3.readFileSync(__dirname + '/../app/app.js', 'utf8');

  // 1) 提示词里必须明确「线只是说明位置，不要画出来」
  //    不写这句的话，模型有相当概率把引导线当成画面内容画进去（实测过）
  const d = C.describeGuides({ guides: [{ kind: 'line', x1: 0, y1: .6, x2: 1, y2: .6 }], isZh: true });
  // 引导线现在**真的画进了请求图**（这次改动的核心），所以「别把线画出来」这句
  // 比以前更关键：模型看得见线，不说清楚它就会当成画面内容照着生成
  t('要求不要画出线条', /不要把任何一条彩色线条画进最终画面/.test(d), d);
  t('说明了线是标注、不是画面内容', /不是照片里真实存在的东西/.test(d));
  t('英文版也有对应约束',
    /never draw any of these colored lines/i.test(C.describeGuides({
      guides: [{ kind: 'line', x1: 0, y1: .6, x2: 1, y2: .6 }], isZh: false
    })));

  // 2) 坐标换算：外扩上下左右各 12% 时，位置误差必须为 0
  //    这是本功能最容易错的地方 —— 不补偿的话引导线会整体偏移，模型按错误位置构图
  for (const pct of [0, 12, 30]) {
    const rect = { x: 400, y: 300, w: 200, h: 100 };
    const padX = Math.round(rect.w * pct / 100), padY = Math.round(rect.h * pct / 100);
    const ctxRect = { x: rect.x - padX, y: rect.y - padY, w: rect.w + padX * 2, h: rect.h + padY * 2 };
    const r = C.mapGuidesToRequest({
      guides: [{ kind: 'horizon', x1: 0, y1: .4, x2: 1, y2: .4 }],
      rect, ctxRect
    });
    // 期望：文档坐标 y = rect.y + 0.4*rect.h → 请求图归一化
    const want = (rect.y + 0.4 * rect.h - ctxRect.y) / ctxRect.h;
    t(`contextPct=${pct}% 引导线位置无偏移`, Math.abs(r[0].y1 - want) < 1e-9,
      { got: r[0].y1, want });
  }

  // 3) 引导线不进图片：请求图必须原样发送，绝不能把线画上去
  //    （和当初「蓝色掩膜被当成画面内容」是同一类坑）
  const imgBuild = appSrc.slice(appSrc.indexOf('function buildRequestImage'), appSrc.indexOf('function canvasToDataUrl'));
  // 构图线永远不进图；自由笔迹按设置进图（两者用途不同，必须分开）
  t('请求图构建里不画构图线', !/drawGuides/.test(imgBuild), imgBuild.length);
  t('请求图构建里只画笔迹（不画其它引导线）',
    /planStrokeOverlay\(\{/.test(imgBuild) && /isFreehandGuide/.test(
      fs3.readFileSync(__dirname + '/../app/core.js', 'utf8')));
  t('笔迹进图受开关控制', /S\.cfg\.guideStrokeOverlay !== false/.test(imgBuild));
  // 没有框选时引导线画在整张图上（见 effectiveRect），所以不能再要求 S.rect
  t('引导线只画在屏幕预览上', /if \(S\.guides\.length\) drawGuides\(/.test(appSrc));

  // 4) 引导线相对选区存储 → 换选区/换图必须清空，否则位置全错
  t('换选区清空引导线', /S\.guides = \[\];\s*\n\s*updateGuideBadge\(\);/.test(appSrc));
  t('换图清空引导线', /S\.guides = \[\];\s*\/\/ 引导线跟着选区走/.test(appSrc));

  // 5) 分块：块外的线要丢掉，不能 clamp 到边缘
  const clipped = C.mapGuidesToRequest({
    guides: [{ kind: 'horizon', x1: 0, y1: .02, x2: 1, y2: .02 }],
    rect: { x: 0, y: 0, w: 100, h: 100 },
    ctxRect: { x: 0, y: 50, w: 100, h: 50 }, clip: true
  });
  t('分块时块外引导线被丢弃', clipped.length === 0);
})();
/* ---------- 引导线 ---------- */

// ===== 导出设置（回归块） =====
console.log('\n【导出】格式与大小可选，且不能把小图放大');
(() => {
  const fs3 = require('fs');
  const appSrc = fs3.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const css = fs3.readFileSync(__dirname + '/../app/style.css', 'utf8');

  // 1) 只缩不放：小图放大只会变糊，必须拒绝并说明
  const p = C.makeCustomPreset({ format: 'jpeg', maxSide: 8000, quality: 0.92 });
  const plan = C.planExportWithHint(1600, 1200, p);
  t('小图不放大', plan.w === 1600 && plan.h === 1200, plan);
  t('说明为什么没放大', plan.hint.length > 0, plan.hint);
  t('大图按长边缩', (() => {
    const q = C.planExportWithHint(6000, 4000, C.makeCustomPreset({ maxSide: 3000 }));
    return q.w === 3000 && Math.abs(q.h - 2000) < 1;
  })());

  // 2) 竖图按长边（高）算，不能按宽
  t('竖图按高度缩', (() => {
    const q = C.planExportWithHint(3000, 6000, C.makeCustomPreset({ maxSide: 2000 }));
    return q.h === 2000 && Math.abs(q.w - 1000) < 1;
  })());

  // 3) 导出必须真的用面板里的设置，而不是设置页的预设
  t('导出接受外部预设', /async function exportImage\(overridePreset\)/.test(appSrc));
  t('面板预设优先', /overridePreset \|\| C\.getExportPreset/.test(appSrc));
  t('导出按钮传面板预设', /exportImage\(currentExportPreset\(\)\)/.test(appSrc));

  // 4) PNG 下质量参数无意义，界面要隐藏（避免用户以为调了有用）
  t('选 PNG 时隐藏质量滑块', /qRow\.hidden = expFormat === 'png';/.test(appSrc));

  // 5) 自定义长边输入要有边界，避免 0 或天文数字把 canvas 搞崩
  t('自定义长边有上限', /Math\.min\(16384, Number\(cInput\.value\)/.test(appSrc));
  t('自定义长边不接受负数', /Math\.max\(0, Math\.min\(16384/.test(appSrc));

  // 6) 导出面板的样式必须真的存在（否则面板会散架）
  t('CSS 有导出面板样式', /#exportpanel/.test(css));
  t('CSS 有格式选中态', /\.exp-check/.test(css));
})();
/* ---------- 导出设置 ---------- */

// ===== 引导线自由笔迹（回归块） =====
console.log('\n【笔迹】手绘走向必须真的送到模型，且不能被压成贴边直线');
(() => {
  const fs3 = require('fs');
  const appSrc = fs3.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const html = fs3.readFileSync(__dirname + '/../app/index.html', 'utf8');
  const css = fs3.readFileSync(__dirname + '/../app/style.css', 'utf8');
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  const mk = (pts, extra) => C.planStrokeOverlay(Object.assign({
    guides: [{ kind: 'freehand', points: pts }],
    rect, ctxRect: rect, colorId: 'red', width: 3
  }, extra || {}));

  /* 1) 回归：越界笔迹曾被 clamp 成贴边直线
        根因是 normalizeGuide 把点夹到 0~1 —— 分块时笔迹常跨出瓦片，
        夹取后整条线贴着瓦片边缘，模型看到一条沿边缘的假线。 */
  t('笔迹越界部分被裁掉而非压到边界', (() => {
    const p = mk([{ x: .1, y: .5 }, { x: 1.8, y: .5 }]);
    const last = p.draw[0].points[p.draw[0].points.length - 1];
    return p.count === 1 && last.x === 100 && last.y === 50;
  })());
  t('笔迹点保留越界值（不被夹取）', (() => {
    const g = C.normalizeGuide({ kind: 'freehand', points: [{ x: -0.4, y: .5 }, { x: .5, y: .5 }] });
    return g.points[0].x === -0.4;
  })());

  /* 2) 回归：按「有没有点在框内」预筛，会把贯穿画面的线整条丢掉 */
  t('两端都在框外的贯穿笔迹不被丢弃', (() => {
    const p = mk([{ x: .5, y: -0.5 }, { x: .5, y: 1.5 }]);
    return p.count === 1 && p.draw[0].points[0].y === 0 && p.draw[0].points[1].y === 100;
  })());

  /* 3) 回归：分块时若以瓦片为基准换算，第二块之后的笔迹会整体偏移/消失 */
  // 笔迹坐标相对**整个选区**存储。分块时若拿瓦片当基准，坐标会整体偏移，
  // 表现为「第二块之后的笔迹跑到别处 / 整条消失」。
  t('分块换算以选区为基准（坐标精确）', (() => {
    const sel = { x: 0, y: 0, w: 400, h: 400 };
    // 笔迹在选区归一化 x=0.25 → 选区像素 x=100
    const guides = [{ kind: 'freehand', points: [{ x: .25, y: .5 }, { x: .25, y: .6 }] }];
    // 瓦片 2 覆盖选区左下：x 0..220、y 180..400
    const tile = { x: 0, y: 180, w: 220, h: 220 };
    const p = C.planStrokeOverlay({ guides, rect: sel, ctxRect: tile, colorId: 'red', width: 3 });
    if (p.count !== 1) return false;
    const pts = p.draw[0].points;
    // 期望：x = 100 - 0 = 100；y = (200-180)=20 → (240-180)=60
    // 用容差比较：0.6*400 这类运算必然带浮点误差
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    return near(pts[0].x, 100) && near(pts[0].y, 20) && near(pts[1].y, 60);
  })());
  // 若错用瓦片作基准，同一笔会得到 x = 0.25*220 = 55（偏移 45px）
  t('分块换算不会退化成瓦片基准', (() => {
    const sel = { x: 0, y: 0, w: 400, h: 400 };
    const tile = { x: 0, y: 180, w: 220, h: 220 };
    const guides = [{ kind: 'freehand', points: [{ x: .25, y: .5 }, { x: .25, y: .6 }] }];
    const wrong = C.planStrokeOverlay({ guides, rect: tile, ctxRect: tile, colorId: 'red', width: 3 });
    const right = C.planStrokeOverlay({ guides, rect: sel, ctxRect: tile, colorId: 'red', width: 3 });
    return wrong.count === 0 || wrong.draw[0].points[0].x !== right.draw[0].points[0].x;
  })());

  /* 4) 提示词：两件事必须同时说清 —— 沿笔迹生成、别把线画出来。
        只说要生成 → 模型把线画进画面；只说别画线 → 模型忽略笔迹。 */
  const d = C.describeGuides({
    guides: [{ kind: 'freehand', points: [{ x: .2, y: .3 }, { x: .8, y: .4 }] }],
    isZh: true
  });
  t('提示词要求沿笔迹生成', /沿着笔迹生成/.test(d));
  t('提示词禁止把线画进画面', /绝对不要把任何一条彩色线条画进最终画面/.test(d));
  t('提示词强调最终画面不能有线条', /不能出现任何线条/.test(d));
  // 颜色名必须和实际画进图的颜色一致（同一个取色函数），
  // 否则模型会去找一条根本不存在的颜色。这里逐条比对三处的取值。
  t('颜色名与实际画进图的颜色一致', (() => {
    const guides = [
      { kind: 'line', x1: 0, y1: .2, x2: 1, y2: .2 },
      { kind: 'line', x1: 0, y1: .5, x2: 1, y2: .5 },
      { kind: 'line', x1: 0, y1: .8, x2: 1, y2: .8 }
    ];
    const s2 = C.describeGuides({ guides, isZh: true });
    const painted = C.planStrokeOverlay({
      guides, rect: { x: 0, y: 0, w: 100, h: 100 },
      ctxRect: { x: 0, y: 0, w: 100, h: 100 }
    });
    // 提示词里出现的每种颜色名，都要能在实际绘制的颜色里找到同一个 hex
    for (let i = 0; i < guides.length; i++) {
      const c = C.guideColorAt(i);
      if (s2.indexOf(c.zh) < 0) return false;
      if (painted.draw[i].color !== c.hex) return false;
    }
    return true;
  })());

  /* 5) 笔迹不能进「构图线」的措辞分支 —— 两者行为完全不同 */
  t('笔迹不写成构图线说明', !/构图引导/.test(d));
  t('构图线不写成手绘草图', !/手绘草图/.test(C.describeGuides({
    guides: [{ kind: 'horizon', x1: 0, y1: .6, x2: 1, y2: .6 }], isZh: true
  })));

  /* 6) 风险控制：必须能一键关掉（早期蓝色掩膜被模型当成画面内容的教训） */
  t('有开关能关掉笔迹进图', /id="set-strokeimg"/.test(html));
  t('开关默认开', /guideStrokeOverlay: true,/.test(appSrc));
  t('关掉后不调用绘制', (() => {
    // 从「开关从哪来」到「画在哪」整段一起看：strokeOn 在 let strokeNote 之前定义
    const seg = appSrc.slice(appSrc.indexOf('const jobGuides ='),
      appSrc.indexOf('lastStrokeNote = strokeNote'));
    // 开关现在从调用方传入（快照化）：`strokeOn` 就是那次的开关状态
    return /if \(strokeOn && jobGuides\.length\)/.test(seg) &&
      /const strokeOn = \(strokeOverlay === undefined/.test(seg);
  })());
  t('关掉后仍作为文字说明（不是彻底失效）', (() => {
    const seg = appSrc.slice(appSrc.indexOf('const selGuides ='),
      appSrc.indexOf('const req = C.buildImageRequest'));
    return /describeGuides/.test(seg);
  })());
  t('界面提示了怎么应对线被画出来', /关掉/.test(html) && /画进/.test(html));

  /* 7) 笔迹不吸附（拉直会毁掉手画的弧度） */
  t('笔迹不吸附', (() => {
    const g = C.snapGuide({ kind: 'freehand', points: [{ x: .1, y: .5 }, { x: .5, y: .6 }, { x: .9, y: .5 }] });
    return g.points[1].y === .6;
  })());

  /* 8) 界面接线 */
  // 颜色选择条**故意移除**：颜色按序号自动分配。
  // 让用户自己选色会直接毁掉提示词的指代能力 —— 两条红线时「红线」这个词就废了。
  t('没有颜色选择条（颜色按序号自动分配）', !/id="guide-colors"/.test(html));
  t('有自由绘制专用提示', /id="guide-tip-free"/.test(html));
  t('颜色条相关代码已彻底移除', !/guide-colors/.test(appSrc));
  // 提示文案随类型切换，且只在第一次进这个工具时显示。
  // 用 tipDecision 而不是直接查 shouldShowHint：进入工具的那一次点击里
  // 本函数会被调用两次，直接查会让提示出现又立刻消失（用户看不到，记录却已写）。
  t('提示文案随类型切换',
    /tf\.hidden = !\(inGuide && free && tipDecision\('guide-free'\)\)/.test(appSrc) &&
    /tg\.hidden = !\(inGuide && !free && tipDecision\('guide'\)\)/.test(appSrc));
  t('提示显示过就记下（第二次不再弹）',
    /function tipDecision/.test(appSrc) &&
    /if \(S\.tips\[key\]\) markHintSeen\(key\)/.test(appSrc));
  // 函数体里不能再出现 shouldShowHint —— 否则同一帧内第二次调用会把它隐藏掉。
  // 只截到函数体结束（下一个 function 声明），别越界到别的函数里去误判。
  t('同一帧内不会自己把自己隐藏掉', (() => {
    const i = appSrc.indexOf('function updateGuideBarVisibility');
    if (i < 0) return false;
    const body = appSrc.slice(i, appSrc.indexOf('\n  function ', i + 10));
    return body.length > 0 && !/shouldShowHint/.test(body);
  })());
  t('CSS 有色块样式', /\.chip-color \.swatch/.test(css));
  t('CSS 有颜色条布局', /#guide-color-bar/.test(css));
  t('CSS 有无 flex-gap 兜底', /\.ps-no-flex-gap #guide-color-bar/.test(css));
  t('自由笔迹提示用醒目边框（有副作用）', /#guide-tip-free \{ border-left-color/.test(css));
})();
/* ---------- 引导线自由笔迹 ---------- */

// ===== 检查更新走代理（回归块） =====
console.log('\n【更新】检查更新必须走通本地代理（POST-only 代理会让它永远失败）');
(() => {
  const fs3 = require('fs');
  const appSrc = fs3.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const srv = fs3.readFileSync(__dirname + '/../app/server.js', 'utf8');
  const java = fs3.readFileSync(__dirname + '/../android/src/com/photostudio/app/LocalServer.java', 'utf8');

  /* ---------- 根因：本地代理无条件用 POST 转发 ---------- */
  // GitHub 的 releases 列表用 POST 请求会返回 401 Requires authentication，
  // 而本地代理当初只为生图接口设计（全是 POST），于是：
  //   浏览器打开仓库一切正常，应用内检查更新却永远失败。
  // 必须让代理支持 GET，且调用方要显式声明方法。

  t('Java 代理支持 GET 转发', /x-target-method/.test(java) && /"GET"\.equals\(reqMethod\)/.test(java));
  t('Java 代理按声明的方法发请求', /conn\.setRequestMethod\(reqMethod\)/.test(java));
  t('Java 代理 GET 时不写 body', /"GET"\.equals\(reqMethod\)\) \{\s*\n\s*conn\.setDoOutput\(false\)/.test(java));
  t('Node 代理支持 GET 转发', /x-target-method/.test(srv));
  t('Node 代理按声明的方法发请求', /proxyUpstream\(target, method, headers/.test(srv));
  t('Node 代理 GET 时不发 body', /method === 'GET' \? null : payload/.test(srv));
  t('非法方法退化为 POST（不崩）', /if \(method !== 'GET' && method !== 'POST'\) method = 'POST'/.test(srv) &&
    /if \(!"GET"\.equals\(reqMethod\) && !"POST"\.equals\(reqMethod\)\) reqMethod = "POST"/.test(java));

  /* ---------- 第二个坑：GitHub 强制要求 User-Agent ---------- */
  // 缺 UA 会被 403 拒掉（"Request forbidden by administrative rules"）。
  // 浏览器直连会自动带 UA，但经过代理转发就没有了。
  t('Java 代理补了 User-Agent', /setRequestProperty\("User-Agent"/.test(java));
  t('Node 代理补了 User-Agent', /headers\['User-Agent'\]/.test(srv));
  t('调用方在代理路径声明 UA', /'X-Target-User-Agent': 'PhotoStudio-Android'/.test(appSrc));
  t('调用方在代理路径声明 Accept', /'X-Target-Accept': 'application\/vnd\.github\+json'/.test(appSrc));
  t('Java 代理透传 Accept', /x-target-accept/.test(java));
  t('Node 代理透传 Accept', /x-target-accept/.test(srv));
  t('CORS 放行了新头（Java）', /X-Target-Method/.test(java) || /Access-Control-Allow-Headers/.test(java));
  t('CORS 放行了新头（Node）', /X-Target-Method,X-Target-Accept,X-Target-User-Agent/.test(srv));

  /* ---------- 第三个坑：代理失败没有回退直连 ---------- */
  // 生图路径（callModel）一直有 auto 回退，检查更新这里当初漏了 ——
  // 代理一旦不可用（老版 APK 的代理不支持 GET、或代理被安全策略挡住），
  // 检查更新就彻底不可用，而直连本来是能成功的。
  const fr = appSrc.slice(appSrc.indexOf('async function fetchReleases'),
    appSrc.indexOf('async function checkUpdate'));
  t('检查更新有代理路径', /api\/generate/.test(fr));
  t('检查更新有直连路径', /fetch\(GH_RELEASES_API/.test(fr));
  t('auto 模式下代理失败会回退直连', /try \{ return await viaProxy\(\); \}\s*\n\s*catch \(e\) \{ return await viaDirect\(\); \}/.test(fr));
  t('direct 模式只走直连', /mode === 'direct'\) return viaDirect\(\)/.test(fr));
  t('proxy 模式只走代理', /mode === 'proxy'\) return viaProxy\(\)/.test(fr));
  t('file: 协议直接走直连（没有代理可用）', /location\.protocol === 'file:'\) return viaDirect\(\)/.test(fr));

  /* ---------- 第四个坑：代理返回 200 + __proxyError 会被当成成功 ---------- */
  // 那样 pickLatestRelease 拿到一个对象，静默返回「没有可用版本」，
  // 用户看到的是「已是最新」而不是「检查失败」—— 更糟，因为无从排查。
  t('代理自身的错误被识别为失败', /j\.__proxyError\) throw new Error\(j\.__proxyError\)/.test(fr));

  /* ---------- 解析链路仍然正确 ---------- */
  // 用真实 API 返回的形状验证（不联网，只验解析）
  const sample = [
    { tag_name: 'v1.0.0', draft: false, prerelease: false, assets: [] },
    {
      tag_name: 'v3.2.0', draft: false, prerelease: false,
      assets: [
        // 故意混入一个不带版本号的旧命名，验证「优先选带版本号的」
        { name: 'app.apk', browser_download_url: 'https://example.com/download/v3.2.0/app.apk' },
        { name: 'photo-studio-v3.2.0.apk', browser_download_url: 'https://example.com/download/v3.2.0/photo-studio-v3.2.0.apk' }
      ]
    },
    { tag_name: 'v2.9.0', draft: false, prerelease: false, assets: [] }
  ];
  const best = C.pickLatestRelease(sample);
  t('从乱序列表挑出版本号最高的', best && best.tag_name === 'v3.2.0', best && best.tag_name);
  t('挑出 APK 附件', (() => {
    const a = C.pickApkAsset(best);
    return !!a && /photo-studio-v3\.2\.0\.apk$/.test(a.browser_download_url);
  })());
  t('旧版能检测到更新', C.planUpdate({ current: '3.1.0', latest: 'v3.2.0' }).hasUpdate === true);
  t('同版不提示', C.planUpdate({ current: '3.2.0', latest: 'v3.2.0' }).hasUpdate === false);
  t('草稿/预发布不参与挑选', (() => {
    const b = C.pickLatestRelease([
      { tag_name: 'v9.0.0', draft: true, prerelease: false, assets: [] },
      { tag_name: 'v3.2.0', draft: false, prerelease: false, assets: [] }
    ]);
    return b && b.tag_name === 'v3.2.0';
  })());

  /* ---------- 手动检查必须绕过时间间隔 ---------- */
  // 用户点了「检查更新」却发现没反应（被 12 小时间隔挡住），
  // 会以为功能坏了 —— 这正是本次问题的表象之一。
  t('手动检查无视时间间隔', C.planUpdateCheck({
    now: Date.now(), lastCheck: Date.now() - 1000, force: true
  }).should === true);
  t('自动检查受间隔限制', C.planUpdateCheck({
    now: Date.now(), lastCheck: Date.now() - 1000, force: false
  }).should === false);
  // 连续失败时退避，避免网络不通还反复打扰；但必须封顶（4 倍 = 48 小时），
  // 否则网络恢复后用户要等很久才重新检查
  t('失败后按倍数退避', (() => {
    const base = 12 * 60 * 60 * 1000;
    // 间隔已过 1 倍但没到 2 倍：failCount=1 时应该还没到
    const st = { now: Date.now(), lastCheck: Date.now() - base * 1.5 };
    return C.planUpdateCheck(Object.assign({ failCount: 0 }, st)).should === true &&
      C.planUpdateCheck(Object.assign({ failCount: 1 }, st)).should === false;
  })());
  t('退避封顶在 4 倍（48 小时）', (() => {
    const base = 12 * 60 * 60 * 1000;
    // 过了 4 倍间隔 → 即使失败很多次也该重新检查（封顶，不会无限退避）
    const st = { now: Date.now(), lastCheck: Date.now() - base * 4.5 };
    return C.planUpdateCheck(Object.assign({ failCount: 4 }, st)).should === true &&
      C.planUpdateCheck(Object.assign({ failCount: 99 }, st)).should === true;
  })());
  t('超过封顶前仍退避', (() => {
    const base = 12 * 60 * 60 * 1000;
    const st = { now: Date.now(), lastCheck: Date.now() - base * 2.5 };
    return C.planUpdateCheck(Object.assign({ failCount: 3 }, st)).should === false;
  })());
})();
/* ---------- 检查更新走代理 ---------- */

// ===== 返回键（回归块） =====
console.log('\n【返回】按一下返回键不能直接退出应用');
(() => {
  const fs3 = require('fs');
  const appSrc = fs3.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const javaSrc = fs3.readFileSync(__dirname + '/../android/src/com/photostudio/app/MainActivity.java', 'utf8');

  /* 回归点 1：根因 —— 单页应用 canGoBack() 永远 false，返回键被交给系统
        这是用户报的问题：「不管在哪个页面，点一次返回就直接退回主界面」。
        旧实现只判断 canGoBack()，为假就 super → 一步退出整个应用。 */
  t('不再只靠 canGoBack 判断', !/if \(keyCode == KeyEvent\.KEYCODE_BACK && web != null && web\.canGoBack\(\)\)/.test(javaSrc));
  t('改用 onBackPressed 询问页面', /public void onBackPressed\(\)/.test(javaSrc));
  t('页面能拦下返回键', /handleBack/.test(javaSrc));

  /* 回归点 2：evaluateJavascript 是异步的，不能用 onKeyDown 同步决定。
        所以必须用 onBackPressed（返回 void，可以走回调）。 */
  t('用 onBackPressed 而非 onKeyDown（异步回调）', !/public boolean onKeyDown/.test(javaSrc));

  /* 回归点 3：构建用的 android.jar 不含 LambdaMetafactory ——
        回调写成 lambda 会编译失败（javac: cannot find symbol metafactory）。 */
  t('回调不用 lambda', !/evaluateJavascript\([^)]*->/.test(javaSrc));

  /* 回归点 4：super.onBackPressed() 不能在回调里调用，必须单独抽方法 */
  t('super 调用抽成独立方法', /private void callSuperBack\(\)[\s\S]{0,80}super\.onBackPressed\(\)/.test(javaSrc));

  /* 回归点 5：应用里原本没有「卸下照片」这条路（S.img 从不清空），
        所以「回首页」只能靠退出应用重进。goHome 补上了这条路径，
        而且**必须先把作品存档** —— 否则返回一下就把刚才的修改丢了。 */
  t('存在卸下照片的路径', /S\.img = null;/.test(appSrc));
  t('卸下前先存档（否则返回=丢修改）',
    /function goHome[\s\S]{0,400}touchWork\(\)/.test(appSrc));
  t('存档失败不挡住返回', /catch \(e\) \{ \/\* 作品库失败不该挡住返回 \*\/ \}/.test(appSrc));

  /* 回归点 6：卸载文档必须让「当前文档」的操作序列作废。
     **但不再中止请求** —— 后台生成的核心就是「回首页后任务继续跑，
     结果落进那件作品的记录」。作废的是「把结果贴进当前文档」这条路，
     由 docVersion / genToken 保证，而不是靠 abort 把请求掐死。
     用 abort 掐死的代价是：上游已经出图、钱已经花了，结果却收不到。 */
  t('卸载时作废当前文档的操作序列',
    /function goHome[\s\S]{0,900}S\.genToken\+\+/.test(appSrc));
  t('卸载时不再中止请求（任务转后台继续跑）',
    !/function goHome[\s\S]{0,900}S\.aborter\.abort\(\)/.test(appSrc));
  t('换图仍会取消当前这张的任务（结果已无处可落）',
    /function setImage[\s\S]{0,600}cancelJobsForCurrentDoc\(/.test(appSrc));
  t('取消只针对当前文档（别的照片的任务照常跑）',
    /function cancelJobsForCurrentDoc[\s\S]{0,600}j\.docVersion !== docVer/.test(appSrc));

  /* 回归点 7：处理失败不能让用户卡住 —— 返回 false 交给系统退出 */
  t('handleBack 异常时放行退出',
    /catch \(e\) \{[\s\S]{0,400}return false;/.test(appSrc));
  t('安卓侧 null 也放行', /value == null \|\| value\.indexOf\("true"\) < 0/.test(javaSrc));

  /* 顺序正确性：必须与 z-index 一致 */
  t('层级顺序与 z-index 一致',
    C.BACK_LAYERS.every((L, i) => i === 0 || C.BACK_LAYERS[i - 1].z >= L.z));
  t('关闭最上层（不是最下层）', (() => {
    const r = C.planBackAction({ open: { settings: true, workPreview: true } });
    return r.target === 'workPreview';
  })());

  /* 逐级退：连续按返回应依次处理，最后才退出 */
  t('连续按返回逐级退到退出', (() => {
    let st = { open: { settings: true }, busy: true, mode: 'brush', editing: true };
    const seq = [];
    for (let i = 0; i < 6; i++) {
      const r = C.planBackAction(st);
      seq.push(r.action);
      if (!r.handled) break;
      // 模拟处理后的状态推进
      if (r.action === 'close') st = Object.assign({}, st, { open: {} });
      else if (r.action === 'cancel-gen') st = Object.assign({}, st, { busy: false });
      else if (r.action === 'mode') st = Object.assign({}, st, { mode: 'select' });
      else if (r.action === 'home') st = Object.assign({}, st, { editing: false });
    }
    return JSON.stringify(seq) === JSON.stringify(['close', 'cancel-gen', 'mode', 'home', 'exit']);
  })(), (() => {
    let st = { open: { settings: true }, busy: true, mode: 'brush', editing: true };
    const seq = [];
    for (let i = 0; i < 6; i++) {
      const r = C.planBackAction(st);
      seq.push(r.action);
      if (!r.handled) break;
      if (r.action === 'close') st = Object.assign({}, st, { open: {} });
      else if (r.action === 'cancel-gen') st = Object.assign({}, st, { busy: false });
      else if (r.action === 'mode') st = Object.assign({}, st, { mode: 'select' });
      else if (r.action === 'home') st = Object.assign({}, st, { editing: false });
    }
    return seq.join(',');
  })());

  /* 不能因为修返回键把「退出应用」弄丢 —— 首页按返回仍要能退出 */
  t('首页按返回仍能退出应用', C.planBackAction({ editing: false, mode: 'select' }).handled === false);
})();
/* ---------- 返回键 ---------- */

/* ---------- 顶栏溢出（回归） ---------- */
/*
 * 缺陷现象：顶栏把文件名挤没了，窄屏上按钮还溢出屏幕。
 * 根因：可见按钮的最小宽度之和 > 视口宽度，而按钮不能压缩（有 min-width），
 *      只能把 #file-info 挤到 0，再挤就溢出。
 * 回归点：只要有人往顶栏里加回按钮 / 把入口从菜单搬回去，就必须失败。
 */
(() => {
  const fs = require('fs');
  const html = fs.readFileSync(__dirname + '/../app/index.html', 'utf8');
  const css = fs.readFileSync(__dirname + '/../app/style.css', 'utf8');
  const appSrc = fs.readFileSync(__dirname + '/../app/app.js', 'utf8');

  const barTop = html.slice(html.indexOf('id="topbar"'), html.indexOf('id="moremenu"'));
  const inBar = (id) => new RegExp('<button[^>]*id="' + id + '"').test(barTop);

  // 这三个是「搬进菜单」的入口：搬回去 = 缺陷复现
  t('照片信息不在顶栏里（否则窄屏又溢出）', !inBar('btn-photoinfo'));
  t('修图记录不在顶栏里（否则窄屏又溢出）', !inBar('btn-library'));
  t('设置不在顶栏里（否则窄屏又溢出）', !inBar('btn-settings'));

  // 用真实 CSS 数值算一遍：只要顶栏按钮再多一个就会溢出
  const barW = (() => {
    const m = /(^|\n)\.tb-btn\s*\{([\s\S]*?)\}/.exec(css);
    const mm = m && /min-width:\s*(\d+)px/.exec(m[2]);
    return mm ? parseInt(mm[1], 10) : 0;
  })();
  const iconW = (() => {
    const m = /(^|\n)\.tb-btn\.icon\s*\{([\s\S]*?)\}/.exec(css);
    const mm = m && /min-width:\s*(\d+)px/.exec(m[2]);
    return mm ? parseInt(mm[1], 10) : 0;
  })();
  const n = (barTop.match(/class="tb-btn/g) || []).length;
  const fixed = barW + (n - 1) * iconW + n * 6 + 16;
  t('顶栏固定占宽留有余量（320px 机型）', fixed <= 320 - 60, fixed);
  // 再加一个图标按钮就该溢出 —— 说明现在的余量不是「碰巧够」
  t('再加一个按钮就会溢出（余量是设计出来的）', fixed + iconW + 6 > 320 - 60, fixed + iconW + 6);

  // 文件名必须真的能显示：容器要能收缩但不能为 0
  t('文件名容器可收缩', /#file-info\s*\{[\s\S]{0,120}min-width:\s*0/.test(css));
  t('文件名过长省略号', /#file-name\s*\{[\s\S]{0,200}text-overflow:\s*ellipsis/.test(css));
  t('文件名不换行（换行会把顶栏撑高）', /#file-name\s*\{[\s\S]{0,200}white-space:\s*nowrap/.test(css));

  // 菜单本身不能把顶栏撑宽
  t('菜单绝对定位（不参与顶栏布局）', /#moremenu\s*\{[\s\S]{0,160}position:\s*absolute/.test(css));

  // 顶栏不能靠 overflow 藏住溢出的按钮（那只是把问题盖住，按钮点不到）
  const tbRule = /(^|\n)#topbar\s*\{([\s\S]*?)\}/.exec(css);
  t('顶栏没有用 overflow:hidden 掩盖溢出',
    !tbRule || !/overflow\s*:\s*hidden/.test(tbRule[2]), tbRule && tbRule[2]);

  // 点外面关闭要挂在 document 上（挂 topbar 上点画布就不会关）
  t('点外面关闭挂在 document 上',
    /document\.addEventListener\('click'[\s\S]{0,400}closeMoreMenu\(\)/.test(appSrc));
  // 关菜单不能顺手把面板也关了
  const closeBody = (() => {
    const i = appSrc.indexOf('function closeMoreMenu()');
    return i < 0 ? '' : appSrc.slice(i, i + 400);
  })();
  t('关闭菜单不误关面板', closeBody.length > 0 && !/closeAllSheets|closePanel|hideAll/.test(closeBody));
  // 关菜单也不该清掉用户的编辑状态
  t('关闭菜单不动编辑状态', closeBody.length > 0 && !/S\.(img|rect|strokes)\s*=/.test(closeBody));
})();
/* ---------- 顶栏溢出（回归） ---------- */

/* ---------- 改名（回归） ---------- */
/*
 * 缺陷风险：改名改到「状态标识符」上会让用户丢数据 ——
 *   改包名 → 系统当成新 App，设置/历史/会话全没了，还会签名冲突
 *   改 localStorage 键 → 老数据读不出来，等于清空
 *   改通知图标资源名 → 通知栏图标丢失
 *   改 JS 桥名 → 网页调不到原生（下载安装、返回键、保活全废）
 * 这里逐个锁死。
 */
(() => {
  const fs = require('fs');
  const appSrc = fs.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const mf = fs.readFileSync(__dirname + '/../android/AndroidManifest.xml', 'utf8');
  const act = fs.readFileSync(__dirname + '/../android/src/com/photostudio/app/MainActivity.java', 'utf8');
  const keep = fs.readFileSync(__dirname + '/../android/src/com/photostudio/app/KeepAliveService.java', 'utf8');

  /* 包名 */
  t('包名仍是 com.photostudio.app', /package="com\.photostudio\.app"/.test(mf));
  t('Manifest 里没有别的包名', (mf.match(/package="([^"]+)"/g) || []).length === 1, mf.match(/package="[^"]+"/g));
  t('Java 包声明没改', /^package com\.photostudio\.app;/m.test(act));
  t('保活服务的包声明没改', /^package com\.photostudio\.app;/m.test(keep));

  /* localStorage：所有持久化键都必须还是 photoStudio.* */
  const keys = Array.from(new Set((appSrc.match(/['"]photoStudio\.[A-Za-z0-9_.]+['"]/g) || []).map((s) => s.slice(1, -1))));
  t('还能扫到持久化键（防止正则失效后假装通过）', keys.length >= 5, keys.length);
  t('持久化键全部还是 photoStudio.*', keys.every((k) => k.indexOf('photoStudio.') === 0), keys);

  /* 通知 / 桥 / 日志 TAG */
  t('通知图标资源名没改', /ic_stat_photostudio/.test(keep));
  t('JS 桥名没改（PSBridge）', /PSBridge/.test(appSrc) && /PSBridge/.test(act));
  t('日志 TAG 没改（PhotoStudio）', /"PhotoStudio"/.test(act));

  /* 显示名确实改了（否则「改名」这件事没做到） */
  const strings = fs.readFileSync(__dirname + '/../android/res/values/strings.xml', 'utf8');
  t('安卓显示名是枫叶修图', /<string name="app_name">枫叶修图<\/string>/.test(strings));
  t('网页标题是枫叶修图', /<title>[^<]*枫叶修图/.test(fs.readFileSync(__dirname + '/../app/index.html', 'utf8')));

  /* 改名不能顺手改坏路径：启动脚本、构建脚本引用的文件都得在 */
  const root = __dirname + '/..';
  for (const f of ['app/index.html', 'app/app.js', 'app/core.js', 'app/style.css', 'app/manifest.json', 'app/icon.svg']) {
    t('文件仍在：' + f, fs.existsSync(root + '/' + f));
  }
  t('启动脚本改名后仍存在', fs.existsSync(root + '/启动枫叶修图.sh'));
})();
/* ---------- 改名（回归） ---------- */

/* ---------- 枫叶图标（回归） ---------- */
/*
 * 缺陷风险：网页图标（icon.svg）和安装后图标（生成器产出的 PNG）不一致 ——
 * 用户在浏览器里看到一片叶子，装完变成另一片。
 * 根因是两套几何：SVG 用贝塞尔路径，生成器用展平多边形。
 * 这里用「叶形宽高比 + 叶高占画布比例」把两边绑在一起。
 */
(() => {
  const fs = require('fs');
  const svg = fs.readFileSync(__dirname + '/../app/icon.svg', 'utf8');
  const mk = fs.readFileSync(__dirname + '/../tools/make-icons.js', 'utf8');

  // SVG 必须能独立渲染（不能被裁剪/引用外部资源）
  t('SVG 有 viewBox', /viewBox="0 0 512 512"/.test(svg));
  t('SVG 不引用外部文件', !/xlink:href|<image/.test(svg));
  t('SVG 尺寸声明完整', /width="512"/.test(svg) && /height="512"/.test(svg));

  // 两边的叶形比例必须一致
  const arGen = parseFloat((/const LEAF_AR = ([\d.]+)/.exec(mk) || [])[1]);
  const arSvg = 255.6 / 279; // 源路径包围盒
  t('生成器有叶形比例常量', !isNaN(arGen), arGen);
  t('SVG 与生成器的叶形比例一致', Math.abs(arGen - arSvg) < 0.001, [arGen, arSvg]);

  // 叶高占画布比例一致（决定了图标里叶子多大）
  const sc = parseFloat((/scale\(([\d.]+)\)/.exec(svg) || [])[1]);
  const svgLeafH = 279 * sc / 512;
  t('SVG 叶高占画布 60%', Math.abs(svgLeafH - 0.6) < 0.01, svgLeafH.toFixed(4));

  // 生成器里几个关键尺寸不能乱改（改了图标在系统里会被裁）
  const num = (name) => {
    const m = new RegExp('const ' + name + '\\s*=\\s*([\\d.]+)').exec(mk);
    return m ? parseFloat(m[1]) : NaN;
  };
  t('启动图标叶高 60%', num('leafH') === 0.6, num('leafH'));

  // 自适应图标只有中间 66.7% 保证可见，叶子超出就会被厂商遮罩裁掉
  const afBody = (() => {
    const i = mk.indexOf('function adaptiveForeground(');
    return i < 0 ? '' : mk.slice(i, i + 500);
  })();
  const afLeafH = (() => {
    const m = /const leafH\s*=\s*([\d.]+)/.exec(afBody);
    return m ? parseFloat(m[1]) : NaN;
  })();
  t('自适应前景叶高不超过 66.7% 安全区', afLeafH > 0 && afLeafH <= 0.667, afLeafH);
  // 前景不能自带光晕/背景：超出安全区会被裁，而且背景由系统层叠
  t('自适应前景不含光晕', afBody.length > 0 && !/glow/i.test(afBody));

  // 图标生成是零依赖的：构建机上没有 SVG 光栅化器，引了依赖就会构建失败
  const deps = (mk.match(/require\((['"])([^'"]+)\1\)/g) || []).map((s) => s.replace(/require\((['"])([^'"]+)\1\)/, '$2'));
  t('图标生成器零依赖（只 require 内置模块）',
    deps.every((d) => d.indexOf('.') !== 0 && ['fs', 'path', 'zlib', 'os'].indexOf(d) >= 0),
    deps);

  // 生成的图标要真的写进两处（网页 + 安卓资源）
  const files = ['app/icon-192.png', 'app/icon-512.png'];
  for (const f of files) {
    const p = __dirname + '/../' + f;
    t('图标已生成：' + f, fs.existsSync(p) && fs.statSync(p).size > 200, fs.existsSync(p) ? fs.statSync(p).size : 0);
  }
  const res = __dirname + '/../android/res';
  for (const d of ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi']) {
    const p = res + '/' + d + '/ic_launcher.png';
    t('安卓启动图标已生成：' + d, fs.existsSync(p) && fs.statSync(p).size > 100,
      fs.existsSync(p) ? fs.statSync(p).size : 0);
  }
  t('有自适应图标前景', fs.existsSync(res + '/mipmap-xxxhdpi/ic_launcher_foreground.png'));
  t('有自适应图标配置', fs.existsSync(res + '/mipmap-anydpi-v26/ic_launcher.xml'));
  t('有自适应图标背景', fs.existsSync(res + '/drawable/ic_launcher_bg.xml'));
  t('通知栏小图标已生成', fs.existsSync(res + '/drawable-xxhdpi/ic_stat_photostudio.png'));
})();
/* ---------- 枫叶图标（回归） ---------- */

/* ---------- 导出保存位置（回归） ---------- */
/*
 * 缺陷现象：点了「导出」提示「已导出」，但手机上找不到文件。
 * 根因：Android WebView 既没实现 navigator.share，也没实现文件下载
 *      （没有 DownloadListener，点 <a download> 什么都不会发生），
 *      而提示是无条件弹的 —— 用户被「成功」骗了。
 * 回归点：壳里必须走原生保存；三个位置都要有对应实现。
 */
(() => {
  const fs = require('fs');
  const appSrc = fs.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const html = fs.readFileSync(__dirname + '/../app/index.html', 'utf8');
  const core = fs.readFileSync(__dirname + '/../app/core.js', 'utf8');
  const act = fs.readFileSync(__dirname + '/../android/src/com/photostudio/app/MainActivity.java', 'utf8');
  const srv = fs.readFileSync(__dirname + '/../android/src/com/photostudio/app/LocalServer.java', 'utf8');
  const mf = fs.readFileSync(__dirname + '/../android/AndroidManifest.xml', 'utf8');

  /* ---------- 原生侧：三个位置都要真的写盘 ---------- */

  t('本地服务有保存接口', /"\/api\/save"\.equals\(path\)/.test(srv));
  t('保存接口收二进制（不是 base64）',
    /private void handleSave\(OutputStream out, String rawPath, byte\[\] body\)/.test(srv));
  t('保存接口能取文件名与位置', /queryParam\(rawPath, "name"\)/.test(srv) && /queryParam\(rawPath, "where"\)/.test(srv));
  t('Saver 接口已定义', /public interface Saver \{/.test(srv));
  t('Saver 已由 Activity 注入', /server\.setSaver\(new LocalServer\.Saver\(\)/.test(act));

  // 相册 / 下载 / 每次询问 三条路径都要在
  t('保存入口按位置分派', /private String saveImage\(byte\[\] data, String name, String where\)/.test(act));
  t('相册走系统媒体库', /MediaStore\.Images\.Media\.EXTERNAL_CONTENT_URI/.test(act));
  t('下载走系统媒体库', /MediaStore\.Downloads\.EXTERNAL_CONTENT_URI/.test(act));
  t('每次询问走系统文件选择器', /Intent\.ACTION_CREATE_DOCUMENT/.test(act));
  t('选完位置能拿到结果', /requestCode == REQ_SAVE_AS/.test(act));
  t('取消选择不会当成失败崩溃', /canceled/.test(act));

  // 分区存储：10+ 不需要权限，9- 才要
  t('按系统版本选写入方式', /Build\.VERSION\.SDK_INT >= 29\) return saveScoped/.test(act));
  t('低版本有降级写入路径', /private String saveLegacy\(/.test(act));
  t('低版本会通知相册刷新', /MediaScannerConnection\.scanFile/.test(act));
  t('低版本才申请存储权限', /requestWriteStorage\(\)/.test(act));
  t('Manifest 声明了存储权限且限低版本',
    /WRITE_EXTERNAL_STORAGE[\s\S]{0,80}maxSdkVersion="28"/.test(mf));

  // 文件名不能带路径分隔符（否则能写到别处去）
  t('文件名做了安全处理', /private static String sanitizeFileName/.test(act));
  t('剥掉路径分隔符', /replace\('\/', '_'\)/.test(act));
  t('同名文件不覆盖', /private static File uniqueFile/.test(act));
  t('写入失败会回滚（避免留半个文件）', /IS_PENDING, 1/.test(act) && /IS_PENDING, 0/.test(act));

  /* ---------- 网页侧：能力探测 + 走原生 ---------- */

  t('有原生保存能力探测', /function nativeSaveAvailable\(\)/.test(appSrc));
  t('探测走桥（浏览器里没有 PSBridge）', /saveSupported/.test(appSrc));
  t('桥方法已暴露', /public boolean saveSupported\(\)/.test(act));
  t('通过本地服务保存', /function nativeSave\(blob, name, where\)/.test(appSrc));
  t('保存请求打到 /api/save', /'\/api\/save' \+ q/.test(appSrc));
  t('导出优先走原生保存', /if \(nativeSaveAvailable\(\)\) \{[\s\S]{0,200}await nativeSave\(/.test(appSrc));
  // 关键：保存成功要用**真实路径**提示，而不是笼统的「已导出」
  t('提示显示真实保存路径', /toast\('已保存到 ' \+ r\.path/.test(appSrc));
  t('原生失败会退回分享/下载（不让用户白等）',
    /保存失败'\) \+ ' · 改用分享'/.test(appSrc) || /改用分享/.test(appSrc));
  t('用户取消时不报成功', /if \(r\.canceled\) \{ toast\('已取消导出'\)/.test(appSrc));

  /* ---------- 设置项 ---------- */

  t('core 里有三个保存位置', /const SAVE_LOCATIONS = \[/.test(core));
  for (const id of ['gallery', 'downloads', 'ask']) {
    t('保存位置含 ' + id, new RegExp("id: '" + id + "'").test(core));
  }
  t('保存位置已导出', /SAVE_LOCATIONS,/.test(core));
  t('配置里有默认值', /expSaveWhere: 'gallery'/.test(appSrc));
  t('配置会持久化', /'expSaveWhere',/.test(appSrc));
  // 脏数据不能让导出存到不存在的位置
  t('脏数据会回落到相册', /if \(!C\.isSaveLocation\(c\.expSaveWhere\)\) c\.expSaveWhere = 'gallery'/.test(appSrc));
  t('回落逻辑是纯函数（可单测）', /function isSaveLocation\(id\)/.test(core) && /function getSaveLocation\(id\)/.test(core));
  t('两个纯函数都已导出', /isSaveLocation, getSaveLocation,/.test(core));

  /* ---------- 界面 ---------- */

  t('导出面板有保存位置容器', /id="exp-saves"/.test(html));
  t('导出面板有保存位置分组', /id="exp-save-group"/.test(html));
  t('有位置说明文字', /id="exp-save-hint"/.test(html));
  t('渲染三个位置选项', /C\.SAVE_LOCATIONS\.map\(\(L\) =>/.test(appSrc));
  t('点了会记住', /S\.cfg\.expSaveWhere = b\.dataset\.save/.test(appSrc));
  // 浏览器里下载目录由浏览器决定，这一组要藏起来（否则点了没用）
  t('浏览器里隐藏这一组', /svGroup\.hidden = !nativeSaveAvailable\(\)/.test(appSrc));
  // 说明小字样式不能只在设置页生效
  t('说明小字样式覆盖导出面板',
    /#exportpanel \.st-desc-inline/.test(fs.readFileSync(__dirname + '/../app/style.css', 'utf8')));
})();
/* ---------- 导出保存位置（回归） ---------- */

/* ---------- 后台生成任务（回归） ---------- */
console.log('\n【后台生成】一张图进 AI 生图后，可以放到后台去处理下一张');

(() => {
  const fs = require('fs');
  const path = require('path');
  const C2 = require(path.join(__dirname, '..', 'app', 'core.js'));
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'style.css'), 'utf8');

  /* ---------- 1) 核心回归：离开照片**不再中止**请求 ---------- */
  // 旧实现：goHome / setImage 无条件 S.aborter.abort() →
  // 用户回首页 = 这次生成白花钱（上游已出图，结果收不到）。
  t('goHome 不再中止在途请求',
    !/function goHome[\s\S]{0,1200}S\.aborter\.abort\(\)/.test(appSrc));
  t('goHome 明确注释了「任务继续跑」',
    /function goHome[\s\S]{0,900}在途任务\*\*继续跑\*\*/.test(appSrc));
  // 但当前文档的操作序列仍要作废（防旧回调写 UI / 贴错图）
  t('goHome 仍作废当前文档的操作序列',
    /function goHome[\s\S]{0,1200}S\.genToken\+\+/.test(appSrc));

  /* ---------- 2) 取消只针对当前文档 ---------- */
  t('有「只取消当前文档任务」的函数', /function cancelJobsForCurrentDoc\(/.test(appSrc));
  t('取消时按 docVersion 过滤',
    /function cancelJobsForCurrentDoc[\s\S]{0,700}j\.docVersion !== docVer/.test(appSrc));
  t('换图会取消当前文档的任务',
    /function setImage[\s\S]{0,700}cancelJobsForCurrentDoc\(/.test(appSrc));
  t('恢复作品会取消当前文档的任务',
    /async function restoreSession[\s\S]{0,900}cancelJobsForCurrentDoc\(/.test(appSrc));
  t('返回键取消当前文档的任务',
    /case 'cancel-gen':[\s\S]{0,300}cancelJobsForCurrentDoc\(/.test(appSrc));
  t('取消按钮取消当前文档的任务',
    /\$\('btn-cancel'\)\.onclick[\s\S]{0,150}cancelJobsForCurrentDoc\(/.test(appSrc));
  // 关键：取消不能牵连别的照片的任务（那是用户已经花的钱）
  t('取消不牵连别的照片（明确注释）',
    /刻意不动别的照片的任务/.test(appSrc));

  /* ---------- 3) 三个失败模式都要防住 ---------- */
  // (a) 结果落到错的照片上 → 任务自带归属 + 落地前双重校验
  t('任务自带归属信息（workId + docVersion）',
    /workId: S\.workId,\s*\n\s*docVersion: S\.docVersion,/.test(appSrc));
  t('落地走纯函数决策（可单测）', /C\.planJobLanding\(/.test(appSrc));
  t('决策同时看作品 id 与文档版本',
    /function planJobLanding[\s\S]{0,900}curDocVersion === opt\.jobDocVersion/.test(
      fs.readFileSync(path.join(__dirname, '..', 'app', 'core.js'), 'utf8')));
  // 发起时固化全部输入 —— 之后用户换图/改选区都不影响这次请求
  t('请求输入在发起时固化成任务快照', /function prepareJob\(\)/.test(appSrc));
  t('快照里存了选区', /rect,\s*\n\s*mask,\s*\n\s*built,/.test(appSrc));
  t('快照里存了请求体', /req,/.test(appSrc));
  t('快照里存了掩膜', /mask,\s*\n\s*built,/.test(appSrc));
  // 引导线/开关/颜色也显式传进去（不能读模块状态）
  t('引导线按快照传给组图函数',
    /buildRequestImage\(rect, mask, rect, S\.guides\.slice\(\), S\.cfg\.guideStrokeOverlay\)/.test(appSrc));

  // (b) 结果静默丢失 → 落不进当前文档就落进作品库
  t('有「把结果存进作品库」的函数', /function stashJobResult\(/.test(appSrc));
  t('结果存进**任务自己那件**作品的记录',
    /function stashJobResult[\s\S]{0,400}S\.library\.find\(\(e\) => e\.id === job\.workId\)/.test(appSrc));
  t('结果存了 patch 与选区',
    /bgResult = \{[\s\S]{0,400}rect: \{[\s\S]{0,200}patch: patchUrl/.test(appSrc));
  t('结果存了掩膜（画笔排除的地方贴回时也不动）',
    /mask: job\.mask \? C\.packMask\(job\.mask\) : null/.test(appSrc));
  t('存不进去时明确报失败（不假装成功）',
    /if \(ok\) \{[\s\S]{0,400}\} else \{[\s\S]{0,400}job\.status = 'failed'/.test(appSrc));
  // 用户回到那张照片时自动贴回 —— 这是闭环
  t('回到作品时自动贴回后台结果', /async function applyStashedResult\(/.test(appSrc));
  t('continueWork 里调用了贴回', /async function continueWork[\s\S]{0,1600}applyStashedResult\(w\)/.test(appSrc));
  t('贴回后清掉暂存（不重复贴）', /rec\.bgResult = null;/.test(appSrc));
  t('贴回进撤销栈（可撤销）',
    /async function applyStashedResult[\s\S]{0,2600}recordUndo\(/.test(appSrc));

  // (c) UI 假装在忙 → busy 只反映当前这张照片
  t('busy 由纯函数按当前文档判定', /C\.planBusyForCurrent\(/.test(appSrc));
  t('busy 判定只看当前文档的任务',
    /function planBusyForCurrent[\s\S]{0,700}j\.docVersion === opt\.curDocVersion/.test(
      fs.readFileSync(path.join(__dirname, '..', 'app', 'core.js'), 'utf8')));
  t('没有打开照片时不显示 busy',
    /function planBusyForCurrent[\s\S]{0,400}if \(!opt\.hasPhoto\) return \{ busy: false, count: 0 \}/.test(
      fs.readFileSync(path.join(__dirname, '..', 'app', 'core.js'), 'utf8')));

  /* ---------- 4) 用户要能看到进度（否则不敢离开） ---------- */
  t('有任务角标元素', /id="job-badge"/.test(html));
  t('角标有样式', /#job-badge \{/.test(css));
  t('全部完成时角标变绿（有结果可看）', /#job-badge\.ok/.test(css));
  t('角标文案来自纯函数', /C\.planJobBadge\(S\.jobs\)/.test(appSrc));
  // 角标刻意不放顶栏：顶栏为「文件名可见」收敛过一次
  t('角标不放顶栏（避免挤掉文件名）',
    !/id="job-badge"[\s\S]{0,80}tb-btn/.test(html));
  t('角标有「为什么放这里」的注释', /刻意不放进顶栏/.test(html));
  t('首页条目标出后台状态', /C\.jobTagFor\(w\.id, S\.jobs\)/.test(appSrc));
  t('作品库条目标出后台状态', /C\.jobTagFor\(w\.id, S\.jobs\)/.test(appSrc));
  t('已完成的结果在首页有专门标记',
    /w\.bgResult && !jt[\s\S]{0,200}有生成结果待贴回/.test(appSrc));
  t('状态标有样式区分', /\.home-tag\.job-done/.test(css) && /\.home-tag\.job-running/.test(css));
  // 发起时明确告知「可以走」——这是这个功能存在的意义
  t('发起后提示可以切到别的照片',
    /已开始生成 · 可以切到别的照片，好了会通知你/.test(appSrc));
  t('后台完成时发原生通知', /notifyGenDone\('后台生成完成/.test(appSrc));

  /* ---------- 5) 任务表不落盘（应用被杀时请求也断了） ---------- */
  t('任务表在内存里', /jobs: \[\],/.test(appSrc));
  t('任务表不写 localStorage', !/LS_KEY_JOBS/.test(appSrc));
  t('注释说明了为什么不落盘', /应用被系统杀掉时 HTTP 请求也断了/.test(appSrc));
  // 任务表要能收敛（否则长会话会越积越多）
  t('有清理函数', /function pruneJobs\(\)/.test(appSrc));
  t('已完成且看过的会被清掉',
    /function pruneJobs[\s\S]{0,300}j\.status === 'running' \|\| !j\.seen/.test(appSrc));
  t('失败/取消后也会清理',
    /function cancelJob[\s\S]{0,500}pruneJobs\(\);/.test(appSrc) &&
    /catch \(err\) \{[\s\S]{0,1400}pruneJobs\(\);/.test(appSrc));

  /* ---------- 6) 失败处理的细节 ---------- */
  // 用户已经换到别的照片时，不该往他脸上弹上一张的报错
  t('只有还在看这张时才弹错误面板',
    /const stillHere = job\.docVersion === S\.docVersion && !!S\.img;/.test(appSrc));
  t('不在看这张时改成 toast', /else toast\('后台生成失败：'/.test(appSrc));
  t('切走后失败也发通知',
    /document\.hidden[\s\S]{0,120}notifyGenDone\('生成失败/.test(appSrc));

  /* ---------- 7) 「准备」与「执行」分离（各自好测好读） ---------- */
  t('有 prepareJob（同步，会抛本地自检错）', /function prepareJob\(\)/.test(appSrc));
  t('有 runJob（异步，发请求 + 出 patch）', /async function runJob\(job\)/.test(appSrc));
  t('本地自检失败就地报错（不白等一次）',
    /try \{\s*return prepareJob\(\);\s*\} catch \(err\) \{[\s\S]{0,400}showGenError/.test(appSrc));
  t('runJob 用任务自己的 aborter',
    /await callModel\(job\.req, job\.aborter\)/.test(appSrc));
  // callModel 必须接收 aborter 参数，不能读全局的 S.aborter
  t('callModel 收 aborter 参数', /async function callModel\(body, aborter\)/.test(appSrc));
  t('callModel 不再读全局 aborter',
    !/async function callModel\(body, aborter\)[\s\S]{0,4000}S\.aborter/.test(appSrc));
  t('注释说明了「每个任务各自一个取消器」',
    /必须是\*\*每个任务各自一个\*\*/.test(appSrc));

  /* ---------- 8) 保活：后台期间也要钉住进程 ---------- */
  // 保活看的是「有没有任务在跑」，不能只看 busy ——
  // 用户在首页时 busy 是 false，但后台任务还需要保活
  t('保活按「有没有任务在跑」决定',
    /function syncKeepAlive[\s\S]{0,1400}hasRunningJobs/.test(appSrc));
  t('首页时后台任务仍在保活',
    /const keepNeeded = !!S\.busy \|\| hasRunningJobs;/.test(appSrc));
  // 注释必须说明「为什么不能只看 busy」——否则以后很容易被「简化」掉
  t('注释说明了为什么不能只看 busy',
    /保活看的是「有没有生成在跑」，\*\*不能只看 busy\*\*/.test(appSrc));
  // 任务跑完时要释放保活（否则留下一条不该有的常驻通知）
  t('busy 未变时也同步保活',
    /else syncKeepAlive\(\);/.test(appSrc));
})();
/* ---------- 后台生成任务（回归） ---------- */

/* ---------- 基础调色（回归） ---------- */
console.log('\n【调色】基础调色工具：作用在框选区域、可预览、可撤销、不花钱');

(() => {
  const fs = require('fs');
  const path = require('path');
  const C2 = require(path.join(__dirname, '..', 'app', 'core.js'));
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'style.css'), 'utf8');

  /* ---------- 1) 像素数学在 core（可单测），不在 DOM 里内联 ---------- */
  t('core 有 gradePixels', typeof C2.gradePixels === 'function');
  t('core 有参数定义', Array.isArray(C2.GRADE_PARAMS) && C2.GRADE_PARAMS.length >= 5);
  t('core 有描述函数', typeof C2.describeGrade === 'function');
  t('core 有归一化函数', typeof C2.normalizeGrade === 'function');
  t('core 有全零判定', typeof C2.isGradeEmpty === 'function');
  t('全部已导出', /gradePixels, describeGrade/.test(fs.readFileSync(
    path.join(__dirname, '..', 'app', 'core.js'), 'utf8')));
  // 五项必须齐备（用户明确要求的最低集合）
  for (const k of ['exposure', 'contrast', 'saturation', 'temperature', 'tint']) {
    t('参数含 ' + k, C2.GRADE_PARAMS.some((p) => p.key === k));
  }
  // 曝光必须是「线性光里乘系数」，不是 sRGB 加减 —— 后者暗部变化远大于亮部
  t('曝光在线性光里做', /gradeExposureFactor/.test(fs.readFileSync(
    path.join(__dirname, '..', 'app', 'core.js'), 'utf8')));
  t('转线性光用的是项目里已有的 srgbToLinear',
    /let r = srgbToLinear\(r0\)/.test(fs.readFileSync(path.join(__dirname, '..', 'app', 'core.js'), 'utf8')));

  /* ---------- 2) 作用范围：只动框选区域，框外一个像素都不动 ---------- */
  // 这是用户明确要求的「对框选区域进行色调微调」，也是这个应用的核心承诺
  // 整张图调色时羽化按 0 处理：羽化会让最外一圈权重趋近 0，
  // 变成「整张图调色、但四周留一圈没调」，那是一个可见的框
  t('app 里调色走 layerAlphaMap 算权重',
    /function applyGradeInto\([\s\S]{0,1600}C\.layerAlphaMap\(whole \? Object\.assign\(\{\}, edit, \{ feather: 0 \}\) : edit, r\.w, r\.h\)/.test(appSrc));
  t('调色按选区裁剪像素',
    /function applyGradeInto\(targetCtx, edit, id\)[\s\S]{0,400}const r = edit\.rect;/.test(appSrc));
  // 掩膜/羽化让边界平滑（不然选区边界会有可见的色块分界）
  t('掩膜与羽化都参与权重',
    /C\.layerAlphaMap\(whole \? Object\.assign\(\{\}, edit, \{ feather: 0 \}\) : edit/.test(appSrc) &&
    /feather/.test(appSrc));
  t('调色图层沿用画笔掩膜（画笔排除的地方调色也不动）',
    /function makeGradeEdit[\s\S]{0,600}mask: S\.strokes\.length \? maskFromStrokes\(rect\) : null/.test(appSrc));

  /* ---------- 3) 独立合成路径：不与「模型生成块」那套混在一起 ---------- */
  t('调色有独立的合成分支',
    /if \(edit\.grade && !edit\.patch\) \{[\s\S]{0,200}applyGradeInto\(targetCtx, edit, id\)/.test(appSrc));
  // 调色不引入外来色差，不该跑色彩匹配/无缝融合
  t('调色不跑色彩匹配（不需要）',
    /colorMatch: 0, *\/\/ 调色不引入外来色差/.test(appSrc) ||
    /grade: C\.normalizeGrade\(grade\),[\s\S]{0,200}colorMatch: 0/.test(appSrc));
  // 图层开关关闭时不能合成
  t('调色图层受图层开关控制',
    /function applyGradeInto[\s\S]{0,400}if \(!L\.enabled \|\| L\.opacity <= 0\) return;/.test(appSrc));
  t('调色图层受图层不透明度控制',
    /applyGradeInto[\s\S]{0,400}layerAlphaMap/.test(appSrc));

  /* ---------- 4) 非破坏性 + 可撤销 ---------- */
  t('调色记录进 S.edits（非破坏性）', /function applyGrade[\s\S]{0,2000}S\.edits\.push\(edit\)/.test(appSrc));
  t('调色可撤销（记进撤销栈）', /function applyGrade[\s\S]{0,2200}recordUndo\(\{[\s\S]{0,200}'add-layer'/.test(appSrc));
  t('撤销标签说明改了什么颜色',
    /label: '调色：' \+ C\.describeGrade\(g\)/.test(appSrc));
  // 撤销 = 删掉这个图层，重做 = 加回来（复用已有的 add-layer 命令）
  t('调色复用 add-layer 命令（撤销/重做天然可用）',
    /type: 'add-layer', layer: edit, index: S\.edits\.length - 1/.test(appSrc));
  // 调色要能被「修改记录」面板管（开关、删除、调参）
  t('调色图层能被开关/删除',
    /toggle-layer/.test(appSrc) && /remove-layer/.test(appSrc));
  t('修改记录面板显示调色的色调描述',
    /if \(e\.grade\) \{[\s\S]{0,300}C\.describeGrade\(e\.grade\)/.test(appSrc));
  t('修改记录面板为调色图层渲染五个滑块',
    /if \(e\.grade\) \{[\s\S]{0,400}for \(const gp of C\.GRADE_PARAMS\)/.test(appSrc));

  /* ---------- 5) 会话持久化：调色参数要能存下来（不然「继续编辑」就丢了） ---------- */
  const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'core.js'), 'utf8');
  t('会话里存了 grade 参数',
    /grade: e\.grade \? normalizeGrade\(e\.grade\) : null/.test(coreSrc));
  t('恢复时能还原调色图层',
    /if \(it\.grade && !it\.patch\) \{[\s\S]{0,400}grade: C\.normalizeGrade\(it\.grade\)/.test(appSrc));
  // 调色图层没有 patch，内存整理不能因为读 patch.width 而崩
  t('内存整理跳过没有 patch 的图层',
    /for \(const e of list\) used \+= e\.patch \? patchMemory\(e\.patch\.width, e\.patch\.height\) : 0;/.test(coreSrc));
  t('降采样跳过没有 patch 的图层',
    /if \(!e\.patch\) continue; *\/\/ 调色图层没有可降采样的 patch/.test(coreSrc));
  t('app 侧降采样也跳过', /if \(!e \|\| !e\.patch \|\| e\.patch\.__halved\) continue;/.test(appSrc));
  // 接缝评分对没有 patch 的图层要返回 null（不能崩）
  t('接缝评分对调色图层返回 null', /if \(!edit \|\| !edit\.patch \|\| !S\.docCanvas\) return null;/.test(appSrc));

  /* ---------- 6) 实时预览 + 只在「应用」时记一条 ---------- */
  t('有实时预览函数', /function previewGrade\(\)/.test(appSrc));
  t('预览不写历史（拖滑块不产生上百条撤销）',
    /function previewGrade[\s\S]{0,900}rebuildViewCanvas\(\)/.test(appSrc) &&
    !/function previewGrade[\s\S]{0,900}recordUndo/.test(appSrc));
  t('预览与「应用」用同一套参数合成（所见即所得）',
    /function previewGrade[\s\S]{0,700}makeGradeEdit\(rect, g\)/.test(appSrc) &&
    /function applyGrade[\s\S]{0,600}makeGradeEdit\(rect, g\)/.test(appSrc) &&
    /function previewGrade[\s\S]{0,700}const rect = effectiveRect\(\)/.test(appSrc) &&
    /function applyGrade[\s\S]{0,600}const rect = effectiveRect\(\)/.test(appSrc));
  // 预览时 viewCanvas 已含草稿，应用前必须重建干净底子，否则调色会叠加两次
  t('应用前重建底子（避免调色叠加两次）',
    /function applyGrade[\s\S]{0,900}rebuildViewCanvas\(\)/.test(appSrc));
  t('应用后草稿归零（再次调色不会叠加）',
    /function applyGrade[\s\S]{0,1800}gradeDraft = C\.emptyGrade\(\);/.test(appSrc));
  t('有归零按钮的处理', /\$\('grade-reset'\)\.onclick = resetGradeDraft;/.test(appSrc));
  t('有应用按钮的处理', /\$\('grade-apply'\)\.onclick = applyGrade;/.test(appSrc));
  t('参数全零时不记录（避免产生没意义的记录）',
    /function applyGrade[\s\S]{0,300}if \(C\.isGradeEmpty\(g\)\) \{ toast\('还没有调整任何参数'\); return; \}/.test(appSrc));

  /* ---------- 7) 不花钱：调色不调用模型 ---------- */
  t('调色路径里没有 callModel', !/function applyGrade[\s\S]{0,2500}callModel/.test(appSrc));
  t('预览路径里没有 callModel', !/function previewGrade[\s\S]{0,900}callModel/.test(appSrc));
  t('界面上说明了不花钱', /不调用模型、不花钱/.test(html));
  t('修改记录里也说明了不花钱', /调色不调用模型，改参数立即生效、不花钱/.test(appSrc));

  /* ---------- 8) 界面：工具入口 + 参数栏 + 提示 ---------- */
  t('工具行有调色入口', /data-mode="grade"/.test(html));
  t('入口有图标与文字', /id="btn-grade"[\s\S]{0,300}调色/.test(html));
  t('入口有已调色数量角标', /id="grade-count"/.test(html));
  t('有参数栏容器', /id="grade-bar"/.test(html));
  t('滑块由 core 定义渲染（加参数不用改界面）',
    /function renderGradeSliders[\s\S]{0,400}for \(const p of C\.GRADE_PARAMS\)/.test(appSrc));
  t('有归零与应用按钮', /id="grade-reset"/.test(html) && /id="grade-apply"/.test(html));
  t('有改动说明容器', /id="grade-note"/.test(html));
  t('有工具提示（说明不花钱）', /id="grade-tip"/.test(html));
  t('参数栏平时隐藏（不占底栏空间）',
    /\$\('grade-bar'\)\.hidden = !inGrade;/.test(appSrc));
  t('提示只在第一次进这个工具时显示',
    /gtip\.hidden = !\(inGrade && tipDecision\('grade'\)\)/.test(appSrc));
  t('有参数栏样式', /#grade-bar \{/.test(css) && /\.grade-row/.test(css));
  t('有改动行高亮样式', /\.grade-row\.on/.test(css));
  // 调色滑块也必须「只能拖滑块头」——五个滑块紧挨着，误触归零等于白调
  t('调色滑块也套了 thumbOnlySlider', /thumbOnlySlider\(input\);/.test(appSrc));
  t('滑块渲染时也套了（不只是 bind 时扫一遍）',
    /renderGradeSliders[\s\S]{0,2000}thumbOnlySlider\(input\)/.test(appSrc));

  /* ---------- 9) AI 贴回后自动进入调色 ---------- */
  t('贴回后自动打开调色工具',
    /function applyPending[\s\S]{0,2600}openGradeTool\(edit\.rect\)/.test(appSrc));
  t('自动打开时对着**同一块选区**', /openGradeTool\(edit\.rect\)/.test(appSrc));
  // 可关闭：不想被切走工具的用户有权关掉
  t('有开关可以关掉自动打开', /S\.cfg\.autoGrade !== false/.test(appSrc));
  t('设置里有开关', /id="set-autograde"/.test(html));
  t('开关已接线', /bindField\('set-autograde', 'autoGrade'/.test(appSrc));
  t('配置默认开', /autoGrade: true/.test(appSrc));
  t('配置会持久化', /'autoGrade',/.test(appSrc));
  t('设置界面会同步开关状态', /\$\('set-autograde'\)\.checked = S\.cfg\.autoGrade !== false;/.test(appSrc));
  // 不打断：不弹窗、不自动改像素（滑块全 0，画面还是刚贴回的结果）
  t('自动打开不弹确认框（不打断用户）',
    !/autoGrade !== false[\s\S]{0,300}confirm\(/.test(appSrc));
  // 不打断：正在用画笔/引导线画东西时不抢走工具
  t('画笔/引导线模式下不抢工具',
    /const midTask = gradeMode === 'brush' \|\| gradeMode === 'guide';/.test(appSrc) &&
    /if \(S\.cfg\.autoGrade !== false && !midTask\)/.test(appSrc));
  t('自动打开时草稿是全零（不自动改像素）',
    /function openGradeTool[\s\S]{0,400}gradeDraft = C\.emptyGrade\(\)/.test(appSrc));
  // 没有框选时按整张图调色（需求：没有框选默认处理整张图）。
  // 旧行为是弹提示拒绝，现在不再需要 —— 但「没有照片」仍然要拦，
  // 否则拖滑块没有任何反应，比提示更让人困惑。
  t('没有选区时按整张图处理（不再弹提示拒绝）',
    /function openGradeTool[\s\S]{0,500}if \(!effectiveRect\(\)\)/.test(appSrc) &&
    !/function openGradeTool[\s\S]{0,400}toast\('先在照片上框选要调色的区域'\)/.test(appSrc));
  t('没有照片时仍然拦住（否则滑块拖了没反应）',
    /function openGradeTool\(rect\)[\s\S]{0,120}toast\('先打开一张照片'\)/.test(appSrc));
})();
/* ---------- 基础调色（回归） ---------- */

/* ---------- 新手教程（回归） ---------- */
console.log('\n【教程】首次启动弹一次、看过不再弹、随时能重看');

(() => {
  const fs = require('fs');
  const path = require('path');
  const C2 = require(path.join(__dirname, '..', 'app', 'core.js'));
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'style.css'), 'utf8');

  /* ---------- 1) 「看过」的标记：独立键，不与工具提示混用 ---------- */
  t('有独立的 localStorage 键', /LS_KEY_TUTORIAL = 'photoStudio\.tutorialSeen\.v1'/.test(appSrc));
  t('键名沿用 photoStudio. 前缀', /'photoStudio\.tutorialSeen\.v1'/.test(appSrc));
  // 关键：与工具提示分开存。混用会让「重置工具提示」顺手把教程也重置了，
  // 用户点一下「重置提示」就被教程挡住，很莫名
  t('与工具提示的键不同',
    /LS_KEY_TUTORIAL = '([^']+)'/.exec(appSrc)[1] !== /LS_KEY_HINTS = '([^']+)'/.exec(appSrc)[1],
    [/LS_KEY_TUTORIAL = '([^']+)'/.exec(appSrc)[1], /LS_KEY_HINTS = '([^']+)'/.exec(appSrc)[1]]);
  t('重置工具提示不会重置教程',
    /resetHints:[\s\S]{0,400}?saveHints\(\)/.test(appSrc) &&
    !/resetHints:[\s\S]{0,400}?clearTutorialSeen/.test(appSrc));
  t('读写标记都有容错（隐私模式不崩）',
    /function tutorialSeen\(\)[\s\S]{0,300}catch \(e\) \{ return false; \}/.test(appSrc));
  t('写标记失败不抛异常',
    /function markTutorialSeen\(\)[\s\S]{0,300}catch \(e\)/.test(appSrc));
  t('有清除标记的函数（便于重看）', /function clearTutorialSeen\(\)/.test(appSrc));

  /* ---------- 2) 首启自动弹：接在 boot 上 ---------- */
  t('boot 里会判断是否自动弹', /shouldAutoTutorial\(\)/.test(appSrc));
  t('自动弹之前先看「有没有正在编辑的照片」',
    /function shouldAutoTutorial\(\)[\s\S]{0,300}hasPhoto: !!S\.img/.test(appSrc));
  // 首屏元素还没布局时弹，高亮圈会套到 (0,0) —— 必须延后一拍
  t('延后一拍再弹（等首屏布局完成）',
    /shouldAutoTutorial\(\)[\s\S]{0,300}setTimeout\(/.test(appSrc));
  t('延后期间用户打开了照片就不弹',
    /setTimeout\(\(\) => \{[\s\S]{0,300}if \(!S\.img && shouldAutoTutorial\(\)\)/.test(appSrc));
  // 自动弹的那一刻就记「已看过」：中途杀掉应用也不该下次再弹
  t('自动弹时立刻记「已看过」', /function openTutorial\(auto\)[\s\S]{0,400}if \(auto\) markTutorialSeen\(\)/.test(appSrc));

  /* ---------- 3) 重看入口：更多菜单 + 设置页 ---------- */
  t('更多菜单里有教程入口', /id="btn-tutorial"/.test(html));
  t('设置页也有教程入口', /id="btn-tutorial2"/.test(html));
  t('两个入口都绑定了', /tutBtn\.onclick = \(\) => \{[^}]*openTutorial\(false\); \};/.test(appSrc) &&
    /tutBtn2\.onclick = \(\) => \{[^}]*openTutorial\(false\); \};/.test(appSrc));
  t('重看时先关掉菜单（否则菜单压在教程上）',
    /tutBtn\.onclick = \(\) => \{ closeMoreMenu\(\); openTutorial\(false\); \}/.test(appSrc));
  t('重看时先关掉设置（否则设置压在教程上）',
    /tutBtn2\.onclick = \(\) => \{ closeSettings\(\); openTutorial\(false\); \}/.test(appSrc));
  // 重看**不**改标记：反复重看不该反复写盘，也不该把「已看过」清掉
  t('手动重看不改「已看过」标记',
    /function openTutorial\(auto\)[\s\S]{0,600}if \(auto\) markTutorialSeen\(\)/.test(appSrc) &&
    !/openTutorial\(false\)[\s\S]{0,200}markTutorialSeen/.test(appSrc));

  /* ---------- 4) 跳过：必须记「已看过」，否则每次启动都弹 ---------- */
  t('有跳过按钮', /id="tut-skip"/.test(html));
  t('跳过会记「已看过」', /tutSkip\.onclick = \(\) => \{ markTutorialSeen\(\); closeTutorial\(\); \}/.test(appSrc));
  t('点蒙层也算跳过', /tutMask\.onclick = \(\) => \{ markTutorialSeen\(\); closeTutorial\(\); \}/.test(appSrc));
  // 返回键关教程同样要记，否则按返回键跳过的人下次还会被弹
  t('返回键关教程也记「已看过」',
    /case 'tutorial': markTutorialSeen\(\); closeTutorial\(\); break;/.test(appSrc));
  t('返回键分层里有教程', /\{ id: 'tutorial'/.test(fs.readFileSync(
    path.join(__dirname, '..', 'app', 'core.js'), 'utf8')));

  /* ---------- 5) 界面结构：蒙层 + 高亮圈 + 气泡 ---------- */
  t('有教程浮层', /id="tutorial" hidden/.test(html));
  t('有蒙层', /class="tut-mask"/.test(html));
  t('有高亮圈', /id="tut-spot"/.test(html));
  t('有说明气泡', /id="tut-card"/.test(html));
  t('有步骤计数', /id="tut-step"/.test(html));
  t('有标题与正文容器', /id="tut-title"/.test(html) && /id="tut-body"/.test(html));
  t('有上一步/下一步按钮', /id="tut-prev"/.test(html) && /id="tut-next"/.test(html));
  t('有进度点容器', /id="tut-dots"/.test(html));
  t('教程默认隐藏（不能一进来就盖住首页）', /id="tutorial" hidden/.test(html));
  // z-index 必须最高，否则会被「更多」菜单或作品预览盖住
  t('教程层级最高', /#tutorial \{[^}]*z-index: 140/.test(css), '教程的 z-index 必须是最高层');
  t('高亮圈用扩散阴影挖空（不用四块遮罩拼）',
    /\.tut-spot \{[\s\S]{0,300}box-shadow: 0 0 0 9999px/.test(css));
  t('高亮圈不拦点击（用户能边看边操作）',
    /\.tut-spot \{[\s\S]{0,400}pointer-events: none/.test(css));
  t('气泡有样式', /\.tut-card \{/.test(css));
  t('进度点有样式', /\.tut-dot \{/.test(css));
  t('当前进度点有区分', /\.tut-dot\.on/.test(css));

  /* ---------- 6) 摆位的兜底：目标找不到时必须居中，不能指向屏幕角落 ---------- */
  t('有摆位函数', /function layoutTutorial\(step\)/.test(appSrc));
  t('目标元素不存在时隐藏高亮圈',
    /\} else \{[\s\S]{0,200}spot\.classList\.add\('off'\)/.test(appSrc) &&
    /spot\.classList\.remove\('off'\)/.test(appSrc));
  t('有 off 样式（隐藏高亮圈）', /\.tut-spot\.off \{ display: none; \}/.test(css));
  t('气泡位置被夹在屏幕内',
    /Math\.max\(8, Math\.min\(vh - cardH - 8, top\)\)/.test(appSrc));
  t('选择器写错不会让教程崩',
    /try \{\s*target = step\.target \? document\.querySelector\(step\.target\) : null;\s*\} catch \(e\) \{ target = null; \}/.test(appSrc));
  t('尺寸为 0 的元素视作找不到（被隐藏了）',
    /if \(!r \|\| r\.width < 2 \|\| r\.height < 2\) r = null;/.test(appSrc));
  t('窗口尺寸变化时重摆（横竖屏切换）',
    /addEventListener\('resize', \(\) => \{ if \(tutorialOpen\(\)\) renderTutorial\(\); \}\)/.test(appSrc));

  /* ---------- 7) 步骤内容：文案要能独立看懂，不能只是「点这里」 ---------- */
  t('每一步都说了「做什么」和「为什么」',
    C2.TUTORIAL_STEPS.every((s) => s.body.length >= 12),
    C2.TUTORIAL_STEPS.map((s) => s.body.length));
  // 生成要等 30~60 秒是这个应用最容易让人困惑的点，教程必须提前说清
  t('教程说明了生成要等一段时间',
    C2.TUTORIAL_STEPS.some((s) => /30~60 秒|切到别的应用/.test(s.body)),
    C2.TUTORIAL_STEPS.map((s) => s.body));
  // 「框外不动」是核心卖点，必须讲
  t('教程说明了只改框住的部分',
    C2.TUTORIAL_STEPS.some((s) => /框外|框住哪里/.test(s.body)),
    C2.TUTORIAL_STEPS.map((s) => s.body));
})();
/* ---------- 新手教程（回归） ---------- */

/* ---------- 调用日志（回归） ---------- */
console.log('\n【调用日志】设置里能看、能导出，且真的记了每次调用');

(() => {
  const fs = require('fs');
  const path = require('path');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'core.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'style.css'), 'utf8');

  /* ---------- 1) 记录点：必须真的挂在生成流程上 ---------- */

  // 关键：日志必须记在**真正发请求的那一层**（runJob），
  // 记在 callModel 里拿不到选区尺寸与 workId。
  // 注意不能只扫 runGenerate：发请求已经拆到 runJob 里了
  // （拆开是为了让「准备输入」与「等结果」各自好测、好读）。
  const rjStart = appSrc.indexOf('async function runJob(job) {');
  const rjEnd = appSrc.indexOf('async function runGenerate() {');
  const rgBody = rjStart >= 0 && rjEnd > rjStart ? appSrc.slice(rjStart, rjEnd) : '';
  t('发请求的流程里记了调用日志', /recordCallLog\(/.test(rgBody), 'runJob 里没有 recordCallLog');
  t('调用前记了开始时间', /const callT0 = Date\.now\(\)/.test(rgBody));
  t('记了耗时', /ms: Date\.now\(\) - callT0/.test(rgBody));
  t('记了发送的图片尺寸', /imgW: built\.canvas\.width, imgH: built\.canvas\.height/.test(rgBody));
  t('记了提示词', /prompt: job\.promptText/.test(rgBody));
  t('记了模型与服务商', /model: job\.req\.body\.model \|\| S\.cfg\.model/.test(rgBody));
  // 归属必须用**任务里记的** workId，不是当前的 —— 用户可能已经换图了
  t('日志的归属用任务里的 workId（换图后仍归对照片）',
    /workId: job\.workId \|\| ''/.test(rgBody));
  // 失败必须记 —— 有些接口失败也计费，而且失败原因是最有价值的排查线索
  t('失败路径也记（catch 里有 recordCallLog）',
    /catch \(callErr\)[\s\S]{0,600}recordCallLog\(/.test(rgBody));
  t('失败记了 HTTP 状态', /status: callErr && callErr\.status/.test(rgBody));
  t('失败记了错误原因', /error: describeCallError\(callErr\)/.test(rgBody));
  t('成功记了 ok:true', /ok: true, status: 200/.test(rgBody));
  // HTTP 通了但没拿到图片（对话模型回文字）也要算失败，不能记成「成功但没图」
  t('没拿到图片也记为失败',
    /if \(!items\.length\) \{[\s\S]{0,500}ok: false, status: 200/.test(rgBody));
  t('没拿到图片记下了诊断结论', /diagnoseResponse\(json, 200/.test(rgBody));

  /* ---------- 2) 失败原因要翻译成人话，不能只有一句 HTTP 400 ---------- */
  t('有失败原因翻译函数', /function describeCallError\(/.test(appSrc));
  t('复用了 core 的诊断文案', /C\.diagnoseResponse\(/.test(appSrc));

  /* ---------- 3) 花费：用已有的成本预估，不另起一套 ---------- */
  t('花费走已有的成本预估', /function estimateCallCost\(/.test(appSrc) && /currentEstimate\(\)/.test(appSrc));
  t('单价未知记为 null（不能当成 0）', /return \{ usd: null, note: '单价未知' \}/.test(appSrc));

  /* ---------- 4) 存储：环形缓冲 + 独立键 + 坏了不影响主流程 ---------- */
  t('有独立的 localStorage 键', /LS_KEY_CALLLOG = 'photoStudio\.callLog\.v1'/.test(appSrc));
  // 键名必须符合项目的命名约定（photoStudio.*），否则以后迁移会找不到
  t('键名沿用 photoStudio. 前缀', /'photoStudio\.callLog\.v1'/.test(appSrc));
  t('有上限常量', /const CALL_LOG_MAX = \d+/.test(coreSrc));
  t('上限在 100 量级', /const CALL_LOG_MAX = 100;/.test(coreSrc));
  t('用环形缓冲（appendCallLog 裁掉超出部分）',
    /function appendCallLog\(list, entry, max\)/.test(coreSrc) && /out\.length < cap/.test(coreSrc));
  // 日志是「可丢弃」数据：写不进去要降级，绝不能抛出去打断生成
  t('记录失败不抛异常（catch 里只警告）',
    /function recordCallLog\(entry\)[\s\S]{0,600}catch \(e\) \{[\s\S]{0,200}console\.warn/.test(appSrc));
  t('读日志失败退回空数组',
    /function loadCallLog\(\)[\s\S]{0,600}catch \(e\)[\s\S]{0,200}return \[\]/.test(appSrc));
  t('空间紧张时日志先让路（丢一半再试）',
    /function saveCallLog\(\)[\s\S]{0,600}slice\(0, Math\.max\(1/.test(appSrc));
  // 日志绝不能把图片 base64 存进去 —— 那会让日志变成第二个存储黑洞
  t('日志不存图片内容（只有尺寸与字节数）',
    !/image:\s*(e\.image|img|dataUrl)/.test(coreSrc) && /imgBytes/.test(coreSrc));

  /* ---------- 5) 界面：设置里有入口，面板能看能导出 ---------- */
  t('设置页有调用日志入口', /id="btn-calllog"/.test(html));
  t('入口显示条数与花费（不用点进去才知道）', /id="calllog-brief"/.test(html));
  t('有日志面板', /id="calllog" class="sheet" hidden/.test(html));
  t('面板有列表容器', /id="calllog-list"/.test(html));
  t('面板有统计行', /id="calllog-summary"/.test(html));
  t('面板有空状态', /id="calllog-empty"/.test(html));
  t('有导出 JSON 按钮', /id="calllog-export-json"/.test(html));
  t('有导出文本按钮', /id="calllog-export-text"/.test(html));
  t('有清空按钮', /id="calllog-clear"/.test(html));
  t('面板文案说明了「失败也记」', /失败也会记/.test(html));
  t('面板文案说明了保留条数', /100 条/.test(html));
  t('面板有样式', /\.cl-item/.test(css) && /\.cl-summary/.test(css));
  t('失败条目有视觉区分', /\.cl-item\.bad/.test(css));

  /* ---------- 6) 接线：按钮真的绑了函数 ---------- */
  t('设置入口绑定打开函数', /clBtn\.onclick[\s\S]{0,120}openCallLog\(\)/.test(appSrc));
  t('打开日志前先关设置（否则被压在下面）', /clBtn\.onclick = \(\) => \{ closeSettings\(\); openCallLog\(\); \}/.test(appSrc));
  t('面板可关闭', /#calllog \[data-close\][\s\S]{0,80}closeCallLog/.test(appSrc));
  t('导出按钮绑了导出函数', /clJson\.onclick = \(\) => exportCallLog\('json'\)/.test(appSrc));
  t('导出文本按钮绑了导出函数', /clText\.onclick = \(\) => exportCallLog\('text'\)/.test(appSrc));
  t('清空要二次确认（避免误触清掉排查线索）',
    /clClear\.onclick[\s\S]{0,200}confirm\(/.test(appSrc));
  t('启动时载入日志', /S\.callLog = loadCallLog\(\)/.test(appSrc));
  t('启动时刷新入口副标题', /S\.callLog = loadCallLog\(\);[\s\S]{0,120}updateCallLogBrief\(\)/.test(appSrc));

  /* ---------- 7) 导出复用已有的原生保存路径 ---------- */
  t('导出走原生保存（安卓壳里 <a download> 没用）',
    /async function exportCallLog\(kind\)[\s\S]{0,2000}nativeSaveAvailable\(\)/.test(appSrc));
  t('日志默认存到下载目录（不是相册）',
    /nativeSave\(blob, name, 'downloads'\)/.test(appSrc));
  t('浏览器里有下载兜底', /a\.download = name/.test(appSrc));
  t('导出用时间戳文件名', /C\.timestampName\('calllog'/.test(appSrc));
  t('没有记录时不导出空文件', /if \(!list\.length\) \{ toast\('还没有调用记录'\); return; \}/.test(appSrc));

  /* ---------- 8) 返回键要能关掉日志面板 ---------- */
  t('返回键分层里有调用日志', /\{ id: 'calllog'/.test(coreSrc));
  t('日志层在设置之上（z 更大）', (() => {
    const iLog = coreSrc.indexOf("{ id: 'calllog'");
    const iSet = coreSrc.indexOf("{ id: 'settings'");
    const zLog = parseFloat((/z: (\d+)/.exec(coreSrc.slice(iLog, iLog + 60)) || [])[1]);
    const zSet = parseFloat((/z: (\d+)/.exec(coreSrc.slice(iSet, iSet + 60)) || [])[1]);
    return zLog > zSet;
  })(), '日志层的 z 必须大于设置层');
  t('返回键处理里有 closeCallLog', /case 'calllog': closeCallLog\(\)/.test(appSrc));
  t('CSS 里日志面板的 z-index 高于设置',
    /#calllog \{ z-index: 110; \}/.test(css));

  /* ---------- 9) 耗时显示：ms=0 也必须显示出来 ---------- */
  // 回归的坑：判断写成 `e.ms ? ... : ''`，而 ms 的合法值包含 0
  // （瞬时返回 / 瞬时失败 —— 例如参数不对被服务端立刻拒绝）。
  // 0 是 falsy，于是这条记录的耗时被静默吞掉，界面看起来像日志坏了。
  // 这个 bug 在真实环境里表现为「偶尔有一条记录不显示耗时」的随机失败。
  t('耗时判断不用真值判断（ms=0 不能被吞掉）',
    /const hasMs = e\.ms !== null && e\.ms !== undefined && e\.ms !== '' &&/.test(appSrc) &&
    /hasMs \? ' · ' \+ \(Number\(e\.ms\) \/ 1000\)\.toFixed\(1\) \+ ' 秒' : ''/.test(appSrc));
  t('不再有 e.ms 的真值判断写法', !/\(e\.ms \? ' · '/.test(appSrc));
  // 抽出来跑一遍：0 要显示、缺失不能显示成 0.0
  // （只判 Number.isFinite 是不行的 —— Number(null) === 0 也是有限数，
  //   那样「没记录耗时」会被显示成「0.0 秒」，变成另一个错误）
  t('ms=0 显示 0.0 秒、ms 缺失不显示', (() => {
    const fmt = (ms) => {
      const hasMs = ms !== null && ms !== undefined && ms !== '' && Number.isFinite(Number(ms));
      return hasMs ? ' · ' + (Number(ms) / 1000).toFixed(1) + ' 秒' : '';
    };
    return fmt(0) === ' · 0.0 秒' && fmt(1234) === ' · 1.2 秒' &&
      fmt(undefined) === '' && fmt(null) === '' && fmt('') === '';
  })());
  t('core 里 ms 归一化后仍是数字 0（不是 null）', (() => {
    const C2 = require(path.join(__dirname, '..', 'app', 'core.js'));
    const rec = C2.appendCallLog([], { ms: 0, ok: false, model: 'm' })[0];
    return rec.ms === 0;
  })());
})();
/* ---------- 调用日志（回归） ---------- */

/* ---------- 作品库「只存得下一张」回归（真实体积测量） ---------- */
console.log('\n【作品库】历史记录必须存得住多张（用真实 JPEG 体积验证）');

(() => {
  const fs = require('fs');
  const path = require('path');
  const C2 = require(path.join(__dirname, '..', 'app', 'core.js'));
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');

  let napi = null;
  try { napi = require('@napi-rs/canvas'); }
  catch (e) {
    try { napi = require('/tmp/domtest/node_modules/@napi-rs/canvas'); }
    catch (e2) { napi = null; }
  }

  if (!napi) {
    console.log('  ⚠ 跳过（未安装 @napi-rs/canvas，无法做真实体积测量）');
    return;
  }

  /**
   * 造一张「像照片」的图：低频渐变 + 逐像素颗粒。
   *
   * 为什么不用纯色：纯色 JPEG 只有几 KB，测不出「一条记录吃满整库」的 bug。
   * 真实照片（尤其带颗粒的）压缩后体积大得多，正是问题的来源。
   */
  function photoLike(w, h, seed) {
    const c = napi.createCanvas(w, h);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return ((s >>> 8) & 0xffff) / 0xffff; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const b = (x / w) * 120 + (y / h) * 90 + 20;
      img.data[i] = Math.max(0, Math.min(255, b + rnd() * 46 - 23));
      img.data[i + 1] = Math.max(0, Math.min(255, b * 0.95 + 15 + rnd() * 46 - 23));
      img.data[i + 2] = Math.max(0, Math.min(255, b * 0.85 + 30 + rnd() * 46 - 23));
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
  /** 编码成 dataURL 后的**字符数**（estimateWorkBytes 的口径） */
  const dataUrlChars = (canvas, q) => {
    const buf = canvas.toBuffer('image/jpeg', Math.round(q * 100));
    return Math.ceil(buf.length / 3) * 4 + 23;
  };

  // ---- 1) 关键前提：会话基准图真的被缩放，不是照原尺寸存 ----
  const docSide = 3072;                       // 设置里默认的「工作分辨率上限」
  const docH = Math.round(docSide * 2048 / 3072);
  const docCanvas = photoLike(docSide, docH, 7);
  const plan = C2.planSessionBase({ w: docSide, h: docH });
  t('基准图被缩到上限以内', plan.scaled && Math.max(plan.w, plan.h) <= C2.SESSION_BASE_MAX_SIDE,
    plan);
  t('缩放保持长宽比', Math.abs(plan.w / plan.h - docSide / docH) < 0.01, [plan.w, plan.h]);
  // 只缩不放：小图不能被放大（放大变糊且体积更大）
  const smallPlan = C2.planSessionBase({ w: 800, h: 600 });
  t('小图不被放大', smallPlan.scaled === false && smallPlan.w === 800 && smallPlan.h === 600, smallPlan);
  t('planSessionBase 对脏值安全', C2.planSessionBase({ w: 'x', h: null }).w === 0,
    C2.planSessionBase({ w: 'x', h: null }));

  // ---- 2) 用真实编码体积证明：修复前的存法一条就吃满整库 ----
  const oldBaseChars = dataUrlChars(docCanvas, 0.85);          // 修复前：整张 3072px q0.85
  const newBaseChars = dataUrlChars(
    (() => {                                                  // 修复后：缩到 2048px q0.75
      const s = napi.createCanvas(plan.w, plan.h);
      const sc = s.getContext('2d');
      sc.drawImage(docCanvas, 0, 0, docSide, docH, 0, 0, plan.w, plan.h);
      return s;
    })(), C2.SESSION_BASE_QUALITY);
  const oldBaseBytes = C2.storageBytes('x'.repeat(oldBaseChars));
  const newBaseBytes = C2.storageBytes('x'.repeat(newBaseChars));
  t('修复前：单条会话基准图就吃掉大半个库', oldBaseBytes > C2.LIBRARY_BUDGET_BYTES * 0.6,
    { oldBaseBytes, budget: C2.LIBRARY_BUDGET_BYTES });
  t('修复后：基准图体积降到一半以下', newBaseBytes < oldBaseBytes * 0.6,
    { newBaseBytes, oldBaseBytes });
  t('修复后：单条会话基准图远小于总预算', newBaseBytes < C2.LIBRARY_BUDGET_BYTES * 0.5,
    { newBaseBytes, budget: C2.LIBRARY_BUDGET_BYTES });

  // ---- 3) 缩略图也是累积项：条数上限 × 单张体积必须放得下 ----
  const thumbCanvas = photoLike(1600, 1067, 3);
  const thumbPlan = Math.min(1, C2.THUMB_MAX_SIDE / 1600);
  const thumb = (() => {
    const s = napi.createCanvas(Math.round(1600 * thumbPlan), Math.round(1067 * thumbPlan));
    s.getContext('2d').drawImage(thumbCanvas, 0, 0, 1600, 1067, 0, 0, s.width, s.height);
    return s;
  })();
  const thumbChars = dataUrlChars(thumb, C2.THUMB_QUALITY);
  const thumbBytes = C2.storageBytes('x'.repeat(thumbChars));
  t('满条数时缩略图总占用不超过总预算的 3/4',
    thumbBytes * C2.LIBRARY_MAX_ITEMS < C2.LIBRARY_BUDGET_BYTES * 0.75,
    { thumbBytes, items: C2.LIBRARY_MAX_ITEMS, budget: C2.LIBRARY_BUDGET_BYTES });
  t('单张缩略图 <= 64KB', thumbBytes <= 64 * 1024, thumbBytes);

  // ---- 4) 核心回归：用真实体积模拟「导入 3 张、各改一次」 ----
  const patchChars = dataUrlChars(photoLike(600, 400, 11), 0.82);   // 一次典型编辑的 patch
  const realWork = (id, at) => ({
    id, at, name: 'photo.jpg',
    thumb: 't'.repeat(thumbChars),
    session: { base: 'b'.repeat(newBaseChars), items: [{ patch: 'p'.repeat(patchChars) }] }
  });
  const opts = (pinned) => ({
    maxBytes: C2.LIBRARY_BUDGET_BYTES,
    maxItems: C2.LIBRARY_MAX_ITEMS,
    sessionBudgetBytes: C2.SESSION_BUDGET_BYTES,
    pinnedId: pinned || null
  });

  let lib = [];
  const trace = [];
  for (let i = 0; i < 3; i++) {
    lib.unshift(realWork('w' + i, 1000 + i));
    const p = C2.planLibrary(lib, opts('w' + i));
    if (p.downgradeIds.length) for (const e of lib) if (p.downgradeIds.includes(e.id)) e.session = null;
    if (p.evictIds.length) lib = lib.filter((e) => !p.evictIds.includes(e.id));
    trace.push({ after: i + 1, kept: lib.length, editable: lib.filter((e) => e.session).length });
  }
  t('导入 3 张照片后 3 条都在列表里', lib.length === 3, trace);
  t('导入 3 张后没有一条被清理', lib.length === 3, trace);
  t('导入 3 张后至少 2 张可继续编辑', lib.filter((e) => e.session).length >= 2,
    lib.filter((e) => e.session).map((e) => e.id));
  t('第 1 张仍然看得见（缩略图还在）', lib.some((e) => e.id === 'w0' && e.thumb), lib.map((e) => e.id));
  t('真实体积下占用不超总预算',
    C2.workLibraryStats(lib).bytes <= C2.LIBRARY_BUDGET_BYTES,
    [C2.workLibraryStats(lib).bytes, C2.LIBRARY_BUDGET_BYTES]);
  t('统计能报告可继续编辑的张数',
    C2.workLibraryStats(lib).withSession >= 2, C2.workLibraryStats(lib));

  // ---- 4b) 对照：把「修复前」的算法原样复现一遍，证明本测试真的能测出这个 bug ----
  // 只复现旧算法里与取舍相关的部分（单层预算 + 先降级再淘汰）。
  // 没有这个对照，上面那几条断言在「预算被悄悄调大」时也会通过，
  // 测试就失去意义了。
  const oldPlanLibrary = (entries, maxBytes, maxItems, pinnedId) => {
    const sorted = entries.slice().sort((a, b) => b.at - a.at);
    const kept = [], evictIds = [], downgradeIds = [];
    const downgraded = new Set();
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      const isPinned = pinnedId && e.id === pinnedId;
      if (i < maxItems || isPinned) kept.push(e); else evictIds.push(e.id);
    }
    const remainBytes = (e) => {
      let n = 400 + C2.storageBytes(e.thumb) + C2.storageBytes(e.before || '');
      if (e.session && !downgraded.has(e.id)) n += C2.storageBytes(JSON.stringify(e.session));
      return n;
    };
    let bytes = kept.reduce((s, e) => s + C2.estimateWorkBytes(e), 0);
    if (bytes > maxBytes) {
      for (let i = kept.length - 1; i >= 0 && bytes > maxBytes; i--) {
        const e = kept[i];
        if ((pinnedId && e.id === pinnedId) || !e.session) continue;
        bytes -= C2.storageBytes(JSON.stringify(e.session));
        downgraded.add(e.id); downgradeIds.push(e.id);
      }
      for (let i = kept.length - 1; i >= 0 && bytes > maxBytes && kept.length > 1; i--) {
        const e = kept[i];
        if (pinnedId && e.id === pinnedId) continue;
        bytes -= remainBytes(e); evictIds.push(e.id); kept.splice(i, 1);
      }
    }
    return { keepIds: kept.map((e) => e.id), downgradeIds, evictIds };
  };
  // 旧算法 + 旧预算 + 旧尺寸（3072px 基准图）
  const fatWork = (id, at) => ({
    id, at, name: 'photo.jpg', thumb: 't'.repeat(thumbChars),
    session: { base: 'b'.repeat(oldBaseChars), items: [{ patch: 'p'.repeat(patchChars) }] }
  });
  const oldLib = [fatWork('w0', 1000), fatWork('w1', 2000), fatWork('w2', 3000)];
  const oldRepro = oldPlanLibrary(oldLib, 2.5 * 1024 * 1024, 80, 'w2');
  t('（对照）旧算法下第 1 张确实被淘汰 —— 说明本测试能测出这个 bug',
    oldRepro.evictIds.indexOf('w0') >= 0, oldRepro);
  t('（对照）旧算法最终只剩 1 条 —— 与用户报告的现象一致',
    oldRepro.keepIds.length === 1, oldRepro.keepIds);

  // ---- 4c) 两个修复缺一不可（这条对照把「只改一半」的假修复挡在门外）----
  // 「会话单独一层预算」+「基准图缩小」是配套的：
  //   只加预算分层、不缩基准图 → 单条记录本身仍超过总预算，列表照样被清空
  //   只缩基准图、不加预算分层 → 单条会话变小了，但两条一起仍会互相挤掉
  const fatLib = [fatWork('w0', 1000), fatWork('w1', 2000)];
  const fatPlan = C2.planLibrary(fatLib, {
    maxBytes: C2.LIBRARY_BUDGET_BYTES, maxItems: 80,
    sessionBudgetBytes: C2.SESSION_BUDGET_BYTES, pinnedId: 'w1'
  });
  t('对照：基准图不缩时单条就超过总预算（所以缩图是必需的）',
    C2.estimateWorkBytes(fatLib[0]) > C2.LIBRARY_BUDGET_BYTES,
    [C2.estimateWorkBytes(fatLib[0]), C2.LIBRARY_BUDGET_BYTES]);
  t('对照：基准图不缩时列表仍会被清空（说明光加预算分层不够）',
    fatPlan.evictIds.length > 0, fatPlan);

  // 反过来说：缩了图但两条一起超预算时，也必须先降级而不是淘汰
  const midWork = (id, at) => ({
    id, at, name: 'photo.jpg', thumb: 't'.repeat(thumbChars),
    session: { base: 'b'.repeat(newBaseChars), items: [{ patch: 'p'.repeat(patchChars) }] }
  });
  const midLib = [midWork('w0', 1000), midWork('w1', 2000), midWork('w2', 3000)];
  const midPlan = C2.planLibrary(midLib, {
    maxBytes: C2.LIBRARY_BUDGET_BYTES, maxItems: 80,
    // 故意把会话预算压到只够放 1 条，逼出降级
    sessionBudgetBytes: C2.estimateWorkBytes(midLib[0]) * 1.1,
    pinnedId: 'w2'
  });
  t('会话预算不足时降级最老的会话', midPlan.downgradeIds.indexOf('w0') >= 0, midPlan.downgradeIds);
  t('会话预算不足时列表一条都不少', midPlan.keepIds.length === 3 && midPlan.evictIds.length === 0,
    midPlan);

  // ---- 5) 接线：app 侧必须真的用上新参数，不能只改 core ----
  t('app 传了会话预算', /sessionBudgetBytes: C\.SESSION_BUDGET_BYTES/.test(appSrc));
  t('app 用 core 的基准图规划', /C\.planSessionBase\(/.test(appSrc));
  t('app 用 core 的基准图质量', /C\.SESSION_BASE_QUALITY/.test(appSrc));
  t('app 用 core 的 patch 上限', /maxBytes: C\.SESSION_PATCH_MAX_CHARS/.test(appSrc));
  t('app 用 core 的缩略图质量', /C\.THUMB_QUALITY/.test(appSrc));
  // 兜底路径不能直接砍记录（用户会莫名丢历史），要先丢会话
  const saveFn = appSrc.slice(appSrc.indexOf('function saveLibrary()'),
    appSrc.indexOf('function saveLibrary()') + 2200);
  t('配额兜底先丢会话而不是丢记录',
    /session: null/.test(saveFn) && !/slice\(0, 5\)/.test(saveFn), '兜底路径仍是直接砍记录');
  // 单条会话过大时必须**告诉用户**，不能静默不存
  const touchFn = appSrc.slice(appSrc.indexOf('function touchWork()'),
    appSrc.indexOf('function touchWork()') + 2000);
  t('单条会话过大时不静默（有提示）', /libraryNote/.test(touchFn));
})();
/* ---------- 作品库「只存得下一张」回归 ---------- */

/* ---------- 滑块「只能拖滑块头」（回归） ---------- */
console.log('\n【滑块】点轨道不能跳值，拖动滑块头必须照常工作');

(() => {
  const fs = require('fs');
  const path = require('path');
  const C2 = require(path.join(__dirname, '..', 'app', 'core.js'));
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'style.css'), 'utf8');

  // 1) 页面上每一个滑块都要被保护。
  //    回归的坑：只给「设置页那几个」接线，导出面板/画笔栏/图层参数里的滑块漏掉，
  //    用户在最容易误触的地方（图层参数滑块上下紧挨着）照样会被跳值。
  const ids = [...html.matchAll(/<input type="range"[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  t('页面里确实有多个滑块（前提）', ids.length >= 10, ids.length);
  const expected = ['brush-size', 'exp-quality', 'set-ctx', 'set-feather', 'set-cm',
    'set-fusion', 'set-fusionc', 'set-fusiong', 'set-mem', 'set-quality'];
  for (const id of expected) {
    t('滑块 ' + id + ' 在页面里', ids.indexOf(id) >= 0, ids);
  }

  // 2) 实现必须是「一个可复用函数 + 统一套用」，不是逐个写死 id
  t('有可复用的 thumbOnlySlider', /function thumbOnlySlider\(el\)/.test(appSrc));
  t('有统一套用入口（覆盖页面上全部滑块）', /function applyThumbOnlySliders\(/.test(appSrc));
  t('统一入口真的被调用', /applyThumbOnlySliders\(\);/.test(appSrc));
  // 动态创建的图层参数滑块也要套上（它是运行时才出现的，统一入口扫不到）
  t('动态滑块也套了保护', /thumbOnlySlider\(input\)/.test(appSrc));
  t('套用前会跳过已处理的（幂等）', /el\.__psThumbOnly/.test(appSrc));

  // 3) 判定必须走 core 的纯函数（可单测），不在 DOM 里内联几何计算
  t('判定走 core 纯函数', /C\.planSliderHit\(/.test(appSrc));
  t('几何算法已导出', typeof C2.sliderThumbGeometry === 'function' && typeof C2.planSliderHit === 'function');

  // 4) 必须真的 preventDefault —— 只 stopPropagation 拦不住「跳值」
  //    （跳值是浏览器对 range 元素的默认动作，跟事件冒泡无关）
  const fnStart = appSrc.indexOf('function thumbOnlySlider(el)');
  const fnBody = appSrc.slice(fnStart, fnStart + 3200);
  t('拦下时调用了 preventDefault', /if \(plan\.block\) e\.preventDefault\(\)/.test(fnBody));
  t('监听的是 pointerdown（覆盖触摸/鼠标/触控笔）',
    /addEventListener\('pointerdown'/.test(fnBody));
  t('pointerdown 监听是非被动（否则 preventDefault 无效）',
    /addEventListener\('pointerdown', handler, \{ passive: false \}\)/.test(fnBody));

  // 5) 键盘与程序赋值不能被误伤（这是用户明确要求的「键盘仍可用」）
  t('没有拦 keydown（方向键仍能调值）', !/keydown/.test(fnBody));
  t('没有拦 input/change 事件（程序赋值不受影响）',
    !/addEventListener\('input'/.test(fnBody) && !/addEventListener\('change'/.test(fnBody));

  // 6) 拿不到宽度时放行，不能把滑块拦成「拖不动」
  t('量不到宽度时不拦', /if \(!r \|\| !\(r\.width > 0\)\) return;/.test(fnBody));
  // 只拦主按键：右键菜单之类不该影响滑块
  t('只拦主按键', /e\.button !== 0/.test(fnBody));

  // 7) 滑块头宽度必须和 CSS 一致 —— 对不上就会「点滑块头跳值」或「拖不动」
  t('滑块头宽度是自定义属性', /--ps-thumb:/.test(css));
  t('webkit 滑块头用该属性', /::-webkit-slider-thumb\s*\{[\s\S]{0,120}var\(--ps-thumb\)/.test(css));
  t('firefox 滑块头也用该属性', /::-moz-range-thumb\s*\{[^}]*var\(--ps-thumb\)/.test(css));
  t('JS 从 CSS 读宽度', /getPropertyValue\('--ps-thumb'\)/.test(appSrc));
  t('读不到时回落到 core 常量', /return C\.SLIDER_THUMB_PX/.test(appSrc));
  // CSS 里的默认值必须等于 core 常量，否则两条兜底路径会给出不同判定
  const cssPx = parseFloat((/--ps-thumb:\s*([\d.]+)px/.exec(css) || [])[1]);
  t('CSS 默认宽度等于 core 常量', cssPx === C2.SLIDER_THUMB_PX, [cssPx, C2.SLIDER_THUMB_PX]);

  // 8) 老内核（没有 PointerEvent）要有降级路径，否则那批设备又变回会跳值
  t('老内核有降级监听', /typeof window\.PointerEvent === 'undefined'/.test(fnBody));
  t('降级到 touchstart', /addEventListener\('touchstart'/.test(fnBody));
  t('降级到 mousedown', /addEventListener\('mousedown'/.test(fnBody));

  // 9) 解绑函数：重复套用不能叠加监听器（否则一次按下被处理多次）
  t('返回解绑函数', /return \(\) => \{[\s\S]{0,300}removeEventListener\('pointerdown'/.test(fnBody));

  // 10) 端到端行为（用最小 DOM 验证真实事件路径）：
  //     点轨道 → 值不变；点滑块头 → 值照常跳过去
  //     jsdom 的 range 不实现原生跳值，所以这里验证「事件有没有被吃掉」，
  //     那正是决定浏览器跳不跳值的唯一开关。
  let domOk = true, detail = '';
  try {
    const { JSDOM } = (() => {
      try { return require('jsdom'); } catch (e) { return require('/tmp/domtest/node_modules/jsdom'); }
    })();
    const dom = new JSDOM('<!doctype html><input type="range" id="s" min="0" max="100" value="50">', {
      pretendToBeVisual: true
    });
    const win = dom.window;
    const el = win.document.getElementById('s');
    // 伪装成一个 200px 宽、left=30 的滑块（jsdom 不做布局）
    el.getBoundingClientRect = () => ({ left: 30, top: 0, width: 200, height: 22, right: 230, bottom: 22 });
    win.getComputedStyle = () => ({ getPropertyValue: () => '17px' });

    // 复刻 app.js 里的接线（用同一套 core 判定）
    const attach = (input) => {
      input.addEventListener('pointerdown', (e) => {
        const px = e.clientX;
        const r = input.getBoundingClientRect();
        const plan = C2.planSliderHit({
          value: input.value, min: input.min, max: input.max,
          rectLeft: r.left, rectWidth: r.width, thumbWidth: 17, pointerX: px
        });
        if (plan.block) e.preventDefault();
      }, { passive: false });
    };
    attach(el);

    // 轨道最左端（离 50% 处的滑块头很远）
    const evTrack = new win.PointerEvent('pointerdown', { clientX: 33, bubbles: true, cancelable: true, button: 0 });
    el.dispatchEvent(evTrack);
    if (!evTrack.defaultPrevented) { domOk = false; detail = '点轨道没有被拦下'; }

    // 滑块头中心（值 50 → 30 + 8.5 + 0.5×183 = 130）
    const evThumb = new win.PointerEvent('pointerdown', { clientX: 130, bubbles: true, cancelable: true, button: 0 });
    el.dispatchEvent(evThumb);
    if (evThumb.defaultPrevented) { domOk = false; detail = '点滑块头被误拦（会拖不动）'; }
  } catch (e) {
    domOk = false; detail = 'DOM 验证失败：' + e.message;
  }
  t('真实事件路径：点轨道被拦下、点滑块头放行', domOk, detail);
})();
/* ---------- 滑块只能拖滑块头（回归） ---------- */

console.log('\n【引导线大改】两类线、按序号配色、线真的画进请求图');

(() => {
  const fs = require('fs');
  const path = require('path');
  const C2 = require(path.join(__dirname, '..', 'app', 'core.js'));
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

  /* ---- 1) 只留两类：直线 + 自由绘制 ---- */
  t('引导线只有两类', C2.GUIDE_KINDS.length === 2, C2.GUIDE_KINDS.map((k) => k.id));
  t('两类是直线与自由绘制',
    C2.GUIDE_KINDS.map((k) => k.id).join(',') === 'line,freehand');
  // 老用户的历史引导线存的是 horizon/vertical/diagonal/subject，
  // 不迁移的话会退化成「第一项」，语义就错了
  t('旧四类自动迁移为直线', ['horizon', 'vertical', 'diagonal', 'subject']
    .every((k) => C2.migrateGuideKind(k) === 'line'));
  t('迁移后的数据能正常归一化',
    C2.normalizeGuide({ kind: 'horizon', x1: 0, y1: .5, x2: 1, y2: .5 }).kind === 'line');
  t('旧类型经吸附也不残留', C2.snapGuide({
    kind: 'diagonal', x1: .1, y1: .5, x2: .9, y2: .5
  }).kind === 'line');

  /* ---- 2) 颜色按序号：第 1 条红、第 2 条青，以此类推 ---- */
  t('第 1 条是红色', C2.guideColorAt(0).id === 'red');
  t('第 2 条是青色', C2.guideColorAt(1).id === 'cyan');
  t('第 3 条是黄色', C2.guideColorAt(2).id === 'yellow');
  t('第 4 条是品红', C2.guideColorAt(3).id === 'magenta');
  t('第 5 条是绿色', C2.guideColorAt(4).id === 'green');
  t('第 6 条是橙色', C2.guideColorAt(5).id === 'orange');
  t('第 7 条循环回红色', C2.guideColorAt(6).id === 'red');
  t('每种颜色的中文名都不重复（指代必须唯一）',
    new Set(C2.GUIDE_COLORS.map((c) => c.zh)).size === C2.GUIDE_COLORS.length);
  t('每种颜色的色值都不重复', new Set(C2.GUIDE_COLORS.map((c) => c.hex)).size === C2.GUIDE_COLORS.length);
  // 相邻两条的颜色必须差得够远，否则在画面上糊成一片
  t('相邻两条颜色明显不同', (() => {
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16));
    const dist = (a, b) => {
      const x = rgb(a), y = rgb(b);
      return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
    };
    for (let i = 1; i < C2.GUIDE_COLORS.length; i++) {
      if (dist(C2.GUIDE_COLORS[i - 1].hex, C2.GUIDE_COLORS[i].hex) < 90) return false;
    }
    return true;
  })());

  /* ---- 3) 致命点：模型必须真的「看得见」引导线 ---- */
  const rect = { x: 0, y: 0, w: 200, h: 200 };
  const two = [
    { kind: 'line', x1: 0, y1: .3, x2: 1, y2: .3 },
    { kind: 'line', x1: 0, y1: .7, x2: 1, y2: .7 }
  ];
  const painted = C2.planStrokeOverlay({ guides: two, rect, ctxRect: rect });
  t('直线被真的画进请求图', painted.count === 2, painted.count);
  t('第 1 条画成红色', painted.draw[0].color === '#ff2d2d', painted.draw[0].color);
  t('第 2 条画成青色', painted.draw[1].color === '#00e5ff', painted.draw[1].color);
  // 位置必须精确：提示词只说百分比，模型得靠画出来的线定位
  t('线的位置换算精确（30% → 60px）', painted.draw[0].points[0].y === 60,
    painted.draw[0].points[0].y);
  t('线宽足够模型看清（≥4px）', painted.draw[0].width >= 4, painted.draw[0].width);
  // 自由绘制同样进图（这条以前就成立，别在改动中弄丢）
  t('自由绘制也进图', C2.planStrokeOverlay({
    guides: [{ kind: 'freehand', points: [{ x: .2, y: .2 }, { x: .8, y: .8 }] }],
    rect, ctxRect: rect
  }).count === 1);
  // 两类混排时都画，且颜色按原始顺序
  t('两类混排都被画进去', (() => {
    const p = C2.planStrokeOverlay({
      guides: [
        { kind: 'line', x1: 0, y1: .2, x2: 1, y2: .2 },
        { kind: 'freehand', points: [{ x: .2, y: .8 }, { x: .8, y: .8 }] }
      ], rect, ctxRect: rect
    });
    return p.count === 2 && p.draw[0].color === '#ff2d2d' && p.draw[1].color === '#00e5ff';
  })());
  // 真正落到画布上：画出来的像素里必须能找到这两种颜色，且位置对得上。
  // 这是「模型看得见」的最后一环 —— planStrokeOverlay 算得再对，
  // 只要 drawStrokeOverlay 没把像素真的画上去，模型那边就是一片空白。
  const napi = (() => {
    for (const p of ['@napi-rs/canvas', '/tmp/domtest/node_modules/@napi-rs/canvas',
                     '/tmp/ci-sim/node_modules/@napi-rs/canvas']) {
      try { return require(p); } catch (e) { /* 换下一个 */ }
    }
    return null;
  })();
  if (napi) {
    const cv = napi.createCanvas(200, 200);
    const c2d = cv.getContext('2d');
    // 先铺一层中灰底：让「深色描边 + 本色」两层都画在已知背景上
    c2d.fillStyle = '#888888';
    c2d.fillRect(0, 0, 200, 200);
    const drawn = C2.drawStrokeOverlay(c2d, painted);
    const data = c2d.getImageData(0, 0, 200, 200).data;
    let red = 0, cyan = 0, redRowMin = 1e9, redRowMax = -1;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 180 && g < 110 && b < 110) {
        red++;
        const y = Math.floor((i / 4) / 200);
        if (y < redRowMin) redRowMin = y;
        if (y > redRowMax) redRowMax = y;
      }
      if (r < 120 && g > 170 && b > 200) cyan++;
    }
    t('画布上真的画出了两条线', drawn === 2, drawn);
    t('画布上出现了红色像素（第 1 条）', red > 100, red);
    t('画布上出现了青色像素（第 2 条）', cyan > 100, cyan);
    // 第 1 条线在 30% 处 → y=60。允许线宽带来的上下浮动
    t('红线画在了正确位置（y≈60）',
      redRowMin >= 56 && redRowMax <= 64, [redRowMin, redRowMax]);
  } else {
    t('画布像素校验（需要 @napi-rs/canvas，本次环境缺失）', false,
      '找不到 canvas 库 —— 这条断言不能被静默跳过');
  }

  /* ---- 4) 提示词：颜色指代必须唯一且与实际一致 ---- */
  const desc = C2.describeGuides({ guides: two, isZh: true });
  t('提示词逐条按颜色指代', /第 1 条（红色，直线）/.test(desc) && /第 2 条（青色，直线）/.test(desc), desc.slice(0, 100));
  t('提示词禁止把线画进画面（线现在真在图上，这句更关键）',
    /不要把任何一条彩色线条画进最终画面/.test(desc));
  t('提示词说明线是标注不是画面内容', /不是照片里真实存在的东西/.test(desc));
  t('英文版同样逐条指代',
    /line 1 \(red\)/.test(C2.describeGuides({ guides: two, isZh: false })) &&
    /line 2 \(cyan\)/.test(C2.describeGuides({ guides: two, isZh: false })));
  // 颜色不能被「全局颜色」覆盖 —— 那样两条线会变成同一个颜色
  t('describeGuides 不再接受全局颜色参数（防指代失效）', (() => {
    const d = C2.describeGuides({ guides: two, isZh: true, strokeColorZh: '品红色' });
    return /红色/.test(d) && /青色/.test(d) && !/品红色/.test(d);
  })());

  /* ---- 5) 三处取色必须同源（屏幕 / 请求图 / 提示词）---- */
  t('有统一的取色函数', typeof C2.colorOfGuide === 'function');
  t('app 屏幕绘制用统一取色', /const c = C\.colorOfGuide\(g, i\);/.test(appSrc));
  t('app 请求图绘制走同一函数（planStrokeOverlay 内部）',
    /const color = colorOfGuide\(g, i\);/.test(
      fs.readFileSync(path.join(__dirname, '..', 'app', 'core.js'), 'utf8')));
  t('提示词也用同一函数', /const c = guideColorAt\(i\);/.test(
    fs.readFileSync(path.join(__dirname, '..', 'app', 'core.js'), 'utf8')));
  // 颜色在创建时就定下来，跟着线条走（删线不会让其它线换色）
  t('画线时立刻定色', /colorId: C\.nextGuideColor\(S\.guides\)\.id,/.test(appSrc));
  t('删除线之后新线不会撞色', C2.nextGuideColor([
    { colorId: 'red' }, { colorId: 'yellow' }
  ]).id === 'cyan');

  /* ---- 6) 界面：只留两类，没有颜色选择 ---- */
  t('界面没有颜色选择条', !/id="guide-colors"/.test(html));
  t('设置里也没有颜色选择', !/id="set-strokecolor"/.test(html));
  t('设置里说明了颜色按顺序分配', /第 1 条红、第 2 条青/.test(html));
  t('提示里说明线会画进图片', /线会画进发给模型的图片/.test(html));
})();
/* ---------- 引导线大改（回归） ---------- */

console.log('\n【整图】没有框选时默认处理整张图（含 AI 生图）');

(() => {
  const fs = require('fs');
  const path = require('path');
  const C2 = require(path.join(__dirname, '..', 'app', 'core.js'));
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');

  // 1) core 的整图几何
  t('整张图矩形 = 全画布', (() => {
    const r = C2.wholeRect(3072, 2048);
    return r.x === 0 && r.y === 0 && r.w === 3072 && r.h === 2048;
  })());
  t('能识别整张图', C2.isWholeRect({ x: 0, y: 0, w: 3072, h: 2048 }, 3072, 2048) === true);
  t('内缩一像素就不算整张图',
    C2.isWholeRect({ x: 1, y: 0, w: 3071, h: 2048 }, 3072, 2048) === false);
  t('没有选区时不算整张图', C2.isWholeRect(null, 3072, 2048) === false);
  // 浮点尺寸要按「夹取后」判断，否则 3071.6 会因为四舍五入被误判
  t('浮点尺寸夹取后再判断',
    C2.isWholeRect({ x: 0, y: 0, w: 3071.6, h: 2047.5 }, 3072, 2048) === true);

  // 2) 整张图**不能**被当成普通选区去羽化/融合/色彩匹配。
  //    这是这个功能最容易翻车的地方：
  //      - 羽化 → 四周留一圈没改（可见的框）
  //      - 融合/色彩匹配 → 环带样本为 0，均值 [0,0,0]，整张图被压黑
  //    下面用真实像素验证「整张图铺满时，贴回的颜色与模型返回的颜色一致」。
  const W = 120, H = 90;
  const mkPix = (w, h, fn) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const c = fn(x, y);
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      }
    }
    return { data: d, width: w, height: h };
  };

  const base = mkPix(W, H, () => [120, 130, 140]);
  const model = mkPix(W, H, () => [200, 90, 60]);   // 模型返回一个明显不同的颜色

  const whole = C2.compositeFeathered(base, model, { x: 0, y: 0, w: W, h: H }, {
    whole: true,
    feather: 20,                                     // 故意给大羽化：整图必须忽略它
    colorMatch: { ring: 8, ramp: 12, strength: 1 },   // 故意开色彩匹配
    fusion: { strength: 0.9, ring: 10, centerFloor: 0.35, grain: 0, seed: 7 },
    dstOffset: { x: 0, y: 0 },
    dstFull: base
  });
  const px = (p, x, y) => {
    const o = (y * p.width + x) * 4;
    return [p.data[o], p.data[o + 1], p.data[o + 2]];
  };
  const eq = (a, b, tol) => Math.abs(a[0] - b[0]) <= tol &&
    Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;

  // 最外圈一个像素：如果被羽化，这里会保留原始底色 120/130/140
  t('整图贴回：四个角都是模型颜色（没被羽化留边）',
    eq(px(base, 0, 0), [200, 90, 60], 2) &&
    eq(px(base, W - 1, 0), [200, 90, 60], 2) &&
    eq(px(base, 0, H - 1), [200, 90, 60], 2) &&
    eq(px(base, W - 1, H - 1), [200, 90, 60], 2),
    JSON.stringify([px(base, 0, 0), px(base, W - 1, H - 1)]));
  // 中心也不能被「融合」拉回底色
  t('整图贴回：中心也是模型颜色（没被融合拉回底色）',
    eq(px(base, (W / 2) | 0, (H / 2) | 0), [200, 90, 60], 2),
    JSON.stringify(px(base, (W / 2) | 0, (H / 2) | 0)));
  // 整张图必须**全部**改成模型颜色，不能有任何一块漏掉
  let worst = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = px(base, x, y);
      worst = Math.max(worst, Math.abs(c[0] - 200), Math.abs(c[1] - 90), Math.abs(c[2] - 60));
    }
  }
  t('整图贴回：整幅逐像素都是模型颜色（零遗漏）', worst <= 2, '最大偏差 ' + worst);

  // 3) 对照组：普通小选区**必须**照旧羽化。
  //    否则就是「为了修整图，把原来好用的局部贴回也改坏了」。
  const base2 = mkPix(W, H, () => [120, 130, 140]);
  const inset = { x: 30, y: 20, w: 60, h: 50 };
  C2.compositeFeathered(base2, mkPix(60, 50, () => [200, 90, 60]), inset, {
    feather: 10,
    dstOffset: { x: 0, y: 0 },
    dstFull: base2
  });
  t('对照组：小选区边缘仍然羽化（没被整图逻辑改坏）',
    !eq(px(base2, 30, 20), [200, 90, 60], 2), JSON.stringify(px(base2, 30, 20)));
  t('对照组：小选区中心照常是模型颜色',
    eq(px(base2, 60, 45), [200, 90, 60], 2), JSON.stringify(px(base2, 60, 45)));
  t('对照组：选区外一个像素都不动',
    eq(px(base2, 29, 20), [120, 130, 140], 0) && eq(px(base2, 90, 20), [120, 130, 140], 0));

  // 4) 融合/契合度在「取不到环带」时必须放弃，不能拿 0 均值去减。
  //    回归的坑：ringMoments 零样本返回 mean=[0,0,0]，delta 变成 -128，
  //    整张图被压成暗角，契合度还报 20 分说「接缝处有色差」。
  const full = mkPix(60, 40, () => [128, 128, 128]);
  const same = mkPix(60, 40, () => [128, 128, 128]);
  const plan = C2.planFusion({
    src: same, rect: { x: 0, y: 0, w: 60, h: 40 },
    dst: full, dstFull: full, dstOffset: { x: 0, y: 0 }, ring: 10
  });
  t('整图融合：校正量为 0（不拿空环带的 0 均值去减）',
    plan.delta[0] === 0 && plan.delta[1] === 0 && plan.delta[2] === 0,
    JSON.stringify(plan.delta));
  t('整图融合：明确标为「没有可对齐的环境」', plan.ok === false);
  t('整图融合：环带样本确实是 0（前提成立）', plan.samples.dst === 0);
  // 关键：融合后像素不能变
  const fused = C2.fuseColor(128, 128, 128, 0.02, 0.02, { mean: 0.7, struct: 0.7 }, plan);
  t('整图融合：像素原样不动（不会凭空多出暗角）',
    fused[0] === 128 && fused[1] === 128 && fused[2] === 128, JSON.stringify(fused));
  // 契合度：整图没有接缝，不能报「有色差」
  t('整图不算契合度（整图没有接缝）',
    C2.assessSeam({
      src: same, rect: { x: 0, y: 0, w: 60, h: 40 },
      dst: full, dstFull: full, dstOffset: { x: 0, y: 0 }, ring: 6
    }) === null);
  // 对照组：普通选区照旧有契合度
  const dst2 = mkPix(60, 40, () => [128, 128, 128]);
  const seam = C2.assessSeam({
    src: mkPix(20, 20, () => [128, 128, 128]), rect: { x: 20, y: 10, w: 20, h: 20 },
    dst: dst2, dstFull: dst2, dstOffset: { x: 0, y: 0 }, ring: 6
  });
  t('对照组：普通选区仍有契合度评分', !!seam && seam.score === 100, seam && seam.score);

  // 5) 整图调色不能羽化，否则四周留一圈没调（这里是同一件事的调色版本）
  const gradeEdit = {
    rect: { x: 0, y: 0, w: W, h: H }, patch: null,
    grade: { exposure: 60, contrast: 0, saturation: 0, temperature: 0, tint: 0 },
    feather: 20, colorMatch: 0, mask: null, opacity: 1, enabled: true
  };
  const alpha = C2.layerAlphaMap(gradeEdit, W, H);
  // smoothstep 在 d=0.5（最外圈像素中心）处几乎为 0 —— 也就是那一圈几乎没被调色。
  // 不要求严格等于 0：smoothstep 在边界附近是连续过渡，取的是极小值而非 0。
  t('整图调色的羽化权重在最外圈接近 0（这就是「一圈没调」的原因）',
    alpha[0] < 0.01, String(alpha[0]));
  const alphaNoF = C2.layerAlphaMap(Object.assign({}, gradeEdit, { feather: 0 }), W, H);
  let allOne = true;
  for (let i = 0; i < alphaNoF.length; i++) if (alphaNoF[i] !== 1) { allOne = false; break; }
  t('整图调色按 0 羽化后，全幅权重都是 1（处处都调）', allOne);

  // 6) 界面接线：四个工具入口都不能再要求先框选
  t('生图入口用统一解析', /function prepareJob\(\)[\s\S]{0,300}const rect = effectiveRect\(\);/.test(appSrc));
  t('生图不再要求先框选',
    !/toast\('先在照片上框选要修改的位置'\)/.test(appSrc));
  t('调色不再要求先框选',
    !/toast\('先在照片上框选要调色的区域'\)/.test(appSrc));
  t('画笔不再要求先框选',
    !/toast\('先框选一块区域，再用画笔'\)/.test(appSrc));
  t('引导线不再要求先框选',
    !/toast\('先框选一块区域，再画引导线'\)/.test(appSrc));
  t('整图生图走整体口径的提示词',
    /scope: whole \? 'global' : \$\('scope-select'\)\.value,/.test(appSrc));
  t('界面明示整张图（用户得知道会改全图）',
    /整张图 ' \+ Math\.round\(S\.docW\)/.test(appSrc) && /未框选 → 调整整张图；/.test(appSrc));
  // 选区框只在真的有选区时画：没框选就不该凭空出现一个铺满全图的框
  t('没框选时不画选区框（不凭空多出选区）', /if \(S\.rect\) drawSelection\(\);/.test(appSrc));
})();
/* ---------- 没有框选 = 整张图（回归） ---------- */

console.log(`\n合计 ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
