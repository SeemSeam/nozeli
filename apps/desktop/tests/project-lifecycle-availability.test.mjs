import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {ProjectLifecycle} from '../src/main/project-lifecycle.mjs';
import {WorkspaceNative} from '../src/main/workspace-native.mjs';

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
