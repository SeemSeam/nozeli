import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';
import {createAcceptanceCollector} from './acceptance-request-control.mjs';
import {runParallelAudit} from './parallel-workflow.fixture.mjs';
import {runQueueAudit} from './queue-workflow.fixture.mjs';
import {runConflictAudit} from './conflict-workflow.fixture.mjs';
import {runNativeFailureAudit} from './native-failure-workflow.fixture.mjs';
import {runRendererFailureAudit} from './renderer-failure-workflow.fixture.mjs';
import {runReasoningAudit} from './reasoning-workflow.fixture.mjs';
import {runBookingAudit,flushBookingTelemetry} from './booking-workflow.fixture.mjs';
import {runBookingResumeAudit} from './booking-resume-workflow.fixture.mjs';
import {processStamp} from '../src/agents/managed/process-ownership.mjs';
const [release,prior]=process.argv.slice(2);
const failurePolicyProbe=process.env.NOZELI_AUDIT_FAILURE_POLICY_PROBE==='1';
const baseline=JSON.parse(await fs.readFile(path.join(prior,'report.json'),'utf8'));
const project=process.env.NOZELI_AUDIT_PROJECT||path.join(prior,'sensor-audit'),profile=process.env.NOZELI_AUDIT_PROFILE||baseline.profile;let runtime=null;
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-workflow-continuation-'));
const result={out,release,prior,profile,project,checks:[],screenshots:[],events:[],notRun:[],scope:'Actual fixed Electron candidate, real native OMP, owned project and Work; GUI business decisions.'};
const protection=process.env.NOZELI_AUDIT_PROTECTION_MANIFEST?JSON.parse(await fs.readFile(process.env.NOZELI_AUDIT_PROTECTION_MANIFEST,'utf8')):null;
async function checkProtection(phase){
 if(!protection)return;
 const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 for(const entry of [protection,...(protection.additionalStates??[])]){const store=JSON.parse(await fs.readFile(entry.stateFile,'utf8'));assert.equal(digest({works:store.works,jobs:store.jobs,drafts:store.drafts}),entry.stateDigest,'Protected original Work/job/draft state changed');}
 for(const file of protection.files)assert.equal(createHash('sha256').update(await fs.readFile(file.path)).digest('hex'),file.digest,'Protected original file changed: '+file.path);
 (result.protection??=[]).push({at:Date.now(),phase,stateUnchanged:true,filesUnchanged:protection.files.length});
}
const collector=await createAcceptanceCollector({ledgerPath:path.join(out,'requests.json'),maxAttempts:null,maxInputOutput:null,deadlineAt:null,allowedDestinations:failurePolicyProbe?[]:[...new Set(baseline.requests.policy.allowedDestinations.flatMap(url=>[url,url.replace('xyz/','xyz/v1/')]))],allowedModels:baseline.requests.policy.allowedModels});
if(process.env.NOZELI_AUDIT_REASONING_SETUP||process.env.NOZELI_AUDIT_RENDERER_FAILURE==='1'||failurePolicyProbe)console.log(JSON.stringify({out,release,stage:failurePolicyProbe?'starting-zero-failure-policy-probe':process.env.NOZELI_AUDIT_REASONING_SETUP?'starting-real-reasoning':'starting-real-renderer-failure',modelPolicy:'Cumulative HTTP/token accounting; no numeric cap; no automatic replay'}));
let child,browser,shell,chat,observer,exited,projectId,log='',stage='launch',instrumented=[];
async function bounded(promise,label,ms=5000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' observation timeout')),ms);})]);}finally{clearTimeout(timer);}}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(fn,label,timeout=120000){const end=Date.now()+timeout;do{if(collector.snapshot().stopped)throw Error('Collector safety stop: '+collector.snapshot().stopped);const value=await fn();if(value)return value;await pause(200);}while(Date.now()<end);throw Error('Observation timeout: '+label+'; no automatic replay');}
async function call(op,payload={},page=shell){const response=await page.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);if(!response.ok)throw Object.assign(Error(op+': '+response.error.message),{code:response.error.code});return response.value;}
const state=async()=>(await call('managed.status',{projectId})).state;
async function scoped(kind,todoId){return wait(async()=>{for(const p of await browser.pages())if(await p.evaluate(({kind,todoId})=>window.__workspaceScope?.kind===kind&&window.__nozeliReady&&(!todoId||window.__workspaceScope.viewState?.report?.todoId===todoId),{kind,todoId}).catch(()=>false))return p;},kind);}
async function shot(label,page){await page.screenshot({path:path.join(out,label+'.png')});result.screenshots.push(label+'.png');}
async function checkpoint(){result.requests=collector.snapshot();await fs.writeFile(path.join(out,'report.json'),JSON.stringify({...result,stage},null,2));await fs.writeFile(path.join(out,'electron.log'),log);}
async function compose(text,background=false,expectedTarget=background?'frontdesk':null){chat=await scoped('conversation');if(expectedTarget)await chat.waitForFunction(target=>document.querySelector('#conversation-panel')?.dataset.managedConversation===target,{},expectedTarget);await chat.locator('#composer').click();await chat.keyboard.down('Control');await chat.keyboard.press('A');await chat.keyboard.up('Control');await chat.keyboard.sendCharacter(text);assert.equal(await chat.$eval('#composer',n=>n.value),text);const jobs=new Set((await state()).jobs.map(j=>j.id));const at=Date.now();if(background)await chat.locator('#managed-submit-task').click();else{await chat.keyboard.down('Control');await chat.keyboard.press('Enter');await chat.keyboard.up('Control');}const job=await wait(async()=>(await state()).jobs.find(j=>!jobs.has(j.id)),'job accepted',30000);if(expectedTarget&&!background)assert.equal(job.target,expectedTarget);result.events.push({kind:'input',jobId:job.id,target:job.target,at});return job;}
async function review(workId){return wait(async()=>{const s=await state(),work=s.works.find(w=>w.id===workId);if(work?.status==='paused')throw Error('Work paused for user action: '+JSON.stringify(work.problem||work.deviation));if(s.jobs.some(j=>j.target===workId&&['failed','unknown','interrupted'].includes(j.status)))throw Error('Worker execution failed or uncertain');return work?.status==='review'&&!s.busyTargets.includes(workId)?work:false;},'Worker review',600000);}
async function openReport(work){if(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await shell.click('#toggle-sidebar');const s=await state(),todo=s.todos.filter(t=>t.workId===work.id&&t.kind==='result'&&t.revision===work.revision).at(-1);assert(todo);await shell.locator('[data-managed-todo="'+todo.id+'"]').click();const page=await scoped('report',todo.id);await page.waitForSelector('#managed-result-actions');return page;}
async function decision(work,action){const page=await openReport(work),selector=action==='accept'?'[data-managed-end-result]':'[data-managed-end-discard]';const retry=await page.$('[data-disposition-unavailable] button');if(retry)await retry.click();await page.waitForFunction(selector=>!document.querySelector(selector)?.disabled,{},selector);await shot(action+'-before',page);page.once('dialog',dialog=>dialog.accept());await page.locator(selector).click();return wait(async()=>{const w=(await state()).works.find(w=>w.id===work.id);if(w?.closure?.phase==='blocked')throw Error('User outcome ended but technical closure blocked: '+JSON.stringify(w.closure));return w?.status==='ended'&&w.closure?.phase==='complete'?w:false;},action+' closure',120000);}
try{
 await checkProtection('before-new-process');
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key))delete env[key];Object.assign(env,{HOME:'/home/bfly',NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:'/home/bfly/.Nozeli',NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out});
 child=spawn(path.join(release,'nozeli'),['--ozone-platform=wayland','--inspect=0'],{cwd:project,env,stdio:['ignore','pipe','pipe']});exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes);
 result.processOwner={pid:child.pid,stamp:await processStamp(child.pid),release,profile,project};assert(result.processOwner.stamp,'Owned test process has a birth stamp');
 const inspect=await wait(()=>log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'Inspector');observer=await MainObserver.connect(inspect);
 const moduleSource=(await fs.readFile(path.join(import.meta.dirname,'acceptance-request-control.mjs'),'utf8')).replace("'../src/agents/managed/process-ownership.mjs'","'./audit-process-ownership.mjs'");const ownershipSource=await fs.readFile(path.resolve(import.meta.dirname,'../src/agents/managed/process-ownership.mjs'),'utf8');
 // Test-only startup instrumentation: no installed bytes, credentials or task results are changed.
 await wait(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'browser');shell=await wait(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__workspaceScope?.role==='shell'&&window.__nozeliReady).catch(()=>false))return p;},'shell');
 const canonicalProject=await fs.realpath(project),registered=(await call('project.recent')).projects.find(p=>p.rootDisplay===canonicalProject||p.root===canonicalProject);assert(registered,'Exact owned project directory is registered');projectId=registered.id;runtime=path.join(profile,'nozeli','managed-v1',projectId,'runtime');result.projectId=projectId;
 const auditRuntimeRoots=[runtime];if(process.env.NOZELI_AUDIT_BOOKING_SETUP){const booking=JSON.parse(await fs.readFile(process.env.NOZELI_AUDIT_BOOKING_SETUP,'utf8'));assert.equal(booking.projectId,projectId);assert.equal(booking.profile,profile);assert(/^[a-f0-9]{64}$/.test(booking.projectBId));auditRuntimeRoots.push(path.join(profile,'nozeli','managed-v1',booking.projectBId,'runtime'));}
 await observer.evaluate(`(async()=>{
  const req=process.mainModule.require.bind(process.mainModule),fs=req('node:fs/promises'),syncfs=req('node:fs'),path=req('node:path');
  const {OmpTuiSession}=req(${JSON.stringify(path.join(release,'resources/app/src/agents/managed/omp-tui-session.mjs'))}),{prepareOmpPrivateHome}=req(${JSON.stringify(path.join(release,'resources/app/src/agents/managed/omp-provider-home.mjs'))}),{processStamp}=req(${JSON.stringify(path.join(release,'resources/app/src/agents/managed/process-ownership.mjs'))}),{parse,stringify}=req('yaml');
  const {observeSyncBarrier}=req(${JSON.stringify(path.join(import.meta.dirname,'sync-barrier-observer.fixture.mjs'))}),{openFrame}=req(${JSON.stringify(path.join(release,'resources/app/src/agents/managed/collab/guest.mjs'))});
  const {observeRelayPeers}=req(${JSON.stringify(path.join(import.meta.dirname,'relay-peer-observer.fixture.mjs'))}),{WebSocketServer}=req('ws');globalThis.auditNativeInstances=new Set();
  globalThis.auditPeerObserver=observeRelayPeers(WebSocketServer,{onEvent:row=>{syncfs.appendFileSync(${JSON.stringify(path.join(out,'relay-peer-events.jsonl'))},JSON.stringify(row)+String.fromCharCode(10));}});
  const originalStart=OmpTuiSession.prototype.start,originalStop=OmpTuiSession.prototype.stop;
  globalThis.auditHomes=[];globalThis.auditHomeExtensions=new Map();globalThis.auditLifecycle=[];globalThis.auditObserverErrors=[];globalThis.auditSyncObservers=new Set();
  const record=(phase,session,extra={})=>{const row={at:Date.now(),phase,target:session.collabContext?.targetId||session.role,ownerId:session.viewOwnerId,threadId:session.threadId,pid:session.pid,...extra};auditLifecycle.push(row);try{syncfs.appendFileSync(${JSON.stringify(path.join(out,'native-lifecycle.jsonl'))},JSON.stringify(row)+String.fromCharCode(10));}catch(error){auditObserverErrors.push({stage:'lifecycle-metadata',code:error.code||'UNKNOWN'});}};
  const caller=()=>new Error().stack.split(String.fromCharCode(10)).slice(2,8).map(line=>line.split(${JSON.stringify(release)}).join('<candidate>').split(${JSON.stringify(runtime)}).join('<owned-runtime>'));
  OmpTuiSession.prototype.start=async function(...args){
   if(!${JSON.stringify(auditRuntimeRoots.map(root=>root+path.sep+'agents'+path.sep))}.some(root=>this.home.startsWith(root)))throw Error('Unowned role instrumentation');
   record('native-start-request',this,{requestedThreadId:args[0]?.id||null,caller:caller()});
   await prepareOmpPrivateHome(this.home,{system:this.ompSystemSource});
   await fs.writeFile(path.join(this.home,'audit-request-control.mjs'),${JSON.stringify(moduleSource)});await fs.writeFile(path.join(this.home,'audit-process-ownership.mjs'),${JSON.stringify(ownershipSource)});
   const extension=path.join(this.home,'audit-observer.mjs');await fs.writeFile(extension,'import{installAcceptanceControl}from "./audit-request-control.mjs";export default pi=>installAcceptanceControl(pi,{endpoint:'+JSON.stringify(${JSON.stringify(collector.endpoint)})+',roleInstance:process.env.NOZELI_AGENT_DIR,brokerURL:process.env.OMP_AUTH_BROKER_URL||null});');
   const file=path.join(this.home,'config.yml'),doc=parse(await fs.readFile(file,'utf8'))||{};
   if(!auditHomeExtensions.has(this.home)){auditHomeExtensions.set(this.home,doc.extensions||[]);await fs.writeFile(${JSON.stringify(path.join(out,'home-extensions.json'))},JSON.stringify([...auditHomeExtensions].map(([home,extensions])=>({home,extensions}))));}
   doc.extensions=[...(doc.extensions||[]).filter(p=>p!==extension),extension];await fs.writeFile(file,stringify(doc));auditHomes.push(this.home);
   if(!this.auditSpawnWrapped){const onSpawn=this.onSpawn;this.auditSpawnWrapped=true;this.onSpawn=async pid=>{this.auditPidStamp=await processStamp(pid);record('native-spawn',this,{pid,stamp:this.auditPidStamp});await onSpawn?.(pid);};}
   try{const value=await originalStart.apply(this,args);auditNativeInstances.add(this);if(this.collab&&this.auditSyncRuntime!==this.collab){this.auditSyncRuntime=this.collab;this.auditSyncObserver=observeSyncBarrier(this.collab,{decodeFrame:openFrame,onEvent:row=>{syncfs.appendFileSync(${JSON.stringify(path.join(out,'sync-wire-events.jsonl'))},JSON.stringify({target:this.collabContext?.targetId||this.role,ownerId:this.viewOwnerId,threadId:this.threadId,pid:this.pid,stamp:this.auditPidStamp,jobId:this.currentTicket?.job?.id||this.currentTicket?.jobId||null,...row})+String.fromCharCode(10));}});auditSyncObservers.add(this.auditSyncObserver);auditPeerObserver.bind(this.collab,{target:this.collabContext?.targetId||this.role,ownerId:this.viewOwnerId,threadId:this.threadId,pid:this.pid,stamp:this.auditPidStamp});}record('native-start-call-complete',this,{stamp:await processStamp(this.pid)});return value;}catch(error){record('native-start-failed',this,{code:error.code||error.name});throw error;}
  };
  OmpTuiSession.prototype.stop=async function(...args){record('native-stop-request',this,{recover:args[0]?.recover===true,alreadyStopping:Boolean(this.stopPromise),caller:caller()});try{const value=await originalStop.apply(this,args);if(this.auditSyncObserver?.errors.length)auditObserverErrors.push(...this.auditSyncObserver.errors.map(error=>({stage:'sync-metadata',...error})));auditSyncObservers.delete(this.auditSyncObserver);this.auditSyncObserver?.();record('native-stop-call-complete',this,{confirmed:value?.confirmationComplete===true});return value;}catch(error){record('native-stop-failed',this,{code:error.code||error.name});throw error;}};
  return true;
 })()`,20000);
 await observer.evaluate(`(()=>{
  const req=process.mainModule.require.bind(process.mainModule),ipc=req('electron').ipcMain,fs=req('node:fs'),original=ipc._invokeHandlers.get('nozeli:invoke');globalThis.auditCalls=[];globalThis.auditRpcEvents=[];
  const watched=new Set(['managed.send','managed.task','managed.enable','managed.project.active','managed.connect','managed.session','managed.restart','managed.terminal.attach','session.requestClose','session.quitChoice','workspace.control']);
  const record=row=>{auditRpcEvents.push(row);try{fs.appendFileSync(${JSON.stringify(path.join(out,'rpc-events.jsonl'))},JSON.stringify(row)+String.fromCharCode(10));}catch(error){(globalThis.auditObserverErrors??=[]).push({stage:'rpc-metadata',code:error.code||'UNKNOWN'});}};
  ipc._invokeHandlers.set('nozeli:invoke',async(event,op,payload)=>{const id=watched.has(op)?auditRpcEvents.length+1:null,start={id,at:Date.now(),phase:'request',op,target:payload?.target,type:payload?.type,action:payload?.action,choice:payload?.choice};if(id)record(start);try{const response=await original(event,op,payload);const receipt={at:Date.now(),op,target:payload?.target,ok:response.ok,error:response.error?.code,accepted:response.value?.accepted,jobId:response.value?.jobId};if(id)record({...receipt,id,phase:'response'});if(['managed.send','managed.task'].includes(op))auditCalls.push(receipt);return response;}catch(error){if(id)record({id,at:Date.now(),phase:'throw',op,code:error.code||error.name});throw error;}});
  return true;
 })()`);
 await shell.locator('[data-project-id="'+projectId+'"]').click();await wait(async()=>(await call('workspace.bootstrap')).projectId===projectId,'exact project scope committed');if(!(await call('managed.status',{projectId})).enabled)await call('managed.enable',{projectId});await call('managed.connect',{projectId});if(!process.env.NOZELI_AUDIT_BOOKING_SETUP)for(const target of ['frontdesk','orchestrator'])await call('managed.restart',{projectId,target});await shell.locator('#workspace-open-conversation').click();chat=await scoped('conversation');await wait(()=>collector.snapshot().events.filter(e=>e.kind==='loaded').length>=2,'resident observer loading');
 if(failurePolicyProbe&&process.env.NOZELI_AUDIT_IDLE_PROBE_MS){const duration=Number(process.env.NOZELI_AUDIT_IDLE_PROBE_MS);assert(Number.isFinite(duration)&&duration>0);result.idleParity={startedAt:Date.now(),durationMs:duration};await pause(duration);result.idleParity.endedAt=Date.now();result.idleParity.sessions=await observer.evaluate('[...globalThis.auditNativeInstances].filter(session=>!session.closed).map(session=>({role:session.role,pid:session.pid,isolated:Boolean(session.isolation),sourceManaged:Boolean(session.ompSystemSource),brokerPresent:Boolean(session.ompAuthBroker),threadId:session.threadId,wsState:session.collab?.guest?.ws?.readyState,hostEnded:session.collab?.guest?.hostEnded===true,transport:session.collab?.diagnostics()}))');}
 if(failurePolicyProbe){stage='failure-policy-probe';throw Error('Intentional zero-model probe: preserve before any exit intervention');}
 if(process.env.NOZELI_AUDIT_BOOKING_RESUME){
  stage='booking-resume';await runBookingResumeAudit({state,call,wait,shell,shot,result,out,fs,path,scoped,openReport,checkpoint,observer,browser});result.ok=true;stage='complete-booking-resume';
 }else
 if(process.env.NOZELI_AUDIT_BOOKING_SETUP){
  stage='booking-interaction';await runBookingAudit({state,compose,call,wait,pause,shell,shot,result,out,fs,path,scoped,review,openReport,checkpoint,observer,browser,collector});result.ok=true;stage='complete-booking-interaction';
 }else
 if(process.env.NOZELI_AUDIT_REASONING_SETUP){
  stage='content-reasoning';await runReasoningAudit({state,compose,call,wait,shell,shot,result,out,fs,path,scoped,review,openReport,checkpoint});result.ok=true;stage='complete-content-reasoning';
 }else
 if(process.env.NOZELI_AUDIT_RENDERER_FAILURE==='1'){
  stage='renderer-failure';await runRendererFailureAudit({state,compose,call,wait,pause,shell,shot,result,out,fs,path,scoped,observer,openReport});result.ok=true;stage='complete-renderer-failure';
 }else
 if(process.env.NOZELI_AUDIT_NATIVE_FAILURE==='1'){
  stage='native-failure';await runNativeFailureAudit({state,compose,call,wait,pause,shell,shot,result,out,fs,path,scoped,browser,collector});result.ok=true;stage='complete-native-failure';
 }else
 if(process.env.NOZELI_AUDIT_CLEANUP==='1'){
  stage='review-cleanup';const before=await state();for(const work of before.works.filter(w=>['长工具A','长工具B'].includes(w.name)&&w.status==='review'))await decision(work,'discard');assert.deepEqual((await state()).jobs.map(j=>j.id),before.jobs.map(j=>j.id));result.checks.push('Remaining completed parallel Work explicitly discarded without new jobs');result.ok=true;stage='complete-cleanup';
 }else if(process.env.NOZELI_AUDIT_CONFLICT==='1'){
  stage='unsaved-conflict';await runConflictAudit({state,compose,call,wait,pause,shell,shot,result,out,fs,path,scoped,openReport,browser});result.ok=true;stage='complete-conflict';
 }else
 if(process.env.NOZELI_AUDIT_QUEUE_ONLY==='1'){
  stage='queue-only';await runQueueAudit({state,compose,call,wait,pause,shell,shot,result,out,fs,path});result.ok=true;stage='complete-queue';
 }else
 if(process.env.NOZELI_AUDIT_PARALLEL==='1'){
  stage='parallel-and-queue';await runParallelAudit({state,compose,call,wait,pause,shell,shot,decision,result,out,fs,path});result.ok=true;stage='complete-parallel';
 }else{
 const initial=await state();const algorithm=initial.works.find(w=>w.name==='算法修正');assert.equal(algorithm.revision,2);assert.deepEqual(algorithm.execution.candidate.files,['src/aggregate.ts']);result.algorithmIdentity={id:algorithm.id,threadId:algorithm.threadId};await call('managed.limit',{projectId,limit:2});assert.equal((await state()).limit,2);
 stage='remaining-document';const originalJobIds=new Set(initial.jobs.map(j=>j.id));await compose('只补建此前尚未建立的独立文档工作，名称为“操作指南补全”。只修改 docs/operator-guide.md，依据 materials 四份材料及 docs/method.md 的已澄清规则，说明UTC+08、最后有效重复值、所有无有效读数日输出null，并给出跨日样例。算法工作已经存在，不要重建、续改或处置它。不改源码、材料或验收程序。只交付候选报告，不自动采用。',true);
 const documentWork=await wait(async()=>{const s=await state();const work=s.works.find(w=>w.id!==algorithm.id);if(work)return work;const jobs=s.jobs.filter(j=>!originalJobIds.has(j.id));if(jobs.length&&jobs.every(j=>['completed','failed','interrupted'].includes(j.status))&&!s.busyTargets.length)throw Error('Routing settled without remaining document Work');return false;},'remaining Work dispatch',180000);const docs=await review(documentWork.id);assert.notEqual(docs.threadId,algorithm.threadId);assert((await fs.readFile(path.join(docs.execution.directory,'docs/operator-guide.md'),'utf8')).includes('null'));assert.equal(await fs.readFile(path.join(project,'docs/operator-guide.md'),'utf8'),'# Operator guide\nPending implementation.\n');result.checks.push('Only remaining document goal creates independent real Work and candidate');await shot('document-review',await openReport(docs));
 stage='human-edit';await shell.locator('#workspace-open-conversation').click();chat=await scoped('conversation');await chat.keyboard.down('Control');await chat.keyboard.press('P');await chat.keyboard.up('Control');await chat.waitForSelector('#quick-open[open]');await chat.type('#quick-open-input','user-notes.txt');await chat.waitForSelector('[data-open-target="current"]');await chat.locator('[data-open-target="current"]').click();const docPage=await scoped('document');await docPage.waitForSelector('#text-host .cm-content');await docPage.locator('#text-host .cm-content').click();await docPage.keyboard.down('Control');await docPage.keyboard.press('End');await docPage.keyboard.up('Control');await docPage.keyboard.sendCharacter('HUMAN_SENTINEL_'+path.basename(out));await wait(async()=>(await fs.readFile(path.join(project,'user-notes.txt'),'utf8')).includes('HUMAN_SENTINEL_'),'human autosave');const sentinel=await fs.readFile(path.join(project,'user-notes.txt'),'utf8');result.checks.push('Real keyboard human edit persisted; not claimed as unsaved conflict');
 stage='disposition';const algorithmEnded=await decision(algorithm,'accept');assert.equal(algorithmEnded.outcome,'accept');const discarded=await decision(docs,'discard');assert.equal(discarded.outcome,'discard');assert.equal(await fs.readFile(path.join(project,'user-notes.txt'),'utf8'),sentinel);assert.equal(await fs.readFile(path.join(project,'docs/operator-guide.md'),'utf8'),'# Operator guide\nPending implementation.\n');assert((await fs.readFile(path.join(project,'src/aggregate.ts'),'utf8')).includes('Map<string'));result.checks.push('Actual report GUI acceptance and discard close both Works with human content preserved');
 const run=promisify(execFile),build=path.join(out,'adopted-build');await run(process.execPath,[path.resolve(import.meta.dirname,'../node_modules/typescript/bin/tsc'),'src/aggregate.ts','--target','es2022','--module','commonjs','--outDir',build,'--skipLibCheck'],{cwd:project});const actual=JSON.parse((await run(process.execPath,[path.join(build,'aggregate.js'),path.join(project,'materials/readings.csv')])).stdout);assert.deepEqual(actual,[{day:'2026-01-01',mean:10},{day:'2026-01-02',mean:22},{day:'2026-01-03',mean:null}]);result.checks.push('Adopted source independently compiles and returns oracle result');
 const final=await state();await fs.writeFile(path.join(out,'final-state.json'),JSON.stringify(final,null,2));result.finalJobs=final.jobs.map(j=>j.id);result.notRun.push('True unsaved same-file conflict remains untested','Two concurrently running Workers and failure injection remain untested');result.ok=true;stage='complete-business-chain';
 }
 await checkProtection('after-case');
}catch(error){
 result.ok=false;result.failure={stage,code:error.code,message:error.message,stack:error.stack,observedAt:Date.now()};process.exitCode=1;
 // Capture before screenshots, recovery, close requests or cancellation can
 // change the state. A failed observation is unknown, never a substitute fact.
 if(projectId&&shell){const snapshot=await bounded(state(),'failure state').catch(cause=>{result.failure.stateUnavailable=cause.message;return null;});await fs.writeFile(path.join(out,'failure-state.json'),JSON.stringify(snapshot,null,2));result.failure.stateWrittenAt=Date.now();}
 if(observer)result.nativeTransportFailures=await bounded(observer.evaluate(`([...globalThis.auditNativeInstances].map(session=>{const text=(session.replayFrames||[]).map(frame=>frame.data).join('').replace(/\\x1b\\[[0-?]*[ -/]*[@-~]/g,'');return {target:session.collabContext?.targetId||session.role,pid:session.pid,threadId:session.threadId,closed:session.closed,sendBacklogExceeded:text.includes('Collab ended: collab send backlog exceeded its limit')};}).filter(row=>row.sendBacklogExceeded))`),'native failure category').catch(()=>null);
 try{await checkProtection('failure-before-intervention');}catch(cause){result.protectionFailure={at:Date.now(),message:cause.message};}
 if(shell)await bounded(shot('failure-shell',shell),'failure shell screenshot',3000).catch(()=>{});
 if(chat)await bounded(shot('failure-chat',chat),'failure chat screenshot',3000).catch(()=>{});
}finally{
 result.interventions??=[];
 if(process.env.NOZELI_AUDIT_BOOKING_SETUP&&browser)try{await flushBookingTelemetry({browser,fs,path,out,result,phase:'driver-finally'});}catch(error){result.telemetryFailure={message:error.message};result.failure??={stage:'booking-telemetry',message:error.message};result.ok=false;process.exitCode=1;}
 if(observer){result.inputReceipts=await bounded(observer.evaluate('globalThis.auditCalls||[]'),'input receipts').catch(()=>[]);instrumented=await bounded(observer.evaluate('globalThis.auditHomes||[]'),'instrumentation owners').catch(()=>[]);result.diagnosticErrors=await bounded(observer.evaluate('[...(globalThis.auditObserverErrors||[]),...(globalThis.auditPeerObserver?.errors||[]).map(error=>({stage:"relay-peer-metadata",...error})),...[...(globalThis.auditSyncObservers||[])].flatMap(observer=>observer.errors.map(error=>({stage:"live-sync-metadata",...error})))]'),'diagnostic errors').catch(()=>[{stage:'observer-unavailable'}]);if(result.diagnosticErrors.length){result.failure??={stage:'diagnostic-observation',message:'Required metadata could not be preserved'};result.ok=false;process.exitCode=1;}observer.close();}
 if(child?.exitCode===null&&!result.failure&&shell){
  result.interventions.push({at:Date.now(),action:'request-normal-close'});await bounded(call('session.requestClose'),'normal close request').catch(error=>{result.closeError=error.message;});await pause(300);
  if(await bounded(shell.$eval('#quit-choice',node=>node.open),'quit choice').catch(()=>false)){
   // Declining a close is not a business cancellation. Never click quit-cancel.
   await shell.click('#quit-stay');result.interventions.push({at:Date.now(),action:'decline-implicit-business-cancellation'});result.failure={stage:'normal-close',message:'Busy work requires explicit operator disposition; preserved'};result.ok=false;process.exitCode=1;
  }else if(!await Promise.race([exited,pause(15000).then(()=>null)])){result.failure={stage:'normal-close',message:'Normal close did not finish; preserved'};result.ok=false;process.exitCode=1;}
 }
 if(child?.exitCode===null){
  result.processPreserved=true;result.interventions.push({at:Date.now(),action:'failure-preserve-no-close-no-cancel',processOwner:result.processOwner});
  result.requests=collector.snapshot();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(out,'electron.log'),log);
  console.log(JSON.stringify({out,stage:'failed-preserved-awaiting-operator',processOwner:result.processOwner,failure:result.failure}));
  // Keep admission accounting and the owned app alive. The operator must choose
  // any recovery/exit explicitly; launch this manual journey with no outer kill
  // deadline. An eventual app exit is separately recorded, not natural success.
  result.operatorExit=await exited;result.interventions.push({at:Date.now(),action:'externally-initiated-exit',exit:result.operatorExit});
 }
 await browser?.disconnect();const {parse,stringify}=await import('yaml');
 try{await checkProtection('after-owned-process-exit');}catch(cause){result.protectionFailure={at:Date.now(),message:cause.message};result.ok=false;process.exitCode=1;}
 const homes=await fs.readFile(path.join(out,'home-extensions.json'),'utf8').then(JSON.parse).catch(()=>instrumented.map(home=>({home,extensions:null})));
 for(const {home,extensions} of homes){const file=path.join(home,'config.yml');try{const doc=parse(await fs.readFile(file,'utf8'));doc.extensions=extensions??(doc.extensions||[]).filter(p=>p!==path.join(home,'audit-observer.mjs'));await fs.writeFile(file,stringify(doc));}catch(error){if(error.code!=='ENOENT')result.cleanupError=error.message;}}
 result.requests=collector.snapshot();await collector.close();result.exit=child?{code:child.exitCode,signal:child.signalCode}:null;
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(out,'electron.log'),log);
 console.log(JSON.stringify({out,stage,ok:result.ok,failure:result.failure,http:Object.keys(result.requests.attempts).length,loaded:result.requests.events.filter(e=>e.kind==='loaded').length,exit:result.exit,processPreserved:result.processPreserved}));
}
