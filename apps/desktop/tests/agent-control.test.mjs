// Permanent manual work-control behavior suites (design:
// docs/manual-task-control-repair-design.md §4–§9, acceptance matrix §11).
//
// Real DesktopHost + ProjectStorage + Workspace ledger + ManagedProjects with
// deterministic scripted owners (ControlSession) and a fake clock. Correctness
// uses barriers and microtask draining only — no timer-sleep races, no mocks of
// the code under test, no wiring echo: every assertion observes durable state,
// real sessions, real receipts or real scheduler behavior.
//
// Depends on the shared contract (Controller.workControl / workControlCapabilities
// / workExecutionHeld, managed/work-control.mjs dispatchWorkControl, gateway ops
// managed.work.control[.status], maintenanceRetry expectedRetryMode). Contract
// seam: controlApi in ./agent-control.fixture.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {AgentIdleLifecycle} from '../src/agents/managed/agent-idle-lifecycle.mjs';
import {
  barrier,spin,drain,drainIdle,FakeClock,ControlSession,
  controlHost,controlManager,teardown,seedQueuedWorks,
  controlApi,stopStateOf,
} from './agent-control.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';

async function fixture(t,options={}){
  const {processLimit=6}=options;
  const idleTimeoutMs=Object.hasOwn(options,'idleTimeoutMs')?options.idleTimeoutMs:100;
  const host=await controlHost(),clock=new FakeClock(),prompts=[],scriptFor=new Map();
  const sessionFactory=(spec,target)=>new ControlSession(spec,target,{script:async(session,text,job)=>{
    const key=job?.target??target;
    prompts.push({target:key,text,jobId:job?.id??null,owner:session.viewOwnerId});
    const run=scriptFor.get(key);
    const outcome=run?await run(session,text,job):'ok';
    if(spec.role==='worker'&&!session.cancelled&&!session.closed)await spec.onTool({tool:'nozeli_publish',arguments:{kind:'result',content:staticReport('Synthetic control report'),files:[]},callId:'control-publish-'+job.id});
    return outcome;
  }});
  const manager=controlManager({host:host.host,profile:host.profile,clock,idleTimeoutMs,sessionFactory});
  await manager.processBudget.save(processLimit);
  t.after(async()=>{await teardown({manager});await host.done();});
  await manager.connect(host.project.id,{enable:true});
  const controller=manager.controllers.get(host.project.id);
  await controller.store.mutate(()=>{controller.store.state.limit=2;});
  return {host,manager,controller,clock,prompts,scriptFor,projectId:host.project.id};
}
const submitWork=async(c,name)=>c.store.submit(`Synthetic request ${name}`,`Synthetic brief ${name}`,{name});
const runningJob=async(c,target)=>spin(()=>{
  const job=c.store.state.jobs.find(row=>row.target===target&&row.status==='running'&&row.promptStartedAt!=null);
  const session=c.sessions.get(target);
  return job&&session&&session.busy?{job,session}:null;
},'admitted running turn for '+target);
const holdScript=session=>session.holdUntilCancelled()();
const noStopFabrication=(c,jobId)=>{
  const job=c.store.state.jobs.find(row=>row.id===jobId);
  return !c.store.state.receipts.some(row=>row.jobId===jobId&&row.origin==='host-diagnostic')&&!c.store.state.todos.some(todo=>todo.workId===job?.target&&todo.kind==='recovery'&&todo.sourceJobId===jobId);
};

// ── pause: durable gate, admission-only, drafts and threads untouched ───────
test('pause commits before scheduler admission and holds only new business',async t=>{
  const f=await fixture(t),c=f.controller;
  const work=await submitWork(c,'Pause A');
  const realKick=c.kick.bind(c);c.kick=()=>{};
  const paused=await controlApi.controllerControl(c,{workId:work.id,action:'pause',requestKey:'ctl-pause-basic-1'});
  c.kick=realKick;c.kick();
  assert.equal(paused.controlApplied.applied,true);
  assert.equal(paused.controlApplied.paused,true);
  assert.ok(Number.isSafeInteger(paused.controlVersion));
  assert.equal(controlApi.held(c,work.id),true);
  await drain(c);
  assert.equal(c.store.find(work.id).status,'queued','held work must not activate');
  assert.equal(f.prompts.filter(row=>row.target===work.id).length,0,'zero admissions while held');
  const capabilities=await controlApi.capabilities(c,work.id);
  for(const key of ['pause','stopCurrent','resume'])assert.ok(capabilities[key]!==undefined,'capabilities expose '+key);
  const resumed=await controlApi.controllerControl(c,{workId:work.id,action:'resume',requestKey:'ctl-resume-basic-1'});
  assert.equal(resumed.executionDisposition.kind,'eligible');
  await drain(c);
  const saved=c.store.find(work.id);
  assert.equal(f.prompts.filter(row=>row.target===work.id).length,1,'exactly one admission after resume');
  assert.equal(saved.status,'review','successful publication remains pending explicit user review');
  // Drafts survive control operations and never leak into admission.
  await c.setDraft(work.id,'DRAFT_KEEP_PAUSE');
  await controlApi.controllerControl(c,{workId:work.id,action:'pause',requestKey:'ctl-pause-basic-2'});
  await controlApi.controllerControl(c,{workId:work.id,action:'resume',requestKey:'ctl-resume-basic-2'});
  await drain(c);
  assert.equal(c.store.state.drafts[work.id],'DRAFT_KEEP_PAUSE','draft preserved across pause/resume');
  assert.equal(f.prompts.filter(row=>row.target===work.id).length,1,'drafted text never auto-admitted');
});

test('pause racing queued pickup: committed pause wins; admitted turn completes',async t=>{
  const f=await fixture(t),c=f.controller;
  const work=await submitWork(c,'Race A');
  const realKick=c.kick.bind(c);c.kick=()=>{};
  await controlApi.controllerControl(c,{workId:work.id,action:'pause',requestKey:'ctl-race-hold-1'});
  c.kick=realKick;c.kick();
  await drain(c);
  assert.equal(c.store.find(work.id).status,'queued');
  assert.equal(c.store.state.jobs.some(job=>job.target===work.id),false,'no initial job created for held work');
  f.scriptFor.set(work.id,holdScript);
  await controlApi.controllerControl(c,{workId:work.id,action:'resume',requestKey:'ctl-race-free-1'});
  const first=await runningJob(c,work.id);
  // Pause DURING the admitted turn: the current round and its tools continue.
  const during=await controlApi.controllerControl(c,{workId:work.id,action:'pause',requestKey:'ctl-race-mid-1'});
  assert.equal(during.controlApplied.paused,true);
  assert.equal(first.session.interrupts.length,0,'pause never interrupts the admitted round');
  const realKick2=c.kick.bind(c);c.kick=()=>{};
  const supplement=await c.send(work.id,'supplement after pause',{requestKey:'ctl-race-supp-1'});
  c.kick=realKick2;c.kick();await spin(()=>!c.kicking,'supplement remains gated while the admitted round runs');
  assert.equal(c.store.state.jobs.find(job=>job.id===supplement.jobId).status,'queued','next admission is gated');
  first.session.finishPending();await drain(c);f.scriptFor.delete(work.id);
  assert.equal(first.job.status,'completed','admitted round settled through the normal host path');
  const again=await controlApi.controllerControl(c,{workId:work.id,action:'resume',requestKey:'ctl-race-resume-1'});
  assert.equal(again.executionDisposition.kind,'eligible');
  await drain(c);
  assert.equal(c.store.state.jobs.find(job=>job.id===supplement.jobId).status,'completed');
  assert.equal(f.prompts.filter(row=>row.text==='supplement after pause').length,1);
});

// ── stop-current: exact run, confirmed exit, no fabricated recovery ──────────
test('stop-current cancels the exact run, confirms exit and leaves peers untouched',async t=>{
  let endPublicationB;
  t.after(()=>endPublicationB?.());
  const f=await fixture(t),c=f.controller;
  const A=await submitWork(c,'Stop A'),B=await submitWork(c,'Peer B');
  const gateB=barrier();
  f.scriptFor.set(A.id,holdScript);
  f.scriptFor.set(B.id,async()=>{await gateB.promise;return 'peer output';});
  c.kick();
  const runA=await runningJob(c,A.id),runB=await runningJob(c,B.id);
  endPublicationB=c.beginHostOperation(B.id,'publication');
  const budgetBefore=f.manager.processBudget.used;
  const stop=await controlApi.controllerControl(c,{workId:A.id,action:'stop-current',requestKey:'ctl-stop-exact-1',ownerId:runA.session.viewOwnerId,ownerGeneration:runA.session.epoch,currentJobId:runA.job.id});
  assert.equal(stopStateOf(stop),'confirmed');
  assert.equal(stop.controlApplied.stop.exit.confirmed,true);
  assert.ok(Number.isInteger(stop.controlApplied.stop.exit.pid),'real owner pid evidence');
  const savedA=c.store.state.jobs.find(job=>job.id===runA.job.id);
  assert.ok(!['completed','failed'].includes(savedA.status),'stopped run is neither success nor provider failure');
  assert.ok(savedA.promptStartedAt!=null,'admission evidence retained');
  assert.ok(noStopFabrication(c,runA.job.id),'no fabricated missing-report problem/recovery for the stopped run');
  assert.equal(c.store.find(A.id).status,'paused','stop does not end the Work');
  assert.equal(c.store.find(A.id).manualControl?.pause?.requestKey,'ctl-stop-exact-1','stop submitted the hold first');
  assert.equal(runA.session.interrupts.filter(row=>row.stopped).length,1,'exact-run cancellation attempted once');
  assert.equal(c.sessions.has(A.id),false);
  assert.equal(f.manager.processBudget.used,budgetBefore-1,'confirmed exit releases capacity');
  // Peer B: its own publication transaction stays open and completes later.
  assert.equal(c.hostOperations.size,1);
  assert.deepEqual([...c.hostOperations.values()][0],{target:B.id,phase:'publication'});
  assert.equal(c.current.has(B.id),true);
  endPublicationB();gateB.open();
  await drain(c);
  assert.equal(runB.job.status,'completed');
  assert.ok(c.store.state.receipts.some(row=>row.jobId===runB.job.id&&row.kind==='result'),'peer B publishes its own result independently');
});

test('unconfirmed owner exit keeps stop unknown, evidence and capacity; pause survives',async t=>{
  const f=await fixture(t),c=f.controller;
  const A=await submitWork(c,'Unknown A');
  f.scriptFor.set(A.id,holdScript);
  c.kick();
  const run=await runningJob(c,A.id);
  const pidBefore=run.session.pid;
  run.session.exitReceipt={confirmationComplete:false};
  const budgetBefore=f.manager.processBudget.used;
  const stop=await controlApi.controllerControl(c,{workId:A.id,action:'stop-current',requestKey:'ctl-stop-unknown-1',ownerId:run.session.viewOwnerId,ownerGeneration:run.session.epoch,currentJobId:run.job.id});
  assert.equal(stopStateOf(stop),'unknown','unconfirmed exit is unknown, never 已停止');
  assert.equal(stop.executionDisposition.kind,'stopped-unconfirmed');
  assert.equal(c.sessions.get(A.id),run.session,'owner evidence retained');
  assert.equal(run.session.pid,pidBefore,'pid retained for later verification');
  assert.equal(f.manager.processBudget.used,budgetBefore,'unconfirmed exit keeps capacity');
  assert.equal(c.store.find(A.id).manualControl?.pause?.requestKey,'ctl-stop-unknown-1','pause commit survives the failed stop (separate transaction)');
  const replay=await controlApi.controllerControl(c,{workId:A.id,action:'stop-current',requestKey:'ctl-stop-unknown-1',ownerId:run.session.viewOwnerId,ownerGeneration:run.session.epoch,currentJobId:run.job.id});
  assert.deepEqual(replay.receipt,stop.receipt,'same requestKey replays the original receipt verbatim');
  assert.equal(run.session.stops.length,1,'replay never re-attempts the exit');
  // Later verification under a NEW operation key settles the same stop operation.
  run.session.exitReceipt=undefined;
  const confirmed=await controlApi.controllerControl(c,{workId:A.id,action:'stop-current',requestKey:'ctl-stop-verify-2',ownerId:run.session.viewOwnerId,ownerGeneration:run.session.epoch,currentJobId:run.job.id});
  assert.equal(stopStateOf(confirmed),'confirmed');
  assert.equal(c.sessions.has(A.id),false);
  assert.equal(f.manager.processBudget.used,budgetBefore-1);
});

test('stop with replaced owner stays stale: hold kept, new owner never stopped',async t=>{
  const f=await fixture(t),c=f.controller;
  const A=await submitWork(c,'Stale A');
  c.kick();await drain(c);                       // initial round settled, owner idle
  const oldOwner=c.sessions.get(A.id);
  await c.reclaimIdle(A.id);
  const replacement=await c.session(A.id);
  assert.notEqual(replacement,oldOwner);
  f.scriptFor.set(A.id,holdScript);
  const supplement=await c.send(A.id,'supplement on new owner',{requestKey:'ctl-stale-supp-1'});
  const run=await runningJob(c,A.id);
  assert.equal(c.sessions.get(A.id),replacement);
  await controlApi.controllerControl(c,{workId:A.id,action:'pause',requestKey:'ctl-stale-hold-1'});
  const stale=await controlApi.controllerControl(c,{workId:A.id,action:'stop-current',requestKey:'ctl-stale-stop-1',ownerId:oldOwner.viewOwnerId,ownerGeneration:oldOwner.epoch,currentJobId:run.job.id});
  assert.equal(stopStateOf(stale),'stale-owner');
  assert.equal(stale.executionDisposition.kind,'stale');
  assert.equal(stale.controlApplied.paused,true,'hold is kept, never rolled back');
  assert.equal(replacement.closed,false,'replacement owner must not be stopped');
  assert.equal(c.sessions.get(A.id),replacement);
  const replay=await controlApi.controllerControl(c,{workId:A.id,action:'stop-current',requestKey:'ctl-stale-stop-1',ownerId:oldOwner.viewOwnerId,ownerGeneration:oldOwner.epoch,currentJobId:run.job.id});
  assert.deepEqual(replay.receipt,stale.receipt);
  await assert.rejects(controlApi.controllerControl(c,{workId:A.id,action:'resume',requestKey:'ctl-stale-stop-1'}),{code:'WORK_CONTROL_REQUEST_CONFLICT'});
});

// ── request keys and CAS ─────────────────────────────────────────────────────
test('requestKey dedupe and version CAS semantics',async t=>{
  const f=await fixture(t),c=f.controller;
  const work=await submitWork(c,'Dedupe');
  const first=await controlApi.controllerControl(c,{workId:work.id,action:'pause',requestKey:'ctl-dedupe-key-1'});
  const second=await controlApi.controllerControl(c,{workId:work.id,action:'pause',requestKey:'ctl-dedupe-key-1'});
  assert.deepEqual(second,first,'identical intent returns the stored response verbatim');
  await assert.rejects(controlApi.controllerControl(c,{workId:work.id,action:'resume',requestKey:'ctl-dedupe-key-1'}),{code:'WORK_CONTROL_REQUEST_CONFLICT'});
  await assert.rejects(controlApi.controllerControl(c,{workId:work.id,action:'stop-current',requestKey:'ctl-dedupe-key-1'}),{code:'WORK_CONTROL_REQUEST_CONFLICT'});
  await assert.rejects(controlApi.controllerControl(c,{workId:work.id,action:'pause',requestKey:'ctl-dedupe-key-2',expectedControlVersion:first.controlVersion+5}),{code:'STALE_CONTROL_VERSION'});
  await assert.rejects(controlApi.controllerControl(c,{workId:work.id,action:'pause',requestKey:'ctl-dedupe-key-3',expectedWorkRevision:c.store.find(work.id).revision+3}),{code:'STALE_WORK_REVISION'});
  await assert.rejects(controlApi.controllerControl(c,{workId:'no-such-work',action:'pause',requestKey:'ctl-dedupe-key-4'}),{code:'WORK_CONTROL_TARGET_UNKNOWN'});
  await assert.rejects(controlApi.controllerControl(c,{workId:work.id,jobId:'no-such-job',action:'pause',requestKey:'ctl-dedupe-key-5'}));
});

// ── receipt ledger: CAS identity, capped replays, gated resume ───────────────
test('control receipts: CAS belongs to intent, capped ledger replays originals, held review never executes',async t=>{
  const f=await fixture(t),c=f.controller,projectId=f.projectId;
  const work=await submitWork(c,'Receipts A');
  c.kick=()=>{}; // receipt/CAS assertions must not race a new Work activation
  const first=await controlApi.controllerControl(c,{workId:work.id,action:'pause',requestKey:'ctl-cap-key-1',expectedControlVersion:0});
  assert.equal(first.controlVersion,1);
  const verbatim=await controlApi.controllerControl(c,{workId:work.id,action:'pause',requestKey:'ctl-cap-key-1',expectedControlVersion:0});
  assert.deepEqual(verbatim,first);
  // Same request key and action but a DIFFERENT CAS expectation is a different
  // intent: never silently re-applied against the moved version.
  await assert.rejects(controlApi.controllerControl(c,{workId:work.id,action:'pause',requestKey:'ctl-cap-key-1',expectedControlVersion:1}),error=>['WORK_CONTROL_REQUEST_CONFLICT','STALE_CONTROL_VERSION'].includes(error.code));
  // More than the durable receipt window: replay of the FIRST control still
  // returns the original response, and the ledger stays bounded.
  for(let index=0;index<18;index++)await controlApi.controllerControl(c,{workId:work.id,action:index%2?'resume':'pause',requestKey:'ctl-cap-bulk-'+index});
  const replay=await controlApi.controllerControl(c,{workId:work.id,action:'pause',requestKey:'ctl-cap-key-1',expectedControlVersion:0});
  assert.equal(replay.controlVersion,first.controlVersion,'eviction never rewrites the applied outcome');
  assert.equal(replay.receipt?.outcome??replay.receipt?.controlVersion,first.receipt?.outcome??first.controlVersion,'idempotence evidence survives eviction');
  assert.equal(replay.controlApplied.applied,first.controlApplied.applied);
  assert.equal(controlApi.held(c,work.id),false,'a retired receipt replay never fabricates a hold');
  assert.ok(c.store.find(work.id).manualControl.receipts.length<=16);
  // Cold pause is CAS-bound to the durable work revision: missing CAS rejects
  // without ever constructing a Controller.
  await f.manager.stopProject(projectId);
  await assert.rejects(controlApi.invoke(f.manager,{projectId,workId:work.id,action:'pause',expectedProjectInstanceId:f.host.project.instanceId,requestKey:'ctl-cold-nocas-1'}));
  assert.equal(f.manager.controllers.size,0);
  await f.manager.connect(projectId,{enable:true});
  const live=f.manager.controllers.get(projectId);
  // Resume on a review-held Work only releases the gate: no execution, no
  // continueState revision bump, no synthesized prompt.
  const reviewWork=await submitWork(live,'Receipts B');
  live.kick();await drain(live);
  await controlApi.controllerControl(live,{workId:reviewWork.id,action:'pause',requestKey:'ctl-cap-review-1'});
  const before=f.prompts.length,revision=live.store.find(reviewWork.id).revision;
  const resumed=await controlApi.controllerControl(live,{workId:reviewWork.id,action:'resume',requestKey:'ctl-cap-review-2'});
  assert.equal(resumed.executionDisposition.kind,'review');
  assert.equal(live.store.find(reviewWork.id).status,'review');
  assert.equal(live.store.find(reviewWork.id).revision,revision,'no continueState side effect');
  assert.equal(f.prompts.length,before,'no synthesized continuation input');
});

// ── manual gate vs maintenance repair/finalize ───────────────────────────────
test('manual pause defers unstarted repair effects; repair never requeues held input',async t=>{
  const f=await fixture(t),c=f.controller;
  const A=await submitWork(c,'Repair A');
  c.kick();await drain(c);
  const job=c.store.state.jobs.find(row=>row.target===A.id&&row.type==='initial');
  const marker=path.join(f.host.content,'repair-marker.txt');
  let effectRuns=0;
  const run=async()=>{if(++effectRuns<=2)throw Object.assign(Error('synthetic transient publication fault'),{code:'SYNTHETIC_TRANSIENT'});await fs.writeFile(marker,'verified\n',{flag:'wx'});return marker;};
  const verify=async file=>await fs.readFile(file,'utf8')==='verified\n';
  await assert.rejects(c.maintenanceTransaction(job,'publication',run,verify),error=>error.code==='MAINTENANCE_PENDING');
  const findBug=async()=>(await c.maintenanceStatus()).bugs.find(row=>row.phase==='publication'&&row.workId===A.id);
  const bug=await findBug();
  assert.ok(bug);assert.equal(bug.attempts.length,1);
  const binding=c.maintenanceBinding(await findBug());
  try{await c.maintenanceRetry(bug.id,{binding,expectedRetryMode:'finalize'});assert.fail('drift must reject');}
  catch(error){assert.equal(error.code,'MAINTENANCE_RETRY_MODE_STALE');}
  await controlApi.controllerControl(c,{workId:A.id,action:'pause',requestKey:'ctl-repair-hold-1'});
  await c.maintenanceRetry(bug.id,{binding});
  const heldBug=await findBug();
  assert.equal(heldBug.attempts.length,1,'paused work never spends repair effects');
  assert.equal(await fs.stat(marker).then(()=>true,()=>false),false,'no effect bytes while held');
  c.kick=()=>{};
  await controlApi.controllerControl(c,{workId:A.id,action:'resume',requestKey:'ctl-repair-free-1'});
  const repaired=await c.maintenanceRetry(bug.id,{binding:c.maintenanceBinding(await findBug())});
  assert.equal(repaired.status,'repaired');
  assert.equal(effectRuns,3,'initial effect, one failed auto repair, then one verified repair');
  assert.equal(await fs.readFile(marker,'utf8'),'verified\n');
  assert.equal(f.prompts.filter(row=>row.target===A.id).length,1,'repair must not replay the business input');
});

// ── idle held queue: reclaim safely, resume admits the original job ─────────
test('manual-held queued job keeps identity through idle reclaim and resumes once',async t=>{
  const f=await fixture(t,{idleTimeoutMs:100}),c=f.controller;
  const A=await submitWork(c,'Idle A');
  c.kick();await drain(c);await drainIdle(f.manager);
  assert.ok(c.sessions.has(A.id),'owner idles after the admitted round');
  const realKick=c.kick.bind(c);c.kick=()=>{};
  const supplement=await c.send(A.id,'held supplement',{requestKey:'ctl-idle-supp-1'});
  await controlApi.controllerControl(c,{jobId:supplement.jobId,action:'pause',requestKey:'ctl-idle-hold-1'});
  c.kick=realKick;c.kick();await drain(c);
  const queued=c.store.state.jobs.find(row=>row.id===supplement.jobId);
  assert.equal(queued.status,'queued');
  assert.equal(controlApi.held(c,supplement.jobId),true);
  const orderBefore=c.store.state.jobs.indexOf(queued);
  await f.clock.advance(100,f.manager.idleLifecycle);
  assert.equal(c.sessions.has(A.id),false,'held-queued input alone never protects an idle owner');
  assert.equal(c.store.state.jobs.find(row=>row.id===supplement.jobId).status,'queued','job identity and queue position survive reclaim');
  assert.equal(c.store.find(A.id).status,'review','owner reclaim preserves the pending result');
  const resumed=await controlApi.controllerControl(c,{jobId:supplement.jobId,action:'resume',requestKey:'ctl-idle-free-1'});
  await drain(c);
  const done=c.store.state.jobs.find(row=>row.id===supplement.jobId);
  assert.equal(done.status,'completed','the ORIGINAL job object is admitted, not a replacement');
  assert.equal(c.store.state.jobs.indexOf(done),orderBefore);
  assert.equal(f.prompts.filter(row=>row.text==='held supplement').length,1);
  assert.equal([...c.sessions.values()].filter(session=>session.target===A.id).length,1,'no dual owner');
});

// ── hard five-minute policy with fake clock; stop/idle single exit flight ────
test('default grace stays five minutes on a fake clock while manual gates coexist',async t=>{
  assert.equal(new AgentIdleLifecycle({controllers:new Map()}).idleTimeoutMs,300000);
  const f=await fixture(t,{idleTimeoutMs:undefined}),c=f.controller;
  assert.equal(f.manager.idleLifecycle.idleTimeoutMs,300000);
  const A=await submitWork(c,'Five A');
  c.kick();await drain(c);await drainIdle(f.manager);
  const owner=c.sessions.get(A.id);
  const realKick=c.kick.bind(c);c.kick=()=>{};
  const supplement=await c.send(A.id,'held five-minute',{requestKey:'ctl-five-supp-1'});
  await controlApi.controllerControl(c,{jobId:supplement.jobId,action:'pause',requestKey:'ctl-five-hold-1'});
  c.kick=realKick;c.kick();await drain(c);
  await f.clock.advance(299999,f.manager.idleLifecycle);
  assert.equal(c.sessions.get(A.id),owner,'no early expiry under the hard policy');
  await f.clock.advance(1,f.manager.idleLifecycle);
  assert.equal(c.sessions.has(A.id),false,'continuous safe idle still reclaims under the manual hold');
  await controlApi.controllerControl(c,{jobId:supplement.jobId,action:'resume',requestKey:'ctl-five-free-1'});
  await drain(c);
  assert.equal(c.store.state.jobs.find(row=>row.id===supplement.jobId).status,'completed');
});

test('stop and idle share one serial exit flight without dual owners',async t=>{
  const f=await fixture(t,{idleTimeoutMs:100}),c=f.controller;
  const A=await submitWork(c,'Serial A');
  f.scriptFor.set(A.id,holdScript);
  c.kick();
  const run=await runningJob(c,A.id);
  const stopGate=barrier();
  const originalStop=run.session.stop.bind(run.session);
  run.session.stop=async()=>{await stopGate.promise;return originalStop();};
  const stopFlight=controlApi.controllerControl(c,{workId:A.id,action:'stop-current',requestKey:'ctl-serial-stop-1',ownerId:run.session.viewOwnerId,ownerGeneration:run.session.epoch,currentJobId:run.job.id});
  stopFlight.catch(()=>{});
  await spin(()=>run.session.interrupts.length>0||run.session.stops.length>0,'stop flight entered the exit path');
  assert.equal(c.canReclaimIdle(A.id,run.session),false,'idle expiry cannot overlap the stop exit flight');
  await f.clock.advance(500,f.manager.idleLifecycle);
  stopGate.open();
  const stop=await stopFlight;
  assert.equal(stopStateOf(stop),'confirmed');
  await f.clock.advance(500,f.manager.idleLifecycle);
  assert.equal(run.session.stops.length,1,'no second exit attempt after the confirmed stop');
  assert.equal(c.sessions.has(A.id),false);
});

test('resume during confirmed stop exit dispatches the original queued supplement without another wake',async t=>{
  const f=await fixture(t),c=f.controller,A=await submitWork(c,'Resume during stop');
  f.scriptFor.set(A.id,holdScript);c.kick();
  const run=await runningJob(c,A.id),exit=barrier(),originalStop=run.session.stop.bind(run.session);
  run.session.stop=async()=>{await exit.promise;return originalStop();};
  const stopping=controlApi.controllerControl(c,{workId:A.id,action:'stop-current',requestKey:'ctl-exit-stop-1',ownerId:run.session.viewOwnerId,ownerGeneration:run.session.epoch,currentJobId:run.job.id});
  stopping.catch(()=>{});
  try{
    await spin(()=>run.session.interrupts.length>0,'stop interruption');
    const supplement=await c.send(A.id,'original pending supplement',{requestKey:'ctl-exit-supp-1'});
    f.scriptFor.delete(A.id);
    await controlApi.controllerControl(c,{workId:A.id,action:'resume',requestKey:'ctl-exit-resume-1'});
    assert.equal(c.store.state.jobs.find(job=>job.id===supplement.jobId).status,'queued');
    exit.open();await stopping;
    await spin(()=>c.store.state.jobs.find(job=>job.id===supplement.jobId).status==='completed','original supplement after exit');
    assert.equal(f.prompts.filter(prompt=>prompt.jobId===supplement.jobId).length,1);
  }finally{exit.open();await stopping;}
});

test('resume wakes an existing bug-bound technical event without replaying failed business input',async t=>{
  const f=await fixture(t),c=f.controller,A=await submitWork(c,'Technical wake');
  c.kick();await drain(c);
  const job=c.store.state.jobs.find(row=>row.target===A.id&&row.type==='initial');
  const kick=c.kick.bind(c);c.kick=()=>{};
  try{
    await c.store.mutate(()=>{job.status='failed';c.store.find(A.id).status='paused';});
    await assert.rejects(c.maintenanceTransaction(job,'publication',async()=>{throw Object.assign(Error('synthetic fault'),{code:'SYNTHETIC_TRANSIENT'});},async()=>false),{code:'MAINTENANCE_PENDING'});
    await controlApi.controllerControl(c,{workId:A.id,action:'pause',requestKey:'ctl-tech-pause-1'});
  }finally{c.kick=kick;}
  c.kick();await drain(c);
  const technical=c.store.state.jobs.find(row=>row.type==='maintenance'&&row.context?.bugId);
  assert.equal(technical.status,'queued','manual hold defers the existing technical event');
  await controlApi.controllerControl(c,{workId:A.id,action:'resume',requestKey:'ctl-tech-resume-1'});
  await spin(()=>technical.status==='completed','technical event after resume');
  assert.equal(f.prompts.filter(prompt=>prompt.jobId===technical.id).length,1);
  assert.equal(f.prompts.filter(prompt=>prompt.target===A.id).length,1,'failed business input is not reissued');
});

// ── closure gate: limit 2, FIFO eligible selection, bounded paging ───────────
test('limit 2 admits FIFO-eligible works only and closure-complete releases the slot',async t=>{
  const f=await fixture(t),c=f.controller,projectId=f.projectId;
  await seedQueuedWorks(c.store,100,{limit:2});
  const works=c.store.state.works;
  await controlApi.controllerControl(c,{workId:works[1].id,action:'pause',requestKey:'ctl-fifo-hold-1'});
  c.kick();await drain(c);
  assert.deepEqual(works.filter(work=>work.status!=='queued').map(work=>work.name),['seed-work 1','seed-work 3'],'held item skipped in FIFO order');
  assert.equal(c.store.used(),2);
  assert.equal(works.filter(work=>work.status==='queued').length,98,'the held work stays queued');
  const disposition=await f.manager.invoke('managed.disposition',{projectId,workId:works[0].id});
  assert.equal(disposition.discard.allowed,true);
  await c.endWork(works[0].id,{revision:works[0].revision,decision:'discard'});
  await spin(()=>c.store.find(works[0].id).closure?.phase==='complete','closure complete');
  c.kick();
  await spin(()=>c.store.find(works[3].id).status!=='queued','next eligible admitted');
  assert.deepEqual(c.store.state.works.filter(work=>work.status!=='queued'&&work.status!=='ended').map(work=>work.name),['seed-work 3','seed-work 4']);
  assert.equal(c.store.find(works[1].id).status,'queued','held work never force-activated');
  await drain(c);await f.manager.attentionPublish?.get(projectId);
  // Bounded paged reads over the whole ledger: 50-row pages, 64KiB cap.
  let cursor=null,pages=0;const seen=new Set();
  do{
    const page=await f.manager.invoke('managed.collaboration.status',{projectId,limit:50,cursor});
    assert.ok(Buffer.byteLength(JSON.stringify(page))<64*1024);
    for(const agent of page.agents)if(agent.workId){assert.equal(seen.has(agent.workId),false);seen.add(agent.workId);}pages++;cursor=page.nextCursor;
  }while(cursor);
  assert.deepEqual([...seen].sort(),works.slice(1).map(work=>work.id).sort());
  assert.ok(pages>=2&&pages<=3,'bounded page count');
  const stale=await f.manager.invoke('managed.collaboration.status',{projectId,limit:50}).then(value=>value.nextCursor);
  await controlApi.controllerControl(c,{workId:works[4].id,action:'pause',requestKey:'ctl-fifo-hold-2'});
  await assert.rejects(f.manager.invoke('managed.collaboration.status',{projectId,limit:50,cursor:stale}),{code:'COLLABORATION_CURSOR_STALE'});
});

test('1000 queued tasks stay bounded: two activations, paged reads, no polling storms',async t=>{
  const f=await fixture(t),c=f.controller,projectId=f.projectId;
  await seedQueuedWorks(c.store,1000,{limit:2});
  c.kick();await drain(c);
  assert.equal(c.store.state.works.filter(work=>work.status!=='queued').length,2);
  assert.equal(c.store.used(),2);
  await f.manager.attentionPublish?.get(projectId);
  let cursor=null,calls=0;const seen=new Set();
  do{
    const page=await f.manager.invoke('managed.collaboration.status',{projectId,limit:50,cursor});
    assert.ok(Buffer.byteLength(JSON.stringify(page))<64*1024);
    for(const agent of page.agents)if(agent.workId){assert.equal(seen.has(agent.workId),false);seen.add(agent.workId);}calls++;cursor=page.nextCursor;
  }while(cursor);
  assert.deepEqual([...seen].sort(),c.store.state.works.map(work=>work.id).sort());
  assert.equal(calls,20);
});

// ── cold open: no replay, cold pure pause, durable receipts ─────────────────
test('cold reopen replays nothing; cold pure pause touches no controller or owner',async t=>{
  const f=await fixture(t),c=f.controller,projectId=f.projectId;
  const A=await submitWork(c,'Cold A'),B=await submitWork(c,'Cold B');
  f.scriptFor.set(A.id,holdScript);
  c.kick();
  const run=await runningJob(c,A.id);
  const realKick=c.kick.bind(c);c.kick=()=>{};
  const supplement=await c.send(A.id,'cold held supplement',{requestKey:'ctl-cold-supp-1'});
  await controlApi.controllerControl(c,{jobId:supplement.jobId,action:'pause',requestKey:'ctl-cold-hold-1'});
  c.kick=realKick;
  const stop=await controlApi.controllerControl(c,{workId:A.id,action:'stop-current',requestKey:'ctl-cold-stop-1',ownerId:run.session.viewOwnerId,ownerGeneration:run.session.epoch,currentJobId:run.job.id});
  assert.equal(stopStateOf(stop),'confirmed');
  await drain(c);
  const promptsBefore=f.prompts.length;
  await f.manager.stopProject(projectId);
  assert.equal(f.manager.controllers.size,0);
  // Pure reads and pure pause on a disconnected project stay controller-free.
  await controlApi.invokeStatus(f.manager,{projectId,workId:B.id});
  assert.equal(f.manager.controllers.size,0,'status read created no controller');
  const coldPause=await controlApi.invokeBound(f.manager,f.host.project,{projectId,workId:B.id,action:'pause',requestKey:'ctl-cold-pause-1'});
  assert.equal(coldPause.controlApplied.paused,true);
  assert.equal(f.manager.controllers.size,0,'cold pause created no controller or owner');
  const coldCap=await controlApi.invokeStatus(f.manager,{projectId,workId:B.id});
  assert.equal(coldCap.live,false);
  await f.manager.connect(projectId,{enable:true});
  const reopened=f.manager.controllers.get(projectId);
  assert.equal(reopened.store.find(A.id).manualControl?.stop?.state,'confirmed','stop receipt is durable across reopen');
  assert.equal(reopened.store.find(B.id).manualControl?.pause?.requestKey,'ctl-cold-pause-1','offline pause persisted');
  await drain(reopened);
  assert.equal(reopened.store.state.jobs.find(row=>row.id===supplement.jobId).status,'queued','cold held job never replays');
  assert.equal(reopened.store.find(A.id).status,'paused');
  assert.equal(f.prompts.length,promptsBefore,'only resident owners restarted, zero business replay');
  const fresh=await reopened.send('frontdesk','new explicit input after cold reopen',{requestKey:'ctl-cold-fresh-1'});
  await spin(()=>reopened.store.state.jobs.find(row=>row.id===fresh.jobId)?.status==='completed','fresh input completes');
  assert.equal(f.prompts.filter(row=>row.text==='new explicit input after cold reopen').length,1);
  assert.equal(f.prompts.filter(row=>row.text==='cold held supplement').length,0);
});

// ── stop without any owner: persist the gate only ────────────────────────────
test('stop with no owner persists the manual pause and never creates an owner',async t=>{
  const f=await fixture(t),c=f.controller;
  const A=await submitWork(c,'Ownerless A');   // never activated: no kick
  const capabilities=await controlApi.capabilities(c,A.id);
  assert.equal(capabilities.stopCurrent.allowed,false);
  assert.equal(capabilities.stopCurrent.reason,'owner-unavailable');
  let outcome=null;
  try{outcome=await controlApi.controllerControl(c,{workId:A.id,action:'stop-current',requestKey:'ctl-noowner-stop-1'});}
  catch(error){assert.equal(error.code,'WORK_CONTROL_OWNER_UNAVAILABLE');}
  const saved=c.store.find(A.id);
  assert.equal(saved.manualControl?.pause?.requestKey,'ctl-noowner-stop-1','only the manual gate was persisted');
  assert.equal(saved.status,'queued');
  assert.equal(c.sessions.has(A.id),false);
  assert.equal(f.prompts.filter(row=>row.target===A.id).length,0);
  assert.notEqual(stopStateOf(outcome),'confirmed','ownerless stop cannot claim a process exit');
  assert.equal(controlApi.held(c,A.id),true);
});

// ── pure-logic unit tier: idle lifecycle defaults with manual gates ──────────
test('idle lifecycle protects only its exact target while another target stops',async()=>{
  const clock=new FakeClock(),controllers=new Map(),errors=[];
  const lifecycle=new AgentIdleLifecycle({controllers,clock,idleTimeoutMs:100,onError:(id,error)=>errors.push({id,error})});
  const session={closed:false,busy:false,activitySnapshot:()=>({known:true})};
  const controller={stopping:false,store:{},sessions:new Map([['idle',session]]),stops:[],stopFlight:false,
    canReclaimIdle(target,value){return this.sessions.get(target)===value&&!value.busy&&!this.stopFlight;},
    reclaimIdle(target){this.stops.push(target);this.sessions.delete(target);return Promise.resolve(true);}};
  controllers.set('p',controller);
  lifecycle.observe();await drainIdle({idleLifecycle:lifecycle});
  await clock.advance(99,lifecycle);
  assert.deepEqual(controller.stops,[]);
  controller.stopFlight=true;                 // a manual stop flight owns the exit path
  lifecycle.observe();await drainIdle({idleLifecycle:lifecycle});
  await clock.advance(50,lifecycle);
  assert.deepEqual(controller.stops,[],'no idle exit may overlap a stop flight on the same owner');
  controller.stopFlight=false;controller.sessions.set('idle',session);session.busy=false;
  lifecycle.observe();await drainIdle({idleLifecycle:lifecycle});
  await clock.advance(100,lifecycle);
  assert.deepEqual(controller.stops,['idle']);
  assert.deepEqual(errors,[]);
  lifecycle.stop();
});

// ── gateway instance guard: stale replacements have zero effect ─────────────
test('work.control binds the live project instance; a stale replacement never mutates',async t=>{
  const f=await fixture(t),c=f.controller,projectId=f.projectId;
  const work=await submitWork(c,'Instance A');
  const before=await controlApi.capabilities(c,work.id);
  await assert.rejects(controlApi.invokeBound(f.manager,{...f.host.project,instanceId:'replaced-instance-id'},{projectId,workId:work.id,action:'pause',requestKey:'ctl-instance-1'}),error=>error.code==='WORK_CONTROL_INSTANCE_STALE');
  assert.equal(c.store.find(work.id).manualControl?.pause??null,null,'zero durable mutation');
  const after=await controlApi.capabilities(c,work.id);
  assert.equal(after.controlVersion??0,before.controlVersion??0,'zero version movement from the stale request');
  const good=await controlApi.invokeBound(f.manager,f.host.project,{projectId,workId:work.id,action:'pause',requestKey:'ctl-instance-2'});
  assert.equal(good.controlApplied.paused,true);
  await controlApi.invokeBound(f.manager,f.host.project,{projectId,workId:work.id,action:'resume',requestKey:'ctl-instance-3'});
});

// ── gateway parity: job.target binding, capability records, quota-full kick ─
test('gateway control paths bind jobs through job.target and survive full quota',async t=>{
  const f=await fixture(t),c=f.controller,projectId=f.projectId,project=f.host.project;
  const A=await submitWork(c,'Gateway A'),B=await submitWork(c,'Gateway B'),C=await submitWork(c,'Gateway C');
  c.kick();await drain(c);
  // All three controls go through the gateway op, never Controller directly.
  const viaGateway=(payload,requestKey)=>controlApi.invokeBound(f.manager,project,{projectId,requestKey,...payload});
  const realKick=c.kick.bind(c);c.kick=()=>{};
  const supplement=await c.send(B.id,'gateway bound supplement',{requestKey:'gw-supp-1'});
  const pauseJob=await viaGateway({jobId:supplement.jobId,action:'pause'},'ctl-gw-jobbind-1');
  c.kick=realKick;c.kick();await drain(c);
  assert.equal(pauseJob.controlApplied.applied,true);
  assert.equal(controlApi.held(c,B.id),true,'jobId control gates the WORK resolved through job.target');
  const capsWork=await controlApi.invokeStatus(f.manager,{projectId,workId:A.id});
  const capsJob=await controlApi.invokeStatus(f.manager,{projectId,jobId:supplement.jobId});
  for(const caps of [capsWork,capsJob]){
    assert.ok(Number.isSafeInteger(caps.controlVersion),'capability record exposes an integer controlVersion');
    for(const key of ['pause','stopCurrent','resume'])assert.ok(caps[key]!==undefined,'capability descriptor exposes '+key);
  }
  // A+B occupy the limit; resuming the held queued work reports waiting-capacity
  // and the kick must not stall: drain completes, nothing activates.
  const holdC=await viaGateway({workId:C.id,action:'pause'},'ctl-gw-holdc-1');
  assert.equal(holdC.controlApplied.paused,true);
  c.kick();await drain(c);
  assert.equal(c.store.find(C.id).status,'queued');
  const freeC=await viaGateway({workId:C.id,action:'resume'},'ctl-gw-freec-1');
  assert.equal(freeC.executionDisposition.kind,'waiting-capacity');
  await drain(c);
  assert.equal(c.store.find(C.id).status,'queued','full quota never force-activates');
  // Releasing one closure-complete slot lets the SAME kick path admit C.
  const disposition=await f.manager.invoke('managed.disposition',{projectId,workId:A.id});
  assert.equal(disposition.discard.allowed,true);
  await c.endWork(A.id,{revision:c.store.find(A.id).revision,decision:'discard'});
  await spin(()=>c.store.find(A.id).closure?.phase==='complete','closure complete');
  c.kick();
  await spin(()=>c.store.find(C.id).status!=='queued','quota-free resume admits after closure completes');
  assert.equal(controlApi.held(c,supplement.jobId),true,'the job-level gate survives independently of C');
  const freeJob=await viaGateway({jobId:supplement.jobId,action:'resume'},'ctl-gw-freejob-1');
  await drain(c);
  assert.equal(c.store.state.jobs.find(row=>row.id===supplement.jobId).status,'completed');
});

// ── concurrent stop requests during the exit barrier share one outcome ─────
test('duplicate stop requests during the exit barrier settle to one stop',async t=>{
  const f=await fixture(t),c=f.controller;
  const A=await submitWork(c,'DupStop A');
  f.scriptFor.set(A.id,holdScript);
  c.kick();
  const run=await runningJob(c,A.id);
  const stopGate=barrier();
  const originalStop=run.session.stop.bind(run.session);
  run.session.stop=async()=>{await stopGate.promise;return originalStop();};
  const first=controlApi.controllerControl(c,{workId:A.id,action:'stop-current',requestKey:'ctl-dup-stop-1',ownerId:run.session.viewOwnerId,ownerGeneration:run.session.epoch,currentJobId:run.job.id});
  first.catch(()=>{});
  await spin(()=>run.session.interrupts.length>0,'first stop entered the exit path');
  const secondFlight=controlApi.controllerControl(c,{workId:A.id,action:'stop-current',requestKey:'ctl-dup-stop-1',ownerId:run.session.viewOwnerId,ownerGeneration:run.session.epoch,currentJobId:run.job.id});
  stopGate.open();
  const settledFirst=await first;
  const second=await secondFlight;
  assert.equal(stopStateOf(settledFirst),'confirmed');
  assert.equal(stopStateOf(second),'confirmed','the concurrent request settles the SAME stop operation');
  assert.equal(run.session.stops.length,1,'one real owner exit, no duplicate stop');
  const record=c.store.find(A.id).manualControl;
  assert.ok(record.stop&&!Array.isArray(record.stop),'exactly one durable stop record');
  assert.equal(record.stop.state,'confirmed');
  assert.equal(run.session.interrupts.filter(row=>row.stopped).length,1);
  assert.equal(c.sessions.has(A.id),false);
  assert.ok(noStopFabrication(c,run.job.id));
});
