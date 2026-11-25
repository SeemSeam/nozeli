import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {ProjectLifecycle} from '../src/main/project-lifecycle.mjs';
import {WorkspaceNative} from '../src/main/workspace-native.mjs';
import {spawnTool,stopTool} from '../src/main/tool-process.mjs';
import {desktopHosts} from './fixtures/desktop-hosts.mjs';

async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-bounded-lifecycle-'));
 const root=path.join(directory,'project');await fs.mkdir(root);await fs.writeFile(path.join(root,'source.txt'),'source retained\n');
 const storage=new ProjectStorage(path.join(directory,'profile')),project=await storage.register(root);
 const stops=[],closes=[];
 const managed={projectStops:new Map(),stopProject:async(id,options)=>{stops.push({id,options});return {confirmationComplete:true};}};
 const workspace={layouts:new Map(),closeProject:async(id,options)=>{closes.push({id,options});}};
 const host={storage,requireRegisteredProject:id=>storage.requireRegistered(id)};
 const lifecycle=new ProjectLifecycle({host,managed,workspace,trashItem:()=>{throw Error('never trash source');}});
 t.after(async()=>{await storage.db.close();await fs.rm(directory,{recursive:true,force:true});});
 return {directory,root,storage,project,managed,workspace,lifecycle,stops,closes};
}
async function hold(f,{action='remove',instanceId=f.project.instanceId}={}){
 const operationId=randomUUID(),h=f.storage.holdProject(f.project.id,{operationId,instanceId,action,root:f.root});
 h.needsStopCheck=true;await f.storage.persistProjectHold(f.project.id,h);
 await f.storage.putRecovery(f.project.id,'lifecycle:'+operationId,{schema:1,projectId:f.project.id,instanceId,operationId,action,root:f.root,phase:'needs-attention',failedPhase:'prepared'});
 return h;
}

test('Windows refuses unsupported permanent reset before replacing a lifecycle fence', {skip:process.platform!=='win32'}, async()=>{
 const projectId='synthetic-project',operationId='synthetic-reset',instanceId='synthetic-instance',token='synthetic-token';
 const old={operationId:'original-operation',action:'remove',instanceId};
 const lifecycleHolds=new Map([[projectId,old]]);
 const unexpected=()=>assert.fail('unsupported reset reached project or writer state');
 const host={requireRegisteredProject:unexpected,storage:{root:os.tmpdir(),lifecycleHolds,holdProject:unexpected,
  db:{request:async(_file,_op,{collection})=>collection==='permanent_resets'?{projectId,phase:'complete'}:null},requireRegistered:unexpected}};
 const lifecycle=new ProjectLifecycle({host,managed:{},workspace:{}});
 await assert.rejects(lifecycle.preview({projectId,action:'reset-project'}),{code:'PERSISTENCE_UNSUPPORTED'});
 const confirmation={projectId,operationId,instanceId,action:'reset-project',expiresAt:Date.now()+60000};
 lifecycle.tokens.set(token,confirmation);
 await assert.rejects(lifecycle.execute({token,...confirmation,confirmPermanentDelete:true}),{code:'PERSISTENCE_UNSUPPORTED'});
 lifecycle.tokens.set(token,confirmation);
 await assert.rejects(lifecycle.run(confirmation),{code:'PERSISTENCE_UNSUPPORTED'});
 await assert.rejects(lifecycle.reconcile({projectId,operationId}),{code:'PERSISTENCE_UNSUPPORTED'});
 assert.equal(lifecycleHolds.get(projectId),old);
});

test('held reset preview observes without stopping; confirmed reset discards without flush and preserves source',async t=>{
 const f=await fixture(t),h=await hold(f);
 await f.storage.putRecovery(f.project.id,'business:pending',{unknown:true,text:'discarded fixture'});
 const preview=await f.lifecycle.preview({projectId:f.project.id,action:'reset-project'});
 assert.equal(f.stops.length,0);assert.equal(f.closes.length,0);assert.equal(f.storage.lifecycleHolds.get(f.project.id),h);
 await assert.rejects(f.lifecycle.execute({token:preview.token}),{code:'PERMANENT_DELETE_CONFIRMATION_REQUIRED'});
 const result=await f.lifecycle.execute({token:preview.token,confirmPermanentDelete:true});
 assert.equal(result.complete,true);assert.notEqual(result.newInstanceId,f.project.instanceId);
 assert(f.closes.every(({options})=>options.discardState===true&&options.strictStop===true));
 assert(f.stops.every(({options})=>options.discardState===true));
 assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'source retained\n');
 assert.equal((await f.storage.requireOnline(result.newProjectId)).instanceId,result.newInstanceId);
 assert.equal(await fs.stat(path.join(f.storage.root,'recovery',f.project.instanceId)).catch(e=>e.code),'ENOENT');
});

test('one automatic pass retires only stopped same-instance non-destructive hold without replaying business',async t=>{
 const f=await fixture(t);await hold(f);const pending={unknown:true};await f.storage.putRecovery(f.project.id,'business:pending',pending);
 const [a,b]=await Promise.all([f.lifecycle.ensureProjectAvailable(f.project.id),f.lifecycle.ensureProjectAvailable(f.project.id)]);
 assert.equal(a.available,true);assert.deepEqual(a,b);assert.equal(f.stops.length,1);
 assert.equal(f.closes.length,0);assert.deepEqual(await f.storage.getRecovery(f.project.id,'business:pending'),pending);
});

test('foreign instance and active writer holds remain blocked',async t=>{
 const f=await fixture(t),h=await hold(f,{instanceId:randomUUID()});
 await assert.rejects(f.lifecycle.ensureProjectAvailable(f.project.id),{code:'PROJECT_IDENTITY_CONFLICT'});
 assert.equal(f.storage.lifecycleHolds.get(f.project.id),h);assert.equal(f.stops.length,0);
 await assert.rejects(f.lifecycle.preview({projectId:f.project.id,action:'reset-project'}),{code:'PROJECT_IDENTITY_CONFLICT'});
});

test('interrupted confirmed reset finishes missing owned targets in one pass',async t=>{
 const f=await fixture(t),preview=await f.lifecycle.preview({projectId:f.project.id,action:'reset-project'});
 const request=f.storage.db.request.bind(f.storage.db);let interrupted=false;
 f.storage.db.request=async(file,op,args)=>{
  if(!interrupted&&args?.collection==='permanent_resets'&&args.value?.phase==='cleared'){interrupted=true;throw Object.assign(Error('synthetic interruption'),{code:'EIO'});}
  return request(file,op,args);
 };
 await assert.rejects(f.lifecycle.execute({token:preview.token,confirmPermanentDelete:true}),{code:'EIO'});
 const result=await f.lifecycle.ensureProjectAvailable(f.project.id);
 assert.equal(result.available,true);assert.notEqual(result.projectId,f.project.id);
 assert.equal((await f.storage.requireOnline(result.projectId)).id,result.projectId);
 assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'source retained\n');
});

test('same unchanged stop failure is attempted once and keeps precise blocker',async t=>{
 const f=await fixture(t);await hold(f);let attempts=0;
 f.managed.stopProject=async()=>{attempts++;throw Object.assign(Error('writer still alive'),{code:'PI_EXIT_UNCONFIRMED'});};
 for(let i=0;i<2;i++)await assert.rejects(f.lifecycle.ensureProjectAvailable(f.project.id),{code:'PI_EXIT_UNCONFIRMED'});
 assert.equal(attempts,1);assert(f.storage.lifecycleHolds.has(f.project.id));
});

test('interrupted reset rejects a replacement entity instead of deleting it',async t=>{
 const f=await fixture(t),preview=await f.lifecycle.preview({projectId:f.project.id,action:'reset-project'});
 const foreign=path.join(f.directory,'foreign');await fs.mkdir(foreign);await fs.writeFile(path.join(foreign,'keep.txt'),'foreign replacement');
 const request=f.storage.db.request.bind(f.storage.db);let interrupted=false;
 f.storage.db.request=async(file,op,args)=>{
  if(!interrupted&&args?.collection==='permanent_resets'&&args.value?.phase==='cleared'){interrupted=true;throw Object.assign(Error('synthetic interruption'),{code:'EIO'});}
  return request(file,op,args);
 };
 await assert.rejects(f.lifecycle.execute({token:preview.token,confirmPermanentDelete:true}),{code:'EIO'});
 const replacement=path.join(f.root,'.nozeli');await fs.rename(foreign,replacement);
 await assert.rejects(f.lifecycle.ensureProjectAvailable(f.project.id),{code:'PROJECT_IDENTITY_CONFLICT'});
 assert.equal(await fs.readFile(path.join(replacement,'keep.txt'),'utf8'),'foreign replacement');
 assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'source retained\n');
});

for(const consumer of ['direct-reset','open-fresh'])test(`completed reset receipt resumes old catalog retirement after interruption via ${consumer}`,async t=>{
 const f=await fixture(t),preview=await f.lifecycle.preview({projectId:f.project.id,action:'reset-project'});
 const request=f.storage.db.request.bind(f.storage.db);let interrupted=false;
 f.storage.db.request=async(file,op,args)=>{
  if(!interrupted&&file===f.storage.catalog&&op==='delete'&&args?.collection==='instances'&&args.id===f.project.id){interrupted=true;throw Object.assign(Error('catalog retirement interrupted'),{code:'EIO'});}
  return request(file,op,args);
 };
 await assert.rejects(f.lifecycle.execute({token:preview.token,confirmPermanentDelete:true}),{code:'EIO'});
 const receipt=await request(f.storage.catalog,'get',{collection:'permanent_resets',id:preview.operationId});
 assert.equal(receipt.phase,'complete');assert.equal((await f.storage.requireRegistered(f.project.id)).instanceId,f.project.instanceId);
 await f.storage.db.close();
 const cold=new ProjectStorage(path.join(f.directory,'profile'));t.after(()=>cold.db.close());await cold.ready();
 const lifecycle=new ProjectLifecycle({host:{storage:cold,requireRegisteredProject:id=>cold.requireRegistered(id)},managed:f.managed,workspace:f.workspace,trashItem:()=>{throw Error('never trash');}});
 if(consumer==='direct-reset'){
  assert.deepEqual(await cold.resetProject(f.project.id,{operationId:preview.operationId}),receipt.result);
  await assert.rejects(cold.requireRegistered(f.project.id),{code:'UNKNOWN_PROJECT'});
 }
 const available=await lifecycle.ensureProjectAvailable(receipt.result.newProjectId);
 assert.equal(available.projectId,receipt.result.newProjectId);assert.equal(available.available,true);
 await assert.rejects(cold.requireRegistered(f.project.id),{code:'UNKNOWN_PROJECT'});
 assert.deepEqual((await cold.list()).map(project=>project.id),[receipt.result.newProjectId]);
 assert.equal(cold.lifecycleHolds.size,0);assert.equal((await cold.requireOnline(available.projectId)).instanceId,receipt.result.newInstanceId);
 assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'source retained\n');
});

test('actual native discard close during reset recovery never recreates discarded recovery directory',async t=>{
 const f=await fixture(t),preview=await f.lifecycle.preview({projectId:f.project.id,action:'reset-project'});
 const request=f.storage.db.request.bind(f.storage.db);let interrupted=false;
 f.storage.db.request=async(file,op,args)=>{
  if(!interrupted&&args?.collection==='permanent_resets'&&args.value?.phase==='cleared'){interrupted=true;throw Object.assign(Error('synthetic interruption'),{code:'EIO'});}
  return request(file,op,args);
 };
 await assert.rejects(f.lifecycle.execute({token:preview.token,confirmPermanentDelete:true}),{code:'EIO'});
 const recovery=path.join(f.storage.root,'recovery',f.project.instanceId);
 assert.equal(await fs.stat(recovery).catch(error=>error.code),'ENOENT');
 const native=Object.create(WorkspaceNative.prototype);
 Object.assign(native,{host:{storage:f.storage,requireRegisteredProject:id=>f.storage.requireRegistered(id),settled:async()=>{}},lifecycle:new Map(),projectRecords:()=>[],shell:null,buffers:new Map(),leases:new Map(),windows:new Map(),projectTerminals:{stopProject:async()=>{}},flushOne:()=>{throw Error('discard must not flush');}});
 f.lifecycle.workspace=native;
 const available=await f.lifecycle.ensureProjectAvailable(f.project.id);
 assert.equal(available.available,true);assert.equal((await f.storage.requireOnline(available.projectId)).id,available.projectId);
 assert.equal(await fs.stat(recovery).catch(error=>error.code),'ENOENT');
 assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'source retained\n');
});

for(const mode of ['remove','resume-stop','stop-recheck','refused','timeout','native-job'])test(`lifecycle ${mode} stops a writer opened by a previously admitted operation`,{skip:mode==='native-job'&&process.platform!=='win32'},async t=>{
 const root=path.resolve('synthetic-project'),project={id:'project',instanceId:randomUUID(),root};
 const storage=new ProjectStorage(path.resolve('unused-synthetic-profile'));
 const records=new Map();
 Object.assign(storage,{ready:async()=>{},list:async()=>[project],persistProjectHold:async()=>{},db:{request:async()=>null},reconcileLifecycleStorage:async()=>{},getRecovery:async(_id,key)=>records.get(key),requireOnline:async()=>project});
 const managed={stopProject:async()=>({confirmationComplete:true})};
 let writer=false,removed=false,closed=false;
 let child,childClosed;
 let swept;
 const firstSweep=new Promise(resolve=>{swept=resolve;});
 let finishStop;
 const stopGate=new Promise(resolve=>{finishStop=resolve;});
 const workspace={closeProject:async()=>{assert.equal(writer,false,'writer must exit before Workspace closes');closed=true;}};
 storage.remove=async()=>{assert.equal(writer,false,'writer must exit before removal');removed=true;return {removed:true};};
 const lifecycle=new ProjectLifecycle({host:{storage,requireRegisteredProject:async()=>project},managed,workspace,beforeStop:async()=>{
  if(writer&&mode==='refused')throw Object.assign(Error('stop unconfirmed'),{code:'PROCESS_JOB_EXIT_UNCONFIRMED'});
  if(writer&&mode==='timeout'){lifecycle.timeoutMs=25;await stopGate;}
  if(child){assert.equal((await stopTool(child)).treeExitVerified,true);await childClosed;}
  writer=false;swept();
 }});
 lifecycle.journal=async(_id,record)=>{records.set('lifecycle:'+record.operationId,record);};
 let start;
 const admitted=new Promise(resolve=>{start=resolve;});
 const opening=storage.withProjectOperation(project.id,async()=>{
  start();await firstSweep;
  if(mode==='native-job'){
   child=spawnTool(process.execPath,['-e','setInterval(()=>{},1000)']);
   childClosed=once(child,'close');childClosed.catch(()=>{});
   t.after(async()=>{await stopTool(child);await childClosed;});
   child.stdout.resume();child.stderr.resume();
  }
  writer=true;
 });
 await admitted;
 const confirmation={projectId:project.id,instanceId:project.instanceId,root,action:'remove',operationId:randomUUID()};
 if(mode==='refused'){
  await assert.rejects(lifecycle.run(confirmation),{code:'PROCESS_JOB_EXIT_UNCONFIRMED'});
  assert.equal(storage.lifecycleHolds.get(project.id)?.needsStopCheck,true);
  assert.equal(removed,false);assert.equal(closed,false);return;
 }
 if(mode==='timeout'){
  try{
   await assert.rejects(lifecycle.run(confirmation),{code:'PROJECT_STOP_TIMEOUT'});
   const hold=storage.lifecycleHolds.get(project.id);
   assert.equal(hold?.needsStopCheck,true);
   await assert.rejects(lifecycle.reconcile(confirmation),{code:'PROJECT_STOP_PENDING'});
   await assert.rejects(storage.withProjectOperation(project.id,()=>assert.fail('admitted while a stop is in flight')),{code:'PROJECT_LIFECYCLE_ACTIVE'});
   assert.equal(closed,false);assert.equal(removed,false);
   finishStop();
   await new Promise(resolve=>setImmediate(resolve));
   assert.equal(storage.lifecycleHolds.get(project.id),hold);
   await lifecycle.reconcile(confirmation);
   assert.equal(storage.lifecycleHolds.has(project.id),false);
   assert.equal(closed,false);assert.equal(removed,false);
  }finally{finishStop();}
  return;
 }
 if(mode==='remove'||mode==='native-job')await lifecycle.run(confirmation);
 else {
  const hold=storage.holdProject(project.id,confirmation);
  if(mode==='resume-stop')await lifecycle.stopHeldProject(project.id,hold);
  else {
   hold.needsStopCheck=true;
   await lifecycle.journal(project.id,{...confirmation,phase:'prepared'});
   // Model the first stop having been requested before the prior operation finished.
   swept();
   await lifecycle.reconcile(confirmation);
   assert.equal(storage.lifecycleHolds.has(project.id),false);
  }
 }
 await opening;
 assert.equal(writer,false);
 assert.equal(removed,mode==='remove'||mode==='native-job');
 assert.equal(closed,mode!=='stop-recheck');
});

test('Windows native catalog releases a stopped hold without replaying removal', {skip:process.platform!=='win32'||process.arch!=='x64'},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-native-lifecycle-'));
 const root=path.join(directory,'project'),profile=path.join(directory,'profile');
 const hosts=desktopHosts();let passed=false;
 t.after(async()=>{await hosts.close();if(passed)await fs.rm(directory,{recursive:true,force:true});});
 t.diagnostic(`native lifecycle fixture: ${directory}`);
 await fs.mkdir(root);await fs.writeFile(path.join(root,'source.txt'),'original\n');
 const host=hosts.create(profile),{storage}=host;
 const project=await host.requireRegisteredProject((await host.pick(root)).project.id);
 const pending={text:'unsent note',unknown:true};
 await storage.putRecovery(project.id,'business:pending',pending);
 const h=await hold({root,storage,project});
 assert.equal((await storage.db.request(storage.catalog,'get',{collection:'lifecycle_holds',id:project.id})).operationId,h.operationId);
 const lifecycle=new ProjectLifecycle({host,managed:{stopProject:async()=>({confirmationComplete:true})},workspace:{closeProject:()=>assert.fail('reconciliation must not replay Workspace close')},trashItem:()=>assert.fail('reconciliation must not trash source')});
 await assert.rejects(storage.withProjectOperation(project.id,()=>assert.fail('admitted while held')),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 assert.equal((await lifecycle.ensureProjectAvailable(project.id)).available,true);
 assert.equal(await storage.db.request(storage.catalog,'get',{collection:'lifecycle_holds',id:project.id}),null);
 assert.equal((await host.requireProject(project.id)).instanceId,project.instanceId);
 assert.deepEqual(await storage.getRecovery(project.id,'business:pending'),pending);
 assert.equal(await fs.readFile(path.join(root,'source.txt'),'utf8'),'original\n');
 passed=true;
});

for(const outcome of ['resolve','reject'])test(`related project stays fenced until a timed-out stop can ${outcome}`,async()=>{
 const root=path.resolve('synthetic-project'),primary={id:'primary',instanceId:randomUUID(),root},related={id:'related',instanceId:randomUUID(),root};
 const storage=new ProjectStorage(path.resolve('unused-synthetic-profile'));
 Object.assign(storage,{ready:async()=>{},list:async()=>[primary,related],persistProjectHold:async()=>{},db:{request:async()=>null},getRecovery:async()=>null});
 storage.resetScope=async()=>assert.fail('must not advance to reset preparation');
 storage.resetProject=async()=>assert.fail('must not run reset');
 const gate=Promise.withResolvers(),closed=[];
 let relatedSweeps=0;
 const source={root,identity:null};
 const lifecycle=new ProjectLifecycle({host:{storage,requireRegisteredProject:async()=>primary},managed:{stopProject:async()=>({confirmationComplete:true})},workspace:{closeProject:async id=>{closed.push(id);}},beforeStop:async id=>{
  if(id!==related.id||++relatedSweeps!==2)return;
  lifecycle.timeoutMs=25;
  await gate.promise;
 }});
 lifecycle.checkReset=async()=>source;
 lifecycle.journal=async()=>{};
 const confirmation={projectId:primary.id,instanceId:primary.instanceId,root,action:'reset-project',operationId:randomUUID(),source,resetScope:{relatedProjectIds:[primary.id,related.id],projects:[primary,related]}};
 try{
  await assert.rejects(lifecycle.run(confirmation),{code:'PROJECT_STOP_TIMEOUT'});
  const held=storage.lifecycleHolds.get(related.id);
  await assert.rejects(lifecycle.prepareResetAdmission(primary.id,primary),{code:'PROJECT_STOP_PENDING'});
  await assert.rejects(lifecycle.prepareResetAdmission(related.id,related),{code:'PROJECT_STOP_PENDING'});
  await assert.rejects(lifecycle.ensureProjectAvailable(related.id),{code:'PROJECT_STOP_PENDING'});
  await assert.rejects(storage.withProjectOperation(related.id,()=>assert.fail('new operation admitted')),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  if(outcome==='reject')gate.reject(new Error('late stop failure'));else gate.resolve();
  await new Promise(resolve=>setImmediate(resolve));
  await lifecycle.prepareResetAdmission(primary.id,primary);
  await lifecycle.prepareResetAdmission(related.id,related);
  assert.equal(storage.lifecycleHolds.get(related.id),held);
  await assert.rejects(storage.withProjectOperation(related.id,()=>assert.fail('settlement reopened admission')),{code:'PROJECT_LIFECYCLE_ACTIVE'});
  assert.deepEqual(closed,[primary.id]);
 }finally{gate.resolve();}
});
