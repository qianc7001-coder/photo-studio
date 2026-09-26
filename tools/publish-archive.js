#!/usr/bin/env node
/* =============================================================================
 * 把历史版本归档发布到 GitHub Release
 *
 * 为什么需要这个脚本：
 *   开发过程中每个版本都在本地留了归档（源码 + APK + 版本说明），
 *   但早期版本漏发了 Release —— 用户下载历史版本时会发现缺号。
 *   这个脚本把「归档目录」直接变成「Release」，可重复执行（幂等）。
 *
 * 用法：
 *   GH_TOKEN=xxx node tools/publish-archive.js                 # 补齐所有缺失的版本
 *   GH_TOKEN=xxx node tools/publish-archive.js v1.8.0          # 只发指定版本
 *   GH_TOKEN=xxx node tools/publish-archive.js --dry-run       # 只报告，不改动
 *
 * 安全约定：
 *   - Token 只从环境变量读取，绝不写入文件
 *   - 只上传 .apk 与版本说明，源码不进 Release（源码在 git 里）
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOKEN = process.env.GH_TOKEN || '';
const ARCHIVE = process.env.ARCHIVE_DIR || path.join(__dirname, '..', '..', 'photo-studio-archive');
const REPO = process.env.REPO || 'qianc7001-coder/photo-studio';
const API = 'https://api.github.com';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const only = args.filter((a) => /^v\d/.test(a));

if (!TOKEN && !DRY) {
  console.error('✗ 缺少 GH_TOKEN 环境变量');
  process.exit(1);
}

/* ---------- HTTP（用 curl，避免额外依赖） ---------- */
function api(method, url, body, extraArgs) {
  const a = ['-s', '-X', method,
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'Accept: application/vnd.github+json'];
  if (body !== undefined && body !== null) {
    a.push('-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(body));
  }
  if (extraArgs) a.push(...extraArgs);
  a.push(url);
  const out = execFileSync('curl', a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  try { return JSON.parse(out); } catch (e) { return { __raw: out }; }
}

/** 上传附件（二进制，必须走 uploads.github.com） */
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

/* ---------- 读取归档 ---------- */
function readArchive(dir) {
  const ver = path.join(ARCHIVE, dir, 'version.json');
  if (!fs.existsSync(ver)) return null;
  let vj;
  try { vj = JSON.parse(fs.readFileSync(ver, 'utf8')); } catch (e) { return null; }
  if (!vj.versionName) return null;

  // APK：优先精确命名，其次任意 .apk
  const files = fs.readdirSync(path.join(ARCHIVE, dir));
  const apkName = files.find((f) => f === `修图台-v${vj.versionName}.apk`)
    || files.find((f) => f.endsWith('.apk'));
  const notesName = files.find((f) => /版本说明|RELEASE-NOTES/i.test(f) && f.endsWith('.md'));

  return {
    dir,
    versionCode: vj.versionCode,
    versionName: vj.versionName,
    tag: 'v' + vj.versionName,
    changelog: Array.isArray(vj.changelog) ? vj.changelog : [],
    apk: apkName ? path.join(ARCHIVE, dir, apkName) : null,
    notes: notesName ? path.join(ARCHIVE, dir, notesName) : null
  };
}

/** 从 changelog 里提炼一个简短标题（Release 名用） */
function titleOf(rel) {
  const first = String(rel.changelog[0] || '').trim();
  // 去掉「新增：」「修复：」「关闭：」这类前缀
  let cleaned = first.replace(/^(重大更新|新增|修复|优化|兼容|关闭|调整)[：:]\s*/, '');
  // 截到第一个停顿符（逗号/句号/分号/破折号/冒号），避免标题被截在半句
  cleaned = cleaned.split(/[，。；—：]/)[0].trim();
  // 还是太长就再截一次（中文 16 字足够表达主题）
  let brief = cleaned.slice(0, 16);
  // 如果截断处正好在括号/引号中间，去掉不配对的尾巴
  brief = brief.replace(/[（(\[【「『][^）)\]】」』]*$/, '').trim();
  return brief ? `v${rel.versionName} · ${brief}` : `v${rel.versionName}`;
}

function bodyOf(rel) {
  const lines = [];
  lines.push(`## 修图台 v${rel.versionName}（versionCode ${rel.versionCode}）`);
  lines.push('');
  lines.push('> 这是历史版本，建议使用最新版：https://github.com/' + REPO + '/releases/latest');
  lines.push('');
  for (const c of rel.changelog) lines.push('- ' + c);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('**安装说明**：下载 APK 后直接安装。覆盖安装即可保留 API 设置与修图记录。');
  return lines.join('\n');
}

/* ---------- 主流程 ---------- */
function main() {
  if (!fs.existsSync(ARCHIVE)) {
    console.error('✗ 找不到归档目录：' + ARCHIVE);
    process.exit(1);
  }
  let dirs = fs.readdirSync(ARCHIVE).filter((d) => /^v\d/.test(d)).sort(byVersion);
  if (only.length) dirs = dirs.filter((d) => only.includes(d));

  const rels = dirs.map(readArchive).filter(Boolean);
  console.log(`归档目录：${ARCHIVE}`);
  console.log(`共 ${rels.length} 个版本待检查\n`);

  // 拉取已存在的 tag（dry-run 也要查，否则「待建」数字不准）
  const existing = new Set();
  if (TOKEN) {
    const list = api('GET', `${API}/repos/${REPO}/releases?per_page=100`);
    if (Array.isArray(list)) {
      list.forEach((r) => existing.add(r.tag_name));
    } else {
      console.log('  （无法读取已有 Release，将按「全部缺失」处理）');
    }
  }

  let created = 0, skipped = 0, failed = 0;
  for (const rel of rels) {
    const has = existing.has(rel.tag);
    if (has) {
      console.log(`  已有  ${rel.tag.padEnd(8)} 跳过`);
      skipped++;
      continue;
    }
    if (DRY) {
      console.log(`  待建  ${rel.tag.padEnd(8)} ${titleOf(rel)}`);
      if (rel.apk) console.log(`         APK: ${path.basename(rel.apk)}`);
      created++;
      continue;
    }
    if (!rel.apk) {
      console.log(`  ✗ ${rel.tag} 归档里没有 APK，跳过`);
      failed++;
      continue;
    }

    // 建 Release
    const r = api('POST', `${API}/repos/${REPO}/releases`, {
      tag_name: rel.tag,
      target_commitish: 'main',
      name: titleOf(rel),
      body: bodyOf(rel),
      draft: false,
      prerelease: false
    });
    if (!r || !r.id) {
      console.log(`  ✗ ${rel.tag} 创建失败：${(r && (r.message || r.__raw)) || '未知错误'}`);
      failed++;
      continue;
    }
    console.log(`  ✓ ${rel.tag.padEnd(8)} 已创建`);

    // 上传附件（GitHub 对非 ASCII 文件名支持不好，用 ASCII 名）
    const apkAscii = `photo-studio-v${rel.versionName}.apk`;
    const up = uploadAsset(r.id, rel.apk, apkAscii);
    if (up && up.name) {
      console.log(`         APK ${(up.size / 1024).toFixed(0)} KB`);
    } else {
      console.log(`         ✗ APK 上传失败：${(up && (up.message || up.__raw)) || '未知'}`);
    }
    if (rel.notes) {
      const un = uploadAsset(r.id, rel.notes, `RELEASE-NOTES-v${rel.versionName}.md`);
      if (un && un.name) console.log(`         版本说明已上传`);
    }
    created++;
  }

  console.log('');
  console.log(DRY
    ? `[预览] 待创建 ${created} 个，已存在 ${skipped} 个`
    : `完成：新建 ${created} 个，跳过 ${skipped} 个，失败 ${failed} 个`);
  if (failed) process.exit(1);
}

/** 版本号排序：v1.8.0 < v2.10.0（按数字段比较，不能按字符串） */
function byVersion(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

main();
