// Opt-in live qualification for manual work control: real private Pi owners,
// real bash tool side effects, real files, real Git; scripted loopback provider
// only (no paid model, no personal credentials, no real accounts).
// Covers design §5/§7/§9 acceptance rows: production stop of a tool-running
// owner with exit confirmation, peer survival, sleeping resume without new
// prompts, idle reclaim under the shortened production constructor, cold
// no-replay + cold pure pause, and the real-HTTP cross-project fault release:
// read-only prime, durable partial receipts (no replay of settled members),
// idempotency, drift rejection, generation fences from real HTTP statuses
// (402/503/401), a queued peer and durable batch reads.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopHost} from '../src/main/host.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {resolveBundledPiRuntime} from '../src/agents/managed/pi-runtime.mjs';
import {createNozeliPiSource} from '../src/agents/managed/pi-source.mjs';
import {runGit} from '../src/agents/managed/git-runtime.mjs';
import {writePiModels,liveResult,until,stopStateOf} from './agent-control.fixture.mjs';
import {serve} from './pi-provider.fixture.mjs';

const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-agent-control-pi-'));
const config=path.join(out,'private');
const rootA=path.join(out,'project-a'),rootB=path.join(out,'project-b');
const profile=path.join(config,'desktop');
const lineDelayMs=80;
const longScript=`i=0; while [ ! -f control-release ]; do i=$((i+1)); printf 'progress %s\\n' $i >> control-progress.log; sleep ${(lineDelayMs/1000).toFixed(3)}; done`;
const sentinelScript=`printf 'sentinel ready\\n' > sentinel.log; printf 'sentinel payload\\n' >> sentinel.log`;
await fs.mkdir(rootA,{recursive:true});await fs.mkdir(rootB,{recursive:true});
for(const root of [rootA,rootB]){
  await fs.writeFile(path.join(root,'paper.txt'),'Original synthetic source.\n');
  await fs.writeFile(path.join(root,'.gitignore'),'/.nozeli/\n/build/\n');
  const git=async(...args)=>(await runGit(root,args)).toString().trim();
  await git('init','-b','main');await git('config','user.name','Synthetic Control');await git('config','user.email','control@localhost');await git('add','--all');await git('commit','-m','Synthetic baseline');
}
const host=new DesktopHost(profile);
const projectA=await host.requireRegisteredProject((await host.pick(rootA)).project.id),projectB=await host.requireRegisteredProject((await host.pick(rootB)).project.id);
const source=createNozeliPiSource({root:config});
const result=liveResult(out,'Actual DesktopHost/ManagedProjects with private native Pi owners, real bash side effects and real loopback HTTP faults (402/503/401); no paid model or personal credentials');

// One real provider endpoint keyed by the task markers that reach it through
// the genuine pipeline. HTTP statuses are the ONLY classification input.
const failA={on:true},failB={on:true},failA2={on:true};
const failFault={'FAULT-A':()=>failA.on,'FAULT-A2':()=>failA2.on,'FAULT-B':()=>failB.on,'GATE-A':()=>false,'GATE-C':()=>false,'TRANSIENT-A':()=>true,'AUTH-B':()=>true};
const statusFor={'FAULT-A':402,'FAULT-B':402,'FAULT-A2':402,'TRANSIENT-A':503,'AUTH-B':401};
const workerSteps=new Map();
const step=key=>workerSteps.set(key,(workerSteps.get(key)??0)+1);
const concurrentFaults=new Set();let releaseFaultResponses;
const faultResponsesReady=new Promise(resolve=>{releaseFaultResponses=resolve;});
const provider=await serve(async request=>{
  assert(provider.requests.length<96,'bounded native/model flow');
  const text=request.messages.map(message=>typeof message.content==='string'?message.content:(message.content??[]).map(part=>part.text??'').join('\n')).join('\n');
  const names=request.tools?.map(tool=>tool.function?.name)??[];
  if(names.includes('nozeli_dispatch')&&/TASK-CONTROL/.test(text)){
    const marker=[...text.matchAll(/TASK-CONTROL (STOP-A|SENTINEL|GATE-A|GATE-C|FAULT-A2|FAULT-A|FAULT-B|TRANSIENT-A|AUTH-B):/g)].at(-1)?.[1];
    assert(marker,'dispatch must carry a scenario marker');
    return {id:'dispatch-'+marker,tool:'nozeli_dispatch',args:{name:'Work '+marker,brief:`Scenario ${marker}: perform the assigned real file operations through native bash and publish once. Marker ${marker} identifies this Work.`}};
  }
  if(names.includes('nozeli_publish')){
    const marker=[...text.matchAll(/Marker (STOP-A|SENTINEL|GATE-A|GATE-C|FAULT-A2|FAULT-A|FAULT-B|TRANSIENT-A|AUTH-B)/g)].map(row=>row[1]).at(-1);
    if(marker&&failFault[marker]){
      if(failFault[marker]()){
        if(marker==='FAULT-A'||marker==='FAULT-B'){
          concurrentFaults.add(marker);if(concurrentFaults.size===2)releaseFaultResponses();
          await faultResponsesReady;
        }
        const status=statusFor[marker];
        const body=status===503?{message:'service unavailable',type:'service_unavailable'}:status===401?{message:'unauthorized',type:'authentication_error'}:{message:'insufficient balance',type:'insufficient_balance'};
        return {status,error:body};
      }
      const key='recover-'+marker;step(key);  // GATE-A lands here once the gate clears
      if(workerSteps.get(key)===1)return {id:key+'-bash',tool:'bash',args:{command:`printf 'recovered ${marker}\\n' > recovered-${marker}.txt`}};
      return {id:key+'-publish',tool:'nozeli_publish',args:{kind:'result',content:`<h1>Recovered ${marker}</h1><p>Queue re-kick completed the original input; no new prompt was synthesized.</p>`,files:[]}};
    }
    if(marker==='SENTINEL'){
      const key='sentinel';step(key);
      if(workerSteps.get(key)===1)return {id:'sentinel-bash',tool:'bash',args:{command:sentinelScript}};
      return {id:'sentinel-publish',tool:'nozeli_publish',args:{kind:'result',content:'<h1>Sentinel peer survived</h1><p>The unrelated peer completed its own real tool work and publication.</p>',files:[]}};
    }
    if(marker==='STOP-A'){
      const key='stop-a';step(key);
      if(workerSteps.get(key)===1)return {id:'stop-long-bash',tool:'bash',args:{command:longScript}};
      throw Error('STOP-A worker must never get a second turn');
    }
  }
  return {text:'Host receipts are authoritative. No new business input is synthesized.'};
});
let manager=null;
const ownerPids=new Set();
const collectPids=()=>{for(const controller of manager?.controllers?.values()??[])for(const session of controller.sessions.values())if(session.pid)ownerPids.add(session.pid);};
const stateOf=async projectId=>(await manager.invoke('managed.status',{projectId})).state;
const workOf=async(projectId,name)=>until(async()=>{const state=await stateOf(projectId);return state.works.find(work=>work.name===name);},'Work '+name);
const controlStatus=async(projectId,workId)=>manager.invoke('managed.work.control.status',{projectId,workId});
const controlVersionOf=caps=>{if(!Number.isSafeInteger(caps?.controlVersion))throw Error('control.status must expose an integer controlVersion');return caps.controlVersion;};
const faultStatus=async()=>manager.invoke('managed.fault.status',{});
const quiet=async()=>{while(manager?.busy())await new Promise(resolve=>setTimeout(resolve,25));};
try{
  await writePiModels(source.agentDir,provider.url);
  source.modelFor=async()=>'control-local/scripted';
  source.roleDefaultsFor=async()=>({selector:'control-local/scripted',effort:'off'});
  const runtime=await resolveBundledPiRuntime({piHome:source.agentDir});
  const events=[];manager=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()},piSource:source,piRuntime:runtime,idleTimeoutMs:1200,serviceFaultBackoffMs:40});
  manager.onEvent(event=>{if(event.kind==='managed-error')events.push(event.text);});
  await manager.processBudget.save(4);
  result.managerEvents=events;

  // ── 1. production stop of a tool-running owner; peer survives ────────────
  await manager.connect(projectA.id,{enable:true});
  await manager.connect(projectB.id,{enable:true});
  await manager.invoke('managed.limit',{projectId:projectA.id,limit:6});
  await manager.invoke('managed.limit',{projectId:projectB.id,limit:6});
  await manager.invoke('managed.task',{projectId:projectA.id,text:'TASK-CONTROL STOP-A: run the long real progress script through native bash, then publish.',requestKey:'live-stop-a-task'});
  await manager.invoke('managed.task',{projectId:projectB.id,text:'TASK-CONTROL SENTINEL: write sentinel.log through native bash and publish once.',requestKey:'live-sentinel-task'});
  const stopWork=await workOf(projectA.id,'Work STOP-A');
  const stopDirectory=await until(async()=>(await stateOf(projectA.id)).works.find(work=>work.id===stopWork.id)?.execution?.directory,'Worker execution directory');
  await until(async()=>(await fs.readFile(path.join(stopDirectory,'control-progress.log'),'utf8').then(value=>value.trim().split('\n').length).catch(()=>0))>=8,'long side effect running');
  collectPids();
  const liveStatus=await controlStatus(projectA.id,stopWork.id);
  assert.ok(liveStatus.binding?.ownerId&&typeof liveStatus.binding.ownerGeneration==='string'&&liveStatus.binding.currentJobId,'live capabilities expose the exact native owner binding');
  const owner=liveStatus.binding;
  const stop=await manager.invoke('managed.work.control',{projectId:projectA.id,workId:stopWork.id,action:'stop-current',requestKey:'live-stop-a-1',expectedProjectInstanceId:projectA.instanceId,expectedControlVersion:controlVersionOf(liveStatus),expectedWorkRevision:liveStatus.workRevision,ownerId:owner.ownerId,ownerGeneration:owner.ownerGeneration,currentJobId:owner.currentJobId});
  assert.equal(stopStateOf(stop),'confirmed');
  assert.equal(stop.controlApplied.stop.exit.confirmed,true);
  const exitPid=stop.controlApplied.stop.exit.pid;
  assert.ok(Number.isInteger(exitPid));
  await until(()=>{try{process.kill(exitPid,0);return false;}catch(error){return error.code==='ESRCH';}},'stopped owner pid exited');
  const frozen=(await fs.readFile(path.join(stopDirectory,'control-progress.log'),'utf8')).trim().split('\n').length;
  const stoppedState=await stateOf(projectA.id);
  const stoppedWork=stoppedState.works.find(work=>work.id===stopWork.id);
  assert.equal(stoppedWork.status,'paused','stop never ends the Work');
  assert.equal(stoppedWork.manualControl?.stop?.state,'confirmed','durable stop receipt');
  assert.ok(stoppedWork.threadId,'original native thread retained');
  assert.ok(!stoppedState.receipts.some(row=>row.workId===stopWork.id&&row.origin==='host-diagnostic'),'no fabricated missing-report recovery');
  result.threadA=stoppedWork.threadId;
  const sentinel=await until(async()=>{const state=await stateOf(projectB.id);const work=state.works.find(row=>row.name==='Work SENTINEL');return work?.status==='review'?work:null;},'unrelated peer publishes normally');
  await until(async()=>(await fs.readFile(path.join(sentinel.execution.directory,'sentinel.log'),'utf8').catch(()=>''))==='sentinel ready\nsentinel payload\n','sentinel side effect complete');
  const requestsAtFreeze=provider.requests.length;
  await new Promise(resolve=>setTimeout(resolve,3*lineDelayMs));
  assert.equal((await fs.readFile(path.join(stopDirectory,'control-progress.log'),'utf8')).trim().split('\n').length,frozen,'no late side effects after confirmed stop');
  assert.equal(await fs.stat(path.join(stopDirectory,'control-release')).then(()=>true,()=>false),false,'the producer barrier was never opened: stop interrupted it');
  result.checks.push('production stop cancels a real tool-running owner with confirmed exit, frozen side effects and no fabricated recovery (requests '+requestsAtFreeze+')');

  // ── 2. sleeping resume without synthesized input; idle reclaim ───────────
  const requestsAfterStop=provider.requests.length;
  const resumeCaps=await controlStatus(projectA.id,stopWork.id);
  const resume=await manager.invoke('managed.work.control',{projectId:projectA.id,workId:stopWork.id,action:'resume',requestKey:'live-resume-a-1',expectedProjectInstanceId:projectA.instanceId,expectedControlVersion:controlVersionOf(resumeCaps),expectedWorkRevision:resumeCaps.workRevision});
  assert.equal(resume.controlApplied.paused,false);
  assert.equal(resume.executionDisposition.kind,'no-pending-input','nothing admissible: no continue prompt is invented');
  await quiet();
  assert.equal(provider.requests.length,requestsAfterStop,'resume triggered zero model turns');
  const controllerA=manager.controllers.get(projectA.id);
  const controllerB=manager.controllers.get(projectB.id);
  collectPids();
  await until(()=>[controllerA,controllerB].every(controller=>controller.sessions.size===0&&controller.reclaiming.size===0),'idle owners reclaimed under the shortened production constructor');
  for(const pid of ownerPids){assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH','every observed owner pid is gone');}
  result.checks.push('resume releases only the gate; continuous safe idle reclaims native owners');

  // ── 3. cold reopen: no replay; cold pure pause without a controller ──────
  await manager.stopProject(projectA.id);
  const coldRead=await controlStatus(projectA.id,stopWork.id);
  assert.equal(manager.controllers.size,1,'cold status read creates no controller (B still live)');
  assert.equal(coldRead.live,false);
  const coldPause=await manager.invoke('managed.work.control',{projectId:projectA.id,workId:stopWork.id,action:'pause',requestKey:'live-cold-pause-1',expectedWorkRevision:coldRead.workRevision,expectedControlVersion:controlVersionOf(coldRead),expectedProjectInstanceId:projectA.instanceId});
  assert.equal(coldPause.controlApplied.paused,true);
  assert.equal(manager.controllers.size,1,'cold pause created no controller or owner');
  const requestsBeforeReopen=provider.requests.length;
  await manager.connect(projectA.id,{enable:true});
  await quiet();
  assert.equal(provider.requests.length,requestsBeforeReopen,'cold reopen replays no business turn');
  const reopened=await stateOf(projectA.id);
  assert.equal(reopened.works.find(work=>work.id===stopWork.id).manualControl?.pause?.requestKey,'live-cold-pause-1');
  assert.equal(reopened.works.find(work=>work.id===stopWork.id).manualControl?.stop?.state,'confirmed');
  result.checks.push('cold reopen keeps no-replay and offline pause durable without controller creation');

  // ── 4. real-HTTP fault: prime, post-entry reconcile, pre-prompt gate ──
  const requestsAtPrime=provider.requests.length;
  const prime=await faultStatus();
  assert.equal(prime.faults.length,0,'fault prime reads nothing before any failure');
  assert.equal(provider.requests.length,requestsAtPrime,'prime never touches the provider');
  await manager.invoke('managed.task',{projectId:projectA.id,text:'TASK-CONTROL FAULT-A: publish the recovered marker file.',requestKey:'live-fault-a-1'});
  await manager.invoke('managed.task',{projectId:projectB.id,text:'TASK-CONTROL FAULT-B: publish after the service recovers.',requestKey:'live-fault-b-1'});
  const fault=await until(async()=>{const status=await faultStatus();return status.faults.find(row=>row.projects.length===2&&row.projects.some(member=>member.projectId===projectA.id)&&row.projects.some(member=>member.projectId===projectB.id));},'both projects aggregated into one real service fault');
  assert.equal(fault.category,'balance','402 classifies as balance from the real status');
  assert.equal(fault.generation,1);
  assert.equal(typeof fault.source.provider,'string','source provider identity recorded');assert.ok(fault.source.endpointOrigin,'endpoint origin recorded without secrets');
  const faultAWork=await workOf(projectA.id,'Work FAULT-A');
  // Pre-prompt gate smoke: a NEW input submitted while the fault is active must
  // stay queued with its exact text preserved and spend zero provider calls.
  const requestsBeforeGate=provider.requests.length;
  const rootC=path.join(out,'project-c');await fs.mkdir(rootC);await fs.writeFile(path.join(rootC,'paper.txt'),'Synthetic peer input.\n');
  const gitC=async(...args)=>runGit(rootC,args);
  await gitC('init','-b','main');await gitC('config','user.name','Synthetic Peer');await gitC('config','user.email','peer@localhost');await gitC('add','--all');await gitC('commit','-m','Synthetic peer baseline');
  const projectC=await host.requireRegisteredProject((await host.pick(rootC)).project.id);
  await manager.connect(projectC.id,{enable:true});
  const peerInput=await manager.invoke('managed.task',{projectId:projectC.id,text:'TASK-CONTROL GATE-C: run this original input after the shared service recovers.',requestKey:'live-gate-c-1'});
  const gateSubmission=await manager.invoke('managed.task',{projectId:projectA.id,text:'TASK-CONTROL GATE-A: publish the gated marker file.',requestKey:'live-gate-a-1'});
  const gateJobId=gateSubmission.jobId;
  await until(async()=>{const status=await faultStatus();const member=status.faults.find(row=>row.faultRef===fault.faultRef)?.projects.find(row=>row.projectId===projectA.id);return member?.blockedJobs?.includes(gateJobId)===true;},'gated intake job joins the fault scope pre-prompt');
  await quiet();
  assert.equal(provider.requests.length,requestsBeforeGate,'the fault gate admits no prompt for the queued input');
  const gateIntake=(await stateOf(projectA.id)).jobs.find(job=>job.id===gateJobId);
  assert.ok(gateIntake&&gateIntake.status==='queued','gated input preserved verbatim in the queue');
  assert.ok(/GATE-A/.test(gateIntake.text));
  assert.equal((await stateOf(projectC.id)).jobs.find(job=>job.id===peerInput.jobId).status,'queued','an unfaulted peer shares the same source fence');
  // Fresh snapshot so the gated member belongs to the release scope.
  const scoped=await until(async()=>{const status=await faultStatus();const row=status.faults.find(item=>item.faultRef===fault.faultRef);return row?.release?.available?row:null;},'fresh release capability');
  assert.ok(scoped.release.scopeSnapshot,'exact host-issued snapshot');
  await manager.stopProject(projectB.id);           // real member barrier: B disconnects
  failA.on=false;                                   // the real endpoint for A recovers
  const release=await manager.invoke('managed.fault.release',{faultRef:scoped.faultRef,expectedVersion:scoped.release.expectedVersion,scopeSnapshot:scoped.release.scopeSnapshot,requestKey:'live-fault-release-1'});
  assert.ok(release.batchRef);
  const releaseRows=async()=>(await manager.invoke('managed.fault.results',{batchRef:release.batchRef})).rows;
  const rowsAfterRelease=await releaseRows();
  assert.equal(rowsAfterRelease.find(row=>row.workId===faultAWork.id)?.outcome,'needs-reconciliation','post-entry 402 requires explicit reconciliation, never auto-retry');
  assert.equal(rowsAfterRelease.find(row=>row.jobId===gateJobId)?.outcome,'accepted','safe pre-prompt member is requeued by the release itself');
  const outcomesB=release.results.find(row=>row.projectId===projectB.id);
  assert.equal(outcomesB?.outcome,'project-disconnected','disconnected member reports honestly');
  // The gated input executes EXACTLY once through the real queue re-kick.
  const gateWork=await workOf(projectA.id,'Work GATE-A');
  await until(async()=>{const state=await stateOf(projectA.id);return state.works.find(work=>work.id===gateWork.id)?.status==='review';},'gated work resumed and published after release');
  const gateDirectory=(await stateOf(projectA.id)).works.find(work=>work.id===gateWork.id).execution.directory;
  await until(async()=>(await fs.readFile(path.join(gateDirectory,'recovered-GATE-A.txt'),'utf8').catch(()=>''))==='recovered GATE-A\n','gated effect executed through real native bash');
  assert.equal(workerSteps.get('recover-GATE-A'),2,'the released queued input executed exactly once (bash+publish)');
  const peerWork=await until(async()=>(await stateOf(projectC.id)).works.find(work=>work.name==='Work GATE-C'&&work.status==='review'),'shared-source recovery wakes the already-connected unfaulted peer');
  assert.equal(await fs.readFile(path.join(peerWork.execution.directory,'recovered-GATE-C.txt'),'utf8'),'recovered GATE-C\n');
  assert.equal(workerSteps.get('recover-GATE-C'),2,'the peer original input executes only once');
  result.checks.push('shared-source recovery wakes an already-connected queued peer without inventing a recovery prompt or connecting another project');
  // The admitted (post-entry) failure is NOT retried by the release.
  const afterFaultA=await stateOf(projectA.id);
  assert.notEqual(afterFaultA.works.find(work=>work.id===faultAWork.id).status,'review','post-entry failure stays unreconciled');
  assert.equal(await fs.stat(path.join(faultAWork.execution.directory,'recovered-FAULT-A.txt')).then(()=>true,()=>false),false,'no silent re-execution of the admitted failure');
  assert.equal((await faultStatus()).faults.filter(row=>row.faultRef===fault.faultRef).length,0,'explicit release clears the resolved source gate without replaying failed inputs');
  // Checkpoint resume with the SAME key once B is back: finished members freeze.
  await manager.connect(projectB.id,{enable:true});
  const resumedBatch=await manager.invoke('managed.fault.release',{faultRef:scoped.faultRef,expectedVersion:scoped.release.expectedVersion,scopeSnapshot:scoped.release.scopeSnapshot,requestKey:'live-fault-release-1'});
  assert.deepEqual(resumedBatch,release,'same key returns the original receipt even after reconnection');
  const resumedRows=await manager.invoke('managed.fault.results',{batchRef:release.batchRef});
  assert.equal(resumedRows.rows.find(row=>row.jobId===gateJobId).outcome,'accepted','settled original input is not repeated');
  assert.equal(resumedRows.rows.find(row=>row.projectId===projectB.id)?.outcome,'project-disconnected','reconnection does not silently extend a settled batch');
  assert.equal(workerSteps.get('recover-GATE-A'),2,'member effect count frozen across resume');
  assert.equal(await fs.stat(path.join(rootB,'recovered-FAULT-B.txt')).then(()=>true,()=>false),false,'no auto execution for the reconnected admitted failure');
  const requestsAfterResume=provider.requests.length;
  const replay=await manager.invoke('managed.fault.release',{faultRef:scoped.faultRef,expectedVersion:scoped.version,scopeSnapshot:scoped.release.scopeSnapshot,requestKey:'live-fault-release-1'});
  assert.deepEqual(replay.results,resumedBatch.results,'same key returns the current batch receipt');
  await manager.invoke('managed.fault.release',{faultRef:scoped.faultRef,expectedVersion:scoped.version+9,scopeSnapshot:scoped.release.scopeSnapshot,requestKey:'live-fault-release-2'}).then(()=>{throw Error('version drift must reject');},error=>assert.equal(error.code,'FAULT_VERSION_STALE'));
  await manager.invoke('managed.fault.release',{faultRef:scoped.faultRef,expectedVersion:scoped.release.expectedVersion,scopeSnapshot:{tampered:true},requestKey:'live-fault-release-3'}).then(()=>{throw Error('invalid scope must reject');},error=>assert.equal(error.code,'INVALID_PAYLOAD'));
  await quiet();
  assert.equal(provider.requests.length,requestsAfterResume,'idempotent replay and drift rejections spend zero members');
  const batch=await manager.invoke('managed.fault.results',{batchRef:release.batchRef});
  const batchIds=batch.rows.map(row=>JSON.stringify(row));
  assert.equal(new Set(batchIds).size,batchIds.length,'no duplicate member rows');
  result.batchRef=release.batchRef;
  result.checks.push('release requeues only safe pre-prompt members (exactly once), keeps post-entry 402/503 at explicit needs-reconciliation with a single fault entry, and checkpoints real disconnections');

  // Same identity recurrence is 402 again; 503 and 401 are distinct categories.
  await manager.invoke('managed.task',{projectId:projectA.id,text:'TASK-CONTROL FAULT-A2: publish the second recovered marker.',requestKey:'live-fault-a2-1'});
  const generationRow=await until(async()=>{const status=await faultStatus();return status.faults.find(item=>item.faultRef===fault.faultRef&&item.generation>fault.generation);},'same-source balance recurrence increments generation');
  assert.equal(generationRow.category,'balance');
  await assert.rejects(manager.invoke('managed.fault.release',{faultRef:fault.faultRef,expectedVersion:fault.release.expectedVersion,scopeSnapshot:fault.release.scopeSnapshot,requestKey:'live-fault-release-4'}),error=>['FAULT_VERSION_STALE','FAULT_SCOPE_STALE'].includes(error.code));
  const releaseCurrent=async(row,key)=>manager.invoke('managed.fault.release',{faultRef:row.faultRef,expectedVersion:row.release.expectedVersion,scopeSnapshot:row.release.scopeSnapshot,requestKey:key});
  await releaseCurrent(generationRow,'live-fault-release-5');
  await manager.invoke('managed.task',{projectId:projectA.id,text:'TASK-CONTROL TRANSIENT-A: inspect the temporary service failure.',requestKey:'live-transient-a-1'});
  const transientRow=await until(async()=>(await faultStatus()).faults.find(row=>row.category==='service-transient'),'real HTTP 503 classification');
  assert.equal(transientRow.evidenceSummary.httpStatus,503);
  await releaseCurrent(transientRow,'live-transient-release-1');
  await manager.invoke('managed.task',{projectId:projectB.id,text:'TASK-CONTROL AUTH-B: publish after re-authentication.',requestKey:'live-auth-b-1'});
  const authRow=await until(async()=>(await faultStatus()).faults.find(row=>row.category==='auth'),'real HTTP 401 classification');
  assert.equal(authRow.evidenceSummary.httpStatus,401);
  assert.equal(authRow.userCritical,true);
  result.checks.push('same-source recurrence increments generation and rejects stale batches; real HTTP 503 and 401 classify separately without business replay');

  // ── 6. batch durability across restart ────────────────────────────────────
  await manager.stopProject(projectA.id);
  const requestsAtRestart=provider.requests.length;
  const durable=await manager.invoke('managed.fault.results',{batchRef:release.batchRef});
  assert.equal(durable.rows.length,batch.rows.length,'batch rows persist read-only after restart');
  await quiet();
  assert.equal(provider.requests.length,requestsAtRestart,'reads never re-execute members');
  result.checks.push('batch results survive project restart as pure reads');

  result.ok=true;
  result.requests=provider.requests.length;
  result.providerErrors=provider.errors.length;
}catch(error){
  result.error=error.stack;
  result.workerSteps=[...workerSteps];
  result.faults=await faultStatus().catch(error=>({error:error.code??error.message}));
  result.states=await Promise.all([projectA,projectB].map(project=>stateOf(project.id).catch(()=>null)));
  process.exitCode=1;
}finally{
  if(provider.errors.length)result.providerErrors=provider.errors.map(error=>error.message);
  await manager?.stop().catch(error=>{result.cleanupError=error.message;process.exitCode=1;});
  await provider.close();
  await host.storage.db.close();
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}
