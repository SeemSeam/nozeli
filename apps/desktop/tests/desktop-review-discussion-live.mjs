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

const app=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-approval-discussion-'));
const configRoot=path.join(out,'.Nozeli'),profile=path.join(configRoot,'desktop'),projectRoot=path.join(out,'project');
await fs.mkdir(projectRoot);await fs.writeFile(path.join(projectRoot,'candidate.txt'),'original project baseline\n');
const exec=promisify(execFile);
for(const args of [['init','--initial-branch=main'],['add','.'],['-c','user.name=Review Smoke','-c','user.email=review@example.invalid','commit','-m','isolated baseline']])await exec('git',args,{cwd:projectRoot});
const host=new DesktopHost(profile),project=(await host.pick(projectRoot)).project;await host.storage.db.close();
const wireText=message=>typeof message?.content==='string'?message.content:message?.content?.filter(part=>part.type==='text').map(part=>part.text).join('')||'';
const trace=[];
let releaseQueuedTurn;
const queuedTurnGate=new Promise(resolve=>{releaseQueuedTurn=resolve;});
const provider=await serve(async request=>{
 const tools=request.tools?.map(tool=>tool.function?.name)||[];
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
let child,browser,shell,reviewPage,exit,log='';const errors=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Electron exited '+log);const value=await fn();if(value)return value;await pause(80);}throw Error('Timeout: '+label);}
async function invoke(page,op,payload={}){const r=await page.evaluate(({op,payload})=>window.nozeli.invoke(op,payload),{op,payload});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
const state=async()=> (await invoke(shell,'managed.status',{projectId:project.id})).state;
const check=name=>{report.checks.push(name);console.log(name);};
async function shot(name){const file=path.join(out,name+'.png');await reviewPage.screenshot({path:file});report.screenshots.push(file);}
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
 await reviewPage.waitForSelector('[data-review-instruction]:not([disabled])',{visible:true});
 await reviewPage.$eval('[data-review-instruction]',(node,text)=>{node.value=text;node.dispatchEvent(new Event('input',{bubbles:true}));},text);
 await reviewPage.waitForSelector('[data-review-action="send"]:not([disabled])',{visible:true});
 await reviewPage.click('[data-review-action="send"]');
 await until(async()=>{const s=await state(),job=s.jobs.findLast(row=>row.text===text);if(job?.status==='failed'||job?.status==='unknown')throw Error(JSON.stringify(job));return job?.status==='completed'&&!s.jobs.some(row=>row.target===job.target&&['queued','running'].includes(row.status));},text+' settles');
}
try{
 child=spawn(process.env.NOZELI_TEST_BINARY||require('electron'),[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform='+ozone],{cwd:projectRoot,env,stdio:['ignore','pipe','pipe']});
 exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 browser.on('targetcreated',async target=>{const page=await target.page().catch(()=>null);page?.on('pageerror',error=>errors.push(error.message));});
 shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');
 await invoke(shell,'config.initialize',{mode:'independent'});
 if(await shell.$eval('#configuration-setup',node=>node.open).catch(()=>false))await shell.click('#configuration-cancel');
 await invoke(shell,'settings.providers.save',{operation:'create',provider:'approval-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-nonsecret'}});
 const model={model:{mode:'explicit',selector:'approval-local/scripted'},thinking:{mode:'native-default'}};
 await invoke(shell,'settings.models.save',{frontdesk:model,orchestrator:model,worker:model});
 await shell.click('[data-project-id="'+project.id+'"]');
 await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,project.id),'project binding');
 await invoke(shell,'managed.enable',{projectId:project.id});
 await invoke(shell,'managed.task',{projectId:project.id,text:'Create a candidate and HTML report for the isolated approval discussion smoke.',requestKey:'approval-smoke-initial-task'});
 const first=await until(async()=>{const s=await state();const w=s.works[0];if(s.jobs.some(j=>j.status==='failed'))throw Error(JSON.stringify(s.jobs.filter(j=>j.status==='failed')));return w?.status==='review'&&!s.jobs.some(j=>['queued','running'].includes(j.status))?s:null;},'initial review');
 const work=first.works[0],originalThread=work.threadId,originalReceipt=first.receipts.find(r=>r.workId===work.id&&r.kind==='result'),todo=first.todos.find(t=>t.workId===work.id&&t.kind==='result'&&t.status==='open');
 assert(todo&&originalReceipt);report.workId=work.id;report.threadId=originalThread;report.initialObjectId=originalReceipt.objectId;
 const sourceBefore=await fs.readFile(path.join(projectRoot,'candidate.txt'),'utf8');
 if(await shell.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')!=='true').catch(()=>false))await shell.click('#toggle-sidebar');
 await shell.waitForSelector('[data-managed-todo="'+todo.id+'"]',{visible:true});await shell.click('[data-managed-todo="'+todo.id+'"]');
 reviewPage=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.kind==='report').catch(()=>false))return p;},'native report workspace');
 await reviewPage.waitForSelector('[data-review-discussion]',{visible:true});await reviewPage.waitForSelector('[data-review-instruction]:not([disabled])',{visible:true});
 assert(await reviewPage.$('.managed-report-body'));assert.equal(await reviewPage.$eval('[data-review-discussion]',node=>Boolean(node.querySelector('.managed-report-body'))),false);
 await visibleReport('REVIEW_REPORT_V1');
 check('Todo opens the real report workspace and a separate nonmodal approval discussion; report body is not inside the float');await shot('approval-open');
 await send('DISCUSS_QUESTION');await reviewPage.waitForFunction(()=>document.querySelector('[data-review-discussion-history]')?.textContent.includes('REVIEW_ANSWER_ORIGINAL_THREAD'));
 let current=await state();assert.equal(current.works.length,1);assert.equal(current.works[0].threadId,originalThread);assert.equal(current.receipts.filter(r=>r.workId===work.id&&r.kind==='result').length,1);assert.equal(current.works[0].status,'review');
 assert.equal(await fs.readFile(path.join(projectRoot,'candidate.txt'),'utf8'),sourceBefore);
 check('Original Worker answers a pure review question in its original native thread without a new report or project mutation');
 await reviewPage.waitForFunction(()=>{const e=document.querySelector('[data-review-instruction]');return e&&!e.disabled&&!e.readOnly;});
 await reviewPage.$eval('[data-review-instruction]',node=>{node.value='DISCUSS_HOLD';node.dispatchEvent(new Event('input',{bubbles:true}));});await reviewPage.waitForSelector('[data-review-action="send"]:not([disabled])',{visible:true});await reviewPage.click('[data-review-action="send"]');
 await until(()=>trace.includes('DISCUSS_HOLD'),'held native discussion started');
 await reviewPage.waitForFunction(()=>{const e=document.querySelector('[data-review-instruction]');return e&&!e.disabled&&!e.readOnly;});
 await reviewPage.$eval('[data-review-instruction]',node=>{node.value='DISCUSS_QUEUED';node.dispatchEvent(new Event('input',{bubbles:true}));});await reviewPage.waitForSelector('[data-review-action="send"]:not([disabled])',{visible:true});await reviewPage.click('[data-review-action="send"]');
 await until(async()=>{const s=await state();return s.jobs.some(j=>j.text==='DISCUSS_QUEUED'&&j.status==='queued');},'second discussion durably queued');
 assert(!trace.includes('DISCUSS_QUEUED'),'second provider turn must not overlap held first turn');
 assert.equal(await reviewPage.$eval('[data-review-action="accept"]',node=>node.disabled),true);
 releaseQueuedTurn();
 await until(async()=>{const s=await state();return s.jobs.find(j=>j.text==='DISCUSS_QUEUED')?.status==='completed'&&s.works[0].status==='review';},'native FIFO discussions settle');
 await reviewPage.waitForFunction(()=>document.querySelector('[data-review-discussion-history]')?.textContent.includes('REVIEW_QUEUED_REPLY'));
 check('Busy approval input enters a durable FIFO queue, executes on the same native owner without overlap and blocks acceptance until drained');
 await send('DISCUSS_MODIFY');
 current=await state();assert.equal(current.works.length,1);assert.equal(current.works[0].threadId,originalThread);
 const publications=current.receipts.filter(r=>r.workId===work.id&&r.kind==='result');assert.equal(publications.length,2);const updated=publications.at(-1);assert.notEqual(updated.objectId,originalReceipt.objectId);
 await until(async()=>{
  const currentObject=await reviewPage.evaluate(()=>window.__workspaceScope.viewState?.report?.objectId);
  if(currentObject===updated.objectId)return true;
  const latest=await reviewPage.$('[data-review-action="latest-discussion"]:not([hidden])');
  if(!latest)return false;
  await latest.click();return true;
 },'explicit latest report entrance');
 await until(async()=>{const scope=await reviewPage.evaluate(()=>window.__workspaceScope);return scope.viewState?.report?.objectId===updated.objectId;},'latest main report publication binding');
 await visibleReport('REVIEW_REPORT_V2');
 assert.equal(await fs.readFile(path.join(projectRoot,'candidate.txt'),'utf8'),sourceBefore);
 check('Direct approval discussion modifies the real candidate, publishes a new immutable report and refreshes the main report without another Work');await shot('approval-updated');
 await reviewPage.waitForSelector('[data-review-file="candidate.txt"]',{visible:true});
 await reviewPage.click('[data-review-file="candidate.txt"]');
 const candidatePage=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(objectId=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.relPath==='candidate.txt'&&window.__workspaceScope.documentSource?.objectId===objectId,updated.objectId).catch(()=>false))return p;},'single candidate native document');
 await candidatePage.waitForFunction(()=>window.__nozeliInput?.text().includes('updated candidate from approval discussion'));
 assert.equal(await reviewPage.$('dialog[open]'),null,'opening the candidate leaves no modal over the review');
 const reportViewId=await reviewPage.evaluate(()=>window.__workspaceScope.viewId),layout=await shell.evaluate(()=>window.__workspaceGroups.snapshot());
 await invoke(shell,'workspace.command',{projectId:project.id,expectedRevision:layout.revision,requestKey:'approval-smoke-return-report',command:{type:'activate',viewId:reportViewId}});
 check('Single-file review directly opens the exact native candidate and returns without a leftover modal or project overwrite');
 await send('DISCUSS_AFTER');await reviewPage.waitForFunction(()=>document.querySelector('[data-review-discussion-history]')?.textContent.includes('REVIEW_ANSWER_AFTER_UPDATE'));
 await reviewPage.$eval('[data-review-instruction]',node=>{node.value='UNSENT_APPROVAL_DRAFT';node.dispatchEvent(new Event('input',{bubbles:true}));});
 await reviewPage.click('[data-review-action="hide-discussion"]');await reviewPage.click('[data-review-action="open-discussion"]');
 assert.equal(await reviewPage.$eval('[data-review-instruction]',node=>node.value),'UNSENT_APPROVAL_DRAFT');
 for(const theme of ['light','dark'])for(const width of [1440,800]){
  await invoke(shell,'settings.appearance.save',{theme,palette:'sage',font:'system',size:14});
  await invoke(shell,'workspace.control',{type:'window-control',action:'resize',width,height:width===800?650:900});
  await reviewPage.waitForFunction(theme=>document.documentElement.dataset.theme===theme,{},theme);
  await reviewPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await reviewPage.$eval('[data-review-instruction]',node=>node.value),'UNSENT_APPROVAL_DRAFT');
  await shot('approval-'+theme+'-'+width);
 }
 for(const size of [{width:654,height:1150},{width:390,height:844},{width:390,height:480}]){
  await invoke(shell,'workspace.control',{type:'window-control',action:'resize',...size});
  await reviewPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const geometry=await reviewPage.evaluate(()=>{const float=document.querySelector('[data-review-discussion]').getBoundingClientRect(),accept=document.querySelector('[data-review-action="accept"]').getBoundingClientRect();return {left:float.left,right:float.right,bottom:float.bottom,actionBottom:accept.bottom,width:innerWidth,height:innerHeight};});
  assert(geometry.left>=-1&&geometry.right<=geometry.width+1&&geometry.bottom<=geometry.height+1&&geometry.actionBottom<=geometry.height+1,'approval controls fit actual narrow surface: '+JSON.stringify(geometry));
  await shot('approval-'+size.width+'x'+size.height);
 }
 await invoke(shell,'workspace.control',{type:'window-control',action:'resize',width:1280,height:900});
 check('Actual narrow and short native report surfaces retain the approval window and visible footer controls');
 check('Latest report discussion remains in the original thread, and collapsing/reopening retains the Work-scoped unsent draft');
 await reviewPage.waitForSelector('[data-review-action="accept"]:not([disabled])',{visible:true});await reviewPage.click('[data-review-action="accept"]');await reviewPage.waitForSelector('[data-confirmation-dialog][open]');report.acceptConfirmation=await reviewPage.$eval('[data-confirmation-dialog]',node=>node.innerText);await shot('approval-accept-confirmation');await reviewPage.click('[data-confirmation-cancel]');
 assert.equal((await state()).works[0].status,'review');
 await reviewPage.click('[data-review-action="accept"]');await reviewPage.waitForSelector('[data-confirmation-dialog][open]');await reviewPage.click('[data-confirmation-confirm]');
 await until(async()=>{const w=(await state()).works[0];return ['closing','ended'].includes(w.status)&&w.outcome==='accept';},'exact-version accept recorded');
 await until(async()=>{const w=(await state()).works[0];if(w.closure?.phase==='blocked')throw Error('closure blocked: '+JSON.stringify(w.closure));return w.status==='ended'&&w.closure?.phase==='complete';},'host merge and original task closure',60000);
 assert.equal(await fs.readFile(path.join(projectRoot,'candidate.txt'),'utf8'),'updated candidate from approval discussion\n');
 const final=await state();assert.equal(final.works.length,1);assert.equal(final.jobs.filter(j=>j.text==='UNSENT_APPROVAL_DRAFT').length,0);assert.equal(final.works[0].threadId,originalThread);
 check('Footer acceptance supports cancel then explicit exact-version accept, starts original closure and does not dispatch the unsent draft');
 assert.deepEqual(provider.errors,[]);assert.deepEqual(errors,[]);report.providerCalls=provider.requests.length;report.trace=trace;report.finalStatus=final.works[0].status;report.ok=true;
 await invoke(shell,'session.requestClose');assert.deepEqual(await Promise.race([exit,pause(20000).then(()=>null)]),{code:0,signal:null});child=null;
}catch(error){report.error=error.stack;process.exitCode=1;report.surface=await reviewPage?.evaluate(()=>({scope:window.__workspaceScope,text:document.body.innerText.slice(-7000)})).catch(()=>null);await reviewPage?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{
 releaseQueuedTurn();
 if(child?.exitCode===null){try{await invoke(shell,'session.requestClose');await Promise.race([exit,pause(10000)]);}catch{}if(child.exitCode===null)child.kill('SIGTERM');}
 await browser?.disconnect().catch(()=>{});await provider.close();report.errors=errors;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));
}
