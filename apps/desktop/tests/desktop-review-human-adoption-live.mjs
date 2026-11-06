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
const reportEvidenceParagraphs=Array.from({length:40},(_,i)=>`<p>静态依据段落 ${i+1}：本段仅为长报告阅读、滚动与原生叠层像素验收提供稳定文字。样本来自同一实验室，没有长期追踪，不能代表所有研究者。</p>`).join('');
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
 if(!r.messages.some(m=>m.tool_call_id===id))return {text:version===1?'我先核对材料边界，再整理访谈摘要，不把单一实验室的样本推广为总体。':'我会保持原来的样本边界，并把补充建议落到同一份候选稿。',tool:'write',id,args:{path:relPath,content:version===1?originalCandidate:revisedCandidate}};
 return {text:version===1?'摘要已按材料整理，接下来发布原文可读的报告与候选文件，供你审阅。':'补充建议已写入候选稿，现在发布本次对应的报告与文件。',tool:'nozeli_publish',id:version===1?'zh-publish-1':'zh-publish-2',args:{kind:'result',content:htmlReport(version).replace('</main>',reportEvidenceParagraphs+'</main>'),files:[relPath]}};
});
let child,browser,shell,review,discussion,doc,observer,exit,log='',windowId;const errors=[];
const report={ok:false,out,version:'0.1.0-alpha.5-source-report-restoration',scope:'Actual Electron/private Pi/native files and composited X11 parent plus owned discussion child; report endmatter, explicit Work discussion and human adoption. Chinese local scripted Provider only.',steps:[],screenshots:[],checks:[],notCovered:['真实模型理解','Windows/macOS','R01/R02与未知效果恢复','同文件合入冲突解决']};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('App exited '+log);const v=await fn();if(v)return v;await pause(70);}throw Error('Timeout '+label);}
async function invoke(page,op,p={}){const r=await page.evaluate(({op,p})=>window.nozeli.invoke(op,p),{op,p});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
report.binary=process.env.NOZELI_TEST_BINARY||require('electron');
if(process.env.NOZELI_TEST_BINARY)report.version='0.1.0-alpha.5-installed-'+path.basename(path.dirname(process.env.NOZELI_TEST_BINARY));
const state=async()=> (await invoke(shell,'managed.status',{projectId:project.id})).state;
async function nativeDiscussionState(){
 return observer.evaluate(`(async()=>{const {BrowserWindow}=process.mainModule.require('electron'),rows=[];for(const win of BrowserWindow.getAllWindows()){if(win.isDestroyed())continue;const scope=await win.webContents.executeJavaScript('window.__workspaceScope').catch(()=>null);if(scope?.role!=='review-discussion'||scope.projectId!==${JSON.stringify(project.id)})continue;const parent=win.getParentWindow();rows.push({id:win.id,nativeHandle:'0x'+win.getNativeWindowHandle().readUInt32LE(0).toString(16),scope,visible:win.isVisible(),bounds:win.getBounds(),parentId:parent?.id,parentHandle:parent?'0x'+parent.getNativeWindowHandle().readUInt32LE(0).toString(16):null,modal:win.isModal(),alwaysOnTop:win.isAlwaysOnTop()});}return rows;})()`);
}
async function expectDiscussionVisible(expected){
 return until(async()=>{const rows=await nativeDiscussionState();return rows.filter(row=>row.visible).length===(expected?1:0)?{rows}:false;},'actual native discussion visibility '+expected);
}
async function discussionPage(){return until(async()=>{for(const p of await browser.pages())if(await p.evaluate(projectId=>window.__nozeliReady&&window.__workspaceScope?.role==='review-discussion'&&window.__workspaceScope.projectId===projectId,project.id).catch(()=>false))return p;},'owned native discussion page');}
function intersectPixels(...rects){const x=Math.max(...rects.map(r=>r.x)),y=Math.max(...rects.map(r=>r.y)),right=Math.min(...rects.map(r=>r.x+r.width)),bottom=Math.min(...rects.map(r=>r.y+r.height));assert(right>x&&bottom>y,'visible pixel intersection is required');return {x,y,width:right-x,height:bottom-y};}
async function nativePageFrame(page,{activate=false}={}){
 const identity=await page.evaluate(()=>{const scope=window.__workspaceScope;return {role:scope.role,projectId:scope.projectId,viewId:scope.viewId,generation:scope.generation};});assert(identity.viewId,'native page must have an exact workspace surface identity');
 return observer.evaluate(`(async()=>{const {BaseWindow}=process.mainModule.require('electron'),expected=${JSON.stringify(identity)},matches=[];for(const win of BaseWindow.getAllWindows()){if(win.isDestroyed())continue;for(const view of win.contentView.children||[]){const wc=view.webContents;if(!wc||wc.isDestroyed())continue;const scope=await wc.executeJavaScript('window.__workspaceScope').catch(()=>null);if(!scope||!['role','projectId','viewId','generation'].every(key=>scope[key]===expected[key]))continue;if(!view.getVisible?.())return null;matches.push({win,view,wc});}}if(matches.length!==1){if(!matches.length)return null;throw Error('Ambiguous exact native surface identity');}const {win,view,wc}=matches[0];${activate?'win.show();win.focus();':''}return {identity:expected,webContentsId:wc.id,parentNativeHandle:'0x'+win.getNativeWindowHandle().readUInt32LE(0).toString(16),window:win.getBounds(),content:win.getContentBounds(),view:view.getBounds()};})()`);
}
async function shot(name,{page=review,floatVisible,distinctFrom}={}){
 await until(()=>nativePageFrame(page),'expected exact native surface visible for '+name);
 const nativeState=typeof floatVisible==='boolean'?await expectDiscussionVisible(floatVisible):{rows:await nativeDiscussionState()};
 const visibleState={parent:await page.evaluate(()=>({scope:window.__workspaceScope,viewport:{width:innerWidth,height:innerHeight},reportBox:(()=>{const el=document.querySelector('.managed-report-body');if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()})),discussion:nativeState.rows,child:discussion?await discussion.evaluate(()=>({scope:window.__workspaceScope,draft:document.querySelector('[data-review-instruction]')?.value})):null};
 const file=path.join(out,name+'.png');let changedPixels=null,attempts=0;
 let captureRegion,reportPixelRegion,coordinateMap,compositor;
 for(;attempts<8;attempts++){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await observer.evaluate(`(async()=>{const {BaseWindow}=process.mainModule.require('electron');const capture=async view=>{if(!view.getVisible?.())return;if(view.webContents&&!view.webContents.isDestroyed())await view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});for(const child of view.children||[])await capture(child);};for(const win of BaseWindow.getAllWindows())for(const view of win.contentView.children||[])await capture(view);return true;})()`,15000);
  await pause(200);
  const nativeFrame=await nativePageFrame(page);assert(nativeFrame,'exact captured native surface must remain visible');
  const captured=await exec('python3',[path.join(import.meta.dirname,'review-composite-capture.py'),String(child.pid),file,JSON.stringify(nativeFrame.window)],{timeout:180000,maxBuffer:4*1024*1024});compositor=JSON.parse(captured.stdout);
  captureRegion={x:0,y:0,width:compositor.width,height:compositor.height};
  const scale={x:compositor.width/nativeFrame.window.width,y:compositor.height/nativeFrame.window.height};
  for(const row of nativeState.rows.filter(row=>row.visible)){
   assert.equal(row.parentHandle,nativeFrame.parentNativeHandle,'discussion must belong to the captured exact surface parent');assert.equal(row.modal,false);assert.equal(row.alwaysOnTop,false);
   const r=row.bounds;row.pixelBounds={x:Math.floor((r.x-nativeFrame.window.x)*scale.x),y:Math.floor((r.y-nativeFrame.window.y)*scale.y),width:Math.ceil(r.width*scale.x),height:Math.ceil(r.height*scale.y)};assert.deepEqual(intersectPixels(row.pixelBounds,captureRegion),row.pixelBounds,'compositor area must include the entire owned discussion');
  }
  coordinateMap={nativeFrame,scale};
  if(visibleState.parent.reportBox){
   const box=visibleState.parent.reportBox,cssToDip={x:nativeFrame.view.width/visibleState.parent.viewport.width,y:nativeFrame.view.height/visibleState.parent.viewport.height};
   const left=(nativeFrame.content.x-nativeFrame.window.x+nativeFrame.view.x+box.x*cssToDip.x)*scale.x,top=(nativeFrame.content.y-nativeFrame.window.y+nativeFrame.view.y+box.y*cssToDip.y)*scale.y;
   const right=left+box.width*cssToDip.x*scale.x,bottom=top+box.height*cssToDip.y*scale.y;
   reportPixelRegion={x:Math.ceil(left),y:Math.ceil(top),width:Math.floor(right)-Math.ceil(left),height:Math.floor(bottom)-Math.ceil(top)};coordinateMap.cssToDip=cssToDip;
  }
  // Every frame is a normal Spectacle region-UI capture after exact own-PID
  // parent activation and scoped tool-only input. Child pixels are verified.
  await exec('ffmpeg',['-y','-loglevel','error','-framerate','10','-i',path.join(compositor.framesDirectory,'%03d.png'),'-c:v','ffv1','-pix_fmt','bgr0',path.join(out,name+'-frames.mkv')],{timeout:15000});
  if(!distinctFrom)break;
  const comparison=await exec('compare',['-metric','AE',path.join(out,distinctFrom+'.png'),file,'null:']).catch(error=>error);
  changedPixels=Number.parseFloat(String(comparison.stderr||'').trim());
  assert(Number.isFinite(changedPixels),'pixel comparison must yield an actual count');
  if(changedPixels>5000)break;
 }
 if(distinctFrom)assert(changedPixels>5000,'changed UI state requires a genuinely changed window image: '+name);
 const geometry=await invoke(shell,'workspace.control',{type:'window-control',action:'state'});
 report.screenshots.push({file,recording:path.join(out,name+'-frames.mkv'),name,capture:'spectacle-owned-parent-region-ui-child-inclusion-requires-region-proof',captureRegion,compositor,reportPixelRegion,coordinateMap,geometry,visibleState,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex'),distinctFrom,changedPixels,captureAttempts:attempts+1});
}
async function activePage(kind){return until(async()=>{for(const p of await browser.pages())if(await p.evaluate(kind=>window.__nozeliReady&&window.__workspaceScope?.kind===kind,kind).catch(()=>false))return p;},kind);}
async function submit(value){await discussion.waitForFunction(()=>{const n=document.querySelector('[data-review-instruction]');return n&&!n.disabled&&!n.readOnly;});await discussion.$eval('[data-review-instruction]',(n,t)=>{n.value=t;n.dispatchEvent(new Event('input',{bubbles:true}));},value);await discussion.waitForSelector('[data-review-action="send"]:not([disabled])',{visible:true});await discussion.click('[data-review-action="send"]');await until(async()=>{const s=await state(),j=s.jobs.find(j=>j.text===value);if(j&&['failed','unknown'].includes(j.status))throw Error(JSON.stringify(j));return j?.status==='completed'&&s.works[0].status==='review';},'中文讨论完成');report.steps.push({action:'发送讨论',text:value});}
async function resize(width,height){const state=await invoke(shell,'workspace.control',{type:'window-control',action:'state'});if(state.bounds.windowState==='maximized'){await invoke(shell,'workspace.control',{type:'window-control',action:'maximize'});await until(async()=>(await invoke(shell,'workspace.control',{type:'window-control',action:'state'})).bounds.windowState!=='maximized','测试窗口退出最大化');}await invoke(shell,'workspace.control',{type:'window-control',action:'resize',width,height});await until(async()=>{const s=await invoke(shell,'workspace.control',{type:'window-control',action:'state'});return s.contentSize.width===width&&s.contentSize.height===height;},'实测窗口尺寸');await review.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
async function activateReview(){
 const id=await review.evaluate(()=>window.__workspaceScope.viewId);await shell.evaluate(id=>window.__workspaceGroups.command({type:'activate',viewId:id,groupId:window.__workspaceGroups.activeGroup()}),id);
 const frame=await until(()=>nativePageFrame(review,{activate:true}),'真实审核内容面按精确viewId激活并置于前台');windowId=frame.parentNativeHandle;
}
async function compareReportPixels(beforeName,afterName){
 const before=report.screenshots.find(s=>s.name===beforeName),after=report.screenshots.find(s=>s.name===afterName);assert(before&&after);
 assert.deepEqual(after.reportPixelRegion,before.reportPixelRegion,'same native report pixel rectangle');
 const screen=intersectPixels(before.reportPixelRegion,before.captureRegion,after.captureRegion);
 const masks=[...before.visibleState.discussion,...after.visibleState.discussion].filter(row=>row.visible).map(row=>row.pixelBounds);
 const images=[];
 for(const shot of [before,after]){
  const file=path.join(out,shot.name+'-against-'+afterName+'-uncovered-report.png'),draw=[];
  for(const r of masks)draw.push('-fill','black','-draw',`rectangle ${r.x-screen.x-16},${r.y-screen.y-16} ${r.x+r.width-screen.x+16},${r.y+r.height-screen.y+16}`);
  await exec('convert',[shot.file,'-crop',`${screen.width}x${screen.height}+${screen.x-shot.captureRegion.x}+${screen.y-shot.captureRegion.y}`,'+repage',...draw,file]);images.push(file);
 }
 const comparison=await exec('compare',['-metric','AE',...images,'null:']).catch(error=>error),changedPixels=Number.parseFloat(String(comparison.stderr||'').trim());
 assert(Number.isFinite(changedPixels),'uncovered report pixel metric must be real');assert(changedPixels<=Math.max(200,screen.width*screen.height*.002),'report pixels outside child plus 16px shadow must not disappear or blacken');
 (report.uncoveredReportPixels??=[]).push({beforeName,afterName,screen,masks,shadow:16,images,changedPixels});
 if(!before.visibleState.discussion.some(row=>row.visible))for(const row of after.visibleState.discussion.filter(row=>row.visible)){
  const region=intersectPixels(row.pixelBounds,before.captureRegion,after.captureRegion),childImages=[];
  for(const shot of [before,after]){const file=path.join(out,shot.name+'-against-'+afterName+'-child-region.png');await exec('convert',[shot.file,'-crop',`${region.width}x${region.height}+${region.x}+${region.y}`,'+repage',file]);childImages.push(file);}
  const childComparison=await exec('compare',['-metric','AE',...childImages,'null:']).catch(error=>error),childChangedPixels=Number.parseFloat(String(childComparison.stderr||'').trim());
  assert(Number.isFinite(childChangedPixels)&&childChangedPixels>Math.max(1000,region.width*region.height*.05),'Spectacle selected-region capture does not prove owned child inclusion: child-region pixels must actually change; no stitched fallback is allowed');
  (report.ownedChildPixelProof??=[]).push({beforeName,afterName,region,images:childImages,changedPixels:childChangedPixels});
 }
}
async function nativeReportLayout(){
 return until(async()=>{
  const key=await review.$eval('.managed-report-body .isolated-viewport',node=>node.dataset.previewKey),snapshot=await invoke(review,'isolated-preview.snapshot',{key});
  const guest=(await browser.pages()).find(page=>page.url().startsWith(snapshot.origin+'/'));if(!guest)return false;
  const layout=await guest.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY},blocks:[...document.querySelectorAll('h1,p')].slice(0,3).map(node=>{const range=document.createRange();range.selectNodeContents(node);return {text:node.textContent,lines:[...range.getClientRects()].map(rect=>({x:rect.x,y:rect.y,width:rect.width,height:rect.height}))};})}));
  const expected=await review.$eval('.managed-report-body .isolated-viewport',node=>{const r=node.getBoundingClientRect();return {width:Math.round(r.width),height:Math.round(r.height)};});
  return layout.viewport.width===expected.width&&layout.viewport.height===expected.height?layout:false;
 },'原生报告完整viewport跟随阅读区，而非浮窗裁切区');
}
try{
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});const env={...process.env};for(const k of Object.keys(env))if(k!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|OMP_|PI_|CODEX_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||['ELECTRON_RUN_AS_NODE','NODE_OPTIONS'].includes(k)))delete env[k];Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_OZONE:'x11'});
 child=spawn(process.env.NOZELI_TEST_BINARY||require('electron'),[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform=x11','--inspect=0'],{cwd:root,env,stdio:['ignore','pipe','pipe']});exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const s of [child.stdout,child.stderr])s.on('data',b=>log+=b);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');browser.on('targetcreated',async t=>{const p=await t.page().catch(()=>null);p?.on('pageerror',e=>errors.push(e.message));});shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');
 observer=await MainObserver.connect(await until(()=>log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'native observer'));
 windowId=await observer.evaluate(`(()=>{const {BaseWindow}=process.mainModule.require('electron');const win=BaseWindow.getAllWindows().find(w=>!w.isDestroyed());if(!win)throw Error('Owned native window not ready');win.show();win.focus();return '0x'+win.getNativeWindowHandle().readUInt32LE(0).toString(16);})()`);
 await invoke(shell,'config.initialize',{mode:'independent'});if(await shell.$eval('#configuration-setup',n=>n.open).catch(()=>false))await shell.click('#configuration-cancel');await invoke(shell,'settings.providers.save',{operation:'create',provider:'zh-review-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-nonsecret'}});const model={model:{mode:'explicit',selector:'zh-review-local/scripted'},thinking:{mode:'native-default'}};await invoke(shell,'settings.models.save',{frontdesk:model,orchestrator:model,worker:model});
 await shell.click('[data-project-id="'+project.id+'"]');await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,project.id),'project');await invoke(shell,'managed.enable',{projectId:project.id});await invoke(shell,'managed.task',{projectId:project.id,text:request,requestKey:'zh-review-natural-task'});
 const initial=await until(async()=>{const s=await state();if(s.jobs.some(j=>j.status==='failed'))throw Error(JSON.stringify(s.jobs));return s.works[0]?.status==='review'&&!s.jobs.some(j=>['queued','running'].includes(j.status))?s:null;},'初稿待审');const work=initial.works[0],thread=work.threadId,todo=initial.todos.find(t=>t.workId===work.id&&t.kind==='result'&&t.status==='open');
 if(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await shell.click('#toggle-sidebar');await shell.waitForSelector('[data-managed-todo="'+todo.id+'"]',{visible:true});await shell.click('[data-managed-todo="'+todo.id+'"]');review=await activePage('report');await review.waitForSelector('.managed-review');await review.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
 assert.equal((await nativeDiscussionState()).length,0,'cold report must not create or show a native discussion window');
 assert.deepEqual(await review.$$eval('.managed-review-actions > button',nodes=>nodes.map(n=>({action:n.dataset.reviewAction,text:n.textContent}))),[{action:'open-discussion',text:'审核讨论'},{action:'accept',text:'采纳并结束'},{action:'discard',text:'放弃并结束'}]);
 for(const width of [1440,800]){await resize(width,width===800?650:900);await shot('01-报告主体与底部审核按钮-'+width,{floatVisible:false});}
 const firstDiscussion=await invoke(review,'managed.review.discussion.read',{projectId:project.id,workId:work.id,objectId:work.result.objectId,limit:100});
 const mainFrame=await invoke(shell,'managed.timeline.page',{projectId:project.id,limit:100}),mainRows=new Map(mainFrame.entries.map(row=>[row.id,row]));
 const workerRows=firstDiscussion.entries.filter(row=>row.speaker==='worker'&&row.source!=='publication');assert.equal(workerRows.length,2,'真实初稿回合有两段原生助手正文');
 for(const row of workerRows){assert(mainRows.has(row.id),'同一原消息也在主对话canonical timeline');assert.equal(mainRows.get(row.id).text,row.text);assert.equal(row.workId,work.id);}
 await resize(1440,900);await shell.click('#workspace-open-conversation');const conversationPage=await activePage('conversation');
 await conversationPage.waitForSelector('.session-worker details > summary');const workerDetails=await conversationPage.$('.session-worker details');if(!await workerDetails.evaluate(node=>node.open))await conversationPage.click('.session-worker details > summary');
 await conversationPage.waitForFunction(text=>document.body.textContent.includes(text),{},workerRows[0].text);await conversationPage.$eval('.session-worker',node=>node.scrollIntoView({block:'start'}));
 await shot('00-主对话同一Work原始内容-1440',{page:conversationPage});
 await activateReview();await expectDiscussionVisible(false);await resize(800,650);
 const previewKey=await review.$eval('.managed-report-body .isolated-viewport',node=>node.dataset.previewKey),previewOrigin=(await invoke(review,'isolated-preview.snapshot',{key:previewKey})).origin;
 const readingGuest=(await browser.pages()).find(page=>page.url().startsWith(previewOrigin+'/'));assert(readingGuest);await invoke(review,'isolated-preview.focus',{key:previewKey});await until(()=>observer.evaluate(`(()=>{const {webContents}=process.mainModule.require('electron');return webContents.getFocusedWebContents()?.getURL().startsWith(${JSON.stringify(previewOrigin+'/')})===true;})()`),'原生报告实际取得阅读焦点');
 await readingGuest.screenshot({captureBeyondViewport:false});let readingScrollAttempts=0;
 for(;readingScrollAttempts<8;readingScrollAttempts++){const before=await nativeReportLayout();if(before.scroll.y>=119)break;await readingGuest.mouse.move(100,100);await readingGuest.mouse.wheel({deltaY:120-before.scroll.y});await review.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
 const readingPosition=await nativeReportLayout();assert(readingPosition.scroll.y>0,'真实输入须建立非零原文位置');report.steps.push({action:'真实原生阅读滚动',inputAttempts:readingScrollAttempts,position:readingPosition.scroll});
 await review.bringToFront();
 await shot('01a-报告非零阅读位置-800',{floatVisible:false,distinctFrom:'01-报告主体与底部审核按钮-800'});
 report.layoutProof={beforeOpen:await nativeReportLayout()};
 // Optional external CPU/IPC inspection: attach using hold-meta.json, restore
 // the recorded report layout and hidden child, then create out/continue.
 if(process.env.NOZELI_REVIEW_HOLD==='1'){
  const meta={out,pid:child.pid,browserURL:'http://127.0.0.1:'+port,inspectorURL:log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],binary:report.binary,appRoot:hostRoot,profile,root,projectId:project.id,workId:work.id,objectId:work.result.objectId,reviewURL:review.url(),windowId,layout:report.layoutProof.beforeOpen,continueFile:path.join(out,'continue')};
  await fs.writeFile(path.join(out,'hold-meta.json'),JSON.stringify(meta,null,2));console.log(JSON.stringify({hold:meta}));
  while(!await fs.access(meta.continueFile).then(()=>true,()=>false)){if(child.exitCode!==null)throw Error('App exited during external review hold '+log);await pause(200);}
 }
 await review.click('[data-review-action="open-discussion"]');discussion=await discussionPage();await expectDiscussionVisible(true);await discussion.waitForSelector('[data-review-discussion]',{visible:true});assert.equal(await discussion.$('[data-review-action="accept"]'),null);assert.equal(await discussion.$('[data-review-action="discard"]'),null);
 const discussionScope=await discussion.evaluate(()=>window.__workspaceScope);assert.equal(discussionScope.workId,work.id);assert.equal(discussionScope.objectId,work.result.objectId);assert.equal(discussionScope.ownerSurfaceId,await review.evaluate(()=>window.__workspaceScope.viewId));
 await shot('01b-显式打开不重排报告-800',{floatVisible:true,distinctFrom:'01a-报告非零阅读位置-800'});report.layoutProof.afterOpen=await nativeReportLayout();assert.deepEqual(report.layoutProof.afterOpen,report.layoutProof.beforeOpen,'仅打开讨论不得改变原生viewport或报告文字行位置');
 await compareReportPixels('01a-报告非零阅读位置-800','01b-显式打开不重排报告-800');
 const reviewBubbles=await discussion.$$eval('[data-review-discussion-history] .tag-message-assistant',nodes=>nodes.map(node=>({ids:[...node.querySelectorAll('[data-message-id]')].map(n=>n.dataset.messageId),text:node.textContent})));
 assert(reviewBubbles.some(bubble=>workerRows.every(row=>bubble.ids.includes(row.id))),'同一真实回合两段正文在同一个AI气泡内，原消息ID不丢');
 report.steps.push({action:'核对主对话同一Work与审核窗口',workId:work.id,sourceMessageIds:workerRows.map(row=>row.id),sameTexts:true,singleReplyBubble:true});
 report.steps.push({action:'待办进入审阅',report:'访谈摘要初稿',files:[relPath]});
 await submit(question);await discussion.waitForFunction(answer=>document.querySelector('[data-review-discussion-history]')?.textContent.includes(answer),{},answer);
 assert.equal((await state()).works[0].result.objectId,work.result.objectId,'pure explanation must retain the original published report');
 await discussion.waitForFunction(()=>{const e=document.querySelector('[data-review-instruction]');return e&&!e.disabled&&!e.readOnly;});
 const answerView=await discussion.evaluate(answer=>{const log=document.querySelector('[data-review-discussion-history]'),clip=log.getBoundingClientRect(),body=[...log.querySelectorAll('.tag-message-assistant [data-message-id]')].find(node=>node.textContent.includes(answer));if(!body)return null;const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),lines=[];for(let node=walker.nextNode();node;node=walker.nextNode()){if(!node.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(node);for(const rect of range.getClientRects())if(rect.width>0&&rect.height>0)lines.push({top:rect.top,bottom:rect.bottom});}return {text:body.textContent,scrollTop:log.scrollTop,clip:{top:clip.top,bottom:clip.bottom},lines,fullyReadable:lines.length>0&&lines.every(rect=>rect.top>=clip.top-1&&rect.bottom<=clip.bottom+1)};},answer);
 assert(answerView?.fullyReadable,'本次完整助手解释必须实际在讨论视口内，不能仅存在DOM中');report.steps.push({action:'核对当前完整解释实际可读',...answerView});
 await shot('02-显式打开标签式审核讨论-800',{floatVisible:true,distinctFrom:'01-报告主体与底部审核按钮-800'});
 report.layoutProof.beforeDrag=await nativeReportLayout();assert.deepEqual(report.layoutProof.beforeDrag.blocks,report.layoutProof.beforeOpen.blocks,'问答不改报告正文换行');assert.deepEqual(report.layoutProof.beforeDrag.scroll,report.layoutProof.beforeOpen.scroll,'问答不抢报告阅读位置');
 await discussion.type('[data-review-instruction]',unsent);await discussion.waitForFunction(()=>document.querySelector('[data-review-instruction-status]')?.textContent.includes('草稿已保存'));
 const beforeMove=(await nativeDiscussionState()).find(row=>row.visible).bounds;
 const head=await discussion.$eval('[data-local-window-header]',n=>{const r=n.getBoundingClientRect();return {x:r.left+Math.min(100,r.width/3),y:r.top+r.height/2};});
 await discussion.evaluate(()=>{window.__humanJourneyPointer=[];for(const type of ['pointerdown','pointermove','pointerup','gotpointercapture','lostpointercapture'])document.addEventListener(type,event=>window.__humanJourneyPointer.push({type,isTrusted:event.isTrusted,target:event.target?.dataset?.localWindowHeader!==undefined?'header':event.target?.tagName,path:event.composedPath().slice(0,5).map(node=>node.tagName||node.nodeName),client:{x:event.clientX,y:event.clientY},screen:{x:event.screenX,y:event.screenY},pointerId:event.pointerId}),true);});
 await discussion.mouse.move(head.x,head.y);await discussion.mouse.down();await discussion.mouse.move(head.x-100,head.y-70,{steps:8});await discussion.mouse.up();
 const afterMove=await until(async()=>{const bounds=(await nativeDiscussionState()).find(row=>row.visible)?.bounds;return bounds&&beforeMove.x-bounds.x>=80&&beforeMove.y-bounds.y>=50?bounds:false;},'trusted pointer drag changes actual child native bounds by at least 80×50');
 const dragEvents=await discussion.evaluate(()=>window.__humanJourneyPointer);assert(dragEvents.some(event=>event.type==='pointerdown'&&event.isTrusted));assert(dragEvents.some(event=>event.type==='pointermove'&&event.isTrusted));assert(dragEvents.some(event=>event.type==='pointerup'&&event.isTrusted));report.dragEvents=dragEvents;
 await shot('03-直接拖动与未发意见-800',{floatVisible:true});
 report.layoutProof.afterDrag=await nativeReportLayout();assert.deepEqual(report.layoutProof.afterDrag,report.layoutProof.beforeDrag,'拖动原生子窗不得裁切或重排报告');
 await compareReportPixels('01a-报告非零阅读位置-800','03-直接拖动与未发意见-800');
 const inputNode=await discussion.$('[data-review-instruction]'),historyNode=await discussion.$('[data-review-discussion-history]');
 const retained=await discussion.evaluate(()=>{const e=document.querySelector('[data-review-instruction]'),log=document.querySelector('[data-review-discussion-history]');e.focus();e.setSelectionRange(2,8);return {draft:e.value,selection:[e.selectionStart,e.selectionEnd],scroll:log.scrollTop};});
 assert(retained.scroll>0,'保留真正滚过的记录位置，不以非滚动子节点的0冒充保留');
 await discussion.click('[data-local-window-hide]');await shot('04-收起恢复报告主体-800',{floatVisible:false,distinctFrom:'03-直接拖动与未发意见-800'});
 report.layoutProof.afterClose=await nativeReportLayout();assert.deepEqual(report.layoutProof.afterClose,report.layoutProof.beforeDrag,'关闭讨论恢复同一报告viewport与行位置');
 await review.click('[data-review-action="open-discussion"]');await expectDiscussionVisible(true);assert.equal(await discussionPage(),discussion);assert(await inputNode.evaluate(node=>node===document.querySelector('[data-review-instruction]')));assert(await historyNode.evaluate(node=>node===document.querySelector('[data-review-discussion-history]')));const reopened=await discussion.evaluate(()=>{const e=document.querySelector('[data-review-instruction]'),log=document.querySelector('[data-review-discussion-history]');return {draft:e.value,selection:[e.selectionStart,e.selectionEnd],scroll:log.scrollTop};});assert.deepEqual(reopened,retained);
 report.steps.push({action:'底部按钮显式打开→标题直接拖动→收起展开',beforeMove,afterMove,retained});
 await submit(modification);const updated=(await state()).works[0].result.objectId;await discussion.waitForSelector('[data-review-action="latest-discussion"]:not([hidden])',{visible:true});await discussion.click('[data-review-action="latest-discussion"]');await until(()=>review.evaluate(id=>window.__workspaceScope.viewState.report.objectId===id,updated),'新版报告');await review.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');await until(()=>discussion.evaluate(id=>window.__workspaceScope.objectId===id,updated),'同一原生讨论绑定新版报告');
 await discussion.waitForFunction(()=>{const e=document.querySelector('[data-review-instruction]');return e&&!e.disabled&&!e.readOnly;});await discussion.type('[data-review-instruction]',unsent);await discussion.waitForFunction(()=>document.querySelector('[data-review-instruction-status]')?.textContent.includes('草稿已保存'));
 await discussion.click('[data-local-window-hide]');await expectDiscussionVisible(false);
 const updatedKey=await review.$eval('.managed-report-body .isolated-viewport',node=>node.dataset.previewKey),updatedOrigin=(await invoke(review,'isolated-preview.snapshot',{key:updatedKey})).origin;
 const updatedGuest=await until(async()=>(await browser.pages()).find(page=>page.url().startsWith(updatedOrigin+'/')),'updated report guest');
 await updatedGuest.waitForSelector('[data-nozeli-report-endmatter] .nozeli-end-files li');
 const fileRow=await updatedGuest.evaluateHandle(relPath=>[...document.querySelectorAll('[data-nozeli-report-endmatter] .nozeli-end-files li')].find(row=>row.querySelector('code.nozeli-end-path')?.textContent===relPath),relPath);
 const fileLink=await fileRow.asElement()?.$('[data-nozeli-endmatter-action="file"]');assert(fileLink,'actual delivery path must have a guest endmatter file link');await fileLink.scrollIntoView();await fileLink.click();doc=await activePage('document');await doc.waitForFunction(()=>window.__nozeliInput?.text().includes('访谈摘要'));const beforeHuman=await doc.evaluate(()=>window.__nozeliInput.text());assert.equal(beforeHuman,revisedCandidate);
 await doc.bringToFront();await doc.evaluate(t=>{window.__nozeliInput.focus();const text=window.__nozeliInput.text();window.__nozeliInput.select(text.length,text.length);window.__nozeliInput.insert(t);},humanNote);await doc.keyboard.down('Control');await doc.keyboard.press('s');await doc.keyboard.up('Control');
 const humanText=beforeHuman+humanNote;await until(async()=>{const r=await invoke(doc,'managed.review.read',{projectId:project.id,workId:work.id,objectId:updated,relPath});return r.files?.some(f=>f.relPath===relPath&&f.draft?.text===humanText);},'人工审阅稿持久保存');
 await assert.rejects(fs.stat(path.join(root,relPath)),{code:'ENOENT'});await shot('05-人工直接改稿已保存-800',{page:doc,distinctFrom:'04-收起恢复报告主体-800'});report.steps.push({action:'人工编辑候选→Ctrl+S',relPath,text:humanText,projectStillMissing:true});
 const decision=process.env.NOZELI_REVIEW_DECISION==='discard'?'discard':'accept';report.decision=decision;
 await activateReview();await review.waitForFunction(decision=>!document.querySelector('[data-review-action="'+decision+'"]').disabled,{},decision);
 await expectDiscussionVisible(false);for(const width of [800,1440]){await resize(width,width===800?650:900);await shot('06-人工稿返回报告主体-'+width,{floatVisible:false,...(width===800?{distinctFrom:'05-人工直接改稿已保存-800'}:{})});}
 if(decision==='discard'){
  const beforeDiscard=await state(),jobIds=beforeDiscard.jobs.map(job=>job.id),providerRequests=provider.requests.length,reportOriginalText=await updatedGuest.$eval('main',node=>node.textContent);
  const frozenBefore=await invoke(shell,'managed.artifact.read',{projectId:project.id,objectId:updated,relPath});assert.equal(frozenBefore.text,revisedCandidate,'frozen candidate must not include the human review edit');
  await review.click('[data-review-action="discard"]');await review.waitForSelector('[data-confirmation-dialog][open]');report.confirmation=await review.$eval('[data-confirmation-dialog]',node=>node.innerText);
  await shot('07-放弃并结束确认-1440',{distinctFrom:'06-人工稿返回报告主体-1440'});await review.click('[data-confirmation-cancel]');
  const cancelled=await state();assert.equal(cancelled.works[0].status,'review');assert.equal(cancelled.works[0].outcome,beforeDiscard.works[0].outcome);assert.deepEqual(cancelled.jobs.map(job=>job.id),jobIds);assert.equal(provider.requests.length,providerRequests);await assert.rejects(fs.stat(path.join(root,relPath)),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(root,'材料说明.md'),'utf8'),source);
  const cancelledReview=await invoke(shell,'managed.review.read',{projectId:project.id,workId:work.id,objectId:updated,relPath});assert.equal(cancelledReview.files.find(file=>file.relPath===relPath)?.draft?.text,humanText);assert.equal((await invoke(shell,'managed.review.instruction.read',{projectId:project.id,workId:work.id,objectId:updated})).text,unsent);
  await review.waitForSelector('[data-review-action="discard"]:not([disabled])');await review.click('[data-review-action="discard"]');await review.waitForSelector('[data-confirmation-dialog][open]');await review.click('[data-confirmation-confirm]');
  await until(async()=>{const current=(await state()).works[0];if(current.closure?.phase==='blocked')throw Error(JSON.stringify(current.closure));return current.status==='ended'&&current.outcome==='discard'&&current.closure?.phase==='complete';},'放弃决定实际结束且完整收尾');
  await assert.rejects(fs.stat(path.join(root,relPath)),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(root,'材料说明.md'),'utf8'),source);
  const discarded=await state();assert.equal(discarded.works.length,1);assert.equal(discarded.works[0].threadId,thread);assert.equal(discarded.works[0].outcome,'discard');assert.deepEqual(discarded.jobs.map(job=>job.id),jobIds);assert.equal(discarded.jobs.some(job=>job.text===unsent),false);assert.equal(provider.requests.length,providerRequests);
  assert.equal((await invoke(shell,'managed.artifact.read',{projectId:project.id,objectId:updated,relPath})).text,revisedCandidate,'discard retains the exact frozen candidate');
  const historicalReview=await invoke(shell,'managed.review.read',{projectId:project.id,workId:work.id,objectId:updated,relPath});assert.equal(historicalReview.files.find(file=>file.relPath===relPath)?.draft?.text,humanText,'discard retains the exact saved human draft');
  assert.equal((await invoke(shell,'managed.review.instruction.read',{projectId:project.id,workId:work.id,objectId:updated})).text,unsent,'discard retains the exact unsent instruction');assert.equal(await discussion.$eval('[data-review-instruction]',node=>node.value),unsent);
  assert.equal(await updatedGuest.$eval('main',node=>node.textContent),reportOriginalText,'frozen report original remains readable and unchanged after discard');await shot('08-放弃结束后保留报告-1440',{floatVisible:false});
  assert.deepEqual(provider.errors,[]);assert.deepEqual(errors,[]);report.steps.push({action:'放弃确认取消零副作用→明确放弃并结束',relPath,projectStillMissing:true,retainedFrozenText:revisedCandidate,retainedHumanText:humanText,retainedUnsent:unsent,thread,jobIds,workStatus:discarded.works[0].status,outcome:discarded.works[0].outcome,closurePhase:discarded.works[0].closure.phase});report.checks.push('真实Pi同线程解释与修改','放弃确认取消零副作用','放弃后项目不写入候选且原文件bytes不变','冻结报告/候选/人工稿/未发送意见保留可读','放弃ended/complete且无新增job或provider调用');report.providerCalls=provider.requests.length;report.scriptPhases=calls;report.ok=true;
 }else{
 await review.click('[data-review-action="accept"]');await review.waitForSelector('[data-confirmation-dialog][open]');const confirmation=await review.$eval('[data-confirmation-dialog]',n=>n.innerText);report.confirmation=confirmation;assert(confirmation.includes(relPath),'confirmation names actual file');assert(confirmation.includes('人工'),'confirmation identifies manual version');await shot('07-采用人工稿单层确认-1440',{distinctFrom:'06-人工稿返回报告主体-1440'});await review.click('[data-confirmation-cancel]');assert.equal(await discussion.$eval('[data-review-instruction]',n=>n.value),unsent);assert.equal((await state()).works[0].status,'review');await assert.rejects(fs.stat(path.join(root,relPath)),{code:'ENOENT'});
 await review.click('[data-review-action="accept"]');await review.waitForSelector('[data-confirmation-dialog][open]');await review.click('[data-confirmation-confirm]');await until(async()=>{const w=(await state()).works[0];if(w.closure?.phase==='blocked')throw Error(JSON.stringify(w.closure));return w.status==='ended'&&w.closure?.phase==='complete';},'人工稿实际合入');
 assert.equal(await fs.readFile(path.join(root,relPath),'utf8'),humanText);assert.equal(await fs.readFile(path.join(root,'材料说明.md'),'utf8'),source);const final=await state();assert.equal(final.works.length,1);assert.equal(final.works[0].threadId,thread);assert.equal(final.jobs.some(j=>j.text===unsent),false);assert.equal(await discussion.$eval('[data-review-instruction]',n=>n.value),unsent);assert.deepEqual(provider.errors,[]);assert.deepEqual(errors,[]);report.steps.push({action:'返回审阅保留草稿→明确采纳人工稿',exactFile:relPath,mergedText:humanText,unsentDispatched:false,workStatus:final.works[0].status});report.checks.push('自然中文原任务及同线程讨论','主工作区正文与原生子窗实际X11合成同帧','收起恢复正文且意见保留','人工直接编辑候选保存后原项目未改','单层确认实际路径/人工稿/未发送意见','采纳文件逐字等于人工稿且ended/complete');report.providerCalls=provider.requests.length;report.scriptPhases=calls;report.ok=true;
 }
 observer.close();observer=null;
 await invoke(shell,'session.requestClose');assert.deepEqual(await Promise.race([exit,pause(20000).then(()=>null)]),{code:0,signal:null});child=null;
}catch(error){report.error=error.stack;process.exitCode=1;await review?.screenshot({path:path.join(out,'failure-dom.png')}).catch(()=>{});if(windowId)await shot('failure-composite').catch(()=>{});report.visible=await review?.evaluate(()=>document.body.innerText.slice(-7000)).catch(()=>null);}
finally{observer?.close();if(child?.exitCode===null){try{await invoke(shell,'session.requestClose');await Promise.race([exit,pause(10000)]);}catch{}if(child.exitCode===null)child.kill('SIGTERM');}await browser?.disconnect().catch(()=>{});await provider.close();report.errors=errors;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));}
