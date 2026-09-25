#!/usr/bin/env node
/* =============================================================================
 * 幂等插入测试块
 *
 * 背景：用 Python 的 str.replace 做插入时，如果脚本被重复执行（或 pattern 匹配多次），
 * 同一段测试会被插入多次，导致变量重复声明、测试跑不通。
 * 这个脚本保证「同名块只存在一份」。
 *
 * 用法：node tools/insert-block.js <目标文件> <块标记> <锚点> <块文件>
 * ========================================================================== */
'use strict';
const fs = require('fs');

const [, , target, marker, anchorText, blockFile] = process.argv;
if (!target || !marker || !anchorText || !blockFile) {
  console.error('用法: node tools/insert-block.js <目标> <标记> <锚点> <块文件>');
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');
const block = fs.readFileSync(blockFile, 'utf8');

// 1) 先移除已存在的同名块（从标记行到下一个分隔注释）
const lines = src.split('\n');
let removed = 0;
for (;;) {
  const start = lines.findIndex((l) => l.includes(marker));
  if (start < 0) break;
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (lines[j].trim().startsWith('/* ----------')) { end = j; break; }
  }
  lines.splice(start, end - start);
  removed++;
}
src = lines.join('\n');
if (removed) console.log('移除已存在的同名块:', removed, '份');

// 2) 插入到锚点之前
if (!src.includes(anchorText)) {
  console.error('✗ 找不到锚点:', anchorText.slice(0, 40));
  process.exit(1);
}
src = src.replace(anchorText, block + '\n' + anchorText);
fs.writeFileSync(target, src);
console.log('✓ 已插入块:', marker);
