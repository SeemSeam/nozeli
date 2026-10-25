import {openTestController,openTestWorkspace} from './project-storage.fixture.mjs';
import {dispositionIntent} from './disposition-intent.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
// Deterministic lifecycle coverage of the formal runtime; no real model claims.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';import {Controller} from '../src/agents/managed/controller.mjs';
const wait=async fn=>{const end=Date.now()+5000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('condition timeout');};
const submitBackground=(c,text,options={})=>!text||text.startsWith('light')?c.send('frontdesk',text,options):c.submitTask(text,{requestKey:randomUUID(),...options});
async function fixture(t,{automatic=true}={}){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-controller-'));const calls=[],all=[];let dropEmpty=false;
 class FakeSession{constructor(spec,target){Object.assign(this,spec,{target,closed:false,busy:false,toolsDigest:'fixture-native-schema'});}async preflightToolsDigest(){}async assertToolsDigest(){}async start(id){if(id&&dropEmpty)throw Object.assign(new Error('OMP_SESSION_FILE_NOT_FOUND'),{code:'OMP_SESSION_FILE_NOT_FOUND'});this.threadId=id||randomUUID();calls.push({type:'start',target:this.target,threadId:this.threadId});return this;}async prompt(text){this.hasPrompted=true;this.busy=true;calls.push({type:'prompt',target:this.target,text});try{await new Promise(r=>setTimeout(r,15));const tool=(name,args)=>this.onTool({tool:name,arguments:args,threadId:this.threadId,callId:randomUUID()});if(this.target==='frontdesk'&&!text.split('用户本次原文：\n').at(-1).startsWith('light'))await tool('nozeli_handoff',{reason:'specialist'});else if(this.target==='orchestrator'){if(text.includes('原始请求:\nlight manual answer'))await tool('nozeli_manage',{action:'status',workName:'',text:'current status'});else if(text.includes('主控入口'))await tool('nozeli_dispatch',{name:'worker '+randomUUID().slice(0,4),brief:text});}else if(!['frontdesk','orchestrator'].includes(this.target))await tool('nozeli_publish',{kind: 'result', html: staticReport('Verified fixture report'), files: []});return {text:'fixture response',threadId:this.threadId,turnId:randomUUID()};}finally{this.busy=false;}}async stop(){this.closed=true;}}
 const options={runtimeRoot:path.join(root,'data'),contentRoot:path.join(root,'content'),sessionFactory:(spec,target)=>new FakeSession(spec,target)};const c=await openTestController(options);all.push(c);await c.start();await wait(()=>!c.kicking);c.started=automatic;t.after(async()=>{await Promise.all(all.map(c=>c.stop()));await fs.rm(root,{recursive:true,force:true});});return {c,root,calls,loseEmptyThreads:()=>{dropEmpty=true;},reopen:async()=>{const n=await openTestController(options);all.push(n);await n.start();return n;}};}
test('automatic queue releases quota on user end while preserving prior Worker history',async t=>{const {c,calls}=await fixture(t);await submitBackground(c, 'task A');await submitBackground(c, 'task B');await wait(()=>c.store.state.works.length===2&&c.store.state.works[0].status==='review');const [a,b]=c.store.state.works;assert.equal(b.status,'queued');assert.equal(c.store.used(),1);assert.equal(calls.filter(x=>x.type==='start'&&!['frontdesk','orchestrator'].includes(x.target)).length,1);await wait(()=>!c.running.has(a.id));await c.endWork(a.id,{revision:a.revision,decision:'accept'});await wait(()=>c.store.find(b.id).status==='review');assert.equal(c.store.find(a.id).status,'ended');assert.notEqual(c.store.find(a.id).threadId,c.store.find(b.id).threadId);assert.equal(c.store.used(),1);assert((await fs.stat(c.store.find(a.id).closure.workerHome.historyPath)).isDirectory());});
test('manual draft holds automatic intake until released without losing original request',async t=>{const {c}=await fixture(t);await c.setDraft('orchestrator','unsent manual draft');await submitBackground(c, 'task original');await wait(()=>c.store.state.jobs.some(j=>j.target==='orchestrator'));assert.equal(c.store.state.works.length,0);assert.equal(c.store.state.drafts.orchestrator,'unsent manual draft');await c.setDraft('orchestrator','');await wait(()=>c.store.state.works[0]?.status==='review');assert.equal(c.store.state.works[0].request,'task original');});
test('reopen retains review, resident and worker thread ids, quota and unsent draft',async t=>{const {c,reopen}=await fixture(t);await submitBackground(c, 'task A');await wait(()=>c.store.state.works[0]?.status==='review'&&!c.running.size);const w=structuredClone(c.store.state.works[0]),front=c.store.state.residents.frontdesk.threadId;await c.setDraft(w.id,'my draft');await c.stop();const next=await reopen();assert.equal(next.store.state.residents.frontdesk.threadId,front);assert.equal(next.store.find(w.id).status,'review');assert.equal(next.store.find(w.id).threadId,w.threadId);assert.equal(next.store.state.drafts[w.id],'my draft');assert.equal(next.store.used(),1);assert.equal(next.snapshot().agents.find(a=>a.target===w.id).resumable,true);await next.send(w.id,'follow up');await wait(()=>next.store.find(w.id).revision===2&&next.store.find(w.id).status==='review');assert.equal(next.store.find(w.id).threadId,w.threadId);});
test('failed stale end check does not detach running job state from durable job record',async t=>{const {c}=await fixture(t);await submitBackground(c, 'task A');await wait(()=>c.store.state.works[0]?.status==='review'&&!c.running.size);const id=c.store.state.works[0].id;await assert.rejects(c.endWork(id,{revision:0,decision:'accept'}),/stale/);await c.send(id,'followup');await wait(()=>c.store.find(id).revision===2&&c.store.find(id).status==='review'&&!c.running.size);assert.equal(c.store.state.jobs.at(-1).status,'completed');});

;

test('missing empty native thread can restart without changing Work identity or replaying input',async t=>{const {c,reopen,loseEmptyThreads}=await fixture(t,{automatic:false});const w=await c.store.submit('empty worker','brief');await c.store.activate(w.id);await c.session(w.id);const old=c.store.find(w.id).threadId;await c.stop();loseEmptyThreads();const next=await reopen();await next.session(w.id);assert.notEqual(next.store.find(w.id).threadId,old);assert.equal(next.store.find(w.id).status,'paused');assert.equal(next.store.state.jobs.length,0);assert.equal(next.store.used(),1);assert.equal(next.store.state.recoveryEvents.filter(e=>e.type==='omp-zero-activity-restarted').length,3);});
test('missing native history after accepted execution never silently starts a new conversation',async t=>{const {c,reopen,loseEmptyThreads}=await fixture(t);await submitBackground(c,'light question');await wait(()=>!c.running.size&&c.store.state.jobs[0]?.status==='completed');await c.stop();loseEmptyThreads();await assert.rejects(reopen(),/OMP_SESSION_FILE_NOT_FOUND/);});
;
test('connection failure preserves exact input and reason without model-configuration advice or automatic replay',async t=>{
 const {c}=await fixture(t);c.sessions.get('frontdesk').prompt=async()=>{throw Object.assign(Error('write closed'),{code:'EPIPE'});};await submitBackground(c, 'light exact input');await wait(()=>c.store.state.jobs.some(j=>j.status==='failed')&&!c.running.size);
 assert.equal(c.store.state.jobs.length,1);assert.equal(c.store.state.jobs[0].text,'light exact input');const message=c.store.state.messages.findLast(m=>m.speaker==='system');assert(message.text.includes('write closed'));assert(message.text.includes('连接中断'));assert(!message.text.includes('模型配置'));assert.equal(c.store.state.jobs[0].error,'write closed');
});
test('role skills retain resident identity and existing worker bindings while changing new workers',async t=>{const {c}=await fixture(t);const front=c.store.state.residents.frontdesk.threadId;await c.setBinding('frontdesk',{provider:'omp'});assert.equal(c.store.state.residents.frontdesk.threadId,front);await submitBackground(c, 'task A');await wait(()=>c.store.state.works[0]?.status==='review'&&!c.running.size);const first=c.store.state.works[0],original=structuredClone(first.binding);await c.setBinding('worker',{provider:'omp',skills:['report.md']});assert.deepEqual(c.store.find(first.id).binding,original);await c.endWork(first.id,{revision:1,decision:'accept'});await wait(()=>c.store.find(first.id).status==='ended'&&!c.running.size);await submitBackground(c, 'task B');await wait(()=>c.store.state.works[1]?.status==='review'&&!c.running.size);assert.equal(c.store.state.works[1].binding.effort,undefined);assert.deepEqual(c.store.state.works[1].binding.skills,['report.md']);await assert.rejects(c.setBinding('worker',{skills:['unknown.md']}),/unknown/);});
test('resident settings reject accepted queued input rather than bypass it',async t=>{const {c}=await fixture(t);const before=structuredClone(c.store.state.bindings.frontdesk);await c.setDraft('frontdesk','hold automatic input');await c.enqueue('frontdesk','front','light question');await assert.rejects(c.setBinding('frontdesk',{provider:'omp'}),/accepted input/);assert.deepEqual(c.store.state.bindings.frontdesk,before);});
test('native composer holds automatic intake and rejects another manual input until released',async t=>{const {c}=await fixture(t);c.nativeDraftTargets.add('orchestrator');await submitBackground(c, 'task original');await wait(()=>c.store.state.jobs.some(j=>j.target==='orchestrator'&&j.status==='queued'));assert.equal(c.store.state.works.length,0);await assert.rejects(c.send('orchestrator','other manual input'),{code:'NATIVE_DRAFT_PENDING'});c.nativeDraftTargets.delete('orchestrator');c.kick();await wait(()=>c.store.state.works[0]?.status==='review'&&!c.running.size);assert.equal(c.store.state.works[0].request,'task original');});
test('submitted native orchestrator draft runs before held automatic intake without losing it',async t=>{const {c,calls}=await fixture(t);c.nativeDraftTargets.add('orchestrator');await submitBackground(c, 'task original');await wait(()=>c.store.state.jobs.some(j=>j.target==='orchestrator'&&j.status==='queued'));await c.send('orchestrator','light manual answer',{priority:true,native:true});assert.equal(c.store.state.jobs.filter(j=>j.target==='orchestrator')[0].text,'light manual answer');c.nativeDraftTargets.delete('orchestrator');c.kick();await wait(()=>c.store.state.works[0]?.status==='review'&&!c.running.size);assert.equal(c.store.state.works[0].request,'task original');assert.ok(calls.filter(x=>x.type==='prompt'&&x.target==='orchestrator')[0].text.endsWith('light manual answer'));});
test('rejected input preserves the durable composer draft',async t=>{const {c}=await fixture(t);await c.setDraft('frontdesk','keep this draft');await assert.rejects(submitBackground(c, ''),/invalid input/);assert.equal(c.store.state.drafts.frontdesk,'keep this draft');});

test('explicit tag input dispatches serially without consuming independent main draft or releasing automatic input',async t=>{
 const {c,calls}=await fixture(t);const thread=c.sessions.get('frontdesk').threadId;
 await c.setDraft('frontdesk','UNSENT_MAIN_ALPHA');
 c.restarting=new Map([['frontdesk',Promise.resolve()]]);
 const automatic=await c.enqueue('frontdesk','front','light automatic held');
 const first=await c.send('frontdesk','light tag question',{requestKey:'explicit-tag-first',draftText:'tag question'});
 const second=await c.send('frontdesk','light tag followup',{requestKey:'explicit-tag-second',draftText:'tag followup'});
 const duplicate=await c.send('frontdesk','light tag question',{requestKey:'explicit-tag-first',draftText:'tag question'});assert.equal(duplicate.jobId,first.jobId);
 c.restarting.delete('frontdesk');c.kick();
 await c.setDraft('frontdesk','UNSENT_MAIN_NEWER');
 await wait(()=>[first,second].every(receipt=>c.store.state.jobs.find(job=>job.id===receipt.jobId)?.status==='completed')&&!c.running.size);
 assert.equal(c.store.state.drafts.frontdesk,'UNSENT_MAIN_NEWER');
 assert.equal(c.sessions.get('frontdesk').threadId,thread);
 assert.equal(c.store.state.jobs.find(job=>job.id===automatic.jobId).status,'queued');
 assert.deepEqual(calls.filter(call=>call.type==='prompt'&&call.target==='frontdesk').map(call=>call.text.split('用户本次原文：\n').at(-1)),['light tag question','light tag followup']);
 assert.equal(c.store.state.jobs.length,3);
});

test('native draft still fences already accepted explicit input until deliberately cleared',async t=>{
 const {c,calls}=await fixture(t);c.restarting=new Map([['frontdesk',Promise.resolve()]]);
 await c.setDraft('frontdesk','UNSENT_MAIN_ALPHA');
 const accepted=await c.send('frontdesk','light explicit waiting',{requestKey:'explicit-native-fence',draftText:'tag input'});
 c.nativeDraftTargets.add('frontdesk');c.restarting.delete('frontdesk');await c.pump();
 assert.equal(c.store.state.jobs.find(job=>job.id===accepted.jobId).status,'queued');
 assert.equal(calls.filter(call=>call.type==='prompt').length,0);
 await assert.rejects(c.send('frontdesk','light rejected',{draftText:'tag input'}),{code:'NATIVE_DRAFT_PENDING'});
 assert.equal(c.store.state.drafts.frontdesk,'UNSENT_MAIN_ALPHA');
 c.nativeDraftTargets.delete('frontdesk');c.kick();
 await wait(()=>c.store.state.jobs.find(job=>job.id===accepted.jobId).status==='completed'&&!c.running.size);
 assert.equal(c.store.state.drafts.frontdesk,'UNSENT_MAIN_ALPHA');
});

test('failed context delivery does not consume events; retry succeeds and restore retains checkpoint',async t=>{
 const {c,reopen,calls}=await fixture(t);await submitBackground(c, 'light first');await wait(()=>!c.running.size&&c.store.state.jobs[0].status==='completed');const before=structuredClone(c.store.state.contextDelivery.frontdesk);
 await c.store.mutate(()=>c.store.state.messages.push({id:'external-update',target:'orchestrator',audience:'frontdesk',speaker:'system',text:'Important outside update'}));c.sessions.get('frontdesk').prompt=async()=>{throw Error('fixture provider failure');};await submitBackground(c, 'light failed');await wait(()=>!c.running.size&&c.store.state.jobs.at(-1).status==='failed');assert.deepEqual(c.store.state.contextDelivery.frontdesk,before);
 await submitBackground(c, 'light retry');await wait(()=>!c.running.size&&c.store.state.jobs.at(-1).status==='completed');const retry=calls.filter(x=>x.type==='prompt'&&x.target==='frontdesk').at(-1);assert(retry.text.includes('Important outside update'));const checkpoint=structuredClone(c.store.state.contextDelivery.frontdesk);await c.stop();const restored=await reopen();assert.deepEqual(restored.store.state.contextDelivery.frontdesk,checkpoint);await submitBackground(restored, 'light after restart');await wait(()=>!restored.running.size&&restored.store.state.jobs.at(-1).status==='completed');const after=calls.filter(x=>x.type==='prompt'&&x.target==='frontdesk').at(-1);assert(!after.text.includes('Important outside update'));assert(!after.text.includes('light first'));
});

test('restoring Worker keeps durable identity visible while provider start is pending',async t=>{
 const {c,reopen}=await fixture(t);await submitBackground(c, 'task identity');await wait(()=>!c.running.size&&c.store.state.works[0]?.status==='review');const w=structuredClone(c.store.state.works[0]);await c.stop();const next=await reopen(),factory=next.sessionFactory;let release;const gate=new Promise(r=>release=r);
 let starts=0,concurrent,resolved;
 next.sessionFactory=(spec,target)=>{const session=factory(spec,target),start=session.start.bind(session);session.start=async id=>{starts++;await gate;return start(id);};return session;};
 const pending=next.session(w.id);
 try{await wait(()=>next.sessions.has(w.id));concurrent=next.session(w.id);const shown=next.snapshot().agents.find(a=>a.target===w.id);assert.equal(shown.threadId,w.threadId);assert.equal(shown.starting,true);}finally{release();resolved=await Promise.all([pending,concurrent]);}
 assert.equal(resolved[0],resolved[1],'concurrent native attach must resolve to the original initialized owner');assert.equal(resolved[0],next.sessions.get(w.id));assert.equal(starts,1,'concurrent native attach must not start another provider session');assert.equal(next.snapshot().agents.find(a=>a.target===w.id).threadId,w.threadId);
});
;
;
test('proven pre-prompt interruption restores original Work requirements on explicit continuation',async t=>{
 const {c,reopen,calls,loseEmptyThreads}=await fixture(t,{automatic:false});const w=await c.store.submit('ORIGINAL_EMPTY_REQUEST_731','ORIGINAL_EMPTY_BRIEF_731');await c.store.activate(w.id);await c.session(w.id);
 await c.store.mutate(()=>{const j=c.queueJob(w.id,'initial','original accepted input');j.status='interrupted';c.store.state.jobs.find(x=>x.id===j.id).status='interrupted';c.store.find(w.id).status='paused';});await c.stop();loseEmptyThreads();const next=await reopen();await next.send(w.id,'explicit continuation');await wait(()=>next.store.find(w.id).status==='review'&&!next.running.size);
 const prompt=calls.findLast(x=>x.type==='prompt'&&x.target===w.id).text;assert(prompt.includes('ORIGINAL_EMPTY_REQUEST_731'));assert(prompt.includes('ORIGINAL_EMPTY_BRIEF_731'));assert(prompt.includes('explicit continuation'));assert.equal(next.store.state.works.length,1);
});

;

;

;

test('取消、用户结束与迟到收尾不能结算或发布到新回合', async t => {
  const { c } = await fixture(t,{automatic:false});
  const work = await c.store.submit('cancellation source', 'bound original material');
  await c.store.activate(work.id);
  const first = await c.openManualJob(work.id, 'cancelled-round', 'first original input');
  const cancelled = c.store.state.jobs.find(j => j.id === first.jobId);
  await c.store.mutate(() => { c.store.state.jobs.find(j => j.id === first.jobId).status = 'cancelled'; });
  await c.settleManualJob(work.id, { promptId: 'cancelled-round', jobId: first.jobId, text: 'late cancelled output' });
  assert.equal(c.store.find(work.id).status, 'running');
  assert.equal(c.store.state.jobs.find(j => j.id === first.jobId).status, 'cancelled');
  assert.ok(!c.store.state.messages.some(m => m.jobId === first.jobId && m.speaker === 'agent'));
  assert.deepEqual(c.store.state.messages.filter(m => m.jobId === first.jobId && m.speaker === 'user').map(m => m.text), ['first original input']);

  // 新输入持有 current 时，旧 job 的迟到收尾不改新 Work 状态、不清新 current。
  const second = await c.openManualJob(work.id, 'current-round', 'second original input');
  await c.settleManualJob(work.id, { promptId: 'cancelled-round', jobId: first.jobId, text: 'late retry' });
  assert.equal(c.current.get(work.id).id, second.jobId);
  assert.equal(c.store.find(work.id).status, 'running');
  assert.equal(c.store.state.jobs.find(j => j.id === second.jobId).text, 'second original input');
  assert.equal(cancelled.text, 'first original input');

  // 正式用户结束合同关闭 Work；晚到发布仍走既有 publish 门，不放宽运行状态/版本校验。
  await c.store.end(work.id,dispositionIntent(c.store.find(work.id)));
  await assert.rejects(c.onTool(work.id, { tool: 'nozeli_publish', arguments: {kind: 'result', html: staticReport('late result'), files: []}, callId: 'late-after-user-end' }), /closing/);
  await c.settleManualJob(work.id, { promptId: 'current-round', jobId: second.jobId, text: 'ended turn settled' });
  assert.equal(c.store.find(work.id).status,'ended');
  assert.equal(c.store.state.receipts.filter(r => r.workId === work.id).length, 0);
  await assert.rejects(c.openManualJob(work.id, 'after-close', 'must not replay'), /active Work/);
  assert.equal(c.store.state.jobs.filter(j => j.target === work.id).length, 2);
});

test('manual admission is atomic, idempotent and role-bound without starting a native transport', async t => {
  const { c } = await fixture(t,{automatic:false});
  for (const [target, type] of [['frontdesk', 'front'], ['orchestrator', 'intake']]) {
    const opened = await c.openManualJob(target, 'role-' + target, 'manual ' + target);
    assert.equal(c.current.get(target).type, type);
    assert.equal((await c.openManualJob(target, 'role-' + target, 'manual ' + target)).jobId, opened.jobId);
    await c.settleManualJob(target, { promptId: 'role-' + target, jobId: opened.jobId, text: 'answer' });
    assert.equal(c.store.state.jobs.find(job => job.id === opened.jobId).status, 'completed');
  }
  const work = await c.store.submit('concurrent manual admission', 'original material');
  await c.store.activate(work.id);
  const outcomes = await Promise.allSettled([
    c.openManualJob(work.id, 'first', 'first input'),
    c.openManualJob(work.id, 'second', 'second input'),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(outcome => outcome.status === 'rejected').reason.message, /settlement pending/);
  const job = c.current.get(work.id);
  assert.equal(job.revision, c.store.find(work.id).revision);
  assert.deepEqual(c.store.state.messages.filter(message => message.jobId === job.id && message.speaker === 'user').map(message => message.text), [job.text]);
  assert.equal(c.store.state.jobs.filter(saved => saved.target === work.id).length, 1);
  assert.equal((await c.openManualJob(work.id, job.manualPromptId, job.text)).jobId, job.id);
});

test('manual settlement failure retains durable input and owner until same-job retry; cold recovery never replays', async t => {
  const { c, reopen, calls } = await fixture(t,{automatic:false});
  const work = await c.store.submit('manual recovery', 'preserved material');
  await c.store.activate(work.id);
  const opened = await c.openManualJob(work.id, 'durable-input', 'original manual input');
  const save = c.store.save.bind(c.store);
  c.store.save = async () => { throw Error('injected settlement disk failure'); };
  try {
    await assert.rejects(c.settleManualJob(work.id, { promptId: 'durable-input', jobId: opened.jobId, text: 'answer' }), /settlement disk failure/);
  } finally { c.store.save = save; }
  assert.equal(c.current.get(work.id).id, opened.jobId);
  assert.equal(c.store.find(work.id).status, 'running');
  assert.equal(c.store.state.jobs.find(job => job.id === opened.jobId).status, 'running');
  assert.equal(c.store.state.jobs.find(job => job.id === opened.jobId).text, 'original manual input');
  await assert.rejects(c.openManualJob(work.id, 'new-input', 'must not replace'), /settlement pending/);
  await c.settleManualJob(work.id, { promptId: 'durable-input', jobId: opened.jobId, text: 'answer' });
  await c.settleManualJob(work.id, { promptId: 'durable-input', jobId: opened.jobId, text: 'duplicate' });
  assert.equal(c.current.has(work.id), false);
  assert.equal(c.store.state.jobs.find(job => job.id === opened.jobId).status, 'completed');
  assert.equal(c.store.state.messages.filter(message => message.jobId === opened.jobId && message.speaker === 'agent').length, 1);
  const pending = await c.openManualJob(work.id, 'crash-input', 'unsettled input survives restart');
  await c.stop();
  const before = calls.filter(call => call.type === 'prompt').length;
  const next = await reopen();
  assert.equal(next.store.find(work.id).status, 'paused');
  assert.equal(next.store.state.jobs.find(job => job.id === pending.jobId).status, 'interrupted');
  assert.equal(next.store.state.jobs.find(job => job.id === pending.jobId).text, 'unsettled input survives restart');
  assert.equal(calls.filter(call => call.type === 'prompt').length, before);
});

test('manual continuation admission failure rolls back revision, job and messages together', async t => {
  const { c } = await fixture(t,{automatic:false});
  const work = await c.store.submit('manual continuation', 'original material');
  await c.store.activate(work.id);
  await c.store.mutate(() => { c.store.find(work.id).status = 'review'; });
  const before = structuredClone(c.store.find(work.id));
  const jobs = c.store.state.jobs.length, messages = c.store.state.messages.length;
  const save = c.store.save.bind(c.store);
  c.store.save = async () => { throw Error('injected admission disk failure'); };
  try {
    await assert.rejects(c.openManualJob(work.id, 'failed-continuation', 'preserve original input'), /admission disk failure/);
  } finally { c.store.save = save; }
  assert.deepEqual(c.store.find(work.id), before);
  assert.equal(c.store.state.jobs.length, jobs);
  assert.equal(c.store.state.messages.length, messages);
  assert.equal(c.current.has(work.id), false);
});

test('manual Worker document reads and recoverable edit failures preserve the active job and isolated files', async t => {
  const { c } = await fixture(t,{automatic:false});
  await fs.writeFile(path.join(c.store.content, 'source.txt'), 'baseline\n');
  const work = await c.store.submit('edit source safely', 'read and recover rejected edits');
  await c.store.activate(work.id);
  const opened = await c.openManualJob(work.id, 'document-round', 'read and edit source');
  const directory = c.execution.directory(work.id);
  const execute = (tool, callId, args) => c.onTool(work.id, { tool, callId, arguments: args });
  const active = () => {
    assert.equal(c.current.get(work.id).id, opened.jobId);
    assert.equal(c.store.find(work.id).status, 'running');
    assert.equal(c.store.state.jobs.find(job => job.id === opened.jobId).status, 'running');
  };
  const read = await execute('nozeli_document_read', 'read-baseline', { relPath: 'source.txt' });
  assert.equal(read.ok, true);
  assert.equal(read.value.text, 'baseline\n');
  const foreign = await execute('nozeli_document_apply', 'foreign-handle', { readHandle: 'not-current', edits: [{ from: 0, to: 0, insert: 'bad' }] });
  assert.equal(foreign.error.code, 'READ_HANDLE_REJECTED'); active();
  await fs.writeFile(path.join(directory, 'source.txt'), 'new baseline\n');
  const stale = await execute('nozeli_document_apply', 'stale-baseline', { readHandle: read.value.readHandle, edits: [{ from: 0, to: 0, insert: 'bad' }] });
  assert.equal(stale.error.code, 'STALE_VERSION'); active();
  const current = await execute('nozeli_document_read', 'read-current', { relPath: 'source.txt' });
  const invalid = await execute('nozeli_document_apply', 'invalid-range', { readHandle: current.value.readHandle, edits: [{ from: -1, to: 0, insert: 'bad' }] });
  assert.equal(invalid.error.code, 'INVALID_EDIT'); active();
  const escaping = await execute('nozeli_document_read', 'escaping-read', { relPath: '../outside.txt' });
  assert.equal(escaping.ok, false); active();
  const applied = await execute('nozeli_document_apply', 'safe-edit', { readHandle: current.value.readHandle, edits: [{ from: 0, to: 0, insert: 'verified ' }] });
  assert.equal(applied.ok, true); active();
  assert.equal(await fs.readFile(path.join(directory, 'source.txt'), 'utf8'), 'verified new baseline\n');
  assert.equal(await fs.readFile(path.join(c.store.content, 'source.txt'), 'utf8'), 'baseline\n');
});


test('accepted input failure persists before failed native stop and retains unconfirmed owner', async t => {
  const { c } = await fixture(t);
  const session = c.sessions.get('frontdesk'), originalStop = session.stop.bind(session);
  const hold = Object.assign(Error('collab-close-failed'), { code: 'OMP_COLLAB_HOLD' });
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  session.prompt = async () => { throw Object.assign(Error('provider 502 Upstream access forbidden'), { code: 'OMP_TURN_ERROR' }); };
  session.stop = async () => { entered(); await gate; throw hold; };
  try {
    await c.send('frontdesk', 'light preserve exact accepted input');
    await waiting;
    const saved = c.store.state.jobs.at(-1);
    assert.equal(saved.status, 'failed');
    assert.equal(saved.text, 'light preserve exact accepted input');
    assert.equal(saved.error, 'provider 502 Upstream access forbidden');
    assert.ok(c.store.state.messages.some(message => message.jobId === saved.id && message.speaker === 'system' && message.text.includes('Upstream access forbidden')));
    const owner = structuredClone(c.store.state.providers.frontdesk);
    release();
    await wait(() => !c.running.size && Boolean(c.store.state.jobs.at(-1).cleanupFailure));
    assert.equal(c.store.state.jobs.at(-1).status, 'failed');
    assert.deepEqual(c.store.state.providers.frontdesk, owner);
    assert.deepEqual(c.store.state.jobs.at(-1).cleanupFailure.stages, [{ stage: 'native-stop', category: 'collab-hold' }]);
    assert.equal(c.store.state.jobs.at(-1).cleanupFailure.exitConfirmed, false);
  } finally { release(); session.stop = originalStop; }
});

test('late cancelled input remains cancelled while failed cleanup evidence is retained', async t => {
  const { c } = await fixture(t);
  const session = c.sessions.get('frontdesk'), originalStop = session.stop.bind(session);
  session.prompt = async () => {
    await c.store.mutate(() => { c.store.state.jobs.at(-1).status = 'cancelled'; });
    throw Error('late provider failure');
  };
  session.stop = async () => { throw Object.assign(Error('private callback failure'), { code: 'OMP_COLLAB_HOLD' }); };
  try {
    await c.send('frontdesk', 'light cancelled accepted input');
    await wait(() => !c.running.size && Boolean(c.store.state.jobs.at(-1).cleanupFailure));
    const saved = c.store.state.jobs.at(-1);
    assert.equal(saved.status, 'cancelled');
    assert.equal(saved.error, undefined);
    assert.equal(c.store.state.messages.some(message => message.jobId === saved.id && message.speaker === 'system'), false);
    assert.equal(JSON.stringify(saved.cleanupFailure).includes('private'), false);
  } finally { session.stop = originalStop; }
});
test('manual settlement retains the admitted ticket model, not the owner selection after defaults change',async t=>{
 const {c}=await fixture(t),opened=await c.openManualJob('frontdesk','model-evidence','original manual input');
 c.sessions.get('frontdesk').effective={model:'new/default',effort:'high'};
 await c.settleManualJob('frontdesk',{promptId:'model-evidence',jobId:opened.jobId,text:'answer',effective:{model:'admitted/model',effort:'low'}});
 assert.deepEqual(c.store.state.jobs.find(job=>job.id===opened.jobId).effective,{model:'admitted/model',effort:'low'});
 await c.settleManualJob('frontdesk',{promptId:'model-evidence',jobId:opened.jobId,effective:{model:'new/default'}});
 assert.deepEqual(c.store.state.jobs.find(job=>job.id===opened.jobId).effective,{model:'admitted/model',effort:'low'});
});
test('nozeli_publish 字段由 kind 决定：problem 收 Markdown text，result 收 html，互斥不嗅探',async t=>{
 const {c,root}=await fixture(t,{automatic:false});
 const work=await c.store.submit('publish field contract','bound original material');
 await c.store.activate(work.id);
 const session=await c.session(work.id);
 const first=await c.openManualJob(work.id,'publish-round','first original input');
 const publish=(arguments_,callId)=>c.onTool(work.id,{tool:'nozeli_publish',arguments:arguments_,callId});
 await assert.rejects(publish({kind:'problem',html:staticReport('html question'),files:[]},'reject-problem-html'),/publication requires kind/);
 await assert.rejects(publish({kind:'result',text:'# markdown result',files:[]},'reject-result-text'),/publication requires kind/);
 await assert.rejects(publish({kind:'problem',text:'选择？',html:staticReport('both fields'),files:[]},'reject-both-fields'),/publication requires kind/);
 await assert.rejects(publish({kind:'notice',text:'body',files:[]},'reject-kind'),/invalid publication kind/);
 await assert.rejects(publish({kind:'problem',text:'q',files:[],unexpected:true},'reject-extra-key'),/publication requires kind/);
 assert.deepEqual(c.store.state.receipts.filter(r=>r.workId===work.id),[]);
 const question='# 请选择数据源\n\n已完成基础核对。继续用 notes.txt 还是改为数据库？\n';
 const published=await publish({kind:'problem',text:question,files:[]},'problem-text-receipt');
 assert.equal(published.saved,true);assert.equal(published.kind,'problem');assert.equal(published.duplicate,undefined);
 const receipt=c.store.state.receipts.find(r=>r.id==='problem-text-receipt');
 assert.equal(receipt.report.format,'markdown');assert.equal(receipt.report.manifestDigest,null);
 assert.equal((await c.store.readObject(receipt.report.digest).then(bytes=>bytes.toString('utf8'))),question);
 const replay=await publish({kind:'problem',text:question,files:[]},'problem-text-receipt');
 assert.equal(replay.duplicate,true);assert.equal(replay.object,receipt.objectId);
 await assert.rejects(publish({kind:'problem',text:question+'\n改动后的重放',files:[]},'problem-text-receipt'),/receipt collision/);
 await c.settleManualJob(work.id,{promptId:'publish-round',jobId:first.jobId,text:'question asked'});
 assert.equal(c.store.find(work.id).status,'paused');
 await c.store.continue(work.id);
 const second=await c.openManualJob(work.id,'result-round','user answer');
 const result=await publish({kind:'result',html:staticReport('最终结论已核对'),files:[]},'result-html-receipt');
 assert.equal(result.saved,true);
 const resultReceipt=c.store.state.receipts.find(r=>r.id==='result-html-receipt');
 assert.equal(resultReceipt.report.format,'html-static');
 assert.ok((await c.store.readObject(resultReceipt.report.digest)).length>0);
 assert.ok(JSON.parse((await c.store.readObject(resultReceipt.report.manifestDigest)).toString('utf8')));
 await c.settleManualJob(work.id,{promptId:'result-round',jobId:second.jobId,text:'final answer delivered'});
 assert.equal(c.store.find(work.id).status,'review');
 const problemAfter=structuredClone(c.store.state.receipts.find(r=>r.id==='problem-text-receipt').report);
 assert.deepEqual(problemAfter,receipt.report);
 assert.equal((await c.store.readObject(receipt.report.digest).then(bytes=>bytes.toString('utf8'))),question);
 // 工具 schema 以 oneOf 显式表达字段合同；schema 变化经既有 toolsDigest 门，不自动重开线程。
 const publishTool=session.tools.find(entry=>entry.name==='nozeli_publish');
 assert.deepEqual(publishTool.inputSchema.oneOf.map(branch=>({required:branch.required,forbidden:branch.not.required})),[{required:['html'],forbidden:['text']},{required:['text'],forbidden:['html']}]);
 assert.deepEqual(publishTool.inputSchema.required,['kind','files']);
});
