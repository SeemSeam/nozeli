import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {ProjectLifecycle} from '../src/main/project-lifecycle.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-lifecycle-admission-'));
 const root=path.join(directory,'project');await fs.mkdir(root);await fs.writeFile(path.join(root,'source.txt'),'retained source\n');
 const storage=new ProjectStorage(path.join(directory,'profile')),project=await storage.register(root);
 const host={storage,requireProject:id=>storage.requireOnline(id),requireRegisteredProject:id=>storage.requireRegistered(id)};
 const managed=new ManagedProjects({userDataDir:path.join(directory,'profile'),host,legacy:{projects:new Map()}});
 const closed=[];
 const workspace={closeProject:async(id,{operationId})=>{
  // Production close flushes cross-process; this unit verifies only its host owner scope.
  await storage.requireOnline(id);await storage.putProject(id,'fixture','flush',{retained:true});closed.push(operationId);return {closed:true};
 }};
 const manager=new ProjectLifecycle({host,managed,workspace,trashItem:()=>{throw Error('entry removal must never trash');}});
 t.after(async()=>{await managed.stop();await storage.db.close();await fs.rm(directory,{recursive:true,force:true});});
 return {directory,root,storage,project,host,managed,workspace,closed,manager};
}
async function controller(f){
 const c=await Controller.open({storage:f.storage,projectId:f.project.id,runtimeRoot:path.join(await f.storage.localDirectory(f.project.id),'execution'),contentRoot:f.root,localOnly:true});
 f.managed.controllers.set(f.project.id,c);return c;
}

test('admission capability survives hold only for an existing operation and expires at settlement',async t=>{
 const f=await fixture(t),started=deferred(),finish=deferred(),late=deferred();let leaked,lateResult;
 const accepted=f.storage.withProjectOperation(f.project.id,async()=>{
  leaked=async()=>f.storage.putProject(f.project.id,'fixture','leaked',{bad:true});
  started.resolve();await finish.promise;
  await f.storage.putProject(f.project.id,'fixture','accepted',{ok:true});
  lateResult=late.promise.then(()=>assert.rejects(leaked(),{code:'PROJECT_LIFECYCLE_ACTIVE'}));
 });
 await started.promise;
 const hold=f.storage.holdProject(f.project.id,{operationId:'admission-capability',instanceId:f.project.instanceId,action:'remove'});
 await assert.rejects(f.storage.withProjectOperation(f.project.id,()=>f.storage.requireOnline(f.project.id)),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 await assert.rejects(f.storage.putProject(f.project.id,'fixture','new',{bad:true}),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 finish.resolve();await accepted;await f.storage.drainProjectOperations(f.project.id);
 late.resolve();await lateResult;
 await assert.rejects(async()=>f.storage.withLifecycleOwner(f.project.id,{...hold},()=>f.storage.requireOnline(f.project.id)),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 await f.storage.releaseProject(f.project.id,hold);
 assert.deepEqual(await f.storage.getProject(f.project.id,'fixture','accepted'),{ok:true});
 assert.equal(await f.storage.getProject(f.project.id,'fixture','leaked'),null);
});

test('a pre-hold managed mutation saves under the exact stop owner without a pending replay',async t=>{
 const f=await fixture(t),c=await controller(f),entered=deferred(),finish=deferred(),stopping=deferred();
 const mutation=c.store.mutate(async()=>{entered.resolve();await finish.promise;c.store.state.limit=2;});
 await entered.promise;f.manager.beforeStop=async()=>{stopping.resolve();};
 const removing=f.manager.removeProject(f.project.id,{operationId:'remove-preexisting-mutation'});
 await stopping.promise;
 await assert.rejects(f.storage.withProjectOperation(f.project.id,()=>c.send('frontdesk','new business')),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 await assert.rejects(c.send('frontdesk','direct new business'),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 await assert.rejects(c.submitTask('direct new task',{requestKey:'not-admitted'}),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 await assert.rejects(f.managed.saveLocalDraft(f.project.id,'frontdesk','new non-flush draft'),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 await assert.rejects(f.managed.saveResourceLimits({projectId:f.project.id,globalLimit:4,projectLimit:1}),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 finish.resolve();await mutation;assert.equal((await removing).removed,true);
 assert.equal(c.store.offline,false);assert.equal(c.store.closed,true);
 assert.equal((await f.storage.requireRegistered(f.project.id)).removed,true);assert.equal(f.closed.length,1);
 const pending=(await f.storage.listRecovery(f.project.id)).filter(row=>row.id.startsWith('managed:pending:'));
 assert(pending.length>0);assert(pending.every(row=>row.value.status==='reconciled'));
 assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'retained source\n');
});

test('failed stop is explicitly retryable and reconciliation never removes or replays pending business',async t=>{
 const f=await fixture(t),c=await controller(f);let closes=0;
 c.terminals.set('fixture',{close:async()=>{if(++closes===1)throw Object.assign(Error('controlled stop failure'),{code:'EIO'});}});
 const pending={schema:1,kind:'business',status:'pending',automaticReplay:false,collections:{managed_jobs:[{id:'never-replay',value:{text:'synthetic held input'}}]}};
 await f.storage.putRecovery(f.project.id,'managed:pending:preserved-fixture',pending);
 await assert.rejects(f.manager.removeProject(f.project.id,{operationId:'remove-stop-failure'}),{code:'EIO'});
 assert.equal(c.stopPromise,null);assert(f.storage.lifecycleHolds.has(f.project.id));
 await assert.rejects(f.storage.requireOnline(f.project.id),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 await f.manager.reconcile({projectId:f.project.id,operationId:'remove-stop-failure'});
 assert.equal(closes,2);assert.notEqual((await f.storage.requireRegistered(f.project.id)).removed,true);assert.equal(f.closed.length,0);
 assert.deepEqual(await f.storage.getRecovery(f.project.id,'managed:pending:preserved-fixture'),pending);
 assert.equal((await f.manager.removeProject(f.project.id,{operationId:'remove-after-explicit-check'})).removed,true);
 assert.deepEqual(await f.storage.getRecovery(f.project.id,'managed:pending:preserved-fixture'),pending);
 assert.equal(c.store.lifecycleHold,null);
 const registered=await f.storage.register(f.root);assert.equal(registered.instanceId,f.project.instanceId);
 await f.managed.connect(f.project.id,{enable:true,localOnly:true,startResidents:false});
 const reopened=f.managed.controllers.get(f.project.id);assert.notEqual(reopened,c);assert.notEqual(reopened.store,c.store);
 assert.equal(reopened.store.lifecycleHold,undefined);assert.equal(reopened.store.state.jobs.some(job=>job.id==='never-replay'),false);
 assert.equal((await f.manager.removeProject(f.project.id,{operationId:'remove-reconnected-instance'})).removed,true);
 assert.deepEqual(await f.storage.getRecovery(f.project.id,'managed:pending:preserved-fixture'),pending);
});

test('a pre-hold connection flight is drained and cancelled without poisoning managed persistence',async t=>{
 const f=await fixture(t),opening=deferred(),finish=deferred();let opened;
 f.managed.openController=async options=>{opening.resolve();await finish.promise;opened=await Controller.open(options);return opened;};
 const connecting=f.managed.connect(f.project.id,{enable:true,localOnly:true,startResidents:false});
 const rejected=assert.rejects(connecting,{code:'PROJECT_STOPPING'});
 await opening.promise;
 const removing=f.manager.removeProject(f.project.id,{operationId:'remove-opening-controller'});
 // Enter stop before allowing the accepted open to finish; no polling or production replay.
 const nativeStop=f.managed.stopProject.bind(f.managed),stopping=deferred();
 // The lifecycle has not reached its asynchronous stop continuation yet.
 f.managed.stopProject=(...args)=>{const result=nativeStop(...args);stopping.resolve();return result;};
 await stopping.promise;finish.resolve();await rejected;
 assert.equal((await removing).removed,true);assert.equal(opened.store.closed,true);assert.equal(opened.store.offline,false);
 assert.equal(f.storage.projectOperations.size,0);
 assert((await f.storage.listRecovery(f.project.id)).filter(row=>row.id.startsWith('managed:pending:')).every(row=>row.value.status==='reconciled'));
});

test('active worker interruption persists under stop owner and keeps the execution worktree',async t=>{
 const f=await fixture(t),c=await controller(f),executing=deferred(),interrupted=deferred();
 c.sessionFactory=(spec,target)=>({
  ...spec,target,closed:false,busy:false,toolsDigest:'synthetic-worker-schema',
  async preflightToolsDigest(){},async assertToolsDigest(){},
  async start(){this.threadId='synthetic-worker-thread';return this;},
  async prompt(){
   this.busy=true;this.hasPrompted=true;
   await fs.writeFile(path.join(spec.cwd,'running-result.txt'),'synthetic in-progress result\n');executing.resolve();
   await interrupted.promise;this.busy=false;throw Object.assign(Error('synthetic native stop'),{code:'ABORTED'});
  },
  async stop(){this.closed=true;interrupted.resolve();return {confirmationComplete:true};},
 });
 await c.prepareOnline();
 const work=await c.store.submit('synthetic active task','keep the unfinished result');await c.store.activate(work.id);
 const {jobId}=await c.enqueue(work.id,'initial','synthetic active task'),job=c.store.state.jobs.find(row=>row.id===jobId),running=c.runJob(job);running.catch(()=>{});
 c.running.set(work.id,running);await executing.promise;
 const execution=c.execution.directory(work.id);
 assert.equal((await f.manager.removeProject(f.project.id,{operationId:'remove-active-worker'})).removed,true);await running;
 assert.equal(c.store.state.jobs.find(row=>row.id===job.id).status,'interrupted');
 assert.equal(c.store.closed,true);assert.equal(c.store.offline,false);assert.equal(c.store.lifecycleHold,null);
 assert.equal(await fs.readFile(path.join(execution,'running-result.txt'),'utf8'),'synthetic in-progress result\n');
 assert((await f.storage.listRecovery(f.project.id)).filter(row=>row.id.startsWith('managed:pending:')).every(row=>row.value.status==='reconciled'));
});

test('cold operation admission loads the persisted hold before issuing any capability',async t=>{
 const f=await fixture(t),hold=f.storage.holdProject(f.project.id,{operationId:'cold-operation-hold',instanceId:f.project.instanceId,action:'remove'});
 await f.storage.persistProjectHold(f.project.id,hold);await f.storage.db.close();
 const cold=new ProjectStorage(path.join(f.directory,'profile'));t.after(()=>cold.db.close());let invoked=false;
 await assert.rejects(cold.withProjectOperation(f.project.id,async()=>{invoked=true;await cold.requireOnline(f.project.id);}),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 assert.equal(invoked,false);assert.equal(cold.projectOperations.size,0);assert(cold.lifecycleHolds.has(f.project.id));
});

test('hold drains a draft flight accepted before a controller exists',async t=>{
 const f=await fixture(t),reading=deferred(),finish=deferred(),stopping=deferred();
 const projection=f.managed.projectionSource.bind(f.managed);
 f.managed.projectionSource=async(...args)=>{reading.resolve();await finish.promise;return projection(...args);};
 const draft=f.managed.saveLocalDraft(f.project.id,'frontdesk','synthetic accepted draft');await reading.promise;
 f.manager.beforeStop=async()=>{stopping.resolve();};
 const removing=f.manager.removeProject(f.project.id,{operationId:'remove-draft-flight'});await stopping.promise;
 finish.resolve();await draft;assert.equal((await removing).removed,true);
 assert.equal((await f.storage.getRecovery(f.project.id,'managed:drafts')).frontdesk,'synthetic accepted draft');assert.equal(f.storage.projectOperations.size,0);
});

test('hold drains a resource operation accepted before its flight is published',async t=>{
 const f=await fixture(t),initializing=deferred(),finish=deferred(),stopping=deferred();
 f.managed.initializeResources=async()=>{initializing.resolve();await finish.promise;};
 const resource=f.managed.saveResourceLimits({projectId:f.project.id,globalLimit:4,projectLimit:2});await initializing.promise;
 f.manager.beforeStop=async()=>{stopping.resolve();};
 const removing=f.manager.removeProject(f.project.id,{operationId:'remove-resource-flight'});await stopping.promise;
 finish.resolve();await resource;assert.equal((await removing).removed,true);assert.equal(f.storage.projectOperations.size,0);
 assert((await f.storage.listRecovery(f.project.id)).filter(row=>row.id.startsWith('managed:pending:')).every(row=>row.value.status==='reconciled'));
});
