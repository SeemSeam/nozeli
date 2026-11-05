import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';
const hostRoot=process.env.NOZELI_TEST_BINARY?path.join(path.dirname(process.env.NOZELI_TEST_BINARY),'resources/app'):path.resolve(import.meta.dirname,'..');
const {DesktopHost}=await import(pathToFileURL(path.join(hostRoot,'src/main/host.mjs')).href);
import {serve} from './pi-provider.fixture.mjs';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';

// Natural Chinese journey, real private Pi/tools/files + actual X11 window pixels.
// The local HTTP response is scripted, not model-understanding evidence.
const app=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),exec=promisify(execFile);
assert(process.env.DISPLAY,'M5 composite evidence requires an actual X11/XWayland display; no DOM substitute');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-ux-batch2-zh-')),config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),root=path.join(out,'组会材料');
await fs.mkdir(root);
const relPath='笔记/访谈摘要.md';
const source='# 组会材料\n\n访谈为合成样本：10人中8人来自同一实验室，未做长期追踪。\n';
await fs.writeFile(path.join(root,'材料说明.md'),source);
const host=new DesktopHost(profile),project=(await host.pick(root)).project;await host.storage.db.close();
const request='请整理一份访谈摘要，说明主要发现、样本局限和还需核对的内容，供组会审阅。';
const question='这里的十人样本为什么不能代表所有研究者？先解释，不要增加结论。';
const modification='把结论写得更简洁，明确说明没有做长期追踪。';
const unsent='我还想补充跨实验室样本的讨论，这条意见先留着，不发送。';
const answer='十人样本主要来自同一实验室，来源集中，且没有长期追踪。因此只能描述这组材料，不能代表所有研究者。这一解释不改变报告结论，当前版本保留。';
const originalCandidate='# 访谈摘要\n\n## 主要发现\n参与者希望更快找到原文依据，并保留自己的阅读笔记。\n\n## 样本局限\n共10位合成参与者，8位来自同一实验室，不能代表所有研究者。\n\n## 待核对\n没有长期追踪，尚不能判断持续使用效果。\n';
const revisedCandidate='# 访谈摘要\n\n## 主要发现\n本组样本重视原文依据与笔记保留。\n\n## 样本局限\n10位合成参与者中8位来自同一实验室，不代表所有研究者。没有长期追踪，持续使用效果待核对。\n';
const humanNote='\n## 我的审阅补充\n采用时保留这条人工说明：样本仅用于流程演示，不作为研究结论。\n';
const htmlReport=version=>`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>访谈摘要 · 第${version}版</title><style>body{font:16px/1.9 system-ui;margin:0;padding:28px;color:inherit}h1{font-size:26px}h2{font-size:19px}main{max-width:720px;margin:auto}aside{border-left:3px solid currentColor;padding:10px 15px;opacity:.85}</style></head><body><main><h1>访谈摘要</h1><p>本报告基于合成访谈材料，供组会审阅与交互验证。</p><h2>结论</h2><p>${version===1?'参与者希望更快定位依据、保留阅读笔记。样本集中在单一实验室，尚不能外推总体。':'本组样本重视依据定位与笔记保留，不能代表所有研究者。没有长期追踪，持续效果待核对。'}</p><h2>改动文件</h2><p><a href="${relPath}">${relPath}</a> · 候选文件，采用前不写入项目。</p><aside><b>尚未核实</b><br>没有独立用户研究；不声称AI推理或长期效果已验证。人工修改保存在文件审阅稿中，旧报告正文不会随之改写。</aside><h2>依据与范围</h2><p>10位合成参与者，8位来自同一实验室，未作长期追踪。请结合原材料和自己的判断采用。</p></main></body></html>`;
const text=m=>typeof m.content==='string'?m.content:m.content?.filter(p=>p.type==='text').map(p=>p.text).join('')||'';
const calls=[];
const provider=await serve(r=>{
 const names=r.tools?.map(t=>t.function?.name)||[];
 if(names.includes('nozeli_dispatch'))return {tool:'nozeli_dispatch',id:'zh-dispatch',args:{name:'访谈摘要',brief:request+' 候选相对路径为'+relPath+'。'}};
 const inputs=r.messages.filter(m=>m.role==='user').map(text);
 const phase=inputs.findLast(t=>[question,modification].includes(t.trim()))?.trim();calls.push(phase||'初稿');
 if(phase===question)return {text:answer};
 const version=phase===modification?2:1,id=version===1?'zh-initial-write':'zh-revised-write';
 if(!r.messages.some(m=>m.tool_call_id===id))return {tool:'write',id,args:{path:relPath,content:version===1?originalCandidate:revisedCandidate}};
 return {tool:'nozeli_publish',id:version===1?'zh-publish-1':'zh-publish-2',args:{kind:'result',content:htmlReport(version),files:[relPath]}};
});
let child,browser,shell,review,doc,observer,exit,log='',windowId;const errors=[];
const report={ok:false,out,version:'0.1.0-alpha.5-source-ux-batch4',scope:'Actual Electron/private Pi/native files and X11 window capture, Chinese scripted local Provider, no paid model/user project',steps:[],screenshots:[],checks:[],notCovered:['真实模型理解','Windows/macOS','R01/R02与未知效果恢复','同文件合入冲突解决']};
report.narrowStackProof={window:{width:800,height:650,fonts:'default',zoomFactorExpected:1},batch:'ux-batch4',floatingUsed:false,scrollActions:[],layoutAdjustments:[],restorations:[],states:{},checks:[]};
report.freePlacement={steps:[],note:'自由摆放序列独立记录；默认并读证明的滚动/布局调整可单独统计'};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('App exited '+log);const v=await fn();if(v)return v;await pause(70);}throw Error('Timeout '+label);}
async function invoke(page,op,p={}){const r=await page.evaluate(({op,p})=>window.nozeli.invoke(op,p),{op,p});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
report.binary=process.env.NOZELI_TEST_BINARY||require('electron');
if(process.env.NOZELI_TEST_BINARY)report.version='0.1.0-alpha.5-installed-'+path.basename(path.dirname(process.env.NOZELI_TEST_BINARY));
const state=async()=> (await invoke(shell,'managed.status',{projectId:project.id})).state;
async function shot(name,{page=review,floatVisible,distinctFrom}={}){
 const url=page.url();
 await until(()=>observer.evaluate(`(()=>{const {BaseWindow}=process.mainModule.require('electron');return BaseWindow.getAllWindows().some(win=>(win.contentView.children||[]).some(view=>view.getVisible?.()&&view.webContents?.getURL()===${JSON.stringify(url)}));})()`),'expected native page visible for '+name);
 if(typeof floatVisible==='boolean')await review.waitForFunction(expected=>{const el=document.querySelector('[data-review-discussion]');return Boolean(el&&!el.hidden&&el.getClientRects().length)===expected;},{},floatVisible);
 const visibleState=await page.evaluate(()=>({scope:window.__workspaceScope,discussionVisible:Boolean(document.querySelector('[data-review-discussion]:not([hidden])')?.getClientRects().length),draft:document.querySelector('[data-review-instruction]')?.value,layout:document.querySelector('.managed-review')?.dataset.reviewLayout,reportBox:(()=>{const el=document.querySelector('.managed-report-body');if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()}));
 const file=path.join(out,name+'.png');let changedPixels=null,attempts=0;
 for(;attempts<8;attempts++){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await observer.evaluate(`(async()=>{const {BaseWindow}=process.mainModule.require('electron');for(const win of BaseWindow.getAllWindows())for(const view of win.contentView.children||[])if(view.getVisible?.()&&view.webContents&&!view.webContents.isDestroyed())await view.webContents.capturePage(undefined,{stayAwake:true});return true;})()`,15000);
  await pause(200);
  const info=(await exec('xwininfo',['-id',windowId],{timeout:5000})).stdout;
  const width=Number(/Width:\s+(\d+)/.exec(info)?.[1]),height=Number(/Height:\s+(\d+)/.exec(info)?.[1]);
  assert(width>0&&height>0,'owned X11 window dimensions are required');
  const clip=path.join(out,name+'-frames.mkv');
  await exec('ffmpeg',['-y','-loglevel','error','-f','x11grab','-framerate','10','-draw_mouse','0','-window_id',windowId,'-video_size',width+'x'+height,'-i',process.env.DISPLAY,'-t','1.2','-c:v','ffv1','-pix_fmt','bgr0',clip],{timeout:10000});
  await exec('ffmpeg',['-y','-loglevel','error','-sseof','-0.15','-i',clip,'-frames:v','1',file],{timeout:10000});
  if(!distinctFrom)break;
  const comparison=await exec('compare',['-metric','AE',path.join(out,distinctFrom+'.png'),file,'null:']).catch(error=>error);
  changedPixels=Number.parseFloat(String(comparison.stderr||'').trim());
  assert(Number.isFinite(changedPixels),'pixel comparison must yield an actual count');
  if(changedPixels>5000)break;
 }
 if(distinctFrom)assert(changedPixels>5000,'changed UI state requires a genuinely changed window image: '+name);
 const geometry=await invoke(shell,'workspace.control',{type:'window-control',action:'state'});
 report.screenshots.push({file,recording:path.join(out,name+'-frames.mkv'),name,capture:'actual-X11-owned-window-recording-final-frame',geometry,visibleState,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex'),distinctFrom,changedPixels,captureAttempts:attempts+1});
}
async function activePage(kind){return until(async()=>{for(const p of await browser.pages())if(await p.evaluate(kind=>window.__nozeliReady&&window.__workspaceScope?.kind===kind,kind).catch(()=>false))return p;},kind);}
async function submit(value){await review.waitForFunction(()=>{const n=document.querySelector('[data-review-instruction]');return n&&!n.disabled&&!n.readOnly;});await review.$eval('[data-review-instruction]',(n,t)=>{n.value=t;n.dispatchEvent(new Event('input',{bubbles:true}));},value);await review.waitForSelector('[data-review-action="send"]:not([disabled])',{visible:true});await review.click('[data-review-action="send"]');await until(async()=>{const s=await state(),j=s.jobs.find(j=>j.text===value);if(j&&['failed','unknown'].includes(j.status))throw Error(JSON.stringify(j));return j?.status==='completed'&&s.works[0].status==='review';},'中文讨论完成');report.steps.push({action:'发送讨论',text:value});}
async function resize(width,height){const state=await invoke(shell,'workspace.control',{type:'window-control',action:'state'});if(state.bounds.windowState==='maximized'){await invoke(shell,'workspace.control',{type:'window-control',action:'maximize'});await until(async()=>(await invoke(shell,'workspace.control',{type:'window-control',action:'state'})).bounds.windowState!=='maximized','测试窗口退出最大化');}await invoke(shell,'workspace.control',{type:'window-control',action:'resize',width,height});await until(async()=>{const s=await invoke(shell,'workspace.control',{type:'window-control',action:'state'});return s.contentSize.width===width&&s.contentSize.height===height;},'实测窗口尺寸');await review.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
// U3-01 窄窗证明助手：只用于默认上下并读（stack，不用自由摆放）。真实滚轮滚动原生 HTML
// 报告 guest 与讨论记录；“可见”一律以实际视口框几何断言，绝不用 DOM 文本存在代替。
async function reportGuest(){
 await review.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
 const key=await review.$eval('.managed-report-body .isolated-viewport',n=>n.dataset.previewKey);
 const origin=(await invoke(review,'isolated-preview.snapshot',{key})).origin;
 return until(async()=>{for(const p of await browser.pages())if(p.url().startsWith(origin+'/'))return p;},'当前原生报告 guest');
}
const settle=async()=>review.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
async function conclusionState(){
 const guest=await reportGuest();
 const s=await guest.evaluate(()=>{const heading=[...document.querySelectorAll('h2')].find(n=>n.textContent.trim()==='结论');const paragraph=heading?.nextElementSibling;if(!paragraph)return null;const p=paragraph.getBoundingClientRect(),h=heading.getBoundingClientRect();return {scrollY:scrollY,viewport:{width:innerWidth,height:innerHeight},paragraph:{text:paragraph.textContent,top:p.top,bottom:p.bottom,height:p.height},heading:{top:h.top,bottom:h.bottom,height:h.height},paragraphTop:p.top+scrollY,headingTop:h.top+scrollY};});
 assert(s,'原生报告 guest 包含“结论”段落');
 const view=await review.evaluate(()=>{const n=document.querySelector('.managed-report-body .isolated-viewport');const r=n.getBoundingClientRect();return {viewX:r.x,viewY:r.y,viewWidth:r.width,viewHeight:r.height,pageWidth:innerWidth,pageHeight:innerHeight,layout:document.querySelector('.managed-review')?.dataset.reviewLayout};});
 return {guest,...s,...view};
}
async function scrollGuestToConclusion(label){
 let s=await conclusionState();const from=s.scrollY;
 const both=s.heading.height+s.paragraph.height+16<=s.viewport.height;
 const target=Math.max(0,Math.round((both?s.headingTop:s.paragraphTop)-8));
 let attempts=0;
 while(Math.abs(s.scrollY-target)>1&&attempts<12){await s.guest.mouse.move(Math.round(s.viewport.width/2),Math.round(s.viewport.height/2));await s.guest.mouse.wheel({deltaY:target-s.scrollY});await settle();s=await conclusionState();attempts++;}
 assert(s.paragraph.top>=-0.5&&s.paragraph.bottom<=s.viewport.height+0.5,'结论段完全位于报告 guest 实际视口内 '+JSON.stringify({top:s.paragraph.top,bottom:s.paragraph.bottom,viewportHeight:s.viewport.height,scrollY:s.scrollY}));
 assert(s.viewX>=-0.5&&s.viewY>=-0.5&&s.viewX+s.viewWidth<=s.pageWidth+0.5&&s.viewY+s.viewHeight<=s.pageHeight+0.5,'报告 guest 视口完全位于窗口实际视口内 '+JSON.stringify({x:s.viewX,y:s.viewY,width:s.viewWidth,height:s.viewHeight,page:s.pageWidth+'x'+s.pageHeight}));
 assert.equal(s.layout,'stack','窄窗证明仅在默认上下并读布局中进行');
 report.narrowStackProof.scrollActions.push({target:'native-report-guest',label,action:attempts?'真实滚轮滚动':'位置核对（无需滚动）',from,to:s.scrollY,attempts});
 return s;
}
async function transcriptState(){
 return review.evaluate(()=>{
  const log=document.querySelector('[data-review-discussion-history]');if(!log)return null;
  const clip=log.getBoundingClientRect();
  const bubble=[...log.querySelectorAll('.tag-message-assistant')].find(n=>n.textContent.includes('十人样本主要来自同一实验室'));
  const b=bubble?.getBoundingClientRect();
  return {scrollTop:log.scrollTop,clip:{top:clip.top,bottom:clip.bottom,left:clip.left,right:clip.right,width:clip.width,height:clip.height},bubble:b&&{top:b.top,bottom:b.bottom,height:b.height,width:b.width},entireWithinClip:Boolean(b&&b.top>=clip.top-0.5&&b.bottom<=clip.bottom+0.5),pageWidth:innerWidth,pageHeight:innerHeight,layout:document.querySelector('.managed-review')?.dataset.reviewLayout};
 });
}
async function scrollTranscriptToAnswer(label){
 let s=await transcriptState();assert(s&&s.bubble,'讨论记录包含当前助手解释气泡');
 const from=s.scrollTop;let attempts=0;
 while(!s.entireWithinClip&&attempts<12){
  const delta=Math.round(s.bubble.top>=s.clip.top?s.bubble.bottom-s.clip.bottom:s.bubble.top-s.clip.top);
  await review.mouse.move(Math.round(s.clip.left+s.clip.width/2),Math.round((s.clip.top+s.clip.bottom)/2));
  await review.mouse.wheel({deltaY:delta});await settle();s=await transcriptState();attempts++;
 }
 assert(s.entireWithinClip,'整条助手解释完全位于讨论记录实际视口内 '+JSON.stringify({bubble:s.bubble,clip:{top:s.clip.top,bottom:s.clip.bottom,height:s.clip.height}}));
 assert(s.bubble.height<=s.clip.height+0.5,'解释原文完整高度未缩短：'+s.bubble.height+'px ≤ 讨论视口 '+s.clip.height+'px');
 assert(s.clip.top>=-0.5&&s.clip.left>=-0.5&&s.clip.bottom<=s.pageHeight+0.5&&s.clip.right<=s.pageWidth+0.5,'讨论记录视口完全位于窗口实际视口内');
 assert.equal(s.layout,'stack','窄窗证明仅在默认上下并读布局中进行');
 report.narrowStackProof.scrollActions.push({target:'discussion-log',label,action:attempts?'真实滚轮滚动':'位置核对（无需滚动）',from,to:s.scrollTop,attempts});
 return s;
}
async function stableConclusion(expectedHeight,grownBeyond){let s=await conclusionState();for(let i=0;i<24;i++){await pause(250);const b=await conclusionState();if(b.viewport.height===s.viewport.height&&Math.abs(b.scrollY-s.scrollY)<=1&&(!expectedHeight||Math.abs(b.viewport.height-expectedHeight)<=3)&&(!grownBeyond||b.viewport.height>grownBeyond+100))return b;s=b;}return s;}
try{
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});const env={...process.env};for(const k of Object.keys(env))if(k!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|OMP_|PI_|CODEX_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||['ELECTRON_RUN_AS_NODE','NODE_OPTIONS'].includes(k)))delete env[k];Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_OZONE:'x11'});
 child=spawn(process.env.NOZELI_TEST_BINARY||require('electron'),[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform=x11','--inspect=0'],{cwd:root,env,stdio:['ignore','pipe','pipe']});exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const s of [child.stdout,child.stderr])s.on('data',b=>log+=b);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');browser.on('targetcreated',async t=>{const p=await t.page().catch(()=>null);p?.on('pageerror',e=>errors.push(e.message));});shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');
 observer=await MainObserver.connect(await until(()=>log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'native observer'));
 windowId=await observer.evaluate(`(()=>{const {BaseWindow}=process.mainModule.require('electron');const win=BaseWindow.getAllWindows().find(w=>!w.isDestroyed());if(!win)throw Error('Owned native window not ready');win.show();win.focus();return '0x'+win.getNativeWindowHandle().readUInt32LE(0).toString(16);})()`);
 await invoke(shell,'config.initialize',{mode:'independent'});if(await shell.$eval('#configuration-setup',n=>n.open).catch(()=>false))await shell.click('#configuration-cancel');await invoke(shell,'settings.providers.save',{operation:'create',provider:'zh-review-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-nonsecret'}});const model={model:{mode:'explicit',selector:'zh-review-local/scripted'},thinking:{mode:'native-default'}};await invoke(shell,'settings.models.save',{frontdesk:model,orchestrator:model,worker:model});
 await shell.click('[data-project-id="'+project.id+'"]');await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,project.id),'project');await invoke(shell,'managed.enable',{projectId:project.id});await invoke(shell,'managed.task',{projectId:project.id,text:request,requestKey:'zh-review-natural-task'});
 const initial=await until(async()=>{const s=await state();if(s.jobs.some(j=>j.status==='failed'))throw Error(JSON.stringify(s.jobs));return s.works[0]?.status==='review'&&!s.jobs.some(j=>['queued','running'].includes(j.status))?s:null;},'初稿待审');const work=initial.works[0],thread=work.threadId,todo=initial.todos.find(t=>t.workId===work.id&&t.kind==='result'&&t.status==='open');
 if(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await shell.click('#toggle-sidebar');await shell.waitForSelector('[data-managed-todo="'+todo.id+'"]',{visible:true});await shell.click('[data-managed-todo="'+todo.id+'"]');review=await activePage('report');await review.waitForSelector('[data-review-discussion]',{visible:true});await review.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
 for(const width of [1440,800]){await resize(width,width===800?650:900);await shot('01-读中文报告与讨论-'+width);}
 report.steps.push({action:'待办进入审阅',report:'访谈摘要初稿',files:[relPath]});
 await submit(question);await review.waitForFunction(()=>document.querySelector('[data-review-discussion-history]')?.textContent.includes('十人样本主要来自同一实验室'));
 await review.waitForFunction(()=>{const e=document.querySelector('[data-review-instruction]');return e&&!e.disabled&&!e.readOnly;});
// U3-01：02 必须显示本次问答后的当前解释，而不是停在初始交接。默认上下并读中用真实滚轮
// 把原生报告 guest 滚到“结论”短段落、讨论记录滚到整条解释（解释原文不缩短），二者同屏后
// 按像素门禁（相对初始 01-800）截图；可见性断言全部用实际视口框几何，不用 DOM 文本代替。
const proofGeometry=await invoke(shell,'workspace.control',{type:'window-control',action:'state'});
if(proofGeometry.contentSize.width!==800||proofGeometry.contentSize.height!==650){await resize(800,650);report.narrowStackProof.layoutAdjustments.push({action:'恢复测试窗口800×650',from:proofGeometry.contentSize,to:{width:800,height:650},reason:'窗口在取证开始前改变尺寸；不以最大化图冒充窄窗'});}
await review.waitForFunction(()=>document.querySelector('.managed-review')?.dataset.reviewLayout==='stack');
assert.equal(await review.$eval('.managed-review',n=>n.dataset.reviewLayout),'stack');
const g02=await scrollGuestToConclusion('问后对照：结论段'),l02=await scrollTranscriptToAnswer('问后对照：整条助手解释');
report.narrowStackProof.states['02-自然中文解释-800']={layout:'stack',guestScrollY:g02.scrollY,transcriptScrollTop:l02.scrollTop,geometry:{guestView:{x:g02.viewX,y:g02.viewY,width:g02.viewWidth,height:g02.viewHeight},guestViewport:g02.viewport,conclusion:{text:g02.paragraph.text,top:g02.paragraph.top,bottom:g02.paragraph.bottom,height:g02.paragraph.height},transcriptClip:l02.clip,explanation:{height:l02.bubble.height,top:l02.bubble.top,bottom:l02.bubble.bottom,width:l02.bubble.width}}};
await shot('02-自然中文解释-800',{distinctFrom:'01-读中文报告与讨论-800'});
report.steps.push({action:'问后同屏对照（默认上下并读，800×650 正常字号）',conclusionParagraph:g02.paragraph.text,explanationEntireHeightPx:l02.bubble.height,transcriptClipHeightPx:l02.clip.height});
// U3-01：实际对照后继续写一句真实意见（逐字真实键盘输入，不发送）。
await review.waitForFunction(()=>{const e=document.querySelector('[data-review-instruction]');return e&&!e.disabled&&!e.readOnly;});
await review.type('[data-review-instruction]',unsent);
await review.waitForFunction(()=>document.querySelector('[data-review-instruction-status]')?.textContent.includes('草稿已保存'));
const zoomState=await invoke(shell,'workspace.control',{type:'window-control',action:'state'});assert.equal(zoomState.chromeZoomFactor,1,'正常缩放 zoom 1');assert.equal(zoomState.contentSize.width,800);assert.equal(zoomState.contentSize.height,650);
report.narrowStackProof.window.actual={zoomFactor:zoomState.chromeZoomFactor,devicePixelRatio:await review.evaluate(()=>devicePixelRatio)};
const g02b=await scrollGuestToConclusion('对照后继续写意见：结论段'),l02b=await scrollTranscriptToAnswer('对照后继续写意见：整条助手解释');
assert.equal(await review.$eval('[data-review-instruction]',n=>n.value),unsent);
const compare={draft:unsent,guestScrollY:g02b.scrollY,transcriptScrollTop:l02b.scrollTop,guestViewportHeight:g02b.viewport.height};
report.narrowStackProof.states['02b-同屏对照与未发意见-800']={...compare,layout:'stack',zoomFactor:zoomState.chromeZoomFactor,geometry:{guestView:{x:g02b.viewX,y:g02b.viewY,width:g02b.viewWidth,height:g02b.viewHeight},guestViewport:g02b.viewport,conclusion:{text:g02b.paragraph.text,top:g02b.paragraph.top,bottom:g02b.paragraph.bottom,height:g02b.paragraph.height},transcriptClip:l02b.clip,explanation:{height:l02b.bubble.height,top:l02b.bubble.top,bottom:l02b.bubble.bottom,width:l02b.bubble.width}}};
await shot('02b-同屏对照与未发意见-800',{distinctFrom:'02-自然中文解释-800'});
report.steps.push({action:'窄窗同屏对照后写真实意见（未发送）',layout:'默认上下并读，未用自由摆放'});
await review.click('[data-review-action="hide-discussion"]');
let hidden=await stableConclusion(null,compare.guestViewportHeight);const hiddenRetained=Math.abs(hidden.scrollY-compare.guestScrollY)<=1;let hiddenRestored=false;
if(!hiddenRetained||!(hidden.paragraph.top>=-0.5&&hidden.paragraph.bottom<=hidden.viewport.height+0.5)){
 const from={scrollY:hidden.scrollY,paragraphTop:hidden.paragraph.top,viewportHeight:hidden.viewport.height};
 hidden=await scrollGuestToConclusion('收起后按视口高度钳制再锚定结论段');
 report.narrowStackProof.restorations.push({phase:'收起后',target:'native-report-guest',reason:'视口高度钳制/重锚定',from,to:{scrollY:hidden.scrollY}});hiddenRestored=true;
}
report.narrowStackProof.states['03-收起继续读中文报告-800']={guestScrollY:hidden.scrollY,guestViewport:hidden.viewport,conclusionWithinViewport:hidden.paragraph.top>=-0.5&&hidden.paragraph.bottom<=hidden.viewport.height+0.5,retainedGuestScroll:hiddenRetained,restored:hiddenRestored,draft:await review.$eval('[data-review-instruction]',n=>n.value)};
assert.equal(report.narrowStackProof.states['03-收起继续读中文报告-800'].draft,unsent);
await shot('03-收起继续读中文报告-800',{floatVisible:false,distinctFrom:'02b-同屏对照与未发意见-800'});
await review.click('[data-review-action="open-discussion"]');
assert.equal(await review.$eval('[data-review-instruction]',n=>n.value),unsent);
let shown=await stableConclusion(compare.guestViewportHeight),shownLog=await transcriptState();const retainedGuest=Math.abs(shown.scrollY-compare.guestScrollY)<=1,retainedLog=Boolean(shownLog?.entireWithinClip)&&Math.abs(shownLog.scrollTop-compare.transcriptScrollTop)<=1;let shownRestored=false;
if(!retainedGuest||!(shown.paragraph.top>=-0.5&&shown.paragraph.bottom<=shown.viewport.height+0.5)){
 const from={scrollY:shown.scrollY,paragraphTop:shown.paragraph.top,viewportHeight:shown.viewport.height};
 shown=await scrollGuestToConclusion('展开后按视口高度钳制再锚定结论段');
 report.narrowStackProof.restorations.push({phase:'展开后',target:'native-report-guest',reason:'视口高度钳制/重锚定',from,to:{scrollY:shown.scrollY}});shownRestored=true;
}
if(!shownLog?.entireWithinClip){
 const from={scrollTop:shownLog?.scrollTop};
 shownLog=await scrollTranscriptToAnswer('展开后按视口高度钳制再锚定整条解释');
 report.narrowStackProof.restorations.push({phase:'展开后',target:'discussion-log',reason:'视口高度钳制/重锚定',from,to:{scrollTop:shownLog.scrollTop}});shownRestored=true;
}
report.narrowStackProof.states['04-展开保留意见-800']={draft:await review.$eval('[data-review-instruction]',n=>n.value),guestScrollY:shown.scrollY,transcriptScrollTop:shownLog.scrollTop,retained:{guestScroll:retainedGuest,discussionScroll:retainedLog},restored:shownRestored,geometry:{guestViewport:shown.viewport,transcriptClip:shownLog.clip,explanation:{height:shownLog.bubble.height,top:shownLog.bubble.top,bottom:shownLog.bubble.bottom,width:shownLog.bubble.width}}};
await shot('04-展开保留意见-800',{floatVisible:true,distinctFrom:'03-收起继续读中文报告-800'});
report.steps.push({action:'收起继续读→展开',retainedDraft:unsent,reportPositionKept:retainedGuest,discussionPositionKept:retainedLog,restorationLogged:shownRestored});
report.checks.push('窄窗800×650默认并读：结论段与整条助手解释同屏、真实滚轮滚动、未发意见保留及位置变化记录');
report.narrowStackProof.checks.push('800×650 默认上下并读：结论段与整条助手解释同屏（实际视口框几何断言，非 DOM 文本）','真实滚轮滚动原生报告 guest 与讨论记录；解释原文未缩短','收起/展开后未发意见保留；报告与讨论位置'+(shownRestored?'经显式再锚定恢复（已记录）':retainedGuest&&retainedLog?'保持':'数值有小幅变化，读段仍完整可见（已记录）'),'02 相对初始 01-800 像素差异门禁 >5000px');
report.narrowStackProof.summary={positionChecks:report.narrowStackProof.scrollActions.length,scrollActions:report.narrowStackProof.scrollActions.reduce((count,action)=>count+action.attempts,0),layoutAdjustments:report.narrowStackProof.layoutAdjustments.length,restorations:report.narrowStackProof.restorations.length,extraLayoutAdjustmentsNeeded:report.narrowStackProof.layoutAdjustments.length>0};
 await submit(modification);const updated=(await state()).works[0].result.objectId;await until(()=>review.$('[data-review-action="latest-discussion"]:not([hidden])'),'新版入口');await review.click('[data-review-action="latest-discussion"]');await until(()=>review.evaluate(id=>window.__workspaceScope.viewState.report.objectId===id,updated),'新版报告');await review.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
// The accepted revision/adoption journey follows the same-report U3-01 proof.
// Its explicit new request replaces the input, so restore the retained opinion
// afterwards for the separate, already accepted manual-adoption scenario.
 await review.waitForFunction(()=>{const e=document.querySelector('[data-review-instruction]');return e&&!e.disabled&&!e.readOnly;});
 await review.type('[data-review-instruction]',unsent);
 await review.waitForFunction(()=>document.querySelector('[data-review-instruction-status]')?.textContent.includes('草稿已保存'));
 if(!process.env.NOZELI_TEST_BINARY){
  await review.click('[data-review-action="discussion-layout"]');await review.waitForFunction(()=>document.querySelector('.managed-review')?.dataset.reviewLayout==='floating');
  await review.focus('[data-review-discussion] .tag-head');await review.keyboard.press('ArrowRight');await review.keyboard.press('ArrowDown');
  await shot('04b-自由摆放讨论-800',{floatVisible:true,distinctFrom:'04-展开保留意见-800'});
  await review.click('[data-review-action="hide-discussion"]');await review.click('[data-review-action="open-discussion"]');assert.equal(await review.$eval('[data-review-instruction]',n=>n.value),unsent);
  await review.click('[data-review-action="discussion-layout"]');await review.waitForFunction(()=>document.querySelector('.managed-review')?.dataset.reviewLayout==='stack');
  report.freePlacement.steps.push({action:'自由摆放→键盘移动→收起展开→恢复并读',retainedDraft:unsent});
 }
 if(process.env.NOZELI_REVIEW_VISUAL_ONLY==='1'){
  await review.waitForSelector('[data-review-action="accept"]:not([disabled])',{visible:true});await review.click('[data-review-action="accept"]');await review.waitForSelector('[data-confirmation-dialog][open]');report.confirmation=await review.$eval('[data-confirmation-dialog]',n=>n.innerText);await shot('00-原版采用确认-800');await review.click('[data-confirmation-cancel]');
  report.mode='visual-only-baseline';report.ok=true;report.providerCalls=provider.requests.length;report.scriptPhases=calls;
  report.checks.push('仅中文阅读／讨论／收起展开实际窗口基线，不执行或声称人工采用通过');
 }else{
 await review.waitForSelector('[data-review-file="'+relPath+'"]',{visible:true});await review.click('[data-review-file="'+relPath+'"]');doc=await activePage('document');await doc.waitForFunction(()=>window.__nozeliInput?.text().includes('访谈摘要'));const beforeHuman=await doc.evaluate(()=>window.__nozeliInput.text());assert.equal(beforeHuman,revisedCandidate);
 await doc.bringToFront();await doc.evaluate(t=>{window.__nozeliInput.focus();const text=window.__nozeliInput.text();window.__nozeliInput.select(text.length,text.length);window.__nozeliInput.insert(t);},humanNote);await doc.keyboard.down('Control');await doc.keyboard.press('s');await doc.keyboard.up('Control');
 const humanText=beforeHuman+humanNote;await until(async()=>{const r=await invoke(doc,'managed.review.read',{projectId:project.id,workId:work.id,objectId:updated,relPath});return r.files?.some(f=>f.relPath===relPath&&f.draft?.text===humanText);},'人工审阅稿持久保存');
 await assert.rejects(fs.stat(path.join(root,relPath)),{code:'ENOENT'});await shot('05-人工直接改稿已保存-800',{page:doc});report.steps.push({action:'人工编辑候选→Ctrl+S',relPath,text:humanText,projectStillMissing:true});
 const layout=await shell.evaluate(()=>window.__workspaceGroups.snapshot()),viewId=await review.evaluate(()=>window.__workspaceScope.viewId);await invoke(shell,'workspace.command',{projectId:project.id,expectedRevision:layout.revision,requestKey:'zh-return-report',command:{type:'activate',viewId}});await review.waitForFunction(()=>!document.querySelector('[data-review-action="accept"]').disabled);
 for(const width of [800,1440]){await resize(width,width===800?650:900);await shot('06-人工稿返回审阅-'+width,{floatVisible:true,...(width===800?{distinctFrom:'05-人工直接改稿已保存-800'}:{})});}
 await review.click('[data-review-action="accept"]');await review.waitForSelector('[data-confirmation-dialog][open]');const confirmation=await review.$eval('[data-confirmation-dialog]',n=>n.innerText);report.confirmation=confirmation;assert(confirmation.includes(relPath),'confirmation names actual file');assert(confirmation.includes('人工'),'confirmation identifies manual version');assert(confirmation.includes('不会')&&confirmation.includes('AI'),'confirmation states unsent opinions are not sent');await shot('07-采用人工稿单层确认-1440');await review.click('[data-confirmation-cancel]');assert.equal(await review.$eval('[data-review-instruction]',n=>n.value),unsent);assert.equal((await state()).works[0].status,'review');await assert.rejects(fs.stat(path.join(root,relPath)),{code:'ENOENT'});
 await review.click('[data-review-action="accept"]');await review.waitForSelector('[data-confirmation-dialog][open]');await review.click('[data-confirmation-confirm]');await until(async()=>{const w=(await state()).works[0];if(w.closure?.phase==='blocked')throw Error(JSON.stringify(w.closure));return w.status==='ended'&&w.closure?.phase==='complete';},'人工稿实际合入');
 assert.equal(await fs.readFile(path.join(root,relPath),'utf8'),humanText);assert.equal(await fs.readFile(path.join(root,'材料说明.md'),'utf8'),source);const final=await state();assert.equal(final.works.length,1);assert.equal(final.works[0].threadId,thread);assert.equal(final.jobs.some(j=>j.text===unsent),false);assert.equal(await review.$eval('[data-review-instruction]',n=>n.value),unsent);assert.deepEqual(provider.errors,[]);assert.deepEqual(errors,[]);report.steps.push({action:'返回审阅保留草稿→明确采用人工稿',exactFile:relPath,mergedText:humanText,unsentDispatched:false,workStatus:final.works[0].status});report.checks.push('自然中文原任务及同线程讨论','主工作区正文与标签窗实际X11同帧','收起恢复正文且意见保留','人工直接编辑候选保存后原项目未改','单层确认实际路径/人工稿/未发送意见','采用文件逐字等于人工稿且ended/complete');report.providerCalls=provider.requests.length;report.scriptPhases=calls;report.ok=true;
 }
 observer.close();observer=null;
 await invoke(shell,'session.requestClose');assert.deepEqual(await Promise.race([exit,pause(20000).then(()=>null)]),{code:0,signal:null});child=null;
}catch(error){report.error=error.stack;process.exitCode=1;await review?.screenshot({path:path.join(out,'failure-dom.png')}).catch(()=>{});if(windowId)await shot('failure-composite').catch(()=>{});report.visible=await review?.evaluate(()=>document.body.innerText.slice(-7000)).catch(()=>null);}
finally{observer?.close();if(child?.exitCode===null){try{await invoke(shell,'session.requestClose');await Promise.race([exit,pause(10000)]);}catch{}if(child.exitCode===null)child.kill('SIGTERM');}await browser?.disconnect().catch(()=>{});await provider.close();report.errors=errors;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));}
