// Permanent service-fault gateway boundary suites (design:
// docs/manual-task-control-repair-design.md §4.2/§7).
//
// ServiceFaults is constructed directly on a REAL DesktopHost + ProjectStorage
// (owned mkdtemp roots through the shared agent-control fixture): every fault
// record, batch checkpoint and CAS goes through real per-project ui.sqlite
// storage — no record store is mocked. The injected seams are exactly the
// production constructor seams: controllers map, sourceRevisionOf,
// modelForTarget, liveEvaluate (a release-effect ledger: counter + JSONL file
// under the owned root, standing in for the Core resume executor with real
// transaction uncertainty between members), retryExpired, clock fn and
// timers {setTimeout,clearTimeout} (FakeClock — the ONE shared deadline wake
// is driven deterministically, never by real sleeps).
//
// Only public behavior is asserted: observe/status/release/results/prime/
// forget/claimRetry/markUnknown/gateFor/summaryFor/updateSourceRevision/
// recordNativeRetry and their DTOs — never source internals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ServiceFaults} from '../src/agents/managed/service-faults.mjs';
import {FakeClock,controlHost} from './agent-control.fixture.mjs';

// ── deterministic deadline driving ─────────────────────────────────────────
// Fires only timers that are due at the (fake) current time, then yields real
// event-loop turns so storage workers and wake flights settle. Conditions are
// observed, never assumed after a fixed number of ticks.
async function settle(fake,cond,label,{step=5,timeout=15000}={}){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    if(cond())return;
    for(const [token,timer] of [...fake.timers])if(timer.at<=fake.time){fake.timers.delete(token);timer.fn();}
    fake.time+=step;
    await new Promise(resolve=>setImmediate(resolve));
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  if(cond())return;
  throw Error('Timed out: '+label);
}

// ── release-effect ledger: the fake external action ────────────────────────
// Counter + append-only JSONL under the owned root. Member crash/failure
// between settlement and fan-out is real transaction uncertainty: the ledger
// is the observable "effect happened exactly once" proof.
async function effectLedger(root){
  const file=path.join(root,'effects','ledger.jsonl');
  await fs.mkdir(path.dirname(file),{recursive:true});
  const counts=new Map();
  return {
    counts,
    async perform(projectId,detail={}){
      const seq=(counts.get(projectId)??0)+1;counts.set(projectId,seq);
      await fs.appendFile(file,JSON.stringify({projectId,seq,faultRef:detail.faultRef??null,generation:detail.generation??null})+'\n');
      return {outcome:'accepted',jobId:detail.jobId??null,workId:detail.workId??null};
    },
    total(){return [...counts.values()].reduce((sum,n)=>sum+n,0);},
    async entries(){return (await fs.readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));},
  };
}

// ── evidence builders (structured fields only, never message text) ─────────
const httpRow=(provider,status)=>({origin:'https://api.'+provider+'.test/v1/chat',pathname:'/v1/chat',method:'POST',status,at:new Date().toISOString(),durationMs:14});
const transient=(provider,model,{willRetry=false,phase='pre-admission',status=503}={})=>({schema:1,phase,provider,model,httpStatus:status,...(willRetry?{willRetry:true}:{}),http:[httpRow(provider,status)]});
const critical=(provider,model,status=401)=>({schema:1,phase:'pre-admission',provider,model,httpStatus:status,http:[httpRow(provider,status)]});
const fact=(evidence,{id='job-fx-1',target='w-fx-1'}={})=>({job:{id,target},evidence,admitted:false,recordConfirmed:false});

/**
 * Real host + real per-project storage, injected boundary seams.
 * models: target -> selector string handed to modelForTarget ('provider/model').
 */
async function faultFixture(t,{members=1,backoffMs=30000,models={},sourceRevisionOf,liveEvaluate,retryExpired,afterRelease}={}){
  const base=await controlHost();
  const projects=[base.project];
  for(let index=1;index<members;index++){
    const dir=path.join(base.out,'member-'+index);
    await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,'paper.txt'),'Synthetic member source '+index+'.\n');
    const picked=await base.host.pick(dir);
    projects.push({...picked.project,instanceId:(await base.host.requireRegisteredProject(picked.project.id)).instanceId});
  }
  const fake=new FakeClock();
  const timerStats={armed:0,executed:0};
  const timers={setTimeout:(fn,delay)=>{timerStats.armed++;return fake.setTimeout(()=>{timerStats.executed++;fn();},delay);},clearTimeout:token=>fake.clearTimeout(token)};
  const effects=await effectLedger(base.out);
  const controllers=new Map(projects.map(project=>[project.id,{projectId:project.id,stopping:false,sessions:new Map(),store:{state:{works:[]}}}]));
  const faults=new ServiceFaults({
    host:base.host,storage:base.host.storage,controllers,
    clock:()=>fake.time,timers,backoffMs,
    sourceRevisionOf:sourceRevisionOf??(async()=>null),
    modelForTarget:(projectId,target)=>models[target]??null,
    liveEvaluate:liveEvaluate??(async(projectId,ctx)=>effects.perform(projectId,ctx)),
    ...(retryExpired?{retryExpired}:{}),
    ...(afterRelease?{afterRelease}:{}),
    listener:()=>{},
  });
  t.after(async()=>{await faults.stop?.();await base.done();});
  for(const project of projects)await faults.prime(project.id);
  return {
    base,projects,fake,timers,timerStats,faults,controllers,effects,
    enable:async projectId=>base.host.storage.putLocal(projectId,'managed:binding',{enabled:true}),
    gate:(projectId,target)=>faults.gateFor(projectId,{id:'job-'+target,target,type:'task'}),
    faultRows:async scope=>(await faults.status(scope??{})).faults,
    releaseRow:async(requestKey,row)=>faults.release({faultRef:row.faultRef,expectedVersion:row.release.expectedVersion,scopeSnapshot:row.release.scopeSnapshot,requestKey}),
  };
}

// ── deterministic clock: two same-deadline faults, one shared wake, delayed
// drain claims each exactly once ────────────────────────────────────────────
test('two faults due at the same deadline share ONE wake and each retry claims exactly once',async t=>{
  let faultsRef=null;
  const wakes=[],claims=[];
  const f=await faultFixture(t,{models:{'w-alpha-one':'alpha/one','w-beta-one':'beta/one'},retryExpired:async(projectId,faultRef)=>{
    wakes.push({projectId,faultRef});
    claims.push(await faultsRef.claimRetry(projectId,faultRef,async()=>({retried:0})));
  }});
  faultsRef=f.faults;
  const pid=f.projects[0].id;
  const first=await f.faults.observe(pid,fact(transient('alpha','alpha/one'),{id:'job-alpha-1',target:'w-alpha-one'}));
  const second=await f.faults.observe(pid,fact(transient('beta','beta/one'),{id:'job-beta-1',target:'w-beta-one'}));
  assert.equal(first.autoUntilMs,second.autoUntilMs,'same observe time => identical backoff deadline');
  assert.equal(f.gate(pid,'w-alpha-one').held,true);
  assert.equal(f.gate(pid,'w-beta-one').held,true);
  assert.equal(f.fake.timers.size,1,'ONE shared deadline timer for two same-deadline faults');
  // Delayed clock: the wake fires long after the deadline; the drain must
  // still settle every due fault exactly once.
  f.fake.time+=5*f.fake.timers.values().next().value.at;
  await settle(f.fake,()=>claims.length===2&&claims.every(claim=>claim.claimed===true),'both due retries claimed through the delayed shared wake');
  assert.equal(f.timerStats.executed,1,'exactly one wake execution drained both due faults');
  assert.equal(wakes.length,2,'the single wake drained every due fault');
  assert.deepEqual(await f.faults.claimRetry(pid,first.faultRef,async()=>({retried:0})),{claimed:false},'already-claimed generation is never claimed twice');
  assert.deepEqual(await f.faults.claimRetry(pid,second.faultRef,async()=>({retried:0})),{claimed:false});
  assert.equal(f.faults.summaryFor(pid).held,true,'retry admission is not proof of service recovery');
  assert.equal(f.faults.gateFor(pid,{id:'job-alpha-1',target:'w-alpha-one',type:'task'}).held,false,'only the claimed original input may retry');
  assert.equal(f.gate(pid,'w-alpha-one').held,true,'unrelated queued inputs stay gated until verified native success');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.fake.timers.size,0,'no future deadline is armed after both windows settle');
  assert.equal(f.timerStats.executed,1,'no second wake appears after settlement');
});

// ── claim settlement must not clear a NEW occurrence's gate ────────────────
test('retry settlement after a new occurrence keeps the fresh backoff gate (version fence)',async t=>{
  let faultsRef=null;
  const done=[];
  const f=await faultFixture(t,{models:{'w-alpha-one':'alpha/one'},retryExpired:async(projectId,faultRef)=>{
    done.push(await faultsRef.claimRetry(projectId,faultRef,async()=>{
      // A new occurrence lands WHILE the claimed retry is executing: the
      // settlement that follows must fence on the fault version and keep the
      // new generation's gate.
      await faultsRef.observe(projectId,fact(transient('alpha','alpha/one'),{id:'job-alpha-2',target:'w-alpha-one'}));
      return {retried:1};
    }));
  }});
  faultsRef=f.faults;
  const pid=f.projects[0].id;
  const observed=await f.faults.observe(pid,fact(transient('alpha','alpha/one'),{id:'job-alpha-1',target:'w-alpha-one'}));
  f.fake.time+=30000;
  await settle(f.fake,()=>done.length===1,'claimed retry settled');
  assert.equal(done[0].claimed,true);
  const gate=f.gate(pid,'w-alpha-one');
  assert.equal(gate.held,true,'the fresh occurrence keeps its gate after the older claim settles');
  assert.equal(gate.reason,'service-fault-backoff');
  assert.equal(f.faults.summaryFor(pid).held,true);
  assert.deepEqual(await f.faults.claimRetry(pid,observed.faultRef,async()=>({retried:0})),{claimed:false},'the settled claim token is not re-claimable');
});

// ── native willRetry diagnostics never gate, alert or escalate ─────────────
test('willRetry observations are diagnostic-only: no gate, no critical, no deadline',async t=>{
  const f=await faultFixture(t,{models:{'w-alpha-one':'alpha/one'}});
  const pid=f.projects[0].id;
  for(let round=1;round<=3;round++){
    await f.faults.observe(pid,fact(transient('alpha','alpha/one',{willRetry:true}),{id:'job-alpha-'+round,target:'w-alpha-one'}));
  }
  assert.equal(f.gate(pid,'w-alpha-one').held,false);
  assert.equal(f.faults.summaryFor(pid).held,false);
  assert.equal(f.timerStats.armed,0,'a recovering fault never arms a deadline wake');
  const status=await f.faults.status();
  assert.equal(status.summary.critical,0);
  assert.deepEqual(status.faults,[],'native retries do not create user fault cards');
  // The settled outcome of the same native loop decides gating.
  const settled=await f.faults.observe(pid,fact(transient('alpha','alpha/one'),{id:'job-alpha-4',target:'w-alpha-one'}));
  assert.equal(settled.gate,true);
  assert.equal(settled.userCritical,false);
  assert.equal(f.gate(pid,'w-alpha-one').reason,'service-fault-backoff');
});

// ── recordNativeRetry: durable diagnostics log, never a gate ───────────────
test('recordNativeRetry journals native retries without creating or clearing any gate',async t=>{
  const f=await faultFixture(t,{models:{'w-alpha-one':'alpha/one'}});
  const pid=f.projects[0].id;
  const retry={type:'auto_retry_start',jobId:'job-native-1',target:'w-alpha-one',ownerId:'native-owner',ownerGeneration:'epoch-1',attempt:1,maxAttempts:3,delayMs:100,provider:'alpha',model:'alpha/one'};
  await f.faults.recordNativeRetry(pid,retry);
  const afterFirst=await f.faults.read(pid);
  assert.equal(afterFirst.record.nativeRetries.length,1,'native retry journaled in the durable diagnostics log');
  assert.equal(f.gate(pid,'w-alpha-one').held,false);
  assert.equal(f.faults.summaryFor(pid).held,false);
  assert.equal((await f.faults.status()).faults.length,0,'a native retry is not a fault');
  await f.faults.observe(pid,fact(transient('alpha','alpha/one'),{id:'job-alpha-1',target:'w-alpha-one'}));
  await f.faults.recordNativeRetry(pid,{...retry,type:'auto_retry_end',success:true});
  assert.equal(f.gate(pid,'w-alpha-one').held,true,'a journaled native retry never releases the settled gate');
  assert.equal((await f.faults.read(pid)).record.nativeRetries.length,2);
});

// ── status storage failure: fail explicitly, retain the gate, fail closed ──
test('a real storage failure during status fails the read and keeps admission fail-closed until re-primed',async t=>{
  const f=await faultFixture(t,{models:{'w-alpha-one':'alpha/one'}});
  const pid=f.projects[0].id,storage=f.base.host.storage;
  await f.faults.observe(pid,fact(transient('alpha','alpha/one'),{id:'job-alpha-1',target:'w-alpha-one'}));
  const heldBefore=f.gate(pid,'w-alpha-one');
  assert.equal(heldBefore.held,true);
  // Real local-state failure through the production lifecycle hold.
  const hold=storage.holdProject(pid,{operationId:'sfc-hold-1',instanceId:f.projects[0].instanceId,action:'clean-local'});
  storage.sealLocal(pid,hold);
  await assert.rejects(f.faults.status(),error=>error.code==='FAULT_STATUS_UNAVAILABLE','a failed durable read must not look like "no faults"');
  assert.equal(f.gate(pid,'w-alpha-one').held,true,'the prior gate is retained, not silently dropped');
  assert.equal(f.gate(pid,'w-alpha-one').reason,'service-fault-backoff');
  await assert.rejects(f.faults.observe(pid,fact(transient('alpha','alpha/one'),{id:'job-alpha-2',target:'w-alpha-one'})),error=>error.code==='PROJECT_LIFECYCLE_ACTIVE');
  f.faults.markUnknown(pid); // the production onServiceFault failure path
  assert.equal(f.gate(pid,'w-alpha-one').held,true);
  assert.equal(f.gate(pid,'w-alpha-one').reason,'service-fault-state-unknown','unknown state blocks admission conservatively');
  await storage.releaseProject(pid,hold);
  const recovered=await f.faults.status(); // readable again…
  assert.equal(recovered.faults.length,1);
  assert.equal(f.gate(pid,'w-alpha-one').reason,'service-fault-state-unknown','…but trust is NOT re-established by a mere read');
  await f.faults.prime(pid); // explicit reconnect priming
  assert.equal(f.gate(pid,'w-alpha-one').reason,'service-fault-backoff','priming re-derives the gate from the durable record');
  assert.equal(f.faults.summaryFor(pid).held,true);
});

// ── per-member release eligibility: manual/unknown members excluded, others
// still complete ────────────────────────────────────────────────────────────
test('release evaluates eligibility per member: manual-hold and disconnected members never execute, peers complete',async t=>{
  const f=await faultFixture(t,{members:3,models:{'w-alpha-one':'alpha/one'},liveEvaluate:async(projectId,ctx)=>{
    if(projectId===f.projects[1].id)return {outcome:'manual-hold',reason:'人工执行门保持，未解除。'};
    if(projectId===f.projects[2].id)throw Error('disconnected member must never be evaluated');
    return f.effects.perform(projectId,ctx);
  }});
  const [A,B,C]=f.projects.map(project=>project.id);
  for(const project of f.projects){
    await f.enable(project.id);
    await f.faults.observe(project.id,fact(transient('alpha','alpha/one'),{id:'job-'+project.id.slice(0,8),target:'w-alpha-one'}));
  }
  f.controllers.delete(C); // third member offline: no controller connection
  const rows=await f.faultRows();
  assert.equal(rows.length,1,'one fault group across members');
  const row=rows[0];
  assert.equal(row.projects.length,3);
  assert.deepEqual(row.projects.map(p=>p.connection).sort(),['live','live','recorded']);
  const receipt=await f.releaseRow('sfc-member-elig-1',row);
  assert.equal(receipt.accepted,1);
  assert.equal(receipt.blocked,2);
  assert.equal(f.effects.counts.get(A)??0,1,'the eligible member executed exactly once');
  assert.equal(f.effects.counts.get(B)??0,0,'the manual-hold member performed no external action');
  assert.equal(f.effects.counts.get(C)??0,0,'the disconnected member performed no external action');
  const results=await f.faults.results({batchRef:receipt.batchRef});
  const outcomeOf=projectId=>results.rows.find(r=>r.projectId===projectId)?.outcome;
  assert.equal(outcomeOf(A),'accepted');
  assert.equal(outcomeOf(B),'manual-hold');
  assert.equal(outcomeOf(C),'project-disconnected');
  assert.equal(f.gate(B,'w-alpha-one').held,false,'manual-hold still released THIS fault for its own member');
  assert.equal(f.gate(A,'w-alpha-one').held,false);
});

// ── exact instance/version/generation verified BEFORE any effect ───────────
test('release verifies member version and instance before any effect and refuses stale scopes',async t=>{
  const f=await faultFixture(t,{members:2,models:{'w-alpha-one':'alpha/one'}});
  const [A,B]=f.projects.map(project=>project.id);
  for(const project of f.projects){
    await f.enable(project.id);
    await f.faults.observe(project.id,fact(transient('alpha','alpha/one'),{id:'job-'+project.id.slice(0,8),target:'w-alpha-one'}));
  }
  const stale=await f.faults.status();
  // A new occurrence bumps member A's fault version after the snapshot.
  await f.faults.observe(A,fact(transient('alpha','alpha/one'),{id:'job-new-occurrence',target:'w-alpha-one'}));
  await assert.rejects(f.releaseRow('sfc-cas-version-1',stale.faults[0]),error=>error.code==='FAULT_VERSION_STALE');
  assert.equal(f.effects.total(),0,'no member effect ran for a stale version');
  assert.equal(f.gate(A,'w-alpha-one').held,true);
  assert.equal(f.gate(B,'w-alpha-one').held,true);
  const fresh=await f.faults.status();
  const tampered=structuredClone(fresh.faults[0]);
  tampered.release.scopeSnapshot[0].instanceId='00000000-0000-0000-0000-000000000000';
  await assert.rejects(f.faults.release({faultRef:tampered.faultRef,expectedVersion:tampered.release.expectedVersion,scopeSnapshot:tampered.release.scopeSnapshot,requestKey:'sfc-cas-instance-1'}),error=>error.code==='FAULT_SCOPE_STALE');
  assert.equal(f.effects.total(),0,'no member effect ran for a stale instance');
  const receipt=await f.releaseRow('sfc-cas-ok-1',fresh.faults[0]);
  assert.equal(receipt.accepted,2);
  assert.equal(f.effects.counts.get(A),1);
  assert.equal(f.effects.counts.get(B),1);
  assert.equal(f.gate(A,'w-alpha-one').held,false);
  assert.equal(f.gate(B,'w-alpha-one').held,false);
  // A recurrence after release starts a NEW generation; the pre-recurrence
  // scope is refused before any effect.
  const recurring=await f.faults.observe(A,fact(transient('alpha','alpha/one'),{id:'job-recurrence',target:'w-alpha-one'}));
  assert.equal(recurring.generation,2,'a recurrence after release opens a new generation');
  await assert.rejects(f.releaseRow('sfc-cas-generation-1',fresh.faults[0]),error=>error.code==='FAULT_VERSION_STALE');
  assert.equal(f.effects.counts.get(A),1,'a stale generation never re-runs member effects');
  assert.equal(f.effects.counts.get(B),1);
});

// ── partial batch: member crash / member write failure; same key resumes
// from merged durable checkpoints with no duplicate effects ────────────────
test('an uncertain member effect never replays while peers complete and same-key receipts remain durable',async t=>{
  const f=await faultFixture(t,{members:2,models:{'w-alpha-one':'alpha/one'},liveEvaluate:async(projectId,ctx)=>{
    const receipt=await f.effects.perform(projectId,ctx);
    if(projectId===f.projects[1].id)throw Error('lost response after external effect');
    return receipt;
  }});
  const [A,B]=f.projects.map(project=>project.id);
  for(const project of f.projects){
    await f.enable(project.id);
    await f.faults.observe(project.id,fact(transient('alpha','alpha/one'),{id:'job-'+project.id.slice(0,8),target:'w-alpha-one'}));
  }
  const row=(await f.faults.status()).faults[0];
  const receipt=await f.releaseRow('sfc-crash-resume-1',row);
  assert.equal(receipt.accepted,1,'the unrelated eligible peer proceeds despite one uncertain effect');
  assert.equal(receipt.blocked,1);
  assert.equal(f.effects.counts.get(A),1);
  assert.equal(f.effects.counts.get(B),1);
  const results=await f.faults.results({batchRef:receipt.batchRef});
  assert.equal(results.rows.find(result=>result.projectId===B).outcome,'needs-reconciliation');
  const replay=await f.releaseRow('sfc-crash-resume-1',row);
  assert.deepEqual(replay,receipt,'same-key replay returns the original settled results');
  assert.equal(f.effects.counts.get(A),1);
  assert.equal(f.effects.counts.get(B),1,'an uncertain effect is never invoked again');
  assert.equal((await f.effects.entries()).length,2);
});

test('a member staging-write failure aborts before any effect and the same key completes after recovery',async t=>{
  const f=await faultFixture(t,{members:2,models:{'w-alpha-one':'alpha/one'}});
  const [A,B]=f.projects.map(project=>project.id);
  for(const project of f.projects){
    await f.enable(project.id);
    await f.faults.observe(project.id,fact(transient('alpha','alpha/one'),{id:'job-'+project.id.slice(0,8),target:'w-alpha-one'}));
  }
  const row=(await f.faults.status()).faults[0];
  const storage=f.base.host.storage;
  const hold=storage.holdProject(B,{operationId:'sfc-stage-hold-1',instanceId:f.projects[1].instanceId,action:'clean-local'});
  storage.sealLocal(B,hold); // real local-state write failure for member B
  await assert.rejects(f.releaseRow('sfc-write-fail-1',row),error=>error.code==='PROJECT_LIFECYCLE_ACTIVE');
  assert.equal(f.effects.total(),0,'a failed member write aborts the batch before any effect');
  await storage.releaseProject(B,hold);
  const receipt=await f.releaseRow('sfc-write-fail-1',row);
  assert.equal(receipt.state,'complete');
  assert.equal(receipt.accepted,2);
  assert.equal(f.effects.counts.get(A),1);
  assert.equal(f.effects.counts.get(B),1);
  assert.equal(f.gate(A,'w-alpha-one').held,false);
  assert.equal(f.gate(B,'w-alpha-one').held,false);
});

// ── source authority and scoping: only the affected provider/model/account ──
test('the gate holds only the affected provider+model, resolved through native session then configured then ledger',async t=>{
  const f=await faultFixture(t,{models:{'w-native':'alpha/one','w-configured':'alpha/two','w-ledger':'alpha/one','w-other':'beta/one'}});
  const pid=f.projects[0].id,controller=f.controllers.get(pid);
  // Native session source wins over every configured fallback.
  controller.sessions.set('w-native',{model:'alpha/two',effective:{model:'alpha/one'},closed:false});
  // Configured modelForTarget wins when no live session exists.
  controller.store.state.works.push({id:'w-ledger',binding:{provider:'pi',model:'alpha/one'}});
  await f.faults.observe(pid,fact(transient('alpha','alpha/one'),{id:'job-alpha-1',target:'w-native'}));
  assert.equal(f.gate(pid,'w-native').held,true,'native effective model decides the source');
  const session=controller.sessions.get('w-native');
  session.effective={model:'alpha/two'};
  assert.equal(f.gate(pid,'w-native').held,false,'a rotated native selection leaves the fault scope');
  assert.equal(f.gate(pid,'w-configured').held,false,'configured alpha/two is outside the alpha/one fault scope');
  assert.equal(f.gate(pid,'w-other').held,false,'an unaffected provider is never gated');
  assert.equal(f.gate(pid,'w-ledger').held,true,'the work ledger binding is the last-resort source');
  assert.equal(f.faults.gateFor(pid,{id:'job-maint',target:'w-native',type:'maintenance'}),null,'maintenance jobs bypass the fault gate');
  assert.deepEqual(Object.keys(f.gate(pid,'w-ledger')).sort(),['held','reason','source'],'held gate verdicts carry the resolved source');
  assert.equal(f.gate(pid,'w-ledger').source.provider,'alpha');
  assert.equal(f.gate(pid,'w-ledger').source.model,'alpha/one');
});

// ── credential rotation: new account identity, fresh gate, old fault never
// blocks the rotated credentials ────────────────────────────────────────────
test('credential rotation starts a fresh fault identity and the old account fault stops gating',async t=>{
  const revisions=new Map([['alpha',1]]);
  const f=await faultFixture(t,{models:{'w-alpha-one':'alpha/one'},sourceRevisionOf:async provider=>revisions.get(provider)??null});
  const pid=f.projects[0].id;
  await f.enable(pid);
  const oldFault=await f.faults.observe(pid,fact(transient('alpha','alpha/one'),{id:'job-alpha-1',target:'w-alpha-one'}));
  // Rotate credentials: the configured source revision bumps.
  revisions.set('alpha',2);
  f.faults.updateSourceRevision('alpha',2);
  const rotatedFault=await f.faults.observe(pid,fact(transient('alpha','alpha/one'),{id:'job-alpha-2',target:'w-alpha-one'}));
  assert.notEqual(rotatedFault.faultRef,oldFault.faultRef,'rotated credentials produce a NEW fault identity');
  assert.equal(rotatedFault.generation,1,'the rotated identity starts a fresh generation');
  assert.equal(rotatedFault.userCritical,false);
  const rows=await f.faultRows();
  assert.equal(rows.length,2);
  const accounts=rows.map(r=>r.source.accountConfigId);
  assert.notEqual(accounts[0],accounts[1],'account-config identity follows the source revision');
  const oldRow=rows.find(r=>r.faultRef===oldFault.faultRef),rotatedRow=rows.find(r=>r.faultRef===rotatedFault.faultRef);
  assert.equal(rotatedRow.occurrenceCount,1,'no backoff history is inherited across rotation');
  assert.equal(f.gate(pid,'w-alpha-one').held,true,'the rotated account has its own fresh gate');
  // Releasing the OLD fault never unblocks the rotated account's gate…
  await f.releaseRow('sfc-rotation-old-1',oldRow);
  assert.equal(f.gate(pid,'w-alpha-one').held,true);
  // …and after the rotated fault is released the old fault — still active on
  // its own record — no longer gates the rotated credentials.
  await f.releaseRow('sfc-rotation-new-1',rotatedRow);
  assert.equal(f.gate(pid,'w-alpha-one').held,false,'a fault from the pre-rotation account never gates rotated credentials');
});

// ── status pagination: critical first, complete across all pages ───────────
test('status pages put critical faults first and the cursor walks every fault exactly once',async t=>{
  const f=await faultFixture(t,{members:2,models:{}});
  const [p1,p2]=f.projects.map(project=>project.id);
  await f.faults.observe(p1,fact(critical('gamma','gamma/one'),{id:'job-gamma-1',target:'w-gamma-one'}));
  await f.faults.observe(p1,fact(transient('alpha','alpha/one'),{id:'job-alpha-1',target:'w-alpha-one'}));
  await f.faults.observe(p2,fact(critical('eps','eps/one',429),{id:'job-eps-1',target:'w-eps-one'}));
  await f.faults.observe(p2,fact(transient('delta','delta/one'),{id:'job-delta-1',target:'w-delta-one'}));
  await f.faults.observe(p2,fact(transient('zeta','zeta/one'),{id:'job-zeta-1',target:'w-zeta-one'}));
  const full=await f.faults.status({limit:50});
  assert.equal(full.faults.length,5);
  assert.equal(full.summary.critical,2);
  assert.equal(full.nextCursor,null);
  // Walk every page with a small limit.
  const pages=[];let cursor=null,guard=0;
  do{
    const page=await f.faults.status({cursor,limit:2});
    pages.push(page);cursor=page.nextCursor;
    assert.ok(page.faults.length<=2);
    assert.ok(guard++<6,'pagination must terminate');
  }while(cursor);
  const walked=pages.flatMap(page=>page.faults);
  assert.equal(walked.length,5);
  assert.equal(new Set(walked.map(r=>r.faultRef)).size,5,'each fault appears on exactly one page');
  assert.deepEqual(new Set(walked.map(r=>r.faultRef)),new Set(full.faults.map(r=>r.faultRef)),'pages cover the complete fault set');
  assert.equal(pages[0].faults.length,2);
  assert.ok(pages[0].faults.every(r=>r.userCritical===true),'the first page leads with critical faults');
  const keyOf=row=>[row.userCritical?1:0,row.lastAt,row.faultRef];
  for(let index=1;index<walked.length;index++){
    const prior=keyOf(walked[index-1]),next=keyOf(walked[index]);
    const descending=prior[0]>next[0]||prior[0]===next[0]&&prior[1]>next[1]||prior[0]===next[0]&&prior[1]===next[1]&&prior[2]<next[2];
    assert.ok(descending,'page order keeps criticality/time descending, faultRef ascending');
  }
  assert.ok(walked.slice(0,2).every(r=>r.userCritical)&&walked.slice(2).every(r=>!r.userCritical),'all critical faults precede transient faults across pages');
  // A state change invalidates an outstanding cursor explicitly.
  const firstPage=await f.faults.status({limit:2});
  await f.faults.observe(p1,fact(transient('alpha','alpha/one'),{id:'job-alpha-2',target:'w-alpha-one'}));
  await assert.rejects(f.faults.status({cursor:firstPage.nextCursor,limit:2}),error=>error.code==='FAULT_CURSOR_STALE');
  // A cursor may not cross scopes.
  await assert.rejects(f.faults.status({projectId:p1,cursor:firstPage.nextCursor,limit:2}),error=>error.code==='FAULT_CURSOR_STALE');
  const scoped=await f.faults.status({projectId:p1});
  assert.equal(scoped.scope,p1);
  assert.equal(scoped.faults.length,2,'project scope lists only its own faults');
});

test('pending members and new inputs stay gated until their own durable release claim',async t=>{
  let first=true;
  const f=await faultFixture(t,{members:2,models:{'w-alpha-one':'alpha/one'},liveEvaluate:async(projectId,ctx)=>{
    if(first){
      first=false;
      const pending=f.projects.find(project=>project.id!==projectId).id;
      const verdict=(id,jobId)=>f.faults.gateFor(id,{id:jobId,target:'w-alpha-one',type:'task'});
      assert.equal(verdict(pending,'job-'+pending.slice(0,8)).held,true,'pending original input has no execution claim');
      assert.equal(verdict(pending,'new-pending-input').held,true,'new pending input cannot inherit another member claim');
      assert.equal(verdict(projectId,'job-'+projectId.slice(0,8)).held,false,'the claimed frozen original input is authorized');
      assert.equal(verdict(projectId,'new-claimed-project-input').held,true,'authorization is not project-wide');
    }
    return f.effects.perform(projectId,ctx);
  }});
  for(const project of f.projects){await f.enable(project.id);await f.faults.observe(project.id,fact(critical('alpha','alpha/one'),{id:'job-'+project.id.slice(0,8),target:'w-alpha-one'}));}
  const receipt=await f.releaseRow('sfc-claim-scope-1',(await f.faults.status()).faults[0]);
  assert.equal(receipt.accepted,2);
  assert.equal(f.effects.total(),2);
});

test('released higher-version peers do not invalidate the active release capability',async t=>{
  const f=await faultFixture(t,{members:2,models:{'w-alpha-one':'alpha/one'}});
  const [A,B]=f.projects.map(project=>project.id);
  for(const project of f.projects)await f.enable(project.id);
  for(let index=0;index<5;index++)await f.faults.observe(A,fact(critical('alpha','alpha/one'),{id:'job-a-'+index,target:'w-alpha-one'}));
  await f.faults.observe(B,fact(critical('alpha','alpha/one'),{id:'job-b-1',target:'w-alpha-one'}));
  await f.releaseRow('sfc-mixed-initial',(await f.faults.status()).faults[0]);
  await f.faults.observe(B,fact(critical('alpha','alpha/one'),{id:'job-b-2',target:'w-alpha-one'}));
  const row=(await f.faults.status()).faults[0];
  assert.ok(row.version>row.release.scopeSnapshot[0].version,'display includes a higher historical version');
  assert.equal(row.release.expectedVersion,Math.max(...row.release.scopeSnapshot.map(member=>member.version)));
  const receipt=await f.releaseRow('sfc-mixed-next',row);
  assert.equal(receipt.accepted,1);
  assert.equal(f.effects.counts.get(A),1,'released peer is not executed again');
  assert.equal(f.effects.counts.get(B),2);
});
