import {openTestController,readTestObject} from './project-storage.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Controller} from '../src/agents/managed/controller.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {DesktopHost} from '../src/main/host.mjs';
import {managedRuntime,readManagedState} from '../src/agents/managed/managed-storage.mjs';

const PROBLEM_TEXT='依赖缺失已核实。建议处理方案：在本任务内以普通用户权限安装构建依赖并重跑验证；不引入全局改动。';

async function fixture(t,{readApproved=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-problem-')),calls=[],controllers=[];
 class Session{
  async preflightToolsDigest(){}async assertToolsDigest(){}
  constructor(spec,target){Object.assign(this,spec,{target,closed:false});}
  async start(thread){this.threadId=thread||randomUUID();return this;}
  async stop(){this.closed=true;return {confirmationComplete:true};}
  async prompt(text,options={}){
   const projection=options.projection?JSON.parse(options.projection.text):null;
   const source=readApproved&&projection?.sources?.approvedSources?.[0];
   const approvedSource=source?await this.onTool({tool:'nozeli_history_read',arguments:{readRef:source.readRef},callId:'approved-read:'+randomUUID()}):null;
   calls.push({target:this.target,text,projection,approvedSource});
   await this.onTool({tool:'nozeli_publish',arguments:{kind:'problem',content:PROBLEM_TEXT,files:[]},callId:'problem:'+randomUUID()});
   return {completion:'host-control',threadId:this.threadId};
  }
 }
 const options={runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'content'),sessionFactory:(spec,target)=>new Session(spec,target),projectHome:home=>fs.mkdir(home,{recursive:true})};
 const open=async()=>{const c=await openTestController(options);c.execution=null;controllers.push(c);return c;};
 const c=await open();c.execution=null;await c.store.mutate(()=>{for(const binding of Object.values(c.store.state.bindings))binding.provider='pi';c.store.state.contentRoot=path.join(root,'content');});
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

test('approved source remains version-bound and readable on Worker continuation without a repeated task anchor',async t=>{
 const {c,calls,run,id}=await fixture(t,{readApproved:true}),{work:w,revisionBefore}=await run();
 const result=await c.resolveProblem(decision(w));
 await c.runJob(c.store.state.jobs.find(j=>j.id===result.jobId));c.current.delete(id);
 const delivered=calls.filter(row=>row.target===id).at(-1),source=c.store.find(id).approvedScopes[0];
 assert.equal(delivered.approvedSource.text,source.sourceText);
 assert.equal(delivered.approvedSource.version,delivered.projection.sources.approvedSources[0].version);
 assert(delivered.approvedSource.text.includes(PROBLEM_TEXT));
 assert.equal(delivered.projection.sources.approvedSources[0].sourceJobId,source.sourceJobId);
 assert.equal(JSON.stringify(delivered.projection).includes(PROBLEM_TEXT),false,'source bodies are read as data, not repeated in the control projection');
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
 assert.equal(first.executionDisposition.kind,'connection-required');
 assert.equal(first.executionDisposition.reason,'CONNECT_FAILED');
 assert.match(first.executionDisposition.connection.message,/global resources forbidden/);
 assert.equal(first.executionDisposition.jobId,first.jobId);
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
 assert.equal(reloaded.started,false);assert.equal(reloaded.sessions.size,0);
 await reloaded.store.mutate(()=>{reloaded.store.state.jobs.find(j=>j.id===first.jobId).collabAttempts=[{requestId:'cold-wake-transport',kind:'prompt',status:'unknown',everAdmitted:true}];});
 const unknown=await service.invoke('managed.problem.resolve',p);
 assert.equal(unknown.accepted,true);
 assert.equal(unknown.executionDisposition.kind,'needs-reconciliation');
 assert.equal(unknown.executionDisposition.reason,'settlement-unknown');
 assert.equal(unknown.executionDisposition.recovery.op,'managed.recovery.resolve');
 assert.equal(unknown.executionDisposition.recovery.sourceJob,first.jobId);
 assert.equal(unknown.executionDisposition.recovery.workId,workId);
 assert.equal(reloaded.started,false,'结算未知不启动任何会话或连接');
 assert.equal(reloaded.sessions.size,0);
 assert.equal(reloaded.store.state.jobs.filter(j=>j.type==='problem-resume').length,1);
 assert.equal(reloaded.store.find(workId).status,'running');
 await assert.rejects(service.invoke('managed.problem.resolve',{...p,text:'不同说明',requestKey:'cold-problem-0002'}),e=>e.code==='STALE_PROBLEM');
});

test('cold explicit decision wakes the exact continuation online through the explicit connect channel',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-problem-wake-')),content=path.join(root,'project');await fs.mkdir(content);
 const host=new DesktopHost(root),projectId=(await host.pick(content)).project.id,storage=host.storage;
 const prompts=[],sessions=[];
 class Session extends EventEmitter{
  async preflightToolsDigest(expected){return {expectedDigest:expected,toolsDigest:this.toolsDigest,compatible:true};}async assertToolsDigest(){}
  constructor(spec,target){super();Object.assign(this,spec,{target,closed:false});sessions.push(target);this.toolsDigest=createHash('sha256').update(JSON.stringify(this.tools??[])).digest('hex');}
  async start(thread){this.threadId=thread||randomUUID();return this;}
  async stop(){this.closed=true;return {confirmationComplete:true};}
  async prompt(text){
   prompts.push({target:this.target,text});
   const call=(tool,args)=>this.onTool({tool,arguments:args,callId:randomUUID()});
   if(this.target!=='frontdesk'&&this.target!=='orchestrator'){
    await call('nozeli_publish',{kind:'result',content:'<!doctype html><html><head><meta charset="utf-8"><title>Continuation verified</title></head><body><main><h1>Continuation verified</h1><p>The exact approved remaining work completed in the original Work.</p></main></body></html>',files:[]});
    return {completion:'host-control',threadId:this.threadId};
   }
   const active=service.controllers.get(projectId)?.current.get(this.target);
   if(this.target==='orchestrator'&&active?.type==='backstage'){await call('nozeli_backstage_respond',{blocked:true,reason:'Preserve the original proposal for the explicit user decision.'});return {completion:'host-control',threadId:this.threadId};}
   throw Error('A completed original business input must not be replayed');
  }
 }
 const service=new ManagedProjects({userDataDir:root,host,legacy:{projects:new Map()}});
 service.openController=async options=>Controller.open({...options,sessionFactory:(spec,target)=>new Session(spec,target),projectHome:async home=>{await fs.mkdir(home,{recursive:true});}});
 t.after(async()=>{await service.stop();await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 await storage.putLocal(projectId,'managed:binding',{enabled:true});
 const seed=await service.loadLocal(projectId);
 const workId=(await seed.store.submit('冷唤醒原任务','brief')).id;
 await seed.store.activate(workId);
 await seed.store.publish(workId,seed.store.find(workId).revision,'problem','冷唤醒问题：建议在本任务内安装构建依赖并重跑验证','wake-problem-call',{jobId:'wake-source-job'});
 await seed.store.mutate(()=>seed.store.state.jobs.push({id:'wake-source-job',target:workId,revision:seed.store.find(workId).revision,type:'manual',status:'completed',text:'源回合',context:{}}));
 await seed.store.settle(workId);
 assert.equal(seed.store.find(workId).status,'paused');
 const p={projectId,workId,objectId:seed.store.find(workId).problem.objectId,revision:seed.store.find(workId).revision,action:'approve',text:'',requestKey:'wake-problem-0001'};
 await seed.stop();service.controllers.delete(projectId);
 const first=await service.invoke('managed.problem.resolve',p);
 assert.equal(first.accepted,true);
 assert.ok(['eligible','running','completed'].includes(first.executionDisposition.kind));
 assert.equal(first.executionDisposition.jobId,first.jobId);
 const controller=service.controllers.get(projectId);
 const until=async(check,label)=>{const end=Date.now()+5000;for(;;){const value=await check();if(value)return value;if(Date.now()>end)throw Error('Timed out: '+label+' '+JSON.stringify({prompts,started:controller.started,kicking:controller.kicking,works:controller.store.state.works.map(({id,status,revision})=>({id,status,revision})),jobs:controller.store.state.jobs.map(({id,target,type,status,error})=>({id,target,type,status,error}))}));await new Promise(resolve=>setTimeout(resolve,20));}};
 await until(()=>controller.started===true&&!controller.running.size&&!controller.kicking&&controller.store.state.jobs.find(j=>j.id===first.jobId)?.status==='completed'&&controller.store.find(workId).status==='review','冷决定后的唯一续作实际完成并发布成果');
 assert.equal(controller.localOnly,false,'prepareOnline 已将冷控制器转入在线');
 assert.ok(sessions.includes('frontdesk')&&sessions.includes('orchestrator'),'显式连接启动居民会话');
 assert.equal(prompts.filter(row=>row.target===workId).length,1,'只投递批准的唯一 Worker 续作，不重放原任务');
 assert.ok(prompts.find(row=>row.target===workId).text.includes('冷唤醒问题'));
 assert.equal(controller.store.state.jobs.filter(j=>j.type==='problem-resume').length,1);
 const jobsBefore=controller.store.state.jobs.length;
 const replay=await service.invoke('managed.problem.resolve',p);
 assert.equal(replay.accepted,true);assert.equal(replay.jobId,first.jobId);
 assert.equal(replay.executionDisposition.kind,'completed','完成后的同键回放不再唤醒任何会话或模型回合');
 assert.equal(controller.store.state.jobs.length,jobsBefore);
 assert.equal(prompts.filter(row=>row.target===workId).length,1);
});

test('manual pause gate survives a cold decision: saved but never started, no sessions',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-problem-held-')),content=path.join(root,'project');await fs.mkdir(content);
 const host=new DesktopHost(root),projectId=(await host.pick(content)).project.id,storage=host.storage;
 let sessionAttempts=0;
 const service=new ManagedProjects({userDataDir:root,host,legacy:{projects:new Map()}});
 service.initializeResources=async()=>{};
 service.openController=async options=>{const c=await Controller.open({...options,sessionFactory:()=>{sessionAttempts++;throw Error('native session forbidden');}});c.execution=null;return c;};
 t.after(async()=>{await service.stop();await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 await storage.putLocal(projectId,'managed:binding',{enabled:true});
 const seed=await service.loadLocal(projectId);
 const workId=(await seed.store.submit('人工暂停下的原任务','brief')).id;
 await seed.store.activate(workId);
 await seed.store.publish(workId,seed.store.find(workId).revision,'problem','人工暂停下的问题报告：建议的本任务处理方案。','held-problem-call',{jobId:'held-source-job'});
 await seed.store.mutate(()=>{seed.store.state.jobs.push({id:'held-source-job',target:workId,revision:seed.store.find(workId).revision,type:'manual',status:'completed',text:'源回合',context:{}});seed.store.find(workId).manualControl={version:1,pause:{requestKey:'user-pause-0001',at:new Date().toISOString()},receipts:[],retired:[]};});
 await seed.store.settle(workId);
 const p={projectId,workId,objectId:seed.store.find(workId).problem.objectId,revision:seed.store.find(workId).revision,action:'approve',text:'',requestKey:'held-problem-0001'};
 await seed.stop();service.controllers.delete(projectId);
 const first=await service.invoke('managed.problem.resolve',p);
 assert.equal(first.accepted,true);
 assert.deepEqual(first.executionDisposition,{kind:'manual-held',reason:'manual-gate',jobId:first.jobId});
 assert.equal(sessionAttempts,0,'人工门阻止任何唤醒：未创建任何会话');
 const held=service.controllers.get(projectId);
 assert.equal(held.started,false);assert.equal(held.sessions.size,0);
 assert.equal(held.store.state.jobs.filter(j=>j.type==='problem-resume').length,1);
 assert.equal(held.store.state.problemActions.length,1);
 assert.equal(held.store.find(workId).status,'running');
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

test('a superseded queued proposal never executes on a newer Work revision',async t=>{
 const {c,run,id,calls}=await fixture(t),{work}=await run();
 const accepted=await c.resolveProblem(decision(work,'approve','problem-stale-admission'));
 const queued=c.store.state.jobs.find(job=>job.id===accepted.jobId),before=calls.length;
 await c.store.mutate(()=>{c.store.find(id).revision++;});
 await c.runJob(queued);
 const saved=c.store.state.jobs.find(job=>job.id===accepted.jobId);
 assert.equal(saved.status,'interrupted');assert.equal(saved.restartRecovery.kind,'needs-reconciliation');
 assert.equal(calls.length,before,'superseded plan never reaches the model or tools');
 assert.equal(c.store.state.jobs.filter(job=>job.type==='problem-resume').length,1);
});
