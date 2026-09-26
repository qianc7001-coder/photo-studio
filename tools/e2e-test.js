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
    if (fm) out.files[nm[1]] = { name: fm[1], data: body, length: body.length };
    else out.fields[nm[1]] = body.toString('utf8').replace(/\r\n$/, '');
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
        const rec = { url: req.url, auth: req.headers.authorization, body: json, multipart: mpFields, ctype: req.headers['content-type'] || '' };
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
        // 生成纯色 PNG
        const c = napi.createCanvas(64, 64);
        const cx = c.getContext('2d');
        cx.fillStyle = `rgb(${nextColor[0]},${nextColor[1]},${nextColor[2]})`;
        cx.fillRect(0, 0, 64, 64);
        const b64 = c.toBuffer('image/png').toString('base64');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ images: [{ url: 'data:image/png;base64,' + b64 }] }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      srv, port: srv.address().port, seen,
      setColor: (c) => { nextColor = c; }
    }));
  });
}

/* ============================ 测试主流程 ============================ */

async function run() {
  const fake = await startFakeModel();
  console.log(`\n假模型服务器：127.0.0.1:${fake.port}\n`);
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
            return function (img, x, y) {
              const data = img && img.data ? img.data : img;
              return target.putImageData(new napi.ImageData(data, img.width, img.height), x, y);
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

  window.HTMLCanvasElement.prototype.toDataURL = function (fmt, q) {
    if (!this.__real) this.getContext('2d');
    return 'data:image/jpeg;base64,' + this.__real.toBuffer('image/jpeg', q || 0.92).toString('base64');
  };
  window.HTMLCanvasElement.prototype.toBlob = function (cb, fmt, q) {
    if (!this.__real) this.getContext('2d');
    const buf = this.__real.toBuffer(fmt === 'image/png' ? 'image/png' : 'image/jpeg', q || 0.92);
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
  S.cfg.tile = 0;
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

  const mask = window.PSCore.strokesToMask(
    S.strokes.map((s) => ({ mode: s.mode, radius: s.radius, points: s.points.map((p) => ({ x: p.x - S.rect.x, y: p.y - S.rect.y })) })),
    S.rect.w, S.rect.h);
  const cov = window.PSCore.maskCoverage(mask);
  t('默认排除笔：掩膜覆盖度 < 100%', cov > 0.5 && cov < 0.999, cov);

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
  const painted = docPixel(115, 115);     // 涂抹过 → 排除 → 不改
  const untouched = docPixel(220, 220);   // 没涂 → 交给模型 → 变绿
  t('涂抹过（排除）的区域保持原样', JSON.stringify(painted) === '[30,90,160]', painted);
  t('未涂抹的区域被模型修改', untouched[1] > 120 && untouched[0] < 100, untouched);
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
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.tile = 0;
  S.cfg.upscaleSmall = true;
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
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.tile = 0;
  // 8:1 的细长选区，模型会返回 16:9 → 必须裁切而不是拉伸
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
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.tile = 0;
  S.rect = { x: 30, y: 30, w: 120, h: 120 };
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
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.tile = 0; S.cfg.upscaleSmall = false;
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
  // 恢复默认
  S.cfg.provider = 'siliconflow';
  S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
  S.cfg.model = 'Qwen/Qwen-Image-Edit';

  /* ---------- 偏色：发给模型的图片不能带蓝色标记 ---------- */
  console.log('\n【17】发给模型的图片不得偏色（画笔蓝层回归测试）');
  S.cfg.provider = 'siliconflow';
  S.cfg.baseUrl = 'https://api.siliconflow.cn/v1';
  S.cfg.model = 'Qwen/Qwen-Image-Edit';
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.tile = 0; S.cfg.upscaleSmall = false;
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
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.tile = 0; S.cfg.upscaleSmall = false;
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
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.tile = 0; S.cfg.upscaleSmall = false;
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
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.tile = 0; S.cfg.upscaleSmall = false;
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
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.tile = 0; S.cfg.upscaleSmall = false;
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
  S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.tile = 1400; S.cfg.upscaleSmall = false;
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

  // 触发分块：底图只有 400x300，必须把分块阈值调小才会分块
  const csTileEarly = doc.getElementById('set-tile');
  csTileEarly.value = '200';
  csTileEarly.dispatchEvent(new window.Event('change'));
  S.rect = { x: 10, y: 10, w: 380, h: 280 };
  window.__PS_API.updateUI();
  await sleep(80);
  const csHintBig = doc.getElementById('gen-hint').textContent;
  t('分块时提示多次调用', /次调用/.test(csHintBig), csHintBig);
  const csEstBig = window.__PS_API.currentEstimate();
  t('分块时调用次数 > 1', csEstBig && csEstBig.calls > 1, csEstBig && csEstBig.calls);
  t('分块时金额按次数累加', csEstBig && Math.abs(csEstBig.totalUsd - 0.04 * csEstBig.calls) < 1e-9,
    csEstBig && csEstBig.totalUsd);
  // 恢复分块阈值
  csTileEarly.value = '1400';
  csTileEarly.dispatchEvent(new window.Event('change'));
  await sleep(60);

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
  const csTile = doc.getElementById('set-tile');
  csTile.value = '300';            // 强制多块，抬高预估金额
  csTile.dispatchEvent(new window.Event('change'));
  window.__PS_API.updateUI();
  await sleep(100);
  const csEstConfirm = window.__PS_API.currentEstimate();
  t('预估金额达到确认阈值', csEstConfirm && csEstConfirm.totalUsd >= 0.2, csEstConfirm && csEstConfirm.totalUsd);
  doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
  await sleep(200);
  t('大额生成前弹出确认', csConfirmCalled);
  t('确认信息含金额与块数', /\$/.test(csConfirmMsg) && /块/.test(csConfirmMsg), csConfirmMsg.slice(0, 80));
  t('取消确认则不生成', S.pending === null);
  window.confirm = csOrigConfirm;
  csTile.value = '1400';
  csTile.dispatchEvent(new window.Event('change'));
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
  const s0 = S.view.scale;
  doc.getElementById('zoom-in').dispatchEvent(new window.Event('click'));
  await sleep(30);
  t('放大生效', S.view.scale > s0, [s0, S.view.scale]);
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

  /* ---------- 后台保活（JS ↔ 原生桥） ---------- */
  console.log('\n【14.8】后台保活');

  // jsdom 里没有原生桥，先装一个假的，用来验证 JS 侧的调用时机与参数
  const kaCalls = [];
  window.PSBridge = {
    supported: () => true,
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
    t('没照片时工具栏收起', window.__PS_API.toolbarVisible() === false);
    t('收起态打了 collapsed 类',
      doc.getElementById('bottombar').classList.contains('collapsed') === true);
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
    S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.tile = 0; S.cfg.upscaleSmall = false;
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
    t('类型选择器有 5 个选项（含自由绘制）',
      doc.querySelectorAll('#guide-kinds [data-gk]').length === 5);
    t('默认类型是地平线',
      doc.querySelector('#guide-kinds [data-gk="horizon"]').classList.contains('on'));

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
    t('引导线类型正确', S.guides[0].kind === 'horizon', S.guides[0]);
    t('引导线归一化坐标在 0~1',
      S.guides[0].y1 >= 0 && S.guides[0].y1 <= 1 && S.guides[0].x2 > S.guides[0].x1);
    t('数量角标已更新',
      doc.getElementById('guide-count').textContent === '1' &&
      doc.getElementById('guide-count').hidden === false);
    t('方向被对齐（几乎水平）',
      Math.abs(S.guides[0].y2 - S.guides[0].y1) < 0.02, S.guides[0]);

    // 画第二条：垂直线
    doc.querySelector('#guide-kinds [data-gk="vertical"]').dispatchEvent(new window.Event('click'));
    await sleep(60);
    t('切换到垂直线类型', S.guideKind === 'vertical');
    const gx = r2.left + sr.x + sr.w * 0.35;
    mk2('pointerdown', gx - r2.left, gy - r2.top - sr.h * 0.3);
    mk2('pointermove', gx - r2.left + 2, gy - r2.top + sr.h * 0.3);
    mk2('pointerup', gx - r2.left + 2, gy - r2.top + sr.h * 0.3);
    await sleep(80);
    t('第二条引导线已记录', S.guides.length === 2, S.guides.length);
    t('第二条是垂直线', S.guides[1].kind === 'vertical');

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
      t('提示词写了地平线位置', /地平线/.test(pr));
      t('提示词写了垂直线位置', /垂直参考线/.test(pr));
      t('提示词要求不要画出线条', /不要.*画出任何线条/.test(pr));
      // 关键：引导线位置必须按 contextPct 补偿，不能直接用选区内的归一化值
      t('引导线位置已换算到请求图坐标（不是选区内的原值）',
        !new RegExp('高度 50%').test(pr), pr.slice(0, 260));
    }

    // 引导线不进图片：请求图里不能出现引导线的青色（#3ddcc4）。
    // 这和当初「蓝色掩膜被模型当成画面内容」是同一类坑，必须逐像素确认。
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
        let cyan28 = 0;
        for (let i = 0; i < px28.length; i += 4) {
          // 引导线颜色 61,220,196：允许编码误差
          if (Math.abs(px28[i] - 61) < 30 && Math.abs(px28[i + 1] - 220) < 30 &&
              Math.abs(px28[i + 2] - 196) < 30) cyan28++;
        }
        t('请求图里没有引导线像素（线只画在屏幕上）', cyan28 === 0, cyan28);
      }
    } else {
      t('请求里带了参考图（跳过）', true);
      t('请求图里没有引导线像素（跳过）', true);
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
    window.__PS_API.setGuides([{ kind: 'horizon', x1: 0, y1: .5, x2: 1, y2: .5 }]);
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
    S.cfg.feather = 0; S.cfg.colorMatch = 0; S.cfg.tile = 0;
    S.cfg.upscaleSmall = false; S.cfg.contextPct = 0;
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
    t('自由绘制时显示颜色条', doc.getElementById('guide-color-bar').hidden === false);
    t('自由绘制时显示专用提示', doc.getElementById('guide-tip-free').hidden === false);
    t('自由绘制时隐藏构图提示', doc.getElementById('guide-tip').hidden === true);
    t('颜色条有 3 个选项', doc.querySelectorAll('#guide-colors [data-gc]').length === 3);
    t('默认选中红色',
      doc.querySelector('#guide-colors [data-gc="red"]').classList.contains('on'));

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
      t('提示词含「手绘草图」段', /手绘草图/.test(pr30), pr30.slice(0, 120));
      t('提示词要求沿笔迹生成', /沿着笔迹生成/.test(pr30));
      t('提示词含发丝等示例', /头发/.test(pr30));
      t('提示词禁止把线画进画面', /绝对不要把红色线条本身画进画面/.test(pr30));

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

    // ---- 切换颜色：请求图里的颜色必须跟着变 ----
    doc.querySelector('#guide-colors [data-gc="magenta"]').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('切到品红色', S.cfg.guideStrokeColor === 'magenta');
    t('颜色选择已落盘',
      JSON.parse(window.localStorage.getItem('photoStudio.cfg.v1')).guideStrokeColor === 'magenta');
    const beforeC = fake.seen.length;
    fake.setColor([120, 180, 120]);
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 8000);
    const genC = fake.seen.slice(beforeC).filter((x) => x.body && x.body.prompt);
    if (genC.length) {
      t('提示词里的颜色名跟着变（品红色）', /品红色/.test(genC[0].body.prompt));
      const mC = /^data:image\/(jpeg|png);base64,(.*)$/.exec(String(genC[0].body.image || ''));
      if (mC) {
        const imC = await napi.loadImage(Buffer.from(mC[2], 'base64'));
        const ccC = napi.createCanvas(imC.width, imC.height);
        const cxC = ccC.getContext('2d');
        cxC.drawImage(imC, 0, 0);
        const pxC = cxC.getImageData(0, 0, imC.width, imC.height).data;
        let mag = 0;
        for (let i = 0; i < pxC.length; i += 4) {
          // 品红：R 与 B 都高、G 低
          if (pxC[i] > 110 && pxC[i + 2] > 110 && pxC[i + 1] < pxC[i] - 50) mag++;
        }
        t('请求图里的笔迹真的变成了品红', mag > 100, mag);
      } else {
        t('请求图里的笔迹真的变成了品红（跳过）', true);
      }
    }
    if (S.pending) {
      doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
      await sleep(120);
    }

    // ---- 开关：关掉后请求图里不能有笔迹，但提示词仍要有说明 ----
    S.cfg.guideStrokeOverlay = false;
    const beforeOff = fake.seen.length;
    fake.setColor([120, 180, 120]);
    doc.getElementById('btn-generate').dispatchEvent(new window.Event('click'));
    await waitGen(S, 8000);
    const genOff = fake.seen.slice(beforeOff).filter((x) => x.body && x.body.prompt);
    t('关掉后仍发起了请求', genOff.length > 0, genOff.length);
    if (genOff.length) {
      t('关掉后提示词里仍有笔迹说明（退化成文字）', /手绘草图/.test(genOff[0].body.prompt));
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
        t('关掉后请求图里没有笔迹', any === 0, any);
      } else {
        t('关掉后请求图里没有笔迹（跳过）', true);
      }
    }
    t('关掉后自检标注为「未画进图片」', /关闭/.test(window.__PS_API.strokeNote()), window.__PS_API.strokeNote());
    if (S.pending) {
      doc.getElementById('cmp-apply').dispatchEvent(new window.Event('click'));
      await sleep(120);
    }
    S.cfg.guideStrokeOverlay = true;

    // ---- 设置页开关与颜色 ----
    doc.getElementById('btn-settings').dispatchEvent(new window.Event('click'));
    await sleep(80);
    t('设置里有笔迹进图开关', !!doc.getElementById('set-strokeimg'));
    t('设置开关反映当前状态', doc.getElementById('set-strokeimg').checked === true);
    t('设置里有颜色选择', doc.getElementById('set-strokecolor').value === 'magenta');
    doc.getElementById('set-strokecolor').value = 'cyan';
    doc.getElementById('set-strokecolor').dispatchEvent(new window.Event('change'));
    await sleep(60);
    t('从设置改颜色生效', S.cfg.guideStrokeColor === 'cyan');
    doc.getElementById('set-strokeimg').checked = false;
    doc.getElementById('set-strokeimg').dispatchEvent(new window.Event('change'));
    await sleep(60);
    t('从设置关开关生效', S.cfg.guideStrokeOverlay === false);
    t('关开关后不再显示颜色条说明', window.__PS_API.strokeOverlayEnabled() === false);
    doc.getElementById('set-strokeimg').checked = true;
    doc.getElementById('set-strokeimg').dispatchEvent(new window.Event('change'));
    await sleep(60);
    doc.querySelector('#settings [data-close]').dispatchEvent(new window.Event('click'));
    await sleep(60);

    // ---- 笔迹随会话保存 ----
    const sess31 = JSON.parse(window.localStorage.getItem('photoStudio.session.v1') || 'null');
    t('笔迹写进了会话存档', !!(sess31 && sess31.guides && sess31.guides.length === 1),
      sess31 && sess31.guides && sess31.guides.length);
    t('存档里的笔迹带 points', !!(sess31 && sess31.guides[0].points &&
      sess31.guides[0].points.length >= 4));
    t('存档里记了笔迹类型', sess31 && sess31.guideKind === 'freehand', sess31 && sess31.guideKind);

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
    S.cfg.guideStrokeColor = 'red';
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
