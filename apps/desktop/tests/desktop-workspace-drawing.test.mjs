// Parent-only serial smoke: NOZELI_TEST_BINARY=/candidate/nozeli node tests/desktop-report-actions-live.mjs
// Real Git + host, synthetic durable history; no Worker inference, provider initialization or DOM injection.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {prepareFrozenWorkflow} from './desktop-frozen-workflow.fixture.mjs';
const appRoot=process.env.NOZELI_TEST_APP_ROOT||path.resolve(import.meta.dirname,'..');
const {Controller}=await import(path.join(appRoot,'src/agents/managed/controller.mjs')); 
import {staticReport} from './static-report.fixture.mjs';

const source=path.resolve(import.meta.dirname,'..');
const binary=process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron');
const lock=path.join(os.tmpdir(),'nozeli-drawing-live.lock');
await fs.mkdir(lock);
const report={checks:[],scenes:[],errors:[],evidence:'真实 Git 和真实宿主；预置合成历史，非 Worker 推理。',processEvidence:'Linux /proc sampled descendant processes; Electron renderer/utility processes are UI, not Agent processes.'};
let out,fixture,child,browser,shell,log='',launchError,monitor,monitorPending=Promise.resolve(),monitorError;
let explicitChat=false;
const observedProcesses=new Map();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=12000){
 const end=Date.now()+timeout;
 do{if(launchError)throw launchError;if(child&&(child.exitCode!==null||child.signalCode))throw Error('Product exited: '+log);if(monitorError)throw monitorError;const value=await fn();if(value)return value;await pause(60);}while(Date.now()<end);
 throw Error('Timeout: '+label);
}
async function call(page,op,payload={}){const result=await page.evaluate((op,payload)=>window.nozeli.invoke(op,payload),op,payload);assert(result.ok,op+': '+JSON.stringify(result.error));return result.value;}
async function scoped(kind){return until(async()=>{for(const page of await browser.pages()){const scope=await page.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope&&(kind==='shell'?scope.role==='shell':scope.role==='surface'&&scope.kind===kind&&scope.projectId===fixture.a.id)&&await page.evaluate(()=>window.__nozeliReady===true))return {page,scope};}},'ready '+kind);}
async function isolatedReport(reportPage,objectId){
 const preview=await until(async()=>{
  if(!await reportPage.$eval('.isolated-report .isolated-status',n=>n.dataset.state==='ready'))return false;
  const key=await reportPage.$eval('.isolated-report .isolated-viewport',n=>n.dataset.previewKey);
  if(!key)return false;
  return call(reportPage,'isolated-preview.snapshot',{key});
 },'host-bound isolated report snapshot');
 assert.equal(preview.projectId,fixture.a.id);assert.equal(preview.profile,'staticReport');
 const target=await browser.waitForTarget(target=>target.type()==='page'&&target.url().startsWith(preview.origin+'/'),{timeout:20000});
 const page=await target.page();await page.waitForFunction(()=>document.body?.textContent.includes('OFFLINE-RESULT-CONTENT-67291'));
 assert.equal(await page.evaluate(()=>typeof window.nozeli),'undefined');
 assert.equal(await page.evaluate(()=>typeof process),'undefined');
 assert.equal(await page.evaluate(()=>typeof require),'undefined');
 const source=await call(shell,'managed.history.read',{projectId:fixture.a.id,objectId});
 assert.equal(source.objectVerified,true);assert.equal(source.objectId,objectId);assert.equal(source.report.format,'html-static');
 return {page,scope:{role:'isolated-static-report',url:target.url(),preview,projectId:source.projectId,objectId:source.objectId,report:source.report}};
}
async function windows(){return call(shell,'workspace.windows.list',{projectId:fixture.a.id});}
async function visible(viewId){return until(async()=> (await windows()).flatMap(w=>w.surfaces).find(s=>s.viewId===viewId&&s.visible&&s.bounds.width>0&&s.bounds.height>0),'visible native content '+viewId);}
async function snapshot(){return call(shell,'managed.status',{projectId:fixture.a.id});}
function execution(state){return {jobs:state.jobs,providers:state.providers||{},agents:state.agents||[],residents:state.residents||{},requests:state.jobs.flatMap(j=>j.collabAttempts||[]),workThreads:state.works.filter(w=>w.threadId).map(w=>[w.id,w.threadId])};}
async function offline(expected){const status=await snapshot();assert.equal(status.ready,false);assert.deepEqual(execution(status.state),expected);assert.deepEqual(Object.keys(status.state.providers||{}),[]);assert.equal(status.state.agents.length,0);assert.equal((await call(shell,'config.status')).initialized,false);assert(!(await windows()).some(w=>w.surfaces.some(s=>s.kind==='conversation')),'No online conversation surface');return status;}
async function sampleProcesses(pid){
 let children;try{children=await fs.readFile('/proc/'+pid+'/task/'+pid+'/children','utf8');}catch(error){if(error.code==='ENOENT')return;throw error;}
 for(const id of children.trim().split(/\s+/).filter(Boolean)){
  try{const [exe,cmd]=await Promise.all([fs.readlink('/proc/'+id+'/exe'),fs.readFile('/proc/'+id+'/cmdline','utf8')]);observedProcesses.set(id,{pid:Number(id),exe,command:cmd.replaceAll('\0',' ')});}catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw error;}
  await sampleProcesses(id);
 }
}
async function monitorUI(){
 await sampleProcesses(child.pid);
 for(const page of await browser.pages()){
  const state=await page.evaluate(()=>({scope:window.__workspaceScope,dialogs:[...document.querySelectorAll('dialog[open]')].map(n=>({id:n.id,text:n.innerText})),toasts:[...document.querySelectorAll('.toast,#toast')].filter(n=>n.getClientRects().length).map(n=>n.innerText).filter(Boolean)})).catch(()=>null);
  if(!state?.scope)continue;
  if(!explicitChat&&(state.dialogs.some(d=>d.id==='conversation-connection-error'||d.id==='configuration-setup')||state.toasts.some(t=>/请.*初始化|先.*初始化|完成.*配置初始化/.test(t))))report.interruption={...state,at:new Date().toISOString(),stage:report.stage};
  assert(!state.toasts.some(t=>/IPC_DENIED|外部变更监听失败|文件标记未能加载|目录状态未保存/.test(t)),'Directory-navigation permission failures must never surface as toasts at any stage: '+JSON.stringify(state.toasts));
 }
}
async function capture(label,page,selector,viewId,isolatedScope=null){
 const data=await page.$eval(selector,n=>{const b=n.getBoundingClientRect();return {text:n.innerText,bounds:b.toJSON(),visible:!!n.getClientRects().length&&b.width>0&&b.height>0&&b.right>0&&b.bottom>0&&b.left<innerWidth&&b.top<innerHeight};});
 assert(data.visible,label+' positive visible bounds');
 const scope=isolatedScope||await page.evaluate(()=>window.__workspaceScope);
 const surface=viewId?await visible(viewId):null;
 const file=label+(scope.role==='shell'?'-host-shell.png':'-actual-content-WCV.png');
 await page.screenshot({path:path.join(out,file)});report.scenes.push({label,file,scope,surface,...data});
}
async function assertReportHeight(page,label){const metrics=await page.evaluate(()=>{const root=document.querySelector('#reader-scroll').getBoundingClientRect(),bar=document.querySelector('#managed-result-actions').getBoundingClientRect(),paper=document.querySelector('.isolated-report').getBoundingClientRect();return{blankBelow:root.bottom-bar.bottom,paperHeight:paper.height,barHeight:bar.height,rootHeight:root.height};});assert(metrics.blankBelow>=-1&&metrics.blankBelow<=24,label+': report must fill available height, not leave a 72vh tail '+JSON.stringify(metrics));assert(metrics.paperHeight>0,label+': report viewport must remain visible');(report.heightChecks??=[]).push({label,...metrics});}
async function editorState(doc,editor){const local=await doc.page.evaluate(editor=>({sameEditor:editor===document.querySelector('#text-host .cm-editor'),text:window.__nozeliInput.text(),selection:window.__nozeliInput.selection(),scroll:document.querySelector('#text-host .cm-scroller').scrollTop}),editor);return {...local,drafts:(await snapshot()).state.drafts};}
async function closeReport(viewId){const selector='.workspace-pane:has([data-view-id="'+viewId+'"]) [data-workspace-command="close"]';await shell.waitForSelector(selector,{visible:true});await shell.click(selector);await until(async()=>!(await windows()).some(w=>w.surfaces.some(s=>s.viewId===viewId&&s.visible)),'report no longer current visible content');}
try{
 out=process.env.NOZELI_REPORT_ACTIONS_OUT?path.resolve(process.env.NOZELI_REPORT_ACTIONS_OUT):await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-offline-results-'));
 if(process.env.NOZELI_REPORT_ACTIONS_OUT)await fs.mkdir(out);
 report.out=out;fixture=await prepareFrozenWorkflow(out,{appRoot});
 // A live business Work with a persisted result, but no native thread/provider. Do not execute it.
 const c=await Controller.open({projectId:fixture.a.id,runtimeRoot:fixture.runtimeRoot,contentRoot:fixture.project});
 let work,receipt,todo;
 const text='# 离线本地报告 D3\n\n离线读取精确正文：OFFLINE-RESULT-CONTENT-67291。\n\n输入：'+fixture.inputCommit+'\n\n候选：'+fixture.candidateCommit+'\n\n这是预置合成宿主历史，不是 Worker 推理。';
 const reportHtml=staticReport(text).replace('</main>','<details id="persistent-detail"><summary>保留展开状态</summary><p id="state-marker">REPORT-STATE-MARKER</p></details><pre>const answer = 42;</pre><table><tr><th>列标题</th></tr><tr><td>表格正文</td></tr></table>'+Array.from({length:60},(_,i)=>'<p>Persistent report paragraph '+i+' — keep frozen content, scroll and selection.</p>').join('')+'</main>');
 try{work=await c.store.submit('D3 本地成果阅读，不启动任务对话','合成宿主历史，不执行',{name:'D3 离线成果工作'});await c.store.activate(work.id);work=c.store.find(work.id);const jobId='report-actions-result';await c.execution.prepare(work.id);await fs.writeFile(path.join(c.execution.directory(work.id),'action-result.txt'),'Real report action candidate');await c.execution.publish(work,{id:jobId},()=>true);receipt=await c.store.publish(work.id,1,'result',reportHtml,'offline-result-receipt',{jobId,files:[{relPath:'action-result.txt'}]});await c.store.settle(work.id);await c.store.mutate(()=>c.store.state.jobs.push({id:jobId,target:work.id,revision:1,type:'initial',status:'completed',text:'No-model fixture',context:{},completedAt:new Date().toISOString()}));todo=c.store.state.todos.find(t=>t.objectId===receipt.objectId);assert(todo);assert.equal(c.store.find(work.id).status,'review');}finally{await c.stop();}
 await fs.writeFile(path.join(fixture.profile,'appearance.json'),JSON.stringify({theme:'dark',palette:'slate',font:'system',size:13}));
 report.identity={projectId:fixture.a.id,workId:work.id,todoId:todo.id,objectId:receipt.objectId,inputCommit:fixture.inputCommit,candidateCommit:fixture.candidateCommit};
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const env={...process.env};for(const k of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(k))delete env[k];
 Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:fixture.configRoot,NOZELI_USER_DATA:fixture.profile,NOZELI_TEST_PICK:fixture.project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_SHOT_DIR:out});
 child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(source,'src/main/main.cjs')]),'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{cwd:os.tmpdir(),env,stdio:['ignore','pipe','pipe']});child.on('error',e=>launchError=e);for(const s of [child.stdout,child.stderr])s.on('data',b=>log+=b);
 await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'debug endpoint');
 shell=(await scoped('shell')).page;shell.on('pageerror',e=>report.errors.push(e.stack));
 if(await shell.$eval('#configuration-setup',n=>n.open)){await shell.click('#configuration-cancel');await shell.waitForFunction(()=>!document.querySelector('#configuration-setup').open);}
 await shell.waitForSelector('[data-project-id="'+fixture.a.id+'"]',{visible:true});await shell.click('[data-project-id="'+fixture.a.id+'"]');
 await until(async()=>(await call(shell,'workspace.bootstrap')).projectId===fixture.a.id,'project binding');
 const initial=await snapshot(),baseline=execution(initial.state);assert.deepEqual(baseline.providers,{});assert.deepEqual(baseline.agents,[]);assert.deepEqual(baseline.residents,{});assert.deepEqual(baseline.workThreads,[]);await offline(baseline);
 report.initialExecution=baseline;
 await shell.locator('[data-managed-todo="'+todo.id+'"]').click();const coldReport=await scoped('report');await visible(coldReport.scope.viewId);await coldReport.page.waitForSelector('.isolated-report',{visible:true});
 const coldGuest=await isolatedReport(coldReport.page,receipt.objectId);
 await shell.click('.workspace-pane:has([data-view-id="'+coldReport.scope.viewId+'"]) [data-workspace-command="floatOpen"]');await until(async()=>{const list=await windows();return list.length===2&&list.every(w=>w.visible)&&list.some(w=>w.id!=='main'&&w.surfaces.some(s=>s.visible));},'second native window');
 const beginCapture=await call(shell,'workspace.capture.begin',{projectId:fixture.a.id});assert(beginCapture.captureId);
 const overlay=await until(async()=>{for(const p of await browser.pages())if(p.url().endsWith('/capture.html'))return p;},'drawing overlay');
 await overlay.waitForFunction(()=>document.querySelector('#capture-canvas').width>500);
 assert.equal((await overlay.evaluate(()=>drawingCapture.invoke('read'))).value.tiles.length,2);await overlay.screenshot({path:path.join(out,'capture-native-preview.png')});
 await overlay.click('#window-mode');await overlay.waitForFunction(()=>document.querySelector('#window-mode').getAttribute('aria-pressed')==='true');
 await overlay.click('#screen-mode');await overlay.waitForFunction(()=>document.querySelector('select[aria-label="选择屏幕"]').hidden===false);
 await overlay.click('#rectangle-mode');overlay.setDefaultTimeout(10000);await overlay.click('#draw-start');await overlay.waitForFunction(()=>document.querySelector('#capture-status').textContent.includes('矩形'));
 const canvas=await overlay.$eval('#capture-canvas',n=>n.getBoundingClientRect().toJSON());await overlay.mouse.move(canvas.x+canvas.width*.2,canvas.y+canvas.height*.2);await overlay.mouse.down();await overlay.mouse.move(canvas.x+canvas.width*.7,canvas.y+canvas.height*.7,{steps:10});await overlay.mouse.up();
 await overlay.click('#unanchored-mode');await overlay.click('#draw-start');
 await overlay.waitForSelector('.drawing-area',{visible:true});
 const bounds=await overlay.$eval('.drawing-area',n=>n.getBoundingClientRect().toJSON());
 await overlay.mouse.move(bounds.x+bounds.width*.2,bounds.y+bounds.height*.4);await overlay.mouse.down();await overlay.mouse.move(bounds.x+bounds.width*.6,bounds.y+bounds.height*.6,{steps:20});await overlay.mouse.up();
 await overlay.screenshot({path:path.join(out,'drawing-stroke.png')});
 await overlay.click('#drawing-finish');
 const chat=await scoped('conversation');await chat.page.waitForSelector('.cm-chip',{visible:true});
 const materials=await chat.page.evaluate(()=>window.__composerMaterials.snapshotPersist());assert.equal(materials.pending.filter(p=>p.source==='drawing').length,1);assert.deepEqual(materials.pending.find(p=>p.source==='drawing').sources,[]);
 assert.equal((await snapshot()).state.jobs.length,initial.state.jobs.length);
 report.checks.push('Native frozen report layers, pointer drawing and unanchored offline attachment verified');
 await chat.page.screenshot({path:path.join(out,'drawing-offline-draft.png')});

 report.stage='local-second';await shell.click('#workspace-drawing');const second=await until(async()=>{for(const p of await browser.pages())if(p.url().endsWith('/capture.html'))return p;},'second drawing');await second.waitForFunction(()=>document.querySelector('#capture-canvas').width>500);second.setDefaultTimeout(10000);await second.click('#window-mode');await second.waitForFunction(()=>!document.querySelector('#draw-start').disabled);await second.click('#draw-start');await second.waitForSelector('.drawing-area',{visible:true});const b=await second.$eval('.drawing-area',n=>n.getBoundingClientRect().toJSON());await second.mouse.move(b.x+b.width*.3,b.y+b.height*.3);await second.mouse.down();await second.mouse.move(b.x+b.width*.5,b.y+b.height*.5,{steps:10});await second.mouse.up();report.stage='local-save';await second.click('#drawing-save-local');await until(()=>second.isClosed(),'local close');
 await shell.click('#workspace-drawing');report.stage='recovery-open';const third=await until(async()=>{for(const p of await browser.pages())if(p.url().endsWith('/capture.html'))return p;},'recover drawing');third.setDefaultTimeout(10000);report.stage='recovery-list';await third.waitForFunction(()=>[...document.querySelectorAll('header button')].some(b=>b.textContent.startsWith('本地备注')));await third.waitForFunction(()=>!document.querySelector('#draw-start').disabled);report.stage='recovery-click';await third.evaluate(()=>[...document.querySelectorAll('header button')].find(b=>b.textContent.startsWith('本地备注')).click());report.stage='recovery-editor';await third.waitForSelector('.drawing-area',{visible:true});report.stage='recovery-vectors';await third.waitForFunction(()=>document.querySelectorAll('.drawing-area svg polyline').length===1);await third.click('#drawing-finish');await until(()=>third.isClosed(),'recovered note attached');await until(async()=>{const state=await chat.page.evaluate(()=>__composerMaterials.snapshotPersist());return state.pending.filter(p=>p.source==='drawing').length===2;},'append recovered note');report.checks.push('Window-scope local note reopens exact vectors and attaches without replacing prior screenshot');

 await shell.click('#workspace-drawing');const finalOverlay=await until(async()=>{for(const p of await browser.pages())if(p.url().endsWith('/capture.html'))return p;},'shutdown capture');await finalOverlay.waitForFunction(()=>!document.querySelector('#draw-start').disabled);await finalOverlay.click('#draw-start');await finalOverlay.waitForSelector('.drawing-area',{visible:true});const finalBounds=await finalOverlay.$eval('.drawing-area',n=>n.getBoundingClientRect().toJSON());await finalOverlay.mouse.move(finalBounds.x+30,finalBounds.y+30);await finalOverlay.mouse.down();await finalOverlay.mouse.move(finalBounds.x+80,finalBounds.y+80);await finalOverlay.mouse.up();
 for(const p of await browser.pages())if(await p.evaluate(()=>window.__workspaceScope?.role==='detached').catch(()=>false))await call(p,'session.requestClose');
 const normalExit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));await call(shell,'session.requestClose').catch(()=>{});report.normalExit=await Promise.race([normalExit,pause(15000).then(()=>null)]);assert.deepEqual(report.normalExit,{code:0,signal:null});const captureDir=path.join(fixture.profile,'nozeli','drawing-captures');const drafts=await Promise.all((await fs.readdir(captureDir)).filter(n=>n.endsWith('.drawing.json')).map(async n=>JSON.parse(await fs.readFile(path.join(captureDir,n),'utf8'))));assert(drafts.some(d=>d.drawing.strokes.length===1));report.checks.push('Normal shutdown durably flushes the active drawing without auto delivery');
}catch(error){report.failure=error.stack;process.exitCode=1;
 report.failureWindows=await windows().catch(()=>null);report.failurePages=[];
 for(const page of await browser?.pages()||[]){report.failurePages.push(await page.evaluate(()=>({url:location.href,scope:window.__workspaceScope,ready:window.__nozeliReady,body:document.body.innerText.slice(-10000),rows:[...document.querySelectorAll('[data-managed-work]')].map(n=>({id:n.dataset.managedWork,html:n.innerHTML,bounds:n.getBoundingClientRect().toJSON()})),buttons:[...document.querySelectorAll('.managed-work-open')].map(n=>{const b=n.getBoundingClientRect();return {bounds:b.toJSON(),hit:document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.outerHTML};})})).catch(e=>({error:e.message})));}
 await shell?.screenshot({path:path.join(out,'failure-host.png')}).catch(()=>{});
}
finally{
 clearInterval(monitor);await monitorPending;
 await browser?.disconnect();if(child?.exitCode===null&&!child.signalCode){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),pause(5000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');}
 report.ok=!report.failure&&report.normalExit?.code===0;
 if(out){await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'main.log'),log);}await fs.rmdir(lock);console.log(JSON.stringify({out,ok:report.ok,checks:report.checks,failure:report.failure},null,2));
}
