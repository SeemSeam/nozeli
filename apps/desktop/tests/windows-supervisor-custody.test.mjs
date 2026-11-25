import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {acquireExperimentalHostLease as acquire,startExperimentalHostSupervisor as supervise} from '../src/platform/windows/experimental-host-lease.mjs';
import {createExperimentalProcessJob as create,waitExperimentalJobEmpty as wait} from '../src/platform/windows/experimental-process-job.mjs';
import {startExperimentalProcessSupervisor as start,connectExperimentalProcessSupervisor as connect,experimentalSupervisorEndpoint as endpoint} from '../src/platform/windows/experimental-process-supervisor.mjs';
import {openExperimentalPersistenceParent as parent} from '../src/platform/windows/experimental-persistence.mjs';
import {security} from './fixtures/windows-security.mjs';
import {inspectExperimentalColdHostSources} from '../src/platform/windows/experimental-host-sources.mjs';
import {createOwnerLaunchRegistry} from '../src/main/owner-launch-registry.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {randomUUID} from 'node:crypto';
const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:30000};
const binding=()=>createRequire(import.meta.url)('../native/windows/build/Release/nozeli_windows_read.node');
const env=root=>({SystemRoot:process.env.SystemRoot,TEMP:root,TMP:root,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})});
async function until(fn){const deadline=performance.now()+12000;for(;;){const value=await fn();if(value)return value;if(performance.now()>deadline)assert.fail('Custody fixture timeout');await delay(10);}}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli custody 中文 ')),project=path.join(root,'project'),profile=path.join(root,'profile');await fs.mkdir(project);
  const storage=new ProjectStorage(profile,{experimentalWindowsRoot:root,experimentalWindowsInitialization:true}),projectId=(await storage.register(project)).id;
  const database=path.join(await storage.localDirectory(projectId),'ui.sqlite'),anchor=path.join((await storage.requireOnline(projectId)).metadataRoot,'managed-host.lease');
  const jobs=[],pins=[],leases=[],children=[],storages=[storage];
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const end=once(child,'exit');child.kill();await end;}
    for(const job of jobs){if(!job.snapshot().jobEmptyObserved)job.terminate();await wait(job);}
    for(const pin of pins.reverse()){try{if(pin.shutdown)pin.shutdown();}finally{pin.close();}}
    for(const job of jobs)job.close();for(const lease of leases)lease.abandon();for(const entry of storages)await entry.db.close();await fs.rm(root,{recursive:true,force:true});
  });
  return {root,profile,storage,projectId,database,anchor,jobs,pins,leases,children,
    observer(){const value=new ProjectStorage(profile,{experimentalWindowsRoot:root,experimentalWindowsInitialization:true});storages.push(value);return value;},
    async hold(){const lease=await acquire({storage,projectId});leases.push(lease);return lease;},
    job(){const job=create({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:root,env:Object.entries(env(root)).map(([k,v])=>k+'='+v)});jobs.push(job);return job;}};
}

test('owner home custody retains directory identity after the original pin closes while allowing journal writes',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),home=path.join(f.profile,'owner-home');
  await ensureExperimentalPrivateDirectory(f.root,home);
  const original=parent(f.root,path.relative(f.root,path.join(home,'__custody__')).split(path.sep).join('/')),identity=original.identity();
  const registry=createOwnerLaunchRegistry(f.storage,f.projectId,{hostLease:lease});
  const intent=await registry.begin({target:'frontdesk',ownerId:randomUUID(),generation:randomUUID(),launchId:randomUUID(),home});
  try{
    assert.throws(()=>registry.startSupervisor(f.job(),intent.record.launchId,{}),{code:'CUSTODY_SPEC_INVALID'});
    const closed=parent(f.root,path.relative(f.root,path.join(home,'__custody__')).split(path.sep).join('/'));closed.close();
    assert.throws(()=>registry.startSupervisor(f.job(),intent.record.launchId,closed),{code:'CUSTODY_ENTITY_CHANGED'});
    const job=f.job(),pin=registry.startSupervisor(job,intent.record.launchId,original);f.pins.push(pin);original.close();
    const record=endpoint(pin);assert.equal(record.custodyRoles,63);assert.equal(record.ownerHomeIdentity,identity);
    await fs.writeFile(path.join(home,'journal.jsonl'),'mutable journal\n');
    await assert.rejects(fs.rename(home,home+'.winner'),e=>['EBUSY','EPERM','EACCES'].includes(e.code));
    assert.equal(pin.snapshot().ownerHomeDirectoryCustodyVerified,true);
    assert.throws(()=>connect({...record,ownerHomeIdentity:'0'.repeat(16)+':'+ '0'.repeat(32)}),{code:'CUSTODY_ENTITY_CHANGED'});
    assert.throws(()=>connect({...record,custodyRoles:31}),{code:'CUSTODY_SPEC_INVALID'});
    const handleCount=()=>{
      const result=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile','-Command',`(Get-Process -Id ${process.pid}).HandleCount`],{env:env(f.root),windowsHide:true,encoding:'utf8',timeout:15000});
      assert.equal(result.status,0,result.stderr);const value=Number(result.stdout.trim());assert.ok(Number.isSafeInteger(value)&&value>0);return value;
    };
    handleCount();await delay(50);const beforeHandles=handleCount();
    for(let attempt=0;attempt<16;attempt++)assert.throws(()=>connect({...record,ownerHomeIdentity:'0'.repeat(16)+':'+ '0'.repeat(32)}),{code:'CUSTODY_ENTITY_CHANGED'});
    await delay(50);assert.ok(handleCount()<=beforeHandles+8,'Repeated rejected home identities must close all transferred Job/process/launch-set HANDLEs');
    const observer=connect(record);observer.close();job.terminate();await wait(job);
  }finally{original.close();}
});

test('native opaque custody rejects forged, closed and consumed bundles without exporting HANDLE integers',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),a=parent(f.root,path.relative(f.root,f.anchor).split(path.sep).join('/')),d=parent(f.root,path.relative(f.root,f.database).split(path.sep).join('/'));
  const anchor=a.openPrivateTreeFile.bind(a); // The host already owns its write pin.
  assert.throws(()=>anchor(path.basename(f.anchor)),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===32);
  for(const value of [{},null,process.pid]){
    assert.throws(()=>binding().createSupervisorCustody(value,{}),{code:'CUSTODY_SPEC_INVALID'});
    assert.throws(()=>start(f.job(),value),{code:'CUSTODY_SPEC_INVALID'});
  }
  a.close();d.close();
  const pin=supervise(lease,{storage:f.storage,projectId:f.projectId},f.job());f.pins.push(pin);
  const record=endpoint(pin);assert.ok(record.custodyEntityCount>=6);assert.match(record.custodySha256,/^[a-f0-9]{64}$/);
  assert.equal(pin.snapshot().custodyVerified,true);
  assert.equal(pin.snapshot().sourceCustodyVerified,true);assert.equal(record.custodyRoles,31);
  assert.match(record.sourceSha256,/^[a-f0-9]{64}$/);assert.equal(pin.snapshot().sourceSha256,record.sourceSha256);
  for(const changed of [{custodySha256:'0'.repeat(64)},{custodyEntityCount:record.custodyEntityCount+1},{sourceSha256:'1'.repeat(64)}])
    assert.throws(()=>connect({...record,...changed}),{code:'CUSTODY_ENTITY_CHANGED'});
  assert.throws(()=>connect({...record,custodyRoles:3}),{code:'CUSTODY_SPEC_INVALID'});
  await assert.rejects(lease.release(),{code:'HOST_LEASE_BUSY'});
});

test('custody bundle close and one-shot transfer are checked natively; local duplicate retains original write exclusion',native,async t=>{
  const f=await fixture(t),lease=await f.hold();lease.abandon();
  const a=parent(f.root,path.relative(f.root,f.anchor).split(path.sep).join('/')),d=parent(f.root,path.relative(f.root,f.database).split(path.sep).join('/'));
  const file=a.openPrivateTreeFile(path.basename(f.anchor)),db=d.openPrivateDatabase('ui.sqlite',true);
  const bundle=binding().createSupervisorCustody(file,db),closed=binding().createSupervisorCustody(file,db);closed.close();
  assert.deepEqual(Object.keys(bundle),[]);assert.equal(JSON.stringify(bundle),'{}');
  assert.throws(()=>start(f.job(),closed),{code:'CUSTODY_CLOSED'});
  file.close();db.close();a.close();d.close();
  await assert.rejects(fs.writeFile(f.anchor,'contender'),error=>['EBUSY','EPERM','EACCES'].includes(error.code));
  const pin=start(f.job(),bundle);f.pins.push(pin);
  assert.throws(()=>start(f.job(),bundle),{code:'CUSTODY_TRANSFER_REFUSED'});bundle.close();
  await assert.rejects(fs.writeFile(f.anchor,'contender'),error=>['EBUSY','EPERM','EACCES'].includes(error.code));
});

for(const mode of ['normal','forced'])for(const resumed of [false,true])test(`${mode} host death (${resumed?'running':'prepared'}) leaves helper alone holding anchor/database/parent entities until explicit cleanup`,native,async t=>{
  const f=await fixture(t),ready=path.join(f.root,'ready.json'),stop=path.join(f.root,'stop'),script=path.join(f.root,'host.mjs');
  await f.storage.db.close(); // The helper must be the only surviving source file custodian.
  const module=relative=>new URL(relative,import.meta.url).href;
  await fs.writeFile(script,`import fs from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';import {randomUUID} from 'node:crypto';
    import {ProjectStorage} from ${JSON.stringify(module('../src/main/project-storage.mjs'))};
    import {acquireExperimentalHostLease,startExperimentalHostSupervisor} from ${JSON.stringify(module('../src/platform/windows/experimental-host-lease.mjs'))};
    import {createExperimentalProcessJob} from ${JSON.stringify(module('../src/platform/windows/experimental-process-job.mjs'))};
    import {experimentalSupervisorEndpoint} from ${JSON.stringify(module('../src/platform/windows/experimental-process-supervisor.mjs'))};
    import {createOwnerLaunchRegistry} from ${JSON.stringify(module('../src/main/owner-launch-registry.mjs'))};
    const i=JSON.parse(process.argv[2]),storage=new ProjectStorage(i.profile,{experimentalWindowsRoot:i.root,experimentalWindowsInitialization:true});
    const lease=await acquireExperimentalHostLease({storage,projectId:i.projectId});
    const registry=createOwnerLaunchRegistry(storage,i.projectId,{hostLease:lease});
    const intent=await registry.begin({target:'frontdesk',ownerId:randomUUID(),generation:randomUUID(),launchId:randomUUID(),home:i.root});
    const job=createExperimentalProcessJob({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:i.root,env:i.env});
    const pin=registry.startSupervisor(job,intent.record.launchId),facts=job.snapshot();
    await registry.register(intent,{schema:1,platform:'win32',pid:facts.pid,creationTime100ns:facts.creationTime100ns,stamp:facts.stamp},pin);if(i.resumed)job.resume();
    await fs.writeFile(i.ready,JSON.stringify(experimentalSupervisorEndpoint(pin)));
    for(;;){try{await fs.stat(i.stop);process.exit(91);}catch(e){if(e.code!=='ENOENT')throw e;}await delay(10);}`);
  const child=spawn(process.execPath,[script,JSON.stringify({root:f.root,profile:f.profile,projectId:f.projectId,ready,stop,resumed,env:Object.entries(env(f.root)).map(([k,v])=>k+'='+v)})],{env:env(f.root),stdio:['ignore','ignore','pipe'],windowsHide:true});f.children.push(child);
  let diagnostics='';child.stderr.on('data',bytes=>diagnostics+=bytes);
  const record=await until(async()=>{try{return JSON.parse(await fs.readFile(ready,'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;assert.equal(child.exitCode,null,diagnostics);}});
  const end=once(child,'exit');if(mode==='normal')await fs.writeFile(stop,'stop');else child.kill();await end;
  const pin=connect(record);f.pins.push(pin);await until(()=>pin.snapshot().jobEmptyObserved);
  assert.equal(pin.snapshot().hostExited,true);assert.equal(pin.snapshot().custodyVerified,true);assert.ok(pin.snapshot().custodyEntityCount>=6);
  assert.equal(pin.snapshot().sourceCustodyVerified,true);
  // This parent process has never opened ui.sqlite: SQLite cannot mask failure
  // of the helper's inherited sharing restrictions in these replacement tests.
  const anchorBytes=await fs.readFile(f.anchor),dbBytes=await fs.readFile(f.database);
  await assert.rejects(fs.writeFile(f.anchor,'second host'),error=>['EBUSY','EPERM','EACCES'].includes(error.code));
  const manifest=path.join(path.dirname(f.anchor),'project.json'),projectDatabase=path.join(path.dirname(f.anchor),'project.sqlite');
  await assert.rejects(fs.writeFile(manifest,'foreign project'),error=>['EBUSY','EPERM','EACCES'].includes(error.code));
  for(const file of [f.anchor,f.database,f.storage.catalog,projectDatabase,manifest,path.dirname(f.anchor),path.dirname(f.database),f.profile,path.join(f.root,'project')])
    await assert.rejects(fs.rename(file,file+'.contender'),error=>['EBUSY','EPERM','EACCES'].includes(error.code));
  const observer=f.observer();
  await assert.rejects(acquire({storage:observer,projectId:f.projectId}),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===32);
  assert.deepEqual(await fs.readFile(f.anchor),anchorBytes);assert.deepEqual(await fs.readFile(f.database),dbBytes);
  assert.equal(pin.snapshot().coldRecoveryQualified,false);
  const observation=await inspectExperimentalColdHostSources({storage:observer,projectId:f.projectId,target:'frontdesk',supervisor:pin});
  assert.equal(observation.sourceRecordsVerified,true);assert.equal(observation.ownerReleaseQualified,false);assert.equal(observation.automaticReplay,false);
  assert.equal(observation.crossDatabaseAtomicityQualified,false);
  const registry=createOwnerLaunchRegistry(observer,f.projectId),owner=await registry.read('frontdesk');
  await assert.rejects(registry.retire(owner,observation),{code:'OWNER_EXIT_INVALID'});
  if(mode==='forced'&&resumed){
    const source=observation.source;
    await observer.db.request(projectDatabase,'put',{collection:'identity',id:'project',value:source.projectDatabase.identity.value,expectedRevision:source.projectDatabase.identity.revision});
    await assert.rejects(inspectExperimentalColdHostSources({storage:observer,projectId:f.projectId,target:'frontdesk',supervisor:pin}),{code:'HOST_SOURCE_CHANGED'});
    assert.deepEqual(await registry.read('frontdesk'),owner);
    // An external writer may rewrite both source rows and their declaration.
    // The original helper, rather than mutable SQLite, anchors the digest.
    const host=await observer.db.request(f.database,'record',{collection:'managed_host_leases',id:'host'}),winner=structuredClone(host.value);
    winner.source.projectDatabase.identity=await observer.db.request(projectDatabase,'record',{collection:'identity',id:'project'});
    await observer.db.request(f.database,'put',{collection:'managed_host_leases',id:'host',value:winner,expectedRevision:host.revision});
    await assert.rejects(inspectExperimentalColdHostSources({storage:observer,projectId:f.projectId,target:'frontdesk',supervisor:pin}),{code:'HOST_SOURCE_BINDING_CHANGED'});
    const forged=structuredClone(owner.value);
    forged.supervision.sourceSha256=createHash('sha256').update(JSON.stringify(winner.source)).digest('hex');
    await observer.db.request(f.database,'put',{collection:'managed_owner_launches',id:'frontdesk',value:forged,expectedRevision:owner.revision});
    assert.throws(()=>connect(forged.supervision),{code:'CUSTODY_ENTITY_CHANGED'});
    await assert.rejects(inspectExperimentalColdHostSources({storage:observer,projectId:f.projectId,target:'frontdesk',supervisor:pin}),{code:'HOST_SOURCE_BINDING_CHANGED'});
    assert.deepEqual((await observer.db.request(f.database,'record',{collection:'managed_host_leases',id:'host'})).value,winner);
    assert.deepEqual((await registry.read('frontdesk')).value,forged);
  }
  await observer.db.close();
  pin.shutdown();pin.close();f.pins.splice(f.pins.indexOf(pin),1);
  // Only component cleanup is proved. Sticky host row still forbids adoption.
  const reopened=await fs.open(f.anchor,'r+');await reopened.close();
  await fs.rename(f.database,f.database+'.after');await fs.rename(f.database+'.after',f.database);
  await assert.rejects(acquire({storage:f.observer(),projectId:f.projectId}),{code:'HOST_LEASE_RECOVERY_REQUIRED'});
});

test('helper custody ACL drift refuses observation and empty-Job cleanup and retains the original pin',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),job=f.job(),pin=supervise(lease,{storage:f.storage,projectId:f.projectId},job);f.pins.push(pin);
  job.terminate();await wait(job);const record=endpoint(pin);
  try{
    security('add-write',f.anchor);
    assert.throws(()=>pin.snapshot(),{code:'SUPERVISOR_REQUEST_REFUSED'});
    assert.throws(()=>pin.shutdown(),{code:'SUPERVISOR_REQUEST_REFUSED'});
    await assert.rejects(lease.release());
    await assert.rejects(fs.writeFile(f.anchor,'contender'),error=>['EBUSY','EPERM','EACCES'].includes(error.code));
  }finally{
    // Fixture disposal kills only the original helper whose process HANDLE is
    // still retained by pin. A changed anchor never receives a release proof.
    process.kill(record.supervisorPid);
    await until(()=>{try{pin.snapshot();return false;}catch(error){return error.code==='SUPERVISOR_IDENTITY_UNVERIFIED';}});
    pin.close();f.pins.splice(f.pins.indexOf(pin),1);
  }
});
