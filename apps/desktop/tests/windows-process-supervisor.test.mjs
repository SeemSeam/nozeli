import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import net from 'node:net';
import {createExperimentalProcessJob as create,waitExperimentalJobEmpty as wait} from '../src/platform/windows/experimental-process-job.mjs';
import {startExperimentalProcessSupervisor as start,connectExperimentalProcessSupervisor as connect,experimentalSupervisorEndpoint as endpoint,verifyExperimentalPreparedSupervisor,experimentalSupervisorShutdownObserved} from '../src/platform/windows/experimental-process-supervisor.mjs';
import {openExperimentalProcessIdentity as observe} from '../src/platform/windows/experimental-process-identity.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:30000};
const helper=path.resolve(import.meta.dirname,'../native/windows-process/build/Release/nozeli_process_fixture.exe');
async function until(fn){const deadline=performance.now()+10000;for(;;){const value=await fn();if(value)return value;if(performance.now()>deadline)assert.fail('supervisor fixture timeout');await delay(10);}}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli supervisor 中文 ')),jobs=[],pins=[],children=[];
  const env=[`SystemRoot=${process.env.SystemRoot}`,`TEMP=${root}`,`TMP=${root}`,...(process.versions.electron?['ELECTRON_RUN_AS_NODE=1']:[])];
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}
    for(const job of jobs){if(!job.snapshot().jobEmptyObserved)job.terminate();await wait(job);}
    for(const pin of pins.reverse())try{if(pin.shutdown)pin.shutdown();}catch(error){if(!['SUPERVISOR_IDENTITY_UNVERIFIED','SUPERVISOR_CLOSED'].includes(error.code))throw error;}finally{pin.close();}
    for(const job of jobs)job.close();await fs.rm(root,{recursive:true,force:true});
  });
  return {root,env,jobs,pins,children,job(args=[],command=process.execPath){const job=create({command,args,cwd:root,env});jobs.push(job);return job;},hold(job){const pin=start(job);pins.push(pin);return pin;}};
}

test('supervisor retains the actual prepared Job before resume and another observer retrieves query-only original objects',native,async t=>{
  const f=await fixture(t),marker=path.join(f.root,'single-process.json'),job=f.job(['hold',marker],helper),pin=f.hold(job),record=endpoint(pin);
  const before=pin.snapshot();assert.equal(before.pid,job.snapshot().pid);assert.equal(before.hostPid,process.pid);assert.equal(before.hostExited,false);assert.equal(before.coldRecoveryQualified,false);
  assert.equal(before.jobHandleInheritable,false);assert.equal(before.killOnJobClose,true);assert.equal(before.breakawayAllowed,false);
  assert.equal(before.resumed,undefined);assert.equal(before.executionState,'not-observed');
  assert.throws(()=>start(job),{code:'SUPERVISOR_START_REFUSED'});
  job.resume();const second=connect(record);f.pins.push(second);assert.equal(second.snapshot().stamp,job.snapshot().stamp);
  assert.throws(()=>verifyExperimentalPreparedSupervisor(second,{stamp:job.snapshot().stamp}),{code:'SUPERVISOR_IDENTITY_UNVERIFIED'});
  assert.throws(()=>second.shutdown(),error=>error.code==='SUPERVISOR_REQUEST_REFUSED'&&error.win32Code===170);
  // Windows may create conhost during console initialization even for this
  // native fixture. Wait for user code, then retain its actual live members
  // before termination; termination before initialization can miss history.
  await until(async()=>{try{return await fs.readFile(marker,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}});
  const running=second.snapshot();assert.equal(running.allProcessIncarnationsObserved,true,JSON.stringify(running));
  job.terminate();await wait(job);await until(()=>second.snapshot().jobEmptyObserved);
  assert.equal(second.snapshot().allProcessIncarnationsObserved,true);
});

test('retained supervisor exit observation works after helper exit without repeating close or granting release',native,async t=>{
 const f=await fixture(t),job=f.job(['-e','process.exit(0)']),owner=f.hold(job),record=endpoint(owner);
 const observer=connect(record);f.pins.push(observer);
 const running=observer.observeExit();
 assert.equal(running.supervisorExited,false);assert.equal(running.supervisorPid,record.supervisorPid);
 assert.equal(running.supervisorCreationTime100ns,record.supervisorCreationTime100ns);
 assert.equal(running.ownerReleaseQualified,false);assert.equal(running.shutdownAcknowledged,false);
 assert.throws(()=>observer.observeExit.call({}),{code:'SUPERVISOR_RECEIVER'});
 job.resume();await wait(job);
 owner.shutdown();
 // The independent original observer did not issue close. Once the pipe peer
 // exits, snapshot/shutdown cannot substitute for a retained HANDLE check.
 const exited=observer.observeExit();
 assert.equal(exited.supervisorExited,true);
 assert.equal(exited.scope,'retained-supervisor-process-exit-observation-only');
 assert.equal(exited.shutdownAcknowledged,false);assert.equal(exited.ownerReleaseQualified,false);
 assert.equal(exited.automaticReplay,false);assert.equal(experimentalSupervisorShutdownObserved(observer),false);
 assert.equal(experimentalSupervisorShutdownObserved(owner),true);
 assert.deepEqual(observer.observeExit(),exited);
 assert.throws(()=>observer.snapshot(),{code:'SUPERVISOR_IDENTITY_UNVERIFIED'});
 observer.close();assert.throws(()=>observer.observeExit(),{code:'SUPERVISOR_CLOSED'});
 f.pins.splice(f.pins.indexOf(observer),1);
});

test('fabricated receivers and changed supervisor/host/leader incarnations refuse without affecting the running owner',native,async t=>{
  const f=await fixture(t),job=f.job(['-e','setInterval(()=>{},1000)']),pin=f.hold(job),record=endpoint(pin);job.resume();
  assert.throws(()=>pin.snapshot.call({}),{code:'SUPERVISOR_RECEIVER'});
  for(const field of ['supervisorCreationTime100ns','hostCreationTime100ns','leaderCreationTime100ns'])
    assert.throws(()=>connect({...record,[field]:(BigInt(record[field])+1n).toString()}),{code:'SUPERVISOR_IDENTITY_UNVERIFIED'});
  assert.throws(()=>connect({...record,pipe:record.pipe.slice(0,-1)+'g'}),{code:'SUPERVISOR_SPEC_INVALID'});
  assert.throws(()=>connect({...record,helperSha256:'0'.repeat(64)}),{code:'SUPERVISOR_IMAGE_UNVERIFIED'});
  assert.equal(job.snapshot().leaderState,'running');job.terminate();await wait(job);
});

test('supervision cannot be added after resume or after termination and does not become an arbitrary PID adoption API',native,async t=>{
  const f=await fixture(t),running=f.job(['-e','setInterval(()=>{},1000)']);running.resume();assert.throws(()=>start(running),{code:'SUPERVISOR_START_REFUSED'});
  const cancelled=f.job(['-e','process.exit(0)']);cancelled.terminate();await wait(cancelled);assert.throws(()=>start(cancelled),{code:'SUPERVISOR_START_REFUSED'});
  for(const value of [{},process.pid,null])assert.throws(()=>start(value),{code:'SUPERVISOR_SPEC_INVALID'});
});

for(const mode of ['normal','forced'])for(const stage of ['suspended','running','descendant'])test(`${mode} host death ${stage} preserves original Job custody for a new host and leaves unrelated sentinel alive`,native,async t=>{
  const resumed=stage!=='suspended';
  const f=await fixture(t),ready=path.join(f.root,'ready.json'),stop=path.join(f.root,'host-stop'),marker=path.join(f.root,'executed.json');
  const module=relative=>new URL(relative,import.meta.url).href,script=path.join(f.root,'host.mjs');
  await fs.writeFile(script,`import fs from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';
    import {createExperimentalProcessJob} from ${JSON.stringify(module('../src/platform/windows/experimental-process-job.mjs'))};
    import {startExperimentalProcessSupervisor,experimentalSupervisorEndpoint} from ${JSON.stringify(module('../src/platform/windows/experimental-process-supervisor.mjs'))};
    const i=JSON.parse(process.argv[2]),job=createExperimentalProcessJob(i.spec),pin=startExperimentalProcessSupervisor(job);
    if(i.resumed)job.resume();await fs.writeFile(i.ready,JSON.stringify(experimentalSupervisorEndpoint(pin)));
    for(;;){try{await fs.stat(i.stop);process.exit(91);}catch(e){if(e.code!=='ENOENT')throw e;}await delay(10);}`);
  const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});f.children.push(sentinel);
  const sentinelPin=observe(sentinel.pid);f.pins.push(sentinelPin);const sentinelBefore=sentinelPin.snapshot();
  const descendantFile=path.join(f.root,'descendant.json');
  const host=spawn(process.execPath,[script,JSON.stringify({resumed,ready,stop,spec:{command:helper,args:stage==='descendant'?['nested',marker,descendantFile]:['hold',marker],cwd:f.root,env:f.env}})],{
    env:Object.fromEntries(f.env.map(entry=>{const i=entry.indexOf('=');return [entry.slice(0,i),entry.slice(i+1)];})),stdio:['ignore','pipe','pipe'],windowsHide:true});f.children.push(host);
  let stderr='';host.stderr.on('data',bytes=>stderr+=bytes);host.stdout.resume();
  const record=await until(async()=>{try{return JSON.parse(await fs.readFile(ready,'utf8'));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;assert.equal(host.exitCode,null,stderr);}});
  const leader=observe(record.leaderPid);f.pins.push(leader);
  if(resumed)await until(async()=>{try{return await fs.readFile(marker,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}});
  let descendant;
  if(stage==='descendant'){
    const record=await until(async()=>{try{return JSON.parse(await fs.readFile(descendantFile,'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}});
    descendant=observe(record.pid);f.pins.push(descendant);assert.equal(descendant.snapshot().state,'running');
  }
  let stalled;
  if(mode==='forced'&&stage==='running'){
    stalled=net.createConnection(record.pipe);await once(stalled,'connect');stalled.on('error',()=>{});
  }
  const exited=once(host,'exit');if(mode==='normal')await fs.writeFile(stop,'stop');else host.kill();const result=await exited;
  if(mode==='normal')assert.equal(result[0],91);else assert.equal(result[1],'SIGTERM');
  if(stalled){await until(()=>leader.snapshot().state==='exited');stalled.destroy();}
  // No observation object crossed host death. Reconnect actually transfers
  // the retained original kernel Job, host and leader handles to this process.
  const cold=connect(record);f.pins.push(cold);await until(()=>cold.snapshot().jobEmptyObserved);
  // Job accounting and each process HANDLE are independent observations. An
  // empty accounting snapshot can precede the descendant's signalled HANDLE;
  // wait for the retained original incarnations instead of assuming one tick
  // proves both facts. This query-only test grants no owner release receipt.
  await until(()=>leader.snapshot().state==='exited'&&(!descendant||descendant.snapshot().state==='exited'));
  const facts=cold.snapshot();assert.equal(facts.hostExited,true);assert.equal(facts.stamp,leader.snapshot().stamp);assert.equal(leader.snapshot().state,'exited');
  if(descendant)assert.equal(descendant.snapshot().state,'exited');
  assert.equal(facts.ownerRegistrationVerified,false);assert.equal(facts.coldRecoveryQualified,false);
  if(!resumed)await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  assert.deepEqual(sentinelPin.snapshot(),sentinelBefore);
});

test('a real transient unobserved member keeps the endpoint refusing without release',native,async t=>{
  const f=await fixture(t),marker=path.join(f.root,'transient.json');
  const job=f.job(['-e',`const r=require('child_process').spawnSync(process.argv[1],[],{stdio:'ignore',windowsHide:true});require('fs').writeFileSync(process.argv[2],JSON.stringify({status:r.status}));`,helper,marker]),pin=f.hold(job),record=endpoint(pin);
  const observationWindow=mode=>{
    const result=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-File',path.resolve(import.meta.dirname,'fixtures/windows-supervisor-observation-window.ps1'),'-Mode',mode,'-ProcessNumber',String(record.supervisorPid),'-CreationTime100ns',record.supervisorCreationTime100ns],{encoding:'utf8',windowsHide:true,timeout:15000});
    assert.ifError(result.error);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout.trim()).ok,true);
  };
  // A real bounded helper suspension makes the observation gap deterministic;
  // no mocked count or new product bypass is used. The harness verifies the
  // exact helper executable and creation time before either native operation.
  observationWindow('Suspend');
  try{job.resume();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);await until(()=>job.snapshot().jobEmptyObserved);}
  finally{observationWindow('Resume');}
  assert.equal(JSON.parse(await fs.readFile(marker,'utf8')).status,90);
  // The descendant's NEW_PROCESS can now only reference a freed incarnation:
  // capture is unprovable, so the kernel-notification refusal sticks.
  const refused=await until(()=>{const facts=job.snapshot();return facts.memberCaptureError>0?facts:undefined;});
  assert.ok(refused.totalProcesses>1);
  assert.equal(refused.allProcessIncarnationsObserved,false);
  // Both supervisor surfaces refuse; the endpoint cannot be reused to obtain
  // observation objects or any release authority after the sticky failure.
  assert.throws(()=>pin.snapshot(),{code:'PROCESS_JOB_MEMBERS_UNVERIFIED'});
  assert.throws(()=>connect(record),{code:'PROCESS_JOB_MEMBERS_UNVERIFIED'});
});

test('leader exit with a native descendant alive remains nonempty after a cold connection',native,async t=>{
  const f=await fixture(t),ready=path.join(f.root,'tail-ready'),job=create({command:helper,args:['spawn-stdio-tail',ready],cwd:f.root,env:f.env,stdio:'pipe'});f.jobs.push(job);const pin=f.hold(job);job.resume();
  const second=connect(endpoint(pin));f.pins.push(second);
  await until(()=>job.snapshot().leaderState==='exited');const facts=second.snapshot();
  assert.equal(facts.jobEmptyObserved,false);assert.ok(facts.activeProcesses>0);await until(()=>second.snapshot().jobEmptyObserved);
});

test('helper loss refuses cold observation while the original host still retains its running Job',native,async t=>{
  const f=await fixture(t),job=f.job(['-e','setInterval(()=>{},1000)']),pin=f.hold(job),record=endpoint(pin);job.resume();
  const nativeBinding=createRequire(import.meta.url)('../native/windows-process/build/Release/nozeli_windows_process.node');
  assert.equal(typeof nativeBinding.connectProcessSupervisor,'function');
  // Terminate only the exact helper this test just created; original Job is
  // still retained by the fixture, so helper death itself is not Job-empty.
  process.kill(record.supervisorPid);await until(()=>{try{pin.snapshot();return false;}catch(e){return e.code==='SUPERVISOR_IDENTITY_UNVERIFIED';}});
  assert.throws(()=>connect(record),{code:'SUPERVISOR_IDENTITY_UNVERIFIED'});assert.equal(job.snapshot().leaderState,'running');
});
