import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {ProjectLifecycle} from '../src/main/project-lifecycle.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';

// Regression for the stale persisted remove hold: a previous remove that
// failed after its 'prepared' journal checkpoint leaves a persisted
// lifecycle_holds row plus a needs-attention journal (the field incident:
// action remove, failedPhase prepared, PROJECT_LIFECYCLE_ACTIVE). Cold
// restarts keep ordinary writes locked, and an explicit second remove — and
// only that entry — may clear the hold by first walking the existing
// observation-only reconcile (verify stop stability) and only then removing
// the entry under a fresh operationId. Sources, journals and pending business
// are never deleted or replayed, and nothing auto-releases for other actions,
// foreign instances or journals, in-flight operations or pending stops.

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const OLD_OPERATION_ID='e8cd9c4e-11f2-47f8-8650-bde8a7960381';
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-stale-remove-hold-'));
 const root=path.join(directory,'project');await fs.mkdir(root);await fs.writeFile(path.join(root,'source.txt'),'retained source\n');
 const storage=new ProjectStorage(path.join(directory,'profile')),project=await storage.register(root);
 const host={storage,requireProject:id=>storage.requireOnline(id),requireRegisteredProject:id=>storage.requireRegistered(id)};
 const managed=new ManagedProjects({userDataDir:path.join(directory,'profile'),host,legacy:{projects:new Map()}});
 const closed=[];
 const workspace={closeProject:async(id,{operationId})=>{
  // Production close flushes cross-process; this unit verifies only its host owner scope.
  await storage.requireOnline(id);await storage.putProject(id,'fixture','flush',{retained:true});closed.push(operationId);return {closed:true};
 }};
 const manager=new ProjectLifecycle({host,managed,workspace,trashItem:()=>{throw Error('remove entry must never trash');}});
 const cleanups=[async()=>{await managed.stop();await storage.db.close();await fs.rm(directory,{recursive:true,force:true});}];
 t.after(async()=>{for(const cleanup of cleanups)await cleanup();});
 return {directory,root,storage,project,host,managed,workspace,closed,manager,cleanups};
}
async function controller(f){
 const c=await Controller.open({storage:f.storage,projectId:f.project.id,runtimeRoot:path.join(await f.storage.localDirectory(f.project.id),'execution'),contentRoot:f.root,localOnly:true});
 f.managed.controllers.set(f.project.id,c);return c;
}
const pendingBusiness=nonce=>({schema:1,kind:'business',status:'pending',automaticReplay:false,collections:{managed_jobs:[{id:'never-replay-'+nonce,value:{text:'synthetic held input '+nonce}}]}});
// Persist the exact field shape of the incident: a hold left behind by a
// remove whose journal stopped at needs-attention/failedPhase prepared. Every
// identity field of the real journal is reproduced here.
async function seedStaleHold(f,{action='remove',instanceId=f.project.instanceId,needsStopCheck=true,journal=true,oldOperationId=OLD_OPERATION_ID,journalOverride}={}){
 const hold=f.storage.holdProject(f.project.id,{operationId:oldOperationId,instanceId,action});
 hold.needsStopCheck=needsStopCheck;await f.storage.persistProjectHold(f.project.id,hold);
 if(journal){
  const record={schema:1,projectId:f.project.id,operationId:oldOperationId,instanceId,action,root:f.project.root,phase:'needs-attention',failedPhase:'prepared',error:{code:'PROJECT_LIFECYCLE_ACTIVE',message:'项目正在停用或等待停稳核查；未接受新操作。'},updatedAt:'2026-10-26T12:21:17.000Z'};
  await f.storage.putRecovery(f.project.id,'lifecycle:'+oldOperationId,{...record,...journalOverride});
 }
 return hold;
}
// Reopen the profile the way a real restart does and rebuild the process-wide
// services around the cold storage; no controller survives the restart.
async function coldRestart(f){
 const profile=path.join(f.directory,'profile');
 await f.storage.db.close();
 const storage=new ProjectStorage(profile);
 const host={storage,requireProject:id=>storage.requireOnline(id),requireRegisteredProject:id=>storage.requireRegistered(id)};
 const managed=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()}});
 const closed=[];
 const workspace={closeProject:async(id,{operationId})=>{await storage.requireOnline(id);await storage.putProject(id,'fixture','flush',{retained:true});closed.push(operationId);return {closed:true};}};
 const manager=new ProjectLifecycle({host,managed,workspace,trashItem:()=>{throw Error('remove entry must never trash');}});
 f.cleanups.unshift(async()=>{await managed.stop();await storage.db.close();});
 return {storage,host,managed,workspace,manager,closed};
}
async function reloadHolds(f){
 const peek=new ProjectStorage(path.join(f.directory,'profile'));
 try{await peek.requireRegistered(f.project.id);return [...peek.lifecycleHolds.entries()];}
 finally{await peek.db.close();}
}

test('a cold persisted remove hold with its needs-attention journal is cleared only by an explicit second remove that first verifies stop stability',async t=>{
 const f=await fixture(t),pending=pendingBusiness('cold');
 await f.storage.putRecovery(f.project.id,'managed:pending:preserved-cold',pending);
 await seedStaleHold(f);
 // Restart: the hold loads from the catalog before any capability is issued.
 const cold=await coldRestart(f);
 const [[coldId,loaded]]=await reloadHolds(f);
 assert.equal(coldId,f.project.id);assert.equal(loaded.action,'remove');assert.equal(loaded.operationId,OLD_OPERATION_ID);assert.equal(loaded.instanceId,f.project.instanceId);assert.equal(loaded.needsStopCheck,true);assert.equal(loaded.pendingCount,0);
 const stops=[];const nativeStop=cold.managed.stopProject.bind(cold.managed);
 cold.managed.stopProject=(id,options)=>{stops.push({id,held:Boolean(cold.storage.lifecycleHolds.get(id)),options});return nativeStop(id,options);};
 // Ordinary writes stay locked under the persisted hold.
 await assert.rejects(cold.storage.putProject(f.project.id,'fixture','new',{bad:true}),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 await assert.rejects(cold.storage.withProjectOperation(f.project.id,()=>cold.storage.requireOnline(f.project.id)),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 const result=await cold.manager.removeProject(f.project.id,{operationId:'remove-after-cold-hold'});
 assert.equal(result.removed,true);
 // Stop stability was verified under the surviving old hold, before any
 // release; only then the fresh remove run stops under its own new hold.
 assert.equal(stops.length,2);
 assert.equal(stops[0].id,f.project.id);assert.equal(stops[0].held,true);assert.equal(stops[0].options?.lifecycleHold?.operationId,OLD_OPERATION_ID);
 assert.equal(stops[1].options?.lifecycleHold?.operationId,'remove-after-cold-hold');
 assert.equal(cold.closed.length,1);assert.equal(cold.closed[0],'remove-after-cold-hold');
 assert.equal((await cold.storage.requireRegistered(f.project.id)).removed,true);
 assert.equal(cold.storage.lifecycleHolds.has(f.project.id),false);
 // Source, journal and pending business are preserved untouched; no replay.
 assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'retained source\n');
 assert.deepEqual(await cold.storage.getRecovery(f.project.id,'managed:pending:preserved-cold'),pending);
 const journal=await cold.storage.getRecovery(f.project.id,'lifecycle:'+OLD_OPERATION_ID);
 assert.equal(journal.phase,'needs-attention');assert.equal(journal.action,'remove');
 assert.equal(journal.projectId,f.project.id);assert.equal(journal.instanceId,f.project.instanceId);assert.equal(journal.operationId,OLD_OPERATION_ID);
 assert.equal((await cold.storage.getRecovery(f.project.id,'lifecycle:remove:remove-after-cold-hold')).complete,true);
 // The second remove is idempotent through its persisted receipt.
 assert.deepEqual(await cold.manager.removeProject(f.project.id,{operationId:'remove-after-cold-hold'}),result);
 assert.equal(stops.length,2);assert.equal(cold.closed.length,1);
 // A further cold open never resurrects the hold or the entry.
 assert.deepEqual(await reloadHolds(f),[]);
 const after=new ProjectStorage(path.join(f.directory,'profile'));
 try{const registered=await after.requireRegistered(f.project.id);assert.equal(registered.removed,true);assert.equal(after.lifecycleHolds.size,0);}
 finally{await after.db.close();}
});

test('a guarded stop failure keeps the hold locked and stays explicitly retryable',async t=>{
 const f=await fixture(t),c=await controller(f),pending=pendingBusiness('retry');let closes=0;
 c.terminals.set('fixture',{close:async()=>{if(++closes===1)throw Object.assign(Error('controlled stop failure'),{code:'EIO'});}});
 await f.storage.putRecovery(f.project.id,'managed:pending:preserved-retry',pending);
 await seedStaleHold(f);
 await assert.rejects(f.manager.removeProject(f.project.id,{operationId:'remove-stop-fails'}),{code:'EIO'});
 assert.equal(closes,1);assert(f.storage.lifecycleHolds.has(f.project.id));
 const hold=f.storage.lifecycleHolds.get(f.project.id);assert.equal(hold.needsStopCheck,true);
 await assert.rejects(f.storage.putProject(f.project.id,'fixture','new',{bad:true}),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 assert.notEqual((await f.storage.requireRegistered(f.project.id)).removed,true);
 assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'retained source\n');
 assert.deepEqual(await f.storage.getRecovery(f.project.id,'managed:pending:preserved-retry'),pending);
 const journal=await f.storage.getRecovery(f.project.id,'lifecycle:'+OLD_OPERATION_ID);
 assert.equal(journal.phase,'needs-attention');assert.equal(journal.failedPhase,'prepared');assert.equal(journal.error.code,'PROJECT_LIFECYCLE_ACTIVE');
 // The explicit retry walks the same guarded stop and then removes the entry.
 assert.equal((await f.manager.removeProject(f.project.id,{operationId:'remove-stop-retry'})).removed,true);
 assert.equal(closes,2);assert.equal(f.storage.lifecycleHolds.has(f.project.id),false);
 assert.equal((await f.storage.requireRegistered(f.project.id)).removed,true);
 assert.deepEqual(await f.storage.getRecovery(f.project.id,'managed:pending:preserved-retry'),pending);
 assert.equal(c.store.lifecycleHold,null);
});

test('holds for other lifecycle actions are never auto-released by the remove entry',async t=>{
 const f=await fixture(t),pending=pendingBusiness('other-action');
 await f.storage.putRecovery(f.project.id,'managed:pending:preserved-other',pending);
 for(const action of ['clean-local','delete-project','settle-managed']){
  const hold=await seedStaleHold(f,{action,oldOperationId:randomUUID()});
  await assert.rejects(f.manager.removeProject(f.project.id,{operationId:'remove-'+action}),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  assert.equal(f.storage.lifecycleHolds.get(f.project.id),hold);assert.equal(hold.action,action);
  assert.notEqual((await f.storage.requireRegistered(f.project.id)).removed,true);
  assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'retained source\n');
  assert.deepEqual(await f.storage.getRecovery(f.project.id,'managed:pending:preserved-other'),pending);
  const journal=await f.storage.getRecovery(f.project.id,'lifecycle:'+hold.operationId);
  assert.equal(journal.phase,'needs-attention');assert.equal(journal.failedPhase,'prepared');assert.equal(journal.error.code,'PROJECT_LIFECYCLE_ACTIVE');
  await assert.rejects(f.storage.putProject(f.project.id,'fixture','new',{bad:true}),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  await f.storage.releaseProject(f.project.id,hold);
 }
});

test('an instance-mismatched remove hold is never auto-released',async t=>{
 const f=await fixture(t);
 const foreign=randomUUID(),hold=await seedStaleHold(f,{instanceId:foreign});
 await assert.rejects(f.manager.removeProject(f.project.id,{operationId:'remove-foreign-instance'}),{code:'PROJECT_IDENTITY_CONFLICT'});
 assert.equal(f.storage.lifecycleHolds.get(f.project.id),hold);assert.equal(hold.instanceId,foreign);
 assert.notEqual((await f.storage.requireRegistered(f.project.id)).removed,true);
 assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'retained source\n');
 const journal=await f.storage.getRecovery(f.project.id,'lifecycle:'+hold.operationId);
 assert.equal(journal.phase,'needs-attention');assert.equal(journal.instanceId,foreign);
 await assert.rejects(f.storage.putProject(f.project.id,'fixture','new',{bad:true}),{code:'PROJECT_LIFECYCLE_ACTIVE'});
});

test('a remove hold whose journal identity or action disagrees with the hold is never auto-released',async t=>{
 const f=await fixture(t),pending=pendingBusiness('journal-mismatch');
 await f.storage.putRecovery(f.project.id,'managed:pending:preserved-journal',pending);
 const mismatches=[
  {name:'journal action',override:{action:'clean-local'}},
  {name:'journal instance',override:{instanceId:randomUUID()}},
  {name:'journal project',override:{projectId:randomUUID()}},
  {name:'journal operation',override:{operationId:randomUUID()}},
 ];
 for(const {name,override} of mismatches){
  const hold=await seedStaleHold(f,{oldOperationId:randomUUID(),journalOverride:override});
  const before=await f.storage.getRecovery(f.project.id,'lifecycle:'+hold.operationId);
  await assert.rejects(f.manager.removeProject(f.project.id,{operationId:'remove-'+name.replace(/ /g,'-')}),{code:'PROJECT_IDENTITY_CONFLICT'});
  assert.equal(f.storage.lifecycleHolds.get(f.project.id),hold);
  assert.notEqual((await f.storage.requireRegistered(f.project.id)).removed,true);
  assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'retained source\n');
  // The disagreeing journal is retained byte-for-byte, never rewritten.
  assert.deepEqual(await f.storage.getRecovery(f.project.id,'lifecycle:'+hold.operationId),before);
  assert.deepEqual(await f.storage.getRecovery(f.project.id,'managed:pending:preserved-journal'),pending);
  await assert.rejects(f.storage.putProject(f.project.id,'fixture','new',{bad:true}),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  // Repairing only the journal identity lets the same guarded path proceed.
  const repair={...before,action:'remove',projectId:f.project.id,instanceId:f.project.instanceId,operationId:hold.operationId};
  await f.storage.putRecovery(f.project.id,'lifecycle:'+hold.operationId,repair);
  assert.equal((await f.manager.removeProject(f.project.id,{operationId:'remove-after-'+name.replace(/ /g,'-')})).removed,true);
  assert.equal(f.storage.lifecycleHolds.has(f.project.id),false);
  assert.deepEqual(await f.storage.getRecovery(f.project.id,'managed:pending:preserved-journal'),pending);
  // Revive the same instance for the next mismatch case.
  const revived=await f.storage.register(f.root);assert.equal(revived.instanceId,f.project.instanceId);assert.notEqual(revived.removed,true);
 }
});

test('an in-flight lifecycle operation keeps the hold locked against a new remove admission',async t=>{
 const f=await fixture(t),gate=deferred(),prepared=deferred();
 // The prepared journal is in flight before stop stages increment pendingCount.
 // A live operation must retain its hold even in this zero-pending window.
 const journal=f.manager.journal.bind(f.manager);
 f.manager.journal=async(id,record)=>{await journal(id,record);if(record.operationId==='remove-inflight-first'&&record.phase==='prepared'){prepared.resolve();await gate.promise;}};
 const first=f.manager.run({projectId:f.project.id,operationId:'remove-inflight-first',instanceId:f.project.instanceId,action:'remove',root:f.project.root});
 await prepared.promise;
 assert(f.manager.operations.has(f.project.id));assert.equal(f.storage.lifecycleHolds.get(f.project.id).pendingCount,0);
 await assert.rejects(f.manager.removeProject(f.project.id,{operationId:'remove-inflight-second'}),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 // The refusal must not journal or disturb the running operation.
 assert.equal(await f.storage.getRecovery(f.project.id,'lifecycle:remove-inflight-second'),null);
 assert.equal(await f.storage.getRecovery(f.project.id,'lifecycle:remove:remove-inflight-second'),null);
 gate.resolve();assert.equal((await first).removed,true);
 assert.equal(f.storage.lifecycleHolds.has(f.project.id),false);
 assert.equal((await f.storage.requireRegistered(f.project.id)).removed,true);
 assert.equal((await f.storage.getRecovery(f.project.id,'lifecycle:remove:remove-inflight-first')).complete,true);
});

test('a fallback-synthesized journal lacking instanceId stays releasable',async t=>{
 const f=await fixture(t);
 const hold=await seedStaleHold(f);
 const record=await f.storage.getRecovery(f.project.id,'lifecycle:'+hold.operationId);
 delete record.instanceId; // reconcile's journal-less fallback never stores one
 await f.storage.putRecovery(f.project.id,'lifecycle:'+hold.operationId,record);
 assert.equal((await f.manager.removeProject(f.project.id,{operationId:'remove-fallback-journal'})).removed,true);
 assert.equal(f.storage.lifecycleHolds.has(f.project.id),false);
 assert.equal((await f.storage.requireRegistered(f.project.id)).removed,true);
 assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'retained source\n');
});

test('a second remove click serializes behind the first instead of reconciling concurrently',async t=>{
 const f=await fixture(t),gate=deferred(),started=deferred();
 f.manager.beforeStop=async()=>{started.resolve();await gate.promise;};
 const first=f.manager.removeProject(f.project.id,{operationId:'remove-serial-first'});
 await started.promise;
 const second=f.manager.removeProject(f.project.id,{operationId:'remove-serial-second'});
 await new Promise(resolve=>setTimeout(resolve,50)); // both admissions are now pending
 assert.equal(f.manager.operations.has(f.project.id),true);
 gate.resolve();
 assert.equal((await first).removed,true);assert.equal((await second).removed,true);
 assert.deepEqual(f.closed,['remove-serial-first','remove-serial-second']);
 assert.equal(f.storage.lifecycleHolds.has(f.project.id),false);
 assert.equal((await f.storage.getRecovery(f.project.id,'lifecycle:remove:remove-serial-first')).complete,true);
 assert.equal((await f.storage.getRecovery(f.project.id,'lifecycle:remove:remove-serial-second')).complete,true);
 assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'retained source\n');
});

test('a pending stop or outstanding stop-owned flights keep the hold locked',async t=>{
 const f=await fixture(t);
 const hold=await seedStaleHold(f);
 // A stop already in flight for this project must not be re-entered.
 f.managed.projectStops=new Map([[f.project.id,(async()=>await new Promise(()=>{}))()]]);
 await assert.rejects(f.manager.removeProject(f.project.id,{operationId:'remove-stop-pending'}),{code:'PROJECT_STOP_PENDING'});
 assert.equal(f.storage.lifecycleHolds.get(f.project.id),hold);
 f.managed.projectStops.delete(f.project.id);
 // Outstanding stop-owned admissions (pendingCount) also keep the hold.
 hold.pendingCount=1;
 await assert.rejects(f.manager.removeProject(f.project.id,{operationId:'remove-pending-count'}),{code:'PROJECT_STOP_PENDING'});
 assert.equal(f.storage.lifecycleHolds.get(f.project.id),hold);
 await assert.rejects(f.storage.putProject(f.project.id,'fixture','new',{bad:true}),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 assert.notEqual((await f.storage.requireRegistered(f.project.id)).removed,true);
 hold.pendingCount=0;
 assert.equal((await f.manager.removeProject(f.project.id,{operationId:'remove-after-drain'})).removed,true);
 assert.equal(f.storage.lifecycleHolds.has(f.project.id),false);
});

test('a stale hold without any journal still goes through the reconcile fallback',async t=>{
 const f=await fixture(t),pending=pendingBusiness('no-journal');
 await f.storage.putRecovery(f.project.id,'managed:pending:preserved-nojournal',pending);
 await seedStaleHold(f,{journal:false});
 await assert.rejects(f.storage.putProject(f.project.id,'fixture','new',{bad:true}),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 assert.equal((await f.manager.removeProject(f.project.id,{operationId:'remove-without-journal'})).removed,true);
 assert.equal(f.storage.lifecycleHolds.has(f.project.id),false);
 assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'retained source\n');
 assert.deepEqual(await f.storage.getRecovery(f.project.id,'managed:pending:preserved-nojournal'),pending);
 const fabricated=await f.storage.getRecovery(f.project.id,'lifecycle:'+OLD_OPERATION_ID);
 assert.equal(fabricated.phase,'needs-attention');assert.equal(fabricated.action,'remove');
});

test('reconcile itself stays observation-only and never removes or replays pending business',async t=>{
 const f=await fixture(t),pending=pendingBusiness('observe');
 await f.storage.putRecovery(f.project.id,'managed:pending:preserved-observe',pending);
 await seedStaleHold(f);
 const observation=await f.manager.reconcile({projectId:f.project.id,operationId:OLD_OPERATION_ID});
 assert.equal(observation.phase,'needs-attention');assert.equal(observation.action,'remove');
 assert.equal(observation.observation,'registered');assert.equal(observation.removed,false);
 assert.notEqual((await f.storage.requireRegistered(f.project.id)).removed,true);
 assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'retained source\n');
 assert.deepEqual(await f.storage.getRecovery(f.project.id,'managed:pending:preserved-observe'),pending);
 // After the explicit observation the entry remove takes the normal path.
 assert.equal((await f.manager.removeProject(f.project.id,{operationId:'remove-after-observation'})).removed,true);
 assert.deepEqual(await f.storage.getRecovery(f.project.id,'managed:pending:preserved-observe'),pending);
});
