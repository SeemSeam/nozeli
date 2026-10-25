import {openTestController,openTestWorkspace,readTestState,writeTestState,readTestObject} from './project-storage.fixture.mjs';
import {dispositionIntent} from './disposition-intent.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Controller} from '../src/agents/managed/controller.mjs';

const wait=async fn=>{const until=Date.now()+5000;while(Date.now()<until){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('condition timeout');};
async function fixture(t,{holdWorker=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-boundaries-'));let c;const controllers=[],prompts=[];
 class Session {
  constructor(spec,target){Object.assign(this,spec,{target,closed:false,busy:false});}
  async start(id){this.threadId=id||randomUUID();return this;}
  async stop(){this.closed=true;this.rejectTurn?.(new Error('provider stopped'));}
  async prompt(text){this.busy=true;prompts.push({target:this.target,text});try{const job=c.current.get(this.target);
   if(!['frontdesk','orchestrator'].includes(this.target)){
    if(holdWorker)await new Promise((_,reject)=>this.rejectTurn=reject);
    await this.onTool({tool:'nozeli_publish',arguments:{kind: 'result', html: staticReport('Fixture report'), files: []},callId:randomUUID()});
   }
   return {threadId:this.threadId,turnId:randomUUID(),text:'fixture'};
  }finally{this.busy=false;}}
 }
 const options={runtimeRoot:path.join(root,'data'),contentRoot:path.join(root,'content'),projectHome:async home=>fs.mkdir(home,{recursive:true}),sessionFactory:(spec,target)=>new Session(spec,target)};
 const open=async()=>{c=await openTestController(options);controllers.push(c);return c;};await open();await c.start();await wait(()=>!c.kicking);
 t.after(async()=>{for(const controller of controllers)await controller.stop();await fs.rm(root,{recursive:true,force:true});});
 return {c,open,prompts};
}
function observeSaves(c){const snapshots=[],save=c.store.save.bind(c.store);c.store.save=async(...args)=>{await save(...args);snapshots.push(await readTestState(c.store));};return snapshots;}

test('every persisted activation includes the binding and initial job',async t=>{
 const {c}=await fixture(t),snapshots=observeSaves(c);const w=await c.store.submit('original','brief',{name:'Alpha'});c.kick();await wait(()=>c.store.find(w.id).status==='review'&&!c.running.size);
 const activated=snapshots.filter(s=>s.works.find(x=>x.id===w.id).revision>0);assert.ok(activated.length);
 for(const s of activated){assert.ok(s.works[0].binding);assert.equal(s.jobs.filter(j=>j.key===`initial:${w.id}`).length,1,'activation must not persist without initial input');}
});
test('supplement, routing decision and accepted queue entry persist together',async t=>{
 const {c}=await fixture(t);const w=await c.store.submit('original','brief',{name:'Alpha'});c.kick();await wait(()=>c.store.find(w.id).status==='review'&&!c.running.size);c.started=false;
 const accepted=await c.enqueue('orchestrator','intake','Additional constraint');const job=c.store.state.jobs.find(j=>j.id===accepted.jobId),snapshots=observeSaves(c);
 await c.manageIntake(job,{action:'continue',workName:'Alpha',text:'Refined constraint'});
 for(const s of snapshots.filter(s=>s.works[0].inputs?.length)){assert.ok(s.jobs.some(j=>j.key===`supplement:${job.id}`));assert.equal(s.jobs.find(j=>j.id===job.id).routing?.action,'continue');}
});
test('a send checked before user-end cannot enqueue after the end intent',async t=>{
 const {c}=await fixture(t);const w=await c.store.submit('original','brief',{name:'Alpha'});c.kick();await wait(()=>c.store.find(w.id).status==='review'&&!c.running.size);c.started=false;
 await c.setDraft(w.id,'Keep my rejected draft');
 let release;const gate=new Promise(resolve=>release=resolve),block=c.store.mutate(async()=>gate);
 await Promise.resolve();
 const ending=c.store.end(w.id,dispositionIntent(c.store.find(w.id)));const sending=c.send(w.id,'Late input');release();await block;await ending;
 await assert.rejects(sending,/closing|current state/);assert.ok(!c.store.state.jobs.some(j=>j.target===w.id&&j.text==='Late input'));assert.equal(c.store.state.drafts[w.id],'Keep my rejected draft');
});
test('active user cancellation is cancelled, without failure UI or model-failure observation',async t=>{
 const {c}=await fixture(t,{holdWorker:true});const w=await c.store.submit('original','brief',{name:'Alpha'});c.kick();await wait(()=>c.sessions.get(w.id)?.busy);
 await c.endWork(w.id,{revision:c.store.find(w.id).revision,decision:'discard'});await wait(()=>c.store.find(w.id).status==='ended'&&!c.running.size);
 const job=c.store.state.jobs.find(j=>j.target===w.id);assert.equal(job.status,'cancelled');assert.equal(job.interruptionReason,'user-ended');
 assert.ok(!c.store.state.messages.some(m=>m.target===w.id&&m.text?.includes('本次处理失败')));
 assert.ok(!c.store.state.todos.some(todo=>todo.workId===w.id&&todo.kind==='recovery'));
 assert.equal(c.store.used(),0);await assert.rejects(fs.stat(c.store.agentHome(w.id)),{code:'ENOENT'});
});
test('publication receipt and conversation projection persist together',async t=>{
 const {c}=await fixture(t),snapshots=observeSaves(c);const w=await c.store.submit('original','brief',{name:'Alpha'});c.kick();await wait(()=>c.store.find(w.id).status==='review'&&!c.running.size);
 for(const s of snapshots)for(const receipt of s.receipts)assert.equal(s.messages.filter(m=>m.objectId===receipt.objectId).length,1);
});
test('old receipt without conversation projection repairs once on restart without replay',async t=>{
 const {c,open}=await fixture(t);const w=await c.store.submit('original','brief',{name:'Alpha'});c.kick();await wait(()=>c.store.find(w.id).status==='review'&&!c.running.size);
 const receipt=c.store.state.receipts[0];await c.store.mutate(()=>{c.store.state.messages=c.store.state.messages.filter(m=>m.objectId!==receipt.objectId);});const jobCount=c.store.state.jobs.length;await c.stop();const next=await open();
 assert.equal(next.store.state.messages.filter(m=>m.objectId===receipt.objectId).length,1);assert.equal(next.store.state.jobs.length,jobCount);assert.equal(next.store.find(w.id).status,'review');await next.stop();const again=await open();assert.equal(again.store.state.messages.filter(m=>m.objectId===receipt.objectId).length,1);
});
test('supplement arriving during activation runs once after the initial job',async t=>{
 const {c,prompts}=await fixture(t);c.started=false;
 const w=await c.store.submit('original','brief',{name:'Alpha'}),accepted=await c.enqueue('orchestrator','intake','During activation');
 const job=c.store.state.jobs.find(j=>j.id===accepted.jobId);await c.store.mutate(()=>{job.status='completed';});
 let release,entered;const blocked=new Promise(r=>entered=r),gate=new Promise(r=>release=r),save=c.store.save.bind(c.store);let held=false;
 c.store.save=async()=>{if(!held&&c.store.find(w.id).status==='running'){held=true;entered();await gate;}return save();};c.started=true;c.kick();await blocked;
 const supplement=c.manageIntake(job,{action:'continue',workName:'Alpha',text:'Same Work, extra constraint'});release();await supplement;await wait(()=>c.store.find(w.id).revision===2&&c.store.find(w.id).status==='review'&&!c.running.size);
 const turns=c.store.state.jobs.filter(j=>j.target===w.id);assert.deepEqual(turns.map(j=>j.type),['initial','supplement']);assert.ok(turns.every(j=>j.status==='completed'));assert.equal(new Set(turns.map(j=>j.threadId)).size,1);assert.equal(prompts.filter(p=>p.target===w.id&&p.text.includes('During activation')).length,1);
});
test('priority input cannot overtake a persisted initial job',async t=>{
 const {c}=await fixture(t);c.started=false;const w=await c.store.submit('original','brief',{name:'Alpha'});
 await c.store.activate(w.id,{initialize:current=>c.queueJob(current.id,'initial','Initial request',{key:`initial:${current.id}`})});
 await c.send(w.id,'Normal follow-up');await c.send(w.id,'Urgent follow-up',{priority:true});assert.deepEqual(c.store.state.jobs.filter(j=>j.target===w.id).map(j=>j.text),['Initial request','Urgent follow-up','Normal follow-up']);
});
test('late publication after user end is rejected without a new receipt',async t=>{
 const {c}=await fixture(t);c.started=false;const w=await c.store.submit('original','brief',{name:'Alpha'});await c.store.activate(w.id);
 c.current.set(w.id,{target:w.id,revision:1,id:'late-job'});await c.store.end(w.id,dispositionIntent(c.store.find(w.id)));
 await assert.rejects(c.onTool(w.id,{tool:'nozeli_publish',arguments:{kind: 'result', html: staticReport('Late report'), files: []},callId:'late-call'}),/closing/);assert.equal(c.store.state.receipts.length,0);c.current.delete(w.id);
});
;
test('user-input limit still rejects oversized input without erasing its draft',async t=>{
 const {c}=await fixture(t);await c.setDraft('frontdesk','Keep draft');const count=c.store.state.jobs.length;
 await assert.rejects(c.send('frontdesk','x'.repeat(32001)),/invalid input/);assert.equal(c.store.state.jobs.length,count);assert.equal(c.store.state.drafts.frontdesk,'Keep draft');
});
test('explicit user end preserves unsent conversation drafts as history',async t=>{
 const {c}=await fixture(t);const w=await c.store.submit('original','brief',{name:'Alpha'});c.kick();await wait(()=>c.store.find(w.id).status==='review'&&!c.running.size);
 await c.setDraft(w.id,'Unsent user answer');c.nativeDraftTargets.add(w.id);await c.endWork(w.id,{revision:1,decision:'discard'});assert.equal(c.store.find(w.id).status,'ended');assert.equal(c.store.state.drafts[w.id],'Unsent user answer');c.nativeDraftTargets.delete(w.id);
});
;

test('manual task bypasses frontend, accepts once by key and keeps later draft',async t=>{
 const {c}=await fixture(t);c.started=false;c.nativeDraftTargets.add('orchestrator');await c.setDraft('frontdesk','one');const first=await c.submitTask('one',{requestKey:'manual-one'});
 assert.equal(c.store.state.jobs.filter(j=>j.type==='front').length,0);assert.equal(c.store.state.jobs.filter(j=>j.type==='intake').length,1);assert.equal(c.store.state.drafts.frontdesk,'');assert.equal(c.store.state.messages.at(-1).target,'frontdesk');assert.equal(c.store.state.messages.at(-1).taskRequestId,first.jobId);
 await c.setDraft('frontdesk','later draft');assert.equal((await c.submitTask('one',{requestKey:'manual-one'})).jobId,first.jobId);assert.equal(c.store.state.drafts.frontdesk,'later draft');await assert.rejects(c.submitTask('different',{requestKey:'manual-one'}),/collision/);
 assert.notEqual((await c.submitTask('one',{requestKey:'manual-two'})).jobId,first.jobId);
});
test('dispatch, lineage and route commit once; save failure rolls everything back',async t=>{
 const {c}=await fixture(t);c.started=false;const accepted=await c.submitTask('Atomic request',{requestKey:'atomic-one'}),job=c.store.state.jobs.find(j=>j.id===accepted.jobId);c.current.set('orchestrator',structuredClone(job));const save=c.store.save.bind(c.store),before=await readTestState(c.store).then(state=>JSON.stringify(state));let failed=false;
 c.store.save=async()=>{if(!failed){failed=true;throw Error('injected disk failure');}return save();};const args={tool:'nozeli_dispatch',arguments:{name:'Atomic',brief:'Do actual bounded work'}};
 await assert.rejects(c.onTool('orchestrator',args),/disk failure/);assert.equal(c.store.state.works.length,0);assert.equal(c.store.state.jobs[0].routing,undefined);assert.equal(await readTestState(c.store).then(state=>JSON.stringify(state)),before);
 const snapshots=observeSaves(c),receipt=await c.onTool('orchestrator',args);assert.equal((await c.onTool('orchestrator',args)).workId,receipt.workId);assert.equal(c.store.state.works.length,1);
 for(const s of snapshots){const w=s.works[0];assert.equal(w.sourceJob,job.id);assert.deepEqual(w.sourceInputJobIds,[job.id]);assert.equal(s.jobs[0].routing.workId,w.id);}
 c.current.delete('orchestrator');
});
test('failed intake retries explicitly on original root and blocks replay after dispatch',async t=>{
 const {c,open}=await fixture(t);c.started=false;const accepted=await c.submitTask('Retry this',{requestKey:'retry-source'});await c.store.mutate(()=>{c.store.state.jobs[0].status='interrupted';});await c.stop();const restored=await open();assert.equal(restored.store.state.jobs.length,1);assert.equal(restored.store.state.jobs[0].status,'interrupted');
 const retry=await restored.retryIntake(accepted.jobId,'retry-click');assert.equal((await restored.retryIntake(accepted.jobId,'second-click')).jobId,retry.jobId);assert.equal(restored.store.state.jobs.length,2);const job=restored.store.state.jobs.at(-1);assert.deepEqual(restored.intakeSource(job).sourceInputJobIds,[accepted.jobId,retry.jobId]);assert.equal(restored.intakeSource(job).request,'Retry this');
 restored.current.set('orchestrator',structuredClone(job));await restored.onTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'Retry',brief:'Do it'}});await assert.rejects(restored.retryIntake(accepted.jobId,'late-click'),/重复派工/);restored.current.delete('orchestrator');
});
test('direct queued Worker input is host-resolved on original Work without model routing',async t=>{
 const {c}=await fixture(t);c.started=false;const w=await c.store.submit('queued original','brief',{name:'Queued'});await c.setDraft(w.id,'extra');const accepted=await c.send(w.id,'extra',{requestKey:'queued-supplement'});const job=c.store.state.jobs.find(j=>j.id===accepted.jobId);assert.equal(job.type,'intake');assert.equal(job.context.boundWorkId,w.id);assert.equal(c.store.state.messages.at(-1).target,w.id);assert.equal(c.store.state.drafts[w.id],'');assert.equal(accepted.hostResolved,true);assert.equal(job.status,'completed');assert.equal(job.promptStartedAt,null);assert.equal(c.store.find(w.id).inputs[0].text,'extra');assert.equal(c.store.find(w.id).brief,'brief');assert.equal(c.store.state.works.length,1);assert.equal(c.store.find(w.id).threadId,undefined);
});
test('separately accepted answers to one clarification cannot dispatch replacement Workers',async t=>{const {c}=await fixture(t);c.started=false;const root=await c.submitTask('Original request',{requestKey:'multi-answer-root'}),job=c.store.state.jobs.find(j=>j.id===root.jobId);await c.manageIntake(job,{action:'clarify',workName:'',text:'Which format?'});const q=c.store.state.todos.find(t=>t.sourceJobId===job.id),one=await c.submitTask('1',{requestKey:'answer-one',context:{routingQuestionId:q.id}}),two=await c.submitTask('2',{requestKey:'answer-two',context:{routingQuestionId:q.id}});c.current.set('orchestrator',c.store.state.jobs.find(j=>j.id===one.jobId));const w=await c.onTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'Original',brief:'First answer'}});c.current.set('orchestrator',c.store.state.jobs.find(j=>j.id===two.jobId));await assert.rejects(c.onTool('orchestrator',{tool:'nozeli_dispatch',arguments:{name:'Replacement',brief:'Second answer'}}),/existing Work/);await c.manageIntake(c.store.state.jobs.find(j=>j.id===two.jobId),{action:'continue',workName:'Original',text:'Additional answer'});assert.equal(c.store.state.works.length,1);assert.equal(c.store.find(w.workId).inputs.length,1);c.current.delete('orchestrator');});
test('user ending a queued work retains host-accepted supplement without starting Worker',async t=>{const {c}=await fixture(t);c.started=false;const w=await c.store.submit('queued task','brief',{name:'Queued'}),accepted=await c.send(w.id,'supplement',{requestKey:'queued-cancel'});await c.endWork(w.id,{revision:c.store.find(w.id).revision,decision:'discard'});const job=c.store.state.jobs.find(j=>j.id===accepted.jobId);assert.equal(job.status,'completed');assert.equal(job.hostResolved,true);assert.equal(c.store.find(w.id).inputs[0].text,'supplement');c.started=true;c.kick();await wait(()=>c.store.find(w.id).status==='ended'&&!c.running.size);assert.equal(c.store.state.jobs.filter(j=>j.target===w.id).length,0);assert.ok(!c.store.state.todos.some(q=>q.kind==='system'&&q.sourceJobId===job.id));});
test('active explicitly bound semantic intake settles as user cancellation without stopping resident main',async t=>{const {c}=await fixture(t);c.started=false;const w=await c.store.submit('queued task','brief',{name:'Queued'}),accepted=await c.send('orchestrator','supplement',{requestKey:'active-bound-end',context:{boundWorkId:w.id}}),main=c.sessions.get('orchestrator'),prompt=main.prompt.bind(main);let release;main.prompt=async text=>{if(c.current.get('orchestrator')?.type!=='intake')return prompt(text);await new Promise(r=>release=r);return {threadId:main.threadId,turnId:randomUUID(),text:'late response'};};c.started=true;c.kick();await wait(()=>Boolean(release));await c.endWork(w.id,{revision:c.store.find(w.id).revision,decision:'discard'});const late=await c.onTool('orchestrator',{tool:'nozeli_manage',arguments:{action:'clarify',workName:'Queued',text:'Late question'}});assert.equal(late.cancelled,true);assert.ok(!c.store.state.todos.some(q=>q.kind==='routing'));release();await wait(()=>c.store.find(w.id).status==='ended'&&!c.running.size);assert.equal(c.store.state.jobs.find(j=>j.id===accepted.jobId).status,'cancelled');assert.ok(!main.closed);assert.ok(!c.store.state.todos.some(q=>q.kind==='system'&&q.sourceJobId===accepted.jobId));assert.ok(!c.store.state.messages.some(m=>m.jobId===accepted.jobId&&m.text?.includes('本次处理失败')));});
