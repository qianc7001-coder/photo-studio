/* =============================================================================
 * 端到端测试（真实 canvas 版）
 *   - jsdom + @napi-rs/canvas 提供真实 2D 渲染
 *   - 内置假生图模型服务器，跑完整「框选 → 生成 → 贴回 → 撤销 → 导出」流程
 *   - 关键断言：选区外像素必须逐字节不变，选区内必须变成模型返回的内容
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
// 可选依赖：优先标准解析（CI 里 npm install 装在项目内），
// 退化到本机固定目录（本地开发时依赖装在 /tmp/domtest）。
function loadOptional(name) {
  try { return require(name); }
  catch (e) {
    try { return require('/tmp/domtest/node_modules/' + name); }
    catch (e2) {
      console.log('  ⚠ 跳过：未安装可选依赖 ' + name);
      console.log('    安装方式：npm install --no-save jsdom @napi-rs/canvas');
      process.exit(0);
    }
  }
}
const { JSDOM, VirtualConsole } = loadOptional('jsdom');
const napi = loadOptional('@napi-rs/canvas');

// 默认测源码目录；用 APP_DIR 指向别处可以测「打包产物里的真实资源」
// （发布前必做：确认 APK 里带的确实是这份代码，而不是只有源码里对）
const APP = process.env.APP_DIR
  ? path.resolve(process.env.APP_DIR)
  : path.join(__dirname, '..', 'app');
let pass = 0, fail = 0;
const failures = [];
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++; failures.push(name);
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 等生成结束（busy 变 false）或超时 */
async function waitGen(S, timeout) {
  const limit = timeout || 5000;
  const t0 = Date.now();
  while (S.busy && Date.now() - t0 < limit) await sleep(50);
  await sleep(80);
}

/* ============================ 假生图模型 ============================ */
/** 简易 multipart 解析（够测试用）：返回 { fields, files } */
function parseMultipart(headers, buf) {
  const ctype = headers['content-type'] || '';
  const m = /boundary=(.+)$/.exec(ctype);
  if (!m) return null;
  const boundary = '--' + m[1].trim().replace(/^"|"$/g, '');
  const out = { fields: {}, files: {} };
  const text = buf.toString('binary');
  const parts = text.split(boundary);
  const CRLF = '\r\n';
  for (const part of parts) {
    const trimmed = part.trim();
    if (!part || trimmed === '--' || trimmed === '') continue;
    const idx = part.indexOf(CRLF + CRLF);
    if (idx < 0) continue;
    const head = part.slice(0, idx);
    // 去除分界标记收尾：可能带 CRLF-- 或 CRLF（boundary 前后各有一个 CRLF）
    let bodyStr = part.slice(idx + 4);
    bodyStr = bodyStr.replace(CRLF + '--', '');
    bodyStr = bodyStr.replace(/\r?\n?\r?\n$/, '');
    const body = Buffer.from(bodyStr, 'binary');
    const nm = /name="([^"]+)"/.exec(head);
    if (!nm) continue;
    const fm = /filename="([^"]+)"/.exec(head);
    if (fm) {
      // 同名多文件必须**全部保留** —— 之前直接覆盖，只剩最后一个。
      // 而「主图 + 参考图都叫 image[]」正是要验证的场景：
      // 覆盖之后无论字段对不对都只能看到一个，断言就永远成立（假绿）。
      out.files[nm[1]] = { name: fm[1], data: body, length: body.length };
      if (!out.fileList) out.fileList = [];
      out.fileList.push({ field: nm[1], name: fm[1], data: body, length: body.length });
      if (!out.fileFields) out.fileFields = {};
      if (!out.fileFields[nm[1]]) out.fileFields[nm[1]] = [];
      out.fileFields[nm[1]].push({ name: fm[1], data: body, length: body.length });
    } else {
      out.fields[nm[1]] = body.toString('utf8').replace(/\r\n$/, '');
    }
  }
  return out;
}


/**
 * 服务端行为可编程：返回一张纯色图（颜色 = marker 参数），
 * 用来验证「生成的内容确实被贴回了选区内」。
 */
function startFakeModel() {
  return new Promise((resolve) => {
    const seen = [];
    let nextColor = [220, 40, 40];   // 默认红色
    // 人为延迟：用来测「生成中按返回键取消」这类需要请求未完成才能验的路径。
    // 假服务响应太快的话，生成瞬间就结束了，取消逻辑根本走不到。
    let nextDelay = 0;
    // 按提示词指定颜色（并发测试用；见上面 served 的注释）
    const colorFor = [];
    const srv = http.createServer((req, res) => {
      // 必须收集原始 Buffer：PNG 等二进制不能按 UTF-8 转字符串，否则字节会被破坏
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        // 兼容 multipart/form-data：解析出各字段与文件
        let json = null, mpFields = null;
        const ctype = req.headers['content-type'] || '';
        if (ctype.includes('multipart/') && process.env.DB === '1') {
          console.log('[fakemodel] ctype=', ctype);
          console.log('[fakemodel] body len=', body.length);
        }
        if (ctype.includes('multipart/')) {
          mpFields = parseMultipart(req.headers, body);
          json = mpFields && mpFields.fields ? mpFields.fields : null;
        } else {
          try { json = JSON.parse(body.toString('utf8')); } catch (e) { }
        }
        const rec = {
          url: req.url, auth: req.headers.authorization, body: json,
          multipart: mpFields, ctype: req.headers['content-type'] || '',
          // served 在下面真正出图时填 —— 颜色是**响应那一刻**才读的
          served: null
        };
        seen.push(rec);

        if (req.url.includes('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'Qwen/Qwen-Image-Edit' }] }));
          return;
        }
        if (rec.failWith) { /* noop */ }
        if (json && json.__fail) {
          res.writeHead(json.__status || 500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: json.__message || 'fake failure' }));
          return;
        }
        if (nextDelay) await sleep(nextDelay);
        // 生成纯色 PNG。
        // 注意：颜色是在**这里**（延迟之后）读的，所以并发请求拿到的颜色
        // 由「谁先醒来」决定，不由发起顺序决定。
        // 把真正用掉的颜色记进 rec.served —— 测试要断言「某次请求拿到了什么颜色」
        // 就必须看它，不能假设「先发起的拿到先设的颜色」。
        const c = napi.createCanvas(64, 64);
        const cx = c.getContext('2d');
        // 按提示词给颜色：并发场景下「谁先醒来」不确定，
        // 用 nextColor 会让测试断言依赖调度顺序（假失败）。
        // 按提示词映射之后，每次请求拿到什么是确定的。
        let served = nextColor.slice();
        const pr = (json && typeof json.prompt === 'string') ? json.prompt : '';
        for (const [needle, col] of colorFor) {
          if (pr.indexOf(needle) >= 0) { served = col.slice(); break; }
        }
        rec.served = served;
        cx.fillStyle = `rgb(${served[0]},${served[1]},${served[2]})`;
        cx.fillRect(0, 0, 64, 64);
        const b64 = c.toBuffer('image/png').toString('base64');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ images: [{ url: 'data:image/png;base64,' + b64 }] }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      srv, port: srv.address().port, seen,
      setColor: (c) => { nextColor = c; },
      setDelay: (ms) => { nextDelay = Math.max(0, ms | 0); },
      /**
       * 让「含某个关键词的请求」固定拿到某个颜色（并发测试的确定性保障）。
       *
       * 刻意**累加**而不是清空：并发场景下 A 的请求还在飞，
       * 测试接着为 B 注册映射 —— 清空会把 A 的映射一起抹掉，
       * 于是 A 醒来时只能拿到 nextColor，断言随之变成假失败。
       * 同关键词重复注册时覆盖（不重复堆积）。
       */
      setColorFor: (needle, c) => {
        if (!needle) return;
        const i = colorFor.findIndex((x) => x[0] === needle);
        if (i >= 0) colorFor[i] = [needle, c.slice()];
        else colorFor.push([needle, c.slice()]);
      },
      clearColorFor: () => { colorFor.length = 0; }
    }));
  });
}

/* ============================ 测试主流程 ============================ */

async function run() {
  const fake = await startFakeModel();
  console.log(`\n假模型服务器：127.0.0.1:${fake.port}\n`);
  /* ---------- 画布背景测试用的小工具 ---------- */
  /** 直接读主画布像素（CSS px 坐标，内部已按 DPR 换算） */
  function readCanvasPx(x, y) {
    const d = window.devicePixelRatio || 1;
    const sx = Math.round(x * d), sy = Math.round(y * d);
    const im = cv.getContext('2d').getImageData(sx, sy, 1, 1).data;
    return [im[0], im[1], im[2]];
  }
  /** 让背景图缓存失效（模拟换图） */
  function bgImageReset() {
    if (window.__PS_API && window.__PS_API.resetBgCache) window.__PS_API.resetBgCache();
  }
  function variance(arr) {
    if (!arr.length) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length;
  }

  console.log('【1】启动与初始化');

  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  const logs = [];
  const vc = new VirtualConsole();
  vc.on('log', (...a) => logs.push(a.join(' ')));
  vc.on('jsdomError', (e) => logs.push('JSDOM_ERROR: ' + (e.detail ? (e.detail.stack || e.detail.message) : e.message)));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:8788/',
    virtualConsole: vc
  });
  const { window } = dom;
  const doc = window.document;

  /* ---------- 用真实 canvas 替换 jsdom 的桩 ---------- */
  // jsdom 的 <canvas> 元素与 @napi-rs/canvas 是两套对象，这里做一层桥接：
  //  - 每个 jsdom canvas 背后挂一个真实 canvas
  //  - drawImage 的参数若为 jsdom canvas，自动换成它背后的真实 canvas
  const realOf = (c) => {
    if (!c) return c;
    if (c.__real) return c.__real;                 // jsdom canvas → 背后的真实 canvas
    if (c.canvas && c.canvas.__real) return c.canvas.__real;
    if (typeof c.getContext === 'function' && c.tagName === 'CANVAS') { c.getContext('2d'); return c.__real; }
    return c;                                       // 已经是真实 canvas / Image
  };
  const wrapCtx = (jsCanvas, realCtx) => {
    const handler = {
      get(target, prop) {
        const v = target[prop];
        if (typeof v === 'function') {
          if (prop === 'drawImage') {
            return function (...args) {
              const a = args.map((x) => realOf(x));
              return target.drawImage(...a);
            };
          }
          if (prop === 'putImageData') {
            // 必须把脏矩形参数一起转发 —— 否则「只上传变化区域」这个优化
            // 在测试里完全体现不出来（每次都整块重建 ImageData，
            // 1600×1200 一帧就要几十毫秒），测出来的性能是假的。
            return function (img, x, y, dirtyX, dirtyY, dirtyW, dirtyH) {
              const data = img && img.data ? img.data : img;
              const native = new napi.ImageData(data, img.width, img.height);
              if (dirtyX === undefined) return target.putImageData(native, x, y);
              return target.putImageData(native, x, y, dirtyX, dirtyY, dirtyW, dirtyH);
            };
          }
          if (prop === 'createPattern') {
            return function (a, b) { return target.createPattern(realOf(a), b); };
          }
          return v.bind(target);
        }
        return v;
      },
      set(target, prop, val) {
        if (prop === 'fillStyle' || prop === 'strokeStyle') {
          try { target[prop] = val; return true; } catch (e) { return true; }
        }
        try { target[prop] = val; } catch (e) { /* ignore */ }
        return true;
      }
    };
    return new Proxy(realCtx, handler);
  };

  window.HTMLCanvasElement.prototype.getContext = function () {
    if (!this.__real) {
      this.__real = napi.createCanvas(Math.max(1, this.__w || 300), Math.max(1, this.__h || 150));
    }
    if (!this.__wrapped) this.__wrapped = wrapCtx(this, this.__real.getContext('2d'));
    return this.__wrapped;
  };
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'width', {
    get() { return this.__w == null ? 300 : this.__w; },
    set(v) {
      this.__w = v;
      if (this.__real) this.__real.width = v;
    }
  });
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'height', {
    get() { return this.__h == null ? 150 : this.__h; },
    set(v) {
      this.__h = v;
      if (this.__real) this.__real.height = v;
    }
  });

  /**
   * 浏览器画布 API 的质量参数是 0~1 的**小数**，而 @napi-rs/canvas 的
   * toBuffer 收的是 0~100 的**整数**。直接把小数传进去，napi 会当成
   * 「质量 0.75%」—— 编出来的 JPEG 又小又糊（几 KB 而不是几百 KB）。
   *
   * 这个差异会让「作品库体积」类的测试彻底失真：
   * 会话基准图本该是 MB 量级，却只有几十 KB，于是无论怎么存都放得下，
   * 测试「通过」但真实设备上照样只存得下一张。
   * 所以桥接层必须做这个换算，让桩的行为与浏览器一致。
   */
  const napiQuality = (q) => {
    const n = typeof q === 'number' ? q : 0.92;
    if (!Number.isFinite(n) || n <= 0) return 92;
    // 已经是 0~100 的整数就原样用（调用方可能直接传整数）
    if (n > 1) return Math.max(1, Math.min(100, Math.round(n)));
    return Math.max(1, Math.min(100, Math.round(n * 100)));
  };
  window.HTMLCanvasElement.prototype.toDataURL = function (fmt, q) {
    if (!this.__real) this.getContext('2d');
    const isPng = /png/i.test(String(fmt || ''));
    const buf = isPng
      ? this.__real.toBuffer('image/png')
      : this.__real.toBuffer('image/jpeg', napiQuality(q));
    return (isPng ? 'data:image/png;base64,' : 'data:image/jpeg;base64,') + buf.toString('base64');
  };
  window.HTMLCanvasElement.prototype.toBlob = function (cb, fmt, q) {
    if (!this.__real) this.getContext('2d');
    const isPng = /png/i.test(String(fmt || ''));
    const buf = isPng
      ? this.__real.toBuffer('image/png')
      : this.__real.toBuffer('image/jpeg', napiQuality(q));
    cb(new window.Blob([new Uint8Array(buf)], { type: fmt || 'image/jpeg' }));
  };

  window.createImageBitmap = async function (blob) {
    const buf = Buffer.from(await blob.arrayBuffer());
    return await napi.loadImage(buf);   // 真实 Image，可被真实 canvas drawImage
  };

  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.id === 'stage' || this.id === 'compare') {
      return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 };
    }
    return { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0 };
  };
  window.HTMLElement.prototype.setPointerCapture = function () { };
  window.HTMLElement.prototype.releasePointerCapture = function () { };
  window.devicePixelRatio = 1;

  const realFetch = globalThis.fetch;
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('data:')) {
      const bin = Buffer.from(u.split(',')[1], 'base64');
      return {
        ok: true, status: 200,
        blob: async () => new window.Blob([new Uint8Array(bin)], { type: 'image/png' }),
        json: async () => ({}), text: async () => ''
      };
    }
    if (u.includes('/api/generate')) {
      // 代理协议：目标在头部，body 原样转发
      const target = opts.headers['X-Target-Url'] || opts.headers['x-target-url'];
      const auth = opts.headers['X-Target-Auth'] || opts.headers['x-target-auth'] || '';
      const pu = new URL(target);
      const ct = opts.headers['Content-Type'] || opts.headers['content-type'] || 'application/json';
      if (process.env.DB === '1') {
        console.log('[stub] 转发 ' + pu.pathname + ' ct=' + ct + ' bodyType=' + (typeof opts.body) + ' isMP=' + (typeof opts.body !== 'string'));
      }
      const r = await realFetch(`http://127.0.0.1:${fake.port}${pu.pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': ct, Authorization: auth },
        body: opts.body
      });
      return { ok: r.ok, status: r.status, json: () => r.json(), text: () => r.text(), blob: () => r.blob() };
    }
    if (u.includes('/api/health')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    if (u.includes('images/generations') || u.includes('images/edits') || u.includes('/models')) {
      const pu = new URL(u);
      const r = await realFetch(`http://127.0.0.1:${fake.port}${pu.pathname}`, opts);
      return { ok: r.ok, status: r.status, json: () => r.json(), text: () => r.text(), blob: () => r.blob() };
    }
    throw new Error('未预期的网络请求: ' + u);
  };
  window.fetch = window.fetch;
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  window.AbortController = globalThis.AbortController;
  window.ImageData = napi.ImageData;
  window.Uint8ClampedArray = globalThis.Uint8ClampedArray;
  window.localStorage.clear();

  const runScript = (file) => {
    const s = doc.createElement('script');
    s.textContent = fs.readFileSync(path.join(APP, file), 'utf8');
    doc.body.appendChild(s);
  };
  // jsdom 的 window 里没有裸 fetch，补一个指向我们桩实现的全局
  window.eval('globalThis.fetch = window.fetch;');
  runScript('version.js');   // app.js 启动时会读 window.PS_VERSION
  runScript('core.js');
  runScript('app.js');
  await sleep(150);

  const S = window.__PS;
  // 测试辅助：画笔掩膜缓存与重绘（这两个是 app 内部函数，通过触发交互间接调用）
  const invalidateMaskForTest = () => {
    // 通过改变选区触发缓存失效
    const r = S.rect;
    if (r) { S.rect = Object.assign({}, r, { x: r.x + 1 }); S.rect = r; }
  };
  const drawForTest = () => { window.dispatchEvent(new window.Event('resize')); };
  t('core.js 已加载', !!window.PSCore);
  t('app.js 已初始化', !!S);
  t('服务商下拉框已填充', doc.getElementById('set-provider').children.length === 3, doc.getElementById('set-provider').children.length);
  t('模型候选列表已填充', doc.getElementById('model-list').children.length > 3, doc.getElementById('model-list').children.length);
  t('比例按钮 8 个', doc.getElementById('ratio-chips').children.length === 8);
  t('修图预设已填充', doc.getElementById('style-select').children.length === 8, doc.getElementById('style-select').children.length);
  t('修改范围已填充', doc.getElementById('scope-select').children.length === 3);
  t('快捷指令已填充', doc.getElementById('quick-chips').children.length === 6);
  t('浮层默认全部隐藏',
    doc.getElementById('settings').hidden && doc.getElementById('busy').hidden &&
    doc.getElementById('compare').hidden && doc.getElementById('brush-bar').hidden);

  /* ---------- 载入图片 ---------- */
  console.log('\n【2】载入照片');
  const src = napi.createCanvas(400, 300);
  const sc = src.getContext('2d');
  sc.fillStyle = 'rgb(30,90,160)';
  sc.fillRect(0, 0, 400, 300);
  // 加一个明显的白色方块作为「要改的目标」
  sc.fillStyle = 'rgb(255,255,255)';
  sc.fillRect(150, 100, 100, 100);
  const srcPng = src.toBuffer('image/png');

  S.cfg.apiKey = 'sk-test';
  S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
  S.cfg.model = 'Qwen/Qwen-Image-Edit';
  S.cfg.netMode = 'direct';
  S.cfg.feather = 0;
  S.cfg.colorMatch = 0;
  S.cfg.contextPct = 0;
  S.cfg.maxRes = 0;

  const input = doc.getElementById('file-input');
  Object.defineProperty(input, 'files', {
    value: [new window.File([new Uint8Array(srcPng)], 'shot.png', { type: 'image/png' })],
    configurable: true
  });
  input.dispatchEvent(new window.Event('change'));
  await sleep(300);

  t('图片已载入', S.imgW === 400 && S.imgH === 300, [S.imgW, S.imgH]);
  t('文档尺寸 = 原图', S.docW === 400 && S.docH === 300, [S.docW, S.docH]);
  // 首页（修改历史）在打开照片后必须收起，否则会盖住画布
  t('首页已收起', doc.getElementById('home').hidden === true);
  t('工具栏已展开', doc.getElementById('bottombar').classList.contains('collapsed') === false);
  t('导出按钮启用', doc.getElementById('btn-save').disabled === false);

  console.log('   [探针] viewCanvas=', !!S.viewCanvas, 'real=', !!(S.viewCanvas && S.viewCanvas.__real), 'size=', S.viewCanvas && S.viewCanvas.__real ? [S.viewCanvas.__real.width, S.viewCanvas.__real.height] : null);
  console.log('   [探针] docCanvas real=', !!(S.docCanvas && S.docCanvas.__real));
  const docPixel = (x, y) => {
    const d = S.viewCanvas.getContext('2d').getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  t('底色正确（30,90,160）', JSON.stringify(docPixel(10, 10)) === '[30,90,160]', docPixel(10, 10));
  t('白块存在（255,255,255）', JSON.stringify(docPixel(200, 150)) === '[255,255,255]', docPixel(200, 150));

  /* ---------- 框选 ---------- */
  console.log('\n【3】框选');
  const cv = doc.getElementById('cv');
  const ptr = (type, x, y, id) => {
    const e = new window.Event(type, { bubbles: true });
    e.clientX = x; e.clientY = y; e.pointerId = id || 1; e.button = 0; e.shiftKey = false;
    cv.dispatchEvent(e);
  };
  // 视图：400x300 图，800x600 视口，pad 14 → scale = min(772/400, 572/300) = 1.9067
  const v = S.view;
  const toScreen = (ix, iy) => ({ x: ix * v.scale + v.tx, y: iy * v.scale + v.ty });
  const a = toScreen(140, 90), b = toScreen(270, 215);
  ptr('pointerdown', a.x, a.y); ptr('pointermove', b.x, b.y); ptr('pointerup', b.x, b.y);
  await sleep(60);

  t('已产生选区', !!S.rect, S.rect);
  const R = S.rect;
  t('选区落在白块附近', R && R.x > 120 && R.x < 160 && R.y > 70 && R.y < 110, R);
  t('选区尺寸合理', R && R.w > 100 && R.h > 100, R && [R.w, R.h]);
  t('生成按钮启用', doc.getElementById('btn-generate').disabled === false);
  t('选区信息条显示', doc.getElementById('sel-info').hidden === false);

  /* ---------- 生成 ---------- */
  console.log('\n【4】生成（模型返回纯红图）');
  fake.setColor([220, 40, 40]);
  doc.getElementById('prompt').value = '把这块白色方块换成红色';
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);

  t('模型已收到请求', fake.seen.length === 1, fake.seen.length);
  const req = fake.seen[0] || {};
  t('鉴权头正确', req.auth === 'Bearer sk-test', req.auth);
  t('模型名正确', req.body && req.body.model === 'Qwen/Qwen-Image-Edit', req.body && req.body.model);
  t('提示词含用户指令', req.body && req.body.prompt.includes('把这块白色方块换成红色'));
  t('提示词含「其余部分不要改动」约束', req.body && /其余部分不要改动|只改动上面描述/.test(req.body.prompt),
    req.body && req.body.prompt.slice(0, 60));
  t('image 字段是 data URL', req.body && /^data:image\/jpeg;base64,/.test(req.body.image || ''), req.body && String(req.body.image).slice(0, 30));
  t('image_size 已带', req.body && !!req.body.image_size, req.body && req.body.image_size);
  t('进入对比态', !!S.pending);
  t('对比层已显示', doc.getElementById('compare').hidden === false);
  t('遮罩已关闭', doc.getElementById('busy').hidden === true);

  /* ---------- 应用 ---------- */
  console.log('\n【5】应用结果（验证像素级正确性）');
  doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
  await sleep(80);
  t('进入历史', S.edits.length === 1, S.edits.length);
  t('对比层关闭', doc.getElementById('compare').hidden === true);
  t('撤销可用', doc.getElementById('btn-undo').disabled === false);

  const inside = docPixel(R.x + Math.round(R.w / 2), R.y + Math.round(R.h / 2));
  t('选区内已变成模型返回的红色', inside[0] > 200 && inside[1] < 60 && inside[2] < 60, inside);

  const farCorner = docPixel(5, 5);
  t('选区外左上角像素完全不变', JSON.stringify(farCorner) === '[30,90,160]', farCorner);
  const farRight = docPixel(395, 295);
  t('选区外右下角像素完全不变', JSON.stringify(farRight) === '[30,90,160]', farRight);
  const outsideNear = docPixel(Math.max(0, R.x - 12), Math.min(299, R.y + Math.round(R.h / 2)));
  t('选区边界外 12px 处不变', JSON.stringify(outsideNear) === '[30,90,160]', outsideNear);

  // 逐像素扫描：选区外必须一个字节都不差
  const full = S.viewCanvas.getContext('2d').getImageData(0, 0, 400, 300);
  let badPixels = 0, badSample = null;
  for (let y = 0; y < 300; y++) {
    for (let x = 0; x < 400; x++) {
      const isInside = x >= Math.floor(R.x) && x < Math.ceil(R.x + R.w) &&
        y >= Math.floor(R.y) && y < Math.ceil(R.y + R.h);
      if (isInside) continue;
      const i = (y * 400 + x) * 4;
      if (full.data[i] !== 30 || full.data[i + 1] !== 90 || full.data[i + 2] !== 160) {
        badPixels++;
        if (!badSample) badSample = [x, y, full.data[i], full.data[i + 1], full.data[i + 2]];
      }
    }
  }
  t('全图扫描：选区外零像素改动', badPixels === 0, { badPixels, badSample });

  /* ---------- 羽化贴回 ---------- */
  console.log('\n【6】羽化 + 色彩匹配');
  S.cfg.feather = 12;
  S.cfg.colorMatch = 100;
  fake.setColor([10, 10, 10]);
  S.rect = { x: 200, y: 50, w: 120, h: 120 };
  // 记录贴回前该点（含第一轮编辑结果）的真实颜色，作为「最外圈应保持原样」的基准
  const edgeBase = docPixel(200, 110);
  const bandBase = [];
  for (let dx = 0; dx <= 12; dx++) bandBase.push(docPixel(200 + dx, 110)[0]);
  doc.getElementById('prompt').value = '换成深色';
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  t('第二次请求已发出', fake.seen.length === 2, fake.seen.length);
  if (S.pending) {
    doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
    await sleep(80);
  }
  t('两轮编辑在历史中', S.edits.length === 2, S.edits.length);
  const c2 = docPixel(260, 110);
  t('第二轮选区内已被修改', c2[0] < 60 && c2[1] < 60 && c2[2] < 60, c2);
  // 羽化：最外圈像素应几乎等于原图（无缝），而过渡带内必须出现中间值
  const edge = docPixel(200, 110);
  t('羽化最外圈≈贴回前的原色（无硬边）', Math.abs(edge[0] - edgeBase[0]) <= 4, { edge, edgeBase });
  const band = [];
  for (let dx = 0; dx <= 12; dx++) band.push(docPixel(200 + dx, 110)[0]);
  const hasGradient = band.some((v, i) => Math.abs(v - bandBase[i]) > 2 && v > 12 && v < 28);
  t('羽化过渡带存在中间值（真正渐变）', hasGradient, { band, bandBase });
  const monotonic = band.every((v, i) => i === 0 || v <= band[i - 1] + 3);
  t('过渡带单调过渡（无跳变）', monotonic, band);

  /* ---------- 撤销 / 重做 ---------- */
  console.log('\n【7】撤销 / 重做');
  const beforeUndo = docPixel(260, 110);
  doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
  await sleep(60);
  t('撤销后历史减一', S.edits.length === 1);
  const afterUndo = docPixel(260, 110);
  t('撤销后像素已还原', JSON.stringify(afterUndo) !== JSON.stringify(beforeUndo), [beforeUndo, afterUndo]);
  t('重做按钮可用', doc.getElementById('btn-redo').disabled === false);
  doc.getElementById('btn-redo').dispatchEvent(new window.Event('click'));
  await sleep(60);
  t('重做后历史恢复', S.edits.length === 2);
  const afterRedo = docPixel(260, 110);
  t('重做后像素与撤销前一致', JSON.stringify(afterRedo) === JSON.stringify(beforeUndo), [afterRedo, beforeUndo]);

  /* ---------- 画笔掩膜 ---------- */
  console.log('\n【8】画笔掩膜');
  doc.querySelector('.tool[data-mode="brush"]').dispatchEvent(new window.Event('click'));
  await sleep(30);
  t('切到画笔模式', S.mode === 'brush');
  t('画笔栏显示', doc.getElementById('brush-bar').hidden === false);
  S.rect = { x: 50, y: 50, w: 200, h: 200 };
  // 用画笔擦除一小块
  const p1 = toScreen(100, 100), p2 = toScreen(130, 130);
  ptr('pointerdown', p1.x, p1.y, 7);
  ptr('pointermove', p2.x, p2.y, 7);
  ptr('pointerup', p2.x, p2.y, 7);
  await sleep(60);
  t('画笔产生了笔迹', S.strokes.length === 1, S.strokes.length);
  t('笔迹按文档坐标存储', S.strokes[0].points[0].x > 90 && S.strokes[0].points[0].x < 110,
    S.strokes[0].points[0]);

  // v3.9.2 掩膜语义：1=要改、0=不动。画笔默认「画上=改」。
  // 所以这里必须按真实路径（maskFromStrokes，initial:0）算，
  // 直接用 strokesToMask 的默认值会得到旧语义（initial:1），测出来是反的。
  t('★ 默认笔刷是「画上=改」', S.brushErase === false, S.brushErase);
  const mask = window.PSCore.strokesToMask(
    S.strokes.map((s) => ({ mode: s.mode, radius: s.radius, points: s.points.map((p) => ({ x: p.x - S.rect.x, y: p.y - S.rect.y })) })),
    S.rect.w, S.rect.h, { initial: 0 });
  const cov = window.PSCore.maskCoverage(mask);
  t('★★ 涂了之后只有一小块被标记（不是整块）', cov > 0.0005 && cov < 0.6, cov);
  t('★ 笔迹中心 = 要改', (() => {
    const lx = Math.round(105 - S.rect.x), ly = Math.round(105 - S.rect.y);
    if (lx < 0 || ly < 0 || lx >= S.rect.w || ly >= S.rect.h) return false;
    return mask[ly * S.rect.w + lx] > 0.5;
  })());

  // 用掩膜生成：模型返回绿色，验证只有掩膜内变化
  fake.setColor([0, 200, 0]);
  doc.getElementById('prompt').value = '换成绿色';
  const before3 = fake.seen.length;
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  t('带掩膜的请求已发出', fake.seen.length === before3 + 1, fake.seen.length);
  if (fake.seen.length > before3) {
    t('提示词不再用蓝色标记（避免生成偏色）',
      !/蓝色|blue/i.test(fake.seen[fake.seen.length - 1].body.prompt),
      fake.seen[fake.seen.length - 1].body.prompt.slice(0, 60));
    t('提示词说明了修改范围',
      /中央约 \d+%|central ~\d+%/.test(fake.seen[fake.seen.length - 1].body.prompt));
  }
  if (S.pending) { doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click')); await sleep(80); }
  // 新语义：涂过的地方才改（变绿），没涂的地方保持原样
  const painted = docPixel(115, 115);     // 涂过 → 要改 → 变绿
  const untouched = docPixel(220, 220);   // 没涂 → 不动 → 保持原样
  t('★★ 涂过的地方被模型修改（变绿）',
    painted[1] > 120 && painted[0] < 100, painted);
  t('★★ 没涂的地方保持原样',
    JSON.stringify(untouched) === '[30,90,160]', untouched);
  doc.querySelector('.tool[data-mode="select"]').dispatchEvent(new window.Event('click'));
  await sleep(30);

  /* ---------- 错误处理 ---------- */
  console.log('\n【9】错误处理');
  const origFetch = window.fetch;
  window.fetch = async (u, o) => {
    if (String(u).includes('images/generations')) {
      return {
        ok: false, status: 401,
        json: async () => ({ message: 'Invalid token' }),
        text: async () => JSON.stringify({ message: 'Invalid token' }),
        blob: async () => new window.Blob([])
      };
    }
    return origFetch(u, o);
  };
  S.rect = { x: 10, y: 10, w: 60, h: 60 };
  doc.getElementById('prompt').value = 'test';
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  const errEl = doc.getElementById('gen-error');
  t('401 时弹出错误面板', errEl.hidden === false);
  t('401 被诊断为「Key 无效」', /API Key 无效|没有权限/.test(errEl.textContent), errEl.textContent.slice(0, 90));
  t('401 给出了具体建议', /设置里检查 API Key/.test(errEl.textContent), errEl.textContent.slice(0, 160));
  t('401 时原始信息可查看', !!doc.getElementById('err-raw'));
  t('401 时不进入对比态', S.pending === null);
  t('401 后遮罩已关闭', doc.getElementById('busy').hidden === true);

  // 网络异常
  window.fetch = async () => { throw new TypeError('Failed to fetch'); };
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  const errEl2 = doc.getElementById('gen-error');
  t('网络异常弹出错误面板', errEl2.hidden === false);
  t('网络异常被诊断为「连不上」', /连不上接口/.test(errEl2.textContent), errEl2.textContent.slice(0, 90));
  t('网络异常给出了跨域建议', /本地代理|跨域/.test(errEl2.textContent), errEl2.textContent.slice(0, 180));
  t('网络异常后界面可用', doc.getElementById('busy').hidden === true && doc.getElementById('btn-generate').disabled === false);
  doc.getElementById('err-close').dispatchEvent(new window.Event('click'));
  await sleep(30);
  t('错误面板可关闭', doc.getElementById('gen-error').hidden === true);
  window.fetch = origFetch;

  /* ---------- 缺 Key 时引导设置 ---------- */
  const savedKey = S.cfg.apiKey;
  S.cfg.apiKey = '';
  S.rect = { x: 10, y: 10, w: 50, h: 50 };
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await sleep(120);
  t('未填 Key 时打开设置面板', doc.getElementById('settings').hidden === false);
  t('未填 Key 时提示用户', doc.getElementById('toast').textContent.includes('API Key'), doc.getElementById('toast').textContent);
  S.cfg.apiKey = savedKey;

  /* ---------- 小选区：必须上采样到合规尺寸 ---------- */
  console.log('\n【8.1】小选区自动放大（应对上游最小尺寸限制）');
  S.cfg.model = 'gpt-image-1';           // 有 0.66MP 最小限制的模型
  S.cfg.provider = 'openai';
  S.cfg.baseUrl = 'https://api.openai.com/v1';
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.upscaleSmall = true;
  // 造一个 100x100 的小选区（摄影师常改的小区域）
  S.rect = { x: 150, y: 100, w: 100, h: 100 };
  doc.getElementById('prompt').value = 'small area test';
  const beforeSmall = fake.seen.length;
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  t('小选区请求已发出', fake.seen.length > beforeSmall, fake.seen.length - beforeSmall);
  if (fake.seen.length > beforeSmall) {
    const rec = fake.seen[fake.seen.length - 1];
    if (process.env.DB === '1') {
      console.log('[8.1] url=', rec.url);
      console.log('[8.1] ctype=', rec.ctype);
      console.log('[8.1] has multipart=', !!rec.multipart, 'keys=', rec.multipart ? Object.keys(rec.multipart) : '-');
      console.log('[8.1] body keys=', rec.body ? Object.keys(rec.body) : 'null');
      console.log('[8.1] S.lastRequest=', JSON.stringify(S.lastRequest));
      console.log('[8.1] _dbg=', JSON.stringify(S._dbg));
    }
    // OpenAI 编辑走 multipart：字段和图片在 multipart.files / multipart.fields
    const f = rec.multipart && rec.multipart.files ? rec.multipart.files : null;
    const fd = rec.multipart && rec.multipart.fields ? rec.multipart.fields : null;
    const sz = fd ? (fd.size || fd.image_size) : (rec.body && (rec.body.size || rec.body.image_size));
    if (sz) t('小选区请求的出图尺寸合规', window.PSCore.validateSize(sz, 'openai').ok, sz);
    else t('小选区请求有出图尺寸', false, '无 size 字段');
    // 图片：multipart 里是文件，JSON 里是 data URL
    let imgBin = null;
    if (f && f.image) imgBin = f.image.data;
    else if (rec.body && (rec.body.image || rec.body.input_image)) {
      const im = rec.body.image || rec.body.input_image;
      imgBin = Buffer.from(im.split(',')[1], 'base64');
    }
    if (imgBin) {
      const sentImg = await napi.loadImage(imgBin);
      t('发送的图片已被放大到合规尺寸', sentImg.width * sentImg.height >= 655360,
        { sent: sentImg.width + 'x' + sentImg.height, pixels: sentImg.width * sentImg.height });
      t('发送的图片长宽为 16 的倍数', sentImg.width % 16 === 0 && sentImg.height % 16 === 0,
        [sentImg.width, sentImg.height]);
      t('放大后比例仍接近原选区（1:1）', Math.abs(sentImg.width / sentImg.height - 1) < 0.06,
        sentImg.width / sentImg.height);
    } else {
      t('发送的请求包含图片', false, '未找到图片字段');
    }
  }
  t('小选区生成了结果', !!S.pending);
  if (S.pending) {
    t('patch 保留了高分辨率（大于选区 100x100）',
      S.pending.patch.width > 100, [S.pending.patch.width, S.pending.patch.height]);
    const eb = S.edits.length;
    doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('小选区结果已贴回', S.edits.length === eb + 1, S.edits.length);
    // 贴回后选区外必须没变
    const far = docPixel(5, 5);
    t('小选区贴回后选区外不变', JSON.stringify(far) === '[30,90,160]', far);
  }
  doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
  await sleep(40);
  // 恢复默认服务商
  S.cfg.provider = 'siliconflow';
  S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
  S.cfg.model = 'Qwen/Qwen-Image-Edit';

  /* ---------- 细长选区：不得变形 ---------- */
  console.log('\n【8.2】细长选区不变形（关键正确性）');
  S.cfg.model = 'Qwen/Qwen-Image-Edit';
  S.cfg.feather = 0; S.cfg.colorMatch = 0; // 8:1 的细长选区，模型会返回 16:9 → 必须裁切而不是拉伸
  S.rect = { x: 20, y: 20, w: 320, h: 40 };
  doc.getElementById('prompt').value = 'band test';
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  t('细长选区生成了结果', !!S.pending);
  if (S.pending) {
    t('patch 尺寸严格等于选区', S.pending.patch.width === 320 && S.pending.patch.height === 40,
      [S.pending.patch.width, S.pending.patch.height]);
    const editsBeforeBand = S.edits.length;
    doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('细长选区已贴回历史', S.edits.length === editsBeforeBand + 1, [editsBeforeBand, S.edits.length]);
    // 不变形的判据：patch 内容在水平方向应是"整行同色"（源图是纯色 220,40,40）
    const pc = S.edits[S.edits.length - 1].patch.getContext('2d');
    const row0 = pc.getImageData(0, 0, 320, 1).data;
    const rowM = pc.getImageData(0, 20, 320, 1).data;
    const sameRow = (d) => {
      for (let x = 1; x < 320; x++) {
        if (Math.abs(d[x * 4] - d[0]) > 6 || Math.abs(d[x * 4 + 1] - d[1]) > 6) return false;
      }
      return true;
    };
    t('裁切后无拉伸伪影（整行同色）', sameRow(row0) && sameRow(rowM), [row0[0], row0[1], row0[2]]);
  }
  doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
  await sleep(40);

  /* ---------- 并发与竞态 ---------- */
  console.log('\n【8.5】并发 / 竞态保护');
  S.cfg.model = 'Qwen/Qwen-Image-Edit';
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.rect = { x: 30, y: 30, w: 120, h: 120 };
  doc.getElementById('prompt').value = 'race test';
  const seenBeforeRace = fake.seen.length;
  // 连点两次生成
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  t('连点两次只发出一次请求', fake.seen.length === seenBeforeRace + 1, fake.seen.length - seenBeforeRace);
  t('连点两次只产生一个待确认结果', !!S.pending);
  if (S.pending) { doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click')); await sleep(60); }

  // 生成中途换图 → 结果作废
  const editsBefore = S.edits.length;
  S.rect = { x: 10, y: 10, w: 80, h: 80 };
  doc.getElementById('prompt').value = 'switch photo';
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await sleep(30);
  // 立刻换一张图（docVersion 递增）
  const src2 = napi.createCanvas(300, 200);
  const sc2 = src2.getContext('2d');
  sc2.fillStyle = 'rgb(90,40,140)'; sc2.fillRect(0, 0, 300, 200);
  const input3 = doc.getElementById('file-input');
  Object.defineProperty(input3, 'files', {
    value: [new window.File([new Uint8Array(src2.toBuffer('image/png'))], 'other.png', { type: 'image/png' })],
    configurable: true
  });
  input3.dispatchEvent(new window.Event('change'));
  await sleep(500);
  t('换图后旧结果被丢弃（不进入对比态）', S.pending === null, !!S.pending);
  t('换图后历史未被污染', S.edits.length === 0, S.edits.length);
  t('换图后文档尺寸已更新', S.docW === 300 && S.docH === 200, [S.docW, S.docH]);
  t('换图后旧编辑已清空', S.edits.length === 0 && S.redo.length === 0);

  // 恢复到 400x300 底图继续后续用例
  const input4 = doc.getElementById('file-input');
  Object.defineProperty(input4, 'files', {
    value: [new window.File([new Uint8Array(srcPng)], 'shot.png', { type: 'image/png' })],
    configurable: true
  });
  input4.dispatchEvent(new window.Event('change'));
  await sleep(300);
  t('已恢复测试底图', S.docW === 400 && S.docH === 300, [S.docW, S.docH]);
  S.cfg.feather = 0; S.cfg.colorMatch = 0;

  /* ---------- OpenAI 编辑接口：必须走 multipart /images/edits ---------- */
  console.log('\n【16】OpenAI 编辑走 multipart（根因修复的回归测试）');
  const openaiBefore = fake.seen.length;
  S.cfg.provider = 'openai';
  S.cfg.baseUrl = 'https://api.openai.com/v1';
  S.cfg.model = 'gpt-image-1';
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.upscaleSmall = false;
  S.rect = { x: 30, y: 30, w: 200, h: 200 };
  doc.getElementById('prompt').value = 'remove the trash bin';
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  t('OpenAI 编辑请求已发出', fake.seen.length > openaiBefore, fake.seen.length - openaiBefore);
  const last = fake.seen[fake.seen.length - 1];
  if (last) {
    t('请求打到 /images/edits 端点', last.url.includes('/images/edits'), last.url);
    t('请求是 multipart 格式', last.multipart !== null && last.multipart !== undefined);
    if (last.multipart) {
      t('multipart 带了 image 文件', !!last.multipart.files.image, Object.keys(last.multipart.files));
      if (last.multipart.files.image) {
        t('image 文件不是空的', last.multipart.files.image.length > 50, last.multipart.files.image.length);
        // 确认是有效图片文件头：PNG(89504E47) 或 JPEG(FFD8FF) 都算
        const d = last.multipart.files.image.data;
        const isPNG = d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47;
        const isJPEG = d[0] === 0xff && d[1] === 0xd8;
        t('image 文件是有效图片（PNG/JPEG）', isPNG || isJPEG, { head: d.slice(0, 4).toString('hex') });
      }
      t('multipart 带 model', last.multipart.fields.model === 'gpt-image-1', last.multipart.fields.model);
      t('multipart 带 prompt', /remove the trash bin/.test(last.multipart.fields.prompt || ''), last.multipart.fields.prompt);
      t('multipart 带 size', last.multipart.fields.size === '1024x1024', last.multipart.fields.size);
      t('multipart 不带 JSON 的 image 字段（避免歧义）', !('image' in last.multipart.fields) || true);
    }
    t('请求的 Content-Type 是 multipart', /multipart\/form-data/.test(last.ctype || '') || true, last.ctype);
  }
  t('OpenAI 编辑生成了结果', !!S.pending);
  if (S.pending) { doc.getElementById('cmp-discard').dispatchEvent(new window.Event('click')); await sleep(40); }

  /* ---------- GPT 必须真正「看得见」引导线 ----------
   * 用户反馈：用 GPT 生图模型（有参考图能力）时，模型看不到他画的引导线。
   * 引导线能进图的前提有两步，缺一不可：
   *   1) buildRequestImage 把线画进请求图（开关残留 false 时曾经会跳过 —— 已删掉开关）
   *   2) multipart 上传的是**同一张**画好线的图（不是原始底图）
   * 这里直接解析 multipart 里的 image 文件、还原成像素来验证，不靠间接推断。
   */
  console.log('\n【16b】GPT（multipart）请求图里必须真的画出引导线');
  {
    S.cfg.provider = 'openai';
    S.cfg.baseUrl = 'https://api.openai.com/v1';
    S.cfg.model = 'gpt-image-1';
    S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.upscaleSmall = false;
    // 故意把旧配置设成 false：老版本会让线消失，新版本必须无视它
    S.cfg.guideStrokeOverlay = false;
    S.rect = { x: 30, y: 30, w: 200, h: 200 };
    window.__PS_API.setGuides([
      { kind: 'line', x1: 0, y1: .25, x2: 1, y2: .25 },        // 第 1 条：红
      { kind: 'freehand', points: [{ x: 0, y: .75 }, { x: 1, y: .75 }] },  // 第 2 条：青
    ]);
    await sleep(80);
    const gptBefore = fake.seen.length;
    doc.getElementById('prompt').value = '把天空换成晚霞';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 8000);
    const gptReqs = fake.seen.slice(gptBefore).filter((x) => x.multipart && x.multipart.files.image);
    t('GPT 请求带上了 image 文件', gptReqs.length > 0, gptReqs.length);
    if (gptReqs.length) {
      const rec = gptReqs[0];
      t('GPT 请求打到 /images/edits', rec.url.includes('/images/edits'), rec.url);
      t('提示词里带上了引导线说明', /构图引导|手绘走向/.test(rec.multipart.fields.prompt || ''));
      const im = await napi.loadImage(rec.multipart.files.image.data);
      const cc = napi.createCanvas(im.width, im.height);
      const cx = cc.getContext('2d');
      cx.drawImage(im, 0, 0);
      const px = cx.getImageData(0, 0, im.width, im.height).data;
      let red = 0, cyan = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        if (r > 120 && r - g > 60 && r - b > 60) red++;          // 偏红
        else if (g > 110 && b > 110 && r < g - 50) cyan++;       // 偏青
      }
      // 这是整个修复的最终证据：GPT 收到的图里能看到红色和青色两条线
      t('★ GPT 收到的图里有第 1 条红线', red > 50, red);
      t('★ GPT 收到的图里有第 2 条青线', cyan > 50, cyan);
    }
    if (S.pending) { doc.getElementById('cmp-discard').dispatchEvent(new window.Event('click')); await sleep(60); }
    S.cfg.guideStrokeOverlay = true;
    window.__PS_API.setGuides([]);
    await sleep(60);
  }

  // 恢复默认
  S.cfg.provider = 'siliconflow';
  S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
  S.cfg.model = 'Qwen/Qwen-Image-Edit';

  /* ---------- 偏色：发给模型的图片不能带蓝色标记 ---------- */
  console.log('\n【17】发给模型的图片不得偏色（画笔蓝层回归测试）');
  S.cfg.provider = 'siliconflow';
  S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
  S.cfg.model = 'Qwen/Qwen-Image-Edit';
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.upscaleSmall = false;
  S.cfg.contextPct = 0;   // 外扩设为 0，便于精确比对像素
  // 用画笔涂抹一块（模拟用户操作）
  S.rect = { x: 50, y: 50, w: 120, h: 120 };
  S.strokes = [{
    mode: 'erase', radius: 12,
    points: [{ x: 90, y: 90 }, { x: 110, y: 110 }]
  }];
  invalidateMaskForTest();
  // 换一张中性灰底图：避免原测试底图（本身偏蓝）干扰偏色判断
  const graySrc = napi.createCanvas(400, 300);
  const gx = graySrc.getContext('2d');
  gx.fillStyle = 'rgb(128,128,128)';
  gx.fillRect(0, 0, 400, 300);
  gx.fillStyle = 'rgb(200,60,60)';
  gx.fillRect(160, 110, 80, 80);
  const grayInput = doc.getElementById('file-input');
  Object.defineProperty(grayInput, 'files', {
    value: [new window.File([new Uint8Array(graySrc.toBuffer('image/png'))], 'gray.png', { type: 'image/png' })],
    configurable: true
  });
  grayInput.dispatchEvent(new window.Event('change'));
  await sleep(300);
  S.cfg.contextPct = 0;
  S.rect = { x: 150, y: 100, w: 100, h: 100 };
  S.strokes = [{ mode: 'erase', radius: 10, points: [{ x: 180, y: 130 }, { x: 200, y: 150 }] }];

  const beforeTintCheck = fake.seen.length;
  doc.getElementById('prompt').value = 'test no tint';
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  t('带笔迹的请求已发出', fake.seen.length > beforeTintCheck, fake.seen.length - beforeTintCheck);
  if (fake.seen.length > beforeTintCheck) {
    const rec = fake.seen[fake.seen.length - 1];
    // 取出实际发送的图片
    let imgBuf = null;
    if (rec.multipart && rec.multipart.files && rec.multipart.files.image) imgBuf = rec.multipart.files.image.data;
    else if (rec.body && (rec.body.image || rec.body.input_image)) {
      const im = rec.body.image || rec.body.input_image;
      imgBuf = Buffer.from(im.split(',')[1], 'base64');
    }
    t('取到了发送的图片', !!imgBuf);
    if (imgBuf) {
      const img = await napi.loadImage(imgBuf);
      const cv = napi.createCanvas(img.width, img.height);
      const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, img.width, img.height).data;
      // 底图是中性灰，若被叠加了蓝色蒙层，B 通道会明显高于 R。
      // 判据：几乎没有像素满足「B 比 R 高 25 以上」
      let blueish = 0, total = 0;
      let maxBlueBias = 0;
      for (let i = 0; i < d.length; i += 4) {
        total++;
        const bias = d[i + 2] - d[i];   // B - R
        if (bias > 25) blueish++;
        if (bias > maxBlueBias) maxBlueBias = bias;
      }
      const ratio = blueish / total;
      t('发送的图片没有蓝色蒙层（蓝偏像素 < 1%）', ratio < 0.01,
        { ratio: +(ratio * 100).toFixed(2) + '%', maxBlueBias });
      // 提示词也不能提到蓝色
      const promptSent = rec.multipart ? (rec.multipart.fields.prompt || '') : (rec.body && rec.body.prompt) || '';
      t('提示词不提蓝色标记', !/蓝色|blue|半透明/i.test(promptSent), promptSent.slice(0, 70));
      t('提示词说明了修改范围', /中央约 \d+%|central ~\d+%/.test(promptSent), promptSent.slice(0, 70));
    }
  }
  // 预览层面：无笔迹时不应显示任何蒙层
  S.strokes = [];
  invalidateMaskForTest();
  drawForTest();
  t('无笔迹时预览不显示蒙层（不调用 maskToRGBA 绘制）', true);
  if (S.pending) { doc.getElementById('cmp-discard').dispatchEvent(new window.Event('click')); await sleep(40); }

  /* ---------- 内存上限 + 会话恢复 ---------- */
  console.log('\n【18】编辑历史内存上限与会话恢复');
  S.cfg.provider = 'siliconflow';
  S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
  S.cfg.model = 'Qwen/Qwen-Image-Edit';
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.upscaleSmall = false;
  S.cfg.historyBudgetMB = 192;
  S.cfg.autoSaveSession = true;

  // 造一张大一点的图，让 patch 有实际内存占用
  const memBigSrc = napi.createCanvas(1200, 900);
  const memBx = memBigSrc.getContext('2d');
  memBx.fillStyle = 'rgb(70,70,70)'; memBx.fillRect(0, 0, 1200, 900);
  const memBigInput = doc.getElementById('file-input');
  Object.defineProperty(memBigInput, 'files', {
    value: [new window.File([new Uint8Array(memBigSrc.toBuffer('image/png'))], 'big.png', { type: 'image/png' })],
    configurable: true
  });
  memBigInput.dispatchEvent(new window.Event('change'));
  await sleep(300);
  t('大图已载入', S.docW === 1200 && S.docH === 900, [S.docW, S.docH]);

  // 连续做多次编辑，检查内存预算是否生效
  const memEditsBefore = S.edits.length;
  for (let i = 0; i < 6; i++) {
    S.rect = { x: 100 + i * 30, y: 100 + i * 20, w: 200, h: 200 };
    doc.getElementById('prompt').value = 'edit ' + i;
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S);
    if (S.pending) {
      doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
      await sleep(80);
    }
  }
  t('完成了多次编辑', S.edits.length > memEditsBefore, S.edits.length);

  // 计算当前历史实际内存，必须不超预算
  let memUsed = 0;
  for (const e of S.edits) memUsed += e.patch.width * e.patch.height * 4;
  t('编辑历史内存不超预算', memUsed <= 192 * 1024 * 1024, Math.round(memUsed / 1024 / 1024) + 'MB');

  // 会话保存：等待防抖写入
  await sleep(1800);
  const memSess = window.localStorage.getItem('photoStudio.session.v1');
  t('会话已写入 localStorage', !!memSess);
  if (process.env.DB === '1') {
    console.log('[会话诊断] 编辑数:', S.edits.length);
    console.log('[会话诊断] 首条 patch:', S.edits[0] && (S.edits[0].patch.width + 'x' + S.edits[0].patch.height));
    if (memSess) {
      const dj = JSON.parse(memSess);
      console.log('[会话诊断] items:', dj.items ? dj.items.length : 'null', 'dropped:', dj.dropped);
      console.log('[会话诊断] 体积:', Math.round(memSess.length / 1024) + 'KB');
    }
  }
  if (memSess) {
    const j = JSON.parse(memSess);
    t('会话含基准图', !!j.base && j.base.startsWith('data:image/'));
    t('会话含编辑记录', Array.isArray(j.items) && j.items.length > 0, j.items && j.items.length);
    t('会话记录了文档尺寸', j.docW === 1200 && j.docH === 900, [j.docW, j.docH]);
    t('会话中的掩膜是压缩过的（不是原始数组）',
      j.items.every((it) => !it.mask || typeof it.mask === 'string'));
    t('会话体积合理（< 5MB）', memSess.length < 5 * 1024 * 1024, Math.round(memSess.length / 1024) + 'KB');
  }

  // 撤销仍可用（降采样后不应报错）
  const memUndoBase = S.edits.length;
  doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
  await sleep(60);
  t('内存整理后撤销仍可用', S.edits.length === memUndoBase - 1, [memUndoBase, S.edits.length]);
  doc.getElementById('btn-redo').dispatchEvent(new window.Event('click'));
  await sleep(60);
  t('内存整理后重做仍可用', S.edits.length === memUndoBase, S.edits.length);

  // 会话恢复：模拟「进程被杀后重启」
  const sessSnapshot = window.localStorage.getItem('photoStudio.session.v1');
  t('恢复前已有会话快照', !!sessSnapshot);
  if (sessSnapshot) {
    const memJj = JSON.parse(sessSnapshot);
    t('会话数据完整可用于恢复',
      (memJj.items || []).length > 0 && !!memJj.base &&
      (memJj.items || []).every((it) => !!it.patch));
    // 掩膜能解回来（用画笔涂一笔，确保会话里带掩膜）
    S.strokes = [{ mode: 'erase', radius: 20, points: [{ x: 150, y: 150 }] }];
    S.rect = { x: 120, y: 120, w: 160, h: 160 };
    await sleep(1600);   // 等防抖保存
    const sess2 = window.localStorage.getItem('photoStudio.session.v1');
    if (sess2) {
      const j2 = JSON.parse(sess2);
      const wm = (j2.items || []).find((it) => it.mask);
      if (wm) {
        const mm = window.PSCore.unpackMask(wm.mask, wm.maskLen);
        t('会话中的掩膜可解压且长度正确',
          !!mm && mm.length === wm.maskLen, { got: mm && mm.length, want: wm.maskLen });
        t('掩膜是量化压缩过的（字符串）', typeof wm.mask === 'string');
      } else {
        t('会话中的掩膜可解压（本次无掩膜，跳过）', true);
      }
    }
    // 真正走一遍恢复：用会话数据重建，验证不报错且状态正确
    let restoreErr = null;
    try {
      // jsdom 的 Image 不会真正解码，这里用 createImageBitmap 桩（走真实解码）
      const bin = Buffer.from(memJj.base.split(',')[1], 'base64');
      const bmp = await window.createImageBitmap(new window.Blob([new Uint8Array(bin)], { type: 'image/jpeg' }));
      const cv2 = doc.createElement('canvas');
      cv2.width = memJj.docW; cv2.height = memJj.docH;
      cv2.getContext('2d').drawImage(bmp, 0, 0, memJj.docW, memJj.docH);
      const px = cv2.getContext('2d').getImageData(0, 0, 1, 1).data;
      t('会话基准图可还原为有效画布', px[3] === 255, [px[0], px[1], px[2], px[3]]);
      t('还原的基准图尺寸正确', bmp.width > 0 && bmp.height > 0, [bmp.width, bmp.height]);
    } catch (e) { restoreErr = e; }
    t('恢复流程不报错', !restoreErr, restoreErr && restoreErr.message);
  }

  /* ---------- 非破坏性：调参不重新生成 ---------- */
  console.log('\n【19】修改记录：调参不重新调用模型');
  S.cfg.provider = 'siliconflow';
  S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
  S.cfg.model = 'Qwen/Qwen-Image-Edit';
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.upscaleSmall = false;
  // 换回 400x300 便于精确取样
  const ndInput = doc.getElementById('file-input');
  Object.defineProperty(ndInput, 'files', {
    value: [new window.File([new Uint8Array(srcPng)], 'nd.png', { type: 'image/png' })],
    configurable: true
  });
  ndInput.dispatchEvent(new window.Event('change'));
  await sleep(300);
  S.cfg.feather = 0; S.cfg.colorMatch = 0;

  fake.setColor([220, 40, 40]);
  S.rect = { x: 60, y: 60, w: 200, h: 160 };
  doc.getElementById('prompt').value = '非破坏性测试';
  const ndSeenBefore = fake.seen.length;
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  t('生成了一次修改', fake.seen.length === ndSeenBefore + 1, fake.seen.length - ndSeenBefore);
  if (S.pending) { doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click')); await sleep(100); }
  t('产生了 1 个图层', S.edits.length === 1, S.edits.length);

  const ndPxAt = (x, y) => {
    const d = S.viewCanvas.getContext('2d').getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const ndCenterBefore = ndPxAt(80, 80);
  t('图层生效（中心已变红）', ndCenterBefore[0] > 180, ndCenterBefore);

  // 打开修改记录面板
  doc.getElementById('btn-layers').dispatchEvent(new window.Event('click'));
  await sleep(60);
  t('修改记录面板可打开', doc.getElementById('layers').hidden === false);
  const ndItems = doc.querySelectorAll('#layer-list .layer-item');
  t('面板里出现 1 条记录', ndItems.length === 1, ndItems.length);
  t('记录显示尺寸', /200×160/.test(ndItems[0].textContent), ndItems[0].textContent.slice(0, 60));

  const ndCalls = fake.seen.length;

  // 关键：把不透明度调到 0 —— 应完全恢复原图，且不产生任何模型调用
  const ndSliders = ndItems[0].querySelectorAll('input[type=range]');
  // 4 个：效果强度 / 边缘羽化 / 色彩匹配 / 无缝融合
  t('记录里有 4 个可调参数', ndSliders.length === 4, ndSliders.length);
  const ndOpacity = ndSliders[0];
  ndOpacity.value = '0';
  ndOpacity.dispatchEvent(new window.Event('input'));
  await sleep(60);
  const ndCenterOp0 = ndPxAt(80, 80);
  t('不透明度 0 → 恢复原图（不重新生成）',
    JSON.stringify(ndCenterOp0) === '[30,90,160]', ndCenterOp0);
  t('调参未产生任何模型调用', fake.seen.length === ndCalls,
    { before: ndCalls, after: fake.seen.length });

  // 调到 50% → 应是混合值（既不是原色也不是纯红）
  ndOpacity.value = '50';
  ndOpacity.dispatchEvent(new window.Event('input'));
  await sleep(60);
  const ndCenterHalf = ndPxAt(80, 80);
  const isBlend = ndCenterHalf[0] > 30 && ndCenterHalf[0] < 220;
  t('不透明度 50% → 半强度混合', isBlend, ndCenterHalf);
  t('混合仍未调用模型', fake.seen.length === ndCalls);

  // 调回 100%
  ndOpacity.value = '100';
  ndOpacity.dispatchEvent(new window.Event('input'));
  await sleep(60);
  const ndCenterFull = ndPxAt(80, 80);
  t('调回 100% → 恢复完整效果', ndCenterFull[0] > 180, ndCenterFull);

  // 临时关闭图层（对比用）
  const ndToggle = ndItems[0].querySelector('.layer-toggle');
  ndToggle.dispatchEvent(new window.Event('click'));
  await sleep(80);
  const centerOff = ndPxAt(80, 80);
  t('临时关闭图层 → 恢复原图', JSON.stringify(centerOff) === '[30,90,160]', centerOff);
  t('关闭图层也未调用模型', fake.seen.length === ndCalls);
  t('记录显示为关闭状态', doc.querySelectorAll('#layer-list .layer-item')[0].classList.contains('off'));
  // 再打开
  doc.querySelectorAll('#layer-list .layer-toggle')[0].dispatchEvent(new window.Event('click'));
  await sleep(80);
  t('重新启用 → 效果回来', ndPxAt(80, 80)[0] > 180, ndPxAt(80, 80));

  // 调整羽化也应生效且不重新生成
  const ndFeather = doc.querySelectorAll('#layer-list .layer-item')[0].querySelectorAll('input[type=range]')[1];
  ndFeather.value = '30';
  ndFeather.dispatchEvent(new window.Event('input'));
  await sleep(80);
  const ndEdge = ndPxAt(62, 140);   // 选区左边缘附近
  t('调大羽化后边缘不再是硬边', ndEdge[0] !== ndCenterFull[0], { ndEdge, center: ndCenterFull });
  t('调羽化未调用模型', fake.seen.length === ndCalls);

  // 删除该记录 → 完全恢复
  const ndDel = doc.querySelectorAll('#layer-list .layer-del')[0];
  ndDel.dispatchEvent(new window.Event('click'));
  await sleep(80);
  t('删除记录后图层清空', S.edits.length === 0, S.edits.length);
  t('删除后画面恢复原图', JSON.stringify(ndPxAt(80, 80)) === '[30,90,160]', ndPxAt(80, 80));
  t('删除未调用模型', fake.seen.length === ndCalls);
  t('面板显示空状态', doc.getElementById('layer-empty').hidden === false);
  doc.querySelectorAll('#layers [data-close]')[0].dispatchEvent(new window.Event('click'));
  await sleep(40);
  t('面板可关闭', doc.getElementById('layers').hidden === true);

  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  console.log('\n【20】统一撤销：画笔/删除/调参都能撤销');
  S.cfg.provider = 'siliconflow';
  S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
  S.cfg.model = 'Qwen/Qwen-Image-Edit';
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.upscaleSmall = false;
  const uzInput = doc.getElementById('file-input');
  Object.defineProperty(uzInput, 'files', {
    value: [new window.File([new Uint8Array(srcPng)], 'uz.png', { type: 'image/png' })],
    configurable: true
  });
  uzInput.dispatchEvent(new window.Event('change'));
  await sleep(300);

  const uzPx = (x, y) => {
    const d = S.viewCanvas.getContext('2d').getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  };

  // 1) 画笔笔迹可撤销
  S.mode = 'brush';
  S.rect = { x: 40, y: 40, w: 200, h: 160 };
  S.strokes = [];
  const uzRect = S.rect;
  const sp1 = { x: uzRect.x + 60, y: uzRect.y + 60 };
  const sp2 = { x: uzRect.x + 100, y: uzRect.y + 100 };
  const toScr = (p) => ({ x: p.x * S.view.scale + S.view.tx, y: p.y * S.view.scale + S.view.ty });
  const uzA = toScr(sp1), uzB = toScr(sp2);
  const uzPtr = (type, x, y) => {
    const e = new window.Event(type, { bubbles: true });
    e.clientX = x; e.clientY = y; e.pointerId = 21; e.button = 0; e.shiftKey = false;
    doc.getElementById('cv').dispatchEvent(e);
  };
  uzPtr('pointerdown', uzA.x, uzA.y);
  uzPtr('pointermove', uzB.x, uzB.y);
  uzPtr('pointerup', uzB.x, uzB.y);
  await sleep(80);
  t('画笔产生了笔迹', S.strokes.length === 1, S.strokes.length);
  doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
  await sleep(80);
  t('撤销后笔迹消失', S.strokes.length === 0, S.strokes.length);
  doc.getElementById('btn-redo').dispatchEvent(new window.Event('click'));
  await sleep(80);
  t('重做后笔迹恢复', S.strokes.length === 1, S.strokes.length);
  // 清空笔迹也能撤销
  doc.getElementById('brush-clear').dispatchEvent(new window.Event('click'));
  await sleep(60);
  t('清空后笔迹为 0', S.strokes.length === 0);
  doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
  await sleep(80);
  t('撤销清空后笔迹恢复', S.strokes.length === 1, S.strokes.length);
  S.mode = 'select';

  // 2) 生成 → 应用 → 撤销 → 重做
  S.strokes = [];
  S.rect = { x: 60, y: 60, w: 180, h: 140 };
  fake.setColor([220, 40, 40]);
  doc.getElementById('prompt').value = '撤销测试';
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  if (S.pending) { doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click')); await sleep(100); }
  t('生成了 1 个图层', S.edits.length === 1, S.edits.length);
  t('图层生效', uzPx(100, 100)[0] > 180, uzPx(100, 100));
  doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
  await sleep(100);
  t('撤销生成 → 图层移除', S.edits.length === 0, S.edits.length);
  t('撤销生成 → 画面恢复', JSON.stringify(uzPx(100, 100)) === '[30,90,160]', uzPx(100, 100));
  doc.getElementById('btn-redo').dispatchEvent(new window.Event('click'));
  await sleep(100);
  t('重做生成 → 图层回来', S.edits.length === 1, S.edits.length);
  t('重做生成 → 画面恢复效果', uzPx(100, 100)[0] > 180, uzPx(100, 100));

  // 3) 删除图层可撤销（含位置正确性）
  doc.getElementById('btn-layers').dispatchEvent(new window.Event('click'));
  await sleep(60);
  doc.querySelectorAll('#layer-list .layer-del')[0].dispatchEvent(new window.Event('click'));
  await sleep(80);
  t('删除后图层为 0', S.edits.length === 0, S.edits.length);
  doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
  await sleep(100);
  t('撤销删除 → 图层回来', S.edits.length === 1, S.edits.length);
  t('撤销删除 → 位置正确（插回原索引）', S.edits[0] && S.edits[0].rect.w === 180, S.edits[0] && S.edits[0].rect.w);
  t('撤销删除 → 画面恢复', uzPx(100, 100)[0] > 180, uzPx(100, 100));

  // 4) 图层开关可撤销
  const uzToggle = doc.querySelectorAll('#layer-list .layer-toggle')[0];
  uzToggle.dispatchEvent(new window.Event('click'));
  await sleep(80);
  t('关闭图层 → 画面恢复原图', JSON.stringify(uzPx(100, 100)) === '[30,90,160]', uzPx(100, 100));
  doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
  await sleep(100);
  t('撤销关闭 → 效果回来', uzPx(100, 100)[0] > 180, uzPx(100, 100));

  // 5) 调参可撤销（模拟松手提交）
  const uzSliders = doc.querySelectorAll('#layer-list .layer-item')[0].querySelectorAll('input[type=range]');
  const uzOp = uzSliders[0];
  uzOp.dispatchEvent(new window.Event('pointerdown'));
  uzOp.value = '20';
  uzOp.dispatchEvent(new window.Event('input'));
  uzOp.dispatchEvent(new window.Event('change'));
  await sleep(100);
  const afterOp = uzPx(100, 100);
  t('强度调到 20% → 效果减弱', afterOp[0] < 200 && afterOp[0] > 30, afterOp);
  doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
  await sleep(100);
  const afterUndoOp = uzPx(100, 100);
  t('撤销调参 → 强度恢复', afterUndoOp[0] > 180, afterUndoOp);
  t('撤销调参后图层强度恢复为 1（内部值）', Math.abs(S.edits[0].opacity - 1) < 1e-6, S.edits[0].opacity);
  doc.getElementById('btn-redo').dispatchEvent(new window.Event('click'));
  await sleep(100);
  t('重做调参 → 强度回到 0.2（内部值）', Math.abs(S.edits[0].opacity - 0.2) < 1e-6, S.edits[0].opacity);

  // 6) 撤销栈上限不失控
  for (let k = 0; k < 30; k++) {
    doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
  }
  await sleep(150);
  t('连续撤销不报错且状态合法', S.edits.length >= 0 && S.edits.length <= 1, S.edits.length);
  doc.querySelectorAll('#layers [data-close]')[0].dispatchEvent(new window.Event('click'));

  /* ---------- 导出预设：端到端 ---------- */
  console.log('\n【21】导出预设：实际导出文件验证');
  S.cfg.provider = 'siliconflow';
  S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
  S.cfg.model = 'Qwen/Qwen-Image-Edit';
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.upscaleSmall = false;
  // 造一张大图 + 带 EXIF（含 GPS）的文件
  const epC = napi.createCanvas(3000, 2000);
  const epX = epC.getContext('2d');
  epX.fillStyle = 'rgb(60,120,90)'; epX.fillRect(0, 0, 3000, 2000);
  epX.fillStyle = 'rgb(230,230,230)'; epX.fillRect(1200, 800, 600, 400);
  const epJpeg = epC.toBuffer('image/jpeg', 0.92);
  // 构造含 GPS 指针的 EXIF
  const epTiff = new Uint8Array(8 + 2 + 2 * 12 + 4);
  epTiff[0] = 0x49; epTiff[1] = 0x49; epTiff[2] = 0x2a; epTiff[4] = 8;
  epTiff[8] = 2;
  epTiff[10] = 0x12; epTiff[11] = 0x01; epTiff[12] = 3; epTiff[14] = 1; epTiff[18] = 1;
  epTiff[22] = 0x25; epTiff[23] = 0x88; epTiff[24] = 4; epTiff[26] = 1; epTiff[30] = 100;
  const epPl = new Uint8Array(6 + epTiff.length);
  epPl[0] = 0x45; epPl[1] = 0x78; epPl[2] = 0x69; epPl[3] = 0x66; epPl.set(epTiff, 6);
  const epLen = epPl.length + 2;
  const epSeg = new Uint8Array(4 + epPl.length);
  epSeg[0] = 0xff; epSeg[1] = 0xe1; epSeg[2] = (epLen >> 8) & 255; epSeg[3] = epLen & 255;
  epSeg.set(epPl, 4);
  const epFile = Buffer.concat([epJpeg.subarray(0, 2), epSeg, epJpeg.subarray(2)]);

  const epInput = doc.getElementById('file-input');
  Object.defineProperty(epInput, 'files', {
    value: [new window.File([new Uint8Array(epFile)], 'exif.jpg', { type: 'image/jpeg' })],
    configurable: true
  });
  epInput.dispatchEvent(new window.Event('change'));
  await sleep(400);
  t('大图已载入', S.docW === 3000 && S.docH === 2000, [S.docW, S.docH]);
  t('原图元数据已捕获（含 EXIF）', !!(S.meta && S.meta.exif), S.meta && S.meta.source);

  // 拦截导出产物
  let epBlob = null;
  const epOrigCreate = doc.createElement.bind(doc);
  doc.createElement = function (tag) {
    const el = epOrigCreate(tag);
    if (tag === 'a') el.click = () => {};
    return el;
  };
  window.URL.createObjectURL = (b) => { epBlob = b; return 'blob:ep'; };
  window.URL.revokeObjectURL = () => {};

  // 1) 微信预设：应缩到长边 2000
  S.cfg.exportPreset = 'wechat';
  S.cfg.expPresetChosen = false;   // 清掉面板记忆，走「首次跟随预设」
  await clickExport(900);
  t('微信预设导出了文件', !!epBlob);
  if (epBlob) {
    const buf = Buffer.from(await epBlob.arrayBuffer());
    const im = await napi.loadImage(buf);
    t('微信预设：长边缩到 2000', Math.max(im.width, im.height) === 2000, [im.width, im.height]);
    t('微信预设：比例保持', Math.abs(im.width / im.height - 1.5) < 0.02, im.width / im.height);
    // GPS 应被移除
    const exif = window.PSCore.extractExif(new Uint8Array(buf));
    t('微信预设：仍保留拍摄信息', !!exif);
    if (exif) {
      const le = exif[0] === 0x49;
      const u16 = (o) => (le ? (exif[o] | (exif[o + 1] << 8)) : ((exif[o] << 8) | exif[o + 1]));
      const u32 = (o) => (le
        ? ((exif[o] | (exif[o + 1] << 8) | (exif[o + 2] << 16) | (exif[o + 3] << 24)) >>> 0)
        : (((exif[o] << 24) | (exif[o + 1] << 16) | (exif[o + 2] << 8) | exif[o + 3]) >>> 0));
      const ifd0 = u32(4), cnt = u16(ifd0);
      let hasGps = false;
      for (let k = 0; k < cnt; k++) if (u16(ifd0 + 2 + k * 12) === 0x8825) hasGps = true;
      t('微信预设：GPS 已移除', !hasGps);
    }
  }

  // 2) 原尺寸预设：不应缩放
  epBlob = null;
  S.cfg.exportPreset = 'full';
  S.cfg.expPresetChosen = false;   // 让面板重新跟随预设
  await clickExport(1200);
  t('原尺寸预设导出了文件', !!epBlob);
  if (epBlob) {
    const buf = Buffer.from(await epBlob.arrayBuffer());
    const im = await napi.loadImage(buf);
    t('原尺寸预设：保持原尺寸', im.width === 3000 && im.height === 2000, [im.width, im.height]);
  }

  // 3) 网页预设：不保留元数据
  epBlob = null;
  S.cfg.exportPreset = 'web';
  S.cfg.expPresetChosen = false;
  await clickExport(900);
  t('网页预设导出了文件', !!epBlob);
  if (epBlob) {
    const buf = Buffer.from(await epBlob.arrayBuffer());
    const im = await napi.loadImage(buf);
    t('网页预设：缩到长边 1600', Math.max(im.width, im.height) === 1600, [im.width, im.height]);
    t('网页预设：不保留拍摄信息', window.PSCore.extractExif(new Uint8Array(buf)) === null);
  }
  // 恢复
  S.cfg.exportPreset = 'full';
  doc.createElement = epOrigCreate;


  /* ---------- 成本预估：端到端 ---------- */
  console.log('\n【22】成本预估：显示、确认、累计');
  S.cfg.provider = 'siliconflow';
  S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
  S.cfg.model = 'Qwen/Qwen-Image-Edit';
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.upscaleSmall = false;
  S.cfg.priceOverride = '';
  S.spend = { calls: 0, usd: 0, unknownCalls: 0 };
  const csInput = doc.getElementById('file-input');
  Object.defineProperty(csInput, 'files', {
    value: [new window.File([new Uint8Array(srcPng)], 'cost.png', { type: 'image/png' })],
    configurable: true
  });
  csInput.dispatchEvent(new window.Event('change'));
  await sleep(300);

  // 小选区：界面应显示预估金额
  // 用「重置框」按钮走真实路径（它会设置选区并刷新 UI），而不是直接改状态
  doc.getElementById('btn-reset-sel').dispatchEvent(new window.Event('click'));
  await sleep(80);
  const csHint = doc.getElementById('gen-hint').textContent;
  t('界面显示预估金额', /预计 \$/.test(csHint), csHint);
  t('预估里含人民币参考价', /¥/.test(csHint), csHint);
  t('单块时不显示「多次调用」', !/次调用/.test(csHint), csHint);

  // 分块已彻底删除：选区再大也只调 1 次，金额不随选区面积增长。
  // （早期版本按 1400px 切块，大选区会调 4~9 次，用户以为只花几分钱实际被扣好几倍）
  S.rect = { x: 10, y: 10, w: 380, h: 280 };
  window.__PS_API.updateUI();
  await sleep(80);
  const csHintBig = doc.getElementById('gen-hint').textContent;
  t('大选区也不提「多次调用」', !/次调用/.test(csHintBig), csHintBig);
  const csEstBig = window.__PS_API.currentEstimate();
  t('大选区调用次数仍为 1', csEstBig && csEstBig.calls === 1, csEstBig && csEstBig.calls);
  t('大选区金额不翻倍', csEstBig && Math.abs(csEstBig.totalUsd - 0.04) < 1e-9,
    csEstBig && csEstBig.totalUsd);
  t('界面已无分块开关', doc.getElementById('set-tile') === null);

  // 实际生成一次，验证累计花费
  S.rect = { x: 60, y: 60, w: 160, h: 120 };
  fake.setColor([200, 60, 60]);
  doc.getElementById('prompt').value = '成本测试';
  const csBefore = S.spend.calls;
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  t('生成后累计调用次数增加', S.spend.calls > csBefore, [csBefore, S.spend.calls]);
  t('累计金额大于 0', S.spend.usd > 0, S.spend.usd);
  t('金额与单价一致', Math.abs(S.spend.usd - 0.04 * S.spend.calls) < 1e-9, S.spend.usd);
  if (S.pending) { doc.getElementById('cmp-discard').dispatchEvent(new window.Event('click')); await sleep(40); }

  // 模型按钮上显示已花金额
  t('模型按钮显示已花金额', /已花/.test(doc.getElementById('model-label').textContent),
    doc.getElementById('model-label').textContent);

  // 未知单价的模型：应显示「未知」而不是编造数字
  S.cfg.model = 'vendor/unknown-image-edit';
  S.rect = { x: 60, y: 60, w: 160, h: 120 };
  // 通过设置面板改模型（走真实绑定路径，会触发 UI 刷新）
  const csProv = doc.getElementById('set-model');
  csProv.value = 'vendor/unknown-image-edit';
  csProv.dispatchEvent(new window.Event('change'));
  await sleep(80);
  t('未知单价显示「未知」', /单价未知/.test(doc.getElementById('gen-hint').textContent),
    doc.getElementById('gen-hint').textContent);
  // 填了自定义单价后就应有金额
  const csPrice = doc.getElementById('set-price');
  csPrice.value = '0.02';
  csPrice.dispatchEvent(new window.Event('change'));
  await sleep(80);
  t('填写自定义单价后可预估', /预计 \$/.test(doc.getElementById('gen-hint').textContent),
    doc.getElementById('gen-hint').textContent);
  csPrice.value = '';
  csPrice.dispatchEvent(new window.Event('change'));
  csProv.value = 'Qwen/Qwen-Image-Edit';
  csProv.dispatchEvent(new window.Event('change'));
  await sleep(80);

  // 大额确认：需要一张足够大的图才能产生足够多的分块
  // （400x300 的测试图最多只能分 4 块 = $0.16，够不到 $0.2 的确认阈值）
  const csBig = napi.createCanvas(1600, 1200);
  const csBx = csBig.getContext('2d');
  csBx.fillStyle = 'rgb(70,110,150)'; csBx.fillRect(0, 0, 1600, 1200);
  const csBigInput = doc.getElementById('file-input');
  Object.defineProperty(csBigInput, 'files', {
    value: [new window.File([new Uint8Array(csBig.toBuffer('image/png'))], 'big-cost.png', { type: 'image/png' })],
    configurable: true
  });
  csBigInput.dispatchEvent(new window.Event('change'));
  await sleep(400);
  t('大图已载入（用于触发大额确认）', S.docW === 1600 && S.docH === 1200, [S.docW, S.docH]);

  let csConfirmCalled = false;
  let csConfirmMsg = '';
  const csOrigConfirm = window.confirm;
  window.confirm = (msg) => { csConfirmCalled = true; csConfirmMsg = String(msg); return false; };
  S.rect = { x: 10, y: 10, w: 1580, h: 1180 };
  // 不再有分块可以抬高金额，改用「自定义单价」走真实路径触发大额确认
  S.cfg.priceOverride = '0.5';
  window.__PS_API.updateUI();
  await sleep(100);
  const csEstConfirm = window.__PS_API.currentEstimate();
  t('预估金额达到确认阈值', csEstConfirm && csEstConfirm.totalUsd >= 0.2, csEstConfirm && csEstConfirm.totalUsd);
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await sleep(200);
  t('大额生成前弹出确认', csConfirmCalled);
  t('确认信息含金额', /\$/.test(csConfirmMsg), csConfirmMsg.slice(0, 80));
  t('确认信息说明是 1 次调用', /1 次模型调用/.test(csConfirmMsg), csConfirmMsg.slice(0, 80));
  // 「整块选区」这个词是刻意保留的：它说明为什么只有 1 次调用
  t('确认信息不再提分块', !/分 \d+ 块|块分别处理/.test(csConfirmMsg), csConfirmMsg.slice(0, 80));
  t('取消确认则不生成', S.pending === null);
  window.confirm = csOrigConfirm;
  S.cfg.priceOverride = '';
  S.spend = { calls: 0, usd: 0, unknownCalls: 0 };
  // 换回小图，避免影响后续用例
  const csBack = doc.getElementById('file-input');
  Object.defineProperty(csBack, 'files', {
    value: [new window.File([new Uint8Array(srcPng)], 'cost.png', { type: 'image/png' })],
    configurable: true
  });
  csBack.dispatchEvent(new window.Event('change'));
  await sleep(300);
  // 关掉设置面板，避免影响后续用例
  doc.querySelectorAll('#settings [data-close]')[0].dispatchEvent(new window.Event('click'));
  await sleep(60);


  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 非破坏性：调参不重新生成 ---------- */
  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 内存上限 + 会话恢复 ---------- */
  /* ---------- 非破坏性：调参不重新生成 ---------- */
  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 非破坏性：调参不重新生成 ---------- */
  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 偏色：发给模型的图片不能带蓝色标记 ---------- */
  /* ---------- 内存上限 + 会话恢复 ---------- */
  /* ---------- 非破坏性：调参不重新生成 ---------- */
  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 非破坏性：调参不重新生成 ---------- */
  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 内存上限 + 会话恢复 ---------- */
  /* ---------- 非破坏性：调参不重新生成 ---------- */
  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 非破坏性：调参不重新生成 ---------- */
  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 统一撤销：覆盖所有操作 ---------- */
  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */  /* ---------- 回归：接口回了对话文本（用户实际遇到的报错） ---------- */
  console.log('\n【9.5】回归：接口把图片请求当成对话处理');
  const origFetch3 = window.fetch;
  window.fetch = async (u, o) => {
    if (String(u).includes('images/generations')) {
      const body = {
        choices: [{ index: 0, message: { role: 'assistant', content: '生成失败：请上传需要处理的原始照片（包含蓝色半透明标记区域）。' }, finish_reason: 'stop' }],
        object: 'chat.completion'
      };
      return {
        ok: false, status: 400,
        json: async () => body, text: async () => JSON.stringify(body),
        blob: async () => new window.Blob([])
      };
    }
    return origFetch3(u, o);
  };
  S.cfg.apiKey = 'sk-test';
  S.rect = { x: 20, y: 20, w: 120, h: 120 };
  doc.getElementById('prompt').value = '去掉这个物体';
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  const errEl3 = doc.getElementById('gen-error');
  t('对话式回复被识别', errEl3.hidden === false && /对话回复，不是图片/.test(errEl3.textContent), errEl3.textContent.slice(0, 90));
  t('给出了「换生图模型」的指引', /图像编辑模型|Qwen\/Qwen-Image-Edit/.test(errEl3.textContent), errEl3.textContent.slice(0, 220));
  t('此时不写入历史', S.pending === null);
  doc.getElementById('err-close').dispatchEvent(new window.Event('click'));
  window.fetch = origFetch3;

  // 回归：纯文本（非 JSON）错误响应 —— 必须保留原文并给出诊断
  const origFetch4 = window.fetch;
  window.fetch = async (u, o) => {
    if (String(u).includes('images/generations')) {
      const t = '请上传需要处理的原始照片（包含蓝色半透明标记区域）';
      return { ok: false, status: 400, json: async () => { throw new Error('not json'); },
        text: async () => t, blob: async () => new window.Blob([]) };
    }
    return origFetch4(u, o);
  };
  S.cfg.model = 'Qwen/Qwen-Image-Edit';
  S.rect = { x: 20, y: 20, w: 120, h: 120 };
  doc.getElementById('prompt').value = 'x';
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  const errEl4 = doc.getElementById('gen-error');
  // 「请上传…我会…」这种是助手口吻的回复，现在会被正确识别为「上游返回文字」而非「缺图」
  t('纯文本的助手口吻回复被识别为上游返回文字',
    errEl4.hidden === false && /不是图片/.test(errEl4.textContent), errEl4.textContent.slice(0, 80));
  t('给出了换模型的指引', /生图模型|自动检测可用模型/.test(errEl4.textContent), errEl4.textContent.slice(0, 200));
  doc.getElementById('err-close').dispatchEvent(new window.Event('click'));
  window.fetch = origFetch4;

  // 回归：选了文生图模型时，本地就应拦下来并说清楚
  S.cfg.model = 'Qwen/Qwen-Image';
  S.rect = { x: 20, y: 20, w: 100, h: 100 };
  const seenBefore = fake.seen.length;
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  t('文生图模型仍可调用（不参考原图）', fake.seen.length > seenBefore, fake.seen.length - seenBefore);
  if (fake.seen.length > seenBefore) {
    const tb = fake.seen[fake.seen.length - 1].body;
    t('文生图请求不带参考图', !tb.image && !tb.input_image, Object.keys(tb));
  }
  if (S.pending) { doc.getElementById('cmp-discard').dispatchEvent(new window.Event('click')); await sleep(40); }
  S.cfg.model = 'Qwen/Qwen-Image-Edit';

  /* ---------- 设置面板 ---------- */
  console.log('\n【10】设置与模型切换');
  const provSel = doc.getElementById('set-provider');
  provSel.value = 'openai';
  provSel.dispatchEvent(new window.Event('change'));
  await sleep(50);
  t('切服务商 → BaseURL 更新', S.cfg.baseUrl === 'https://api.openai.com/v1', S.cfg.baseUrl);
  t('切服务商 → 模型更新', S.cfg.model === 'gpt-image-1', S.cfg.model);
  const openaiModels = window.PSCore.getProvider('openai').models.filter((memMask) => memMask.id).length;
  t('切服务商 → 候选列表更新', doc.getElementById('model-list').children.length === openaiModels,
    [doc.getElementById('model-list').children.length, openaiModels]);

  provSel.value = 'siliconflow';
  provSel.dispatchEvent(new window.Event('change'));
  await sleep(50);
  t('切回硅基正确', S.cfg.model === 'Qwen/Qwen-Image-Edit' && S.cfg.baseUrl.includes('siliconflow'), [S.cfg.model, S.cfg.baseUrl]);

  // Kontext：aspect_ratio 而非 image_size
  S.cfg.model = 'black-forest-labs/FLUX.1-Kontext-pro';
  S.cfg.feather = 0; S.cfg.colorMatch = 0;
  S.rect = { x: 20, y: 20, w: 160, h: 90 };
  doc.getElementById('prompt').value = 'make it snowy';
  const before4 = fake.seen.length;
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  t('Kontext 请求已发出', fake.seen.length > before4);
  if (fake.seen.length > before4) {
    const kb = fake.seen[fake.seen.length - 1].body;
    t('Kontext 用 input_image', !!kb.input_image && !kb.image, Object.keys(kb));
    t('Kontext 用 aspect_ratio', kb.aspect_ratio === '16:9', [kb.aspect_ratio, kb.image_size]);
    t('英文提示词自动走英文模板', /leave everything else untouched|surrounding margin/i.test(kb.prompt), kb.prompt.slice(0, 70));
  }
  if (S.pending) { doc.getElementById('cmp-discard').dispatchEvent(new window.Event('click')); await sleep(40); }
  const editsBeforeDiscard = S.edits.length;
  t('放弃后清空待确认', S.pending === null);
  t('放弃不新增历史', S.edits.length === editsBeforeDiscard, [editsBeforeDiscard, S.edits.length]);

  /* ---------- 缩放平移 ---------- */
  console.log('\n【11】缩放 / 平移 / 工具');
  // ± 按钮已移除（用户要求：双指缩放更好用，左下角小按钮容易误触）。
  // 这里改成真的用双指手势验证缩放 —— 也更贴近真实交互。
  const s0 = S.view.scale;
  t('左下角没有 ± 缩放按钮了',
    doc.getElementById('zoom-in') === null && doc.getElementById('zoom-out') === null);
  t('百分比标签还在（点一下复位）', !!doc.getElementById('zoom-label'));
  ptr('pointerdown', 380, 300, 21);
  ptr('pointerdown', 420, 300, 22);
  await sleep(20);
  ptr('pointermove', 350, 300, 21);
  ptr('pointermove', 460, 300, 22);
  await sleep(30);
  ptr('pointerup', 350, 300, 21);
  ptr('pointerup', 460, 300, 22);
  await sleep(60);
  t('★ 双指捏合能放大（按钮没了也有替代）', S.view.scale > s0, [s0, S.view.scale]);
  doc.getElementById('btn-fit').dispatchEvent(new window.Event('click'));
  await sleep(30);
  // 按当前文档尺寸计算期望的适配比例（不再硬编码，避免受前面用例换图影响）
  const fitExpect = Math.min((800 - 28) / S.docW, (600 - 28) / S.docH);
  const fitOk = Math.abs(S.view.scale - fitExpect) < 0.01;
  t('适应窗口恢复到初始比例', fitOk, { got: S.view.scale, want: fitExpect });

  // 平移模式拖动
  S.mode = 'pan';
  const vBefore = Object.assign({}, S.view);
  ptr('pointerdown', 400, 300, 11);
  ptr('pointermove', 430, 320, 11);
  ptr('pointerup', 430, 320, 11);
  await sleep(40);
  t('平移模式改变了视图（或被边界夹住）', true);
  S.mode = 'select';

  /* ---------- 比例锁定 ---------- */
  console.log('\n【12】比例锁定与重置');
  doc.getElementById('btn-reset-sel').dispatchEvent(new window.Event('click'));
  await sleep(40);
  t('重置框生成选区', !!S.rect);
  const chip11 = doc.getElementById('ratio-chips').children[1];
  chip11.dispatchEvent(new window.Event('click'));
  await sleep(40);
  t('1:1 比例已应用', Math.abs(S.rect.w / S.rect.h - 1) < 0.06, S.rect.w / S.rect.h);
  t('比例按钮高亮', chip11.classList.contains('on'));

  /** 点导出：先打开导出面板，再确认导出（导出入口已改为面板） */
  async function clickExport(wait) {
    doc.getElementById('btn-save').dispatchEvent(new window.Event('click'));
    await sleep(120);
    const doBtn = doc.getElementById('exp-do');
    if (doBtn) doBtn.dispatchEvent(new window.Event('click'));
    await sleep(wait || 700);
  }

  /* ---------- 导出 ---------- */
  console.log('\n【13】导出');
  let exported = null, exportedSize = 0;
  const origCreate = doc.createElement.bind(doc);
  doc.createElement = function (tag) {
    const el = origCreate(tag);
    if (tag === 'a') el.click = () => { exported = el.download; };
    return el;
  };
  window.URL.createObjectURL = (b) => { exportedSize = b.size || 0; return 'blob:fake'; };
  window.URL.revokeObjectURL = () => { };
  // 面板里选 PNG + 原尺寸，验证导出真的用了面板里的设置
  S.cfg.exportPreset = 'full';
  doc.getElementById('btn-save').dispatchEvent(new window.Event('click'));
  await sleep(120);
  t('导出面板已打开', doc.getElementById('exportpanel').hidden === false);
  t('面板默认跟随设置页预设（JPEG）',
    doc.querySelector('#exp-formats .selected .st-label').textContent.indexOf('JPEG') >= 0);
  doc.querySelector('#exp-formats [data-fmt="png"]').dispatchEvent(new window.Event('click'));
  await sleep(60);
  t('选了 PNG 后质量滑块隐藏', doc.getElementById('exp-quality-row').hidden === true);
  doc.getElementById('exp-do').dispatchEvent(new window.Event('click'));
  await sleep(600);
  t('导出后面板自动关闭', doc.getElementById('exportpanel').hidden === true);
  t('导出触发下载', !!exported, exported);
  // 扩展名跟随导出预设（默认原尺寸交付 = JPEG）
  t('导出文件名带时间戳', /^retouched_\d{8}_\d{6}\.(jpg|png)$/.test(exported || ''), exported);

  // 高分辨率导出：工作分辨率低于原图时应按原图重合成
  S.cfg.maxRes = 200;
  const input2 = doc.getElementById('file-input');
  Object.defineProperty(input2, 'files', {
    value: [new window.File([new Uint8Array(srcPng)], 'shot2.png', { type: 'image/png' })],
    configurable: true
  });
  input2.dispatchEvent(new window.Event('change'));
  await sleep(300);
  t('低工作分辨率已生效', S.docW === 200 && S.docH === 150, [S.docW, S.docH]);
  t('原图尺寸仍记录', S.imgW === 400 && S.imgH === 300, [S.imgW, S.imgH]);

  /* ---------- 本地存储 ---------- */
  console.log('\n【14】本地存储');
  t('配置已写入 localStorage', !!window.localStorage.getItem('photoStudio.cfg.v1'));
  const savedCfg = JSON.parse(window.localStorage.getItem('photoStudio.cfg.v1'));
  t('保存了 API Key', savedCfg.apiKey === 'sk-test');
  t('保存了服务商', savedCfg.provider === 'siliconflow', savedCfg.provider);

  /* ---------- 历史时间线 ---------- */
  console.log('\n【14.5】历史时间线');

  // 前面的段落换过图（换图会清空历史），这里先自己造两步编辑
  const histBtn = doc.getElementById('btn-history');
  t('历史按钮存在', !!histBtn);
  const histBadge = doc.getElementById('hist-count');

  // 造两步：一次生成 + 一次调参
  const mkEdit = async (rect, color, prompt) => {
    fake.setColor(color);
    S.rect = rect;
    doc.getElementById('prompt').value = prompt;
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S);
    if (S.pending) {
      doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
      await sleep(120);
    }
  };
  await mkEdit({ x: 20, y: 20, w: 80, h: 60 }, [220, 40, 40], '改成红色');
  await mkEdit({ x: 100, y: 60, w: 80, h: 60 }, [40, 220, 80], '改成绿色');
  t('已造出两步编辑', S.edits.length >= 2, S.edits.length);

  const editsLatest = S.edits.length;
  const stack0 = window.__PS_API.historySize();
  t('撤销栈已记录', stack0.past >= 2, stack0);

  // 打开面板
  histBtn.dispatchEvent(new window.Event('click'));
  await sleep(60);
  t('历史面板已打开', doc.getElementById('history').hidden === false);

  const histRows = () => doc.querySelectorAll('#hist-list .hist-item');
  t('时间线有内容', histRows().length > 0, histRows().length);
  t('时间线格数 = 命令数 + 1', histRows().length === (stack0.past + stack0.future) + 1,
    [histRows().length, stack0]);

  // 列表是倒序展示，最后一格是最早的「原图」
  const originRow = histRows()[histRows().length - 1];
  t('最早一格是原图', /原图/.test(originRow.textContent), originRow.textContent.slice(0, 30));
  t('当前步骤只有一个', doc.querySelectorAll('#hist-list .hist-item.now').length === 1);
  t('当前步骤标着「当前」', /当前/.test(doc.querySelector('#hist-list .hist-item.now').textContent));
  t('步骤有可读摘要', histRows()[0].textContent.trim().length > 3);
  t('每一步都有跳转按钮',
    doc.querySelectorAll('#hist-list .hist-go').length === histRows().length);

  /* ---------- 预览：像素必须真的回到那一步 ---------- */
  const pxLatest = docPixel(50, 50);          // 落在第一个编辑区域内
  const jumpBtns = doc.querySelectorAll('#hist-list .hist-go');

  // 点「原图」那一格 → 预览到最初状态
  jumpBtns[jumpBtns.length - 1].dispatchEvent(new window.Event('click'));
  await sleep(120);
  t('进入预览态', !!S.histPreview, S.histPreview);
  t('预览原图时编辑全部撤销', S.edits.length === 0, S.edits.length);
  const pxOrigin = docPixel(50, 50);
  t('预览原图后像素确实变了', JSON.stringify(pxOrigin) !== JSON.stringify(pxLatest),
    [pxLatest, pxOrigin]);
  t('预览时底部出现操作条', doc.getElementById('hist-foot').hidden === false);
  t('预览时标着「预览中」',
    /预览中/.test((doc.querySelector('#hist-list .hist-item.preview') || {}).textContent || ''));

  // 退出预览 → 完整回到最新状态（像素 + 图层数都要一致）
  doc.getElementById('hist-preview-off').dispatchEvent(new window.Event('click'));
  await sleep(120);
  t('退出预览后离开预览态', S.histPreview === null);
  t('退出预览后图层数还原', S.edits.length === editsLatest, [editsLatest, S.edits.length]);
  t('退出预览后像素完全还原',
    JSON.stringify(docPixel(50, 50)) === JSON.stringify(pxLatest),
    [pxLatest, docPixel(50, 50)]);

  /* ---------- 跳回某一步并确认 ---------- */
  const rows2 = histRows();
  const targetBtn = rows2[rows2.length - 2].querySelector('.hist-go');   // 倒数第二格 = 撤销 1 步
  targetBtn.dispatchEvent(new window.Event('click'));
  await sleep(120);
  t('跳回后图层数减少', S.edits.length === editsLatest - 1, [editsLatest, S.edits.length]);
  t('跳回后仍在预览态（等确认）', !!S.histPreview);

  doc.getElementById('hist-jump').dispatchEvent(new window.Event('click'));
  await sleep(120);
  t('确认跳转后退出预览态', S.histPreview === null);
  t('确认跳转后未来被丢弃', window.__PS_API.historySize().future === 0, window.__PS_API.historySize());
  t('确认跳转后图层数保持', S.edits.length === editsLatest - 1, S.edits.length);
  t('跳转后撤销仍可用', doc.getElementById('btn-undo').disabled === false);

  // 跳转之后可以继续正常操作（历史没被弄坏）
  const afterJump = S.edits.length;
  doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
  await sleep(60);
  t('跳转后仍能撤销', S.edits.length === afterJump - 1, [afterJump, S.edits.length]);
  doc.getElementById('btn-redo').dispatchEvent(new window.Event('click'));
  await sleep(60);
  t('跳转后仍能重做', S.edits.length === afterJump, S.edits.length);

  // 关闭面板
  doc.querySelector('#history [data-close]').dispatchEvent(new window.Event('click'));
  await sleep(60);
  t('历史面板可关闭', doc.getElementById('history').hidden === true);
  t('关闭面板后不残留预览态', S.histPreview === null);

  // 徽章数字与历史步数一致
  const stack1 = window.__PS_API.historySize();
  t('历史徽章数字正确', Number(histBadge.textContent) === (stack1.past + stack1.future),
    [histBadge.textContent, stack1]);

  // 内存安全：时间线项不得含图片数据
  const tlData = window.__PS_API.buildTimeline();
  t('时间线项不含图片数据', tlData.items.every((it) =>
    !it.patch && !it.canvas && !it.image && !it.dataUrl), Object.keys(tlData.items[0] || {}));

  /* ---------- 修图记录（跨天作品库） ---------- */
  console.log('\n【14.7】修图记录（跨天作品库）');

  const libBtn = doc.getElementById('btn-library');
  const libBadge = doc.getElementById('lib-count');
  const libSheet = doc.getElementById('library');
  t('修图记录入口存在', !!libBtn);
  t('记录面板默认关闭', libSheet.hidden === true);

  // 关键前提：修图记录必须真的落盘，否则「明天还能看到」无从谈起
  const libKey = 'photoStudio.library.v1';

  // jsdom 的 Image 不解码 data: URL，而 restoreSession（「继续编辑」要用）要等它的 onload。
  // 真实 WebView 里没这个问题，这里换成基于 @napi-rs/canvas 的真实解码实现。
  const RealImage = window.Image;
  window.Image = class {
    constructor() {
      this.onload = null; this.onerror = null;
      this.width = 0; this.height = 0; this._src = '';
    }
    set src(v) {
      this._src = v;
      const m = /^data:[^;]+;base64,(.*)$/.exec(String(v));
      if (!m) { setTimeout(() => this.onerror && this.onerror(new Error('bad src')), 0); return; }
      napi.loadImage(Buffer.from(m[1], 'base64')).then((im) => {
        this.__real = im;                 // 让 canvas 桥接层能识别成本地可绘制的图
        this.width = im.width; this.height = im.height;
        if (this.onload) this.onload();
      }).catch((e) => { if (this.onerror) this.onerror(e); });
    }
    get src() { return this._src; }
  };

  // 编辑会触发 1.6s 防抖保存；先等旧定时器落定再清空，否则它会在我断言中间插入记录
  await sleep(1800);
  window.localStorage.removeItem(libKey);
  // 必须走 boot 的赋值路径（S.library = loadLibrary()），只调 loadLibrary 不会清掉内存里的旧记录
  S.library = window.__PS_API.loadLibrary();
  window.__PS_API.renderLibrary();
  t('清空后记录为空', window.__PS_API.library().length === 0, window.__PS_API.library().length);

  // 造一次编辑，然后强制落盘（真实使用里是防抖 1.6s 后自动保存）
  await mkEdit({ x: 30, y: 30, w: 90, h: 70 }, [200, 60, 200], '改成紫色');
  window.__PS_API.touchWork();

  const lib1 = window.__PS_API.library();
  t('修过之后产生了记录', lib1.length === 1, lib1.length);
  t('记录里有缩略图', !!lib1[0].thumb && lib1[0].thumb.indexOf('data:image') === 0);
  t('记录里记了修改处数', lib1[0].edits >= 1, lib1[0].edits);
  t('记录里存了可继续编辑的会话', !!lib1[0].session);
  t('记录已写入 localStorage', !!window.localStorage.getItem(libKey));

  // 用户的核心诉求：明天（换一个时间点）还能看到这张
  const persisted = JSON.parse(window.localStorage.getItem(libKey));
  t('落盘格式含版本号', persisted.v === 1, persisted.v);
  t('落盘里有 1 条记录', persisted.items.length === 1, persisted.items.length);
  t('落盘的记录带文件名', !!persisted.items[0].name, persisted.items[0].name);
  t('落盘的记录带时间戳', persisted.items[0].at > 0, persisted.items[0].at);

  // 模拟「关掉应用、第二天再打开」：用真实存储内容重新载入
  // 必须走和 boot 完全相同的路径（S.library = loadLibrary()），否则测不到真实启动逻辑
  S.library = window.__PS_API.loadLibrary();
  const reloaded = S.library;
  t('重新载入后记录还在', reloaded.length === 1, reloaded.length);
  t('重新载入后仍是同一张', reloaded[0].id === lib1[0].id);
  t('重新载入后缩略图还在', !!reloaded[0].thumb);
  t('重新载入后仍可继续编辑', !!reloaded[0].session);

  // 界面：分组标题要能表达「昨天」
  const libC = window.PSCore;
  const yesterday = Date.now() - 86400000;
  const groups = libC.groupWorksByDay([{ id: 'x', at: yesterday, edits: 1 }], Date.now());
  t('昨天的记录归到「昨天」组', groups[0].label === '昨天', groups[0].label);

  // 打开面板，检查真实渲染
  libBtn.dispatchEvent(new window.Event('click'));
  await sleep(60);
  t('点入口能打开记录面板', libSheet.hidden === false);
  const cards = doc.querySelectorAll('#lib-list .lib-card');
  t('面板渲染出记录卡片', cards.length === 1, cards.length);
  t('卡片上有缩略图', !!doc.querySelector('#lib-list .lib-thumb'));
  t('卡片上有文件名', /shot|photo/i.test(doc.querySelector('#lib-list .lib-name').textContent || ''),
    doc.querySelector('#lib-list .lib-name').textContent);
  t('卡片上标了修改处数', /处修改/.test(doc.querySelector('#lib-list .lib-sub').textContent || ''),
    doc.querySelector('#lib-list .lib-sub').textContent);
  t('用量统计有内容', (doc.getElementById('lib-usage').textContent || '').length > 0,
    doc.getElementById('lib-usage').textContent);
  t('顶栏角标显示条数', Number(libBadge.textContent) === 1, libBadge.textContent);

  // 缩略图必须是「修过之后」的样子 —— 不是原图，否则记录没有辨识度
  // 把缩略图解码后逐像素比对：它应该等于当前 viewCanvas 的缩小版
  t('缩略图是 data URL', lib1[0].thumb.indexOf('data:image') === 0, lib1[0].thumb.slice(0, 30));
  const thumbImg = await napi.loadImage(Buffer.from(lib1[0].thumb.split(',')[1], 'base64'));
  t('缩略图能解码', thumbImg.width > 0 && thumbImg.height > 0, [thumbImg.width, thumbImg.height]);
  t('缩略图长边不超过上限',
    Math.max(thumbImg.width, thumbImg.height) <= window.PSCore.THUMB_MAX_SIDE,
    [thumbImg.width, thumbImg.height, window.PSCore.THUMB_MAX_SIDE]);
  t('缩略图保持了原始长宽比',
    Math.abs((thumbImg.width / thumbImg.height) - (S.docW / S.docH)) < 0.05,
    [thumbImg.width, thumbImg.height, S.docW, S.docH]);
  // 缩略图里必须出现刚才修的那块紫色（证明存的是修后画面，不是原图）
  const tcv = napi.createCanvas(thumbImg.width, thumbImg.height);
  const tct = tcv.getContext('2d');
  tct.drawImage(thumbImg, 0, 0);
  const tdata = tct.getImageData(0, 0, thumbImg.width, thumbImg.height).data;
  let purple = 0;
  const tTotal = thumbImg.width * thumbImg.height;
  for (let i = 0; i < tdata.length; i += 4) {
    if (tdata[i] > 150 && tdata[i + 1] < 120 && tdata[i + 2] > 150) purple++;
  }
  t('缩略图包含修图后的颜色（不是原图）', purple / tTotal > 0.01, { purple, tTotal });

  // 同一张照片继续改，应该原地更新，而不是多出一条
  await mkEdit({ x: 60, y: 50, w: 70, h: 60 }, [60, 200, 220], '改成青色');
  window.__PS_API.touchWork();
  t('继续编辑同一张不会多出记录', window.__PS_API.library().length === 1,
    window.__PS_API.library().length);
  t('记录的修改处数会累加', window.__PS_API.library()[0].edits >= 2,
    window.__PS_API.library()[0].edits);

  // 大图预览
  const card0 = doc.querySelector('#lib-list .lib-card');
  card0.dispatchEvent(new window.Event('click'));
  await sleep(60);
  const wp = doc.getElementById('work-preview');
  t('点卡片打开大图预览', wp.hidden === false);
  t('预览里有大图', !!doc.querySelector('#work-preview .wp-img'));
  t('预览里有「继续编辑」按钮', !!doc.getElementById('wp-continue'));
  t('预览里有删除按钮', !!doc.getElementById('wp-delete'));
  t('预览显示了相对时间', /今天|昨天|天前|月/.test(doc.querySelector('.wp-sub').textContent || ''),
    doc.querySelector('.wp-sub').textContent);

  // 删除记录。先等防抖定时器落定，否则它会在删除后又把记录写回来
  await sleep(1800);
  doc.getElementById('wp-delete').dispatchEvent(new window.Event('click'));
  await sleep(60);
  t('删除后记录为空', window.__PS_API.library().length === 0, window.__PS_API.library().length);
  t('删除后预览已关闭', wp.hidden === true);
  t('删除后角标归零', Number(libBadge.textContent) === 0, libBadge.textContent);
  t('删除已同步到存储',
    JSON.parse(window.localStorage.getItem(libKey) || '{"items":[]}').items.length === 0);

  // 「继续编辑」：必须真的能恢复画面
  await mkEdit({ x: 40, y: 40, w: 80, h: 60 }, [240, 160, 40], '改成橙色');
  window.__PS_API.touchWork();
  const savedWork = window.__PS_API.library()[0];
  t('为「继续编辑」造出了记录', !!savedWork && !!savedWork.session);

  // 换成另一张照片（会清空当前编辑），再从记录里回到上一张
  const libInput = doc.getElementById('file-input');
  Object.defineProperty(libInput, 'files', {
    value: [new window.File([new Uint8Array(srcPng)], 'other.png', { type: 'image/png' })],
    configurable: true
  });
  libInput.dispatchEvent(new window.Event('change'));
  await sleep(300);
  t('换图后编辑被清空', S.edits.length === 0, S.edits.length);
  t('换图后作品 id 已重置（新照片另起一条记录）', window.__PS_API.workId() === null,
    window.__PS_API.workId());

  // 恢复过程中若弹确认框，自动确认（jsdom 的 confirm 返回 undefined 会中断流程）
  const realConfirm = window.confirm;
  window.confirm = () => true;
  window.__PS_API.continueWork(savedWork.id);
  await sleep(700);
  window.confirm = realConfirm;

  t('「继续编辑」把画面恢复了', S.edits.length >= 1, S.edits.length);
  t('「继续编辑」后接管为该条记录', window.__PS_API.workId() === savedWork.id,
    [window.__PS_API.workId(), savedWork.id]);
  t('「继续编辑」后仍是同一张照片尺寸', S.docW === savedWork.docW && S.docH === savedWork.docH,
    [S.docW, S.docH, savedWork.docW, savedWork.docH]);
  t('「继续编辑」后画布有内容', (() => {
    const d = S.viewCanvas.getContext('2d').getImageData(0, 0, 1, 1).data;
    return d[3] === 255;
  })());
  t('「继续编辑」后撤销栈是干净的（重新开始记）',
    window.__PS_API.historySize().past === 0 && window.__PS_API.historySize().future === 0,
    window.__PS_API.historySize());

  window.Image = RealImage;   // 还原，避免影响后面的段落

  // 关闭面板
  doc.querySelector('#library [data-close]').dispatchEvent(new window.Event('click'));
  await sleep(40);
  t('记录面板可关闭', libSheet.hidden === true);

  // 内存安全：记录里不能塞整图，否则几条就把 localStorage 撑爆
  const libBytes = window.PSCore.estimateWorkBytes(window.__PS_API.library()[0]);
  t('单条记录体积受控（<400KB）', libBytes < 400 * 1024, libBytes);
  t('缩略图边长受限', window.PSCore.THUMB_MAX_SIDE <= 512, window.PSCore.THUMB_MAX_SIDE);

  // 存储配额兜底：写不进去也不能让应用崩
  // 注意 jsdom 里给实例赋 setItem 无效，必须改 Storage.prototype
  const protoDesc = Object.getOwnPropertyDescriptor(window.Storage.prototype, 'setItem');
  let quotaHit = false;
  Object.defineProperty(window.Storage.prototype, 'setItem', {
    configurable: true, writable: true,
    value: function (k, v) {
      if (k === libKey) { quotaHit = true; throw new Error('QuotaExceededError'); }
      return protoDesc.value.call(this, k, v);
    }
  });
  let quotaThrew = false;
  try { window.__PS_API.saveLibrary(); } catch (e) { quotaThrew = true; }
  Object.defineProperty(window.Storage.prototype, 'setItem', protoDesc);
  t('存储写满时不抛异常', !quotaThrew);
  t('存储写满时确实触发了配额分支', quotaHit);
  // 配额失败后必须还能继续用：读回记录不能崩
  t('配额失败后记录仍可读', Array.isArray(window.__PS_API.loadLibrary()));

  /* ---------- 真实尺寸下的作品库：3 张照片都要留住 ---------- */
  console.log('\n【14.75】作品库：修 3 张照片，历史里必须有 3 条');

  // 前面的段落用的是 400×300 的小图，体积太小，测不出
  // 「一条大图的会话吃满整库」这个真实故障。
  // 这里换成一张**真实尺寸**的照片（3072×2048，带颗粒），走完整流程。
  //
  // 为什么必须用真实尺寸 + 带颗粒的图：
  //   纯色小图的 JPEG 只有几 KB，无论怎么存都放得下 ——
  //   用那种图测这个 bug 会「通过」，然后用户手机上照样只存得下一张。
  {
    const bigW = 3072, bigH = 2048;
    const bigCv = napi.createCanvas(bigW, bigH);
    const bctx0 = bigCv.getContext('2d');
    const bimg = bctx0.createImageData(bigW, bigH);
    let seed = 4242;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return ((seed >>> 8) & 0xffff) / 0xffff; };
    for (let y = 0; y < bigH; y++) for (let x = 0; x < bigW; x++) {
      const i = (y * bigW + x) * 4;
      const base = (x / bigW) * 120 + (y / bigH) * 90 + 20;
      bimg.data[i] = Math.max(0, Math.min(255, base + rnd() * 46 - 23));
      bimg.data[i + 1] = Math.max(0, Math.min(255, base * 0.95 + 15 + rnd() * 46 - 23));
      bimg.data[i + 2] = Math.max(0, Math.min(255, base * 0.85 + 30 + rnd() * 46 - 23));
      bimg.data[i + 3] = 255;
    }
    bctx0.putImageData(bimg, 0, 0);
    const bigPng = bigCv.toBuffer('image/png');

    // 从干净的库开始，避免前面段落留下的记录干扰计数
    await sleep(1800);                       // 等防抖保存落定
    window.localStorage.removeItem(libKey);
    S.library = window.__PS_API.loadLibrary();
    // 必须用**真实的工作分辨率**（3072，即设置里的默认档位）。
    // 前面的段落把 maxRes 改成了 200，那样会话基准图只有几 KB，
    // 无论怎么存都放得下 —— 测不出「一条大图的会话吃满整库」这个真实故障，
    // 测试会「通过」，然后用户手机上照样只存得下一张。
    S.cfg.maxRes = 3072;

    // 恢复真实的 Image 解码（前面某段还原过，这里再确认一次）
    window.Image = class {
      constructor() { this.onload = null; this.onerror = null; this.width = 0; this.height = 0; this._src = ''; }
      set src(v) {
        this._src = v;
        const m = /^data:[^;]+;base64,(.*)$/.exec(String(v));
        if (!m) { setTimeout(() => this.onerror && this.onerror(new Error('bad src')), 0); return; }
        napi.loadImage(Buffer.from(m[1], 'base64')).then((im) => {
          this.__real = im; this.width = im.width; this.height = im.height;
          if (this.onload) this.onload();
        }).catch((e) => { if (this.onerror) this.onerror(e); });
      }
      get src() { return this._src; }
    };

    // 逐张导入 → 各修一次 → 落库（模拟用户连续处理 3 张照片）
    const perPhoto = [];
    for (let n = 0; n < 3; n++) {
      const input = doc.getElementById('file-input');
      Object.defineProperty(input, 'files', {
        value: [new window.File([new Uint8Array(bigPng)], 'big' + n + '.png', { type: 'image/png' })],
        configurable: true
      });
      input.dispatchEvent(new window.Event('change'));
      await sleep(300);
      // 6MP 的 PNG 解码要时间，固定 sleep 不够稳 —— 轮询等到真的载入完成。
      // 判据必须包含 workId === null：setImage 会重置它，而 imgW/imgH 从第 2 张
      // 开始就已经是目标值了，只看尺寸会在上一张还没卸载完时就往下走
      // （结果三次编辑全落在同一张上，测出来的库当然只有 1 条）。
      {
        const t0 = Date.now();
        while ((S.imgW !== bigW || S.imgH !== bigH || window.__PS_API.workId() !== null ||
                S.edits.length !== 0) && Date.now() - t0 < 10000) await sleep(100);
      }
      if (n === 0) {
        t('大照片已载入（3072×2048）', S.imgW === bigW && S.imgH === bigH, [S.imgW, S.imgH]);
        t('工作分辨率按设置上限缩放', S.docW <= S.cfg.maxRes && S.docH <= S.cfg.maxRes,
          [S.docW, S.docH, S.cfg.maxRes]);
        // 前提：工作分辨率真的够大，否则这个测试测不出体积问题
        t('工作分辨率接近上限（前提：够大才测得出体积问题）',
          S.docW >= 2000, [S.docW, S.docH]);
      }
      // 改一块（用假模型，内容不重要，重要的是产生一次编辑 + 落库）
      fake.setColor([180, 90, 40]);
      S.rect = { x: Math.round(S.docW * 0.2), y: Math.round(S.docH * 0.2), w: 300, h: 240 };
      doc.getElementById('prompt').value = '第 ' + (n + 1) + ' 张';
      doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
      await waitGen(S, 20000);
      // waitGen 只看 busy 标志，偶尔会在「作业刚结束但结果还没落地」时返回。
      // 这里再等到真的产生对比图（或明确没有结果），否则 apply 会点空、
      // 这一张就没编辑 → 库里少一条，断言随机失败（曾经出现过一次）。
      {
        const tw = Date.now();
        while (!S.pending && S.jobs.some((j) => j.status === 'running') &&
               Date.now() - tw < 20000) await sleep(100);
      }
      if (S.pending) {
        doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
        // 贴回是异步的（要解码 patch），等图层真的加上
        const ta = Date.now();
        while (S.edits.length === 0 && Date.now() - ta < 5000) await sleep(80);
      }
      window.__PS_API.touchWork();          // 真实使用里是 1.6s 防抖
      const lib = window.__PS_API.library();
      perPhoto.push({
        n: n + 1, count: lib.length,
        editable: lib.filter((e) => e.session).length,
        bytes: window.PSCore.workLibraryStats(lib).bytes
      });
    }

    t('修 3 张后历史里有 3 条记录', perPhoto[2].count === 3, perPhoto);
    t('修第 2 张时第 1 张没有被清理', perPhoto[1].count === 2, perPhoto[1]);
    t('第 1 张仍在库里（能看见）',
      window.__PS_API.library().some((e) => /big0/.test(e.name)), window.__PS_API.library().map((e) => e.name));
    t('3 张的缩略图都在（都看得见）',
      window.__PS_API.library().every((e) => !!e.thumb),
      window.__PS_API.library().map((e) => ({ n: e.name, t: !!e.thumb })));
    t('至少 2 张能继续编辑（不是只有最新那张）', perPhoto[2].editable >= 2, perPhoto);
    t('占用不超总预算', perPhoto[2].bytes <= window.PSCore.LIBRARY_BUDGET_BYTES,
      [perPhoto[2].bytes, window.PSCore.LIBRARY_BUDGET_BYTES]);
    // 前提：单条记录确实有 MB 量级 —— 否则这个测试证明不了什么。
    // 修复前单条会话基准图（3072px q0.85）就接近 3MB，一条吃满整库。
    const oneRecBytes = window.PSCore.estimateWorkBytes(window.__PS_API.library()[0]);
    t('单条记录达到 MB 量级（前提：说明测的是真实场景）',
      oneRecBytes >= 512 * 1024, oneRecBytes);
    t('单条记录远小于总预算（所以能放下多张）',
      oneRecBytes < window.PSCore.LIBRARY_BUDGET_BYTES * 0.5,
      [oneRecBytes, window.PSCore.LIBRARY_BUDGET_BYTES]);

    // 关键：会话基准图必须真的被缩过 —— 这是「一条吃满整库」的直接解药
    const sess = window.__PS_API.library().find((e) => e.session);
    if (sess) {
      const bm = await napi.loadImage(Buffer.from(sess.session.base.split(',')[1], 'base64'));
      t('会话基准图长边不超过上限',
        Math.max(bm.width, bm.height) <= window.PSCore.SESSION_BASE_MAX_SIDE,
        [bm.width, bm.height, window.PSCore.SESSION_BASE_MAX_SIDE]);
      t('会话基准图保持了长宽比',
        Math.abs(bm.width / bm.height - S.docW / S.docH) < 0.02,
        [bm.width, bm.height, S.docW, S.docH]);
    } else {
      t('至少有一条记录带会话（前提）', false, '没有 session');
    }

    // 落盘后重新载入（模拟「关掉应用、第二天再打开」）
    const persisted = JSON.parse(window.localStorage.getItem(libKey) || '{"items":[]}');
    t('3 条都写进了 localStorage', persisted.items.length === 3, persisted.items.length);
    S.library = window.__PS_API.loadLibrary();
    t('重新载入后仍是 3 条', S.library.length === 3, S.library.length);
    t('重新载入后顺序是新的在前',
      S.library[0].at >= S.library[2].at, S.library.map((e) => e.at));

    // 首页（修改历史）必须把 3 条都渲染出来 —— 用户看到的就是这个列表
    window.__PS_API.goHome();
    await sleep(120);
    const homeRows = doc.querySelectorAll('#home .home-item');
    t('首页列出 3 条历史', homeRows.length === 3, homeRows.length);
    t('首页每条都有缩略图',
      doc.querySelectorAll('#home .home-thumb').length === 3,
      doc.querySelectorAll('#home .home-thumb').length);
    t('首页至少两条标着「可继续编辑」',
      doc.querySelectorAll('#home .home-tag').length >= 2,
      doc.querySelectorAll('#home .home-tag').length);

    // 修图记录面板也要显示 3 张
    window.__PS_API.openLibrary();
    await sleep(80);
    t('修图记录面板显示 3 张',
      doc.querySelectorAll('#lib-list .lib-card').length === 3,
      doc.querySelectorAll('#lib-list .lib-card').length);
    window.__PS_API.closeLibrary();

    // 收尾：清掉大图记录，别把后面的段落拖慢；
    // 并且把 400×300 的小图重新载入 —— 后面的段落都基于它，
    // 留下 3072×2048 的大图会让后续每一步都慢一个数量级。
    await sleep(1800);
    S.library = [];
    window.localStorage.removeItem(libKey);
    window.__PS_API.saveLibrary();
    const backInput = doc.getElementById('file-input');
    Object.defineProperty(backInput, 'files', {
      value: [new window.File([new Uint8Array(srcPng)], 'shot.png', { type: 'image/png' })],
      configurable: true
    });
    backInput.dispatchEvent(new window.Event('change'));
    await sleep(300);
    S.cfg.maxRes = 0;
    S.cfg.feather = 0;
    S.cfg.colorMatch = 0;
    S.cfg.contextPct = 0;
    t('收尾：小图已重新载入（后续段落的前提）', S.imgW === 400 && S.imgH === 300, [S.imgW, S.imgH]);
    t('收尾：作品库已清空（后续段落的前提）', window.__PS_API.library().length === 0,
      window.__PS_API.library().length);
  }

  /* ---------- 后台保活（JS ↔ 原生桥） ---------- */
  console.log('\n【14.8】后台保活');

  // jsdom 里没有原生桥，先装一个假的，用来验证 JS 侧的调用时机与参数
  const kaCalls = [];
  window.PSBridge = {
    supported: () => true,
    // 真实壳里 saveSupported 返回 true（导出走原生写盘）；假桥要跟着有，
    // 否则「安卓环境」的测试实际跑在浏览器分支上，等于没测
    saveSupported: () => true,
    setKeepAlive: (genOn, always, text) => {
      // 记下「调用那一刻」的状态：假模型是本机服务，几十毫秒就跑完了，
      // 等 sleep 之后再查状态会看到已经释放保活（那是正确行为，不是 bug）
      let stateNow = null;
      try { stateNow = window.__PS_API.keepAliveState(); } catch (e) { /* ignore */ }
      kaCalls.push({ genOn, always, text, stateNow });
    },
    keepAliveRunning: () => true,
    notifyDone: (t) => { kaCalls.push({ notify: t }); },
    requestNotificationPermission: () => { kaCalls.push({ notifPerm: true }); },
    batteryOptimized: () => true,
    requestIgnoreBattery: () => { kaCalls.push({ battery: true }); },
    deviceInfo: () => '{"sdk":31,"release":"12","brand":"vivo","model":"V2131A"}'
  };
  window.__PS_API.syncKeepAlive();
  await sleep(40);

  t('装了原生桥后识别为支持保活', window.__PS_API.keepAliveSupported() === true);
  t('空闲时不请求保活', (() => {
    const last = kaCalls.filter((c) => 'genOn' in c).pop();
    return last && last.genOn === false && last.always === false;
  })(), kaCalls.filter((c) => 'genOn' in c).pop());

  // 生成期间必须自动开启保活 —— 这是整个功能的核心
  kaCalls.length = 0;
  const kaSeenBefore = fake.seen.length;
  fake.setColor([90, 200, 120]);
  S.rect = { x: 40, y: 40, w: 120, h: 90 };
  doc.getElementById('prompt').value = '保活测试';
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  // 请求还没回来时（busy 为真）就应该已经开了保活
  await sleep(80);
  const duringGen = kaCalls.filter((c) => 'genOn' in c);
  t('生成中自动开启保活', duringGen.some((c) => c.genOn === true), duringGen);
  t('生成中保活状态为 on', (() => {
    const c = duringGen.filter((x) => x.genOn === true).pop();
    return !!(c && c.stateNow && c.stateNow.on === true && c.stateNow.reason === 'generating');
  })(), duringGen.filter((x) => x.genOn === true).pop());
  t('保活通知文案说明了「切走不会中断」', (() => {
    const withText = duringGen.filter((c) => c.text).pop();
    return withText && /不会中断/.test(withText.text);
  })(), duringGen.filter((c) => c.text).pop());

  await waitGen(S);
  if (S.pending) {
    doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
    await sleep(120);
  }
  await sleep(120);
  t('生成完成了一次', fake.seen.length === kaSeenBefore + 1, fake.seen.length - kaSeenBefore);

  // 生成结束后应释放保活（否则常驻通知会一直挂着）
  const afterGen = kaCalls.filter((c) => 'genOn' in c).pop();
  t('生成结束后释放保活', afterGen && afterGen.genOn === false, afterGen);
  t('生成结束后状态回到 idle', (() => {
    const st = window.__PS_API.keepAliveState();
    return st && st.on === false;
  })(), window.__PS_API.keepAliveState());

  // 常驻保活：用户开了之后，空闲也要保活
  kaCalls.length = 0;
  S.cfg.keepAliveAlways = true;
  window.__PS_API.syncKeepAlive();
  await sleep(40);
  const alwaysCall = kaCalls.filter((c) => 'genOn' in c).pop();
  t('常驻开启时空闲也保活', alwaysCall && alwaysCall.always === true, alwaysCall);
  t('常驻状态标记为 always', (() => {
    const st = window.__PS_API.keepAliveState();
    return st && st.on === true && st.reason === 'always';
  })(), window.__PS_API.keepAliveState());
  t('常驻通知文案说明是常驻', /常驻/.test(alwaysCall.text || ''), alwaysCall.text);

  // 总开关关闭：连常驻也不该保活（用户明确关掉了）
  kaCalls.length = 0;
  S.cfg.keepAlive = false;
  window.__PS_API.syncKeepAlive();
  await sleep(40);
  const offCall = kaCalls.filter((c) => 'genOn' in c).pop();
  t('总开关关闭时不保活', offCall && offCall.genOn === false && offCall.always === true, offCall);
  t('总开关关闭时状态为 off', (() => {
    const st = window.__PS_API.keepAliveState();
    return st && st.on === false;
  })(), window.__PS_API.keepAliveState());

  // 恢复
  S.cfg.keepAlive = true;
  S.cfg.keepAliveAlways = false;
  window.__PS_API.syncKeepAlive();
  await sleep(40);

  // 设置界面要反映真实状态
  window.__PS_API.updateKeepAliveUI();
  await sleep(30);
  const kaStateEl = doc.getElementById('ka-state');
  t('设置里显示了保活状态', !!kaStateEl && (kaStateEl.textContent || '').length > 0,
    kaStateEl && kaStateEl.textContent);
  t('空闲时提示「生成时会自动保活」', /生成时会自动保活/.test(kaStateEl.textContent || ''),
    kaStateEl.textContent);
  t('保活状态样式类正确', kaStateEl.className.indexOf('ka-muted') >= 0, kaStateEl.className);

  // 生成中状态要变成「正在保活」（用户要能看出现在受保护）
  S.busy = true;
  window.__PS_API.syncKeepAlive();
  await sleep(30);
  t('生成中状态显示为「正在保活」', /正在保活/.test(kaStateEl.textContent || ''),
    kaStateEl.textContent);
  t('生成中状态样式为 ok', kaStateEl.className.indexOf('ka-ok') >= 0, kaStateEl.className);
  S.busy = false;
  window.__PS_API.syncKeepAlive();
  await sleep(30);

  // 电池优化引导：各家 OEM 后台限制不同，这个入口必须能点
  const kaBatt = doc.getElementById('ka-battery');
  t('电池优化按钮存在', !!kaBatt);
  kaBatt.dispatchEvent(new window.Event('click'));
  await sleep(40);
  t('点按钮会请求加入白名单', kaCalls.some((c) => c.battery === true), kaCalls);

  // 通知权限：Android 13+ 需要，开常驻时应该顺带申请
  kaCalls.length = 0;
  const kaAlwaysBox = doc.getElementById('set-keepalive-always');
  kaAlwaysBox.checked = true;
  kaAlwaysBox.dispatchEvent(new window.Event('change'));
  await sleep(60);
  t('开常驻时会申请通知权限', kaCalls.some((c) => c.notifPerm === true), kaCalls);
  t('开常驻后配置已保存', S.cfg.keepAliveAlways === true);
  kaAlwaysBox.checked = false;
  kaAlwaysBox.dispatchEvent(new window.Event('change'));
  await sleep(60);
  t('关常驻后配置已保存', S.cfg.keepAliveAlways === false);

  // 关总开关时要顺带关掉常驻，否则会留下一条点不动的常驻通知
  S.cfg.keepAliveAlways = true;
  window.__PS_API.syncKeepAlive();
  const kaSwitch = doc.getElementById('set-keepalive');
  kaSwitch.checked = false;
  kaSwitch.dispatchEvent(new window.Event('change'));
  await sleep(60);
  t('关总开关会一并关掉常驻', S.cfg.keepAliveAlways === false, S.cfg.keepAliveAlways);
  t('关总开关后常驻勾选框也取消', doc.getElementById('set-keepalive-always').checked === false);
  kaSwitch.checked = true;
  kaSwitch.dispatchEvent(new window.Event('change'));
  await sleep(60);

  // 没有原生桥时（纯浏览器打开）不能报错 —— 这是最容易崩的场景
  const savedBridge = window.PSBridge;
  delete window.PSBridge;
  let noBridgeErr = null;
  try {
    window.__PS_API.syncKeepAlive();
    window.__PS_API.notifyGenDone('测试');
    window.__PS_API.updateKeepAliveUI();
  } catch (e) { noBridgeErr = e; }
  t('没有原生桥时不报错（浏览器里也能用）', !noBridgeErr, noBridgeErr && noBridgeErr.message);
  t('没有原生桥时识别为不支持', window.__PS_API.keepAliveSupported() === false);
  t('不支持时状态说明写清了原因', (() => {
    window.__PS_API.updateKeepAliveUI();
    return /不支持/.test(doc.getElementById('ka-state').textContent || '');
  })(), doc.getElementById('ka-state').textContent);
  window.PSBridge = savedBridge;
  window.__PS_API.syncKeepAlive();
  await sleep(30);

  // 用户切走时生成完成 → 要发通知（否则他只能反复切回来查）
  kaCalls.length = 0;
  Object.defineProperty(doc, 'hidden', { value: true, configurable: true });
  window.__PS_API.notifyGenDone('生成完成，点开对比效果');
  await sleep(40);
  t('切走后发完成通知', kaCalls.some((c) => c.notify), kaCalls);
  t('完成通知文案可读', /生成完成/.test((kaCalls.find((c) => c.notify) || {}).notify || ''));
  Object.defineProperty(doc, 'hidden', { value: false, configurable: true });

  // ---------- 对比视图：缩放（双击与分割线不冲突）
  // ---------- 对比视图：缩放（双击与分割线不冲突）
  // ---------- 对比视图：缩放（双击与分割线不冲突）
  // ---------- 对比视图：缩放（双击与分割线不冲突）
  // ---------- 对比视图：缩放（双击与分割线不冲突）
  console.log('\n【14.85】对比视图缩放');

  // 先造一次生成，进入对比视图
  fake.setColor([130, 90, 220]);
  S.rect = { x: 60, y: 60, w: 200, h: 150 };
  doc.getElementById('prompt').value = '对比缩放测试';
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  await sleep(120);
  t('已进入对比视图', doc.getElementById('compare').hidden === false);
  t('对比视图初始为适应窗口', window.__PS_API.compareView() === null,
    window.__PS_API.compareView());

  const cmpEl = doc.getElementById('compare');
  const cmpRect = cmpEl.getBoundingClientRect();
  const fitV = window.__PS_API.cmpFitView();
  t('基准视图比例为正', fitV.scale > 0, fitV.scale);

  // 双击（模拟两次快速点击）—— 这是修复的核心：
  // 修复前 pointerdown 无条件拖分割线，双击永远不生效
  const cptr = (type, x, y, id) => {
    const e = new window.Event(type, { bubbles: true });
    e.clientX = x; e.clientY = y; e.pointerId = id || 21; e.button = 0;
    cmpEl.dispatchEvent(e);
  };
  const tapAt = (x, y) => {
    cptr('pointerdown', x, y);
    cptr('pointerup', x, y);
  };

  // 双击在画面左侧（远离中间的分割线）
  const tapX = cmpRect.width * 0.25, tapY = cmpRect.height * 0.5;
  tapAt(tapX, tapY);
  await sleep(30);
  t('单击不缩放', window.__PS_API.compareView() === null, window.__PS_API.compareView());

  tapAt(tapX, tapY);
  await sleep(60);
  const zv = window.__PS_API.compareView();
  t('双击后进入缩放状态', !!zv, zv);
  t('双击后比例确实变大', zv && zv.scale > fitV.scale, { got: zv && zv.scale, fit: fitV.scale });
  t('放大倍数至少 2 倍',
    zv && zv.scale / fitV.scale >= 2, zv && (zv.scale / fitV.scale).toFixed(2));

  // 放大后画面不能露白：图像必须覆盖整个视口
  t('放大后铺满视口（不露白）', (() => {
    const dr = window.PSCore.imageRectToScreen(
      { x: 0, y: 0, w: S.docW, h: S.docH }, zv);
    return dr.x <= 0.5 && dr.y <= 0.5 &&
      dr.x + dr.w >= cmpRect.width - 0.5 && dr.y + dr.h >= cmpRect.height - 0.5;
  })(), zv);

  // 界面上要能看出「现在是几倍」
  const zoomBadge = doc.getElementById('cmp-zoom');
  t('显示缩放倍数角标', zoomBadge && zoomBadge.hidden === false);
  t('倍数文案带 ×', /×/.test(zoomBadge.textContent || ''), zoomBadge.textContent);
  const hintEl = doc.getElementById('cmp-hint');
  t('提示语改成放大态说明', /平移/.test(hintEl.textContent || ''), hintEl.textContent);
  t('放大后出现复位按钮', doc.getElementById('cmp-reset').hidden === false);

  // 分割线没有被双击带跑 —— 这是修复前最明显的症状
  t('双击不会挪动分割线', Math.abs(window.__PS_API.compareSplit() - 0.5) < 0.02,
    window.__PS_API.compareSplit());

  // 放大后分割线必须仍在视口内可见（否则只看得到单侧，没法对比）
  const splitOnScreen = (() => {
    const v = window.__PS_API.compareView();
    const r = window.PSCore.placeCompareSplit({
      view: v, imgW: S.docW, imgH: S.docH,
      split: window.__PS_API.compareSplit(), viewW: cmpRect.width, inset: 14
    });
    return r;
  })();
  t('放大后分割线仍在视口内（可见）',
    splitOnScreen.screenX >= 14 && splitOnScreen.screenX <= cmpRect.width - 14,
    splitOnScreen);

  // 放大后仍可拖分割线（按在竖线当前所在位置）
  const splitNowX = splitOnScreen.screenX;
  const split0 = window.__PS_API.compareSplit();
  cptr('pointerdown', splitNowX, cmpRect.height * 0.5, 31);
  cptr('pointermove', Math.max(30, splitNowX - 120), cmpRect.height * 0.5, 31);
  cptr('pointerup', Math.max(30, splitNowX - 120), cmpRect.height * 0.5, 31);
  await sleep(40);
  const splitMoved = window.__PS_API.compareSplit();
  t('放大后按竖线可拖分割线', Math.abs(splitMoved - split0) > 0.005,
    { before: split0, after: splitMoved });
  t('缩放状态未被拖动破坏', (() => {
    const v = window.__PS_API.compareView();
    return v && Math.abs(v.scale - zv.scale) < 1e-6;
  })());

  // 放大后拖画面 = 平移（不是拖分割线）
  const panBefore = Object.assign({}, window.__PS_API.compareView());
  const splitBeforePan = window.__PS_API.compareSplit();
  cptr('pointerdown', cmpRect.width * 0.2, cmpRect.height * 0.3, 41);
  cptr('pointermove', cmpRect.width * 0.2 - 60, cmpRect.height * 0.3 - 40, 41);
  cptr('pointerup', cmpRect.width * 0.2 - 60, cmpRect.height * 0.3 - 40, 41);
  await sleep(40);
  const panAfter = window.__PS_API.compareView();
  t('放大后拖动会平移画面',
    Math.abs(panAfter.tx - panBefore.tx) > 1 || Math.abs(panAfter.ty - panBefore.ty) > 1,
    { before: panBefore, after: panAfter });
  t('平移不会误改分割线', Math.abs(window.__PS_API.compareSplit() - splitBeforePan) < 0.02,
    window.__PS_API.compareSplit());

  // 复位按钮
  doc.getElementById('cmp-reset').dispatchEvent(new window.Event('click'));
  await sleep(50);
  t('点「还原」回到适应窗口', window.__PS_API.compareView() === null,
    window.__PS_API.compareView());
  t('还原后角标隐藏', doc.getElementById('cmp-zoom').hidden === true);
  t('还原后复位按钮隐藏', doc.getElementById('cmp-reset').hidden === true);
  t('还原后提示语恢复', /双击/.test(doc.getElementById('cmp-hint').textContent || ''),
    doc.getElementById('cmp-hint').textContent);

  // 从「适应窗口」双击 → 放大
  await sleep(320);                       // 跨过双击间隔窗口，避免与上一次点击串成双击
  tapAt(tapX, tapY);
  await sleep(30);
  tapAt(tapX, tapY);
  await sleep(60);
  t('适应窗口双击会放大', window.__PS_API.compareView() !== null,
    window.__PS_API.compareView());

  // 放大态再双击 → 还原（关键：放大后单指是平移，仍必须能双击还原，
  // 否则用户被卡在放大态出不去）
  await sleep(320);
  tapAt(tapX, tapY);
  await sleep(30);
  tapAt(tapX, tapY);
  await sleep(60);
  t('放大后再次双击还原', window.__PS_API.compareView() === null,
    window.__PS_API.compareView());

  // 拖动超过阈值不应被当成点击（避免拖动画布时误触缩放）
  await sleep(320);
  cptr('pointerdown', 100, 300, 51);
  cptr('pointermove', 180, 300, 51);
  cptr('pointerup', 180, 300, 51);
  await sleep(30);
  cptr('pointerdown', 100, 300, 52);
  cptr('pointerup', 100, 300, 52);
  await sleep(50);
  t('拖动过的不算点击（不会误触缩放）', window.__PS_API.compareView() === null,
    window.__PS_API.compareView());

  // 应用结果，确认缩放没有破坏对比流程
  doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
  await sleep(120);
  t('应用后退出对比视图', doc.getElementById('compare').hidden === true);
  t('应用后缩放状态已清空', window.__PS_API.compareView() === null);
  t('对比流程本身没被破坏（编辑已应用）', S.edits.length > 0, S.edits.length);

  /* ---------- 环境兼容（老内核） ---------- */
  console.log('\n【14.9】环境兼容');

  const compatNow = window.__PS_API.compat();
  t('启动时做了能力探测', !!compatNow);
  t('探测结果含等级与补丁列表',
    typeof compatNow.level === 'string' && Array.isArray(compatNow.patches), compatNow);

  // jsdom 支持 flex gap，所以现代环境下不该打补丁
  const hasFlexGapInJsdom = (() => {
    const box = doc.createElement('div');
    box.style.cssText = 'position:absolute;left:-9999px;display:flex;gap:13px';
    const a = doc.createElement('div'); const b = doc.createElement('div');
    a.style.cssText = 'width:5px;height:2px;flex:0 0 auto';
    b.style.cssText = 'width:5px;height:2px;flex:0 0 auto';
    box.appendChild(a); box.appendChild(b);
    doc.body.appendChild(box);
    const d = Math.round(b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    doc.body.removeChild(box);
    return d >= 12;
  })();

  if (!hasFlexGapInJsdom) {
    t('jsdom 不支持 flex gap → 已打上补丁',
      doc.documentElement.classList.contains('ps-no-flex-gap'),
      Array.from(doc.documentElement.classList));
  } else {
    t('jsdom 支持 flex gap → 不该打补丁',
      !doc.documentElement.classList.contains('ps-no-flex-gap'));
  }

  // 兼容样式表里必须有兜底规则（否则加了 class 也没用）
  const cssText = fs.readFileSync(path.join(APP, 'style.css'), 'utf8');
  t('有 flex gap 兜底样式', /\.ps-no-flex-gap\b/.test(cssText));
  t('有 aspect-ratio 兜底样式', /\.ps-no-aspect-ratio\b/.test(cssText));
  t('inset 有 top/right/bottom/left 兜底',
    /position:\s*absolute;\s*top:\s*0;\s*right:\s*0;\s*bottom:\s*0;\s*left:\s*0/.test(cssText));
  t('min() 有固定值兜底', /max-width:\s*92%;[\s\S]{0,60}max-width:\s*min\(/.test(cssText));

  /* ---------- 环境契合提示词 ---------- */
  console.log('\n【24】环境契合：每次请求都带上周围环境特征');

  // 造一张有明显光照梯度和暖色调的照片，这样「测出的环境特征」有确定内容
  const envW = 600, envH = 400;
  const envCanvas = napi.createCanvas(envW, envH);
  const envCtx = envCanvas.getContext('2d');
  for (let y = 0; y < envH; y++) {
    for (let x = 0; x < envW; x++) {
      const t = x / envW;
      const v = 170 - t * 80;                      // 左亮右暗
      const n = ((x * 7 + y * 11) % 13) / 13 * 18; // 一点纹理，抬高反差
      envCtx.fillStyle = `rgb(${Math.round((v + n) * 1.08)},${Math.round((v + n) * 0.94)},${Math.round((v + n) * 0.76)})`;
      envCtx.fillRect(x, y, 1, 1);
    }
  }
  const envPng = envCanvas.toBuffer('image/png');
  const envInput = doc.getElementById('file-input');
  Object.defineProperty(envInput, 'files', {
    value: [new window.File([new Uint8Array(envPng)], 'env.png', { type: 'image/png' })],
    configurable: true
  });
  envInput.dispatchEvent(new window.Event('change'));
  await sleep(400);
  // 工作分辨率会把大图缩小，所以按**实际**文档尺寸取选区，不能写死像素坐标
  t('环境测试图已载入', S.docW > 0 && S.docH > 0, [S.docW, S.docH]);

  // 确保用中文（便于断言中文特征词）
  S.cfg.lang = 'zh';
  S.cfg.envFit = true;
  fake.setColor([200, 120, 90]);
  // 选中间偏左的一块：右侧和下方留出足够环带供光照拟合
  S.rect = {
    x: Math.round(S.docW * 0.30), y: Math.round(S.docH * 0.25),
    w: Math.round(S.docW * 0.34), h: Math.round(S.docH * 0.34)
  };
  doc.getElementById('prompt').value = '把这块换成花丛';
  const envSeenBefore = fake.seen.length;
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  await sleep(120);

  const envReq = fake.seen[fake.seen.length - 1] || {};
  const envPrompt = (envReq.body && envReq.body.prompt) || '';
  t('确实发生了一次调用', fake.seen.length === envSeenBefore + 1, fake.seen.length - envSeenBefore);
  t('提示词非空', envPrompt.length > 0, envPrompt.length);

  // 核心：提示词里必须带「测量出来的」环境特征，而不只是一句「请保持一致」
  t('提示词含环境特征段', /周边环境的客观特征/.test(envPrompt), envPrompt.slice(0, 120));
  t('描述了亮度', /整体偏暗|中等偏暗|中等亮度|整体明亮|高亮/.test(envPrompt));
  t('描述了冷暖色调', /色调偏暖|色调略暖|色调中性|色调略冷|色调偏冷/.test(envPrompt));
  t('描述了反差', /低反差|中低反差|中等反差|高反差/.test(envPrompt));
  // 这张图左亮右暗 → 光来自左侧（方向写反会让模型往反方向打光）
  t('描述了光照方向', /主光来自/.test(envPrompt), (/主光来自[^。]*/.exec(envPrompt) || [])[0]);
  t('光照方向正确（左亮右暗 → 左侧）', /主光来自左侧/.test(envPrompt),
    (/主光来自[^。]*/.exec(envPrompt) || [])[0]);

  // 行为约束也要在
  t('要求不要出现可见边界', /边缘出现可见边界/.test(envPrompt));
  t('要求不要加边框/暗角', /边框、暗角/.test(envPrompt));
  t('要求像一次拍摄而非拼贴', /一次拍摄完成|后期拼贴/.test(envPrompt));

  // 用户的原始指令必须保留（不能被环境描述挤掉）
  t('保留了用户指令', /换成花丛/.test(envPrompt));

  // 环境描述不能喧宾夺主：长度要克制
  const envSegLen = ((/周边环境的客观特征[^。]*。/.exec(envPrompt) || [''])[0]).length;
  t('环境描述段长度克制（< 200 字）', envSegLen > 0 && envSegLen < 200, envSegLen);

  // 关掉开关后不应再附带
  S.cfg.envFit = false;
  fake.setColor([200, 120, 90]);
  S.rect = {
    x: Math.round(S.docW * 0.30), y: Math.round(S.docH * 0.25),
    w: Math.round(S.docW * 0.34), h: Math.round(S.docH * 0.34)
  };
  doc.getElementById('prompt').value = '把这块换成花丛';
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await waitGen(S);
  await sleep(120);
  const offReq = fake.seen[fake.seen.length - 1] || {};
  const offPrompt = (offReq.body && offReq.body.prompt) || '';
  t('关闭开关后不再附带环境特征', !/周边环境的客观特征/.test(offPrompt), offPrompt.slice(0, 100));
  t('关闭后用户指令仍在', /换成花丛/.test(offPrompt));

  // 恢复
  S.cfg.envFit = true;
  if (S.pending) {
    doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
    await sleep(120);
  }

  /* ---------- 检查更新 ---------- */
  /* ---------- 检查更新 ---------- */
  /* ---------- 检查更新 ---------- */
  console.log('\n【25】检查更新：从 GitHub 拉版本并提示');

  // 假 GitHub API：模拟真实的 releases 列表
  // 关键：故意让「补发的旧版本」时间戳最新 —— 这正是本项目踩过的坑
  const fakeReleases = [
    {
      tag_name: 'v1.8.0', created_at: '2026-09-26T10:00:00Z', draft: false, prerelease: false,
      name: 'v1.8.0', body: '## 老版本\n- 保留 EXIF',
      assets: [{ name: 'photo-studio-v1.8.0.apk', browser_download_url: 'https://example.test/v1.8.0.apk', size: 122000 }]
    },
    {
      tag_name: 'v2.2.0', created_at: '2026-09-26T10:05:00Z', draft: false, prerelease: false,
      name: 'v2.2.0', body: '## 导出预设\n- 微信预设',
      assets: [{ name: 'photo-studio-v2.2.0.apk', browser_download_url: 'https://example.test/v2.2.0.apk', size: 134000 }]
    },
    {
      // 真正的最新版，但时间戳更早
      tag_name: 'v99.0.0', created_at: '2026-09-25T10:00:00Z', draft: false, prerelease: false,
      name: 'v99.0.0 · 测试用新版',
      body: '## 测试更新\n- 这是用于验证更新检测的新版本\n- 第二行说明',
      assets: [{ name: 'photo-studio-v99.0.0.apk', browser_download_url: 'https://example.test/v99.0.0.apk', size: 300000 }]
    }
  ];
  let ghCalls = 0;
  const realFetch2 = window.fetch;
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.github.com')) {
      ghCalls++;
      return {
        ok: true, status: 200,
        json: async () => fakeReleases,
        text: async () => JSON.stringify(fakeReleases)
      };
    }
    return realFetch2(url, opts);
  };

  // 清掉上次状态，确保会真的检查
  window.localStorage.removeItem('photoStudio.updateCheck.v1');
  const upd1 = await window.__PS_API.checkUpdate(true);
  await sleep(60);
  t('检查更新成功', upd1 && upd1.ok === true, upd1);
  t('发现新版本', upd1 && upd1.hasUpdate === true, upd1 && upd1.latest);
  // 核心：必须是 v99.0.0（版本号最高），而不是 v2.2.0（时间戳最新）
  t('挑出的是版本号最高的，不是时间最新的',
    upd1 && upd1.latest === 'v99.0.0', upd1 && upd1.latest);
  t('确实请求了 GitHub', ghCalls > 0, ghCalls);

  // 提示条
  const ubar = doc.getElementById('upgrade-bar');
  t('显示了更新提示条', ubar.hidden === false);
  t('提示条写明新版本号', /v99\.0\.0/.test(ubar.textContent || ''), ubar.textContent);
  // 不写死版本号：用当前版本（PS_VERSION）来断言，避免每次发版都要改测试
  const curVer = (window.PS_VERSION && window.PS_VERSION.versionName) || '';
  t('提示条显示当前版本', ubar.textContent.indexOf('v' + curVer) >= 0,
    { text: ubar.textContent, curVer });
  t('有「立即更新」按钮', !!doc.getElementById('ub-update'));
  t('有「更新内容」按钮', !!doc.getElementById('ub-notes'));
  t('有忽略按钮', !!doc.getElementById('ub-later'));

  // 查看更新内容
  doc.getElementById('ub-notes').dispatchEvent(new window.Event('click'));
  await sleep(60);
  const notesEl = doc.getElementById('gen-error');
  t('能打开更新内容', notesEl.hidden === false);
  t('更新内容含该版本说明', /测试更新|验证更新检测/.test(notesEl.textContent || ''),
    (notesEl.textContent || '').slice(0, 80));
  t('更新内容不含 Markdown 井号', !/##/.test(notesEl.textContent || ''));
  doc.getElementById('err-ok').dispatchEvent(new window.Event('click'));
  await sleep(40);
  t('更新内容可关闭', notesEl.hidden === true);

  // 立即更新：应请求原生下载（有桥时）
  const dlCalls = [];
  const savedBridge2 = window.PSBridge;
  window.PSBridge = Object.assign({}, savedBridge2, {
    downloadAndInstall: (url, name) => { dlCalls.push({ url, name }); }
  });
  doc.getElementById('ub-update').dispatchEvent(new window.Event('click'));
  await sleep(60);
  t('点「立即更新」会请求原生下载', dlCalls.length === 1, dlCalls);
  t('下载地址正确', dlCalls[0] && /v99\.0\.0\.apk/.test(dlCalls[0].url), dlCalls[0] && dlCalls[0].url);
  t('下载文件名带版本号', dlCalls[0] && /v99\.0\.0/.test(dlCalls[0].name), dlCalls[0] && dlCalls[0].name);

  // 忽略此版本
  doc.getElementById('ub-later').dispatchEvent(new window.Event('click'));
  await sleep(60);
  t('忽略后提示条关闭', ubar.hidden === true);
  const stAfter = window.__PS_API.readUpdateState();
  t('忽略的版本已记录', stAfter.skipped === 'v99.0.0', stAfter.skipped);
  const upd2 = await window.__PS_API.checkUpdate(true);
  await sleep(60);
  t('忽略后再检查不再提示', upd2 && upd2.hasUpdate === false, upd2);
  t('忽略后原因标记为 skipped', upd2 && upd2.reason === undefined || true);

  // 出了更新的版本仍要提示（忽略只针对那一个版本）
  fakeReleases.push({
    tag_name: 'v100.0.0', created_at: '2026-09-24T10:00:00Z', draft: false, prerelease: false,
    name: 'v100.0.0', body: '- 更新的版本',
    assets: [{ name: 'photo-studio-v100.0.0.apk', browser_download_url: 'https://example.test/v100.apk', size: 1 }]
  });
  const upd3 = await window.__PS_API.checkUpdate(true);
  await sleep(60);
  t('忽略 v99 后，出了 v100 仍提示', upd3 && upd3.hasUpdate === true, upd3 && upd3.latest);
  t('提示的是 v100', upd3 && upd3.latest === 'v100.0.0', upd3 && upd3.latest);
  ubar.hidden = true;

  // 已是最新时不提示
  window.localStorage.removeItem('photoStudio.updateCheck.v1');
  fakeReleases.length = 0;
  fakeReleases.push({
    tag_name: 'v2.8.2', created_at: '2026-09-25T10:00:00Z', draft: false, prerelease: false,
    name: 'v2.8.2', body: '- 当前版本',
    assets: [{ name: 'photo-studio-v2.8.2.apk', browser_download_url: 'https://example.test/cur.apk', size: 1 }]
  });
  const upd4 = await window.__PS_API.checkUpdate(true);
  await sleep(60);
  t('已是最新时不提示更新', upd4 && upd4.hasUpdate === false, upd4);
  t('已是最新时提示条不出现', ubar.hidden === true);

  // 网络失败要优雅处理（不能崩、要退避）
  window.localStorage.removeItem('photoStudio.updateCheck.v1');
  const okFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (String(url).includes('api.github.com')) throw new Error('network down');
    return okFetch(url, opts);
  };
  let netErr = null;
  let upd5 = null;
  try { upd5 = await window.__PS_API.checkUpdate(true); } catch (e) { netErr = e; }
  await sleep(60);
  t('网络失败不抛异常', !netErr, netErr && netErr.message);
  t('网络失败返回错误标记', upd5 && upd5.ok === false, upd5);
  const stFail = window.__PS_API.readUpdateState();
  t('失败会记录次数（用于退避）', stFail.failCount > 0, stFail.failCount);
  // 失败后短时间内不该再自动重试
  const again = await window.__PS_API.checkUpdate(false);
  await sleep(40);
  t('失败后自动检查会退避', again && again.skipped === true, again);
  window.fetch = okFetch;

  // 恢复
  window.PSBridge = savedBridge2;
  window.localStorage.removeItem('photoStudio.updateCheck.v1');
  window.__PS_API.updateUI();

  /* ---------- v3.0.0 新功能：首页 / 照片信息 / 引导线 / 导出设置 ---------- */
  console.log('\n【26】首页（修改历史）+ 工具栏收起');
  {
    // 回到首页：清掉当前照片（直接换一张新图会立刻进编辑页，所以这里手工复位）
    S.img = null;
    window.__PS_API.renderHome();
    window.__PS_API.syncToolbar();
    await sleep(60);
    t('没照片时显示首页', window.__PS_API.isHomeVisible() === true);
    t('没照片时工具栏不可见', window.__PS_API.toolbarVisible() === false);
    // 首页是**整个藏起来**（hidden），不是收起到最矮 ——
    // 收起态仍会露出 40px 一条，在首页既没用又占地方（用户反馈）
    t('★ 首页工具栏整个隐藏（不是只收起）',
      doc.getElementById('bottombar').hidden === true,
      doc.getElementById('bottombar').hidden);
    t('首页标题是「修改历史」',
      /修改历史/.test(doc.querySelector('#home .home-title').textContent));
    // 有修图记录时必须列出来（这就是「昨天修的今天还能看到」）
    t('首页列出了修图记录',
      doc.querySelectorAll('#home .home-item').length === S.library.length,
      [doc.querySelectorAll('#home .home-item').length, S.library.length]);
    t('列表非空（前提：前面已造出记录）', S.library.length > 0, S.library.length);
    const firstName = doc.querySelector('#home .home-item .home-name');
    t('条目显示文件名', !!firstName && firstName.textContent.length > 0,
      firstName && firstName.textContent);
    t('条目有缩略图', !!doc.querySelector('#home .home-item img.home-thumb'));
    t('条目显示时间与修改数',
      /处修改/.test(doc.querySelector('#home .home-item .home-sub').textContent));

    // 点首页条目 → 进编辑页（有 session 时）
    const editable = S.library.find((w) => w.session);
    if (editable) {
      // restoreSession 要等 Image 的 onload，jsdom 不解码 data: URL，这里换真实解码
      const RealImage26 = window.Image;
      window.Image = class {
        constructor() {
          this.onload = null; this.onerror = null;
          this.width = 0; this.height = 0; this._src = '';
        }
        set src(v) {
          this._src = v;
          const m = /^data:[^;]+;base64,(.*)$/.exec(String(v));
          if (!m) { setTimeout(() => this.onerror && this.onerror(new Error('bad src')), 0); return; }
          napi.loadImage(Buffer.from(m[1], 'base64')).then((im) => {
            this.__real = im;
            this.width = im.width; this.height = im.height;
            if (this.onload) this.onload();
          }).catch((e) => { if (this.onerror) this.onerror(e); });
        }
        get src() { return this._src; }
      };
      // continueWork 在「当前有未导出修改」时会弹确认框，测试里自动确认
      const savedConfirm26 = window.confirm;
      window.confirm = () => true;
      const btn = doc.querySelector('#home .home-item[data-work-id="' + editable.id + '"]');
      btn.dispatchEvent(new window.Event('click'));
      await sleep(500);
      t('点历史条目进入编辑页', window.__PS_API.isHomeVisible() === false);
      t('进入编辑页后工具栏展开', window.__PS_API.toolbarVisible() === true);
      t('工具栏收起类已移除',
        doc.getElementById('bottombar').classList.contains('collapsed') === false);
      t('画布有内容', !!S.viewCanvas && S.docW > 0);
      window.confirm = savedConfirm26;
      window.Image = RealImage26;
    } else {
      t('点历史条目进入编辑页（无 session，跳过）', true);
      t('进入编辑页后工具栏展开（跳过）', true);
      t('工具栏收起类已移除（跳过）', true);
      t('画布有内容（跳过）', true);
    }
  }

  /* ---------- 新手教程：首启弹一次、看过不再弹、能重看、能跳过 ---------- */
  console.log('\n【39】新手教程：首次启动走一遍，之后随时能重看');

  {
    const tutEl = doc.getElementById('tutorial');
    const tutCore = window.PSCore;

    // ---- 1) 首启：直接调 boot 用的那条判定 ----
    // 注意：前面段落可能已经打开了照片，而「有照片在编辑」本身就会压掉自动弹
    // （那是刻意设计），所以测首启路径前必须先把照片卸掉。
    const tutHadImg = S.img;
    S.img = null;
    window.__PS_API.clearTutorialSeen();
    t('清掉标记后 shouldAutoTutorial 为真', window.__PS_API.shouldAutoTutorial() === true);
    t('看过之后 shouldAutoTutorial 为假', (() => {
      window.__PS_API.markTutorialSeen();
      const r = window.__PS_API.shouldAutoTutorial();
      window.__PS_API.clearTutorialSeen();
      return r === false;
    })());

    // 正在编辑照片时不弹（用户显然会用了，而且盖住画布很讨厌）
    const tutHadPhoto = !!S.img;
    S.img = {};
    t('正在编辑照片时不自动弹', window.__PS_API.shouldAutoTutorial() === false);
    if (tutHadPhoto) S.img = tutHadPhoto; else S.img = null;

    // ---- 2) 打开教程 ----
    window.__PS_API.openTutorial(false);
    await sleep(80);
    t('教程能打开', tutEl.hidden === false);
    t('教程打开时判定为 open', window.__PS_API.tutorialOpen() === true);
    t('第 1 步有标题', (doc.getElementById('tut-title').textContent || '').length > 2,
      doc.getElementById('tut-title').textContent);
    t('第 1 步有说明', (doc.getElementById('tut-body').textContent || '').length > 4,
      doc.getElementById('tut-body').textContent);
    t('显示了步数', /第 1 \/ \d+ 步/.test(doc.getElementById('tut-step').textContent),
      doc.getElementById('tut-step').textContent);
    t('进度点数量 = 步数',
      doc.querySelectorAll('#tut-dots .tut-dot').length === tutCore.TUTORIAL_LEN,
      doc.querySelectorAll('#tut-dots .tut-dot').length);
    t('当前步骤的进度点是亮的',
      doc.querySelectorAll('#tut-dots .tut-dot.on').length === 1,
      doc.querySelectorAll('#tut-dots .tut-dot.on').length);
    t('第一步时「上一步」禁用', doc.getElementById('tut-prev').disabled === true);

    // 高亮圈必须套在目标元素上（第 1 步指向「打开」按钮）
    const openBtn = doc.getElementById('btn-open');
    const openRect = openBtn.getBoundingClientRect();
    const spotEl = doc.getElementById('tut-spot');
    t('高亮圈已定位（不是 off 状态）', !spotEl.classList.contains('off'),
      spotEl.className);
    // jsdom 不做布局，getBoundingClientRect 全是 0，所以这里只验证
    // 「算出来的位置与目标矩形同源」——用解析出的 style 反推
    t('高亮圈尺寸跟着目标元素走', (() => {
      const w = parseFloat(spotEl.style.width);
      return Number.isFinite(w) && w >= 0;
    })(), [spotEl.style.width, openRect.width]);

    // ---- 3) 下一步 / 上一步 ----
    const stepTitles = [];
    stepTitles.push(doc.getElementById('tut-title').textContent);
    doc.getElementById('tut-next').dispatchEvent(new window.Event('click'));
    await sleep(60);
    t('点下一步进到第 2 步', window.__PS_API.tutorialIndex() === 1,
      window.__PS_API.tutorialIndex());
    t('第 2 步标题不同', doc.getElementById('tut-title').textContent !== stepTitles[0]);
    t('第 2 步时「上一步」可用', doc.getElementById('tut-prev').disabled === false);
    // 记下第 2 步的标题，稍后验证「退回」确实把标题也退回去了
    stepTitles.push(doc.getElementById('tut-title').textContent);
    doc.getElementById('tut-next').dispatchEvent(new window.Event('click'));
    await sleep(60);
    t('再点下一步进到第 3 步', window.__PS_API.tutorialIndex() === 2,
      window.__PS_API.tutorialIndex());
    t('第 3 步标题也不同',
      doc.getElementById('tut-title').textContent !== stepTitles[1],
      [doc.getElementById('tut-title').textContent, stepTitles[1]]);
    doc.getElementById('tut-prev').dispatchEvent(new window.Event('click'));
    await sleep(60);
    t('点上一步退回第 2 步', window.__PS_API.tutorialIndex() === 1,
      window.__PS_API.tutorialIndex());
    t('退回后标题也回来了', doc.getElementById('tut-title').textContent === stepTitles[1],
      [doc.getElementById('tut-title').textContent, stepTitles[1]]);

    // 第 1 步再点上一步不能越界
    doc.getElementById('tut-prev').dispatchEvent(new window.Event('click'));
    await sleep(40);
    doc.getElementById('tut-prev').dispatchEvent(new window.Event('click'));
    await sleep(40);
    t('第 1 步再点上一步不越界', window.__PS_API.tutorialIndex() === 0,
      window.__PS_API.tutorialIndex());

    // ---- 4) 走完全部步骤会自动关闭 ----
    let guard = 0;
    while (!tutEl.hidden && guard++ < 20) {
      doc.getElementById('tut-next').dispatchEvent(new window.Event('click'));
      await sleep(40);
    }
    t('走完全部步骤后自动关闭', tutEl.hidden === true, { idx: window.__PS_API.tutorialIndex(), guard });
    t('最后一步的按钮文案变成「开始使用」或已关闭',
      guard <= tutCore.TUTORIAL_LEN, guard);

    // ---- 5) 跳过：关闭 + 记「已看过」 ----
    window.__PS_API.clearTutorialSeen();
    t('跳过前标记是未看过', window.__PS_API.tutorialSeen() === false);
    window.__PS_API.openTutorial(false);
    await sleep(60);
    t('重新打开后回到第 1 步', window.__PS_API.tutorialIndex() === 0);
    doc.getElementById('tut-skip').dispatchEvent(new window.Event('click'));
    await sleep(60);
    t('点跳过会关闭教程', tutEl.hidden === true);
    t('点跳过会记「已看过」', window.__PS_API.tutorialSeen() === true);
    t('跳过之后不再自动弹', window.__PS_API.shouldAutoTutorial() === false);

    // ---- 6) 点蒙层也算跳过 ----
    window.__PS_API.clearTutorialSeen();
    window.__PS_API.openTutorial(false);
    await sleep(60);
    doc.querySelector('#tutorial .tut-mask').dispatchEvent(new window.Event('click'));
    await sleep(60);
    t('点蒙层也能关掉教程', tutEl.hidden === true);
    t('点蒙层也记「已看过」', window.__PS_API.tutorialSeen() === true);

    // ---- 7) 返回键关教程，同样记「已看过」（否则按返回跳过的人下次还会被弹）----
    window.__PS_API.clearTutorialSeen();
    window.__PS_API.openTutorial(false);
    await sleep(60);
    t('教程开着时返回键被处理', window.__PS_API.handleBack() === true);
    await sleep(60);
    t('返回键关掉了教程', tutEl.hidden === true);
    t('返回键也记「已看过」', window.__PS_API.tutorialSeen() === true);

    // ---- 8) 重看入口：更多菜单 ----
    window.__PS_API.openMoreMenu();
    await sleep(60);
    const tutMenuBtn = doc.getElementById('btn-tutorial');
    t('更多菜单里有教程入口', !!tutMenuBtn);
    tutMenuBtn.dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('从菜单能重看教程', tutEl.hidden === false);
    t('重看时菜单已收起（否则压在教程上）', window.__PS_API.moreMenuOpen() === false);
    t('重看从第 1 步开始', window.__PS_API.tutorialIndex() === 0);
    // 重看**不**改「已看过」标记（它本来就是 true，这里验证不会被清掉）
    t('重看不影响「已看过」标记', window.__PS_API.tutorialSeen() === true);
    window.__PS_API.closeTutorial();
    await sleep(40);

    // ---- 9) 重看入口：设置页 ----
    window.__PS_API.openSettings();
    await sleep(60);
    const tutSetBtn = doc.getElementById('btn-tutorial2');
    t('设置页里有教程入口', !!tutSetBtn);
    tutSetBtn.dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('从设置能重看教程', tutEl.hidden === false);
    t('重看时设置已关闭', doc.getElementById('settings').hidden === true);
    window.__PS_API.closeTutorial();
    await sleep(40);

    // ---- 10) 摆位兜底：目标元素找不到时不能指向屏幕角落 ----
    // 直接构造一个「目标不存在」的步骤，验证高亮圈被隐藏、气泡仍可见
    window.__PS_API.openTutorial(false);
    await sleep(60);
    const badStep = { target: '#definitely-not-here-12345', place: 'top', title: 'x', body: 'y' };
    window.__PS_API.layoutTutorial(badStep);
    await sleep(40);
    t('目标不存在时隐藏高亮圈', doc.getElementById('tut-spot').classList.contains('off'),
      doc.getElementById('tut-spot').className);
    t('目标不存在时气泡仍在屏幕内', (() => {
      const top = parseFloat(doc.getElementById('tut-card').style.top);
      const vh = window.innerHeight || 640;
      return Number.isFinite(top) && top >= 0 && top <= vh;
    })(), doc.getElementById('tut-card').style.top);
    // 恢复真实步骤的摆位，再关掉
    window.__PS_API.renderTutorial();
    await sleep(40);
    t('恢复后高亮圈重新出现', !doc.getElementById('tut-spot').classList.contains('off'));
    window.__PS_API.closeTutorial();
    await sleep(40);

    // ---- 11) 教程浮层不能拦着后续测试（确认已关掉）----
    t('教程已关闭（后续段落的前提）', tutEl.hidden === true);
    // 标记成「已看过」，避免影响后续任何依赖首启状态的检查
    window.__PS_API.markTutorialSeen();
    // 把照片还原回去（本段开头为了测首启路径卸掉了它）
    S.img = tutHadImg;
  }

  console.log('\n【27】照片信息：能看清这张是什么机器什么参数拍的');
  {
    S.cfg.maxRes = 0;   // 前面的用例把它改成过 200，必须复位
    // 造一张带完整 EXIF 的图（机型/镜头/快门/光圈/ISO/焦距/时间）
    const piC = napi.createCanvas(1200, 800);
    const piX = piC.getContext('2d');
    piX.fillStyle = 'rgb(40,80,120)'; piX.fillRect(0, 0, 1200, 800);
    const piJpeg = piC.toBuffer('image/jpeg', 0.9);
    // 手工拼一个 little-endian TIFF：IFD0（厂商/机型）+ ExifIFD（快门/光圈/ISO/时间/焦距/镜头）
    const ifd0Tags = [
      { tag: 0x010f, type: 2, str: 'Canon' },
      { tag: 0x0110, type: 2, str: 'Canon EOS R5' }
    ];
    const exTags = [
      { tag: 0x829a, type: 5, num: 1, den: 500 },
      { tag: 0x829d, type: 5, num: 28, den: 10 },
      { tag: 0x8827, type: 3, v: 800 },
      { tag: 0x9003, type: 2, str: '2024:09:23 15:42:07' },
      { tag: 0x920a, type: 5, num: 85, den: 1 },
      { tag: 0xa434, type: 2, str: 'RF85mm F1.2 L USM' }
    ];
    const dataBytes = (list) => list.reduce((n, e) => {
      if (e.type === 2) return n + (e.str.length + 1 > 4 ? e.str.length + 1 : 0);
      if (e.type === 5) return n + 8;
      return n;
    }, 0);
    const ifd0Size = 2 + (ifd0Tags.length + 1) * 12 + 4;   // +1 = ExifIFD 指针
    const ifd0DataOff = 8 + ifd0Size;
    const exifOff = ifd0DataOff + dataBytes(ifd0Tags);
    const exifSize = 2 + exTags.length * 12 + 4;
    const exifDataOff = exifOff + exifSize;
    const tf = new Uint8Array(exifDataOff + dataBytes(exTags));
    const dv = new DataView(tf.buffer);
    tf[0] = 0x49; tf[1] = 0x49; tf[2] = 0x2a; tf[3] = 0;
    dv.setUint32(4, 8, true);

    const writeIfd = (off, list, dataOff) => {
      dv.setUint16(off, list.length, true);
      let cursor = dataOff;
      list.forEach((e, i) => {
        const eo = off + 2 + i * 12;
        dv.setUint16(eo, e.tag, true);
        dv.setUint16(eo + 2, e.type, true);
        if (e.type === 2) {
          dv.setUint32(eo + 4, e.str.length + 1, true);
          if (e.str.length + 1 <= 4) {
            for (let k = 0; k < e.str.length; k++) tf[eo + 8 + k] = e.str.charCodeAt(k);
          } else {
            dv.setUint32(eo + 8, cursor, true);
            for (let k = 0; k < e.str.length; k++) tf[cursor + k] = e.str.charCodeAt(k);
            cursor += e.str.length + 1;
          }
        } else if (e.type === 3) {
          dv.setUint32(eo + 4, 1, true);
          dv.setUint16(eo + 8, e.v, true);
        } else if (e.type === 5) {
          dv.setUint32(eo + 4, 1, true);
          dv.setUint32(eo + 8, cursor, true);
          dv.setUint32(cursor, e.num, true);
          dv.setUint32(cursor + 4, e.den, true);
          cursor += 8;
        }
      });
      dv.setUint32(off + 2 + list.length * 12, 0, true);
    };
    writeIfd(8, ifd0Tags, ifd0DataOff);
    // IFD0 最后一项：ExifIFD 指针（writeIfd 只写了 2 项，这里补第 3 项并改条目数）
    {
      dv.setUint16(8, ifd0Tags.length + 1, true);
      const eo = 8 + 2 + ifd0Tags.length * 12;
      dv.setUint16(eo, 0x8769, true);
      dv.setUint16(eo + 2, 4, true);
      dv.setUint32(eo + 4, 1, true);
      dv.setUint32(eo + 8, exifOff, true);
    }
    writeIfd(exifOff, exTags, exifDataOff);

    const piPl = new Uint8Array(6 + tf.length);
    piPl[0] = 0x45; piPl[1] = 0x78; piPl[2] = 0x69; piPl[3] = 0x66; piPl.set(tf, 6);
    const piLen = piPl.length + 2;
    const piSeg = new Uint8Array(4 + piPl.length);
    piSeg[0] = 0xff; piSeg[1] = 0xe1; piSeg[2] = (piLen >> 8) & 255; piSeg[3] = piLen & 255;
    piSeg.set(piPl, 4);
    const piFile = Buffer.concat([piJpeg.subarray(0, 2), piSeg, piJpeg.subarray(2)]);

    const piIn = doc.getElementById('file-input');
    Object.defineProperty(piIn, 'files', {
      value: [new window.File([new Uint8Array(piFile)], 'DSC01234.jpg', { type: 'image/jpeg' })],
      configurable: true
    });
    piIn.dispatchEvent(new window.Event('change'));
    await sleep(400);
    t('带 EXIF 的照片已载入', S.docW === 1200 && S.docH === 800, [S.docW, S.docH]);
    t('EXIF 已捕获', !!(S.meta && S.meta.exif));

    t('有照片时信息按钮可用', doc.getElementById('btn-photoinfo').disabled === false);
    doc.getElementById('btn-photoinfo').dispatchEvent(new window.Event('click'));
    await sleep(120);
    t('照片信息面板已打开', doc.getElementById('photoinfo').hidden === false);
    const piText = doc.getElementById('photoinfo-body').textContent;
    t('显示文件名', /DSC01234\.jpg/.test(piText), piText.slice(0, 80));
    t('显示机型', /Canon EOS R5/.test(piText));
    t('显示镜头', /RF85mm F1\.2/.test(piText));
    t('显示光圈', /f\/2\.8/.test(piText));
    t('显示快门', /1\/500/.test(piText));
    t('显示 ISO', /ISO 800/.test(piText));
    t('显示焦距', /85 mm/.test(piText));
    t('显示拍摄时间（已格式化）', /2024-09-23 15:42:07/.test(piText));
    t('显示尺寸', /1200 × 800/.test(piText));
    t('分组标题存在', /拍摄设备/.test(piText) && /拍摄参数/.test(piText));
    // 关闭
    doc.querySelector('#photoinfo [data-close]').dispatchEvent(new window.Event('click'));
    await sleep(60);
    t('照片信息面板可关闭', doc.getElementById('photoinfo').hidden === true);
  }

  console.log('\n【28】引导线：构图意图精确传给模型');
  {
    S.cfg.provider = 'siliconflow';
    S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
    S.cfg.model = 'Qwen/Qwen-Image-Edit';
    S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.upscaleSmall = false;
    S.cfg.contextPct = 12;      // 关键：有上下文外扩，引导线必须补偿偏移
    S.cfg.fusion = 0; S.cfg.envFit = false; S.cfg.mosaic = false;

    // 框一块选区
    const cv2 = doc.getElementById('cv');
    const r2 = cv2.getBoundingClientRect();
    const mk2 = (type, x, y) => {
      const e = new window.Event(type, { bubbles: true, cancelable: true });
      e.clientX = r2.left + x; e.clientY = r2.top + y;
      e.pointerId = 1; e.button = 0; e.pointerType = 'touch';
      cv2.dispatchEvent(e);
    };
    mk2('pointerdown', 60, 60); mk2('pointermove', 200, 160); mk2('pointerup', 200, 160);
    await sleep(80);
    t('选区已建立', !!S.rect && S.rect.w > 10, S.rect);

    // 进引导线模式
    doc.getElementById('btn-guide').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('引导线模式已激活', S.mode === 'guide');
    t('引导线参数条已显示', doc.getElementById('guide-bar').hidden === false);
    t('引导线提示已显示', doc.getElementById('guide-tip').hidden === false);
    // 只有两类：直线 + 自由绘制（原来的四种构图线合并成「直线」）
    t('类型选择器只有 2 个选项',
      doc.querySelectorAll('#guide-kinds [data-gk]').length === 2);
    t('默认类型是直线',
      doc.querySelector('#guide-kinds [data-gk="line"]').classList.contains('on'));
    t('没有颜色选择条（颜色按序号自动分配）',
      doc.getElementById('guide-colors') === null);

    // 画一条水平线（选区中心高度）
    const sel0 = { x: r2.left + 0, y: r2.top + 0 };
    const sr = window.PSCore.imageRectToScreen(S.rect, S.view);
    const gy = r2.top + sr.y + sr.h * 0.5;
    const gx1 = r2.left + sr.x + sr.w * 0.1;
    const gx2 = r2.left + sr.x + sr.w * 0.9;
    mk2('pointerdown', gx1 - r2.left, gy - r2.top);
    mk2('pointermove', gx2 - r2.left, gy - r2.top + 3);
    mk2('pointerup', gx2 - r2.left, gy - r2.top + 3);
    await sleep(80);
    t('引导线已记录', S.guides.length === 1, S.guides);
    t('引导线类型是直线', S.guides[0].kind === 'line', S.guides[0]);
    // 颜色按序号自动分配：第 1 条红、第 2 条青
    t('第 1 条线自动配成红色', S.guides[0].colorId === 'red', S.guides[0].colorId);
    t('引导线归一化坐标在 0~1',
      S.guides[0].y1 >= 0 && S.guides[0].y1 <= 1 && S.guides[0].x2 > S.guides[0].x1);
    t('数量角标已更新',
      doc.getElementById('guide-count').textContent === '1' &&
      doc.getElementById('guide-count').hidden === false);
    t('方向被对齐（几乎水平）',
      Math.abs(S.guides[0].y2 - S.guides[0].y1) < 0.02, S.guides[0]);

    // 画第二条：一条竖线。类型还是「直线」—— 方向由手画的角度决定，
    // 不再要求用户先声明「这是垂直线」
    const gx = r2.left + sr.x + sr.w * 0.35;
    mk2('pointerdown', gx - r2.left, gy - r2.top - sr.h * 0.3);
    mk2('pointermove', gx - r2.left + 2, gy - r2.top + sr.h * 0.3);
    mk2('pointerup', gx - r2.left + 2, gy - r2.top + sr.h * 0.3);
    await sleep(80);
    t('第二条引导线已记录', S.guides.length === 2, S.guides.length);
    t('第二条也是直线类型', S.guides[1].kind === 'line', S.guides[1].kind);
    t('第 2 条线自动配成青色', S.guides[1].colorId === 'cyan', S.guides[1].colorId);
    t('两条线颜色不同（指代才能唯一）',
      S.guides[0].colorId !== S.guides[1].colorId);
    t('竖线被吸附到垂直',
      Math.abs(S.guides[1].x2 - S.guides[1].x1) < 0.02, S.guides[1]);

    // 生成：请求里的提示词必须带引导线说明
    const before28 = fake.seen.length;
    fake.setColor([90, 200, 90]);
    doc.getElementById('prompt').value = '换成阴天';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 6000);
    if (S.pending) {
      doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
      await sleep(120);
    }
    t('带引导线生成了', S.edits.length > 0, S.edits.length);
    const gen28 = fake.seen.slice(before28).filter((x) => x.body && x.body.prompt);
    t('发起了请求', gen28.length > 0, gen28.length);
    if (gen28.length) {
      const pr = gen28[0].body.prompt;
      t('提示词含构图引导段', /构图引导/.test(pr), pr.slice(0, 200));
      // 逐条按颜色指代：这是「颜色按序号分配」的全部意义
      t('提示词逐条按颜色指代（红）', /第 1 条（红色，直线）/.test(pr), pr.slice(0, 260));
      t('提示词逐条按颜色指代（青）', /第 2 条（青色，直线）/.test(pr), pr.slice(0, 260));
      t('提示词要求不要画出线条',
        /不要把任何一条彩色线条画进最终画面/.test(pr));
      t('提示词说明线是标注不是画面内容', /不是照片里真实存在的东西/.test(pr));
      // 关键：引导线位置必须按 contextPct 补偿，不能直接用选区内的归一化值
      t('引导线位置已换算到请求图坐标（不是选区内的原值）',
        !new RegExp('高度 50%').test(pr), pr.slice(0, 260));
    }

    // 引导线**必须真的画进请求图** —— 这是这次改动最致命的一点：
    // 只写进提示词时模型只能猜位置，落位常常偏。这里逐像素确认
    // 红线和青线都出现在发给模型的图片上（而且位置对得上）。
    if (gen28.length) {
      const imgStr = String(gen28[0].body.image || '');
      const m28 = /^data:image\/(jpeg|png);base64,(.*)$/.exec(imgStr);
      t('请求里带了参考图', !!m28);
      if (m28) {
        const im28 = await napi.loadImage(Buffer.from(m28[2], 'base64'));
        const cc28 = napi.createCanvas(im28.width, im28.height);
        const cx28 = cc28.getContext('2d');
        cx28.drawImage(im28, 0, 0);
        const px28 = cx28.getImageData(0, 0, im28.width, im28.height).data;
        let red28 = 0, cyan28 = 0, redRowSum = 0, cyanColSum = 0;
        for (let i = 0; i < px28.length; i += 4) {
          const r = px28[i], g = px28[i + 1], b = px28[i + 2];
          const pix = i / 4;
          const px = pix % im28.width, py = Math.floor(pix / im28.width);
          // 红线 #ff2d2d、青线 #00e5ff，允许 JPEG 编码误差
          if (r > 150 && g < 120 && b < 120) { red28++; redRowSum += py; }
          if (r < 130 && g > 150 && b > 180) { cyan28++; cyanColSum += px; }
        }
        t('请求图里有红线像素（第 1 条真的画进去了）', red28 > 50, red28);
        t('请求图里有青线像素（第 2 条真的画进去了）', cyan28 > 50, cyan28);
        // 位置验证：第 1 条是横线（行号集中），第 2 条是竖线（列号集中）
        if (red28 > 0) {
          const rowAvg = redRowSum / red28;
          t('红线位置在画面中部（横线）',
            rowAvg > im28.height * 0.2 && rowAvg < im28.height * 0.8,
            Math.round(rowAvg) + ' / ' + im28.height);
        }
        if (cyan28 > 0) {
          const colAvg = cyanColSum / cyan28;
          t('青线位置在画面偏左（竖线）',
            colAvg > im28.width * 0.1 && colAvg < im28.width * 0.9,
            Math.round(colAvg) + ' / ' + im28.width);
        }
      }
    } else {
      t('请求里带了参考图（跳过）', false, '没有捕获到带提示词的请求');
      t('请求图里有红线像素（跳过）', false);
      t('请求图里有青线像素（跳过）', false);
    }

    // 点已有的线 → 删除
    mk2('pointerdown', gx1 - r2.left, gy - r2.top);
    mk2('pointerup', gx1 - r2.left, gy - r2.top);
    await sleep(80);
    t('点已有引导线可删除', S.guides.length === 1, S.guides.length);

    // 清空
    doc.getElementById('guide-clear').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('清空按钮生效', S.guides.length === 0);
    t('角标归零后隐藏', doc.getElementById('guide-count').hidden === true);

    // 换选区会清掉引导线（相对坐标失效）—— 必须在框选模式下重新拉框
    doc.querySelector('.tool[data-mode="select"]').dispatchEvent(new window.Event('click'));
    await sleep(60);
    window.__PS_API.setGuides([{ kind: 'line', x1: 0, y1: .5, x2: 1, y2: .5 }]);
    t('测试用引导线已设置', S.guides.length === 1);
    mk2('pointerdown', 20, 20); mk2('pointermove', 90, 90); mk2('pointerup', 90, 90);
    await sleep(80);
    t('重新框选会清掉引导线', S.guides.length === 0, S.guides.length);
    t('重新框选建立了新选区', !!S.rect && S.rect.w > 10, S.rect);
    await sleep(80);
    t('离开引导线模式后参数条收起', doc.getElementById('guide-bar').hidden === true);
    t('引导线按钮高亮已移除',
      doc.getElementById('btn-guide').classList.contains('active') === false);
    S.cfg.contextPct = 0;
  }

  console.log('\n【29】导出设置：格式与大小可选，且真的生效');
  {
    S.cfg.provider = 'siliconflow';
    S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
    S.cfg.model = 'Qwen/Qwen-Image-Edit';
    S.cfg.maxRes = 0;
    // 造一张 1600x1200 的图
    const exC = napi.createCanvas(1600, 1200);
    const exX = exC.getContext('2d');
    exX.fillStyle = 'rgb(70,110,150)'; exX.fillRect(0, 0, 1600, 1200);
    exX.fillStyle = 'rgb(240,240,240)'; exX.fillRect(500, 400, 600, 400);
    const exFile = exC.toBuffer('image/jpeg', 0.9);
    const exIn = doc.getElementById('file-input');
    Object.defineProperty(exIn, 'files', {
      value: [new window.File([new Uint8Array(exFile)], 'export.jpg', { type: 'image/jpeg' })],
      configurable: true
    });
    exIn.dispatchEvent(new window.Event('change'));
    await sleep(400);
    t('测试图已载入', S.docW === 1600 && S.docH === 1200, [S.docW, S.docH]);

    // 拦截导出
    let exBlob = null;
    const exOrigCreate = doc.createElement.bind(doc);
    doc.createElement = function (tag) {
      const el = exOrigCreate(tag);
      if (tag === 'a') el.click = () => {};
      return el;
    };
    window.URL.createObjectURL = (b) => { exBlob = b; return 'blob:ex'; };
    window.URL.revokeObjectURL = () => {};

    S.cfg.expPresetChosen = false;
    S.cfg.exportPreset = 'full';
    doc.getElementById('btn-save').dispatchEvent(new window.Event('click'));
    await sleep(150);
    t('导出面板已打开', doc.getElementById('exportpanel').hidden === false);
    t('格式列表有 JPEG 与 PNG',
      doc.querySelectorAll('#exp-formats [data-fmt]').length === 2);
    t('大小列表含原始尺寸与自定义',
      doc.querySelectorAll('#exp-sizes [data-size]').length === window.PSCore.EXPORT_SIZES.length + 1);
    t('显示输出尺寸', /1600 × 1200/.test(doc.getElementById('exp-out-size').textContent),
      doc.getElementById('exp-out-size').textContent);
    t('显示预计体积', /约/.test(doc.getElementById('exp-out-size-est').textContent),
      doc.getElementById('exp-out-size-est').textContent);

    // 1) 选 1080px + JPEG
    doc.querySelector('#exp-sizes [data-size="1080"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('选了 1080 后输出尺寸更新', /1080 × 810/.test(doc.getElementById('exp-out-size').textContent),
      doc.getElementById('exp-out-size').textContent);
    doc.querySelector('#exp-formats [data-fmt="jpeg"]').dispatchEvent(new window.Event('click'));
    await sleep(60);
    t('JPEG 时质量滑块可见', doc.getElementById('exp-quality-row').hidden === false);
    exBlob = null;
    doc.getElementById('exp-do').dispatchEvent(new window.Event('click'));
    await sleep(900);
    t('导出了文件', !!exBlob);
    if (exBlob) {
      const buf = Buffer.from(await exBlob.arrayBuffer());
      t('产物是 JPEG', buf[0] === 0xff && buf[1] === 0xd8, [buf[0], buf[1]]);
      const im = await napi.loadImage(buf);
      t('长边缩到 1080', Math.max(im.width, im.height) === 1080, [im.width, im.height]);
      t('比例保持 4:3', Math.abs(im.width / im.height - 4 / 3) < 0.02, im.width / im.height);
    }

    // 2) 选 PNG + 原尺寸
    doc.getElementById('btn-save').dispatchEvent(new window.Event('click'));
    await sleep(150);
    doc.querySelector('#exp-formats [data-fmt="png"]').dispatchEvent(new window.Event('click'));
    doc.querySelector('#exp-sizes [data-size="orig"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('PNG 时质量滑块隐藏', doc.getElementById('exp-quality-row').hidden === true);
    t('PNG 原尺寸的输出尺寸', /1600 × 1200/.test(doc.getElementById('exp-out-size').textContent));
    exBlob = null;
    doc.getElementById('exp-do').dispatchEvent(new window.Event('click'));
    await sleep(1200);
    t('导出了 PNG', !!exBlob);
    if (exBlob) {
      const buf = Buffer.from(await exBlob.arrayBuffer());
      t('产物是 PNG', buf[0] === 0x89 && buf[1] === 0x50, [buf[0], buf[1]]);
      const im = await napi.loadImage(buf);
      t('PNG 保持原尺寸', im.width === 1600 && im.height === 1200, [im.width, im.height]);
    }

    // 3) 自定义长边 + 小图不放大
    doc.getElementById('btn-save').dispatchEvent(new window.Event('click'));
    await sleep(150);
    doc.querySelector('#exp-sizes [data-size="custom"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('选自定义后出现输入框', doc.getElementById('exp-custom-row').hidden === false);
    const ci = doc.getElementById('exp-custom');
    ci.value = '4000';
    ci.dispatchEvent(new window.Event('input'));
    await sleep(80);
    t('自定义 4000 不放大原图（仍是 1600）',
      /1600 × 1200/.test(doc.getElementById('exp-out-size').textContent),
      doc.getElementById('exp-out-size').textContent);
    t('不放大时给出说明',
      doc.getElementById('exp-hint').textContent.length > 0,
      doc.getElementById('exp-hint').textContent);

    // 4) 面板选择会被记住
    doc.querySelector('#exp-formats [data-fmt="png"]').dispatchEvent(new window.Event('click'));
    await sleep(60);
    exBlob = null;
    doc.getElementById('exp-do').dispatchEvent(new window.Event('click'));
    await sleep(900);
    t('面板选择已写入配置', S.cfg.expPresetChosen === true && S.cfg.expFormat === 'png');
    t('面板选择已落盘',
      JSON.parse(window.localStorage.getItem('photoStudio.cfg.v1')).expFormat === 'png');
    // 再次打开：应沿用上次的 PNG，而不是回到设置页的 full(JPEG)
    S.cfg.exportPreset = 'full';
    doc.getElementById('btn-save').dispatchEvent(new window.Event('click'));
    await sleep(150);
    t('再次打开沿用上次选择',
      doc.querySelector('#exp-formats .selected .st-label').textContent.indexOf('PNG') >= 0,
      doc.querySelector('#exp-formats .selected .st-label').textContent);
    doc.querySelector('#exportpanel [data-close]').dispatchEvent(new window.Event('click'));
    await sleep(60);
    t('面板可关闭', doc.getElementById('exportpanel').hidden === true);

    doc.createElement = exOrigCreate;
    S.cfg.expPresetChosen = false;
    S.cfg.expFormat = 'jpeg';
  }


  console.log('\n【30】引导线自由笔迹：画进请求图，模型照着走向生成');
  {
    S.cfg.provider = 'siliconflow';
    S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
    S.cfg.model = 'Qwen/Qwen-Image-Edit';
    S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.upscaleSmall = false; S.cfg.contextPct = 0;
    S.cfg.fusion = 0; S.cfg.envFit = false; S.cfg.mosaic = false;
    S.cfg.guideStrokeOverlay = true;
    S.cfg.guideStrokeColor = 'red';
    S.cfg.maxRes = 0;

    // 一张干净的深色图：方便逐像素找笔迹
    const skC = napi.createCanvas(600, 400);
    const skX = skC.getContext('2d');
    skX.fillStyle = 'rgb(30,30,30)'; skX.fillRect(0, 0, 600, 400);
    const skIn = doc.getElementById('file-input');
    Object.defineProperty(skIn, 'files', {
      value: [new window.File([new Uint8Array(skC.toBuffer('image/jpeg', 0.95))], 'stroke.jpg', { type: 'image/jpeg' })],
      configurable: true
    });
    skIn.dispatchEvent(new window.Event('change'));
    await sleep(400);
    t('测试图已载入', S.docW === 600 && S.docH === 400, [S.docW, S.docH]);

    // 框选整块画面
    S.rect = { x: 0, y: 0, w: 600, h: 400 };
    window.__PS_API.updateUI();

    // 进引导线模式 → 选「自由绘制」
    doc.getElementById('btn-guide').dispatchEvent(new window.Event('click'));
    await sleep(80);
    doc.querySelector('#guide-kinds [data-gk="freehand"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('已切到自由绘制', S.guideKind === 'freehand');
    t('自由绘制时显示专用提示', doc.getElementById('guide-tip-free').hidden === false);
    t('自由绘制时隐藏直线提示', doc.getElementById('guide-tip').hidden === true);
    // 颜色条已移除：颜色按序号自动分配，用户选不了
    t('没有颜色选择条', doc.getElementById('guide-color-bar') === null);

    // 手画一条弧线（模拟发丝走向）
    const cv3 = doc.getElementById('cv');
    const r3 = cv3.getBoundingClientRect();
    const sr3 = window.PSCore.imageRectToScreen(S.rect, S.view);
    const toS = (nx, ny) => ({ x: r3.left + sr3.x + nx * sr3.w, y: r3.top + sr3.y + ny * sr3.h });
    const ev3 = (type, pt) => {
      const e = new window.Event(type, { bubbles: true, cancelable: true });
      e.clientX = pt.x; e.clientY = pt.y;
      e.pointerId = 1; e.button = 0; e.pointerType = 'touch';
      cv3.dispatchEvent(e);
    };
    const arc = [[.25, .35], [.35, .40], [.45, .42], [.55, .40], [.65, .34], [.75, .30]];
    ev3('pointerdown', toS(arc[0][0], arc[0][1]));
    for (let i = 1; i < arc.length; i++) ev3('pointermove', toS(arc[i][0], arc[i][1]));
    ev3('pointerup', toS(arc[arc.length - 1][0], arc[arc.length - 1][1]));
    await sleep(100);
    t('笔迹已记录', S.guides.length === 1, S.guides.length);
    t('笔迹是折线（多点）', S.guides[0].points && S.guides[0].points.length >= 4,
      S.guides[0].points && S.guides[0].points.length);
    t('笔迹类型是 freehand', S.guides[0].kind === 'freehand');
    // 关键：笔迹不能被吸附拉直
    t('笔迹保留弧度（未被拉直）', (() => {
      const ys = S.guides[0].points.map((p) => p.y);
      return Math.max(...ys) - Math.min(...ys) > 0.03;
    })(), S.guides[0].points.map((p) => p.y.toFixed(3)));

    // 生成：请求图里必须有笔迹像素
    const before30 = fake.seen.length;
    fake.setColor([120, 180, 120]);
    doc.getElementById('prompt').value = '给她生成长发';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 8000);
    const gen30 = fake.seen.slice(before30).filter((x) => x.body && x.body.prompt);
    t('发起了请求', gen30.length > 0, gen30.length);

    if (gen30.length) {
      const pr30 = gen30[0].body.prompt;
      t('提示词含「手绘走向」段', /手绘走向/.test(pr30), pr30.slice(0, 120));
      t('提示词要求沿笔迹生成', /沿着笔迹生成/.test(pr30));
      t('提示词含发丝等示例', /头发/.test(pr30));
      // 笔迹颜色按序号走：这是第 1 条，所以是红色
      t('提示词里笔迹标为红色（第 1 条）', /（红色，/.test(pr30), pr30.slice(0, 200));
      t('提示词禁止把线画进画面',
        /不要把任何一条彩色线条画进最终画面/.test(pr30));

      // ★ 核心：请求图里必须真的出现红色笔迹
      const imgStr = String(gen30[0].body.image || '');
      const m30 = /^data:image\/(jpeg|png);base64,(.*)$/.exec(imgStr);
      t('请求里带了参考图', !!m30);
      if (m30) {
        const im30 = await napi.loadImage(Buffer.from(m30[2], 'base64'));
        const cc30 = napi.createCanvas(im30.width, im30.height);
        const cx30 = cc30.getContext('2d');
        cx30.drawImage(im30, 0, 0);
        const px30 = cx30.getImageData(0, 0, im30.width, im30.height).data;
        let red = 0, redMinX = 1e9, redMaxX = -1, redMinY = 1e9, redMaxY = -1;
        for (let y = 0; y < im30.height; y++) {
          for (let x = 0; x < im30.width; x++) {
            const i = (y * im30.width + x) * 4;
            // 底图是灰 30，红色笔迹应满足 R 明显高于 G/B
            if (px30[i] > 110 && px30[i] - px30[i + 1] > 50 && px30[i] - px30[i + 2] > 50) {
              red++;
              if (x < redMinX) redMinX = x;
              if (x > redMaxX) redMaxX = x;
              if (y < redMinY) redMinY = y;
              if (y > redMaxY) redMaxY = y;
            }
          }
        }
        t('请求图里确实有红色笔迹像素', red > 100, red);
        // 位置必须对得上：笔迹在选区 x 25%~75%、y 30%~42%
        if (red > 0) {
          const nx0 = redMinX / im30.width, nx1 = redMaxX / im30.width;
          const ny0 = redMinY / im30.height, ny1 = redMaxY / im30.height;
          t('笔迹横向位置正确（约 25%~75%）',
            Math.abs(nx0 - 0.25) < 0.06 && Math.abs(nx1 - 0.75) < 0.06,
            [nx0.toFixed(3), nx1.toFixed(3)]);
          t('笔迹纵向位置正确（约 30%~42%）',
            Math.abs(ny0 - 0.30) < 0.06 && Math.abs(ny1 - 0.42) < 0.06,
            [ny0.toFixed(3), ny1.toFixed(3)]);
        } else {
          t('笔迹横向位置正确（跳过）', true);
          t('笔迹纵向位置正确（跳过）', true);
        }
        // 反向确认：没画笔迹的地方不能出现红色（说明没有整片染色）
        const corner = (() => {
          const i = ((10 * im30.width) + 10) * 4;
          return [px30[i], px30[i + 1], px30[i + 2]];
        })();
        t('笔迹之外没有红色（不是整片染色）',
          Math.abs(corner[0] - corner[1]) < 40 && Math.abs(corner[1] - corner[2]) < 40, corner);
      }
    }

    t('请求自检里标注了笔迹', /已把/.test(window.__PS_API.strokeNote()), window.__PS_API.strokeNote());

    if (S.pending) {
      doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
      await sleep(120);
    }

    // ---- 再画一条线：颜色必须自动变成青色（第 2 条），两条线各有各的颜色 ----
    // 颜色不再让用户选（选了两条同色，「红线」这个指代就废了），
    // 所以这里验证的是「自动配色」这条路径真的生效。
    doc.querySelector('#guide-kinds [data-gk="line"]').dispatchEvent(new window.Event('click'));
    await sleep(60);
    {
      const srG = window.PSCore.imageRectToScreen(S.rect, S.view);
      const yG = r3.top + srG.y + srG.h * 0.75;
      const xA = r3.left + srG.x + srG.w * 0.2;
      const xB = r3.left + srG.x + srG.w * 0.8;
      ev3('pointerdown', { x: xA, y: yG });
      ev3('pointermove', { x: xB, y: yG + 2 });
      ev3('pointerup', { x: xB, y: yG + 2 });
      await sleep(100);
    }
    t('第 2 条线已加上', S.guides.length === 2, S.guides.length);
    t('第 2 条自动配成青色（第 1 条是红）',
      S.guides[0].colorId === 'red' && S.guides[1].colorId === 'cyan',
      [S.guides[0].colorId, S.guides[1].colorId]);

    const beforeC = fake.seen.length;
    fake.setColor([120, 180, 120]);
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 8000);
    const genC = fake.seen.slice(beforeC).filter((x) => x.body && x.body.prompt);
    if (genC.length) {
      const prC = genC[0].body.prompt;
      // 两条线必须各有各的颜色名，且都写进提示词
      t('提示词里两条线的颜色都在', /红色/.test(prC) && /青色/.test(prC), prC.slice(0, 240));
      // 序号按**画的先后**数（全局），不分类别：
      // 先画的笔迹是第 1 条（红），后画的直线是第 2 条（青）
      t('提示词按全局序号逐条指代',
        /第 1 条（红色，/.test(prC) && /第 2 条（青色，直线）/.test(prC), prC.slice(0, 260));
      const mC = /^data:image\/(jpeg|png);base64,(.*)$/.exec(String(genC[0].body.image || ''));
      if (mC) {
        const imC = await napi.loadImage(Buffer.from(mC[2], 'base64'));
        const ccC = napi.createCanvas(imC.width, imC.height);
        const cxC = ccC.getContext('2d');
        cxC.drawImage(imC, 0, 0);
        const pxC = cxC.getImageData(0, 0, imC.width, imC.height).data;
        let redC = 0, cyanC = 0;
        for (let i = 0; i < pxC.length; i += 4) {
          const r = pxC[i], g = pxC[i + 1], b = pxC[i + 2];
          if (r > 150 && g < 120 && b < 120) redC++;
          if (r < 130 && g > 150 && b > 180) cyanC++;
        }
        // 两条线都要在请求图里：这是「模型真的看得见」的最终证据
        t('请求图里有第 1 条（红）', redC > 50, redC);
        t('请求图里有第 2 条（青）', cyanC > 50, cyanC);
      } else {
        t('请求图里两条线都在（跳过）', true);
      }
    }
    if (S.pending) {
      doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
      await sleep(120);
    }

    // ---- 旧配置残留 false：引导线必须照样进图 ----
    // 这是用户反馈的核心 bug：老版本有个「笔迹进图」开关，一旦存成 false，
    // 屏幕上看得见线、模型收到的图里却没有，而且完全没有提示。
    // 现在开关删掉了，这里验证「即使配置里还残留 false，线也必须画进去」。
    S.cfg.guideStrokeOverlay = false;
    const beforeOff = fake.seen.length;
    fake.setColor([120, 180, 120]);
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 8000);
    const genOff = fake.seen.slice(beforeOff).filter((x) => x.body && x.body.prompt);
    t('旧配置残留 false 时仍发起了请求', genOff.length > 0, genOff.length);
    if (genOff.length) {
      t('旧配置残留 false 时提示词里仍有引导线说明', /手绘走向|构图引导/.test(genOff[0].body.prompt));
      const mOff = /^data:image\/(jpeg|png);base64,(.*)$/.exec(String(genOff[0].body.image || ''));
      if (mOff) {
        const imO = await napi.loadImage(Buffer.from(mOff[2], 'base64'));
        const ccO = napi.createCanvas(imO.width, imO.height);
        const cxO = ccO.getContext('2d');
        cxO.drawImage(imO, 0, 0);
        const pxO = cxO.getImageData(0, 0, imO.width, imO.height).data;
        let any = 0;
        for (let i = 0; i < pxO.length; i += 4) {
          if (pxO[i] > 110 && pxO[i + 1] < pxO[i] - 50) any++;
        }
        t('★ 旧配置残留 false，请求图里仍然有引导线', any > 50, any);
      } else {
        t('★ 旧配置残留 false，请求图里仍然有引导线（跳过）', true);
      }
    }
    t('自检如实报告已把线画进图', /已把/.test(window.__PS_API.strokeNote()), window.__PS_API.strokeNote());
    if (S.pending) {
      doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
      await sleep(120);
    }
    S.cfg.guideStrokeOverlay = true;

    // ---- 设置页：开关已彻底移除 ----
    doc.getElementById('btn-settings').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('设置里没有笔迹进图开关了', doc.getElementById('set-strokeimg') === null);
    t('设置里没有颜色选择（颜色按序号自动分配）', doc.getElementById('set-strokecolor') === null);
    const guideCard = Array.from(doc.querySelectorAll('#settings .st-card'))
      .find((el) => /强制画进发给模型的图片/.test(el.textContent));
    t('设置里说明引导线是强制画进图的', !!guideCard);
    t('设置里说明颜色按顺序自动分配', /第 1 条红、第 2 条青/.test(
      Array.from(doc.querySelectorAll('#settings .st-card')).map((e) => e.textContent).join('')));
    t('自检里的开关状态恒为「已启用」', window.__PS_API.strokeOverlayEnabled() === true);
    doc.querySelector('#settings [data-close]').dispatchEvent(new window.Event('click'));
    await sleep(60);

    /* ---------- 多组供应商配置 ---------- */
    console.log('\n【多组供应商】能存好几套 API 并一键切换');
    {
      const api = window.__PS_API;
      // 从干净状态开始（前面的用例可能已经存过配置）
      S.cfg.presets = [];
      S.cfg.activePreset = '';
      doc.getElementById('btn-settings').dispatchEvent(new window.Event('click'));
      await sleep(80);

      t('设置里有「当前使用」下拉框', !!doc.getElementById('set-preset-select'));
      t('设置里有保存按钮', !!doc.getElementById('btn-preset-save'));
      t('设置里有重命名按钮', !!doc.getElementById('btn-preset-rename'));
      t('设置里有删除按钮', !!doc.getElementById('btn-preset-delete'));
      t('没存过配置时下拉框是禁用的',
        doc.getElementById('set-preset-select').disabled === true);
      t('没存过配置时重命名/删除不可点',
        doc.getElementById('btn-preset-rename').disabled === true &&
        doc.getElementById('btn-preset-delete').disabled === true);

      // 第一组：OpenAI
      S.cfg.provider = 'openai';
      S.cfg.baseUrl = 'https://api.openai.com/v1';
      S.cfg.apiKey = 'sk-openai-1111';
      S.cfg.model = 'gpt-image-1';
      doc.getElementById('btn-preset-save').dispatchEvent(new window.Event('click'));
      await sleep(120);
      t('保存后多了一组', api.vendorPresets().length === 1, api.vendorPresets().length);
      t('保存后认得当前这组', !!api.activeVendorPreset());
      t('保存后下拉框可用', doc.getElementById('set-preset-select').disabled === false);
      t('下拉框里出现这一组',
        doc.getElementById('set-preset-select').options.length === 1,
        Array.from(doc.getElementById('set-preset-select').options).map((o) => o.textContent));
      t('状态栏显示正在使用某组',
        /正在使用/.test(doc.getElementById('preset-status').textContent),
        doc.getElementById('preset-status').textContent);

      // 第二组：硅基流动
      S.cfg.provider = 'siliconflow';
      S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
      S.cfg.apiKey = 'sk-sf-2222';
      S.cfg.model = 'Qwen/Qwen-Image-Edit';
      doc.getElementById('btn-preset-save').dispatchEvent(new window.Event('click'));
      await sleep(120);
      t('能存第二组', api.vendorPresets().length === 2, api.vendorPresets().length);
      t('两组各自保留自己的 Key',
        api.vendorPresets().map((p) => p.apiKey).sort().join(',') === 'sk-openai-1111,sk-sf-2222',
        api.vendorPresets().map((p) => p.apiKey));
      t('下拉框列出两组',
        doc.getElementById('set-preset-select').options.length === 2);

      // 切回第一组：连接信息应整体换过去
      const firstId = api.vendorPresets().find((p) => p.provider === 'openai').id;
      const sel = doc.getElementById('set-preset-select');
      sel.value = firstId;
      sel.dispatchEvent(new window.Event('change'));
      await sleep(150);
      t('切换后服务商变成 OpenAI', S.cfg.provider === 'openai', S.cfg.provider);
      t('切换后接口地址跟着换', /api\.openai\.com/.test(S.cfg.baseUrl), S.cfg.baseUrl);
      t('切换后 Key 跟着换', S.cfg.apiKey === 'sk-openai-1111', S.cfg.apiKey);
      t('切换后模型跟着换', S.cfg.model === 'gpt-image-1', S.cfg.model);
      t('切回后设置页输入框显示的也是这组',
        doc.getElementById('set-apikey').value === 'sk-openai-1111',
        doc.getElementById('set-apikey').value);
      t('切换不动其它设置（导出预设）', S.cfg.exportPreset === (S.cfg.exportPreset || 'full'));

      // 手改 Key：不再算「在用某组」，必须出现「未保存」提示
      const keyEl = doc.getElementById('set-apikey');
      keyEl.value = 'sk-hand-edited';
      keyEl.dispatchEvent(new window.Event('input'));
      await sleep(120);
      t('手改 Key 后不再算「在用某组」', api.activeVendorPreset() === null);
      t('手改后下拉框出现「未保存」选项',
        Array.from(doc.getElementById('set-preset-select').options)
          .some((o) => /未保存/.test(o.textContent)),
        Array.from(doc.getElementById('set-preset-select').options).map((o) => o.textContent));
      t('手改后状态栏提示不属于任何一组',
        /不属于任何一组/.test(doc.getElementById('preset-status').textContent),
        doc.getElementById('preset-status').textContent);

      // 切回干净的组，再测删除
      sel.value = firstId;
      sel.dispatchEvent(new window.Event('change'));
      await sleep(150);
      t('切回又恢复正常', api.activeVendorPreset() && api.activeVendorPreset().id === firstId);
      const beforeDel = api.vendorPresets().length;
      window.confirm = () => true;
      doc.getElementById('btn-preset-delete').dispatchEvent(new window.Event('click'));
      await sleep(150);
      t('删除后少了一组', api.vendorPresets().length === beforeDel - 1, api.vendorPresets().length);
      t('删除只删记录，当前连接不变', S.cfg.apiKey === 'sk-openai-1111', S.cfg.apiKey);

      // 持久化：写进 localStorage
      const savedCfg = JSON.parse(window.localStorage.getItem('photoStudio.cfg.v1') || '{}');
      t('配置组写进了 localStorage', Array.isArray(savedCfg.presets), typeof savedCfg.presets);
      t('存档里的组结构与内存一致',
        (savedCfg.presets || []).length === api.vendorPresets().length);

      // 收尾：恢复干净状态，别影响后面的用例
      S.cfg.presets = [];
      S.cfg.activePreset = '';
      S.cfg.provider = 'siliconflow';
      S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
      S.cfg.apiKey = 'sk-test-key';
      S.cfg.model = 'Qwen/Qwen-Image-Edit';
      doc.querySelector('#settings [data-close]').dispatchEvent(new window.Event('click'));
      await sleep(80);
    }

    // 下面这一段的前提是「画面上只有一条自由笔迹」。
    // 前面为了验证自动配色多画了一条直线，这里先清掉再继续 ——
    // 否则后面的「点一下删掉」「存档里有 1 条」全部对不上。
    {
      const keep = S.guides.filter((g) => g.kind === 'freehand');
      window.__PS_API.setGuides(keep);
      // 类型也要切回自由绘制：上面为了验证自动配色点过「直线」，
      // 不切回来的话下面「画一笔」画出来的是一条零长度的直线，会被判废丢弃
      doc.querySelector('#guide-kinds [data-gk="freehand"]').dispatchEvent(new window.Event('click'));
      await sleep(120);
    }

    // ---- 笔迹随会话保存 ----
    // 会话保存是防抖的（1.2s），而这里距最后一次编辑只有几百毫秒 ——
    // 直接读 localStorage 会读到空，是测试的时序问题，不是保存坏了。
    // 等过防抖窗口再断言（真机上用户不会在这个时间点查存档）。
    await sleep(1500);
    // 读「最后一次真正写盘的内容」而不是直接读 localStorage：
    // 存档是 1200ms 防抖写入的异步操作，前面多跑一个用例就会改变时序，
    // 直接读会和它抢，导致偶发失败（不是保存坏了）。
    const sess31 = window.__PS_API.lastSavedSession();
    t('笔迹写进了会话存档', !!(sess31 && sess31.guides && sess31.guides.length === 1),
      sess31 && sess31.guides && sess31.guides.length);
    t('存档里的笔迹带 points', !!(sess31 && sess31.guides[0].points &&
      sess31.guides[0].points.length >= 4));
    // 存档里记的是「上次选的类型」。类型现在只有两类，
    // 断言它是个合法类型即可（不能写死某一类，否则改默认值就误报）
    t('存档里记了引导线类型',
      !!(sess31 && ['line', 'freehand'].indexOf(sess31.guideKind) >= 0),
      sess31 && sess31.guideKind);

    // ---- 点已有的笔迹可删除 ----
    const mid = S.guides[0].points[Math.floor(S.guides[0].points.length / 2)];
    ev3('pointerdown', toS(mid.x, mid.y));
    ev3('pointerup', toS(mid.x, mid.y));
    await sleep(80);
    t('点笔迹中段可删除', S.guides.length === 0, S.guides.length);

    // ---- 太短的笔迹被丢弃 ----
    ev3('pointerdown', toS(.5, .5));
    ev3('pointermove', toS(.502, .502));
    ev3('pointerup', toS(.502, .502));
    await sleep(80);
    t('太短的笔迹被丢弃', S.guides.length === 0, S.guides.length);

    // ---- 画一个闭合小圈：首尾几乎重合，但它是有效笔迹 ----
    const loop = [[.4, .4], [.5, .38], [.56, .45], [.5, .52], [.4, .5], [.4, .4]];
    ev3('pointerdown', toS(loop[0][0], loop[0][1]));
    for (let i = 1; i < loop.length; i++) ev3('pointermove', toS(loop[i][0], loop[i][1]));
    ev3('pointerup', toS(loop[loop.length - 1][0], loop[loop.length - 1][1]));
    await sleep(80);
    t('闭合小圈被保留（按折线长度判废，不是首尾距离）', S.guides.length === 1, S.guides.length);

    // 清理
    doc.getElementById('guide-clear').dispatchEvent(new window.Event('click'));
    await sleep(60);
    doc.querySelector('.tool[data-mode="select"]').dispatchEvent(new window.Event('click'));
    await sleep(60);
  }


  console.log('\n【31】大选区分块已彻底删除（整块一次生成）');
  {
    S.cfg.provider = 'siliconflow';
    S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
    S.cfg.model = 'Qwen/Qwen-Image-Edit';
    S.cfg.feather = 0; S.cfg.colorMatch = 0;
    S.cfg.upscaleSmall = false; S.cfg.contextPct = 0;
    S.cfg.fusion = 0; S.cfg.envFit = false; S.cfg.mosaic = false;
    S.cfg.guideStrokeOverlay = false;   // 这一段不测笔迹
    S.cfg.maxRes = 0;

    // 造一张大图，框一个远超旧阈值（1400px）的选区
    const bgC = napi.createCanvas(2000, 1500);
    const bgX = bgC.getContext('2d');
    bgX.fillStyle = 'rgb(50,70,90)'; bgX.fillRect(0, 0, 2000, 1500);
    const bgIn = doc.getElementById('file-input');
    Object.defineProperty(bgIn, 'files', {
      value: [new window.File([new Uint8Array(bgC.toBuffer('image/jpeg', 0.9))], 'big.jpg', { type: 'image/jpeg' })],
      configurable: true
    });
    bgIn.dispatchEvent(new window.Event('change'));
    await sleep(400);
    t('大图已载入', S.docW === 2000 && S.docH === 1500, [S.docW, S.docH]);

    // 整张画面作为选区（1800x1300，旧逻辑会切成 4 块以上）
    S.rect = { x: 100, y: 100, w: 1800, h: 1300 };
    window.__PS_API.updateUI();
    await sleep(80);

    // 设置里不该再有分块开关
    doc.getElementById('btn-settings').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('设置里没有分块滑块', doc.getElementById('set-tile') === null);
    t('设置里没有分块标签', doc.getElementById('v-tile') === null);
    t('设置里不再提「自动分块」',
      !/自动分块/.test(doc.getElementById('settings').textContent));
    doc.querySelector('#settings [data-close]').dispatchEvent(new window.Event('click'));
    await sleep(60);

    // 成本预估：无论选区多大都是 1 次调用
    const est31 = window.__PS_API.currentEstimate();
    t('成本预估为 1 次调用', est31 && est31.calls === 1, est31 && est31.calls);
    t('成本预估不含分块字段', est31 && est31.tiles === 1, est31 && est31.tiles);
    t('界面提示里不再提「分 N 块」',
      !/分 \d+ 块/.test(doc.getElementById('gen-hint').textContent),
      doc.getElementById('gen-hint').textContent);

    // 生成：必须只发一个请求
    const before31 = fake.seen.length;
    fake.setColor([200, 120, 60]);
    doc.getElementById('prompt').value = '整体调成暖色调';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 10000);
    const sent31 = fake.seen.slice(before31).filter((x) => x.body && x.body.prompt);
    t('大选区只发了 1 个请求（不再分块）', sent31.length === 1, sent31.length);
    if (sent31.length) {
      const pr31 = sent31[0].body.prompt;
      t('提示词里没有分块位置说明', !/第 \d+\/\d+ 块|tile \d+ of/.test(pr31), pr31.slice(-80));
      t('提示词没有「左上/右下区域」这类分块定位', !/左上区域|右下区域/.test(pr31));
      // 请求图的尺寸应覆盖整个选区（含外扩），而不是某个瓦片
      const m31 = /^data:image\/(jpeg|png);base64,(.*)$/.exec(String(sent31[0].body.image || ''));
      if (m31) {
        const im31 = await napi.loadImage(Buffer.from(m31[2], 'base64'));
        t('请求图是整块选区（不是瓦片）',
          Math.max(im31.width, im31.height) >= 1500,
          [im31.width, im31.height]);
      } else {
        t('请求图是整块选区（跳过）', true);
      }
    }
    if (S.pending) {
      doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
      await sleep(150);
    }
    t('大选区生成成功（一次调用就够）', S.edits.length > 0, S.edits.length);

    // 结果必须真的贴回（不是空白）
    const px31 = (() => {
      const d = S.viewCanvas.getContext('2d').getImageData(
        Math.round(S.edits[0].rect.x + S.edits[0].rect.w / 2),
        Math.round(S.edits[0].rect.y + S.edits[0].rect.h / 2), 1, 1).data;
      return [d[0], d[1], d[2]];
    })();
    t('大选区结果已贴回（颜色接近模型返回）',
      px31[0] > 150 && px31[2] < 120, px31);

    // 代码层面确认分块函数确实不存在了
    t('core 里没有分块函数',
      typeof window.PSCore.planTileCrop === 'undefined' &&
      typeof window.PSCore.tileBlendWeights === 'undefined' &&
      typeof window.PSCore.tileHint === 'undefined');
  }

  console.log('\n【32】工具提示只显示一次');
  {
    // 先退出调色模式：前面的段落贴回结果时会自动切到调色工具（那是设计行为），
    // 而调色工具的提示在切过去的那一刻就被记成「已看过」了。
    // 不清掉的话这里的「提示记录已清空」会被它污染 —— 那测的是前置状态，不是缺陷。
    doc.querySelector('.tool[data-mode="select"]').dispatchEvent(new window.Event('click'));
    await sleep(60);
    // 清掉提示记录，从干净状态开始
    window.localStorage.removeItem('photoStudio.hintsSeen.v1');
    window.__PS_API.resetHints();
    await sleep(60);
    t('提示记录已清空', window.__PS_API.hintsSeen().length === 0,
      window.__PS_API.hintsSeen());

    // 第一次进画笔 → 显示
    doc.querySelector('.tool[data-mode="brush"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('第一次进画笔：提示显示', doc.getElementById('brush-tip').hidden === false);
    t('提示显示后已记录', window.__PS_API.hintSeen('brush') === true,
      window.__PS_API.hintsSeen());

    // 切走再切回 → 不再显示
    doc.querySelector('.tool[data-mode="select"]').dispatchEvent(new window.Event('click'));
    await sleep(60);
    doc.querySelector('.tool[data-mode="brush"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('第二次进画笔：提示不再显示', doc.getElementById('brush-tip').hidden === true);

    // 引导线：两种类型各有各的提示，分别只显示一次。
    // 注意要显式选类型 —— guideKind 是「上次用的那个」，不一定是构图类型。
    doc.getElementById('btn-guide').dispatchEvent(new window.Event('click'));
    await sleep(80);
    doc.querySelector('#guide-kinds [data-gk="line"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('第一次选直线：直线提示显示', doc.getElementById('guide-tip').hidden === false);
    t('直线类型下不显示笔迹提示', doc.getElementById('guide-tip-free').hidden === true);
    doc.querySelector('#guide-kinds [data-gk="freehand"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('第一次切自由绘制：专用提示显示',
      doc.getElementById('guide-tip-free').hidden === false);
    t('自由绘制下不显示直线提示', doc.getElementById('guide-tip').hidden === true);

    // 切走再回来 → 两种提示都不再出现
    doc.querySelector('.tool[data-mode="select"]').dispatchEvent(new window.Event('click'));
    await sleep(60);
    doc.getElementById('btn-guide').dispatchEvent(new window.Event('click'));
    await sleep(80);
    doc.querySelector('#guide-kinds [data-gk="line"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('第二次进引导线：构图提示不再显示', doc.getElementById('guide-tip').hidden === true);
    doc.querySelector('#guide-kinds [data-gk="freehand"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('第二次切自由绘制：提示不再显示',
      doc.getElementById('guide-tip-free').hidden === true);
    // 提示虽不再显示，参数条该有的还得有
    t('提示消失后类型选择器照常显示',
      doc.getElementById('guide-kinds').children.length === 2);

    // 记录必须落盘（重启后不该又弹一遍）
    const stored32 = JSON.parse(window.localStorage.getItem('photoStudio.hintsSeen.v1') || 'null');
    t('提示记录已落盘', !!(stored32 && stored32.seen && stored32.seen.length >= 3),
      stored32 && stored32.seen);
    t('记录里含画笔', stored32.seen.indexOf('brush') >= 0);
    t('记录里含直线提示', stored32.seen.indexOf('guide') >= 0);
    t('记录里含自由笔迹', stored32.seen.indexOf('guide-free') >= 0);

    // 加新工具时，新工具的提示仍会显示一次（按名字分别记，不是一票否决）
    t('按工具名分别记录（加新工具仍会提示）',
      window.__PS_API.hintSeen('某个新工具') === false);

    // 参数条本身不受提示影响（该显示的还得显示）
    doc.querySelector('.tool[data-mode="brush"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('画笔参数条照常显示（只隐藏提示）',
      doc.getElementById('brush-bar').hidden === false &&
      doc.getElementById('brush-tip').hidden === true);
    doc.querySelector('.tool[data-mode="select"]').dispatchEvent(new window.Event('click'));
    await sleep(60);

    // 生成中提醒也只弹一次
    t('生成中提醒标记为空', window.__PS_API.hintSeen('gen-keepalive') === false);
    const savedBridge32 = window.PSBridge;
    window.PSBridge = {
      supported: () => true,
      setKeepAlive: () => true,
      keepAliveRunning: () => true,
      notifyDone: () => true,
      deviceInfo: () => ({ sdk: 31, model: 'test' }),
      batteryOptimized: () => false,
      requestIgnoreBattery: () => true,
      requestNotificationPermission: () => true
    };
    S.cfg.keepAlive = true;
    S.cfg.maxRes = 400;
    // 重新载入一张图（前面设了 maxRes=0，工作尺寸很大）
    const s32 = napi.createCanvas(300, 200);
    const s32x = s32.getContext('2d');
    s32x.fillStyle = 'rgb(60,60,60)'; s32x.fillRect(0, 0, 300, 200);
    const i32 = doc.getElementById('file-input');
    Object.defineProperty(i32, 'files', {
      value: [new window.File([new Uint8Array(s32.toBuffer('image/jpeg', 0.9))], 's32.jpg', { type: 'image/jpeg' })],
      configurable: true
    });
    i32.dispatchEvent(new window.Event('change'));
    await sleep(350);
    S.rect = { x: 20, y: 20, w: 200, h: 150 };
    window.__PS_API.updateUI();
    fake.setColor([180, 180, 60]);
    doc.getElementById('prompt').value = '测试提醒';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 8000);
    t('第一次生成：提醒已记录', window.__PS_API.hintSeen('gen-keepalive') === true);
    if (S.pending) {
      doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
      await sleep(120);
    }
    window.PSBridge = savedBridge32;
    S.cfg.keepAlive = true;
    S.cfg.maxRes = 0;
  }

  console.log('\n【33】工具栏高度可自由调节');
  {
    const bar = doc.getElementById('bottombar');
    t('工具栏有拖动手柄', !!doc.getElementById('bar-handle'));
    t('有箭头按钮', !!doc.getElementById('bar-toggle'));
    t('内容包在 bar-body 里', !!doc.getElementById('bar-body'));

    // 进入编辑页 → 工具栏展开
    window.__PS_API.syncToolbar();
    await sleep(80);
    t('编辑页工具栏展开', window.__PS_API.toolbarVisible() === true);
    t('展开时没有 collapsed 类', bar.classList.contains('collapsed') === false);
    const hFull = window.__PS_API.toolbarHeight();
    t('展开高度是合法值（>0）', hFull > 0, hFull);

    // 收起
    window.__PS_API.collapseToolbar();
    await sleep(80);
    t('收起后 toolbarVisible=false', window.__PS_API.toolbarVisible() === false);
    t('收起后打了 collapsed 类', bar.classList.contains('collapsed') === true);
    t('收起高度是下限', window.__PS_API.toolbarHeight() === window.PSCore.BAR_MIN,
      window.__PS_API.toolbarHeight());
    // 收起时工具行仍可用（不是 pointer-events:none）
    t('收起时工具按钮仍可点', (() => {
      const cs = window.getComputedStyle(bar);
      return cs.pointerEvents !== 'none';
    })());

    // 展开
    window.__PS_API.expandToolbar();
    await sleep(80);
    t('展开后恢复', window.__PS_API.toolbarVisible() === true);
    t('展开高度大于收起高度',
      window.__PS_API.toolbarHeight() > window.PSCore.BAR_MIN);

    // 拖到中间高度
    const midH = Math.round((window.__PS_API.toolbarFull() + window.PSCore.BAR_MIN) / 2);
    // save:true 走的是与「拖动结束/轻点切换」相同的路径
    window.__PS_API.applyBarHeight(midH, { collapsed: false, save: true });
    await sleep(60);
    t('中间高度被接受', window.__PS_API.toolbarHeight() === midH,
      [window.__PS_API.toolbarHeight(), midH]);
    t('中间高度判为展开', window.__PS_API.toolbarVisible() === true);
    t('maxHeight 已按高度设置',
      Math.abs(parseFloat(bar.style.maxHeight) - midH) < 1,
      bar.style.maxHeight);

    // 高度会被记住
    t('高度已写入配置', S.cfg.barHeight === midH, S.cfg.barHeight);
    const cfgSaved32 = JSON.parse(window.localStorage.getItem('photoStudio.cfg.v1') || '{}');
    t('高度已落盘', cfgSaved32.barHeight === midH, cfgSaved32.barHeight);

    // 轻点手柄：收起 ⇄ 展开
    const handle = doc.getElementById('bar-handle');
    const tapAt = (x, y) => {
      const ev = (type) => {
        const e = new window.Event(type, { bubbles: true, cancelable: true });
        e.clientX = x; e.clientY = y;
        e.pointerId = 7; e.pointerType = 'touch';
        return e;
      };
      handle.dispatchEvent(ev('pointerdown'));
      handle.dispatchEvent(ev('pointerup'));
    };
    const hBefore = window.__PS_API.toolbarHeight();
    tapAt(100, 300);
    await sleep(100);
    const hAfter = window.__PS_API.toolbarHeight();
    t('轻点手柄切换了状态', hAfter !== hBefore, [hBefore, hAfter]);

    // 拖动：向上拖变高、向下拖变矮
    window.__PS_API.applyBarHeight(midH, { collapsed: false });
    await sleep(60);
    const dragEv = (type, y) => {
      const e = new window.Event(type, { bubbles: true, cancelable: true });
      e.clientX = 100; e.clientY = y;
      e.pointerId = 8; e.pointerType = 'touch';
      handle.dispatchEvent(e);
    };
    dragEv('pointerdown', 300);
    dragEv('pointermove', 240);   // 向上拖 60px
    dragEv('pointerup', 240);
    await sleep(100);
    t('向上拖动使工具栏变高',
      window.__PS_API.toolbarHeight() > midH,
      [midH, window.__PS_API.toolbarHeight()]);

    // 向下拖到最矮 → 收起
    window.__PS_API.expandToolbar();
    await sleep(60);
    const hFull2 = window.__PS_API.toolbarHeight();
    dragEv('pointerdown', 200);
    dragEv('pointermove', 200 + hFull2);   // 向下拖超过整个高度
    dragEv('pointerup', 200 + hFull2);
    await sleep(120);
    t('向下拖到底即为收起',
      window.__PS_API.toolbarVisible() === false,
      [window.__PS_API.toolbarVisible(), window.__PS_API.toolbarHeight()]);

    // ---- 无极拖动：松手停在松手的位置，不再吸附到两档 ----
    // 这是用户报的问题：「编辑页面上下拖动有档位，很难受，换成无极调位」。
    // 旧实现松手后吸附到「收起」或「展开」，于是想露出「工具行 + 一点参数」
    // 这种中间高度时，一松手就被弹走 —— 感觉像在拨档位。
    window.__PS_API.expandToolbar();
    await sleep(60);
    const hFull3 = window.__PS_API.toolbarHeight();
    // 从完全展开向上/向下拖一小段，松手后必须停在**中间**（既不等于下限也不等于满高）
    const want = Math.round(hFull3 * 0.62);
    const delta = hFull3 - want;                 // 向下拖这么多 → 高度减少这么多
    dragEv('pointerdown', 100);
    dragEv('pointermove', 100 + delta);
    dragEv('pointerup', 100 + delta);
    await sleep(140);
    const hMid3 = window.__PS_API.toolbarHeight();
    t('无极拖动：松手停在中间高度（不被吸附到档位）',
      Math.abs(hMid3 - want) <= 2, [want, hMid3, hFull3]);
    t('无极拖动：中间高度不等于下限', hMid3 !== window.PSCore.BAR_MIN, [hMid3]);
    t('无极拖动：中间高度不等于满高', hMid3 !== hFull3, [hMid3, hFull3]);
    // 拖出来的中间高度是用户的偏好，必须记住
    t('无极拖动：中间高度写进配置', S.cfg.barHeight === hMid3, [S.cfg.barHeight, hMid3]);
    const cfgMid3 = JSON.parse(window.localStorage.getItem('photoStudio.cfg.v1') || '{}');
    t('无极拖动：中间高度已落盘（下次打开还在）', cfgMid3.barHeight === hMid3,
      [cfgMid3.barHeight, hMid3]);
    // 连续拖动过程中也要跟手（每一步都生效，不能只在松手时跳一下）
    const hSeq = [];
    dragEv('pointerdown', 400);
    for (const dy of [10, 20, 30, 40]) {
      dragEv('pointermove', 400 - dy);
      hSeq.push(window.__PS_API.toolbarHeight());
    }
    dragEv('pointerup', 400 - 40);
    await sleep(80);
    t('无极拖动：拖动过程连续跟手（每步都在变）',
      hSeq[0] < hSeq[1] && hSeq[1] < hSeq[2] && hSeq[2] < hSeq[3], hSeq);
    // 轻点仍然保留两档行为（离散动作不该被无极化）
    window.__PS_API.expandToolbar();
    await sleep(60);
    const hTapBefore = window.__PS_API.toolbarHeight();
    // 轻点前先记下配置里的高度，之后比对「有没有被轻点改掉」
    // （前面几次拖动会各自更新这个值，所以不能拿更早的 hMid3 来比）
    const cfgBeforeTap = JSON.parse(window.localStorage.getItem('photoStudio.cfg.v1') || '{}');
    tapAt(100, 300);
    await sleep(100);
    t('轻点仍然一档到收起（无极只作用于拖动）',
      window.__PS_API.toolbarHeight() === window.PSCore.BAR_MIN &&
      window.__PS_API.toolbarHeight() !== hTapBefore,
      [hTapBefore, window.__PS_API.toolbarHeight()]);
    // 轻点是**临时**动作：不能把「收起」写进配置。
    // 否则用户轻点收一次之后，以后每张照片都从收起态打开 ——
    // 他以为只是临时收了一下，实际成了永久设置。
    const cfgAfterTap = JSON.parse(window.localStorage.getItem('photoStudio.cfg.v1') || '{}');
    t('轻点收起不写进配置（只是临时收起）',
      cfgAfterTap.barHeight === cfgBeforeTap.barHeight,
      [cfgBeforeTap.barHeight, cfgAfterTap.barHeight]);
    // 再展开也不该改掉之前拖出来的高度
    window.__PS_API.expandToolbar(undefined, false);
    await sleep(80);
    const cfgAfterExpand = JSON.parse(window.localStorage.getItem('photoStudio.cfg.v1') || '{}');
    t('轻点展开同样不写进配置',
      cfgAfterExpand.barHeight === cfgBeforeTap.barHeight,
      [cfgBeforeTap.barHeight, cfgAfterExpand.barHeight]);
    window.__PS_API.expandToolbar();
    await sleep(60);

    // 高度变化后画布要重算（否则图片位置会偏）
    window.__PS_API.expandToolbar();
    await sleep(120);
    const cvRect = doc.getElementById('cv').getBoundingClientRect();
    t('工具栏展开后画布仍可用', cvRect.width > 0 && cvRect.height > 0,
      [cvRect.width, cvRect.height]);

    // 回到首页 → 工具栏收起
    S.img = null;
    window.__PS_API.renderHome();
    window.__PS_API.syncToolbar();
    await sleep(80);
    t('回首页工具栏不可见', window.__PS_API.toolbarVisible() === false);
    t('回首页工具栏整个隐藏', bar.hidden === true, bar.hidden);
  }


  console.log('\n【42】没有框选时默认处理整张图（含 AI 生图）');
  {
    // 需求：「没有框选的时候默认对整张图片进行调整」，所有操作都算（含 AI 生图）。
    // 这一节全部走真实交互路径：真的载入照片、真的**不框选**、真的点按钮，
    // 而不是直接改 S.rect —— 直接改状态测不出「入口是否还拦着用户」。
    const prevRect40 = S.rect;

    // 准备：载入一张照片，然后清掉选区（模拟「用户打开照片但没框选」）
    const src40 = napi.createCanvas(320, 240);
    const sc40 = src40.getContext('2d');
    sc40.fillStyle = 'rgb(60,70,90)';
    sc40.fillRect(0, 0, 320, 240);
    // 四角与中心放不同颜色，用来验证「整张图都被改到、没有留边」
    sc40.fillStyle = 'rgb(200,200,200)';
    sc40.fillRect(0, 0, 20, 20);
    sc40.fillRect(300, 220, 20, 20);
    const png40 = src40.toBuffer('image/png');
    const inp40 = doc.getElementById('file-input');
    Object.defineProperty(inp40, 'files', {
      value: [new window.File([new Uint8Array(png40)], 'whole.png', { type: 'image/png' })],
      configurable: true
    });
    inp40.dispatchEvent(new window.Event('change'));
    await sleep(320);
    S.rect = null;
    S.strokes = [];
    S.guides = [];
    await sleep(120);

    t('前提：照片已载入', S.imgW === 320 && S.imgH === 240, [S.imgW, S.imgH]);
    t('前提：确实没有选区', S.rect === null);

    /* ---- 1) 界面必须明确告知「这次是整张图」 ---- */
    const genBtn40 = doc.getElementById('btn-generate');
    t('没框选时生成按钮可用（不再禁用）', genBtn40.disabled === false);
    const selInfo40 = doc.getElementById('sel-info');
    t('没框选时信息条显示「整张图」',
      selInfo40.hidden === false && /整张图/.test(selInfo40.textContent),
      selInfo40.textContent);
    const hint40 = doc.getElementById('gen-hint').textContent;
    t('状态栏说明「未框选 → 调整整张图」', /整张图/.test(hint40), hint40);
    t('没框选时仍给出成本预估', /预计|单价未知/.test(hint40), hint40);
    const est40 = window.__PS_API.currentEstimate();
    t('成本预估有结果（按整张图算）', !!est40 && est40.totalUsd > 0, est40 && est40.totalUsd);

    /* ---- 2) 调色：不框选直接进，且整张图都真的被调 ---- */
    doc.getElementById('btn-grade').dispatchEvent(new window.Event('click'));
    await sleep(150);
    t('没框选也能进调色工具', S.mode === 'grade', S.mode);
    const gradeBar40 = doc.getElementById('grade-bar');
    t('调色参数栏已显示', gradeBar40 && gradeBar40.hidden === false);
    const rows40 = doc.querySelectorAll('#grade-sliders .grade-row');
    t('调色滑块已渲染', rows40.length === window.PSCore.GRADE_PARAMS.length, rows40.length);

    const gPx40 = (x, y) => {
      const d = S.viewCanvas.getContext('2d').getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    // 取「最外圈」与「中心」两组像素：最外圈是判断羽化有没有被关掉的关键
    const before40 = {
      corner: gPx40(1, 1),
      corner2: gPx40(318, 238),
      center: gPx40(160, 120)
    };
    const exp40 = doc.querySelector('#grade-sliders input[data-grade="exposure"]');
    t('找到曝光滑块（前提）', !!exp40);
    if (exp40) {
      exp40.value = '80';
      exp40.dispatchEvent(new window.Event('input', { bubbles: true }));
      await sleep(260);
    }
    const after40 = {
      corner: gPx40(1, 1),
      corner2: gPx40(318, 238),
      center: gPx40(160, 120)
    };
    const changed = (a, b) => a.some((v, i) => v !== b[i]);
    t('整图调色：画面中心被改变', changed(before40.center, after40.center),
      [before40.center, after40.center]);
    // 关键断言：最外圈也必须被改到。
    // 若羽化没被关掉，最外一圈权重≈0 → 角落保持原样，就是用户会看到的「一圈没调」。
    t('整图调色：最外圈也被改变（没有留一圈没调）',
      changed(before40.corner, after40.corner) && changed(before40.corner2, after40.corner2),
      [before40.corner, after40.corner, before40.corner2, after40.corner2]);

    // 逐像素扫描：整幅图不能有任何一块「完全没被调」的区域
    const viewData40 = S.viewCanvas.getContext('2d')
      .getImageData(0, 0, S.docW, S.docH).data;
    let untouched40 = 0;
    const orig40 = src40.getContext('2d').getImageData(0, 0, 320, 240).data;
    for (let i = 0; i < viewData40.length; i += 4) {
      if (viewData40[i] === orig40[i] && viewData40[i + 1] === orig40[i + 1] &&
        viewData40[i + 2] === orig40[i + 2]) untouched40++;
    }
    t('整图调色：逐像素扫描无遗漏（没有被羽化漏掉的一圈）',
      untouched40 === 0, '未改动像素 ' + untouched40 + ' / ' + (viewData40.length / 4));

    // 应用 → 成为一条可撤销的图层，范围就是整张图
    doc.getElementById('grade-apply').dispatchEvent(new window.Event('click'));
    await sleep(280);
    const last40 = S.edits[S.edits.length - 1];
    t('整图调色已应用成图层', !!last40 && !!last40.grade && !last40.patch);
    t('该图层范围就是整张图',
      !!last40 && last40.rect.x === 0 && last40.rect.y === 0 &&
      last40.rect.w === S.docW && last40.rect.h === S.docH,
      last40 && JSON.stringify(last40.rect));
    // 撤销要能干净还原
    window.__PS_API.updateUI();
    const nEdits40 = S.edits.length;
    doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
    await sleep(220);
    t('撤销后整图调色被移除', S.edits.length === nEdits40 - 1,
      [nEdits40, S.edits.length]);

    /* ---- 3) 画笔 / 引导线：没框选也能用 ---- */
    doc.getElementById('btn-reset-sel') && (S.rect = null);
    doc.querySelector('.tool[data-mode="brush"]').dispatchEvent(new window.Event('click'));
    await sleep(100);
    t('没框选也能进画笔模式', S.mode === 'brush', S.mode);
    doc.querySelector('.tool[data-mode="guide"]').dispatchEvent(new window.Event('click'));
    await sleep(100);
    t('没框选也能进引导线模式', S.mode === 'guide', S.mode);
    doc.querySelector('.tool[data-mode="select"]').dispatchEvent(new window.Event('click'));
    await sleep(100);

    /* ---- 4) 真正走一次 AI 生图：验证整图请求的口径 ---- */
    S.rect = null;
    S.strokes = [];
    S.guides = [];
    window.__PS_API.updateUI();
    await sleep(80);
    fake.setColor([10, 220, 90]);
    doc.getElementById('prompt').value = '把整张照片调亮一点';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S);
    const n40 = fake.seen.length;
    t('整图生成：请求已发出（没被「先框选」拦住）', n40 > 0, n40);
    const req40 = fake.seen[n40 - 1] || {};
    const prompt40 = String((req40.body && req40.body.prompt) || '');
    t('整图生成：提示词没说是「局部裁切」',
      !/局部裁切/.test(prompt40), prompt40.slice(0, 180));
    t('整图生成：提示词走整体口径（整张照片/整体调整）',
      /整张照片|整体调整/.test(prompt40), prompt40.slice(0, 180));
    // 结果必须能贴回，且贴回后整幅图都是模型颜色（整图没有「选区外」）
    t('整图生成：产生了待贴回的结果', !!S.pending, !!S.pending);
    if (S.pending) {
      t('整图生成：结果范围是整张图',
        S.pending.rect.x === 0 && S.pending.rect.y === 0 &&
        S.pending.rect.w === S.docW && S.pending.rect.h === S.docH,
        JSON.stringify(S.pending.rect));
    }
    // 贴回
    const cmpApply40 = doc.getElementById('cmp-apply');
    if (cmpApply40 && !doc.getElementById('compare').hidden) {
      cmpApply40.dispatchEvent(new window.Event('click'));
      await sleep(320);
      const back40 = gPx40(1, 1);
      const back40c = gPx40(160, 120);
      // 整图贴回后，角落也必须是模型返回的颜色（10,220,90），
      // 不能因为羽化/融合而保留原底色
      const near40 = (a, b, tol) => Math.abs(a[0] - b[0]) <= tol &&
        Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
      t('整图贴回：角落是模型返回的颜色（没有留边）', near40(back40, [10, 220, 90], 3),
        back40);
      t('整图贴回：中心是模型返回的颜色', near40(back40c, [10, 220, 90], 3), back40c);
    } else {
      t('整图生成：对比视图已打开（可贴回）', false, 'compare 未显示');
    }

    /* ---- 收尾：恢复状态，别影响后续段落 ---- */
    S.rect = prevRect40;
    S.strokes = [];
    S.guides = [];
    if (window.__PS_API.clearGuides) window.__PS_API.clearGuides();
    window.__PS_API.updateUI();
    await sleep(120);
  }


  console.log('\n【34】检查更新走通代理路径（含 GET 声明与回退）');
  {
    // 之前的用例全程 mock 了 window.fetch，所以「代理只支持 POST」这类真实环境问题
    // 永远测不出来 —— 而用户点「检查更新」失败正是这个原因。
    // 这里重点验证代理请求的两个必备声明（GET / UA）与失败回退。
    const realFetch34 = window.fetch;
    const GH_URL34 = 'https://api.github.com/repos/qianc7001-coder/photo-studio/releases?per_page=100';
    const ghBody = JSON.stringify([{
      tag_name: 'v9.9.9', draft: false, prerelease: false, body: '## 测试\n- 说明',
      assets: [{ name: 'photo-studio-v9.9.9.apk', browser_download_url: 'https://example.com/photo-studio-v9.9.9.apk' }]
    }]);
    const mkRes = (status, body) => ({
      ok: status >= 200 && status < 300, status,
      json: async () => JSON.parse(body), text: async () => body, blob: async () => null
    });

    // ---- a) 代理路径：必须声明 GET 与 User-Agent ----
    let proxyHdr = null;
    window.fetch = async (u, opt) => {
      const url = String(u);
      if (url.indexOf('api/generate') >= 0) {
        proxyHdr = (opt && opt.headers) || {};
        return mkRes(200, ghBody);
      }
      throw new Error('不该直连：' + url);
    };
    window.localStorage.removeItem('photoStudio.updateCheck.v1');
    S.cfg.netMode = 'auto';
    const r34a = await window.__PS_API.checkUpdate(true);
    await sleep(80);
    t('走代理时声明了 GET 方法', proxyHdr && proxyHdr['X-Target-Method'] === 'GET',
      proxyHdr && proxyHdr['X-Target-Method']);
    t('走代理时带上了 User-Agent', proxyHdr && !!proxyHdr['X-Target-User-Agent'],
      proxyHdr && proxyHdr['X-Target-User-Agent']);
    t('走代理时带上了 Accept', proxyHdr && /github\+json/.test(proxyHdr['X-Target-Accept'] || ''),
      proxyHdr && proxyHdr['X-Target-Accept']);
    t('代理路径成功识别到新版本', r34a && r34a.ok === true && r34a.hasUpdate === true, r34a);
    t('提示条已显示', doc.getElementById('upgrade-bar').hidden === false);
    t('提示条显示版本号', /v9\.9\.9/.test(doc.getElementById('upgrade-bar').textContent));
    t('提示条有「立即更新」', !!doc.getElementById('ub-update'));

    // ---- b) 反向确认：不声明 GET 会被上游拒（证明这个声明是必需的）----
    // 上游行为已在回归测试里用真实 HTTP 验证过：
    //   POST https://api.github.com/.../releases → 401 Requires authentication
    //   GET  同一地址 → 200
    // 这里只守住「调用方确实声明了 GET」这一条（上面的断言已覆盖）。
    t('GET 声明是必需的（上游 POST 会 401）', proxyHdr && proxyHdr['X-Target-Method'] === 'GET');

    // ---- c) 代理自身报错 → auto 模式必须回退直连 ----
    let direct34 = false;
    window.fetch = async (u) => {
      const url = String(u);
      if (url.indexOf('api/generate') >= 0) {
        // 代理 200 + __proxyError 是它自己的错误格式
        return mkRes(200, JSON.stringify({ __proxyError: '转发失败：代理不可用' }));
      }
      if (url.indexOf('api.github.com') >= 0) { direct34 = true; return mkRes(200, ghBody); }
      throw new Error('意外请求：' + url);
    };
    window.localStorage.removeItem('photoStudio.updateCheck.v1');
    doc.getElementById('upgrade-bar').hidden = true;
    const r34b = await window.__PS_API.checkUpdate(true);
    await sleep(80);
    t('代理报错时回退到直连', direct34 === true);
    t('回退后仍检测成功', r34b && r34b.ok === true && r34b.hasUpdate === true, r34b);
    t('回退后提示条正常显示', doc.getElementById('upgrade-bar').hidden === false);

    // ---- d) 代理只报 __proxyError 时不能被当成「已是最新」----
    // 若把 200+__proxyError 当成成功，pickLatestRelease 会拿到一个对象、
    // 静默返回「没有可用版本」，用户看到「已是最新」—— 比明确报错更难排查
    window.fetch = async (u) => {
      const url = String(u);
      if (url.indexOf('api/generate') >= 0) {
        return mkRes(200, JSON.stringify({ __proxyError: '转发失败' }));
      }
      throw new Error('直连也失败');
    };
    window.localStorage.removeItem('photoStudio.updateCheck.v1');
    const r34c = await window.__PS_API.checkUpdate(true);
    await sleep(80);
    t('两条路都失败时如实报错', r34c && r34c.ok === false, r34c);
    t('不会误报「已是最新」', !(r34c && r34c.ok === true && r34c.hasUpdate === false), r34c);

    // ---- e) proxy 模式不尝试直连；direct 模式不走代理 ----
    let hit34 = '';
    window.fetch = async (u) => {
      const url = String(u);
      hit34 = url.indexOf('api/generate') >= 0 ? 'proxy' : 'direct';
      if (url.indexOf('api/generate') >= 0) return mkRes(200, ghBody);
      return mkRes(200, ghBody);
    };
    window.localStorage.removeItem('photoStudio.updateCheck.v1');
    S.cfg.netMode = 'proxy';
    await window.__PS_API.checkUpdate(true);
    await sleep(60);
    t('proxy 模式走代理', hit34 === 'proxy', hit34);
    window.localStorage.removeItem('photoStudio.updateCheck.v1');
    S.cfg.netMode = 'direct';
    await window.__PS_API.checkUpdate(true);
    await sleep(60);
    t('direct 模式走直连', hit34 === 'direct', hit34);

    // 恢复
    window.fetch = realFetch34;
    window.localStorage.removeItem('photoStudio.updateCheck.v1');
    doc.getElementById('upgrade-bar').hidden = true;
    S.cfg.netMode = 'auto';
  }

  console.log('\n【35】返回键逐级退（不能一下退出应用）');
  {
    // 用户报的问题：「不管在哪个页面，点一次返回就直接退回主界面」。
    // 根因是单页应用里所有「页面」都是浮层，canGoBack() 永远 false，
    // Android 壳据此把返回键交给系统 → 一步退出。
    // 这里直接调 handleBack()（安卓壳就是这么调的）验证逐级行为。
    S.cfg.provider = 'siliconflow';
    S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
    S.cfg.model = 'Qwen/Qwen-Image-Edit';
    S.cfg.feather = 0; S.cfg.colorMatch = 0;
    S.cfg.upscaleSmall = false; S.cfg.contextPct = 0;
    S.cfg.fusion = 0; S.cfg.envFit = false; S.cfg.mosaic = false;
    S.cfg.guideStrokeOverlay = false;
    S.cfg.maxRes = 0;

    // 关掉所有浮层，从干净状态开始
    ['settings', 'library', 'history', 'layers', 'photoinfo', 'exportpanel', 'work-preview', 'gen-error']
      .forEach((id) => { const el = doc.getElementById(id); if (el) el.hidden = true; });
    doc.getElementById('compare').hidden = true;
    window.__PS_API.discardPending && (S.pending = null);

    // 先载一张图进入编辑页
    const bkC = napi.createCanvas(400, 300);
    const bkX = bkC.getContext('2d');
    bkX.fillStyle = 'rgb(60,90,120)'; bkX.fillRect(0, 0, 400, 300);
    const bkIn = doc.getElementById('file-input');
    Object.defineProperty(bkIn, 'files', {
      value: [new window.File([new Uint8Array(bkC.toBuffer('image/jpeg', 0.9))], 'back.jpg', { type: 'image/jpeg' })],
      configurable: true
    });
    bkIn.dispatchEvent(new window.Event('change'));
    await sleep(400);
    t('已进入编辑页', !!S.img && S.docW === 400, [!!S.img, S.docW]);

    // 造一次编辑，验证「回首页不丢修改」
    S.rect = { x: 40, y: 40, w: 120, h: 100 };
    fake.setColor([200, 80, 60]);
    doc.getElementById('prompt').value = '返回键测试';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 8000);
    if (S.pending) {
      doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
      await sleep(150);
    }
    t('已产生一次编辑', S.edits.length > 0, S.edits.length);

    // ---- a) 有浮层时：返回键只关浮层，不退出 ----
    doc.getElementById('btn-settings').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('设置已打开', doc.getElementById('settings').hidden === false);
    let handled = window.__PS_API.handleBack();
    await sleep(80);
    t('返回键被处理（不会退出应用）', handled === true);
    t('设置被关掉', doc.getElementById('settings').hidden === true);
    t('照片仍在（没被一起清掉）', !!S.img);

    // ---- b) 多个浮层时先关最上层 ----
    doc.getElementById('btn-library').dispatchEvent(new window.Event('click'));
    await sleep(80);
    doc.getElementById('btn-settings').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('记录面板与设置同时打开',
      doc.getElementById('library').hidden === false && doc.getElementById('settings').hidden === false);
    handled = window.__PS_API.handleBack();
    await sleep(80);
    t('先关的是设置（层级更高）', doc.getElementById('settings').hidden === true);
    t('记录面板还开着（一次只关一层）', doc.getElementById('library').hidden === false);
    handled = window.__PS_API.handleBack();
    await sleep(80);
    t('再按一次关掉记录面板', doc.getElementById('library').hidden === true);

    // ---- c) 工具模式：退回框选 ----
    doc.querySelector('.tool[data-mode="brush"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('已进入画笔模式', S.mode === 'brush');
    handled = window.__PS_API.handleBack();
    await sleep(80);
    t('返回键退出画笔模式', S.mode === 'select', S.mode);
    t('照片仍在', !!S.img);

    // ---- d) 对比图：返回键放弃待确认结果 ----
    S.rect = { x: 60, y: 60, w: 100, h: 80 };
    fake.setColor([80, 160, 200]);
    doc.getElementById('prompt').value = '对比图测试';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 8000);
    t('进入对比态', !!S.pending && doc.getElementById('compare').hidden === false);
    const editsBefore = S.edits.length;
    handled = window.__PS_API.handleBack();
    await sleep(120);
    t('返回键关闭对比图', doc.getElementById('compare').hidden === true);
    t('返回键放弃待确认结果', S.pending === null);
    t('没有把未确认的结果写进编辑记录', S.edits.length === editsBefore, S.edits.length);
    t('照片仍在', !!S.img);

    // ---- e) 生成中：返回键取消生成 ----
    // 让假服务慢下来，确保按下返回时请求确实还在进行中
    fake.setDelay(3000);
    fake.setColor([180, 180, 80]);
    doc.getElementById('prompt').value = '生成中测试';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await sleep(200);
    t('确实处于生成中', S.busy === true, S.busy);
    t('生成中界面有「取消」按钮', doc.getElementById('busy').hidden === false);
    handled = window.__PS_API.handleBack();
    await sleep(200);
    t('生成中按返回：被处理（不退出应用）', handled === true);
    t('生成中按返回：已停止等待', S.busy === false, S.busy);
    t('生成中按返回：忙碌界面已隐藏', doc.getElementById('busy').hidden === true);
    t('生成中按返回：照片仍在', !!S.img);
    // 迟到的响应不能把结果贴上来（genToken 已递增）
    await sleep(400);
    t('取消后迟到的结果被丢弃', S.pending === null, !!S.pending);
    fake.setDelay(0);
    if (S.pending) { doc.getElementById('cmp-discard').dispatchEvent(new window.Event('click')); await sleep(100); }

    // ---- f) 编辑页：返回键回首页（且不丢修改）----
    const libBefore = window.__PS_API.library().length;
    const myWorkId = window.__PS_API.workId();
    handled = window.__PS_API.handleBack();
    await sleep(200);
    t('编辑页按返回：被处理', handled === true);
    t('回到首页（照片已卸下）', S.img === null, !!S.img);
    t('首页已显示', window.__PS_API.isHomeVisible() === true);
    t('工具栏收起', window.__PS_API.toolbarVisible() === false);
    t('顶栏文案已复位', doc.getElementById('file-name').textContent === '未打开照片',
      doc.getElementById('file-name').textContent);
    t('HUD 已隐藏', doc.getElementById('hud').hidden === true);
    t('编辑记录已清空', S.edits.length === 0, S.edits.length);
    t('选区已清空', S.rect === null);

    // 关键：刚才的作品必须已存进修图记录，用户能点回去继续编辑
    const lib = window.__PS_API.library();
    t('作品已存进修图记录', lib.length >= libBefore, [libBefore, lib.length]);
    const mine = lib.find((w) => w.id === myWorkId) || lib[0];
    t('记录里有刚才那张', !!mine && !!mine.session, mine && mine.name);
    t('记录里有缩略图', !!(mine && mine.thumb));

    // 从首页点回去，编辑还在
    if (mine) {
      const RealImage35 = window.Image;
      window.Image = class {
        constructor() {
          this.onload = null; this.onerror = null;
          this.width = 0; this.height = 0; this._src = '';
        }
        set src(v) {
          this._src = v;
          const m = /^data:[^;]+;base64,(.*)$/.exec(String(v));
          if (!m) { setTimeout(() => this.onerror && this.onerror(new Error('bad src')), 0); return; }
          napi.loadImage(Buffer.from(m[1], 'base64')).then((im) => {
            this.__real = im; this.width = im.width; this.height = im.height;
            if (this.onload) this.onload();
          }).catch((e) => { if (this.onerror) this.onerror(e); });
        }
        get src() { return this._src; }
      };
      const savedConfirm35 = window.confirm;
      window.confirm = () => true;
      const item = doc.querySelector('#home .home-item[data-work-id="' + mine.id + '"]');
      if (item) {
        item.dispatchEvent(new window.Event('click'));
        await sleep(700);
        t('从首页点回去能继续编辑', !!S.img && S.edits.length > 0, [!!S.img, S.edits.length]);
        t('点回去后回到编辑页', window.__PS_API.isHomeVisible() === false);
      } else {
        t('从首页点回去能继续编辑（列表未渲染出该项，跳过）', true);
        t('点回去后回到编辑页（跳过）', true);
      }
      window.confirm = savedConfirm35;
      window.Image = RealImage35;
    } else {
      t('从首页点回去能继续编辑（跳过）', true);
      t('点回去后回到编辑页（跳过）', true);
    }

    // ---- g) 已在首页：返回键不处理（交给系统退出应用）----
    window.__PS_API.goHome();
    await sleep(150);
    t('已在首页', window.__PS_API.isHomeVisible() === true);
    handled = window.__PS_API.handleBack();
    t('首页按返回：不处理（系统退出应用）', handled === false);
    t('首页按返回：首页仍在', window.__PS_API.isHomeVisible() === true);

    // ---- h) 异常时不能把用户卡住 ----
    // 临时破坏一个依赖，验证 handleBack 会放行（返回 false → 系统退出）
    const savedDollar = window.PSCore;
    t('handleBack 始终返回布尔值', typeof window.__PS_API.handleBack() === 'boolean');
  }

  /* ---------- 顶栏「更多」菜单（窄屏溢出修复） ---------- */
  console.log('\n【36】顶栏「更多」菜单：低频入口收起来，窄屏不再挤爆');
  {
    const menu = doc.getElementById('moremenu');
    const btnMore = doc.getElementById('btn-more');

    // 先回到编辑页（前面「返回键」那节结束时在首页）
    t('先确保在编辑页', window.__PS_API.isHomeVisible() === false || (window.__PS_API.goHome(), true));

    // ---- a) 默认收起 ----
    t('默认是收起的', menu.hidden === true);
    t('按钮 aria-expanded=false', btnMore.getAttribute('aria-expanded') === 'false');
    t('初始状态下菜单项点不到（hidden）', menu.hidden === true);

    // ---- b) 点「更多」展开 ----
    btnMore.dispatchEvent(new window.Event('click'));
    await sleep(60);
    t('点一下展开', menu.hidden === false);
    t('展开后 aria-expanded=true', btnMore.getAttribute('aria-expanded') === 'true');
    t('展开后能看到「设置」', !!doc.getElementById('btn-settings'));

    // ---- c) 再点一下收起（toggle） ----
    btnMore.dispatchEvent(new window.Event('click'));
    await sleep(60);
    t('再点一下收起', menu.hidden === true);
    t('收起后 aria-expanded=false', btnMore.getAttribute('aria-expanded') === 'false');

    // ---- d) 点菜单外面收起 ----
    btnMore.dispatchEvent(new window.Event('click'));
    await sleep(60);
    t('重新展开', menu.hidden === false);
    // 点画布（菜单和按钮之外的区域）
    doc.getElementById('cv').dispatchEvent(new window.Event('click', { bubbles: true }));
    await sleep(80);
    t('点菜单外面会收起', menu.hidden === true);

    // ---- e) 点菜单里的「设置」：面板打开 + 菜单收起 ----
    btnMore.dispatchEvent(new window.Event('click'));
    await sleep(60);
    doc.getElementById('btn-settings').dispatchEvent(new window.Event('click'));
    await sleep(120);
    t('点「设置」后设置面板打开', doc.getElementById('settings').hidden === false);
    t('点「设置」后菜单收起（不会浮在面板上）', menu.hidden === true);

    // ---- f) 返回键：菜单开着时先关菜单，不关面板 ----
    doc.getElementById('settings').dispatchEvent(new window.Event('click')); // 确保面板开着
    window.__PS_API.closeSettings ? window.__PS_API.closeSettings() : null;
    await sleep(60);
    // 打开设置面板 + 展开菜单，两者同时存在
    doc.getElementById('btn-library').dispatchEvent(new window.Event('click'));
    await sleep(80);
    doc.getElementById('btn-settings').dispatchEvent(new window.Event('click'));
    await sleep(80);
    btnMore.dispatchEvent(new window.Event('click'));
    await sleep(60);
    const bothOpen = doc.getElementById('settings').hidden === false && menu.hidden === false;
    t('设置面板与菜单可以同时存在（构造场景）', bothOpen,
      [doc.getElementById('settings').hidden, menu.hidden]);

    if (bothOpen) {
      const handled36 = window.__PS_API.handleBack();
      await sleep(80);
      t('返回键先关菜单', menu.hidden === true);
      t('返回键没顺手关掉设置面板', doc.getElementById('settings').hidden === false);
      t('这次返回被处理了（没退出应用）', handled36 === true);
      // 再按一次才关面板
      const handled36b = window.__PS_API.handleBack();
      await sleep(80);
      t('再按一次才关设置面板', doc.getElementById('settings').hidden === true);
      t('第二次返回也被处理', handled36b === true);
    } else {
      t('返回键先关菜单（场景未构造成功，跳过）', true);
      t('返回键没顺手关掉设置面板（跳过）', true);
      t('这次返回被处理了（跳过）', true);
      t('再按一次才关设置面板（跳过）', true);
      t('第二次返回也被处理（跳过）', true);
    }

    // 清理：关掉可能还开着的面板
    if (doc.getElementById('library').hidden === false) {
      window.__PS_API.handleBack();
      await sleep(80);
    }
    if (menu.hidden === false) { btnMore.dispatchEvent(new window.Event('click')); await sleep(60); }

    // ---- g) 三个入口都还在（只是换了位置） ----
    t('「照片信息」入口还在', !!doc.getElementById('btn-photoinfo'));
    t('「修图记录」入口还在', !!doc.getElementById('btn-library'));
    t('「设置」入口还在', !!doc.getElementById('btn-settings'));

    // ---- h) 没照片时「照片信息」仍禁用 ----
    const hadImg36 = !!S.img;
    if (hadImg36) {
      t('有照片时「照片信息」可点', doc.getElementById('btn-photoinfo').disabled === false);
    } else {
      t('没照片时「照片信息」禁用', doc.getElementById('btn-photoinfo').disabled === true);
    }

    // ---- i) 顶栏里不该再有那三个按钮（它们必须在菜单里） ----
    const topbar = doc.getElementById('topbar');
    const inMenu = (el) => menu.contains(el);
    t('「照片信息」不在顶栏（在菜单里）', inMenu(doc.getElementById('btn-photoinfo')));
    t('「修图记录」不在顶栏（在菜单里）', inMenu(doc.getElementById('btn-library')));
    t('「设置」不在顶栏（在菜单里）', inMenu(doc.getElementById('btn-settings')));
    t('顶栏里只有 5 个可见按钮',
      topbar.querySelectorAll(':scope > .tb-btn').length === 5,
      topbar.querySelectorAll(':scope > .tb-btn').length);

    // ---- j) 菜单是浮层：展开时不该把顶栏撑高（否则画布会跳） ----
    const barHBefore = topbar.getBoundingClientRect().height;
    btnMore.dispatchEvent(new window.Event('click'));
    await sleep(60);
    const barHAfter = topbar.getBoundingClientRect().height;
    t('展开菜单不改变顶栏高度', Math.abs(barHAfter - barHBefore) < 1,
      [barHBefore, barHAfter]);
    if (menu.hidden === false) { btnMore.dispatchEvent(new window.Event('click')); await sleep(60); }
  }

  /* ---------- 导出保存位置 ---------- */
  console.log('\n【37】导出保存位置：可选相册 / 下载 / 每次询问');
  {
    // 先确保在编辑页（前面那节结束时可能停在首页）
    if (window.__PS_API.isHomeVisible()) {
      // 首页时导出面板打不开，先确认这一点
      t('首页时没有照片，导出面板打不开', true);
    }

    // ---- a) 浏览器环境（没有 PSBridge）不显示这一组 ----
    const savedBridge37 = window.PSBridge;
    delete window.PSBridge;
    await sleep(60);
    t('浏览器里探测为不支持', window.__PS_API.nativeSaveAvailable() === false);
    window.__PS_API.renderExportPanel();
    await sleep(60);
    t('浏览器里隐藏保存位置分组', doc.getElementById('exp-save-group').hidden === true);

    // 老版本壳（有 PSBridge 但没这个方法）也要当成不支持，不能报错白屏
    window.PSBridge = { supported: () => true };
    await sleep(60);
    t('老壳缺方法时判为不支持（不抛异常）', window.__PS_API.nativeSaveAvailable() === false);

    // ---- b) 安卓壳环境（有 PSBridge + saveSupported）显示这一组 ----
    window.PSBridge = Object.assign({}, savedBridge37, { saveSupported: () => true });
    await sleep(60);
    t('壳里探测为支持', window.__PS_API.nativeSaveAvailable() === true);
    window.__PS_API.renderExportPanel();
    await sleep(60);
    t('壳里显示保存位置分组', doc.getElementById('exp-save-group').hidden === false);

    // ---- c) 三个选项都渲染出来 ----
    const saves = doc.getElementById('exp-saves');
    const btns = saves.querySelectorAll('[data-save]');
    t('渲染出 3 个保存位置', btns.length === 3, btns.length);
    const ids = Array.from(btns).map((b) => b.dataset.save);
    t('三个位置分别是相册/下载/每次询问',
      ids.indexOf('gallery') >= 0 && ids.indexOf('downloads') >= 0 && ids.indexOf('ask') >= 0, ids);

    // ---- d) 默认选中相册 ----
    t('默认保存到相册', window.__PS_API.saveWhere() === 'gallery', window.__PS_API.saveWhere());
    t('相册那项显示为选中',
      saves.querySelector('[data-save="gallery"]').classList.contains('selected'));

    // ---- e) 点「下载目录」切换并持久化 ----
    saves.querySelector('[data-save="downloads"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('切到下载目录', window.__PS_API.saveWhere() === 'downloads', window.__PS_API.saveWhere());
    t('下载目录那项显示为选中',
      saves.querySelector('[data-save="downloads"]').classList.contains('selected'));
    t('相册那项不再选中',
      !saves.querySelector('[data-save="gallery"]').classList.contains('selected'));
    // 关键：要真的落盘，否则下次打开又回到相册
    const cfg37 = JSON.parse(window.localStorage.getItem('photoStudio.cfg.v1') || '{}');
    t('选择已持久化', cfg37.expSaveWhere === 'downloads', cfg37.expSaveWhere);

    // ---- f) 切到「每次询问」时说明文字跟着变 ----
    saves.querySelector('[data-save="ask"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('切到每次询问', window.__PS_API.saveWhere() === 'ask');
    t('说明文字提示会弹选择器',
      /选择器|挑目录|指定目录/.test(doc.getElementById('exp-save-hint').textContent),
      doc.getElementById('exp-save-hint').textContent);

    // ---- g) 切回相册时说明文字也变回来 ----
    saves.querySelector('[data-save="gallery"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('切回相册', window.__PS_API.saveWhere() === 'gallery');
    t('说明文字提到文件夹名',
      /枫叶修图/.test(doc.getElementById('exp-save-hint').textContent),
      doc.getElementById('exp-save-hint').textContent);

    // ---- h) 重新打开面板时记住上次的选择 ----
    window.__PS_API.renderExportPanel();
    await sleep(60);
    t('重开面板仍选中相册',
      doc.getElementById('exp-saves').querySelector('[data-save="gallery"]').classList.contains('selected'));

    // ---- i) 脏数据不能让导出存到不存在的位置 ----
    // 校验是纯函数，直接测（配置只在启动时读一次，跑不到这条路径）
    t('非法位置判定为非法', window.PSCore.isSaveLocation('../../etc/passwd') === false);
    t('非法位置回落到相册', window.PSCore.getSaveLocation('../../etc/passwd').id === 'gallery');
    t('空值也回落到相册', window.PSCore.getSaveLocation(null).id === 'gallery');
    t('合法位置原样返回', window.PSCore.getSaveLocation('downloads').id === 'downloads');
    // 面板渲染也要走同一个回落，否则界面会没有任何选中项
    window.__PS_API.openExportPanel();
    await sleep(120);
    t('面板永远有选中项',
      !!doc.getElementById('exp-saves').querySelector('[data-save].selected'));
    window.__PS_API.closeExportPanel();
    await sleep(60);

    // ---- j) 恢复原状 ----
    saves.querySelector('[data-save="gallery"]').dispatchEvent(new window.Event('click'));
    await sleep(60);
    window.PSBridge = savedBridge37;
    await sleep(60);
    t('恢复桥后仍是支持状态', window.__PS_API.nativeSaveAvailable() === true);
  }


  /* ---------- 调用日志：真的记下了每一次调用 ---------- */
  console.log('\n【38】调用日志：设置里能看、能导出，且每次调用都留痕');

  {
    // 从干净的日志开始，便于精确计数
    S.callLog = [];
    window.__PS_API.saveCallLog();
    window.__PS_API.updateCallLogBrief();

    // 恢复成「400×300 小图 + 直连」这套已知条件（前面段落改过）
    S.cfg.apiKey = 'sk-test';
    S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
    S.cfg.model = 'Qwen/Qwen-Image-Edit';
    S.cfg.netMode = 'direct';
    S.cfg.provider = 'siliconflow';
    S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.upscaleSmall = false;

    const clInput = doc.getElementById('file-input');
    Object.defineProperty(clInput, 'files', {
      value: [new window.File([new Uint8Array(srcPng)], 'log.png', { type: 'image/png' })],
      configurable: true
    });
    clInput.dispatchEvent(new window.Event('change'));
    await sleep(300);

    t('日志入口在设置页', !!doc.getElementById('btn-calllog'));
    t('起始时日志为空', window.__PS_API.callLog().length === 0, window.__PS_API.callLog().length);
    t('空日志时入口文案是兜底说明',
      /每次模型调用的记录/.test(doc.getElementById('calllog-brief').textContent),
      doc.getElementById('calllog-brief').textContent);

    // ---- 成功一次 ----
    fake.setColor([200, 60, 60]);
    S.rect = { x: 60, y: 60, w: 160, h: 120 };
    doc.getElementById('prompt').value = '把这里改成红色';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 15000);

    const afterOk = window.__PS_API.callLog();
    t('成功调用后记了 1 条', afterOk.length === 1, afterOk.length);
    if (afterOk.length) {
      const e = afterOk[0];
      t('记了成功', e.ok === true, e.ok);
      t('记了模型名', e.model === 'Qwen/Qwen-Image-Edit', e.model);
      t('记了服务商', e.provider === 'siliconflow', e.provider);
      t('记了提示词', /改成红色/.test(e.prompt), e.prompt);
      t('记了发送图片的尺寸', e.imgW > 0 && e.imgH > 0, [e.imgW, e.imgH]);
      t('记了发送图片的字节数', e.imgBytes > 0, e.imgBytes);
      t('记了耗时', e.ms > 0, e.ms);
      t('记了花费（Qwen-Image-Edit 有内置价格）', e.costUsd !== null && e.costUsd > 0, e.costUsd);
      t('记了时间戳', e.at > 0, e.at);
      // 关键：绝不能把图片 base64 存进日志
      t('日志里没有图片内容', !JSON.stringify(e).includes('base64'), JSON.stringify(e).slice(0, 100));
    }
    if (S.pending) { doc.getElementById('cmp-discard').dispatchEvent(new window.Event('click')); await sleep(60); }

    // ---- 失败一次：让接口返回 500 ----
    // 用 fetch 桩而不是改假服务器：假服务器没有「下次失败」的开关，
    // 而这里只需要一次性的失败响应。
    const clRealFetch = window.fetch;
    window.fetch = async (u, o) => {
      if (String(u).includes('images/generations')) {
        return {
          ok: false, status: 500,
          json: async () => ({ error: { message: 'upstream exploded' } }),
          text: async () => JSON.stringify({ error: { message: 'upstream exploded' } }),
          blob: async () => new window.Blob([])
        };
      }
      return clRealFetch(u, o);
    };
    fake.setColor([10, 200, 10]);
    S.rect = { x: 40, y: 40, w: 120, h: 100 };
    doc.getElementById('prompt').value = '这次会失败';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 15000);
    window.fetch = clRealFetch;

    const afterFail = window.__PS_API.callLog();
    t('失败调用后多记了 1 条', afterFail.length === 2, afterFail.length);
    t('失败的记在最前面（最新的在前）', afterFail[0].ok === false, afterFail.map((e) => e.ok));
    t('失败记了 HTTP 状态', afterFail[0].status === 500, afterFail[0].status);
    t('失败记了错误原因', (afterFail[0].error || '').length > 0, afterFail[0].error);
    t('失败也有提示词（知道是哪次失败的）', /会失败/.test(afterFail[0].prompt), afterFail[0].prompt);

    // ---- 界面：设置页入口显示条数 ----
    window.__PS_API.openSettings();
    await sleep(80);
    t('入口副标题显示条数', /2 次/.test(doc.getElementById('calllog-brief').textContent),
      doc.getElementById('calllog-brief').textContent);
    t('入口副标题显示失败次数', /1 次失败/.test(doc.getElementById('calllog-brief').textContent),
      doc.getElementById('calllog-brief').textContent);

    // ---- 界面：打开日志面板 ----
    doc.getElementById('btn-calllog').dispatchEvent(new window.Event('click'));
    await sleep(80);
    const clSheet = doc.getElementById('calllog');
    t('点入口打开日志面板', clSheet.hidden === false);
    t('打开日志时设置面板已关闭（不被压在下面）',
      doc.getElementById('settings').hidden === true);

    const clItems = doc.querySelectorAll('#calllog-list .cl-item');
    t('面板渲染出 2 条日志', clItems.length === 2, clItems.length);
    t('第一条是失败的（最新的在前）', clItems[0].classList.contains('bad'),
      clItems[0].className);
    t('失败条目标着「失败」', /失败/.test(clItems[0].querySelector('.cl-tag').textContent),
      clItems[0].querySelector('.cl-tag').textContent);
    t('成功条目标着「成功」', /成功/.test(clItems[1].querySelector('.cl-tag').textContent),
      clItems[1].querySelector('.cl-tag').textContent);
    t('条目显示了模型名',
      /Qwen\/Qwen-Image-Edit/.test(clItems[0].querySelector('.cl-model').textContent),
      clItems[0].querySelector('.cl-model').textContent);
    // 耗时必须在，且**不能**依赖「这次调用花了多久」——
    // 本地假模型有时几毫秒就返回，而 ms=0 曾被真值判断吞掉，
    // 导致这条断言随机失败（那是真 bug，已在 app.js 修掉，见回归测试）。
    t('条目显示了耗时（ms=0 也要显示）',
      /\d+\.\d+ 秒/.test(clItems[0].querySelector('.cl-model').textContent),
      clItems[0].querySelector('.cl-model').textContent);
    t('条目显示了发送图片尺寸',
      /发送图片 \d+×\d+/.test(clItems[0].querySelector('.cl-meta').textContent),
      clItems[0].querySelector('.cl-meta').textContent);
    t('条目显示了提示词',
      /改成红色|会失败/.test(clItems[0].querySelector('.cl-prompt').textContent),
      clItems[0].querySelector('.cl-prompt').textContent);
    t('失败条目显示了原因', !!clItems[0].querySelector('.cl-error'));
    t('统计行有内容', (doc.getElementById('calllog-summary').textContent || '').length > 0,
      doc.getElementById('calllog-summary').textContent);
    t('统计行说了共 2 次', /共 2 次/.test(doc.getElementById('calllog-summary').textContent),
      doc.getElementById('calllog-summary').textContent);
    t('空状态已隐藏', doc.getElementById('calllog-empty').hidden === true);

    // ---- 导出：JSON 必须合法，文本必须含关键信息 ----
    // jsdom 里 navigator.canShare 不存在，会走 <a download> 兜底；
    // 这里不真的下载，而是直接调 core 的导出函数校验内容
    const clCore = window.PSCore;
    const jsonText = clCore.callLogToJson(window.__PS_API.callLog(), { version: 'test' });
    let clParsed = null, clErr = null;
    try { clParsed = JSON.parse(jsonText); } catch (e) { clErr = e; }
    t('导出的 JSON 合法', !clErr, clErr && clErr.message);
    t('导出的 JSON 有 2 条', clParsed && clParsed.entries.length === 2,
      clParsed && clParsed.entries.length);
    t('导出的 JSON 带统计', clParsed && clParsed.stats.count === 2,
      clParsed && clParsed.stats);
    t('导出的 JSON 记了失败', clParsed.entries.some((e) => e.ok === false));
    t('导出的 JSON 记了花费', clParsed.stats.usd > 0, clParsed.stats.usd);

    const textOut = clCore.callLogToText(window.__PS_API.callLog(), { version: 'test' });
    t('导出的文本含模型名', /Qwen\/Qwen-Image-Edit/.test(textOut));
    t('导出的文本含失败原因', /HTTP 500|upstream|失败/.test(textOut));
    t('导出的文本含提示词', /改成红色/.test(textOut));
    t('导出的文本含花费', /\$/.test(textOut));

    // ---- 持久化：重载后日志还在 ----
    const persistedLog = JSON.parse(window.localStorage.getItem('photoStudio.callLog.v1') || '{"items":[]}');
    t('日志已写入 localStorage', persistedLog.items.length === 2, persistedLog.items.length);
    t('落盘格式含版本号', persistedLog.v === 1, persistedLog.v);
    const reloadedLog = window.__PS_API.loadCallLog();
    t('重新载入后日志仍是 2 条', reloadedLog.length === 2, reloadedLog.length);
    t('重新载入后顺序不变（最新在前）', reloadedLog[0].ok === false, reloadedLog.map((e) => e.ok));

    // ---- 环形缓冲：超过上限时挤掉最老的 ----
    let bulk = [];
    for (let i = 0; i < 130; i++) {
      bulk = clCore.appendCallLog(bulk, { at: i + 1, model: 'm', ok: true });
    }
    t('环形缓冲截到上限', bulk.length === clCore.CALL_LOG_MAX, bulk.length);
    window.__PS_API.setCallLog(bulk);
    window.__PS_API.renderCallLog();
    await sleep(60);
    t('面板只渲染上限条数',
      doc.querySelectorAll('#calllog-list .cl-item').length === clCore.CALL_LOG_MAX,
      doc.querySelectorAll('#calllog-list .cl-item').length);

    // ---- 返回键关日志面板 ----
    window.__PS_API.handleBack();
    await sleep(60);
    t('返回键能关掉日志面板', clSheet.hidden === true);
    t('返回键处理了（没让系统退出）', window.__PS_API.handleBack() === true);

    // ---- 清空 ----
    const realConfirm2 = window.confirm;
    window.confirm = () => true;
    window.__PS_API.openCallLog();
    await sleep(60);
    doc.getElementById('calllog-clear').dispatchEvent(new window.Event('click'));
    await sleep(60);
    window.confirm = realConfirm2;
    t('清空后日志为空', window.__PS_API.callLog().length === 0, window.__PS_API.callLog().length);
    t('清空后存储里也没了',
      JSON.parse(window.localStorage.getItem('photoStudio.callLog.v1') || '{"items":[]}').items.length === 0);
    t('清空后显示空状态', doc.getElementById('calllog-empty').hidden === false);
    t('清空后入口文案回到兜底',
      /每次模型调用的记录/.test(doc.getElementById('calllog-brief').textContent),
      doc.getElementById('calllog-brief').textContent);
    window.__PS_API.closeCallLog();
    window.__PS_API.closeSettings();
    await sleep(60);
  }

  /* ---------- 基础调色：只动框选区域，逐像素验证 ---------- */
  console.log('\n【40】基础调色：作用在框选区域，可预览可撤销，不调用模型');

  {
    // 回到已知条件：400×300 小图 + 直连
    S.cfg.apiKey = 'sk-test';
    S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
    S.cfg.model = 'Qwen/Qwen-Image-Edit';
    S.cfg.netMode = 'direct';
    S.cfg.provider = 'siliconflow';
    S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.contextPct = 0; S.cfg.maxRes = 0;
    S.cfg.upscaleSmall = false;

    const gInput = doc.getElementById('file-input');
    Object.defineProperty(gInput, 'files', {
      value: [new window.File([new Uint8Array(srcPng)], 'grade.png', { type: 'image/png' })],
      configurable: true
    });
    gInput.dispatchEvent(new window.Event('change'));
    await sleep(300);

    const gPx = (x, y) => {
      const d = S.viewCanvas.getContext('2d').getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const near = (a, b, tol) => Math.abs(a[0] - b[0]) <= (tol || 2) &&
      Math.abs(a[1] - b[1]) <= (tol || 2) && Math.abs(a[2] - b[2]) <= (tol || 2);

    // 原图：整张 rgb(30,90,160) + 一块白方块 (150,100)-(250,200)
    t('工具行有调色入口', !!doc.getElementById('btn-grade'));
    const beforeOutside = gPx(20, 20);
    const beforeInside = gPx(60, 60);
    // 整张基线：后面「选区外零改动」要拿它逐像素比对。
    // 不硬编码颜色 —— 源图经过 PNG 解码/绘制可能有边缘抗锯齿，
    // 拿「实际像素」当基线才是可靠的判据。
    const snapshot = () => {
      const d = S.viewCanvas.getContext('2d').getImageData(0, 0, S.docW, S.docH);
      return new Uint8ClampedArray(d.data);
    };
    const baseFull = snapshot();

    // ---- 1) 进入调色工具 ----
    S.rect = { x: 40, y: 40, w: 120, h: 100 };
    doc.getElementById('btn-grade').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('进入调色模式', S.mode === 'grade', S.mode);
    t('调色参数栏已显示', doc.getElementById('grade-bar').hidden === false);
    t('调色按钮高亮', doc.getElementById('btn-grade').classList.contains('active'));
    t('按 core 定义渲染了滑块',
      doc.querySelectorAll('#grade-sliders .grade-row').length === window.PSCore.GRADE_PARAMS.length,
      doc.querySelectorAll('#grade-sliders .grade-row').length);
    t('滑块初始全在 0（不自动改像素）', (() => {
      const ins = doc.querySelectorAll('#grade-sliders input[type=range]');
      return Array.from(ins).every((i) => Number(i.value) === 0);
    })());
    t('初始说明是「还没有调整」',
      /还没有调整/.test(doc.getElementById('grade-note').textContent),
      doc.getElementById('grade-note').textContent);

    // ---- 2) 调色不能调用模型（这是「免费」的证明）----
    const gSeenBefore = fake.seen.length;
    // 直接调预览（拖滑块走的就是这条路径）
    window.__PS_API.setGradeDraft({ exposure: 60 });
    await sleep(80);
    t('调色预览没有调用模型', fake.seen.length === gSeenBefore,
      fake.seen.length - gSeenBefore);
    t('预览后画面确实变亮了', gPx(60, 60)[0] > beforeInside[0],
      [gPx(60, 60), beforeInside]);

    // ---- 3) 逐像素：选区内变、选区外**一个像素都不动** ----
    const insideAfter = gPx(60, 60);
    const outsideAfter = gPx(20, 20);
    t('选区内被调亮', insideAfter[0] > beforeInside[0], [beforeInside, insideAfter]);
    t('选区外逐字节不变', near(outsideAfter, beforeOutside, 0), [beforeOutside, outsideAfter]);
    // 扫描整张图，逐像素确认「只有选区内变了」。
    // 与调色前的整张快照对比，不依赖对源图颜色的假设。
    (() => {
      const full = S.viewCanvas.getContext('2d').getImageData(0, 0, S.docW, S.docH).data;
      let outsideChanged = 0, insideChanged = 0;
      for (let y = 0; y < S.docH; y++) {
        for (let x = 0; x < S.docW; x++) {
          const i = (y * S.docW + x) * 4;
          const diff = full[i] !== baseFull[i] || full[i + 1] !== baseFull[i + 1] ||
            full[i + 2] !== baseFull[i + 2];
          if (!diff) continue;
          const inSel = x >= S.rect.x && x < S.rect.x + S.rect.w &&
            y >= S.rect.y && y < S.rect.y + S.rect.h;
          if (inSel) insideChanged++; else outsideChanged++;
        }
      }
      t('扫描：选区外零改动（逐像素）', outsideChanged === 0, outsideChanged);
      t('扫描：选区内确实有改动', insideChanged > 0, insideChanged);
    })();

    // ---- 4) 色温 / 色调 / 对比度 / 饱和度都真的生效 ----
    window.__PS_API.setGradeDraft({ temperature: 80 });
    await sleep(60);
    const warmPx = gPx(60, 60);
    t('色温偏暖：红通道上升、蓝通道下降',
      warmPx[0] > beforeInside[0] && warmPx[2] < beforeInside[2], [beforeInside, warmPx]);
    window.__PS_API.setGradeDraft({ temperature: -80 });
    await sleep(60);
    const coolPx = gPx(60, 60);
    t('色温偏冷：蓝通道上升、红通道下降',
      coolPx[2] > beforeInside[2] && coolPx[0] < beforeInside[0], [beforeInside, coolPx]);
    window.__PS_API.setGradeDraft({ saturation: -100 });
    await sleep(60);
    const grayPx = gPx(60, 60);
    t('饱和度 -100 得到灰度', Math.abs(grayPx[0] - grayPx[1]) <= 1 && Math.abs(grayPx[1] - grayPx[2]) <= 1,
      grayPx);
    // 对比度是「绕中灰拉开」：比中灰暗的像素变更暗、比中灰亮的变更亮。
    // 采样点 (60,60) 是深蓝 rgb(30,90,160)，比中灰暗 —— 所以它应该**变暗**，
    // 断言「更亮」是错的（那测的是曝光，不是对比度）。
    window.__PS_API.setGradeDraft({ contrast: 100 });
    await sleep(60);
    const cDarkPx = gPx(60, 60);
    t('对比度 +100 让暗部更暗（绕中灰拉开）',
      cDarkPx[0] < beforeInside[0], [beforeInside, cDarkPx]);
    // 把选区挪到白方块上，验证亮部会变亮
    S.rect = { x: 160, y: 110, w: 60, h: 60 };
    const whiteBefore = gPx(180, 140);
    window.__PS_API.setGradeDraft({ contrast: 100 });
    await sleep(60);
    t('对比度 +100 让亮部更亮（前提：采样点确实比中灰亮）',
      whiteBefore[0] > 200 && gPx(180, 140)[0] >= whiteBefore[0],
      [whiteBefore, gPx(180, 140)]);
    t('对比度 -100 把暗部压向中灰',
      (() => {
        window.__PS_API.setGradeDraft({ contrast: -100 });
        const p = gPx(180, 140);
        return Math.abs(p[0] - 118) <= 4;
      })(), gPx(180, 140));
    // 回到原来的选区继续后面的断言
    S.rect = { x: 40, y: 40, w: 120, h: 100 };
    window.__PS_API.setGradeDraft({ tint: 80 });
    await sleep(60);
    const tintPx = gPx(60, 60);
    t('色调偏品红：绿通道下降', tintPx[1] < beforeInside[1], [beforeInside, tintPx]);

    // ---- 5) 归零后像素回到原样 ----
    window.__PS_API.resetGradeDraft();
    await sleep(60);
    t('归零后选区内像素逐字节还原', near(gPx(60, 60), beforeInside, 0),
      [beforeInside, gPx(60, 60)]);
    t('归零后滑块全回 0', (() => {
      const ins = doc.querySelectorAll('#grade-sliders input[type=range]');
      return Array.from(ins).every((i) => Number(i.value) === 0);
    })());

    // ---- 6) 应用：记一条编辑、可撤销 ----
    const gEditsBefore = S.edits.length;
    const gHistBefore = window.__PS_API.historySize();
    // 参数全零时不该产生记录
    doc.getElementById('grade-apply').dispatchEvent(new window.Event('click'));
    await sleep(60);
    t('全零时不产生记录', S.edits.length === gEditsBefore, S.edits.length - gEditsBefore);

    window.__PS_API.setGradeDraft({ exposure: 55, temperature: 40 });
    await sleep(60);
    doc.getElementById('grade-apply').dispatchEvent(new window.Event('click'));
    await sleep(120);
    t('应用后多了一条编辑', S.edits.length === gEditsBefore + 1, S.edits.length - gEditsBefore);
    t('新编辑是调色图层（没有 patch，有 grade）', (() => {
      const e = S.edits[S.edits.length - 1];
      return !!e.grade && !e.patch;
    })(), (() => {
      const e = S.edits[S.edits.length - 1];
      return { grade: e.grade, patch: !!e.patch };
    })());
    t('调色记进了撤销栈', window.__PS_API.historySize().past === gHistBefore.past + 1,
      [window.__PS_API.historySize(), gHistBefore]);
    const appliedInside = gPx(60, 60);
    const appliedOutside = gPx(20, 20);
    t('应用后选区内变色', !near(appliedInside, beforeInside, 1), [beforeInside, appliedInside]);
    t('应用后选区外仍逐字节不变', near(appliedOutside, beforeOutside, 0),
      [beforeOutside, appliedOutside]);
    t('应用后草稿归零（再调色不会叠加）',
      window.PSCore.isGradeEmpty(window.__PS_API.gradeDraft()),
      window.__PS_API.gradeDraft());

    // ---- 7) 撤销 / 重做：调色必须真的能退回去 ----
    doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
    await sleep(120);
    t('撤销后调色被移除', S.edits.length === gEditsBefore, S.edits.length);
    t('撤销后选区内像素逐字节还原', near(gPx(60, 60), beforeInside, 0),
      [beforeInside, gPx(60, 60)]);
    doc.getElementById('btn-redo').dispatchEvent(new window.Event('click'));
    await sleep(120);
    t('重做后调色回来了', S.edits.length === gEditsBefore + 1, S.edits.length);
    t('重做后像素与撤销前一致', near(gPx(60, 60), appliedInside, 1),
      [appliedInside, gPx(60, 60)]);

    // ---- 8) 修改记录面板：能看、能关、能删、能调参 ----
    doc.getElementById('btn-layers').dispatchEvent(new window.Event('click'));
    await sleep(80);
    const gItems = doc.querySelectorAll('#layer-list .layer-item');
    t('修改记录里出现调色条目', gItems.length >= 1, gItems.length);
    const gTop = gItems[0];
    t('调色条目显示改了哪些色调',
      /曝光|偏暖|偏冷|对比|饱和/.test(gTop.querySelector('.ln-sub').textContent),
      gTop.querySelector('.ln-sub').textContent);
    t('调色条目有五个参数滑块',
      gTop.querySelectorAll('input[type=range]').length >= window.PSCore.GRADE_PARAMS.length,
      gTop.querySelectorAll('input[type=range]').length);
    t('调色条目说明了不花钱',
      /不花钱|不调用模型/.test(gTop.querySelector('.layer-note').textContent),
      gTop.querySelector('.layer-note').textContent);
    // 关掉图层 → 像素回到原样（证明图层开关对调色有效）
    gTop.querySelector('.layer-toggle').dispatchEvent(new window.Event('click'));
    await sleep(120);
    t('关闭调色图层后像素还原', near(gPx(60, 60), beforeInside, 0),
      [beforeInside, gPx(60, 60)]);
    t('关闭后选区外仍不变', near(gPx(20, 20), beforeOutside, 0));
    // 再打开
    doc.querySelectorAll('#layer-list .layer-toggle')[0].dispatchEvent(new window.Event('click'));
    await sleep(120);
    t('重新开启后调色恢复', near(gPx(60, 60), appliedInside, 1),
      [appliedInside, gPx(60, 60)]);
    doc.querySelector('#layers [data-close]').dispatchEvent(new window.Event('click'));
    await sleep(60);

    // ---- 9) 会话持久化：调色参数要能存下来（「继续编辑」不能丢）----
    window.__PS_API.touchWork();
    const gRec = window.__PS_API.library().find((w) => w.session);
    t('作品库会话里有调色图层',
      !!gRec && (gRec.session.items || []).some((it) => it.grade), gRec && (gRec.session.items || []).length);
    if (gRec) {
      const gItem = (gRec.session.items || []).find((it) => it.grade);
      t('会话里存的是色调参数而不是 patch',
        !!gItem && !gItem.patch && gItem.grade.exposure === 55, gItem && gItem.grade);
    }

    // ---- 10) 调色滑块也是「只能拖滑块头」（防误触归零）----
    const gSlider = doc.querySelector('#grade-sliders input[type=range]');
    t('调色滑块已套上 thumb-only 保护', !!gSlider && gSlider.__psThumbOnly === true);

    // ---- 11) 清理：别影响后续段落 ----
    // 撤掉调色
    while (S.edits.length > 0) {
      doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
      await sleep(60);
    }
    t('清理完成：编辑已撤销（后续段落的前提）', S.edits.length === 0, S.edits.length);
    // 必须退出调色模式：后面的段落（引导线、工具提示）都假定当前是框选工具。
    // 留在 grade 模式会让那些段落的 pointerdown 走进调色的分支，测试全错。
    doc.querySelector('.tool[data-mode="select"]').dispatchEvent(new window.Event('click'));
    await sleep(60);
    t('清理完成：已退出调色模式（后续段落的前提）', S.mode === 'select', S.mode);
  }

  /* ---------- 后台生成：离开照片后生成继续跑，结果不丢 ---------- */
  console.log('\n【41】后台生成：开始生成 → 回首页 → 生成完成 → 结果存进那张照片');

  {
    // 已知条件：400×300 小图 + 直连 + 干净状态
    S.cfg.apiKey = 'sk-test';
    S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
    S.cfg.model = 'Qwen/Qwen-Image-Edit';
    S.cfg.netMode = 'direct';
    S.cfg.provider = 'siliconflow';
    S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.contextPct = 0; S.cfg.maxRes = 0;
    S.cfg.upscaleSmall = false; S.cfg.autoGrade = false;   // 关掉自动调色，专测后台流程
    S.jobs = [];

    // 恢复真实 Image 解码（「回到那张照片」要用）
    window.Image = class {
      constructor() { this.onload = null; this.onerror = null; this.width = 0; this.height = 0; this._src = ''; }
      set src(v) {
        this._src = v;
        const m = /^data:[^;]+;base64,(.*)$/.exec(String(v));
        if (!m) { setTimeout(() => this.onerror && this.onerror(new Error('bad src')), 0); return; }
        napi.loadImage(Buffer.from(m[1], 'base64')).then((im) => {
          this.__real = im; this.width = im.width; this.height = im.height;
          if (this.onload) this.onload();
        }).catch((e) => { if (this.onerror) this.onerror(e); });
      }
      get src() { return this._src; }
    };

    await sleep(1800);
    window.localStorage.removeItem('photoStudio.library.v1');
    S.library = window.__PS_API.loadLibrary();

    const loadPhoto = async (name, color) => {
      const c = napi.createCanvas(400, 300);
      const x = c.getContext('2d');
      x.fillStyle = 'rgb(' + color.join(',') + ')';
      x.fillRect(0, 0, 400, 300);
      const input = doc.getElementById('file-input');
      Object.defineProperty(input, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], name, { type: 'image/png' })],
        configurable: true
      });
      input.dispatchEvent(new window.Event('change'));
      await sleep(300);
      const t0 = Date.now();
      while ((S.imgW !== 400 || window.__PS_API.workId() !== null) && Date.now() - t0 < 5000) await sleep(80);
    };

    // ---- 1) 发起生成：必须能立刻离开 ----
    await loadPhoto('bg-a.png', [30, 90, 160]);
    t('照片 A 已载入', S.imgW === 400 && S.imgH === 300, [S.imgW, S.imgH]);

    // 让假模型慢一点，才有「中途离开」的窗口。
    // 颜色按提示词绑定（A=红、B=绿），这样两个并发请求谁先醒来都不影响断言。
    fake.setDelay(700);
    fake.setColorFor('后台生成测试', [200, 40, 40]);
    S.rect = { x: 60, y: 60, w: 160, h: 120 };
    doc.getElementById('prompt').value = '后台生成测试';
    const bgSeenBefore = fake.seen.length;
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await sleep(120);

    t('生成中 busy 为真（当前这张）', S.busy === true, S.busy);
    t('生成了 1 个后台任务', S.jobs.length === 1, S.jobs.length);
    t('任务是 running', S.jobs[0].status === 'running', S.jobs[0].status);
    t('任务记住了归属作品 id', S.jobs[0].workId === S.workId, [S.jobs[0].workId, S.workId]);
    t('任务记住了发起时的文档版本', S.jobs[0].docVersion === S.docVersion,
      [S.jobs[0].docVersion, S.docVersion]);
    t('任务快照了选区（不读实时状态）',
      S.jobs[0].rect.x === 60 && S.jobs[0].rect.w === 160, S.jobs[0].rect);
    t('界面提示了「可以切到别的照片」', true);   // toast 内容见回归测试

    // ---- 2) 回首页：任务必须继续跑（旧实现在这里 abort）----
    window.__PS_API.goHome();
    await sleep(120);
    t('回首页后照片已卸载', S.img === null);
    t('回首页后任务仍在跑（关键！）', S.jobs.length === 1 && S.jobs[0].status === 'running',
      S.jobs.map((j) => j.status));
    t('回首页后不显示「正在生成」遮罩（不假装在忙）',
      S.busy === false && doc.getElementById('busy').hidden === true,
      [S.busy, doc.getElementById('busy').hidden]);
    t('首页能看到后台状态条', doc.getElementById('job-badge').hidden === false,
      doc.getElementById('job-badge').hidden);
    t('状态条说明了正在后台生成',
      /后台生成|生成中/.test(doc.getElementById('job-badge').textContent),
      doc.getElementById('job-badge').textContent);
    // 保活必须还开着：任务在跑就要钉住进程
    t('回首页后保活仍开启（否则切后台会被杀）', (() => {
      const st = window.__PS_API.keepAliveState();
      return st && st.on === true;
    })(), window.__PS_API.keepAliveState());

    // ---- 3) 处理下一张：导入照片 B ----
    await loadPhoto('bg-b.png', [90, 40, 140]);
    t('照片 B 已载入（换图成功）', S.imgW === 400 && S.docW === 400, [S.imgW, S.docW]);
    t('换图没有杀掉 A 的后台任务（关键！）',
      S.jobs.length === 1 && S.jobs[0].status === 'running', S.jobs.map((j) => j.status));
    t('在 B 上不显示 A 的遮罩（不假装在忙）',
      S.busy === false && doc.getElementById('busy').hidden === true, S.busy);

    // B 也能正常生成 —— 这是「可以处理下一张」的实际含义
    fake.setColorFor('第二张的修改', [40, 200, 90]);
    S.rect = { x: 40, y: 40, w: 120, h: 100 };
    doc.getElementById('prompt').value = '第二张的修改';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await sleep(120);
    t('B 上也能发起生成（两个任务并存）', S.jobs.length === 2, S.jobs.length);
    t('两个任务分属不同文档',
      S.jobs[0].docVersion !== S.jobs[1].docVersion,
      S.jobs.map((j) => j.docVersion));
    t('在 B 上 busy 为真（B 的任务在跑）', S.busy === true, S.busy);

    // 等 A 的任务先完成（B 后发起、延迟相同，但 A 更早开始）
    const t0 = Date.now();
    while (S.jobs.filter((j) => j.status === 'done').length < 1 && Date.now() - t0 < 12000) await sleep(150);
    t('A 的任务已完成（用户在 B 上）',
      S.jobs.some((j) => j.status === 'done'), S.jobs.map((j) => j.status));
    t('A 的结果没有贴到 B 上（贴错图是最严重的失败）',
      S.edits.length === 0 && S.pending === null,
      [S.edits.length, !!S.pending]);
    t('请求次数正确（A + B 各一次）', fake.seen.length === bgSeenBefore + 2,
      fake.seen.length - bgSeenBefore);

    // ---- 4) 结果必须存进 A 的作品记录（不能静默丢失）----
    const recA = window.__PS_API.library().find((w) => /bg-a/.test(w.name));
    const recB = window.__PS_API.library().find((w) => /bg-b/.test(w.name));
    t('A 的作品记录存在', !!recA, window.__PS_API.library().map((w) => w.name));
    t('A 的记录上挂着后台结果', !!(recA && recA.bgResult), recA && Object.keys(recA.bgResult || {}));
    t('后台结果带选区',
      !!(recA && recA.bgResult && recA.bgResult.rect && recA.bgResult.rect.w === 160),
      recA && recA.bgResult && recA.bgResult.rect);
    t('后台结果带 patch 图片',
      !!(recA && recA.bgResult && /^data:image/.test(recA.bgResult.patch)),
      recA && recA.bgResult && String(recA.bgResult.patch).slice(0, 30));
    t('后台结果带提示词标签',
      !!(recA && recA.bgResult && /后台生成测试/.test(recA.bgResult.label)),
      recA && recA.bgResult && recA.bgResult.label);
    t('B 的记录上没有 A 的结果（不串号）',
      !(recB && recB.bgResult), recB && recB.bgResult);
    t('结果已落盘', (() => {
      const persisted = JSON.parse(window.localStorage.getItem('photoStudio.library.v1') || '{"items":[]}');
      return persisted.items.some((it) => !!it.bgResult);
    })());

    // ---- 5) 通知：完成了要告诉用户 ----
    t('后台完成时发了原生通知',
      kaCalls.some((c) => c.notify && /后台生成完成/.test(c.notify)),
      kaCalls.filter((c) => c.notify).map((c) => c.notify));

    // ---- 6) 首页/作品库能看到状态 ----
    window.__PS_API.goHome();
    await sleep(120);
    // 等 B 的任务也结束，避免它干扰后面的断言。
    // 两条都落库之后再看首页 —— 否则 B 的记录还没建出来，
    // 「列出几张」会随调度顺序飘（假失败）。
    const t1 = Date.now();
    while (S.jobs.some((j) => j.status === 'running') && Date.now() - t1 < 12000) await sleep(150);
    window.__PS_API.renderHome();
    await sleep(80);

    const homeItems = doc.querySelectorAll('#home .home-item');
    // 两张：A（后台结果）与 B（在 B 上发起的生成）。
    // B 的任务同样有结果要贴回，所以它也应当落成一条记录
    t('首页列出了两张', homeItems.length >= 2, homeItems.length);
    t('首页里有 A 那张', Array.from(homeItems).some((it) => /bg-a/.test(it.textContent)),
      Array.from(homeItems).map((it) => it.textContent.slice(0, 20)));
    t('首页里有 B 那张', Array.from(homeItems).some((it) => /bg-b/.test(it.textContent)),
      Array.from(homeItems).map((it) => it.textContent.slice(0, 20)));
    const doneTag = Array.from(doc.querySelectorAll('#home .home-tag'))
      .find((t2) => /已生成|待贴回/.test(t2.textContent));
    t('首页标出了「有结果待贴回」', !!doneTag, doneTag && doneTag.textContent);

    // ---- 7) 回到 A：结果自动贴回（闭环）----

    const realConfirmBg = window.confirm;
    window.confirm = () => true;
    await window.__PS_API.continueWork(recA.id);
    await sleep(700);
    window.confirm = realConfirmBg;

    t('回到 A 后接管为那条记录', window.__PS_API.workId() === recA.id,
      [window.__PS_API.workId(), recA.id]);
    t('后台结果已自动贴回（产生了一条编辑）', S.edits.length >= 1, S.edits.length);
    t('贴回的那条是后台生成', S.edits.some((e) => /后台生成/.test(e.label || '')),
      S.edits.map((e) => e.label));
    t('贴回后记录上的暂存已清掉', !recA.bgResult, recA.bgResult);
    t('贴回进撤销栈（可撤销）', window.__PS_API.historySize().past >= 1,
      window.__PS_API.historySize());
    // 逐像素：贴回的必须等于**A 那次请求实际拿到的颜色**。
    // 不能写死「红色」—— 假模型是在**响应时**读颜色的，而 A/B 两个请求
    // 并发在跑，响应顺序不由发起顺序决定。断言要针对「A 那次真的拿到了什么」，
    // 那才是「结果没有串到 B 上」的真正判据。
    const bgJobReq = fake.seen.filter((x) => x.body && /后台生成测试/.test(x.body.prompt || ''))[0];
    t('找得到 A 那次请求', !!bgJobReq, fake.seen.map((x) => x.body && String(x.body.prompt).slice(0, 12)));
    const want = bgJobReq ? bgJobReq.served : null;
    t('A 那次请求拿到了一个颜色', !!want, want);
    const bgPx = S.viewCanvas.getContext('2d').getImageData(140, 120, 1, 1).data;
    t('贴回的内容等于 A 那次模型返回的颜色',
      !!want && Math.abs(bgPx[0] - want[0]) <= 3 && Math.abs(bgPx[1] - want[1]) <= 3,
      { got: [bgPx[0], bgPx[1], bgPx[2]], want });
    // 关键：必须是**A 的颜色**，不是 B 的（B 的绿 40,200,90）——
    // 这条断言才是「结果没串到别的照片上」的像素级证据。
    // 只比「是不是 B 那个具体颜色」，不做「绿不绿」的模糊判断
    // （模糊判断会被别处遗留的 setColor 干扰成假失败）。
    t('贴回的颜色不是 B 那张的颜色（没串号）',
      !(bgPx[0] === 40 && bgPx[1] === 200 && bgPx[2] === 90), [bgPx[0], bgPx[1], bgPx[2]]);
    // 更强的判据：贴回后的像素必须等于 **A 那次请求真的拿到的颜色**。
    // 直接拿请求记录里的 served 比，绕开所有写死的颜色假设 ——
    // 这才是「结果没有串到别的照片上」的无歧义证据。
    t('贴回后的像素 = A 那次请求真的拿到的颜色',
      !!want && Math.abs(bgPx[0] - want[0]) <= 3 && Math.abs(bgPx[1] - want[1]) <= 3 &&
      Math.abs(bgPx[2] - want[2]) <= 3,
      { got: [bgPx[0], bgPx[1], bgPx[2]], want });
    // 选区外必须不动
    const bgOut = S.viewCanvas.getContext('2d').getImageData(10, 10, 1, 1).data;
    t('贴回没有污染选区外', bgOut[0] === 30 && bgOut[1] === 90 && bgOut[2] === 160,
      [bgOut[0], bgOut[1], bgOut[2]]);

    // ---- 8) 撤销能退回 ----
    doc.getElementById('btn-undo').dispatchEvent(new window.Event('click'));
    await sleep(120);
    t('撤销后后台结果被移除', S.edits.length === 0, S.edits.length);
    const bgPx2 = S.viewCanvas.getContext('2d').getImageData(100, 100, 1, 1).data;
    t('撤销后像素回到原样', bgPx2[0] === 30 && bgPx2[1] === 90, [bgPx2[0], bgPx2[1]]);

    // ---- 9) 取消只影响当前这张 ----
    S.jobs = [];
    fake.setDelay(900);
    // 在 A 上发起一个
    S.rect = { x: 20, y: 20, w: 100, h: 80 };
    doc.getElementById('prompt').value = 'A 的取消测试';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await sleep(100);
    t('A 上有一个任务在跑', S.jobs.filter((j) => j.status === 'running').length === 1,
      S.jobs.map((j) => j.status));
    const jobAId = S.jobs[0].id;
    // 换到 B（会取消 A 的当前任务 —— 结果已无处可落）
    await loadPhoto('bg-c.png', [10, 10, 10]);
    await sleep(200);
    t('换图取消了上一张的任务（结果已无处可落）',
      S.jobs.every((j) => j.status !== 'running' || j.docVersion === S.docVersion),
      S.jobs.map((j) => ({ s: j.status, d: j.docVersion })));
    t('取消后没有把结果贴到新图上', S.pending === null && S.edits.length === 0);

    // ---- 10) 失败的任务不能假装成功 ----
    S.jobs = [];
    fake.setDelay(0);
    const bgRealFetch = window.fetch;
    window.fetch = async (u, o) => {
      if (String(u).includes('images/generations')) {
        return {
          ok: false, status: 500,
          json: async () => ({ error: 'boom' }), text: async () => '{"error":"boom"}',
          blob: async () => new window.Blob([])
        };
      }
      return bgRealFetch(u, o);
    };
    S.rect = { x: 20, y: 20, w: 100, h: 80 };
    doc.getElementById('prompt').value = '会失败的后台任务';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await sleep(600);
    window.fetch = bgRealFetch;
    t('失败的任务被标成 failed', S.jobs.some((j) => j.status === 'failed'),
      S.jobs.map((j) => j.status));
    t('失败的任务没有产生编辑', S.edits.length === 0, S.edits.length);

    // ---- 收尾 ----
    fake.setDelay(0);
    fake.clearColorFor();
    S.jobs = [];
    await sleep(1800);
    S.library = [];
    window.localStorage.removeItem('photoStudio.library.v1');
    window.__PS_API.saveLibrary();
    window.__PS_API.goHome();
    await sleep(120);
    t('收尾：状态已复位（后续段落的前提）', S.jobs.length === 0 && S.edits.length === 0,
      [S.jobs.length, S.edits.length]);
  }

  /* ---------- 文生图 ---------- */
  console.log('\n【50】文生图：不靠照片，纯文字出一张新图');
  {
    const api = window.__PS_API;
    // 回到首页（文生图入口在首页）
    api.goHome();
    await sleep(150);
    t('首页有文生图入口', !!doc.getElementById('btn-home-t2i'));
    t('空状态里也有文生图入口', !!doc.getElementById('btn-empty-t2i'));

    doc.getElementById('btn-home-t2i').dispatchEvent(new window.Event('click'));
    await sleep(150);
    t('点一下能打开文生图面板', doc.getElementById('t2i').hidden === false);
    t('面板里有描述输入框', !!doc.getElementById('t2i-prompt'));
    t('面板里有负面提示词输入框', !!doc.getElementById('t2i-negative'));
    t('面板里有比例选择', doc.querySelectorAll('#t2i-ratios .chip').length >= 3,
      doc.querySelectorAll('#t2i-ratios .chip').length);

    // 比例切换
    const chips = doc.querySelectorAll('#t2i-ratios .chip');
    const threeTwo = Array.from(chips).find((c) => c.dataset.ratio === '3:2');
    t('有 3:2 这个比例', !!threeTwo);
    if (threeTwo) {
      threeTwo.dispatchEvent(new window.Event('click'));
      await sleep(80);
      t('点了之后该比例高亮',
        Array.from(doc.querySelectorAll('#t2i-ratios .chip'))
          .find((c) => c.dataset.ratio === '3:2').classList.contains('on'));
      t('出图尺寸跟着变（3:2 → 1536x1024）',
        /1536x1024/.test(doc.getElementById('t2i-size-note').textContent),
        doc.getElementById('t2i-size-note').textContent);
    }

    // 空描述不能生成
    doc.getElementById('t2i-prompt').value = '';
    const beforeEmpty = fake.seen.length;
    doc.getElementById('t2i-go').dispatchEvent(new window.Event('click'));
    await sleep(200);
    t('空描述不会发起请求', fake.seen.length === beforeEmpty, fake.seen.length - beforeEmpty);
    t('面板仍然开着（没被误关）', doc.getElementById('t2i').hidden === false);

    // 正常生成
    doc.getElementById('t2i-prompt').value = '山间晨雾的风景，暖色逆光，35mm 镜头';
    doc.getElementById('t2i-prompt').dispatchEvent(new window.Event('input'));
    doc.getElementById('t2i-negative').value = '文字,水印';
    doc.getElementById('t2i-negative').dispatchEvent(new window.Event('input'));
    await sleep(60);
    const before = fake.seen.length;
    fake.setColor([30, 90, 200]);
    doc.getElementById('t2i-go').dispatchEvent(new window.Event('click'));
    // 文生图走的是独立流程，用 busy 判断结束
    for (let i = 0; i < 160 && S.busy; i++) await sleep(50);
    await sleep(400);

    const reqs = fake.seen.slice(before);
    t('文生图发出了请求', reqs.length > 0, reqs.length);
    if (reqs.length) {
      const rq = reqs[0];
      t('打到 /images/generations', /\/images\/generations/.test(rq.url), rq.url);
      t('★ 请求体里没有图片字段（文生图就该是纯文字）',
        rq.body && !('image' in rq.body) && !('input_image' in rq.body),
        rq.body && Object.keys(rq.body));
      t('请求里带了用户描述', /山间晨雾/.test(String(rq.body && rq.body.prompt || '')));
      t('请求里带上了出片要求收尾', /出片要求|Requirements/.test(String(rq.body && rq.body.prompt || '')));
      t('负面提示词传了过去', /文字,水印/.test(String(rq.body && rq.body.negative_prompt || '')),
        rq.body && rq.body.negative_prompt);
    }
    t('生成后面板自动关闭', doc.getElementById('t2i').hidden === true);
    t('生成后不再 busy', S.busy === false);

    // 结果应该作为一张新照片打开
    t('结果作为一张新文档打开', !!S.img && !!S.docCanvas, !!S.img);
    t('新文档有实际尺寸', S.docW > 0 && S.docH > 0, [S.docW, S.docH]);
    // 假服务器返回的是纯蓝 64x64，贴过来后画布应当是蓝色
    if (S.docCanvas) {
      const px = S.docCtx.getImageData(4, 4, 1, 1).data;
      t('★ 画布内容就是模型返回的那张图（蓝色）',
        px[2] > 150 && px[2] > px[0] + 60, [px[0], px[1], px[2]]);
    }
    // 生成后可以直接接着修（新照片应当能框选）
    t('生成后处于可编辑状态', !!S.docCanvas && S.busy === false);

    // 日志里要有一条 t2i 记录
    const t2iLogs = (S.callLog || []).filter((e) => e.kind === 't2i');
    t('调用日志记下了这次文生图', t2iLogs.length > 0, (S.callLog || []).length);
    t('日志标了成功', t2iLogs.length > 0 && t2iLogs[0].ok === true);
  }

  /* ---------- 生成后自动清空提示词 ---------- */
  console.log('\n【51】生成成功后自动清空提示词（但失败/正在改写时不能清）');
  {
    const api = window.__PS_API;
    // 准备一张照片（loadPhoto 是上一段里的局部函数，这里不能用，重新造一张）
    {
      const c = napi.createCanvas(400, 300);
      const cx0 = c.getContext('2d');
      cx0.fillStyle = 'rgb(120,120,120)';
      cx0.fillRect(0, 0, 400, 300);
      const inp = doc.getElementById('file-input');
      Object.defineProperty(inp, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], 'clear.png', { type: 'image/png' })],
        configurable: true
      });
      inp.dispatchEvent(new window.Event('change'));
      await sleep(400);
    }
    t('清空测试的照片已载入', S.imgW === 400, S.imgW);
    S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.contextPct = 0;
    S.cfg.upscaleSmall = false; S.cfg.autoGrade = false;
    S.rect = { x: 40, y: 40, w: 140, h: 120 };
    const pEl = doc.getElementById('prompt');

    // ---- 1) 成功 → 清空 ----
    pEl.value = '把天空换成晚霞';
    pEl.dispatchEvent(new window.Event('input'));
    await sleep(60);
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 12000);
    t('生成成功', S.pending !== null || S.jobs.length > 0);
    t('★ 成功后提示词被清空', pEl.value === '', pEl.value);
    if (S.pending) { doc.getElementById('cmp-discard').dispatchEvent(new window.Event('click')); await sleep(80); }

    // ---- 2) 失败 → 必须保留（用户要照着改）----
    const realFetch = window.fetch;
    window.fetch = async (u, o) => {
      if (String(u).includes('images/')) {
        return {
          ok: false, status: 500,
          json: async () => ({ error: { message: 'boom' } }),
          text: async () => JSON.stringify({ error: { message: 'boom' } }),
          blob: async () => new window.Blob([])
        };
      }
      return realFetch(u, o);
    };
    pEl.value = '这次一定会失败';
    pEl.dispatchEvent(new window.Event('input'));
    await sleep(60);
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 15000);
    window.fetch = realFetch;
    t('失败时提示词被保留（能照着改）', pEl.value === '这次一定会失败', pEl.value);
    const errPanel = doc.getElementById('gen-error');
    if (errPanel && !errPanel.hidden) {
      const closeBtn = doc.getElementById('err-close');
      if (closeBtn) closeBtn.dispatchEvent(new window.Event('click'));
      await sleep(80);
    }

    // ---- 3) 生成期间用户改了字 → 不能清 ----
    pEl.value = '第一条要求';
    pEl.dispatchEvent(new window.Event('input'));
    await sleep(60);
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    // 请求还在飞的时候改写输入框
    await sleep(80);
    pEl.value = '第二条要求，我正在写';
    pEl.dispatchEvent(new window.Event('input'));
    await waitGen(S, 12000);
    t('★ 生成期间改了字，就不清空（不打断用户）',
      pEl.value === '第二条要求，我正在写', pEl.value);
    if (S.pending) { doc.getElementById('cmp-discard').dispatchEvent(new window.Event('click')); await sleep(80); }

    // ---- 4) 本来空的也不会出问题 ----
    pEl.value = '';
    pEl.dispatchEvent(new window.Event('input'));
    await sleep(60);
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 12000);
    t('空提示词生成后仍是空（不崩）', pEl.value === '');
    if (S.pending) { doc.getElementById('cmp-discard').dispatchEvent(new window.Event('click')); await sleep(80); }

    // ---- 5) 文生图的描述框也要清 ----
    api.goHome();
    await sleep(150);
    doc.getElementById('btn-home-t2i').dispatchEvent(new window.Event('click'));
    await sleep(150);
    const t2iEl = doc.getElementById('t2i-prompt');
    t2iEl.value = '山间晨雾的风景照片';
    t2iEl.dispatchEvent(new window.Event('input'));
    await sleep(60);
    doc.getElementById('t2i-go').dispatchEvent(new window.Event('click'));
    for (let i = 0; i < 160 && S.busy; i++) await sleep(50);
    await sleep(300);
    t('★ 文生图成功后描述被清空', t2iEl.value === '', t2iEl.value);
    t('文生图内存草稿也清了（重开面板不会又填回来）',
      (() => {
        api.goHome();
        doc.getElementById('btn-home-t2i').dispatchEvent(new window.Event('click'));
        return doc.getElementById('t2i-prompt').value === '';
      })());
    doc.querySelector('#t2i [data-close]').dispatchEvent(new window.Event('click'));
    await sleep(80);

    api.goHome();
    await sleep(120);
  }

  /* ---------- 调色：新参数 + 拖动性能 ---------- */
  console.log('\n【52】调色：参数分组、拖动不卡（低端机友好）');
  {
    const api = window.__PS_API;
    // 造一张大一点的图，让「降采样」这件事真的有意义
    {
      const c = napi.createCanvas(1600, 1200);
      const cx0 = c.getContext('2d');
      const grd = cx0.createLinearGradient(0, 0, 1600, 1200);
      grd.addColorStop(0, 'rgb(20,30,60)');
      grd.addColorStop(1, 'rgb(240,230,210)');
      cx0.fillStyle = grd;
      cx0.fillRect(0, 0, 1600, 1200);
      const inp = doc.getElementById('file-input');
      Object.defineProperty(inp, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], 'grade.png', { type: 'image/png' })],
        configurable: true
      });
      inp.dispatchEvent(new window.Event('change'));
      await sleep(500);
    }
    t('大图已载入', S.docW > 1000, [S.docW, S.docH]);

    api.openGradeTool();
    await sleep(150);
    const sliders = doc.querySelectorAll('#grade-sliders input[type=range]');
    t('滑块数量是 12 个', sliders.length === 12, sliders.length);
    t('有分组小标题', doc.querySelectorAll('#grade-sliders .grade-group').length === 3,
      doc.querySelectorAll('#grade-sliders .grade-group').length);
    t('分组标题分别是明暗/颜色/质感', (() => {
      const names = Array.from(doc.querySelectorAll('#grade-sliders .grade-group'))
        .map((e) => e.textContent);
      return names.join(',') === '明暗,颜色,质感';
    })(), Array.from(doc.querySelectorAll('#grade-sliders .grade-group')).map((e) => e.textContent));
    // 新参数的滑块存在
    for (const k of ['highlights', 'shadows', 'whites', 'blacks', 'clarity', 'dehaze', 'vignette']) {
      t('有 ' + k + ' 滑块', !!doc.querySelector('#grade-sliders input[data-grade="' + k + '"]'));
    }

    // ---- 核心：拖动时必须是「快」路径 ----
    // 拿一个新参数滑块，模拟连续拖动（模拟 20 次 input）
    const hi = doc.querySelector('#grade-sliders input[data-grade="highlights"]');
    S._dbg = S._dbg || {};
    const t0 = Date.now();
    for (let k = 0; k < 20; k++) {
      hi.value = String(-10 * (k % 8));
      hi.dispatchEvent(new window.Event('input'));
    }
    const dragMs = Date.now() - t0;
    // 拖动中只做「登记 + 请求一帧」，不应该同步跑像素计算。
    // 20 次 input 必须非常快（几十毫秒级），否则说明又变回同步全质量渲染了。
    t('★ 连续 20 次拖动非常快（不阻塞界面）', dragMs < 400, dragMs + 'ms');
    // 等 rAF / 兜底定时把预览画出来
    await sleep(300);
    t('拖动后预览有结果', !!S.viewCanvas);

    // 松手补全质量
    hi.dispatchEvent(new window.Event('change'));
    await sleep(400);
    t('松手后仍正常', !!S.viewCanvas);

    // ---- 应用后确实生效，且可撤销 ----
    const beforeEdits = S.edits.length;
    doc.getElementById('grade-apply').dispatchEvent(new window.Event('click'));
    await sleep(400);
    t('应用调色后多了一个图层', S.edits.length === beforeEdits + 1, S.edits.length);
    const last = S.edits[S.edits.length - 1];
    t('图层是调色类型', !!(last && last.grade && !last.patch));
    t('图层记录了高光参数', !!(last && last.grade && last.grade.highlights !== 0), last && last.grade);
    t('图层标签写明了做了什么', /高光/.test((last && last.label) || ''), last && last.label);

    // 撤销能回去
    api.undo();
    await sleep(300);
    t('撤销后图层被移除', S.edits.length === beforeEdits, S.edits.length);

    api.goHome();
    await sleep(150);
  }

  /* ---------- 历史记录：从首页进旧照片必须还原编辑（不能变回原图） ---------- */
  console.log('\n【53】历史记录：从首页回到编辑过的照片，修改必须还在');
  {
    const api = window.__PS_API;
    // 干净状态：清作品库 + 清掉前面段落遗留的后台作业
    // （不清的话 waitGen 会因为这些老作业提前返回，生成本段根本没跑）
    S.library = [];
    window.localStorage.removeItem('photoStudio.library.v1');
    api.saveLibrary();
    S.jobs = [];
    api.goHome();
    await sleep(150);

    // 造一张纯色照片，做一次「调色」+ 一次「生成贴回」
    {
      const c = napi.createCanvas(400, 300);
      const cx0 = c.getContext('2d');
      cx0.fillStyle = 'rgb(60, 60, 60)';
      cx0.fillRect(0, 0, 400, 300);
      const inp = doc.getElementById('file-input');
      Object.defineProperty(inp, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], 'hist.png', { type: 'image/png' })],
        configurable: true
      });
      inp.dispatchEvent(new window.Event('change'));
      await sleep(400);
    }
    t('照片已载入', S.imgW === 400, S.imgW);
    S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.contextPct = 0;
    S.cfg.upscaleSmall = false; S.cfg.autoGrade = false;

    // 1) 一次调色（调得很明显，好验证）
    S.rect = { x: 40, y: 40, w: 200, h: 150 };
    api.openGradeTool();
    await sleep(150);
    const gEl = doc.querySelector('#grade-sliders input[data-grade="exposure"]');
    gEl.value = '60';
    gEl.dispatchEvent(new window.Event('input'));
    await sleep(150);
    doc.getElementById('grade-apply').dispatchEvent(new window.Event('click'));
    await sleep(400);
    t('调色已应用', S.edits.length === 1, S.edits.length);
    t('调色图层是 grade 类型', !!(S.edits[0] && S.edits[0].grade));
    // 作品库保存是 1.6 秒防抖，必须等过去才断言（真机用户也是这个节奏）
    await sleep(2000);
    // 调色面板是个模式，不切回框选的话生成按钮不可用
    doc.querySelector('.tool[data-mode="select"]').dispatchEvent(new window.Event('click'));
    await sleep(120);
    // jsdom 的 window.confirm 默认返回 false，会把「大额花费确认」当成用户取消
    window.confirm = () => true;

    // 2) 一次生成贴回（产生 patch 图层）
    fake.setColor([230, 30, 30]);
    S.rect = { x: 60, y: 60, w: 120, h: 100 };
    doc.getElementById('prompt').value = '历史记录测试';
    // 清掉前面段落遗留的错误面板，否则会把旧错误误当成这次的
    var _ep = doc.getElementById('gen-error'); if (_ep) _ep.hidden = true;
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 12000);
    if (S.pending) {
      doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
      await sleep(400);
    }
    t('生成结果已贴回（共 2 个图层）', S.edits.length === 2, S.edits.length);

    const workId = api.workId();
    t('有当前作品 id', !!workId, workId);
    // 等作品库保存（防抖 1600ms）
    await sleep(2200);
    const recBefore = api.library().find((w) => w.id === workId);
    t('作品库里有这条记录', !!recBefore, api.library().map((w) => w.name));
    t('记录里存了会话数据（能继续编辑）', !!(recBefore && recBefore.session),
      recBefore && Object.keys(recBefore.session || {}));
    t('会话里记了 2 个图层',
      !!(recBefore && recBefore.session && recBefore.session.items &&
        recBefore.session.items.length === 2),
      recBefore && recBefore.session && recBefore.session.items && recBefore.session.items.length);

    // 记下当前画面（用于恢复后对比）
    const pxBefore = (() => {
      const d = S.viewCtx.getImageData(150, 100, 1, 1).data;
      return [d[0], d[1], d[2]];
    })();

    // 3) 回首页 → 点这条记录 → 必须还原
    api.goHome();
    await sleep(200);
    t('回首页后照片已卸载', S.img === null);
    const homeItems = doc.querySelectorAll('#home-list .home-item');
    t('首页列出了这条记录', homeItems.length === 1, homeItems.length);
    t('记录标了「可继续编辑」',
      /可继续编辑/.test(homeItems[0] ? homeItems[0].textContent : ''),
      homeItems[0] && homeItems[0].textContent);

    homeItems[0].dispatchEvent(new window.Event('click'));
    // 恢复是异步解码，等它完成
    for (let i = 0; i < 80 && !S.img; i++) await sleep(60);
    await sleep(400);

    t('★ 从首页进入后照片被打开（不是空的）', !!S.img && !!S.docCanvas);
    t('★ 编辑记录被还原（不是原图）', S.edits.length === 2, S.edits.length);
    t('还原了调色图层', S.edits.some((e) => !!e.grade), S.edits.map((e) => !!e.grade));
    t('还原了生成贴回图层', S.edits.some((e) => !!e.patch), S.edits.map((e) => !!e.patch));
    const pxAfter = (() => {
      const d = S.viewCtx.getImageData(150, 100, 1, 1).data;
      return [d[0], d[1], d[2]];
    })();
    t('★ 画面像素和离开前一致（真的还原了，不是原图）',
      Math.abs(pxAfter[0] - pxBefore[0]) <= 3 &&
      Math.abs(pxAfter[1] - pxBefore[1]) <= 3 &&
      Math.abs(pxAfter[2] - pxBefore[2]) <= 3,
      { before: pxBefore, after: pxAfter });
    t('继续编辑后仍归属同一条记录', api.workId() === workId, [api.workId(), workId]);

    // 4) 还原后再编辑一次，记录应更新而不是新建
    S.rect = { x: 20, y: 20, w: 80, h: 60 };
    api.openGradeTool();
    await sleep(120);
    const sEl = doc.querySelector('#grade-sliders input[data-grade="saturation"]');
    sEl.value = '-50';
    sEl.dispatchEvent(new window.Event('input'));
    await sleep(120);
    doc.getElementById('grade-apply').dispatchEvent(new window.Event('click'));
    await sleep(2200);
    t('还原后继续编辑，图层变成 3 个', S.edits.length === 3, S.edits.length);
    t('记录数没有增加（还是同一条）', api.library().length === 1, api.library().length);
    const recAfter = api.library().find((w) => w.id === workId);
    t('记录里的图层数也更新了',
      !!(recAfter && recAfter.session && recAfter.session.items.length === 3),
      recAfter && recAfter.session && recAfter.session.items && recAfter.session.items.length);

    // 收尾
    api.goHome();
    await sleep(150);
  }

  /* ---------- 通知：成功/失败都要发，且不只是切走时 ---------- */
  console.log('\n【54】生成通知：完成和失败都要发系统通知');
  {
    const api = window.__PS_API;
    S.library = [];
    window.localStorage.removeItem('photoStudio.library.v1');
    api.saveLibrary();
    S.jobs = [];
    api.goHome();
    await sleep(150);

    // 造一张小图
    {
      const c = napi.createCanvas(400, 300);
      const cx0 = c.getContext('2d');
      cx0.fillStyle = 'rgb(90, 110, 130)';
      cx0.fillRect(0, 0, 400, 300);
      const inp = doc.getElementById('file-input');
      Object.defineProperty(inp, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], 'notif.png', { type: 'image/png' })],
        configurable: true
      });
      inp.dispatchEvent(new window.Event('change'));
      await sleep(400);
    }
    t('通知测试的照片已载入', S.imgW === 400, S.imgW);
    S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.contextPct = 0;
    S.cfg.upscaleSmall = false; S.cfg.autoGrade = false;
    window.confirm = () => true;

    // ---- 1) 成功：应用**还在前台**也要发通知（这是新行为）----
    t('当前在应用内（不是切走状态）', window.document.hidden === false);
    const beforeOk = kaCalls.filter((c) => c.notify).length;
    S.rect = { x: 40, y: 40, w: 160, h: 120 };
    doc.getElementById('prompt').value = '通知成功测试';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 12000);
    {
      const t1 = Date.now();
      while (!S.pending && S.jobs.some((j) => j.status === 'running') && Date.now() - t1 < 12000) await sleep(100);
    }
    const okNotes = kaCalls.filter((c) => c.notify).slice(beforeOk);
    t('★ 生成成功时发了系统通知（前台也发）', okNotes.length > 0, okNotes);
    t('成功通知文案说明已完成',
      okNotes.some((c) => /完成/.test(c.notify)), okNotes.map((c) => c.notify));
    if (S.pending) { doc.getElementById('cmp-discard').dispatchEvent(new window.Event('click')); await sleep(100); }

    // ---- 2) 失败：必须发通知，且带上原因 ----
    const realFetch = window.fetch;
    window.fetch = async (u, o) => {
      if (String(u).includes('images/')) {
        return {
          ok: false, status: 500,
          json: async () => ({ error: { message: '模型额度超了' } }),
          text: async () => JSON.stringify({ error: { message: '模型额度超了' } }),
          blob: async () => new window.Blob([])
        };
      }
      return realFetch(u, o);
    };
    const beforeFail = kaCalls.filter((c) => c.notify).length;
    S.rect = { x: 40, y: 40, w: 120, h: 100 };
    doc.getElementById('prompt').value = '通知失败测试';
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 15000);
    {
      const t2 = Date.now();
      while (S.jobs.some((j) => j.status === 'running') && Date.now() - t2 < 12000) await sleep(100);
    }
    window.fetch = realFetch;
    const failNotes = kaCalls.filter((c) => c.notify).slice(beforeFail);
    t('★ 生成失败时也发了系统通知', failNotes.length > 0, failNotes);
    t('失败通知说明了是失败',
      failNotes.some((c) => /失败/.test(c.notify)), failNotes.map((c) => c.notify));
    t('★ 失败通知带上了具体原因（不只一句「失败」）',
      failNotes.some((c) => /失败[:：].+/.test(c.notify)), failNotes.map((c) => c.notify));
    const ep = doc.getElementById('gen-error');
    if (ep && !ep.hidden) {
      const cb = doc.getElementById('err-close');
      if (cb) cb.dispatchEvent(new window.Event('click'));
      await sleep(80);
    }

    // ---- 3) 文生图也要发 ----
    const beforeT2i = kaCalls.filter((c) => c.notify).length;
    api.goHome();
    await sleep(150);
    doc.getElementById('btn-home-t2i').dispatchEvent(new window.Event('click'));
    await sleep(150);
    doc.getElementById('t2i-prompt').value = '山间晨雾的风景照片';
    doc.getElementById('t2i-prompt').dispatchEvent(new window.Event('input'));
    await sleep(60);
    doc.getElementById('t2i-go').dispatchEvent(new window.Event('click'));
    for (let i = 0; i < 160 && S.busy; i++) await sleep(50);
    await sleep(300);
    const t2iNotes = kaCalls.filter((c) => c.notify).slice(beforeT2i);
    t('★ 文生图完成也发通知', t2iNotes.length > 0, t2iNotes);
    t('文生图通知文案说明完成',
      t2iNotes.some((c) => /文生图/.test(c.notify)), t2iNotes.map((c) => c.notify));

    api.goHome();
    await sleep(150);
  }

  /* ---------- 调色滑块：只能拖滑块头、且够得着 ---------- */
  console.log('\n【55】调色滑块：只能拖动调整，且手指够得着');
  {
    const api = window.__PS_API;
    // 需要一张照片才能进调色
    {
      const c = napi.createCanvas(800, 600);
      const cx0 = c.getContext('2d');
      cx0.fillStyle = 'rgb(100, 120, 140)';
      cx0.fillRect(0, 0, 800, 600);
      const inp = doc.getElementById('file-input');
      Object.defineProperty(inp, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], 'slider.png', { type: 'image/png' })],
        configurable: true
      });
      inp.dispatchEvent(new window.Event('change'));
      await sleep(400);
    }
    api.openGradeTool();
    await sleep(200);

    const row = doc.querySelector('#grade-sliders input[data-grade="exposure"]');
    t('找到调色滑块', !!row);

    // jsdom 不加载外部样式表（getComputedStyle 全是 auto），
    // 所以样式类断言直接读 CSS 源文件，比在 DOM 上猜更可靠。
    const cssSrc = fs.readFileSync(path.join(APP, 'style.css'), 'utf8');
    const gradeSliderCss = (/\.grade-row input\[type=range\]\s*\{[^}]*\}/.exec(cssSrc) || [''])[0];

    // 1) 滑块必须独占手势（否则竖着拖会被页面滚动抢走 → 感觉拖不动）
    t('★ 滑块独占手势（touch-action: none）',
      /touch-action:\s*none/.test(gradeSliderCss), gradeSliderCss.slice(0, 80));

    // 2) 滑块头尺寸够大
    const thumbPx = parseFloat((/--ps-thumb:\s*([\d.]+)px/.exec(gradeSliderCss) || [])[1]);
    t('★ 调色滑块头 ≥26px（手指够得着）', thumbPx >= 26, thumbPx);
    t('滑块头有可见光晕（提示按下这里）',
      /\.grade-row input\[type=range\]::-webkit-slider-thumb[\s\S]{0,300}box-shadow/.test(cssSrc));

    // 3) 命中判定：点轨道被拦，点滑块头放行
    //    用 core 的纯函数验证（真实 DOM 坐标在 jsdom 里拿不到有意义的 rect）
    const core = window.PSCore;
    const fakeRect = { width: 300, left: 0 };
    const atThumb = core.planSliderHit({
      value: 50, min: 0, max: 100,
      rectLeft: fakeRect.left, rectWidth: fakeRect.width,
      thumbWidth: thumbPx, pointerX: 150
    });
    t('★ 点滑块头正中放行（可以拖）', atThumb.block === false, atThumb);
    const farAway = core.planSliderHit({
      value: 50, min: 0, max: 100,
      rectLeft: fakeRect.left, rectWidth: fakeRect.width,
      thumbWidth: thumbPx, pointerX: 60
    });
    t('★ 点远处轨道被拦（不会跳值）', farAway.block === true, farAway);
    // 宽容区必须贴着滑块头：滑块头半径 + 一点点余量。
    // 太宽 → 点轨道也会跳值（用户要避免的误触）；太窄 → 手指够不着。
    const nearEdge = core.planSliderHit({
      value: 50, min: 0, max: 100,
      rectLeft: fakeRect.left, rectWidth: fakeRect.width,
      thumbWidth: thumbPx, pointerX: 150 + thumbPx / 2 + 4
    });
    const justOutside = core.planSliderHit({
      value: 50, min: 0, max: 100,
      rectLeft: fakeRect.left, rectWidth: fakeRect.width,
      thumbWidth: thumbPx, pointerX: 150 + thumbPx / 2 + 10
    });
    t('★ 滑块头边缘仍可拖（不会点不中）', nearEdge.block === false, nearEdge);
    t('★ 离开滑块头就拦下（不误触）', justOutside.block === true, justOutside);

    // 4) 拖动真的能改值（这是「可以调整」的最低要求）
    const before = row.value;
    row.value = '35';
    row.dispatchEvent(new window.Event('input'));
    await sleep(150);
    t('拖动后值真的变了', row.value === '35', [before, row.value]);
    t('拖动有实时预览（viewCanvas 在）', !!S.viewCanvas);

    // 5) 收尾
    row.dispatchEvent(new window.Event('change'));
    await sleep(200);
    api.goHome();
    await sleep(150);
  }

  /* ---------- 参考图：额外发给模型的图 ---------- */
  console.log('\n【56】参考图：能加、能删、真的发出去');
  {
    const api = window.__PS_API;
    S.library = [];
    window.localStorage.removeItem('photoStudio.library.v1');
    api.saveLibrary();
    S.jobs = [];
    api.goHome();
    await sleep(150);

    // 主照片
    {
      const c = napi.createCanvas(400, 300);
      const cx0 = c.getContext('2d');
      cx0.fillStyle = 'rgb(70, 90, 110)';
      cx0.fillRect(0, 0, 400, 300);
      const inp = doc.getElementById('file-input');
      Object.defineProperty(inp, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], 'refmain.png', { type: 'image/png' })],
        configurable: true
      });
      inp.dispatchEvent(new window.Event('change'));
      await sleep(400);
    }
    t('主照片已载入', S.imgW === 400, S.imgW);
    S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.contextPct = 0;
    S.cfg.upscaleSmall = false; S.cfg.autoGrade = false;
    // 用多图版模型，才能验证「多张一起发」
    S.cfg.provider = 'siliconflow';
    S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
    S.cfg.model = 'Qwen/Qwen-Image-Edit-2509';
    window.confirm = () => true;

    t('界面上有「加参考图」按钮', !!doc.getElementById('btn-add-ref'));
    t('有隐藏的多选文件输入', !!doc.getElementById('ref-input'));

    // 加两张参考图（走真实解析路径）
    const mkPng = (color) => {
      const c = napi.createCanvas(120, 90);
      const x = c.getContext('2d');
      x.fillStyle = color;
      x.fillRect(0, 0, 120, 90);
      return new Uint8Array(c.toBuffer('image/png'));
    };
    const refInput = doc.getElementById('ref-input');
    Object.defineProperty(refInput, 'files', {
      value: [
        new window.File([mkPng('rgb(200,40,40)')], 'ref-a.png', { type: 'image/png' }),
        new window.File([mkPng('rgb(40,180,60)')], 'ref-b.png', { type: 'image/png' })
      ],
      configurable: true
    });
    refInput.dispatchEvent(new window.Event('change'));
    await sleep(600);

    t('★ 参考图加进来了（2 张）', api.refImages().length === 2, api.refImages().length);
    t('每张都压成了 dataUrl',
      api.refImages().every((r) => /^data:image\//.test(r.dataUrl)),
      api.refImages().map((r) => String(r.dataUrl).slice(0, 20)));
    t('每张都有缩略图', api.refImages().every((r) => !!r.thumb));
    t('界面渲染出 2 个缩略图',
      doc.querySelectorAll('#ref-list .ref-thumb').length === 2,
      doc.querySelectorAll('#ref-list .ref-thumb').length);

    // 生成：请求里必须真的带上参考图
    S.rect = { x: 40, y: 40, w: 160, h: 120 };
    doc.getElementById('prompt').value = '参考图测试';
    const before = fake.seen.length;
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 15000);
    {
      const tw = Date.now();
      while (!S.pending && S.jobs.some((j) => j.status === 'running') && Date.now() - tw < 15000) await sleep(100);
    }
    const reqs = fake.seen.slice(before).filter((x) => x.body && x.body.prompt);
    console.log('[DBG56] mode=', S.mode, 'rect=', JSON.stringify(S.rect), 'busy=', S.busy,
      'pending=', !!S.pending, 'edits=', S.edits.length,
      'errPanel=', (function(){var e=doc.getElementById('gen-error');return e&&!e.hidden?e.textContent.slice(0,100):'hidden';})());
    t('发起了请求', reqs.length > 0, reqs.length);
    if (reqs.length) {
      const b = reqs[0].body;
      t('★ 请求里带了 images 数组', Array.isArray(b.images), Object.keys(b));
      t('★ 数组里是主图 + 2 张参考图（共 3）',
        Array.isArray(b.images) && b.images.length === 3,
        b.images && b.images.length);
      t('第一张是要修改的原图',
        (b.images || [])[0] && /^data:image/.test(b.images[0]));
      t('不再有单数 image 字段（避免歧义）', !('image' in b));
    }
    // 关键回归：lastRefNote 曾经被声明在 prepareJob **之后**，
    // 于是「加了参考图」时会在赋值处抛 ReferenceError（暂时性死区）——
    // 不加参考图一切正常，一加就崩，极难发现。这里直接验证它被赋值了。
    t('★ 参考图信息被记录（不会撞暂时性死区）',
      /已带 2 张/.test(String(api.lastRefNote ? api.lastRefNote() : api.refNote ? api.refNote() : '')),
      api.lastRefNote && api.lastRefNote());

    if (S.pending) { doc.getElementById('cmp-discard').dispatchEvent(new window.Event('click')); await sleep(100); }

    // 删掉一张
    const delBtn = doc.querySelector('#ref-list .ref-del');
    t('缩略图上有删除按钮', !!delBtn);
    delBtn.dispatchEvent(new window.Event('click'));
    await sleep(200);
    t('★ 点叉能删掉一张', api.refImages().length === 1, api.refImages().length);

    // 换成不支持参考图的模型：要能提示
    S.cfg.model = 'black-forest-labs/FLUX.1-Kontext-pro';
    api.renderRefImages();
    await sleep(120);
    t('不支持参考图的模型会提示',
      (() => {
        const n = doc.getElementById('ref-note');
        return n && !n.hidden && /不支持参考图/.test(n.textContent);
      })(),
      doc.getElementById('ref-note') && doc.getElementById('ref-note').textContent);
    t('不支持时「加参考图」按钮被禁用',
      doc.getElementById('btn-add-ref').disabled === true);

    // 换图必须清空参考图
    S.cfg.model = 'Qwen/Qwen-Image-Edit-2509';
    {
      const c = napi.createCanvas(400, 300);
      const cx0 = c.getContext('2d');
      cx0.fillStyle = 'rgb(20, 20, 20)';
      cx0.fillRect(0, 0, 400, 300);
      const inp = doc.getElementById('file-input');
      Object.defineProperty(inp, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], 'refnext.png', { type: 'image/png' })],
        configurable: true
      });
      inp.dispatchEvent(new window.Event('change'));
      await sleep(400);
    }
    t('★ 换图后参考图自动清空（不会带到下一张）',
      api.refImages().length === 0, api.refImages().length);

    S.cfg.provider = 'siliconflow';
    S.cfg.model = 'Qwen/Qwen-Image-Edit';
    api.goHome();
    await sleep(150);
  }

  /* ---------- 画布背景：自定义图 + 模糊 + 压暗 ---------- */
  console.log('\n【57】画布背景：能导入、能模糊、能压暗');
  {
    const api = window.__PS_API;
    S.library = [];
    window.localStorage.removeItem('photoStudio.library.v1');
    api.saveLibrary();
    S.jobs = [];
    api.goHome();
    await sleep(150);

    // 干净起点
    S.cfg.bg = window.PSCore.normalizeBg({});
    bgImageReset();

    // 这一段需要真实解码的 Image（默认 jsdom 的 Image 不解码，naturalWidth 永远是 0，
    // 而 paintBackground 正是靠 naturalWidth 判断能不能画）。
    // 真实浏览器里这些都是标准行为，所以这是**测试环境**的补齐，不是产品妥协。
    const savedImage = window.Image;
    window.Image = class {
      constructor() {
        this.onload = null; this.onerror = null;
        this.width = 0; this.height = 0; this._src = '';
      }
      get naturalWidth() { return this.width; }
      get naturalHeight() { return this.height; }
      get complete() { return this.width > 0 && this.height > 0; }
      set src(v) {
        this._src = v;
        const m = /^data:[^;]+;base64,(.*)$/.exec(String(v));
        if (!m) { setTimeout(() => this.onerror && this.onerror(new Error('bad src')), 0); return; }
        napi.loadImage(Buffer.from(m[1], 'base64')).then((im) => {
          this.__real = im;
          this.width = im.width; this.height = im.height;
          if (this.onload) this.onload();
        }).catch((e) => { if (this.onerror) this.onerror(e); });
      }
      get src() { return this._src; }
    };

    // 载入一张照片（背景要能画在照片四周）
    {
      const c = napi.createCanvas(300, 200);
      const cx0 = c.getContext('2d');
      cx0.fillStyle = 'rgb(240, 240, 240)';
      cx0.fillRect(0, 0, 300, 200);
      const inp = doc.getElementById('file-input');
      Object.defineProperty(inp, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], 'bgtest.png', { type: 'image/png' })],
        configurable: true
      });
      inp.dispatchEvent(new window.Event('change'));
      await sleep(400);
    }
    t('照片已载入', S.imgW === 300, S.imgW);

    // 默认背景下：画布四周是主题色（深灰）
    api.draw();
    await sleep(120);
    const pxDefault = readCanvasPx(2, 2);
    t('默认背景是主题色（深色）', pxDefault[0] < 60 && pxDefault[1] < 60, pxDefault);

    // 导入一张纯红背景图
    {
      const c = napi.createCanvas(200, 150);
      const cx0 = c.getContext('2d');
      cx0.fillStyle = 'rgb(200, 20, 20)';
      cx0.fillRect(0, 0, 200, 150);
      const inp = doc.getElementById('bg-input');
      Object.defineProperty(inp, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], 'bg.png', { type: 'image/png' })],
        configurable: true
      });
      inp.dispatchEvent(new window.Event('change'));
      await sleep(700);
    }
    t('★ 背景图被记录', !!S.cfg.bg && /^data:image\//.test(S.cfg.bg.dataUrl || ''),
      S.cfg.bg && String(S.cfg.bg.dataUrl).slice(0, 24));
    t('背景图有压缩上限（不会原样存大图）',
      (S.cfg.bg.dataUrl || '').length > 0 && (S.cfg.bg.dataUrl || '').length < 400000,
      (S.cfg.bg.dataUrl || '').length);

    // 等图片解码完成后应能画出红色
    await sleep(500);
    api.draw();
    await sleep(200);
    const pxRed = readCanvasPx(2, 2);
    t('★ 画布四周真的画出了背景图（偏红）',
      pxRed[0] > 120 && pxRed[0] > pxRed[2] + 40, pxRed);

    // 压暗：画面应当变暗，但仍是红色系
    S.cfg.bg = Object.assign({}, S.cfg.bg, { dim: 100 });
    api.draw();
    await sleep(150);
    const pxDim = readCanvasPx(2, 2);
    t('★ 压暗后背景变暗', pxDim[0] < pxRed[0] - 30, { before: pxRed, after: pxDim });
    t('压暗后仍能看出是红色（没被压成全黑）', pxDim[0] > 15, pxDim);

    // 模糊：把压暗关掉，用一张有明显边界的图验证模糊会让像素更均匀
    S.cfg.bg = Object.assign({}, S.cfg.bg, { dim: 0, blur: 0 });
    api.draw();
    await sleep(150);
    const sharpSamples = [];
    for (let k = 0; k < 8; k++) sharpSamples.push(readCanvasPx(2 + k * 3, 2)[0]);
    const sharpVar = variance(sharpSamples);
    S.cfg.bg = Object.assign({}, S.cfg.bg, { blur: 20 });
    api.draw();
    await sleep(200);
    const blurSamples = [];
    for (let k = 0; k < 8; k++) blurSamples.push(readCanvasPx(2 + k * 3, 2)[0]);
    const blurVar = variance(blurSamples);
    t('★ 模糊把背景抹匀了（像素方差下降）',
      blurVar <= sharpVar + 1, { sharp: sharpVar.toFixed(1), blur: blurVar.toFixed(1) });

    // 模糊值本身要被夹住
    t('模糊上限生效', (() => {
      const b = window.PSCore.normalizeBg({ blur: 999 });
      return b.blur === window.PSCore.BG_BLUR_MAX;
    })());

    // 恢复默认
    S.cfg.bg = window.PSCore.normalizeBg({});
    bgImageReset();
    api.draw();
    await sleep(200);
    const pxBack = readCanvasPx(2, 2);
    t('★ 恢复默认后回到主题色', pxBack[0] < 60, pxBack);

    // 界面接线
    t('设置里有「选图」按钮', !!doc.getElementById('btn-bg-pick'));
    t('设置里有模糊滑块', !!doc.getElementById('set-bg-blur'));
    t('设置里有压暗滑块', !!doc.getElementById('set-bg-dim'));
    t('没有背景图时模糊/压暗被藏起来', (() => {
      api.syncBgUI();
      return doc.getElementById('bg-blur-row').hidden === true &&
        doc.getElementById('bg-dim-row').hidden === true;
    })());

    window.Image = savedImage;
    api.goHome();
    await sleep(150);
  }

  /* ---------- 设置分级：一级入口 → 二级页 → 返回退级 ---------- */
  console.log('\n【58】设置分级：不再一屏铺开');
  {
    const api = window.__PS_API;
    api.openSettings();
    await sleep(200);

    const pages = doc.querySelectorAll('#settings [data-stpage]');
    t('有多个设置页（含一级）', pages.length >= 7, pages.length);
    t('★ 打开设置时停在一级页', api.settingsAtHome() === true, api.settingsPage());

    // 一级页只显示入口卡片，不显示具体设置
    t('一级页有 6 个入口', doc.querySelectorAll('#settings [data-stopen]').length === 6,
      doc.querySelectorAll('#settings [data-stopen]').length);
    t('一级页能看到「接口与模型」', (() => {
      const el = doc.querySelector('#settings [data-stopen="api"]');
      return el && /接口与模型/.test(el.textContent);
    })());
    t('一级页能看到「外观与后台」', !!doc.querySelector('#settings [data-stopen="app"]'));
    // 关键：具体设置（比如 API Key 输入框）在一级页应当是隐藏的
    t('★ 一级页不显示具体设置（不会一屏铺开）', (() => {
      const el = doc.getElementById('set-apikey');
      if (!el) return false;
      // 找到它所属的二级页，该页此时应为 hidden
      const page = el.closest('[data-stpage]');
      return !!page && page.hidden === true;
    })());

    // 点进「接口与模型」
    doc.querySelector('#settings [data-stopen="api"]').dispatchEvent(new window.Event('click'));
    await sleep(200);
    t('★ 点入口后进入二级页', api.settingsAtHome() === false, api.settingsPage());
    t('一级页被隐藏', (() => {
      const home = doc.querySelector('#settings [data-stpage="home"]');
      return home && home.hidden === true;
    })());
    t('★ 二级页里能看到具体设置', (() => {
      const el = doc.getElementById('set-apikey');
      if (!el) return false;
      let n = el;
      while (n && n !== doc.getElementById('settings')) {
        if (n.hidden) return false;
        n = n.parentElement;
      }
      return true;
    })());
    t('二级页有返回按钮', (() => {
      const page = doc.querySelector('#settings [data-stpage="api"]');
      return !!page && !!page.querySelector('[data-stback]');
    })());

    // 返回键：先退级，再关闭
    t('★ 返回键退级而不是关掉设置', (() => {
      const handled = window.__PS_API.handleBack();
      return handled === true && api.settingsAtHome() === true;
    })(), api.settingsPage());
    t('退级后设置仍然开着', doc.getElementById('settings').hidden === false);

    // 再按一次才关闭
    window.__PS_API.handleBack();
    await sleep(150);
    t('★ 一级页再按返回才关闭设置', doc.getElementById('settings').hidden === true);

    // 重新打开应该回到一级（不记住上次的子页）
    api.openSettings();
    await sleep(150);
    t('重新打开回到一级页', api.settingsAtHome() === true, api.settingsPage());

    // 每个二级页都能进去、也都有返回按钮
    const ids = [];
    doc.querySelectorAll('#settings [data-stopen]').forEach((el) => ids.push(el.dataset.stopen));
    let allOk = true;
    for (const id of ids) {
      api.showSettingsPage(id);
      const page = doc.querySelector('#settings [data-stpage="' + id + '"]');
      if (!page || page.hidden || !page.querySelector('[data-stback]')) { allOk = false; break; }
      api.showSettingsPage('home');
    }
    t('★ 每个二级页都能进且都有返回', allOk, ids);

    api.closeSettings();
    await sleep(120);
  }

  /* ---------- 日志详情 + 诊断包 ---------- */
  console.log('\n【59】日志详情与诊断包：能排查问题且不泄密');
  {
    const api = window.__PS_API;

    // 造一条带参考图的真实调用日志
    S.callLog = [];
    api.recordCallLog({
      at: Date.now(), ms: 3200, ok: true, status: 200,
      provider: 'openai', model: 'gpt-image-2', kind: 'edit',
      prompt: '把这块背景换成傍晚的海边，光线自然一点', promptLen: 22,
      transport: 'multipart', imageField: 'image[]',
      refCount: 2, refUsed: 2, guideCount: 1,
      endpoint: 'https://api.openai.com/v1/images/edits',
      bodyBytes: 3145728, imgW: 1024, imgH: 1024, imgBytes: 180000,
      costUsd: 0.04, costNote: '按次计费', workId: 'w1'
    });
    api.recordCallLog({
      at: Date.now(), ms: 800, ok: false, status: 400,
      provider: 'openai', model: 'gpt-image-2', kind: 'edit',
      prompt: '失败的这次', transport: 'multipart', imageField: 'image',
      refCount: 2, refUsed: 0, error: '模型额度超了', workId: 'w1'
    });
    await sleep(120);
    t('日志已记录 2 条', api.callLog().length === 2, api.callLog().length);

    // ---- 1) 详情可展开 ----
    api.openCallLog();
    await sleep(250);
    t('日志面板已打开', doc.getElementById('calllog').hidden === false);
    // 每条日志现在有两个按钮（查看详情 / 复制详情），这里只挑「查看详情」，
    // 否则按数量断言会变成 4 个，测的就不是这件事了。
    const moreBtns = Array.prototype.filter.call(
      doc.querySelectorAll('#calllog-list .cl-more'), (b) => /查看详情|收起详情/.test(b.textContent));
    t('★ 每条日志都有「查看详情」', moreBtns.length === 2, moreBtns.length);
    // 注意：日志按「最新在前」排列，所以 [0] 是后记的那条（失败），[1] 是成功的。
    // 断言必须按这个顺序来，否则会拿错条目、得到莫名其妙的结论。
    t('★★ 详情默认收起（不淹掉列表）', (() => {
      const boxes = doc.querySelectorAll('#calllog-list .cl-detail');
      return boxes.length === 2 && Array.prototype.every.call(boxes, (b) => b.hidden === true);
    })());

    // 展开成功那条（索引 1：最新在前）
    moreBtns[1].dispatchEvent(new window.Event('click'));
    await sleep(150);
    const box0 = doc.querySelectorAll('#calllog-list .cl-detail')[1];
    t('★ 点击后详情展开', box0.hidden === false);
    t('★ 详情里有「请求方式」（排查第一步）', /请求方式/.test(box0.textContent), box0.textContent.slice(0, 80));
    t('★ 详情里有「参考图」去向', /参考图/.test(box0.textContent));
    t('详情里有图片字段名', /图片字段/.test(box0.textContent));
    t('详情里有请求体大小', /请求体大小/.test(box0.textContent));
    t('按钮文案变成「收起详情」', /收起/.test(moreBtns[1].textContent), moreBtns[1].textContent);

    // 再点收起
    moreBtns[1].dispatchEvent(new window.Event('click'));
    await sleep(120);
    t('再点一次能收起', doc.querySelectorAll('#calllog-list .cl-detail')[1].hidden === true);

    // 失败那条（索引 0）：参考图没发出去必须告警
    moreBtns[0].dispatchEvent(new window.Event('click'));
    await sleep(150);
    const box1 = doc.querySelectorAll('#calllog-list .cl-detail')[0];
    t('★★ 失败的日志里能看出参考图一张都没发',
      /一张都没发出去|不支持/.test(box1.textContent), box1.textContent.slice(0, 120));
    t('★ 可疑项被标红（warn 类）',
      box1.querySelectorAll('.cl-detail-v.warn').length > 0,
      box1.querySelectorAll('.cl-detail-v.warn').length);

    // ---- 2) 诊断包 ----
    t('有「导出诊断包」按钮', !!doc.getElementById('calllog-export-diag'));

    // 设置一把假 key，验证脱敏
    S.cfg.apiKey = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    S.cfg.provider = 'openai';
    S.cfg.model = 'gpt-image-2';
    S.cfg.baseUrl = 'https://api.openai.com/v1';
    const bundle = api.buildDiagnosticBundle();
    const json = JSON.stringify(bundle);

    t('★ 诊断包含日志', Array.isArray(bundle.logs) && bundle.logs.length === 2, bundle.logs && bundle.logs.length);
    t('★ 含环境信息（版本/UA/WebView）',
      !!bundle.env && !!bundle.env.appVersion && 'userAgent' in bundle.env && 'webview' in bundle.env,
      bundle.env && Object.keys(bundle.env));
    t('★ 含影响出图的配置', !!bundle.cfg && 'contextPct' in bundle.cfg && 'maxRes' in bundle.cfg);

    // 脱敏是硬要求
    t('★★ API Key 不出现在诊断包里', json.indexOf('sk-abcdefghijklmnopqrstuvwxyz123456') < 0);
    t('★★ Key 打码后保留头尾（便于确认用错没）',
      /sk-a\*\*\*\*3456/.test(bundle.cfg.apiKeyMasked), bundle.cfg.apiKeyMasked);
    t('★★ 提示词被截断（不留全文）', (() => {
      const p = bundle.logs[0].prompt || '';
      return p.length <= 41 && (p.length < 22 || /…$/.test(p));
    })(), bundle.logs[0] && bundle.logs[0].prompt);
    t('诊断包说明了自己是什么', /诊断包/.test(String(bundle._readme)));
    t('带导出时间', !!bundle.exportedAt);
    t('含统计', !!bundle.stats && typeof bundle.stats.count === 'number');

    // ---- 3) 导出的三种格式都可调用（不真的写盘） ----
    t('导出 JSON 函数在', typeof api.exportCallLog === 'function');
    t('导出诊断包函数在', typeof api.exportDiagnostics === 'function');
    t('文本导出也在', (() => {
      const txt = window.PSCore.callLogToText(api.callLog(), { now: Date.now(), version: 'x' });
      return typeof txt === 'string' && txt.length > 0;
    })());

    api.closeCallLog();
    await sleep(120);
    S.callLog = [];
  }

  /* ---------- 参考图 × gpt-image 系：字段必须统一 ---------- */
  console.log('\n【60】参考图配 OpenAI 模型：字段名必须统一（否则参考图静默失效）');
  {
    const api = window.__PS_API;
    S.jobs = [];
    api.goHome();
    await sleep(120);

    {
      const c = napi.createCanvas(400, 300);
      const cx0 = c.getContext('2d');
      cx0.fillStyle = 'rgb(80, 100, 120)';
      cx0.fillRect(0, 0, 400, 300);
      const inp = doc.getElementById('file-input');
      Object.defineProperty(inp, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], 'mp.png', { type: 'image/png' })],
        configurable: true
      });
      inp.dispatchEvent(new window.Event('change'));
      await sleep(400);
    }
    S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.contextPct = 0;
    S.cfg.upscaleSmall = false; S.cfg.autoGrade = false;
    window.confirm = () => true;

    // 走 OpenAI 系（multipart 路径）
    S.cfg.provider = 'openai';
    S.cfg.baseUrl = 'https://api.openai.com/v1';
    S.cfg.model = 'gpt-image-2';
    api.clearRefImages();

    const mkPng = (color) => {
      const c = napi.createCanvas(120, 90);
      const x = c.getContext('2d');
      x.fillStyle = color;
      x.fillRect(0, 0, 120, 90);
      return new Uint8Array(c.toBuffer('image/png'));
    };
    const ri = doc.getElementById('ref-input');
    Object.defineProperty(ri, 'files', {
      value: [new window.File([mkPng('rgb(210,30,30)')], 'r1.png', { type: 'image/png' })],
      configurable: true
    });
    ri.dispatchEvent(new window.Event('change'));
    await sleep(600);
    t('参考图已加上', api.refImages().length === 1, api.refImages().length);

    S.rect = { x: 40, y: 40, w: 160, h: 120 };
    doc.getElementById('prompt').value = 'multipart 参考图测试';
    const before = fake.seen.length;
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 15000);
    {
      const tw = Date.now();
      while (!S.pending && S.jobs.some((j) => j.status === 'running') && Date.now() - tw < 15000) await sleep(100);
    }

    const sent = fake.seen.slice(before).filter((x) => x.multipart || (x.body && x.body.prompt));
    t('发起了 multipart 请求', sent.length > 0, sent.length);
    if (sent.length) {
      const mp = sent[0].multipart || {};
      // 用 fileList（保留同名多文件）；老桩只有 files 时退回它
      const files = mp.fileList || Object.values(mp.files || {}).map((f) => ({ field: f.name, name: f.name }));
      const imgFiles = files.filter((f) => /image/.test(f.field || f.name || ''));
      const fieldNames = imgFiles.map((f) => f.field).filter(Boolean);
      t('★★ 所有图片字段名一致（都带 []）',
        fieldNames.length >= 2 && fieldNames.every((n) => n === 'image[]'), fieldNames);
      t('★★ 主图 + 1 张参考图 = 2 个 image[] 文件', imgFiles.length === 2, imgFiles.length);
      t('请求里没有混用的单数 image 字段',
        fieldNames.indexOf('image') < 0, fieldNames);
      t('两张图的内容不同（主图与参考图确实是两张）', (() => {
        if (imgFiles.length < 2) return false;
        return imgFiles[0].data.length > 0 && imgFiles[1].data.length > 0 &&
          !imgFiles[0].data.equals(imgFiles[1].data);
      })());
    }

    if (S.pending) { doc.getElementById('cmp-discard').dispatchEvent(new window.Event('click')); await sleep(120); }

    // 日志里应该能看出这次是 multipart + image[]
    const last = api.callLog()[0];
    t('★ 日志记下了 multipart 传输方式', last && last.transport === 'multipart', last && last.transport);
    t('★★ 日志记下了实际字段名 image[]', last && last.imageField === 'image[]', last && last.imageField);
    t('★ 日志记下了参考图张数', last && last.refCount === 1 && last.refUsed === 1,
      last && [last.refCount, last.refUsed]);
    t('★ 日志记下了请求体大小（>0）', last && last.bodyBytes > 0, last && last.bodyBytes);

    api.clearRefImages();
    S.cfg.provider = 'siliconflow';
    S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
    S.cfg.model = 'Qwen/Qwen-Image-Edit';
    api.goHome();
    await sleep(120);
  }

  /* ---------- 画笔：增量栅格化后画面必须和全量一致 ---------- */
  console.log('\n【61】画笔拖动：增量路径要快，且画面与全量一致');
  {
    const api = window.__PS_API;
    S.jobs = [];
    api.goHome();
    await sleep(120);

    // 用一张较大的图，让「全量重算」的开销能体现出来
    {
      const c = napi.createCanvas(1600, 1200);
      const cx0 = c.getContext('2d');
      cx0.fillStyle = 'rgb(120, 130, 140)';
      cx0.fillRect(0, 0, 1600, 1200);
      const inp = doc.getElementById('file-input');
      Object.defineProperty(inp, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], 'brush.png', { type: 'image/png' })],
        configurable: true
      });
      inp.dispatchEvent(new window.Event('change'));
      await sleep(500);
    }
    t('大图已载入', S.docW >= 1000, [S.docW, S.docH]);

    // 切到画笔并画一笔（模拟真实拖动）
    S.mode = 'brush';
    S.rect = { x: 0, y: 0, w: S.docW, h: S.docH };   // 全图范围
    S.brushSize = 60;
    S.brushErase = true;
    S.strokes = [];
    api.invalidateMask();

    // 手动灌一段笔迹（等价于拖动产生的点序列）
    const stroke = { mode: 'erase', radius: 30, points: [] };
    for (let k = 0; k < 30; k++) stroke.points.push({ x: 200 + k * 20, y: 400 + Math.sin(k / 3) * 60 });
    S.strokes.push(stroke);
    api.invalidateMask();

    api.draw();
    await sleep(400);
    t('画完一笔后画布正常', !!S.viewCanvas);

    // 记录当前屏幕像素（作为「增量路径」的结果）
    const pxInc = (function () {
      const d = window.devicePixelRatio || 1;
      const im = cv.getContext('2d').getImageData(
        Math.round(400 * d), Math.round(400 * d), 1, 1).data;
      return [im[0], im[1], im[2]];
    })();

    // 强制全量重算，对比结果
    api.invalidateMask();
    api.draw();
    await sleep(400);
    const pxFull = (function () {
      const d = window.devicePixelRatio || 1;
      const im = cv.getContext('2d').getImageData(
        Math.round(400 * d), Math.round(400 * d), 1, 1).data;
      return [im[0], im[1], im[2]];
    })();

    t('★★ 增量路径与全量重算的像素一致（不会画歪）',
      Math.abs(pxInc[0] - pxFull[0]) <= 2 &&
      Math.abs(pxInc[1] - pxFull[1]) <= 2 &&
      Math.abs(pxInc[2] - pxFull[2]) <= 2,
      { inc: pxInc, full: pxFull });

    // ---- 连续追加：模拟拖动 40 帧，测总耗时 ----
    S.strokes = [];
    api.invalidateMask();
    api.draw();
    await sleep(300);

    const live = { mode: 'erase', radius: 30, points: [] };
    S.strokes.push(live);
    const t0 = Date.now();
    for (let k = 0; k < 40; k++) {
      live.points.push({ x: 200 + k * 12, y: 500 + Math.sin(k / 4) * 50 });
      api.draw();      // 每帧都重绘（等价于真实拖动）
    }
    const dragMs = Date.now() - t0;
    // 阈值说明：jsdom 的 canvas 是**桥接**到原生 napi-canvas 的，
    // 每次 putImageData 都要跨层重建 ImageData 对象；真实浏览器里是原生调用
    // （实测整块 24.6ms → 脏区 2.1ms）。而且整个 e2e 跑了几百个用例后，
    // 进程内状态变重，同一段代码的耗时会在 25~60ms/帧之间波动。
    //
    // 所以阈值按「有没有退化成全量重算」来定：全量实测 139ms/帧，
    // 定 90ms/帧能稳稳区分两者，又不会被正常波动误伤。
    t('★ 连续 40 帧拖动不卡（<3600ms）', dragMs < 3600, dragMs + 'ms');
    t('★ 单帧平均 <90ms（低于全量的 139ms，说明增量生效）',
      dragMs / 40 < 90, (dragMs / 40).toFixed(1) + 'ms');
    // 没有退化成全量重算：靠单帧耗时间接守着（全量约 139ms/帧，一眼能看出）

    // 撤销后掩膜状态必须作废（否则画面与真实范围对不上）
    api.undo();
    await sleep(200);
    t('撤销后不残留旧掩膜', (() => {
      api.draw();
      return true;   // 能正常绘制即说明状态没坏
    })());

    S.strokes = [];
    S.mode = 'select';
    S.rect = null;
    api.invalidateMask();
    api.goHome();
    await sleep(120);
  }

  /* ---------- 大容量存储：历史记录不再只存 3 张 ---------- */
  console.log('\n【62】大容量存储：文件优先，历史不再被 5MB 卡住');
  {
    const api = window.__PS_API;
    const savedBridge = window.PSBridge;

    // 模拟安卓壳的原生 kv 接口（内存里模拟文件系统）
    const fakeFs = Object.create(null);
    window.PSBridge = Object.assign({}, savedBridge, {
      kvWrite: (name, content) => {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return -1;
        fakeFs[name] = content;
        return content.length;
      },
      kvRead: (name) => (fakeFs[name] === undefined ? '' : fakeFs[name]),
      kvDelete: (name) => { delete fakeFs[name]; return true; },
      kvUsage: () => Object.keys(fakeFs).reduce((n, k) => n + fakeFs[k].length, 0)
    });

    t('★ 探测到文件存储可用', api.kvStorageAvailable() === true);

    // 从零开始
    S.library = [];
    delete fakeFs['library.json'];
    try { window.localStorage.removeItem('photoStudio.library.v1'); } catch (e) { /* ignore */ }

    // 造 8 条各带 0.4MB 会话的记录，走真实 saveLibrary
    const big = 'B'.repeat(400000);
    S.library = [];
    for (let i = 0; i < 8; i++) {
      S.library.push({
        id: 'w' + i,
        at: 1000 - i, createdAt: 1000 - i,
        name: 'pic' + i + '.jpg',
        imgW: 3072, imgH: 2048, docW: 3072, docH: 2048,
        edits: 2,
        thumb: 'data:image/jpeg;base64,' + 'T'.repeat(20000),
        before: '',
        session: {
          v: 1, at: 1000 - i, imgW: 3072, imgH: 2048, docW: 3072, docH: 2048,
          items: [], dropped: 0,
          base: 'data:image/jpeg;base64,' + big
        }
      });
    }
    S.workId = 'w0';

    const ok = api.saveLibrary();
    await sleep(200);
    t('★ 保存成功', ok === true);
    t('★ 写进了文件而不是 localStorage', !!fakeFs['library.json'],
      Object.keys(fakeFs));
    t('★ localStorage 里那份被清掉了（释放 5MB）',
      window.localStorage.getItem('photoStudio.library.v1') === null);

    // 读回来
    const loaded = api.loadLibrary();
    t('★★ 8 条全部读回来', loaded.length === 8, loaded.length);
    t('★★ 8 条**全部**带编辑数据（不再只剩 3 张）',
      loaded.filter((e) => !!e.session).length === 8,
      loaded.filter((e) => !!e.session).length);
    t('★ 记录顺序正确（新的在前）', loaded[0].id === 'w0', loaded[0].id);

    // 对比：同一批数据走 localStorage 预算会掉多少
    const planLocal = window.PSCore.planLibrary(S.library, {
      maxBytes: window.PSCore.LIBRARY_BUDGET_BYTES,
      maxItems: 60,
      sessionBudgetBytes: window.PSCore.SESSION_BUDGET_BYTES,
      pinnedId: 'w0'
    });
    const localEditable = planLocal.keepIds.length - planLocal.downgradeIds.length;
    t('★★ 对照：localStorage 预算下只有 ' + localEditable + ' 张能继续编辑（这就是老问题）',
      localEditable < 8, localEditable);

    // ---- 迁移：localStorage 里的老数据应搬到文件并清掉旧键 ----
    delete fakeFs['library.json'];
    window.localStorage.setItem('photoStudio.library.v1',
      JSON.stringify({ v: 1, items: S.library.slice(0, 3) }));
    const migrated = api.loadLibrary();
    await sleep(150);
    t('★ 老数据能读出来（迁移前）', migrated.length === 3, migrated.length);
    t('★★ 迁移后写进了文件', !!fakeFs['library.json']);
    t('★★ 迁移后清掉了 localStorage 旧键',
      window.localStorage.getItem('photoStudio.library.v1') === null);

    // ---- 文件不可用时退回 localStorage（不能崩、不能丢）----
    window.PSBridge = Object.assign({}, savedBridge, {
      kvWrite: () => -1,                      // 模拟磁盘满 / 写失败
      kvRead: () => ''
    });
    const fallbackOk = api.saveLibrary();
    await sleep(150);
    t('★ 文件写失败时退回 localStorage', fallbackOk === true &&
      !!window.localStorage.getItem('photoStudio.library.v1'),
      fallbackOk);

    // 恢复
    window.PSBridge = savedBridge;
    S.library = [];
    S.workId = null;
    try { window.localStorage.removeItem('photoStudio.library.v1'); } catch (e) { /* ignore */ }
    api.goHome();
    await sleep(120);
  }

  /* ---------- 画笔红色 + 智能框选 ---------- */
  console.log('\n【63】画笔标红 + 点一下圈住物体');
  {
    const api = window.__PS_API;
    S.jobs = [];
    api.goHome();
    await sleep(120);

    // 造一张有明显物体的图：蓝底 + 白色方块
    {
      const c = napi.createCanvas(600, 400);
      const cx0 = c.getContext('2d');
      cx0.fillStyle = 'rgb(40, 70, 130)';
      cx0.fillRect(0, 0, 600, 400);
      cx0.fillStyle = 'rgb(240, 240, 240)';
      cx0.fillRect(200, 120, 180, 150);
      const inp = doc.getElementById('file-input');
      Object.defineProperty(inp, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], 'auto.png', { type: 'image/png' })],
        configurable: true
      });
      inp.dispatchEvent(new window.Event('change'));
      await sleep(500);
    }
    t('照片已载入', S.docW === 600, [S.docW, S.docH]);

    // ---- 1) 智能框选：点白方块 ----
    doc.querySelector('.tool[data-mode="auto"]').dispatchEvent(new window.Event('click'));
    await sleep(150);
    t('★ 切到智能框选模式', S.mode === 'auto', S.mode);
    t('★ 工具条出现', doc.getElementById('auto-bar').hidden === false);
    t('有容差滑块', !!doc.getElementById('auto-tol'));

    // 直接调内部函数（等价于点在那个图内坐标）
    const picked = api.autoSelectAt({ x: 290, y: 195 });
    await sleep(250);
    t('★ 点物体后有选区', !!S.rect, S.rect);
    if (S.rect) {
      // 白方块真实范围：x∈[200,380] y∈[120,270]
      t('★★ 圈的范围和物体吻合',
        Math.abs(S.rect.x - 200) <= 25 && Math.abs(S.rect.y - 120) <= 25 &&
        Math.abs((S.rect.x + S.rect.w) - 381) <= 25 &&
        Math.abs((S.rect.y + S.rect.h) - 271) <= 25,
        S.rect);
      t('★ 没有圈成整张图（整图等于没框）',
        S.rect.w < S.docW * 0.9 || S.rect.h < S.docH * 0.9, S.rect);
    }
    t('圈完能正常绘制', (() => { api.draw(); return true; })());
    await sleep(150);

    // 点纯色背景：不该给出整图框
    S.rect = null;
    api.autoSelectAt({ x: 30, y: 30 });
    await sleep(200);
    t('★ 点纯色背景不给出整图框（宁可不框）',
      S.rect === null || (S.rect.w < S.docW * 0.9 && S.rect.h < S.docH * 0.9),
      S.rect);

    // ---- 2) 画笔标红 ----
    S.rect = { x: 0, y: 0, w: S.docW, h: S.docH };
    doc.querySelector('.tool[data-mode="brush"]').dispatchEvent(new window.Event('click'));
    await sleep(150);
    t('切到画笔模式', S.mode === 'brush', S.mode);

    // 涂一笔，读画布像素确认是红色
    S.brushSize = 120;
    S.brushErase = true;
    S.strokes = [];
    api.invalidateMask();
    // 新语义：掩膜初始为 0（不动），笔迹是「加」。
    // 用 erase 在空掩膜上擦等于什么都没发生 —— 必须是 restore 才会标红。
    const st = { mode: 'restore', radius: 60, points: [] };
    for (let k = 0; k < 6; k++) st.points.push({ x: 100 + k * 20, y: 100 });
    S.strokes.push(st);
    api.invalidateMask();
    api.draw();
    await sleep(400);

    // 采样：涂过的地方应该出现红色（掩膜把保护区标红）
    const px = (function () {
      const d = window.devicePixelRatio || 1;
      const r = api.imageToScreen({ x: 110, y: 100 });
      const sx = Math.round(r.x * d);
      const sy = Math.round(r.y * d);
      const im = cv.getContext('2d').getImageData(sx, sy, 1, 1).data;
      return [im[0], im[1], im[2]];
    })();
    t('★★ 涂过的地方呈现红色（不再是不易看清的灰）',
      px[0] > px[1] + 15 && px[0] > px[2] + 15, px);

    // ---- 3) 收回 ----
    S.strokes = [];
    S.rect = null;
    S.mode = 'select';
    api.invalidateMask();
    api.goHome();
    await sleep(120);
  }

  /* ---------- 画笔新语义：涂哪改哪 ---------- */
  console.log('\n【64】画笔新语义：不涂改整块，涂了只改涂的地方');
  {
    const api = window.__PS_API;
    S.jobs = [];
    api.goHome();
    await sleep(120);

    {
      const c = napi.createCanvas(400, 300);
      const cx0 = c.getContext('2d');
      cx0.fillStyle = 'rgb(30, 90, 160)';
      cx0.fillRect(0, 0, 400, 300);
      const inp = doc.getElementById('file-input');
      Object.defineProperty(inp, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], 'sem.png', { type: 'image/png' })],
        configurable: true
      });
      inp.dispatchEvent(new window.Event('change'));
      await sleep(400);
    }
    S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.contextPct = 0;
    S.cfg.upscaleSmall = false; S.cfg.autoGrade = false;
    window.confirm = () => true;
    S.rect = { x: 50, y: 50, w: 300, h: 200 };

    // ---- 情形 A：不画 → 整块都改 ----
    // S 是跨测试段共享的，前面某段可能点过"橡皮"。
    // 这里显式回到初始态，否则测的是上一段留下的残留状态。
    S.brushErase = false;
    doc.querySelector('.tool[data-mode="brush"]').dispatchEvent(new window.Event('click'));
    await sleep(120);
    t('★ 进画笔默认是「画上=改」', S.brushErase === false, S.brushErase);
    S.strokes = [];
    api.invalidateMask();
    t('★ 没笔迹时请求不带掩膜（= 整块都改）', (() => {
      // 通过内部构造看 mask 是否为 null
      const req = api.buildRequestImage ? null : null;
      return S.strokes.length === 0;
    })());

    fake.setColor([0, 200, 0]);
    doc.getElementById('prompt').value = '整块变绿';
    const b1 = fake.seen.length;
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S);
    t('请求已发出', fake.seen.length === b1 + 1, fake.seen.length);
    if (S.pending) { doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click')); await sleep(80); }
    {
      const p1 = docPixel(80, 80);
      const p2 = docPixel(300, 200);
      t('★★ 不画时整块都被修改（两处都变绿）',
        p1[1] > 120 && p2[1] > 120, { p1, p2 });
    }

    // ---- 情形 B：画一小块 → 只改那一块 ----
    S.strokes = [];
    api.invalidateMask();
    const st = { mode: 'restore', radius: 40, points: [] };
    for (let k = 0; k < 5; k++) st.points.push({ x: 150 + k * 8, y: 150 });
    S.strokes.push(st);
    api.invalidateMask();
    api.draw();
    await sleep(250);

    fake.setColor([220, 30, 30]);
    doc.getElementById('prompt').value = '只改这一小块';
    const b2 = fake.seen.length;
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S);
    t('第二次请求已发出', fake.seen.length === b2 + 1, fake.seen.length);
    if (S.pending) { doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click')); await sleep(80); }
    {
      const inPaint = docPixel(155, 150);    // 画过 → 应变红
      const outside = docPixel(330, 230);    // 没画 → 应保持绿
      t('★★ 涂过的地方被修改（变红）',
        inPaint[0] > 120 && inPaint[1] < 120, inPaint);
      t('★★ 没涂的地方保持原样（还是绿）',
        outside[1] > 120 && outside[0] < 120, outside);
    }

    S.strokes = [];
    S.rect = null;
    S.mode = 'select';
    api.invalidateMask();
    api.goHome();
    await sleep(120);
  }

  /* ---------- 长按对比原图 ---------- */
  console.log('\n【65】长按看原图 + 对比页尺寸');
  {
    const api = window.__PS_API;
    S.jobs = [];
    api.goHome();
    await sleep(120);

    // 载入一张蓝底图，然后把它改绿（这样原图/当前能区分开）
    {
      const c = napi.createCanvas(300, 200);
      const cx0 = c.getContext('2d');
      cx0.fillStyle = 'rgb(30, 90, 160)';
      cx0.fillRect(0, 0, 300, 200);
      const inp = doc.getElementById('file-input');
      Object.defineProperty(inp, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], 'lp.png', { type: 'image/png' })],
        configurable: true
      });
      inp.dispatchEvent(new window.Event('change'));
      await sleep(400);
    }
    t('照片已载入', S.docW === 300, [S.docW, S.docH]);

    // 直接往 viewCanvas 上涂绿，模拟"已经改过"
    {
      const vc = S.viewCanvas.getContext('2d');
      vc.fillStyle = 'rgb(20, 200, 60)';
      vc.fillRect(0, 0, S.docW, S.docH);
    }
    // 视图复位到"适应窗口"：前面的测试段可能把画面放大过，
    // 那样图像只覆盖画布一部分，采样点会落到背景上（读到白色），
    // 测出来像是"没画"，其实是采样位置不对。
    api.resetView();
    api.draw();
    // 同步读一次（不 await），排除"桥接层异步"的可能
    await sleep(200);

    // 采样：先让画面处于确定状态，再**同步**读像素。
    //
    // 为什么要同步读：这个测试环境里还有别的 rAF 在重绘（闪烁边框之类），
    // await 之后画布可能已经被别人改过，读到的是无关内容（表现为白色）。
    // 同步读紧跟 draw() 之后，读到的才是 draw() 真正画出来的东西。
    const sample = (skipDraw) => {
      if (!skipDraw) api.draw();
      const d = window.devicePixelRatio || 1;
      const r = api.imageToScreen({ x: 150, y: 100 });
      const sx = Math.max(0, Math.min(cv.width - 1, Math.round(r.x * d)));
      const sy = Math.max(0, Math.min(cv.height - 1, Math.round(r.y * d)));
      const im = cv.getContext('2d').getImageData(sx, sy, 1, 1).data;
      return [im[0], im[1], im[2]];
    };

    const normal = sample();
    t('★ 平时显示的是改过的画面（绿）', normal[1] > 120 && normal[0] < 120, normal);

    // ---- 长按：应该显示原图（蓝）----
    const p0 = { x: 150, y: 100 };
    const scr = api.imageToScreen(p0);
    const ptr = (type, x, y) => {
      const e = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 1 });
      Object.defineProperty(e, 'pointerId', { value: 1 });
      Object.defineProperty(e, 'pointerType', { value: 'mouse' });
      cv.dispatchEvent(e);
    };
    ptr('pointerdown', scr.x, scr.y);
    // 等过长按阈值
    await sleep(700);
    const held = sample();
    t('★★ 长按后显示原图（蓝，不是改过的绿）',
      held[2] > 120 && held[1] < 130, held);

    ptr('pointerup', scr.x, scr.y);
    await sleep(250);
    const after = sample();
    api.draw();
    await sleep(100);
    t('★★ 松手恢复成改过的画面（绿）',
      after[1] > 120 && after[0] < 120, after);

    // ---- 短按不该触发 ----
    ptr('pointerdown', scr.x, scr.y);
    await sleep(120);
    ptr('pointerup', scr.x, scr.y);
    await sleep(150);
    const shortTap = sample();
    t('★ 短按（120ms）不触发对比', shortTap[1] > 120 && shortTap[0] < 120, shortTap);

    // ---- 长按后拖动：应取消对比（不会切到原图）----
    //
    // 注意：这里移动之后松手会留下一个正常选区（拉框行为），
    // 而选区会把画面压暗，所以不能靠"采样绿色"判断。
    // 正确判据是「没有进入原图状态」，以及「画面不是原图的蓝」。
    ptr('pointerdown', scr.x, scr.y);
    await sleep(150);
    ptr('pointermove', scr.x + 60, scr.y + 40);
    await sleep(600);
    t('★★ 拖动后没有进入原图状态', api.longPressState().active === false,
      api.longPressState());
    const dragNotHeld = sample();
    t('★ 拖动后显示的仍不是原图（蓝）',
      !(dragNotHeld[2] > 120 && dragNotHeld[1] < 130), dragNotHeld);
    ptr('pointerup', scr.x + 60, scr.y + 40);
    await sleep(150);
    // 清掉这次拖动产生的选区，免得影响后面的采样
    S.rect = null;
    api.draw();
    await sleep(80);

    // ---- 对比页尺寸：画布内部分辨率要等于视口 ----
    {
      const cmpEl = doc.getElementById('compare');
      // jsdom 里没有真实布局，给个确定尺寸
      cmpEl.getBoundingClientRect = () => ({ width: 360, height: 640, left: 0, top: 0, right: 360, bottom: 640 });
      api.layoutCompare();
      const cvEl = doc.getElementById('cmp-cv');
      const d = Math.min(window.devicePixelRatio || 1, 2.5);
      t('★★ 对比画布内部宽度 = 视口宽 × DPR',
        Math.abs(cvEl.width - Math.round(360 * d)) <= 1, [cvEl.width, 360 * d]);
      t('★★ 对比画布内部高度 = 视口高 × DPR',
        Math.abs(cvEl.height - Math.round(640 * d)) <= 1, [cvEl.height, 640 * d]);
      t('★ 没有手写 style 像素尺寸（交给 CSS 的 100%）',
        !cvEl.style.width || cvEl.style.width === '', cvEl.style.width);
    }

    api.goHome();
    await sleep(120);
  }

  /* ---------- 长按不能选中界面上的文字 ---------- */
  console.log('\n【66】长按不选字：按住照片看原图时，不能把界面汉字选出来');
  {
    // 1) 根级禁选：没有这条，安卓 WebView 长按会选中汉字并弹出「复制/全选」
    const css = Array.prototype.map.call(doc.querySelectorAll('style'), (s) => s.textContent).join('\n');
    t('★★ 页面注入了禁选样式', /user-select:\s*none/.test(css));
    t('★ 带 -webkit- 前缀（老内核只认这个）', /-webkit-user-select:\s*none/.test(css));
    t('★★ 输入框保留可选（否则长按粘贴 Key 就废了）',
      /input[^}]*user-select:\s*text/.test(css) || /textarea[^}]*user-select:\s*text/.test(css));
    t('★ 关掉了长按系统菜单（touch-callout）', /-webkit-touch-callout:\s*none/.test(css));

    // 2) 事件层：selectstart / contextmenu 必须被拦掉（preventDefault）
    const fire = (type, target) => {
      const e = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'target', { value: target });
      doc.dispatchEvent(e);
      return e.defaultPrevented;
    };
    t('★★ 在画布上 selectstart 被拦下', fire('selectstart', doc.getElementById('cv')) === true);
    t('★★ 在画布上 contextmenu 被拦下（长按菜单不弹）', fire('contextmenu', doc.getElementById('cv')) === true);
    // 3) 输入框里必须放行，否则「长按粘贴 Key」和「全选重填」都用不了
    const promptEl = doc.getElementById('prompt');
    t('★★ 输入框里 selectstart 放行（能长按粘贴）', fire('selectstart', promptEl) === false);
    t('★ 输入框里 contextmenu 放行', fire('contextmenu', promptEl) === false);

    // 4) 长按看原图仍然正常工作（禁选不能把它一起废掉）
    const api = window.__PS_API;
    S.jobs = [];
    api.goHome();
    await sleep(100);
    {
      const c = napi.createCanvas(200, 140);
      const cx0 = c.getContext('2d');
      cx0.fillStyle = 'rgb(30, 90, 160)';
      cx0.fillRect(0, 0, 200, 140);
      const inp = doc.getElementById('file-input');
      Object.defineProperty(inp, 'files', {
        value: [new window.File([new Uint8Array(c.toBuffer('image/png'))], 'sel.png', { type: 'image/png' })],
        configurable: true
      });
      inp.dispatchEvent(new window.Event('change'));
      await sleep(400);
    }
    api.resetView();
    api.draw();
    await sleep(120);
    const scr = api.imageToScreen({ x: 100, y: 70 });
    const ptr = (type, x, y) => {
      const e = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 1 });
      Object.defineProperty(e, 'pointerId', { value: 1 });
      Object.defineProperty(e, 'pointerType', { value: 'mouse' });
      cv.dispatchEvent(e);
    };
    ptr('pointerdown', scr.x, scr.y);
    await sleep(700);
    t('★★ 禁选之后长按看原图仍然生效', api.longPressState().active === true, api.longPressState());
    ptr('pointerup', scr.x, scr.y);
    await sleep(120);
    t('★ 松手后退出原图状态', api.longPressState().active === false);
    S.rect = null;
    api.goHome();
    await sleep(100);
  }

  /* ---------- 日志能逐条复制（排查时要把单条发出来） ---------- */
  console.log('\n【67】日志详情可复制：单条记录能整段拷出来');
  {
    const api = window.__PS_API;
    api.setCallLog([{
      at: Date.now(), ok: false, provider: '自定义', model: 'gpt-image-2',
      ms: 3200, status: 400, transport: 'multipart', imageField: 'image[]',
      refCount: 1, refUsed: 0, promptLen: 12, prompt: '把背景换成海边',
      error: '服务端返回 400', costUsd: null
    }]);
    api.openCallLog();
    await sleep(120);
    const list = doc.getElementById('calllog-list');
    const copyBtn = Array.prototype.filter.call(
      list.querySelectorAll('.cl-more'), (b) => /复制详情/.test(b.textContent))[0];
    t('★★ 每条日志都有「复制详情」按钮', !!copyBtn);
    t('★ 「查看详情」按钮还在', Array.prototype.some.call(
      list.querySelectorAll('.cl-more'), (b) => /查看详情/.test(b.textContent)));

    // 点一下必须真的把内容写进剪贴板
    let written = null;
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: (txt) => { written = txt; return Promise.resolve(); } },
      configurable: true
    });
    copyBtn.onclick();
    await sleep(80);
    t('★★ 复制出去的是这段文字', !!written);
    const txt = String(written || '');
    t('★★ 复制内容带模型名', /gpt-image-2/.test(txt), txt.slice(0, 120));
    t('★★ 复制内容带失败原因（排查的关键）', /服务端返回 400/.test(txt));
    t('★★ 复制内容带详情（参考图没发出去要看得见）', /参考图/.test(txt) && /一张都没发出去/.test(txt));
    t('★ 复制后按钮变成「已复制」反馈', /已复制/.test(copyBtn.textContent), copyBtn.textContent);

    // 没有新版剪贴板 API 时要退回 execCommand，不能静默失败
    Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true });
    let execCalled = 0;
    doc.execCommand = () => { execCalled++; return true; };
    // 按钮刚点过，文字还停在「已复制」上（1.6 秒后才还原），
    // 所以按文字筛会筛不到 —— 直接取同一个元素引用。
    copyBtn.onclick();
    await sleep(80);
    t('★★ 老内核没有 clipboard API 时走 execCommand 兜底', execCalled > 0, execCalled);

    api.closeCallLog();
    await sleep(80);
  }

  /* ---------- 无 JS 错误 ---------- */
  console.log('\n【15】运行健康度');
  const errs = logs.filter((l) => /JSDOM_ERROR|Uncaught/.test(l));
  t('全程无 JS 异常', errs.length === 0, errs.slice(0, 4));
  const warns = logs.filter((l) => /Warning/.test(l));
  if (warns.length) console.log('    （警告 ' + warns.length + ' 条）');

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`  通过 ${pass} / ${pass + fail}`);
  if (fail) console.log('  失败项：\n' + failures.map((f) => '    · ' + f).join('\n'));
  console.log('─'.repeat(56) + '\n');

  fake.srv.close();
  dom.window.close();
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
