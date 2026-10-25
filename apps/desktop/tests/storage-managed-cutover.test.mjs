import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DesktopHost} from '../src/main/host.mjs';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {managedRuntime,readManagedState,listManagedPending,reconcileManagedPending} from '../src/agents/managed/managed-storage.mjs';
import {managedReportSource,managedArtifact} from '../src/agents/managed-report-source.mjs';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-managed-cutover-')),profile=path.join(root,'profile'),content=path.join(root,'project');
 await fs.mkdir(content);await fs.writeFile(path.join(content,'source.txt'),'Frozen project evidence.\n');
 const host=new DesktopHost(profile),registered=await host.registerDirectory(content),storage=host.storage,project=await storage.requireRegistered(registered.id);
 const runtime=await managedRuntime(storage,project.id),store=await Workspace.open(runtime,content,{storage,projectId:project.id});
 t.after(async()=>{if(!store.closed)await store.close();await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 return {root,profile,content,host,project,storage,runtime,store};
}

test('managed records are project collections while execution ownership stays local',async t=>{
 const {store,storage,project,runtime}=await fixture(t),work=await store.submit('Original request','Approved brief',{name:'Portable Work'});
 await store.activate(work.id);
 await store.mutate(()=>{
  store.find(work.id).threadId='local-native-thread';store.find(work.id).execution={directory:path.join(runtime,'private-worktree'),candidate:{commit:'local-candidate'}};
  store.state.providers={};store.state.jobs=[{id:'request-one',target:work.id,status:'completed',text:'Business input',collabAttempts:[{requestId:'private-request',sessionId:'private-native-session'}]}];
  store.state.drafts={frontdesk:'Unsent local draft'};
 });
 const rows=await storage.listProject(project.id,'managed_works');assert.equal(rows.length,1);assert.equal(rows[0].value.id,work.id);
 assert.equal(rows[0].value.request,'Original request');assert.equal('execution' in rows[0].value,false);assert.equal('threadId' in rows[0].value,false);
 const jobs=await storage.listProject(project.id,'managed_jobs');assert.equal(jobs[0].value.text,'Business input');assert.equal('collabAttempts' in jobs[0].value,false);
 assert.equal((await storage.getLocal(project.id,'managed:works:'+work.id)).threadId,'local-native-thread');
 assert.equal((await storage.getRecovery(project.id,'managed:drafts')).frontdesk,'Unsent local draft');
 await assert.rejects(fs.access(path.join(runtime,'state.json')),{code:'ENOENT'});
 assert.equal(store.plan,path.join(project.metadataRoot,'memory','plantree','index.md'));
});

test('copied project reports and artifacts remain readable without the execution directory',async t=>{
 const {root,content,store,project,storage,runtime}=await fixture(t),work=await store.submit('Freeze evidence','Portable report');await store.activate(work.id);
 const receipt=await store.publish(work.id,1,'problem','# Frozen report\n\nProject evidence.\n','portable-report',{files:[{relPath:'source.txt'}]});
 const original=await store.readObject(receipt.report.digest);await store.close();await storage.db.close();
 await fs.rm(runtime,{recursive:true,force:true});
 const copy=path.join(root,'copied-project');await fs.cp(content,copy,{recursive:true});
 const imported=new ProjectStorage(path.join(root,'other-profile'));t.after(()=>imported.db.close());
 const binding=await imported.register(copy);assert.notEqual(binding.id,project.id);assert.notEqual(binding.instanceId,project.instanceId);
 const state=await readManagedState(imported,binding.id);assert.equal(state.workspaceId,binding.id);assert.equal(state.works[0].threadId,undefined);
 const options={project:binding,storage:imported,runtime:await managedRuntime(imported,binding.id),controller:null,currentController:()=>null};
 const source=await managedReportSource({...options,objectId:receipt.objectId});assert.deepEqual(await source.read(),original);
 const artifact=await managedArtifact(options,{objectId:receipt.objectId,relPath:'source.txt'});assert.equal(artifact.text,'Frozen project evidence.\n');
 assert.equal(state.receipts[0].snapshot.artifactDirectory,undefined);assert.equal(state.receipts[0].snapshot.directory,undefined);
});

test('missing project saves drafts and reads cached recovery without recreating the source',async t=>{
 const {root,profile,content,store,host,storage,project}=await fixture(t),work=await store.submit('Retained task','Do not replay');await store.activate(work.id);
 const receipt=await store.publish(work.id,1,'problem','# Retained offline report\n','offline-report');await store.close();
 await storage.putLocal(project.id,'managed:binding',{enabled:true});await storage.db.request(path.join(project.metadataRoot,'project.sqlite'),'close');
 await fs.rename(content,path.join(root,'disconnected-project'));
 const managed=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()}});
 await managed.saveLocalDraft(project.id,'frontdesk','Draft retained while the root is missing');
 assert.equal((await storage.getRecovery(project.id,'managed:drafts')).frontdesk,'Draft retained while the root is missing');
 const status=await managed.status(project.id);assert.equal(status.state.works[0].id,work.id);assert.equal(status.ready,false);
 const source=await managed.reportSource(project.id,receipt.objectId);assert.equal((await source.read()).toString(),'# Retained offline report\n');
 await assert.rejects(managed.connect(project.id,{enable:true}),{code:'PROJECT_ROOT_MISSING'});
 await assert.rejects(fs.access(content),{code:'ENOENT'});assert.equal(managed.controllers.size,0);
 const offline=await Workspace.open(await managedRuntime(storage,project.id),content,{storage,projectId:project.id,offline:true});
 try{assert.equal(offline.state.works[0].id,work.id);await assert.rejects(fs.access(content),{code:'ENOENT'});}finally{await offline.close();}
});

const injected=()=>Object.assign(Error('injected project commit failure'),{code:'INJECTED_PROJECT_COMMIT'});
async function consumeInput(store,text){
 return store.mutate(tx=>{store.state.jobs??=[];store.state.jobs.push({id:'accepted-input',target:'frontdesk',type:'front',text,status:'queued',explicitInput:true});tx.consumeDraft('frontdesk',text);});
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('failed project commit never persists a cleared draft and pending intent survives reopen',async t=>{
 const {store,storage,project,runtime,content}=await fixture(t);
 await store.setDraft('frontdesk','Unsent request');
 const replace=storage.replaceProjectCollections.bind(storage);storage.replaceProjectCollections=async()=>{throw injected();};
 await assert.rejects(consumeInput(store,'Unsent request'),{code:'INJECTED_PROJECT_COMMIT'});storage.replaceProjectCollections=replace;
 assert.equal(store.state.drafts.frontdesk,'Unsent request');assert.equal((await storage.getRecovery(project.id,'managed:drafts')).frontdesk,'Unsent request');
 assert.equal((await storage.listProject(project.id,'managed_jobs')).length,0);
 const pending=(await listManagedPending(storage,project.id)).find(row=>row.kind==='business');assert.equal(pending.status,'pending');assert.equal(pending.collections.managed_jobs[0].value.text,'Unsent request');assert.equal(pending.automaticReplay,false);
 await store.close();const reopened=await Workspace.open(runtime,content,{storage,projectId:project.id});
 try{assert.equal(reopened.state.drafts.frontdesk,'Unsent request');assert.equal(reopened.state.jobs?.length??0,0);assert.equal((await reopened.listPending())[0].id,pending.id);}finally{await reopened.close();}
});

for(const succeeds of [false,true])for(const late of ['Late concurrent input','Original input'])test(`draft confirmation preserves late ${late==='Original input'?'identical':'different'} input when commit ${succeeds?'succeeds':'fails'}`,async t=>{
 const {store,storage,project}=await fixture(t);await store.setDraft('frontdesk','Original input');
 const entered=deferred(),release=deferred(),replace=storage.replaceProjectCollections.bind(storage);
 storage.replaceProjectCollections=async(...args)=>{entered.resolve();await release.promise;if(!succeeds)throw injected();return replace(...args);};
 const commit=consumeInput(store,'Original input');const settled=commit.then(()=>({ok:true}),error=>({error}));await entered.promise;
 await store.setDraft('frontdesk',late);release.resolve();const result=await settled;storage.replaceProjectCollections=replace;
 assert.equal(result.ok===true,succeeds);assert.equal(store.state.drafts.frontdesk,late);assert.equal((await storage.getRecovery(project.id,'managed:drafts')).frontdesk,late);
});

test('successful commit confirms draft clearing only after project data exists',async t=>{
 const {store,storage,project}=await fixture(t);await store.setDraft('frontdesk','Accepted input');
 const put=storage.putRecovery.bind(storage),events=[];
 storage.putRecovery=async(id,key,value)=>{if(key==='managed:drafts'&&value.frontdesk===''){events.push('clear');assert.equal((await storage.listProject(project.id,'managed_jobs'))[0].value.text,'Accepted input');}return put(id,key,value);};
 await consumeInput(store,'Accepted input');storage.putRecovery=put;
 assert.deepEqual(events,['clear']);assert.equal(store.state.drafts.frontdesk,'');assert.equal((await storage.getRecovery(project.id,'managed:drafts')).frontdesk,'');
 assert.equal((await listManagedPending(storage,project.id)).length,0);
});

test('lifecycle rejection retains drafts and the complete pending business candidate',async t=>{
 const {store,storage,project}=await fixture(t);await store.setDraft('frontdesk','Held lifecycle input');
 const online=storage.requireOnline.bind(storage);storage.requireOnline=async()=>{throw Object.assign(Error('lifecycle held'),{code:'PROJECT_LIFECYCLE_ACTIVE'});};
 await assert.rejects(consumeInput(store,'Held lifecycle input'),{code:'PROJECT_LIFECYCLE_ACTIVE'});storage.requireOnline=online;
 assert.equal((await storage.getRecovery(project.id,'managed:drafts')).frontdesk,'Held lifecycle input');
 assert.equal((await listManagedPending(storage,project.id)).find(row=>row.kind==='business').collections.managed_jobs[0].value.text,'Held lifecycle input');
});

test('explicit recovery merges independent business edits, promotes verified result objects and never replays jobs',async t=>{
 const {store,storage,project}=await fixture(t),work=await store.submit('Retain result','Inspect without rerun');await store.activate(work.id);
 const replace=storage.replaceProjectCollections.bind(storage);storage.replaceProjectCollections=async()=>{throw injected();};
 await assert.rejects(store.publish(work.id,1,'problem','# Pending result\n\nRetained bytes.\n','pending-result'),{code:'INJECTED_PROJECT_COMMIT'});storage.replaceProjectCollections=replace;
 const pending=(await listManagedPending(storage,project.id)).find(row=>row.kind==='business'),receipt=pending.collections.managed_receipts.find(row=>row.id==='pending-result').value;
 // Remove only this fixture's project object to require verified recovery promotion while online.
 await fs.unlink(path.join(project.metadataRoot,'objects','sha256',receipt.report.digest));
 assert.equal((await store.readObject(receipt.report.digest)).toString(),'# Pending result\n\nRetained bytes.\n');
 const workRow=(await storage.listProject(project.id,'managed_works'))[0].value;await storage.putProject(project.id,'managed_works',work.id,{...workRow,name:'Independent current edit'});
 const result=await reconcileManagedPending(storage,project.id,{pendingId:pending.id,requestKey:'reconcile-result-one',confirmed:true});
 assert.equal(result.accepted,true);assert.equal(result.automaticReplay,false);assert.ok(result.promotedObjects.includes(receipt.report.digest));
 assert.equal((await storage.readObject(project.id,receipt.report.digest)).toString(),'# Pending result\n\nRetained bytes.\n');
 const recovered=await readManagedState(storage,project.id);assert.equal(recovered.works[0].name,'Independent current edit');assert.equal(recovered.receipts[0].id,'pending-result');
 assert.deepEqual(await reconcileManagedPending(storage,project.id,{pendingId:pending.id,requestKey:'reconcile-result-one',confirmed:true}),result);
 assert.equal((await storage.listProject(project.id,'managed_receipts')).length,1);
});

test('recovered queued requests are inspection-only and original drafts stay retained',async t=>{
 const {store,storage,project}=await fixture(t);await store.setDraft('frontdesk','Never replay this input');
 const replace=storage.replaceProjectCollections.bind(storage);storage.replaceProjectCollections=async()=>{throw injected();};await assert.rejects(consumeInput(store,'Never replay this input'));storage.replaceProjectCollections=replace;
 const pending=(await listManagedPending(storage,project.id)).find(row=>row.kind==='business');
 await assert.rejects(reconcileManagedPending(storage,project.id,{pendingId:pending.id,requestKey:'explicit-required'}),{code:'RECOVERY_CONFIRM_REQUIRED'});
 const result=await reconcileManagedPending(storage,project.id,{pendingId:pending.id,requestKey:'explicit-required',confirmed:true});assert.equal(result.accepted,true);
 const jobs=await storage.listProject(project.id,'managed_jobs');assert.equal(jobs[0].value.status,'interrupted');assert.equal(jobs[0].value.recoveryRequiresExplicitInput,true);assert.equal(jobs[0].value.automaticReplay,false);
 assert.equal((await storage.getRecovery(project.id,'managed:drafts')).frontdesk,'Never replay this input');
});

test('recovery refuses conflicting business edits without replacing current data',async t=>{
 const {store,storage,project}=await fixture(t),work=await store.submit('Original','Approved');
 const replace=storage.replaceProjectCollections.bind(storage);storage.replaceProjectCollections=async()=>{throw injected();};
 await assert.rejects(store.mutate(()=>{store.find(work.id).brief='Pending changed brief';}));storage.replaceProjectCollections=replace;
 const row=(await storage.listProject(project.id,'managed_works'))[0].value;await storage.putProject(project.id,'managed_works',work.id,{...row,brief:'Current changed brief'});
 const pending=(await listManagedPending(storage,project.id)).find(item=>item.kind==='business'),result=await reconcileManagedPending(storage,project.id,{pendingId:pending.id,requestKey:'conflicting-brief',confirmed:true});
 assert.equal(result.accepted,false);assert.equal(result.status,'conflict');assert.ok(result.conflicts.some(value=>value.endsWith('.brief')));
 assert.equal((await storage.listProject(project.id,'managed_works'))[0].value.brief,'Current changed brief');assert.ok((await listManagedPending(storage,project.id)).some(row=>row.id===pending.id));
});

test('corrupt recovery objects block reconciliation and preserve pending results',async t=>{
 const {store,storage,project}=await fixture(t),work=await store.submit('Integrity','Verify original bytes');await store.activate(work.id);
 const replace=storage.replaceProjectCollections.bind(storage);storage.replaceProjectCollections=async()=>{throw injected();};await assert.rejects(store.publish(work.id,1,'problem','# Integrity candidate\n','corrupt-result'));storage.replaceProjectCollections=replace;
 const pending=(await listManagedPending(storage,project.id)).find(row=>row.kind==='business'),receipt=pending.collections.managed_receipts[0].value;
 await fs.writeFile(path.join(await storage.recoveryDirectory(project.id),'objects','sha256',receipt.report.digest),'Corrupted recovery bytes');
 await assert.rejects(reconcileManagedPending(storage,project.id,{pendingId:pending.id,requestKey:'corrupt-object-retry',confirmed:true}),{code:'MATERIAL_CORRUPT'});
 assert.equal((await storage.listProject(project.id,'managed_receipts')).length,0);assert.ok((await listManagedPending(storage,project.id)).some(row=>row.id===pending.id));
});

test('reconcile retry after post-commit recovery failure is idempotent across reopen',async t=>{
 const {store,storage,project,runtime,content}=await fixture(t);await store.setDraft('frontdesk','Crash retained input');
 const replace=storage.replaceProjectCollections.bind(storage);storage.replaceProjectCollections=async()=>{throw injected();};await assert.rejects(consumeInput(store,'Crash retained input'));storage.replaceProjectCollections=replace;
 const pending=(await listManagedPending(storage,project.id)).find(row=>row.kind==='business'),put=storage.putRecovery.bind(storage);let injectedOnce=false;
 storage.putRecovery=async(id,key,value)=>{if(key===pending.id&&value.status==='reconciled'&&!injectedOnce){injectedOnce=true;throw Object.assign(Error('recovery confirmation crash'),{code:'INJECTED_CONFIRM_CRASH'});}return put(id,key,value);};
 await assert.rejects(reconcileManagedPending(storage,project.id,{pendingId:pending.id,requestKey:'crash-reconcile-retry',confirmed:true}),{code:'INJECTED_CONFIRM_CRASH'});storage.putRecovery=put;
 await store.close();const reopened=await Workspace.open(runtime,content,{storage,projectId:project.id});
 try{const result=await reopened.reconcilePending({pendingId:pending.id,requestKey:'crash-reconcile-retry',confirmed:true});assert.equal(result.accepted,true);assert.equal((await storage.listProject(project.id,'managed_jobs')).length,1);assert.equal((await storage.listProject(project.id,'managed_jobs'))[0].value.status,'interrupted');assert.equal(reopened.state.drafts.frontdesk,'Crash retained input');}finally{await reopened.close();}
});

test('unknown project commit keeps draft until explicit inspection-only reconciliation',async t=>{
 const {store,storage,project}=await fixture(t);await store.setDraft('frontdesk','Unknown commit input');
 const replace=storage.replaceProjectCollections.bind(storage);storage.replaceProjectCollections=async(...args)=>{await replace(...args);throw Object.assign(Error('lost commit response'),{code:'STORAGE_RESULT_UNKNOWN'});};
 await assert.rejects(consumeInput(store,'Unknown commit input'),{code:'STORAGE_RESULT_UNKNOWN'});storage.replaceProjectCollections=replace;
 assert.equal((await storage.getRecovery(project.id,'managed:drafts')).frontdesk,'Unknown commit input');assert.equal((await storage.listProject(project.id,'managed_jobs')).length,1);
 assert.equal(store.state.jobs[0].text,'Unknown commit input');assert.equal(typeof store.commitUnknown.pendingId,'string');
 let entered=false;await assert.rejects(store.mutate(()=>{entered=true;}),{code:'STORAGE_RESULT_UNKNOWN'});assert.equal(entered,false);
 await assert.rejects(store.requireOnline(),{code:'STORAGE_RESULT_UNKNOWN'});await assert.rejects(store.save(),{code:'STORAGE_RESULT_UNKNOWN'});
 await store.setDraft('frontdesk','Late input still recoverable during unknown hold');assert.equal((await storage.getRecovery(project.id,'managed:drafts')).frontdesk,'Late input still recoverable during unknown hold');
 const pending=(await listManagedPending(storage,project.id)).find(row=>row.kind==='business'),result=await reconcileManagedPending(storage,project.id,{pendingId:pending.id,requestKey:'unknown-commit-inspection',confirmed:true});
 assert.equal(result.accepted,true);assert.equal((await storage.listProject(project.id,'managed_jobs')).length,1);assert.equal((await storage.listProject(project.id,'managed_jobs'))[0].value.status,'interrupted');
});

test('business merge checks its complete baseline atomically against a late project writer',async t=>{
 const {store,storage,project}=await fixture(t),work=await store.submit('Concurrent project','Original brief');
 const replace=storage.replaceProjectCollections.bind(storage);storage.replaceProjectCollections=async()=>{throw injected();};await assert.rejects(store.mutate(()=>{store.find(work.id).name='Pending name';}));storage.replaceProjectCollections=replace;
 const pending=(await listManagedPending(storage,project.id)).find(row=>row.kind==='business');let changed=false;
 storage.replaceProjectCollections=async(...args)=>{if(!changed){changed=true;const current=(await storage.listProject(project.id,'managed_works'))[0].value;await storage.putProject(project.id,'managed_works',work.id,{...current,brief:'Late concurrent project brief'});}return replace(...args);};
 const result=await reconcileManagedPending(storage,project.id,{pendingId:pending.id,requestKey:'late-project-writer',confirmed:true});storage.replaceProjectCollections=replace;
 assert.equal(result.accepted,false);assert.equal(result.status,'conflict');assert.equal((await storage.listProject(project.id,'managed_works'))[0].value.brief,'Late concurrent project brief');assert.equal((await storage.listProject(project.id,'managed_works'))[0].value.name,undefined);
});

test('recovery-only objects are readable online and explicitly promoted idempotently',async t=>{
 const {store,storage,project}=await fixture(t),put=storage.putObject.bind(storage);storage.putObject=async()=>{throw injected();};
 const digest=await store.putObject(Buffer.from('Recovery-only immutable object'));storage.putObject=put;
 assert.equal((await store.readObject(digest)).toString(),'Recovery-only immutable object');
 const pending=(await listManagedPending(storage,project.id)).find(row=>row.kind==='object'),options={pendingId:pending.id,requestKey:'object-promotion-once',confirmed:true};
 const result=await reconcileManagedPending(storage,project.id,options);assert.equal(result.accepted,true);assert.deepEqual(result.promotedObjects,[digest]);assert.equal((await storage.readObject(project.id,digest)).toString(),'Recovery-only immutable object');
 assert.deepEqual(await reconcileManagedPending(storage,project.id,options),result);
 await assert.rejects(reconcileManagedPending(storage,project.id,{...options,pendingId:'managed:object-pending:another'}),{code:'REQUEST_KEY_COLLISION'});
});

test('Controller task acceptance uses the durable intent and confirmation path without model execution',async t=>{
 const {store,storage,project,runtime,content}=await fixture(t);
 await store.setDraft('frontdesk','Controller original draft');await store.close();
 const controller=await Controller.open({storage,projectId:project.id,runtimeRoot:runtime,contentRoot:content,localOnly:true}),replace=storage.replaceProjectCollections.bind(storage);
 try{
  assert.equal(controller.started,false);assert.equal(controller.sessions.size,0);
  storage.replaceProjectCollections=async()=>{throw injected();};
  await assert.rejects(controller.submitTask('Controller original draft',{requestKey:'controller-failed-input'}),{code:'INJECTED_PROJECT_COMMIT'});
  storage.replaceProjectCollections=replace;
  assert.equal((await storage.getRecovery(project.id,'managed:drafts')).frontdesk,'Controller original draft');
  assert.equal(controller.store.state.jobs.length,0);assert.equal((await storage.listProject(project.id,'managed_jobs')).length,0);
  const pending=(await listManagedPending(storage,project.id)).find(row=>row.kind==='business');assert.equal(pending.collections.managed_jobs[0].value.text,'Controller original draft');
  assert.equal(controller.sessions.size,0);assert.equal(controller.starting.size,0);assert.equal(controller.running.size,0);
  await controller.store.requireOnline();const accepted=await controller.submitTask('Controller original draft',{requestKey:'controller-success-input'});
  assert.equal(accepted.accepted,true);assert.equal((await storage.getRecovery(project.id,'managed:drafts')).frontdesk,'');
  const jobs=await storage.listProject(project.id,'managed_jobs');assert.equal(jobs.length,1);assert.equal(jobs[0].id,accepted.jobId);assert.equal(jobs[0].value.text,'Controller original draft');assert.equal(jobs[0].value.status,'queued');
  assert.equal(controller.store.state.jobs[0].id,accepted.jobId);assert.equal(controller.sessions.size,0);assert.equal(controller.starting.size,0);assert.equal(controller.running.size,0);
 }finally{storage.replaceProjectCollections=replace;await controller.stop();}
});

async function nativeFactFixture(t){
 const data=await fixture(t);await data.store.close();
 const controller=await Controller.open({storage:data.storage,projectId:data.project.id,runtimeRoot:data.runtime,contentRoot:data.content,localOnly:true});
 await controller.store.mutate(()=>{controller.store.state.jobs.push({id:'native-accepted-job',target:'frontdesk',type:'front',status:'running',text:'Previously accepted business input'});});
 const fact={jobId:'native-accepted-job',requestId:'offline-request-one',sessionId:'offline-native-session',epoch:'offline-native-session#0',attempt:1,kind:'prompt',contentDigest:'a'.repeat(64),status:'prepared'};
 await controller.recordTransport('frontdesk',fact);return {...data,controller,fact};
}

test('native admitted/settled facts and canonical entries durably ACK offline without a business commit',async t=>{
 const {controller,storage,project,fact}=await nativeFactFixture(t),online=storage.requireOnline.bind(storage),replace=storage.replaceProjectCollections.bind(storage);let projectCommits=0;
 storage.requireOnline=async()=>{throw Object.assign(Error('isolated project source missing'),{code:'PROJECT_ROOT_MISSING'});};
 storage.replaceProjectCollections=async()=>{projectCommits++;throw Error('Native journal must not replace business collections');};
 try{
  await controller.recordTransport('frontdesk',{...fact,status:'admitted',seq:1});
  await controller.recordNativeEntries('frontdesk',{sessionId:fact.sessionId,epoch:fact.epoch,jobId:fact.jobId,requestId:fact.requestId,entry:{id:'offline-answer-entry',type:'message',message:{role:'assistant',content:[{type:'text',text:'Retained offline native answer'}]}}});
  await controller.recordTransport('frontdesk',{...fact,status:'settled',seq:2});
  assert.equal(projectCommits,0);assert.equal(controller.store.state.jobs[0].status,'running');assert.equal(controller.store.state.messages.some(row=>row.nativeEntryDigest),false);
  const native=await storage.getRecovery(project.id,'managed:native-facts');assert.equal(native.jobs[0].local.collabAttempts[0].status,'settled');assert.equal(native.sessionIndex.entries[0].entryId,'offline-answer-entry');
  const reloaded=await readManagedState(storage,project.id,{offline:true});assert.equal(reloaded.jobs[0].status,'running');assert.equal(reloaded.jobs[0].collabAttempts[0].status,'settled');assert.equal(reloaded.sessionIndex.entries[0].ownership,'verified');
  const pending=(await listManagedPending(storage,project.id)).find(row=>row.nativeMessageIds?.length);assert.ok(pending);assert.equal(pending.collections.managed_jobs[0].value.status,'running');assert.equal(pending.automaticReplay,false);
  assert.equal(controller.snapshot().timeline.entries.find(row=>row.entryId==='offline-answer-entry').text,'Retained offline native answer');
  await assert.rejects(controller.recordTransport('frontdesk',{...fact,requestId:'forbidden-new-prompt',status:'prepared'}),{code:'PROJECT_ROOT_MISSING'});
  assert.equal(controller.store.state.jobs[0].collabAttempts.length,1);assert.equal(controller.sessions.size,0);
 }finally{storage.requireOnline=online;storage.replaceProjectCollections=replace;await controller.stop();}
});

for(const unknown of [false,true])test(`native journal ${unknown?'unknown':'failed'} local commit is never acknowledged as durable success`,async t=>{
 const {controller,storage,project,fact}=await nativeFactFixture(t),put=storage.putRecovery.bind(storage);
 storage.putRecovery=async(id,key,value)=>{if(key==='managed:native-facts'){if(unknown)await put(id,key,value);throw Object.assign(Error('injected native WAL commit failure'),{code:unknown?'STORAGE_RESULT_UNKNOWN':'INJECTED_NATIVE_WAL'});}return put(id,key,value);};
 try{
  await assert.rejects(controller.recordTransport('frontdesk',{...fact,status:'admitted',seq:1}),{code:unknown?'STORAGE_RESULT_UNKNOWN':'INJECTED_NATIVE_WAL'});
  storage.putRecovery=put;
  const native=await storage.getRecovery(project.id,'managed:native-facts');assert.equal(native.jobs[0].local.collabAttempts[0].status,unknown?'admitted':'prepared');
  if(unknown){assert.ok(controller.store.nativeCommitUnknown);await assert.rejects(controller.recordTransport('frontdesk',{...fact,status:'settled',seq:2}),{code:'STORAGE_RESULT_UNKNOWN'});}
  else assert.equal(controller.store.state.jobs[0].collabAttempts[0].status,'prepared');
  assert.equal(controller.sessions.size,0);
 }finally{storage.putRecovery=put;await controller.stop();}
});
