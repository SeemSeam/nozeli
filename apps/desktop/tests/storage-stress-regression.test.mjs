import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {readManagedState,saveManagedState} from '../src/agents/managed/managed-storage.mjs';

// Regressions for the 100-chat managed storage stress failure:
// 1. replace must apply only the row delta while producing exactly the table
//    state a full DELETE+re-INSERT would produce (values and revision=1).
// 2. Errors inside an open transaction must surface their original code and
//    message; the automatic ROLLBACK must never mask the SQLite failure.
// 3. saveManagedState must not rewrite full-state pending records for
//    mutations that only change durable local metadata (context budget epochs),
//    and unchanged business snapshots must not issue a project transaction.

async function openProject(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-storage-stress-'));
  const content=path.join(root,'project');
  await fs.mkdir(content,{recursive:true});
  const storage=new ProjectStorage(path.join(root,'.test-storage'));
  const project=await storage.register(content);
  return {root,storage,projectId:project.id};
}

test('replace applies the row delta with exact full-rewrite table state',async t=>{
  const {root,storage,projectId}=await openProject();
  t.after(async()=>{await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
  await storage.replaceProjectCollections(projectId,{c:[{id:'a',value:{x:1}},{id:'b',value:{y:2}}]});
  assert.deepEqual((await storage.getProjectRecord(projectId,'c','a')),{value:{x:1},revision:1});
  // An external put bumps b to revision 2; replace must reset it exactly like a full rewrite.
  await storage.putProject(projectId,'c','b',{y:2});
  assert.equal((await storage.getProjectRecord(projectId,'c','b')).revision,2);
  await storage.replaceProjectCollections(projectId,{c:[{id:'a',value:{x:1}},{id:'b',value:{y:2}}]});
  assert.deepEqual((await storage.getProjectRecord(projectId,'c','a')),{value:{x:1},revision:1},'identical row untouched');
  assert.deepEqual((await storage.getProjectRecord(projectId,'c','b')),{value:{y:2},revision:1},'rewritten row reset to revision 1');
  // add/remove rows
  await storage.replaceProjectCollections(projectId,{c:[{id:'a',value:{x:1}},{id:'c',value:{z:3}}]});
  const rows=await storage.listProject(projectId,'c');
  assert.deepEqual(rows.map(row=>[row.id,row.value]).sort(),[['a',{x:1}],['c',{z:3}]]);
  assert.ok(rows.every(row=>row.revision===1));
  // idempotent repeat keeps byte-identical state
  await storage.replaceProjectCollections(projectId,{c:[{id:'a',value:{x:1}},{id:'c',value:{z:3}}]});
  assert.deepEqual((await storage.getProjectRecord(projectId,'c','c')),{value:{z:3},revision:1});
});

test('transaction failure keeps the original error, never a rollback artifact',async t=>{
  const {root,storage,projectId}=await openProject();
  t.after(async()=>{await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
  await storage.replaceProjectCollections(projectId,{c:[{id:'a',value:{x:1}}]});
  // CAS mismatch throws inside the open transaction; the explicit ROLLBACK runs.
  await assert.rejects(storage.replaceProjectCollections(projectId,{c:[{id:'a',value:{x:2}}]},{expectedCollections:{c:[{id:'a',value:{x:999}}]}}),error=>{
    assert.equal(error.code,'STORAGE_CONFLICT');
    assert.ok(!error.message.includes('cannot rollback'),'original message must not be masked: '+error.message);
    return true;
  });
  // The transaction rolled back: the conflicting write must not be visible.
  assert.deepEqual((await storage.getProjectRecord(projectId,'c','a')),{value:{x:1},revision:1});
});

test('expectedCollections comparison stays order-insensitive',async t=>{
  const {root,storage,projectId}=await openProject();
  t.after(async()=>{await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
  await storage.putProject(projectId,'c','d',{p:1,q:2});
  await storage.replaceProjectCollections(projectId,{c:[{id:'d',value:{q:2,p:1}}]},{expectedCollections:{c:[{id:'d',value:{q:2,p:1}}]}});
  assert.deepEqual((await storage.getProjectRecord(projectId,'c','d')),{value:{q:2,p:1},revision:1});
});

test('duplicate ids in replace keep failing like the full rewrite',async t=>{
  const {root,storage,projectId}=await openProject();
  t.after(async()=>{await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
  await assert.rejects(storage.replaceProjectCollections(projectId,{c:[{id:'d',value:1},{id:'d',value:2}]}),error=>{
    assert.equal(error.code,'STORAGE_FAILED');
    assert.ok(error.message.includes('UNIQUE constraint failed'));
    return true;
  });
});

function fakeStore(storage,projectId,state){
  const calls={putRecovery:[],putLocal:[],replace:0};
  const fake={
    requireOnline:async()=>({id:projectId}),
    getRecovery:async()=>null,
    putRecovery:async(id,key,value)=>{calls.putRecovery.push({key,status:value.status});},
    putLocal:async(id,key,value)=>{calls.putLocal.push(key);},
    listProject:async()=>[],
    replaceProjectCollections:async(id,collections)=>{calls.replace++;},
  };
  const store={storage:fake,projectId,state,offline:false,
    persistDrafts:async()=>{},persistNativeFacts:async()=>{},confirmDrafts:async()=>{}};
  return {store,calls,fake};
}

test('saveManagedState minimizes writes without skipping required acknowledgments',async t=>{
  const {root,storage,projectId}=await openProject();
  t.after(async()=>{await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
  const state={todos:[],works:[],jobs:[],messages:[{id:'m1',value:{text:'hi'}}],contextBudgetEpochs:{frontdesk:{'e:1':{used:3}}}};
  const {store,calls}=fakeStore(storage,projectId,structuredClone(state));
  const first=await saveManagedState(store);
  assert.equal(first.committed,true);
  assert.equal(calls.replace,1,'changed snapshot commits exactly one project transaction');
  assert.deepEqual(calls.putRecovery.map(row=>row.status),['prepared','reconciled'],'one intent write and one completion write');
  // Identical snapshot: no recovery record, no project transaction, no local rewrite.
  calls.putRecovery.length=0;calls.putLocal.length=0;calls.replace=0;
  const second=await saveManagedState(store);
  assert.equal(second.committed,true);
  assert.equal(calls.putRecovery.length,0);
  assert.equal(calls.replace,0);
  assert.equal(calls.putLocal.length,0);
  // Local-metadata-only mutation (budget epochs): durable local write, no business snapshot rewrite.
  store.state=structuredClone({...state,contextBudgetEpochs:{frontdesk:{'e:1':{used:9}}}});
  calls.putRecovery.length=0;calls.putLocal.length=0;calls.replace=0;
  const third=await saveManagedState(store);
  assert.equal(third.committed,true);
  assert.equal(calls.replace,0,'budget epoch accounting must not rewrite the business snapshot');
  assert.equal(calls.putRecovery.length,0,'no full-state pending record for local metadata');
  assert.deepEqual(calls.putLocal,['managed:contextBudgetEpochs'],'epoch write is a small durable local record');
});

test('a failed business save still retains the pending candidate',async t=>{
  const {root,storage,projectId}=await openProject();
  t.after(async()=>{await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
  const state={todos:[],works:[],jobs:[],messages:[{id:'m1',value:{text:'held'}}]};
  const {store,calls,fake}=fakeStore(storage,projectId,structuredClone(state));
  const replace=fake.replaceProjectCollections;
  fake.replaceProjectCollections=async()=>{throw Object.assign(Error('INJECTED_PROJECT_COMMIT'),{code:'STORAGE_FAILED'});};
  await assert.rejects(saveManagedState(store),error=>error.message==='INJECTED_PROJECT_COMMIT');
  fake.replaceProjectCollections=replace;
  assert.deepEqual(calls.putRecovery.map(row=>row.status),['prepared','pending'],'intent retained with failure status');
});

test('context budget epochs persist as local metadata and hydrate, including legacy settings rows',async t=>{
  const {root,storage,projectId}=await openProject();
  t.after(async()=>{await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
  const epochs={frontdesk:{'e:1':{used:7}}};
  const store={storage,projectId,state:{todos:[],works:[],jobs:[],messages:[],contextBudgetEpochs:structuredClone(epochs)},offline:false,
    persistDrafts:async()=>{},persistNativeFacts:async()=>{},confirmDrafts:async()=>{}};
  await saveManagedState(store);
  const settings=await storage.listProject(projectId,'managed_settings');
  assert.ok(!settings.some(row=>row.id==='contextBudgetEpochs'),'epochs no longer ride the shared business ledger');
  const reloaded=await readManagedState(storage,projectId);
  assert.deepEqual(reloaded.contextBudgetEpochs,epochs,'epochs hydrate from durable local metadata');
  // Legacy project: epochs stored as a settings row still hydrate.
  const legacy=await openProject();
  t.after(async()=>{await legacy.storage.db.close();await fs.rm(legacy.root,{recursive:true,force:true});});
  await legacy.storage.putProject(legacy.projectId,'managed_settings','collections',['messages']);
  await legacy.storage.putProject(legacy.projectId,'managed_settings','contextBudgetEpochs',{legacy:true});
  const legacyState=await readManagedState(legacy.storage,legacy.projectId);
  assert.deepEqual(legacyState.contextBudgetEpochs,{legacy:true});
});
