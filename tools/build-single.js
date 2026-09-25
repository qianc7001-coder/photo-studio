#!/usr/bin/env node
/* 把 app/ 打包成单个 HTML 文件（离线可用、可直接丢进手机浏览器打开） */
'use strict';
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');

// 先确保 version.js 与 version.json 同步（单文件版也要带正确版本号）
try {
  require('child_process').execFileSync(process.execPath,
    [path.join(__dirname, 'bump-version.js')], { stdio: 'ignore' });
} catch (e) { /* 版本脚本失败不阻塞打包 */ }
const OUT = path.join(__dirname, '..', 'dist');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

let html = read('index.html');
const css = read('style.css');
const core = read('core.js');
const versionJs = read('version.js');
const app = read('app.js');
const icon = read('icon.svg');

const iconDataUrl = 'data:image/svg+xml;base64,' + Buffer.from(icon, 'utf8').toString('base64');

// 内联 CSS
// 注意：必须用「函数形式」做替换。
// 字符串形式的 replace 会把替换串里的 $& / $' / $` / $1 当成特殊标记，
// 而我们的源码里含有 '$' 这样的字符串（例如价格提示 '单价：$'），
// 其中 $' 会被解释成「匹配之后的文本」，把 </body></html> 注入进 JS 字符串，
// 导致生成的文件结构损坏。函数形式不做这种解释。
const put = (from, to) => { html = html.replace(from, () => to); };
put('<link rel="stylesheet" href="style.css">', '<style>\n' + css + '\n</style>');
// 内联图标 + manifest
put('<link rel="manifest" href="manifest.json">', '');
put('<link rel="icon" href="icon.svg" type="image/svg+xml">',
  '<link rel="icon" href="' + iconDataUrl + '" type="image/svg+xml">');
// 内联 JS（version.js 必须在最前，app.js 启动时要读它）
put('<script src="version.js"></script>', '<script>\n' + versionJs + '\n</script>');
put('<script src="core.js"></script>', '<script>\n' + core + '\n</script>');
put('<script src="app.js"></script>', '<script>\n' + app + '\n</script>');

if (/href="style\.css"|src="core\.js"|src="app\.js"|src="version\.js"/.test(html)) {
  console.error('✗ 内联失败：仍有外部引用');
  process.exit(1);
}

// 结构守卫：内联后 HTML 结构不能被破坏。
// 曾经踩过的坑：replace 的替换串里含 $'，被当成「匹配之后的文本」，
// 把 </body></html> 注入进 JS 字符串 —— 源码没问题，产物却坏了，很难查。
const bodyCount = (html.match(/<\/body>/g) || []).length;
const htmlCount = (html.match(/<\/html>/g) || []).length;
if (bodyCount !== 1 || htmlCount !== 1) {
  console.error('✗ 产物结构损坏：</body> 出现 ' + bodyCount + ' 次，</html> 出现 ' + htmlCount + ' 次（都应为 1）');
  console.error('  常见原因：replace 的替换串里含 $ 特殊标记（$& / $\' / $` / $1），请改用函数形式替换');
  process.exit(1);
}
// 逐块做语法检查，确保内联的脚本没有被打断
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
for (let i = 0; i < blocks.length; i++) {
  try {
    new Function(blocks[i][1]);
  } catch (e) {
    console.error('✗ 第 ' + (i + 1) + ' 个内联脚本语法错误：' + e.message);
    process.exit(1);
  }
}

fs.mkdirSync(OUT, { recursive: true });
const outFile = path.join(OUT, '修图台.html');
fs.writeFileSync(outFile, html, 'utf8');
console.log('✓ 单文件已生成：' + outFile);
console.log('  体积：' + (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1) + ' KB');
