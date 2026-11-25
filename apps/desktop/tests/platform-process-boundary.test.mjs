// Platform process-boundary regressions for the extracted contracts: real
// Linux group semantics through the Linux adapter, structured refusal (never a
// fabricated fallback) for platforms without a verified adapter, UNKNOWN exit
// retention, workspace stale-lock takeover safety, recovery-source ownership,
// and real restricted-directory isolation behavior. Live UNKNOWN/no-replay/
// exit-confirmation journeys stay in pi-lifecycle-live.mjs /
// pi-session-admission.test.mjs.
// Run: node --test tests/platform-process-boundary.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {processStamp,ownerAlive,recoverProvider,reapOwnedGroup,hostProcessTree,processIdentityCapability} from '../src/agents/managed/process-ownership.mjs';
import {reapOwnedPiGroup,recoverPiProvider} from '../src/agents/managed/pi-process-ownership.mjs';
import {isolatedLaunch,requireIsolationSupport,isolationAvailable,isolationCapability,optionalIsolatedLaunch} from '../src/agents/managed/process-isolation.mjs';
import {assertRecoverySourceStopped} from '../src/main/project-recovery-owner.mjs';
import {PiSession} from '../src/agents/managed/pi-session.mjs';
import {OmpTuiSession} from '../src/agents/managed/omp-tui-session.mjs';
import {NativeCollabRuntime} from '../src/agents/managed/collab/runtime.mjs';
import {legacyWorkspaceIO} from '../src/agents/managed/workspace-io.mjs';

// Structured "no verified adapter" selections, exactly what selectCapability
// returns on a platform whose capability status is 'unsupported'.
const unsupportedProcess={state:'unavailable',capability:'verified-process-ownership',platform:'windows',status:'unsupported',reason:'no verified implementation for this platform'};
const unsupportedIsolation={state:'unavailable',capability:'execution-isolation',platform:'windows',status:'unsupported',reason:'no verified implementation for this platform'};
const ownerId='0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b';
const stampShape='1b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b:1';

const spawnSitter=async t=>{
  const child=spawn(process.execPath,['-e','require("node:readline").createInterface({input:process.stdin}).on("line",line=>process.stdout.write(line+"\\n"));process.stdout.write("ready\\n");'],{stdio:['pipe','pipe','ignore']});
  const lines=createInterface({input:child.stdout});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
    lines.close();
  });
  assert.equal((await once(lines,'line'))[0],'ready');
  child.assertAlive=async()=>{
    const nonce=randomUUID(),reply=once(lines,'line');
    child.stdin.write(nonce+'\n');
    assert.equal((await reply)[0],nonce,'the unrelated control process still answers its private pipe');
  };
  return child;
};
const gone=async pid=>{for(let i=0;i<40;i++){if(await processStamp(pid)===null)return true;await new Promise(resolve=>setTimeout(resolve,50));}return false;};
// /proc/<pid>/stat fields after the comm parenthesis: [0]=state, [2]=pgid.
const pgidOf=async pid=>{const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8');return Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[2]);};
const refusesProcessOwnership=error=>error.code==='PROCESS_OWNERSHIP_UNSUPPORTED'&&error.platform==='windows';

test('Linux process service spawns a verified group leader and terminates the whole group',{timeout:20000},async t=>{
  if(process.platform!=='linux')return t.skip('Linux adapter required');
  const service=hostProcessTree();
  assert.equal(service.verified,true);
  assert.equal(service.platform,'linux');
  assert.equal(processIdentityCapability().state,'available');
  const child=service.spawn({command:process.execPath,args:['-e','const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});process.stdout.write(String(child.pid)+"\\n");setInterval(()=>{},1000);'],cwd:os.tmpdir(),env:process.env,stdio:['pipe','pipe','pipe']});
  const exit=new Promise(resolve=>child.once('exit',resolve));
  t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
  const descendantPid=Number((await once(child.stdout,'data'))[0].toString().trim());
  const stamp=await service.stamp(child.pid);
  assert.ok(stamp,'owner gets an identity stamp');
  // The spawned owner is its own process-group leader and the descendant
  // inherited that group: kill(-pid) can reach the whole managed tree.
  assert.equal(await pgidOf(child.pid),child.pid,'owner must lead its own process group');
  assert.equal(await pgidOf(descendantPid),child.pid,'descendant inherited the owner group');
  service.terminateGroup(child.pid,'SIGKILL');
  await exit;
  assert.equal(await gone(child.pid),true,'owner PID gone after group termination');
  assert.equal(await gone(descendantPid),true,'descendant reaped with the group');
});

test('platforms without a verified adapter never stamp, reap, recover or signal',{timeout:20000},async t=>{
  const sitter=await spawnSitter(t);
  const stamp=await processStamp(sitter.pid);
  if(processIdentityCapability().state==='available')assert.ok(stamp,'native stamp exists for the control process');
  await sitter.assertAlive();
  assert.equal(await processStamp(sitter.pid,{selection:unsupportedProcess}),null,'no fabricated identity stamp');
  const identity=processIdentityCapability({selection:unsupportedProcess});
  assert.equal(identity.state,'unavailable');
  assert.equal(identity.platform,'windows');
  assert.equal(identity.failureSemantics.includes('retained'),true);
  const reaped=await reapOwnedGroup({pid:sitter.pid,stamp:stampShape},{selection:unsupportedProcess});
  assert.equal(reaped.verified,false);
  assert.equal(reaped.descendantsReaped,0);
  assert.equal(reaped.platform,'windows');
  await assert.rejects(recoverProvider({pid:sitter.pid,home:'/tmp/nozeli-unsupported-home',stamp:stampShape},'/tmp',{selection:unsupportedProcess}),error=>error.code==='PROCESS_OWNERSHIP_UNSUPPORTED'&&/verified on Linux only/.test(error.message));
  const piReaped=await reapOwnedPiGroup({pid:sitter.pid,stamp,ownerId,kind:'pi-node'},{selection:unsupportedProcess});
  assert.equal(piReaped.verified,false);
  assert.equal(piReaped.descendantsReaped,0);
  await assert.rejects(recoverPiProvider({pid:sitter.pid,home:'/tmp/nozeli-unsupported-home/agents/worker',stamp,ownerId,kind:'pi-node'},'/tmp/nozeli-unsupported-home',{selection:unsupportedProcess}),error=>error.code==='PI_PROCESS_OWNERSHIP_UNSUPPORTED'&&/has not been verified on windows/.test(error.message));
  // The host process service refuses every mutating operation explicitly —
  // never a silent no-op success — and never signals the unrelated process.
  const service=hostProcessTree({selection:unsupportedProcess});
  assert.equal(service.verified,false);
  assert.equal(await service.stamp(sitter.pid),null,'stamp honestly reports no verified identity');
  await assert.rejects(async()=>service.spawn({command:process.execPath,args:[],cwd:os.tmpdir(),env:process.env}),refusesProcessOwnership);
  await assert.rejects(async()=>service.terminateGroup(sitter.pid,'SIGTERM'),refusesProcessOwnership);
  assert.equal(await processStamp(sitter.pid),stamp,'unsupported platform never signals; registration retained');
  await sitter.assertAlive();
});

test('unverified ownerAlive refuses a verdict instead of guessing liveness',{timeout:20000},async t=>{
  const alive=await spawnSitter(t);
  // A kill(pid,0) answer is not identity proof and not descendant proof, so
  // the boolean contract refuses: live, stamped and exited owners alike can
  // never be declared dead on an unverified platform.
  await assert.rejects(ownerAlive({pid:alive.pid},{selection:unsupportedProcess}),refusesProcessOwnership);
  await assert.rejects(ownerAlive({pid:alive.pid,stamp:'1b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b:99999999'},{selection:unsupportedProcess}),refusesProcessOwnership);
  alive.kill('SIGKILL');
  await once(alive,'exit');
  await assert.rejects(ownerAlive({pid:alive.pid},{selection:unsupportedProcess}),refusesProcessOwnership);
  await assert.rejects(ownerAlive({pid:0},{selection:unsupportedProcess}),/invalid owner PID/);
  if(process.platform==='linux'){
    assert.equal(await ownerAlive({pid:alive.pid}),false,'Linux verified identity: an exited owner is dead');
    const live=await spawnSitter(t);
    assert.equal(await ownerAlive({pid:live.pid,stamp:'1b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b:99999999'}),false,'Linux verified identity: a reused PID incarnation is not the recorded owner');
    assert.equal(await ownerAlive({pid:live.pid}),true);
  }
});

test('a stale workspace lock is only releasable through a verified identity answer',{timeout:20000},async t=>{
  // Exercise the actual extracted acquisition path against a real stale lock.
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-lock-takeover-'));
  t.after(()=>fs.rm(runtime,{recursive:true,force:true}));
  const lock=path.join(runtime,'host.lock');
  const dead=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});
  await once(dead,'exit');
  await fs.writeFile(lock,JSON.stringify({pid:dead.pid,hostId:'stale-host',stamp:stampShape}));
  if(process.platform==='linux'){
    assert.equal(await ownerAlive(JSON.parse(await fs.readFile(lock,'utf8'))),false,'Linux verified identity: a dead stale owner is releasable');
  }
  await assert.rejects(ownerAlive(JSON.parse(await fs.readFile(lock,'utf8')),{selection:unsupportedProcess}),refusesProcessOwnership);
  await assert.doesNotReject(fs.access(lock),'the refused takeover never unlinked the stale lock');
  const before=await fs.readFile(lock),options={project:{root:path.join(runtime,'separate-content')},runtimeRoot:runtime,recoverStale:true};
  if(process.platform==='linux'){
    const custody=await legacyWorkspaceIO.acquire(options);assert.notDeepEqual(await fs.readFile(lock),before);await custody.release();await assert.rejects(fs.stat(lock),{code:'ENOENT'});
  }else if(process.platform==='win32'){
    await assert.rejects(legacyWorkspaceIO.acquire(options),{code:'PROCESS_OWNERSHIP_UNSUPPORTED'});assert.deepEqual(await fs.readFile(lock),before);
  }
});

test('recovery-source ownership has one Linux proof path and refuses elsewhere',{timeout:60000},async()=>{
  await assert.rejects(assertRecoverySourceStopped('/tmp/nozeli-unknown-recovery-root',{selection:unsupportedProcess}),error=>error.code==='RECOVERY_OWNER_UNVERIFIED'&&/此平台尚不能核验其他实例/.test(error.message)&&error.platform==='windows');
});

test('an unverified Pi owner tree exit never closes the session or claims confirmation',async()=>{
  const termination=[];
  const session=new PiSession({role:'worker',home:'/tmp/nozeli-unverified-exit',cwd:'/tmp',tools:[],processTree:{verified:true,platform:'linux',spawn(){throw Error('not used');},async stamp(){return null;},terminateGroup(pid,signal){termination.push({pid,signal});}}});
  session.pid=4194304;
  session.child={exitCode:null,signalCode:null,kill(){}};
  session.exitPromise=Promise.resolve(null);
  session.request=async()=>{throw Object.assign(Error('stop not acknowledged'),{code:'PI_RUNTIME_CLOSED'});};
  await assert.rejects(session.stop(),error=>error.code==='PI_EXIT_UNCONFIRMED');
  assert.equal(session.closed,false,'UNKNOWN exit keeps the session owner retained');
  assert.equal(session.lastExitReceipt.confirmationComplete,false);
  assert.deepEqual(termination,[{pid:4194304,signal:'SIGTERM'}],'group termination went through the injected platform service only');
});

test('PiSession refuses to start without a verified platform process service',{timeout:20000},async t=>{
  const home=path.join(os.tmpdir(),'nozeli-pi-unverified-'+process.pid);
  const session=new PiSession({role:'worker',home,cwd:os.tmpdir(),tools:[],processTree:hostProcessTree({selection:unsupportedProcess})});
  await assert.rejects(session.start(),error=>error.code==='PI_PLATFORM_UNSUPPORTED'&&/not verified on windows/.test(error.message));
  assert.equal(session.child,undefined,'no process was spawned');
  await assert.rejects(fs.stat(home),{code:'ENOENT'},'refused before creating any owner state');
  assert.deepEqual(await session.stop(),{confirmationComplete:true,reason:'never-spawned'});
  if(process.platform==='linux'){
    assert.equal(new PiSession({role:'worker',home,cwd:os.tmpdir(),tools:[]}).processTree.verified,true,'default service follows the shared capability contract');
  }
});

test('execution isolation fails structured instead of spawning unsandboxed',{timeout:20000},async()=>{
  const capability=isolationCapability({selection:unsupportedIsolation});
  assert.equal(capability.state,'unavailable');
  assert.equal(capability.platform,'windows');
  assert.equal(capability.status,'unsupported');
  assert.throws(()=>requireIsolationSupport({selection:unsupportedIsolation}),{code:'ISOLATION_UNSUPPORTED'});
  await assert.rejects(isolatedLaunch({command:process.execPath,args:[],home:'/tmp/nozeli-iso-unsupported',cwd:os.tmpdir()},{selection:unsupportedIsolation}),error=>error.code==='ISOLATION_UNSUPPORTED'&&/尚未在此平台实现/.test(error.message)&&error.capability.state==='unavailable');
  assert.equal(await isolationAvailable({selection:unsupportedIsolation}),false);
  const ordinary=await optionalIsolatedLaunch({command:'git',args:['--version']},{selection:unsupportedIsolation});
  assert.deepEqual(ordinary,{launch:{command:'git',args:['--version'],env:{}},isolated:false},'explicit non-isolated opt-in stays honestly labelled');
  await assert.rejects(optionalIsolatedLaunch({command:'git',args:[]},{probe:async()=>true,selection:unsupportedIsolation}),error=>error.code==='ISOLATION_UNSUPPORTED','an isolation request is never degraded into a normal spawn');
});

test('explicit OMP isolation refuses before private home, runtime, bridge, collaboration or auth preparation',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-omp-isolation-refusal-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'home');let effects=0;
  const forbidden=()=>{effects++;throw Error('preparation forbidden');};
  const session=new OmpTuiSession({role:'worker',home,cwd:root,isolation:{},isolationDeps:{selection:unsupportedIsolation},ompSystemSource:{get private(){return forbidden();},modelFor:forbidden},ompAuthBroker:{acquire:forbidden},tuiSpawn:{spawn:forbidden}});
  await assert.rejects(session.start(),error=>error.code==='ISOLATION_UNSUPPORTED'&&error.capability.platform==='windows');
  assert.equal(effects,0);assert.equal(session.command,null);assert.equal(session.deployed,undefined);assert.equal(session.collab,undefined);assert.equal(session.pty,undefined);
  assert.deepEqual(await fs.readdir(root),[],'no home, bridge, collaboration or execution marker');
});

for(const isolated of [false,true])test(`OMP ${isolated?'adapter initialization failure never falls back':'ordinary no-isolation route still reaches ordinary PTY execution'}`,async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-omp-isolation-launch-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  t.mock.method(NativeCollabRuntime.prototype,'prepare',async function(){this.root=path.join(root,'synthetic-collab');await fs.mkdir(this.root);return {};});
  let launches=0,spawns=0;const failure=Object.assign(Error('synthetic isolation initialization failure'),{code:'ISOLATION_INIT_FAILED'}),ordinary=Object.assign(Error('synthetic PTY admission observed'),{code:'ORDINARY_SPAWN_OBSERVED'});
  const selection={state:'available',capability:'execution-isolation',platform:'synthetic',implementation:{mechanism:'synthetic-refusing-adapter',launch(){launches++;throw failure;}}};
  const session=new OmpTuiSession({role:'worker',home:path.join(root,'home'),cwd:root,command:process.execPath,...(isolated?{isolation:{}}:{}),isolationDeps:{selection},tuiSpawn:{spawn(args,options){spawns++;assert.equal(options.command,process.execPath);assert.ok(args.includes('--cwd'));throw ordinary;}}});
  await assert.rejects(session.start(),error=>error===(isolated?failure:ordinary));
  assert.equal(launches,isolated?1:0);assert.equal(spawns,isolated?0:1);assert.equal(session.pty,undefined);
});

test('Linux isolation can write its private home but cannot read an unmounted sibling',{timeout:30000},async t=>{
  if(process.platform!=='linux')return t.skip('Linux adapter required');
  if(!await isolationAvailable())return t.skip('bubblewrap unavailable on this host');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-iso-contract-')),home=path.join(root,'home'),outside=path.join(root,'outside.txt');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(home);await fs.writeFile(outside,'outside sentinel');
  const code=`const fs=require('node:fs');fs.writeFileSync('inside.txt','private output');try{fs.readFileSync(${JSON.stringify(outside)});process.exitCode=1;}catch(error){if(error.code!=='ENOENT'&&error.code!=='EACCES')throw error;}`;
  const launch=await isolatedLaunch({command:process.execPath,args:['-e',code],home,cwd:home});
  const child=spawn(launch.command,launch.args,{env:launch.env,stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  assert.deepEqual(await exited,[0,null],stderr);
  assert.equal(await fs.readFile(path.join(home,'inside.txt'),'utf8'),'private output');
  assert.equal(await fs.readFile(outside,'utf8'),'outside sentinel');
});
