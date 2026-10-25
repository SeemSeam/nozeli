import {openTestController,openTestWorkspace,readTestState,writeTestState,readTestObject} from './project-storage.fixture.mjs';
import {dispositionIntent} from './disposition-intent.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Controller} from '../src/agents/managed/controller.mjs';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-deviation-')),calls=[],controllers=[];
 class Session { async preflightToolsDigest() {} async assertToolsDigest() {} constructor(spec,target){Object.assign(this,spec,{target,closed:false});}
 async start(thread){this.threadId=thread||randomUUID();return this;}
 async stop(){assert(!this.insideTool,'stop must not run inside host tool callback');this.closed=true;calls.push({stop:this.target});return {confirmationComplete:true};}
 async prompt(text){
  calls.push({target:this.target,text});
  if(this.target==='orchestrator')return {completion:'host-control',threadId:this.threadId};
  this.insideTool=true;
  try{
   if(text.includes('TRIGGER_SCOPE'))await this.onTool({tool:'nozeli_report_deviation',arguments:{changedGoal:'Different proposed goal',reason:'Original task does not authorize the trigger',progress:'Original evidence retained; trigger not executed'},callId:'deviation:'+this.target});
   else await this.onTool({tool:'nozeli_publish',arguments:{kind: 'problem', text: '原始任务已恢复；来源已核对。', files: []},callId:randomUUID()});
  }finally{this.insideTool=false;}
  return {completion:'host-control',threadId:this.threadId};
 } }
 const options={runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'content'),sessionFactory:(spec,target)=>new Session(spec,target),projectHome:home=>fs.mkdir(home,{recursive:true})};
 const open=async()=>{const c=await openTestController(options);c.execution=null;controllers.push(c);return c;};
 const c=await open();await c.store.mutate(()=>{for(const binding of Object.values(c.store.state.bindings))binding.provider='omp';});
 t.after(async()=>{for(const controller of controllers)if(!controller.store.closed)await controller.stop();await fs.rm(root,{recursive:true,force:true});});
 const submitted=await c.store.submit('Original immutable task','Brief',{name:'Original'});await c.store.activate(submitted.id);await c.store.mutate(()=>{c.store.find(submitted.id).status='paused';});
 const run=async(text='TRIGGER_SCOPE exact user text')=>{const accepted=await c.send(submitted.id,text);const job=c.store.state.jobs.find(j=>j.id===accepted.jobId);await c.runJob(job);c.current.delete(submitted.id);return c.store.find(submitted.id);};
 return {c,root,calls,run,open,id:submitted.id};
}
const decision=(w,action='continue',requestKey='decision-request-1')=>({projectId:'project',workId:w.id,deviationId:w.deviation.id,expectedRevision:w.revision,expectedVersion:w.deviation.version,action,requestKey});

test('deviation tool durably pauses with exact admitted source and stops outside callback',async t=>{
 const {c,id,run,calls}=await fixture(t),w=await run();
 assert.equal(w.status,'paused');assert.equal(w.request,'Original immutable task');assert.equal(c.store.used(),1);assert.equal(w.deviation.sourceText,'TRIGGER_SCOPE exact user text');
 assert(calls.some(row=>row.stop===id));assert(w.threadId);assert.equal(c.sessions.has(id),false);await fs.stat(c.store.agentHome(id));
 const todo=c.store.state.todos.find(row=>row.id===w.deviation.todoId);assert.equal(todo.kind,'deviation');assert.equal(todo.objectId,w.problem.objectId);
 assert.match(await readTestObject(c.store,todo.objectId).then(bytes=>bytes.toString('utf8')),/Original immutable task[\s\S]*TRIGGER_SCOPE exact user text/);
 await assert.rejects(c.store.continue(id),{code:'DEVIATION_HELD'});await assert.rejects(c.session(id),{code:'DEVIATION_HELD'});await assert.rejects(c.restart(id),{code:'DEVIATION_HELD'});
 await assert.rejects(c.openManualJob(id,'native-blocked','continue'),{code:'DEVIATION_HELD'});
 const queued=await c.send(id,'continue');await c.runJob(c.store.state.jobs.find(j=>j.id===queued.jobId));assert.equal(c.store.state.jobs.find(j=>j.id===queued.jobId).status,'queued');assert.equal(w.revision,2);
});

test('concurrent CAS and durable request idempotency approve exact input once without rewriting request',async t=>{
 const {c,run,id}=await fixture(t),w=await run(),payload=decision(w);
 const results=await Promise.all([c.resolveDeviation(payload),c.resolveDeviation(payload)]);assert.deepEqual(results[0],results[1]);
 assert.equal(c.store.state.jobs.filter(j=>j.type==='deviation-resume').length,1);assert.equal(c.store.find(id).approvedScopes.length,1);assert.equal(c.store.find(id).approvedScopes[0].sourceText,'TRIGGER_SCOPE exact user text');assert.equal(c.store.find(id).request,'Original immutable task');
 await assert.rejects(c.resolveDeviation({...payload,requestKey:'another-request-1',action:'replan'}),{code:'STALE_DEVIATION'});
 await assert.rejects(c.resolveDeviation({...payload,action:'replan'}),{code:'DEVIATION_REQUEST_COLLISION'});
});

test('replan dispatch is unbound and later continue resumes original without re-executing transferred input',async t=>{
 const {c,run,id,calls}=await fixture(t),w=await run();
 const replanned=await c.resolveDeviation(decision(w,'replan')),intake=c.store.state.jobs.find(j=>j.id===replanned.jobId);
 assert.equal(intake.target,'orchestrator');assert.equal(intake.text,'TRIGGER_SCOPE exact user text');assert.equal(intake.context.boundWorkId,undefined);assert.equal(intake.context.workHintId,id);assert.equal(c.intakeBoundWork(intake),undefined);assert.equal(c.deviationHeld(id),true);assert.equal(c.store.find(id).status,'paused');
 const recommendation=await c.manageIntake(intake,{action:'continue',workName:'Original',text:'Route back to old Work'});assert.equal(recommendation.pendingRecommendation,true);assert.equal(recommendation.requiresUserDecision,true);assert.equal(c.store.state.jobs.filter(j=>j.target===id&&j.type==='supplement').length,0);
 const resumed=await c.resolveDeviation(decision(c.store.find(id),'continue','resume-original-1')),job=c.store.state.jobs.find(j=>j.id===resumed.jobId);
 assert.equal(resumed.resumeOriginal,true);assert(!job.text.includes('TRIGGER_SCOPE'));assert.equal(c.store.find(id).approvedScopes,undefined);
 await c.runJob(job);c.current.delete(id);assert.equal(c.store.find(id).revision,3);assert.equal(c.store.find(id).status,'paused');assert(!calls.filter(row=>row.target===id).at(-1).text.includes('TRIGGER_SCOPE'));
});

test('cold restore retains held gate, todo, request history and never replays queued inputs or replan',async t=>{
 const {c,run,id,open}=await fixture(t),w=await run();await c.resolveDeviation(decision(w,'replan'));await c.send(id,'saved while held');const d=structuredClone(c.store.find(id).deviation),thread=c.store.find(id).threadId;await c.stop();
 const next=await open();assert.deepEqual(next.store.find(id).deviation,d);assert.equal(next.store.find(id).threadId,thread);assert.equal(next.store.state.todos.filter(row=>row.id===d.todoId).length,1);assert.equal(next.store.state.jobs.filter(j=>j.status==='queued'||j.status==='running').length,0);assert.equal(next.deviationHeld(id),true);
 const retry=await next.resolveDeviation({...decision(next.store.find(id),'replan'),expectedVersion:1,requestKey:'decision-request-1'});assert.equal(retry.status,'replanned');assert.equal(next.store.state.jobs.filter(j=>j.key==='deviation-replan:'+d.id).length,1);
});

test('ending blocked work archives actual Worker problem bytes as incomplete with separate user facts',async t=>{
 const {c,run,id}=await fixture(t),w=await run(),report=await readTestObject(c.store,w.problem.objectId);
 await c.store.end(id,dispositionIntent(w));await c.store.markStopped(id,{confirmed:true});const archived=await c.store.archiveReport(id);
 assert.equal(archived.kind,'worker-problem');assert.deepEqual(await fs.readFile(path.join(path.dirname(c.store.plan),archived.relPath)),report);
 const metadata=(await readTestState(c.store)).works.find(work=>work.id===id);assert.equal(metadata.outcome,'discard');assert.equal(metadata.deviation.sourceText,'TRIGGER_SCOPE exact user text');
});

test('inherited frontdesk association is only a hint and does not prohibit new-work classification',async t=>{
 const {c,id}=await fixture(t);const root=await c.enqueue('orchestrator','intake','Original immutable task');await c.store.mutate(()=>{const w=c.store.find(id);w.sourceJob=root.jobId;c.store.state.frontGoals=[{id:'goal',intakeJobId:root.jobId,jobIds:[],reads:[],chars:0}];});
 const front={id:'fresh-front',type:'front',text:'Independently new requirement',context:{frontGoalId:'goal'}};await c.store.mutate(()=>c.store.state.jobs.push(front));const receipt=await c.handoffFront(front,'classify input'),intake=c.store.state.jobs.find(j=>j.id===receipt.jobId);
 assert.equal(intake.context.workHintId,id);assert.equal(intake.context.boundWorkId,undefined);assert.equal(c.intakeBoundWork(intake),undefined);
 c.current.set('orchestrator',intake);await c.onTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'Independent',brief:'Independent exact requirement'},callId:randomUUID()});assert.equal(c.store.state.works.length,2);assert.equal(c.store.state.works.at(-1).request,front.text);
});

test('competing user decisions serialize by event CAS and repeated events retain approved history',async t=>{
 const {c,run,id}=await fixture(t),w=await run(),continuePayload=decision(w,'continue','race-continue-1'),replanPayload=decision(w,'replan','race-replan-1');
 const results=await Promise.allSettled([c.resolveDeviation(continuePayload),c.resolveDeviation(replanPayload)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'STALE_DEVIATION');
 const resume=c.store.state.jobs.find(j=>j.type==='deviation-resume');await c.store.mutate(()=>{resume.status='interrupted';c.store.continueState(id);});
 const admitted={id:randomUUID(),target:id,type:'manual',text:'SECOND_SCOPE',revision:c.store.find(id).revision,context:{},status:'running'};await c.store.mutate(()=>c.store.state.jobs.push(admitted));
 const second=await c.store.reportDeviation(id,admitted,{changedGoal:'Second change',reason:'Outside approved input',progress:'No second input executed'},'second-report');
 assert.equal(second.version,1);assert.equal(c.store.find(id).deviationHistory.length,1);assert.equal(c.store.find(id).deviationHistory[0].status,'continued');assert.equal(c.store.find(id).approvedScopes[0].sourceText,'TRIGGER_SCOPE exact user text');
 await c.store.mutate(()=>{c.store.state.todos.find(row=>row.id===second.todoId).status='resolved';});assert.equal(c.deviationHeld(id),true);await assert.rejects(c.store.continue(id),{code:'DEVIATION_HELD'});
});
