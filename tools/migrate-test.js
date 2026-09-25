/* =============================================================================
 * 配置迁移端到端验证
 *
 * 为什么单独测：改默认值对已安装的用户无效（localStorage 里存着旧值）。
 * 这个脚本模拟「老版本用户升级」的真实路径：
 *   预置老配置 → 启动应用 → 检查分块是否真的被关掉、且只关一次
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
// 可选依赖：优先标准解析（CI 装在项目内），退化到本机固定目录
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
const napi = loadOptional('@napi-rs/canvas');
const { JSDOM, VirtualConsole } = loadOptional('jsdom');

const APP = path.join(__dirname, '..', 'app');
let pass = 0, fail = 0;
const t = (n, c, e) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); }
};

/** 用给定的 localStorage 预置数据启动一次应用 */
async function boot(seedCfg) {
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', (e) => errs.push(e.detail ? (e.detail.stack || e.detail.message) : e.message));

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:8788/',
    virtualConsole: vc
  });
  const { window } = dom;

  // jsdom 没有 fetch（真实 WebView 有）。应用启动时会用它探测本地代理，
  // 这里给个最小桩，让测试专注于配置迁移本身。
  window.fetch = () => Promise.reject(new Error('offline (test stub)'));

  // 预置存储（必须在脚本执行前）
  if (seedCfg !== undefined) {
    window.localStorage.setItem('photoStudio.cfg.v1', JSON.stringify(seedCfg));
  }

  // 真实 canvas 桥接（与主 e2e 同款，保证应用能正常初始化）
  const realOf = (c) => {
    if (!c) return c;
    if (c.__real) return c.__real;
    if (c.canvas && c.canvas.__real) return c.canvas.__real;
    if (typeof c.getContext === 'function' && c.tagName === 'CANVAS') { c.getContext('2d'); return c.__real; }
    return c;
  };
  const wrapCtx = (realCtx) => new Proxy(realCtx, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v === 'function') {
        if (prop === 'drawImage') return function (...a) { return target.drawImage(...a.map(realOf)); };
        if (prop === 'putImageData') {
          return function (img, x, y) {
            const d = img && img.data ? img.data : img;
            return target.putImageData(new napi.ImageData(d, img.width, img.height), x, y);
          };
        }
        return v.bind(target);
      }
      return v;
    },
    set(target, prop, val) { try { target[prop] = val; } catch (e) { /* ignore */ } return true; }
  });
  window.HTMLCanvasElement.prototype.getContext = function () {
    if (!this.__real) this.__real = napi.createCanvas(Math.max(1, this.__w || 300), Math.max(1, this.__h || 150));
    if (!this.__wrapped) this.__wrapped = wrapCtx(this.__real.getContext('2d'));
    return this.__wrapped;
  };
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'width', {
    get() { return this.__w == null ? 300 : this.__w; },
    set(v) { this.__w = v; if (this.__real) this.__real.width = v; }
  });
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'height', {
    get() { return this.__h == null ? 150 : this.__h; },
    set(v) { this.__h = v; if (this.__real) this.__real.height = v; }
  });

  // 执行应用脚本（顺序与 index.html 一致）
  for (const f of ['version.js', 'core.js', 'app.js']) {
    const code = fs.readFileSync(path.join(APP, f), 'utf8');
    window.eval(code);
  }
  await new Promise((r) => setTimeout(r, 120));
  return { window, doc: window.document, errs, S: window.__PS };
}

(async () => {
  console.log('\n【配置迁移】老用户升级后，分块必须真的被关掉');

  // 1) 模拟老版本用户：存着分块开启 + 自己的 API 设置
  const oldCfg = {
    provider: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: 'sk-old-user-key',
    model: 'Qwen/Qwen-Image-Edit',
    tile: 1400,
    feather: 18,
    __savedAt: 1700000000000
  };
  const a = await boot(oldCfg);
  t('启动无 JS 异常', a.errs.length === 0, a.errs.slice(0, 2));
  t('分块被关闭', a.S.cfg.tile === 0, a.S.cfg.tile);
  t('API Key 完整保留', a.S.cfg.apiKey === 'sk-old-user-key', a.S.cfg.apiKey);
  t('模型设置完整保留', a.S.cfg.model === 'Qwen/Qwen-Image-Edit');
  t('其它设置不受影响', a.S.cfg.feather === 18, a.S.cfg.feather);
  t('迁移版本已写入内存', a.S.cfg.__cfgRev === a.window.PSCore.CFG_REV);

  // 2) 关键：迁移标记必须落盘，否则下次启动会再关一遍
  const persisted = JSON.parse(a.window.localStorage.getItem('photoStudio.cfg.v1'));
  t('迁移标记已落盘', persisted.__cfgRev === a.window.PSCore.CFG_REV, persisted.__cfgRev);
  t('落盘配置里分块是关的', persisted.tile === 0, persisted.tile);

  // 3) 用户手动重新打开分块 → 重启后不能被覆盖
  persisted.tile = 1600;
  const b = await boot(persisted);
  t('用户手动打开的分块不被覆盖', b.S.cfg.tile === 1600, b.S.cfg.tile);
  t('再次启动仍保留 API Key', b.S.cfg.apiKey === 'sk-old-user-key');

  // 4) 全新安装：默认就是关的
  const c = await boot(undefined);
  t('全新安装默认关闭分块', c.S.cfg.tile === 0, c.S.cfg.tile);
  t('全新安装不误报迁移', c.S.cfg.__cfgRev === c.window.PSCore.CFG_REV);

  // 5) 界面：设置滑块与文案要跟默认值一致
  const d = await boot(undefined);
  t('设置滑块值为 0', d.doc.getElementById('set-tile').value === '0',
    d.doc.getElementById('set-tile').value);
  t('设置标签显示「关闭」', d.doc.getElementById('v-tile').textContent === '关闭',
    d.doc.getElementById('v-tile').textContent);

  console.log(`\n  通过 ${pass} / ${pass + fail}`);
  if (fail) process.exit(1);
  process.exit(0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
