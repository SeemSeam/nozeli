import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Controller} from '../src/agents/managed/controller.mjs';
import {MaintenanceLedger} from '../src/agents/managed/maintenance-ledger.mjs';
import {DebugProtocol} from '../src/agents/managed/debug-protocol.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';

async function fixture({phase='runtime',workStatus='running'}={}){
 let local=null;
 const storage={getLocal:async()=>structuredClone(local),putLocal:async(_project,_key,value)=>{local=structuredClone(value);}};
 storage.requireRegistered=async projectId=>{assert.equal(projectId,'project');return {id:'project',instanceId:'diagnostic-fixture-instance'};};
 const original={id:'original',target:'work',revision:3,type:'work',status:'failed',text:'PRIVATE_USER_REQUEST',errorCode:'PI_HOST_TOOL_FAILED',hostToolCode:'READ_REF_EXPIRED',failureOrigin:'host',collabAttempts:[{status:'unknown',everAdmitted:true}]};
 const work={id:'work',revision:3,status:workStatus,brief:'PRIVATE_WORK_BRIEF'};
 const host=Object.assign(Object.create(Controller.prototype),{projectId:'project',current:new Map(),maintenanceActions:new Map(),maintenanceFlights:new Map(),coldJobs:new Set(),changed(){},kick(){this.kicks=(this.kicks??0)+1;}});
 host.store={state:{jobs:[original],works:[work],todos:[]},storage,requireOnline:async()=>{},mutate:async fn=>fn()};
 host.maintenance=new MaintenanceLedger(storage,host.projectId);host.debugProtocol=new DebugProtocol(host);
 const error=Object.assign(Error('PRIVATE_ERROR token=SECRET_TOKEN'),{code:'READ_REF_EXPIRED'});
 const bug=await host.maintenance.record({phase,jobId:original.id,workId:work.id,revision:3,error});
 await host.maintenance.finish(bug.id,{outcome:'needs-version-fix'});original.maintenanceBugId=bug.id;work.maintenance={bugId:bug.id,status:'needs-version-fix'};
 await host.maintenanceEvent(bug,{schedule:false});
 const event=host.store.state.jobs.find(j=>j.type==='maintenance');event.status='running';host.current.set('orchestrator',event);
 const call=args=>host.handleTool('orchestrator',{tool:'nozeli_maintenance',arguments:{bugId:bug.id,...args}});
 return {host,bug,original,work,event,call,read:()=>host.maintenance.read()};
}
const report={diagnosis:'The host read reference was resolved by the wrong reader.',rootCause:'Reader ownership differs from the reference owner.',fixPlan:'Correct reader dispatch and verify exact native behavior without replaying original effects.'};
async function inspect(f){const begin=await f.call({action:'debug'});const source=begin.evidence.sources.find(s=>s.path.endsWith('/context-reader.mjs'));const page=await f.call({action:'debug.inspect',attemptId:begin.attemptId,sourceId:source.sourceId,lineCount:80});return {begin,page};}

test('maintenance DEBUG durably queues one internal event without authorizing completion',async()=>{
 const f=await fixture();
 assert.equal(f.original.debugState,'queued');assert.equal(f.work.maintenance.debugState,'queued');
 assert.equal((await f.read()).bugs[0].debug.eventJobId,f.event.id);
 await f.host.maintenanceEvent(f.bug,{schedule:false});assert.equal(f.host.store.state.jobs.filter(j=>j.type==='maintenance').length,1);
 assert.equal(await f.host.debugProtocol.completed(f.event),false);
});

test('action-null bugs inspect bounded trusted source and persist interpretation, never repair/resume/replay',async()=>{
 const f=await fixture(),{begin,page}=await inspect(f);
 assert.equal(begin.attemptId,(await f.call({action:'debug'})).attemptId);
 assert.equal(begin.evidence.originalJob.id,f.original.id);assert.equal(begin.evidence.error.code,'READ_REF_EXPIRED');
 assert.equal(f.host.maintenanceActions.size,0);assert.equal(page.readOnly,true);assert.ok(Buffer.byteLength(page.value.text)<=12288);assert.ok(page.value.endLine-page.value.startLine<80);
 const saved=await f.call({action:'debug.report',attemptId:begin.attemptId,...report});
 assert.equal(saved.report.kind,'model-interpretation');assert.equal(saved.report.verifiedFix,false);assert.equal(saved.report.version,1);assert.equal(saved.debug.state,'awaiting-fix');
 assert.equal(saved.workResumed,false);assert.equal((await f.read()).bugs[0].status,'needs-version-fix');assert.equal(f.work.status,'running');assert.equal(f.original.status,'failed');
 assert.equal(f.original.debugState,'awaiting-fix');assert.equal(await f.host.debugProtocol.completed(f.event),true);
 assert.deepEqual((await f.call({action:'debug.report',attemptId:begin.attemptId,...report})).report,saved.report);
 const durable=JSON.stringify(await f.read());for(const privateText of ['PRIVATE_USER_REQUEST','PRIVATE_WORK_BRIEF','PRIVATE_ERROR','SECRET_TOKEN'])assert.equal(durable.includes(privateText),false);
 assert.equal(f.original.collabAttempts[0].status,'unknown');assert.equal(f.host.kicks,undefined);
});

test('debug report requires source evidence, current exact event/project/attempt and original revision',async()=>{
 const f=await fixture(),begin=await f.call({action:'debug'}),base={action:'debug.report',attemptId:begin.attemptId,...report};
 assert.equal((await f.call(base)).error.code,'DEBUG_INSPECTION_REQUIRED');
 await inspect(f);
 assert.equal((await f.call({...base,bugId:'foreign'})).error.code,'DEBUG_SCOPE_MISMATCH');
 assert.equal((await f.call({...base,attemptId:'old'})).error.code,'DEBUG_ATTEMPT_STALE');
 f.work.revision++;assert.equal((await f.call(base)).error.code,'DEBUG_BINDING_STALE');f.work.revision--;
 f.original.revision++;assert.equal((await f.call(base)).error.code,'DEBUG_BINDING_STALE');f.original.revision--;
 f.host.projectId='other-project';assert.equal((await f.call(base)).error.code,'DEBUG_SCOPE_MISMATCH');f.host.projectId='project';
 f.host.current.set('orchestrator',{...f.event,id:'other-event'});assert.equal((await f.call(base)).error.code,'DEBUG_SCOPE_MISMATCH');f.host.current.set('orchestrator',f.event);
 assert.equal((await f.call({...base,diagnosis:'x'.repeat(1201)})).error.code,'DEBUG_REPORT_INVALID');
 assert.equal((await f.call({...base,diagnosis:''})).error.code,'DEBUG_REPORT_INVALID');
 assert.equal((await f.call({...base,rootCause:'token=SECRET'})).report.rootCause,'[redacted]');
});

test('debug source selector cannot become arbitrary filesystem/history/credential access',async()=>{
 const f=await fixture(),begin=await f.call({action:'debug'}),base={action:'debug.inspect',attemptId:begin.attemptId};
 for(const sourceId of ['/etc/passwd','../../secrets','history','source:99'])assert.equal((await f.call({...base,sourceId})).error.code,'DEBUG_SOURCE_INVALID');
 for(const args of [{startLine:0},{lineCount:81},{lineCount:1.5},{startLine:999999}])assert.equal((await f.call({...base,sourceId:'source:0',...args})).error.code,'DEBUG_SOURCE_INVALID');
 assert.equal((await f.read()).bugs[0].debug.inspections.length,0);
});

test('status/prose is pending, model outage stops without recursive debug or automatic requeue',async()=>{
 const f=await fixture();await f.call({action:'status'});assert.equal(await f.host.debugProtocol.completed(f.event),false);
 await f.host.debugProtocol.stopped(f.event);assert.equal((await f.read()).bugs[0].debug.state,'pending');
 await f.host.debugProtocol.stopped(f.event,{modelUnavailable:true});assert.equal((await f.read()).bugs[0].debug.state,'model-unavailable');assert.equal(f.original.debugState,'model-unavailable');
 assert.equal(f.host.store.state.jobs.filter(j=>j.type==='maintenance').length,1);assert.equal(f.host.kicks,undefined);
 assert.equal(f.host.internalRuntimeFailure(Object.assign(new TypeError('host bug'),{failureOrigin:'runtime'})),true);
 assert.equal(f.host.internalRuntimeFailure({code:'READ_REF_EXPIRED',failureOrigin:'host'}),true);
 assert.equal(f.host.internalRuntimeFailure({code:'HOST_BUDGET_PERSIST_FAILED'}),true);
 for(const error of [{code:'PI_MODEL_FAILED'},{code:'PI_REQUEST_TIMEOUT'},{code:'ECONNRESET'},{code:'PROVIDER_FAILED',failureOrigin:'provider'},{code:'EACCES',failureOrigin:'host'},{code:'WORK_CONTROL_HELD'},{code:'RESTART_RECONCILIATION_REQUIRED'},{code:'PI_HOST_TOOL_FAILED',hostToolCode:'EACCES',failureOrigin:'host'}])assert.equal(f.host.internalRuntimeFailure(error),false,JSON.stringify(error));
});

test('same-revision closure diagnosis remains read-only after business Work ended',async()=>{
 const f=await fixture({phase:'closure',workStatus:'ended'}),{begin}=await inspect(f);
 const result=await f.call({action:'debug.report',attemptId:begin.attemptId,...report});assert.equal(result.report.verifiedFix,false);assert.equal(f.work.status,'ended');assert.equal(f.host.maintenanceActions.size,0);
});

test('identical report repairs failed metadata projection without reinterpreting or replaying effects',async()=>{
 const f=await fixture(),{begin}=await inspect(f),args={action:'debug.report',attemptId:begin.attemptId,...report};
 const mutate=f.host.store.mutate;let failOnce=true;
 f.host.store.mutate=async fn=>{if(failOnce){failOnce=false;throw Object.assign(Error('projection fault'),{code:'EIO'});}return mutate(fn);};
 await assert.rejects(f.call(args),{code:'EIO'});
 const persisted=(await f.read()).bugs[0].debug.report;
 assert.equal(persisted.kind,'model-interpretation');assert.equal(f.original.debugState,'running');
 const retried=await f.call(args);
 assert.deepEqual(retried.report,persisted);assert.equal(f.original.debugState,'awaiting-fix');assert.equal(f.event.debugState,'awaiting-fix');assert.equal(f.work.maintenance.debugState,'awaiting-fix');
 assert.equal(f.original.collabAttempts[0].status,'unknown');assert.equal(f.host.kicks,undefined);
});

test('concurrent duplicate reports are idempotent and differing reports cannot overwrite serialized evidence',async()=>{
 const f=await fixture(),{begin}=await inspect(f),args={action:'debug.report',attemptId:begin.attemptId,...report};
 const results=await Promise.all([f.call(args),f.call({...args,diagnosis:'A competing incompatible interpretation.'})]);
 assert.equal(results.filter(r=>r.report).length,1);assert.equal(results.find(r=>r.error).error.code,'DEBUG_REPORT_INVALID');
 const saved=(await f.read()).bugs[0].debug.report;assert.deepEqual(saved,results.find(r=>r.report).report);
 const identical={...args,diagnosis:saved.diagnosis};const duplicates=await Promise.all([f.call(identical),f.call(identical)]);
 for(const result of duplicates)assert.deepEqual(result.report,saved);
 assert.equal(f.original.debugState,'awaiting-fix');assert.equal((await f.read()).bugs[0].status,'needs-version-fix');
});

test('cold reconciliation projects persisted metadata without model replay and skips stale revisions',async()=>{
 const f=await fixture(),{begin}=await inspect(f);
 await f.call({action:'debug.report',attemptId:begin.attemptId,...report});
 for(const job of [f.original,f.event]){delete job.debugState;delete job.debugEventJobId;delete job.debugAttemptId;}delete f.work.maintenance.debugState;
 const cold=new DebugProtocol(f.host);
 assert.deepEqual(await cold.reconcile(),{projected:1,modelReplayed:false});
 assert.equal(f.original.debugState,'awaiting-fix');assert.equal(f.original.debugAttemptId,begin.attemptId);assert.equal(f.event.debugEventJobId,f.event.id);assert.equal(f.work.maintenance.debugState,'awaiting-fix');
 f.work.revision++;f.original.debugState='new-revision';
 assert.deepEqual(await cold.reconcile(),{projected:0,modelReplayed:false});assert.equal(f.original.debugState,'new-revision');assert.equal(f.host.kicks,undefined);
});

test('only a genuine new event resets stopped debug and retains bounded prior attempt identity',async()=>{
 const f=await fixture(),{begin}=await inspect(f);
 await f.host.debugProtocol.stopped(f.event,{modelUnavailable:true});
 const stopped=(await f.read()).bugs[0].debug;
 await f.host.debugProtocol.queued(f.bug.id,f.event.id);assert.deepEqual((await f.read()).bugs[0].debug,stopped);
 const next={id:'new-debug-event',target:'orchestrator',type:'maintenance',status:'running',context:{bugId:f.bug.id}};
 f.host.store.state.jobs.unshift(next);f.host.current.set('orchestrator',next);
 await f.host.debugProtocol.queued(f.bug.id,next.id);
 const queued=(await f.read()).bugs[0].debug;assert.equal(queued.state,'queued');assert.equal(queued.eventJobId,next.id);assert.deepEqual(queued.previousAttempt,{eventJobId:f.event.id,attemptId:begin.attemptId,state:'model-unavailable'});assert.equal(queued.evidence,undefined);
 const restarted=await f.call({action:'debug'});assert.notEqual(restarted.attemptId,begin.attemptId);assert.deepEqual(restarted.debug.previousAttempt,queued.previousAttempt);
 await assert.rejects(f.host.debugProtocol.queued(f.bug.id,'another-event'),{code:'DEBUG_EVENT_NOT_REACTIVATABLE'});
 const source=restarted.evidence.sources[0];await f.call({action:'debug.inspect',attemptId:restarted.attemptId,sourceId:source.sourceId,lineCount:1});await f.call({action:'debug.report',attemptId:restarted.attemptId,...report});
 await assert.rejects(f.host.debugProtocol.queued(f.bug.id,'another-event'),{code:'DEBUG_EVENT_NOT_REACTIVATABLE'});
 assert.equal((await f.read()).bugs[0].debug.state,'awaiting-fix');assert.equal(f.host.kicks,undefined);
});

test('controller explicit activation creates a new diagnostic event only for stopped pending evidence',async()=>{
 for(const status of ['failed','interrupted']){
  const f=await fixture(),{begin}=await inspect(f);f.event.status=status;
  await f.host.debugProtocol.stopped(f.event);
  assert.equal(await f.host.maintenanceEvent(f.bug,{schedule:false}),undefined);
  assert.equal(f.host.store.state.jobs.filter(j=>j.type==='maintenance').length,1);
  const activated=await f.host.maintenanceEvent(f.bug,{reactivate:true,schedule:false});
  assert.notEqual(activated.eventJobId,f.event.id);assert.equal(activated.automaticReplay,false);
  assert.equal(f.event.status,status);assert.equal(f.original.status,'failed');assert.equal(f.original.collabAttempts[0].status,'unknown');
  const debug=(await f.read()).bugs[0].debug;assert.equal(debug.state,'queued');assert.equal(debug.previousAttempt.attemptId,begin.attemptId);
  const reused=await f.host.maintenanceEvent(f.bug,{reactivate:true,schedule:false});assert.equal(reused.eventJobId,activated.eventJobId);
  assert.equal(f.host.store.state.jobs.filter(j=>j.type==='maintenance').length,2);assert.equal(f.host.kicks,undefined);
 }
});

test('controller never loops completed or reported debug events even with explicit activation',async()=>{
 const completed=await fixture();await completed.host.debugProtocol.stopped(completed.event);completed.event.status='completed';
 assert.equal(await completed.host.maintenanceEvent(completed.bug,{reactivate:true,schedule:false}),undefined);
 const reported=await fixture(),{begin}=await inspect(reported);await reported.call({action:'debug.report',attemptId:begin.attemptId,...report});reported.event.status='failed';
 assert.equal(await reported.host.maintenanceEvent(reported.bug,{reactivate:true,schedule:false}),undefined);
 assert.equal(reported.host.store.state.jobs.filter(j=>j.type==='maintenance').length,1);assert.equal((await reported.read()).bugs[0].debug.state,'awaiting-fix');
});

test('provider recovery reactivates only its matching stopped diagnostic event',async()=>{
 const f=await fixture(),{begin}=await inspect(f);f.event.status='failed';f.event.serviceSource={provider:'affected-provider'};
 await f.host.debugProtocol.stopped(f.event,{modelUnavailable:true});
 await f.host.reactivateModelUnavailableDebug('other-provider');assert.equal(f.host.store.state.jobs.filter(j=>j.type==='maintenance').length,1);
 await f.host.reactivateModelUnavailableDebug('affected-provider');const next=f.host.store.state.jobs.find(j=>j.type==='maintenance'&&j.id!==f.event.id);
 assert.ok(next);assert.equal(next.status,'queued');assert.equal(f.event.status,'failed');assert.equal(f.original.collabAttempts[0].status,'unknown');assert.equal(f.host.kicks,1);
 assert.equal((await f.read()).bugs[0].debug.previousAttempt.attemptId,begin.attemptId);
 await f.host.reactivateModelUnavailableDebug('affected-provider');assert.equal(f.host.store.state.jobs.filter(j=>j.type==='maintenance').length,2);assert.equal(f.host.kicks,1);
});

test('provider activation fallback respects the diagnostic effective model and host stop',async()=>{
 const f=await fixture();f.event.status='interrupted';f.event.effective={model:'affected/model'};f.host.store.state.bindings={orchestrator:{model:'other/model'}};
 await f.host.debugProtocol.stopped(f.event,{modelUnavailable:true});
 await f.host.reactivateModelUnavailableDebug('other');assert.equal(f.host.store.state.jobs.filter(j=>j.type==='maintenance').length,1);
 f.host.stopping=true;await f.host.reactivateModelUnavailableDebug('affected');assert.equal(f.host.store.state.jobs.filter(j=>j.type==='maintenance').length,1);
 f.host.stopping=false;await f.host.reactivateModelUnavailableDebug('affected');assert.equal(f.host.store.state.jobs.filter(j=>j.type==='maintenance').length,2);
});

// ── DEBUG 临时运行时续行（dispatch-empty-brief 历史现场恢复回归）──────────
// 源码已把 brief 修为可选（省略/null/空白=冻结原请求），普通派工路径不再
// 触发 DISPATCH_BRIEF_EMPTY；以下用例从修复前历史现场已落盘的
// dispatchRejections 出发验收恢复合同，不在当前源码上复现已修复故障。
async function runtimeHost(){
 let local=null;
 const storage={getLocal:async()=>structuredClone(local),putLocal:async(_project,_key,value)=>{local=structuredClone(value);}};
 storage.requireRegistered=async projectId=>{assert.equal(projectId,'project');return {id:'project',instanceId:'runtime-recovery-fixture-instance'};};
 // Constructor dependencies are deliberately unavailable in this pure state
 // fixture; any unexpected artifact/project I/O must fail, not fake success.
 for(const method of ['putObject','readObject','getProject','putProject','listProject'])storage[method]=async()=>{throw Error('Unexpected '+method+' in in-memory runtime recovery fixture');};
 const intake={id:'intake-1',target:'orchestrator',type:'intake',status:'running',text:'我需要制作一个混沌系统的html演示'};
 const store={root:'/fixture/runtime',content:'/fixture/content',plan:'/fixture/runtime/memory/plantree/index.md',projectId:'project',state:{jobs:[intake],works:[],todos:[],messages:[],limit:3},storage,requireOnline:async()=>{},mutate:async fn=>fn(),find(id){const w=this.state.works.find(item=>item.id===id);if(!w)throw Error('unknown work');return w;},used:()=>0,submitState:Workspace.prototype.submitState};
 const host=Object.assign(new Controller(store,{projectId:'project'}),{coldJobs:new Set(),changed(){},kick(){this.kicks=(this.kicks??0)+1;}});
 host.maintenance=new MaintenanceLedger(storage,host.projectId);host.debugProtocol=new DebugProtocol(host);
 host.current.set('orchestrator',intake);
 return {host,intake,read:()=>host.maintenance.read()};
}
async function runtimeFixture({rejections=true,errorCode='DISPATCH_BRIEF_EMPTY'}={}){
 const {host,intake,read}=await runtimeHost();
 if(rejections){
  const name='混沌系统 HTML 演示';
  const intent=createHash('sha256').update(JSON.stringify({schema:1,tool:'nozeli_dispatch',name,brief:''})).digest('hex');
  intake.dispatchRejections=[{kind:'dispatch-empty-brief',intent,name,brief:'',at:new Date().toISOString()}];
 }
 Object.assign(intake,{status:'failed',errorCode,completion:'host-control'});
 const bug=await host.recordInternalFailure(intake,{code:errorCode,message:'task requires original request and brief'});
 await host.maintenanceEvent(bug,{schedule:false});
 const event=host.store.state.jobs.find(j=>j.type==='maintenance');event.status='running';host.current.set('orchestrator',event);
 const call=args=>host.handleTool('orchestrator',{tool:'nozeli_maintenance',arguments:{bugId:bug.id,...args}});
 return {host,bug,intake,event,call,read,state:host.store.state};
}
async function diagnose(f){
 const begin=await f.call({action:'debug'});
 const source=begin.evidence.sources.find(s=>s.path.endsWith('/workspace.mjs'));
 await f.call({action:'debug.inspect',attemptId:begin.attemptId,sourceId:source.sourceId,startLine:1,lineCount:10});
 await f.call({action:'debug.report',attemptId:begin.attemptId,...report});
 return begin;
}

test('a historically captured empty-brief failure continues once via debug with the original request, never a replay',async()=>{
 // 历史现场恢复验收：dispatchRejections 由修复前宿主在拒绝现场落盘，
 // 不是用当前源码重新制造故障（空 brief 现在会正常建 Work）。
 const {host,intake,bug,event,call}=await runtimeFixture();
 assert.equal(intake.status,'failed');assert.equal(intake.routing,undefined);assert.deepEqual(host.store.state.works,[]);
 assert.equal(intake.dispatchRejections.length,1);assert.equal(intake.dispatchRejections[0].kind,'dispatch-empty-brief');
 assert.equal(intake.dispatchRejections[0].name,'混沌系统 HTML 演示');
 assert.equal(host.internalRuntimeFailure(Object.assign(Error('task requires original request and brief'),{code:'DISPATCH_BRIEF_EMPTY',completion:'host-control'})),true);
 const begin=await call({action:'debug'});
 assert.equal(begin.evidence.originalJob.type,'intake');assert.equal(begin.evidence.originalJob.status,'failed');
 assert.equal(begin.hostContinuation.kind,'dispatch-empty-brief');assert.equal(begin.evidence.continuationCapability.name,'混沌系统 HTML 演示');
 const source=begin.evidence.sources.find(s=>s.path.endsWith('/workspace.mjs'));assert(source,'actual rejecting guard source is inspectable');
 await call({action:'debug.inspect',attemptId:begin.attemptId,sourceId:source.sourceId,startLine:1,lineCount:10});
 const reported=await call({action:'debug.report',attemptId:begin.attemptId,...report});
 assert.equal(reported.report.verifiedFix,false);assert.equal(reported.hostContinuation.kind,'dispatch-empty-brief');
 const continued=await call({action:'debug.continue',attemptId:begin.attemptId});
 assert.equal(continued.ok,true);assert.equal(continued.verifiedFix,false);assert.equal(continued.sourceRepairRequired,true);
 assert.equal(continued.debugState,'continued-with-known-fault');assert.equal(continued.duplicate,false);assert.equal(continued.continueTurn,true);
 const works=host.store.state.works;assert.equal(works.length,1);
 assert.equal(works[0].sourceJob,intake.id);assert.equal(works[0].request,intake.text);assert.equal(works[0].brief,intake.text);assert.equal(works[0].name,'混沌系统 HTML 演示');
 assert.equal(intake.routing.workId,works[0].id);assert.equal(intake.routing.action,'dispatch');assert.equal(intake.routing.hostContinuation.bugId,bug.id);
 assert.equal(intake.status,'completed');assert.ok(intake.continuedAt);
 assert.equal(host.store.state.messages.filter(m=>m.jobId===intake.id&&m.speaker==='system'&&m.continuation?.bugId===bug.id).length,1);
 assert.equal(host.kicks,1);
 const saved=(await host.maintenance.read()).bugs.find(item=>item.id===bug.id);
 assert.equal(saved.debug.state,'continued-with-known-fault');assert.equal(saved.debug.report.verifiedFix,false);assert.equal(saved.debug.sourceRepairRequired,true);
 assert.equal(saved.debug.continuation.workId,works[0].id);assert.notEqual(saved.status,'repaired');
 assert.equal(intake.debugState,'continued-with-known-fault');
 assert.equal(await host.debugProtocol.completed(event),true);
 const duplicate=await call({action:'debug.continue',attemptId:begin.attemptId});
 assert.equal(duplicate.duplicate,true);assert.equal(duplicate.workId,works[0].id);assert.equal(duplicate.verifiedFix,false);
 const concurrent=await Promise.all([call({action:'debug.continue',attemptId:begin.attemptId}),call({action:'debug.continue',attemptId:begin.attemptId})]);
 assert.equal(host.store.state.works.length,1);assert.equal(new Set(concurrent.map(item=>item.workId)).size,1);
 assert.equal(JSON.stringify(await host.maintenance.read()).includes(intake.text),false,'no user request text enters the maintenance ledger');
});

test('debug.continue is explicitly blocked without precise evidence, fences or a valid attempt',async()=>{
 const historic=await runtimeFixture({rejections:false});
 const h1=await diagnose(historic);
 assert.equal((await historic.call({action:'debug.continue',attemptId:h1.attemptId})).error.code,'DEBUG_CONTINUE_UNAVAILABLE');
 assert.equal(historic.state.works.length,0);
 const early=await runtimeFixture();
 const h2=await early.call({action:'debug'});
 assert.equal((await early.call({action:'debug.continue',attemptId:h2.attemptId})).error.code,'DEBUG_CONTINUE_REPORT_REQUIRED');
 const fenced=await runtimeFixture();
 const h3=await diagnose(fenced);
 assert.equal((await fenced.call({action:'debug.continue',attemptId:'wrong'})).error.code,'DEBUG_ATTEMPT_STALE');
 assert.equal((await fenced.call({action:'debug.continue',bugId:'bug:foreign',attemptId:h3.attemptId})).error.code,'DEBUG_SCOPE_MISMATCH');
 for(const fence of [
  f=>{f.intake.manualControl={version:0,pause:{at:new Date().toISOString()},stop:null,receipts:[]};},
  f=>{f.host.taskPermissions={heldFor:async()=>true};},
  f=>{f.intake.routing={action:'dispatch',intent:'already-routed',workId:'work-x',at:new Date().toISOString()};},
  f=>{f.state.works.push({id:'work-x',sourceJob:f.intake.id,revision:0,status:'queued',request:f.intake.text,brief:'已有后台 Work'});},
  f=>{f.intake.status='cancelled';},
 ]){
  const f=await runtimeFixture();const begin=await diagnose(f);fence(f);const beforeWorks=f.state.works.map(w=>w.id);
  const code=f.intake.status==='cancelled'?'DEBUG_BINDING_STALE':'DEBUG_CONTINUE_UNAVAILABLE';
  assert.equal((await f.call({action:'debug.continue',attemptId:begin.attemptId})).error.code,code);
  assert.deepEqual(f.state.works.map(w=>w.id),beforeWorks);
  const saved=(await f.read()).bugs[0];assert.equal(saved.debug.state,'awaiting-fix');if(code==='DEBUG_CONTINUE_UNAVAILABLE')assert.equal(saved.debug.lastContinueBlocked.code,code);
 }
 const mismatch=await runtimeFixture({errorCode:'PI_HOST_TOOL_FAILED'});
 const h4=await diagnose(mismatch);
 assert.equal((await mismatch.call({action:'debug.continue',attemptId:h4.attemptId})).error.code,'DEBUG_CONTINUE_UNAVAILABLE');
 assert.equal(mismatch.state.works.length,0);assert.equal(mismatch.host.kicks,undefined);
});

test('cold reconciliation and stopped events settle continuation strictly from the durable receipt',async()=>{
 const committed=await runtimeFixture();const begin=await diagnose(committed);
 await committed.call({action:'debug.continue',attemptId:begin.attemptId});
 const workId=committed.state.works[0].id,kicks=committed.host.kicks;
 await committed.host.maintenance.mutate(state=>{state.bugs.find(item=>item.id===committed.bug.id).debug.state='continuing';});
 delete committed.intake.debugState;
 await new DebugProtocol(committed.host).reconcile();
 assert.equal((await committed.read()).bugs[0].debug.state,'continued-with-known-fault');
 assert.equal(committed.intake.debugState,'continued-with-known-fault');
 assert.equal(committed.state.works.length,1);assert.equal(committed.host.kicks,kicks);
 const interrupted=await runtimeFixture();const other=await diagnose(interrupted);
 await interrupted.host.maintenance.mutate(state=>{state.bugs.find(item=>item.id===interrupted.bug.id).debug.state='continuing';});
 await new DebugProtocol(interrupted.host).reconcile();
 assert.equal((await interrupted.read()).bugs[0].debug.state,'awaiting-fix');assert.ok((await interrupted.read()).bugs[0].debug.continuationInterruptedAt);
 assert.equal(interrupted.state.works.length,0);assert.equal(interrupted.host.kicks,undefined);
 const stoppedCommitted=await runtimeFixture();const sc=await diagnose(stoppedCommitted);
 await stoppedCommitted.call({action:'debug.continue',attemptId:sc.attemptId});
 await stoppedCommitted.host.maintenance.mutate(state=>{state.bugs.find(item=>item.id===stoppedCommitted.bug.id).debug.state='continuing';});
 await stoppedCommitted.host.debugProtocol.stopped(stoppedCommitted.event);
 assert.equal((await stoppedCommitted.read()).bugs[0].debug.state,'continued-with-known-fault');assert.equal(stoppedCommitted.state.works.length,1);
 const stoppedBare=await runtimeFixture();const sb=await diagnose(stoppedBare);
 await stoppedBare.host.maintenance.mutate(state=>{state.bugs.find(item=>item.id===stoppedBare.bug.id).debug.state='continuing';});
 await stoppedBare.host.debugProtocol.stopped(stoppedBare.event);
 assert.equal((await stoppedBare.read()).bugs[0].debug.state,'awaiting-fix');assert.equal(stoppedBare.state.works.length,0);
});

test('normal-brief dispatch keeps its ordinary contract beside the temporary continuation path',async()=>{
 const {host,intake}=await runtimeHost();
 const receipt=await host.handleTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'混沌系统 HTML 演示',brief:'离线 Lorenz 混沌系统 HTML 演示'}});
 assert.equal(receipt.action,'dispatch');assert.equal(host.store.state.works.length,1);
 assert.equal(host.store.state.works[0].brief,'离线 Lorenz 混沌系统 HTML 演示');
 assert.equal(host.store.state.works[0].sourceJob,intake.id);assert.equal(intake.routing.workId,receipt.workId);
 assert.equal(intake.dispatchRejections,undefined);assert.equal(host.kicks,1);
 const replay=await host.handleTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'混沌系统 HTML 演示',brief:'离线 Lorenz 混沌系统 HTML 演示'}});
 assert.equal(replay.workId,receipt.workId);assert.equal(host.store.state.works.length,1);
});

test('fixed dispatch never records rejection evidence; storage-unknown and intent conflicts still propagate',async()=>{
 const {host,intake}=await runtimeHost();
 const dispatch=()=>host.handleTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'混沌系统 HTML 演示',brief:''}});
 // 存储/提交未知异常在真实派工路径上原样上抛，绝不吞错或改写为安全证据。
 const realSubmit=host.store.submitState;
 host.store.submitState=()=>{throw Object.assign(Error('commit outcome unknown'),{code:'STORAGE_RESULT_UNKNOWN',commitUnknown:{projectId:'project'}});};
 await assert.rejects(dispatch(),{code:'STORAGE_RESULT_UNKNOWN'});
 host.store.submitState=()=>{throw Object.assign(Error('rollback failed'),{code:'EIO',rollbackFailures:[Error('hook')]});};
 await assert.rejects(dispatch(),error=>Array.isArray(error.rollbackFailures)&&error.rollbackFailures.length===1);
 host.store.submitState=realSubmit;
 assert.deepEqual(host.store.state.works,[]);assert.equal(intake.routing,undefined);assert.equal(intake.dispatchRejections,undefined);
 // routing 已存在且意图不同时的意图冲突不创建 Work，也不再写任何拒绝证据。
 intake.routing={action:'dispatch',intent:'other',workId:'work-y',at:new Date().toISOString()};
 await assert.rejects(dispatch(),{code:'INTENT_MISMATCH'});
 assert.equal(intake.dispatchRejections,undefined);
});

test('empty, omitted, null and blank brief dispatch once under the frozen original request',async()=>{
 const {host,intake}=await runtimeHost();
 const receipt=await host.handleTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'混沌系统 HTML 演示',brief:''}});
 assert.equal(receipt.action,'dispatch');assert.equal(receipt.status,'queued');
 const works=host.store.state.works;assert.equal(works.length,1);
 assert.equal(works[0].sourceJob,intake.id);
 assert.equal(works[0].request,intake.text);assert.equal(works[0].brief,intake.text,'blank brief runs the Work under the frozen original request');
 assert.equal(works[0].name,'混沌系统 HTML 演示');
 assert.deepEqual(works[0].sourceInputJobIds,[intake.id]);
 assert.equal(intake.routing.workId,works[0].id);assert.equal(intake.dispatchRejections,undefined);assert.equal(host.kicks,1);
 // 归一化等价重复：省略/null/空白/显式原请求重放同一回执，不重复建 Work。
 for(const args of [{name:'混沌系统 HTML 演示'},{name:'混沌系统 HTML 演示',brief:null},{name:'混沌系统 HTML 演示',brief:'   '},{name:'混沌系统 HTML 演示',brief:intake.text}]){
  const replay=await host.handleTool('orchestrator',{tool:'nozeli_dispatch',arguments:args});
  assert.equal(replay.workId,receipt.workId);assert.equal(replay.at,receipt.at);
 }
 assert.equal(host.store.state.works.length,1);
 // 不同有效 brief 不得继承既有回执，也不创建第二个 Work。
 await assert.rejects(host.handleTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'混沌系统 HTML 演示',brief:'另一个执行说明'}}),{code:'INTENT_MISMATCH'});
 assert.equal(host.store.state.works.length,1);
});

test('non-string brief is a correctable INVALID_PAYLOAD with zero writes and no internal fault',async()=>{
 const {host,intake}=await runtimeHost();
 for(const brief of [5,{note:'x'},true]){
  const rejected=await host.handleTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'混沌系统 HTML 演示',brief}});
  assert.equal(rejected.ok,false);assert.equal(rejected.continueTurn,true);assert.equal(rejected.error.code,'INVALID_PAYLOAD');assert.equal(rejected.hostControl,undefined);
 }
 assert.deepEqual(host.store.state.works,[]);assert.equal(intake.routing,undefined);assert.equal(intake.dispatchRejections,undefined);
 assert.deepEqual((await host.maintenance.read()).bugs,[],'correctable payload correction is not an internal program fault');
 // 同一 intake 随后用正确参数派工仍成功：可纠正错误不废回合、不需用户重发。
 const corrected=await host.handleTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'混沌系统 HTML 演示'}});
 assert.equal(corrected.action,'dispatch');assert.equal(host.store.state.works.length,1);assert.equal(host.store.state.works[0].brief,intake.text);
});

test('continuation re-verifies stop, permission and exact intent fences inside the business transaction',async()=>{
 const f=await runtimeFixture();const begin=await diagnose(f);
 const realCapability=f.host.debugContinuationCapability.bind(f.host);
 f.host.debugContinuationCapability=async bug=>{const capability=await realCapability(bug);f.host.stopping=true;return capability;};
 assert.equal((await f.call({action:'debug.continue',attemptId:begin.attemptId})).error.code,'DEBUG_CONTINUE_UNAVAILABLE');
 assert.equal(f.state.works.length,0);
 let saved=(await f.read()).bugs[0];assert.equal(saved.debug.state,'awaiting-fix');assert.equal(saved.debug.lastContinueBlocked.code,'DEBUG_CONTINUE_UNAVAILABLE');
 f.host.stopping=false;f.host.debugContinuationCapability=realCapability;
 const g=await runtimeFixture();const other=await diagnose(g);
 const realCap=g.host.debugContinuationCapability.bind(g.host);
 const held={value:false};g.host.taskPermissions={heldFor:async()=>held.value};
 g.host.debugContinuationCapability=async bug=>{const capability=await realCap(bug);held.value=true;return capability;};
 assert.equal((await g.call({action:'debug.continue',attemptId:other.attemptId})).error.code,'DEBUG_CONTINUE_UNAVAILABLE');
 assert.equal(g.state.works.length,0);
 saved=(await g.read()).bugs[0];assert.equal(saved.debug.state,'awaiting-fix');assert.equal(saved.debug.lastContinueBlocked.code,'DEBUG_CONTINUE_UNAVAILABLE');
 const duringPermission=await runtimeFixture();const permissionBegin=await diagnose(duringPermission);let permissionReads=0;
 duringPermission.host.taskPermissions={heldFor:async()=>{if(++permissionReads===2)duringPermission.host.stopping=true;return false;}};
 assert.equal((await duringPermission.call({action:'debug.continue',attemptId:permissionBegin.attemptId})).error.code,'DEBUG_CONTINUE_UNAVAILABLE');
 assert.equal(duringPermission.state.works.length,0,'a stop arriving during the final permission read prevents first dispatch');
 const h=await runtimeFixture();
 h.intake.dispatchRejections=[{kind:'dispatch-empty-brief',intent:'b'.repeat(64),name:'混沌系统 HTML 演示',brief:'',at:new Date().toISOString()}];
 const begin3=await diagnose(h);
 assert.equal(begin3.hostContinuation,null,'a rejection row whose intent does not match its own name/brief is not evidence');
 assert.equal((await h.call({action:'debug.continue',attemptId:begin3.attemptId})).error.code,'DEBUG_CONTINUE_UNAVAILABLE');
 assert.equal(h.state.works.length,0);assert.equal(h.host.kicks,undefined);
});

test('a committed receipt with failing ledger settles reports projectionPending, never a fabricated terminal',async()=>{
 const f=await runtimeFixture();const begin=await diagnose(f);
 const realContinue=f.host.debugContinuation.bind(f.host);
 const mutate=f.host.maintenance.mutate.bind(f.host.maintenance);
 let failSettle=false;
 f.host.maintenance.mutate=fn=>failSettle?Promise.reject(Object.assign(Error('ledger offline'),{code:'EIO'})):mutate(fn);
 f.host.debugContinuation=async(...args)=>{failSettle=true;return realContinue(...args);};
 const result=await f.call({action:'debug.continue',attemptId:begin.attemptId});
 assert.equal(result.ok,true);assert.equal(result.projectionPending,true);assert.equal(result.debugState,'continuing');
 assert.equal(result.verifiedFix,false);assert.equal(result.workId,f.state.works[0].id);
 assert.equal(f.state.works.length,1);
 assert.equal((await f.read()).bugs[0].debug.state,'continuing');
 assert.equal(await f.host.debugProtocol.completed(f.event),false);
 failSettle=false;f.host.maintenance.mutate=mutate;
 await f.host.debugProtocol.stopped(f.event);
 assert.equal((await f.read()).bugs[0].debug.state,'continued-with-known-fault');
 assert.equal(f.state.works.length,1);
 // awaiting-fix 落下已提交回执后，冷 reconcile 也收正为终态（不长期悬置）。
 const g=await runtimeFixture();const other=await diagnose(g);
 await g.call({action:'debug.continue',attemptId:other.attemptId});
 await g.host.maintenance.mutate(state=>{state.bugs.find(item=>item.id===g.bug.id).debug.state='awaiting-fix';});
 await new DebugProtocol(g.host).reconcile();
 assert.equal((await g.read()).bugs[0].debug.state,'continued-with-known-fault');
 assert.equal(g.intake.debugState,'continued-with-known-fault');assert.equal(g.state.works.length,1);
});
