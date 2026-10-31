import {openTestController,openTestWorkspace,readTestState,writeTestState,readTestObject} from './project-storage.fixture.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {Controller} from '../src/agents/managed/controller.mjs';import {managedWorkRecords} from '../src/domain/managed-work-records.mjs';
const wait=async fn=>{const end=Date.now()+30000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('condition timeout');};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-transfer-'));let c,resolve,reject;const events=[];let failInterrupt=false,interrupts=0;
 class Session { async preflightToolsDigest() {} async assertToolsDigest() {} constructor(spec,target){Object.assign(this,spec,{target,busy:false,closed:false});}async start(id){this.threadId=id||randomUUID();return this;}async stop(){this.closed=true;reject?.(Error('stopped'));}async interrupt(){interrupts++;if(failInterrupt)throw Error('模拟中断请求失败');events.push('interrupt-requested');return {requested:true};}async prompt(){this.busy=true;const job=c.current.get(this.target);events.push(this.target+':start');try{if(this.target==='frontdesk')return await new Promise((r,j)=>{resolve=r;reject=j;});await this.onTool({tool:'nozeli_manage',arguments:{action:'clarify',workName:'',text:'后台任务已接收；请补充验收标准'},callId:randomUUID()});return {text:'',completion:'host-control',threadId:this.threadId};}finally{events.push(this.target+':settled');this.busy=false;}} }
 const options={runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),projectHome:home=>fs.mkdir(home,{recursive:true}),sessionFactory:(spec,target)=>new Session(spec,target)};c=await openTestController(options);await c.start();t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});
 const r=await c.send('frontdesk','解释项目资料'),source=c.store.state.messages.find(m=>m.jobId===r.jobId);await wait(()=>c.sessions.get('frontdesk').busy);
 return {c,options,source,events,finish:()=>resolve({text:'尚未验证的部分解释',metrics:{tokens:null,tokenCompleteness:'unavailable'},threadId:c.sessions.get('frontdesk').threadId,completion:'user-transfer',providerStatus:'interrupted'}),fail:()=>{failInterrupt=true;},allow:()=>{failInterrupt=false;},interrupts:()=>interrupts};
}
test('active transfer persists first, gates main until settlement, preserves partial/draft and dedupes races',async t=>{
 const {c,source,events,finish}=await fixture(t);const thread=c.sessions.get('frontdesk').threadId;await c.setDraft('frontdesk','无关草稿');const r=await c.convertMessage(source.id,'核对项目',{requestKey:'active-transfer-one'});assert(r.transferring);await wait(()=>events.includes('interrupt-requested'));const saved=await readTestState(c.store);assert.equal(saved.jobs.find(j=>j.id===r.jobId).status,'transferring');assert.equal(c.store.used(),0);assert.equal(managedWorkRecords(c.snapshot())[0].phase,'正在转交，等待前台停稳');assert(!events.includes('orchestrator:start'));
 assert.equal((await c.convertMessage(source.id,'核对项目',{requestKey:'active-transfer-two'})).jobId,r.jobId);const callback=await c.onTool('frontdesk',{tool:'nozeli_handoff',arguments:{reason:'自动交接'},callId:'race'});assert.equal(callback.jobId,r.jobId);for(const reason of ['@read state','@new 新目标','@continue'])assert((await c.onTool('frontdesk',{tool:'nozeli_handoff',arguments:{reason},callId:reason})).transferred);
 finish();await wait(()=>c.store.state.jobs.find(j=>j.id===r.jobId).status==='completed'&&!c.running.size);assert(events.indexOf('frontdesk:settled')<events.indexOf('orchestrator:start'));assert.equal(c.store.state.jobs.filter(j=>j.type==='intake').length,1);assert.equal(c.sessions.get('frontdesk').threadId,thread);assert(!c.sessions.get('frontdesk').closed);assert.equal(c.store.state.drafts.frontdesk,'无关草稿');assert.equal(c.store.state.messages.find(m=>m.partial).text,'尚未验证的部分解释');assert.match(c.store.state.jobs.find(j=>j.id===r.jobId).text,/非最终成果/);assert(!c.store.state.todos.some(t=>t.kind==='system'));
});
test('failed interrupt remains pending, retry uses same receipt and natural completion settles safely',async t=>{
 const {c,source,events,finish,fail,allow,interrupts}=await fixture(t);fail();const r=await c.convertMessage(source.id,'核对',{requestKey:'stop-failure-one'});await wait(()=>c.store.state.jobs.find(j=>j.id===r.jobId).transfer.error);assert(!events.includes('orchestrator:start'));const record=managedWorkRecords(c.snapshot())[0];assert.equal(record.retryJobId,r.jobId);assert.match(record.phase,/尚未停稳/);allow();await c.retryIntake(r.jobId,'retry-stop-one');assert.equal(interrupts(),2);assert.equal(c.store.state.jobs.filter(j=>j.type==='intake').length,1);assert(!events.includes('orchestrator:start'));finish();await wait(()=>c.store.state.jobs.find(j=>j.id===r.jobId).status==='completed');
});
test('restart preserves accepted transfer and requires destination retry without replaying source',async t=>{
 const {c,source,options,events}=await fixture(t);const r=await c.convertMessage(source.id,'核对',{requestKey:'recovery-transfer-one'});await c.stop();const reopened=await openTestController(options);try{const intake=reopened.store.state.jobs.find(j=>j.id===r.jobId);assert.equal(intake.status,'interrupted');assert.equal(intake.transfer.status,'settled');const text=intake.text;await reopened.finalizeTransfers({restoring:true});assert.equal(intake.text,text);assert.equal(reopened.store.state.jobs.filter(j=>j.type==='intake').length,1);assert.equal(reopened.store.state.jobs.find(j=>j.id===source.jobId).status,'interrupted');assert.equal(events.filter(e=>e==='frontdesk:start').length,1);assert.equal(reopened.sessions.size,0);const retried=await reopened.retryIntake(intake.id,'explicit-transfer-retry');assert.equal(reopened.store.state.jobs.find(j=>j.id===retried.jobId).text,text);assert.equal(reopened.store.state.jobs.find(j=>j.id===retried.jobId).status,'queued');assert.equal(events.filter(e=>e==='frontdesk:start').length,1);}finally{await reopened.stop();}
});
test('converting old unrelated message never interrupts current different goal',async t=>{
 const {c,finish,interrupts}=await fixture(t);await c.store.mutate(()=>c.store.state.messages.push({id:'unrelated-old',target:'frontdesk',speaker:'agent',text:'独立旧问题答案'}));const r=await c.convertMessage('unrelated-old','核对旧问题',{requestKey:'unrelated-transfer-one'});assert(!r.transferring);assert.equal(interrupts(),0);await wait(()=>c.store.state.jobs.find(j=>j.id===r.jobId).status==='completed');assert(c.sessions.get('frontdesk').busy);finish();await wait(()=>!c.running.size);
});
test('persisted pre-settlement crash snapshot restores after process recovery without duplicate evidence',async t=>{
 const {c,source,options}=await fixture(t);const r=await c.convertMessage(source.id,'核对',{requestKey:'crash-snapshot-one'});const frozen=structuredClone(c.store.state);frozen.messages.push({id:'partial-crash',target:'frontdesk',speaker:'agent',jobId:source.jobId,text:'崩溃前已保存进展',partial:true});await c.stop();await writeTestState(c.store,frozen);const restored=await openTestController(options);try{const intake=restored.store.state.jobs.find(j=>j.id===r.jobId);assert.equal(intake.status,'interrupted');assert(intake.transfer.recovered);assert.equal(intake.transfer.status,'settled');assert.equal(intake.text.split('崩溃前已保存进展').length,2);await restored.finalizeTransfers({restoring:true});assert.equal(intake.text.split('崩溃前已保存进展').length,2);assert.equal(restored.store.state.jobs.find(j=>j.id===source.jobId).status,'interrupted');assert.equal(restored.store.state.works.length,0);assert(restored.store.state.todos.some(todo=>todo.sourceJobId===intake.id&&todo.status==='open'));const retry=await restored.retryIntake(intake.id,'explicit-crash-transfer-retry');assert.equal(restored.store.state.jobs.find(j=>j.id===retry.jobId).text,intake.text);assert.equal(restored.store.state.jobs.filter(j=>j.target==='frontdesk').length,1);}finally{await restored.stop();}
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
test('a continue naming no open Work dispatches the new task first-run instead of asking the user to choose',async t=>{
 const {c}=await fixture(t);const front=c.current.get('frontdesk');
 const request='请修复calc并运行 node checks/verify.mjs 验证，检查脚本不可修改';
 const intake=await c.store.mutate(()=>c.queueJob('orchestrator','intake',request,{context:{frontJobId:front.id}}));
 c.current.set('orchestrator',intake);
 try{
  const result=await c.onTool('orchestrator',{tool:'nozeli_manage',arguments:{action:'continue',workName:request,text:''},callId:'m-1'});
  assert.equal(result.action,'dispatch');assert.equal(result.firstRunFallback,true);assert.ok(result.workId);
  assert.equal(c.store.state.works.length,1);
  assert.equal(c.snapshot().todos.filter(todo=>todo.kind==='routing'&&todo.status==='open').length,0);
  const work=c.store.find(result.workId);assert.equal(work.request,request);assert.equal(work.sourceJob,intake.id);
  // Repeating the same continue returns the original fallback receipt — same Work, no duplicate.
  const repeat=await c.onTool('orchestrator',{tool:'nozeli_manage',arguments:{action:'continue',workName:request,text:''},callId:'m-1b'});
  assert.equal(repeat.action,'dispatch');assert.equal(repeat.workId,result.workId);assert.equal(c.store.state.works.length,1);
  // An intake already bound to an existing Work chain never fabricates a new Work.
  const bound=await c.store.mutate(()=>c.queueJob('orchestrator','intake','补充：再跑一次验证',{context:{frontJobId:front.id,workHintId:result.workId}}));
  c.current.set('orchestrator',bound);
  await assert.rejects(c.onTool('orchestrator',{tool:'nozeli_manage',arguments:{action:'continue',workName:'不存在的旧工作名',text:''},callId:'m-2'}),/work name must uniquely identify/);
  assert.equal(c.store.state.works.length,1);
  // With ANY open Work unmatched by name, an unbound intake must clarify or
  // dispatch explicitly — never silently create a second Work.
  const unbound=await c.store.mutate(()=>c.queueJob('orchestrator','intake','另一个全新任务：整理目录',{context:{frontJobId:front.id}}));
  c.current.set('orchestrator',unbound);
  await assert.rejects(c.onTool('orchestrator',{tool:'nozeli_manage',arguments:{action:'continue',workName:'另一个全新任务：整理目录',text:''},callId:'m-3'}),/work name must uniquely identify/);
  assert.equal(c.store.state.works.length,1);
 }finally{c.current.delete('orchestrator');}
});
test('status never routes or completes an intake; a status-only turn fails explicitly instead of silent success',async t=>{
 const {c}=await fixture(t);const front=c.current.get('frontdesk');
 const intake=await c.store.mutate(()=>c.queueJob('orchestrator','intake','全新的独立后台任务',{context:{frontJobId:front.id}}));
 c.current.set('orchestrator',intake);
 try{
  const observed=await c.onTool('orchestrator',{tool:'nozeli_manage',arguments:{action:'status',workName:'',text:''},callId:'s-1'});
  assert.equal(observed.action,'status');assert.equal(observed.continueTurn,true);
  assert.equal(c.store.state.jobs.find(j=>j.id===intake.id).routing,undefined);
  // The same status query stays repeatable and still never routes.
  const again=await c.onTool('orchestrator',{tool:'nozeli_manage',arguments:{action:'status',workName:'',text:''},callId:'s-2'});
  assert.equal(again.continueTurn,true);assert.equal(c.store.state.jobs.find(j=>j.id===intake.id).routing,undefined);
  // Ending the turn after only status is an explicit actionable failure — never a silent completion.
  c.current.delete('orchestrator');
  const session=c.sessions.get('orchestrator'),originalPrompt=session.prompt.bind(session);
  session.prompt=async()=>{await session.onTool({tool:'nozeli_manage',arguments:{action:'status',workName:'',text:''},callId:'s-3'});return {text:'',completion:'host-control',threadId:session.threadId};};
  try{
   await c.store.mutate(()=>{Object.assign(c.store.state.jobs.find(j=>j.id===intake.id),{status:'queued'});});
   c.kick();
   await wait(()=>['failed','completed'].includes(c.store.state.jobs.find(j=>j.id===intake.id).status));
   const saved=c.store.state.jobs.find(j=>j.id===intake.id);
   assert.equal(saved.status,'failed');assert.match(saved.error,/without a routing decision/);
   assert.ok(c.snapshot().todos.some(todo=>todo.kind==='system'&&todo.status==='open'&&/routing decision/.test(todo.text)));
  }finally{session.prompt=originalPrompt;}
 }finally{c.current.delete('orchestrator');}
});
