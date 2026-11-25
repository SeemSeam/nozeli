import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {openExperimentalHostSources} from '../src/platform/windows/experimental-host-sources.mjs';
import {createExperimentalProcessJob,waitExperimentalJobEmpty} from '../src/platform/windows/experimental-process-job.mjs';
import {startExperimentalProcessSupervisor} from '../src/platform/windows/experimental-process-supervisor.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {openWindowsManagedColdInspection as inspect,commitWindowsManagedColdCheckpoint as commit,holdWindowsManagedColdBusiness as hold,claimWindowsManagedColdAnchor as claim,retireWindowsManagedColdOwners as retire} from '../src/platform/windows/managed-cold-checkpoint.mjs';
import {openExperimentalPersistenceParent} from '../src/platform/windows/experimental-persistence.mjs';
import {connectExperimentalProcessSupervisor as connect} from '../src/platform/windows/experimental-process-supervisor.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:60000};
async function until(fn){const deadline=performance.now()+20000;for(;;){const value=await fn();if(value)return value;if(performance.now()>deadline)assert.fail('Native cold fixture observation timeout');await delay(5);}}
async function fixture(t,{withoutStdio=false,expiredDescendant=false,targets=['frontdesk','orchestrator'],reservedOnly=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli cold checkpoint 中文 ')),profile=path.join(root,'profile'),content=path.join(root,'project');await fs.mkdir(content);
  const stores=[],pins=[],inspections=[],anchorPins=[];let child;
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}
    for(const inspection of inspections)inspection.close();
    for(const pin of pins){await until(()=>pin.snapshot().jobEmptyObserved);pin.shutdown();pin.close();}
    for(const pin of anchorPins)pin.close();
    for(const store of stores)assert(!(await store.db.close()).some(value=>value?.closed===false));
    await fs.rm(root,{recursive:true,force:true});
  });
  const storage=new ProjectStorage(profile,{windowsDesktopProjects:true});stores.push(storage);
  const projectId=(await storage.register(content)).id,database=path.join(await storage.localDirectory(projectId),'ui.sqlite');
  const retained={draft:'未发送草稿 😀',pending:{schema:1,kind:'business',status:'prepared',automaticReplay:false},tool:{state:'result-unknown',requestId:'synthetic-tool'}};
  await storage.putRecovery(projectId,'managed:drafts',{frontdesk:retained.draft});
  await storage.putRecovery(projectId,'managed:pending:synthetic',retained.pending);
  await storage.putRecovery(projectId,'managed:synthetic-tool',retained.tool);
  await storage.db.close();
  const input=path.join(root,'input.json'),ready=path.join(root,'ready.json'),stop=path.join(root,'stop');
  const env={SystemRoot:process.env.SystemRoot,TEMP:root,TMP:root,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})};
  await fs.writeFile(input,JSON.stringify({root,profile,projectId,ready,stop,withoutStdio,expiredDescendant,targets,reservedOnly,env:Object.entries(env).map(([key,value])=>key+'='+value)}));
  child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/windows-managed-cold-host.mjs',import.meta.url)),input],{env,stdio:['ignore','ignore','pipe'],windowsHide:true});
  let diagnostics='';child.stderr.on('data',bytes=>diagnostics+=bytes);
  const original=await until(async()=>{try{return JSON.parse(await fs.readFile(ready,'utf8'));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;assert.equal(child.exitCode,null,diagnostics);}});
  for(const endpoint of original.endpoints)pins.push(connect(endpoint));
  const observer=new ProjectStorage(profile,{windowsDesktopProjects:true});stores.push(observer);
  const options={storage:observer,projectId};
  return {root,profile,content,projectId,database,original,pins,observer,options,retained,anchorPins,
    async stop(mode='forced'){const ended=once(child,'exit');if(mode==='normal')await fs.writeFile(stop,'exit');else child.kill();const result=await ended;for(const pin of pins)await until(()=>{const f=pin.snapshot();return f.hostExited&&f.jobEmptyObserved&&(!f.outputCustodyVerified||f.stdoutEOF&&f.stderrEOF&&f.inputClosed);});return result;},
    async inspect(){try{const result=await inspect(options);inspections.push(result);return result;}catch(error){if(error.code==='MANAGED_COLD_STOP_UNCONFIRMED')t.diagnostic(JSON.stringify({coldStopFacts:error.facts,current:pins.map(pin=>pin.snapshot())}));throw error;}},
    host:()=>observer.db.request(database,'record',{collection:'managed_host_leases',id:'host'}),
    owners:()=>observer.db.request(database,'list',{collection:'managed_owner_launches'}),
    checkpoints:()=>observer.db.request(database,'list',{collection:'managed_cold_checkpoints'}),
    async assertRetained(){assert.deepEqual(await observer.getRecovery(projectId,'managed:drafts'),{frontdesk:retained.draft});assert.deepEqual(await observer.getRecovery(projectId,'managed:pending:synthetic'),retained.pending);assert.deepEqual(await observer.getRecovery(projectId,'managed:synthetic-tool'),retained.tool);},
  };
}

for(const mode of ['normal','forced'])test(`${mode} whole-host exit checkpoints each registered original Job and exact retained I/O without replaying or retiring business`,native,async t=>{
  const f=await fixture(t);await f.stop(mode);const beforeHost=await f.host(),beforeOwners=await f.owners(),inspection=await f.inspect(),facts=inspection.facts();
  assert.equal(facts.owners.length,2);assert.equal(facts.registeredJobQuiescenceVerified,true);assert.equal(facts.processQuiescenceVerified,true);assert.equal(facts.launchSetCompletenessVerified,true);assert.equal(facts.launchSet.entries.length,2);assert.equal(facts.inputDeliveryIsExecutionAcknowledgement,false);
  for(const owner of facts.owners){assert.ok(owner.streams.stdin.bytes>0);assert.equal(owner.streams.stdin.sha256,owner.streams.stdout.sha256);assert.ok(owner.streams.stderr.bytes>0);}
  let writes=0;const request=f.observer.db.request.bind(f.observer.db);
  f.observer.db.request=(file,op,args)=>{if(op==='put'&&args.collection==='managed_cold_checkpoints')writes++;return request(file,op,args);};
  const result=await commit(inspection,f.options);assert.deepEqual(await commit(inspection,f.options),result);assert.equal(writes,1);
  assert.equal(result.automaticReplay,false);assert.equal(result.ownerReleaseQualified,false);assert.equal(result.coldRecoveryQualified,false);
  assert.equal((await f.checkpoints()).length,1);assert.deepEqual(await f.host(),beforeHost);assert.deepEqual(await f.owners(),beforeOwners);await f.assertRetained();
  inspection.close();for(const pin of f.pins)assert.equal(pin.snapshot().sourceCustodyVerified,true,'inspection never shuts down original custody');
});

test('a still-live original host cannot mint a cold checkpoint',native,async t=>{
  const f=await fixture(t);await assert.rejects(f.inspect(),{code:'MANAGED_COLD_CUSTODY_UNVERIFIED'});assert.deepEqual(await f.checkpoints(),[]);await f.assertRetained();
});

test('a new cold connection receives original already-exited descendant HANDLEs rather than reconstructing absent PIDs',native,async t=>{
  const f=await fixture(t,{expiredDescendant:true,targets:['frontdesk']});await f.stop();const inspection=await f.inspect(),owner=inspection.facts().owners[0];
  assert.ok(owner.members.length>=1);assert.equal(owner.totalProcesses,owner.members.length+1);assert.ok(owner.members.every(member=>member.state==='exited'));
  const descendant=JSON.parse(await fs.readFile(path.join(f.root,'descendant-frontdesk'),'utf8'));
  assert.ok(owner.members.some(member=>member.pid===descendant.pid));await commit(inspection,f.options);await f.assertRetained();
});

test('Job/source custody without original stdio cannot qualify complete cold stop',native,async t=>{
  const f=await fixture(t,{withoutStdio:true});await f.stop();await assert.rejects(f.inspect(),{code:'MANAGED_COLD_CUSTODY_UNVERIFIED'});assert.deepEqual(await f.checkpoints(),[]);await f.assertRetained();
});

test('an unregistered intent alongside genuine empty Jobs prevents complete-owner checkpointing',native,async t=>{
  const f=await fixture(t);await f.stop();const value={...(await f.owners())[0].value,target:'unconfirmed',phase:'intent'};delete value.supervision;
  await f.observer.db.request(f.database,'put',{collection:'managed_owner_launches',id:value.target,value,expectedRevision:0});
  await assert.rejects(f.inspect(),{code:'MANAGED_COLD_OWNER_SET_UNVERIFIED'});assert.deepEqual(await f.checkpoints(),[]);await f.assertRetained();
});

test('an owner row removed before inspection cannot turn the remaining genuine Job into whole-host quiescence authority',native,async t=>{
  const f=await fixture(t);await f.stop();const removed=(await f.owners())[0];
  await f.observer.db.request(f.database,'delete',{collection:'managed_owner_launches',id:removed.id});
  await assert.rejects(f.inspect(),{code:'MANAGED_COLD_LAUNCH_SET_UNVERIFIED'});assert.deepEqual(await f.checkpoints(),[]);await f.assertRetained();
});

for(const winner of ['owner','catalog'])test(`a real ${winner} revision winner permanently fences the retained inspection before checkpoint allocation`,native,async t=>{
  const f=await fixture(t);await f.stop();const inspection=await f.inspect();
  const owner=(await f.owners())[0],file=winner==='owner'?f.database:f.observer.catalog,collection=winner==='owner'?'managed_owner_launches':'instances',id=winner==='owner'?owner.id:f.projectId;
  const before=await f.observer.db.request(file,'record',{collection,id});
  await f.observer.db.request(file,'put',{collection,id,value:before.value,expectedRevision:before.revision});
  const expected=winner==='owner'?'MANAGED_COLD_BINDING_CHANGED':'HOST_SOURCE_CHANGED';
  await assert.rejects(commit(inspection,f.options),{code:expected});await assert.rejects(inspection.check(),{code:expected});assert.deepEqual(await f.checkpoints(),[]);await f.assertRetained();
});

test('a checkpoint commit followed by an actual owner winner remains UNKNOWN and never retries the write',native,async t=>{
  const f=await fixture(t);await f.stop();const inspection=await f.inspect(),request=f.observer.db.request.bind(f.observer.db);let writes=0;
  f.observer.db.request=async(file,op,args)=>{const result=await request(file,op,args);if(op==='put'&&args.collection==='managed_cold_checkpoints'){
    writes++;const owner=(await f.owners())[0];await request(f.database,'put',{collection:'managed_owner_launches',id:owner.id,value:owner.value,expectedRevision:owner.revision});
  }return result;};
  await assert.rejects(commit(inspection,f.options),{code:'STORAGE_RESULT_UNKNOWN'});await assert.rejects(commit(inspection,f.options),{code:'STORAGE_RESULT_UNKNOWN'});assert.equal(writes,1);assert.equal((await f.checkpoints()).length,1);await f.assertRetained();
});

test('cloned or serialized summaries and another storage authority cannot commit; closed inspections cannot allocate',native,async t=>{
  const f=await fixture(t);await f.stop();const inspection=await f.inspect();
  for(const value of [{...inspection},structuredClone(inspection.facts()),JSON.parse(JSON.stringify(inspection.facts()))]){
    await assert.rejects(commit(value,f.options),{code:'MANAGED_COLD_RECEIPT_INVALID'});
    await assert.rejects(hold(value,f.options),{code:'MANAGED_COLD_RECEIPT_INVALID'});
    await assert.rejects(claim(value,f.options),{code:'MANAGED_COLD_RECEIPT_INVALID'});
    await assert.rejects(retire(value,f.options),{code:'MANAGED_COLD_RECEIPT_INVALID'});
  }
  await assert.rejects(commit(inspection,{...f.options,storage:{...f.observer}}),{code:'MANAGED_COLD_RECEIPT_INVALID'});
  await assert.rejects(hold(inspection,{...f.options,storage:{...f.observer}}),{code:'MANAGED_COLD_RECEIPT_INVALID'});
  await assert.rejects(claim(inspection,{...f.options,storage:{...f.observer}}),{code:'MANAGED_COLD_RECEIPT_INVALID'});
  await assert.rejects(retire(inspection,{...f.options,storage:{...f.observer}}),{code:'MANAGED_COLD_RECEIPT_INVALID'});
  await assert.rejects(hold(inspection,f.options),{code:'MANAGED_COLD_UNSUPPORTED'});
  await assert.rejects(claim(inspection,f.options),{code:'MANAGED_COLD_UNSUPPORTED'});
  await assert.rejects(retire(inspection,f.options),{code:'MANAGED_COLD_UNSUPPORTED'});
  inspection.close();await assert.rejects(commit(inspection,f.options),{code:'MANAGED_COLD_CLOSED'});assert.deepEqual(await f.checkpoints(),[]);await f.assertRetained();
  await assert.rejects(claim(inspection,f.options),{code:'MANAGED_COLD_CLOSED'});
  await assert.rejects(retire(inspection,f.options),{code:'MANAGED_COLD_CLOSED'});
});

test('native cold anchor arbitration spans all original helpers and retains the file object after every helper shuts down',native,async t=>{
  const f=await fixture(t);await f.stop();const host=await f.host(),owners=await f.owners();
  const first=f.pins[0].claimColdAnchor();f.anchorPins.push(first);
  assert.equal(first.identity,host.value.anchorIdentity);assert.equal(first.inheritable,false);
  assert.equal(first.ownerReleaseQualified,false);assert.equal(first.automaticReplay,false);first.verify();
  assert.throws(()=>first.verify.call({...first}),{code:'HOST_LAUNCH_SET_INVALID'});
  assert.throws(()=>f.pins[0].claimColdAnchor(),{code:'COLD_ANCHOR_ATTEMPTED'});
  assert.throws(()=>f.pins[1].claimColdAnchor(),error=>error.code==='SUPERVISOR_REQUEST_REFUSED'&&error.win32Code===183);
  const independent=connect(f.original.endpoints[0]);
  try{assert.throws(()=>independent.claimColdAnchor(),error=>error.code==='SUPERVISOR_REQUEST_REFUSED'&&error.win32Code===183);}finally{independent.close();}
  assert.deepEqual(await f.host(),host);assert.deepEqual(await f.owners(),owners);await f.assertRetained();
  // Read-only duplicate access still retains the original write share denial.
  for(const pin of f.pins.splice(0)){pin.shutdown();pin.close();}
  const project=await f.observer.requireOnline(f.projectId),file=path.join(project.metadataRoot,'managed-host.lease');
  const root=f.observer.nativeRootForPath(file),parent=openExperimentalPersistenceParent(root,path.relative(root,file).split(path.sep).join('/'));
  try{
    first.verify();assert.throws(()=>parent.openPrivateTreeFile('managed-host.lease'),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===32);
    first.close();assert.throws(()=>first.verify(),{code:'COLD_ANCHOR_CLOSED'});
    const reopened=parent.openPrivateTreeFile('managed-host.lease');try{assert.equal(reopened.stat().identity,host.value.anchorIdentity);}finally{reopened.close();}
  }finally{parent.close();}
});

test('native cold anchor refuses a live host without consuming the shared exited-host arbitration cell',native,async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.pins[0].claimColdAnchor(),error=>error.code==='SUPERVISOR_REQUEST_REFUSED'&&error.win32Code===170);
  await f.stop();const pin=connect(f.original.endpoints[0]);
  try{const held=pin.claimColdAnchor();try{held.verify();}finally{held.close();}}finally{pin.close();}
  await f.assertRetained();
});

test('native cold anchor refuses an unfinished original native launch intent even after its SQLite row disappears',native,async t=>{
  const f=await fixture(t,{reservedOnly:true});await f.stop();
  const intent=(await f.owners()).find(row=>row.value.phase==='intent');
  await f.observer.db.request(f.database,'delete',{collection:'managed_owner_launches',id:intent.id});
  assert.throws(()=>f.pins[0].claimColdAnchor(),error=>error.code==='SUPERVISOR_REQUEST_REFUSED'&&error.win32Code===13);
  assert.deepEqual(await f.checkpoints(),[]);await f.assertRetained();
});

test('native cold anchor transfer reply loss consumes the whole-host claim and retains original helper evidence',native,async t=>{
  const f=await fixture(t);await f.stop();
  const child=spawn(process.execPath,['-e',`
    const net=require('node:net'),frame=Buffer.alloc(32);frame.writeUInt32LE(0x4e5a5331,0);frame.writeUInt32LE(10,4);frame.writeUInt32LE(10,8);
    const socket=net.connect(process.argv[1],()=>socket.write(frame));
    socket.once('data',bytes=>{if(bytes.length<12||bytes.readUInt32LE(8)!==0)process.exit(7);process.stdout.write('reply received without acknowledgement',()=>process.exit(0));});
    socket.on('error',()=>process.exit(8));setTimeout(()=>process.exit(9),10000);
  `,f.original.endpoints[0].pipe],{windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:{SystemRoot:process.env.SystemRoot,TEMP:f.root,TMP:f.root,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})}});
  let diagnostics='';child.stdout.on('data',bytes=>diagnostics+=bytes);child.stderr.on('data',bytes=>diagnostics+=bytes);
  const [code]=await once(child,'close');assert.equal(code,0,diagnostics);
  assert.throws(()=>f.pins[1].claimColdAnchor(),error=>error.code==='SUPERVISOR_REQUEST_REFUSED'&&error.win32Code===183);
  for(const pin of f.pins)assert.equal(pin.snapshot().sourceCustodyVerified,true);
  assert.deepEqual(await f.checkpoints(),[]);await f.assertRetained();
});

test('native cold anchor requires complete original stdio custody',native,async t=>{
  const f=await fixture(t,{withoutStdio:true});await f.stop();
  assert.throws(()=>f.pins[0].claimColdAnchor(),error=>error.code==='SUPERVISOR_REQUEST_REFUSED'&&error.win32Code===170);
  await f.assertRetained();
});

test('restricted cold anchor builds complete next-host source custody without a writable reopen or HANDLE export',native,async t=>{
  const f=await fixture(t);await f.stop();const host=await f.host(),project=await f.observer.requireOnline(f.projectId);
  const anchor=f.pins[0].claimColdAnchor();f.anchorPins.push(anchor);
  const native=createRequire(import.meta.url)('../native/windows/build/Release/nozeli_windows_read.node');
  const root=f.observer.nativeRootForPath(f.database),dbParent=openExperimentalPersistenceParent(root,path.relative(root,f.database).split(path.sep).join('/'));
  const anchorPath=path.join(project.metadataRoot,'managed-host.lease'),metadataRoot=f.observer.nativeRootForPath(anchorPath);
  const metadata=openExperimentalPersistenceParent(metadataRoot,path.relative(metadataRoot,anchorPath).split(path.sep).join('/'));
  const db=dbParent.openPrivateDatabase('ui.sqlite',true),sources=await openExperimentalHostSources({storage:f.observer,project,expected:host.value.source});
  let job,pin,bundle;
  try{
    assert.throws(()=>native.createSupervisorCustody({...anchor},db,db,db,{},'0'.repeat(64),metadata),{code:'CUSTODY_SPEC_INVALID'});
    const foreign=await openExperimentalHostSources({storage:f.observer,project,expected:host.value.source});
    try{assert.throws(()=>foreign.createCustody(anchor,db,dbParent),{code:'WIN32_IO_ERROR'});}finally{foreign.close();}
    bundle=sources.createCustody(anchor,db,metadata);assert.deepEqual(Object.keys(bundle),[]);
    job=createExperimentalProcessJob({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:f.root,
      env:['SystemRoot='+process.env.SystemRoot,'TEMP='+f.root,'TMP='+f.root,...(process.versions.electron?['ELECTRON_RUN_AS_NODE=1']:[])]});
    pin=startExperimentalProcessSupervisor(job,bundle);bundle.close();bundle=null;
    assert.equal(pin.snapshot().sourceCustodyVerified,true);assert.equal(pin.snapshot().sourceSha256,f.pins[0].snapshot().sourceSha256);
    for(const old of f.pins.splice(0)){old.shutdown();old.close();}
    anchor.close();assert.throws(()=>anchor.verify(),{code:'COLD_ANCHOR_CLOSED'});
    assert.throws(()=>sources.createCustody(anchor,db,metadata),{code:'COLD_ANCHOR_CLOSED'});
    assert.throws(()=>metadata.openPrivateTreeFile('managed-host.lease'),error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===32);
    assert.equal(pin.snapshot().sourceCustodyVerified,true);
  }finally{
    bundle?.close();if(job){job.terminate();await waitExperimentalJobEmpty(job);}if(pin){pin.shutdown();pin.close();}job?.close();
    sources.close();db.close();dbParent.close();metadata.close();
  }
  await f.assertRetained();
});


test('native intent remains visible after its SQLite row is deleted before any Job allocation',native,async t=>{
  const f=await fixture(t,{reservedOnly:true});await f.stop();
  const intent=(await f.owners()).find(row=>row.value.phase==='intent');assert.ok(intent);
  await f.observer.db.request(f.database,'delete',{collection:'managed_owner_launches',id:intent.id});
  const history=f.pins[0].snapshot().launchSet;assert.equal(history.entries.length,3);assert.equal(history.entries.filter(entry=>!entry.prepared).length,1);
  await assert.rejects(f.inspect(),{code:'MANAGED_COLD_LAUNCH_SET_UNVERIFIED'});assert.deepEqual(await f.checkpoints(),[]);await f.assertRetained();
});

test('rewriting the host launch-set identity cannot adopt matching PIDs or genuine Job observations',native,async t=>{
  const f=await fixture(t);await f.stop();const host=await f.host();
  const value={...host.value,launchSet:{...host.value.launchSet,id:'0'.repeat(64)}};
  await f.observer.db.request(f.database,'put',{collection:'managed_host_leases',id:'host',value,expectedRevision:host.revision});
  await assert.rejects(f.inspect(),{code:'MANAGED_COLD_LAUNCH_SET_UNVERIFIED'});assert.deepEqual(await f.checkpoints(),[]);await f.assertRetained();
});
