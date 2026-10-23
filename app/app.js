/* =============================================================================
 * 枫叶修图 · 应用主体
 *  交互：框选 / 画笔掩膜 / 平移缩放 / 生成 / 对比 / 应用 / 撤销重做 / 导出
 * ========================================================================== */
(function () {
  'use strict';

  const C = window.PSCore;
  const $ = (id) => document.getElementById(id);

  /* ---------- 工具提示：只在第一次进这个工具时显示一次 ---------- */

  let hintsSeen = null;

  function loadHints() {
    if (hintsSeen) return hintsSeen;
    try {
      const raw = localStorage.getItem(LS_KEY_HINTS);
      const j = raw ? JSON.parse(raw) : null;
      hintsSeen = (j && typeof j === 'object' && Array.isArray(j.seen)) ? j.seen : [];
    } catch (e) {
      hintsSeen = [];
    }
    return hintsSeen;
  }

  function saveHints() {
    try { localStorage.setItem(LS_KEY_HINTS, JSON.stringify({ v: 1, seen: hintsSeen || [] })); }
    catch (e) { /* 空间不足不影响使用 */ }
  }

  /** 这个工具的提示是否已经显示过 */
  function hintSeen(name) {
    return loadHints().indexOf(name) >= 0;
  }

  /** 标记这个工具的提示已显示（此后不再弹） */
  function markHintSeen(name) {
    const list = loadHints();
    if (list.indexOf(name) < 0) { list.push(name); saveHints(); }
  }

  /**
   * 提示是否应该显示：第一次进这个工具才显示。
   *
   * 为什么不做成「显示几秒自动消失」：用户可能正忙着看别处，
   * 提示自己消失了他根本没读到；下次进来又要等一遍，反而更烦。
   * 「只显示一次，看到就永远不再出现」对老用户最省事。
   */
  function shouldShowHint(name) {
    return !hintSeen(name);
  }
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
    // 画笔默认「画上就是要改」（restore 语义）。
    // v3.9.2 起掩膜语义反转：没画过的地方不动，画到的地方才改。
    // 所以默认必须是"加"而不是"减"，否则一进画笔用户涂半天什么都没发生。
    brushErase: false,
    strokes: [],          // 文档坐标

    // 编辑历史
    edits: [],            // 已应用的编辑记录
    redo: [],             // 重做栈（编辑记录）

    // 历史时间线预览：预览某个历史状态时，暂存当前状态用于随时退回
    histPreview: null,    // { cursor, total } 正在预览的位置
    histStash: null,      // { edits, strokes, docVersion } 预览前的现场

    // 作品库：当前这张照片对应哪条作品记录（换图时重新生成）
    workId: null,
    workStartedAt: 0,
    library: [],          // 作品记录列表（内存态，落盘在 LS_KEY_LIBRARY）
    libraryNote: '',      // 空间不足时的提示（说明清理了什么）

    // 模型调用日志（环形缓冲，最新的在前；落盘在 LS_KEY_CALLLOG）
    callLog: [],

    // 后台生成任务表（**不落盘**）。
    // 为什么不做持久化：应用被系统杀掉时 HTTP 请求也断了，
    // 留一条「任务记录」只会让用户以为它还在跑，是更糟的谎言。
    // 每项：{ id, workId, docVersion, status, rect, patch, error, ... }
    jobs: [],
    jobSeq: 0,

    // 环境能力（启动时探测）：{ level, patches[], warn, blocking }
    compat: null,
    // 后台保活是否可用（Android 壳里才有 PSBridge）
    keepAliveSupported: false,
    keepAliveState: null, // { on, reason, note }
    updateRelease: null,  // 检测到的新版本（release 对象）
    toolbarVisible: false, // 工具栏是否展开（首页收起，编辑页展开）
    tips: {},              // 本次进入工具时是否显示提示（见 tipDecision）
    toolbarHeight: 0,      // 当前露出高度（px），用户可拖动调节
    toolbarFull: 0,        // 完全展开时的高度（px）
    // 引导线：把「构图意图」画给模型看（比文字描述准确得多）
    // 坐标是「相对选区的归一化值」0~1，这样选区移动/缩放时不用重算
    guides: [],
    guideKind: 'horizon',

    // 待确认的生成结果
    pending: null,

    // 交互
    pointers: new Map(),
    gesture: null,
    spaceDown: false,

    // 设置
    cfg: null,
    busy: false,
    busyTotal: 1,         // 本次生成共几块（保活通知要显示进度感）
    aborter: null,

    // 原图元数据（EXIF / ICC）：canvas 重绘会丢掉它们，导入时先存下来，导出时写回
    meta: null,        // { exif: Uint8Array|null, icc: Uint8Array|null, iccIsSrgb: boolean, orientation: number|null }

    // 并发控制：docVersion 在换图/改历史时递增，用来丢弃过期的生成结果；
    // genToken 用来防止重复点击生成造成多个请求并发写同一块画布。
    docVersion: 0,
    genToken: 0,

    // 打包缓存版本号：任何会让 buildSessionPayload 结果失效的改动都要 +1，
    // 否则缓存会把过期的会话数据发给「会话保存」和「作品库」两处。
    docRev: 0,

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
    upscaleSmall: true,
    historyBudgetMB: 192,      // 编辑历史内存上限（超过则降采样/丢弃最老的）
    autoSaveSession: true,     // 自动保存编辑会话，进程被杀后可恢复
    keepAlive: true,           // 后台保活：生成时钉住进程，避免切走被杀导致请求白花钱
    // 无缝融合：把模型输出对齐到周围环境（光照梯度/对比度/颗粒）。
    // 这是解决「生成结果和周围不契合」的关键手段，且不重新调用模型。
    fusion: 0.7,               // 总强度（0 = 关闭）
    // 环境契合提示词：把测出来的周围特征（亮度/冷暖/反差/光向）写进每次请求，
    // 让模型有可对照的目标。与像素级融合互补：提示词让模型尽量做对，融合兜底。
    envFit: true,
    // 自动检查更新：从 GitHub 拉取最新版本号（每 12 小时最多一次）
    autoCheckUpdate: true,
    fusionCenter: 0.35,        // 中心区域保留多少校正（0 = 中心完全不干预）
    fusionGrain: 0.6,          // 颗粒补偿强度（模型输出比真照片平滑）
    keepAliveAlways: false,    // 一直保活（长时间连续修图时有用，代价是常驻通知）
    lang: 'auto',
    seed: '',
    exportPreset: 'full',      // 导出预设（决定尺寸/质量/元数据策略）
    priceOverride: '',         // 自定义单价（美元/张），留空则用内置价格表
    usdCny: 7.1,               // 汇率（仅用于人民币参考价）
    format: 'jpeg',
    quality: 95,
    mosaic: false,
    // 导出面板记住上一次的选择。
    // 刻意与设置页的 exportPreset 分开存 —— 用户临时改一次导出格式，
    // 不应该把设置页里选的「交付预设」也改掉。
    // expPresetChosen=false 表示「还没在面板里选过」→ 首次打开跟随设置页预设。
    // 引导线：自由笔迹是否画进请求图（默认开），以及笔迹颜色
    // 工具栏高度（px）。0 = 用默认完全展开。
    // 存下来是为了「用户调好的高度不该被换图/重启重置」。
    barHeight: 0,
    // 多组供应商配置。默认空数组 —— 单组用户（大多数）看不到任何变化，
    // 设置页那张卡片只在存过配置后才显得有用。
    presets: [],
    activePreset: '',
    // 自定义快捷提示词（编辑页底部那排 chip）。
    // 空数组 = 用内置默认，不是「一条都没有」—— 升级后不该突然变空。
    quickPrompts: [],
    // 主题：auto 跟随系统 / dark / light
    theme: 'auto',
    // 画布背景：{ dataUrl, blur, dim, fit }
    bg: null,
    guideStrokeOverlay: true,
    expPresetChosen: false,
    expFormat: 'jpeg',
    expMaxSide: 0,
    expQuality: 95,
    expKeepExif: true,
    expKeepGps: true,
    expKeepIcc: true,
    expSaveWhere: 'gallery',  // 导出保存位置：gallery 相册 / downloads 下载 / ask 每次询问
    // AI 贴回后自动切到调色工具（对着同一块选区）。
    // 默认开：模型改完常常还差一点颜色，顺手调一下比重新生成省钱得多。
    // 但有人就是不想被切走工具，所以给一个关掉的开关。
    autoGrade: true
  };

  // 配置存储键。注意：这里刻意保持键名稳定 —— 覆盖安装后必须能读到旧设置，
  // 所以不能随版本改键名；需要迁移时在 loadCfg 里做字段级兼容。
  const LS_KEY = 'photoStudio.cfg.v1';
  const LS_KEY_PHOTO = 'photoStudio.photo.v1';
  const LS_KEY_VER = 'photoStudio.lastVersion';
  // 工具提示「已读过」的记录。工具提示（画笔怎么用、引导线怎么用）只在
  // 第一次进这个工具时显示一次 —— 第二次打开还弹一遍，是纯打扰。
  // 用「工具名集合」而不是单个布尔值：将来加新工具时，新工具的提示照样会显示一次。
  const LS_KEY_HINTS = 'photoStudio.hintsSeen.v1';
  const LS_KEY_SESSION = 'photoStudio.session.v1';
  // 作品库：历史上修过的每一张照片（跨天保留）。
  // 与 SESSION 的区别：SESSION 只存「当前这张图未完成的编辑」，换图即被覆盖；
  // LIBRARY 是作品清单，关掉应用、换图、隔几天都还在。
  const LS_KEY_LIBRARY = 'photoStudio.library.v1';
  // 模型调用日志：每次 API 调用的留痕（时间/模型/提示词摘要/耗时/成败/花费）。
  // 独立成一个键而不是塞进配置：日志是「可丢弃」的数据，
  // 写满了、写坏了都不该影响设置与作品库。
  const LS_KEY_CALLLOG = 'photoStudio.callLog.v1';
  // 新手教程「已看过」的标记。与工具提示（LS_KEY_HINTS）分开存：
  // 提示是「每个工具各看一次」，教程是「整个应用看一次」，
  // 混在一起会让「重置工具提示」把教程也一起重置掉（用户会莫名被教程挡住）。
  const LS_KEY_TUTORIAL = 'photoStudio.tutorialSeen.v1';
  // 版本号由 version.js（构建时从 version.json 生成）提供，避免多处手改不一致
  const APP_VERSION = (window.PS_VERSION && window.PS_VERSION.versionName) || '1.1.0';
  const CHANGELOG = (window.PS_VERSION && window.PS_VERSION.changelog) || [];

  /** 用户数据字段：升级时必须原样保留，绝不因版本变化被重置 */
  const PERSIST_KEYS = [
    'provider', 'baseUrl', 'apiKey', 'model', 'netMode',
    'contextPct', 'feather', 'colorMatch', 'maxRes',
    'lang', 'seed', 'format', 'quality', 'mosaic', 'upscaleSmall', 'exportPreset',
    'expPresetChosen', 'expFormat', 'expMaxSide', 'expQuality', 'expKeepExif', 'expKeepGps', 'expKeepIcc',
    'expSaveWhere',
    'guideStrokeOverlay', 'barHeight', 'autoGrade',
    'priceOverride', 'usdCny',
    'historyBudgetMB', 'autoSaveSession',
    'keepAlive', 'keepAliveAlways',
    'fusion', 'fusionCenter', 'fusionGrain', 'envFit', 'autoCheckUpdate',
    'theme', 'bg',
    // 多组供应商：presets 是数组（每组含 provider/baseUrl/apiKey/model），
    // activePreset 记住当前用的是哪一组（手改连接信息后可能不再指向任何一组）
    'presets', 'activePreset',
    // 自定义快捷提示词：用户自己写的，覆盖安装必须保留
    'quickPrompts'
  ];

  /**
   * 配置迁移：把老版本留下的值改成新版本的正确默认。
   *
   * 实现在 core.js（纯函数，便于单测覆盖各种版本组合）。
   * 这里只是接一下，并把改动记下来以便提示用户。
   */
  const CFG_REV = C.CFG_REV;

  function migrateCfg(c, saved) {
    const r = C.migrateCfg(c, saved);
    if (r.changed.length) lastCfgMigration = r.changed.slice();
    return r.cfg;
  }

  /** 本次启动实际迁移了哪些字段（用于首启提示，让用户知道设置被动过） */
  let lastCfgMigration = [];

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
      c.quality = clampNum(c.quality, 70, 100, DEFAULT_CFG.quality);
      // 导出面板的记忆字段：历史脏数据（比如手改 localStorage）不能把导出搞崩
      c.expMaxSide = clampNum(c.expMaxSide, 0, 16384, 0);
      c.expQuality = clampNum(c.expQuality, 60, 100, 95);
      if (!C.EXPORT_FORMATS.some((f) => f.id === c.expFormat)) c.expFormat = 'jpeg';
      // 保存位置：历史脏数据/手改 localStorage 不能让导出存到不存在的位置
      if (!C.isSaveLocation(c.expSaveWhere)) c.expSaveWhere = 'gallery';
      // 笔迹颜色：历史脏数据/手改 localStorage 不能让取色失败（退化成红色）
      // 引导线必须进入发给模型的图片：旧版本允许关闭，旧设置里可能保存了 false。
      // 强制恢复为 true，避免「屏幕上看得到、模型图片里看不到」的致命分叉。
      c.guideStrokeOverlay = true;
      c.barHeight = clampNum(c.barHeight, 0, 2000, 0);
      c.expPresetChosen = c.expPresetChosen === true;
      // 多组供应商：存档可能是脏数据（手改、旧版、写了一半），
      // 必须先规范化再用 —— 否则设置页渲染时拿 p.name 会直接报错。
      c.presets = C.normalizePresets(c.presets);
      // 画布背景：脏数据会让 canvas 画出黑块，必须规范化
      c.bg = C.normalizeBg(c.bg);
      // 自定义快捷提示词：存档可能是脏数据（手改 localStorage、写了一半）。
      // 不清洗的话，带换行的条目会把编辑页那排 chip 撑成两行、把工具栏顶歪。
      c.quickPrompts = C.normalizeQuickPrompts(c.quickPrompts);
      if (typeof c.activePreset !== 'string') c.activePreset = '';
      // activePreset 指向一组已不存在的配置时清掉，
      // 免得下拉框选中一个空项、界面上看不出当前在用哪组。
      if (c.activePreset && !c.presets.some((p) => p.id === c.activePreset)) {
        c.activePreset = '';
      }
      if (!c.baseUrl && c.provider) {
        const p = C.getProvider(c.provider);
        if (p && p.baseUrl) c.baseUrl = p.baseUrl;
      }
      // 最后跑迁移：会按需覆盖上面读回来的旧值
      migrateCfg(c, saved);
    } else {
      c.__cfgRev = CFG_REV;
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
      // 记录迁移版本：不写的话下次启动会再迁移一遍，
      // 把用户手动重新打开的设置又覆盖掉。
      out.__cfgRev = Number(S.cfg.__cfgRev) || CFG_REV;
      localStorage.setItem(LS_KEY, JSON.stringify(out));
    } catch (e) { /* 隐私模式下可能不可用，忽略 */ }
  }

  /* ============ 滑块：只允许拖动滑块头，点轨道不改值 ============ */

  /**
   * 让一个 `<input type=range>` 只能通过**拖动滑块头**改值。
   *
   * 为什么需要：原生滑块的默认行为是「点轨道哪里，值就跳到那里」。
   * 设置页里每个滑块上下都是别的设置项，想拖动时手指稍微偏一点落在轨道上，
   * 值就瞬间跳到 0 或 100 —— 比如「融合强度」被点成 0，用户毫无察觉，
   * 下次生成才发现效果不对。手机上尤其容易发生（手指比鼠标粗得多）。
   *
   * 做法：在 `pointerdown` 里算出滑块头中心的屏幕坐标，
   * 指针离它太远就 `preventDefault()` 掉这次按下 ——
   * 浏览器收不到这次按下，就不会执行「跳到点击位置」，值保持不变。
   *
   * 刻意**不**拦的几种情况：
   *   - 键盘方向键（完全没走 pointerdown，天然可用）
   *   - 程序赋值 `el.value = ...`（同上）
   *   - 从滑块头上按下的拖动（距离判定在内，正常跟随手指）
   *   - 鼠标滚轮 / 触摸板（走 wheel，不走 pointerdown）
   *
   * 为什么用 pointerdown 而不是 mousedown：安卓 WebView 里触摸会先合成
   * pointerdown，用 mousedown 会漏掉触摸；而且 pointerdown 能一并覆盖
   * 鼠标、触屏、触控笔三种输入。
   *
   * @param {HTMLInputElement} el  必须是 type=range
   * @returns {Function} 解绑函数（测试与热更新用）
   */
  function thumbOnlySlider(el) {
    if (!el || el.type !== 'range') return () => { };
    const handler = (e) => {
      // 只处理主按键（右键/中键不该影响滑块）
      if (e.button !== undefined && e.button !== 0) return;
      // 触摸事件没有 pointerX 时用 touches[0]，保证老内核也能算出位置
      const px = (e.clientX !== undefined && e.clientX !== null)
        ? e.clientX
        : (e.touches && e.touches[0] ? e.touches[0].clientX : null);
      if (px === null || px === undefined) return;

      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      // 量不到宽度（元素隐藏 / 内核不做布局）时**不拦**：
      // 拦了会让滑块彻底拖不动，比误触更糟
      if (!r || !(r.width > 0)) return;

      const plan = C.planSliderHit({
        value: el.value, min: el.min, max: el.max,
        rectLeft: r.left, rectWidth: r.width,
        thumbWidth: sliderThumbWidth(el),
        pointerX: px
      });
      // preventDefault 要在**按下时**生效才能阻止跳值；
      // 只 stopPropagation 是没用的 —— 跳值是浏览器对元素的默认动作
      if (plan.block) e.preventDefault();
    };
    el.addEventListener('pointerdown', handler, { passive: false });
    // 老内核没有 PointerEvent（Chrome < 55）：退回 touchstart/mousedown，
    // 否则滑块在这类设备上又变回「点轨道跳值」
    const legacy = (e) => {
      const px = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : null);
      if (px === null || px === undefined) return;
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r || !(r.width > 0)) return;
      const plan = C.planSliderHit({
        value: el.value, min: el.min, max: el.max,
        rectLeft: r.left, rectWidth: r.width,
        thumbWidth: sliderThumbWidth(el),
        pointerX: px
      });
      if (plan.block) e.preventDefault();
    };
    if (typeof window.PointerEvent === 'undefined') {
      el.addEventListener('touchstart', legacy, { passive: false });
      el.addEventListener('mousedown', legacy);
    }
    el.__psThumbOnly = true;
    return () => {
      el.removeEventListener('pointerdown', handler);
      el.removeEventListener('touchstart', legacy);
      el.removeEventListener('mousedown', legacy);
      el.__psThumbOnly = false;
    };
  }

  /**
   * 读滑块头的 CSS 宽度（px）。
   *
   * 从 `--ps-thumb` 自定义属性读，而不是写死常量 ——
   * 样式改了宽度而 JS 不知道，判定就会偏：偏小 → 点滑块头边缘被误拦（拖不动），
   * 偏大 → 点轨道靠近滑块头的位置仍会跳值。
   * 读不到（老内核 / jsdom 未加载样式）时回落到 core 里的常量。
   */
  function sliderThumbWidth(el) {
    try {
      const v = getComputedStyle(el).getPropertyValue('--ps-thumb');
      const n = parseFloat(v);
      if (Number.isFinite(n) && n > 0) return n;
    } catch (e) { /* 读不到就用兜底 */ }
    return C.SLIDER_THUMB_PX;
  }

  /**
   * 给页面上**所有** `<input type=range>` 套上「只能拖滑块头」。
   *
   * 用统一入口而不是逐个写死 id：将来加新滑块（比如调色面板里的）忘了接线，
   * 就等于漏了一个误触点。这里一次性覆盖全部，新滑块自动受保护。
   *
   * 分两次调用（bind 时 + 动态滑块创建后），已处理过的靠 `__psThumbOnly` 跳过。
   */
  function applyThumbOnlySliders(root) {
    const scope = root || document;
    const list = scope.querySelectorAll ? scope.querySelectorAll('input[type=range]') : [];
    for (const el of list) {
      if (!el.__psThumbOnly) thumbOnlySlider(el);
    }
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
        // 迁移动过设置就要说出来 —— 悄悄改用户配置是很糟糕的体验
        const migNote = lastCfgMigration.length
          ? '<div class="ub-sub" style="color:#ffd591">' +
            '设置已按新版本自动调整（旧版本的分块功能已移除，现在整块一次生成）。</div>'
          : '';
        bar.innerHTML =
          '<div class="ub-main">' +
            '<div class="ub-title">已更新到 v' + APP_VERSION + '</div>' +
            '<div class="ub-sub">' + keep + '</div>' +
            migNote +
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

  /** 刷新设置里的「检查更新」状态文案 */
  function refreshUpdateStateText(override) {
    const el = $('update-state');
    if (!el) return;
    if (override) { el.textContent = override; return; }
    const st = readUpdateState();
    if (!st.lastCheck) { el.textContent = '从 GitHub 获取最新版本'; return; }
    const d = new Date(st.lastCheck);
    const p = (n) => String(n).padStart(2, '0');
    const when = p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    el.textContent = st.latest
      ? '上次检查 ' + when + ' · 远程最新 ' + st.latest
      : '上次检查 ' + when;
  }

  /** 展示本次更新内容 */
  function showChangelog() {
    const el = $('gen-error');
    if (!el) return;
    el.innerHTML =
      '<div class="err-head">' +
        '<div class="err-title" style="color:#cfe4ff">枫叶修图 v' + APP_VERSION + ' 更新内容</div>' +
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

  /* ============================ 检查更新 ============================ */

  /**
   * GitHub 仓库地址与 API 端点。
   *
   * 注意：**不能用 `/releases/latest`** —— 那个接口按「创建时间」判定最新，
   * 而我们事后补发过旧版本的 Release（补齐 v1.8.0~v2.2.0 时它们的时间戳
   * 变成了最新），导致它返回 v2.2.0。所以这里拉完整列表，按版本号自己挑。
   */
  const GH_OWNER_REPO = 'qianc7001-coder/photo-studio';
  const GH_RELEASES_API = 'https://api.github.com/repos/' + GH_OWNER_REPO + '/releases?per_page=100';
  const GH_RELEASES_PAGE = 'https://github.com/' + GH_OWNER_REPO + '/releases';
  const LS_KEY_UPDATE = 'photoStudio.updateCheck.v1';

  /** 读取更新检查状态（上次检查时间、失败次数、忽略的版本） */
  function readUpdateState() {
    try {
      const raw = localStorage.getItem(LS_KEY_UPDATE);
      if (!raw) return { lastCheck: 0, failCount: 0, skipped: '', latest: '', notes: '' };
      const j = JSON.parse(raw);
      return {
        lastCheck: Number(j.lastCheck) || 0,
        failCount: Number(j.failCount) || 0,
        skipped: typeof j.skipped === 'string' ? j.skipped : '',
        latest: typeof j.latest === 'string' ? j.latest : '',
        notes: typeof j.notes === 'string' ? j.notes : ''
      };
    } catch (e) {
      return { lastCheck: 0, failCount: 0, skipped: '', latest: '', notes: '' };
    }
  }

  function writeUpdateState(st) {
    try { localStorage.setItem(LS_KEY_UPDATE, JSON.stringify(st)); } catch (e) { /* ignore */ }
  }

  /**
   * 请求 GitHub 拉取版本列表。
   *
   * 走本地代理（同源，无跨域问题）；浏览器直开时 GitHub API 本身允许跨域
   * （`access-control-allow-origin: *`），所以直接 fetch 也能用。
   */
  /**
   * 拉取 GitHub 的 Release 列表。
   *
   * 两个坑（都真实踩过）：
   *
   * 1. **必须用 GET**。本地代理默认用 POST 转发（生图接口都是 POST），
   *    但 GitHub 的 releases 列表用 POST 请求会返回 401 Requires authentication，
   *    表现为「应用内检查更新永远失败，但用浏览器打开仓库明明是好的」。
   *    所以这里显式带上 X-Target-Method: GET。
   *
   * 2. **代理失败必须回退直连**。生图路径（callModel）一直有这个回退，
   *    检查更新这里当初漏了 —— 代理一旦不可用（老版本 APK 的代理不支持 GET、
   *    或代理被安全策略挡住），检查更新就彻底不可用。
   */
  async function fetchReleases() {
    const viaProxy = async () => {
      const r = await fetch('api/generate', {
        method: 'POST',
        headers: {
          'X-Target-Url': GH_RELEASES_API,
          'X-Target-Method': 'GET',
          'X-Target-Content-Type': 'application/json',
          // GitHub 的 API 要求 User-Agent，代理转发时必须显式带上；
          // 浏览器直连时由浏览器自己加，所以只在代理路径需要
          'X-Target-User-Agent': 'PhotoStudio-Android',
          'X-Target-Accept': 'application/vnd.github+json'
        },
        body: '{}'
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      // 代理自身出错时会回 200 + __proxyError，必须当成失败，
      // 否则下面 pickLatestRelease 会拿到一个对象、静默返回「没有可用版本」
      if (j && j.__proxyError) throw new Error(j.__proxyError);
      return j;
    };
    const viaDirect = async () => {
      const r = await fetch(GH_RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    };

    if (location.protocol === 'file:') return viaDirect();
    const mode = S.cfg.netMode;
    if (mode === 'direct') return viaDirect();
    if (mode === 'proxy') return viaProxy();
    // auto：先代理，失败再直连
    try { return await viaProxy(); }
    catch (e) { return await viaDirect(); }
  }

  /**
   * 检查更新。
   * @param {boolean} force 用户手动点「检查更新」时为 true（忽略时间间隔）
   */
  async function checkUpdate(force) {
    const st = readUpdateState();
    const plan = C.planUpdateCheck({
      now: Date.now(), lastCheck: st.lastCheck,
      force: !!force, failCount: st.failCount
    });
    if (!plan.should) return { skipped: true, reason: plan.reason };

    let list;
    try {
      list = await fetchReleases();
      st.failCount = 0;                       // 成功就清零退避
    } catch (e) {
      st.failCount = Math.min(4, st.failCount + 1);
      st.lastCheck = Date.now();
      writeUpdateState(st);
      if (force) toast('检查更新失败：' + (e && e.message ? e.message : '网络不通'));
      return { ok: false, error: String((e && e.message) || e) };
    }

    const best = C.pickLatestRelease(list);
    st.lastCheck = Date.now();
    if (!best) {
      writeUpdateState(st);
      if (force) toast('没有找到可用的版本信息');
      return { ok: false, error: 'no-release' };
    }

    const up = C.planUpdate({
      current: APP_VERSION, latest: best.tag_name, skipped: st.skipped
    });
    st.latest = best.tag_name;
    st.notes = String(best.body || '').slice(0, 4000);
    writeUpdateState(st);

    if (force) {
      if (up.hasUpdate) toast('发现新版本 ' + best.tag_name, 2600);
      else if (up.reason === 'skipped') toast('已忽略该版本（当前 v' + APP_VERSION + '）', 3000);
      else toast('已是最新版本 v' + APP_VERSION, 2400);
    }
    if (up.hasUpdate) showUpdateBar(best);
    return { ok: true, hasUpdate: up.hasUpdate, latest: best.tag_name, release: best };
  }

  /** 显示「有新版本」提示条 */
  function showUpdateBar(release) {
    const bar = $('upgrade-bar');
    if (!bar) return;
    const apk = C.pickApkAsset(release);
    const ver = String(release.tag_name || '').replace(/^v/i, '');
    S.updateRelease = release;
    bar.innerHTML =
      '<div class="ub-main">' +
        '<div class="ub-title">发现新版本 v' + esc(ver) + '</div>' +
        '<div class="ub-sub">当前 v' + esc(APP_VERSION) +
          (apk ? ' · 点「立即更新」下载安装包' : ' · 请在浏览器中打开下载页') + '</div>' +
      '</div>' +
      (apk ? '<button class="primary small" id="ub-update">立即更新</button>' : '') +
      '<button class="ghost small" id="ub-notes">更新内容</button>' +
      '<button class="tb-btn icon" id="ub-later" title="忽略此版本">' +
        '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
      '</button>';
    bar.hidden = false;
    const up = $('ub-update');
    if (up) up.onclick = () => startUpdate(release);
    const nt = $('ub-notes');
    if (nt) nt.onclick = () => showReleaseNotes(release);
    const lt = $('ub-later');
    if (lt) lt.onclick = () => {
      bar.hidden = true;
      // 只忽略「这一个版本」—— 出了更新版本还要提示，
      // 否则用户忽略一次就永远收不到更新了
      const s2 = readUpdateState();
      s2.skipped = release.tag_name;
      writeUpdateState(s2);
      toast('已忽略 v' + ver + '，下次有更新会再提示', 3200);
    };
  }

  /** 展示某个 release 的更新内容 */
  function showReleaseNotes(release) {
    const el = $('gen-error');
    if (!el) return;
    const ver = String(release.tag_name || '').replace(/^v/i, '');
    // release.body 是 GitHub 的 Markdown，这里做最小处理：按行转列表项
    const lines = String(release.body || '').split('\n')
      .map((x) => x.trim())
      .filter((x) => x && x !== '---' && !/^#{1,6}\s/.test(x))
      .map((x) => '<li>' + esc(x.replace(/^[-*]\s*/, '')) + '</li>')
      .join('');
    el.innerHTML =
      '<div class="err-head">' +
        '<div class="err-title" style="color:#cfe4ff">枫叶修图 v' + esc(ver) + ' 更新内容</div>' +
        '<button class="tb-btn icon err-close" id="err-close">' +
          '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
        '</button>' +
      '</div>' +
      '<ul class="whatsnew">' + (lines || '<li>（该版本没有填写更新说明）</li>') + '</ul>' +
      '<div class="err-actions">' +
        '<button class="ghost small" id="err-page">在浏览器打开</button>' +
        '<button class="primary small" id="err-ok">知道了</button>' +
      '</div>';
    el.hidden = false;
    el.style.borderColor = 'rgba(77,163,255,.4)';
    const close = () => { el.hidden = true; el.style.borderColor = ''; };
    const c = $('err-close'); if (c) c.onclick = close;
    const k = $('err-ok'); if (k) k.onclick = close;
    const pg = $('err-page');
    if (pg) pg.onclick = () => { openExternal(GH_RELEASES_PAGE); close(); };
  }

  /**
   * 用系统浏览器打开外链。
   *
   * 安卓壳里 WebView 会拦截 http(s) 跳转交给系统浏览器；
   * 浏览器里点一个 target=_blank 的链接即可。
   */
  function openExternal(url) {
    try {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { a.remove(); } catch (e) { /* ignore */ } }, 0);
    } catch (e) {
      try { window.open(url, '_blank'); } catch (e2) { /* ignore */ }
    }
  }

  /**
   * 下载并安装新版本。
   *
   * 安卓壳里交给原生下载（能申请「安装未知应用」权限、能调起安装器）；
   * 浏览器里退化成打开下载地址，由浏览器自己处理。
   */
  async function startUpdate(release) {
    const apk = C.pickApkAsset(release);
    const ver = String(release.tag_name || '').replace(/^v/i, '');
    if (!apk) { openExternal(GH_RELEASES_PAGE); return; }

    const b = bridge();
    if (b && b.downloadAndInstall) {
      toast('正在下载 v' + ver + '…', 4000);
      try {
        b.downloadAndInstall(apk.browser_download_url, '枫叶修图-v' + ver + '.apk');
      } catch (e) {
        openExternal(apk.browser_download_url);
      }
      return;
    }
    openExternal(apk.browser_download_url);
    toast('已开始下载，完成后请手动安装', 3600);
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
  /**
   * 生成成功后清空提示词输入框。
   *
   * 为什么需要：摄影师是一张一张连着修的，上一次的描述留在框里，
   * 下次生成要么忘了改（白花一次钱），要么得先全选删掉。清掉更顺手。
   *
   * 但绝不能无脑清 —— 只在「框里还是那次生成用的原文」时才清：
   *   - 生成期间用户改了字（说明已经在写下一条要求了）→ 不动，别打断他
   *   - 失败/取消 → 根本不调这个函数（调用点只放在成功分支）
   *
   * @param {string} usedRaw 那次生成时输入框里的原文
   */
  function clearPromptIfUnchanged(usedRaw) {
    const el = $('prompt');
    if (!el) return;
    const now = String(el.value || '');
    const used = String(usedRaw == null ? '' : usedRaw);
    // 用户已经在写新的了：保留，不回退他的输入
    if (now !== used) return;
    if (!now) return;           // 本来就是空的，没什么可清
    el.value = '';
    // 清空后通知一次，让依赖提示词的界面（成本预估之类）跟着刷新。
    // 用 dispatch 而不是直接调内部函数：和用户手动输入走完全一样的路径，
    // 不会漏掉任何一个监听者。
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) { /* 极老内核不支持 Event 构造，忽略即可 */ }
  }

  /* ============================ 参考图 ============================
   *
   * 用户可以在「加参考图」里放几张贴图，请求时和原图一起发给模型，
   * 让它「照这个改」（换衣服、换姿势、参考风格）。
   *
   * 三个必须处理好的点：
   *   1) 体积：参考图可能是相机直出的大图，原样发会让请求变慢甚至被拒。
   *      统一压到长边 1280、JPEG 0.85（对「照着改」这个用途完全够）。
   *   2) 数量：不同模型能收的张数不同（Kontext 一张都收不了）。
   *      超出的部分要**明确告诉用户**，不能静默丢掉。
   *   3) 生命周期：参考图属于「这一次生成」，换图/回首页必须清掉 ——
   *      否则下次修别的照片会莫名带上上一次的参考图。
   */

  /** 当前挂着的参考图：{ dataUrl, thumb, name } */
  let refImages = [];

  /**
   * 本次请求带了几张参考图（供「请求自检」面板显示）。
   * 声明必须在这里 —— prepareJob 里会写它，而 prepareJob 在文件更后面；
   * 用 let 声明在下面会撞上暂时性死区（ReferenceError），
   * 而且只在「确实加了参考图」时才触发，很难在开发时发现。
   */
  let lastRefNote = '';

  /** 参考图压缩后的长边上限（对「照着改」够用，又能压住体积） */
  const REF_MAX_SIDE = 1280;

  /** 把一张 File 压成 base64 的小图 */
  async function readRefImage(file) {
    const blob = file;
    let bmp;
    try {
      bmp = await decodeToWorkSize(blob, REF_MAX_SIDE);
    } catch (e) {
      return null;
    }
    const w = bmp.width, h = bmp.height;
    const scale = Math.min(1, REF_MAX_SIDE / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const c = makeCanvas(cw, ch);
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(bmp, 0, 0, cw, ch);
    return {
      dataUrl: canvasToDataUrl(c, 'image/jpeg', 0.85),
      thumb: canvasToDataUrl(c, 'image/jpeg', 0.6),
      name: file.name || '参考图'
    };
  }

  /** 当前模型能收几张参考图 */
  function refLimit() {
    const cap = C.refCapability(S.cfg.model, S.cfg.provider);
    return cap;
  }

  /** 把参考图列表画到界面上 */
  function renderRefImages() {
    const list = $('ref-list');
    const note = $('ref-note');
    const cap = refLimit();
    if (!list) return;
    list.innerHTML = '';
    refImages.forEach((r, i) => {
      const box = document.createElement('div');
      box.className = 'ref-thumb';
      const img = document.createElement('img');
      img.src = r.thumb || r.dataUrl;
      img.alt = r.name || ('参考图 ' + (i + 1));
      box.appendChild(img);
      const del = document.createElement('button');
      del.className = 'ref-del';
      del.type = 'button';
      del.textContent = '×';
      del.setAttribute('aria-label', '移除这张参考图');
      del.onclick = () => {
        refImages.splice(i, 1);
        renderRefImages();
      };
      box.appendChild(del);
      list.appendChild(box);
    });
    // 说明：能不能加、能加几张，必须提前说清楚。
    // 等用户加了 3 张才发现只发出去 1 张，等于骗他。
    if (note) {
      if (cap.max <= 0) {
        note.hidden = false;
        note.textContent = '当前模型不支持参考图' +
          (/kontext/.test(String(S.cfg.model).toLowerCase()) ? '（FLUX Kontext 只能收一张原图）' : '') +
          '，换一个模型才能用。';
      } else if (refImages.length === 0) {
        note.hidden = true;
      } else if (refImages.length > cap.max) {
        note.hidden = false;
        note.textContent = '这个模型最多收 ' + cap.max + ' 张参考图，' +
          '多出的 ' + (refImages.length - cap.max) + ' 张不会发出去。';
      } else {
        note.hidden = true;
      }
    }
    if ($('btn-add-ref')) {
      $('btn-add-ref').disabled = cap.max <= 0 || refImages.length >= C.REF_MAX;
    }
  }

  /** 加一批参考图（多选） */
  async function addRefImages(files) {
    const cap = refLimit();
    if (cap.max <= 0) {
      toast('当前模型不支持参考图，先在设置里换一个模型', 3200);
      return;
    }
    const arr = Array.prototype.slice.call(files || []);
    if (!arr.length) return;
    let added = 0;
    for (const f of arr) {
      if (refImages.length >= C.REF_MAX) break;
      if (!/^image\//.test(f.type || '')) continue;
      const r = await readRefImage(f);
      if (r) { refImages.push(r); added++; }
    }
    renderRefImages();
    if (added) toast('已加 ' + added + ' 张参考图（会一起发给模型）', 2600);
  }

  /** 清空参考图（换图/回首页时调用） */
  function clearRefImages() {
    if (!refImages.length) return;
    refImages = [];
    renderRefImages();
  }

  /* ============================ 主题 ============================
   *
   * 只做一件事：把 html[data-theme] 设成真正要用的那套。
   * 所有颜色都在 CSS 变量里（见 style.css 开头），所以这里不用碰任何样式。
   *
   * 「跟随系统」必须**实时**响应系统切换，不能只在启动时读一次 ——
   * 很多人设了「日落到日出自动深色」，应用一直开着的话，
   * 不监听就永远是白天那套。
   */

  /** 系统当前是不是深色 */
  function systemPrefersDark() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {
      return true;   // 判断不了就按深色（应用默认观感）
    }
  }

  /** 把主题应用到 DOM */
  function applyTheme() {
    const want = C.resolveTheme(S.cfg.theme, systemPrefersDark());
    const el = document.documentElement;
    if (el.getAttribute('data-theme') !== want) el.setAttribute('data-theme', want);
    // 同步状态栏颜色（安卓 WebView 里由原生桥处理；浏览器里忽略）
    const b = bridge();
    if (b && b.setStatusBarTheme) {
      try { b.setStatusBarTheme(want === 'light'); } catch (e) { /* ignore */ }
    }
    // 界面上的主题选择器要反映当前档位（不是「实际用的」那套，
    // 而是用户选的那档：选了「跟随系统」就该显示「跟随系统」）
    const cur = C.getTheme(S.cfg.theme).id;
    document.querySelectorAll('#theme-chips [data-theme-id]').forEach((b2) => {
      b2.classList.toggle('on', b2.dataset.themeId === cur);
    });
    S.themeResolved = want;
    // 画布四周的背景色是从 CSS 变量读的，主题变了必须重新读一遍并重绘，
    // 否则会出现「界面变浅了，但照片周围还是深色」这种割裂感。
    try {
      refreshBgColor();
      if (ctx) draw();
    } catch (e) { /* 画布还没就绪时忽略 */ }
    return want;
  }

  /** 用户在设置里改主题 */
  function setTheme(id) {
    S.cfg.theme = C.getTheme(id).id;
    saveCfg();
    applyTheme();
    toast('主题：' + C.getTheme(S.cfg.theme).zh, 1800);
  }

  /** 渲染主题选择器（只在设置页里，很小的一个 chips） */
  function renderThemeChips() {
    const box = $('theme-chips');
    if (!box) return;
    box.innerHTML = '';
    for (const th of C.THEMES) {
      const b = document.createElement('button');
      b.className = 'chip' + (th.id === C.getTheme(S.cfg.theme).id ? ' on' : '');
      b.dataset.themeId = th.id;
      b.textContent = th.zh;
      b.title = th.hint || '';
      b.onclick = () => setTheme(th.id);
      box.appendChild(b);
    }
  }

  /** 监听系统深浅色变化（只在「跟随系统」时需要真的响应） */
  function watchSystemTheme() {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => {
        // 用户选了明确的深/浅就不受系统影响，但还是要重算一次
        // （切回 auto 时能立刻跟上，不用等下次启动）
        applyTheme();
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);   // 老内核
    } catch (e) { /* 不支持就算了，启动时读一次足够 */ }
  }

  function setBusy(on, title, sub) {
    S.busy = on;
    $('busy').hidden = !on;
    if (title) $('busy-title').textContent = title;
    $('busy-sub').textContent = sub || '';
    // 有照片就能生成：没有框选时按整张图处理（见 effectiveRect）
    $('btn-generate').disabled = on || !S.img || !S.docCanvas;
    // 生成状态变化直接驱动保活：这是「正在花钱」的时刻，最需要钉住进程
    syncKeepAlive();
  }

  /* ============================ 后台保活 ============================ */

  /**
   * 原生桥（Android 壳里才有）。
   *
   * 浏览器 / PWA 里没有这个对象，所有调用都要先判断存在性 ——
   * 否则纯网页打开时会直接报错白屏。
   */
  function bridge() {
    try {
      return (typeof window !== 'undefined' && window.PSBridge) ? window.PSBridge : null;
    } catch (e) {
      return null;
    }
  }

  /** 当前环境是否支持保活 */
  function keepAliveSupported() {
    const b = bridge();
    if (!b) return false;
    try {
      return b.supported() === true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 按当前状态同步保活开关。
   *
   * 调用点：生成开始/结束、设置里切换常驻、启动时。
   * 内部把「生成中」和「用户常驻」两个来源合并后交给原生，
   * 由 core.planKeepAlive 决定最终该不该开（纯逻辑，有单测覆盖）。
   */
  function syncKeepAlive() {
    const b = bridge();
    // 每次都实时探测，不用启动时的缓存值：
    // 页面可能在桥就绪前就 boot 了（WebView 里 addJavascriptInterface 的
    // 时序不受我们控制），缓存一次会永久误判为「不支持」。
    S.keepAliveSupported = keepAliveSupported();
    if (!b) {
      S.keepAliveState = C.planKeepAlive({ supported: false });
      updateKeepAliveUI();
      return S.keepAliveState;
    }
    // 保活看的是「有没有生成在跑」，**不能只看 busy**。
    // 后台生成任务正是这个区别的由来：用户回首页时 busy 是 false
    // （首页不该弹「正在生成…」遮罩），但任务还在跑、还要钉住进程 ——
    // 只看 busy 的话，用户一离开照片保活就关了，切后台照样被杀，
    // 请求断了钱白花。这恰恰是后台生成最需要防的事。
    const hasRunningJobs = S.jobs.some((j) => j && j.status === 'running');
    const keepNeeded = !!S.busy || hasRunningJobs;
    const plan = C.planKeepAlive({
      busy: keepNeeded,
      userAlwaysOn: S.cfg.keepAliveAlways === true,
      supported: true,
      enabled: S.cfg.keepAlive !== false
    });
    S.keepAliveState = plan;
    try {
      b.setKeepAlive(keepNeeded, S.cfg.keepAliveAlways === true, keepAliveText(plan));
    } catch (e) {
      // 桥调用失败不该影响修图
    }
    updateKeepAliveUI();
    return plan;
  }

  /** 保活通知上显示的文案 */
  function keepAliveText(plan) {
    if (!plan || !plan.on) return '';
    if (plan.reason === 'always') return '常驻保活中，修图不会被系统中断';
    if (S.busy && S.busyTotal > 1) return '正在生成（共 ' + S.busyTotal + ' 块），切走或锁屏不会中断';
    return '正在生成，切走或锁屏不会中断';
  }

  /** 生成完成：请原生发一条「好了」的通知，用户切走后也能知道 */
  function notifyGenDone(text) {
    const b = bridge();
    if (!b) return;
    try { b.notifyDone(text || '生成完成，点开查看效果'); } catch (e) { /* ignore */ }
  }

  /**
   * 生成任务开始时确保有通知权限。
   *
   * 为什么放在这里：权限被拒绝过一次之后，系统不会再自动弹框；
   * 用户也未必会主动去设置里开。这里不发弹窗（系统不会二次弹），
   * 只是让原生侧在「还没授权」时再走一次申请流程，
   * 并在真发不出通知时把原因记下来供自查面板显示。
   */
  function ensureNotifyReady() {
    const b = bridge();
    if (!b) return;
    try { b.requestNotificationPermission(); } catch (e) { /* ignore */ }
  }

  /**
   * 把「能不能发通知」如实刷到设置界面。
   *
   * 为什么必须有：Android 13+ 没授权时通知会被系统**静默丢弃** ——
   * 应用看起来一切正常，就是不弹通知。用户会认为是应用坏了。
   * 这里直接问原生要真实状态，并给出一个能跳过去的按钮。
   */
  function updateNotifyUI() {
    const el = $('notify-state');
    const btn = $('btn-notify-settings');
    if (!el) return;
    const b = bridge();
    let state = 0;
    if (b && b.notificationState) {
      try { state = Number(b.notificationState()); } catch (e) { state = 0; }
    }
    if (state === 1) {
      el.textContent = '通知未授权 —— 生成完成/失败时收不到提醒';
      el.className = 'ka-state ka-warn';
      if (btn) btn.hidden = false;
    } else if (state === 2) {
      el.textContent = '系统里已关闭本应用的通知 —— 收不到提醒';
      el.className = 'ka-state ka-warn';
      if (btn) btn.hidden = false;
    } else if (!b) {
      el.textContent = '浏览器里没有系统通知（用 APK 才有）';
      el.className = 'ka-state ka-muted';
      if (btn) btn.hidden = true;
    } else {
      el.textContent = '通知正常 · 生成完成和失败都会提醒';
      el.className = 'ka-state ka-ok';
      if (btn) btn.hidden = true;
    }
  }

  /** 把保活状态刷到设置界面 */
  function updateKeepAliveUI() {
    const el = $('ka-state');
    if (!el) return;
    // 同样实时探测：桥晚一点就绪时，界面要能自己纠正过来
    S.keepAliveSupported = keepAliveSupported();
    const d = C.describeKeepAlive(S.keepAliveState, {
      supported: S.keepAliveSupported,
      enabled: S.cfg.keepAlive !== false,
      userAlwaysOn: S.cfg.keepAliveAlways === true
    });
    el.textContent = d.text;
    el.className = 'ka-state ka-' + d.tone;
    const row = $('ka-always-row');
    if (row) row.hidden = !d.canAlways;
    // 电池按钮包在 st-row-plain 里（系统设置风格），所以切换整行的显隐 ——
    // 只切按钮本身会留下一行空白
    const batt = $('ka-battery');
    const battRow = $('ka-battery-row');
    if (batt) {
      // 电池优化白名单：各家 OEM 的后台限制都靠这一步放宽
      let optimized = false;
      const b = bridge();
      if (b && S.keepAliveSupported) {
        try { optimized = b.batteryOptimized() === true; } catch (e) { /* ignore */ }
      }
      batt.hidden = !optimized;
      if (battRow) battRow.hidden = !optimized;
    }
    // 顺带刷新通知状态：权限可能刚在系统设置里被改过
    updateNotifyUI();
  }

  /** 引导用户把应用加入电池优化白名单 */
  function askIgnoreBattery() {
    const b = bridge();
    if (!b) return;
    try {
      b.requestIgnoreBattery();
      toast('若系统弹出提示，请选择「允许」', 3200);
    } catch (e) {
      toast('无法打开系统设置，请手动到「电池」里允许后台运行', 3600);
    }
  }

  /** 申请通知权限（Android 13+ 需要，否则保活通知看不到） */
  function askNotificationPermission() {
    const b = bridge();
    if (!b) return;
    try { b.requestNotificationPermission(); } catch (e) { /* ignore */ }
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
  async function decodeToWorkSize(blob, maxSide, orientation) {
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
      //
      // 但这一步有个致命细节：**文件头里的宽高是未旋转的**。
      // 手机竖拍的 JPEG 像素数据是横的（4032×3024）配一个 Orientation=6，
      // 而 createImageBitmap 默认会按 EXIF 把它转成 3024×4032。
      // 若还按 4032×3024 算缩放，传进去的 resizeWidth/Height 就反了 ——
      // 竖图会被拉成横图，用户看到的就是「导入之后直接被压扁」。
      // 所以先判断方向是否需要互换宽高。
      const swapped = C.isSwappedOrientation(orientation);
      const realW = swapped ? srcH : srcW;
      const realH = swapped ? srcW : srcH;
      if (maxSide > 0 && realW > 0 && Math.max(realW, realH) > maxSide) {
        const k = maxSide / Math.max(realW, realH);
        const tw = Math.max(1, Math.round(realW * k));
        const th = Math.max(1, Math.round(realH * k));
        try {
          // imageOrientation:'from-image' 明确要求按 EXIF 转正，
          // 这样 resize 的宽高就是**转正之后**的宽高，两者一致。
          const bmp = await createImageBitmap(blob, {
            resizeWidth: tw, resizeHeight: th, resizeQuality: 'high',
            imageOrientation: 'from-image'
          });
          return bmp;
        } catch (e) { /* 老内核不认 imageOrientation，落到下面的不带选项重载 */ }
        try {
          return await createImageBitmap(blob, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
        } catch (e) { /* 落到全尺寸解码 */ }
      }
      try {
        return await createImageBitmap(blob, { imageOrientation: 'from-image' });
      } catch (e) { /* 老内核不认这个选项，落到不带选项的重载 */ }
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
    // 元数据要在**解码之前**取，因为解码缩放后 Orientation 就没意义了；
    // 而解码又需要它来判断宽高要不要互换（竖拍的旋转标记）。
    S.meta = await captureMetadata(blob);
    let bmp;
    try {
      bmp = await decodeToWorkSize(blob, maxSide, S.meta && S.meta.orientation);
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
      console.warn('[枫叶修图] 读取元数据失败（不影响使用）', e);
      return out;
    }
  }

  function setImage(src, name) {
    // 兜底：万一某条路径还是给出了超大位图，这里强制按工作尺寸绘制，
    // 绝不把全尺寸图塞进 canvas（否则仍然会 OOM）
    const hardMax = 8192;
    // 换图时**只中止当前这张照片的任务**，其它照片的后台任务继续跑。
    // 这是「一张图进 AI 生图后可以放在后台处理下一张」的核心：
    // 旧实现无条件 abort 全局请求，等于换图就把上一张的钱白花了。
    // 当前这张的请求必须中止 —— 它的结果已经无处可落（文档被卸载了），
    // 而且留着会让它跑完才发现白干。
    cancelJobsForCurrentDoc('换图');
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
    S.guides = [];       // 引导线跟着选区走，换图必须清掉
    // 参考图也属于「这一次生成」，换图必须清 ——
    // 否则下次修另一张照片时会莫名带上上一次的参考图，而用户完全没发现。
    clearRefImages();
    S.pending = null;
    updateGuideBadge();
    S.docVersion++;      // 旧文档的生成结果一律作废
    S.docRev++;          // 换图 → 打包缓存失效
    // 换图 = 换一件作品：生成新的作品 id。
    // 旧的那条**留在作品库里**（这正是「昨天修的今天还看得到」的关键），
    // 只是不再接收后续编辑。
    S.workId = null;
    S.workStartedAt = 0;
    try { localStorage.removeItem(LS_KEY_SESSION); } catch (e) { /* ignore */ }
    // 进入编辑页：收起首页、展开工具栏
    renderHome();
    syncToolbar();

    $('file-name').textContent = name;
    const metaBits = [];
    if (S.meta && S.meta.exif) metaBits.push('拍摄信息');
    if (S.meta && S.meta.icc) metaBits.push(S.meta.iccIsSrgb ? 'sRGB' : '广色域');
    if (S.meta && S.meta.orientation && S.meta.orientation !== 1) metaBits.push('已校正旋转');
    updatePresetUI();
    $('file-meta').textContent = `${S.imgW}×${S.imgH}` +
      (scale < 1 ? ` → 工作 ${S.docW}×${S.docH}` : '') +
      (metaBits.length ? ` · 含${metaBits.join(' / ')}` : '');
    // 首页空状态由 renderHome 统一管理（上面已调用），这里不再单独操作
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
  /**
   * 评估一个图层「贴得好不好」。
   *
   * 做法：把图层**排除掉**再合成一遍，然后比较「该图层边界内外」的差异。
   * 这样得到的分数反映的是「这个图层本身带来的色差/亮度台阶」，
   * 而不是原图本来就有的差异。
   *
   * 结果会缓存（按图层参数 + 文档版本），因为 renderLayers 每次都会调用。
   */
  let seamCache = new Map();

  function assessLayerSeam(edit) {
    if (!edit || !edit.patch || !S.docCanvas) return null;
    const L = C.normalizeLayer(edit);
    if (!L.enabled || L.opacity <= 0.01) return null;
    const key = [S.docRev, edit.createdAt, edit.rect.x, edit.rect.y, edit.rect.w, edit.rect.h,
      Math.round(L.feather), Math.round(L.colorMatch * 100), Math.round(L.opacity * 100),
      L.fusion == null ? 'auto' : Math.round(L.fusion * 100)].join('|');
    if (seamCache.has(key)) return seamCache.get(key);

    let result = null;
    try {
      const r = edit.rect;
      // 把整图当前状态读出来（不含本图层），作为「周围环境」的参考
      const full = S.docCtx.getImageData(0, 0, S.docCanvas.width, S.docCanvas.height);
      // 反向抵消：把该图层先去掉，得到「没有这一块」的底图
      const base = makeCanvas(r.w, r.h);
      const bx = base.getContext('2d', { willReadFrequently: true });
      bx.drawImage(S.docCanvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      // patch 缩放到选区尺寸
      let patchSrc = edit.patch;
      if (patchSrc.width !== r.w || patchSrc.height !== r.h) {
        const tmp = makeCanvas(r.w, r.h);
        tmp.getContext('2d').drawImage(patchSrc, 0, 0, patchSrc.width, patchSrc.height, 0, 0, r.w, r.h);
        patchSrc = tmp;
      }
      const src = patchSrc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, r.w, r.h);
      result = C.assessSeam({
        src,
        rect: { x: r.x, y: r.y, w: r.w, h: r.h },
        dst: full,
        dstFull: full,
        dstOffset: { x: 0, y: 0 },
        ring: 6
      });
    } catch (e) {
      result = null;      // 取不到像素（画布被污染等）时不影响界面
    }
    // 缓存不要无限增长
    if (seamCache.size > 60) seamCache.clear();
    seamCache.set(key, result);
    return result;
  }

  /**
   * 把「调色图层」合成进目标画布。
   *
   * 与 compositeEditInto 的模型生成块路径分开，因为两者要的东西完全不同：
   *   - 生成块：有 patch，要缩放/羽化/色彩匹配/无缝融合（都是为「外来像素」设计的）
   *   - 调色：  没有 patch，只是在**已有像素**上按参数重算色调
   * 硬塞进同一条路径会让两边都变复杂，而且调色根本不需要色彩匹配
   * （它不引入外来色差，只是把现有颜色整体挪一挪）。
   *
   * 边界过渡用 featherMask（和画笔掩膜同一个函数），
   * 这样调色的边缘和「贴回」的边缘是同一套过渡，视觉上一致。
   *
   * @param {CanvasRenderingContext2D} targetCtx 目标上下文（已含前面所有编辑的结果）
   * @param {object} edit  调色图层 { rect, grade, feather, mask, opacity, enabled }
   * @param {ImageData} id 已经取好的选区像素（避免重复 getImageData）
   */
  function applyGradeInto(targetCtx, edit, id) {
    const r = edit.rect;
    const L = C.normalizeLayer(edit);
    if (!L.enabled || L.opacity <= 0) return;

    // 权重图 = 羽化 × 画笔掩膜 × 图层不透明度。
    // 复用 layerAlphaMap：它就是为这件事写的，且已被别处验证过。
    //
    // 整张图调色时把羽化按 0 处理：羽化会让最外一圈权重趋近 0，
    // 结果是「整张图调色，但四周留了一圈没调」——一圈明显的框。
    // 整张图没有「边缘要过渡到哪里」这个问题，所以不需要羽化。
    const whole = C.isWholeRect(r, S.docW, S.docH);
    const alpha = C.layerAlphaMap(whole ? Object.assign({}, edit, { feather: 0 }) : edit, r.w, r.h);

    // gradePixels 不修改入参（纯函数），返回新的像素
    const graded = C.gradePixels(id, edit.grade, { mask: alpha });
    targetCtx.putImageData(new ImageData(graded.data, r.w, r.h), r.x, r.y);
  }

  function compositeEditInto(targetCtx, edit) {
    const r = edit.rect;
    const id = targetCtx.getImageData(r.x, r.y, r.w, r.h);
    // 图层开关：关闭时完全不合成（用于对比「改之前」）
    const L = C.normalizeLayer(edit);
    if (!L.enabled) return;

    // 调色图层（grade）：没有 patch，只有一组色调参数。
    // 走单独一条路径 —— 它不需要 patch 缩放、色彩匹配、无缝融合那套
    // （那些都是为「模型生成块」设计的），只是把选区内的像素按参数重算一遍。
    if (edit.grade && !edit.patch) {
      applyGradeInto(targetCtx, edit, id);
      return;
    }

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
    const needFull = edit.colorMatch > 0 || edit.fusion > 0 ||
      (edit.fusion == null && S.cfg.fusion > 0);
    if (needFull && targetCtx.canvas) {
      try {
        fullPix = targetCtx.getImageData(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
      } catch (e) { fullPix = null; }
    }
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
    // 无缝融合：把生成块对齐到周围环境（光照梯度/对比度/颗粒）。
    // 这一步是免费的 —— 纯像素运算，不重新调用模型，所以可以随时调、随时看效果。
    const fuseStrength = C.clamp01(edit.fusion != null ? edit.fusion : (S.cfg.fusion != null ? S.cfg.fusion : 0.7));
    C.compositeFeathered(id, src, { x: 0, y: 0, w: r.w, h: r.h }, {
      // 显式告知「这次改的是不是整张图」：整张图没有周围环境，
      // 羽化/色彩匹配/无缝融合全都无依据（详见 core 里的说明）
      whole: C.isWholeRect(r, S.docW, S.docH),
      feather: edit.feather,
      colorMatch: {
        ring: 8,
        ramp: Math.max(6, edit.feather || 8),
        strength: edit.colorMatch
      },
      fusion: fuseStrength > 0 ? {
        strength: fuseStrength,
        ring: 10,
        // 中心保留多少校正：0 = 中心完全不干预（改动原样保留）
        //                  1 = 中心也完全对齐（最贴合，但可能削弱用户的改动）
        centerFloor: S.cfg.fusionCenter != null ? S.cfg.fusionCenter : 0.35,
        grain: S.cfg.fusionGrain != null ? S.cfg.fusionGrain : 0.6,
        seed: 7
      } : null,
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
      // 必须同步修正撤销栈里的索引：命令存的是**索引**而非对象引用，
      // 图层前移后不修正，撤销就会作用到错误的图层上（删错图）。
      if (undoStack) undoStack.adjustForDrop(plan.drop);
    }
    // 对指定条目做降采样（边长减半，内存降到 1/4）
    for (const idx of plan.downscale) {
      const e = S.edits[idx];
      // 调色图层没有 patch，跳过（它的内存占用是 0，本来就不需要降采样）
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

  /* ---------- 画布背景（纯色 / 自定义图 + 模糊 + 压暗） ----------
   *
   * 为什么要统一成一个函数：这段「先铺背景」的逻辑在三个地方各写了一遍
   * （draw / drawGradeThumb / goHome），以前是纯色填充所以重复也无所谓；
   * 现在要画图 + 模糊 + 压暗，三份实现必然会走偏 ——
   * 比如回到首页时忘了压暗，用户会看到背景忽然变亮。
   */

  /** 缓存解码好的背景图，避免每帧重新解码 */
  let bgImage = null;
  let bgImageKey = '';

  /** 取背景图（带缓存）。没有背景图返回 null */
  function getBgImage() {
    const bg = S.cfg.bg || {};
    const url = bg.dataUrl || '';
    if (!url) { bgImage = null; bgImageKey = ''; return null; }
    if (bgImage && bgImageKey === url) return bgImage;
    bgImageKey = url;
    bgImage = new Image();
    bgImage.onload = () => { try { draw(); } catch (e) { /* ignore */ } };
    bgImage.onerror = () => { bgImage = null; bgImageKey = ''; };
    bgImage.src = url;
    // decode() 比 onload 更可靠（onload 可能在元素已可用时才触发，
    // 而这里每帧都要判断"能不能画"）。不支持 decode 的老内核退回 naturalWidth。
    if (bgImage.complete && bgImage.naturalWidth) return bgImage;
    // 还没解码好：先返回 null（这一帧画纯色），解码完 onload 会重绘。
    // 注意**不能**在这里 await —— paintBackground 在每帧的同步路径里。
    return null;
  }

  /**
   * 把背景铺满视口。抽出来是因为三处都要用，且逻辑不简单。
   * @param {CanvasRenderingContext2D} c
   * @param {number} vw 视口宽（CSS px）
   * @param {number} vh
   */
  function paintBackground(c, vw, vh) {
    if (!c) return;
    const bg = C.normalizeBg(S.cfg.bg);
    const img = getBgImage();
    // 没有背景图 → 用主题色（原来的行为）
    if (!img) {
      c.fillStyle = bgColor;
      c.fillRect(0, 0, vw, vh);
      return;
    }
    const plan = C.planBgDraw(vw, vh, img.naturalWidth, img.naturalHeight, bg.fit);
    if (!plan) {
      c.fillStyle = bgColor;
      c.fillRect(0, 0, vw, vh);
      return;
    }
    // 先铺底色：cover 模式下背景图会被放大，边缘可能出现缝隙，
    // 不铺底会露出透明（看起来像闪白）
    c.fillStyle = bgColor;
    c.fillRect(0, 0, vw, vh);

    // 模糊用 canvas filter，实时生效，不用预生成模糊图。
    // 注意 filter 必须在这张图上设完再还原，否则会影响后面的绘画。
    try {
      if (bg.blur > 0) c.filter = 'blur(' + bg.blur + 'px)';
      // 模糊会把边缘吸黑/透明，稍微放大一点点盖住
      const grow = bg.blur > 0 ? bg.blur * 2 : 0;
      c.drawImage(img, plan.x - grow, plan.y - grow, plan.w + grow * 2, plan.h + grow * 2);
    } catch (e) {
      // 老内核不支持 filter：退化成不模糊也要把图画出来
      try { c.drawImage(img, plan.x, plan.y, plan.w, plan.h); } catch (e2) { /* ignore */ }
    } finally {
      try { c.filter = 'none'; } catch (e3) { /* ignore */ }
    }

    // 压暗：亮背景会把照片衬得发灰，垫一层黑让照片始终是焦点
    const a = C.bgScrimAlpha(bg.dim);
    if (a > 0) {
      c.fillStyle = 'rgba(0,0,0,' + a.toFixed(3) + ')';
      c.fillRect(0, 0, vw, vh);
    }
  }

  /** 把背景设置刷到设置界面 */
  function syncBgUI() {
    const bg = C.normalizeBg(S.cfg.bg);
    const has = !!bg.dataUrl;
    if ($('bg-state')) {
      $('bg-state').textContent = has
        ? ('已设置' + (bg.blur > 0 ? ' · 模糊 ' + Math.round(bg.blur) : ''))
        : '默认（主题色）';
    }
    if ($('btn-bg-clear')) $('btn-bg-clear').hidden = !has;
    // 没设背景时，模糊/压暗/铺法都没有意义 —— 藏起来，别让人调了没反应
    for (const id of ['bg-blur-row', 'bg-dim-row', 'bg-fit-row']) {
      if ($(id)) $(id).hidden = !has;
    }
    if ($('set-bg-blur')) {
      $('set-bg-blur').value = String(Math.round(bg.blur));
      if ($('bg-blur-val')) $('bg-blur-val').textContent = String(Math.round(bg.blur));
    }
    if ($('set-bg-dim')) {
      $('set-bg-dim').value = String(Math.round(bg.dim));
      if ($('bg-dim-val')) $('bg-dim-val').textContent = String(Math.round(bg.dim));
    }
    const chips = $('bg-fit-chips');
    if (chips) {
      chips.innerHTML = '';
      for (const f of [{ id: 'cover', zh: '铺满' }, { id: 'contain', zh: '完整显示' }]) {
        const b = document.createElement('button');
        b.className = 'chip' + (f.id === bg.fit ? ' on' : '');
        b.textContent = f.zh;
        b.onclick = () => {
          const n = C.normalizeBg(S.cfg.bg);
          n.fit = f.id;
          S.cfg.bg = n;
          saveCfg();
          syncBgUI();
          draw();
        };
        chips.appendChild(b);
      }
    }
  }

  /** 导入背景图（压到长边上限再存，避免大图拖慢绘制） */
  async function loadBgImage(file) {
    if (!file) return;
    try {
      const bmp = await decodeToWorkSize(file, C.BG_MAX_SIDE);
      const w = bmp.width, h = bmp.height;
      const scale = Math.min(1, C.BG_MAX_SIDE / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const c = makeCanvas(cw, ch);
      c.getContext('2d').drawImage(bmp, 0, 0, cw, ch);
      const n = C.normalizeBg(S.cfg.bg);
      n.dataUrl = canvasToDataUrl(c, 'image/jpeg', 0.85);
      S.cfg.bg = n;
      // 换图后缓存必须失效，否则还画着上一张
      bgImage = null; bgImageKey = '';
      saveCfg();
      syncBgUI();
      draw();
      toast('背景已设置', 2000);
    } catch (e) {
      toast('这张图打不开，换一张试试', 3200);
    }
  }

  /** 恢复默认背景（纯主题色） */
  function clearBg() {
    S.cfg.bg = C.normalizeBg({});
    bgImage = null; bgImageKey = '';
    saveCfg();
    syncBgUI();
    draw();
    toast('已恢复默认背景', 1800);
  }

  function draw() {
    if (!ctx) return;
    const v = viewSize();
    ctx.clearRect(0, 0, v.w, v.h);
    paintBackground(ctx, v.w, v.h);

    if (!S.viewCanvas) return;
    const r = C.imageRectToScreen({ x: 0, y: 0, w: S.docW, h: S.docH }, S.view);
    ctx.imageSmoothingEnabled = S.view.scale < 1;
    ctx.imageSmoothingQuality = 'high';

    // 长按对比：画原图（docCanvas = 导入时那张，不含任何编辑），
    // 并且**跳过**下面的选区/笔迹/引导线 —— 对比时要看的是干净的原始画面，
    // 叠一堆辅助线反而看不清。
    if (longPressActive && S.docCanvas) {
      ctx.drawImage(S.docCanvas, r.x, r.y, r.w, r.h);
      drawOriginalBadge(r);
      return;
    }

    ctx.drawImage(S.viewCanvas, r.x, r.y, r.w, r.h);

    // 画笔掩膜预览
    if (S.mode === 'brush' && S.rect && S.strokes.length) {
      drawMaskOverlay();
    }

    // 引导线：只要存在就画出来 —— 它会进提示词，用户必须随时看得见。
    // 非引导线模式下画淡一点，避免和选区抢注意力。
    if (S.guides.length) drawGuides(S.mode !== 'guide');

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

  /** 长按对比时右上角的小标签，让用户知道"现在看的是原图" */
  function drawOriginalBadge(r) {
    const label = '原图';
    ctx.save();
    ctx.font = '600 13px system-ui, -apple-system, sans-serif';
    const tw = ctx.measureText(label).width;
    const padX = 10, padY = 6;
    const bw = tw + padX * 2;
    const bh = 13 + padY * 2;
    const bx = Math.min(r.x + r.w - bw - 8, viewSize().w - bw - 8);
    const by = Math.max(8, r.y + 8);
    ctx.fillStyle = 'rgba(12,14,18,.82)';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 7);
      ctx.fill();
    } else {
      ctx.fillRect(bx, by, bw, bh);
    }
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + padX, by + bh / 2);
    ctx.restore();
  }

  let maskCache = null, maskCacheKey = '';
  // 增量栅格化的持久状态：
  //   maskBuf        已画好的掩膜（Float32Array，长度 = 选区像素数）
  //   maskDone       每一笔**已经画进去**的点数（用来判断"只追加了新的"）
  //   maskRgbaCache  掩膜转好的 RGBA（缓存，避免每帧重算 70ms）
  let maskBuf = null, maskBufW = 0, maskBufH = 0, maskBufRectKey = '';
  let maskDone = [];
  let maskRgbaCache = null;
  let maskRgbaW = 0, maskRgbaH = 0;
  /** 这次要刷新的像素范围（null = 无变化） */
  let maskDirtyBox = null;
  /** 是否要求下一次绘图做全量重算（撤销/清空/换选区时置 true） */
  let maskNeedFull = true;
  /** 这次要把哪一块上传到离屏画布（null = 整块） */
  let maskPutBox = null;
  // 画笔是热路径：每移动一次手指都会重算掩膜。这里复用离屏画布与缓冲，
  // 避免每帧新建 canvas / ImageData（大选区下这是主要卡顿来源）。
  let maskCanvas = null, maskCanvasKey = '';
  let maskRaf = 0;

  /** 笔迹按文档坐标保存，这里转换成矩形局部坐标后栅格化 */
  /**
   * 在图片坐标处点一下 → 自动圈住那里的物体。
   *
   * 取的是 **docCanvas（不含已应用的编辑）** 而不是 viewCanvas：
   * 用户想圈的是"照片里那个东西"，已应用的贴回结果不应该影响形状判断。
   * 代价很小（只在点击时读一次），不必为此纠结。
   */
  function autoSelectAt(ip) {
    if (!S.docCanvas) { toast('先打开一张照片'); return; }
    const x = Math.round(ip.x), y = Math.round(ip.y);
    if (x < 0 || y < 0 || x >= S.docW || y >= S.docH) return;

    // 只在点击附近取一小块来跑算法？不行 —— 物体可能比附近大。
    // 但整张读一次在 3072×2048 上是 25MB，每次点击都读太贵。
    // 折中：读整张（点一下而已，用户不会连点几十次）；
    // 若将来觉得卡，可改成"以点击为中心的 2× 视野"。
    const data = (function () {
      try {
        const ctx2 = S.docCanvas.getContext('2d', { willReadFrequently: true });
        return ctx2.getImageData(0, 0, S.docW, S.docH);
      } catch (e) {
        return null;
      }
    })();
    if (!data) { toast('读不到画面像素，换普通框选试试'); return; }

    const tol = Number($('auto-tol') ? $('auto-tol').value : C.AUTO_SELECT_TOLERANCE) || C.AUTO_SELECT_TOLERANCE;
    const r = C.autoSelectRegion(data, x, y, { tolerance: tol });
    if (!r) {
      toast('这里没圈出物体，换个位置点，或把容差调大一点', 3600);
      return;
    }
    S.rect = r;
    // 换了选区 → 笔迹和引导线都失效（它们存的是相对选区的坐标）
    S.strokes = [];
    S.guides = [];
    invalidateMask();
    updateGuideBadge();
    updateUI();
    draw();
    toast('已圈住（' + r.w + '×' + r.h + '），可以用生成或调色', 2600);
  }

  function maskFromStrokes(rect) {
    // 掩膜语义（v3.9.2 起）：**1 = 要改，0 = 不动**。
    //
    // 和以前正好相反。以前是「默认整块都改，涂过的地方保护起来」，
    // 用户反馈那样反直觉：他想「只改我画的地方」。
    // 现在 initial=0 —— 没画过的地方一律 0（不动），
    // 画到的地方才被抬起来（要改）。
    //
    // 注意：没有笔迹时 maskFromStrokes 根本不会被调用
    // （调用处是 S.strokes.length ? maskFromStrokes(rect) : null），
    // 传 null 表示「整块都改」。所以「不画 = 改整块」依然成立。
    const local = S.strokes.map((s) => ({
      mode: s.mode,
      radius: s.radius,
      points: s.points.map((p) => ({ x: p.x - rect.x, y: p.y - rect.y }))
    }));
    return C.strokesToMask(local, rect.w, rect.h, { initial: 0 });
  }

  /** 请求重绘掩膜：合并同一帧内的多次调用 */
  function scheduleMaskRedraw() {
    if (maskRaf) return;
    maskRaf = requestAnimationFrame(() => {
      maskRaf = 0;
      draw();
    });
  }

  /* ============================ 引导线 ============================ */

  /**
   * 绘制引导线。
   *
   * 视觉设计：用醒目的青色 + 端点圆点 + 类型标签，
   * 与选区（蓝色虚线）和画笔（灰色）区分开，一眼能认出。
   */
  function drawGuides(dim) {
    // 没有框选时按整张图定位（见 effectiveRect）：引导线存在就必须画出来，
    // 它会画进请求图，用户得随时看得见自己画的线
    const rect = effectiveRect();
    if (!rect || !S.guides.length) return;
    const sr = C.imageRectToScreen(rect, S.view);

    ctx.save();
    if (dim) ctx.globalAlpha = 0.42;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 0; i < S.guides.length; i++) {
      const g = S.guides[i];
      // 颜色按序号取（第 1 条红、第 2 条青…），和请求图、提示词用的是同一个函数 ——
      // 三处只要有一处各算各的，就会出现「屏幕上是青色、提示词说红色」的致命错位
      const c = C.colorOfGuide(g, i);
      const lineColor = c.hex;
      // 归一化坐标 → 屏幕坐标
      const x1 = sr.x + g.x1 * sr.w, y1 = sr.y + g.y1 * sr.h;
      const x2 = sr.x + g.x2 * sr.w, y2 = sr.y + g.y2 * sr.h;
      const free = C.isFreehandGuide(g);

      // 外描边（深色）保证在任何底图上都看得清：
      // 纯色线画在同色区域上等于没画（红发上画红线）
      const stroke = (lw) => {
        ctx.strokeStyle = 'rgba(0,0,0,.55)';
        ctx.lineWidth = lw + 3;
        ctx.beginPath();
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        ctx.stroke();
      };

      if (free && g.points && g.points.length >= 2) {
        const path = () => {
          ctx.beginPath();
          ctx.moveTo(sr.x + g.points[0].x * sr.w, sr.y + g.points[0].y * sr.h);
          for (let k = 1; k < g.points.length; k++) {
            ctx.lineTo(sr.x + g.points[k].x * sr.w, sr.y + g.points[k].y * sr.h);
          }
        };
        ctx.strokeStyle = 'rgba(0,0,0,.55)';
        ctx.lineWidth = 6.5;
        path(); ctx.stroke();
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 3.5;
        path(); ctx.stroke();
      } else {
        // 两类都是实线：虚线在缩放后会显得断断续续，而颜色已经足够区分不同线
        stroke(2.5);
      }

      // 端点（自由笔迹不画端点圆点：头发走向不需要「起点终点」，
      // 圆点还会被模型误当成画面元素）
      if (!free) {
        for (const [px, py] of [[x1, y1], [x2, y2]]) {
          ctx.beginPath();
          ctx.arc(px, py, 5.5, 0, Math.PI * 2);
          ctx.fillStyle = lineColor;
          ctx.fill();
          ctx.strokeStyle = '#0b1014';
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
      }

      // 标签：显示**序号**，而不是类型名。
      // 现在只有两类，类型名区分不了「第 2 条线」和「第 3 条线」；
      // 而序号正好对应提示词里的「第 N 条线（颜色）」，用户能对上号。
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      ctx.font = '600 11px -apple-system, "PingFang SC", sans-serif';
      const label = String(i + 1);
      const tw = ctx.measureText(label).width;
      const bx = mx - tw / 2 - 6, by = my - 21;
      ctx.fillStyle = 'rgba(11,16,20,.82)';
      ctx.beginPath();
      const rr = 5;
      ctx.moveTo(bx + rr, by);
      ctx.lineTo(bx + tw + 12 - rr, by);
      ctx.quadraticCurveTo(bx + tw + 12, by, bx + tw + 12, by + rr);
      ctx.lineTo(bx + tw + 12, by + 16 - rr);
      ctx.quadraticCurveTo(bx + tw + 12, by + 16, bx + tw + 12 - rr, by + 16);
      ctx.lineTo(bx + rr, by + 16);
      ctx.quadraticCurveTo(bx, by + 16, bx, by + 16 - rr);
      ctx.lineTo(bx, by + rr);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = lineColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(label, bx + 6, by + 3);
    }
    ctx.restore();
  }

  /** 把屏幕坐标换算成「相对选区的归一化坐标」 */
  function screenToGuideNorm(p) {
    // 没有框选时按整张图归一化（见 effectiveRect）——
    // 引导线在整图上也能画，坐标基准必须是整张图
    const rect = effectiveRect();
    if (!rect) return { x: 0.5, y: 0.5 };
    const ip = C.screenToImage(p, S.view);
    return {
      x: Math.max(0, Math.min(1, (ip.x - rect.x) / Math.max(1, rect.w))),
      y: Math.max(0, Math.min(1, (ip.y - rect.y) / Math.max(1, rect.h)))
    };
  }

  /** 更新引导线数量角标 */
  function updateGuideBadge() {
    const b = $('guide-count');
    if (!b) return;
    const n = S.guides.length;
    b.textContent = String(n);
    b.hidden = n === 0;
  }

  function clearGuides() {
    if (!S.guides.length) return;
    S.guides = [];
    updateGuideBadge();
    scheduleSessionSave();   // 清空也要落盘，否则重开会把线"复活"
    draw();
    toast('已清空引导线');
  }

  /* ============================ 基础调色 ============================ */

  /**
   * 调色工具：对**框选区域**做色调微调（曝光/对比度/饱和度/色温/色调）。
   *
   * 为什么单独做一个工具而不是塞进「修改记录」的参数区：
   *   - 修改记录里的参数（强度/羽化/色彩匹配/融合）是**接缝技术参数**，
   *     作用是「让生成块融入原图」，不是用户的创作意图；
   *   - 调色是**创作意图**（我想要暖一点、想要淡一点），
   *     它应该能独立于任何一次生成使用 —— 打开一张没生成过的照片也能调。
   *
   * 交互：拖滑块即时预览（走 viewCanvas，不写历史），点「应用调色」才记一条。
   * 这样拖一次滑块不会产生上百条撤销记录（和图层参数滑块是同一个考虑）。
   */
  let gradeDraft = null;   // 当前未应用的调色参数（null = 尚未初始化）

  /** 取当前草稿（没有就按全零建一个） */
  function currentGradeDraft() {
    if (!gradeDraft) gradeDraft = C.emptyGrade();
    return gradeDraft;
  }

  /**
   * 渲染调色滑块。
   *
   * 按 C.GRADE_PARAMS 生成，不写死五个滑块 ——
   * 将来在 core 里加一个参数（比如「清晰度」），界面自动就有了。
   */
  function renderGradeSliders() {
    const box = $('grade-sliders');
    if (!box) return;
    const g = currentGradeDraft();
    box.innerHTML = '';
    let lastGroup = '';
    for (const p of C.GRADE_PARAMS) {
      // 分组小标题：12 个滑块平铺会让人找不到东西，按「明暗 / 颜色 / 质感」分段
      if (p.group && p.group !== lastGroup) {
        lastGroup = p.group;
        const grp = C.GRADE_GROUPS.find((x) => x.id === p.group);
        if (grp) {
          const gh = document.createElement('div');
          gh.className = 'grade-group';
          gh.textContent = grp.zh;
          box.appendChild(gh);
        }
      }
      const row = document.createElement('div');
      row.className = 'grade-row' + (g[p.key] ? ' on' : '');
      row.dataset.key = p.key;

      const l = document.createElement('span');
      l.className = 'gl';
      l.textContent = p.zh;
      l.title = p.hint || '';

      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(p.min); input.max = String(p.max);
      input.step = '1';
      input.value = String(g[p.key]);
      input.dataset.grade = p.key;
      input.title = (p.hint || '') + '（0 = 不变）';

      const v = document.createElement('b');
      v.className = 'gv';
      v.textContent = fmtGradeVal(g[p.key]);

      input.oninput = () => {
        const nv = Number(input.value);
        currentGradeDraft()[p.key] = nv;
        v.textContent = fmtGradeVal(nv);
        row.classList.toggle('on', nv !== 0);
        // 拖动中：跑「低分辨率 + 节流」的预览。
        // 全质量预览一张 3072×2048 要一秒多，每动一格滑块跑一次会让低端机
        // 直接卡死（手指在动、画面不动）。见 previewGradeFast 的说明。
        previewGradeFast();
      };
      // 松手/离开：补一张全质量预览，让用户看到最终效果
      input.onchange = () => { previewGradeSoon(); };

      row.appendChild(l); row.appendChild(input); row.appendChild(v);
      box.appendChild(row);
      // 与其它滑块一致：只能拖滑块头，点轨道不跳值
      // （调色滑块特别容易误触：五个滑块紧挨着，归零就是「这次调色白做了」）
      thumbOnlySlider(input);
    }
    updateGradeNote();
  }

  /** 数值显示：0 显示成「0」而不是「+0」，正数带 + 号 */
  function fmtGradeVal(v) {
    const n = Math.round(Number(v) || 0);
    return n > 0 ? '+' + n : String(n);
  }

  /** 更新底部提示：这一组参数会做什么 */
  function updateGradeNote() {
    const el = $('grade-note');
    if (!el) return;
    const g = currentGradeDraft();
    el.textContent = C.isGradeEmpty(g)
      ? '还没有调整'
      : C.describeGrade(g);
  }

  /**
   * 实时预览：把调色草稿临时合成到 viewCanvas 上（不写 S.edits、不记撤销）。
   *
   * 做法是「从 docCanvas + 已应用编辑重建，再叠一层临时调色」——
   * 这样拖滑块来回调时不会累积（每次都是干净的一遍）。
   */
  function previewGrade() {
    if (!S.docCanvas) return;
    // 没有框选 = 整张图（见 effectiveRect）
    const rect = effectiveRect();
    if (!rect) return;
    rebuildViewCanvas();          // 干净底子（doc + 已应用编辑）
    const g = currentGradeDraft();
    if (C.isGradeEmpty(g)) { draw(); return; }
    // 用与「应用」完全相同的参数合成，保证预览与结果是同一个东西
    const draftEdit = makeGradeEdit(rect, g);
    compositeEditInto(S.viewCtx, draftEdit);
    draw();
  }

  /* ============================================================================
   * 拖动中的调色预览：降采样 + 节流
   *
   * 为什么非这样不可：
   *   全质量预览一张 3072×2048 要做
   *     权重图 ~105ms + 逐像素调色 ~1430ms + 重建全部图层
   *   一次接近 1.5 秒，而且是**同步**的 —— 手指在拖、画面完全不动，
   *   低端机上表现就是「滑块卡死」。拖十次就是十几秒白等。
   *
   * 做法：
   *   1) 拖动中把画布缩到长边 <= PREVIEW_MAX 再算（默认 720）。
   *      要处理的像素从 630 万降到 ~35 万，快近 20 倍；
   *      缩略图上根本看不出和全质量的区别，但手感完全不同。
   *   2) 用 requestAnimationFrame 合并同一帧内的多次 input，
   *      拖得再快也只算一次/帧，不会排队堆积。
   *   3) 松手后（onchange）再补一张全质量预览 —— 最终看到的仍是准确效果。
   *
   * 刻意**不改像素数学**：只是把同样的 gradePixels 跑在更小的图上，
   * 再放大绘制。调色结果在小图上视觉一致，而「应用」时走的仍是全分辨率、
   * 全质量的老路径，所以成片质量一分不差。
   * ========================================================================== */

  /** 拖动中预览的长边上限（px）。够看清颜色变化，又不至于卡。 */
  // 拖动中的预览长边。
  // 720 时单帧仍要 75~115ms（超过 60fps 的 16.7ms 预算，手感一顿一顿），
  // 降到 480 后像素量再降一半，配合"拖动中跳过清晰度/暗角"能进 30ms 以内。
  // 480 在手机上看起来和 720 差别很小 —— 拖动只是看"往哪个方向变"，
  // 松手会立刻补一张全质量。
  const PREVIEW_MAX = 480;

  let previewRaf = 0;
  let previewSmall = null;      // 复用的缩略底图（避免每帧重建）
  let previewSmallKey = '';
  let previewSmallCtx = null;

  /** 拖动中调用：同一帧内只跑一次 */
  function previewGradeFast() {
    if (previewRaf) return;
    // requestAnimationFrame 在后台标签页/某些 WebView 里可能不触发，
    // 用一个短定时兜底，保证「至少会更新一次」，不会让画面彻底冻住。
    let fired = false;
    const run = () => {
      if (fired) return;
      fired = true;
      previewRaf = 0;
      renderGradePreview(true);
    };
    previewRaf = requestAnimationFrame(run);
    setTimeout(() => { if (!fired) run(); }, 100);
  }

  /** 松手后调用：补一张全质量预览（也走 rAF，避免同步卡一下） */
  function previewGradeSoon() {
    if (previewRaf) cancelAnimationFrame(previewRaf);
    previewRaf = requestAnimationFrame(() => {
      previewRaf = 0;
      renderGradePreview(false);
    });
  }

  /**
   * 真正画预览。
   * @param {boolean} fast true = 拖动中，用缩略图；false = 松手后，全质量
   */
  function renderGradePreview(fast) {
    if (!S.docCanvas) return;
    const rect = effectiveRect();
    if (!rect) return;
    const g = currentGradeDraft();

    // 参数全零：直接画干净底子，连缩略图都不用建
    if (C.isGradeEmpty(g)) {
      rebuildViewCanvas();
      draw();
      return;
    }

    // 只有「整张图调色 + 参数全零以外的简单情况」才走缩略图。
    // 有画笔掩膜时缩略图和掩膜坐标对不上，宁可慢一点也要走全质量，
    // 否则预览会显示成「调色跑到了别的地方」——那是比卡更糟的错误。
    const hasMask = S.strokes.length > 0;
    if (!fast || hasMask) {
      previewGrade();           // 原来的全质量路径
      return;
    }

    // ---- 拖动的快路径：先跳过「清晰度 / 暗角」 ----
    //
    // 这两个参数代价特别大：清晰度要算局部块均值（相当于小半径模糊），
    // 暗角要按到中心的距离逐像素计算。实测 480px 上：
    //   全参数 115ms  →  跳过这两项 25ms
    // 而它们在拖动中几乎看不出区别（拖动只是看"往哪个方向变"），
    // 松手后会立刻补全质量预览，不会漏掉效果。
    let grade = g;
    if (fast) {
      const skip = {};
      let skipped = false;
      for (const k of Object.keys(g)) {
        if (k === 'clarity' || k === 'vignette') {
          if (Number(g[k]) !== 0) skipped = true;
          skip[k] = 0;
        } else {
          skip[k] = g[k];
        }
      }
      if (skipped) grade = C.normalizeGrade(skip);
    }

    // ---- 缩略图路径 ----
    const scale = Math.min(1, PREVIEW_MAX / Math.max(S.docW, S.docH));
    if (scale >= 1) { previewGrade(); return; }   // 图本来就小，没必要缩

    const sw = Math.max(1, Math.round(S.docW * scale));
    const sh = Math.max(1, Math.round(S.docH * scale));

    // 底图缓存：文档没变就复用（拖滑块时文档是不变的，能省一次缩放）
    const key = S.docW + 'x' + S.docH + ':' + sw + 'x' + sh + ':' + S.docRev;
    if (!previewSmall || previewSmallKey !== key) {
      if (!previewSmall) {
        previewSmall = makeCanvas(sw, sh);
        previewSmallCtx = previewSmall.getContext('2d', { willReadFrequently: true });
      } else if (previewSmall.width !== sw || previewSmall.height !== sh) {
        previewSmall.width = sw; previewSmall.height = sh;
        previewSmallCtx = previewSmall.getContext('2d', { willReadFrequently: true });
      }
      previewSmallCtx.imageSmoothingEnabled = true;
      previewSmallCtx.imageSmoothingQuality = 'medium';   // 拖动中不必用 high
      previewSmallCtx.clearRect(0, 0, sw, sh);
      previewSmallCtx.drawImage(S.viewCanvas, 0, 0, S.docW, S.docH, 0, 0, sw, sh);
      previewSmallKey = key;
    }

    // 在缩略图上按同样参数调色（整图范围 → 无羽化、无掩膜）。
    // 注意用 grade 而不是 g：拖动中 grade 已经把清晰度/暗角清零了。
    const id = previewSmallCtx.getImageData(0, 0, sw, sh);
    const graded = C.gradePixels(id, grade, { mask: null });
    previewSmallCtx.putImageData(new ImageData(graded.data, sw, sh), 0, 0);

    // 画到屏幕：直接用缩略图替代 viewCanvas 的绘制，不回写 viewCanvas。
    // 这一点很重要 —— viewCanvas 是「已应用编辑」的权威状态，
    // 拖动过程中往里面塞半成品，松手后不重建就会留下脏数据。
    drawGradeThumb(previewSmallCanvasToScreen(previewSmall));
  }

  /** 缩略图就是这张 canvas 本身；单独包一层是为了以后想换实现 */
  function previewSmallCanvasToScreen(c) { return c; }

  /**
   * 把缩略图按当前缩放画到屏幕。
   * 除了「用哪张图」，其余绘制逻辑（背景/选区/引导线）必须和 draw() 一致，
   * 否则拖动时选区框会闪。
   */
  function drawGradeThumb(thumb) {
    if (!ctx || !thumb) return;
    const v = viewSize();
    ctx.clearRect(0, 0, v.w, v.h);
    paintBackground(ctx, v.w, v.h);
    const r = C.imageRectToScreen({ x: 0, y: 0, w: S.docW, h: S.docH }, S.view);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(thumb, r.x, r.y, r.w, r.h);
    if (S.mode === 'brush' && S.rect && S.strokes.length) drawMaskOverlay();
    if (S.guides.length) drawGuides(S.mode !== 'guide');
    if (S.rect) drawSelection();
  }

  /**
   * 造一个调色图层对象。
   *
   * feather 沿用设置里的「边缘羽化」，mask 沿用当前画笔掩膜 ——
   * 这样调色的作用范围与生成完全一致（画笔排除的地方调色也不动）。
   */
  function makeGradeEdit(rect, grade) {
    return {
      rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      patch: null,
      grade: C.normalizeGrade(grade),
      feather: Number(S.cfg.feather) || 0,
      colorMatch: 0,             // 调色不引入外来色差，不需要色彩匹配
      mask: S.strokes.length ? maskFromStrokes(rect) : null,
      opacity: 1,
      enabled: true,
      label: C.describeGrade(grade).slice(0, 24),
      createdAt: Date.now()
    };
  }

  /** 把当前草稿应用成一条正式编辑记录（可撤销） */
  function applyGrade() {
    if (!S.docCanvas) { toast('先打开一张照片'); return; }
    // 没有框选 = 整张图（见 effectiveRect）
    const rect = effectiveRect();
    if (!rect) { toast('先打开一张照片'); return; }
    const g = C.normalizeGrade(currentGradeDraft());
    if (C.isGradeEmpty(g)) { toast('还没有调整任何参数'); return; }
    const edit = makeGradeEdit(rect, g);
    // 先用同一套参数把结果合成进正式文档
    const tmp = makeCanvas(S.docW, S.docH);
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(S.viewCanvas, 0, 0);
    // 注意：viewCanvas 此刻已经含了预览的那层调色，直接再叠一次会加倍。
    // 所以先重建一份「不含草稿」的底子
    rebuildViewCanvas();
    tctx.clearRect(0, 0, S.docW, S.docH);
    tctx.drawImage(S.viewCanvas, 0, 0);
    compositeEditInto(tctx, edit);

    S.viewCanvas = tmp;
    S.viewCtx = tctx;
    S.edits.push(edit);
    recordUndo({
      type: 'add-layer', layer: edit, index: S.edits.length - 1,
      label: '调色：' + C.describeGrade(g)
    });
    // 应用后草稿归零：下一次调色从「不变」开始，
    // 否则用户再打开调色会发现滑块还停在上次的位置，一拖就叠加了两次
    gradeDraft = C.emptyGrade();
    renderGradeSliders();
    enforceHistoryBudget();
    scheduleSessionSave();
    scheduleWorkSave();
    renderLayers();
    updateUI();
    draw();
    toast('已应用调色（可撤销）', 2600);
  }

  /** 归零草稿 */
  function resetGradeDraft() {
    gradeDraft = C.emptyGrade();
    renderGradeSliders();
    previewGrade();
  }

  /** 统计已应用的调色图层数（工具按钮上的角标） */
  function updateGradeBadge() {
    const b = $('grade-count');
    if (!b) return;
    const n = S.edits.filter((e) => e && e.grade).length;
    b.textContent = String(n);
    b.hidden = n === 0;
  }

  /**
   * 进入调色工具。
   *
   * @param {object} rect 可选：指定要调色的选区（AI 贴回后自动进入时传入）
   */
  function openGradeTool(rect) {
    if (!S.docCanvas) { toast('先打开一张照片'); return; }
    if (rect) S.rect = C.clampRect(rect, S.docW, S.docH);
    // 没有框选也能进：整张图调色（见 effectiveRect）。
    // 这里不写 S.rect —— 用户没框选就不该凭空多出一个铺满全图的选区框。
    if (!effectiveRect()) { toast('先打开一张照片'); return; }
    S.mode = 'grade';
    gradeDraft = C.emptyGrade();
    renderGradeSliders();
    resetTipDecision();
    updateUI();
    draw();
  }

  /**
   * 渲染引导线类型选择器。
   *
   * 只有两类（直线 / 自由绘制）。**没有颜色选择器了** ——
   * 颜色按序号自动分配（第 1 条红、第 2 条青…），见 core 的 GUIDE_COLORS。
   * 让用户自己选色会直接毁掉提示词的指代能力：两条红线时，
   * 「红线」这个词就废了，模型只能猜你说的是哪一条。
   */
  function renderGuideKinds() {
    const el = $('guide-kinds');
    if (el) {
      el.innerHTML = C.GUIDE_KINDS.map((k) =>
        '<button class="chip' + (k.id === S.guideKind ? ' on' : '') + '" data-gk="' + k.id + '" title="' +
          esc(k.desc) + '">' + esc(k.zh) + '</button>').join('');
      el.querySelectorAll('[data-gk]').forEach((b) => {
        b.onclick = () => {
          S.guideKind = b.dataset.gk;
          renderGuideKinds();
          // 切到自由绘制时提示会变（两者用途不同，必须说清楚）
          updateGuideBarVisibility();
        };
      });
    }
    updateGuideBarVisibility();
  }

  /**
   * 提示的「本次是否显示」状态。
   *
   * 为什么不能每次渲染都去查 shouldShowHint：
   *   进入工具的那一次点击里，renderGuideKinds() 和 updateUI() 都会调用本函数。
   *   如果第一次调用就把记录写成「已读」，第二次调用立刻判定为「不该显示」，
   *   提示在同一帧内出现又消失 —— 用户根本没看到，记录却已经写了。
   *   所以进入工具时**决定一次**并缓存，本次停留期间一直显示。
   */
  function tipDecision(key) {
    if (S.tips[key] === undefined) {
      S.tips[key] = shouldShowHint(key);
      // 重置过程中不记 —— 否则刚清空就又被写回一条
      if (S.tips[key] && !resettingHints) markHintSeen(key);
    }
    return S.tips[key];
  }

  /**
   * 重置提示记录期间为真。
   *
   * 为什么要这个标志：resetHints 清完记录后会调 updateUI() 刷新界面，
   * 而 updateUI 里会为当前工具重新判定"要不要显示提示" ——
   * 于是刚清空的记录立刻又被写回一条（表现是"重置点了没反应"）。
   * 判定本身是必要的（否则界面状态过期），只是这个瞬间不该记。
   */
  let resettingHints = false;

  /** 离开工具时清掉决定，下次进来重新判断 */
  function resetTipDecision(key) {
    if (key) delete S.tips[key];
    else S.tips = {};
  }

  /**
   * 引导线模式下：只有自由笔迹才需要选颜色，构图线不需要。
   *
   * 提示只显示一次（见 tipDecision）：用过一次的人不需要再被教一遍。
   */
  function updateGuideBarVisibility() {
    const inGuide = S.mode === 'guide';
    const free = C.getGuideKind(S.guideKind).freehand === true;
    // 提示只显示一次（见 tipDecision）：用过一次的人不需要再被教一遍
    const tf = $('guide-tip-free');
    const tg = $('guide-tip');
    if (tf) tf.hidden = !(inGuide && free && tipDecision('guide-free'));
    if (tg) tg.hidden = !(inGuide && !free && tipDecision('guide'));
  }

  function drawMaskOverlay() {
    // 没有框选时按整张图栅格化（见 effectiveRect）：
    // 用户在整张图上涂的排除区必须看得见，否则他不知道哪里被保护了
    const rect = effectiveRect();
    if (!rect) return;

    // 没有任何笔迹时，整块选区都会被修改 —— 此时不该在画面上蒙任何颜色。
    // 新语义下这一点更自然：没画 = 全改，全改就没必要标红"哪里要改"。
    if (!S.strokes.length) return;

    // ---- 掩膜：优先增量，避免「涂一笔就把所有笔迹重算一遍」 ----
    //
    // 原来每次 draw 都全量重算：3072×2048 上实测 900ms/帧，
    // 表现为越涂越卡。现在维护持久的 maskBuf 与「已栅格化的点数」，
    // 只有末尾追加了新笔段时才增量补画；撤销/清空/换选区/换笔刷
    // 一律退回全量，保证结果永远正确（增量与全量已做逐像素对拍）。
    const rectKey = rect.x + ',' + rect.y + ',' + rect.w + ',' + rect.h;

    if (!maskBuf || maskBufW !== rect.w || maskBufH !== rect.h || maskBufRectKey !== rectKey) {
      maskBuf = maskFromStrokes(rect);
      maskBufW = rect.w; maskBufH = rect.h; maskBufRectKey = rectKey;
      maskDone = S.strokes.map((st) => st.points.length);
      maskRgbaCache = null;
    } else if (S.strokes.length < maskDone.length) {
      // 笔迹变少了（撤销 / 删除）→ 增量表达不了
      maskBuf = maskFromStrokes(rect);
      maskDone = S.strokes.map((st) => st.points.length);
      maskRgbaCache = null;
    } else {
      let changed = false;
      let ok = true;
      // 前 maskDone.length 笔必须「只增不减」，否则说明被改写过
      for (let i = 0; i < maskDone.length; i++) {
        const st = S.strokes[i];
        if (!st || st.points.length < maskDone[i]) { ok = false; break; }
      }
      if (ok) {
        for (let i = 0; i < S.strokes.length; i++) {
          const st = S.strokes[i];
          const from = i < maskDone.length ? maskDone[i] : 0;
          if (st.points.length <= from) continue;
          // 带上一个连接点，保证与上一帧的笔画接得上（否则段与段之间有缝）
          const pts = st.points.slice(Math.max(0, from - 1));
          const local = {
            mode: st.mode, radius: st.radius,
            points: pts.map((q) => ({ x: q.x - rect.x, y: q.y - rect.y }))
          };
          if (C.applyStrokeToMask(maskBuf, local, rect.w, rect.h)) {
            changed = true;
            // 把这次改动的范围累积起来，着色时只刷这块
            const b = C.applyStrokeToMask.lastBox;
            if (b) {
              if (!maskDirtyBox) {
                maskDirtyBox = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
              } else {
                if (b.x0 < maskDirtyBox.x0) maskDirtyBox.x0 = b.x0;
                if (b.y0 < maskDirtyBox.y0) maskDirtyBox.y0 = b.y0;
                if (b.x1 > maskDirtyBox.x1) maskDirtyBox.x1 = b.x1;
                if (b.y1 > maskDirtyBox.y1) maskDirtyBox.y1 = b.y1;
              }
            }
          }
        }
        maskDone = S.strokes.map((st) => st.points.length);
        if (changed && !maskDirtyBox) maskNeedFull = true;
      } else {
        maskBuf = maskFromStrokes(rect);
        maskDone = S.strokes.map((st) => st.points.length);
        maskRgbaCache = null;
      }
    }

    // 掩膜 → RGBA。
    //
    // 全量转一次要 30~80ms（按尺寸），而增量涂一笔只影响一个小窗口。
    // 所以维护一块持久的 RGBA 缓冲，只刷变化的那块（实测 0.66ms），
    // 再把这块直接写进 ImageData —— 不做整块 copy（3072×2048 是 25MB）。
    //
    // 三种情况必须做全量：
    //   缓冲刚建 / 尺寸变了 / 调用了 invalidateMask（撤销、清空、换选区）
    const sizeChanged = !maskRgbaCache || maskRgbaW !== rect.w || maskRgbaH !== rect.h;
    if (sizeChanged || maskNeedFull) {
      // 直接把 mask 交给着色：mask=1 现在表示「要改」，
      // 正好就是要标红的地方。以前要取 1-mask（标保护区），语义反转后不用了。
      maskRgbaCache = C.maskToRGBA(maskBuf, rect.w, rect.h, C.BRUSH_COLOR, C.BRUSH_ALPHA);
      maskRgbaW = rect.w; maskRgbaH = rect.h;
      maskNeedFull = false;
      maskDirtyBox = { x0: 0, y0: 0, x1: rect.w - 1, y1: rect.h - 1 };
    } else if (maskDirtyBox) {
      C.paintMaskRGBA(maskRgbaCache, maskBuf, rect.w, rect.h,
        maskDirtyBox, C.BRUSH_COLOR, C.BRUSH_ALPHA);
    }

    // ImageData 与 RGBA 缓冲同尺寸时复用，只把「这次变化的那块」写进去
    const needFullPut = !maskCache || maskCache.width !== rect.w || maskCache.height !== rect.h;
    if (needFullPut) {
      maskCache = new ImageData(new Uint8ClampedArray(maskRgbaCache), rect.w, rect.h);
    } else if (maskDirtyBox) {
      const bb = maskDirtyBox;
      const rowBytes = (bb.x1 - bb.x0 + 1) * 4;
      for (let y = bb.y0; y <= bb.y1; y++) {
        const off = (y * rect.w + bb.x0) * 4;
        maskCache.data.set(maskRgbaCache.subarray(off, off + rowBytes), off);
      }
    }
    // 记录这次要把哪一块上传到离屏画布：
    //   null      → 整块上传（刚建/尺寸变了）
    //   空范围    → 没有变化，跳过上传
    //   有效范围  → 只传这一块（putImageData 支持脏矩形重载）
    if (needFullPut) {
      maskPutBox = null;
    } else if (maskDirtyBox) {
      maskPutBox = { x0: maskDirtyBox.x0, y0: maskDirtyBox.y0, x1: maskDirtyBox.x1, y1: maskDirtyBox.y1 };
    } else {
      maskPutBox = { x0: 0, y0: 0, x1: -1, y1: -1 };
    }
    maskDirtyBox = null;
    // 离屏画布按尺寸复用，只有选区尺寸变化时才重建
    const ck = rect.w + 'x' + rect.h;
    if (!maskCanvas || maskCanvasKey !== ck) {
      maskCanvas = makeCanvas(rect.w, rect.h);
      maskCanvasKey = ck;
    }
    // putImageData 会把整块 ImageData 上传到 canvas。
    // 1600×1200 每帧上传一次是主要开销（整块 ≈ 7.7MB），
    // 而实际每次涂只改了很小一块 —— 用带脏矩形的重载只传那一块。
    //
    // 注意：putImageData 的脏矩形参数是**源数据里的坐标**，
    // 与 canvas 上的位置由 (0,0) 决定，这里两者一致所以直接传。
    const mctx = maskCanvas.getContext('2d');
    if (maskPutBox && maskPutBox.x1 >= maskPutBox.x0) {
      const bb = maskPutBox;
      mctx.putImageData(maskCache, 0, 0, bb.x0, bb.y0, bb.x1 - bb.x0 + 1, bb.y1 - bb.y0 + 1);
    } else {
      mctx.putImageData(maskCache, 0, 0);
    }
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
      cancelLongPress();     // 双指 = 缩放，不是长按
      startPinch();
      return;
    }
    if (S.pointers.size > 2) { cancelLongPress(); return; }

    // 单指按下 → 开始长按计时（按住不放就显示原图）
    armLongPress(p, ev.pointerId);

    const ip = C.screenToImage(p, S.view);

    // 平移模式 / 空格 / 中键
    if (S.mode === 'pan' || S.spaceDown || ev.button === 1) {
      S.gesture = { type: 'pan', start: p, view0: Object.assign({}, S.view) };
      return;
    }

    if (S.mode === 'guide') {
      // 没有框选 = 整张图（见 effectiveRect）：引导线可以直接画，不必先框
      const rect = effectiveRect();
      if (!rect) { toast('先打开一张照片'); return; }
      if (!C.pointInRect(ip, rect)) { toast('引导线只能画在选区内'); return; }
      // 点已有的引导线 = 删除（比找小叉号方便）
      const hitIdx = hitGuide(p);
      if (hitIdx >= 0) {
        S.guides.splice(hitIdx, 1);
        updateGuideBadge();
        scheduleSessionSave();   // 删线也要落盘，否则重开又冒出来
        draw();
        toast('已删除一条引导线');
        return;
      }
      const n0 = screenToGuideNorm(p);
      const free = C.getGuideKind(S.guideKind).freehand === true;
      const draft = {
        kind: S.guideKind,
        // 颜色在**创建时**定下来，用「第一个还没被用到的颜色」——
        // 不能按长度推：删掉中间一条后长度会变小，新线就会撞上已有颜色，
        // 画面上出现两条同色线，提示词里「红线」这个指代当场失效。
        colorId: C.nextGuideColor(S.guides).id,
        x1: n0.x, y1: n0.y, x2: n0.x, y2: n0.y
      };
      // 自由笔迹要收整条折线（发丝/水流的走向是有弧度的，两个端点描述不了）
      if (free) draft.points = [{ x: n0.x, y: n0.y }];
      S.guides.push(draft);
      S.gesture = { type: 'guide', draft, rect, free };
      draw();
      return;
    }

    // 智能框选：点一下把选区收紧到那个物体
    if (S.mode === 'auto') {
      autoSelectAt(ip);
      return;
    }

    if (S.mode === 'brush') {
      // 没有框选 = 整张图（见 effectiveRect）：画笔可以在整张照片上涂
      const rect = effectiveRect();
      if (!rect) { toast('先打开一张照片'); return; }
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
    // 空白处：重新开始框选（笔迹和引导线都随旧选区一起丢弃 ——
    // 引导线存的是「相对选区」的归一化坐标，换了选区位置就完全对不上了）
    S.gesture = { type: 'create', start: ip };
    S.rect = { x: ip.x, y: ip.y, w: 0, h: 0 };
    S.strokes = [];
    S.guides = [];
    updateGuideBadge();
    invalidateMask();
  });

  cv.addEventListener('pointermove', (ev) => {
    const p = localPoint(ev);
    if (S.pointers.has(ev.pointerId)) S.pointers.set(ev.pointerId, p);

    // 长按判定：动得太多说明是在拖，不是要对比
    if (longPressStart && ev.pointerId === longPressPointerId) {
      const dx = p.x - longPressStart.x;
      const dy = p.y - longPressStart.y;
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOL) {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = 0; }
        longPressStart = null;
        longPressPointerId = null;
        // 取消长按后，如果这次按下只留下一个退化选区（0×0），也要清掉。
        // 否则它会一直留着，把画面压暗 —— 用户看到的是"点了空白处画面变灰"。
        if (S.rect && (S.rect.w < 1 || S.rect.h < 1)) S.rect = null;
      }
    }
    // 长按生效期间不处理任何手势
    if (longPressActive) return;

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
    if (g.type === 'guide') {
      const n = screenToGuideNorm(p);
      g.draft.x2 = n.x;
      g.draft.y2 = n.y;
      if (g.free) {
        const pts = g.draft.points;
        const last = pts[pts.length - 1];
        // 采样抽稀：手指移动每帧都记会让点数爆炸（一笔几百个点，存进会话还会撑爆存储）。
        // 与上一个点距离小于选区短边的 1% 就丢弃 —— 肉眼看不出差别。
        const minD = Math.min(g.rect.w, g.rect.h) * 0.01;
        if (!last || Math.hypot((n.x - last.x) * g.rect.w, (n.y - last.y) * g.rect.h) >= minD) {
          pts.push({ x: n.x, y: n.y });
          // 硬上限：单笔最多 400 点，超了就丢中间点（防止极端情况下卡死）
          if (pts.length > 400) pts.splice(Math.floor(pts.length / 2), 1);
        }
      }
      // 拖到选区外也允许：夹回边界，用户不用精确收手
      draw();
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
    // 长按对比：松手就恢复（先取消再走后续清理）
    if (longPressActive) {
      cancelLongPress();
      S.pointers.delete(ev.pointerId);
      draw();
      return;
    }
    // 还没到 450ms 就抬手 → 不是长按，取消计时
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = 0; }
    longPressStart = null;
    longPressPointerId = null;

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
    if (g.type === 'guide') {
      const d = g.draft;
      const kind = C.getGuideKind(d.kind);
      let tooShort;
      if (kind.freehand) {
        // 笔迹按「折线总长度」判废，不能只看首尾直线距离：
        // 画一个闭合的小圈，首尾几乎重合，但它是有效笔迹
        let len = 0;
        const pts = d.points || [];
        for (let i = 1; i < pts.length; i++) {
          len += Math.hypot((pts[i].x - pts[i - 1].x) * g.rect.w, (pts[i].y - pts[i - 1].y) * g.rect.h);
        }
        tooShort = pts.length < 2 || len < Math.max(14, Math.hypot(g.rect.w, g.rect.h) * 0.06);
      } else {
        tooShort = Math.hypot((d.x2 - d.x1) * g.rect.w, (d.y2 - d.y1) * g.rect.h) <
          Math.max(12, Math.hypot(g.rect.w, g.rect.h) * 0.06);
      }
      if (tooShort) {
        S.guides.pop();
      } else if (kind.freehand) {
        // 笔迹不做吸附 —— 拉直等于毁掉手画的弧度
        const nrm = C.normalizeGuide(d);
        d.x1 = nrm.x1; d.y1 = nrm.y1; d.x2 = nrm.x2; d.y2 = nrm.y2;
        d.points = nrm.points;
        updateGuideBadge();
        toast('已加草图：' + (d.points ? d.points.length : 0) + ' 个点（会画进模型请求图）');
      } else {
        // 吸附到常见方向，模型拿到的是干净的构图意图而不是手抖斜线
        const snapped = C.snapGuide(d);
        d.x1 = snapped.x1; d.y1 = snapped.y1;
        d.x2 = snapped.x2; d.y2 = snapped.y2;
        d.kind = snapped.kind;
        updateGuideBadge();
        toast('已加引导线：' + kind.zh);
      }
      S.gesture = null;
      updateGuideBadge();
      // 引导线也是用户的手工成果，必须立刻排一次会话保存。
      // 以前这里没存：画完线直接切走/被杀，重开应用线就没了 ——
      // 而「画好的线」正是下一次生成的依据，丢了等于白画。
      scheduleSessionSave();
      draw();
      updateUI();
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

  /** 命中测试：屏幕坐标是否落在某条引导线附近，返回下标或 -1 */
  function hitGuide(p) {
    // 没有框选时引导线是按整张图存的（见 effectiveRect），命中测试也要用同一基准
    const rect = effectiveRect();
    if (!rect || !S.guides.length) return -1;
    const sr = C.imageRectToScreen(rect, S.view);
    const TOL = 14;
    /** 点到线段的最短距离 */
    const segDist = (px, py, ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };
    for (let i = S.guides.length - 1; i >= 0; i--) {
      const g = S.guides[i];
      if (g.points && g.points.length >= 2) {
        // 折线：逐段算距离，取最小
        let best = Infinity;
        for (let k = 1; k < g.points.length; k++) {
          const a = g.points[k - 1], b = g.points[k];
          best = Math.min(best, segDist(p.x, p.y,
            sr.x + a.x * sr.w, sr.y + a.y * sr.h,
            sr.x + b.x * sr.w, sr.y + b.y * sr.h));
        }
        if (best <= TOL) return i;
        continue;
      }
      const x1 = sr.x + g.x1 * sr.w, y1 = sr.y + g.y1 * sr.h;
      const x2 = sr.x + g.x2 * sr.w, y2 = sr.y + g.y2 * sr.h;
      if (segDist(p.x, p.y, x1, y1, x2, y2) <= TOL) return i;
    }
    return -1;
  }

  function invalidateMask() {
    maskCacheKey = '';
    maskCache = null;
    // 增量状态也要一并作废 —— 否则"撤销一笔"之后掩膜还留着旧内容，
    // 画面显示的和真正发出去的范围对不上，而且极难发现。
    maskBuf = null; maskDone = [];
    maskNeedFull = true;
  }

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

  /**
   * 当前**实际要处理**的区域。
   *
   * 需求：「没有框选的时候默认对整张图片进行调整」，且**所有操作**都算（含 AI 生图）。
   * 所以「没有选区」不再是错误，而是「整张图」。
   *
   * 为什么做成一个统一的解析函数，而不是在每个工具里各写一遍兜底：
   *   15 处 `if (!S.rect) { toast(...); return; }` 分散在生图/调色/画笔/引导线里，
   *   各写一遍必然出现「有的工具兜底了、有的没有」的不一致 ——
   *   用户会遇到「AI 生图能用整张图，但调色说我没框选」这种莫名其妙的行为。
   *   收敛到一个函数，含义就只有一种。
   *
   * 注意这里**不写 S.rect**：解析出的整张图范围只用于这一次操作。
   * 若写回 S.rect，画面上会立刻出现一个铺满全图的选区框、并且后续拖动
   * 就变成「在整图上拖手柄」——用户只是没框选，不该被强行塞一个选区。
   *
   * @returns {object|null} 选区；没有打开照片时返回 null
   */
  function effectiveRect() {
    if (!S.docCanvas) return null;
    if (S.rect) return C.clampRect(S.rect, S.docW, S.docH);
    return C.wholeRect(S.docW, S.docH);
  }

  /** 这次操作是不是在整张图上做（用于切换提示词口径、跳过羽化等） */
  function editingWholeImage(rect) {
    return C.isWholeRect(rect || effectiveRect(), S.docW, S.docH);
  }

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

  /**
   * 统计选区**周围环境**的客观特征，用于写进提示词。
   *
   * 为什么要测：只说「请保持一致」模型不知道该一致成什么样 ——
   * 它看不到像素统计。把测出来的结果（多亮、冷暖、反差、光向）写进去，
   * 模型就有了可对照的目标，配合贴回时的无缝融合，效果明显更贴合。
   *
   * 测的是「环带」（选区外一圈），那才是要融入的环境。
   */
  function measureSurroundings(rect) {
    if (!S.docCanvas || !S.docCtx) return null;
    try {
      const ring = Math.max(8, Math.round(Math.min(rect.w, rect.h) * 0.25));
      // 往外扩一圈，读出来当环带样本
      const x0 = Math.max(0, rect.x - ring), y0 = Math.max(0, rect.y - ring);
      const x1 = Math.min(S.docW, rect.x + rect.w + ring);
      const y1 = Math.min(S.docH, rect.y + rect.h + ring);
      const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
      const pix = S.docCtx.getImageData(x0, y0, w, h);
      const stats = C.ringMoments({
        pixels: pix,
        rect: { x: rect.x - x0, y: rect.y - y0, w: rect.w, h: rect.h },
        ring
      });
      const plane = C.fitLightPlane({
        pixels: pix,
        rect: { x: rect.x - x0, y: rect.y - y0, w: rect.w, h: rect.h },
        ring: ring + 4
      });
      if (!stats || stats.n < 20) return null;
      return { stats, plane };
    } catch (e) {
      return null;      // 取不到就退化成「不描述环境」，不影响生成
    }
  }

  /**
   * 组装要发给模型的图（含上下文外扩 + 掩膜提示 + 隐私打码）。
   *
   * @param {object} rect 选区（文档坐标）
   * @param {Float32Array|null} mask 画笔掩膜
   * @param {object} [baseRect] 笔迹坐标的基准选区。
   *   笔迹是相对「发起生成那一刻的选区」存的，而选区在生成期间可以被拖动。
   *   不显式传的话就得读模块级的 lastSelRect —— 那个变量是**异步回调里才赋值**的，
   *   于是「先组图、后赋值」的调用顺序下，笔迹会按错误的基准换算，
   *   画到请求图上的位置整体偏掉（实测偏到 20%~40% 而不是 25%~75%）。
   *   所以必须由调用方把基准显式传进来。
   */
  /**
   * 把超出图片边界的那一条用**边缘像素往外延**补满。
   *
   * 为什么不用黑边：黑边会被模型当成画面内容，生成结果边上会发黑/发灰。
   * 为什么不用镜像：镜像是翻转的内容，模型可能把倒影当真实景物画进去。
   * 边缘延伸（把最外一行/一列像素拉伸出去）在视觉上最中性 ——
   * 它只是把天空继续是天空、墙继续是墙，模型不会因此改变构图。
   *
   * 这段补出来的内容**最后会被裁掉**（贴回只取选区那一块），
   * 所以它只影响模型对画面的理解，不会出现在成品里。
   *
   * @param {CanvasRenderingContext2D} dst 目标上下文（已经画好图片内的部分）
   * @param {HTMLCanvasElement} doc 原图
   * @param {{x,y,w,h}} fit 扩大后的矩形（可能超出图片）
   */
  function extendCanvasEdges(dst, doc, fit) {
    const DW = doc.width, DH = doc.height;
    const x0 = Math.max(0, fit.x), y0 = Math.max(0, fit.y);
    const x1 = Math.min(DW, fit.x + fit.w), y1 = Math.min(DH, fit.y + fit.h);
    if (x1 <= x0 || y1 <= y0) return;
    const dw = x1 - x0, dh = y1 - y0;
    // 图片内容在目标画布里的位置
    const dx = x0 - fit.x, dy = y0 - fit.y;

    // 上：把最上面一行横向拉出去
    if (dy > 0) dst.drawImage(doc, x0, y0, dw, 1, dx, 0, dw, dy);
    // 下
    if (dy + dh < fit.h) dst.drawImage(doc, x0, y1 - 1, dw, 1, dx, dy + dh, dw, fit.h - (dy + dh));
    // 左：把最左一列纵向拉出去
    if (dx > 0) dst.drawImage(doc, x0, y0, 1, dh, 0, dy, dx, dh);
    // 右
    if (dx + dw < fit.w) dst.drawImage(doc, x1 - 1, y0, 1, dh, dx + dw, dy, fit.w - (dx + dw), dh);
    // 四个角：用对应的那一个像素
    if (dx > 0 && dy > 0) dst.drawImage(doc, x0, y0, 1, 1, 0, 0, dx, dy);
    if (dx + dw < fit.w && dy > 0) dst.drawImage(doc, x1 - 1, y0, 1, 1, dx + dw, 0, fit.w - (dx + dw), dy);
    if (dx > 0 && dy + dh < fit.h) dst.drawImage(doc, x0, y1 - 1, 1, 1, 0, dy + dh, dx, fit.h - (dy + dh));
    if (dx + dw < fit.w && dy + dh < fit.h) {
      dst.drawImage(doc, x1 - 1, y1 - 1, 1, 1, dx + dw, dy + dh, fit.w - (dx + dw), fit.h - (dy + dh));
    }
  }

  function buildRequestImage(rect, mask, baseRect, guides) {
    const pct = Number(S.cfg.contextPct) || 0;
    const padX = Math.round(rect.w * pct / 100), padY = Math.round(rect.h * pct / 100);
    const ctxRect = C.clampRect({ x: rect.x - padX, y: rect.y - padY, w: rect.w + padX * 2, h: rect.h + padY * 2 }, S.docW, S.docH);

    const c = makeCanvas(ctxRect.w, ctxRect.h);
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(S.docCanvas, ctxRect.x, ctxRect.y, ctxRect.w, ctxRect.h, 0, 0, ctxRect.w, ctxRect.h);

    // 已应用的编辑也要带上（保证上下文一致）。
    //
    // 这里必须区分两类图层，否则会直接崩：
    //   - 生成图层：有 patch，贴上去即可
    //   - 调色图层：**没有 patch**（只有一组参数），drawImage(null) 会抛
    //     "Value is not one of these types" —— 用户表现为「只要先调过色，
    //     就再也生成不了」，而且报错信息完全看不出原因。
    // 调色图层要按参数重新算一遍，而不是贴图。
    for (const e of S.edits) {
      const L = C.normalizeLayer(e);
      if (!L.enabled) continue;
      const ix = e.rect.x - ctxRect.x, iy = e.rect.y - ctxRect.y;
      if (ix + e.rect.w < 0 || iy + e.rect.h < 0 || ix > ctxRect.w || iy > ctxRect.h) continue;
      if (e.patch) {
        cx.drawImage(e.patch, ix, iy, e.rect.w, e.rect.h);
      } else if (e.grade) {
        // 调色图层：在请求图上按同样的参数重算一遍，
        // 让模型看到的上下文和用户在屏幕上看到的一致。
        // 先取子图，算完再贴回去（坐标要夹到请求图范围内）。
        const sx = Math.max(0, ix), sy = Math.max(0, iy);
        const ex = Math.min(ctxRect.w, ix + e.rect.w), ey = Math.min(ctxRect.h, iy + e.rect.h);
        const w2 = ex - sx, h2 = ey - sy;
        if (w2 > 0 && h2 > 0) {
          const sub = cx.getImageData(sx, sy, w2, h2);
          // 权重按图层羽化/不透明度算；请求图是整块发送，
          // 这里不需要画笔掩膜（掩膜只管「改哪里」，不影响上下文颜色）
          const alpha = C.layerAlphaMap(
            { rect: { x: 0, y: 0, w: w2, h: h2 }, feather: e.feather, opacity: L.opacity, enabled: true },
            w2, h2
          );
          const graded = C.gradePixels(sub, e.grade, { mask: alpha });
          cx.putImageData(new ImageData(graded.data, w2, h2), sx, sy);
        }
      }
    }

    // ---- 竖屏/比例不符时：把请求图外扩成模型的出图比例 ----
    //
    // 背景：OpenAI 没有 3:4 这一档（只有 1:1 / 3:2 / 2:3 / 16:9 / 9:16）。
    // 竖屏照片（3:4）最接近 2:3，比例差 13%。贴回时必须「盖满 + 居中裁切」，
    // 于是**上下各被切掉约 6% 的画面** —— 用户框了整张竖图，结果少了上下一条。
    //
    // 修法：在发请求前就把请求图按模型比例**补足**（补的是选区外已有的画面，
    // 不是凭空生成的内容），这样返回图的比例和选区完全一致，贴回时不用裁，
    // 用户选中的每一像素都能原样落回原位。
    //
    // 只在不打码、且选区外还有可用画面时补；补不出来（选区已经顶到图片边界）
    // 就维持原样，宁可轻微裁切也不能把画布撑出边界变成黑边。
    // 目标比例取自模型实际会输出的尺寸（不是写死 2:3）：
    // 换模型 / 换服务商时不用改代码，竖屏和横屏都走同一套。
    const wantSize = pickOutputSize(rect);
    let targetAspect = 0;
    if (wantSize && wantSize.size) {
      const parts = String(wantSize.size).split('x');
      if (parts.length === 2) targetAspect = (+parts[0]) / (+parts[1]);
    } else if (wantSize && wantSize.aspect) {
      const ap = String(wantSize.aspect).split(':');
      if (ap.length === 2) targetAspect = (+ap[0]) / (+ap[1]);
    }
    const fit = C.planRequestAspect(ctxRect, rect, {
      targetAspect,
      docW: S.docW, docH: S.docH,
      // 打码模式下补出来的那圈也是原图内容，没必要补（而且会稀释打码范围）
      maxGrow: S.cfg.mosaic ? 0 : 0.6,
      // 选区贴边（整张竖屏照片就是这种）时，允许把画面往外延一点点
      allowExtend: !S.cfg.mosaic
    });
    // 外扩要**最后**做：引导线和打码都画在 ctxRect 这块画布上，
    // 提前外扩会把它们丢掉（复制的是还没画线的那一版）。
    let srcCanvas = c;
    let srcOff = { x: rect.x - ctxRect.x, y: rect.y - ctxRect.y };
    let srcRect = ctxRect;

    let off = srcOff;

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
    //
    // 引导线（直线 + 自由笔迹两类）是**唯一**会画进请求图的标注，原因：
    // 「地平线放在这里」「头发往这个方向飘」这类要求，文字根本说不明白 ——
    // 模型看不到我们的坐标系，也无法把「下方三分之一」对应到像素。
    // 画在图上让它直接看，是唯一可靠的做法。
    // 它和当初的蓝色掩膜有本质区别：蓝色掩膜标的是「改哪一块」（文字能说清），
    // 引导线标的是「生成成什么位置/走向」（文字说不清）。
    //
    // 引导线快照由调用方传入（默认回落到当前状态）：
    // 快照化之后，即使随后换了图/改了引导线，这次请求也不受影响。
    const jobGuides = (guides !== undefined && guides !== null) ? guides : S.guides;
    // 这里**不读任何开关**：早期那个「笔迹进图」开关一旦被存成 false，
    // 就会出现「屏幕上看得见线、模型收到的图里却没有」——
    // 用户反馈的「GPT 看不到我画的引导线」正是这么来的。
    // 所以现在只有一条规则：画了引导线就画进请求图。
    const strokeOn = jobGuides.length > 0;
    let strokeNote = '';
    // 每次组图都先把参考图记录清空，避免上一次的残留
    // （比如上次带了 2 张、这次没带，自检面板不该还写着「已带 2 张」）
    lastRefNote = '';
    if (strokeOn) {
      // 引导线的坐标是相对**整个选区**存的，换算时必须以选区为基准。
      // 基准由调用方传入（见函数注释：不能读模块级的 lastSelRect）
      const strokeBase = baseRect || rect;
      const sp = C.planStrokeOverlay({
        guides: jobGuides,
        rect: strokeBase,
        ctxRect,
        enabled: true,
        // 线宽按请求图短边给：图越大线越粗，视觉粗细才一致
        width: Math.max(4, Math.round(Math.min(ctxRect.w, ctxRect.h) * 0.012))
      });
      // 如实记录这次到底画了几条，供请求自检面板显示
      strokeNote = sp.note;
      if (sp.count) C.drawStrokeOverlay(cx, sp);
    }
    lastStrokeNote = strokeNote;

    // ---- 竖屏/比例不符：把请求图补成模型的出图比例 ----
    //
    // 放在引导线之后：这段会新建一块更大的画布，然后把**已经画好标注的**
    // 请求图复制进去。放在前面的话，复制的是还没画线的版本，线就丢了。
    if (fit && (fit.padX || fit.padY)) {
      const big = makeCanvas(fit.w, fit.h);
      const bx = big.getContext('2d', { willReadFrequently: true });
      // 先按「扩大后的矩形」直接从原图取一份（超出图片的部分由下一步补）
      bx.drawImage(S.docCanvas, fit.x, fit.y, fit.w, fit.h, 0, 0, fit.w, fit.h);
      // 超出图片边界的那一条：用边缘像素往外延（不是黑边，也不是凭空生成）
      if (fit.extend) extendCanvasEdges(bx, S.docCanvas, fit);
      // 再把已经画好标注的请求图覆盖回它该在的位置
      bx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height,
        fit.offX, fit.offY, srcCanvas.width, srcCanvas.height);
      srcCanvas = big;
      srcRect = fit;
      srcOff = { x: rect.x - fit.x, y: rect.y - fit.y };
      off = srcOff;
    }

    // ---- 小选区上采样 ----
    // 很多接口对输入图有最小像素要求（如 0.66MP）。摄影师常改的恰恰是小区域，
    // 裁出来可能只有 100x100，直接发会被服务端拒收。
    // 这里把「选区本身」放大到合规尺寸，并记录放大信息供贴回时精确还原。
    const up = (S.cfg.upscaleSmall === false)
      ? { needed: false, scale: 1, w: rect.w, h: rect.h, srcW: rect.w, srcH: rect.h }
      : C.planUpscale(rect.w, rect.h, S.cfg.provider);
    let outCanvas = srcCanvas;
    let upInfo = null;
    if (up.needed && up.w > rect.w) {
      // 放大后的画布尺寸 = 外扩部分按同倍数放大。
      // 用 srcCanvas/srcRect（可能已被补过比例），否则补出来的那圈会被丢掉。
      const k = up.w / rect.w;
      const ow = Math.round(srcCanvas.width * k), oh = Math.round(srcCanvas.height * k);
      const big = makeCanvas(ow, oh);
      const bx = big.getContext('2d', { willReadFrequently: true });
      bx.imageSmoothingEnabled = true;
      bx.imageSmoothingQuality = 'high';
      bx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, 0, 0, ow, oh);
      outCanvas = big;
      upInfo = {
        scale: k,
        srcW: rect.w, srcH: rect.h,          // 选区原始尺寸
        upW: Math.round(rect.w * k), upH: Math.round(rect.h * k),
        off: { x: Math.round(off.x * k), y: Math.round(off.y * k) },
        reqW: ow, reqH: oh
      };
    }
    return { canvas: outCanvas, rect: srcRect, off, up: upInfo, aspectFit: !!fit };
  }

  function canvasToDataUrl(canvas, format, quality) {
    return canvas.toDataURL(format || 'image/jpeg', quality);
  }

  /**
   * 发一次模型请求。
   *
   * @param {object} body  buildImageRequest 的结果（可能带 multipart）
   * @param {AbortController} aborter 这次请求专属的取消器。
   *   必须是**每个任务各自一个**：旧实现用全局的 S.aborter，
   *   于是「用户换了图」就把所有人的请求一起 abort 了 ——
   *   后台任务正是要解决这件事。
   */
  async function callModel(body, aborter) {
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
        signal: aborter ? aborter.signal : undefined
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
        signal: aborter ? aborter.signal : undefined
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
      if (aborter && aborter.signal.aborted) throw e;
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

  /* ====================== 后台生成任务 ====================== */

  /**
   * 后台生成任务：发起生成后可以离开这张照片，生成继续跑。
   *
   * 为什么需要：生图要 30~60 秒，摄影师手上有几十张要修。旧实现里
   * 「回首页 / 换图」会 abort 在途请求 —— 上游已经出图、钱已经花了，
   * 结果却收不到。这是最让人心疼的一类失败。
   *
   * 设计要点：
   *   - 任务自带**归属信息**（workId + docVersion），落地前双重校验，
   *     绝不会把结果贴到别的照片上
   *   - 请求所需的**全部输入**在发起时就固化进任务（选区、掩膜、提示词、
   *     引导线、外扩比例……），这样即使用户随后换了图、撤销了编辑，
   *     请求本身也不受影响（旧实现直接读 S.* ，换图后就会错）
   *   - 结果回来时按 planJobLanding 决定去处：同一张 → 对比图；
   *     在别处 → 存进那件作品的记录 + 角标 + 通知
   *   - busy 只反映「当前这张照片有没有在跑的任务」，不假装在忙
   */

  /** 找一条任务 */
  function findJob(id) {
    return S.jobs.find((j) => j.id === id) || null;
  }

  /** 当前这张照片正在跑的任务（决定 busy 遮罩） */
  function jobsForCurrentDoc() {
    return S.jobs.filter((j) => j.status === 'running' && j.docVersion === S.docVersion);
  }

  /** 还没被用户看过的「已完成」任务数（首页角标用） */
  function pendingJobNotice() {
    return S.jobs.filter((j) => j.status === 'done' && !j.seen);
  }

  /**
   * 刷新「后台任务」相关的界面：角标 + busy 遮罩 + 首页/作品库的标记。
   *
   * 统一入口，避免各处漏刷 —— 漏刷的表现是「结果出来了但界面没反应」，
   * 用户会以为白花钱了。
   */
  function refreshJobsUI() {
    // busy 只反映「当前这张照片」的任务：
    // 用户在首页时别的照片还在跑，弹「正在生成…」会让他以为卡住了
    const plan = C.planBusyForCurrent({
      jobs: S.jobs,
      curWorkId: S.workId,
      curDocVersion: S.docVersion,
      hasPhoto: !!S.img
    });
    if (plan.busy !== S.busy) setBusy(plan.busy, '正在生成…', '正在请求生图模型');
    // busy 没变时也要同步一次保活：后台任务从「跑着」变成「跑完」时
    // busy 可能一直是 false（用户不在那张照片上），但保活必须跟着释放，
    // 否则会留下一条不该有的常驻通知。
    else syncKeepAlive();

    // 画布上方的状态条：有几个在跑 / 几个好了
    const badge = $('job-badge');
    const b = C.planJobBadge(S.jobs);
    if (badge) {
      badge.hidden = b.total === 0;
      badge.textContent = b.text;
      badge.classList.toggle('ok', b.running === 0 && b.done > 0);
      // 点一下：有结果就回首页看（结果都在作品库里）
      badge.onclick = () => { if (!S.img) renderHome(); else toast(b.text, 2600); };
      // 「已生成」这类**结果性**提示不要一直挂在画面上 ——
      // 用户反馈它会一直悬浮着挡视线。几秒后自动收起。
      // 「正在生成」属于进行中状态，必须保留（否则用户不知道后台还在跑）。
      scheduleBadgeAutoHide(b);
    }
    // 首页与作品库的条目标记（「生成中…」/「已生成，点开看」）
    if (isHomeVisible()) renderHome();
    if ($('library') && !$('library').hidden) renderLibrary();
    updateUI();
  }

  /**
   * 结果型状态条（已生成 / 生成失败）自动隐藏。
   *
   * 判据是「没有任务在跑」—— 那说明这条提示只是结果，不是进度。
   * 进行中（running > 0）绝不能自动藏，否则用户以为后台停了。
   */
  let badgeHideTimer = null;
  /** 这条提示是不是已经自动藏起来了（避免每次刷新又冒出来） */
  let badgeDismissedText = '';

  function scheduleBadgeAutoHide(b) {
    const badge = $('job-badge');
    if (!badge) return;
    const isResult = b && b.running === 0 && (b.done > 0 || b.failed > 0);
    if (!isResult) {
      // 有任务在跑 / 没有任务：清掉计时器与「已隐藏」标记
      if (badgeHideTimer) { clearTimeout(badgeHideTimer); badgeHideTimer = null; }
      badgeDismissedText = '';
      return;
    }
    // 同一条提示已经藏过且内容没变 → 别再把它显示出来
    if (badgeDismissedText && badgeDismissedText === b.text) {
      badge.hidden = true;
      return;
    }
    if (badgeHideTimer) clearTimeout(badgeHideTimer);
    badgeHideTimer = setTimeout(() => {
      badgeHideTimer = null;
      // 只有「还是这条结果提示」时才藏：期间如果又开始了新生成，不该藏
      const nb = C.planJobBadge(S.jobs);
      if (nb.running === 0 && nb.text === b.text) {
        badge.hidden = true;
        badgeDismissedText = b.text;
      }
    }, 4000);
  }

  /** 任务完成后清掉「已看过」的标记（用户回到那张照片了） */
  function markJobsSeen(workId) {
    let changed = false;
    for (const j of S.jobs) {
      if (j.status === 'done' && !j.seen && (!workId || j.workId === workId)) {
        j.seen = true;
        changed = true;
      }
    }
    if (changed) refreshJobsUI();
  }

  /** 移除已看过/已失败的任务（避免任务表无限增长） */
  function pruneJobs() {
    const keep = S.jobs.filter((j) => j.status === 'running' || !j.seen);
    if (keep.length !== S.jobs.length) { S.jobs = keep; refreshJobsUI(); }
  }

  /**
   * 取消「当前这张照片」的所有在途任务。
   *
   * 用于换图 / 回首页 / 恢复作品 / 用户点取消 —— 这些场景下当前文档的
   * 结果已经无处可落（文档被换掉或卸载了），继续跑纯属浪费。
   *
   * **刻意不动别的照片的任务**：那些任务的结果有地方可落（各自的记录），
   * 中止它们等于把用户已经花掉的钱扔掉。
   *
   * @returns {number} 取消了几条
   */
  function cancelJobsForCurrentDoc(why) {
    const docVer = S.docVersion;
    let n = 0;
    for (const j of S.jobs) {
      if (j.status !== 'running' || j.docVersion !== docVer) continue;
      try { if (j.aborter) j.aborter.abort(); } catch (e) { /* ignore */ }
      j.aborter = null;
      j.status = 'canceled';
      j.cancelReason = why || '';
      n++;
    }
    if (n) {
      pruneJobs();
      refreshJobsUI();
    }
    return n;
  }

  /** 用户取消某个任务（或当前这张的所有任务） */
  function cancelJob(id) {
    const j = findJob(id);
    if (!j || j.status !== 'running') return false;
    try { if (j.aborter) j.aborter.abort(); } catch (e) { /* ignore */ }
    j.status = 'canceled';
    j.aborter = null;
    pruneJobs();
    refreshJobsUI();
    return true;
  }

  /** 主流程入口：先做预检，再执行生成 */
  async function generate() {
    if (S.busy) { toast('正在生成，请稍候'); return; }   // 防重复点击
    if (!S.img) { toast('先打开一张照片'); return; }
    // 没有框选 = 整张图（见 effectiveRect），不再要求用户先框选
    if (!effectiveRect()) { toast('先打开一张照片'); return; }
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
    if (S._dbg) S._dbg.gen = { est: est && { usd: est.totalUsd, known: est.known } };
    if (!confirmCostIfNeeded(est)) { if (S._dbg) S._dbg.gen.blocked = 'cost'; return; }

    return runGenerate();
  }

  /**
   * 准备一次生成：把所有输入**固化**进一个「任务」对象。
   *
   * 为什么要把输入全部拷贝出来，而不是执行时现读 S.*：
   * 用户可以在生成期间换图、撤销、改选区、改设置。旧实现直接在请求里读
   * `S.rect` / `S.strokes` / `S.docCanvas`，换图后这些就都变了 ——
   * 轻则请求错乱，重则把结果贴到别的照片上。固化成快照之后，
   * 「发起时看到的就是发出去的」，与用户之后做什么完全无关。
   *
   * @returns {object|null} 任务对象；条件不满足时返回 null（已 toast 说明原因）
   */
  function prepareJob() {
    if (!S.img || !S.docCanvas) return null;
    // 没有框选 = 整张图（见 effectiveRect）。不写回 S.rect。
    const rect = effectiveRect();
    if (!rect) return null;
    const whole = editingWholeImage(rect);
    const mask = S.strokes.length ? maskFromStrokes(rect) : null;
    const m = currentModelParams();
    const kind = m ? m.kind : 'edit';
    const lang = S.cfg.lang === 'auto' ? (C.HAS_CJK.test($('prompt').value) ? 'zh' : 'en') : S.cfg.lang;

    // 请求图（含上下文外扩 / 掩膜提示 / 隐私打码）在**发起时**就编好，
    // 这样即使随后换了图，请求体也不会变。
    // 显式把笔迹/开关/颜色传进去：这是「快照」的一部分，
    // 之后用户改引导线或切颜色都不该影响这次已经发出去的请求
    const built = buildRequestImage(rect, mask, rect, S.guides.slice());
    const dataUrl = canvasToDataUrl(built.canvas, 'image/jpeg', 0.94);

    // 小选区上采样后模型看到的图更大，出图尺寸也要相应提高，
    // 否则「输入 832x832、输出 1024x1024」这种组合在某些接口上会被拒。
    const sizeRef = (built.up && built.up.scale > 1)
      ? { w: built.up.upW, h: built.up.upH }
      : rect;
    const selSize = pickOutputSize(sizeRef);

    // 选区在「发给模型的图」里占多大比例，用文字告诉模型该改哪一块。
    // 这是替代「涂蓝色标记」的做法 —— 标记会被模型当成画面内容，导致生成结果偏色。
    const areaPct = built.canvas.width > 0
      ? Math.round(Math.sqrt((rect.w * rect.h) / (built.canvas.width * built.canvas.height)) * 100)
      : 80;
    // 测出周围环境的客观特征，写进提示词 —— 让模型有可对照的目标。
    // 同样必须在发起时测（换图后 S.docCanvas 就不是这一张了）
    const envFitOn = S.cfg.envFit !== false;
    const envMeas = envFitOn ? measureSurroundings(rect) : null;
    const envDesc = envMeas
      ? C.describeEnvironment({ stats: envMeas.stats, plane: envMeas.plane, isZh: lang === 'zh' })
      : '';
    // 引导线：把用户画在选区里的线换算到请求图坐标，再翻译成构图说明写进提示词。
    // 颜色**不在这里指定** —— 每条线自带 colorId（第 1 条红、第 2 条青…），
    // describeGuides 会按它逐条指代。这也正是必须让颜色跟着数据走的原因：
    // 在这里另取一个全局颜色的话，两条线会被说成同一个颜色，指代就废了。
    const selGuides = S.guides.length
      ? C.mapGuidesToRequest({ guides: S.guides, rect, ctxRect: built.rect })
      : [];
    const guideDesc = selGuides.length
      ? C.describeGuides({ guides: selGuides, isZh: lang === 'zh' })
      : '';
    const promptText = C.buildPrompt({
      instruction: $('prompt').value,
      style: $('style-select').value,
      // 整张图必须用「整体处理」的口径。局部口径的提示词会说
      // 「这是一张照片的局部裁切，请修改画面中央约 80% 的区域」，
      // 而请求图此刻就是整张照片 —— 模型会以为自己在改一张裁切图，
      // 于是把边缘当留白参考、缩着改中间，甚至补一圈画面。
      scope: whole ? 'global' : $('scope-select').value,
      hasMask: !!mask,
      centerPct: areaPct,
      language: lang,
      envDesc,                       // 周围环境的客观特征（测出来的，不是编的）
      envFit: envFitOn,
      guideDesc                      // 用户画的构图引导线（位置精确，比文字描述准）
    });
    // 参考图在这时**快照**进任务：之后用户增删参考图不影响这次请求
    const refUrls = refImages.map((r) => r.dataUrl);
    const req = C.buildImageRequest({
      baseUrl: S.cfg.baseUrl,
      apiKey: S.cfg.apiKey,
      model: S.cfg.model,
      prompt: promptText,
      imageDataUrl: kind === 't2i' ? null : dataUrl,
      size: selSize.size, aspectRatio: selSize.aspect,
      seed: S.cfg.seed === '' ? null : Number(S.cfg.seed),
      batch: 1,
      kind,
      imageField: m ? m.imageField : 'image',
      sizeMode: m ? m.sizeMode : 'image_size',
      providerId: S.cfg.provider,
      quality: 'high',
      outputFormat: 'png',
      // 参考图（额外输入的图）。JSON 类接口在这里就被挂进 body 了；
      // multipart 类接口下面单独处理，不会重复添加。
      refDataUrls: refUrls
    });
    // 如实记录参考图去向：发了几张、几张被模型能力截掉了。
    // 用户加了 3 张却只发 1 张时，自检面板必须能看出来 ——
    // 不然他会以为模型不听话，而其实是我们没发出去。
    {
      const used = req.refUsed || 0;
      const capped = req.refCapped || 0;
      if (refUrls.length && used) {
        lastRefNote = '已带 ' + used + ' 张' + (capped ? '（' + capped + ' 张超出模型上限未发）' : '');
      } else if (refUrls.length && !used) {
        lastRefNote = '已加 ' + refUrls.length + ' 张，但当前模型不支持参考图（未发送）';
      } else {
        lastRefNote = '';
      }
    }

    // OpenAI 系的图像编辑接口是 multipart 表单（/v1/images/edits），
    // 必须把图片作为文件字段上传。若打成 JSON 发到 generations，
    // 图片会被静默丢弃，上游只看到文字 → 回一段文字（upstream_text_reply）。
    if (C.needsMultipart(C.resolveEndpoint({
      providerId: S.cfg.provider, kind, imageDataUrl: dataUrl, model: S.cfg.model
    }))) {
      // multipart 路径：参考图在这里以文件形式追加（image[]）。
      // 注意要用**主图字段名**，别处（JSON 路径）已经把参考图挂进 body 了，
      // 这边必须只走 multipart，避免同一张图发两遍、体积翻倍。
      const mp = C.buildMultipartBody({
        imageDataUrl: dataUrl,
        imageField: m ? m.imageField : 'image',
        refDataUrls: refUrls,
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
      // multipart 已经把参考图作为文件带上，body 里就不该再有图的副本
      if (req.body.images) delete req.body.images;
    }

    // 发送前自检：图片没准备好 / 编码异常，就地报清楚，别等接口回一句看不懂的错
    // 自检要读「主图到底在哪」。
    // 多图版模型（如 Qwen-Image-Edit-2509）会把主图并进 images 数组的第一位，
    // 此时 body.image 是 undefined —— 直接读它会让自检误判成「没准备好图片」，
    // 于是加了参考图就完全生成不了（而这是本功能最常见的用法）。
    const mainImg = (() => {
      if (Array.isArray(req.body.images) && req.body.images.length) return req.body.images[0];
      if (req.multipart) return dataUrl;          // multipart 走文件字段，主图就是 dataUrl
      return req.body[m ? m.imageField : 'image'];
    })();
    const check = C.validateImageRequest({
      model: req.body.model,
      prompt: req.body.prompt,
      kind,
      imageField: m ? m.imageField : 'image',
      imageDataUrl: mainImg
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
        const e = new Error('出图尺寸 ' + sentSize + ' 不符合该接口要求：' + sv.reasons.join('；') +
          '\n\n可以试试：框选小一点的区域，或换一个支持更大出图尺寸的模型。');
        e.local = true;
        e.status = 0;
        throw e;
      }
    }

    // 记录上采样情况，供提示与自查
    const upscale = (built.up && built.up.scale > 1)
      ? { from: built.up.srcW + 'x' + built.up.srcH, to: built.up.upW + 'x' + built.up.upH, scale: built.up.scale }
      : null;

    // 记录实际发出的请求，便于排查「上游说没收到图片」这类问题
    const imageBytes = (() => {
      const img = req.body.image || req.body.input_image;
      if (!img || typeof img !== 'string') return 0;
      const i = img.indexOf(',');
      return i > 0 ? Math.round((img.length - i - 1) * 0.75) : 0;
    })();

    // 会话数据也快照一份：如果这张照片还没有作品记录（首次生成），
    // 结果落地时要靠它补建一条「能继续编辑」的记录。
    // 构建失败不影响生成 —— 只是补建出来的记录会退化成「仅预览」。
    let sessionSnapshot = null;
    try { sessionSnapshot = buildSessionPayload(); } catch (e) { sessionSnapshot = null; }

    return {
      id: 'j' + (++S.jobSeq) + '-' + Date.now().toString(36),
      // 归属：结果只能落到这张照片上。
      // workId 可能是 null（这张照片还没被编辑过 → 作品库还没有它的记录）——
      // 这是**首次生成**的常见情形，不能因此丢掉结果。
      // 所以下面同时快照「建记录所需的一切」，落地时按需补建。
      workId: S.workId,
      docVersion: S.docVersion,
      docW: S.docW, docH: S.docH,
      imgW: S.imgW, imgH: S.imgH,
      workName: ($('file-name').textContent || 'photo.jpg').replace(/（已恢复）$/, ''),
      // 底图：补建记录时要用（缩略图给历史列表看，会话数据给「继续编辑」用）。
      // 都在发起时快照 —— 之后用户换图了就拿不到了。
      // 用 docCanvas（不含编辑）而不是 viewCanvas：这张记录代表「这次生成之前的样子」。
      baseThumb: makeThumb(S.docCanvas, C.THUMB_MAX_SIDE),
      session: sessionSnapshot,
      status: 'running',
      seen: false,
      startedAt: Date.now(),
      // 请求所需的全部输入（快照）
      rect,
      mask,
      built,
      req,
      kind,
      promptText,
      // 用户输入框里的**原文**（未经 buildPrompt 加工）。
      // 生成成功后要据此清空输入框，所以必须存原文而不是 promptText ——
      // promptText 里塞了风格、环境描述、出片要求一大堆，和输入框对不上，
      // 拿它做比较永远不相等，清空就永远不会发生。
      promptRaw: String($('prompt').value || ''),
      promptLabel: String($('prompt').value || '').trim().slice(0, 24),
      upscale,
      imageBytes,
      // 排查用：参考图去向、传输方式、字段名。
      // 这些是「参考图有没有真的发出去」的唯一证据，必须跟着任务走。
      refUrls,
      refUsed: req.refUsed || 0,
      transport: req.multipart ? 'multipart' : 'json',
      // 记录**实际发出去的**字段名（有参考图时会自动变成 image[]）。
      // 存配置值没有意义 —— 排查时要看的是请求里到底是什么，
      // 否则日志说 image、实际发 image[]，看日志反而会误判。
      imageField: (function () {
        const base = String((m ? m.imageField : 'image') || 'image').replace(/\[\]$/, '');
        return (refUrls.length > 0 && req.multipart) ? (base + '[]') : base;
      })(),
      guides: selGuides,
      feather: Number(S.cfg.feather) || 0,
      colorMatch: (Number(S.cfg.colorMatch) || 0) / 100,
      aborter: null
    };
  }

  /**
   * 真正发请求并把结果变成一张 patch。
   *
   * 与「准备」分开：准备是同步的（快、会抛本地自检错），
   * 这里是异步的（慢、会抛网络错）。分开之后两段各自好测、好读。
   */
  async function runJob(job) {
    const sel = job.rect;
    const built = job.built;

    // 调用日志：记下「这次请求长什么样」和「多久、成没成、花了多少」
    const callT0 = Date.now();
    const callCost = estimateCallCost();
    const callMeta = {
      provider: S.cfg.provider,
      model: job.req.body.model || S.cfg.model,
      prompt: job.promptText,
      imgW: built.canvas.width, imgH: built.canvas.height,
      imgBytes: job.imageBytes,
      endpoint: job.req.url || job.req.endpoint || '',
      costUsd: callCost.usd,
      costNote: callCost.note,
      // 归属用**任务里记的** workId，不是当前的 —— 用户可能已经换图了
      workId: job.workId || '',
      // ---- 排查用：这几项平时看不出来，但出问题时决定性质 ----
      kind: job.kind || 'edit',
      // 参考图：发了几张、请求体里到底带没带（"参考图不生效"最常见的原因）
      refCount: (job.refUrls || []).length,
      refUsed: job.refUsed === undefined ? 0 : job.refUsed,
      // 是不是 multipart 表单（OpenAI 系走这条），以及**实际发出**的图片字段名
      transport: job.req.multipart ? 'multipart' : 'json',
      imageField: job.imageField || 'image',
      // 请求体大小：太大容易被网关拒（413/502），这是很常见的隐蔽失败原因。
      // JSON 路径也要算 —— 用序列化后的长度，否则永远显示 0。
      bodyBytes: job.req.multipart
        ? (job.req.multipart.body ? job.req.multipart.body.length : 0)
        : (function () {
          try { return JSON.stringify(job.req.body || {}).length; } catch (e) { return 0; }
        })(),
      // 提示词长度（日志里会被截断，这里存真实长度）
      promptLen: (job.promptText || '').length,
      // 是否带了引导线（画进图里的线）
      guideCount: (job.guides || []).length
    };

    let json;
    try {
      json = await callModel(job.req, job.aborter);
    } catch (callErr) {
      recordCallLog(Object.assign({}, callMeta, {
        at: callT0, ms: Date.now() - callT0, ok: false,
        status: callErr && callErr.status ? callErr.status : 0,
        error: describeCallError(callErr)
      }));
      throw callErr;
    }
    const items = C.parseImageResponse(json);
    // HTTP 通了但没拿到图片（最常见的是模型是对话模型，回了一段文字）——
    // 这同样是一次「花了钱没拿到结果」的调用，必须按失败记，
    // 否则日志里会出现一条「成功但没图」，用户根本看不出问题在哪
    if (!items.length) {
      recordCallLog(Object.assign({}, callMeta, {
        at: callT0, ms: Date.now() - callT0, ok: false, status: 200,
        error: '接口没有返回图片' + (() => {
          try {
            const d = C.diagnoseResponse(json, 200, { model: S.cfg.model });
            return d && d.title ? ' · ' + d.title : '';
          } catch (e2) { return ''; }
        })()
      }));
      const e = new Error('接口没有返回图片');
      e.status = 200;
      e.json = json;
      e.text = JSON.stringify(json);
      throw e;
    }
    recordCallLog(Object.assign({}, callMeta, {
      at: callT0, ms: Date.now() - callT0, ok: true, status: 200, error: ''
    }));

    let blob;
    if (items[0].dataUrl) {
      const r = await fetch(items[0].dataUrl);
      blob = await r.blob();
    } else {
      blob = await urlToBlob(items[0].url);
    }
    const gen = await blobToCanvas(blob);

    // 关键一步：从模型返回图里取出「选区」对应的内容。
    // 请求图带上下文外扩（built.off 记录选区在请求图里的位置），
    // 且模型返回尺寸与请求尺寸往往不同 —— 必须两步换算，否则内容会整体偏移。
    // 如果请求图被上采样过，坐标换算必须用「放大后的」位置与尺寸。
    const up = built.up;
    const crop = C.mapSelectionToResult({
      genW: gen.width, genH: gen.height,
      reqW: built.canvas.width, reqH: built.canvas.height,
      offX: up ? up.off.x : built.off.x,
      offY: up ? up.off.y : built.off.y,
      selW: up ? up.upW : sel.w,
      selH: up ? up.upH : sel.h
    });

    // 把结果绘制到临时画布（不变形）。
    // 若请求图被上采样过，这里刻意「多留分辨率」：按放大后的尺寸存 patch，
    // 贴回时再缩到选区大小。这样模型输出的高分辨率细节能保留到最后一步，
    // 而不是先缩到 100x100 再放大贴回（那样会糊两次）。
    const storeW = (up && up.scale > 1) ? Math.max(sel.w, Math.round(sel.w * up.scale)) : sel.w;
    const storeH = (up && up.scale > 1) ? Math.max(sel.h, Math.round(sel.h * up.scale)) : sel.h;
    const patchCanvas = makeCanvas(storeW, storeH);
    const tctx2 = patchCanvas.getContext('2d', { willReadFrequently: true });
    tctx2.imageSmoothingEnabled = true;
    tctx2.imageSmoothingQuality = 'high';
    tctx2.drawImage(gen, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, storeW, storeH);

    return {
      patch: patchCanvas,
      aspectMismatch: C.aspectMismatch(gen.width, gen.height, sel.w, sel.h)
    };
  }

  /**
   * 发起一次生成。
   *
   * 流程：准备任务（同步，会抛本地自检错）→ 注册任务 → 异步执行 →
   *       结果按 planJobLanding 决定去处（当前照片的对比图 / 那件作品的记录）。
   *
   * 与旧实现最大的区别：**不再 abort 在途请求**。
   * 用户回首页 / 换图时任务继续跑，结果落进它自己那件作品的记录里。
   */
  async function runGenerate() {
    // 开始生成前先确认通知权限：这次跑完要发通知，
    // 没权限的话用户就等于什么都收不到（表现就是「无法发通知」）。
    ensureNotifyReady();
    const job = (() => {
      try {
        return prepareJob();
      } catch (err) {
        // 本地自检失败：就地报清楚，别发出去白等一次
        setBusy(false);
        showGenError(err, { kind: 'edit', model: S.cfg.model, baseUrl: S.cfg.baseUrl });
        console.error('[枫叶修图] 生成准备失败', err);
        return null;
      }
    })();
    if (!job) return;

    job.aborter = new AbortController();
    S.jobs.push(job);
    lastSelRect = job.rect;
    // 先让保活真正开起来（setBusy → syncKeepAlive 会同步 S.keepAliveState），
    // 再判断要不要提醒。顺序反了的话 keepAliveState 还是上一次的 idle，
    // 提醒永远不出现 —— 而这条提醒恰恰是「切走不会中断」的唯一告知。
    setBusy(true, '正在生成…', '正在请求生图模型');

    // 「生成时保活」提醒只显示一次（老用户不需要再被教一遍）
    {
      const notice = C.planGenForegroundNotice({
        supported: S.keepAliveSupported,
        enabled: S.cfg.keepAlive !== false,
        keepAlive: S.keepAliveState,
        seen: hintSeen('gen-keepalive')
      });
      if (notice.show) { markHintSeen('gen-keepalive'); toast(notice.text, 6000); }
    }
    clearErrorPanel();
    refreshJobsUI();

    // 立刻告诉用户「可以走，结果不会丢」——这是这个功能存在的意义
    toast('已开始生成 · 可以切到别的照片，好了会通知你', 3600);

    try {
      const r = await runJob(job);
      job.patch = r.patch;
      job.status = 'done';
      job.finishedAt = Date.now();
      job.aborter = null;

      // 累计花费（每次实际调用都算，无论结果落在哪）
      const spent = currentEstimate();
      if (spent) S.spend = C.accumulateSpend(S.spend, spent);

      // 成功之后清空输入框，省得手动删掉上一次的描述。
      // 三个前提都必须满足，缺一个就会误伤：
      //   1) 只在**成功**时清 —— 失败时用户要照着原话改一改重试，
      //      清了等于把他刚写的东西弄丢（而重试按钮也靠它）
      //   2) 只在用户还在这张照片上时清 —— 他已经切到别的照片去写新描述了，
      //      这时清空会把那张照片上正在写的字抹掉
      //   3) 清的是**那次生成用的快照**对应的输入框内容（见 promptRaw），
      //      期间用户改了字（说明在写新的），就不清，别打断他
      if (job.docVersion === S.docVersion) clearPromptIfUnchanged(job.promptRaw);

      landJob(job, r);
    } catch (err) {
      job.aborter = null;
      if (err && err.name === 'AbortError') {
        job.status = 'canceled';
        if (!err.stale) toast('已取消生成');
      } else {
        job.status = 'failed';
        job.error = err;
        // 只有「用户还在看这张照片」时才弹错误面板：
        // 用户已经换到别的照片了，往他脸上弹一个上一张的报错会让人莫名其妙
        const stillHere = job.docVersion === S.docVersion && !!S.img;
        if (stillHere) showGenError(err, { kind: job.kind, model: S.cfg.model, baseUrl: S.cfg.baseUrl });
        else toast('后台生成失败：' + ((err && err.message) || '未知错误'), 4200);
        // 失败也必须发通知，且把原因带上 ——
        // 只写「生成失败」等于让用户回到应用再猜一遍为什么。
        // 原因做截断（通知栏只有一行可见），完整信息仍在错误面板里。
        const why = (err && (err.message || (err.json && err.json.error && err.json.error.message))) || '未知错误';
        notifyGenDone('生成失败：' + String(why).replace(/\s+/g, ' ').slice(0, 60));
        console.error('[枫叶修图] 生成失败', err);
      }
      pruneJobs();
      refreshJobsUI();
    }
  }

  /**
   * 结果落地：按 planJobLanding 决定去处。
   *
   * 这是整个后台生成功能最关键的一步 —— 三条路必须恰好走一条：
   *   1. 用户还在同一张照片上 → 走对比图（原来的流程，用户能立刻看到）
   *   2. 用户在别处 → 存进那件作品的记录（**不丢**）+ 角标 + 通知
   *   3. 实在没地方可落（连作品库都没有）→ 明确告诉用户，不假装成功
   */
  function landJob(job, r) {
    const plan = C.planJobLanding({
      jobWorkId: job.workId,
      jobDocVersion: job.docVersion,
      curWorkId: S.workId,
      curDocVersion: S.docVersion,
      hasPhoto: !!S.img && !!S.docCanvas,
      hasLibrary: true
    });

    if (plan.target === 'compare') {
      // 路径 1：用户就在这张照片上，走原来的「对比图」
      S.pending = {
        patch: job.patch,
        rect: job.rect,
        feather: job.feather,
        colorMatch: job.colorMatch,
        mask: job.mask,
        docVersion: job.docVersion,
        label: job.promptLabel
      };
      job.seen = true;
      showCompare();
      refreshJobsUI();
      // 生成完就发通知 —— 不再只在「切走了」时才发。
      // 用户可能在应用里做别的事（看历史、改设置），系统通知能让他不盯屏幕也知道好了。
      notifyGenDone('生成完成，点开对比效果');
      if (job.upscale && job.upscale.scale > 1.05) {
        toast('生成完成（选区较小，已放大 ' + job.upscale.scale.toFixed(1) +
          ' 倍发送，贴回时按原分辨率还原）', 3600);
      } else {
        toast('生成完成，拖动中间竖线对比效果', 3000);
      }
      return;
    }

    if (plan.target === 'library') {
      // 路径 2：用户在别处 —— 把结果存进那件作品的记录里，绝不丢
      const ok = stashJobResult(job, r);
      if (ok) {
        job.seen = false;
        notifyGenDone('后台生成完成，回到那张照片即可贴回');
        toast('后台生成完成 · 回到「' + (job.workName || '那张照片') + '」就能贴回', 4200);
      } else {
        job.status = 'failed';
        job.error = new Error('结果无处可存');
        toast('后台生成完成，但没能存进修图记录（空间不足？）', 4200);
      }
      pruneJobs();
      refreshJobsUI();
      return;
    }

    // 路径 3：无处可落 —— 明确告知，不假装成功
    job.status = 'failed';
    job.error = new Error('结果无处可存');
    toast('后台生成完成，但这张照片没有可存放的记录', 4200);
    pruneJobs();
    refreshJobsUI();
  }

  /**
   * 把后台任务的结果存进作品库。
   *
   * 为什么不能直接改 S.edits：用户当前可能在编辑**另一张**照片，
   * 往 S.edits 里塞就把结果贴错图了（用户明确点出的第一个失败模式）。
   *
   * 做法：把结果编码成一张缩略图大小的预览 + 一个「待贴回」的补丁数据，
   * 挂在作品记录上。用户回到那张照片时（continueWork）自动贴回。
   *
   * @returns {boolean} 是否成功存下
   */
  function stashJobResult(job, r) {
    try {
      let rec = job.workId ? S.library.find((e) => e.id === job.workId) : null;
      if (!rec) {
        // 这张照片还没有作品记录 —— 首次生成就是这样（touchWork 只在有编辑时才建记录）。
        // 此时**必须补建一条**，否则结果无处可存、白花钱。
        // 用任务快照里的信息建：缩略图取「生成之前的底图」，
        // 这样记录在历史里看起来就是「这张照片 + 一次待贴回的生成」。
        const newId = job.workId || newWorkId();
        rec = {
          id: newId,
          at: Date.now(),
          createdAt: job.startedAt || Date.now(),
          name: job.workName || 'photo.jpg',
          imgW: job.imgW || job.docW,
          imgH: job.imgH || job.docH,
          docW: job.docW, docH: job.docH,
          edits: 0,
          thumb: job.baseThumb || '',
          before: '',
          // 会话：从任务快照里补。没有它用户点这条记录就没法回到那张照片，
          // 也就看不到结果 —— 那等于白生成。
          // 会话构建失败（编码异常等）时留 null：记录仍在历史里，结果仍能贴到
          // 当前打开的照片上（见 landOrphanResult），不假装成功。
          session: job.session || null
        };
        S.library.unshift(rec);
        job.workId = newId;
      } else {
        job.workName = rec.name;
      }

      // 结果 patch 编码成 dataURL。体积和「继续编辑」的会话 patch 一个量级，
      // 用同一套 JPEG 质量即可。
      const patchUrl = r.patch.toDataURL('image/jpeg', 0.85);
      rec.bgResult = {
        at: Date.now(),
        rect: { x: job.rect.x, y: job.rect.y, w: job.rect.w, h: job.rect.h },
        patch: patchUrl,
        patchW: r.patch.width, patchH: r.patch.height,
        feather: job.feather,
        colorMatch: job.colorMatch,
        label: job.promptLabel,
        docVersion: job.docVersion,
        // 掩膜也存下来：画笔排除的区域贴回时同样不能动
        mask: job.mask ? C.packMask(job.mask) : null,
        maskLen: job.mask ? job.mask.length : 0
      };
      // 结果属于这张照片，标记一下让首页能显示「已生成，点开看」
      saveLibrary();
      return true;
    } catch (e) {
      console.warn('[枫叶修图] 后台结果存入作品库失败', e);
      return false;
    }
  }

  /**
   * 兜底：作品记录没有会话（底图已丢），但挂着一个后台生成的结果。
   *
   * 用户点它就是想看结果。做法：把结果作为一条独立编辑贴到**当前打开的照片**上，
   * 然后清掉暂存。这不算「贴错图」—— 用户是主动点这条记录要求看结果的，
   * 而且我们会明确告诉他贴到了哪张上。
   */
  async function landOrphanResult(rec) {
    if (!S.docCanvas || !S.viewCanvas) {
      toast('先打开一张照片，再回来看这条结果');
      return;
    }
    const applied = await applyStashedResult(rec);
    if (applied) {
      markJobsSeen(rec.id);
      renderHome();
    } else {
      toast('这条结果无法贴回（数据损坏）');
    }
  }

  /**
   * 把作品记录里挂着的后台结果贴回当前文档。
   *
   * 在 continueWork（用户回到那张照片）之后调用。
   * 只贴属于**这份文档**的结果：记录里的 docVersion 与当前不一致时说明
   * 用户后来又改过（那份状态已经包含或不包含这个结果），跳过更安全。
   */
  async function applyStashedResult(rec) {
    if (!rec || !rec.bgResult || !S.docCanvas) return false;
    const bg = rec.bgResult;
    try {
      const patch = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = bg.patch;
      });
      const pc = makeCanvas(bg.patchW || patch.width, bg.patchH || patch.height);
      pc.getContext('2d').drawImage(patch, 0, 0);

      const edit = {
        rect: bg.rect,
        patch: pc,
        feather: bg.feather,
        colorMatch: bg.colorMatch,
        mask: bg.mask ? C.unpackMask(bg.mask, bg.maskLen) : null,
        opacity: 1,
        enabled: true,
        label: bg.label || '后台生成',
        createdAt: Date.now()
      };
      const tmp = makeCanvas(S.docW, S.docH);
      const tctx = tmp.getContext('2d', { willReadFrequently: true });
      tctx.drawImage(S.viewCanvas, 0, 0);
      compositeEditInto(tctx, edit);
      S.viewCanvas = tmp;
      S.viewCtx = tctx;
      S.edits.push(edit);
      recordUndo({
        type: 'add-layer', layer: edit, index: S.edits.length - 1,
        label: '后台生成：' + (edit.label || '')
      });
      rec.bgResult = null;          // 贴回后清掉，避免下次重复贴
      S.docRev++;
      enforceHistoryBudget();
      scheduleSessionSave();
      scheduleWorkSave();
      renderLayers();
      updateUI();
      draw();
      toast('已把后台生成的结果贴回这张照片', 3600);
      return true;
    } catch (e) {
      console.warn('[枫叶修图] 贴回后台结果失败', e);
      return false;
    }
  }

  /* ====================== 成本预估 ====================== */

  /**
   * 算当前选区的预估成本。
   * 一次点击 = 一次调用（整块选区一次生成，不再分块）。
   */
  function currentEstimate() {
    // 没有框选 = 整张图（见 effectiveRect）：成本预估也要照常给，
    // 否则用户点生成前看不到要花多少钱
    const rect = effectiveRect();
    if (!rect) return null;
    const m = currentModelParams();
    return C.estimateCost({
      rect,
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
      '共 1 次模型调用（整块选区一次生成）。\n\n要继续吗？';
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
      if (e.grade) {
        // 调色图层没有 patch，显示「改了什么色调」比显示覆盖率有用得多
        sub.textContent = e.rect.w + '×' + e.rect.h + ' · ' + C.describeGrade(e.grade);
      } else {
        const cov = C.layerCoverage(e, e.rect.w, e.rect.h);
        sub.textContent = e.rect.w + '×' + e.rect.h +
          ' · 覆盖约 ' + Math.round(cov * 100) + '%' +
          (e.downscaled ? ' · 已降采样' : '');
      }
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
      // 滑块值 → 图层内部值。
      // feather 存像素数、grade 各参数存 -100~100 的整数（与滑块一致），
      // 其余（opacity/colorMatch/fusion）存 0~1 的比例。
      const GRADE_KEYS = C.GRADE_PARAMS.map((p) => p.key);
      const normalizeParam = (k, v) => (k === 'feather' || GRADE_KEYS.indexOf(k) >= 0 ? v : v / 100);

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
        // 图层参数滑块同样只允许拖滑块头：这几个滑块上下紧挨着，
        // 想微调「效果强度」时点到轨道上会直接归零（等于把这次修改关掉）
        thumbOnlySlider(input);
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

      // 调色图层：参数是色调本身，而不是「接缝技术参数」。
      // 直接改 S.edits[i].grade 并重绘 —— 和别的图层参数一样，不调用模型。
      if (e.grade) {
        for (const gp of C.GRADE_PARAMS) {
          item.appendChild(mkParam(gp.zh, Math.round(e.grade[gp.key]), gp.min, gp.max, 1,
            (v) => (v > 0 ? '+' + Math.round(v) : String(Math.round(v))), gp.key,
            (v) => {
              S.edits[i].grade[gp.key] = v;
              rebuildViewCanvas(); draw();
            }));
        }
        // 调色也需要边缘过渡（不然边界会有可见的色块分界）
        item.appendChild(mkParam('边缘羽化', Math.round(e.feather), 0, 60, 1,
          (v) => v + ' px', 'feather',
          (v) => {
            S.edits[i].feather = v;
            rebuildViewCanvas(); draw();
          }));
        const note0 = document.createElement('div');
        note0.className = 'layer-note';
        note0.textContent = '调色不调用模型，改参数立即生效、不花钱';
        item.appendChild(note0);
        list.appendChild(item);
        continue;
      }

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

      // 无缝融合：修正「生成块和周围环境不契合」的主要手段
      const curFusion = e.fusion == null ? (S.cfg.fusion != null ? S.cfg.fusion : 0.7) : e.fusion;
      item.appendChild(mkParam('无缝融合', Math.round(curFusion * 100), 0, 100, 1,
        (v) => v + '%', 'fusion',
        (v) => {
          S.edits[i].fusion = v / 100;
          rebuildViewCanvas(); draw();
        }));

      // 契合度评分：让用户知道「现在贴得好不好」、该往哪调
      const assess = assessLayerSeam(S.edits[i]);
      if (assess) {
        const sc = document.createElement('div');
        sc.className = 'layer-score' + (assess.score >= 80 ? ' good' : assess.score >= 55 ? ' fair' : ' poor');
        sc.innerHTML = '<span class="ls-num">' + assess.score + '</span>' +
          '<span class="ls-lbl">契合度</span>' +
          (assess.issues.length
            ? '<span class="ls-issues">' + esc(assess.issues.join(' · ')) + '</span>'
            : '<span class="ls-issues">接缝看不出差异</span>');
        item.appendChild(sc);
      }

      const note = document.createElement('div');
      note.className = 'layer-note';
      note.textContent = '调整这些参数不会重新生成，可随时改动';
      item.appendChild(note);

      list.appendChild(item);
    }
    refreshHistoryIfOpen();
  }

  // 历史面板若开着就跟着刷新。
  // 用 guard 防止「renderHistory → renderLayers → renderHistory」绕成死循环；
  // batching 期间跳过（预览时要连续走很多步，逐帧重绘纯属浪费）。
  let histRendering = false;
  let histBatching = false;
  function refreshHistoryIfOpen() {
    if (histRendering || histBatching) return;
    const el = $('history');
    if (!el || el.hidden) return;
    histRendering = true;
    try { renderHistory(); } finally { histRendering = false; }
  }

  function openLayers() {
    $('layers').hidden = false;
    renderLayers();
  }
  function closeLayers() { $('layers').hidden = true; }

  /* ============================ 历史时间线 ============================ */

  /**
   * 历史时间线。
   *
   * 关键设计：**不存图片快照**，直接复用撤销栈里的差异命令。
   * 时间线上的位置 = 已执行了多少条命令；「跳回某一步」= 连续撤销/重做。
   * 所以 100 步历史的内存开销和现在一样（只多了几个命令对象）。
   *
   * 预览：先记下现场，再真正执行撤销/重做，用户看到的就是那一步的真实画面
   * （而不是缩略图近似）。确认就保留，取消就把现场恢复回去。
   */

  function currentTimeline() {
    if (!undoStack) return { items: [], cursor: 0 };
    return C.buildTimeline(undoStack, { edits: S.edits, strokes: S.strokes });
  }

  function openHistory() {
    $('history').hidden = false;
    renderHistory();
  }

  function closeHistory() {
    // 关闭面板时若还在预览，恢复现场，避免用户以为改动生效了
    if (S.histPreview) cancelHistoryPreview(true);
    $('history').hidden = true;
  }

  /* ============================ 作品库（跨天记录） ============================ */

  /**
   * 作品库：把「修过的每一张照片」记下来，跨天保留。
   *
   * 和上面「历史时间线」的区别：
   *   时间线 = 当前这张图的操作步骤（换图就没了）
   *   作品库 = 历史上修过的所有照片（昨天修的，今天还看得到）
   *
   * 存储是分层的，因为 localStorage 只有 ~5MB：
   *   - 缩略图：每条都存，保证「看得见」
   *   - 完整会话：预算够时才存，保证「能继续编辑」
   *   - 超预算：先丢老条目的会话（保缩略图），再不够才整条淘汰
   */

  /** 生成一个作品 id（时间戳 + 随机后缀，避免同一毫秒内重复） */
  function newWorkId() {
    return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ====================== 大容量存储（作品库专用） ======================
   *
   * 背景：WebView 的 localStorage 只有约 5MB。一张照片的「可继续编辑」
   * 数据约 0.8MB，于是一共只存得下 3 张 —— 第 4 张开始，最早的记录
   * 会被降级成「只能看预览，点进去变回原图」。这是用户反复反馈的问题。
   *
   * 解决：安卓壳里通过原生桥把作品库写到应用私有目录（几 GB 可用），
   * localStorage 只保留一份**极小的索引**（给旧版本/浏览器兜底）。
   *
   * 设计要点：
   *   - 浏览器里没有桥 → 自动退回 localStorage，功能不缺失，只是张数少
   *   - 文件读取是同步桥调用，启动时一次，可接受
   *   - 写入失败（磁盘满）→ 退回 localStorage，绝不让历史凭空消失
   */

  /** 作品库文件名（原生侧会校验只允许安全字符） */
  const KV_LIBRARY_FILE = 'library.json';

  /** 原生大容量存储是否可用（有桥且接口存在） */
  function kvStorageAvailable() {
    const b = bridge();
    return !!(b && typeof b.kvWrite === 'function' && typeof b.kvRead === 'function');
  }

  /** 把作品库写到文件。返回 true 表示已成功落盘 */
  function kvSaveLibrary(list) {
    if (!kvStorageAvailable()) return false;
    const b = bridge();
    try {
      const payload = JSON.stringify({ v: 2, at: Date.now(), items: list });
      const n = b.kvWrite(KV_LIBRARY_FILE, payload);
      return typeof n === 'number' && n >= 0;
    } catch (e) {
      console.warn('[枫叶修图] 作品库写入文件失败', e);
      return false;
    }
  }

  /** 从文件读作品库。返回 null 表示「没有存档」（区别于「空库」） */
  function kvLoadLibrary() {
    if (!kvStorageAvailable()) return null;
    const b = bridge();
    try {
      const raw = b.kvRead(KV_LIBRARY_FILE);
      if (!raw) return null;
      const j = JSON.parse(raw);
      const items = (j && Array.isArray(j.items)) ? j.items : [];
      return items.map(C.normalizeWork).filter((e) => e.id);
    } catch (e) {
      console.warn('[枫叶修图] 作品库文件读取失败', e);
      return null;
    }
  }

  function loadLibrary() {
    // 1) 优先读文件（大容量，能存几十上百张）
    const fromFile = kvLoadLibrary();
    if (fromFile && fromFile.length) {
      S.libraryStore = 'file';
      // 顺手把文件里的内容同步一份到 localStorage 作为索引备份？
      // **不要**：那会把 5MB 配额又占满，回到老问题。
      // 只在文件不可用时才需要 localStorage 兜底，见下面。
      return fromFile;
    }
    // 2) 文件里没有（首次升级 / 浏览器环境）→ 读 localStorage
    try {
      const raw = localStorage.getItem(LS_KEY_LIBRARY);
      if (!raw) { S.libraryStore = kvStorageAvailable() ? 'file' : 'local'; return []; }
      const j = JSON.parse(raw);
      const list = (j && Array.isArray(j.items)) ? j.items : [];
      const out = list.map(C.normalizeWork).filter((e) => e.id);
      // 老数据在 localStorage 里 → 迁移到文件，然后**清掉旧键**释放 5MB。
      // 这是升级后"历史条数不变但突然能存更多"的关键一步。
      if (out.length && kvStorageAvailable() && kvSaveLibrary(out)) {
        try { localStorage.removeItem(LS_KEY_LIBRARY); } catch (e2) { /* ignore */ }
        S.libraryStore = 'file';
        console.info('[枫叶修图] 作品库已从 localStorage 迁移到文件（' + out.length + ' 条）');
      } else {
        S.libraryStore = 'local';
      }
      return out;
    } catch (e) {
      console.warn('[枫叶修图] 作品库读取失败，将从空开始', e);
      return [];
    }
  }

  /** 落盘。返回是否成功（超配额会失败，交给调用方决定怎么退让） */
  function saveLibrary() {
    // 有大容量存储（安卓壳）→ 直接写文件，**不再受 5MB 限制**。
    // 这里仍要跑一次 planLibrary，但预算换成文件预算（几十 MB），
    // 于是几乎不会触发降级 —— 「点进去变回原图」的问题从根上消失。
    if (kvStorageAvailable()) {
      const plan = C.planLibrary(S.library, {
        maxBytes: C.FILE_LIBRARY_BUDGET_BYTES,
        maxItems: C.LIBRARY_MAX_ITEMS,
        sessionBudgetBytes: C.FILE_LIBRARY_BUDGET_BYTES,
        pinnedId: S.workId
      });
      if (plan.downgradeIds.length) {
        for (const e of S.library) {
          if (plan.downgradeIds.includes(e.id)) e.session = null;
        }
      }
      if (plan.evictIds.length) {
        S.library = S.library.filter((e) => !plan.evictIds.includes(e.id));
      }
      if (plan.note) S.libraryNote = plan.note;
      if (kvSaveLibrary(S.library)) {
        S.libraryStore = 'file';
        // 文件写成功就把 localStorage 里那份清掉，把 5MB 让给别处
        try {
          if (localStorage.getItem(LS_KEY_LIBRARY)) localStorage.removeItem(LS_KEY_LIBRARY);
        } catch (e3) { /* ignore */ }
        return true;
      }
      // 文件写失败（磁盘满 / 权限异常）→ 落到下面的 localStorage 路径，
      // 宁可少存几张，也不能让用户以为"保存成功"。
      console.warn('[枫叶修图] 作品库写文件失败，退回 localStorage');
    }

    try {
      const plan = C.planLibrary(S.library, {
        maxBytes: C.LIBRARY_BUDGET_BYTES,
        maxItems: C.LIBRARY_MAX_ITEMS,
        // 会话单独一层预算：缩略图很便宜（几十 KB），会话很贵（可上 MB）。
        // 不分开管的话，一张大图的会话就能把整个库挤成「只剩一条」。
        sessionBudgetBytes: C.SESSION_BUDGET_BYTES,
        pinnedId: S.workId
      });
      // 执行降级：丢掉完整会话，只留缩略图（**记录本身留着**，用户仍看得见）
      if (plan.downgradeIds.length) {
        for (const e of S.library) {
          if (plan.downgradeIds.includes(e.id)) e.session = null;
        }
      }
      // 执行淘汰
      if (plan.evictIds.length) {
        S.library = S.library.filter((e) => !plan.evictIds.includes(e.id));
      }
      if (plan.note) S.libraryNote = plan.note;
      localStorage.setItem(LS_KEY_LIBRARY, JSON.stringify({ v: 1, items: S.library }));
      return true;
    } catch (e) {
      // 配额真的满了（浏览器给每个源的额度不同，可能远小于预算）。
      // 兜底顺序：先丢**老记录的会话**（保住列表可见性），再不行才丢整条记录 ——
      // 之前的兜底直接 slice(0,5) 砍记录，用户会莫名丢历史。
      try {
        const keep = S.library.slice(0, 12);
        const slim = keep.map((x, i) => (i === 0 || x.id === S.workId)
          ? x
          : Object.assign({}, x, { session: null }));
        S.library = slim;
        localStorage.setItem(LS_KEY_LIBRARY, JSON.stringify({ v: 1, items: S.library }));
        S.libraryNote = '存储空间紧张，较早记录的编辑数据已转为仅保留预览';
        return true;
      } catch (e2) {
        console.warn('[枫叶修图] 作品库保存失败（空间不足）', e2);
        return false;
      }
    }
  }

  /** 把画布缩成小图（作品库的预览图，控制在几十 KB） */
  function makeThumb(canvas, maxSide) {
    if (!canvas || !canvas.width || !canvas.height) return '';
    const ms = Math.max(48, Math.round(Number(maxSide) || C.THUMB_MAX_SIDE));
    const scale = Math.min(1, ms / Math.max(canvas.width, canvas.height));
    const w = Math.max(1, Math.round(canvas.width * scale));
    const h = Math.max(1, Math.round(canvas.height * scale));
    try {
      const t = makeCanvas(w, h);
      const tc = t.getContext('2d', { willReadFrequently: true });
      tc.imageSmoothingEnabled = true;
      tc.imageSmoothingQuality = 'high';
      tc.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, w, h);
      return t.toDataURL('image/jpeg', C.THUMB_QUALITY);
    } catch (e) {
      return '';
    }
  }

  /**
   * 把当前这张照片写进作品库（有编辑才记）。
   *
   * 用 workId 做「原地更新」：同一张照片反复编辑只占一条记录，
   * 不会每改一次就多出一条。
   */
  function touchWork() {
    if (!S.docCanvas || !S.viewCanvas) return;
    if (!S.edits.length) return;              // 没改过就不记，避免堆一堆原图
    if (!S.workId) { S.workId = newWorkId(); S.workStartedAt = Date.now(); }

    const rec = {
      id: S.workId,
      at: Date.now(),
      createdAt: S.workStartedAt || Date.now(),
      name: ($('file-name').textContent || 'photo.jpg').replace(/（已恢复）$/, ''),
      imgW: S.imgW, imgH: S.imgH,
      docW: S.docW, docH: S.docH,
      edits: S.edits.length,
      thumb: makeThumb(S.viewCanvas, C.THUMB_MAX_SIDE),
      before: '',
      session: null
    };

    // 完整会话：预算够就存，让用户能「继续编辑」。
    //
    // 这里**只做「单条太大就先不存」的自保**，具体留几条由 saveLibrary 里的
    // planLibrary 统一裁决 —— 之前在这里按「整库 60%」判断，一条 3072px 大图的
    // 会话（UTF-16 后近 3MB）永远超不过判断线，但会把库里其它条目全挤掉。
    // 分成两处判断还会互相打架：这里以为放得下，planLibrary 那边又降级掉。
    const payload = buildSessionPayload();
    if (payload) {
      const probe = Object.assign({}, rec, { session: payload });
      const probeBytes = C.estimateWorkBytes(probe);
      // 单条上限：localStorage 下是总预算的一半（存下去会把整库挤空），
      // 文件存储下则宽松得多 —— 那边的预算本来就是 240MB，
      // 一条 1MB 的会话完全不值得为它放弃「可继续编辑」。
      const singleLimit = kvStorageAvailable()
        ? C.FILE_LIBRARY_BUDGET_BYTES * 0.5
        : C.LIBRARY_BUDGET_BYTES * 0.5;
      if (probeBytes <= singleLimit) {
        rec.session = payload;
      } else {
        // 不静默：告诉用户为什么这张不能继续编辑
        S.libraryNote = '这张图较大，编辑数据未存档（只能看预览，不能继续编辑）';
      }
    } else if (S.edits.length) {
      // payload 为 null 但有编辑 = 这次什么都没能存下来（编辑数据超上限）。
      // 必须记下来：不记的话 rec.session 是 null，首页不会标「可继续编辑」，
      // 用户点进去只会看到预览 —— 至少不会以为「保存成功却变回原图」。
      S.libraryNote = '编辑数据太大，这张只保存了预览（不能继续编辑）';
    }

    const i = S.library.findIndex((e) => e.id === S.workId);
    if (i >= 0) S.library[i] = rec; else S.library.unshift(rec);
    saveLibrary();
    updateLibraryBadge();
    // 首页就是「修改历史」，记录变了要立刻反映出来
    if (isHomeVisible()) renderHome();
  }

  /** 防抖保存：编辑过程中频繁写 localStorage 会卡 */
  let workSaveTimer = null;
  // 会话保存的防抖定时器。声明放在这里而不是「会话保存」那一节，
  // 是因为 forceSaveNow() 要先把它取消掉 —— 用 let 声明在后面的块里，
  // 调用方就落在 TDZ 里，运行时直接抛错。
  let sessionSaveTimer = null;
  function scheduleWorkSave() {
    clearTimeout(workSaveTimer);
    workSaveTimer = setTimeout(() => {
      try { touchWork(); } catch (e) { /* ignore */ }
      // 存完了要立刻把「未保存」标记去掉 —— 否则用户会一直以为还没存，
      // 反复去点「保存修改」。
      try { syncSaveNowUI(); } catch (e2) { /* ignore */ }
    }, 1600);
    // 刚改了东西、还没落盘：菜单里要能立刻看到「未保存」
    try { syncSaveNowUI(); } catch (e3) { /* ignore */ }
  }

  /** 最近一次「主动/强制保存」的时间与结果（给界面显示） */
  let lastSaveAt = 0;
  let lastSaveOk = null;

  /**
   * 立刻、同步地把当前编辑存起来（跳过 1.6 秒防抖）。
   *
   * 为什么需要：防抖保存意味着「刚刚那一下改动」最多有 1.6 秒还在内存里。
   * 用户改完立刻按返回 / 退出 / 被系统回收，那一下就可能没了 ——
   * 日志里「历史记录丢修改」十有八九是这个时间窗。
   *
   * 返回是否真的写进去了。**写失败必须让用户知道**：
   * 磁盘满 / 通道异常时如果还提示「已保存」，等于骗人。
   *
   * @param {{silent?:boolean}} opt silent = 不弹提示（用于自动兜底）
   * @returns {{ok:boolean, why:string, edits:number}}
   */
  function forceSaveNow(opt) {
    // 外层只负责「存完刷新界面」：内部有多条返回路径（没照片 / 没改动 /
    // 写失败 / 部分成功），每条都手动刷一次界面很容易漏。
    // 漏掉的表现是：文件其实存好了，菜单里还写着「未保存」，
    // 用户会以为没存住，反复点、最后干脆不敢退出。
    const r = forceSaveNowInner(opt);
    try { syncSaveNowUI(); } catch (e) { /* 刷新失败不该影响保存结果 */ }
    return r;
  }

  function forceSaveNowInner(opt) {
    const o = opt || {};
    clearTimeout(workSaveTimer);
    workSaveTimer = null;
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = null;

    const result = { ok: false, why: '', edits: S.edits ? S.edits.length : 0 };
    if (!S.docCanvas || !S.viewCanvas) {
      result.why = '还没有打开照片';
      if (!o.silent) toast(result.why);
      return result;
    }
    if (!result.edits) {
      result.why = '这张照片还没有任何修改，不需要保存';
      if (!o.silent) toast(result.why, 2600);
      return result;
    }

    // 1) 作品库（历史记录里能点进去继续编辑的那份）—— 这是用户真正怕丢的东西
    try {
      touchWork();
    } catch (e) {
      console.warn('[枫叶修图] 主动保存：作品库写入异常', e);
      result.why = '保存出错：' + ((e && e.message) || '未知原因');
      lastSaveOk = false;
      if (!o.silent) toast(result.why, 3600);
      return result;
    }

    // 2) 核对：记录真的在库里，并且带上了可恢复的编辑数据。
    //    只信 touchWork 没抛异常是不够的 —— 它在「单条太大」时会
    //    主动放弃 session，那种情况下用户点进去还是变原图。
    const rec = (S.library || []).filter((e) => e.id === S.workId)[0];
    if (!rec) {
      result.why = '保存失败：记录没有写进作品库';
      lastSaveOk = false;
      if (!o.silent) toast(result.why, 3600);
      return result;
    }

    // 3) 会话兜底：万一这张图的编辑数据没法进作品库（体积超限），
    //    至少把「未完成的编辑」留在本地，下次打开还能恢复。
    let sessionOk = !!rec.session;
    if (!sessionOk) {
      try {
        const payload = buildSessionPayload();
        if (payload) {
          localStorage.setItem(LS_KEY_SESSION, JSON.stringify(payload));
          lastSavedSession = payload;
          sessionOk = true;
        }
      } catch (e2) { /* 兜底失败不额外报，下面统一说明 */ }
      if (sessionOk) {
        result.ok = true;
        result.why = '编辑数据太大，已存成「未完成的编辑」，下次打开可以恢复';
      } else {
        result.ok = true;
        result.why = '已保存，但这张图太大，只存了预览（不能继续编辑）';
      }
    } else {
      result.ok = true;
      result.why = '已保存';
    }

    lastSaveAt = Date.now();
    lastSaveOk = result.ok;
    if (!o.silent) toast(result.why, 2600);
    return result;
  }

  /**
   * 刷新「保存修改」按钮的状态。
   *
   * 三项信息，缺一用户就会瞎猜：
   *   - 能不能点（没有照片 / 没有任何修改时点它没有意义）
   *   - 有没有还没落盘的改动（防抖还没触发，此刻退出会丢）
   *   - 上次保存是什么时候、成没成
   */
  /* ---------------- 自定义快捷提示词 ---------------- */

  /** 渲染编辑页底部那排快捷指令 */
  function renderQuickChips() {
    const qc = $('quick-chips');
    if (!qc) return;
    const plan = C.planQuickPrompts(S.cfg.quickPrompts);
    qc.innerHTML = '';
    plan.list.forEach((t, i) => {
      const b = document.createElement('button');
      b.className = 'chip';
      // 自定义的标一下：用户得能分清哪些是自己加的（否则以为没保存成功）
      if (i < plan.customCount) b.className += ' chip-mine';
      b.textContent = t.length > 14 ? t.slice(0, 13) + '…' : t;
      b.title = t;
      b.onclick = () => { $('prompt').value = t; $('prompt').focus(); };
      qc.appendChild(b);
    });
  }

  /** 渲染设置页里的自定义提示词列表 */
  function renderQuickPromptSettings() {
    const list = $('qp-list');
    if (!list) return;
    const mine = C.normalizeQuickPrompts(S.cfg.quickPrompts);
    list.innerHTML = '';
    mine.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'qp-item';
      const span = document.createElement('span');
      span.className = 'qp-text';
      span.textContent = t;
      const del = document.createElement('button');
      del.className = 'qp-del';
      del.type = 'button';
      del.textContent = '×';
      del.setAttribute('aria-label', '删除这条');
      del.onclick = () => {
        const plan = C.planEditQuickPrompt(S.cfg.quickPrompts, '', i);
        S.cfg.quickPrompts = plan.list;
        saveCfg();
        renderQuickPromptSettings();
        renderQuickChips();
        toast('已删除');
      };
      row.appendChild(span);
      row.appendChild(del);
      list.appendChild(row);
    });
    if (!mine.length) {
      const empty = document.createElement('div');
      empty.className = 'qp-empty';
      empty.textContent = '还没有自定义。下面加一条试试。';
      list.appendChild(empty);
    }
    const cnt = $('qp-count');
    if (cnt) {
      cnt.textContent = mine.length
        ? (mine.length + ' 条自定义（共 ' + C.QUICK_PROMPT_MAX + ' 条上限）')
        : '还没有自定义';
    }
    const hint = $('qp-hint');
    if (hint) {
      hint.innerHTML = '加在这里的会出现在编辑页底部的快捷指令里，点一下直接填进提示词输入框。' +
        '自己加的排在前面；<b>内置的 6 条一直在</b>，不会被替换掉。';
    }
  }

  /** 添加一条自定义提示词 */
  function addQuickPrompt(text) {
    const plan = C.planEditQuickPrompt(S.cfg.quickPrompts, text);
    if (plan.dup) { toast('这条已经有了', 2200); return false; }
    if (plan.full) { toast('最多 ' + C.QUICK_PROMPT_MAX + ' 条，先删掉一条', 2800); return false; }
    if (!plan.added) { toast('请先输入内容', 2200); return false; }
    S.cfg.quickPrompts = plan.list;
    saveCfg();
    renderQuickPromptSettings();
    renderQuickChips();
    return true;
  }

  function syncSaveNowUI() {
    const btn = $('btn-save-now');
    if (!btn) return;
    const st = saveState();
    const can = !!S.img && st.edits > 0;
    btn.disabled = !can;

    const brief = $('save-state-brief');
    if (brief) {
      let txt = '';
      let warn = false;
      if (!S.img) {
        txt = '';
      } else if (st.pending) {
        // 防抖窗口内：明确告诉用户「还没存」，这时候退出确实会丢
        txt = '未保存';
        warn = true;
      } else if (st.lastAt) {
        txt = st.ok ? ('已存 ' + C.formatClock(st.lastAt)) : '保存失败';
        warn = !st.ok;
      } else if (st.edits > 0) {
        txt = st.hasSession ? '已自动保存' : '待保存';
        warn = !st.hasSession;
      }
      brief.textContent = txt;
      brief.hidden = !txt;
      brief.className = 'mi-state' + (warn ? ' warn' : '');
    }
    btn.title = can ? '立刻把这次修改写进修图记录（不用等自动保存）' : '还没有可保存的修改';
  }

  /** 保存了吗？界面上显示「已保存 / 未保存」用 */
  function saveState() {
    return {
      lastAt: lastSaveAt,
      ok: lastSaveOk,
      pending: !!workSaveTimer,
      edits: S.edits ? S.edits.length : 0,
      hasSession: !!(S.library || []).filter((e) => e.id === S.workId && C.isSessionUsable(e.session))[0]
    };
  }

  function updateLibraryBadge() {
    const b = $('lib-count');
    if (!b) return;
    const n = S.library.length;
    b.textContent = String(n);
    b.hidden = n === 0;
  }

  /* ============================ 模型调用日志 ============================ */

  /**
   * 调用日志：每次模型 API 调用的留痕。
   *
   * 为什么要在设置里能看、能导出：
   *   生图按次收费，用户最想知道三件事 ——「花了多少」「为什么这次失败了」
   *   「我到底发过去了什么」。这些信息原本只在控制台，手机上根本看不到。
   *
   * 存储：环形缓冲（上限 C.CALL_LOG_MAX），最新的在前。
   * 日志是**可丢弃**的数据：写不进去就当没记，绝不能影响生成流程。
   */

  /** 读日志（容错：任何异常都退回空数组，日志坏了不该让应用起不来） */
  function loadCallLog() {
    try {
      const raw = localStorage.getItem(LS_KEY_CALLLOG);
      if (!raw) return [];
      const j = JSON.parse(raw);
      const list = (j && Array.isArray(j.items)) ? j.items : [];
      // 只保留结构正确的条目，脏数据会让面板渲染出 undefined
      return list.filter((e) => e && typeof e === 'object' && C.num(e.at, 0) > 0)
        .slice(0, C.CALL_LOG_MAX);
    } catch (e) {
      console.warn('[枫叶修图] 调用日志读取失败，将从空开始', e);
      return [];
    }
  }

  function saveCallLog() {
    try {
      localStorage.setItem(LS_KEY_CALLLOG, JSON.stringify({ v: 1, items: S.callLog }));
      return true;
    } catch (e) {
      // 空间紧张时日志最该让路：丢掉一半再试一次，还不行就整体放弃。
      // 日志丢了只是少个排查线索，作品库丢了是用户的心血。
      try {
        S.callLog = S.callLog.slice(0, Math.max(1, Math.floor(S.callLog.length / 2)));
        localStorage.setItem(LS_KEY_CALLLOG, JSON.stringify({ v: 1, items: S.callLog }));
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  /**
   * 记一条调用日志。
   *
   * 刻意**不抛异常**：日志失败不该让生成流程出错 ——
   * 用户宁可丢一条日志，也不愿意图白生成。
   */
  function recordCallLog(entry) {
    try {
      S.callLog = C.appendCallLog(S.callLog, Object.assign({ workId: S.workId || '' }, entry));
      saveCallLog();
      // 面板开着就实时刷新（用户正盯着看这次调用的结果）
      if ($('calllog') && !$('calllog').hidden) renderCallLog();
    } catch (e) {
      console.warn('[枫叶修图] 调用日志记录失败', e);
    }
  }

  /** 估算这次调用的花费（返回 null 表示单价未知） */
  function estimateCallCost() {
    try {
      const est = currentEstimate();
      if (!est || !est.known) return { usd: null, note: '单价未知' };
      return { usd: C.num(est.totalUsd, 0), note: est.note || '' };
    } catch (e) {
      return { usd: null, note: '' };
    }
  }

  /** 把错误对象整理成一句人看得懂的失败原因（复用诊断文案） */
  function describeCallError(err) {
    const e = err || {};
    const bits = [];
    if (e.local) bits.push('本地自检未通过');
    if (e.status) bits.push('HTTP ' + e.status);
    // diagnoseResponse 会把「上游回文字 / Key 失效 / 限流」等翻译成人话，
    // 这里复用同一套，免得日志里只有一句 HTTP 400
    try {
      const d = C.diagnoseResponse(e.json || null, e.status || 0, { model: S.cfg.model });
      if (d && d.title) bits.push(d.title);
    } catch (e2) { /* 诊断失败不影响记录原始信息 */ }
    if (e.message) bits.push(String(e.message).slice(0, 200));
    const s = bits.filter(Boolean).join(' · ');
    return s || '未知错误';
  }

  /* ============================ 新手教程 ============================ */

  /**
   * 新手教程：首次启动时走一遍「打开照片 → 框选 → 写要求 → 生成 → 对比/贴回 → 导出」。
   *
   * 为什么做成「蒙层 + 高亮圈 + 说明气泡」而不是更花哨的引导：
   * 这个应用的流程本身很长（要等 30~60 秒生成），用户很可能想边看边动手。
   * 拦截点击的那种引导会让人烦，所以这里**只做视觉指示**，
   * 随时可以跳过，也不会阻止任何操作。
   *
   * 「看过」的标记独立于版本：升级后不再弹（老用户已经会用了），
   * 但菜单和设置里都能重看。
   */

  let tutIdx = 0;

  function tutorialSeen() {
    try { return localStorage.getItem(LS_KEY_TUTORIAL) === '1'; } catch (e) { return false; }
  }

  function markTutorialSeen() {
    try { localStorage.setItem(LS_KEY_TUTORIAL, '1'); } catch (e) { /* 隐私模式忽略 */ }
  }

  function clearTutorialSeen() {
    try { localStorage.removeItem(LS_KEY_TUTORIAL); } catch (e) { /* ignore */ }
  }

  /** 首次启动该不该自动弹教程 */
  function shouldAutoTutorial() {
    return C.planTutorial({
      seen: tutorialSeen(),
      hasPhoto: !!S.img
    }).show;
  }

  /**
   * 打开教程。
   *
   * @param {boolean} auto true = 首次启动自动弹（会自动标记「已看过」）；
   *                       false = 用户手动重看（不改变标记，避免反复写盘）
   */
  function openTutorial(auto) {
    const el = $('tutorial');
    if (!el) return;
    // 自动弹的那次立刻记「已看过」：万一用户中途杀掉应用，
    // 下次启动不该再弹一遍（他要真想看会自己去菜单里点）
    if (auto) markTutorialSeen();
    tutIdx = 0;
    el.hidden = false;
    renderTutorial();
  }

  function closeTutorial() {
    const el = $('tutorial');
    if (el) el.hidden = true;
  }

  function tutorialOpen() {
    const el = $('tutorial');
    return !!el && !el.hidden;
  }

  /** 渲染当前步骤：高亮圈对准目标元素，气泡放在它上方/下方 */
  function renderTutorial() {
    const el = $('tutorial');
    if (!el || el.hidden) return;
    const step = C.TUTORIAL_STEPS[tutIdx];
    if (!step) { closeTutorial(); return; }

    const stepEl = $('tut-step');
    if (stepEl) stepEl.textContent = '第 ' + (tutIdx + 1) + ' / ' + C.TUTORIAL_LEN + ' 步';
    const titleEl = $('tut-title');
    if (titleEl) titleEl.textContent = step.title;
    const bodyEl = $('tut-body');
    if (bodyEl) bodyEl.textContent = step.body;

    // 上一步：第一步时禁用（而不是隐藏）—— 按钮位置稳定，不会跳来跳去
    const prev = $('tut-prev');
    if (prev) {
      const p = C.planTutorialStep(tutIdx, 'prev');
      prev.disabled = p.atStart;
      prev.style.opacity = p.atStart ? '.4' : '';
    }
    const next = $('tut-next');
    if (next) next.textContent = (tutIdx >= C.TUTORIAL_LEN - 1) ? '开始使用' : '下一步';

    // 进度点
    const dots = $('tut-dots');
    if (dots) {
      dots.innerHTML = '';
      for (let i = 0; i < C.TUTORIAL_LEN; i++) {
        const d = document.createElement('span');
        d.className = 'tut-dot' + (i === tutIdx ? ' on' : '');
        dots.appendChild(d);
      }
    }

    layoutTutorial(step);
  }

  /**
   * 摆位：把高亮圈套到目标元素上，气泡放在不遮挡它的那一侧。
   *
   * 兜底：目标元素不存在或不可见（例如「导出」按钮在有照片前是 disabled 的、
   * 或者老内核不支持某个选择器）时，**隐藏高亮圈、气泡居中** ——
   * 指向屏幕角落的箭头比没有箭头更让人困惑。
   */
  function layoutTutorial(step) {
    const spot = $('tut-spot');
    const card = $('tut-card');
    if (!card) return;

    const vw = window.innerWidth || 360;
    const vh = window.innerHeight || 640;
    let target = null;
    try {
      target = step.target ? document.querySelector(step.target) : null;
    } catch (e) { target = null; }

    let r = null;
    if (target && target.getBoundingClientRect) {
      r = target.getBoundingClientRect();
      // 尺寸为 0 说明元素被隐藏（display:none）或还没布局出来
      if (!r || r.width < 2 || r.height < 2) r = null;
    }

    const cardW = Math.min(460, vw - 24);
    const cardH = card.offsetHeight || 190;

    if (spot) {
      if (r) {
        spot.classList.remove('off');
        spot.style.left = (r.left - 6) + 'px';
        spot.style.top = (r.top - 6) + 'px';
        spot.style.width = (r.width + 12) + 'px';
        spot.style.height = (r.height + 12) + 'px';
      } else {
        spot.classList.add('off');
        spot.style.left = '-9999px';
        spot.style.top = '-9999px';
        spot.style.width = '0px';
        spot.style.height = '0px';
      }
    }

    card.style.width = cardW + 'px';
    card.style.left = Math.max(12, (vw - cardW) / 2) + 'px';

    // 气泡放在目标下方（目标在屏幕上半部分）或上方（目标在下半部分），
    // 两者都放不下就居中 —— 保证气泡永远在屏幕里
    let top = (vh - cardH) / 2;
    if (r) {
      const below = r.bottom + 14;
      const above = r.top - cardH - 14;
      if (step.place === 'top' && above >= 8) top = above;
      else if (step.place === 'bottom' && below + cardH <= vh - 8) top = below;
      else if (below + cardH <= vh - 8) top = below;
      else if (above >= 8) top = above;
    }
    card.style.top = Math.max(8, Math.min(vh - cardH - 8, top)) + 'px';
  }

  /** 教程推进。返回是否已结束（供测试断言） */
  function tutorialNext() {
    const p = C.planTutorialStep(tutIdx, 'next');
    if (p.done) { closeTutorial(); return true; }
    tutIdx = p.idx;
    renderTutorial();
    return false;
  }

  function tutorialPrev() {
    const p = C.planTutorialStep(tutIdx, 'prev');
    tutIdx = p.idx;
    renderTutorial();
    return false;
  }

  /* ============================ 照片信息 ============================ */

  /**
   * 展示当前照片的基本信息（EXIF / 尺寸 / 体积 / 色彩配置）。
   *
   * 数据来源：导入时已解析并存进 S.meta（EXIF/ICC），尺寸与体积在 setImage 时记录。
   * 所以打开面板是瞬时的，不需要重新读文件。
   */
  function openPhotoInfo() {
    const el = $('photoinfo');
    const body = $('photoinfo-body');
    if (!el || !body) return;

    if (!S.img) {
      body.innerHTML = '<div class="pi-empty">还没有打开照片</div>';
      el.hidden = false;
      return;
    }

    // EXIF 字段：S.meta.exif 是 TIFF 段，需要解析成字段
    let exifFields = {};
    try {
      if (S.meta && S.meta.exif) exifFields = C.parseExifFields(S.meta.exif);
    } catch (e) { exifFields = {}; }

    const groups = C.describePhotoInfo({
      exif: exifFields,
      width: S.imgW, height: S.imgH,
      sizeBytes: S.fileSize || 0,
      fileName: ($('file-name').textContent || '').replace(/（已恢复）$/, ''),
      mime: S.fileMime || '',
      icc: S.meta && S.meta.icc,
      iccIsSrgb: !S.meta || S.meta.iccIsSrgb !== false
    });

    if (!groups.length) {
      body.innerHTML = '<div class="pi-empty">读不到这张照片的信息</div>';
      el.hidden = false;
      return;
    }

    body.innerHTML = groups.map((g) =>
      '<div class="pi-group">' + esc(g.group) + '</div>' +
      '<div class="pi-card">' +
        g.items.map((it) =>
          '<div class="pi-row">' +
            '<span class="pi-label">' + esc(it.label) + '</span>' +
            '<span class="pi-value' + (/GPS|定位/.test(it.value) ? ' pi-warn' : '') + '">' +
              esc(it.value) + '</span>' +
          '</div>').join('') +
      '</div>'
    ).join('');
    el.hidden = false;
  }

  function closePhotoInfo() { $('photoinfo').hidden = true; }

  /* ============================ 导出设置 ============================ */

  /**
   * 导出面板：让用户在导出前选择格式与大小。
   *
   * 为什么单独做一个面板（而不是只放在设置里）：
   *   导出是高频动作，而格式/尺寸经常每张都不一样（这张要发微信、那张要交客户）。
   *   埋在设置里每次都要翻两层，所以提到导出按钮上。
   */
  let expFormat = 'jpeg';
  let expMaxSide = 0;          // 0 = 原始尺寸
  let expQuality = 95;
  let expCustomSide = 0;       // 自定义长边

  /** 安卓壳是否支持「选保存位置」（浏览器里 PSBridge 不存在） */
  function nativeSaveAvailable() {
    const b = bridge();
    try { return !!(b && b.saveSupported && b.saveSupported()); } catch (e) { return false; }
  }

  /**
   * 把导出的图片交给原生保存。
   *
   * 走本地服务的 /api/save 而不是 JS 桥：一张 4096px 的 JPEG 有十几 MB，
   * 走桥要 base64（多占 1/3 内存，且字符串参数有长度风险），HTTP 直接传二进制。
   */
  async function nativeSave(blob, name, where) {
    try {
      const q = '?name=' + encodeURIComponent(name) + '&where=' + encodeURIComponent(where || 'gallery');
      const res = await fetch('/api/save' + q, { method: 'POST', body: blob });
      const j = await res.json();
      return j && typeof j === 'object' ? j : { ok: false, error: '返回数据异常' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function openExportPanel() {
    if (!S.viewCanvas) { toast('先打开一张照片'); return; }
    // 首次打开：跟随设置页里选的交付预设（用户刚在设置里选了「微信」，
    // 打开导出面板却还是「原尺寸」会让人以为设置没生效）；
    // 之后打开：记住上次在面板里选的那一套。
    const preset = C.getExportPreset(S.cfg.exportPreset);
    const chosen = S.cfg.expPresetChosen === true;
    expFormat = (chosen && S.cfg.expFormat) || preset.format || 'jpeg';
    expMaxSide = Number(chosen ? S.cfg.expMaxSide : preset.maxSide) || 0;
    expQuality = Math.round(Number(chosen ? S.cfg.expQuality : (preset.quality || 0.95) * 100));
    if (!(expQuality >= 60 && expQuality <= 100)) expQuality = 95;
    expCustomSide = expMaxSide > 0 && !C.EXPORT_SIZES.some((x) => x.maxSide === expMaxSide) ? expMaxSide : 0;
    renderExportPanel();
    $('exportpanel').hidden = false;
  }

  function closeExportPanel() { $('exportpanel').hidden = true; }

  /** 当前导出设置对应的预设对象 */
  function currentExportPreset() {
    return C.makeCustomPreset({
      format: expFormat,
      maxSide: expMaxSide,
      quality: expQuality / 100,
      keepExif: $('exp-exif') ? $('exp-exif').checked : true,
      keepGps: $('exp-gps') ? $('exp-gps').checked : true,
      keepIcc: $('exp-icc') ? $('exp-icc').checked : true
    });
  }

  function renderExportPanel() {
    // ---- 格式 ----
    const fEl = $('exp-formats');
    if (fEl) {
      fEl.innerHTML = C.EXPORT_FORMATS.map((f) =>
        '<button class="st-row st-row-btn' + (f.id === expFormat ? ' selected' : '') + '" data-fmt="' + f.id + '">' +
          '<span class="st-label">' + esc(f.label) + '</span>' +
          (f.id === expFormat
            ? '<svg class="exp-check" viewBox="0 0 24 24"><path d="m5 13 4 4L19 7"/></svg>'
            : '') +
        '</button>').join('');
      fEl.querySelectorAll('[data-fmt]').forEach((b) => {
        b.onclick = () => { expFormat = b.dataset.fmt; renderExportPanel(); };
      });
    }

    // ---- 尺寸 ----
    const sEl = $('exp-sizes');
    if (sEl) {
      const sizes = C.EXPORT_SIZES.concat([{ id: 'custom', label: '自定义…', maxSide: -1 }]);
      sEl.innerHTML = sizes.map((sz) => {
        const sel = sz.id === 'custom' ? !!expCustomSide : (expMaxSide === sz.maxSide && !expCustomSide);
        return '<button class="st-row st-row-btn' + (sel ? ' selected' : '') + '" data-size="' + sz.id + '">' +
          '<span class="st-label">' + esc(sz.label) + '</span>' +
          (sel ? '<svg class="exp-check" viewBox="0 0 24 24"><path d="m5 13 4 4L19 7"/></svg>' : '') +
        '</button>';
      }).join('');
      sEl.querySelectorAll('[data-size]').forEach((b) => {
        b.onclick = () => {
          const id = b.dataset.size;
          if (id === 'custom') {
            expCustomSide = expCustomSide || Math.max(1, Math.min(16384, Math.max(S.imgW, S.imgH)));
            expMaxSide = expCustomSide;
          } else {
            expCustomSide = 0;
            const sz = C.EXPORT_SIZES.find((x) => x.id === id);
            expMaxSide = sz ? sz.maxSide : 0;
          }
          renderExportPanel();
        };
      });
    }

    // 自定义输入框
    const cRow = $('exp-custom-row');
    const cInput = $('exp-custom');
    if (cRow) cRow.hidden = !expCustomSide;
    if (cInput) {
      cInput.value = String(expCustomSide || 0);
      cInput.oninput = () => {
        expCustomSide = Math.max(0, Math.min(16384, Number(cInput.value) || 0));
        expMaxSide = expCustomSide;
        updateExportSummary();
      };
    }

    // ---- 保存位置（只在安卓壳里显示：浏览器里下载目录由浏览器决定） ----
    const svEl = $('exp-saves');
    const svGroup = $('exp-save-group');
    if (svGroup) svGroup.hidden = !nativeSaveAvailable();
    if (svEl && nativeSaveAvailable()) {
      svEl.innerHTML = C.SAVE_LOCATIONS.map((L) => {
        const sel = L.id === S.cfg.expSaveWhere;
        return '<button class="st-row st-row-btn' + (sel ? ' selected' : '') + '" data-save="' + L.id + '">' +
          '<span class="st-label">' + esc(L.label) +
            '<i class="st-desc-inline">' + esc(L.desc) + '</i></span>' +
          (sel ? '<svg class="exp-check" viewBox="0 0 24 24"><path d="m5 13 4 4L19 7"/></svg>' : '') +
        '</button>';
      }).join('');
      svEl.querySelectorAll('[data-save]').forEach((b) => {
        b.onclick = () => {
          S.cfg.expSaveWhere = b.dataset.save;
          saveCfg();
          renderExportPanel();
        };
      });
    }
    const svHint = $('exp-save-hint');
    if (svHint && nativeSaveAvailable()) {
      const cur = C.getSaveLocation(S.cfg.expSaveWhere);
      svHint.textContent = cur.id === 'ask'
        ? '每次导出都会弹出系统文件选择器，由你指定目录和文件名。'
        : '导出会保存到「' + cur.label + '」下的「枫叶修图」文件夹。';
    }

    // 质量滑块（PNG 时无意义，隐藏）
    const qRow = $('exp-quality-row');
    const qInput = $('exp-quality');
    if (qRow) qRow.hidden = expFormat === 'png';
    if (qInput) {
      qInput.value = String(expQuality);
      qInput.oninput = () => {
        expQuality = Number(qInput.value) || 95;
        $('exp-quality-val').textContent = expQuality + '%';
        updateExportSummary();
      };
      $('exp-quality-val').textContent = expQuality + '%';
    }

    // 元数据开关：同样恢复上次的选择（首次打开跟随设置页预设）
    const basePreset = C.getExportPreset(S.cfg.exportPreset);
    const meta0 = {
      expKeepExif: basePreset.keepExif !== false,
      expKeepGps: basePreset.keepGps !== false,
      expKeepIcc: basePreset.keepIcc !== false
    };
    for (const [id, key] of [['exp-exif', 'expKeepExif'], ['exp-gps', 'expKeepGps'], ['exp-icc', 'expKeepIcc']]) {
      const el = $(id);
      if (!el) continue;
      el.checked = S.cfg.expPresetChosen === true ? (S.cfg[key] !== false) : meta0[key];
      el.onchange = updateExportSummary;
    }

    updateExportSummary();
  }

  /** 刷新「输出尺寸 / 预计体积」这两行 */
  function updateExportSummary() {
    if (!S.viewCanvas) return;
    const preset = currentExportPreset();
    // 用**原图**尺寸算（导出时会按原图重新合成）
    const plan = C.planExportWithHint(S.imgW, S.imgH, preset);
    const sizeEl = $('exp-out-size');
    const estEl = $('exp-out-size-est');
    const hintEl = $('exp-hint');
    if (sizeEl) sizeEl.textContent = plan.w + ' × ' + plan.h + ' px';
    if (estEl) {
      const est = C.estimateExportSize({
        w: plan.w, h: plan.h, format: expFormat, quality: expQuality / 100
      });
      estEl.textContent = '约 ' + est.text + '（' + (expFormat === 'png' ? 'PNG 无损' : 'JPEG') + '）';
    }
    if (hintEl) hintEl.textContent = plan.hint;
  }

  /* ============================ 首页（修改历史） ============================ */

  /**
   * 首页显示什么：有照片在编辑 → 收起；没照片 → 显示修改历史。
   *
   * 设计意图：摄影师多数时候是回来接着改上次那张，而不是每次都修新图。
   * 打开应用先看到历史记录，比看到一个空白画布有用得多。
   */
  function isHomeVisible() {
    const home = $('home');
    return !!home && !home.hidden;
  }

  /** 刷新首页（进入/退出编辑、记录变化时调用） */
  function renderHome() {
    const home = $('home');
    if (!home) return;
    // 有照片在编辑时不显示首页（用户要看画布）
    const showHome = !S.img;
    home.hidden = !showHome;
    if (!showHome) return;

    const list = $('home-list');
    const empty = $('home-empty');
    if (!list) return;

    const groups = C.groupWorksByDay(S.library, Date.now());
    if (empty) empty.hidden = S.library.length > 0;
    if (!S.library.length) { list.innerHTML = ''; return; }

    list.innerHTML = '';
    for (const g of groups) {
      const head = document.createElement('div');
      head.className = 'home-day';
      head.textContent = g.label;
      list.appendChild(head);

      for (const w of g.items) {
        const item = document.createElement('button');
        item.className = 'home-item';
        item.dataset.workId = w.id;

        const img = document.createElement('img');
        img.className = 'home-thumb';
        img.loading = 'lazy';
        img.alt = w.name;
        if (w.thumb) img.src = w.thumb;
        item.appendChild(img);

        const meta = document.createElement('div');
        meta.className = 'home-meta';
        const nm = document.createElement('div');
        nm.className = 'home-name';
        nm.textContent = w.name;
        // 能继续编辑的标一下，用户才知道点进去能接着改
        // 「可继续编辑」= 有能还原的图层，或者挂着待贴回的后台结果。
        // 只看 !!session 会把空壳会话也标上（点进去是原图）；
        // 只看 isSessionUsable 又会让「只有后台结果」的记录进不去。
        if (C.isSessionUsable(w.session) || !!w.bgResult) {
          const tag = document.createElement('span');
          tag.className = 'home-tag';
          tag.textContent = '可继续编辑';
          nm.appendChild(tag);
        }
        // 后台生成状态：让用户知道「那张还在跑」/「那张已经好了，点开看」。
        // 没有这个标记，后台生成就等于没有 —— 用户不知道结果在哪。
        const jt = C.jobTagFor(w.id, S.jobs);
        if (jt) {
          const tag2 = document.createElement('span');
          tag2.className = 'home-tag job-' + jt.tag;
          tag2.textContent = jt.zh;
          nm.appendChild(tag2);
        }
        // 已经存好的后台结果（用户还没回来贴）
        if (w.bgResult && !jt) {
          const tag3 = document.createElement('span');
          tag3.className = 'home-tag job-done';
          tag3.textContent = '有生成结果待贴回';
          nm.appendChild(tag3);
        }
        const sub = document.createElement('div');
        sub.className = 'home-sub';
        sub.textContent = C.formatWorkClock(w.at) + ' · ' + w.edits + ' 处修改' +
          (w.docW ? ' · ' + w.docW + '×' + w.docH : '');
        meta.appendChild(nm);
        meta.appendChild(sub);
        item.appendChild(meta);

        const go = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        go.setAttribute('class', 'home-go');
        go.setAttribute('viewBox', '0 0 24 24');
        const gp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        gp.setAttribute('d', 'm9 6 6 6-6 6');
        go.appendChild(gp);
        item.appendChild(go);

        item.onclick = () => {
          // 有**能真正还原的**编辑数据就直接进编辑页；
          // 没有（被空间清理、或是老版本留下的空壳会话）就只预览。
          // 判空壳很关键：老版本在编辑数据超上限时存过「只有底图、items 为空」
          // 的会话，点进去恢复出来就是原图 —— 用户会以为保存失败了。
          // 挂着的后台结果也算「能进去」：进去是为了把它贴回。
          // 这种记录的会话可能只有底图（用户当时还没贴回任何修改），
          // 单看会话会被误判成空壳。
          if (C.isSessionUsable(w.session) || !!w.bgResult) continueWork(w.id);
          else openWorkPreview(w.id);
        };
        list.appendChild(item);
      }
    }
  }

  /* ---------- 工具栏高度：轻点收起/展开，上下拖动自由调节 ---------- */

  /** 测量失败时的兜底高度（例如祖先 display:none、或内核不做布局） */
  const BAR_FALLBACK_FULL = 240;

  /**
   * 工具栏完全展开时的高度（px）。
   *
   * 测量失败（得到 0）时返回兜底值而不是 0 —— 返回 0 会让「收起/展开」
   * 的判定全部失效（0 < 0*0.5 恒为假 → 永远判成展开）。
   * 宁可给一个偏大的兜底值，也不要让状态机坏掉。
   */
  function barFullHeight() {
    const bar = $('bottombar');
    if (!bar) return BAR_FALLBACK_FULL;
    const body = $('bar-body');
    const h = (body ? body.scrollHeight : 0) || bar.scrollHeight || 0;
    return h > C.BAR_MIN ? Math.round(h) : BAR_FALLBACK_FULL;
  }

  /**
   * 应用工具栏高度。
   *
   * 用 maxHeight 而不是 height：内容高度会随「画笔参数条显示/隐藏」变化，
   * 写死 height 会让参数条被裁掉；maxHeight 在内容变矮时自然收缩。
   *
   * @param {number} h 期望高度（px）
   * @param {object|boolean} opt { animate, collapsed, save }
   *   collapsed 显式给出时以它为准，不从高度推导 ——
   *   「收起」是一个明确意图（首页不该有工具栏），不该依赖一次可能失败的测量。
   *   save=true 时把高度写进配置（拖动结束、轻点切换时用；
   *   拖动过程中不写，否则每个 pointermove 都写一次 localStorage）。
   */
  function applyBarHeight(h, opt) {
    const bar = $('bottombar');
    if (!bar) return;
    // 首页不该有工具栏。任何路径（拖动/展开/换图后重算）都不该在没照片时
    // 把它重新显示出来 —— 否则用户会看到底部莫名多出一条。
    if (!S.img) { bar.hidden = true; return; }
    const o = (typeof opt === 'object' && opt) ? opt : { animate: opt };
    const full = barFullHeight();
    const plan = C.planToolbar({ height: h, full, viewH: window.innerHeight });
    const collapsed = o.collapsed !== undefined ? !!o.collapsed : plan.collapsed;
    if (o.animate === false) bar.classList.add('no-anim');
    bar.style.maxHeight = plan.height + 'px';
    bar.classList.toggle('collapsed', collapsed);
    S.toolbarHeight = plan.height;
    S.toolbarFull = plan.full;
    S.toolbarVisible = !collapsed;
    if (o.animate === false) {
      // 强制回流后再移除，避免「禁用动画」被合并到同一帧而不生效
      void bar.offsetHeight;
      bar.classList.remove('no-anim');
    }
    // 高度变了画布可用空间也变了，重算视图（否则图片位置会偏）
    if (typeof resizeCanvas === 'function') resizeCanvas();
    if (o.save) saveBarHeight();
    return Object.assign({}, plan, { collapsed });
  }

  /**
   * 把当前工具栏高度写进配置（下次进编辑页、下次启动都沿用）。
   *
   * 无极拖动之后这里**存真实高度**，不再把「收起」记成 0。
   * 原因：以前只有两档，收起是个临时动作，记 0 表示「没偏好、下次展开」；
   * 现在高度是连续值，「工具行 + 一点参数」这种中间高度本身就是用户的偏好，
   * 记成 0 会让他下次打开发现辛苦调的高度没了。
   * 首页的收起是**另一回事**（没打开照片就没有工具栏），走 collapseToolbar()
   * 且不带 save，所以不会覆盖这里的偏好。
   */
  function saveBarHeight() {
    S.cfg.barHeight = S.toolbarHeight;
    saveCfg();
  }

  /** 展开到完全高度（save=true 时记住这个高度） */
  function expandToolbar(animate, save) {
    return applyBarHeight(barFullHeight(), { animate, collapsed: false, save });
  }

  /** 收起到最矮（只留手柄 + 工具行） */
  function collapseToolbar(animate, save) {
    return applyBarHeight(C.BAR_MIN, { animate, collapsed: true, save });
  }

  /**
   * 回到首页（修图记录列表）。
   *
   * 为什么需要：返回键在编辑页要能退回首页，但在此之前应用里
   * **没有任何路径能把照片卸下来** —— S.img 一旦设置就从不清空，
   * 所以「回首页」只能靠退出应用重进。这里补上。
   *
   * 关键：卸载前必须先把当前作品存进作品库，否则用户「返回」一下
   * 就丢了刚才所有修改 —— 那是比「退出应用」更糟的体验。
   */
  function goHome() {
    // 1) 先把当前作品落盘（防抖保存可能还没触发）
    try {
      if (S.edits.length) touchWork();
    } catch (e) { /* 作品库失败不该挡住返回 */ }

    // 2) 在途任务**继续跑**（这是「放后台」的关键）。
    // 旧实现在这里 abort，于是「回首页 = 这次生成白花钱」。
    // 现在任务自带归属信息，结果回来时会落进它自己那件作品的记录里。
    // 只把「当前这张」标记成已离开：结果落地时才知道用户已经走了。
    const leavingDoc = S.docVersion;
    S.genToken++;                 // 当前文档的操作序列到此为止（防旧回调写 UI）
    setBusy(false);

    // 3) 关掉所有依赖照片的浮层（对比图、生成失败说明）
    S.pending = null;
    closeCompare();
    clearErrorPanel();

    // 4) 卸载文档
    S.img = null;
    S.imgW = 0; S.imgH = 0;
    S.docW = 0; S.docH = 0;
    S.docCanvas = null; S.docCtx = null;
    S.viewCanvas = null; S.viewCtx = null;
    S.meta = null;
    S.edits = [];
    S.redo = [];
    S.rect = null;
    S.strokes = [];
    S.guides = [];
    S.mode = 'select';
    S.ratio = 0;
    S.workId = null;
    S.workStartedAt = 0;
    S.histPreview = null;
    S.histStash = null;
    S.docVersion++;      // 旧文档的在途结果一律作废
    S.docRev++;
    updateGuideBadge();

    // 5) 顶栏与 HUD 复位
    $('file-name').textContent = '未打开照片';
    $('file-meta').textContent = '点「打开」导入手机里的照片';
    $('hud').hidden = true;
    $('btn-save').disabled = true;

    // 6) 会话存档属于「这张图未完成的编辑」，卸载后没有意义
    try { localStorage.removeItem(LS_KEY_SESSION); } catch (e) { /* ignore */ }

    // 7) 清空画布并切回首页布局
    const v = viewSize();
    if (ctx) { ctx.clearRect(0, 0, v.w, v.h); paintBackground(ctx, v.w, v.h); }
    renderHome();
    syncToolbar();
    updateUI();
  }

  /* ---------- 返回键 ---------- */

  /**
   * 处理一次返回键。返回 true 表示「已处理，别退出应用」。
   *
   * Android 壳通过 evaluateJavascript 调用它并读取返回值决定是否退出。
   * 浏览器里没有返回键，所以这个函数只服务于安卓壳（测试也可直接调）。
   */
  function handleBack() {
    try {
      // 设置二级页：返回键先退回设置列表，而不是把整个设置关掉。
      // 这和手机系统一致 —— 用户在「外观与后台」里按返回，
      // 期待回到设置列表继续找别的东西，而不是退出设置重来。
      // 注意位置：必须在 planBackAction 之前拦截，否则它会直接关掉 settings。
      if ($('settings') && !$('settings').hidden && !settingsAtHome()) {
        showSettingsPage('home');
        return true;
      }

      const open = {
        // 更多菜单是最「临时」的一层：它一关就没了，所以排在返回链最前面
        moremenu: moreMenuOpen(),
        workPreview: !!$('work-preview') && !$('work-preview').hidden,
        settings: !!$('settings') && !$('settings').hidden,
        library: !!$('library') && !$('library').hidden,
        history: !!$('history') && !$('history').hidden,
        layers: !!$('layers') && !$('layers').hidden,
        photoinfo: !!$('photoinfo') && !$('photoinfo').hidden,
        exportpanel: !!$('exportpanel') && !$('exportpanel').hidden,
        t2i: !!$('t2i') && !$('t2i').hidden,
        calllog: !!$('calllog') && !$('calllog').hidden,
        tutorial: tutorialOpen(),
        compare: !!$('compare') && !$('compare').hidden,
        genError: !!$('gen-error') && !$('gen-error').hidden
      };
      const plan = C.planBackAction({
        open, busy: !!S.busy, mode: S.mode, editing: !!S.img
      });
      if (!plan.handled) return false;

      switch (plan.action) {
        case 'close':
          switch (plan.target) {
            case 'moremenu': closeMoreMenu(); break;
            case 'workPreview': $('work-preview').hidden = true; break;
            case 'settings': closeSettings(); break;
            case 't2i': closeT2i(); break;
            case 'library': closeLibrary(); break;
            case 'history': closeHistory(); break;
            case 'layers': closeLayers(); break;
            case 'photoinfo': closePhotoInfo(); break;
            case 'exportpanel': closeExportPanel(); break;
            case 'calllog': closeCallLog(); break;
            // 教程按返回键 = 跳过（同样记「已看过」），否则会每次启动都弹
            case 'tutorial': markTutorialSeen(); closeTutorial(); break;
            case 'compare': discardPending(); break;
            case 'genError': clearErrorPanel(); break;
          }
          break;
        case 'cancel-gen':
          // 只取消**当前这张照片**的任务。别的照片的后台任务不该被牵连 ——
          // 用户按返回键是想离开这一张，不是想放弃所有在跑的生成。
          cancelJobsForCurrentDoc('返回键');
          setBusy(false);
          toast('已取消生成');
          break;
        case 'mode':
          S.mode = 'select';
          S.strokes = []; invalidateMask();
          resetTipDecision();
          updateUI(); draw();
          break;
        case 'home': {
          // 先确认真的存住了再说「已存」。
          // 以前是无条件弹这句话：保存失败（磁盘满 / 单条超限）时
          // 用户被这句提示骗了，回头发现记录里是原图。
          //
          // 注意必须在 goHome() 之前把「有没有修改」记下来 ——
          // goHome 会把 S.edits 清空，之后再读就永远是 0。
          const hadEdits = S.edits.length > 0;
          const saved = hadEdits ? forceSaveNow({ silent: true }) : { ok: true, why: '' };
          goHome();
          toast(!hadEdits ? '已回到首页'
            : saved.ok ? '已存进修图记录，可随时继续编辑'
              : ('没能保存：' + (saved.why || '未知原因')), 3200);
          break;
        }
      }
      return true;
    } catch (e) {
      // 处理失败时宁可让系统退出，也不要让用户卡在按返回没反应的界面里
      console.warn('[枫叶修图] 返回键处理失败', e);
      return false;
    }
  }

  /* ---------- 顶栏「更多」菜单 ---------- */

  /**
   * 更多菜单（照片信息 / 修图记录 / 设置）。
   *
   * 为什么要有：顶栏原本 7 个按钮 + 文件名，最小占宽 344px ——
   * 360px 的手机上文件名只剩 8px（等于没有），320px 的机器上按钮直接溢出屏幕。
   * 把三个低频入口收进菜单后固定占宽降到 252px，任何机型都不会再挤爆。
   *
   * 交互上要注意两点：
   *   1. 点菜单里的一项后必须关菜单，否则面板关掉后菜单还浮在上面
   *   2. 点菜单外面任何地方也要关 —— 菜单是浮层，不关会挡住画布
   */
  function openMoreMenu() {
    const m = $('moremenu');
    if (!m || !m.hidden) return;
    m.hidden = false;
    const b = $('btn-more');
    if (b) b.setAttribute('aria-expanded', 'true');
  }
  function closeMoreMenu() {
    const m = $('moremenu');
    if (!m || m.hidden) return;
    m.hidden = true;
    const b = $('btn-more');
    if (b) b.setAttribute('aria-expanded', 'false');
  }
  function toggleMoreMenu() {
    const m = $('moremenu');
    if (m && !m.hidden) closeMoreMenu(); else openMoreMenu();
  }
  function moreMenuOpen() {
    const m = $('moremenu');
    return !!m && !m.hidden;
  }

  /** 工具栏展开 / 收起（供外部与旧代码调用） */
  function setToolbarVisible(visible) {
    if (visible) expandToolbar();
    else collapseToolbar();
  }

  /**
   * 同步「是否显示工具栏」。
   * 打开照片后进入编辑页 → 展开；回到首页 → 收起。
   *
   * 注意：编辑页展开时用的是**用户上次调好的高度**（S.cfg.barHeight），
   * 不是写死的完全展开 —— 用户辛苦调出来的高度不该被一次换图重置。
   */
  function syncToolbar() {
    const editing = !!S.img;
    const bar = $('bottombar');
    if (!editing) {
      // 首页把工具栏**整个藏起来**，不是「收起到最矮」。
      // 收起态仍会露出 BAR_MIN(40px) 一条，在首页既没用又占地方
      // （用户反馈「首页不需要把工具栏放在底下」）。
      // 用 hidden 而不是 maxHeight:0：后者仍会占位、也仍可被点到。
      if (bar) bar.hidden = true;
      S.toolbarVisible = false;
      return;
    }
    if (bar) bar.hidden = false;
    const saved = Number(S.cfg.barHeight);
    if (Number.isFinite(saved) && saved > 0) {
      applyBarHeight(saved, { collapsed: C.isBarCollapsed(saved, barFullHeight()) });
    } else {
      expandToolbar();
    }
  }

  function openLibrary() {
    $('library').hidden = false;
    renderLibrary();
  }
  function closeLibrary() { $('library').hidden = true; }

  function renderLibrary() {
    const list = $('lib-list');
    const empty = $('lib-empty');
    const usage = $('lib-usage');
    if (!list) return;

    const groups = C.groupWorksByDay(S.library, Date.now());
    const stats = C.workLibraryStats(S.library);

    if (empty) empty.hidden = S.library.length > 0;
    if (usage) {
      usage.textContent = stats.count
        ? (stats.count + ' 张 · 占用 ' + C.formatBytes(stats.bytes) +
          (stats.withSession ? ' · ' + stats.withSession + ' 张可继续编辑' : ''))
        : '';
    }
    list.innerHTML = '';

    for (const g of groups) {
      const head = document.createElement('div');
      head.className = 'lib-day';
      head.textContent = g.label;
      list.appendChild(head);

      const grid = document.createElement('div');
      grid.className = 'lib-grid';

      for (const w of g.items) {
        const card = document.createElement('div');
        card.className = 'lib-card';
        card.dataset.workId = w.id;

        const img = document.createElement('img');
        img.className = 'lib-thumb';
        img.loading = 'lazy';
        img.alt = w.name;
        if (w.thumb) img.src = w.thumb;
        else {
          // 没有缩略图（极少数脏数据）时给个占位，避免出现破图
          img.style.background = 'var(--panel-2)';
        }
        card.appendChild(img);

        const meta = document.createElement('div');
        meta.className = 'lib-meta';
        const nm = document.createElement('div');
        nm.className = 'lib-name';
        nm.textContent = w.name;
        // 后台生成状态（同首页：让用户知道哪张在跑、哪张好了）
        const jt2 = C.jobTagFor(w.id, S.jobs);
        if (jt2) {
          const tag2 = document.createElement('span');
          tag2.className = 'lib-tag job-' + jt2.tag;
          tag2.textContent = jt2.zh;
          nm.appendChild(tag2);
        } else if (w.bgResult) {
          const tag3 = document.createElement('span');
          tag3.className = 'lib-tag job-done';
          tag3.textContent = '有结果待贴回';
          nm.appendChild(tag3);
        }
        const sub = document.createElement('div');
        sub.className = 'lib-sub';
        sub.textContent = C.formatWorkClock(w.at) + ' · ' + w.edits + ' 处修改' +
          (w.session ? '' : ' · 仅预览');
        meta.appendChild(nm);
        meta.appendChild(sub);
        card.appendChild(meta);

        card.onclick = () => openWorkPreview(w.id);
        grid.appendChild(card);
      }
      list.appendChild(grid);
    }
  }

  /** 作品预览：大图 + 继续编辑 / 删除 */
  function openWorkPreview(id) {
    const w = S.library.find((e) => e.id === id);
    if (!w) return;
    const el = $('work-preview');
    if (!el) return;

    const canEdit = C.isSessionUsable(w.session) || !!w.bgResult;
    el.innerHTML =
      '<div class="wp-mask" data-wp-close></div>' +
      '<div class="wp-body">' +
        '<div class="wp-head">' +
          '<div>' +
            '<div class="wp-title">' + escapeHtml(w.name) + '</div>' +
            '<div class="wp-sub">' + escapeHtml(C.describeWorkAge(w.at, Date.now())) + ' ' +
              escapeHtml(C.formatWorkClock(w.at)) + ' · ' + w.edits + ' 处修改' +
              (w.docW ? ' · ' + w.docW + '×' + w.docH : '') + '</div>' +
          '</div>' +
          '<button class="tb-btn icon" data-wp-close>' +
            '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
          '</button>' +
        '</div>' +
        (w.thumb ? '<img class="wp-img" src="' + w.thumb + '" alt="' + escapeHtml(w.name) + '">' : '') +
        '<div class="wp-actions">' +
          (canEdit
            ? '<button class="primary grow" id="wp-continue">继续编辑这张</button>'
            : '<div class="wp-note">这张的编辑数据已被空间清理，只能查看预览</div>') +
          '<button class="danger" id="wp-delete">删除记录</button>' +
        '</div>' +
      '</div>';
    el.hidden = false;

    el.querySelectorAll('[data-wp-close]').forEach((b) => { b.onclick = () => { el.hidden = true; }; });
    const del = $('wp-delete');
    if (del) del.onclick = () => {
      S.library = S.library.filter((e) => e.id !== id);
      saveLibrary();
      el.hidden = true;
      renderLibrary();
      updateLibraryBadge();
      toast('已删除这条记录');
    };
    const cont = $('wp-continue');
    if (cont) cont.onclick = async () => {
      el.hidden = true;
      await continueWork(id);
    };
  }

  /** 从作品库恢复一张照片继续编辑 */
  async function continueWork(id) {
    const w = S.library.find((e) => e.id === id);
    if (!w) { toast('这条记录已不存在'); return; }
    // 会话存在（有底图可还原）就行 —— 空壳会话 + 待贴回结果是有意义的：
    // 恢复底图之后紧接着会把结果贴上去。
    // 只有「会话本身就是空壳、又没有待贴回结果」才是真的没法继续。
    if (!w.session || (!C.isSessionUsable(w.session) && !w.bgResult)) {
      // 没有会话 = 不能还原整张照片。
      // 但如果上面挂着「后台生成的结果」，用户点它的意图很明确（想看看结果），
      // 不该被一句「没有可恢复的编辑数据」堵住 —— 至少把结果作为一条独立记录
      // 落到**当前打开的照片**上，让用户能看到。
      if (w.bgResult) { await landOrphanResult(w); return; }
      toast('这条记录没有可恢复的编辑数据');
      return;
    }

    // 当前有未保存的编辑时先确认，避免用户误以为「刚才的还在」
    if (S.edits.length && S.workId !== id) {
      const ok = window.confirm(
        '当前照片还有 ' + S.edits.length + ' 处未导出的修改。\n' +
        '继续编辑历史记录会替换掉当前画面（当前这张已存入修图记录，随时可以回来）。\n\n继续？'
      );
      if (!ok) return;
      // 先把当前这张存进作品库，保证不丢
      touchWork();
    }

    await restoreSession(w.session);
    // 接管为「当前作品」：后续编辑继续写这条记录
    S.workId = w.id;
    S.workStartedAt = w.createdAt || w.at;
    undoStack = C.createUndoStack(100);
    updateUI();
    updateLibraryBadge();
    toast('已回到「' + w.name + '」，可以继续修改', 3200);
    // 这条记录上如果挂着「后台生成的结果」，现在把它贴回 ——
    // 这正是后台生成的闭环：离开 → 生成完 → 回来 → 结果自动贴上。
    // 放在 toast 之后：贴回成功会再弹一条更具体的提示，覆盖掉上面那句。
    if (w.bgResult) {
      const applied = await applyStashedResult(w);
      if (applied) {
        // 结果已用掉，任务也标记成已看过
        markJobsSeen(w.id);
        renderHome();
      }
    }
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderHistory() {
    const list = $('hist-list');
    const empty = $('hist-empty');
    const badge = $('hist-count');
    const foot = $('hist-foot');
    if (!list) return;

    const tl = currentTimeline();
    const steps = tl.items.length - 1;         // 不含「原图」那一格

    if (badge) { badge.textContent = String(steps); badge.hidden = steps === 0; }
    if (empty) empty.hidden = steps > 0;
    list.innerHTML = '';

    const cursor = S.histPreview ? S.histPreview.cursor : tl.cursor;
    const total = steps;

    // 从最新到最旧展示（用户最关心最近的操作）
    for (let i = tl.items.length - 1; i >= 0; i--) {
      const it = tl.items[i];
      const isNow = (i === cursor);
      const isFuture = i > cursor;             // 已撤销（可以再跳回来）
      const isPreviewing = S.histPreview && isNow;

      const row = document.createElement('div');
      row.className = 'hist-item' + (isNow ? ' now' : '') +
        (isFuture ? ' future' : '') + (isPreviewing ? ' preview' : '');

      const dot = document.createElement('div');
      dot.className = 'hist-dot';
      if (it.kind === 'origin') dot.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 15 5-5 4 4 3-3 6 6"/></svg>';

      const body = document.createElement('div');
      body.className = 'hist-body';

      const top = document.createElement('div');
      top.className = 'hist-top';
      const label = document.createElement('div');
      label.className = 'hist-label';
      label.textContent = it.label;
      top.appendChild(label);

      if (isNow) {
        const tag = document.createElement('span');
        tag.className = 'hist-tag';
        tag.textContent = isPreviewing ? '预览中' : '当前';
        top.appendChild(tag);
      }

      const sub = document.createElement('div');
      sub.className = 'hist-sub';
      const bits = [];
      if (it.detail) bits.push(it.detail);
      if (it.kind !== 'origin') {
        bits.push(it.layers + ' 处修改');
        if (it.strokes) bits.push(it.strokes + ' 笔涂改');
      }
      if (it.time) bits.push(fmtClock(it.time));
      sub.textContent = bits.join(' · ');

      body.appendChild(top);
      body.appendChild(sub);

      const go = document.createElement('button');
      go.className = 'hist-go';
      go.textContent = isNow ? '查看' : (isFuture ? '跳到这里' : '跳到这里');
      go.onclick = () => previewHistoryAt(i);

      row.appendChild(dot);
      row.appendChild(body);
      row.appendChild(go);
      list.appendChild(row);
    }

    // 底部操作条
    if (foot) {
      const previewing = !!S.histPreview;
      foot.hidden = !previewing;
      const off = $('hist-preview-off'), jump = $('hist-jump');
      if (off) off.hidden = !previewing;
      if (jump) {
        const atNow = S.histPreview && S.histPreview.cursor === tl.cursor;
        jump.hidden = !previewing || atNow;
        if (previewing) jump.textContent = '回到这一步（撤销 ' + Math.max(0, tl.cursor - S.histPreview.cursor) + ' 步）';
      }
    }
  }

  /** 时间戳 → HH:MM（只显示时刻，日期无意义——都是同一次编辑） */
  function fmtClock(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /**
   * 预览历史上的某一步。
   *
   * 做法是**真正执行**撤销/重做（而不是画个近似缩略图）——
   * 这样用户看到的就是跳过去之后的真实画面，不会有「预览和实际不一致」。
   * 首次预览前把现场存进 histStash，退出预览时恢复。
   */
  function previewHistoryAt(targetIdx) {
    if (!undoStack || !S.docCanvas) return;
    const tl = currentTimeline();
    const total = tl.items.length - 1;
    const target = Math.max(0, Math.min(targetIdx, total));
    const from = S.histPreview ? S.histPreview.cursor : tl.cursor;
    const plan = C.planHistoryJump(from, target, total);
    if (!plan.undo && !plan.redo && S.histPreview) {
      // 已经在这一点上，再点一次就退出预览
      cancelHistoryPreview();
      return;
    }

    // 第一次进入预览：存现场
    if (!S.histPreview) {
      S.histStash = {
        edits: S.edits.slice(),
        strokes: S.strokes.slice(),
        docVersion: S.docVersion
      };
    }

    // 逐条执行（复用 applyCommand，保证与撤销按钮完全同一套逻辑）
    // 用 histBatching 跳过中间过程的重绘：跳 20 步就只重绘 1 次
    histBatching = true;
    try {
      for (let i = 0; i < plan.undo; i++) {
        const cmd = undoStack.undo();
        if (!cmd) break;
        applyCommand(cmd, false);
      }
      for (let i = 0; i < plan.redo; i++) {
        const cmd = undoStack.redo();
        if (!cmd) break;
        applyCommand(cmd, true);
      }
    } finally {
      histBatching = false;
    }

    S.histPreview = { cursor: target, total };
    renderHistory();
    renderLayers();
    draw();
    toast(target === total ? '已回到最新状态' : '预览第 ' + target + ' 步的画面（点「回到这一步」确认）', 2600);
  }

  /** 退出预览，恢复现场（silent=true 时不弹提示，用于关闭面板） */
  function cancelHistoryPreview(silent) {
    const st = S.histStash;
    if (!st) { S.histPreview = null; return; }
    // 先算出「当前预览位置 → 现场位置」需要走几步，再走回去
    const tl = currentTimeline();
    const total = tl.items.length - 1;
    const plan = C.planHistoryJump(S.histPreview ? S.histPreview.cursor : tl.cursor, total, total);
    histBatching = true;
    try {
      for (let i = 0; i < plan.redo; i++) {
        const cmd = undoStack.redo();
        if (!cmd) break;
        applyCommand(cmd, true);
      }
    } finally {
      histBatching = false;
    }
    S.histPreview = null;
    S.histStash = null;
    renderHistory();
    renderLayers();
    draw();
    updateUI();
    if (!silent) toast('已退出预览，回到最新状态');
  }

  /** 确认跳到预览的那一步：丢弃「未来」的命令，让这一步成为新起点 */
  function commitHistoryJump() {
    if (!S.histPreview || !undoStack) return;
    const at = S.histPreview.cursor;
    const tl = currentTimeline();
    const total = tl.items.length - 1;
    if (at >= total) { cancelHistoryPreview(); return; }
    undoStack.dropFuture();
    S.histPreview = null;
    S.histStash = null;
    invalidateMask();
    S.docVersion++;
    rebuildViewCanvas();
    renderHistory();
    renderLayers();
    draw();
    updateUI();
    scheduleSessionSave();
    toast('已回到第 ' + at + ' 步，之后的 ' + (total - at) + ' 步已移除（可继续操作）', 3200);
  }

  /* ============================ 错误面板 ============================ */

  let lastError = null;
  let lastRequest = null;   // 最近一次实际发出的请求（用于自查）
  let lastUpscale = null;
  let lastStrokeNote = '';   // 本次请求有没有把笔迹画进图（用于请求自检显示）
  // 本次生成用的选区。笔迹坐标相对它存储，换算时必须用它做基准。
  let lastSelRect = null;   // 最近一次的上采样信息

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
  // 对比视图的缩放状态。null = 还没算过（首次进入按「适应窗口」）
  let cmpView = null;
  // 手势现场
  let cmpDrag = null;       // { mode:'split'|'pan', startX, startY, view0, split0 }
  let cmpPointers = new Map();
  let cmpPinch = null;      // { dist0, view0, cx, cy }
  let cmpLastTap = 0, cmpLastTapX = 0, cmpLastTapY = 0;
  /** 上一次布局用的视口尺寸（用来发现"布局变了但还没重算"） */
  let cmpLayoutSize = { w: 0, h: 0 };

  /* ---------------- 长按对比原图 ----------------
   *
   * 按住画面就显示「原图」（S.docCanvas = 导入时那张，不含任何编辑），
   * 松手恢复。用来随时确认"改了这么多，原始是什么样"。
   *
   * 为什么不复用生成后的对比页（#compare）：
   *   那套是「修改前 / 修改后」的左右分割，还带应用/放弃按钮，
   *   属于一次性的确认流程。长按是随时看一眼，不该弹出任何东西。
   *
   * 交互细节（都是踩过的坑）：
   *   - 450ms 才算长按：太短会在正常拖动时误触发
   *   - 移动超过 8px 就取消：说明用户是在拖，不是要对比
   *   - 长按期间**不能**让原手势继续（否则会画出笔迹）
   */
  const LONG_PRESS_MS = 450;
  const LONG_PRESS_MOVE_TOL = 8;
  let longPressTimer = 0;
  let longPressActive = false;
  let longPressStart = null;
  let longPressPointerId = null;

  /** 当前该显示原图吗（绘制时用） */
  function showingOriginal() { return longPressActive; }

  /** 开始长按计时（在 pointerdown 里调） */
  function armLongPress(p, pointerId) {
    cancelLongPress();
    longPressStart = { x: p.x, y: p.y };
    longPressPointerId = pointerId;
    longPressTimer = setTimeout(() => {
      longPressTimer = 0;
      // 长按生效：把当前手势整个丢掉，避免松手时留下一笔。
      //
      // 还要清掉「点一下就会建出来的退化选区」：pointerdown 里如果是空白处
      // 按下，会立刻 S.rect = {x,y,w:0,h:0} 并开始拉框。长按触发时这个
      // 0×0 选区已经存在了 —— 它会让 drawSelection() 把整个画面压暗，
      // 表现就是"长按后画面变白/看不清"，而用户完全不知道原因。
      const degenerate = S.rect && (S.rect.w < 1 || S.rect.h < 1);
      if (degenerate) S.rect = null;
      S.gesture = null;
      S.pointers.clear();
      longPressActive = true;
      draw();
    }, LONG_PRESS_MS);
  }

  /** 取消长按（移动超限 / 抬起 / 多指） */
  function cancelLongPress() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = 0; }
    longPressStart = null;
    longPressPointerId = null;
    if (longPressActive) {
      longPressActive = false;
      draw();
    }
  }

  /** 当前视口尺寸（对比层是全屏的） */
  function cmpSize() {
    const r = $('compare').getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  }

  /** 「适应窗口」的基准视图 —— 双击复位与缩放倍数都以它为参照 */
  function cmpFitView() {
    const s = cmpSize();
    return C.fitView(S.docW, S.docH, s.w, s.h, 10);
  }

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
    cmpView = null;              // 每次进入都从「适应窗口」开始
    cmpLastTap = 0;
    $('compare').hidden = false;
    // 先画一次（用当前能拿到的尺寸），再等一帧重画。
    // 原因：刚把 hidden 改成 false 时，浏览器还没完成布局，
    // getBoundingClientRect() 可能返回 0 或上一帧的旧尺寸。
    // 第一帧先兜住"立刻可见"，第二帧布局一定完成了，尺寸才准。
    layoutCompare();
    drawCompare();
    requestAnimationFrame(() => {
      if (!S.pending) return;      // 用户可能已经放弃/应用了
      layoutCompare();
      drawCompare();
    });
  }

  /**
   * 把对比画布的内部分辨率对齐到当前视口。
   *
   * 这里踩过一个坑，症状是「生成后的确认页比原图大一点，而且只显示左上角」：
   *   原来除了设 width/height（内部分辨率），还写死了
   *   style.width/height 为 getBoundingClientRect() 的像素值。
   *   而 CSS 里 #cmp-cv 本来就是 width:100%;height:100% ——
   *   两套尺寸互相打架。更要紧的是 showCompare() 里
   *   `hidden=false` 之后**立刻**调这里，此时布局往往还没完成，
   *   getBoundingClientRect() 可能拿到 0 或上一帧的旧值；
   *   画布一旦被设成错误的尺寸，绘制时按 CSS 拉伸到满屏，
   *   看起来就是「放大了一点、只看到左上角」。
   *
   * 现在：
   *   - 只设内部分辨率（width/height），显示尺寸完全交给 CSS
   *   - 尺寸没变就什么都不做（避免每帧重建画布、丢内容）
   *   - 每次绘制前调一次，布局迟到也能自动纠正
   */
  function layoutCompare() {
    const r = $('compare').getBoundingClientRect();
    const d = DPR();
    const cssW = Math.max(1, r.width);
    const cssH = Math.max(1, r.height);
    const bw = Math.max(1, Math.round(cssW * d));
    const bh = Math.max(1, Math.round(cssH * d));

    if (cmpCv.width !== bw || cmpCv.height !== bh) {
      cmpCv.width = bw;
      cmpCv.height = bh;
    }
    // 不再写 style.width/height：CSS 的 100% 才是唯一权威，
    // 手写像素值只会在布局变化后留下过期尺寸。
    if (!cmpCtx) cmpCtx = cmpCv.getContext('2d');
    cmpCtx.setTransform(d, 0, 0, d, 0, 0);

    // 视口尺寸变了：把缩放状态夹回可视范围，避免露出空白
    if (cmpView) {
      cmpView = C.clampView(cmpView, S.docW, S.docH, cssW, cssH);
    }
    cmpLayoutSize = { w: cssW, h: cssH };
    return { w: cssW, h: cssH };
  }

  function drawCompare() {
    if (!cmpCtx || !cmpBefore) return;
    // 每次绘制前对齐一次尺寸：showCompare 里刚把 hidden 改 false 时
    // 布局可能还没完成，那一刻拿到的尺寸是错的。这里兜住，
    // 保证画布内部分辨率永远等于真实视口 —— 否则画面会被拉伸
    // （表现为"放大了一点、只看到左上角"）。
    const now = $('compare').getBoundingClientRect();
    if (Math.abs(now.width - cmpLayoutSize.w) > 0.5 ||
        Math.abs(now.height - cmpLayoutSize.h) > 0.5) {
      layoutCompare();
    }
    const W = Math.max(1, now.width), H = Math.max(1, now.height);
    const fit = C.fitView(S.docW, S.docH, W, H, 10);
    // 没有缩放状态时用适应窗口（首次进入）
    const v = cmpView || fit;

    cmpCtx.clearRect(0, 0, W, H);
    cmpCtx.fillStyle = '#0b0d11';
    cmpCtx.fillRect(0, 0, W, H);

    const dr = C.imageRectToScreen({ x: 0, y: 0, w: S.docW, h: S.docH }, v);
    cmpCtx.imageSmoothingEnabled = v.scale < 1;
    cmpCtx.drawImage(cmpBefore, dr.x, dr.y, dr.w, dr.h);

    // 放大后分割线可能落到视口外（那样就只剩单侧可见，没法对比了），
    // 所以统一经 placeCompareSplit 夹到视口内
    const sp = C.placeCompareSplit({
      view: v, imgW: S.docW, imgH: S.docH,
      split: cmpSplit, viewW: W, inset: 14
    });
    const sx = sp.screenX;
    cmpCtx.save();
    cmpCtx.beginPath();
    cmpCtx.rect(sx, 0, W - sx, H);
    cmpCtx.clip();
    cmpCtx.drawImage(cmpAfter, dr.x, dr.y, dr.w, dr.h);
    cmpCtx.restore();

    // 选区提示：放大后线宽按比例减细，否则会显得很粗
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
    updateCompareZoomUI(v, fit);
  }

  /** 把缩放状态刷到界面：倍数、提示语、复位按钮 */
  function updateCompareZoomUI(view, fit) {
    const info = C.describeCompareZoom(view, fit);
    const zoomEl = $('cmp-zoom');
    if (zoomEl) {
      zoomEl.textContent = info.text;
      zoomEl.hidden = !info.zoomed;
    }
    const hintEl = $('cmp-hint');
    if (hintEl && hintEl.textContent !== info.hint) hintEl.textContent = info.hint;
    const resetEl = $('cmp-reset');
    if (resetEl) resetEl.hidden = !info.canReset;
  }

  /** 复位到适应窗口 */
  function resetCompareZoom() {
    cmpView = null;
    drawCompare();
  }

  function initCompareInteraction() {
    const el = $('compare');

    /** 双击：放大到指定倍数（以点击点为中心），再双击还原 */
    const doubleTap = (clientX, clientY) => {
      const r = el.getBoundingClientRect();
      const px = clientX - r.left, py = clientY - r.top;
      const fit = cmpFitView();
      const res = C.planCompareDoubleTap({
        view: cmpView || fit,
        fitView: fit,
        px, py,
        zoom: 3,
        imgW: S.docW, imgH: S.docH,
        viewW: r.width, viewH: r.height,
        maxScale: 12
      });
      cmpView = res.zoomed ? res.view : null;   // 还原时直接回到 fit（null 即自适应）
      drawCompare();
    };

    const localX = (e) => e.clientX - el.getBoundingClientRect().left;
    const localY = (e) => e.clientY - el.getBoundingClientRect().top;

    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.cmp-actions') || e.target.closest('.cmp-hint')) return;
      if (e.target.closest('.cmp-reset')) return;
      cmpPointers.set(e.pointerId, { x: localX(e), y: localY(e) });

      // 双指：进入捏合缩放
      if (cmpPointers.size === 2) {
        const pts = [...cmpPointers.values()];
        cmpPinch = {
          dist0: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
          view0: cmpView || cmpFitView(),
          cx: (pts[0].x + pts[1].x) / 2,
          cy: (pts[0].y + pts[1].y) / 2
        };
        cmpDrag = null;
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        return;
      }
      if (cmpPointers.size > 2) return;

      const r = el.getBoundingClientRect();
      const fit = cmpFitView();
      const v = cmpView || fit;
      const dr = C.imageRectToScreen({ x: 0, y: 0, w: S.docW, h: S.docH }, v);
      const splitX = dr.x + dr.w * cmpSplit;

      // 判定这次按下是要拖分割线、平移画面，还是留给双击
      const mode = C.planCompareDrag({
        x: localX(e), splitX, hitPx: 22,
        scale: v.scale, fitScale: fit.scale
      });

      if (mode === 'split') {
        cmpDrag = { mode: 'split', pointerId: e.pointerId };
      } else if (mode === 'pan') {
        // 注意：pan 模式也要记 moved。放大后单指拖动是平移，
        // 但用户可能只是「点一下」—— 那种情况仍应参与双击判定，
        // 否则放大后就再也双击不回去（用户被卡在放大态）。
        cmpDrag = {
          mode: 'pan', pointerId: e.pointerId,
          startX: e.clientX, startY: e.clientY,
          view0: Object.assign({}, v),
          moved: false
        };
      } else {
        // tap：先记下，等 pointerup 时判断是不是双击
        cmpDrag = { mode: 'tap', pointerId: e.pointerId, moved: false, startX: e.clientX, startY: e.clientY };
      }
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });

    el.addEventListener('pointermove', (e) => {
      if (!cmpPointers.has(e.pointerId)) return;
      cmpPointers.set(e.pointerId, { x: localX(e), y: localY(e) });

      // 捏合缩放
      if (cmpPinch && cmpPointers.size >= 2) {
        const pts = [...cmpPointers.values()];
        const d = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
        const fit = cmpFitView();
        const r = el.getBoundingClientRect();
        const want = C.zoomAt(cmpPinch.view0, cmpPinch.cx, cmpPinch.cy,
          d / cmpPinch.dist0, Math.max(0.02, fit.scale * 0.4), 12);
        cmpView = C.clampView(want, S.docW, S.docH, r.width, r.height);
        drawCompare();
        return;
      }

      const g = cmpDrag;
      if (!g || g.pointerId !== e.pointerId) return;

      if (g.mode === 'tap') {
        // 超过阈值就说明不是点击（避免拖动画布被误判成双击）
        if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > 10) g.moved = true;
        return;
      }

      if (g.mode === 'split') {
        const r = el.getBoundingClientRect();
        const fit = cmpFitView();
        const v = cmpView || fit;
        const dr = C.imageRectToScreen({ x: 0, y: 0, w: S.docW, h: S.docH }, v);
        // 把屏幕坐标反算成「图内比例」，这样放大后拖分割线依然准确
        cmpSplit = C.clamp01(dr.w > 0 ? ((e.clientX - r.left) - dr.x) / dr.w : 0.5);
        drawCompare();
        return;
      }

      if (g.mode === 'pan') {
        const dx = e.clientX - g.startX, dy = e.clientY - g.startY;
        if (Math.hypot(dx, dy) > 6) g.moved = true;
        if (!g.moved) return;      // 还没超过阈值：可能是点击，先不平移
        const r = el.getBoundingClientRect();
        const nv = C.makeView(g.view0.scale,
          g.view0.tx + dx, g.view0.ty + dy);
        cmpView = C.clampView(nv, S.docW, S.docH, r.width, r.height);
        drawCompare();
      }
    });

    const endPointer = (e) => {
      const g = cmpDrag;
      cmpPointers.delete(e.pointerId);

      if (cmpPinch && cmpPointers.size < 2) cmpPinch = null;

      // tap 模式、以及「按下了但没移动」的 pan 模式，都算一次点击
      const isTap = g && g.pointerId === e.pointerId && !g.moved &&
        (g.mode === 'tap' || g.mode === 'pan');
      if (isTap) {
        // 双击判定：两次点击间隔 < 300ms 且位置接近
        const now = Date.now();
        const near = Math.hypot(e.clientX - cmpLastTapX, e.clientY - cmpLastTapY) < 40;
        if (now - cmpLastTap < 300 && near) {
          cmpLastTap = 0;
          doubleTap(e.clientX, e.clientY);
        } else {
          cmpLastTap = now;
          cmpLastTapX = e.clientX;
          cmpLastTapY = e.clientY;
        }
      }
      cmpDrag = null;
    };
    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', endPointer);

    // 桌面端双击（鼠标）也支持
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.cmp-actions') || e.target.closest('.cmp-hint')) return;
      doubleTap(e.clientX, e.clientY);
    });

    // 滚轮缩放（桌面/外接鼠标）
    el.addEventListener('wheel', (e) => {
      if (e.target.closest('.cmp-actions')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const fit = cmpFitView();
      const v = cmpView || fit;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const nv = C.zoomAt(v, e.clientX - r.left, e.clientY - r.top, factor,
        Math.max(0.02, fit.scale * 0.4), 12);
      cmpView = C.clampView(nv, S.docW, S.docH, r.width, r.height);
      drawCompare();
    }, { passive: false });

    const resetBtn = $('cmp-reset');
    if (resetBtn) resetBtn.onclick = resetCompareZoom;
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
    scheduleWorkSave();           // 记进作品库（跨天可查）
    renderLayers();               // 刷新修改记录面板
    closeCompare();
    updateUI();
    draw();
    // AI 改完常常还差一点颜色（偏冷偏暖/发灰/过艳）—— 这些纯数学能修，
    // 不该再花一次模型调用。所以贴回后直接把调色工具对着**同一块区域**打开。
    //
    // 刻意做成「不打断」：只是切到调色工具并摆好选区，用户想用就用，
    // 不想用直接切别的工具（或按返回键退回框选）即可，不会弹窗拦人。
    // 也不自动改任何像素 —— 滑块全在 0，画面上看到的还是刚贴回的结果。
    // 什么时候**不**自动打开：用户正拿着画笔或引导线在画东西。
    // 这两种模式是「手工进行中」的状态，把他拽到另一个工具会打断思路 ——
    // 用户刚画完引导线生成完，多半还想接着调框、再画一条，不是想调色。
    // 框选/平移/已在调色时切过去没有打断风险，才自动进。
    const gradeMode = S.mode;
    const midTask = gradeMode === 'brush' || gradeMode === 'guide';
    // 设置里可以关掉（默认开）：不想被切走工具的用户有权关
    if (S.cfg.autoGrade !== false && !midTask) {
      openGradeTool(edit.rect);
      toast(S.historyNote
        ? '已贴回原图（' + S.historyNote + '）· 可以顺手调个色'
        : '已贴回原图 · 可以顺手调个色', S.historyNote ? 3600 : 3000);
      return;
    }
    toast(S.historyNote ? '已贴回原图（' + S.historyNote + '）' : '已贴回原图', S.historyNote ? 3600 : 2600);
  }

  /**
   * 关闭对比视图。
   *
   * 统一走这里：缩放状态必须一起清掉，否则下次生成时
   * 会带着上次的缩放和偏移进来（用户看到的是「上次那个放大位置」）。
   */
  function closeCompare() {
    $('compare').hidden = true;
    cmpView = null;
    cmpDrag = null;
    cmpPinch = null;
    cmpPointers.clear();
    cmpLastTap = 0;
  }

  function discardPending() {
    S.pending = null;
    closeCompare();
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
    S.docRev++;                  // 撤销/重做改了编辑 → 打包缓存失效
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
    S.docRev++;                  // 编辑变了 → 打包缓存失效
    updateUI();
    // 所有改动画面的操作都会经过这里（生成/画笔/调参/开关/删除），
    // 所以在这里挂一次作品库保存，就覆盖了全部编辑路径。
    scheduleWorkSave();
  }

  /* ============================ 导出 ============================ */

  async function exportImage(overridePreset) {
    if (!S.viewCanvas) return;
    // 导出面板里选好的设置优先；没有（比如旧入口/快捷导出）才回落到设置页的预设
    const preset = overridePreset || C.getExportPreset(S.cfg.exportPreset);
    // 设置页那个「自定义」预设的格式/质量存在 S.cfg 里，需要特殊照顾；
    // 而导出面板生成的预设（explicit）自带格式与质量，必须直接用它自己那套 ——
    // 否则用户在面板里选了 PNG，导出出来还是 JPEG。
    const isCustom = preset.id === 'custom' && preset.explicit !== true;
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
        console.warn('[枫叶修图] 写入元数据失败（不影响导出）', e);
      }
    }

    // 导出是「这张做完了」的信号：立刻存一次作品库（不等防抖），
    // 并把原图也存下来，方便以后对比修改前后。
    if (S.edits.length) {
      try {
        touchWork();
        const rec = S.library.find((e) => e.id === S.workId);
        if (rec && !rec.before && S.docCanvas) {
          rec.before = makeThumb(S.docCanvas, C.THUMB_MAX_SIDE);
          saveLibrary();
        }
      } catch (e) { /* 作品库失败不影响导出 */ }
    }

    const name = C.timestampName('retouched', fmt === 'image/png' ? 'png' : 'jpg');
    const note = (metaNote ? ' · ' + metaNote : '') +
      (S.meta && S.meta.exif ? ' · 已保留拍摄信息' : '');

    // 安卓壳：WebView 既不支持 Web Share，也没有 DownloadListener，
    // 点 <a download> 什么都不会发生（但 toast 照样报成功）。
    // 所以壳里改走本地服务把二进制交给原生写盘 —— 位置由用户选。
    if (nativeSaveAvailable()) {
      const r = await nativeSave(blob, name, S.cfg.expSaveWhere);
      if (r.ok) {
        toast('已保存到 ' + r.path + '（' + C.formatBytes(blob.size) + '）' + note, 4200);
        return;
      }
      if (r.canceled) { toast('已取消导出'); return; }
      // 失败（比如没给存储权限）就退回分享/下载，别让用户白等
      toast((r.error || '保存失败') + ' · 改用分享', 4000);
    }

    // 浏览器：优先系统分享，其次下载
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
    toast('已导出 ' + name + '（' + C.formatBytes(blob.size) + '）' + note, 3600);
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
    const piBtn = $('btn-photoinfo');
    if (piBtn) piBtn.disabled = !S.img;
    syncSaveNowUI();

    // 历史按钮上的步数（不含「原图」那一格）
    const hb = $('hist-count');
    if (hb) {
      const sz = undoStack ? undoStack.size() : { past: 0, future: 0 };
      const n = sz.past + sz.future;
      hb.textContent = String(n);
      hb.hidden = n === 0;
    }

    // 缩放显示
    $('zoom-label').textContent = Math.round(S.view.scale * 100) + '%';

    // 选区信息。
    // 没有框选时显示「整张图」——用户必须知道这次操作会作用于全图，
    // 而不是像以前那样看到一片空白、猜自己是不是漏了哪一步。
    const info = $('sel-info');
    if (S.img && S.docCanvas) {
      const wholeSel = !S.rect;
      const selRect = effectiveRect();
      info.hidden = false;
      const m0 = C.findModel(S.cfg.provider, S.cfg.model);
      const { size, aspect } = selRect ? pickOutputSize(selRect) : { size: null, aspect: null };
      const px = selRect ? Math.round(selRect.w * (S.imgW / S.docW)) : 0;
      const py = selRect ? Math.round(selRect.h * (S.imgH / S.docH)) : 0;
      const selPill = wholeSel
        ? '<span class="hud-pill whole">整张图 ' + Math.round(S.docW) + '×' + Math.round(S.docH) + '</span>'
        : '<span class="hud-pill">选区 ' + Math.round(selRect.w) + '×' + Math.round(selRect.h) + '</span>';
      info.innerHTML = selPill +
        (size ? `<span class="hud-pill dim">出图 ${size}</span>` : aspect ? `<span class="hud-pill dim">出图 ${aspect}</span>` : '') +
        (!wholeSel && px !== Math.round(selRect.w) ? `<span class="hud-pill dim">原图 ${px}×${py}</span>` : '');
    } else {
      info.hidden = true;
    }

    // 生成按钮。
    // 有照片就能生成：没有框选时按整张图处理（见 effectiveRect），
    // 所以这里的判断从「必须有合法选区」放宽成「必须有照片」。
    const canGen = !!S.img && !!S.docCanvas && !S.busy;
    $('btn-generate').disabled = !canGen;
    const m = C.findModel(S.cfg.provider, S.cfg.model);
    const dev = aspectDevPct();
    const devNote = dev >= 6 ? `（出图比例与选区差 ${dev}%，会自动按比例裁切，不会变形）` : '';
    const outSize = (S.img && S.docCanvas) ? pickOutputSize(effectiveRect()) : null;
    const sizeNote = (outSize && outSize.size) ? `出图 ${outSize.size}；` : '';
    // 成本预估：让用户在点之前就知道要花多少
    const est = (S.img && S.docCanvas) ? currentEstimate() : null;
    let costNote = '';
    if (est) {
      if (est.known) {
        costNote = '预计 ' + C.formatUsd(est.totalUsd) + '（' + C.formatCny(est.totalCny) + '）' +
          (est.calls > 1 ? '，' + est.calls + ' 次调用' : '') + '；';
      } else {
        costNote = '单价未知（可在设置填写）；';
      }
    }
    const wholeHint = !S.rect ? '未框选 → 调整整张图；' : '';
    // 文生图模型：必须说清「照片和引导线都不会发给模型」。
    // 以前只写「不支持参考图」，用户看不懂这意味着什么 —— 他会以为
    // 「只是不能参考，我画的引导线应该还是有用的吧」，于是白白花一次钱。
    // 事实上这个模式下**整个请求体里没有任何图片**，引导线自然也到不了模型。
    const t2iWarn = '当前模型是文生图：照片和你画的引导线都不会发给模型，只能按文字重新生成；'
      + '想按原图改就换一个「可编辑」模型；';
    $('gen-hint').textContent = !S.img ? '先打开一张照片'
      : (m && m.kind === 't2i' ? wholeHint + t2iWarn + costNote
        : wholeHint + sizeNote + costNote + '就绪' + devNote);

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
    const btip = $('brush-tip');
    btip.hidden = !(inBrush && tipDecision('brush'));
    const inGuide = S.mode === 'guide';
    $('guide-bar').hidden = !inGuide;
    $('btn-guide').classList.toggle('active', inGuide);
    updateGuideBarVisibility();
    updateGuideBadge();
    // 调色工具：参数栏只在调色模式下露出（平时不占底栏空间）
    // 智能框选的工具条
    const inAuto = S.mode === 'auto';
    if ($('auto-bar')) $('auto-bar').hidden = !inAuto;
    if ($('auto-tip')) {
      const t = tipDecision('auto');
      $('auto-tip').hidden = !(inAuto && t);
    }
    const abtn = document.querySelector('.tool[data-mode="auto"]');
    if (abtn) abtn.classList.toggle('active', inAuto);

    const inGrade = S.mode === 'grade';
    $('grade-bar').hidden = !inGrade;
    const gtip = $('grade-tip');
    if (gtip) gtip.hidden = !(inGrade && tipDecision('grade'));
    const gbtn = $('btn-grade');
    if (gbtn) gbtn.classList.toggle('active', inGrade);
    updateGradeBadge();
    $('brush-erase').setAttribute('aria-pressed', String(S.brushErase));
    $('brush-erase').classList.toggle('on', S.brushErase);
    $('brush-restore').setAttribute('aria-pressed', String(!S.brushErase));
    $('brush-restore').classList.toggle('on', !S.brushErase);
  }

  /* ============================ 设置分级 ============================
   *
   * 一级（home）放 6 个入口，点进去才是具体设置。
   *
   * 为什么必须有「返回上一级」而不是直接关闭：用户从二级页按返回键，
   * 期待的是回到设置列表继续找，而不是把整个设置关掉重开。
   * 这和手机系统的行为一致，也是返回键逐级退的一部分。
   */

  /** 当前所在的设置子页（home 表示一级） */
  let settingsPage = 'home';

  /** 切到某个设置子页 */
  function showSettingsPage(id) {
    const page = id || 'home';
    const all = document.querySelectorAll('#settings [data-stpage]');
    if (!all.length) return;
    let found = false;
    all.forEach((el) => {
      const on = el.dataset.stpage === page;
      el.hidden = !on;
      if (on) found = true;
    });
    // 目标页不存在就退回一级，别让用户面对白屏
    if (!found) {
      all.forEach((el) => { el.hidden = el.dataset.stpage !== 'home'; });
      settingsPage = 'home';
    } else {
      settingsPage = page;
    }
    // 切页时滚回顶部：否则从长页返回会停在半截
    const sc = document.querySelector('#settings .sheet-scroll');
    if (sc) sc.scrollTop = 0;
  }

  /** 当前是否停在设置的一级页（返回键据此决定是退级还是关闭） */
  function settingsAtHome() {
    return settingsPage === 'home';
  }

  function openSettings() {
    $('settings').hidden = false;
    // 每次打开都从一级开始，不记住上次停在哪个子页 ——
    // 否则用户下次进来会「跳过了首页」，一时找不到想改的东西。
    showSettingsPage('home');
    syncSettingsUI();
  }
  function closeSettings() { $('settings').hidden = true; }

  /* ============================ 文生图 ============================
   *
   * 和「修图」是两条独立的路：
   *   修图  = 打开照片 → 框选 → 带参考图请求 → 结果贴回选区
   *   文生图 = 写描述 → 纯文字请求 → 结果直接作为一张新照片打开
   *
   * 刻意复用「生成中」遮罩、调用日志、成本统计、错误面板 ——
   * 这几样和修图完全一样，用户不需要学两套；只有「结果怎么落地」不同。
   */

  /** 文生图的输入状态（不持久化：这是临时输入，不该污染设置） */
  let t2i = { prompt: '', ratio: '1:1', negative: '' };

  function openT2i() {
    const el = $('t2i');
    if (!el) return;
    el.hidden = false;
    renderT2iRatios();
    syncT2iUI();
    // 自动聚焦到描述框：进来就是要写字，省一次点击
    setTimeout(() => {
      const p = $('t2i-prompt');
      if (p) { try { p.focus(); } catch (e) { /* 部分 WebView 不允许 */ } }
    }, 60);
  }
  function closeT2i() { const el = $('t2i'); if (el) el.hidden = true; }

  /**
   * 文生图成功后清空描述框。
   * 和修图那个 clearPromptIfUnchanged 同一个道理：只在「框里还是那次用的原文」
   * 时才清，用户已经在写新描述就不动。
   * @param {string} usedRaw 那次生成时输入框里的原文
   */
  function clearT2iIfUnchanged(usedRaw) {
    const el = $('t2i-prompt');
    if (!el) return;
    const now = String(el.value || '');
    const used = String(usedRaw == null ? '' : usedRaw);
    if (now !== used) return;
    if (!now) return;
    el.value = '';
    // 内存里的草稿也要一起清，否则下次打开面板又会把它填回去
    t2i.prompt = '';
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* ignore */ }
  }

  function renderT2iRatios() {
    const box = $('t2i-ratios');
    if (!box) return;
    box.innerHTML = '';
    for (const r of C.T2I_RATIOS) {
      const b = document.createElement('button');
      b.className = 'chip' + (r.id === t2i.ratio ? ' on' : '');
      b.dataset.ratio = r.id;
      b.textContent = r.label;
      b.onclick = () => {
        t2i.ratio = r.id;
        renderT2iRatios();
        syncT2iUI();
      };
      box.appendChild(b);
    }
  }

  /** 把当前状态和「这次会花什么、发多大」同步到界面 */
  function syncT2iUI() {
    const m = currentModelParams();
    const kind = m ? m.kind : null;
    const plan = C.planT2iSize(t2i.ratio, S.cfg.provider, m ? m.sizeMode : 'image_size');
    if ($('t2i-size-note')) {
      $('t2i-size-note').textContent = '出图尺寸：' + plan.size
        + (plan.note !== C.getT2iRatio(t2i.ratio).label ? '（该服务商规范尺寸，比例已自动修正）' : '');
    }
    const st = $('t2i-status');
    if (st) {
      st.className = 'status';
      if (!S.cfg.apiKey) {
        st.className = 'status bad';
        st.textContent = '还没填 API Key，去设置里填一下才能生成。';
      } else if (!S.cfg.model) {
        st.className = 'status bad';
        st.textContent = '还没选模型。';
      } else {
        // 用编辑模型做文生图也能出图，但和「参考我的照片」是两回事，
        // 这里点名说明，免得用户以为是 bug
        st.textContent = '模型：' + S.cfg.model
          + (kind === 't2i' ? '' : '（编辑模型，纯文字出图可能不如专用文生图模型）');
      }
    }
    const tip = $('t2i-tip');
    if (tip) {
      const est = estimateT2iCost();
      tip.innerHTML = est.text;
    }
  }

  /** 文生图的成本预估（复用修图那套单价表） */
  function estimateT2iCost() {
    try {
      const est = currentEstimate();
      if (!est || !est.known) return { text: '单价未知，可在设置里填写每张价格。' };
      const cny = est.totalUsd * (Number(S.cfg.usdCny) || 7.1);
      return {
        text: '预计花费约 $' + est.totalUsd.toFixed(3)
          + '（≈ ¥' + cny.toFixed(2) + '）· 1 次调用 · ' + (est.note || '')
      };
    } catch (e) {
      return { text: '' };
    }
  }

  /** 生图结果 → 一张新照片 */
  async function openAsNewPhoto(canvas, name) {
    // 转成 blob 再走 loadImageFromBlob：那条路已经处理好了
    // 「工作分辨率上限 / EXIF / 作品库登记 / 会话恢复」等一整套，
    // 直接 setImage(canvas) 会绕过这些，导出和恢复都会缺东西。
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.95));
    if (!blob) throw new Error('结果转换失败');
    await loadImageFromBlob(blob, name || ('文生图-' + new Date().toISOString().slice(0, 10) + '.jpg'));
  }

  /** 跑一次文生图 */
  async function runT2i() {
    ensureNotifyReady();
    const prompt = String($('t2i-prompt') ? $('t2i-prompt').value : '').trim();
    const negative = String($('t2i-negative') ? $('t2i-negative').value : '').trim();
    t2i.prompt = prompt;
    t2i.negative = negative;

    const m = currentModelParams();
    const check = C.checkT2i({
      prompt, model: S.cfg.model,
      kind: m ? m.kind : null
    });
    if (check) {
      toast(check.title + '：' + check.message.split('\n')[0], 3600);
      if ($('t2i-prompt')) { try { $('t2i-prompt').focus(); } catch (e) {} }
      return;
    }
    if (!S.cfg.apiKey) { toast('先去设置里填 API Key', 3000); return; }

    const fullPrompt = C.buildT2iPrompt(prompt, { isZh: S.cfg.lang !== 'en' });
    const req = C.buildT2iRequest({
      baseUrl: S.cfg.baseUrl,
      apiKey: S.cfg.apiKey,
      model: S.cfg.model,
      prompt: fullPrompt,
      negativePrompt: negative,
      ratio: t2i.ratio,
      providerId: S.cfg.provider,
      seed: S.cfg.seed
    });

    const aborter = new AbortController();
    S.t2iAborter = aborter;
    const t0 = Date.now();
    setBusy(true, '生成中', '文生图 · 大约 10–30 秒');
    closeT2i();
    try {
      const json = await callModel(req, aborter);
      const items = C.parseImageResponse(json);
      if (!items.length) {
        recordCallLog({
          at: t0, ms: Date.now() - t0, ok: false, status: 200,
          model: S.cfg.model, kind: 't2i', error: '接口没有返回图片', workId: ''
        });
        throw new Error('接口没有返回图片。这个模型可能不支持文生图，换一个试试。');
      }
      let blob;
      if (items[0].dataUrl) {
        const r = await fetch(items[0].dataUrl);
        blob = await r.blob();
      } else {
        blob = await urlToBlob(items[0].url);
      }
      const gen = await blobToCanvas(blob);
      const callCost = estimateCallCost();
      recordCallLog({
        at: t0, ms: Date.now() - t0, ok: true, status: 200,
        model: S.cfg.model, kind: 't2i', error: '',
        costUsd: callCost.usd, costNote: callCost.note, workId: ''
      });
      // 生成成功就把描述清掉：同一条描述连着生成两张的概率很低，
      // 留着反而容易忘改、白花一次钱。
      // 只在这条成功路径上清 —— 失败时用户要照着原话改了重试。
      // 用 prompt 快照比较，期间用户改过字就不动（别打断他在写新的）。
      // 放在 openAsNewPhoto **之前**：它会切走界面、重置一堆状态，
      // 之后再动输入框容易碰上「文档已换、控件已刷新」的边界情况。
      clearT2iIfUnchanged(prompt);
      await openAsNewPhoto(gen, '文生图-' + Date.now().toString(36) + '.jpg');
      // 文生图同样要发通知：它比修图更慢（十几秒起步），
      // 用户很可能趁这段时间切出去看别的。
      notifyGenDone('文生图完成，共生成 1 张');
      toast('已生成新照片，可以继续框选精修', 3000);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      recordCallLog({
        at: t0, ms: Date.now() - t0, ok: false,
        status: err && err.status ? err.status : 0,
        model: S.cfg.model, kind: 't2i',
        error: describeCallError(err), workId: ''
      });
      const why = (err && err.message) || '未知错误';
      notifyGenDone('文生图失败：' + String(why).replace(/\s+/g, ' ').slice(0, 60));
      showGenError(err, { kind: 't2i', model: S.cfg.model, baseUrl: S.cfg.baseUrl });
    } finally {
      S.t2iAborter = null;
      setBusy(false);
    }
  }

  /* ---------- 调用日志面板 ---------- */

  function openCallLog() {
    const el = $('calllog');
    if (!el) return;
    el.hidden = false;
    renderCallLog();
  }
  function closeCallLog() { const el = $('calllog'); if (el) el.hidden = true; }

  /** 设置页里那一行的副标题：直接显示条数与花费，不用点进去才知道 */
  function updateCallLogBrief() {
    const el = $('calllog-brief');
    if (!el) return;
    const st = C.callLogStats(S.callLog);
    el.textContent = st.count
      ? (st.count + ' 次 · 花费 ' + C.formatUsd(st.usd) + (st.failed ? ' · ' + st.failed + ' 次失败' : ''))
      : '每次模型调用的记录';
  }

  /** 渲染日志列表（最新的在最上面） */
  function renderCallLog() {
    const list = $('calllog-list');
    const empty = $('calllog-empty');
    const sum = $('calllog-summary');
    if (!list) return;

    const st = C.callLogStats(S.callLog);
    if (sum) {
      sum.textContent = st.count
        ? ('共 ' + st.count + ' 次 · 成功 ' + st.ok + ' 次 · 失败 ' + st.failed + ' 次 · 花费 ' +
          C.formatUsd(st.usd) + (st.unknown ? '（另有 ' + st.unknown + ' 次单价未知）' : '') +
          (st.avgMs ? ' · 平均 ' + (st.avgMs / 1000).toFixed(1) + ' 秒' : ''))
        : '';
    }
    if (empty) empty.hidden = st.count > 0;

    list.innerHTML = '';
    for (const e of S.callLog) {
      const item = document.createElement('div');
      item.className = 'cl-item' + (e.ok ? '' : ' bad');

      const head = document.createElement('div');
      head.className = 'cl-head';
      const t = document.createElement('span');
      t.className = 'cl-time';
      t.textContent = C.formatDateTime(e.at);
      const tag = document.createElement('span');
      tag.className = 'cl-tag' + (e.ok ? ' ok' : ' bad');
      tag.textContent = e.ok ? '成功' : '失败';
      const cost = document.createElement('span');
      cost.className = 'cl-cost';
      cost.textContent = (e.costUsd === null || e.costUsd === undefined)
        ? '花费未知' : C.formatUsd(e.costUsd);
      head.appendChild(t); head.appendChild(tag); head.appendChild(cost);
      item.appendChild(head);

      const model = document.createElement('div');
      model.className = 'cl-model';
      // 耗时判断**不能**用 `e.ms ? ...`：
      // ms 的合法值包含 0（瞬时返回 / 瞬时失败 —— 例如参数不对被服务端立刻拒绝），
      // 而 0 是 falsy，用真值判断会把「0.0 秒」这条信息静默吞掉，
      // 用户看到一条完全没有耗时的记录，会以为日志坏了。
      // 但也不能只判 Number.isFinite：Number(null) === 0 也是有限数，
      // 那样「没记录耗时」会被显示成「0.0 秒」，变成另一个错误。
      // 所以先排掉空值，再判有限数。
      const hasMs = e.ms !== null && e.ms !== undefined && e.ms !== '' &&
        Number.isFinite(Number(e.ms));
      model.textContent = (e.model || '（未记录模型）') +
        (e.provider ? ' · ' + e.provider : '') +
        (hasMs ? ' · ' + (Number(e.ms) / 1000).toFixed(1) + ' 秒' : '');
      item.appendChild(model);

      const metaBits = [];
      if (e.imgW || e.imgH) {
        metaBits.push('发送图片 ' + e.imgW + '×' + e.imgH +
          (e.imgBytes ? '（' + C.formatBytes(e.imgBytes) + '）' : ''));
      }
      if (e.status) metaBits.push('HTTP ' + e.status);
      if (metaBits.length) {
        const m = document.createElement('div');
        m.className = 'cl-meta';
        m.textContent = metaBits.join(' · ');
        item.appendChild(m);
      }

      if (e.prompt) {
        const p = document.createElement('div');
        p.className = 'cl-prompt';
        // 截断过就说明原提示词更长 —— 让用户知道日志里不是全文
        p.textContent = '要求：' + e.prompt + (e.promptLen > e.prompt.length ? '（共 ' + e.promptLen + ' 字）' : '');
        item.appendChild(p);
      }
      if (!e.ok && e.error) {
        const er = document.createElement('div');
        er.className = 'cl-error';
        er.textContent = '原因：' + e.error;
        item.appendChild(er);
      }

      // ---- 详情（点一下展开）----
      //
      // 摘要只够判断"成没成"，排查问题需要的是请求到底长什么样：
      // 参考图发没发出去、走的哪种传输、图片字段名、请求体多大…
      // 这些在摘要里放不下，全放又太吵，所以默认收起。
      const detailRows = C.buildCallLogDetail(e);
      // 有详情就要能复制：用户排查时最常做的是「把这条发给别人看」。
      // 只给个展开而不给复制，等于让他对着屏幕手抄。
      if (detailRows.length) {
        const acts = document.createElement('div');
        acts.className = 'cl-acts';
        const btn = document.createElement('button');
        btn.className = 'cl-more';
        btn.type = 'button';
        btn.textContent = '查看详情';
        const copy = document.createElement('button');
        copy.className = 'cl-more';
        copy.type = 'button';
        copy.textContent = '复制详情';
        copy.onclick = () => {
          const text = callLogEntryText(e, detailRows);
          copyToClipboard(text).then((ok) => {
            copy.textContent = ok ? '已复制' : '复制失败';
            setTimeout(() => { copy.textContent = '复制详情'; }, 1600);
          });
        };
        acts.appendChild(btn);
        acts.appendChild(copy);
        item.appendChild(acts);

        const box = document.createElement('div');
        box.className = 'cl-detail';
        box.hidden = true;
        for (const row of detailRows) {
          const r = document.createElement('div');
          r.className = 'cl-detail-row';
          const k = document.createElement('span');
          k.className = 'cl-detail-k';
          k.textContent = row.k;
          const v = document.createElement('span');
          v.className = 'cl-detail-v' + (row.warn ? ' warn' : '');
          v.textContent = row.v;
          r.appendChild(k); r.appendChild(v);
          box.appendChild(r);
        }
        btn.onclick = () => {
          box.hidden = !box.hidden;
          btn.textContent = box.hidden ? '查看详情' : '收起详情';
        };
        item.appendChild(box);
      }
      list.appendChild(item);
    }
  }

  /**
   * 把一条日志连同它的详情拼成纯文本（给「复制详情」用）。
   *
   * 摘要 + 详情都要带上：只复制详情的话，对方看不到时间、模型和成败，
   * 还得回头问一遍，等于没复制。
   */
  function callLogEntryText(e, rows) {
    const list = rows || C.buildCallLogDetail(e);
    const lines = [];
    lines.push(C.formatDateTime(e.at) + '  ' + (e.ok ? '成功' : '失败'));
    lines.push('模型：' + (e.model || '（未记录）') + (e.provider ? ' · ' + e.provider : ''));
    const hasMs = e.ms !== null && e.ms !== undefined && e.ms !== '' && Number.isFinite(Number(e.ms));
    if (hasMs) lines.push('耗时：' + (Number(e.ms) / 1000).toFixed(1) + ' 秒');
    if (e.prompt) lines.push('要求：' + e.prompt);
    for (const row of list) lines.push(row.k + '：' + row.v);
    return lines.join('\n');
  }

  /**
   * 写剪贴板。
   *
   * 安卓 WebView 里 navigator.clipboard 不一定有（非安全上下文 / 老内核），
   * 所以要有 execCommand 的兜底 —— 只靠新版 API 的话，
   * 在老机器上「复制」会静默失败，用户以为复制成功了。
   */
  function copyToClipboard(text) {
    return new Promise((resolve) => {
      const fallback = () => {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          // 必须真的在文档里且可见度不为 hidden，否则 execCommand 选不中
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.top = '-1000px';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          ta.setSelectionRange(0, ta.value.length);
          const ok = document.execCommand && document.execCommand('copy');
          document.body.removeChild(ta);
          resolve(!!ok);
        } catch (err) {
          resolve(false);
        }
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => resolve(true)).catch(fallback);
          return;
        }
      } catch (err) { /* 落到兜底 */ }
      fallback();
    });
  }

  /**
   * 收集一份「诊断包」：日志 + 环境 + 当前配置（已脱敏）。
   *
   * 为什么要单独做一个：光有日志往往不够定位问题。
   * 比如「参考图不生效」，需要同时知道：
   *   - 当时用的什么模型、是不是走了 multipart
   *   - 应用版本、安卓版本、WebView 版本
   *   - 用户是不是把某个开关关了
   * 这些散落在各个地方，让用户一项项报过来不现实，
   * 所以一次性打包成一份，方便直接发给我。
   *
   * **脱敏是硬要求**：API Key、完整提示词原文都不能带出去。
   * Key 只留头尾几位，提示词只留长度和前 40 字。
   */
  function buildDiagnosticBundle() {
    const env = {
      appVersion: APP_VERSION,
      // 构建时间：version.js 里如果有就带上，没有就留空。
      // 不能直接引用 __BUILD_AT__ —— 未定义时是 ReferenceError，
      // 而 try/catch 挡不住引用错误之外的时序问题（且会把诊断包整个搞崩）。
      buildTime: (function () {
        try {
          return (typeof window !== 'undefined' && window.__PS_BUILD_AT__) || '';
        } catch (e) { return ''; }
      })(),
      userAgent: navigator.userAgent || '',
      platform: navigator.platform || '',
      dpr: window.devicePixelRatio || 1,
      screen: (window.screen ? (window.screen.width + 'x' + window.screen.height) : ''),
      viewport: (function () {
        const v = viewSize ? viewSize() : null;
        return v ? (Math.round(v.w) + 'x' + Math.round(v.h)) : '';
      })(),
      // WebView 版本决定了很多兼容行为，排查必需
      webview: (function () {
        const m = /Chrome\/([\d.]+)/.exec(navigator.userAgent || '');
        return m ? m[1] : '';
      })(),
      compat: (S.compat && S.compat.level) || null,
      language: navigator.language || '',
      online: navigator.onLine !== false
    };

    // 配置：只带「影响请求」的项，且 Key 脱敏
    const cfg = S.cfg || {};
    const safeCfg = {
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKeyMasked: maskSecret(cfg.apiKey),
      // 以下这些都会实打实影响出图结果，排查时经常是元凶
      contextPct: cfg.contextPct,
      feather: cfg.feather,
      colorMatch: cfg.colorMatch,
      maxRes: cfg.maxRes,
      upscaleSmall: cfg.upscaleSmall,
      mosaic: cfg.mosaic,
      lang: cfg.lang,
      seed: cfg.seed,
      quality: cfg.quality,
      format: cfg.format,
      netMode: cfg.netMode,
      keepAlive: cfg.keepAlive,
      autoGrade: cfg.autoGrade,
      // 主题和背景不影响出图，但影响"看到的和导出的是否一致"，带上很便宜
      theme: cfg.theme,
      bgConfigured: !!(cfg.bg && cfg.bg.dataUrl)
    };

    // 日志：原样带上，但每条都把提示词压到 40 字（完整文本留在应用里）
    const logs = (S.callLog || []).map((e) => Object.assign({}, e, {
      prompt: e.prompt ? String(e.prompt).slice(0, 40) + '…' : '',
      // workId 是内部随机串，对排查没用，去掉减小体积
      workId: undefined
    }));

    return {
      // 说明这份文件是什么、怎么来的 —— 用户隔几天再看也能明白
      _readme: '枫叶修图诊断包：日志 + 环境 + 配置（API Key 与提示词已脱敏）',
      exportedAt: new Date().toISOString(),
      env,
      cfg: safeCfg,
      stats: C.callLogStats(S.callLog || []),
      logs
    };
  }

  /** 把密钥脱敏成 sk-****abcd（保留头尾，便于确认"是不是用错了那把 key"） */
  function maskSecret(k) {
    const s = String(k || '');
    if (!s) return '';
    if (s.length <= 8) return '****';
    return s.slice(0, 4) + '****' + s.slice(-4);
  }

  /** 导出诊断包（一份 JSON，含环境与脱敏配置） */
  async function exportDiagnostics() {
    const bundle = buildDiagnosticBundle();
    const text = JSON.stringify(bundle, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const name = C.timestampName('diagnostics', 'json');
    if (nativeSaveAvailable()) {
      const r = await nativeSave(blob, name, 'downloads');
      if (r.ok) { toast('诊断包已导出到 ' + r.path, 3600); return; }
      if (r.canceled) { toast('已取消'); return; }
      toast((r.error || '保存失败') + ' · 改用分享', 4000);
    }
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: '诊断包' }); toast('已分享'); return; }
      catch (e) { /* 取消则继续走下载 */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('已导出 ' + name, 3200);
  }

  /**
   * 导出日志（JSON 或文本）。
   *
   * 复用导出的原生保存路径（/api/save）：安卓壳里没有 <a download>，
   * 浏览器里走 Blob + 下载。这样两个环境都不用各写一套。
   */
  async function exportCallLog(kind) {
    const list = S.callLog || [];
    if (!list.length) { toast('还没有调用记录'); return; }
    const isJson = kind === 'json';
    const text = isJson
      ? C.callLogToJson(list, { now: Date.now(), version: APP_VERSION })
      : C.callLogToText(list, { now: Date.now(), version: APP_VERSION });
    const blob = new Blob([text], { type: isJson ? 'application/json' : 'text/plain' });
    const name = C.timestampName('calllog', isJson ? 'json' : 'txt');

    if (nativeSaveAvailable()) {
      // 日志属于「临时排查材料」，默认丢下载目录而不是相册
      const r = await nativeSave(blob, name, 'downloads');
      if (r.ok) { toast('已导出到 ' + r.path, 3600); return; }
      if (r.canceled) { toast('已取消导出'); return; }
      toast((r.error || '保存失败') + ' · 改用分享', 4000);
    }
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: '调用日志' }); toast('已分享'); return; }
      catch (e) { /* 用户取消则继续下载 */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('已导出 ' + name, 3200);
  }

  function syncSettingsUI() {
    fillProviderList();
    fillPresetList();
    updatePresetUI();
    syncVendorPresets();
    renderThemeChips();
    syncBgUI();
    updateCallLogBrief();
    renderQuickPromptSettings();   // 自定义快捷提示词列表
    $('set-provider').value = S.cfg.provider;
    $('set-baseurl').value = S.cfg.baseUrl;
    $('set-apikey').value = S.cfg.apiKey;
    $('set-model').value = S.cfg.model;
    $('set-netmode').value = S.cfg.netMode;
    $('set-ctx').value = S.cfg.contextPct;
    $('set-feather').value = S.cfg.feather;
    $('set-cm').value = S.cfg.colorMatch;
    // 无缝融合
    $('set-fusion').value = Math.round((S.cfg.fusion != null ? S.cfg.fusion : 0.7) * 100);
    $('set-fusionc').value = Math.round((S.cfg.fusionCenter != null ? S.cfg.fusionCenter : 0.35) * 100);
    $('set-fusiong').value = Math.round((S.cfg.fusionGrain != null ? S.cfg.fusionGrain : 0.6) * 100);
    $('set-envfit').checked = S.cfg.envFit !== false;
    $('set-autograde').checked = S.cfg.autoGrade !== false;
    $('set-autocheck').checked = S.cfg.autoCheckUpdate !== false;
    refreshUpdateStateText();
    $('set-maxres').value = String(S.cfg.maxRes);
    $('set-lang').value = S.cfg.lang;
    $('set-seed').value = S.cfg.seed;
    $('set-preset').value = S.cfg.exportPreset || 'full';
    $('set-format').value = S.cfg.format;
    $('set-quality').value = S.cfg.quality;
    $('set-mosaic').checked = !!S.cfg.mosaic;
    $('set-upscale').checked = S.cfg.upscaleSmall !== false;
    $('set-mem').value = S.cfg.historyBudgetMB || 192;
    $('set-autosave').checked = S.cfg.autoSaveSession !== false;
    // 后台保活
    S.keepAliveSupported = keepAliveSupported();
    const kaEl = $('set-keepalive');
    if (kaEl) {
      kaEl.checked = S.cfg.keepAlive !== false;
      kaEl.disabled = !S.keepAliveSupported;
    }
    const kaAlways = $('set-keepalive-always');
    if (kaAlways) {
      kaAlways.checked = S.cfg.keepAliveAlways === true;
      kaAlways.disabled = !S.keepAliveSupported;
    }
    // 浏览器里没有原生桥，直接说明「不适用」，避免用户以为坏了
    if (!S.keepAliveSupported) {
      const st = $('ka-state');
      if (st) { st.textContent = '当前环境不支持（仅在安卓 App 内有效）'; st.className = 'ka-state ka-muted'; }
      const row = $('ka-always-row');
      if (row) row.hidden = true;
      const kb = $('ka-battery');
      if (kb) kb.hidden = true;
      const kbRow = $('ka-battery-row');
      if (kbRow) kbRow.hidden = true;
    } else {
      updateKeepAliveUI();
    }
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
    $('v-fusion').textContent = Math.round((S.cfg.fusion != null ? S.cfg.fusion : 0.7) * 100) + '%';
    $('v-fusionc').textContent = Math.round((S.cfg.fusionCenter != null ? S.cfg.fusionCenter : 0.35) * 100) + '%';
    $('v-fusiong').textContent = Math.round((S.cfg.fusionGrain != null ? S.cfg.fusionGrain : 0.6) * 100) + '%';
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

  /* ============ 多组供应商配置（设置页第一张卡片） ============ */

  /**
   * 把预设列表画进下拉框，并标出「当前连接是否属于某一组」。
   *
   * 关键点：当前连接可能是**手动改出来的**（比如临时换了个 Key），
   * 这时它不属于任何一组。必须有一个「未保存」的选项，否则下拉框
   * 会停在某一组上，让用户误以为「我现在的配置就是这组」——
   * 而他真正在用的 Key 已经和这组不一样了。
   */
  function syncVendorPresets() {
    const sel = $('set-preset-select');
    if (!sel) return;
    const list = S.cfg.presets || [];
    const active = C.findActivePreset(list, S.cfg);
    sel.innerHTML = '';
    if (!list.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '（还没有保存过配置）';
      sel.appendChild(o);
      sel.disabled = true;
    } else {
      sel.disabled = false;
      if (!active) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = '当前连接（未保存）';
        sel.appendChild(o);
      }
      for (const p of list) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.name;
        sel.appendChild(o);
      }
      sel.value = active ? active.id : '';
    }
    // 没有「这一组」时，重命名/删除没有对象可操作
    const has = !!active;
    if ($('btn-preset-rename')) $('btn-preset-rename').disabled = !has;
    if ($('btn-preset-delete')) $('btn-preset-delete').disabled = !has;
    if ($('btn-preset-save')) $('btn-preset-save').disabled = false;
    updateVendorStatus(active);
  }

  function updateVendorStatus(active) {
    const el = $('preset-status');
    if (!el) return;
    const list = S.cfg.presets || [];
    el.className = 'status';
    if (!list.length) {
      el.textContent = '把当前这套 API 存下来，以后一键切换。';
      return;
    }
    if (!active) {
      el.textContent = '当前连接不属于任何一组（下面的地址/Key 被手改过）。'
        + '想保留就点「保存当前配置」。';
      return;
    }
    const dots = [];
    dots.push(active.apiKey ? ('Key 已填（尾号 ' + String(active.apiKey).slice(-4) + '）') : '没填 Key');
    dots.push(active.model ? ('模型 ' + active.model.split('/').pop()) : '没选模型');
    el.className = 'status ok';
    el.textContent = '正在使用「' + active.name + '」· ' + dots.join(' · ')
      + '（共 ' + list.length + ' 组）';
  }

  /** 切换当前使用的配置组 */
  function useVendorPreset(id) {
    const list = S.cfg.presets || [];
    const p = list.find((x) => x.id === id);
    if (!p) return;
    C.applyPreset(S.cfg, p);
    saveCfg();
    syncSettingsUI();
    fillModelList();
    updateProviderTip();
    updatePriceTip();
    if (S.img) { snapRectToModel(); rebuildViewCanvas(); draw(); }
    updateUI();
    toast('已切换到「' + p.name + '」', 2200);
  }

  /** 保存当前连接为一组配置（内容与已有组相同则覆盖那一组） */
  function saveVendorPreset() {
    if (!S.cfg.baseUrl && !S.cfg.apiKey && !S.cfg.model) {
      toast('当前还没有可保存的连接信息，先填接口地址和 Key', 3000);
      return;
    }
    const r = C.planSavePreset(S.cfg.presets || [], S.cfg, '');
    if (r.full) {
      toast('最多只能存 ' + C.PRESET_MAX + ' 组，先删掉一组再存', 3200);
      return;
    }
    S.cfg.presets = r.presets;
    saveCfg();
    syncVendorPresets();
    toast(r.created ? ('已保存为「' + r.preset.name + '」') : ('已更新「' + r.preset.name + '」'), 2400);
  }

  /** 重命名当前这一组 */
  function renameVendorPreset() {
    const active = C.findActivePreset(S.cfg.presets || [], S.cfg);
    if (!active) { toast('当前连接还没保存成一组，先点「保存当前配置」', 2800); return; }
    const name = window.prompt('给这组配置起个名字（比如「主力号」「OpenAI 备用」）', active.name);
    if (name === null) return;
    S.cfg.presets = C.planRenamePreset(S.cfg.presets, active.id, name);
    saveCfg();
    syncVendorPresets();
    toast('已重命名', 1800);
  }

  /** 删除当前这一组（只删这条记录，不影响正在用的连接） */
  function deleteVendorPreset() {
    const active = C.findActivePreset(S.cfg.presets || [], S.cfg);
    if (!active) { toast('当前没有选中任何一组', 2000); return; }
    if (!window.confirm('删除配置「' + active.name + '」？\n\n'
      + '只删除这条保存记录，当前正在用的接口地址和 Key 不会变。')) return;
    S.cfg.presets = C.planDeletePreset(S.cfg.presets, S.cfg, active.id);
    saveCfg();
    syncVendorPresets();
    toast('已删除「' + active.name + '」', 2000);
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
      ? '当前是本地文件方式打开，浏览器直连即可（若接口不开放跨域，请用「启动枫叶修图」脚本以本地服务方式打开）。'
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
      (lastStrokeNote ? '引导线：' + lastStrokeNote : '引导线：无'),
      (lastRefNote || '参考图：无'),
      '请求字段：' + r.keys.join(', ')
    ];
    if (!r.hasImage && r.model) {
      lines.push('');
      lines.push('提示：当前请求没有带上参考图。');
      lines.push('要改一块区域，请换用图像编辑模型（如 Qwen/Qwen-Image-Edit、FLUX.1-Kontext、gpt-image-1）。');
      // 用户画了引导线却没带图，是他最容易困惑的情况：
      // 屏幕上明明有线，模型却完全不知道 —— 因为文生图模式下整张图都不发。
      if (lastStrokeNote) {
        lines.push('你画的引导线也没能发出去（引导线是画在参考图上的，没有图就没有线）。');
      }
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

  /**
   * 工具栏手柄：轻点收起/展开，上下拖动自由调节高度。
   *
   * 为什么用「拖动」而不是给几个档位：
   *   每台手机屏幕高度不同、每个人想要的露出量也不同 ——
   *   有人只要一个生成按钮，有人要工具行 + 参数条。
   *   给一个连续可调的高度，比猜几个档位更省事。
   *
   * 轻点与拖动要能共存：按下后移动超过阈值才算拖动，
   * 否则抬起时当作「轻点」切换收起/展开。
   */
  function bindBarHandle() {
    const handle = $('bar-handle');
    if (!handle) return;
    let drag = null;

    const pointY = (ev) => (ev.touches && ev.touches[0] ? ev.touches[0].clientY : ev.clientY);

    const down = (ev) => {
      const full = barFullHeight();
      drag = {
        y0: pointY(ev),
        h0: S.toolbarHeight || full,
        full,
        moved: false,
        id: ev.pointerId != null ? ev.pointerId : null
      };
      if (handle.setPointerCapture && drag.id != null) {
        try { handle.setPointerCapture(drag.id); } catch (e) { /* 老内核没有 */ }
      }
      handle.classList.add('dragging');
    };

    const move = (ev) => {
      if (!drag) return;
      // 手指向上拖 → 工具栏变高（露出更多）；向下拖 → 变矮
      const dy = drag.y0 - pointY(ev);
      if (!drag.moved && Math.abs(dy) > 6) drag.moved = true;
      if (!drag.moved) return;
      if (ev.cancelable) ev.preventDefault();
      applyBarHeight(drag.h0 + dy, false);
    };

    const up = () => {
      if (!drag) return;
      const wasDrag = drag.moved;
      const h = S.toolbarHeight;
      const full = drag.full || barFullHeight();
      drag = null;
      handle.classList.remove('dragging');
      if (!wasDrag) {
        // 轻点：收起 ⇄ 展开（离散动作，保留两档）
        //
        // 注意这里 **save=false**：轻点是「现在想多看一点照片」的临时动作，
        // 不该覆盖用户用拖动调出来的偏好高度。
        // 若在这里存下 40px，用户轻点收起一次之后，**以后每张照片都从收起态打开** ——
        // 他以为自己只是临时收了一下，结果成了永久设置。
        if (C.isBarCollapsed(h, full)) expandToolbar(undefined, false);
        else collapseToolbar(undefined, false);
      } else {
        // 拖动结束：**停在松手的位置**，不再吸附到两档。
        // 旧实现在这里把高度吸附到「收起」或「展开」，于是拖动有档位感：
        // 想露出「工具行 + 画笔参数」这种组合，一松手就被弹到别的高度。
        // 现在按无极处理 —— 想到哪里就到哪里，松手即定，并且记住这个高度。
        applyBarHeight(h, { animate: false, collapsed: C.isBarCollapsed(h, full), save: true });
      }
      draw();
    };

    handle.addEventListener('pointerdown', down);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    // 老内核没有 Pointer Events 时退化到 touch/mouse
    if (!window.PointerEvent) {
      handle.addEventListener('touchstart', down, { passive: true });
      handle.addEventListener('touchmove', move, { passive: false });
      handle.addEventListener('touchend', up);
      handle.addEventListener('mousedown', down);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }
    // 点箭头按钮也算轻点（手柄区域较大，手指不一定正好点中）
    const tg = $('bar-toggle');
    if (tg) {
      tg.addEventListener('click', (e) => {
        e.stopPropagation();
        const full = barFullHeight();
        // 同「轻点手柄」：save=false —— 这是临时收起/展开，不覆盖拖动调出来的偏好高度
        if (C.isBarCollapsed(S.toolbarHeight, full)) expandToolbar(undefined, false);
        else collapseToolbar(undefined, false);
        draw();
      });
    }
  }

  /* ---------- 事件绑定 ---------- */

  function bind() {
    // 全部滑块改成「只能拖滑块头」——必须在任何滑块逻辑之前完成，
    // 否则第一批 pointerdown 会按老行为跳值
    applyThumbOnlySliders();

    // 顶栏
    $('btn-open').onclick = () => $('file-input').click();
    $('btn-pick').onclick = () => $('file-input').click();
    $('btn-home-pick').onclick = () => $('file-input').click();
    $('btn-demo').onclick = useDemoImage;

    // ---- 文生图 ----
    // ---- 画布背景 ----
    $('btn-bg-pick').onclick = () => { $('bg-input').click(); };
    $('bg-input').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) await loadBgImage(f);
      try { e.target.value = ''; } catch (e2) { /* ignore */ }
    });
    $('btn-bg-clear').onclick = clearBg;
    $('set-bg-blur').addEventListener('input', (e) => {
      const n = C.normalizeBg(S.cfg.bg);
      n.blur = Number(e.target.value) || 0;
      S.cfg.bg = n;
      if ($('bg-blur-val')) $('bg-blur-val').textContent = String(Math.round(n.blur));
      draw();                    // 拖动中即时预览，不写配置（松手再存）
    });
    $('set-bg-blur').addEventListener('change', () => {
      saveCfg(); syncBgUI();
    });
    $('set-bg-dim').addEventListener('input', (e) => {
      const n = C.normalizeBg(S.cfg.bg);
      n.dim = Number(e.target.value) || 0;
      S.cfg.bg = n;
      if ($('bg-dim-val')) $('bg-dim-val').textContent = String(Math.round(n.dim));
      draw();
    });
    $('set-bg-dim').addEventListener('change', () => {
      saveCfg(); syncBgUI();
    });
    // 滑块也只能拖滑块头（和设置页其它滑块一致）
    if ($('set-bg-blur')) applyThumbOnlySliders(document.querySelector('#set-bg-blur').parentNode);
    if ($('set-bg-dim')) applyThumbOnlySliders(document.querySelector('#set-bg-dim').parentNode);

    // ---- 参考图 ----
    $('btn-add-ref').onclick = () => { $('ref-input').click(); };
    $('ref-input').addEventListener('change', async (e) => {
      const files = e.target.files;
      if (files && files.length) await addRefImages(files);
      // 清掉选择，否则再选同一张图不会触发 change
      try { e.target.value = ''; } catch (e2) { /* ignore */ }
    });

    $('btn-home-t2i').onclick = openT2i;
    $('btn-empty-t2i').onclick = openT2i;
    document.querySelectorAll('#t2i [data-close]').forEach((el) => { el.onclick = closeT2i; });
    $('t2i-go').onclick = runT2i;
    $('t2i-prompt').addEventListener('input', () => {
      t2i.prompt = $('t2i-prompt').value;
      syncT2iUI();
    });
    $('t2i-negative').addEventListener('input', () => {
      t2i.negative = $('t2i-negative').value;
    });
    const IDEAS = {
      't2i-idea-1': '黄昏的江南水乡，石桥下停着一只小船，远处青瓦白墙，暖色逆光，35mm 镜头，浅景深',
      't2i-idea-2': '窗边侧光的年轻女性肖像，米色毛衣，背景虚化的绿植，柔和自然光，85mm 人像镜头',
      't2i-idea-3': '木桌上的手冲咖啡与翻开的旧书，晨光斜射，浅色木纹，温馨安静，微距质感',
      't2i-idea-4': '雨后的现代美术馆外观，玻璃幕墙上挂着水珠，阴天柔光，对称构图，广角'
    };
    for (const id of Object.keys(IDEAS)) {
      const b = $(id);
      if (b) b.onclick = () => {
        if ($('t2i-prompt')) {
          $('t2i-prompt').value = IDEAS[id];
          t2i.prompt = IDEAS[id];
          syncT2iUI();
        }
      };
    }
    $('btn-more').onclick = (e) => { e.stopPropagation(); toggleMoreMenu(); };
    $('btn-settings').onclick = () => { closeMoreMenu(); openSettings(); };

    // ---- 主动保存 ----
    // 点完**不关菜单**：用户要看到「已保存」的反馈和保存时间，
    // 菜单一关反馈就没了，他会不确定到底存没存。
    if ($('btn-save-now')) $('btn-save-now').onclick = () => { forceSaveNow(); syncSaveNowUI(); };

    // ---- 设置分级：一级入口 / 二级页返回 ----
    document.querySelectorAll('#settings [data-stopen]').forEach((el) => {
      el.onclick = () => showSettingsPage(el.dataset.stopen);
    });
    document.querySelectorAll('#settings [data-stback]').forEach((el) => {
      el.onclick = () => showSettingsPage('home');
    });
    $('btn-save').onclick = openExportPanel;
    $('btn-photoinfo').onclick = () => { closeMoreMenu(); openPhotoInfo(); };
    document.querySelectorAll('#photoinfo [data-close]').forEach((el) => { el.onclick = closePhotoInfo; });
    document.querySelectorAll('#exportpanel [data-close]').forEach((el) => { el.onclick = closeExportPanel; });
    $('exp-do').onclick = async () => {
      const btn = $('exp-do');
      btn.disabled = true;
      try {
        // 记住这套选择（下次打开面板还是它），但不改设置页的预设
        S.cfg.expFormat = expFormat;
        S.cfg.expMaxSide = expMaxSide;
        S.cfg.expQuality = expQuality;
        S.cfg.expKeepExif = $('exp-exif').checked;
        S.cfg.expKeepGps = $('exp-gps').checked;
        S.cfg.expKeepIcc = $('exp-icc').checked;
        S.cfg.expPresetChosen = true;    // 之后打开面板就按这套来
        saveCfg();
        closeExportPanel();
        await exportImage(currentExportPreset());
      } finally {
        btn.disabled = false;
      }
    };
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
      // 引导线与调色都有自己的处理（见下）：它们进入模式时要准备额外的界面
      if (b.id === 'btn-guide' || b.id === 'btn-grade') return;
      b.onclick = () => {
        S.mode = b.dataset.mode;
        if (S.mode !== 'brush') { S.strokes = []; invalidateMask(); }
        // 换工具 = 重新判断「这个工具的提示要不要显示」，
        // 否则上一次的缓存会让新工具的提示永远不出现
        resetTipDecision();
        updateUI(); draw();
      };
    });
    // 工具栏：轻点手柄收起/展开；上下拖动自由调节高度
    bindBarHandle();
    $('btn-guide').onclick = () => {
      // 引导线按钮不走通用逻辑：它要保证进入模式后类型选择器是渲染好的
      S.mode = 'guide';
      S.strokes = []; invalidateMask();
      resetTipDecision();
      renderGuideKinds();
      // 没有框选也能画：默认对整张图（见 effectiveRect）
      if (!S.rect) toast('没框选就按整张图来 —— 在照片上拖一条线，告诉模型位置');
      else toast('在选区内拖一条线，告诉模型位置');
      updateUI(); draw();
    };
    // 调色工具：没有框选也能进（整张图调色，见 effectiveRect）
    $('btn-grade').onclick = () => openGradeTool();
    $('grade-reset').onclick = resetGradeDraft;
    $('grade-apply').onclick = applyGrade;
    $('guide-clear').onclick = clearGuides;
    renderGuideKinds();
    $('btn-layers').onclick = openLayers;
    document.querySelectorAll('#layers [data-close]').forEach((el) => { el.onclick = closeLayers; });
    $('btn-history').onclick = openHistory;
    document.querySelectorAll('#history [data-close]').forEach((el) => { el.onclick = closeHistory; });
    $('hist-preview-off').onclick = () => cancelHistoryPreview();
    $('hist-jump').onclick = commitHistoryJump;
    $('btn-library').onclick = () => { closeMoreMenu(); openLibrary(); };
    document.querySelectorAll('#library [data-close]').forEach((el) => { el.onclick = closeLibrary; });
    $('btn-fit').onclick = fitToScreen;
    $('btn-reset-sel').onclick = () => {
      if (!S.docCanvas) return;
      const m = 0.08;
      S.rect = C.clampRect({ x: S.docW * m, y: S.docH * m, w: S.docW * (1 - 2 * m), h: S.docH * (1 - 2 * m) }, S.docW, S.docH);
      S.strokes = []; invalidateMask();
      S.guides = []; updateGuideBadge();
      snapRectToModel(); draw(); updateUI();
    };

    // 点菜单外任意位置关闭。用捕获阶段：菜单项自己的 onclick 里已经关过菜单，
    // 这里只负责「点在别处」的情况，避免菜单一直浮在画布上。
    document.addEventListener('click', (e) => {
      if (!moreMenuOpen()) return;
      const m = $('moremenu'), b = $('btn-more');
      if (m && m.contains(e.target)) return;
      if (b && b.contains(e.target)) return;
      closeMoreMenu();
    }, true);

    // 缩放：± 按钮已移除（双指缩放更好用，且左下角小按钮容易误触）。
    // 这里做判空而不是直接删行 —— 万一以后又加回来，不至于忘接线；
    // 也避免 $('zoom-in') 返回 null 时抛 TypeError 打断整个 bind()，
    // 那会导致后面所有按钮全部失效，症状是「应用好像没反应」。
    if ($('zoom-in')) $('zoom-in').onclick = () => zoomCenter(1.35);
    if ($('zoom-out')) $('zoom-out').onclick = () => zoomCenter(1 / 1.35);
    $('zoom-label').onclick = fitToScreen;

    // 画笔
    const bs = $('brush-size');
    bs.oninput = () => { S.brushSize = Number(bs.value); $('brush-size-val').textContent = bs.value; };
    // 智能框选：容差滑块 + 重新框
    if ($('auto-tol')) {
      $('auto-tol').value = String(C.AUTO_SELECT_TOLERANCE);
      if ($('auto-tol-val')) $('auto-tol-val').textContent = String(C.AUTO_SELECT_TOLERANCE);
      $('auto-tol').oninput = () => {
        if ($('auto-tol-val')) $('auto-tol-val').textContent = $('auto-tol').value;
      };
    }
    if ($('auto-again')) {
      $('auto-again').onclick = () => {
        // 清掉当前选区，让用户重新点
        S.rect = null; S.strokes = []; S.guides = [];
        invalidateMask(); updateGuideBadge(); updateUI(); draw();
        toast('在物体上点一下', 2000);
      };
    }

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

    // 快捷指令（用户自定义的排前面，内置的接在后面）
    renderQuickChips();

    // 自定义快捷提示词：设置页里加 / 删
    if ($('qp-add')) {
      $('qp-add').onclick = () => {
        const inp = $('qp-input');
        if (addQuickPrompt(inp.value)) { inp.value = ''; inp.focus(); }
      };
    }
    if ($('qp-input')) {
      $('qp-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if ($('qp-add')) $('qp-add').onclick(); }
      });
    }

    $('btn-model').onclick = openSettings;
    $('btn-generate').onclick = generate;
    // 取消按钮只取消当前这张照片的任务（其它照片的后台任务照常跑）
    $('btn-cancel').onclick = () => { cancelJobsForCurrentDoc('取消按钮'); setBusy(false); };

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
      // 换服务商等于换了整套连接：原来那组配置已经不匹配了，标记要清掉，
      // 否则卡片仍显示「正在使用「OpenAI」」而实际连接已经是硅基流动。
      delete S.cfg.activePreset;
      saveCfg(); syncSettingsUI();
      if (S.img) { rebuildViewCanvas(); draw(); }
      updateUI();
    });
    bindField('set-baseurl', 'baseUrl', (el) => el.value.trim(), syncVendorPresets);
    bindField('set-apikey', 'apiKey', (el) => el.value.trim(), syncVendorPresets);
    bindField('set-model', 'model', null, () => {
      if (S.img && S.rect) { snapRectToModel(); draw(); }
      fillModelList(); updateProviderTip(); updatePriceTip();
      // 换了模型就等于连接信息变了 —— 可能已经不再属于原来那一组，
      // 卡片上的「正在使用某组」必须跟着变，否则会误导用户。
      syncVendorPresets();
      // 不同模型能收的参考图张数不同，换了模型要立刻重算提示
      renderRefImages();
    });
    bindField('set-netmode', 'netMode', null, updateProviderTip);
    bindField('set-ctx', 'contextPct', (el) => Number(el.value));
    bindField('set-feather', 'feather', (el) => Number(el.value));
    bindField('set-cm', 'colorMatch', (el) => Number(el.value));
    // 无缝融合：改了要重绘（纯像素运算，不重新调用模型）
    bindField('set-fusion', 'fusion', (el) => Number(el.value) / 100, () => {
      seamCache.clear();      // 参数变了，评分缓存要失效
      if (S.edits.length) { rebuildViewCanvas(); draw(); }
      renderLayers();
    });
    bindField('set-fusionc', 'fusionCenter', (el) => Number(el.value) / 100, () => {
      seamCache.clear();
      if (S.edits.length) { rebuildViewCanvas(); draw(); }
      renderLayers();
    });
    bindField('set-fusiong', 'fusionGrain', (el) => Number(el.value) / 100, () => {
      seamCache.clear();
      if (S.edits.length) { rebuildViewCanvas(); draw(); }
      renderLayers();
    });
    // 环境契合提示词：只影响下一次请求，不需要重绘
    bindField('set-envfit', 'envFit', (el) => el.checked);
    // 贴回后自动打开调色：纯界面偏好，不影响画面
    bindField('set-autograde', 'autoGrade', (el) => el.checked);
    // 检查更新
    bindField('set-autocheck', 'autoCheckUpdate', (el) => el.checked);
    const cu = $('btn-checkupdate');
    if (cu) cu.onclick = () => {
      refreshUpdateStateText('检查中…');
      checkUpdate(true).then(() => refreshUpdateStateText());
    };
    bindField('set-lang', 'lang');
    bindField('set-seed', 'seed');
    bindField('set-preset', 'exportPreset', null, updatePresetUI);
    bindField('set-format', 'format');
    bindField('set-quality', 'quality', (el) => Number(el.value));
    bindField('set-mosaic', 'mosaic', (el) => el.checked);
    bindField('set-upscale', 'upscaleSmall', (el) => el.checked, () => { if (S.img && S.rect) updateUI(); });
    bindField('set-mem', 'historyBudgetMB', (el) => Number(el.value), () => { enforceHistoryBudget(); });
    bindField('set-autosave', 'autoSaveSession', (el) => el.checked);

    // 后台保活
    bindField('set-keepalive', 'keepAlive', (el) => el.checked, () => {
      // 关掉总开关时顺便把常驻也关掉，避免留下一条点不动的常驻通知。
      // bindField 已经存过配置了，这里改完再存一次即可。
      if (S.cfg.keepAlive === false && S.cfg.keepAliveAlways) {
        S.cfg.keepAliveAlways = false;
        const el2 = $('set-keepalive-always');
        if (el2) el2.checked = false;
        saveCfg();
      }
      syncKeepAlive();
    });
    bindField('set-keepalive-always', 'keepAliveAlways', (el) => el.checked, () => {
      // 开常驻时顺带申请通知权限，否则 Android 13+ 上通知不显示，用户会以为没生效
      if (S.cfg.keepAliveAlways) askNotificationPermission();
      syncKeepAlive();
    });
    $('ka-battery').onclick = askIgnoreBattery;
    // 「去打开通知设置」：直接跳到系统里本应用的通知页。
    // 不这么做的话，用户得自己翻 设置 → 应用 → 通知，很多人找不到。
    if ($('btn-notify-settings')) {
      $('btn-notify-settings').onclick = () => {
        const b = bridge();
        if (b && b.openNotificationSettings) {
          try { b.openNotificationSettings(); } catch (e) { /* ignore */ }
        } else {
          toast('请到「系统设置 → 应用 → 枫叶修图 → 通知」里打开', 4200);
        }
      };
    }
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

    // ---- 供应商配置（多组）----
    $('set-preset-select').addEventListener('change', (e) => {
      const id = e.target.value;
      if (!id) return;            // 「未保存」那项只是状态展示，不触发切换
      useVendorPreset(id);
    });
    $('btn-preset-save').onclick = saveVendorPreset;
    $('btn-preset-rename').onclick = renameVendorPreset;
    $('btn-preset-delete').onclick = deleteVendorPreset;

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

    // 新手教程：两处入口（更多菜单 + 设置页的「帮助」），行为一致。
    // 手动重看时**不**改「已看过」标记 —— 标记只在自动弹的那次写，
    // 否则「看过又重看」会反复写 localStorage，没必要。
    const tutBtn = $('btn-tutorial');
    if (tutBtn) tutBtn.onclick = () => { closeMoreMenu(); openTutorial(false); };
    const tutBtn2 = $('btn-tutorial2');
    if (tutBtn2) tutBtn2.onclick = () => { closeSettings(); openTutorial(false); };
    const tutNext = $('tut-next');
    if (tutNext) tutNext.onclick = tutorialNext;
    const tutPrev = $('tut-prev');
    if (tutPrev) tutPrev.onclick = tutorialPrev;
    const tutSkip = $('tut-skip');
    // 跳过 = 关闭并记「已看过」（跳过就是明确的「我不需要」，下次不该再弹）
    if (tutSkip) tutSkip.onclick = () => { markTutorialSeen(); closeTutorial(); };
    // 点蒙层也算跳过（手机上「点空白处关掉」是最自然的手势）
    const tutMask = document.querySelector('#tutorial .tut-mask');
    if (tutMask) tutMask.onclick = () => { markTutorialSeen(); closeTutorial(); };
    // 窗口尺寸变了要重摆高亮圈（横竖屏切换、软键盘弹出）
    window.addEventListener('resize', () => { if (tutorialOpen()) renderTutorial(); });

    // 调用日志：从设置页进入（设置页先关掉，否则日志面板会压在它上面）
    const clBtn = $('btn-calllog');
    if (clBtn) clBtn.onclick = () => { closeSettings(); openCallLog(); };
    document.querySelectorAll('#calllog [data-close]').forEach((el) => { el.onclick = closeCallLog; });
    const clJson = $('calllog-export-json');
    if (clJson) clJson.onclick = () => exportCallLog('json');
    const clText = $('calllog-export-text');
    if (clText) clText.onclick = () => exportCallLog('text');
    const clDiag = $('calllog-export-diag');
    if (clDiag) clDiag.onclick = () => exportDiagnostics();
    const clClear = $('calllog-clear');
    if (clClear) clClear.onclick = () => {
      if (!confirm('清空所有调用日志？这只影响日志记录，不影响作品库和设置。')) return;
      S.callLog = [];
      try { localStorage.removeItem(LS_KEY_CALLLOG); } catch (e) { /* ignore */ }
      renderCallLog();
      updateCallLogBrief();
      toast('已清空调用日志');
    };

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

  /** 最后一次真正写进存档的会话内容（测试用；也便于排查「存档里到底是什么」） */
  let lastSavedSession = null;

  /**
   * 打包缓存：只缓存「贵的那部分」，便宜的字段每次都现读。
   *
   * buildSessionPayload 的开销几乎全在两处编码：整张画布的 JPEG，
   * 以及每个 patch 的 JPEG（3000×2000 上量到几百毫秒）。
   * 而「会话保存」和「作品库保存」都要用它 —— 一次编辑各建一遍，手机上会明显卡顿。
   *
   * 这里只缓存 base 和已编码的 patches，用 S.docRev 判断失效；
   * rect / strokes / 文件名体积可忽略，每次现读，所以不存在过期风险。
   */
  let payloadCache = null;

  /** 丢掉打包缓存（文档或编辑变了就调一次） */
  function invalidatePayloadCache() { payloadCache = null; }

  /**
   * 防抖保存：编辑后延迟保存，避免频繁写 localStorage 卡顿。
   * 存的是「编辑记录 + 原图」，这样进程被杀后能继续之前的工作。
   */
  function scheduleSessionSave() {
    if (S.cfg.autoSaveSession === false) return;
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = setTimeout(saveSession, 1200);
  }

  /**
   * 把当前编辑状态打包成可恢复的会话数据。
   *
   * 抽出来给两处共用：
   *   - saveSession()：存「当前未完成的编辑」，进程被杀后可恢复
   *   - touchWork()：存进作品库，让历史记录可以「继续编辑」
   * 两边用同一个结构，恢复时就能复用同一套 restoreSession。
   */
  /**
   * 会话里那张「底图」的编码。
   *
   * 为什么要单独拿出来并缩放：底图是**整张工作图**的 JPEG dataURL，
   * 也是单条作品记录体积的大头（3072px 的图约 1.1MB，UTF-16 计费后近 3MB）——
   * 一条就能吃满整个作品库预算，于是「修第二张时第一张被清理」，
   * 用户看到的就是「历史记录只存得下一张」。
   *
   * 缩到 SESSION_BASE_MAX_SIDE（2048）后体积减半，而会话只是「接着改」的
   * 中间态 —— 真出片走导出，导出会按原图重新合成，不受这里影响。
   *
   * 返回 dataURL；失败时回落到不缩放（宁可大一点，也不能存不了）。
   */
  function encodeSessionBase(canvas) {
    if (!canvas) return null;
    // 文件存储下不缺空间 → 会话底图**不缩放**，等于把工作分辨率原样存下来。
    // 这样「继续编辑」恢复出来的底图和你离开时一模一样，不会因为存档降质。
    // localStorage 兜底时才压到 2048（那边一张就 0.8MB，压不住放不下几张）。
    const maxSide = kvStorageAvailable() ? 100000 : C.SESSION_BASE_MAX_SIDE;
    const plan = C.planSessionBase({ w: canvas.width, h: canvas.height, maxSide });
    if (!plan.scaled) {
      return canvas.toDataURL('image/jpeg', C.SESSION_BASE_QUALITY);
    }
    const small = makeCanvas(plan.w, plan.h);
    const sx = small.getContext('2d', { willReadFrequently: true });
    sx.imageSmoothingEnabled = true;
    sx.imageSmoothingQuality = 'high';
    sx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, plan.w, plan.h);
    return small.toDataURL('image/jpeg', C.SESSION_BASE_QUALITY);
  }

  function buildSessionPayload() {
    if (!S.docCanvas || !S.viewCanvas) return null;
    try {
      let baseUrl, plan;
      if (payloadCache && payloadCache.rev === S.docRev) {
        baseUrl = payloadCache.base;
        plan = payloadCache.plan;
      } else {
        baseUrl = encodeSessionBase(S.docCanvas);
        // patch 总量上限：按存储通道分开。
        //
        // 以前这里写死 localStorage 的预算（256K 字符）。但安卓壳走的是文件存储
        // （240MB），沿用 256K 会让一张 1024×1024 的生成块（实测约 36 万字符）
        // **单条就超预算**，整条会话一个图层都存不下 —— 用户点「继续编辑」
        // 看到原图，记录却还标着「可继续编辑」。
        // 这就是「明明保存了，进去还是初始状态」的直接原因。
        const patchBudget = kvStorageAvailable()
          ? C.SESSION_PATCH_MAX_CHARS_FILE
          : C.SESSION_PATCH_MAX_CHARS;
        plan = C.planSessionPersist(S.edits, {
          // 作品库里要放好几条会话，单条吃太多会把别的挤没。
          // 超出的部分只影响「最老的几次编辑能不能继续调」，最近的操作永远保住。
          maxBytes: patchBudget,
          encode: (patch) => patch.toDataURL('image/jpeg', 0.82)
        });
        payloadCache = { rev: S.docRev, base: baseUrl, plan };
      }
      // 一个图层都没打包进去 = 这次存档等于没有。
      // 返回 null 让调用方走「没有可存内容」的分支，
      // 而不是把一个空壳存进作品库、再标上「可继续编辑」骗用户。
      if (plan.empty) {
        console.warn('[枫叶修图] 编辑数据超过存档上限，本次没有可保存的内容');
        return null;
      }
      // 以下字段每次都现读：体积小，且可能在两次打包之间变化
      return {
        v: 1,
        at: Date.now(),
        fileName: ($('file-name').textContent || 'photo.jpg').replace(/（已恢复）$/, ''),
        base: baseUrl,
        imgW: S.imgW, imgH: S.imgH,
        docW: S.docW, docH: S.docH,
        rect: S.rect,
        strokes: S.strokes,
        guides: S.guides,          // 引导线也是用户的手工成果，不能丢
        guideKind: S.guideKind,    // 上次选的引导线类型
        dropped: plan.dropped,
        items: plan.items.map((it) => Object.assign({}, it, {
          mask: it.mask ? C.packMask(new Float32Array(it.mask)) : null,
          maskLen: it.mask ? it.mask.length : 0
        }))
      };
    } catch (e) {
      return null;
    }
  }

  async function saveSession() {
    if (!S.img || !S.viewCanvas) return;
    try {
      const payload = buildSessionPayload();
      if (!payload) return;
      localStorage.setItem(LS_KEY_SESSION, JSON.stringify(payload));
      // 记下最后一次**真正写进去**的内容。
      // 测试要断言「存档里有什么」，而防抖写入是异步的（1200ms），
      // 直接读 localStorage 会和别的用例抢时序；读这里就没有竞争。
      lastSavedSession = payload;
    } catch (e) {
      // 空间不足：清掉会话，避免影响正常使用
      try { localStorage.removeItem(LS_KEY_SESSION); } catch (e2) { /* ignore */ }
      console.warn('[枫叶修图] 会话保存失败（可能空间不足）', e);
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
      // 换掉整份文档前，只作废**当前这张**的在途任务 ——
      // 「继续编辑」是从作品库进入的，此时可能正好有一次生成在跑，
      // 那一次的结果已经无处可落（文档被换掉了）。
      // 但别的照片的后台任务必须继续跑：它们自带归属信息，
      // 结果会落进各自的记录里，不会被贴到这张刚恢复的照片上。
      cancelJobsForCurrentDoc('恢复作品');
      S.genToken++;
      S.pending = null;
      const cmpEl2 = $('compare');
      if (cmpEl2) cmpEl2.hidden = true;

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
      let failedPatches = 0;   // 有几处 patch 没能恢复（要在提示里说清楚）
      for (const it of (j.items || [])) {
        // 调色图层：没有 patch，参数直接就能还原（不需要解码图片）
        if (it.grade && !it.patch) {
          S.edits.push({
            rect: it.rect,
            patch: null,
            grade: C.normalizeGrade(it.grade),
            feather: it.feather,
            colorMatch: 0,
            mask: it.mask ? C.unpackMask(it.mask, it.maskLen) : null,
            opacity: 1,
            enabled: true,
            label: C.describeGrade(it.grade).slice(0, 24),
            createdAt: Date.now()
          });
          continue;
        }
        if (!it.patch) continue;
        // 单张 patch 解码失败**不能中断整次恢复**。
        //
        // 这里原来没有 try/catch：任何一张 patch 加载失败（dataURL 被截断、
        // 内存不足、格式坏掉），异常会一路抛到外层 catch，
        // 结果 S.edits 停在「恢复了一半」的状态，用户看到的就是
        // 「记录还在，点进去变回原图」—— 而且报错信息只有一句
        // 「恢复会话失败」，完全指不到是哪张图的问题。
        //
        // 现在：失败的跳过并计数，其余照常恢复，最后如实告诉用户
        // 「有几处没能恢复」，而不是让他面对一张莫名其妙的原图。
        try {
          const patch = await new Promise((res, rej) => {
            const im = new Image();
            im.onload = () => res(im);
            im.onerror = () => rej(new Error('patch 解码失败'));
            im.src = it.patch;
          });
          if (!patch || !patch.width || !patch.height) throw new Error('patch 尺寸非法');
          const pc = makeCanvas(patch.width, patch.height);
          pc.getContext('2d').drawImage(patch, 0, 0);
          S.edits.push({
            rect: it.rect,
            patch: pc,
            feather: it.feather,
            colorMatch: it.colorMatch,
            mask: it.mask ? C.unpackMask(it.mask, it.maskLen) : null
          });
        } catch (e2) {
          failedPatches++;
          console.warn('[枫叶修图] 有一处修改没能恢复', e2);
        }
      }
      S.redo = [];
      S.docVersion++;              // 文档整体换掉了，旧的在途结果一律作废
      S.docRev++;                  // 打包缓存失效
      S.rect = j.rect || null;
      S.strokes = j.strokes || [];
      // 旧版本存档里没有 guides 字段 → 退化成空数组，不影响恢复
      S.guides = Array.isArray(j.guides) ? j.guides.map(C.normalizeGuide) : [];
      S.guideKind = C.getGuideKind(j.guideKind).id;
      renderGuideKinds();
      updateGuideBadge();

      $('file-name').textContent = (j.fileName || 'photo.jpg') + '（已恢复）';
      $('file-meta').textContent = `${S.docW}×${S.docH} · 已恢复 ${S.edits.length} 处修改` +
        (j.dropped ? `（较早的 ${j.dropped} 次未能保存）` : '');
      $('hud').hidden = false;
      $('btn-save').disabled = false;

      rebuildViewCanvas();
      fitToScreen();
      // 恢复 = 回到编辑页，首页要收起、工具栏要展开
      renderHome();
      syncToolbar();
      updateUI();
      // 如实报告：有没恢复成功的就说清楚，别让用户以为「全都回来了」。
      //
      // 「一个都没恢复」要单独说 —— 这正是用户抱怨的「明明保存了却是初始状态」：
      // 以前这种情况也会弹「已恢复 0 处修改」，听起来像成功了，实际画面是原图。
      if (!S.edits.length) {
        toast('这条记录的编辑数据没能恢复（可能已损坏或超出存档上限），当前显示的是原图', 6000);
      } else if (failedPatches > 0) {
        toast('已恢复 ' + S.edits.length + ' 处修改，另有 ' + failedPatches +
          ' 处没能恢复（数据可能已损坏）', 5000);
      } else {
        toast('已恢复上次未完成的编辑（' + S.edits.length + ' 处修改）', 3600);
      }
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
    console.error('[枫叶修图] 致命错误 @' + where, err);
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

  /* ============================ 浏览器兼容 ============================ */

  /**
   * 实测 flex gap 是否生效。
   *
   * 为什么不用 @supports：
   *   `@supports (gap: 1px)` 在 Chrome 66~83 上返回 true —— 因为 grid 的 gap
   *   早就支持了，但 **flex 的 gap 要 Chrome 84 才有**。用 @supports 判断会漏掉
   *   一大批机型，界面直接挤成一团。所以这里真的建两个盒子量一下。
   */
  function detectFlexGap() {
    try {
      const box = document.createElement('div');
      box.style.cssText =
        'position:absolute;left:-9999px;top:0;display:flex;flex-direction:row;' +
        'column-gap:13px;gap:13px;width:40px;height:2px';
      const a = document.createElement('div');
      const b = document.createElement('div');
      a.style.cssText = 'width:5px;height:2px;flex:0 0 auto';
      b.style.cssText = 'width:5px;height:2px;flex:0 0 auto';
      box.appendChild(a);
      box.appendChild(b);
      document.body.appendChild(box);
      const d = Math.round(b.getBoundingClientRect().left - a.getBoundingClientRect().left);
      document.body.removeChild(box);
      // 有 gap 时两个 5px 盒子间距应为 13px
      return d >= 12;
    } catch (e) {
      return true;   // 测不了就按支持处理，宁可不打补丁
    }
  }

  /** 从 UA 里取 Chrome/WebView 主版本号（取不到返回 0） */
  function detectChromeVersion() {
    try {
      const ua = navigator.userAgent || '';
      const m = /Chrome\/(\d+)/.exec(ua);
      if (m) return Number(m[1]);
      // 部分国产内核不报 Chrome，但报 AppleWebKit；拿不到就交给能力探测
      return 0;
    } catch (e) {
      return 0;
    }
  }

  /** 安全地做 CSS.supports 探测（老内核可能没有这个 API） */
  function cssSupports(prop, value) {
    try {
      if (typeof CSS === 'undefined' || !CSS.supports) return true;   // 没有就按支持处理
      return CSS.supports(prop, value);
    } catch (e) {
      return true;
    }
  }

  /** 探测一次环境能力，给老内核打补丁 */
  function applyCompat() {
    let plan;
    try {
      plan = C.planCompat({
        chrome: detectChromeVersion(),
        hasFlexGap: detectFlexGap(),
        hasInset: cssSupports('inset', '0'),
        hasAspectRatio: cssSupports('aspect-ratio', '1 / 1'),
        hasMinFn: cssSupports('width', 'min(1px, 2px)'),
        // async/await 无法运行时探测（语法错误就没机会执行到这里），
        // 由版本号推断；这里按支持处理，真不支持时页面根本到不了这一步
        hasAsync: true
      });
    } catch (e) {
      return null;   // 探测本身失败不该影响启动
    }
    if (plan.patches.length) {
      const root = document.documentElement;
      for (const cls of C.compatClassNames(plan.patches)) root.classList.add(cls);
      console.log('[枫叶修图] 已启用兼容模式：' + plan.patches.join(', '));
    }
    S.compat = plan;
    return plan;
  }

  /* ---------------- 禁掉「长按选字」和「长按弹出系统菜单」 ----------------
   *
   * 修图应用里长按画布是「看原图」，但 WebView 默认把长按当成文字操作：
   *   按住画面 → 安卓选中界面里的汉字 → 弹出「复制/全选」气泡 → 盖住画面，
   *   而且长按对比根本没法用（选区一出来，看的就是被选中的文字而不是照片）。
   *
   * 三道一起关：
   *   1. CSS 的 user-select（老内核要加 -webkit- 前缀）—— 从根上不让文字可选
   *   2. selectstart 事件 —— 少数内核无视 user-select
   *   3. contextmenu 事件 —— 安卓 WebView 的长按菜单走这个事件，
   *      不拦的话即使选不中字，按住不动也会弹出系统菜单
   *
   * 但输入框必须保留可选：API Key、提示词、地址栏都要能长按粘贴/全选，
   * 把那里也禁掉等于把「粘贴 Key」这条路堵死 —— 那是用户最常做的操作之一。
   */
  function lockTextSelection() {
    const style = document.createElement('style');
    style.id = 'no-select-style';
    style.textContent = [
      'html, body, #app, #stage, #cv, .sheet-mask, .st-card, .cl-item {',
      '  -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; user-select: none;',
      '  -webkit-touch-callout: none;',
      '}',
      'input, textarea, [contenteditable="true"] {',
      '  -webkit-user-select: text; -moz-user-select: text; -ms-user-select: text; user-select: text;',
      '  -webkit-touch-callout: default;',
      '}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);

    // 输入框里要放行：否则「长按粘贴」和「全选删掉重填」都会失效
    const inField = (el) => {
      if (!el || !el.tagName) return false;
      const tag = String(el.tagName).toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
    };
    const guard = (ev) => {
      if (inField(ev.target)) return;
      ev.preventDefault();
    };
    document.addEventListener('selectstart', guard, true);
    document.addEventListener('contextmenu', guard, true);
  }

  /* ============================ 启动 ============================ */

  function boot() {
    applyCompat();               // 必须最先做：老内核要在渲染前打上补丁
    lockTextSelection();         // 长按选字会盖住画面、挡掉长按看原图
    S.cfg = loadCfg();
    // 迁移过配置就必须立刻落盘。
    // 不落盘的话，每次启动都会重新迁移一遍 —— 用户手动改回来的设置会被反复覆盖。
    if (lastCfgMigration.length) saveCfg();
    // 载入跨天的修图记录（必须早于 bind，角标要能立刻显示条数）
    S.library = loadLibrary();
    updateLibraryBadge();
    // 载入调用日志（设置页那一行要立刻显示「N 次 · 花费 $X」）
    S.callLog = loadCallLog();
    updateCallLogBrief();
    undoStack = C.createUndoStack(100);
    refreshBgColor();
    bind();
    // 首屏就是「修改历史」：没有照片时显示首页，工具栏默认收起。
    // 必须在 bind 之后 —— 渲染出来的条目要能绑定点击事件。
    renderHome();
    syncToolbar();
    syncSettingsUI();
    updateUI();
    resizeCanvas();

    $('about').textContent = '纯本地运行 · 照片只发往你配置的接口';
    const av = $('about-version');
    if (av) av.textContent = 'v' + APP_VERSION + '（' + ((window.PS_VERSION && window.PS_VERSION.versionCode) || '?') + '）';
    checkUpgrade();
    // 静默检查更新：延迟 3 秒再发（不跟启动时的其它请求抢带宽），
    // 失败也不打扰用户 —— 只有手动检查时才报错
    if (S.cfg.autoCheckUpdate !== false) {
      setTimeout(() => { checkUpdate(false).catch(() => { /* 静默 */ }); }, 3000);
    }
    // 检查是否有上次未完成的编辑（Android 后台回收很常见）
    if (S.cfg.autoSaveSession !== false) offerSessionRestore();

    // 新手教程：只在第一次启动弹一次。
    // 延后一拍再弹：首屏要先把首页/工具栏渲染出来，教程的高亮圈才能量到
    // 真实位置 —— 同步弹的话元素还没布局，圈会套到 (0,0)。
    if (shouldAutoTutorial()) {
      setTimeout(() => {
        // 这一拍里用户可能已经打开照片了（引导条上的「恢复」按钮），
        // 那就别再拿教程盖住画布
        if (!S.img && shouldAutoTutorial()) openTutorial(true);
      }, 600);
    }

    // 后台保活：把当前状态同步给原生。
    // 无条件调用 —— 桥可能比 boot 晚就绪，syncKeepAlive 内部会实时探测并自行处理。
    // 常驻保活必须在这里补一次，否则用户上次开了常驻、这次重启就失效了。
    // 主题：尽早应用，避免先闪一下深色再变浅色。
    // 这里在 boot 里就调，而不是等用户打开设置页。
    applyTheme();
    watchSystemTheme();
    renderThemeChips();

    syncKeepAlive();
    // 通知权限：**启动就申请**，不再挂在「常驻保活」这个开关上。
    // 以前只有开了常驻保活才申请，结果是绝大多数用户从来没被问过，
    // 于是「生成完成/失败」的通知被系统静默丢弃 —— 用户看到的就是「无法发通知」。
    // 这个权限只影响通知显示，拒绝了也能正常修图，所以启动时问一次是安全的。
    askNotificationPermission();

    // 老内核兼容提示：不弹窗打扰，只在控制台留痕 + 升级条里说明
    if (S.compat && S.compat.warn) console.warn('[枫叶修图] ' + S.compat.warn);

    // 切回前台时重新同步一次：应用在后台期间保活状态可能与实际不符
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        syncKeepAlive();
        updateKeepAliveUI();
        return;
      }
      // 切到后台 = 最可能被系统回收的时刻。防抖保存还有 1.6 秒没落地，
      // 这一下没存住，回来就是「记录不见了」。
      // 这里同步存一次（不弹提示，用户看不见界面）。
      try { forceSaveNow({ silent: true }); } catch (e) { /* 后台保存失败不该崩 */ }
    });

    // 页面被卸载前的最后机会。
    // pagehide 比 beforeunload 更可靠（安卓 WebView 常常不触发后者）。
    window.addEventListener('pagehide', () => {
      try { forceSaveNow({ silent: true }); } catch (e) { /* ignore */ }
    });

    // 若通过本地服务打开，探测代理是否可用
    if (location.protocol !== 'file:') {
      fetch('api/health').then((r) => r.ok ? r.json() : null).then((j) => {
        if (j && j.ok) console.log('[枫叶修图] 本地代理可用');
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
    fitToScreen,
    // 历史时间线（供测试与外部调用）
    renderHistory,
    openHistory,
    closeHistory,
    buildTimeline: currentTimeline,
    historySize: () => (undoStack ? undoStack.size() : { past: 0, future: 0 }),
    undo, redo,
    previewGradeFast, previewGradeSoon, renderGradePreview,
    undoStack: () => undoStack,
    // 作品库（跨天修图记录，供测试与外部调用）
    loadLibrary, kvStorageAvailable, kvSaveLibrary, kvLoadLibrary,
    saveLibrary,
    touchWork,
    scheduleWorkSave,
    forceSaveNow,
    saveState,
    syncSaveNowUI,
    // 自定义快捷提示词（供测试与外部调用）
    renderQuickChips,
    renderQuickPromptSettings,
    addQuickPrompt,
    quickPrompts: () => S.cfg.quickPrompts,
    renderLibrary,
    openLibrary,
    closeLibrary,
    openWorkPreview,
    continueWork,
    library: () => S.library,
    // 调用日志（供测试与外部调用）
    loadCallLog,
    saveCallLog,
    recordCallLog,
    // 日志详情与诊断包
    buildDiagnosticBundle, exportDiagnostics, maskSecret,
    renderCallLog,
    openCallLog,
    closeCallLog,
    exportCallLog,
    updateCallLogBrief,
    callLog: () => S.callLog,
    setCallLog: (list) => { S.callLog = Array.isArray(list) ? list : []; updateCallLogBrief(); },
    // 设置面板（日志入口在设置里，测试要能打开它）
    openSettings, closeSettings, syncSettingsUI,
    // 基础调色（供测试与外部调用）
    openGradeTool, applyGrade, previewGrade, resetGradeDraft,
    renderGradeSliders, updateGradeNote, updateGradeBadge, makeGradeEdit,
    gradeDraft: () => gradeDraft,
    setGradeDraft: (g) => { gradeDraft = C.normalizeGrade(g || {}); renderGradeSliders(); previewGrade(); },
    // 新手教程（供测试与外部调用）
    openTutorial, closeTutorial, renderTutorial, layoutTutorial,
    tutorialNext, tutorialPrev, tutorialOpen, tutorialSeen,
    markTutorialSeen, clearTutorialSeen, shouldAutoTutorial,
    tutorialIndex: () => tutIdx,
    tutorialSteps: () => C.TUTORIAL_STEPS,
    workId: () => S.workId,
    // 后台保活 + 环境兼容（供测试与外部调用）
    syncKeepAlive,
    keepAliveState: () => S.keepAliveState,
    keepAliveSupported,
    updateKeepAliveUI,
    notifyGenDone,
    applyCompat,
    compat: () => S.compat,
    // 检查更新（供测试与外部调用）
    checkUpdate,
    showUpdateBar,
    showReleaseNotes,
    startUpdate,
    readUpdateState,
    writeUpdateState,
    fetchReleases,
    openExternal,
    // 首页 / 工具栏 / 照片信息 / 导出（供测试与外部调用）
    renderHome,
    isHomeVisible,
    // 多组供应商配置
    syncVendorPresets, useVendorPreset, saveVendorPreset,
    renameVendorPreset, deleteVendorPreset,
    vendorPresets: () => S.cfg.presets,
    lastSavedSession: () => lastSavedSession,
    // 参考图
    refImages: () => refImages,
    // 画布背景
    syncBgUI, loadBgImage, clearBg,
    // 设置分级
    showSettingsPage, settingsAtHome, settingsPage: () => settingsPage,
    invalidateMask, draw, autoSelectAt,
    layoutCompare,
    resetView: () => { const v = viewSize(); S.view = C.fitView(S.docW, S.docH, v.w, v.h, 14); draw(); },
    longPressState: () => ({ active: longPressActive, timer: !!longPressTimer }),
    imageToScreen: (p) => C.imageRectToScreen({ x: p.x, y: p.y, w: 1, h: 1 }, S.view),
    openSettings, closeSettings, handleBack,
    bgState: () => C.normalizeBg(S.cfg.bg),
    resetBgCache: () => { bgImage = null; bgImageKey = ''; },
    lastRefNote: () => lastRefNote,
    addRefImages, clearRefImages, renderRefImages, refLimit,
    activeVendorPreset: () => C.findActivePreset(S.cfg.presets || [], S.cfg),
    setToolbarVisible,
    syncToolbar,
    expandToolbar,
    collapseToolbar,
    applyBarHeight,
    saveBarHeight,
    barFullHeight,
    toolbarVisible: () => S.toolbarVisible,
    toolbarHeight: () => S.toolbarHeight,
    toolbarFull: () => S.toolbarFull,
    handleBack,
    openMoreMenu, closeMoreMenu, toggleMoreMenu, moreMenuOpen,
    goHome,
    openPhotoInfo,
    closePhotoInfo,
    openExportPanel,
    closeExportPanel,
    currentExportPreset,
    renderExportPanel,
    updateExportSummary,
    exportPresetState: () => ({ expFormat, expMaxSide, expQuality, expCustomSide }),
    exportImage,
    // 保存位置（供测试与外部调用）
    nativeSaveAvailable,
    nativeSave,
    saveWhere: () => S.cfg.expSaveWhere,
    // 引导线（供测试与外部调用）
    guides: () => S.guides,
    setGuides: (list) => { S.guides = (list || []).map(C.normalizeGuide); updateGuideBadge(); scheduleSessionSave(); draw(); },
    clearGuides,
    renderGuideKinds,
    updateGuideBarVisibility,
    drawGuides,
    hitGuide,
    hintsSeen: () => loadHints().slice(),
    resetHints: () => {
      hintsSeen = [];
      saveHints();
      // 内存里的「本次是否显示」缓存也必须清掉：
      // 只清 localStorage 的话，重置后提示依然不出现 —— 与承诺的行为不符
      resetTipDecision();
      // 刷新界面时必须屏蔽"顺带记录提示"：updateUI 会为当前工具
      // 重新判定并写回一条，导致刚清空就又有记录了。
      resettingHints = true;
      try { updateUI(); } finally { resettingHints = false; }
      toast('工具提示已重置，下次进入会再显示一次');
    },
    hintSeen,
    // 兼容旧测试/API：该能力现在固定开启，避免旧 localStorage 的 false 让模型看不到线。
    strokeOverlayEnabled: () => true,
    strokeNote: () => lastStrokeNote,
    // 对比视图（供测试与外部调用）
    compareView: () => cmpView,
    compareSplit: () => cmpSplit,
    resetCompareZoom,
    showCompare,
    drawCompare,
    cmpFitView
  };
})();
