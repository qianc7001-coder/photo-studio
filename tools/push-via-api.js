#!/usr/bin/env node
/* =============================================================================
 * 用 GitHub REST API 推送一个提交（不用 git push）
 *
 * 为什么需要它：
 *   本环境 github.com 的 HTTPS 时通时断（SNI 层拦截），但 api.github.com 稳定可用。
 *   网络不通时 git push 会失败，而 REST API 仍然能推。
 *
 * 做法（Git Data API）：
 *   1. 读远程分支当前 commit
 *   2. `git diff 远程..本地` 算出改动文件
 *   3. 逐个建 blob → 建 tree → 建 commit → 更新分支引用
 *
 * 关键点：必须比对**提交**而不是工作区 —— 本地已经 commit 过、工作区是干净的，
 * 只看工作区会误判为「无需推送」。
 *
 * 安全约定：
 *   - Token 只从环境变量 GH_TOKEN 读取，绝不写入文件
 *   - 日志不打印 Token
 *   - 只推送 git 已跟踪的改动，密钥与构建产物天然被排除
 *
 * 用法：
 *   GH_TOKEN=xxx node tools/push-via-api.js              # 推送本地 HEAD 到远程
 *   GH_TOKEN=xxx node tools/push-via-api.js --dry-run    # 只列出要推什么
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TOKEN = process.env.GH_TOKEN || '';
const REPO = process.env.REPO || 'qianc7001-coder/photo-studio';
const BRANCH = process.env.BRANCH || 'main';
const API = 'https://api.github.com';
const DRY = process.argv.includes('--dry-run');

if (!TOKEN && !DRY) {
  console.error('✗ 缺少 GH_TOKEN 环境变量');
  console.error('  用法：GH_TOKEN=你的token node tools/push-via-api.js');
  process.exit(1);
}

const git = (args) => execFileSync('git', args, {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
});

function api(method, url, body) {
  const a = ['-s', '-X', method,
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'Accept: application/vnd.github+json'];
  if (body !== undefined) {
    a.push('-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(body));
  }
  a.push(url);
  const out = execFileSync('curl', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try { return JSON.parse(out); } catch (e) { return { __raw: out }; }
}

/**
 * 列出「要推送的改动文件」。
 *
 * 基准点的选择很关键：
 *   远程的 commit 可能是通过 API 建的（不在本地对象库里），
 *   直接 `git diff <远程sha> HEAD` 会报 "bad object"。
 *   所以优先用本地记录的上次同步点（.git/ps-last-push），
 *   没有就退回远程 sha，再不行就用「相对 HEAD~1」。
 * 用 -z 输出以 NUL 分隔，避免中文文件名被转义成八进制（踩过的坑）。
 */
function diffBase(remoteSha) {
  const marker = path.join(ROOT, '.git', 'ps-last-push');
  try {
    const saved = fs.readFileSync(marker, 'utf8').trim();
    if (saved) {
      try { git(['cat-file', '-e', saved + '^{commit}']); return saved; } catch (e) { /* 本地没有 */ }
    }
  } catch (e) { /* 首次推送 */ }
  try { git(['cat-file', '-e', remoteSha + '^{commit}']); return remoteSha; } catch (e) { /* 不在本地 */ }
  try { return git(['rev-parse', 'HEAD~1']).trim(); } catch (e) { return null; }
}

/** 记下这次同步到哪，供下次 diff 用 */
function saveSyncPoint(sha) {
  try { fs.writeFileSync(path.join(ROOT, '.git', 'ps-last-push'), sha + '\n'); } catch (e) { /* 忽略 */ }
}

function changedFiles(base) {
  if (!base) return [];
  const out = git(['diff', '--name-status', '-z', base, 'HEAD']);
  const parts = out.split('\0').filter((x) => x !== '');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i];
    if (!/^[A-Z]/.test(st)) continue;         // 状态码行（A/M/D/R…）
    const file = parts[i + 1];
    if (file === undefined) continue;
    i++;
    files.push({ file, deleted: st === 'D' });
  }
  return files;
}

/** 含 NUL 或大量不可打印字节 → 按二进制处理（base64） */
function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  if (!n) return false;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) bad++;
  }
  return bad / n > 0.3;
}

function main() {
  // 1) 远程分支当前 commit
  const ref = api('GET', `${API}/repos/${REPO}/git/ref/heads/${BRANCH}`);
  if (!ref || !ref.object) {
    console.error('✗ 读不到分支引用：' + ((ref && (ref.message || ref.__raw)) || '未知'));
    process.exit(1);
  }
  const remoteSha = ref.object.sha;

  // 2) 算出要推送的改动（基准点见 diffBase 的说明）
  const base = diffBase(remoteSha);
  const files = changedFiles(base);
  if (!files.length) {
    console.log('本地与远程一致，无需推送（远程 ' + remoteSha.slice(0, 7) + '）');
    return;
  }
  console.log(`基准 ${base ? base.slice(0, 7) : '(无)'} → 本地 HEAD，改动 ${files.length} 个文件：`);
  for (const f of files) console.log('  ' + (f.deleted ? '删除 ' : '修改 ') + f.file);
  if (DRY) { console.log('\n[预览] 未实际推送'); return; }

  const head = api('GET', `${API}/repos/${REPO}/git/commits/${remoteSha}`);
  const baseTree = head.tree.sha;

  // 3) 逐个建 blob
  const tree = [];
  for (const f of files) {
    if (f.deleted) {
      tree.push({ path: f.file, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const abs = path.join(ROOT, f.file);
    if (!fs.existsSync(abs)) continue;
    const buf = fs.readFileSync(abs);
    const bin = isBinary(buf);
    const blob = api('POST', `${API}/repos/${REPO}/git/blobs`, {
      content: bin ? buf.toString('base64') : buf.toString('utf8'),
      encoding: bin ? 'base64' : 'utf-8'
    });
    if (!blob || !blob.sha) {
      console.error(`✗ 创建 blob 失败（${f.file}）：` + ((blob && (blob.message || blob.__raw)) || '未知'));
      process.exit(1);
    }
    tree.push({ path: f.file, mode: '100644', type: 'blob', sha: blob.sha });
    console.log(`  blob ✓ ${f.file}`);
  }

  // 4) 建 tree（基于远程最新 tree，保证不丢别人的提交）
  const newTree = api('POST', `${API}/repos/${REPO}/git/trees`, { base_tree: baseTree, tree });
  if (!newTree || !newTree.sha) {
    console.error('✗ 创建 tree 失败：' + ((newTree && (newTree.message || newTree.__raw)) || '未知'));
    process.exit(1);
  }

  // 5) 建 commit（提交信息用本地 HEAD，保持与 git 历史一致）
  const msg = git(['log', '-1', '--pretty=%B']).trim();
  const commit = api('POST', `${API}/repos/${REPO}/git/commits`, {
    message: msg, tree: newTree.sha, parents: [remoteSha]
  });
  if (!commit || !commit.sha) {
    console.error('✗ 创建 commit 失败：' + ((commit && (commit.message || commit.__raw)) || '未知'));
    process.exit(1);
  }

  // 6) 更新分支（force:false，非快进会被拒，避免覆盖远程别人的提交）
  const upd = api('PATCH', `${API}/repos/${REPO}/git/refs/heads/${BRANCH}`, {
    sha: commit.sha, force: false
  });
  if (!upd || !upd.object) {
    console.error('✗ 更新分支失败：' + ((upd && (upd.message || upd.__raw)) || '未知'));
    process.exit(1);
  }
  saveSyncPoint(commit.sha);
  console.log('');
  console.log('✓ 已推送 ' + commit.sha.slice(0, 7) + ' → ' + BRANCH);
  console.log('  ' + msg.split('\n')[0]);
}

main();
