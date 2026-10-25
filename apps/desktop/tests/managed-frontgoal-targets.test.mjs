import {openTestController,openTestWorkspace} from './project-storage.fixture.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {Controller} from '../src/agents/managed/controller.mjs';
async function chooseBackground(c,job,reason){if(c.frontGoal(job)?.intakeJobId)return c.handoffFront(job,reason);const proposal=await c.proposeFrontdeskRoute(job,reason);return c.resolveFrontdeskRoute({proposalId:proposal.proposalId,expectedVersion:proposal.version,action:'background',requestKey:randomUUID()});}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-frontgoal-target-'));
 class Session{constructor(spec){Object.assign(this,spec);}async start(id){this.threadId=id||randomUUID();return this;}async stop(){this.closed=true;}}
 const c=await openTestController({runtimeRoot:root+'/runtime',contentRoot:root+'/project',projectHome:home=>fs.mkdir(home,{recursive:true}),sessionFactory:spec=>new Session(spec)});await c.start();c.started=false;
 while(c.kicking)await new Promise(resolve=>setTimeout(resolve,5));
 t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});await c.store.mutate(()=>c.store.state.limit=2);
 const a=await c.store.submit('count request','count brief',{name:'人物计数'}),b=await c.store.submit('style request','style brief',{name:'格式检查'});await c.store.activate(a.id);await c.store.activate(b.id);await c.store.mutate(()=>{c.store.find(a.id).status='paused';c.store.find(b.id).status='paused';});
 const original=await c.enqueue('orchestrator','intake','创建队列标记');const q=await c.store.submit('queue request','queue brief',{name:'队列标记',sourceJob:original.jobId});
 const previous=await c.enqueue('frontdesk','front','创建独立队列标记');
 const goal={id:randomUUID(),rootJobId:previous.jobId,jobIds:[previous.jobId],reads:[],chars:0,intakeJobId:original.jobId};
 await c.store.mutate(()=>{c.store.state.frontGoals=[goal];c.store.state.activeFrontGoalId=goal.id;const j=c.store.state.jobs.find(j=>j.id===previous.jobId);j.context.frontGoalId=goal.id;j.status='completed';c.store.state.jobs.find(j=>j.id===original.jobId).status='completed';});
 const front=async text=>{const accepted=await c.enqueue('frontdesk','front',text),job=c.store.state.jobs.find(j=>j.id===accepted.jobId);await c.prepareFrontGoal(job);return job;};
 return {c,a,b,q,goal,front};
}

test('explicit supplement to paused A never inherits the latest queued Q goal',async t=>{
 const {c,a,q,goal,front}=await fixture(t),job=await front('补充原“人物计数”，不是新任务：人物是Mira。');
 assert.notEqual(c.frontGoal(job).id,goal.id);const accepted=await chooseBackground(c, job, 'existing named task'),intake=c.store.state.jobs.find(j=>j.id===accepted.jobId);
 assert.equal(intake.context.boundWorkId,undefined);assert.equal(intake.context.pendingIntakeId,undefined);assert(!intake.text.includes('queue request'));
 c.current.set('orchestrator',intake);await c.onTool('orchestrator',{tool:'nozeli_manage',arguments:{action:'continue',workName:'人物计数',text:'人物是Mira'}});c.current.delete('orchestrator');
 assert(c.store.state.jobs.some(j=>j.target===a.id&&j.type==='supplement'));assert(!c.store.state.jobs.some(j=>j.context?.boundWorkId===q.id));assert.equal(c.store.find(q.id).status,'queued');assert.equal(c.store.used(),2);
});

test('bare continuation keeps Q identity and its frozen reading history',async t=>{
 const {c,q,goal,front}=await fixture(t);goal.reads.push({chars:8000});goal.chars=8000;
 const job=await front('补充：最后加一个简短说明');assert.equal(c.frontGoal(job).id,goal.id);assert.equal(c.frontGoal(job).chars,8000);
 const accepted=await chooseBackground(c, job, 'continuation'),intake=c.store.state.jobs.find(j=>j.id===accepted.jobId);assert.equal(intake.context.boundWorkId,undefined);assert.equal(intake.context.workHintId,q.id);assert.equal(c.intakeBoundWork(intake),undefined);
});

test('explicit new goal, unknown target and multiple Work references stay unbound for main routing',async t=>{
 const {c,goal,front}=await fixture(t);
 for(const text of ['继续一个全新独立任务，创建总结','补充原“未知工作”：继续分析','继续比较人物计数和格式检查','补充“人物计数”和“格式检查”的差异']){
  await c.store.mutate(()=>c.store.state.activeFrontGoalId=goal.id);const job=await front(text);assert.notEqual(c.frontGoal(job).id,goal.id,text);
  const accepted=await chooseBackground(c, job, 'main determines scope'),intake=c.store.state.jobs.find(j=>j.id===accepted.jobId);assert.equal(intake.context.boundWorkId,undefined,text);
 }
});

test('unquoted named supplement and @continue cannot force a different Work into Q',async t=>{
 const {c,goal,front}=await fixture(t),job=await front('补充原人物计数：人物是Mira');assert.notEqual(c.frontGoal(job).id,goal.id);
 c.current.set('frontdesk',job);await assert.rejects(c.onTool('frontdesk',{tool:'nozeli_handoff',arguments:{reason:'@continue'}}),/其他或不明确工作/);c.current.delete('frontdesk');assert.notEqual(c.frontGoal(job).id,goal.id);
});

test('duplicate legacy names are ambiguous rather than inheriting a selected Work',async t=>{
 const {c,b,q,goal,front}=await fixture(t);await c.store.mutate(()=>c.store.find(b.id).name=c.store.find(q.id).name);
 const job=await front('继续“队列标记”的任务');assert.notEqual(c.frontGoal(job).id,goal.id);const accepted=await chooseBackground(c, job, 'ambiguous name'),intake=c.store.state.jobs.find(j=>j.id===accepted.jobId);assert.equal(intake.context.boundWorkId,undefined);
});
