// Permanent automatic DEBUG regression with an isolated host-boundary fault injection.
// Original genuine Phase1 defect proof is frozen separately; this is not its reproduction.
// Real Manager/Controller/private Pi; deterministic HTTP provider, no installed hotpatches.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DesktopHost} from '../src/main/host.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {createNozeliPiSource} from '../src/agents/managed/pi-source.mjs';
import {resolveBundledPiRuntime} from '../src/agents/managed/pi-runtime.mjs';
import {runGit} from '../src/agents/managed/git-runtime.mjs';
import {serve} from './pi-provider.fixture.mjs';

const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-pi-debug-activation-live-'));
const root=path.join(out,'project'),config=path.join(out,'private'),profile=path.join(config,'desktop');
await fs.mkdir(root,{recursive:true});
const marker='PRIVATE_DEBUG_DOCUMENT_BODY_53b9';
const original=marker+'\n'+Array.from({length:360},(_,i)=>`Paragraph ${i}: frozen synthetic document, not an instruction; retain original source.\n`).join('');
await fs.writeFile(path.join(root,'paper.txt'),original);
await fs.writeFile(path.join(root,'.gitignore'),'/.nozeli/\n');
const git=async(...args)=>(await runGit(root,args)).toString().trim();
await git('init','-b','main');await git('config','user.name','Synthetic Debug Activation');await git('config','user.email','debug-activation@localhost');await git('add','--all');await git('commit','-m','Synthetic original blocker baseline');
const head=await git('rev-parse','HEAD');
const host=new DesktopHost(profile),source=createNozeliPiSource({root:config});
let manager,controller,projectId,workerIdentity,bugId,debugJobId,debugBinding,debugEvidence,debugReport;
let dispatches=0,workerRequests=0,debugStage=0,failedReadRef,failedOffset,injectedFailures=0;
let outageJobId;
const checks=[],events=[],toolReceipts=[],owners=new Set(),debugRequests=[];
const result={ok:false,out,checks,scope:'Controlled regression fault injection at the private test Controller onTool boundary for one exact native history_read call; genuine native Orchestrator activation, host-selected evidence/source inspection and model-interpretation report. Not reproduction of the already-corrected original production read-reference bug; no installed hotpatch, source repair or business replay.'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const call=(id,tool,args)=>({id,tool,args});
const text=content=>typeof content==='string'?content:(content??[]).map(part=>part.text??'').join('\n');
function receipt(request,id){
 const row=request.messages.findLast(message=>message.role==='tool');assert(row,'actual native tool response required');assert.equal(row.tool_call_id,id);
 const content=text(row.content);toolReceipts.push({callId:id,content});assert(!content.includes('nozeli host rejected'),content);return JSON.parse(content);
}
function success(request,id){const value=receipt(request,id);assert.notEqual(value.ok,false,JSON.stringify(value));return value.value??value;}
function refused(request,id,code){const value=receipt(request,id);assert.equal(value.ok,false);assert.equal(value.continueTurn,true);assert.equal(value.error.code,code);return value;}
async function until(fn,label,timeout=60000){
 const end=Date.now()+timeout;while(Date.now()<end){if(provider.errors.length)throw provider.errors[0];const value=await fn();if(value)return value;await pause(25);}throw Error('Timed out: '+label);
}
function orchestratorJob(){return [...(controller?.current.values()??[])].find(job=>job.target==='orchestrator');}
function boundWorker(){
 const work=controller.store.state.works.find(row=>row.name==='Original read blocker');assert(work);
 const job=controller.current.get(work.id),owner=controller.sessions.get(work.id);assert(job&&owner);
 const identity={projectId,workId:work.id,revision:work.revision,threadId:work.threadId,jobId:job.id,requestId:owner.current?.requestId,pid:owner.pid,ownerId:owner.viewOwnerId};
 if(workerIdentity)assert.deepEqual(identity,workerIdentity,'one original native input and Worker identity');else workerIdentity=identity;
 return {work,job,owner};
}
const reportFields={
 diagnosis:'The native Worker stopped at nozeli_history_read after a fixture-owned, exact-call host-boundary fault injection. The host recorded READ_REF_EXPIRED with host failure origin, not a provider outage. This regression does not establish that the corrected production read routing still fails.',
 rootCause:'The controlled regression injects READ_REF_EXPIRED before the private Controller delegates one exact native history_read frame. Inspected context-reader and document-reader source confirms separate reference storage; those pages are genuine diagnostic evidence, but do not prove an active production defect. The injected boundary failure is the known cause of this test stop, and the report is model interpretation, not a verified fix.',
 fixPlan:'Preserve the exact original job and Work revision while awaiting a separately verified host repair; never replay business effects or ask the user for technical repair. Keep the actual read-reference correction covered by its separate native continuation test. This fixture fault needs no production workaround or installed-code patch and must not be reported as a repaired product defect.'
};
const reportArgs=extra=>({action:'debug.report',bugId,attemptId:debugBinding.attemptId,...reportFields,...extra});
const provider=await serve(async request=>{
 assert(provider.requests.length<30,'bounded native diagnostic requests, no recursive debug loop');
 const names=request.tools?.map(tool=>tool.function?.name)??[];
 if(names.includes('nozeli_publish')){
  boundWorker();
  if(workerRequests++===0)return call('original-document','nozeli_document_read',{relPath:'paper.txt'});
  assert.equal(workerRequests,2,'original fatal tool must end the native Worker, never replay or continue: '+JSON.stringify(request.messages.findLast(message=>message.role==='tool')));
  const document=success(request,'original-document');assert.equal(document.relPath,'paper.txt');assert(document.nextReadRef,'real document exceeds one native page');
  assert.equal(document.text,original.slice(document.offset,document.endOffset));failedReadRef=document.nextReadRef;failedOffset=document.endOffset;
  return call('original-wrong-history-reader','nozeli_history_read',{readRef:document.nextReadRef,offset:document.endOffset});
 }
 const job=orchestratorJob();
 if(job?.type==='intake'){
  assert.equal(dispatches++,0,'one original explicit business dispatch');
  return call('original-dispatch','nozeli_dispatch',{name:'Original read blocker',brief:'Read the entire frozen paper.txt and report its conclusion. Do not alter source, create another Work or request user technical repair.'});
 }
 if(job?.type!=='maintenance')return {text:'Preserve the original request and explicit user authorization; no additional business dispatch.'};
 assert(names.includes('nozeli_maintenance'),'real native Orchestrator exposes host debug tool');
 if(!outageJobId){outageJobId=job.id;bugId=job.context.bugId;return {status:401,error:{type:'authentication_error',code:'invalid_api_key',message:'Synthetic diagnostic provider temporarily unavailable'}};}
 debugRequests.push({jobId:job.id,stage:debugStage,nativeUserInputs:request.messages.filter(message=>message.role==='user').length});
 if(!debugJobId){debugJobId=job.id;bugId=job.context.bugId;}else assert.equal(job.id,debugJobId,'one automatic diagnostic event, no tight requeue loop');
 assert.equal(job.context.bugId,bugId);
 if(debugStage===0){
  const bug=(await controller.maintenance.read()).bugs.find(row=>row.id===bugId);assert(bug);
  assert.equal(bug.error.code,'READ_REF_EXPIRED','exact injected host failure reaches durable automatic DEBUG');
  assert.equal(bug.jobId,workerIdentity.jobId);assert.equal(bug.workId,workerIdentity.workId);assert.equal(bug.revision,workerIdentity.revision);
  const originalJob=controller.store.state.jobs.find(row=>row.id===workerIdentity.jobId);assert.equal(originalJob.status,'failed');assert.equal(originalJob.hostToolCode,'READ_REF_EXPIRED');
  debugStage++;return call('activate-debug','nozeli_maintenance',{action:'debug',bugId});
 }
 if(debugStage===1){
  const activated=success(request,'activate-debug');debugBinding={binding:activated.binding,attemptId:activated.attemptId};debugEvidence=activated.evidence;
  assert.equal(activated.readOnly,true);assert.equal(activated.debug.state,'running');assert(debugBinding.attemptId);
  assert.equal(debugEvidence.error.code,'READ_REF_EXPIRED');assert.equal(debugEvidence.originalJob.id,workerIdentity.jobId);assert.equal(debugEvidence.originalJob.revision,workerIdentity.revision);assert.equal(debugEvidence.originalJob.hostToolCode,'READ_REF_EXPIRED');
  assert(!JSON.stringify(activated).includes(marker));assert(!JSON.stringify(activated).includes(failedReadRef));
  const context=debugEvidence.sources.find(row=>row.path.endsWith('/context-reader.mjs'));assert(context);
  debugStage++;return call('inspect-context-reader','nozeli_maintenance',{action:'debug.inspect',bugId,attemptId:debugBinding.attemptId,sourceId:context.sourceId,startLine:1,lineCount:80});
 }
 if(debugStage===2){
  const page=success(request,'inspect-context-reader'),source=await fs.readFile(new URL('../src/agents/managed/context-reader.mjs',import.meta.url),'utf8');assert.equal(page.text,source.split('\n').slice(page.startLine-1,page.endLine).join('\n'));assert(page.endLine-page.startLine<80);assert(Buffer.byteLength(page.text)<=12288);assert.equal(page.digest,createHash('sha256').update(source).digest('hex'));
  const document=debugEvidence.sources.find(row=>row.path.endsWith('/document-reader.mjs'));assert(document);
  debugStage++;return call('inspect-document-reader','nozeli_maintenance',{action:'debug.inspect',bugId,attemptId:debugBinding.attemptId,sourceId:document.sourceId,startLine:1,lineCount:80});
 }
 if(debugStage===3){
  const page=success(request,'inspect-document-reader'),source=await fs.readFile(new URL('../src/agents/managed/document-reader.mjs',import.meta.url),'utf8');assert.equal(page.text,source.split('\n').slice(page.startLine-1,page.endLine).join('\n'));assert.equal(page.digest,createHash('sha256').update(source).digest('hex'));
  debugStage++;return call('foreign-report-refused','nozeli_maintenance',reportArgs({bugId:'bug:foreign-project-not-authorized'}));
 }
 if(debugStage===4){refused(request,'foreign-report-refused','DEBUG_SCOPE_MISMATCH');debugStage++;return call('stale-attempt-report-refused','nozeli_maintenance',reportArgs({attemptId:'obsolete-native-debug-attempt'}));}
 if(debugStage===5){
  refused(request,'stale-attempt-report-refused','DEBUG_ATTEMPT_STALE');
  // A fixture-owned authorization probe only: advance the original Work's
  // revision without admitting input or executing any business effect.
  await controller.store.mutate(()=>{controller.store.find(workerIdentity.workId).revision=workerIdentity.revision+1;});
  debugStage++;return call('stale-work-report-refused','nozeli_maintenance',reportArgs());
 }
 if(debugStage===6){
  refused(request,'stale-work-report-refused','DEBUG_BINDING_STALE');
  await controller.store.mutate(()=>{controller.store.find(workerIdentity.workId).revision=workerIdentity.revision;});
  const bug=(await controller.maintenance.read()).bugs.find(row=>row.id===bugId);assert.equal(bug.debug.report,undefined,'rejected reports never persist diagnosis');
  debugStage++;return call('submit-debug-diagnosis','nozeli_maintenance',reportArgs());
 }
 if(debugStage===7){
  const reported=success(request,'submit-debug-diagnosis');debugReport=reported.report;assert.equal(reported.verifiedFix,false);assert.equal(reported.workResumed,false);assert.equal(reported.debug.state,'awaiting-fix');
  assert.equal(debugReport.version,1);assert.equal(debugReport.kind,'model-interpretation');assert.equal(debugReport.verifiedFix,false);assert.deepEqual(debugReport.binding,debugBinding.binding);
  for(const field of Object.keys(reportFields))assert.equal(debugReport[field],reportFields[field]);
  debugStage++;return {text:'DEBUG evidence inspected and diagnosis/fixPlan persisted for the exact original bug. This is not a verified fix. Preserve the original Work for source correction; no business replay and no user technical repair request.'};
 }
 throw Error('Unexpected diagnostic prompt after completed report');
});
try{
 await fs.mkdir(source.agentDir,{recursive:true});
 await fs.writeFile(path.join(source.agentDir,'models.json'),JSON.stringify({providers:{'debug-activation-local':{baseUrl:provider.url,api:'openai-completions',apiKey:'local-nonsecret',models:[{id:'scripted',name:'Synthetic Native DEBUG',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:131072,maxTokens:4096}]}}}),{mode:0o600});
 source.modelFor=async()=> 'debug-activation-local/scripted';source.roleDefaultsFor=async()=>({selector:'debug-activation-local/scripted',effort:'off'});
 const runtime=await resolveBundledPiRuntime({piHome:source.agentDir});
 manager=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()},piSource:source,piRuntime:runtime,idleTimeoutMs:60000});
 manager.onEvent(event=>{events.push({kind:event.kind,text:event.text});for(const c of manager.controllers.values())for(const owner of c.sessions.values())if(owner.pid)owners.add(owner.pid);});
 await manager.processBudget.save(2);
 projectId=(await host.pick(root)).project.id;
 result.projectId=projectId;result.ledgerFile=path.join(await host.storage.localDirectory(projectId),'ui.sqlite');result.ledgerCollection='ui';result.ledgerRecord='managed:maintenance';
 await manager.connect(projectId,{enable:true});controller=manager.controllers.get(projectId);
 // Test-instance-only injection, outside production routing: only the exact
 // native call issued below can fail here; all other tools use the real host.
 const onTool=controller.onTool.bind(controller);
 controller.onTool=async(target,frame)=>{
  if(frame.callId==='original-wrong-history-reader'){
   assert.equal(injectedFailures++,0,'inject exactly one private host failure');
   assert.equal(target,workerIdentity.workId);assert.equal(frame.tool,'nozeli_history_read');assert.equal(frame.promptId,workerIdentity.requestId);
   assert.deepEqual(frame.arguments,{readRef:failedReadRef,offset:failedOffset});assert(Number.isSafeInteger(failedOffset)&&failedOffset>0);
   result.faultInjection={kind:'fixture-owned-host-boundary',callId:frame.callId,tool:frame.tool,workId:target,jobId:workerIdentity.jobId,promptId:frame.promptId,exactReadRefMatched:true,offset:failedOffset,code:'READ_REF_EXPIRED',failureOrigin:'host'};
   throw Object.assign(Error('Controlled regression host-boundary fault injection; not a production read-reference defect'),{code:'READ_REF_EXPIRED',failureOrigin:'host'});
  }
  return onTool(target,frame);
 };
 const submitted=await controller.enqueue('orchestrator','intake','Original read blocker: read the entire synthetic paper.txt.');
 await until(async()=>{const failed=controller.store.state.jobs.find(job=>job.id===outageJobId);return failed?.status==='failed'&&!controller.running.size&&!controller.kicking&&(await controller.maintenance.read()).bugs.find(bug=>bug.id===bugId)?.debug?.state==='model-unavailable';},'actual diagnostic HTTP401 stops without recursive debug');
 const stoppedEvents=controller.store.state.jobs.filter(job=>job.type==='maintenance').map(job=>job.id);
 await manager.connect(projectId);assert.deepEqual(controller.store.state.jobs.filter(job=>job.type==='maintenance').map(job=>job.id),stoppedEvents,'ordinary connection read cannot reactivate an unavailable diagnostic');
 await controller.sessions.get('orchestrator').stop();assert.equal(controller.sessions.get('orchestrator').closed,true);
 await manager.connect(projectId,{enable:true});
 checks.push('real diagnostic HTTP401 stops as model-unavailable; ordinary connect never retries; explicit reconnect after owner shutdown admits one new technical event without replaying business input');
 await until(()=>debugStage===8&&!controller.running.size&&!controller.kicking,'injected host failure followed by completed native debug report');
 const work=controller.store.find(workerIdentity.workId),jobs=controller.store.state.jobs;
 assert.equal(injectedFailures,1);assert.equal(dispatches,1);assert.equal(workerRequests,2);assert.equal(controller.store.state.works.length,1,'no replacement or extra business Work');
 assert.equal(work.revision,workerIdentity.revision);assert.equal(work.threadId,workerIdentity.threadId);assert.notEqual(work.status,'review');
 const workerJobs=jobs.filter(job=>job.target===work.id);assert.equal(workerJobs.length,1,'no business replay or supplementary Worker input');
 assert.equal(workerJobs[0].id,workerIdentity.jobId);assert.equal(workerJobs[0].status,'failed');assert.equal(workerJobs[0].hostToolCode,'READ_REF_EXPIRED');assert.equal(workerJobs[0].collabAttempts.length,1);
 assert.equal(jobs.find(job=>job.id===submitted.jobId).status,'completed');
 const maintenanceJobs=jobs.filter(job=>job.type==='maintenance');assert.equal(maintenanceJobs.length,2,'one automatic diagnostic plus one explicit model-recovery event');assert.equal(maintenanceJobs.find(job=>job.id===outageJobId).status,'failed');const completedDebug=maintenanceJobs.find(job=>job.id===debugJobId);assert.notEqual(debugJobId,outageJobId);assert.equal(completedDebug.status,'completed','completion follows exact evidence and report, not prose');
 assert.equal(controller.store.state.receipts.filter(row=>row.workId===work.id).length,0,'diagnosis is not business publication');
 const actionable=controller.store.state.todos.filter(row=>row.status==='open'&&(row.workId===work.id||row.sourceJobId===workerIdentity.jobId));assert.deepEqual(actionable,[],'program bug must not ask user for technical repair or decision');
 const durable=await host.storage.getLocal(projectId,'managed:maintenance');assert.deepEqual(durable,await controller.maintenance.read());
 const bug=durable.bugs.find(row=>row.id===bugId);assert(bug);assert.equal(durable.bugs.length,1,'authorization refusals do not recursively create program bugs');
 assert.equal(bug.projectId,projectId);assert.equal(bug.jobId,workerIdentity.jobId);assert.equal(bug.workId,work.id);assert.equal(bug.revision,workerIdentity.revision);assert.equal(bug.error.code,'READ_REF_EXPIRED');assert.notEqual(bug.status,'repaired');assert(!bug.attempts.some(row=>row.status==='verified'),'no verified host repair manufactured by diagnosis');
 assert.equal(bug.debug.schema,1);assert.equal(bug.debug.state,'awaiting-fix');assert.equal(bug.debug.eventJobId,debugJobId);assert.equal(bug.debug.attemptId,debugBinding.attemptId);assert.deepEqual(bug.debug.binding,debugBinding.binding);assert.deepEqual(bug.debug.evidence,debugEvidence);assert.deepEqual(bug.debug.report,debugReport);assert.equal(bug.debug.inspections.length,2);
 for(const inspection of bug.debug.inspections){assert(debugEvidence.sources.some(row=>row.sourceId===inspection.sourceId&&row.digest===inspection.digest));assert(inspection.endLine-inspection.startLine<80);}
 const serialized=JSON.stringify(durable);assert(!serialized.includes(marker));assert(!serialized.includes(failedReadRef));assert(!serialized.includes(original.slice(0,200)));
 assert.equal(work.maintenance.bugId,bugId);assert(/系统|后台|处理/.test(work.maintenance.message),'affected Work projects internal system processing');
 assert.equal(await fs.readFile(path.join(root,'paper.txt'),'utf8'),original);assert.equal(await git('rev-parse','HEAD'),head,'regression diagnosis never changes source or merges');
 checks.push('one explicitly labeled fixture-owned host-boundary READ_REF_EXPIRED injection matches exact native call/ref/offset; original Work/input retained, not a claim that corrected production routing fails');
 checks.push('automatic native Orchestrator DEBUG durably activates one attempt and inspects two host-selected source pages through real tool round trips');
 checks.push('foreign scope, stale attempt and stale original Work revision reports refuse without persisting diagnosis or recursive bugs');
 checks.push('versioned model-interpretation diagnosis/rootCause/fixPlan persists with exact bug/project/job/Work revision and source inspection digests; no repaired claim');
 checks.push('no business replay, publication, extra Worker/Work or user technical repair prompt; original source/Git unchanged');
 result.ledger=durable;result.identity=workerIdentity;result.debugJobId=debugJobId;result.jobs=structuredClone(jobs);result.work=structuredClone(work);result.debugRequests=debugRequests;
 const before=provider.requests.length;await pause(300);assert.equal(provider.requests.length,before,'awaiting source fix never spins a diagnostic requeue');
 await manager.stop();assert.equal(manager.processBudget.used,0);await pause(100);assert.equal(provider.requests.length,before);
 for(const pid of owners)assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
 assert.equal(provider.errors.length,0);checks.push('settled diagnosis does not requeue and private native owners release process capacity');
 result.ok=true;result.requests=provider.requests.length;
}catch(error){result.error=error.stack;result.jobs=controller?.store.state.jobs;result.providerErrors=provider.errors.map(error=>error.stack);process.exitCode=1;}
finally{
 await manager?.stop().catch(error=>{result.cleanupError=error.message;process.exitCode=1;});
 if(controller)result.finalLedger=await host.storage.getLocal(projectId,'managed:maintenance').catch(error=>({error:error.message}));
 await provider.close();await host.storage.db.close();
 await fs.writeFile(path.join(out,'native-proof.json'),JSON.stringify({toolReceipts,identity:workerIdentity,debugRequests,events},null,2));
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
