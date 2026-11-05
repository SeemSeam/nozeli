// Actual installed Nozeli release gate for effect-permission approval
// continuations. Runs the real packaged main resolved through the current
// account's ~/.local/opt/nozeli/current (never a source Controller, node-host
// surrogate or installed-byte edit) with a real synthetic Git project, the
// private bundled Pi runtime and bundled Git. Four independent scenarios run
// through the actual UI decision surface — the permission card mounted in the
// EXISTING conversation (#conversation > [data-conversation-permission]) with
// the preserved effect-permission selectors — the real privilege broker and
// the real manual work-control APIs:
//   1. frontdesk native nozeli_privileged_execute returns PERMISSION_REQUIRED
//      with a zero marker before approval; explicit approve-once resumes the
//      SAME original frontdesk thread and the actual broker appends the
//      harmless synthetic marker exactly once; repeating the identical
//      decision requestKey and the identical managed.send requestKey proves
//      no replay, no new job and no new model request.
//   2. an elevation:admin request opens the real permission gate with no
//      default selection; an explicit UI deny finishes with zero OS admin
//      execution, zero marker, no fabricated approval, the request durably
//      persisted as denied and no business replay.
//   3. one managed.task drives a real orchestrator dispatch to ONE original
//      Worker: ordinary retained native progress, then the sensitive-effect
//      boundary; the real UI approval lets the original Worker/thread/worktree
//      execute the approved command exactly once and publish one real valid
//      frozen HTML result while the project source stays unchanged awaiting
//      acceptance.
//   4. while that Worker waits for the approval, managed.work.control pauses
//      it; the approval decision made while paused saves the grant and queues
//      exactly one continuation that stays unadmitted with a zero marker until
//      an explicit managed.work.control resume; the resume runs the queued
//      command once and the flow continues into scenario 3's publication
//      (combined single Work by design — distinct checks below).
// Deterministic loopback provider scripts model turns only; sensitive
// commands append one synthetic marker line as the current user (declared
// dangerousEffect exercises the real approval gate; no real destructive
// action, no root). The owned installed app exits 0 through
// session.requestClose.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {bootInstalled,CURRENT_LINK} from './installed-debug-read.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';

const nonce='APPROVALCONT-'+randomUUID().slice(0,8).toUpperCase();
const markerLine='EXECUTED_ONCE\n';
const ordinaryValue='APPROVAL_GATE_INPUT_'+nonce;
const workName='Approval continuation worker';
const account=os.userInfo();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const checks=[],steps=[],unexpected=[],toolReceipts=[];
const result={ok:false,nonce,checks,screenshots:[],unexpectedModelTurns:unexpected,trace:steps,scope:'Actual installed current release: real packaged main, private bundled Pi runtime, bundled Git, real synthetic Git project, real UI effect-permission decisions, real privilege broker user-scope execution appending one synthetic marker line, real managed.work.control pause/resume, durable on-disk permission ledger. Deterministic loopback provider scripts model turns only; no source Controller surrogate, no installed-byte edit, no root, no real destructive effect.',boundary:'Sensitive commands append one synthetic marker file line as the current user only. The administrator request is denied through the real UI before any OS authentication could run; no actual system elevation is attempted.'};
let gate=null,external=null,effects=null,publishedHtml=null;
let inputsSubmitted=0;
const seen={frontInitial:0,frontContinuation:0,admin:0,orchestrator:0,workerInitial:0,workerContinuation:0};
const scenarios=result.scenarios={front:{},admin:{},worker:{}};
const record={front:null,worker:null};
const nonListingRequests=()=>gate.provider.requests.filter(request=>!request.listing).length;

const text=content=>typeof content==='string'?content:(content??[]).map(part=>part.text??'').join('\n');
function receipt(request,id){
  const row=(request.messages??[]).find(message=>message.role==='tool'&&message.tool_call_id===id);
  assert(row,'actual native tool response for '+id+' must be present in the thread history; roles seen: '+JSON.stringify((request.messages??[]).map(message=>message.role)));
  const content=text(row.content);
  toolReceipts.push({callId:id,content});
  assert(!content.includes('nozeli host rejected'),content);
  return JSON.parse(content);
}
function success(request,id){const value=receipt(request,id);assert.notEqual(value.ok,false,'tool '+id+' failed: '+JSON.stringify(value));return value.value??value;}
function permissionRequired(request,id){
  const value=receipt(request,id);
  assert.equal(value.ok,false,'sensitive call must be refused before approval');
  assert.equal(value.error.code,'PERMISSION_REQUIRED');
  assert.equal(value.hostControl,true);
  assert.equal(value.userDecisionRequired,true);
  assert(typeof value.error.requestId==='string'&&value.error.requestId,'PERMISSION_REQUIRED carries the pending request id');
  assert.equal(value.continueTurn,undefined);
  return value;
}
function recordBroker(tag,value){
  assert.equal(value.executed,true,'broker executed the approved command');
  assert.equal(value.exitCode,0,'broker command exits 0');
  assert(typeof value.receiptId==='string'&&value.receiptId,'durable broker receipt id');
  assert(/^[a-f0-9]{64}$/.test(value.effectHash),'frozen effect hash pinned');
  const identity=value.actualIdentity;
  assert(identity&&Number(identity.uid)===account.uid&&Number(identity.euid)===account.uid,'actual broker identity is the current account '+account.username);
  assert(identity.root!==true,'user-scope execution never claims root');
  record[tag]={exitCode:value.exitCode,uid:identity.uid,euid:identity.euid,receiptId:value.receiptId,effectHash:value.effectHash};
  return value;
}
const call=(id,tool,args)=>({id,tool,args});
const markerPath=name=>path.join(external,name);
async function markerEquals(name,expected){return await fs.readFile(markerPath(name),'utf8').then(value=>value===expected,()=>false);}
async function markerAbsent(name){assert.equal(await fs.access(markerPath(name)).then(()=>true,()=>false),false,name+' must not exist (zero execution)');}
async function failingJob(){try{const s=await gate.status();return s.jobs.find(job=>job.status==='failed')??null;}catch{return null;}}
async function until(fn,label,timeout=300000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    if(gate?.provider?.errors?.length)throw gate.provider.errors[0];
    const failed=await failingJob();
    if(failed)throw Error(label+': native job failed: '+failed.error);
    const value=await fn();
    if(value)return value;
    await pause(120);
  }
  throw new Error('Timed out: '+label);
}
async function permissionTodo(target){
  return until(async()=>{
    const s=await gate.status();
    return s.todos.find(t=>t.status==='open'&&t.destination?.kind==='effect-permission'&&(!target||s.jobs.find(job=>job.id===t.sourceJobId)?.target===target))??null;
  },'effect-permission todo for '+(target??'any target'));
}
// Permission decisions mount INSIDE the existing conversation surface
// (#conversation > [data-conversation-permission]) with the original
// effect-permission selectors preserved. The reminder click must not create
// any report view or receipt and must leave the composer draft untouched.
async function choose(todo,action,label){
  await gate.invoke('workspace.control',{type:'conversation-action',projectId:gate.projectId,action:'open'});
  const page=await until(async()=>{for(const p of await gate.browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.kind==='conversation').catch(()=>false))return p;},'existing conversation before reminder '+label);
  await page.waitForSelector('#composer:not([disabled])');
  await page.$eval('#composer',(node,value)=>{node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));node.setSelectionRange(2,8);},'UNSENT_PERMISSION_DRAFT_'+label);
  const composer=()=>page.$eval('#composer',node=>({value:node.value,selectionStart:node.selectionStart,selectionEnd:node.selectionEnd}));
  const composerBefore=await composer();
  const reports=()=>gate.shell.evaluate(()=>Object.values(window.__workspaceGroups.snapshot()?.views??{}).filter(view=>view?.kind==='report').map(view=>view.id).sort());
  const reportsBefore=await reports(),receiptsBefore=(await gate.status()).receipts.length,requestsBefore=nonListingRequests();
  if(await gate.shell.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')!=='true').catch(()=>false))await gate.shell.click('#toggle-sidebar');
  await gate.shell.waitForSelector('[data-managed-todo="'+todo.id+'"]',{visible:true});
  await gate.shell.click('[data-managed-todo="'+todo.id+'"]');
  const card='[data-conversation-permission="'+todo.id+'"]';
  await page.waitForSelector('#conversation > '+card,{visible:true});
  assert.equal(await page.evaluate(()=>window.__workspaceScope.kind),'conversation');
  assert.deepEqual(await reports(),reportsBefore,'opening the permission reminder creates no report view');
  assert.equal((await gate.status()).receipts.length,receiptsBefore,'opening a reminder creates no publication');
  assert.equal(nonListingRequests(),requestsBefore,'opening a reminder sends no model input');
  assert.deepEqual(await composer(),composerBefore,'opening a reminder preserves the nonempty draft and selection');
  const selector=card+' section[data-attention-kind="effect-permission"][data-attention-id="'+todo.destination.requestId+'"]';
  await page.waitForSelector(selector,{visible:true});
  assert.equal(await page.$$eval(selector+' input',nodes=>nodes.some(node=>node.checked)),false,'approval has no default selection');
  await page.screenshot({path:path.join(gate.out,label+'-before.png')});
  await page.click(selector+' input[data-attention-permission-action="'+action+'"]');
  await page.click(selector+' [data-attention-submit]');
  await page.screenshot({path:path.join(gate.out,label+'-decided.png')});
  result.screenshots.push(path.join(gate.out,label+'-before.png'),path.join(gate.out,label+'-decided.png'));
  assert.deepEqual(await composer(),composerBefore,'authorization is separate from unsent conversation input');
}
const settled=async()=>until(async()=>{const s=await gate.status();return !s.jobs.some(job=>['queued','running','transferring'].includes(job.status))?s:null;},'native settlement');
const shot=async label=>{const returned=await gate.capture(label);result.screenshots.push(typeof returned==='string'?returned:path.join(gate.out,label+'.png'));};

// Deterministic loopback provider: every turn is scripted from the caller's
// explicit inputs. Routing NEVER parses the native prompt: the last user
// message can be a host context projection (<nozeli-context-projection>), so
// the durable RUNNING business job from managed.status is the only
// discriminator — target/type/key plus context.effectRequestId for approval
// continuations and the Work identity for the original Worker input.
const ROUTE_PRIORITY=['worker-continuation','front-continuation','worker-initial','orchestrator','front-initial','admin'];
const handler=async request=>{
  assert(gate,'model requests are legal only after the installed app booted');
  assert(inputsSubmitted>0,'no model request is allowed before an explicit user input');
  assert(steps.length<60,'bounded deterministic native scenario');
  const tools=request.tools?.map(tool=>tool.function?.name)??[];
  const state=await gate.status();
  const workId=state.works.find(row=>row.name===workName)?.id??null;
  const running=state.jobs.filter(job=>job.status==='running');
  const routeOf=job=>job.context?.effectRequestId
      ?(job.target===workId?'worker-continuation':'front-continuation')
      :workId&&job.target===workId?'worker-initial'
      :job.target==='orchestrator'?'orchestrator'
      :job.target==='frontdesk'?(job.key==='input:ac-front-2'?'admin':'front-initial'):null;
  let job=null,route=null;
  for(const wanted of ROUTE_PRIORITY){job=running.find(row=>routeOf(row)===wanted)??null;if(job){route=wanted;break;}}
  const digest=running.map(row=>({id:row.id,target:row.target,type:row.type,key:row.key??null,effectRequestId:row.context?.effectRequestId??null}));
  steps.push({route,jobId:job?.id??null,target:job?.target??null,type:job?.type??null,key:job?.key??null,lastUser:String(text((request.messages??[]).findLast(message=>message.role==='user')?.content)).slice(0,60),tools});
  const bail=note=>{unexpected.push({note,route,running:digest,tools});return {text:'No additional actions; preserve the original inputs.'};};
  if(job?.type==='backstage')return call('preserve-backstage-'+job.id,'nozeli_backstage_respond',{blocked:true,reason:'This synthetic test preserves the exact user permission decision and never invents additional business authorization.'});
  if(route==='front-initial'){
    assert.equal(seen.frontInitial++,0,'exactly one frontdesk sensitive request');
    return call('s1-request','nozeli_privileged_execute',effects.front);
  }
  if(route==='front-continuation'){
    const step=seen.frontContinuation++;
    if(step===0){
      permissionRequired(request,'s1-request');
      return call('s1-execute','nozeli_privileged_execute',effects.front);
    }
    if(step===1){
      recordBroker('front',success(request,'s1-execute'));
      return {text:'The approved synthetic marker append executed exactly once through the host broker; reporting factually and taking no further action.'};
    }
    return bail('extra frontdesk continuation turn '+step);
  }
  if(route==='admin'){
    assert.equal(seen.admin++,0,'exactly one administrator request');
    return call('s2-request','nozeli_privileged_execute',effects.admin);
  }
  if(route==='orchestrator'){
    if(seen.orchestrator++===0)return call('s3-dispatch','nozeli_dispatch',{name:workName,brief:effects.workerBrief});
    return bail('extra orchestrator turn '+(seen.orchestrator-1));
  }
  if(route==='worker-initial'){
    const step=seen.workerInitial++;
    if(step===0)return call('w-ordinary','bash',{command:effects.workerOrdinaryCommand});
    if(step===1)return call('w-pending','nozeli_privileged_execute',effects.worker);
    return bail('extra worker turn while the decision is pending '+step);
  }
  if(route==='worker-continuation'){
    const step=seen.workerContinuation++;
    if(step===0){
      permissionRequired(request,'w-pending');
      return call('w-execute','nozeli_privileged_execute',effects.worker);
    }
    if(step===1){
      recordBroker('worker',success(request,'w-execute'));
      return call('w-publish','nozeli_publish',{kind:'result',content:publishedHtml,files:[]});
    }
    if(step===2){
      const value=success(request,'w-publish');
      assert.equal(value.saved,true);
      return {text:'Worker published the verified result; awaiting user acceptance.'};
    }
    return bail('extra worker continuation turn '+step);
  }
  return bail('no running business job matched the model turn');
};

try{
  gate=await bootInstalled({scenario:{name:'installed-approval-continuation'},files:{
    'README.md':'Synthetic installed approval-continuation gate baseline.\n',
    'notes.txt':'BASELINE-SOURCE-UNCHANGED '+nonce+'\n',
    '.gitignore':'/.nozeli/\n'
  },handler});
  for(const key of ['out','root','profile','projectId','release','appRoot','binary','shell','observer','provider','invoke','status','capture','close','browser','git','gitRaw','head','ledgerFile'])assert(gate[key]!==undefined,'bootInstalled contract field missing: '+key);
  // Installed artifact identity: exactly the real current-account installation.
  assert.equal(gate.identity.currentLink,CURRENT_LINK,'fixture resolves the current account current link');
  assert.equal(await fs.realpath(CURRENT_LINK),gate.release,'the gate runs the actual current installation realpath');
  assert.equal(gate.appRoot,path.join(gate.release,'resources','app'));
  assert.equal(await fs.realpath(gate.binary),await fs.realpath(path.join(gate.release,'nozeli')));
  result.account={username:account.username,uid:account.uid,homedir:account.homedir};
  result.installed={identity:gate.identity};
  assert.equal(nonListingRequests(),0,'no model request happened during boot');
  // Synthetic external effect space: harmless marker files only.
  external=path.join(gate.out,'external');
  await fs.mkdir(external,{mode:0o700});
  await fs.writeFile(path.join(external,'input.txt'),ordinaryValue);
  const nodeBin=await fs.realpath(path.join(gate.appRoot,'runtime','node','bin','node'));
  const ordinaryScript=name=>`const fs=require('node:fs');const value=fs.readFileSync(${JSON.stringify(path.join(external,'input.txt'))},'utf8');if(value!==${JSON.stringify(ordinaryValue)})throw Error(value);fs.writeFileSync(${JSON.stringify(markerPath(name))},value);console.log(value);`;
  const ordinaryCommand=name=>JSON.stringify(nodeBin)+' -e '+JSON.stringify(ordinaryScript(name));
  const appendScript=name=>`require('node:fs').appendFileSync(${JSON.stringify(markerPath(name))},${JSON.stringify(markerLine)});`;
  const effect=(name,elevation='user')=>({command:nodeBin,args:['-e',appendScript(name)],cwd:external,purpose:'Synthetic installed approval-continuation gate; appends one marker line only',...(elevation==='user'?{dangerousEffect:'Synthetic sensitive-effect gate marker append as the current user; no real destructive action'}:{}),elevation});
  publishedHtml=staticReport('Installed approval continuation '+nonce+'. The original Worker ran the ordinary native command for retained progress, then — after the explicit UI approval saved during a manual work-control pause and the explicit resume — executed the approved sensitive marker append exactly once through the real privilege broker as the current user. Project source stays unchanged awaiting acceptance.');
  const workerBrief='WORKER-BRIEF-3: First run this ordinary native bash command and wait for its result: '+ordinaryCommand('worker-ordinary.txt')+'. Then call nozeli_privileged_execute directly with arguments exactly '+JSON.stringify(effect('worker-approved.txt'))+'. Do not bypass the pending decision with bash, do not alter the arguments, do not execute before the user decision. After approval execute that exact command once, then publish the final result with nozeli_publish (kind "result", files []). Do not modify project files, do not call other agents, do not use Git.';
  effects={
    front:effect('front-approved.txt'),
    admin:effect('admin-denied.txt','admin'),
    worker:effect('worker-approved.txt'),
    workerOrdinaryCommand:ordinaryCommand('worker-ordinary.txt'),
    workerBrief
  };
  const s1Text='FRONT-SENSITIVE-1: Call nozeli_privileged_execute directly with arguments exactly '+JSON.stringify(effects.front)+'. This is a user-requested synthetic acceptance: the only effect is appending one marker line to front-approved.txt. Do not bypass the pending decision with bash, do not modify the arguments, do not execute it yourself and do not dispatch other tasks; wait for the user decision. After approval execute that exact command once and report factually; never repeat it.';
  const s2Text='ADMIN-DENY-2: Call nozeli_privileged_execute directly with arguments exactly '+JSON.stringify(effects.admin)+'. This is a user-requested synthetic acceptance of the authorization flow only; the command would append one marker line to admin-denied.txt. Wait for the user decision; if it is denied, do not execute, do not retry, do not dispatch other tasks, and state that no execution happened.';
  const taskText='WORKER-FLOW-3: Create exactly one Work named "'+workName+'". Dispatch it to a Worker with this brief verbatim: '+workerBrief+' Do not perform the Worker steps yourself and do not create a second Work.';

  // ── Scenario 1: frontdesk sensitive effect, approve-once, idempotent replay ──
  inputsSubmitted++;
  const s1Submitted=await gate.invoke('managed.send',{projectId:gate.projectId,target:'frontdesk',text:s1Text,requestKey:'ac-front-1'});
  assert(s1Submitted.accepted&&typeof s1Submitted.jobId==='string','managed.send returns the original frontdesk job');
  scenarios.front.submittedJobId=s1Submitted.jobId;
  const s1Todo=await permissionTodo('frontdesk');
  const s1RequestId=s1Todo.destination.requestId,s1Version=s1Todo.destination.expectedVersion;
  scenarios.front.requestId=s1RequestId;
  const s1DecisionKey='attention:'+s1RequestId+':'+s1Version+':approve-once';
  scenarios.front.decisionRequestKey=s1DecisionKey;
  await markerAbsent('front-approved.txt');
  // Thread identity through the durable state: live session threadId with the
  // persistent resident record as the idle-release fallback.
  const frontdeskThread=state=>{
    const agent=state.agents.find(row=>row.target==='frontdesk');
    return agent?.threadId??state.residents?.frontdesk?.threadId??null;
  };
  const threadBefore=frontdeskThread(await gate.status());
  assert(threadBefore,'original frontdesk thread identity present while waiting');
  scenarios.front.threadIdBefore=threadBefore;
  await choose(s1Todo,'approve-once','front-approval');
  await until(()=>markerEquals('front-approved.txt',markerLine),'approved frontdesk marker appended exactly once');
  await settled();
  assert.equal(await fs.readFile(markerPath('front-approved.txt'),'utf8'),markerLine,'marker carries exactly one appended line');
  const threadAfter=frontdeskThread(await gate.status());
  assert(threadAfter&&threadAfter===threadBefore,'approval continues the SAME original frontdesk thread');
  scenarios.front.threadIdAfter=threadAfter;
  assert(record.front,'frontdesk broker receipt recorded on the original thread');
  scenarios.front.broker=record.front;
  await shot('01-frontdesk-approval-continued');
  // Repeat the identical decision requestKey and the identical send requestKey:
  // both must be idempotent duplicates with zero replay, zero new jobs and
  // zero new model requests.
  const requestsBeforeDuplicate=nonListingRequests();
  const jobsBeforeDuplicate=(await gate.status()).jobs.map(job=>job.id).sort().join(',');
  const duplicateDecision=await gate.invoke('managed.attention.respond',{projectId:gate.projectId,attentionKind:'effect-permission',attentionId:s1RequestId,expectedVersion:s1Version,action:'approve-once',sourceJobId:s1Todo.destination.sourceJobId,requestKey:s1DecisionKey});
  assert.equal(duplicateDecision.duplicate,true,'identical decision requestKey replays the stored decision');
  assert.equal(duplicateDecision.accepted,true);
  assert.equal(duplicateDecision.executionDisposition.kind,'completed','duplicate decision never re-queues the completed continuation');
  const duplicateSend=await gate.invoke('managed.send',{projectId:gate.projectId,target:'frontdesk',text:s1Text,requestKey:'ac-front-1'});
  assert.equal(duplicateSend.jobId,s1Submitted.jobId,'identical managed.send requestKey returns the original job');
  await pause(2500);
  assert.equal(nonListingRequests(),requestsBeforeDuplicate,'no new model request after duplicate decision and duplicate send');
  assert.equal((await gate.status()).jobs.map(job=>job.id).sort().join(','),jobsBeforeDuplicate,'no new job after duplicate decision and duplicate send');
  assert.equal(await fs.readFile(markerPath('front-approved.txt'),'utf8'),markerLine,'no second execution after duplicates');
  scenarios.front.duplicate={decision:'idempotent',send:'same-job',providerDelta:nonListingRequests()-requestsBeforeDuplicate};
  checks.push('frontdesk nozeli_privileged_execute returns PERMISSION_REQUIRED with zero marker before approval; explicit approve-once continues the same original thread and the real broker appends the harmless marker exactly once; identical decision and send requestKeys stay idempotent with no replay, no new job and no new model request');

  // ── Scenario 2: administrator request, explicit UI deny before OS auth ──
  inputsSubmitted++;
  const s2Submitted=await gate.invoke('managed.send',{projectId:gate.projectId,target:'frontdesk',text:s2Text,requestKey:'ac-front-2'});
  assert(s2Submitted.accepted&&typeof s2Submitted.jobId==='string');
  const s2Todo=await permissionTodo('frontdesk');
  const s2RequestId=s2Todo.destination.requestId,s2Version=s2Todo.destination.expectedVersion;
  scenarios.admin.requestId=s2RequestId;
  scenarios.admin.decisionRequestKey='attention:'+s2RequestId+':'+s2Version+':deny';
  await markerAbsent('admin-denied.txt');
  const requestsAfterAdminCall=nonListingRequests();
  await choose(s2Todo,'deny','administrator-denial');
  await until(async()=>!(await gate.status()).todos.some(todo=>todo.id===s2Todo.id&&todo.status==='open'),'deny settles the permission todo');
  const s2State=await settled();
  await markerAbsent('admin-denied.txt');
  assert.equal(nonListingRequests(),requestsAfterAdminCall,'deny produces no business replay: zero additional model requests');
  const s2Job=s2State.jobs.find(job=>job.id===s2Submitted.jobId);
  assert(s2Job&&!['failed','queued','running'].includes(s2Job.status),'denied administrator request leaves no failed or stuck job');
  scenarios.admin.providerDeltaAfterDeny=nonListingRequests()-requestsAfterAdminCall;
  await shot('02-administrator-denied');
  checks.push('administrator elevation request opens the real permission gate with no default selection; the explicit UI deny — before any OS authentication could run — leaves zero marker, zero broker execution, no fabricated approval and zero business replay');
  checks.push('every permission decision surfaces inside the existing conversation permission card ([data-conversation-permission], scope kind conversation) with no default selection, zero new report views, zero new receipts, and the original conversation history and composer draft preserved');
  // ── Scenarios 3+4: one real Worker dispatch, manual pause across the decision ──
  inputsSubmitted++;
  const taskSubmitted=await gate.invoke('managed.task',{projectId:gate.projectId,text:taskText,requestKey:'ac-task-3'});
  assert(taskSubmitted.accepted&&typeof taskSubmitted.jobId==='string');
  const work=await until(async()=>{const s=await gate.status();return s.works.find(row=>row.name===workName)??null;},'original Worker Work created');
  const workerTodo=await permissionTodo(work.id);
  const workerRequestId=workerTodo.destination.requestId,workerVersion=workerTodo.destination.expectedVersion;
  scenarios.worker.requestId=workerRequestId;
  scenarios.worker.decisionRequestKey='attention:'+workerRequestId+':'+workerVersion+':approve-once';
  // Ordinary retained progress on the original Worker before the boundary.
  await until(()=>markerEquals('worker-ordinary.txt',ordinaryValue),'original Worker ordinary native command retained as progress');
  await markerAbsent('worker-approved.txt');
  const workBefore=(await gate.status()).works.find(row=>row.id===work.id);
  scenarios.worker.workId=work.id;
  scenarios.worker.threadId=workBefore.threadId;
  scenarios.worker.executionDirectory=workBefore.execution?.directory??null;
  assert(workBefore.threadId,'original Worker bound a real native thread');
  assert(workBefore.execution?.directory&&workBefore.execution.directory!==gate.root,'original Worker runs in its own real worktree');
  // Manual pause while the Worker waits for the approval decision.
  const cap=await gate.invoke('managed.work.control.status',{projectId:gate.projectId,workId:work.id});
  assert.equal(cap.pause.allowed,true,'pause capability available while waiting: '+JSON.stringify(cap.pause));
  const paused=await gate.invoke('managed.work.control',{projectId:gate.projectId,workId:work.id,action:'pause',expectedControlVersion:cap.controlVersion,expectedWorkRevision:cap.workRevision,expectedProjectInstanceId:cap.projectInstanceId,requestKey:'ac-pause-'+nonce});
  assert.equal(paused.controlApplied.applied,true);
  assert.equal(paused.controlApplied.paused,true);
  assert.equal(paused.controlApplied.controlVersion,cap.controlVersion+1,'pause advances the durable control version');
  assert.equal(paused.executionDisposition.kind,'held','pause reports the manual gate');
  scenarios.worker.pause={requestKey:paused.requestKey,controlVersion:paused.controlVersion,disposition:paused.executionDisposition.kind};
  // Decide the approval while paused: grant saved, one continuation queued,
  // zero execution, zero admission while the gate holds.
  await choose(workerTodo,'approve-once','worker-approval-paused');
  const continuation=await until(async()=>{
    const s=await gate.status();
    return s.jobs.find(job=>job.context?.effectRequestId===workerRequestId&&job.status==='queued'&&!job.promptStartedAt)??null;
  },'approval continuation queued while paused');
  scenarios.worker.continuationJobId=continuation.id;
  await until(async()=>!(await gate.status()).todos.some(todo=>todo.id===workerTodo.id&&todo.status==='open'),'approval closes the permission todo');
  await pause(2500);
  const heldState=await gate.status();
  const heldContinuation=heldState.jobs.find(job=>job.id===continuation.id);
  assert(heldContinuation&&heldContinuation.status==='queued'&&!heldContinuation.promptStartedAt,'continuation stays queued and never admitted while paused');
  assert(!heldState.busyTargets.includes(work.id),'paused Worker owner never admits the continuation');
  await markerAbsent('worker-approved.txt');
  await shot('03-worker-approval-while-paused');
  // Explicit resume through the same real control API: the queued continuation
  // runs once on the original Worker.
  const resumeCap=await gate.invoke('managed.work.control.status',{projectId:gate.projectId,workId:work.id});
  assert.equal(resumeCap.paused,true,'control status still shows the manual pause');
  assert.equal(resumeCap.resume.allowed,true,'resume capability available');
  const resumed=await gate.invoke('managed.work.control',{projectId:gate.projectId,workId:work.id,action:'resume',expectedControlVersion:resumeCap.controlVersion,expectedWorkRevision:resumeCap.workRevision,expectedProjectInstanceId:resumeCap.projectInstanceId,requestKey:'ac-resume-'+nonce});
  assert.equal(resumed.controlApplied.applied,true);
  assert.equal(resumed.controlApplied.paused,false);
  scenarios.worker.resume={requestKey:resumed.requestKey,controlVersion:resumed.controlVersion,disposition:resumed.executionDisposition?.kind??null,jobId:resumed.executionDisposition?.jobId??null};
  assert(resumed.executionDisposition?.jobId===continuation.id||resumed.executionDisposition?.kind==='eligible','resume points at the admissible queued continuation');
  await until(()=>markerEquals('worker-approved.txt',markerLine),'resumed continuation executes the approved command once');
  const reviewed=await until(async()=>{
    const s=await gate.status();
    return s.works.find(row=>row.id===work.id&&row.status==='review')&&!s.busyTargets.includes(work.id)?s:null;
  },'original Worker publishes after the resume');
  assert.equal(await fs.readFile(markerPath('worker-approved.txt'),'utf8'),markerLine,'approved Worker marker appended exactly once');
  assert(record.worker,'worker broker receipt recorded on the original thread');
  scenarios.worker.broker=record.worker;
  const finalWork=reviewed.works[0];
  assert.equal(reviewed.works.length,1,'exactly one Work; no replacement Worker');
  assert(!reviewed.works.some(row=>row.replacementWork||row.replacementWorkId));
  assert.equal(finalWork.threadId,workBefore.threadId,'approval and resume continue the SAME original Worker thread');
  assert.equal(reviewed.quotaUsed,1,'one work slot used');
  const workerJobs=reviewed.jobs.filter(job=>job.target===work.id);
  assert.equal(workerJobs.length,2,'exactly one original Worker input plus one approval continuation');
  const originalWorkerJob=workerJobs.find(job=>job.id!==continuation.id);
  assert.equal(originalWorkerJob.status,'completed');
  assert.equal(originalWorkerJob.collabAttempts.length,1,'original Worker admitted exactly once');
  assert.equal(reviewed.jobs.filter(job=>job.type==='intake'&&job.target==='orchestrator').length,1,'exactly one orchestrator intake for the explicit task');
  assert.equal(reviewed.jobs.filter(job=>job.target==='frontdesk').length,3,'two frontdesk sends plus one approval continuation only');
  const publication=reviewed.receipts.find(row=>row.workId===work.id&&row.kind==='result');
  assert(publication,'one result publication for the original Work');
  assert.equal(publication.report.format,'html-static','published a real HTML report');
  assert.equal(publication.report.objectId,finalWork.result.objectId);
  const frozenReport=await gate.invoke('managed.history.read',{projectId:gate.projectId,objectId:publication.report.objectId});
  assert.equal(frozenReport.objectVerified,true,'host verifies the frozen canonical HTML bytes');
  scenarios.worker.publication={objectId:publication.report.objectId,format:publication.report.format,byteLength:frozenReport.report.byteLength,digest:frozenReport.report.digest,objectVerified:frozenReport.objectVerified};
  // Source stays unchanged while the result awaits explicit acceptance.
  assert.equal(await fs.readFile(path.join(gate.root,'notes.txt'),'utf8'),'BASELINE-SOURCE-UNCHANGED '+nonce+'\n','project source unchanged awaiting acceptance');
  assert.equal(await fs.readFile(path.join(gate.root,'README.md'),'utf8'),'Synthetic installed approval-continuation gate baseline.\n');
  assert.equal(await gate.git('rev-parse','HEAD'),gate.head,'no project commit before acceptance');
  assert.equal((await gate.git('status','--porcelain')).length,0,'no stray worktree files');
  const resultTodo=reviewed.todos.find(todo=>todo.workId===work.id&&todo.kind==='result'&&todo.status==='open');
  assert(resultTodo,'publication leaves the acceptance todo open');
  // Open the real frozen HTML report through the actual UI.
  if(await gate.shell.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')!=='true').catch(()=>false))await gate.shell.click('#toggle-sidebar');
  await gate.shell.waitForSelector('[data-managed-todo="'+resultTodo.id+'"]',{visible:true});
  await gate.shell.click('[data-managed-todo="'+resultTodo.id+'"]');
  const review=await until(async()=>{for(const page of await gate.browser.pages()){if(await page.$eval('[data-review-action="accept"]:not([disabled])',node=>node.getClientRects().length>0).catch(()=>false))return page;}},'actionable original report review surface');
  await review.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
  const previewKey=await review.$eval('.managed-report-body .isolated-viewport',node=>node.dataset.previewKey);
  const snapshotReply=await review.evaluate(key=>window.nozeli.invoke('isolated-preview.snapshot',{key}),previewKey);
  assert(snapshotReply.ok,'isolated preview snapshot for the frozen report');
  const guest=await until(async()=>{for(const page of await gate.browser.pages())if(page.url().startsWith(snapshotReply.value.origin+'/'))return page;},'real isolated frozen report guest');
  await guest.waitForFunction(token=>document.body.innerText.includes(token),{},nonce);
  await guest.screenshot({path:path.join(gate.out,'04-worker-report-guest.png')});
  result.screenshots.push(path.join(gate.out,'04-worker-report-guest.png'));
  await shot('05-worker-review-awaiting-acceptance');
  checks.push('one real orchestrator dispatch creates one original Worker: ordinary native progress is retained, the sensitive boundary waits, and the approve-once decision made during a real managed.work.control pause saves the grant and queues exactly one never-admitted continuation with a zero marker');
  checks.push('explicit managed.work.control resume releases the gate: the original Worker/thread/worktree executes the approved command exactly once through the real broker as the current user and publishes one verified frozen HTML result while project source and Git stay unchanged awaiting acceptance');

  // ── Normal owned exit, then raw on-disk permission ledger ──
  const finalState=await settled();
  result.jobs=finalState.jobs.map(job=>({id:job.id,target:job.target,type:job.type,status:job.status,effectRequestId:job.context?.effectRequestId??null}));
  result.providerRequests=gate.provider.requests.length;
  assert.equal(unexpected.length,0,'no unmatched model turns: '+JSON.stringify(unexpected));
  const closeResult=await gate.close();
  assert.deepEqual(closeResult,{code:0,signal:null},'owned installed app exits 0 through session.requestClose');
  result.closeInfo={...gate.closeInfo};
  assert(!gate.closeInfo.installedBytesChanged,'installed bytes must not change during the gate: '+JSON.stringify(gate.closeInfo.installedBytesChanged));
  assert.equal(gate.provider.errors.length,0);
  assert.deepEqual(gate.errors,[],'installed renderer surfaces stay error-free');
  const db=new DatabaseSync(gate.ledgerFile,{readOnly:true});
  try{
    const row=db.prepare("SELECT value FROM records WHERE collection='ui' AND id='managed:task-permissions'").get();
    assert(row,'durable task-permissions ledger on disk at '+gate.ledgerFile);
    const perms=JSON.parse(row.value);
    const byMarker=token=>(perms.requests??[]).find(request=>(request.frozenEffect?.args??[]).some(arg=>String(arg).includes(token)));
    const front=byMarker('front-approved.txt'),admin=byMarker('admin-denied.txt'),worker=byMarker('worker-approved.txt');
    assert(front&&front.status==='approved','frontdesk request durably approved');
    const frontGrant=(perms.grants??[]).find(grant=>grant.requestId===front.id);
    assert(frontGrant&&frontGrant.mode==='once'&&frontGrant.status==='used','approve-once grant consumed exactly once');
    const frontExecution=(perms.executions??[]).find(execution=>execution.requestId===front.id);
    assert(frontExecution&&frontExecution.status==='completed'&&frontExecution.exitCode===0,'frontdesk broker receipt completed');
    assert(Number(frontExecution.actualIdentity?.uid)===account.uid&&frontExecution.actualIdentity?.root!==true,'on-disk receipt pins the real current-user identity');
    assert(admin&&admin.status==='denied','administrator request durably persisted as denied');
    assert.equal(admin.decision?.action,'deny');
    assert.equal(admin.decision?.authority,'user-choice');
    assert(!(perms.grants??[]).some(grant=>grant.requestId===admin.id),'denied request never mints a grant');
    assert(!(perms.executions??[]).some(execution=>execution.requestId===admin.id),'denied request never reaches the broker');
    assert(worker&&worker.status==='approved','worker request durably approved');
    const workerGrant=(perms.grants??[]).find(grant=>grant.requestId===worker.id);
    assert(workerGrant&&workerGrant.mode==='once'&&workerGrant.status==='used');
    const workerExecution=(perms.executions??[]).find(execution=>execution.requestId===worker.id);
    assert(workerExecution&&workerExecution.status==='completed'&&workerExecution.exitCode===0&&Number(workerExecution.actualIdentity?.uid)===account.uid);
    for(const key of [scenarios.front.decisionRequestKey,scenarios.admin.decisionRequestKey,scenarios.worker.decisionRequestKey])assert((perms.decisions??[]).some(decision=>decision.requestKey===key),'durable user decision for '+key);
    assert((perms.requests??[]).every(request=>request.status!=='pending'),'no request left pending');
    result.permissions={ledgerPath:gate.ledgerFile,front:{requestId:front.id,grant:frontGrant.status,execution:{status:frontExecution.status,exitCode:frontExecution.exitCode,uid:Number(frontExecution.actualIdentity?.uid)}},admin:{requestId:admin.id,status:admin.status,decision:admin.decision?.action,grants:0,executions:0},worker:{requestId:worker.id,grant:workerGrant.status,execution:{status:workerExecution.status,exitCode:workerExecution.exitCode,uid:Number(workerExecution.actualIdentity?.uid)}}};
    checks.push('raw read-only on-disk permission ledger: frontdesk/worker approve-once grants consumed exactly once with completed current-user receipts; the administrator request persists denied with zero grants and zero executions');
  }finally{db.close();}
  result.toolReceipts=toolReceipts;
  result.ok=true;
}catch(error){
  result.error=String(error?.stack??error);
  result.stage={seen,inputsSubmitted};
  try{result.screenshots.push(await shot('failure'));}catch{}
  try{await gate.close();}catch(closeError){result.closeError=String(closeError);}
  process.exitCode=1;
}finally{
  const reportDir=gate?.out??await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-installed-approval-continuation-')).catch(()=>null);
  if(reportDir){
    result.closeInfo=result.closeInfo??(gate?{...gate.closeInfo}:null);
    await fs.writeFile(path.join(reportDir,'report.json'),JSON.stringify(result,null,2)).catch(writeError=>console.error('report.json failed:',writeError));
  }
  console.log(JSON.stringify(result,null,2));
}
