import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {git,str,commitTree} from '../src/agents/managed/git-service.mjs';
import {connectExperimentalProcessSupervisor} from '../src/platform/windows/experimental-process-supervisor.mjs';
import {openWindowsManagedColdInspection,archiveWindowsManagedColdEvidence,prepareWindowsManagedColdHandoff,prepareWindowsManagedColdDisposal,openWindowsReleasedColdArchiveReader} from '../src/platform/windows/managed-cold-checkpoint.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {serve} from './pi-provider.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
import {openColdController} from './fixtures/windows-cold-controller.mjs';
import {readEvidenceFrames} from '../../../integrations/pi/src/read-evidence-journal.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:480000};
const run=promisify(execFile);
async function until(fn,diagnostic){const end=performance.now()+180000;for(;;){const r=await fn();if(r)return r;if(performance.now()>end)assert.fail(diagnostic());await delay(10);}}

for(const mode of ['normal','intent-lost-reply','source-winner','pending-after-intent','destination-winner','ready-lost-reply','ready-revision','ready-history-winner','exit-observation'])
test(`actual cold evidence archive: ${mode} retains original homes and helpers without replay`,native,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli cold archive 中文 ')),profile=path.join(root,'profile'),content=path.join(root,'project');await fs.mkdir(content);
 const provider=await serve((request,index)=>{
  if(index===1)return {id:'read',tool:'nozeli_document_read',args:{relPath:'正文.md'}};
  const tool=request.messages.filter(r=>r.role==='tool').at(-1),result=JSON.parse(typeof tool.content==='string'?tool.content:tool.content.map(r=>r.text??'').join(''));assert.equal(result.ok,true);
  if(index===2)return {id:'apply',tool:'nozeli_document_apply',args:{readHandle:result.value.readHandle,replacements:[{oldText:'baseline',newText:'cold receipt'}]}};
  assert.equal(index,3);return {id:'publish',tool:'nozeli_publish',args:{kind:'result',content:staticReport('原始冷归档候选'),files:['正文.md']}};
 });
 const storage=new ProjectStorage(profile,{windowsDesktopProjects:true}),projectId=(await storage.register(content)).id;
 const local=path.join(await storage.localDirectory(projectId),'ui.sqlite'),pins=[];let child,closed,inspection,adopted,helpersStopped=false;
 const raw=storage.db.request.bind(storage.db),request=(op,args)=>raw(local,op,args);
 t.after(async()=>{
  storage.db.request=raw;if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await closed;}
  // Startup can fail before the parent pins the launch set. Reconnect those
  // exact registered fixture helpers before deleting their synthetic profile.
  if(!pins.length&&!helpersStopped){for(const row of await request('list',{collection:'managed_owner_launches'})){
   if(row.value.supervision)pins.push(connectExperimentalProcessSupervisor(row.value.supervision));
  }}
  inspection?.close();if(adopted){assert.equal((await adopted.controller.stop()).confirmationComplete,true);for(const service of adopted.services)service.close();}
  for(const pin of pins){await until(()=>pin.snapshot().jobEmptyObserved,()=>JSON.stringify(pin.snapshot()));pin.shutdown();pin.close();}
  await provider.close();await storage.db.close();await fs.rm(root,{recursive:true,force:true});
 });
 await fs.writeFile(path.join(content,'正文.md'),'baseline');await fs.writeFile(path.join(content,'.gitignore'),'.nozeli/\nnode_modules/\n');
 const originalSettings=Buffer.from('{"defaultModel":"scripted","customMarker":"original-cold-settings"}');
 await fs.mkdir(path.join(content,'.pi'));await fs.writeFile(path.join(content,'.pi','settings.json'),originalSettings);
 await git(content,['init','--initial-branch=main']);await git(content,['config','core.autocrlf','false']);await git(content,['add','.']);
 const initial=await commitTree(content,await str(content,['write-tree']),[],'synthetic archive baseline',path.join(root,'seed'));await git(content,['update-ref','refs/heads/main',initial]);
 const input=path.join(root,'input.json'),i={root,profile,content,projectId,ready:path.join(root,'ready.json'),provider:provider.url,
  piRoot:process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi')};await fs.writeFile(input,JSON.stringify(i));
 child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/windows-cold-business-host.mjs',import.meta.url)),input],
  {env:{SystemRoot:process.env.SystemRoot,TEMP:root,TMP:root,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},windowsHide:true,stdio:['ignore','pipe','pipe']});
 let diagnostics='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>diagnostics+=b);closed=once(child,'close');
 const original=await until(async()=>{try{return JSON.parse(await fs.readFile(i.ready,'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;assert.equal(child.exitCode,null,diagnostics);}},()=>diagnostics);
 const owners=await request('list',{collection:'managed_owner_launches'});for(const row of owners)pins.push(connectExperimentalProcessSupervisor(row.value.supervision));
 child.kill();await closed;for(const pin of pins)await until(()=>{const f=pin.snapshot();return f.hostExited&&f.jobEmptyObserved&&f.stdoutEOF&&f.stderrEOF;},()=>JSON.stringify(pin.snapshot()));
 // Cold settings verification must use original retained bytes even after the
 // project has an external winner. The Worker has its own execution cwd.
 const externalSettings='{"customMarker":"external-winner-after-owner-exit"}';
 await fs.writeFile(path.join(content,'.pi','settings.json'),externalSettings);
 for(let index=0;index<owners.length;index++){
  const owner=owners[index].value,facts=pins[index].snapshot();
  assert.equal(facts.ownerHomeDirectoryCustodyVerified,true);assert.equal(facts.custodyRoles,63);
  assert.equal(facts.ownerHomeIdentity,owner.supervision.ownerHomeIdentity);
  await assert.rejects(fs.rename(owner.home,owner.home+'.contender'),e=>['EBUSY','EPERM','EACCES'].includes(e.code));
  assert.throws(()=>connectExperimentalProcessSupervisor({...owner.supervision,ownerHomeIdentity:'0'.repeat(16)+':'+ '0'.repeat(32)}),{code:'CUSTODY_ENTITY_CHANGED'});
 }
 const worker=owners.find(r=>r.id===original.workId),extra=path.join(worker.value.home,'additional-evidence.bin');await fs.writeFile(extra,Buffer.from([0,255,42,0,13,10]));
 const binding={storage,projectId,inspectJournals:true,inspectBusinessReceipts:true};inspection=await openWindowsManagedColdInspection(binding);
 if(mode==='exit-observation'){
  const before=inspection.helperExits();
  assert.equal(before.projectId,projectId);assert.equal(before.ledgerRevalidated,false);
  assert.equal(before.helpers.length,owners.length);assert(before.helpers.every(row=>row.state==='running'));
  assert.deepEqual(before.helpers.map(row=>row.launchId).sort(),owners.map(row=>row.value.launchId).sort());
  assert.throws(()=>inspection.helperExits.call({}),{code:'MANAGED_COLD_RECEIPT_INVALID'});
  const ledgerBefore=await request('all',{});
  // New synthetic owners only, already quiescent and held by this fixture.
  // The inspection observes their exact original HANDLEs, never sends close.
  for(const pin of pins){pin.shutdown();pin.close();}pins.length=0;
  const after=inspection.helperExits();assert(after.helpers.every(row=>row.state==='exited'));
  assert.deepEqual(after.helpers.map(({state,...binding})=>binding),before.helpers.map(({state,...binding})=>binding));
  assert.equal(after.shutdownAcknowledged,false);assert.equal(after.ownerReleaseQualified,false);
  assert.equal(after.coldRecoveryQualified,false);assert.equal(after.automaticReplay,false);
  await assert.rejects(inspection.check(),{code:'SUPERVISOR_IDENTITY_UNVERIFIED'});
  assert.deepEqual(await request('all',{}),ledgerBefore,'exit observations cannot authorize ledger writes or release');
  inspection.close();assert.throws(()=>inspection.helperExits(),{code:'MANAGED_COLD_CLOSED'});
  helpersStopped=true;
  return;
 }
 await assert.rejects(archiveWindowsManagedColdEvidence({...inspection},binding),{code:'MANAGED_COLD_RECEIPT_INVALID'});
 await assert.rejects(archiveWindowsManagedColdEvidence(inspection,{storage:{},projectId}),{code:'MANAGED_COLD_RECEIPT_INVALID'});
 let intentWrites=0,readyWrites=0,archiveRow;
 storage.db.request=async(file,op,args)=>{
  const result=await raw(file,op,args),change=op==='compareAndPut'&&args.records.find(r=>r.collection==='managed_cold_archives');
  if(!change)return result;archiveRow=change;
  if(change.value.phase==='intent'){
   intentWrites++;
   if(mode==='intent-lost-reply')throw Object.assign(Error('Lost actual archive intent COMMIT reply'),{code:'STORAGE_RESULT_UNKNOWN'});
   if(mode==='source-winner')await fs.writeFile(path.join(worker.value.home,'concurrent-winner.txt'),'winner');
   if(mode==='pending-after-intent')await storage.putRecovery(projectId,'managed:pending:archive-race',{schema:1,kind:'business',projectId,status:'pending',collections:{},base:{}});
   if(mode==='destination-winner'){await ensureExperimentalPrivateDirectory(profile,change.value.destination);await fs.writeFile(path.join(change.value.destination,'winner.txt'),'external destination winner');}
  }else{
   readyWrites++;
   if(mode==='ready-lost-reply')throw Object.assign(Error('Lost actual archive ready COMMIT reply'),{code:'STORAGE_RESULT_UNKNOWN'});
   if(mode==='ready-revision')await raw(file,'put',{collection:'managed_cold_archives',id:change.id,value:change.value,expectedRevision:2});
   if(mode==='ready-history-winner'){
    const history=(await request('list',{collection:'managed_cold_retirements'}))[0];await raw(file,'put',{collection:'managed_cold_retirements',id:history.id,value:history.value,expectedRevision:history.revision});
   }
  }
  return result;
 };
 const a=archiveWindowsManagedColdEvidence(inspection,binding),b=archiveWindowsManagedColdEvidence(inspection,binding);assert.equal(a,b);
 await assert.rejects(inspection.check(),{code:'MANAGED_COLD_ARCHIVE_BUSY'});
 if(mode==='normal'){
  const result=await a;assert.deepEqual(await b,result);assert.equal(result.phase,'ready');assert.equal(result.revision,2);
  assert.equal(result.ownerReleaseQualified,false);assert.equal(result.originalHelpersRequired,true);assert.equal(result.recoveryClosureQualified,false);
  const manifest=JSON.parse(await fs.readFile(path.join(result.destination,'manifest.json'),'utf8'));
  const {archiveOwners,...sourceEvidence}=manifest;assert.equal(sha(JSON.stringify(sourceEvidence)),result.sourceEvidenceSha256);
  assert.equal(archiveOwners.length,3);
  for(const saved of archiveOwners){
   const base=path.join(result.destination,...saved.archiveRelative.split('/'));
   assert.equal(saved.journal.settingsReads.schema,3);assert.ok(saved.journal.settingsReads.confirmedReads>0);
   assert.equal(saved.journal.settingsReads.ownerReleaseQualified,false);
   const settings=saved.journal.settingsReads;
   const retained=await fs.readFile(path.join(base,...settings.journal.relative.split('/')));
   assert.ok([...readEvidenceFrames(retained,settings.headBytes,1024*1024)].some(({bytes})=>bytes?.equals(originalSettings)));
   assert.equal(saved.journal.modelAuthReads.schema,2);assert.ok(saved.journal.modelAuthReads.confirmedReads>0);
   assert.equal(saved.journal.modelAuthReads.fullRecoveryClosureQualified,false);
   assert.equal(saved.journal.modelAuthReads.ownerReleaseQualified,false);
   assert.equal(saved.journal.roleReads.schema,3);assert.equal(saved.journal.roleReads.originalStartupConfirmed,true);assert.equal(saved.journal.roleReads.catalogCovered,true);assert.equal(saved.journal.roleReads.completeObservedSet,true);assert.equal(saved.journal.roleReads.ownerReleaseQualified,false);
   for(const entry of saved.journal.modelAuthReads.observedEntries){
    const source=saved.sourceManifest.entries.find(e=>e.relative===entry.relative);
    assert.ok(source);assert.equal(source.identity,entry.identity);
    if(entry.type==='file'){assert.equal(source.byteLength,entry.byteLength);assert.equal(source.sha256,entry.sha256);}
   }
   assert.equal(saved.originalHomeDirectoryCustodyQualified,true);
   assert.equal(saved.originalHomeLifetimeCustodyQualified,false);
   assert.equal(saved.sourceManifest.rootIdentity,owners.find(o=>o.id===saved.target).value.supervision.ownerHomeIdentity);
   for(const entry of saved.sourceManifest.entries)if(entry.type==='file')assert.equal(sha(await fs.readFile(path.join(base,...entry.relative.split('/')))),entry.sha256);
   for(const [name,stream] of Object.entries(saved.streams)){
    const bytes=await fs.readFile(path.join(result.destination,'streams',saved.launchId,name+'.bin'));assert.equal(bytes.length,stream.bytes);assert.equal(sha(bytes),stream.sha256);
   }
  }
  const saved=archiveOwners.find(o=>o.target===original.workId);assert.deepEqual(await fs.readFile(path.join(result.destination,...saved.archiveRelative.split('/'),'additional-evidence.bin')),await fs.readFile(extra));
  await inspection.check();assert.equal(readyWrites,1);
  const token=await prepareWindowsManagedColdHandoff(inspection,binding);adopted=await openColdController(i,storage,token);inspection.close();
  assert.equal(adopted.controller.store.state.drafts.frontdesk,'原始未发送草稿');
  await adopted.controller.start();assert.equal(adopted.controller.sessions.size,2);assert.equal(adopted.budget.used,2);
  assert.equal(adopted.controller.store.find(original.workId).status,'paused');assert.equal(provider.requests.length,3);
 }else{
  await assert.rejects(a,{code:'STORAGE_RESULT_UNKNOWN'});await assert.rejects(b,{code:'STORAGE_RESULT_UNKNOWN'});
  await assert.rejects(archiveWindowsManagedColdEvidence(inspection,binding),{code:'STORAGE_RESULT_UNKNOWN'});
  if(mode==='intent-lost-reply')await assert.rejects(fs.stat(archiveRow.value.destination),{code:'ENOENT'});
  if(mode==='destination-winner')assert.equal(await fs.readFile(path.join(archiveRow.value.destination,'winner.txt'),'utf8'),'external destination winner');
  if(mode==='source-winner')assert.equal(await fs.readFile(path.join(worker.value.home,'concurrent-winner.txt'),'utf8'),'winner');
  assert.equal(readyWrites,mode.startsWith('ready-')?1:0);
 }
 assert.equal(intentWrites,1);assert.equal(provider.requests.length,3);
 const reconcile=async()=>{
  const {stdout}=await run(process.execPath,[fileURLToPath(new URL('./fixtures/windows-cold-archive-reader.mjs',import.meta.url)),
   profile,projectId,archiveRow.id],{env:{SystemRoot:process.env.SystemRoot,TEMP:root,TMP:root,
   ...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},windowsHide:true});
  return JSON.parse(stdout);
 };
 if(['intent-lost-reply','destination-winner','ready-lost-reply','ready-revision','ready-history-winner'].includes(mode)){
  inspection.close();
  const before=await request('list',{collection:'managed_cold_archives'});
  const observed=await reconcile();
  if(mode==='ready-lost-reply'){
   assert.equal(observed.result?.state,'ready-verified',JSON.stringify(observed));
   assert.equal(observed.result.archiveManifestSha256,archiveRow.value.archiveManifestSha256);
   assert.equal(observed.result.ownerReleaseQualified,false);
   assert.equal(observed.result.recoveryClosureQualified,false);
   const disposal=await prepareWindowsManagedColdDisposal({storage,projectId,operationId:archiveRow.id});assert.equal(disposal.state,'ready');assert.equal(disposal.available,false);assert.equal(disposal.deletionStarted,false);assert.equal(disposal.deletionCompleted,false);assert.equal(disposal.ownerReleaseQualified,false);assert.equal(disposal.recoveryClosureQualified,false);assert.equal(disposal.owners.length,archiveRow.value.ownerLaunchIds.length);assert.deepEqual(disposal.prerequisites,{archiveVerified:true,exactOwnerHomeSet:true,originalHelpersReleased:false,releasedAncestorReaderQualified:false,namespaceDurabilityQualified:false,homeDeletionAuthorized:false,automaticReplay:false});
   const originalPlan=await request('record',{collection:'managed_cold_disposals',id:archiveRow.id});
   const forgedPlan={...originalPlan.value,owners:originalPlan.value.owners.map((owner,index)=>index?owner:{...owner,archiveRelative:'owners/forged'})};
   const replacePlan=async value=>{await request('replace',{collections:{managed_cold_disposals:[{id:archiveRow.id,value}]}});await request('put',{collection:'managed_cold_disposals',id:archiveRow.id,value,expectedRevision:1});};
   await replacePlan(forgedPlan);
   await assert.rejects(openWindowsReleasedColdArchiveReader({storage,projectId,operationId:archiveRow.id}),error=>error.code==='MANAGED_COLD_DISPOSAL_UNQUALIFIED'&&error.cause?.code==='STORAGE_OPERATION_CONFLICT');
   await replacePlan(originalPlan.value);
   const reader=await openWindowsReleasedColdArchiveReader({storage,projectId,operationId:archiveRow.id});
   const metadata=await reader.readOwnerFile(archiveRow.value.ownerLaunchIds[0],'nozeli-session-tools.json');
   assert.deepEqual(metadata,await fs.readFile(path.join(owners.find(owner=>owner.value.launchId===archiveRow.value.ownerLaunchIds[0]).value.home,'nozeli-session-tools.json')));
   await assert.rejects(reader.readOwnerFile('foreign-launch','nozeli-session-tools.json'),{code:'MANAGED_COLD_DISPOSAL_UNQUALIFIED'});
   await assert.rejects(reader.readOwnerFile(archiveRow.value.ownerLaunchIds[0],'../manifest.json'),{code:'MANAGED_COLD_ARCHIVE_UNVERIFIED'});
   await reader.verify();const disposalRecord=await request('record',{collection:'managed_cold_disposals',id:archiveRow.id}),drifted={...disposalRecord.value,phase:'unknown'};await request('put',{collection:'managed_cold_disposals',id:archiveRow.id,value:drifted,expectedRevision:disposalRecord.revision});await assert.rejects(reader.verify,{code:'MANAGED_COLD_DISPOSAL_CHANGED'});reader.close();
   assert.deepEqual(observed.result.release,{schema:1,available:false,scope:'cold-archive-only-no-home-deletion-or-released-ancestor-reader',reason:'Exact-set archived-home disposal and released-ancestor reader are not qualified',automaticReplay:false});
   assert.equal(observed.result.settingsReads.length,3);
   for(const settings of observed.result.settingsReads){assert.ok(settings.confirmedReads>0);assert.equal(settings.fullRecoveryClosureQualified,false);}
   assert.equal(observed.result.modelAuthReads.length,3);
   for(const material of observed.result.modelAuthReads){assert.ok(material.confirmedReads>0);assert.equal(material.fullRecoveryClosureQualified,false);assert.equal(material.ownerReleaseQualified,false);}
   assert.equal(observed.result.roleReads.length,3);for(const role of observed.result.roleReads){assert.equal(role.schema,3);assert.equal(role.originalStartupConfirmed,true);assert.equal(role.completeObservedSet,true);assert.equal(role.ownerReleaseQualified,false);}
   const manifest=JSON.parse(await fs.readFile(path.join(archiveRow.value.destination,'manifest.json'),'utf8'));
   const saved=manifest.archiveOwners[0],journal=saved.journal.settingsReads.journal;
   const settingsFile=path.join(archiveRow.value.destination,...saved.archiveRelative.split('/'),...journal.relative.split('/'));
   const settingsBytes=await fs.readFile(settingsFile);await fs.rename(settingsFile,settingsFile+'.retained');await fs.writeFile(settingsFile,settingsBytes);
   assert.equal((await reconcile()).code,'MANAGED_COLD_ARCHIVE_UNVERIFIED');
   await assert.rejects(openWindowsReleasedColdArchiveReader({storage,projectId,operationId:archiveRow.id}),{code:'MANAGED_COLD_ARCHIVE_UNVERIFIED'});
   await fs.unlink(settingsFile);await fs.rename(settingsFile+'.retained',settingsFile);
   assert.equal((await reconcile()).result?.state,'ready-verified');
   const modelJournal=saved.journal.modelAuthReads.journal;
   const modelFile=path.join(archiveRow.value.destination,...saved.archiveRelative.split('/'),...modelJournal.relative.split('/'));
   const modelBytes=await fs.readFile(modelFile);
   // A same-byte replacement still changes the frozen ARCHIVE identity.
   // Original SOURCE IDs are separately checked by material reconciliation.
   await fs.rename(modelFile,modelFile+'.retained');await fs.writeFile(modelFile,modelBytes);
   assert.equal((await reconcile()).code,'MANAGED_COLD_ARCHIVE_UNVERIFIED');
   await fs.unlink(modelFile);await fs.rename(modelFile+'.retained',modelFile);
   assert.equal((await reconcile()).result?.state,'ready-verified');
   await fs.appendFile(modelFile,'synthetic archive content change');
   assert.equal((await reconcile()).code,'MANAGED_COLD_ARCHIVE_UNVERIFIED');
   await fs.writeFile(modelFile,modelBytes);
   assert.equal((await reconcile()).result?.state,'ready-verified');
   const file=path.join(archiveRow.value.destination,'streams',archiveRow.value.ownerLaunchIds[0],'stderr.bin');
   const originalBytes=await fs.readFile(file);
   await fs.appendFile(file,'tampered archived stream');
   assert.equal((await reconcile()).code,'MANAGED_COLD_ARCHIVE_UNVERIFIED');
   await fs.writeFile(file,originalBytes);
   // A replacement can reproduce revision 2 but cannot reproduce the exact
   // committed comparison fingerprint for its altered ready value.
   const altered={...archiveRow.value,barriers:{...archiveRow.value.barriers,namespace:'qualified'}};
   await request('replace',{collections:{managed_cold_archives:[{id:archiveRow.id,value:altered}]}});
   await request('put',{collection:'managed_cold_archives',id:archiveRow.id,value:altered,expectedRevision:1});
   const rejected=await reconcile();assert.equal(rejected.code,'MANAGED_COLD_ARCHIVE_UNVERIFIED');
   assert.equal(rejected.cause,'STORAGE_OPERATION_CONFLICT');
  }else if(['intent-lost-reply','destination-winner'].includes(mode)){
   assert.equal(observed.result?.state,'unknown',JSON.stringify(observed));
   assert.equal(observed.result.reason,'intent-only');
   assert.equal(observed.result.automaticReplay,false);
   assert.deepEqual(await request('list',{collection:'managed_cold_archives'}),before);
   await assert.rejects(prepareWindowsManagedColdDisposal({storage,projectId,operationId:archiveRow.id}),{code:'MANAGED_COLD_DISPOSAL_UNQUALIFIED'});
  }else{
   assert.equal(observed.code,'MANAGED_COLD_ARCHIVE_UNVERIFIED');
   assert.deepEqual(await request('list',{collection:'managed_cold_archives'}),before);
  }
  assert.equal(provider.requests.length,3);
 }
 for(const pin of pins){const f=pin.snapshot();assert.equal(f.sourceCustodyVerified,true);assert.equal(f.jobEmptyObserved,true);}
 for(const owner of owners)assert.equal((await fs.stat(owner.value.home)).isDirectory(),true);
 assert.equal(await fs.readFile(path.join(content,'正文.md'),'utf8'),'baseline');
 assert.equal(await fs.readFile(path.join(content,'.pi','settings.json'),'utf8'),externalSettings);
 const work=(await storage.projectRequest(projectId,'record',{collection:'managed_works',id:original.workId})).value;
 assert.equal(work.status,'paused');assert.equal(work.recoveryRequiresExplicitInput,true);assert.ok(work.result);
});
