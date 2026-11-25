import {openTestController,openTestWorkspace,readTestState,writeTestState,readTestObject} from './project-storage.fixture.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {Controller} from '../src/agents/managed/controller.mjs';import {managedWorkRecords} from '../src/domain/managed-work-records.mjs';
const wait=async fn=>{const end=Date.now()+30000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('condition timeout');};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-transfer-'));let c,resolve,reject;const events=[],prompts=[];let failInterrupt=false,interrupts=0;
 class Session { async preflightToolsDigest() {} async assertToolsDigest() {} constructor(spec,target){Object.assign(this,spec,{target,busy:false,closed:false});}async start(id){this.threadId=id||randomUUID();return this;}async stop(){this.closed=true;reject?.(Error('stopped'));}async interrupt(){interrupts++;if(failInterrupt)throw Error('模拟中断请求失败');events.push('interrupt-requested');return {requested:true};}async prompt(text){this.busy=true;const job=c.current.get(this.target);prompts.push({jobId:job.id,text});events.push(this.target+':start');try{if(this.target==='frontdesk')return await new Promise((r,j)=>{resolve=r;reject=j;});await this.onTool({tool:'nozeli_manage',arguments:{action:'clarify',text:'后台任务已接收；请补充验收标准'},callId:randomUUID()});return {text:'',completion:'host-control',threadId:this.threadId};}finally{events.push(this.target+':settled');this.busy=false;}}}
 const options={runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),projectHome:home=>fs.mkdir(home,{recursive:true}),sessionFactory:(spec,target)=>new Session(spec,target)};c=await openTestController(options);await c.start();t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});
 const r=await c.send('frontdesk','解释项目资料'),source=c.store.state.messages.find(m=>m.jobId===r.jobId);await wait(()=>c.sessions.get('frontdesk').busy);
 return {c,options,source,events,prompts,finish:()=>resolve({text:'尚未验证的部分解释',metrics:{tokens:null,tokenCompleteness:'unavailable'},threadId:c.sessions.get('frontdesk').threadId,completion:'user-transfer',providerStatus:'interrupted'}),fail:()=>{failInterrupt=true;},allow:()=>{failInterrupt=false;},interrupts:()=>interrupts};
}
test('active transfer persists first, gates main until settlement, preserves partial/draft and dedupes races',async t=>{
 const {c,source,events,prompts,finish}=await fixture(t);const thread=c.sessions.get('frontdesk').threadId;await c.setDraft('frontdesk','无关草稿');const r=await c.convertMessage(source.id,'核对项目',{requestKey:'active-transfer-one'});assert(r.transferring);await wait(()=>events.includes('interrupt-requested'));const saved=await readTestState(c.store);const accepted=saved.jobs.find(j=>j.id===r.jobId);assert.equal(accepted.status,'transferring');assert.equal(c.store.used(),0);assert.equal(managedWorkRecords(c.snapshot())[0].phase,'正在转交，等待前台停稳');assert(!events.includes('orchestrator:start'));
 assert.equal((await c.convertMessage(source.id,'核对项目',{requestKey:'active-transfer-two'})).jobId,r.jobId);const callback=await c.onTool('frontdesk',{tool:'nozeli_handoff',arguments:{reason:'自动交接'},callId:'race'});assert.equal(callback.jobId,r.jobId);for(const reason of ['@read state','@new 新目标','@continue'])assert((await c.onTool('frontdesk',{tool:'nozeli_handoff',arguments:{reason},callId:reason})).transferred);
 finish();await wait(()=>c.store.state.jobs.find(j=>j.id===r.jobId).status==='completed'&&!c.running.size);assert(events.indexOf('frontdesk:settled')<events.indexOf('orchestrator:start'));assert.equal(c.store.state.jobs.filter(j=>j.type==='intake').length,1);assert.equal(c.sessions.get('frontdesk').threadId,thread);assert(!c.sessions.get('frontdesk').closed);assert.equal(c.store.state.drafts.frontdesk,'无关草稿');
 const partial=c.store.state.messages.find(m=>m.jobId===source.jobId&&m.partial);
 assert.equal(partial.text,'尚未验证的部分解释');
 // A settled partial is host-added discussion evidence, never part of the frozen intake input.
 assert.equal((await readTestState(c.store)).jobs.find(j=>j.id===r.jobId).text,accepted.text);
 const delivered=prompts.filter(p=>p.jobId===r.jobId);
 assert.equal(delivered.length,1);
 assert.ok(delivered[0].text.includes('转交前可观察输出（讨论材料，非最终成果）：\n'+partial.text));
 assert.equal(delivered[0].text.split(partial.text).length-1,1);
 assert(!c.store.state.todos.some(t=>t.kind==='system'));
});
test('failed interrupt remains pending, retry uses same receipt and natural completion settles safely',async t=>{
 const {c,source,events,finish,fail,allow,interrupts}=await fixture(t);fail();const r=await c.convertMessage(source.id,'核对',{requestKey:'stop-failure-one'});await wait(()=>c.store.state.jobs.find(j=>j.id===r.jobId).transfer.error);assert(!events.includes('orchestrator:start'));const record=managedWorkRecords(c.snapshot())[0];assert.equal(record.retryJobId,r.jobId);assert.match(record.phase,/尚未停稳/);allow();await c.retryIntake(r.jobId,'retry-stop-one');assert.equal(interrupts(),2);assert.equal(c.store.state.jobs.filter(j=>j.type==='intake').length,1);assert(!events.includes('orchestrator:start'));finish();await wait(()=>c.store.state.jobs.find(j=>j.id===r.jobId).status==='completed');
});
test('restart preserves accepted transfer and retained destination input without replaying source',async t=>{
 const {c,source,options,events}=await fixture(t);const r=await c.convertMessage(source.id,'核对',{requestKey:'recovery-transfer-one'});const text=c.store.state.jobs.find(j=>j.id===r.jobId).text;await c.stop();const reopened=await openTestController(options);try{const intake=reopened.store.state.jobs.find(j=>j.id===r.jobId);assert.equal(intake.status,'queued');assert.equal(intake.restartRecovery?.kind,'never-admitted');assert.equal(intake.transfer.status,'settled');await reopened.finalizeTransfers({restoring:true});assert.equal(reopened.store.state.jobs.find(j=>j.id===r.jobId).text,text);assert.equal(reopened.store.state.jobs.filter(j=>j.type==='intake').length,1);const sourceJob=reopened.store.state.jobs.find(j=>j.id===source.jobId);assert.equal(sourceJob.status,'queued');assert.equal(sourceJob.restartRecovery?.kind,'native-continuation');assert.equal(reopened.sessions.size,0);await assert.rejects(reopened.retryIntake(intake.id,'explicit-transfer-retry'),{code:'INTAKE_REPLAY_FORBIDDEN'});assert.equal(reopened.store.state.jobs.filter(j=>j.type==='intake').length,1);assert.equal(events.filter(e=>e==='frontdesk:start').length,1);assert(!events.includes('orchestrator:start'));assert.equal(reopened.sessions.size,0);}finally{await reopened.stop();}
});
test('converting old unrelated message never interrupts current different goal',async t=>{
 const {c,finish,interrupts}=await fixture(t);await c.store.mutate(()=>c.store.state.messages.push({id:'unrelated-old',target:'frontdesk',speaker:'agent',text:'独立旧问题答案'}));const r=await c.convertMessage('unrelated-old','核对旧问题',{requestKey:'unrelated-transfer-one'});assert(!r.transferring);assert.equal(interrupts(),0);await wait(()=>c.store.state.jobs.find(j=>j.id===r.jobId).status==='completed');assert(c.sessions.get('frontdesk').busy);finish();await wait(()=>!c.running.size);
});
test('persisted pre-settlement crash snapshot restores after process recovery without duplicate evidence',async t=>{
 const {c,source,options}=await fixture(t);const r=await c.convertMessage(source.id,'核对',{requestKey:'crash-snapshot-one'});const frozen=structuredClone(c.store.state);frozen.messages.push({id:'partial-crash',target:'frontdesk',speaker:'agent',jobId:source.jobId,text:'崩溃前已保存进展',partial:true});await c.stop();await writeTestState(c.store,frozen);const restored=await openTestController(options);try{const intake=restored.store.state.jobs.find(j=>j.id===r.jobId);assert.equal(intake.status,'transferring');assert.equal(intake.transfer.status,'waiting');assert(!intake.transfer.recovered);const text=intake.text;await restored.finalizeTransfers({restoring:true});assert.equal(intake.text,text);assert.equal(intake.text.split('崩溃前已保存进展').length,1);const sourceJob=restored.store.state.jobs.find(j=>j.id===source.jobId);assert.equal(sourceJob.status,'queued');assert.equal(sourceJob.restartRecovery?.kind,'native-continuation');assert.equal(restored.store.state.works.length,0);assert(!restored.store.state.todos.some(todo=>todo.sourceJobId===intake.id&&todo.status==='open'));const retry=await restored.retryIntake(intake.id,'explicit-crash-transfer-retry');assert.equal(retry.accepted,true);assert.equal(retry.transferring,true);assert.equal(retry.jobId,intake.id);assert.equal(restored.store.state.jobs.filter(j=>j.target==='frontdesk').length,1);assert.equal(restored.store.state.jobs.filter(j=>j.type==='intake').length,1);}finally{await restored.stop();}
});
test('additional user goal while transferring is retained and shares one row without premature main execution',async t=>{
 const {c,source,events,finish}=await fixture(t);c.started=false;const first=await c.convertMessage(source.id,'核对原资料',{requestKey:'goal-base-one'});const second=await c.convertMessage(source.id,'补充：输出两条核心要求',{requestKey:'goal-extra-one'});assert(second.supplement);assert.notEqual(second.jobId,first.jobId);assert.equal((await c.convertMessage(source.id,'补充：输出两条核心要求',{requestKey:'goal-extra-repeat'})).jobId,second.jobId);await assert.rejects(c.convertMessage(source.id,'冲突要求',{requestKey:'goal-extra-one'}),/collision/);await c.pump();assert(!events.includes('orchestrator:start'));const records=managedWorkRecords(c.snapshot());assert.equal(records.length,1);assert.equal(records[0].id,'request:'+first.jobId);assert.equal(records[0].status,'transferring');assert.match(c.store.state.jobs.find(j=>j.id===second.jobId).text,/两条核心要求/);finish();await wait(()=>!c.running.size);assert.equal(c.store.state.jobs.find(j=>j.id===first.jobId).status,'queued');assert.equal(c.store.state.jobs.find(j=>j.id===second.jobId).context.pendingIntakeId,first.jobId);const w=await c.store.submit('原请求','细化',{name:'原工作',sourceJob:first.jobId});const supplemental=c.store.state.jobs.find(j=>j.id===second.jobId);assert.equal(c.intakeBoundWork(supplemental).id,w.id);assert.equal(c.intakeSource(supplemental).request,supplemental.text);assert.deepEqual(c.intakeSource(supplemental).sourceInputJobIds,[first.jobId,second.jobId]);
});
test('ordinary handoff dispatches straight to background under the original request with no permission-style prompt',async t=>{
 const {c,events,finish}=await fixture(t);const job=c.current.get('frontdesk');
 const result=await c.onTool('frontdesk',{tool:'nozeli_handoff',arguments:{reason:'整理并汇总剩余资料'},callId:'auto-1'});
 assert.equal(result.autoBackground,true);assert.equal(result.authority,'original-request');assert.equal(result.transferred,true);
 assert.equal(c.store.state.frontdeskRoutes.length,0);
 assert.equal(c.snapshot().todos.filter(todo=>todo.kind==='frontdesk-route').length,0);
 const intake=c.store.state.jobs.find(j=>j.type==='intake');
 assert.ok(intake);assert.equal(intake.context.handoffAuthority,'original-request');
 finish();await wait(()=>events.includes('orchestrator:start'));
});
test('an explicit user continue decision gates later auto-handoff back to a user proposal',async t=>{
 const {c,finish}=await fixture(t);const first=c.current.get('frontdesk');
 const proposalId=(await c.proposeFrontdeskRoute(first,'需要后台执行脚本')).proposalId;
 const decided=await c.resolveFrontdeskRoute({proposalId,expectedVersion:1,action:'continue',requestKey:'attention:'+proposalId+':1:continue'});
 finish();await wait(()=>c.current.get('frontdesk')&&c.current.get('frontdesk').id===decided.jobId&&c.sessions.get('frontdesk').busy);
 const resumed=c.current.get('frontdesk');
 const result=await c.onTool('frontdesk',{tool:'nozeli_handoff',arguments:{reason:'改主意了，希望后台跑完'},callId:'gate-1'});
 assert.notEqual(result.autoBackground,true);assert.equal(result.userDecisionRequired,true);assert.equal(result.hostControl,true);
 assert.equal(c.store.state.frontdeskRoutes.filter(r=>r.status==='pending'&&r.sourceJobId===resumed.id).length,1);
 assert.equal(c.store.state.jobs.filter(j=>j.type==='intake').length,0);
 const todo=c.snapshot().todos.find(todo=>todo.kind==='frontdesk-route'&&todo.status==='open');
 assert.equal(todo.destination.kind,'frontdesk-route');assert.equal(todo.destination.sourceJobId,resumed.id);
});
test('a continue miss is never converted into a dispatch; explicit nozeli_dispatch remains the only new-Work path',async t=>{
 const {c}=await fixture(t);const front=c.current.get('frontdesk');
 const request='请修复calc并运行 node checks/verify.mjs 验证，检查脚本不可修改';
 const intake=await c.store.mutate(()=>c.queueJob('orchestrator','intake',request,{context:{frontJobId:front.id}}));
 c.current.set('orchestrator',intake);
 try{
  // Unknown stable workId: rejected with UNKNOWN_WORK, no Work created, no fallback dispatch.
  await assert.rejects(c.onTool('orchestrator',{tool:'nozeli_manage',arguments:{action:'continue',workId:'00000000-0000-4000-8000-000000000000',expectedRevision:0,text:''},callId:'m-1'}),error=>error.code==='UNKNOWN_WORK');
  assert.equal(c.store.state.works.length,0);
  // A continue without the stable identity contract is invalid before any lookup.
  await assert.rejects(c.onTool('orchestrator',{tool:'nozeli_manage',arguments:{action:'continue',text:'name-only routing'},callId:'m-1a'}),error=>error.code==='INVALID_PAYLOAD');
  assert.equal(c.store.state.works.length,0);
  // The brand-new task is dispatched explicitly — same intake, one terminal decision.
  const dispatched=await c.onTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'Fix calc',brief:request},callId:'m-1b'});
  assert.equal(dispatched.action,'dispatch');assert.ok(dispatched.workId);assert.equal(c.store.state.works.length,1);
  const work=c.store.find(dispatched.workId);assert.equal(work.request,request);assert.equal(work.sourceJob,intake.id);
  // An identical dispatch replay returns the original receipt; a different intent cannot inherit it.
  const replay=await c.onTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'Fix calc',brief:request},callId:'m-1c'});
  assert.equal(replay.workId,dispatched.workId);assert.equal(c.store.state.works.length,1);
  await assert.rejects(c.onTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'Other',brief:request},callId:'m-1d'}),error=>error.code==='INTENT_MISMATCH');
  // An intake bound to an existing Work chain never continues a different Work.
  const bound=await c.store.mutate(()=>c.queueJob('orchestrator','intake','补充：再跑一次验证',{context:{frontJobId:front.id,workHintId:dispatched.workId}}));
  c.current.set('orchestrator',bound);
  await assert.rejects(c.onTool('orchestrator',{tool:'nozeli_manage',arguments:{action:'continue',workId:'00000000-0000-4000-8000-000000000000',expectedRevision:0,text:''},callId:'m-2'}),error=>error.code==='BOUND_WORK_MISMATCH'||error.code==='UNKNOWN_WORK');
  assert.equal(c.store.state.works.length,1);
 }finally{c.current.delete('orchestrator');}
});
test('status never routes an intake; ending after status requires reconciliation without replay',async t=>{
 const {c,source}=await fixture(t);
 const session=c.sessions.get('orchestrator'),originalPrompt=session.prompt.bind(session),observations=[];
 let prompts=0;
 session.prompt=async()=>{
  prompts++;
  const active=c.current.get('orchestrator');
  for(const callId of ['status-first','status-repeat']){
   const result=await session.onTool({tool:'nozeli_manage',arguments:{action:'status',text:''},callId});
   observations.push({result,routing:c.store.state.jobs.find(j=>j.id===active.id).routing});
  }
  return {text:'',completion:'provider-completed',threadId:session.threadId};
 };
 try{
  const text='全新的独立后台任务';
  const {jobId}=await c.submitTask(text,{requestKey:'status-no-route',context:{frontJobId:source.jobId}});
  await wait(()=>c.store.state.jobs.find(j=>j.id===jobId)?.status==='failed'&&!c.running.has('orchestrator'));
  assert.equal(observations.length,2);
  for(const {result,routing} of observations){
   assert.equal(result.action,'status');assert.equal(result.readOnly,true);assert.equal(result.continueTurn,true);assert.equal(routing,undefined);
  }
  const saved=(await readTestState(c.store)).jobs.find(j=>j.id===jobId);
  assert.equal(saved.errorCode,'INTAKE_ROUTE_REQUIRED');assert.equal(saved.text,text);assert.equal(saved.routing,undefined);
  assert.equal(c.intakeReconcile(jobId,c.store.projectInstanceId).status,'needs-reconciliation');
  await assert.rejects(c.retryIntake(jobId,'status-no-replay'),{code:'INTAKE_REPLAY_FORBIDDEN'});
  assert.equal(prompts,1);
  assert.equal(c.store.state.works.length,0);
  assert.equal(c.store.state.jobs.filter(job=>job.type==='intake').length,1);
  assert.equal(saved.maintenanceBugId,undefined);
  const {bugs}=await c.maintenance.read();
  assert.ok(!bugs.some(bug=>bug.jobId===jobId));
  assert.ok(!c.snapshot().todos.some(todo=>todo.sourceJobId===jobId&&['system','recovery'].includes(todo.kind)&&todo.status==='open'));
 }finally{session.prompt=originalPrompt;}
});
