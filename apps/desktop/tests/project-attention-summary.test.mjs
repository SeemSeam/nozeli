import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopHost} from '../src/main/host.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {managedInboxTodos} from '../src/domain/managed-work-records.mjs';

const empty=()=>({schema:2,reportStateVersion:1,works:[],jobs:[],todos:[],receipts:[]});
const forbidden=()=>{throw Error('Summary crossed a mutation/process boundary');};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'project-attention-summary-'));
 const host=new DesktopHost(path.join(root,'profile'));
 const dir=path.join(root,'project');await fs.mkdir(dir);
 const project=await host.storage.register(dir);
 const manager=Object.assign(Object.create(ManagedProjects.prototype),{host,controllers:new Map(),attention:{read:forbidden,observe:forbidden,acknowledge:forbidden},openController:forbidden,connect:forbidden,loadLocal:forbidden,projectionSource:forbidden,attentionState:forbidden});
 t.after(async()=>{await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 const read=async ids=>(await manager.projectAttentionSummary({projectIds:ids??[project.id]})).projects;
 const persist=async state=>{
  const keys=['works','jobs','todos','receipts'];
  const collections={managed_settings:[{id:'schema',value:2},{id:'reportStateVersion',value:1},{id:'collections',value:keys},{id:'collectionOrder',value:Object.fromEntries(keys.map(key=>[key,state[key].map(row=>row.id)]))}]};
  for(const key of keys)collections['managed_'+key]=state[key].map(row=>({id:row.id,value:row}));
  await host.storage.replaceProjectCollections(project.id,collections);
 };
 return {root,dir,host,project,manager,read,persist};
}
function publicationState(){
 const state=empty();
 state.works=[{id:'current',status:'review',revision:2,result:{objectId:'new',revision:2}},{id:'ended',status:'ended',revision:1,result:{objectId:'final',revision:1},closure:{phase:'complete'}},{id:'running',status:'review',revision:1,result:{objectId:'busy',revision:1}}];
 state.jobs=[{id:'busy-job',target:'running',status:'queued',revision:1}];
 state.todos=[
  {id:'new',kind:'result',workId:'current',revision:2,objectId:'new',status:'open'},
  {id:'old',kind:'result',workId:'current',revision:1,objectId:'old',status:'open',reopenedAt:'2026-01-01'},
  {id:'ended',kind:'result',workId:'ended',revision:1,objectId:'final',status:'open'},
  {id:'busy',kind:'result',workId:'running',revision:1,objectId:'busy',status:'open'},
  {id:'backstage',kind:'problem',status:'open'},
  {id:'explicit-hidden',kind:'result',status:'open',userActionable:false},
  {id:'closed',kind:'merge-consent',permissionPurpose:'never-commit-override',status:'closed'},
  {id:'merge',kind:'merge-consent',permissionPurpose:'merge-conflict-override',status:'open'}
 ];
 return state;
}
test('never-initialized registered project is a complete true zero; invalid batch fails before reading',async t=>{
 const {read,manager,project}=await fixture(t);
 const [row]=await read();
 assert.equal(row.projectId,project.id);assert.equal(row.instanceId,project.instanceId);
 assert.equal(row.pendingCount,0);assert.equal(row.complete,true);assert.equal(row.freshness,'live');
 assert.match(row.revision,/^[a-f0-9]{64}$/);assert.equal(new Date(row.observedAt).toISOString(),row.observedAt);
 assert.deepEqual(await manager.projectAttentionSummary({projectIds:[]}),{projects:[]});
 for(const payload of [null,{}, {projectIds:'x'},{projectIds:[' x']},{projectIds:Array(101).fill(project.id)}])await assert.rejects(manager.projectAttentionSummary(payload),{code:'INVALID_PAYLOAD'});
});
test('persisted and active projections match the right inbox, replacing embedded attention copies',async t=>{
 const {host,project,manager,read,persist}=await fixture(t),state=publicationState();
 await persist(state);
 const attention=[{id:'approve',origin:'instance-attention',kind:'attention',status:'open',destination:{kind:'conversation',question:{method:'approve'}}},{id:'ask',origin:'instance-attention',kind:'attention',status:'open',destination:{kind:'conversation',question:{method:'askDialog'}}},{id:'effect',origin:'instance-attention',kind:'attention',status:'open',destination:{kind:'effect-permission'}},{id:'lost',origin:'instance-attention',kind:'attention',status:'open',interrupted:true,destination:{kind:'connection'}}];
 await host.storage.putLocal(project.id,'managed:attention',{todos:attention,active:{},notified:['approve']});
 const expected=managedInboxTodos({...state,todos:[...state.todos,...attention]}).filter(todo=>todo.pending).length;
 assert.equal(expected,4);
 const [inactive]=await read();assert.equal(inactive.pendingCount,expected);
 state.todos.push({id:'stale-ledger-copy',origin:'instance-attention',kind:'result',status:'open'});
 manager.controllers.set(project.id,{snapshot:()=>state,processBackstage:forbidden,start:forbidden,kick:forbidden});
 const [active]=await read();assert.equal(active.pendingCount,expected);assert.equal(active.revision,inactive.revision);
 state.jobs=[];
 const [changed]=await read();assert.equal(changed.pendingCount,expected+1);assert.notEqual(changed.revision,active.revision);
});
test('summary reads never write, initialize local directories, observe, connect, or spawn an owner',async t=>{
 const {host,project,read,manager}=await fixture(t),storage=host.storage;
 for(const method of ['putLocal','putRecovery','putProject','replaceProjectCollections','localDirectory','getLocal','getRecovery','requireOnline'])storage[method]=forbidden;
 const request=storage.db.request.bind(storage.db),ops=[];
 storage.db.request=async(file,op,args)=>{ops.push(op);assert(['get','list','boundedRecord'].includes(op));if(op==='list')assert.equal(args.mustExist,true);return request(file,op,args);};
 const [row]=await read();assert.equal(row.complete,true);assert.equal(row.pendingCount,0);
 assert.equal(manager.controllers.size,0);assert.equal(ops.length,0,'read-only SQLite handles bypass worker schema initialization');
 const local=path.join(storage.root,'instances',project.instanceId);
 await assert.rejects(fs.stat(local),{code:'ENOENT'});
});
test('directory loss is unknown, does not invalidate or stop owners, and recovers on a fresh read',async t=>{
 const {dir,read,host}=await fixture(t);
 const [before]=await read();assert.equal(before.pendingCount,0);
 host.storage.onUnavailable=forbidden;
 await fs.rename(dir,dir+'-away');
 const [missing]=await read();assert.equal(missing.complete,false);assert.equal(missing.pendingCount,null);assert.equal(missing.freshness,'unknown');
 assert.equal(host.storage.unavailable.size,0);
 await fs.rename(dir+'-away',dir);
 const [restored]=await read();assert.equal(restored.complete,true);assert.equal(restored.pendingCount,0);
});
test('malformed ledger, partial business manifest and orphaned rows cannot masquerade as zero',async t=>{
 const {read,host,project,persist}=await fixture(t);
 await host.storage.putLocal(project.id,'managed:attention',{todos:null});
 assert.equal((await read())[0].pendingCount,null);
 await host.storage.putLocal(project.id,'managed:attention',{todos:[]});
 await host.storage.replaceProjectCollections(project.id,{managed_settings:[{id:'schema',value:2}]});
 assert.equal((await read())[0].complete,false);
 await host.storage.replaceProjectCollections(project.id,{managed_settings:[],managed_todos:[{id:'orphan',value:{id:'orphan',kind:'result',status:'open'}}]});
 assert.equal((await read())[0].pendingCount,null);
 await persist(empty());assert.equal((await read())[0].pendingCount,0);
});
test('one failed project never consumes a healthy sibling, and duplicate requests are merged',async t=>{
 const {read,project}=await fixture(t);
 const rows=await read(['not-registered',project.id,project.id]);
 assert.equal(rows.length,2);assert.equal(rows[0].projectId,'not-registered');assert.equal(rows[0].instanceId,null);assert.equal(rows[0].pendingCount,null);assert.equal(rows[1].pendingCount,0);
});
test('a changed active snapshot, ledger, instance, controller or project generation is rejected',async t=>{
 for(const change of ['snapshot','ledger','instance','controller','generation']){
  const {host,project,manager,read}=await fixture(t),storage=host.storage,state=empty();
  const controller={snapshot:()=>state};manager.controllers.set(project.id,controller);
  const registered=storage.requireRegistered.bind(storage);let calls=0;
  storage.requireRegistered=async(...args)=>{
   const value=await registered(...args);
   if(++calls===2){
    if(change==='snapshot')state.todos.push({id:'new',kind:'result',status:'open'});
    if(change==='instance')storage.bindings.set(project.id,{...project,instanceId:'replacement'});
    if(change==='controller')manager.controllers.set(project.id,{snapshot:()=>state});
    if(change==='generation')storage.generations.set(project.id,1);
   }
   if(change==='ledger'&&calls===3)await storage.putLocal(project.id,'managed:attention',{todos:[{id:'new',kind:'result',status:'open'}]});
   return value;
  };
  const [row]=await read();assert.equal(row.complete,false,change);assert.equal(row.pendingCount,null,change);
 }
});
test('strict batch payload rejects unrelated scope identities and duplicate live todo IDs count once',async t=>{
 const {manager,project,read}=await fixture(t);
 for(const payload of [Object.assign([],{projectIds:[]}),{projectIds:[],projectId:project.id},{projectIds:[],extra:true}])await assert.rejects(manager.projectAttentionSummary(payload),{code:'INVALID_PAYLOAD'});
 const state=empty(),todo={id:'same',kind:'result',status:'open'};state.todos=[todo,{...todo}];
 manager.controllers.set(project.id,{snapshot:()=>state});
 assert.equal((await read())[0].pendingCount,1);
});
test('repeated summaries leave SQLite bytes and reminder acknowledgement state unchanged',async t=>{
 const {host,project,read,persist}=await fixture(t);
 await persist(publicationState());
 const attention={todos:[{id:'permission',kind:'attention',origin:'instance-attention',status:'open',destination:{kind:'effect-permission'}}],active:{'permission:test':'permission'},notified:['permission']};
 await host.storage.putLocal(project.id,'managed:attention',attention);
 const files=[host.storage.catalog,path.join(project.metadataRoot,'project.sqlite'),path.join(host.storage.root,'instances',project.instanceId,'ui.sqlite')];
 const before=await Promise.all(files.map(file=>fs.readFile(file)));
 const [first]=await read(),[second]=await read();
 assert.equal(first.complete,true);assert.equal(first.revision,second.revision);
 for(const [index,file] of files.entries())assert.deepEqual(await fs.readFile(file),before[index],file);
 assert.deepEqual(await host.storage.getLocal(project.id,'managed:attention'),attention);
});
