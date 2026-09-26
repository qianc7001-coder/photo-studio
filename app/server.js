#!/usr/bin/env node
/* =============================================================================
 * 修图台 · 本地服务
 *   - 提供静态页面（手机浏览器打开 http://127.0.0.1:8788 即可使用）
 *   - 提供 /api/generate 同源代理：把生图请求转发给服务商，避免浏览器跨域限制
 *   - 提供 /api/health 健康检查
 * 用法：node server.js [端口]
 * ========================================================================== */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8788);
// 默认只监听本机：这个服务带生图代理，暴露到局域网等于把 API Key 转发能力开放出去。
// 需要手机从局域网访问时，显式设置 HOST=0.0.0.0 并自行确认网络环境可信。
const HOST = process.env.HOST || '127.0.0.1';
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_TARGET === '1';
const MAX_BODY = 64 * 1024 * 1024;   // 64MB，够 4K 图的 base64
const UPSTREAM_TIMEOUT = 300000;     // 5 分钟

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function send(res, code, body, headers) {
  // 页面与接口同源，正常不需要 CORS 头；显式回显本机来源，避免任意网站读取响应
  const h = Object.assign({
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  }, headers || {});
  const origin = res.__reqOrigin;
  if (origin && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Content-Type,X-Target-Url,X-Target-Auth,X-Target-Content-Type,X-Target-Method,X-Target-Accept,X-Target-User-Agent';
    h['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
  }
  res.writeHead(code, h);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 判断目标是否指向本机/私网/链路本地地址（含云厂商元数据 169.254.169.254） */
function isPrivateTarget(target) {
  let h;
  try { h = new URL(target).hostname.toLowerCase(); } catch (e) { return true; }
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1') return true;
  // IPv6
  if (h.startsWith('[')) h = h.slice(1, -1);
  if (h.includes(':')) {
    return h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h === '::1';
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;      // 链路本地 / 云元数据
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
  return false;
}

/** 把请求转发到上游 */
function proxyUpstream(target, method, headers, body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch (e) { reject(new Error('接口地址无效：' + target)); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: method,
      headers: headers,
      timeout: UPSTREAM_TIMEOUT
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(new Error('上游超时（' + (UPSTREAM_TIMEOUT / 1000) + 's）')); });
    req.on('error', (e) => reject(e));
    if (body && body.length) req.write(body);
    req.end();
  });
}

/**
 * 生图请求代理。
 * 协议：目标地址与鉴权放在请求头，请求体原样转发（服务端不做 JSON 解析）。
 *   POST /api/generate
 *   X-Target-Url: https://api.siliconflow.cn/v1/images/generations
 *   X-Target-Auth: Bearer sk-xxx
 *   body: {"model":...,"prompt":...}
 * 兼容旧协议：body 为 {url, headers, body} 时同样可用。
 */
async function handleGenerate(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    send(res, 413, JSON.stringify({ __proxyError: '请求体读取失败：' + e.message }), { 'Content-Type': MIME['.json'] });
    return;
  }

  let target = req.headers['x-target-url'];
  let auth = req.headers['x-target-auth'] || '';
  let payload = raw;

  // 兼容旧协议
  if (!target) {
    try {
      const j = JSON.parse(raw.toString('utf8'));
      if (j && j.url) {
        target = j.url;
        auth = (j.headers && j.headers.Authorization) || auth;
        payload = Buffer.from(JSON.stringify(j.body), 'utf8');
      }
    } catch (e) { /* 保持原样 */ }
  }

  if (!target) {
    send(res, 400, JSON.stringify({ __proxyError: '缺少 X-Target-Url' }), { 'Content-Type': MIME['.json'] });
    return;
  }
  // 只允许 http/https，防止 file:// 之类的协议被滥用
  if (!/^https?:\/\//i.test(target)) {
    send(res, 400, JSON.stringify({ __proxyError: '仅支持 http/https 目标地址' }), { 'Content-Type': MIME['.json'] });
    return;
  }
  // 阻止被当成内网探测器：默认拒绝指向本机/私网/云元数据地址的目标
  if (!ALLOW_PRIVATE && isPrivateTarget(target)) {
    send(res, 400, JSON.stringify({
      __proxyError: '出于安全考虑，默认不允许代理到本机或内网地址。如确实需要，请用 ALLOW_PRIVATE_TARGET=1 启动。'
    }), { 'Content-Type': MIME['.json'] });
    return;
  }

  // 透传原始 Content-Type：multipart/form-data 的 boundary 必须原样带上，
  // 否则上游无法解析表单，图片会被丢掉（表现为「上游回一段文字」）
  const contentType = req.headers['x-target-content-type'] || req.headers['content-type'] || 'application/json';
  // 上游请求方法：默认 POST（生图接口都是 POST），
  // 但 GitHub 的 releases 列表用 POST 会返回 401 —— 必须能指定 GET。
  let method = String(req.headers['x-target-method'] || 'POST').trim().toUpperCase();
  if (method !== 'GET' && method !== 'POST') method = 'POST';
  const headers = { 'Content-Type': contentType };
  if (auth) headers['Authorization'] = auth;
  // GitHub 的 API 强制要求 User-Agent，缺失会被 403 拒掉
  // （"Request forbidden by administrative rules"）。
  // 浏览器直连时会自动带上，但经过本代理转发就没有了 —— 必须补。
  // 同时透传调用方指定的 Accept，否则 GitHub 可能返回与预期不同的表示。
  headers['User-Agent'] = req.headers['x-target-user-agent'] || 'PhotoStudio';
  if (req.headers['x-target-accept']) headers['Accept'] = req.headers['x-target-accept'];

  const started = Date.now();
  try {
    const out = await proxyUpstream(target, method, headers, method === 'GET' ? null : payload);
    const ms = Date.now() - started;
    console.log(`[代理] ${method} ${target} -> ${out.status} (${ms}ms, ${out.body.length}B)`);
    send(res, out.status || 502, out.body, { 'Content-Type': out.headers['content-type'] || MIME['.json'] });
  } catch (e) {
    console.log(`[代理] ${method} ${target} -> 失败: ${e.message}`);
    send(res, 502, JSON.stringify({ __proxyError: '转发失败：' + e.message }), { 'Content-Type': MIME['.json'] });
  }
}

const server = http.createServer(async (req, res) => {
  // 解析失败要兜住：畸形百分号编码（如 /%）会抛 URIError，
  // 未捕获时整个服务进程会退出，后续请求全部失败。
  let url, pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch (e) {
    send(res, 400, 'Bad Request');
    return;
  }
  if (pathname.includes('\0')) { send(res, 400, 'Bad Request'); return; }

  // 记录来源，供 send() 决定是否回 CORS 头（只放行本机来源）
  res.__reqOrigin = req.headers.origin || '';

  // 非本机来源直接拒绝，避免被其它网站当作代理使用
  if (res.__reqOrigin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(res.__reqOrigin)) {
    send(res, 403, 'Forbidden: 仅允许本机页面调用');
    return;
  }

  if (req.method === 'OPTIONS') { send(res, 204, ''); return; }

  if (pathname === '/api/health') {
    send(res, 200, JSON.stringify({ ok: true, name: 'photo-studio', version: '1.0.0', time: Date.now() }),
      { 'Content-Type': MIME['.json'] });
    return;
  }

  if (pathname === '/api/generate') {
    if (req.method !== 'POST') { send(res, 405, 'Method Not Allowed'); return; }
    await handleGenerate(req, res);
    return;
  }

  // 静态文件（只允许 ROOT 目录内，规范化后二次校验）
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel.split('/').some((seg) => seg === '..')) { send(res, 403, 'Forbidden'); return; }
  const filePath = path.resolve(ROOT, rel);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (filePath !== ROOT && !filePath.startsWith(rootWithSep)) { send(res, 403, 'Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 单文件模式下把 /index.html 之外的路由回落到 index.html
      fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => {
        if (e2) send(res, 404, 'Not Found');
        else send(res, 200, d2, { 'Content-Type': MIME['.html'] });
      });
      return;
    }
    send(res, 200, data, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  });
});

// 最后一层保险：任何未捕获异常都不应该让服务退出
process.on('uncaughtException', (e) => {
  console.error('[修图台] 未捕获异常（已忽略，服务继续运行）：', e && e.message);
});
process.on('unhandledRejection', (e) => {
  console.error('[修图台] 未处理的 Promise 拒绝（已忽略）：', e && (e.message || e));
});

server.listen(PORT, HOST, () => {
  const nets = require('os').networkInterfaces();
  const ips = [];
  for (const k of Object.keys(nets)) {
    for (const n of nets[k] || []) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │            修图台 · 本地服务已启动            │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');
  console.log(`   本机访问：  http://127.0.0.1:${PORT}`);
  for (const ip of ips) console.log(`   局域网访问：http://${ip}:${PORT}`);
  console.log('');
  console.log('   在手机浏览器打开上面的地址即可开始修图。');
  console.log('   按 Ctrl+C 停止服务。');
  console.log('');
});
