// Focused recovery tests for legacy nozeli_diagram validation failures.
// Deterministic: no live model, no real project, no vendor renderer.
import {openTestController} from './project-storage.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {DiagramRecovery} from '../src/agents/managed/diagram-recovery.mjs';

const wait=async fn=>{const end=Date.now()+15000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('condition timeout');};
// The controller fixture fake from managed-controller.test.mjs; no provider is
// ever prompted here because automation stays off after start().
class FakeSession{constructor(spec,target){Object.assign(this,spec,{target,closed:false,busy:false,interactions:[],contextEpoch:'compaction:0:root',hasPrompted:false,phase:'idle',toolsDigest:'fixture-native-schema'});}async preflightToolsDigest(){}async assertToolsDigest(){}async start(id){this.threadId=id||randomUUID();return this;}async prompt(text){this.hasPrompted=true;this.busy=true;try{return {text:'fixture response',threadId:this.threadId,turnId:randomUUID()};}finally{this.busy=false;this.phase='idle';}}async stop(){this.closed=true;return {confirmationComplete:true};}}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-diagram-recovery-'));
  const c=await openTestController({runtimeRoot:path.join(root,'data'),contentRoot:path.join(root,'content'),sessionFactory:(spec,target)=>new FakeSession(spec,target)});
  await c.start();await wait(()=>!c.kicking);c.started=false;
  t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});
  return c;
}
// Renderer contract stub mirroring the corrected renderArchifyDiagram
// classification: typed failure with the actual closed-vocabulary category and
// lower slash rule codes.
const typedFailure=async()=>{const error=new Error('diagram validation failure');error.code='DIAGRAM_INPUT_INVALID';error.diagramEvidence={tool:'nozeli_diagram',stage:'validation',effect:'none',category:'layout',rules:[{code:'layout/constraint',count:1}]};error.correction={nodeIds:['node-1']};throw error;};
const untypedFailure=async()=>{throw new Error('geometry exploded');};
// Each seeded Work gets its own native thread and entry identities so several
// fixtures can share one controller journal without record collisions.
async function seed(c,{tool='nozeli_diagram',extraTail=false,threadId=null,workThreadId=undefined,attemptStatus='settled',recordConfirmed=true,manual=false,phase='runtime',bugCode='PI_HOST_TOOL_FAILED',workId=null}={}){
  workId??='work-'+randomUUID().slice(0,8);
  const suffix=randomUUID().slice(0,8);
  threadId??='thread-'+suffix;
  workThreadId??=threadId;
  const jobId='job-'+randomUUID().slice(0,8),sessionId=threadId,epoch=sessionId+'#0',requestId='req-'+randomUUID().slice(0,8),revision=3;
  const bug=await c.maintenance.record({phase,jobId,workId,revision,error:{code:bugCode,message:'host tool failed'}});
  await c.maintenance.finish(bug.id,{outcome:'needs-version-fix'});
  const callId='call-'+randomUUID().slice(0,8);
  await c.store.mutate(()=>{
    c.store.state.works??=[];c.store.state.todos??=[];
    c.store.state.works.push({id:workId,status:'paused',revision,request:'original diagram request',threadId:workThreadId,createdAt:new Date().toISOString(),maintenance:{bugId:bug.id,status:'needs-version-fix',message:'系统故障已记录，原任务与改动保留。'}});
    c.store.state.jobs.push({id:jobId,target:workId,type:'initial',status:'failed',revision,text:'original diagram request',error:'Host tool failed',errorCode:bugCode,finishedAt:new Date().toISOString(),maintenanceBugId:bug.id,maintenanceFault:{phase,code:bugCode},context:{},at:new Date().toISOString(),collabAttempts:[{requestId,sessionId,epoch,status:attemptStatus,everAdmitted:true,definitiveRejection:false,recordConfirmed,nativeEntryId:'user-entry-'+suffix}]});
    c.store.state.todos.push({id:randomUUID(),workId,revision,sourceJobId:jobId,kind:'recovery',status:'open',text:'Worker 回合已结束，但尚未发布最终成果或问题报告。'});
    if(manual)c.store.state.works.at(-1).manualControl={pause:new Date().toISOString()};
  });
  const arguments_=tool==='nozeli_diagram'?{type:'workflow',spec:{diagram_type:'workflow',meta:{title:'原任务图示'+suffix},nodes:[],edges:[]}}:{kind:'result',content:staticReport('fixture report '+suffix)};
  const facts=[{sessionId,epoch,requestId,jobId,entry:{type:'message',id:'entry-assistant-'+suffix,message:{role:'assistant',content:[{type:'toolCall',id:callId,name:tool,arguments:arguments_}]}}},{sessionId,epoch,requestId,jobId,entry:{type:'message',id:'entry-tool-result-'+suffix,message:{role:'toolResult',toolName:tool,toolCallId:callId,content:[{type:'text',text:JSON.stringify({code:'HOST_TOOL_ERROR',message:'Diagram validation failed'})}],isError:true}}}];
  if(extraTail)facts.push({sessionId,epoch,requestId,jobId,entry:{type:'message',id:'entry-after-'+suffix,message:{role:'assistant',content:[{type:'text',text:'later assistant text'}]}}});
  await c.timeline.recordBatch(facts,workId);
  return {bug,workId,jobId,callId,sessionId,epoch,suffix};
}
const supplements=(c,workId)=>c.store.state.jobs.filter(job=>job.target===workId&&job.type==='supplement');

test('legacy failed job with generic error text recovers once from verified immutable diagram history',async t=>{
  const c=await fixture(t),{bug,workId,jobId,callId,sessionId}=await seed(c);
  const recovery=new DiagramRecovery(c,{render:typedFailure});
  const result=await recovery.recover(bug.id,{expectedRevision:3,requestKey:'user-recovery-1',explicit:true});
  assert.equal(result.recovered,true);assert.equal(result.settled,true);assert.ok(result.supplementJobId);
  // Original job stays failed history with a bound, digested receipt.
  const job=c.store.state.jobs.find(row=>row.id===jobId);
  assert.equal(job.status,'failed');assert.equal(job.errorCode,'PI_HOST_TOOL_FAILED');
  assert.equal(job.diagramRecovery.bugId,bug.id);assert.equal(job.diagramRecovery.toolCallId,callId);
  assert.equal(job.diagramRecovery.threadId,sessionId);assert.match(job.diagramRecovery.specDigest,/^[a-f0-9]{64}$/);
  assert.match(job.diagramRecovery.originalErrorDigest,/^[a-f0-9]{64}$/);assert.equal(job.diagramRecovery.originalErrorCode,'HOST_TOOL_ERROR');
  assert.equal(job.diagramRecovery.rerun.code,'DIAGRAM_INPUT_INVALID');assert.equal(job.diagramRecovery.rerun.effect,'none');
  assert.equal(job.diagramRecovery.rerun.category,'layout');assert.deepEqual(job.diagramRecovery.rerun.rules,[{code:'layout/constraint',count:1}]);
  assert.ok(job.diagramRecovery.settledAt);
  // Raw archived error text and spec never leak into durable state.
  assert(!JSON.stringify(job.diagramRecovery).includes('Diagram validation failed'));
  // One bound supplement: original thread, revision and source retained; the
  // original request itself is never resent.
  const queued=supplements(c,workId);
  assert.equal(queued.length,1);assert.equal(queued[0].key,'diagram-recovery:'+bug.id);assert.equal(queued[0].status,'queued');
  assert.equal(queued[0].context.sourceJobId,jobId);assert.equal(queued[0].context.diagramRecoveryReceiptId,job.diagramRecovery.id);
  assert(queued[0].text.includes('DIAGRAM_INPUT_INVALID'));assert(queued[0].text.includes(callId));assert(!queued[0].text.includes('original diagram request'));
  assert.equal(c.store.state.jobs.filter(row=>row.target===workId&&row.type==='initial').length,1);
  const work=c.store.find(workId);
  assert.equal(work.status,'running');assert.equal(work.revision,3);assert.equal(work.threadId,sessionId);assert.equal(work.maintenance,undefined);
  assert.equal(c.store.state.todos.find(row=>row.sourceJobId===jobId).status,'resolved');
  // Ledger records only the corrected classification, never task completion.
  const saved=(await c.maintenance.read()).bugs.find(row=>row.id===bug.id);
  assert.equal(saved.status,'repaired');assert.equal(saved.lastOutcome.outcome,'diagram-classification-corrected');
});

test('final archived tool call that is not nozeli_diagram denies without effects',async t=>{
  const c=await fixture(t),{bug,workId,jobId}=await seed(c,{tool:'nozeli_report'});
  await assert.rejects(new DiagramRecovery(c,{render:typedFailure}).recover(bug.id),error=>error.code==='DIAGRAM_RECOVERY_DENIED'&&error.reason==='wrong-tool');
  assert.equal(supplements(c,workId).length,0);
  assert.equal(c.store.state.jobs.find(row=>row.id===jobId).diagramRecovery,undefined);
  assert.equal((await c.maintenance.read()).bugs.find(row=>row.id===bug.id).status,'needs-version-fix');
});

test('entries after the failed diagram tool result deny the recovery',async t=>{
  const c=await fixture(t),{bug,workId}=await seed(c,{extraTail:true});
  await assert.rejects(new DiagramRecovery(c,{render:typedFailure}).recover(bug.id),error=>error.code==='DIAGRAM_RECOVERY_DENIED'&&error.reason==='wrong-tail');
  assert.equal(supplements(c,workId).length,0);
});

test('changed revision denies recovery before any mutation',async t=>{
  const c=await fixture(t),{bug,workId}=await seed(c);
  await assert.rejects(new DiagramRecovery(c,{render:typedFailure}).recover(bug.id,{expectedRevision:2}),error=>error.code==='DIAGRAM_RECOVERY_DENIED'&&error.reason==='stale-revision');
  assert.equal(supplements(c,workId).length,0);
  await assert.rejects(new DiagramRecovery(c,{render:typedFailure}).recover(bug.id,{expectedRevision:'three'}),error=>error.reason==='invalid-revision');
});

test('manual pause fence stays closed for recovery',async t=>{
  const c=await fixture(t),{bug,workId}=await seed(c,{manual:true});
  await assert.rejects(new DiagramRecovery(c,{render:typedFailure}).recover(bug.id),error=>error.code==='DIAGRAM_RECOVERY_DENIED'&&error.reason==='manual-control-held');
  assert.equal(supplements(c,workId).length,0);assert.equal(c.store.find(workId).status,'paused');
});

test('unknown bug and foreign thread deny recovery',async t=>{
  const c=await fixture(t);
  await assert.rejects(new DiagramRecovery(c,{render:typedFailure}).recover('bug:missing'),error=>error.code==='DIAGRAM_RECOVERY_DENIED'&&error.reason==='unknown-bug');
  const {bug:bound,workId}=await seed(c,{workThreadId:'thread-other'});
  await assert.rejects(new DiagramRecovery(c,{render:typedFailure}).recover(bound.id),error=>error.reason==='thread-mismatch');
  assert.equal(supplements(c,workId).length,0);
});

test('bug whose workId does not match the original Work denies recovery',async t=>{
  const c=await fixture(t),seeded=await seed(c);
  // A differently-bound bug must first own the job/work maintenance markers;
  // only then does the identity mismatch itself become the denial reason.
  const forged=await c.maintenance.record({phase:'runtime',jobId:seeded.jobId,workId:'work-other',revision:3,error:{code:'PI_HOST_TOOL_FAILED',message:'host tool failed'}});
  await c.maintenance.finish(forged.id,{outcome:'needs-version-fix'});
  await c.store.mutate(()=>{
    const job=c.store.state.jobs.find(row=>row.id===seeded.jobId);job.maintenanceBugId=forged.id;job.maintenanceFault={phase:'runtime',code:'PI_HOST_TOOL_FAILED'};
    const work=c.store.find(seeded.workId);work.maintenance={bugId:forged.id,status:'needs-version-fix',message:'系统故障已记录，原任务与改动保留。'};
  });
  await assert.rejects(new DiagramRecovery(c,{render:typedFailure}).recover(forged.id),error=>error.code==='DIAGRAM_RECOVERY_DENIED'&&error.reason==='binding-mismatch');
  assert.equal(supplements(c,seeded.workId).length,0);
});

test('an active or newer job on the same Work denies recovery',async t=>{
  const c=await fixture(t),seeded=await seed(c);
  const active={id:'job-active-'+randomUUID().slice(0,8),target:seeded.workId,type:'supplement',status:'running',text:'already running follow-up',context:{},promptStartedAt:Date.now(),at:new Date().toISOString()};
  await c.store.mutate(()=>{c.store.state.jobs.push(active);});
  const before=supplements(c,seeded.workId).length;
  c.current.set(seeded.workId,active);
  await assert.rejects(new DiagramRecovery(c,{render:typedFailure}).recover(seeded.bug.id),error=>error.code==='DIAGRAM_RECOVERY_DENIED'&&error.reason==='work-active');
  assert.equal(supplements(c,seeded.workId).length,before,'denial must not add or remove follow-up jobs');
  await c.store.mutate(()=>{const row=c.store.state.jobs.find(job=>job.id===active.id);row.status='completed';});
  c.current.delete(seeded.workId);
  assert.equal((await new DiagramRecovery(c,{render:typedFailure}).recover(seeded.bug.id)).recovered,true);
  assert.equal(supplements(c,seeded.workId).length,before+1,'recovery queues exactly one supplement beside the finished follow-up');
});

test('newer native conversation on the original thread denies recovery',async t=>{
  const c=await fixture(t),seeded=await seed(c);
  const newer={id:'job-newer-'+randomUUID().slice(0,8),target:seeded.workId,type:'supplement',status:'completed',revision:3,text:'follow-up',context:{},at:new Date().toISOString(),collabAttempts:[{requestId:'req-newer',sessionId:seeded.sessionId,epoch:seeded.epoch,status:'settled',everAdmitted:true,definitiveRejection:false,recordConfirmed:true}]};
  await c.store.mutate(()=>{c.store.state.jobs.push(newer);});
  const before=supplements(c,seeded.workId).length;
  await c.timeline.recordBatch([{sessionId:seeded.sessionId,epoch:seeded.epoch,requestId:'req-newer',jobId:newer.id,entry:{type:'message',id:'entry-newer-'+seeded.suffix,message:{role:'assistant',content:[{type:'text',text:'the thread moved on'}]}}}],seeded.workId);
  await assert.rejects(new DiagramRecovery(c,{render:typedFailure}).recover(seeded.bug.id),error=>error.code==='DIAGRAM_RECOVERY_DENIED'&&error.reason==='wrong-tail');
  assert.equal(supplements(c,seeded.workId).length,before,'denial must not add or remove follow-up jobs');
});

test('a Work whose maintenance pause was already removed denies recovery',async t=>{
  const c=await fixture(t),seeded=await seed(c);
  await c.store.mutate(()=>{const work=c.store.find(seeded.workId);delete work.maintenance;});
  await assert.rejects(new DiagramRecovery(c,{render:typedFailure}).recover(seeded.bug.id),error=>error.code==='DIAGRAM_RECOVERY_DENIED'&&error.reason==='maintenance-binding');
  assert.equal(supplements(c,seeded.workId).length,0);assert.equal(c.store.find(seeded.workId).status,'paused');
});

test('a held project lifecycle denies recovery without effects',async t=>{
  const c=await fixture(t),seeded=await seed(c);
  const storage=c.store.storage,assertActive=storage.assertActive;
  storage.assertActive=()=>{throw Object.assign(new Error('project stopping'),{code:'PROJECT_LIFECYCLE_ACTIVE'});};
  await assert.rejects(new DiagramRecovery(c,{render:typedFailure}).recover(seeded.bug.id),error=>error.code==='DIAGRAM_RECOVERY_DENIED'&&error.reason==='lifecycle-held');
  storage.assertActive=assertActive;
  assert.equal(supplements(c,seeded.workId).length,0);
  assert.equal((await new DiagramRecovery(c,{render:typedFailure}).recover(seeded.bug.id)).recovered,true);
});

test('a held permission decision denies recovery for that original job only',async t=>{
  const c=await fixture(t),held=await seed(c),free=await seed(c);
  c.taskPermissions={heldFor:async(projectId,job)=>projectId===c.projectId&&job?.id===held.jobId};
  await assert.rejects(new DiagramRecovery(c,{render:typedFailure}).recover(held.bug.id),error=>error.code==='DIAGRAM_RECOVERY_DENIED'&&error.reason==='human-decision-required');
  assert.equal(supplements(c,held.workId).length,0);assert.equal(c.store.find(held.workId).status,'paused');
  c.taskPermissions=null;
  assert.equal((await new DiagramRecovery(c,{render:typedFailure}).recover(free.bug.id)).recovered,true);
  assert.equal(supplements(c,held.workId).length,0);assert.equal(supplements(c,free.workId).length,1);
});

test('unknown attempt status denies while a record-confirmed cold failure still recovers',async t=>{
  const c=await fixture(t);
  const {bug:unknown,workId:unknownWork}=await seed(c,{attemptStatus:'unknown'});
  await assert.rejects(new DiagramRecovery(c,{render:typedFailure}).recover(unknown.id),error=>error.reason==='original-effect-unknown');
  assert.equal(supplements(c,unknownWork).length,0);
  const {bug:cold,workId:coldWork,jobId:coldJob,sessionId:coldThread}=await seed(c);
  c.coldJobs.add(coldJob);
  const result=await new DiagramRecovery(c,{render:typedFailure}).recover(cold.id);
  assert.equal(result.recovered,true);assert.equal(supplements(c,coldWork).length,1);assert.equal(c.store.find(coldWork).threadId,coldThread);
});

test('record-confirmed host-tool failure can reconcile from exact diagram journal but transport uncertainty cannot',async t=>{
  const c=await fixture(t),verified=await seed(c,{attemptStatus:'unknown'}),transport=await seed(c,{attemptStatus:'unknown'});
  await c.store.mutate(()=>{for(const row of [verified,transport]){const job=c.store.state.jobs.find(j=>j.id===row.jobId);job.errorCode='PI_HOST_TOOL_FAILED';job.failureOrigin='host';job.hostToolCode='HOST_TOOL_ERROR';job.collabAttempts[0].facts=[{status:'unknown',reason:row===verified?'PI_HOST_TOOL_FAILED':'PI_OWNER_EXIT'}];}});
  await assert.rejects(new DiagramRecovery(c,{render:typedFailure}).recover(transport.bug.id),error=>error.reason==='original-effect-unknown');
  const result=await new DiagramRecovery(c,{render:typedFailure}).recover(verified.bug.id);
  assert.equal(result.recovered,true);assert.equal(supplements(c,verified.workId).length,1);assert.equal(supplements(c,transport.workId).length,0);
});

test('untyped re-render failure is never swallowed and queues nothing',async t=>{
  const c=await fixture(t),{bug,workId,jobId}=await seed(c);
  await assert.rejects(new DiagramRecovery(c,{render:untypedFailure}).recover(bug.id),error=>error.code==='DIAGRAM_RECOVERY_UNPROVEN'&&error.reason==='rerun-untyped'&&error.cause.message==='geometry exploded');
  assert.equal(supplements(c,workId).length,0);
  assert.equal(c.store.state.jobs.find(row=>row.id===jobId).diagramRecovery,undefined);
});

test('repeat recovery reads the durable receipt and never queues a second supplement',async t=>{
  const c=await fixture(t),{bug,workId}=await seed(c);
  const recovery=new DiagramRecovery(c,{render:typedFailure});
  const first=await recovery.recover(bug.id,{requestKey:'same-key'});
  const second=await recovery.recover(bug.id,{requestKey:'same-key'});
  assert.equal(second.alreadyRecovered,true);assert.equal(second.supplementJobId,first.supplementJobId);assert.equal(second.settled,true);
  assert.equal(supplements(c,workId).length,1);
  assert.equal(c.store.state.messages.filter(message=>message.jobId===first.supplementJobId).length,1);
  await assert.rejects(recovery.recover(bug.id,{requestKey:'other-key'}),error=>error.reason==='request-key-conflict');
});

test('ledger finalization failure retries settlement without duplicating the queue',async t=>{
  const c=await fixture(t),{bug,workId}=await seed(c);
  const original=c.maintenance.finish.bind(c.maintenance);let broken=true;
  c.maintenance.finish=(id,options)=>{if(broken)throw Object.assign(new Error('ledger commit unknown'),{code:'STORAGE_RESULT_UNKNOWN'});return original(id,options);};
  const recovery=new DiagramRecovery(c,{render:typedFailure});
  const pending=await recovery.recover(bug.id);
  assert.equal(pending.recovered,true);assert.equal(pending.settled,false);assert.equal(pending.settleError.code,'STORAGE_RESULT_UNKNOWN');
  assert.equal(supplements(c,workId).length,1);
  assert.equal(c.store.state.jobs.find(job=>job.target===workId).diagramRecovery.settledAt,null);
  broken=false;
  const retried=await new DiagramRecovery(c,{render:()=>{throw Error('settlement must not rerender');}}).scan();
  assert.equal(retried.recovered.length,1);assert.equal(retried.recovered[0].alreadyRecovered,true);assert.equal(retried.recovered[0].settled,true);
  assert.equal(supplements(c,workId).length,1);
  assert.equal((await c.maintenance.read()).bugs.find(row=>row.id===bug.id).status,'repaired');
});

test('scan auto-recovers only the known legacy runtime recipe and stays idempotent',async t=>{
  const c=await fixture(t);
  const good=await seed(c);
  const wrongTool=await seed(c,{tool:'nozeli_report'});
  const otherPhase=await seed(c,{phase:'tool',bugCode:'HOST_INTERNAL_FAILURE'});
  const recovery=new DiagramRecovery(c,{render:typedFailure});
  const first=await recovery.scan();
  assert.equal(first.considered,2);
  assert.deepEqual(first.recovered.map(row=>row.bugId),[good.bug.id]);
  assert.deepEqual(first.denied,[{bugId:wrongTool.bug.id,reason:'wrong-tool'}]);
  assert.equal(c.store.find(good.workId).status,'running');assert.equal(c.store.find(good.workId).threadId,good.sessionId);
  assert.equal(supplements(c,wrongTool.workId).length,0);assert.equal(supplements(c,otherPhase.workId).length,0);
  const again=await recovery.scan();
  assert.equal(again.considered,1);assert.deepEqual(again.recovered,[]);assert.deepEqual(again.denied,[{bugId:wrongTool.bug.id,reason:'wrong-tool'}]);
  assert.equal(supplements(c,good.workId).length,1);
});
