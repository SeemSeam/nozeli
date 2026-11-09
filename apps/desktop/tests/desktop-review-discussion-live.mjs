// Actual Electron + private Pi owners + real candidate files. Scripted loopback provider, never user data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {serve} from './pi-provider.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';

const app=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-approval-discussion-'));
const configRoot=path.join(out,'.Nozeli'),profile=path.join(configRoot,'desktop'),projectRoot=path.join(out,'project');
await fs.mkdir(projectRoot);await fs.writeFile(path.join(projectRoot,'candidate.txt'),'original project baseline\n');
const exec=promisify(execFile);
for(const args of [['init','--initial-branch=main'],['add','.'],['-c','user.name=Review Smoke','-c','user.email=review@example.invalid','commit','-m','isolated baseline']])await exec('git',args,{cwd:projectRoot});
const host=new DesktopHost(profile),project=(await host.pick(projectRoot)).project;
const otherRoot=path.join(out,'other-project');await fs.mkdir(otherRoot);await fs.writeFile(path.join(otherRoot,'readme.md'),'isolated second project');const otherProject=(await host.pick(otherRoot)).project;
for(const p of [project,otherProject]){const registered=await host.storage.requireRegistered(p.id);registered.semanticInitializationEligible=false;await host.storage.db.request(host.storage.catalog,'put',{collection:'instances',id:p.id,value:registered});}
await host.storage.db.close();
const wireText=message=>typeof message?.content==='string'?message.content:message?.content?.filter(part=>part.type==='text').map(part=>part.text).join('')||'';
const trace=[];
let releaseQueuedTurn;
const queuedTurnGate=new Promise(resolve=>{releaseQueuedTurn=resolve;});
const provider=await serve(async request=>{
 const tools=request.tools?.map(tool=>tool.function?.name)||[];
 if(tools.includes('nozeli_handoff')&&request.messages.some(row=>row.role==='user'&&wireText(row).includes('FOREGROUND_READ_MARKER'))){trace.push('foreground-read');return {text:'FOREGROUND_REPLY_MARKER: exact foreground native message, no task dispatch.'};}
 if(tools.includes('nozeli_handoff')){trace.push('frontdesk');return {tool:'nozeli_handoff',id:'review-handoff',args:{reason:'Run the explicitly requested isolated candidate task.'}};}
 if(tools.includes('nozeli_dispatch')){trace.push('orchestrator');return {tool:'nozeli_dispatch',id:'review-dispatch',args:{name:'审批讨论真实接线',brief:'Create candidate.txt with initial candidate content and publish the HTML report for explicit review.'}};}
 const user=request.messages.filter(row=>row.role==='user').map(wireText);
 const phase=user.findLast(text=>['DISCUSS_QUESTION','DISCUSS_MODIFY','DISCUSS_AFTER','DISCUSS_HOLD','DISCUSS_QUEUED'].includes(text.trim()))?.trim()||'initial';
 trace.push(phase);
 if(phase==='DISCUSS_HOLD'){await queuedTurnGate;return {text:'REVIEW_HOLD_REPLY: first queued round completed.'};}
 if(phase==='DISCUSS_QUEUED')return {text:'REVIEW_QUEUED_REPLY: second round ran after the first.'};
 if(phase==='DISCUSS_QUESTION')return {text:'REVIEW_ANSWER_ORIGINAL_THREAD: this explanation does not change the report or files.'};
 if(phase==='DISCUSS_AFTER')return {text:'REVIEW_ANSWER_AFTER_UPDATE: the revised report and candidate are retained in this same task.'};
 if(phase==='DISCUSS_MODIFY'){
  if(!request.messages.some(row=>row.tool_call_id==='review-modify-write'))return {tool:'write',id:'review-modify-write',args:{path:'candidate.txt',content:'updated candidate from approval discussion\n'}};
  return {tool:'nozeli_publish',id:'review-modify-publish',args:{kind:'result',content:staticReport('REVIEW_REPORT_V2 updated after direct Worker discussion.'),files:['candidate.txt']}};
 }
 if(!request.messages.some(row=>row.tool_call_id==='review-initial-write'))return {tool:'write',id:'review-initial-write',args:{path:'candidate.txt',content:'initial frozen candidate\n'}};
 return {tool:'nozeli_publish',id:'review-initial-publish',args:{kind:'result',content:staticReport('REVIEW_REPORT_V1 original frozen report.'),files:['candidate.txt']}};
});
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
const ozone=process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':process.env.WAYLAND_DISPLAY?'wayland':'headless');
Object.assign(env,{NOZELI_CONFIG_ROOT:configRoot,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_OZONE:ozone});
const require=createRequire(import.meta.url),report={ok:false,out,scope:'Real Electron, private Pi native owners and Git files; local scripted provider, no paid model or user profile',checks:[],screenshots:[]};
let child,browser,shell,reviewPage,discussionPage,observer,exit,log='';const errors=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Electron exited '+log);const value=await fn();if(value)return value;await pause(80);}throw Error('Timeout: '+label);}
async function invoke(page,op,payload={}){const r=await page.evaluate(({op,payload})=>window.nozeli.invoke(op,payload),{op,payload});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
const state=async()=> (await invoke(shell,'managed.status',{projectId:project.id})).state;
const check=name=>{report.checks.push(name);console.log(name);};
async function shot(name){const file=path.join(out,name+'.png');await reviewPage.screenshot({path:file});report.screenshots.push(file);}
async function discussion(){discussionPage=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='review-discussion').catch(()=>false))return p;},'trusted native discussion');return discussionPage;}
async function nativeDiscussionState(){return observer.evaluate(`(async()=>{const {BrowserWindow}=process.mainModule.require('electron'),rows=[];for(const win of BrowserWindow.getAllWindows()){if(win.isDestroyed())continue;const scope=await win.webContents.executeJavaScript('window.__workspaceScope').catch(()=>null);if(scope?.role!=='review-discussion'||scope.projectId!==${JSON.stringify(project.id)})continue;const parent=win.getParentWindow();rows.push({id:win.id,visible:win.isVisible(),focused:win.isFocused(),bounds:win.getBounds(),contentBounds:win.getContentBounds(),zoomFactor:win.webContents.getZoomFactor(),parentVisible:parent?.isVisible(),parentFocused:parent?.isFocused(),scope});}return rows;})()`);}
async function discussionVisible(selector='[data-review-discussion]'){
 return until(async()=>{const rows=await nativeDiscussionState(),native=rows.find(row=>row.visible&&row.parentVisible&&row.bounds.width>0&&row.bounds.height>0);if(!native)return false;const visible=await discussionPage.$eval(selector,node=>{const r=node.getBoundingClientRect(),style=getComputedStyle(node);return !node.hidden&&r.width>0&&r.height>0&&style.display!=='none'&&style.visibility!=='hidden';}).catch(()=>false);return visible?native:false;},'actual native discussion and control visible: '+selector,6000);
}
async function clickDiscussion(selector,{waitHidden=true}={}){await discussionVisible(selector);await discussionPage.click(selector);if(selector==='[data-local-window-hide]'&&waitHidden)await until(async()=>{const rows=await nativeDiscussionState();return rows.length===1&&rows.every(row=>!row.visible);},'native discussion close acknowledged',6000);}
async function visibleReport(marker){
 await reviewPage.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
 const key=await reviewPage.$eval('.managed-report-body .isolated-viewport',node=>node.dataset.previewKey);
 const snapshot=await invoke(reviewPage,'isolated-preview.snapshot',{key});
 const guest=await until(async()=>{for(const p of await browser.pages())if(p.url().startsWith(snapshot.origin+'/'))return p;},'current native report guest');
 await guest.waitForFunction(marker=>document.body.innerText.includes(marker),{},marker);
 const file=path.join(out,marker+'.png');await guest.screenshot({path:file});report.screenshots.push(file);
 return guest;
}
async function send(text){
 await discussionVisible('[data-review-instruction]');await discussionPage.waitForSelector('[data-review-instruction]:not([disabled])',{visible:true});
 await discussionPage.$eval('[data-review-instruction]',(node,text)=>{node.value=text;node.dispatchEvent(new Event('input',{bubbles:true}));},text);
 await discussionPage.waitForSelector('[data-review-action="send"]:not([disabled])',{visible:true});
 await clickDiscussion('[data-review-action="send"]');
 await until(async()=>{const s=await state(),job=s.jobs.findLast(row=>row.text===text);if(job?.status==='failed'||job?.status==='unknown')throw Error(JSON.stringify(job));return job?.status==='completed'&&s.works.find(work=>work.id===job.target)?.status==='review'&&!s.jobs.some(row=>row.target===job.target&&['queued','running'].includes(row.status));},text+' settles');
}
try{
 child=spawn(process.env.NOZELI_TEST_BINARY||require('electron'),[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform='+ozone,'--inspect=0'],{cwd:projectRoot,env,stdio:['ignore','pipe','pipe']});
 exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 browser.on('targetcreated',async target=>{const page=await target.page().catch(()=>null);page?.on('pageerror',error=>errors.push(error.message));});
 shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');
 observer=await MainObserver.connect(await until(()=>log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'native main observer'));
 await invoke(shell,'config.initialize',{mode:'independent'});
 if(await shell.$eval('#configuration-setup',node=>node.open).catch(()=>false))await shell.click('#configuration-cancel');
 await invoke(shell,'settings.providers.save',{operation:'create',provider:'approval-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-nonsecret'}});
 const model={model:{mode:'explicit',selector:'approval-local/scripted'},thinking:{mode:'native-default'}};
 await invoke(shell,'settings.models.save',{frontdesk:model,orchestrator:model,worker:model});
 await shell.click('[data-project-id="'+project.id+'"]');
 await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,project.id),'project binding');
 await until(()=>shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')==='true'),'project visit opens sidebar');
 await shell.click('#toggle-sidebar');assert.equal(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')),'false');
 await invoke(shell,'workspace.control',{type:'window-control',action:'resize',width:800,height:650});await shell.waitForFunction(()=>document.querySelector('#app').classList.contains('narrow-layout'));
 assert.equal(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')),'false','explicit collapse survives breakpoint');
 await shell.click('[data-project-id="'+otherProject.id+'"]');await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,otherProject.id),'second project visit');await until(()=>shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')==='true'),'second visit opens sidebar');
 await shell.click('[data-project-id="'+project.id+'"]');await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,project.id),'return project visit');await until(()=>shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')==='true'),'return visit opens sidebar');
 await invoke(shell,'workspace.control',{type:'window-control',action:'resize',width:1440,height:900});await shell.waitForFunction(()=>!document.querySelector('#app').classList.contains('narrow-layout'));
 check('Entering and re-entering real projects opens the core sidebar; explicit collapse survives a responsive breakpoint');
 await invoke(shell,'managed.enable',{projectId:project.id});
 await shell.evaluate(()=>{window.__foregroundPresentations=[];window.nozeli.subscribe('workspace.control',event=>{if(event.type==='attention-presented')window.__foregroundPresentations.push(event);});});
 await shell.click('#workspace-open-conversation');
 const conversationPage=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.kind==='conversation').catch(()=>false))return page;},'real foreground conversation');
 await conversationPage.waitForSelector('#composer:not([disabled])');await conversationPage.$eval('#composer',node=>{node.value='FOREGROUND_READ_MARKER';node.dispatchEvent(new Event('input',{bubbles:true}));});await conversationPage.waitForSelector('#send-message:not([disabled])');await conversationPage.click('#send-message');
 await conversationPage.waitForFunction(()=>document.querySelector('#conversation')?.innerText.includes('FOREGROUND_REPLY_MARKER'));
 await until(()=>shell.evaluate(()=>window.__foregroundPresentations.some(event=>event.messageId&&event.sessionId)),'canonical foreground message presented through native bridge');
 assert.equal((await state()).works.length,0,'foreground reading does not dispatch a Work');check('Real foreground native reply is presented with canonical session/revision identity and reaches the shell without task dispatch');
 await invoke(shell,'managed.task',{projectId:project.id,text:'Create a candidate and HTML report for the isolated approval discussion smoke.',requestKey:'approval-smoke-initial-task'});
 const first=await until(async()=>{const s=await state();const w=s.works[0];if(s.jobs.some(j=>j.status==='failed'))throw Error(JSON.stringify(s.jobs.filter(j=>j.status==='failed')));return w?.status==='review'&&!s.jobs.some(j=>['queued','running'].includes(j.status))?s:null;},'initial review');
 const work=first.works[0],originalThread=work.threadId,originalReceipt=first.receipts.find(r=>r.workId===work.id&&r.kind==='result'),todo=first.todos.find(t=>t.workId===work.id&&t.kind==='result'&&t.status==='open');
 assert(todo&&originalReceipt);report.workId=work.id;report.threadId=originalThread;report.initialObjectId=originalReceipt.objectId;
 const sourceBefore=await fs.readFile(path.join(projectRoot,'candidate.txt'),'utf8');
 if(await shell.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')!=='true').catch(()=>false))await shell.click('#toggle-sidebar');
 const pendingBeforeOpen=(await state()).todos.filter(t=>t.status==='open').map(t=>t.id);
 const notifiedBeforeOpen=(await state()).attentionNotified;
 await shell.click('#toggle-sidebar');assert.equal(await shell.$('#sidebar-badge'),null);await shell.screenshot({path:path.join(out,'pending-collapsed-rail.png')});
 await shell.click('#toggle-sidebar');assert.deepEqual((await state()).todos.filter(t=>t.status==='open').map(t=>t.id),pendingBeforeOpen);assert.deepEqual((await state()).attentionNotified,notifiedBeforeOpen,'opening never acknowledges pending obligations');
 await shell.waitForSelector('[data-managed-todo="'+todo.id+'"]',{visible:true});await shell.click('[data-managed-todo="'+todo.id+'"]');
 reviewPage=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.kind==='report').catch(()=>false))return p;},'native report workspace');
 await reviewPage.waitForSelector('.managed-review');assert.equal(await reviewPage.$('[data-review-discussion]'),null);
 assert.equal(await until(async()=>{const pages=await browser.pages();return Promise.all(pages.map(p=>p.evaluate(()=>window.__workspaceScope?.role==='review-discussion').catch(()=>false))).then(values=>!values.some(Boolean));},'cold report has no native discussion'),true);await reviewPage.click('[data-review-action="open-discussion"]');await discussion();await discussionPage.waitForSelector('[data-review-discussion]',{visible:true});await discussionPage.waitForSelector('[data-review-instruction]:not([disabled])',{visible:true});
 assert(await reviewPage.$('.managed-report-body'));assert.equal(await discussionPage.$('.managed-report-body'),null);
 await discussionPage.waitForSelector('.session-task-card .session-task-flow');
 assert.equal(await discussionPage.$('[data-review-context]'),null,'the old separate context bucket is retired');
 assert.equal(await discussionPage.$eval('[data-task-toggle]',node=>node.getAttribute('aria-expanded')),'true','review discussion defaults to expanded independently of conversation cards');
 const layoutBeforeInline=await invoke(shell,'workspace.snapshot',{projectId:project.id}),inlineViewIds=Object.keys(layoutBeforeInline.layout.views).sort(),inlinePageCount=(await browser.pages()).length;
 await discussionPage.click('[data-task-action="process"]');await discussionPage.waitForSelector('[data-task-inline-process] [data-task-process]',{visible:true});
 assert.deepEqual(Object.keys((await invoke(shell,'workspace.snapshot',{projectId:project.id})).layout.views).sort(),inlineViewIds,'review process disclosure never creates a split');
 assert.equal((await browser.pages()).length,inlinePageCount,'review process disclosure never opens a new page');
 await discussionPage.click('[data-task-action="process"]');await discussionPage.waitForSelector('[data-task-inline-process]',{hidden:true});
 const taskFrame=await invoke(discussionPage,'managed.review.discussion.read',{projectId:project.id,workId:work.id,objectId:originalReceipt.objectId,limit:100});
 assert.equal(taskFrame.taskState.works.length,1);assert.equal(taskFrame.taskState.works[0].id,work.id);
 const mainTaskFrame=await invoke(shell,'managed.timeline.page',{projectId:project.id,workId:work.id,limit:100});
 const canonical=new Map(mainTaskFrame.entries.map(row=>[row.id,row]));
 for(const entry of taskFrame.taskFrame.entries){const same=canonical.get(entry.id);if(same)assert.equal(entry.text,same.text,'shared source text for '+entry.id);}
 assert(taskFrame.taskFrame.entries.some(entry=>entry.speaker==='user'),'the task reader includes the original accepted input');
 await discussionPage.screenshot({path:path.join(out,'shared-task-reader-open.png')});
 await discussionPage.$eval('.session-task-flow',node=>node.scrollIntoView({block:'start'}));
 await discussionPage.screenshot({path:path.join(out,'shared-task-direction-and-request.png')});
 await visibleReport('REVIEW_REPORT_V1');
 check('Todo opens the original report first; only its bottom button opens the separate nonmodal Work discussion');await shot('approval-open');
 await shell.evaluate(()=>{window.__presentedMessages=[];window.nozeli.subscribe('workspace.control',event=>{if(event.type==='attention-presented')window.__presentedMessages.push(event);});});
 await send('DISCUSS_QUESTION');await discussionPage.waitForFunction(()=>document.querySelector('[data-review-discussion-history]')?.textContent.includes('REVIEW_ANSWER_ORIGINAL_THREAD'));
 let current=await state();assert.equal(current.works.length,1);assert.equal(current.works[0].threadId,originalThread);assert.equal(current.receipts.filter(r=>r.workId===work.id&&r.kind==='result').length,1);assert.equal(current.works[0].status,'review');
 assert.equal(await fs.readFile(path.join(projectRoot,'candidate.txt'),'utf8'),sourceBefore);
 check('Original Worker answers a pure review question in its original native thread without a new report or project mutation');
 await discussionPage.bringToFront();await observer.evaluate(`(()=>{const{BrowserWindow}=process.mainModule.require('electron');for(const win of BrowserWindow.getAllWindows())if(win.getParentWindow()){win.focus();win.webContents.focus();}})()`);await discussionPage.click('[data-review-instruction]');await discussionPage.waitForFunction(()=>document.hasFocus());
 await discussionPage.$eval('[data-review-discussion-history]',node=>{node.scrollTop=node.scrollHeight;node.dispatchEvent(new Event('scroll'));});
 const validMessage=await until(()=>shell.evaluate(()=>window.__presentedMessages?.find(event=>event.messageId&&event.sessionId)),'canonical review message presented through native bridge');
 assert.equal(validMessage.projectId,project.id);assert.equal(validMessage.objectId,originalReceipt.objectId);
 const rejected=await shell.evaluate(detail=>window.nozeli.invoke('workspace.attention.presented',detail),validMessage);assert.equal(rejected.ok,false,'shell cannot claim a message was shown on a child');
 assert.equal((await state()).todos.find(row=>row.id===todo.id).status,'open','reading does not resolve pending review');
 check('Visible exact native message is relayed to shell; shell spoof is denied and pending review stays open');
 await discussionPage.waitForFunction(()=>{const e=document.querySelector('[data-review-instruction]');return e&&!e.disabled&&!e.readOnly;});
 await discussionVisible('[data-review-instruction]');await discussionPage.$eval('[data-review-instruction]',node=>{node.value='DISCUSS_HOLD';node.dispatchEvent(new Event('input',{bubbles:true}));});await discussionPage.waitForSelector('[data-review-action="send"]:not([disabled])',{visible:true});await clickDiscussion('[data-review-action="send"]');
 await until(()=>trace.includes('DISCUSS_HOLD'),'held native discussion started');
 await discussionPage.waitForFunction(()=>document.querySelector('.session-task-flow')?.dataset.running==='true');
 assert.match(await discussionPage.$eval('.session-task-detail',node=>node.textContent),/./,'real discussion activity is visible while the Task remains in review');
 assert.equal(await discussionPage.$$eval('.session-task-trail[data-returning=true]',nodes=>nodes.length),0,'a question is not fabricated as an approval modification return');
 await discussionPage.waitForFunction(()=>{const e=document.querySelector('[data-review-instruction]');return e&&!e.disabled&&!e.readOnly;});
 await discussionVisible('[data-review-instruction]');await discussionPage.$eval('[data-review-instruction]',node=>{node.value='DISCUSS_QUEUED';node.dispatchEvent(new Event('input',{bubbles:true}));});await discussionPage.waitForSelector('[data-review-action="send"]:not([disabled])',{visible:true});await clickDiscussion('[data-review-action="send"]');
 await until(async()=>{const s=await state();return s.jobs.some(j=>j.text==='DISCUSS_QUEUED'&&j.status==='queued');},'second discussion durably queued');
 assert(!trace.includes('DISCUSS_QUEUED'),'second provider turn must not overlap held first turn');
 assert.equal(await reviewPage.$eval('[data-review-action="accept"]',node=>node.disabled),true);
 releaseQueuedTurn();
 await until(async()=>{const s=await state();return s.jobs.find(j=>j.text==='DISCUSS_QUEUED')?.status==='completed'&&s.works[0].status==='review';},'native FIFO discussions settle');
 await discussionPage.waitForFunction(()=>document.querySelector('[data-review-discussion-history]')?.textContent.includes('REVIEW_QUEUED_REPLY'));
 check('Busy approval input enters a durable FIFO queue, executes on the same native owner without overlap and blocks acceptance until drained');
 await send('DISCUSS_MODIFY');
 current=await state();assert.equal(current.works.length,1);assert.equal(current.works[0].threadId,originalThread);
 const publications=current.receipts.filter(r=>r.workId===work.id&&r.kind==='result');assert.equal(publications.length,2);const updated=publications.at(-1);assert.notEqual(updated.objectId,originalReceipt.objectId);
 assert.equal(await reviewPage.evaluate(()=>window.__workspaceScope.viewState?.report?.objectId),originalReceipt.objectId,'new publication never silently upgrades the read object');
 assert.equal(await discussionPage.evaluate(()=>window.__workspaceScope.objectId),originalReceipt.objectId,'discussion read binding remains on the original publication');
 await until(async()=>{
  const currentObject=await reviewPage.evaluate(()=>window.__workspaceScope.viewState?.report?.objectId);
  if(currentObject===updated.objectId)return true;
  const latest=await discussionPage.$('[data-review-action="latest-discussion"]:not([hidden])');
  if(!latest)return false;
  await clickDiscussion('[data-review-action="latest-discussion"]:not([hidden])');return true;
 },'explicit latest report entrance');
 await until(async()=>{const scope=await reviewPage.evaluate(()=>window.__workspaceScope);return scope.viewState?.report?.objectId===updated.objectId;},'latest main report publication binding');
 await visibleReport('REVIEW_REPORT_V2');
 assert.equal(await fs.readFile(path.join(projectRoot,'candidate.txt'),'utf8'),sourceBefore);
 check('Direct approval discussion modifies the real candidate, publishes a new immutable report and refreshes the main report without another Work');await shot('approval-updated');
 await clickDiscussion('[data-local-window-hide]');
 const updatedGuest=await visibleReport('REVIEW_REPORT_V2');await updatedGuest.waitForSelector('[data-nozeli-endmatter-action="file"]');await updatedGuest.click('[data-nozeli-endmatter-action="file"]');
 const candidatePage=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(objectId=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.relPath==='candidate.txt'&&window.__workspaceScope.documentSource?.objectId===objectId,updated.objectId).catch(()=>false))return p;},'single candidate native document');
 await candidatePage.waitForFunction(()=>window.__nozeliInput?.text().includes('updated candidate from approval discussion'));
 assert.equal(await reviewPage.$('dialog[open]'),null,'opening the candidate leaves no modal over the review');
 const reportViewId=await reviewPage.evaluate(()=>window.__workspaceScope.viewId),layout=await shell.evaluate(()=>window.__workspaceGroups.snapshot());
 await invoke(shell,'workspace.command',{projectId:project.id,expectedRevision:layout.revision,requestKey:'approval-smoke-return-report',command:{type:'activate',viewId:reportViewId}});
 check('Single-file review directly opens the exact native candidate and returns without a leftover modal or project overwrite');
 assert.equal(await reviewPage.$('[data-review-discussion]'),null);await reviewPage.click('[data-review-action="open-discussion"]');
 await discussionPage.waitForFunction(objectId=>window.__workspaceScope.objectId===objectId,{},updated.objectId);
 await send('DISCUSS_AFTER');await discussionPage.waitForFunction(()=>document.querySelector('[data-review-discussion-history]')?.textContent.includes('REVIEW_ANSWER_AFTER_UPDATE'));
 await discussionVisible('[data-review-instruction]');await discussionPage.$eval('[data-review-instruction]',node=>{node.value='UNSENT_APPROVAL_DRAFT';node.dispatchEvent(new Event('input',{bubbles:true}));window.__retainedReviewInput=node;});
 await clickDiscussion('[data-local-window-hide]',{waitHidden:false});await reviewPage.click('[data-review-action="open-discussion"]');await discussionVisible();
 assert.equal(await discussionPage.$eval('[data-review-instruction]',node=>node.value),'UNSENT_APPROVAL_DRAFT');assert.equal(await discussionPage.evaluate(()=>document.querySelector('[data-review-instruction]')===window.__retainedReviewInput),true);
 for(const theme of ['light','dark'])for(const palette of ['sage','slate'])for(const width of [1440,800]){
  await invoke(shell,'settings.appearance.save',{theme,palette,font:'system',size:14});
  await invoke(shell,'workspace.control',{type:'window-control',action:'resize',width,height:width===800?650:900});
  // An open narrow drawer correctly occludes native report/discussion views.
  if(width<=1000&&await shell.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')==='true'))await shell.click('#toggle-sidebar');
  await reviewPage.waitForFunction(theme=>document.documentElement.dataset.theme===theme,{},theme);
  await reviewPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await discussionVisible('[data-review-instruction]');
  assert.equal(await discussionPage.$eval('[data-review-instruction]',node=>node.value),'UNSENT_APPROVAL_DRAFT');
  const colors=await discussionPage.evaluate(()=>{
   const c=document.createElement('canvas').getContext('2d'),rgb=v=>{c.clearRect(0,0,1,1);c.fillStyle=v;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].slice(0,3);},lum=v=>rgb(v).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0),contrast=(a,b)=>{a=lum(a);b=lum(b);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);},s=getComputedStyle(document.documentElement),read=n=>s.getPropertyValue(n).trim();
   return {theme:document.documentElement.dataset.theme,palette:document.documentElement.dataset.palette,states:['review','decision','running','queued','paused','unknown','danger'].map(name=>({name,ink:read('--status-'+name+'-ink'),bg:read('--status-'+name+'-bg'),textContrast:contrast(read('--status-'+name+'-ink'),read('--status-'+name+'-bg')),borderContrast:contrast(read('--status-'+name+'-border'),read('--paper'))})),inputHeight:document.querySelector('[data-review-instruction]').getBoundingClientRect().height};
  });
  for(const row of colors.states){assert(row.textContrast>=4.5,theme+'/'+palette+'/'+row.name+' readable text');assert(row.borderContrast>=3,theme+'/'+palette+'/'+row.name+' distinct outline');}
  assert(colors.inputHeight>=64);(report.themeMatrix??=[]).push({theme,palette,width,...colors});
  await discussionPage.screenshot({path:path.join(out,'discussion-'+theme+'-'+palette+'-'+width+'.png')});
  await shell.screenshot({path:path.join(out,'sidebar-'+theme+'-'+palette+'-'+width+'.png')});
  await shot('approval-'+theme+'-'+palette+'-'+width);
 }
 for(const size of [{width:654,height:1150},{width:390,height:844},{width:390,height:480},{width:320,height:480}]){
  await invoke(shell,'workspace.control',{type:'window-control',action:'resize',...size});
  await reviewPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await discussionVisible('[data-review-action="send"]');
  await discussionPage.$eval('[data-review-action="send"]',node=>node.scrollIntoView({block:'nearest'}));
  const geometry=await until(async()=>{const native=(await nativeDiscussionState()).find(row=>row.visible);if(!native)return null;const g=await discussionPage.evaluate(()=>{const float=document.querySelector('[data-review-discussion]').getBoundingClientRect(),send=document.querySelector('[data-review-action="send"]').getBoundingClientRect();return {left:float.left,right:float.right,top:float.top,bottom:float.bottom,floatWidth:float.width,floatHeight:float.height,sendWidth:send.width,sendHeight:send.height,sendBottom:send.bottom,width:innerWidth,height:innerHeight};});return g.floatWidth>0&&g.floatHeight>0&&g.sendWidth>0&&g.sendHeight>0&&g.left>=-1&&g.right<=g.width+1&&g.bottom<=g.height+1&&g.sendBottom<=g.height+1&&Math.abs(g.floatWidth-native.contentBounds.width/native.zoomFactor)<=1&&Math.abs(g.floatHeight-native.contentBounds.height/native.zoomFactor)<=1?{...g,native}:null;},'positive discussion controls match actual native client DIP through zoom',6000);
  (report.windowGeometry??=[]).push({requested:size,actual:geometry});
  await shot('approval-'+size.width+'x'+size.height);
 }
 await invoke(shell,'workspace.control',{type:'window-control',action:'resize',width:1280,height:900});
 const zoomReport=async factor=>observer.evaluate(`(async()=>{const{webContents}=process.mainModule.require('electron');for(const wc of webContents.getAllWebContents()){const scope=await wc.executeJavaScript('window.__workspaceScope').catch(()=>null);if(scope?.role==='surface'&&scope.kind==='report'&&scope.projectId===${JSON.stringify(project.id)}){wc.setZoomFactor(${factor});return wc.getZoomFactor();}}throw Error('Report owner missing');})()`);
 assert.equal(await zoomReport(2),2);await until(async()=>{const native=(await nativeDiscussionState()).find(row=>row.visible&&row.zoomFactor===2);return native;},'200 percent native discussion zoom');
 await discussionVisible('[data-review-action="send"]');
 await discussionPage.$eval('[data-review-action="send"]',node=>node.scrollIntoView({block:'nearest'}));
 const zoomGeometry=await until(()=>discussionPage.evaluate(async()=>{const float=document.querySelector('[data-review-discussion]').getBoundingClientRect();if(Math.abs(float.width-innerWidth)>1||Math.abs(float.height-innerHeight)>1||innerWidth<160)return null;document.querySelector('[data-review-action="send"]').scrollIntoView({block:'nearest'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const send=document.querySelector('[data-review-action="send"]').getBoundingClientRect(),input=document.querySelector('[data-review-instruction]').getBoundingClientRect();if(send.left<0||send.right>innerWidth+1||send.bottom>innerHeight+1||input.left<0||input.right>innerWidth+1||input.bottom>innerHeight+1)return null;return {width:innerWidth,height:innerHeight,send:{left:send.left,right:send.right,top:send.top,bottom:send.bottom},input:{left:input.left,right:input.right,top:input.top,bottom:input.bottom},draft:document.querySelector('[data-review-instruction]').value};}),'settled CSS and reachable single-scroll input through native zoom');
 assert(zoomGeometry.send.left>=0&&zoomGeometry.send.right<=zoomGeometry.width+1&&zoomGeometry.send.bottom<=zoomGeometry.height+1);assert(zoomGeometry.input.left>=0&&zoomGeometry.input.right<=zoomGeometry.width+1&&zoomGeometry.input.bottom<=zoomGeometry.height+1);assert.equal(zoomGeometry.draft,'UNSENT_APPROVAL_DRAFT');report.zoom200=zoomGeometry;await discussionPage.screenshot({path:path.join(out,'discussion-zoom200.png')});await zoomReport(1);await until(async()=>{const native=(await nativeDiscussionState()).find(row=>row.visible&&row.zoomFactor===1);return native;},'normal native discussion zoom');
 check('Actual narrow/short native surfaces retain the movable discussion and reachable input; adoption belongs to the report footer');
 check('Latest report discussion remains in the original thread, and collapsing/reopening retains the Work-scoped unsent draft');
 await clickDiscussion('[data-local-window-hide]');
 await reviewPage.waitForSelector('[data-review-action="accept"]:not([disabled])',{visible:true});await reviewPage.click('[data-review-action="accept"]');await reviewPage.waitForSelector('[data-confirmation-dialog][open]');report.acceptConfirmation=await reviewPage.$eval('[data-confirmation-dialog]',node=>node.innerText);await shot('approval-accept-confirmation');await reviewPage.click('[data-confirmation-cancel]');
 assert.equal((await state()).works[0].status,'review');
 await reviewPage.click('[data-review-action="accept"]');await reviewPage.waitForSelector('[data-confirmation-dialog][open]');await reviewPage.click('[data-confirmation-confirm]');
 await until(async()=>{const w=(await state()).works[0];return ['closing','ended'].includes(w.status)&&w.outcome==='accept';},'exact-version accept recorded');
 await until(async()=>{const w=(await state()).works[0];if(w.closure?.phase==='blocked')throw Error('closure blocked: '+JSON.stringify(w.closure));return w.status==='ended'&&w.closure?.phase==='complete';},'host merge and original task closure',60000);
 assert.equal(await fs.readFile(path.join(projectRoot,'candidate.txt'),'utf8'),'updated candidate from approval discussion\n');
 const final=await state();assert.equal(final.works.length,1);assert.equal(final.jobs.filter(j=>j.text==='UNSENT_APPROVAL_DRAFT').length,0);assert.equal(final.works[0].threadId,originalThread);
 check('Footer acceptance supports cancel then explicit exact-version accept, starts original closure and does not dispatch the unsent draft');
 assert.deepEqual(provider.errors,[]);assert.deepEqual(errors,[]);report.providerCalls=provider.requests.length;report.trace=trace;report.finalStatus=final.works[0].status;report.ok=true;
 observer.close();observer=null;
 await invoke(shell,'session.requestClose');assert.deepEqual(await Promise.race([exit,pause(20000).then(()=>null)]),{code:0,signal:null});child=null;
}catch(error){report.error=error.stack;process.exitCode=1;report.nativeDiscussion=await nativeDiscussionState().catch(()=>null);report.childSurface=await discussionPage?.evaluate(()=>({scope:window.__workspaceScope,html:document.querySelector('[data-review-discussion]')?.outerHTML,body:document.body.innerText})).catch(()=>null);report.surface=await reviewPage?.evaluate(()=>({scope:window.__workspaceScope,text:document.body.innerText.slice(-7000)})).catch(()=>null);await reviewPage?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{
 observer?.close();
 releaseQueuedTurn();
 if(child?.exitCode===null){try{await Promise.race([invoke(shell,'session.requestClose'),pause(10000)]);await Promise.race([exit,pause(10000)]);}catch{}if(child.exitCode===null)child.kill('SIGTERM');}
 await browser?.disconnect().catch(()=>{});await provider.close();report.errors=errors;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));
}
