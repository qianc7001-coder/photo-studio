/* =============================================================================
 * 修图台 · 应用主体
 *  交互：框选 / 画笔掩膜 / 平移缩放 / 生成 / 对比 / 应用 / 撤销重做 / 导出
 * ========================================================================== */
(function () {
  'use strict';

  const C = window.PSCore;
  const $ = (id) => document.getElementById(id);
  const DPR = () => Math.min(window.devicePixelRatio || 1, 2.5);

  /* ============================ 状态 ============================ */

  // 统一撤销栈：覆盖生成、画笔、删除、调参等所有可撤销操作
  let undoStack = null;

  const S = {
    // 图像
    img: null,            // ImageBitmap / HTMLImageElement（原始）
    imgW: 0, imgH: 0,
    docW: 0, docH: 0,     // 工作分辨率
    docCanvas: null,      // 基准图（原图按工作分辨率绘制，不含编辑）
    docCtx: null,
    viewCanvas: null,     // 当前显示（基准 + 已应用编辑）
    viewCtx: null,

    // 视图
    view: { scale: 1, tx: 0, ty: 0 },

    // 选区
    rect: null,           // 文档坐标 {x,y,w,h}
    ratio: 0,             // 0=自由
    mode: 'select',

    // 画笔
    brushSize: 80,
    // 掩膜初始为「整块都改」，画笔默认从掩膜里「排除」区域，最安全
    brushErase: true,
    strokes: [],          // 文档坐标

    // 编辑历史
    edits: [],            // 已应用的编辑记录
    redo: [],             // 重做栈（编辑记录）

    // 待确认的生成结果
    pending: null,

    // 交互
    pointers: new Map(),
    gesture: null,
    spaceDown: false,

    // 设置
    cfg: null,
    busy: false,
    aborter: null,

    // 原图元数据（EXIF / ICC）：canvas 重绘会丢掉它们，导入时先存下来，导出时写回
    meta: null,        // { exif: Uint8Array|null, icc: Uint8Array|null, iccIsSrgb: boolean, orientation: number|null }

    // 并发控制：docVersion 在换图/改历史时递增，用来丢弃过期的生成结果；
    // genToken 用来防止重复点击生成造成多个请求并发写同一块画布。
    docVersion: 0,
    genToken: 0,

    // 本次会话累计花费（用于让用户对总支出有数）
    spend: { calls: 0, usd: 0, unknownCalls: 0 }
  };

  const DEFAULT_CFG = {
    provider: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'Qwen/Qwen-Image-Edit',
    netMode: 'auto',
    contextPct: 12,
    feather: 10,
    colorMatch: 50,
    maxRes: 3072,
    tile: 1400,
    upscaleSmall: true,
    historyBudgetMB: 192,      // 编辑历史内存上限（超过则降采样/丢弃最老的）
    autoSaveSession: true,     // 自动保存编辑会话，进程被杀后可恢复
    lang: 'auto',
    seed: '',
    exportPreset: 'full',      // 导出预设（决定尺寸/质量/元数据策略）
    priceOverride: '',         // 自定义单价（美元/张），留空则用内置价格表
    usdCny: 7.1,               // 汇率（仅用于人民币参考价）
    format: 'jpeg',
    quality: 95,
    mosaic: false
  };

  // 配置存储键。注意：这里刻意保持键名稳定 —— 覆盖安装后必须能读到旧设置，
  // 所以不能随版本改键名；需要迁移时在 loadCfg 里做字段级兼容。
  const LS_KEY = 'photoStudio.cfg.v1';
  const LS_KEY_PHOTO = 'photoStudio.photo.v1';
  const LS_KEY_VER = 'photoStudio.lastVersion';
  const LS_KEY_SESSION = 'photoStudio.session.v1';
  // 版本号由 version.js（构建时从 version.json 生成）提供，避免多处手改不一致
  const APP_VERSION = (window.PS_VERSION && window.PS_VERSION.versionName) || '1.1.0';
  const CHANGELOG = (window.PS_VERSION && window.PS_VERSION.changelog) || [];

  /** 用户数据字段：升级时必须原样保留，绝不因版本变化被重置 */
  const PERSIST_KEYS = [
    'provider', 'baseUrl', 'apiKey', 'model', 'netMode',
    'contextPct', 'feather', 'colorMatch', 'maxRes', 'tile',
    'lang', 'seed', 'format', 'quality', 'mosaic', 'upscaleSmall', 'exportPreset',
    'priceOverride', 'usdCny',
    'historyBudgetMB', 'autoSaveSession'
  ];

  function loadCfg() {
    let c = Object.assign({}, DEFAULT_CFG);
    let saved = null;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (e) { /* 数据损坏则用默认值 */ }

    if (saved && typeof saved === 'object') {
      // 只接受已知字段，未知字段忽略；缺失字段用默认值补齐
      for (const k of PERSIST_KEYS) {
        if (saved[k] !== undefined && saved[k] !== null) c[k] = saved[k];
      }
      // 数值型字段做一次类型校正，避免历史脏数据导致计算异常
      c.contextPct = clampNum(c.contextPct, 0, 60, DEFAULT_CFG.contextPct);
      c.feather = clampNum(c.feather, 0, 60, DEFAULT_CFG.feather);
      c.colorMatch = clampNum(c.colorMatch, 0, 100, DEFAULT_CFG.colorMatch);
      c.maxRes = clampNum(c.maxRes, 0, 8192, DEFAULT_CFG.maxRes);
      c.tile = clampNum(c.tile, 0, 2000, DEFAULT_CFG.tile);
      c.quality = clampNum(c.quality, 70, 100, DEFAULT_CFG.quality);
      if (!c.baseUrl && c.provider) {
        const p = C.getProvider(c.provider);
        if (p && p.baseUrl) c.baseUrl = p.baseUrl;
      }
    }
    return c;
  }

  function clampNum(v, min, max, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  }

  function saveCfg() {
    try {
      // 只写用户数据字段，不写运行期状态，避免把内部状态混进配置
      const out = {};
      for (const k of PERSIST_KEYS) out[k] = S.cfg[k];
      out.__savedAt = Date.now();
      localStorage.setItem(LS_KEY, JSON.stringify(out));
    } catch (e) { /* 隐私模式下可能不可用，忽略 */ }
  }

  /**
   * 升级后的首启处理：明确告知「设置被保留」，并展示本次更新内容。
   * 这是用户最关心的两件事 —— 配置有没有丢、这次改了什么。
   */
  function checkUpgrade() {
    let last = null;
    try { last = localStorage.getItem(LS_KEY_VER); } catch (e) { /* ignore */ }
    const isUpgrade = !!(last && last !== APP_VERSION);
    const hasKey = !!(S.cfg.apiKey && S.cfg.model);

    if (isUpgrade) {
      // 用常驻条而不是一闪而过的 toast：升级后用户最想知道设置还在不在
      const bar = $('upgrade-bar');
      if (bar) {
        const keep = hasKey
          ? '你的 API 设置已保留，可直接使用。'
          : '还没有配置 API，点「设置」填写接口地址与 API Key。';
        bar.innerHTML =
          '<div class="ub-main">' +
            '<div class="ub-title">已更新到 v' + APP_VERSION + '</div>' +
            '<div class="ub-sub">' + keep + '</div>' +
          '</div>' +
          (CHANGELOG.length ? '<button class="ghost small" id="ub-whatsnew">更新内容</button>' : '') +
          '<button class="tb-btn icon" id="ub-close"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
        bar.hidden = false;
        const cl = $('ub-close');
        if (cl) cl.onclick = () => { bar.hidden = true; };
        const wn = $('ub-whatsnew');
        if (wn) wn.onclick = showChangelog;
      }
    }
    try { localStorage.setItem(LS_KEY_VER, APP_VERSION); } catch (e) { /* ignore */ }
  }

  /** 展示本次更新内容 */
  function showChangelog() {
    const el = $('gen-error');
    if (!el) return;
    el.innerHTML =
      '<div class="err-head">' +
        '<div class="err-title" style="color:#cfe4ff">修图台 v' + APP_VERSION + ' 更新内容</div>' +
        '<button class="tb-btn icon err-close" id="err-close">' +
          '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
        '</button>' +
      '</div>' +
      '<ul class="whatsnew">' + CHANGELOG.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' +
      '<div class="err-actions"><button class="primary small" id="err-ok">知道了</button></div>';
    el.hidden = false;
    el.style.borderColor = 'rgba(77,163,255,.4)';
    const c = $('err-close'); if (c) c.onclick = () => { el.hidden = true; el.style.borderColor = ''; };
    const k = $('err-ok'); if (k) k.onclick = () => { el.hidden = true; el.style.borderColor = ''; };
  }

  /* ============================ 提示 ============================ */

  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { el.hidden = true; }, 260);
    }, ms || 2600);
  }
  function setBusy(on, title, sub) {
    S.busy = on;
    $('busy').hidden = !on;
    if (title) $('busy-title').textContent = title;
    $('busy-sub').textContent = sub || '';
    $('btn-generate').disabled = on || !S.img || !S.rect;
  }

  /* ============================ 画布尺寸 ============================ */

  const stage = $('stage');
  const cv = $('cv');
  let ctx = null;

  let lastCanvasW = 0, lastCanvasH = 0;

  function resizeCanvas() {
    const r = stage.getBoundingClientRect();
    const d = DPR();
    const w = Math.max(1, Math.round(r.width * d));
    const h = Math.max(1, Math.round(r.height * d));
    // 尺寸没变就不动：重建后备存储会丢内容，频繁重建还会闪烁
    if (w === lastCanvasW && h === lastCanvasH && ctx) return;
    lastCanvasW = w; lastCanvasH = h;
    cv.width = w;
    cv.height = h;
    cv.style.width = r.width + 'px';
    cv.style.height = r.height + 'px';
    ctx = cv.getContext('2d');
    if (!ctx) { showFatal('画布', new Error('无法获取画布上下文，可能是内存不足')); return; }
    ctx.setTransform(d, 0, 0, d, 0, 0);
    draw();
  }

  // 内存吃紧时浏览器会丢弃 canvas 内容（context lost），画面会整块变黑。
  // 这里捕获并重建，而不是让用户面对黑屏。
  cv.addEventListener('contextlost', (e) => {
    e.preventDefault();
    toast('画面被系统回收，正在恢复…', 3000);
  });
  cv.addEventListener('contextrestored', () => {
    lastCanvasW = lastCanvasH = 0;
    resizeCanvas();
    draw();
  });

  function viewSize() {
    const r = stage.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  /* ============================ 图像载入 ============================ */

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /**
   * 读一张图片文件。
   *
   * 关键点：手机照片动辄 4000x3000 甚至 8000x6000，直接 createImageBitmap 全尺寸解码
   * 需要 50~200MB 连续内存，WebView 渲染进程很容易被系统杀掉 —— 表现就是「导入后黑屏」。
   * 所以这里在「解码阶段」就用 resizeWidth/resizeHeight 直接解出工作尺寸的位图，
   * 从源头避免超大分配。
   */
  async function decodeToWorkSize(blob, maxSide) {
    let srcW = 0, srcH = 0;

    // 第一步：只读文件头拿到原始像素尺寸（不分配任何像素内存）
    if (maxSide > 0 && blob.size > 0) {
      try {
        const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
        const info = C.parseImageSize(head);
        if (info && info.width > 0 && info.height > 0) {
          srcW = info.width; srcH = info.height;
        }
      } catch (e) { /* 解析失败就走全尺寸解码 */ }
    }

    if (typeof createImageBitmap === 'function') {
      // 第二步：如果原图比工作尺寸大，在解码阶段就直接解出缩小版，
      // 完全不产生全尺寸位图 —— 这是避免「导入大照片黑屏」的关键。
      if (maxSide > 0 && srcW > 0 && Math.max(srcW, srcH) > maxSide) {
        const k = maxSide / Math.max(srcW, srcH);
        const tw = Math.max(1, Math.round(srcW * k));
        const th = Math.max(1, Math.round(srcH * k));
        try {
          return await createImageBitmap(blob, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
        } catch (e) { /* 落到全尺寸解码 */ }
      }
      try {
        return await createImageBitmap(blob);
      } catch (e) { /* 落到 img 兜底 */ }
    }

    return await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('这个格式的图片打不开'));
      im.src = URL.createObjectURL(blob);
    });
  }

  async function loadImageFromBlob(blob, name) {
    const maxSide = Number(S.cfg.maxRes) || 0;
    // 先把原图的 EXIF / ICC 存下来：canvas 一重绘这些就没了，
    // 而摄影师交片需要保留相机型号、镜头、光圈快门 ISO、拍摄时间等信息。
    S.meta = await captureMetadata(blob);
    let bmp;
    try {
      bmp = await decodeToWorkSize(blob, maxSide);
    } catch (e) {
      toast('照片打开失败：' + (e && e.message ? e.message : e), 4200);
      return;
    }
    setImage(bmp, name || 'photo.jpg');
  }

  /**
   * 从原始文件里提取 EXIF 与 ICC 色彩配置。
   * 只对 JPEG 有效（PNG/WebP 的结构不同，暂不处理，但不会报错）。
   */
  async function captureMetadata(blob) {
    const out = { exif: null, icc: null, iccIsSrgb: true, orientation: null, source: 'none' };
    try {
      if (!blob || blob.size === 0) return out;
      // 元数据都在文件头部，读前 256KB 足够（ICC 较大时可能需要更多，做两次尝试）
      let bytes = new Uint8Array(await blob.slice(0, Math.min(blob.size, 256 * 1024)).arrayBuffer());
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return out;   // 非 JPEG
      out.source = 'jpeg';

      // ICC 可能很大，若头部没找全就扩大读取范围
      let icc = C.extractICC(bytes);
      if (!icc && blob.size > bytes.length) {
        bytes = new Uint8Array(await blob.slice(0, Math.min(blob.size, 2 * 1024 * 1024)).arrayBuffer());
        icc = C.extractICC(bytes);
      }
      if (icc) {
        out.icc = icc;
        out.iccIsSrgb = C.isSrgbProfile(icc);
      }

      const tiff = C.extractExif(bytes);
      if (tiff) {
        out.orientation = C.readExifOrientation(tiff);
        // 像素已被浏览器按 Orientation 旋转过，写回时必须归一化为 1，否则会二次旋转
        out.exif = C.normalizeExifOrientation(tiff);
      }
      return out;
    } catch (e) {
      console.warn('[修图台] 读取元数据失败（不影响使用）', e);
      return out;
    }
  }

  function setImage(src, name) {
    // 兜底：万一某条路径还是给出了超大位图，这里强制按工作尺寸绘制，
    // 绝不把全尺寸图塞进 canvas（否则仍然会 OOM）
    const hardMax = 8192;
    // 换图时立刻中止在途的生成请求：否则旧请求返回后可能把结果贴到新照片上
    if (S.aborter) {
      try { S.aborter.abort(); } catch (e) { /* ignore */ }
      S.aborter = null;
    }
    S.genToken++;                 // 让旧请求的后续步骤全部失效
    S.pending = null;
    const cmpEl = $('compare');
    if (cmpEl) cmpEl.hidden = true;   // 否则对比面板会残留旧图，且 Esc/应用都关不掉
    cmpBefore = cmpAfter = null;
    setBusy(false);

    S.img = src;
    S.imgW = src.width;
    S.imgH = src.height;

    let scale = 1;
    const maxRes = Number(S.cfg.maxRes) || 0;
    const limit = maxRes > 0 ? Math.min(maxRes, hardMax) : hardMax;
    if (Math.max(S.imgW, S.imgH) > limit) {
      scale = limit / Math.max(S.imgW, S.imgH);
    }
    S.docW = Math.max(1, Math.round(S.imgW * scale));
    S.docH = Math.max(1, Math.round(S.imgH * scale));

    try {
      S.docCanvas = makeCanvas(S.docW, S.docH);
      S.docCtx = S.docCanvas.getContext('2d', { willReadFrequently: true });
      if (!S.docCtx) throw new Error('无法创建画布（内存不足）');
      S.docCtx.imageSmoothingQuality = 'high';
      S.docCtx.drawImage(S.img, 0, 0, S.docW, S.docH);
    } catch (e) {
      showFatal('导入', e);
      S.docCanvas = null; S.docCtx = null;
      return;
    }

    S.edits = [];
    S.redo = [];
    S.rect = null;
    S.strokes = [];
    S.pending = null;
    S.docVersion++;      // 旧文档的生成结果一律作废
    try { localStorage.removeItem(LS_KEY_SESSION); } catch (e) { /* ignore */ }

    $('file-name').textContent = name;
    const metaBits = [];
    if (S.meta && S.meta.exif) metaBits.push('拍摄信息');
    if (S.meta && S.meta.icc) metaBits.push(S.meta.iccIsSrgb ? 'sRGB' : '广色域');
    if (S.meta && S.meta.orientation && S.meta.orientation !== 1) metaBits.push('已校正旋转');
    updatePresetUI();
    $('file-meta').textContent = `${S.imgW}×${S.imgH}` +
      (scale < 1 ? ` → 工作 ${S.docW}×${S.docH}` : '') +
      (metaBits.length ? ` · 含${metaBits.join(' / ')}` : '');
    $('empty').hidden = true;
    $('hud').hidden = false;
    $('btn-save').disabled = false;
    $('btn-undo').disabled = true;
    $('btn-redo').disabled = true;

    rebuildViewCanvas();
    fitToScreen();
    updateUI();
    savePhotoRef(name);
  }

  /**
   * 把一次编辑真正合成进目标画布。
   *
   * 注意 dst 必须是「整图」：接缝色彩匹配需要在选区外侧取环形样本，
   * 如果只传裁出来的选区子图，外侧样本会全部落在图外被丢弃，
   * 色彩匹配就会静默失效（delta 恒为 0）。
   * 这个函数被「应用」「撤销重做重放」「导出」三处共用，保证三者结果一致。
   */
  function compositeEditInto(targetCtx, edit) {
    const r = edit.rect;
    const id = targetCtx.getImageData(r.x, r.y, r.w, r.h);
    // patch 的分辨率可能高于选区（小选区上采样时保留了模型输出的高分辨率）。
    // 这里统一缩放到选区尺寸再合成，保证羽化/掩膜的坐标与选区一一对应。
    let patchSrc = edit.patch;
    if (edit.patch.width !== r.w || edit.patch.height !== r.h) {
      const tmp = makeCanvas(r.w, r.h);
      const tx = tmp.getContext('2d', { willReadFrequently: true });
      tx.imageSmoothingEnabled = true;
      tx.imageSmoothingQuality = 'high';
      tx.drawImage(edit.patch, 0, 0, edit.patch.width, edit.patch.height, 0, 0, r.w, r.h);
      patchSrc = tmp;
    }
    const src = patchSrc.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, r.w, r.h);
    // 接缝色彩匹配要在选区外侧取环形样本，而这里 dst 只是裁出来的子图，
    // 子图之外没有像素 —— 所以额外把「整图当前状态」读一份传给合成器当参考。
    // 只在真正需要色彩匹配时才读，避免白白复制一份整图。
    let fullPix = null;
    if (edit.colorMatch > 0 && targetCtx.canvas) {
      try {
        fullPix = targetCtx.getImageData(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
      } catch (e) { fullPix = null; }
    }
    // 图层开关：关闭时完全不合成（用于对比「改之前」）
    const L = C.normalizeLayer(edit);
    if (!L.enabled) return;
    // 图层不透明度：用来「减弱」效果，无需重新调用模型（不花钱）
    const maskForComposite = (() => {
      const base = (edit.mask && edit.mask.length === r.w * r.h) ? edit.mask : null;
      if (L.opacity >= 0.999) return base;
      // 把不透明度乘进掩膜：这样画笔排除的区域仍然严格为 0
      const out = new Float32Array(r.w * r.h);
      for (let i = 0; i < out.length; i++) {
        out[i] = (base ? base[i] : 1) * L.opacity;
      }
      return out;
    })();
    C.compositeFeathered(id, src, { x: 0, y: 0, w: r.w, h: r.h }, {
      feather: edit.feather,
      colorMatch: {
        ring: 8,
        ramp: Math.max(6, edit.feather || 8),
        strength: edit.colorMatch
      },
      mask: maskForComposite,
      dstOffset: { x: r.x, y: r.y },
      dstFull: fullPix
    });
    targetCtx.putImageData(id, r.x, r.y);
  }

  /**
   * 按内存预算整理编辑历史。
   * 超出预算时：先把较老的 patch 降采样（省内存），仍不够就丢弃最老的。
   * 每次新增编辑后调用，避免手机被系统杀掉。
   */
  function enforceHistoryBudget() {
    if (!S.edits.length) return;
    const budget = (Number(S.cfg.historyBudgetMB) || 192) * 1024 * 1024;
    const plan = C.planHistoryMemory(S.edits, budget);
    if (!plan.downscale.length && !plan.drop) return;

    // 丢弃最老的（从前往后删）
    if (plan.drop > 0) {
      S.edits.splice(0, plan.drop);
    }
    // 对指定条目做降采样（边长减半，内存降到 1/4）
    for (const idx of plan.downscale) {
      const e = S.edits[idx];
      if (!e || !e.patch || e.patch.__halved) continue;
      const w = Math.max(1, Math.round(e.patch.width / 2));
      const h = Math.max(1, Math.round(e.patch.height / 2));
      const small = makeCanvas(w, h);
      const sx = small.getContext('2d', { willReadFrequently: true });
      sx.imageSmoothingEnabled = true;
      sx.imageSmoothingQuality = 'high';
      sx.drawImage(e.patch, 0, 0, e.patch.width, e.patch.height, 0, 0, w, h);
      e.patch = small;
      e.patch.__halved = true;
      e.downscaled = true;
    }
    if (plan.note) S.historyNote = plan.note;
  }

  /** 把当前编辑结果重新渲染到 viewCanvas */
  function rebuildViewCanvas() {
    if (!S.docCanvas) return;
    S.viewCanvas = makeCanvas(S.docW, S.docH);
    S.viewCtx = S.viewCanvas.getContext('2d', { willReadFrequently: true });
    S.viewCtx.drawImage(S.docCanvas, 0, 0);
    // 必须按序「重新合成」而不是硬贴 patch：
    // 硬贴会丢掉羽化过渡与掩膜保护，导致撤销/重做后画面与当初应用时不一致。
    for (const e of S.edits) {
      compositeEditInto(S.viewCtx, e);
    }
  }

  function fitToScreen() {
    if (!S.docCanvas) return;
    const v = viewSize();
    S.view = C.fitView(S.docW, S.docH, v.w, v.h, 14);
    draw();
    updateUI();
  }

  /* ============================ 绘制 ============================ */

  let bgColor = '#101216';
  function refreshBgColor() {
    try {
      const v = getComputedStyle(document.body).getPropertyValue('--bg-canvas');
      if (v && v.trim()) bgColor = v.trim();
    } catch (e) { /* ignore */ }
  }

  function draw() {
    if (!ctx) return;
    const v = viewSize();
    ctx.clearRect(0, 0, v.w, v.h);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, v.w, v.h);

    if (!S.viewCanvas) return;
    const r = C.imageRectToScreen({ x: 0, y: 0, w: S.docW, h: S.docH }, S.view);
    ctx.imageSmoothingEnabled = S.view.scale < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(S.viewCanvas, r.x, r.y, r.w, r.h);

    // 画笔掩膜预览
    if (S.mode === 'brush' && S.rect && S.strokes.length) {
      drawMaskOverlay();
    }

    // 选区
    if (S.rect) drawSelection();

    // 待确认结果的选区闪烁边框
    if (S.pending) {
      const sr = C.imageRectToScreen(S.rect, S.view);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,196,0,.95)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.lineDashOffset = -(performance.now() / 60) % 14;
      ctx.strokeRect(sr.x, sr.y, sr.w, sr.h);
      ctx.restore();
      requestAnimationFrame(() => { if (S.pending) draw(); });
    }
  }

  let maskCache = null, maskCacheKey = '';
  // 画笔是热路径：每移动一次手指都会重算掩膜。这里复用离屏画布与缓冲，
  // 避免每帧新建 canvas / ImageData（大选区下这是主要卡顿来源）。
  let maskCanvas = null, maskCanvasKey = '';
  let maskRaf = 0;

  /** 笔迹按文档坐标保存，这里转换成矩形局部坐标后栅格化 */
  function maskFromStrokes(rect) {
    const local = S.strokes.map((s) => ({
      mode: s.mode,
      radius: s.radius,
      points: s.points.map((p) => ({ x: p.x - rect.x, y: p.y - rect.y }))
    }));
    return C.strokesToMask(local, rect.w, rect.h);
  }

  /** 请求重绘掩膜：合并同一帧内的多次调用 */
  function scheduleMaskRedraw() {
    if (maskRaf) return;
    maskRaf = requestAnimationFrame(() => {
      maskRaf = 0;
      draw();
    });
  }

  function drawMaskOverlay() {
    const rect = C.clampRect(S.rect, S.docW, S.docH);

    // 没有任何笔迹时，整块选区都会被修改 —— 此时不该在画面上蒙任何颜色，
    // 否则用户会以为「图片变蓝了」（以前正是这个 bug）。
    if (!S.strokes.length) return;

    const key = `${rect.x},${rect.y},${rect.w},${rect.h}|` +
      S.strokes.map((s) => s.mode + ':' + s.radius + ':' + s.points.length + ':' +
        (s.points.length ? `${s.points[0].x.toFixed(1)},${s.points[s.points.length - 1].x.toFixed(1)}` : '')).join(';');
    if (maskCacheKey !== key || !maskCache) {
      const mask = maskFromStrokes(rect);
      // mask=1 是「要修改」的区域，mask=0 是「保护」的区域。
      // 预览只把「保护区域」标出来（灰色斜纹感），要修改的区域保持原样可见 ——
      // 这样用户看到的画面和原图一致，不会误以为图片变色。
      const protectedAlpha = new Float32Array(mask.length);
      for (let i = 0; i < mask.length; i++) protectedAlpha[i] = 1 - mask[i];
      const rgba = C.maskToRGBA(protectedAlpha, rect.w, rect.h, [120, 128, 140], 96);
      maskCache = new ImageData(rgba, rect.w, rect.h);
      maskCacheKey = key;
    }
    // 离屏画布按尺寸复用，只有选区尺寸变化时才重建
    const ck = rect.w + 'x' + rect.h;
    if (!maskCanvas || maskCanvasKey !== ck) {
      maskCanvas = makeCanvas(rect.w, rect.h);
      maskCanvasKey = ck;
    }
    maskCanvas.getContext('2d').putImageData(maskCache, 0, 0);
    const sr = C.imageRectToScreen(rect, S.view);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(maskCanvas, sr.x, sr.y, sr.w, sr.h);
    ctx.restore();
  }

  function drawSelection() {
    const sr = C.imageRectToScreen(S.rect, S.view);
    const v = viewSize();

    // 选区外压暗
    ctx.save();
    ctx.fillStyle = 'rgba(8,10,14,.45)';
    ctx.beginPath();
    ctx.rect(0, 0, v.w, v.h);
    ctx.rect(sr.x, sr.y, sr.w, sr.h);
    ctx.fill('evenodd');
    ctx.restore();

    // 边框
    ctx.save();
    ctx.strokeStyle = '#4da3ff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sr.x + .5, sr.y + .5, sr.w - 1, sr.h - 1);
    // 三分线
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 2; i++) {
      const x = sr.x + sr.w * i / 3, y = sr.y + sr.h * i / 3;
      ctx.beginPath(); ctx.moveTo(x, sr.y); ctx.lineTo(x, sr.y + sr.h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sr.x, y); ctx.lineTo(sr.x + sr.w, y); ctx.stroke();
    }
    // 手柄
    const hp = C.handlePoints({ x: sr.x, y: sr.y, w: sr.w, h: sr.h });
    const R = 7;
    for (const k of C.HANDLES) {
      const p = hp[k];
      ctx.beginPath();
      ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#2b7fe0';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();

    // 尺寸标签
    const label = `${Math.round(S.rect.w)} × ${Math.round(S.rect.h)}`;
    ctx.save();
    ctx.font = '600 12px ui-sans-serif,system-ui,sans-serif';
    const tw = ctx.measureText(label).width;
    let lx = sr.x, ly = sr.y - 24;
    if (ly < 4) ly = sr.y + 6;
    lx = C.clamp(lx, 4, v.w - tw - 16);
    ctx.fillStyle = 'rgba(12,16,22,.85)';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(lx, ly, tw + 14, 20, 6) : ctx.rect(lx, ly, tw + 14, 20);
    ctx.fill();
    ctx.fillStyle = '#cfe4ff';
    ctx.fillText(label, lx + 7, ly + 14);
    ctx.restore();
  }

  /* ============================ 指针交互 ============================ */

  function localPoint(ev) {
    const r = cv.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  cv.addEventListener('pointerdown', (ev) => {
    if (!S.img) return;
    cv.setPointerCapture(ev.pointerId);
    const p = localPoint(ev);
    S.pointers.set(ev.pointerId, p);

    if (S.pointers.size === 2) {
      startPinch();
      return;
    }
    if (S.pointers.size > 2) return;

    const ip = C.screenToImage(p, S.view);

    // 平移模式 / 空格 / 中键
    if (S.mode === 'pan' || S.spaceDown || ev.button === 1) {
      S.gesture = { type: 'pan', start: p, view0: Object.assign({}, S.view) };
      return;
    }

    if (S.mode === 'brush') {
      if (!S.rect) { toast('先框选一块区域，再用画笔'); return; }
      const rect = C.clampRect(S.rect, S.docW, S.docH);
      if (!C.pointInRect(ip, rect) && !nearRect(ip, rect, 40 / S.view.scale)) {
        toast('画笔只能画在选区内');
        return;
      }
      const stroke = { mode: S.brushErase ? 'erase' : 'restore', radius: S.brushSize / 2, points: [{ x: ip.x, y: ip.y }] };
      S.strokes.push(stroke);
      recordUndo({ type: 'stroke', stroke, label: S.brushErase ? '画笔（排除）' : '画笔（恢复）' });
      S.gesture = { type: 'brush', stroke, rect };
      invalidateMask();
      scheduleMaskRedraw();
      return;
    }

    // 框选模式
    if (!S.rect) {
      S.gesture = { type: 'create', start: ip };
      S.rect = { x: ip.x, y: ip.y, w: 0, h: 0 };
      return;
    }
    const sr = C.imageRectToScreen(S.rect, S.view);
    const hit = C.hitTest(p, sr, 24);
    if (hit) {
      S.gesture = {
        type: 'transform', handle: hit, start: ip,
        rect0: Object.assign({}, S.rect),
        aspect: S.ratio || 0,
        fromCenter: ev.shiftKey
      };
      return;
    }
    // 空白处：重新开始框选（笔迹随旧选区一起丢弃）
    S.gesture = { type: 'create', start: ip };
    S.rect = { x: ip.x, y: ip.y, w: 0, h: 0 };
    S.strokes = [];
    invalidateMask();
  });

  cv.addEventListener('pointermove', (ev) => {
    const p = localPoint(ev);
    if (S.pointers.has(ev.pointerId)) S.pointers.set(ev.pointerId, p);

    if (S.pointers.size === 2 && S.gesture && S.gesture.type === 'pinch') {
      updatePinch();
      return;
    }
    const g = S.gesture;
    if (!g) { updateCursor(p); return; }

    if (g.type === 'pan') {
      S.view = C.makeView(g.view0.scale, g.view0.tx + (p.x - g.start.x), g.view0.ty + (p.y - g.start.y));
      S.view = C.clampView(S.view, S.docW, S.docH, viewSize().w, viewSize().h);
      draw();
      return;
    }
    if (g.type === 'brush') {
      const ip = C.screenToImage(p, S.view);
      g.stroke.points.push({ x: ip.x, y: ip.y });
      invalidateMask();
      scheduleMaskRedraw();   // 合并同一帧内的多次移动，避免卡顿
      return;
    }
    const ip = C.screenToImage(p, S.view);
    if (g.type === 'create') {
      let r = C.rectFromPoints(g.start, ip);
      r = applyRatio(r, g.start, S.ratio);
      S.rect = C.clampRect(r, S.docW, S.docH);
    } else if (g.type === 'transform') {
      const dx = ip.x - g.start.x, dy = ip.y - g.start.y;
      let r = C.resizeRect(g.rect0, g.handle, dx, dy, { min: 16, aspect: g.aspect, fromCenter: g.fromCenter });
      if (S.ratio && g.handle === 'move') r = { x: r.x, y: r.y, w: g.rect0.w, h: g.rect0.h };
      S.rect = C.clampRect(r, S.docW, S.docH);
      invalidateMask();
    }
    draw();
    updateUI();
  });

  function endPointer(ev) {
    const g = S.gesture;
    S.pointers.delete(ev.pointerId);
    if (S.pointers.size < 2 && g && g.type === 'pinch') {
      S.gesture = null;
    }
    if (!g) {
      // 手势已被双指接管，这里仍要清理退化选区
      if (S.rect && (S.rect.w < 1 || S.rect.h < 1)) S.rect = null;
      draw(); updateUI();
      return;
    }
    if (g.type === 'create' || g.type === 'transform') {
      if (S.rect && (S.rect.w < 8 || S.rect.h < 8)) {
        S.rect = null;      // 太小的误触一律丢掉，避免出现 1x1 选区
      } else if (S.rect) {
        S.rect = C.clampRect(S.rect, S.docW, S.docH);
        snapRectToModel();  // 只记录比例偏差，不改写选区
      }
    }
    S.gesture = null;
    draw();
    updateUI();
  }
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);

  function invalidateMask() { maskCacheKey = ''; maskCache = null; }

  function nearRect(pt, rect, tol) {
    return pt.x > rect.x - tol && pt.x < rect.x + rect.w + tol &&
      pt.y > rect.y - tol && pt.y < rect.y + rect.h + tol;
  }

  function applyRatio(r, anchor, ratio) {
    if (!ratio) return r;
    // 以拖动起点为固定角，按比例修正
    const w = r.w, h = r.h;
    let nw = w, nh = h;
    if (w / (h || 1) > ratio) nh = w / ratio; else nw = h * ratio;
    const sx = anchor.x <= r.x + r.w / 2 ? 1 : -1;
    const sy = anchor.y <= r.y + r.h / 2 ? 1 : -1;
    const x = sx > 0 ? anchor.x : anchor.x - nw;
    const y = sy > 0 ? anchor.y : anchor.y - nh;
    return { x, y, w: nw, h: nh };
  }

  /** 把选区吸附到模型支持的出图比例（轻微调整，用户几乎无感） */
  function snapRectToModel() {
    if (!S.rect || !S.cfg) return;
    const m = C.findModel(S.cfg.provider, S.cfg.model);
    if (!m) return;
    let target = 0;
    if (m.sizeMode === 'image_size' && m.sizes && m.sizes.length) {
      const best = C.resolveOutputSize(S.rect.w, S.rect.h, m.sizes);
      if (best) target = best.w / best.h;
    } else if (m.sizeMode === 'aspect_ratio' && m.aspectRatios) {
      const ar = C.resolveAspectRatio(S.rect.w, S.rect.h, m.aspectRatios);
      const p = ar.split(':');
      target = +p[0] / +p[1];
    } else if (m.sizeMode === 'size' && m.sizes && m.sizes.length) {
      const best = C.resolveOutputSize(S.rect.w, S.rect.h, m.sizes);
      if (best) target = best.w / best.h;
    }
    if (!target || S.ratio) return;   // 用户手动锁了比例就不动
    // 需求是「自由框选任意位置和大小」，所以默认不改写用户的选区。
    // 比例不一致由贴回阶段按比例裁切解决（不会变形），这里只记录偏差供 UI 提示。
    S.aspectDev = Math.abs(Math.log((S.rect.w / S.rect.h) / target));
  }

  /** 当前选区比例与模型出图比例的偏差百分比（用于提示，不改选区） */
  function aspectDevPct() {
    if (!S.rect || !S.aspectDev) return 0;
    return Math.round((Math.exp(S.aspectDev) - 1) * 100);
  }

  /* ---------- 双指缩放 ---------- */

  function startPinch() {
    // 双指手势前若刚因单指按下建出一个空选区，要清掉，
    // 否则抬手后会残留 {w:0,h:0} 的退化选区，还能点「生成」发出 1x1 的图。
    if (S.gesture && S.gesture.type === 'create' && S.rect &&
        (S.rect.w < 1 || S.rect.h < 1)) {
      S.rect = null;
      S.gesture = null;
    }
    const pts = [...S.pointers.values()];
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    S.gesture = {
      type: 'pinch',
      d0: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1,
      mid0: mid,
      view0: Object.assign({}, S.view)
    };
    if (S.mode === 'brush') { /* 双指时暂停画笔 */ }
  }
  function updatePinch() {
    const g = S.gesture;
    if (!g || g.type !== 'pinch') return;
    const pts = [...S.pointers.values()];
    const d = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const factor = d / g.d0;
    const minS = Math.min(viewSize().w / S.docW, viewSize().h / S.docH) * 0.4;
    let v = C.zoomAt(g.view0, g.mid0.x, g.mid0.y, factor, Math.max(0.02, minS), 12);
    v = C.makeView(v.scale, v.tx + (mid.x - g.mid0.x), v.ty + (mid.y - g.mid0.y));
    S.view = C.clampView(v, S.docW, S.docH, viewSize().w, viewSize().h);
    draw();
    updateUI();
  }

  /* ---------- 滚轮 ---------- */
  cv.addEventListener('wheel', (ev) => {
    if (!S.img) return;
    ev.preventDefault();
    const p = localPoint(ev);
    const factor = Math.pow(1.0016, -ev.deltaY);
    const minS = Math.min(viewSize().w / S.docW, viewSize().h / S.docH) * 0.4;
    let v = C.zoomAt(S.view, p.x, p.y, factor, Math.max(0.02, minS), 12);
    S.view = C.clampView(v, S.docW, S.docH, viewSize().w, viewSize().h);
    draw(); updateUI();
  }, { passive: false });

  function updateCursor(p) {
    if (!S.img) { cv.style.cursor = 'default'; return; }
    if (S.mode === 'pan' || S.spaceDown) { cv.style.cursor = 'grab'; return; }
    if (S.mode === 'brush') { cv.style.cursor = 'crosshair'; return; }
    if (!S.rect) { cv.style.cursor = 'crosshair'; return; }
    const hit = C.hitTest(p, C.imageRectToScreen(S.rect, S.view), 24);
    cv.style.cursor = hit ? (C.CURSORS[hit] || 'default') : 'crosshair';
  }

  /* ============================ 生成流水线 ============================ */

  function pickOutputSize(rect) {
    const m = currentModelParams();
    if (!m) return { size: null, aspect: null };
    // 传入 providerId：让尺寸挑选阶段就避开服务商不接受的尺寸
    if (m.sizeMode === 'image_size' && m.sizes && m.sizes.length) {
      const best = C.resolveOutputSize(rect.w, rect.h, m.sizes, S.cfg.provider);
      return { size: best ? best.size : null, aspect: null };
    }
    if (m.sizeMode === 'aspect_ratio' && m.aspectRatios) {
      return { size: null, aspect: C.resolveAspectRatio(rect.w, rect.h, m.aspectRatios) };
    }
    if (m.sizeMode === 'size') {
      const sizes = (m.sizes && m.sizes.length) ? m.sizes : null;
      const best = C.resolveOutputSize(rect.w, rect.h, sizes, S.cfg.provider);
      return { size: best ? best.size : null, aspect: null };
    }
    return { size: null, aspect: null };
  }

  /**
   * 取当前模型的参数。优先用内置表；若用户手填的模型名不在表里，
   * 则按名字推断（这样自动检测出来的新模型也能正常工作）。
   */
  function currentModelParams() {
    const known = C.findModel(S.cfg.provider, S.cfg.model);
    if (known) return known;
    if (S.cfg.model) return C.modelParams(S.cfg.model);
    return null;
  }

  /** 从文档里裁一块，返回 canvas */
  function cropDoc(rect) {
    const c = makeCanvas(rect.w, rect.h);
    const cx = c.getContext('2d');
    cx.drawImage(S.docCanvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    return c;
  }

  /** 组装要发给模型的图（含上下文外扩 + 掩膜提示 + 隐私打码） */
  function buildRequestImage(rect, mask) {
    const pct = Number(S.cfg.contextPct) || 0;
    const padX = Math.round(rect.w * pct / 100), padY = Math.round(rect.h * pct / 100);
    const ctxRect = C.clampRect({ x: rect.x - padX, y: rect.y - padY, w: rect.w + padX * 2, h: rect.h + padY * 2 }, S.docW, S.docH);

    const c = makeCanvas(ctxRect.w, ctxRect.h);
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(S.docCanvas, ctxRect.x, ctxRect.y, ctxRect.w, ctxRect.h, 0, 0, ctxRect.w, ctxRect.h);

    // 已应用的编辑也要带上（保证上下文一致）
    for (const e of S.edits) {
      const ix = e.rect.x - ctxRect.x, iy = e.rect.y - ctxRect.y;
      if (ix + e.rect.w < 0 || iy + e.rect.h < 0 || ix > ctxRect.w || iy > ctxRect.h) continue;
      cx.drawImage(e.patch, ix, iy, e.rect.w, e.rect.h);
    }

    const off = { x: rect.x - ctxRect.x, y: rect.y - ctxRect.y };

    // 隐私打码：把选区外的内容打码（只在整图发送时才需要，这里给整图模式保留）
    if (S.cfg.mosaic) {
      const id = cx.getImageData(0, 0, ctxRect.w, ctxRect.h);
      const maskFull = new Uint8Array(ctxRect.w * ctxRect.h);
      for (let y = 0; y < ctxRect.h; y++) {
        for (let x = 0; x < ctxRect.w; x++) {
          const inside = x >= off.x && x < off.x + rect.w && y >= off.y && y < off.y + rect.h;
          maskFull[y * ctxRect.w + x] = inside ? 1 : 0;
        }
      }
      // 对选区外做块平均（保留边缘 24px 供模型参考）
      const band = 24;
      const bd = id.data;
      for (let y = 0; y < ctxRect.h; y += 12) {
        for (let x = 0; x < ctxRect.w; x += 12) {
          const inside = x + 12 > off.x - band && x < off.x + rect.w + band && y + 12 > off.y - band && y < off.y + rect.h + band;
          if (inside) continue;
          let r = 0, g = 0, b = 0, n = 0;
          for (let yy = y; yy < Math.min(y + 12, ctxRect.h); yy++)
            for (let xx = x; xx < Math.min(x + 12, ctxRect.w); xx++) {
              const i = (yy * ctxRect.w + xx) * 4;
              r += bd[i]; g += bd[i + 1]; b += bd[i + 2]; n++;
            }
          if (!n) continue;
          r /= n; g /= n; b /= n;
          for (let yy = y; yy < Math.min(y + 12, ctxRect.h); yy++)
            for (let xx = x; xx < Math.min(x + 12, ctxRect.w); xx++) {
              const i = (yy * ctxRect.w + xx) * 4;
              bd[i] = r; bd[i + 1] = g; bd[i + 2] = b;
            }
        }
      }
      cx.putImageData(id, 0, 0);
    }

    // 这里刻意「不」把画笔掩膜画到请求图上。
    // 曾经的做法是把要修改的区域涂成半透明蓝色作为提示，结果模型把蓝色当成画面内容，
    // 生成结果整体偏蓝、和原图对不上。现在改为：图片原样发送，
    // 要修改的范围通过提示词里的文字描述表达（见 buildPrompt 的 centerPct）。
    // 蓝色只保留在屏幕预览上（drawMaskOverlay），永远不会进入发给模型的图片。

    // ---- 小选区上采样 ----
    // 很多接口对输入图有最小像素要求（如 0.66MP）。摄影师常改的恰恰是小区域，
    // 裁出来可能只有 100x100，直接发会被服务端拒收。
    // 这里把「选区本身」放大到合规尺寸，并记录放大信息供贴回时精确还原。
    const up = (S.cfg.upscaleSmall === false)
      ? { needed: false, scale: 1, w: rect.w, h: rect.h, srcW: rect.w, srcH: rect.h }
      : C.planUpscale(rect.w, rect.h, S.cfg.provider);
    let outCanvas = c;
    let upInfo = null;
    if (up.needed && up.w > rect.w) {
      // 放大后的画布尺寸 = 外扩部分按同倍数放大
      const k = up.w / rect.w;
      const ow = Math.round(ctxRect.w * k), oh = Math.round(ctxRect.h * k);
      const big = makeCanvas(ow, oh);
      const bx = big.getContext('2d', { willReadFrequently: true });
      bx.imageSmoothingEnabled = true;
      bx.imageSmoothingQuality = 'high';
      bx.drawImage(c, 0, 0, ctxRect.w, ctxRect.h, 0, 0, ow, oh);
      outCanvas = big;
      upInfo = {
        scale: k,
        srcW: rect.w, srcH: rect.h,          // 选区原始尺寸
        upW: Math.round(rect.w * k), upH: Math.round(rect.h * k),
        off: { x: Math.round(off.x * k), y: Math.round(off.y * k) },
        reqW: ow, reqH: oh
      };
    }
    return { canvas: outCanvas, rect: ctxRect, off, up: upInfo };
  }

  function canvasToDataUrl(canvas, format, quality) {
    return canvas.toDataURL(format || 'image/jpeg', quality);
  }

  async function callModel(body) {
    const mode = S.cfg.netMode;
    // multipart 请求体已经是二进制，不能再 JSON.stringify
    const isMultipart = !!(body && body.multipart);
    const payload = isMultipart ? body.multipart.body : JSON.stringify(body.body);
    const contentType = isMultipart ? body.multipart.contentType : 'application/json';
    if (S._dbg) {
      S._dbg.callModel = {
        isMultipart, mode, hasBody: !!body,
        bodyHasMultipart: !!(body && body.multipart),
        url: body && body.url
      };
    }

    const direct = async () => {
      // 注意：Content-Type 必须由调用方（multipart 判定）决定，不能反被 body.headers 里的旧值覆盖。
      // 之前这里是 Object.assign({Content-Type: contentType}, body.headers)，
      // buildImageRequest 返回的 headers 里硬编码了 JSON 类型，会把 multipart 覆盖成 JSON，
      // 导致二进制体送出去却声明为 JSON → 上游解析失败 → 图片丢失。
      const hdrs = Object.assign({}, body.headers || {}, { 'Content-Type': contentType });
      if (S._dbg) {
        S._dbg.direct = {
          contentType,
          payloadIsBinary: typeof payload !== 'string',
          payloadLen: payload && (payload.length || payload.byteLength) || 0,
          headersKeys: Object.keys(hdrs),
          url: body.url
        };
      }
      const res = await fetch(body.url, {
        method: 'POST',
        headers: hdrs,
        body: payload,
        signal: S.aborter ? S.aborter.signal : undefined
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* ignore */ }
      if (!res.ok) {
        const err = new Error('HTTP ' + res.status);
        err.status = res.status;
        err.json = json;
        err.text = text;
        throw err;
      }
      if (!json) {
        const err = new Error('接口返回了非 JSON 内容');
        err.status = res.status;
        err.text = text;
        throw err;
      }
      return json;
    };

    const viaProxy = async () => {
      // 代理协议：目标地址与鉴权放在头部，请求体原样转发（服务端零解析）
      const res = await fetch('api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'X-Target-Url': body.url,
          'X-Target-Auth': (body.headers && body.headers.Authorization) || '',
          // multipart 的 boundary 在 Content-Type 里，必须让代理原样转发给上游
          'X-Target-Content-Type': contentType
        },
        body: payload,
        signal: S.aborter ? S.aborter.signal : undefined
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* ignore */ }
      if (!res.ok) {
        const err = new Error('HTTP ' + res.status);
        err.status = res.status;
        err.json = json;
        err.text = text;
        throw err;
      }
      if (json && json.__proxyError) {
        const err = new Error(json.__proxyError);
        err.status = 502;
        err.proxy = true;
        throw err;
      }
      if (!json) {
        const err = new Error('代理返回了非 JSON 内容');
        err.status = res.status;
        err.text = text;
        throw err;
      }
      return json;
    };

    if (mode === 'proxy') return viaProxy();
    if (mode === 'direct') return direct();
    // auto：先代理，失败再直连
    try { return await viaProxy(); }
    catch (e) {
      if (S.aborter && S.aborter.signal.aborted) throw e;
      return direct();
    }
  }

  async function urlToBlob(url) {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('下载生成结果失败 HTTP ' + res.status);
    return await res.blob();
  }

  async function blobToCanvas(blob) {
    const bmp = await createImageBitmap(blob);
    const c = makeCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    return c;
  }

  /** 主流程入口：先做预检，再执行生成 */
  async function generate() {
    if (S.busy) { toast('正在生成，请稍候'); return; }   // 防重复点击
    if (!S.img) { toast('先打开一张照片'); return; }
    if (!S.rect) { toast('先在照片上框选要修改的位置'); return; }
    if (!S.cfg.apiKey) { toast('先到设置里填 API Key'); openSettings(); return; }
    if (!S.cfg.model) { toast('先到设置里选模型'); openSettings(); return; }

    // 预检：当前模型名看起来不是生图模型。这是「上游回一段文字」最常见的原因，
    // 与其等接口报一句看不懂的错，不如现在就提醒（仍允许继续，有些中转的命名不按常规）。
    const looksImageModel = !!C.classifyModel(S.cfg.model);
    if (!looksImageModel) {
      const el = $('gen-error');
      if (el) {
        el.innerHTML =
          '<div class="err-head">' +
            '<svg viewBox="0 0 24 24" class="err-ico"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>' +
            '<div class="err-title">当前模型可能不是生图模型</div>' +
            '<button class="tb-btn icon err-close" id="err-close"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>' +
          '</div>' +
          '<div class="err-msg">你填的模型是「' + esc(S.cfg.model) + '」，从名字看它像是对话模型，而不是生图模型。</div>' +
          '<div class="err-hint">' +
            '对话模型只会回你一段文字（常见表现是它复述你的要求，然后说「请上传照片」），不会返回图片。<br>' +
            '建议：点下面的按钮自动检测，选一个标注「可编辑」的生图模型。' +
          '</div>' +
          '<div class="err-actions">' +
            '<button class="ghost small" id="err-settings">去设置检测模型</button>' +
            '<button class="ghost small" id="err-still">仍要尝试</button>' +
          '</div>';
        el.hidden = false;
        el.style.borderColor = '';
        const c1 = $('err-close'); if (c1) c1.onclick = () => { el.hidden = true; };
        const c2 = $('err-settings'); if (c2) c2.onclick = () => { el.hidden = true; openSettings(); };
        const c3 = $('err-still'); if (c3) c3.onclick = () => { el.hidden = true; runGenerate(); };
      }
      return;
    }
    // 成本确认：大额时先问一下
    const est = currentEstimate();
    if (!confirmCostIfNeeded(est)) return;

    return runGenerate();
  }

  async function runGenerate() {

    const rect = C.clampRect(S.rect, S.docW, S.docH);
    const mask = S.strokes.length ? maskFromStrokes(rect) : null;
    const m = currentModelParams();
    const kind = m ? m.kind : 'edit';
    const { size, aspect } = pickOutputSize(rect);
    const lang = S.cfg.lang === 'auto' ? (C.HAS_CJK.test($('prompt').value) ? 'zh' : 'en') : S.cfg.lang;

    const tiles = (Number(S.cfg.tile) > 0) ? C.planTileCrop(rect, { maxSide: Number(S.cfg.tile), overlap: 80 }) : [rect];

    S.aborter = new AbortController();
    const token = ++S.genToken;
    const docVer = S.docVersion;
    setBusy(true, '正在生成…', tiles.length > 1 ? `共 ${tiles.length} 块，第 1 块` : '正在请求生图模型');
    $('btn-generate').disabled = true;
    clearErrorPanel();

    let aspectWarned = false;
    lastUpscale = null;
    try {
      const patchCanvas = makeCanvas(rect.w, rect.h);
      const pctx = patchCanvas.getContext('2d', { willReadFrequently: true });
      // 分块模式下的加权累加缓冲。
      // 小选区上采样时按放大尺寸累加，保留模型输出的分辨率。
      const preUp = (S.cfg.upscaleSmall === false)
        ? { needed: false, scale: 1 }
        : C.planUpscale(rect.w, rect.h, S.cfg.provider);
      const accScale = (tiles.length > 1 && preUp.needed && preUp.scale > 1) ? preUp.scale : 1;
      const accW = Math.round(rect.w * accScale), accH = Math.round(rect.h * accScale);
      const acc = { data: new Float32Array(accW * accH * 3), w: accW, h: accH };
      const wacc = { data: new Float32Array(accW * accH), w: accW, h: accH };
      const tileOverlap = 80;

      for (let i = 0; i < tiles.length; i++) {
        // 生成过程中用户换了图 / 点了取消 / 又发起了一次生成 → 直接放弃这次结果
        if (token !== S.genToken || docVer !== S.docVersion) {
          const e = new Error('stale');
          e.name = 'AbortError';
          e.stale = true;
          throw e;
        }
        const tile = tiles[i];
        if (tiles.length > 1) setBusy(true, '正在生成…', `第 ${i + 1}/${tiles.length} 块`);

        const tileMask = mask ? cropMask(mask, rect, tile) : null;
        const built = buildRequestImage(tile, tileMask);
        const dataUrl = canvasToDataUrl(built.canvas, 'image/jpeg', 0.94);

        // 出图尺寸按「当前这一块」的比例来挑，而不是整块选区的比例。
        // 否则一块接近正方形的瓦片会被要求出 16:9 的图，贴回时被压缩变形。
        // 注意：小选区上采样后，模型看到的图更大，出图尺寸也应相应提高，
        // 否则「输入 832x832、输出 1024x1024」这种组合在某些接口上会被拒。
        const sizeRef = (built.up && built.up.scale > 1)
          ? { w: built.up.upW, h: built.up.upH }
          : tile;
        const tileSize = pickOutputSize(sizeRef);

        // 选区在「发给模型的图」里占多大比例，用文字告诉模型该改哪一块。
        // 这是替代「涂蓝色标记」的做法 —— 标记会被模型当成画面内容，导致生成结果偏色。
        const areaPct = built.canvas.width > 0
          ? Math.round(Math.sqrt((tile.w * tile.h) / (built.canvas.width * built.canvas.height)) * 100)
          : 80;
        let promptText = C.buildPrompt({
          instruction: $('prompt').value,
          style: $('style-select').value,
          scope: $('scope-select').value,
          hasMask: !!mask,
          centerPct: areaPct,
          language: lang
        });
        if (tiles.length > 1) promptText += '。' + C.tileHint(i, tiles.length, lang === 'zh');

        const req = C.buildImageRequest({
          baseUrl: S.cfg.baseUrl,
          apiKey: S.cfg.apiKey,
          model: S.cfg.model,
          prompt: promptText,
          imageDataUrl: kind === 't2i' ? null : dataUrl,
          size: tileSize.size, aspectRatio: tileSize.aspect,
          seed: S.cfg.seed === '' ? null : Number(S.cfg.seed),
          batch: 1,
          kind,
          imageField: m ? m.imageField : 'image',
          sizeMode: m ? m.sizeMode : 'image_size',
          providerId: S.cfg.provider,
          quality: 'high',
          outputFormat: 'png'
        });

        // OpenAI 系的图像编辑接口是 multipart 表单（/v1/images/edits），
        // 必须把图片作为文件字段上传。若打成 JSON 发到 generations，
        // 图片会被静默丢弃，上游只看到文字 → 回一段文字（upstream_text_reply）。
        if (C.needsMultipart(C.resolveEndpoint({
          providerId: S.cfg.provider, kind, imageDataUrl: dataUrl, model: S.cfg.model
        }))) {
          const mp = C.buildMultipartBody({
            imageDataUrl: dataUrl,
            maskDataUrl: null,     // 不额外传掩膜文件（体积会翻倍），范围用提示词文字描述
            model: req.body.model,
            prompt: req.body.prompt,
            size: req.body.size || null,
            quality: 'high',
            outputFormat: 'png',
            n: 1
          });
          req.multipart = mp;
          req.endpoint = 'images/edits';
        }

        // 发送前自检：图片没准备好 / 编码异常，就地报清楚，别等接口回一句看不懂的错
        const check = C.validateImageRequest({
          model: req.body.model,
          prompt: req.body.prompt,
          kind,
          imageField: m ? m.imageField : 'image',
          imageDataUrl: req.body[m ? m.imageField : 'image']
        });
        if (check) {
          const e = new Error(check.message);
          e.local = true;
          e.status = 0;
          throw e;
        }
        // 尺寸合规自检：不合规会被服务端直接拒单，白等一次
        const sentSize = req.body.size || req.body.image_size;
        if (sentSize) {
          const sv = C.validateSize(sentSize, S.cfg.provider);
          if (!sv.ok) {
            const e = new Error('出图尺寸 ' + sentSize + ' 不符合该接口要求：' + sv.reasons.join('；'));
            e.local = true;
            e.status = 0;
            throw e;
          }
        }

        // 记录上采样情况，供提示与自查
        // 注意：这里必须用 built.up，不能用下面才声明的 up（同一作用域内提前引用会报 TDZ 错误）
        if (built.up && built.up.scale > 1) {
          lastUpscale = {
            from: built.up.srcW + 'x' + built.up.srcH,
            to: built.up.upW + 'x' + built.up.upH,
            scale: built.up.scale
          };
        }

        // 调试与自查：把最近一次请求的关键状态暴露到全局，便于定位问题
        S._dbg = {
          url: req.url,
          multipartUsed: !!req.multipart,
          kind, provider: S.cfg.provider, model: S.cfg.model,
          upscale: built.up ? built.up.scale : 1,
          dataUrlLen: dataUrl ? dataUrl.length : 0
        };

        // 记录实际发出的请求，便于排查「上游说没收到图片」这类问题
        lastRequest = {
          url: req.url,
          multipartUsed: !!req.multipart,
          model: req.body.model,
          hasImage: !!(req.body.image || req.body.input_image),
          imageBytes: (() => {
            const img = req.body.image || req.body.input_image;
            if (!img || typeof img !== 'string') return 0;
            const i = img.indexOf(',');
            return i > 0 ? Math.round((img.length - i - 1) * 0.75) : 0;
          })(),
          imageField: req.body.image ? 'image' : (req.body.input_image ? 'input_image' : '（无）'),
          size: req.body.size || req.body.image_size || req.body.aspect_ratio || '（未指定）',
          promptChars: (req.body.prompt || '').length,
          keys: Object.keys(req.body)
        };

        const json = await callModel(req);
        const items = C.parseImageResponse(json);
        if (!items.length) {
          const e = new Error('接口没有返回图片');
          e.status = 200;
          e.json = json;
          e.text = JSON.stringify(json);
          throw e;
        }

        let blob;
        if (items[0].dataUrl) {
          const r = await fetch(items[0].dataUrl);
          blob = await r.blob();
        } else {
          blob = await urlToBlob(items[0].url);
        }
        const gen = await blobToCanvas(blob);
        const tr = { x: tile.x - rect.x, y: tile.y - rect.y, w: tile.w, h: tile.h };
        // 关键一步：从模型返回图里取出「选区」对应的内容。
        // 请求图带上下文外扩（built.off 记录选区在请求图里的位置），
        // 且模型返回尺寸与请求尺寸往往不同 —— 必须两步换算，否则内容会整体偏移。
        // 关键：如果请求图被上采样过，坐标换算必须用「放大后的」位置与尺寸，
        // 否则取回的内容会偏移或缩放错误。
        const up = built.up;
        const crop = C.mapSelectionToResult({
          genW: gen.width, genH: gen.height,
          reqW: built.canvas.width, reqH: built.canvas.height,
          offX: up ? up.off.x : built.off.x,
          offY: up ? up.off.y : built.off.y,
          selW: up ? up.upW : tile.w,
          selH: up ? up.upH : tile.h
        });

        // 把这一块绘制到临时画布（不变形），再按权重累加。
        // 若请求图被上采样过，这里刻意「多留分辨率」：按放大后的尺寸存 patch，
        // 贴回时再缩到选区大小。这样模型输出的高分辨率细节能保留到最后一步，
        // 而不是先缩到 100x100 再放大贴回（那样会糊两次）。
        const storeW = (up && up.scale > 1) ? Math.max(tile.w, Math.round(tile.w * up.scale)) : tile.w;
        const storeH = (up && up.scale > 1) ? Math.max(tile.h, Math.round(tile.h * up.scale)) : tile.h;
        const tileCv = makeCanvas(storeW, storeH);
        const tctx2 = tileCv.getContext('2d', { willReadFrequently: true });
        tctx2.imageSmoothingEnabled = true;
        tctx2.imageSmoothingQuality = 'high';
        tctx2.drawImage(gen, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, storeW, storeH);
        const tilePix = tctx2.getImageData(0, 0, storeW, storeH);

        if (tiles.length > 1) {
          // 多块：重叠区按权重加权平均，避免块边界出现色差断层
          // 权重按「存下来的分辨率」生成，才能与 tilePix 一一对应
          const wts = C.tileBlendWeights(
            { x: Math.round(tr.x * accScale), y: Math.round(tr.y * accScale), w: storeW, h: storeH },
            { x: 0, y: 0, w: accW, h: accH },
            Math.round(tileOverlap * accScale));
          C.accumulateTile(acc, wacc, tilePix,
            Math.round(tr.x * accScale), Math.round(tr.y * accScale), wts);
        } else {
          // 单块：直接写入（此时 patchCanvas 就是 store 尺寸）
          if (storeW !== patchCanvas.width) {
            patchCanvas.width = storeW; patchCanvas.height = storeH;
          }
          pctx.putImageData(tilePix, 0, 0);
        }

        // 偏差太大时提醒一次，让用户知道这块结果是被裁过/重采样过的
        const mm = C.aspectMismatch(gen.width, gen.height, tile.w, tile.h);
        if (mm > 1.25 && !aspectWarned) {
          aspectWarned = true;
          const pct = Math.round((mm - 1) * 100);
          toast(`选区比例和模型出图比例差 ${pct}%，已按比例裁切贴合，不会变形`, 3600);
        }
      }

      // 多块结果：归一化后写入 patch（尺寸与累加缓冲一致）
      if (tiles.length > 1) {
        if (patchCanvas.width !== accW) { patchCanvas.width = accW; patchCanvas.height = accH; }
        const merged = pctx.createImageData(accW, accH);
        C.resolveAccumulated(acc, wacc, merged);
        pctx.putImageData(merged, 0, 0);
      }

      // 构造预览（不立即写入历史）；再次确认文档没被换掉
      if (token !== S.genToken || docVer !== S.docVersion) {
        const e = new Error('stale');
        e.name = 'AbortError';
        e.stale = true;
        throw e;
      }
      S.pending = {
        patch: patchCanvas,
        rect,
        feather: Number(S.cfg.feather) || 0,
        colorMatch: (Number(S.cfg.colorMatch) || 0) / 100,
        mask,
        docVersion: docVer,
        label: String($('prompt').value || '').trim().slice(0, 24)
      };
      // 累计花费（每次实际调用都算）
      const spent = currentEstimate();
      if (spent) S.spend = C.accumulateSpend(S.spend, spent);
      updateUI();

      showCompare();
      setBusy(false);
      if (lastUpscale && lastUpscale.scale > 1.05) {
        toast('生成完成（选区较小，已放大 ' + lastUpscale.scale.toFixed(1) + ' 倍发送，贴回时按原分辨率还原）', 3600);
      } else {
        toast('生成完成，拖动中间竖线对比效果');
      }
    } catch (err) {
      setBusy(false);
      if (err && err.name === 'AbortError') {
        if (!err.stale) toast('已取消生成');
      } else {
        showGenError(err, { kind, model: S.cfg.model, baseUrl: S.cfg.baseUrl });
      }
      console.error('[修图台] 生成失败', err);
    } finally {
      S.aborter = null;
      $('btn-generate').disabled = !S.img || !S.rect;
    }
  }

  function cropMask(mask, fullRect, tile) {
    const w = tile.w, h = tile.h;
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = tile.x - fullRect.x + x, sy = tile.y - fullRect.y + y;
        out[y * w + x] = (sx >= 0 && sy >= 0 && sx < fullRect.w && sy < fullRect.h) ? mask[sy * fullRect.w + sx] : 0;
      }
    }
    return out;
  }

  /* ====================== 成本预估 ====================== */

  /**
   * 算当前选区的预估成本。
   * 注意分块：选区过大时会切成多块，每块各调用一次模型 —— 成本随块数翻倍。
   */
  function currentEstimate() {
    if (!S.rect) return null;
    const m = currentModelParams();
    return C.estimateCost({
      rect: S.rect,
      tileMaxSide: Number(S.cfg.tile) || 0,
      overlap: 80,
      model: S.cfg.model,
      priceOverride: S.cfg.priceOverride === '' ? null : Number(S.cfg.priceOverride),
      usdCny: S.cfg.usdCny
    });
  }

  /** 生成前的成本确认（大额时拦一下，避免误操作烧钱） */
  function confirmCostIfNeeded(est) {
    if (!est || !est.known) return true;
    // 只有金额较大时才弹确认（0.2 美元以上，约 1.4 元）
    if (est.totalUsd < 0.2) return true;
    const msg = '这次生成预计花费 ' + C.formatUsd(est.totalUsd) +
      '（' + C.formatCny(est.totalCny) + '）\n\n' +
      '原因：选区较大，需要分 ' + est.tiles + ' 块分别处理，共 ' + est.calls + ' 次模型调用。\n\n' +
      '要继续吗？\n（缩小选区可以减少调用次数）';
    return window.confirm(msg);
  }

  /* ====================== 修改记录（图层）面板 ====================== */

  /**
   * 渲染修改记录列表。
   *
   * 这是「非破坏性编辑」的入口：每一行代表一次生成，但羽化、色彩匹配、
   * 不透明度都是「合成时」才应用的参数 —— 所以拖动滑块能立即看到效果变化，
   * **不需要重新调用模型（不花钱、不等待）**。
   */
  function renderLayers() {
    const list = $('layer-list');
    const empty = $('layer-empty');
    const badge = $('layer-count');
    if (!list) return;

    const n = S.edits.length;
    if (badge) { badge.textContent = String(n); badge.hidden = n === 0; }
    if (empty) empty.hidden = n > 0;
    list.innerHTML = '';

    // 从最新到最旧展示（用户最关心最近的操作）
    for (let i = S.edits.length - 1; i >= 0; i--) {
      const e = C.normalizeLayer(S.edits[i]);
      const idx = i + 1;

      const item = document.createElement('div');
      item.className = 'layer-item' + (e.enabled ? '' : ' off');

      // 头部：序号 + 名称 + 开关 + 删除
      const head = document.createElement('div');
      head.className = 'layer-head';

      const num = document.createElement('div');
      num.className = 'layer-idx';
      num.textContent = String(idx);

      const name = document.createElement('div');
      name.className = 'layer-name';
      const main = document.createElement('div');
      main.className = 'ln-main';
      main.textContent = e.label ? ('「' + e.label + '」') : '未命名修改';
      const sub = document.createElement('div');
      sub.className = 'ln-sub';
      const cov = C.layerCoverage(e, e.rect.w, e.rect.h);
      sub.textContent = e.rect.w + '×' + e.rect.h +
        ' · 覆盖约 ' + Math.round(cov * 100) + '%' +
        (e.downscaled ? ' · 已降采样' : '');
      name.appendChild(main); name.appendChild(sub);

      const toggle = document.createElement('button');
      toggle.className = 'layer-toggle' + (e.enabled ? ' on' : '');
      toggle.title = e.enabled ? '点击临时关闭这一处修改' : '点击重新启用';
      toggle.onclick = () => {
        const after = !e.enabled;
        S.edits[i].enabled = after;
        recordUndo({ type: 'toggle-layer', index: i, before: e.enabled, after, label: (after ? '启用' : '关闭') + '第 ' + idx + ' 处' });
        rebuildViewCanvas();
        renderLayers();
        draw();
        toast(after ? '已启用第 ' + idx + ' 处修改' : '已临时关闭第 ' + idx + ' 处修改');
      };

      const del = document.createElement('button');
      del.className = 'layer-del';
      del.title = '删除这一处修改';
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
      del.onclick = () => {
        const removed = S.edits[i];
        S.edits.splice(i, 1);
        recordUndo({ type: 'remove-layer', layer: removed, index: i, label: '删除第 ' + idx + ' 处修改' });
        rebuildViewCanvas();
        renderLayers();
        updateUI();
        draw();
        toast('已删除第 ' + idx + ' 处修改（可撤销）');
      };

      head.appendChild(num); head.appendChild(name);
      head.appendChild(toggle); head.appendChild(del);
      item.appendChild(head);

      // 参数区
      // 滑块值 → 图层内部值（opacity/colorMatch 是 0~1，feather 是像素数）
      const normalizeParam = (k, v) => (k === 'feather' ? v : v / 100);

      const mkParam = (label, value, min, max, step, fmt, key, onChange) => {
        const wrap = document.createElement('div');
        wrap.className = 'layer-param';
        const row = document.createElement('div');
        row.className = 'lp-row';
        const l = document.createElement('span'); l.textContent = label;
        const v = document.createElement('b'); v.textContent = fmt(value);
        row.appendChild(l); row.appendChild(v);
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(min); input.max = String(max); input.step = String(step);
        input.value = String(value);
        // 拖动过程中实时预览，但只在「松手」时记一条撤销 ——
        // 否则拖一次会产生上百条历史，把撤销栈冲爆
        // 注意：撤销命令里必须记「归一化后」的值（图层内部存的是 0~1 等比例值），
        // 而不是滑块上的 0~100。否则撤销会把 100 写进 opacity（越界）。
        let dragStart = null;
        const commit = (nv) => {
          onChange(nv);
          if (dragStart !== null && Math.abs(nv - dragStart) > 1e-9) {
            recordUndo({
              type: 'param-layer', index: i, key,
              before: normalizeParam(key, dragStart),
              after: normalizeParam(key, nv),
              label: label + ' ' + fmt(dragStart) + ' → ' + fmt(nv)
            });
          }
          dragStart = null;
        };
        input.onpointerdown = () => { dragStart = Number(input.value); };
        input.oninput = () => {
          const nv = Number(input.value);
          v.textContent = fmt(nv);
          onChange(nv);          // 实时预览（不记历史）
        };
        input.onchange = () => { commit(Number(input.value)); };
        input.onpointerup = () => { commit(Number(input.value)); };
        wrap.appendChild(row); wrap.appendChild(input);
        return wrap;
      };

      // 不透明度：最常用的「减弱」手段
      item.appendChild(mkParam('效果强度', Math.round(e.opacity * 100), 0, 100, 1,
        (v) => v + '%', 'opacity',
        (v) => {
          S.edits[i].opacity = v / 100;
          rebuildViewCanvas(); draw();
        }));

      // 边缘羽化
      item.appendChild(mkParam('边缘羽化', Math.round(e.feather), 0, 60, 1,
        (v) => v + ' px', 'feather',
        (v) => {
          S.edits[i].feather = v;
          rebuildViewCanvas(); draw();
        }));

      // 接缝色彩匹配
      item.appendChild(mkParam('色彩匹配', Math.round(e.colorMatch * 100), 0, 100, 1,
        (v) => v + '%', 'colorMatch',
        (v) => {
          S.edits[i].colorMatch = v / 100;
          rebuildViewCanvas(); draw();
        }));

      const note = document.createElement('div');
      note.className = 'layer-note';
      note.textContent = '调整这些参数不会重新生成，可随时改动';
      item.appendChild(note);

      list.appendChild(item);
    }
  }

  function openLayers() {
    $('layers').hidden = false;
    renderLayers();
  }
  function closeLayers() { $('layers').hidden = true; }

  /* ============================ 错误面板 ============================ */

  let lastError = null;
  let lastRequest = null;   // 最近一次实际发出的请求（用于自查）
  let lastUpscale = null;   // 最近一次的上采样信息

  function clearErrorPanel() {
    const el = $('gen-error');
    if (el) { el.hidden = true; el.innerHTML = ''; }
    lastError = null;
  }

  /**
   * 把失败原因讲清楚：一句话结论 + 具体怎么改 + 可展开的原始信息。
   * 生图接口的报错往往很含糊（甚至回一段对话），这里负责翻译成能照着做的提示。
   */
  function showGenError(err, ctx) {
    const status = err && err.status ? err.status : 0;
    const json = err && err.json ? err.json : null;
    let diag;

    if (err && err.local) {
      diag = { code: 'local', message: err.message, hint: '', raw: '' };
    } else if (err && err.proxy) {
      diag = {
        code: 'proxy',
        message: '本机代理没能连上接口',
        hint: '请检查网络是否可用，以及设置里的接口地址是否正确（硅基流动为 https://api.siliconflow.cn/v1）。',
        raw: err.message
      };
    } else if (err && /Failed to fetch|NetworkError|Load failed/i.test(err.message || '')) {
      diag = {
        code: 'network',
        message: '连不上接口（网络或跨域问题）',
        hint: '请检查手机网络；若使用「浏览器直连」方式，部分服务商不允许跨域，' +
          '请在设置里把「请求方式」改成「只用本地代理」，或改用本应用的 APK 版本。',
        raw: err.message
      };
    } else if (json || (err && err.text)) {
      diag = C.diagnoseResponse(json, status, Object.assign({ rawText: err && err.text }, ctx));
    } else {
      diag = { code: 'unknown', message: (err && err.message) || '生成失败', hint: '', raw: '' };
    }

    lastError = diag;
    const el = $('gen-error');
    if (!el) { toast('生成失败：' + diag.message, 4200); return; }

    const raw = (diag.raw || '').toString().replace(/</g, '&lt;').slice(0, 600);
    el.innerHTML =
      '<div class="err-head">' +
        '<svg viewBox="0 0 24 24" class="err-ico"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>' +
        '<div class="err-title">生成失败</div>' +
        '<button class="tb-btn icon err-close" id="err-close">' +
          '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="err-msg">' + diag.message.replace(/</g, '&lt;') + '</div>' +
      (diag.hint ? '<div class="err-hint">' + diag.hint.replace(/</g, '&lt;') + '</div>' : '') +
      '<div class="err-actions">' +
        '<button class="ghost small" id="err-settings">去设置检查</button>' +
        (raw ? '<button class="ghost small" id="err-toggle">查看原始信息</button>' : '') +
        (lastRequest ? '<button class="ghost small" id="err-req">查看本次请求</button>' : '') +
        '<button class="primary small" id="err-retry">重试</button>' +
      '</div>' +
      (lastRequest ? '<pre class="err-raw" id="err-req-body" hidden>' + esc(requestSummary(lastRequest)) + '</pre>' : '') +
      (raw ? '<pre class="err-raw" id="err-raw" hidden>' + raw + '</pre>' : '');

    el.hidden = false;
    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    on('err-close', clearErrorPanel);
    on('err-settings', () => { clearErrorPanel(); openSettings(); });
    on('err-retry', () => { clearErrorPanel(); generate(); });
    on('err-toggle', () => {
      const pre = $('err-raw');
      if (pre) {
        pre.hidden = !pre.hidden;
        $('err-toggle').textContent = pre.hidden ? '查看原始信息' : '收起原始信息';
      }
    });
    on('err-req', () => {
      const pre = $('err-req-body');
      if (pre) {
        pre.hidden = !pre.hidden;
        $('err-req').textContent = pre.hidden ? '查看本次请求' : '收起请求信息';
      }
    });
  }

  /* ============================ 对比预览 ============================ */

  const cmpCv = $('cmp-cv');
  let cmpCtx = null;
  let cmpSplit = 0.5;
  let cmpBefore = null, cmpAfter = null;

  function showCompare() {
    const p = S.pending;
    if (!p) return;
    // before = 当前文档（含已应用编辑），after = 再叠加本次结果
    const before = makeCanvas(S.docW, S.docH);
    const bctx = before.getContext('2d');
    bctx.drawImage(S.viewCanvas, 0, 0);

    const after = makeCanvas(S.docW, S.docH);
    const actx = after.getContext('2d', { willReadFrequently: true });
    actx.drawImage(S.viewCanvas, 0, 0);
    const id = actx.getImageData(p.rect.x, p.rect.y, p.rect.w, p.rect.h);
    const src = p.patch.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, p.patch.width, p.patch.height);
    C.compositeFeathered(id, src, { x: 0, y: 0, w: p.rect.w, h: p.rect.h }, {
      feather: p.feather,
      colorMatch: { ring: 8, ramp: Math.max(6, p.feather || 8), strength: p.colorMatch },
      mask: p.mask
    });
    actx.putImageData(id, p.rect.x, p.rect.y);

    cmpBefore = before; cmpAfter = after;
    cmpSplit = 0.5;
    $('compare').hidden = false;
    layoutCompare();
    drawCompare();
  }

  function layoutCompare() {
    const r = $('compare').getBoundingClientRect();
    const d = DPR();
    cmpCv.width = Math.max(1, Math.round(r.width * d));
    cmpCv.height = Math.max(1, Math.round(r.height * d));
    cmpCv.style.width = r.width + 'px';
    cmpCv.style.height = r.height + 'px';
    cmpCtx = cmpCv.getContext('2d');
    cmpCtx.setTransform(d, 0, 0, d, 0, 0);
  }

  function drawCompare() {
    if (!cmpCtx || !cmpBefore) return;
    const r = $('compare').getBoundingClientRect();
    const W = r.width, H = r.height;
    const v = C.fitView(S.docW, S.docH, W, H, 10);

    cmpCtx.clearRect(0, 0, W, H);
    cmpCtx.fillStyle = '#0b0d11';
    cmpCtx.fillRect(0, 0, W, H);

    const dr = C.imageRectToScreen({ x: 0, y: 0, w: S.docW, h: S.docH }, v);
    cmpCtx.imageSmoothingEnabled = v.scale < 1;
    cmpCtx.drawImage(cmpBefore, dr.x, dr.y, dr.w, dr.h);

    const sx = dr.x + dr.w * cmpSplit;
    cmpCtx.save();
    cmpCtx.beginPath();
    cmpCtx.rect(sx, 0, W - sx, H);
    cmpCtx.clip();
    cmpCtx.drawImage(cmpAfter, dr.x, dr.y, dr.w, dr.h);
    cmpCtx.restore();

    // 选区提示
    const sr = C.imageRectToScreen(S.pending.rect, v);
    cmpCtx.save();
    cmpCtx.strokeStyle = 'rgba(77,163,255,.9)';
    cmpCtx.lineWidth = 1.5;
    cmpCtx.setLineDash([6, 5]);
    cmpCtx.strokeRect(sr.x, sr.y, sr.w, sr.h);
    cmpCtx.restore();

    // 分割线
    cmpCtx.save();
    cmpCtx.strokeStyle = '#fff';
    cmpCtx.lineWidth = 2;
    cmpCtx.beginPath();
    cmpCtx.moveTo(sx, 0); cmpCtx.lineTo(sx, H);
    cmpCtx.stroke();
    cmpCtx.restore();

    $('cmp-handle').style.left = (sx / W * 100) + '%';
  }

  function initCompareInteraction() {
    const el = $('compare');
    let dragging = false;
    const move = (clientX) => {
      const r = el.getBoundingClientRect();
      cmpSplit = C.clamp01((clientX - r.left) / r.width);
      drawCompare();
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.cmp-actions') || e.target.closest('.cmp-hint')) return;
      dragging = true;
      el.setPointerCapture(e.pointerId);
      move(e.clientX);
    });
    el.addEventListener('pointermove', (e) => { if (dragging) move(e.clientX); });
    el.addEventListener('pointerup', () => { dragging = false; });
    el.addEventListener('pointercancel', () => { dragging = false; });
  }

  function applyPending() {
    const p = S.pending;
    if (!p) return;
    // 双重校验：文档版本 + 选区是否仍落在当前画布内（换图后可能越界）
    const outOfBounds = p.rect.x < 0 || p.rect.y < 0 ||
      p.rect.x + p.rect.w > S.docW || p.rect.y + p.rect.h > S.docH;
    if (p.docVersion !== S.docVersion || outOfBounds) {
      toast('照片已更换，这次结果已作废');
      discardPending();
      return;
    }
    // 用同一套合成参数写入正式文档
    const tmp = makeCanvas(S.docW, S.docH);
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(S.viewCanvas, 0, 0);

    const edit = {
      rect: p.rect,
      patch: p.patch,
      feather: p.feather,
      colorMatch: p.colorMatch,
      mask: p.mask,
      opacity: 1,               // 图层不透明度（可调，用于减弱效果）
      enabled: true,            // 图层开关
      label: (p.label || ''),   // 展示用标签（取自提示词）
      createdAt: Date.now()
    };
    compositeEditInto(tctx, edit);

    S.viewCanvas = tmp;
    S.viewCtx = tctx;
    S.edits.push(edit);
    recordUndo({
      type: 'add-layer', layer: edit, index: S.edits.length - 1,
      label: edit.label ? ('「' + edit.label + '」') : '生成修改'
    });
    S.pending = null;
    S.strokes = [];
    invalidateMask();
    enforceHistoryBudget();       // 控制内存，防止手机上被系统杀掉
    scheduleSessionSave();
    renderLayers();               // 刷新修改记录面板
    $('compare').hidden = true;
    updateUI();
    draw();
    toast(S.historyNote ? '已贴回原图（' + S.historyNote + '）' : '已贴回原图', S.historyNote ? 3600 : 2600);
  }

  function discardPending() {
    S.pending = null;
    $('compare').hidden = true;
    draw();
    updateUI();
  }

  /* ============================ 撤销 / 重做 ============================ */

  /**
   * 执行一条「撤销/重做」命令。
   *
   * 关键设计：命令只存「最小差异」（索引 + 参数），不存整图快照，
   * 所以 100 步历史也不会吃内存。
   */
  function applyCommand(cmd, isRedo) {
    const d = C.commandDirection(cmd, isRedo);
    if (!d) return;
    switch (d.action) {
      case 'insert-layer':
        S.edits.splice(Math.max(0, Math.min(d.index, S.edits.length)), 0, d.layer);
        break;
      case 'remove-layer':
        S.edits.splice(d.index, 1);
        break;
      case 'set-param':
        if (S.edits[d.index]) S.edits[d.index][d.key] = d.value;
        break;
      case 'set-enabled':
        if (S.edits[d.index]) S.edits[d.index].enabled = d.value;
        break;
      case 'add-stroke':
        if (cmd.stroke) S.strokes.push(cmd.stroke);
        break;
      case 'remove-last-stroke':
        S.strokes.pop();
        break;
      case 'clear-strokes':
        S.strokes = [];
        break;
      case 'restore-strokes':
        S.strokes = (d.strokes || []).slice();
        break;
      case 'set-rect':
        S.rect = d.rect ? Object.assign({}, d.rect) : null;
        break;
      default:
        break;
    }
    invalidateMask();
    S.docVersion++;
    rebuildViewCanvas();
    renderLayers();
    draw();
    updateUI();
  }

  function undo() {
    if (!undoStack || !undoStack.canUndo()) { toast('没有可撤销的操作'); return; }
    const cmd = undoStack.undo();
    applyCommand(cmd, false);
    toast('已撤销：' + (cmd.label || '操作'));
  }

  function redo() {
    if (!undoStack || !undoStack.canRedo()) { toast('没有可重做的操作'); return; }
    const cmd = undoStack.redo();
    applyCommand(cmd, true);
    toast('已重做：' + (cmd.label || '操作'));
  }

  /** 记录一个操作到撤销栈（在所有会改变画面的操作后调用） */
  function recordUndo(cmd) {
    if (!undoStack) return;
    const c = C.makeUndoCommand(cmd.type, cmd);
    if (c) undoStack.push(c);
    updateUI();
  }

  /* ============================ 导出 ============================ */

  async function exportImage() {
    if (!S.viewCanvas) return;
    // 按预设决定格式/质量（自定义时用设置里的值）
    const preset = C.getExportPreset(S.cfg.exportPreset);
    const isCustom = preset.id === 'custom';
    const fmt = (isCustom ? (S.cfg.format === 'png') : (preset.format === 'png'))
      ? 'image/png' : 'image/jpeg';
    const q = isCustom ? ((Number(S.cfg.quality) || 95) / 100) : preset.quality;

    // 若工作分辨率低于原图，按原图尺寸重新合成一遍（保证导出清晰度）
    let out = S.viewCanvas;
    const scale = S.imgW / S.docW;
    if (scale > 1.01 && S.edits.length) {
      const big = makeCanvas(S.imgW, S.imgH);
      const bctx = big.getContext('2d', { willReadFrequently: true });
      bctx.imageSmoothingQuality = 'high';
      bctx.drawImage(S.img, 0, 0, S.imgW, S.imgH);
      for (const e of S.edits) {
        const r = { x: Math.round(e.rect.x * scale), y: Math.round(e.rect.y * scale), w: Math.round(e.rect.w * scale), h: Math.round(e.rect.h * scale) };
        const id = bctx.getImageData(r.x, r.y, r.w, r.h);
        const pc = makeCanvas(r.w, r.h);
        pc.getContext('2d').drawImage(e.patch, 0, 0, r.w, r.h);
        const src = pc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, r.w, r.h);
        const mask = e.mask ? resampleMask(e.mask, e.rect.w, e.rect.h, r.w, r.h) : null;
        C.compositeFeathered(id, src, { x: 0, y: 0, w: r.w, h: r.h }, {
          feather: e.feather * scale,
          colorMatch: { ring: Math.round(8 * scale), ramp: Math.max(6, e.feather * scale), strength: e.colorMatch },
          mask
        });
        bctx.putImageData(id, r.x, r.y);
      }
      out = big;
    }

    // 按预设缩放尺寸（只缩不放，避免把小图拉大导致模糊）
    const plan = C.planExportSize(out.width, out.height, preset);
    if (plan.scaled) {
      const scaled = makeCanvas(plan.w, plan.h);
      const sx = scaled.getContext('2d');
      sx.imageSmoothingEnabled = true;
      sx.imageSmoothingQuality = 'high';
      sx.drawImage(out, 0, 0, out.width, out.height, 0, 0, plan.w, plan.h);
      out = scaled;
    }

    let blob = await new Promise((res) => out.toBlob(res, fmt, q));
    if (!blob) { toast('导出失败'); return; }

    // 写回元数据：canvas 重绘会把 EXIF（相机/镜头/光圈/快门/ISO/时间/GPS）和
    // ICC 色彩配置全部丢掉，摄影师交片时需要保留，所以在这里手动补回。
    let metaNote = '';
    if (fmt === 'image/jpeg' && S.meta && S.meta.source === 'jpeg') {
      try {
        const raw = new Uint8Array(await blob.arrayBuffer());
        // 按预设决定写回哪些元数据（是否保留拍摄信息 / 是否去掉 GPS / 是否保留 ICC）
        const mp = C.planExportMetadata(S.meta, preset);
        if (mp.notes && mp.notes.length) metaNote = mp.notes.join('；');
        const r = C.injectMetadata(raw, { exif: mp.exif, icc: mp.icc });
        if (r.bytes && r.bytes.length) {
          blob = new Blob([r.bytes], { type: 'image/jpeg' });
        }
        if (r.notes && r.notes.length) metaNote = r.notes.join('；');
      } catch (e) {
        console.warn('[修图台] 写入元数据失败（不影响导出）', e);
      }
    }

    const name = C.timestampName('retouched', fmt === 'image/png' ? 'png' : 'jpg');

    // 优先系统分享（手机上更方便）
    const file = new File([blob], name, { type: fmt });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: '修图结果' });
        toast('已分享');
        return;
      } catch (e) { /* 用户取消则继续下载 */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('已导出 ' + name + '（' + C.formatBytes(blob.size) + '）' +
      (metaNote ? ' · ' + metaNote : '') +
      (S.meta && S.meta.exif ? ' · 已保留拍摄信息' : ''), 3600);
  }

  function resampleMask(mask, sw, sh, dw, dh) {
    const out = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(sh - 1, Math.floor(y * sh / dh));
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(sw - 1, Math.floor(x * sw / dw));
        out[y * dw + x] = mask[sy * sw + sx];
      }
    }
    return out;
  }

  /* ============================ UI 绑定 ============================ */

  function updateUI() {
    // 撤销 / 重做
    $('btn-undo').disabled = !(undoStack && undoStack.canUndo());
    $('btn-redo').disabled = !(undoStack && undoStack.canRedo());
    $('btn-save').disabled = !S.viewCanvas;

    // 缩放显示
    $('zoom-label').textContent = Math.round(S.view.scale * 100) + '%';

    // 选区信息
    const info = $('sel-info');
    if (S.rect) {
      info.hidden = false;
      const m = C.findModel(S.cfg.provider, S.cfg.model);
      const { size, aspect } = pickOutputSize(S.rect);
      const px = Math.round(S.rect.w * (S.imgW / S.docW));
      const py = Math.round(S.rect.h * (S.imgH / S.docH));
      info.innerHTML = `<span class="hud-pill">选区 ${Math.round(S.rect.w)}×${Math.round(S.rect.h)}</span>` +
        (size ? `<span class="hud-pill dim">出图 ${size}</span>` : aspect ? `<span class="hud-pill dim">出图 ${aspect}</span>` : '') +
        (px !== Math.round(S.rect.w) ? `<span class="hud-pill dim">原图 ${px}×${py}</span>` : '');
    } else {
      info.hidden = true;
    }

    // 生成按钮
    const rectOk = !!S.rect && S.rect.w >= 8 && S.rect.h >= 8;
    const canGen = !!S.img && rectOk && !S.busy;
    $('btn-generate').disabled = !canGen;
    const m = C.findModel(S.cfg.provider, S.cfg.model);
    const nTiles = (S.rect && Number(S.cfg.tile) > 0) ? C.planTileCrop(S.rect, { maxSide: Number(S.cfg.tile), overlap: 80 }).length : 1;
    const dev = aspectDevPct();
    const devNote = dev >= 6 ? `（出图比例与选区差 ${dev}%，会自动按比例裁切，不会变形）` : '';
    const outSize = (S.rect && S.img) ? pickOutputSize(S.rect) : null;
    const sizeNote = (outSize && outSize.size) ? `出图 ${outSize.size}；` : '';
    // 成本预估：让用户在点之前就知道要花多少（含分块导致的多次调用）
    const est = (S.rect && S.img) ? currentEstimate() : null;
    let costNote = '';
    if (est) {
      if (est.known) {
        costNote = '预计 ' + C.formatUsd(est.totalUsd) + '（' + C.formatCny(est.totalCny) + '）' +
          (est.calls > 1 ? '，' + est.calls + ' 次调用' : '') + '；';
      } else {
        costNote = '单价未知（可在设置填写）；';
      }
    }
    $('gen-hint').textContent = !S.img ? '先打开一张照片'
      : !S.rect ? '在照片上拖动框选要修改的位置'
        : nTiles > 1 ? `选区较大，将分 ${nTiles} 块生成；${sizeNote}${costNote}${devNote}`
          : (m && m.kind === 't2i' ? '当前模型不支持参考图，将按提示词重新生成该区域；' + costNote
            : sizeNote + costNote + '就绪' + devNote);

    // 模型按钮
    const dot = $('model-dot');
    const hasKey = !!S.cfg.apiKey;
    dot.className = 'dot' + (hasKey ? ' ok' : ' warn');
    const shortModel = S.cfg.model ? S.cfg.model.split('/').pop() : '未配置模型';
    const spendTxt = S.spend.calls > 0
      ? '　·　已花 ' + C.formatUsd(S.spend.usd) + (S.spend.unknownCalls ? ' +' + S.spend.unknownCalls + '次未知' : '')
      : '';
    $('model-label').textContent = shortModel + spendTxt;

    // 工具态
    document.querySelectorAll('.tool[data-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === S.mode);
    });
    const inBrush = S.mode === 'brush';
    $('brush-bar').hidden = !inBrush;
    $('brush-tip').hidden = !inBrush;
    $('brush-erase').setAttribute('aria-pressed', String(S.brushErase));
    $('brush-erase').classList.toggle('on', S.brushErase);
    $('brush-restore').setAttribute('aria-pressed', String(!S.brushErase));
    $('brush-restore').classList.toggle('on', !S.brushErase);
  }

  function openSettings() {
    $('settings').hidden = false;
    syncSettingsUI();
  }
  function closeSettings() { $('settings').hidden = true; }

  function syncSettingsUI() {
    fillProviderList();
    fillPresetList();
    updatePresetUI();
    $('set-provider').value = S.cfg.provider;
    $('set-baseurl').value = S.cfg.baseUrl;
    $('set-apikey').value = S.cfg.apiKey;
    $('set-model').value = S.cfg.model;
    $('set-netmode').value = S.cfg.netMode;
    $('set-ctx').value = S.cfg.contextPct;
    $('set-feather').value = S.cfg.feather;
    $('set-cm').value = S.cfg.colorMatch;
    $('set-maxres').value = String(S.cfg.maxRes);
    $('set-tile').value = S.cfg.tile;
    $('set-lang').value = S.cfg.lang;
    $('set-seed').value = S.cfg.seed;
    $('set-preset').value = S.cfg.exportPreset || 'full';
    $('set-format').value = S.cfg.format;
    $('set-quality').value = S.cfg.quality;
    $('set-mosaic').checked = !!S.cfg.mosaic;
    $('set-upscale').checked = S.cfg.upscaleSmall !== false;
    $('set-mem').value = S.cfg.historyBudgetMB || 192;
    $('set-autosave').checked = S.cfg.autoSaveSession !== false;
    $('set-price').value = S.cfg.priceOverride === '' ? '' : S.cfg.priceOverride;
    $('set-usdcny').value = S.cfg.usdCny || 7.1;
    syncRangeLabels();
    fillModelList();
    updateProviderTip();
    updatePriceTip();
  }

  function syncRangeLabels() {
    $('v-ctx').textContent = S.cfg.contextPct + '%';
    $('v-feather').textContent = S.cfg.feather + ' px';
    $('v-cm').textContent = S.cfg.colorMatch + '%';
    $('v-tile').textContent = S.cfg.tile > 0 ? S.cfg.tile + ' px' : '关闭';
    $('v-quality').textContent = S.cfg.quality + '%';
    $('v-mem').textContent = (S.cfg.historyBudgetMB || 192) + ' MB';
  }

  function fillModelList() {
    const p = C.getProvider(S.cfg.provider);
    const dl = $('model-list');
    dl.innerHTML = '';
    for (const m of p.models) {
      if (!m.id) continue;
      const o = document.createElement('option');
      o.value = m.id; o.label = m.label;
      dl.appendChild(o);
    }
  }

  function fillPresetList() {
    const sel = $('set-preset');
    if (!sel || sel.children.length) return;
    sel.innerHTML = '';
    for (const p of C.EXPORT_PRESETS) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.label;
      sel.appendChild(o);
    }
  }

  function updatePresetUI() {
    const preset = C.getExportPreset(S.cfg.exportPreset);
    const desc = $('preset-desc');
    if (desc) {
      let d = preset.desc || '';
      if (S.imgW && S.docW) {
        const plan = C.planExportSize(S.imgW, S.imgH, preset);
        d += '　→ 导出 ' + plan.w + '×' + plan.h + (plan.scaled ? '（已缩小）' : '');
      }
      desc.textContent = d;
    }
    const ce = $('custom-export');
    if (ce) ce.hidden = preset.id !== 'custom';
  }

  function fillProviderList() {
    const sel = $('set-provider');
    if (sel.children.length) return;
    sel.innerHTML = '';
    for (const p of C.PROVIDERS) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.label;
      sel.appendChild(o);
    }
  }

  /** 显示当前模型的单价来源，让用户知道预估依据 */
  function updatePriceTip() {
    const tip = $('price-tip');
    const st = $('spend-status');
    if (tip) {
      const builtin = C.modelPrice(S.cfg.model);
      const custom = S.cfg.priceOverride !== '' && S.cfg.priceOverride != null;
      let t = '';
      if (custom) {
        t = '当前使用你填写的单价：$' + Number(S.cfg.priceOverride).toFixed(4) + '/张';
      } else if (builtin) {
        t = '内置单价：' + C.formatUsd(builtin.usd) + '/张（' + (builtin.note || '') + '）';
      } else {
        t = '这个模型没有内置单价，预估会显示「未知」。你可以手动填写单价。';
      }
      t += '\n价格来自各服务商官方页面，可能随时间变化，仅作量级参考。';
      t += '\n注意：选区过大时会自动分块，每块各调用一次，成本按块数增加。';
      tip.textContent = t;
    }
    if (st) {
      st.textContent = S.spend.calls > 0
        ? ('本次会话已调用 ' + S.spend.calls + ' 次，累计 ' + C.formatUsd(S.spend.usd) +
           (S.spend.unknownCalls ? '（另有 ' + S.spend.unknownCalls + ' 次单价未知）' : ''))
        : '本次会话还没有产生调用';
    }
  }

  function updateProviderTip() {
    const p = C.getProvider(S.cfg.provider);
    const m = C.findModel(S.cfg.provider, S.cfg.model);
    let tip = `服务商：${p.label}`;
    if (m && m.note) tip += ` · ${m.note}`;
    if (p.keyUrl) tip += ` · 获取 Key：${p.keyUrl}`;
    $('provider-tip').textContent = tip;

    const netTip = $('net-tip');
    const isFile = location.protocol === 'file:';
    netTip.textContent = isFile
      ? '当前是本地文件方式打开，浏览器直连即可（若接口不开放跨域，请用「启动修图台」脚本以本地服务方式打开）。'
      : '通过本地服务打开时，请求走同源代理，没有跨域限制，Key 只在本机使用。';
  }

  /* ====================== 自动检测可用模型 ====================== */

  /**
   * 拉取服务商的模型列表，筛出生图模型，并给出推荐。
   * 流程：先校验地址/Key → 请求 /models → 分类筛选 → 逐个校验可编辑性 → 渲染可选列表。
   */
  async function detectModels() {
    const box = $('detect-box');
    const list = $('detect-list');
    const summary = $('detect-summary');
    const st = $('test-status');
    const baseUrl = (S.cfg.baseUrl || '').trim().replace(/\/+$/, '');

    if (!baseUrl) {
      st.textContent = '请先填写接口地址';
      st.className = 'status bad';
      return;
    }
    if (!S.cfg.apiKey) {
      st.textContent = '请先填写 API Key';
      st.className = 'status bad';
      return;
    }

    box.hidden = false;
    list.innerHTML = '<div class="detect-loading">正在读取模型列表…</div>';
    summary.textContent = '检测中…';
    st.textContent = '检测中…';
    st.className = 'status';

    const headers = { Authorization: 'Bearer ' + S.cfg.apiKey };
    let json = null, httpErr = null;

    // 依次尝试几种常见的模型列表路径（不同服务商不一样）
    const paths = ['/models', '/v1/models', '/api/v1/models', '/openai/v1/models'];
    for (const p of paths) {
      const url = baseUrl.endsWith('/v1') && p === '/v1/models'
        ? baseUrl.replace(/\/v1$/, '') + '/v1/models'
        : baseUrl + p;
      try {
        const res = await fetch(url, { headers });
        const text = await res.text();
        if (!res.ok) {
          httpErr = { status: res.status, text };
          continue;
        }
        try { json = JSON.parse(text); } catch (e) { continue; }
        if (json) break;
      } catch (e) {
        httpErr = { status: 0, text: e.message };
      }
    }

    if (!json) {
      const d = C.diagnoseResponse(null, httpErr ? httpErr.status : 0,
        { rawText: httpErr ? httpErr.text : '', kind: 'edit' });
      list.innerHTML = '<div class="detect-empty">读取失败：' + esc(d.message) +
        (d.hint ? '<br>' + esc(d.hint) : '') + '</div>';
      summary.textContent = '检测失败';
      st.textContent = '✗ 检测失败';
      st.className = 'status bad';
      return;
    }

    const found = C.pickImageModels(json);
    const total = (json && (json.data || json.models || json.result || (Array.isArray(json) ? json : [])) || []).length;

    if (!found.length) {
      list.innerHTML = '<div class="detect-empty">这个接口下有 ' + total +
        ' 个模型，但没找到生图模型。<br>' +
        '可能原因：① 该服务商不提供图像模型；② 该账号未开通图像权限。<br>' +
        '可以手动在「模型」里填写模型名，例如 Qwen/Qwen-Image-Edit。</div>';
      summary.textContent = '共 ' + total + ' 个模型，其中 0 个可用于生图';
      st.textContent = '✓ 连接正常（无生图模型）';
      st.className = 'status ok';
      return;
    }

    const edits = found.filter((m) => m.kind === 'edit').length;
    summary.textContent = '共 ' + total + ' 个模型 · 找到 ' + found.length +
      ' 个生图模型（其中 ' + edits + ' 个支持参考原图编辑）';
    st.textContent = '✓ 连接正常';
    st.className = 'status ok';
    renderDetectList(found);
  }

  function renderDetectList(models) {
    const list = $('detect-list');
    list.innerHTML = '';
    for (const m of models) {
      const btn = document.createElement('button');
      btn.className = 'detect-item' + (m.id === S.cfg.model ? ' current' : '');
      const tagCls = m.kind === 'edit' ? 'edit' : 't2i';
      const tagTxt = m.kind === 'edit' ? '可编辑' : '文生图';
      const note = m.kind === 'edit'
        ? '支持传参考图做局部修改' + (m.recommended ? ' · 推荐' : '')
        : '只按提示词生成，不参考原图';
      btn.innerHTML =
        '<div class="di-main">' +
          '<div class="di-id">' + esc(m.id) + '</div>' +
          '<div class="di-note">' + esc(note) + '</div>' +
        '</div>' +
        '<span class="detect-tag ' + tagCls + '">' + tagTxt + '</span>';
      btn.onclick = () => {
        S.cfg.model = m.id;
        saveCfg();
        $('set-model').value = m.id;
        [...list.children].forEach((c) => c.classList.toggle('current', c === btn));
        updateProviderTip();
        if (S.img && S.rect) { snapRectToModel(); draw(); }
        updateUI();
        toast('已选用 ' + m.id);
      };
      list.appendChild(btn);
    }
  }

  /** 把「实际发出的请求」整理成人能看懂的一段文字，便于自查是否带了图片 */
  function requestSummary(r) {
    if (!r) return '';
    const lines = [
      '接口地址：' + r.url,
      '模型名　：' + r.model,
      // multipart（OpenAI 编辑接口）与 JSON（硅基流动）是两种完全不同的发送格式，
      // 类型不对时图片会静默丢失，所以必须写清楚
      '发送格式：' + (r.multipartUsed ? 'multipart 表单（图片作为文件上传）' : 'JSON'),
      '是否带图：' + (r.hasImage ? '是（字段 ' + r.imageField + '，约 ' + C.formatBytes(r.imageBytes) + '）' : '否 —— 这就是上游说没收到图片的原因'),
      '出图尺寸：' + r.size,
      '提示词　：' + r.promptChars + ' 字',
      (lastUpscale ? '小图放大：是（' + lastUpscale.from + ' → ' + lastUpscale.to +
        '，' + lastUpscale.scale.toFixed(2) + ' 倍；生成后会按同比例缩回原分辨率）' : '小图放大：不需要'),
      '请求字段：' + r.keys.join(', ')
    ];
    if (!r.hasImage && r.model) {
      lines.push('');
      lines.push('提示：当前请求没有带上参考图。');
      lines.push('要改一块区域，请换用图像编辑模型（如 Qwen/Qwen-Image-Edit、FLUX.1-Kontext、gpt-image-1）。');
    }
    if (r.multipartUsed) {
      lines.push('');
      lines.push('说明：OpenAI 系接口要求图片以 multipart 表单上传。');
      lines.push('如果上游仍说没收到图片，多半是接口地址或中转不支持该模型/格式，请换一个中转或模型名试试。');
    }
    return lines.join('\n');
  }

  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------- 事件绑定 ---------- */

  function bind() {
    // 顶栏
    $('btn-open').onclick = () => $('file-input').click();
    $('btn-pick').onclick = () => $('file-input').click();
    $('btn-demo').onclick = useDemoImage;
    $('btn-settings').onclick = openSettings;
    $('btn-save').onclick = exportImage;
    $('btn-undo').onclick = undo;
    $('btn-redo').onclick = redo;

    $('file-input').onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try { await loadImageFromBlob(f, f.name); toast('已载入 ' + f.name); }
      catch (err) { toast('打开失败：' + err.message); }
      e.target.value = '';
    };

    // 工具
    document.querySelectorAll('.tool[data-mode]').forEach((b) => {
      b.onclick = () => {
        S.mode = b.dataset.mode;
        if (S.mode !== 'brush') { S.strokes = []; invalidateMask(); }
        updateUI(); draw();
      };
    });
    $('btn-layers').onclick = openLayers;
    document.querySelectorAll('#layers [data-close]').forEach((el) => { el.onclick = closeLayers; });
    $('btn-fit').onclick = fitToScreen;
    $('btn-reset-sel').onclick = () => {
      if (!S.docCanvas) return;
      const m = 0.08;
      S.rect = C.clampRect({ x: S.docW * m, y: S.docH * m, w: S.docW * (1 - 2 * m), h: S.docH * (1 - 2 * m) }, S.docW, S.docH);
      S.strokes = []; invalidateMask();
      snapRectToModel(); draw(); updateUI();
    };

    // 缩放
    $('zoom-in').onclick = () => zoomCenter(1.35);
    $('zoom-out').onclick = () => zoomCenter(1 / 1.35);
    $('zoom-label').onclick = fitToScreen;

    // 画笔
    const bs = $('brush-size');
    bs.oninput = () => { S.brushSize = Number(bs.value); $('brush-size-val').textContent = bs.value; };
    $('brush-erase').onclick = () => { S.brushErase = true; updateUI(); };
    $('brush-restore').onclick = () => { S.brushErase = false; updateUI(); };
    $('brush-clear').onclick = () => {
      if (!S.strokes.length) { toast('当前没有笔迹'); return; }
      recordUndo({ type: 'clear-strokes', strokes: S.strokes.slice(), label: '清空笔迹' });
      S.strokes = [];
      invalidateMask();
      renderLayers();
      draw();
      toast('已重置修改范围（可撤销）');
    };

    // 比例
    const ratios = [
      { v: 0, t: '自由' }, { v: 1, t: '1:1' }, { v: 4 / 3, t: '4:3' }, { v: 3 / 4, t: '3:4' },
      { v: 3 / 2, t: '3:2' }, { v: 2 / 3, t: '2:3' }, { v: 16 / 9, t: '16:9' }, { v: 9 / 16, t: '9:16' }
    ];
    const rc = $('ratio-chips');
    rc.innerHTML = '';
    for (const r of ratios) {
      const b = document.createElement('button');
      b.className = 'chip' + (r.v === 0 ? ' on' : '');
      b.textContent = r.t;
      b.onclick = () => {
        S.ratio = r.v;
        [...rc.children].forEach((c) => c.classList.toggle('on', c === b));
        if (S.ratio && S.rect) {
          const cx = S.rect.x + S.rect.w / 2, cy = S.rect.y + S.rect.h / 2;
          let w = S.rect.w, h = w / S.ratio;
          if (h > S.docH) { h = S.docH; w = h * S.ratio; }
          S.rect = C.clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }, S.docW, S.docH);
          S.strokes = []; invalidateMask();
        }
        draw(); updateUI();
      };
      rc.appendChild(b);
    }

    // 预设
    const ss = $('style-select');
    for (const s of C.STYLE_PRESETS) {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = s.label;
      ss.appendChild(o);
    }
    const sc = $('scope-select');
    for (const s of C.SCOPE_PRESETS) {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = s.label;
      sc.appendChild(o);
    }
    sc.value = 'region';

    // 快捷指令
    const quick = [
      '去掉这个物体，背景自然补全',
      '皮肤精修，保留质感',
      '换成傍晚的光线',
      '把这行字改成「' + '」',
      '衣服换成深蓝色',
      '修复模糊，变清晰'
    ];
    const qc = $('quick-chips');
    qc.innerHTML = '';
    quick.forEach((t) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = t.length > 14 ? t.slice(0, 13) + '…' : t;
      b.title = t;
      b.onclick = () => { $('prompt').value = t; $('prompt').focus(); };
      qc.appendChild(b);
    });

    $('btn-model').onclick = openSettings;
    $('btn-generate').onclick = generate;
    $('btn-cancel').onclick = () => { if (S.aborter) S.aborter.abort(); setBusy(false); };

    // 对比
    $('cmp-apply').onclick = applyPending;
    $('cmp-discard').onclick = discardPending;
    $('cmp-retry').onclick = () => { discardPending(); generate(); };
    initCompareInteraction();

    // 设置面板
    document.querySelectorAll('#settings [data-close]').forEach((el) => { el.onclick = closeSettings; });

    const bindField = (id, key, transform, after) => {
      const el = $(id);
      const handler = () => {
        const v = transform ? transform(el) : el.value;
        S.cfg[key] = v;
        saveCfg();
        syncRangeLabels();
        if (after) after();
        updateUI();
      };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    };

    $('set-provider').addEventListener('change', (e) => {
      S.cfg.provider = e.target.value;
      const p = C.getProvider(S.cfg.provider);
      S.cfg.baseUrl = p.baseUrl || S.cfg.baseUrl;
      const first = p.models.find((m) => m.id);
      if (first && S.cfg.provider !== 'custom') S.cfg.model = first.id;
      saveCfg(); syncSettingsUI();
      if (S.img) { rebuildViewCanvas(); draw(); }
      updateUI();
    });
    bindField('set-baseurl', 'baseUrl');
    bindField('set-apikey', 'apiKey');
    bindField('set-model', 'model', null, () => {
      if (S.img && S.rect) { snapRectToModel(); draw(); }
      fillModelList(); updateProviderTip(); updatePriceTip();
    });
    bindField('set-netmode', 'netMode', null, updateProviderTip);
    bindField('set-ctx', 'contextPct', (el) => Number(el.value));
    bindField('set-feather', 'feather', (el) => Number(el.value));
    bindField('set-cm', 'colorMatch', (el) => Number(el.value));
    bindField('set-tile', 'tile', (el) => Number(el.value));
    bindField('set-lang', 'lang');
    bindField('set-seed', 'seed');
    bindField('set-preset', 'exportPreset', null, updatePresetUI);
    bindField('set-format', 'format');
    bindField('set-quality', 'quality', (el) => Number(el.value));
    bindField('set-mosaic', 'mosaic', (el) => el.checked);
    bindField('set-upscale', 'upscaleSmall', (el) => el.checked, () => { if (S.img && S.rect) updateUI(); });
    bindField('set-mem', 'historyBudgetMB', (el) => Number(el.value), () => { enforceHistoryBudget(); });
    bindField('set-autosave', 'autoSaveSession', (el) => el.checked);
    bindField('set-price', 'priceOverride', (el) => el.value.trim());
    bindField('set-usdcny', 'usdCny', (el) => Number(el.value) || 7.1, updatePriceTip);
    $('btn-reset-spend').onclick = () => {
      S.spend = { calls: 0, usd: 0, unknownCalls: 0 };
      updatePriceTip();
      updateUI();
      toast('已重置花费统计');
    };

    $('set-maxres').addEventListener('change', (e) => {
      S.cfg.maxRes = Number(e.target.value);
      saveCfg();
      if (S.img) {
        const cur = S.img;
        setImage(cur, $('file-name').textContent);
        toast('已按新的工作分辨率重新载入');
      }
    });

    $('btn-detect').onclick = detectModels;
    $('detect-close').onclick = () => { $('detect-box').hidden = true; };

    $('btn-test').onclick = async () => {
      const st = $('test-status');
      st.textContent = '测试中…';
      st.className = 'status';
      try {
        const res = await fetch((S.cfg.baseUrl || '').replace(/\/+$/, '') + '/models', {
          headers: S.cfg.apiKey ? { Authorization: 'Bearer ' + S.cfg.apiKey } : {}
        });
        if (res.ok) { st.textContent = '✓ 连接正常'; st.className = 'status ok'; }
        else { st.textContent = '✗ HTTP ' + res.status; st.className = 'status bad'; }
      } catch (e) {
        st.textContent = '✗ ' + e.message.slice(0, 60);
        st.className = 'status bad';
      }
    };

    $('btn-whatsnew').onclick = showChangelog;

    $('btn-clear').onclick = () => {
      if (!confirm('将清空 API Key、设置和已打开的图片缓存，确定吗？')) return;
      try {
        localStorage.removeItem(LS_KEY);
        localStorage.removeItem(LS_KEY_PHOTO);
        localStorage.removeItem(LS_KEY_VER);
      } catch (e) { }
      S.cfg = loadCfg();
      syncSettingsUI(); updateUI();
      toast('已清空本地数据');
    };

    // 键盘
    window.addEventListener('keydown', (e) => {
      if (e.target.matches('input,textarea,select')) return;
      if (e.code === 'Space') { S.spaceDown = true; updateCursor({ x: 0, y: 0 }); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); exportImage(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate(); }
      if (e.key === 'Escape') {
        if (!$('compare').hidden) discardPending();
        else if (!$('gen-error').hidden) clearErrorPanel();
        else if (!$('settings').hidden) closeSettings();
      }
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') { S.spaceDown = false; updateCursor({ x: 0, y: 0 }); } });

    // 布局变化未必触发 window.resize：切工具会让底栏高度变化（画笔栏显示/隐藏），
    // 软键盘弹出/收起也一样。用 ResizeObserver 直接盯住 stage，最可靠。
    if (typeof ResizeObserver !== 'undefined') {
      let lastW = 0, lastH = 0;
      const ro = new ResizeObserver((entries) => {
        const r = entries[0] && entries[0].contentRect;
        if (!r) return;
        if (Math.abs(r.width - lastW) < 0.5 && Math.abs(r.height - lastH) < 0.5) return;
        lastW = r.width; lastH = r.height;
        resizeCanvas();
        // 视口尺寸变了，之前按旧尺寸算的 fit 视图要重算，否则图片会偏移或溢出
        if (S.docCanvas && !S.pending) fitToScreen();
        if (S.pending) { layoutCompare(); drawCompare(); }
      });
      ro.observe(stage);
      S._ro = ro;
    }

    window.addEventListener('resize', () => { resizeCanvas(); if (S.pending) { layoutCompare(); drawCompare(); } });
    window.addEventListener('orientationchange', () => setTimeout(() => { resizeCanvas(); if (S.pending) { layoutCompare(); drawCompare(); } }, 300));

    // 拖拽打开
    stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragging'); });
    stage.addEventListener('dragleave', () => stage.classList.remove('dragging'));
    stage.addEventListener('drop', async (e) => {
      e.preventDefault();
      stage.classList.remove('dragging');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) { try { await loadImageFromBlob(f, f.name); } catch (err) { toast('打开失败'); } }
    });

    // 粘贴
    window.addEventListener('paste', async (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) { try { await loadImageFromBlob(f, '粘贴的图片.png'); toast('已粘贴图片'); } catch (err) { } }
          break;
        }
      }
    });
  }

  function zoomCenter(factor) {
    const v = viewSize();
    const minS = Math.min(v.w / S.docW, v.h / S.docH) * 0.4;
    let nv = C.zoomAt(S.view, v.w / 2, v.h / 2, factor, Math.max(0.02, minS), 12);
    S.view = C.clampView(nv, S.docW, S.docH, v.w, v.h);
    draw(); updateUI();
  }

  /* ---------- 示例图 ---------- */

  function useDemoImage() {
    const w = 1600, h = 1067;
    const c = makeCanvas(w, h);
    const x = c.getContext('2d');
    // 天空
    const sky = x.createLinearGradient(0, 0, 0, h * 0.62);
    sky.addColorStop(0, '#2b5b8f');
    sky.addColorStop(0.55, '#7fa8c9');
    sky.addColorStop(1, '#e2c9a3');
    x.fillStyle = sky; x.fillRect(0, 0, w, h * 0.62);
    // 太阳
    const g = x.createRadialGradient(w * 0.72, h * 0.42, 10, w * 0.72, h * 0.42, 260);
    g.addColorStop(0, 'rgba(255,236,190,.95)');
    g.addColorStop(1, 'rgba(255,236,190,0)');
    x.fillStyle = g; x.fillRect(0, 0, w, h * 0.7);
    // 远山
    x.fillStyle = '#6d7f8c';
    x.beginPath(); x.moveTo(0, h * 0.58);
    x.lineTo(w * 0.18, h * 0.40); x.lineTo(w * 0.34, h * 0.55);
    x.lineTo(w * 0.52, h * 0.34); x.lineTo(w * 0.70, h * 0.56);
    x.lineTo(w * 0.86, h * 0.44); x.lineTo(w, h * 0.58);
    x.lineTo(w, h * 0.66); x.lineTo(0, h * 0.66); x.closePath(); x.fill();
    // 地面
    const gr = x.createLinearGradient(0, h * 0.6, 0, h);
    gr.addColorStop(0, '#5c6b4a');
    gr.addColorStop(1, '#2f3a28');
    x.fillStyle = gr; x.fillRect(0, h * 0.62, w, h * 0.38);
    // 小路
    x.fillStyle = '#8b7f66';
    x.beginPath(); x.moveTo(w * 0.44, h * 0.62); x.lineTo(w * 0.56, h * 0.62);
    x.lineTo(w * 0.78, h); x.lineTo(w * 0.22, h); x.closePath(); x.fill();
    // 树
    for (let i = 0; i < 7; i++) {
      const tx = 80 + i * 230 + (i % 3) * 30, ty = h * 0.62 + (i % 2) * 20;
      x.fillStyle = '#2a2418';
      x.fillRect(tx - 5, ty - 60, 10, 70);
      x.fillStyle = ['#3f5a33', '#48663a', '#37502d'][i % 3];
      x.beginPath(); x.arc(tx, ty - 78, 42, 0, Math.PI * 2); x.fill();
      x.beginPath(); x.arc(tx - 26, ty - 58, 30, 0, Math.PI * 2); x.fill();
      x.beginPath(); x.arc(tx + 26, ty - 58, 30, 0, Math.PI * 2); x.fill();
    }
    // 云
    x.fillStyle = 'rgba(255,255,255,.72)';
    const cloud = (cx, cy, s) => {
      x.beginPath();
      x.arc(cx, cy, 34 * s, 0, 7); x.arc(cx + 40 * s, cy + 8 * s, 26 * s, 0, 7);
      x.arc(cx - 40 * s, cy + 10 * s, 22 * s, 0, 7); x.arc(cx + 12 * s, cy - 20 * s, 24 * s, 0, 7);
      x.fill();
    };
    cloud(280, 190, 1.1); cloud(760, 140, 0.85); cloud(1240, 230, 1.0);
    // 噪点
    const id = x.getImageData(0, 0, w, h);
    for (let i = 0; i < id.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 9;
      id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n;
    }
    x.putImageData(id, 0, 0);

    c.toBlob((b) => loadImageFromBlob(b, '示例风景.jpg'), 'image/jpeg', 0.92);
  }

  /* ---------- 上次照片恢复（仅记录文件名，不存图） ---------- */

  function savePhotoRef(name) {
    try { localStorage.setItem(LS_KEY_PHOTO, JSON.stringify({ name, at: Date.now() })); } catch (e) { }
  }

  /* ============================ 会话保存与恢复 ============================ */

  let sessionSaveTimer = null;

  /**
   * 防抖保存：编辑后延迟保存，避免频繁写 localStorage 卡顿。
   * 存的是「编辑记录 + 原图」，这样进程被杀后能继续之前的工作。
   */
  function scheduleSessionSave() {
    if (S.cfg.autoSaveSession === false) return;
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = setTimeout(saveSession, 1200);
  }

  async function saveSession() {
    if (!S.img || !S.viewCanvas) return;
    try {
      // 原图存成压缩后的 dataURL（用工作分辨率的基准图，避免超大）
      const baseCanvas = S.docCanvas;
      if (!baseCanvas) return;
      const baseUrl = baseCanvas.toDataURL('image/jpeg', 0.85);

      // 编辑记录：patch 编码成 JPEG，掩膜做量化压缩
      const plan = C.planSessionPersist(S.edits, {
        maxBytes: 3 * 1024 * 1024,
        encode: (patch) => patch.toDataURL('image/jpeg', 0.82)
      });

      const payload = {
        v: 1,
        at: Date.now(),
        fileName: $('file-name').textContent || 'photo.jpg',
        base: baseUrl,
        imgW: S.imgW, imgH: S.imgH,
        docW: S.docW, docH: S.docH,
        rect: S.rect,
        strokes: S.strokes,
        dropped: plan.dropped,
        items: plan.items.map((it) => Object.assign({}, it, {
          mask: it.mask ? C.packMask(new Float32Array(it.mask)) : null,
          maskLen: it.mask ? it.mask.length : 0
        }))
      };
      localStorage.setItem(LS_KEY_SESSION, JSON.stringify(payload));
    } catch (e) {
      // 空间不足：清掉会话，避免影响正常使用
      try { localStorage.removeItem(LS_KEY_SESSION); } catch (e2) { /* ignore */ }
      console.warn('[修图台] 会话保存失败（可能空间不足）', e);
    }
  }

  /** 读取上次未完成的会话（不自动恢复，交给用户决定） */
  function readSession() {
    try {
      const raw = localStorage.getItem(LS_KEY_SESSION);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || j.v !== 1 || !j.base) return null;
      return j;
    } catch (e) { return null; }
  }

  /** 从会话数据恢复编辑状态 */
  async function restoreSession(j) {
    try {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = j.base;
      });
      // 基准图直接用它（已经是工作分辨率），避免再次解码原图
      S.img = img;
      S.imgW = j.imgW || img.width;
      S.imgH = j.imgH || img.height;
      S.docW = j.docW || img.width;
      S.docH = j.docH || img.height;
      S.meta = { exif: null, icc: null, iccIsSrgb: true, orientation: null, source: 'restored' };

      S.docCanvas = makeCanvas(S.docW, S.docH);
      S.docCtx = S.docCanvas.getContext('2d', { willReadFrequently: true });
      S.docCtx.drawImage(img, 0, 0, S.docW, S.docH);

      // 还原编辑记录
      S.edits = [];
      for (const it of (j.items || [])) {
        if (!it.patch) continue;
        const patch = await new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = rej;
          im.src = it.patch;
        });
        const pc = makeCanvas(patch.width, patch.height);
        pc.getContext('2d').drawImage(patch, 0, 0);
        S.edits.push({
          rect: it.rect,
          patch: pc,
          feather: it.feather,
          colorMatch: it.colorMatch,
          mask: it.mask ? C.unpackMask(it.mask, it.maskLen) : null
        });
      }
      S.redo = [];
      S.rect = j.rect || null;
      S.strokes = j.strokes || [];

      $('file-name').textContent = (j.fileName || 'photo.jpg') + '（已恢复）';
      $('file-meta').textContent = `${S.docW}×${S.docH} · 已恢复 ${S.edits.length} 处修改` +
        (j.dropped ? `（较早的 ${j.dropped} 次未能保存）` : '');
      $('empty').hidden = true;
      $('hud').hidden = false;
      $('btn-save').disabled = false;

      rebuildViewCanvas();
      fitToScreen();
      updateUI();
      toast('已恢复上次未完成的编辑（' + S.edits.length + ' 处修改）', 3600);
    } catch (e) {
      toast('恢复会话失败：' + (e && e.message ? e.message : e), 3600);
    }
  }

  /** 启动时提示是否恢复 */
  function offerSessionRestore() {
    const j = readSession();
    if (!j || !j.items || !j.items.length) return;
    const el = $('upgrade-bar');
    if (!el) return;
    const mins = Math.max(1, Math.round((Date.now() - (j.at || 0)) / 60000));
    el.innerHTML =
      '<div class="ub-main">' +
        '<div class="ub-title">发现未完成的编辑</div>' +
        '<div class="ub-sub">' + esc(j.fileName || '照片') + ' · ' + j.items.length +
          ' 处修改 · ' + (mins < 60 ? mins + ' 分钟前' : Math.round(mins / 60) + ' 小时前') + '</div>' +
      '</div>' +
      '<button class="ghost small" id="ub-restore">恢复</button>' +
      '<button class="tb-btn icon" id="ub-discard-session"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
    el.hidden = false;
    const r = $('ub-restore');
    if (r) r.onclick = async () => { el.hidden = true; await restoreSession(j); };
    const d = $('ub-discard-session');
    if (d) d.onclick = () => {
      el.hidden = true;
      try { localStorage.removeItem(LS_KEY_SESSION); } catch (e) { /* ignore */ }
      toast('已放弃上次的编辑');
    };
  }

  /* ============================ 故障可视化 ============================ */
  // 手机上没有控制台，「黑屏但不知道为什么」是最难排查的情况。
  // 这里把致命错误直接画到界面上，用户能截图反馈，我们也一眼看到原因。

  let fatalShown = false;
  function showFatal(where, err) {
    if (fatalShown) return;
    fatalShown = true;
    const msg = (err && (err.message || err.reason && err.reason.message)) || String(err);
    console.error('[修图台] 致命错误 @' + where, err);
    try {
      const el = document.getElementById('gen-error');
      if (!el) return;
      el.innerHTML =
        '<div class="err-head">' +
          '<svg viewBox="0 0 24 24" class="err-ico"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>' +
          '<div class="err-title">出错了（' + where + '）</div>' +
          '<button class="tb-btn icon err-close" onclick="this.closest(\'#gen-error\').hidden=true">' +
            '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="err-msg">' + String(msg).replace(/</g, '&lt;').slice(0, 300) + '</div>' +
        '<div class="err-hint">如果是导入大照片后出现，通常是手机内存不足。可以到设置里把「工作分辨率上限」调低（例如 2048），再重新导入。</div>' +
        '<div class="err-actions">' +
          '<button class="ghost small" onclick="location.reload()">重新加载</button>' +
        '</div>';
      el.hidden = false;
    } catch (e) { /* 连界面都坏了就只能靠日志 */ }
  }

  window.addEventListener('error', (e) => showFatal('运行', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => showFatal('异步', e.reason));

  /* ============================ 启动 ============================ */

  function boot() {
    S.cfg = loadCfg();
    undoStack = C.createUndoStack(100);
    refreshBgColor();
    bind();
    syncSettingsUI();
    updateUI();
    resizeCanvas();

    $('about').textContent = '修图台 v' + APP_VERSION + ' · 纯本地运行 · 照片只发往你配置的接口';
    checkUpgrade();
    // 检查是否有上次未完成的编辑（Android 后台回收很常见）
    if (S.cfg.autoSaveSession !== false) offerSessionRestore();

    // 若通过本地服务打开，探测代理是否可用
    if (location.protocol !== 'file:') {
      fetch('api/health').then((r) => r.ok ? r.json() : null).then((j) => {
        if (j && j.ok) console.log('[修图台] 本地代理可用');
      }).catch(() => { });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 供调试与自动化测试使用（暴露内部状态与刷新入口）
  window.__PS = S;
  window.__PS_API = {
    updateUI,
    draw,
    renderLayers,
    rebuildViewCanvas,
    currentEstimate,
    enforceHistoryBudget,
    fitToScreen
  };
})();
