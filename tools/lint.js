#!/usr/bin/env node
/* =============================================================================
 * 轻量代码检查（不依赖 eslint，避免安装依赖）
 *
 * 检查的是「这个项目真实踩过的坑」：
 *   1. 语法错误（用 Function 构造器校验）
 *   2. 文件里混入 HTML 结构（构建时替换导致过，源码被污染很难发现）
 *   3. 单文件构建产物结构损坏（</body> 必须恰好 1 次）
 *   4. 内联脚本块语法错误
 *   5. 重复的顶层函数定义（重复插入代码块导致过）
 *   6. 遗留的调试语句（console.log 大量残留）
 *   7. 敏感信息（密钥、token 硬编码）
 *   8. 版本号一致性（version.json / version.js / package.json）
 *
 * 用法：node tools/lint.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let errors = 0;
let warnings = 0;

const err = (msg) => { errors++; console.log('  ✗ ' + msg); };
const warn = (msg) => { warnings++; console.log('  ⚠ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

/* ---------- 1. 语法检查 ---------- */
console.log('\n【1】语法检查');
const JS_FILES = ['app/core.js', 'app/app.js', 'app/server.js', 'app/version.js'];
for (const f of JS_FILES) {
  if (!exists(f)) { err('缺少文件: ' + f); continue; }
  const src = read(f);
  try {
    // 用 Function 构造器解析（不执行），能抓到真正的语法错误。
    // 注意：shebang（#!/usr/bin/env node）不是合法 JS，Node 会特殊处理但 new Function 不会，
    // 所以要先去首行的 shebang，否则会误报。
    const code = src.replace(/^#![^\n]*\n/, '');
    new Function(code);
    ok(f);
  } catch (e) {
    err(f + ' 语法错误：' + e.message);
  }
}

/* ---------- 2. 源码不得混入 HTML 结构 ---------- */
console.log('\n【2】源码纯净度（不得混入 HTML 结构）');
for (const f of JS_FILES) {
  if (!exists(f)) continue;
  const src = read(f);
  // 这些标签出现在 JS 里，几乎一定是构建/替换事故
  for (const tag of ['</body>', '</html>', '</head>']) {
    if (src.includes(tag)) {
      const i = src.indexOf(tag);
      err(f + ' 含 ' + tag + '（位置 ' + i + '）：' + JSON.stringify(src.slice(Math.max(0, i - 60), i + 20)));
    }
  }
}
if (!errors) ok('所有 JS 源码干净');

/* ---------- 3. 单文件产物结构 ---------- */
console.log('\n【3】单文件产物结构');
const single = path.join(ROOT, 'dist', '修图台.html');
if (fs.existsSync(single)) {
  const h = fs.readFileSync(single, 'utf8');
  const bodyN = (h.match(/<\/body>/g) || []).length;
  const htmlN = (h.match(/<\/html>/g) || []).length;
  if (bodyN !== 1) err('产物 </body> 出现 ' + bodyN + ' 次（应为 1）');
  else ok('</body> 恰好 1 次');
  if (htmlN !== 1) err('产物 </html> 出现 ' + htmlN + ' 次（应为 1）');
  else ok('</html> 恰好 1 次');
  if (/href="style\.css"|src="core\.js"|src="app\.js"|src="version\.js"/.test(h)) {
    err('产物仍有外部引用（内联不完整）');
  } else {
    ok('无外部引用');
  }
  // 4. 内联脚本语法
  const blocks = [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  let bad = 0;
  blocks.forEach((b, i) => {
    try { new Function(b[1]); } catch (e) { err('内联脚本块 ' + (i + 1) + ' 语法错误：' + e.message); bad++; }
  });
  if (!bad) ok(blocks.length + ' 个内联脚本块语法正确');
} else {
  warn('未找到单文件产物（跳过；可运行 npm run build:web 生成）');
}

/* ---------- 5. 重复的顶层函数定义 ---------- */
console.log('\n【5】重复函数定义');
for (const f of ['app/core.js', 'app/app.js']) {
  if (!exists(f)) continue;
  const src = read(f);
  // 匹配顶层函数声明（缩进 <= 2 空格）
  const names = {};
  const re = /^\s{0,2}function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) {
    names[m[1]] = (names[m[1]] || 0) + 1;
  }
  const dups = Object.keys(names).filter((k) => names[k] > 1);
  if (dups.length) {
    for (const d of dups) err(f + ' 重复定义函数 ' + d + '（' + names[d] + ' 次）');
  } else {
    ok(f + ' 无重复定义');
  }
}

/* ---------- 6. 遗留调试语句 ---------- */
console.log('\n【6】调试语句残留');
for (const f of JS_FILES) {
  if (!exists(f) || f === 'app/version.js') continue;
  const src = read(f);
  const logs = (src.match(/console\.log\(/g) || []).length;
  const dbg = (src.match(/process\.env\.DB/g) || []).length;
  if (dbg > 0) {
    err(f + ' 残留 ' + dbg + ' 处 process.env.DB 调试代码（测试专用，应清理）');
  } else if (f === 'app/server.js') {
    // server.js 的 console.log 是正式日志（启动提示、代理转发记录），不算残留
    ok(f + '（' + logs + ' 处正式日志）');
  } else if (logs > 3) {
    warn(f + ' 有 ' + logs + ' 处 console.log（确认是否为正式日志）');
  } else {
    ok(f + '（' + logs + ' 处日志）');
  }
}

/* ---------- 7. 敏感信息 ---------- */
console.log('\n【7】敏感信息检查');
const SENSITIVE = [
  { re: /sk-[A-Za-z0-9]{20,}/g, name: 'API Key（sk- 开头）' },
  { re: /Bearer\s+[A-Za-z0-9._-]{30,}/g, name: 'Bearer Token' },
  { re: /-----BEGIN\s+(RSA\s+)?PRIVATE KEY-----/g, name: '私钥' }
];
let found = 0;
const scanTargets = ['app/core.js', 'app/app.js', 'app/server.js', 'app/index.html', 'README.md', 'package.json'];
for (const f of scanTargets) {
  if (!exists(f)) continue;
  const src = read(f);
  for (const s of SENSITIVE) {
    const m = src.match(s.re);
    if (m) { err(f + ' 含疑似' + s.name + '：' + m[0].slice(0, 12) + '…'); found++; }
  }
}
// 签名密钥不得被跟踪
if (exists('android/keystore.jks')) {
  if (exists('.gitignore') && read('.gitignore').includes('keystore.jks')) ok('签名密钥已被 .gitignore 忽略');
  else err('android/keystore.jks 存在但未被 .gitignore 忽略（签名密钥绝不能进仓库）');
}
// 归档快照也要查：.gitignore 只管仓库，复制归档时容易把密钥一起带过去
// （真实发生过：v2.4.0 / v2.4.1 的归档里混进了 keystore.jks）
{
  const archRoot = path.join(__dirname, '..', '..', 'photo-studio-archive');
  let leaked = [];
  try {
    for (const d of fs.readdirSync(archRoot)) {
      const p = path.join(archRoot, d, 'android', 'keystore.jks');
      if (fs.existsSync(p)) leaked.push(d);
    }
  } catch (e) { /* 没有归档目录就跳过 */ }
  if (leaked.length) err('归档快照里混入了签名密钥：' + leaked.join(', '));
  else ok('归档快照未含签名密钥');
}
if (!found) ok('未发现硬编码敏感信息');

/* ---------- 8. 版本号一致性 ---------- */
console.log('\n【8】版本号一致性');
if (exists('version.json') && exists('app/version.js') && exists('package.json')) {
  const vj = JSON.parse(read('version.json'));
  const pkg = JSON.parse(read('package.json'));
  const vjs = read('app/version.js');
  let bad = 0;
  if (!vjs.includes('"' + vj.versionName + '"')) { err('app/version.js 与 version.json 版本号不一致'); bad++; }
  if (pkg.version !== vj.versionName) { warn('package.json 版本 ' + pkg.version + ' 与 version.json ' + vj.versionName + ' 不一致'); }
  if (!vj.changelog || !vj.changelog.length) { err('version.json 缺少 changelog'); bad++; }
  if (!Number.isInteger(vj.versionCode) || vj.versionCode < 1) { err('version.json 的 versionCode 非法'); bad++; }
  if (!bad) ok('版本号 v' + vj.versionName + ' (code ' + vj.versionCode + ') 一致');
} else {
  err('缺少 version.json / app/version.js / package.json');
}

/* ---------- 9. 必需文件 ---------- */
console.log('\n【9】项目必需文件');
for (const f of ['README.md', 'LICENSE', '.gitignore', 'version.json', 'package.json']) {
  if (exists(f)) ok(f);
  else err('缺少 ' + f);
}

/* ---------- 汇总 ---------- */
console.log('\n' + '─'.repeat(52));
if (errors === 0) {
  console.log('  检查通过' + (warnings ? '（' + warnings + ' 条提醒）' : ''));
} else {
  console.log('  ' + errors + ' 项错误' + (warnings ? '，' + warnings + ' 条提醒' : ''));
}
console.log('─'.repeat(52) + '\n');
process.exit(errors ? 1 : 0);
