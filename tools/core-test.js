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

// --- 分块 ---
(()=>{const t1=C.planTileCrop({x:0,y:0,w:800,h:600},{maxSide:1400});t('tile single', t1.length===1);})();
(()=>{const t2=C.planTileCrop({x:0,y:0,w:3000,h:2000},{maxSide:1400,overlap:100});t('tile grid >1', t2.length>=4, t2.length);
  let coversAll=true; const cx=1500,cy=1000; let hit=0;
  for(const q of t2){ if(q.w>1400||q.h>1400) coversAll=false; if(cx>=q.x&&cx<q.x+q.w&&cy>=q.y&&cy<q.y+q.h) hit++; }
  t('tiles within maxSide', coversAll); t('tiles cover center', hit>=1, hit);})();

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
t('tileHint none', C.tileHint(0,1,true)==='');
t('tileHint zh', C.tileHint(1,4,true).includes('2/4'), C.tileHint(1,4,true));

t('formatBytes', C.formatBytes(1536)==='1.5 KB');
t('timestampName ext', /^photo_\d{8}_\d{6}\.jpg$/.test(C.timestampName('photo','jpg')));
t('estimateCalls', C.estimateCalls({x:0,y:0,w:3000,h:3000},{maxSide:1400,overlap:100})>1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
