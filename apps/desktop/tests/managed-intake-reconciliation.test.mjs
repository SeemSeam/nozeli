import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/agents/managed/controller.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {restoreExecutionIntents} from '../src/agents/managed/restart-recovery.mjs';
import {assertUnroutedIntake,intakeReconciliation,withdrawIntakeState} from '../src/agents/managed/intake-reconciliation.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openTestWorkspace} from './project-storage.fixture.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';

const input=(id,overrides={})=>({type:'intake',target:'orchestrator',id,status:'queued',promptStartedAt:null,text:'frozen input',context:{},...overrides});
const projectInstanceId='project-instance';
const facts={kind:'prompt',requestId:'native-request',sessionId:'native-session',epoch:'native-epoch',status:'native-record-confirmed',everAdmitted:true};

test('cold intake reads back committed routes and admits only positively unsent original jobs',()=>{
 const accepted=input('admitted',{status:'running',promptStartedAt:42,collabAttempts:[structuredClone(facts)]});
 const committed=input('committed',{status:'running',promptStartedAt:43,routing:{action:'dispatch',workId:'w1'}});
 const workOnly=input('work-only',{status:'queued',promptStartedAt:44});
 const queued=input('unsent');
 const clone=input('historical-clone',{context:{retryOf:accepted.id}});
 const ambiguous=input('legacy',{promptStartedAt:undefined,restartRecovery:{kind:'never-admitted'}});
 const withdrawn=input('withdrawn',{status:'queued',intakeWithdrawal:{projectInstanceId,at:'2026-11-23'}});
 const state={jobs:[accepted,committed,workOnly,queued,clone,ambiguous,withdrawn],works:[{id:'w1',sourceJob:committed.id},{id:'w2',sourceJob:workOnly.id}],sessionIndex:{entries:[{...facts,jobId:accepted.id,target:'orchestrator',speaker:'user',ownership:'verified',entryId:'native-entry'}]}};
 for(let startup=0;startup<2;startup++){
  restoreExecutionIntents(state);
  assert.deepEqual(state.jobs.map(job=>job.status),['interrupted','completed','completed','queued','interrupted','interrupted','cancelled']);
  assert.equal(accepted.restartRecovery.kind,'needs-reconciliation');
  assert.equal(queued.restartRecovery.kind,'never-admitted');
  assert.equal(intakeReconciliation(state,workOnly.id,{projectInstanceId}).route.workId,'w2');
 }
 const view=intakeReconciliation(state,accepted.id,{projectInstanceId});
 assert.equal(view.requestId,facts.requestId);assert.equal(view.nativeEntryId,'native-entry');assert.equal(view.nativeSessionId,facts.sessionId);
 assert.equal(view.effectUnknown,true);assert.equal(view.status,'needs-reconciliation');
});

test('legacy retry endpoint denies cloning but retains stop-only transfer operation',async()=>{
 const original=input('failed',{status:'failed',promptStartedAt:1});
 const transfer=input('transfer',{status:'transferring'});
 const ids=[];
 const receiver={store:{state:{jobs:[original,transfer],works:[]}},requestTransferStop:async id=>ids.push(id)};
 const managed={host:{requireProject:async()=>({id:'project'})},controller:()=>({retryIntake:Controller.prototype.retryIntake.bind(receiver)})};
 await assert.rejects(ManagedProjects.prototype.invoke.call(managed,'managed.intake.retry',{projectId:'project',jobId:original.id,requestKey:'legacy-direct-ipc-key'}),{code:'INTAKE_REPLAY_FORBIDDEN'});
 await assert.rejects(Controller.prototype.retryIntake.call(receiver,original.id,'new-request-key'),{code:'INTAKE_REPLAY_FORBIDDEN'});
 const receipt=await Controller.prototype.retryIntake.call(receiver,transfer.id,'new-transfer-key');
 assert.deepEqual(receipt,{accepted:true,jobId:transfer.id,transferring:true});
 assert.deepEqual(ids,[transfer.id]);assert.equal(receiver.store.state.jobs.length,2);
});

test('exact intake API binds current instance and returns no request or transcript body',async()=>{
 const original=input('failed',{status:'failed',promptStartedAt:4,errorCode:'INTAKE_ROUTE_REQUIRED',error:'body only in original ledger'});
 const state={jobs:[original],works:[]};
 const controller={intakeWithdraw:(id,instance)=>withdrawIntakeState(state,id,{projectInstanceId:instance})};
 const ledger={requests:[{id:'r1',sourceJobId:original.id,status:'denied',frozenEffect:{command:'not projected'}},{id:'other',sourceJobId:'other-job',status:'pending'}],grants:[],executions:[]};
 const receiver={host:{requireRegisteredProject:async()=>({instanceId:projectInstanceId}),storage:{getLocal:async()=>ledger,recoveryPage:async()=>({entries:[]}),withProjectOperation:(_id,fn)=>fn(),assertActive:()=>{}}},controllers:new Map([['project',controller]]),projectionSource:async()=>({state,store:{offline:false}})};
 const invoke=(op,extra={})=>ManagedProjects.prototype.invoke.call(receiver,'managed.intake.'+op,{projectId:'project',jobId:original.id,...extra});
 const view=await invoke('reconcile');assert.equal(view.projectInstanceId,projectInstanceId);assert.equal(view.canWithdraw,true);
 assert.deepEqual(view.effects.requests,[{id:'r1',status:'denied'}]);
 assert.equal(view.errorCode,'INTAKE_ROUTE_REQUIRED');assert.equal(JSON.stringify(view).includes(original.text),false);assert.equal(JSON.stringify(view).includes(original.error),false);
 await assert.rejects(invoke('withdraw'),{code:'INVALID_PAYLOAD'});
 await assert.rejects(invoke('withdraw',{projectInstanceId:'stale'}),{code:'INTAKE_PROJECT_STALE'});
 const response=await invoke('withdraw',{projectInstanceId});assert.equal(response.status,'withdrawn');assert.equal(response.effectUnknown,true);
 assert.deepEqual(await invoke('withdraw',{projectInstanceId}),response);
 assert.equal(original.errorCode,'INTAKE_ROUTE_REQUIRED');assert.equal(original.status,'failed');assert.equal(state.jobs.length,1);
 assert.throws(()=>assertUnroutedIntake(state,original,{dispatch:true}),{code:'INTAKE_RECONCILIATION_REQUIRED'});
});

test('historical completed status is a receipt, not a withdrawable intake',()=>{
 const original=input('status',{status:'completed',routing:{action:'status'}});
 assert.equal(intakeReconciliation({jobs:[original]},original.id,{projectInstanceId}).status,'routed');
 assert.throws(()=>withdrawIntakeState({jobs:[original]},original.id,{projectInstanceId}),{code:'INTAKE_WITHDRAWAL_BLOCKED'});
});

test('cold unknown business outcome fences withdrawal and native admission',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-intake-cold-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const runtime=path.join(root,'runtime'),content=path.join(root,'project');
 const initial=await openTestWorkspace(runtime,content);
 const {storage,projectId,projectInstanceId}=initial;
 const original=input('cold');
 try{await initial.mutate(()=>{initial.state.jobs=[original];});}finally{await initial.close();}
 await storage.putRecovery(projectId,'managed:pending:unconfirmed',{kind:'business',status:'prepared',projectId});
 const receiver={host:{storage,requireRegisteredProject:()=>storage.requireRegistered(projectId)},controllers:new Map(),projectionSource:async()=>({state:{jobs:[original]},store:{offline:false}})};
 const view=await ManagedProjects.prototype.invoke.call(receiver,'managed.intake.reconcile',{projectId,jobId:original.id});
 assert.equal(view.errorCode,'STORAGE_RESULT_UNKNOWN');assert.equal(view.canWithdraw,false);
 const reopened=await Workspace.open(runtime,content,{storage,projectId});
 try{
  await assert.rejects(reopened.requireOnline(),{code:'STORAGE_RESULT_UNKNOWN'});
  await assert.rejects(reopened.mutate(()=>withdrawIntakeState(reopened.state,original.id,{projectInstanceId})),{code:'STORAGE_RESULT_UNKNOWN'});
  assert.equal(reopened.state.jobs[0].intakeWithdrawal,undefined);
 }finally{await reopened.close();}
});

test('same-lineage dispatch cannot bypass a committed receipt or a withdrawal',()=>{
 const root=input('root',{routing:{action:'clarify',question:'Which scope?'}});
 const first=input('first',{context:{routingQuestionId:'question'}});
 const second=input('second',{context:{routingQuestionId:'question'}});
 const state={jobs:[root,first,second],works:[],todos:[{id:'question',kind:'routing',sourceJobId:root.id}]};
 assert.doesNotThrow(()=>assertUnroutedIntake(state,first,{dispatch:true}));
 first.routing={action:'dispatch',workId:'existing'};
 assert.throws(()=>assertUnroutedIntake(state,second,{dispatch:true}),{code:'INTAKE_RECONCILIATION_REQUIRED'});
 assert.throws(()=>withdrawIntakeState(state,first.id,{projectInstanceId}),{code:'INTAKE_WITHDRAWAL_BLOCKED'});
 assert.throws(()=>withdrawIntakeState(state,second.id,{projectInstanceId,storageBlocked:true}),{code:'INTAKE_WITHDRAWAL_BLOCKED'});
});

test('an approved continuation into existing Work blocks withdrawal of the original',()=>{
 const original=input('original',{status:'completed',text:'Frozen supplement',context:{softWorkHint:true},intakePermissionWait:{requestId:'approved'}});
 const child=input('continuation',{status:'completed',text:'Generated approval notice',context:{softWorkHint:true,effectSourceJobId:original.id,effectRequestId:'approved'},routing:{action:'continue',workId:'existing'}});
 const work={id:'existing',inputs:[{sourceJobId:child.id,sourceInputJobIds:[original.id,child.id]}]};
 const state={jobs:[original,child],works:[work]};
 assert.deepEqual(Controller.prototype.intakeSource.call({store:{state}},child),{request:'Frozen supplement',sourceInputJobIds:[original.id,child.id],imageAttachments:[]});
 for(const works of [[work],[]]){
  state.works=works;
  assert.equal(intakeReconciliation(state,original.id,{projectInstanceId}).route.workId,work.id);
  assert.throws(()=>withdrawIntakeState(state,original.id,{projectInstanceId}),{code:'INTAKE_WITHDRAWAL_BLOCKED'});
 }
});
