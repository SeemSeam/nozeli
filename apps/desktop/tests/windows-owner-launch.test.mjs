import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {createOwnerLaunchRegistry} from '../src/main/owner-launch-registry.mjs';
import {PiSession} from '../src/agents/managed/pi-session.mjs';
import {AgentProcessBudget} from '../src/agents/managed/agent-process-budget.mjs';
import {prepareExperimentalProcessTransport as prepare} from '../src/platform/windows/experimental-process-transport.mjs';
import {openExperimentalProcessIdentity} from '../src/platform/windows/experimental-process-identity.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:30000};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(fn){const deadline=performance.now()+10000;for(;;){const result=await fn();if(result)return result;if(performance.now()>deadline)assert.fail('synthetic launch observation timeout');await delay(10);}}
async function missing(file){await assert.rejects(fs.stat(file),{code:'ENOENT'});}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli launch 中文 ')),project=path.join(root,'项目'),profile=path.join(root,'profile');await fs.mkdir(project);
  const storage=new ProjectStorage(profile,{experimentalWindowsRoot:root,experimentalWindowsInitialization:true});
  const projectId=(await storage.register(project)).id,registry=createOwnerLaunchRegistry(storage,projectId),transports=[],children=[],reads=[];
  const env=[`SystemRoot=${process.env.SystemRoot}`,`TEMP=${root}`,`TMP=${root}`,...(process.versions.electron?['ELECTRON_RUN_AS_NODE=1']:[])];
  t.after(async()=>{
    const failures=[];
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}
    for(const child of transports)try{if(!child.lease.snapshot().jobEmptyObserved)child.terminate();await child.waitForJobEmpty();child.close();}catch(error){if(error.code!=='PROCESS_JOB_CLOSED')failures.push(error);}
    for(const read of reads)read.close();await storage.db.close();
    if(failures.length)throw new AggregateError(failures,'Keep synthetic fixture on unconfirmed local exit');
    await fs.rm(root,{recursive:true,force:true});
  });
  const marker=path.join(root,'executed.txt');
  const launch={command:process.execPath,args:['-e',`require('fs').appendFileSync(process.argv[1],'executed\\n');require('readline').createInterface({input:process.stdin}).on('line',line=>{const frame=JSON.parse(line);process.stdout.write(JSON.stringify({id:frame.id,result:{method:frame.method,text:frame.params.text}})+'\\n');});`,marker],cwd:root,env};
  const options=(session,extra={})=>({launch,prepare:spec=>{const child=prepare(spec);transports.push(child);return child;},registry,target:'frontdesk',isCurrent:()=>true,...extra});
  const session=()=>new PiSession({role:'frontdesk',home:path.join(root,'private-home'),cwd:project});
  const read=pid=>{const pin=openExperimentalProcessIdentity(pid);reads.push(pin);return pin;};
  return {root,profile,projectId,storage,registry,marker,launch,env,transports,children,session,options,read};
}

test('shared prepared launch waits for durable intent and registration before actual execution and Pi request correlation',native,async t=>{
  const f=await fixture(t),session=f.session();let identity;
  const receipt=await session.prepareRegisteredOwner(f.options(session,{onPrepared:async child=>{
    identity=child.preparedIdentity();assert.equal((await f.registry.read('frontdesk')).value.phase,'intent');
    await delay(80);await missing(f.marker);assert.throws(()=>session.write({method:'early'}),{code:'PI_LAUNCH_UNCONFIRMED'});
  }}));
  assert.equal(receipt.record.phase,'prepared');assert.deepEqual(receipt.record.identity,identity);
  assert.equal(receipt.record.generation,session.epoch);assert.equal(receipt.record.ownerId,session.viewOwnerId);
  assert.equal((await f.registry.read('frontdesk')).revision,2);
  assert.deepEqual(await session.request('echo',{text:'中文 😀'},5000),{method:'echo',text:'中文 😀'});
  assert.equal(await fs.readFile(f.marker,'utf8'),'executed\n');
  assert.equal((await f.storage.listProject(f.projectId,'managed_owner_launches')).length,0,'local kernel ownership is not portable project data');
});

test('prepared launch requires an explicit synchronous current-owner guard before any process or database write',native,async t=>{
  const f=await fixture(t),session=f.session();await assert.rejects(session.prepareRegisteredOwner(f.options(session,{isCurrent:undefined})),{code:'PI_LAUNCH_CONTRACT_INVALID'});
  assert.equal(await f.registry.read('frontdesk'),null);assert.equal(f.transports.length,0);await missing(f.marker);
});

test('one durable CAS winner starts when two sessions race for the same local target',native,async t=>{
  const f=await fixture(t),a=f.session(),b=f.session(),results=await Promise.allSettled([a.prepareRegisteredOwner(f.options(a)),b.prepareRegisteredOwner(f.options(b))]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.find(row=>row.status==='rejected').reason.code,'STORAGE_CONFLICT');
  assert.equal(f.transports.length,1);const winner=results[0].status==='fulfilled'?a:b;
  assert.equal((await f.registry.read('frontdesk')).value.ownerId,winner.viewOwnerId);await winner.request('echo',{},5000);
  assert.equal(await fs.readFile(f.marker,'utf8'),'executed\n');
});

for(const mode of ['generation','target'])test(`${mode} supersession while prepared never resumes or overwrites the durable intent`,native,async t=>{
  const f=await fixture(t),session=f.session();let current=true;
  await assert.rejects(session.prepareRegisteredOwner(f.options(session,{isCurrent:()=>current,onPrepared:async()=>{if(mode==='generation')session.epoch=randomUUID();else current=false;}})),{code:'PI_LAUNCH_SUPERSEDED'});
  assert.equal((await f.registry.read('frontdesk')).value.phase,'intent');assert.equal(session.launchResumeAttempted,undefined);
  assert.equal(session.launchCleanup.confirmationComplete,false);assert.equal(session.child.lease.snapshot().jobEmptyObserved,true);await missing(f.marker);
});

test('stop during a delayed actual prepared-registration reply prevents late resume and retains the budget',native,async t=>{
  const f=await fixture(t),session=f.session(),entered=deferred(),release=deferred(),budget=new AgentProcessBudget({limit:2}),slot=budget.reserve(f.projectId,'frontdesk');budget.bind(slot,session);
  const registry={begin:binding=>f.registry.begin(binding),async register(...args){const receipt=await f.registry.register(...args);entered.resolve();await release.promise;return receipt;}};
  const launch=session.prepareRegisteredOwner(f.options(session,{registry}));const rejected=assert.rejects(launch,{code:'PI_LAUNCH_SUPERSEDED'});
  await entered.promise;try{await assert.rejects(session.stop(),{code:'PI_EXIT_UNCONFIRMED'});assert.equal(budget.used,1);assert.equal(slot.state,'unconfirmed');}finally{release.resolve();}
  await rejected;assert.equal((await f.registry.read('frontdesk')).value.phase,'prepared');await missing(f.marker);
});

test('independent SQLite registration winner is preserved and stale prepared CAS refuses execution',native,async t=>{
  const f=await fixture(t),session=f.session();let winner;
  await assert.rejects(session.prepareRegisteredOwner(f.options(session,{onPrepared:async()=>{
    const previous=await f.registry.read('frontdesk');winner={...previous.value,ownerId:randomUUID(),launchId:randomUUID(),phase:'external-winner'};
    const script=path.join(f.root,'winner.mjs');await fs.writeFile(script,`import path from 'node:path';import {ProjectStorage} from ${JSON.stringify(new URL('../src/main/project-storage.mjs',import.meta.url).href)};
      const i=JSON.parse(process.argv[2]),s=new ProjectStorage(i.profile,{experimentalWindowsRoot:i.root,experimentalWindowsInitialization:true});await s.requireRegistered(i.projectId);await s.db.request(path.join(await s.localDirectory(i.projectId),'ui.sqlite'),'put',{collection:'managed_owner_launches',id:'frontdesk',value:i.winner,expectedRevision:i.revision});await s.db.close();`);
    const child=spawn(process.execPath,[script,JSON.stringify({root:f.root,profile:f.profile,projectId:f.projectId,winner,revision:previous.revision})],{env:Object.fromEntries(f.env.map(entry=>{const i=entry.indexOf('=');return [entry.slice(0,i),entry.slice(i+1)];})),stdio:['ignore','pipe','pipe'],windowsHide:true});f.children.push(child);let diagnostic='';child.stderr.on('data',bytes=>diagnostic+=bytes);child.stdout.resume();
    assert.deepEqual(await once(child,'exit'),[0,null],diagnostic);
  }})),{code:'STORAGE_CONFLICT'});
  assert.deepEqual((await f.registry.read('frontdesk')).value,winner);await missing(f.marker);
});

for(const phase of ['intent','prepared'])test(`actual ${phase} SQLite commit with controlled lost reply fences launch and never releases the budget`,native,async t=>{
  const f=await fixture(t),session=f.session(),budget=new AgentProcessBudget({limit:2}),slot=budget.reserve(f.projectId,'frontdesk');budget.bind(slot,session);
  const original=f.storage.db.request.bind(f.storage.db);let injected=0;
  f.storage.db.request=async(file,op,args)=>{const result=await original(file,op,args);if(op==='put'&&args.collection==='managed_owner_launches'&&args.value.phase===phase){injected++;throw Object.assign(Error('controlled reply loss after actual SQLite commit'),{code:'STORAGE_RESULT_UNKNOWN'});}return result;};
  try{await assert.rejects(session.prepareRegisteredOwner(f.options(session)),{code:'STORAGE_RESULT_UNKNOWN'});}finally{f.storage.db.request=original;}
  assert.equal(injected,1);await assert.rejects(f.registry.read('frontdesk'),{code:'STORAGE_RESULT_UNKNOWN'});
  const cold=createOwnerLaunchRegistry(f.storage,f.projectId);assert.equal((await cold.read('frontdesk')).value.phase,phase);
  assert.equal(f.transports.length,phase==='intent'?0:1);assert.equal(session.launchResumeAttempted,undefined);await missing(f.marker);
  await assert.rejects(session.stop(),{code:'PI_EXIT_UNCONFIRMED'});assert.equal(budget.used,1);assert.equal(slot.state,'unconfirmed');
  const retry=f.session();await assert.rejects(retry.prepareRegisteredOwner(f.options(retry,{registry:cold})),{code:'STORAGE_CONFLICT'});
});

test('failed native preparation retains its durable intent and cannot turn into a never-spawned release',native,async t=>{
  const f=await fixture(t),session=f.session();await assert.rejects(session.prepareRegisteredOwner(f.options(session,{launch:{...f.launch,command:path.join(f.root,'missing.exe')}})),{code:'PROCESS_JOB_LAUNCH_FAILED'});
  assert.equal(session.child,undefined);assert.equal((await f.registry.read('frontdesk')).value.phase,'intent');await assert.rejects(session.stop(),{code:'PI_EXIT_UNCONFIRMED'});await missing(f.marker);
});

test('a concurrent second call on the same session cannot create a second intent or process',native,async t=>{
  const f=await fixture(t),session=f.session(),entered=deferred(),release=deferred();
  const first=session.prepareRegisteredOwner(f.options(session,{onPrepared:async()=>{entered.resolve();await release.promise;}}));
  await entered.promise;try{await assert.rejects(session.prepareRegisteredOwner(f.options(session)),{code:'PI_OWNER_EXISTS'});}finally{release.resolve();}
  await first;assert.equal(f.transports.length,1);assert.equal((await f.registry.read('frontdesk')).revision,2);
});

test('a resume failure after the actual native call retains registration and cannot authorize another resume',native,async t=>{
  const f=await fixture(t),session=f.session();let calls=0;
  await assert.rejects(session.prepareRegisteredOwner(f.options(session,{onPrepared:async child=>{const resume=child.resume;child.resume=()=>{calls++;resume();throw Object.assign(Error('controlled reply loss after native resume'),{code:'CONTROLLED_RESUME_UNKNOWN'});};}})),{code:'CONTROLLED_RESUME_UNKNOWN'});
  assert.equal(calls,1);assert.equal(session.launchResumeAttempted,true);assert.equal((await f.registry.read('frontdesk')).value.phase,'prepared');
  await assert.rejects(session.prepareRegisteredOwner(f.options(session)),{code:'PI_OWNER_EXISTS'});assert.equal(calls,1);assert.equal(session.launchCleanup.confirmationComplete,false);
});

test('forged intent receipt or malformed incarnation is refused without changing durable registration',native,async t=>{
  const f=await fixture(t),binding={target:'frontdesk',ownerId:randomUUID(),generation:randomUUID(),launchId:randomUUID(),home:path.join(f.root,'home')},intent=await f.registry.begin(binding);
  await assert.rejects(f.registry.register(structuredClone(intent),{}),{code:'OWNER_LAUNCH_INVALID'});
  await assert.rejects(f.registry.register(intent,{schema:1,platform:'win32',pid:1,creationTime100ns:'1',stamp:'linux:fake'}),{code:'OWNER_LAUNCH_IDENTITY_INVALID'});
  await assert.rejects(f.registry.register(intent,{schema:1,platform:'win32',pid:1,creationTime100ns:'1',stamp:'win32:1:1',handle:123}),{code:'OWNER_LAUNCH_IDENTITY_INVALID'});
  assert.equal((await f.registry.read('frontdesk')).revision,1);assert.equal(f.transports.length,0);
});

test('shared session protocol failure terminates its actual prepared transport, fences input and retains registration',native,async t=>{
  const f=await fixture(t),session=f.session(),launch={...f.launch,args:['-e',`process.stdout.write('{invalid}\\n');setInterval(()=>{},1000);`]};
  await session.prepareRegisteredOwner(f.options(session,{launch}));
  await assert.rejects(session.request('echo',{},5000),{code:'PI_PROTOCOL_INVALID'});
  assert.throws(()=>session.write({method:'late'}),{code:'PI_PROTOCOL_INVALID'});
  await session.child.waitForJobEmpty();assert.equal((await f.registry.read('frontdesk')).value.phase,'prepared');
  await assert.rejects(session.stop(),{code:'PI_EXIT_UNCONFIRMED'});
});

test('a changed registered instance is refused before the prepared CAS can write',native,async t=>{
  const f=await fixture(t),session=f.session(),original=f.storage.requireRegistered.bind(f.storage);let changed=false;
  try{await assert.rejects(session.prepareRegisteredOwner(f.options(session,{onPrepared:async()=>{changed=true;f.storage.requireRegistered=async(...args)=>({...await original(...args),instanceId:'controlled-changed-instance'});}})),{code:'PROJECT_IDENTITY_CONFLICT'});}
  finally{f.storage.requireRegistered=original;}
  assert.equal(changed,true);assert.equal((await f.registry.read('frontdesk')).value.phase,'intent');assert.equal(session.launchResumeAttempted,undefined);await missing(f.marker);
});

test('a local lifecycle seal after actual prepared commit produces UNKNOWN and prevents resume',native,async t=>{
  const f=await fixture(t),session=f.session(),original=f.storage.assertLocalOpen.bind(f.storage),request=f.storage.db.request.bind(f.storage.db);let sealed=false;
  f.storage.db.request=async(file,op,args)=>{const result=await request(file,op,args);if(op==='put'&&args.collection==='managed_owner_launches'&&args.value.phase==='prepared')sealed=true;return result;};
  f.storage.assertLocalOpen=(...args)=>{if(sealed)throw Object.assign(Error('controlled actual lifecycle seal'),{code:'PROJECT_LIFECYCLE_ACTIVE'});return original(...args);};
  try{await assert.rejects(session.prepareRegisteredOwner(f.options(session)),{code:'STORAGE_RESULT_UNKNOWN'});}
  finally{f.storage.db.request=request;f.storage.assertLocalOpen=original;}
  assert.equal((await createOwnerLaunchRegistry(f.storage,f.projectId).read('frontdesk')).value.phase,'prepared');assert.equal(session.launchResumeAttempted,undefined);await missing(f.marker);
});

for(const mode of ['normal','forced'])test(`actual ${mode} host exit after durable prepared registration retains cold evidence and executes no child marker`,native,async t=>{
  const f=await fixture(t),script=path.join(f.root,'host.mjs'),ready=path.join(f.root,'ready.json'),exit=path.join(f.root,'exit');
  await fs.writeFile(script,`import fs from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';
    import {ProjectStorage} from ${JSON.stringify(new URL('../src/main/project-storage.mjs',import.meta.url).href)};
    import {createOwnerLaunchRegistry} from ${JSON.stringify(new URL('../src/main/owner-launch-registry.mjs',import.meta.url).href)};
    import {PiSession} from ${JSON.stringify(new URL('../src/agents/managed/pi-session.mjs',import.meta.url).href)};
    import {prepareExperimentalProcessTransport as prepare} from ${JSON.stringify(new URL('../src/platform/windows/experimental-process-transport.mjs',import.meta.url).href)};
    const input=JSON.parse(process.argv[2]),storage=new ProjectStorage(input.profile,{experimentalWindowsRoot:input.root,experimentalWindowsInitialization:true});await storage.requireRegistered(input.projectId);
    const actual=createOwnerLaunchRegistry(storage,input.projectId),registry={begin:b=>actual.begin(b),async register(...args){const receipt=await actual.register(...args);await fs.writeFile(input.ready,JSON.stringify(receipt));for(;;){try{await fs.stat(input.exit);process.exit(91);}catch(error){if(error.code!=='ENOENT')throw error;}await delay(10);}}};
    const session=new PiSession({role:'frontdesk',home:input.root+'/home',cwd:input.root});await session.prepareRegisteredOwner({registry,target:'frontdesk',launch:input.launch,prepare,isCurrent:()=>true});`);
  const child=spawn(process.execPath,[script,JSON.stringify({root:f.root,profile:f.profile,projectId:f.projectId,ready,exit,launch:f.launch})],{env:Object.fromEntries(f.env.map(entry=>{const i=entry.indexOf('=');return [entry.slice(0,i),entry.slice(i+1)];})),stdio:['ignore','pipe','pipe'],windowsHide:true});f.children.push(child);let diagnostics='';child.stderr.on('data',part=>diagnostics+=part);child.stdout.resume();
  const receipt=await until(async()=>{try{return JSON.parse(await fs.readFile(ready,'utf8'));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;assert.equal(child.exitCode,null,diagnostics);}});
  const pin=f.read(receipt.record.identity.pid);assert.equal(pin.snapshot().state,'running');const exited=once(child,'exit');
  if(mode==='normal')await fs.writeFile(exit,'exit');else child.kill();const result=await exited;
  if(mode==='normal')assert.equal(result[0],91);else assert.equal(result[1],'SIGTERM');
  await until(()=>pin.snapshot().state==='exited');await missing(f.marker);const cold=createOwnerLaunchRegistry(f.storage,f.projectId),record=await cold.read('frontdesk');
  assert.equal(record.value.phase,'prepared');assert.deepEqual(record.value.identity,receipt.record.identity);
  const retry=f.session();await assert.rejects(retry.prepareRegisteredOwner(f.options(retry,{registry:cold})),{code:'STORAGE_CONFLICT'});assert.equal(f.transports.length,0);
});
