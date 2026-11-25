import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {StorageDatabase} from '../src/main/storage-database.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
async function receiptFixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storage-atomic-recovery-')),root=path.join(dir,'private');
 if(process.platform==='win32')await ensureExperimentalPrivateDirectory(dir,root);else await fs.mkdir(root);
 const file=path.join(root,'recovery.sqlite'),storage=new StorageDatabase(process.platform==='win32'?{experimentalWindowsRoot:root}:{});
 t.after(async()=>{await storage.close();await fs.rm(dir,{recursive:true,force:true});});return {storage,file};
}

test('multi-collection compare-and-put keeps monotonic revisions, compare-only rows and its receipt across worker restart',async t=>{
 const {storage,file}=await receiptFixture(t);
 for(const collection of ['hosts','owners','tools']){
  await storage.request(file,'put',{collection,id:'original',value:{phase:'prepared'}});
  await storage.request(file,'put',{collection,id:'original',value:{phase:'prepared'},expectedRevision:1});
 }
 const expectedCollections={history:[]};for(const collection of ['hosts','owners','tools'])expectedCollections[collection]=await storage.request(file,'list',{collection});
 const args={operationId:'cold-retirement',expectedCollections,records:[
  {collection:'hosts',id:'original',value:{phase:'retired'},expectedRevision:2},
  {collection:'owners',id:'original',value:{phase:'retired'},expectedRevision:2},
  {collection:'history',id:'generation',value:{original:expectedCollections},expectedRevision:0}]};
 const result=await storage.request(file,'compareAndPut',args);assert.equal(result.committed,true);
 for(const collection of ['hosts','owners'])assert.deepEqual(await storage.request(file,'record',{collection,id:'original'}),{revision:3,value:{phase:'retired'}});
 assert.deepEqual(await storage.request(file,'list',{collection:'tools'}),expectedCollections.tools);
 await storage.closeFile(file);assert.deepEqual(await storage.request(file,'compareAndPut',args),result);
 assert.deepEqual(await storage.request(file,'receipt',{operationId:args.operationId}),result);
 await assert.rejects(storage.request(file,'compareAndPut',{...args,records:args.records.slice(0,2)}),{code:'STORAGE_OPERATION_CONFLICT'});
});

for(const race of ['same-value-revision','extra-row'])test(`multi-collection ${race} in a compare-only collection rolls back all retirements and history`,async t=>{
 const {storage,file}=await receiptFixture(t),expectedCollections={history:[]};
 for(const collection of ['hosts','owners','tools']){await storage.request(file,'put',{collection,id:'original',value:{phase:'prepared'}});expectedCollections[collection]=await storage.request(file,'list',{collection});}
 await storage.request(file,'put',{collection:'tools',id:race==='extra-row'?'winner':'original',value:{phase:'prepared'}});
 const args={operationId:'retirement-'+race,expectedCollections,records:[
  {collection:'hosts',id:'original',value:{phase:'retired'},expectedRevision:1},
  {collection:'owners',id:'original',value:{phase:'retired'},expectedRevision:1},
  {collection:'history',id:'generation',value:{retired:true},expectedRevision:0}]};
 await assert.rejects(storage.request(file,'compareAndPut',args),{code:'STORAGE_CONFLICT'});
 for(const collection of ['hosts','owners','history'])assert.deepEqual(await storage.request(file,'list',{collection}),expectedCollections[collection]);
 assert.equal(await storage.request(file,'receipt',{operationId:args.operationId}),null);
});

test('multi-collection writes require exact complete comparisons and reject duplicate or unchecked writes atomically',async t=>{
 const {storage,file}=await receiptFixture(t);await storage.request(file,'put',{collection:'owners',id:'original',value:{phase:'prepared'}});
 const original=await storage.request(file,'list',{collection:'owners'}),row={collection:'owners',id:'original',value:{phase:'retired'},expectedRevision:1};
 const cases=[{expectedCollections:{owners:original},records:[row,row]},
  {expectedCollections:{owners:original},records:[row,{collection:'history',id:'unchecked',value:1,expectedRevision:0}]},
  {expectedCollections:{owners:original.map(({revision,...value})=>value)},records:[row]},
  {expectedCollections:{owners:original},records:[{...row,expectedRevision:0}]}];
 for(const [index,args] of cases.entries()){
  const operationId='invalid-multi-'+index;await assert.rejects(storage.request(file,'compareAndPut',{...args,operationId}),{code:'INVALID_COMPARE_BATCH'});
  assert.deepEqual(await storage.request(file,'list',{collection:'owners'}),original);
  assert.deepEqual(await storage.request(file,'list',{collection:'history'}),[]);assert.equal(await storage.request(file,'receipt',{operationId}),null);
 }
});

test('replace with original row revisions rejects a same-value ABA winner atomically',async t=>{
 const {storage,file}=await receiptFixture(t);
 for(const [collection,value]of [['jobs',{status:'running'}],['works',{status:'review'}]])await storage.request(file,'put',{collection,id:'original',value});
 const before={};for(const collection of ['jobs','works'])before[collection]=await storage.request(file,'list',{collection});
 await storage.request(file,'put',{collection:'jobs',id:'original',value:{status:'running'},expectedRevision:1});
 const args={operationId:'hold-aba-winner',expectedCollections:before,collections:{jobs:[{id:'original',value:{status:'interrupted'}}],works:[{id:'original',value:{status:'paused'}}]}};
 await assert.rejects(storage.request(file,'replace',args),{code:'STORAGE_CONFLICT'});
 assert.deepEqual(await storage.request(file,'record',{collection:'jobs',id:'original'}),{value:{status:'running'},revision:2});
 assert.deepEqual(await storage.request(file,'list',{collection:'works'}),before.works);
 assert.equal(await storage.request(file,'receipt',{operationId:args.operationId}),null);
});

test('recovery batch CAS rejects a late target winner before clearing source or completing receipt',async t=>{
 const {storage,file}=await receiptFixture(t),collection='recovery';
 for(const [id,value]of [['source','original draft'],['target','late target winner'],['operation',{phase:'pending'}]])await storage.request(file,'put',{collection,id,value});
 const args={collection,operationId:'atomic-conflict',records:[{id:'source',value:null,expectedRevision:1},{id:'operation',value:{phase:'complete'},expectedRevision:1},{id:'target',value:'original draft',expectedRevision:0}]};
 await assert.rejects(storage.request(file,'putMany',args),{code:'STORAGE_CONFLICT'});
 assert.equal(await storage.request(file,'get',{collection,id:'source'}),'original draft');
 assert.equal(await storage.request(file,'get',{collection,id:'target'}),'late target winner');
 assert.deepEqual(await storage.request(file,'record',{collection,id:'operation'}),{revision:1,value:{phase:'pending'}});
 assert.equal(await storage.request(file,'receipt',{operationId:args.operationId}),null);
});

test('recovery batch durable receipt survives worker restart and rejects changed request identity',async t=>{
 const {storage,file}=await receiptFixture(t),collection='recovery';
 await storage.request(file,'put',{collection,id:'source',value:'retained draft'});
 const args={collection,operationId:'atomic-complete',records:[{id:'source',value:null,expectedRevision:1},{id:'target',value:'retained draft',expectedRevision:0},{id:'operation',value:{phase:'complete'},expectedRevision:0}]};
 const result=await storage.request(file,'putMany',args);await storage.closeFile(file);
 assert.deepEqual(await storage.request(file,'putMany',args),result);
 assert.deepEqual(await storage.request(file,'record',{collection,id:'source'}),{revision:2,value:null});
 assert.deepEqual(await storage.request(file,'record',{collection,id:'target'}),{revision:1,value:'retained draft'});
 assert.deepEqual(await storage.request(file,'record',{collection,id:'operation'}),{revision:1,value:{phase:'complete'}});
 await assert.rejects(storage.request(file,'putMany',{...args,records:args.records.map(row=>row.id==='target'?{...row,value:'different'}:row)}),{code:'STORAGE_OPERATION_CONFLICT'});
 assert.deepEqual(await storage.request(file,'receipt',{operationId:args.operationId}),result);
});

test('invalid recovery batch has no partial writes or operation receipt',async t=>{
 const {storage,file}=await receiptFixture(t),collection='recovery';
 await storage.request(file,'put',{collection,id:'source',value:'retained draft'});
 for(const [index,records]of [[{id:'source',value:null,expectedRevision:1},{id:'source',value:'duplicate',expectedRevision:1}],[{id:'source',value:null,expectedRevision:1},{id:'target',expectedRevision:0}],[{id:'source',value:null,expectedRevision:1},{id:'target',value:'invalid revision',expectedRevision:-1}]].entries()){
  const operationId='invalid-batch-'+index;
  await assert.rejects(storage.request(file,'putMany',{collection,records,operationId}),/INVALID_RECORD_BATCH/);
  assert.deepEqual(await storage.request(file,'record',{collection,id:'source'}),{revision:1,value:'retained draft'});
  assert.equal(await storage.request(file,'get',{collection,id:'target'}),null);
  assert.equal(await storage.request(file,'receipt',{operationId}),null);
 }
});
