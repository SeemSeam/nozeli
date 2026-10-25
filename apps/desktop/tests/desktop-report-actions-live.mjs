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
const lock=path.join(os.tmpdir(),'nozeli-report-actions-live.lock');
await fs.mkdir(lock);
const report={checks:[],scenes:[],errors:[],evidence:'真实 Git 和真实宿主；预置合成历史，非 Worker 推理。',processEvidence:'Linux /proc sampled descendant processes; Electron renderer/utility processes are UI, not Agent processes.'};
let out,fixture,child,browser,shell,log='',launchError,monitor,monitorPending=Promise.resolve(),monitorError;
let explicitChat=false;
const observedProcesses=new Map();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=45000){
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
 if(await shell.$eval('#configuration-setup',n=>n.open)){await shell.click('#configuration-cancel');await shell.waitForFunction(()=>!document.querySelector('#configuration-setup').open);}
 await shell.waitForSelector('[data-project-id="'+fixture.a.id+'"]',{visible:true});await shell.click('[data-project-id="'+fixture.a.id+'"]');
 await until(async()=>(await call(shell,'workspace.bootstrap')).projectId===fixture.a.id,'project binding');
 const initial=await snapshot(),baseline=execution(initial.state);assert.deepEqual(baseline.providers,{});assert.deepEqual(baseline.agents,[]);assert.deepEqual(baseline.residents,{});assert.deepEqual(baseline.workThreads,[]);await offline(baseline);
 report.initialExecution=baseline;
 await shell.locator('[data-managed-todo="'+todo.id+'"]').click();const coldReport=await scoped('report');await visible(coldReport.scope.viewId);await coldReport.page.waitForSelector('.isolated-report',{visible:true});
 const coldGuest=await isolatedReport(coldReport.page,receipt.objectId);
 const coldColors=await coldGuest.page.evaluate(()=>({bg:getComputedStyle(document.body).backgroundColor,ink:getComputedStyle(document.body).color}));
 assert.deepEqual(coldColors,{bg:'rgb(34, 45, 58)',ink:'rgb(227, 234, 242)'});report.coldTheme=coldColors;
 await closeReport(coldReport.scope.viewId);await call(shell,'settings.appearance.save',{theme:'light',palette:'sage',font:'system',size:13});
 report.checks.push('Cold start honors saved explicit dark/slate for both the renderer and the frozen report guest');
 await call(shell,'session.resize',{width:1440,height:1000});
 const toggleTo=async(id,open)=>{if(await shell.$eval('#'+id,n=>n.getAttribute('aria-expanded')==='true')!==open)await shell.click('#'+id);};
 report.railMatrix=[];
 for(const [left,right]of [[true,true],[false,true],[true,false],[false,false]]){
  await toggleTo('file-toggle',left);await toggleTo('toggle-sidebar',right);
  const metrics=await shell.evaluate(()=>{const b=id=>document.getElementById(id).getBoundingClientRect();return{left:b('files').width,right:b('side').width,launcher:b('workspace-open-conversation').toJSON(),settings:b('open-settings').toJSON()};});
  if(!left)assert.equal(metrics.left,20);if(!right)assert.equal(metrics.right,20);assert(metrics.launcher.bottom<=metrics.settings.top+1);report.railMatrix.push({left,right,...metrics});
 }
 await toggleTo('file-toggle',true);await toggleTo('toggle-sidebar',true);
 await shell.focus('#open-settings');await shell.keyboard.down('Shift');await shell.keyboard.press('Tab');await shell.keyboard.up('Shift');
 assert.equal(await shell.evaluate(()=>document.activeElement.id),'workspace-open-conversation');
 const outline=await shell.$eval('#workspace-open-conversation',n=>({style:getComputedStyle(n).outlineStyle,width:getComputedStyle(n).outlineWidth}));assert.notEqual(outline.style,'none');assert(parseFloat(outline.width)>=2);
 await call(shell,'settings.appearance.save',{theme:'light',palette:'sage',font:'system',size:20});
 await call(shell,'session.resize',{width:590,height:800});await shell.waitForFunction(()=>document.getElementById('app').classList.contains('narrow-layout'));
 const narrowRail=await shell.evaluate(()=>{const r=document.getElementById('workspace-open-conversation').getBoundingClientRect(),s=document.getElementById('open-settings').getBoundingClientRect();return {r:r.toJSON(),s:s.toJSON(),width:innerWidth};});
 assert(narrowRail.r.left>=0&&narrowRail.r.right<=narrowRail.width&&narrowRail.r.bottom<=narrowRail.s.top+1);report.railMatrix.push({narrow:true,...narrowRail});
 await call(shell,'session.resize',{width:1440,height:1000});await shell.waitForFunction(()=>!document.getElementById('app').classList.contains('narrow-layout'));
 await call(shell,'settings.appearance.save',{theme:'light',palette:'sage',font:'system',size:13});await toggleTo('file-toggle',true);await toggleTo('toggle-sidebar',true);
 report.checks.push('Rail keyboard focus has a visible outline; all desktop collapse combinations and 590px/20px launcher/settings remain reachable without overlap');
 if(await shell.$eval('#file-toggle',n=>n.getAttribute('aria-expanded')!=='true'))await shell.click('#file-toggle');
 await shell.waitForSelector('#file-tree [data-path="reading.txt"]',{visible:true});await shell.click('#file-tree [data-path="reading.txt"]');
 const doc=await scoped('document');assert.equal(doc.scope.relPath,'reading.txt');await visible(doc.scope.viewId);await doc.page.waitForSelector('#text-host .cm-content',{visible:true});
 const editor=await doc.page.$('#text-host .cm-editor');await doc.page.click('#text-host .cm-content');await doc.page.keyboard.down('Control');await doc.page.keyboard.press('Home');await doc.page.keyboard.up('Control');await doc.page.keyboard.type('OFFLINE-UNSENT-EDITOR ');await doc.page.keyboard.down('Shift');for(let i=0;i<7;i++)await doc.page.keyboard.press('ArrowLeft');await doc.page.keyboard.up('Shift');
 const b=await doc.page.$eval('#text-host .cm-scroller',n=>n.getBoundingClientRect().toJSON());await doc.page.mouse.move(b.x+b.width/2,b.y+b.height/2);await doc.page.mouse.wheel({deltaY:550});await until(async()=>(await editorState(doc,editor)).scroll>0,'editor scroll');
 const before=await editorState(doc,editor);assert(before.sameEditor);assert(before.text.includes('OFFLINE-UNSENT-EDITOR'));assert.notEqual(before.selection.from,before.selection.to);assert.equal(before.drafts.frontdesk,'Preloaded main draft — never send');
 await capture('editor-before',doc.page,'#text-host .cm-editor',doc.scope.viewId);
 // Smooth switch: the next document may only become visible after it is ready,
 // and switching back must reuse the same native surface with unsaved edits intact.
 const docWebContents=(await windows()).flatMap(w=>w.surfaces).find(s=>s.viewId===doc.scope.viewId)?.webContentsId;
 const pageFor=async predicate=>{for(const p of await browser.pages()){if(await p.evaluate(predicate).catch(()=>false))return p;}return null;};
 let switchViolation=null;
 await shell.click('#file-tree [data-path="retained change.txt"]');
 await until(async()=>{
  const next=(await windows()).flatMap(w=>w.surfaces).find(s=>s.relPath==='retained change.txt');
  if(!next?.visible)return false;
  const state=await (await pageFor(()=>window.__workspaceScope?.role==='surface'&&window.__workspaceScope?.relPath==='retained change.txt'))?.evaluate(()=>({ready:window.__nozeliReady===true,shell:document.body.innerText.includes('未打开项目')})).catch(()=>null);
  if(!state?.ready||state?.shell)switchViolation=state;
  return true;
 },'switched document becomes visible');
 assert.equal(switchViolation,null,'a surface must never be visible before it is ready: '+JSON.stringify(switchViolation));
 await shell.click('#file-tree [data-path="reading.txt"]');
 await until(async()=>(await windows()).flatMap(w=>w.surfaces).some(s=>s.viewId===doc.scope.viewId&&s.visible),'original document visible again');
 assert.equal((await windows()).flatMap(w=>w.surfaces).find(s=>s.viewId===doc.scope.viewId)?.webContentsId,docWebContents,'switching back must reuse the same native surface');
 const afterSwitch=await editorState(doc,editor);
 assert(afterSwitch.text.includes('OFFLINE-UNSENT-EDITOR'),'unsent edits survive switching documents');
 report.checks.push('document switch shows new content only after ready and preserves the previous surface with unsaved edits');
 // Document theme follows the effective appearance without touching editor state.
 const themeState=async()=>doc.page.$eval('#text-host .cm-editor',n=>{const s=getComputedStyle(n);return {bg:s.backgroundColor,color:s.color,caret:s.caretColor};});
 await call(shell,'settings.appearance.save',{theme:'dark',palette:'slate',font:'system',size:13});
 const darkTheme=await themeState();
 assert.equal(darkTheme.bg,'rgb(34, 45, 58)','CodeMirror paper must follow dark slate');
 assert.equal(darkTheme.color,'rgb(227, 234, 242)','CodeMirror ink must follow dark slate');
 await call(shell,'settings.appearance.save',{theme:'light',palette:'sage',font:'system',size:13});
 const lightTheme=await themeState();
 assert.equal(lightTheme.bg,'rgb(255, 254, 250)','CodeMirror paper must return to sage light');
 const afterTheme=await editorState(doc,editor);
 const selRule=await doc.page.evaluate(()=>{const out=[];const scan=ss=>{try{for(const r of ss.cssRules){if(r.selectorText&&r.selectorText.includes('cm-selectionBackground')&&r.style?.backgroundColor)out.push(r.selectorText+' => '+r.style.backgroundColor);if(r.cssRules)scan(r);}}catch{}};for(const ss of document.styleSheets)scan(ss);for(const ss of document.adoptedStyleSheets??[])scan(ss);return out;});
 assert(selRule.some(rule=>rule.includes('var(--doc-selection)')),'selection theme must own the selection layer background: '+JSON.stringify(selRule));
 assert.equal(afterTheme.scroll,before.scroll,'theme switching must not scroll the editor');
 assert.deepEqual(afterTheme.drafts,before.drafts,'theme switching must not trigger saves or draft changes');
 report.checks.push('editor document colors follow the live appearance switch without touching editor state');
 // Dock regression: button float and host drag-float must both return the view
 // to a visible pane in the main window.
 const detachedRootFor=async()=>{for(let i=0;i<200;i++){for(const p of await browser.pages()){if(await p.evaluate(()=>window.__workspaceScope?.role==='detached'&&window.__nozeliReady).catch(()=>false))return p;}await new Promise(r=>setTimeout(r,50));}throw Error('detached root missing');};
 await shell.click('.workspace-pane:has([data-view-id="'+doc.scope.viewId+'"]) [data-workspace-command="floatOpen"]');
 let docDetached=await detachedRootFor();
 let dockPoint=await docDetached.$eval('[data-workspace-command="dock"]',n=>{const b=n.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};});
 await docDetached.mouse.click(dockPoint.x,dockPoint.y);
 await until(async()=>{const l=await windows();return l.length===1&&l[0].surfaces.some(s=>s.viewId===doc.scope.viewId&&s.visible);},'button-floated document docks back visible');
 const dragBegin=await shell.evaluate(viewId=>window.nozeli.invoke('workspace.drag.begin',{viewId,screenX:600,screenY:400}),doc.scope.viewId);
 assert(dragBegin.ok,'drag begin: '+JSON.stringify(dragBegin.error));
 await shell.evaluate(sessionId=>window.nozeli.invoke('workspace.drag.update',{sessionId,screenX:1800,screenY:350}),dragBegin.value.sessionId).catch(()=>{});
 const dragEnd=await shell.evaluate(sessionId=>window.nozeli.invoke('workspace.drag.end',{sessionId,screenX:1800,screenY:350,cancelled:false}),dragBegin.value.sessionId);
 assert(dragEnd.ok,'drag detach: '+JSON.stringify(dragEnd.error));
 await until(async()=>(await windows()).length===2,'drag detached the document');
 docDetached=await detachedRootFor();
 dockPoint=await docDetached.$eval('[data-workspace-command="dock"]',n=>{const b=n.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};});
 await docDetached.mouse.click(dockPoint.x,dockPoint.y);
 await until(async()=>{const l=await windows();return l.length===1&&l[0].surfaces.some(s=>s.viewId===doc.scope.viewId&&s.visible);},'drag-floated document docks back visible');
 report.checks.push('document button-float and drag-float both dock back into a visible pane');
 // Use a second real pane, keeping the original editor mounted and owned by its pane.
 await shell.click('.workspace-pane:has([data-view-id="'+doc.scope.viewId+'"]) .workspace-pane-title',{button:'right'});await shell.waitForSelector('#workspace-title-menu [data-command="split-x"]',{visible:true});await shell.click('#workspace-title-menu [data-command="split-x"]');
 const empty=await until(()=>shell.$$eval('.workspace-pane',nodes=>nodes.find(n=>!n.querySelector('[data-view-id]'))?.dataset.workspaceGroup),'empty pane');await shell.click('[data-workspace-group="'+empty+'"] .workspace-pane-title');
 const sideOpen=await shell.$eval('#app',n=>n.classList.contains('narrow-layout')?n.classList.contains('drawer-side-open'):!n.classList.contains('side-collapsed'));if(!sideOpen)await shell.click('#toggle-sidebar');
 report.stage='before-work-report-click';
 await monitorUI();monitor=setInterval(()=>{monitorPending=monitorPending.then(monitorUI).catch(e=>{monitorError=e;});},75);
 const workRow='[data-managed-work="'+work.id+'"]';await shell.waitForSelector(workRow+' .managed-work-open',{visible:true});
 const workItem=await shell.$eval(workRow,n=>({buttons:n.querySelectorAll('button').length,details:n.querySelectorAll('details').length,text:n.innerText,height:n.getBoundingClientRect().height}));assert.equal(workItem.buttons,1,'Work list has only its navigation entry');assert.equal(workItem.details,0,'No expandable operation card');assert(workItem.height<100,'Work entry remains compact');report.compactWorkItem=workItem;
 await capture('compact-work-list',shell,'#work-items');
 const openWorkMenu=async(via='keyboard')=>{if(via==='mouse')await shell.locator(workRow+' .managed-work-open').click({button:'right'});else{await shell.focus(workRow+' .managed-work-open');await shell.keyboard.down('Shift');await shell.keyboard.press('F10');await shell.keyboard.up('Shift');}await shell.waitForSelector('#managed-work-menu:not([hidden])',{visible:true});};
 await openWorkMenu('mouse');await shell.locator('#managed-work-menu [data-command="details"]').click();await shell.waitForSelector('#managed-agent-details[open] #managed-current-work:not([hidden])');assert.match(await shell.$eval('#managed-current-work',n=>n.innerText),/D3 离线成果工作/);await shell.locator('#managed-agent-details>button').click();
 
 await openWorkMenu();await shell.locator('#managed-work-menu [data-command="discard"]').click();await shell.waitForSelector('.managed-report-dialog[open]');assert.equal(await shell.evaluate(()=>document.activeElement.textContent),'取消');await shell.keyboard.press('Escape');assert.equal((await snapshot()).state.works.find(w=>w.id===work.id).status,'review');await offline(baseline);report.checks.push('Work list exposes details and dangerous cancellation only on demand; cancelled confirmation preserves Work and never connects');
 await openWorkMenu();await shell.locator('#managed-work-menu [data-command="terminal"]').click();
 const terminal=await scoped('terminal');await visible(terminal.scope.viewId);await terminal.page.waitForSelector('.work-terminal-preview',{visible:true});
 assert.match(await terminal.page.$eval('[role="status"]',n=>n.textContent),/未就绪|断开/);await offline(baseline);
 const forbidden=await terminal.page.evaluate(projectId=>window.nozeli.invoke('managed.send',{projectId,target:'frontdesk',text:'must not send'}),fixture.a.id);assert.equal(forbidden.ok,false);assert.equal(forbidden.error.code,'IPC_DENIED');
 await capture('terminal-preview-workspace',terminal.page,'.work-terminal-preview',terminal.scope.viewId);
 assert.match(await terminal.page.$eval('.work-terminal-preview-note',n=>n.textContent),/当前画面/);
 const termAnchor=await terminal.page.$eval('.work-terminal-preview-viewport',n=>({display:getComputedStyle(n).display,justify:getComputedStyle(n).justifyContent}));
 assert.deepEqual(termAnchor,{display:'flex',justify:'flex-end'},'terminal preview must bottom-anchor the current screen');
 assert.equal(await terminal.page.$eval('.work-terminal-preview-follow',n=>n.hidden),true,'follow bar starts hidden');
 const terminalBefore=(await windows()).flatMap(w=>w.surfaces).find(s=>s.viewId===terminal.scope.viewId);
 await shell.click('.workspace-pane:has([data-view-id="'+terminal.scope.viewId+'"]) .workspace-pane-title',{button:'right'});await shell.waitForSelector('#workspace-title-menu [data-command="split-y"]',{visible:true});await shell.click('#workspace-title-menu [data-command="split-y"]');
 const reportPane=await until(()=>shell.$$eval('.workspace-pane',nodes=>nodes.find(n=>!n.querySelector('[data-view-id]'))?.dataset.workspaceGroup),'empty report pane');await shell.click('[data-workspace-group="'+reportPane+'"] .workspace-pane-title');await offline(baseline);
 report.terminalPreview={scope:terminal.scope,surface:terminalBefore,forbidden};
 await shell.locator('[data-managed-todo="'+todo.id+'"]:not(:disabled)').click();
 const result=await scoped('report');await visible(result.scope.viewId);
 await visible(terminal.scope.viewId);await terminal.page.waitForSelector('.work-terminal-preview',{visible:true});await capture('terminal-alongside-report',terminal.page,'.work-terminal-preview',terminal.scope.viewId);report.checks.push('Terminal preview and report remain visible in separate native panes in the same window; input denied and absent PTY does not start a session');
 await result.page.waitForSelector('.isolated-report',{visible:true});
 const isolated=await isolatedReport(result.page,receipt.objectId);
// The frozen report follows the appearance through host-injected enum tokens;
// the frozen object bytes never change.
const objectDigestBefore=createHash('sha256').update(await fixture.storage.readObject(fixture.a.id,receipt.report.digest)).digest('hex');
await call(shell,'settings.appearance.save',{theme:'dark',palette:'slate',font:'system',size:13});
await until(async()=>{try{return await isolated.page.evaluate(()=>{const s=getComputedStyle(document.body);const r=getComputedStyle(document.documentElement);return s.backgroundColor+'|'+s.color+'|'+r.getPropertyValue('--nozeli-link').trim();});}catch{return null;}},'report guest restyles to dark slate').then(value=>assert.equal(value,'rgb(34, 45, 58)|rgb(227, 234, 242)|#a4c7ed','report must follow palette+mode via host tokens: '+value));
await call(shell,'settings.appearance.save',{theme:'light',palette:'sage',font:'system',size:13});
await until(async()=>{try{return await isolated.page.evaluate(()=>getComputedStyle(document.body).backgroundColor);}catch{return null;}},'report guest restores sage light').then(value=>assert.equal(value,'rgb(255, 254, 250)','report must restore sage light: '+value));
assert.equal(createHash('sha256').update(await fixture.storage.readObject(fixture.a.id,receipt.report.digest)).digest('hex'),objectDigestBefore,'frozen report bytes must not change with theme');
report.checks.push('frozen report restyles live from host enum tokens while object bytes stay frozen');

 await capture('frozen-html-actual-guest',isolated.page,'body',result.scope.viewId,isolated.scope);
 await result.page.waitForFunction(()=>!document.querySelector('[data-managed-end-result]').disabled);
 assert.equal(await result.page.$eval('[data-report-state]',n=>n.innerText),'待审阅 · 第 1 版');
 assert.equal(await result.page.$eval('[data-managed-end-result]',n=>n.dataset.uiAction),'primary');
 assert.equal(await result.page.$eval('#managed-doc',n=>n.innerText.includes('控制器尚未就绪')),false);
 assert.equal(await result.page.$('[data-todo-detail]'),null);
 assert.equal(await result.page.$('.isolated-report .isolated-controls'),null);
 await assertReportHeight(result.page,'normal');
 await capture('report-footer',result.page,'#managed-result-actions',result.scope.viewId);
 const more='.workspace-pane:has([data-view-id="'+result.scope.viewId+'"]) [data-workspace-command="more"]';
 async function openMore(){await shell.click(more);await result.page.waitForSelector('#managed-report-menu:not([hidden])',{visible:true});}
 await openMore();await capture('report-more',result.page,'#managed-report-menu',result.scope.viewId);
 await until(async()=>{const key=await result.page.$eval('.isolated-viewport',n=>n.dataset.previewKey);const s=await call(result.page,'isolated-preview.snapshot',{key});return s;},'isolated still owned while overlay');
 await result.page.keyboard.press('End');assert.equal(await result.page.evaluate(()=>document.activeElement.dataset.command),'discard');
 await result.page.keyboard.press('Home');assert.equal(await result.page.evaluate(()=>document.activeElement.dataset.command),'save');
 await result.page.keyboard.press('Escape');await until(()=>shell.$eval(more,n=>document.activeElement===n),'title more keyboard focus restored');
 await openMore();
 await result.page.click('#managed-report-menu [data-command="copy"]');
 const original=await fixture.storage.readObject(fixture.a.id,receipt.report.digest).then(bytes=>bytes.toString('utf8'));
 const clipboard=await until(async()=>{const value=await call(result.page,'document.clipboard',{action:'read'});return (typeof value==='string'?value:value.text)===original?value:null;},'frozen HTML copied exactly');
 report.clipboard=clipboard;
 await openMore();await result.page.click('#managed-report-menu [data-command="todo"]');
 await result.page.waitForSelector('.managed-report-dialog[open]',{visible:true});
 assert.equal(await result.page.$eval('[data-todo-detail]',n=>n.dataset.todoDetail),todo.id);
 await capture('todo-details',result.page,'.managed-report-dialog',result.scope.viewId);
 assert(await visible(result.scope.viewId),'trusted report surface stays visible over inner report');
 await result.page.keyboard.press('Escape');await result.page.waitForSelector('.managed-report-dialog',{hidden:true});
 const guestBody=await isolated.page.$('body');let guestNavigations=0;
 isolated.page.on('framenavigated',frame=>{if(frame===isolated.page.mainFrame())guestNavigations++;});
 await isolated.page.click('#persistent-detail summary');
 await isolated.page.evaluate(()=>{const range=document.createRange();range.selectNodeContents(document.getElementById('state-marker'));getSelection().removeAllRanges();getSelection().addRange(range);window.scrollTo(0,180);});
 const guestReadState=async()=>isolated.page.evaluate(()=>({text:document.body.innerText.includes('OFFLINE-RESULT-CONTENT-67291'),selected:getSelection().toString(),open:document.getElementById('persistent-detail').open,scroll:scrollY,documentStart:performance.timeOrigin}));
 const guestBefore=await guestReadState();assert(guestBefore.scroll>0);assert.equal(guestBefore.selected,'REPORT-STATE-MARKER');
 // Detached window: real pointer events must reach title buttons (no native drag capture).
 await shell.click('.workspace-pane:has([data-view-id="'+result.scope.viewId+'"]) [data-workspace-command="floatOpen"]');
 const detachedRoot=await (async()=>{for(let i=0;i<200;i++){for(const p of await browser.pages()){if(await p.evaluate(()=>window.__workspaceScope?.role==='detached'&&window.__nozeliReady).catch(()=>false))return p;}await new Promise(r=>setTimeout(r,50));}throw Error('detached root missing');})();
 const detachedScope=await detachedRoot.evaluate(()=>window.__workspaceScope);await call(detachedRoot,'workspace.windows.focus',{projectId:fixture.a.id,windowId:detachedScope.windowId});await detachedRoot.bringToFront();await detachedRoot.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const morePoint=await detachedRoot.$eval('[data-workspace-command="more"]',n=>{const b=n.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2,region:getComputedStyle(n).webkitAppRegion};});
 assert.equal(morePoint.region,'no-drag','detached report actions must not sit in the native drag region');
 await detachedRoot.mouse.click(morePoint.x,morePoint.y);
 await result.page.waitForSelector('#managed-report-menu:not([hidden])',{visible:true,timeout:10000});
 assert.match(await result.page.$eval('#managed-report-menu',n=>n.innerText),/另存报告到项目/);
 await result.page.keyboard.press('Escape');
 const reportDockPoint=await detachedRoot.$eval('[data-workspace-command="dock"]',n=>{const b=n.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2,region:getComputedStyle(n).webkitAppRegion};});
 assert.equal(reportDockPoint.region,'no-drag','detached dock must not sit in the native drag region');
 await detachedRoot.mouse.click(reportDockPoint.x,reportDockPoint.y);
 await until(async()=>{const list=await windows();return list.length===1&&list[0].surfaces.some(s=>s.viewId===result.scope.viewId&&s.visible);},'report docked back into the single main window');
 const guestAfter=await guestReadState();assert.equal(guestAfter.documentStart,guestBefore.documentStart);assert.equal(guestAfter.text,true);assert.equal(guestAfter.selected,guestBefore.selected);assert.equal(guestAfter.open,true);assert(Math.abs(guestAfter.scroll-guestBefore.scroll)<=1,'report scroll survives detach/dock');assert.equal(guestNavigations,0);
 assert.equal(await isolated.page.$eval('body',(n,old)=>n===old,guestBody),true,'same report document node survives transfer');
 const currentGuest=await call(result.page,'isolated-preview.snapshot',{key:isolated.scope.preview.key});assert.equal(currentGuest.origin,isolated.scope.preview.origin);assert.equal(currentGuest.generation,isolated.scope.preview.generation);
 await isolated.page.screenshot({path:path.join(out,'report-guest-after-dock.png')});report.reportTransfer={before:guestBefore,after:guestAfter,navigations:guestNavigations,origin:currentGuest.origin};await guestBody.dispose();
 assert(await visible(doc.scope.viewId),'docking the report back must not displace the active document pane');
 // Returning into a constrained main window must fill its single visible pane,
 // not retain the percentage basis from the former split ancestry.
 await shell.click('.workspace-pane:has([data-view-id="'+result.scope.viewId+'"]) [data-workspace-command="floatOpen"]');
 const narrowDetached=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__workspaceScope?.role==='detached'&&window.__nozeliReady).catch(()=>false))return p;},'second report detached root');
 await call(shell,'session.resize',{width:590,height:650});
 await shell.waitForFunction(()=>innerWidth===590);
 await narrowDetached.click('[data-workspace-command="dock"]');
 await until(async()=>narrowDetached.isClosed(),'narrow report return closes detached chrome');
 await visible(result.scope.viewId);
 await shell.waitForFunction(viewId=>{
   const host=document.querySelector('#workspace-groups'),tree=host.querySelector('.workspace-tree'),pane=host.querySelector('.workspace-pane.is-focused'),content=pane?.querySelector('[data-view-id]');
   if(!host.classList.contains('workspace-narrow')||content?.dataset.viewId!==viewId)return false;
   const a=tree.getBoundingClientRect(),b=pane.getBoundingClientRect();
   return Math.abs(a.width-b.width)<=2&&Math.abs(a.height-b.height)<=2;
 },{},result.scope.viewId);
 const narrowGuest=await guestReadState();assert.equal(narrowGuest.documentStart,guestBefore.documentStart);assert.equal(narrowGuest.text,true);assert.equal(narrowGuest.selected,guestBefore.selected);assert.equal(narrowGuest.open,true);assert.equal(guestNavigations,0);
 await shell.screenshot({path:path.join(out,'narrow-report-return-shell.png')});
 await isolated.page.screenshot({path:path.join(out,'narrow-report-return-guest.png')});
 report.checks.push('Narrow main workspace return selects the same report and fills both workspace dimensions without navigation');
 await call(shell,'session.resize',{width:1440,height:1000});
 await visible(doc.scope.viewId);
 report.checks.push('detached title buttons receive real pointer events: report menu opens and dock returns the same view');
 await result.page.keyboard.press('Escape');await result.page.waitForSelector('.managed-report-dialog',{hidden:true});
 await result.page.click('[data-managed-end-result]');await result.page.waitForSelector('.managed-report-dialog[open]',{visible:true});
 assert.equal(await result.page.evaluate(()=>document.activeElement.textContent),'取消');
 await capture('accept-confirm-cancel',result.page,'.managed-report-dialog',result.scope.viewId);await result.page.keyboard.press('Escape');
 await result.page.waitForSelector('.managed-report-dialog',{hidden:true});
 assert.equal((await snapshot()).state.works.find(w=>w.id===work.id).status,'review');
 explicitChat=true;const beforeNavigation=(await snapshot()).state.jobs.map(j=>j.id);await shell.locator(workRow+' .managed-work-open').click();await shell.waitForSelector('#conversation-connection-error[open]',{visible:true});assert.deepEqual((await snapshot()).state.jobs.map(j=>j.id),beforeNavigation,'Opening original Work never sends a task');await shell.locator('#conversation-connection-error button:last-child').click();assert.equal((await snapshot()).state.works.find(w=>w.id===work.id).status,'review');report.checks.push('Compact Work name navigates via original host admission; unavailable session retains report and creates no task');
 for(const theme of ['light','dark'])for(const scheme of ['sage','slate']){
  await result.page.evaluate(({theme,scheme})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.palette=scheme;document.documentElement.style.setProperty('--chrome-font-size','20px');document.querySelector('#managed-doc').style.width='274px';},{theme,scheme});
  await result.page.$eval('#managed-result-actions',n=>n.scrollIntoView());
  assert.equal(await result.page.$eval('#managed-result-actions',n=>getComputedStyle(n).fontSize),'20px');
  assert(await result.page.$eval('#managed-result-actions',n=>n.scrollWidth<=n.clientWidth),'274px footer must not overflow');
  await assertReportHeight(result.page,scheme+'-'+theme+'-274px-20px');
  await capture('narrow-274-20-'+scheme+'-'+theme,result.page,'#managed-result-actions',result.scope.viewId);
 }
 await offline(baseline);report.checks.push('Offline real report/footer, menu, verified HTML clipboard, on-demand details, cancel-first bound confirmation, 274px decision controls; no provider or Work mutation');
 await result.page.evaluate(()=>{document.querySelector('#managed-doc').style.width='';document.documentElement.style.setProperty('--chrome-font-size','13px');});
 await fs.writeFile(path.join(fixture.project,'action-result.txt'),'Conflicting local file, must be preserved');
 await result.page.click('[data-managed-end-result]');await result.page.waitForSelector('.managed-report-dialog[open]',{visible:true});
 await result.page.keyboard.press('Tab');await result.page.keyboard.press('Enter');
 await until(async()=>{const w=(await snapshot()).state.works.find(w=>w.id===work.id);return w.status==='ended'&&w.closure?.phase==='blocked';},'business ended despite technical conflict');
 await result.page.waitForFunction(()=>document.querySelector('[data-report-state]').innerText.includes('已接受 · 技术收尾未完成'));
 await capture('ended-blocked-real-conflict',result.page,'#managed-result-actions',result.scope.viewId);
 assert.equal(await fs.readFile(path.join(fixture.project,'action-result.txt'),'utf8'),'Conflicting local file, must be preserved');
 await fs.unlink(path.join(fixture.project,'action-result.txt'));
 await result.page.waitForFunction(()=>!document.querySelector('[data-managed-closure-retry]').disabled);
 await result.page.click('[data-managed-closure-retry]');
 await until(async()=>(await snapshot()).state.works.find(w=>w.id===work.id).closure?.phase==='complete','real technical retry completed');
 await result.page.waitForFunction(()=>document.querySelector('[data-report-state]').innerText==='已接受');
 await capture('ended-complete-real-retry',result.page,'#managed-result-actions',result.scope.viewId);
 assert.equal(await fs.readFile(path.join(fixture.project,'action-result.txt'),'utf8'),'Real report action candidate');
 report.checks.push('Real bound accept through keyboard confirmation: ended+blocked preserves conflicting file, retry merges frozen candidate without reopening Work');
 await closeReport(result.scope.viewId);await visible(doc.scope.viewId);
 await capture('editor-after',doc.page,'#text-host .cm-editor',doc.scope.viewId);
 // An ended Work must not offer continuation or create a conversation.
 assert.equal((await snapshot()).state.works.find(w=>w.id===work.id).status,'ended');
 assert.deepEqual(await editorState(doc,editor),before);await offline(baseline);
 clearInterval(monitor);monitor=null;await monitorPending;if(monitorError)throw monitorError;
 const mainExe=await fs.readlink('/proc/'+child.pid+'/exe');report.processes=[...observedProcesses.values()];assert(report.processes.length>0,'Actual process observation');assert.deepEqual(report.processes.filter(p=>p.exe!==mainExe&&!/chrome_crashpad_handler$/.test(p.exe)&&!/(?:^|\/)git$/.test(p.exe)),[],'No spawned Agent/provider process (Electron UI and real local Git are allowed)');
 report.finalExecution=execution((await offline(baseline)).state);report.noModelEvidence={zeroProviders:true,zeroLiveThreads:true,jobsAndRequestRecordsUnchanged:true,initialized:false,noAgentProcessObserved:true,processSamplingMs:75};assert.deepEqual(report.errors,[]);report.checks.push('Ended Work stays ended; zero providers/live threads and unchanged jobs/request records');await editor.dispose();
 await shell.keyboard.press('Escape');
 const normalExit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 const quitStart=Date.now();await call(shell,'session.requestClose').catch(()=>{});
 let closed=await Promise.race([normalExit,pause(45000).then(()=>null)]);report.quitMs=Date.now()-quitStart;
 if(!closed)report.quitPages=await Promise.all((await browser.pages()).map(p=>p.evaluate(()=>({scope:window.__workspaceScope,ready:window.__nozeliReady,composing:document.querySelector('#app')?.inert,dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.id)})).catch(()=>null)));
 assert.deepEqual(closed,{code:0,signal:null});report.normalExit=closed;
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
