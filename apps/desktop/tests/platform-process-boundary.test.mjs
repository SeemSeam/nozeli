// Platform process-boundary regressions for the extracted contracts: real
// Linux group semantics through the Linux adapter, structured refusal (never a
// fabricated fallback) for platforms without a verified adapter, UNKNOWN exit
// retention, workspace stale-lock takeover safety, recovery-source ownership,
// and a source guard keeping platform/group-kill assumptions out of the shared
// PiSession. Live UNKNOWN/no-replay/exit-confirmation journeys stay in
// pi-lifecycle-live.mjs / pi-session-admission.test.mjs.
// Run: node --test tests/platform-process-boundary.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {processStamp,ownerAlive,recoverProvider,reapOwnedGroup,hostProcessTree,processIdentityCapability} from '../src/agents/managed/process-ownership.mjs';
import {reapOwnedPiGroup,recoverPiProvider} from '../src/agents/managed/pi-process-ownership.mjs';
import {isolatedLaunch,isolationAvailable,isolationCapability,optionalIsolatedLaunch} from '../src/agents/managed/process-isolation.mjs';
import {assertRecoverySourceStopped} from '../src/main/project-recovery-owner.mjs';
import {PiSession} from '../src/agents/managed/pi-session.mjs';

// Structured "no verified adapter" selections, exactly what selectCapability
// returns on a platform whose capability status is 'unsupported'.
const unsupportedProcess={state:'unavailable',capability:'verified-process-ownership',platform:'windows',status:'unsupported',reason:'no verified implementation for this platform'};
const unsupportedIsolation={state:'unavailable',capability:'execution-isolation',platform:'windows',status:'unsupported',reason:'no verified implementation for this platform'};
const ownerId='0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b';
const stampShape='1b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b:1';

const spawnSitter=async()=>{
  const child=spawn(process.execPath,['-e','process.stdout.write("ready\\n");setInterval(()=>{},1000);'],{stdio:['ignore','pipe','ignore']});
  await once(child.stdout,'data');
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
  const sitter=await spawnSitter();
  const stamp=await processStamp(sitter.pid);
  assert.ok(stamp,'Linux stamp exists for the control process');
  t.after(()=>{try{sitter.kill('SIGKILL');}catch{}});
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
});

test('unverified ownerAlive refuses a verdict instead of guessing liveness',{timeout:20000},async t=>{
  const alive=await spawnSitter();
  t.after(()=>{try{alive.kill('SIGKILL');}catch{}});
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
    const live=await spawnSitter();
    t.after(()=>{try{live.kill('SIGKILL');}catch{}});
    assert.equal(await ownerAlive({pid:live.pid,stamp:'1b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b:99999999'}),false,'Linux verified identity: a reused PID incarnation is not the recorded owner');
    assert.equal(await ownerAlive({pid:live.pid}),true);
  }
});

test('a stale workspace lock is only releasable through a verified identity answer',{timeout:20000},async t=>{
  // Real lock file + real contract, mirroring managed/workspace.mjs's stale
  // takeover: the lock is unlinked only AFTER ownerAlive(old) returns, so a
  // structured refusal keeps the lock and surfaces the error.
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
  const source=await fs.readFile(new URL('../src/agents/managed/workspace.mjs',import.meta.url),'utf8');
  const gate=source.indexOf("if(await ownerAlive(old))throw");
  assert.ok(gate>0,'takeaway path checks ownerAlive before anything else');
  assert.ok(source.indexOf('await fs.unlink(lock)')>gate,'the lock unlink happens only after the ownerAlive gate in the same try block');
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
  await assert.rejects(isolatedLaunch({command:process.execPath,args:[],home:'/tmp/nozeli-iso-unsupported',cwd:os.tmpdir()},{selection:unsupportedIsolation}),error=>error.code==='ISOLATION_UNSUPPORTED'&&/尚未在此平台实现/.test(error.message)&&error.capability.state==='unavailable');
  assert.equal(await isolationAvailable({selection:unsupportedIsolation}),false);
  const ordinary=await optionalIsolatedLaunch({command:'git',args:['--version']},{selection:unsupportedIsolation});
  assert.deepEqual(ordinary,{launch:{command:'git',args:['--version'],env:{}},isolated:false},'explicit non-isolated opt-in stays honestly labelled');
  await assert.rejects(optionalIsolatedLaunch({command:'git',args:[]},{probe:async()=>true,selection:unsupportedIsolation}),error=>error.code==='ISOLATION_UNSUPPORTED','an isolation request is never degraded into a normal spawn');
});

test('Linux bwrap isolation stays reachable through the contract when installed',{timeout:30000},async t=>{
  if(process.platform!=='linux')return t.skip('Linux adapter required');
  if(!await isolationAvailable())return t.skip('bubblewrap unavailable on this host');
  assert.equal(isolationCapability().state,'available');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-iso-contract-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const launch=await isolatedLaunch({command:process.execPath,args:['-e',''],home,cwd:os.tmpdir()});
  assert.equal(launch.command,'bwrap');
  assert.ok(launch.args.includes('--unshare-pid'));
  assert.ok(launch.args.includes('--die-with-parent'));
  assert.equal(typeof launch.env.HOME,'string','sandbox gets its own home, not the user home');
});

test('the shared PiSession keeps platform and group-kill assumptions out of its source',async()=>{
  const source=await fs.readFile(new URL('../src/agents/managed/pi-session.mjs',import.meta.url),'utf8');
  assert.equal(source.includes('process.platform'),false,'platform selection belongs to the capability contract');
  assert.equal(source.includes('process.kill'),false,'group termination belongs to the injected platform service');
  assert.ok(source.includes('platformPersistence.writeAtomic(this.metadataFile'),'session metadata uses the shared durable atomic publish');
});
