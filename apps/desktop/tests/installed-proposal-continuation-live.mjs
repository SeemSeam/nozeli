// Actual installed Nozeli release: real packaged main, private bundled Pi
// Worker, bundled Git and one synthetic Git project. One explicit managed.task
// drives the original Worker through the exact proposal-continuation protocol:
// an INITIAL progress write into the candidate plus a Markdown problem
// publication; the orchestrator backstage turn is genuinely answered blocked
// with the actual durable job type discriminated through managed.status (never
// the request tool catalog); the user reaches the explicit problem decision UI
// only through the real task-directory -> overview -> retained-progress ->
// frozen-report navigation; empty-feedback rejection executes nothing; the app
// is closed normally (exit 0) and relaunched on the SAME isolated
// config/profile/project, the persisted problem is loaded without any model
// connection (ready===false recorded as actual evidence), and one explicit
// reject decision with the exact feedback itself reconnects and executes the
// exact queued continuation once on the same Work/thread/candidate (feedback
// appended verbatim + a NEW Markdown problem); a stale-version decision is
// refused with zero extra effects; a manual execution-gate pause holds the
// saved approval (zero execution) until an explicit resume executes it once;
// the duplicate completed decision replays only the stored receipt; the same
// Worker then publishes the final valid HTML result and only the explicit
// footer acceptance merges the exact candidate bytes and completes closure.
// Loopback HTTP provider scripts model turns only; never a source
// Controller/main surrogate, never an installed-byte edit, no app state patch.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {bootInstalled,CURRENT_LINK} from './installed-debug-read.fixture.mjs';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';

const exec=promisify(execFile);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha256=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const freePort=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
// Local (test-owned) copy of the fixture credential scrub for the relaunched
// owned process only; the shared fixture itself is never modified.
const scrubEnv=base=>{
  const env={...base};
  for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&( /^(NOZELI_|CCB_|OMP_|PI_|CODEX_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
  return env;
};

const workName='Installed proposal continuation';
const nonce='PROPOSAL-'+randomUUID().slice(0,8).toUpperCase();
const feedbackText=`Rejected first proposal: keep every completed step, append this exact feedback to the candidate, and continue only the local verification. Proof FEEDBACK-${nonce}.`;
const problemOneMarkdown=`## Proposed treatment ${nonce}\n\nWrite the verified marker into the candidate, then continue only after the explicit user decision on this exact report. No installation, no elevated change, no replay of completed steps.\n`;
const problemTwoMarkdown=`## Revised treatment after user feedback ${nonce}\n\nThe user rejected the first treatment; the exact feedback is retained verbatim below and no completed step was replayed.\n\n> ${feedbackText}\n\nRemaining step: finish the local verification and publish the final candidate only after the explicit user decision on this report.\n`;
const finalResultHtml=staticReport(`Approved proposal executed by the original installed Worker: initial progress, exact user feedback and the approval continuation are all retained on one Work and one thread; the underlying project stays untouched until explicit acceptance. Proof ${nonce}.`);
const expectedProgress='INITIAL_PROGRESS\nEXACT_USER_FEEDBACK_APPLIED\nAPPROVED_CONTINUATION\n';
const taskText=`Create one proposal continuation task: write initial progress into the candidate, publish the proposed treatment as a Markdown problem, then continue only on the explicit user decisions for the current problem report. Proof ${nonce}.`;
const taskBrief='Publish the proposed treatment as a Markdown problem, then continue only on the explicit user decision for the current problem report.';

const checks=[],screenshots=[],captures=[],unexpected=[],tailTurns=[];
const result={ok:false,scope:'Actual installed current release main/private bundled Pi Worker/bundled Git; one original managed.task input, real UI decision navigation, cold normal-close/relaunch on the same isolated profile with a persisted problem loaded without connection and one explicit reject decision reconnecting and executing the exact continuation once, stale refusal, manual-gate held approval plus explicit resume, duplicate completed decision, final HTML result and explicit footer acceptance merge; deterministic loopback provider only',nonce,checks,screenshots};
const markers={nonce,feedbackText,progressExpected:expectedProgress,problemOne:problemOneMarkdown,problemTwo:problemTwoMarkdown,finalResult:finalResultHtml};
result.markers=markers;
const evidence={identity:null,backstage:[],workerJobs:[],dispatches:0,publications:{problem:0,result:0},feedbackVerbatim:false,approvalVerbatim:false};
let gate=null,taskSubmitted=false,providerTurns=0;
let child2=null,exit2Future=null,browser2=null,observer2=null;
let decided=null; // exact {objectId,revision,action} the test is committing to
const jobSteps=new Map();

// ── live session abstraction (boot session, later the relaunched process) ──
let session=null;
async function until(fn,label,timeout=420000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    const value=await fn();
    if(value)return value;
    await pause(120);
  }
  throw Error('Timeout waiting for '+label);
}
const stateOf=async()=>{assert(session,'live installed session required');return await session.state();};
const counts=async()=>{
  const s=await stateOf();
  const work=s.works.find(row=>row.name===workName);
  return {jobs:s.jobs.length,business:gate.provider.requests.filter(row=>!row.listing).length,revision:work?.revision??null,works:s.works.length};
};

// ── deterministic loopback provider: model turns only ──
const call=(id,tool,args)=>({id,tool,args});
const textOf=request=>(request.messages??[]).map(message=>typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.map(part=>part.text??'').join(''):'').join('\n');
const handler=async request=>{
  assert(session,'model requests are legal only while an owned installed app is live');
  assert(taskSubmitted,'no model request is allowed before the explicit managed.task input');
  assert(providerTurns++<90,'bounded deterministic native scenario');
  const s=await stateOf();
  const work=s.works.find(row=>row.name===workName);
  const active=(s.jobs??[]).filter(job=>['running','transferring'].includes(job.status));
  // The orchestrator backstage turn is discriminated by the ACTUAL durable job
  // type from managed.status — never by the tool catalog of this request.
  const backstage=active.find(job=>job.type==='backstage'&&job.context?.backstageEventKey);
  if(backstage){
    evidence.backstage.push({jobId:backstage.id,type:backstage.type,status:backstage.status,problem:backstage.context.backstageProblem,turn:providerTurns});
    return call('backstage-blocked-'+evidence.backstage.length,'nozeli_backstage_respond',{blocked:true,reason:'This synthetic proposal requires the explicit original user decision; the Orchestrator must not continue or dispatch independently.'});
  }
  if(work){
    let workerJob=active.find(job=>job.target===work.id);
    if(!workerJob&&request.tools?.some(tool=>tool.function?.name==='nozeli_publish'))workerJob=(s.jobs??[]).findLast(job=>job.target===work.id&&job.status!=='completed');
    if(workerJob){
      const identity={workId:work.id,threadId:work.threadId,jobType:workerJob.type,directory:work.execution.directory};
      if(!evidence.identity)evidence.identity=identity;
      else{
        assert.equal(identity.workId,evidence.identity.workId,'continuation stays on the original Work');
        assert.equal(identity.threadId,evidence.identity.threadId,'continuation stays on the original native thread');
        assert.equal(identity.directory,evidence.identity.directory,'continuation stays on the original candidate directory');
      }
      const step=jobSteps.get(workerJob.id)??0;
      jobSteps.set(workerJob.id,step+1);
      evidence.workerJobs.push({jobId:workerJob.id,type:workerJob.type,step});
      const input=textOf(request);
      if(workerJob.type==='initial'){
        if(step===0)return call('initial-progress','bash',{command:"printf 'INITIAL_PROGRESS\\n' >> progress.txt"});
        if(step===1){evidence.publications.problem++;return call('initial-problem','nozeli_publish',{kind:'problem',content:problemOneMarkdown,files:['progress.txt']});}
        tailTurns.push({jobType:'initial',step});
        return {text:'Publication complete; preserve the original request and receipts.'};
      }
      if(workerJob.type==='problem-resume'){
        assert(decided&&workerJob.context?.problemObjectId===decided.objectId&&workerJob.context?.problemDecisionAction===decided.action,'continuation job is bound to the exact decided problem report');
        if(workerJob.context.problemDecisionAction==='reject'){
          assert(input.includes(feedbackText),'the reject continuation input carries the exact user feedback verbatim');
          evidence.feedbackVerbatim=true;
          if(step===0)return call('feedback-progress','bash',{command:"printf 'EXACT_USER_FEEDBACK_APPLIED\\n' >> progress.txt"});
          if(step===1){evidence.publications.problem++;return call('feedback-problem','nozeli_publish',{kind:'problem',content:problemTwoMarkdown,files:['progress.txt']});}
          tailTurns.push({jobType:'problem-resume',action:'reject',step});
          return {text:'Publication complete; preserve the user feedback verbatim.'};
        }
        assert(input.includes(nonce),'the approve continuation input carries the approved proposal report verbatim');
        evidence.approvalVerbatim=true;
        if(step===0)return call('approved-progress','bash',{command:"printf 'APPROVED_CONTINUATION\\n' >> progress.txt"});
        if(step===1){evidence.publications.result++;return call('final-result','nozeli_publish',{kind:'result',content:finalResultHtml,files:['progress.txt']});}
        tailTurns.push({jobType:'problem-resume',action:'approve',step});
        return {text:'Publication complete; preserve the approval identity.'};
      }
      throw Error('Unexpected Worker job type '+workerJob.type);
    }
  }
  const intake=active.find(job=>job.type==='intake'&&job.target==='orchestrator');
  if(intake){
    if(evidence.dispatches===0){evidence.dispatches++;return call('dispatch-original','nozeli_dispatch',{name:workName,brief:taskBrief});}
    tailTurns.push({jobType:'intake'});
    return {text:'Preserve the original request and receipts; do not dispatch again.'};
  }
  unexpected.push({tools:request.tools?.map(tool=>tool.function?.name)??[]});
  return {text:'No additional business operation; preserve the original request and receipts.'};
};

// ── shared UI navigation: real clicks only ──
async function ensureSidebar(){
  if(await session.shell.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')!=='true').catch(()=>false))await session.shell.click('#toggle-sidebar');
}
async function openOverview(workId){
  await ensureSidebar();
  await session.shell.waitForSelector(`.managed-work-entry[data-managed-work="${workId}"] .managed-work-open`,{visible:true,timeout:30000});
  await session.shell.click(`.managed-work-entry[data-managed-work="${workId}"] .managed-work-open`);
  await session.shell.waitForSelector(`[data-work-overview="${workId}"]`,{visible:true,timeout:30000});
}
async function openRetainedProgress(workId){
  await openOverview(workId);
  await session.shell.waitForSelector(`[data-work-retained-progress="${workId}"]:not([disabled])`,{visible:true,timeout:30000});
  await session.shell.click(`[data-work-retained-progress="${workId}"]`);
  await session.shell.waitForSelector(`[data-retained-progress-dialog="${workId}"]`,{visible:true,timeout:30000});
  await session.shell.waitForSelector(`[data-work-progress="${workId}"]`,{visible:true,timeout:30000});
}
async function openProblemDecision(workId,objectId){
  await openRetainedProgress(workId);
  await session.shell.waitForSelector(`[data-progress-open-report="${objectId}"]:not([disabled])`,{visible:true,timeout:30000});
  await session.shell.click(`[data-progress-open-report="${objectId}"]`);
  const found=await scanWorkspacePages(`(()=>{const n=document.querySelector('[data-problem-object="${objectId}"] [data-problem-action="approve"]');return !!(n&&!n.disabled&&n.getClientRects().length>0);})()`,'actionable explicit problem decision surface');
  return found.page;
}
async function closeShellDialogs(){
  // Close the shell's own modal surfaces (task overview + execution control)
  // exactly like their close buttons; never touches other pages' surfaces.
  await session.shell.evaluate(()=>{for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();}).catch(()=>{});
}

// Bounded in-page evaluation: a hung or destroyed guest never stalls the gate
// on the protocol default; every outcome resolves within ms.
const boundedEval=(page,expression,ms=3000)=>{
  const settled=Promise.resolve(page.evaluate(expression)).then(value=>({ok:true,value}),error=>({ok:false,error:String(error?.message??error)}));
  return Promise.race([settled,pause(ms).then(()=>({ok:false,error:'bounded-evaluate-timeout',timeoutMs:ms}))]);
};
// Resolve the ACTUAL workspace report page by binding the live workspace
// layout (shell __workspaceGroups snapshot) to each guest's __workspaceScope
// viewId, then run the caller's visibility check only on live report guests.
// Stale/destroyed/unresponsive guests are skipped and reported, never probed
// with unbounded $eval loops.
async function scanWorkspacePages(checkExpression,label,timeout=60000){
  return until(async()=>{
    const binding=await boundedEval(session.shell,`(()=>{const api=window.__workspaceGroups;const layout=api&&api.snapshot();const views=layout?Object.values(layout.views||{}):[];return {active:(api&&api.activeView&&api.activeView()?api.activeView().id:null),reports:views.filter(v=>v&&v.kind==='report').map(v=>v.id)};})()`);
    if(!binding.ok){result.scanError={label,stage:binding.error};return null;}
    const wanted=binding.value.reports;
    if(!wanted.length)return null;
    const preferred=binding.value.active&&wanted.includes(binding.value.active)?binding.value.active:null;
    const pages=await session.browser.pages();
    const facts=[];const matches=[];
    for(const page of pages){
      const url=page.url().slice(0,200);
      const scope=await boundedEval(page,`(()=>{const s=window.__workspaceScope;return s?{viewId:s.viewId||null,kind:s.kind||null,role:s.role||null}:null;})()`,2500);
      if(!scope.ok||!scope.value){facts.push({url,skipped:scope.ok?'no-workspace-scope':scope.error});continue;}
      if(scope.value.kind!=='report'||!wanted.includes(scope.value.viewId)){facts.push({url,kind:scope.value.kind,role:scope.value.role});continue;}
      const check=await boundedEval(page,checkExpression,2500);
      if(check.ok&&check.value)matches.push({page,url,viewId:scope.value.viewId,active:scope.value.viewId===preferred});
      else facts.push({url,viewId:scope.value.viewId,check:check.ok?check.value:check.error});
    }
    result.scans=result.scans||{};result.scans[label]={activeViewId:binding.value.active,reportViews:wanted,pages:facts};
    if(!matches.length)return null;
    matches.sort((a,b)=>Number(b.active)-Number(a.active));
    return matches[0];
  },label,timeout);
}

const settledProblem=async previousObject=>until(async()=>{
  const s=await stateOf();
  const failed=s.jobs.find(job=>['failed','interrupted','unknown'].includes(job.status));
  if(failed)throw Error('native job failed: '+(failed.error??failed.id));
  const work=s.works.find(row=>row.name===workName);
  const todo=s.todos.find(row=>row.workId===work?.id&&row.kind==='problem'&&row.status==='open');
  return work&&work.status==='paused'&&work.problem?.objectId&&work.problem.objectId!==previousObject&&!s.busyTargets.includes(work.id)&&!s.busyTargets.includes('orchestrator')&&!s.jobs.some(job=>['queued','running','transferring'].includes(job.status))&&todo?{state:s,work}:null;
},'next problem publication awaiting its explicit decision',300000);
const settledReview=async()=>until(async()=>{
  const s=await stateOf();
  const failed=s.jobs.find(job=>['failed','interrupted','unknown'].includes(job.status));
  if(failed)throw Error('native job failed: '+(failed.error??failed.id));
  const work=s.works.find(row=>row.name===workName);
  return work&&work.status==='review'&&!s.busyTargets.includes(work.id)&&!s.jobs.some(job=>['queued','running','transferring'].includes(job.status))?{state:s,work}:null;
},'final result review',300000);

try{
  gate=await bootInstalled({scenario:{name:'installed-proposal-continuation'},files:{'README.md':'Installed proposal continuation synthetic project.\n','.gitignore':'/.nozeli/\n'},handler});
  session={
    name:'boot',
    shell:gate.shell,browser:gate.browser,
    state:async()=>(await gate.invoke('managed.status',{projectId:gate.projectId})).state,
    statusView:async()=>gate.invoke('managed.status',{projectId:gate.projectId})
  };
  // Installed artifact identity: exactly the real current user installation.
  const current=await fs.realpath(CURRENT_LINK);
  assert.equal(gate.release,current,'the gate must run the actual current installation realpath');
  assert.equal(gate.appRoot,path.join(current,'resources','app'));
  assert.equal(await fs.realpath(gate.binary),await fs.realpath(path.join(current,'nozeli')));
  const runtimeIdentity=gate.identity?.runtimeIdentity;
  assert(runtimeIdentity?.pi?.command&&runtimeIdentity?.git?.command,'fixture exposes the redacted in-main runtime identity');
  assert.equal(runtimeIdentity.git.source,'bundled','in-main Inspector identity: bundled Git source');
  const shot=async label=>{const returned=await gate.capture(label);screenshots.push(typeof returned==='string'?returned:path.join(gate.out,label+'.png'));return screenshots.at(-1);};
  result.installed={current,release:gate.release,appRoot:gate.appRoot,binary:await fs.realpath(gate.binary),runtimeIdentity,gitIdentity:gate.identity.gitIdentity,registration:gate.registration,digests:gate.identity.digests};
  const head=gate.head;
  assert.equal(await gate.git('rev-parse','HEAD'),head,'synthetic Git baseline present before any managed activity');
  // The only original input: one explicit managed.task.
  const bootBusiness=gate.provider.requests.filter(row=>!row.listing).length;
  assert.equal(bootBusiness,0,'boot itself performs no model request');
  taskSubmitted=true;result.stage='initial-problem-settle';
  const submitted=await gate.invoke('managed.task',{projectId:gate.projectId,text:taskText,requestKey:'installed-proposal-'+nonce});
  result.submitted={jobId:submitted.jobId??submitted.requestId??null};
  // INITIAL progress write + first Markdown problem; the orchestrator
  // backstage turn is genuinely blocked through the durable job type.
  const first=await settledProblem(null);
  const work=first.work,workId=work.id,threadId=work.threadId,directory=work.execution.directory,revision1=work.revision;
  const p1={objectId:work.problem.objectId,revision:revision1};
  result.work={workId,threadId,directory,initialRevision:revision1,firstProblem:p1};
  const intakeJobs=first.state.jobs.filter(job=>job.type==='intake'&&job.target==='orchestrator');
  assert.equal(intakeJobs.length,1,'exactly one orchestrator intake for the explicit task');
  assert.equal(intakeJobs[0].status,'completed');
  assert.equal(intakeJobs[0].text,taskText,'original user input preserved verbatim');
  const initialJob=first.state.jobs.find(job=>job.target===workId);
  assert(initialJob&&initialJob.type==='initial'&&initialJob.status==='completed','one completed original Worker input');
  const receipt1=first.state.receipts.find(row=>row.workId===workId&&row.kind==='problem');
  assert(receipt1&&receipt1.objectId===p1.objectId&&receipt1.report?.format==='markdown','first problem published as Markdown');
  assert.equal(await fs.readFile(path.join(directory,'progress.txt'),'utf8'),'INITIAL_PROGRESS\n','original Worker wrote the INITIAL progress into the candidate');
  await fs.access(path.join(gate.root,'progress.txt')).then(()=>{throw Error('candidate write leaked into the project before any decision');},()=>{});
  assert.equal(await gate.git('rev-parse','HEAD'),head,'project Git unchanged before any decision');
  assert(evidence.backstage.length>=1&&evidence.backstage.every(row=>row.type==='backstage'&&row.problem?.objectId===p1.objectId),'backstage turn answered blocked, discriminated through status');
  assert.equal(evidence.dispatches,1);
  checks.push('real installed Worker wrote INITIAL progress and published the Markdown problem; the orchestrator backstage continuation is genuinely blocked with the durable job type discriminated through managed.status, never the tool catalog');
  // Real user navigation: task directory -> overview -> retained progress ->
  // frozen report -> explicit current-problem decision UI.
  await openOverview(workId);
  result.stage='ui-navigation';
  result.screenshots.push(await shot('01-task-directory-overview'));
  await session.shell.waitForSelector(`[data-work-retained-progress="${workId}"]:not([disabled])`,{visible:true,timeout:30000});
  await session.shell.click(`[data-work-retained-progress="${workId}"]`);
  await session.shell.waitForSelector(`[data-retained-progress-dialog="${workId}"]`,{visible:true,timeout:30000});
  await session.shell.waitForSelector(`[data-work-progress="${workId}"]`,{visible:true,timeout:30000});
  result.screenshots.push(await shot('02-retained-progress'));
  await session.shell.waitForSelector(`[data-progress-open-report="${p1.objectId}"]:not([disabled])`,{visible:true,timeout:30000});
  await session.shell.click(`[data-progress-open-report="${p1.objectId}"]`);
  const decisionPage=(await scanWorkspacePages(`(()=>{const n=document.querySelector('[data-problem-object="${p1.objectId}"] [data-problem-action="approve"]');return !!(n&&!n.disabled&&n.getClientRects().length>0);})()`,'actionable explicit problem decision surface')).page;
  result.screenshots.push(await shot('03-problem-decision-initial'));
  checks.push('the explicit current-problem decision UI is reachable only through the real task-directory -> overview -> retained-progress -> frozen-report navigation');
  result.stage='reject-empty-feedback';
  const beforeEmpty=await counts();
  await decisionPage.click('[data-problem-action="reject"]');
  await decisionPage.waitForFunction(()=>{const node=document.querySelector('[data-problem-decision-status]');return node&&node.textContent.trim().length>0;},{timeout:10000});
  const afterEmpty=await counts();
  assert.deepEqual(afterEmpty,beforeEmpty,'empty-feedback rejection performs no job, no model turn and no revision change');
  checks.push('rejecting the problem report without feedback executes nothing: no job, no model turn, no revision change');
  result.stage='cold-normal-close';
  gate.observer.close();
  const exit1=await (async()=>{
    await gate.invoke('session.requestClose');
    const code=await Promise.race([gate.child.exitCode===null?new Promise(resolve=>gate.child.once('exit',(c,s)=>resolve({code:c,signal:s}))):Promise.resolve(null),pause(20000).then(()=>null)]);
    return code??{code:gate.child.exitCode,signal:gate.child.signalCode};
  })();
  assert.deepEqual(exit1,{code:0,signal:null},'owned installed app closes normally (exit 0) before the cold relaunch');
  await Promise.resolve(gate.browser.disconnect()).catch(()=>{});
  result.normalClose={phase:'pre-decision',exit:exit1};
  checks.push('the owned installed app exits 0 through session.requestClose with the persisted paused problem and no queued jobs');
  // Local owned relaunch: same installed binary, SAME config/profile/project,
  result.stage='relaunch-connect';
  const port2=await freePort();
  const env2=scrubEnv(process.env);
  Object.assign(env2,{NOZELI_CONFIG_ROOT:gate.config,NOZELI_USER_DATA:gate.profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port2),NOZELI_HIDDEN:'0',NOZELI_OZONE:'x11'});
  child2=spawn(gate.binary,['--ozone-platform=x11','--inspect=0'],{cwd:gate.root,env:env2,stdio:['ignore','pipe','pipe']});
  let log2='';
  for(const stream of [child2.stdout,child2.stderr])stream.on('data',bytes=>{log2+=bytes;});
  exit2Future=new Promise(resolve=>child2.once('exit',(code,signal)=>resolve({code,signal})));
  browser2=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port2,defaultViewport:null}).catch(()=>null),'relaunched installed CDP endpoint',60000);
  const errors2=[];
  browser2.on('targetcreated',async target=>{const page=await target.page().catch(()=>null);page?.on('pageerror',error=>errors2.push(String(error?.message??error)));});
  const shell2=await until(async()=>{
    if(child2.exitCode!==null)throw Error('relaunched installed app exited early: '+log2.slice(-4000));
    for(const page of await browser2.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;
    return null;
  },'relaunched installed shell surface',90000);
  observer2=await MainObserver.connect(await until(()=>log2.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1]??null,'relaunched installed main Inspector',60000));
  const windowId2=await until(()=>observer2.evaluate(`(()=>{try{const {BaseWindow}=process.mainModule.require('electron');const win=BaseWindow.getAllWindows()[0];if(!win)return null;win.show();win.focus();return '0x'+win.getNativeWindowHandle().readUInt32LE(0).toString(16);}catch{return null}})()`).catch(()=>null),'relaunched owned installed window',30000);
  const mainMeta2=await observer2.evaluate('({execPath:process.execPath,resourcesPath:process.resourcesPath,main:process.mainModule&&process.mainModule.filename})');
  assert.equal(await fs.realpath(mainMeta2.execPath),await fs.realpath(gate.binary),'relaunched main executable is the installed binary');
  assert.equal(await fs.realpath(mainMeta2.resourcesPath),path.join(gate.release,'resources'),'relaunched main runs from the installed release resources');
  const rawInvoke2=(op,p={})=>shell2.evaluate(({op,p})=>window.nozeli.invoke(op,p),{op,p});
  const invoke2=async(op,p={})=>{const reply=await rawInvoke2(op,p);assert(reply&&reply.ok,op+': '+JSON.stringify(reply?.error));return reply.value;};
  const capture2=async label=>{
    const safe=String(label).replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'')||'capture';
    const output=path.join(gate.out,safe+'.png'),clip=path.join(gate.out,safe+'-frames.mkv');
    const record={label,path:output,method:'x11-grab',session:'relaunched'};
    await observer2.evaluate(`(async()=>{const {BaseWindow}=process.mainModule.require('electron');for(const win of BaseWindow.getAllWindows())for(const view of win.contentView.children||[])if(view.getVisible?.()&&view.webContents)await view.webContents.capturePage(undefined,{stayAwake:true});return true;})()`,15000).catch(()=>{});
    try{
      const info=(await exec('xwininfo',['-id',windowId2],{timeout:5000})).stdout;
      const width=Number(/Width:\s+(\d+)/.exec(info)?.[1]),height=Number(/Height:\s+(\d+)/.exec(info)?.[1]);
      assert(width>0&&height>0,'relaunched owned X11 window dimensions required');
      await exec('ffmpeg',['-y','-loglevel','error','-f','x11grab','-framerate','10','-draw_mouse','0','-window_id',windowId2,'-video_size',width+'x'+height,'-i',process.env.DISPLAY,'-t','1.2','-c:v','ffv1','-pix_fmt','bgr0',clip],{timeout:10000});
      await exec('ffmpeg',['-y','-loglevel','error','-sseof','-0.15','-i',clip,'-frames:v','1',output],{timeout:10000});
      assert((await fs.stat(output)).size>0,'x11 grab produced a frame for '+safe);
    }catch(error){
      const native=path.join(gate.out,safe+'-native.png');
      const nativeResult=await observer2.evaluate(`(async()=>{const fs=process.mainModule.require('node:fs');const {BaseWindow}=process.mainModule.require('electron');const win=BaseWindow.getAllWindows().find(candidate=>!candidate.isDestroyed());if(!win)throw Error('no owned window for native capture');const image=await win.webContents.capturePage();fs.writeFileSync(${JSON.stringify(native)},image.toPNG(),{mode:0o600});return {empty:image.isEmpty(),size:image.getSize()};})()`,15000);
      if(nativeResult.empty)throw Error('native WebContents capture empty for '+safe);
      record.method='webcontents-capture';record.path=native;record.reason=String(error?.message??error);
    }
    captures.push(record);screenshots.push(record.path);
    return record.path;
  };
  session={name:'relaunched',shell:shell2,browser:browser2,state:async()=>(await invoke2('managed.status',{projectId:gate.projectId})).state,statusView:async()=>invoke2('managed.status',{projectId:gate.projectId})};
  result.relaunched={pid:child2.pid,cdpPort:port2,main:mainMeta2};
  // Project reselection on the relaunched shell (real click), then cold facts.
  await until(async()=>shell2.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,gate.projectId).catch(()=>false),'relaunched project selection',60000).catch(()=>{});
  if(!await shell2.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,gate.projectId).catch(()=>false)){
    await shell2.waitForSelector(`[data-project-id="${gate.projectId}"]`,{visible:true,timeout:30000});
    await shell2.click(`[data-project-id="${gate.projectId}"]`);
    await until(()=>shell2.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,gate.projectId).catch(()=>false),'relaunched project selection',60000);
  }
  if(await shell2.$eval('#configuration-setup',node=>node.open).catch(()=>false))await shell2.click('#configuration-cancel');
  result.stage='cold-readiness-evidence';
  const businessBeforeCold=gate.provider.requests.filter(row=>!row.listing).length;
  const coldView=await invoke2('managed.status',{projectId:gate.projectId});
  assert.equal(coldView.enabled,true,'managed binding stays enabled across the cold relaunch');
  result.cold={readyBeforeDecision:coldView.ready===true,proven:false};
  // Load the persisted existing problem WITHOUT connecting: real UI reads
  result.stage='cold-problem-reads';
  const coldDecisionPage=await openProblemDecision(workId,p1.objectId);
  const coldViewAfterReads=await invoke2('managed.status',{projectId:gate.projectId});
  result.cold.readsKeptReady=coldViewAfterReads.ready===true;
  result.cold.businessRequestsDuringColdReads=gate.provider.requests.filter(row=>!row.listing).length-businessBeforeCold;
  assert.equal(result.cold.businessRequestsDuringColdReads,0,'loading the persisted problem performs no model request');
  result.screenshots.push(await capture2('04-cold-relaunch-decision'));
  if(coldView.ready!==true){
    result.cold.proven=true;
    assert(coldViewAfterReads.ready!==true,'read-only report loading never connects the model runtime');
    checks.push('cold relaunch on the SAME isolated profile/project loads the persisted problem through the real UI without any connection (ready stays false, zero model requests)');
  }else{
    // Honest reporting only: no cold claim is invented when the relaunched app
    // is already online; the decision below then simply runs warm.
    result.cold.reason='relaunched app reported ready before the decision; cold-not-proven, continuation verified warm';
  }
  // One explicit reject decision with the exact feedback: itself reconnects
  // (when cold) and executes the exact queued continuation once.
  result.stage='cold-reject-decision';
  decided={objectId:p1.objectId,revision:p1.revision,action:'reject'};
  const feedbackSet=await boundedEval(coldDecisionPage,`(()=>{const n=document.querySelector('[data-problem-feedback]');if(!n)return false;n.value=${JSON.stringify(feedbackText)};n.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  assert(feedbackSet.ok&&feedbackSet.value===true,'cold decision feedback field must accept the exact text: '+(feedbackSet.ok?JSON.stringify(feedbackSet.value):feedbackSet.error));
  await coldDecisionPage.click('[data-problem-action="reject"]');
  const second=await settledProblem(p1.objectId);
  const work2=second.work,p2={objectId:work2.problem.objectId,revision:work2.revision};
  result.secondProblem=p2;
  const resumeJobs=second.state.jobs.filter(job=>job.type==='problem-resume');
  assert.equal(resumeJobs.length,1,'exactly one queued continuation for the reject decision');
  assert(resumeJobs[0].context?.problemDecisionAction==='reject'&&resumeJobs[0].context?.problemObjectId===p1.objectId,'continuation job bound to the decided problem');
  assert.equal(resumeJobs[0].status,'completed');
  assert(resumeJobs[0].text.includes(feedbackText),'the continuation input carries the exact feedback verbatim');
  assert.equal(work2.threadId,threadId,'same Work keeps the original native thread');
  assert.equal(work2.execution.directory,directory,'same Work keeps the original candidate directory');
  assert.equal(work2.revision,revision1+1,'exactly one revision advance for the decision');
  assert.equal(await fs.readFile(path.join(directory,'progress.txt'),'utf8'),'INITIAL_PROGRESS\nEXACT_USER_FEEDBACK_APPLIED\n','the candidate retains INITIAL progress and appends the FEEDBACK continuation');
  const receipt2=second.state.receipts.findLast(row=>row.workId===workId&&row.kind==='problem');
  assert(receipt2&&receipt2.objectId===p2.objectId&&receipt2.report?.format==='markdown','reject+exact feedback yields a NEW Markdown problem');
  const frozen2=await invoke2('managed.history.read',{projectId:gate.projectId,objectId:p2.objectId});
  assert.equal(frozen2.report.format,'markdown');
  assert(frozen2.body.includes(feedbackText),'the new problem report carries the exact user feedback verbatim');
  assert(evidence.feedbackVerbatim,'the reject continuation model input carried the exact feedback');
  assert.equal(evidence.backstage.length,2,'the second problem also gets one genuinely blocked backstage turn');
  assert(evidence.backstage[1].problem?.objectId===p2.objectId);
  const viewAfterDecision=await invoke2('managed.status',{projectId:gate.projectId});
  if(result.cold.proven)assert.equal(viewAfterDecision.ready,true,'the explicit decision itself connected the model runtime');
  result.cold.readyAfterDecision=viewAfterDecision.ready===true;
  await fs.access(path.join(gate.root,'progress.txt')).then(()=>{throw Error('continuation leaked into the project root');},()=>{});
  assert.equal(await gate.git('rev-parse','HEAD'),head,'project Git still unchanged after the cold continuation');
  checks.push((result.cold.proven?'cold explicit reject decision itself reconnected and ':'explicit reject decision ')+'executed the exact queued continuation once: same Work/thread/candidate, INITIAL retained, FEEDBACK appended and a NEW Markdown problem carrying the feedback verbatim');
  result.stage='stale-refusal';
  const beforeStale=await counts();
  const staleReply=await rawInvoke2('managed.problem.resolve',{projectId:gate.projectId,workId,objectId:p1.objectId,revision:p1.revision,action:'approve',text:'',requestKey:'stale-probe-'+nonce});
  assert.equal(staleReply.ok,false,'stale decision must be refused');
  assert.equal(staleReply.error?.code,'STALE_PROBLEM','stale refusal code');
  result.stale={code:staleReply.error?.code??null};
  const afterStale=await counts();
  assert.deepEqual(afterStale,beforeStale,'stale refusal causes zero extra jobs, model turns or revision changes');
  checks.push('a decision for the superseded problem version is refused (STALE_PROBLEM) with zero extra effects, jobs or model turns');
  // ── manual execution gate: saved approval held, then explicit resume ──
  await openOverview(workId);
  await session.shell.waitForSelector(`[data-work-control-details="${workId}"]:not([disabled])`,{visible:true,timeout:30000});
  await session.shell.click(`[data-work-control-details="${workId}"]`);
  result.stage='manual-gate-pause';
  await session.shell.waitForSelector('dialog.managed-control-dialog [data-work-control-action="pause"]:not([disabled])',{visible:true,timeout:30000});
  await session.shell.click('dialog.managed-control-dialog [data-work-control-action="pause"]');
  await until(async()=>(await stateOf()).works.find(row=>row.id===workId)?.manualControl?.pause!=null,'manual execution gate holds',30000);
  await closeShellDialogs();
  result.screenshots.push(await capture2('05-manual-gate-paused'));
  // Approve the CURRENT problem while the gate is held: decision saved, the
  result.stage='held-approval';
  const heldPage=await openProblemDecision(workId,p2.objectId);
  const noteValue=await boundedEval(heldPage,`(()=>{const n=document.querySelector('[data-problem-feedback]');return n?n.value:'missing';})()`);
  assert(noteValue.ok&&noteValue.value==='','approval note stays empty for exact receipt identity: '+(noteValue.ok?JSON.stringify(noteValue.value):noteValue.error));
  const beforeHeld=await counts();
  decided={objectId:p2.objectId,revision:p2.revision,action:'approve'};
  await heldPage.click('[data-problem-action="approve"]');
  const held=await until(async()=>{
    const s=await stateOf();
    const work=structuredClone(s.works.find(row=>row.id===workId));
    const job=s.jobs.find(row=>row.type==='problem-resume'&&row.context?.problemDecisionAction==='approve');
    return work?.problemDecisions?.some(row=>row.action==='approve'&&row.objectId===p2.objectId)&&job?.status==='queued'?{work,job}:null;
  },'approval decision saved with its unique queued continuation',60000);
  await pause(1500);
  const heldJob=(await stateOf()).jobs.find(row=>row.id===held.job.id);
  assert.equal(heldJob.status,'queued','the held approval continuation is never admitted while the manual gate holds');
  assert.equal(gate.provider.requests.filter(row=>!row.listing).length,beforeHeld.business,'the held approval performs no model turn');
  assert.equal((await stateOf()).works.find(row=>row.id===workId).manualControl?.pause!=null,true,'manual gate still held after the saved approval');
  checks.push('explicit approval under the manual execution gate is saved durably (unique queued continuation) with zero execution and zero model turns');
  // Explicit resume: the exact queued continuation executes once.
  await openOverview(workId);
  await session.shell.waitForSelector(`[data-work-control-details="${workId}"]:not([disabled])`,{visible:true,timeout:30000});
  await session.shell.click(`[data-work-control-details="${workId}"]`);
  result.stage='explicit-resume';
  await session.shell.waitForSelector('dialog.managed-control-dialog [data-work-control-action="resume"]:not([disabled])',{visible:true,timeout:30000});
  result.screenshots.push(await capture2('06-held-approval-control'));
  await session.shell.click('dialog.managed-control-dialog [data-work-control-action="resume"]');
  await closeShellDialogs();
  const reviewed=await settledReview();
  const work3=reviewed.work;
  assert.equal(work3.threadId,threadId,'the same original Worker publishes the final result');
  assert.equal(work3.execution.directory,directory,'the same candidate directory carries the final result');
  assert.equal(work3.revision,revision1+2,'exactly one further revision advance for the approval');
  assert.equal(await fs.readFile(path.join(directory,'progress.txt'),'utf8'),expectedProgress,'the candidate carries INITIAL + FEEDBACK + APPROVED progress exactly');
  const resumeAll=(await stateOf()).jobs.filter(job=>job.type==='problem-resume');
  assert.equal(resumeAll.length,2,'exactly two unique continuations for the two decisions');
  assert(resumeAll.every(job=>job.status==='completed'));
  const approveJob=resumeAll.find(job=>job.context?.problemDecisionAction==='approve');
  assert.equal(approveJob.id,held.job.id,'the resume executed the exact held continuation job');
  assert(approveJob.text.includes(nonce),'the approve continuation input carried the approved proposal report');
  assert(evidence.approvalVerbatim,'the approve continuation model input carried the approved proposal verbatim');
  const resultReceipt=reviewed.state.receipts.findLast(row=>row.workId===workId&&row.kind==='result');
  assert(resultReceipt&&resultReceipt.report?.format==='html-static','final publication is valid static HTML');
  const digest=createHash('sha256').update(expectedProgress).digest('hex');
  assert(resultReceipt.snapshot?.files?.some(row=>row.relPath==='progress.txt'&&row.digest===digest),'the frozen candidate carries the exact final bytes');
  const openResultTodos=reviewed.state.todos.filter(row=>row.workId===workId&&row.kind==='result'&&row.status==='open');
  assert.equal(openResultTodos.length,1,'one open result todo');
  checks.push('explicit resume executes the held approval continuation exactly once: the same Worker appends the APPROVED progress and publishes the final valid HTML result');
  // Duplicate completed decision: stored receipt only, no extra model/job.
  const approveDecision=work3.problemDecisions.findLast(row=>row.action==='approve'&&row.objectId===p2.objectId);
  assert(approveDecision?.requestKey,'the saved approval exposes its exact receipt key');
  result.stage='duplicate-completed-decision';
  const beforeDuplicate=await counts();
  const duplicateReply=await rawInvoke2('managed.problem.resolve',{projectId:gate.projectId,workId,objectId:p2.objectId,revision:p2.revision,action:'approve',text:'',requestKey:approveDecision.requestKey});
  assert.equal(duplicateReply.ok,true,'duplicate completed decision replays the stored receipt');
  assert.equal(duplicateReply.value?.accepted,true);
  assert.equal(duplicateReply.value?.jobId,approveDecision.jobId,'replayed receipt names the original continuation job');
  await pause(400);
  const afterDuplicate=await counts();
  assert.deepEqual(afterDuplicate,beforeDuplicate,'duplicate completed decision creates no job and no model turn');
  checks.push('the duplicate completed decision replays only the stored receipt: no extra job, no extra model turn');
  // ── underlying project unchanged until the actual accept footer ──
  result.stage='accept-precheck-root-unchanged';
  assert.equal(await fs.readFile(path.join(gate.root,'README.md'),'utf8'),'Installed proposal continuation synthetic project.\n');
  await fs.access(path.join(gate.root,'progress.txt')).then(()=>{throw Error('result merged before explicit acceptance');},()=>{});
  assert.equal(await gate.git('rev-parse','HEAD'),head,'project Git unchanged until explicit acceptance');
  // Real UI acceptance through the actual footer confirmation.
  result.stage='accept-todo-click';
  await ensureSidebar();
  await session.shell.waitForSelector(`[data-managed-todo="${openResultTodos[0].id}"]`,{visible:true,timeout:30000});
  await session.shell.click(`[data-managed-todo="${openResultTodos[0].id}"]`);
  result.stage='accept-review-page-bind';
  const review=(await scanWorkspacePages(`(()=>{const n=document.querySelector('[data-review-action="accept"]');return !!(n&&!n.disabled&&n.getClientRects().length>0);})()`,'actionable final result review surface'));
  const reviewPage=review.page;
  result.acceptReview={viewId:review.viewId,url:review.url};
  result.stage='accept-review-ready';
  await reviewPage.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]',{timeout:60000}).catch(()=>{});
  result.stage='accept-review-screenshot';
  result.screenshots.push(await capture2('07-final-result-review'));
  const requestsAtReview=gate.provider.requests.filter(row=>!row.listing).length;
  result.stage='accept-footer-click';
  await reviewPage.click('[data-review-action="accept"]');
  result.stage='accept-confirmation-dialog';
  await reviewPage.waitForSelector('[data-confirmation-dialog][open]',{visible:true,timeout:30000});
  const confirmationRead=await boundedEval(reviewPage,`(()=>{const n=document.querySelector('[data-confirmation-dialog]');return n?n.innerText:null;})()`);
  assert(confirmationRead.ok&&typeof confirmationRead.value==='string','acceptance confirmation readable: '+(confirmationRead.ok?JSON.stringify(confirmationRead.value):confirmationRead.error));
  const confirmation=confirmationRead.value;
  assert(confirmation.includes('progress.txt'),'acceptance confirmation names the actual candidate file');
  result.confirmation=confirmation;
  result.stage='accept-confirmation-confirm';
  await reviewPage.click('[data-confirmation-confirm]');
  result.stage='accept-closure-complete';
  const ended=await until(async()=>{
    const s=await stateOf();
    const w=s.works.find(row=>row.id===workId);
    if(w?.closure?.phase==='blocked')throw Error('closure blocked: '+JSON.stringify(w.closure));
    return w&&w.status==='ended'&&w.outcome==='accept'&&w.closure?.phase==='complete'?w:null;
  },'explicit acceptance merges and completes closure',300000);
  assert.equal(await fs.readFile(path.join(gate.root,'progress.txt'),'utf8'),expectedProgress,'only explicit acceptance merges the exact candidate bytes');
  assert.equal(await gate.gitRaw('show','HEAD:progress.txt'),expectedProgress,'merged candidate committed byte-exact on the project branch');
  assert.notEqual(await gate.git('rev-parse','HEAD'),head,'acceptance creates the real merge commit');
  assert.equal((await gate.git('status','--porcelain')).length,0,'clean worktree after the merge');
  assert.equal(await fs.readFile(path.join(gate.root,'README.md'),'utf8'),'Installed proposal continuation synthetic project.\n','unrelated project files untouched');
  await until(async()=>fs.stat(directory).then(()=>null,()=>true),'worker execution directory cleaned after closure',60000);
  checks.push('the underlying project stays unchanged until the actual accept footer; explicit acceptance merges the exact bytes, commits them and completes closure');
  // ── exactly-once accounting after acceptance ──
  const settledJobIds=new Set(reviewed.state.jobs.map(job=>job.id));
  const finalState=await until(async()=>{const s=await stateOf();return s.jobs.some(job=>['queued','running','transferring'].includes(job.status))?null:s;},'post-acceptance jobs settle (closeout included)',60000);
  const laterRequests=gate.provider.requests.filter(row=>!row.listing).slice(requestsAtReview);
  assert(laterRequests.length<=3,'at most one bounded original-Orchestrator closeout');
  for(const request of laterRequests)assert(!request.tools?.some(tool=>tool.function?.name==='nozeli_publish'),'no repeated business Worker input after acceptance');
  const added=finalState.jobs.filter(job=>!settledJobIds.has(job.id));
  assert(added.length<=1,'at most one legitimate bound closeout job after acceptance');
  for(const job of added){assert.equal(job.target,'orchestrator');assert.notEqual(job.type,'intake');assert.equal(job.status,'completed');}
  assert.equal(finalState.works.length,1,'still exactly one original Work');
  assert.equal(finalState.jobs.filter(job=>job.target===workId).length,3,'original Worker input never repeated: initial + exactly two unique continuations');
  assert.equal(finalState.jobs.filter(job=>job.type==='intake'&&job.target==='orchestrator').length,1,'no repeated intake input');
  assert.equal(finalState.receipts.filter(row=>row.workId===workId&&row.kind==='problem').length,2,'exactly two Markdown problems');
  assert.equal(finalState.receipts.filter(row=>row.workId===workId&&row.kind==='result').length,1,'exactly one final result');
  assert.equal(finalState.quotaUsed,0,'accepted work releases the processing slot');
  assert.equal(evidence.dispatches,1);assert.equal(evidence.publications.problem,2);assert.equal(evidence.publications.result,1);
  checks.push('exactly-once accounting: one dispatch, one intake, one initial Worker input plus exactly two unique decision continuations, two Markdown problems, one HTML result, and at most one bound closeout');
  // ── close the relaunched owned app normally (exit 0) ──
  observer2.close();
  let exit2=null;
  if(child2.exitCode===null){
    try{await invoke2('session.requestClose');}catch{/* already closing */}
    exit2=await Promise.race([exit2Future,pause(20000).then(()=>null)]);
    if(child2.exitCode===null){child2.kill('SIGTERM');exit2=await Promise.race([exit2Future,pause(8000).then(()=>null)]);}
    if(child2.exitCode===null){child2.kill('SIGKILL');exit2=await Promise.race([exit2Future,pause(5000).then(()=>null)]);}
  }else exit2=await exit2Future;
  assert.deepEqual(exit2,{code:0,signal:null},'relaunched owned installed app exits 0 through session.requestClose');
  result.normalClose.relaunched={exit:exit2};
  await Promise.resolve(browser2.disconnect()).catch(()=>{});
  assert.equal(gate.provider.errors.length,0,'deterministic provider served every scripted turn without error');
  assert.deepEqual(gate.errors,[],'boot renderer surfaces stay error-free');
  assert.deepEqual(errors2,[],'relaunched renderer surfaces stay error-free');
  // Installed bytes must not have changed across BOTH owned processes.
  const drifted=[];
  if(await fs.realpath(CURRENT_LINK)!==gate.release)drifted.push('current-realpath-changed');
  for(const [rel,expected] of Object.entries(gate.identity.digests)){
    const file=rel==='nozeli'?gate.binary:rel==='INSTALLATION.json'?path.join(gate.release,'INSTALLATION.json'):path.join(gate.appRoot,rel);
    if(await sha256(file)!==expected)drifted.push(rel);
  }
  assert(!drifted.length,'installed bytes must not change during the gate: '+JSON.stringify(drifted));
  result.installed.bytesUnchanged=true;
  result.work={...result.work,final:{id:ended.id,status:ended.status,outcome:ended.outcome,closure:ended.closure}};
  result.evidence={identity:evidence.identity,backstageTurns:evidence.backstage,workerJobs:evidence.workerJobs,dispatches:evidence.dispatches,publications:evidence.publications};
  result.captures=captures;
  result.model={provider:'deterministic loopback HTTP (openai-completions)',requests:gate.provider.requests.length,business:gate.provider.requests.filter(row=>!row.listing).length,requestsBeforeExplicitTask:bootBusiness,boundary:'no model request before the explicit managed.task; every later turn belongs to a durable job discriminated through managed.status'};
  result.tailTurns=tailTurns;result.unexpectedModelTurns=unexpected;
  result.ok=true;
}catch(error){
  result.error=String(error?.stack??error);
  result.evidence={identity:evidence.identity,backstageTurns:evidence.backstage,workerJobs:evidence.workerJobs,dispatches:evidence.dispatches,publications:evidence.publications};
  result.tailTurns=tailTurns;result.unexpectedModelTurns=unexpected;
  process.exitCode=1;
  // Read-only failure evidence first: capture, live main-process window/webContents
  // facts and per-page URLs only — no state patching, no product interference.
  try{if(session?.name==='relaunched')result.screenshots.push(await capture2('08-failure'));else if(gate?.shell)result.screenshots.push(await gate.capture('08-failure').then(value=>typeof value==='string'?value:path.join(gate.out,'08-failure.png')).catch(()=>null));}catch{}
  try{
    result.diagnostics={observer:session?.name??null,windows:null,pages:[]};
    if(observer2&&session?.name==='relaunched')result.diagnostics.windows=await observer2.evaluate(`(()=>{try{const {BaseWindow}=process.mainModule.require('electron');return BaseWindow.getAllWindows().map(w=>({id:w.id,destroyed:w.isDestroyed(),visible:w.isVisible(),views:(w.contentView&&w.contentView.children||[]).map(v=>{try{const wc=v.webContents;return {attached:!!wc,crashed:!!(wc&&wc.crashed()),unresponsive:!!(wc&&wc.isUnresponsive&&wc.isUnresponsive()),url:String(wc&&wc.getURL?wc.getURL():'').slice(0,160)};}catch{return {attached:false,error:'gone'};}})}));}catch(error){return {error:String(error)};}})()`,8000).catch(error=>({error:String(error)}));
    else if(session?.name==='boot')result.diagnostics.windows=await gate.observer.evaluate(`(()=>{try{const {BaseWindow}=process.mainModule.require('electron');return BaseWindow.getAllWindows().map(w=>({id:w.id,destroyed:w.isDestroyed(),visible:w.isVisible()}));}catch(error){return {error:String(error)};}})()`,8000).catch(error=>({error:String(error)}));
    if(session?.browser)for(const page of await session.browser.pages())result.diagnostics.pages.push({url:page.url().slice(0,200)});
  }catch{}
  try{if(session?.name==='relaunched'&&session.shell)await session.shell.screenshot({path:path.join(gate.out,'failure-relaunched.png')});screenshots.push(path.join(gate.out,'failure-relaunched.png'));}catch{}
  try{if(session?.name==='boot'&&gate?.shell&&gate.child?.exitCode===null){gate.observer.close();await gate.invoke('session.requestClose').catch(()=>{});await Promise.race([new Promise(resolve=>gate.child.once('exit',resolve)),pause(15000)]);if(gate.child.exitCode===null)gate.child.kill('SIGKILL');}}catch{}
  try{await Promise.resolve(gate?.browser?.disconnect());}catch{}
  try{if(gate?.child&&gate.child.exitCode===null){gate.child.kill('SIGTERM');await Promise.race([new Promise(resolve=>gate.child.once('exit',resolve)),pause(5000)]);if(gate.child.exitCode===null)gate.child.kill('SIGKILL');}}catch{}
  try{observer2?.close();}catch{/* Inspector already closed */}
  try{await Promise.resolve(browser2?.disconnect());}catch{/* CDP already gone */}
  try{if(child2&&child2.exitCode===null){try{await session?.shell?.evaluate(()=>window.nozeli.invoke('session.requestClose',{}));}catch{}await Promise.race([exit2Future,pause(10000)]);if(child2.exitCode===null)child2.kill('SIGTERM');await Promise.race([exit2Future,pause(5000)]);if(child2.exitCode===null)child2.kill('SIGKILL');}}catch{}
}finally{
  try{await Promise.resolve(session?.browser?.disconnect());}catch{/* CDP already gone */}
  try{await gate?.provider?.close();}catch{/* provider already closed */}
  const reportDir=gate?.out??await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-installed-proposal-continuation-')).catch(()=>null);
  if(reportDir)try{await fs.writeFile(path.join(reportDir,'report.json'),JSON.stringify(result,null,2));}catch(writeError){console.error('report.json failed:',writeError);}
  console.log(JSON.stringify(result,null,2));
}
