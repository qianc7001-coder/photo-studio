// 用相对路径解析：本机、CI 检出目录、任意 clone 位置都能跑
const path = require('path');
const C = require(path.join(__dirname, '..', 'app', 'core.js'));
let pass=0, fail=0;
const t=(name,cond,extra)=>{ if(cond){pass++;} else {fail++; console.log('FAIL:',name, extra===undefined?'':JSON.stringify(extra));} };

// --- 几何 ---
t('rectFromPoints', JSON.stringify(C.rectFromPoints({x:10,y:20},{x:5,y:50}))==='{"x":5,"y":20,"w":5,"h":30}');
t('clampRect', JSON.stringify(C.clampRect({x:-5,y:-5,w:1000,h:1000},100,100))==='{"x":0,"y":0,"w":100,"h":100}');
t('clampRect min1', C.clampRect({x:99,y:99,w:0,h:0},100,100).w===1);
t('fitView', (()=>{const v=C.fitView(4000,3000,1000,800,0); return Math.abs(v.scale-0.25)<1e-9 && Math.abs(v.tx-0)<1e-9 && Math.abs(v.ty-25)<1e-9;})());
t('screenToImage roundtrip', (()=>{const v={scale:0.5,tx:30,ty:40};const p=C.screenToImage({x:130,y:140},v);const q=C.imageToScreen(p,v);return Math.abs(q.x-130)<1e-9&&Math.abs(q.y-140)<1e-9;})());
t('zoomAt keeps anchor', (()=>{const v={scale:1,tx:0,ty:0};const n=C.zoomAt(v,100,100,2,0.1,8);const before=C.screenToImage({x:100,y:100},v), after=C.screenToImage({x:100,y:100},n);return Math.abs(before.x-after.x)<1e-9&&Math.abs(before.y-after.y)<1e-9;})());
t('clampView centers small', (()=>{const v=C.clampView({scale:1,tx:999,ty:999},100,100,1000,1000);return v.tx===450&&v.ty===450;})());
t('clampView blocks gap large', (()=>{const v=C.clampView({scale:10,tx:500,ty:-500},100,100,1000,1000);return v.tx===0&&v.ty===-0;})());
// 手柄
t('hitTest corner', C.hitTest({x:100,y:100},{x:100,y:100,w:200,h:200},22)==='nw');
t('hitTest inside', C.hitTest({x:200,y:200},{x:100,y:100,w:200,h:200},22)==='move');
t('hitTest outside', C.hitTest({x:20,y:20},{x:100,y:100,w:200,h:200},22)===null);
t('hitTest edge n', C.hitTest({x:200,y:100},{x:100,y:100,w:200,h:200},22)==='n');
// resize
t('resize move', JSON.stringify(C.resizeRect({x:10,y:10,w:100,h:100},'move',5,7))==='{"x":15,"y":17,"w":100,"h":100}');
t('resize se', (()=>{const r=C.resizeRect({x:10,y:10,w:100,h:100},'se',20,30);return r.w===120&&r.h===130&&r.x===10&&r.y===10;})());
t('resize nw', (()=>{const r=C.resizeRect({x:10,y:10,w:100,h:100},'nw',20,30);return r.x===30&&r.y===40&&r.w===80&&r.h===70;})());
t('resize min clamp', (()=>{const r=C.resizeRect({x:10,y:10,w:100,h:100},'se',-500,-500,{min:16});return r.w===16&&r.h===16;})());
t('resize aspect', (()=>{const r=C.resizeRect({x:0,y:0,w:100,h:100},'se',100,0,{aspect:2,min:8});return Math.abs(r.w/r.h-2)<1e-6;})());

// --- 像素合成 ---
function solid(w,h,c){const p=C.makePixels(w,h);for(let i=0;i<p.data.length;i+=4){p.data[i]=c[0];p.data[i+1]=c[1];p.data[i+2]=c[2];p.data[i+3]=255;}return p;}
t('edgeDistance center', Math.abs(C.edgeDistance(5,5,10,10)-4.5)<1e-9, C.edgeDistance(5,5,10,10));
// 羽化会被夹到短边 1/3 以内（避免小选区整块被淡化），所以小图角落不再是 0，
// 这里验证「角落 <= 中心」的单调性，以及大图下能真正归零
t('featherMask 角落<=中心', C.featherMask(10,10,6)[0] <= C.featherMask(10,10,6)[2*10+2]);
t('featherMask 大图角落归零', C.featherMask(60,60,6)[0] < 0.05, C.featherMask(60,60,6)[0]);
t('featherMask monotonic', C.featherMask(60,60,6)[0] < C.featherMask(60,60,6)[30*60+30]);
t('featherMask 小图中心可全效', (()=>{const m=C.featherMask(16,16,10);let mx=0;for(const v of m)mx=Math.max(mx,v);return mx>0.99;})());
t('featherMask center 1', C.featherMask(10,10,4)[5*10+5]===1);
t('featherMask no feather', C.featherMask(10,10,0)[0]===1);
// composite: 全同色 + 羽化 -> 结果不变
(()=>{const dst=solid(40,40,[100,100,100]);const src=solid(20,20,[100,100,100]);C.compositeFeathered(dst,src,{x:10,y:10,w:20,h:20},{feather:6});let ok=true;for(let i=0;i<dst.data.length;i+=4){if(dst.data[i]!==100)ok=false;}t('composite same color',ok);})();
// composite: 中心替换为新颜色，边缘保留
(()=>{const dst=solid(40,40,[100,100,100]);const src=solid(20,20,[200,50,50]);C.compositeFeathered(dst,src,{x:10,y:10,w:20,h:20},{feather:4});const c=(x,y)=>dst.data[(y*40+x)*4];t('composite center replaced',c(20,20)===200, c(20,20));t('composite outside untouched',c(5,5)===100);t('composite edge blended',c(10,20)>100&&c(10,20)<200, c(10,20));})();
// 色彩匹配：patch 全灰 200，周围 100 -> 边缘被拉向 100
(()=>{const dst=solid(60,60,[100,100,100]);const src=solid(20,20,[200,200,200]);const st=C.compositeFeathered(dst,src,{x:20,y:20,w:20,h:20},{feather:2,colorMatch:{ring:6,ramp:8,strength:1}});const edge=dst.data[((30)*60+20)*4];const center=dst.data[(30*60+30)*4];t('colorMatch delta computed', Math.abs(st.delta[0]+100)<1e-6, st.delta);t('colorMatch edge pulled', edge<160&&edge>100, edge);t('colorMatch center closer to src', center>edge, [edge,center]);})();
// 掩膜合成
(()=>{const dst=solid(20,20,[10,10,10]);const src=solid(20,20,[250,250,250]);const mask=new Float32Array(400);mask[0]=1;C.compositeFeathered(dst,src,{x:0,y:0,w:20,h:20},{mask});t('mask only at 0,0', dst.data[0]===250&&dst.data[(1*20+1)*4]===10);})();
// 打码
(()=>{const p=solid(20,20,[0,0,0]);for(let y=0;y<10;y++)for(let x=0;x<10;x++){const i=(y*20+x)*4;p.data[i]=255;}C.mosaicRegion(p,{x:0,y:0,w:10,h:10},5);const i0=p.data[0];t('mosaic uniform keeps value', i0===255, i0);
(()=>{const q=solid(20,20,[0,0,0]);for(let y=0;y<10;y++)for(let x=0;x<10;x++){const i=(y*20+x)*4;q.data[i]=200;}C.mosaicRegion(q,{x:0,y:0,w:10,h:10},10);t('mosaic block uniform', q.data[0]===200, q.data[0]);})();})();

// --- 掩膜 ---
(()=>{const m=C.strokesToMask([{mode:'erase',radius:5,points:[{x:10,y:10}]}],20,20);t('stroke erase center', m[10*20+10]===0);t('stroke erase far', m[0]===1);})();
(()=>{const m=C.strokesToMask([{mode:'restore',radius:3,points:[{x:5,y:5}]}],20,20,{initial:0});t('stroke restore', m[5*20+5]>0.5&&m[19*20+19]===0, m[5*20+5]);})();
(()=>{const m=C.strokesToMask([{mode:'erase',radius:4,points:[{x:2,y:2},{x:17,y:17}]}],20,20);t('stroke line rasterized', m[10*20+10]===0, m[10*20+10]);})();

// --- 色彩 ---
t('oklab roundtrip black', C.oklabToRgb(...Object.values(C.rgbToOklab(0,0,0))).join()==='0,0,0');
(()=>{const rgb=[123,77,201];const l=C.rgbToOklab(...rgb);const back=C.oklabToRgb(l.L,l.a,l.b);t('oklab roundtrip', back.every((v,i)=>Math.abs(v-rgb[i])<=2), back);})();
t('colorDistance self 0', C.colorDistance([10,20,30],[10,20,30])<1e-9);
t('bestTextColor white bg', C.bestTextColor([255,255,255])==='#0b0c0e');
t('bestTextColor dark bg', C.bestTextColor([10,10,10])==='#ffffff');
t('hex roundtrip', C.rgbToHex(C.hexToRgb('#3aa7ff'))==='#3aa7ff');

// --- 尺寸 ---
t('parseSize', JSON.stringify(C.parseSize('1024x768'))==='[1024,768]');
t('parseSize ×', JSON.stringify(C.parseSize('1024×768'))==='[1024,768]');
t('parseSize bad', C.parseSize('abc')===null);
t('snapTo', C.snapTo(100,16)===96);
(()=>{const r=C.resolveOutputSize(1000,1000,['1328x1328','1664x928','928x1664']);t('resolveOutputSize square', r.size==='1328x1328', r);})();
(()=>{const r=C.resolveOutputSize(1600,900,['1328x1328','1664x928','928x1664']);t('resolveOutputSize wide', r.size==='1664x928', r);})();
t('resolveAspectRatio wide', C.resolveAspectRatio(1920,1080)==='16:9');
t('resolveAspectRatio tall', C.resolveAspectRatio(1080,1920)==='9:16');
t('resolveAspectRatio square', C.resolveAspectRatio(1000,1000)==='1:1');

// --- 分块已彻底移除（早期版本会把大选区切块分别生成，重叠区内容不一致 → 接缝重影） ---
t('分块裁剪函数已移除', typeof C.planTileCrop === 'undefined');
t('分块权重函数已移除', typeof C.tileBlendWeights === 'undefined');
t('分块累加函数已移除', typeof C.accumulateTile === 'undefined');
t('分块归一化函数已移除', typeof C.resolveAccumulated === 'undefined');
t('分块提示词函数已移除', typeof C.tileHint === 'undefined');
t('估算调用次数的旧接口已移除', typeof C.estimateCalls === 'undefined');

// --- 模型 ---
t('joinUrl', C.joinUrl('https://api.siliconflow.cn/v1/','images/generations')==='https://api.siliconflow.cn/v1/images/generations');
(()=>{const r=C.buildImageRequest({baseUrl:'https://api.siliconflow.cn/v1',apiKey:'k',model:'Qwen/Qwen-Image-Edit',prompt:'p',imageDataUrl:'data:image/png;base64,AAA',size:'1328x1328',sizeMode:'image_size',imageField:'image',seed:42,batch:2});
 t('req url', r.url==='https://api.siliconflow.cn/v1/images/generations');
 t('req auth', r.headers.Authorization==='Bearer k');
 t('req body', r.body.model==='Qwen/Qwen-Image-Edit'&&r.body.image==='data:image/png;base64,AAA'&&r.body.image_size==='1328x1328'&&r.body.seed===42&&r.body.batch_size===2, r.body);})();
(()=>{const r=C.buildImageRequest({baseUrl:'https://api.siliconflow.cn/v1',model:'black-forest-labs/FLUX.1-Kontext-pro',prompt:'p',imageDataUrl:'data:image/png;base64,AAA',aspectRatio:'16:9',sizeMode:'aspect_ratio',imageField:'input_image'});
 t('kontext body', r.body.input_image&&r.body.aspect_ratio==='16:9'&&!r.body.image, r.body);})();
(()=>{const r=C.buildImageRequest({baseUrl:'https://x/v1',model:'m',prompt:'p',size:'1024x1024',sizeMode:'size'});
 t('openai size field', r.body.size==='1024x1024'&&!r.body.image_size, r.body);})();
t('parseImageResponse images', C.parseImageResponse({images:[{url:'http://a/1.png'}]})[0].url==='http://a/1.png');
t('parseImageResponse data b64', C.parseImageResponse({data:[{b64_json:'AAA'}]})[0].dataUrl==='data:image/png;base64,AAA');
t('parseImageResponse empty', C.parseImageResponse(null).length===0);
t('extractError', C.extractError({message:'bad'},400)==='bad');

// --- 提示词 ---
(()=>{const p=C.buildPrompt({instruction:'把天空换成晚霞',style:'none',scope:'region'});
 t('prompt zh region', p.includes('把天空换成晚霞')&&/中央约 \d+%/.test(p), p.slice(0,60));
 t('prompt zh keeps outside', /其余部分不要改动|只改动上面描述/.test(p), p.slice(0,80));
 t('prompt zh 不含蓝色标记', !/蓝色/.test(p));})();
(()=>{const p=C.buildPrompt({instruction:'remove the trash bin',style:'remove',scope:'region',language:'en'});
 t('prompt en', p.includes('remove the trash bin')&&/leave everything else untouched|surrounding margin/.test(p), p.slice(0,90));
 t('prompt en 不含 blue', !/blue/i.test(p));})();
(()=>{const p=C.buildPrompt({instruction:'x',style:'none',scope:'global',language:'zh'});t('prompt global', p.includes('整体调整'));})();
(()=>{const p=C.buildPrompt({instruction:'x',style:'none',hasMask:true,language:'zh'});
 // 掩膜不再用蓝色标记表达（会被模型当成画面内容导致偏色），改为描述修改范围
 t('prompt mask note 用范围描述', /中央约 \d+%/.test(p));
 t('prompt mask note 不含蓝色', !/蓝色/.test(p));})();

t('formatBytes', C.formatBytes(1536)==='1.5 KB');
t('timestampName ext', /^photo_\d{8}_\d{6}\.jpg$/.test(C.timestampName('photo','jpg')));


// ===== 历史时间线（测试块） =====
(() => {
  const L = { rect: { x: 0, y: 0, w: 10, h: 10 }, patch: {}, feather: 0, opacity: 1 };

  // 1) 空历史
  const s0 = C.createUndoStack(100);
  const t0 = C.buildTimeline(s0, { edits: [], strokes: [] });
  t('时间线至少含「原图」一格', t0.items.length === 1 && t0.items[0].kind === 'origin', t0.items.length);
  t('空历史游标在 0', t0.cursor === 0);

  // 2) 逐步累加：每一步都能算出当时的图层数
  const s1 = C.createUndoStack(100);
  s1.push(C.makeUndoCommand('add-layer', { layer: L, index: 0, label: '生成修改', time: 1000 }));
  s1.push(C.makeUndoCommand('stroke', { stroke: { points: [{ x: 1, y: 1 }] }, time: 2000 }));
  s1.push(C.makeUndoCommand('add-layer', { layer: L, index: 1, label: '再改一处', time: 3000 }));
  const t1 = C.buildTimeline(s1, { edits: [L, L], strokes: [{ points: [] }] });
  t('时间线格数 = 命令数 + 1', t1.items.length === 4, t1.items.length);
  t('第 0 格是原图', t1.items[0].kind === 'origin');
  t('第 1 格记录 1 个图层', t1.items[1].layers === 1, t1.items[1].layers);
  t('第 2 格记录 1 笔涂改', t1.items[2].strokes === 1, t1.items[2].strokes);
  t('游标指向最新', t1.cursor === 3, t1.cursor);
  t('最后一步的图层数用真实状态校准', t1.items[3].layers === 2, t1.items[3].layers);
  t('标签来自命令', t1.items[1].label === '生成修改', t1.items[1].label);
  t('时间戳带出来了', t1.items[1].time === 1000, t1.items[1].time);

  // 3) 撤销后：后面的步骤标记为「未来」，但仍在时间线上（可跳回）
  s1.undo();
  const t2 = C.buildTimeline(s1, { edits: [L], strokes: [{ points: [] }] });
  t('撤销后游标前移', t2.cursor === 2, t2.cursor);
  t('已撤销的步骤仍留在时间线上', t2.items.length === 4, t2.items.length);
  t('已撤销的步骤标记为 future', t2.items[3].undone === true);
  t('未撤销的步骤不是 future', t2.items[1].undone === false);

  // 4) 跳转计划：撤销/重做步数算对
  t('往回跳只撤销', JSON.stringify(C.planHistoryJump(3, 1, 5)) === '{"undo":2,"redo":0}');
  t('往前跳只重做', JSON.stringify(C.planHistoryJump(1, 3, 5)) === '{"undo":0,"redo":2}');
  t('原地跳不动', JSON.stringify(C.planHistoryJump(2, 2, 5)) === '{"undo":0,"redo":0}');
  t('目标越界夹取到 0', JSON.stringify(C.planHistoryJump(3, -5, 5)) === '{"undo":3,"redo":0}');
  t('目标越界夹取到末尾', JSON.stringify(C.planHistoryJump(1, 99, 5)) === '{"undo":0,"redo":4}');
  t('非法输入安全', JSON.stringify(C.planHistoryJump(null, null, null)) === '{"undo":0,"redo":0}');

  // 5) 丢弃未来（跳回后确认）
  const s2 = C.createUndoStack(100);
  s2.push(C.makeUndoCommand('add-layer', { layer: L, index: 0 }));
  s2.push(C.makeUndoCommand('add-layer', { layer: L, index: 1 }));
  s2.undo();
  t('丢弃前有未来', s2.canRedo() === true);
  const dropped = s2.dropFuture();
  t('dropFuture 返回丢弃条数', dropped === 1, dropped);
  t('丢弃后不能再重做', s2.canRedo() === false);
  t('已执行的保留', s2.size().past === 1, s2.size());

  // 6) 关键 bug 修复：内存整理丢弃最老图层后，索引必须同步前移
  //    （不修正的话，撤销会作用到错误的图层上）
  const s3 = C.createUndoStack(100);
  s3.push(C.makeUndoCommand('add-layer', { layer: L, index: 0 }));
  s3.push(C.makeUndoCommand('add-layer', { layer: L, index: 1 }));
  s3.push(C.makeUndoCommand('add-layer', { layer: L, index: 2 }));
  s3.adjustForDrop(2);        // 丢弃最老的两个图层
  const rest = s3.list().past;
  t('丢弃后剩余命令数正确', rest.length === 1, rest.length);
  t('引用了已丢弃图层的命令被移除', rest.every((c) => c.index >= 0));
  t('剩余命令索引已前移', rest[0].index === 0, rest[0].index);
  // 撤销一次后应作用在 index 0 上（而不是原来的 2）
  const back = s3.undo();
  t('撤销作用在正确的索引上', C.commandDirection(back, false).index === 0,
    C.commandDirection(back, false).index);
  t('adjustForDrop 对 0 是安全的', (() => {
    const s = C.createUndoStack(10);
    s.push(C.makeUndoCommand('add-layer', { layer: L, index: 0 }));
    s.adjustForDrop(0);
    return s.size().past === 1;
  })());
  t('adjustForDrop 不误伤无索引命令', (() => {
    const s = C.createUndoStack(10);
    s.push(C.makeUndoCommand('stroke', { stroke: { points: [] } }));
    s.adjustForDrop(1);
    return s.size().past === 1;
  })());

  // 7) 命令摘要要说人话
  t('摘要：新增图层带尺寸', /10×10/.test(C.describeCommand(C.makeUndoCommand('add-layer', { layer: L, index: 0 }))));
  t('摘要：删除带序号', /第 2 处/.test(C.describeCommand(C.makeUndoCommand('remove-layer', { index: 1 }))));
  t('摘要：羽化用像素', /px/.test(C.describeCommand(C.makeUndoCommand('param-layer', { index: 0, key: 'feather', before: 0, after: 12 }))));
  t('摘要：不透明度用百分比', /50%/.test(C.describeCommand(C.makeUndoCommand('param-layer', { index: 0, key: 'opacity', before: 1, after: 0.5 }))));
  t('摘要：未知命令不崩', C.describeCommand({ type: 'nope' }) === '');
  t('摘要：空输入不崩', C.describeCommand(null) === '');

  // 8) 时间戳：命令自带时间，且可被 payload 覆盖（便于测试）
  t('命令自带时间戳', C.makeUndoCommand('stroke', { stroke: {} }).time > 0);
  t('时间戳可覆盖', C.makeUndoCommand('stroke', { stroke: {}, time: 42 }).time === 42);
  t('非法命令仍返回 null', C.makeUndoCommand('unknown', {}) === null);

  // 9) 内存安全：时间线不得复制图片数据
  const fs2 = require('fs');
  const src2 = fs2.readFileSync(__dirname + '/../app/core.js', 'utf8');
  const tlFn = src2.slice(src2.indexOf('function buildTimeline'), src2.indexOf('function describeCommand'));
  t('时间线不存图片快照', !/getImageData|toDataURL|ImageData/.test(tlFn));
  t('时间线只读命令列表', /stack\.list|\.list\(\)/.test(tlFn));
})();
// ===== 历史时间线结束 =====


// ===== 配置迁移（测试块） =====
(() => {
  // 迁移的核心目的：只改默认值对已安装的用户无效（localStorage 里存着旧值），
  // 必须显式改一次；而且只能改一次，否则用户手动改回来也白改。

  // 1) 老配置（分块开着）→ 迁移时把 tile 字段彻底删掉。
  // 功能删了但配置里还留着字段，会让用户在设置里看到开关却不起作用 ——
  // 比没有这个开关更让人困惑。
  const old1 = { tile: 1400, apiKey: 'sk-x', model: 'Qwen/Qwen-Image-Edit' };
  const r1 = C.migrateCfg(Object.assign({}, old1), old1);
  t('老配置的 tile 字段被删除', r1.cfg.tile === undefined, r1.cfg.tile);
  t('迁移有记录（便于提示用户）', r1.changed.includes('tile-removed'), r1.changed);
  t('迁移后打上版本标记', r1.cfg.__cfgRev === C.CFG_REV, r1.cfg.__cfgRev);
  t('迁移不影响用户数据', r1.cfg.apiKey === 'sk-x' && r1.cfg.model === 'Qwen/Qwen-Image-Edit');

  // 2) 已经是当前版本的配置：不再改动，且用户的 tile 残留也保留（不再反复迁移）
  const cur = { __cfgRev: C.CFG_REV, feather: 25, apiKey: 'sk-keep' };
  const r2 = C.migrateCfg(Object.assign({}, cur), cur);
  t('当前版本配置不被改动', r2.changed.length === 0 && r2.cfg.feather === 25, r2.changed);
  t('用户数据完整保留', r2.cfg.apiKey === 'sk-keep');

  // 3) 首次安装（没有存档）：不该记迁移，也不该改任何东西
  const fresh = {};
  const r3 = C.migrateCfg(fresh, null);
  t('首次安装不产生迁移记录', r3.changed.length === 0, r3.changed);
  t('首次安装打上版本标记', r3.cfg.__cfgRev === C.CFG_REV);

  // 4) 脏数据不能崩
  t('saved 为 null 安全', C.migrateCfg({}, null).cfg.__cfgRev === C.CFG_REV);
  t('saved 为 undefined 安全', C.migrateCfg({}, undefined).cfg.__cfgRev === C.CFG_REV);
  t('cfg 为 null 安全', !!C.migrateCfg(null, {}).cfg);
  t('cfgRev 是脏字符串也不崩', C.migrateCfg({ tile: 5 }, { __cfgRev: 'abc' }).cfg.tile === undefined);
  t('tile 是脏字符串也照样删掉', C.migrateCfg({ tile: 'x' }, {}).cfg.tile === undefined);
  t('版本号比当前大时不动它', C.migrateCfg({ tile: 900 }, { __cfgRev: 99 }).cfg.tile === 900);

  // 5) 默认值与界面：分块相关的东西必须全部消失
  const appSrc = require('fs').readFileSync(__dirname + '/../app/app.js', 'utf8');
  t('默认配置里没有 tile 字段', !/\btile:\s*\d/.test(appSrc.slice(
    appSrc.indexOf('DEFAULT_CFG'), appSrc.indexOf('DEFAULT_CFG') + 2500)));
  t('PERSIST_KEYS 里没有 tile', !/'tile'/.test(appSrc.slice(
    appSrc.indexOf('PERSIST_KEYS'), appSrc.indexOf('PERSIST_KEYS') + 700)));
  t('保存配置时记录迁移版本（否则每次启动都重迁）', /__cfgRev/.test(appSrc));
  t('loadCfg 里调用了迁移', /migrateCfg\(c, saved\)/.test(appSrc));
  t('有配置存档时才迁移（首次安装不记）', /if \(saved && typeof saved === 'object'\)/.test(appSrc));
  t('代码里不再引用 cfg.tile', !/cfg\.tile/.test(appSrc));
  t('代码里不再调用分块函数', !/planTileCrop|tileBlendWeights|accumulateTile|resolveAccumulated|tileHint/.test(appSrc));
  t('生成路径不再有分块循环', !/for \(let i = 0; i < tiles\.length/.test(appSrc));

  const html = require('fs').readFileSync(__dirname + '/../app/index.html', 'utf8');
  t('设置界面已移除分块滑块', !/id="set-tile"/.test(html));
  t('设置界面已移除分块标签', !/id="v-tile"/.test(html));
  t('设置界面不再提「自动分块」', !/自动分块/.test(html));
})();
// ===== 配置迁移结束 =====

// ===== 作品库单元测试开始 =====
(() => {
  // 1) 存储占用按 UTF-16 计费（1 字符 = 2 字节），算错会严重低估占用
  t('storageBytes 按 UTF-16 计费', C.storageBytes('abc') === 6, C.storageBytes('abc'));
  t('storageBytes 处理 null', C.storageBytes(null) === 0);
  t('storageBytes 处理 undefined', C.storageBytes(undefined) === 0);
  t('storageBytes 处理数字', C.storageBytes(123) === 6);

  // 2) 单条记录的体积估算：元数据 + 缩略图 + 会话
  const bare = { id: 'a', thumb: '', before: '', session: null };
  t('estimateWorkBytes 有空记录的基础开销', C.estimateWorkBytes(bare) >= 400, C.estimateWorkBytes(bare));
  t('estimateWorkBytes 计入缩略图', C.estimateWorkBytes({ id: 'a', thumb: 'x'.repeat(100) }) >
    C.estimateWorkBytes(bare));
  t('estimateWorkBytes 计入完整会话',
    C.estimateWorkBytes({ id: 'a', session: { base: 'y'.repeat(1000) } }) >
    C.estimateWorkBytes(bare) + 1500);
  t('estimateWorkBytes 对 null 安全', typeof C.estimateWorkBytes(null) === 'number');

  // 3) 归一化：脏数据不能把界面搞崩
  const n1 = C.normalizeWork(null);
  t('normalizeWork 对 null 安全', n1.id === '' && n1.name === '照片' && n1.edits === 0);
  t('normalizeWork 丢掉非字符串 id', C.normalizeWork({ id: 123 }).id === '');
  t('normalizeWork 补齐缺失名字', C.normalizeWork({ id: 'a' }).name === '照片');
  t('normalizeWork 负数尺寸归零', C.normalizeWork({ id: 'a', imgW: -50 }).imgW === 0);
  t('normalizeWork 小数尺寸取整', C.normalizeWork({ id: 'a', docW: 100.7 }).docW === 101);
  t('normalizeWork 脏字符串尺寸归零', C.normalizeWork({ id: 'a', imgH: 'x' }).imgH === 0);
  t('normalizeWork 非对象 session 置 null', C.normalizeWork({ id: 'a', session: 'oops' }).session === null);
  t('normalizeWork 保留合法 session', C.normalizeWork({ id: 'a', session: { v: 1 } }).session.v === 1);
  t('normalizeWork createdAt 回退到 at', C.normalizeWork({ id: 'a', at: 5000 }).createdAt === 5000);
  t('normalizeWork 保留传入的 createdAt', C.normalizeWork({ id: 'a', at: 5000, createdAt: 100 }).createdAt === 100);

  // 4) 排序：新的在前，且不改原数组
  const orig = [{ id: 'a', at: 100 }, { id: 'b', at: 300 }, { id: 'c', at: 200 }];
  const sorted = C.sortWorksNewestFirst(orig);
  t('sortWorksNewestFirst 新的在前', sorted.map((e) => e.id).join('') === 'bca', sorted.map((e) => e.id));
  t('sortWorksNewestFirst 不改原数组', orig.map((e) => e.id).join('') === 'abc');
  t('sortWorksNewestFirst 对空安全', C.sortWorksNewestFirst(null).length === 0);

  // 5) 自然日边界：这是「昨天」判断的核心
  const day = 86400000;
  const now = new Date(2024, 8, 23, 10, 0, 0).getTime();   // 9月23日 10:00
  t('dayStartTs 取当天零点', C.dayStartTs(now) === new Date(2024, 8, 23, 0, 0, 0).getTime());
  t('dayStartTs 对脏值返回 0', C.dayStartTs('x') === 0);
  t('今天', C.describeWorkAge(now, now) === '今天');
  t('昨天（跨自然日，哪怕只差 2 小时）',
    C.describeWorkAge(new Date(2024, 8, 22, 23, 30, 0).getTime(), new Date(2024, 8, 23, 1, 30, 0).getTime()) === '昨天');
  t('同一天深夜仍算今天',
    C.describeWorkAge(new Date(2024, 8, 23, 0, 5, 0).getTime(), new Date(2024, 8, 23, 23, 55, 0).getTime()) === '今天');
  t('3 天前', C.describeWorkAge(now - 3 * day, now) === '3 天前');
  t('6 天前仍是相对描述', C.describeWorkAge(now - 6 * day, now) === '6 天前');
  t('7 天前改显示日期', /月/.test(C.describeWorkAge(now - 7 * day, now)), C.describeWorkAge(now - 7 * day, now));
  t('跨年显示年份', C.describeWorkAge(new Date(2023, 8, 23).getTime(), now).indexOf('2023') === 0,
    C.describeWorkAge(new Date(2023, 8, 23).getTime(), now));
  t('同年不显示年份', C.describeWorkAge(new Date(2024, 0, 5).getTime(), now).indexOf('2024') < 0,
    C.describeWorkAge(new Date(2024, 0, 5).getTime(), now));
  t('describeWorkAge 对脏值返回空', C.describeWorkAge('x', now) === '');

  t('formatWorkClock 补零', C.formatWorkClock(new Date(2024, 8, 23, 9, 5).getTime()) === '09:05');
  // 时间戳损坏时不能显示成 "00:00"（看起来像真的凌晨编辑），要与 describeWorkAge 一样返回空
  t('formatWorkClock 对脏字符串返回空', C.formatWorkClock('x') === '', C.formatWorkClock('x'));
  t('formatWorkClock 对 0 返回空', C.formatWorkClock(0) === '', C.formatWorkClock(0));
  t('formatWorkClock 对 null 返回空', C.formatWorkClock(null) === '', C.formatWorkClock(null));
  t('formatWorkClock 对 undefined 返回空', C.formatWorkClock(undefined) === '');
  t('formatWorkClock 对负数返回空', C.formatWorkClock(-1) === '', C.formatWorkClock(-1));

  // 6) 分组：同一天要合并成一组，且按天倒序
  const groups = C.groupWorksByDay([
    { id: 'a', at: new Date(2024, 8, 23, 9, 0).getTime() },
    { id: 'b', at: new Date(2024, 8, 23, 18, 0).getTime() },
    { id: 'c', at: new Date(2024, 8, 22, 9, 0).getTime() }
  ], now);
  t('分组数量正确', groups.length === 2, groups.length);
  t('今天那组含两条', groups[0].items.length === 2, groups[0].items.length);
  t('今天那组标签是今天', groups[0].label === '今天', groups[0].label);
  t('昨天那组标签是昨天', groups[1].label === '昨天', groups[1].label);
  t('组内新的在前', groups[0].items[0].id === 'b', groups[0].items.map((x) => x.id));
  t('分组丢掉无 id 的脏条目',
    C.groupWorksByDay([{ at: 1 }, { id: 'ok', at: 1 }], now).reduce((s, g) => s + g.items.length, 0) === 1);
  t('分组对空数组安全', C.groupWorksByDay([], now).length === 0);
  // 时间戳损坏的记录不能产生「没有标题」的分隔条
  const gBad = C.groupWorksByDay([{ id: 'x', at: 0 }, { id: 'y', at: 'oops' }], now);
  t('损坏时间的记录仍会显示', gBad.reduce((s, g) => s + g.items.length, 0) === 2,
    gBad.map((g) => g.items.length));
  t('损坏时间的分组有兜底标题', gBad.every((g) => !!g.label), gBad.map((g) => g.label));
  t('损坏时间的分组归为一组', gBad.length === 1, gBad.length);
  t('兜底标题是「时间未知」', gBad[0].label === '时间未知', gBad[0].label);

  // 7) 淘汰规划：先降级（丢会话）再淘汰，尽量多留可见历史
  const mk = (id, at, sessBytes, thumbBytes) => ({
    id, at,
    thumb: 't'.repeat(thumbBytes || 10),
    session: sessBytes ? { base: 'b'.repeat(sessBytes) } : null
  });
  // 预算很小，逼出淘汰
  const many = [];
  for (let i = 0; i < 10; i++) many.push(mk('w' + i, 1000 + i * 1000, 2000, 10));
  const p1 = C.planLibrary(many, { maxBytes: 3000, maxItems: 80 });
  t('超预算时会淘汰', p1.evictIds.length > 0, p1.evictIds.length);
  t('淘汰后至少留 1 条', p1.keepIds.length >= 1, p1.keepIds.length);
  t('淘汰的是最老的', p1.evictIds.indexOf('w0') >= 0, p1.evictIds);
  t('最新的会被保留', p1.keepIds.indexOf('w9') >= 0, p1.keepIds);
  t('淘汰项与保留项不重叠',
    p1.evictIds.every((id) => p1.keepIds.indexOf(id) < 0));
  t('超预算时给出提示文案', /清理/.test(p1.note), p1.note);

  // 条数上限
  const p2 = C.planLibrary(many, { maxBytes: 1e9, maxItems: 3 });
  t('条数上限生效', p2.keepIds.length === 3, p2.keepIds.length);
  t('条数超限时淘汰最老的 7 条',
    p2.evictIds.slice().sort().join(',') === 'w0,w1,w2,w3,w4,w5,w6', p2.evictIds.slice().sort());
  t('条数超限时保留最新的 3 条',
    p2.keepIds.slice().sort().join(',') === 'w7,w8,w9', p2.keepIds.slice().sort());

  // 降级优先于淘汰：体积刚好超一点时，应该丢会话而不是丢整条记录
  const p3 = C.planLibrary([
    mk('old', 1000, 5000, 10),
    mk('new', 2000, 0, 10)
  ], { maxBytes: 4000, maxItems: 80 });
  t('优先降级而不是淘汰', p3.downgradeIds.indexOf('old') >= 0 && p3.evictIds.length === 0,
    { d: p3.downgradeIds, e: p3.evictIds });
  t('降级后仍保留可见', p3.keepIds.indexOf('old') >= 0, p3.keepIds);
  t('降级给出提示文案', /仅保留预览/.test(p3.note), p3.note);

  // 置顶（当前作品）永不被淘汰/降级 —— 否则正在编辑的照片会从记录里消失
  const p4 = C.planLibrary(many, { maxBytes: 500, maxItems: 1, pinnedId: 'w0' });
  t('置顶项永不被淘汰', p4.evictIds.indexOf('w0') < 0, p4.evictIds);
  t('置顶项永不被降级', p4.downgradeIds.indexOf('w0') < 0, p4.downgradeIds);
  t('置顶项始终在保留列表里', p4.keepIds.indexOf('w0') >= 0, p4.keepIds);

  t('planLibrary 对空数组安全', C.planLibrary([], {}).keepIds.length === 0);
  t('planLibrary 对 null 安全', C.planLibrary(null, {}).keepIds.length === 0);
  t('planLibrary 不改原数组', (() => {
    const arr = [{ id: 'a', at: 1, session: { base: 'x'.repeat(9000) } }];
    const before = arr[0].session;
    C.planLibrary(arr, { maxBytes: 100 });
    return arr[0].session === before;
  })());
  t('planLibrary 不返回重复 id', (() => {
    const p = C.planLibrary(many, { maxBytes: 3000 });
    const all = p.keepIds.concat(p.evictIds);
    return new Set(all).size === all.length;
  })());

  // 8) 统计
  const st = C.workLibraryStats([mk('a', 1, 100, 10), mk('b', 2, 0, 10), { at: 3 }]);
  t('统计只算有 id 的条目', st.count === 2, st.count);
  t('统计可继续编辑的条数', st.withSession === 1, st.withSession);
  t('统计体积为正', st.bytes > 0, st.bytes);
  t('统计对空安全', C.workLibraryStats(null).count === 0);
  t('editable 与 withSession 一致', st.editable === st.withSession);

  // 9) 预算常量本身要合理：不能超过 localStorage 常见上限（5MB），
  //    且必须给「未完成编辑的会话」键和配置留出余量 ——
  //    作品库 + 会话 + 配置写爆配额会让 setItem 抛异常，比少留几张严重得多。
  t('作品库预算不超过 3.5MB', C.LIBRARY_BUDGET_BYTES <= 3.5 * 1024 * 1024, C.LIBRARY_BUDGET_BYTES);
  t('作品库预算不至于小到放不下两条', C.LIBRARY_BUDGET_BYTES >= 3 * 1024 * 1024, C.LIBRARY_BUDGET_BYTES);
  t('作品库预算 + 会话预算留了余量给 5MB 上限',
    C.LIBRARY_BUDGET_BYTES + C.SESSION_BUDGET_BYTES <= 7 * 1024 * 1024,
    [C.LIBRARY_BUDGET_BYTES, C.SESSION_BUDGET_BYTES]);
  // 会话预算必须单独存在，且小于总预算（否则又回到「一条挤满整库」）
  t('有独立的会话预算', typeof C.SESSION_BUDGET_BYTES === 'number' && C.SESSION_BUDGET_BYTES > 0,
    C.SESSION_BUDGET_BYTES);
  t('会话预算小于总预算', C.SESSION_BUDGET_BYTES < C.LIBRARY_BUDGET_BYTES,
    [C.SESSION_BUDGET_BYTES, C.LIBRARY_BUDGET_BYTES]);
  t('条数上限合理', C.LIBRARY_MAX_ITEMS >= 20 && C.LIBRARY_MAX_ITEMS <= 200, C.LIBRARY_MAX_ITEMS);
  t('缩略图边长够小', C.THUMB_MAX_SIDE <= 512, C.THUMB_MAX_SIDE);
  t('缩略图边长不至于糊', C.THUMB_MAX_SIDE >= 128, C.THUMB_MAX_SIDE);
  t('缩略图质量在合理区间', C.THUMB_QUALITY > 0.5 && C.THUMB_QUALITY <= 0.85, C.THUMB_QUALITY);
  // 会话基准图必须真的被限制住 —— 它就是「一条吃满整库」的元凶
  t('会话基准图有长边上限', C.SESSION_BASE_MAX_SIDE > 0 && C.SESSION_BASE_MAX_SIDE <= 3072,
    C.SESSION_BASE_MAX_SIDE);
  t('会话基准图质量在合理区间',
    C.SESSION_BASE_QUALITY > 0.5 && C.SESSION_BASE_QUALITY <= 0.9, C.SESSION_BASE_QUALITY);
  t('单条 patch 上限不至于吃满库',
    C.SESSION_PATCH_MAX_CHARS > 0 && C.SESSION_PATCH_MAX_CHARS * 2 < C.SESSION_BUDGET_BYTES,
    [C.SESSION_PATCH_MAX_CHARS, C.SESSION_BUDGET_BYTES]);

  // 10) 用户的核心诉求：昨天修的照片今天还能看到
  //     用真实的「今天 10:00」和「昨天 22:00」验证，不能依赖当前时钟
  const today = new Date(2024, 8, 23, 10, 0).getTime();
  const yest = new Date(2024, 8, 22, 22, 0).getTime();
  const lib = [{ id: 'y', at: yest, name: '昨天的照片', edits: 3, thumb: 'x', session: { v: 1 } }];
  const g = C.groupWorksByDay(lib, today);
  t('昨天修的照片今天仍在记录里', g.length === 1 && g[0].items.length === 1);
  t('显示为「昨天」', g[0].label === '昨天', g[0].label);
  t('能看出修了几处', g[0].items[0].edits === 3);
  t('仍可继续编辑（会话还在）', !!g[0].items[0].session);
})();
// ===== 作品库单元测试结束 =====

/* ---------- 作品库（跨天修图记录） ---------- */
// ===== 后台保活与环境兼容（测试块） =====
(() => {
  // 1) 保活策略：生成中必须保活（这是花钱的时刻），空闲不保活
  const idle = C.planKeepAlive({ busy: false, userAlwaysOn: false });
  t('空闲时不保活', idle.on === false && idle.reason === 'idle');
  const gen = C.planKeepAlive({ busy: true, userAlwaysOn: false });
  t('生成中必须保活', gen.on === true && gen.reason === 'generating');
  const always = C.planKeepAlive({ busy: false, userAlwaysOn: true });
  t('常驻开关开启时保活', always.on === true && always.reason === 'always');
  const both = C.planKeepAlive({ busy: true, userAlwaysOn: true });
  t('生成中 + 常驻仍保活', both.on === true);
  t('生成中优先报「生成中」', both.reason === 'generating', both.reason);

  // 总开关与不支持的环境要能压住
  t('总开关关闭时不保活（即使正在生成）',
    C.planKeepAlive({ busy: true, enabled: false }).on === false);
  t('环境不支持时不保活',
    C.planKeepAlive({ busy: true, supported: false }).on === false);
  t('不支持时给出原因', C.planKeepAlive({ supported: false }).reason === 'unsupported');
  t('planKeepAlive 对 null 安全', C.planKeepAlive(null).on === false);
  t('planKeepAlive 无参安全', C.planKeepAlive().on === false);

  // 2) 状态描述：用户最关心「现在切走会不会断」，必须能一眼看出
  const dOn = C.describeKeepAlive({ on: true, reason: 'generating' });
  t('保活中状态为 ok', dOn.tone === 'ok');
  t('保活中说明「切到后台也不会中断」', /切到后台也不会中断/.test(dOn.text), dOn.text);
  const dAlways = C.describeKeepAlive({ on: true, reason: 'always' });
  t('常驻保活显示为「常驻」', /常驻/.test(dAlways.text), dAlways.text);
  const dOff = C.describeKeepAlive({ on: false });
  t('空闲状态为 muted', dOff.tone === 'muted');
  t('空闲时说明「生成时会自动保活」', /生成时会自动保活/.test(dOff.text), dOff.text);
  const dUnsup = C.describeKeepAlive(null, { supported: false });
  t('不支持时不允许开常驻', dUnsup.canAlways === false);
  t('不支持时说明原因', /不支持/.test(dUnsup.text), dUnsup.text);
  const dDisabled = C.describeKeepAlive(null, { enabled: false });
  t('总开关关闭时显示「已关闭」', dDisabled.text === '已关闭', dDisabled.text);
  t('关闭时仍允许重新打开常驻', dDisabled.canAlways === true);

  // 3) 生成中提醒：说清「能切走，但别划掉」。只提醒一次 —— 同一条提示
  //    每次生成都弹一遍纯属打扰（与工具提示同一个原则）。
  const n1 = C.planGenForegroundNotice({ keepAlive: { on: true } });
  t('保活开着时提醒', n1.show === true);
  t('提醒里说明已开保活', /已开启后台保活/.test(n1.text), n1.text);
  t('提醒里说明「别从最近任务划掉」', /划掉/.test(n1.text), n1.text);
  t('提醒里给出大致耗时', /30~60 秒/.test(n1.text), n1.text);
  t('已提醒过就不再提醒（只弹一次）',
    C.planGenForegroundNotice({ keepAlive: { on: true }, seen: true }).show === false);
  t('保活没开时不提醒（说了也没用）',
    C.planGenForegroundNotice({ keepAlive: { on: false } }).show === false);
  t('保活总开关关闭时不提醒',
    C.planGenForegroundNotice({ keepAlive: { on: true }, enabled: false }).show === false);
  t('非安卓环境不提醒',
    C.planGenForegroundNotice({ keepAlive: { on: true }, supported: false }).show === false);
  t('空参数不崩', typeof C.planGenForegroundNotice().show === 'boolean');

  // 4) 环境兼容：各版本该打什么补丁
  //    这些数字不是随便定的，对应真实的 Chrome 版本：
  //      flex gap 84 / inset 87 / aspect-ratio 88 / min() 79 / async 55
  const modern = C.planCompat({ chrome: 120 });
  t('新内核不打补丁', modern.patches.length === 0, modern.patches);
  t('新内核标记为 modern', modern.level === 'modern');
  t('新内核不告警', modern.warn === '');

  const c83 = C.planCompat({ chrome: 83, hasFlexGap: false, hasInset: false, hasAspectRatio: false });
  t('Chrome 83 要补 flex gap', c83.patches.includes('no-flex-gap'), c83.patches);
  t('Chrome 83 要补 inset', c83.patches.includes('no-inset'), c83.patches);
  t('Chrome 83 要补 aspect-ratio', c83.patches.includes('no-aspect-ratio'), c83.patches);
  t('Chrome 83 不补 min()（79 就支持了）', !c83.patches.includes('no-css-minmax'), c83.patches);
  t('打了补丁就不算 blocking', c83.blocking === false);
  t('打了补丁会告警建议更新 WebView', /WebView/.test(c83.warn), c83.warn);

  const c70 = C.planCompat({ chrome: 70, hasFlexGap: false, hasInset: false, hasAspectRatio: false, hasMinFn: false });
  t('Chrome 70 要补 min()', c70.patches.includes('no-css-minmax'), c70.patches);
  // 70 是「打了补丁但还能用」的分界：再往下就归为 legacy（体验明显更差）
  t('Chrome 70 标为 patched', c70.level === 'patched', c70.level);
  t('Chrome 69 标为 legacy', C.planCompat({ chrome: 69, hasFlexGap: false }).level === 'legacy');
  // 边界：84 起 flex gap 原生支持，不该再打这个补丁
  t('Chrome 84 不再补 flex gap',
    !C.planCompat({ chrome: 84, hasFlexGap: true, hasInset: false, hasAspectRatio: false }).patches.includes('no-flex-gap'));
  t('Chrome 87 不再补 inset',
    !C.planCompat({ chrome: 87, hasFlexGap: true, hasInset: true, hasAspectRatio: false }).patches.includes('no-inset'));
  t('Chrome 88 起完全不用补', C.planCompat({ chrome: 88, hasFlexGap: true, hasInset: true, hasAspectRatio: true, hasMinFn: true }).patches.length === 0);

  const c54 = C.planCompat({ chrome: 54, hasAsync: false });
  t('不支持 async 时标记 blocking', c54.blocking === true);
  t('blocking 时给出可操作的指引', /更新/.test(c54.warn), c54.warn);
  t('blocking 时不打补丁（打了也没用）', c54.patches.length === 0);

  // 能力探测优先于版本号：国产内核可能不报 Chrome 版本
  const unknown = C.planCompat({ chrome: 0, hasFlexGap: true, hasInset: true, hasAspectRatio: true, hasMinFn: true });
  t('拿不到版本号时按能力判断（全支持→不打补丁）', unknown.patches.length === 0, unknown.patches);
  const unknownBad = C.planCompat({ chrome: 0, hasFlexGap: false });
  t('拿不到版本号但实测缺 flex gap → 打补丁', unknownBad.patches.includes('no-flex-gap'), unknownBad.patches);
  t('planCompat 对 null 安全', typeof C.planCompat(null).patches.length === 'number');

  // 5) 补丁名 → class 名
  t('补丁名转 class 加 ps- 前缀',
    C.compatClassNames(['no-flex-gap']).join(',') === 'ps-no-flex-gap');
  t('多个补丁都转换', C.compatClassNames(['a', 'b']).length === 2);
  t('空输入安全', C.compatClassNames([]).length === 0);
  t('null 输入安全', C.compatClassNames(null).length === 0);

  // 6) 接线检查：这些必须在真实文件里，不能只有函数定义
  const fs2 = require('fs');
  const appSrc2 = fs2.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const html2 = fs2.readFileSync(__dirname + '/../app/index.html', 'utf8');
  const css2 = fs2.readFileSync(__dirname + '/../app/style.css', 'utf8');

  t('生成开始时同步保活（setBusy 里挂钩）',
    /function setBusy[\s\S]{0,500}syncKeepAlive\(\)/.test(appSrc2));
  // 启动时必须无条件同步一次：桥可能比 boot 晚就绪，靠启动时的缓存值会永久误判
  t('启动时无条件同步保活状态', /\/\/ 后台保活[\s\S]{0,400}syncKeepAlive\(\);/.test(appSrc2));
  t('启动时按常驻配置申请通知权限',
    /syncKeepAlive\(\);[\s\S]{0,200}keepAliveAlways === true\) askNotificationPermission\(\)/.test(appSrc2));
  t('保活支持检测不缓存（实时探测）',
    /S\.keepAliveSupported = keepAliveSupported\(\);/.test(appSrc2));
  t('启动时探测环境能力', /applyCompat\(\)/.test(appSrc2));
  t('切回前台会重新同步保活', /visibilitychange[\s\S]{0,200}syncKeepAlive\(\)/.test(appSrc2));
  t('浏览器里没有桥时不报错（bridge 判空）', /function bridge\(\)[\s\S]{0,200}PSBridge[\s\S]{0,200}null/.test(appSrc2));
  t('生成完成且用户切走时发通知', /document\.hidden[\s\S]{0,120}notifyGenDone/.test(appSrc2));
  t('生成失败且用户切走时也发通知', /生成失败，点开查看原因/.test(appSrc2));
  t('生成中提醒「别划掉」', /planGenForegroundNotice\(/.test(appSrc2));
  t('生成中提醒只弹一次', /seen: hintSeen\('gen-keepalive'\)/.test(appSrc2));
  t('设置里有保活总开关', /id="set-keepalive"/.test(html2));
  t('设置里有常驻开关', /id="set-keepalive-always"/.test(html2));
  t('设置里有状态显示', /id="ka-state"/.test(html2));
  t('设置里有电池优化引导', /id="ka-battery"/.test(html2));
  t('保活配置会被持久化', /'keepAlive', 'keepAliveAlways'/.test(appSrc2));
  t('保活默认开启', /keepAlive: true,/.test(appSrc2));
  t('常驻默认关闭（不该默认挂通知）', /keepAliveAlways: false,/.test(appSrc2));
  t('关总开关时一并关掉常驻', /keepAlive === false && S\.cfg\.keepAliveAlways/.test(appSrc2));
  t('状态样式存在', /\.ka-state/.test(css2) && /\.ka-ok/.test(css2));
  t('兼容补丁样式存在', /\.ps-no-flex-gap/.test(css2));
})();
// ===== 后台保活结束 =====


/* ---------- 后台保活与环境兼容 ---------- */






// ===== 对比视图手势（测试块） =====
(() => {
  // 1) 手势判定：这是修复的核心 —— 双击必须不被当成拖分割线
  //    修复前：pointerdown 无条件拖分割线，双击的两次点击各把线拽到手指位置
  const base = { splitX: 400, hitPx: 22, scale: 1, fitScale: 1 };
  t('按在竖线上 → 拖分割线',
    C.planCompareDrag(Object.assign({}, base, { x: 400 })) === 'split');
  t('按在竖线附近（阈值内）→ 拖分割线',
    C.planCompareDrag(Object.assign({}, base, { x: 415 })) === 'split');
  t('适应窗口时远离竖线 → 留给双击判定',
    C.planCompareDrag(Object.assign({}, base, { x: 200 })) === 'tap');
  t('放大后远离竖线 → 平移画面',
    C.planCompareDrag(Object.assign({}, base, { x: 200, scale: 3, fitScale: 1 })) === 'pan');
  // 关键：放大后仍然要能拖分割线，否则用户放大了就没法对比了
  t('放大后按竖线仍可拖分割线',
    C.planCompareDrag(Object.assign({}, base, { x: 400, scale: 3, fitScale: 1 })) === 'split');
  t('阈值可配置', C.planCompareDrag({ x: 130, splitX: 100, hitPx: 40 }) === 'split');
  t('阈值有下限保护（太小会误触）',
    C.planCompareDrag({ x: 101, splitX: 100, hitPx: 0 }) === 'split');
  // 缺参数时 x/splitX 都是 0，判定为 split（保守：不会误触发缩放）
  t('planCompareDrag 对 null 安全（不崩）', typeof C.planCompareDrag(null) === 'string');
  t('canPan=false 时不进入平移', 
    C.planCompareDrag({ x: 200, splitX: 400, scale: 3, fitScale: 1, canPan: false }) === 'tap');

  // 2) 双击缩放
  const fit = C.makeView(0.5, 10, 10);
  const geo = { imgW: 400, imgH: 300, viewW: 800, viewH: 600, zoom: 3, maxScale: 12 };

  const z1 = C.planCompareDoubleTap(Object.assign({ view: fit, fitView: fit, px: 400, py: 300 }, geo));
  t('首次双击会放大', z1.zoomed === true);
  t('放大后确实比适应窗口大', z1.view.scale > fit.scale);
  // 小图（400x300 在 800x600 视口）按 3 倍只有 1.5，四周仍是空白，
  // 所以会被提升到「铺满视口」的 2 倍 —— 这才是用户能看出区别的放大
  t('小图按铺满视口放大而不是死守 3 倍',
    Math.abs(z1.view.scale - 2) < 1e-9, z1.view.scale);

  // 小图放大后仍要铺满视口 —— 否则四周全是空白，用户看不出「放大了」
  // （400x300 图在 800x600 视口里，3 倍 = 1.5，但铺满需要 2 倍）
  t('小图放大后至少铺满视口',
    z1.view.scale >= Math.max(800 / 400, 600 / 300) - 1e-9, z1.view.scale);

  // 以点击点为中心放大：用大图验证（放大后仍有平移空间，clamp 不会强制居中）
  const bigW = 1600, bigH = 1200;
  const bigFit = C.fitView(bigW, bigH, 800, 600, 10);
  const bigZ = C.planCompareDoubleTap({
    view: bigFit, fitView: bigFit, px: 300, py: 200,
    zoom: 3, imgW: bigW, imgH: bigH, viewW: 800, viewH: 600, maxScale: 12
  });
  const pt = { x: 300, y: 200 };
  const before = C.imageToScreen(C.screenToImage(pt, bigFit), bigFit);
  const after = C.imageToScreen(C.screenToImage(pt, bigFit), bigZ.view);
  t('以双击点为中心放大（该点位置不动）',
    Math.abs(before.x - after.x) < 1 && Math.abs(before.y - after.y) < 1,
    { before, after });
  t('大图放大倍数就是 3 倍',
    Math.abs(bigZ.view.scale / bigFit.scale - 3) < 0.01, bigZ.view.scale / bigFit.scale);

  const z2 = C.planCompareDoubleTap(Object.assign({ view: z1.view, fitView: fit, px: 400, py: 300 }, geo));
  t('再次双击还原', z2.zoomed === false);
  t('还原后回到适应窗口比例', Math.abs(z2.view.scale - fit.scale) < 1e-9, z2.view.scale);
  t('还原后画面居中（不会偏到角落）',
    Math.abs(z2.view.tx - fit.tx) < 1e-6 && Math.abs(z2.view.ty - fit.ty) < 1e-6, z2.view);

  // 放大后不能露白：视图必须被夹在图像范围内
  t('放大结果已夹取（不露白）', z1.view.scale >= fit.scale);
  // 缩放上限
  const huge = C.planCompareDoubleTap(Object.assign(
    { view: C.makeView(fit.scale, 0, 0), fitView: fit, px: 400, py: 300, zoom: 999 }, geo));
  t('缩放不超过上限', huge.view.scale <= geo.maxScale + 1e-9, huge.view.scale);
  t('planCompareDoubleTap 对 null 安全', typeof C.planCompareDoubleTap(null).view === 'object');

  // 3) 缩放状态描述
  const dFit = C.describeCompareZoom(fit, fit);
  t('适应窗口时不算放大', dFit.zoomed === false);
  t('适应窗口时不显示倍数', dFit.text === '');
  t('适应窗口时提示可双击放大', /双击/.test(dFit.hint), dFit.hint);
  t('适应窗口时不需要复位按钮', dFit.canReset === false);

  const dZoom = C.describeCompareZoom(z1.view, fit);
  t('放大时标记为 zoomed', dZoom.zoomed === true);
  t('放大时显示倍数', /×/.test(dZoom.text), dZoom.text);
  t('放大时显示倍数（小图为 4×）', dZoom.text === '4×', dZoom.text);
  t('放大时提示怎么平移/还原', /平移/.test(dZoom.hint) && /还原/.test(dZoom.hint), dZoom.hint);
  t('放大时提供复位按钮', dZoom.canReset === true);
  t('放大后提示仍说明可按竖线拖对比', /竖线/.test(dZoom.hint), dZoom.hint);

  // 倍数显示：大倍数不带小数点
  t('10 倍以上取整', C.describeCompareZoom(C.makeView(5, 0, 0), C.makeView(0.5, 0, 0)).text === '10×');
  t('10 倍以下保留一位', C.describeCompareZoom(C.makeView(1.5, 0, 0), C.makeView(0.5, 0, 0)).text === '3×');
  t('describeCompareZoom 对 null 安全', typeof C.describeCompareZoom(null, null).text === 'string');

  // 4) 接线检查：不能只有纯函数，必须真的接进对比视图
  const fs3 = require('fs');
  const appSrc3 = fs3.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const html3 = fs3.readFileSync(__dirname + '/../app/index.html', 'utf8');
  const css3 = fs3.readFileSync(__dirname + '/../app/style.css', 'utf8');

  // 根因回归：drawCompare 之前每帧都用 fitView，导致根本没有缩放状态
  t('对比视图有可变的缩放状态', /let cmpView = null/.test(appSrc3));
  t('drawCompare 使用缩放状态而不是每帧 fitView',
    /const v = cmpView \|\| fit;/.test(appSrc3));
  t('双击会改缩放状态', /planCompareDoubleTap\(/.test(appSrc3));
  t('双击以点击点为中心', /px, py,\s*\n\s*zoom: 3/.test(appSrc3) || /px, py/.test(appSrc3));
  t('按下时先判定手势类型', /planCompareDrag\(/.test(appSrc3));
  t('只有 split 模式才拖分割线',
    /mode === 'split'\)[\s\S]{0,400}cmpSplit = C\.clamp01/.test(appSrc3));
  // 平移要先越过 6px 阈值（否则「按下没动」会被当成拖动，双击就失效了）
  t('放大后可拖动平移',
    /mode === 'pan'\)[\s\S]{0,400}clampView/.test(appSrc3));
  t('平移有起手阈值（避免与点击冲突）',
    /Math\.hypot\(dx, dy\) > 6\) g\.moved = true/.test(appSrc3));
  t('有双击时间间隔判定', /now - cmpLastTap < 300/.test(appSrc3));
  t('有双击位置接近判定（避免误触）', /Math\.hypot\(e\.clientX - cmpLastTapX/.test(appSrc3));
  t('拖动超过阈值就不算点击', /g\.moved = true/.test(appSrc3));
  t('支持双指捏合缩放', /cmpPinch/.test(appSrc3));
  t('支持滚轮缩放（桌面端）', /addEventListener\('wheel'/.test(appSrc3));
  t('进入对比视图时重置缩放', /cmpView = null;\s*\/\/ 每次进入都从「适应窗口」开始/.test(appSrc3));
  t('分割线位置按图内比例换算（放大后仍准确）',
    /\(\(e\.clientX - r\.left\) - dr\.x\) \/ dr\.w/.test(appSrc3));

  // 界面：放大后必须能看到倍数并能复位，否则用户会以为界面坏了
  t('界面有倍数指示', /id="cmp-zoom"/.test(html3));
  t('界面有复位按钮', /id="cmp-reset"/.test(html3));
  t('提示文案有 id（可动态更新）', /id="cmp-hint"/.test(html3));
  t('倍数指示有样式', /\.cmp-zoom/.test(css3));
  t('复位按钮有样式', /\.cmp-reset/.test(css3));
  t('复位按钮避开了右上角标签', /\.cmp-reset[\s\S]{0,200}margin-top/.test(css3));
})();
// ===== 手势块结束 =====


/* ---------- 对比视图手势 ---------- */
// ===== 无缝融合（测试块） =====
(() => {
  function mk(w, h, fn) {
    const p = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = fn(x, y);
        const i = (y * w + x) * 4;
        p.data[i] = c[0]; p.data[i + 1] = c[1]; p.data[i + 2] = c[2]; p.data[i + 3] = 255;
      }
    }
    return p;
  }
  const clone = (p) => {
    const q = { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) };
    return q;
  };
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

  // 1) ringMoments：环带统计（均值 + 标准差）
  const flat = mk(80, 80, () => [100, 100, 100]);
  const m1 = C.ringMoments({ pixels: flat, rect: { x: 20, y: 20, w: 40, h: 40 }, ring: 6 });
  t('ringMoments 取到环带样本', m1.n > 0, m1.n);
  t('ringMoments 均值正确', Math.abs(m1.mean[0] - 100) < 0.01, m1.mean);
  t('ringMoments 纯色标准差为 0', m1.std[0] < 0.01, m1.std);
  // 标准差要能反映「起伏程度」——这是对比度匹配的依据
  const noisy = mk(80, 80, (x) => [x % 2 ? 60 : 140, x % 2 ? 60 : 140, x % 2 ? 60 : 140]);
  const m2 = C.ringMoments({ pixels: noisy, rect: { x: 20, y: 20, w: 40, h: 40 }, ring: 6 });
  t('ringMoments 标准差能反映起伏', m2.std[0] > 30, m2.std);
  t('ringMoments 对 null 安全', C.ringMoments(null).n === 0);
  t('ringMoments 对空 rect 安全', typeof C.ringMoments({ pixels: flat }).n === 'number');

  // 2) rectMoments：整块统计（生成块没有环带，必须用这个）
  const rm = C.rectMoments(flat);
  t('rectMoments 整块均值正确', Math.abs(rm.mean[0] - 100) < 0.01, rm.mean);
  t('rectMoments 样本数等于像素数', rm.n === 80 * 80, rm.n);
  t('rectMoments 对 null 安全', C.rectMoments(null).n === 0);

  // 3) fitLightPlane：光照梯度拟合
  //    造一张「左亮右暗」的图，拟合出的 x 斜率必须为负
  const grad = mk(200, 200, (x) => { const v = 200 - x * 0.5; return [v, v, v]; });
  const pl = C.fitLightPlane({ pixels: grad, rect: { x: 60, y: 60, w: 80, h: 80 }, ring: 14 });
  t('梯度拟合成功', pl.ok === true);
  t('x 方向斜率为负（左亮右暗）', pl.a[0] < -5, pl.a[0]);
  t('y 方向斜率接近 0（无上下渐变）', Math.abs(pl.b[0]) < 1, pl.b[0]);
  // 反向：右亮左暗 → 斜率应为正
  const grad2 = mk(200, 200, (x) => { const v = 80 + x * 0.5; return [v, v, v]; });
  const pl2 = C.fitLightPlane({ pixels: grad2, rect: { x: 60, y: 60, w: 80, h: 80 }, ring: 14 });
  t('反向渐变斜率为正', pl2.a[0] > 5, pl2.a[0]);
  // 纯色：无梯度
  const pl3 = C.fitLightPlane({ pixels: flat, rect: { x: 20, y: 20, w: 40, h: 40 }, ring: 6 });
  t('纯色图无梯度', Math.abs(pl3.a[0]) < 1 && Math.abs(pl3.b[0]) < 1, [pl3.a[0], pl3.b[0]]);
  // 退化输入不能崩
  t('fitLightPlane 对 null 安全', C.fitLightPlane(null).ok === false);
  t('环带太小则放弃梯度（不硬算）', (() => {
    const p = C.fitLightPlane({ pixels: flat, rect: { x: 0, y: 0, w: 2, h: 2 }, ring: 1 });
    return p.ok === false || (Number.isFinite(p.a[0]) && Number.isFinite(p.b[0]));
  })());

  // 4) planFusion：色偏 + 对比度
  const doc = mk(400, 300, () => [150, 140, 120]);
  const rect = { x: 150, y: 100, w: 100, h: 80 };
  const patch = mk(rect.w, rect.h, (x, y) => {
    const n = ((x * 7 + y * 13) % 11) / 11;
    const v = 120 + n * 25;
    return [v * 0.85, v * 0.95, v * 1.15];      // 偏冷、偏暗
  });
  const plan = C.planFusion({
    src: patch, rect, dst: doc, dstFull: doc, dstOffset: { x: 0, y: 0 }, ring: 10
  });
  t('planFusion 取到生成块均值（非 0）', plan.srcMean[0] > 50, plan.srcMean);
  t('planFusion 取到环境均值', plan.dstMean[0] > 100, plan.dstMean);
  t('delta 方向正确（环境更暖→红通道为正）', plan.delta[0] > 0, plan.delta);
  t('delta 方向正确（生成块偏蓝→蓝通道为负）', plan.delta[2] < 0, plan.delta);
  t('gain 在安全范围内', plan.gain.every((g) => g >= 0.75 && g <= 1.35), plan.gain);

  // 5) fuseColor：核心校正
  //    ① 均值对齐必须精确
  const plan2 = C.planFusion({
    src: patch, rect, dst: doc, dstFull: doc, dstOffset: { x: 0, y: 0 }, ring: 10
  });
  const fused = mk(rect.w, rect.h, (x, y) => {
    const i = (y * rect.w + x) * 4;
    return C.fuseColor(patch.data[i], patch.data[i + 1], patch.data[i + 2],
      (x + 0.5) / rect.w, (y + 0.5) / rect.h, { mean: 1, struct: 1 }, plan2);
  });
  let s = [0, 0, 0];
  const np = rect.w * rect.h;
  for (let i = 0; i < np; i++) { s[0] += fused.data[i * 4]; s[1] += fused.data[i * 4 + 1]; s[2] += fused.data[i * 4 + 2]; }
  const err = s.map((v, i) => Math.abs(v / np - plan2.dstMean[i]));
  t('均值对齐精确（误差 < 2）', err.every((v) => v < 2), err.map((v) => Math.round(v * 10) / 10));

  //    ② 关键设计：中心必须保留用户意图
  //    这是实现中真实踩到的坑 —— 早期版本把用户要的纯红拉成了偏暗的浊红
  const pure = C.fuseColor(220, 40, 40, 0.5, 0.5, { mean: 0, struct: 1 }, plan2);
  t('中心处（mean=0）保留用户要的颜色', pure[0] === 220 && pure[1] === 40 && pure[2] === 40, pure);
  const tinted = C.fuseColor(220, 40, 40, 0.5, 0.5, { mean: 1, struct: 0 }, plan2);
  t('接缝处（mean=1）色偏被校正', tinted[0] !== 220 || tinted[1] !== 40 || tinted[2] !== 40, tinted);
  t('强度为 0 时原样返回', JSON.stringify(C.fuseColor(10, 20, 30, 0.5, 0.5, 0, plan2)) === '[10,20,30]');
  t('无计划时原样返回', JSON.stringify(C.fuseColor(10, 20, 30, 0.5, 0.5, 1, null)) === '[10,20,30]');
  t('输出被夹在 0~255', (() => {
    const r = C.fuseColor(255, 255, 255, 0, 0, { mean: 1, struct: 1 }, plan2);
    return r.every((v) => v >= 0 && v <= 255);
  })());

  // 6) textureEnergy + planGrain：颗粒补偿
  const smooth = mk(80, 80, () => [128, 128, 128]);
  const rough = mk(80, 80, (x, y) => {
    const n = ((x * 13 + y * 29) % 17) / 17;
    const v = 100 + n * 56;
    return [v, v, v];
  });
  const eS = C.textureEnergy(smooth, { x: 0, y: 0, w: 80, h: 80 }, 2);
  const eR = C.textureEnergy(rough, { x: 0, y: 0, w: 80, h: 80 }, 2);
  t('平滑图纹理能量低', eS < 1, eS);
  t('粗糙图纹理能量高', eR > 5, eR);
  t('textureEnergy 对 null 安全', C.textureEnergy(null) === 0);
  const g = C.planGrain({ src: smooth, w: 80, h: 80, dst: rough, dstRect: { x: 0, y: 0, w: 80, h: 80 }, stride: 2 });
  t('周围更粗糙时会补颗粒', g.ok === true && g.amount > 0, g);
  const g2 = C.planGrain({ src: rough, w: 80, h: 80, dst: smooth, dstRect: { x: 0, y: 0, w: 80, h: 80 }, stride: 2 });
  t('周围更平滑时不补颗粒（不主动降质）', g2.ok === false, g2);
  t('颗粒量有上限', g.amount <= 10 + 1e-9, g.amount);

  // 7) grainNoise：必须确定性（否则每次重绘画面会闪烁）
  t('同一 seed 结果一致', C.grainNoise(10, 20, 7) === C.grainNoise(10, 20, 7));
  t('不同坐标结果不同', C.grainNoise(10, 20, 7) !== C.grainNoise(11, 20, 7));
  t('不同 seed 结果不同', C.grainNoise(10, 20, 7) !== C.grainNoise(10, 20, 8));
  t('噪声范围在 -1~1', (() => {
    for (let i = 0; i < 500; i++) {
      const v = C.grainNoise(i, i * 3, 1);
      if (v < -1 || v > 1) return false;
    }
    return true;
  })());

  // 8) assessSeam：契合度评分
  const same = C.assessSeam({
    src: mk(60, 60, () => [128, 128, 128]), rect: { x: 0, y: 0, w: 60, h: 60 },
    dst: mk(200, 200, () => [128, 128, 128]), dstFull: null, ring: 6
  });
  t('完全一致时评分满分', same.score === 100, same);
  t('完全一致时无问题项', same.issues.length === 0, same.issues);
  const bad = C.assessSeam({
    src: mk(60, 60, () => [220, 40, 40]), rect: { x: 0, y: 0, w: 60, h: 60 },
    dst: mk(200, 200, () => [30, 90, 160]), dstFull: null, ring: 6
  });
  t('差异大时评分低', bad.score < 50, bad.score);
  t('差异大时报告具体问题', bad.issues.length > 0, bad.issues);
  t('评分在 0~100 之间', same.score >= 0 && same.score <= 100 && bad.score >= 0 && bad.score <= 100);
  t('报告含 ΔE', typeof bad.detail.deltaE === 'number', bad.detail);
  t('报告含亮度台阶', typeof bad.detail.lumStep === 'number', bad.detail);

  // 9) 集成：融合必须真的改善接缝
  //    场景：原图有强光照梯度，生成块是平的 —— 这是「一眼看出贴过」的典型
  const base = mk(400, 300, (x) => {
    const v = 230 - (x / 400) * 150;
    return [v, v * 0.95, v * 0.85];
  });
  const r2 = { x: 200, y: 100, w: 100, h: 80 };
  const flatPatch = mk(r2.w, r2.h, () => [150, 143, 128]);
  const runComposite = (useFusion) => {
    const d = clone(base);
    const opts = { feather: 14, colorMatch: { ring: 8, ramp: 14, strength: 0.5 } };
    if (useFusion) {
      opts.fusion = { strength: 1, ring: 12, centerFloor: 0.35 };
      opts.dstFull = d; opts.dstOffset = { x: 0, y: 0 };
    }
    C.compositeFeathered(d, flatPatch, r2, opts);
    return d;
  };
  const d1 = runComposite(false), d2 = runComposite(true);
  // 沿接缝取剖面：梯度不匹配时台阶会随位置变化（看得见的「明暗带」）
  const profile = (d) => {
    const out = [];
    for (let x = r2.x + 8; x < r2.x + r2.w - 8; x += 20) {
      const o = (r2.y - 3) * 400 + x, i = (r2.y + 3) * 400 + x;
      const lo = 0.299 * d.data[o * 4] + 0.587 * d.data[o * 4 + 1] + 0.114 * d.data[o * 4 + 2];
      const li = 0.299 * d.data[i * 4] + 0.587 * d.data[i * 4 + 1] + 0.114 * d.data[i * 4 + 2];
      out.push(li - lo);
    }
    return out;
  };
  const rms = (a) => Math.sqrt(a.reduce((s2, v) => s2 + v * v, 0) / a.length);
  const p1 = profile(d1), p2 = profile(d2);
  t('融合降低了接缝处的亮度台阶', rms(p2) < rms(p1),
    { withoutFusion: rms(p1).toFixed(2), withFusion: rms(p2).toFixed(2) });
  t('融合让台阶更均匀（波动更小）', (() => {
    const sd = (a) => { const m = a.reduce((s2, v) => s2 + v, 0) / a.length;
      return Math.sqrt(a.reduce((s2, v) => s2 + (v - m) * (v - m), 0) / a.length); };
    return sd(p2) <= sd(p1) + 0.01;
  })(), { before: p1.map((v) => Math.round(v * 10) / 10), after: p2.map((v) => Math.round(v * 10) / 10) });

  // 9.5) 关键设计回归：中心必须保留用户意图（走真实合成路径）
  //       早期版本把「均值校正」也施加到中心，导致用户要的纯红被拉成浊红。
  //       这条必须走 compositeFeathered —— 只测 fuseColor 抓不到强度分配的错误。
  const intentDoc = mk(400, 300, () => [30, 90, 160]);      // 深蓝环境
  const intentRect = { x: 120, y: 90, w: 100, h: 80 };
  const pureRed = mk(intentRect.w, intentRect.h, () => [220, 40, 40]);   // 用户要的纯红
  const dIntent = clone(intentDoc);
  C.compositeFeathered(dIntent, pureRed, intentRect, {
    feather: 12,
    colorMatch: { ring: 8, ramp: 12, strength: 0 },          // 关掉旧的色彩匹配，隔离变量
    fusion: { strength: 1, ring: 12, centerFloor: 0.35 },
    dstFull: dIntent, dstOffset: { x: 0, y: 0 }
  });
  const cxi = (intentRect.y + Math.round(intentRect.h / 2)) * 400 + intentRect.x + Math.round(intentRect.w / 2);
  const centerPx = [dIntent.data[cxi * 4], dIntent.data[cxi * 4 + 1], dIntent.data[cxi * 4 + 2]];
  t('中心保留用户要的颜色（不被均值对齐拉走）',
    centerPx[0] === 220 && centerPx[1] === 40 && centerPx[2] === 40, centerPx);
  // 但接缝附近必须被校正（否则会有一圈突兀的色边）
  const edgeIdx = (intentRect.y + 1) * 400 + intentRect.x + Math.round(intentRect.w / 2);
  const edgePx = [dIntent.data[edgeIdx * 4], dIntent.data[edgeIdx * 4 + 1], dIntent.data[edgeIdx * 4 + 2]];
  t('接缝附近会被校正（向环境靠拢）', edgePx[0] !== 220 || edgePx[2] !== 40, edgePx);

  // 10) 关闭融合时行为与旧版一致（不能破坏既有能力）
  const dOff = clone(base);
  const dNoFusion = clone(base);
  const legacyOpts = { feather: 10, colorMatch: { ring: 8, ramp: 10, strength: 0.5 } };
  C.compositeFeathered(dOff, flatPatch, r2, Object.assign({}, legacyOpts, { fusion: null }));
  C.compositeFeathered(dNoFusion, flatPatch, r2, legacyOpts);
  let identical = true;
  for (let i = 0; i < dOff.data.length; i += 4) {
    if (dOff.data[i] !== dNoFusion.data[i]) { identical = false; break; }
  }
  t('fusion=null 时与旧版行为完全一致', identical);
  t('强度为 0 时不做任何校正', (() => {
    const a = clone(base), b = clone(base);
    C.compositeFeathered(a, flatPatch, r2, Object.assign({}, legacyOpts, { fusion: { strength: 0 } }));
    C.compositeFeathered(b, flatPatch, r2, legacyOpts);
    for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i]) return false;
    return true;
  })());

  // 11) 接线检查
  const fs4 = require('fs');
  const appSrc4 = fs4.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const html4 = fs4.readFileSync(__dirname + '/../app/index.html', 'utf8');
  t('合成路径接了融合', /fusion: fuseStrength > 0 \?/.test(appSrc4));
  t('图层 UI 有无缝融合滑块', /mkParam\('无缝融合'/.test(appSrc4));
  t('图层显示契合度评分', /assessLayerSeam/.test(appSrc4));
  t('设置界面有无缝融合', /id="set-fusion"/.test(html4));
  t('设置界面有中心保留', /id="set-fusionc"/.test(html4));
  t('设置界面有颗粒补偿', /id="set-fusiong"/.test(html4));
  t('融合参数会被持久化', /'fusion', 'fusionCenter', 'fusionGrain'/.test(appSrc4));
  t('融合默认开启', /fusion: 0\.7,/.test(appSrc4));
  t('评分缓存会随参数失效', /seamCache\.clear\(\)/.test(appSrc4));
})();
// ===== 融合块结束 =====


/* ---------- 无缝融合 ---------- */
// ===== 环境契合提示词（测试块） =====
(() => {
  // 1) 环境特征描述：必须把测出来的统计翻译成可读文字
  const darkWarm = C.describeEnvironment({
    stats: { mean: [92, 84, 66], std: [38, 36, 32] },
    plane: { a: [0, 0, 0], b: [0, 0, 0], ok: false },
    isZh: true
  });
  t('描述了亮度档位', /偏暗|中等亮度|整体明亮|高亮/.test(darkWarm), darkWarm);
  t('描述了冷暖', /色调偏暖|色调略暖|色调中性|色调略冷|色调偏冷/.test(darkWarm), darkWarm);
  t('描述了反差', /反差/.test(darkWarm), darkWarm);
  t('给出「必须融入」的要求', /必须自然融入/.test(darkWarm), darkWarm);
  // 偏暗 + 红>蓝 → 应该判成「偏暗 + 偏暖」
  t('暗调判断正确', /偏暗/.test(darkWarm), darkWarm);
  t('暖调判断正确', /暖/.test(darkWarm), darkWarm);

  const brightCool = C.describeEnvironment({
    stats: { mean: [180, 195, 215], std: [70, 70, 70] }, isZh: true
  });
  t('亮调判断正确', /明亮|高亮/.test(brightCool), brightCool);
  t('冷调判断正确', /冷/.test(brightCool), brightCool);
  t('高反差判断正确', /高反差/.test(brightCool), brightCool);

  const neutral = C.describeEnvironment({
    stats: { mean: [140, 140, 140], std: [30, 30, 30] }, isZh: true
  });
  t('中性调判断正确', /色调中性/.test(neutral), neutral);

  // 2) 光照方向：这是最容易写反的地方
  //    符号约定：像素值 = a·u + b·v + c，u/v 是归一化坐标（0→1）
  //      a > 0 → 越往右越亮 → 光来自右侧
  //      a < 0 → 越往右越暗 → 光来自左侧
  function mk(w, h, fn) {
    const p = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = fn(x, y);
        const i = (y * w + x) * 4;
        p.data[i] = c[0]; p.data[i + 1] = c[1]; p.data[i + 2] = c[2]; p.data[i + 3] = 255;
      }
    }
    return p;
  }
  const stat = { mean: [150, 150, 150], std: [40, 40, 40] };
  const dirOf = (fn) => {
    const img = mk(300, 300, fn);
    const pl = C.fitLightPlane({ pixels: img, rect: { x: 100, y: 100, w: 100, h: 100 }, ring: 14 });
    const d = C.describeEnvironment({ stats: stat, plane: pl, isZh: true });
    const m = /主光来自(\S+?)。/.exec(d);
    return m ? m[1] : '';
  };
  t('左亮右暗 → 主光来自左侧', dirOf((x) => { const v = 200 - x * 0.4; return [v, v, v]; }) === '左侧');
  t('右亮左暗 → 主光来自右侧', dirOf((x) => { const v = 80 + x * 0.4; return [v, v, v]; }) === '右侧');
  t('上亮下暗 → 主光来自上方', dirOf((x, y) => { const v = 200 - y * 0.4; return [v, v, v]; }) === '上方');
  t('下亮上暗 → 主光来自下方', dirOf((x, y) => { const v = 80 + y * 0.4; return [v, v, v]; }) === '下方');
  // 均匀光照不应硬编方向（没有方向时不说，比说错强）
  t('均匀光照不编造方向',
    dirOf(() => [150, 150, 150]) === '', dirOf(() => [150, 150, 150]));

  // 3) 英文版也要完整
  const en = C.describeEnvironment({
    stats: { mean: [92, 84, 66], std: [38, 36, 32] },
    plane: { a: [40, 40, 40], b: [0, 0, 0], ok: true },
    isZh: false
  });
  t('英文版含特征描述', /Measured characteristics/.test(en), en);
  t('英文版含光向', /key light from/.test(en), en);
  t('英文版不含中文', !/[\u4e00-\u9fa5]/.test(en), en);

  // 4) 退化输入不能崩
  t('describeEnvironment 对 null 安全', C.describeEnvironment(null) === '');
  t('无 stats 时返回空串', C.describeEnvironment({ plane: null }) === '');
  t('stats 缺 mean 时返回空串', C.describeEnvironment({ stats: {} }) === '');

  // 5) environmentClause：特征 + 行为要求
  const clause = C.environmentClause({ isZh: true, envDesc: darkWarm, scope: 'region' });
  t('约束段含环境特征', clause.indexOf(darkWarm) === 0, clause.slice(0, 40));
  t('约束段要求不改周边', /不要改变周边参考区域/.test(clause), clause);
  t('约束段要求无可见边界', /可见边界/.test(clause), clause);
  t('约束段禁止边框暗角', /边框、暗角/.test(clause), clause);
  t('约束段要求像一次拍摄', /一次拍摄完成/.test(clause), clause);
  // 全局修改时不该说「别改周边」（整个画面都是要改的）
  const gClause = C.environmentClause({ isZh: true, envDesc: '', scope: 'global' });
  t('全局模式不提「周边参考区域」', !/不要改变周边参考区域/.test(gClause), gClause);
  t('environmentClause 对 null 安全', typeof C.environmentClause(null) === 'string');

  // 6) buildPrompt 集成：每次调用都要带上
  const withEnv = C.buildPrompt({
    instruction: '把这块换成花丛', style: 'natural', scope: 'region',
    centerPct: 80, language: 'zh', envDesc: darkWarm, envFit: true
  });
  t('提示词含环境特征', /周边环境的客观特征/.test(withEnv), withEnv.slice(0, 100));
  t('提示词保留用户指令', /换成花丛/.test(withEnv));
  t('提示词含行为约束', /不要改变周边参考区域/.test(withEnv));
  t('提示词仍要求只改描述内容', /只改动上面描述的内容/.test(withEnv));

  const withoutEnv = C.buildPrompt({
    instruction: '把这块换成花丛', style: 'natural', scope: 'region',
    centerPct: 80, language: 'zh', envFit: false
  });
  t('envFit=false 时不带环境特征', !/周边环境的客观特征/.test(withoutEnv), withoutEnv.slice(0, 80));
  t('envFit=false 时其它约束仍在', /只改动上面描述的内容/.test(withoutEnv));

  const noDesc = C.buildPrompt({
    instruction: '把这块换成花丛', style: 'natural', scope: 'region',
    centerPct: 80, language: 'zh', envFit: true, envDesc: ''
  });
  t('没有环境数据时优雅降级（不报错、不留空句）',
    noDesc.length > 0 && !/。。/.test(noDesc) && !/周边环境的客观特征/.test(noDesc), noDesc.slice(0, 80));

  // 英文提示词也要带上
  const enPrompt = C.buildPrompt({
    instruction: 'turn this into a flower bed', style: 'natural', scope: 'region',
    centerPct: 80, language: 'en', envDesc: en, envFit: true
  });
  t('英文提示词含环境特征', /Measured characteristics/.test(enPrompt), enPrompt.slice(0, 100));

  // 7) 提示词长度要克制（太长会稀释用户的指令）
  const len = withEnv.length;
  t('提示词长度可控（< 500 字）', len < 500, len);
  const envSeg = (/周边环境的客观特征[^。]*。/.exec(withEnv) || [''])[0];
  t('环境特征段不超过 150 字', envSeg.length < 150, envSeg.length);

  // 8) 接线检查
  const fs5 = require('fs');
  const appSrc5 = fs5.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const html5 = fs5.readFileSync(__dirname + '/../app/index.html', 'utf8');
  t('生成时测量周围环境', /measureSurroundings\(rect\)/.test(appSrc5));
  t('环境描述传给 buildPrompt', /envDesc,/.test(appSrc5));
  t('有环境契合开关', /envFit/.test(appSrc5));
  t('默认开启', /envFit: true,/.test(appSrc5));
  t('设置界面有开关', /id="set-envfit"/.test(html5));
  t('开关会持久化', /'envFit'/.test(appSrc5));
  t('测量失败时不影响生成',
    /function measureSurroundings[\s\S]{0,1200}catch \(e\)[\s\S]{0,200}return null/.test(appSrc5));
  t('测量前先检查画布存在', /function measureSurroundings[\s\S]{0,120}if \(!S\.docCanvas/.test(appSrc5));
  t('环带样本不足时放弃描述', /stats\.n < 20\) return null/.test(appSrc5));
})();
// ===== 环境契合块结束 =====


/* ---------- 环境契合提示词 ---------- */
// ===== 返回键分层处理（测试块） =====
(() => {
  const fs9 = require('fs');
  const appSrc = fs9.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const javaSrc = fs9.readFileSync(__dirname + '/../android/src/com/photostudio/app/MainActivity.java', 'utf8');

  /* ---------- 层级表 ---------- */

  t('返回层级表存在', Array.isArray(C.BACK_LAYERS) && C.BACK_LAYERS.length >= 8, C.BACK_LAYERS.length);
  // 顺序必须与 z-index 一致：后开的浮层压在上面，返回时先关它。
  // 顺序错了会出现「关掉了看不见的那个面板」这种怪事。
  // 新手教程是全屏引导，必须盖住一切（含「更多」下拉）——
  // 否则教程高亮圈会把菜单里的按钮圈出来，但菜单本身盖在蒙层上，看着像坏了
  t('新手教程在最前（z-index 最高）', C.BACK_LAYERS[0].id === 'tutorial', C.BACK_LAYERS[0].id);
  t('更多菜单次之（必须盖住所有面板，否则点不到）',
    C.BACK_LAYERS[1].id === 'moremenu', C.BACK_LAYERS[1].id);
  t('作品预览排第三', C.BACK_LAYERS[2].id === 'workPreview', C.BACK_LAYERS[2].id);
  t('层级表按 z-index 降序',
    C.BACK_LAYERS.every((L, i) => i === 0 || C.BACK_LAYERS[i - 1].z >= L.z),
    C.BACK_LAYERS.map((L) => L.id + ':' + L.z));
  t('对比图排在浮层之后', (() => {
    const ci = C.BACK_LAYERS.findIndex((L) => L.id === 'compare');
    const si = C.BACK_LAYERS.findIndex((L) => L.id === 'settings');
    return ci > si;
  })());
  t('生成失败说明在最后', C.BACK_LAYERS[C.BACK_LAYERS.length - 1].id === 'genError');
  t('每个层级都有中文名（用于提示）', C.BACK_LAYERS.every((L) => !!L.zh));

  /* ---------- 规划逻辑 ---------- */

  const P = (o) => C.planBackAction(o);

  t('无浮层+无照片 → 退出（交给系统）', P({}).handled === false && P({}).action === 'exit');
  t('空参数不崩', typeof P().handled === 'boolean');
  t('null 参数不崩', typeof C.planBackAction(null).handled === 'boolean');

  // 浮层优先
  t('设置开着 → 关设置', P({ open: { settings: true } }).target === 'settings');
  t('作品预览优先于设置', P({ open: { settings: true, workPreview: true } }).target === 'workPreview');
  t('多个浮层同时开着时关最上层', (() => {
    const r = P({ open: { library: true, history: true, layers: true } });
    return r.target === 'library';   // 表中 library 在 history/layers 之前
  })());
  t('对比图优先于失败说明', P({ open: { compare: true, genError: true } }).target === 'compare');
  t('浮层优先于取消生成', P({ open: { settings: true }, busy: true }).action === 'close');

  // 生成中
  t('生成中 → 取消生成', P({ busy: true }).action === 'cancel-gen');
  t('取消生成优先于模式切换', P({ busy: true, mode: 'brush' }).action === 'cancel-gen');
  t('取消生成优先于回首页', P({ busy: true, editing: true }).action === 'cancel-gen');

  // 工具模式
  t('画笔模式 → 退回框选', P({ mode: 'brush' }).action === 'mode');
  t('平移模式 → 退回框选', P({ mode: 'pan' }).action === 'mode');
  t('引导线模式 → 退回框选', P({ mode: 'guide' }).action === 'mode');
  t('已是框选则不处理模式', P({ mode: 'select', editing: true }).action === 'home');
  t('模式切换优先于回首页', P({ mode: 'brush', editing: true }).action === 'mode');

  // 编辑页
  t('编辑中 → 回首页', P({ editing: true }).action === 'home');
  t('回首页带中文说明', /首页/.test(P({ editing: true }).zh), P({ editing: true }).zh);

  // 优先级整体：浮层 > 生成 > 模式 > 编辑 > 退出
  t('完整优先级链', (() => {
    const full = { open: { settings: true }, busy: true, mode: 'brush', editing: true };
    if (P(full).action !== 'close') return false;
    if (P({ busy: true, mode: 'brush', editing: true }).action !== 'cancel-gen') return false;
    if (P({ mode: 'brush', editing: true }).action !== 'mode') return false;
    if (P({ editing: true }).action !== 'home') return false;
    return P({}).action === 'exit';
  })());

  /* ---------- 界面接线 ---------- */

  t('handleBack 已定义', /function handleBack/.test(appSrc));
  t('handleBack 已导出（安卓壳要调）', /handleBack,/.test(appSrc));
  t('handleBack 读取全部浮层状态',
    ['workPreview', 'settings', 'library', 'history', 'layers', 'photoinfo', 'exportpanel', 'compare', 'genError']
      .every((k) => appSrc.indexOf(k + ':') >= 0));
  t('handleBack 用 planBackAction 决策', /C\.planBackAction\(\{/.test(appSrc));
  t('关闭动作覆盖全部层级', (() => {
    const i = appSrc.indexOf("case 'close':");
    // 截到外层 switch 的下一个分支（内层 switch 的 case 缩进更深，用行首缩进区分）
    const rest = appSrc.slice(i);
    const next = rest.search(/\n        case '/);
    const body = next > 0 ? rest.slice(0, next) : rest.slice(0, 1200);
    return ['workPreview', 'settings', 'library', 'history', 'layers', 'photoinfo', 'exportpanel', 'compare', 'genError']
      .every((k) => body.indexOf("'" + k + "'") >= 0);
  })());
  // 取消生成：现在按「当前这张照片的任务」取消，不再用全局 aborter
  // （别的照片的后台任务必须继续跑，否则用户已经花的钱就白扔了）
  t('生成中取消走任务取消（只取消当前这张）',
    /case 'cancel-gen':[\s\S]{0,300}cancelJobsForCurrentDoc\(/.test(appSrc));
  t('模式动作回到框选', /case 'mode':[\s\S]{0,200}S\.mode = 'select'/.test(appSrc));
  t('编辑中回首页', /case 'home':[\s\S]{0,80}goHome\(\)/.test(appSrc));
  // 处理失败时返回 false（宁可退出，也不要让用户卡在按返回没反应的界面里）
  t('handleBack 异常时返回 false（不把用户卡住）',
    /catch \(e\) \{[\s\S]{0,300}return false;[\s\S]{0,40}\}/.test(appSrc));

  /* ---------- goHome：应用里原本没有「卸下照片」这条路 ---------- */

  t('goHome 已定义', /function goHome/.test(appSrc));
  // 最关键：卸载前必须先存档，否则用户「返回」一下就把刚才的修改丢了 ——
  // 那比退出应用更糟
  t('回首页前先保存作品', /function goHome[\s\S]{0,300}touchWork\(\)/.test(appSrc));
  // 回首页**不再**中止在途生成：任务要在后台跑完，结果落进作品记录。
  // 这是「一张图进 AI 生图后可以放在后台处理下一张」的核心改动。
  t('回首页不再中止在途生成（任务转后台）',
    !/function goHome[\s\S]{0,900}S\.aborter\.abort\(\)/.test(appSrc));
  t('回首页仍会让当前文档的操作序列作废',
    /function goHome[\s\S]{0,900}S\.genToken\+\+/.test(appSrc));
  t('回首页递增 genToken（作废旧结果）', /function goHome[\s\S]{0,900}S\.genToken\+\+/.test(appSrc));
  t('回首页清空照片状态', /S\.img = null;/.test(appSrc));
  t('回首页清空画布引用', /S\.viewCanvas = null; S\.viewCtx = null;/.test(appSrc));
  t('回首页清空编辑记录', /function goHome[\s\S]{0,1200}S\.edits = \[\];/.test(appSrc));
  t('回首页清空选区与笔迹', /S\.rect = null;[\s\S]{0,120}S\.strokes = \[\];/.test(appSrc));
  t('回首页清空引导线', /S\.guides = \[\];[\s\S]{0,60}S\.mode = 'select';/.test(appSrc));
  t('回首页复位顶栏文案', /未打开照片/.test(appSrc));
  t('回首页隐藏 HUD', /function goHome[\s\S]{0,2000}\$\('hud'\)\.hidden = true/.test(appSrc));
  t('回首页清理会话存档', /function goHome[\s\S]{0,2200}removeItem\(LS_KEY_SESSION\)/.test(appSrc));
  t('回首页切回首页布局', /function goHome[\s\S]{0,2400}renderHome\(\)[\s\S]{0,60}syncToolbar\(\)/.test(appSrc));
  t('回首页后重绘（不留旧画面）', /function goHome[\s\S]{0,3000}ctx\.clearRect/.test(appSrc));

  /* ---------- 安卓壳 ---------- */

  // 根因：单页应用里所有「页面」都是浮层，canGoBack() 永远 false，
  // 于是返回键被交给系统 → 从任何浮层按一下都直接退出应用
  t('安卓壳覆写了 onBackPressed', /public void onBackPressed\(\)/.test(javaSrc));
  t('返回键先问页面是否处理', /evaluateJavascript\(BACK_PROBE_JS/.test(javaSrc));
  t('页面处理了就不退出', /indexOf\("true"\) < 0\) callSuperBack\(\)/.test(javaSrc));
  t('页面异常时按未处理（交给系统退出，不卡住用户）',
    /value == null \|\| value\.indexOf\("true"\) < 0/.test(javaSrc));
  t('WebView 为空时直接退出', /if \(web == null\) \{[\s\S]{0,60}callSuperBack\(\)/.test(javaSrc));
  t('探针调用 handleBack', /__PS_API\.handleBack\(\)/.test(javaSrc));
  t('探针返回布尔值', /return !!\(window\.__PS_API/.test(javaSrc));
  // 构建用的 android.jar 不含 LambdaMetafactory，用 lambda 会编译失败
  t('回调用匿名内部类（lambda 会编译失败）',
    /new ValueCallback<String>\(\)/.test(javaSrc) && !/evaluateJavascript\([^)]*->/.test(javaSrc));
  t('已导入 ValueCallback', /import android\.webkit\.ValueCallback;/.test(javaSrc));
  t('super.onBackPressed 单独抽成方法（回调里不能 super）', /private void callSuperBack\(\)/.test(javaSrc));
})();
/* ---------- 返回键分层处理 ---------- */

// ===== 引导线自由笔迹 · 笔迹进图（测试块） =====
(() => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  const mk = (pts, extra) => C.planStrokeOverlay(Object.assign({
    guides: [{ kind: 'freehand', points: pts }],
    rect, ctxRect: rect, colorId: 'red', width: 3
  }, extra || {}));

  /* ---------- 类型与颜色表 ---------- */

  // 只有两类：直线 + 自由绘制。原来四种构图线（地平线/垂直线/对角线/主体位置）
  // 差别只在文字措辞上，画出来都是「一条线段」，要求用户先声明类型是多余负担。
  t('引导线只有两类', C.GUIDE_KINDS.length === 2, C.GUIDE_KINDS.length);
  t('两类是「直线」和「自由绘制」',
    C.GUIDE_KINDS.map((k) => k.id).join(',') === 'line,freehand');
  t('自由绘制被标记为 freehand', C.getGuideKind('freehand').freehand === true);
  t('直线不带 freehand 标记', C.getGuideKind('line').freehand !== true);
  t('isFreehandGuide 判定笔迹', C.isFreehandGuide({ kind: 'freehand' }) === true);
  t('isFreehandGuide 判定直线', C.isFreehandGuide({ kind: 'line' }) === false);
  t('isFreehandGuide 空值不崩', C.isFreehandGuide(null) === false);
  // 老数据（horizon 等）必须迁移成直线，不能静默变成别的类型
  t('旧类型迁移为直线', C.migrateGuideKind('horizon') === 'line' &&
    C.migrateGuideKind('vertical') === 'line' &&
    C.migrateGuideKind('diagonal') === 'line' &&
    C.migrateGuideKind('subject') === 'line');
  t('新类型不被迁移', C.migrateGuideKind('freehand') === 'freehand' &&
    C.migrateGuideKind('line') === 'line');
  t('老数据经 normalizeGuide 后是直线',
    C.normalizeGuide({ kind: 'horizon', x1: 0, y1: .5, x2: 1, y2: .5 }).kind === 'line');

  /* ---------- 颜色按序号自动分配 ---------- */

  t('六种颜色', C.GUIDE_COLORS.length === 6, C.GUIDE_COLORS.length);
  t('色序：红→青→黄→品红→绿→橙',
    C.GUIDE_COLORS.map((c) => c.id).join(',') === 'red,cyan,yellow,magenta,green,orange');
  t('每种颜色都有中文名与色值',
    C.GUIDE_COLORS.every((c) => c.zh && /^#[0-9a-f]{6}$/i.test(c.hex)));
  t('第 1 条是红色', C.guideColorAt(0).id === 'red');
  t('第 2 条是青色', C.guideColorAt(1).id === 'cyan');
  t('第 3 条是黄色', C.guideColorAt(2).id === 'yellow');
  t('超过六条循环回红色', C.guideColorAt(6).id === 'red');
  t('序号为负不崩（当作第 1 条）', C.guideColorAt(-3).id === 'red');
  t('取颜色', C.getStrokeColor('magenta').hex === '#ff2df0');
  t('未知颜色退化为红色', C.getStrokeColor('nope').id === 'red');
  t('颜色空值不崩', C.getStrokeColor(null).id === 'red');
  // 颜色必须跟着线条走：只按下标推的话，任何过滤/删除都会让后面的线整体换色
  t('colorOfGuide 优先用线条自带的颜色',
    C.colorOfGuide({ colorId: 'yellow' }, 0).id === 'yellow');
  t('colorOfGuide 没带颜色时按下标推',
    C.colorOfGuide({}, 1).id === 'cyan');
  // 下一条线的颜色：不能按长度推，否则删掉中间一条后会撞色
  t('空列表第一条是红色', C.nextGuideColor([]).id === 'red');
  t('已有红线时下一条是青色', C.nextGuideColor([{ colorId: 'red' }]).id === 'cyan');
  // 关键：删掉中间那条之后，长度会变小，按长度推就会撞上已有的黄色
  t('删过线之后补空缺颜色（不撞色）',
    C.nextGuideColor([{ colorId: 'red' }, { colorId: 'yellow' }]).id === 'cyan');
  t('六色用满后循环', C.nextGuideColor(C.GUIDE_COLORS.map((c) => ({ colorId: c.id }))).id === 'red');
  t('assignGuideColors 按序号配色',
    C.assignGuideColors([{}, {}, {}]).map((g) => g.colorId).join(',') === 'red,cyan,yellow');

  /* ---------- 笔迹数据 ---------- */

  t('笔迹保留 points', (() => {
    const g = C.normalizeGuide({ kind: 'freehand', points: [{ x: .1, y: .2 }, { x: .3, y: .4 }] });
    return g.points.length === 2 && g.points[0].x === .1;
  })());
  t('笔迹端点跟随折线（不是 0）', (() => {
    const g = C.normalizeGuide({ kind: 'freehand', points: [{ x: .3, y: .4 }, { x: .7, y: .8 }] });
    return g.x1 === .3 && g.y1 === .4 && g.x2 === .7 && g.y2 === .8;
  })());
  // 关键：笔迹点**不能**夹到 0~1。夹取会把越界部分压到边界，变成贴边假直线
  t('笔迹点不被夹取到 0~1（越界信息要保留）', (() => {
    const g = C.normalizeGuide({ kind: 'freehand', points: [{ x: -0.3, y: 1.5 }, { x: 2, y: 0.5 }] });
    return g.points[0].x === -0.3 && g.points[0].y === 1.5 && g.points[1].x === 2;
  })());
  t('笔迹点里的脏数据被丢掉', (() => {
    const g = C.normalizeGuide({ kind: 'freehand', points: [{ x: 1, y: 1 }, null, { x: 'a', y: 2 }, { x: .5, y: .5 }] });
    return g.points.length === 2;
  })());
  t('没有 points 时退化成两个端点', (() => {
    const g = C.normalizeGuide({ kind: 'freehand', x1: .1, y1: .2, x2: .3, y2: .4 });
    return g.points.length === 0 && g.x1 === .1;
  })());
  t('直线不产生 points', (() => {
    const g = C.normalizeGuide({ kind: 'line', x1: 0, y1: .5, x2: 1, y2: .5 });
    return g.points === undefined;
  })());
  t('颜色跟着线条一起归一化',
    C.normalizeGuide({ kind: 'line', colorId: 'green', x1: 0, y1: .5, x2: 1, y2: .5 })
      .colorId === 'green');
  t('脏颜色被纠正为合法值',
    C.normalizeGuide({ kind: 'line', colorId: 'nope', x1: 0, y1: .5, x2: 1, y2: .5 })
      .colorId === 'red');

  /* ---------- 吸附：笔迹不能被拉直 ---------- */

  // 拉直等于毁掉手画的弧度（头发会被掰成直线）
  t('笔迹不吸附（保留弧度）', (() => {
    const g = C.snapGuide({ kind: 'freehand', points: [{ x: .1, y: .5 }, { x: .5, y: .52 }, { x: .9, y: .5 }] });
    return g.points[1].y === .52;
  })());
  t('笔迹吸附后端点不变', (() => {
    const g = C.snapGuide({ kind: 'freehand', points: [{ x: .1, y: .5 }, { x: .9, y: .51 }] });
    return g.y1 === .5 && g.y2 === .51;
  })());
  t('直线仍然吸附到水平', (() => {
    const g = C.snapGuide({ kind: 'line', x1: .1, y1: .5, x2: .9, y2: .52 });
    return Math.abs(g.y2 - g.y1) < 1e-9;
  })());
  t('直线吸附到垂直', (() => {
    const g = C.snapGuide({ kind: 'line', x1: .5, y1: .1, x2: .52, y2: .9 });
    return Math.abs(g.x2 - g.x1) < 1e-9;
  })());
  // 只有一种直线类型了，吸附不该再改类型（以前会把「竖着画的地平线」改成垂直线）
  t('吸附不改类型（方向由坐标表达）',
    C.snapGuide({ kind: 'line', x1: .1, y1: .5, x2: .9, y2: .52 }).kind === 'line');

  /* ---------- 笔迹进图：坐标换算与裁剪 ---------- */

  t('完整在框内的笔迹原样保留', (() => {
    const p = mk([{ x: .2, y: .2 }, { x: .5, y: .5 }]);
    return p.count === 1 && p.draw[0].points[0].x === 20 && p.draw[0].points[1].y === 50;
  })());
  // 分块/越界的核心：必须真裁掉，不能压到边界
  t('越界部分被裁掉（不贴边拉直）', (() => {
    const p = mk([{ x: 0, y: .5 }, { x: .5, y: .5 }, { x: 1.5, y: .5 }]);
    return p.count === 1 && p.draw[0].points.length === 3 &&
      p.draw[0].points[2].x === 100;
  })());
  t('完全在框外的笔迹被丢弃', mk([{ x: 2, y: 2 }, { x: 3, y: 3 }]).count === 0);
  t('穿出去又回来的笔迹断成两段', mk([{ x: .2, y: .5 }, { x: .5, y: 2 }, { x: .8, y: .5 }]).count === 2);
  t('两端越界但横穿的笔迹保留', mk([{ x: -1, y: .5 }, { x: .5, y: .5 }, { x: 2, y: .5 }]).count === 1);
  // 这条最容易错：两个端点都在框外，但它穿过整个画面 —— 按「有没有点在框内」筛会整条丢掉
  t('纵向贯穿（两端都在框外）仍被保留', (() => {
    const p = mk([{ x: .5, y: -.2 }, { x: .5, y: 1.2 }]);
    return p.count === 1 && p.draw[0].points[0].y === 0 && p.draw[0].points[1].y === 100;
  })());
  t('斜向贯穿也被保留', mk([{ x: -.5, y: -.5 }, { x: 1.5, y: 1.5 }]).count === 1);
  t('从框外绕过去的笔迹被丢弃', mk([{ x: 2, y: .2 }, { x: 2, y: .8 }, { x: 3, y: .8 }]).count === 0);

  // 这是这次改动的核心：直线**也要画进请求图**。
  // 只写进提示词时模型只能猜位置，落位常常偏；画进图它就直接看得见。
  t('直线也画进请求图', C.planStrokeOverlay({
    guides: [{ kind: 'line', x1: 0, y1: .5, x2: 1, y2: .5 }],
    rect, ctxRect: rect
  }).count === 1);
  t('直线进图用的是两个端点', (() => {
    const p = C.planStrokeOverlay({
      guides: [{ kind: 'line', x1: 0, y1: .5, x2: 1, y2: .5 }],
      rect, ctxRect: rect
    });
    return p.draw[0].points.length === 2 &&
      p.draw[0].points[0].x === 0 && p.draw[0].points[0].y === 50 &&
      p.draw[0].points[1].x === 100;
  })());
  t('两类混在一起时都被画进去', C.planStrokeOverlay({
    guides: [
      { kind: 'line', x1: 0, y1: .3, x2: 1, y2: .3 },
      { kind: 'freehand', points: [{ x: .2, y: .7 }, { x: .8, y: .7 }] }
    ],
    rect, ctxRect: rect
  }).count === 2);
  // 颜色必须逐条对应：屏幕上第 2 条是青色，画进请求图的第 2 条也必须是青色
  t('两条线的颜色按序号分配（红、青）', (() => {
    const p = C.planStrokeOverlay({
      guides: [
        { kind: 'line', x1: 0, y1: .3, x2: 1, y2: .3 },
        { kind: 'line', x1: 0, y1: .7, x2: 1, y2: .7 }
      ],
      rect, ctxRect: rect
    });
    return p.draw[0].color === '#ff2d2d' && p.draw[1].color === '#00e5ff';
  })());
  t('颜色跟着线条自带的 colorId（不按下标硬推）', (() => {
    const p = C.planStrokeOverlay({
      guides: [
        { kind: 'line', colorId: 'yellow', x1: 0, y1: .3, x2: 1, y2: .3 },
        { kind: 'line', colorId: 'red', x1: 0, y1: .7, x2: 1, y2: .7 }
      ],
      rect, ctxRect: rect
    });
    return p.draw[0].color === '#ffe100' && p.draw[1].color === '#ff2d2d';
  })());
  t('直线进图时也会被裁剪（不贴边拉直）', (() => {
    const p = C.planStrokeOverlay({
      guides: [{ kind: 'line', x1: -.5, y1: .5, x2: 1.5, y2: .5 }],
      rect, ctxRect: rect
    });
    return p.count === 1 && p.draw[0].points[0].x === 0 && p.draw[0].points[1].x === 100;
  })());

  t('开关关闭时不画进图', (() => {
    const p = mk([{ x: .2, y: .2 }, { x: .8, y: .8 }], { enabled: false });
    return p.count === 0 && /关闭/.test(p.note);
  })());
  t('开关开启时给出说明', (() => {
    const p = mk([{ x: .2, y: .2 }, { x: .8, y: .8 }]);
    return /画进请求图/.test(p.note) && /红色/.test(p.note);
  })());
  // 说明里的颜色名必须和实际画进去的颜色一致（否则用户看到青色、提示词说红色）
  t('说明里的颜色名跟着实际颜色走', (() => {
    const p = mk([{ x: .2, y: .2 }, { x: .8, y: .8 }], {
      guides: [{ kind: 'freehand', colorId: 'cyan', points: [{ x: .2, y: .2 }, { x: .8, y: .8 }] }]
    });
    return /青色/.test(p.note) && p.colors[0].zh === '青色' && p.draw[0].color === '#00e5ff';
  })());
  t('两条线时说明里两种颜色都在', (() => {
    const p = C.planStrokeOverlay({
      guides: [
        { kind: 'line', x1: 0, y1: .3, x2: 1, y2: .3 },
        { kind: 'line', x1: 0, y1: .7, x2: 1, y2: .7 }
      ],
      rect, ctxRect: rect
    });
    return /红色/.test(p.note) && /青色/.test(p.note);
  })());
  t('颜色写进 draw 项（第 1 条红）', mk([{ x: .2, y: .2 }, { x: .8, y: .8 }])
    .draw[0].color === '#ff2d2d');
  t('自带 colorId 时以它为准', mk([{ x: .2, y: .2 }, { x: .8, y: .8 }], {
    guides: [{ kind: 'freehand', colorId: 'magenta', points: [{ x: .2, y: .2 }, { x: .8, y: .8 }] }]
  }).draw[0].color === '#ff2df0');
  t('线宽随图大小缩放', (() => {
    const big = C.planStrokeOverlay({
      guides: [{ kind: 'freehand', points: [{ x: .2, y: .2 }, { x: .8, y: .8 }] }],
      rect: { x: 0, y: 0, w: 2000, h: 2000 },
      ctxRect: { x: 0, y: 0, w: 2000, h: 2000 }, colorId: 'red'
    });
    return big.draw[0].width > 3;
  })());
  // 下限 4px 是实测出来的：2px 的细线经 JPEG 编码后从 698 个像素掉到 42 个，
  // 位置也糊掉了 —— 模型看不到笔迹，功能等于没做
  t('线宽下限 4px（细线会被 JPEG 压没）', (() => {
    const small = C.planStrokeOverlay({
      guides: [{ kind: 'freehand', points: [{ x: .2, y: .2 }, { x: .8, y: .8 }] }],
      rect: { x: 0, y: 0, w: 50, h: 50 },
      ctxRect: { x: 0, y: 0, w: 50, h: 50 }, colorId: 'red'
    });
    return small.draw[0].width >= 4;
  })());
  t('600px 图上线宽至少 5px', (() => {
    const p = C.planStrokeOverlay({
      guides: [{ kind: 'freehand', points: [{ x: .2, y: .2 }, { x: .8, y: .8 }] }],
      rect: { x: 0, y: 0, w: 600, h: 400 },
      ctxRect: { x: 0, y: 0, w: 600, h: 400 }, colorId: 'red'
    });
    return p.draw[0].width >= 5;
  })());
  t('planStrokeOverlay 空参数不崩', C.planStrokeOverlay().count === 0);

  // 分块：笔迹相对**整个选区**存储，换算必须以选区为基准
  t('分块时以选区为基准换算（不是瓦片）', (() => {
    const sel = { x: 0, y: 0, w: 200, h: 200 };
    const tile = { x: 0, y: 100, w: 200, h: 100 };
    const p = C.planStrokeOverlay({
      guides: [{ kind: 'freehand', points: [{ x: .2, y: .75 }, { x: .8, y: .75 }] }],
      rect: sel, ctxRect: tile, colorId: 'red', width: 3
    });
    return p.count === 1 && p.draw[0].points[0].y === 50;   // 瓦片高度的一半
  })());

  // 上下文外扩：笔迹坐标也要补偿，否则整体偏移
  t('有上下文外扩时补偿偏移', (() => {
    const sel = { x: 100, y: 100, w: 100, h: 100 };
    const ctxRect = { x: 88, y: 88, w: 124, h: 124 };
    const p = C.planStrokeOverlay({
      guides: [{ kind: 'freehand', points: [{ x: 0, y: .5 }, { x: 1, y: .5 }] }],
      rect: sel, ctxRect, colorId: 'red', width: 3
    });
    // 选区中线 y=150 → 请求图 (150-88)/124*124 = 62
    return p.count === 1 && p.draw[0].points[0].y === 62;
  })());

  /* ---------- 提示词：措辞必须区分「沿它生成」与「别画出来」 ---------- */

  const freeDesc = C.describeGuides({
    guides: [{ kind: 'freehand', points: [{ x: .2, y: .3 }, { x: .5, y: .5 }, { x: .8, y: .4 }] }],
    isZh: true
  });
  t('笔迹说明含「手绘走向」', /手绘走向/.test(freeDesc), freeDesc.slice(0, 60));
  t('笔迹说明要求沿笔迹生成内容', /沿着笔迹生成/.test(freeDesc));
  t('笔迹说明含颜色名（第 1 条是红色）', /红色/.test(freeDesc));
  t('笔迹说明明确禁止把线画进画面', /绝对不要把任何一条彩色线条画进最终画面/.test(freeDesc));
  t('笔迹说明描述走向', /基本横向|基本纵向|斜向|集中在一处/.test(freeDesc));
  t('笔迹说明描述范围（包围盒）', /横向 20%~80%/.test(freeDesc));
  t('笔迹说明不逐点念坐标', !/0\.2|0\.3/.test(freeDesc));
  t('笔迹说明举例了头发', /头发/.test(freeDesc));
  t('英文版也有对应措辞', (() => {
    const d = C.describeGuides({
      guides: [{ kind: 'freehand', points: [{ x: .2, y: .3 }, { x: .8, y: .4 }] }],
      isZh: false
    });
    return /Hand-drawn flow/.test(d) && /never draw any of these colored lines/i.test(d);
  })());
  // 颜色按序号走：第 4 条是品红色
  t('颜色名跟着序号走（第 4 条是品红）', /品红色/.test(C.describeGuides({
    guides: [
      { kind: 'line', x1: 0, y1: .1, x2: 1, y2: .1 },
      { kind: 'line', x1: 0, y1: .2, x2: 1, y2: .2 },
      { kind: 'line', x1: 0, y1: .3, x2: 1, y2: .3 },
      { kind: 'freehand', points: [{ x: .2, y: .8 }, { x: .8, y: .9 }] }
    ],
    isZh: true
  })));
  // 直线也要有说明（以前直线只写提示词、不进图，现在两者都要）
  const lineDesc = C.describeGuides({
    guides: [{ kind: 'line', x1: 0, y1: .6, x2: 1, y2: .6 }], isZh: true
  });
  t('直线说明含「构图引导」', /构图引导/.test(lineDesc), lineDesc.slice(0, 60));
  t('直线说明含序号与颜色', /第 1 条（红色，直线）/.test(lineDesc), lineDesc.slice(0, 120));
  t('直线说明含位置百分比', /60%/.test(lineDesc));
  t('直线说明含三分法参考', /三分之二处/.test(C.describeGuides({
    guides: [{ kind: 'line', x1: 0, y1: 2 / 3, x2: 1, y2: 2 / 3 }], isZh: true
  })));
  t('直线说明要求内容与线对齐', /必须落在这一条线上/.test(lineDesc));
  t('说明里明确「线是标注、不是画面内容」',
    /不是照片里真实存在的东西/.test(lineDesc));
  t('说明里禁止把线画进最终画面',
    /绝对不要把任何一条彩色线条画进最终画面/.test(lineDesc));
  // 直线和笔迹可以共存，两段说明都要在
  t('直线与笔迹共存时两段都在', (() => {
    const d = C.describeGuides({
      guides: [
        { kind: 'line', x1: 0, y1: .6, x2: 1, y2: .6 },
        { kind: 'freehand', points: [{ x: .2, y: .3 }, { x: .8, y: .4 }] }
      ], isZh: true
    });
    return /构图引导/.test(d) && /手绘走向/.test(d);
  })());
  t('只有笔迹时不出现构图引导段', !/构图引导/.test(freeDesc));
  // 混排时颜色序号必须按**原始顺序**，不能只数其中一类
  t('混排时颜色序号按原始顺序', (() => {
    const d = C.describeGuides({
      guides: [
        { kind: 'line', x1: 0, y1: .6, x2: 1, y2: .6 },
        { kind: 'freehand', points: [{ x: .2, y: .3 }, { x: .8, y: .4 }] }
      ], isZh: true
    });
    // 第 1 条（直线）红、第 2 条（笔迹）青
    return /第 1 条（红色，直线）/.test(d) && /（青色，/.test(d);
  })());

  /* ---------- 界面接线 ---------- */

  const fs8 = require('fs');
  const appSrc8 = fs8.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const html8 = fs8.readFileSync(__dirname + '/../app/index.html', 'utf8');

  t('HTML 没有颜色选择条（颜色按序号自动分配）', !/id="guide-colors"/.test(html8));
  t('HTML 有自由绘制专用提示', /id="guide-tip-free"/.test(html8));
  t('提示里说明了「会画进图片」', /会画进发给模型的图片/.test(html8));
  t('设置里有笔迹进图开关', /id="set-strokeimg"/.test(html8));
  t('设置里没有颜色选择（同上）', !/id="set-strokecolor"/.test(html8));
  t('设置里说明了颜色按顺序自动分配', /第 1 条红、第 2 条青/.test(html8));
  t('设置里说明了怎么应对「线被画出来」', /关掉上面的开关/.test(html8));
  t('开关会持久化', /'guideStrokeOverlay', 'barHeight'/.test(appSrc8));
  t('开关默认开启', /guideStrokeOverlay: true,/.test(appSrc8));
  // 颜色不再是配置项：按序号自动分配，用户选不了（选了就会撞色，指代失效）
  t('颜色不再是配置项', !/guideStrokeColor/.test(appSrc8));
  t('颜色选择器已从界面移除', !/id="guide-colors"/.test(html8));
  t('笔迹确实画进请求图', /C\.drawStrokeOverlay\(cx, sp\)/.test(appSrc8));
  // 引导线/开关/颜色现在由调用方**显式传入**（快照化，见后台生成任务一节）：
  // 请求在发起那一刻就固化，之后用户改引导线或切颜色都不该影响它。
  t('只在开关打开时画',
    /if \(strokeOn && jobGuides\.length\)/.test(appSrc8) &&
    /const strokeOn = \(strokeOverlay === undefined/.test(appSrc8));
  t('引导线来自显式传入的快照（不读模块状态）',
    /const jobGuides = \(guides !== undefined && guides !== null\) \? guides : S\.guides;/.test(appSrc8));
  t('换算以选区为基准（调用方显式传入）',
    /const strokeBase = baseRect \|\| rect;/.test(appSrc8) &&
    /rect: strokeBase,/.test(appSrc8));
  // 选区现在记在「任务」里（prepareJob → runGenerate 里赋给 lastSelRect），
  // 而任务自带的 job.rect 才是真正发出去的那份快照
  t('生成开始时记录选区', /lastSelRect = job\.rect;/.test(appSrc8));
  // 颜色名不再由调用方传：每条线自带 colorId，describeGuides 按它逐条指代。
  // 调用方另传一个全局颜色的话，两条线会被说成同一个颜色，指代就废了。
  t('颜色不再由调用方指定（跟着线条走）',
    /C\.describeGuides\(\{ guides: selGuides, isZh: lang === 'zh' \}\)/.test(appSrc8));
  t('笔迹绘制不画箭头圆点等装饰', !/arrow|arrowhead/i.test(
    appSrc8.slice(appSrc8.indexOf('function drawGuides'), appSrc8.indexOf('function screenToGuideNorm'))));
  // 屏幕、请求图、提示词三处必须用**同一个取色函数**，
  // 有一处各算各的就会出现「屏幕青色、提示词说红色」的致命错位
  t('屏幕颜色按序号取（与请求图同源）',
    /const c = C\.colorOfGuide\(g, i\);/.test(appSrc8) &&
    /const lineColor = c\.hex;/.test(appSrc8));
  t('屏幕上不再有写死的青色构图线', !/#3ddcc4/.test(appSrc8));
  t('请求自检里显示引导线状态', /引导线：/.test(appSrc8));
  t('拖动时对笔迹抽稀（防点数爆炸）', /minD/.test(appSrc8));
  t('单笔点数有硬上限', /pts\.length > 400/.test(appSrc8));
  t('笔迹按折线总长度判废（不是首尾距离）', /笔迹按「折线总长度」判废/.test(appSrc8));
})();
/* ---------- 引导线自由笔迹 ---------- */

// ===== 照片信息 · 引导线 · 导出设置（测试块） =====
(() => {
  /* ---------- 功能 1：照片信息（EXIF 解析 + 展示分组） ---------- */

  /** 造一个最小可用的 little-endian TIFF：IFD0 + ExifIFD */
  function makeTiff(entries0, entriesExif) {
    // 布局：[头 8B][IFD0][IFD0 数据区][ExifIFD][ExifIFD 数据区]
    const HEAD = 8;
    const ifd0Size = 2 + entries0.length * 12 + 4;
    const ifd0Off = HEAD;
    const data0Off = ifd0Off + ifd0Size;
    // 先算 IFD0 数据区大小
    const dataOf = (entries) => {
      let n = 0;
      for (const e of entries) {
        if (e.type === 2) n += e.str.length + 1;
        else if (e.type === 5 || e.type === 10) n += 8;
        else if (e.type === 3) n += 2;
        else if (e.type === 4 || e.type === 9) n += 4;
      }
      return n;
    };
    const exifOff = data0Off + dataOf(entries0);
    const exifSize = 2 + entriesExif.length * 12 + 4;
    const dataExifOff = exifOff + exifSize;
    const total = dataExifOff + dataOf(entriesExif);

    const b = new Uint8Array(total);
    const dv = new DataView(b.buffer);
    b[0] = 0x49; b[1] = 0x49; b[2] = 0x2a; b[3] = 0x00;   // II, 42
    dv.setUint32(4, ifd0Off, true);

    const writeIfd = (off, entries, dataOff) => {
      dv.setUint16(off, entries.length, true);
      let cursor = dataOff;
      entries.forEach((e, i) => {
        const eo = off + 2 + i * 12;
        dv.setUint16(eo, e.tag, true);
        dv.setUint16(eo + 2, e.type, true);
        if (e.type === 2) {
          dv.setUint32(eo + 4, e.str.length + 1, true);
          if (e.str.length + 1 <= 4) {
            for (let k = 0; k < e.str.length; k++) b[eo + 8 + k] = e.str.charCodeAt(k);
          } else {
            dv.setUint32(eo + 8, cursor, true);
            for (let k = 0; k < e.str.length; k++) b[cursor + k] = e.str.charCodeAt(k);
            cursor += e.str.length + 1;
          }
        } else if (e.type === 3) {
          dv.setUint32(eo + 4, 1, true);
          dv.setUint16(eo + 8, e.v, true);
        } else if (e.type === 4) {
          dv.setUint32(eo + 4, 1, true);
          dv.setUint32(eo + 8, e.v, true);
        } else if (e.type === 5) {
          dv.setUint32(eo + 4, 1, true);
          dv.setUint32(eo + 8, cursor, true);
          dv.setUint32(cursor, e.num, true);
          dv.setUint32(cursor + 4, e.den, true);
          cursor += 8;
        }
      });
      dv.setUint32(off + 2 + entries.length * 12, 0, true);   // 无下一个 IFD
    };
    writeIfd(ifd0Off, entries0, data0Off);
    writeIfd(exifOff, entriesExif, dataExifOff);
    return b;
  }

  const tiff = makeTiff([
    { tag: 0x010F, type: 2, str: 'Canon' },
    { tag: 0x0110, type: 2, str: 'Canon EOS R5' },
    { tag: 0x0112, type: 3, v: 1 },
    { tag: 0x0131, type: 2, str: 'Firmware 1.8.1' },
    { tag: 0x8769, type: 4, v: 8 + (2 + 5 * 12 + 4) + 0 }   // ExifIFD 指针（占位，下面修正）
  ], [
    { tag: 0x829A, type: 5, num: 1, den: 500 },
    { tag: 0x829D, type: 5, num: 28, den: 10 },
    { tag: 0x8827, type: 3, v: 800 },
    { tag: 0x9003, type: 2, str: '2024:09:23 15:42:07' },
    { tag: 0x920A, type: 5, num: 85, den: 1 },
    { tag: 0xA434, type: 2, str: 'RF85mm F1.2 L USM' }
  ]);
  // 修正 ExifIFD 指针（= 头 + IFD0 + IFD0 数据区）
  (() => {
    const dv = new DataView(tiff.buffer);
    const dataOf0 = 6 + 13 + 2 + 15 + 4;              // Canon / EOS R5 / SHORT / Firmware / LONG
    dv.setUint32(8 + 2 + 4 * 12 + 8, 8 + (2 + 5 * 12 + 4) + dataOf0, true);
  })();

  const ex = C.parseExifFields(tiff);
  t('EXIF 厂商', ex.make === 'Canon', ex.make);
  t('EXIF 机型', ex.model === 'Canon EOS R5', ex.model);
  t('EXIF 镜头', ex.lensModel === 'RF85mm F1.2 L USM', ex.lensModel);
  t('EXIF 快门 1/500', Math.abs(ex.exposureTime - 0.002) < 1e-9, ex.exposureTime);
  t('EXIF 光圈 f/2.8', Math.abs(ex.fNumber - 2.8) < 1e-9, ex.fNumber);
  t('EXIF ISO 800', ex.iso === 800, ex.iso);
  t('EXIF 焦距 85mm', Math.abs(ex.focalLength - 85) < 1e-9, ex.focalLength);
  t('EXIF 拍摄时间', ex.dateTimeOriginal === '2024:09:23 15:42:07', ex.dateTimeOriginal);
  t('EXIF 软件', ex.software === 'Firmware 1.8.1', ex.software);
  // 容错：损坏 / 空数据不能抛错
  t('EXIF 空数据返回 {}', Object.keys(C.parseExifFields(null)).length === 0);
  t('EXIF 短数据返回 {}', Object.keys(C.parseExifFields(new Uint8Array(3))).length === 0);
  t('EXIF 非法头返回 {}', Object.keys(C.parseExifFields(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).length === 0);
  t('EXIF 截断数据不抛错', (() => {
    try { C.parseExifFields(tiff.slice(0, 20)); return true; } catch (e) { return false; }
  })());

  // 时间格式化
  t('EXIF 时间 冒号→横线', C.formatExifDate('2024:09:23 15:42:07') === '2024-09-23 15:42:07');
  t('EXIF 时间 空值', C.formatExifDate('') === '' && C.formatExifDate(null) === '');
  t('EXIF 时间 非标准格式原样返回', C.formatExifDate('2024-09-23') === '2024-09-23');

  // 展示分组
  const groups = C.describePhotoInfo({
    exif: ex, width: 8192, height: 5464, sizeBytes: 24 * 1024 * 1024,
    fileName: 'DSC01234.jpg', mime: 'image/jpeg', icc: true, iccIsSrgb: true
  });
  const gname = groups.map((g) => g.group);
  t('信息分组含文件', gname.indexOf('文件') >= 0, gname);
  t('信息分组含拍摄设备', gname.indexOf('拍摄设备') >= 0, gname);
  t('信息分组含拍摄参数', gname.indexOf('拍摄参数') >= 0, gname);
  t('信息分组含时间', gname.indexOf('时间') >= 0, gname);
  const find = (g, label) => {
    const grp = groups.find((x) => x.group === g);
    if (!grp) return null;
    const it = grp.items.find((x) => x.label === label);
    return it ? it.value : null;
  };
  t('显示尺寸', find('文件', '尺寸') === '8192 × 5464 像素', find('文件', '尺寸'));
  t('显示像素数', find('文件', '像素数') === '44.8 MP', find('文件', '像素数'));
  t('显示机型不重复厂商名', find('拍摄设备', '相机 / 手机') === 'Canon EOS R5', find('拍摄设备', '相机 / 手机'));
  t('显示光圈', find('拍摄参数', '光圈') === 'f/2.8', find('拍摄参数', '光圈'));
  t('显示快门为分数', find('拍摄参数', '快门') === '1/500 秒', find('拍摄参数', '快门'));
  t('显示 ISO', find('拍摄参数', 'ISO') === 'ISO 800', find('拍摄参数', 'ISO'));
  t('显示焦距', find('拍摄参数', '焦距') === '85 mm', find('拍摄参数', '焦距'));
  t('显示拍摄时间（已格式化）', find('时间', '拍摄时间') === '2024-09-23 15:42:07', find('时间', '拍摄时间'));
  t('显示色彩配置', find('色彩与方向', '色彩配置') === 'sRGB（标准）', find('色彩与方向', '色彩配置'));
  // 厂商名已在机型里时不再重复拼
  t('机型含厂商时不重复', (() => {
    const g = C.describePhotoInfo({ exif: { make: 'SONY', model: 'SONY ILCE-7M4' } });
    const grp = g.find((x) => x.group === '拍摄设备');
    return grp.items[0].value === 'SONY ILCE-7M4';
  })());
  // 空 EXIF：只显示文件信息，不崩
  t('无 EXIF 时只剩文件组', (() => {
    const g = C.describePhotoInfo({ width: 100, height: 100, fileName: 'a.png' });
    return g.length === 1 && g[0].group === '文件';
  })());
  t('完全空参数不崩', Array.isArray(C.describePhotoInfo()) && C.describePhotoInfo().length === 0);
  // GPS 只提示不显示坐标（隐私）
  t('有 GPS 时提示隐私', (() => {
    const g = C.describePhotoInfo({ exif: { hasGps: true }, width: 10, height: 10 });
    const grp = g.find((x) => x.group === '隐私');
    return !!grp && /GPS/.test(grp.items[0].value);
  })());
  t('无 GPS 时不出现隐私组',
    C.describePhotoInfo({ exif: {}, width: 10, height: 10 }).every((g) => g.group !== '隐私'));
  // 曝光时间 >= 1 秒时不用分数（长曝光）
  t('长曝光显示秒数', (() => {
    const g = C.describePhotoInfo({ exif: { exposureTime: 30 }, width: 10, height: 10 });
    return g.find((x) => x.group === '拍摄参数').items[0].value === '30.0 秒';
  })());
  // 等效焦距与原焦距差 1mm 以内时不重复显示
  t('等效焦距接近时不重复', (() => {
    const g = C.describePhotoInfo({ exif: { focalLength: 85, focalLength35: 85.4 }, width: 10, height: 10 });
    return g.find((x) => x.group === '拍摄参数').items[0].value === '85 mm';
  })());
  t('等效焦距差异大时显示', (() => {
    const g = C.describePhotoInfo({ exif: { focalLength: 50, focalLength35: 75 }, width: 10, height: 10 });
    return g.find((x) => x.group === '拍摄参数').items[0].value === '50 mm（等效 75 mm）';
  })());

  /* ---------- 功能 3：引导线 ---------- */

  t('引导线只有两类（直线 + 自由绘制）', C.GUIDE_KINDS.length === 2);
  t('取引导线类型', C.getGuideKind('line').zh === '直线');
  t('未知类型退化为第一种', C.getGuideKind('nope').id === 'line');
  t('未知类型 null 也不崩', C.getGuideKind(null).id === 'line');
  // 归一化：夹取端点
  t('归一化夹取越界端点', (() => {
    const g = C.normalizeGuide({ kind: 'line', x1: -1, y1: 2, x2: 3, y2: -5 });
    return g.x1 === 0 && g.y1 === 1 && g.x2 === 1 && g.y2 === 0;
  })());
  t('归一化补齐缺失字段', (() => {
    const g = C.normalizeGuide({});
    return g.kind === 'line' && g.x1 === 0 && g.y1 === 0 && g.x2 === 0 && g.y2 === 0;
  })());
  t('归一化空值不崩', C.normalizeGuide(null).kind === 'line');

  t('水平判定', C.guideOrientation({ x1: 0, y1: .5, x2: 1, y2: .5 }) === 'horizontal');
  t('垂直判定', C.guideOrientation({ x1: .5, y1: 0, x2: .5, y2: 1 }) === 'vertical');
  t('斜向判定', C.guideOrientation({ x1: 0, y1: 0, x2: 1, y2: 1 }) === 'diagonal');
  t('点判定（零长度）', C.guideOrientation({ x1: .5, y1: .5, x2: .5, y2: .5 }) === 'point');

  // 构图说明
  const gdesc = C.describeGuides({
    guides: [{ kind: 'line', x1: 0, y1: .62, x2: 1, y2: .62 }], isZh: true
  });
  t('引导线说明含百分比位置', /62%/.test(gdesc), gdesc);
  t('引导线说明含「构图引导」', /构图引导/.test(gdesc));
  t('引导线说明要求不要画出线条', /不要.*画进最终画面/.test(gdesc));
  t('三分法位置会点名', /三分之一处|三分之二处/.test(C.describeGuides({
    guides: [{ kind: 'line', x1: 0, y1: 1 / 3, x2: 1, y2: 1 / 3 }], isZh: true
  })));
  t('居中位置会点名', /居中/.test(C.describeGuides({
    guides: [{ kind: 'line', x1: .5, y1: 0, x2: .5, y2: 1 }], isZh: true
  })));
  t('英文版输出英文', /Composition guides/.test(C.describeGuides({
    guides: [{ kind: 'line', x1: 0, y1: .6, x2: 1, y2: .6 }], isZh: false
  })));
  t('空引导线返回空串', C.describeGuides({ guides: [], isZh: true }) === '');
  t('无参数返回空串', C.describeGuides() === '');
  // 方向不再靠类型表达，而是按实际角度说清楚（横/竖/斜）
  t('竖向直线说明为纵向', /基本纵向/.test(C.describeGuides({
    guides: [{ kind: 'line', x1: .5, y1: .1, x2: .5, y2: .9 }], isZh: true
  })));
  t('斜线说明为斜向', /斜向/.test(C.describeGuides({
    guides: [{ kind: 'line', x1: 0, y1: 1, x2: 1, y2: 0 }], isZh: true
  })));
  t('多条引导线都写进说明', (() => {
    const d = C.describeGuides({
      guides: [
        { kind: 'line', x1: 0, y1: .3, x2: 1, y2: .3 },
        { kind: 'line', x1: .7, y1: 0, x2: .7, y2: 1 }
      ], isZh: true
    });
    return /第 1 条（红色，直线）/.test(d) && /第 2 条（青色，直线）/.test(d) && /2 条/.test(d);
  })());
  // 每条线的颜色都必须在提示词里出现一次 —— 指代唯一是这个设计的全部意义
  t('每条线的颜色都在说明里', (() => {
    const d = C.describeGuides({
      guides: [
        { kind: 'line', x1: 0, y1: .2, x2: 1, y2: .2 },
        { kind: 'line', x1: 0, y1: .4, x2: 1, y2: .4 },
        { kind: 'line', x1: 0, y1: .6, x2: 1, y2: .6 }
      ], isZh: true
    });
    return /红色/.test(d) && /青色/.test(d) && /黄色/.test(d);
  })());

  // 坐标换算：引导线存在「相对选区」的坐标系里，发请求前必须换算到请求图坐标
  t('mapGuides 无外扩时原样', (() => {
    const r = C.mapGuidesToRequest({
      guides: [{ kind: 'horizon', x1: 0, y1: .5, x2: 1, y2: .5 }],
      rect: { x: 0, y: 0, w: 100, h: 100 }, ctxRect: { x: 0, y: 0, w: 100, h: 100 }
    });
    return r.length === 1 && Math.abs(r[0].y1 - .5) < 1e-9 && Math.abs(r[0].y2 - .5) < 1e-9;
  })());
  // 关键：有上下文外扩时必须补偿，否则引导线位置整体偏移
  t('mapGuides 外扩时补偿偏移', (() => {
    const r = C.mapGuidesToRequest({
      guides: [{ kind: 'horizon', x1: 0, y1: .5, x2: 1, y2: .5 }],
      rect: { x: 100, y: 100, w: 100, h: 100 },
      ctxRect: { x: 88, y: 88, w: 124, h: 124 }     // 上下左右各外扩 12
    });
    // 引导线在文档坐标 y = 100 + 50 = 150 → 请求图 (150-88)/124 = 0.5
    return Math.abs(r[0].y1 - 0.5) < 1e-9;
  })());
  t('mapGuides 外扩时横向也补偿', (() => {
    const r = C.mapGuidesToRequest({
      guides: [{ kind: 'vertical', x1: .25, y1: 0, x2: .25, y2: 1 }],
      rect: { x: 100, y: 100, w: 100, h: 100 },
      ctxRect: { x: 88, y: 88, w: 124, h: 124 }
    });
    // x = 100 + 25 = 125 → (125-88)/124
    return Math.abs(r[0].x1 - (37 / 124)) < 1e-9;
  })());
  t('mapGuides 结果夹在 0~1', (() => {
    const r = C.mapGuidesToRequest({
      guides: [{ kind: 'horizon', x1: -5, y1: -5, x2: 9, y2: 9 }],
      rect: { x: 0, y: 0, w: 100, h: 100 }, ctxRect: { x: 0, y: 0, w: 100, h: 100 }
    });
    return r[0].x1 === 0 && r[0].y1 === 0 && r[0].x2 === 1 && r[0].y2 === 1;
  })());
  t('mapGuides 空列表返回空数组', C.mapGuidesToRequest({ guides: [], rect: {}, ctxRect: {} }).length === 0);
  t('mapGuides 无参数不崩', C.mapGuidesToRequest().length === 0);
  // 分块：块外的线必须丢掉，否则 clamp 会把它压到边缘，模型以为「地平线在图最上边」
  t('分块时丢掉块外的引导线', (() => {
    const r = C.mapGuidesToRequest({
      guides: [{ kind: 'horizon', x1: 0, y1: .05, x2: 1, y2: .05 }],
      rect: { x: 0, y: 0, w: 200, h: 200 },
      ctxRect: { x: 0, y: 100, w: 200, h: 100 },   // 只看下半块
      clip: true
    });
    return r.length === 0;
  })());
  t('分块时保留块内的引导线', (() => {
    const r = C.mapGuidesToRequest({
      guides: [{ kind: 'horizon', x1: 0, y1: .75, x2: 1, y2: .75 }],
      rect: { x: 0, y: 0, w: 200, h: 200 },
      ctxRect: { x: 0, y: 100, w: 200, h: 100 },
      clip: true
    });
    return r.length === 1 && Math.abs(r[0].y1 - 0.5) < 1e-9;
  })());
  t('不开 clip 时行为不变（向后兼容）', (() => {
    const r = C.mapGuidesToRequest({
      guides: [{ kind: 'horizon', x1: 0, y1: .05, x2: 1, y2: .05 }],
      rect: { x: 0, y: 0, w: 200, h: 200 },
      ctxRect: { x: 0, y: 100, w: 200, h: 100 }
    });
    return r.length === 1 && r[0].y1 === 0;
  })());

  // buildPrompt 接入引导线
  const gp = C.buildPrompt({
    instruction: '换天空', language: 'zh', scope: 'region',
    guideDesc: '【构图引导】地平线在 62%'
  });
  t('buildPrompt 带上引导线说明', /构图引导/.test(gp), gp.slice(0, 80));
  t('buildPrompt 没有引导线时不受影响', !/构图引导/.test(C.buildPrompt({ instruction: '换天空', language: 'zh' })));
  t('引导线说明排在「只改动」之前（模型更当回事）', (() => {
    const s2 = C.buildPrompt({ instruction: 'x', language: 'zh', guideDesc: '引导段' });
    return s2.indexOf('引导段') < s2.indexOf('只改动上面描述的内容');
  })());

  /* ---------- 功能 4：导出设置（格式 / 大小） ---------- */

  t('导出格式含 JPEG', C.EXPORT_FORMATS.some((f) => f.id === 'jpeg'));
  t('导出格式含 PNG', C.EXPORT_FORMATS.some((f) => f.id === 'png'));
  t('导出尺寸档位非空', C.EXPORT_SIZES.length > 0);
  t('尺寸档位含原图', C.EXPORT_SIZES.some((s2) => s2.maxSide === 0));
  // 界面从「原始尺寸」往下排，所以正数档位是降序的（大 → 小）
  t('尺寸档位按从大到小', (() => {
    const v = C.EXPORT_SIZES.map((s2) => s2.maxSide).filter((x) => x > 0);
    for (let i = 1; i < v.length; i++) if (v[i] > v[i - 1]) return false;
    return true;
  })());
  t('原始尺寸排在第一个', C.EXPORT_SIZES[0].maxSide === 0);

  const cp = C.makeCustomPreset({ format: 'jpeg', maxSide: 2000, quality: 0.9 });
  t('自定义预设 id', cp.id === 'custom');
  t('自定义预设格式', cp.format === 'jpeg');
  t('自定义预设长边', cp.maxSide === 2000);
  t('自定义预设质量', Math.abs(cp.quality - 0.9) < 1e-9);
  t('PNG 时质量无意义置 1', C.makeCustomPreset({ format: 'png', quality: 0.7 }).quality === 1);
  t('质量低于 60% 被抬到 60%', Math.abs(C.makeCustomPreset({ format: 'jpeg', quality: 0.1 }).quality - 0.6) < 1e-9);
  t('质量高于 1 被夹到 1', C.makeCustomPreset({ format: 'jpeg', quality: 5 }).quality === 1);
  t('长边负数夹到 0', C.makeCustomPreset({ maxSide: -100 }).maxSide === 0);
  t('长边超大夹到 16384', C.makeCustomPreset({ maxSide: 999999 }).maxSide === 16384);
  t('未知格式退化为 JPEG', C.makeCustomPreset({ format: 'bmp' }).format === 'jpeg');
  t('自定义预设默认保留元数据', (() => {
    const p = C.makeCustomPreset({});
    return p.keepExif === true && p.keepGps === true && p.keepIcc === true;
  })());
  t('自定义预设可关闭元数据', C.makeCustomPreset({ keepExif: false }).keepExif === false);
  t('空参数不崩', C.makeCustomPreset().id === 'custom');

  // 尺寸规划 + 提示
  const h1 = C.planExportWithHint(6000, 4000, C.makeCustomPreset({ maxSide: 2000 }));
  t('缩放：6000→2000', h1.w === 2000 && h1.h === 1333, [h1.w, h1.h]);
  t('缩放时给出说明', /2000/.test(h1.hint), h1.hint);
  // 关键：小图不能放大（会糊）
  const h2 = C.planExportWithHint(1200, 800, C.makeCustomPreset({ maxSide: 4000 }));
  t('小图不放大', h2.w === 1200 && h2.h === 800, [h2.w, h2.h]);
  t('不放大时说明为什么', /原图|放大|1200/.test(h2.hint), h2.hint);
  const h3 = C.planExportWithHint(3000, 2000, C.makeCustomPreset({ maxSide: 0 }));
  t('原尺寸不缩放', h3.w === 3000 && h3.h === 2000);
  t('尺寸规划空参数不崩', C.planExportWithHint(0, 0, null).w >= 0);

  // 体积预估
  const eJ = C.estimateExportSize({ w: 3000, h: 2000, format: 'jpeg', quality: 0.95 });
  t('JPEG 体积预估有数字', eJ.bytes > 0, eJ);
  t('JPEG 体积预估有文案', typeof eJ.text === 'string' && eJ.text.length > 0, eJ.text);
  const eP = C.estimateExportSize({ w: 3000, h: 2000, format: 'png' });
  t('PNG 预估大于同尺寸 JPEG', eP.bytes > eJ.bytes, [eP.bytes, eJ.bytes]);
  t('体积随尺寸增长', C.estimateExportSize({ w: 6000, h: 4000, format: 'jpeg', quality: 0.95 }).bytes >
    C.estimateExportSize({ w: 1500, h: 1000, format: 'jpeg', quality: 0.95 }).bytes);
  t('JPEG 质量越高体积越大', C.estimateExportSize({ w: 3000, h: 2000, format: 'jpeg', quality: 1 }).bytes >
    C.estimateExportSize({ w: 3000, h: 2000, format: 'jpeg', quality: 0.6 }).bytes);
  t('体积预估空参数不崩', C.estimateExportSize().bytes >= 0);

  // planExportMetadata 尊重面板选项
  const fakeMeta = { source: 'jpeg', exif: { make: 'Canon' }, icc: new Uint8Array([1]), iccIsSrgb: true };
  t('关闭 EXIF 时不写入', C.planExportMetadata(fakeMeta, C.makeCustomPreset({ keepExif: false })).exif === null);
  t('保留 EXIF 时写入', C.planExportMetadata(fakeMeta, C.makeCustomPreset({ keepExif: true })).exif !== null);
  t('关闭 ICC 时不写入', C.planExportMetadata(fakeMeta, C.makeCustomPreset({ keepIcc: false })).icc === null);

  /* ---------- 界面接线（防止逻辑写好了但没接上） ---------- */
  const fs7 = require('fs');
  const appSrc7 = fs7.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const html7 = fs7.readFileSync(__dirname + '/../app/index.html', 'utf8');
  const css7 = fs7.readFileSync(__dirname + '/../app/style.css', 'utf8');
  const coreSrc = fs7.readFileSync(__dirname + '/../app/core.js', 'utf8');

  // 首页 = 修改历史
  t('HTML 有首页容器', /id="home"/.test(html7));
  t('首页标题是「修改历史」', /修改历史/.test(html7));
  t('首页可跳去修新照片', /id="btn-home-pick"/.test(html7));
  t('首页复用作品库数据', /C\.groupWorksByDay\(S\.library/.test(appSrc7));
  t('有照片时首页自动收起', /const showHome = !S\.img;/.test(appSrc7));
  t('启动时渲染首页', /bind\(\);[\s\S]{0,300}renderHome\(\)/.test(appSrc7));
  t('启动时同步工具栏', /bind\(\);[\s\S]{0,300}syncToolbar\(\)/.test(appSrc7));
  t('打开照片后展开工具栏', /renderHome\(\);\s*\n\s*syncToolbar\(\);/.test(appSrc7));
  // 收起/展开由高度驱动（用户可拖动调节），class 只用于视觉提示
  // 收起意图可以显式传入（首页不该有工具栏），没传时才由高度推导 ——
  // 避免依赖一次可能失败的测量（display:none / 内核不做布局时测不到高度）
  t('收起状态可显式指定，否则按高度判定',
    /const collapsed = o\.collapsed !== undefined \? !!o\.collapsed : plan\.collapsed;/.test(appSrc7));
  t('首页收起是显式意图', /collapseToolbar\(animate, save\)[\s\S]{0,120}collapsed: true/.test(appSrc7));
  t('测量失败有兜底高度（否则状态机全坏）', /BAR_FALLBACK_FULL/.test(appSrc7));
  t('CSS 有收起态', /#bottombar\.collapsed/.test(css7));
  t('CSS 有高度过渡', /#bottombar \{[\s\S]{0,400}transition: max-height/.test(css7));

  /* ---------- 工具栏自由调节高度 ---------- */

  t('工具栏有拖动手柄', /id="bar-handle"/.test(html7));
  t('手柄里有箭头按钮', /id="bar-toggle"/.test(html7));
  t('手柄有抓握提示条', /class="grip"/.test(html7));
  t('工具栏内容包在可测高度的容器里', /id="bar-body"/.test(html7));
  t('轻点手柄可收起/展开', /function bindBarHandle/.test(appSrc7));
  t('拖动改变高度', /applyBarHeight\(drag\.h0 \+ dy, false\)/.test(appSrc7));
  t('拖动阈值避免误判（轻点与拖动共存）', /Math\.abs\(dy\) > 6/.test(appSrc7));
  // 无极拖动：松手停在哪里就是哪里，**不再**吸附到收起/展开两档。
  // 旧实现吸附，于是用户想露出「工具行 + 一点参数」这种中间高度时，
  // 一松手就被弹走，感觉像在拨档位 —— 这正是要修掉的问题。
  t('拖动无级：松手停在松手位置（不吸附档位）',
    /applyBarHeight\(h, \{ animate: false, collapsed: C\.isBarCollapsed\(h, full\), save: true \}\);/.test(appSrc7) &&
    !/const target = collapsed \? C\.BAR_MIN : full;/.test(appSrc7));
  t('无极拖动仍保留轻点切换（两档是轻点的行为，不是拖动的）',
    /if \(C\.isBarCollapsed\(h, full\)\) expandToolbar\(undefined, false\);/.test(appSrc7) &&
    /else collapseToolbar\(undefined, false\);/.test(appSrc7));
  // 轻点必须**不保存**：它是「现在想多看一点照片」的临时动作。
  // 若轻点也存下高度，用户收一次之后每张照片都从收起态打开 ——
  // 他以为只是临时收了一下，实际成了永久设置。
  t('轻点收起/展开不写配置（临时动作不覆盖偏好）',
    !/expandToolbar\(undefined, true\)/.test(appSrc7) &&
    !/collapseToolbar\(undefined, true\)/.test(appSrc7));
  t('箭头按钮同样只做临时切换', /expandToolbar\(undefined, false\)[\s\S]{0,200}collapseToolbar\(undefined, false\)/.test(appSrc7));
  t('高度会记住（换图不重置）', /function saveBarHeight/.test(appSrc7) &&
    /S\.cfg\.barHeight = S\.toolbarHeight;/.test(appSrc7));
  // 中间高度也是用户的偏好：以前只有两档，收起记 0 表示「下次展开」；
  // 现在若仍记 0，用户辛苦拖出来的高度下次打开就没了
  t('中间高度也要记住（不再把矮高度记成 0）',
    !/S\.cfg\.barHeight = S\.toolbarVisible \? S\.toolbarHeight : 0;/.test(appSrc7));
  t('拖动结束才保存（不在 pointermove 里写存储）', /save: true \}\);/.test(appSrc7) &&
    !/applyBarHeight\(drag\.h0 \+ dy, true\)/.test(appSrc7));
  t('轻点切换不保存（见上：临时动作不覆盖偏好高度）',
    /expandToolbar\(undefined, false\)/.test(appSrc7));
  t('barHeight 纳入持久化', /'guideStrokeOverlay', 'barHeight',/.test(appSrc7));
  t('barHeight 有类型校正', /c\.barHeight = clampNum\(c\.barHeight, 0, 2000, 0\);/.test(appSrc7));
  t('进编辑页沿用上次高度', /const saved = Number\(S\.cfg\.barHeight\)/.test(appSrc7));
  t('高度用 maxHeight（内容变矮时自然收缩）', /bar\.style\.maxHeight = plan\.height/.test(appSrc7));
  t('高度变化后重算画布', /resizeCanvas\(\);[\s\S]{0,120}return Object\.assign/.test(appSrc7));
  t('CSS 有手柄样式', /#bar-handle/.test(css7));
  t('收起时箭头翻转提示可展开', /#bottombar\.collapsed \.bar-chev svg \{ transform: rotate\(180deg\)/.test(css7));
  t('收起态不再用 pointer-events:none（工具行仍可点）',
    !/#bottombar\.collapsed \{[^}]*pointer-events: none/.test(css7));
  t('手柄有 no-flex-gap 兜底', /\.ps-no-flex-gap #bar-handle/.test(css7));

  /* ---------- 没有框选时默认处理整张图 ---------- */

  // 需求：「没有框选的时候默认对整张图片进行调整」，且所有操作都算（含 AI 生图）。
  // 关键是**收敛到唯一一个解析函数**：15 处 `if (!S.rect) toast(...)` 各写各的
  // 必然出现「AI 生图能整图、调色却说我还没框选」这种不一致。
  t('core 有整张图矩形构造', /function wholeRect\(W, H\)/.test(coreSrc) &&
    /wholeRect, isWholeRect,/.test(coreSrc));
  t('core 有整张图判定', /function isWholeRect\(rect, W, H\)/.test(coreSrc));
  t('app 有统一的「实际处理区域」解析', /function effectiveRect\(\)/.test(appSrc7));
  t('没有选区时解析成整张图', /if \(S\.rect\) return C\.clampRect\(S\.rect, S\.docW, S\.docH\);[\s\S]{0,80}return C\.wholeRect\(S\.docW, S\.docH\);/.test(appSrc7));
  // 不能写回 S.rect：否则画面上会凭空多出一个铺满全图的选区框，
  // 而且后续拖动变成「在整图上拖手柄」——用户只是没框选，不该被塞一个选区
  t('解析结果不写回选区（不凭空多出选区框）',
    /function effectiveRect\(\)[\s\S]{0,600}?\n  \}/.test(appSrc7) &&
    !/function effectiveRect\(\)[\s\S]{0,600}S\.rect = C\.wholeRect/.test(appSrc7));
  t('有整图判定包装', /function editingWholeImage\(rect\)/.test(appSrc7));

  // 四个工具入口都要接受「没有选区」
  t('AI 生图不要求先框选', /function generate\(\)[\s\S]{0,400}if \(!effectiveRect\(\)\)/.test(appSrc7) &&
    !/function generate\(\)[\s\S]{0,400}toast\('先在照片上框选要修改的位置'\)/.test(appSrc7));
  t('生成按钮不再要求选区', /btn-generate'\)\.disabled = on \|\| !S\.img \|\| !S\.docCanvas;/.test(appSrc7));
  t('成本预估照常给（整图也要能看要花多少钱）',
    /function currentEstimate\(\)[\s\S]{0,300}const rect = effectiveRect\(\);/.test(appSrc7));
  t('调色不要求先框选', /function openGradeTool\(rect\)[\s\S]{0,500}if \(!effectiveRect\(\)\)/.test(appSrc7) &&
    !/function openGradeTool[\s\S]{0,400}toast\('先在照片上框选要调色的区域'\)/.test(appSrc7));
  t('调色预览与应允都用整图', /function previewGrade\(\)[\s\S]{0,400}const rect = effectiveRect\(\);/.test(appSrc7) &&
    /function applyGrade\(\)[\s\S]{0,400}const rect = effectiveRect\(\);/.test(appSrc7));
  t('画笔不要求先框选', /const rect = effectiveRect\(\);\s*\n\s*if \(!rect\) \{ toast\('先打开一张照片'\); return; \}\s*\n\s*if \(!C\.pointInRect\(ip, rect\)/.test(appSrc7));
  t('引导线不要求先框选', /function drawGuides\(dim\)[\s\S]{0,400}const rect = effectiveRect\(\);/.test(appSrc7));
  t('引导线命中测试用同一基准', /function hitGuide\(p\)[\s\S]{0,400}const rect = effectiveRect\(\);/.test(appSrc7));
  t('引导线归一化用同一基准', /function screenToGuideNorm\(p\)[\s\S]{0,400}const rect = effectiveRect\(\);/.test(appSrc7));
  t('整图时提示词走整体口径（不能说是局部裁切）',
    /scope: whole \? 'global' : \$\('scope-select'\)\.value,/.test(appSrc7));
  t('整图时界面明示「整张图」', /hud-pill whole/.test(appSrc7) && /未框选 → 调整整张图；/.test(appSrc7));

  // 整张图**没有周围环境**：羽化/色彩匹配/融合都必须关掉，否则会出现
  // 「四周留一圈没改」和「凭空多出暗角」——这两件事实测都踩到过
  t('core 能识别整图铺满（不能误判成普通图层）',
    /const whole = opts\.whole !== undefined/.test(coreSrc) &&
    /const feather = whole \? 0/.test(coreSrc));
  t('整图不做色彩匹配（没有外圈可采）', /const useCM = !!\(!whole && cm && cm\.strength > 0\);/.test(coreSrc));
  t('整图不做无缝融合（没有环境可对齐）', /const useFusion = !!\(!whole && fus && fus\.strength > 0\);/.test(coreSrc));
  t('整图调色不羽化（否则四周留一圈没调）',
    /const alpha = C\.layerAlphaMap\(whole \? Object\.assign\(\{\}, edit, \{ feather: 0 \}\) : edit, r\.w, r\.h\);/.test(appSrc7));
  t('融合取不到环带样本时不动画面（不拿 0 均值去减）',
    /const hasRing = dstMom\.n > 0;/.test(coreSrc) && /: \[0, 0, 0\];/.test(coreSrc));
  t('融合结果带 ok 标记（界面可据此不误报）', /ok: hasRing,/.test(coreSrc));
  t('整图不报「接缝有色差」（整图没有接缝）', /if \(dstMom\.n <= 0\) return null;/.test(coreSrc));

  /* ---------- 工具提示只显示一次 ---------- */

  t('有「提示已读」存储键', /LS_KEY_HINTS/.test(appSrc7));
  t('有 shouldShowHint 判断', /function shouldShowHint/.test(appSrc7));
  t('有 markHintSeen 记录', /function markHintSeen/.test(appSrc7));
  // 提示不能「每次渲染都查一遍 shouldShowHint」：
  // 同一帧里 renderGuideKinds 与 updateUI 都会调用，第一次就把记录写成已读，
  // 第二次立刻判定不该显示 —— 提示出现又消失，用户根本没看到。
  // 正确做法是进入工具时决定一次并缓存（tipDecision）。
  t('画笔提示只显示一次', /btip\.hidden = !\(inBrush && tipDecision\('brush'\)\)/.test(appSrc7));
  t('引导线提示只显示一次', /tipDecision\('guide'\)/.test(appSrc7));
  t('自由笔迹提示只显示一次', /tipDecision\('guide-free'\)/.test(appSrc7));
  t('进入工具时决定一次并缓存', /function tipDecision/.test(appSrc7));
  t('决定显示的那一刻才记录已读', /if \(S\.tips\[key\]\) markHintSeen\(key\)/.test(appSrc7));
  t('切换工具时清掉决定（新工具重新判断）', /resetTipDecision\(\)/.test(appSrc7));
  t('重置提示时内存缓存也要清', /resetTipDecision\(\);[\s\S]{0,120}toast\('工具提示已重置/.test(appSrc7));
  t('生成中提醒只显示一次', /shouldShowHint|hintSeen\('gen-keepalive'\)/.test(appSrc7));
  t('提示记录按工具名分别记（加新工具仍会显示一次）', /hintSeen\('guide-free'\)|indexOf\(name\) >= 0/.test(appSrc7));
  t('提示状态可重置（便于换人用/调试）', /resetHints:/.test(appSrc7));
  t('提示写入失败不影响使用', /空间不足不影响使用/.test(appSrc7));

  // 照片信息
  t('顶栏有照片信息按钮', /id="btn-photoinfo"/.test(html7));
  t('有照片信息面板', /id="photoinfo"/.test(html7));
  t('没照片时按钮禁用', /piBtn\.disabled = !S\.img;/.test(appSrc7));
  // 绑定里会先 closeMoreMenu() 再打开面板（点完菜单项菜单要收起来），
  // 所以只断言「这个按钮最终会调用 openPhotoInfo」
  t('按钮绑定打开面板', /\$\('btn-photoinfo'\)\.onclick = [^\n]*openPhotoInfo\(\)/.test(appSrc7));
  t('面板可关闭', /#photoinfo \[data-close\]/.test(appSrc7));
  t('用 describePhotoInfo 渲染', /C\.describePhotoInfo\(/.test(appSrc7));

  // 引导线
  t('工具行有引导线按钮', /id="btn-guide"/.test(html7));
  t('引导线按钮带 data-mode', /data-mode="guide" id="btn-guide"/.test(html7));
  t('有类型选择条', /id="guide-kinds"/.test(html7));
  t('有清空按钮', /id="guide-clear"/.test(html7));
  t('有数量角标', /id="guide-count"/.test(html7));
  // 引导线会进提示词，所以必须常显（非引导模式下淡化），否则用户会忘了自己画过
  // 注意不能要求 S.rect：没有框选时引导线画在整张图上（见 effectiveRect）
  t('画布上会画引导线', /if \(S\.guides\.length\) drawGuides\(S\.mode !== 'guide'\);/.test(appSrc7));
  t('非引导线模式下淡化显示', /function drawGuides\(dim\)/.test(appSrc7));
  t('引导线只在选区内画', /引导线只能画在选区内/.test(appSrc7));
  t('引导线存入状态', /S\.guides\.push\(draft\)/.test(appSrc7));
  t('点已有引导线可删除', /S\.guides\.splice\(hitIdx, 1\)/.test(appSrc7));
  t('太短的手抖轨迹会丢弃', /S\.guides\.pop\(\)/.test(appSrc7));
  t('抬手后对齐方向', /C\.snapGuide\(d\)/.test(appSrc7));
  // 吸附：手抖出来的小斜角必须被拉直，否则模型会以为「地平线是斜的」
  t('吸附拉平小斜角', (() => {
    const g = C.snapGuide({ kind: 'horizon', x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.52 });
    return Math.abs(g.y2 - g.y1) < 1e-9;
  })());
  t('吸附拉直小偏角', (() => {
    const g = C.snapGuide({ kind: 'vertical', x1: 0.5, y1: 0.1, x2: 0.52, y2: 0.9 });
    return Math.abs(g.x2 - g.x1) < 1e-9;
  })());
  // 关键：透视下的地平线本来就可能斜，超过阈值不能强行掰直
  t('大角度斜线保持原样', (() => {
    const g = C.snapGuide({ kind: 'diagonal', x1: 0, y1: 1, x2: 1, y2: 0 });
    return g.x1 === 0 && g.y1 === 1 && g.x2 === 1 && g.y2 === 0;
  })());
  // 现在只有一种直线类型，方向由坐标本身表达，吸附不该再改类型
  t('竖向直线吸附后仍是直线类型', (() => {
    const g = C.snapGuide({ kind: 'line', x1: 0.5, y1: 0.1, x2: 0.5, y2: 0.9 });
    return g.kind === 'line' && Math.abs(g.x2 - g.x1) < 1e-9;
  })());
  t('横向直线吸附后仍是直线类型', (() => {
    const g = C.snapGuide({ kind: 'line', x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5 });
    return g.kind === 'line' && Math.abs(g.y2 - g.y1) < 1e-9;
  })());
  // 老数据（horizon）经吸附后应该变成 line，而不是保留旧类型
  t('老类型经吸附迁移为直线',
    C.snapGuide({ kind: 'horizon', x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.52 }).kind === 'line');
  t('零长度线不崩', (() => {
    const g = C.snapGuide({ kind: 'horizon', x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 });
    return g.x1 === 0.5 && g.y1 === 0.5;
  })());
  t('吸附空值不崩', C.snapGuide(null).kind === 'line');
  t('吸附后端点仍在 0~1', (() => {
    const g = C.snapGuide({ kind: 'horizon', x1: -1, y1: 5, x2: 2, y2: 5 });
    return g.x1 >= 0 && g.x2 <= 1 && g.y1 >= 0 && g.y2 <= 1;
  })());
  t('换选区会清掉引导线', /S\.guides = \[\];/.test(appSrc7));
  t('换图会清掉引导线', /S\.guides = \[\];\s*\/\/ 引导线跟着选区走/.test(appSrc7));
  t('引导线写进会话存档', /guides: S\.guides,/.test(appSrc7));
  t('恢复会话时读回引导线', /j\.guides\.map\(C\.normalizeGuide\)/.test(appSrc7));
  t('提示词里带上引导线', /guideDesc/.test(appSrc7));
  t('请求前换算到请求图坐标', /C\.mapGuidesToRequest\(/.test(appSrc7));

  // 导出面板
  t('有导出面板', /id="exportpanel"/.test(html7));
  t('面板里有格式选择', /id="exp-formats"/.test(html7));
  t('面板里有大小选择', /id="exp-sizes"/.test(html7));
  t('面板里有自定义长边输入', /id="exp-custom"/.test(html7));
  t('面板里有质量滑块', /id="exp-quality"/.test(html7));
  t('面板里有导出按钮', /id="exp-do"/.test(html7));
  t('显示输出尺寸', /id="exp-out-size"/.test(html7));
  t('显示预计体积', /id="exp-out-size-est"/.test(html7));
  t('保存按钮打开导出面板', /\$\('btn-save'\)\.onclick = openExportPanel;/.test(appSrc7));
  t('导出按钮绑定导出', /\$\('exp-do'\)\.onclick/.test(appSrc7));
  t('导出用面板里的设置', /exportImage\(currentExportPreset\(\)\)/.test(appSrc7));
  t('面板选择会被记住', /S\.cfg\.expFormat = expFormat;/.test(appSrc7));
  t('面板字段纳入持久化', /'expFormat', 'expMaxSide', 'expQuality'/.test(appSrc7));
  t('面板字段有类型校正（防脏数据）', /c\.expQuality = clampNum\(c\.expQuality, 60, 100, 95\);/.test(appSrc7));
  t('面板设置不影响设置页预设', !/S\.cfg\.exportPreset = 'custom';/.test(appSrc7));
  t('CSS 有导出面板样式', /#exportpanel/.test(css7));
})();
/* ---------- 照片信息 / 引导线 / 导出设置 ---------- */

// ===== 检查更新（测试块） =====
(() => {
  // 1) 版本号解析
  t('解析 v2.8.2', JSON.stringify(C.parseVersion('v2.8.2')) === '[2,8,2]');
  t('解析不带 v 的', JSON.stringify(C.parseVersion('2.8.2')) === '[2,8,2]');
  t('解析两段版本号', JSON.stringify(C.parseVersion('2.8')) === '[2,8]');
  t('忽略后缀（2.8.2-beta.1）', JSON.stringify(C.parseVersion('2.8.2-beta.1')) === '[2,8,2]');
  t('空值返回空数组', C.parseVersion('').length === 0 && C.parseVersion(null).length === 0);
  t('纯文字返回空数组', C.parseVersion('abc').length === 0);

  // 2) 版本比较 —— 关键：不能按字符串比（"2.10" < "2.9" 是错的）
  t('2.8.2 > 2.8.1', C.compareVersion('2.8.2', '2.8.1') === 1);
  t('2.8.1 < 2.8.2', C.compareVersion('2.8.1', '2.8.2') === -1);
  t('相同版本为 0', C.compareVersion('2.8.2', '2.8.2') === 0);
  t('带 v 与不带 v 等价', C.compareVersion('v2.8.2', '2.8.2') === 0);
  // 这条最容易错：字符串比较会得出 "2.10.0" < "2.9.0"
  t('2.10.0 > 2.9.0（数字比较而非字符串）', C.compareVersion('2.10.0', '2.9.0') === 1);
  t('2.9.0 < 2.10.0', C.compareVersion('2.9.0', '2.10.0') === -1);
  t('段数不同也能比（2.8 == 2.8.0）', C.compareVersion('2.8', '2.8.0') === 0);
  t('主版本优先', C.compareVersion('3.0.0', '2.99.99') === 1);
  t('无法解析时退化成字符串比较（不崩）',
    typeof C.compareVersion('abc', 'def') === 'number');

  // 3) 挑最新版 —— 这是本功能最容易踩的坑
  //    /releases/latest 按「创建时间」判定，本项目补发旧版后它返回了 v2.2.0
  const mkRel = (tag, created, extra) => Object.assign({
    tag_name: tag, created_at: created, draft: false, prerelease: false,
    name: tag, body: 'notes ' + tag,
    assets: [{ name: 'photo-studio-' + tag + '.apk', browser_download_url: 'https://x/' + tag + '.apk', size: 100 }]
  }, extra || {});

  const realWorld = [
    // 真实情况：补发的旧版本时间戳更新，但版本号低
    mkRel('v1.8.0', '2026-09-26T10:00:00Z'),
    mkRel('v2.2.0', '2026-09-26T10:05:00Z'),
    mkRel('v2.8.2', '2026-09-25T10:00:00Z'),   // 时间更早，但版本最高
    mkRel('v2.4.0', '2026-09-25T12:00:00Z')
  ];
  const best = C.pickLatestRelease(realWorld);
  t('按版本号挑最新（不受时间戳影响）', best.tag_name === 'v2.8.2', best.tag_name);
  // 对照：如果按时间排序会选错
  const byTime = realWorld.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  t('确认「按时间挑」会选错（说明必须按版本号）', byTime.tag_name === 'v2.2.0', byTime.tag_name);

  // 4) 排除 draft 与 prerelease
  const withDraft = realWorld.concat([mkRel('v9.9.9', '2026-09-27T00:00:00Z', { draft: true })]);
  t('排除 draft', C.pickLatestRelease(withDraft).tag_name === 'v2.8.2');
  const withPre = realWorld.concat([mkRel('v9.9.9', '2026-09-27T00:00:00Z', { prerelease: true })]);
  t('排除 prerelease', C.pickLatestRelease(withPre).tag_name === 'v2.8.2');

  // 5) 边界
  t('空列表返回 null', C.pickLatestRelease([]) === null);
  t('null 返回 null', C.pickLatestRelease(null) === null);
  t('全部是 draft 时返回 null',
    C.pickLatestRelease([mkRel('v1.0.0', 'x', { draft: true })]) === null);
  t('tag 无法解析的条目被跳过',
    C.pickLatestRelease([mkRel('nightly', 'x'), mkRel('v2.0.0', 'y')]).tag_name === 'v2.0.0');

  // 6) 是否需要提示更新
  t('有更新时提示', C.planUpdate({ current: '2.8.2', latest: 'v2.9.0' }).hasUpdate === true);
  t('已是最新时不提示', C.planUpdate({ current: '2.8.2', latest: 'v2.8.2' }).hasUpdate === false);
  t('本地比远程新时不提示（不回退）',
    C.planUpdate({ current: '2.9.0', latest: 'v2.8.2' }).hasUpdate === false);
  t('远程为空时不提示', C.planUpdate({ current: '2.8.2', latest: '' }).hasUpdate === false);
  t('远程为空给出原因', C.planUpdate({ current: '2.8.2', latest: '' }).reason === 'no-remote');
  t('忽略过的版本不再提示',
    C.planUpdate({ current: '2.8.2', latest: 'v2.9.0', skipped: 'v2.9.0' }).hasUpdate === false);
  t('忽略后原因标记为 skipped',
    C.planUpdate({ current: '2.8.2', latest: 'v2.9.0', skipped: 'v2.9.0' }).reason === 'skipped');
  // 关键：忽略只针对那一个版本，出了更新的还要提示
  t('忽略 v2.9.0 后，v2.10.0 仍提示',
    C.planUpdate({ current: '2.8.2', latest: 'v2.10.0', skipped: 'v2.9.0' }).hasUpdate === true);
  t('planUpdate 对 null 安全', C.planUpdate(null).hasUpdate === false);

  // 7) 挑 APK 附件
  const rel = {
    tag_name: 'v2.8.2',
    assets: [
      { name: 'RELEASE-NOTES-v2.8.2.md', browser_download_url: 'https://x/n.md' },
      { name: 'photo-studio-v2.8.2.apk', browser_download_url: 'https://x/a.apk' }
    ]
  };
  t('挑出 APK 附件', C.pickApkAsset(rel).name === 'photo-studio-v2.8.2.apk');
  t('忽略非 APK 附件', C.pickApkAsset(rel).name.indexOf('.md') < 0);
  t('多个 APK 时优先带版本号的',
    C.pickApkAsset({
      tag_name: 'v2.8.2',
      assets: [
        { name: 'other.apk', browser_download_url: 'https://x/o.apk' },
        { name: 'photo-studio-v2.8.2.apk', browser_download_url: 'https://x/a.apk' }
      ]
    }).name === 'photo-studio-v2.8.2.apk');
  t('没有 APK 时返回 null',
    C.pickApkAsset({ tag_name: 'v1.0.0', assets: [{ name: 'a.zip', browser_download_url: 'u' }] }) === null);
  t('pickApkAsset 对 null 安全', C.pickApkAsset(null) === null);

  // 8) 检查时机（不该每次启动都请求）
  const H = 3600 * 1000;
  t('首次检查会执行', C.planUpdateCheck({ now: 1000, lastCheck: 0 }).should === true);
  t('刚检查过则跳过',
    C.planUpdateCheck({ now: 1000, lastCheck: 999 }).should === false);
  t('超过间隔会执行',
    C.planUpdateCheck({ now: 13 * H, lastCheck: 0 }).should === true);
  t('未到间隔不执行',
    C.planUpdateCheck({ now: 6 * H, lastCheck: 1 }).should === false);
  t('手动检查总是执行（忽略间隔）',
    C.planUpdateCheck({ now: 1000, lastCheck: 999, force: true }).should === true);
  t('手动检查标记原因为 manual',
    C.planUpdateCheck({ now: 1000, lastCheck: 999, force: true }).reason === 'manual');
  // 失败退避：网络不通时不该反复重试
  t('失败后退避（等待时间变长）',
    C.planUpdateCheck({ now: 13 * H, lastCheck: 1, failCount: 2 }).should === false);
  // 退避上限：间隔 12h × 2^2 = 48h（fails 被夹到 2）。
  // 夹到 4 会变成 16 倍（8 天）—— 网络只是短暂故障的用户要等 8 天才重新检查，太久。
  t('退避有上限（不会无限增长）',
    C.planUpdateCheck({ now: 50 * H, lastCheck: 1, failCount: 99 }).should === true);
  t('退避不会超过 48 小时（12h × 2^2）',
    C.planUpdateCheck({ now: 47 * H, lastCheck: 1, failCount: 99 }).should === false);
  t('返回剩余等待时间',
    C.planUpdateCheck({ now: 1000, lastCheck: 999 }).waitMs > 0);
  t('planUpdateCheck 对 null 安全', typeof C.planUpdateCheck(null).should === 'boolean');

  // 9) 接线检查
  const fs6 = require('fs');
  const appSrc6 = fs6.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const html6 = fs6.readFileSync(__dirname + '/../app/index.html', 'utf8');
  const act6 = fs6.readFileSync(__dirname + '/../android/src/com/photostudio/app/MainActivity.java', 'utf8');
  const mf6 = fs6.readFileSync(__dirname + '/../android/AndroidManifest.xml', 'utf8');

  // 根因：不能用 /releases/latest（按创建时间判定，补发旧版后会返回错的）
  // 注释里提到它是**对的**（说明为什么不用），所以要先去掉注释再查
  const codeOnly = appSrc6.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  t('代码里没有使用 /releases/latest（注释里说明不算）',
    !/releases\/latest/.test(codeOnly));
  t('拉取完整 releases 列表', /releases\?per_page=100/.test(appSrc6));
  t('用 pickLatestRelease 挑最新', /pickLatestRelease\(/.test(appSrc6));

  t('启动时静默检查（延迟执行）',
    /setTimeout\(\(\) => \{ checkUpdate\(false\)/.test(appSrc6));
  t('静默检查失败不打扰用户', /checkUpdate\(false\)\.catch/.test(appSrc6));
  t('设置里有手动检查', /id="btn-checkupdate"/.test(html6));
  t('设置里有自动检查开关', /id="set-autocheck"/.test(html6));
  t('自动检查默认开启', /autoCheckUpdate: true,/.test(appSrc6));
  t('自动检查开关会持久化', /'autoCheckUpdate'/.test(appSrc6));
  t('显示上次检查时间与远程版本', /上次检查/.test(appSrc6));

  t('更新提示条有「立即更新」', /id="ub-update"/.test(appSrc6));
  t('更新提示条有「更新内容」', /id="ub-notes"/.test(appSrc6));
  t('更新提示条可忽略此版本', /id="ub-later"/.test(appSrc6));
  t('忽略只影响该版本（注释说明）', /只忽略「这一个版本」/.test(appSrc6));

  // 安卓侧：下载 + 安装
  t('安卓壳提供下载安装接口', /downloadAndInstall/.test(act6));
  t('用系统下载管理器', /DownloadManager/.test(act6));
  t('下载完成会调起安装器', /installDownloadedApk/.test(act6));
  t('处理「安装未知应用」授权', /checkInstallPermission/.test(act6));
  t('授权后继续安装（不丢下载结果）', /pendingInstallPath/.test(act6));
  t('Manifest 声明了安装权限', /REQUEST_INSTALL_PACKAGES/.test(mf6));
  t('下载完注销广播（防泄漏）', /unregisterDownloadReceiver/.test(act6));
  t('onDestroy 里清理广播', /onDestroy[\s\S]{0,600}unregisterDownloadReceiver/.test(act6));
  t('浏览器里退化成打开下载地址', /openExternal\(apk\.browser_download_url\)/.test(appSrc6));
})();
// ===== 检查更新块结束 =====


/* ---------- 顶栏溢出修复：低频入口收进「更多」菜单 ---------- */
// 症状：360px 机型上文件名只剩 8px（等于没有），320px 机型上按钮直接溢出屏幕右边。
// 原因：顶栏 7 个按钮的最小占宽加起来就 286px，加间距和内边距 352px > 视口宽度，
//      按钮有 min-width 不能压缩，于是被挤出屏幕。
// 修法：把「照片信息 / 修图记录 / 设置」三个低频入口收进「更多」下拉。
(() => {
  const fs8 = require('fs');
  const appSrc = fs8.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const html = fs8.readFileSync(__dirname + '/../app/index.html', 'utf8');
  const css = fs8.readFileSync(__dirname + '/../app/style.css', 'utf8');

  /* ---------- 顶栏固定占宽必须在最窄机型上也放得下 ---------- */

  // 视口最窄按 320px 算（小屏 + 大字体缩放后的实际 CSS 宽度）
  const VIEWPORT = 320;
  // 从 CSS 里抠出真实数值，避免「改了样式但测试还在验旧数字」
  // .tb-btn 的 min-width 是「打开」这种带文字的按钮，.tb-btn.icon 是纯图标按钮
  const barW = (() => {
    const m = /(^|\n)\.tb-btn\s*\{([\s\S]*?)\}/.exec(css);
    const mm = m && /min-width:\s*(\d+)px/.exec(m[2]);
    return mm ? parseInt(mm[1], 10) : null;
  })();
  const iconW = (() => {
    const m = /(^|\n)\.tb-btn\.icon\s*\{([\s\S]*?)\}/.exec(css);
    const mm = m && /min-width:\s*(\d+)px/.exec(m[2]);
    return mm ? parseInt(mm[1], 10) : null;
  })();

  t('CSS 里能读到「打开」按钮宽度', barW !== null, barW);
  t('CSS 里能读到图标按钮宽度', iconW !== null, iconW);
  t('图标按钮比文字按钮窄', iconW !== null && barW !== null && iconW < barW, [iconW, barW]);

  // 顶栏里直接可见的按钮（#moremenu 里的不算，它们在浮层里）
  const barTop = html.slice(html.indexOf('id="topbar"'), html.indexOf('id="moremenu"'));
  const visibleBtns = (barTop.match(/class="tb-btn/g) || []).length;
  t('顶栏可见按钮数量已收敛', visibleBtns <= 5, visibleBtns);
  t('顶栏有 1 个带文字的按钮 + 4 个图标按钮', visibleBtns === 5, visibleBtns);

  if (barW && iconW) {
    // 打开(46) + 4 个图标按钮(40) = 206，间距 5×6 = 30，左右内边距 8+8 = 16
    const fixed = barW + (visibleBtns - 1) * iconW + visibleBtns * 6 + 16;
    t('顶栏固定占宽 < 320px（最窄机型也放得下）', fixed < VIEWPORT, fixed);
    // 剩下的宽度要够显示一截文件名，否则「文件名可见」这个修复就没意义
    t('留给文件名的宽度 >= 60px', VIEWPORT - fixed >= 60, VIEWPORT - fixed);
    // 反证：搬走三个按钮前是放不下的（否则这个修复本身没意义）
    const before = barW + 6 * iconW + 7 * 6 + 16;
    t('收进菜单前确实会溢出（说明修复有效）', before > VIEWPORT, before);
  }

  /* ---------- 三个入口都还在（只是搬进菜单，功能没丢） ---------- */

  t('「更多」按钮存在', /id="btn-more"/.test(html));
  t('「更多」按钮是顶栏可见按钮',
    /<button[^>]*class="tb-btn[^"]*"[^>]*id="btn-more"/.test(html));
  t('「更多」按钮带 aria-expanded（无障碍/测试用）', /id="btn-more"[\s\S]{0,200}aria-expanded/.test(html));
  t('菜单容器存在且默认收起', /id="moremenu"[^>]*hidden/.test(html));
  t('菜单有 role=menu', /id="moremenu"[^>]*role="menu"/.test(html));

  for (const [id, label] of [['btn-photoinfo', '照片信息'], ['btn-library', '修图记录'], ['btn-settings', '设置']]) {
    t(`菜单里有「${label}」`, new RegExp('id="' + id + '"').test(html));
    // 必须在 moremenu 里，不能在顶栏里 —— 搬回顶栏就等于没修
    const mi = html.indexOf('id="moremenu"');
    t(`「${label}」已移出顶栏（在菜单容器内）`, html.indexOf('id="' + id + '"') > mi);
    t(`「${label}」用 .more-item 排版`, new RegExp('class="more-item"[^>]*id="' + id + '"').test(html)
      || new RegExp('id="' + id + '"[^>]*class="more-item"').test(html));
    // 齿轮图标的 path 很长，窗口要开够（1200 字符内必须出现文字标签）
    t(`「${label}」有可见文字标签`, new RegExp('id="' + id + '"[\\s\\S]{0,1200}?' + label + '</span>').test(html));
  }

  /* ---------- 交互：点开 / 收起 / 点外面收起 ---------- */

  t('openMoreMenu 已定义', /function openMoreMenu\(\)/.test(appSrc));
  t('closeMoreMenu 已定义', /function closeMoreMenu\(\)/.test(appSrc));
  t('toggleMoreMenu 已定义', /function toggleMoreMenu\(\)/.test(appSrc));
  t('moreMenuOpen 已定义', /function moreMenuOpen\(\)/.test(appSrc));
  t('开关只改 hidden 属性', /function openMoreMenu\(\)[\s\S]{0,200}m\.hidden = false/.test(appSrc)
    && /function closeMoreMenu\(\)[\s\S]{0,200}m\.hidden = true/.test(appSrc));
  t('开关同步 aria-expanded', /aria-expanded', 'true'/.test(appSrc) && /aria-expanded', 'false'/.test(appSrc));
  t('toggle 依据当前状态取反', /function toggleMoreMenu\(\)[\s\S]{0,160}moreMenuOpen\(\)|function toggleMoreMenu\(\)[\s\S]{0,160}m\.hidden/.test(appSrc));
  t('「更多」按钮绑定了切换', /\$\('btn-more'\)\.onclick = [^\n]*toggleMoreMenu\(\)/.test(appSrc));
  t('点按钮不会同时触发「点外面关闭」', /\$\('btn-more'\)\.onclick = [^\n]*stopPropagation\(\)/.test(appSrc));

  // 点菜单项要顺手关菜单，否则面板关了菜单还浮在画布上
  t('点「设置」后菜单收起', /\$\('btn-settings'\)\.onclick = [^\n]*closeMoreMenu\(\)/.test(appSrc));
  t('点「照片信息」后菜单收起', /\$\('btn-photoinfo'\)\.onclick = [^\n]*closeMoreMenu\(\)/.test(appSrc));
  t('点「修图记录」后菜单收起', /\$\('btn-library'\)\.onclick = [^\n]*closeMoreMenu\(\)/.test(appSrc));

  // 点菜单外面任意位置也要关
  t('点了菜单外面会收起菜单',
    /document\.addEventListener\('click'[\s\S]{0,400}closeMoreMenu\(\)/.test(appSrc));
  t('用捕获阶段处理（先于业务点击）',
    /addEventListener\('click',[\s\S]{0,400}\}, true\)/.test(appSrc));
  t('点在菜单内部不收起', /m\.contains\(e\.target\)\) return/.test(appSrc));
  t('点「更多」按钮本身不收起', /b\.contains\(e\.target\)\) return/.test(appSrc));
  t('菜单没开时不做无谓处理', /if \(!moreMenuOpen\(\)\) return/.test(appSrc));

  /* ---------- 返回键：先关菜单，再关面板 ---------- */

  t('返回时把菜单状态交给 planBackAction', /moremenu: moreMenuOpen\(\),/.test(appSrc));
  t('返回键能关掉菜单', /case 'moremenu': closeMoreMenu\(\);/.test(appSrc));
  // 教程是全屏引导，盖在菜单之上；菜单仍是「面板类」里最靠前的一层
  t('教程盖在最上面', C.BACK_LAYERS[0].id === 'tutorial');
  t('菜单紧跟教程之后', C.BACK_LAYERS[1].id === 'moremenu');
  t('菜单 z-index 高于所有面板',
    C.BACK_LAYERS.slice(1).every((L) => C.BACK_LAYERS[0].z > L.z),
    C.BACK_LAYERS.map((L) => L.id + ':' + L.z));

  /* ---------- 样式：不能挡住别的层 ---------- */

  t('菜单是绝对定位（不占顶栏空间）', /#moremenu\s*\{[\s\S]{0,200}position:\s*absolute/.test(css));
  t('菜单从顶栏底部展开', /#moremenu\s*\{[\s\S]{0,300}top:\s*100%/.test(css));
  t('菜单右对齐（窄屏不会被裁掉）', /#moremenu\s*\{[\s\S]{0,300}right:\s*calc\(8px \+ var\(--sar\)\)/.test(css));
  t('菜单 z-index 与层级表一致', /#moremenu\s*\{[\s\S]{0,400}z-index:\s*130/.test(css));
  t('顶栏是菜单的定位父级', /#topbar\s*\{[\s\S]{0,120}position:\s*relative/.test(css));
  t('菜单项是横向排列', /\.more-item\s*\{[\s\S]{0,160}display:\s*flex/.test(css));
  t('禁用态有视觉反馈', /\.more-item:disabled\s*\{[\s\S]{0,80}opacity/.test(css));
  // 横屏顶栏很矮，菜单往右展开才放得下
  t('横屏改成右侧弹出', /@media[^{]*orientation:\s*landscape[\s\S]{0,400}#moremenu\s*\{[\s\S]{0,200}left:\s*100%/.test(css));

  /* ---------- 导出给测试/安卓壳 ---------- */
  t('菜单开关已导出', /openMoreMenu,/.test(appSrc) && /closeMoreMenu,/.test(appSrc));
})();
// ===== 顶栏溢出修复块结束 =====

/* ---------- 改名：修图台 → 枫叶修图 ---------- */
// 硬约束：只改「显示名」。包名 / localStorage 键 / 资源名 / 签名 一律不动 ——
// 改包名等于装出一个新 App（设置和历史全丢），改 localStorage 键等于把用户数据孤立。
(() => {
  const fs9 = require('fs');
  const appSrc = fs9.readFileSync(__dirname + '/../app/app.js', 'utf8');
  const html = fs9.readFileSync(__dirname + '/../app/index.html', 'utf8');
  const manifest = fs9.readFileSync(__dirname + '/../app/manifest.json', 'utf8');
  const strings = fs9.readFileSync(__dirname + '/../android/res/values/strings.xml', 'utf8');

  /* ---------- 显示名已改 ---------- */

  t('页面标题是枫叶修图', /<title>[^<]*枫叶修图/.test(html));
  t('安卓应用名是枫叶修图', /<string name="app_name">枫叶修图<\/string>/.test(strings));
  t('PWA 名字是枫叶修图', /"name":\s*"[^"]*枫叶修图/.test(manifest));
  t('PWA 短名是枫叶修图', /"short_name":\s*"[^"]*枫叶修图/.test(manifest));

  /* ---------- 状态相关的标识符一个都没动 ---------- */

  // 包名：改了就是另一个 App，设置、历史、签名全部失效
  t('包名没改（仍是 com.photostudio.app）',
    /com\.photostudio\.app/.test(fs9.readFileSync(__dirname + '/../android/src/com/photostudio/app/MainActivity.java', 'utf8'))
    && /com\.photostudio\.app/.test(fs9.readFileSync(__dirname + '/../android/AndroidManifest.xml', 'utf8')));
  t('Manifest 里没有出现新包名', !/com\.fengye/.test(fs9.readFileSync(__dirname + '/../android/AndroidManifest.xml', 'utf8')));

  // localStorage 键：改了用户的设置 / 历史 / 会话就全读不到了
  t('localStorage 前缀仍是 photoStudio.', /photoStudio\./.test(appSrc));
  t('没有出现新的存储前缀', !/fengye|maple/i.test(appSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));

  // 通知图标资源名：改名会导致通知栏图标丢失
  t('通知图标资源名没改',
    /ic_stat_photostudio/.test(fs9.readFileSync(__dirname + '/../android/src/com/photostudio/app/KeepAliveService.java', 'utf8')));

  // WebView 桥名：改了 JS 调不到原生
  t('JS 桥名没改（仍是 PSBridge）', /PSBridge/.test(appSrc));

  /* ---------- 但面向用户的文案里不该再有旧名字 ---------- */

  const oldName = /修图台/;
  // 说明性注释里可以保留（比如「原名修图台」），只看真正会显示出来的部分
  t('页面标题里没有旧名字', !oldName.test((/<title>([^<]*)<\/title>/.exec(html) || [])[1] || ''));
  t('安卓应用名里没有旧名字', !oldName.test((/<string name="app_name">([^<]*)<\/string>/.exec(strings) || [])[1] || ''));
  t('PWA 名字里没有旧名字', !oldName.test((/"name":\s*"([^"]*)"/.exec(manifest) || [])[1] || ''));

  /* ---------- 启动脚本也跟着改名 ---------- */
  t('启动脚本已改名', fs9.existsSync(__dirname + '/../启动枫叶修图.sh'));
  t('旧启动脚本已删除', !fs9.existsSync(__dirname + '/../启动修图台.sh'));
})();
// ===== 改名块结束 =====

/* ---------- 枫叶图标 ---------- */
// 图标是纯 Node 零依赖生成的（构建环境里没有 SVG 光栅化器），
// 所以叶子几何以「展平后的 42 点多边形」内联在生成器里。
// 这里校验的是「SVG 和生成器描述的是同一片叶子」——两边不一致就会出现
// 网页图标和安装后图标长得不一样。
(() => {
  const fs10 = require('fs');
  const svg = fs10.readFileSync(__dirname + '/../app/icon.svg', 'utf8');
  const mkSrc = fs10.readFileSync(__dirname + '/../tools/make-icons.js', 'utf8');
  const html = fs10.readFileSync(__dirname + '/../app/index.html', 'utf8');
  const manifest = fs10.readFileSync(__dirname + '/../app/manifest.json', 'utf8');

  /* ---------- 配色：饱和红底 + 白叶（小尺寸下对比度最高） ---------- */

  const palette = ['#ff7048', '#dc2318', '#8a0d0a'];
  t('SVG 用饱和红底（枫叶配色）',
    palette.every((h) => svg.toLowerCase().indexOf(h) >= 0), palette.filter((h) => svg.toLowerCase().indexOf(h) < 0));
  t('生成器用同一套红底',
    palette.every((h) => mkSrc.toLowerCase().indexOf(h) >= 0));
  t('SVG 叶子是白色', /linearGradient id="leaf"/.test(svg) && /#ffffff/.test(svg));
  t('SVG 用圆角底', /rx="114"/.test(svg));
  t('SVG 有叶周光晕与顶部高光', /radialGradient/.test(svg) && /id="hl"/.test(svg));

  /* ---------- 叶子形状：SVG 里是贝塞尔路径，生成器里是多边形 ---------- */

  t('SVG 含标准枫叶路径', /M201 232/.test(svg));
  t('生成器内联了展平后的枫叶多边形', /const LEAF = \[\[/.test(mkSrc));

  const leafArr = /const LEAF = (\[\[[\s\S]*?\]\]);/.exec(mkSrc);
  t('能解析出叶子多边形', !!leafArr);
  if (leafArr) {
    const pts = JSON.parse(leafArr[1].replace(/,\s*\]/g, ']'));
    t('叶子点数 = 42（展平精度）', pts.length === 42, pts.length);
    // 顶点必须是归一化坐标（生成器按高度=1 存放，绘制时再乘比例）
    t('叶子顶点已归一化到 [0,1]',
      pts.every((p) => p.length === 2 && p[0] >= -1e-6 && p[0] <= 1 + 1e-6 && p[1] >= -1e-6 && p[1] <= 1 + 1e-6));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    t('叶子高正好占满 0..1', Math.abs(Math.min(...ys)) < 1e-6 && Math.abs(Math.max(...ys) - 1) < 1e-6,
      [Math.min(...ys), Math.max(...ys)]);
    t('叶子宽高比 ≈ 0.916（加拿大枫叶比例）',
      Math.abs((Math.max(...xs) - Math.min(...xs)) - 0.91613) < 0.001,
      Math.max(...xs) - Math.min(...xs));

    // 面积/包围盒比值：太低说明画成了一条线，太高说明画成了一个方块
    const ratio = (() => {
      let a = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        a += p[0] * q[1] - q[0] * p[1];
      }
      return Math.abs(a / 2) / ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)));
    })();
    t('叶子面积占比合理（真叶子约 0.43）', ratio > 0.36 && ratio < 0.50, ratio.toFixed(4));

    // 自交会让扫描线填充出空洞，叶子会看起来「破」了
    const seg = (i, j) => {
      const p1 = pts[i], p2 = pts[(i + 1) % pts.length], p3 = pts[j], p4 = pts[(j + 1) % pts.length];
      const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
      return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
    };
    let cross = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (j === i || (j + 1) % pts.length === i || (i + 1) % pts.length === j) continue;
        if (seg(i, j)) cross++;
      }
    }
    t('叶子多边形无自交', cross === 0, cross);
  }

  t('生成器记下了叶子宽高比常量', /const LEAF_AR = 0\.91613/.test(mkSrc));

  /* ---------- SVG 与生成器必须是同一片叶子（尺寸/比例一致） ---------- */

  const sc = /scale\(([\d.]+)\)/.exec(svg);
  t('能解析出 SVG 里的叶子缩放', !!sc);
  if (sc) {
    // 源路径高 279px，缩放后应占画布 512 的 60%
    t('SVG 叶高 = 画布 60%', Math.abs(279 * parseFloat(sc[1]) - 512 * 0.6) < 2,
      (279 * parseFloat(sc[1])).toFixed(1));
  }
  const arGen = parseFloat((/const LEAF_AR = ([\d.]+)/.exec(mkSrc) || [])[1]);
  t('SVG 与生成器的叶形宽高比一致', Math.abs(255.6 / 279 - arGen) < 0.001,
    (255.6 / 279).toFixed(5) + ' vs ' + arGen);

  /* ---------- 叶子在自适应图标安全区内 ---------- */

  // 自适应图标只有中间 66.7% 是保证可见的，叶子超出就会被系统裁掉
  const leafH = parseFloat((/function adaptiveForeground[\s\S]{0,400}leafH:\s*([\d.]+)/.exec(mkSrc) || [])[1]
    || (/leafH\s*=\s*([\d.]+)/.exec(mkSrc) || [])[1] || '0');
  t('自适应图标叶子高度 <= 66.7% 安全区', leafH > 0 && leafH <= 0.667, leafH);

  /* ---------- 图标资源齐备 ---------- */

  t('页面引用了图标', /icon\.svg|icon-192/.test(html));
  t('PWA 清单引用了 192 图标', /icon-192\.png/.test(manifest));
  t('PWA 清单引用了 512 图标', /icon-512\.png/.test(manifest));
  t('清单声明了 maskable/any 用途', /"purpose"/.test(manifest));
})();
// ===== 枫叶图标块结束 =====

/* ---------- 导出保存位置（纯逻辑） ---------- */
(() => {
  // 三个位置：相册 / 下载 / 每次询问
  t('保存位置有三个', Array.isArray(C.SAVE_LOCATIONS) && C.SAVE_LOCATIONS.length === 3,
    C.SAVE_LOCATIONS && C.SAVE_LOCATIONS.length);
  const ids = C.SAVE_LOCATIONS.map((x) => x.id);
  t('位置 id 是 gallery/downloads/ask',
    ids.join(',') === 'gallery,downloads,ask', ids);
  t('每个位置都有标题与说明',
    C.SAVE_LOCATIONS.every((x) => x.label && x.desc));

  // 合法性判定：脏数据不能把导出导到不存在的地方
  t('gallery 合法', C.isSaveLocation('gallery') === true);
  t('downloads 合法', C.isSaveLocation('downloads') === true);
  t('ask 合法', C.isSaveLocation('ask') === true);
  t('未知值非法', C.isSaveLocation('nope') === false);
  t('路径穿越非法', C.isSaveLocation('../../etc/passwd') === false);
  t('null 非法', C.isSaveLocation(null) === false);
  t('undefined 非法', C.isSaveLocation(undefined) === false);
  t('数字非法', C.isSaveLocation(123) === false);
  t('对象非法', C.isSaveLocation({}) === false);

  // 取定义：非法时回落到相册（保证界面永远有选中项）
  t('取 gallery 原样返回', C.getSaveLocation('gallery').id === 'gallery');
  t('取 downloads 原样返回', C.getSaveLocation('downloads').id === 'downloads');
  t('取 ask 原样返回', C.getSaveLocation('ask').id === 'ask');
  t('取非法值回落到相册', C.getSaveLocation('../../etc/passwd').id === 'gallery');
  t('取 null 回落到相册', C.getSaveLocation(null).id === 'gallery');
  t('回落对象也是完整定义',
    !!(C.getSaveLocation('bad').label && C.getSaveLocation('bad').desc));
})();
// ===== 导出保存位置块结束 =====

/* ---------- 后台生成任务（纯逻辑） ---------- */
(() => {
  // 用户诉求：一张图进了 AI 生图后，可以放到后台去处理下一张。
  // 最关键的是「结果不能落到错的照片上」「不能静默丢失」「界面不能假装在忙」。

  // 1) 落地决策：五种组合都要有确定答案
  const L = (o) => C.planJobLanding(o);

  // a) 用户就在同一张照片的同一份状态上 → 走对比图（原来的流程）
  t('同一文档 → 走对比图',
    L({ jobWorkId: 'w1', jobDocVersion: 5, curWorkId: 'w1', curDocVersion: 5, hasPhoto: true, hasLibrary: true })
      .target === 'compare');
  t('同一文档的原因是 same-doc',
    L({ jobWorkId: 'w1', jobDocVersion: 5, curWorkId: 'w1', curDocVersion: 5, hasPhoto: true, hasLibrary: true })
      .reason === 'same-doc');

  // b) 同一件作品但文档版本变了（用户又编辑/撤销过）→ 落库，不能贴
  t('同作品但文档变了 → 落作品库',
    L({ jobWorkId: 'w1', jobDocVersion: 5, curWorkId: 'w1', curDocVersion: 9, hasPhoto: true, hasLibrary: true })
      .target === 'library');
  t('同作品但文档变了的原因是 same-work-newer-doc',
    L({ jobWorkId: 'w1', jobDocVersion: 5, curWorkId: 'w1', curDocVersion: 9, hasPhoto: true, hasLibrary: true })
      .reason === 'same-work-newer-doc');
  // 关键：这种情形**绝不能**走 compare —— 那会把用户中间的编辑盖掉
  t('同作品但文档变了时绝不走对比图',
    L({ jobWorkId: 'w1', jobDocVersion: 5, curWorkId: 'w1', curDocVersion: 9, hasPhoto: true, hasLibrary: true })
      .target !== 'compare');

  // c) 用户在别的照片上 → 落库（这是「处理下一张」的主路径）
  t('在别的照片上 → 落作品库',
    L({ jobWorkId: 'w1', jobDocVersion: 5, curWorkId: 'w2', curDocVersion: 7, hasPhoto: true, hasLibrary: true })
      .target === 'library');
  t('在别的照片上的原因是 other-photo',
    L({ jobWorkId: 'w1', jobDocVersion: 5, curWorkId: 'w2', curDocVersion: 7, hasPhoto: true, hasLibrary: true })
      .reason === 'other-photo');

  // d) 用户回首页了（没有打开任何照片）→ 落库
  t('在首页（没开照片）→ 落作品库',
    L({ jobWorkId: 'w1', jobDocVersion: 5, curWorkId: null, curDocVersion: 0, hasPhoto: false, hasLibrary: true })
      .target === 'library');
  // 关键：不能因为「没打开照片」就判成 compare —— 那会把结果贴到空白画布上
  t('首页时绝不走对比图',
    L({ jobWorkId: 'w1', jobDocVersion: 5, curWorkId: null, curDocVersion: 0, hasPhoto: false, hasLibrary: true })
      .target !== 'compare');
  // 作品 id 为 null 的任务（发起时还没建记录）也要有确定去处
  t('任务没有 workId 时不会误判成同一张',
    L({ jobWorkId: null, jobDocVersion: 5, curWorkId: null, curDocVersion: 0, hasPhoto: false, hasLibrary: true })
      .target === 'library');

  // e) 无处可落 → 明确 drop（不假装成功）
  t('没有作品库时判为 drop',
    L({ jobWorkId: 'w1', jobDocVersion: 5, curWorkId: 'w2', curDocVersion: 7, hasPhoto: true, hasLibrary: false })
      .target === 'drop');
  t('planJobLanding 对 null 安全', typeof C.planJobLanding(null).target === 'string');
  t('planJobLanding 对空参数安全', typeof C.planJobLanding({}).target === 'string');
  t('所有分支都返回三种之一',
    (() => {
      const cases = [
        {}, { hasPhoto: true, curDocVersion: 1, jobDocVersion: 1 },
        { hasLibrary: true }, { hasLibrary: true, hasPhoto: true },
        { hasLibrary: true, curWorkId: 'a', jobWorkId: 'a', curDocVersion: 1, jobDocVersion: 1, hasPhoto: true }
      ];
      return cases.every((c) => ['compare', 'library', 'drop'].indexOf(C.planJobLanding(c).target) >= 0);
    })());

  // 2) 角标文案：让用户一眼看出有几张在跑、几张好了
  t('planJobBadge 对空安全', C.planJobBadge([]).total === 0 && C.planJobBadge(null).total === 0);
  const b1 = C.planJobBadge([{ status: 'running' }, { status: 'running' }]);
  t('统计生成中数量', b1.running === 2 && b1.total === 2, b1);
  t('只有生成中时文案说「正在后台生成」', /2 张正在后台生成/.test(b1.text), b1.text);
  const b2 = C.planJobBadge([{ status: 'done' }]);
  t('统计完成数量', b2.done === 1, b2);
  t('只有完成时文案说「已完成」', /已完成/.test(b2.text), b2.text);
  const b3 = C.planJobBadge([{ status: 'running' }, { status: 'done' }, { status: 'done' }]);
  t('混合时同时报两个数', b3.running === 1 && b3.done === 2, b3);
  t('混合时文案两个数都在', /1 张生成中/.test(b3.text) && /2 张已完成/.test(b3.text), b3.text);
  t('统计失败数量', C.planJobBadge([{ status: 'failed' }]).failed === 1);
  t('已取消的不计入（用户自己取消的不该提醒）',
    C.planJobBadge([{ status: 'canceled' }]).total === 0, C.planJobBadge([{ status: 'canceled' }]));
  t('脏条目被跳过', C.planJobBadge([null, undefined, {}, { status: 'running' }]).running === 1);
  // 优先级：有完成就优先说完成（那是行动召唤）
  t('有完成时优先报完成',
    /已完成/.test(C.planJobBadge([{ status: 'running' }, { status: 'done' }]).text),
    C.planJobBadge([{ status: 'running' }, { status: 'done' }]).text);

  // 3) 条目标记：告诉用户点进去有结果
  const jobs = [
    { workId: 'w1', status: 'running' },
    { workId: 'w2', status: 'done' },
    { workId: 'w3', status: 'failed' }
  ];
  t('生成中的条目标「生成中…」',
    C.jobTagFor('w1', jobs).tag === 'running' && /生成中/.test(C.jobTagFor('w1', jobs).zh),
    C.jobTagFor('w1', jobs));
  t('完成的条目标「已生成」',
    C.jobTagFor('w2', jobs).tag === 'done' && /点开看/.test(C.jobTagFor('w2', jobs).zh),
    C.jobTagFor('w2', jobs));
  t('失败的条目标「生成失败」',
    C.jobTagFor('w3', jobs).tag === 'failed', C.jobTagFor('w3', jobs));
  t('没有任务的条目返回 null', C.jobTagFor('w9', jobs) === null);
  t('jobTagFor 对空安全', C.jobTagFor('w1', []) === null && C.jobTagFor('w1', null) === null);
  // 优先级：同一张既有跑着的又有好了的 → 报「好了」（更重要）
  t('同一张既有生成中又有完成时报完成',
    C.jobTagFor('w1', [{ workId: 'w1', status: 'running' }, { workId: 'w1', status: 'done' }]).tag === 'done');
  // 反过来（先完成后生成中）也要报完成
  t('顺序不影响完成优先',
    C.jobTagFor('w1', [{ workId: 'w1', status: 'done' }, { workId: 'w1', status: 'running' }]).tag === 'done');

  // 4) busy 只反映「当前这张照片」—— 用户明确点出的「不能假装在忙」
  const pj = (o) => C.planBusyForCurrent(o);
  t('当前文档有任务 → busy',
    pj({ jobs: [{ status: 'running', docVersion: 5 }], curDocVersion: 5, hasPhoto: true }).busy === true);
  t('当前文档有任务 → 计数正确',
    pj({ jobs: [{ status: 'running', docVersion: 5 }], curDocVersion: 5, hasPhoto: true }).count === 1);
  // 关键：别的照片在跑时**不能**显示遮罩（会挡住首页，让人以为卡住）
  t('别的文档有任务 → 不 busy',
    pj({ jobs: [{ status: 'running', docVersion: 5 }], curDocVersion: 9, hasPhoto: true }).busy === false);
  t('别的文档有任务 → 计数为 0',
    pj({ jobs: [{ status: 'running', docVersion: 5 }], curDocVersion: 9, hasPhoto: true }).count === 0);
  t('没打开照片 → 不 busy（首页不能被遮住）',
    pj({ jobs: [{ status: 'running', docVersion: 5 }], curDocVersion: 0, hasPhoto: false }).busy === false);
  t('没有任务 → 不 busy', pj({ jobs: [], curDocVersion: 5, hasPhoto: true }).busy === false);
  t('已完成的任务不算 busy',
    pj({ jobs: [{ status: 'done', docVersion: 5 }], curDocVersion: 5, hasPhoto: true }).busy === false);
  t('已取消/失败的任务不算 busy',
    pj({ jobs: [{ status: 'canceled', docVersion: 5 }, { status: 'failed', docVersion: 5 }],
      curDocVersion: 5, hasPhoto: true }).busy === false);
  t('多个任务都算进计数',
    pj({ jobs: [{ status: 'running', docVersion: 5 }, { status: 'running', docVersion: 5 }],
      curDocVersion: 5, hasPhoto: true }).count === 2);
  t('planBusyForCurrent 对 null 安全', pj(null).busy === false);
})();
// ===== 后台生成任务块结束 =====

/* ---------- 基础调色（纯像素数学） ---------- */
(() => {
  const mk = (r, g, b, a) => ({
    data: new Uint8ClampedArray([r, g, b, a === undefined ? 255 : a]),
    width: 1, height: 1
  });
  const px = (im) => [im.data[0], im.data[1], im.data[2], im.data[3]];
  const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

  // 1) 参数定义：对称、有默认值、有中文名（界面按它渲染滑块）
  t('调色参数是数组', Array.isArray(C.GRADE_PARAMS));
  t('至少有 曝光/对比度/饱和度/色温/色调 五项', C.GRADE_PARAMS.length >= 5, C.GRADE_PARAMS.length);
  for (const k of ['exposure', 'contrast', 'saturation', 'temperature', 'tint']) {
    t('调色参数含 ' + k, C.GRADE_PARAMS.some((p) => p.key === k), C.GRADE_PARAMS.map((p) => p.key));
  }
  t('每项都有中文名与说明',
    C.GRADE_PARAMS.every((p) => p.zh && p.hint), C.GRADE_PARAMS);
  t('值域对称（0 = 不变）',
    C.GRADE_PARAMS.every((p) => p.min === -p.max && p.def === 0),
    C.GRADE_PARAMS.map((p) => [p.min, p.max, p.def]));

  t('emptyGrade 全零', C.isGradeEmpty(C.emptyGrade()));
  t('emptyGrade 字段齐备',
    Object.keys(C.emptyGrade()).length === C.GRADE_PARAMS.length, Object.keys(C.emptyGrade()));
  t('有非零参数时 isGradeEmpty 为假', C.isGradeEmpty({ exposure: 1 }) === false);
  t('isGradeEmpty 对 null 为真', C.isGradeEmpty(null) === true);
  t('isGradeEmpty 对脏值安全', C.isGradeEmpty({ exposure: 'x' }) === true);

  // 2) 归一化：夹取 + 补默认 + 丢脏值
  const ng = C.normalizeGrade({ exposure: 999, contrast: -999, saturation: 'x', temperature: 50 });
  t('归一化夹到上限', ng.exposure === 100, ng.exposure);
  t('归一化夹到下限', ng.contrast === -100, ng.contrast);
  t('归一化丢掉脏值', ng.saturation === 0, ng.saturation);
  t('归一化保留合法值', ng.temperature === 50, ng.temperature);
  t('归一化补齐缺失字段', ng.tint === 0, ng.tint);
  t('归一化对 null 安全', C.normalizeGrade(null).exposure === 0);

  // 3) **恒等性**：全零调整 = 像素逐字节不变（这是「非破坏性」的技术底线）
  const samples = [[0, 0, 0], [255, 255, 255], [128, 128, 128], [120, 80, 40], [1, 254, 128], [200, 10, 250]];
  let allIdentical = true;
  for (const [r, g, b] of samples) {
    const out = C.gradePixels(mk(r, g, b), C.emptyGrade());
    const p = px(out);
    if (p[0] !== r || p[1] !== g || p[2] !== b || p[3] !== 255) {
      allIdentical = false;
      t('恒等：' + [r, g, b].join(',') + ' 不变', false, p);
    }
  }
  t('恒等性：全零调整像素逐字节不变', allIdentical);
  // 缺参、null、undefined 都等价于「不调」
  t('缺参等价于不调', JSON.stringify(px(C.gradePixels(mk(120, 80, 40), {}))) === '[120,80,40,255]');
  t('null 参数等价于不调', JSON.stringify(px(C.gradePixels(mk(120, 80, 40), null))) === '[120,80,40,255]');
  t('undefined 参数等价于不调', JSON.stringify(px(C.gradePixels(mk(120, 80, 40), undefined))) === '[120,80,40,255]');

  // 4) **单调性**：曝光越大越亮（对所有采样点都成立）
  let monoOk = true;
  for (const [r, g, b] of samples) {
    const levels = [-100, -50, 0, 50, 100].map((v) => lum(px(C.gradePixels(mk(r, g, b), { exposure: v }))));
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] < levels[i - 1] - 1e-9) { monoOk = false; t('曝光单调 ' + [r, g, b].join(',') + ' @' + i, false, levels); }
    }
  }
  t('单调性：曝光越大越亮', monoOk);
  t('曝光 +100 确实更亮', lum(px(C.gradePixels(mk(120, 80, 40), { exposure: 100 }))) >
    lum(px(C.gradePixels(mk(120, 80, 40), C.emptyGrade()))));
  t('曝光 -100 确实更暗', lum(px(C.gradePixels(mk(120, 80, 40), { exposure: -100 }))) <
    lum(px(C.gradePixels(mk(120, 80, 40), C.emptyGrade()))));
  // 曝光系数本身也要单调，且 ±100 是 ±2EV
  t('曝光系数在 0 处为 1', Math.abs(C.gradeExposureFactor(0) - 1) < 1e-9);
  t('曝光 +100 = 4 倍（+2EV）', Math.abs(C.gradeExposureFactor(100) - 4) < 1e-9,
    C.gradeExposureFactor(100));
  t('曝光 -100 = 1/4 倍（-2EV）', Math.abs(C.gradeExposureFactor(-100) - 0.25) < 1e-9,
    C.gradeExposureFactor(-100));
  t('曝光系数单调递增',
    [-100, -50, 0, 50, 100].every((v, i, a) => i === 0 || C.gradeExposureFactor(v) > C.gradeExposureFactor(a[i - 1])));

  // 5) **夹取**：不溢出、不绕回（绕回是「亮部烧成黑块」的经典 bug）
  let noWrap = true;
  const extremes = [
    { exposure: 100 }, { exposure: -100 }, { contrast: 100 }, { contrast: -100 },
    { saturation: 100 }, { saturation: -100 }, { temperature: 100 }, { temperature: -100 },
    { tint: 100 }, { tint: -100 },
    { exposure: 100, contrast: 100, saturation: 100, temperature: 100, tint: 100 },
    { exposure: -100, contrast: -100, saturation: -100, temperature: -100, tint: -100 }
  ];
  for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [120, 80, 40]]) {
    for (const grade of extremes) {
      const p = px(C.gradePixels(mk(r, g, b), grade));
      for (let k = 0; k < 3; k++) {
        if (!(p[k] >= 0 && p[k] <= 255) || !Number.isFinite(p[k])) {
          noWrap = false;
          t('夹取 ' + [r, g, b].join(',') + ' ' + JSON.stringify(grade), false, p);
        }
      }
      // 白色不能被「调」成黑色（那说明绕回了）
      if (r === 255 && g === 255 && b === 255 && grade.exposure >= 0 && (p[0] < 200 || p[1] < 200)) {
        noWrap = false;
        t('白色在正向调整下不会绕回变黑', false, { grade, p });
      }
    }
  }
  t('夹取：所有极端组合都在 0~255 内（不绕回）', noWrap);
  t('白色在 +100 曝光下仍是白（不绕回）',
    px(C.gradePixels(mk(255, 255, 255), { exposure: 100 }))[0] === 255);
  t('黑色在 -100 曝光下仍是黑（不绕回成白）',
    px(C.gradePixels(mk(0, 0, 0), { exposure: -100 }))[0] <= 2);

  // 6) 对比度：绕中灰（线性 0.18 → sRGB 约 118）旋转，中灰本身不动
  const mid = px(C.gradePixels(mk(118, 118, 118), { contrast: 100 }));
  t('对比度绕中灰：中灰几乎不动', Math.abs(mid[0] - 118) <= 2, mid);
  t('对比度 +100 拉开亮部', px(C.gradePixels(mk(180, 180, 180), { contrast: 100 }))[0] > 180);
  t('对比度 +100 压暗暗部', px(C.gradePixels(mk(60, 60, 60), { contrast: 100 }))[0] < 60);
  t('对比度 -100 把一切压向中灰',
    Math.abs(px(C.gradePixels(mk(180, 180, 180), { contrast: -100 }))[0] - 118) <= 2,
    px(C.gradePixels(mk(180, 180, 180), { contrast: -100 })));
  t('对比度单调：越加对比，亮部越亮',
    px(C.gradePixels(mk(180, 180, 180), { contrast: 50 }))[0] <
    px(C.gradePixels(mk(180, 180, 180), { contrast: 100 }))[0]);

  // 7) 饱和度：-100 = 完全去色（三通道相等，且亮度不变）
  const desat = px(C.gradePixels(mk(200, 80, 40), { saturation: -100 }));
  t('饱和度 -100 得到灰度（三通道相等）',
    desat[0] === desat[1] && desat[1] === desat[2], desat);
  // 参照必须是**线性光**亮度守恒（物理正确的口径），不是 sRGB 数值的加权平均。
  // 两者差很多（102.6 vs 118），用错参照会把正确实现判成 bug。
  // 在 sRGB 上直接做加权平均等于把 gamma 编码当线性用，绿色会偏暗。
  const linLum = (p) => 0.2126 * C.srgbToLinear(p[0]) + 0.7152 * C.srgbToLinear(p[1]) + 0.0722 * C.srgbToLinear(p[2]);
  const linOfGray = C.linearToSrgb(linLum([200, 80, 40]));
  t('去色后线性亮度守恒（物理正确的口径）',
    Math.abs(desat[0] - linOfGray) <= 2, [desat[0], linOfGray]);
  t('去色结果就是线性亮度对应的灰',
    desat[0] === desat[1] && desat[1] === desat[2], desat);
  t('饱和度 +100 增加色彩跨度', (() => {
    const before = Math.max(200, 80, 40) - Math.min(200, 80, 40);
    const after = px(C.gradePixels(mk(200, 80, 40), { saturation: 100 }));
    return (Math.max(...after.slice(0, 3)) - Math.min(...after.slice(0, 3))) > before;
  })());
  t('灰度像素调饱和度不变（灰没有饱和度可调）', (() => {
    const p = px(C.gradePixels(mk(120, 120, 120), { saturation: 100 }));
    return Math.abs(p[0] - 120) <= 2 && Math.abs(p[1] - 120) <= 2 && Math.abs(p[2] - 120) <= 2;
  })(), px(C.gradePixels(mk(120, 120, 120), { saturation: 100 })));

  // 8) 色温：暖 = 红多蓝少，冷 = 反之；绿通道基本不动
  const warm = px(C.gradePixels(mk(128, 128, 128), { temperature: 100 }));
  const cool = px(C.gradePixels(mk(128, 128, 128), { temperature: -100 }));
  t('色温偏暖时红 > 蓝', warm[0] > warm[2], warm);
  t('色温偏冷时蓝 > 红', cool[2] > cool[0], cool);
  t('色温不显著改变绿通道', Math.abs(warm[1] - 128) <= 3 && Math.abs(cool[1] - 128) <= 3,
    [warm[1], cool[1]]);
  t('色温单调：越暖红越多',
    px(C.gradePixels(mk(128, 128, 128), { temperature: 50 }))[0] <
    px(C.gradePixels(mk(128, 128, 128), { temperature: 100 }))[0]);
  t('色温 ±0 时通道增益为 1',
    Math.abs(C.gradeChannelGains(0, 0).r - 1) < 1e-9 && Math.abs(C.gradeChannelGains(0, 0).b - 1) < 1e-9);
  t('色温 +100 时红增益 > 1、蓝增益 < 1', (() => {
    const g = C.gradeChannelGains(100, 0);
    return g.r > 1 && g.b < 1 && Math.abs(g.g - 1) < 1e-9;
  })());

  // 9) 色调：正 = 偏品红（减绿），负 = 偏绿（减红蓝）
  const magenta = px(C.gradePixels(mk(128, 128, 128), { tint: 100 }));
  const green = px(C.gradePixels(mk(128, 128, 128), { tint: -100 }));
  t('色调偏品红时绿通道减少', magenta[1] < 128, magenta);
  t('色调偏绿时绿通道相对更高', green[1] > magenta[1], [green[1], magenta[1]]);

  // 10) 掩膜：权重 0 的地方一个像素都不动
  const masked = C.gradePixels({
    data: new Uint8ClampedArray([120, 80, 40, 255, 120, 80, 40, 255]),
    width: 2, height: 1
  }, { exposure: 100 }, { mask: new Float32Array([0, 1]) });
  t('掩膜 0 的像素完全不动', masked.data[0] === 120 && masked.data[1] === 80 && masked.data[2] === 40,
    [masked.data[0], masked.data[1], masked.data[2]]);
  t('掩膜 1 的像素被调整', masked.data[4] > 120, masked.data[4]);
  t('掩膜 0.5 的像素被调一半左右', (() => {
    const half = C.gradePixels({
      data: new Uint8ClampedArray([120, 80, 40, 255]), width: 1, height: 1
    }, { exposure: 100 }, { mask: new Float32Array([0.5]) });
    const full = px(C.gradePixels(mk(120, 80, 40), { exposure: 100 }));
    return half.data[0] > 120 && half.data[0] < full[0];
  })());
  t('掩膜长度不足时不崩', (() => {
    const r = C.gradePixels({ data: new Uint8ClampedArray([120, 80, 40, 255]), width: 1, height: 1 },
      { exposure: 100 }, { mask: new Float32Array(0) });
    return Number.isFinite(r.data[0]);
  })());

  // 11) 纯函数契约：不改入参
  t('不改入参像素（默认复制一份）', (() => {
    const src = mk(120, 80, 40);
    const before = src.data[0];
    C.gradePixels(src, { exposure: 100 });
    return src.data[0] === before;
  })());
  t('inPlace 时才写回原数组', (() => {
    const src = mk(120, 80, 40);
    C.gradePixels(src, { exposure: 100 }, { inPlace: true });
    return src.data[0] > 120;
  })());
  t('不改入参的 grade 对象', (() => {
    const g = { exposure: 999 };
    C.gradePixels(mk(120, 80, 40), g);
    return g.exposure === 999;
  })());

  // 12) 全透明像素：没有颜色可调，不能给它编出假颜色
  t('全透明像素保持全透明', (() => {
    const r = C.gradePixels(mk(0, 0, 0, 0), { exposure: 100 });
    return r.data[3] === 0;
  })());
  t('alpha 通道不被改动', (() => {
    const r = C.gradePixels(mk(120, 80, 40, 137), { exposure: 100 });
    return r.data[3] === 137;
  })());

  // 13) 脏输入不能让整块像素坏掉
  t('空图不崩', C.gradePixels(null, { exposure: 100 }).width === 0);
  t('data 为空不崩', C.gradePixels({ data: null, width: 5, height: 5 }, { exposure: 100 }).width === 5);
  t('宽高为 0 不崩', C.gradePixels({ data: new Uint8ClampedArray(4), width: 0, height: 0 },
    { exposure: 100 }).width === 0);
  t('多像素图全部被处理', (() => {
    const n = 64;
    const data = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) { data[i * 4] = 100; data[i * 4 + 1] = 100; data[i * 4 + 2] = 100; data[i * 4 + 3] = 255; }
    const r = C.gradePixels({ data, width: 8, height: 8 }, { exposure: 100 });
    for (let i = 0; i < n; i++) if (r.data[i * 4] <= 100) return false;
    return true;
  })());

  // 14) 描述文案（界面与撤销记录都要显示）
  t('全零描述为「未调整」', C.describeGrade(C.emptyGrade()) === '未调整');
  t('描述含曝光', /曝光 \+30/.test(C.describeGrade({ exposure: 30 })), C.describeGrade({ exposure: 30 }));
  t('描述含对比度', /对比/.test(C.describeGrade({ contrast: 20 })));
  t('描述含饱和度', /饱和/.test(C.describeGrade({ saturation: 20 })));
  t('描述用「偏暖」而不是正数', /偏暖/.test(C.describeGrade({ temperature: 30 })),
    C.describeGrade({ temperature: 30 }));
  t('描述用「偏冷」而不是负数', /偏冷/.test(C.describeGrade({ temperature: -30 })),
    C.describeGrade({ temperature: -30 }));
  t('描述用「偏绿」/「偏品红」', /偏品红/.test(C.describeGrade({ tint: 30 })) &&
    /偏绿/.test(C.describeGrade({ tint: -30 })), [C.describeGrade({ tint: 30 }), C.describeGrade({ tint: -30 })]);
  t('描述对 null 安全', C.describeGrade(null) === '未调整');
  t('多项描述用 · 分隔', /·/.test(C.describeGrade({ exposure: 10, contrast: 10 })),
    C.describeGrade({ exposure: 10, contrast: 10 }));

  // 15) 多像素一致性：同样颜色在任意位置结果相同（不能有位置相关 bug）
  t('同色像素结果一致（与位置无关）', (() => {
    const n = 4;
    const data = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) { data[i * 4] = 120; data[i * 4 + 1] = 80; data[i * 4 + 2] = 40; data[i * 4 + 3] = 255; }
    const r = C.gradePixels({ data, width: 4, height: 1 }, { exposure: 50, temperature: 30 });
    const first = [r.data[0], r.data[1], r.data[2]];
    for (let i = 1; i < n; i++) {
      if (r.data[i * 4] !== first[0] || r.data[i * 4 + 1] !== first[1] || r.data[i * 4 + 2] !== first[2]) return false;
    }
    return true;
  })());
})();
// ===== 基础调色块结束 =====

/* ---------- 新手教程（纯逻辑） ---------- */
(() => {
  // 首次启动要能走一遍「打开照片 → 框选 → 写要求 → 生成 → 对比/贴回 → 导出」
  t('教程步骤是数组', Array.isArray(C.TUTORIAL_STEPS));
  t('步骤数量够走完主流程', C.TUTORIAL_STEPS.length >= 5, C.TUTORIAL_STEPS.length);
  t('步数常量与数组一致', C.TUTORIAL_LEN === C.TUTORIAL_STEPS.length,
    [C.TUTORIAL_LEN, C.TUTORIAL_STEPS.length]);
  t('每步都有标题与说明',
    C.TUTORIAL_STEPS.every((s) => s.title && s.title.length > 2 && s.body && s.body.length > 4));
  t('每步都有摆位提示',
    C.TUTORIAL_STEPS.every((s) => ['top', 'bottom', 'center'].indexOf(s.place) >= 0),
    C.TUTORIAL_STEPS.map((s) => s.place));

  // 用户明确列出的流程，每一步都要在
  const targets = C.TUTORIAL_STEPS.map((s) => s.target).join(' ');
  t('教程覆盖「打开照片」', /#btn-open/.test(targets), targets);
  t('教程覆盖「框选」', /data-mode="select"/.test(targets), targets);
  t('教程覆盖「写要求」', /#prompt/.test(targets), targets);
  t('教程覆盖「生成」', /#btn-generate/.test(targets), targets);
  t('教程覆盖「对比/贴回」', /#cmp-apply/.test(targets), targets);
  t('教程覆盖「导出」', /#btn-save/.test(targets), targets);

  // 1) 该不该自动弹：只在真正第一次启动时
  t('首次启动要弹', C.planTutorial({ seen: false, hasPhoto: false }).show === true);
  t('首次启动的原因是 first-run',
    C.planTutorial({ seen: false, hasPhoto: false }).reason === 'first-run');
  t('看过之后不再弹', C.planTutorial({ seen: true, hasPhoto: false }).show === false);
  t('看过之后的原因是 seen',
    C.planTutorial({ seen: true, hasPhoto: false }).reason === 'seen');
  // 已经在编辑照片时不弹：用户显然会用了，而且盖住画布很讨厌
  t('正在编辑照片时不弹', C.planTutorial({ seen: false, hasPhoto: true }).show === false);
  t('正在编辑时不弹的原因说明了原因',
    C.planTutorial({ seen: false, hasPhoto: true }).reason === 'editing');
  t('planTutorial 对空参数安全', typeof C.planTutorial({}).show === 'boolean');
  t('planTutorial 对 null 安全', typeof C.planTutorial(null).show === 'boolean');

  // 2) 推进：下一步 / 上一步 / 结束
  const n = C.TUTORIAL_LEN;
  t('第 0 步的下一步是第 1 步', C.planTutorialStep(0, 'next').idx === 1);
  t('第 0 步不是结束', C.planTutorialStep(0, 'next').done === false);
  t('第 0 步处于开头', C.planTutorialStep(0, 'next').atStart === true);
  t('最后一步的下一步 = 结束', C.planTutorialStep(n - 1, 'next').done === true);
  t('结束后索引被夹在最后一步（不越界）',
    C.planTutorialStep(n - 1, 'next').idx === n - 1, C.planTutorialStep(n - 1, 'next').idx);
  t('最后一步被标为末尾', C.planTutorialStep(n - 1, 'next').atEnd === true);
  t('上一步能退回', C.planTutorialStep(2, 'prev').idx === 1);
  t('第 0 步的上一步不越界', C.planTutorialStep(0, 'prev').idx === 0);
  t('第 0 步的上一步仍在开头', C.planTutorialStep(0, 'prev').atStart === true);
  t('上一步不会「结束」', C.planTutorialStep(0, 'prev').done === false);
  // 脏数据不能让界面卡住（索引 NaN / 越界）
  t('索引为 NaN 时夹到第 0 步', C.planTutorialStep(NaN, 'next').idx === 1,
    C.planTutorialStep(NaN, 'next'));
  t('索引为 null 时夹到第 0 步', C.planTutorialStep(null, 'prev').idx === 0);
  t('索引越界（大于步数）时夹到末尾',
    C.planTutorialStep(999, 'prev').idx === n - 2, C.planTutorialStep(999, 'prev').idx);
  t('索引为负时夹到开头', C.planTutorialStep(-5, 'next').idx === 1);
  t('未知方向时原地不动', C.planTutorialStep(1, 'sideways').idx === 1);
  t('方向为 undefined 时原地不动', C.planTutorialStep(1).idx === 1);
  t('全部返回有限数字', (() => {
    for (const i of [-1, 0, 1, n - 1, n, 1e9, 'x', null]) {
      const r = C.planTutorialStep(i, 'next');
      if (!Number.isFinite(r.idx) || r.idx < 0 || r.idx > n - 1) return false;
    }
    return true;
  })());
})();
// ===== 新手教程块结束 =====

/* ---------- 调用日志（纯逻辑） ---------- */
(() => {
  // 生图按次花钱，用户需要能自己核对「哪几次调用了、花了多少、为什么失败」。
  const mk = (o) => Object.assign({
    at: 1700000000000, provider: 'siliconflow', model: 'Qwen/Qwen-Image-Edit',
    prompt: '把背景换成海边', imgW: 1024, imgH: 1024, imgBytes: 120000,
    ms: 32000, ok: true, error: '', status: 200, costUsd: 0.04, costNote: ''
  }, o || {});

  // 1) 追加：最新的在前，且不改入参
  const a = C.appendCallLog([], mk({ at: 1 }));
  const b = C.appendCallLog(a, mk({ at: 2 }));
  t('追加一条得到长度 1', a.length === 1, a.length);
  t('再追加一条得到长度 2', b.length === 2, b.length);
  t('最新的排在最前面（不用滚到底）', b[0].at === 2 && b[1].at === 1, b.map((e) => e.at));
  t('追加不改原数组', a.length === 1 && a[0].at === 1, a.map((e) => e.at));
  t('空/null 输入安全', C.appendCallLog(null, mk()).length === 1);
  t('空 entry 也安全（补默认值）', (() => {
    const r = C.appendCallLog([], null);
    return r.length === 1 && r[0].ok === false && typeof r[0].at === 'number';
  })());

  // 2) 环形缓冲：上限之外的老条目必须被挤掉
  let list = [];
  for (let i = 1; i <= 150; i++) list = C.appendCallLog(list, mk({ at: i }));
  t('条数被上限截住', list.length === C.CALL_LOG_MAX, list.length);
  t('上限是 100 量级（不会把 localStorage 撑爆）',
    C.CALL_LOG_MAX >= 20 && C.CALL_LOG_MAX <= 500, C.CALL_LOG_MAX);
  t('保留的是最近的（最老的第 1 条已被挤掉）', list[list.length - 1].at === 51,
    [list[0].at, list[list.length - 1].at]);
  t('第一条就是最新的', list[0].at === 150, list[0].at);
  // 自定义上限也要生效
  const small = C.appendCallLog(C.appendCallLog([], mk({ at: 1 }), 2), mk({ at: 2 }), 2);
  t('自定义上限生效', small.length === 2, small.length);
  t('上限非法值不会变成 0 条', C.appendCallLog([mk()], mk(), 0).length === 1);

  // 3) 提示词截断：完整提示词可能上千字，100 条就是几百 KB
  const longPrompt = '改'.repeat(500);
  const truncated = C.appendCallLog([], mk({ prompt: longPrompt }))[0];
  t('提示词被截断', truncated.prompt.length <= C.CALL_LOG_PROMPT_CHARS + 1,
    truncated.prompt.length);
  t('截断后带省略号（看得出被截了）', /…$/.test(truncated.prompt), truncated.prompt.slice(-3));
  t('记下了原始长度', truncated.promptLen === 500, truncated.promptLen);
  t('短提示词原样保留', C.appendCallLog([], mk({ prompt: '改成红色' }))[0].prompt === '改成红色');
  t('promptLen 可由调用方显式指定',
    C.appendCallLog([], mk({ prompt: 'abc', promptLen: 999 }))[0].promptLen === 999);
  t('truncateText 对 null 安全', C.truncateText(null, 10) === '');
  t('truncateText 不截断短文本', C.truncateText('abc', 10) === 'abc');

  // 4) 关键：绝不能把图片 base64 存进日志（那会让日志变成第二个存储黑洞）
  const withBase = C.appendCallLog([], mk({ image: 'data:image/png;base64,' + 'A'.repeat(5000) }))[0];
  t('日志条目里没有 base64 图片字段', !('image' in withBase) && !('base64' in withBase),
    Object.keys(withBase));
  t('日志条目里没有 dataUrl', !JSON.stringify(withBase).includes('base64'),
    JSON.stringify(withBase).slice(0, 120));
  t('图片只记尺寸与字节数', withBase.imgW === 1024 && withBase.imgBytes === 120000,
    [withBase.imgW, withBase.imgBytes]);
  // 单条日志的体积必须很小，100 条加起来才不至于占地方
  t('单条日志体积 < 2KB', JSON.stringify(withBase).length < 2048, JSON.stringify(withBase).length);

  // 5) 失败调用必须被记录，且带错误原因
  const failed = C.appendCallLog([], mk({
    ok: false, status: 401, error: 'HTTP 401 · API Key 无效', costUsd: null, costNote: '单价未知'
  }))[0];
  t('失败被记为 ok:false', failed.ok === false);
  t('失败记下了 HTTP 状态', failed.status === 401, failed.status);
  t('失败记下了错误原因', /API Key 无效/.test(failed.error), failed.error);
  t('错误原因有长度上限（防止上游回一坨 HTML）',
    C.appendCallLog([], mk({ error: 'x'.repeat(5000) }))[0].error.length <= 300,
    C.appendCallLog([], mk({ error: 'x'.repeat(5000) }))[0].error.length);
  t('单价未知记为 null（而不是 0）',
    failed.costUsd === null, failed.costUsd);

  // 6) 统计：成功/失败计数、花费累加、未知单价单独报
  const st = C.callLogStats([
    mk({ ok: true, costUsd: 0.04, ms: 30000 }),
    mk({ ok: true, costUsd: 0.04, ms: 50000 }),
    mk({ ok: false, costUsd: null, ms: 0 })
  ]);
  t('统计总数', st.count === 3, st.count);
  t('统计成功数', st.ok === 2, st.ok);
  t('统计失败数', st.failed === 1, st.failed);
  t('花费只累加已知单价', Math.abs(st.usd - 0.08) < 1e-9, st.usd);
  t('未知单价单独报条数（不能当成 0 混进去）', st.unknown === 1, st.unknown);
  t('平均耗时按有耗时的条目算', st.avgMs === 40000, st.avgMs);
  t('统计对空数组安全', C.callLogStats([]).count === 0 && C.callLogStats([]).usd === 0);
  t('统计对 null 安全', C.callLogStats(null).count === 0);

  // 7) 导出文本：人读的，必须带关键信息，且按时间正序
  const text = C.callLogToText([
    mk({ at: new Date(2024, 8, 23, 10, 0, 5).getTime(), prompt: '把背景换成海边' }),
    mk({ at: new Date(2024, 8, 23, 10, 5, 30).getTime(), ok: false, error: 'HTTP 429 · 触发限流', costUsd: null })
  ], { now: new Date(2024, 8, 23, 11, 0, 0).getTime(), version: '9.9.9' });
  t('文本含标题', /调用日志/.test(text), text.slice(0, 40));
  t('文本含导出时间', /2024-09-23 11:00:00/.test(text), text.slice(0, 200));
  t('文本含版本号', /9\.9\.9/.test(text));
  t('文本含总次数', /共 2 次/.test(text));
  t('文本含成功失败数', /成功 1 次/.test(text) && /失败 1 次/.test(text));
  t('文本含模型名', /Qwen\/Qwen-Image-Edit/.test(text));
  t('文本含发送图片尺寸', /1024×1024/.test(text));
  t('文本含耗时（秒）', /32\.0 秒/.test(text), text.match(/耗时[^\n]*/));
  t('文本含花费', /\$0\.04/.test(text));
  t('文本含提示词', /把背景换成海边/.test(text));
  t('文本含失败原因', /HTTP 429/.test(text));
  t('文本含单价未知的说明', /单价未知|未收录价格/.test(text));
  // 内部存储是倒序（界面先看最新的），导出文本要翻成时间正序（人读日志的习惯）
  const iFirst = text.indexOf('2024-09-23 10:00:05');
  const iSecond = text.indexOf('2024-09-23 10:05:30');
  t('文本按时间正序（早的在前）', iFirst >= 0 && iSecond > iFirst, [iFirst, iSecond]);
  t('文本对空日志不崩', /还没有任何调用记录/.test(C.callLogToText([], {})));
  t('文本对 null 不崩', typeof C.callLogToText(null, {}) === 'string');

  // 8) 导出 JSON：必须是**合法 JSON**，且结构稳定（脚本要能直接读）
  const json = C.callLogToJson([mk({ at: 1 }), mk({ at: 2, ok: false, error: 'x' })], {
    now: 1700000000000, version: '1.2.3'
  });
  let parsed = null, parseErr = null;
  try { parsed = JSON.parse(json); } catch (e) { parseErr = e; }
  t('导出的 JSON 合法', !parseErr, parseErr && parseErr.message);
  t('JSON 带应用标识', parsed && parsed.app === 'photo-studio', parsed && parsed.app);
  t('JSON 带版本号', parsed && parsed.version === '1.2.3');
  t('JSON 带导出时间', parsed && parsed.exportedAt === 1700000000000);
  t('JSON 带统计头', parsed && parsed.stats && parsed.stats.count === 2, parsed && parsed.stats);
  t('JSON 带条目数组', parsed && Array.isArray(parsed.entries) && parsed.entries.length === 2);
  t('JSON 保留顺序（最新在前，与界面一致）',
    parsed.entries[0].at === 2 && parsed.entries[1].at === 1,
    parsed.entries.map((e) => e.at));
  t('JSON 里失败的条目带 error', parsed.entries[0].ok === false && parsed.entries[0].error === 'x');
  t('JSON 对空日志也合法', (() => {
    try { return JSON.parse(C.callLogToJson([], {})).entries.length === 0; } catch (e) { return false; }
  })());

  // 9) 时间格式化
  t('formatDateTime 补零', C.formatDateTime(new Date(2024, 0, 5, 9, 5, 3).getTime()) === '2024-01-05 09:05:03',
    C.formatDateTime(new Date(2024, 0, 5, 9, 5, 3).getTime()));
  t('formatDateTime 对 0 返回空', C.formatDateTime(0) === '');
  t('formatDateTime 对脏值返回空', C.formatDateTime('x') === '');
  t('formatDateTime 对 null 返回空', C.formatDateTime(null) === '');

  // 10) 作品归属：日志要能对上「哪张照片」
  t('记下了 workId（便于查「这张花了几次」）',
    C.appendCallLog([], mk({ workId: 'w123' }))[0].workId === 'w123');
  t('没有 workId 时是空串（不是 undefined）',
    C.appendCallLog([], mk({}))[0].workId === '');
})();
// ===== 调用日志块结束 =====

/* ---------- 作品库：历史记录必须存得住多张（纯逻辑） ---------- */
(() => {
  // 回归的 bug：修第 2 张时第 1 张整条被清理，修第 3 张时第 2 张被清理 ——
  // 用户看到的就是「历史记录只保存得下一张」。
  //
  // 根因：只有一个总预算，且会话基准图是整张工作图的 JPEG（3072px 约 1.1MB，
  // Base64 + UTF-16 后近 3MB），一条就超过 2.5MB 的总预算 →
  // 每存一条新的就把上一条整条淘汰。
  //
  // 修复：会话单独一层预算 + 基准图缩到 2048px + 缩略图缩到 320px。

  // 用**实测体积**构造记录，而不是随便编的数字 —— 编小了就测不出这个 bug。
  // 数据来自 tools/regression-test.js 里的真实 canvas 测量。
  const BASE_CHARS = Math.round(1.11 * 1024 * 1024 / 2);    // 2048px q0.75 基准图
  const PATCH_CHARS = 60 * 1024;                            // 一次典型编辑的 patch
  const THUMB_CHARS = Math.round(28 * 1024 / 2);             // 320px q0.68 缩略图
  const realWork = (id, at) => ({
    id, at, name: 'photo.jpg', thumb: 't'.repeat(THUMB_CHARS),
    session: { base: 'b'.repeat(BASE_CHARS), items: [{ patch: 'p'.repeat(PATCH_CHARS) }] }
  });
  const opts = (pinned) => ({
    maxBytes: C.LIBRARY_BUDGET_BYTES,
    maxItems: C.LIBRARY_MAX_ITEMS,
    sessionBudgetBytes: C.SESSION_BUDGET_BYTES,
    pinnedId: pinned || null
  });

  // 1) 单条记录的体积必须远小于总预算 —— 否则「只存得下一张」是必然的
  const oneBytes = C.estimateWorkBytes(realWork('a', 1));
  t('单条记录体积 < 总预算的一半', oneBytes < C.LIBRARY_BUDGET_BYTES * 0.5,
    { oneBytes, budget: C.LIBRARY_BUDGET_BYTES });
  t('单条记录体积 >= 1MB（说明用的是真实照片的量级）', oneBytes >= 1024 * 1024, oneBytes);

  // 2) 核心回归：连续导入 3 张照片、各改一次，三条都必须还在列表里
  let lib = [];
  for (let i = 0; i < 3; i++) {
    lib.unshift(realWork('w' + i, 1000 + i));
    const plan = C.planLibrary(lib, opts('w' + i));
    if (plan.downgradeIds.length) for (const e of lib) if (plan.downgradeIds.includes(e.id)) e.session = null;
    if (plan.evictIds.length) lib = lib.filter((e) => !plan.evictIds.includes(e.id));
  }
  t('3 张照片全部留在列表里', lib.length === 3, lib.map((e) => e.id));
  t('3 张里没有一张被淘汰', lib.every((e) => e.id), lib.map((e) => e.id));
  t('第 1 张没有被清理', lib.some((e) => e.id === 'w0'), lib.map((e) => e.id));
  t('最新的那张可继续编辑', lib.filter((e) => e.session).some((e) => e.id === 'w2'),
    lib.map((e) => ({ id: e.id, s: !!e.session })));
  // 至少要能同时留住两张的会话 —— 只留最新一张的话，用户切回去就发现上一张改不了了
  t('至少 2 张可继续编辑', lib.filter((e) => e.session).length >= 2,
    lib.filter((e) => e.session).map((e) => e.id));

  // 3) 继续加到 8 张：列表仍然全在（降级只丢会话，不丢条目）
  for (let i = 3; i < 8; i++) {
    lib.unshift(realWork('w' + i, 1000 + i));
    const plan = C.planLibrary(lib, opts('w' + i));
    if (plan.downgradeIds.length) for (const e of lib) if (plan.downgradeIds.includes(e.id)) e.session = null;
    if (plan.evictIds.length) lib = lib.filter((e) => !plan.evictIds.includes(e.id));
  }
  t('8 张照片全部留在列表里', lib.length === 8, lib.length);
  t('8 张里最新的两张可继续编辑',
    lib.filter((e) => e.session).length >= 2, lib.filter((e) => e.session).map((e) => e.id));
  t('占用不超总预算', C.workLibraryStats(lib).bytes <= C.LIBRARY_BUDGET_BYTES,
    [C.workLibraryStats(lib).bytes, C.LIBRARY_BUDGET_BYTES]);

  // 4) 会话预算真的在起作用：超过预算时降级最老的会话，**但不淘汰条目**
  const many = [];
  for (let i = 0; i < 10; i++) many.push(realWork('w' + i, 1000 + i));
  const p = C.planLibrary(many, opts('w9'));
  t('超会话预算时降级而不是淘汰', p.evictIds.length === 0, p.evictIds);
  t('降级的是最老的几条', p.downgradeIds.indexOf('w0') >= 0, p.downgradeIds);
  t('最新的不被降级', p.downgradeIds.indexOf('w9') < 0, p.downgradeIds);
  t('降级后条数不变（列表全留）', p.keepIds.length === 10, p.keepIds.length);
  t('降级后会话占用回到预算内', p.sessionBytes <= C.SESSION_BUDGET_BYTES,
    [p.sessionBytes, C.SESSION_BUDGET_BYTES]);
  t('降级后总体积不超总预算', p.bytes <= C.LIBRARY_BUDGET_BYTES,
    [p.bytes, C.LIBRARY_BUDGET_BYTES]);

  // 5) pinnedId（当前正在编辑的这张）**既不被淘汰也不被降级** ——
  //    否则刚修完切回去，发现「这张不能继续编辑了」
  const pinP = C.planLibrary(many, Object.assign(opts('w0'), { sessionBudgetBytes: 1 }));
  t('置顶项不被淘汰（即便它最老）', pinP.evictIds.indexOf('w0') < 0, pinP.evictIds);
  t('置顶项不被降级（即便预算极小）', pinP.downgradeIds.indexOf('w0') < 0, pinP.downgradeIds);
  t('置顶项仍在保留列表里', pinP.keepIds.indexOf('w0') >= 0, pinP.keepIds);

  // 6) 只有缩略图本身就装不下时，才整条淘汰（保留至少 1 条）
  const hugeThumbs = [];
  for (let i = 0; i < 5; i++) {
    hugeThumbs.push({ id: 'w' + i, at: 1000 + i, thumb: 't'.repeat(3 * 1024 * 1024), session: null });
  }
  const ph = C.planLibrary(hugeThumbs, { maxBytes: 8 * 1024 * 1024, maxItems: 80 });
  t('缩略图装不下时才会整条淘汰', ph.evictIds.length > 0, ph.evictIds.length);
  t('缩略图超预算时也至少留 1 条', ph.keepIds.length >= 1, ph.keepIds.length);

  // 7) 返回的 sessionBytes 口径要等于真实会话占用（降级的算 0）
  const sb = C.planLibrary(many, opts('w9'));
  const realSessionBytes = sb.keepIds.reduce((s, id) => {
    const e = many.find((x) => x.id === id);
    if (!e.session || sb.downgradeIds.indexOf(id) >= 0) return s;
    return s + C.storageBytes(JSON.stringify(e.session));
  }, 0);
  t('sessionBytes 等于真实会话占用', sb.sessionBytes === realSessionBytes,
    { got: sb.sessionBytes, want: realSessionBytes });

  // 8) 纯函数契约：不改入参、不返回重复 id
  t('planLibrary 不改原数组的 session', (() => {
    const arr = [realWork('a', 1)];
    const before = arr[0].session;
    C.planLibrary(arr, opts());
    return arr[0].session === before;
  })());
  t('keepIds 与 evictIds 不重叠', (() => {
    const all = sb.keepIds.concat(sb.evictIds);
    return new Set(all).size === all.length;
  })());
})();
// ===== 作品库多张留档块结束 =====

/* ---------- 滑块「只能拖滑块头」（纯几何判定） ---------- */
(() => {
  // 场景：设置页里滑块上下紧挨着别的设置项，想拖动时手指偏到轨道上，
  // 原生行为会把值瞬间跳到点击位置（比如「融合强度」直接归零）。
  // 这里验证「滑块头中心在哪 / 这次按下要不要拦」的判定。
  const W = 200;      // 元素宽
  const TW = 17;      // 滑块头宽
  const L = 30;       // 元素左边（视口坐标）

  // 1) 滑块头中心 = 左边缘 + 半个滑块头 + 进度 × (宽度 − 滑块头宽)
  const mid = C.sliderThumbGeometry({
    value: 50, min: 0, max: 100, rectLeft: L, rectWidth: W, thumbWidth: TW
  });
  t('滑块头在 50% 处居中', Math.abs(mid.thumbX - (L + TW / 2 + 0.5 * (W - TW))) < 1e-9, mid.thumbX);
  t('轨道可用宽度扣掉滑块头', Math.abs(mid.trackWidth - (W - TW)) < 1e-9, mid.trackWidth);
  t('进度比例正确', Math.abs(mid.ratio - 0.5) < 1e-9, mid.ratio);

  // 2) 两端：值=min 时滑块头贴着左边缘；值=max 时贴着右边缘
  const lo = C.sliderThumbGeometry({ value: 0, min: 0, max: 100, rectLeft: L, rectWidth: W, thumbWidth: TW });
  const hi = C.sliderThumbGeometry({ value: 100, min: 0, max: 100, rectLeft: L, rectWidth: W, thumbWidth: TW });
  t('值为 min 时滑块头中心 = 左边缘 + 半宽', Math.abs(lo.thumbX - (L + TW / 2)) < 1e-9, lo.thumbX);
  t('值为 max 时滑块头中心 = 右边缘 − 半宽', Math.abs(hi.thumbX - (L + W - TW / 2)) < 1e-9, hi.thumbX);
  t('滑块头中心不会超出元素', lo.thumbX >= L && hi.thumbX <= L + W, [lo.thumbX, hi.thumbX, L, L + W]);

  // 3) 非 0 起始的区间（如「编辑历史内存上限」是 64~512）
  const mem = C.sliderThumbGeometry({ value: 192, min: 64, max: 512, rectLeft: 0, rectWidth: 400, thumbWidth: TW });
  const wantRatio = (192 - 64) / (512 - 64);
  t('非 0 起点的区间按比例算', Math.abs(mem.ratio - wantRatio) < 1e-9, mem.ratio);
  t('非 0 起点也能算出中心', mem.thumbX > 0 && mem.thumbX < 400, mem.thumbX);

  // 4) 越界值 / 非法区间不能算出 NaN（NaN 会让判定全部失效 → 滑块拖不动）
  const over = C.sliderThumbGeometry({ value: 999, min: 0, max: 100, rectLeft: 0, rectWidth: W, thumbWidth: TW });
  const under = C.sliderThumbGeometry({ value: -999, min: 0, max: 100, rectLeft: 0, rectWidth: W, thumbWidth: TW });
  t('值超上限时夹到 1', over.ratio === 1, over.ratio);
  t('值超下限时夹到 0', under.ratio === 0, under.ratio);
  const bad = C.sliderThumbGeometry({ value: 5, min: 100, max: 0, rectLeft: 0, rectWidth: W, thumbWidth: TW });
  t('区间非法时不产生 NaN', Number.isFinite(bad.thumbX) && Number.isFinite(bad.ratio), bad);
  const nan = C.sliderThumbGeometry({ value: 'x', min: 'y', max: 'z', rectLeft: 'a', rectWidth: 'b', thumbWidth: 'c' });
  t('全部脏输入也不产生 NaN', Number.isFinite(nan.thumbX) && Number.isFinite(nan.distance), nan);
  t('空参数不崩', Number.isFinite(C.sliderThumbGeometry().thumbX));

  // 5) 判定：贴着滑块头 → 不拦；离得远 → 拦
  const atThumb = C.planSliderHit({
    value: 50, min: 0, max: 100, rectLeft: L, rectWidth: W, thumbWidth: TW,
    pointerX: mid.thumbX
  });
  t('点在滑块头正中不拦（能正常拖动）', atThumb.block === false, atThumb);
  const nearThumb = C.planSliderHit({
    value: 50, min: 0, max: 100, rectLeft: L, rectWidth: W, thumbWidth: TW,
    pointerX: mid.thumbX + 6      // 半个滑块头（8.5）以内
  });
  t('点在滑块头边缘不拦', nearThumb.block === false, nearThumb);
  const farAway = C.planSliderHit({
    value: 50, min: 0, max: 100, rectLeft: L, rectWidth: W, thumbWidth: TW,
    pointerX: L + 3               // 轨道最左端，离滑块头很远
  });
  t('点在轨道远处要拦（防止跳值）', farAway.block === true, farAway);
  t('拦下时给出距离（便于调试）', farAway.distance > 0, farAway.distance);

  // 6) 边界：刚好等于 slack 不拦（「>」而不是「>=」，避免临界点行为飘忽）
  const slack = TW / 2 + 6;
  const exact = C.planSliderHit({
    value: 50, min: 0, max: 100, rectLeft: L, rectWidth: W, thumbWidth: TW,
    pointerX: mid.thumbX + slack
  });
  t('距离正好等于阈值时不拦', exact.block === false, exact);
  const over1 = C.planSliderHit({
    value: 50, min: 0, max: 100, rectLeft: L, rectWidth: W, thumbWidth: TW,
    pointerX: mid.thumbX + slack + 1
  });
  t('超过阈值 1px 就拦', over1.block === true, over1);

  // 7) 拿不到滑块头宽度时用常量兜底（老内核读不到自定义属性）
  t('有滑块头宽度常量', C.SLIDER_THUMB_PX > 0, C.SLIDER_THUMB_PX);
  const noThumbW = C.planSliderHit({
    value: 50, min: 0, max: 100, rectLeft: L, rectWidth: W, pointerX: L + 3
  });
  t('缺 thumbWidth 时仍能判定', noThumbW.block === true, noThumbW);

  // 8) 元素宽度为 0（隐藏 / 内核不做布局）时，中心退化成左边缘 + 半宽，
  //    不产生 NaN —— app 侧对这种情况会直接放行（拦了滑块就彻底拖不动）
  const zero = C.sliderThumbGeometry({ value: 50, min: 0, max: 100, rectLeft: 10, rectWidth: 0, thumbWidth: TW });
  t('宽度为 0 时轨道宽度为 0', zero.trackWidth === 0, zero.trackWidth);
  t('宽度为 0 时仍能算出中心', Number.isFinite(zero.thumbX), zero.thumbX);
})();
// ===== 滑块只能拖滑块头块结束 =====

/* ---------- 检查更新 ---------- */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
