import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {createOwnerLaunchRegistry} from '../src/main/owner-launch-registry.mjs';
import {acquireExperimentalHostLease as acquire,verifyExperimentalHostRegistration as confirm} from '../src/platform/windows/experimental-host-lease.mjs';
import {openExperimentalPersistenceParent as open} from '../src/platform/windows/experimental-persistence.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:30000};
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli sources 中文 ')),profile=path.join(root,'profile'),project=path.join(root,'project');await fs.mkdir(project);
  const storage=new ProjectStorage(profile,{experimentalWindowsRoot:root,experimentalWindowsInitialization:true}),projectId=(await storage.register(project)).id;
  const database=path.join(await storage.localDirectory(projectId),'ui.sqlite'),projectDatabase=path.join(project,'.nozeli','project.sqlite');
  const leases=[],pins=[],options={storage,projectId};
  t.after(async()=>{for(const lease of leases)lease.abandon();for(const pin of pins.reverse())pin.close();await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,storage,projectId,database,projectDatabase,options,pins,
    async hold(){const lease=await acquire(options);leases.push(lease);return lease;},
    catalog:()=>storage.db.request(storage.catalog,'record',{collection:'instances',id:projectId,mustExist:true}),
    identity:()=>storage.db.request(projectDatabase,'record',{collection:'identity',id:'project',mustExist:true}),
    host:()=>storage.db.request(database,'record',{collection:'managed_host_leases',id:'host'}),
    launch:()=>({target:'frontdesk',ownerId:randomUUID(),generation:randomUUID(),launchId:randomUUID(),home:root}),
  };
}

test('retained source entities coexist with checkedMetadata reads and ordinary catalog/project business transactions',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),source=lease.facts().source;
  assert.match(source.catalog.entityIdentity,/^[a-f0-9]+:[a-f0-9]{32}$/);assert.notEqual(source.catalog.entityIdentity,source.projectDatabase.entityIdentity);
  assert.equal(source.catalog.registration.value.instanceId,lease.facts().instanceId);
  assert.equal(source.crossDatabaseAtomicityQualified,false);
  await f.storage.db.request(f.storage.catalog,'put',{collection:'unrelated',id:'note',value:{draft:'保留'}});
  await f.storage.db.request(f.projectDatabase,'put',{collection:'synthetic-business',id:'note',value:{text:'合法的项目事务'}});
  assert.equal((await f.storage.requireOnline(f.projectId)).id,f.projectId);
  await confirm(lease,f.options);assert.deepEqual(lease.facts().source,source);
  assert.equal((await lease.release()).record.phase,'retired');
});

test('a real catalog winner hidden by requireRegistered cache prevents durable owner intent and retains the winner',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),before=await f.catalog(),cached=await f.storage.requireRegistered(f.projectId);
  const winner={...before.value,instanceId:randomUUID()};
  await f.storage.db.request(f.storage.catalog,'put',{collection:'instances',id:f.projectId,value:winner,expectedRevision:before.revision});
  assert.deepEqual(await f.storage.requireRegistered(f.projectId),cached);
  const registry=createOwnerLaunchRegistry(f.storage,f.projectId,{hostLease:lease});
  await assert.rejects(registry.begin(f.launch()),{code:'HOST_SOURCE_CHANGED'});
  assert.deepEqual((await f.catalog()).value,winner);
  assert.deepEqual(await f.storage.db.request(f.database,'list',{collection:'managed_owner_launches'}),[]);
  await assert.rejects(lease.release(),{code:'HOST_SOURCE_CHANGED'});
});

for(const role of ['catalog','project'])test(`same-value ${role} identity rewrite changes the real revision and permanently fences the retained host`,native,async t=>{
  const f=await fixture(t),lease=await f.hold(),source=role==='catalog'?{file:f.storage.catalog,collection:'instances',id:f.projectId,row:await f.catalog()}:
    {file:f.projectDatabase,collection:'identity',id:'project',row:await f.identity()};
  await f.storage.db.request(source.file,'put',{collection:source.collection,id:source.id,value:source.row.value,expectedRevision:source.row.revision});
  await assert.rejects(confirm(lease,f.options),{code:'HOST_SOURCE_CHANGED'});
  assert.throws(()=>lease.verify(),{code:'HOST_SOURCE_CHANGED'});
  assert.equal((await f.host()).value.phase,'active');
});

test('catalog ABA restores the original JSON but cannot restore its retained revision',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),before=await f.catalog();
  const first=await f.storage.db.request(f.storage.catalog,'put',{collection:'instances',id:f.projectId,value:{...before.value,instanceId:randomUUID()},expectedRevision:before.revision});
  await f.storage.db.request(f.storage.catalog,'put',{collection:'instances',id:f.projectId,value:before.value,expectedRevision:first.revision});
  assert.deepEqual((await f.catalog()).value,before.value);
  await assert.rejects(confirm(lease,f.options),{code:'HOST_SOURCE_CHANGED'});assert.equal((await f.host()).value.phase,'active');
});

for(const phase of ['active','retired'])test(`source revision changes after the real ${phase} host commit preserve UNKNOWN and never replay retirement`,native,async t=>{
  const f=await fixture(t),lease=phase==='retired'?await f.hold():null,request=f.storage.db.request.bind(f.storage.db);let changed=0;
  f.storage.db.request=async(file,op,args)=>{
    const result=await request(file,op,args);
    if(op==='put'&&args.collection==='managed_host_leases'&&args.value.phase===phase){
      changed++;const identity=await request(f.projectDatabase,'record',{collection:'identity',id:'project'});
      await request(f.projectDatabase,'put',{collection:'identity',id:'project',value:identity.value,expectedRevision:identity.revision});
    }
    return result;
  };
  try{await assert.rejects(lease?lease.release():f.hold(),{code:'STORAGE_RESULT_UNKNOWN'});}
  finally{f.storage.db.request=request;}
  assert.equal(changed,1);assert.equal((await f.host()).value.phase,phase);
  if(lease){await assert.rejects(lease.release(),{code:'STORAGE_RESULT_UNKNOWN'});assert.equal(changed,1);}
});

test('acquisition reads the actual catalog before activating a stale cached project and leaves source winner intact',native,async t=>{
  const f=await fixture(t),before=await f.catalog(),winner={...before.value,instanceId:randomUUID()};
  await f.storage.db.request(f.storage.catalog,'put',{collection:'instances',id:f.projectId,value:winner,expectedRevision:before.revision});
  await assert.rejects(f.hold(),{code:'HOST_SOURCE_CHANGED'});
  assert.equal(await f.host(),null);assert.deepEqual((await f.catalog()).value,winner);
});

test('native source roles reject swapped databases, partial tuples and a writable manifest while exposing checked database File IDs',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),source=lease.facts().source;lease.abandon();
  const pin=file=>{const parent=open(f.root,path.relative(f.root,file).split(path.sep).join('/'));f.pins.push(parent);return parent;};
  const metadata=path.join(path.dirname(f.projectDatabase),'managed-host.lease'),parent=pin(metadata),anchor=parent.openPrivateTreeFile('managed-host.lease');f.pins.push(anchor);
  const database=file=>{const value=pin(file).openPrivateDatabase(path.basename(file),true);f.pins.push(value);return value;};
  const ui=database(f.database),catalog=database(f.storage.catalog),project=database(f.projectDatabase),manifest=parent.openPrivateObjectRead('project.json');f.pins.push(manifest);
  const native=createRequire(import.meta.url)('../native/windows/build/Release/nozeli_windows_read.node');
  assert.throws(()=>native.createSupervisorCustody(anchor,ui,project,catalog,manifest,'1'.repeat(64)),{code:'CUSTODY_SPEC_INVALID'});
  assert.throws(()=>native.createSupervisorCustody(anchor,ui,catalog),{code:'CUSTODY_SPEC_INVALID'});
  assert.throws(()=>native.createSupervisorCustody(anchor,ui,catalog,project,anchor,'1'.repeat(64)),{code:'CUSTODY_SPEC_INVALID'});
  for(const digest of [undefined,null,{},'1'.repeat(63),'G'.repeat(64),'0'.repeat(64)])
    assert.throws(()=>native.createSupervisorCustody(anchor,ui,catalog,project,manifest,digest),{code:'CUSTODY_SPEC_INVALID'});
  assert.equal(catalog.identity(),source.catalog.entityIdentity);assert.equal(project.identity(),source.projectDatabase.entityIdentity);
  const id=catalog.identity();catalog.close();assert.throws(()=>catalog.identity(),{code:'FS_HANDLE_CLOSED'});assert.ok(id.length>32);
});
