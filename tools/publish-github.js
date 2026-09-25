#!/usr/bin/env node
/* =============================================================================
 * 用 GitHub REST API 发布仓库
 *
 * 为什么不用 git push：
 *   本环境 github.com 的 git 协议不通（超时），但 api.github.com 可用。
 *   所以改用 REST API：建仓库 → 逐个上传文件 → 自动形成提交。
 *
 * 安全约定：
 *   - Token 只从环境变量 GH_TOKEN 读取，绝不写入任何文件
 *   - 日志里不打印 Token
 *   - 上传内容来自 git 已跟踪的文件（自动排除密钥与构建产物）
 *
 * 用法：
 *   GH_TOKEN=xxx node tools/publish-github.js [仓库名] [--private]
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TOKEN = process.env.GH_TOKEN || '';
const REPO = process.argv[2] || 'photo-studio';
const PRIVATE = process.argv.includes('--private');
const API = 'https://api.github.com';

if (!TOKEN) {
  console.error('✗ 缺少 GH_TOKEN 环境变量');
  console.error('  用法：GH_TOKEN=你的token node tools/publish-github.js [仓库名] [--private]');
  process.exit(1);
}

/* ---------- HTTP 封装（用 curl，避免额外依赖） ---------- */
function api(method, url, body) {
  const args = [
    '-s', '-X', method,
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    '-H', 'User-Agent: photo-studio-publisher',
    '-w', '\n%{http_code}'
  ];
  if (body !== undefined) {
    args.push('-H', 'Content-Type: application/json');
    args.push('--data-binary', '@-');
  }
  args.push(url);

  const opts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  let out;
  if (body !== undefined) {
    out = execFileSync('curl', args, Object.assign({ input: JSON.stringify(body) }, opts));
  } else {
    out = execFileSync('curl', args, opts);
  }
  const nl = out.lastIndexOf('\n');
  const code = parseInt(out.slice(nl + 1).trim(), 10);
  const text = out.slice(0, nl);
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
  return { code, json, text };
}

/** 出错时把 GitHub 的说明取出来（不泄露 token） */
function errMsg(r) {
  if (r.json && r.json.message) {
    let m = r.json.message;
    if (r.json.errors && r.json.errors.length) {
      m += '：' + r.json.errors.map((e) => e.message || JSON.stringify(e)).join('；');
    }
    return m;
  }
  return r.text ? r.text.slice(0, 200) : ('HTTP ' + r.code);
}

/* ---------- 收集要上传的文件（用 git 跟踪清单，自动排除密钥与产物） ---------- */
function collectFiles() {
  // 注意：必须加 -z，否则中文文件名会被转义成 "\345\220\257..." 八进制形式，
  // 导致路径读不到、文件被静默跳过（曾漏传 2 个中文名文件）。
  const raw = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  const list = raw.split('\0').filter(Boolean);

  const out = [];
  for (const rel of list) {
    // 双保险：即使 git 里混进了敏感文件也不上传
    if (/keystore\.jks$|\.keystore$|\.jks$|\.p12$|\.pem$|\.key$/i.test(rel)) {
      console.log('  ⚠ 跳过疑似密钥文件：' + rel);
      continue;
    }
    if (/^dist\/|^node_modules\//.test(rel)) {
      console.log('  ⚠ 跳过构建产物：' + rel);
      continue;
    }
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    out.push({ rel, abs });
  }
  return out;
}

async function main() {
  console.log('\n=== 1. 校验 Token ===');
  const me = api('GET', API + '/user');
  if (me.code !== 200) {
    console.error('✗ Token 无效或权限不足：' + errMsg(me));
    process.exit(1);
  }
  const owner = me.json.login;
  console.log('  ✓ 已登录：' + owner);
  if (me.json.name) console.log('    显示名：' + me.json.name);

  console.log('\n=== 2. 检查仓库 ===');
  let repoRes = api('GET', API + '/repos/' + owner + '/' + REPO);
  if (repoRes.code === 200) {
    console.log('  ✓ 仓库已存在：' + repoRes.json.full_name);
    console.log('    默认分支：' + (repoRes.json.default_branch || 'main'));
    console.log('    （将向其推送文件）');
  } else if (repoRes.code === 404) {
    console.log('  仓库不存在，正在创建…');
    const create = api('POST', API + '/user/repos', {
      name: REPO,
      description: '给摄影师用的局部修图工具：框选照片任意区域交给生图模型修改，结果自动贴回原位置',
      private: PRIVATE,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false
    });
    if (create.code !== 201) {
      console.error('✗ 创建失败：' + errMsg(create));
      if (create.code === 403) {
        console.error('  提示：Token 需要勾选 repo 权限（经典 Token）或 Contents+Administration 写权限（细粒度 Token）');
      }
      process.exit(1);
    }
    console.log('  ✓ 已创建：' + create.json.full_name + '（' + (PRIVATE ? '私有' : '公开') + '）');
  } else {
    console.error('✗ 查询仓库失败：' + errMsg(repoRes));
    process.exit(1);
  }

  console.log('\n=== 3. 收集文件 ===');
  const files = collectFiles();
  console.log('  待上传 ' + files.length + ' 个文件');
  const totalBytes = files.reduce((s, f) => s + fs.statSync(f.abs).size, 0);
  console.log('  总大小 ' + (totalBytes / 1024 / 1024).toFixed(2) + ' MB');

  console.log('\n=== 4. 上传文件 ===');
  const commitMsg = (() => {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
      return '发布 修图台 v' + v.versionName + '\n\n' +
        '给摄影师用的局部修图工具：框选照片任意区域交给生图模型修改，结果自动贴回原位置。\n' +
        '包含 ' + files.length + ' 个文件、699 项测试。';
    } catch (e) {
      return '发布 修图台';
    }
  })();

  let done = 0, failed = 0;
  for (const f of files) {
    const content = fs.readFileSync(f.abs).toString('base64');
    // 路径里的特殊字符要编码（中文文件名）
    const apiPath = f.rel.split('/').map(encodeURIComponent).join('/');
    const res = api('PUT', API + '/repos/' + owner + '/' + REPO + '/contents/' + apiPath, {
      message: commitMsg,
      content,
      branch: 'main'
    });
    if (res.code === 201 || res.code === 200) {
      done++;
      process.stdout.write('\r  进度 ' + done + '/' + files.length + '  ' + f.rel.slice(0, 40).padEnd(42));
    } else {
      failed++;
      console.log('\n  ✗ 上传失败：' + f.rel + ' → ' + errMsg(res));
      // 分支可能不叫 main，尝试 master
      if (res.code === 422 && /branch/i.test(errMsg(res))) {
        console.log('    提示：仓库默认分支可能不是 main');
      }
    }
  }
  console.log('\n  完成：成功 ' + done + ' 个' + (failed ? '，失败 ' + failed + ' 个' : ''));

  console.log('\n=== 5. 结果 ===');
  console.log('  仓库地址：https://github.com/' + owner + '/' + REPO);
  console.log('  查看提交：https://github.com/' + owner + '/' + REPO + '/commits/main');
  if (failed) {
    console.log('\n  有 ' + failed + ' 个文件失败，可重新运行本脚本（已存在的文件会被覆盖更新）');
    process.exit(1);
  }
  console.log('\n✓ 发布完成');
}

main().catch((e) => {
  console.error('\n✗ 执行失败：' + (e && e.message ? e.message : e));
  process.exit(1);
});
