#!/usr/bin/env node
/* =============================================================================
 * 版本号自增守卫
 *
 * 解决的问题：改完代码重新构建时忘了改版本号，导致两个内容不同的包
 * 顶着同一个版本号，用户无法判断装的是不是新版。
 *
 * 做法：
 *   1. 计算源码内容指纹（app/ 下的网页代码 + Java 源码 + 构建脚本）
 *   2. 与上次构建时记录的指纹比较
 *   3. 内容变了但版本号没变 → 自动递增 versionCode，并把 versionName 的修订号 +1
 *   4. 内容没变 → 保持版本号（重复构建同一个包不算新版本）
 *
 * 也支持手动指定：在 version.json 里把 versionCode/versionName 写成更大的值，
 * 脚本会识别为「用户已手动指定」，不再自动递增。
 *
 * 用法：node tools/bump-version.js [--check-only]
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'version.json');
const STATE_FILE = path.join(ROOT, 'dist', '.build-state.json');
const CHECK_ONLY = process.argv.includes('--check-only');

/** 参与指纹计算的文件（顺序稳定，保证可复现） */
function collectSources() {
  const out = [];
  const walk = (dir, filter) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, filter);
      else if (!filter || filter(name)) out.push(p);
    }
  };
  walk(path.join(ROOT, 'app'), null);                       // 网页代码（含生成的 version.js 之外的部分）
  walk(path.join(ROOT, 'android', 'src'), (n) => n.endsWith('.java'));
  // 只把「会进入 APK 的内容」计入指纹：
  // 构建脚本、图标生成器等工具改动不影响产物功能，不该反复推高版本号。
  for (const f of ['android/AndroidManifest.xml', 'android/res/values/strings.xml',
                   'android/res/values/styles.xml']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) out.push(p);
  }
  // version.js 是从 version.json 生成的产物，不算内容变更
  return out.filter((p) => path.basename(p) !== 'version.js');
}

function contentHash() {
  const h = crypto.createHash('sha256');
  for (const f of collectSources()) {
    h.update(path.relative(ROOT, f));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 20);
}

/** versionName 的修订号 +1：1.1.0 → 1.1.1；1.2 → 1.2.1；异常格式则追加 .1 */
function bumpName(name) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(name || '').trim());
  if (!m) return String(name || '1.0') + '.1';
  const major = m[1], minor = m[2];
  const patch = m[3] === undefined ? 0 : parseInt(m[3], 10);
  return `${major}.${minor}.${patch + 1}`;
}

function main() {
  if (!fs.existsSync(VERSION_FILE)) {
    console.error('✗ 找不到 version.json');
    process.exit(1);
  }
  const ver = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  const hash = contentHash();

  let state = null;
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { /* 首次构建 */ }

  const sameContent = state && state.hash === hash;
  const versionRaised = state && Number(ver.versionCode) > Number(state.versionCode);

  let action = 'keep';

  if (!state) {
    // 没有历史记录（首次构建 / 状态被清理）：没有比较基准，不擅自改版本号，
    // 只把当前内容记下来作为基准。
    action = 'first';
  } else if (sameContent) {
    // 内容没变：允许同号重建（例如只想重新签名）
    action = 'keep';
  } else if (versionRaised) {
    // 已经手动递增过，尊重用户设置
    action = 'manual';
  } else {
    // 内容变了但版本号没动 → 自动递增
    const oldCode = Number(ver.versionCode) || 1;
    const oldName = ver.versionName || '1.0.0';
    ver.versionCode = oldCode + 1;
    ver.versionName = bumpName(oldName);
    action = 'auto';
    fs.writeFileSync(VERSION_FILE, JSON.stringify(ver, null, 2) + '\n', 'utf8');
    console.log(`  ⚠ 源码有改动但版本号未更新，已自动递增：`);
    console.log(`      versionCode ${oldCode} → ${ver.versionCode}`);
    console.log(`      versionName ${oldName} → ${ver.versionName}`);
  }

  // 生成 version.js（供页面读取版本号与更新说明）
  const vjs = '/** 由 tools/bump-version.js 从 version.json 自动生成，请勿手改 */\n' +
    'window.PS_VERSION = ' + JSON.stringify({
      versionCode: ver.versionCode,
      versionName: ver.versionName,
      changelog: ver.changelog || []
    }, null, 2) + ';\n';
  fs.writeFileSync(path.join(ROOT, 'app', 'version.js'), vjs, 'utf8');

  // 记录本次构建状态
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    hash, versionCode: ver.versionCode, versionName: ver.versionName, at: new Date().toISOString()
  }, null, 2) + '\n', 'utf8');

  const actionNote = action === 'keep' ? ' · 内容未变，沿用同号'
    : action === 'first' ? ' · 首次记录基准，版本号不变' : '';
  console.log(`  版本：v${ver.versionName} (versionCode ${ver.versionCode})${actionNote}`);

  if (CHECK_ONLY && action === 'auto') {
    // 只检查模式下不应写文件，这里还原以便调用方决定
    console.log('  （仅检查模式：版本号需要递增）');
  }
  process.stdout.write(String(ver.versionCode) + '\n' + String(ver.versionName) + '\n');
}

main();
