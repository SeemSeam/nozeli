import {openTestWorkspace} from './project-storage.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {manageTodoState,reconcileTodos,todoCapabilities} from '../src/domain/todo-management.mjs';
import {reportDescriptor} from '../src/agents/managed/report-descriptor.mjs';
import {staticReport} from './static-report.fixture.mjs';
import {readManagedState} from '../src/agents/managed/managed-storage.mjs';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-todo-management-'));
 const runtime=path.join(root,'runtime'),content=path.join(root,'content');
 let store=await openTestWorkspace(runtime,content);
 t.after(async()=>{await store.close();await fs.rm(root,{recursive:true,force:true});});
 return {root,get store(){return store;},async restart(){await store.close();store=await openTestWorkspace(runtime,content);return store;},
  async seed(todos,works=[]){await store.mutate(()=>{store.state.todos.push(...structuredClone(todos));store.state.works.push(...structuredClone(works));});},
  manage(payload){return store.mutate(()=>manageTodoState(store.state,payload));},
  todo(id='todo'){return store.state.todos.find(todo=>todo.id===id);}};
}
const request=(action,expectedRevision=0,extra={})=>({action,todoId:'todo',expectedRevision,requestKey:`request-${action}-${expectedRevision}`,projectId:'project-a',...extra});
const reminder=(extra={})=>({id:'todo',kind:'system',sourceJobId:'event-a',status:'open',text:'Private reminder body',...extra});
const rejectsCode=(promise,code)=>assert.rejects(promise,error=>error.code===code);

test('close and reopen are durable local reminders with idempotent receipts and no source mutations',async t=>{
 const f=await fixture(t);
 await f.seed([reminder({workId:'work'})],[{id:'work',status:'paused',revision:3}]);
 const reportBytes=Buffer.from(staticReport('report body'));await f.store.putObject(reportBytes);
 await f.store.mutate(()=>{const objectId='00000000-0000-4000-8000-000000000001';Object.assign(f.store.state,{messages:[{id:'message',text:'source body'}],receipts:[{id:'receipt',objectId,report:reportDescriptor(reportBytes,{format:'html-static',objectId})}],jobs:[{id:'event-a',status:'failed'}],gitIntents:[{id:'intent',status:'uncertain'}]});});
 const source=structuredClone({works:f.store.state.works,messages:f.store.state.messages,receipts:f.store.state.receipts,jobs:f.store.state.jobs,gitIntents:f.store.state.gitIntents});
 const close=request('close',0,{reason:'Handled offline'}),receipt=await f.manage(close);
 assert.equal(receipt.managementRevision,1);assert.equal(f.todo().status,'closed');assert.equal(f.todo().closedBy,'user:local');assert.equal(f.todo().reason,'Handled offline');assert(f.todo().closedAt);assert(f.todo().settledAt);
 const closed=structuredClone(f.todo());await f.restart();assert.deepEqual(f.todo(),closed);
 assert.deepEqual(await f.manage(close),receipt);assert.deepEqual(f.todo(),closed);assert.equal(f.todo().managementHistory.length,1);
 const reopen=request('reopen',1);await f.manage(reopen);assert.equal(f.todo().status,'open');assert.equal(f.todo().managementRevision,2);assert.equal(f.todo().settledAt,undefined);assert.equal(f.todo().closedAt,undefined);assert.equal(f.todo().managementHistory.length,2);
 await f.restart();assert.equal(f.todo().status,'open');assert.equal(f.todo().managementRevision,2);
 for(const [key,value] of Object.entries(source))assert.deepEqual(f.store.state[key],value,key);
});

test('remove erases only private reminder content, action ledgers and history; minimal retry survives restart',async t=>{
 const f=await fixture(t);await f.seed([reminder({workId:'work'})],[{id:'work',status:'ended',closureHistory:[{reviewTodoId:'unrelated',text:'source history'}]}]);
 await f.manage(request('close',0,{reason:'Private closure reason'}));
 await f.store.mutate(()=>{f.store.state.todoActions=[{requestKey:'old-private',identity:JSON.stringify(['project-a','git','todo','work']),result:{text:'Private recovery result'}},{requestKey:'keep',identity:JSON.stringify(['project-a','git','other','work'])}];f.store.state.messages=[{id:'message',text:'Keep original message'}];});
 const works=structuredClone(f.store.state.works),messages=structuredClone(f.store.state.messages);
 const remove=request('remove',1,{reason:'Private deletion reason'}),receipt=await f.manage(remove);
 assert.equal(f.todo(),undefined);assert.deepEqual(f.store.state.todoManagementActions,[]);assert.equal(f.store.state.todoActions.length,1);assert.equal(f.store.state.todoActions[0].requestKey,'keep');
 const tombstone=f.store.state.todoTombstones[0];assert.deepEqual(Object.keys(tombstone).sort(),['todoId','sourceIdentity','removedAt','projectId','expectedRevision','requestKey'].sort());
 const saved=await readManagedState(f.store.storage,f.store.projectId,{offline:false});const bytes=JSON.stringify(saved);for(const secret of ['Private reminder body','Private closure reason','Private deletion reason','Private recovery result','old-private'])assert.equal(bytes.includes(secret),false,secret);
 await f.restart();assert.deepEqual(await f.manage(remove),receipt);assert.equal(f.store.state.todoTombstones.length,1);assert.deepEqual(f.store.state.works,works);assert.deepEqual(f.store.state.messages,messages);
});

test('tombstones suppress exact IDs and new-ID same-source replay but allow independent machine events',async t=>{
 const f=await fixture(t);await f.seed([reminder({revision:1})]);await f.manage(request('close'));await f.manage(request('remove',1));await f.restart();
 await f.store.mutate(()=>{f.store.state.todos.push(reminder({sourceJobId:'different-source'}),reminder({id:'replayed'}),reminder({id:'same-source-replayed',revision:1}),reminder({id:'new-revision',revision:2}),reminder({id:'new-event',sourceJobId:'event-b',revision:1}),reminder({id:'independent',kind:'git',revision:1}));});
 assert.deepEqual(f.store.state.todos.map(todo=>todo.id),['replayed','new-revision','new-event','independent']);
 // A missing revision is a different source identity, not inferred from matching text.
 assert.equal(f.todo('replayed').revision,undefined);await f.restart();assert.equal(f.store.state.todos.length,4);
});

test('closed historical records survive producer replacement and suppress same-source replay',async t=>{
 const f=await fixture(t);await f.seed([reminder()]);await f.manage(request('close'));const old=structuredClone(f.todo());
 await f.store.mutate(()=>{f.store.state.todos=[reminder({id:'new-id'})];});
 assert.deepEqual(f.store.state.todos,[old]);
 await f.store.mutate(()=>{f.store.state.todos.push(reminder({id:'new-job',sourceJobId:'event-b'}));});assert(f.todo('new-job'));
});

test('live duties and queue entries are protected; anomaly close does not authorize live deletion',async t=>{
 const f=await fixture(t);await f.seed(['result','problem','routing','queue'].map(kind=>reminder({id:kind,kind,workId:'live'})),[{id:'live',status:'review'}]);
 for(const kind of ['result','problem','routing','queue'])await rejectsCode(f.manage(request('close',0,{todoId:kind,requestKey:'close-'+kind})),'TODO_BLOCKED');
 await f.seed([reminder({id:'review',kind:'recovery',workId:'live',origin:'closure-review'}),reminder({id:'legacy-review',kind:'recovery',workId:'live'}),reminder({id:'anomaly',workId:'live'})]);
 await f.store.mutate(()=>{f.store.state.works[0].closureHistory=[{reviewTodoId:'legacy-review'}];});
 for(const todoId of ['review','legacy-review'])await rejectsCode(f.manage(request('close',0,{todoId,requestKey:'close-'+todoId})),'TODO_BLOCKED');
 await f.manage(request('close',0,{todoId:'anomaly'}));await rejectsCode(f.manage(request('remove',1,{todoId:'anomaly'})),'TODO_BLOCKED');
 await f.store.mutate(()=>{f.store.state.works[0].status='ended';});await f.manage(request('remove',1,{todoId:'anomaly'}));assert.equal(f.todo('anomaly'),undefined);
});

test('old publication reminders can close for ended or missing Work without business completion',async t=>{
 const f=await fixture(t);await f.seed([reminder({kind:'result',workId:'ended'}),reminder({id:'orphan',kind:'problem',workId:'missing'})],[{id:'ended',status:'ended',revision:2}]);
 const work=structuredClone(f.store.state.works);await f.manage(request('close'));await f.manage(request('close',0,{todoId:'orphan',requestKey:'orphan-close'}));assert.deepEqual(f.store.state.works,work);
 assert.equal(f.todo().status,'closed');assert.equal(f.todo('orphan').status,'closed');
});

test('source-bound routing reminders cannot bypass protection by omitting workId',async t=>{
 const f=await fixture(t);await f.seed([reminder({kind:'routing',sourceJobId:'routing-job',status:'resolved'})],[{id:'live',status:'running'}]);
 await f.store.mutate(()=>{f.store.state.jobs=[{id:'routing-job',context:{boundWorkId:'live'}}];});
 assert.equal(todoCapabilities(f.store.state,f.todo()).remove,false);await rejectsCode(f.manage(request('remove')),'TODO_BLOCKED');
 const work=structuredClone(f.store.state.works);await f.manage(request('reopen'));assert.deepEqual(f.store.state.works,work);assert.equal(f.todo().status,'open');
});

test('stale versions, request collisions, missing IDs and malformed requests mutate nothing',async t=>{
 const f=await fixture(t);await f.seed([reminder()]);await f.manage(request('close'));const before=structuredClone(f.store.state);
 await rejectsCode(f.manage(request('reopen',0)),'STALE_TODO');
 await rejectsCode(f.manage(request('reopen',1,{requestKey:'request-close-0'})),'REQUEST_KEY_COLLISION');
 await rejectsCode(f.manage(request('close',0,{todoId:'missing'})),'REQUEST_KEY_COLLISION');
 await rejectsCode(f.manage(request('close',0,{todoId:'missing',requestKey:'missing-key'})),'TODO_MISSING');
 for(const extra of [{expectedRevision:-1},{expectedRevision:'1'},{projectId:''},{todoId:null},{requestKey:''},{reason:{}}])await rejectsCode(f.manage(request('reopen',1,extra)),'INVALID_TODO_MANAGEMENT');
 assert.deepEqual(f.store.state,before);
});

test('serialized competing operations accept one version and preserve exact-key retry',async t=>{
 const f=await fixture(t);await f.seed([reminder()]);
 const outcomes=await Promise.allSettled([f.manage(request('close',0,{requestKey:'race-key-a'})),f.manage(request('close',0,{requestKey:'race-key-b'}))]);
 assert.equal(outcomes[0].status,'fulfilled');assert.equal(outcomes[1].status,'rejected');assert.equal(outcomes[1].reason.code,'STALE_TODO');
 const receipt=outcomes[0].value;assert.deepEqual(await f.manage(request('close',0,{requestKey:'race-key-a'})),receipt);assert.equal(f.todo().managementHistory.length,1);assert.equal(f.todo().managementRevision,1);
});

test('write failures roll back close and remove, including ledgers and tombstones',async t=>{
 const f=await fixture(t);await f.seed([reminder()]);await f.restart();
 for(const [action,revision] of [['close',0],['remove',1]]){
  const storage=f.store.storage,replace=storage.replaceProjectCollections.bind(storage),before=structuredClone(f.store.state),durable=await readManagedState(storage,f.store.projectId,{offline:false});
  storage.replaceProjectCollections=async()=>{throw Object.assign(new Error('injected transaction rejection'),{code:'EINJECTED_COMMIT'});};
  try{await assert.rejects(f.manage(request(action,revision)),{code:'EINJECTED_COMMIT'});}finally{storage.replaceProjectCollections=replace;}
  assert.deepEqual(f.store.state,before);assert.deepEqual(await readManagedState(storage,f.store.projectId,{offline:false}),durable);
  const pending=(await f.store.listPending()).find(row=>row.kind==='business'&&row.error?.code==='EINJECTED_COMMIT');assert(pending);assert.equal(pending.automaticReplay,false);assert.equal(pending.requiresConfirmation,true);
  await f.restart();for(const key of ['todos','todoManagementActions','todoTombstones','todoActions','todoManagementHistory','todoHistory','works','jobs','messages','receipts'])assert.deepEqual(f.store.state[key]??[],before[key]??[],`${key} must survive rejected ${action} unchanged across recovery`);await f.manage(request(action,revision));
 }
 await f.restart();assert.equal(f.todo(),undefined);assert.equal(f.store.state.todoTombstones.length,1);
});

test('separate project stores with identical todo and request IDs stay independent',async t=>{
 const a=await fixture(t),b=await fixture(t);await a.seed([reminder()]);await b.seed([reminder()]);
 await a.manage(request('close'));assert.equal(b.todo().status,'open');await b.manage(request('close',0,{projectId:'project-b'}));await a.manage(request('remove',1));
 await a.restart();await b.restart();assert.equal(a.todo(),undefined);assert.equal(b.todo().status,'closed');assert.equal(b.store.state.todoTombstones,undefined);
 await rejectsCode(b.manage(request('close')),'REQUEST_KEY_COLLISION');
});

test('reconciliation revisions track semantic changes, not timestamps or unrelated mutations; legacy defaults are zero',()=>{
 const legacy={todos:[reminder()],works:[]},state=structuredClone(legacy);reconcileTodos(state,legacy);
 assert.equal(state.todos[0].managementRevision,0);assert.equal(state.todos[0].createdAt,undefined);assert.equal(state.todos[0].updatedAt,undefined);assert.equal(state.todos[0].settledAt,undefined);
 let previous=structuredClone(state);state.works.push({id:'unrelated',status:'ended'});reconcileTodos(state,previous);assert.deepEqual(state.todos,previous.todos);
 previous=structuredClone(state);state.todos[0].text='Changed content';reconcileTodos(state,previous);assert.equal(state.todos[0].managementRevision,1);
 previous=structuredClone(state);state.todos[0].status='resolved';reconcileTodos(state,previous);assert.equal(state.todos[0].managementRevision,2);assert(state.todos[0].settledAt);
 const bare={todos:[reminder({status:'resolved'})]};assert.equal(manageTodoState(bare,request('reopen')).managementRevision,1);assert.equal(bare.todos[0].status,'open');
});

test('every stable source dimension distinguishes independent persisted events, never their text',async t=>{
 const f=await fixture(t),source=reminder({workId:'work',revision:1,gitIntentId:'intent',objectId:'object',reviewCycle:'cycle',closureHistoryId:'history'});
 await f.seed([source],[{id:'work',status:'ended'}]);await f.manage(request('close'));await f.manage(request('remove',1));
 const fields=['kind','workId','revision','sourceJobId','gitIntentId','objectId','reviewCycle','closureHistoryId'];
 await f.store.mutate(()=>{
  f.store.state.todos.push({...source,id:'same-source',text:'Entirely different wording'});
  for(const key of fields)f.store.state.todos.push({...source,id:'new-'+key,[key]:key==='revision'?2:'different-'+key});
 });
 assert.deepEqual(f.store.state.todos.map(todo=>todo.id),fields.map(key=>'new-'+key));await f.restart();assert.equal(f.store.state.todos.length,fields.length);
});

test('source-less reminders use ID only, so equal text and kind do not suppress independent reminders',async t=>{
 const f=await fixture(t);await f.seed([{id:'todo',kind:'system',status:'closed',text:'Identical text'}]);await f.manage(request('remove'));
 await f.store.mutate(()=>{f.store.state.todos.push({id:'todo',kind:'system',status:'open',text:'Changed text'},{id:'independent',kind:'system',status:'open',text:'Identical text'});});
 assert.deepEqual(f.store.state.todos.map(todo=>todo.id),['independent']);await f.restart();assert.equal(f.todo('independent').text,'Identical text');
});

test('producer replay of the same ID cannot reopen a manually closed reminder, but explicit reopen persists its timestamp',async t=>{
 const f=await fixture(t);await f.seed([reminder({kind:'result',workId:'ended'})],[{id:'ended',status:'ended',revision:1}]);
 await f.manage(request('close'));const closed=structuredClone(f.todo());
 await f.store.mutate(()=>{f.store.state.todos=[reminder({kind:'result',workId:'ended'})];});assert.deepEqual(f.todo(),closed);
 await f.store.mutate(()=>{f.todo().status='open';});assert.deepEqual(f.todo(),closed);
 await f.restart();assert.deepEqual(f.todo(),closed);
 const works=structuredClone(f.store.state.works);const reopened=await f.manage(request('reopen',1));
 assert.equal(reopened.status,'open');assert(f.todo().reopenedAt);assert.equal(f.todo().managementRevision,2);assert.equal(f.todo().settledAt,undefined);assert.deepEqual(f.store.state.works,works);
 const timestamp=f.todo().reopenedAt;await f.restart();assert.equal(f.todo().reopenedAt,timestamp);await f.manage(request('reopen',1));assert.equal(f.todo().reopenedAt,timestamp);
 // An old reopen history entry is not authorization to undo a later manual close.
 await f.manage(request('close',2));const closedAgain=structuredClone(f.todo());await f.store.mutate(()=>{f.todo().status='open';});assert.deepEqual(f.todo(),closedAgain);
});

test('kind plus Work alone never identifies independent unknown faults',async t=>{
 const f=await fixture(t),unknown={id:'todo',kind:'recovery',workId:'work',status:'open',text:'Unknown fault'};
 await f.seed([unknown],[{id:'work',status:'ended'}]);await f.manage(request('close'));
 await f.store.mutate(()=>{f.store.state.todos.push({...unknown,id:'independent-before-remove'});});assert(f.todo('independent-before-remove'));
 await f.manage(request('remove',1));assert.deepEqual(f.store.state.todoTombstones[0].sourceIdentity,{id:'todo'});
 await f.store.mutate(()=>{f.store.state.todos.push({...unknown},{...unknown,id:'independent-after-remove'});});
 assert.deepEqual(f.store.state.todos.map(todo=>todo.id),['independent-before-remove','independent-after-remove']);await f.restart();assert.equal(f.store.state.todos.length,2);
});

test('indexed reconciliation preserves large settled histories and filters historical and removed event replay',()=>{
 const count=3000,old=Array.from({length:count},(_,i)=>reminder({id:'settled-'+i,sourceJobId:'event-'+i,status:'resolved',managementRevision:2}));
 const previous={todos:old},state={todos:[],todoTombstones:[]};
 for(let i=0;i<count;i++){
  state.todos.push(reminder({id:'replay-'+i,sourceJobId:'event-'+i}),reminder({id:'new-'+i,sourceJobId:'new-event-'+i}),reminder({id:'removed-'+i,sourceJobId:'removed-event-'+i}));
  state.todoTombstones.push({todoId:'removed-'+i,sourceIdentity:{kind:'system',sourceJobId:'removed-event-'+i}});
 }
 reconcileTodos(state,previous);assert.equal(state.todos.length,count*2);
 const byId=new Map(state.todos.map(todo=>[todo.id,todo]));
 for(let i=0;i<count;i++){assert.equal(byId.get('settled-'+i).managementRevision,2);assert.equal(byId.get('new-'+i).managementRevision,0);assert.equal(byId.has('replay-'+i),false);assert.equal(byId.has('removed-'+i),false);}
});

test('persisted tombstone identity matching canonicalizes key order after restart',async t=>{
 const f=await fixture(t);await f.seed([reminder({workId:'ended',revision:1,objectId:'object'})],[{id:'ended',status:'ended'}]);await f.manage(request('close'));await f.manage(request('remove',1));
 await f.store.mutate(()=>{
  const tombstone=f.store.state.todoTombstones[0];tombstone.sourceIdentity=Object.fromEntries(Object.entries(tombstone.sourceIdentity).reverse());
 });
 await f.restart();
 await f.store.mutate(()=>{f.store.state.todos.push(reminder({id:'replay',workId:'ended',revision:1,objectId:'object'}));});
 assert.deepEqual(f.store.state.todos,[]);
});

test('closed records bound to active Work expose a disabled remove capability with a reason',async t=>{
 const f=await fixture(t);await f.seed([reminder({status:'closed',workId:'active'})],[{id:'active',status:'paused'}]);
 const capability=todoCapabilities(f.store.state,f.todo());assert.equal(capability.remove,false);assert(capability.reason.trim());
 await rejectsCode(f.manage(request('remove')),'TODO_BLOCKED');assert.equal(f.todo().status,'closed');
});
