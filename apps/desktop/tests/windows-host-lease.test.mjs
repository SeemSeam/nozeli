import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {createOwnerLaunchRegistry} from '../src/main/owner-launch-registry.mjs';
import {acquireExperimentalHostLease as acquire,verifyExperimentalHostLease,verifyExperimentalHostWorkOwner,readExperimentalHostRetiredOwner} from '../src/platform/windows/experimental-host-lease.mjs';
import {openExperimentalPersistenceParent} from '../src/platform/windows/experimental-persistence.mjs';
import {openExperimentalProcessIdentity} from '../src/platform/windows/experimental-process-identity.mjs';
import {security} from './fixtures/windows-security.mjs';
import {PiSession} from '../src/agents/managed/pi-session.mjs';
import {createExperimentalProcessJob} from '../src/platform/windows/experimental-process-job.mjs';
import {retainExperimentalOwnerExitProof} from '../src/platform/windows/experimental-owner-exit-proof.mjs';
import {prepareExperimentalProcessTransport} from '../src/platform/windows/experimental-process-transport.mjs';
const modules={storage:new URL('../src/main/project-storage.mjs',import.meta.url).href,lease:new URL('../src/platform/windows/experimental-host-lease.mjs',import.meta.url).href,
  registry:new URL('../src/main/owner-launch-registry.mjs',import.meta.url).href,transport:new URL('../src/platform/windows/experimental-process-transport.mjs',import.meta.url).href,
  exitProof:new URL('../src/platform/windows/experimental-owner-exit-proof.mjs',import.meta.url).href};
const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:40000};
const collection='managed_host_leases',id='host',releases=leaseId=>'managed_host_release_completions:'+leaseId;
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli host 中文 ')),project=path.join(root,'project'),profile=path.join(root,'profile');await fs.mkdir(project);
  const storage=new ProjectStorage(profile,{experimentalWindowsRoot:root,experimentalWindowsInitialization:true});
  const projectId=(await storage.register(project)).id,binding=await storage.requireOnline(projectId),leases=[],children=[],pins=[],transports=[];
  const database=path.join(await storage.localDirectory(projectId),'ui.sqlite'),anchor=path.join(binding.metadataRoot,'managed-host.lease');
  const options={storage,projectId};
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
    for(const child of transports){if(!child.lease.snapshot().jobEmptyObserved)child.terminate();await child.waitForJobEmpty();child.close();}
    for(const lease of leases)lease.abandon();for(const pin of pins)pin.close();await storage.db.close();
    await fs.rm(root,{recursive:true,force:true});
  });
  return {root,profile,projectId,binding,storage,database,anchor,options,leases,children,pins,transports,
    async hold(extra={}){const lease=await acquire({...options,...extra});leases.push(lease);return lease;},
    record:()=>storage.db.request(database,'record',{collection,id}),
    bindingFor:()=>({target:'frontdesk',ownerId:randomUUID(),generation:randomUUID(),launchId:randomUUID(),home:path.join(root,'home')}),
  };
}
async function until(fn){const deadline=performance.now()+10000;for(;;){const value=await fn();if(value)return value;if(performance.now()>deadline)assert.fail('synthetic host observation timeout');await delay(10);}}
const env=()=>({SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})});
function compete(operation,...args){
  return spawnSync(process.execPath,['-e',`try{require('fs')[process.argv[1]](...process.argv.slice(2));}catch(e){console.log(e.code);process.exitCode=7;}`,operation,...args],{env:env(),encoding:'utf8',windowsHide:true,timeout:10000});
}
// Real retired owner evidence: an actually launched Job observed to exit through
// its retained transport, retired through the live registry before release.
async function releaseWithOwner(f,target='worker'){
  const lease=await f.hold();
  const child=prepareExperimentalProcessTransport({command:process.execPath,args:['-e','process.exit(0)'],cwd:f.root,
    env:Object.entries(env()).map(([key,value])=>key+'='+value)});
  f.transports.push(child);
  const registry=createOwnerLaunchRegistry(f.storage,f.projectId,{hostLease:lease}),identity=child.preparedIdentity();
  const intent=await registry.begin({...f.bindingFor(),target});
  const prepared=await registry.register(intent,identity);
  child.stdout.resume();child.stderr.resume();child.resume();
  await child.waitForExitAndDrain();
  await until(async()=>child.lease.snapshot().allProcessIncarnationsObserved);
  await registry.retire(prepared,retainExperimentalOwnerExitProof(child,()=>({schema:1,scope:'same-host-exact-job-and-journal',
    allProcessIncarnationsObserved:true,stdoutEOF:true,stderrEOF:true,protocolComplete:true,
    journalSha256:createHash('sha256').update('synthetic final journal').digest('hex'),
    namespace:'synthetic-test-owner',coldRecoveryQualified:false})));
  return {receipt:await lease.release(),target};
}

test('native host custody pins shared project anchor and real SQLite while retaining normal retirement evidence',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),facts=lease.facts();
  assert.equal(facts.projectId,f.projectId);assert.equal(facts.instanceId,f.binding.instanceId);assert.equal(facts.host.pid,process.pid);
  assert.match(facts.host.stamp,new RegExp('^win32:'+process.pid+':\\d+$'));assert.equal(facts.host.inheritable,false);
  assert.equal(facts.host.treeExitVerified,false);assert.equal(facts.coldRecoveryQualified,false);
  assert.equal((await f.record()).value.leaseId,facts.leaseId);
  const acl=security('inspect',f.anchor);assert.equal(acl.protected,true);assert.equal(acl.rules.length,1);assert.equal(acl.rules[0].sid,acl.currentSid);
  const receipt=await lease.release();assert.equal(receipt.record.phase,'retired');assert.equal(receipt.revision,2);assert.deepEqual(receipt.disposal,{schema:1,scope:'windows-native-helper-and-host-custody-disposal-only',nativeSupervisorsShutdown:true,ownerLaunchClaimsRetired:true,hostRecordRetired:true,ownerHomesRetained:true,historicalRecoveryRecordsRetained:true,ownerReleaseQualified:false,coldRecoveryQualified:false,automaticReplay:false});
  assert.equal((await f.record()).value.phase,'retired');assert.equal(await fs.readFile(f.anchor,'utf8'),JSON.stringify({schema:1,scope:'explicit-host-custody-anchor',projectId:f.projectId}));
  assert.throws(()=>lease.facts(),{code:'HOST_LEASE_CLOSED'});
});

test('durable terminal normal-release publication authorizes receipt-less reacquisition; serialized or used receipts still refuse',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),receipt=await lease.release();
  await assert.rejects(f.hold({previousRelease:structuredClone(receipt)}),{code:'HOST_LEASE_RECOVERY_REQUIRED'});
  const warm=await f.hold({previousRelease:receipt});assert.equal(warm.facts().revision,3);const warmReceipt=await warm.release();
  assert.equal(warmReceipt.revision,4);await assert.rejects(f.hold({previousRelease:receipt}),{code:'HOST_LEASE_RECOVERY_REQUIRED'});
  const generations=[receipt.record.leaseId,warmReceipt.record.leaseId];
  let current=warmReceipt;
  for(const expectedRevision of [5,7]){
    // No WeakMap receipt can exist for a fresh process: only the durable terminal
    // publication of the exact current retired generation authorizes a successor.
    const next=await f.hold();
    assert.equal(next.facts().revision,expectedRevision);
    assert.notEqual(next.facts().leaseId,current.record.leaseId);
    assert.equal(next.facts().coldRecoveryQualified,false);
    current=await next.release();
    generations.push(current.record.leaseId);
  }
  for(const generation of generations){
    // Exact single-generation membership: each publication lives only in its
    // own collection and is never compared against historical generations.
    const completions=await f.storage.db.request(f.database,'list',{collection:releases(generation)});
    assert.deepEqual(completions.map(row=>row.id),[generation+':normal-release']);
    for(const row of completions){
      assert.equal(row.revision,1);
      assert.equal(row.value.scope,'windows-managed-normal-release-completion');
      assert.equal(row.value.durableRestartAuthority,true);
      assert.equal(row.value.executionAcknowledged,false);
      assert.equal(row.value.ownerReleaseQualified,false);
      assert.equal(row.value.coldRecoveryQualified,false);
      assert.equal(row.value.automaticReplay,false);
    }
  }
  const warmAgain=await f.hold({previousRelease:current});assert.equal(warmAgain.facts().revision,9);
  await warmAgain.release();
});

test('actual two-process normal release and reopen admits a fresh successor generation with real owner replacement',native,async t=>{
  const f=await fixture(t),script=path.join(f.root,'release-host.mjs'),proof=path.join(f.root,'release-proof.json'),home=path.join(f.root,'home');
  await fs.writeFile(script,`import fs from 'node:fs/promises';import {randomUUID,createHash} from 'node:crypto';
    import {ProjectStorage} from ${JSON.stringify(modules.storage)};
    import {acquireExperimentalHostLease as acquire} from ${JSON.stringify(modules.lease)};
    import {createOwnerLaunchRegistry} from ${JSON.stringify(modules.registry)};
    import {prepareExperimentalProcessTransport} from ${JSON.stringify(modules.transport)};
    import {retainExperimentalOwnerExitProof} from ${JSON.stringify(modules.exitProof)};
    const i=JSON.parse(process.argv[2]);
    const storage=new ProjectStorage(i.profile,{experimentalWindowsRoot:i.root,experimentalWindowsInitialization:true});
    const lease=await acquire({storage,projectId:i.projectId});
    const registry=createOwnerLaunchRegistry(storage,i.projectId,{hostLease:lease});
    const child=prepareExperimentalProcessTransport({command:process.execPath,args:['-e','process.exit(0)'],cwd:i.root,env:i.env});
    const identity=child.preparedIdentity();
    const intent=await registry.begin({target:'worker',ownerId:randomUUID(),generation:randomUUID(),launchId:randomUUID(),home:i.home});
    const prepared=await registry.register(intent,identity);
    child.stdout.resume();child.stderr.resume();child.resume();
    await child.waitForExitAndDrain();
    for(const deadline=performance.now()+10000;;){const facts=child.lease.snapshot();if(facts.allProcessIncarnationsObserved)break;
      if(performance.now()>deadline)throw Error('job incarnation observation timeout');await new Promise(resolve=>setTimeout(resolve,10));}
    const retired=await registry.retire(prepared,retainExperimentalOwnerExitProof(child,()=>({schema:1,scope:'same-host-exact-job-and-journal',
      allProcessIncarnationsObserved:true,stdoutEOF:true,stderrEOF:true,protocolComplete:true,
      journalSha256:createHash('sha256').update('synthetic final journal').digest('hex'),namespace:'synthetic-test-owner',coldRecoveryQualified:false})));
    child.close();
    const receipt=await lease.release();
    await fs.writeFile(i.proof,JSON.stringify({released:true,leaseId:receipt.record.leaseId,hostRevision:receipt.revision,
      ownerTarget:retired.record.target,ownerRevision:retired.revision}));
    await storage.db.close();`);
  const process1=spawn(process.execPath,[script,JSON.stringify({root:f.root,profile:f.profile,projectId:f.projectId,proof,home,
    env:Object.entries(env()).map(([key,value])=>key+'='+value)})],{env:env(),stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stderr='';process1.stderr.on('data',bytes=>stderr+=bytes);process1.stdout.resume();
  const [code,signal]=await once(process1,'exit');
  assert.equal(signal,null);assert.equal(code,0,stderr);
  const released=JSON.parse(await fs.readFile(proof,'utf8'));
  assert.equal(released.hostRevision,2);
  assert.equal((await f.record()).value.phase,'retired');
  const owner=await f.storage.db.request(f.database,'record',{collection:'managed_owner_launches',id:released.ownerTarget});
  assert.equal(owner.value.phase,'retired');assert.equal(owner.revision,released.ownerRevision);
  // A genuinely fresh process/object graph: no WeakMap receipt exists here.
  const next=await f.hold(),facts=next.facts();
  assert.equal(facts.phase,'active');assert.equal(facts.revision,3);assert.notEqual(facts.leaseId,released.leaseId);
  assert.equal(facts.coldRecoveryQualified,false);
  assert.deepEqual((await f.storage.db.request(f.database,'list',{collection:releases(released.leaseId)})).map(row=>row.id),
    [released.leaseId+':normal-release']);
  // The verified retired owner set becomes this successor's exact predecessor,
  // so the next generation can actually replace the retired owner.
  const original=await readExperimentalHostRetiredOwner(next,{storage:f.storage,projectId:f.projectId,target:released.ownerTarget});
  assert.equal(original.revision,owner.revision);
  const registry=createOwnerLaunchRegistry(f.storage,f.projectId,{hostLease:next});
  const replacement=await registry.begin({...f.bindingFor(),target:released.ownerTarget});
  assert.equal(replacement.revision,owner.revision+1);assert.equal(replacement.record.phase,'intent');
});

for(const scenario of ['altered-owner-revision','host-winner','forged-completion','missing-completion'])
  test(`${scenario} after a durable normal release refuses restart and leaves the winner rows untouched`,native,async t=>{
    const f=await fixture(t),{receipt,target}=await releaseWithOwner(f),leaseId=receipt.record.leaseId;
    if(scenario==='altered-owner-revision'){
      const row=await f.storage.db.request(f.database,'record',{collection:'managed_owner_launches',id:target});
      await f.storage.db.request(f.database,'put',{collection:'managed_owner_launches',id:target,value:row.value,expectedRevision:row.revision,operationId:'owner-same-value-rewrite'});
    }else if(scenario==='host-winner'){
      const row=await f.record();
      await f.storage.db.request(f.database,'put',{collection,id,value:{...row.value,phase:'external-winner'},expectedRevision:row.revision,operationId:'host-external-winner'});
    }else if(scenario==='forged-completion'){
      const row=await f.storage.db.request(f.database,'record',{collection:releases(leaseId),id:leaseId+':normal-release'});
      await f.storage.db.request(f.database,'put',{collection:releases(leaseId),id:leaseId+':normal-release',
        value:{...row.value,durableRestartAuthority:false},expectedRevision:row.revision,operationId:'forged-completion'});
    }else
      await f.storage.db.request(f.database,'delete',{collection:releases(leaseId),id:leaseId+':normal-release',operationId:'missing-completion'});
    await assert.rejects(f.hold(),error=>error.code==='HOST_LEASE_RECOVERY_REQUIRED'&&error.automaticReplay===false&&error.coldRecoveryQualified===false);
    if(scenario==='altered-owner-revision'){
      const row=await f.storage.db.request(f.database,'record',{collection:'managed_owner_launches',id:target});
      assert.equal(row.revision,4);
    }else if(scenario==='host-winner'){
      assert.equal((await f.record()).value.phase,'external-winner');
    }else if(scenario==='forged-completion'){
      const row=await f.storage.db.request(f.database,'record',{collection:releases(leaseId),id:leaseId+':normal-release'});
      assert.equal(row.revision,2);assert.equal(row.value.durableRestartAuthority,false);
    }else
      assert.deepEqual(await f.storage.db.request(f.database,'list',{collection:releases(leaseId)}),[]);
  });

test('lost terminal publication reply stays UNKNOWN to the issuer while read-only reconciliation admits the next opener',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),originalLeaseId=lease.facts().leaseId,request=f.storage.db.request.bind(f.storage.db);let lost=0;
  f.storage.db.request=async(file,op,args)=>{
    const result=await request(file,op,args);
    if(op==='compareAndPut'&&args.operationId?.endsWith(':normal-release')){
      lost++;throw Object.assign(Error('controlled terminal publication reply loss after real SQLite commit'),{code:'STORAGE_RESULT_UNKNOWN'});
    }
    return result;
  };
  try{
    await assert.rejects(lease.release(),error=>error.code==='STORAGE_RESULT_UNKNOWN'&&error.automaticReplay===false&&
      error.commitUnknown?.operationId===originalLeaseId+':normal-release');
  }finally{f.storage.db.request=request;}
  assert.equal(lost,1);
  assert.throws(()=>lease.facts(),{code:'STORAGE_RESULT_UNKNOWN'});
  await assert.rejects(lease.release(),{code:'STORAGE_RESULT_UNKNOWN'});
  lease.abandon();
  assert.equal((await f.record()).value.phase,'retired');
  // The durable terminal publication committed: a fresh opener verifies it
  // read-only and activates, without the issuer ever acknowledging completion.
  const next=await f.hold(),facts=next.facts();
  assert.equal(facts.revision,3);assert.notEqual(facts.leaseId,originalLeaseId);
  const completions=await f.storage.db.request(f.database,'list',{collection:releases(originalLeaseId)});
  await next.release();
  const after=await f.hold();assert.equal(after.facts().revision,5);await after.release();
});

test('unrelated prior-generation completion rows at the CAS row limit do not block release or restart',native,async t=>{
  const f=await fixture(t);
  // Two real normal generations: only the latest retired generation's own
  // publication is ever compared for restart or successor activation.
  const first=await f.hold(),firstReceipt=await first.release();
  const second=await f.hold(),secondReceipt=await second.release();
  // Synthetic unrelated rows in a historical generation's collection, filling
  // the storage worker's entire 16384-row compare budget. The former shared
  // collection design summed these into every publication and successor CAS
  // and eventually exhausted the budget; no host launch is involved here.
  const stale=releases(firstReceipt.record.leaseId);
  await f.storage.db.request(f.database,'putMany',{collection:stale,operationId:'synthetic-unrelated-release-rows',
    records:Array.from({length:16384},(_,index)=>({id:'unrelated-'+index,value:0,expectedRevision:0}))});
  assert.equal((await f.storage.db.request(f.database,'list',{collection:stale})).length,16385);
  const third=await f.hold();
  assert.equal(third.facts().revision,secondReceipt.revision+1);
  assert.notEqual(third.facts().leaseId,secondReceipt.record.leaseId);
  const thirdReceipt=await third.release();
  assert.deepEqual((await f.storage.db.request(f.database,'list',{collection:releases(thirdReceipt.record.leaseId)}))
    .map(row=>row.id),[thirdReceipt.record.leaseId+':normal-release']);
  const after=await f.hold();
  assert.equal(after.facts().revision,thirdReceipt.revision+1);
  await after.release();
});

test('second native writer and independent process cannot acquire, replace, remove or move the live custody entity',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),before=await fs.readFile(f.anchor,'utf8');
  await assert.rejects(f.hold(),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===32);
  for(const [op,args]of [['writeFileSync',[f.anchor,'foreign']],['unlinkSync',[f.anchor]],['renameSync',[f.anchor,f.anchor+'-moved']],['renameSync',[f.binding.metadataRoot,f.binding.metadataRoot+'-moved']],['renameSync',[f.database,f.database+'-moved']]]){
    const result=compete(op,...args);assert.ifError(result.error);assert.equal(result.status,7,result.stderr);assert.match(result.stdout,/EPERM|EACCES|EBUSY|UNKNOWN/);
  }
  assert.equal(await fs.readFile(f.anchor,'utf8'),before);lease.verify();await lease.release();
});

test('foreign native objects and another storage instance cannot authorize this host lease',native,async t=>{
  const f=await fixture(t),lease=await f.hold();
  assert.throws(()=>verifyExperimentalHostLease({...lease},f.options),{code:'HOST_LEASE_INVALID'});
  assert.throws(()=>verifyExperimentalHostLease(lease,{...f.options,storage:{}}),{code:'HOST_LEASE_BINDING_CHANGED'});
  assert.throws(()=>verifyExperimentalHostLease(lease,{...f.options,projectId:randomUUID()}),{code:'HOST_LEASE_BINDING_CHANGED'});
  await lease.release();
});

test('a pre-existing broad anchor is refused without repairing policy or contents',native,async t=>{
  const f=await fixture(t);await fs.writeFile(f.anchor,'foreign broad marker');
  security('add-write',f.anchor);const before=security('inspect',f.anchor);
  await assert.rejects(f.hold(),{code:'FS_SECURITY_CHANGED'});
  assert.deepEqual(security('inspect',f.anchor),before);assert.equal(await fs.readFile(f.anchor,'utf8'),'foreign broad marker');
});

test('actual hard-link drift fences a retained host and blocks new registry admission',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),registry=createOwnerLaunchRegistry(f.storage,f.projectId,{hostLease:lease}),alias=path.join(f.root,'alias');
  await fs.link(f.anchor,alias);assert.throws(()=>lease.verify(),{code:'FS_STAGE_CHANGED'});
  await assert.rejects(registry.begin(f.bindingFor()),{code:'FS_STAGE_CHANGED'});
  assert.equal((await f.record()).value.phase,'active');await fs.unlink(alias);
});

test('stop seals admission synchronously and an actual durable launch intent retains the host claim',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),registry=createOwnerLaunchRegistry(f.storage,f.projectId,{hostLease:lease});
  const launching=registry.begin(f.bindingFor());assert.equal(lease.facts().pendingLaunches,1);
  await assert.rejects(lease.release(),{code:'HOST_LEASE_BUSY'});const intent=await launching;
  assert.equal(intent.record.hostLeaseId,lease.facts().leaseId);
  await assert.rejects(registry.begin(f.bindingFor()),{code:'HOST_LEASE_STOPPING'});
  await assert.rejects(lease.release(),{code:'HOST_LEASE_BUSY'});assert.equal((await f.record()).value.phase,'active');
});

for(const phase of ['active','retired'])test(`actual host ${phase} commit followed by lost reply retains persistent evidence and refuses cold admission`,native,async t=>{
  const f=await fixture(t);let lease;
  if(phase==='retired')lease=await f.hold();
  const request=f.storage.db.request.bind(f.storage.db);let lost=0;
  f.storage.db.request=async(file,op,args)=>{const result=await request(file,op,args);if(args.collection===collection&&op==='put'&&args.value.phase===phase){lost++;throw Object.assign(Error('controlled reply loss after real SQLite commit'),{code:'STORAGE_RESULT_UNKNOWN'});}return result;};
  try{await assert.rejects(phase==='active'?f.hold():lease.release(),{code:'STORAGE_RESULT_UNKNOWN'});}finally{f.storage.db.request=request;}
  assert.equal(lost,1);assert.equal((await f.record()).value.phase,phase);
  if(lease){await assert.rejects(lease.release(),{code:'STORAGE_RESULT_UNKNOWN'});lease.abandon();}
  await assert.rejects(f.hold(),{code:'HOST_LEASE_RECOVERY_REQUIRED'});
});

test('external SQLite host winner blocks owner registration and remains untouched',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),old=await f.record(),winner={...old.value,leaseId:randomUUID(),phase:'external-winner'};
  await f.storage.db.request(f.database,'put',{collection,id,value:winner,expectedRevision:old.revision,operationId:'external-host-winner'});
  const registry=createOwnerLaunchRegistry(f.storage,f.projectId,{hostLease:lease});
  await assert.rejects(registry.begin(f.bindingFor()),{code:'HOST_LEASE_BINDING_CHANGED'});assert.deepEqual((await f.record()).value,winner);
});

test('another registered profile contends on the shared project entity and cannot treat its empty local database as a fresh host',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),foreign=new ProjectStorage(path.join(f.root,'second-profile'),{experimentalWindowsRoot:f.root,experimentalWindowsInitialization:true});
  t.after(()=>foreign.db.close());await foreign.ready();
  const binding={...f.binding,instanceId:randomUUID()};
  // Seed an actual separate synthetic catalog to model an independently
  // registered instance; this does not qualify production cross-profile import.
  await foreign.db.request(foreign.catalog,'put',{collection:'instances',id:f.projectId,value:binding});
  await assert.rejects(acquire({storage:foreign,projectId:f.projectId}),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===32);
  await lease.release();await assert.rejects(acquire({storage:foreign,projectId:f.projectId}),{code:'HOST_LEASE_RECOVERY_REQUIRED'});
  assert.equal(await foreign.db.request(path.join(await foreign.localDirectory(f.projectId),'ui.sqlite'),'record',{collection,id}),null);
  await foreign.db.close();
});

test('unissued serialized retired owner rows cannot authorize host retirement',native,async t=>{
  const f=await fixture(t),lease=await f.hold();
  await f.storage.db.request(f.database,'put',{collection:'managed_owner_launches',id:'foreign',value:{phase:'retired',launchId:randomUUID(),exit:{allProcessIncarnationsObserved:true}}});
  await assert.rejects(lease.release(),{code:'HOST_LEASE_BUSY'});assert.equal((await f.record()).value.phase,'active');
});

test('lost actual owner-intent reply retains both UNKNOWN registration and the host launch claim',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),registry=createOwnerLaunchRegistry(f.storage,f.projectId,{hostLease:lease}),request=f.storage.db.request.bind(f.storage.db);
  f.storage.db.request=async(file,op,args)=>{const result=await request(file,op,args);if(op==='put'&&args.collection==='managed_owner_launches')throw Object.assign(Error('controlled actual owner commit reply loss'),{code:'STORAGE_RESULT_UNKNOWN'});return result;};
  try{await assert.rejects(registry.begin(f.bindingFor()),{code:'STORAGE_RESULT_UNKNOWN'});}finally{f.storage.db.request=request;}
  assert.equal(lease.facts().pendingLaunches,1);await assert.rejects(lease.release(),{code:'HOST_LEASE_BUSY'});
  assert.equal((await f.storage.db.request(f.database,'record',{collection:'managed_owner_launches',id:'frontdesk'})).value.phase,'intent');
});

for(const stage of ['stop','abandon','host-winner','owner-winner'])test(`${stage} after actual prepared registration refuses the final shared resume barrier`,native,async t=>{
  const f=await fixture(t),lease=await f.hold(),registry=createOwnerLaunchRegistry(f.storage,f.projectId,{hostLease:lease});
  const marker=path.join(f.root,'must-not-execute'),session=new PiSession({role:'frontdesk',home:path.join(f.root,'home'),cwd:f.root});
  const launch={command:process.execPath,args:['-e',`require('fs').writeFileSync(process.argv[1],'executed');setInterval(()=>{},1000)`,marker],cwd:f.root,
    env:Object.entries(env()).map(([key,value])=>key+'='+value)};
  await assert.rejects(session.prepareRegisteredOwner({registry,target:'frontdesk',launch,isCurrent:()=>true,
    prepare:spec=>{const child=prepareExperimentalProcessTransport(spec);f.transports.push(child);return child;},
    onRegistered:async()=>{
      if(stage==='stop')await assert.rejects(lease.release(),{code:'HOST_LEASE_BUSY'});
      else if(stage==='abandon')lease.abandon();
      else{
        const targetCollection=stage==='host-winner'?collection:'managed_owner_launches',targetId=stage==='host-winner'?id:'frontdesk';
        const row=await f.storage.db.request(f.database,'record',{collection:targetCollection,id:targetId});
        await f.storage.db.request(f.database,'put',{collection:targetCollection,id:targetId,value:{...row.value,phase:'external-winner'},expectedRevision:row.revision});
      }
    },
  }),{code:{stop:'HOST_LEASE_STOPPING',abandon:'HOST_LEASE_CLOSED','host-winner':'HOST_LEASE_BINDING_CHANGED','owner-winner':'STORAGE_CONFLICT'}[stage]});
  assert.equal(session.launchResumeAttempted,undefined);await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  assert.equal(session.child.lease.snapshot().jobEmptyObserved,true);
});

test('Work ownership requires the original prepared receipt and refuses an actual SQLite generation winner',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),registry=createOwnerLaunchRegistry(f.storage,f.projectId,{hostLease:lease}),session=new PiSession({role:'worker',home:path.join(f.root,'home'),cwd:f.root});
  const launch={command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:f.root,env:Object.entries(env()).map(([key,value])=>key+'='+value)};
  const registration=await session.prepareRegisteredOwner({registry,target:'synthetic-work',launch,isCurrent:()=>true,prepare:spec=>{const child=prepareExperimentalProcessTransport(spec);f.transports.push(child);return child;}});
  const binding={...f.options,target:'synthetic-work',home:session.home,record:session.groupRecord,registration};
  await verifyExperimentalHostWorkOwner(lease,binding);
  await assert.rejects(verifyExperimentalHostWorkOwner(lease,{...binding,registration:undefined}),{code:'HOST_LEASE_OWNER_UNVERIFIED'});
  await assert.rejects(verifyExperimentalHostWorkOwner(lease,{...binding,retired:true}),{code:'HOST_LEASE_OWNER_UNVERIFIED'});
  const winner={...registration.record,generation:randomUUID()},result=await f.storage.db.request(f.database,'put',{collection:'managed_owner_launches',id:binding.target,value:winner,expectedRevision:registration.revision});
  await assert.rejects(verifyExperimentalHostWorkOwner(lease,{...binding,record:{...session.groupRecord,generation:winner.generation}}),{code:'HOST_LEASE_OWNER_UNVERIFIED'});
  assert.equal((await registry.read(binding.target)).revision,result.revision);assert.deepEqual((await registry.read(binding.target)).value,winner);
});

test('actual host retirement commit followed by an external owner winner fails postcheck and retains custody',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),request=f.storage.db.request.bind(f.storage.db);let changed=0;
  f.storage.db.request=async(file,op,args)=>{
    const result=await request(file,op,args);
    if(op==='put'&&args.collection===collection&&args.value.phase==='retired'){
      changed++;await request(f.database,'put',{collection:'managed_owner_launches',id:'foreign',value:{phase:'prepared',launchId:randomUUID()}});
    }
    return result;
  };
  try{await assert.rejects(lease.release(),{code:'STORAGE_RESULT_UNKNOWN'});}finally{f.storage.db.request=request;}
  assert.equal(changed,1);assert.equal((await f.record()).value.phase,'retired');
  await assert.rejects(lease.release(),{code:'STORAGE_RESULT_UNKNOWN'});
  await assert.rejects(f.hold(),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===32);
});

test('actual lifecycle seal after host retirement commit produces UNKNOWN and prevents reacquisition',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),request=f.storage.db.request.bind(f.storage.db),check=f.storage.assertLocalOpen.bind(f.storage);let sealed=false;
  f.storage.db.request=async(file,op,args)=>{const result=await request(file,op,args);if(op==='put'&&args.collection===collection&&args.value.phase==='retired')sealed=true;return result;};
  f.storage.assertLocalOpen=(...args)=>{if(sealed)throw Object.assign(Error('controlled lifecycle seal'),{code:'PROJECT_LIFECYCLE_ACTIVE'});return check(...args);};
  try{await assert.rejects(lease.release(),{code:'STORAGE_RESULT_UNKNOWN'});}finally{f.storage.db.request=request;f.storage.assertLocalOpen=check;}
  assert.equal((await f.record()).value.phase,'retired');lease.abandon();await assert.rejects(f.hold(),{code:'HOST_LEASE_RECOVERY_REQUIRED'});
});

for(const mode of ['normal','forced'])test(`actual ${mode} host death releases kernel custody but preserves cold UNKNOWN, drafts and unrelated sentinel`,native,async t=>{
  const f=await fixture(t),script=path.join(f.root,'host.mjs'),ready=path.join(f.root,'host-ready.json'),exit=path.join(f.root,'host-exit');
  await f.storage.putRecovery(f.projectId,'managed:drafts',{frontdesk:'未发送的草稿'});
  await fs.writeFile(script,`import fs from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';
    import {ProjectStorage} from ${JSON.stringify(modules.storage)};import {acquireExperimentalHostLease} from ${JSON.stringify(modules.lease)};
    const i=JSON.parse(process.argv[2]),storage=new ProjectStorage(i.profile,{experimentalWindowsRoot:i.root,experimentalWindowsInitialization:true});
    const lease=await acquireExperimentalHostLease({storage,projectId:i.projectId});await fs.writeFile(i.ready,JSON.stringify(lease.facts()));
    for(;;){try{await fs.stat(i.exit);process.exit(91);}catch(e){if(e.code!=='ENOENT')throw e;}await delay(10);}`);
  const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:env(),stdio:'ignore',windowsHide:true});f.children.push(sentinel);
  const sentinelPin=openExperimentalProcessIdentity(sentinel.pid);f.pins.push(sentinelPin);const sentinelBefore=sentinelPin.snapshot();
  const child=spawn(process.execPath,[script,JSON.stringify({root:f.root,profile:f.profile,projectId:f.projectId,ready,exit})],{env:env(),stdio:['ignore','pipe','pipe'],windowsHide:true});f.children.push(child);
  let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);child.stdout.resume();
  const facts=await until(async()=>{try{return JSON.parse(await fs.readFile(ready,'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;assert.equal(child.exitCode,null,stderr);}});
  const hostPin=openExperimentalProcessIdentity(child.pid);f.pins.push(hostPin);assert.equal(hostPin.snapshot().stamp,facts.host.stamp);
  await assert.rejects(f.hold(),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===32);
  const exited=once(child,'exit');if(mode==='normal')await fs.writeFile(exit,'exit');else child.kill();const result=await exited;
  if(mode==='normal')assert.equal(result[0],91);else assert.equal(result[1],'SIGTERM');assert.equal(hostPin.snapshot().state,'exited');
  // Prove actual HANDLE availability separately from the deliberately refused
  // cold business activation. Neither process absence nor this pin drains Jobs.
  const parent=openExperimentalPersistenceParent(f.root,path.relative(f.root,f.anchor).split(path.sep).join('/'));
  try{const pin=parent.openPrivateTreeFile('managed-host.lease');pin.verify();pin.close();}finally{parent.close();}
  await assert.rejects(f.hold(),{code:'HOST_LEASE_RECOVERY_REQUIRED'});
  assert.equal((await f.record()).value.phase,'active');assert.equal((await f.storage.getRecovery(f.projectId,'managed:drafts')).frontdesk,'未发送的草稿');
  assert.deepEqual(sentinelPin.snapshot(),sentinelBefore);
});


test('native supervision requires the reserved launch and cannot be registered under another original intent',native,async t=>{
  const f=await fixture(t),lease=await f.hold(),registry=createOwnerLaunchRegistry(f.storage,f.projectId,{hostLease:lease});
  const a=await registry.begin(f.bindingFor()),b=await registry.begin({...f.bindingFor(),target:'orchestrator'});
  const job=createExperimentalProcessJob({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:f.root,env:Object.entries(env()).map(([key,value])=>key+'='+value)});
  let pin;
  try{
    assert.throws(()=>registry.startSupervisor(job),{code:'HOST_LAUNCH_SET_INVALID'});
    assert.throws(()=>registry.startSupervisor(job,randomUUID()),{code:'HOST_LAUNCH_SET_INVALID'});
    pin=registry.startSupervisor(job,a.record.launchId);const facts=job.snapshot();
    const identity={schema:1,platform:'win32',pid:facts.pid,creationTime100ns:facts.creationTime100ns,stamp:facts.stamp};
    await assert.rejects(registry.register(b,identity,pin),{code:'HOST_LEASE_BINDING_CHANGED'});
    const prepared=await registry.register(a,identity,pin);assert.equal(prepared.record.launchId,a.record.launchId);
    assert.throws(()=>registry.startSupervisor(job,a.record.launchId),{code:'HOST_LAUNCH_SET_UNVERIFIED'});
  }finally{job.terminate();await until(()=>job.snapshot().jobEmptyObserved);pin?.shutdown();pin?.close();job.close();}
});
