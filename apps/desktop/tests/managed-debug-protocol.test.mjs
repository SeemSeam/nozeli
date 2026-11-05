import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/agents/managed/controller.mjs';
import {MaintenanceLedger} from '../src/agents/managed/maintenance-ledger.mjs';
import {DebugProtocol} from '../src/agents/managed/debug-protocol.mjs';

async function fixture({phase='runtime',workStatus='running'}={}){
 let local=null;
 const storage={getLocal:async()=>structuredClone(local),putLocal:async(_project,_key,value)=>{local=structuredClone(value);}};
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
