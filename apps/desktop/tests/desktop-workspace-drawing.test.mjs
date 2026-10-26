// Parent-only serial smoke: node tests/desktop-workspace-drawing.test.mjs
// Real Git + host, synthetic durable history; no Worker inference, provider initialization or DOM injection.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
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
// ---- Opt-in responsiveness profiling (NOZELI_RESPONSIVENESS=1). ----------------------------
// Default runs are unchanged: profile() is a pass-through unless the flag is set, and it only
// wraps existing awaits with the shared test helper (no browser/IPC/clock overrides).
const PROFILE=process.env.NOZELI_RESPONSIVENESS==='1';
const responsiveness={records:[],profilerErrors:[],nodeElapsedMs:{},cycles:[],memory:null};
let measureResponsiveness,summarizeResponsiveness,observeProcessMemory;
if(PROFILE)({measureResponsiveness,summarizeResponsiveness,observeProcessMemory}=await import(path.join(source,'tests','responsiveness-metrics.fixture.mjs')).catch(error=>{throw Error('NOZELI_RESPONSIVENESS=1 requires tests/responsiveness-metrics.fixture.mjs: '+error.message);}));
async function profile(context,label,action){
 if(!PROFILE)return action();
 const started=performance.now(),before=responsiveness.records.length;
 try{
  const returned=await measureResponsiveness(context,label,action,responsiveness.records);
  if(responsiveness.records.length===before)throw Error('responsiveness helper produced no record for '+label);
  return returned;
 }catch(error){
  if(responsiveness.records.length>before&&responsiveness.records.at(-1)?.label===label)responsiveness.records.at(-1).profilerError=String(error?.message||error);
  responsiveness.profilerErrors.push({label,error:String(error?.stack||error)});throw error;
 }finally{if(responsiveness.records.length>before)responsiveness.nodeElapsedMs[label]=Math.round(performance.now()-started);}
}
const isColdLabel=label=>/cold|restart|shutdown/i.test(label);
function attachResponsiveness(extra={}){
 if(!PROFILE)return;
 const by=fn=>{const map={};for(const r of responsiveness.records)(map[fn(r.label)]??=[]).push(r);return map;};
 const group=rows=>rows.length?summarizeResponsiveness(rows):null;
 report.responsiveness={
  enabled:true,flag:'NOZELI_RESPONSIVENESS=1',measurements:responsiveness.records.length,
  summaries:{overall:group(responsiveness.records),cold:group(responsiveness.records.filter(r=>isColdLabel(r.label))),warm:group(responsiveness.records.filter(r=>!isColdLabel(r.label)))},
  phases:Object.fromEntries(Object.entries(by(l=>l.split('/')[0])).map(([k,v])=>[k,summarizeResponsiveness(v)])),
  cycles:responsiveness.cycles,records:responsiveness.records,nodeElapsedMsByLabel:responsiveness.nodeElapsedMs,memory:responsiveness.memory,
  errors:{renderer:report.errors,profiler:responsiveness.profilerErrors,...extra},
  limits:['Node elapsedMs includes CDP round trips and wait polling; it is not pure paint latency.','Linux Wayland software rendering, single display; other platforms out of scope.','Heap/DOM columns and descendant sum RSS are descriptive observations, not a leak verdict; no leak absence is claimed.',(responsiveness.memory?.boundary)||''],};
}
const observedProcesses=new Map();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=12000){
 const end=Date.now()+timeout;
 do{if(launchError)throw launchError;if(child&&(child.exitCode!==null||child.signalCode))throw Error('Product exited: '+log);if(monitorError)throw monitorError;const value=await fn();if(value)return value;await pause(60);}while(Date.now()<end);
 throw Error('Timeout: '+label);
}
async function call(page,op,payload={}){const result=await page.evaluate((op,payload)=>window.nozeli.invoke(op,payload),op,payload);assert(result.ok,op+': '+JSON.stringify(result.error));return result.value;}
async function scoped(kind,relPath){return until(async()=>{for(const page of await browser.pages()){const scope=await page.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope&&(kind==='shell'?scope.role==='shell':scope.role==='surface'&&scope.kind===kind&&scope.projectId===fixture.a.id)&&(!relPath||scope.relPath===relPath)&&await page.evaluate(()=>window.__nozeliReady===true))return {page,scope};}},'ready '+kind);}
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
 await fs.writeFile(path.join(fixture.project,'peer.txt'),'Peer original text.\n');
 // A live business Work with a persisted result, but no native thread/provider. Do not execute it.
 const c=await Controller.open({storage:fixture.storage,projectId:fixture.a.id,runtimeRoot:fixture.runtimeRoot,contentRoot:fixture.project});
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
 report.runtime={binary,source,userAgent:await browser.userAgent(),platform:process.platform,arch:process.arch,devicePixelRatio:await shell.evaluate(()=>devicePixelRatio)};
 if(await shell.$eval('#configuration-setup',n=>n.open)){await shell.click('#configuration-cancel');await shell.waitForFunction(()=>!document.querySelector('#configuration-setup').open);}
 if(await shell.$eval('#settings-dialog',n=>n.open))await shell.click('#settings-close');
 await shell.waitForSelector('[data-project-id="'+fixture.a.id+'"]',{visible:true});await shell.click('[data-project-id="'+fixture.a.id+'"]');
 await until(async()=>(await call(shell,'workspace.bootstrap')).projectId===fixture.a.id,'project binding');
 const initial=await snapshot(),baseline=execution(initial.state);assert.deepEqual(baseline.providers,{});assert.deepEqual(baseline.agents,[]);assert.deepEqual(baseline.residents,{});assert.deepEqual(baseline.workThreads,[]);await offline(baseline);
 report.initialExecution=baseline;
 await shell.locator('[data-managed-todo="'+todo.id+'"]').click();const coldReport=await scoped('report');await visible(coldReport.scope.viewId);await coldReport.page.waitForSelector('.isolated-report',{visible:true});
 const coldGuest=await isolatedReport(coldReport.page,receipt.objectId);
 await shell.click('.workspace-pane:has([data-view-id="'+coldReport.scope.viewId+'"]) [data-workspace-command="floatOpen"]');await until(async()=>{const list=await windows();return list.length===2&&list.every(w=>w.visible)&&list.some(w=>w.id!=='main'&&w.surfaces.some(s=>s.visible));},'second native window');
 const reportWindowId=(await windows()).find(window=>window.surfaces.some(surface=>surface.viewId===coldReport.scope.viewId)).id;
 await shell.waitForSelector('#file-tree button[data-path="peer.txt"]');await shell.click('#file-tree button[data-path="peer.txt"]');
 const peer=await scoped('document','peer.txt');await visible(peer.scope.viewId);
 await shell.click('.workspace-pane:has([data-view-id="'+peer.scope.viewId+'"]) [data-workspace-command="floatOpen"]');
 await until(async()=>(await windows()).length===3,'independent native document window');
 await shell.waitForSelector('#file-tree button[data-path="reading.txt"]');await shell.click('#file-tree button[data-path="reading.txt"]');
 const reading=await scoped('document','reading.txt');await visible(reading.scope.viewId);
 await shell.click('#open-settings');await shell.waitForSelector('#settings-dialog[open]',{visible:true});
 const sensitive=await shell.evaluate(projectId=>window.nozeli.invoke('workspace.capture.begin',{projectId}),fixture.a.id);
 assert.equal(sensitive.ok,false,'an open settings surface must refuse pixel capture');
 await shell.click('#settings-close');await visible(reading.scope.viewId);
 report.checks.push('The initiating window refuses capture while its real settings panel is open');
 // Simplified flow: one click freezes the initiating window only; dialog and
 // editor live in the shell renderer itself (no capture.html overlay page).
 await profile(shell, 'entry/snapshot-editor-ready-cold', async () => {
  await shell.click('#workspace-drawing');
  await shell.waitForSelector('dialog[aria-label="工作面涂鸦"] .drawing-area',{visible:true});
 });
 const snapshotSession=await call(shell,'workspace.capture.begin',{projectId:fixture.a.id});
 assert.equal(snapshotSession.tiles.length,1,'initiating window only');
 assert.equal((await windows()).length,3,'other same-project windows stay alive but are never captured');assert.equal(snapshotSession.omittedWindowCount,2);
 assert(snapshotSession.tiles[0].layers.length>=1,'frozen layers present');
 assert(snapshotSession.sources.some(s=>s.locationStatus==='viewport-only'),'static viewport-only sources');
 const peerText='Peer file saved while drawing in another native window.\n',mod=process.platform==='darwin'?'Meta':'Control';
 const peerEditor='#text-host .cm-content, #text-host .monaco-editor textarea.inputarea';
 await peer.page.waitForSelector(peerEditor,{visible:true});await peer.page.click(peerEditor);
 await peer.page.keyboard.down(mod);await peer.page.keyboard.press('a');await peer.page.keyboard.up(mod);await peer.page.keyboard.type(peerText);
 await peer.page.keyboard.down(mod);await peer.page.keyboard.press('s');await peer.page.keyboard.up(mod);
 await until(async()=>await fs.readFile(path.join(fixture.project,'peer.txt'),'utf8')===peerText,'peer document save while drawing');
 assert.equal(await shell.$eval('dialog[aria-label="工作面涂鸦"]',dialog=>dialog.open),true);
 assert(!snapshotSession.sources.some(source=>source.relPath==='peer.txt'),'the edited peer window is excluded from frozen sources');
 report.checks.push('A different native window physically edits and saves a real file while this window keeps drawing open');
 await shell.screenshot({path:path.join(out,'capture-native-preview.png')});
 const firstBounds=await shell.$eval('dialog[aria-label="工作面涂鸦"] .drawing-area',n=>n.getBoundingClientRect().toJSON());
 await profile(shell, 'stroke/first-gesture', async () => {
  await shell.mouse.move(firstBounds.x+firstBounds.width*.2,firstBounds.y+firstBounds.height*.4);await shell.mouse.down();await shell.mouse.move(firstBounds.x+firstBounds.width*.6,firstBounds.y+firstBounds.height*.6,{steps:20});await shell.mouse.up();
 });
 await shell.screenshot({path:path.join(out,'drawing-stroke.png')});
 await profile(shell, 'finish/local-card-cold', async () => {
  await shell.click('dialog[aria-label="工作面涂鸦"] #snapshot-drawing-finish');
  await shell.waitForSelector('[aria-label="位置讨论卡"]',{visible:true});
  assert.equal((await snapshot()).state.jobs.length,initial.state.jobs.length,'opening local discussion never sends');
  await shell.type('[aria-label="讨论说明"]','请解释这里的红色标记。');
 });

 // Direct 发送讨论 is gated by agent readiness (shared discussion layer): with
 // no configured agent the card refuses the handoff, keeps the question
 // editable, commits nothing and dispatches nothing — the draft path below
 // still works unchanged afterwards.
 const gateReceiptFile=path.join(await fixture.storage.recoveryDirectory(fixture.a.id),'drawing-captures',snapshotSession.captureId+'.result.json');
 assert(!await fs.stat(gateReceiptFile).then(()=>true,()=>false),'no receipt exists before any handoff');
 await shell.evaluate(()=>[...document.querySelectorAll('[aria-label="位置讨论卡"] button')].find(b=>b.textContent==='发送讨论').click());
 await shell.waitForFunction(()=>{const line=document.querySelector('[aria-label="位置讨论卡"] .snapshot-card-status');return line&&line.textContent.includes('发送未发出');},{timeout:10000});
 assert.equal(await shell.$eval('[aria-label="讨论说明"]',node=>node.value),'请解释这里的红色标记。','a refused direct send keeps the question editable');
 assert.equal(await shell.$eval('[aria-label="位置讨论卡"]',node=>node.querySelector('.snapshot-card-send').disabled),false,'the refused card stays retryable');
 assert.equal((await snapshot()).state.jobs.length,initial.state.jobs.length,'a refused direct send dispatches no work');
 assert(!await fs.stat(gateReceiptFile).then(()=>true,()=>false),'a refused direct send persists no capture receipt');
 report.checks.push('Direct send is refused by the shared agent gate without committing or dispatching anything');
 await shell.screenshot({path:path.join(out,'drawing-local-discussion.png')});
 await shell.evaluate(()=>[...document.querySelectorAll('[aria-label="位置讨论卡"] button')].find(b=>b.textContent==='加入对话草稿').click());
 const chat=await scoped('conversation');await chat.page.waitForSelector('.cm-chip',{visible:true});
 const materials=await chat.page.evaluate(()=>window.__composerMaterials.snapshotPersist());
 assert.equal(materials.pending.filter(p=>p.source==='drawing').length,1);
 assert(materials.pending.find(p=>p.source==='drawing').sources.length>=1,'static sources ride along with the image');
 assert.equal(materials.pending.find(p=>p.source==='drawing').frozenText,'请解释这里的红色标记。');
 assert((await chat.page.evaluate(()=>__composerMaterials.snapshot().text)).includes('请解释这里的红色标记。'));
 assert.equal((await snapshot()).state.jobs.length,initial.state.jobs.length,'no model job created');
 report.checks.push('Single-window freeze, in-page pointer drawing and offline attachment with static sources verified');
 await chat.page.screenshot({path:path.join(out,'drawing-offline-draft.png')});

 // Fault injection is confined to this synthetic profile: recipient persistence
 // succeeded, but the capture result acknowledgement was lost before restart.
 report.stage='pending-delivery-recovery';
 const receiptFile=path.join(await fixture.storage.recoveryDirectory(fixture.a.id),'drawing-captures',snapshotSession.captureId+'.result.json');
 const delivered=JSON.parse(await fs.readFile(receiptFile,'utf8'));assert.equal(delivered.state,'delivered');
 await fs.writeFile(receiptFile,JSON.stringify({...delivered,state:'pending-delivery'}));
 await shell.click('#workspace-drawing');await shell.waitForSelector('dialog[aria-label="工作面涂鸦"] .drawing-area',{visible:true});
 await shell.waitForFunction(id=>[...document.querySelector('[aria-label="恢复未完成涂鸦"]').options].some(option=>option.value===id),{},snapshotSession.captureId);
 await profile(shell, 'recovery/pending-delivery-restore', async () => {
  await shell.select('[aria-label="恢复未完成涂鸦"]',snapshotSession.captureId);
  await shell.waitForFunction(()=>document.querySelectorAll('dialog[aria-label="工作面涂鸦"] .drawing-area svg polyline').length===1);
 });
 await shell.click('#snapshot-drawing-finish');await shell.waitForSelector('[aria-label="位置讨论卡"]',{visible:true});
 assert.equal(await shell.$eval('[aria-label="讨论说明"]',node=>node.value),'请解释这里的红色标记。');
 await shell.evaluate(()=>[...document.querySelectorAll('[aria-label="位置讨论卡"] button')].find(button=>button.textContent==='加入对话草稿').click());
 await shell.waitForFunction(()=>!document.querySelector('dialog[aria-label="工作面涂鸦"]').open);
 assert.equal((await chat.page.evaluate(()=>__composerMaterials.snapshotPersist())).pending.filter(item=>item.source==='drawing').length,1,'a recovered lost acknowledgement must not duplicate the original attachment');
 assert.equal(JSON.parse(await fs.readFile(receiptFile,'utf8')).state,'delivered');
 report.checks.push('Real pending-delivery recovery keeps the original question and receipt without duplicating the existing frontdesk attachment');

 // Local save finishes into a local record without touching the conversation.
 report.stage='local-second';await profile(shell, 'entry/snapshot-editor-open', async () => {
  await shell.click('#workspace-drawing');
  await shell.waitForSelector('dialog[aria-label="工作面涂鸦"] .drawing-area',{visible:true});
 });
 const secondBounds=await shell.$eval('dialog[aria-label="工作面涂鸦"] .drawing-area',n=>n.getBoundingClientRect().toJSON());
 await profile(shell, 'stroke/second', async () => {
  await shell.mouse.move(secondBounds.x+secondBounds.width*.3,secondBounds.y+secondBounds.height*.3);await shell.mouse.down();await shell.mouse.move(secondBounds.x+secondBounds.width*.5,secondBounds.y+secondBounds.height*.5,{steps:10});await shell.mouse.up();
 });
 await profile(shell, 'local-save/second', async () => {
  await shell.click('dialog[aria-label="工作面涂鸦"] #snapshot-drawing-finish');
  await shell.waitForSelector('[aria-label="位置讨论卡"]',{visible:true});
  await shell.type('[aria-label="讨论说明"]','本地保留的问题');
  await shell.evaluate(()=>[...document.querySelectorAll('[aria-label="位置讨论卡"] button')].find(b=>b.textContent==='仅保存本地').click());
  await shell.waitForFunction(()=>!document.querySelector('dialog[aria-label="工作面涂鸦"]').open);
 });
 const afterLocal=await chat.page.evaluate(()=>__composerMaterials.snapshotPersist());
 assert.equal(afterLocal.pending.filter(p=>p.source==='drawing').length,1,'local save must not touch the conversation draft');
 report.checks.push('Window-scope local note saved without attaching to conversation');

 // Lightweight recovery reopens the saved local record with its strokes.
 report.stage='recovery-open';await shell.click('#workspace-drawing');
 await shell.waitForSelector('dialog[aria-label="工作面涂鸦"] .drawing-area',{visible:true});
 await shell.waitForFunction(()=>[...document.querySelector('[aria-label="恢复未完成涂鸦"]').options].some(o=>o.textContent.startsWith('本地记录')));
 const localId=await shell.$eval('[aria-label="恢复未完成涂鸦"]',n=>[...n.options].find(o=>o.textContent.startsWith('本地记录')).value);
 await profile(shell, 'recovery/open-local-record', async () => {
  await shell.select('[aria-label="恢复未完成涂鸦"]',localId);
  await shell.waitForFunction(()=>{const svg=document.querySelector('dialog[aria-label="工作面涂鸦"] .drawing-area svg');return svg&&svg.querySelectorAll('path,polyline,line').length===1;});
 });
 await shell.screenshot({path:path.join(out,'drawing-recovered.png')});
 report.checks.push('Saved local record reopens with exact vectors');
 await shell.click('#snapshot-drawing-finish');await shell.waitForSelector('[aria-label="位置讨论卡"]',{visible:true});
 const revisedQuestion='修订后的本地问题';await shell.click('[aria-label="讨论说明"]');await shell.keyboard.down(mod);await shell.keyboard.press('a');await shell.keyboard.up(mod);await shell.keyboard.type(revisedQuestion);
 await profile(shell, 'back-to-drawing/return-to-ink', async () => {
  await shell.click('aria/返回笔迹');await shell.waitForSelector('dialog[aria-label="工作面涂鸦"] .drawing-area',{visible:true});
 });
 const revisedBounds=await shell.$eval('dialog[aria-label="工作面涂鸦"] .drawing-area',node=>node.getBoundingClientRect().toJSON());
 await shell.mouse.move(revisedBounds.x+revisedBounds.width*.7,revisedBounds.y+revisedBounds.height*.2);await shell.mouse.down();await shell.mouse.move(revisedBounds.x+revisedBounds.width*.8,revisedBounds.y+revisedBounds.height*.5,{steps:8});await shell.mouse.up();
 await profile(shell, 'recovery/return-finish-card', async () => {
  await shell.click('#snapshot-drawing-finish');await shell.waitForSelector('[aria-label="位置讨论卡"]',{visible:true});
 });
 assert.equal(await shell.$eval('[aria-label="讨论说明"]',node=>node.value),revisedQuestion,'returning to ink and finishing again keeps the newest recovered question');
 const revisedSession=await call(shell,'workspace.capture.begin',{projectId:fixture.a.id});
 await profile(shell, 'local-save/revised', async () => {
  await shell.click('aria/仅保存本地');await shell.waitForFunction(()=>!document.querySelector('dialog[aria-label="工作面涂鸦"]').open);
 });
 const captureDirectory=path.join(await fixture.storage.recoveryDirectory(fixture.a.id),'drawing-captures');
 const oldQuestion=JSON.parse(await fs.readFile(path.join(captureDirectory,localId+'.drawing.json'),'utf8')).target.card.message;
 const revisedDraft=JSON.parse(await fs.readFile(path.join(captureDirectory,revisedSession.captureId+'.drawing.json'),'utf8'));
 assert.equal(oldQuestion,'本地保留的问题');assert.equal(revisedDraft.target.card.message,revisedQuestion);assert.equal(revisedDraft.drawing.strokes.length,2);
 report.checks.push('Recovered question edits survive return-to-ink and another stroke; the previous local record remains unchanged');

 // Opt-in bounded repeated capture/draw/complete/local-save cycles (NOZELI_RESPONSIVENESS=1 only).
 // Per-cycle phases and node elapsed go to report.responsiveness.cycles; the count is bounded by
 // the documented 32-capture recovery store capacity, which the scenes above already consume.
 report.stage='profiling-cycles';
 if (PROFILE) {
  const configured = Math.min(10, Math.max(1, Number.parseInt(process.env.NOZELI_RESPONSIVENESS_CYCLES || '6', 10) || 6));
  const existingCaptures=(await fs.readdir(captureDirectory)).filter(name=>name.endsWith('.json')&&!/\.(drawing|result)\.json$/.test(name)).length;
  const cycles=Math.max(0,Math.min(configured,32-existingCaptures-4));
  report.responsivenessCycles = {configured, existingCaptures, executed: cycles, documentedCapacity: 32, ...(cycles < configured ? {note: 'cycle count bounded by the documented 32-capture recovery store capacity'} : {})};
  const memory = observeProcessMemory ? observeProcessMemory(child.pid) : null;
  try{
  for (let i = 1; i <= cycles; i++) {
   const tag = 'cycle-' + String(i).padStart(2, '0'), started = performance.now(), mark0 = Object.keys(responsiveness.nodeElapsedMs).length, row = {cycle: i, phases: {}};
   await profile(shell, tag + '/entry', async () => {
    await shell.click('#workspace-drawing');
    await shell.waitForSelector('dialog[aria-label="工作面涂鸦"] .drawing-area', {visible: true});
   });
   const bounds = await shell.$eval('dialog[aria-label="工作面涂鸦"] .drawing-area', n => n.getBoundingClientRect().toJSON());
   await profile(shell, tag + '/stroke', async () => {
    await shell.mouse.move(bounds.x+bounds.width*.15,bounds.y+bounds.height*.45);await shell.mouse.down();
    for(let segment=1;segment<=60;segment++){const t=segment/60;await shell.mouse.move(bounds.x+bounds.width*(.15+.7*t),bounds.y+bounds.height*(.45+.2*Math.sin(t*Math.PI*6)),{steps:3});}
    await shell.mouse.up();
   });
   await profile(shell, tag + '/finish-card', async () => {
    await shell.click('dialog[aria-label="工作面涂鸦"] #snapshot-drawing-finish');
    await shell.waitForSelector('[aria-label="位置讨论卡"]', {visible: true});
   });
   await profile(shell, tag + '/local-save', async () => {
    await shell.type('[aria-label="讨论说明"]', '响应性周期本地保存 ' + i);
    await shell.evaluate(() => [...document.querySelectorAll('[aria-label="位置讨论卡"] button')].find(button => button.textContent === '仅保存本地').click());
    await shell.waitForFunction(() => !document.querySelector('dialog[aria-label="工作面涂鸦"]').open);
   });
   row.phases = Object.fromEntries(Object.entries(responsiveness.nodeElapsedMs).slice(mark0));
   row.totalNodeMs = Math.round(performance.now() - started);
   responsiveness.cycles.push(row);
  }
  }finally{if(memory)responsiveness.memory=await memory.stop();}
  report.checks.push('profiling cycles: bounded repeated capture/draw/complete/local-save stayed within the 32-capture recovery store capacity');
 }

 // The detached chrome freezes its own report guest, never the main reading pane.
 report.stage='detached-drawing';
 const detached=await until(async()=>{for(const page of await browser.pages()){const state=await page.evaluate(()=>({scope:window.__workspaceScope,ready:window.__nozeliReady})).catch(()=>null);if(state?.ready&&state.scope?.role==='detached'&&state.scope.windowId===reportWindowId)return {page,scope:state.scope};}return null;},'ready detached report root');
 await detached.page.click('.workspace-pane-header',{button:'right'});
 await detached.page.waitForSelector('.nozeli-context-menu:not([hidden]) [data-command="drawing"]',{visible:true});
 await detached.page.click('.nozeli-context-menu:not([hidden]) [data-command="drawing"]');
 await profile(detached.page, 'entry/detached-editor', async () => {
  await detached.page.waitForSelector('dialog[aria-label="工作面涂鸦"] .drawing-area',{visible:true});
 });
 const detachedSession=await call(detached.page,'workspace.capture.begin',{projectId:fixture.a.id});
 assert.equal(detachedSession.tiles.length,1);assert.equal(detachedSession.tiles[0].id,detached.scope.windowId);
 assert(detachedSession.sources.some(source=>source.identity?.resource?.objectId===receipt.objectId),'immutable report guest provenance belongs to the detached capture');
 assert(!detachedSession.sources.some(source=>source.relPath==='reading.txt'),'main reading pane is excluded');
 const detachedBounds=await detached.page.$eval('dialog[aria-label="工作面涂鸦"] .drawing-area',node=>node.getBoundingClientRect().toJSON());
 await profile(detached.page, 'stroke/detached', async () => {
  await detached.page.mouse.move(detachedBounds.x+detachedBounds.width*.3,detachedBounds.y+detachedBounds.height*.3);await detached.page.mouse.down();await detached.page.mouse.move(detachedBounds.x+detachedBounds.width*.6,detachedBounds.y+detachedBounds.height*.5,{steps:12});await detached.page.mouse.up();
 });
 await profile(detached.page, 'finish-card/detached', async () => {
  await detached.page.click('#snapshot-drawing-finish');await detached.page.waitForSelector('[aria-label="位置讨论卡"]',{visible:true});
  await detached.page.type('[aria-label="讨论说明"]','独立报告窗的本地讨论');
 });
 await detached.page.screenshot({path:path.join(out,'detached-drawing-local-discussion.png')});
 await profile(detached.page, 'local-save/detached', async () => {
  await detached.page.evaluate(()=>[...document.querySelectorAll('[aria-label="位置讨论卡"] button')].find(button=>button.textContent==='仅保存本地').click());
  await detached.page.waitForFunction(()=>!document.querySelector('dialog[aria-label="工作面涂鸦"]').open);
 });
 assert.deepEqual((await chat.page.evaluate(()=>__composerMaterials.snapshotPersist())).pending,afterLocal.pending,'detached local discussion never replaces or appends the main draft');
 assert.equal((await snapshot()).state.jobs.length,initial.state.jobs.length,'detached completion never dispatches work');
 report.checks.push('Detached chrome captures its own immutable report guest; physical drawing opens a local card without touching the main draft or jobs');

 // A real failed atomic draft replacement must not turn a second Escape into discard.
 report.stage='retention-failure';await shell.click('#workspace-drawing');await shell.waitForSelector('dialog[aria-label="工作面涂鸦"] .drawing-area',{visible:true});
 const failedSession=await call(shell,'workspace.capture.begin',{projectId:fixture.a.id}),blockedDraft=path.join(captureDirectory,failedSession.captureId+'.drawing.json');
 const previousDraft=await fs.readFile(blockedDraft).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
 await fs.rm(blockedDraft,{force:true});await fs.mkdir(blockedDraft);
 try{

  const failureBounds=await shell.$eval('dialog[aria-label="工作面涂鸦"] .drawing-area',node=>node.getBoundingClientRect().toJSON());await shell.mouse.move(failureBounds.x+failureBounds.width*.55,failureBounds.y+failureBounds.height*.45);await shell.mouse.down();await shell.mouse.move(failureBounds.x+failureBounds.width*.7,failureBounds.y+failureBounds.height*.6,{steps:8});await shell.mouse.up();
 for(let attempt=0;attempt<2;attempt++){
 await shell.keyboard.press('Escape');await call(shell,'workspace.capture.begin',{projectId:fixture.a.id});
 await shell.waitForSelector('dialog[aria-label="工作面涂鸦"] .drawing-area',{visible:true,timeout:3000});
 assert.equal(await shell.$eval('dialog[aria-label="工作面涂鸦"]',dialog=>dialog.open),true,'failed retention leaves the same dialog open');
 assert.equal(await shell.$$eval('dialog[aria-label="工作面涂鸦"] .drawing-area svg polyline',nodes=>nodes.length),1,'failed Escape retains the visible editable stroke');
 }
 }finally{await fs.rm(blockedDraft,{recursive:true,force:true});if(previousDraft)await fs.writeFile(blockedDraft,previousDraft);}
 await shell.keyboard.press('Escape');await shell.waitForFunction(()=>!document.querySelector('dialog[aria-label="工作面涂鸦"]').open);
 assert.equal(JSON.parse(await fs.readFile(blockedDraft,'utf8')).drawing.strokes.length,1);
 report.checks.push('Two actual persistence failures keep ink and dialog editable; restoring storage permits a retained exit');

 // Unfinished drawing flushes on normal exit; strokes persist durably.
 report.stage='shutdown-flush';await profile(shell, 'entry/shutdown-flush', async () => {
  await shell.click('#workspace-drawing');
  await shell.waitForSelector('dialog[aria-label="工作面涂鸦"] .drawing-area',{visible:true});
 });
 const shutdownCapture=await call(shell,'workspace.capture.begin',{projectId:fixture.a.id});
 const finalBounds=await shell.$eval('dialog[aria-label="工作面涂鸦"] .drawing-area',n=>n.getBoundingClientRect().toJSON());
 await profile(shell, 'stroke/flush-gesture', async () => {
 await shell.mouse.move(finalBounds.x+finalBounds.width*.45,finalBounds.y+finalBounds.height*.45);await shell.mouse.down();await shell.mouse.move(finalBounds.x+finalBounds.width*.6,finalBounds.y+finalBounds.height*.6,{steps:5});await shell.mouse.up();
  await shell.waitForFunction(()=>document.querySelectorAll('dialog[aria-label="工作面涂鸦"] .drawing-area svg polyline').length===1);
 });
 for(const p of await browser.pages())if(await p.evaluate(()=>window.__workspaceScope?.role==='detached').catch(()=>false))await call(p,'session.requestClose');
 const normalExit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 await profile(shell, 'cold/normal-shutdown-exit', async () => {
  await call(shell,'session.requestClose').catch(()=>{});report.normalExit=await Promise.race([normalExit,pause(15000).then(()=>null)]);
 });
 assert.deepEqual(report.normalExit,{code:0,signal:null});
 const savedAtExit=JSON.parse(await fs.readFile(path.join(captureDirectory,shutdownCapture.captureId+'.drawing.json'),'utf8')).drawing;
 assert.equal(savedAtExit.width,shutdownCapture.width);assert.equal(savedAtExit.height,shutdownCapture.height);assert.equal(savedAtExit.strokes.length,1);
 const exitPoints=savedAtExit.strokes[0].points,start=exitPoints[0],end=exitPoints.at(-1);
 for(const [actual,expected] of [[start,[.45,.45]],[end,[.6,.6]]]){
 assert(Math.abs(actual[0]-expected[0])<=1/finalBounds.width&&Math.abs(actual[1]-expected[1])<=1/finalBounds.height,'the exact visible unfinished stroke survives normal shutdown');
 }
 report.checks.push('Normal shutdown durably flushes the active drawing without auto delivery');
}catch(error){report.failure=error.stack;process.exitCode=1;
 report.failureWindows=await windows().catch(()=>null);report.failurePages=[];
 for(const page of await browser?.pages()||[]){report.failurePages.push(await page.evaluate(()=>({url:location.href,scope:window.__workspaceScope,ready:window.__nozeliReady,body:document.body.innerText.slice(-10000),rows:[...document.querySelectorAll('[data-managed-work]')].map(n=>({id:n.dataset.managedWork,html:n.innerHTML,bounds:n.getBoundingClientRect().toJSON()})),buttons:[...document.querySelectorAll('.managed-work-open')].map(n=>{const b=n.getBoundingClientRect();return {bounds:b.toJSON(),hit:document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.outerHTML};})})).catch(e=>({error:e.message})));}
 await shell?.screenshot({path:path.join(out,'failure-host.png')}).catch(()=>{});
}
finally{
 clearInterval(monitor);await monitorPending;
 await browser?.disconnect();if(child?.exitCode===null&&!child.signalCode){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),pause(5000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');}
 report.ok=!report.failure&&report.normalExit?.code===0;
 attachResponsiveness({status: report.failure ? 'failed' : 'passed', normalExit: report.normalExit ?? null});
 if(out){await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'main.log'),log);}await fs.rmdir(lock);console.log(JSON.stringify({out,ok:report.ok,checks:report.checks,failure:report.failure,responsiveness:PROFILE?{measurements:responsiveness.records.length,cycles:responsiveness.cycles.length,profilerErrors:responsiveness.profilerErrors}:undefined},null,2));
}
