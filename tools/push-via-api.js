#!/usr/bin/env node
/* =============================================================================
 * 用 GitHub REST API 推送一个提交（不用 git push）
 *
 * 为什么需要它：
 *   本环境 github.com 的 HTTPS 时通时断（SNI 层拦截），但 api.github.com 稳定可用。
 *   网络不通时 git push 会失败，而 REST API 仍然能推。
 *
 * 做法（Git Data API）：
 *   1. 读远程分支当前 commit，拉它的 tree
 *   2. **逐文件比对内容**（远程 blob sha vs 本地 blob sha），算出还差哪些
 *   3. 建 blob → 建 tree → 建 commit → 更新分支引用
 *   4. 再比一次复核，确认真的推上去了
 *
 * 为什么比对内容而不是 `git diff <基准> HEAD`：
 *   基准点一旦记错（某次推送中途失败、但同步点已前进），就会漏推文件，
 *   而且脚本会**报成功**。这个坑真实踩过：更新功能的提交没推上去，
 *   后续推送只补了几个工具文件，远程 app.js 一直是旧版。
 *   直接比内容则无论中间失败多少次都能收敛到一致。
 *
 * 安全约定：
 *   - Token 只从环境变量 GH_TOKEN 读取，绝不写入文件
 *   - body 走 stdin（不放命令行参数：有长度上限，且失败时 argv 含 token
 *     会被 Node 挂到错误对象上，一旦打印就泄漏）
 *   - 自己捕获 curl 异常并脱敏，只报「哪一步失败」
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

/**
 * 调 GitHub API。
 *
 * 两个必须注意的点：
 *   1. **body 走 stdin**（`--data-binary @-`），不放命令行参数 ——
 *      app.js 有 190KB，塞进 argv 会超限直接失败。
 *   2. **绝不把 argv 打进日志**：argv 里含 Authorization 头。
 *      Node 的 execFileSync 失败时会把整个 args 数组挂在错误对象上，
 *      一旦被 console 打出来 token 就泄漏了（真实踩过）。
 */
function api(method, url, body) {
  const a = ['-s', '-X', method,
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'Accept: application/vnd.github+json'];
  if (body !== undefined) {
    a.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  }
  a.push(url);
  const opts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  if (body !== undefined) opts.input = JSON.stringify(body);
  let out;
  try {
    out = execFileSync('curl', a, opts);
  } catch (e) {
    return { __error: 'curl 调用失败（' + method + ' ' + safeUrl(url) + '）' };
  }
  try { return JSON.parse(out); } catch (e) { return { __raw: out }; }
}

/** 去掉查询串，避免日志噪声 */
function safeUrl(u) {
  const i = String(u).indexOf('?');
  return i > 0 ? String(u).slice(0, i) + '?…' : String(u);
}

/**
 * 比对远程 tree 与本地 HEAD，列出内容不一致的文件。
 * 用 -z 输出以 NUL 分隔，避免中文文件名被转义成八进制（踩过的坑）。
 */
function changedFiles(remoteTree) {
  const remote = new Map();
  for (const t of (remoteTree && remoteTree.tree) || []) {
    if (t.type === 'blob') remote.set(t.path, t.sha);
  }

  const out = git(['ls-tree', '-r', '-z', 'HEAD']);
  const files = [];
  const localSet = new Set();
  for (const line of out.split('\0')) {
    if (!line) continue;
    const m = /^\d+ blob ([0-9a-f]+)\t(.*)$/.exec(line);
    if (!m) continue;
    const sha = m[1], file = m[2];
    localSet.add(file);
    if (remote.get(file) !== sha) files.push({ file, deleted: false });
  }
  // 远程有、本地没有 → 需要删除（保持一致）
  for (const p of remote.keys()) {
    if (!localSet.has(p)) files.push({ file: p, deleted: true });
  }
  return files;
}

/** 含 NUL 或大量不可打印字节 → 按二进制处理（base64） */
/**
 * 带重试的 API 调用。
 *
 * 为什么必须重试：GitHub 会间歇性返回 `We received a malformed request from your client`
 * —— 同样的请求体重发一次就成功（本项目实测：同一份 app/app.js 第一次失败、第二次通过）。
 * 大文件更容易触发（body 越大越可能被截断/分片出错）。
 * 没有重试的话，一次偶发失败就会让整个推送中断在半路。
 */
function apiRetry(method, url, body, tries) {
  const n = tries || 3;
  let last = null;
  for (let i = 1; i <= n; i++) {
    last = api(method, url, body);
    if (last && last.sha) return last;
    if (last && last.id) return last;
    // 明确的业务错误（如鉴权失败、路径不存在）不重试，重试也没用
    const msg = String((last && (last.message || last.__error)) || '');
    if (/Bad credentials|Not Found|Forbidden|Validation Failed/i.test(msg)) return last;
    if (i < n) {
      console.log(`    （第 ${i} 次失败，重试：${msg.slice(0, 60)}）`);
      // 简单的线性退避：等一会儿再试，避免连续撞上同一个抖动窗口
      try { execFileSync('sleep', [String(i)]); } catch (e) { /* ignore */ }
    }
  }
  return last;
}

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
    console.error('✗ 读不到分支引用：' +
      ((ref && (ref.message || ref.__error || ref.__raw)) || '未知'));
    process.exit(1);
  }
  const remoteSha = ref.object.sha;

  // 2) 拉远程 tree，逐文件比对内容
  const remoteCommit = api('GET', `${API}/repos/${REPO}/git/commits/${remoteSha}`);
  if (!remoteCommit || !remoteCommit.tree) {
    console.error('✗ 读不到远程 tree');
    process.exit(1);
  }
  const remoteTree = api('GET', `${API}/repos/${REPO}/git/trees/${remoteCommit.tree.sha}?recursive=1`);
  if (!remoteTree || !remoteTree.tree) {
    console.error('✗ 拉取远程 tree 失败：' +
      ((remoteTree && (remoteTree.message || remoteTree.__error)) || '未知'));
    process.exit(1);
  }

  const files = changedFiles(remoteTree);
  if (!files.length) {
    console.log('本地与远程内容一致，无需推送（远程 ' + remoteSha.slice(0, 7) + '）');
    return;
  }
  console.log(`远程 ${remoteSha.slice(0, 7)} → 本地 HEAD，有 ${files.length} 个文件内容不一致：`);
  for (const f of files) console.log('  ' + (f.deleted ? '删除 ' : '更新 ') + f.file);
  if (DRY) { console.log('\n[预览] 未实际推送'); return; }

  const baseTree = remoteCommit.tree.sha;

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
    const blob = apiRetry('POST', `${API}/repos/${REPO}/git/blobs`, {
      content: bin ? buf.toString('base64') : buf.toString('utf8'),
      encoding: bin ? 'base64' : 'utf-8'
    });
    if (!blob || !blob.sha) {
      console.error(`✗ 创建 blob 失败（${f.file}）：` +
        ((blob && (blob.message || blob.__error || blob.__raw)) || '未知'));
      process.exit(1);
    }
    tree.push({ path: f.file, mode: '100644', type: 'blob', sha: blob.sha });
    console.log(`  blob ✓ ${f.file}`);
  }

  // 4) 建 tree（基于远程最新 tree，保证不丢别人的提交）
  const newTree = apiRetry('POST', `${API}/repos/${REPO}/git/trees`, { base_tree: baseTree, tree });
  if (!newTree || !newTree.sha) {
    console.error('✗ 创建 tree 失败：' +
      ((newTree && (newTree.message || newTree.__error)) || '未知'));
    process.exit(1);
  }

  // 5) 建 commit（提交信息用本地 HEAD，与 git 历史一致）
  const msg = git(['log', '-1', '--pretty=%B']).trim();
  const commit = apiRetry('POST', `${API}/repos/${REPO}/git/commits`, {
    message: msg, tree: newTree.sha, parents: [remoteSha]
  });
  if (!commit || !commit.sha) {
    console.error('✗ 创建 commit 失败：' +
      ((commit && (commit.message || commit.__error)) || '未知'));
    process.exit(1);
  }

  // 6) 更新分支（force:false，非快进会被拒，避免覆盖远程别人的提交）
  const upd = api('PATCH', `${API}/repos/${REPO}/git/refs/heads/${BRANCH}`, {
    sha: commit.sha, force: false
  });
  if (!upd || !upd.object) {
    console.error('✗ 更新分支失败：' +
      ((upd && (upd.message || upd.__error)) || '未知'));
    process.exit(1);
  }

  console.log('');
  console.log('✓ 已推送 ' + commit.sha.slice(0, 7) + ' → ' + BRANCH);
  console.log('  ' + msg.split('\n')[0]);

  // 7) 复核：再比一次，确认真的推上去了
  const verifyTree = api('GET', `${API}/repos/${REPO}/git/trees/${newTree.sha}?recursive=1`);
  const still = changedFiles(verifyTree);
  if (still.length) {
    console.error('⚠ 推送后仍有 ' + still.length + ' 个文件不一致：' +
      still.map((x) => x.file).join(', '));
    process.exit(1);
  }
  console.log('  ✓ 复核通过：远程内容与本地 HEAD 一致');
}

main();
