import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {managedReviewTodos,managedWorkRecords,userTodoEligible} from '../src/domain/managed-work-records.mjs';
import {createAttentionNotificationModel} from '../src/domain/attention-notifications.mjs';
import {AttentionLedger} from '../src/agents/managed/attention-ledger.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';

const permission={id:'approval',kind:'attention',status:'open',destination:{kind:'conversation',target:'frontdesk',ownerId:'original-owner',interactionId:'approval-1',question:{method:'approve'}}};

test('one projection admits only results and real approval requests across notifications',()=>{
 const kinds=['problem','routing','frontdesk-route','deviation','recovery','system','closure','git','merge-constraint'];
 const backstage=kinds.map(kind=>({id:kind,kind,status:'open'}));
 for(const method of ['select','input','ask','askDialog','confirm'])backstage.push({id:method,kind:'attention',status:'open',destination:{kind:'conversation',question:{method}}});
 for(const kind of ['connection','settings','native-draft','terminal'])backstage.push({id:kind,kind:'attention',status:'open',destination:{kind}});
 const result={id:'result',kind:'result',status:'open'},effect={id:'effect',kind:'attention',status:'open',destination:{kind:'effect-permission'}};
 const state={todos:[...backstage,result,permission,effect]};
 assert.deepEqual(managedReviewTodos(state).map(t=>t.id),['result','approval','effect']);
 const model=createAttentionNotificationModel();
 assert.deepEqual(model.applyManagedState('p',state).added.map(r=>r.todoId),['result','approval','effect']);
 assert.deepEqual(model.applyManagedState('p',{todos:backstage}).resolvedFeedback,[]);
 assert.equal(userTodoEligible({kind:'merge-consent',permissionPurpose:'never-commit-override'}),true);
 assert.equal(userTodoEligible({kind:'merge-consent',permissionPurpose:'merge-conflict-override'}),true);
 assert.equal(userTodoEligible({kind:'merge-consent'}),false);
 assert.equal(userTodoEligible({kind:'attention',destination:{kind:'effect-grant'}}),false);
 assert.equal(backstage.every(t=>!userTodoEligible(t)),true);
});

test('backstage native ledger persists one neutral record without duplicate reminders',async()=>{
 const saved=new Map(),storage={getLocal:async(p,k)=>saved.get(p+':'+k),putLocal:async(p,k,v)=>saved.set(p+':'+k,structuredClone(v))};
 const ledger=new AttentionLedger(storage),fact={key:'owner:question',title:'Missing external fact',destination:{kind:'conversation',ownerId:'owner',interactionId:'question',question:{method:'input'}}};
 await ledger.observe('p','native',[fact]);await ledger.observe('p','native',[fact]);
 const state=await ledger.read('p');assert.equal(state.todos.length,1);assert.equal(state.todos[0].backstageStatus,'blocked');assert.equal(state.todos[0].userActionable,false);
 assert.deepEqual(managedReviewTodos(state),[]);assert.deepEqual(createAttentionNotificationModel().applyManagedState('p',state).added,[]);
});

test('attention refresh invokes actual controller backstage processing before taking its snapshot',async()=>{
 const calls=[],manager=Object.create(ManagedProjects.prototype),initial={todos:[],agents:[]},processed={...initial,works:[{id:'original',status:'paused'}]};
 manager.controllers=new Map([['p',{processBackstage:async()=>calls.push('process-original'),snapshot:()=>{calls.push('snapshot');return processed;}}]]);
 manager.attention={observe:async()=>{},read:async()=>({todos:[],notified:[]})};manager.permissions={read:async()=>({})};
 const state=await manager.attentionState('p',initial,{connected:true});assert.deepEqual(calls,['process-original','snapshot']);assert.equal(state.works[0].id,'original');
});

test('ordinary native questions cannot be submitted through the human authorization endpoint',async()=>{
 const manager=Object.create(ManagedProjects.prototype);let applied=false;
 manager.controllers=new Map([['p',{snapshot:()=>({}),respondInteraction:async()=>{applied=true;}}]]);
 manager.attentionState=async()=>({todos:[{...permission,id:'ordinary',destination:{...permission.destination,question:{method:'input'}}}]});
 await assert.rejects(manager.respondAttention('p',{todoId:'ordinary',answer:'invented'}),{code:'ATTENTION_STALE'});assert.equal(applied,false);
});

test('ordinary external directories remain unregistered while registered descendants retain identity',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-review-resolve-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const registered=path.join(root,'registered'),nested=path.join(registered,'notes'),external=path.join(root,'external');await fs.mkdir(nested,{recursive:true});await fs.mkdir(external);
 const manager=Object.create(ManagedProjects.prototype);manager.host={recent:async()=>({projects:[{id:'registered',rootDisplay:registered}]})};
 const target=await manager.resolveRegisteredProject('registered',nested);assert.equal(target.projectId,'registered');assert.equal(target.relPathPrefix,'notes');assert.equal(target.root,registered);
 assert.deepEqual(await manager.resolveRegisteredProject('registered',external),{projectId:null,root:external,external:true});
 assert.deepEqual(await fs.readdir(external),[],'reading resolution creates no metadata');
});

test('original Work exposes neutral blocked disposition without losing history or creating an answer',()=>{
 const state={works:[{id:'original',request:'Original task',revision:2,status:'paused'}],todos:[{id:'problem',workId:'original',kind:'problem',status:'open'}],backstageEvents:[{key:'problem:object',workId:'original',revision:2,kind:'problem',status:'blocked',reason:'Required source fact is unavailable'}]};
 const before=structuredClone(state),record=managedWorkRecords(state)[0];assert.equal(record.phase,'后台受阻 · 进展已保留');assert.equal(record.backstage.reason,'Required source fact is unavailable');assert.equal(record.todoId,undefined);assert.deepEqual(managedReviewTodos(state),[]);assert.deepEqual(state,before);
 state.works[0].revision=3;assert.equal(managedWorkRecords(state)[0].backstage,undefined,'old blocked facts do not override a new original-Work round');
});

test('default YOLO admission is not misrepresented as a user authorization reminder',async()=>{
 const manager=Object.create(ManagedProjects.prototype),observations=[];
 manager.controllers=new Map();manager.attention={observe:async(id,scope,facts)=>observations.push({scope,facts}),read:async()=>({todos:[],notified:[]})};
 const grant={kind:'effect',status:'granted',mode:'task',sourceJobId:'source',frozenEffect:{action:'user',command:'ordinary-command',cwd:'/tmp'}};
 manager.permissions={read:async()=>({grants:[{...grant,id:'ordinary',authority:'default-yolo'},{...grant,id:'approved',authority:'user-choice'}]})};
 await manager.attentionState('p',{todos:[],agents:[]});
 const facts=observations.find(row=>row.scope==='permission').facts;
 assert.deepEqual(facts.map(fact=>fact.key),['effect-grant:approved']);
 assert.equal(userTodoEligible({kind:'attention',destination:facts[0].destination}),false,'real grants remain revoke/history facts, not pending approvals');
});
