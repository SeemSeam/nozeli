import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openTestWorkspace,openTestController,readTestState} from './project-storage.fixture.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {dispositionBinding,workDisposition} from '../src/domain/work-disposition.mjs';
import {migrateReviewLifecycle} from '../src/agents/managed/review-lifecycle.mjs';
import {workSlotFacts} from '../src/agents/managed/workspace.mjs';
import {restoreExecutionIntents} from '../src/agents/managed/restart-recovery.mjs';
import {workControlHeldFor} from '../src/agents/managed/work-control.mjs';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'durable-review-')),runtime=path.join(root,'runtime'),content=path.join(root,'content');
 let store=await openTestWorkspace(runtime,content);t.after(async()=>{if(!store.closed)await store.close();await fs.rm(root,{recursive:true,force:true});});
 const submitted=await store.submit('review me','brief');await store.activate(submitted.id);const work=store.find(submitted.id);
 await store.mutate(()=>{work.status='review';store.state.jobs=[];store.state.providers={};store.state.drafts={[work.id]:'unsent'};});
 return {get store(){return store;},work,reopen:async()=>{await store.close();store=await openTestWorkspace(runtime,content);return store;}};
}
test('never reviewed work and unsent draft survive repeated cold opens without acquiring a decision',async t=>{
 const f=await fixture(t);
 for(let i=0;i<3;i++){const store=await f.reopen();await store.mutate(()=>migrateReviewLifecycle(store.state));const w=store.find(f.work.id);assert.equal(w.status,'review');assert.equal(w.closure,undefined);assert.equal(w.endedAt,undefined);assert.equal(store.state.drafts[w.id],'unsent');assert.equal(store.used(),1);}
});
test('accepted blocked closure survives cold open with immutable identity and quota held',async t=>{
 const f=await fixture(t),w=f.work;
 await f.store.end(w.id,{by:'user',decision:'accept',revision:w.revision,binding:dispositionBinding(w),requestKey:'review-request-1'});
 await f.store.mutate(()=>{w.closure.phase='blocked';w.closure.error='permission held';});
 const before=structuredClone(w.closure),store=await f.reopen();await store.mutate(()=>migrateReviewLifecycle(store.state));
 const current=store.find(w.id);assert.equal(current.status,'closing');assert.deepEqual(current.closure,before);assert.equal(current.endedAt,undefined);assert.equal(store.used(),1);assert.equal(workDisposition(store.state,current).retryClosure.allowed,true);
 const c=new Controller(store);c.drainMergeQueue=async()=>{};c.advanceClosure=async()=>{};
 await assert.rejects(c.retryClosure(w.id,{requestKey:'new-retry-operation',binding:{...before.binding,revision:99}}),/immutable/);
 await c.retryClosure(w.id,{requestKey:'new-retry-operation',binding:before.binding});
 const {retryRequests,...original}=current.closure;assert.deepEqual(original,before);assert.equal(retryRequests[0].authorizationRequestKey,before.requestKey);
});
test('legacy proven incomplete migrates, ambiguous labels remain fenced, complete history stays terminal',()=>{
 const proven={id:'proven',revision:1,status:'ended',outcome:'accept',endedAt:'old',closure:{decision:'accept',revision:1,requestKey:'original-key',phase:'blocked'}};proven.closure.binding=dispositionBinding(proven);
 const ambiguous={id:'ambiguous',revision:1,status:'ended',endedBy:'user',closure:{phase:'blocked',decision:'accept'}};
 const complete={id:'complete',revision:1,status:'ended',endedAt:'actual',closure:{phase:'complete'}};
 const state={works:[proven,ambiguous,complete],todos:[]};migrateReviewLifecycle(state);
 assert.equal(proven.status,'closing');assert.equal(proven.endedAt,undefined);assert.equal(proven.legacyEndedAt,'old');assert.equal(complete.endedAt,'actual');assert.equal(complete.status,'ended');assert.ok(ambiguous.needsReconciliation);assert.equal(workDisposition(state,ambiguous).retryClosure.allowed,false);assert.equal(workDisposition(state,ambiguous).accept.allowed,false);
 const snapshot=structuredClone(state);migrateReviewLifecycle(state);assert.deepEqual(state,snapshot);assert.equal(workSlotFacts(state.works).used,2);
});
test('only complete host finalization marks ended, archive failure retains closing and slot',async t=>{
 const f=await fixture(t),store=f.store,w=f.work;
 await store.end(w.id,{by:'user',decision:'discard',revision:w.revision,binding:dispositionBinding(w),requestKey:'discard-request-1'});
 const c=new Controller(store),visible=[];c.changed=()=>visible.push({status:w.status,phase:w.closure.phase,stopped:w.closure.stopped===true,gitComplete:w.closure.git?.complete===true});c.kick=()=>{};c.timeline={drain:async()=>{}};
 c.execution={finish:async()=>({cleaned:true,status:'discarded'})};store.archiveReport=async()=>{};store.cleanupWorkerHome=async()=>{};
 let fail=true;store.updateClosureArchive=async()=>{if(fail)throw Object.assign(Error('archive unavailable'),{code:'MERGE_CONSENT_REQUIRED'});};
 await c.finishClosure(w.id);assert.equal(w.status,'closing');assert.equal(w.closure.phase,'blocked');assert.equal(w.endedAt,undefined);assert.equal(store.used(),1);
 fail=false;await c.finishClosure(w.id);assert.equal(w.status,'ended');assert.equal(w.closure.phase,'complete');assert.equal(w.endedAt,w.closure.completedAt);assert.equal(store.used(),0);
 assert(visible.some(f=>f.phase==='stopping'&&f.status==='closing'&&!f.stopped),'stop progress is published before the stop completes');
 assert(visible.some(f=>f.phase==='report'&&f.stopped&&!f.gitComplete),'verified stop and pending report/integration are visible');
 assert(visible.some(f=>f.phase==='integrating'&&f.status==='closing'&&!f.gitComplete),'integration is not presented as complete in advance');
 assert(visible.some(f=>f.phase==='cleanup'&&f.status==='closing'&&f.gitComplete),'integration completion does not hide remaining cleanup');
 assert(visible.some(f=>f.phase==='blocked'&&f.status==='closing'),'failed final archival remains visibly blocked');
 assert(visible.some(f=>f.phase==='complete'&&f.status==='ended'),'only final durable closure publishes ended');
});

test('restart admits only unsent queue normally and preserves original native recovery identity and manual pause',()=>{
 const state={works:[{id:'worker',status:'running',revision:2,threadId:'same-thread'},{id:'paused',status:'running',revision:1,manualControl:{pause:{requestKey:'explicit-pause'}}},{id:'review',status:'review',revision:1}],residents:{orchestrator:{threadId:'same-orchestrator'}},jobs:[
  {id:'queued',target:'worker',status:'queued',revision:2,promptStartedAt:null},
  {id:'admitted',target:'orchestrator',context:{boundWorkId:'worker'},status:'running',revision:1,promptStartedAt:1,collabAttempts:[{kind:'prompt',requestId:'request',sessionId:'same-orchestrator',nativeEntryId:'entry',everAdmitted:true}],restartRecovery:{expectedLeafId:'leaf',recoveryAttemptId:'recovery'}},
  {id:'held',target:'paused',status:'queued',revision:1,promptStartedAt:null},
  {id:'old-failure',target:'worker',status:'failed',error:'old failure'},
  {id:'review-held',target:'review',status:'queued',promptStartedAt:null},
  {id:'stopped',target:'worker',status:'interrupted',revision:2,interruptionReason:'host-stopped',promptStartedAt:1}
 ]};
 restoreExecutionIntents(state);
 assert.equal(state.jobs[0].status,'queued');assert.equal(state.jobs[0].restartRecovery.kind,'never-admitted');
 assert.equal(state.jobs[1].status,'queued');assert.equal(state.jobs[1].restartRecovery.kind,'native-continuation');assert.equal(state.jobs[1].restartRecovery.threadId,'same-orchestrator');assert.equal(state.jobs[1].restartRecovery.expectedLeafId,'leaf');assert.equal(state.jobs[1].restartRecovery.recoveryAttemptId,'recovery');
 assert.notEqual(state.jobs[1].restartRecovery.threadId,state.works[0].threadId);assert.equal(state.jobs[1].context.boundWorkId,'worker');assert.equal(state.jobs[1].collabAttempts[0].sessionId,state.jobs[1].restartRecovery.threadId);
 assert.equal(workControlHeldFor(state,state.jobs[2]),true);assert.equal(state.works[1].manualControl.pause.requestKey,'explicit-pause');assert.equal(state.jobs[3].status,'failed');assert.equal(state.jobs[4].status,'interrupted');assert.equal(state.works[2].status,'review');assert.equal(state.jobs[5].restartRecovery.kind,'native-continuation');
 const saved=structuredClone(state);restoreExecutionIntents(state);assert.deepEqual(state,saved);
});

test('localOnly production promotion restores persisted jobs once before any scheduling',async t=>{
 const f=await fixture(t),store=f.store,id=f.work.id;
 await store.mutate(()=>{store.find(id).status='running';store.state.jobs=[{id:'unsent-intake',target:'orchestrator',type:'intake',status:'running',promptStartedAt:null,context:{}}];});
 const options={runtimeRoot:store.root,contentRoot:store.content,localOnly:true};await store.close();
 const c=await openTestController(options);try{
 assert.equal(c.localOnly,true);assert.equal(c.store.state.jobs[0].status,'running');assert.equal(c.sessions.size,0);
 await Promise.all([c.prepareOnline(),c.prepareOnline()]);
 assert.equal(c.localOnly,false);assert.equal(c.store.state.jobs[0].status,'queued');assert.equal(c.store.state.jobs[0].restartRecovery.kind,'never-admitted');
 assert.equal(c.store.state.recoveryEvents.filter(row=>row.type==='host-opened').length,1);assert.equal(c.sessions.size,0);
 await c.prepareOnline();assert.equal(c.store.state.recoveryEvents.filter(row=>row.type==='host-opened').length,1);
 }finally{if(!c.store.closed)await c.stop();}
});

test('verified native user entry and original attempt identity commit together before prompt completion',async t=>{
 const f=await fixture(t),store=f.store;
 await store.mutate(()=>{store.state.jobs=[{id:'native-midturn',target:'orchestrator',status:'running',context:{},promptStartedAt:1,collabAttempts:[{kind:'prompt',requestId:'original-request',sessionId:'original-session',epoch:'original-epoch',status:'admitted',everAdmitted:true}]}];});
 const c=new Controller(store);await c.timeline.initialize();
 const fact={jobId:'native-midturn',requestId:'original-request',sessionId:'original-session',epoch:'original-epoch',entry:{type:'message',id:'original-user-entry',parentId:null,message:{role:'user',content:[{type:'text',text:'Exact original user input'}]}}};
 await assert.rejects(c.recordNativeEntries('orchestrator',{...fact,epoch:'wrong-epoch'}),{code:'TIMELINE_OWNER'});
 assert.equal(store.state.jobs[0].collabAttempts[0].nativeEntryId,undefined);
 await c.recordNativeEntries('orchestrator',fact);clearTimeout(c.timelineTimer);
 const saved=await readTestState(store),attempt=saved.jobs[0].collabAttempts[0];
 assert.equal(saved.jobs[0].status,'running');assert.equal(attempt.status,'admitted');assert.equal(attempt.nativeEntryId,'original-user-entry');assert.equal(attempt.nativeUserEntryConfirmed,true);assert.equal(attempt.recordConfirmed,undefined);
 assert.equal(saved.sessionIndex.entries.find(row=>row.entryId==='original-user-entry').ownership,'verified');
});
