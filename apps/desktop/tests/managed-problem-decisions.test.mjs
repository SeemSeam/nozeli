import {openTestController,readTestObject} from './project-storage.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Controller} from '../src/agents/managed/controller.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {DesktopHost} from '../src/main/host.mjs';
import {managedRuntime,readManagedState} from '../src/agents/managed/managed-storage.mjs';

const PROBLEM_TEXT='依赖缺失已核实。建议处理方案：在本任务内以普通用户权限安装构建依赖并重跑验证；不引入全局改动。';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-problem-')),calls=[],controllers=[];
 class Session{
  async preflightToolsDigest(){}async assertToolsDigest(){}
  constructor(spec,target){Object.assign(this,spec,{target,closed:false});}
  async start(thread){this.threadId=thread||randomUUID();return this;}
  async stop(){this.closed=true;return {confirmationComplete:true};}
  async prompt(text){
   calls.push({target:this.target,text});
   await this.onTool({tool:'nozeli_publish',arguments:{kind:'problem',text:PROBLEM_TEXT,files:[]},callId:'problem:'+randomUUID()});
   return {completion:'host-control',threadId:this.threadId};
  }
 }
 const options={runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'content'),sessionFactory:(spec,target)=>new Session(spec,target),projectHome:home=>fs.mkdir(home,{recursive:true})};
 const open=async()=>{const c=await openTestController(options);c.execution=null;controllers.push(c);return c;};
 const c=await open();c.execution=null;await c.store.mutate(()=>{for(const binding of Object.values(c.store.state.bindings))binding.provider='omp';c.store.state.contentRoot=path.join(root,'content');});
 t.after(async()=>{for(const controller of controllers)if(!controller.store.closed)await controller.stop();await fs.rm(root,{recursive:true,force:true});});
 const submitted=await c.store.submit('Original task with a no-install constraint','Brief',{name:'Original'});await c.store.activate(submitted.id);
 const run=async()=>{const accepted=await c.send(submitted.id,'请继续处理');const job=c.store.state.jobs.find(j=>j.id===accepted.jobId);await c.runJob(job);c.current.delete(submitted.id);const work=c.store.find(submitted.id);return {work,revisionBefore:work.revision};};
 return {c,calls,run,open,id:submitted.id};
}
const decision=(w,action='approve',requestKey='problem-decision-1',text)=>({projectId:'project',workId:w.id,objectId:w.problem.objectId,revision:w.revision,action,...(text!==undefined?{text}:{}),requestKey});

test('approve resumes the same Work exactly once with exact source, durable receipt and audit',async t=>{
 const {c,run,id}=await fixture(t),{work:w,revisionBefore}=await run();
 assert.equal(w.status,'paused');
 const problemTodo=()=>c.store.state.todos.find(row=>row.workId===id&&row.kind==='problem'&&row.objectId===w.problem.objectId);
 assert.equal(problemTodo().status,'open');
 const receiptBefore=structuredClone(c.store.state.receipts.findLast(r=>r.workId===id&&r.kind==='problem')),threadBefore=w.threadId,requestBefore=w.request;
 const artifactRow={id:'art-1',workId:id,jobId:receiptBefore.jobId,relPath:'notes.md',digest:'d0',size:3};
 await c.store.mutate(()=>{const row=c.store.state.jobs.find(j=>j.id===receiptBefore.jobId);row.context={...(row.context||{}),permissionTaskId:'inherited-perm-task'};c.store.state.artifacts=[structuredClone(artifactRow)];c.store.find(id).execution={candidate:{commit:'candidate-commit'}};});
 const p=decision(w);
 const first=await c.resolveProblem(p);
 assert.equal(first.accepted,true);assert.equal(typeof first.jobId,'string');assert.equal(first.status,'running');
 const job=c.store.state.jobs.find(j=>j.id===first.jobId);
 assert.equal(job.type,'problem-resume');assert.equal(job.target,id);assert.equal(job.status,'queued');
 assert.equal(c.store.state.jobs.filter(j=>j.type==='problem-resume').length,1);
 assert.equal(c.store.state.works.length,1);
 assert.equal(c.store.find(id).status,'running');assert.equal(c.store.find(id).revision,revisionBefore+1);assert.equal(c.store.find(id).threadId,threadBefore);
 assert(job.text.includes(PROBLEM_TEXT));
 assert.equal(job.context.permissionTaskId,'inherited-perm-task');assert.equal(job.context.sourceJobId,receiptBefore.jobId);
 const done=c.store.find(id);
 assert.deepEqual(c.store.state.artifacts,[artifactRow]);assert.equal(done.execution.candidate.commit,'candidate-commit');
 assert.equal(c.store.state.receipts.findLast(r=>r.workId===id&&r.kind==='problem').stale,undefined);
 assert.equal(done.approvedScopes.length,1);
 assert.equal(done.approvedScopes[0].deviationId,'problem:'+w.problem.objectId+':'+revisionBefore);
 assert.equal(done.approvedScopes[0].sourceJobId,receiptBefore.jobId);
 assert(done.approvedScopes[0].sourceText.includes(PROBLEM_TEXT));
 assert.equal(done.problemDecisions.length,1);assert.equal(done.problemDecisions[0].action,'approve');assert.equal(done.problemDecisions[0].requestKey,p.requestKey);
 assert.equal(problemTodo().status,'resolved');assert.equal(problemTodo().resolution.action,'approve');assert.equal(problemTodo().resolution.jobId,first.jobId);
 assert.deepEqual(c.store.state.receipts.findLast(r=>r.workId===id&&r.kind==='problem'),receiptBefore);
 assert.equal(await readTestObject(c.store,w.problem.objectId).then(bytes=>bytes.toString('utf8')),PROBLEM_TEXT);
 assert.equal(done.request,requestBefore);
 // 同键同参跨版本前进仍返回原回执；同键换参为碰撞。
 const replay=await c.resolveProblem(p);
 assert.deepEqual(replay,first);
 assert.equal(c.store.state.jobs.filter(j=>j.type==='problem-resume').length,1);
 await assert.rejects(c.resolveProblem(decision(w,'approve','problem-decision-1','追加说明')),e=>e.code==='PROBLEM_REQUEST_COLLISION');
 await assert.rejects(c.resolveProblem(decision(c.store.find(id),'approve','problem-decision-2')),{code:'STALE_PROBLEM'});
 await assert.rejects(c.resolveProblem({...decision(w),objectId:randomUUID(),requestKey:'problem-decision-3'}),{code:'STALE_PROBLEM'});
 await assert.rejects(c.resolveProblem({...decision(w),revision:w.revision+1,requestKey:'problem-decision-4'}),{code:'STALE_PROBLEM'});
 assert.equal(c.store.state.problemActions.length,1);
});

test('reject requires exact user feedback and continues the same Work with it as the only new source',async t=>{
 const {c,run,id}=await fixture(t),{work:w}=await run();
 await assert.rejects(c.resolveProblem(decision(w,'reject','reject-no-text')),e=>e.code==='INVALID_PROBLEM_DECISION');
 await assert.rejects(c.resolveProblem(decision(w,'reject','reject-blank-text','   ')),e=>e.code==='INVALID_PROBLEM_DECISION');
 const feedback='不要安装任何依赖；改用系统已有的 esbuild 并重跑验证';
 const result=await c.resolveProblem(decision(w,'reject','reject-with-feedback',feedback));
 assert.equal(result.accepted,true);
 const job=c.store.state.jobs.find(j=>j.id===result.jobId);
 assert.equal(job.type,'problem-resume');assert(job.text.includes(feedback));assert(job.text.includes(PROBLEM_TEXT));
 const done=c.store.find(id);
 assert.equal(done.approvedScopes.length,1);
 assert(done.approvedScopes[0].sourceText.includes(feedback));
 assert(!done.approvedScopes[0].sourceText.includes(PROBLEM_TEXT));
 assert.equal(done.status,'running');assert.equal(c.store.state.works.length,1);
});
test('simultaneous approve and reject cannot enqueue two continuations or mix their authority',async t=>{
 const {c,run,id}=await fixture(t),{work:w}=await run();
 const approve=decision(w,'approve','competing-approve'),reject=decision(w,'reject','competing-reject','保留原成果，改用替代处理方案');
 const results=await Promise.allSettled([c.resolveProblem(approve),c.resolveProblem(reject)]);
 assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
 assert.equal(results.find(row=>row.status==='rejected').reason.code,'STALE_PROBLEM');
 const winner=results.find(row=>row.status==='fulfilled').value;
 assert.equal(c.store.state.jobs.filter(job=>job.target===id&&job.type==='problem-resume').length,1);
 assert.equal(c.store.find(id).approvedScopes.length,1);
 assert.equal(c.store.find(id).problemDecisions.length,1);
 const replay=await c.resolveProblem(winner.action==='approve'?approve:reject);
 assert.deepEqual(replay,winner);
});

test('approved source is delivered through the Worker task anchor on continuation',async t=>{
 const {c,calls,run,id}=await fixture(t),{work:w,revisionBefore}=await run();
 const result=await c.resolveProblem(decision(w));
 await c.runJob(c.store.state.jobs.find(j=>j.id===result.jobId));c.current.delete(id);
 const prompt=calls.filter(row=>row.target===id).at(-1).text;
 assert(prompt.includes('用户明确批准的来源输入'));
 assert(prompt.includes(PROBLEM_TEXT));
 assert(prompt.includes('本轮明确输入'));
 assert.equal(c.store.find(id).status,'paused');
 assert.equal(c.store.find(id).revision,revisionBefore+1);
 assert.equal(c.store.state.jobs.filter(j=>j.type==='problem-resume').length,1);
});

test('busy, provenance, unknown-settlement and held-effect guards reject with concrete entries',async t=>{
 const {c,run,id}=await fixture(t),{work:w}=await run();
 const receipt=c.store.state.receipts.findLast(r=>r.workId===id&&r.kind==='problem'),source=()=>c.store.state.jobs.find(j=>j.id===receipt.jobId),sourceSnapshot=structuredClone(source());
 // 存储层忙：待执行输入。
 await c.store.mutate(()=>{c.store.state.jobs.push({id:'pending-supplement',target:id,revision:w.revision,type:'manual',status:'queued',text:'排队补充',context:{boundWorkId:id}});});
 await assert.rejects(c.resolveProblem(decision(w,'approve','busy-key-0001')),{code:'WORK_BUSY'});
 await c.store.mutate(()=>{c.store.state.jobs.find(j=>j.id==='pending-supplement').status='cancelled';});
 c.starting.set(id,true);await assert.rejects(c.resolveProblem(decision(w,'approve','busy-key-0004')),{code:'WORK_BUSY'});c.starting.delete(id);
 c.current.set(id,{id:'transient-job'});await assert.rejects(c.resolveProblem(decision(w,'approve','busy-key-0002')),{code:'WORK_BUSY'});c.current.delete(id);
 c.running.set(id,Promise.resolve());await assert.rejects(c.resolveProblem(decision(w,'approve','busy-key-0003')),{code:'WORK_BUSY'});c.running.delete(id);
 const session=c.sessions.get(id);if(session){session.busy=true;await assert.rejects(c.resolveProblem(decision(w,'approve','busy-key-0005')),{code:'WORK_BUSY'});session.busy=false;}
 // 来源回合错位/版本不符/缺失：不授权续作。
 await c.store.mutate(()=>{source().target='another-work';});
 await assert.rejects(c.resolveProblem(decision(w,'approve','missing-key-01')),{code:'PROBLEM_SOURCE_MISSING'});
 await c.store.mutate(()=>{source().target=id;source().revision=w.revision+9;});
 await assert.rejects(c.resolveProblem(decision(w,'approve','missing-key-02')),{code:'PROBLEM_SOURCE_MISSING'});
 await c.store.mutate(()=>{c.store.state.jobs.splice(c.store.state.jobs.findIndex(j=>j.id===receipt.jobId),1);});
 await assert.rejects(c.resolveProblem(decision(w,'approve','missing-key-03')),{code:'PROBLEM_SOURCE_MISSING'});
 await c.store.mutate(()=>{c.store.state.jobs.push(structuredClone(sourceSnapshot));});
 // 结算未知：job unknown、transport unknown、未决敏感效果授权都走显式恢复入口。
 await c.store.mutate(()=>{source().status='unknown';});
 await assert.rejects(c.resolveProblem(decision(w,'approve','unknown-key-01')),error=>error.code==='PROBLEM_SOURCE_UNKNOWN'&&error.recovery.op==='managed.recovery.resolve'&&error.recovery.sourceJob===receipt.jobId&&typeof error.recovery.workId==='string');
 await c.store.mutate(()=>{source().status='completed';source().collabAttempts=[{requestId:'transport-1',kind:'prompt',status:'unknown',everAdmitted:true}];});
 await assert.rejects(c.resolveProblem(decision(w,'approve','unknown-key-02')),error=>error.code==='PROBLEM_SOURCE_UNKNOWN'&&error.recovery.op==='managed.recovery.resolve');
 await c.store.mutate(()=>{source().collabAttempts=[];});
 const permissions={held:false,heldFor:async()=>permissions.held,read:async()=>({grants:[]}),endTask:async()=>{}};
 c.taskPermissions=permissions;permissions.held=true;
 await assert.rejects(c.resolveProblem(decision(w,'approve','unknown-key-03')),error=>error.code==='PROBLEM_SOURCE_UNKNOWN'&&error.recovery.op==='managed.recovery.resolve');
 permissions.held=false;
 assert.equal(c.store.state.jobs.filter(j=>j.type==='problem-resume').length,0);
 assert.equal(c.store.state.problemActions,undefined);
 assert.equal(c.store.find(id).status,'paused');
 // 可核实终态（含 interrupted/failed 的宿主诊断来源）允许续作。
 await c.store.mutate(()=>{source().status='interrupted';});
 const interrupted=await c.resolveProblem(decision(w,'approve','interrupted-1'));
 assert.equal(interrupted.accepted,true);
 await c.store.mutate(()=>{const work=c.store.find(id);work.deviation={id:'dev-seed',revision:work.revision,version:1,status:'pending',todoId:'dev-todo-seed',objectId:randomUUID()};});
 await assert.rejects(c.resolveProblem(decision(c.store.find(id),'approve','held-key-00001')),{code:'DEVIATION_HELD'});
});

test('cold local decision persists before any model connect and replays across restart',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-problem-cold-')),content=path.join(root,'project');await fs.mkdir(content);
 const host=new DesktopHost(root),projectId=(await host.pick(content)).project.id,storage=host.storage;
 const service=new ManagedProjects({userDataDir:root,host,legacy:{projects:new Map()}});
 service.initializeResources=async()=>{throw Error('global resources forbidden');};
 service.openController=options=>Controller.open({...options,sessionFactory:()=>{throw Error('native session forbidden');}});
 t.after(async()=>{await service.stop();await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 await storage.putLocal(projectId,'managed:binding',{enabled:true});
 const seed=await service.loadLocal(projectId),runtimeRoot=await managedRuntime(storage,projectId);
 const workId=(await seed.store.submit('冷启动原任务','brief')).id;
 await seed.store.activate(workId);
 await seed.store.publish(workId,seed.store.find(workId).revision,'problem','冷启动问题：建议在本任务内安装构建依赖并重跑验证','cold-problem-call',{jobId:'cold-source-job'});
 await seed.store.mutate(()=>seed.store.state.jobs.push({id:'cold-source-job',target:workId,revision:seed.store.find(workId).revision,type:'manual',status:'completed',text:'源回合',context:{}}));
 await seed.store.settle(workId);
 assert.equal(seed.store.find(workId).status,'paused');
 const p={projectId,workId,objectId:seed.store.find(workId).problem.objectId,revision:seed.store.find(workId).revision,action:'approve',text:'',requestKey:'cold-problem-0001'};
 await seed.stop();service.controllers.delete(projectId);
 const first=await service.invoke('managed.problem.resolve',p);
 assert.equal(first.accepted,true);
 const restored=service.controllers.get(projectId);
 assert.equal(restored.sessions.size,0);assert.equal(restored.started,false);
 assert.equal(restored.store.state.jobs.filter(j=>j.type==='problem-resume').length,1);assert.equal(typeof restored.store.state.jobs.find(j=>j.id===first.jobId).context.permissionTaskId,'string','来源无权限身份时生成新任务身份');
 assert.equal(restored.store.state.jobs.find(j=>j.id===first.jobId).target,workId);
 assert.equal(restored.store.find(workId).status,'running');
 const persisted=await readManagedState(storage,projectId),persistedWork=persisted.works.find(work=>work.id===workId);
 assert.equal(persisted.problemActions.length,1);assert.equal(persisted.problemActions[0].requestKey,p.requestKey);assert.equal(persisted.problemActions[0].result.jobId,first.jobId);
 assert.equal(persistedWork.problemDecisions.length,1);assert.equal(persistedWork.problemDecisions[0].action,'approve');
 assert.equal(persistedWork.approvedScopes.length,1);assert.ok(persistedWork.approvedScopes[0].sourceText.includes('冷启动问题'));
 await restored.stop();service.controllers.delete(projectId);
 const second=await service.invoke('managed.problem.resolve',p);
 assert.deepEqual(second,first);
 const reloaded=service.controllers.get(projectId);
 assert.equal(reloaded.store.state.jobs.filter(j=>j.type==='problem-resume').length,1);
 assert.equal(reloaded.store.state.problemActions.length,1);
 await assert.rejects(service.invoke('managed.problem.resolve',{...p,text:'不同说明',requestKey:'cold-problem-0002'}),e=>e.code==='STALE_PROBLEM');
});

test('problem resolve IPC validates exact payload before controller admission',async()=>{
 const calls=[],manager=new ManagedProjects({userDataDir:'/unused-problem-test',host:{storage:{},requireProject:async id=>{if(id!=='project-1')throw Error('unknown project');return {id};}},legacy:{projects:new Map()}});
 manager.controllers.set('project-1',{started:true,resolveProblem:async p=>{calls.push(p);return {accepted:true,workId:p.workId};}});
 const p=()=>({projectId:'project-1',workId:'work-1',objectId:'0b0ba8a8-0000-4000-8000-000000000000',revision:2,action:'approve',text:'',requestKey:'problem-key-0001'});
 assert.equal((await manager.invoke('managed.problem.resolve',p())).accepted,true);
 assert.deepEqual(calls,[p()]);
 for(const patch of [{projectId:''},{workId:' padded '},{objectId:4},{revision:0},{revision:1.5},{action:'continue'},{action:'reject'},{text:7},{text:'x'.repeat(32001)},{requestKey:''},{requestKey:' padded '},{unexpected:true}])
  await assert.rejects(manager.invoke('managed.problem.resolve',{...p(),...patch}),e=>e.code==='INVALID_PAYLOAD');
 assert.equal(calls.length,1);
 const rejected=await manager.invoke('managed.problem.resolve',{...p(),action:'reject',text:'改用现有工具链',requestKey:'problem-key-0002'});
 assert.equal(rejected.accepted,true);assert.equal(calls.length,2);assert.equal(calls[1].action,'reject');
 for(const malformed of [undefined,null,[],42,'choice'])await assert.rejects(manager.invoke('managed.problem.resolve',malformed),e=>e.code==='INVALID_PAYLOAD');
 await assert.rejects(manager.invoke('managed.problem.resolve',{...p(),projectId:'other'}),/unknown project/);
 assert.equal(calls.length,2);
});
