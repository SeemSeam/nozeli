import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {DatabaseSync} from 'node:sqlite';import {StorageDatabase} from '../src/main/storage-database.mjs';
import {EventEmitter} from 'node:events';
import {ProjectStorage} from '../src/main/project-storage.mjs';
test('deadline fences the writer, preserves recovery, and requires explicit reconciled generation',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storage-timeout-')),file=path.join(dir,'project.sqlite'),local=path.join(dir,'recovery.sqlite'),storage=new StorageDatabase({timeoutMs:5000});
 t.after(async()=>{await storage.close();await fs.rm(dir,{recursive:true,force:true});});
 await storage.request(file,'put',{collection:'x',id:'before',value:'original',operationId:'before'});
 const lock=new DatabaseSync(file);lock.exec('BEGIN EXCLUSIVE');storage.timeoutMs=30;let failure;
 try{await storage.request(file,'put',{collection:'x',id:'after',value:'unknown',operationId:'blocked-operation'});}catch(error){failure=error;}
 finally{await storage.invalidate(file);const channel=storage.channels.get(file);if(channel)await new Promise(resolve=>channel.worker.once('exit',resolve));lock.exec('ROLLBACK');lock.close();}
 assert.equal(failure.code,'STORAGE_RESULT_UNKNOWN');assert.equal(storage.channels.has(file),false);assert.equal(storage.quarantined.has(file),true);assert.equal(failure.operationId,'blocked-operation');
 await assert.rejects(storage.request(file,'put',{collection:'x',id:'retry',value:'must not run'}),{code:'STORAGE_RESULT_UNKNOWN'});
 storage.timeoutMs=5000;await storage.request(local,'put',{collection:'recovery',id:'draft',value:'retained'});assert.equal(await storage.request(local,'get',{collection:'recovery',id:'draft'}),'retained');
 assert.equal(await storage.reconcile(file,'blocked-operation'),null);const recovered=await storage.recover(file);assert.deepEqual(recovered.operations,[{operationId:'blocked-operation',receipt:null}]);
 assert.equal(await storage.request(file,'get',{collection:'x',id:'before'}),'original');assert.equal(await storage.request(file,'get',{collection:'x',id:'after'}),null);
});
test('an unlinked database cannot receive a cached-descriptor write or be recreated',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storage-unlinked-')),file=path.join(dir,'project.sqlite'),storage=new StorageDatabase();t.after(async()=>{await storage.close();await fs.rm(dir,{recursive:true,force:true});});await storage.request(file,'put',{collection:'x',id:'id',value:1});await fs.unlink(file);await assert.rejects(storage.request(file,'put',{collection:'x',id:'id',value:2}),{code:'PROJECT_METADATA_CONFLICT'});assert.equal(await fs.access(file).then(()=>true,()=>false),false);});
test('a first request requiring an existing database does not create a missing file',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storage-existing-')),file=path.join(dir,'missing.sqlite'),storage=new StorageDatabase();t.after(async()=>{await storage.close();await fs.rm(dir,{recursive:true,force:true});});await assert.rejects(storage.request(file,'get',{collection:'x',id:'id',mustExist:true}));assert.deepEqual(await fs.readdir(dir),[]);});

class ControlledWorker extends EventEmitter {
 constructor(){super();this.messages=[];this.terminations=0;this.references=0;}
 ref(){this.references++;}
 unref(){this.references--;}
 postMessage(message){if(this.postError)throw this.postError;this.messages.push(message);}
 terminate(){this.terminations++;return new Promise((resolve,reject)=>{this.finishTermination=()=>{this.emit('exit',0);resolve(0);};this.failTermination=reject;});}
 reply(index,value){this.emit('message',{id:this.messages[index].id,value});}
}
const microtasks=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
function controlled(t){
 t.mock.timers.enable({apis:['setTimeout']});
 const workers=[],storage=new StorageDatabase({timeoutMs:100,workerFactory:()=>{const worker=new ControlledWorker();workers.push(worker);return worker;}});
 return {storage,workers,file:'/controlled/project.sqlite'};
}

test('close seals admission synchronously, drains accepted replies, and joins one termination',async t=>{
 const {storage,workers,file}=controlled(t),request=storage.request(file,'put',{operationId:'accepted'}),worker=workers[0];
 const closing=storage.closeFile(file);
 assert.equal(storage.closeFile(file),closing);
 await assert.rejects(storage.request(file,'put',{operationId:'too-late'}),{code:'STORAGE_CLOSING'});
 assert.equal(worker.messages.length,1);assert.equal(worker.terminations,0);
 worker.reply(0,{revision:1});assert.deepEqual(await request,{revision:1});await microtasks();
 assert.equal(worker.terminations,1);assert.equal(storage.channels.has(file),true);
 await assert.rejects(storage.request(file,'get'),{code:'STORAGE_CLOSING'});
 await assert.rejects(storage.reconcile(file,'accepted'),/尚未退出/);
 worker.finishTermination();await closing;assert.equal(storage.channels.has(file),false);
 const next=storage.request(file,'get'),replacement=workers[1];replacement.reply(0,'new generation');assert.equal(await next,'new generation');
 worker.emit('error',Error('late old-generation error'));worker.emit('exit',1);worker.reply(0,'late reply');
 assert.equal(storage.channels.get(file).worker,replacement);assert.equal(storage.quarantined.has(file),false);
 const finished=storage.close();await microtasks();replacement.finishTermination();await finished;
});

test('deadline still quarantines all accepted requests while graceful close is draining',async t=>{
 const {storage,workers,file}=controlled(t),first=storage.request(file,'put',{operationId:'first'}),second=storage.request(file,'put',{operationId:'second'}),worker=workers[0];
 const outcomes=Promise.allSettled([first,second]),closing=storage.closeFile(file);let settled=false;outcomes.then(()=>{settled=true;});
 t.mock.timers.tick(100);await microtasks();
 assert.equal(worker.terminations,1);assert.equal(settled,true);assert.equal(storage.channels.has(file),true);
 worker.reply(0,{revision:1});worker.reply(1,{revision:1});
 await assert.rejects(storage.request(file,'put'),{code:'STORAGE_RESULT_UNKNOWN'});
 worker.finishTermination();const results=await outcomes;await closing;
 assert.deepEqual(results.map(result=>[result.status,result.reason.code,result.reason.operationId]),[['rejected','STORAGE_RESULT_UNKNOWN','first'],['rejected','STORAGE_RESULT_UNKNOWN','second']]);
 assert.deepEqual(storage.quarantined.get(file).operationIds,['first','second']);assert.equal(storage.channels.has(file),false);assert.equal(workers.length,1);
 await storage.close();
});

test('invalidate during close shares shutdown and keeps completed results distinct from unknowns',async t=>{
 const {storage,workers,file}=controlled(t),completed=storage.request(file,'put',{operationId:'completed'}),pending=storage.request(file,'put',{operationId:'unknown'}),worker=workers[0];
 const failure=assert.rejects(pending,error=>error.code==='STORAGE_RESULT_UNKNOWN'&&error.commitUnknown.operationId==='unknown');
 const closing=storage.closeFile(file);worker.reply(0,{revision:3});assert.deepEqual(await completed,{revision:3});
 const invalidated=storage.invalidate(file);assert.equal(storage.invalidate(file),invalidated);await microtasks();
 worker.emit('error',Error('concurrent transport error'));t.mock.timers.tick(100);await microtasks();
 assert.equal(worker.terminations,1);worker.finishTermination();await Promise.all([closing,invalidated,failure]);
 assert.deepEqual(storage.quarantined.get(file).operationIds,['unknown']);assert.equal(worker.messages.length,2);await storage.close();
});

for(const code of [0,7])test(`unexpected exit ${code} settles every accepted request without creating a replacement`,async t=>{
 const {storage,workers,file}=controlled(t),first=storage.request(file,'put',{operationId:'one'}),second=storage.request(file,'get',{operationId:'two'}),worker=workers[0];
 const outcomes=Promise.allSettled([first,second]),closing=storage.closeFile(file);worker.emit('exit',code);
 for(const result of await outcomes){assert.equal(result.status,'rejected');assert.equal(result.reason.code,'STORAGE_RESULT_UNKNOWN');}
 await closing;await assert.rejects(storage.request(file,'get'),{code:'STORAGE_RESULT_UNKNOWN'});
 assert.equal(workers.length,1);assert.equal(worker.terminations,0);await storage.close();
});

test('synchronous dispatch failure settles as unknown and cannot leak a pending request',async t=>{
 const {storage,workers,file}=controlled(t),channel=storage.channel(file),worker=workers[0];worker.postError=Error('structured clone failed');
 const failed=assert.rejects(storage.request(file,'put',{operationId:'dispatch'}),{code:'STORAGE_RESULT_UNKNOWN',operationId:'dispatch'});
 await microtasks();assert.equal(worker.terminations,1);worker.finishTermination();await failed;
 assert.equal(channel.pending.size,0);assert.equal(storage.channels.has(file),false);await storage.close();
});

test('failed termination settles requests but keeps the live generation fenced until exit',async t=>{
 const {storage,workers,file}=controlled(t),request=storage.request(file,'put',{operationId:'held'}),worker=workers[0],failure=assert.rejects(request,{code:'STORAGE_RESULT_UNKNOWN'});
 const invalidated=storage.invalidate(file);await microtasks();worker.failTermination(Error('cannot terminate'));await invalidated;await failure;
 assert.equal(storage.channels.has(file),true);await assert.rejects(storage.reconcile(file,'held'),/尚未退出/);await assert.rejects(storage.recover(file),/尚未退出/);
 await assert.rejects(storage.request(file,'put'),{code:'STORAGE_RESULT_UNKNOWN'});assert.equal(workers.length,1);
 worker.emit('exit',1);assert.equal(storage.channels.has(file),false);await storage.close();
});

test('global close seals all files and new-file admission before awaiting any reply',async t=>{
 const {storage,workers,file}=controlled(t),first=storage.request(file,'put'),second=storage.request('/controlled/other.sqlite','put'),closing=storage.close();
 await assert.rejects(storage.request(file,'get'),{code:'STORAGE_CLOSED'});await assert.rejects(storage.request('/controlled/new.sqlite','put'),{code:'STORAGE_CLOSED'});
 workers[0].reply(0,1);workers[1].reply(0,2);assert.deepEqual(await Promise.all([first,second]),[1,2]);await microtasks();
 for(const worker of workers)worker.finishTermination();await closing;assert.equal(workers.length,2);assert.equal(storage.channels.size,0);
});

test('invalidating an unopened file fences the next request instead of silently starting a generation',async t=>{
 const {storage,workers,file}=controlled(t);await storage.invalidate(file);await assert.rejects(storage.request(file,'put'),{code:'STORAGE_RESULT_UNKNOWN'});assert.equal(workers.length,0);await storage.close();
});

async function receiptFixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storage-receipts-')),file=path.join(dir,'project.sqlite'),storage=new StorageDatabase();
 t.after(async()=>{await storage.close();await fs.rm(dir,{recursive:true,force:true});});return {storage,file};
}

test('put receipts bind action, collection, id, nested content and expected revision',async t=>{
 const {storage,file}=await receiptFixture(t),args={collection:'x',id:'a',value:{text:'retained',nested:{a:1,b:2}},expectedRevision:0,operationId:'same-operation'};
 assert.deepEqual(await storage.request(file,'put',args),{revision:1});
 assert.deepEqual(await storage.request(file,'put',{...args,value:{nested:{b:2,a:1},text:'retained'}}),{revision:1});
 for(const [op,changed]of [['delete',args],['replace',{...args,collections:{x:[]}}],['put',{...args,collection:'y'}],['put',{...args,id:'b'}],['put',{...args,value:{text:'different',nested:{a:1,b:2}}}],['put',{...args,expectedRevision:1}],['put',Object.fromEntries(Object.entries(args).filter(([key])=>key!=='expectedRevision'))]]){
  await assert.rejects(storage.request(file,op,changed),{code:'STORAGE_OPERATION_CONFLICT'});
 }
 assert.deepEqual(await storage.request(file,'record',{collection:'x',id:'a'}),{value:args.value,revision:1});
 assert.equal(await storage.request(file,'get',{collection:'x',id:'b'}),null);assert.deepEqual(await storage.request(file,'list',{collection:'y'}),[]);
 await storage.closeFile(file);assert.deepEqual(await storage.reconcile(file,args.operationId),{revision:1});
 assert.deepEqual(await storage.request(file,'put',args),{revision:1});
});

test('same logical request stays idempotent across generation and open-mode changes',async t=>{
 const {storage,file}=await receiptFixture(t),args={collection:'x',id:'a',value:'same',operationId:'stable-op'};
 assert.deepEqual(await storage.request(file,'put',{...args,generation:0}),{revision:1});
 // A loss+retry replays the identical logical operation after the project
 // generation advanced; execution constraints must not change its identity.
 assert.deepEqual(await storage.request(file,'put',{...args,generation:3,mustExist:true}),{revision:1});
 assert.deepEqual(await storage.request(file,'put',{...args,generation:7}),{revision:1});
 await assert.rejects(storage.request(file,'put',{...args,generation:7,value:'different'}),{code:'STORAGE_OPERATION_CONFLICT'});
 assert.deepEqual(await storage.request(file,'record',{collection:'x',id:'a'}),{value:'same',revision:1});
});

test('delete and replace retries are idempotent but cannot change their request fingerprint',async t=>{
 const {storage,file}=await receiptFixture(t);
 await storage.request(file,'put',{collection:'x',id:'a',value:1});
 const deletion={collection:'x',id:'a',operationId:'delete-once'};assert.deepEqual(await storage.request(file,'delete',deletion),{deleted:true});
 await storage.request(file,'put',{collection:'x',id:'a',value:2});assert.deepEqual(await storage.request(file,'delete',deletion),{deleted:true});
 assert.equal(await storage.request(file,'get',{collection:'x',id:'a'}),2);
 await assert.rejects(storage.request(file,'delete',{...deletion,id:'b'}),{code:'STORAGE_OPERATION_CONFLICT'});
 const replacement={collections:{x:[{id:'a',value:{a:1,b:2}}],y:[]},operationId:'replace-once'};
 assert.deepEqual(await storage.request(file,'replace',replacement),{committed:true});
 assert.deepEqual(await storage.request(file,'replace',{...replacement,collections:{y:[],x:[{value:{b:2,a:1},id:'a'}]}}),{committed:true});
 await assert.rejects(storage.request(file,'replace',{...replacement,collections:{x:[{id:'a',value:3}],y:[]}}),{code:'STORAGE_OPERATION_CONFLICT'});
 assert.deepEqual(await storage.request(file,'record',{collection:'x',id:'a'}),{value:{a:1,b:2},revision:1});
});

test('replace compares every expected collection atomically and receipts include the baseline',async t=>{
 const {storage,file}=await receiptFixture(t),original={x:[{id:'b',value:{n:2}},{id:'a',value:{a:1,b:2}}],y:[{id:'keep',value:'original'}]};
 await storage.request(file,'replace',{collections:original});
 const expected={x:[{id:'a',value:{b:2,a:1}},{id:'b',value:{n:2}}],y:original.y,empty:[]},replacement={collections:{x:[{id:'new',value:'committed'}],y:[]},expectedCollections:expected,operationId:'cas-once'};
 assert.deepEqual(await storage.request(file,'replace',replacement),{committed:true});assert.deepEqual(await storage.request(file,'replace',replacement),{committed:true});
 await assert.rejects(storage.request(file,'replace',{...replacement,expectedCollections:{x:[]}}),{code:'STORAGE_OPERATION_CONFLICT'});
 await storage.request(file,'put',{collection:'y',id:'late',value:'newer input'});
 await assert.rejects(storage.request(file,'replace',{collections:{x:[],y:[]},expectedCollections:{x:[{id:'new',value:'committed'}],y:[]},operationId:'stale-cas'}),{code:'STORAGE_CONFLICT'});
 assert.equal(await storage.request(file,'get',{collection:'x',id:'new'}),'committed');assert.equal(await storage.request(file,'get',{collection:'y',id:'late'}),'newer input');
 assert.equal(await storage.request(file,'receipt',{operationId:'stale-cas'}),null);
 await assert.rejects(storage.request(file,'replace',{collections:{x:[]},expectedCollections:{missing:[{id:'absent',value:1}]}}),{code:'STORAGE_CONFLICT'});
 assert.equal(await storage.request(file,'get',{collection:'x',id:'new'}),'committed');
});

for(const schema of ['missing','unbound','nullable'])test(`unsupported ${schema} database schema is refused without migration`,async t=>{
 const {storage,file}=await receiptFixture(t),db=new DatabaseSync(file);
 if(schema!=='missing'){db.exec('CREATE TABLE records(collection TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(collection,id)); CREATE TABLE operation_receipts(id TEXT PRIMARY KEY,result TEXT NOT NULL'+(schema==='nullable'?',fingerprint TEXT':'')+');');db.prepare('INSERT INTO operation_receipts(id,result) VALUES(?,?)').run('old',JSON.stringify({revision:4}));}db.close();
 const before=await fs.readFile(file);
 await assert.rejects(storage.request(file,'put',{collection:'x',id:'a',value:'not written',operationId:'old'}),{code:'STORAGE_FORMAT_UNSUPPORTED'});
 await storage.closeFile(file);await assert.rejects(storage.reconcile(file,'old'),{code:'STORAGE_FORMAT_UNSUPPORTED'});
 assert.deepEqual(await fs.readFile(file),before);
});

test('hung termination returns bounded invalidate and close outcomes without releasing the fence',async t=>{
 const {storage,workers,file}=controlled(t),request=storage.request(file,'put',{operationId:'hung'}),worker=workers[0];
 const failure=assert.rejects(request,{code:'STORAGE_RESULT_UNKNOWN'}),invalidated=storage.invalidate(file),closing=storage.closeFile(file);
 await failure;await microtasks();assert.equal(storage.channels.has(file),true);assert.equal(worker.terminations,1);
 t.mock.timers.tick(100);const outcome=await invalidated;assert.deepEqual(outcome,{closed:false,code:'STORAGE_RESULT_UNKNOWN',file,operationIds:['hung']});assert.deepEqual(await closing,outcome);
 await assert.rejects(storage.reconcile(file,'hung'),/尚未退出/);await assert.rejects(storage.recover(file),/尚未退出/);
 await assert.rejects(storage.request(file,'put'),{code:'STORAGE_RESULT_UNKNOWN'});assert.equal(workers.length,1);
 worker.finishTermination();await microtasks();assert.equal(storage.channels.has(file),false);
 await assert.rejects(storage.request(file,'put'),{code:'STORAGE_RESULT_UNKNOWN'});assert.equal(workers.length,1);await storage.close();
});

test('global close of an idle worker is bounded even if terminate never finishes',async t=>{
 const {storage,workers,file}=controlled(t);storage.channel(file);const closing=storage.close();await microtasks();t.mock.timers.tick(100);
 assert.deepEqual(await closing,[{closed:false,code:'STORAGE_RESULT_UNKNOWN',file,operationIds:[]}]);assert.equal(storage.channels.has(file),true);
 workers[0].finishTermination();await microtasks();assert.equal(storage.channels.has(file),false);
});

test('an idle clean worker exit fences the file rather than silently starting a replacement',async t=>{
 const {storage,workers,file}=controlled(t);storage.channel(file);workers[0].emit('exit',0);await microtasks();
 await assert.rejects(storage.request(file,'get'),{code:'STORAGE_RESULT_UNKNOWN'});assert.equal(workers.length,1);assert.deepEqual(storage.quarantined.get(file).operationIds,[]);await storage.close();
});

test('explicit reconciliation seals admission until its separate receipt reader has exited',async t=>{
 const {storage,file}=await receiptFixture(t);await fs.writeFile(file,'controlled receipt reader');
 let created;const ready=new Promise(resolve=>{created=resolve;}),worker=new ControlledWorker();storage.workerFactory=()=>{created();return worker;};
 const reconciliation=storage.reconcile(file,'receipt-only');
 await assert.rejects(storage.request(file,'put'),{code:'STORAGE_RECONCILING'});await assert.rejects(storage.reconcile(file,'other'),{code:'STORAGE_RECONCILING'});
 await ready;assert.equal(worker.messages[0].op,'receipt');assert.equal(worker.messages[0].args.mustExist,true);worker.reply(0,{revision:2});await microtasks();
 await assert.rejects(storage.request(file,'put'),{code:'STORAGE_RECONCILING'});assert.equal(worker.terminations,1);
 worker.finishTermination();assert.deepEqual(await reconciliation,{revision:2});assert.equal(storage.reconciliations.has(file),false);
});

test('a worker failure reply received during close settles with its known operation error',async t=>{
 const {storage,workers,file}=controlled(t),request=storage.request(file,'put',{operationId:'conflicted'}),worker=workers[0],failure=assert.rejects(request,{code:'STORAGE_CONFLICT',operationId:'conflicted'}),closing=storage.closeFile(file);
 worker.emit('message',{id:worker.messages[0].id,error:{code:'STORAGE_CONFLICT',message:'revision changed'}});await failure;await microtasks();
 assert.equal(worker.terminations,1);assert.equal(storage.quarantined.has(file),false);worker.finishTermination();await closing;await storage.close();
});

for(const closeFailure of ['outcome','rejection'])test(`unconfirmed staging close (${closeFailure}) prevents initialization cleanup`,async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storage-close-cleanup-')),root=path.join(dir,'project');await fs.mkdir(root);
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const stat=await fs.stat(root),temporary=path.join(root,'.nozeli-init-owned'),operationId='owned-initialization',intent={version:1,root,identity:{dev:String(stat.dev),ino:String(stat.ino)},id:'project-id',instanceId:'instance-id',operationId,temporary,phase:'prepared',source:null};
 await fs.mkdir(temporary);await fs.writeFile(path.join(temporary,'initialization.json'),JSON.stringify({operationId}));await fs.writeFile(path.join(temporary,'retained'),'original content');
 const storage=new ProjectStorage(path.join(dir,'profile')),calls=[];storage.ready=async()=>{};
 storage.db={request:async(file,op,args)=>{calls.push({file,op,args});if(op==='list'&&args.collection==='instances')return [];if(op==='get'&&args.collection==='initializations')return intent;if(op==='close'){if(closeFailure==='rejection')throw Object.assign(Error('stop unconfirmed'),{code:'STORAGE_RESULT_UNKNOWN'});return {closed:false,code:'STORAGE_RESULT_UNKNOWN',file,operationIds:['pending-write']};}assert.fail('initialization must not advance after unconfirmed close');}};
 await assert.rejects(storage.initialize(root),{code:'STORAGE_RESULT_UNKNOWN'});
 assert.equal(await fs.readFile(path.join(temporary,'retained'),'utf8'),'original content');assert.deepEqual(JSON.parse(await fs.readFile(path.join(temporary,'initialization.json'),'utf8')),{operationId});
 assert.equal(await fs.access(path.join(root,'.nozeli')).then(()=>true,()=>false),false);assert.equal(calls.filter(call=>call.op==='close').length,1);assert.equal(calls.some(call=>['put','replace','delete'].includes(call.op)),false);
});

test('unconfirmed candidate close prevents initialization publication rename',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storage-close-publish-')),root=path.join(dir,'project');await fs.mkdir(root);
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const stat=await fs.stat(root),temporary=path.join(root,'.nozeli-init-owned'),operationId='publish-operation',id='project-id',intent={version:1,root,identity:{dev:String(stat.dev),ino:String(stat.ino)},id,instanceId:'instance-id',operationId,temporary,phase:'source-preserved',source:null};
 await fs.mkdir(temporary);await fs.writeFile(path.join(temporary,'project.json'),JSON.stringify({schema:1,projectId:id,operationId}));await fs.writeFile(path.join(temporary,'project.sqlite'),'retained database bytes');
 const storage=new ProjectStorage(path.join(dir,'profile')),mutations=[];storage.ready=async()=>{};
 storage.db={request:async(file,op,args)=>{if(op==='list'&&args.collection==='instances')return [];if(op==='get'&&args.collection==='initializations')return intent;if(op==='get'&&args.collection==='identity')return {schema:1,projectId:id};if(op==='close')return {closed:false,code:'STORAGE_RESULT_UNKNOWN',file,operationIds:[]};mutations.push({file,op,args});assert.fail('publication must not advance after unconfirmed close');}};
 await assert.rejects(storage.initialize(root),{code:'STORAGE_RESULT_UNKNOWN',file:path.join(temporary,'project.sqlite')});
 assert.equal(await fs.readFile(path.join(temporary,'project.sqlite'),'utf8'),'retained database bytes');assert.equal(await fs.access(path.join(root,'.nozeli')).then(()=>true,()=>false),false);assert.deepEqual(mutations,[]);
});

for(const method of ['closeLocalHandles','closeProjectHandles'])test(`${method} rejects an unconfirmed close instead of authorizing lifecycle cleanup`,async()=>{
 const storage=new ProjectStorage('/controlled/profile'),project={id:'p',instanceId:'instance',metadataRoot:'/controlled/project/.nozeli'},files=[];storage.ready=async()=>{};storage.bindings.set(project.id,project);
 storage.db={request:async(file,op)=>{assert.equal(op,'close');files.push(file);return {closed:false,code:'STORAGE_RESULT_UNKNOWN',file,operationIds:['pending']};}};
 await assert.rejects(storage[method](project.id),error=>error.code==='STORAGE_RESULT_UNKNOWN'&&error.commitUnknown.file===files[0]&&error.operationIds[0]==='pending');
 assert.equal(files.length,1);assert.equal(files[0],method==='closeLocalHandles'?path.join(storage.root,'instances',project.instanceId,'ui.sqlite'):path.join(project.metadataRoot,'project.sqlite'));
});

test('unconfirmed preservation-copy close prevents deleting the retained backup on retry',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storage-close-backup-')),root=path.join(dir,'project');await fs.mkdir(root);t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const stat=await fs.stat(root),storage=new ProjectStorage(path.join(dir,'profile')),temporary=path.join(root,'.nozeli-init-owned'),swap=path.join(root,'.nozeli-source-owned'),backup=path.join(storage.root,'initialization','owned','source'),operationId='owned',id='new-project',sourceId='source-project';
 for(const [directory,projectId]of [[temporary,id],[swap,sourceId]]){await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'project.json'),JSON.stringify({schema:1,projectId,operationId}));await fs.writeFile(path.join(directory,'project.sqlite'),'retained database bytes');}
 await fs.mkdir(backup,{recursive:true});await fs.writeFile(path.join(backup,'retained'),'original preserved source');
 const intent={version:1,root,identity:{dev:String(stat.dev),ino:String(stat.ino)},id,instanceId:'instance',operationId,temporary,swap,backup,phase:'staged',source:{projectId:sourceId}},closeFiles=[];storage.ready=async()=>{};
 storage.db={request:async(file,op,args)=>{if(op==='list'&&args.collection==='instances')return [];if(op==='get'&&args.collection==='initializations')return intent;if(op==='get'&&args.collection==='identity')return {schema:1,projectId:path.dirname(file)===temporary?id:sourceId};if(op==='close'){closeFiles.push(file);if(file===path.join(backup,'project.sqlite'))return {closed:false,code:'STORAGE_RESULT_UNKNOWN',file,operationIds:['copy-in-flight']};return;}assert.fail('preservation must not advance after unconfirmed backup close');}};
 await assert.rejects(storage.initialize(root),{code:'STORAGE_RESULT_UNKNOWN',file:path.join(backup,'project.sqlite')});
 assert.equal(await fs.readFile(path.join(backup,'retained'),'utf8'),'original preserved source');assert.equal(await fs.readFile(path.join(swap,'project.sqlite'),'utf8'),'retained database bytes');assert.deepEqual(closeFiles,[path.join(temporary,'project.sqlite'),path.join(swap,'project.sqlite'),path.join(backup,'project.sqlite')]);
});

test('sequential replace compares nested undefined, array holes and dates using persisted JSON semantics',async t=>{
 const {storage,file}=await receiptFixture(t),date=new Date('2026-10-24T12:34:56.000Z'),value={nested:{kept:'original',omitted:undefined,date},array:[undefined,{kept:1,omitted:undefined},date],sparse:[,2]},baseline={x:[{id:'record',value}]};
 await storage.request(file,'replace',{collections:baseline,operationId:'json-seed'});
 const persisted=JSON.parse(JSON.stringify(value));assert.deepEqual(await storage.request(file,'get',{collection:'x',id:'record'}),persisted);
 const next={...value,status:'next'},nextCollections={x:[{id:'record',value:next}]};
 assert.deepEqual(await storage.request(file,'replace',{collections:nextCollections,expectedCollections:baseline,operationId:'raw-json-baseline'}),{committed:true});
 const differentValues=[{...next,nested:{...next.nested,kept:'different'}},{...next,nested:{...next.nested,date:new Date('2026-10-25T12:34:56.000Z')}},{...next,array:['different',...next.array.slice(1)]}];
 for(const [index,different]of differentValues.entries()){
  const operationId='json-conflict-'+index;
  await assert.rejects(storage.request(file,'replace',{collections:{x:[]},expectedCollections:{x:[{id:'record',value:different}]},operationId}),{code:'STORAGE_CONFLICT'});
  assert.deepEqual(await storage.request(file,'get',{collection:'x',id:'record'}),JSON.parse(JSON.stringify(next)));assert.equal(await storage.request(file,'receipt',{operationId}),null);
 }
 const equivalent={x:[{id:'record',value:{status:'next',sparse:[null,2],array:[null,{kept:1},date.toISOString()],nested:{date:date.toISOString(),kept:'original'}}}]},finalCollections={x:[{id:'record',value:{finished:true}}]};
 assert.deepEqual(await storage.request(file,'replace',{collections:finalCollections,expectedCollections:equivalent,operationId:'persisted-json-baseline'}),{committed:true});
 assert.deepEqual(await storage.request(file,'get',{collection:'x',id:'record'}),{finished:true});
});

test('retry on a healthy live worker is an idempotent no-op that keeps the generation usable',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storage-healthy-retry-')),root=path.join(dir,'project');await fs.mkdir(root);
 const storage=new ProjectStorage(path.join(dir,'profile'));
 t.after(async()=>{await storage.db.close();await fs.rm(dir,{recursive:true,force:true});});
 const project=await storage.register(root),file=path.join(project.metadataRoot,'project.sqlite');
 assert.deepEqual(await storage.putProject(project.id,'x','before','original'),{revision:1});
 const channel=storage.db.channels.get(file);
 assert.ok(channel);assert.equal(channel.pending.size,0);assert.equal(channel.exited,false);assert.equal(storage.db.quarantined.has(file),false);
 assert.deepEqual(await storage.db.recover(file),{recovered:false,operations:[]});
 for(let attempt=0;attempt<3;attempt++)assert.deepEqual(await storage.retry(project.id),{available:true,projectId:project.id,operations:[]});
 assert.equal(storage.db.channels.get(file),channel,'repeated retry must not disturb the healthy live worker');
 assert.equal(storage.db.quarantined.has(file),false);
 assert.equal(await storage.getProject(project.id,'x','before'),'original');
 assert.deepEqual(await storage.putProject(project.id,'x','before','written after retry'),{revision:2});
 assert.equal(await storage.getProject(project.id,'x','before'),'written after retry');
});

test('retry after a real quarantine still requires the faulted generation to exit and reconciles receipts',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storage-quarantined-retry-')),root=path.join(dir,'project');await fs.mkdir(root);
 const storage=new ProjectStorage(path.join(dir,'profile'));
 t.after(async()=>{await storage.db.close();await fs.rm(dir,{recursive:true,force:true});});
 const project=await storage.register(root),file=path.join(project.metadataRoot,'project.sqlite');
 assert.deepEqual(await storage.putProject(project.id,'x','before','original'),{revision:1});
 const healthyTimeout=storage.db.timeoutMs;storage.db.timeoutMs=30;
 const lock=new DatabaseSync(file);lock.exec('BEGIN EXCLUSIVE');
 let failure;try{await storage.db.request(file,'put',{collection:'x',id:'after',value:'unknown',operationId:'blocked-operation'});}catch(error){failure=error;}
 const held=storage.db.channels.get(file);
 assert.equal(failure.code,'STORAGE_RESULT_UNKNOWN');assert.equal(failure.operationId,'blocked-operation');
 assert.equal(storage.db.quarantined.has(file),true);assert.ok(held,'the faulted generation stays fenced while alive');
 const exited=new Promise(resolve=>held.worker.once('exit',resolve));
 await assert.rejects(storage.db.recover(file),/尚未退出/);
 await exited;lock.exec('ROLLBACK');lock.close();
 assert.equal(storage.db.channels.has(file),false);
 storage.db.timeoutMs=healthyTimeout;
 const outcome=await storage.retry(project.id);
 assert.deepEqual(outcome,{available:true,projectId:project.id,operations:[{operationId:'blocked-operation',receipt:null}]});
 assert.equal(storage.db.quarantined.has(file),false);
 assert.equal(await storage.getProject(project.id,'x','before'),'original');
 assert.equal(await storage.getProject(project.id,'x','after'),null);
 assert.deepEqual(await storage.putProject(project.id,'x','after','written after recovery',{operationId:'post-recovery'}),{revision:1});
 assert.equal(await storage.getProject(project.id,'x','after'),'written after recovery');
 assert.deepEqual(await storage.retry(project.id),{available:true,projectId:project.id,operations:[]});
});
