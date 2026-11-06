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
 if(!r.messages.some(m=>m.tool_call_id===id))return {text:version===1?'我先核对材料边界，再整理访谈摘要，不把单一实验室的样本推广为总体。':'我会保持原来的样本边界，并把补充建议落到同一份候选稿。',tool:'write',id,args:{path:relPath,content:version===1?originalCandidate:revisedCandidate}};
 return {text:version===1?'摘要已按材料整理，接下来发布原文可读的报告与候选文件，供你审阅。':'补充建议已写入候选稿，现在发布本次对应的报告与文件。',tool:'nozeli_publish',id:version===1?'zh-publish-1':'zh-publish-2',args:{kind:'result',content:htmlReport(version),files:[relPath]}};
});
let child,browser,shell,review,doc,observer,exit,log='',windowId;const errors=[];
const report={ok:false,out,version:'0.1.0-alpha.5-source-report-restoration',scope:'Actual Electron/private Pi/native files and owned X11 capture; report-first footer, explicit tag-style Work discussion and human adoption. Chinese local scripted Provider only.',steps:[],screenshots:[],checks:[],notCovered:['真实模型理解','Windows/macOS','R01/R02与未知效果恢复','同文件合入冲突解决']};
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
 const visibleState=await page.evaluate(()=>({scope:window.__workspaceScope,discussionVisible:Boolean(document.querySelector('[data-review-discussion]:not([hidden])')?.getClientRects().length),draft:document.querySelector('[data-review-instruction]')?.value,dialogBox:(()=>{const el=document.querySelector('[data-review-discussion]');if(!el||el.hidden)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})(),reportBox:(()=>{const el=document.querySelector('.managed-report-body');if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()}));
 const file=path.join(out,name+'.png');let changedPixels=null,attempts=0;
 for(;attempts<8;attempts++){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await observer.evaluate(`(async()=>{const {BaseWindow}=process.mainModule.require('electron');const capture=async view=>{if(!view.getVisible?.())return;if(view.webContents&&!view.webContents.isDestroyed())await view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});for(const child of view.children||[])await capture(child);};for(const win of BaseWindow.getAllWindows())for(const view of win.contentView.children||[])await capture(view);return true;})()`,15000);
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
async function activateReview(){
 const id=await review.evaluate(()=>window.__workspaceScope.viewId);await shell.evaluate(id=>window.__workspaceGroups.command({type:'activate',viewId:id,groupId:window.__workspaceGroups.activeGroup()}),id);
 const url=review.url();await until(()=>observer.evaluate(`(()=>{const {BaseWindow}=process.mainModule.require('electron');const win=BaseWindow.getAllWindows().find(w=>(w.contentView.children||[]).some(v=>v.getVisible?.()&&v.webContents?.getURL()===${JSON.stringify(url)}));if(!win)return false;win.show();win.focus();return true;})()`),'真实审核内容面激活并置于前台');
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
 assert.equal(await review.evaluate(()=>{const node=document.querySelector('[data-review-discussion]');return !node||node.hidden;}),true);
 for(const width of [1440,800]){await resize(width,width===800?650:900);await shot('01-报告主体与底部审核按钮-'+width,{floatVisible:false});}
 const firstDiscussion=await invoke(review,'managed.review.discussion.read',{projectId:project.id,workId:work.id,objectId:work.result.objectId,limit:100});
 const mainFrame=await invoke(shell,'managed.timeline.page',{projectId:project.id,limit:100}),mainRows=new Map(mainFrame.entries.map(row=>[row.id,row]));
 const workerRows=firstDiscussion.entries.filter(row=>row.speaker==='worker'&&row.source!=='publication');assert.equal(workerRows.length,2,'真实初稿回合有两段原生助手正文');
 for(const row of workerRows){assert(mainRows.has(row.id),'同一原消息也在主对话canonical timeline');assert.equal(mainRows.get(row.id).text,row.text);assert.equal(row.workId,work.id);}
 await resize(1440,900);await shell.click('#workspace-open-conversation');const conversationPage=await activePage('conversation');
 await conversationPage.waitForSelector('.session-worker details > summary');const workerDetails=await conversationPage.$('.session-worker details');if(!await workerDetails.evaluate(node=>node.open))await conversationPage.click('.session-worker details > summary');
 await conversationPage.waitForFunction(text=>document.body.textContent.includes(text),{},workerRows[0].text);await conversationPage.$eval('.session-worker',node=>node.scrollIntoView({block:'start'}));
 await shot('00-主对话同一Work原始内容-1440',{page:conversationPage});
 await activateReview();assert.equal(await review.evaluate(()=>{const node=document.querySelector('[data-review-discussion]');return !node||node.hidden;}),true);await resize(800,650);
 const previewKey=await review.$eval('.managed-report-body .isolated-viewport',node=>node.dataset.previewKey),previewOrigin=(await invoke(review,'isolated-preview.snapshot',{key:previewKey})).origin;
 const readingGuest=(await browser.pages()).find(page=>page.url().startsWith(previewOrigin+'/'));assert(readingGuest);await invoke(review,'isolated-preview.focus',{key:previewKey});await until(()=>observer.evaluate(`(()=>{const {webContents}=process.mainModule.require('electron');return webContents.getFocusedWebContents()?.getURL().startsWith(${JSON.stringify(previewOrigin+'/')})===true;})()`),'原生报告实际取得阅读焦点');
 await readingGuest.screenshot({captureBeyondViewport:false});let readingScrollAttempts=0;
 for(;readingScrollAttempts<8;readingScrollAttempts++){const before=await nativeReportLayout();if(before.scroll.y>=119)break;await readingGuest.mouse.move(100,100);await readingGuest.mouse.wheel({deltaY:120-before.scroll.y});await review.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
 const readingPosition=await nativeReportLayout();assert(readingPosition.scroll.y>0,'真实输入须建立非零原文位置');report.steps.push({action:'真实原生阅读滚动',inputAttempts:readingScrollAttempts,position:readingPosition.scroll});
 await review.bringToFront();
 await shot('01a-报告非零阅读位置-800',{floatVisible:false,distinctFrom:'01-报告主体与底部审核按钮-800'});
 report.layoutProof={beforeOpen:await nativeReportLayout()};
 await review.click('[data-review-action="open-discussion"]');await review.waitForSelector('[data-review-discussion]',{visible:true});assert.equal(await review.$eval('[data-review-discussion]',n=>Boolean(n.querySelector('[data-review-action="accept"]'))),false);
 await shot('01b-显式打开不重排报告-800',{floatVisible:true,distinctFrom:'01a-报告非零阅读位置-800'});report.layoutProof.afterOpen=await nativeReportLayout();assert.deepEqual(report.layoutProof.afterOpen,report.layoutProof.beforeOpen,'仅打开讨论不得改变原生viewport或报告文字行位置');
 const reviewBubbles=await review.$$eval('[data-review-discussion-history] .tag-message-assistant',nodes=>nodes.map(node=>({ids:[...node.querySelectorAll('[data-message-id]')].map(n=>n.dataset.messageId),text:node.textContent})));
 assert(reviewBubbles.some(bubble=>workerRows.every(row=>bubble.ids.includes(row.id))),'同一真实回合两段正文在同一个AI气泡内，原消息ID不丢');
 report.steps.push({action:'核对主对话同一Work与审核窗口',workId:work.id,sourceMessageIds:workerRows.map(row=>row.id),sameTexts:true,singleReplyBubble:true});
 report.steps.push({action:'待办进入审阅',report:'访谈摘要初稿',files:[relPath]});
 await submit(question);await review.waitForFunction(()=>document.querySelector('[data-review-discussion-history]')?.textContent.includes('十人样本主要来自同一实验室'));
 await review.waitForFunction(()=>{const e=document.querySelector('[data-review-instruction]');return e&&!e.disabled&&!e.readOnly;});
 const answerView=await review.evaluate(answer=>{const log=document.querySelector('[data-review-discussion-history]'),clip=log.getBoundingClientRect(),body=[...log.querySelectorAll('.tag-message-assistant [data-message-id]')].find(node=>node.textContent.includes(answer));if(!body)return null;const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),lines=[];for(let node=walker.nextNode();node;node=walker.nextNode()){if(!node.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(node);for(const rect of range.getClientRects())if(rect.width>0&&rect.height>0)lines.push({top:rect.top,bottom:rect.bottom});}return {text:body.textContent,scrollTop:log.scrollTop,clip:{top:clip.top,bottom:clip.bottom},lines,fullyReadable:lines.length>0&&lines.every(rect=>rect.top>=clip.top-1&&rect.bottom<=clip.bottom+1)};},answer);
 assert(answerView?.fullyReadable,'本次完整助手解释必须实际在讨论视口内，不能仅存在DOM中');report.steps.push({action:'核对当前完整解释实际可读',...answerView});
 await shot('02-显式打开标签式审核讨论-800',{floatVisible:true,distinctFrom:'01-报告主体与底部审核按钮-800'});
 report.layoutProof.beforeDrag=await nativeReportLayout();assert.deepEqual(report.layoutProof.beforeDrag.blocks,report.layoutProof.beforeOpen.blocks,'问答不改报告正文换行');assert.deepEqual(report.layoutProof.beforeDrag.scroll,report.layoutProof.beforeOpen.scroll,'问答不抢报告阅读位置');
 await review.type('[data-review-instruction]',unsent);await review.waitForFunction(()=>document.querySelector('[data-review-instruction-status]')?.textContent.includes('草稿已保存'));
 const beforeMove=await review.$eval('[data-review-discussion]',n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y}));
 const head=await review.$eval('[data-review-discussion] .local-window-header',n=>{const r=n.getBoundingClientRect();return {x:r.left+Math.min(100,r.width/3),y:r.top+r.height/2};});
 await review.mouse.move(head.x,head.y);await review.mouse.down();await review.mouse.move(head.x-100,head.y-70,{steps:8});await review.mouse.up();
 const afterMove=await review.$eval('[data-review-discussion]',n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y}));assert(Math.abs(afterMove.x-beforeMove.x)>5||Math.abs(afterMove.y-beforeMove.y)>5,'标题可以直接拖动，无需切换模式');
 await shot('03-直接拖动与未发意见-800',{floatVisible:true});
 report.layoutProof.afterDrag=await nativeReportLayout();assert.deepEqual(report.layoutProof.afterDrag,report.layoutProof.beforeDrag,'拖动遮挡只改变裁切，不得让报告重排');
 const retained=await review.evaluate(()=>{const e=document.querySelector('[data-review-instruction]'),log=document.querySelector('[data-review-discussion-history]');e.focus();e.setSelectionRange(2,8);return {draft:e.value,selection:[e.selectionStart,e.selectionEnd],scroll:log.scrollTop};});
 assert(retained.scroll>0,'保留真正滚过的记录位置，不以非滚动子节点的0冒充保留');
 await review.bringToFront();
 await review.click('[data-review-discussion] [data-local-window-hide]');await shot('04-收起恢复报告主体-800',{floatVisible:false,distinctFrom:'03-直接拖动与未发意见-800'});
 report.layoutProof.afterClose=await nativeReportLayout();assert.deepEqual(report.layoutProof.afterClose,report.layoutProof.beforeDrag,'关闭讨论恢复同一报告viewport与行位置');
 await review.click('[data-review-action="open-discussion"]');const reopened=await review.evaluate(()=>{const e=document.querySelector('[data-review-instruction]'),log=document.querySelector('[data-review-discussion-history]');return {draft:e.value,selection:[e.selectionStart,e.selectionEnd],scroll:log.scrollTop};});assert.deepEqual(reopened,retained);
 report.steps.push({action:'底部按钮显式打开→标题直接拖动→收起展开',beforeMove,afterMove,retained});
 await submit(modification);const updated=(await state()).works[0].result.objectId;await until(()=>review.$('[data-review-action="latest-discussion"]:not([hidden])'),'新版入口');await review.click('[data-review-action="latest-discussion"]');await until(()=>review.evaluate(id=>window.__workspaceScope.viewState.report.objectId===id,updated),'新版报告');await review.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
 await review.waitForFunction(()=>{const e=document.querySelector('[data-review-instruction]');return e&&!e.disabled&&!e.readOnly;});await review.type('[data-review-instruction]',unsent);await review.waitForFunction(()=>document.querySelector('[data-review-instruction-status]')?.textContent.includes('草稿已保存'));
 await review.click('[data-review-discussion] [data-local-window-hide]');await review.click('[data-review-action="files"]');
 await review.waitForSelector('[data-review-files-panel] [data-review-file="'+relPath+'"][data-review-action="file"]',{visible:true});await review.click('[data-review-files-panel] [data-review-file="'+relPath+'"][data-review-action="file"]');doc=await activePage('document');await doc.waitForFunction(()=>window.__nozeliInput?.text().includes('访谈摘要'));const beforeHuman=await doc.evaluate(()=>window.__nozeliInput.text());assert.equal(beforeHuman,revisedCandidate);
 await doc.bringToFront();await doc.evaluate(t=>{window.__nozeliInput.focus();const text=window.__nozeliInput.text();window.__nozeliInput.select(text.length,text.length);window.__nozeliInput.insert(t);},humanNote);await doc.keyboard.down('Control');await doc.keyboard.press('s');await doc.keyboard.up('Control');
 const humanText=beforeHuman+humanNote;await until(async()=>{const r=await invoke(doc,'managed.review.read',{projectId:project.id,workId:work.id,objectId:updated,relPath});return r.files?.some(f=>f.relPath===relPath&&f.draft?.text===humanText);},'人工审阅稿持久保存');
 await assert.rejects(fs.stat(path.join(root,relPath)),{code:'ENOENT'});await shot('05-人工直接改稿已保存-800',{page:doc,distinctFrom:'04-收起恢复报告主体-800'});report.steps.push({action:'人工编辑候选→Ctrl+S',relPath,text:humanText,projectStillMissing:true});
 await activateReview();await review.waitForFunction(()=>!document.querySelector('[data-review-action="accept"]').disabled);
 assert.equal(await review.$eval('[data-review-discussion]',n=>n.hidden),true);for(const width of [800,1440]){await resize(width,width===800?650:900);await shot('06-人工稿返回报告主体-'+width,{floatVisible:false,...(width===800?{distinctFrom:'05-人工直接改稿已保存-800'}:{})});}
 await review.click('[data-review-action="accept"]');await review.waitForSelector('[data-confirmation-dialog][open]');const confirmation=await review.$eval('[data-confirmation-dialog]',n=>n.innerText);report.confirmation=confirmation;assert(confirmation.includes(relPath),'confirmation names actual file');assert(confirmation.includes('人工'),'confirmation identifies manual version');assert(confirmation.includes('不会')&&confirmation.includes('AI'),'confirmation states unsent opinions are not sent');await shot('07-采用人工稿单层确认-1440',{distinctFrom:'06-人工稿返回报告主体-1440'});await review.click('[data-confirmation-cancel]');assert.equal(await review.$eval('[data-review-instruction]',n=>n.value),unsent);assert.equal((await state()).works[0].status,'review');await assert.rejects(fs.stat(path.join(root,relPath)),{code:'ENOENT'});
 await review.click('[data-review-action="accept"]');await review.waitForSelector('[data-confirmation-dialog][open]');await review.click('[data-confirmation-confirm]');await until(async()=>{const w=(await state()).works[0];if(w.closure?.phase==='blocked')throw Error(JSON.stringify(w.closure));return w.status==='ended'&&w.closure?.phase==='complete';},'人工稿实际合入');
 assert.equal(await fs.readFile(path.join(root,relPath),'utf8'),humanText);assert.equal(await fs.readFile(path.join(root,'材料说明.md'),'utf8'),source);const final=await state();assert.equal(final.works.length,1);assert.equal(final.works[0].threadId,thread);assert.equal(final.jobs.some(j=>j.text===unsent),false);assert.equal(await review.$eval('[data-review-instruction]',n=>n.value),unsent);assert.deepEqual(provider.errors,[]);assert.deepEqual(errors,[]);report.steps.push({action:'返回审阅保留草稿→明确采用人工稿',exactFile:relPath,mergedText:humanText,unsentDispatched:false,workStatus:final.works[0].status});report.checks.push('自然中文原任务及同线程讨论','主工作区正文与标签窗实际X11同帧','收起恢复正文且意见保留','人工直接编辑候选保存后原项目未改','单层确认实际路径/人工稿/未发送意见','采用文件逐字等于人工稿且ended/complete');report.providerCalls=provider.requests.length;report.scriptPhases=calls;report.ok=true;
 observer.close();observer=null;
 await invoke(shell,'session.requestClose');assert.deepEqual(await Promise.race([exit,pause(20000).then(()=>null)]),{code:0,signal:null});child=null;
}catch(error){report.error=error.stack;process.exitCode=1;await review?.screenshot({path:path.join(out,'failure-dom.png')}).catch(()=>{});if(windowId)await shot('failure-composite').catch(()=>{});report.visible=await review?.evaluate(()=>document.body.innerText.slice(-7000)).catch(()=>null);}
finally{observer?.close();if(child?.exitCode===null){try{await invoke(shell,'session.requestClose');await Promise.race([exit,pause(10000)]);}catch{}if(child.exitCode===null)child.kill('SIGTERM');}await browser?.disconnect().catch(()=>{});await provider.close();report.errors=errors;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));}
