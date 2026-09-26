#!/usr/bin/env node
/* =============================================================================
 * 发布当前版本到 GitHub Release
 *
 * 与 publish-archive.js 的分工：
 *   publish-archive.js  —— 补发历史版本（**不**设为 latest）
 *   publish-release.js  —— 发布当前版本（**要**设为 latest）
 *
 * 为什么要专门处理 latest：
 *   GitHub 默认把「创建时间最新」的 release 当作 latest。补发历史版本时，
 *   那些旧版本的时间戳会变成最新，导致 /releases/latest 指向旧版本 ——
 *   用户点 GitHub 上的「最新版」反而下到更老的包。本项目真实踩过这个坑
 *   （补发 v1.8.0~v2.2.0 后，latest 变成了 v2.2.0）。
 *   所以发布当前版本时必须显式声明 make_latest。
 *
 * 用法：
 *   GH_TOKEN=xxx node tools/publish-release.js            # 发布 version.json 里的版本
 *   GH_TOKEN=xxx node tools/publish-release.js --dry-run
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TOKEN = process.env.GH_TOKEN || '';
const REPO = process.env.REPO || 'qianc7001-coder/photo-studio';
const API = 'https://api.github.com';
const DRY = process.argv.includes('--dry-run');

if (!TOKEN && !DRY) {
  console.error('✗ 缺少 GH_TOKEN 环境变量');
  process.exit(1);
}

function api(method, url, body, extraArgs) {
  const a = ['-s', '-X', method,
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'Accept: application/vnd.github+json'];
  if (body !== undefined && body !== null) {
    // body 走 stdin：命令行参数有长度上限，且失败时 argv（含 token）
    // 会被 Node 挂到错误对象上，一旦打印就泄漏
    a.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  }
  if (extraArgs) a.push(...extraArgs);
  a.push(url);
  const opts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  if (body !== undefined && body !== null) opts.input = JSON.stringify(body);
  let out;
  try {
    out = execFileSync('curl', a, opts);
  } catch (e) {
    // 只报「哪一步失败」，绝不打印 argv（含 token）
    return { __error: 'curl 调用失败（' + method + ' ' + safeUrl(url) + '）' };
  }
  try { return JSON.parse(out); } catch (e) { return { __raw: out }; }
}

/** 去掉查询串，避免日志噪声 */
function safeUrl(u) {
  const i = String(u).indexOf('?');
  return i > 0 ? String(u).slice(0, i) + '?…' : String(u);
}

function uploadAsset(releaseId, filePath, name) {
  const url = `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
  const out = execFileSync('curl', [
    '-s', '-X', 'POST',
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'Content-Type: application/octet-stream',
    '--data-binary', '@' + filePath,
    url
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try { return JSON.parse(out); } catch (e) { return { __raw: out }; }
}

function main() {
  const vj = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
  const ver = vj.versionName;
  const tag = 'v' + ver;

  // 找 APK 与版本说明
  const dist = path.join(ROOT, 'dist');
  const files = fs.existsSync(dist) ? fs.readdirSync(dist) : [];
  const apkName = files.find((f) => f === `修图台-v${ver}.apk`) || files.find((f) => f.endsWith('.apk'));
  const apk = apkName ? path.join(dist, apkName) : null;
  const notesPath = '/sdcard/Download/修图台-版本说明.md';
  const notes = fs.existsSync(notesPath) ? notesPath : null;

  console.log(`版本：v${ver}（versionCode ${vj.versionCode}）`);
  console.log(`APK ：${apk ? path.basename(apk) : '✗ 未找到（先跑 tools/build-apk.sh）'}`);
  console.log(`说明：${notes ? path.basename(notes) : '（无）'}`);
  if (!apk) { console.error('✗ 没有 APK，先构建'); process.exit(1); }
  if (DRY) { console.log('\n[预览] 未实际发布'); return; }

  // 已存在则先删掉重建（保证 latest 与附件都是最新的）
  const existing = api('GET', `${API}/repos/${REPO}/releases/tags/${tag}`);
  if (existing && existing.id) {
    console.log(`\n  已存在 ${tag}（id ${existing.id}），先删除再重建`);
    api('DELETE', `${API}/repos/${REPO}/releases/${existing.id}`);
  }

  // 建 release，并**显式声明它是 latest**
  const body = ['## 修图台 v' + ver, '']
    .concat(vj.changelog.map((c) => '- ' + c)).join('\n');
  const r = api('POST', `${API}/repos/${REPO}/releases`, {
    tag_name: tag,
    target_commitish: 'main',
    name: `v${ver}`,
    body,
    draft: false,
    prerelease: false,
    make_latest: 'true'
  });
  if (!r || !r.id) {
    console.error('✗ 创建失败：' + ((r && (r.message || r.__raw)) || '未知'));
    process.exit(1);
  }
  console.log(`  ✓ Release 已创建（id ${r.id}），并标为 latest`);

  // 附件用 ASCII 名（GitHub 对中文名支持不好）
  const up = uploadAsset(r.id, apk, `photo-studio-v${ver}.apk`);
  if (up && up.name) console.log(`  ✓ APK ${(up.size / 1024).toFixed(0)} KB`);
  else console.log(`  ✗ APK 上传失败：${(up && (up.message || up.__raw)) || '未知'}`);

  if (notes) {
    const un = uploadAsset(r.id, notes, `RELEASE-NOTES-v${ver}.md`);
    if (un && un.name) console.log('  ✓ 版本说明已上传');
  }

  // 复核：/releases/latest 必须指向刚发的版本
  const check = api('GET', `${API}/repos/${REPO}/releases/latest`);
  const ok = check && check.tag_name === tag;
  console.log('');
  console.log(ok
    ? `✓ /releases/latest 指向 ${tag}（正确）`
    : `⚠ /releases/latest 指向 ${check && check.tag_name}（应为 ${tag}）`);
  if (!ok) process.exit(1);
}

main();
